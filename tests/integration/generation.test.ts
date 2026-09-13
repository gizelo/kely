import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pool } from "../../src/server/db";
import { accountView, simulateBilling, type Viewer } from "../../src/server/credits";
import { acceptQuote, addMessage, approvePublication, createPublication, quoteOperation, readPublication } from "../../src/server/publications";
import { runOperation } from "../../src/server/generation-operations";
import { operationView } from "../../src/server/operations";
import { getBoss } from "../../src/server/queue";
import { BudgetStore } from "../../src/server/budget/store";
import { FakeProviderGateway } from "../../src/server/providers/gateway";
import { previewTransport } from "../../src/server/providers/preview-transport";
import { initializeFakeBudget } from "../helpers/budget-fixture";
import type { BoundedTextRequest } from "../../src/server/providers/text-envelope";
import type { PublicationView, QuoteView } from "../../src/shared/contracts";
import { readBrand, updateBrandRule } from "../../src/server/brand";
import { confirmPreference } from "../../src/server/preferences";

assert.match(process.env.KELY_DATABASE_URL ?? "", /\/kely_fixture_test$/, "Use the isolated application test database.");
process.env.KELY_PROVIDER_MODE = "ai_preview";
process.env.KELY_LIVE_ENABLED = "false";

async function viewer(): Promise<Viewer> {
  const user = { id: randomUUID(), name: "M4B isolated test", email: `${randomUUID()}@fixture.example.test` };
  await pool.query('INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$2,$3,false)', [user.id, user.name, user.email]);
  await simulateBilling(user, "activate");
  await updateBrandRule(user, { field: "audience", value: "Workshop customers", version: 0, commandKey: randomUUID() });
  await updateBrandRule(user, { field: "palette", value: "indigo", version: 1, commandKey: randomUUID() });
  return user;
}

function runtime(transform?: (response: any, request: BoundedTextRequest, count: number) => any) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "kely-generation-")));
  const location = initializeFakeBudget(join(directory, "ledger"));
  let budget = new BudgetStore(location);
  let sends = 0;
  const transport = { kind: "fake" as const, async send(request: BoundedTextRequest, context: { attemptKey: string; signal: AbortSignal }) {
    sends++;
    const response = await previewTransport.send(request, context);
    return transform ? transform(response, request, sends) : response;
  } };
  let gateway = new FakeProviderGateway(budget, transport);
  return {
    get gateway() { return gateway; }, get budget() { return budget; }, get sends() { return sends; },
    restart() { budget.close(); budget = new BudgetStore(location); gateway = new FakeProviderGateway(budget, transport); },
    close() { budget.close(); rmSync(directory, { recursive: true }); },
  };
}

async function stage(user: Viewer, state: PublicationView, kind: QuoteView["kind"], gateway: FakeProviderGateway, instruction = "", options: { failBeforeCommit?: boolean; failAfterSlide?: number } = {}) {
  const quote = await quoteOperation(user, state.id, kind, state.version, instruction);
  const accepted = await acceptQuote(user, quote.id, randomUUID());
  await runOperation(accepted.operationId, { gateway, ...options });
  return { quote, operationId: accepted.operationId, state: await readPublication(user.id, state.id) };
}

after(async () => { await (await getBoss()).stop({ graceful: true }); await pool.end(); });

test("a resumed paid preparation keeps reservation and attempt count when runtime is unavailable after a settled response", async () => {
  const user = await viewer();
  const fake = runtime();
  try {
    const state = await createPublication(user, { idea: "Introduce the workshop and invite a question", platform: "instagram", slideCount: 1 });
    const quote = await quoteOperation(user, state.id, "prepare", state.version);
    const accepted = await acceptQuote(user, quote.id, randomUUID());
    await assert.rejects(runOperation(accepted.operationId, { gateway: fake.gateway, failBeforeCommit: true }), /PostgreSQL rollback/);
    const budgetBefore = fake.budget.inspect();
    assert.equal(budgetBefore.attempts[0].status, "settled");
    await runOperation(accepted.operationId, { gateway: fake.gateway, failBeforeGateway: true });
    const saved = await readPublication(user.id, state.id);
    assert.equal((await operationView(user.id, accepted.operationId)).status, "uncertain");
    assert.deepEqual([saved.preparation?.attemptsUsed, saved.preparation?.repliesUsed, saved.preparation?.paused], [1, 0, true]);
    assert.equal((await accountView(user)).billing.reserved, 3);
    assert.deepEqual(fake.budget.inspect(), budgetBefore);
    await assert.rejects(quoteOperation(user, state.id, "prepare", saved.version), { code: "attempt_uncertain" });
    await runOperation(accepted.operationId, { gateway: fake.gateway });
    assert.equal(fake.sends, 1);
  } finally { fake.close(); }
});

