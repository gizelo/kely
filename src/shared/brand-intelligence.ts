export const BRAND_INTELLIGENCE_SCHEMA = "brand-intelligence.v1" as const;

export type IntelligenceConfidence = "low" | "medium" | "high";
export type IntelligenceStatus = "observed" | "proposed" | "confirmed" | "contradicted";
export type EvidenceSourceKind = "website" | "social" | "directory" | "user" | "upload";
export type EvidenceRole = "official" | "external_context" | "user_provided";
export type ResearchStage = "queued" | "resolving" | "fetching" | "extracting" | "strategizing" | "checking" | "review_ready" | "needs_input" | "partial" | "failed" | "uncertain";

/** An excerpt is inert evidence. It is never an instruction or a source-discovery input. */
export interface BrandEvidenceRecord {
  id: string;
  sourceKind: EvidenceSourceKind;
  sourceRole: EvidenceRole;
  sourceUrl: string;
  excerpt: string;
  span: { start: number; end: number };
  contentHash: string;
  fetchedAt: string;
}

export type CreativeProposalKey = "audience" | "cta" | "mood" | "palette" | "font" | "layout";
export type BrandClaimKind = "fact" | "offer" | "price" | "regulated" | "creative";

export interface BrandIntelligenceClaim {
  key: string;
  kind: BrandClaimKind;
  value: string;
  status: IntelligenceStatus;
  confidence: IntelligenceConfidence;
  evidenceIds: string[];
}

export interface EntityCandidate {
  id: string;
  displayName: string;
  canonicalUrl: string;
  evidenceIds: string[];
  signals: {
    userSuppliedUrl: boolean;
    officialSiteClaim: boolean;
    exactNameMatch: boolean;
    crossLinkedProfile: boolean;
  };
}

export interface ResearchSearchResult {
  id: string;
  title: string;
  url: string;
  snippet: string;
  sourceRole: "official" | "external_context";
  signals: EntityCandidate["signals"];
}

export interface BrandResearchInput {
  businessName: string;
  category?: string;
  location?: string;
  idea: string;
  platform: "instagram" | "linkedin";
  userSuppliedUrls: string[];
}

export type EntityResolution =
  | { status: "resolved"; candidateId: string; confidence: IntelligenceConfidence; reason: string }
  | { status: "ambiguous" | "not_found"; candidateId: null; confidence: "low"; reason: string };

export interface RequiredAsset {
  id: string;
  label: string;
  available: boolean;
}

export interface BrandIntelligenceSnapshot {
  schemaVersion: typeof BRAND_INTELLIGENCE_SCHEMA;
  id: string;
  version: number;
  createdAt: string;
  query: { businessName: string; userSuppliedUrls: string[] };
  evidence: BrandEvidenceRecord[];
  entityCandidates: EntityCandidate[];
  entityResolution: EntityResolution;
  claims: BrandIntelligenceClaim[];
  requiredAssets: RequiredAsset[];
}

export interface ResearchQuestion {
  code: "entity_conflict" | "missing_fact" | "missing_asset" | "regulated_ambiguity" | "offer_ambiguity" | "source_conflict";
  key: string;
  prompt: string;
}

export interface ResearchReadiness {
  ready: boolean;
  questions: ResearchQuestion[];
  kelyDecides: CreativeProposalKey[];
}
