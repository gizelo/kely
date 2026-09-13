import { assessTextUsage, requestMaximumMicros, validateTextRequest, type BoundedTextRequest } from "./text-envelope";

export const VISION_RATE_SCHEDULE_ID = "openai-vision-2026-09-11-v1";
export type VisionImageInput = Readonly<{ type: "input_image"; image_url: string; detail: "high" }>;
export type BoundedVisionRequest = Omit<BoundedTextRequest, "input" | "model"> & {
  readonly model: "gpt-5.6-luna";
  readonly input: readonly [{ readonly role: "user"; readonly content: readonly [Readonly<{ type: "input_text"; text: string }>, ...VisionImageInput[]] }];
};

function ensure(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(`Vision envelope: ${message}`); }
function object(value: unknown, keys: string[]) {
  ensure(value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).every((key) => typeof key === "string" && keys.includes(key) && "value" in Object.getOwnPropertyDescriptor(value, key)!), "unsupported object");
  return value as Record<string, unknown>;
}

export function jpegDimensions(bytes: Buffer) {
  ensure(bytes.length > 10 && bytes.length <= 1_048_576 && bytes.readUInt16BE(0) === 0xffd8 && bytes.readUInt16BE(bytes.length - 2) === 0xffd9, "bounded JPEG required");
  let cursor = 2;
  while (cursor + 4 <= bytes.length) {
    ensure(bytes[cursor] === 0xff, "invalid JPEG marker");
    while (bytes[cursor] === 0xff) cursor++;
    const marker = bytes[cursor++];
    ensure(marker !== 0xda && marker !== 0xd9, "JPEG dimensions are missing");
    const length = bytes.readUInt16BE(cursor);
    ensure(length >= 2 && cursor + length <= bytes.length, "invalid JPEG segment");
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      ensure(length >= 8, "invalid JPEG frame");
      const height = bytes.readUInt16BE(cursor + 3), width = bytes.readUInt16BE(cursor + 5);
      ensure(width > 0 && height > 0 && width <= 1536 && height <= 1536, "analysis dimensions exceed 1536px");
      return { width, height };
    }
    cursor += length;
  }
  throw new Error("Vision envelope: incomplete JPEG");
}

export function validateVisionRequest(value: unknown): BoundedVisionRequest {
  const raw = object(value, ["model", "input", "instructions", "max_output_tokens", "service_tier", "tools", "tool_choice", "parallel_tool_calls", "stream", "background", "store", "truncation", "reasoning", "text"]);
  ensure(raw.model === "gpt-5.6-luna", "only the approved Luna analysis model is supported");
  ensure(Array.isArray(raw.input) && raw.input.length === 1, "exactly one user message is required");
  const message = object(raw.input[0], ["role", "content"]);
  ensure(message.role === "user" && Array.isArray(message.content) && message.content.length >= 2 && message.content.length <= 4, "one to three selected images are required");
  const text = object(message.content[0], ["type", "text"]);
  ensure(text.type === "input_text" && typeof text.text === "string" && text.text.trim() && Buffer.byteLength(text.text) <= 40_000, "bounded analysis guidance is required");
  const images = message.content.slice(1).map((value): VisionImageInput => {
    const item = object(value, ["type", "image_url", "detail"]);
    ensure(item.type === "input_image" && item.detail === "high" && typeof item.image_url === "string" && item.image_url.length <= 1_398_127 && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(item.image_url), "only exact high-detail local JPEG data URLs are supported");
    const base64 = item.image_url.slice(23);
    const bytes = Buffer.from(base64, "base64");
    ensure(bytes.toString("base64") === base64, "JPEG encoding is not canonical");
    jpegDimensions(bytes);
    return Object.freeze({ type: "input_image", detail: "high", image_url: item.image_url });
  });
  const base = validateTextRequest({ ...raw, input: text.text });
  ensure(base.text.format.type === "json_schema", "analysis requires strict structured output");
  return Object.freeze({ ...base, model: "gpt-5.6-luna", input: Object.freeze([Object.freeze({ role: "user", content: Object.freeze([Object.freeze({ type: "input_text", text: text.text }), ...images]) })]) }) as BoundedVisionRequest;
}

function accountingRequest(value: BoundedVisionRequest): BoundedTextRequest {
  const request = validateVisionRequest(value);
  return { ...request, input: "Accepted image and text tokens share the documented model context." };
}
export function visionMaximumMicros(value: BoundedVisionRequest) { return requestMaximumMicros(accountingRequest(value)); }
export function assessVisionUsage(value: BoundedVisionRequest, response: unknown) { return assessTextUsage(accountingRequest(value), response); }
