import { createHash } from "node:crypto";
import {
  BRAND_INTELLIGENCE_SCHEMA,
  type BrandClaimKind,
  type BrandEvidenceRecord,
  type BrandIntelligenceClaim,
  type BrandIntelligenceSnapshot,
  type CreativeProposalKey,
  type EntityCandidate,
  type EntityResolution,
  type EvidenceSourceKind,
  type EvidenceRole,
  type IntelligenceConfidence,
  type IntelligenceStatus,
  type RequiredAsset,
  type ResearchQuestion,
  type ResearchReadiness,
} from "../shared/brand-intelligence";

const MAX_EXCERPT_LENGTH = 500;
const CREATIVE_DEFAULTS: CreativeProposalKey[] = ["audience", "cta", "mood", "palette", "font", "layout"];
const CLAIM_KINDS = new Set<BrandClaimKind>(["fact", "offer", "price", "regulated", "creative"]);
const CLAIM_STATUSES = new Set<IntelligenceStatus>(["observed", "proposed", "confirmed", "contradicted"]);
const CONFIDENCES = new Set<IntelligenceConfidence>(["low", "medium", "high"]);

function nonEmpty(value: string, field: string) {
  const result = value.trim();
  if (!result) throw new Error(`${field}_required`);
  return result;
}

export function canonicalEvidenceUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) throw new Error("evidence_url_invalid");
  url.hash = "";
  return url.toString();
}

export function evidenceRecord(input: {
  id: string;
  sourceKind: EvidenceSourceKind;
  sourceRole?: EvidenceRole;
  sourceUrl: string;
  excerpt: string;
  span?: { start: number; end: number };
  fetchedAt: string;
}): BrandEvidenceRecord {
  const excerpt = nonEmpty(input.excerpt, "evidence_excerpt");
  if (excerpt.length > MAX_EXCERPT_LENGTH) throw new Error("evidence_excerpt_too_long");
  const fetchedAt = new Date(input.fetchedAt);
  if (!Number.isFinite(fetchedAt.getTime())) throw new Error("evidence_fetched_at_invalid");
  const sourceUrl = canonicalEvidenceUrl(input.sourceUrl);
  return {
    id: nonEmpty(input.id, "evidence_id"),
    sourceKind: input.sourceKind,
    sourceRole: input.sourceRole ?? (input.sourceKind === "user" || input.sourceKind === "upload" ? "user_provided" : "official"),
    sourceUrl,
    excerpt,
    span: input.span ?? { start: 0, end: excerpt.length },
    contentHash: createHash("sha256").update(excerpt, "utf8").digest("hex"),
    fetchedAt: fetchedAt.toISOString(),
  };
}

export function evidenceRecordFromSpan(input: {
  id: string;
  sourceKind: EvidenceSourceKind;
  sourceRole: EvidenceRole;
  sourceUrl: string;
  content: string;
  span: { start: number; end: number };
  fetchedAt: string;
}): BrandEvidenceRecord {
  if (!Number.isInteger(input.span.start) || !Number.isInteger(input.span.end) || input.span.start < 0 || input.span.end <= input.span.start || input.span.end > input.content.length) {
    throw new Error("evidence_span_invalid");
  }
  return evidenceRecord({ ...input, excerpt: input.content.slice(input.span.start, input.span.end) });
}

function entityScore(candidate: EntityCandidate): number {
  return (candidate.signals.userSuppliedUrl ? 5 : 0)
    + (candidate.signals.officialSiteClaim ? 3 : 0)
    + (candidate.signals.exactNameMatch ? 2 : 0)
    + (candidate.signals.crossLinkedProfile ? 2 : 0);
}

function hasLocallyProvenIdentity(candidate: EntityCandidate) {
  return candidate.signals.officialSiteClaim
    && candidate.signals.exactNameMatch
    && candidate.signals.crossLinkedProfile
    && candidate.evidenceIds.length > 0;
}

/** Resolves only explicit candidate metadata. Page excerpts cannot nominate hosts or issue instructions. */
export function resolveEntity(candidates: EntityCandidate[]): EntityResolution {
  if (!candidates.length) return { status: "not_found", candidateId: null, confidence: "low", reason: "No supported entity candidate was found." };
  const ranked = [...candidates].sort((a, b) => entityScore(b) - entityScore(a) || a.id.localeCompare(b.id));
  const first = ranked[0];
  const topScore = entityScore(first);
  const secondScore = ranked[1] ? entityScore(ranked[1]) : -1;
  const locallyProven = ranked.filter(hasLocallyProvenIdentity);
  if (locallyProven.length === 1 && locallyProven[0].id === first.id && topScore - secondScore >= 3) {
    return { status: "resolved", candidateId: first.id, confidence: "high", reason: "One candidate has a unique locally verified name, canonical host and linked social profile." };
  }
  if (topScore < 5 || topScore === secondScore) {
    return { status: "ambiguous", candidateId: null, confidence: "low", reason: "Available sources do not identify one business with sufficient separation." };
  }
  if (topScore < 9 || topScore - secondScore < 3) return { status: "ambiguous", candidateId: null, confidence: "low", reason: "The leading candidate is not supported with high confidence." };
  return { status: "resolved", candidateId: first.id, confidence: "high", reason: "One candidate has the strongest explicit official and cross-source signals." };
}

