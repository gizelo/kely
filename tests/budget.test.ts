import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, renameSync, truncateSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { BudgetStore } from "../src/server/budget/store";
import { FakeProviderGateway } from "../src/server/providers/gateway";
import { fakeAttempt, fakeResponse, initializeFakeBudget } from "./helpers/budget-fixture";

function location() { return initializeFakeBudget(path.join(realpathSync(mkdtempSync(path.join(os.tmpdir(), "kely-budget-test-"))), "authority")); }

function child(mode: string, store: ReturnType<typeof location>, key: string) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, ["--import", path.resolve("node_modules/tsx/dist/loader.mjs"), path.resolve("tests/helpers/budget-child.ts"), mode, store.directory, store.id, key], { cwd: store.directory, env: { PATH: globalThis.process.env.PATH, NODE_ENV: "test" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    process.stdout.on("data", (chunk) => { output += chunk; });
    process.on("error", reject);
    process.on("exit", (code) => resolve({ code, output }));
  });
}

test("durable usage settlement is independent of usable copy, replay and mutable caller input", async () => {
  const store = location();
  let budget = new BudgetStore(store);
  let sends = 0;
  const request = fakeAttempt();
  const original = structuredClone(request);
  const gateway = new FakeProviderGateway(budget, { kind: "fake", async send(wire) { sends++; return fakeResponse(wire, { invalidCopy: true }); } });
  const result = await gateway.dispatch(request);
  assert.equal(result.assessment.basis, "usage_rated");
  assert.equal(budget.inspect().settledMicros, 44);
  assert.equal(budget.inspect().availableMicros, 9_999_956);
  assert.equal((await gateway.dispatch(original)).replayed, true);
  await assert.rejects(gateway.dispatch({ ...original, key: randomUUID() }), { code: "attempt_conflict" });
  request.snapshot.approved = "later profile edit";
  await assert.rejects(gateway.dispatch(request), { code: "attempt_conflict" });
  assert.equal(sends, 1);
  budget.close();
  budget = new BudgetStore(store);
  assert.equal(budget.inspect().attempts[0].snapshot.approved, "original business fact");
  assert.equal(budget.inspect().settledMicros, 44);
  budget.close();
});

test("cross-process dispatch races serialize one request and reject the other before transport", async () => {
  const store = location();
  const results = await Promise.all([child("race", store, randomUUID()), child("race", store, randomUUID())]);
  const outcomes = results.map((result) => { assert.equal(result.code, 0); return JSON.parse(result.output); });
  assert.equal(outcomes.reduce((sum, item) => sum + item.sends, 0), 1);
  assert.equal(outcomes.filter((item) => item.outcome === "completed").length, 1);
  assert.ok(outcomes.some((item) => ["dispatch_in_progress", "budget_exhausted"].includes(item.outcome)));
  const budget = new BudgetStore(store);
  assert.equal(budget.inspect().attempts.length, 1);
  assert.equal(budget.inspect().settledMicros, 5_323_728);
  let sent = false;
  const gateway = new FakeProviderGateway(budget, { kind: "fake", async send(request) { sent = true; return fakeResponse(request); } });
  await assert.rejects(gateway.dispatch(fakeAttempt(randomUUID(), "gpt-5.6-terra")), { code: "budget_exhausted" });
  assert.equal(sent, false);
  budget.close();
});

test("timeout, invalid usage and process exit after fake success retain exposure without redispatch", async () => {
  const store = location();
  let budget = new BudgetStore(store);
  const timeoutInput = fakeAttempt();
  let sends = 0;
  const timeout = new FakeProviderGateway(budget, { kind: "fake", async send() { sends++; return new Promise(() => {}); } }, 10);
  await assert.rejects(timeout.dispatch(timeoutInput), { code: "attempt_uncertain" });
  await assert.rejects(timeout.dispatch(timeoutInput), { code: "attempt_uncertain" });
  assert.equal(sends, 1);
  const invalid = new FakeProviderGateway(budget, { kind: "fake", async send() { return { usage: { input_tokens: -1 } }; } });
  await assert.rejects(invalid.dispatch(fakeAttempt()), { code: "attempt_uncertain" });
  let zeroSends = 0;
  const zeroInput = fakeAttempt();
  const zero = new FakeProviderGateway(budget, { kind: "fake", async send(request) {
    zeroSends++;
    return { ...fakeResponse(request, { invalidCopy: true }), usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } };
  } });
  await assert.rejects(zero.dispatch(zeroInput), { code: "attempt_uncertain" });
  await assert.rejects(zero.dispatch(zeroInput), { code: "attempt_uncertain" });
  assert.equal(zeroSends, 1);
  assert.equal(budget.inspect().uncertainMicros, 3 * 532_373);
  budget.close();
  const crashKey = randomUUID();
  const result = await child("crash-after-success", store, crashKey);
  assert.equal(result.code, 42);
  assert.match(result.output, /fake-provider-success/);
  budget = new BudgetStore(store);
  const recovery = new FakeProviderGateway(budget, { kind: "fake", async send() { assert.fail("A crashed paid attempt must not be repeated."); } });
  await assert.rejects(recovery.dispatch(fakeAttempt(crashKey, "gpt-5.6-terra")), { code: "attempt_uncertain" });
  assert.equal(budget.inspect().reservedMicros, 5_323_728);
  await assert.rejects(recovery.dispatch(fakeAttempt()), { code: "dispatch_in_progress" });
  budget.close();
});

