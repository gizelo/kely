import sharp from "sharp";
import type { CreativePlan } from "../shared/creative-intent";
import { imageEvidenceIsReadable, validateCreativePlan } from "./creative-intent";
import { validateArtDirection } from "./art-direction";
import { verifyResolvedOriginals, type ArtSlideInput, type ResolvedOriginal } from "./art-renderer";
import { LayoutOverflow, layoutApprovedText, type TextRectangle } from "./layout";
import { requireCondition } from "./errors";
import { validateDesignScene } from "./design-scene";
import type { DesignPrimitive, NormalizedZone } from "../shared/design-scene";

export type CreativeSlideInput = ArtSlideInput & { plan: CreativePlan; artworkLayout?: "landscape-editorial-v1" };
const canvas = { width: 1080, height: 1350 };
type Zone = { id: string; role: "logo" | "graphic" | "evidence"; bounds: TextRectangle };

function geometry(input: CreativeSlideInput, artwork = false) {
  const plan = validateCreativePlan(input.plan, input.art);
  if (artwork) {
    requireCondition(!plan.materialId, "artwork_scope_conflict", "Generated artwork cannot replace a selected original.", 409);
    const zones: Zone[] = input.art.direction.logoMaterialId ? [{ id: input.art.direction.logoMaterialId, role: "logo", bounds: { x: 72, y: 1230, width: 240, height: 66 } }] : [];
    return { plan, zones, title: { x: 72, y: 72, width: 936, height: 260 }, bodyArea: { x: 72, y: 1080, width: 936, height: 132 }, scene: undefined };
  }
  if (plan.scene) {
    const scene = validateDesignScene(plan.scene, plan, input.art);
    const px = (zone: NormalizedZone): TextRectangle => ({ x: Math.round(zone.x * canvas.width / 1000), y: Math.round(zone.y * canvas.height / 1000), width: Math.round(zone.width * canvas.width / 1000), height: Math.round(zone.height * canvas.height / 1000) });
    const zones: Zone[] = scene.materialZone ? [{ id: scene.materialZone.id, role: scene.materialZone.role, bounds: px(scene.materialZone) }] : [];
    if (input.art.direction.logoMaterialId) zones.push({ id: input.art.direction.logoMaterialId, role: "logo", bounds: { x: 72, y: 1220, width: 240, height: 76 } });
    return { plan, scene, zones, title: px(scene.titleZone), bodyArea: px(scene.bodyZone) };
  }
  const zones: Zone[] = [];
  const logo = input.art.direction.logoMaterialId;
  if (logo) zones.push({ id: logo, role: "logo", bounds: plan.recipe === "closing" ? { x: 390, y: 1160, width: 300, height: 100 } : { x: 72, y: 54, width: 300, height: 92 } });
  let title: TextRectangle;
  let bodyBottom = plan.recipe === "closing" ? 1080 : 1240;
  switch (plan.recipe) {
    case "graphic-stage":
      zones.push({ id: plan.materialId, role: "graphic", bounds: { x: 388, y: 176, width: 620, height: 512 } });
      title = { x: 72, y: 730, width: 936, height: 260 };
      break;
    case "split-proof":
      zones.push({ id: plan.materialId, role: "evidence", bounds: { x: 568, y: 234, width: 440, height: 970 } });
      title = { x: 72, y: 250, width: 430, height: 420 };
      break;
    case "image-evidence":
      zones.push({ id: plan.materialId, role: "evidence", bounds: { x: 72, y: 680, width: 936, height: 560 } });
      title = { x: 72, y: 210, width: 936, height: 215 };
      bodyBottom = 620;
      break;
    case "closing":
      title = { x: 90, y: 340, width: 900, height: 390 };
      break;
    default:
      title = { x: 72, y: 245, width: 936, height: 540 };
  }
  return { plan, zones, title, bodyBottom, scene: undefined, bodyArea: undefined };
}

async function fit(text: string, area: TextRectangle, sizes: number[], font: "sans" | "serif" | "unbounded", color: string, alignment: CreativePlan["alignment"], bold: boolean) {
  let overflow: LayoutOverflow | undefined;
  for (const fontSizePx of sizes) {
    try { return await layoutApprovedText({ text, canvas, safeArea: area, fontSizePx, font, color, alignment, weight: bold ? "bold" : "regular" }); }
    catch (error) { if (!(error instanceof LayoutOverflow)) throw error; overflow = error; }
  }
  throw overflow!;
}

