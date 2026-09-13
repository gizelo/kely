import type { BrandRules, BrandPalette, BrandSource, FrozenBrand, MemoryInterpretation, ReadinessView, SourceCompleteness, SourceStrategy } from "../shared/brand";
import type { PublicationView } from "../shared/contracts";
import { requireCondition } from "./errors";
import type { ArtDirection } from "../shared/art-direction";
import { isCreativePolicy } from "../shared/creative-intent";

export function defaultArtDirection(palette: BrandPalette | null): ArtDirection {
  const colors = { indigo: ["#F8F7F3", "#17181C", "#254BFF", "#E3E1DA"], forest: ["#F4F6EE", "#153F2D", "#527849", "#DAE4D4"], rose: ["#FFF6F2", "#492C35", "#B1405F", "#F1D9DD"], sand: ["#F7F0E1", "#352817", "#805726", "#E6D7B7"] }[palette ?? "indigo"];
  return { policy: "art-direction-v1", palette: { background: colors[0], foreground: colors[1], accent: colors[2], muted: colors[3] }, headingFont: "sans", composition: "editorial", spacing: "open", logoMaterialId: null, heroMaterialIds: [] };
}

export const defaultBrandRules: BrandRules = { audience: "", palette: null, headlines: "default" };
export const brandPalettes: BrandPalette[] = ["indigo", "forest", "rose", "sand"];

export function sourceCompleteness(sources: BrandSource[], strategy: SourceStrategy | null, requirements: { requiredMaterialIds?: string[]; exactOriginalRequired?: boolean } = {}): SourceCompleteness {
  const activeMaterials = sources.flatMap((source) => source.materials);
  const images = activeMaterials.filter((material) => material.kind === "image");
  const blockers: SourceCompleteness["blockers"] = [];
  const recommendations: SourceCompleteness["recommendations"] = [];
  const optional: SourceCompleteness["optional"] = [];
  if (strategy === "use_materials" && !images.length) blockers.push({ code: "material_source_missing", message: "Add at least one reference or original, or ask Kely to decide the visual direction." });
  for (const id of requirements.requiredMaterialIds ?? []) if (!images.some((material) => material.id === id)) blockers.push({ code: "required_material_missing", message: "A material explicitly required for this post is unavailable.", materialId: id });
  if (requirements.exactOriginalRequired && !images.some((material) => material.role === "original")) blockers.push({ code: "required_original_missing", message: "Add the exact logo, product screenshot or photo required for this post." });
  for (const source of sources.filter((item) => item.kind === "social" && ["partial", "needs_upload"].includes(item.state))) {
    const resolved = sources.some((candidate) => candidate.fallbackFor === source.id && candidate.state === "available" && candidate.materials.some((material) => material.kind === "image"));
    if (!resolved) recommendations.push({ code: "social_screenshots_recommended", message: "Add 2–6 screenshots of the exact social posts for a reliable style match.", sourceId: source.id });
  }
  if (!images.some((material) => material.role === "original")) optional.push({ code: "original_optional", message: "Add an exact logo or owned image when brand recognition matters." });
  if (strategy === "decide_for_me") optional.push({ code: "creative_choices_delegated", message: "Kely may propose missing creative choices, but never business facts or asset rights." });
  const selectableAnalysisMaterialIds = sources.flatMap((source) => source.state === "available" || source.state === "partial" ? source.materials.filter((material) => material.kind === "image").map((material) => material.id) : []);
  return { status: blockers.length ? "blocked" : recommendations.length ? "ready_with_recommendations" : "ready", blockers, recommendations, optional, selectableAnalysisMaterialIds: [...new Set(selectableAnalysisMaterialIds)] };
}

