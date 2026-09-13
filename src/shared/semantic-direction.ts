import type { GenerationOrigin } from "./contracts";

export const semanticTones = ["precise", "warm", "energetic", "calm", "playful", "premium"] as const;
export const visualGrammars = ["editorial-lines", "modular-grid", "soft-organic", "crafted-collage", "bold-geometry"] as const;

export type SemanticTone = typeof semanticTones[number];
export type VisualGrammar = typeof visualGrammars[number];

export interface SemanticDirectionV1 {
  policy: "semantic-direction-v1";
  palette: { background: string; foreground: string; accent: string; muted: string };
  headingFont: "sans" | "serif" | "unbounded";
  spacing: "open" | "compact";
  tone: SemanticTone;
  grammar: VisualGrammar;
  rationale: string;
}

export interface PublicationDirectionProposal {
  direction: SemanticDirectionV1;
  status: "pending" | "accepted";
  proposedBy: GenerationOrigin;
  operationId: string;
  inputHash: string;
  acceptedAt?: string;
}