test("first useful reply survives PostgreSQL rollback and restart, activates exactly once, then permits only included preparation replies", async () => {
  const user = await viewer();
  const fake = runtime((response, _request, count) => {
    if (count === 1) response.output[0].content[0].text = JSON.stringify({ ...JSON.parse(response.output[0].content[0].text), kind: "questions", questions: ["Who should this post reach?"], uncertainFacts: [], caption: "", slides: [], plans: [], palette: "indigo" });
    return response;
  });
  try {
    let state = await createPublication(user, { idea: "A workshop for new customers", platform: "instagram", slideCount: 3 });
    const quote = await quoteOperation(user, state.id, "prepare", state.version);
    const accepted = await acceptQuote(user, quote.id, randomUUID());
    await assert.rejects(runOperation(accepted.operationId, { gateway: fake.gateway, failBeforeCommit: true }), /PostgreSQL rollback/);
    assert.equal(fake.sends, 1);
    assert.equal(fake.budget.inspect().attempts[0].status, "settled");
    assert.equal((await readPublication(user.id, state.id)).preparation?.repliesUsed, 0);
    assert.equal((await accountView(user)).billing.reserved, 3);
    assert.equal((await operationView(user.id, accepted.operationId)).status, "running");
    fake.restart();
    await runOperation(accepted.operationId, { gateway: fake.gateway });
    await runOperation(accepted.operationId, { gateway: fake.gateway });
    state = await readPublication(user.id, state.id);
    assert.equal(fake.sends, 1);
    assert.equal(state.status, "collecting");
    assert.deepEqual([state.preparation?.activated, state.preparation?.repliesUsed], [true, 1]);
    assert.deepEqual([(await accountView(user)).billing.weeklyRemaining, (await accountView(user)).billing.reserved], [97, 0]);
    state = await addMessage(user, state.id, "People visiting our workshop for the first time.", state.version);
    const second = await stage(user, state, "prepare", fake.gateway);
    assert.equal(second.quote.credits, 0);
    state = second.state;
    assert.equal(state.status, "content_approval");
    const third = await stage(user, state, "prepare", fake.gateway);
    assert.equal(third.quote.credits, 0);
    assert.equal(third.state.preparation?.repliesUsed, 3);
    assert.equal(fake.sends, 3);
    const fourth = await quoteOperation(user, state.id, "prepare", third.state.version);
    assert.equal(fourth.credits, 3);
    assert.equal(fourth.preparation?.included, false);
    state = await approvePublication(user, state.id, "content", third.state.version);
    await assert.rejects(acceptQuote(user, fourth.id, randomUUID()), { code: "stale_version" });
    await assert.rejects(quoteOperation(user, state.id, "prepare", state.version), { code: "wrong_stage" });
    assert.equal((await accountView(user)).billing.weeklyRemaining, 97);
  } finally { fake.close(); }
});

