import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { assertBenchmarkBudget } from "../scripts/lib/live-benchmark";
import { DEVELOPMENT_BUDGET_ID } from "../src/server/budget/identity";
import { BudgetStore, type AttemptInput } from "../src/server/budget/store";
import type { KnownRejectionBinding } from "../src/server/budget/known-rejection";
import { summarizeBudget } from "../src/server/budget/status";
import { inputHash } from "../src/server/paid-input";
import { fakeAttempt, fakeResponse, initializeFakeBudget } from "./helpers/budget-fixture";

function authority(t: TestContext) {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "kely-rejection-test-")));
  const location = initializeFakeBudget(path.join(directory, "authority"));
  let budget = new BudgetStore(location);
  t.after(() => { budget.close(); rmSync(directory, { recursive: true, force: true }); });
  return { get budget() { return budget; }, witness: path.join(location.directory, "witness.jsonl"), reopen() { budget.close(); budget = new BudgetStore(location); } };
}

function attempt(): AttemptInput {
  const initial = fakeAttempt();
  const accepted = { schemaVersion: 1, ownerId: initial.ownerId, generation: { origin: "ai_preview", model: "gpt-5.6-luna" }, approved: "Original fake business facts" };
  return { ...initial, step: "text", snapshot: { acceptedHash: inputHash(accepted), input: accepted } };
}

function rejectionEvidence() {
  return { _request_id: "req_fake_quota_rejection", http_status: 429, error: { type: "insufficient_quota", code: "credit_balance_exhausted", param: null, message: "Synthetic balance-exhaustion response; this is not a real provider request." } };
}

function binding(input: AttemptInput): KnownRejectionBinding {
  return { key: input.key, ownerId: input.ownerId, operationId: input.operationId, acceptedHash: String(input.snapshot.acceptedHash), requestId: rejectionEvidence()._request_id };
}

function retain(budget: BudgetStore, input: AttemptInput, evidence: unknown = rejectionEvidence(), reason: "transport_failed" | "invalid_response" | "timeout" = "transport_failed") {
  budget.claim(input);
  budget.markUncertain(input.key, reason, evidence);
}

test("explicit reviewed rejection persists complete evidence and full liability across reopen and idempotent replay", (t) => {
  const fixture = authority(t);
  const input = attempt();
  const evidence = rejectionEvidence();
  fixture.budget.claim(input);
  assert.throws(() => fixture.budget.previewKnownRejection(binding(input)), { code: "rejection_not_reviewable" });
  fixture.budget.markUncertain(input.key, "transport_failed", evidence);
  const before = fixture.budget.inspect();
  const originalWitness = readFileSync(fixture.witness, "utf8");
  const review = fixture.budget.previewKnownRejection(binding(input));
  assert.equal(readFileSync(fixture.witness, "utf8"), originalWitness);
  assert.deepEqual(fixture.budget.inspect(), before);
  assert.equal(review.evidenceHash, inputHash(evidence));
  assert.equal(review.attemptInputHash, inputHash(input));
  assert.equal(review.requestHash, inputHash(input.request));
  assert.equal(review.maximumMicros, 532_373);
  assert.deepEqual(fixture.budget.reviewKnownRejection(binding(input), review.reviewId), review);
  const reviewedWitness = readFileSync(fixture.witness, "utf8");
  assert.ok(reviewedWitness.startsWith(originalWitness));
  assert.equal(reviewedWitness.trim().split("\n").length, originalWitness.trim().split("\n").length + 1);
  fixture.reopen();
  const reviewed = fixture.budget.inspect();
  assert.equal(reviewed.attempts[0].status, "rejected");
  assert.equal(reviewed.attempts[0].reason, "transport_failed");
  assert.deepEqual(reviewed.attempts[0].response, evidence);
  assert.deepEqual(reviewed.attempts[0].rejectionReview, review);
  assert.equal(reviewed.uncertainMicros, before.uncertainMicros);
  assert.equal(reviewed.retainedRejectionMicros, 532_373);
  assert.equal(reviewed.availableMicros, before.availableMicros);
  assert.equal(reviewed.settledMicros, 0);
  assert.equal(reviewed.reservedMicros, 0);
  assert.deepEqual(fixture.budget.previewKnownRejection(binding(input)), review);
  assert.deepEqual(fixture.budget.reviewKnownRejection(binding(input), review.reviewId), review);
  assert.equal(readFileSync(fixture.witness, "utf8"), reviewedWitness);
  assert.equal(fixture.budget.claim(input).dispatched, false);
  assert.throws(() => fixture.budget.claim({ ...input, key: randomUUID() }), { code: "attempt_conflict" });
  assert.throws(() => fixture.budget.settle(input.key, fakeResponse(input.request)), { code: "attempt_uncertain" });
  fixture.budget.markUncertain(input.key, "timeout");
  assert.deepEqual(fixture.budget.inspect(), reviewed);
  assert.deepEqual(summarizeBudget(reviewed), { status: "verified", identity: reviewed.id, purpose: "fake", currency: "USD", unit: "microUSD", ceiling: 10_000_000, settled: 0, reserved: 0, uncertain: 0, settledBounded: 0, retainedRejection: 532_373, retainedAbandonment: 0, remaining: 9_467_627, dispatchingAttempts: 0, uncertainAttempts: 0, rejectedAttempts: 1, abandonedAttempts: 0 });
});

