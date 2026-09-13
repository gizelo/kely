import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BudgetStore } from "../../src/server/budget/store";
import { accountView, simulateBilling, type Viewer } from "../../src/server/credits";
import { pool } from "../../src/server/db";
import { runOperation } from "../../src/server/generation-operations";
import { operationView } from "../../src/server/operations";
import { acceptQuote, addMessage, createPublication, quoteOperation, readPublication } from "../../src/server/publications";
import { FakeProviderGateway } from "../../src/server/providers/gateway";
import { ReceivedTransportError } from "../../src/server/providers/http-transport";
import { previewTransport } from "../../src/server/providers/preview-transport";
import { getBoss } from "../../src/server/queue";
import { recoverFirstQuotaRejection } from "../../src/server/rejection-recovery";
import { initializeFakeBudget } from "../helpers/budget-fixture";

assert.match(process.env.KELY_DATABASE_URL ?? "", /\/kely_fixture_test$/, "Use only the isolated application test database.");
process.env.KELY_PROVIDER_MODE = "ai_preview";
process.env.KELY_LIVE_ENABLED = "false";

after(async () => { await (await getBoss()).stop({ graceful: true }); await pool.end(); });

async function rejected() {
  const viewer: Viewer = { id: randomUUID(), name: "Isolated rejection test", email: `${randomUUID()}@fixture.example.test` };
  await pool.query('INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$2,$3,false)', [viewer.id, viewer.name, viewer.email]);
  await simulateBilling(viewer, "activate");
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "kely-recovery-integration-")));
  const location = initializeFakeBudget(join(directory, "budget"));
  let budget = new BudgetStore(location);
  let sends = 0;
  let failAgain = false;
  const requestId = `req_${randomUUID().replaceAll("-", "")}`;
  const transport = { kind: "fake" as const, async send(request: Parameters<typeof previewTransport.send>[0], context: Parameters<typeof previewTransport.send>[1]) {
    sends++;
    if (sends === 1) throw new ReceivedTransportError({ http_status: 429, _request_id: requestId, error: { type: "insufficient_quota", code: "credit_balance_exhausted", param: null, message: "No prepaid credits remain." } });
    if (failAgain) throw new ReceivedTransportError({ http_status: 500, _request_id: `req_${randomUUID()}`, error: { message: "Fake server failure" } });
    return previewTransport.send(request, context);
  } };
  let gateway = new FakeProviderGateway(budget, transport);
  const original = await createPublication(viewer, { idea: "A workshop introduction for small businesses", platform: "linkedin", slideCount: 3 });
  const quote = await quoteOperation(viewer, original.id, "prepare", original.version);
  const accepted = await acceptQuote(viewer, quote.id, randomUUID());
  await runOperation(accepted.operationId, { gateway });
  return { viewer, original, quote, target: { ownerId: viewer.id, operationId: accepted.operationId, requestId },
    get budget() { return budget; }, get gateway() { return gateway; }, get sends() { return sends; },
    failNext() { failAgain = true; },
    reopen() { budget.close(); budget = new BudgetStore(location); gateway = new FakeProviderGateway(budget, transport); },
    close() { budget.close(); rmSync(directory, { recursive: true }); },
  };
}

