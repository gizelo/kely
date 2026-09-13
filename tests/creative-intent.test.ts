import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import sharp from "sharp";
import type { PaidInputSnapshot } from "../src/server/paid-input";
import type { CreativePlan } from "../src/shared/creative-intent";
import { brandReadiness, defaultArtDirection } from "../src/server/brand-policy";
import { generationRequest, parseGeneratedReply } from "../src/server/providers/generation";
import { validateCreativePlan, validateProposedBrief } from "../src/server/creative-intent";
import { composeCreativeSlide } from "../src/server/creative-renderer";
import { LayoutOverflow } from "../src/server/layout";
import { canonicalizeBriefV2 } from "../src/server/creative-contract-v2";
import { decodePlansV3, layoutChoicesV3 } from "../src/server/creative-contract-v3";
import { sourceCatalogueV4 } from "../src/server/source-catalogue-v4";
import { createDesignScene, validateDesignScene } from "../src/server/design-scene";

function snapshot(schemaVersion: PaidInputSnapshot["schemaVersion"]): PaidInputSnapshot {
  const art = { direction: defaultArtDirection(null), originals: [] };
  return { ownerId: "owner", quoteId: "quote", capturedAt: "2026-09-11T00:00:00Z", kind: "prepare", instruction: "", generation: { origin: "ai_preview", model: "gpt-5.6-luna" }, business: { name: "Workshop", context: "Local makers", website: "", provenance: "user_statement", websiteFetched: false }, publication: { idea: "Meet our workshop", language: "en", platform: "instagram", slideCount: 1, messages: [{ id: "00000000-0000-4000-a000-000000000001", role: "user", text: "Meet our workshop" }], caption: "", slides: [], artDirection: art }, brand: { version: 1, rules: { audience: "Local makers", palette: null, headlines: "default" }, materials: [], brief: { audience: "Local makers", direction: "decide", requiredMaterialIds: [], noPhoto: false, blockingFacts: [], factResolution: "" }, hash: "test", rendererPolicy: "art-direction-v1", art }, schemaVersion } as unknown as PaidInputSnapshot;
}
const plan: CreativePlan = { purpose: "hook", recipe: "type-poster", materialId: "", heading: "large", background: "background", alignment: "left", rationale: "Lead with the key idea." };

test("landscape editorial artwork occupies its full slot without cropping or changing legacy layout", async () => {
  const art = { direction: defaultArtDirection(null), originals: [] };
  const artwork = await sharp({ create: { width: 1536, height: 1024, channels: 3, background: "#ED1484" } }).png().toBuffer();
  const rendered = await composeCreativeSlide({ art, plan, title: "Coffee", body: "A warm welcome", index: 0, slideCount: 1, artworkLayout: "landscape-editorial-v1" }, [], artwork);
  const pixel = await sharp(rendered.png).extract({ left: 72, top: 374, width: 936, height: 624 }).raw().toBuffer();
  assert.ok(pixel.every((value, index) => value === [237, 20, 132, 255][index % 4]));
});

