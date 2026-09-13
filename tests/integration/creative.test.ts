import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import sharp from "sharp";
import { pool } from "../../src/server/db";
import { getBoss } from "../../src/server/queue";
import { accountView, simulateBilling, type Viewer } from "../../src/server/credits";
import { readBrand, updateBrandRule, uploadBrandMaterial } from "../../src/server/brand";
import { acceptAnalysis, quoteAnalysis, runAnalysis } from "../../src/server/brand-analysis";
import { acceptQuote, addMessage, approvePublication, createPublication, quoteOperation, readPublication } from "../../src/server/publications";
import { runOperation } from "../../src/server/generation-operations";
import { BudgetStore } from "../../src/server/budget/store";
import { FakeProviderGateway } from "../../src/server/providers/gateway";
import { previewTransport } from "../../src/server/providers/preview-transport";
import { initializeFakeBudget } from "../helpers/budget-fixture";
import { defaultArtDirection } from "../../src/server/brand-policy";
import { canonicalJson } from "../../src/server/paid-input";
import type { PublicationView, OperationKind } from "../../src/shared/contracts";

assert.match(process.env.KELY_DATABASE_URL ?? "", /\/kely_fixture_test$/u);
process.env.KELY_PROVIDER_MODE = "ai_preview";
process.env.KELY_LIVE_ENABLED = "false";
after(async () => { await (await getBoss()).stop({ graceful: true }); await pool.end(); });

async function owner(): Promise<Viewer> {
  const user = { id: randomUUID(), name: "Creative fixture", email: `${randomUUID()}@fixture.example.test` };
  await pool.query('INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$2,$3,false)', [user.id, user.name, user.email]);
  await simulateBilling(user, "activate");
  return user;
}

