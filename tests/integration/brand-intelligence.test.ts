import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Pool } from "pg";
import { BrandIntelligenceStore } from "../../src/server/brand-intelligence-store";
import { createBrandIntelligenceSnapshot, evidenceRecord } from "../../src/server/brand-intelligence";

test("durable research is idempotent, owner-scoped, append-only and retains partial outcomes and corrections", async () => {
  assert.match(process.env.KELY_DATABASE_URL ?? "", /\/kely_fixture_test$/);
  const schema = `brand_intelligence_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: process.env.KELY_DATABASE_URL, max: 1 });
  const pool = new Pool({ connectionString: process.env.KELY_DATABASE_URL, options: `-c search_path=${schema}`, max: 3 });
  const ownerId = randomUUID(); const foreignId = randomUUID();
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await pool.query(await readFile(new URL("../../migrations/001_local.sql", import.meta.url), "utf8"));
    await pool.query(await readFile(new URL("../../migrations/005_brand.sql", import.meta.url), "utf8"));
    await pool.query(await readFile(new URL("../../migrations/016_brand_intelligence.sql", import.meta.url), "utf8"));
    await pool.query(await readFile(new URL("../../migrations/017_brand_research_material.sql", import.meta.url), "utf8"));
    await pool.query('INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$2,$3,false),($4,$5,$6,false)', [ownerId, "Owner", `${ownerId}@fixture.test`, foreignId, "Foreign", `${foreignId}@fixture.test`]);
    const store = new BrandIntelligenceStore(pool);
    const key = `research-${randomUUID()}`;
    const input = { businessName: "Example", urls: ["https://example.com"] };
    const created = await store.start(ownerId, input, key);
    assert.equal(created.status, "queued");
    const minimal = await store.start(ownerId, { businessName: "Minimal", category: undefined, location: undefined }, `minimal-${randomUUID()}`);
    assert.deepEqual(minimal.input, { businessName: "Minimal" });
    assert.equal((await store.start(ownerId, { urls: ["https://example.com"], businessName: "Example" }, key)).id, created.id);
    await assert.rejects(store.start(ownerId, { businessName: "Changed" }, key), { code: "idempotency_conflict" });
    await assert.rejects(store.read(foreignId, created.id), { code: "research_not_found" });
    await assert.rejects(store.appendStatus(foreignId, created.id, "failed"), { code: "research_not_found" });

    const materialId = randomUUID();
    await pool.query("INSERT INTO brand_material(id,owner_id,role,kind,label,stored_name,mime,bytes,width,height,content_hash) VALUES($1,$2,'reference','image','Reference','fixture.png','image/png',10,10,10,$3)", [materialId, ownerId, "f".repeat(64)]);
    await pool.query("INSERT INTO brand_research_material(owner_id,run_id,material_id,material_version,original_hash,derivative_hash,role,observation,request_hash) VALUES($1,$2,$3,1,$4,$5,'reference',$6,$7)", [ownerId, created.id, materialId, "f".repeat(64), "e".repeat(64), JSON.stringify({ materialId, evidence: "Observed purple composition", purpose: "reference", confidence: "medium" }), "d".repeat(64)]);
    await assert.rejects(pool.query("UPDATE brand_research_material SET observation='{}' WHERE owner_id=$1 AND run_id=$2 AND material_id=$3", [ownerId, created.id, materialId]), /append-only/);

    const evidence = evidenceRecord({ id: randomUUID(), sourceKind: "website", sourceUrl: "https://example.com", excerpt: "Example makes useful products.", fetchedAt: "2026-09-21T12:00:00Z" });
    await store.addSource(ownerId, created.id, evidence, "partial");
    await store.appendStatus(ownerId, created.id, "resolving");
    await store.appendStatus(ownerId, created.id, "fetching");
    let view = await store.appendStatus(ownerId, created.id, "partial", { reason: "Social profile unavailable" });
    assert.equal(view.sources[0].outcome, "partial"); assert.deepEqual(view.statusDetail, { reason: "Social profile unavailable" });
    const snapshot = createBrandIntelligenceSnapshot({ id: randomUUID(), version: 1, createdAt: "2026-09-21T12:01:00Z", query: { businessName: "Example", userSuppliedUrls: ["https://example.com"] }, evidence: [evidence], entityCandidates: [{ id: "example", displayName: "Example", canonicalUrl: "https://example.com", evidenceIds: [evidence.id], signals: { userSuppliedUrl: true, officialSiteClaim: true, exactNameMatch: true, crossLinkedProfile: true } }], claims: [], requiredAssets: [] });
    const accepted = await store.acceptSnapshot(ownerId, created.id, snapshot);
    assert.deepEqual(await store.acceptSnapshot(ownerId, created.id, snapshot), accepted);
    await store.appendStatus(ownerId, created.id, "strategizing");
    view = await store.appendStatus(ownerId, created.id, "checking");
    view = await store.appendStatus(ownerId, created.id, "review_ready");
    assert.equal(view.snapshots.length, 1); assert.equal(view.snapshots[0].hash, accepted.hash);
    await assert.rejects(pool.query("UPDATE brand_research_snapshot SET snapshot='{}' WHERE id=$1", [accepted.id]), /append-only/);
    await assert.rejects(pool.query("DELETE FROM brand_research_source WHERE id=$1", [evidence.id]), /append-only/);

    const ambiguous = await store.start(ownerId, { businessName: "Ambiguous" }, `ambiguous-${randomUUID()}`);
    await store.appendStatus(ownerId, ambiguous.id, "resolving");
    await store.appendStatus(ownerId, ambiguous.id, "fetching");
    await store.appendStatus(ownerId, ambiguous.id, "extracting");
    assert.equal((await store.appendStatus(ownerId, ambiguous.id, "needs_input", { question: "business_identity" })).status, "needs_input");

    const correction = await store.start(ownerId, { businessName: "Example corrected" }, `correction-${randomUUID()}`, created.id);
    assert.equal(correction.supersedesRunId, created.id);
    assert.equal((await store.appendStatus(ownerId, correction.id, "failed", { reason: "Bounded extraction failed" })).status, "failed");
    assert.deepEqual((await store.read(ownerId, correction.id)).statusDetail, { reason: "Bounded extraction failed" });
    assert.equal((await store.read(ownerId, created.id)).status, "review_ready");
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