test("creative preparation preserves all historical request policies and requires sourced facts plus exact plans", () => {
  const hashes = ["b342ee9cac3936ceb41ce0943dced502014493e83697d5a598fa37ee6280c7a5", "7a99efa2742be4e8e8aa3695c90ee42b7500373eee00d1cfecc6fa366201ea7a", "5eeedd74a266ab7de42a1a2341a322b467b47fd018c2a60f52f1eb0cb9a66f28"];
  for (const version of [1, 2, 3] as const) assert.equal(createHash("sha256").update(JSON.stringify(generationRequest(snapshot(version)))).digest("hex"), hashes[version - 1]);
  const input = snapshot(4);
  input.publication.designPolicy = "creative-intent-v1";
  const request = generationRequest(input);
  assert.equal(createHash("sha256").update(JSON.stringify(request)).digest("hex"), "22945d686875888194998d5277a8e6bb8caefdfea602d7cdf3eefc38ee795f45");
  const historicalV2 = snapshot(5);
  historicalV2.publication.designPolicy = "creative-intent-v2";
  assert.equal(createHash("sha256").update(JSON.stringify(generationRequest(historicalV2))).digest("hex"), "0ac5db59b54485bb312f0424dd7a80b1d05d59ebea33fb0ee8002686d0563f30");
  const historicalV3 = snapshot(6);
  historicalV3.publication.designPolicy = "creative-intent-v3";
  assert.equal(createHash("sha256").update(JSON.stringify(generationRequest(historicalV3))).digest("hex"), "3f12004cccd9510e5820b96e20ff45c9b462e6776198459ad71d53fd6fdc16be");
  const historicalV4 = snapshot(7);
  historicalV4.publication.designPolicy = "creative-intent-v4";
  assert.equal(createHash("sha256").update(JSON.stringify(generationRequest(historicalV4))).digest("hex"), "b42b8f3b56aa0a9c277f80d7cfd778cfe38a3b8ee6f0bd03175856bef7742e1c");
  assert.equal(JSON.parse(request.input).creativePolicy, "creative-intent-v1");
  const proposed = { value: "Interested local makers", basis: "proposed" as const, sourceId: "", evidence: "" };
  const brief = { audience: proposed, desiredAction: { ...proposed, value: "Learn about the workshop" }, facts: [{ value: "Local makers", basis: "business" as const, sourceId: "context", evidence: "Local makers" }], requiredFacts: [] };
  const output = { kind: "proposal", message: "A proposed brief and draft.", questions: [], uncertainFacts: [], caption: "Meet the workshop.", slides: [{ title: "Meet the workshop", body: "A place for local makers." }], palette: "indigo", artPalette: input.brand!.art!.direction.palette, preferences: [], brief, plans: [plan] };
  const response = () => ({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }] });
  assert.equal(parseGeneratedReply(response(), input).plans?.[0].recipe, "type-poster");
  assert.throws(() => validateProposedBrief({ ...brief, facts: [proposed] }, input), { code: "brief_evidence_invalid" });
  assert.throws(() => validateProposedBrief({ ...brief, facts: [{ value: "All customers receive a guaranteed 90% discount", basis: "user", sourceId: input.publication.messages[0].id, evidence: "Meet our workshop" }] }, input), { code: "brief_evidence_invalid" });
  assert.throws(() => validateProposedBrief({ ...brief, facts: [{ ...brief.facts[0], sourceId: "website" }] }, input), { code: "brief_evidence_invalid" });
  output.plans = [];
  assert.throws(() => parseGeneratedReply(response(), input), { code: "provider_output_unusable" });
});

test("v2 restores only one supported source span and encodes valid image/composition pairs in its schema", () => {
  const input = snapshot(5);
  input.publication.designPolicy = "creative-intent-v2";
  input.publication.messages[0].text = "Reach people following our product development and invite people to follow our progress.";
  const id = "00000000-0000-4000-a000-000000000002";
  input.brand!.art!.direction.heroMaterialIds = [id];
  input.brand!.art!.originals = [{ id, version: 1, hash: "a".repeat(64), width: 800, height: 600 }];
  const brief = {
    audience: { value: "People following our product development", basis: "user", sourceId: input.publication.messages[0].id, evidence: "People following our product development" },
    desiredAction: { value: "invite people to follow our progress", basis: "user", sourceId: input.publication.messages[0].id, evidence: "invite people to follow our progress" },
    facts: [{ value: "Local makers", basis: "business", sourceId: "business.context", evidence: "Local makers" }], requiredFacts: [],
  };
  const normalized = canonicalizeBriefV2(brief, input);
  assert.equal(normalized.audience.value, "people following our product development");
  assert.equal(normalized.audience.evidence, normalized.audience.value);
  assert.equal(normalized.facts[0].sourceId, "context");
  assert.throws(() => canonicalizeBriefV2({ ...brief, facts: [{ ...brief.facts[0], value: "All customers receive a guaranteed 90% discount" }] }, input), { code: "brief_evidence_invalid" });
  assert.throws(() => canonicalizeBriefV2({ ...brief, facts: [{ ...brief.facts[0], sourceId: "business.website" }] }, input), { code: "brief_evidence_invalid" });
  const repeated = structuredClone(input);
  repeated.publication.messages[0].text += " People following our product development.";
  assert.throws(() => canonicalizeBriefV2(brief, repeated), { code: "brief_evidence_invalid" });
  const request = generationRequest(input);
  const format = request.text.format;
  assert.equal(format.type, "json_schema");
  const properties = (format as { schema: any }).schema.properties.plans.items.properties;
  assert.equal(Object.hasOwn(properties, "materialId"), false);
  assert.equal(Object.hasOwn(properties, "recipe"), false);
  assert.ok(properties.layoutChoice.enum.includes(`graphic-stage:${id}`));
  assert.equal(properties.layoutChoice.enum.includes(`closing:${id}`), false);
  const { recipe: _recipe, materialId: _material, ...metadata } = plan;
  const output = { kind: "proposal", message: "Proposed brief and content.", questions: [], uncertainFacts: [], caption: "Meet our workshop.", slides: [{ title: "Meet the workshop", body: "A place for local makers." }], palette: "indigo", artPalette: input.brand!.art!.direction.palette, preferences: [], brief, plans: [{ ...metadata, purpose: "closing", layoutChoice: `graphic-stage:${id}` }] };
  const response = () => ({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }] });
  assert.equal(parseGeneratedReply(response(), input).brief?.audience.value, normalized.audience.value);
  assert.equal(parseGeneratedReply(response(), input).plans?.[0].materialId, id);
  output.plans[0].layoutChoice = `closing:${id}`;
  assert.throws(() => parseGeneratedReply(response(), input), { code: "creative_plan_invalid" });
  input.kind = "revise";
  input.generation!.scope = { kind: "plan", target: 1 };
  input.publication.proposedBrief = normalized;
  input.business.context = "Newer profile context; the approved brief remains pinned.";
  const { brief: _brief, ...revision } = output;
  revision.kind = "revision"; revision.slides = []; revision.caption = ""; revision.plans[0].layoutChoice = "closing";
  const revisionResponse = { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(revision) }] }] };
  assert.deepEqual(parseGeneratedReply(revisionResponse, input).brief, normalized);
  assert.throws(() => parseGeneratedReply(response(), input), { code: "provider_output_unusable" });
});

