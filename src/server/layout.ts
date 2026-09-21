import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import sharp from "sharp";
import { ensureFontRuntime } from "./font-runtime";
import { rendererFonts, type RendererFont } from "./renderer-fonts";
import { isolatedTextLayout } from "./font-process";

const executeFile = promisify(execFile);
const fontScanner = process.platform === "darwin" ? "/opt/homebrew/bin/fc-scan" : "/usr/bin/fc-scan";
const maximumTextBytes = 16_384;

export interface TextRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ApprovedTextLayoutInput {
  text: string;
  canvas: { width: number; height: number };
  safeArea: TextRectangle;
  fontSizePx: number;
  color?: string;
  font?: RendererFont;
  weight?: "regular" | "bold";
  alignment?: "left" | "center";
}

export interface MeasuredTextLayout {
  approvedText: string;
  canvas: { width: number; height: number };
  safeArea: TextRectangle;
  bounds: TextRectangle;
  font: { family: string; file: string; sizePx: number; dpi: 72 };
  png: Buffer;
}

export class LayoutOverflow extends Error {
  readonly name = "LayoutOverflow";

  constructor(
    public readonly measured: { width: number; height: number },
    public readonly available: TextRectangle,
    public readonly fontSizePx: number,
  ) {
    super(
      `Approved text needs ${measured.width}×${measured.height}px at ${fontSizePx}px; the safe area allows ${available.width}×${available.height}px. Change the layout or request explicit copy approval; no text was shortened.`,
    );
  }
}

export class UnsupportedGlyph extends Error {
  readonly name = "UnsupportedGlyph";

  constructor(public readonly codePoint: number) {
    super(
      `The approved font has no glyph for U+${codePoint.toString(16).toUpperCase()}; choose a verified font or explicitly revise the text.`,
    );
  }
}

type FontRange = readonly [number, number];
const fontRanges = new Map<RendererFont, Promise<FontRange[]>>();

function loadFontRanges(id: RendererFont) {
  if (!Object.hasOwn(rendererFonts, id)) throw new TypeError("Choose a verified renderer font.");
  const font = rendererFonts[id];
  if (!fontRanges.has(id)) fontRanges.set(id, (async () => {
    await ensureFontRuntime();
    const fontConfig = process.env.FONTCONFIG_FILE;
    const cacheDirectory = process.env.XDG_CACHE_HOME;
    if (!fontConfig || !cacheDirectory) {
      throw new Error(
        "Typography is not configured: provide a trusted FONTCONFIG_FILE and writable XDG_CACHE_HOME before measuring text.",
      );
    }
    await Promise.all([
      access(font.file),
      access(fontScanner),
      access(fontConfig),
      access(cacheDirectory, constants.W_OK),
    ]);
    if (font.hash && createHash("sha256").update(await readFile(font.file)).digest("hex") !== font.hash)
      throw new Error("The renderer font failed its pinned integrity check.");
    const { stdout } = await executeFile(
      fontScanner,
      ["--format", "%{family[0]}\n%{charset}\n", font.file],
      { timeout: 5_000, maxBuffer: 32_768, encoding: "utf8" },
    );
    const [family, charset] = stdout.trim().split("\n");
    if (family !== font.family || !charset) {
      throw new Error(
        "The verified local typography font is unavailable or has an unexpected family.",
      );
    }
    return charset.split(/\s+/).map((range): FontRange => {
      if (!/^[a-f\d]+(?:-[a-f\d]+)?$/i.test(range)) {
        throw new Error("Unable to verify local font glyph coverage.");
      }
      const [start, end = start] = range
        .split("-")
        .map((part) => Number.parseInt(part, 16));
      if (start > end || end > 0x10ffff)
        throw new Error("Invalid local font coverage.");
      return [start, end];
    });
  })());
  return fontRanges.get(id)!;
}

