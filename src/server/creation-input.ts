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
import type { Pool, PoolClient } from "pg";
import { researchStrategySchema, type ResearchStrategyOutput } from "./providers/research-stages";
import { validateCreativePlan } from "./creative-intent";
import type { SlideView } from "../shared/contracts";
import type { CreativePlan } from "../shared/creative-intent";

type ResearchQueryClient = Pick<Pool | PoolClient, "query">;

export interface FrozenCreationResearch {
  runId: string;
  snapshotId: string;
  snapshotVersion: number;
  snapshotHash: string;
  entityId: string;
  sourceHashes: { evidenceId: string; contentHash: string }[];
  brandProfileVersion: number;
  strategy: ResearchStrategyOutput;
  strategyHash: string;
  planHash: string;
}

export interface CreationResearchSelection {
  researchId: string;
  researchSnapshotHash: string;
  brandProfileVersion: number;
}

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

export function shouldGenerateEditorialArtwork(input: Pick<CreationInput, "revision" | "analysis"> & Partial<Pick<CreationInput, "schemaVersion">>, state: PublicationView) {
  return input.schemaVersion !== 16 && !input.revision && !state.artwork && !state.artDirection?.direction.heroMaterialIds.length && !state.brandBrief?.noPhoto && !input.analysis?.selected.length;
}
export interface CreationInput {
  schemaVersion: 13 | 14 | 15 | 16;
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
  research?: FrozenCreationResearch;
  revision?: { instruction: string; scope: RevisionScope };
}

function normalizedSourceHashes(value: FrozenCreationResearch["sourceHashes"]) {
  return [...value].sort((a, b) => a.evidenceId.localeCompare(b.evidenceId));
}

export async function freezeCreationResearch(client: ResearchQueryClient, ownerId: string, selection: CreationResearchSelection): Promise<FrozenCreationResearch> {
  requireCondition(/^[a-f0-9]{64}$/u.test(selection.researchSnapshotHash), "research_snapshot_invalid", "Choose a completed research result before creating the post.", 409);
  requireCondition(Number.isSafeInteger(selection.brandProfileVersion) && selection.brandProfileVersion >= 0, "brand_version_invalid", "Choose the current Brand Profile before creating the post.", 409);
  const row = (await client.query(
    `SELECT r.id run_id,s.id snapshot_id,s.version snapshot_version,s.snapshot_hash,s.snapshot,
            e.status
       FROM brand_research_run r
       JOIN LATERAL (
         SELECT id,version,snapshot_hash,snapshot
           FROM brand_research_snapshot
          WHERE owner_id=r.owner_id AND run_id=r.id
          ORDER BY version DESC LIMIT 1
       ) s ON true
       JOIN LATERAL (
         SELECT status FROM brand_research_event
          WHERE owner_id=r.owner_id AND run_id=r.id
          ORDER BY sequence DESC LIMIT 1
       ) e ON true
      WHERE r.owner_id=$1 AND r.id=$2`,
    [ownerId, selection.researchId],
  )).rows[0];
  requireCondition(row, "research_not_found", "That research result is not available for this account.", 404);
  requireCondition(row.status === "review_ready", "research_not_ready", "Finish the saved research questions before preparing a plan.", 409);
  requireCondition(row.snapshot_hash === selection.researchSnapshotHash, "research_snapshot_changed", "The research result changed. Review the current findings before preparing a plan.", 409);
  const resolution = row.snapshot?.entityResolution;
  requireCondition(resolution?.status === "resolved" && resolution.confidence === "high" && typeof resolution.candidateId === "string" && resolution.candidateId, "research_identity_unconfirmed", "Confirm the exact business before preparing a plan.", 409);
  const evidence = Array.isArray(row.snapshot?.evidence) ? row.snapshot.evidence : [];
  const sourceHashes = normalizedSourceHashes(evidence.map((item: { id?: unknown; contentHash?: unknown }) => {
    requireCondition(typeof item.id === "string" && typeof item.contentHash === "string" && /^[a-f0-9]{64}$/u.test(item.contentHash), "research_snapshot_invalid", "The saved research evidence is invalid.", 409);
    return { evidenceId: item.id, contentHash: item.contentHash };
  }));
  let strategy: ResearchStrategyOutput;
  try { strategy = researchStrategySchema.parse(row.snapshot?.strategy); }
  catch { requireCondition(false, "research_plan_invalid", "The reviewed research does not contain a usable publication plan.", 409); throw new Error("unreachable"); }
  requireCondition(row.snapshot?.critic?.outcome === "pass" || row.snapshot?.critic?.outcome === "corrected", "research_plan_unchecked", "The research plan has not passed its saved quality review.", 409);
  return {
    runId: row.run_id,
    snapshotId: row.snapshot_id,
    snapshotVersion: Number(row.snapshot_version),
    snapshotHash: row.snapshot_hash,
    entityId: resolution.candidateId,
    sourceHashes,
    brandProfileVersion: selection.brandProfileVersion,
    strategy: structuredClone(strategy),
    strategyHash: inputHash(strategy),
    planHash: inputHash(strategy.plan),
  };
}

export async function verifyCreationResearch(client: ResearchQueryClient, ownerId: string, frozen: FrozenCreationResearch, brandProfileVersion: number) {
  requireCondition(frozen.brandProfileVersion === brandProfileVersion, "research_brand_mismatch", "The saved research and Brand Profile versions do not match.", 409);
  const current = await freezeCreationResearch(client, ownerId, {
    researchId: frozen.runId,
    researchSnapshotHash: frozen.snapshotHash,
    brandProfileVersion: frozen.brandProfileVersion,
  });
  requireCondition(
    current.snapshotId === frozen.snapshotId
      && current.snapshotVersion === frozen.snapshotVersion
      && current.entityId === frozen.entityId
      && current.strategyHash === frozen.strategyHash
      && current.planHash === frozen.planHash
      && inputHash(current.strategy) === inputHash(frozen.strategy)
      && inputHash(normalizedSourceHashes(current.sourceHashes)) === inputHash(normalizedSourceHashes(frozen.sourceHashes)),
    "research_snapshot_changed",
    "The frozen research evidence no longer matches this creation.",
    409,
  );
  return current;
}