test("new attempts still reserve against reviewed rejection liability and additive status does not double-count it", (t) => {
  const { budget } = authority(t);
  const input = attempt();
  retain(budget, input);
  budget.reviewKnownRejection(binding(input), budget.previewKnownRejection(binding(input)).reviewId);
  const reviewedStatus = summarizeBudget(budget.inspect());
  assert.equal(reviewedStatus.uncertain, 0);
  assert.equal(reviewedStatus.retainedRejection, 532_373);
  assert.equal(reviewedStatus.remaining, 9_467_627);
  assertBenchmarkBudget({ ...reviewedStatus, identity: DEVELOPMENT_BUDGET_ID, purpose: "development" });
  for (let index = 0; index < 17; index++) retain(budget, attempt(), { _request_id: `req_fake_timeout_${index}`, http_status: 200 }, "timeout");
  const state = budget.inspect();
  assert.equal(state.attempts.length, 18);
  assert.equal(state.uncertainMicros, 18 * 532_373);
  assert.equal(state.retainedRejectionMicros, 532_373);
  const summary = summarizeBudget(state);
  assert.equal(summary.uncertain, 17 * 532_373);
  assert.equal(summary.rejectedAttempts, 1);
  assert.equal(summary.uncertainAttempts, 17);
  assert.throws(() => assertBenchmarkBudget({ ...summary, identity: DEVELOPMENT_BUDGET_ID, purpose: "development" }), /requires reconciliation/);
  assert.equal(summary.settled + summary.reserved + summary.uncertain + summary.retainedRejection + summary.remaining, summary.ceiling);
  assert.throws(() => budget.claim(attempt()), { code: "budget_exhausted" });
  assert.deepEqual(budget.inspect(), state);
});

test("binding or expected-review mismatches cannot mutate or replace evidence", (t) => {
  const { budget, witness } = authority(t);
  const input = attempt();
  retain(budget, input);
  const exact = binding(input);
  const marker = budget.previewKnownRejection(exact);
  const before = readFileSync(witness, "utf8");
  for (const changed of [{ key: "different-key" }, { ownerId: "different-owner" }, { operationId: "different-operation" }, { acceptedHash: "0".repeat(64) }, { requestId: "req_different" }, { response: rejectionEvidence() }]) {
    const invalid = { ...exact, ...changed };
    assert.throws(() => budget.previewKnownRejection(invalid), { code: "rejection_not_reviewable" });
    assert.throws(() => budget.reviewKnownRejection(invalid, marker.reviewId), { code: "rejection_not_reviewable" });
  }
  assert.throws(() => budget.reviewKnownRejection(exact, "0".repeat(64)), { code: "rejection_review_conflict" });
  assert.equal(readFileSync(witness, "utf8"), before);
  assert.equal(budget.inspect().attempts[0].status, "uncertain");
});

test("missing, contradictory, truncated, non-Luna and timeout evidence stays uncertain", (t) => {
  const good = rejectionEvidence();
  const cases: { evidence?: unknown; reason?: "transport_failed" | "invalid_response" | "timeout"; change?: (input: AttemptInput) => void }[] = [
    { evidence: null },
    { evidence: { http_status: 429, error: good.error } },
    { evidence: { ...good, http_status: 500 } },
    { evidence: { ...good, error: { ...good.error, code: "rate_limit_exceeded" } } },
    { evidence: { ...good, error: { ...good.error, param: "model" } } },
    { evidence: { ...good, error: { ...good.error, message: "x".repeat(4097) } } },
    ...["response_limit_exceeded", "invalid_json", "body_prefix", "evidenceOmitted", "usage", "output", "model", "status"].map((field) => ({ evidence: { ...good, [field]: field === "output" ? [] : field === "usage" ? { input_tokens: 0, output_tokens: 0 } : true } })),
    { evidence: good, reason: "timeout" },
    { evidence: good, reason: "invalid_response" },
    { evidence: good, change: (input) => { input.request = fakeAttempt(randomUUID(), "gpt-5.6-terra").request; } },
    { evidence: good, change: (input) => { input.step = "not-text"; } },
    { evidence: good, change: (input) => { input.snapshot.acceptedHash = "a".repeat(64); } },
  ];
  for (const [index, scenario] of cases.entries()) {
    const { budget, witness } = authority(t);
    const input = attempt();
    scenario.change?.(input);
    retain(budget, input, scenario.evidence, scenario.reason);
    const originalWitness = readFileSync(witness, "utf8");
    assert.throws(() => budget.previewKnownRejection(binding(input)), { code: "rejection_not_reviewable" }, `Scenario ${index} must remain blocked.`);
    assert.throws(() => budget.reviewKnownRejection(binding(input), "0".repeat(64)), { code: "rejection_not_reviewable" });
    assert.equal(readFileSync(witness, "utf8"), originalWitness);
    assert.equal(budget.inspect().attempts[0].status, "uncertain");
    assert.equal(budget.inspect().retainedRejectionMicros, 0);
  }
});
