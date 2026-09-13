import assert from "node:assert/strict";
import test from "node:test";
import { assessTextUsage, buildTextRequest, requestMaximumMicros, type BoundedTextRequest } from "../src/server/providers/text-envelope";

test("strict schemas preserve bounded array cardinality", () => {
  const request = buildTextRequest({ model: "gpt-5.6-luna", input: "{}", instructions: "Return items.", jsonSchema: { name: "bounded_items", schema: { type: "object", additionalProperties: false, required: ["items"], properties: { items: { type: "array", minItems: 0, maxItems: 3, items: { type: "string" } } } } } });
  assert.equal(request.text.format.type, "json_schema");
  if (request.text.format.type === "json_schema") assert.deepEqual(request.text.format.schema.properties, { items: { type: "array", items: { type: "string" }, minItems: 0, maxItems: 3 } });
  assert.throws(() => buildTextRequest({ model: "gpt-5.6-luna", input: "{}", instructions: "Return items.", jsonSchema: { name: "bad_items", schema: { type: "object", additionalProperties: false, required: ["items"], properties: { items: { type: "array", minItems: 4, maxItems: 3, items: { type: "string" } } } } } }), /item bounds/);
});

const input = { model: "gpt-5.6-luna", input: "Write a short caption about our café.", instructions: "Use only the provided facts." };

function response(overrides: Record<string, unknown> = {}) {
  return {
    id: "resp_fake_pricing", model: "gpt-5.6-luna", service_tier: "default", status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "A usable or unusable caption still costs tokens." }] }],
    usage: {
      input_tokens: 1_000, input_tokens_details: { cached_tokens: 600, cache_write_tokens: 200 },
      output_tokens: 100, output_tokens_details: { reasoning_tokens: 40 }, total_tokens: 1_100,
    }, ...overrides,
  };
}

test("request policy is immutable, rejects unpriced capabilities and uses a full-context maximum", () => {
  const request = buildTextRequest(input);
  assert.equal(requestMaximumMicros(request), 532_373);
  assert.equal(requestMaximumMicros(buildTextRequest({ ...input, model: "gpt-5.6-terra" })), 5_323_728);
  assert.equal(requestMaximumMicros(buildTextRequest({ ...input, maxOutputTokens: 1 })), 525_002);
  assert.equal(request.service_tier, "default");
  assert.equal(request.reasoning.effort, "none");
  assert.equal(request.truncation, "disabled");
  assert.equal(request.store, false);
  assert.equal(request.stream, false);
  assert.equal(request.background, false);
  assert.equal(request.tool_choice, "none");
  assert.deepEqual(request.tools, []);
  assert.throws(() => { (request.reasoning as { effort: string }).effort = "high"; });
  for (const extra of [{ tools: [] }, { previous_response_id: "resp_other" }, { prompt_cache_options: {} }, { service_tier: "priority" }, { moderation: {} }]) {
    assert.throws(() => buildTextRequest({ ...input, ...extra }), /unsupported field/);
  }
  assert.throws(() => buildTextRequest({ ...input, model: "gpt-6-astra" }), /not approved/);
  assert.throws(() => buildTextRequest({ ...input, maxOutputTokens: 4_097 }), /integer bound/);
  assert.throws(() => buildTextRequest({ ...input, input: "я".repeat(32_769) }), /bounded/);
  assert.throws(() => requestMaximumMicros({ ...request, tools: [{ type: "web_search" }] } as unknown as BoundedTextRequest), /tools are not allowed/);
});

test("structured output keeps a copied strict bounded schema and rejects external or open schemas", () => {
  const schema = { type: "object", properties: { caption: { type: "string" } }, required: ["caption"], additionalProperties: false };
  const request = buildTextRequest({ ...input, jsonSchema: { name: "post_copy", schema } });
  schema.properties.caption.type = "number";
  assert.equal(request.text.format.type, "json_schema");
  if (request.text.format.type !== "json_schema") throw new Error("Expected structured format");
  assert.deepEqual(request.text.format.schema.properties, { caption: { type: "string" } });
  assert.equal(request.text.format.strict, true);
  assert.equal(requestMaximumMicros(request), 532_373);
  assert.throws(() => buildTextRequest({ ...input, jsonSchema: { name: "post", schema: { ...schema, $ref: "https://untrusted.example/schema" } } }), /unsupported field/);
  assert.throws(() => buildTextRequest({ ...input, jsonSchema: { name: "post", schema: { ...schema, additionalProperties: true } } }), /disallow additional/);
  assert.throws(() => buildTextRequest({ ...input, jsonSchema: { name: "post", schema: { ...schema, required: [] } } }), /required exactly once/);
  const recursive: Record<string, unknown> = { type: "object", required: ["child"], additionalProperties: false };
  recursive.properties = { child: recursive };
  assert.throws(() => buildTextRequest({ ...input, jsonSchema: { name: "post", schema: recursive } }), /depth or node bound/);
});

