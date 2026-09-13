import { z } from "zod";
import type { FrozenArtDirection } from "../shared/art-direction";
import type { CreativePlan, ProposedBrief } from "../shared/creative-intent";
import { creativePlanSchema, proposedBriefSchema, validateCreativePlan, validateProposedBrief } from "./creative-intent";
import type { PaidInputSnapshot } from "./paid-input";
import { AppError, requireCondition } from "./errors";

function literal(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); }

export function canonicalizeBriefV2(value: unknown, snapshot: PaidInputSnapshot): ProposedBrief {
  const brief = proposedBriefSchema.parse(value);
  for (const item of [brief.audience, brief.desiredAction, ...brief.facts]) {
    if (item.basis === "proposed") continue;
    if (item.basis === "business") item.sourceId = item.sourceId === "business.context" ? "context" : item.sourceId === "business.name" ? "name" : item.sourceId;
    const source = item.basis === "user" ? snapshot.publication.messages.find((message) => message.id === item.sourceId && message.role === "user")?.text : item.sourceId === "context" ? snapshot.business.context : item.sourceId === "name" ? snapshot.business.name : undefined;
    const evidence = item.evidence.trim();
    requireCondition(source && evidence && new RegExp(`^${literal(evidence)}$`, "iu").test(item.value), "brief_evidence_invalid", "The value and evidence must refer to the same source span; paraphrases cannot be repaired as facts.", 422);
    const matches: string[] = [];
    for (const match of source.matchAll(new RegExp(`(?=(${literal(evidence)}))`, "giu"))) {
      matches.push(match[1]);
      if (matches.length > 1) break;
    }
    requireCondition(matches.length === 1, "brief_evidence_invalid", "The cited source span must match unambiguously. No fuzzy attribution was accepted.", 422);
    item.value = matches[0];
    item.evidence = matches[0];
  }
  return validateProposedBrief(brief, snapshot);
}

export type LayoutChoice = Pick<CreativePlan, "recipe" | "materialId">;
export function layoutChoicesV2(art: FrozenArtDirection): Record<string, LayoutChoice> {
  const choices: Record<string, LayoutChoice> = { "type-poster": { recipe: "type-poster", materialId: "" }, closing: { recipe: "closing", materialId: "" } };
  for (const materialId of art.direction.heroMaterialIds) for (const recipe of ["graphic-stage", "split-proof", "image-evidence"] as const) {
    try {
      validateCreativePlan({ recipe, materialId, purpose: "explain", heading: "medium", background: "background", alignment: "left", rationale: "Validate this allowed original and composition pair." }, art);
      choices[`${recipe}:${materialId}`] = { recipe, materialId };
    } catch (error) {
      if (!(error instanceof AppError && error.code === "original_resolution_insufficient")) throw error;
    }
  }
  return choices;
}

export const wirePlanV2 = creativePlanSchema.omit({ recipe: true, materialId: true }).extend({ layoutChoice: z.string().min(1).max(128) }).strict();
export function decodePlansV2(value: unknown, art: FrozenArtDirection): CreativePlan[] {
  const plans = z.array(wirePlanV2).max(6).parse(value);
  const choices = layoutChoicesV2(art);
  return plans.map(({ layoutChoice, ...plan }) => {
    requireCondition(Object.hasOwn(choices, layoutChoice), "creative_plan_invalid", "Choose one of the quoted original/composition pairs. No substitute or incompatible image was accepted.", 422);
    return validateCreativePlan({ ...plan, ...choices[layoutChoice] }, art);
  });
}
