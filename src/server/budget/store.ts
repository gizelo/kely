import { closeSync, constants, existsSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, writeSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { canReserveBudget } from "../budget-policy";
import { canonicalJson, inputHash } from "../paid-input";
import { RATE_SCHEDULE_ID, type UsageAssessment } from "../providers/text-envelope";
import { assessProviderUsage, providerMaximumMicros, providerRateSchedule, type BoundedProviderRequest } from "../providers/provider-envelope";
import { VISION_RATE_SCHEDULE_ID } from "../providers/vision-envelope";
import { IMAGE_RATE_SCHEDULE_ID, IMAGE_RATE_SCHEDULE_ID_V2, IMAGE_RATE_SCHEDULE_ID_V3, IMAGE_RATE_SCHEDULE_ID_V4, type ProviderValidationIssue } from "../providers/image-envelope";
import { WEB_SEARCH_RATE_SCHEDULE_ID } from "../providers/web-search-envelope";
import { budgetFiles, DEVELOPMENT_BUDGET_CEILING_MICROS, DEVELOPMENT_BUDGET_GENESIS_HASH, developmentBudgetLocation, type BudgetLocation } from "./identity";
import { KnownRejectionError, knownRejectionReviewSchema, parseKnownRejectionBinding, previewStoredKnownRejection, type KnownRejectionBinding, type KnownRejectionReview } from "./known-rejection";
import { AbandonmentError, abandonmentReviewSchema, parseAbandonmentBinding, previewStoredAbandonment, type AbandonmentBinding, type AbandonmentReview } from "./undeliverable";

export const BUDGET_SCHEMA = `
  CREATE TABLE authority (singleton INTEGER PRIMARY KEY CHECK(singleton=1), identity TEXT NOT NULL) STRICT;
  CREATE TABLE event (sequence INTEGER PRIMARY KEY, payload TEXT NOT NULL, previous_hash TEXT NOT NULL, hash TEXT NOT NULL) STRICT;
  CREATE TRIGGER event_no_update BEFORE UPDATE ON event BEGIN SELECT RAISE(ABORT,'Budget events are immutable'); END;
  CREATE TRIGGER event_no_delete BEFORE DELETE ON event BEGIN SELECT RAISE(ABORT,'Budget events are immutable'); END;
  CREATE TRIGGER authority_no_update BEFORE UPDATE ON authority BEGIN SELECT RAISE(ABORT,'Budget identity is immutable'); END;
  CREATE TRIGGER authority_no_delete BEFORE DELETE ON authority BEGIN SELECT RAISE(ABORT,'Budget identity is immutable'); END;
`;

export type BudgetIdentity = BudgetLocation & { schemaVersion: 1; ceilingMicros: number; fileIdentity: string };
export type AttemptInput = { key: string; ownerId: string; operationId: string; step: string; snapshot: Record<string, unknown>; request: BoundedProviderRequest; packageId?: string };
export type BudgetAttempt = AttemptInput & {
  inputHash: string; maximumMicros: number; status: "dispatching" | "uncertain" | "settled" | "rejected" | "abandoned";
  settledMicros: number; uncertainMicros: number; response?: unknown; assessment?: UsageAssessment; reason?: string;
  rejectionReview?: KnownRejectionReview;
  abandonmentReview?: AbandonmentReview;
  validationIssues?: ProviderValidationIssue[];
};
export type BudgetPackageInput = {
  id: string;
  ownerId: string;
  operationId: string;
  scopeHash: string;
  steps: { step: string; maximumMicros: number }[];
};
export type BudgetPackage = BudgetPackageInput & {
  inputHash: string;
  maximumMicros: number;
  remainingMicros: number;
  status: "active" | "completed" | "released";
  evidenceHash?: string;
};
export type BudgetState = {
  id: string; purpose: "development" | "fake"; ceilingMicros: number; settledMicros: number;
  reservedMicros: number; uncertainMicros: number; retainedRejectionMicros: number; retainedAbandonmentMicros: number; availableMicros: number; attempts: BudgetAttempt[]; packages: BudgetPackage[];
};
export type EventRow = { sequence: number; payload: string; previous_hash: string; hash: string };
const identitySchema = z.object({
  directory: z.string(), id: z.string(), purpose: z.enum(["development", "fake"]), schemaVersion: z.literal(1),
  ceilingMicros: z.literal(DEVELOPMENT_BUDGET_CEILING_MICROS), fileIdentity: z.string(),
}).strict();
const inputSchema = z.object({
  key: z.string().min(1).max(160), ownerId: z.string().min(1).max(160), operationId: z.string().min(1).max(160),
  step: z.string().min(1).max(80), snapshot: z.record(z.string(), z.unknown()), request: z.unknown(), packageId: z.string().min(8).max(160).optional(),
}).strict();
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const packageInputSchema = z.object({
  id: z.string().min(8).max(160), ownerId: z.string().min(1).max(160), operationId: z.string().min(1).max(160), scopeHash: hashSchema,
  steps: z.array(z.object({ step: z.string().min(1).max(80), maximumMicros: z.number().int().positive() }).strict()).min(1).max(16),
}).strict().superRefine((value, context) => {
  if (new Set(value.steps.map((item) => item.step)).size !== value.steps.length) context.addIssue({ code: "custom", message: "Package steps must be unique." });
  const total = value.steps.reduce((sum, item) => sum + BigInt(item.maximumMicros), 0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) context.addIssue({ code: "custom", message: "Package maximum is too large." });
});
export const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("initialized"), identity: identitySchema }).strict(),
  z.object({ type: z.literal("dispatching"), input: inputSchema, inputHash: z.string(), maximumMicros: z.number().int().positive(), rateSchedule: z.enum([RATE_SCHEDULE_ID, VISION_RATE_SCHEDULE_ID, IMAGE_RATE_SCHEDULE_ID, IMAGE_RATE_SCHEDULE_ID_V2, IMAGE_RATE_SCHEDULE_ID_V3, IMAGE_RATE_SCHEDULE_ID_V4, WEB_SEARCH_RATE_SCHEDULE_ID]) }).strict(),
  z.object({ type: z.literal("uncertain"), key: z.string(), reason: z.enum(["transport_failed", "invalid_response", "timeout"]), response: z.unknown().optional(), validationIssues: z.array(z.object({ path: z.string().max(160).regex(/^[a-zA-Z0-9_.]*$/u), code: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_]+$/u) }).strict()).max(8).optional() }).strict(),
  z.object({ type: z.literal("settled"), key: z.string(), response: z.unknown(), assessment: z.unknown() }).strict(),
  z.object({ type: z.literal("reviewed_known_rejection"), key: z.string(), review: knownRejectionReviewSchema }).strict(),
  z.object({ type: z.literal("abandoned_undeliverable"), key: z.string(), review: abandonmentReviewSchema }).strict(),
  z.object({ type: z.literal("package_reserved"), input: packageInputSchema, inputHash: hashSchema, maximumMicros: z.number().int().positive() }).strict(),
  z.object({ type: z.literal("package_closed"), id: z.string().min(8).max(160), ownerId: z.string().min(1).max(160), operationId: z.string().min(1).max(160), scopeHash: hashSchema, outcome: z.enum(["completed", "released"]), evidenceHash: hashSchema }).strict(),
]);

