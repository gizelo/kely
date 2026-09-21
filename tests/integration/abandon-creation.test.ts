import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pool } from "../../src/server/db";
import { getBoss } from "../../src/server/queue";
import { accountView, simulateBilling, type Viewer } from "../../src/server/credits";
import { acceptCreation, generateCreation, quoteCreation, readCreation } from "../../src/server/creation";
import { runCreation } from "../../src/server/creation-runner";
import { BudgetStore } from "../../src/server/budget/store";
import { FakeProviderGateway } from "../../src/server/providers/gateway";
import { previewTransport } from "../../src/server/providers/preview-transport";
import { buildImageRequest, validateImageRequest, IMAGE_MODEL_V2 } from "../../src/server/providers/image-envelope";
import { ReceivedTransportError } from "../../src/server/providers/http-transport";
import { inputHash } from "../../src/server/paid-input";
import { abandonLostImageCreation } from "../../src/server/abandon-creation";
import { initializeFakeBudget } from "../helpers/budget-fixture";

assert.match(process.env.KELY_DATABASE_URL ?? "", /\/kely_fixture_test$/u);
process.env.KELY_PROVIDER_MODE = "ai_preview";
process.env.KELY_LIVE_ENABLED = "false";
after(async () => { await (await getBoss()).stop({ graceful: true }); await pool.end(); });

