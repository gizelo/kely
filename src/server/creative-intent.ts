import { z } from "zod";
import type { CreativePlan, ProposedBrief } from "../shared/creative-intent";
import type { FrozenArtDirection } from "../shared/art-direction";
import type { PaidInputSnapshot } from "./paid-input";
import { requireCondition } from "./errors";
import { designSceneSchema, validateDesignScene } from "./design-scene";

export const creativePlanSchema = z.object({
  purpose: z.enum(["hook", "explain", "proof", "process", "closing"]),
  recipe: z.enum(["type-poster", "graphic-stage", "split-proof", "image-evidence", "closing"]),
  materialId: z.union([z.uuid(), z.literal("")]),
  heading: z.enum(["large", "medium"]),
  background: z.enum(["background", "foreground"]),
  alignment: z.enum(["left", "center"]),
  rationale: z.string().trim().min(1).max(300),
  scene: designSceneSchema.optional(),
}).strict();

const field = z.object({ value: z.string().trim().min(1).max(500), basis: z.enum(["user", "business", "proposed"]), sourceId: z.string().max(100), evidence: z.string().max(500) }).strict();
export const proposedBriefSchema = z.object({ audience: field, desiredAction: field, facts: z.array(field).max(5), requiredFacts: z.array(z.string().trim().min(1).max(300)).max(3) }).strict();

export function imageEvidenceIsReadable(original: { width: number; height: number }, zone: { width: number; height: number } = { width: 936, height: 560 }) {
  const scale = Math.min(1, zone.width / original.width, zone.height / original.height);
  const width = original.width * scale;
  const height = original.height * scale;
  return (width >= 560 && height >= 280) || (width >= 480 && height >= 480);
}

export function validateCreativePlan(value: unknown, art: FrozenArtDirection): CreativePlan {
  const plan = creativePlanSchema.parse(value);
  const usesImage = ["graphic-stage", "split-proof", "image-evidence"].includes(plan.recipe);
  requireCondition(usesImage ? Boolean(plan.materialId) && art.direction.heroMaterialIds.includes(plan.materialId) : plan.materialId === "", "creative_plan_invalid", "The proposed composition must use an explicitly selected original, or a typography-only recipe.", 422);
  const original = art.originals.find((item) => item.id === plan.materialId);
  if (plan.recipe === "image-evidence") {
    const zone = plan.scene?.materialZone
      ? { width: Math.round(plan.scene.materialZone.width * 1080 / 1000), height: Math.round(plan.scene.materialZone.height * 1350 / 1000) }
      : undefined;
    requireCondition(original && imageEvidenceIsReadable(original, zone), "original_resolution_insufficient", "The evidence image is too small or too narrow in this composition. Provide a readable original or choose another plan.", 422);
  }
  if (plan.scene) validateDesignScene(plan.scene, plan, art);
  return plan;
}

export function validateProposedBrief(value: unknown, snapshot: PaidInputSnapshot): ProposedBrief {
  const brief = proposedBriefSchema.parse(value);
  for (const item of [brief.audience, brief.desiredAction, ...brief.facts]) {
    if (item.basis === "proposed") {
      requireCondition(!item.sourceId && !item.evidence && !brief.facts.includes(item), "brief_evidence_invalid", "A creative proposal cannot be presented as a verified business fact.", 422);
      continue;
    }
    const source = item.basis === "user" ? snapshot.publication.messages.find((message) => message.id === item.sourceId && message.role === "user")?.text : item.sourceId === "context" ? snapshot.business.context : item.sourceId === "name" ? snapshot.business.name : undefined;
    requireCondition(source && item.evidence.trim() && source.includes(item.evidence) && item.value === item.evidence.trim(), "brief_evidence_invalid", "A sourced brief value must be the exact cited user or business span. Label interpretations as proposed instead.", 422);
  }
  return brief;
}