test("missing cache breakdown keeps bounded liability and never reports an exact zero cost", async () => {
  const budget = new BudgetStore(location());
  const gateway = new FakeProviderGateway(budget, { kind: "fake", async send(request) { return fakeResponse(request, { missingCache: true }); } });
  const result = await gateway.dispatch(fakeAttempt());
  assert.equal(result.assessment.basis, "usage_bounded");
  assert.equal(result.assessment.settledMicros, 0);
  assert.ok(result.assessment.uncertainMicros >= 49);
  assert.equal(budget.inspect().uncertainMicros, result.assessment.uncertainMicros);
  assert.ok(budget.inspect().availableMicros < 10_000_000);
  budget.close();
});

test("missing, corrupt, replaced or rolled-back authority refuses reopening instead of reseeding", async () => {
  const missing = location();
  assert.throws(() => new BudgetStore({ ...missing, id: `fake-${randomUUID()}` }), { code: "budget_integrity" });
  renameSync(path.join(missing.directory, "budget.sqlite"), path.join(missing.directory, "preserved.sqlite"));
  assert.throws(() => new BudgetStore(missing), { code: "budget_integrity" });
  assert.throws(() => initializeFakeBudget(missing.directory, missing.id), /EEXIST/);
  const corrupt = location();
  truncateSync(path.join(corrupt.directory, "witness.jsonl"), 2);
  assert.throws(() => new BudgetStore(corrupt), { code: "budget_integrity" });
  const replaced = location();
  const file = path.join(replaced.directory, "budget.sqlite");
  copyFileSync(file, `${file}.replacement`);
  renameSync(`${file}.replacement`, file);
  assert.throws(() => new BudgetStore(replaced), { code: "budget_integrity" });
  const rollback = location();
  const ledgerPath = path.join(rollback.directory, "budget.sqlite");
  const original = readFileSync(ledgerPath);
  const budget = new BudgetStore(rollback);
  const gateway = new FakeProviderGateway(budget, { kind: "fake", async send(request) { return fakeResponse(request); } });
  await gateway.dispatch(fakeAttempt());
  budget.close();
  writeFileSync(ledgerPath, original);
  assert.throws(() => new BudgetStore(rollback), { code: "budget_integrity" });
});

test("settlement storage failure keeps full exposure and an unmatched witness fails closed", async () => {
  const failedStore = location();
  const failedBudget = new BudgetStore(failedStore);
  const connection = new DatabaseSync(path.join(failedStore.directory, "budget.sqlite"));
  connection.exec("CREATE TRIGGER fail_test_settlement BEFORE INSERT ON event WHEN json_extract(NEW.payload,'$.type')='settled' BEGIN SELECT RAISE(ABORT,'injected settlement storage failure'); END;");
  connection.close();
  let sends = 0;
  const inputWithFailure = fakeAttempt();
  const gateway = new FakeProviderGateway(failedBudget, { kind: "fake", async send(request) { sends++; return fakeResponse(request); } });
  await assert.rejects(gateway.dispatch(inputWithFailure), { code: "attempt_uncertain" });
  await assert.rejects(gateway.dispatch(inputWithFailure), { code: "attempt_uncertain" });
  assert.equal(sends, 1);
  assert.equal(failedBudget.inspect().uncertainMicros, 532_373);
  failedBudget.close();
  const store = location();
  const budget = new BudgetStore(store);
  const input = fakeAttempt();
  budget.claim(input);
  const witness = path.join(store.directory, "witness.jsonl");
  writeFileSync(witness, `${readFileSync(witness, "utf8")}{"sequence":3,"hash":"unfinished-commit"}\n`);
  assert.throws(() => budget.settle(input.key, fakeResponse(input.request)), { code: "budget_integrity" });
  budget.close();
  assert.throws(() => new BudgetStore(store), { code: "budget_integrity" });
});
