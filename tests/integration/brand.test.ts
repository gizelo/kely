import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile, rename } from "node:fs/promises";
import { after, test } from "node:test";
import sharp from "sharp";
import { pool } from "../../src/server/db";
import { accountView, simulateBilling, type Viewer } from "../../src/server/credits";
import { archiveBrandMaterial, importBrandReferences, readBrand, readBrandMaterial, readSourceBundle, rememberBrand, undoBrand, updateBrandRule, updateSourceStrategy, uploadBrandMaterial } from "../../src/server/brand";
import { acceptQuote, approvePublication, createPublication, quoteOperation, readPublication, updatePublicationBrief } from "../../src/server/publications";
import { runFixtureOperation } from "../../src/server/operations";
import { getBoss } from "../../src/server/queue";
import { loadAcceptedInput } from "../../src/server/accepted-input";
import { materialRoot, normalizeMaterial } from "../../src/server/brand-materials";
import { runOperation } from "../../src/server/generation-operations";
import type { FakeProviderGateway } from "../../src/server/providers/gateway";

assert.match(process.env.KELY_DATABASE_URL ?? "", /\/kely_fixture_test$/u, "Only the isolated test database is allowed.");
process.env.KELY_PROVIDER_MODE = "fixture";
process.env.KELY_LIVE_ENABLED = "false";
after(async () => { await (await getBoss()).stop({ graceful: true }); await pool.end(); });
async function owner(paid = true): Promise<Viewer> {
  const viewer = { id: randomUUID(), name: "Isolated brand test", email: `${randomUUID()}@fixture.example.test` };
  await pool.query('INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$2,$3,false)', [viewer.id, viewer.name, viewer.email]);
  if (paid) await simulateBilling(viewer, "activate");
  return viewer;
}
async function image() { return sharp({ create: { width: 20, height: 20, channels: 3, background: "#223344" } }).png().toBuffer(); }

test("public reference import stores an immutable source descriptor and normalized reference only, while a stale version stops before acquisition", async () => {
  const user = await owner(); const unpaid = await owner(false);
  const normalized = await normalizeMaterial(await image());
  let acquisitions = 0;
  const commandKey = randomUUID();
  const acquire = async (sourceUrl: string) => {
    acquisitions++;
    return {
      references: [{ sourceUrl: "https://cdn.example.test/preview.jpg", ...normalized }],
      outcome: { status: "imported" as const, imported: 1, message: "Imported one public reference.", sourceUrl, kind: "direct_url" as const, state: "available" as const, code: "direct_image_imported" as const },
    };
  };
  await assert.rejects(importBrandReferences(unpaid, { label: "Denied", sourceUrl: "https://example.test/denied", version: 0 }, acquire), { code: "entitlement_required" });
  assert.equal(acquisitions, 0);
  const result = await importBrandReferences(user, { label: "Public example", sourceUrl: "https://example.test/post", version: 0, commandKey }, acquire);
  assert.equal(result.brand.version, 1);
  assert.equal(result.source?.kind, "direct_url");
  assert.equal(result.source?.state, "available");
  assert.equal(result.brand.materials.length, 2);
  const descriptor = result.brand.materials.find((material) => material.kind === "link")!;
  const imported = result.brand.materials.find((material) => material.kind === "image")!;
  assert.equal(descriptor.role, "reference"); assert.equal(imported.role, "reference");
  assert.equal(descriptor.sourceUrl, "https://example.test/post");
  assert.equal(imported.sourceUrl, "https://cdn.example.test/preview.jpg");
  assert.deepEqual((await readBrandMaterial(user.id, imported.id)).bytes, normalized.data);
  const replay = await importBrandReferences(user, { label: "Public example", sourceUrl: "https://example.test/post", version: 0, commandKey }, acquire);
  assert.equal(replay.source?.id, result.source?.id);
  assert.equal(replay.brand.version, result.brand.version);
  assert.equal(acquisitions, 1);
  await assert.rejects(importBrandReferences(user, { label: "Changed", sourceUrl: "https://example.test/post", version: result.brand.version, commandKey }, acquire), { code: "idempotency_conflict" });
  await assert.rejects(importBrandReferences(user, { label: "Stale", sourceUrl: "https://example.test/stale", version: 0 }, acquire), { code: "brand_changed" });
  assert.equal(acquisitions, 1);
});

