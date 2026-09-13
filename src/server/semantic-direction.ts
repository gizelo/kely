import { createHash } from "node:crypto";
import { z } from "zod";
import type { FrozenArtDirection } from "../shared/art-direction";
import type { PublicationDirectionProposal, SemanticDirectionV1 } from "../shared/semantic-direction";
import { semanticTones, visualGrammars } from "../shared/semantic-direction";
import type { PaidInputSnapshot } from "./paid-input";
import { contrastRatio, validateArtDirection } from "./art-direction";
import { canonicalJson } from "./paid-input";
import { requireCondition } from "./errors";

const hex = z.string().regex(/^#[A-Fa-f0-9]{6}$/u);
const semanticSchema = z.object({
  mode: z.literal("propose"),
  tone: z.enum(semanticTones), grammar: z.enum(visualGrammars),
  background: hex, foreground: hex, accent: hex, muted: hex,
  headingFont: z.enum(["sans", "serif", "unbounded"]), spacing: z.enum(["open", "compact"]),
  rationale: z.string().trim().min(1).max(240),
}).strict();
const inheritSchema = z.object({
  mode: z.literal("inherit"), tone: z.literal("precise"), grammar: z.literal("editorial-lines"),
  background: z.literal(""), foreground: z.literal(""), accent: z.literal(""), muted: z.literal(""),
  headingFont: z.literal("sans"), spacing: z.literal("open"), rationale: z.literal(""),
}).strict();

export type WireSemanticDirection = z.infer<typeof semanticSchema> | z.infer<typeof inheritSchema>;
export const inheritSemanticDirection: WireSemanticDirection = { mode: "inherit", tone: "precise", grammar: "editorial-lines", background: "", foreground: "", accent: "", muted: "", headingFont: "sans", spacing: "open", rationale: "" };

export function semanticDirectionEligibility(snapshot: Pick<PaidInputSnapshot, "kind" | "publication" | "brand">): "propose" | "inherit" {
  const state = snapshot.publication, brand = snapshot.brand;
  const selected = brand?.art?.direction;
  return snapshot.kind === "prepare"
    && !state.artDirection && state.directionProposal?.status !== "accepted"
    && !brand?.rules.artDirection
    && state.brandBrief?.direction === "decide"
    && !(state.brandBrief.requiredMaterialIds.length)
    && !(selected?.heroMaterialIds.length)
    && !selected?.logoMaterialId
    ? "propose" : "inherit";
}

function upper(value: string) { return value.toUpperCase(); }

function blendHex(foreground: string, background: string, opacity: number) {
  const channel = (value: string, offset: number) => Number.parseInt(value.slice(offset, offset + 2), 16);
  return `#${[1, 3, 5].map((offset) => Math.round(channel(foreground, offset) * opacity + channel(background, offset) * (1 - opacity)).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

export function validateSemanticDirection(value: unknown, mode: "propose" | "inherit"): SemanticDirectionV1 | null {
  if (mode === "inherit") { inheritSchema.parse(value); return null; }
  const wire = semanticSchema.parse(value);
  const palette = { background: upper(wire.background), foreground: upper(wire.foreground), accent: upper(wire.accent), muted: upper(wire.muted) };
  requireCondition(contrastRatio(palette.background, palette.foreground) >= 4.5, "provider_output_unusable", "The proposed visual direction does not preserve readable text contrast.", 422);
  if (Math.max(contrastRatio(palette.accent, palette.background), contrastRatio(palette.accent, palette.foreground)) < 3) palette.accent = palette.foreground;
  if (contrastRatio(palette.muted, palette.background) < 1.25) palette.muted = blendHex(palette.foreground, palette.background, .2);
  requireCondition(new Set(Object.values(palette)).size > 1 && palette.background !== palette.foreground, "provider_output_unusable", "The proposed palette does not contain usable contrast.", 422);
  return { policy: "semantic-direction-v1", palette, headingFont: wire.headingFont, spacing: wire.spacing, tone: wire.tone, grammar: wire.grammar, rationale: wire.rationale.trim() };
}

export function semanticArtDirection(direction: SemanticDirectionV1): FrozenArtDirection {
  return { direction: validateArtDirection({ policy: "art-direction-v1", palette: direction.palette, headingFont: direction.headingFont, composition: "editorial", spacing: direction.spacing, logoMaterialId: null, heroMaterialIds: [] }), originals: [] };
}

export function semanticDirectionHash(direction: SemanticDirectionV1) { return createHash("sha256").update(canonicalJson(direction)).digest("hex"); }

export function pendingDirectionProposal(direction: SemanticDirectionV1, snapshot: PaidInputSnapshot, operationId: string): PublicationDirectionProposal {
  return { direction, status: "pending", proposedBy: snapshot.generation!.origin, operationId, inputHash: createHash("sha256").update(canonicalJson(snapshot)).digest("hex") };
}