async function lost(unsupportedModel = false) {
  const user: Viewer = { id: randomUUID(), name: "Lost image test", email: `${randomUUID()}@fixture.example.test` };
  await pool.query('INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$2,$3,false)', [user.id, user.name, user.email]);
  await simulateBilling(user, "activate");
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "kely-lost-creation-")));
  const location = initializeFakeBudget(join(directory, "budget"));
  let budget = new BudgetStore(location), sends = 0;
  const requestId = `req_${randomUUID().replaceAll("-", "")}`;
  const transport = { kind: "fake" as const, async send(request: Parameters<typeof previewTransport.send>[0], context: Parameters<typeof previewTransport.send>[1]) {
    sends++;
    if ("prompt" in request) {
      if (unsupportedModel) throw new ReceivedTransportError({ _request_id: requestId, http_status: 400, error: { code: "invalid_value", param: "model", type: "image_generation_user_error", message: "The model 'gpt-image-1.5-2025-12-16' does not exist." } });
      return { _request_id: requestId, evidenceOmitted: "invalid_or_oversized" };
    }
    return previewTransport.send(request, context);
  } };
  let gateway = new FakeProviderGateway(budget, transport);
  const quoted = await quoteCreation(user, { idea: "Introduce our independent bakery.", platform: "instagram", slideCount: 1 });
  const accepted = await acceptCreation(user, quoted.quote.id, randomUUID());
  const operation = (await pool.query("SELECT input_hash FROM operation WHERE id=$1", [accepted.operationId])).rows[0];
  const { accountingPolicy: _policy, ...wire } = buildImageRequest("An original editorial bakery illustration, no text") as ReturnType<typeof buildImageRequest> & { accountingPolicy: string };
  const step = { acceptedHash: operation.input_hash, snapshot: { historical: "isolated legacy saved artwork step" }, request: validateImageRequest({ ...wire, model: unsupportedModel ? IMAGE_MODEL_V2 : "gpt-image-1.5" }) };
  await pool.query("INSERT INTO creation_step(operation_id,step_key,input,input_hash) VALUES($1,'artwork:0',$2,$3)", [accepted.operationId, JSON.stringify(step), inputHash(step)]);
  await runCreation(accepted.operationId, { gateway });
  const planned = await readCreation(user.id, quoted.publication.id);
  const plan = planned.creation.plan!;
  await generateCreation(user, quoted.publication.id, { version: planned.publication.version, planVersion: plan.version, planHash: plan.hash, requestKey: randomUUID() });
  await runCreation(accepted.operationId, { gateway });
  return { user, quoted, accepted, target: { ownerId: user.id, operationId: accepted.operationId, requestId }, get budget() { return budget; }, get gateway() { return gateway; }, get sends() { return sends; }, reopen() { budget.close(); budget = new BudgetStore(location); gateway = new FakeProviderGateway(budget, transport); }, close() { budget.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("lost-image closure converges after ledger-first rollback, refunds once and cannot resend the old order", async () => {
  const f = await lost();
  try {
    const before = await readCreation(f.user.id, f.quoted.publication.id), budgetBefore = f.budget.inspect();
    assert.equal(before.creation.status, "paused", before.publication.failure);
    assert.equal(f.sends, 2);
    assert.equal((await accountView(f.user)).billing.reserved, 30);
    const preview = await abandonLostImageCreation(f.target, f.budget);
    assert.equal(preview.status, "ready_for_review");
    assert.deepEqual(f.budget.inspect(), budgetBefore);
    assert.deepEqual(await readCreation(f.user.id, f.quoted.publication.id), before);
    await assert.rejects(abandonLostImageCreation(f.target, f.budget, { applyPlan: preview.plan.planHash, failBeforeCommit: true }), /abandonment PostgreSQL rollback/);
    assert.equal(f.budget.inspect().attempts.find((a) => a.step === "artwork:0")?.status, "abandoned");
    assert.equal(f.budget.inspect().availableMicros, budgetBefore.availableMicros);
    assert.deepEqual(await readCreation(f.user.id, f.quoted.publication.id), before);
    assert.equal((await accountView(f.user)).billing.reserved, 30);
    const fresh = await quoteCreation(f.user, { idea: "A separately priced new bakery post.", platform: "instagram" });
    await assert.rejects(acceptCreation(f.user, fresh.quote.id, randomUUID()), { code: "creation_pending" });
    f.reopen();
    assert.equal((await abandonLostImageCreation(f.target, f.budget)).plan.planHash, preview.plan.planHash);
    assert.equal((await abandonLostImageCreation(f.target, f.budget, { applyPlan: preview.plan.planHash })).status, "applied");
    assert.equal((await abandonLostImageCreation(f.target, f.budget, { applyPlan: preview.plan.planHash })).status, "already_applied");
    const after = await readCreation(f.user.id, before.publication.id);
    assert.equal(after.creation.status, "failed");
    assert.equal(after.publication.failureCode, "abandoned_undeliverable");
    assert.equal(after.publication.version, before.publication.version + 1);
    assert.deepEqual(after.publication.history.slice(0, -1), before.publication.history);
    assert.deepEqual(after.publication.cost, before.publication.cost);
    assert.deepEqual(after.publication.messages, before.publication.messages);
    assert.deepEqual([(await accountView(f.user)).billing.weeklyRemaining, (await accountView(f.user)).billing.reserved], [100, 0]);
    const old = await acceptCreation(f.user, f.quoted.quote.id, randomUUID());
    await runCreation(old.operationId, { gateway: f.gateway });
    assert.equal(f.sends, 2);
    assert.equal(f.budget.inspect().availableMicros, budgetBefore.availableMicros);
    assert.equal(f.budget.inspect().retainedAbandonmentMicros, 839680);
    const next = await acceptCreation(f.user, fresh.quote.id, randomUUID());
    assert.notEqual(next.operationId, old.operationId);
    assert.equal((await accountView(f.user)).billing.reserved, 30);
  } finally { f.close(); }
});

test("exact unsupported-model order closes with honest classification and one customer refund without image retry", async () => {
  const f = await lost(true);
  try {
    const before = f.budget.inspect();
    const preview = await abandonLostImageCreation(f.target, f.budget);
    assert.equal(preview.plan.policy, "unsupported-image-model-abandonment-v1");
    assert.equal(preview.plan.review.classification, "unsupported_image_model_400");
    assert.equal((await abandonLostImageCreation(f.target, f.budget, { applyPlan: preview.plan.planHash })).status, "applied");
    assert.equal((await abandonLostImageCreation(f.target, f.budget, { applyPlan: preview.plan.planHash })).status, "already_applied");
    const after = await readCreation(f.user.id, f.quoted.publication.id);
    assert.equal(after.creation.status, "failed");
    assert.match(after.publication.failure!, /rejected Kely's requested model/);
    assert.doesNotMatch(after.publication.failure!, /could not retain/);
    assert.deepEqual([(await accountView(f.user)).billing.weeklyRemaining, (await accountView(f.user)).billing.reserved], [100, 0]);
    await runCreation(f.accepted.operationId, { gateway: f.gateway });
    assert.equal(f.sends, 2);
    assert.equal(f.budget.inspect().availableMicros, before.availableMicros);
    assert.equal(f.budget.inspect().retainedAbandonmentMicros, 839680);
  } finally { f.close(); }
});

test("wrong owner, request evidence and changed publication refuse the closure without refund or ledger mutation", async () => {
  const f = await lost();
  try {
    const original = f.budget.inspect();
    await pool.query("UPDATE credit_account SET anchor_at=anchor_at-interval '8 days' WHERE owner_id=$1", [f.user.id]);
    const entries = await pool.query("SELECT id FROM credit_entry WHERE owner_id=$1 ORDER BY id", [f.user.id]);
    const plan = await abandonLostImageCreation(f.target, f.budget);
    assert.deepEqual((await pool.query("SELECT id FROM credit_entry WHERE owner_id=$1 ORDER BY id", [f.user.id])).rows, entries.rows);
    await assert.rejects(abandonLostImageCreation({ ...f.target, ownerId: randomUUID() }, f.budget), { code: "abandonment_conflict" });
    await assert.rejects(abandonLostImageCreation({ ...f.target, requestId: "req_different" }, f.budget), { code: "abandonment_not_reviewable" });
    await assert.rejects(abandonLostImageCreation(f.target, f.budget, { applyPlan: "0".repeat(64) }), { code: "abandonment_conflict" });
    await pool.query("UPDATE publication SET state=jsonb_set(state,'{idea}',to_jsonb('Intervening owner change'::text)) WHERE id=$1 AND owner_id=$2", [f.quoted.publication.id, f.user.id]);
    await assert.rejects(abandonLostImageCreation(f.target, f.budget, { applyPlan: plan.plan.planHash }), { code: "abandonment_conflict" });
    assert.equal((await accountView(f.user)).billing.reserved, 30);
    assert.deepEqual(f.budget.inspect(), original);
    assert.equal(f.sends, 2);
  } finally { f.close(); }
});
