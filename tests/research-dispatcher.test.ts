import assert from "node:assert/strict";
import test from "node:test";
import type { AttemptInput } from "../src/server/budget/store";
import { dispatchEntitySearch, entitySearchAttempt, researchTextStageAttempt } from "../src/server/providers/research-dispatcher";
import { WEB_SEARCH_RATE_SCHEDULE_ID } from "../src/server/providers/web-search-envelope";
import { researchPackageInput } from "../src/server/budget/research-package";

const input = { ownerId: "owner-1", runId: "00000000-0000-4000-8000-000000000001", businessName: "Girex", userSuppliedUrls: ["https://girex.io"], searchNumber: 1 as const, fetchedAt: "2026-09-21T10:00:00.000Z" };
const reservation = researchPackageInput(input.ownerId, input.runId, "a".repeat(64));
const reservedInput = { ...input, reservation };

function response(overrides: Record<string, unknown> = {}) {
  const output = { kind: "entity_discovery", candidates: [{ id: "girex", displayName: "Girex", canonicalUrl: "https://girex.io", citations: [{ url: "https://girex.io", excerpt: "Girex is a candidate business identity." }] }] };
  return {
    id: "resp_fixture", model: "gpt-5.6-luna", service_tier: "default", status: "completed",
    usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
    output: [{ type: "web_search_call", action: { type: "search", query: "Girex", sources: [{ type: "url", url: "https://girex.io" }] } }, { type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }],
    ...overrides,
  };
}

test("entity search builds one bounded accounted web-search attempt", () => {
  const attempt = entitySearchAttempt(input);
  assert.ok("accountingPolicy" in attempt.request);
  assert.equal(attempt.request.accountingPolicy, WEB_SEARCH_RATE_SCHEDULE_ID);
  assert.equal(attempt.request.max_tool_calls, 1);
  assert.equal(attempt.step, "entity-search-1");
  assert.equal(attempt.snapshot.searchNumber, 1);
  assert.throws(() => entitySearchAttempt({ ...input, searchNumber: 3 as never }), /research_search_number_invalid/u);
  assert.equal(entitySearchAttempt({ ...input, reservation }).packageId, reservation.id);
  assert.throws(() => entitySearchAttempt({ ...input, reservation: { ...reservation, operationId: "another-run" } }), { code: "research_package_scope_invalid" });
});

test("dispatcher accepts only cited HTTPS candidates and returns external context evidence", async () => {
  let sent: AttemptInput | undefined;
  const result = await dispatchEntitySearch({ async dispatch(attempt) { sent = attempt; return { response: response(), assessment: { settledMicros: 10_050 }, replayed: false }; } }, reservedInput);
  assert.equal(sent?.step, "entity-search-1");
  assert.equal(sent?.packageId, reservation.id);
  assert.equal(result.candidates[0].signals.officialSiteClaim, false);
  assert.equal(result.candidates[0].signals.userSuppliedUrl, true);
  assert.equal(result.evidence[0].sourceRole, "external_context");
  assert.equal(result.evidence[0].excerpt, "Girex is a candidate business identity.");
  assert.deepEqual(result.evidence[0].span, { start: 0, end: result.evidence[0].excerpt.length });
});

test("unreturned citations and model-controlled official signals fail closed", async () => {
  const parsed = { kind: "entity_discovery", candidates: [{ id: "girex", displayName: "Girex", canonicalUrl: "https://girex.io", citations: [{ url: "https://invented.example", excerpt: "Invented citation" }] }] };
  const untrusted = response({ output: [{ type: "web_search_call", action: { type: "search", query: "Girex", sources: [{ type: "url", url: "https://girex.io" }] } }, { type: "message", content: [{ type: "output_text", text: JSON.stringify(parsed) }] }] });
  await assert.rejects(dispatchEntitySearch({ async dispatch() { return { response: untrusted, assessment: {}, replayed: false }; } }, reservedInput), /research_citation_not_returned_by_search/u);
});

test("dispatcher requires exactly one search call and one structured message", async () => {
  const duplicateCall = response();
  (duplicateCall.output as unknown[]).splice(1, 0, duplicateCall.output[0]);
  await assert.rejects(dispatchEntitySearch({ async dispatch() { return { response: duplicateCall, assessment: {}, replayed: false }; } }, reservedInput), /research_search_call_invalid/u);
});

test("all paid text research stages are bound to the same whole-run reservation", () => {
  const schema = { type: "object", additionalProperties: false, required: ["result"], properties: { result: { type: "string" } } };
  for (const stage of ["extract:0", "strategy:0", "check:0"] as const) {
    const attempt = researchTextStageAttempt({ ownerId: input.ownerId, runId: input.runId, stage, context: "bounded context", instructions: "Return the bounded result.", schemaName: `research_${stage.replace(":", "_")}`, schema, reservation });
    assert.equal(attempt.packageId, reservation.id);
    assert.equal(attempt.step, stage);
    assert.ok("max_output_tokens" in attempt.request);
    assert.equal(attempt.request.max_output_tokens, stage === "strategy:0" ? 4_096 : 2_048);
  }
});
