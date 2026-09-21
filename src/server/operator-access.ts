import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { z } from "zod";
import { transaction } from "./db";
import { requireCondition } from "./errors";

const email = z.string().trim().pipe(z.email().max(254)).transform((value) => value.toLowerCase());
const commandKey = z.string().min(8).max(100);

export async function createTestAccount(input: unknown) {
  const value = z.object({ email, name: z.string().trim().min(1).max(100), password: z.string().min(10).max(128), commandKey }).strict().parse(input);
  const password = await hashPassword(value.password);
  return transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [6381043]);
    const prior = (await client.query("SELECT owner_id,detail FROM operator_access_event WHERE command_key=$1 AND action='create'", [value.commandKey])).rows[0];
    if (prior) {
      requireCondition(prior.detail.email === value.email && prior.detail.name === value.name, "idempotency_conflict", "That command key belongs to different account details.", 409);
      return { ownerId: prior.owner_id as string, created: false as const };
    }
    requireCondition(!(await client.query('SELECT 1 FROM "user" WHERE lower(email)=$1', [value.email])).rowCount, "account_exists", "That account already exists.", 409);
    const ownerId = randomUUID();
    await client.query('INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$2,$3,false)', [ownerId, value.name, value.email]);
    await client.query("INSERT INTO account(id,user_id,account_id,provider_id,password) VALUES($1,$2,$2,'credential',$3)", [randomUUID(), ownerId, password]);
    await client.query("INSERT INTO credit_account(owner_id) VALUES($1)", [ownerId]);
    await client.query("INSERT INTO operator_access_event(id,command_key,owner_id,action,detail) VALUES($1,$2,$3,'create',$4)", [randomUUID(), value.commandKey, ownerId, JSON.stringify({ email: value.email, name: value.name })]);
    return { ownerId, created: true as const };
  });
}

export async function grantTestAllowance(input: unknown, now = new Date()) {
  const value = z.object({ email, tier: z.enum(["starter", "studio"]), commandKey }).strict().parse(input);
  return transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [6381043]);
    const prior = (await client.query("SELECT owner_id,detail FROM operator_access_event WHERE command_key=$1 AND action='grant'", [value.commandKey])).rows[0];
    if (prior) {
      requireCondition(prior.detail.email === value.email && prior.detail.tier === value.tier, "idempotency_conflict", "That command key belongs to a different allowance grant.", 409);
      return { ownerId: prior.owner_id as string, granted: false as const };
    }
    const owner = (await client.query('SELECT id FROM "user" WHERE lower(email)=$1 FOR UPDATE', [value.email])).rows[0];
    requireCondition(owner, "account_missing", "That account does not exist.", 404);
    const activeUntil = new Date(now);
    activeUntil.setUTCDate(activeUntil.getUTCDate() + 30);
    await client.query("INSERT INTO credit_account(owner_id,tier,cadence,anchor_at,active_until) VALUES($1,$2,'monthly',$3,$4) ON CONFLICT(owner_id) DO UPDATE SET tier=$2,cadence='monthly',anchor_at=$3,active_until=$4,cancel_at_period_end=false,pending_tier=NULL,pending_cadence=NULL", [owner.id, value.tier, now, activeUntil]);
    await client.query("INSERT INTO operator_access_event(id,command_key,owner_id,action,detail) VALUES($1,$2,$3,'grant',$4)", [randomUUID(), value.commandKey, owner.id, JSON.stringify({ email: value.email, tier: value.tier, activeUntil: activeUntil.toISOString() })]);
    return { ownerId: owner.id as string, granted: true as const };
  });
}

export async function revokeTestAllowance(input: unknown, now = new Date()) {
  const value = z.object({ email, commandKey }).strict().parse(input);
  return transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [6381043]);
    const prior = (await client.query("SELECT owner_id,detail FROM operator_access_event WHERE command_key=$1 AND action='revoke'", [value.commandKey])).rows[0];
    if (prior) {
      requireCondition(prior.detail.email === value.email, "idempotency_conflict", "That command key belongs to a different allowance revocation.", 409);
      return { ownerId: prior.owner_id as string, revoked: false as const };
    }
    const owner = (await client.query('SELECT id FROM "user" WHERE lower(email)=$1 FOR UPDATE', [value.email])).rows[0];
    requireCondition(owner, "account_missing", "That account does not exist.", 404);
    await client.query("UPDATE credit_account SET tier='none',active_until=$2,cancel_at_period_end=false,pending_tier=NULL,pending_cadence=NULL WHERE owner_id=$1", [owner.id, now]);
    await client.query("INSERT INTO operator_access_event(id,command_key,owner_id,action,detail) VALUES($1,$2,$3,'revoke',$4)", [randomUUID(), value.commandKey, owner.id, JSON.stringify({ email: value.email })]);
    return { ownerId: owner.id as string, revoked: true as const };
  });
}
