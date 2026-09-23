import { createHash } from "node:crypto";
import { z } from "zod";
import type { CreativePlan } from "../shared/creative-intent";
import type { DesignPrimitive, DesignScene, DesignSceneV1, NormalizedZone } from "../shared/design-scene";
import type { FrozenArtDirection } from "../shared/art-direction";
import type { SemanticDirectionV1 } from "../shared/semantic-direction";
import { semanticTones, visualGrammars } from "../shared/semantic-direction";
import { requireCondition } from "./errors";
import { contrastRatio } from "./art-direction";

const zone = z.object({ x: z.number().int().min(0).max(1000), y: z.number().int().min(0).max(1000), width: z.number().int().min(1).max(1000), height: z.number().int().min(1).max(1000) }).strict();
const color = z.enum(["accent", "muted", "foreground"]);
const primitive = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("rect"), zone, color, opacity: z.number().min(0.08).max(1), radius: z.number().int().min(0).max(500), rotation: z.number().int().min(-18).max(18) }).strict(),
  z.object({ kind: z.literal("ellipse"), zone, color, opacity: z.number().min(0.08).max(1) }).strict(),
  z.object({ kind: z.literal("rule"), zone, color, opacity: z.number().min(0.08).max(1) }).strict(),
]);
const designSceneV1Schema = z.object({
  version: z.literal(1), seed: z.string().regex(/^[a-f0-9]{16}$/u),
  composition: z.enum(["editorial-offset", "signal-grid", "evidence-split", "structured-stack", "action-frame"]),
  titleZone: zone, bodyZone: zone,
  materialZone: zone.extend({ id: z.uuid(), role: z.enum(["graphic", "evidence"]), fit: z.literal("contain") }).strict().nullable(),
  primitives: z.array(primitive).max(10),
}).strict();
const designSceneV2Schema = z.object({
  version: z.literal(2), seed: z.string().regex(/^[a-f0-9]{16}$/u),
  composition: z.enum(["editorial-offset", "signal-grid", "evidence-split", "structured-stack", "action-frame"]),
  grammar: z.enum(visualGrammars), tone: z.enum(semanticTones),
  titleZone: zone, bodyZone: zone, materialZone: z.null(), primitives: z.array(primitive).max(10),
}).strict();
export const designSceneSchema = z.discriminatedUnion("version", [designSceneV1Schema, designSceneV2Schema]);

