import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import sharp from "sharp";
import { pool } from "../../src/server/db";
import { accountView, simulateBilling, type Viewer } from "../../src/server/credits";
import { readBrand, readBrandMaterial, updateBrandRule, uploadBrandMaterial } from "../../src/server/brand";
import { acceptAnalysis, analysisDerivative, applyAnalysis, quoteAnalysis, readAnalysis, runAnalysis } from "../../src/server/brand-analysis";
import { getBoss } from "../../src/server/queue";
import { BudgetStore } from "../../src/server/budget/store";
import { FakeProviderGateway, type FakeTextTransport } from "../../src/server/providers/gateway";
import { previewTransport } from "../../src/server/providers/preview-transport";
import { initializeFakeBudget } from "../helpers/budget-fixture";

assert.match(process.env.KELY_DATABASE_URL ?? "", /\/kely_fixture_test$/u);
process.env.KELY_PROVIDER_MODE = "ai_preview";
process.env.KELY_LIVE_ENABLED = "false";
after(async () => { await (await getBoss()).stop({ graceful: true }); await pool.end(); });

async function owner(): Promise<Viewer> {
  const user = { id: randomUUID(), name: "Isolated analysis", email: `${randomUUID()}@fixture.example.test` };
  await pool.query('INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$2,$3,false)', [user.id, user.name, user.email]);
  await simulateBilling(user, "activate");
  return user;
}
async function source(user: Viewer) {
  const bytes = await sharp({ create: { width: 200, height: 100, channels: 4, background: { r: 20, g: 50, b: 90, alpha: 0 } } }).png().toBuffer();
  return { bytes, brand: await uploadBrandMaterial(user, { bytes, label: "Exact test source", role: "reference", version: 0 }) };
}
function fake(transform?: (response: any) => any) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kely-analysis-ledger-")));
  const location = initializeFakeBudget(join(root, "ledger"));
  let store = new BudgetStore(location), sends = 0;
  const transport: FakeTextTransport = { kind: "fake", async send(request, context) { sends++; const response = await previewTransport.send(request, context); return transform ? transform(response) : response; } };
  let gateway = new FakeProviderGateway(store, transport);
  return { get gateway() { return gateway; }, get store() { return store; }, get sends() { return sends; }, reopen() { store.close(); store = new BudgetStore(location); gateway = new FakeProviderGateway(store, transport); }, close() { store.close(); rmSync(root, { recursive: true }); } };
}
async function operationId(analysisId: string) { return (await pool.query("SELECT operation_id FROM brand_analysis WHERE id=$1", [analysisId])).rows[0].operation_id as string; }

test("analysis freezes exact private derivatives, charges atomically after restart and applies only with explicit brand-version confirmation", async () => {
  const user = await owner(), other = await owner();
  const { bytes, brand } = await source(user);
  const id = brand.materials[0].id;
  const quote = await quoteAnalysis(user, { materialIds: [id], guidance: "Inspect only this supplied image", version: brand.version });
  assert.equal(quote.credits, 3); assert.equal(quote.status, "quoted");
  assert.equal((await accountView(user)).billing.reserved, 0);
  await assert.rejects(analysisDerivative(other.id, quote.id, id), { code: "not_found" });
  const derivative = await analysisDerivative(user.id, quote.id, id);
  assert.equal((await sharp(derivative).metadata()).format, "jpeg");
  assert.deepEqual(await sharp(derivative).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer(), Buffer.from([255, 255, 255]));
  assert.deepEqual((await readBrandMaterial(user.id, id)).bytes, bytes);
  await assert.rejects(pool.query("UPDATE brand_analysis SET snapshot='{}' WHERE id=$1", [quote.id]), /immutable/);
  await updateBrandRule(user, { field: "audience", value: "Owners", version: brand.version, commandKey: randomUUID() });
  await assert.rejects(acceptAnalysis(user, quote.id, randomUUID()), { code: "brand_changed" });
  const current = await readBrand(user.id);
  const fresh = await quoteAnalysis(user, { materialIds: [id], guidance: "Same explicit scope", version: current.version });
  await acceptAnalysis(user, fresh.id, randomUUID());
  await acceptAnalysis(user, fresh.id, randomUUID());
  assert.equal((await accountView(user)).billing.reserved, 3);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM preparation_package WHERE owner_id=$1", [user.id])).rows[0].n, 0);
  const runtime = fake();
  try {
    const op = await operationId(fresh.id);
    await assert.rejects(runAnalysis(op, { gateway: runtime.gateway, failBeforeCommit: true }), /useful-result rollback/);
    assert.equal(runtime.sends, 1); assert.equal(runtime.store.inspect().attempts[0].status, "settled");
    assert.equal((await readAnalysis(user.id, fresh.id)).status, "running");
    assert.equal((await accountView(user)).billing.reserved, 3);
    runtime.reopen();
    await runAnalysis(op, { gateway: runtime.gateway });
    await runAnalysis(op, { gateway: runtime.gateway });
    const result = await readAnalysis(user.id, fresh.id);
    assert.equal(result.status, "completed"); assert.equal(result.applied, false); assert.equal(runtime.sends, 1);
    assert.equal((await readBrand(user.id)).rules.artDirection, undefined);
    assert.equal((await accountView(user)).billing.weeklyRemaining, 97);
    assert.equal((await accountView(user)).billing.reserved, 0);
    await assert.rejects(applyAnalysis(other, fresh.id, { version: current.version, commandKey: randomUUID() }), { code: "not_found" });
    const applied = await applyAnalysis(user, fresh.id, { version: current.version, commandKey: randomUUID() });
    assert.equal(applied.analysis.applied, true); assert.equal(applied.brand.events[0].field, "artDirection");
    assert.equal((await applyAnalysis(user, fresh.id, { version: current.version, commandKey: randomUUID() })).brand.version, applied.brand.version);
    assert.equal(runtime.sends, 1);
  } finally { runtime.close(); }
});

