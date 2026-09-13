import assert from "node:assert/strict";
import test from "node:test";
import { canReserveBudget } from "../src/server/budget-policy";
import { billingPeriodEnd, weeklyWindow, WEEK_MS } from "../src/server/credits";
import { allowedLocalHost } from "../src/server/request-boundary";
import { assertFixtureMode } from "../src/server/config";

test("weekly windows stay anchored across payment months and do not accumulate skipped weeks", () => {
  const anchor = new Date("2026-01-31T12:00:00Z");
  const before = weeklyWindow(anchor, new Date(anchor.getTime() + WEEK_MS - 1));
  const after = weeklyWindow(anchor, new Date(anchor.getTime() + WEEK_MS));
  assert.equal(before.expiresAt.toISOString(), "2026-02-07T12:00:00.000Z");
  assert.notEqual(before.key, after.key);
  assert.equal(weeklyWindow(anchor, new Date("2026-03-01T12:00:00Z")).key, `${anchor.toISOString()}/4`);
});

test("fixture payment periods clamp month-end dates instead of overflowing into another month", () => {
  assert.equal(billingPeriodEnd(new Date("2026-01-31T12:00:00Z"), "monthly").toISOString(), "2026-02-28T12:00:00.000Z");
  assert.equal(billingPeriodEnd(new Date("2028-02-29T12:00:00Z"), "annual").toISOString(), "2029-02-28T12:00:00.000Z");
});

test("budget admission includes reservations and unknown exposure, and fails closed on invalid numbers", () => {
  const budget = { spentMicros: 8_000_000, reservedMicros: 500_000, uncertainMicros: 1_000_000, ceilingMicros: 10_000_000 };
  assert.equal(canReserveBudget(budget, 500_000), true);
  assert.equal(canReserveBudget(budget, 500_001), false);
  assert.equal(canReserveBudget({ ...budget, uncertainMicros: Number.NaN }, 1), false);
  assert.equal(canReserveBudget(budget, 0), false);
});

test("fixture runtime cannot be enabled as a live provider by configuration", () => {
  const previous = process.env.KELY_LIVE_ENABLED;
  try {
    process.env.KELY_LIVE_ENABLED = "true";
    assert.throws(() => assertFixtureMode(), /fixture mode only/);
  } finally {
    if (previous === undefined) delete process.env.KELY_LIVE_ENABLED;
    else process.env.KELY_LIVE_ENABLED = previous;
  }
});

test("local boundary checks raw Host rather than a reconstructed request URL", () => {
  assert.equal(allowedLocalHost(new Request("http://localhost:3130/api/kely/account", { headers: { host: "foreign.example:3130" } })), false);
  assert.equal(allowedLocalHost(new Request("http://localhost:3130/api/kely/account", { headers: { host: "localhost:3130" } })), true);
});