export async function measureCreativeSlide(input: CreativeSlideInput, artwork = false) {
  const direction = validateArtDirection(input.art.direction);
  const { plan, scene, zones, title: titleArea, bodyBottom, bodyArea } = geometry(input, artwork);
  const inverse = plan.background === "foreground";
  const background = direction.palette[inverse ? "foreground" : "background"];
  const foreground = direction.palette[inverse ? "background" : "foreground"];
  const large = plan.heading === "large" && !["split-proof", "image-evidence"].includes(plan.recipe);
  const title = await fit(input.title, titleArea, large ? [116, 100, 88, 76, 64, 54] : [76, 66, 58, 50, 44], direction.headingFont, foreground, plan.alignment, true);
  const bodyTop = bodyArea?.y ?? title.bounds.y + title.bounds.height + (direction.spacing === "open" ? 48 : 32);
  const layers = [title];
  if (input.body.trim()) layers.push(await fit(input.body, bodyArea ?? { x: titleArea.x, y: bodyTop, width: titleArea.width, height: bodyBottom! - bodyTop }, [38, 34, 30, 26], "sans", foreground, plan.alignment, false));
  for (const zone of zones) for (const layer of layers) requireCondition(!(zone.bounds.x < layer.bounds.x + layer.bounds.width && zone.bounds.x + zone.bounds.width > layer.bounds.x && zone.bounds.y < layer.bounds.y + layer.bounds.height && zone.bounds.y + zone.bounds.height > layer.bounds.y), "layout_overlap", "The planned original and approved copy need separate space.", 422);
  return { canvas, direction, background, foreground, zones, layers, plan, scene, artworkArea: artwork ? { x: 72, y: 374, width: 936, height: input.artworkLayout === "landscape-editorial-v1" ? 624 : 654 } : undefined };
}

function primitiveSvg(layer: DesignPrimitive, direction: ReturnType<typeof validateArtDirection>) {
  const zone = layer.zone;
  const x = Math.round(zone.x * canvas.width / 1000), y = Math.round(zone.y * canvas.height / 1000);
  const width = Math.round(zone.width * canvas.width / 1000), height = Math.round(zone.height * canvas.height / 1000);
  const fill = direction.palette[layer.color];
  const common = `fill="${fill}" fill-opacity="${layer.opacity}"`;
  let shape: string;
  if (layer.kind === "ellipse") shape = `<ellipse cx="${x + width / 2}" cy="${y + height / 2}" rx="${width / 2}" ry="${height / 2}" ${common}/>`;
  else if (layer.kind === "rule") shape = `<rect x="${x}" y="${y}" width="${width}" height="${height}" ${common}/>`;
  else shape = `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${layer.radius}" ${common} transform="rotate(${layer.rotation} ${x + width / 2} ${y + height / 2})"/>`;
  return Buffer.from(`<svg width="1080" height="1350" xmlns="http://www.w3.org/2000/svg">${shape}</svg>`);
}

export async function composeCreativeSlide(input: CreativeSlideInput, originals: ResolvedOriginal[], artwork?: Buffer) {
  const layout = await measureCreativeSlide(input, Boolean(artwork));
  const resolved = await verifyResolvedOriginals(input.art, originals);
  const composites: { input: Buffer; left: number; top: number }[] = [];
  const placements: { id: string; role: string; bounds: TextRectangle; hash: string }[] = [];
  if (layout.scene) composites.push(...layout.scene.primitives.map((layer) => ({ input: primitiveSvg(layer, layout.direction), left: 0, top: 0 })));
  if (artwork) {
    requireCondition(!layout.plan.materialId, "artwork_scope_conflict", "Generated artwork cannot replace a selected original.", 409);
    const area = layout.artworkArea!;
    const { data, info } = await sharp(artwork, { limitInputPixels: 1024 * 1536, failOn: "warning" }).resize({ width: area.width, height: area.height, fit: "inside", withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
    composites.push({ input: data, left: area.x + Math.floor((area.width - info.width) / 2), top: area.y + Math.floor((area.height - info.height) / 2) });
  }
  for (const zone of layout.zones) {
    const original = resolved.get(zone.id);
    requireCondition(original, "original_unavailable", "The selected original is unavailable; no substitute was generated.", 409);
    const { data, info } = await sharp(original.bytes).resize({ width: zone.bounds.width, height: zone.bounds.height, fit: "inside", withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
    if (layout.plan.recipe === "image-evidence" && zone.role === "evidence") {
      requireCondition(imageEvidenceIsReadable(info, zone.bounds), "original_resolution_insufficient", "The selected original would be too small in this composition. Select a readable original or another plan.", 422);
    }
    const left = zone.bounds.x + Math.floor((zone.bounds.width - info.width) / 2);
    const top = zone.bounds.y + Math.floor((zone.bounds.height - info.height) / 2);
    composites.push({ input: data, left, top });
    placements.push({ id: zone.id, role: zone.role, hash: original.hash, bounds: { x: left, y: top, width: info.width, height: info.height } });
  }
  composites.push(...layout.layers.map((layer) => ({ input: layer.png, left: layer.bounds.x, top: layer.bounds.y })));
  const png = await sharp({ create: { ...canvas, channels: 4, background: layout.background } }).composite(composites).png().toBuffer();
  return { png, placements, text: layout.layers.map(({ approvedText, bounds, font }) => ({ approvedText, bounds, font })), plan: layout.plan };
}
