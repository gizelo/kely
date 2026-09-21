import assert from "node:assert/strict";
import test from "node:test";
import { classifyResearchReadiness, createBrandIntelligenceSnapshot, evidenceRecord } from "../src/server/brand-intelligence";
import { brandIntelligenceEvalCases } from "./evals/brand-intelligence-cases";

const evaluatedAt = "2026-09-21T12:00:00.000Z";

function evaluate(item: (typeof brandIntelligenceEvalCases)[number]) {
  const evidence = item.evidence.map((source) => evidenceRecord({
    id: source.id,
    sourceKind: source.kind,
    sourceRole: source.role,
    sourceUrl: source.url,
    excerpt: source.excerpt,
    fetchedAt: evaluatedAt,
  }));
  const snapshot = createBrandIntelligenceSnapshot({
    id: `eval-${item.id}`,
    version: 1,
    createdAt: evaluatedAt,
    query: { businessName: item.businessName, userSuppliedUrls: item.urls },
    evidence,
    entityCandidates: item.candidates.map((candidate) => ({
      id: candidate.id,
      displayName: candidate.name,
      canonicalUrl: candidate.url,
      evidenceIds: candidate.evidenceIds,
      signals: candidate.signals,
    })),
    claims: item.claims,
    requiredAssets: item.requiredAssets,
  });
  return { snapshot, readiness: classifyResearchReadiness(snapshot, item.requiredFacts) };
}

test("Brand Intelligence fixture eval covers the approved scenario inventory", () => {
  assert.deepEqual(brandIntelligenceEvalCases.map((item) => item.id), [
    "unique-name", "ambiguous-same-name", "closed-social", "website-only", "uploaded-posts-only", "missing-exact-assets",
    "cafe-no-identity", "saas-design-system", "conflicting-offer", "regulated-claim", "hostile-injection", "weak-idea", "second-post-reuse",
  ]);
});

for (const item of brandIntelligenceEvalCases) {
  test(`Brand Intelligence eval: ${item.title}`, () => {
    const { snapshot, readiness } = evaluate(item);
    const checks = [
      snapshot.entityResolution.status === item.expected.resolution,
      readiness.ready === item.expected.ready,
      JSON.stringify(readiness.questions.map((question) => question.code)) === JSON.stringify(item.expected.questionCodes),
      readiness.questions.length <= 3,
      readiness.kelyDecides.includes("audience") && readiness.kelyDecides.includes("layout"),
    ];
    if (item.expected.evidenceRoles) checks.push(JSON.stringify(snapshot.evidence.map((evidence) => evidence.sourceRole)) === JSON.stringify(item.expected.evidenceRoles));
    if (item.expected.inertText) {
      checks.push(snapshot.evidence.some((evidence) => evidence.excerpt.includes(item.expected.inertText!)));
      checks.push(snapshot.entityCandidates.every((candidate) => !candidate.canonicalUrl.includes(item.expected.inertText!)));
      checks.push(snapshot.query.userSuppliedUrls.every((url) => !url.includes(item.expected.inertText!)));
    }
    if (item.id === "weak-idea") {
      checks.push(snapshot.claims.every((claim) => claim.kind === "creative"));
      checks.push(readiness.kelyDecides.join(",") === "audience,cta,mood,palette,font,layout");
    }
    assert.equal(checks.every(Boolean), true, JSON.stringify({ id: item.id, checks, resolution: snapshot.entityResolution, readiness }, null, 2));
  });
}

test("second-post reuse is deterministic and requires no new evidence acquisition", () => {
  const item = brandIntelligenceEvalCases.find((candidate) => candidate.id === "second-post-reuse")!;
  const first = evaluate(item);
  const second = classifyResearchReadiness(first.snapshot, item.requiredFacts);
  assert.deepEqual(second, first.readiness);
  assert.deepEqual(first.snapshot.evidence.map((evidence) => evidence.contentHash), evaluate(item).snapshot.evidence.map((evidence) => evidence.contentHash));
  assert.equal(first.snapshot.evidence.length, 1);
});

test("eval score reports contract coverage, not demand or visual quality", () => {
  const outcomes = brandIntelligenceEvalCases.map((item) => {
    const { snapshot, readiness } = evaluate(item);
    return snapshot.entityResolution.status === item.expected.resolution
      && readiness.ready === item.expected.ready
      && readiness.questions.map((question) => question.code).join(",") === item.expected.questionCodes.join(",");
  });
  assert.deepEqual({ passed: outcomes.filter(Boolean).length, total: outcomes.length }, { passed: 13, total: 13 });
});
