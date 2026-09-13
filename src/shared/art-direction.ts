export interface ArtDirection {
  policy: "art-direction-v1";
  palette: { background: string; foreground: string; accent: string; muted: string };
  headingFont: "sans" | "serif" | "unbounded";
  composition: "editorial" | "split" | "image-led";
  spacing: "open" | "compact";
  logoMaterialId: string | null;
  heroMaterialIds: string[];
}

export interface FrozenOriginal {
  id: string;
  version: number;
  hash: string;
  width: number;
  height: number;
}

export interface FrozenArtDirection {
  direction: ArtDirection;
  originals: FrozenOriginal[];
}
