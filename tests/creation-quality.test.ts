import assert from "node:assert/strict";
import { test } from "node:test";
import { applySelectedOriginals, freezeCreationResearch, researchedPublicationPlan, shouldGenerateEditorialArtwork, suggestedSlideCount, verifyCreationInput, verifyCreationResearch, type CreationInput } from "../src/server/creation-input";
import { inputHash } from "../src/server/paid-input";
import type { FrozenBrand } from "../src/shared/brand";
import type { PublicationView } from "../src/shared/contracts";

const ids = {
  reference: "00000000-0000-4000-a000-000000000001",
  logo: "00000000-0000-4000-a000-000000000002",
  screenshot: "00000000-0000-4000-a000-000000000003",
};

function brand(): FrozenBrand {
  const value = {
    version: 1,
    rules: { audience: "", palette: null, headlines: "default" as const },
    materials: [
      { id: ids.reference, role: "reference" as const, kind: "image" as const, label: "Past post", sourceUrl: null, version: 1, contentHash: "a".repeat(64), width: 1080, height: 1350, bytes: 10, createdAt: "2026-09-21T00:00:00Z" },
      { id: ids.logo, role: "original" as const, kind: "image" as const, label: "Girex logo.png", sourceUrl: null, version: 1, contentHash: "b".repeat(64), width: 800, height: 240, bytes: 10, createdAt: "2026-09-21T00:00:00Z" },
      { id: ids.screenshot, role: "original" as const, kind: "image" as const, label: "Product screenshot", sourceUrl: null, version: 1, contentHash: "c".repeat(64), width: 1440, height: 900, bytes: 10, createdAt: "2026-09-21T00:00:00Z" },
    ],
    brief: { audience: "", direction: "decide" as const, requiredMaterialIds: [], noPhoto: false, blockingFacts: [], factResolution: "" },
    rendererPolicy: "art-direction-v1" as const,
    art: { direction: { policy: "art-direction-v1" as const, palette: { background: "#FFFFFF", foreground: "#111111", accent: "#6D45FF", muted: "#D9D4FF" }, headingFont: "sans" as const, composition: "editorial" as const, spacing: "open" as const, logoMaterialId: null, heroMaterialIds: [] }, originals: [] },
  };
  return { ...value, hash: inputHash(value) };
}

function researchStrategy() {
  return {
    kind: "research_strategy" as const,
    brandProfile: { facts: [], tone: [], palette: [], typography: [], composition: [], allowedMaterials: [], prohibitions: [] },
    plan: {
      platform: "linkedin" as const, format: "carousel" as const, slideCount: 2, purpose: "Explain the product", audience: "Founders", angle: "Save time",
      slides: [
        { index: 1, objective: "Hook", copy: "Stop scheduling manually", visualDirection: "Bold editorial opener", claimKeys: [], materialIds: [] },
        { index: 2, objective: "Close", copy: "Coordinate in one place", visualDirection: "Simple closing card", claimKeys: [], materialIds: [] },
      ],
      caption: "A clearer way to coordinate.", cta: "Learn more", visualSystem: "High-contrast editorial cards",
    },
  };
}

function variedResearchStrategy() {
  const value = researchStrategy();
  value.plan.slideCount = 4;
  value.plan.slides = [
    value.plan.slides[0],
    { index: 2, objective: "Show how it works", copy: "Three steps to coordinate", visualDirection: "A structured process sequence", claimKeys: [], materialIds: [] },
    { index: 3, objective: "Establish trust", copy: "Verified activity in one view", visualDirection: "An evidence-led signal grid", claimKeys: [], materialIds: [] },
    { ...value.plan.slides[1], index: 4 },
  ];
  return value;
}

test("selected originals enter the post-local art direction while references remain analysis-only", () => {
  const baseline = brand();
  const selected = applySelectedOriginals(baseline, [ids.reference, ids.logo, ids.screenshot]);
  assert.equal(selected.art?.direction.logoMaterialId, ids.logo);
  assert.deepEqual(selected.art?.direction.heroMaterialIds, [ids.screenshot]);
  assert.deepEqual(selected.art?.originals.map(item => item.id), [ids.screenshot, ids.logo]);
  assert.deepEqual(baseline.art?.originals, []);
  assert.notEqual(selected.hash, baseline.hash);
});

test("style references suppress generic image generation but a material-free fresh direction may use it", () => {
  const state = { artDirection: brand().art, brandBrief: brand().brief } as PublicationView;
  const base = { revision: undefined, analysis: null } as Pick<CreationInput, "revision" | "analysis">;
  assert.equal(shouldGenerateEditorialArtwork(base, state), true);
  assert.equal(shouldGenerateEditorialArtwork({ ...base, schemaVersion: 16 }, state), false);
  assert.equal(shouldGenerateEditorialArtwork({ ...base, analysis: { selected: [{ id: ids.reference }] } as CreationInput["analysis"] }, state), false);
  state.artDirection!.direction.heroMaterialIds = [ids.screenshot];
  assert.equal(shouldGenerateEditorialArtwork(base, state), false);
});

test("the initial plan respects an explicit carousel size in the idea", () => {
  assert.equal(suggestedSlideCount("Create a 3-slide LinkedIn carousel."), 3);
  assert.equal(suggestedSlideCount("Сделай четыре слайда о продукте."), 4);
  assert.equal(suggestedSlideCount("Introduce our product in one post."), 1);
});

