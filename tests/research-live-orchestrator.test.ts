import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { researchPackageInput } from "../src/server/budget/research-package";
import type { BrandEvidenceRecord, BrandIntelligenceSnapshot } from "../src/shared/brand-intelligence";
import type { ResearchRunView, ResearchStatus } from "../src/server/brand-intelligence-store";
import { researchStatusCanTransition } from "../src/server/brand-intelligence-store";
import { materialObservationContext, materialObservationEvidence, runLiveResearch, safePipelineErrorCode } from "../src/server/research-live-orchestrator";
import { analysisRequest, previewAnalysisResponse, type AnalysisInput } from "../src/server/providers/analysis";

const runId = "00000000-0000-4000-8000-000000000001";
const reservation = researchPackageInput("owner", runId, "a".repeat(64));
function view(): ResearchRunView { return { id: runId, ownerId: "owner", commandKey: "command-1", inputHash: "a".repeat(64), input: {}, supersedesRunId: null, status: "queued", statusDetail: {}, createdAt: new Date().toISOString(), sources: [], snapshots: [] }; }
function raw(value: unknown) { return { output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(value) }] }] }; }
const strategy = { kind: "research_strategy", brandProfile: { facts: [], tone: [], palette: [], typography: [], composition: [], allowedMaterials: [], prohibitions: [] }, plan: { platform: "linkedin", format: "single", slideCount: 1, purpose: "Introduce Acme", audience: "Salon owners", angle: "Simple scheduling", slides: [{ index: 1, objective: "Introduce", copy: "Meet Acme", visualDirection: "Clean product-led composition", claimKeys: [], materialIds: [] }], caption: "Meet Acme.", cta: "Learn more", visualSystem: "Clear and restrained" } } as const;

test("extraction can pause for an identity answer without failing the research run", () => {
  assert.equal(researchStatusCanTransition("extracting", "needs_input"), true);
  assert.equal(researchStatusCanTransition("extracting", "review_ready"), false);
});

test("pipeline diagnostics expose only known stable codes", () => {
  assert.equal(safePipelineErrorCode(new Error("research_plan_shape_invalid")), "research_plan_shape_invalid");
  assert.equal(safePipelineErrorCode(new Error("private_token_123")), "research_pipeline_failed");
  assert.equal(safePipelineErrorCode("research_plan_shape_invalid"), "research_pipeline_failed");
});

test("material observations are split to the durable evidence limit with run-scoped stable IDs", () => {
  const content = `${"a".repeat(499)}😀${"b".repeat(500)}`;
  const first = materialObservationEvidence(runId, "00000000-0000-4000-8000-000000000099", content, "2026-09-21T10:00:00.000Z");
  const repeated = materialObservationEvidence(runId, "00000000-0000-4000-8000-000000000099", content, "2026-09-21T10:00:00.000Z");
  const nextRun = materialObservationEvidence("00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000099", content, "2026-09-21T10:00:00.000Z");
  assert.equal(first.every((item) => item.excerpt.length <= 500 && [...item.excerpt].length <= 500), true);
  assert.equal(first.map((item) => item.excerpt).join(""), content);
  assert.deepEqual(first.map((item) => item.span), [{ start: 0, end: 499 }, { start: 499, end: 999 }, { start: 999, end: 1001 }]);
  assert.equal(first.every((item) => /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(item.id)), true);
  assert.deepEqual(first.map((item) => item.id), repeated.map((item) => item.id));
  assert.notDeepEqual(first.map((item) => item.id), nextRun.map((item) => item.id));
  const observation = { materialId: "00000000-0000-4000-8000-000000000099", evidence: content, purpose: "reference" as const, confidence: "high" as const };
  assert.deepEqual(materialObservationContext([observation], first)[0].evidenceIds, first.map((item) => item.id));
});

