import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { BudgetStore, type AttemptInput } from "../src/server/budget/store";
import { summarizeBudget } from "../src/server/budget/status";
import { buildImageRequest, validateImageRequest, IMAGE_MODEL_V2 } from "../src/server/providers/image-envelope";
import { FakeProviderGateway } from "../src/server/providers/gateway";
import { inputHash } from "../src/server/paid-input";
import { initializeFakeBudget } from "./helpers/budget-fixture";

function fixture(t: TestContext) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "kely-abandonment-")));
  const location = initializeFakeBudget(join(directory, "authority"));
  let budget = new BudgetStore(location);
  t.after(() => { budget.close(); rmSync(directory, { recursive: true, force: true }); });
  const operationId = randomUUID();
  const { accountingPolicy: _policy, ...legacy } = buildImageRequest("An original geometric illustration") as ReturnType<typeof buildImageRequest> & { accountingPolicy: string };
  const input: AttemptInput = { ownerId: randomUUID(), operationId, key: `kely:${operationId}:artwork:0`, step: "artwork:0", request: validateImageRequest(legacy), snapshot: { acceptedHash: inputHash({ accepted: true }), stepHash: inputHash({ step: true }), input: { original: true } } };
  const binding = { key: input.key, ownerId: input.ownerId, operationId, acceptedHash: String(input.snapshot.acceptedHash), stepHash: String(input.snapshot.stepHash), requestId: "req_fake_lost_image" };
  const evidence = { _request_id: binding.requestId, evidenceOmitted: "invalid_or_oversized" };
  return { input, binding, evidence, get budget() { return budget; }, witness: join(location.directory, "witness.jsonl"), reopen() { budget.close(); budget = new BudgetStore(location); } };
}

test("abandoned image preserves immutable evidence and full liability, reopens once and never redispatches", async (t) => {
  const f = fixture(t);
  f.budget.claim(f.input); f.budget.markUncertain(f.input.key, "invalid_response", f.evidence);
  const before = f.budget.inspect(), witness = readFileSync(f.witness, "utf8");
  const review = f.budget.previewAbandonment(f.binding);
  assert.equal(readFileSync(f.witness, "utf8"), witness);
  assert.equal(review.maximumMicros, 839680);
  assert.equal(review.evidenceHash, inputHash(f.evidence));
  assert.equal(review.attemptInputHash, inputHash(f.input));
  f.budget.abandonUndeliverable(f.binding, review.reviewId);
  f.reopen();
  const after = f.budget.inspect();
  assert.equal(after.availableMicros, before.availableMicros);
  assert.equal(after.uncertainMicros, 839680);
  assert.equal(after.retainedAbandonmentMicros, 839680);
  assert.equal(after.settledMicros, 0);
  assert.equal(after.attempts[0].status, "abandoned");
  assert.deepEqual(after.attempts[0].response, before.attempts[0].response);
  assert.equal(after.attempts[0].inputHash, before.attempts[0].inputHash);
  const closedWitness = readFileSync(f.witness, "utf8");
  assert.equal(closedWitness.trim().split("\n").length, witness.trim().split("\n").length + 1);
  f.budget.abandonUndeliverable(f.binding, review.reviewId);
  assert.equal(readFileSync(f.witness, "utf8"), closedWitness);
  const gateway = new FakeProviderGateway(f.budget, { kind: "fake", async send() { assert.fail("Abandoned work must not be sent"); } });
  await assert.rejects(gateway.dispatch(f.input), { code: "attempt_uncertain" });
  assert.throws(() => f.budget.claim({ ...f.input, key: randomUUID() }), { code: "attempt_conflict" });
  assert.throws(() => f.budget.settle(f.input.key, {}), { code: "attempt_uncertain" });
  const status = summarizeBudget(after);
  assert.equal(status.uncertainAttempts, 0);
  assert.equal(status.uncertain, 0);
  assert.equal(status.abandonedAttempts, 1);
  assert.equal(status.remaining + status.retainedAbandonment, status.ceiling);
});

test("only the exact saved unsupported pinned-model 400 receives its distinct fully retained closure", (t) => {
  const evidence = { _request_id: "req_fake_lost_image", http_status: 400, error: { code: "invalid_value", param: "model", type: "image_generation_user_error", message: "The model 'gpt-image-1.5-2025-12-16' does not exist." } };
  for (const mode of ["exact", "wrong_param", "wrong_model", "wrong_message", "wrong_status"]) {
    const f = fixture(t);
    f.input.request = validateImageRequest({ ...f.input.request, model: mode === "wrong_model" ? "gpt-image-1.5" : IMAGE_MODEL_V2 });
    const received = { ...evidence, http_status: mode === "wrong_status" ? 500 : 400, error: { ...evidence.error, ...(mode === "wrong_param" ? { param: "prompt" } : {}), ...(mode === "wrong_message" ? { message: "Some unrelated input failure" } : {}) } };
    f.budget.claim(f.input); f.budget.markUncertain(f.input.key, "transport_failed", received);
    const before = f.budget.inspect();
    if (mode !== "exact") { assert.throws(() => f.budget.previewAbandonment(f.binding), { code: "abandonment_not_reviewable" }); assert.deepEqual(f.budget.inspect(), before); continue; }
    const review = f.budget.previewAbandonment(f.binding);
    assert.equal(review.classification, "unsupported_image_model_400");
    f.budget.abandonUndeliverable(f.binding, review.reviewId);
    f.reopen();
    assert.deepEqual(f.budget.previewAbandonment(f.binding), review);
    assert.equal(f.budget.inspect().availableMicros, before.availableMicros);
    assert.equal(f.budget.inspect().retainedAbandonmentMicros, 839680);
    assert.deepEqual(f.budget.inspect().attempts[0].response, received);
    assert.equal(f.budget.claim(f.input).dispatched, false);
  }
});

test("timeouts, recoverable responses, wrong identities and stale confirmation cannot abandon an attempt", (t) => {
  for (const scenario of ["timeout", "transport_failed", "full_response", "new_policy", "wrong_owner", "wrong_request", "wrong_step_hash", "stale_confirmation"]) {
    const f = fixture(t);
    if (scenario === "new_policy") f.input.request = buildImageRequest("An original geometric illustration");
    f.budget.claim(f.input);
    f.budget.markUncertain(f.input.key, scenario === "timeout" || scenario === "transport_failed" ? scenario : "invalid_response", scenario === "full_response" ? { ...f.evidence, data: [{ b64_json: "still-present" }] } : f.evidence);
    const before = f.budget.inspect(), witness = readFileSync(f.witness, "utf8");
    const binding = { ...f.binding, ...(scenario === "wrong_owner" ? { ownerId: "different" } : {}), ...(scenario === "wrong_request" ? { requestId: "req_different" } : {}), ...(scenario === "wrong_step_hash" ? { stepHash: "0".repeat(64) } : {}) };
    assert.throws(() => f.budget.abandonUndeliverable(binding, "0".repeat(64)), { code: scenario === "stale_confirmation" ? "abandonment_conflict" : "abandonment_not_reviewable" }, scenario);
    assert.deepEqual(f.budget.inspect(), before);
    assert.equal(readFileSync(f.witness, "utf8"), witness);
  }
});