export class BudgetError extends Error {
  constructor(public readonly code: "budget_integrity" | "budget_exhausted" | "dispatch_in_progress" | "attempt_conflict" | "attempt_uncertain", message: string) { super(message); }
}

export function integrity(condition: unknown): asserts condition {
  if (!condition) throw new BudgetError("budget_integrity", "Development budget integrity failed; spending is disabled. Preserve files for coordinator reconciliation.");
}

export function replayBudgetHistory(identity: BudgetIdentity, rows: EventRow[]): BudgetState {
  identitySchema.parse(identity);
  integrity(rows.length > 0);
  if (identity.purpose === "development") integrity(rows[0].hash === DEVELOPMENT_BUDGET_GENESIS_HASH);
  let previousHash = "0".repeat(64);
  const attempts = new Map<string, BudgetAttempt>();
  const packages = new Map<string, BudgetPackage>();
  for (const [index, row] of rows.entries()) {
    integrity(row.sequence === index + 1 && row.previous_hash === previousHash && row.hash === inputHash({ sequence: row.sequence, payload: row.payload, previousHash }));
    const event = eventSchema.parse(JSON.parse(row.payload));
    if (index === 0) integrity(event.type === "initialized" && canonicalJson(event.identity) === canonicalJson(identity));
    else {
      integrity(event.type !== "initialized");
      if (event.type === "package_reserved") {
        const input = event.input as BudgetPackageInput;
        integrity(!packages.has(input.id) && ![...packages.values()].some((item) => item.ownerId === input.ownerId && item.operationId === input.operationId));
        integrity(inputHash(input) === event.inputHash);
        const maximumMicros = input.steps.reduce((sum, item) => sum + item.maximumMicros, 0);
        integrity(Number.isSafeInteger(maximumMicros) && maximumMicros === event.maximumMicros);
        const exposure = budgetState(identity, attempts, packages);
        integrity(canReserveBudget({ spentMicros: exposure.settledMicros, reservedMicros: exposure.reservedMicros, uncertainMicros: exposure.uncertainMicros, ceilingMicros: exposure.ceilingMicros }, maximumMicros));
        packages.set(input.id, { ...input, inputHash: event.inputHash, maximumMicros, remainingMicros: maximumMicros, status: "active" });
      } else if (event.type === "package_closed") {
        const value = packages.get(event.id);
        integrity(value && value.status === "active" && value.ownerId === event.ownerId && value.operationId === event.operationId && value.scopeHash === event.scopeHash);
        integrity(![...attempts.values()].some((attempt) => attempt.packageId === value.id && (attempt.status === "dispatching" || attempt.status === "uncertain")));
        value.status = event.outcome;
        value.remainingMicros = 0;
        value.evidenceHash = event.evidenceHash;
      } else if (event.type === "dispatching") {
        const input = event.input as AttemptInput;
        integrity(!attempts.has(input.key) && inputHash(input) === event.inputHash);
        integrity(![...attempts.values()].some((attempt) => sameStep(attempt, input)));
        integrity(event.rateSchedule === providerRateSchedule(input.request) && event.maximumMicros === providerMaximumMicros(input.request));
        integrity(![...attempts.values()].some((attempt) => attempt.status === "dispatching"));
        const exposure = budgetState(identity, attempts, packages);
        if (input.packageId) {
          const value = packages.get(input.packageId);
          const step = value?.steps.find((item) => item.step === input.step);
          integrity(value?.status === "active" && value.ownerId === input.ownerId && value.operationId === input.operationId && step && step.maximumMicros >= event.maximumMicros && value.remainingMicros >= event.maximumMicros);
          value.remainingMicros -= event.maximumMicros;
        } else integrity(canReserveBudget({ spentMicros: exposure.settledMicros, reservedMicros: exposure.reservedMicros, uncertainMicros: exposure.uncertainMicros, ceilingMicros: exposure.ceilingMicros }, event.maximumMicros));
        attempts.set(input.key, { ...input, inputHash: event.inputHash, maximumMicros: event.maximumMicros, status: "dispatching", settledMicros: 0, uncertainMicros: 0 });
      } else {
        const attempt = attempts.get(event.key);
        integrity(attempt);
        if (event.type === "reviewed_known_rejection") {
          integrity(attempt.status === "uncertain");
          const { key, ownerId, operationId, acceptedHash, requestId } = event.review;
          const binding = { key, ownerId, operationId, acceptedHash, requestId };
          const review = previewStoredKnownRejection(attempt, binding);
          integrity(canonicalJson(review) === canonicalJson(event.review));
          attempt.status = "rejected";
          attempt.rejectionReview = review;
        } else if (event.type === "abandoned_undeliverable") {
          integrity(attempt.status === "uncertain");
          const { key, ownerId, operationId, acceptedHash, stepHash, requestId } = event.review;
          const review = previewStoredAbandonment(attempt, { key, ownerId, operationId, acceptedHash, stepHash, requestId });
          integrity(canonicalJson(review) === canonicalJson(event.review));
          attempt.status = "abandoned";
          attempt.abandonmentReview = review;
        } else if (event.type === "uncertain") {
          integrity(attempt.status === "dispatching");
          attempt.status = "uncertain"; attempt.uncertainMicros = attempt.maximumMicros; attempt.reason = event.reason; if (event.response !== undefined) attempt.response = event.response;
          if (event.validationIssues) attempt.validationIssues = event.validationIssues;
        } else {
          integrity(attempt.status === "dispatching");
          const assessment = assessProviderUsage(attempt.request, event.response);
          integrity(canonicalJson(assessment) === canonicalJson(event.assessment));
          integrity(assessment.settledMicros + assessment.uncertainMicros <= attempt.maximumMicros);
          Object.assign(attempt, { status: "settled", settledMicros: assessment.settledMicros, uncertainMicros: assessment.uncertainMicros, assessment, response: event.response });
        }
      }
    }
    previousHash = row.hash;
  }
  return budgetState(identity, attempts, packages);
}

