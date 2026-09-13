import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { AccountView, Cadence, Tier } from "../shared/contracts";
import { transaction } from "./db";
import { requireCondition } from "./errors";
import { generationMode } from "./config";

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const WEEKLY_ALLOWANCE = { none: 0, starter: 100, studio: 300 };
export type Viewer = { id: string; name: string; email: string };
type Wallet = { owner_id: string; tier: Tier; cadence: Cadence; anchor_at: Date | null; active_until: Date | null; cancel_at_period_end: boolean; pending_tier: Exclude<Tier, "none"> | null; pending_cadence: Cadence | null };
type Bucket = { id: string; kind: "weekly" | "pack"; remaining: number; reserved: number; expires_at: Date | null };

export function billingPeriodEnd(start: Date, cadence: Cadence) {
  const end = new Date(start);
  end.setUTCDate(1);
  if (cadence === "annual") end.setUTCFullYear(end.getUTCFullYear() + 1);
  else end.setUTCMonth(end.getUTCMonth() + 1);
  const lastDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
  end.setUTCDate(Math.min(start.getUTCDate(), lastDay));
  return end;
}

export function weeklyWindow(anchor: Date, now: Date) {
  const index = Math.max(0, Math.floor((now.getTime() - anchor.getTime()) / WEEK_MS));
  return { key: `${anchor.toISOString()}/${index}`, expiresAt: new Date(anchor.getTime() + (index + 1) * WEEK_MS) };
}

export function active(wallet: Pick<Wallet, "active_until">, now: Date) {
  return wallet.active_until !== null && wallet.active_until.getTime() > now.getTime();
}

export async function lockWallet(client: PoolClient, ownerId: string, now = new Date()): Promise<Wallet> {
  await client.query("INSERT INTO credit_account(owner_id) VALUES($1) ON CONFLICT DO NOTHING", [ownerId]);
  const { rows: [wallet] } = await client.query<Wallet>("SELECT * FROM credit_account WHERE owner_id=$1 FOR UPDATE", [ownerId]);
  if (active(wallet, now) && wallet.anchor_at) {
    const window = weeklyWindow(wallet.anchor_at, now);
    const id = randomUUID();
    const amount = WEEKLY_ALLOWANCE[wallet.tier];
    const inserted = await client.query("INSERT INTO credit_bucket(id,owner_id,kind,window_key,remaining,expires_at) VALUES($1,$2,'weekly',$3,$4,$5) ON CONFLICT(owner_id,window_key) DO NOTHING RETURNING id", [id, ownerId, window.key, amount, window.expiresAt]);
    if (inserted.rowCount) await entry(client, ownerId, id, "grant", amount, `weekly:${window.key}`);
  }
  return wallet;
}

async function entry(client: PoolClient, ownerId: string, bucketId: string, kind: string, amount: number, reference: string) {
  await client.query("INSERT INTO credit_entry(id,owner_id,bucket_id,kind,amount,reference) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(owner_id,reference) DO NOTHING", [randomUUID(), ownerId, bucketId, kind, amount, reference]);
}

async function availableBuckets(client: PoolClient, wallet: Wallet, now: Date): Promise<Bucket[]> {
  const { rows } = await client.query<Bucket>("SELECT * FROM credit_bucket WHERE owner_id=$1 AND (kind='pack' OR ($2 AND expires_at>$3)) ORDER BY CASE WHEN kind='weekly' THEN 0 ELSE 1 END,created_at FOR UPDATE", [wallet.owner_id, active(wallet, now), now]);
  return rows;
}

export async function requireEntitlement(client: PoolClient, wallet: Wallet, now = new Date()) {
  const buckets = await availableBuckets(client, wallet, now);
  requireCondition(active(wallet, now) || buckets.some((bucket) => bucket.kind === "pack" && bucket.remaining > 0), "entitlement_required", "Activate a fixture plan or use remaining purchased credits before preparing a personal post.", 402);
}

