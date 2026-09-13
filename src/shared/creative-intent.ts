export interface CreativePlan {
  purpose: "hook" | "explain" | "proof" | "process" | "closing";
  recipe: "type-poster" | "graphic-stage" | "split-proof" | "image-evidence" | "closing";
  materialId: string;
  heading: "large" | "medium";
  background: "background" | "foreground";
  alignment: "left" | "center";
  rationale: string;
  scene?: import("./design-scene").DesignScene;
}

export function isCreativePolicy(value: string | undefined) { return value === "creative-intent-v1" || value === "creative-intent-v2" || value === "creative-intent-v3" || value === "creative-intent-v4" || value === "creative-intent-v5" || value === "creative-intent-v6" || value === "creative-intent-v7" || value === "creative-intent-v8" || value === "creative-intent-v9"; }

export interface BriefField {
  value: string;
  basis: "user" | "business" | "proposed";
  sourceId: string;
  evidence: string;
}

export interface ProposedBrief {
  audience: BriefField;
  desiredAction: BriefField;
  facts: BriefField[];
  requiredFacts: string[];
}

export interface SelectedAnalysisContext {
  id: string;
  origin: "ai_preview" | "openai";
  summary: string;
  observations: import("./analysis").AnalysisProposal["observations"];
  limitations: string[];
}
