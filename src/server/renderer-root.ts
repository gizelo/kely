import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const rendererProjectRoot = [process.cwd(), sourceRoot].find((root) =>
  existsSync(path.join(root, "scripts/font-worker.ts")) && existsSync(path.join(root, "assets/fonts/inter/Inter.ttf")),
);
if (!rendererProjectRoot) throw new Error("The private renderer runtime must run from the Kely project with its bundled fonts.");