export async function reserveCredits(client: PoolClient, wallet: Wallet, operationId: string, amount: number, now = new Date()) {
  const buckets = await availableBuckets(client, wallet, now);
  requireCondition(buckets.reduce((sum, bucket) => sum + bucket.remaining, 0) >= amount, "insufficient_credits", "There are not enough credits for this action. Upgrade your fixture plan or add a one-off pack.", 402);
  let remaining = amount;
  for (const bucket of buckets) {
    const taken = Math.min(remaining, bucket.remaining);
    if (!taken) continue;
    await client.query("UPDATE credit_bucket SET remaining=remaining-$2,reserved=reserved+$2 WHERE id=$1", [bucket.id, taken]);
    await client.query("INSERT INTO credit_reservation(operation_id,bucket_id,amount) VALUES($1,$2,$3)", [operationId, bucket.id, taken]);
    await entry(client, wallet.owner_id, bucket.id, "reserve", -taken, `reserve:${operationId}:${bucket.id}`);
    remaining -= taken;
    if (!remaining) break;
  }
}

export async function settleCredits(client: PoolClient, ownerId: string, operationId: string, capture: boolean) {
  const { rows } = await client.query<{ bucket_id: string; amount: number }>("SELECT bucket_id,amount FROM credit_reservation WHERE operation_id=$1 AND NOT settled FOR UPDATE", [operationId]);
  for (const row of rows) {
    await client.query("UPDATE credit_bucket SET reserved=reserved-$2,remaining=remaining+$3 WHERE id=$1", [row.bucket_id, row.amount, capture ? 0 : row.amount]);
    await client.query("UPDATE credit_reservation SET settled=true WHERE operation_id=$1 AND bucket_id=$2", [operationId, row.bucket_id]);
    await entry(client, ownerId, row.bucket_id, capture ? "capture" : "release", capture ? 0 : row.amount, `settle:${operationId}:${row.bucket_id}`);
  }
}

export async function accountView(viewer: Viewer, now = new Date()): Promise<AccountView> {
  return transaction(async (client) => {
    const wallet = await lockWallet(client, viewer.id, now);
    const buckets = await availableBuckets(client, wallet, now);
    const { rows: [business] } = await client.query("SELECT id,name,context,website FROM business WHERE owner_id=$1", [viewer.id]);
    const { rows: [reserved] } = await client.query("SELECT coalesce(sum(reserved),0)::integer AS total FROM credit_bucket WHERE owner_id=$1", [viewer.id]);
    return {
      fixture: true, generationMode: generationMode(), user: viewer, business: business ?? null,
      billing: {
        tier: active(wallet, now) ? wallet.tier : "none", cadence: wallet.cadence,
        weeklyRemaining: buckets.filter((bucket) => bucket.kind === "weekly").reduce((sum, bucket) => sum + bucket.remaining, 0),
        packRemaining: buckets.filter((bucket) => bucket.kind === "pack").reduce((sum, bucket) => sum + bucket.remaining, 0),
        reserved: reserved.total,
        nextResetAt: wallet.anchor_at && active(wallet, now) ? weeklyWindow(wallet.anchor_at, now).expiresAt.toISOString() : null,
        activeUntil: wallet.active_until?.toISOString() ?? null,
        cancelAtPeriodEnd: wallet.cancel_at_period_end,
        pendingTier: wallet.pending_tier,
        pendingCadence: wallet.pending_cadence,
      },
    };
  });
}