test("source bundle preserves inaccessible social provenance, screenshot fallback, strategy and deterministic readiness", async () => {
  const user = await owner(); const foreign = await owner();
  const creditsBefore = Number((await pool.query("SELECT count(*) FROM credit_entry WHERE owner_id=$1", [user.id])).rows[0].count);
  const noPreview = async (sourceUrl: string) => ({ references: [], outcome: { status: "fallback" as const, imported: 0, message: "Upload screenshots.", sourceUrl, kind: "social" as const, state: "needs_upload" as const, code: "social_preview_missing" as const } });
  const imported = await importBrandReferences(user, { label: "Instagram examples", sourceUrl: "https://www.instagram.com/example", version: 0 }, noPreview);
  assert.equal(imported.bundle?.summary.nextAction, "upload_screenshots");
  assert.equal(imported.source?.materials.filter((item) => item.kind === "image").length, 0);
  assert.equal(imported.bundle?.completeness.selectableAnalysisMaterialIds.length, 0);
  const sourceId = imported.source!.id;
  await assert.rejects(uploadBrandMaterial(foreign, { bytes: await image(), label: "Foreign fallback", role: "reference", version: 0, fallbackForSourceId: sourceId }), { code: "not_found" });
  const uploadKey = randomUUID();
  const screenshot = await image();
  const brand = await uploadBrandMaterial(user, { bytes: screenshot, label: "Saved post screenshot", role: "reference", version: imported.brand.version, fallbackForSourceId: sourceId, commandKey: uploadKey });
  assert.equal((await uploadBrandMaterial(user, { bytes: screenshot, label: "Saved post screenshot", role: "reference", version: imported.brand.version, fallbackForSourceId: sourceId, commandKey: uploadKey })).version, brand.version);
  await assert.rejects(uploadBrandMaterial(user, { bytes: screenshot, label: "Changed screenshot", role: "reference", version: brand.version, fallbackForSourceId: sourceId, commandKey: uploadKey }), { code: "idempotency_conflict" });
  let bundle = await readSourceBundle(user.id);
  assert.equal(bundle.sources.find((item) => item.fallbackFor === sourceId)?.state, "available");
  assert.equal(bundle.completeness.recommendations.some((item) => item.code === "social_screenshots_recommended"), false);
  assert.equal(bundle.completeness.selectableAnalysisMaterialIds.length, 1);
  assert.equal(bundle.summary.nextAction, "analyze_references");
  bundle = await updateSourceStrategy(user, "use_materials", brand.version, randomUUID());
  assert.equal(bundle.strategy, "use_materials");
  assert.equal(bundle.completeness.status, "ready");
  bundle = await updateSourceStrategy(user, "decide_for_me", bundle.brandVersion, randomUUID());
  assert.equal(bundle.completeness.optional.some((item) => item.code === "creative_choices_delegated"), true);
  assert.equal(Number((await pool.query("SELECT count(*) FROM credit_entry WHERE owner_id=$1", [user.id])).rows[0].count), creditsBefore);
  const fallbackSource = bundle.sources.find((item) => item.fallbackFor === sourceId)!;
  const fallbackImage = fallbackSource.materials.find((item) => item.kind === "image")!;
  await archiveBrandMaterial(user, fallbackImage.id, bundle.brandVersion);
  bundle = await readSourceBundle(user.id);
  assert.equal(bundle.sources.find((item) => item.id === fallbackSource.id)?.state, "needs_upload");
  assert.equal(bundle.summary.unavailable.some((item) => item.includes("Saved post screenshot")), true);
  await assert.rejects(pool.query("UPDATE brand_source SET outcome_code='page_preview_missing' WHERE id=$1", [sourceId]), /immutable/);
});

