import { createHash } from "node:crypto";
import sharp from "sharp";
import type { AnalysisInput } from "./providers/analysis";
import { readBrand, readBrandMaterial } from "./brand";
import { requireCondition } from "./errors";

export async function researchMaterialInput(ownerId: string, materialIds: string[], guidance: string): Promise<AnalysisInput | null> {
  requireCondition(materialIds.length <= 3 && new Set(materialIds).size === materialIds.length, "research_material_input", "Choose up to three distinct images.", 422);
  if (!materialIds.length) return null;
  const brand = await readBrand(ownerId);
  const selected: AnalysisInput["selected"] = [];
  for (const id of materialIds) {
    const expected = brand.materials.find((item) => item.id === id && item.kind === "image");
    requireCondition(expected?.contentHash, "research_material_input", "Only active images from your Brand workspace can be analyzed.", 404);
    const original = await readBrandMaterial(ownerId, id);
    requireCondition(original.view.version === expected.version && original.view.contentHash === expected.contentHash, "material_unavailable", "A selected material changed before research started.", 409);
    const { data, info } = await sharp(original.bytes, { limitInputPixels: 16_000_000, failOn: "warning" }).resize({ width: 1536, height: 1536, fit: "inside", withoutEnlargement: true }).flatten({ background: "#FFFFFF" }).jpeg({ quality: 90, chromaSubsampling: "4:4:4" }).toBuffer({ resolveWithObject: true });
    requireCondition(data.length <= 1_048_576, "analysis_image_large", "This image needs a smaller analysis copy. No AI has been called.", 422);
    selected.push({ id, label: expected.label, role: expected.role, version: expected.version, originalHash: expected.contentHash, derivativeHash: createHash("sha256").update(data).digest("hex"), width: info.width, height: info.height, dataUrl: `data:image/jpeg;base64,${data.toString("base64")}` });
  }
  return { selected, guidance: guidance.slice(0, 2000), rules: structuredClone(brand.rules) };
}
