import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { BudgetStore } from "../src/server/budget/store";
import { FakeProviderGateway } from "../src/server/providers/gateway";
import { assessImageUsage, buildImageRequest, buildLandscapeImageRequest, IMAGE_MODEL_V2, IMAGE_RATE_SCHEDULE_ID_V3, imageMaximumMicros, validateImageRequest } from "../src/server/providers/image-envelope";
import { generateArtwork, parseArtwork } from "../src/server/providers/image-generation";
import { readProviderResponse, serializeProviderRequest } from "../src/server/providers/http-transport";
import { canonicalJson, inputHash } from "../src/server/paid-input";
import { initializeFakeBudget } from "./helpers/budget-fixture";

function location() { return initializeFakeBudget(path.join(realpathSync(mkdtempSync(path.join(os.tmpdir(), "kely-image-test-"))), "authority")); }
const input = { ownerId: "owner", operationId: "post-1", step: "artwork:0", prompt: "A ceramic coffee cup, no text", snapshot: { approved: "coffee" }, origin: "ai_preview" as const };
function response(png: Buffer) { return { created: 1789257600, _request_id: "req_image_test", http_status: 200, data: [{ b64_json: png.toString("base64") }], usage: { input_tokens: 100, input_tokens_details: { text_tokens: 100, image_tokens: 0 }, output_tokens: 6240, output_tokens_details: { image_tokens: 6240, text_tokens: 0 }, total_tokens: 6340 } }; }

test("new landscape request preserves portrait scope and validates its own decoded dimensions", async () => {
  const portrait = buildImageRequest(input.prompt), request = buildLandscapeImageRequest(input.prompt);
  assert.equal(portrait.size, "1024x1536");
  assert.equal(request.size, "1536x1024");
  assert.throws(() => validateImageRequest({ ...portrait, size: "1536x1024" }));
  assert.equal(imageMaximumMicros(request), imageMaximumMicros(portrait));
  const png = await sharp({ create: { width: 1536, height: 1024, channels: 3, background: "#C85A3A" } }).png().toBuffer();
  assert.deepEqual(await parseArtwork(response(png), request.size), png);
  await assert.rejects(parseArtwork(response(png)), /dimensions/);
  assert.equal(assessImageUsage(request, { ...response(png), size: "1536x1024" }).settledMicros, 200180);
  assert.throws(() => assessImageUsage(request, { ...response(png), size: "1024x1536" }));
  assert.equal(Object.hasOwn(JSON.parse(serializeProviderRequest(request)), "accountingPolicy"), false);
});

test("artwork survives authority restart and replay without another provider call", async () => {
  const png = await sharp(randomBytes(1024 * 1536 * 3), { raw: { width: 1024, height: 1536, channels: 3 } }).png().toBuffer();
  assert.ok(Buffer.byteLength(JSON.stringify(response(png))) > 2_200_000);
  const loc = location();
  let budget = new BudgetStore(loc), sends = 0;
  let gateway = new FakeProviderGateway(budget, { kind: "fake", async send() { sends++; return response(png); } });
  const result = await generateArtwork(input, gateway);
  assert.deepEqual(result.png, png);
  assert.equal(result.assessment.settledMicros, 200180);
  budget.close();
  budget = new BudgetStore(loc);
  gateway = new FakeProviderGateway(budget, { kind: "fake", async send() { sends++; return response(png); } });
  assert.equal((await generateArtwork(input, gateway)).replayed, true);
  assert.equal(sends, 1);
  await assert.rejects(generateArtwork({ ...input, prompt: "Different scope" }, gateway), { code: "attempt_conflict" });
  assert.equal(budget.inspect().settledMicros, 200180);
  budget.close();
});

test("invalid image scope and unexpected usage do not permit an unaccounted retry", async () => {
  assert.equal(imageMaximumMicros(buildImageRequest(input.prompt)), 839680);
  assert.throws(() => validateImageRequest({ ...buildImageRequest(input.prompt), n: 2 }));
  assert.throws(() => buildImageRequest("a".repeat(8001)));
  await assert.rejects(generateArtwork(input), /isolated transport/);
  const budget = new BudgetStore(location());
  let sends = 0;
  const gateway = new FakeProviderGateway(budget, { kind: "fake", async send() { sends++; const raw = response(Buffer.from("invalid")); raw.usage.output_tokens = 6241; raw.usage.total_tokens = 6341; return raw; } });
  await assert.rejects(generateArtwork(input, gateway), { code: "attempt_uncertain" });
  await assert.rejects(generateArtwork(input, gateway), { code: "attempt_uncertain" });
  assert.equal(sends, 1);
  assert.equal(budget.inspect().uncertainMicros, 839680);
  budget.close();
});

test("paid usage remains settled when returned artwork cannot be used", async () => {
  const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: "white" } }).png().toBuffer();
  const budget = new BudgetStore(location());
  const gateway = new FakeProviderGateway(budget, { kind: "fake", async send() { return response(png); } });
  await assert.rejects(generateArtwork(input, gateway), /dimensions/);
  assert.equal(budget.inspect().settledMicros, 200180);
  await assert.rejects(parseArtwork({ data: [{ b64_json: "not an image" }] }));
  budget.close();
});