test("private materials and selective memory preserve ownership, unrelated Undo changes, immutable rows and retained quota", async () => {
  const user = await owner(); const foreign = await owner(); const unpaid = await owner(false);
  const bytes = await image();
  await assert.rejects(uploadBrandMaterial(unpaid, { bytes, label: "No access", role: "reference", version: 0 }), { code: "entitlement_required" });
  let brand = await uploadBrandMaterial(user, { bytes, label: "Reference only", role: "reference", version: 0 });
  const id = brand.materials[0].id;
  await assert.rejects(readBrandMaterial(foreign.id, id), { code: "not_found" });
  await assert.rejects(archiveBrandMaterial(foreign, id, 0), { code: "not_found" });
  assert.deepEqual((await readBrandMaterial(user.id, id)).bytes, bytes);
  const local = await rememberBrand(user, "No photo in this post", brand.version, randomUUID());
  assert.equal(local.interpretation.status, "local"); assert.equal(local.brand.version, brand.version);
  brand = (await rememberBrand(user, "Always use shorter headlines", brand.version, randomUUID())).brand;
  const selected = brand.events[0];
  brand = await updateBrandRule(user, { field: "palette", value: "forest", version: brand.version, commandKey: randomUUID() });
  const undoKey = randomUUID();
  brand = await undoBrand(user, selected.id, undoKey);
  assert.equal(brand.rules.headlines, "default"); assert.equal(brand.rules.palette, "forest");
  assert.equal((await undoBrand(user, selected.id, undoKey)).version, brand.version);
  await assert.rejects(undoBrand(user, selected.id, randomUUID()), { code: "undo_conflict" });
  await assert.rejects(undoBrand(foreign, selected.id, randomUUID()), { code: "not_found" });
  await assert.rejects(pool.query("UPDATE brand_material SET content_hash='changed' WHERE id=$1", [id]), /immutable/);
  brand = await archiveBrandMaterial(user, id, brand.version);
  assert.equal(brand.materials.length, 0);
  assert.deepEqual((await readBrandMaterial(user.id, id)).bytes, bytes);
  await pool.query("INSERT INTO brand_material(id,owner_id,role,kind,label,bytes,archived_at) SELECT gen_random_uuid(),$1,'reference','link','Retained fixture',0,now() FROM generate_series(1,99)", [user.id]);
  await assert.rejects(uploadBrandMaterial(user, { bytes, label: "Quota bypass", role: "reference", version: brand.version }), { code: "material_quota" });
});

test("brand snapshots pin queued inputs and require new acceptance after changes; readiness prevents reservation and required unsupported placement", async () => {
  const user = await owner(); const other = await owner();
  let brand = await updateBrandRule(user, { field: "audience", value: "Local clients", version: 0, commandKey: randomUUID() });
  brand = await updateBrandRule(user, { field: "palette", value: "rose", version: brand.version, commandKey: randomUUID() });
  brand = await uploadBrandMaterial(user, { bytes: await image(), label: "Logo original", role: "original", version: brand.version });
  const material = brand.materials[0];
  let state = await createPublication(user, { idea: "Meet our team", platform: "linkedin", slideCount: 1 });
  state = await updatePublicationBrief(user, state.id, state.version, { ...state.brandBrief!, noPhoto: true });
  const stale = await quoteOperation(user, state.id, "prepare", state.version);
  brand = await updateBrandRule(user, { field: "headlines", value: "shorter", version: brand.version, commandKey: randomUUID() });
  await assert.rejects(acceptQuote(user, stale.id, randomUUID()), { code: "brand_changed" });
  assert.equal((await accountView(user)).billing.reserved, 0);
  const quote = await quoteOperation(user, state.id, "prepare", state.version);
  const accepted = await acceptQuote(user, quote.id, randomUUID());
  const { snapshot, hash } = await loadAcceptedInput(user.id, accepted.operationId);
  assert.equal(snapshot.schemaVersion, 3); assert.equal(snapshot.brand!.materials[0].contentHash, material.contentHash);
  brand = await updateBrandRule(user, { field: "palette", value: "forest", version: brand.version, commandKey: randomUUID() });
  await runFixtureOperation(accepted.operationId);
  state = await readPublication(user.id, state.id);
  assert.equal(state.brandPalette, "rose"); assert.equal((await loadAcceptedInput(user.id, accepted.operationId)).hash, hash);
  const foreignMaterial = (await uploadBrandMaterial(other, { bytes: await image(), label: "Foreign", role: "original", version: 0 })).materials[0];
  await assert.rejects(updatePublicationBrief(user, state.id, state.version, { ...state.brandBrief!, requiredMaterialIds: [foreignMaterial.id] }), { code: "material_missing" });
  state = await updatePublicationBrief(user, state.id, state.version, { ...state.brandBrief!, requiredMaterialIds: [material.id] });
  await assert.rejects(approvePublication(user, state.id, "content", state.version), { code: "brand_not_ready" });
  assert.equal((await accountView(user)).billing.reserved, 0);
  state = await updatePublicationBrief(user, state.id, state.version, { ...state.brandBrief!, requiredMaterialIds: [] });
  state = await approvePublication(user, state.id, "content", state.version);
  const cover = await quoteOperation(user, state.id, "cover", state.version);
  const coverAccepted = await acceptQuote(user, cover.id, randomUUID());
  await runFixtureOperation(coverAccepted.operationId);
  assert.equal((await readPublication(user.id, state.id)).status, "cover_approval");
  const second = await createPublication(user, { idea: "A different topic", platform: "linkedin", slideCount: 1 });
  assert.equal(second.brandBrief!.noPhoto, false); assert.equal(second.brandBrief!.direction, "forest");
  assert.equal((await readBrand(user.id)).rules.headlines, "shorter");
});