function budgetState(identity: BudgetIdentity, attempts: Map<string, BudgetAttempt>, packages = new Map<string, BudgetPackage>()): BudgetState {
  const values = [...attempts.values()];
  const settledMicros = values.reduce((sum, attempt) => sum + attempt.settledMicros, 0);
  const uncertainMicros = values.reduce((sum, attempt) => sum + attempt.uncertainMicros, 0);
  // Reviewed rejections remain inside total unpriced liability used by admission checks.
  const retainedRejectionMicros = values.filter((attempt) => attempt.status === "rejected").reduce((sum, attempt) => sum + attempt.uncertainMicros, 0);
  const retainedAbandonmentMicros = values.filter((attempt) => attempt.status === "abandoned").reduce((sum, attempt) => sum + attempt.uncertainMicros, 0);
  const reservedMicros = values.filter((attempt) => attempt.status === "dispatching").reduce((sum, attempt) => sum + attempt.maximumMicros, 0)
    + [...packages.values()].filter((value) => value.status === "active").reduce((sum, value) => sum + value.remainingMicros, 0);
  integrity([settledMicros, uncertainMicros, retainedRejectionMicros, retainedAbandonmentMicros, reservedMicros].every((amount) => Number.isSafeInteger(amount) && amount >= 0));
  integrity(retainedRejectionMicros + retainedAbandonmentMicros <= uncertainMicros);
  const availableMicros = DEVELOPMENT_BUDGET_CEILING_MICROS - settledMicros - uncertainMicros - reservedMicros;
  integrity(availableMicros >= 0);
  return { id: identity.id, purpose: identity.purpose, ceilingMicros: DEVELOPMENT_BUDGET_CEILING_MICROS, settledMicros, uncertainMicros, retainedRejectionMicros, retainedAbandonmentMicros, reservedMicros, availableMicros, attempts: values, packages: [...packages.values()] };
}


