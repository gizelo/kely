import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import sharp from "sharp";
import { normalizeMaterial, readUpload, MAX_UPLOAD_BYTES } from "../src/server/brand-materials";
import { brandReadiness, defaultBrandRules, interpretMemory, sourceCompleteness } from "../src/server/brand-policy";
import { composeSlideImage, measureComposedSlide } from "../src/server/renderer";
import { snapshotPaidInput, inputHash, verifyPaidInput } from "../src/server/paid-input";
import type { BrandSource, FrozenBrand } from "../src/shared/brand";
import type { PublicationView } from "../src/shared/contracts";

function publication(): PublicationView {
  return { fixture: true, id: randomUUID(), idea: "Meet our team", title: "Team", platform: "linkedin", language: "en", slideCount: 1, status: "content_approval", version: 1, outlineApproved: false, coverApproved: false, caption: "Meet the team.", slides: [{ id: randomUUID(), index: 0, title: "Meet our team", body: "People behind the work." }], messages: [], history: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}

test("raster ingestion normalizes actual image bytes and rejects disguised, animated, excessive and streamed oversized input", async () => {
  const jpeg = await sharp({ create: { width: 30, height: 20, channels: 3, background: "#ff3300" } }).jpeg().toBuffer();
  const normalized = await normalizeMaterial(jpeg);
  const meta = await sharp(normalized.data).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height, meta.exif], ["png", 30, 20, undefined]);
  assert.match(normalized.hash, /^[a-f0-9]{64}$/u);
  await assert.rejects(normalizeMaterial(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), { code: "unsupported_image" });
  await assert.rejects(normalizeMaterial(Buffer.from([137,80,78,71,13,10,26,10])), { code: "invalid_image" });
  const animated = Buffer.concat([normalized.data.subarray(0,8), Buffer.from([0,0,0,0]), Buffer.from("acTL"), Buffer.alloc(4), normalized.data.subarray(8)]);
  await assert.rejects(normalizeMaterial(animated), { code: "invalid_image" });
  const wide = await sharp({ create: { width: 8193, height: 1, channels: 3, background: "white" } }).png().toBuffer();
  await assert.rejects(normalizeMaterial(wide), { code: "invalid_image" });
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_UPLOAD_BYTES)); controller.enqueue(new Uint8Array(1)); }, cancel() { cancelled = true; } });
  await assert.rejects(readUpload(new Request("http://localhost/upload", { method: "POST", body: stream, duplex: "half" } as RequestInit)), { code: "upload_too_large" });
  assert.equal(cancelled, true);
});

test("memory separates explicit durable and local intent; readiness distinguishes informational provenance from missing requirements", () => {
  assert.equal(interpretMemory("Always use shorter headlines for our brand").status, "durable");
  assert.equal(interpretMemory("For this post only, do not use a photo").status, "local");
  assert.equal(interpretMemory("Use forest, maybe always unless this one").status, "clarification");
  const state = publication();
  state.uncertainFacts = ["Context is user supplied, not independently verified"];
  const brand: FrozenBrand = { version: 0, rules: defaultBrandRules, materials: [], hash: "", rendererPolicy: "brand-palette-v1", brief: { audience: "Neighbourhood customers", direction: "decide", noPhoto: false, requiredMaterialIds: [], blockingFacts: [], factResolution: "" } };
  assert.equal(brandReadiness(state, brand).ready, true);
  brand.brief.blockingFacts = ["Discount amount missing"];
  assert.equal(brandReadiness(state, brand).blockers[0].code, "facts_missing");
  brand.brief.blockingFacts = [];
  brand.brief.requiredMaterialIds = ["logo"];
  brand.materials = [{ id: "logo", kind: "image", role: "original", label: "Actual logo", sourceUrl: null, version: 1, bytes: 1, width: 1, height: 1, contentHash: "hash", createdAt: "now" }];
  assert.equal(brandReadiness(state, brand).blockers[0].code, "material_composition_unavailable");
});

test("source completeness blocks only explicit material needs and resolves partial social guidance with an uploaded fallback", () => {
  const social: BrandSource = { id: "social", kind: "social", role: "reference", label: "Instagram", state: "needs_upload", outcomeCode: "social_preview_missing", submittedUrl: "https://www.instagram.com/example", canonicalUrl: "https://www.instagram.com/example", acquiredAt: null, createdAt: "now", fallbackFor: null, materials: [] };
  let result = sourceCompleteness([social], "decide_for_me");
  assert.equal(result.status, "ready_with_recommendations");
  assert.deepEqual(result.blockers, []);
  assert.equal(result.recommendations[0].code, "social_screenshots_recommended");
  const material = { id: "image", kind: "image" as const, role: "reference" as const, label: "Saved post", sourceUrl: null, version: 1, bytes: 1, width: 1, height: 1, contentHash: "hash", createdAt: "now", sourceId: "fallback" };
  const fallback: BrandSource = { id: "fallback", kind: "upload", role: "reference", label: "Saved post", state: "available", outcomeCode: "upload_normalized", submittedUrl: null, canonicalUrl: null, acquiredAt: "now", createdAt: "now", fallbackFor: "social", materials: [material] };
  result = sourceCompleteness([social, fallback], "use_materials");
  assert.equal(result.status, "ready");
  assert.deepEqual(result.selectableAnalysisMaterialIds, ["image"]);
  assert.equal(sourceCompleteness([], "use_materials").blockers[0].code, "material_source_missing");
  assert.equal(sourceCompleteness([fallback], "decide_for_me", { exactOriginalRequired: true }).blockers[0].code, "required_original_missing");
});

test("new brand palette changes rendered pixels without changing approved copy; schema1 remains independently verifiable", async () => {
  const state = publication();
  const original = snapshotPaidInput("owner", "quote", "prepare", "", state);
  const hash = inputHash(original);
  state.brandPalette = "rose";
  const rose = await composeSlideImage(state, state.slides[0]);
  const measured = await measureComposedSlide(state, state.slides[0]);
  assert.equal(measured.layers[1].approvedText, state.slides[0].title);
  assert.equal(measured.layers[2].approvedText, state.slides[0].body);
  state.brandPalette = "forest";
  const forest = await composeSlideImage(state, state.slides[0]);
  assert.notDeepEqual(rose, forest);
  const pixel = await sharp(rose).extract({ left: 0, top: 0, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
  assert.deepEqual([...pixel], [251,237,234]);
  assert.equal(verifyPaidInput(original, hash).schemaVersion, 1);
  assert.equal(original.publication.brandPalette, undefined);
});
