import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { privateStorage, usesCloudStorage } from "./private-storage";
import path from "node:path";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { strToU8, zipSync } from "fflate";
import type {
  GenerationOrigin,
  PublicationView,
  SlideView,
} from "../shared/contracts";
import { config } from "./config";
import { pool } from "./db";
import { AppError, requireCondition } from "./errors";
import { ensureFontRuntime } from "./font-runtime";
import {
  LayoutOverflow,
  UnsupportedGlyph,
  layoutApprovedText,
  type MeasuredTextLayout,
} from "./layout";
import { composeArtSlide, measureArtSlide } from "./art-renderer";
import { readBrandMaterial } from "./brand";
import { composeCreativeSlide, measureCreativeSlide } from "./creative-renderer";
import { isCreativePolicy } from "../shared/creative-intent";

const compositionCanvas = { width: 1080, height: 1350 };
const compositionPalettes = {
  indigo: {
    background: "#F0EDFF",
    accent: "#4938A2",
    ornament: "#DDD4FB",
    text: "#292438",
  },
  forest: {
    background: "#EDF3E9",
    accent: "#285641",
    ornament: "#D5E3CE",
    text: "#27372B",
  },
  rose: {
    background: "#FBEDEA",
    accent: "#923F53",
    ornament: "#EED2D5",
    text: "#452F36",
  },
  sand: {
    background: "#F8F1E4",
    accent: "#745128",
    ornament: "#EBDDCA",
    text: "#423728",
  },
};

function originDescription(origin: GenerationOrigin = "fixture") {
  return origin === "openai"
    ? "OpenAI copy"
    : origin === "ai_preview"
      ? "Simulated Responses copy; no live AI call"
      : "Fixture copy; not AI quality evidence";
}

export function exportOriginNotice(state: PublicationView) {
  return [
    "Kely local export — provenance",
    `Caption: ${originDescription(state.captionOrigin)}.`,
    ...state.slides.map(
      (slide) =>
        `Slide ${slide.index + 1}: ${originDescription(slide.copyOrigin)}. Visual: ${slide.artworkId ? state.artwork?.origin === "openai" ? "AI-generated illustration with deterministic typography" : "simulated illustration with deterministic typography" : slide.visualOrigin === "deterministic" ? "deterministic typography; not AI artwork" : "fixture example; not AI artwork"}.`,
    ),
    "Billing is locally simulated. This export is not production acceptance.",
  ].join("\n");
}

export async function measureComposedSlide(
  state: PublicationView,
  slide: SlideView,
) {
  const art = slide.artDirection ?? state.artDirection;
  if (art) {
    try {
      if (isCreativePolicy(state.designPolicy)) {
        requireCondition(slide.creativePlan, "creative_plan_missing", "Prepare and confirm the slide's creative plan before composition.", 409);
        const measured = await measureCreativeSlide({ art, plan: slide.creativePlan, title: slide.title, body: slide.body, index: slide.index, slideCount: state.slideCount });
        return { ...measured, palette: { background: measured.background, accent: measured.direction.palette.accent, ornament: measured.direction.palette.muted, text: measured.foreground } };
      }
      const measured = await measureArtSlide({ art, title: slide.title, body: slide.body, index: slide.index, slideCount: state.slideCount });
      return { ...measured, palette: { background: measured.direction.palette.background, accent: measured.direction.palette.accent, ornament: measured.direction.palette.muted, text: measured.direction.palette.foreground } };
    }
    catch (error) {
      if (error instanceof LayoutOverflow) throw new AppError("layout_overflow", `Slide ${slide.index + 1}: ${error.message}`, 422);
      if (error instanceof UnsupportedGlyph) throw new AppError("unsupported_glyph", `Slide ${slide.index + 1}: ${error.message}`, 422);
      throw error;
    }
  }
  const palette =
    compositionPalettes[
      slide.palette ?? state.brandPalette ?? (state.platform === "instagram" ? "forest" : "indigo")
    ];
  const sections = [
    {
      text: "KELY / LOCAL PREVIEW",
      safeArea: { x: 94, y: 110, width: 800, height: 44 },
      fontSizePx: 22,
      color: palette.accent,
    },
    {
      text: slide.title,
      safeArea: { x: 92, y: 236, width: 896, height: 360 },
      fontSizePx: 64,
      color: palette.accent,
    },
    {
      text: slide.body,
      safeArea: { x: 96, y: 648, width: 888, height: 414 },
      fontSizePx: 36,
      color: palette.text,
    },
    {
      text: `${slide.copyOrigin === "openai" ? "OPENAI COPY" : slide.copyOrigin === "ai_preview" ? "SIMULATED COPY" : "FIXTURE COPY"} / DETERMINISTIC DESIGN\n${slide.index + 1} / ${state.slideCount}`,
      safeArea: { x: 96, y: 1172, width: 888, height: 80 },
      fontSizePx: 20,
      color: palette.accent,
    },
  ];
  const layers: MeasuredTextLayout[] = [];
  try {
    for (const section of sections)
      layers.push(
        await layoutApprovedText({ ...section, canvas: compositionCanvas }),
      );
  } catch (error) {
    if (error instanceof LayoutOverflow)
      throw new AppError(
        "layout_overflow",
        `Slide ${slide.index + 1} needs shorter copy before approval. ${error.message}`,
        422,
      );
    if (error instanceof UnsupportedGlyph)
      throw new AppError(
        "unsupported_glyph",
        `Slide ${slide.index + 1}: ${error.message}`,
        422,
      );
    throw error;
  }
  return { canvas: compositionCanvas, palette, layers };
}

