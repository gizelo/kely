import assert from "node:assert/strict";
import test from "node:test";
import { researchPackageInput } from "../src/server/budget/research-package";
import type { BrandEvidenceRecord, BrandIntelligenceClaim } from "../src/shared/brand-intelligence";
import { checkStageAttempt, extractionStageAttempt, MAX_PLAN_CRITIC_REVISIONS, parseCheckStageResponse, parseExtractionStageResponse, parseStrategyDraftStageResponse, parseStrategyStageResponse, RESEARCH_STAGE_JSON_SCHEMAS, researchBriefFormatConflict, strategyStageAttempt, type ResearchStrategyOutput } from "../src/server/providers/research-stages";

const ownerId = "owner-1";
const runId = "00000000-0000-4000-8000-000000000001";
const reservation = researchPackageInput(ownerId, runId, "a".repeat(64));

function response(value: unknown) {
  return { output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(value) }] }] };
}

const official: BrandEvidenceRecord = { id: "official-1", sourceKind: "website", sourceRole: "official", sourceUrl: "https://example.com/", excerpt: "Example makes scheduling software.", span: { start: 0, end: 34 }, contentHash: "b".repeat(64), fetchedAt: "2026-09-21T10:00:00.000Z" };
const user: BrandEvidenceRecord = { ...official, id: "user-1", sourceKind: "user", sourceRole: "user_provided", sourceUrl: "https://fixture.kely.invalid/user" };
const upload: BrandEvidenceRecord = { ...official, id: "upload-1", sourceKind: "upload", sourceRole: "user_provided", sourceUrl: "https://kely.invalid/material/material-1" };
const external: BrandEvidenceRecord = { ...official, id: "external-1", sourceKind: "directory", sourceRole: "external_context", sourceUrl: "https://directory.example/business" };

function extraction(overrides: Record<string, unknown> = {}) {
  return { kind: "research_extraction", claims: [{ key: "category", kind: "fact", value: "Scheduling software", provenance: "verified", confidence: "high", evidenceIds: [official.id] }], requiredAssets: [], ...overrides };
}

const claims: BrandIntelligenceClaim[] = [{ key: "category", kind: "fact", value: "Scheduling software", status: "observed", confidence: "high", evidenceIds: [official.id] }];

function strategy(): ResearchStrategyOutput {
  return {
    kind: "research_strategy",
    brandProfile: {
      facts: [{ key: "category", value: "Scheduling software", provenance: "verified", confidence: "high", evidenceIds: [official.id] }],
      tone: [{ key: "tone", value: "Clear and direct", provenance: "proposed", confidence: "medium", evidenceIds: [] }],
      palette: [], typography: [], composition: [], allowedMaterials: [], prohibitions: [],
    },
    plan: {
      platform: "linkedin", format: "carousel", slideCount: 2, purpose: "Explain the product", audience: "Small business owners", angle: "Recover time", caption: "Spend less time coordinating.", cta: "See how it works", visualSystem: "High contrast editorial cards",
      slides: [
        { index: 1, objective: "Open", copy: "Scheduling steals your week", visualDirection: "Bold type", claimKeys: [], materialIds: [] },
        { index: 2, objective: "Explain", copy: "A clearer way to coordinate", visualDirection: "Product-led diagram", claimKeys: ["category"], materialIds: [] },
      ],
    },
  };
}

test("all structured research stages build bounded attempts inside one package", () => {
  const base = { ownerId, runId, context: "bounded durable research context", reservation };
  const attempts = [extractionStageAttempt(base), strategyStageAttempt(base), checkStageAttempt(base)];
  assert.deepEqual(attempts.map((item) => item.step), ["extract:0", "strategy:0", "check:0"]);
  assert.ok(attempts.every((item) => item.packageId === reservation.id));
  assert.deepEqual(attempts.map((item) => "max_output_tokens" in item.request && item.request.max_output_tokens), [2_048, 4_096, 4_096]);
  assert.equal(MAX_PLAN_CRITIC_REVISIONS, 2);
  const extractionInstructions = "instructions" in attempts[0].request ? attempts[0].request.instructions : "";
  assert.match(String(extractionInstructions), /only for an exact original without which/u);
  assert.match(String(extractionInstructions), /reference-only/u);
});

