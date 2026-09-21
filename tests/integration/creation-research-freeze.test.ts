import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Pool } from "pg";
import { createBrandIntelligenceSnapshot, evidenceRecordFromSpan } from "../../src/server/brand-intelligence";
import { BrandIntelligenceStore } from "../../src/server/brand-intelligence-store";
import { freezeCreationResearch, verifyCreationResearch } from "../../src/server/creation-input";

test("creation research freeze is owner-scoped and binds the latest exact snapshot and evidence", async () => {
  assert.match(process.env.KELY_DATABASE_URL ?? "", /\/kely_fixture_test$/u);
  const schema = `creation_research_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: process.env.KELY_DATABASE_URL, max: 1 });
  const pool = new Pool({ connectionString: process.env.KELY_DATABASE_URL, options: `-c search_path=${schema}`, max: 3 });
  const ownerId = randomUUID();
  const foreignId = randomUUID();
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await pool.query(await readFile(new URL("../../migrations/001_local.sql", import.meta.url), "utf8"));
    await pool.query(await readFile(new URL("../../migrations/016_brand_intelligence.sql", import.meta.url), "utf8"));
    await pool.query('INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$2,$3,false),($4,$5,$6,false)', [ownerId, "Owner", `${ownerId}@fixture.test`, foreignId, "Foreign", `${foreignId}@fixture.test`]);
    const store = new BrandIntelligenceStore(pool);
    const run = await store.start(ownerId, { businessName: "Girex", idea: "Introduce Girex", platform: "linkedin" }, `research-${randomUUID()}`);
    await store.appendStatus(ownerId, run.id, "resolving");
    await store.appendStatus(ownerId, run.id, "fetching");
    await store.appendStatus(ownerId, run.id, "extracting");
    await store.appendStatus(ownerId, run.id, "strategizing");
    await store.appendStatus(ownerId, run.id, "checking");
    const content = "Girex is a crypto wallet interface.";
    const evidence = evidenceRecordFromSpan({ id: randomUUID(), sourceKind: "website", sourceRole: "official", sourceUrl: "https://girex.io/", content, span: { start: 0, end: content.length }, fetchedAt: "2026-09-21T12:00:00Z" });
    await store.addSource(ownerId, run.id, evidence, "complete");
    const baseSnapshot = createBrandIntelligenceSnapshot({
      id: randomUUID(), version: 1, createdAt: "2026-09-21T12:01:00Z",
      query: { businessName: "Girex", userSuppliedUrls: ["https://girex.io/"] }, evidence: [evidence],
      entityCandidates: [{ id: "girex", displayName: "Girex", canonicalUrl: "https://girex.io/", evidenceIds: [evidence.id], signals: { userSuppliedUrl: true, officialSiteClaim: true, exactNameMatch: true, crossLinkedProfile: true } }],
      claims: [], requiredAssets: [],
    });
    const snapshot = { ...baseSnapshot, strategy: {
      kind: "research_strategy" as const,
      brandProfile: { facts: [], tone: [], palette: [], typography: [], composition: [], allowedMaterials: [], prohibitions: [] },
      plan: { platform: "linkedin" as const, format: "single" as const, slideCount: 1, purpose: "Introduce Girex", audience: "Founders", angle: "Clear coordination", slides: [{ index: 1, objective: "Introduce", copy: "Meet Girex", visualDirection: "Confident editorial card", claimKeys: [], materialIds: [] }], caption: "Meet Girex.", cta: "Learn more", visualSystem: "Editorial" },
    }, critic: { outcome: "pass", issues: [] } };
    const accepted = await store.acceptSnapshot(ownerId, run.id, snapshot);
    await store.appendStatus(ownerId, run.id, "review_ready");
    const frozen = await freezeCreationResearch(pool, ownerId, { researchId: run.id, researchSnapshotHash: accepted.hash, brandProfileVersion: 3 });
    assert.equal(frozen.snapshotId, accepted.id);
    assert.deepEqual(frozen.sourceHashes, [{ evidenceId: evidence.id, contentHash: evidence.contentHash }]);
    await verifyCreationResearch(pool, ownerId, frozen, 3);
    await assert.rejects(freezeCreationResearch(pool, foreignId, { researchId: run.id, researchSnapshotHash: accepted.hash, brandProfileVersion: 3 }), { code: "research_not_found" });
    await assert.rejects(verifyCreationResearch(pool, ownerId, { ...frozen, sourceHashes: [] }, 3), { code: "research_snapshot_changed" });
    await assert.rejects(verifyCreationResearch(pool, ownerId, frozen, 4), { code: "research_brand_mismatch" });
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
