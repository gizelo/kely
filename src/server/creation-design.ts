import { canonicalJson, type PaidInputSnapshot } from "./paid-input";
import { generationRequest, parseGeneratedReply, type GeneratedReply } from "./providers/generation";
import { buildTextRequest } from "./providers/text-envelope";
import { inheritSemanticDirection } from "./semantic-direction";
import { requireCondition } from "./errors";
import type { CreationInput } from "./creation-input";
import { z } from "zod";
import { validateArtDirection } from "./art-direction";
import type { FrozenArtDirection } from "../shared/art-direction";
import { planningFormat } from "./creation-format";

const planStyle = z.object({ palette: z.object({ background: z.string(), foreground: z.string(), accent: z.string(), muted: z.string() }).strict(), headingFont: z.enum(["sans", "serif", "unbounded"]), spacing: z.enum(["open", "compact"]) }).strict();

export function creationDesignRequest(snapshot: PaidInputSnapshot, policy: CreationInput["policy"]) {
  const legacy = generationRequest(snapshot);
  if (policy === "unified-creation-v1") return legacy;
  const format = legacy.text.format;
  requireCondition(format.type === "json_schema", "creation_snapshot_invalid", "Creation requires a strict design response.", 500);
  const schema = structuredClone(format.schema) as Record<string, any>;
  const plannedFormat = policy === "plan-first-v1" && snapshot.kind === "prepare" ? planningFormat(snapshot) : undefined;
  if (plannedFormat) {
    schema.properties.slideCount = { type: "string", enum: [...new Set([plannedFormat.current, plannedFormat.proposed].map(String))] };
    schema.required.push("slideCount");
    schema.properties.slides.maxItems = plannedFormat.proposed;
    schema.properties.plans.maxItems = plannedFormat.proposed;
  }
  const style = snapshot.generation?.scope?.kind === "style";
  const proposal = snapshot.semanticDirection?.mode === "propose";
  const planningStyle = policy === "plan-first-v1" && snapshot.kind === "prepare" && !proposal;
  if (planningStyle) {
    schema.properties.planStyle = { type: "object", additionalProperties: false, required: ["palette", "headingFont", "spacing"], properties: { palette: schema.properties.artPalette, headingFont: { type: "string", enum: ["sans", "serif", "unbounded"] }, spacing: { type: "string", enum: ["open", "compact"] } } };
    schema.required.push("planStyle");
  }
  if (!style) {
    delete schema.properties.artPalette;
    schema.required = schema.required.filter((key: string) => key !== "artPalette");
  }
  if (!proposal) {
    delete schema.properties.semanticDirection;
    schema.required = schema.required.filter((key: string) => key !== "semanticDirection");
  }
  const input = { ...JSON.parse(legacy.input), unifiedCreationPolicy: policy };
  if (plannedFormat) { input.planningFormat = plannedFormat; input.slideCount = plannedFormat.proposed; }
  if (proposal) {
    delete input.artDirection.palette;
    delete input.semanticDirection.inherited;
  }
  const instructions = legacy.instructions.split("\n").filter((line) => !line.startsWith("Return artPalette copied exactly") && (proposal || !line.startsWith("V9 semantic-direction contract:"))).map((line) => line.replace("brief/artPalette unchanged", "brief unchanged"));
  instructions.push(style
    ? "Unified creation v2: artPalette is the sole color response for this explicitly priced style revision. Change only the requested palette roles, preserving foreground/background contrast >=4.5:1 and all unquoted fields. Omit semanticDirection."
    : proposal
      ? "Unified creation v2: semanticDirection is the ONLY proposed visual palette. Choose it from the owner's idea and creative preferences; there is no second inherited palette to reproduce. Omit artPalette entirely. A question reply still uses the documented semantic inherit sentinel. This is a complete creation, not a separate direction-approval stage."
      : "Unified creation v2: the saved visual direction is inherited automatically. Omit artPalette and semanticDirection; do not reproduce their colors or sentinels. Change only the quoted copy or composition scope, or create the new post using its saved direction.");
  if (policy === "plan-first-v1") instructions.push("Plan-first contract: you are proposing one publication for explicit user approval, not generating images. Discuss only essential missing facts; otherwise return the complete proposed slide text, caption and coherent visual plans. In one compact reply ask at most three related questions, ordered as: missing factual claim, missing required original asset, then one high-impact creative choice. Audience, desired action, mood and composition may be professional proposals when the owner says You decide or has no preference; prices, dates, offer terms, results, product claims and real logos/interfaces may never be invented. When a selected original supports a slide, prefer an allowed original-based layout over generic decoration. A reference informs style only and must never be presented as the business's own asset. If no original is available, prefer a deliberate typography-led composition; do not imply a generated logo, interface, coin, rocket or brand symbol in the plan. The latest user comments are edits to the previous proposal and take priority over references and earlier preferences. Keep exact user-supplied text exact when requested. Do not claim that anything has already been designed or approved. Preserve the agreed publication size.");
  if (planningStyle) instructions.push("Plan-first planStyle overrides the inherited-style instruction above during planning only. Start from supplied artDirection.palette, headingFont and spacing; change those when the user's creative preferences request it, preserving readable contrast. Keep originals and logos exactly selected. Do not invent a new palette without a preference that calls for it. Questions must return the unchanged inherited planStyle. This affects this publication only, never saved Brand rules.");
  if (plannedFormat) instructions.push(`Planning format replaces every earlier slide-count instruction. For a proposal return slideCount=${plannedFormat.proposed} with exactly that many slides and plans. For questions return slideCount=${plannedFormat.current} and no slides/plans. ${plannedFormat.clarify ? "The owner has an ambiguous or unsupported count request: return questions asking for one exact count from 1 to 6; do not propose or resize." : "Only the server-permitted count may be used; a referenced slide number is not a count-change instruction."}`);
  return buildTextRequest({ model: legacy.model, input: canonicalJson(input), instructions: instructions.join("\n"), jsonSchema: { name: "kely_unified_design_v2", schema } });
}