export async function composeSlideImage(
  state: PublicationView,
  slide: SlideView,
) {
  requireCondition(!state.artDirection, "original_resolution_required", "Brand-aware originals require the owner-scoped composer.", 409);
  const { palette, layers } = await measureComposedSlide(state, slide);
  requireCondition(palette, "invalid_art_direction", "The legacy palette is unavailable.", 409);
  const decoration = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350"><rect width="1080" height="1350" fill="${palette.background}"/><circle cx="1030" cy="82" r="202" fill="${palette.ornament}"/><circle cx="1090" cy="1358" r="266" fill="${palette.ornament}"/><path d="M96 1126H984" stroke="${palette.accent}" stroke-opacity="0.2"/></svg>`,
  );
  return sharp(decoration)
    .composite(
      layers.map((layer) => ({
        input: layer.png,
        left: layer.bounds.x,
        top: layer.bounds.y,
      })),
    )
    .png()
    .toBuffer();
}

export async function validateComposedCopy(
  state: PublicationView,
): Promise<void> {
  requireCondition(
    state.slides.length > 0,
    "not_ready",
    "There is no proposed slide copy to approve.",
    409,
  );
  for (const slide of state.slides) await measureComposedSlide(state, slide);
}

export async function renderComposedSlide(
  ownerId: string,
  state: PublicationView,
  slide: SlideView,
  operationId: string,
): Promise<string> {
  requireCondition(
    state.outlineApproved,
    "content_approval_required",
    "Approve the complete copy before composing a visual.",
    409,
  );
  return renderValidatedSlide(ownerId, state, slide, operationId);
}

export async function renderCreationSlide(ownerId: string, state: PublicationView, slide: SlideView, operationId: string) {
  requireCondition(state.creation?.operationId === operationId && state.creation.status === "working" && state.creation.phase === "composition", "creation_not_ready", "This visual must belong to the active complete-creation operation.", 409);
  if (slide.artworkId) await preflightCreationArtwork(state, slide);
  else await validateComposedCopy({ ...state, slides: [slide] });
  return renderValidatedSlide(ownerId, state, slide, operationId);
}

export async function preflightCreationArtwork(state: PublicationView, slide: SlideView) {
  requireCondition(state.creation && state.artDirection && slide.creativePlan, "artwork_scope_conflict", "The illustration requires a complete creation plan.", 409);
  return measureCreativeSlide({ art: slide.artDirection ?? state.artDirection, plan: slide.creativePlan, title: slide.title, body: slide.body, index: slide.index, slideCount: state.slideCount, artworkLayout: state.creation.artworkLayout }, true);
}

