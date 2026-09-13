export type BrandPalette = "indigo" | "forest" | "rose" | "sand";
export type SourceStrategy = "use_materials" | "use_preferences" | "decide_for_me";
export type BrandField = "audience" | "palette" | "headlines" | "artDirection" | "voice" | "sourceStrategy";
export type BrandValue = string | null | import("./art-direction").ArtDirection;
export interface BrandRules { audience: string; palette: BrandPalette | null; headlines: "default" | "shorter"; artDirection?: import("./art-direction").ArtDirection | null; voice?: string; sourceStrategy?: SourceStrategy | null }
export interface BrandMaterial {
  id: string; role: "reference" | "original"; kind: "image" | "link"; label: string;
  sourceUrl: string | null; version: number; contentHash: string | null;
  width: number | null; height: number | null; bytes: number; createdAt: string; sourceId?: string | null;
}
export interface BrandEvent {
  id: string; field: BrandField; before: BrandValue; after: BrandValue;
  version: number; undoOf: string | null; createdAt: string;
}
export interface BrandView { version: number; rules: BrandRules; materials: BrandMaterial[]; events: BrandEvent[] }
export interface BrandImportOutcome {
  status: "imported" | "partial" | "fallback";
  imported: number;
  message: string;
  sourceUrl: string;
}
export type BrandSourceKind = "website" | "social" | "direct_url" | "upload" | "legacy";
export type BrandSourceState = "available" | "partial" | "needs_upload";
export type BrandSourceOutcomeCode = "upload_normalized" | "direct_image_imported" | "page_preview_imported" | "page_preview_missing" | "social_preview_partial" | "social_preview_missing";
export interface BrandSource {
  id: string; kind: BrandSourceKind; role: BrandMaterial["role"]; label: string; state: BrandSourceState;
  outcomeCode: BrandSourceOutcomeCode | "legacy_material"; submittedUrl: string | null; canonicalUrl: string | null;
  acquiredAt: string | null; createdAt: string; fallbackFor: string | null; materials: BrandMaterial[];
}
export interface SourceGap { code: string; message: string; sourceId?: string; materialId?: string }
export interface SourceCompleteness {
  status: "blocked" | "ready_with_recommendations" | "ready";
  blockers: SourceGap[]; recommendations: SourceGap[]; optional: SourceGap[]; selectableAnalysisMaterialIds: string[];
}
export type SourceNextAction = "add_material" | "upload_screenshots" | "analyze_references" | "review_proposal" | "continue";
export interface SourceBundleView {
  brandVersion: number; strategy: SourceStrategy | null; sources: BrandSource[];
  preferences: { field: BrandField; state: "confirmed" | "proposed"; value: BrandValue; evidence: "user" | "analysis"; eventId?: string; analysisId?: string }[];
  completeness: SourceCompleteness;
  summary: { learned: string[]; unavailable: string[]; proposed: string[]; nextAction: SourceNextAction };
}
export interface BrandImportResult { brand: BrandView; outcome: BrandImportOutcome; source?: BrandSource; bundle?: SourceBundleView }
export interface PublicationBrief {
  audience: string; direction: BrandPalette | "decide" | null;
  requiredMaterialIds: string[]; noPhoto: boolean;
  blockingFacts: string[]; factResolution: string;
}
export interface FrozenBrand {
  version: number; rules: BrandRules; materials: BrandMaterial[]; hash: string;
  brief: PublicationBrief; rendererPolicy: "brand-palette-v1" | "art-direction-v1";
  art?: import("./art-direction").FrozenArtDirection;
}
export interface ReadinessView { ready: boolean; blockers: { code: string; message: string }[] }
export type MemoryInterpretation =
  | { status: "durable"; field: "palette" | "headlines"; value: BrandPalette | "shorter"; effect: string }
  | { status: "local"; effect: string }
  | { status: "clarification"; effect: string };
