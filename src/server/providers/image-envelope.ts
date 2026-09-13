import { z } from "zod";
import type { UsageAssessment } from "./text-envelope";

export const IMAGE_RATE_SCHEDULE_ID = "openai-image-2026-09-13-v1";
export const IMAGE_RATE_SCHEDULE_ID_V2 = "openai-image-2026-09-13-v2";
export const IMAGE_RATE_SCHEDULE_ID_V3 = "openai-image-2026-09-13-v3";
export const IMAGE_RATE_SCHEDULE_ID_V4 = "openai-image-2026-09-13-v4";
export const IMAGE_MODEL_V2 = "gpt-image-1.5-2025-12-16";
export const IMAGE_INPUT_ALLOWANCE = 128_000;
export const IMAGE_OUTPUT_TOKENS = 6_240;
const schema = z.object({ model: z.literal("gpt-image-1.5"), prompt: z.string().trim().min(1).max(8_000), n: z.literal(1), size: z.literal("1024x1536"), quality: z.literal("high"), output_format: z.literal("png"), background: z.literal("opaque"), moderation: z.literal("auto") }).strict();
const schemaV2 = schema.extend({ model: z.literal(IMAGE_MODEL_V2) });
const schemaV3 = schema.extend({ accountingPolicy: z.literal(IMAGE_RATE_SCHEDULE_ID_V3) });
const schemaV4 = schema.extend({ accountingPolicy: z.literal(IMAGE_RATE_SCHEDULE_ID_V4), size: z.literal("1536x1024") });
export type BoundedImageRequest = Readonly<z.infer<typeof schema> | z.infer<typeof schemaV2> | z.infer<typeof schemaV3> | z.infer<typeof schemaV4>>;

export function buildImageRequest(prompt: string): BoundedImageRequest {
  return validateImageRequest({ model: "gpt-image-1.5", accountingPolicy: IMAGE_RATE_SCHEDULE_ID_V3, prompt, n: 1, size: "1024x1536", quality: "high", output_format: "png", background: "opaque", moderation: "auto" });
}

export function buildLandscapeImageRequest(prompt: string): BoundedImageRequest {
  return validateImageRequest({ ...buildImageRequest(prompt), accountingPolicy: IMAGE_RATE_SCHEDULE_ID_V4, size: "1536x1024" });
}

export function validateImageRequest(value: unknown): BoundedImageRequest {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).some(key => typeof key !== "string" || !("value" in Object.getOwnPropertyDescriptor(value, key)!))) throw new Error("Image request must contain plain data.");
  const request = (Object.getOwnPropertyDescriptor(value, "accountingPolicy")?.value === IMAGE_RATE_SCHEDULE_ID_V4 ? schemaV4 : Object.hasOwn(value, "accountingPolicy") ? schemaV3 : Object.getOwnPropertyDescriptor(value, "model")?.value === IMAGE_MODEL_V2 ? schemaV2 : schema).parse(value);
  if (Buffer.byteLength(request.prompt) > 32_000 || !request.prompt.isWellFormed()) throw new Error("Image prompt exceeds its encoding boundary.");
  return Object.freeze(request);
}

export function imageRateSchedule(request: BoundedImageRequest) {
  const valid = validateImageRequest(request);
  return "accountingPolicy" in valid ? valid.accountingPolicy : valid.model === IMAGE_MODEL_V2 ? IMAGE_RATE_SCHEDULE_ID_V2 : IMAGE_RATE_SCHEDULE_ID;
}

export function imageMaximumMicros(request: BoundedImageRequest) {
  validateImageRequest(request);
  return IMAGE_INPUT_ALLOWANCE * 5 + IMAGE_OUTPUT_TOKENS * 32;
}

const usageSchema = z.object({
  input_tokens: z.number().int().min(1).max(IMAGE_INPUT_ALLOWANCE),
  input_tokens_details: z.object({ text_tokens: z.number().int().min(1).max(IMAGE_INPUT_ALLOWANCE), image_tokens: z.literal(0) }).strict(),
  output_tokens: z.literal(IMAGE_OUTPUT_TOKENS),
  output_tokens_details: z.object({ image_tokens: z.literal(IMAGE_OUTPUT_TOKENS), text_tokens: z.literal(0) }).strict().optional(),
  total_tokens: z.number().int().positive(),
}).strict();