export function parseCreationDesign(response: unknown, snapshot: PaidInputSnapshot, policy: CreationInput["policy"]): GeneratedReply & { plannedArtDirection?: FrozenArtDirection; slideCount?: number } {
  if (policy === "unified-creation-v1") return parseGeneratedReply(response, snapshot);
  const cloned = structuredClone(response) as { output?: { type?: string; content?: { type?: string; text?: string }[] }[] };
  const content = cloned.output?.filter((item) => item.type === "message").flatMap((item) => item.content ?? []);
  requireCondition(content?.length === 1 && content[0].type === "output_text" && content[0].text, "provider_output_unusable", "Creation requires one usable structured design reply.", 422);
  const raw = JSON.parse(content[0].text);
  let slideCount: number | undefined;
  if (policy === "plan-first-v1" && snapshot.kind === "prepare") {
    const format = planningFormat(snapshot);
    slideCount = Number(z.enum(["1", "2", "3", "4", "5", "6"]).parse(raw.slideCount));
    requireCondition(raw.kind === "questions" ? slideCount === format.current : !format.clarify && slideCount === format.proposed, "provider_output_unusable", "The proposal did not match the requested publication size.", 422);
    delete raw.slideCount;
    snapshot = structuredClone(snapshot);
    snapshot.publication.slideCount = slideCount;
  }
  let plannedArtDirection: FrozenArtDirection | undefined;
  if (policy === "plan-first-v1" && snapshot.kind === "prepare" && snapshot.semanticDirection?.mode !== "propose") {
    const accepted = planStyle.parse(raw.planStyle);
    delete raw.planStyle;
    const inherited = snapshot.publication.artDirection ?? snapshot.brand!.art!;
    plannedArtDirection = { ...structuredClone(inherited), direction: validateArtDirection({ ...inherited.direction, ...accepted }) };
    snapshot = structuredClone(snapshot);
    snapshot.publication.artDirection = plannedArtDirection;
    snapshot.brand!.art = plannedArtDirection;
  }
  if (snapshot.generation?.scope?.kind !== "style") {
    requireCondition(!Object.hasOwn(raw, "artPalette"), "provider_output_unusable", "The response included a second, unquoted palette.", 422);
    const target = snapshot.generation?.scope?.target;
    const art = (target ? snapshot.publication.slides[target - 1]?.artDirection : undefined) ?? snapshot.publication.artDirection ?? snapshot.brand!.art!;
    raw.artPalette = art.direction.palette;
  }
  if (snapshot.semanticDirection?.mode !== "propose") {
    requireCondition(!Object.hasOwn(raw, "semanticDirection"), "provider_output_unusable", "The saved visual direction cannot be replaced in this scope.", 422);
    raw.semanticDirection = inheritSemanticDirection;
  }
  content[0].text = JSON.stringify(raw);
  return { ...parseGeneratedReply(cloned, snapshot), ...(plannedArtDirection ? { plannedArtDirection } : {}), ...(slideCount ? { slideCount } : {}) };
}
