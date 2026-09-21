import { createHash } from "node:crypto";
import sharp from "sharp";
import type { GenerationOrigin, PublicationView, RevisionScope } from "../shared/contracts";
import type { CreationQuoteView } from "../shared/creation";
import type { FrozenBrand } from "../shared/brand";
import { readBrandMaterial } from "./brand";
import { inputHash, snapshotPaidInput, type PaidInputSnapshot } from "./paid-input";
import type { AnalysisInput } from "./providers/analysis";
import { semanticDirectionEligibility } from "./semantic-direction";
import { semanticTones, visualGrammars } from "../shared/semantic-direction";
import { requireCondition } from "./errors";
import { freezeArtDirection } from "./art-direction";

export const CREATION_CREDITS = 30;
export const CREATION_REVISION_CREDITS = 11;

export function applySelectedOriginals(brand: FrozenBrand, materialIds: string[]): FrozenBrand {
  if (!brand.art) return structuredClone(brand);
  const selected = materialIds.map(id => brand.materials.find(item => item.id === id)).filter((item): item is NonNullable<typeof item> => item?.kind === "image" && item.role === "original");
  if (!selected.length) return structuredClone(brand);
  const logo = selected.find(item => /(?:^|[\s._-])logo(?:[\s._-]|$)/iu.test(item.label));
  const heroes = brand.brief.noPhoto ? [] : selected.filter(item => item.id !== logo?.id).slice(0, 2);
  const next = structuredClone(brand);
  next.art = freezeArtDirection({ ...brand.art.direction, logoMaterialId: logo?.id ?? brand.art.direction.logoMaterialId, heroMaterialIds: heroes.length ? heroes.map(item => item.id) : brand.art.direction.heroMaterialIds, composition: heroes.length ? "image-led" : brand.art.direction.composition }, brand.materials, brand.brief.noPhoto);
  const { hash: _hash, ...value } = next;
  next.hash = inputHash(value);
  return next;
}

export function shouldGenerateEditorialArtwork(input: Pick<CreationInput, "revision" | "analysis">, state: PublicationView) {
  return !input.revision && !state.artwork && !state.artDirection?.direction.heroMaterialIds.length && !state.brandBrief?.noPhoto && !input.analysis?.selected.length;
}
export interface CreationInput {
  schemaVersion: 13 | 14 | 15;
  policy: "unified-creation-v1" | "unified-creation-v2" | "plan-first-v1";
  ownerId: string;
  quoteId: string;
  origin: Exclude<GenerationOrigin, "fixture">;
  publication: PublicationView;
  brand: FrozenBrand;
  business: PaidInputSnapshot["business"];
  analysis: AnalysisInput | null;
  credits: number;
  format: CreationQuoteView["format"];
  revision?: { instruction: string; scope: RevisionScope };
}

export function suggestedSlideCount(idea: string) {
  return /(?:\b(?:steps|guide|walkthrough|three|compare|process)\b|шаг|этап|сравн|Schritte|Anleitung)/iu.test(idea) || idea.split(/(?:\n[-*\d]|;)/u).length >= 3 ? 3 : 1;
}

export function verifyCreationInput(value: CreationInput, hash: string) {
  requireCondition(((value?.schemaVersion === 13 && value.policy === "unified-creation-v1") || (value?.schemaVersion === 14 && value.policy === "unified-creation-v2") || (value?.schemaVersion === 15 && value.policy === "plan-first-v1")) && inputHash(value) === hash && value.credits === (value.revision ? CREATION_REVISION_CREDITS : CREATION_CREDITS) && ["ai_preview", "openai"].includes(value.origin), "creation_snapshot_invalid", "The saved creation quote could not be verified.", 409);
  return structuredClone(value);
}

export function creationPlanHash(state: PublicationView) {
  return inputHash({ platform: state.platform, slideCount: state.slideCount, slides: state.slides.map(slide => ({ id: slide.id, index: slide.index, title: slide.title, body: slide.body, creativePlan: slide.creativePlan ?? null, artDirection: slide.artDirection ?? null })), caption: state.caption, artDirection: state.artDirection ?? null, artworkLayout: state.creation?.artworkLayout ?? null });
}

export async function creationAnalysis(ownerId: string, materialIds: string[], brand: FrozenBrand, guidance: string): Promise<AnalysisInput | null> {
  requireCondition(materialIds.length <= 3 && new Set(materialIds).size === materialIds.length, "analysis_input", "Choose up to three distinct reference images.");
  if (!materialIds.length) return null;
  const selected: AnalysisInput["selected"] = [];
  for (const id of materialIds) {
    const expected = brand.materials.find((material) => material.id === id && material.kind === "image");
    requireCondition(expected, "analysis_input", "Choose an available image from your own Brand workspace.", 404);
    const material = await readBrandMaterial(ownerId, id);
    requireCondition(material.view.version === expected.version && material.view.contentHash === expected.contentHash, "material_unavailable", "A selected image changed. Review its current version.", 409);
    const { data, info } = await sharp(material.bytes, { limitInputPixels: 16_000_000, failOn: "warning" }).resize({ width: 1536, height: 1536, fit: "inside", withoutEnlargement: true }).flatten({ background: "#FFFFFF" }).jpeg({ quality: 90, chromaSubsampling: "4:4:4" }).toBuffer({ resolveWithObject: true });
    requireCondition(data.length <= 1_048_576, "analysis_image_large", "This image needs a smaller analysis copy. No AI has been called.", 422);
    selected.push({ id, label: expected.label, role: expected.role, version: expected.version, originalHash: expected.contentHash!, derivativeHash: createHash("sha256").update(data).digest("hex"), width: info.width, height: info.height, dataUrl: `data:image/jpeg;base64,${data.toString("base64")}` });
  }
  return { selected, guidance, rules: structuredClone(brand.rules) };
}

export function creationDesignInput(input: CreationInput, state: PublicationView, stepId: string): PaidInputSnapshot {
  const snapshot = snapshotPaidInput(input.ownerId, stepId, input.revision ? "revise" : "prepare", input.revision?.instruction ?? "", state);
  snapshot.schemaVersion = 12;
  snapshot.brand = structuredClone(input.brand);
  if (state.artDirection) snapshot.brand.art = structuredClone(state.artDirection);
  if (state.brandBrief) snapshot.brand.brief = structuredClone(state.brandBrief);
  const { hash: _hash, ...brandValue } = snapshot.brand;
  snapshot.brand.hash = inputHash(brandValue);
  snapshot.business = structuredClone(input.business);
  snapshot.generation = { origin: input.origin, model: "gpt-5.6-luna", ...(input.revision ? { scope: input.revision.scope } : {}) };
  const eligibility = input.policy === "plan-first-v1" && !input.revision
    ? { ...snapshot, publication: { ...snapshot.publication, artDirection: undefined } }
    : snapshot;
  snapshot.semanticDirection = { mode: semanticDirectionEligibility(eligibility), allowedTones: [...semanticTones], allowedGrammars: [...visualGrammars], inherited: snapshot.brand.art!.direction };
  return snapshot;
}