test("a coherent sequence changes actual hierarchy and image placement without clipping or substituting originals", async () => {
  const id = "00000000-0000-4000-a000-000000000001";
  const bytes = await sharp({ create: { width: 800, height: 600, channels: 4, background: "#294DFF" } }).png().toBuffer();
  const hash = createHash("sha256").update(bytes).digest("hex");
  const art = { direction: { ...defaultArtDirection(null), heroMaterialIds: [id] }, originals: [{ id, version: 1, hash, width: 800, height: 600 }] };
  const originals = [{ id, version: 1, hash, bytes }];
  const input = { art, title: "An idea worth sharing", body: "Every approved word stays visible.", index: 0, slideCount: 3 };
  const cover = await composeCreativeSlide({ ...input, plan: { ...plan, recipe: "graphic-stage", materialId: id } }, originals);
  const proof = await composeCreativeSlide({ ...input, index: 1, plan: { ...plan, purpose: "proof", recipe: "image-evidence", materialId: id, heading: "medium" } }, originals);
  const closing = await composeCreativeSlide({ ...input, index: 2, plan: { ...plan, purpose: "closing", recipe: "closing", background: "foreground", alignment: "center" } }, originals);
  assert.notDeepEqual(cover.placements[0].bounds, proof.placements[0].bounds);
  assert.equal(closing.placements.length, 0);
  assert.notDeepEqual(cover.text[0].bounds, closing.text[0].bounds);
  assert.ok(cover.text[0].font.sizePx > proof.text[0].font.sizePx);
  for (const output of [cover, proof, closing]) assert.deepEqual(output.text.map((item) => item.approvedText), [input.title, input.body]);
  assert.deepEqual(await sharp(closing.png).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer(), Buffer.from([23, 24, 28, 255]));
  assert.throws(() => validateCreativePlan({ ...plan, recipe: "graphic-stage", materialId: "00000000-0000-4000-a000-000000000099" }, art), { code: "creative_plan_invalid" });
  assert.throws(() => validateCreativePlan({ ...plan, recipe: "image-evidence", materialId: id }, { ...art, originals: [{ ...art.originals[0], width: 4000, height: 400 }] }), { code: "original_resolution_insufficient" });
  await assert.rejects(composeCreativeSlide({ ...input, body: "Approved text must not be truncated. ".repeat(200), plan }, originals), LayoutOverflow);
});

