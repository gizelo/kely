import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import sharp from "sharp";
import { BudgetStore } from "../src/server/budget/store";
import { budgetFiles } from "../src/server/budget/identity";
import { FakeProviderGateway } from "../src/server/providers/gateway";
import { analysisRequest } from "../src/server/providers/analysis";
import { validateVisionRequest, visionMaximumMicros, VISION_RATE_SCHEDULE_ID } from "../src/server/providers/vision-envelope";
import { fakeAttempt, fakeResponse, initializeFakeBudget } from "./helpers/budget-fixture";
import { providerRateSchedule } from "../src/server/providers/provider-envelope";

async function request() {
  const image = await sharp({ create: { width: 320, height: 200, channels: 3, background: "#224466" } }).jpeg({ quality: 90 }).toBuffer();
  return analysisRequest({ guidance: "Inspect only this reference", rules: { audience: "Owners", headlines: "default", palette: null }, selected: [{ id: randomUUID(), label: "Private raster", role: "reference", version: 1, originalHash: "a".repeat(64), derivativeHash: "b".repeat(64), width: 320, height: 200, dataUrl: `data:image/jpeg;base64,${image.toString("base64")}` }] });
}

test("mixed text and vision share one ceiling and preserve old event bytes across reopen and replay", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kely-vision-budget-")));
  const location = initializeFakeBudget(join(root, "ledger"));
  let store = new BudgetStore(location);
  let sends = 0;
  const transport = { kind: "fake" as const, async send(input: Parameters<typeof fakeResponse>[0]) { sends++; return fakeResponse(input, { full: true }); } };
  let gateway = new FakeProviderGateway(store, transport);
  try {
    const old = fakeAttempt();
    await gateway.dispatch(old);
    const db = new DatabaseSync(budgetFiles(location).database, { readOnly: true });
    const previous = db.prepare("SELECT * FROM event ORDER BY sequence").all(); db.close();
    const vision = { ...fakeAttempt(), step: "brand-analysis", request: await request() };
    assert.equal(visionMaximumMicros(vision.request), 532373);
    assert.equal(providerRateSchedule(vision.request), VISION_RATE_SCHEDULE_ID);
    await gateway.dispatch(vision);
    store.close(); store = new BudgetStore(location); gateway = new FakeProviderGateway(store, transport);
    assert.equal((await gateway.dispatch(old)).replayed, true);
    assert.equal((await gateway.dispatch(vision)).replayed, true);
    assert.equal(sends, 2);
    const reread = new DatabaseSync(budgetFiles(location).database, { readOnly: true });
    assert.deepEqual(reread.prepare("SELECT * FROM event WHERE sequence<=? ORDER BY sequence").all(previous.length), previous); reread.close();
    for (let index = 0; index < 16; index++) await gateway.dispatch(fakeAttempt());
    await assert.rejects(gateway.dispatch({ ...fakeAttempt(), step: "brand-analysis", request: vision.request }), { code: "budget_exhausted" });
    assert.equal(sends, 18);
    assert.equal(store.inspect().settledMicros, 18 * 532373);
  } finally { store.close(); rmSync(root, { recursive: true }); }
});

test("vision rejects remote, unbounded or unpriced inputs and retains invalid-usage liability without resend", async () => {
  const valid = await request();
  const mutated = structuredClone(valid) as any;
  mutated.input[0].content[1].image_url = "https://foreign.example/private.png";
  assert.throws(() => validateVisionRequest(mutated), /local JPEG/);
  mutated.input[0].content[1] = { ...valid.input[0].content[1], detail: "auto" };
  assert.throws(() => validateVisionRequest(mutated), /high-detail/);
  assert.throws(() => validateVisionRequest({ ...valid, model: "gpt-5.6-terra" }), /Luna/);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kely-vision-uncertain-")));
  const store = new BudgetStore(initializeFakeBudget(join(root, "ledger")));
  let sends = 0;
  const gateway = new FakeProviderGateway(store, { kind: "fake", async send(input) { sends++; return { ...fakeResponse(input), usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } }; } });
  try {
    const attempt = { ...fakeAttempt(), step: "brand-analysis", request: valid };
    await assert.rejects(gateway.dispatch(attempt), { code: "attempt_uncertain" });
    await assert.rejects(gateway.dispatch(attempt), { code: "attempt_uncertain" });
    assert.equal(sends, 1); assert.equal(store.inspect().uncertainMicros, 532373);
    assert.equal(store.inspect().settledMicros, 0);
  } finally { store.close(); rmSync(root, { recursive: true }); }
});
