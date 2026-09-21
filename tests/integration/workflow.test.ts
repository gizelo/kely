import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { unzipSync } from "fflate";
import { auth } from "../../src/server/auth";
import { handleApi } from "../../src/server/api";
import { accountView, lockWallet, simulateBilling, WEEK_MS, type Viewer } from "../../src/server/credits";
import { pool, transaction } from "../../src/server/db";
import { acceptQuote, createPublication, quoteOperation, readPublication } from "../../src/server/publications";
import { runFixtureOperation } from "../../src/server/operations";
import { getBoss } from "../../src/server/queue";
import type { PublicationView, QuoteView } from "../../src/shared/contracts";
import { loadAcceptedInput } from "../../src/server/accepted-input";
import { updateBrandRule } from "../../src/server/brand";
import { createTestAccount } from "../../src/server/operator-access";

assert.match(process.env.KELY_DATABASE_URL ?? "", /\/kely_fixture_test$/, "Integration tests require the isolated fixture test database.");

type Client = { viewer: Viewer; cookie: string };
async function createClient(): Promise<Client> {
  const marker = randomUUID();
  const email = `${marker}@fixture.example.test`;
  const password = randomUUID();
  const created = await createTestAccount({ name: "Kely fixture test", email, password, commandKey: `workflow-${marker}` });
  const response = await auth.handler(new Request("http://localhost:3130/api/auth/sign-in/email", {
    method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3130", host: "localhost:3130" },
    body: JSON.stringify({ email, password }),
  }));
  assert.equal(response.status, 200);
  const { user } = await response.json();
  assert.equal(user.id, created.ownerId);
  return { viewer: { id: user.id, name: user.name, email: user.email }, cookie: response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ") };
}

async function request(client: Client, path: string, input?: unknown, expected = 200, extraHeaders: Record<string, string> = {}) {
  const [pathname, query] = path.split("?");
  const response = await handleApi(new Request(`http://localhost:3130/api/kely/${pathname}${query ? `?${query}` : ""}`, {
    method: input === undefined ? "GET" : "POST",
    headers: { host: "localhost:3130", origin: "http://localhost:3130", cookie: client.cookie, "content-type": "application/json", ...extraHeaders },
    body: input === undefined ? undefined : JSON.stringify(input),
  }), pathname.split("/"));
  assert.equal(response.status, expected, `Unexpected status for ${pathname}`);
  return response;
}

async function post(client: Client, path: string, input?: unknown, expected = 200) {
  return (await request(client, path, input, expected)).json();
}

async function runStage(client: Client, state: PublicationView, kind: QuoteView["kind"], instruction?: string, failure?: number) {
  const quote: QuoteView = await post(client, `publications/${state.id}/quote`, { version: state.version, kind, instruction });
  const accepted = await post(client, `quotes/${quote.id}/accept`, { idempotencyKey: randomUUID() });
  await runFixtureOperation(accepted.operationId, { failAfterSlide: failure });
  return { state: await readPublication(client.viewer.id, state.id), operationId: accepted.operationId };
}

after(async () => { await (await getBoss()).stop({ graceful: true }); await pool.end(); });

test("quoted business facts, provenance and conversation remain immutable after profile edits", async () => {
  const owner = await createClient();
  const other = await createClient();
  await post(owner, "billing/simulate", { action: "activate" });
  await post(owner, "business", { name: "Quoted cafe", context: "We open at eight", website: "https://quoted.example.test" });
  const state = await createPublication(owner.viewer, { idea: "Our opening hours", platform: "instagram", slideCount: 1 });
  const quote = await quoteOperation(owner.viewer, state.id, "prepare", state.version);
  await post(owner, "business", { name: "Later profile", context: "A later unrelated edit", website: "https://later.example.test" });
  const accepted = await acceptQuote(owner.viewer, quote.id, randomUUID());
  const { snapshot, hash } = await loadAcceptedInput(owner.viewer.id, accepted.operationId);
  assert.equal(snapshot.business.name, "Quoted cafe");
  assert.equal(snapshot.business.context, "We open at eight");
  assert.equal(snapshot.business.website, "https://quoted.example.test");
  assert.equal(snapshot.business.provenance, "user_statement");
  assert.equal(snapshot.business.websiteFetched, false);
  assert.deepEqual(snapshot.publication.messages, state.messages);
  assert.equal(snapshot.publication.version, state.version);
  assert.match(hash, /^[a-f0-9]{64}$/);
  await assert.rejects(loadAcceptedInput(other.viewer.id, accepted.operationId), { code: "not_found" });
  await assert.rejects(pool.query("UPDATE quote SET input_snapshot='{}' WHERE id=$1", [quote.id]), /immutable/);
  await assert.rejects(pool.query("UPDATE operation SET input_state='{}' WHERE id=$1", [accepted.operationId]), /immutable/);
  await runFixtureOperation(accepted.operationId);
  assert.equal((await loadAcceptedInput(owner.viewer.id, accepted.operationId)).hash, hash);
});

test("authenticated fixture workflow preserves approvals, ownership, exact-once spend, revisions and exports", async () => {
  const owner = await createClient();
  const other = await createClient();
  await request(owner, "publications", { idea: "x".repeat(24_001), platform: "linkedin", slideCount: 1 }, 413);
  const input = { idea: "We are sharing our new workshop", platform: "linkedin", slideCount: 3 };
  await post(owner, "publications", input, 402);
  await request(owner, "account", undefined, 403, { host: "foreign.example:3130" });
  await request(owner, "billing/simulate", { action: "activate" }, 403, { origin: "https://foreign.example" });
  await post(owner, "billing/simulate", { action: "activate", tier: "starter", cadence: "annual" });
  await updateBrandRule(owner.viewer, { field: "audience", value: "Workshop customers", version: 0, commandKey: randomUUID() });
  await updateBrandRule(owner.viewer, { field: "palette", value: "indigo", version: 1, commandKey: randomUUID() });
  await post(owner, "business", { name: "A workshop", context: "A user-provided workshop idea", website: "https://example.test/never-fetched" });
  let state: PublicationView = await post(owner, "publications", input);
  const stale: QuoteView = await post(owner, `publications/${state.id}/quote`, { kind: "prepare", version: state.version });
  state = await post(owner, `publications/${state.id}/messages`, { text: "For people meeting us for the first time", version: state.version });
  await post(owner, `quotes/${stale.id}/accept`, { idempotencyKey: randomUUID() }, 409);
  assert.equal((await accountView(owner.viewer)).billing.weeklyRemaining, 100);

  const quote: QuoteView = await post(owner, `publications/${state.id}/quote`, { kind: "prepare", version: state.version });
  const key = randomUUID();
  const [first, duplicate] = await Promise.all([post(owner, `quotes/${quote.id}/accept`, { idempotencyKey: key }), post(owner, `quotes/${quote.id}/accept`, { idempotencyKey: key })]);
  assert.equal(first.operationId, duplicate.operationId);
  assert.equal((await accountView(owner.viewer)).billing.reserved, 3);
  await runFixtureOperation(first.operationId);
  state = await readPublication(owner.viewer.id, state.id);
  assert.equal(state.status, "content_approval");
  await post(owner, `publications/${state.id}/quote`, { kind: "cover", version: state.version }, 409);
  state = await post(owner, `publications/${state.id}/approve`, { stage: "content", version: state.version });
  state = (await runStage(owner, state, "cover")).state;
  assert.equal(state.status, "cover_approval");
  const savedCover = state.slides[0].assetId;
  await post(owner, `publications/${state.id}/quote`, { kind: "remaining", version: state.version }, 409);
  state = await post(owner, `publications/${state.id}/approve`, { stage: "cover", version: state.version });
  const completed = await runStage(owner, state, "remaining");
  state = completed.state;
  assert.equal(state.status, "ready");
  assert.equal(state.slides[0].assetId, savedCover);
  const original = structuredClone(state);
  const balance = (await accountView(owner.viewer)).billing.weeklyRemaining;
  await runFixtureOperation(completed.operationId);
  assert.equal((await accountView(owner.viewer)).billing.weeklyRemaining, balance);
  assert.equal((await readPublication(owner.viewer.id, state.id)).version, state.version);
  state = (await runStage(owner, state, "revise", "Change the color treatment on slide 2")).state;
  assert.equal(state.slides[0].assetId, original.slides[0].assetId);
  assert.equal(state.slides[2].assetId, original.slides[2].assetId);
  assert.notEqual(state.slides[1].assetId, original.slides[1].assetId);
  assert.equal((await accountView(owner.viewer)).billing.weeklyRemaining, 65);
  const zip = await request(owner, `publications/${state.id}/export?format=zip&version=${original.version}`);
  const files = unzipSync(new Uint8Array(await zip.arrayBuffer()));
  assert.deepEqual(Object.keys(files).sort(), ["caption.txt", "origin-notice.txt", "slide-1.png", "slide-2.png", "slide-3.png"]);
  const pdf = await request(owner, `publications/${state.id}/export?format=pdf`);
  assert.match(Buffer.from(await pdf.arrayBuffer()).subarray(0, 8).toString(), /^%PDF/);
  const png = await request(owner, `assets/${savedCover}`);
  assert.equal(Buffer.from(await png.arrayBuffer()).subarray(1, 4).toString(), "PNG");
  for (const path of [`publications/${state.id}`, `operations/${first.operationId}`, `assets/${savedCover}`, `publications/${state.id}/export?format=zip`]) await request(other, path, undefined, 404);
  await post(other, `quotes/${quote.id}/accept`, { idempotencyKey: randomUUID() }, 404);
  await post(other, `publications/${state.id}/approve`, { stage: "content", version: state.version }, 404);
  assert.equal((await accountView(owner.viewer)).billing.weeklyRemaining, 65);
});

test("parallel reservations cannot overspend and original reservations survive the weekly boundary", async () => {
  const client = await createClient();
  const now = new Date();
  await simulateBilling(client.viewer, "activate", "starter", "monthly", now);
  const a = await createPublication(client.viewer, { idea: "A", platform: "instagram", slideCount: 1 });
  const b = await createPublication(client.viewer, { idea: "B", platform: "instagram", slideCount: 1 });
  await pool.query("UPDATE credit_bucket SET remaining=3 WHERE owner_id=$1", [client.viewer.id]);
  const qa = await quoteOperation(client.viewer, a.id, "prepare", a.version);
  const qb = await quoteOperation(client.viewer, b.id, "prepare", b.version);
  const outcomes = await Promise.allSettled([acceptQuote(client.viewer, qa.id, randomUUID()), acceptQuote(client.viewer, qb.id, randomUUID())]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal((await accountView(client.viewer)).billing.reserved, 3);
  const nextWeek = new Date(now.getTime() + WEEK_MS + 1);
  assert.equal((await accountView(client.viewer, nextWeek)).billing.weeklyRemaining, 100);
  const accepted = outcomes.find((outcome) => outcome.status === "fulfilled") as PromiseFulfilledResult<{ operationId: string }>;
  await runFixtureOperation(accepted.value.operationId);
  const final = await accountView(client.viewer, nextWeek);
  assert.equal(final.billing.weeklyRemaining, 100);
  assert.equal(final.billing.reserved, 0);
});

test("paid access end disables weekly balance while packs remain usable and renewal keeps the anchor", async () => {
  const client = await createClient();
  const now = new Date();
  await simulateBilling(client.viewer, "activate", "starter", "annual", now);
  await simulateBilling(client.viewer, "topup", "starter", "monthly", now);
  const before = await accountView(client.viewer, now);
  await pool.query("UPDATE credit_account SET active_until=$2 WHERE owner_id=$1", [client.viewer.id, new Date(now.getTime() + 1000)]);
  const ended = await accountView(client.viewer, new Date(now.getTime() + 2000));
  assert.equal(ended.billing.weeklyRemaining, 0);
  assert.equal(ended.billing.packRemaining, 50);
  await assert.rejects(() => simulateBilling(client.viewer, "topup", "starter", "monthly", new Date(now.getTime() + 2000)), { code: "active_plan_required" });
  await pool.query("UPDATE credit_account SET active_until=$2 WHERE owner_id=$1", [client.viewer.id, new Date(Date.now() - 1000)]);
  const packPost = await createPublication(client.viewer, { idea: "A post funded by purchased credits", platform: "instagram", slideCount: 1 });
  await runStage(client, packPost, "prepare");
  assert.equal((await accountView(client.viewer)).billing.weeklyRemaining, 0);
  assert.equal((await accountView(client.viewer)).billing.packRemaining, 47);
  await pool.query("UPDATE credit_account SET active_until=$2 WHERE owner_id=$1", [client.viewer.id, new Date(now.getTime() + 30 * 86400000)]);
  const renewed = await accountView(client.viewer, now);
  assert.equal(renewed.billing.nextResetAt, before.billing.nextResetAt);
  assert.equal(renewed.billing.weeklyRemaining, 100);
  const upgraded = await simulateBilling(client.viewer, "upgrade", "studio", "annual", new Date(now.getTime() + WEEK_MS / 2));
  assert.equal(upgraded.billing.weeklyRemaining, 200);
  await assert.rejects(() => simulateBilling(client.viewer, "upgrade", "studio", "annual", now), { code: "upgrade_unavailable" });
});

test("fixture renewal is exact-once, preserves the weekly anchor, applies scheduled downgrade and can resume cancellation", async () => {
  const client = await createClient();
  const now = new Date("2026-06-10T12:00:00Z");
  let view = await simulateBilling(client.viewer, "activate", "studio", "monthly", now);
  const originalReset = view.billing.nextResetAt;
  view = await simulateBilling(client.viewer, "schedule_change", "starter", "annual", now);
  assert.deepEqual([view.billing.pendingTier, view.billing.pendingCadence], ["starter", "annual"]);
  view = await simulateBilling(client.viewer, "clear_change", "studio", "monthly", now);
  assert.deepEqual([view.billing.pendingTier, view.billing.pendingCadence], [null, null]);
  view = await simulateBilling(client.viewer, "schedule_change", "starter", "annual", now);
  view = await simulateBilling(client.viewer, "cancel", "studio", "monthly", now);
  await assert.rejects(() => simulateBilling(client.viewer, "renew", "studio", "monthly", now, "cancelled-event"), { code: "renewal_cancelled" });
  view = await simulateBilling(client.viewer, "resume", "studio", "monthly", now);
  assert.equal(view.billing.cancelAtPeriodEnd, false);
  const key = randomUUID();
  view = await simulateBilling(client.viewer, "renew", "studio", "monthly", now, key);
  const renewedUntil = view.billing.activeUntil;
  assert.deepEqual([view.billing.tier, view.billing.cadence, view.billing.pendingTier, view.billing.pendingCadence], ["starter", "annual", null, null]);
  assert.equal(view.billing.nextResetAt, originalReset);
  view = await simulateBilling(client.viewer, "renew", "studio", "monthly", now, key);
  assert.equal(view.billing.activeUntil, renewedUntil);
  await assert.rejects(pool.query("UPDATE simulated_billing_event SET event_key='changed' WHERE owner_id=$1", [client.viewer.id]), /append-only/);
});

test("a partial remaining-slide failure releases the entire stage and preserves the completed cover", async () => {
  const client = await createClient();
  await post(client, "billing/simulate", { action: "activate" });
  await updateBrandRule(client.viewer, { field: "audience", value: "Workshop customers", version: 0, commandKey: randomUUID() });
  await updateBrandRule(client.viewer, { field: "palette", value: "indigo", version: 1, commandKey: randomUUID() });
  let state: PublicationView = await post(client, "publications", { idea: "A fixture failure scenario", platform: "linkedin", slideCount: 3 });
  state = (await runStage(client, state, "prepare")).state;
  state = await post(client, `publications/${state.id}/approve`, { stage: "content", version: state.version });
  state = (await runStage(client, state, "cover")).state;
  state = await post(client, `publications/${state.id}/approve`, { stage: "cover", version: state.version });
  const originalCover = state.slides[0].assetId;
  state = (await runStage(client, state, "remaining", undefined, 1)).state;
  assert.equal(state.status, "failed");
  assert.equal(state.failedOperationKind, "remaining");
  assert.equal(state.slides[0].assetId, originalCover);
  assert.equal(state.slides[1].assetId, undefined);
  assert.equal((await accountView(client.viewer)).billing.weeklyRemaining, 89);
  assert.equal((await accountView(client.viewer)).billing.reserved, 0);
  const { rows: [reservation] } = await pool.query("SELECT count(*)::integer AS unsettled FROM credit_reservation r JOIN operation o ON o.id=r.operation_id WHERE o.owner_id=$1 AND NOT r.settled", [client.viewer.id]);
  assert.equal(reservation.unsettled, 0);
  await transaction(async (db) => { await lockWallet(db, client.viewer.id); });
});