test("v3 keeps detailed interfaces large without excluding wide graphics and derives truthful planned summaries", async () => {
  const input = snapshot(6);
  input.publication.designPolicy = "creative-intent-v3";
  const screenshot = "00000000-0000-4000-a000-000000000002", graphic = "00000000-0000-4000-a000-000000000003";
  const bytes = await sharp({ create: { width: 1600, height: 900, channels: 4, background: "#254BFF" } }).png().toBuffer();
  const hash = createHash("sha256").update(bytes).digest("hex");
  input.brand!.art!.direction.heroMaterialIds = [screenshot, graphic];
  input.brand!.art!.originals = [screenshot, graphic].map((id) => ({ id, version: 1, hash, width: 1600, height: 900 }));
  input.brand!.materials = [{ id: screenshot, label: "Desktop interface" }, { id: graphic, label: "Glass cubes" }] as NonNullable<PaidInputSnapshot["brand"]>["materials"];
  input.publication.sourceAnalysis = { id: "analysis", origin: "openai", summary: "Visual guidance", limitations: [], observations: [
    { materialId: screenshot, purpose: "screenshot", confidence: "high", evidence: "Detailed interface" },
    { materialId: graphic, purpose: "graphic", confidence: "high", evidence: "Glass decoration" },
  ] };
  const choices = layoutChoicesV3(input);
  assert.ok(choices[`image-evidence:${screenshot}`]);
  assert.equal(choices[`split-proof:${screenshot}`], undefined);
  assert.equal(choices[`graphic-stage:${screenshot}`], undefined);
  assert.ok(choices[`graphic-stage:${graphic}`]);
  assert.ok(choices[`split-proof:${graphic}`]);
  const unknown = structuredClone(input); delete unknown.publication.sourceAnalysis;
  assert.ok(layoutChoicesV3(unknown)[`split-proof:${screenshot}`]);
  const { recipe: _recipe, materialId: _material, rationale: _rationale, ...metadata } = plan;
  const wire = { ...metadata, layoutChoice: `image-evidence:${screenshot}` };
  assert.throws(() => decodePlansV3([{ ...wire, layoutChoice: `split-proof:${screenshot}` }], input), { code: "creative_plan_invalid" });
  const format = generationRequest(input).text.format as { schema: any };
  assert.equal(Object.hasOwn(format.schema.properties, "message"), false);
  assert.equal(Object.hasOwn(format.schema.properties.plans.items.properties, "rationale"), false);
  assert.equal(format.schema.properties.plans.items.properties.layoutChoice.enum.includes(`split-proof:${screenshot}`), false);
  const proposed = { value: "People interested in the product", basis: "proposed", sourceId: "", evidence: "" };
  const output = { kind: "proposal", questions: [], uncertainFacts: [], caption: "A look at the product.", slides: [{ title: "A closer look", body: "The selected interface stays large." }], palette: "indigo", artPalette: input.brand!.art!.direction.palette, preferences: [], brief: { audience: proposed, desiredAction: proposed, facts: [], requiredFacts: [] }, plans: [wire] };
  const response = () => ({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }] });
  const result = parseGeneratedReply(response(), input);
  assert.match(result.message, /Slide 1: Desktop interface/);
  assert.doesNotMatch(result.message, /Glass cubes/);
  assert.match(result.message, /not been rendered/);
  assert.equal(result.plans![0].rationale, "Selected original in a full-width evidence area.");
  const rendered = await composeCreativeSlide({ art: input.brand!.art!, plan: result.plans![0], ...output.slides[0], index: 0, slideCount: 1 }, [screenshot, graphic].map((id) => ({ id, version: 1, hash, bytes })));
  assert.equal(rendered.placements[0].bounds.width, 936);
  assert.ok(rendered.placements[0].bounds.height >= 526);
  const portrait = structuredClone(input);
  Object.assign(portrait.brand!.art!.originals[0], { width: 600, height: 1200 });
  assert.ok(layoutChoicesV3(portrait)[`split-proof:${screenshot}`]);
  Object.assign(portrait.brand!.art!.originals[0], { width: 200, height: 400 });
  assert.equal(layoutChoicesV3(portrait)[`split-proof:${screenshot}`], undefined);
});