test("idea-first creative preparation freezes selected source evidence and preserves unrelated slides through scoped revision", async () => {
  const user = await owner(), foreign = await owner();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kely-creative-ledger-")));
  const budget = new BudgetStore(initializeFakeBudget(join(root, "ledger")));
  let sends = 0;
  const laterLocalFeedback = "For this post only, use a friendly voice and the title A clearer view.";
  let forwardedLocalFeedback = false;
  const gateway = new FakeProviderGateway(budget, { kind: "fake", async send(request, context) {
    sends++;
    const response = await previewTransport.send(request, context) as { output: { content: { text: string }[] }[] };
    if (!("prompt" in request) && typeof request.input === "string") {
      const input = JSON.parse(request.input);
      const message = input.messages.find((item: { role: string; text: string }) => item.role === "user" && item.text === laterLocalFeedback);
      if (input.task === "prepare") {
        const content = response.output[0].content[0];
        const reply = JSON.parse(content.text);
        reply.brief.facts = [input.sourceCatalogue.entries[0].id];
        content.text = JSON.stringify(reply);
      }
      if (input.task === "prepare" && message) {
        forwardedLocalFeedback = true;
        const content = response.output[0].content[0];
        const reply = JSON.parse(content.text);
        reply.slides[0].title = "A clearer view";
        const sourceRef = input.sourceCatalogue.entries.find((entry: { sourceId: string }) => entry.sourceId === message.id).id;
        reply.preferences = { audience: [], voice: [{ sourceRef, value: "friendly", scope: "local" }], headlines: [{ sourceRef, value: "specific and concise copy", scope: "local" }] };
        content.text = JSON.stringify(reply);
      }
    }
    return response;
  } });
  try {
    const bytes = await sharp({ create: { width: 1200, height: 700, channels: 4, background: "#254BFF" } }).png().toBuffer();
    let brand = await uploadBrandMaterial(user, { bytes, label: "Glass cubes", role: "original", version: 0 });
    const first = brand.materials[0].id;
    brand = await uploadBrandMaterial(user, { bytes, label: "Desktop interface", role: "original", version: brand.version });
    const second = brand.materials.find((material) => material.id !== first)!.id;
    brand = await updateBrandRule(user, { field: "artDirection", value: { ...defaultArtDirection(null), headingFont: "unbounded", heroMaterialIds: [first, second], composition: "image-led" }, version: brand.version, commandKey: randomUUID() });
    assert.equal(brand.rules.audience, "");
    const analysis = await quoteAnalysis(user, { materialIds: [first, second], guidance: "Selected visual guidance only", version: brand.version });
    await acceptAnalysis(user, analysis.id, randomUUID());
    const analysisOperation = (await pool.query("SELECT operation_id FROM brand_analysis WHERE id=$1", [analysis.id])).rows[0].operation_id;
    await runAnalysis(analysisOperation, { gateway });
    await assert.rejects(createPublication(foreign, { idea: "A useful idea", platform: "instagram", slideCount: 3, sourceAnalysisId: analysis.id }), { code: "analysis_unavailable" });
    let state = await createPublication(user, { idea: "Explain our interface to people exploring our business, then invite a question.", platform: "instagram", slideCount: 3, sourceAnalysisId: analysis.id });
    assert.equal(state.designPolicy, "creative-intent-v9");
    assert.equal(state.sourceAnalysis?.id, analysis.id);
    async function stage(kind: OperationKind, instruction = "") {
      const quote = await quoteOperation(user, state.id, kind, state.version, instruction);
      const accepted = await acceptQuote(user, quote.id, randomUUID());
      await runOperation(accepted.operationId, { gateway });
      if (quote.scope?.kind === "plan") {
        const balance = (await accountView(user)).billing;
        const beforeSends = sends;
        assert.deepEqual(await acceptQuote(user, quote.id, randomUUID()), accepted);
        await runOperation(accepted.operationId, { gateway });
        assert.equal(sends, beforeSends);
        assert.deepEqual((await accountView(user)).billing, balance);
      }
      state = await readPublication(user.id, state.id);
      assert.notEqual(state.status, "failed", state.failure);
      return quote;
    }
    const preparation = await stage("prepare");
    const saved = (await pool.query("SELECT input_snapshot FROM quote WHERE id=$1", [preparation.id])).rows[0].input_snapshot;
    assert.equal(saved.schemaVersion, 12);
    assert.equal(saved.semanticDirection.mode, "inherit");
    assert.deepEqual(saved.publication.sourceAnalysis, state.sourceAnalysis);
    assert.equal(state.proposedBrief?.audience.basis, "proposed");
    assert.equal(state.proposedBrief?.facts[0].value, state.messages[0].text);
    assert.equal(state.readiness?.ready, true);
    assert.deepEqual(state.slides.map((slide) => slide.creativePlan?.recipe), ["graphic-stage", "image-evidence", "closing"]);
    assert.deepEqual(state.slides.map((slide) => slide.creativePlan?.scene?.composition), ["editorial-offset", "signal-grid", "action-frame"]);
    assert.equal((await readBrand(user.id)).rules.audience, "");
    const beforeFeedback = await readBrand(user.id);
    const localBefore = state.localPreferences;
    state = await addMessage(user, state.id, laterLocalFeedback, state.version);
    const continuation = await stage("prepare");
    assert.equal(continuation.credits, 0);
    assert.equal(forwardedLocalFeedback, true);
    assert.equal(state.slides[0].title, "A clearer view");
    assert.equal(state.preferenceProposals?.[0].scope, "local");
    assert.match(state.messages.at(-1)!.text, /Some memory suggestions were not saved/);
    assert.deepEqual(state.localPreferences, localBefore);
    assert.deepEqual(await readBrand(user.id), beforeFeedback);
    state = await approvePublication(user, state.id, "content", state.version);
    await stage("cover");
    state = await approvePublication(user, state.id, "cover", state.version);
    await stage("remaining");
    const baseline: PublicationView = structuredClone(state);
    const copyQuote = await stage("revise", "Rewrite the text on slide 2 more simply");
    assert.equal(copyQuote.credits, 3);
    assert.equal(state.outlineApproved, false);
    assert.equal(state.slides[1].assetId, undefined);
    assert.equal(canonicalJson(state.slides[1].creativePlan), canonicalJson(baseline.slides[1].creativePlan));
    assert.deepEqual([state.slides[0], state.slides[2], state.caption], [baseline.slides[0], baseline.slides[2], baseline.caption]);
    state = await approvePublication(user, state.id, "content", state.version);
    await stage("revise", "Compose approved slide 2");
    assert.equal(state.status, "ready");
    assert.notEqual(state.slides[1].assetId, baseline.slides[1].assetId);
    assert.deepEqual([state.slides[0], state.slides[2], state.caption], [baseline.slides[0], baseline.slides[2], baseline.caption]);
    assert.equal(sends, 4);
    const beforePlan = structuredClone(state);
    const planQuote = await stage("revise", "Change the visual plan on slide 2");
    assert.equal(planQuote.credits, 3); assert.match(planQuote.summary, /11 total if composed/);
    assert.equal(state.slides[1].creativePlan?.recipe, "type-poster");
    assert.deepEqual([state.slides[1].title, state.slides[1].body, state.caption], [beforePlan.slides[1].title, beforePlan.slides[1].body, beforePlan.caption]);
    assert.deepEqual([state.slides[0], state.slides[2]], [beforePlan.slides[0], beforePlan.slides[2]]);
    await assert.rejects(quoteOperation(user, state.id, "revise", state.version, "Compose approved slide 2"), { code: "content_approval_required" });
    state = await approvePublication(user, state.id, "content", state.version);
    const composeQuote = await stage("revise", "Compose approved slide 2");
    assert.equal(composeQuote.credits, 8); assert.equal(state.status, "ready");
    assert.equal(sends, 5);
    assert.deepEqual([state.slides[0], state.slides[2]], [beforePlan.slides[0], beforePlan.slides[2]]);
    const beforeCoverPlan = structuredClone(state);
    await stage("revise", "Change the visual plan on slide 1");
    assert.deepEqual([state.slides[1], state.slides[2]], [beforeCoverPlan.slides[1], beforeCoverPlan.slides[2]]);
    state = await approvePublication(user, state.id, "content", state.version);
    await stage("revise", "Compose approved slide 1");
    assert.equal(state.status, "cover_approval");
    assert.equal(state.slides.every((slide) => Boolean(slide.assetId)), true);
    state = await approvePublication(user, state.id, "cover", state.version);
    assert.equal(state.status, "ready");
    assert.deepEqual([state.slides[1], state.slides[2]], [beforeCoverPlan.slides[1], beforeCoverPlan.slides[2]]);
    assert.equal(sends, 6);
    assert.equal((await accountView(user)).billing.reserved, 0);
  } finally { budget.close(); rmSync(root, { recursive: true }); }
});
