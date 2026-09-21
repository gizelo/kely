import { createHash } from "node:crypto";
import type { BrandIntelligenceClaim, BrandResearchInput, EntityCandidate, ResearchSearchResult, RequiredAsset } from "../shared/brand-intelligence";
import { canonicalEvidenceUrl, classifyResearchReadiness, createBrandIntelligenceSnapshot, evidenceRecordFromSpan } from "./brand-intelligence";

export const RESEARCH_LIMITS = { searchQueries: 2, candidates: 10, officialPages: 5, socialSources: 2, externalSources: 3, userSources: 12, blockers: 3 } as const;

export interface FixtureResearchSource {
  id: string;
  sourceKind: "website" | "social" | "directory" | "user" | "upload";
  sourceRole: "official" | "external_context" | "user_provided";
  url: string;
  content: string;
  spans: { start: number; end: number }[];
}

export interface FixtureResearchRun {
  id: string;
  createdAt: string;
  input: BrandResearchInput;
  searchQueries: string[];
  candidates: ResearchSearchResult[];
  sources: FixtureResearchSource[];
  claims: BrandIntelligenceClaim[];
  requiredAssets: RequiredAsset[];
  requiredFactKeys?: string[];
}

function cappedSources(sources: FixtureResearchSource[]) {
  const counts = { official: 0, social: 0, external: 0, user: 0 };
  return sources.filter((source) => {
    if (source.sourceRole === "user_provided") return ++counts.user <= RESEARCH_LIMITS.userSources;
    if (source.sourceRole === "external_context") return ++counts.external <= RESEARCH_LIMITS.externalSources;
    if (source.sourceKind === "social") return ++counts.social <= RESEARCH_LIMITS.socialSources;
    return ++counts.official <= RESEARCH_LIMITS.officialPages;
  });
}

export function orchestrateFixtureResearch(run: FixtureResearchRun) {
  if (!run.input.businessName.trim() || !run.input.idea.trim() || !["instagram", "linkedin"].includes(run.input.platform)) throw new Error("research_input_invalid");
  run.input.userSuppliedUrls.forEach(canonicalEvidenceUrl);
  if (run.searchQueries.length > RESEARCH_LIMITS.searchQueries) throw new Error("research_search_query_limit");
  const candidates = run.candidates.slice(0, RESEARCH_LIMITS.candidates).map((item) => ({ ...item, url: canonicalEvidenceUrl(item.url) }));
  if (new Set(candidates.map((item) => item.id)).size !== candidates.length) throw new Error("research_candidate_duplicate");
  const evidence = cappedSources(run.sources).flatMap((source) => source.spans.map((span, index) => evidenceRecordFromSpan({
    id: `${source.id}-${index + 1}`, sourceKind: source.sourceKind, sourceRole: source.sourceRole,
    sourceUrl: source.url, content: source.content, span, fetchedAt: run.createdAt,
  })));
  const evidenceIds = new Set(evidence.map((item) => item.id));
  const entities: EntityCandidate[] = candidates.map((candidate) => ({
    id: candidate.id, displayName: candidate.title, canonicalUrl: candidate.url,
    evidenceIds: candidate.sourceRole === "official" ? evidence.filter((item) => new URL(item.sourceUrl).hostname === new URL(candidate.url).hostname).map((item) => item.id) : [],
    signals: candidate.signals,
  }));
  const claims = run.claims.map((claim) => ({ ...claim, evidenceIds: claim.evidenceIds.filter((id) => evidenceIds.has(id)) }));
  const snapshot = createBrandIntelligenceSnapshot({ id: run.id, version: 1, createdAt: run.createdAt, query: { businessName: run.input.businessName, userSuppliedUrls: run.input.userSuppliedUrls }, evidence, entityCandidates: entities, claims, requiredAssets: run.requiredAssets });
  const readiness = classifyResearchReadiness(snapshot, run.requiredFactKeys).questions.slice(0, RESEARCH_LIMITS.blockers);
  return { snapshot, readiness: { ready: readiness.length === 0, questions: readiness, kelyDecides: classifyResearchReadiness(snapshot).kelyDecides }, fingerprint: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex") };
}