test("preparation suggestions require explicit owner-scoped confirmation and reuse the existing reply allowance", async () => {
  const user = await viewer();
  const foreign = await viewer();
  const fake = runtime((response, request, count) => {
    if (count !== 1) return response;
    const input = JSON.parse(request.input);
    const reply = JSON.parse(response.output[0].content[0].text);
    reply.preferences = { audience: [],
      headlines: [{ value: "shorter", scope: "durable", sourceRef: input.sourceCatalogue.entries.find((item: { text: string }) => item.text === "Always use short headlines.").id }],
      voice: [{ value: "Warm and concise", scope: "durable", sourceRef: input.sourceCatalogue.entries.find((item: { text: string }) => item.text === "For this post only, keep the voice warm.").id }],
    };
    response.output[0].content[0].text = JSON.stringify(reply);
    return response;
  });
  try {
    let state = await createPublication(user, { idea: "Always use short headlines. Introduce our workshop.", platform: "instagram", slideCount: 1 });
    state = await addMessage(user, state.id, "For this post only, keep the voice warm.", state.version);
    state = (await stage(user, state, "prepare", fake.gateway)).state;
    assert.equal(state.preferenceProposals?.length, 2);
    assert.equal(state.preferenceProposals!.find((item) => item.field === "voice")!.scope, "local");
    const currentBrand = await readBrand(user.id);
    assert.equal(currentBrand.rules.headlines, "default");
    const first = { proposalId: state.preferenceProposals!.find((item) => item.field === "headlines")!.id, scope: "durable" as const, version: state.version, brandVersion: currentBrand.version, commandKey: randomUUID() };
    await assert.rejects(confirmPreference(foreign, state.id, first), { code: "not_found" });
    const confirmed = await confirmPreference(user, state.id, first);
    state = confirmed.publication;
    assert.equal(confirmed.brand.rules.headlines, "shorter");
    assert.equal(state.status, "collecting");
    assert.equal(state.preparation?.repliesUsed, 1);
    assert.equal((await accountView(user)).billing.weeklyRemaining, 97);
    await assert.rejects(confirmPreference(user, state.id, { ...first, version: state.version, brandVersion: confirmed.brand.version }), { code: "preference_unavailable" });
    const second = { proposalId: state.preferenceProposals![0].id, scope: "durable" as const, version: state.version, brandVersion: confirmed.brand.version, commandKey: randomUUID() };
    await assert.rejects(confirmPreference(user, state.id, second), { code: "preference_scope" });
    state = (await confirmPreference(user, state.id, { ...second, scope: "local" })).publication;
    assert.equal(state.localPreferences?.voice, "Warm and concise");
    assert.equal((await readBrand(user.id)).rules.voice, undefined);
    const next = await stage(user, state, "prepare", fake.gateway);
    assert.equal(next.quote.credits, 0);
    assert.equal(next.state.preparation?.repliesUsed, 2);
    assert.equal(fake.sends, 2);
    assert.equal((await accountView(user)).billing.weeklyRemaining, 97);
  } finally { fake.close(); }
});

test("confirming a standing preference after content approval preserves the finished post", async () => {
  const user = await viewer();
  const fake = runtime((response, request) => {
    const input = JSON.parse(request.input as string);
    const reply = JSON.parse(response.output[0].content[0].text);
    const sourceRef = input.sourceCatalogue.entries.find((item: { text: string }) => item.text === "Always use short headlines.").id;
    reply.preferences = { audience: [], voice: [], headlines: [{ sourceRef, value: "shorter", scope: "durable" }] };
    response.output[0].content[0].text = JSON.stringify(reply);
    return response;
  });
  try {
    let state = await createPublication(user, { idea: "Always use short headlines. Introduce our workshop.", platform: "instagram", slideCount: 1 });
    state = (await stage(user, state, "prepare", fake.gateway)).state;
    const proposal = state.preferenceProposals![0];
    state = await approvePublication(user, state.id, "content", state.version);
    const before = structuredClone(state);
    const brand = await readBrand(user.id);
    await assert.rejects(confirmPreference(user, state.id, { proposalId: proposal.id, scope: "local", version: state.version, brandVersion: brand.version, commandKey: randomUUID() }), { code: "preference_scope" });
    const result = await confirmPreference(user, state.id, { proposalId: proposal.id, scope: "durable", version: state.version, brandVersion: brand.version, commandKey: randomUUID() });
    assert.equal(result.brand.rules.headlines, "shorter");
    assert.deepEqual({ status: result.publication.status, outlineApproved: result.publication.outlineApproved, slides: result.publication.slides, caption: result.publication.caption }, { status: before.status, outlineApproved: before.outlineApproved, slides: before.slides, caption: before.caption });
    assert.equal((await accountView(user)).billing.weeklyRemaining, 97);
  } finally { fake.close(); }
});

