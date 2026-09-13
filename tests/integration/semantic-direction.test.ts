import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pool } from "../../src/server/db";
import { getBoss } from "../../src/server/queue";
import { accountView, simulateBilling, type Viewer } from "../../src/server/credits";
import { readBrand, updateBrandRule } from "../../src/server/brand";
import { acceptQuote, approvePublication, createPublication, quoteOperation, readPublication, updatePublicationBrief } from "../../src/server/publications";
import { runOperation } from "../../src/server/generation-operations";
import { BudgetStore } from "../../src/server/budget/store";
import { FakeProviderGateway } from "../../src/server/providers/gateway";
import { previewTransport } from "../../src/server/providers/preview-transport";
import { initializeFakeBudget } from "../helpers/budget-fixture";

assert.match(process.env.KELY_DATABASE_URL ?? "", /\/kely_fixture_test$/u, "Use the isolated application test database.");
process.env.KELY_PROVIDER_MODE = "ai_preview";
process.env.KELY_LIVE_ENABLED = "false";
after(async () => { await (await getBoss()).stop({ graceful: true }); await pool.end(); });

async function owner(): Promise<Viewer> {
  const user = { id: randomUUID(), name: "Semantic direction test", email: `${randomUUID()}@fixture.example.test` };
  await pool.query('INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$2,$3,false)', [user.id, user.name, user.email]);
  await simulateBilling(user, "activate");
  return user;
}

test("no-material preparation persists a reviewable direction, requires combined approval and never changes Brand", async () => {
  const user = await owner(), foreign = await owner();
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "kely-semantic-direction-")));
  const budget = new BudgetStore(initializeFakeBudget(join(directory, "ledger")));
  const gateway = new FakeProviderGateway(budget, { kind: "fake", async send(request, context) {
    const response = await previewTransport.send(request, context) as any;
    const wire = JSON.parse(response.output[0].content[0].text);
    wire.plans[0] = { ...wire.plans[0], purpose: "explain", background: "foreground" };
    response.output[0].content[0].text = JSON.stringify(wire);
    return response;
  } });
  try {
    let brandBefore = await readBrand(user.id);
    await updateBrandRule(user, { field: "sourceStrategy", value: "decide_for_me", version: brandBefore.version, commandKey: randomUUID() });
    brandBefore = await readBrand(user.id);
    let state = await createPublication(user, { idea: "Introduce our neighborhood coffee shop without discounts", platform: "instagram", slideCount: 2 });
    assert.equal(state.designPolicy, "creative-intent-v9");
    assert.equal(state.brandBrief?.direction, "decide");
    state = await updatePublicationBrief(user, state.id, state.version, { ...state.brandBrief!, audience: "Neighbors looking for a welcoming coffee shop" });
    const quote = await quoteOperation(user, state.id, "prepare", state.version);
    const row = (await pool.query<{ input_snapshot: any }>("SELECT input_snapshot FROM quote WHERE id=$1", [quote.id])).rows[0];
    assert.deepEqual([row.input_snapshot.schemaVersion, row.input_snapshot.semanticDirection.mode], [12, "propose"]);
    const accepted = await acceptQuote(user, quote.id, randomUUID());
    await runOperation(accepted.operationId, { gateway });
    state = await readPublication(user.id, state.id);
    assert.equal(state.directionProposal?.status, "pending");
    assert.equal(state.slides.every((slide) => slide.creativePlan?.scene?.version === 2), true);
    await assert.rejects(quoteOperation(user, state.id, "cover", state.version), { code: "content_approval_required" });
    await assert.rejects(approvePublication(foreign, state.id, "content", state.version), { code: "not_found" });
    const stale = state.version;
    state = await approvePublication(user, state.id, "content", state.version);
    assert.equal(state.directionProposal?.status, "accepted");
    assert.equal(state.outlineApproved, true);
    assert.equal(state.artDirection?.direction.palette.background, state.directionProposal?.direction.palette.background);
    await assert.rejects(approvePublication(user, state.id, "content", stale), { code: "stale_version" });
    const brandAfter = await readBrand(user.id);
    assert.deepEqual({ version: brandAfter.version, rules: brandAfter.rules, events: brandAfter.events }, { version: brandBefore.version, rules: brandBefore.rules, events: brandBefore.events });
    const cover = await quoteOperation(user, state.id, "cover", state.version);
    const coverAccepted = await acceptQuote(user, cover.id, randomUUID());
    await runOperation(coverAccepted.operationId, { gateway });
    state = await readPublication(user.id, state.id);
    assert.equal(state.status, "cover_approval");
    assert.ok(state.slides[0].assetId);
    state = await approvePublication(user, state.id, "cover", state.version);
    const remaining = await quoteOperation(user, state.id, "remaining", state.version);
    const remainingAccepted = await acceptQuote(user, remaining.id, randomUUID());
    await runOperation(remainingAccepted.operationId, { gateway });
    state = await readPublication(user.id, state.id);
    assert.equal(state.status, "ready");
    const acceptedDirection = state.directionProposal!.direction;
    const secondAsset = state.slides[1].assetId;
    const revision = await quoteOperation(user, state.id, "revise", state.version, "Change the visual plan on slide 1");
    assert.equal(revision.scope?.kind, "plan");
    const revisionAccepted = await acceptQuote(user, revision.id, randomUUID());
    await runOperation(revisionAccepted.operationId, { gateway });
    state = await readPublication(user.id, state.id);
    const revisedScene = state.slides[0].creativePlan?.scene;
    assert.equal(revisedScene?.version, 2);
    if (revisedScene?.version === 2) {
      assert.equal(revisedScene.grammar, acceptedDirection.grammar);
      assert.equal(revisedScene.tone, acceptedDirection.tone);
    }
    assert.equal(state.slides[0].assetId, undefined);
    assert.equal(state.slides[1].assetId, secondAsset);
    state = await approvePublication(user, state.id, "content", state.version);
    const compose = await quoteOperation(user, state.id, "revise", state.version, "Compose approved slide 1");
    const composeAccepted = await acceptQuote(user, compose.id, randomUUID());
    await runOperation(composeAccepted.operationId, { gateway });
    state = await readPublication(user.id, state.id);
    assert.equal(state.status, "cover_approval");
    assert.equal(state.slides[1].assetId, secondAsset);
    state = await approvePublication(user, state.id, "cover", state.version);
    assert.equal(state.status, "ready");
  } finally { budget.close(); rmSync(directory, { recursive: true }); }
});

