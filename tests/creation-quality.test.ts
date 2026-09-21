import assert from "node:assert/strict";
import { test } from "node:test";
import { applySelectedOriginals, shouldGenerateEditorialArtwork, type CreationInput } from "../src/server/creation-input";
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
  assert.equal(shouldGenerateEditorialArtwork({ ...base, analysis: { selected: [{ id: ids.reference }] } as CreationInput["analysis"] }, state), false);
  state.artDirection!.direction.heroMaterialIds = [ids.screenshot];
  assert.equal(shouldGenerateEditorialArtwork(base, state), false);
});