test("complete usage prices disjoint cache partitions and output once regardless of usable business output", () => {
  const assessment = assessTextUsage(buildTextRequest(input), response());
  assert.equal(assessment.basis, "usage_rated");
  assert.equal(assessment.ratedCostNanoUsd, "222000");
  assert.equal(assessment.settledMicros, 222);
  assert.equal(assessment.uncertainMicros, 0);
  assert.equal(assessment.responseId, "resp_fake_pricing");
  assert.equal(assessment.outputStatus, "completed");
  assert.equal(JSON.parse(JSON.stringify(assessment.usage)).output_tokens_details.reasoning_tokens, 40);
  const partial = assessTextUsage(buildTextRequest(input), response({ status: "incomplete", output: [] }));
  assert.equal(partial.settledMicros, 222);
  assert.equal(partial.outputStatus, "incomplete");
  const structured = buildTextRequest({ ...input, jsonSchema: { name: "caption", schema: { type: "object", properties: { caption: { type: "string" } }, required: ["caption"], additionalProperties: false } } });
  const invalidCopy = assessTextUsage(structured, response({ output: [{ type: "message", content: [{ type: "output_text", text: "This is not the required JSON." }] }] }));
  assert.equal(invalidCopy.settledMicros, 222);
  assert.equal(invalidCopy.uncertainMicros, 0);
});

test("long-context pricing starts above 272K and microUSD settlement rounds upward", () => {
  const request = buildTextRequest(input);
  const usage = (tokens: number) => ({ input_tokens: tokens, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 1, total_tokens: tokens + 1 });
  const ordinary = assessTextUsage(request, response({ usage: usage(272_000) }));
  assert.equal(ordinary.ratedCostNanoUsd, "54401200");
  assert.equal(ordinary.settledMicros, 54_402);
  const long = assessTextUsage(request, response({ usage: usage(272_001) }));
  assert.equal(long.ratedCostNanoUsd, "108802200");
  assert.equal(long.settledMicros, 108_803);
  const allWrites = assessTextUsage(buildTextRequest({ ...input, model: "gpt-5.6-terra" }), response({ model: "gpt-5.6-terra", usage: { input_tokens: 1_050_000, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 1_050_000 }, output_tokens: 4_096, total_tokens: 1_054_096 } }));
  assert.equal(allWrites.settledMicros, 5_323_728);
});

test("missing cache components retain conservative known-token exposure without a fabricated rated amount", () => {
  for (const details of [undefined, null, {}, { cached_tokens: 600 }, { cache_write_tokens: 200 }]) {
    const usage = { ...response().usage, input_tokens_details: details };
    const assessment = assessTextUsage(buildTextRequest(input), response({ usage }));
    assert.equal(assessment.basis, "usage_bounded");
    assert.equal(assessment.settledMicros, 0);
    assert.equal(assessment.uncertainMicros, 370);
    assert.equal(assessment.ratedCostNanoUsd, undefined);
  }
});

test("untrustworthy usage or an unreserved response cannot release the gateway reservation", () => {
  const request = buildTextRequest(input);
  const invalidResponses = [
    { usage: null }, { model: undefined }, { service_tier: "priority" }, { service_tier: undefined },
    { status: "in_progress" }, { max_output_tokens: 8_192 },
    { usage: { ...response().usage, total_tokens: undefined } },
    { usage: { ...response().usage, total_tokens: 1_101 } },
    { usage: { ...response().usage, input_tokens: Number.NaN } },
    { usage: { ...response().usage, input_tokens: 1_050_001, total_tokens: 1_050_101 } },
    { usage: { ...response().usage, output_tokens: 4_097, total_tokens: 5_097 } },
    { usage: { ...response().usage, input_tokens_details: { cached_tokens: 900, cache_write_tokens: 200 } } },
    { usage: { ...response().usage, input_tokens_details: { cached_tokens: 0, cache_write_tokens: -1 } } },
    { usage: { ...response().usage, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0, unknown_billable_tokens: 10 } } },
    { usage: { ...response().usage, output_tokens_details: { reasoning_tokens: 101 } } },
  ];
  for (const invalid of invalidResponses) assert.throws(() => assessTextUsage(request, response(invalid)), /Text envelope:/);
});