test("known failures preserve replies and provider spend; four bounded attempts never force a replacement package, uncertainty cannot retry", async () => {
  const user = await viewer();
  let mode: "invalid" | "success" | "uncertain" = "invalid";
  const fake = runtime((response) => {
    if (mode === "invalid") response.output[0].content[0].text = "not JSON";
    if (mode === "uncertain") response.model = "unreviewed-snapshot";
    return response;
  });
  try {
    let state = await createPublication(user, { idea: "A new service", platform: "linkedin", slideCount: 1 });
    state = (await stage(user, state, "prepare", fake.gateway)).state;
    const packageId = state.preparation?.id;
    assert.equal(state.preparation?.repliesUsed, 0);
    assert.equal((await accountView(user)).billing.weeklyRemaining, 100);
    assert.ok(fake.budget.inspect().settledMicros > 0);
    mode = "success";
    for (let reply = 1; reply <= 3; reply++) {
      const completed = await stage(user, state, "prepare", fake.gateway);
      state = completed.state;
      assert.equal(state.preparation?.id, packageId);
      assert.equal(state.preparation?.repliesUsed, reply);
      assert.equal(completed.quote.credits, reply === 1 ? 3 : 0);
    }
    assert.equal(state.preparation?.attemptsUsed, 4);
    assert.equal((await accountView(user)).billing.weeklyRemaining, 97);

    mode = "invalid";
    let paused = await createPublication(user, { idea: "A second post", platform: "linkedin", slideCount: 1 });
    paused = (await stage(user, paused, "prepare", fake.gateway)).state;
    paused = (await stage(user, paused, "prepare", fake.gateway)).state;
    assert.equal(paused.preparation?.paused, true);
    assert.equal(paused.preparation?.repliesRemaining, 3);
    await assert.rejects(quoteOperation(user, paused.id, "prepare", paused.version), { code: "package_paused" });

    mode = "uncertain";
    let unknown = await createPublication(user, { idea: "Unknown response", platform: "linkedin", slideCount: 1 });
    const stopped = await stage(user, unknown, "prepare", fake.gateway);
    unknown = stopped.state;
    const sends = fake.sends;
    await runOperation(stopped.operationId, { gateway: fake.gateway });
    assert.equal(fake.sends, sends);
    assert.equal((await operationView(user.id, stopped.operationId)).status, "uncertain");
    assert.equal(unknown.cost?.uncertainMicros, 532_373);
    assert.equal(unknown.cost?.basis, "maximum_reserved");
    assert.equal((await accountView(user)).billing.reserved, 3);
    await assert.rejects(quoteOperation(user, unknown.id, "prepare", unknown.version), { code: "attempt_uncertain" });
  } finally { fake.close(); }
});

test("composition is atomic, scoped copy requires reapproval, and unrelated assets and saved versions stay unchanged", async () => {
  const user = await viewer();
  const fake = runtime();
  try {
    let state = await createPublication(user, { idea: "Workshop welcome", platform: "instagram", slideCount: 3 });
    state = (await stage(user, state, "prepare", fake.gateway)).state;
    state = await approvePublication(user, state.id, "content", state.version);
    state = (await stage(user, state, "cover", fake.gateway)).state;
    const cover = state.slides[0].assetId;
    state = await approvePublication(user, state.id, "cover", state.version);
    const priorBalance = (await accountView(user)).billing.weeklyRemaining;
    const failure = await stage(user, state, "remaining", fake.gateway, "", { failAfterSlide: 1 });
    assert.equal(failure.state.status, "failed");
    assert.equal((await accountView(user)).billing.weeklyRemaining, priorBalance);
    assert.equal(failure.state.slides[0].assetId, cover);
    assert.equal(failure.state.slides[1].assetId, undefined);
    state = (await stage(user, failure.state, "remaining", fake.gateway)).state;
    const original = structuredClone(state);
    state = (await stage(user, state, "revise", fake.gateway, "Keep slide 1 unchanged, but rewrite slide 2")).state;
    assert.equal(state.outlineApproved, false);
    assert.equal(state.slides[1].assetId, undefined);
    assert.equal(state.slides[0].assetId, original.slides[0].assetId);
    assert.equal(state.slides[2].assetId, original.slides[2].assetId);
    assert.equal(state.caption, original.caption);
    await assert.rejects(quoteOperation(user, state.id, "revise", state.version, "Compose approved slide 2"), { code: "content_approval_required" });
    state = await approvePublication(user, state.id, "content", state.version);
    state = (await stage(user, state, "revise", fake.gateway, "Compose approved slide 2")).state;
    assert.equal(state.status, "ready");
    assert.equal(fake.sends, 2);
    assert.notEqual(state.slides[1].assetId, original.slides[1].assetId);
    const saved = (await pool.query("SELECT state FROM publication_version WHERE publication_id=$1 AND version=$2", [state.id, original.version])).rows[0].state;
    assert.deepEqual(saved.slides, original.slides);
    const revisedCopy = { title: state.slides[1].title, body: state.slides[1].body, caption: state.caption };
    state = (await stage(user, state, "revise", fake.gateway, "Make slide 2 warmer without changing the text")).state;
    assert.deepEqual({ title: state.slides[1].title, body: state.slides[1].body, caption: state.caption }, revisedCopy);
    assert.equal(state.slides[1].palette, "rose");
    assert.equal(state.slides[0].assetId, original.slides[0].assetId);
    assert.equal(state.slides[2].assetId, original.slides[2].assetId);
  } finally { fake.close(); }
});

