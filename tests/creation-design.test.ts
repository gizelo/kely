import assert from "node:assert/strict";
import { test } from "node:test";
import { creationDesignRequest, parseCreationDesign } from "../src/server/creation-design";
import { generationRequest, parseGeneratedReply } from "../src/server/providers/generation";
import { previewTransport } from "../src/server/providers/preview-transport";
import { defaultArtDirection } from "../src/server/brand-policy";
import { inputHash, type PaidInputSnapshot } from "../src/server/paid-input";
import { semanticTones, visualGrammars } from "../src/shared/semantic-direction";
import { planningFormat } from "../src/server/creation-format";

function input(mode: "propose" | "inherit"): PaidInputSnapshot {
  const art = { direction: defaultArtDirection(null), originals: [] };
  const brief = { audience: "", direction: "decide", requiredMaterialIds: [], noPhoto: false, blockingFacts: [], factResolution: "" };
  return { ownerId: "owner", quoteId: "00000000-0000-4000-a000-000000000001", capturedAt: "2026-09-13T00:00:00Z", schemaVersion: 12, kind: "prepare", instruction: "", generation: { origin: "ai_preview", model: "gpt-5.6-luna" }, business: { name: "Maple & Bean", context: "Fictional sample coffee shop", website: "", provenance: "user_statement", websiteFetched: false }, publication: { id: "00000000-0000-4000-a000-000000000002", idea: "Celebrate our seasonal maple latte. Forest green and cream. No prices or product photographs.", language: "en", platform: "instagram", slideCount: 1, designPolicy: "creative-intent-v9", brandBrief: brief, messages: [{ id: "00000000-0000-4000-a000-000000000003", role: "user", text: "Celebrate our seasonal maple latte. Forest green and cream. No prices or product photographs." }], caption: "", slides: [], ...(mode === "inherit" ? { artDirection: art } : {}) }, brand: { version: 1, rules: { audience: "", palette: null, headlines: "default" }, materials: [], brief, hash: "fixture", rendererPolicy: "art-direction-v1", art }, semanticDirection: { mode, allowedTones: [...semanticTones], allowedGrammars: [...visualGrammars], inherited: art.direction } } as unknown as PaidInputSnapshot;
}

const observedPalette = { accent: "#24513D", background: "#F5F0E6", foreground: "#17231C", muted: "#D8D0C0" };
const observedSemantic = { accent: "#24513D", background: "#F5F0E6", foreground: "#17231C", grammar: "soft-organic", headingFont: "sans", mode: "propose", muted: "#B9B19F", rationale: "Warm editorial softness, tactile spacing and gentle organic contrast echo the requested neighborhood café mood.", spacing: "open", tone: "warm" };
function wire(response: any) { return JSON.parse(response.output[0].content[0].text); }
function withWire(response: any, value: any) { const next = structuredClone(response); next.output[0].content[0].text = JSON.stringify(value); return next; }

test("unified v2 has one proposed palette while preserving the observed v1 failure and exact legacy request", async () => {
  const snapshot = input("propose");
  const legacy = generationRequest(snapshot);
  const legacyHash = inputHash(legacy);
  assert.deepEqual(creationDesignRequest(snapshot, "unified-creation-v1"), legacy);
  const response = await previewTransport.send(legacy, { attemptKey: "observed-palette-regression", signal: new AbortController().signal });
  const observed = { ...wire(response), artPalette: observedPalette, semanticDirection: observedSemantic };
  assert.throws(() => parseGeneratedReply(withWire(response, observed), snapshot), /changed an unquoted visual direction/);
  assert.throws(() => parseCreationDesign(withWire(response, observed), snapshot, "unified-creation-v1"), /changed an unquoted visual direction/);
  const request = creationDesignRequest(snapshot, "unified-creation-v2");
  assert.equal(request.text.format.type, "json_schema");
  const schema = (request.text.format as any).schema;
  assert.equal(Object.hasOwn(schema.properties, "artPalette"), false);
  assert.equal(schema.required.includes("artPalette"), false);
  assert.equal(Object.hasOwn(JSON.parse(request.input).artDirection, "palette"), false);
  const { artPalette: _obsolete, ...solePalette } = observed;
  const result = parseCreationDesign(withWire(response, solePalette), snapshot, "unified-creation-v2");
  assert.deepEqual(result.semanticDirection?.palette, { background: observedSemantic.background, foreground: observedSemantic.foreground, accent: observedSemantic.accent, muted: observedSemantic.muted });
  assert.equal(result.plans?.[0].scene?.version, 2);
  assert.throws(() => parseCreationDesign(withWire(response, observed), snapshot, "unified-creation-v2"), /second, unquoted palette/);
  assert.throws(() => parseCreationDesign(withWire(response, { ...solePalette, semanticDirection: { ...observedSemantic, foreground: observedSemantic.background } }), snapshot, "unified-creation-v2"), /readable text contrast/);
  assert.equal(inputHash(generationRequest(snapshot)), legacyHash);
});