test("full durable pipeline uses one package, one critic and reaches review_ready", async () => {
  const run = view(); const statuses: ResearchStatus[] = []; const persisted: BrandEvidenceRecord[] = []; const snapshots: BrandIntelligenceSnapshot[] = []; const steps: string[] = []; let closed = 0;
  const official: BrandEvidenceRecord = { id: "10000000-0000-4000-8000-000000000001", sourceKind: "website", sourceRole: "official", sourceUrl: "https://acme.example/", excerpt: "Acme scheduling", span: { start: 0, end: 15 }, contentHash: "b".repeat(64), fetchedAt: "2026-09-21T10:00:00.000Z" };
  const result = await runLiveResearch("owner", runId, { businessName: "Acme", idea: "Create a single post for the launch.", platform: "linkedin", userSuppliedUrls: ["https://acme.example/"] }, reservation, {
    store: { async read() { return run; }, async appendStatus(_o, _i, status, detail = {}) { statuses.push(status); run.status = status; run.statusDetail = detail; return run; }, async addSource(_o, _i, evidence) { persisted.push(evidence); return run; }, async acceptSnapshot(_o, _i, snapshot) { snapshots.push(snapshot); return { id: "snapshot", version: 1, hash: "c".repeat(64) }; } },
    async verifyReservation(value) { assert.equal(value.id, reservation.id); },
    async search(input) { assert.equal(input.reservation?.id, reservation.id); return { candidates: [{ id: "acme", displayName: "Acme Technologies INC", canonicalUrl: "https://acme.example/", evidenceIds: [], signals: { userSuppliedUrl: true, officialSiteClaim: false, exactNameMatch: false, crossLinkedProfile: false } }, { id: "other", displayName: "Other Acme", canonicalUrl: "https://other.example/", evidenceIds: [], signals: { userSuppliedUrl: false, officialSiteClaim: false, exactNameMatch: false, crossLinkedProfile: false } }], evidence: [], replayed: false, assessment: {} }; },
    async acquire() { return { evidence: [official], outcomes: [{ url: official.sourceUrl, role: "official", kind: "website", status: "complete" }] }; },
    gateway: { async dispatch(attempt) { assert.equal(attempt.packageId, reservation.id); steps.push(attempt.step); if (attempt.step === "extract:0") return { response: raw({ kind: "research_extraction", claims: [], requiredAssets: [] }), assessment: {}, replayed: false }; if (attempt.step === "strategy:0") return { response: raw(strategy), assessment: {}, replayed: false }; assert.match(String(attempt.request.input), /Create a single post for the launch/u); return { response: raw({ kind: "research_check", outcome: "pass", issues: [], result: strategy }), assessment: {}, replayed: false }; } },
    async closeFromDurableEvidence(saved) { assert.equal(saved.status, "review_ready"); closed += 1; },
  });
  assert.equal(result.status, "review_ready"); assert.deepEqual(steps, ["extract:0", "strategy:0", "check:0"]); assert.equal(closed, 1); assert.equal(snapshots.length, 1);
  assert.deepEqual(snapshots[0].entityCandidates.find((item) => item.id === "other")?.evidenceIds, []);
  assert.deepEqual(statuses, ["resolving", "fetching", "extracting", "strategizing", "checking", "review_ready"]);
});

test("unverified package stops before dispatch and unknown outcome is never closed", async () => {
  const run = view(); let calls = 0;
  await assert.rejects(runLiveResearch("owner", runId, { businessName: "Acme", idea: "Launch", platform: "linkedin", userSuppliedUrls: [] }, reservation, { store: { async read() { return run; }, async appendStatus() { calls += 1; return run; }, async addSource() { calls += 1; return run; }, async acceptSnapshot() { calls += 1; return { id: "x", version: 1, hash: "x" }; } }, async verifyReservation() { throw new Error("not reserved"); }, async search() { calls += 1; throw new Error("no"); }, gateway: { async dispatch() { calls += 1; throw new Error("no"); } }, async closeFromDurableEvidence() { calls += 1; } }), /not reserved/u);
  assert.equal(calls, 0);
});