async function renderValidatedSlide(ownerId: string, state: PublicationView, slide: SlideView, operationId: string) {
  let bytes: Buffer;
  const art = slide.artDirection ?? state.artDirection;
  if (art) {
    await measureComposedSlide(state, slide);
    const originals = await Promise.all(art.originals.map(async (expected) => {
      const original = await readBrandMaterial(ownerId, expected.id);
      return { id: original.view.id, version: original.view.version, hash: original.view.contentHash!, bytes: original.bytes };
    }));
    const input = { art, title: slide.title, body: slide.body, index: slide.index, slideCount: state.slideCount };
    let artwork: Buffer | undefined;
    if (slide.artworkId) {
      requireCondition(state.creation && state.artwork?.assetId === slide.artworkId, "artwork_scope_conflict", "The illustration does not belong to this creation.", 409);
      artwork = (await readAsset(ownerId, slide.artworkId)).bytes;
      requireCondition(createHash("sha256").update(artwork).digest("hex") === state.artwork.hash, "artwork_integrity", "The saved illustration failed its integrity check.", 409);
    }
    bytes = isCreativePolicy(state.designPolicy) ? (await composeCreativeSlide({ ...input, plan: slide.creativePlan!, artworkLayout: state.creation?.artworkLayout }, originals, artwork)).png : (await composeArtSlide(input, originals)).png;
  } else bytes = await composeSlideImage(state, slide);
  return persistSlideAsset(ownerId, state.id, slide.id, operationId, bytes);
}