test("the provider schema enforces the product's six-slide boundary", () => {
  const plan = RESEARCH_STAGE_JSON_SCHEMAS.strategy.properties.plan;
  assert.deepEqual(plan.properties.slideCount, { type: "integer", enum: [1, 2, 3, 4, 5, 6] });
  assert.deepEqual(plan.properties.slides.items.properties.index, { type: "integer", enum: [1, 2, 3, 4, 5, 6] });
});

test("contradictory explicit format and count stop before strategy", () => {
  assert.match(researchBriefFormatConflict("Create a one-slide carousel") ?? "", /at least two/u);
  assert.match(researchBriefFormatConflict("Create a single post with 3 slides") ?? "", /only one slide/u);
  assert.equal(researchBriefFormatConflict("Create a 3-slide carousel"), null);
});

test("extraction preserves provenance and drops external context as factual support", () => {
  const parsed = parseExtractionStageResponse(response(extraction()), [official, user, external]);
  assert.equal(parsed.attributions[0].provenance, "verified");
  assert.equal(parsed.claims[0].status, "observed");

  const bad = extraction({ claims: [{ key: "category", kind: "fact", value: "Software", provenance: "inferred", confidence: "medium", evidenceIds: [external.id] }] });
  assert.deepEqual(parseExtractionStageResponse(response(bad), [official, external]).claims, []);
  const proposedFact = extraction({ claims: [{ key: "price", kind: "price", value: "$10", provenance: "proposed", confidence: "low", evidenceIds: [] }] });
  assert.deepEqual(parseExtractionStageResponse(response(proposedFact), [official]).claims, []);
});

test("creative proposals cannot upgrade inspiration into supporting evidence", () => {
  const output = extraction({ claims: [{ key: "art_direction", kind: "creative", value: "Use a bold split composition", provenance: "proposed", confidence: "medium", evidenceIds: [official.id] }] });
  const parsed = parseExtractionStageResponse(response(output), [official]);
  assert.deepEqual(parsed.attributions[0].evidenceIds, []);
  assert.equal(parsed.claims[0].status, "proposed");
});

test("creative user guidance cannot inherit official attribution", () => {
  const mixed = extraction({ claims: [{ key: "objective", kind: "creative", value: "Introduce the product", provenance: "user_provided", confidence: "high", evidenceIds: [official.id, user.id] }] });
  const retained = parseExtractionStageResponse(response(mixed), [official, user]);
  assert.deepEqual(retained.attributions[0].evidenceIds, [user.id]);
  assert.equal(retained.claims[0].status, "confirmed");

  const officialOnly = extraction({ claims: [{ key: "objective", kind: "creative", value: "Introduce the product", provenance: "user_provided", confidence: "high", evidenceIds: [official.id] }] });
  const downgraded = parseExtractionStageResponse(response(officialOnly), [official]);
  assert.deepEqual(downgraded.attributions[0].evidenceIds, []);
  assert.equal(downgraded.attributions[0].provenance, "proposed");
  assert.equal(downgraded.claims[0].status, "proposed");
});

test("upload-backed non-creative claims cannot become plan inputs", () => {
  for (const kind of ["fact", "price", "offer", "regulated"] as const) {
    for (const evidenceIds of [[upload.id], [upload.id, user.id]]) {
      const output = extraction({ claims: [{ key: `uploaded_${kind}`, kind, value: "Untrusted claim from an uploaded image", provenance: "user_provided", confidence: "high", evidenceIds }] });
      const parsed = parseExtractionStageResponse(response(output), [upload, user]);
      assert.deepEqual(parsed.attributions, []);
      assert.deepEqual(parsed.claims, []);
    }
  }
});

test("verified business facts without official evidence are dropped", () => {
  const output = extraction({ claims: [{ key: "official_product_description", kind: "fact", value: "Official product description", provenance: "verified", confidence: "high", evidenceIds: [user.id] }] });
  const parsed = parseExtractionStageResponse(response(output), [user]);
  assert.deepEqual(parsed.claims, []);
});