test("an unusable semantic proposal records provider cost, releases customer credits and is not retried", async () => {
  const user = await owner();
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "kely-semantic-invalid-")));
  const budget = new BudgetStore(initializeFakeBudget(join(directory, "ledger")));
  let sends = 0;
  const gateway = new FakeProviderGateway(budget, { kind: "fake", async send(request, context) {
    sends++;
    const response = await previewTransport.send(request, context) as any;
    const wire = JSON.parse(response.output[0].content[0].text);
    wire.semanticDirection.foreground = "#FFF8F1";
    response.output[0].content[0].text = JSON.stringify(wire);
    return response;
  } });
  try {
    const before = (await accountView(user)).billing.weeklyRemaining;
    let state = await createPublication(user, { idea: "Introduce a calm neighborhood bakery", platform: "instagram", slideCount: 1 });
    state = await updatePublicationBrief(user, state.id, state.version, { ...state.brandBrief!, direction: "decide", audience: "Nearby residents" });
    const quote = await quoteOperation(user, state.id, "prepare", state.version);
    const accepted = await acceptQuote(user, quote.id, randomUUID());
    await runOperation(accepted.operationId, { gateway });
    await runOperation(accepted.operationId, { gateway });
    state = await readPublication(user.id, state.id);
    assert.deepEqual([state.status, state.failureCode, sends], ["failed", "provider_output_unusable", 1]);
    assert.equal((await accountView(user)).billing.weeklyRemaining, before);
    assert.equal(budget.inspect().attempts[0].status, "settled");
    assert.equal(state.directionProposal, undefined);
  } finally { budget.close(); rmSync(directory, { recursive: true }); }
});

test("a pending direction cannot be accepted after its Brand snapshot changes", async () => {
  const user = await owner();
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "kely-semantic-stale-")));
  const budget = new BudgetStore(initializeFakeBudget(join(directory, "ledger")));
  const gateway = new FakeProviderGateway(budget, previewTransport);
  try {
    let state = await createPublication(user, { idea: "Introduce our independent studio", platform: "linkedin", slideCount: 1 });
    state = await updatePublicationBrief(user, state.id, state.version, { ...state.brandBrief!, direction: "decide", audience: "Local founders" });
    const quote = await quoteOperation(user, state.id, "prepare", state.version);
    const accepted = await acceptQuote(user, quote.id, randomUUID());
    await runOperation(accepted.operationId, { gateway });
    state = await readPublication(user.id, state.id);
    const brand = await readBrand(user.id);
    await updateBrandRule(user, { field: "sourceStrategy", value: "decide_for_me", version: brand.version, commandKey: randomUUID() });
    await assert.rejects(approvePublication(user, state.id, "content", state.version), { code: "brand_changed" });
  } finally { budget.close(); rmSync(directory, { recursive: true }); }
});