export async function simulateBilling(viewer: Viewer, action: "activate" | "upgrade" | "topup" | "cancel" | "resume" | "schedule_change" | "clear_change" | "renew", tier: Exclude<Tier, "none"> = "starter", cadence: Cadence = "monthly", now = new Date(), eventKey?: string) {
  await transaction(async (client) => {
    const wallet = await lockWallet(client, viewer.id, now);
    if (action === "activate") {
      requireCondition(!active(wallet, now), "already_active", "The fixture plan is already active. Use upgrade instead.", 409);
      const end = billingPeriodEnd(now, cadence);
      await client.query("UPDATE credit_account SET tier=$2,cadence=$3,anchor_at=$4,active_until=$5,cancel_at_period_end=false,pending_tier=NULL,pending_cadence=NULL WHERE owner_id=$1", [viewer.id, tier, cadence, now, end]);
    } else if (action === "cancel") {
      requireCondition(active(wallet, now), "inactive", "There is no active fixture plan to cancel.", 409);
      await client.query("UPDATE credit_account SET cancel_at_period_end=true WHERE owner_id=$1", [viewer.id]);
    } else if (action === "resume") {
      requireCondition(active(wallet, now) && wallet.cancel_at_period_end, "resume_unavailable", "This fixture renewal is not cancelled.", 409);
      await client.query("UPDATE credit_account SET cancel_at_period_end=false WHERE owner_id=$1", [viewer.id]);
    } else if (action === "schedule_change") {
      requireCondition(active(wallet, now), "inactive", "An active fixture plan is required to schedule the next renewal.", 409);
      requireCondition(!(wallet.tier === "starter" && tier === "studio"), "upgrade_required", "Use the immediate Studio upgrade instead.", 409);
      requireCondition(wallet.tier !== tier || wallet.cadence !== cadence, "change_unavailable", "Choose a different tier or billing cadence for the next renewal.", 409);
      await client.query("UPDATE credit_account SET pending_tier=$2,pending_cadence=$3 WHERE owner_id=$1", [viewer.id, tier, cadence]);
    } else if (action === "clear_change") {
      requireCondition(active(wallet, now) && (wallet.pending_tier || wallet.pending_cadence), "change_unavailable", "There is no scheduled fixture-plan change to remove.", 409);
      await client.query("UPDATE credit_account SET pending_tier=NULL,pending_cadence=NULL WHERE owner_id=$1", [viewer.id]);
    } else if (action === "renew") {
      requireCondition(typeof eventKey === "string" && eventKey.length >= 8 && eventKey.length <= 100, "event_key_required", "A unique simulated renewal event is required.", 400);
      const inserted = await client.query("INSERT INTO simulated_billing_event(id,owner_id,event_key,action) VALUES($1,$2,$3,'renew') ON CONFLICT(owner_id,event_key) DO NOTHING RETURNING id", [randomUUID(), viewer.id, eventKey]);
      if (!inserted.rowCount) return;
      requireCondition(!wallet.cancel_at_period_end, "renewal_cancelled", "Resume renewal before simulating a confirmed payment.", 409);
      const nextTier = wallet.pending_tier ?? (wallet.tier === "none" ? tier : wallet.tier);
      const nextCadence = wallet.pending_cadence ?? wallet.cadence;
      const periodStart = wallet.active_until && wallet.active_until > now ? wallet.active_until : now;
      await client.query("UPDATE credit_account SET tier=$2,cadence=$3,anchor_at=coalesce(anchor_at,$4),active_until=$5,cancel_at_period_end=false,pending_tier=NULL,pending_cadence=NULL WHERE owner_id=$1", [viewer.id, nextTier, nextCadence, now, billingPeriodEnd(periodStart, nextCadence)]);
    } else if (action === "topup") {
      requireCondition(active(wallet, now), "active_plan_required", "A new credit pack requires an active plan. Existing packs remain yours after cancellation.", 402);
      const id = randomUUID();
      await client.query("INSERT INTO credit_bucket(id,owner_id,kind,window_key,remaining) VALUES($1,$2,'pack',$3,50)", [id, viewer.id, `pack:${id}`]);
      await entry(client, viewer.id, id, "grant", 50, `pack:${id}`);
    } else {
      requireCondition(active(wallet, now) && wallet.tier === "starter" && wallet.anchor_at, "upgrade_unavailable", "Only an active Starter fixture plan can upgrade to Studio.", 409);
      const window = weeklyWindow(wallet.anchor_at, now);
      const paidRemainder = Math.min(window.expiresAt.getTime(), wallet.active_until!.getTime()) - now.getTime();
      const delta = Math.floor((WEEKLY_ALLOWANCE.studio - WEEKLY_ALLOWANCE.starter) * Math.max(0, paidRemainder) / WEEK_MS);
      const { rows: [bucket] } = await client.query("UPDATE credit_bucket SET remaining=remaining+$3 WHERE owner_id=$1 AND window_key=$2 RETURNING id", [viewer.id, window.key, delta]);
      if (bucket && delta) await entry(client, viewer.id, bucket.id, "upgrade", delta, `upgrade:${window.key}`);
      await client.query("UPDATE credit_account SET tier='studio' WHERE owner_id=$1", [viewer.id]);
    }
  });
  return accountView(viewer, now);
}

export async function saveBusiness(viewer: Viewer, data: { name: string; context: string; website: string }) {
  return transaction(async (client) => {
    const wallet = await lockWallet(client, viewer.id);
    await requireEntitlement(client, wallet);
    const { rows: [business] } = await client.query("INSERT INTO business(id,owner_id,name,context,website) VALUES($1,$2,$3,$4,$5) ON CONFLICT(owner_id) DO UPDATE SET name=excluded.name,context=excluded.context,website=excluded.website RETURNING id,name,context,website", [randomUUID(), viewer.id, data.name, data.context, data.website]);
    return business;
  });
}