function validateInput(input: ApprovedTextLayoutInput) {
  if (input.alignment !== undefined && !["left", "center"].includes(input.alignment)) throw new TypeError("Choose a supported text alignment.");
  if (typeof input.text !== "string" || !input.text.trim())
    throw new TypeError("Approved text must contain visible content.");
  if (Buffer.byteLength(input.text, "utf8") > maximumTextBytes)
    throw new RangeError(
      "Approved text exceeds the 16 KiB resource limit; it was not truncated.",
    );
  if (
    !input.text.isWellFormed() ||
    /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(input.text)
  ) {
    throw new TypeError(
      "Approved text contains malformed Unicode or unsupported control characters; use LF line breaks.",
    );
  }
  for (const dimension of [input.canvas.width, input.canvas.height]) {
    if (!Number.isInteger(dimension) || dimension < 1 || dimension > 4096)
      throw new RangeError(
        "Canvas dimensions must be integers from 1 to 4096 pixels.",
      );
  }
  const area = input.safeArea;
  if (
    ![area.x, area.y, area.width, area.height].every(Number.isInteger) ||
    area.x < 0 ||
    area.y < 0 ||
    area.width < 1 ||
    area.height < 1 ||
    area.x + area.width > input.canvas.width ||
    area.y + area.height > input.canvas.height
  ) {
    throw new RangeError(
      "The integer safe area must be completely inside the canvas.",
    );
  }
  if (
    !Number.isInteger(input.fontSizePx) ||
    input.fontSizePx < 12 ||
    input.fontSizePx > 144
  )
    throw new RangeError(
      "Choose an explicit integer font size from 12 to 144 pixels.",
    );
  if (input.color !== undefined && !/^#[a-f\d]{6}$/iu.test(input.color))
    throw new TypeError("Text color must be an opaque six-digit hex value.");
  if (input.weight !== undefined && input.weight !== "regular" && input.weight !== "bold")
    throw new TypeError("Choose regular or bold font weight.");
}

function escapeMarkup(value: string) {
  return value.replace(
    /[&<>"']/gu,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[character]!,
  );
}

export async function layoutApprovedText(
  input: ApprovedTextLayoutInput,
): Promise<MeasuredTextLayout> {
  validateInput(input);
  if (input.font && input.font !== "legacy" && !(process.env.KELY_FONT_WORKER === "1" && process.env.PANGOCAIRO_BACKEND === "fontconfig")) {
    try { return await isolatedTextLayout(input); }
    catch (error) {
      if (error instanceof Error && error.name === "LayoutOverflow") {
        const detail = error as Error & { measured: { width: number; height: number }; available: TextRectangle; fontSizePx: number };
        throw new LayoutOverflow(detail.measured, detail.available, detail.fontSizePx);
      }
      if (error instanceof Error && error.name === "UnsupportedGlyph") throw new UnsupportedGlyph((error as Error & { codePoint: number }).codePoint);
      throw error;
    }
  }
  const request = {
    text: input.text,
    fontSizePx: input.fontSizePx,
    color: input.color ?? "#242331",
    canvas: { ...input.canvas },
    safeArea: { ...input.safeArea },
  };
  const font = rendererFonts[input.font ?? "legacy"];
  const ranges = await loadFontRanges(input.font ?? "legacy");
  for (const character of request.text) {
    if (character === "\n" || character === "\t") continue;
    const point = character.codePointAt(0)!;
    if (!ranges.some(([start, end]) => point >= start && point <= end)) {
      throw new UnsupportedGlyph(point);
    }
  }

  // Supplying height would enable Sharp's automatic font scaling and invalidate approval-size bounds.
  const textImage = sharp({
    text: {
      text: `<span foreground="${request.color}" fallback="false" insert_hyphens="false">${escapeMarkup(request.text)}</span>`,
      font: `${font.family}${input.weight === "bold" ? " Bold" : ""} ${request.fontSizePx}`,
      fontfile: font.file,
      dpi: 72,
      width: request.safeArea.width,
      wrap: "word",
      align: input.alignment ?? "left",
      rgba: true,
    },
  });
  const metrics = await textImage.metadata();
  if (!metrics.width || !metrics.height)
    throw new Error("The typography engine returned no measurable text.");
  const measured = { width: metrics.width, height: metrics.height };
  if (
    measured.width > request.safeArea.width ||
    measured.height > request.safeArea.height
  ) {
    throw new LayoutOverflow(measured, request.safeArea, request.fontSizePx);
  }
  const { data: png, info } = await textImage
    .png()
    .toBuffer({ resolveWithObject: true });
  if (
    info.width !== measured.width ||
    info.height !== measured.height ||
    info.textAutofitDpi !== 72
  ) {
    throw new Error(
      "Measured typography and rendered text disagree; no layout was accepted.",
    );
  }
  return {
    approvedText: request.text,
    canvas: request.canvas,
    safeArea: request.safeArea,
    bounds: { x: request.safeArea.x + (input.alignment === "center" ? Math.floor((request.safeArea.width - measured.width) / 2) : 0), y: request.safeArea.y, ...measured },
    font: {
      family: font.family,
      file: font.file,
      sizePx: request.fontSizePx,
      dpi: 72,
    },
    png,
  };
}
