import { createHash } from "node:crypto";
import sharp from "sharp";
import type { AnalysisInput } from "./providers/analysis";
import { readBrand, readBrandMaterial } from "./brand";
import { requireCondition } from "./errors";

export const RESEARCH_DERIVATIVE_MAX_EDGE = 1024;
export const RESEARCH_DERIVATIVE_MAX_BYTES = 512 * 1024;
export const RESEARCH_DERIVATIVES_MAX_BYTES = 1536 * 1024;

export async function createResearchDerivative(bytes: Buffer) {
  const { data, info } = await sharp(bytes, { limitInputPixels: 16_000_000, failOn: "warning" }).resize({ width: RESEARCH_DERIVATIVE_MAX_EDGE, height: RESEARCH_DERIVATIVE_MAX_EDGE, fit: "inside", withoutEnlargement: true }).flatten({ background: "#FFFFFF" }).jpeg({ quality: 78, chromaSubsampling: "4:2:0" }).toBuffer({ resolveWithObject: true });
  requireCondition(data.length <= RESEARCH_DERIVATIVE_MAX_BYTES, "analysis_image_large", "This image needs a smaller analysis copy. No AI has been called.", 422);
  return { data, width: info.width, height: info.height };
}

export async function researchMaterialInput(ownerId: string, materialIds: string[], guidance: string): Promise<AnalysisInput | null> {
  requireCondition(materialIds.length <= 3 && new Set(materialIds).size === materialIds.length, "research_material_input", "Choose up to three distinct images.", 422);
  if (!materialIds.length) return null;
  const brand = await readBrand(ownerId);
  const selected: AnalysisInput["selected"] = [];
  let derivativeBytes = 0;
  for (const id of materialIds) {
    const expected = brand.materials.find((item) => item.id === id && item.kind === "image");
    requireCondition(expected?.contentHash, "research_material_input", "Only active images from your Brand workspace can be analyzed.", 404);
    const original = await readBrandMaterial(ownerId, id);
    requireCondition(original.view.version === expected.version && original.view.contentHash === expected.contentHash, "material_unavailable", "A selected material changed before research started.", 409);
    const derivative = await createResearchDerivative(original.bytes);
    derivativeBytes += derivative.data.length;
    selected.push({ id, label: expected.label, role: expected.role, version: expected.version, originalHash: expected.contentHash, derivativeHash: createHash("sha256").update(derivative.data).digest("hex"), width: derivative.width, height: derivative.height, dataUrl: `data:image/jpeg;base64,${derivative.data.toString("base64")}` });
  }
  requireCondition(derivativeBytes <= RESEARCH_DERIVATIVES_MAX_BYTES, "analysis_images_large", "These images need smaller analysis copies. No AI has been called.", 422);
  return { selected, guidance: guidance.slice(0, 2000), rules: structuredClone(brand.rules) };
}