test("inherited creation and style revision expose only their permitted color fields", async () => {
  const snapshot = input("inherit");
  const request = creationDesignRequest(snapshot, "unified-creation-v2");
  const properties = (request.text.format as any).schema.properties;
  assert.equal(Object.hasOwn(properties, "semanticDirection"), false);
  assert.equal(Object.hasOwn(properties, "artPalette"), false);
  const response = await previewTransport.send(request, { attemptKey: "inherit", signal: new AbortController().signal });
  const ready = parseCreationDesign(response, snapshot, "unified-creation-v2");
  assert.equal(ready.semanticDirection, undefined);
  assert.deepEqual(ready.artPalette, snapshot.brand!.art!.direction.palette);
  assert.throws(() => parseCreationDesign(withWire(response, { ...wire(response), semanticDirection: observedSemantic }), snapshot, "unified-creation-v2"), /cannot be replaced/);
  snapshot.kind = "revise"; snapshot.generation!.scope = { kind: "style", target: 1 }; snapshot.instruction = "Make the colors warmer on slide 1";
  snapshot.publication.slides = ready.slides.map((slide, index) => ({ ...slide, id: `slide-${index}`, index, creativePlan: ready.plans![index] }));
  snapshot.publication.proposedBrief = ready.brief;
  const styleRequest = creationDesignRequest(snapshot, "unified-creation-v2");
  assert.ok((styleRequest.text.format as any).schema.properties.artPalette);
  const styleResponse = await previewTransport.send(styleRequest, { attemptKey: "style", signal: new AbortController().signal });
  const style = parseCreationDesign(styleResponse, snapshot, "unified-creation-v2");
  assert.deepEqual(style.slides, []);
  assert.notDeepEqual(style.artPalette, snapshot.brand!.art!.direction.palette);
});

test("planning can change the publication style without changing standing brand rules", async () => {
  const snapshot = input("inherit"), baseline = structuredClone(snapshot.brand);
  const request = creationDesignRequest(snapshot, "plan-first-v1");
  const response = await previewTransport.send(request, { attemptKey: "plan-style", signal: new AbortController().signal });
  const value = wire(response);
  value.planStyle = { palette: { background: "#FFF8F1", foreground: "#17231C", accent: "#C85A3A", muted: "#B9B19F" }, headingFont: "serif", spacing: "open" };
  const result = parseCreationDesign(withWire(response, value), snapshot, "plan-first-v1");
  assert.ok("plannedArtDirection" in result);
  assert.equal(result.plannedArtDirection!.direction.headingFont, "serif");
  assert.deepEqual(result.plannedArtDirection!.direction.palette, value.planStyle.palette);
  assert.deepEqual(snapshot.brand, baseline);
  value.planStyle.palette.foreground = value.planStyle.palette.background;
  assert.throws(() => parseCreationDesign(withWire(response, value), snapshot, "plan-first-v1"));
});

test("plan size follows only an explicit latest owner request and rejects malformed or ambiguous resize", async () => {
  const snapshot = input("inherit");
  snapshot.publication.creation = { status: "plan_ready", phase: "plan", credits: 30, questions: [], canReply: true, plan: { version: 1, hash: "saved", approved: false, visualDirection: "Editorial" } };
  const comment = { id: "comment", role: "user" as const, text: "Make it four slides.", createdAt: "2026-09-13T00:00:00Z" };
  snapshot.publication.messages.push(comment);
  const request = creationDesignRequest(snapshot, "plan-first-v1");
  const response = await previewTransport.send(request, { attemptKey: "resize", signal: new AbortController().signal });
  const output = parseCreationDesign(response, snapshot, "plan-first-v1");
  assert.equal(output.slideCount, 4);
  assert.equal(output.slides.length, 4);
  assert.equal(snapshot.publication.slideCount, 1);
  const malformed = wire(response);
  malformed.slides.pop();
  assert.throws(() => parseCreationDesign(withWire(response, malformed), snapshot, "plan-first-v1"));
  comment.text = "Rewrite slide 4 with a warmer tone.";
  assert.deepEqual(planningFormat(snapshot), { current: 1, proposed: 1, clarify: false });
  assert.throws(() => parseCreationDesign(response, snapshot, "plan-first-v1"));
  comment.text = "Make it 4 slides or 6 slides.";
  assert.equal(planningFormat(snapshot).clarify, true);
  const unclear = await previewTransport.send(creationDesignRequest(snapshot, "plan-first-v1"), { attemptKey: "unclear-size", signal: new AbortController().signal });
  assert.equal(parseCreationDesign(unclear, snapshot, "plan-first-v1").kind, "questions");
  comment.text = "Make it 8 slides.";
  assert.equal(planningFormat(snapshot).clarify, true);
  comment.text = "Сделай четыре слайда.";
  assert.equal(planningFormat(snapshot).proposed, 4);
  comment.text = 'Make the headline "4 slides for your business".';
  assert.equal(planningFormat(snapshot).proposed, 1);
});