test("unusable source promotion releases only customer credits; uncertainty blocks new and preexisting analysis quotes", async () => {
  const user = await owner();
  const { brand } = await source(user);
  const id = brand.materials[0].id;
  let mode: "invalid" | "uncertain" = "invalid";
  const runtime = fake((response) => {
    if (mode === "uncertain") { response.model = "unreviewed-model"; return response; }
    const reply = JSON.parse(response.output[0].content[0].text);
    reply.direction.logoMaterialId = id;
    response.output[0].content[0].text = JSON.stringify(reply);
    return response;
  });
  try {
    const first = await quoteAnalysis(user, { materialIds: [id], guidance: "Analysis", version: brand.version });
    await acceptAnalysis(user, first.id, randomUUID());
    await runAnalysis(await operationId(first.id), { gateway: runtime.gateway });
    assert.equal((await readAnalysis(user.id, first.id)).status, "failed");
    assert.equal((await accountView(user)).billing.weeklyRemaining, 100);
    assert.ok(runtime.store.inspect().settledMicros > 0);
    const next = await quoteAnalysis(user, { materialIds: [id], guidance: "Explicit new analysis", version: brand.version });
    const preexisting = await quoteAnalysis(user, { materialIds: [id], guidance: "Another quote", version: brand.version });
    mode = "uncertain";
    await acceptAnalysis(user, next.id, randomUUID());
    await runAnalysis(await operationId(next.id), { gateway: runtime.gateway });
    assert.equal((await readAnalysis(user.id, next.id)).status, "uncertain");
    assert.equal((await accountView(user)).billing.reserved, 3);
    assert.equal(runtime.store.inspect().uncertainMicros, 532373);
    await assert.rejects(quoteAnalysis(user, { materialIds: [id], guidance: "Repeat", version: brand.version }), { code: "analysis_pending" });
    await assert.rejects(acceptAnalysis(user, preexisting.id, randomUUID()), { code: "analysis_pending" });
    await runAnalysis(await operationId(next.id), { gateway: runtime.gateway });
    assert.equal(runtime.sends, 2);
  } finally { runtime.close(); }
});

test("a resumed analysis with unavailable runtime preserves prior provider evidence and customer reservation", async () => {
  const user = await owner();
  const { brand } = await source(user);
  const quote = await quoteAnalysis(user, { materialIds: [brand.materials[0].id], guidance: "Explicit analysis", version: brand.version });
  await acceptAnalysis(user, quote.id, randomUUID());
  const id = await operationId(quote.id);
  const runtime = fake();
  try {
    await assert.rejects(runAnalysis(id, { gateway: runtime.gateway, failBeforeCommit: true }), /useful-result rollback/);
    const evidence = runtime.store.inspect();
    assert.equal(evidence.attempts[0].status, "settled");
    await runAnalysis(id, { gateway: runtime.gateway, failBeforeGateway: true });
    assert.equal((await readAnalysis(user.id, quote.id)).status, "uncertain");
    assert.equal((await accountView(user)).billing.reserved, 3);
    assert.equal(runtime.sends, 1);
    assert.deepEqual(runtime.store.inspect(), evidence);
    await assert.rejects(quoteAnalysis(user, { materialIds: [brand.materials[0].id], guidance: "Repeat", version: brand.version }), { code: "analysis_pending" });
  } finally { runtime.close(); }
});
