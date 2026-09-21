import type { Pool, PoolClient } from "pg";
import { canonicalJson, inputHash } from "../paid-input";
import { assessProviderUsage, providerMaximumMicros, providerRateSchedule } from "../providers/provider-envelope";
import type { ProviderValidationIssue } from "../providers/image-envelope";
import { changeStorageUsage, storageTransaction } from "../private-storage";
import { BudgetError, boundedImageEvidence, boundedResponseEvidence, eventSchema, integrity, replayBudgetHistory, type AttemptInput, type BudgetIdentity, type BudgetPackageInput, type BudgetState, type EventRow } from "./store";

type Authority = { identity: BudgetIdentity; destination: string; active: boolean; imported_hash: string; imported_sequence: number; evidence_reserved_bytes: string };
export type BudgetTransfer = { destination: string; hash: string; sequence: number; rows: EventRow[]; state: BudgetState };
const EVIDENCE_HEADROOM = 17_000_000;

export class CloudBudgetStore {
  constructor(private readonly pool: Pool, private readonly destination: string) {
    integrity(/^[a-zA-Z0-9_-]{16,120}$/.test(destination));
  }

  async #transaction<T>(work: (client: PoolClient, state: BudgetState, rows: EventRow[], authority: Authority) => Promise<T>) {
    return storageTransaction(this.pool, async (client) => {
      const { rows: [authority] } = await client.query<Authority>("SELECT * FROM cloud_budget_authority WHERE singleton FOR UPDATE");
      integrity(authority && authority.destination === this.destination);
      const { rows } = await client.query<EventRow>("SELECT * FROM cloud_budget_event ORDER BY sequence");
      integrity(rows[authority.imported_sequence - 1]?.hash === authority.imported_hash);
      const state = replayBudgetHistory(authority.identity, rows);
      return work(client, state, rows, authority);
    });
  }

  async #append(client: PoolClient, rows: EventRow[], event: unknown, reserveDelta = 0) {
    const payload = canonicalJson(eventSchema.parse(event));
    const sequence = rows.length + 1;
    const previousHash = rows.at(-1)!.hash;
    const hash = inputHash({ sequence, payload, previousHash });
    await changeStorageUsage(client, Buffer.byteLength(payload), reserveDelta);
    await client.query("INSERT INTO cloud_budget_event(sequence,payload,previous_hash,hash) VALUES($1,$2,$3,$4)", [sequence,payload,previousHash,hash]);
  }

  inspect() { return this.#transaction(async (_client, state) => state); }

  async reconcileInterruptedDispatch() {
    const state = await this.inspect();
    const attempt = state.attempts.find((item) => item.status === "dispatching");
    if (!attempt) return state;
    await this.markUncertain(attempt.key, "transport_failed");
    return this.inspect();
  }

  reservePackage(input: BudgetPackageInput) {
    const detached = JSON.parse(canonicalJson(input)) as BudgetPackageInput;
    const maximumMicros = detached.steps.reduce((sum, item) => sum + item.maximumMicros, 0);
    const hash = inputHash(detached);
    return this.#transaction(async (client, state, rows, authority) => {
      integrity(authority.active);
      const parsed = eventSchema.parse({ type: "package_reserved", input: detached, inputHash: hash, maximumMicros });
      const prior = state.packages.find((item) => item.id === detached.id || (item.ownerId === detached.ownerId && item.operationId === detached.operationId));
      if (prior) {
        if (prior.inputHash !== hash) throw new BudgetError("attempt_conflict", "That package reservation already has different immutable inputs.");
        return structuredClone(prior);
      }
      if (maximumMicros > state.availableMicros) throw new BudgetError("budget_exhausted", "The shared development budget cannot cover this complete package.");
      await this.#append(client, rows, parsed);
      return { ...detached, inputHash: hash, maximumMicros, remainingMicros: maximumMicros, status: "active" as const };
    });
  }

  closePackage(input: { id: string; ownerId: string; operationId: string; scopeHash: string; outcome: "completed" | "released"; evidenceHash: string }) {
    const event = eventSchema.parse({ type: "package_closed", ...input });
    integrity(event.type === "package_closed");
    return this.#transaction(async (client, state, rows, authority) => {
      integrity(authority.active);
      const value = state.packages.find((item) => item.id === event.id);
      integrity(value && value.ownerId === event.ownerId && value.operationId === event.operationId && value.scopeHash === event.scopeHash);
      if (value.status !== "active") {
        if (value.status !== event.outcome || value.evidenceHash !== event.evidenceHash) throw new BudgetError("attempt_conflict", "That package was already closed with different durable evidence.");
        return structuredClone(value);
      }
      if (state.attempts.some((attempt) => attempt.packageId === value.id && (attempt.status === "dispatching" || attempt.status === "uncertain"))) throw new BudgetError("attempt_uncertain", "This package has an in-flight or uncertain attempt and cannot release its reservation.");
      await this.#append(client, rows, event);
      return { ...value, status: event.outcome, remainingMicros: 0, evidenceHash: event.evidenceHash };
    });
  }

  claim(input: AttemptInput) {
    const detached = JSON.parse(canonicalJson(input)) as AttemptInput;
    const maximumMicros = providerMaximumMicros(detached.request);
    const hash = inputHash(detached);
    return this.#transaction(async (client, state, rows, authority) => {
      integrity(authority.active);
      const previous = state.attempts.find((attempt) => attempt.key === detached.key || (attempt.ownerId === detached.ownerId && attempt.operationId === detached.operationId && attempt.step === detached.step));
      if (previous) {
        if (previous.inputHash !== hash) throw new BudgetError("attempt_conflict", "Provider step inputs changed.");
        return { dispatched: false, attempt: previous };
      }
      if (state.attempts.some((attempt) => attempt.status === "dispatching")) throw new BudgetError("dispatch_in_progress", "An existing provider attempt requires reconciliation.");
      if (detached.packageId) {
        const value = state.packages.find((item) => item.id === detached.packageId);
        const step = value?.steps.find((item) => item.step === detached.step);
        if (!value || value.status !== "active" || value.ownerId !== detached.ownerId || value.operationId !== detached.operationId || !step || step.maximumMicros < maximumMicros || value.remainingMicros < maximumMicros) throw new BudgetError("budget_exhausted", "This request is not covered by its complete package reservation.");
      } else if (maximumMicros > state.availableMicros) throw new BudgetError("budget_exhausted", "The shared development budget cannot cover this request.");
      integrity(Number(authority.evidence_reserved_bytes) === 0);
      await this.#append(client, rows, { type: "dispatching", input: detached, inputHash: hash, maximumMicros, rateSchedule: providerRateSchedule(detached.request) }, EVIDENCE_HEADROOM);
      await client.query("UPDATE cloud_budget_authority SET evidence_reserved_bytes=$1 WHERE singleton", [EVIDENCE_HEADROOM]);
      return { dispatched: true, attempt: { ...detached, inputHash: hash, maximumMicros, status: "dispatching" as const, settledMicros: 0, uncertainMicros: 0 } };
    });
  }

  settle(key: string, response: unknown) {
    const serialized = canonicalJson(response);
    integrity(Buffer.byteLength(serialized) <= 16_777_216);
    const detached = JSON.parse(serialized);
    return this.#transaction(async (client, state, rows, authority) => {
      const attempt = state.attempts.find((item) => item.key === key);
      integrity(attempt);
      integrity(Buffer.byteLength(serialized) <= ("prompt" in attempt.request ? 16_777_216 : 2_200_000));
      if (attempt.status === "settled") {
        if (canonicalJson(attempt.response) !== serialized) throw new BudgetError("attempt_conflict", "Settlement evidence changed.");
        return attempt.assessment!;
      }
      if (attempt.status !== "dispatching") throw new BudgetError("attempt_uncertain", "No automatic reconciliation or retry is permitted.");
      const assessment = assessProviderUsage(attempt.request, detached);
      integrity(assessment.settledMicros + assessment.uncertainMicros <= attempt.maximumMicros);
      await this.#append(client, rows, { type: "settled", key, response: detached, assessment }, -Number(authority.evidence_reserved_bytes));
      await client.query("UPDATE cloud_budget_authority SET evidence_reserved_bytes=0 WHERE singleton");
      return assessment;
    });
  }

  markUncertain(key: string, reason: "transport_failed" | "invalid_response" | "timeout", response?: unknown, validationIssues?: ProviderValidationIssue[]) {
    return this.#transaction(async (client, state, rows, authority) => {
      const attempt = state.attempts.find((item) => item.key === key);
      integrity(attempt);
      if (attempt.status !== "dispatching") return;
      const evidence = response === undefined ? undefined : "prompt" in attempt.request ? boundedImageEvidence(response) : boundedResponseEvidence(response);
      await this.#append(client, rows, { type: "uncertain", key, reason, ...(evidence === undefined ? {} : { response: evidence }), ...(validationIssues?.length ? { validationIssues } : {}) }, -Number(authority.evidence_reserved_bytes));
      await client.query("UPDATE cloud_budget_authority SET evidence_reserved_bytes=0 WHERE singleton");
    });
  }

  async importFencedHistory(transfer: BudgetTransfer) {
    integrity(transfer.destination === this.destination && transfer.sequence === transfer.rows.length && transfer.rows.at(-1)?.hash === transfer.hash);
    const first = eventSchema.parse(JSON.parse(transfer.rows[0]?.payload));
    integrity(first.type === "initialized");
    const state = replayBudgetHistory(first.identity, transfer.rows);
    integrity(!state.attempts.some((attempt) => attempt.status === "dispatching") && canonicalJson(state) === canonicalJson(transfer.state));
    await storageTransaction(this.pool, async (client) => {
      const { rows: [existing] } = await client.query<Authority>("SELECT * FROM cloud_budget_authority WHERE singleton");
      if (existing) {
        integrity(existing.destination === transfer.destination && existing.imported_hash === transfer.hash && existing.imported_sequence === transfer.sequence);
        return;
      }
      integrity((await client.query("SELECT 1 FROM cloud_budget_event LIMIT 1")).rowCount === 0);
      await changeStorageUsage(client, transfer.rows.reduce((sum, row) => sum + Buffer.byteLength(row.payload), 0));
      await client.query("INSERT INTO cloud_budget_authority(singleton,identity,destination,imported_hash,imported_sequence) VALUES(true,$1,$2,$3,$4)", [first.identity, transfer.destination, transfer.hash, transfer.sequence]);
      for (const row of transfer.rows) await client.query("INSERT INTO cloud_budget_event(sequence,payload,previous_hash,hash) VALUES($1,$2,$3,$4)", [row.sequence,row.payload,row.previous_hash,row.hash]);
    });
    const actual = await this.inspect();
    integrity(canonicalJson(actual) === canonicalJson(state));
    return actual;
  }

  activate(expectedHash: string) {
    return this.#transaction(async (client, state, rows, authority) => {
      integrity(authority.imported_hash === expectedHash && rows.at(-1)?.hash === expectedHash);
      await client.query("UPDATE cloud_budget_authority SET active=true WHERE singleton");
      return state;
    });
  }
}