export function interpretMemory(text: string): MemoryInterpretation {
  const value = text.trim().toLowerCase().replace(/[.!]$/u, "");
  if (/^(for this post only[, :]*)?(do not use a photo|no photo)( in this post)?$/u.test(value) || /^только (для этого поста|в этом посте)[,: ]+(без фото|не используй фото)$/u.test(value))
    return { status: "local", effect: "No photo applies only to this post. Use the post's local brief; no standing rule was saved." };
  if (/^always use (shorter|short) headlines( for our brand)?$/u.test(value) || /^всегда (используй|делай) короткие заголовки$/u.test(value))
    return { status: "durable", field: "headlines", value: "shorter", effect: "Remember shorter headlines for new brand-aware preparation replies. Current approved copy stays unchanged." };
  const palette = /^always use (indigo|forest|rose|sand)( palette)?( for our brand)?$/u.exec(value);
  if (palette) return { status: "durable", field: "palette", value: palette[1] as BrandPalette, effect: `Remember ${palette[1]} as the default for future posts without a custom visual direction. Prepared posts keep their accepted direction.` };
  return { status: "clarification", effect: "Should this apply only to this post or become a standing rule? This local parser supports 'Always use shorter headlines', 'Always use forest palette', and 'No photo in this post'. Other wording is not interpreted automatically." };
}

export function selectedPalette(brand: FrozenBrand): BrandPalette {
  return brand.brief.direction && brand.brief.direction !== "decide" ? brand.brief.direction : brand.rules.palette ?? "indigo";
}

export function brandReadiness(state: PublicationView, brand: FrozenBrand): ReadinessView {
  const blockers: ReadinessView["blockers"] = [];
  if (!state.idea.trim()) blockers.push({ code: "task_missing", message: "Describe what this post should communicate." });
  if (!brand.brief.audience.trim() && !(isCreativePolicy(state.designPolicy) && state.proposedBrief?.audience.value.trim())) blockers.push({ code: "audience_missing", message: "Who is this post for? Preparation can propose an audience, or you can add one." });
  if (!brand.brief.direction && !brand.art) blockers.push({ code: "direction_missing", message: "Choose a palette or explicitly ask Kely to decide." });
  if (brand.brief.blockingFacts.length) blockers.push({ code: "facts_missing", message: `Resolve these facts during preparation: ${brand.brief.blockingFacts.join("; ")}` });
  if (isCreativePolicy(state.designPolicy) && state.proposedBrief?.requiredFacts.length) blockers.push({ code: "facts_missing", message: `Resolve the required brief inputs: ${state.proposedBrief.requiredFacts.join("; ")}` });
  if (brand.art && brand.brief.noPhoto && brand.art.direction.heroMaterialIds.length) blockers.push({ code: "photo_conflict", message: "This post excludes photos but its selected direction includes imagery. Confirm a typography-only direction before continuing." });
  if (brand.art?.originals.some((original) => !brand.materials.some((material) => material.id === original.id && material.role === "original" && material.contentHash === original.hash))) blockers.push({ code: "original_unavailable", message: "A selected original is no longer available in this brand. Choose an available original before creating new visuals." });
  for (const id of brand.brief.requiredMaterialIds) {
    const material = brand.materials.find((item) => item.id === id);
    if (!material || material.kind !== "image") blockers.push({ code: "material_missing", message: "A required original image is missing or is only an unfetched link." });
    else if (!brand.art?.originals.some((original) => original.id === id)) blockers.push({ code: "material_composition_unavailable", message: `“${material.label}” is not placed in the current direction. Select it as an original logo or image, or explicitly remove this requirement.` });
    else if (isCreativePolicy(state.designPolicy) && state.slides.length && brand.art.direction.logoMaterialId !== id && !state.slides.some((slide) => slide.creativePlan?.materialId === id)) blockers.push({ code: "material_composition_unavailable", message: `“${material.label}” is required but absent from the proposed slide plan. Change the plan or explicitly remove the requirement.` });
  }
  return { ready: blockers.length === 0, blockers };
}

export function assertBrandReady(state: PublicationView, brand: FrozenBrand) {
  const readiness = brandReadiness(state, brand);
  requireCondition(readiness.ready, "brand_not_ready", readiness.blockers.map((item) => item.message).join(" "), 409);
}
