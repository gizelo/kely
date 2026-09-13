import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import sharp from "sharp";
import type { ArtDirection } from "../src/shared/art-direction";
import type { BrandMaterial } from "../src/shared/brand";
import { freezeArtDirection, validateArtDirection } from "../src/server/art-direction";
import { composeArtSlide, measureArtSlide } from "../src/server/art-renderer";
import { LayoutOverflow } from "../src/server/layout";

const base: ArtDirection = {
  policy: "art-direction-v1", palette: { background: "#F8F7F3", foreground: "#17181C", accent: "#254BFF", muted: "#E3E1DA" },
  headingFont: "sans", composition: "editorial", spacing: "open", logoMaterialId: null, heroMaterialIds: [],
};

test("actual originals retain pixels and ratio in nonoverlapping branded typography", async () => {
  const id = randomUUID();
  const bytes = await sharp({ create: { width: 200, height: 80, channels: 4, background: "#EF5712" } }).png().toBuffer();
  const hash = createHash("sha256").update(bytes).digest("hex");
  const material: BrandMaterial = { id, version: 1, role: "original", kind: "image", label: "Actual original", contentHash: hash, width: 200, height: 80, bytes: bytes.length, sourceUrl: null, createdAt: new Date().toISOString() };
  const art = freezeArtDirection({ ...base, logoMaterialId: id }, [material], false);
  const input = { art, title: "Ёж, Grüße & ideas", body: "Approved copy remains complete. Every word is measured before export.", index: 0, slideCount: 3 };
  const output = await composeArtSlide(input, [{ id, version: 1, hash, bytes }]);
  assert.deepEqual(output.placements[0].bounds, { x: 122, y: 60, width: 200, height: 80 });
  const placed = await sharp(output.png).extract({ left: 122, top: 60, width: 200, height: 80 }).raw().toBuffer();
  assert.deepEqual(placed, await sharp(bytes).raw().toBuffer());
  assert.deepEqual(output.text.slice(0, 2).map((item) => item.approvedText), [input.title, input.body]);
  assert.equal(output.text[0].font.family, "Inter");
  const serif = await composeArtSlide({ ...input, art: { ...art, direction: { ...art.direction, headingFont: "serif" } } }, [{ id, version: 1, hash, bytes }]);
  assert.equal(serif.text[0].font.family, "Source Serif 4");
  assert.notDeepEqual(serif.png, output.png);
  assert.notDeepEqual(serif.text[0].bounds, output.text[0].bounds);
  assert.deepEqual(await sharp(serif.png).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer(), Buffer.from([248, 247, 243, 255]));
  const unbounded = await measureArtSlide({ ...input, art: { ...art, direction: { ...art.direction, headingFont: "unbounded" } } });
  assert.equal(unbounded.layers[0].font.family, "Unbounded");
  assert.notDeepEqual(unbounded.layers[0].bounds, output.text[0].bounds);
  await assert.rejects(composeArtSlide(input, [{ id, version: 1, hash, bytes: Buffer.from("changed") }]), (error: unknown) => (error as { code: string }).code === "original_unavailable");
  assert.throws(() => freezeArtDirection({ ...base, logoMaterialId: id }, [{ ...material, role: "reference" }], false), (error: unknown) => (error as { code: string }).code === "original_unavailable");
});

test("unsupported layouts, missing required images and overflowing approved copy fail explicitly", async () => {
  assert.throws(() => validateArtDirection({ ...base, composition: "image-led" }), (error: unknown) => (error as { code: string }).code === "original_required");
  assert.throws(() => validateArtDirection({ ...base, headingFont: "https://foreign/font.ttf" }), (error: unknown) => (error as { code: string }).code === "invalid_art_direction");
  assert.throws(() => validateArtDirection({ ...base, palette: { ...base.palette, foreground: base.palette.background } }), (error: unknown) => (error as { code: string }).code === "palette_contrast");
  await assert.rejects(measureArtSlide({ art: { direction: base, originals: [] }, title: "Complete approved title", body: "This copy must never be silently clipped. ".repeat(150), index: 0, slideCount: 3 }), LayoutOverflow);
});
