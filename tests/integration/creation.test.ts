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
import { readBrand, undoBrand, uploadBrandMaterial, updateBrandRule } from "../../src/server/brand";
import { defaultArtDirection } from "../../src/server/brand-policy";
import { acceptCreation, cancelCreation, generateCreation, quoteCreation, quoteCreationRevision, readCreation, replyCreation } from "../../src/server/creation";
import { runCreation } from "../../src/server/creation-runner";
import { acceptQuote, quoteOperation } from "../../src/server/publications";
import { readAsset, exportPublication } from "../../src/server/renderer";
import { BudgetStore } from "../../src/server/budget/store";
import { FakeProviderGateway } from "../../src/server/providers/gateway";
import { previewTransport } from "../../src/server/providers/preview-transport";
import { initializeFakeBudget } from "../helpers/budget-fixture";

assert.match(process.env.KELY_DATABASE_URL ?? "", /\/kely_fixture_test$/u);
process.env.KELY_PROVIDER_MODE = "ai_preview";
process.env.KELY_LIVE_ENABLED = "false";
after(async () => { await (await getBoss()).stop({ graceful: true }); await pool.end(); });

async function owner(): Promise<Viewer> {
  const user = { id: randomUUID(), name: "Creation test", email: `${randomUUID()}@fixture.example.test` };
  await pool.query('INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$2,$3,false)', [user.id, user.name, user.email]);
  await simulateBilling(user, "activate");
  return user;
}

function fakeGateway() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "kely-unified-test-")));
  const budget = new BudgetStore(initializeFakeBudget(join(directory, "budget")));
  let sends = 0;
  const gateway = new FakeProviderGateway(budget, { kind: "fake", async send(request, context) {
    sends++;
    if ("prompt" in request) {
      const [width, height] = request.size.split("x").map(Number);
      const png = await sharp({ create: { width, height, channels: 3, background: "#C85A3A" } }).png().toBuffer();
      return { created: 1, _request_id: context.attemptKey, http_status: 200, data: [{ b64_json: png.toString("base64") }], usage: { input_tokens: 100, output_tokens: 6240, total_tokens: 6340, input_tokens_details: { text_tokens: 100, image_tokens: 0 } } };
    }
    const response = await previewTransport.send(request, context) as { output: { content: { text: string }[] }[] };
    if (typeof request.input === "string") {
      const input = JSON.parse(request.input);
      if (input.task === "revise" && input.instruction.includes("Always use shorter headlines")) {
        const source = input.sourceCatalogue.entries.find((entry: { text: string }) => entry.text === "Always use shorter headlines.");
        const output = JSON.parse(response.output[0].content[0].text);
        output.preferences.headlines = [{ sourceRef: source.id, value: "shorter", scope: "durable" }];
        response.output[0].content[0].text = JSON.stringify(output);
      }
    }
    return response;
  } });
  return { budget, gateway, get sends() { return sends; }, close() { budget.close(); rmSync(directory, { recursive: true, force: true }); } };
}

async function approvePlan(user: Viewer, publicationId: string) {
  const { publication, creation } = await readCreation(user.id, publicationId);
  assert.equal(creation.status, "plan_ready", publication.failure);
  assert.ok(creation.plan && !creation.plan.approved);
  const approval = { version: publication.version, planVersion: creation.plan.version, planHash: creation.plan.hash, requestKey: randomUUID() };
  await generateCreation(user, publicationId, approval);
  await generateCreation(user, publicationId, approval);
  return approval;
}

