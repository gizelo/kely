import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { AppError, requireCondition } from "./errors";
import { PostgresPrivateStorage, usesCloudStorage } from "./private-storage";

export const materialRoot = path.resolve(".local/brand-materials");
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_MATERIAL_BYTES = 16 * 1024 * 1024;

export async function readUpload(request: Request) {
  requireCondition(Number(request.headers.get("content-length") ?? 0) <= MAX_UPLOAD_BYTES, "upload_too_large", "Upload one PNG/JPEG of at most 5 MiB.", 413);
  const reader = request.body?.getReader();
  requireCondition(reader, "invalid_image", "Choose a PNG or JPEG image.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > MAX_UPLOAD_BYTES) { await reader.cancel(); throw new AppError("upload_too_large", "Upload one PNG/JPEG of at most 5 MiB.", 413); }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks);
}

export async function normalizeMaterial(bytes: Buffer) {
  requireCondition(bytes.length > 0 && bytes.length <= MAX_UPLOAD_BYTES, "upload_too_large", "Upload one PNG/JPEG of at most 5 MiB.", 413);
  const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  requireCondition(png || jpeg, "unsupported_image", "Only actual PNG and JPEG files are supported. SVG, PDF and fonts are unavailable.", 415);
  if (png) {
    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const type = bytes.toString("ascii", offset + 4, offset + 8);
      requireCondition(!["acTL", "fcTL", "fdAT"].includes(type), "invalid_image", "Animated PNG is unsupported. Use a single-frame PNG or JPEG.", 422);
      requireCondition(length <= bytes.length - offset - 12, "invalid_image", "This PNG has invalid chunk lengths.", 422);
      offset += length + 12;
      if (type === "IEND") break;
    }
  }
  try {
    const input = sharp(bytes, { failOn: "warning", limitInputPixels: 16_000_000, animated: true });
    const metadata = await input.metadata();
    requireCondition(metadata.format === (png ? "png" : "jpeg") && (metadata.pages ?? 1) === 1 && Boolean(metadata.width && metadata.height) && metadata.width! <= 8192 && metadata.height! <= 8192 && metadata.width! * metadata.height! <= 16_000_000, "invalid_image", "Use a single-frame image up to 16 megapixels and 8192 pixels per side.", 422);
    const { data, info } = await input.rotate().png().toBuffer({ resolveWithObject: true });
    requireCondition(data.length <= MAX_MATERIAL_BYTES, "upload_too_large", "The normalized image is too large.", 413);
    return { data, width: info.width, height: info.height, bytes: data.length, hash: createHash("sha256").update(data).digest("hex") };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("invalid_image", "This image could not be safely decoded. Use a single-frame PNG or JPEG up to 16 megapixels.", 422);
  }
}

export async function storeMaterial(bytes: Buffer, root = materialRoot) {
  if (usesCloudStorage()) {
    const { pool } = await import("./db");
    const name = `${randomUUID()}.png`;
    await new PostgresPrivateStorage(pool).put("material", name, bytes);
    return name;
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const name = `${randomUUID()}.png`;
  const handle = await open(path.join(root, name), "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  catch (error) { await handle.close(); await unlink(path.join(root, name)); throw error; }
  await handle.close();
  return name;
}
export async function discardMaterial(name: string, root = materialRoot) {
  if (usesCloudStorage()) {
    const { pool } = await import("./db");
    await new PostgresPrivateStorage(pool).discardUnlinkedMaterial(name);
  } else await unlink(path.join(root, name));
}
export async function materialBytes(name: string, hash: string, root = materialRoot) {
  requireCondition(/^[0-9a-f-]{36}\.png$/u.test(name), "material_unavailable", "This material is unavailable.", 409);
  let bytes: Buffer;
  if (usesCloudStorage()) {
    const { pool } = await import("./db");
    const saved = await new PostgresPrivateStorage(pool).get("material", name);
    requireCondition(saved && saved.length <= MAX_MATERIAL_BYTES && createHash("sha256").update(saved).digest("hex") === hash, "material_unavailable", "Material integrity could not be verified.", 409);
    return saved;
  }
  try {
    const handle = await open(path.join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      requireCondition(stat.isFile() && stat.size <= MAX_MATERIAL_BYTES, "material_unavailable", "This material is unavailable.", 409);
      bytes = await handle.readFile();
    } finally { await handle.close(); }
  } catch { throw new AppError("material_unavailable", "This material is unavailable.", 409); }
  requireCondition(bytes.length <= MAX_MATERIAL_BYTES && createHash("sha256").update(bytes).digest("hex") === hash, "material_unavailable", "Material integrity could not be verified.", 409);
  return bytes;
}