function validateClaim(claim: BrandIntelligenceClaim, evidenceIds: Set<string>): BrandIntelligenceClaim {
  if (!CLAIM_KINDS.has(claim.kind) || !CLAIM_STATUSES.has(claim.status) || !CONFIDENCES.has(claim.confidence)) throw new Error("claim_invalid");
  if (claim.evidenceIds.some((id) => !evidenceIds.has(id))) throw new Error("claim_evidence_missing");
  return { ...claim, key: nonEmpty(claim.key, "claim_key"), value: nonEmpty(claim.value, "claim_value"), evidenceIds: [...new Set(claim.evidenceIds)] };
}

function validateEvidence(item: BrandEvidenceRecord): BrandEvidenceRecord {
  if (!(["official", "external_context", "user_provided"] as const).includes(item.sourceRole)) throw new Error("evidence_role_invalid");
  if (!Number.isInteger(item.span.start) || !Number.isInteger(item.span.end) || item.span.start < 0 || item.span.end <= item.span.start) throw new Error("evidence_span_invalid");
  return item;
}

export function createBrandIntelligenceSnapshot(input: Omit<BrandIntelligenceSnapshot, "schemaVersion" | "entityResolution">): BrandIntelligenceSnapshot {
  input.evidence.forEach(validateEvidence);
  const evidenceIds = new Set(input.evidence.map((item) => item.id));
  if (evidenceIds.size !== input.evidence.length) throw new Error("evidence_id_duplicate");
  const candidateIds = new Set(input.entityCandidates.map((item) => item.id));
  if (candidateIds.size !== input.entityCandidates.length) throw new Error("candidate_id_duplicate");
  const candidates = input.entityCandidates.map((candidate) => {
    const canonicalUrl = canonicalEvidenceUrl(candidate.canonicalUrl);
    if (candidate.evidenceIds.some((id) => !evidenceIds.has(id))) throw new Error("candidate_evidence_missing");
    const host = new URL(canonicalUrl).hostname;
    const hasSameHostOfficialEvidence = candidate.evidenceIds.some((id) => {
      const item = input.evidence.find((evidence) => evidence.id === id);
      return item?.sourceRole === "official" && new URL(item.sourceUrl).hostname === host;
    });
    const signals = hasSameHostOfficialEvidence ? candidate.signals : { ...candidate.signals, officialSiteClaim: false, crossLinkedProfile: false };
    return { ...candidate, signals, id: nonEmpty(candidate.id, "candidate_id"), displayName: nonEmpty(candidate.displayName, "candidate_name"), canonicalUrl, evidenceIds: [...new Set(candidate.evidenceIds)] };
  });
  return {
    ...input,
    schemaVersion: BRAND_INTELLIGENCE_SCHEMA,
    query: { businessName: nonEmpty(input.query.businessName, "business_name"), userSuppliedUrls: input.query.userSuppliedUrls.map(canonicalEvidenceUrl) },
    entityCandidates: candidates,
    claims: input.claims.map((claim) => {
      const value = validateClaim(claim, evidenceIds);
      if (value.kind !== "creative" && value.evidenceIds.some((id) => input.evidence.find((item) => item.id === id)?.sourceRole === "external_context")) throw new Error("external_context_cannot_support_brand_fact");
      return value;
    }),
    entityResolution: resolveEntity(candidates),
  };
}

function usableClaim(claim: BrandIntelligenceClaim) {
  return (claim.status === "observed" || claim.status === "confirmed") && claim.confidence !== "low";
}

function claimQuestion(key: string, kind: BrandClaimKind): ResearchQuestion {
  if (kind === "regulated") return { code: "regulated_ambiguity", key, prompt: `Please confirm the exact regulated claim “${key}” before Kely uses it.` };
  if (kind === "offer" || kind === "price") return { code: "offer_ambiguity", key, prompt: `Please confirm the current ${kind === "price" ? "price" : "offer"} for “${key}”.` };
  return { code: "missing_fact", key, prompt: `What is the exact factual value for “${key}”?` };
}

export function classifyResearchReadiness(snapshot: BrandIntelligenceSnapshot, requiredFactKeys: string[] = []): ResearchReadiness {
  const questions: ResearchQuestion[] = [];
  if (snapshot.entityResolution.status !== "resolved") questions.push({ code: "entity_conflict", key: "business_identity", prompt: "Which exact business is this? Please share its official website or profile." });

  for (const key of [...new Set(requiredFactKeys)]) {
    const matching = snapshot.claims.filter((claim) => claim.key === key && claim.kind !== "creative");
    if (matching.some((claim) => claim.status === "contradicted")) {
      questions.push({ code: "source_conflict", key, prompt: `Sources disagree about “${key}”. Which value is current?` });
      continue;
    }
    if (!matching.some(usableClaim)) questions.push(claimQuestion(key, matching[0]?.kind ?? "fact"));
  }

  for (const asset of snapshot.requiredAssets.filter((item) => !item.available)) {
    questions.push({ code: "missing_asset", key: asset.id, prompt: `Please upload the exact ${asset.label}; Kely must not recreate or guess it.` });
  }

  return { ready: questions.length === 0, questions: questions.slice(0, 3), kelyDecides: [...CREATIVE_DEFAULTS] };
}

export type { BrandIntelligenceSnapshot, EntityCandidate, RequiredAsset };
