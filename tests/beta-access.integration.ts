import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { test, after } from "node:test";
import { verifyPassword } from "better-auth/crypto";
import { acceptBetaInvite, issueBetaLink, recoverBetaAccount, enforceRateLimit, reservedInviteEmail } from "../src/server/beta-access";
import { pool } from "../src/server/db";

assert.match(process.env.KELY_DATABASE_URL ?? "", /\/kely_beta_test$/);
after(() => pool.end());

test("private invites bind email, expire, settle once and enforce three places; recovery revokes sessions", async () => {
  const email = "founder@fixture.example.test";
  const password = "test-only-password-123";
  const token = await issueBetaLink(email, "invite");
  assert.equal(await reservedInviteEmail(email), true);
  await assert.rejects(acceptBetaInvite({ token, email: "other@fixture.example.test", name: "Test", password, acceptedTerms: true }));
  await acceptBetaInvite({ token, email, name: "Test", password, acceptedTerms: true });
  assert.equal(await reservedInviteEmail(email), false);
  await assert.rejects(acceptBetaInvite({ token, email, name: "Test", password, acceptedTerms: true }));
  const { rows: [user] } = await pool.query('SELECT id FROM "user" WHERE email=$1', [email]);
  const { rows: [allowance] } = await pool.query("SELECT sum(remaining)::integer AS total FROM credit_bucket WHERE owner_id=$1", [user.id]);
  assert.equal(allowance.total, 90);
  await pool.query("INSERT INTO session(id,user_id,token,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')", [randomUUID(), user.id, randomUUID()]);
  const recovery = await issueBetaLink(email, "recover");
  const replacement = "test-only-replacement-123";
  await recoverBetaAccount({ token: recovery, password: replacement });
  await assert.rejects(recoverBetaAccount({ token: recovery, password }));
  const { rows: [credential] } = await pool.query("SELECT password FROM account WHERE user_id=$1", [user.id]);
  assert.equal(await verifyPassword({ hash: credential.password, password: replacement }), true);
  assert.equal((await pool.query("SELECT 1 FROM session WHERE user_id=$1", [user.id])).rowCount, 0);
  const expired = await issueBetaLink("second@fixture.example.test", "invite");
  await pool.query("UPDATE beta_access_token SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [createHash("sha256").update(expired).digest("hex")]);
  await assert.rejects(acceptBetaInvite({ token: expired, email: "second@fixture.example.test", name: "Test", password, acceptedTerms: true }));
  await issueBetaLink("second@fixture.example.test", "invite");
  const attempts = await Promise.allSettled([issueBetaLink("third@fixture.example.test", "invite"), issueBetaLink("fourth@fixture.example.test", "invite")]);
  assert.equal(attempts.filter(attempt => attempt.status === "fulfilled").length, 1);
});

test("rate limit rejects excess attempts until a new minute", async () => {
  await enforceRateLimit("test-window", 1, 60000);
  await assert.rejects(enforceRateLimit("test-window", 1, 60001));
  await enforceRateLimit("test-window", 1, 120000);
});
