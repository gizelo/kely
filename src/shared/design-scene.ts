export type NormalizedZone = { x: number; y: number; width: number; height: number };

export type DesignPrimitive =
  | { kind: "rect"; zone: NormalizedZone; color: "accent" | "muted" | "foreground"; opacity: number; radius: number; rotation: number }
  | { kind: "ellipse"; zone: NormalizedZone; color: "accent" | "muted" | "foreground"; opacity: number }
  | { kind: "rule"; zone: NormalizedZone; color: "accent" | "muted" | "foreground"; opacity: number };

export interface DesignSceneV1 {
  version: 1;
  seed: string;
  composition: "editorial-offset" | "signal-grid" | "evidence-split" | "structured-stack" | "action-frame";
  titleZone: NormalizedZone;
  bodyZone: NormalizedZone;
  materialZone: (NormalizedZone & { id: string; role: "graphic" | "evidence"; fit: "contain" }) | null;
  primitives: DesignPrimitive[];
}

export interface DesignSceneV2 {
  version: 2;
  seed: string;
  composition: "editorial-offset" | "signal-grid" | "evidence-split" | "structured-stack" | "action-frame";
  grammar: import("./semantic-direction").VisualGrammar;
  tone: import("./semantic-direction").SemanticTone;
  titleZone: NormalizedZone;
  bodyZone: NormalizedZone;
  materialZone: null;
  primitives: DesignPrimitive[];
}

export type DesignScene = DesignSceneV1 | DesignSceneV2;