test("review survives SQLite-first/PostgreSQL rollback and restores exactly one same-package retry without sending or losing exposure", async () => {
  const fake = await rejected();
  try {
    const failed = await readPublication(fake.viewer.id, fake.original.id);
    const initialBudget = fake.budget.inspect();
    const initialAccount = await accountView(fake.viewer);
    const preview = await recoverFirstQuotaRejection(fake.target, fake.budget);
    assert.equal(preview.status, "ready_for_review");
    assert.deepEqual(fake.budget.inspect(), initialBudget);
    assert.deepEqual(await readPublication(fake.viewer.id, fake.original.id), failed);
    assert.deepEqual(await accountView(fake.viewer), initialAccount);
    await assert.rejects(recoverFirstQuotaRejection(fake.target, fake.budget, { applyPlan: preview.plan.planHash, failBeforeCommit: true }), /recovery PostgreSQL rollback/);
    assert.equal(fake.budget.inspect().attempts[0].status, "rejected");
    assert.equal(fake.budget.inspect().uncertainMicros, 532_373);
    assert.deepEqual(await readPublication(fake.viewer.id, fake.original.id), failed);
    assert.equal((await accountView(fake.viewer)).billing.reserved, 3);
    await assert.rejects(quoteOperation(fake.viewer, failed.id, "prepare", failed.version), { code: "attempt_uncertain" });
    fake.reopen();
    assert.equal((await recoverFirstQuotaRejection(fake.target, fake.budget)).plan.planHash, preview.plan.planHash);
    assert.equal((await recoverFirstQuotaRejection(fake.target, fake.budget, { applyPlan: preview.plan.planHash })).status, "applied");
    let state = await readPublication(fake.viewer.id, failed.id);
    assert.deepEqual([state.preparation?.id, state.preparation?.repliesUsed, state.preparation?.attemptsUsed, state.preparation?.activated, state.preparation?.paused], [failed.preparation?.id, 0, 1, false, false]);
    assert.deepEqual([(await accountView(fake.viewer)).billing.weeklyRemaining, (await accountView(fake.viewer)).billing.reserved], [100, 0]);
    assert.equal(state.version, failed.version + 1);
    assert.deepEqual(state.history.slice(0, -1), failed.history);
    assert.equal((await recoverFirstQuotaRejection(fake.target, fake.budget, { applyPlan: preview.plan.planHash })).status, "already_applied");
    assert.equal((await readPublication(fake.viewer.id, state.id)).version, state.version);
    const old = await acceptQuote(fake.viewer, fake.quote.id, randomUUID());
    await runOperation(old.operationId, { gateway: fake.gateway });
    assert.equal(old.operationId, fake.target.operationId);
    assert.equal(fake.sends, 1);
    const next = await quoteOperation(fake.viewer, state.id, "prepare", state.version);
    assert.equal(next.credits, 3);
    const accepted = await acceptQuote(fake.viewer, next.id, randomUUID());
    assert.notEqual(accepted.operationId, fake.target.operationId);
    await runOperation(accepted.operationId, { gateway: fake.gateway });
    state = await readPublication(fake.viewer.id, state.id);
    assert.equal(fake.sends, 2);
    assert.equal(state.preparation?.id, failed.preparation?.id);
    assert.equal(state.preparation?.repliesUsed, 1);
    assert.equal(state.preparation?.attemptsUsed, 2);
    assert.equal((await accountView(fake.viewer)).billing.weeklyRemaining, 97);
    assert.equal(fake.budget.inspect().retainedRejectionMicros, 532_373);
    assert.equal(fake.budget.inspect().availableMicros, 10_000_000 - 532_373 - fake.budget.inspect().settledMicros);
    assert.equal((await operationView(fake.viewer.id, fake.target.operationId)).status, "failed");
    await assert.rejects(recoverFirstQuotaRejection(fake.target, fake.budget, { applyPlan: preview.plan.planHash }), { code: "recovery_conflict" });
    const marker = await pool.query("SELECT * FROM operation_recovery WHERE operation_id=$1", [fake.target.operationId]);
    assert.equal(marker.rowCount, 1);
    await assert.rejects(pool.query("UPDATE operation_recovery SET plan_hash='changed' WHERE operation_id=$1", [fake.target.operationId]), /immutable/);
  } finally { fake.close(); }
});

test("wrong targets, evidence, stale plans and intervening publication edits cannot release credits or review the authority", async () => {
  const fake = await rejected();
  try {
    const before = fake.budget.inspect();
    const state = await readPublication(fake.viewer.id, fake.original.id);
    const preview = await recoverFirstQuotaRejection(fake.target, fake.budget);
    await assert.rejects(recoverFirstQuotaRejection({ ...fake.target, ownerId: randomUUID() }, fake.budget), { code: "recovery_conflict" });
    await assert.rejects(recoverFirstQuotaRejection({ ...fake.target, operationId: randomUUID() }, fake.budget), { code: "recovery_conflict" });
    await assert.rejects(recoverFirstQuotaRejection({ ...fake.target, requestId: "req_wrong" }, fake.budget));
    await assert.rejects(recoverFirstQuotaRejection(fake.target, fake.budget, { applyPlan: "a".repeat(64) }), { code: "recovery_conflict" });
    const edited = await addMessage(fake.viewer, state.id, "An intervening user edit must remain saved.", state.version);
    await assert.rejects(recoverFirstQuotaRejection(fake.target, fake.budget, { applyPlan: preview.plan.planHash }), { code: "recovery_conflict" });
    assert.deepEqual(await readPublication(fake.viewer.id, state.id), edited);
    assert.deepEqual(fake.budget.inspect(), before);
    assert.equal((await accountView(fake.viewer)).billing.reserved, 3);
    assert.equal(fake.sends, 1);
  } finally { fake.close(); }
});

test("a failed explicit retry still pauses the same package and cannot reuse first-rejection recovery", async () => {
  const fake = await rejected();
  try {
    const preview = await recoverFirstQuotaRejection(fake.target, fake.budget);
    await recoverFirstQuotaRejection(fake.target, fake.budget, { applyPlan: preview.plan.planHash });
    const state = await readPublication(fake.viewer.id, fake.original.id);
    const quote = await quoteOperation(fake.viewer, state.id, "prepare", state.version);
    const accepted = await acceptQuote(fake.viewer, quote.id, randomUUID());
    fake.failNext();
    await runOperation(accepted.operationId, { gateway: fake.gateway });
    const failed = await readPublication(fake.viewer.id, state.id);
    assert.deepEqual([failed.preparation?.id, failed.preparation?.paused, failed.preparation?.attemptsUsed, failed.preparation?.repliesRemaining], [state.preparation?.id, true, 2, 3]);
    await assert.rejects(quoteOperation(fake.viewer, state.id, "prepare", failed.version), { code: "attempt_uncertain" });
    await assert.rejects(recoverFirstQuotaRejection(fake.target, fake.budget, { applyPlan: preview.plan.planHash }), { code: "recovery_conflict" });
    assert.equal(fake.sends, 2);
    assert.equal(fake.budget.inspect().uncertainMicros, 1_064_746);
  } finally { fake.close(); }
});