test("a model-mutated evidence id drops only that unsupported claim", () => {
  const output = extraction({ claims: [
    { key: "category", kind: "fact", value: "Scheduling software", provenance: "verified", confidence: "high", evidenceIds: [official.id] },
    { key: "mutated", kind: "fact", value: "Unsupported external listing", provenance: "verified", confidence: "medium", evidenceIds: ["official-2"] },
  ] });
  const parsed = parseExtractionStageResponse(response(output), [official]);
  assert.deepEqual(parsed.claims.map((item) => item.key), ["category"]);
});

test("strategy permits proposed creative direction but only references known facts", () => {
  const parsed = parseStrategyStageResponse(response(strategy()), claims, [official]);
  assert.equal(parsed.plan.slideCount, 2);
  assert.equal(parsed.brandProfile.tone[0].provenance, "proposed");

  const unknown = strategy();
  unknown.plan.slides[0].claimKeys = ["invented_price"];
  assert.throws(() => parseStrategyStageResponse(response(unknown), claims, [official]), /research_plan_claim_missing/u);
});

test("strategy draft preserves unresolved references for the bounded critic", () => {
  const draft = strategy();
  draft.brandProfile.facts.push({ key: "unverified_fact", value: "Unsupported", provenance: "proposed", confidence: "low", evidenceIds: [] });
  draft.plan.slides[0].claimKeys.push("unverified_fact");
  const parsed = parseStrategyDraftStageResponse(response(draft));
  assert.equal(parsed.brandProfile.facts.at(-1)?.key, "unverified_fact");
  assert.equal(parsed.plan.slides[0].claimKeys.at(-1), "unverified_fact");
  assert.throws(() => parseStrategyStageResponse(response(draft), claims, [official]), /research_plan_claim_missing/);
});

test("strategy drops unrecognized profile facts and preserves user-provided fact provenance", () => {
  const output = strategy();
  output.brandProfile.facts = [
    { key: "category", value: "Scheduling software", provenance: "verified", confidence: "high", evidenceIds: [user.id] },
    { key: "legal_entity", value: "Example LLC", provenance: "verified", confidence: "high", evidenceIds: [external.id] },
  ];
  const parsed = parseStrategyStageResponse(response(output), claims, [official, user, external]);
  assert.deepEqual(parsed.brandProfile.facts, [
    { key: "category", value: "Scheduling software", provenance: "user_provided", confidence: "high", evidenceIds: [user.id] },
  ]);
});

test("critic pass is immutable while one explicit corrected result is accepted", () => {
  const original = strategy();
  const passed = parseCheckStageResponse(response({ kind: "research_check", outcome: "pass", issues: [], result: original }), original, claims, [official]);
  assert.equal(passed.outcome, "pass");

  const changed = strategy(); changed.plan.angle = "A stronger angle";
  assert.throws(() => parseCheckStageResponse(response({ kind: "research_check", outcome: "pass", issues: [], result: changed }), original, claims, [official]), /research_check_pass_invalid/u);
  const corrected = parseCheckStageResponse(response({ kind: "research_check", outcome: "corrected", issues: [{ code: "weak_angle", severity: "blocking", message: "The angle is generic.", slideIndex: 0 }], result: changed }), original, claims, [official]);
  assert.equal(corrected.result.plan.angle, "A stronger angle");
});

test("critic corrections cannot invent evidence ids or claim keys", () => {
  const original = strategy();
  const changed = strategy();
  changed.brandProfile.facts[0].evidenceIds = ["official-1-mutated"];
  changed.brandProfile.tone[0].evidenceIds = ["invented-tone-source"];
  changed.brandProfile.tone[0].provenance = "verified";
  changed.plan.slides[0].claimKeys = ["invented_capability"];
  const corrected = parseCheckStageResponse(response({ kind: "research_check", outcome: "corrected", issues: [{ code: "unsupported_fact", severity: "blocking", message: "Removed unsupported references.", slideIndex: 1 }], result: changed }), original, claims, [official]);
  assert.deepEqual(corrected.result.brandProfile.facts[0].evidenceIds, [official.id]);
  assert.deepEqual(corrected.result.brandProfile.tone[0], original.brandProfile.tone[0]);
  assert.deepEqual(corrected.result.plan.slides[0].claimKeys, []);
});