function splitApprovedCopy(copy: string) {
  const [title, ...body] = copy.split("\n");
  requireCondition(Boolean(title?.trim()), "research_plan_incompatible", "A researched slide has no usable copy.", 409);
  return { title, body: body.join("\n") };
}

function researchedSlidePurpose(slide: ResearchStrategyOutput["plan"]["slides"][number], index: number, slideCount: number): CreativePlan["purpose"] {
  if (index === 0) return "hook";
  if (slideCount > 1 && index === slideCount - 1) return "closing";
  const intent = `${slide.objective}\n${slide.copy}\n${slide.visualDirection}`.normalize("NFKC").toLocaleLowerCase("en");
  if (/(?:how|steps?|process|flow|journey|works?|mechanism|sequence|шаг|процесс|как это работает|ablauf|schritte)/u.test(intent)) return "process";
  if (/(?:proof|evidence|result|trust|security|verified|escrow|metric|data|why believe|доказ|результат|безопас|провер|sicher|beleg|ergebnis)/u.test(intent)) return "proof";
  return "explain";
}

function researchedSlideRecipe(purpose: CreativePlan["purpose"], materialId: string): CreativePlan["recipe"] {
  if (materialId) return purpose === "proof" ? "image-evidence" : "graphic-stage";
  return purpose === "closing" ? "closing" : "type-poster";
}

export function researchedPublicationPlan(research: FrozenCreationResearch, brand: FrozenBrand, origin: CreationInput["origin"], slideId: (index: number) => string) {
  const { plan } = research.strategy;
  requireCondition(plan.slides.length === plan.slideCount && (plan.format === "single" ? plan.slideCount === 1 : plan.slideCount >= 2), "research_plan_incompatible", "The reviewed research plan has an inconsistent publication format.", 409);
  requireCondition(Boolean(brand.art), "research_plan_incompatible", "The reviewed plan cannot be rendered without a saved art direction.", 409);
  const slides: SlideView[] = plan.slides.map((slide, index) => {
    requireCondition(slide.index === index + 1 && slide.visualDirection.length <= 300, "research_plan_incompatible", "A reviewed slide cannot be represented by the current renderer.", 409);
    const materialId = slide.materialIds[0] ?? "";
    requireCondition(slide.materialIds.length <= 1 && (!materialId || brand.art!.direction.heroMaterialIds.includes(materialId)), "research_plan_incompatible", "A reviewed slide references an unavailable or unsupported original material.", 409);
    const purpose = researchedSlidePurpose(slide, index, plan.slideCount);
    const creativePlan = validateCreativePlan({
      purpose,
      recipe: researchedSlideRecipe(purpose, materialId),
      materialId,
      heading: purpose === "hook" || purpose === "closing" ? "large" : "medium",
      background: purpose === "closing" ? "foreground" : "background",
      alignment: purpose === "closing" ? "center" : "left",
      rationale: slide.visualDirection,
    }, brand.art!);
    return { id: slideId(index), index, ...splitApprovedCopy(slide.copy), creativePlan, copyOrigin: origin, visualOrigin: "deterministic" };
  });
  return { platform: plan.platform, slideCount: plan.slideCount, slides, caption: plan.caption, visualDirection: [
    `Purpose: ${plan.purpose}`, `Audience: ${plan.audience}`, `Angle: ${plan.angle}`, `CTA: ${plan.cta}`, `Visual system: ${plan.visualSystem}`,
    ...plan.slides.map((slide) => `Slide ${slide.index} — ${slide.objective}: ${slide.visualDirection}`),
  ].join("\n") };
}

export function suggestedSlideCount(idea: string) {
  const explicit = /(?<![\p{L}\p{N}])([1-6]|one|two|three|four|five|six|один|одна|два|три|четыре|пять|шесть|ein|eine|zwei|drei|vier|fünf|sechs)\s*[-–]?\s*(?:slides?|слайд[а-я]*|folien?)(?![\p{L}])/iu.exec(idea);
  if (explicit) {
    const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, один: 1, одна: 1, два: 2, три: 3, четыре: 4, пять: 5, шесть: 6, ein: 1, eine: 1, zwei: 2, drei: 3, vier: 4, fünf: 5, sechs: 6 };
    return words[explicit[1].toLowerCase()] ?? Number(explicit[1]);
  }
  return /(?:\b(?:steps|guide|walkthrough|compare|process)\b|шаг|этап|сравн|Schritte|Anleitung)/iu.test(idea) || idea.split(/(?:\n[-*\d]|;)/u).length >= 3 ? 3 : 1;
}

export function verifyCreationInput(value: CreationInput, hash: string) {
  const versionedPolicy = (value?.schemaVersion === 13 && value.policy === "unified-creation-v1")
    || (value?.schemaVersion === 14 && value.policy === "unified-creation-v2")
    || (value?.schemaVersion === 15 && value.policy === "plan-first-v1" && !value.research)
    || (value?.schemaVersion === 16 && value.policy === "plan-first-v1" && Boolean(value.research));
  requireCondition(versionedPolicy && inputHash(value) === hash && value.credits === (value.revision ? CREATION_REVISION_CREDITS : CREATION_CREDITS) && ["ai_preview", "openai"].includes(value.origin), "creation_snapshot_invalid", "The saved creation quote could not be verified.", 409);
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
