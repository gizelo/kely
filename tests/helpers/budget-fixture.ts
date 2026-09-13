import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { budgetFiles, DEVELOPMENT_BUDGET_CEILING_MICROS, type BudgetLocation } from "../../src/server/budget/identity";
import { BUDGET_SCHEMA, BudgetStore, type AttemptInput, type BudgetIdentity } from "../../src/server/budget/store";
import { canonicalJson, inputHash } from "../../src/server/paid-input";
import { buildTextRequest, type BoundedTextRequest } from "../../src/server/providers/text-envelope";
import type { BoundedImageRequest } from "../../src/server/providers/image-envelope";

export function initializeFakeBudget(directory: string, id = `fake-${randomUUID()}`): BudgetLocation {
  const location: BudgetLocation = { directory, id, purpose: "fake" };
  const files = budgetFiles(location);
  if (!id.startsWith("fake-")) throw new Error("Test initialization cannot provision a real authority.");
  mkdirSync(directory, { mode: 0o700 });
  if (realpathSync(directory) !== directory) throw new Error("Use the canonical temporary path.");
  closeSync(openSync(files.database, "wx", 0o600));
  const stat = lstatSync(files.database);
  const identity: BudgetIdentity = { ...location, schemaVersion: 1, ceilingMicros: DEVELOPMENT_BUDGET_CEILING_MICROS, fileIdentity: `${stat.dev}:${stat.ino}` };
  const payload = canonicalJson({ type: "initialized", identity });
  const previousHash = "0".repeat(64);
  const hash = inputHash({ sequence: 1, payload, previousHash });
  const database = new DatabaseSync(files.database);
  try {
    database.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; BEGIN IMMEDIATE;");
    database.exec(BUDGET_SCHEMA);
    database.prepare("INSERT INTO authority(singleton,identity) VALUES(1,?)").run(canonicalJson(identity));
    database.prepare("INSERT INTO event(sequence,payload,previous_hash,hash) VALUES(1,?,?,?)").run(payload, previousHash, hash);
    const witness = openSync(files.witness, "wx", 0o600);
    try { writeFileSync(witness, `${JSON.stringify({ sequence: 1, hash })}\n`); fsyncSync(witness); } finally { closeSync(witness); }
    database.exec("COMMIT");
    const directoryFd = openSync(directory, "r");
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  } finally { database.close(); }
  new BudgetStore(location).close();
  return location;
}

export function fakeAttempt(key: string = randomUUID(), model: "gpt-5.6-luna" | "gpt-5.6-terra" = "gpt-5.6-luna"): AttemptInput {
  return { key, operationId: key, ownerId: "fixture-owner", step: "prepare-reply-1", snapshot: { approved: "original business fact", source: "user_statement" }, request: buildTextRequest({ model, input: "An approved business fact", instructions: "Return concise copy." }) };
}

export function fakeResponse(request: Pick<BoundedTextRequest, "model" | "max_output_tokens"> | BoundedImageRequest, options: { full?: boolean; invalidCopy?: boolean; missingCache?: boolean } = {}) {
  if ("prompt" in request) throw new Error("Text fixture does not simulate artwork.");
  const input = options.full ? 1_050_000 : 100;
  const output = options.full ? request.max_output_tokens : 20;
  return {
    id: `resp_fake_${randomUUID()}`, model: request.model, service_tier: "default", status: "completed",
    output: options.invalidCopy ? [{ type: "message", content: [{ type: "output_text", text: "not valid business JSON" }] }] : [],
    usage: { input_tokens: input, output_tokens: output, total_tokens: input + output,
      ...(options.missingCache ? {} : { input_tokens_details: { cached_tokens: 0, cache_write_tokens: options.full ? input : 0 } }),
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
}
