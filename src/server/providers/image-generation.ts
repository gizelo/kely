import { createHash } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import type { AttemptInput } from "../budget/store";
import { canonicalJson } from "../paid-input";
import { createLiveGateway } from "./gateway";
import { buildImageRequest } from "./image-envelope";
import type { UsageAssessment } from "./text-envelope";

export type ArtworkInput = { ownerId: string; operationId: string; step: string; prompt: string; snapshot: Record<string, unknown>; origin: "ai_preview" | "openai" };
type ArtworkGateway = { dispatch(input: AttemptInput): Promise<{ response: unknown; assessment: UsageAssessment; replayed: boolean }> };

export async function parseArtwork(response: unknown, size: "1024x1536" | "1536x1024" = "1024x1536"): Promise<Buffer> {
  const data = z.object({ data: z.array(z.object({ b64_json: z.string().min(1).max(14_000_000) }).passthrough()).length(1) }).passthrough().parse(response).data[0].b64_json;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error("Artwork encoding is invalid.");
  const png = Buffer.from(data, "base64");
  if (png.toString("base64") !== data || png.length < 33 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("Artwork must be a PNG.");
  const decoder = sharp(png, { limitInputPixels: 1024 * 1536, failOn: "warning" });
  const info = await decoder.metadata();
  const [width, height] = size.split("x").map(Number);
  if (info.format !== "png" || info.width !== width || info.height !== height || (info.pages ?? 1) !== 1) throw new Error("Artwork dimensions differ from the accepted scope.");
  await decoder.raw().toBuffer();
  return png;
}

export async function generateArtwork(input: ArtworkInput, gateway?: ArtworkGateway) {
  if (input.origin !== "openai" && !gateway) throw new Error("Preview artwork requires an explicit isolated transport.");
  const request = buildImageRequest(input.prompt);
  const attemptKey = `image-${createHash("sha256").update(canonicalJson({ ownerId: input.ownerId, operationId: input.operationId, step: input.step })).digest("hex")}`;
  const result = await (gateway ?? createLiveGateway()).dispatch({ key: attemptKey, ownerId: input.ownerId, operationId: input.operationId, step: input.step, snapshot: input.snapshot, request });
  const png = await parseArtwork(result.response);
  return { png, assessment: result.assessment, replayed: result.replayed, attemptKey };
}