function privateFile(file: string) {
  const stat = lstatSync(file);
  integrity(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 && stat.uid === process.getuid?.());
  return `${stat.dev}:${stat.ino}`;
}

function sameStep(a: AttemptInput, b: AttemptInput) { return a.ownerId === b.ownerId && a.operationId === b.operationId && a.step === b.step; }

export class BudgetStore {
  readonly location: BudgetLocation;
  #database!: DatabaseSync;
  #files: ReturnType<typeof budgetFiles>;
  #fileIdentity: string;

  constructor(location: BudgetLocation) {
    this.location = Object.freeze({ ...location });
    this.#files = budgetFiles(location);
    try {
      if (location.purpose === "development") integrity(DEVELOPMENT_BUDGET_GENESIS_HASH && /^[a-f0-9]{64}$/.test(DEVELOPMENT_BUDGET_GENESIS_HASH));
      const directory = lstatSync(location.directory);
      integrity(directory.isDirectory() && !directory.isSymbolicLink() && (directory.mode & 0o077) === 0);
      integrity(realpathSync(location.directory) === location.directory);
      this.#fileIdentity = privateFile(this.#files.database);
      privateFile(this.#files.witness);
      this.#database = new DatabaseSync(this.#files.database, { timeout: 5000, enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false, allowExtension: false, defensive: true });
      this.#database.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA trusted_schema=OFF;");
      this.inspect();
    } catch {
      this.#database!?.close();
      throw new BudgetError("budget_integrity", "Development budget is absent or invalid; no initializer or automatic repair is available.");
    }
  }

  static openDevelopment() { return new BudgetStore(developmentBudgetLocation); }
  close() { this.#database.close(); }

  #transaction<T>(work: (state: BudgetState, rows: EventRow[]) => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      integrity(privateFile(this.#files.database) === this.#fileIdentity);
      privateFile(this.#files.witness);
      const { state, rows } = this.#read();
      const result = work(state, rows);
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.#database.isTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #read(): { state: BudgetState; rows: EventRow[] } {
    const check = this.#database.prepare("PRAGMA quick_check").get();
    integrity(check?.quick_check === "ok");
    const authority = this.#database.prepare("SELECT identity FROM authority WHERE singleton=1").get();
    integrity(authority && typeof authority.identity === "string");
    const identity = identitySchema.parse(JSON.parse(authority.identity));
    integrity(identity.id === this.location.id && identity.directory === this.location.directory && identity.purpose === this.location.purpose && identity.fileIdentity === this.#fileIdentity);
    const rows = this.#database.prepare("SELECT * FROM event ORDER BY sequence").all() as EventRow[];
    const witnessText = readFileSync(this.#files.witness, "utf8");
    integrity(witnessText.endsWith("\n"));
    const witnesses = witnessText.trimEnd().split("\n").map((line) => JSON.parse(line));
    integrity(rows.length > 0 && witnesses.length === rows.length);
    if (this.location.purpose === "development") integrity(rows[0].hash === DEVELOPMENT_BUDGET_GENESIS_HASH);
    rows.forEach((row, index) => integrity(witnesses[index].sequence === row.sequence && witnesses[index].hash === row.hash));
    return { state: replayBudgetHistory(identity, rows), rows };
  }

  #append(rows: EventRow[], event: z.infer<typeof eventSchema>) {
    const sequence = rows.length + 1;
    const previousHash = rows.at(-1)!.hash;
    const payload = canonicalJson(event);
    const hash = inputHash({ sequence, payload, previousHash });
    this.#database.prepare("INSERT INTO event(sequence,payload,previous_hash,hash) VALUES(?,?,?,?)").run(sequence, payload, previousHash, hash);
    const witness = openSync(this.#files.witness, constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW);
    try {
      const bytes = Buffer.from(`${JSON.stringify({ sequence, hash })}\n`);
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(witness, bytes, offset, bytes.length - offset);
      // A failed later commit leaves a witness mismatch and blocks spending instead of losing an attempt.
      fsyncSync(witness);
    } finally { closeSync(witness); }
  }

  inspect() { return this.#transaction((state) => structuredClone(state)); }

  exportHistory() {
    return this.#transaction((state, rows) => ({ state: structuredClone(state), rows: structuredClone(rows) }));
  }

  reservePackage(input: BudgetPackageInput) {
    const detached = packageInputSchema.parse(JSON.parse(canonicalJson(input))) as BudgetPackageInput;
    const maximumMicros = detached.steps.reduce((sum, item) => sum + item.maximumMicros, 0);
    const hash = inputHash(detached);
    return this.#transaction((state, rows) => {
      integrity(!existsSync(`${this.#files.database}.transferred`));
      const prior = state.packages.find((item) => item.id === detached.id || (item.ownerId === detached.ownerId && item.operationId === detached.operationId));
      if (prior) {
        if (prior.inputHash !== hash) throw new BudgetError("attempt_conflict", "That package reservation already has different immutable inputs.");
        return structuredClone(prior);
      }
      if (!canReserveBudget({ spentMicros: state.settledMicros, reservedMicros: state.reservedMicros, uncertainMicros: state.uncertainMicros, ceilingMicros: state.ceilingMicros }, maximumMicros)) throw new BudgetError("budget_exhausted", "The project's development API ceiling cannot cover this complete package.");
      this.#append(rows, { type: "package_reserved", input: detached, inputHash: hash, maximumMicros });
      return { ...detached, inputHash: hash, maximumMicros, remainingMicros: maximumMicros, status: "active" as const };
    });
  }

  closePackage(input: { id: string; ownerId: string; operationId: string; scopeHash: string; outcome: "completed" | "released"; evidenceHash: string }) {
    const exact = eventSchema.options.find((schema) => schema.safeParse({ type: "package_closed", ...input }).success)?.parse({ type: "package_closed", ...input }) as Extract<z.infer<typeof eventSchema>, { type: "package_closed" }> | undefined;
    integrity(exact);
    return this.#transaction((state, rows) => {
      const value = state.packages.find((item) => item.id === exact.id);
      integrity(value && value.ownerId === exact.ownerId && value.operationId === exact.operationId && value.scopeHash === exact.scopeHash);
      if (value.status !== "active") {
        if (value.status !== exact.outcome || value.evidenceHash !== exact.evidenceHash) throw new BudgetError("attempt_conflict", "That package was already closed with different durable evidence.");
        return structuredClone(value);
      }
      if (state.attempts.some((attempt) => attempt.packageId === value.id && (attempt.status === "dispatching" || attempt.status === "uncertain"))) throw new BudgetError("attempt_uncertain", "This package has an in-flight or uncertain attempt and cannot release its reservation.");
      this.#append(rows, exact);
      return { ...value, status: exact.outcome, remainingMicros: 0, evidenceHash: exact.evidenceHash };
    });
  }

  fenceForTransfer(destination: string, expectedHash: string) {
    integrity(/^[a-zA-Z0-9_-]{16,120}$/.test(destination));
    return this.#transaction((state, rows) => {
      integrity(!state.attempts.some((attempt) => attempt.status === "dispatching"));
      integrity(rows.at(-1)!.hash === expectedHash);
      const record = { destination, hash: rows.at(-1)!.hash, sequence: rows.length };
      this.#database.exec(`CREATE TABLE IF NOT EXISTS transfer_fence (singleton INTEGER PRIMARY KEY CHECK(singleton=1), record TEXT NOT NULL) STRICT;
        CREATE TRIGGER IF NOT EXISTS transferred_no_dispatch BEFORE INSERT ON event WHEN json_extract(NEW.payload,'$.type')='dispatching'
        BEGIN SELECT RAISE(ABORT,'Budget authority transferred'); END;
        CREATE TRIGGER IF NOT EXISTS transfer_fence_no_update BEFORE UPDATE ON transfer_fence BEGIN SELECT RAISE(ABORT,'Transfer is irreversible'); END;
        CREATE TRIGGER IF NOT EXISTS transfer_fence_no_delete BEFORE DELETE ON transfer_fence BEGIN SELECT RAISE(ABORT,'Transfer is irreversible'); END;`);
      const previous = this.#database.prepare("SELECT record FROM transfer_fence WHERE singleton=1").get();
      if (previous) integrity(previous.record === canonicalJson(record));
      else this.#database.prepare("INSERT INTO transfer_fence(singleton,record) VALUES(1,?)").run(canonicalJson(record));
      const filename = `${this.#files.database}.transferred`;
      if (existsSync(filename)) {
        integrity(canonicalJson(JSON.parse(readFileSync(filename, "utf8"))) === canonicalJson(record));
      } else {
        const file = openSync(filename, "wx", 0o600);
        try { writeSync(file, canonicalJson(record)); fsyncSync(file); } finally { closeSync(file); }
        const directory = openSync(this.location.directory, "r");
        try { fsyncSync(directory); } finally { closeSync(directory); }
      }
      return record;
    });
  }