test("critic corrections keep at most one material already present in the reviewed draft", () => {
  const original = strategy();
  original.plan.slides[0].materialIds = ["material-1"];
  original.plan.slides[1].materialIds = ["material-2"];
  const changed = strategy();
  changed.plan.slides[0].materialIds = ["invented-material", "material-1", "material-2"];
  changed.plan.slides[1].materialIds = ["material-2", "material-1"];

  const corrected = parseCheckStageResponse(response({
    kind: "research_check",
    outcome: "corrected",
    issues: [{ code: "brand_mismatch", severity: "warning", message: "Use only reviewed originals.", slideIndex: 0 }],
    result: changed,
  }), original, claims, [official]);

  assert.deepEqual(corrected.result.plan.slides.map((slide) => slide.materialIds), [["material-1"], ["material-2"]]);
});

test("final critic output must be issue-free and faithful to explicit brief constraints", () => {
  const original = strategy();
  const brief = { businessName: "Example", idea: "Create a 2-slide LinkedIn carousel about recovering time.", platform: "linkedin" as const, userSuppliedUrls: [] };
  assert.throws(() => parseCheckStageResponse(response({ kind: "research_check", outcome: "pass", issues: [{ code: "weak_angle", severity: "warning", message: "The angle is still generic.", slideIndex: 0 }], result: original }), original, claims, [official], brief), /research_check_pass_invalid/u);

  const wrongPlatform = strategy(); wrongPlatform.plan.platform = "instagram";
  assert.throws(() => parseCheckStageResponse(response({ kind: "research_check", outcome: "corrected", issues: [{ code: "brand_mismatch", severity: "blocking", message: "Corrected platform.", slideIndex: 0 }], result: wrongPlatform }), original, claims, [official], brief), /research_plan_platform_mismatch/u);

  const wrongCount = strategy(); wrongCount.plan.format = "single"; wrongCount.plan.slideCount = 1; wrongCount.plan.slides = [wrongCount.plan.slides[0]];
  assert.throws(() => parseCheckStageResponse(response({ kind: "research_check", outcome: "corrected", issues: [{ code: "narrative_gap", severity: "blocking", message: "Corrected count.", slideIndex: 0 }], result: wrongCount }), original, claims, [official], brief), /research_plan_count_mismatch/u);
});

test("final plan rejects repeated and placeholder creative work but accepts a specific repair", () => {
  const brief = { businessName: "Example", idea: "Create a 3-slide LinkedIn carousel about recovering time.", platform: "linkedin" as const, userSuppliedUrls: [] };
  const generic = strategy();
  generic.plan.slideCount = 3;
  generic.plan.slides = [
    { index: 1, objective: "Hook", copy: "Recover time", visualDirection: "Simple card", claimKeys: [], materialIds: [] },
    { index: 2, objective: "Explain", copy: "Recover time", visualDirection: "Simple card", claimKeys: [], materialIds: [] },
    { index: 3, objective: "Closing", copy: "Recover time", visualDirection: "Simple card", claimKeys: [], materialIds: [] },
  ];
  assert.throws(() => parseCheckStageResponse(response({ kind: "research_check", outcome: "pass", issues: [], result: generic }), generic, claims, [official], brief), /research_plan_copy_duplicate/u);

  const repaired = strategy();
  repaired.plan.slideCount = 3;
  repaired.plan.slides = [
    { index: 1, objective: "Expose the weekly coordination drain", copy: "Scheduling steals your week", visualDirection: "Oversized time block interrupted by a narrow accent rule", claimKeys: [], materialIds: [] },
    { index: 2, objective: "Reframe coordination around one workspace", copy: "Bring the moving parts into one clear view", visualDirection: "Structured stack that groups the workflow into three distinct layers", claimKeys: ["category"], materialIds: [] },
    { index: 3, objective: "Invite the owner to inspect the workflow", copy: "See what a calmer week could look like", visualDirection: "Quiet action frame with generous space around the final prompt", claimKeys: [], materialIds: [] },
  ];
  const accepted = parseCheckStageResponse(response({ kind: "research_check", outcome: "corrected", issues: [{ code: "weak_angle", severity: "blocking", message: "Replaced the generic structure with a specific progression.", slideIndex: 0 }], result: repaired }), generic, claims, [official], brief);
  assert.equal(accepted.result.plan.slides.length, 3);
});