function end(value: NormalizedZone) { return { x: value.x + value.width, y: value.y + value.height }; }
function overlaps(a: NormalizedZone, b: NormalizedZone) { const ae = end(a), be = end(b); return a.x < be.x && ae.x > b.x && a.y < be.y && ae.y > b.y; }
function inside(value: NormalizedZone) { const e = end(value); return e.x <= 1000 && e.y <= 1000; }
function insideContentSafeArea(value: NormalizedZone) { const e = end(value); return value.x >= 40 && value.y >= 40 && e.x <= 960 && e.y <= 960; }
function blend(foreground: string, background: string, opacity: number) {
  const channel = (value: string, offset: number) => Number.parseInt(value.slice(offset, offset + 2), 16);
  const mixed = [1, 3, 5].map((offset) => Math.round(channel(foreground, offset) * opacity + channel(background, offset) * (1 - opacity)));
  return `#${mixed.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

export function validateDesignScene(value: unknown, plan: CreativePlan, art: FrozenArtDirection): DesignScene {
  const scene = designSceneSchema.parse(value);
  for (const item of [scene.titleZone, scene.bodyZone, ...(scene.materialZone ? [scene.materialZone] : []), ...scene.primitives.map((layer) => layer.zone)]) requireCondition(inside(item), "design_scene_out_of_bounds", "The proposed design scene extends beyond the canvas.", 422);
  for (const item of [scene.titleZone, scene.bodyZone, ...(scene.materialZone ? [scene.materialZone] : [])]) requireCondition(insideContentSafeArea(item), "design_scene_safe_area", "Copy and original artwork must stay inside the social-safe area.", 422);
  for (const layer of scene.primitives.filter((item): item is Extract<DesignPrimitive, { kind: "rect" }> => item.kind === "rect" && item.rotation !== 0)) {
    const angle = Math.abs(layer.rotation) * Math.PI / 180;
    const rotatedWidth = layer.zone.width * Math.cos(angle) + layer.zone.height * Math.sin(angle);
    const rotatedHeight = layer.zone.width * Math.sin(angle) + layer.zone.height * Math.cos(angle);
    const centerX = layer.zone.x + layer.zone.width / 2, centerY = layer.zone.y + layer.zone.height / 2;
    requireCondition(centerX - rotatedWidth / 2 >= 0 && centerX + rotatedWidth / 2 <= 1000 && centerY - rotatedHeight / 2 >= 0 && centerY + rotatedHeight / 2 <= 1000, "design_scene_out_of_bounds", "A rotated design layer extends beyond the canvas.", 422);
  }
  requireCondition(!overlaps(scene.titleZone, scene.bodyZone), "design_scene_overlap", "Title and body need separate readable areas.", 422);
  const base = plan.background === "foreground" ? art.direction.palette.foreground : art.direction.palette.background;
  const text = plan.background === "foreground" ? art.direction.palette.background : art.direction.palette.foreground;
  for (const textZone of [scene.titleZone, scene.bodyZone]) {
    const backdrops = scene.primitives.filter((layer) => overlaps(layer.zone, textZone));
    requireCondition(backdrops.length <= 1, "design_scene_contrast", "Copy may have only one predictable local backdrop.", 422);
    if (backdrops[0]) {
      const backdrop = blend(art.direction.palette[backdrops[0].color], base, backdrops[0].opacity);
      requireCondition(contrastRatio(text, backdrop) >= 4.5, "design_scene_contrast", "The proposed local artwork does not preserve readable text contrast.", 422);
    }
  }
  if (scene.materialZone) {
    requireCondition(scene.materialZone.id === plan.materialId && art.direction.heroMaterialIds.includes(scene.materialZone.id), "creative_plan_invalid", "The scene may place only the explicitly selected original.", 422);
    requireCondition(!overlaps(scene.titleZone, scene.materialZone) && !overlaps(scene.bodyZone, scene.materialZone), "design_scene_overlap", "Approved copy and the selected original need separate areas.", 422);
  } else requireCondition(plan.materialId === "", "creative_plan_invalid", "A selected original requires one bounded scene placement.", 422);
  requireCondition(scene.primitives.length >= 2, "design_scene_invalid", "A design scene needs a bounded local artwork treatment.", 422);
  return scene;
}

function seeded(seed: string, offset: number, range: number) { return Number.parseInt(seed.slice(offset, offset + 4), 16) % range; }
function rect(x: number, y: number, width: number, height: number, color: DesignPrimitive["color"], opacity: number, seed: string): Extract<DesignPrimitive, { kind: "rect" }> {
  return { kind: "rect", zone: { x, y, width, height }, color, opacity, radius: 12 + seeded(seed, 4, 44), rotation: width > 700 ? 0 : seeded(seed, 8, 17) - 8 };
}

export function createDesignScene(plan: CreativePlan, art: FrozenArtDirection, acceptedSeed: string, slideIndex: number): DesignSceneV1 {
  const seed = createHash("sha256").update(`${acceptedSeed}:${slideIndex}:${plan.purpose}:${plan.materialId}`).digest("hex").slice(0, 16);
  const drift = seeded(seed, 0, 55);
  let scene: Omit<DesignSceneV1, "version" | "seed" | "primitives"> & { primitives: DesignPrimitive[] };
  if (plan.materialId) {
    const original = art.originals.find((item) => item.id === plan.materialId);
    requireCondition(original, "creative_plan_invalid", "The scene cannot place an unavailable original.", 422);
    const portrait = original.height > original.width;
    if (plan.recipe === "graphic-stage") scene = { composition: "editorial-offset", titleZone: { x: 70, y: 515, width: 860, height: 190 }, bodyZone: { x: 70, y: 735, width: 760, height: 145 }, materialZone: { x: 350, y: 95, width: 580, height: 350, id: plan.materialId, role: "graphic", fit: "contain" }, primitives: [rect(30 + drift, 75, 230, 48, "accent", .95, seed), { kind: "ellipse", zone: { x: 745, y: 900, width: 175, height: 70 }, color: "muted", opacity: .85 }] };
    else if (plan.recipe === "image-evidence") scene = { composition: "signal-grid", titleZone: { x: 70, y: 105, width: 860, height: 170 }, bodyZone: { x: 70, y: 300, width: 860, height: 115 }, materialZone: { x: 80, y: 455, width: 840, height: 420, id: plan.materialId, role: "evidence", fit: "contain" }, primitives: [rect(25 + drift, 55, 190, 35, "accent", .95, seed), { kind: "rule", zone: { x: 70, y: 930, width: 860, height: 6 }, color: "muted", opacity: .9 }] };
    else scene = { composition: "evidence-split", titleZone: { x: 70, y: 170, width: 410, height: 240 }, bodyZone: { x: 70, y: 455, width: 410, height: 300 }, materialZone: { x: 555, y: 150, width: 380, height: portrait ? 720 : 520, id: plan.materialId, role: plan.purpose === "proof" ? "evidence" : "graphic", fit: "contain" }, primitives: [rect(25 + drift, 55, 190, 42, "accent", .95, seed), { kind: "rule", zone: { x: 70, y: 925, width: 860, height: 6 }, color: "muted", opacity: .9 }] };
  } else if (plan.purpose === "closing") {
    scene = { composition: "action-frame", titleZone: { x: 125, y: 250, width: 750, height: 260 }, bodyZone: { x: 180, y: 555, width: 640, height: 180 }, materialZone: null, primitives: [rect(55 + drift, 110, 890 - drift, 710, "muted", .42, seed), { kind: "ellipse", zone: { x: 760, y: 45 + Math.floor(drift / 3), width: 175, height: 150 }, color: "accent", opacity: .9 }, { kind: "rule", zone: { x: 310, y: 790, width: 380, height: 8 }, color: "accent", opacity: 1 }] };
  } else if (plan.purpose === "process") {
    scene = { composition: "structured-stack", titleZone: { x: 80, y: 105, width: 760, height: 210 }, bodyZone: { x: 80, y: 625, width: 750, height: 230 }, materialZone: null, primitives: [rect(80, 385, 675 + drift, 55, "accent", .95, seed), rect(160, 470, 650 - drift, 55, "muted", .9, seed), rect(240, 555, 570, 55, "foreground", .16, seed)] };
  } else if (plan.purpose === "proof") {
    scene = { composition: "signal-grid", titleZone: { x: 80, y: 110, width: 650, height: 210 }, bodyZone: { x: 80, y: 660, width: 720, height: 220 }, materialZone: null, primitives: [rect(80, 390, 240 + drift, 180, "accent", .9, seed), rect(370 + drift, 390, 180, 180, "muted", .9, seed), rect(600, 390, 300 - drift, 180, "foreground", .14, seed)] };
  } else if (plan.purpose === "explain") {
    scene = { composition: "structured-stack", titleZone: { x: 80, y: 120, width: 760, height: 220 }, bodyZone: { x: 80, y: 550, width: 700, height: 300 }, materialZone: null, primitives: [{ kind: "rule", zone: { x: 80, y: 410, width: 830, height: 10 }, color: "accent", opacity: 1 }, rect(720 - drift, 360, 210, 210, "muted", .8, seed), { kind: "ellipse", zone: { x: 780, y: 760 - drift, width: 150, height: 150 }, color: "accent", opacity: .8 }] };
  } else {
    scene = { composition: "editorial-offset", titleZone: { x: 75, y: 300, width: 720, height: 330 }, bodyZone: { x: 75, y: 700, width: 690, height: 190 }, materialZone: null, primitives: [{ kind: "ellipse", zone: { x: 715 - drift, y: 45 + Math.floor(drift / 3), width: 235, height: 210 }, color: "accent", opacity: .92 }, rect(40, 95, 320 + drift, 55, "muted", .95, seed), { kind: "rule", zone: { x: 820, y: 430, width: 95, height: 430 }, color: "foreground", opacity: .18 }] };
  }
  return validateDesignScene({ version: 1, seed, ...scene }, { ...plan, scene: undefined }, art) as DesignSceneV1;
}

function semanticZones(purpose: CreativePlan["purpose"]) {
  const zones = { titleZone: { x: purpose === "closing" ? 120 : 70, y: 90, width: purpose === "closing" ? 760 : 780, height: 245 }, bodyZone: { x: purpose === "closing" ? 170 : 70, y: 690, width: purpose === "closing" ? 660 : 760, height: 195 } };
  if (purpose === "closing") return { composition: "action-frame" as const, ...zones };
  if (purpose === "process" || purpose === "explain") return { composition: "structured-stack" as const, ...zones };
  if (purpose === "proof") return { composition: "signal-grid" as const, ...zones };
  return { composition: "editorial-offset" as const, ...zones };
}

export function createDesignSceneV2(plan: CreativePlan, art: FrozenArtDirection, acceptedSeed: string, slideIndex: number, direction: SemanticDirectionV1): DesignScene {
  requireCondition(!plan.materialId, "creative_plan_invalid", "Semantic no-material scenes cannot place an original.", 422);
  const seed = createHash("sha256").update(`${acceptedSeed}:${direction.policy}:${direction.grammar}:${direction.tone}:${slideIndex}:${plan.purpose}`).digest("hex").slice(0, 16);
  const drift = seeded(seed, 0, 42), soft = direction.tone === "calm" || direction.tone === "warm" ? .68 : direction.tone === "premium" ? .82 : .94;
  const base = semanticZones(plan.purpose);
  let primitives: DesignPrimitive[];
  switch (direction.grammar) {
    case "editorial-lines": primitives = [
      { kind: "rule", zone: { x: 55, y: 45, width: 170 + drift, height: 8 }, color: "accent", opacity: soft },
      { kind: "rule", zone: { x: 870, y: 350, width: 8, height: 470 }, color: "foreground", opacity: .18 },
      { kind: "rule", zone: { x: 55, y: 935, width: 860, height: 5 }, color: "muted", opacity: .9 },
    ]; break;
    case "modular-grid": primitives = [
      rect(75, 355, 215 + drift, 170, "accent", soft, seed), rect(330 + drift, 355, 205, 170, "muted", .88, seed),
      rect(575, 355, 305 - drift, 170, "foreground", .14, seed),
    ]; break;
    case "soft-organic": primitives = [
      { kind: "ellipse", zone: { x: 690, y: 405, width: 225 + drift, height: 190 }, color: "accent", opacity: soft },
      { kind: "ellipse", zone: { x: 555, y: 465, width: 155, height: 105 + drift }, color: "muted", opacity: .82 },
      { kind: "rule", zone: { x: 55, y: 940, width: 620, height: 6 }, color: "accent", opacity: .75 },
    ]; break;
    case "crafted-collage": primitives = [
      { ...rect(600, 390, 190, 150, "accent", soft, seed), rotation: -7 },
      { ...rect(750, 430, 155, 125, "muted", .9, seed), rotation: 8 },
      { ...rect(470, 455, 125, 110, "foreground", .14, seed), rotation: -5 },
    ]; break;
    case "bold-geometry": primitives = [
      { kind: "rect", zone: { x: 670, y: 370, width: 280, height: 205 }, color: "accent", opacity: soft, radius: 0, rotation: 0 },
      { kind: "rect", zone: { x: 500, y: 430, width: 160, height: 145 }, color: "foreground", opacity: .16, radius: 0, rotation: 0 },
      { kind: "rule", zone: { x: 40, y: 930, width: 910, height: 12 }, color: "accent", opacity: 1 },
    ]; break;
  }
  return validateDesignScene({ version: 2, seed, grammar: direction.grammar, tone: direction.tone, materialZone: null, ...base, primitives }, { ...plan, scene: undefined }, art);
}
