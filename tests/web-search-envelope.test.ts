import assert from "node:assert/strict";
import test from "node:test";
import { assessWebSearchUsage, buildWebSearchRequest, validateWebSearchRequest, webSearchMaximumMicros, WEB_SEARCH_RATE_SCHEDULE_ID } from "../src/server/providers/web-search-envelope";
import { providerMaximumMicros, providerRateSchedule } from "../src/server/providers/provider-envelope";

const schema = { type: "object", additionalProperties: false, required: ["kind", "candidates"], properties: { kind: { type: "string", enum: ["entity_discovery"] }, candidates: { type: "array", maxItems: 10, items: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" } } } } } };
const request = buildWebSearchRequest({ input: "Find the official Example Studio business.", instructions: "Use one search. Return candidates only.", schema });

test("web search envelope permits exactly one bounded built-in search call", () => {
  assert.equal(request.max_tool_calls, 1);
  assert.equal(request.tools[0].type, "web_search");
  assert.equal(request.tools[0].search_context_size, "low");
  assert.equal(providerRateSchedule(request), WEB_SEARCH_RATE_SCHEDULE_ID);
  assert.equal(providerMaximumMicros(request), webSearchMaximumMicros(request));
  assert.throws(() => validateWebSearchRequest({ ...request, max_tool_calls: 2 }));
  assert.throws(() => validateWebSearchRequest({ ...request, tools: [{ ...request.tools[0], external_web_access: false }] }));
});

test("web search usage includes the single tool-call fee and rejects extra calls", () => {
  const base = { id: "resp_1", model: "gpt-5.6-luna", service_tier: "default", status: "completed", usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  const one = { ...base, output: [{ type: "web_search_call", action: { type: "search", query: "Example Studio", sources: [{ type: "url", url: "https://example.com" }] } }, { type: "message", content: [] }] };
  const result = assessWebSearchUsage(request, one);
  assert.equal(result.usage.web_search_calls, 1);
  assert.ok(result.settledMicros >= 10_000);
  assert.throws(() => assessWebSearchUsage(request, { ...one, output: [one.output[0], one.output[0]] }), /exactly one/u);
});