test("v4 reconstructs source quotations and safely omits optional invalid memory without weakening content", () => {
  const input = snapshot(7);
  input.publication.designPolicy = "creative-intent-v4";
  input.publication.messages[0].text = "Reach people following our product development. Always use shorter headlines; for this post only use a friendly voice.";
  input.publication.messages.push({ id: "00000000-0000-4000-a000-000000000002", role: "assistant", text: "Girex is developing in public." } as typeof input.publication.messages[number]);
  const catalogue = sourceCatalogueV4(input);
  const audience = catalogue.entries.find((entry) => entry.text.startsWith("Reach people"))!;
  const standing = catalogue.entries.find((entry) => entry.text.startsWith("Always"))!;
  const local = catalogue.entries.find((entry) => entry.text.startsWith("for this post"))!;
  const business = catalogue.entries.find((entry) => entry.basis === "business")!;
  assert.ok(audience && standing && local && business);
  assert.equal(catalogue.entries.some((entry) => entry.text.includes("developing in public")), false);
  assert.equal(input.publication.messages[0].text.slice(audience.start, audience.end), audience.text);
  assert.deepEqual(sourceCatalogueV4({ ...input, quoteId: "different-quote" }), catalogue);
  const format = generationRequest(input).text.format as { schema: any };
  assert.deepEqual(Object.keys(format.schema.properties.brief.properties.audience.properties), ["sourceRef", "proposal"]);
  assert.ok(format.schema.properties.brief.properties.facts.items.enum.includes(audience.id));
  assert.deepEqual(format.schema.properties.preferences.properties.headlines.items.properties.value.enum, ["default", "shorter"]);
  assert.equal(format.schema.properties.preferences.properties.voice.items.properties.sourceRef.enum.includes(business.id), false);
  const output = { kind: "proposal", questions: [], uncertainFacts: [], caption: "Follow our progress.", slides: [{ title: "See our progress", body: "A view of our product." }], palette: "indigo", artPalette: input.brand!.art!.direction.palette,
    preferences: { audience: [], voice: [{ sourceRef: local.id, value: "friendly", scope: "durable" }], headlines: [{ sourceRef: standing.id, value: "shorter", scope: "durable" }, { sourceRef: standing.id, value: "specific and concise copy", scope: "durable" }] },
    brief: { audience: { sourceRef: audience.id, proposal: "People following Girex's product development" }, desiredAction: { sourceRef: "proposed", proposal: "Follow the product's progress" }, facts: [audience.id], requiredFacts: [] },
    plans: [{ purpose: "hook", heading: "large", background: "background", alignment: "left", layoutChoice: "type-poster" }],
  };
  const response = () => ({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }] });
  const result = parseGeneratedReply(response(), input);
  assert.equal(result.brief!.audience.value, audience.text);
  assert.equal(result.brief!.audience.evidence, audience.text);
  assert.equal(result.brief!.desiredAction.basis, "proposed");
  assert.equal(result.brief!.facts[0].value, audience.text);
  assert.deepEqual(result.preferences?.map(({ field, value, scope }) => ({ field, value, scope })), [{ field: "voice", value: "friendly", scope: "local" }, { field: "headlines", value: "shorter", scope: "ambiguous" }]);
  assert.match(result.message, /Some memory suggestions were not saved/);
  output.brief.facts = ["s_not_in_this_snapshot"];
  assert.throws(() => parseGeneratedReply(response(), input), { code: "brief_evidence_invalid" });
  output.brief.facts = [audience.id]; output.plans = [];
  assert.throws(() => parseGeneratedReply(response(), input), { code: "provider_output_unusable" });
  output.plans = [{ purpose: "hook", heading: "large", background: "background", alignment: "left", layoutChoice: "type-poster" }];
  input.kind = "revise"; input.generation!.scope = { kind: "plan", target: 1 }; input.publication.proposedBrief = result.brief;
  input.business.context = "Changed profile context.";
  const { brief: _brief, ...revision } = output;
  revision.kind = "revision"; revision.slides = []; revision.caption = "";
  const revised = parseGeneratedReply({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(revision) }] }] }, input);
  assert.deepEqual(revised.brief, result.brief); assert.equal(revised.preferences?.length, 0);
  const oversized = snapshot(7);
  oversized.publication.messages[0].text = "Not a claim without its ending ".repeat(30);
  oversized.brand!.brief.blockingFacts = ["Confirm the launch date before publishing."];
  const omitted = sourceCatalogueV4(oversized);
  assert.equal(omitted.omittedSpans, 1);
  assert.equal(omitted.entries.some((entry) => entry.basis === "user"), false);
  assert.ok(brandReadiness(oversized.publication, oversized.brand!).blockers.some((item) => item.code === "facts_missing"));
  oversized.publication.messages[0].text = "We do not promise:\na guaranteed discount.";
  assert.equal(sourceCatalogueV4(oversized).entries[0].text, oversized.publication.messages[0].text);
});