test("plan approval includes analysis, replays durable results and preserves scoped revisions", async () => {
  const user = await owner(), foreign = await owner(), fake = fakeGateway();
  try {
    const bytes = await sharp({ create: { width: 1200, height: 700, channels: 4, background: "#254BFF" } }).png().toBuffer();
    let brand = await uploadBrandMaterial(user, { bytes, label: "Interface", role: "original", version: 0 });
    const materialId = brand.materials[0].id;
    brand = await updateBrandRule(user, { field: "artDirection", value: { ...defaultArtDirection(null), heroMaterialIds: [materialId] }, version: brand.version, commandKey: randomUUID() });
    const quoted = await quoteCreation(user, { idea: "Explain our interface process to people who follow our work.", context: "Only describe supplied features; invite questions.", platform: "linkedin", slideCount: 3, analysisMaterialIds: [materialId] });
    assert.equal((await readCreation(user.id, quoted.publication.id)).creation.quote?.id, quoted.quote.id);
    assert.equal(fake.sends, 0);
    await assert.rejects(acceptCreation(foreign, quoted.quote.id, randomUUID()), { code: "not_found" });
    const accepted = await acceptCreation(user, quoted.quote.id, randomUUID());
    assert.deepEqual(await acceptCreation(user, quoted.quote.id, randomUUID()), accepted);
    assert.equal((await accountView(user)).billing.reserved, 30);
    await runCreation(accepted.operationId, { gateway: fake.gateway });
    assert.equal(fake.sends, 2);
    await approvePlan(user, accepted.publicationId);
    await assert.rejects(runCreation(accepted.operationId, { gateway: fake.gateway, failBeforeCommit: true }), /PostgreSQL rollback/);
    assert.equal(fake.sends, 2);
    assert.equal((await accountView(user)).billing.reserved, 30);
    await runCreation(accepted.operationId, { gateway: fake.gateway });
    await runCreation(accepted.operationId, { gateway: fake.gateway });
    assert.equal(fake.sends, 2);
    let { publication } = await readCreation(user.id, accepted.publicationId);
    assert.equal(publication.creation?.status, "ready");
    assert.equal(publication.status, "ready");
    assert.equal(publication.outlineApproved, false);
    assert.equal(publication.coverApproved, false);
    assert.equal(publication.slides.filter((slide) => slide.assetId).length, 3);
    assert.deepEqual((await accountView(user)).billing.weeklyRemaining, 70);
    assert.equal((await accountView(user)).billing.reserved, 0);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM preparation_package WHERE publication_id=$1", [publication.id])).rows[0].count, 0);
    assert.deepEqual((await readBrand(user.id)).rules, brand.rules);
    await assert.rejects(quoteOperation(user, publication.id, "cover", publication.version), { code: "unified_creation" });
    await assert.rejects(readCreation(foreign.id, publication.id), { code: "not_found" });
    const baseline = structuredClone(publication);
    const baselineBytes = await Promise.all(publication.slides.map((slide) => readAsset(user.id, slide.assetId!)));
    const revision = await quoteCreationRevision(user, publication.id, publication.version, "Rewrite the text on slide 2 more simply. Always use shorter headlines.");
    assert.equal(revision.credits, 11);
    const changed = await acceptQuote(user, revision.id, randomUUID());
    await runCreation(changed.operationId, { gateway: fake.gateway });
    publication = (await readCreation(user.id, publication.id)).publication;
    assert.equal(publication.status, "ready", publication.failure);
    assert.deepEqual([publication.slides[0], publication.slides[2], publication.caption], [baseline.slides[0], baseline.slides[2], baseline.caption]);
    assert.notEqual(publication.slides[1].assetId, baseline.slides[1].assetId);
    assert.equal(fake.sends, 3);
    assert.equal((await accountView(user)).billing.weeklyRemaining, 59);
    for (const index of [0, 2]) assert.deepEqual((await readAsset(user.id, publication.slides[index].assetId!)).bytes, baselineBytes[index].bytes);
    assert.ok((await exportPublication(user.id, publication.id, "zip")).bytes.length);
    assert.ok((await exportPublication(user.id, publication.id, "pdf")).bytes.length);
    assert.equal(publication.preferenceProposals?.some((item) => item.field === "headlines"), false);
    assert.equal(publication.autoSavedPreferences?.length, 1);
    let remembered = await readBrand(user.id);
    assert.equal(remembered.rules.headlines, "shorter");
    const eventId = publication.autoSavedPreferences![0].eventId;
    assert.equal(remembered.events.find((event) => event.id === eventId)?.field, "headlines");
    await runCreation(changed.operationId, { gateway: fake.gateway });
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM brand_event WHERE owner_id=$1 AND id=$2", [user.id, eventId])).rows[0].count, 1);
    remembered = await undoBrand(user, eventId, randomUUID());
    assert.equal(remembered.rules.headlines, "default");
    assert.equal(remembered.events[0].undoOf, eventId);
  } finally { fake.close(); }
});

