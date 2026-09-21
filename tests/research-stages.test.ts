import assert from "node:assert/strict";
import test from "node:test";
import { researchPackageInput } from "../src/server/budget/research-package";
import type { BrandEvidenceRecord, BrandIntelligenceClaim } from "../src/shared/brand-intelligence";
import { checkStageAttempt, extractionStageAttempt, MAX_PLAN_CRITIC_REVISIONS, parseCheckStageResponse, parseExtractionStageResponse, parseStrategyStageResponse, strategyStageAttempt, type ResearchStrategyOutput } from "../src/server/providers/research-stages";

const ownerId = "owner-1";
const runId = "00000000-0000-4000-8000-000000000001";
const reservation = researchPackageInput(ownerId, runId, "a".repeat(64));

function response(value: unknown) {
  return { output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(value) }] }] };
}

const official: BrandEvidenceRecord = { id: "official-1", sourceKind: "website", sourceRole: "official", sourceUrl: "https://example.com/", excerpt: "Example makes scheduling software.", span: { start: 0, end: 34 }, contentHash: "b".repeat(64), fetchedAt: "2026-09-21T10:00:00.000Z" };
const user: BrandEvidenceRecord = { ...official, id: "user-1", sourceKind: "user", sourceRole: "user_provided", sourceUrl: "https://fixture.kely.invalid/user" };
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
  assert.deepEqual(attempts.map((item) => "max_output_tokens" in item.request && item.request.max_output_tokens), [2_048, 4_096, 2_048]);
  assert.equal(MAX_PLAN_CRITIC_REVISIONS, 2);
});

test("extraction preserves provenance and rejects external context as factual support", () => {
  const parsed = parseExtractionStageResponse(response(extraction()), [official, user, external]);
  assert.equal(parsed.attributions[0].provenance, "verified");
  assert.equal(parsed.claims[0].status, "observed");

  const bad = extraction({ claims: [{ key: "category", kind: "fact", value: "Software", provenance: "inferred", confidence: "medium", evidenceIds: [external.id] }] });
  assert.throws(() => parseExtractionStageResponse(response(bad), [official, external]), /external_context_cannot_support_brand_fact/u);
  const proposedFact = extraction({ claims: [{ key: "price", kind: "price", value: "$10", provenance: "proposed", confidence: "low", evidenceIds: [] }] });
  assert.throws(() => parseExtractionStageResponse(response(proposedFact), [official]), /proposed_fact_invalid/u);
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

test("strategy permits proposed creative direction but only references known facts", () => {
  const parsed = parseStrategyStageResponse(response(strategy()), claims, [official]);
  assert.equal(parsed.plan.slideCount, 2);
  assert.equal(parsed.brandProfile.tone[0].provenance, "proposed");

  const unknown = strategy();
  unknown.plan.slides[0].claimKeys = ["invented_price"];
  assert.throws(() => parseStrategyStageResponse(response(unknown), claims, [official]), /research_plan_claim_missing/u);
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
