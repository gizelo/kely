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
  { id: "d56a3cce-4881-4632-82a2-9879c2029afb", file: "desktop-interface.png" },
  { id: "33200f9a-d05e-46f1-8f30-87e642516ee6", file: "phone-interface.png" },
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
  { title: "Meet Girex.", body: "Manage wallets. Explore crypto. One interface for both.", plan: { purpose: "hook", recipe: "type-poster", materialId: "", heading: "large", background: "background", alignment: "left", rationale: "Open with a restrained product statement and no invented symbols." } },
  { title: "Inside the\ninterface.", body: "A look at the desktop design. Shown values are part of the source screenshot, not a current offer.", plan: { purpose: "proof", recipe: "image-evidence", materialId: files[0].id, heading: "medium", background: "background", alignment: "left", rationale: "Show the intact interface as visual evidence, separate from decoration." } },
  { title: "Explore Girex\non mobile.", body: "See the phone interface, then explore the concept at girex.io.", plan: { purpose: "closing", recipe: "split-proof", materialId: files[1].id, heading: "medium", background: "background", alignment: "left", rationale: "Close with the supplied phone interface and a direct, restrained invitation." } },
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
