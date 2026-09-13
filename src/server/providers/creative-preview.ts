import type { CreativePlan, ProposedBrief } from "../../shared/creative-intent";

export function previewCreativeDraft(input: { slideCount: number; artDirection: { heroMaterialIds: string[] }; selectedOriginals?: { id: string; width: number; height: number }[]; selectedReferenceAnalysis?: { observations: { materialId: string; purpose: string }[] } | null; standingPreferences?: { audience?: string }; postBrief?: { unresolvedRequiredFacts: string[] } }) {
  const heroes = input.artDirection.heroMaterialIds;
  const graphic = input.selectedReferenceAnalysis?.observations.find((item) => item.purpose === "graphic" && heroes.includes(item.materialId))?.materialId ?? heroes[0];
  const evidence = input.selectedReferenceAnalysis?.observations.find((item) => item.purpose === "screenshot" && heroes.includes(item.materialId))?.materialId ?? heroes[1] ?? heroes[0];
  const original = input.selectedOriginals?.find((item) => item.id === evidence);
  const scale = original ? Math.min(1, 936 / original.width, 560 / original.height) : 0;
  const wideEvidence = original && original.width >= 640 && original.height >= 360 && original.width * scale >= 560 && original.height * scale >= 280;
  const brief: ProposedBrief = {
    audience: { value: input.standingPreferences?.audience || "People interested in this business", basis: "proposed", sourceId: "", evidence: "" },
    desiredAction: { value: "Learn about the idea and ask a relevant question", basis: "proposed", sourceId: "", evidence: "" },
    facts: [], requiredFacts: input.postBrief?.unresolvedRequiredFacts ?? [],
  };
  const plans: CreativePlan[] = Array.from({ length: input.slideCount }, (_, index) => {
    const last = index === input.slideCount - 1 && index > 0;
    const materialId = last ? "" : index === 0 ? graphic ?? "" : evidence ?? "";
    return { purpose: last ? "closing" : index === 0 ? "hook" : "proof", recipe: last ? "closing" : index === 0 ? materialId ? "graphic-stage" : "type-poster" : materialId ? wideEvidence ? "image-evidence" : "split-proof" : "type-poster", materialId, heading: index === 0 || last ? "large" : "medium", background: last ? "foreground" : "background", alignment: last ? "center" : "left", rationale: "Simulated per-slide plan for checking the workflow; not a live design recommendation." };
  });
  return { brief, plans };
}