test("creation clarification keeps its price and known partial failure releases the complete reservation", async () => {
  const user = await owner(), fake = fakeGateway();
  try {
    const quoted = await quoteCreation(user, { idea: "Announce a discount for our bakery.", platform: "instagram" });
    const accepted = await acceptCreation(user, quoted.quote.id, randomUUID());
    await runCreation(accepted.operationId, { gateway: fake.gateway });
    let result = await readCreation(user.id, accepted.publicationId);
    assert.equal(result.creation.status, "needs_input", result.publication.failure);
    assert.equal((await accountView(user)).billing.reserved, 30);
    const answer = { version: result.publication.version, message: "The offer is 10% off pastries today only.", requestKey: randomUUID() };
    await replyCreation(user, result.publication.id, answer);
    await replyCreation(user, result.publication.id, answer);
    await assert.rejects(replyCreation(user, result.publication.id, { ...answer, message: "Different answer" }), { code: "idempotency_conflict" });
    await runCreation(accepted.operationId, { gateway: fake.gateway });
    await approvePlan(user, accepted.publicationId);
    await runCreation(accepted.operationId, { gateway: fake.gateway, failAfterSlide: 0 });
    result = await readCreation(user.id, accepted.publicationId);
    assert.equal(result.creation.status, "failed", result.publication.failure);
    assert.equal(result.publication.failureCode, "composition_failed");
    assert.equal((await accountView(user)).billing.weeklyRemaining, 100);
    assert.equal((await accountView(user)).billing.reserved, 0);
    assert.equal(fake.sends, 3);
    assert.ok(fake.budget.inspect().settledMicros > 0);
    assert.equal(result.publication.slides.length, 1);
  } finally { fake.close(); }
});

test("no-material creation produces a saved illustration and full downloads once after final rollback", async () => {
  const user = await owner(), fake = fakeGateway();
  try {
    let brand = await readBrand(user.id);
    brand = await updateBrandRule(user, { field: "sourceStrategy", value: "use_materials", version: brand.version, commandKey: randomUUID() });
    await updateBrandRule(user, { field: "artDirection", value: defaultArtDirection(null), version: brand.version, commandKey: randomUUID() });
    const quoted = await quoteCreation(user, { idea: "Introduce our independent bakery and invite readers to visit.", context: "Use a friendly, handcrafted editorial illustration, not a photograph.", platform: "instagram", slideCount: 1 });
    const accepted = await acceptCreation(user, quoted.quote.id, randomUUID());
    await runCreation(accepted.operationId, { gateway: fake.gateway });
    assert.equal(fake.sends, 1);
    const approvedCopy = (await readCreation(user.id, accepted.publicationId)).publication;
    await approvePlan(user, accepted.publicationId);
    await assert.rejects(runCreation(accepted.operationId, { gateway: fake.gateway, failBeforeCommit: true }), /PostgreSQL rollback/);
    const settled = fake.budget.inspect().settledMicros;
    assert.equal(fake.sends, 2);
    assert.equal((await accountView(user)).billing.reserved, 30);
    await runCreation(accepted.operationId, { gateway: fake.gateway });
    const { publication } = await readCreation(user.id, quoted.publication.id);
    assert.equal(publication.status, "ready", publication.failure);
    assert.equal(publication.outlineApproved, false);
    assert.equal(publication.coverApproved, false);
    assert.ok(publication.slides[0].title && publication.slides[0].body);
    assert.deepEqual(publication.slides.map(({ title, body }) => ({ title, body })), approvedCopy.slides.map(({ title, body }) => ({ title, body })));
    assert.equal(publication.caption, approvedCopy.caption);
    assert.equal(publication.slides[0].artworkId, publication.artwork?.assetId);
    assert.equal(publication.artwork?.origin, "ai_preview");
    const asset = await readAsset(user.id, publication.slides[0].assetId!);
    const png = await sharp(asset.bytes).metadata();
    assert.deepEqual([png.width, png.height], [1080, 1350]);
    assert.ok((await exportPublication(user.id, publication.id, "zip")).bytes.length);
    assert.ok((await exportPublication(user.id, publication.id, "pdf")).bytes.length);
    assert.equal(fake.budget.inspect().settledMicros, settled);
    assert.equal(fake.sends, 2);
    assert.equal((await accountView(user)).billing.weeklyRemaining, 70);
    assert.equal((await accountView(user)).billing.reserved, 0);
  } finally { fake.close(); }
});