  previewKnownRejection(binding: KnownRejectionBinding): KnownRejectionReview {
    const exact = parseKnownRejectionBinding(binding);
    return this.#transaction((state) => previewStoredKnownRejection(state.attempts.find((attempt) => attempt.key === exact.key), exact));
  }

  reviewKnownRejection(binding: KnownRejectionBinding, expectedReviewId: string): KnownRejectionReview {
    const exact = parseKnownRejectionBinding(binding);
    return this.#transaction((state, rows) => {
      const attempt = state.attempts.find((item) => item.key === exact.key);
      const review = previewStoredKnownRejection(attempt, exact);
      if (review.reviewId !== expectedReviewId) throw new KnownRejectionError("rejection_review_conflict", "The expected rejection review marker does not match this saved evidence. No review was applied.");
      if (attempt!.status !== "rejected") this.#append(rows, { type: "reviewed_known_rejection", key: exact.key, review });
      return review;
    });
  }

  claim(input: AttemptInput): { dispatched: boolean; attempt: BudgetAttempt } {
    inputSchema.parse(input);
    const detached = JSON.parse(canonicalJson(input)) as AttemptInput;
    const maximumMicros = providerMaximumMicros(detached.request);
    const hash = inputHash(detached);
    return this.#transaction((state, rows) => {
      integrity(!existsSync(`${this.#files.database}.transferred`));
      const previous = state.attempts.find((attempt) => attempt.key === detached.key || sameStep(attempt, detached));
      if (previous) {
        if (previous.inputHash !== hash) throw new BudgetError("attempt_conflict", "That provider step already has different immutable inputs.");
        return { dispatched: false, attempt: previous };
      }
      if (state.attempts.some((attempt) => attempt.status === "dispatching")) throw new BudgetError("dispatch_in_progress", "A provider attempt is in flight or needs crash reconciliation. No new request was sent.");
      if (detached.packageId) {
        const value = state.packages.find((item) => item.id === detached.packageId);
        const step = value?.steps.find((item) => item.step === detached.step);
        if (!value || value.status !== "active" || value.ownerId !== detached.ownerId || value.operationId !== detached.operationId || !step || step.maximumMicros < maximumMicros || value.remainingMicros < maximumMicros) throw new BudgetError("budget_exhausted", "This request is not covered by its complete package reservation.");
      } else if (!canReserveBudget({ spentMicros: state.settledMicros, reservedMicros: state.reservedMicros, uncertainMicros: state.uncertainMicros, ceilingMicros: state.ceilingMicros }, maximumMicros)) throw new BudgetError("budget_exhausted", "The project's development API ceiling cannot cover this request. Buying customer credits cannot increase this ceiling.");
      this.#append(rows, { type: "dispatching", input: detached, inputHash: hash, maximumMicros, rateSchedule: providerRateSchedule(detached.request) });
      return { dispatched: true, attempt: { ...detached, inputHash: hash, maximumMicros, status: "dispatching", settledMicros: 0, uncertainMicros: 0 } };
    });
  }

  previewAbandonment(binding: AbandonmentBinding): AbandonmentReview {
    const exact = parseAbandonmentBinding(binding);
    return this.#transaction((state) => previewStoredAbandonment(state.attempts.find((attempt) => attempt.key === exact.key), exact));
  }

  abandonUndeliverable(binding: AbandonmentBinding, expectedReviewId: string): AbandonmentReview {
    const exact = parseAbandonmentBinding(binding);
    return this.#transaction((state, rows) => {
      const attempt = state.attempts.find((item) => item.key === exact.key);
      const review = previewStoredAbandonment(attempt, exact);
      if (review.reviewId !== expectedReviewId) throw new AbandonmentError("abandonment_conflict");
      if (attempt!.status !== "abandoned") this.#append(rows, { type: "abandoned_undeliverable", key: exact.key, review });
      return review;
    });
  }

  markUncertain(key: string, reason: "transport_failed" | "invalid_response" | "timeout", response?: unknown, validationIssues?: ProviderValidationIssue[]) {
    return this.#transaction((state, rows) => {
      const attempt = state.attempts.find((item) => item.key === key);
      integrity(attempt);
      if (attempt.status !== "dispatching") return;
      const image = "prompt" in attempt.request;
      const evidence = response === undefined ? undefined : image ? boundedImageEvidence(response) : boundedResponseEvidence(response);
      const event = eventSchema.parse({ type: "uncertain", key, reason, ...(evidence === undefined ? {} : { response: evidence }), ...(validationIssues?.length ? { validationIssues } : {}) });
      this.#append(rows, event);
    });
  }

  settle(key: string, response: unknown) {
    const serialized = canonicalJson(response);
    integrity(Buffer.byteLength(serialized) <= 16_777_216);
    const detached = JSON.parse(serialized);
    return this.#transaction((state, rows) => {
      const attempt = state.attempts.find((item) => item.key === key);
      integrity(attempt);
      integrity(Buffer.byteLength(serialized) <= ("prompt" in attempt.request ? 16_777_216 : 2_200_000));
      if (attempt.status === "settled") {
        if (canonicalJson(attempt.response) !== canonicalJson(detached)) throw new BudgetError("attempt_conflict", "This provider attempt was already settled with different evidence.");
        return attempt.assessment!;
      }
      if (attempt.status !== "dispatching") throw new BudgetError("attempt_uncertain", "Uncertain attempts require coordinator reconciliation, not automatic settlement or retry.");
      const assessment = assessProviderUsage(attempt.request, detached);
      integrity(assessment.settledMicros + assessment.uncertainMicros <= attempt.maximumMicros);
      this.#append(rows, { type: "settled", key, response: detached, assessment });
      return assessment;
    });
  }
}