test("name-only resolution promotes one locally proven host but keeps same-name ties ambiguous", async () => {
  for (const ambiguous of [false, true]) {
    const run = view(); const snapshots: BrandIntelligenceSnapshot[] = []; const calls: string[] = [];
    const candidates = [
      { id: "acme-one", displayName: "Acme", canonicalUrl: "https://one.example/", evidenceIds: [], signals: { userSuppliedUrl: false, officialSiteClaim: false, exactNameMatch: false, crossLinkedProfile: false } },
      { id: "acme-two", displayName: ambiguous ? "Acme" : "Different Company", canonicalUrl: "https://two.example/", evidenceIds: [], signals: { userSuppliedUrl: false, officialSiteClaim: false, exactNameMatch: false, crossLinkedProfile: false } },
    ];
    const evidence = candidates.map((candidate, index) => ({ id: `20000000-0000-4000-8000-00000000000${index + 1}`, sourceKind: "website" as const, sourceRole: "external_context" as const, sourceUrl: candidate.canonicalUrl, excerpt: `${candidate.displayName} scheduling`, span: { start: 0, end: 15 }, contentHash: "d".repeat(64), fetchedAt: "2026-09-21T10:00:00.000Z" }));
    let acquisitionCalls = 0;
    const result = await runLiveResearch("owner", runId, { businessName: "Acme", idea: "Launch", platform: "linkedin", userSuppliedUrls: [] }, reservation, {
      store: { async read() { return run; }, async appendStatus(_o, _i, status, detail = {}) { run.status = status; run.statusDetail = detail; return run; }, async addSource() { return run; }, async acceptSnapshot(_o, _i, snapshot) { snapshots.push(snapshot); return { id: "snapshot", version: 1, hash: "c".repeat(64) }; } },
      async verifyReservation() {},
      async search() { return { candidates, evidence: [], replayed: false, assessment: {} }; },
      async acquire(seeds) {
        acquisitionCalls += 1;
        if (acquisitionCalls === 1) return { evidence, outcomes: candidates.map((candidate, index) => ({ url: candidate.canonicalUrl, role: "external_context" as const, kind: "website" as const, candidateId: candidate.id, status: "complete" as const, identity: { exactNameMatch: index === 0 || ambiguous, canonicalSameHost: true, linkedSocialProfile: index === 0 } })) };
        assert.deepEqual(seeds, [{ url: "https://one.example/", role: "official", kind: "website" }]);
        return { evidence: [
          { ...evidence[0], id: "20000000-0000-4000-8000-000000000010", sourceRole: "official" as const },
          { ...evidence[0], id: "20000000-0000-4000-8000-000000000011", sourceRole: "official" as const, sourceUrl: "https://one.example/features", excerpt: "Acme product features", span: { start: 0, end: 21 } },
        ], outcomes: [
          { url: "https://one.example/", role: "official" as const, kind: "website" as const, status: "complete" as const },
          { url: "https://one.example/features", role: "official" as const, kind: "website" as const, status: "complete" as const },
        ] };
      },
      gateway: { async dispatch(attempt) { calls.push(attempt.step); if (attempt.step === "extract:0") return { response: raw({ kind: "research_extraction", claims: [], requiredAssets: [] }), assessment: {}, replayed: false }; if (attempt.step === "strategy:0") return { response: raw(strategy), assessment: {}, replayed: false }; return { response: raw({ kind: "research_check", outcome: "pass", issues: [], result: strategy }), assessment: {}, replayed: false }; } },
      async closeFromDurableEvidence() {},
    });
    assert.equal(result.status, ambiguous ? "needs_input" : "review_ready");
    assert.equal(acquisitionCalls, ambiguous ? 1 : 2);
    assert.equal(snapshots[0].entityResolution.status, ambiguous ? "ambiguous" : "resolved");
    assert.deepEqual(calls, ambiguous ? ["extract:0"] : ["extract:0", "strategy:0", "check:0"]);
    if (!ambiguous) {
      const official = snapshots[0].evidence.filter((item) => item.sourceRole === "official");
      assert.equal(official.every((item) => new URL(item.sourceUrl).hostname === "one.example"), true);
      assert.equal(official.some((item) => new URL(item.sourceUrl).pathname === "/features"), true);
    }
  }
});

