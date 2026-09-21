import assert from "node:assert/strict";
import test from "node:test";
import { interruptedResearchOutcome } from "../src/server/research-recovery";

test("interrupted research releases only when no provider outcome is unknown", () => {
  assert.equal(interruptedResearchOutcome([]), "failed");
  assert.equal(interruptedResearchOutcome(["settled", "settled"]), "failed");
  assert.equal(interruptedResearchOutcome(["uncertain"]), "uncertain");
  assert.equal(interruptedResearchOutcome(["settled", "dispatching"]), "uncertain");
});