test("confirmed art direction renders actual originals from immutable snapshots and object Undo preserves unrelated rules", async () => {
  const user = await owner();
  let brand = await uploadBrandMaterial(user, { bytes: await image(), label: "Original logo", role: "original", version: 0 });
  const id = brand.materials[0].id;
  const direction = { policy: "art-direction-v1" as const, palette: { background: "#F5F0E3", foreground: "#203528", accent: "#347344", muted: "#DDDFD0" }, headingFont: "serif" as const, composition: "editorial" as const, spacing: "open" as const, logoMaterialId: id, heroMaterialIds: [] };
  const key = randomUUID();
  brand = await updateBrandRule(user, { field: "artDirection", value: direction, version: brand.version, commandKey: key });
  const selected = brand.events[0];
  assert.deepEqual(brand.rules.artDirection, direction);
  assert.equal((await updateBrandRule(user, { field: "artDirection", value: structuredClone(direction), version: 0, commandKey: key })).version, brand.version);
  brand = await updateBrandRule(user, { field: "audience", value: "Local owners", version: brand.version, commandKey: randomUUID() });
  let state = await createPublication(user, { idea: "A thoughtful new service", platform: "instagram", slideCount: 1 });
  state = await updatePublicationBrief(user, state.id, state.version, { ...state.brandBrief!, requiredMaterialIds: [id] });
  const quote = await quoteOperation(user, state.id, "prepare", state.version);
  const accepted = await acceptQuote(user, quote.id, randomUUID());
  const before = await loadAcceptedInput(user.id, accepted.operationId);
  brand = await undoBrand(user, selected.id, randomUUID());
  assert.equal(brand.rules.artDirection, null);
  assert.equal(brand.rules.audience, "Local owners");
  await runFixtureOperation(accepted.operationId);
  state = await readPublication(user.id, state.id);
  assert.deepEqual(state.artDirection?.direction, direction);
  assert.equal((await loadAcceptedInput(user.id, accepted.operationId)).hash, before.hash);
  assert.equal(state.readiness?.ready, true);
  state = await approvePublication(user, state.id, "content", state.version);
  const cover = await acceptQuote(user, (await quoteOperation(user, state.id, "cover", state.version)).id, randomUUID());
  await runFixtureOperation(cover.operationId);
  state = await readPublication(user.id, state.id);
  assert.equal(state.status, "cover_approval");
  assert.ok(state.slides[0].assetId);
  assert.deepEqual((await loadAcceptedInput(user.id, cover.operationId)).snapshot.brand!.art!.originals.map((item) => item.id), [id]);
});