export function boundedImageEvidence(response: unknown): unknown {
  try {
    const serialized = canonicalJson(response);
    if (Buffer.byteLength(serialized) <= 16_777_216) return JSON.parse(serialized);
  } catch { /* Invalid image evidence must not prevent the uncertainty event. */ }
  const metadata = boundedResponseEvidence(response) as Record<string, unknown>;
  if (!response || typeof response !== "object") return metadata;
  for (const key of ["http_status", "created"]) {
    const value = Object.getOwnPropertyDescriptor(response, key)?.value;
    if (typeof value === "number" && Number.isSafeInteger(value)) metadata[key] = value;
  }
  const usage = Object.getOwnPropertyDescriptor(response, "usage")?.value;
  try {
    const encoded = canonicalJson(usage);
    if (Buffer.byteLength(encoded) <= 8192) metadata.usage = JSON.parse(encoded);
  } catch { /* A non-JSON usage object is not safe diagnostic evidence. */ }
  return metadata;
}

export function boundedResponseEvidence(response: unknown): unknown {
  try {
    const serialized = canonicalJson(response);
    if (Buffer.byteLength(serialized) <= 2_200_000) return JSON.parse(serialized);
  } catch { /* Non-JSON transport values cannot become durable evidence. */ }
  if (!response || typeof response !== "object") return { evidenceOmitted: "invalid_or_oversized" };
  const record = response as Record<string, unknown>;
  const metadata: Record<string, unknown> = { evidenceOmitted: "invalid_or_oversized" };
  for (const key of ["id", "_request_id", "model", "status", "service_tier"]) {
    const value = Object.getOwnPropertyDescriptor(record, key)?.value;
    if (typeof value === "string") metadata[key] = value.slice(0, 256);
  }
  return metadata;
}
