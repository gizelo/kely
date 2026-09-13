import { z } from "zod";
import type { ArtDirection, FrozenArtDirection } from "../shared/art-direction";
import type { BrandMaterial } from "../shared/brand";
import { requireCondition } from "./errors";

const hex = z.string().regex(/^#[a-f\d]{6}$/i).transform((value) => value.toUpperCase());
export const artDirectionSchema = z.object({
  policy: z.literal("art-direction-v1"),
  palette: z.object({ background: hex, foreground: hex, accent: hex, muted: hex }).strict(),
  headingFont: z.enum(["sans", "serif", "unbounded"]),
  composition: z.enum(["editorial", "split", "image-led"]),
  spacing: z.enum(["open", "compact"]),
  logoMaterialId: z.uuid().nullable(),
  heroMaterialIds: z.array(z.uuid()).max(2),
}).strict();

function luminance(hexColor: string) {
  const [r, g, b] = [1, 3, 5].map((offset) => Number.parseInt(hexColor.slice(offset, offset + 2), 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

export function contrastRatio(first: string, second: string) {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

export function validateArtDirection(value: unknown): ArtDirection {
  const parsed = artDirectionSchema.safeParse(value);
  requireCondition(parsed.success, "invalid_art_direction", "Choose supported palette roles, bundled fonts and original image placements.");
  const direction = parsed.data;
  requireCondition(contrastRatio(direction.palette.background, direction.palette.foreground) >= 4.5, "palette_contrast", "The text color needs at least 4.5:1 contrast against the background.");
  const ids = [...direction.heroMaterialIds, ...(direction.logoMaterialId ? [direction.logoMaterialId] : [])];
  requireCondition(new Set(ids).size === ids.length, "invalid_art_direction", "Choose distinct original images for logo and imagery.");
  requireCondition(direction.composition === "editorial" || direction.heroMaterialIds.length > 0, "original_required", "This composition needs at least one original image. Choose editorial for a typography-only direction.");
  return structuredClone(direction);
}

export function freezeArtDirection(value: unknown, materials: BrandMaterial[], noPhoto: boolean): FrozenArtDirection {
  const direction = validateArtDirection(value);
  const ids = [...direction.heroMaterialIds, ...(direction.logoMaterialId ? [direction.logoMaterialId] : [])];
  const originals = ids.map((id) => {
    const material = materials.find((item) => item.id === id);
    requireCondition(material?.role === "original" && material.kind === "image" && material.contentHash && material.width && material.height,
      "original_unavailable", "Selected artwork must be an available original image, not a reference or an unfetched link.", 409);
    return { id, version: material.version, hash: material.contentHash, width: material.width, height: material.height };
  });
  requireCondition(!noPhoto || direction.heroMaterialIds.length === 0, "photo_conflict", "This post excludes photos. Confirm a typography-only direction; the original logo may remain.", 409);
  return { direction, originals };
}

export function withoutHeroImages(direction: ArtDirection): ArtDirection {
  return { ...structuredClone(direction), composition: "editorial", heroMaterialIds: [] };
}
