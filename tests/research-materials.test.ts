import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import sharp from "sharp";
import { createResearchDerivative, RESEARCH_DERIVATIVE_MAX_BYTES, RESEARCH_DERIVATIVE_MAX_EDGE } from "../src/server/research-materials";

test("research derivatives keep a bounded edge and payload for noisy source images", async () => {
  const source = await sharp(randomBytes(1800 * 1200 * 3), { raw: { width: 1800, height: 1200, channels: 3 } }).png().toBuffer();
  const derivative = await createResearchDerivative(source);

  assert.equal(Math.max(derivative.width, derivative.height), RESEARCH_DERIVATIVE_MAX_EDGE);
  assert.ok(derivative.data.length <= RESEARCH_DERIVATIVE_MAX_BYTES);
  assert.equal((await sharp(derivative.data).metadata()).format, "jpeg");
});

test("research derivatives do not enlarge small sources and flatten transparency", async () => {
  const source = await sharp({ create: { width: 120, height: 80, channels: 4, background: { r: 12, g: 34, b: 56, alpha: 0 } } }).png().toBuffer();
  const derivative = await createResearchDerivative(source);
  const pixel = await sharp(derivative.data).raw().toBuffer();

  assert.deepEqual([derivative.width, derivative.height], [120, 80]);
  assert.ok(pixel[0] >= 248 && pixel[1] >= 248 && pixel[2] >= 248);
});
