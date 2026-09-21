import { createHash, randomBytes, randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { z } from "zod";
import { transaction } from "./db";
import { requireCondition } from "./errors";

const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const emailSchema = z.email().max(254).transform(value => value.toLowerCase());
const passwordSchema = z.string().min(10).max(128);
const accessLock = 6381043;
export const BETA_STARTING_ALLOWANCE = 90;

function digest(token: string) { return createHash("sha256").update(token).digest("hex"); }

export function accessRateKey(kind: string, identity: string) { return `${kind}:${digest(identity.trim().toLowerCase()).slice(0, 32)}`; }

export function clientRateKey(kind: string, request: Request) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
  const direct = request.headers.get("x-real-ip")?.trim();
  const identity = forwarded || direct || "unknown-client";
  return accessRateKey(`${kind}-client`, identity.slice(0, 100));
}

export async function reservedInviteEmail(emailInput: string) {
  const email = emailSchema.parse(emailInput.trim());
  return transaction(async client => Boolean((await client.query("SELECT 1 FROM beta_access_token WHERE purpose='invite' AND email=$1 AND used_at IS NULL AND expires_at>now() LIMIT 1", [email])).rowCount));
}

export async function assertPublicSignupCapacity() {
  await transaction(async client => {
    const { rows: [counts] } = await client.query<{ total: number; recent: number }>('SELECT count(*)::integer AS total, count(*) FILTER (WHERE created_at>now()-interval \'24 hours\')::integer AS recent FROM "user"');
    requireCondition(counts.total < 500 && counts.recent < 50, "signup_paused", "New account creation is temporarily paused. Try again later.", 429);
  });
}

async function assertUsableToken(token: string, purpose: string, email?: string) {
  const usable = await transaction(async client => (await client.query("SELECT email FROM beta_access_token WHERE token_hash=$1 AND purpose=$2 AND used_at IS NULL AND expires_at>now()", [digest(token), purpose])).rows[0]);
  requireCondition(usable && (email === undefined || usable.email === email), "invalid_link", "This private link is invalid, expired or belongs to another email.", 400);
}

export async function enforceRateLimit(key: string, limit: number, now = Date.now()) {
  const window = Math.floor(now / 60_000);
  const count = await transaction(async client => {
    await client.query("DELETE FROM beta_rate_limit WHERE window_minute < $1", [window - 2]);
    const { rows: [row] } = await client.query<{ count: number }>("INSERT INTO beta_rate_limit(key,window_minute,count) VALUES($1,$2,1) ON CONFLICT(key,window_minute) DO UPDATE SET count=beta_rate_limit.count+1 RETURNING count", [key, window]);
    return row.count;
  });
  requireCondition(count <= limit, "rate_limited", "Please wait a minute before trying again.", 429);
}

export async function issueBetaLink(emailInput: string, purpose: "invite" | "recover") {
  const email = emailSchema.parse(emailInput.trim());
  const token = randomBytes(32).toString("base64url");
  await transaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [accessLock]);
    const { rows: [existing] } = await client.query('SELECT id FROM "user" WHERE lower(email)=$1', [email]);
    if (purpose === "invite") {
      requireCondition(!existing, "account_exists", "This account already exists.", 409);
      const { rows: [capacity] } = await client.query<{ count: number }>('SELECT count(DISTINCT email)::integer AS count FROM beta_access_token WHERE purpose=\'invite\' AND email<>$1', [email]);
      requireCondition(capacity.count < 3, "beta_full", "The private beta has reached its account limit.", 409);
    } else requireCondition(existing, "account_missing", "This account is not available.", 404);
    await client.query("UPDATE beta_access_token SET expires_at=now() WHERE email=$1 AND purpose=$2 AND used_at IS NULL", [email, purpose]);
    await client.query("INSERT INTO beta_access_token(token_hash,purpose,email,expires_at) VALUES($1,$2,$3,now()+$4::interval)", [digest(token), purpose, email, purpose === "invite" ? "24 hours" : "15 minutes"]);
  });
  return token;
}

export async function acceptBetaInvite(input: unknown) {
  const value = z.object({ token: tokenSchema, email: emailSchema, name: z.string().trim().min(1).max(100), password: passwordSchema, acceptedTerms: z.literal(true) }).strict().parse(input);
  await assertUsableToken(value.token, "invite", value.email);
  const password = await hashPassword(value.password);
  await transaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [accessLock]);
    const { rows: [invite] } = await client.query("SELECT email FROM beta_access_token WHERE token_hash=$1 AND purpose='invite' AND used_at IS NULL AND expires_at>now() FOR UPDATE", [digest(value.token)]);
    requireCondition(invite?.email === value.email, "invalid_invitation", "This invitation is invalid, expired or belongs to another email.", 400);
    await client.query("UPDATE beta_access_token SET used_at=now() WHERE token_hash=$1", [digest(value.token)]);
    const id = randomUUID();
    await client.query('INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$2,$3,false)', [id, value.name, value.email]);
    await client.query("INSERT INTO account(id,user_id,account_id,provider_id,password) VALUES($1,$2,$2,'credential',$3)", [randomUUID(), id, password]);
    await client.query("INSERT INTO credit_account(owner_id) VALUES($1)", [id]);
    const bucketId = randomUUID();
    await client.query("INSERT INTO credit_bucket(id,owner_id,kind,window_key,remaining) VALUES($1,$2,'pack','beta-initial',$3)", [bucketId, id, BETA_STARTING_ALLOWANCE]);
    await client.query("INSERT INTO credit_entry(id,owner_id,bucket_id,kind,amount,reference) VALUES($1,$2,$3,'grant',$4,'beta-initial')", [randomUUID(), id, bucketId, BETA_STARTING_ALLOWANCE]);
  });
}

export async function recoverBetaAccount(input: unknown) {
  const value = z.object({ token: tokenSchema, password: passwordSchema }).strict().parse(input);
  await assertUsableToken(value.token, "recover");
  const password = await hashPassword(value.password);
  await transaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [accessLock]);
    const { rows: [recovery] } = await client.query("SELECT email FROM beta_access_token WHERE token_hash=$1 AND purpose='recover' AND used_at IS NULL AND expires_at>now() FOR UPDATE", [digest(value.token)]);
    requireCondition(recovery, "invalid_recovery", "This recovery link is invalid or expired.", 400);
    const { rows: [user] } = await client.query('SELECT id FROM "user" WHERE lower(email)=$1 FOR UPDATE', [recovery.email]);
    requireCondition(user, "invalid_recovery", "This recovery link is invalid or expired.", 400);
    const updated = await client.query("UPDATE account SET password=$2,updated_at=now() WHERE user_id=$1 AND provider_id='credential'", [user.id, password]);
    requireCondition(updated.rowCount === 1, "invalid_recovery", "This account cannot be recovered with this link.", 400);
    await client.query("DELETE FROM session WHERE user_id=$1", [user.id]);
    await client.query("UPDATE beta_access_token SET used_at=now() WHERE token_hash=$1", [digest(value.token)]);
  });
}