test("resumed runtime failure cannot release a previously dispatched creation or admit replacement work", async () => {
  const user = await owner(), fake = fakeGateway();
  try {
    const quoted = await quoteCreation(user, { idea: "Introduce our independent bakery.", platform: "instagram" });
    const accepted = await acceptCreation(user, quoted.quote.id, randomUUID());
    await assert.rejects(runCreation(accepted.operationId, { gateway: fake.gateway, failBeforeStepSave: true }), /persistence failure/);
    const settled = fake.budget.inspect().settledMicros;
    assert.ok(settled > 0);
    await runCreation(accepted.operationId, { gateway: fake.gateway, failBeforeGateway: true });
    const { publication } = await readCreation(user.id, quoted.publication.id);
    assert.equal(publication.creation?.status, "paused");
    assert.equal((await accountView(user)).billing.reserved, 30);
    assert.equal(fake.budget.inspect().settledMicros, settled);
    assert.equal(fake.sends, 1);
    await assert.rejects(quoteCreationRevision(user, publication.id, publication.version, "Rewrite the text on slide 1"), { code: "revision_unavailable" });
    const replacement = await quoteCreation(user, { idea: "Another bakery post.", platform: "instagram" });
    await assert.rejects(acceptCreation(user, replacement.quote.id, randomUUID()), { code: "creation_pending" });
    assert.equal((await accountView(user)).billing.reserved, 30);
  } finally { fake.close(); }
});

test("plan comments invalidate approval, text stays bounded and cancellation preserves work", async () => {
  const user = await owner(), foreign = await owner(), fake = fakeGateway();
  try {
    const quoted = await quoteCreation(user, { idea: "Introduce our bakery.", platform: "instagram", slideCount: 1 });
    const accepted = await acceptCreation(user, quoted.quote.id, randomUUID());
    await assert.rejects(generateCreation(user, accepted.publicationId, { version: 1, planVersion: 1, planHash: "0".repeat(64), requestKey: randomUUID() }), { code: "plan_required" });
    await runCreation(accepted.operationId, { gateway: fake.gateway });
    let result = await readCreation(user.id, accepted.publicationId);
    const initial = { version: result.publication.version, planVersion: result.creation.plan!.version, planHash: result.creation.plan!.hash, requestKey: randomUUID() };
    await assert.rejects(generateCreation(foreign, accepted.publicationId, initial), { code: "not_found" });
    await replyCreation(user, accepted.publicationId, { version: result.publication.version, message: "Make this four slides and use a warmer and friendlier tone.", requestKey: randomUUID() });
    await assert.rejects(generateCreation(user, accepted.publicationId, initial), { code: "stale_version" });
    await runCreation(accepted.operationId, { gateway: fake.gateway });
    result = await readCreation(user.id, accepted.publicationId);
    assert.equal(result.creation.plan!.version, 2);
    assert.equal(result.publication.slideCount, 4);
    assert.equal(result.publication.slides.length, 4);
    assert.notEqual(result.creation.plan!.hash, initial.planHash);
    await replyCreation(user, accepted.publicationId, { version: result.publication.version, message: "Keep the headline short.", requestKey: randomUUID() });
    await runCreation(accepted.operationId, { gateway: fake.gateway });
    result = await readCreation(user.id, accepted.publicationId);
    assert.equal(result.creation.status, "plan_ready");
    assert.equal(result.creation.canReply, false);
    assert.equal(result.creation.discussionLimitReached, true);
    assert.equal(result.creation.plan!.approved, false);
    assert.equal(result.publication.slideCount, 4);
    assert.equal(fake.sends, 3);
    assert.ok(result.publication.slides.every(slide => !slide.artworkId && !slide.assetId));
    await assert.rejects(replyCreation(user, accepted.publicationId, { version: result.publication.version, message: "Another change", requestKey: randomUUID() }), { code: "stale_version" });
    const cost = fake.budget.inspect().settledMicros;
    const cancelled = await cancelCreation(user, accepted.publicationId, result.publication.version);
    assert.deepEqual(cancelled.publication.slides, result.publication.slides);
    await cancelCreation(user, accepted.publicationId, result.publication.version);
    assert.equal(fake.budget.inspect().settledMicros, cost);
    assert.equal((await accountView(user)).billing.reserved, 0);
    assert.equal((await accountView(user)).billing.weeklyRemaining, 100);
    const next = await quoteCreation(user, { idea: "Introduce another pastry.", platform: "instagram" });
    await acceptCreation(user, next.quote.id, randomUUID());
  } finally { fake.close(); }
});