export function escapeXml(value: string) {
  return value.replace(
    /[<>&"']/g,
    (character) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[character]!,
  );
}

export function wrapText(text: string, width: number, maximum: number) {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const chunks =
      Array.from(word).length > width
        ? Array.from(word).reduce<string[]>((parts, character, index) => {
            const part = Math.floor(index / width);
            parts[part] = (parts[part] ?? "") + character;
            return parts;
          }, [])
        : [word];
    for (const chunk of chunks) {
      if (Array.from(`${line} ${chunk}`).length > width && line) {
        lines.push(line);
        line = chunk;
      } else line = line ? `${line} ${chunk}` : chunk;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maximum)
    return [
      ...lines.slice(0, maximum - 1),
      `${lines[maximum - 1].slice(0, width - 1)}…`,
    ];
  return lines;
}

function stableAssetId(operationId: string, slideId: string) {
  const hex = createHash("sha256")
    .update(`${operationId}:${slideId}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export async function renderSlide(
  ownerId: string,
  state: PublicationView,
  slide: SlideView,
  operationId: string,
  variation = 0,
) {
  if (state.brandBrief) return renderComposedSlide(ownerId, state, slide, operationId);
  await ensureFontRuntime();
  const colors = [
    ["#eeedff", "#4432ad", "#d0c7ff"],
    ["#e8f3ee", "#164d3d", "#b5d8cb"],
    ["#fff0e5", "#9e442d", "#edc6aa"],
  ];
  const palette =
    colors[
      (state.platform === "instagram" ? 1 + variation : variation) %
        colors.length
    ];
  const title = wrapText(slide.title, 24, 4);
  const body = wrapText(slide.body, 43, 7);
  const titleMarkup = title
    .map(
      (line, index) =>
        `<tspan x="92" y="${275 + index * 82}">${escapeXml(line)}</tspan>`,
    )
    .join("");
  const bodyY = Math.max(660, 310 + title.length * 82);
  const bodyMarkup = body
    .map(
      (line, index) =>
        `<tspan x="96" y="${bodyY + index * 48}">${escapeXml(line)}</tspan>`,
    )
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350" viewBox="0 0 1080 1350"><rect width="1080" height="1350" fill="${palette[0]}"/><circle cx="950" cy="190" r="310" fill="${palette[2]}" opacity="0.6"/><circle cx="990" cy="1220" r="265" fill="${palette[1]}" opacity="0.09"/><rect x="92" y="108" width="58" height="8" rx="4" fill="${palette[1]}"/><text x="173" y="123" font-family="Arial, sans-serif" font-size="25" font-weight="700" letter-spacing="3" fill="${palette[1]}">KELY / EXAMPLE</text><text font-family="Arial, sans-serif" font-size="72" font-weight="700" fill="${palette[1]}">${titleMarkup}</text><text font-family="Arial, sans-serif" font-size="35" fill="#2c303b">${bodyMarkup}</text><line x1="94" y1="1150" x2="986" y2="1150" stroke="${palette[1]}" opacity="0.2"/><text x="96" y="1210" font-family="Arial, sans-serif" font-size="25" fill="${palette[1]}">FIXTURE · NOT AI GENERATED</text><text x="984" y="1210" text-anchor="end" font-family="Arial, sans-serif" font-size="25" fill="${palette[1]}">${slide.index + 1} / ${state.slideCount}</text></svg>`;
  const bytes = await sharp(Buffer.from(svg)).png().toBuffer();
  return persistSlideAsset(ownerId, state.id, slide.id, operationId, bytes);
}

export async function persistSlideAsset(
  ownerId: string,
  publicationId: string,
  slideId: string,
  operationId: string,
  bytes: Buffer,
) {
  const id = stableAssetId(operationId, slideId);
  const filename = `${id}.png`;
  if (usesCloudStorage()) {
    await privateStorage(pool).put("asset", filename, bytes, operationId);
  } else {
    await mkdir(config.assetRoot, { recursive: true, mode: 0o700 });
    const destination = path.join(config.assetRoot, filename);
    const temporary = `${destination}.${process.pid}.tmp`;
    await writeFile(temporary, bytes, { mode: 0o600 });
    await rename(temporary, destination);
  }
  await pool.query(
    "INSERT INTO asset(id,owner_id,publication_id,filename,mime_type) VALUES($1,$2,$3,$4,'image/png') ON CONFLICT(id) DO NOTHING",
    [id, ownerId, publicationId, filename],
  );
  return id;
}

export async function readAsset(ownerId: string, id: string) {
  const {
    rows: [asset],
  } = await pool.query<{ filename: string; mime_type: string }>(
    "SELECT filename,mime_type FROM asset WHERE id=$1 AND owner_id=$2",
    [id, ownerId],
  );
  requireCondition(asset, "not_found", "That asset is not available.", 404);
  requireCondition(
    /^[a-f0-9-]+\.png$/.test(asset.filename),
    "invalid_asset",
    "The saved asset is invalid.",
    500,
  );
  const bytes = usesCloudStorage()
    ? await privateStorage(pool).get("asset", asset.filename)
    : await readFile(path.join(config.assetRoot, asset.filename));
  requireCondition(bytes, "not_found", "That asset is not available.", 404);
  return {
    bytes,
    contentType: asset.mime_type,
  };
}

export async function exportPublication(
  ownerId: string,
  id: string,
  format: string,
  version?: number,
) {
  const {
    rows: [publication],
  } = await pool.query<{ state: PublicationView }>(
    version
      ? "SELECT v.state FROM publication_version v JOIN publication p ON p.id=v.publication_id WHERE p.id=$1 AND p.owner_id=$2 AND v.version=$3"
      : "SELECT state FROM publication WHERE id=$1 AND owner_id=$2",
    version ? [id, ownerId, version] : [id, ownerId],
  );
  requireCondition(
    publication,
    "not_found",
    "That version is not available.",
    404,
  );
  const state = publication.state;
  if (format === "caption") {
    requireCondition(
      state.caption,
      "not_ready",
      "Prepare the caption first.",
      409,
    );
    return {
      bytes: Buffer.from(
        `${state.caption}\n\n---\n${exportOriginNotice(state)}\n`,
      ),
      contentType: "text/plain; charset=utf-8",
      filename: "kely-caption.txt",
    };
  }
  requireCondition(
    state.slides.length > 0 && state.slides.every((slide) => slide.assetId),
    "not_ready",
    "Finish this version before exporting all visuals.",
    409,
  );
  const images = await Promise.all(
    state.slides.map(
      async (slide) => (await readAsset(ownerId, slide.assetId!)).bytes,
    ),
  );
  if (format === "png")
    return {
      bytes: images[0],
      contentType: "image/png",
      filename: "kely-cover.png",
    };
  if (format === "zip") {
    const files: Record<string, Uint8Array> = {
      "caption.txt": strToU8(state.caption),
      "origin-notice.txt": strToU8(exportOriginNotice(state)),
    };
    images.forEach((bytes, index) => {
      files[`slide-${index + 1}.png`] = bytes;
    });
    return {
      bytes: Buffer.from(zipSync(files)),
      contentType: "application/zip",
      filename: "kely-post.zip",
    };
  }
  const pdf = await PDFDocument.create();
  pdf.setTitle("Kely local post");
  pdf.setSubject(exportOriginNotice(state));
  for (const bytes of images) {
    const image = await pdf.embedPng(bytes);
    pdf
      .addPage([540, 675])
      .drawImage(image, { x: 0, y: 0, width: 540, height: 675 });
  }
  return {
    bytes: Buffer.from(await pdf.save()),
    contentType: "application/pdf",
    filename: "kely-carousel.pdf",
  };
}
