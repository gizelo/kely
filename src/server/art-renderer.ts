import { createHash } from "node:crypto";
import sharp from "sharp";
import type { FrozenArtDirection } from "../shared/art-direction";
import { validateArtDirection } from "./art-direction";
import { requireCondition } from "./errors";
import { LayoutOverflow, layoutApprovedText, type MeasuredTextLayout, type TextRectangle } from "./layout";

const canvas = { width: 1080, height: 1350 };
export interface ArtSlideInput {
  art: FrozenArtDirection;
  title: string;
  body: string;
  index: number;
  slideCount: number;
}
export interface ResolvedOriginal { id: string; version: number; hash: string; bytes: Buffer }
interface ImageZone { id: string; bounds: TextRectangle; role: "logo" | "hero" }

function imageZones(input: ArtSlideInput): ImageZone[] {
  const { direction } = input.art;
  const zones: ImageZone[] = [];
  if (direction.logoMaterialId) zones.push({ id: direction.logoMaterialId, role: "logo", bounds: { x: 72, y: 54, width: 300, height: 92 } });
  const heroes = direction.heroMaterialIds;
  if (direction.composition === "split") heroes.forEach((id, index) => zones.push({ id, role: "hero", bounds: { x: 590, y: 250 + index * 480, width: 418, height: heroes.length === 1 ? 830 : 430 } }));
  else if (heroes.length) heroes.forEach((id, index) => zones.push({ id, role: "hero", bounds: { x: 72 + index * 480, y: 190, width: heroes.length === 1 ? 936 : 456, height: direction.composition === "image-led" ? 510 : 310 } }));
  return zones;
}

async function fitText(text: string, area: TextRectangle, sizes: number[], font: "sans" | "serif" | "unbounded", color: string, bold: boolean) {
  let overflow: LayoutOverflow | undefined;
  for (const fontSizePx of sizes) {
    try { return await layoutApprovedText({ text, safeArea: area, canvas, fontSizePx, font, color, weight: bold ? "bold" : "regular" }); }
    catch (error) { if (!(error instanceof LayoutOverflow)) throw error; overflow = error; }
  }
  throw overflow!;
}

export async function measureArtSlide(input: ArtSlideInput) {
  const direction = validateArtDirection(input.art.direction);
  requireCondition(Number.isInteger(input.index) && input.index >= 0 && input.index < input.slideCount && input.slideCount <= 6,
    "invalid_art_direction", "Slide position must be within the approved publication.");
  const zones = imageZones(input);
  const split = direction.composition === "split";
  const textTop = split || !direction.heroMaterialIds.length ? 230 : direction.composition === "image-led" ? 754 : 556;
  const width = split ? 458 : 936;
  const titleHeight = split ? 400 : direction.composition === "image-led" ? 212 : 310;
  const titleArea = { x: 72, y: textTop, width, height: titleHeight };
  const title = await fitText(input.title, titleArea, direction.spacing === "open" ? [84, 72, 64, 54, 44] : [72, 64, 54, 44], direction.headingFont, direction.palette.foreground, true);
  const bodyTop = title.bounds.y + title.bounds.height + (direction.spacing === "open" ? 46 : 30);
  const bodyArea = { x: 72, y: bodyTop, width, height: 1200 - bodyTop };
  const body = await fitText(input.body, bodyArea, [36, 32, 28, 24], "sans", direction.palette.foreground, false);
  const page = await layoutApprovedText({ text: `${input.index + 1} / ${input.slideCount}`, canvas, safeArea: { x: 894, y: 1250, width: 114, height: 38 }, fontSizePx: 20, font: "sans", color: direction.palette.foreground });
  const layers = [title, body, page];
  for (const zone of zones) requireCondition(!layers.some((layer) => overlaps(zone.bounds, layer.bounds)), "layout_overlap", "Approved text and original imagery require separate layout space.", 422);
  return { canvas, direction, zones, layers };
}

function overlaps(a: TextRectangle, b: TextRectangle) { return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y; }

export async function verifyResolvedOriginals(art: FrozenArtDirection, originals: ResolvedOriginal[]) {
  requireCondition(originals.length === art.originals.length && new Set(originals.map((item) => item.id)).size === originals.length,
    "original_unavailable", "Provide exactly the immutable originals selected for this direction.", 409);
  const resolved = new Map(originals.map((item) => [item.id, item]));
  for (const expected of art.originals) {
    const actual = resolved.get(expected.id);
    requireCondition(actual && actual.version === expected.version && actual.hash === expected.hash && createHash("sha256").update(actual.bytes).digest("hex") === expected.hash,
      "original_unavailable", "An original image no longer matches the approved snapshot.", 409);
    const metadata = await sharp(actual.bytes, { limitInputPixels: 16_000_000, failOn: "warning" }).metadata();
    requireCondition(metadata.format === "png" && metadata.width === expected.width && metadata.height === expected.height && (metadata.pages ?? 1) === 1,
      "original_unavailable", "An original image does not match its normalized dimensions.", 409);
  }
  return resolved;
}

export async function composeArtSlide(input: ArtSlideInput, originals: ResolvedOriginal[]) {
  const layout = await measureArtSlide(input);
  const resolved = await verifyResolvedOriginals(input.art, originals);
  const composites: { input: Buffer; left: number; top: number }[] = [
    { input: await sharp({ create: { width: 88, height: 5, channels: 4, background: layout.direction.palette.accent } }).png().toBuffer(), left: 72, top: 171 },
    { input: await sharp({ create: { width: 936, height: 2, channels: 4, background: layout.direction.palette.muted } }).png().toBuffer(), left: 72, top: 1226 },
  ];
  const placements: { id: string; role: string; bounds: TextRectangle; hash: string }[] = [];
  for (const zone of layout.zones) {
    const original = resolved.get(zone.id);
    requireCondition(original, "original_unavailable", "A required original is unavailable.", 409);
    const { data, info } = await sharp(original.bytes).resize({ width: zone.bounds.width, height: zone.bounds.height, fit: "inside", withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
    const left = zone.bounds.x + Math.floor((zone.bounds.width - info.width) / 2);
    const top = zone.bounds.y + Math.floor((zone.bounds.height - info.height) / 2);
    composites.push({ input: data, left, top });
    placements.push({ id: zone.id, role: zone.role, bounds: { x: left, y: top, width: info.width, height: info.height }, hash: original.hash });
  }
  composites.push(...layout.layers.map((layer: MeasuredTextLayout) => ({ input: layer.png, left: layer.bounds.x, top: layer.bounds.y })));
  const png = await sharp({ create: { ...canvas, channels: 4, background: layout.direction.palette.background } }).composite(composites).png().toBuffer();
  return { png, placements, text: layout.layers.map(({ approvedText, bounds, font }) => ({ approvedText, bounds, font })) };
}