test("v5 bounds response cardinality and rejects unsupported public-development copy", () => {
  const input = snapshot(8);
  input.publication.designPolicy = "creative-intent-v5";
  input.publication.slideCount = 3;
  input.publication.messages[0].text = "Show our map beside offer cards and invite people to follow our progress.";
  const format = generationRequest(input).text.format as { schema: any };
  assert.equal(format.schema.properties.slides.maxItems, 3);
  assert.equal(format.schema.properties.plans.maxItems, 3);
  assert.equal(format.schema.properties.questions.maxItems, 3);
  assert.ok(generationRequest(input).instructions.length < 5_000);
  const catalogue = sourceCatalogueV4(input);
  const idea = catalogue.entries.find((entry) => entry.basis === "user")!;
  const wire = { purpose: "hook", heading: "large", background: "background", alignment: "left", layoutChoice: "type-poster" };
  const output = { kind: "proposal", questions: [], uncertainFacts: [], caption: "Follow our progress.", slides: Array.from({ length: 3 }, (_, index) => ({ title: `Slide ${index + 1}`, body: index === 2 ? "Girex is developing in public." : "A map beside offer cards." })), palette: "indigo", artPalette: input.brand!.art!.direction.palette,
    preferences: { audience: [], voice: [], headlines: [] }, brief: { audience: { sourceRef: "proposed", proposal: "People following the product" }, desiredAction: { sourceRef: idea.id, proposal: "" }, facts: [idea.id], requiredFacts: [] }, plans: Array.from({ length: 3 }, (_, index) => ({ ...wire, purpose: index === 2 ? "closing" : index === 0 ? "hook" : "explain" })) };
  const response = () => ({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }] });
  assert.throws(() => parseGeneratedReply(response(), input), { code: "provider_output_unusable" });
  output.slides[2].body = "Follow our progress.";
  assert.equal(parseGeneratedReply(response(), input).slides.length, 3);
  output.slides.push(...structuredClone(output.slides));
  assert.throws(() => parseGeneratedReply(response(), input), { code: "provider_output_unusable" });
  for (const source of ["We are not developing in public.", "Are we developing in public?", "We stopped developing in public."]) {
    input.publication.messages[0].text = source;
    output.slides = Array.from({ length: 3 }, (_, index) => ({ title: `Slide ${index + 1}`, body: index === 2 ? "We are developing in public." : "A product update." }));
    output.brief.facts = [];
    output.brief.desiredAction = { sourceRef: "proposed", proposal: "Follow progress" };
    assert.throws(() => parseGeneratedReply(response(), input), { code: "provider_output_unusable" });
  }
  input.kind = "revise";
  input.publication.proposedBrief = { audience: { value: "Product followers", basis: "proposed", sourceId: "", evidence: "" }, desiredAction: { value: "Follow progress", basis: "proposed", sourceId: "", evidence: "" }, facts: [], requiredFacts: [] };
  for (const [kind, slides, plans] of [["copy", 1, 0], ["plan", 0, 1], ["style", 0, 0], ["compose", 0, 0]] as const) {
    input.generation!.scope = { kind, target: 1 };
    const revisionFormat = generationRequest(input).text.format as { schema: any };
    assert.equal(revisionFormat.schema.properties.slides.maxItems, slides);
    assert.equal(revisionFormat.schema.properties.plans.maxItems, plans);
    assert.equal(revisionFormat.schema.properties.questions.maxItems, 0);
    assert.equal(Object.hasOwn(revisionFormat.schema.properties, "brief"), false);
  }
});

test("v6 proposes memory only from exact quoted revision evidence", () => {
  const input = snapshot(9);
  input.publication.designPolicy = "creative-intent-v6";
  input.kind = "revise";
  input.quoteId = "00000000-0000-4000-a000-000000000099";
  input.instruction = "From now on, keep our voice calm and direct. Rewrite slide 1.";
  input.generation!.scope = { kind: "copy", target: 1 };
  input.publication.proposedBrief = { audience: { value: "Workshop customers", basis: "proposed", sourceId: "", evidence: "" }, desiredAction: { value: "Learn more", basis: "proposed", sourceId: "", evidence: "" }, facts: [], requiredFacts: [] };
  const request = generationRequest(input);
  const catalogue = JSON.parse(request.input as string).sourceCatalogue;
  const revision = catalogue.entries.find((entry: { sourceId: string }) => entry.sourceId === input.quoteId);
  assert.ok(revision);
  const format = request.text.format as { schema: any };
  assert.equal(format.schema.properties.preferences.properties.voice.maxItems, 3);
  const output: any = { kind: "revision", questions: [], uncertainFacts: [], caption: "", slides: [{ title: "A clearer update", body: "The workshop, explained directly." }], palette: "indigo", artPalette: input.brand!.art!.direction.palette, plans: [], preferences: { audience: [], voice: [{ sourceRef: revision.id, value: "calm and direct", scope: "durable" }], headlines: [] } };
  const response = () => ({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }] });
  const parsed = parseGeneratedReply(response(), input);
  assert.deepEqual(parsed.preferences?.map(({ field, value, scope, messageId, evidence }) => ({ field, value, scope, messageId, evidence })), [{ field: "voice", value: "calm and direct", scope: "durable", messageId: input.quoteId, evidence: "From now on, keep our voice calm and direct." }]);
  output.preferences.voice[0].sourceRef = catalogue.entries.find((entry: { sourceId: string; basis: string }) => entry.sourceId !== input.quoteId && entry.basis === "user")?.id ?? "none";
  assert.deepEqual(parseGeneratedReply(response(), input).preferences, []);
  output.preferences = { audience: [{ sourceRef: revision.id, value: "Unrelated audience", scope: "ambiguous" }], voice: [], headlines: [{ sourceRef: revision.id, value: "default", scope: "ambiguous" }] };
  const bounded = parseGeneratedReply(response(), input);
  assert.deepEqual(bounded.preferences, []);
  assert.match(bounded.message, /memory suggestions were not saved/i);
});