test("optional materials use one package-bound vision call and persist observations", async () => {
  const materialId = "00000000-0000-4000-8000-000000000099";
  const materialReservation = researchPackageInput("owner", runId, "a".repeat(64), [materialId]);
  const image = await sharp({ create: { width: 16, height: 16, channels: 3, background: "#5522AA" } }).jpeg().toBuffer();
  const materialInput: AnalysisInput = { guidance: "Launch", rules: { audience: "Owners", palette: null, headlines: "default" }, selected: [{ id: materialId, label: "Reference", role: "reference", version: 1, originalHash: "e".repeat(64), derivativeHash: "f".repeat(64), width: 16, height: 16, dataUrl: `data:image/jpeg;base64,${image.toString("base64")}` }] };
  const run = view(); const calls: string[] = []; let persisted = 0;
  const official: BrandEvidenceRecord = { id: "30000000-0000-4000-8000-000000000001", sourceKind: "website", sourceRole: "official", sourceUrl: "https://acme.example/", excerpt: "Acme scheduling", span: { start: 0, end: 15 }, contentHash: "b".repeat(64), fetchedAt: "2026-09-21T10:00:00.000Z" };
  const result = await runLiveResearch("owner", runId, { businessName: "Acme", idea: "Launch", platform: "linkedin", userSuppliedUrls: ["https://acme.example/"] }, materialReservation, {
    store: { async read() { return run; }, async appendStatus(_o, _i, status, detail = {}) { run.status = status; run.statusDetail = detail; return run; }, async addSource(_o, _i, evidence, outcome) { run.sources.push({ ...evidence, outcome }); return run; }, async acceptSnapshot() { return { id: "snapshot", version: 1, hash: "c".repeat(64) }; } },
    async verifyReservation() {}, materialInput,
    async persistMaterialAnalysis(proposal) { persisted = proposal.observations.length; },
    async search() { return { candidates: [{ id: "acme", displayName: "Acme", canonicalUrl: "https://acme.example/", evidenceIds: [], signals: { userSuppliedUrl: true, officialSiteClaim: false, exactNameMatch: true, crossLinkedProfile: false } }], evidence: [], replayed: false, assessment: {} }; },
    async acquire() { return { evidence: [official], outcomes: [{ url: official.sourceUrl, role: "official", kind: "website", status: "complete" }] }; },
    gateway: { async dispatch(attempt) { calls.push(attempt.step); assert.equal(attempt.packageId, materialReservation.id); if (attempt.step === "materials:0") return { response: previewAnalysisResponse(analysisRequest(materialInput, "brand-analysis-v2"), "research-material"), assessment: {}, replayed: false }; if (attempt.step === "extract:0") return { response: raw({ kind: "research_extraction", claims: [{ key: "visual_reference", kind: "creative", value: "The supplied image is a visual reference.", provenance: "verified", confidence: "low", evidenceIds: [run.sources.find((item) => item.sourceKind === "upload")!.id] }], requiredAssets: [] }), assessment: {}, replayed: false }; if (attempt.step === "strategy:0") return { response: raw(strategy), assessment: {}, replayed: false }; return { response: raw({ kind: "research_check", outcome: "pass", issues: [], result: strategy }), assessment: {}, replayed: false }; } },
    async closeFromDurableEvidence() {},
  });
  assert.equal(result.status, "review_ready"); assert.equal(persisted, 1); assert.equal(run.sources.some((item) => item.sourceUrl.endsWith(materialId) && item.sourceRole === "user_provided"), true); assert.deepEqual(calls, ["materials:0", "extract:0", "strategy:0", "check:0"]);
});
