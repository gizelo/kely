import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { BudgetStore, replayBudgetHistory, eventSchema } from "../src/server/budget/store";
import { initializeFakeBudget, fakeAttempt, fakeResponse } from "./helpers/budget-fixture";

test("portable replay preserves settlement and uncertainty; transfer fences existing and reopened stores", async () => {
  const location = initializeFakeBudget(path.join(realpathSync(await mkdtemp(path.join(os.tmpdir(), "kely-transfer-"))), "authority"));
  const original = new BudgetStore(location);
  const alreadyOpen = new BudgetStore(location);
  try {
    const paid = fakeAttempt();
    original.claim(paid);
    original.settle(paid.key, fakeResponse(paid.request));
    const unknown = fakeAttempt();
    original.claim(unknown);
    original.markUncertain(unknown.key, "timeout");
    const { state, rows } = original.exportHistory();
    const genesis = eventSchema.parse(JSON.parse(rows[0].payload));
    assert.equal(genesis.type, "initialized");
    if (genesis.type !== "initialized") throw new Error("Missing genesis");
    assert.deepEqual(replayBudgetHistory(genesis.identity, rows), state);
    const damaged = structuredClone(rows);
    damaged[1].payload += " ";
    assert.throws(() => replayBudgetHistory(genesis.identity, damaged));
    assert.throws(() => original.fenceForTransfer("fake-cloud-destination-001", rows[0].hash));
    original.fenceForTransfer("fake-cloud-destination-001", rows.at(-1)!.hash);
    assert.throws(() => alreadyOpen.claim(fakeAttempt()));
    const reopened = new BudgetStore(location);
    try {
      assert.throws(() => reopened.claim(fakeAttempt()));
      assert.deepEqual(reopened.inspect(), state);
      assert.throws(() => reopened.fenceForTransfer("fake-cloud-destination-002", rows.at(-1)!.hash));
    } finally { reopened.close(); }
  } finally { original.close(); alreadyOpen.close(); }
});