test("queued fixture operations remain fixture when the new-operation mode changes", async () => {
  const user = await viewer();
  const fake = runtime();
  try {
    process.env.KELY_PROVIDER_MODE = "fixture";
    const state = await createPublication(user, { idea: "Existing fixture draft", platform: "linkedin", slideCount: 1 });
    const quote = await quoteOperation(user, state.id, "prepare", state.version);
    const accepted = await acceptQuote(user, quote.id, randomUUID());
    process.env.KELY_PROVIDER_MODE = "ai_preview";
    await runOperation(accepted.operationId, { gateway: fake.gateway });
    assert.equal(fake.sends, 0);
    assert.equal((await operationView(user.id, accepted.operationId)).origin, "fixture");
    assert.equal((await readPublication(user.id, state.id)).origin, "fixture");
    await assert.rejects(pool.query("UPDATE operation SET origin='ai_preview' WHERE id=$1", [accepted.operationId]), /immutable/);
  } finally { process.env.KELY_PROVIDER_MODE = "ai_preview"; fake.close(); }
});

test("an uncertain revision blocks all new paid actions and acceptance of earlier quotes without hiding saved work", async () => {
  const user = await viewer();
  let fail = false;
  const fake = runtime((response) => { if (fail) throw new Error("Simulated post-dispatch disconnect"); return response; });
  try {
    let state = await createPublication(user, { idea: "A welcome post", platform: "instagram", slideCount: 1 });
    state = (await stage(user, state, "prepare", fake.gateway)).state;
    state = await approvePublication(user, state.id, "content", state.version);
    state = (await stage(user, state, "cover", fake.gateway)).state;
    state = await approvePublication(user, state.id, "cover", state.version);
    const savedAsset = state.slides[0].assetId;
    const earlierQuote = await quoteOperation(user, state.id, "revise", state.version, "Rewrite slide 1");
    fail = true;
    const stopped = await stage(user, state, "revise", fake.gateway, "Make slide 1 warmer");
    state = stopped.state;
    assert.equal((await operationView(user.id, stopped.operationId)).status, "uncertain");
    const balance = await accountView(user);
    const sends = fake.sends;
    await assert.rejects(quoteOperation(user, state.id, "revise", state.version, "Rewrite slide 1"), { code: "attempt_uncertain" });
    await assert.rejects(quoteOperation(user, state.id, "cover", state.version), { code: "attempt_uncertain" });
    await assert.rejects(acceptQuote(user, earlierQuote.id, randomUUID()), { code: "attempt_uncertain" });
    await runOperation(stopped.operationId, { gateway: fake.gateway });
    assert.equal(fake.sends, sends);
    assert.deepEqual((await accountView(user)).billing, balance.billing);
    assert.equal((await readPublication(user.id, state.id)).slides[0].assetId, savedAsset);
  } finally { fake.close(); }
});