test("upload commit acknowledgement loss preserves committed bytes; proven metadata rollback cleans only its own file", async () => {
  const user = await owner(); const bytes = await image();
  const originalConnect = pool.connect.bind(pool);
  let commits = 0;
  pool.connect = (async () => {
    const client = await originalConnect();
    const originalQuery = client.query.bind(client);
    const originalRelease = client.release.bind(client);
    client.query = (async (...args: any[]) => {
      const value = await (originalQuery as any)(...args);
      if (args[0] === "COMMIT" && ++commits === 2) throw new Error("Injected lost commit acknowledgement");
      return value;
    }) as typeof client.query;
    client.release = ((...args: any[]) => { client.query = originalQuery as typeof client.query; client.release = originalRelease; originalRelease(...args); }) as typeof client.release;
    return client;
  }) as typeof pool.connect;
  try { await assert.rejects(uploadBrandMaterial(user, { bytes, label: "Committed", role: "reference", version: 0 }), /lost commit acknowledgement/); }
  finally { pool.connect = originalConnect; }
  const brand = await readBrand(user.id);
  assert.equal(brand.materials.length, 1);
  assert.deepEqual((await readBrandMaterial(user.id, brand.materials[0].id)).bytes, bytes);
  const before = (await readdir(materialRoot)).sort();
  await pool.query("CREATE OR REPLACE FUNCTION reject_test_material() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.label='Injected rollback' THEN RAISE EXCEPTION 'Injected metadata rollback'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_test_material BEFORE INSERT ON brand_material FOR EACH ROW EXECUTE FUNCTION reject_test_material();");
  try { await assert.rejects(uploadBrandMaterial(user, { bytes, label: "Injected rollback", role: "reference", version: brand.version }), /Injected metadata rollback/); }
  finally { await pool.query("DROP TRIGGER reject_test_material ON brand_material; DROP FUNCTION reject_test_material();"); }
  assert.deepEqual((await readdir(materialRoot)).sort(), before);
  const row = (await pool.query("SELECT stored_name FROM brand_material WHERE id=$1", [brand.materials[0].id])).rows[0];
  assert.deepEqual(await readFile(`${materialRoot}/${row.stored_name}`), bytes);
});

test("missing accepted material fails before provider dispatch and restores the preparation attempt and credits", async () => {
  const user = await owner();
  const brand = await uploadBrandMaterial(user, { bytes: await image(), label: "Isolated preflight", role: "reference", version: 0 });
  process.env.KELY_PROVIDER_MODE = "ai_preview";
  let state = await createPublication(user, { idea: "Our team", platform: "linkedin", slideCount: 1 });
  const quote = await quoteOperation(user, state.id, "prepare", state.version);
  const accepted = await acceptQuote(user, quote.id, randomUUID());
  const row = (await pool.query("SELECT stored_name FROM brand_material WHERE id=$1", [brand.materials[0].id])).rows[0];
  const original = `${materialRoot}/${row.stored_name}`;
  const held = `${original}.isolated-test-held`;
  let sends = 0;
  await rename(original, held);
  try {
    await runOperation(accepted.operationId, { gateway: { async dispatch() { sends++; throw new Error("No provider should be reached"); } } as unknown as FakeProviderGateway });
  } finally { await rename(held, original); process.env.KELY_PROVIDER_MODE = "fixture"; }
  state = await readPublication(user.id, state.id);
  assert.equal(sends, 0);
  assert.equal(state.failureCode, "material_unavailable");
  assert.equal(state.preparation?.attemptsUsed, 0);
  assert.equal(state.preparation?.repliesUsed, 0);
  assert.equal(state.preparation?.paused, false);
  assert.equal((await accountView(user)).billing.reserved, 0);
  assert.equal((await accountView(user)).billing.weeklyRemaining, 100);
  process.env.KELY_PROVIDER_MODE = "ai_preview";
  const retry = await quoteOperation(user, state.id, "prepare", state.version);
  const resumed = await acceptQuote(user, retry.id, randomUUID());
  const priorCost = { basis: "maximum_reserved", settledMicros: 0, uncertainMicros: 532373, simulated: true, model: "gpt-5.6-luna" };
  await pool.query("UPDATE operation SET status='running',cost=$2 WHERE id=$1", [resumed.operationId, JSON.stringify(priorCost)]);
  await rename(original, held);
  try {
    await runOperation(resumed.operationId, { gateway: { async dispatch() { sends++; throw new Error("No current send"); } } as unknown as FakeProviderGateway });
  } finally { await rename(held, original); process.env.KELY_PROVIDER_MODE = "fixture"; }
  state = await readPublication(user.id, state.id);
  assert.equal(sends, 0);
  assert.equal(state.preparation?.attemptsUsed, 1);
  assert.equal(state.preparation?.paused, true);
  assert.equal((await accountView(user)).billing.reserved, 3);
  assert.deepEqual(state.cost, priorCost);
  assert.deepEqual((await pool.query("SELECT cost FROM operation WHERE id=$1", [resumed.operationId])).rows[0].cost, priorCost);
  await assert.rejects(quoteOperation(user, state.id, "prepare", state.version), { code: "attempt_uncertain" });
});
