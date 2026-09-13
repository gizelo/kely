import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { rehearseFakeActivation, verifyFreshActivation } from "../scripts/lib/budget-activation";
import { acquireBenchmarkLock, assertBenchmarkApproval, assertBenchmarkBudget } from "../scripts/lib/live-benchmark";
import { budgetFiles, DEVELOPMENT_BUDGET_ID, type BudgetLocation } from "../src/server/budget/identity";
import { BudgetStore } from "../src/server/budget/store";
import { summarizeBudget } from "../src/server/budget/status";
import { fakeAttempt, fakeResponse } from "./helpers/budget-fixture";

function temporary(t: TestContext) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "kely-activation-test-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const location: BudgetLocation = { directory: join(directory, "authority"), id: "fake-activation-test-v1", purpose: "fake" };
  return { directory, location, receipt: `${location.directory}.activation.jsonl` };
}

test("one-time fake activation verifies genesis and status reports only real ledger aggregates", (t) => {
  const { location, receipt } = temporary(t);
  const activated = rehearseFakeActivation(location);
  assert.equal(activated.remainingMicros, 10_000_000);
  assert.equal(verifyFreshActivation(location, receipt, activated.genesisHash).genesisHash, activated.genesisHash);
  assert.throws(() => rehearseFakeActivation(location), /Activation refused/);
  const store = new BudgetStore(location);
  t.after(() => store.close());
  const settled = fakeAttempt("secret-input-sentinel");
  store.claim(settled);
  store.settle(settled.key, fakeResponse(settled.request));
  const unknown = fakeAttempt("unknown-step");
  store.claim(unknown);
  store.markUncertain(unknown.key, "timeout", { response: "secret-response-sentinel" });
  store.claim(fakeAttempt("in-flight-step"));
  const status = summarizeBudget(store.inspect());
  assert.deepEqual(status, { status: "verified", identity: location.id, purpose: "fake", currency: "USD", unit: "microUSD", ceiling: 10_000_000, settled: 44, reserved: 532_373, uncertain: 532_373, settledBounded: 0, retainedRejection: 0, retainedAbandonment: 0, remaining: 8_935_210, dispatchingAttempts: 1, uncertainAttempts: 1, rejectedAttempts: 0, abandonedAttempts: 0 });
  assert.doesNotMatch(JSON.stringify(status), /sentinel|unknown-step|in-flight-step|original business fact/);
});

test("existing authority or surviving activation receipt cannot be replaced with a fresh budget", (t) => {
  const { directory, location, receipt } = temporary(t);
  mkdirSync(location.directory, { mode: 0o700 });
  assert.throws(() => rehearseFakeActivation(location), /Activation refused/);
  assert.throws(() => readFileSync(receipt), { code: "ENOENT" });
  renameSync(location.directory, join(directory, "preserved-empty-directory"));
  rehearseFakeActivation(location);
  const initialReceipt = readFileSync(receipt, "utf8");
  renameSync(location.directory, join(directory, "preserved-authority"));
  assert.throws(() => rehearseFakeActivation(location), /Activation refused/);
  assert.equal(readFileSync(receipt, "utf8"), initialReceipt);
  assert.throws(() => readFileSync(budgetFiles(location).database), { code: "ENOENT" });
});

test("corrupt fresh evidence fails verification and rerun preserves corrupt files", (t) => {
  const { location, receipt } = temporary(t);
  const activated = rehearseFakeActivation(location);
  const witness = budgetFiles(location).witness;
  writeFileSync(witness, "corrupt witness\n");
  assert.throws(() => verifyFreshActivation(location, receipt, activated.genesisHash));
  assert.throws(() => new BudgetStore(location));
  assert.throws(() => rehearseFakeActivation(location), /Activation refused/);
  assert.equal(readFileSync(witness, "utf8"), "corrupt witness\n");
});

test("coordinator gates are explicit and the exclusive worker lock is released only by its owner", (t) => {
  const { directory } = temporary(t);
  const args = [`--confirm-coordinator-benchmark=${DEVELOPMENT_BUDGET_ID}`];
  const pin = "a".repeat(64);
  assert.throws(() => assertBenchmarkApproval(args, false, pin));
  assert.throws(() => assertBenchmarkApproval(args, true, null));
  assert.throws(() => assertBenchmarkApproval([], true, pin));
  assertBenchmarkApproval(args, true, pin);
  const valid = { status: "verified" as const, identity: DEVELOPMENT_BUDGET_ID, purpose: "development" as const, currency: "USD" as const, unit: "microUSD" as const, ceiling: 10_000_000, settled: 44, reserved: 0, uncertain: 0, settledBounded: 0, retainedRejection: 0, retainedAbandonment: 0, remaining: 9_999_956, dispatchingAttempts: 0, uncertainAttempts: 0, rejectedAttempts: 0, abandonedAttempts: 0 };
  assertBenchmarkBudget(valid);
  assert.throws(() => assertBenchmarkBudget({ ...valid, uncertain: 532_373, remaining: valid.remaining - 532_373 }));
  assertBenchmarkBudget({ ...valid, uncertain: 201364, settledBounded: 201364, remaining: valid.remaining - 201364 });
  assert.throws(() => assertBenchmarkBudget({ ...valid, uncertain: 201364, settledBounded: 201364, uncertainAttempts: 1, remaining: valid.remaining - 201364 }));
  assert.throws(() => assertBenchmarkBudget({ ...valid, purpose: "fake" }));
  const release = acquireBenchmarkLock(directory);
  assert.throws(() => acquireBenchmarkLock(directory), { code: "EEXIST" });
  release();
  release();
  const releaseSecond = acquireBenchmarkLock(directory);
  const path = join(directory, "live-benchmark.lock");
  renameSync(path, join(directory, "preserved-owner-lock"));
  writeFileSync(path, "replacement lock", { mode: 0o600 });
  assert.throws(releaseSecond, /lock changed/);
  assert.equal(readFileSync(path, "utf8"), "replacement lock");
});
