import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { verifyPassword } from "better-auth/crypto";
import { accountView } from "../../src/server/credits";
import { pool } from "../../src/server/db";
import { createTestAccount, grantTestAllowance, revokeTestAllowance } from "../../src/server/operator-access";
import { joinWaitlist } from "../../src/server/waitlist";
import { POST as waitlistPost } from "../../src/app/api/waitlist/route";

assert.match(process.env.KELY_DATABASE_URL ?? "", /\/kely_fixture_test$/);
after(() => pool.end());

test("waitlist normalizes email and duplicate submissions remain one successful entry", async () => {
  const marker = randomUUID();
  const email = `${marker}@example.test`;
  assert.deepEqual(await joinWaitlist({ email: `  ${email.toUpperCase()}  `, consent: true, source: "landing" }), { joined: true });
  assert.deepEqual(await joinWaitlist({ email, consent: true, source: "landing" }), { joined: true });
  const { rows } = await pool.query("SELECT email,source,consent_at FROM waitlist_entry WHERE email=$1", [email]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "landing");
  assert.ok(rows[0].consent_at instanceof Date);
  await assert.rejects(joinWaitlist({ email: `${marker}-invalid@example.test`, consent: false, source: "landing" }));
});

test("waitlist route limits one client even when every submitted email is unique", async () => {
  const marker = randomUUID();
  for (let index = 0; index < 11; index++) {
    const response = await waitlistPost(new Request("http://localhost:3130/api/waitlist", {
      method: "POST",
      headers: { host: "localhost:3130", origin: "http://localhost:3130", "content-type": "application/json", "x-forwarded-for": marker },
      body: JSON.stringify({ email: `${marker}-${index}@example.test`, consent: true, source: "landing" }),
    }));
    assert.equal(response.status, index < 10 ? 200 : 429);
  }
});

test("operator account creation and allowance grant/revoke are idempotent", async () => {
  const marker = randomUUID();
  const email = `${marker}@example.test`;
  const password = "test-password-not-logged";
  const created = await createTestAccount({ email, name: "Kely Tester", password, commandKey: `create-${marker}` });
  assert.equal(created.created, true);
  assert.deepEqual(await createTestAccount({ email, name: "Kely Tester", password, commandKey: `create-${marker}` }), { ownerId: created.ownerId, created: false });
  const credential = (await pool.query("SELECT password FROM account WHERE user_id=$1", [created.ownerId])).rows[0];
  assert.equal(await verifyPassword({ hash: credential.password, password }), true);
  const grant = await grantTestAllowance({ email, tier: "starter", commandKey: `grant-${marker}` }, new Date("2026-09-21T12:00:00Z"));
  assert.equal(grant.granted, true);
  assert.equal((await accountView({ id: created.ownerId, name: "Kely Tester", email }, new Date("2026-09-21T12:00:00Z"))).billing.weeklyRemaining, 100);
  assert.equal((await grantTestAllowance({ email, tier: "starter", commandKey: `grant-${marker}` })).granted, false);
  assert.equal((await revokeTestAllowance({ email, commandKey: `revoke-${marker}` })).revoked, true);
  assert.equal((await accountView({ id: created.ownerId, name: "Kely Tester", email }, new Date("2026-09-21T12:01:00Z"))).billing.weeklyRemaining, 0);
  assert.equal((await revokeTestAllowance({ email, commandKey: `revoke-${marker}` })).revoked, false);
});