test("v7 rejects an original whose subject is not identified by its slide copy", () => {
  const input = snapshot(10);
  input.publication.designPolicy = "creative-intent-v7";
  const materialId = "00000000-0000-4000-a000-000000000077";
  input.brand!.materials = [{ id: materialId, label: "Desktop interface", role: "original", kind: "image", sourceUrl: null, version: 1, contentHash: "hash", width: 1200, height: 700, bytes: 100, createdAt: "2026-09-11T00:00:00Z" }];
  input.brand!.art!.originals = [{ id: materialId, version: 1, hash: "hash", width: 1200, height: 700 }];
  input.brand!.art!.direction.heroMaterialIds = [materialId];
  input.publication.slideCount = 1;
  const catalogue = JSON.parse(generationRequest(input).input as string).sourceCatalogue;
  const source = catalogue.entries.find((entry: { basis: string }) => entry.basis === "user");
  const output: any = { kind: "proposal", questions: [], uncertainFacts: [], caption: "See the interface.", slides: [{ title: "The glass cube motif", body: "A recognizable visual cue." }], palette: "indigo", artPalette: input.brand!.art!.direction.palette, preferences: { audience: [], voice: [], headlines: [] }, brief: { audience: { sourceRef: "proposed", proposal: "Workshop customers" }, desiredAction: { sourceRef: source.id, proposal: "" }, facts: [], requiredFacts: [] }, plans: [{ purpose: "proof", heading: "medium", background: "background", alignment: "left", layoutChoice: `image-evidence:${materialId}` }] };
  const response = () => ({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }] });
  assert.throws(() => parseGeneratedReply(response(), input), { code: "provider_output_unusable" });
  output.slides[0] = { title: "Inside the desktop interface", body: "A closer view of the map-based screen." };
  assert.equal(parseGeneratedReply(response(), input).plans?.[0].materialId, materialId);
  output.brief.desiredAction = { sourceRef: "proposed", proposal: "Follow for product design updates" };
  output.plans[0] = { purpose: "closing", heading: "large", background: "foreground", alignment: "center", layoutChoice: "closing" };
  assert.throws(() => parseGeneratedReply(response(), input), { code: "provider_output_unusable" });
  output.slides[0] = { title: "Follow for more", body: "Follow Girex for product design updates." };
  assert.equal(parseGeneratedReply(response(), input).plans?.[0].purpose, "closing");
});

