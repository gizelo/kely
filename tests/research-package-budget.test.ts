import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BudgetStore } from "../src/server/budget/store";
import { bindResearchAttempt, closeResearchPackageFromDurableEvidence, researchPackageInput, reserveResearchPackage } from "../src/server/budget/research-package";
import { buildTextRequest } from "../src/server/providers/text-envelope";
import { fakeAttempt, fakeResponse, initializeFakeBudget } from "./helpers/budget-fixture";

test("material vision is reserved only when selected", () => {
  const without = researchPackageInput("owner", "00000000-0000-4000-8000-000000000090", "a".repeat(64));
  const withMaterial = researchPackageInput("owner", "00000000-0000-4000-8000-000000000091", "b".repeat(64), ["00000000-0000-4000-8000-000000000001"]);
  assert.equal(without.steps.some((item) => item.step === "materials:0"), false);
  assert.equal(withMaterial.steps.find((item) => item.step === "materials:0")?.maximumMicros, 532_373);
  assert.notEqual(without.scopeHash, withMaterial.scopeHash);
});

test("whole research reservations are idempotent, survive restart and fence their remaining funds", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "kely-research-package-")));
  const location = initializeFakeBudget(join(directory, "budget"));
  const ownerId = "research-owner";
  const reservations = Array.from({ length: 4 }, (_, index) => researchPackageInput(ownerId, `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, String(index + 1).repeat(64).slice(0, 64)));
  let store = new BudgetStore(location);
  try {
    for (const reservation of reservations) await reserveResearchPackage(store, reservation.ownerId, reservation.operationId, String(reservations.indexOf(reservation) + 1).repeat(64).slice(0, 64));
    const replay = await reserveResearchPackage(store, reservations[0].ownerId, reservations[0].operationId, "1".repeat(64));
    assert.equal(replay.id, reservations[0].id);
    assert.equal(store.inspect().packages.length, 4);
    assert.ok(store.inspect().reservedMicros > 0);
    await assert.rejects(Promise.resolve().then(() => store.claim(fakeAttempt(randomUUID(), "gpt-5.6-terra"))), { code: "budget_exhausted" });

    const request = buildTextRequest({ model: "gpt-5.6-luna", input: "bounded evidence", instructions: "Extract exact evidence.", maxOutputTokens: 2_048 });
    const attempt = bindResearchAttempt({ key: randomUUID(), ownerId, operationId: reservations[0].operationId, step: "extract:0", snapshot: { research: true }, request }, reservations[0]);
    const claimed = store.claim(attempt);
    assert.equal(claimed.dispatched, true);
    const beforeRestart = store.inspect();
    assert.equal(beforeRestart.attempts[0].packageId, reservations[0].id);
    store.close();
    store = new BudgetStore(location);
    assert.equal(store.inspect().packages[0].remainingMicros, beforeRestart.packages[0].remainingMicros);
    store.settle(attempt.key, fakeResponse(request));
    const evidenceHash = "a".repeat(64);
    const closed = store.closePackage({ id: reservations[0].id, ownerId, operationId: reservations[0].operationId, scopeHash: reservations[0].scopeHash, outcome: "completed", evidenceHash });
    assert.equal(closed.status, "completed");
    assert.equal(store.closePackage({ id: reservations[0].id, ownerId, operationId: reservations[0].operationId, scopeHash: reservations[0].scopeHash, outcome: "completed", evidenceHash }).status, "completed");
    assert.throws(() => store.closePackage({ id: reservations[0].id, ownerId, operationId: reservations[0].operationId, scopeHash: reservations[0].scopeHash, outcome: "released", evidenceHash }), { code: "attempt_conflict" });
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("package closure requires durable terminal research evidence and uncertainty retains funds", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "kely-research-close-")));
  const store = new BudgetStore(initializeFakeBudget(join(directory, "budget")));
  const ownerId = "research-owner";
  const runId = "00000000-0000-4000-8000-000000000010";
  const researchInputHash = "b".repeat(64);
  const reservation = researchPackageInput(ownerId, runId, researchInputHash);
  try {
    store.reservePackage(reservation);
    const partialDb = { async query() { return { rows: [{ input_hash: researchInputHash, sequence: 3, status: "needs_input", detail: {}, snapshot_id: null, snapshot_version: null, snapshot_hash: null, source_hashes: [] }] }; } };
    await assert.rejects(closeResearchPackageFromDurableEvidence(partialDb as never, store, ownerId, runId, researchInputHash), { code: "research_package_not_terminal" });

    const answeredRunId = "00000000-0000-4000-8000-000000000011";
    const answeredInputHash = "c".repeat(64);
    store.reservePackage(researchPackageInput(ownerId, answeredRunId, answeredInputHash));
    const answeredDb = { async query() { return { rows: [{ input_hash: answeredInputHash, sequence: 4, status: "needs_input", detail: { question: "identity" }, snapshot_id: null, snapshot_version: null, snapshot_hash: null, source_hashes: ["d".repeat(64)] }] }; } };
    const released = await closeResearchPackageFromDurableEvidence(answeredDb as never, store, ownerId, answeredRunId, answeredInputHash);
    assert.equal(released.status, "released");

    const request = buildTextRequest({ model: "gpt-5.6-luna", input: "bounded evidence", instructions: "Extract exact evidence.", maxOutputTokens: 2_048 });
    const attempt = bindResearchAttempt({ key: randomUUID(), ownerId, operationId: runId, step: "extract:0", snapshot: { research: true }, request }, reservation);
    store.claim(attempt);
    store.markUncertain(attempt.key, "timeout", { _request_id: "unknown", http_status: 200 });
    const failedDb = { async query() { return { rows: [{ input_hash: researchInputHash, sequence: 4, status: "failed", detail: { reason: "stopped" }, snapshot_id: null, snapshot_version: null, snapshot_hash: null, source_hashes: [] }] }; } };
    await assert.rejects(closeResearchPackageFromDurableEvidence(failedDb as never, store, ownerId, runId, researchInputHash), { code: "attempt_uncertain" });
    assert.equal(store.inspect().packages[0].status, "active");
    assert.ok(store.inspect().uncertainMicros > 0);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