test("a plan that merely repeats the request is rejected conservatively", () => {
  const original = strategy();
  const idea = "Show owners how to recover time";
  original.plan.purpose = idea;
  original.plan.angle = idea;
  original.plan.slides[0].objective = "Name the hidden coordination burden";
  original.plan.slides[1].objective = "Connect the problem to a calmer workflow";
  const brief = { businessName: "Example", idea, platform: "linkedin" as const, userSuppliedUrls: [] };
  assert.throws(() => parseCheckStageResponse(response({ kind: "research_check", outcome: "pass", issues: [], result: original }), original, claims, [official], brief), /research_plan_request_restatement/u);
});

test("new strategy contract requires explicit slide roles and information gain", () => {
  const slide = RESEARCH_STAGE_JSON_SCHEMAS.strategy.properties.plan.properties.slides.items;
  assert.equal(slide.required.includes("role"), true);
  assert.equal(slide.required.includes("newInformation"), true);
  assert.deepEqual(slide.properties.role.enum, ["hook", "explain", "proof", "process", "closing"]);
  const detailed = strategy();
  detailed.plan.slides[0].visualDirection = "x".repeat(350);
  assert.equal(parseStrategyDraftStageResponse(response(detailed)).plan.slides[0].visualDirection.length, 350);

  const oversized = strategy();
  oversized.plan.slides[0].visualDirection = "x".repeat(601);
  assert.throws(() => parseStrategyDraftStageResponse(response(oversized)), /<=600 characters/u);
});

test("final plan rejects compliance-heavy copy and a redundant unrequested recap", () => {
  const brief = { businessName: "Example", idea: "Create a LinkedIn carousel about the product.", platform: "linkedin" as const, userSuppliedUrls: [] };
  const compliance = strategy();
  compliance.plan.slides[0].copy = "Example publicly describes a clearer workflow";
  compliance.plan.slides[1].copy = "Example states that teams can coordinate here";
  assert.throws(() => parseCheckStageResponse(response({ kind: "research_check", outcome: "pass", issues: [], result: compliance }), compliance, claims, [official], brief), /research_plan_compliance_tone/u);

  const recap = strategy();
  recap.plan.slideCount = 4;
  recap.plan.slides = [
    { index: 1, objective: "Frame the category", copy: "A clearer operating model", visualDirection: "Editorial opener", claimKeys: ["category"], materialIds: [] },
    { index: 2, objective: "Show the first capability", copy: "Coordinate the work", visualDirection: "Structured stack", claimKeys: ["category"], materialIds: [] },
    { index: 3, objective: "Show the second capability", copy: "Keep the context visible", visualDirection: "Signal grid", claimKeys: ["category"], materialIds: [] },
    { index: 4, objective: "Repeat every point", copy: "The full list again", visualDirection: "Closing summary", claimKeys: ["category", "proof", "trust"], materialIds: [] },
  ];
  recap.plan.slides[0].claimKeys = ["category", "proof", "trust"];
  assert.throws(() => parseCheckStageResponse(response({ kind: "research_check", outcome: "pass", issues: [], result: recap }), recap, claims, [official], brief), /research_plan_(claim_missing|redundant_recap)/u);
});

test("typed slide roles must form hook to closing sequence", () => {
  const typed = strategy();
  typed.plan.slides[0].role = "explain";
  typed.plan.slides[0].newInformation = "Frame the category";
  typed.plan.slides[1].role = "closing";
  typed.plan.slides[1].newInformation = "Invite the next step";
  assert.throws(() => parseStrategyDraftStageResponse(response(typed)), /research_plan_role_sequence_invalid/u);

  const single = strategy();
  single.plan.format = "single";
  single.plan.slideCount = 1;
  single.plan.slides = [{ ...single.plan.slides[0], role: "hook", newInformation: "Introduce the one useful idea" }];
  assert.equal(parseStrategyDraftStageResponse(response(single)).plan.slides[0].role, "hook");
});
