import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { interpretRevision } from "../src/server/revision-scope";
import { readProviderResponse, serializeProviderRequest } from "../src/server/providers/http-transport";
import { createLiveGateway, FakeProviderGateway } from "../src/server/providers/gateway";
import { approvedProviderCredential } from "../src/server/providers/credential";
import { BudgetStore } from "../src/server/budget/store";
import { canonicalJson } from "../src/server/paid-input";
import { fakeAttempt, fakeResponse, initializeFakeBudget } from "./helpers/budget-fixture";
import type { PublicationView } from "../src/shared/contracts";

test("revision scope separates preservation constraints and refuses competing changes before payment", () => {
  const state = { slideCount: 3 } as PublicationView;
  assert.deepEqual(interpretRevision(state, "Change only the headline on slide 1 to “Your cozy coffee moment”. Keep the illustration, colors, body text and caption unchanged."), { target: 1, kind: "copy" });
  assert.deepEqual(interpretRevision(state, "Change the headline on slide 1 to “Your cozy coffee moment”."), { target: 1, kind: "copy" });
  assert.throws(() => interpretRevision(state, "Change the headline and colors on slide 1. Keep the illustration and caption unchanged."), { code: "revision_scope_required" });
  assert.deepEqual(interpretRevision(state, "Make slide 2 warmer without changing the text"), { target: 2, kind: "style" });
  assert.deepEqual(interpretRevision(state, "Keep slide 1 unchanged, but rewrite slide 2"), { target: 2, kind: "copy" });
  assert.deepEqual(interpretRevision(state, "Change only slide 2 to explain the idea more simply. Preserve opening, closing and agreed visual style"), { target: 2, kind: "copy" });
  assert.deepEqual(interpretRevision(state, "Сделай слайд 2 теплее, не меняя текст"), { target: 2, kind: "style" });
  assert.deepEqual(interpretRevision(state, "Сохрани слайд 1 без изменений, но перепиши текст слайда 2"), { target: 2, kind: "copy" });
  const creative = { ...state, designPolicy: "creative-intent-v3" as const };
  assert.deepEqual(interpretRevision(creative, "Change the visual plan on slide 2: make the interface screenshot wide and prominent below the copy. Keep all wording, colors, fonts, the other slides and caption unchanged."), { target: 2, kind: "plan" });
  assert.throws(() => interpretRevision(creative, "Change the visual plan on slide 2: place the screenshot below the copy and rewrite the title."), { code: "revision_scope_required" });
  for (const input of ["Rewrite slides 1 and 2", "Rewrite slide 1 and 2", "Rewrite slide 1 and make slide 2 warmer", "Rewrite slide 2 and change its style", "Make it better"]) assert.throws(() => interpretRevision(state, input), { code: "revision_scope_required" });
});

test("bounded HTTP response handling preserves request evidence and refuses redirects, truncation and oversized bodies", async () => {
  const request = fakeAttempt().request;
  assert.equal(serializeProviderRequest(request), canonicalJson(request));
  const parsed = await readProviderResponse(new Response(JSON.stringify(fakeResponse(request)), { headers: { "x-request-id": "req-proof" } })) as Record<string, unknown>;
  assert.equal(parsed._request_id, "req-proof");
  for (const response of [new Response("{}", { status: 302, headers: { location: "https://other.invalid", "x-request-id": "redirect-proof" } }), new Response("{", { headers: { "x-request-id": "invalid-proof" } }), new Response("x".repeat(2_097_153), { headers: { "x-request-id": "large-proof" } })]) {
    await assert.rejects(readProviderResponse(response), (error: unknown) => Boolean(error && typeof error === "object" && "evidence" in error && (error.evidence as Record<string, unknown>)._request_id));
  }
  assert.throws(() => createLiveGateway(), /not been approved/i);
  assert.throws(() => approvedProviderCredential(), /not been approved/i);
});

test("received invalid usage retains bounded response evidence and the same attempt cannot redispatch", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "kely-evidence-")));
  const store = new BudgetStore(initializeFakeBudget(join(directory, "ledger")));
  let sends = 0;
  const input = fakeAttempt();
  const response = { ...fakeResponse(input.request), model: "unknown-snapshot", _request_id: "req-reconcile", output: [{ type: "message", content: [{ type: "output_text", text: "A recoverable result" }] }] };
  const gateway = new FakeProviderGateway(store, { kind: "fake", async send() { sends++; return response; } });
  try {
    await assert.rejects(gateway.dispatch(input), { code: "attempt_uncertain" });
    await assert.rejects(gateway.dispatch(input), { code: "attempt_uncertain" });
    const saved = store.inspect();
    assert.equal(sends, 1);
    assert.equal(saved.uncertainMicros, 532_373);
    assert.deepEqual(saved.attempts[0].response, response);
    const partial = fakeAttempt();
    const timeout = new FakeProviderGateway(store, { kind: "fake", async send(_request, context) { context.receivedEvidence?.({ _request_id: "req-partial", http_status: 200 }); return new Promise(() => {}); } }, 10);
    await assert.rejects(timeout.dispatch(partial), { code: "attempt_uncertain" });
    assert.deepEqual(store.inspect().attempts[1].response, { _request_id: "req-partial", http_status: 200 });
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});
