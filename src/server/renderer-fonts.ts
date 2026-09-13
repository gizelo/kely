import path from "node:path";
import { rendererProjectRoot } from "./renderer-root";

export type RendererFont = "legacy" | "sans" | "serif" | "unbounded";
export const rendererFontsDirectory = path.join(rendererProjectRoot!, "assets/fonts");
export const rendererFonts = {
  legacy: { family: "Arial Unicode MS", file: "/Library/Fonts/Arial Unicode.ttf", hash: null },
  sans: { family: "Inter", file: path.join(rendererFontsDirectory, "inter/Inter.ttf"), hash: "29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031" },
  serif: { family: "Source Serif 4", file: path.join(rendererFontsDirectory, "source-serif-4/SourceSerif4.ttf"), hash: "97b2d4da6e3cb494b5a1e66ae176914d852ccabef49e0c02c0df25f3e39aca0b" },
  unbounded: { family: "Unbounded", file: path.join(rendererFontsDirectory, "unbounded/Unbounded.ttf"), hash: "323b511be380c8d474ef030686b71aedde501f8d9cd46da558b7c40454372c3f" },
} as const;