export function assessImageUsage(request: BoundedImageRequest, raw: unknown): UsageAssessment {
  validateImageRequest(request);
  if (request.model === IMAGE_MODEL_V2 || "accountingPolicy" in request) return assessImageUsageV2(request, raw);
  const response = z.object({ created: z.number().int().positive(), _request_id: z.string().min(1).max(256), http_status: z.literal(200), usage: usageSchema, model: z.literal("gpt-image-1.5").optional(), size: z.literal("1024x1536").optional(), quality: z.literal("high").optional(), background: z.literal("opaque").optional(), output_format: z.literal("png").optional() }).passthrough().parse(raw);
  const usage = response.usage;
  if (usage.input_tokens !== usage.input_tokens_details.text_tokens || usage.total_tokens !== usage.input_tokens + usage.output_tokens) throw new Error("Image usage partitions do not agree.");
  const settledMicros = usage.input_tokens * 5 + usage.output_tokens * 32;
  return { settledMicros, uncertainMicros: 0, basis: "usage_rated", usage: { rate_schedule: IMAGE_RATE_SCHEDULE_ID, ...usage }, responseId: response._request_id, outputStatus: "completed", ratedCostNanoUsd: (BigInt(settledMicros) * 1000n).toString() };
}

export type ProviderValidationIssue = { path: string; code: string };
export class ImageUsageValidationError extends Error {
  constructor(readonly issues: ProviderValidationIssue[]) { super("Image response accounting could not be verified."); }
}

const tokenCountV2 = z.number().int().nonnegative().max(1_000_000);
const usageSchemaV2 = z.object({
  input_tokens: tokenCountV2.min(1).max(IMAGE_INPUT_ALLOWANCE),
  input_tokens_details: z.object({ text_tokens: tokenCountV2.min(1).max(IMAGE_INPUT_ALLOWANCE), image_tokens: z.literal(0) }).strict(),
  output_tokens: tokenCountV2.min(1),
  output_tokens_details: z.object({ image_tokens: tokenCountV2.min(1), text_tokens: tokenCountV2 }).strict().optional(),
  total_tokens: tokenCountV2.min(1),
}).strict();
const responseSchemaV2 = z.object({ created: z.number().int().positive(), _request_id: z.string().min(1).max(256), http_status: z.literal(200), usage: usageSchemaV2, model: z.literal(IMAGE_MODEL_V2).optional(), size: z.literal("1024x1536").optional(), quality: z.literal("high").optional(), background: z.literal("opaque").optional(), output_format: z.literal("png").optional() }).passthrough();
const responseSchemaV3 = responseSchemaV2.extend({ model: z.literal("gpt-image-1.5").optional() });
const responseSchemaV4 = responseSchemaV3.extend({ size: z.literal("1536x1024").optional() });

function assessImageUsageV2(request: BoundedImageRequest, raw: unknown): UsageAssessment {
  const parsed = ("accountingPolicy" in request ? request.accountingPolicy === IMAGE_RATE_SCHEDULE_ID_V4 ? responseSchemaV4 : responseSchemaV3 : responseSchemaV2).safeParse(raw);
  if (!parsed.success) throw new ImageUsageValidationError(parsed.error.issues.slice(0, 8).map((issue) => ({ path: issue.path.map((part) => String(part).replace(/[^a-zA-Z0-9_]/gu, "_").slice(0, 40)).join(".").slice(0, 160), code: issue.code })));
  const response = parsed.data, usage = response.usage, details = usage.output_tokens_details;
  const issues: ProviderValidationIssue[] = [];
  if (usage.input_tokens !== usage.input_tokens_details.text_tokens) issues.push({ path: "usage.input_tokens", code: "partition_mismatch" });
  if (usage.total_tokens !== usage.input_tokens + usage.output_tokens) issues.push({ path: "usage.total_tokens", code: "partition_mismatch" });
  if (details && usage.output_tokens !== details.image_tokens + details.text_tokens) issues.push({ path: "usage.output_tokens", code: "partition_mismatch" });
  const upperMicros = usage.input_tokens * 5 + (details ? details.image_tokens * 32 + details.text_tokens * 10 : usage.output_tokens * 32);
  if (upperMicros > imageMaximumMicros(request)) issues.push({ path: "usage", code: "exceeds_reserved_cost" });
  if (issues.length) throw new ImageUsageValidationError(issues);
  return { settledMicros: details ? upperMicros : 0, uncertainMicros: details ? 0 : upperMicros, basis: details ? "usage_rated" : "usage_bounded", usage: { rate_schedule: imageRateSchedule(request), ...usage, ...(!details ? { output_rate_basis: "all_output_at_highest_rate", cost_upper_bound_micros: upperMicros } : {}) }, responseId: response._request_id, outputStatus: "completed", ...(details ? { ratedCostNanoUsd: (BigInt(upperMicros) * 1000n).toString() } : {}) };
}