test("v8 produces bounded purpose-distinct deterministic scenes without materials", async () => {
  const input = snapshot(11);
  input.publication.designPolicy = "creative-intent-v8";
  const purposes = ["hook", "proof", "closing"] as const;
  const plans = purposes.map((purpose, index) => {
    const base = { ...plan, purpose, recipe: purpose === "closing" ? "closing" as const : "type-poster" as const, background: purpose === "closing" ? "foreground" as const : "background" as const, alignment: purpose === "closing" ? "center" as const : "left" as const };
    return { ...base, scene: createDesignScene(base, input.brand!.art!, "accepted-seed", index) };
  });
  assert.deepEqual(plans.map((item) => item.scene!.composition), ["editorial-offset", "signal-grid", "action-frame"]);
  const rendered = await Promise.all(plans.map((item, index) => composeCreativeSlide({ art: input.brand!.art!, plan: item, title: `Clear idea ${index + 1}`, body: "Every approved word remains visible.", index, slideCount: 3 }, [])));
  const replay = await composeCreativeSlide({ art: input.brand!.art!, plan: plans[0], title: "Clear idea 1", body: "Every approved word remains visible.", index: 0, slideCount: 3 }, []);
  assert.deepEqual(replay.png, rendered[0].png);
  assert.deepEqual(rendered.map((item) => item.text.map((text) => text.approvedText)), purposes.map((_, index) => [`Clear idea ${index + 1}`, "Every approved word remains visible."]));
  const different = createDesignScene(plan, input.brand!.art!, "different-seed", 0);
  assert.notDeepEqual(different.primitives, plans[0].scene!.primitives);
  const hostile = structuredClone(plans[0].scene!);
  hostile.titleZone = { x: 900, y: 0, width: 200, height: 100 };
  assert.throws(() => validateDesignScene(hostile, plans[0], input.brand!.art!), { code: "design_scene_out_of_bounds" });
  hostile.titleZone = { ...hostile.bodyZone };
  assert.throws(() => validateDesignScene(hostile, plans[0], input.brand!.art!), { code: "design_scene_overlap" });
  hostile.titleZone = { x: 0, y: 100, width: 300, height: 200 };
  assert.throws(() => validateDesignScene(hostile, plans[0], input.brand!.art!), { code: "design_scene_safe_area" });
  const unreadable = structuredClone(plans[0].scene!);
  unreadable.primitives = [{ kind: "rect", zone: { ...unreadable.titleZone }, color: "foreground", opacity: 1, radius: 0, rotation: 0 }, unreadable.primitives[0]];
  assert.throws(() => validateDesignScene(unreadable, plans[0], input.brand!.art!), { code: "design_scene_contrast" });
  const excessive = { ...plans[0].scene!, primitives: Array.from({ length: 11 }, () => plans[0].scene!.primitives[0]) };
  assert.throws(() => validateDesignScene(excessive, plans[0], input.brand!.art!));

  const originalId = "00000000-0000-4000-a000-000000000088";
  const squareBytes = await sharp({ create: { width: 1280, height: 1280, channels: 4, background: "#254BFF" } }).png().toBuffer();
  const squareHash = createHash("sha256").update(squareBytes).digest("hex");
  const sourceRichArt = { direction: { ...input.brand!.art!.direction, heroMaterialIds: [originalId] }, originals: [{ id: originalId, version: 1, hash: squareHash, width: 1280, height: 1280 }] };
  const evidence = { ...plan, purpose: "proof" as const, recipe: "image-evidence" as const, materialId: originalId, heading: "medium" as const };
  const evidenceScene = createDesignScene(evidence, sourceRichArt, "accepted-square-seed", 1);
  const acceptedNarrowerScene = { ...evidenceScene, materialZone: { ...evidenceScene.materialZone!, y: 485, height: 390 } };
  const square = await composeCreativeSlide({ art: sourceRichArt, plan: { ...evidence, scene: acceptedNarrowerScene }, title: "A recognizable identity", body: "The selected original remains readable.", index: 1, slideCount: 3 }, [{ id: originalId, version: 1, hash: squareHash, bytes: squareBytes }]);
  assert.ok(square.placements[0].bounds.width >= 480 && square.placements[0].bounds.height >= 480);

  const boundaryBytes = await sharp({ create: { width: 600, height: 600, channels: 4, background: "#254BFF" } }).png().toBuffer();
  const boundaryHash = createHash("sha256").update(boundaryBytes).digest("hex");
  const boundaryArt = { direction: sourceRichArt.direction, originals: [{ id: originalId, version: 1, hash: boundaryHash, width: 600, height: 600 }] };
  const boundary = await composeCreativeSlide({ art: boundaryArt, plan: { ...evidence, scene: acceptedNarrowerScene }, title: "A readable square", body: "Admission and rendering share one resolution rule.", index: 1, slideCount: 3 }, [{ id: originalId, version: 1, hash: boundaryHash, bytes: boundaryBytes }]);
  assert.ok(boundary.placements[0].bounds.width >= 480 && boundary.placements[0].bounds.height >= 480);
  const undersizedArt = { direction: sourceRichArt.direction, originals: [{ id: originalId, version: 1, hash: boundaryHash, width: 470, height: 470 }] };
  assert.throws(() => validateCreativePlan({ ...evidence, scene: acceptedNarrowerScene }, undersizedArt), { code: "original_resolution_insufficient" });
});
