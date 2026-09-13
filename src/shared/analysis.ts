import type { ArtDirection } from "./art-direction";
import type { CostEvidence, GenerationOrigin } from "./contracts";
export interface AnalysisProposal {
  summary: string;
  observations: { materialId: string; evidence: string; purpose: "logo" | "graphic" | "screenshot" | "reference"; confidence: "high" | "medium" | "low" }[];
  limitations: string[];
  missingOriginals: string[];
  direction: ArtDirection;
  fontNotice: string;
}
export interface AnalysisView {
  id: string; status: "quoted" | "queued" | "running" | "completed" | "failed" | "uncertain";
  brandVersion: number; credits: number; origin: GenerationOrigin; createdAt: string; expiresAt: string;
  selected: { id: string; label: string; role: "original" | "reference"; width: number; height: number; derivativeHash: string }[];
  guidance: string; proposal?: AnalysisProposal; cost?: CostEvidence; error?: string; applied: boolean;
}