test("research-aware creation freezes the exact ready snapshot while legacy v15 remains valid", async () => {
  const researchHash = "d".repeat(64);
  const sourceHash = "e".repeat(64);
  const client = {
    async query(_sql: string, parameters: unknown[]) {
      if (parameters[0] !== "owner-1" || parameters[1] !== "00000000-0000-4000-a000-000000000010") return { rows: [] };
      return { rows: [{
        run_id: parameters[1], snapshot_id: "00000000-0000-4000-a000-000000000011", snapshot_version: 2,
        snapshot_hash: researchHash, status: "review_ready",
        snapshot: { entityResolution: { status: "resolved", confidence: "high", candidateId: "girex" }, evidence: [{ id: "source-1", contentHash: sourceHash }], strategy: researchStrategy(), critic: { outcome: "pass", issues: [] } },
      }] };
    },
  };
  const research = await freezeCreationResearch(client as never, "owner-1", { researchId: "00000000-0000-4000-a000-000000000010", researchSnapshotHash: researchHash, brandProfileVersion: 1 });
  assert.deepEqual(research.sourceHashes, [{ evidenceId: "source-1", contentHash: sourceHash }]);
  await assert.rejects(verifyCreationResearch(client as never, "owner-1", { ...research, planHash: "0".repeat(64) }, 1), { code: "research_snapshot_changed" });
  const mapped = researchedPublicationPlan(research, brand(), "ai_preview", (index) => `slide-${index}`);
  assert.deepEqual(mapped.slides.map((slide) => slide.title), ["Stop scheduling manually", "Coordinate in one place"]);
  assert.equal(mapped.caption, "A clearer way to coordinate.");
  const common = { ownerId: "owner-1", quoteId: "quote-1", origin: "ai_preview" as const, publication: {} as PublicationView, brand: brand(), business: {} as CreationInput["business"], analysis: null, credits: 30, format: {} as CreationInput["format"] };
  const legacy = { ...common, schemaVersion: 15, policy: "plan-first-v1" } as const;
  assert.equal(verifyCreationInput(legacy, inputHash(legacy)).schemaVersion, 15);
  const current = { ...common, schemaVersion: 16, policy: "plan-first-v1", research } as const;
  assert.equal(verifyCreationInput(current, inputHash(current)).research?.snapshotHash, researchHash);
  assert.throws(() => verifyCreationInput({ ...legacy, schemaVersion: 16 }, inputHash({ ...legacy, schemaVersion: 16 }) as string), { code: "creation_snapshot_invalid" });
  assert.throws(() => verifyCreationInput({ ...current, schemaVersion: 15 }, inputHash({ ...current, schemaVersion: 15 }) as string), { code: "creation_snapshot_invalid" });
});

test("researched objectives preserve distinct process and proof compositions", () => {
  const strategy = variedResearchStrategy();
  const research = { strategy } as unknown as Parameters<typeof researchedPublicationPlan>[0];
  const mapped = researchedPublicationPlan(research, brand(), "ai_preview", (index) => `slide-${index}`);
  assert.deepEqual(mapped.slides.map((slide) => slide.creativePlan?.purpose), ["hook", "process", "proof", "closing"]);
  assert.deepEqual(mapped.slides.map((slide) => slide.creativePlan?.scene?.composition), ["editorial-offset", "structured-stack", "signal-grid", "action-frame"]);
  assert.ok(mapped.slides.every((slide) => (slide.creativePlan?.scene?.primitives.length ?? 0) >= 2));
  const repeated = researchedPublicationPlan(research, brand(), "ai_preview", (index) => `slide-${index}`);
  assert.deepEqual(repeated.slides.map((slide) => slide.creativePlan?.scene), mapped.slides.map((slide) => slide.creativePlan?.scene));
});

test("detailed researched directions retain the full plan while fitting renderer rationale", () => {
  const strategy = researchStrategy();
  strategy.plan.slides[0].visualDirection = `${"Detailed map composition with offer cards. ".repeat(20)}Final placement.`;
  const research = { strategy, planHash: "f".repeat(64) } as unknown as Parameters<typeof researchedPublicationPlan>[0];
  const mapped = researchedPublicationPlan(research, brand(), "ai_preview", (index) => `slide-${index}`);
  assert.ok((mapped.slides[0].creativePlan?.rationale.length ?? 301) <= 300);
  assert.match(mapped.visualDirection, /Final placement\./u);
});

test("research freeze fails closed for another owner, stale hash, non-final state or medium-confidence identity", async () => {
  const hash = "f".repeat(64);
  const row = { run_id: "run", snapshot_id: "snapshot", snapshot_version: 1, snapshot_hash: hash, status: "review_ready", snapshot: { entityResolution: { status: "resolved", confidence: "high", candidateId: "entity" }, evidence: [], strategy: researchStrategy(), critic: { outcome: "pass", issues: [] } } };
  const selection = { researchId: "00000000-0000-4000-a000-000000000020", researchSnapshotHash: hash, brandProfileVersion: 0 };
  const client = (value: unknown) => ({ async query() { return { rows: value ? [value] : [] }; } });
  await assert.rejects(freezeCreationResearch(client(null) as never, "foreign", selection), { code: "research_not_found" });
  await assert.rejects(freezeCreationResearch(client({ ...row, snapshot_hash: "a".repeat(64) }) as never, "owner", selection), { code: "research_snapshot_changed" });
  await assert.rejects(freezeCreationResearch(client({ ...row, status: "partial" }) as never, "owner", selection), { code: "research_not_ready" });
  await assert.rejects(freezeCreationResearch(client({ ...row, snapshot: { ...row.snapshot, entityResolution: { ...row.snapshot.entityResolution, confidence: "medium" } } }) as never, "owner", selection), { code: "research_identity_unconfirmed" });
  await assert.rejects(freezeCreationResearch(client({ ...row, snapshot: { ...row.snapshot, strategy: undefined } }) as never, "owner", selection), { code: "research_plan_invalid" });
});
