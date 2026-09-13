import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { composeCreativeSlide } from "../src/server/creative-renderer";
import type { CreativePlan } from "../src/shared/creative-intent";

async function main() {
const source = resolve(".local/benchmarks/girex-source-2026-09-11");
const destination = resolve(".local/benchmarks/girex-creative-geometry-2026-09-11");
const files = [
  { id: "bd1f5082-320e-4867-ab23-24b1baf5b1fa", file: "glass-cubes.png" },
  { id: "d56a3cce-4881-4632-82a2-9879c2029afb", file: "desktop-interface.png" },
];
const originals = await Promise.all(files.map(async ({ id, file }) => {
  const bytes = await readFile(resolve(source, file));
  const metadata = await sharp(bytes).metadata();
  return { id, bytes, version: 1, hash: createHash("sha256").update(bytes).digest("hex"), width: metadata.width!, height: metadata.height! };
}));
const art = {
  direction: {
    policy: "art-direction-v1" as const,
    palette: { background: "#101114", foreground: "#FFFFFF", accent: "#3E50D6", muted: "#555862" },
    headingFont: "unbounded" as const, composition: "image-led" as const, spacing: "open" as const,
    logoMaterialId: null, heroMaterialIds: files.map(({ id }) => id),
  },
  originals: originals.map(({ bytes: _bytes, ...metadata }) => metadata),
};
const slides: { title: string; body: string; plan: CreativePlan }[] = [
  { title: "A closer look\nat Girex.", body: "From visual identity to the product interface.", plan: { purpose: "hook", recipe: "graphic-stage", materialId: files[0].id, heading: "large", background: "background", alignment: "left", rationale: "Introduce the visual language with the supplied glass graphic." } },
  { title: "Inside the\ninterface.", body: "A look at the desktop design. Shown values are part of the source screenshot, not a current offer.", plan: { purpose: "proof", recipe: "image-evidence", materialId: files[1].id, heading: "medium", background: "background", alignment: "left", rationale: "Show the intact interface as visual evidence, separate from decoration." } },
  { title: "Follow what\ncomes next.", body: "More looks at Girex and its design.", plan: { purpose: "closing", recipe: "closing", materialId: "", heading: "large", background: "foreground", alignment: "center", rationale: "End with a quiet typographic invitation instead of repeating the cover." } },
];
await mkdir(destination, { recursive: true });
const evidence = [];
for (const [index, slide] of slides.entries()) {
  const result = await composeCreativeSlide({ ...slide, art, index, slideCount: slides.length }, originals);
  const path = resolve(destination, `slide-${index + 1}.png`);
  await writeFile(path, result.png);
  evidence.push({ path, copy: { title: slide.title, body: slide.body }, plan: result.plan, placements: result.placements, text: result.text });
}
await writeFile(resolve(destination, "evidence.json"), JSON.stringify({ origin: "root-authored diagnostic copy and plans; no AI generation, no database mutation", evidence }, null, 2));
console.log(JSON.stringify({ destination, slides: evidence.length, providerCalls: 0 }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
