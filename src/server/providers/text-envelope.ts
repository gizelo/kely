import { Buffer } from "node:buffer";

export type TextModel = "gpt-5.6-luna" | "gpt-5.6-terra";
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type Schema = { [key: string]: JsonValue };

export type BoundedTextRequest = Readonly<{
  model: TextModel;
  input: string;
  instructions: string;
  max_output_tokens: number;
  service_tier: "default";
  tools: readonly [];
  tool_choice: "none";
  parallel_tool_calls: false;
  stream: false;
  background: false;
  store: false;
  truncation: "disabled";
  reasoning: Readonly<{ effort: "none" }>;
  text: Readonly<{ format: Readonly<{ type: "text" }> | Readonly<{ type: "json_schema"; name: string; schema: Schema; strict: true }> }>;
}>;

export type UsageAssessment = {
  settledMicros: number;
  uncertainMicros: number;
  basis: "usage_rated" | "usage_bounded";
  usage: { [key: string]: JsonValue };
  responseId: string;
  outputStatus: string;
  ratedCostNanoUsd?: string;
};

const CONTEXT_TOKENS = 1_050_000;
const OUTPUT_CAP = 4_096;
const LONG_CONTEXT_THRESHOLD = 272_000;
export const RATE_SCHEDULE_ID = "openai-text-2026-09-10-v1";
const RATES = {
  "gpt-5.6-luna": { inputNano: 200n, cachedNano: 20n, writeNano: 250n, outputNano: 1_200n },
  "gpt-5.6-terra": { inputNano: 2_000n, cachedNano: 200n, writeNano: 2_500n, outputNano: 12_000n },
} as const;

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Text envelope: ${message}`);
}

function record(value: unknown, allowed?: readonly string[]): Record<string, unknown> {
  ensure(value !== null && typeof value === "object" && !Array.isArray(value), "expected a plain object");
  const prototype = Object.getPrototypeOf(value);
  ensure(prototype === Object.prototype || prototype === null, "expected a plain object");
  for (const key of Reflect.ownKeys(value)) {
    ensure(typeof key === "string" && (!allowed || allowed.includes(key)), "unsupported field");
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    ensure("value" in descriptor && descriptor.enumerable, "only JSON data fields are supported");
  }
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, maximumBytes: number, label: string): string {
  ensure(typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= maximumBytes, `${label} must be nonempty and bounded`);
  return value;
}

function integer(value: unknown, maximum: number, label: string, minimum = 0): number {
  ensure(typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum, `${label} is outside its integer bound`);
  return value;
}

function modelName(value: unknown): TextModel {
  ensure(value === "gpt-5.6-luna" || value === "gpt-5.6-terra", "model is not approved");
  return value;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function safeSchema(value: unknown): Schema {
  let nodes = 0;
  function visit(current: unknown, depth: number): Schema {
    ensure(depth <= 8 && ++nodes <= 128, "schema exceeds depth or node bound");
    const node = record(current, ["type", "description", "properties", "required", "additionalProperties", "items", "enum", "minItems", "maxItems"]);
    const type = node.type;
    ensure(typeof type === "string" && ["object", "array", "string", "number", "integer", "boolean", "null"].includes(type), "unsupported schema type");
    const result: Schema = { type };
    if (node.description !== undefined) result.description = boundedString(node.description, 512, "schema description");
    if (type === "object") {
      ensure(node.additionalProperties === false, "schema objects must disallow additional properties");
      const properties = record(node.properties);
      const names = Object.keys(properties);
      ensure(names.length <= 64, "too many schema properties");
      ensure(Array.isArray(node.required) && node.required.length === names.length && new Set(node.required).size === names.length && names.every(name => (node.required as unknown[]).includes(name)), "all schema properties must be required exactly once");
      const normalized: Schema = {};
      for (const name of names) {
        ensure(/^[a-zA-Z0-9_-]{1,64}$/.test(name) && !["__proto__", "prototype", "constructor"].includes(name), "unsafe schema property name");
        normalized[name] = visit(properties[name], depth + 1);
      }
      result.properties = normalized;
      result.required = [...node.required] as string[];
      result.additionalProperties = false;
    } else if (type === "array") {
      result.items = visit(node.items, depth + 1);
      if (node.minItems !== undefined) result.minItems = integer(node.minItems, 32, "schema minItems");
      if (node.maxItems !== undefined) result.maxItems = integer(node.maxItems, 32, "schema maxItems");
      ensure((result.minItems as number | undefined) === undefined || (result.maxItems as number | undefined) === undefined || (result.minItems as number) <= (result.maxItems as number), "schema item bounds are inconsistent");
    } else if (node.enum !== undefined) {
      ensure((type === "string" || type === "integer") && Array.isArray(node.enum) && node.enum.length >= 1 && node.enum.length <= 32, "only bounded string or integer enums are supported");
      result.enum = type === "string"
        ? node.enum.map(item => boundedString(item, 128, "schema enum value"))
        : node.enum.map(item => integer(item, 1_000_000, "schema enum value", -1_000_000));
      ensure(new Set(result.enum).size === result.enum.length, "schema enum values must be unique");
    }
    const permitted = type === "object" ? ["type", "description", "properties", "required", "additionalProperties"] : type === "array" ? ["type", "description", "items", "minItems", "maxItems"] : ["type", "description", "enum"];
    record(node, permitted);
    return result;
  }
  const schema = visit(value, 1);
  ensure(schema.type === "object", "schema root must be an object");
  ensure(Buffer.byteLength(JSON.stringify(schema), "utf8") <= 16_384, "schema exceeds byte bound");
  return schema;
}

export function buildTextRequest(input: unknown): BoundedTextRequest {
  const options = record(input, ["model", "input", "instructions", "maxOutputTokens", "jsonSchema"]);
  const model = modelName(options.model);
  const text = boundedString(options.input, 65_536, "input");
  const instructions = boundedString(options.instructions, 16_384, "instructions");
  const maxOutputTokens = options.maxOutputTokens === undefined ? OUTPUT_CAP : integer(options.maxOutputTokens, OUTPUT_CAP, "maxOutputTokens", 1);
  let format: BoundedTextRequest["text"]["format"] = { type: "text" };
  if (options.jsonSchema !== undefined) {
    const specification = record(options.jsonSchema, ["name", "schema"]);
    const name = boundedString(specification.name, 64, "schema name");
    ensure(/^[a-zA-Z0-9_-]+$/.test(name), "invalid schema name");
    format = { type: "json_schema", name, schema: safeSchema(specification.schema), strict: true };
  }
  return freeze({
    model, input: text, instructions, max_output_tokens: maxOutputTokens,
    service_tier: "default", tools: [], tool_choice: "none", parallel_tool_calls: false,
    stream: false, background: false, store: false, truncation: "disabled",
    reasoning: { effort: "none" }, text: { format },
  } satisfies BoundedTextRequest);
}

export function validateTextRequest(value: unknown): BoundedTextRequest {
  const request = record(value, ["model", "input", "instructions", "max_output_tokens", "service_tier", "tools", "tool_choice", "parallel_tool_calls", "stream", "background", "store", "truncation", "reasoning", "text"]);
  ensure(request.service_tier === "default" && request.tool_choice === "none" && request.truncation === "disabled", "request policy differs from approved envelope");
  ensure(request.parallel_tool_calls === false && request.stream === false && request.background === false && request.store === false, "request policy differs from approved envelope");
  ensure(Array.isArray(request.tools) && request.tools.length === 0, "tools are not allowed");
  ensure(record(request.reasoning, ["effort"]).effort === "none", "reasoning policy differs from approved envelope");
  const format = record(record(request.text, ["format"]).format, ["type", "name", "schema", "strict"]);
  ensure(format.type === "text" || format.type === "json_schema", "unsupported output format");
  let jsonSchema: { name: unknown; schema: unknown } | undefined;
  if (format.type === "json_schema") {
    ensure(format.strict === true, "structured output must be strict");
    jsonSchema = { name: format.name, schema: format.schema };
  } else record(format, ["type"]);
  integer(request.max_output_tokens, OUTPUT_CAP, "max_output_tokens", 1);
  return buildTextRequest({ model: request.model, input: request.input, instructions: request.instructions, maxOutputTokens: request.max_output_tokens, jsonSchema });
}

function microsCeiling(nanoUsd: bigint): number {
  return Number((nanoUsd + 999n) / 1_000n);
}

function worstCostNano(model: TextModel, inputTokens: number, outputTokens: number): bigint {
  const rates = RATES[model];
  const long = inputTokens > LONG_CONTEXT_THRESHOLD;
  return BigInt(inputTokens) * rates.writeNano * (long ? 2n : 1n) + BigInt(outputTokens) * rates.outputNano * (long ? 3n : 2n) / 2n;
}

export function requestMaximumMicros(request: BoundedTextRequest): number {
  const valid = validateTextRequest(request);
  // Full context intentionally over-reserves input; byte limits are not a tokenizer guarantee.
  return microsCeiling(worstCostNano(valid.model, CONTEXT_TOKENS, valid.max_output_tokens));
}

export function assessTextUsage(request: BoundedTextRequest, rawResponse: unknown): UsageAssessment {
  const valid = validateTextRequest(request);
  const response = record(rawResponse);
  ensure(response.model === valid.model, "response model differs from reserved model");
  ensure(response.service_tier === "default", "response service tier is not rated");
  const responseId = boundedString(response.id, 256, "response ID");
  const outputStatus = boundedString(response.status, 32, "response status");
  ensure(["completed", "incomplete", "failed", "cancelled"].includes(outputStatus), "response is not terminal");
  if (response.max_output_tokens !== undefined) ensure(response.max_output_tokens === valid.max_output_tokens, "response output cap differs from request");
  const rawUsage = record(response.usage, ["input_tokens", "input_tokens_details", "output_tokens", "output_tokens_details", "total_tokens"]);
  const inputTokens = integer(rawUsage.input_tokens, CONTEXT_TOKENS, "input_tokens", 1);
  const outputTokens = integer(rawUsage.output_tokens, valid.max_output_tokens, "output_tokens");
  if (outputTokens === 0 && Array.isArray(response.output)) ensure(response.output.length === 0, "nonempty generated output contradicts zero output tokens");
  const totalTokens = integer(rawUsage.total_tokens, CONTEXT_TOKENS + valid.max_output_tokens, "total_tokens");
  ensure(totalTokens === inputTokens + outputTokens, "usage totals are inconsistent");
  const inputDetails = rawUsage.input_tokens_details == null ? {} : record(rawUsage.input_tokens_details, ["cached_tokens", "cache_write_tokens"]);
  const cachedTokens = inputDetails.cached_tokens === undefined ? null : integer(inputDetails.cached_tokens, inputTokens, "cached_tokens");
  const cacheWriteTokens = inputDetails.cache_write_tokens === undefined ? null : integer(inputDetails.cache_write_tokens, inputTokens, "cache_write_tokens");
  ensure((cachedTokens ?? 0) + (cacheWriteTokens ?? 0) <= inputTokens, "cache partitions exceed total input");
  const outputDetails = rawUsage.output_tokens_details == null ? {} : record(rawUsage.output_tokens_details, ["reasoning_tokens"]);
  const reasoningTokens = outputDetails.reasoning_tokens === undefined ? null : integer(outputDetails.reasoning_tokens, outputTokens, "reasoning_tokens");
  const usage = {
    rate_schedule: RATE_SCHEDULE_ID,
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: cachedTokens, cache_write_tokens: cacheWriteTokens },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: reasoningTokens },
    total_tokens: totalTokens,
  };
  if (cachedTokens === null || cacheWriteTokens === null) {
    return { settledMicros: 0, uncertainMicros: microsCeiling(worstCostNano(valid.model, inputTokens, outputTokens)), basis: "usage_bounded", usage, responseId, outputStatus };
  }
  const rates = RATES[valid.model];
  const long = inputTokens > LONG_CONTEXT_THRESHOLD;
  const ordinaryTokens = inputTokens - cachedTokens - cacheWriteTokens;
  const inputNano = BigInt(ordinaryTokens) * rates.inputNano + BigInt(cachedTokens) * rates.cachedNano + BigInt(cacheWriteTokens) * rates.writeNano;
  // Reasoning tokens are already included in output_tokens.
  const costNano = inputNano * (long ? 2n : 1n) + BigInt(outputTokens) * rates.outputNano * (long ? 3n : 2n) / 2n;
  return { settledMicros: microsCeiling(costNano), uncertainMicros: 0, basis: "usage_rated", usage, responseId, outputStatus, ratedCostNanoUsd: costNano.toString() };
}
