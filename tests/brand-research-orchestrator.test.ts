import assert from "node:assert/strict";
import test from "node:test";
import { assembleResearchContext } from "../src/server/brand-intelligence-context";
import { orchestrateFixtureResearch, RESEARCH_LIMITS, type FixtureResearchRun } from "../src/server/brand-intelligence-orchestrator";
import { buildEntityDiscoveryRequest, parseEntityDiscoveryOutput } from "../src/server/providers/research-contract";

const now = "2026-09-21T10:00:00.000Z";
function fixture(overrides: Partial<FixtureResearchRun> = {}): FixtureResearchRun {
  const content = "Girex provides a multi-chain interface for managing digital assets.";
  return {
    id: "snapshot-1", createdAt: now,
    input: { businessName: "Girex", idea: "Introduce the product", platform: "linkedin", userSuppliedUrls: ["https://girex.io"] },
    searchQueries: ["Girex official"],
    candidates: [{ id: "girex", title: "Girex", url: "https://girex.io", snippet: "Official site", sourceRole: "official", signals: { userSuppliedUrl: true, officialSiteClaim: true, exactNameMatch: true, crossLinkedProfile: true } }],
    sources: [{ id: "home", sourceKind: "website", sourceRole: "official", url: "https://girex.io", content, spans: [{ start: 0, end: content.length }] }],
    claims: [{ key: "product", kind: "fact", value: "Multi-chain interface", status: "observed", confidence: "high", evidenceIds: ["home-1"] }],
    requiredAssets: [], ...overrides,
  };
}

test("fixture orchestration preserves exact spans and resolves a single official business", () => {
  const result = orchestrateFixtureResearch(fixture());
  assert.equal(result.snapshot.evidence[0].excerpt, fixture().sources[0].content);
  assert.deepEqual(result.snapshot.evidence[0].span, { start: 0, end: fixture().sources[0].content.length });
  assert.equal(result.snapshot.entityResolution.status, "resolved");
  assert.equal(result.readiness.ready, true);
});

test("orchestration enforces search, source, candidate and blocker bounds", () => {
  assert.throws(() => orchestrateFixtureResearch(fixture({ searchQueries: ["one", "two", "three"] })), /research_search_query_limit/u);
  const manySources = Array.from({ length: 9 }, (_, index) => ({ id: `external-${index}`, sourceKind: "directory" as const, sourceRole: "external_context" as const, url: `https://context${index}.example`, content: "Category context", spans: [{ start: 0, end: 16 }] }));
  const result = orchestrateFixtureResearch(fixture({ sources: [...fixture().sources, ...manySources] }));
  assert.equal(result.snapshot.evidence.filter((item) => item.sourceRole === "external_context").length, RESEARCH_LIMITS.externalSources);
});

test("external context cannot become a brand fact", () => {
  const external = { id: "context", sourceKind: "directory" as const, sourceRole: "external_context" as const, url: "https://directory.example/girex", content: "Unverified price is €20", spans: [{ start: 0, end: 23 }] };
  assert.throws(() => orchestrateFixtureResearch(fixture({ sources: [...fixture().sources, external], claims: [{ key: "price", kind: "price", value: "€20", status: "observed", confidence: "high", evidenceIds: ["context-1"] }] })), /external_context_cannot_support_brand_fact/u);
});

test("context assembler prioritizes user and official evidence within a hard byte limit", () => {
  const result = orchestrateFixtureResearch(fixture());
  const context = assembleResearchContext(fixture().input, result.snapshot.evidence);
  assert.ok(Buffer.byteLength(context, "utf8") <= 48 * 1024);
  assert.match(context, /OFFICIAL home-1/u);
});

test("provider entity discovery contract is discriminated, strict and bounded", () => {
  assert.equal(buildEntityDiscoveryRequest({ stableInstructions: "Find candidate businesses.", dynamicContext: "Girex" }).kind, "entity_discovery");
  const candidate = { id: "girex", displayName: "Girex", canonicalUrl: "https://girex.io", snippet: "Official", sourceRole: "official" as const, signals: { userSuppliedUrl: true, officialSiteClaim: true, exactNameMatch: true, crossLinkedProfile: true } };
  assert.equal(parseEntityDiscoveryOutput({ kind: "entity_discovery", candidates: [candidate] }).candidates[0].id, "girex");
  assert.throws(() => parseEntityDiscoveryOutput({ kind: "claims", candidates: [] }), /invalid_value/u);
  assert.throws(() => parseEntityDiscoveryOutput({ kind: "entity_discovery", candidates: [candidate], extra: true }), /unrecognized_keys/u);
  assert.throws(() => buildEntityDiscoveryRequest({ stableInstructions: "Find candidates.", dynamicContext: "x".repeat(49 * 1024) }), /research_context_too_large/u);
});