test("image response transport permits image-sized JSON and omits malformed body content", async () => {
  const raw = { data: [{ b64_json: "A".repeat(2_100_000) }] };
  assert.deepEqual((await readProviderResponse(new Response(JSON.stringify(raw)), true) as { data: unknown }).data, raw.data);
  await assert.rejects(readProviderResponse(new Response("private-image-data"), true), (error: unknown) => {
    assert.equal(JSON.stringify(error).includes("private-image-data"), false);
    return true;
  });
});

test("image numeric usage is versioned, missing breakdown completes with retained upper cost, and mismatch keeps large evidence", async () => {
  const png = await sharp(randomBytes(1024 * 1536 * 3), { raw: { width: 1024, height: 1536, channels: 3 } }).png().toBuffer();
  const request = buildImageRequest(input.prompt);
  assert.equal(request.model, "gpt-image-1.5");
  assert.ok("accountingPolicy" in request);
  assert.equal(request.accountingPolicy, IMAGE_RATE_SCHEDULE_ID_V3);
  const { accountingPolicy: _policy, ...wire } = request;
  const legacy = validateImageRequest(wire);
  const pinned = validateImageRequest({ ...wire, model: IMAGE_MODEL_V2 });
  assert.equal(serializeProviderRequest(request), canonicalJson(legacy));
  assert.equal(serializeProviderRequest(pinned), canonicalJson(pinned));
  assert.notEqual(inputHash(request), inputHash(legacy));
  assert.throws(() => serializeProviderRequest({ ...request, accountingPolicy: "unreviewed" } as never));
  const mixed = response(png);
  mixed.usage.output_tokens = 6277;
  mixed.usage.output_tokens_details.text_tokens = 37;
  mixed.usage.total_tokens = 6377;
  assert.equal(assessImageUsage(request, mixed).settledMicros, 200550);
  assert.equal(assessImageUsage(pinned, mixed).settledMicros, 200550);
  assert.equal(assessImageUsage(request, { ...mixed, model: "gpt-image-1.5" }).usage.rate_schedule, IMAGE_RATE_SCHEDULE_ID_V3);
  assert.throws(() => assessImageUsage(request, { ...mixed, model: IMAGE_MODEL_V2 }));
  assert.throws(() => assessImageUsage(legacy, mixed));
  const loc = location();
  let budget = new BudgetStore(loc), sends = 0;
  try {
    const oldInput = { key: "legacy", ownerId: "owner", operationId: "legacy", step: "artwork:0", snapshot: {}, request: legacy };
    budget.claim(oldInput);
    const oldAssessment = budget.settle("legacy", response(png));
    const pinnedInput = { ...oldInput, key: "pinned", operationId: "pinned", request: pinned };
    budget.claim(pinnedInput);
    const pinnedAssessment = budget.settle("pinned", mixed);
    const { output_tokens_details: _details, ...unpartitioned } = mixed.usage;
    const boundedResponse = { ...mixed, usage: unpartitioned };
    let gateway = new FakeProviderGateway(budget, { kind: "fake", async send() { sends++; return boundedResponse; } });
    const result = await generateArtwork({ ...input, operationId: "bounded" }, gateway);
    assert.deepEqual(result.png, png);
    assert.deepEqual([result.assessment.basis, result.assessment.settledMicros, result.assessment.uncertainMicros], ["usage_bounded", 0, 201364]);
    const malformed = response(png);
    malformed.usage.total_tokens++;
    gateway = new FakeProviderGateway(budget, { kind: "fake", async send() { sends++; return malformed; } });
    await assert.rejects(generateArtwork({ ...input, operationId: "mismatch" }, gateway), { code: "attempt_uncertain" });
    budget.close(); budget = new BudgetStore(loc);
    const saved = budget.inspect();
    assert.deepEqual(saved.attempts.find((item) => item.key === "legacy")?.assessment, oldAssessment);
    assert.deepEqual(saved.attempts.find((item) => item.key === "pinned")?.assessment, pinnedAssessment);
    assert.deepEqual(saved.attempts.find((item) => item.key === "pinned")?.request, pinned);
    assert.throws(() => budget.claim({ ...oldInput, request }), { code: "attempt_conflict" });
    const mismatch = saved.attempts.find((item) => item.operationId === "mismatch")!;
    assert.deepEqual(mismatch.response, malformed);
    assert.deepEqual(mismatch.validationIssues, [{ path: "usage.total_tokens", code: "partition_mismatch" }]);
    assert.equal(mismatch.uncertainMicros, 839680);
    const replay = new FakeProviderGateway(budget, { kind: "fake", async send() { sends++; throw new Error("Must not send"); } });
    assert.equal((await generateArtwork({ ...input, operationId: "bounded" }, replay)).replayed, true);
    await assert.rejects(generateArtwork({ ...input, operationId: "mismatch" }, replay), { code: "attempt_uncertain" });
    assert.equal(sends, 2);
    assert.equal(budget.inspect().uncertainMicros, 201364 + 839680);
  } finally { budget.close(); }
});
