import { z } from "zod";
import type { UsageAssessment } from "./text-envelope";

export const WEB_SEARCH_RATE_SCHEDULE_ID = "openai-web-search-2026-09-21-v1" as const;
const TOOL_CALL_MICROS = 10_000;
const INPUT_TOKEN_RESERVATION = 32_000;
const OUTPUT_TOKEN_CAP = 2_048;
const LUNA_INPUT_NANO = 200n;
const LUNA_OUTPUT_NANO = 1_200n;

const strictObject = z.object({}).strict();
const jsonSchema = z.record(z.string(), z.unknown());
const requestSchema = z.object({
  accountingPolicy: z.literal(WEB_SEARCH_RATE_SCHEDULE_ID),
  model: z.literal("gpt-5.6-luna"),
  input: z.string().trim().min(1).max(65_536),
  instructions: z.string().trim().min(1).max(16_384),
  max_output_tokens: z.number().int().min(1).max(OUTPUT_TOKEN_CAP),
  max_tool_calls: z.literal(1),
  service_tier: z.literal("default"),
  tools: z.tuple([z.object({
    type: z.literal("web_search"), search_context_size: z.literal("low"),
    external_web_access: z.literal(true), return_token_budget: z.literal("default"),
  }).strict()]),
  tool_choice: z.literal("required"),
  include: z.tuple([z.literal("web_search_call.action.sources")]),
  parallel_tool_calls: z.literal(false), stream: z.literal(false), background: z.literal(false), store: z.literal(false), truncation: z.literal("disabled"),
  reasoning: z.object({ effort: z.literal("none") }).strict(),
  text: z.object({ format: z.object({ type: z.literal("json_schema"), name: z.literal("kely_entity_discovery_v1"), schema: jsonSchema, strict: z.literal(true) }).strict() }).strict(),
}).strict();

export type BoundedWebSearchRequest = Readonly<z.infer<typeof requestSchema>>;

export function buildWebSearchRequest(input: { input: string; instructions: string; schema: Record<string, unknown> }): BoundedWebSearchRequest {
  return validateWebSearchRequest({
    accountingPolicy: WEB_SEARCH_RATE_SCHEDULE_ID,
    model: "gpt-5.6-luna", input: input.input, instructions: input.instructions,
    max_output_tokens: OUTPUT_TOKEN_CAP, max_tool_calls: 1, service_tier: "default",
    tools: [{ type: "web_search", search_context_size: "low", external_web_access: true, return_token_budget: "default" }],
    tool_choice: "required", include: ["web_search_call.action.sources"], parallel_tool_calls: false,
    stream: false, background: false, store: false, truncation: "disabled", reasoning: { effort: "none" },
    text: { format: { type: "json_schema", name: "kely_entity_discovery_v1", schema: input.schema, strict: true } },
  });
}

export function validateWebSearchRequest(value: unknown): BoundedWebSearchRequest {
  const result = requestSchema.parse(value);
  if (Buffer.byteLength(result.input, "utf8") > 65_536 || Buffer.byteLength(result.instructions, "utf8") > 16_384) throw new Error("Web search envelope exceeds byte bounds.");
  if (Buffer.byteLength(JSON.stringify(result.text.format.schema), "utf8") > 16_384) throw new Error("Web search schema exceeds byte bounds.");
  strictObject.parse({});
  return Object.freeze(result);
}

function microsCeiling(value: bigint) { return Number((value + 999n) / 1_000n); }

export function webSearchMaximumMicros(value: BoundedWebSearchRequest) {
  const request = validateWebSearchRequest(value);
  return TOOL_CALL_MICROS + microsCeiling(BigInt(INPUT_TOKEN_RESERVATION) * LUNA_INPUT_NANO + BigInt(request.max_output_tokens) * LUNA_OUTPUT_NANO);
}

export function assessWebSearchUsage(requestValue: BoundedWebSearchRequest, raw: unknown): UsageAssessment {
  const request = validateWebSearchRequest(requestValue);
  const response = z.object({
    id: z.string().min(1).max(256), model: z.literal(request.model), service_tier: z.literal("default"),
    status: z.enum(["completed", "incomplete", "failed", "cancelled"]),
    output: z.array(z.record(z.string(), z.unknown())).max(16),
    usage: z.object({ input_tokens: z.number().int().min(1).max(1_050_000), output_tokens: z.number().int().min(0).max(request.max_output_tokens), total_tokens: z.number().int().min(1).max(1_052_048), input_tokens_details: z.object({ cached_tokens: z.number().int().min(0).optional(), cache_write_tokens: z.number().int().min(0).optional() }).passthrough().optional(), output_tokens_details: z.object({ reasoning_tokens: z.number().int().min(0).optional() }).passthrough().optional() }).passthrough(),
  }).passthrough().parse(raw);
  if (response.status !== "completed" || response.usage.total_tokens !== response.usage.input_tokens + response.usage.output_tokens) throw new Error("Web search response is not a completed, internally consistent result.");
  const calls = response.output.filter((item) => item.type === "web_search_call");
  if (calls.length !== 1) throw new Error("Web search response must contain exactly one accounted tool call.");
  const action = calls[0].action;
  if (!action || typeof action !== "object" || Array.isArray(action) || (action as { type?: unknown }).type !== "search") throw new Error("Web search response does not contain one search action.");
  const inputDetails = response.usage.input_tokens_details ?? {};
  const cached = inputDetails.cached_tokens ?? 0;
  const cacheWrite = inputDetails.cache_write_tokens ?? 0;
  if (cached + cacheWrite > response.usage.input_tokens) throw new Error("Web search input token partitions are inconsistent.");
  const ordinary = response.usage.input_tokens - cached - cacheWrite;
  const nano = BigInt(ordinary) * LUNA_INPUT_NANO + BigInt(cached) * 20n + BigInt(cacheWrite) * 250n + BigInt(response.usage.output_tokens) * LUNA_OUTPUT_NANO + BigInt(TOOL_CALL_MICROS) * 1_000n;
  return {
    settledMicros: microsCeiling(nano), uncertainMicros: 0, basis: "usage_rated",
    usage: { rate_schedule: WEB_SEARCH_RATE_SCHEDULE_ID, input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens, total_tokens: response.usage.total_tokens, web_search_calls: 1 },
    responseId: response.id, outputStatus: response.status, ratedCostNanoUsd: nano.toString(),
  };
}
