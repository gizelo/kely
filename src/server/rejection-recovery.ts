import type { PoolClient } from "pg";
import type { PublicationView } from "../shared/contracts";
import { BudgetStore } from "./budget/store";
import type { KnownRejectionBinding, KnownRejectionReview } from "./budget/known-rejection";
import { settleCredits } from "./credits";
import { transaction } from "./db";
import { requireCondition } from "./errors";
import { canonicalJson, inputHash, verifyPaidInput, type PaidInputSnapshot } from "./paid-input";
import { currentPreparation, preparationView } from "./preparation";
import { readPublication, writePublication } from "./publications";
import type { StoredOperation } from "./operations";

type RecoveryTarget = { ownerId: string; operationId: string; requestId: string };
type RecoveryOperation = StoredOperation & { quote_id: string; input_snapshot: PaidInputSnapshot; input_hash: string };
type Reservation = { bucket_id: string; amount: number; settled: boolean; owner_id: string };
type RecoveryPlan = {
  policy: "first-quota-rejection-v1"; ownerId: string; operationId: string; publicationId: string;
  publicationVersion: number; packageId: string; review: KnownRejectionReview;
  customerReleaseCredits: number; repliesRemaining: number; attemptsUsed: number; planHash: string;
};
type RecoveryMarker = { plan: RecoveryPlan; originalError: string | null; resultingVersion: number };
type Options = { applyPlan?: string; failBeforeCommit?: boolean };

function requireRecovery(condition: unknown): asserts condition {
  requireCondition(condition, "recovery_conflict", "This exact first quota rejection no longer matches the reviewed operation, package, reservation or publication. No automatic retry or reset is available.", 409);
}

async function ownedOperation(client: PoolClient, target: RecoveryTarget, lock = false) {
  const { rows: [operation] } = await client.query<RecoveryOperation>(`SELECT * FROM operation WHERE id=$1 AND owner_id=$2${lock ? " FOR UPDATE" : ""}`, [target.operationId, target.ownerId]);
  requireRecovery(operation);
  return operation;
}

export async function recoverFirstQuotaRejection(target: RecoveryTarget, budget: BudgetStore, options: Options = {}) {
  requireRecovery(/^[a-zA-Z0-9_-]{1,160}$/u.test(target.ownerId) && /^[a-f0-9-]{36}$/u.test(target.operationId) && /^req_[a-zA-Z0-9_-]{1,240}$/u.test(target.requestId));
  requireRecovery(!options.applyPlan || /^[a-f0-9]{64}$/u.test(options.applyPlan));
  requireRecovery(!options.failBeforeCommit || budget.location.purpose === "fake");
  return transaction(async (client) => {
    const first = await ownedOperation(client, target);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [target.operationId]);
    const wallet = await client.query("SELECT owner_id FROM credit_account WHERE owner_id=$1 FOR UPDATE", [target.ownerId]);
    requireRecovery(wallet.rowCount === 1);
    const state = await readPublication(target.ownerId, first.publication_id, client, true);
    const preparation = await currentPreparation(target.ownerId, first.publication_id, client, true);
    const operation = await ownedOperation(client, target, true);
    const snapshot = verifyPaidInput(operation.input_snapshot, operation.input_hash);
    requireRecovery(operation.kind === "prepare" && operation.model === "gpt-5.6-luna" && operation.scope === null && operation.package_id && operation.publication_id === state.id);
    requireRecovery(operation.origin === (budget.location.purpose === "fake" ? "ai_preview" : "openai"));
    requireRecovery(snapshot.ownerId === target.ownerId && snapshot.quoteId === operation.quote_id && snapshot.publication.id === state.id && snapshot.kind === "prepare" && snapshot.generation?.origin === operation.origin && snapshot.generation.model === operation.model);
    const binding: KnownRejectionBinding = { key: `kely:${operation.id}:text`, ownerId: target.ownerId, operationId: operation.id, acceptedHash: operation.input_hash, requestId: target.requestId };
    const review = budget.previewKnownRejection(binding);
    const { rows: [saved] } = await client.query<{ owner_id: string; publication_id: string; review_id: string; plan_hash: string; marker: RecoveryMarker }>("SELECT * FROM operation_recovery WHERE operation_id=$1", [operation.id]);
    if (saved) {
      requireRecovery(budget.inspect().attempts.find((attempt) => attempt.key === binding.key)?.status === "rejected");
      requireRecovery(saved.owner_id === target.ownerId && saved.publication_id === state.id && saved.review_id === review.reviewId && canonicalJson(saved.marker.plan.review) === canonicalJson(review) && saved.plan_hash === saved.marker.plan.planHash && operation.status === "failed");
      requireRecovery(!options.applyPlan || options.applyPlan === saved.plan_hash);
      requireRecovery(state.version === saved.marker.resultingVersion && !state.pendingOperation && preparation?.id === saved.marker.plan.packageId && preparation.attempts_used === 1 && preparation.replies_used === 0 && !preparation.activated && !preparation.closed && !preparation.paused);
      return { status: "already_applied" as const, plan: saved.marker.plan };
    }
    requireRecovery(operation.status === "uncertain" && state.status === "failed" && state.failureCode === "attempt_uncertain" && state.failedOperationKind === "prepare" && !state.pendingOperation && !state.outlineApproved && state.version === snapshot.publication.version + 2);
    requireRecovery(preparation && preparation.id === operation.package_id && preparation.origin === operation.origin && preparation.model === operation.model && !preparation.activated && !preparation.closed && preparation.paused && preparation.replies_used === 0 && preparation.attempts_used === 1);
    const operations = await client.query("SELECT id FROM operation WHERE owner_id=$1 AND publication_id=$2", [target.ownerId, state.id]);
    requireRecovery(operations.rowCount === 1 && operations.rows[0].id === operation.id);
    const { rows: reservations } = await client.query<Reservation>("SELECT r.bucket_id,r.amount,r.settled,b.owner_id FROM credit_reservation r JOIN credit_bucket b ON b.id=r.bucket_id WHERE r.operation_id=$1 ORDER BY r.bucket_id FOR UPDATE OF r,b", [operation.id]);
    requireRecovery(reservations.length > 0 && reservations.every((row) => row.owner_id === target.ownerId && !row.settled && Number.isSafeInteger(row.amount) && row.amount > 0) && reservations.reduce((sum, row) => sum + row.amount, 0) === 3);
    const quote = await client.query("SELECT credits,accepted_operation_id FROM quote WHERE id=$1 AND owner_id=$2", [operation.quote_id, target.ownerId]);
    requireRecovery(quote.rows[0]?.credits === 3 && quote.rows[0].accepted_operation_id === operation.id);
    const planBody = { policy: "first-quota-rejection-v1" as const, ownerId: target.ownerId, operationId: operation.id, publicationId: state.id, publicationVersion: state.version, packageId: preparation.id, review, customerReleaseCredits: 3, repliesRemaining: 3, attemptsUsed: 1 };
    const packageState = { id: preparation.id, ownerId: preparation.owner_id, publicationId: preparation.publication_id, origin: preparation.origin, model: preparation.model, activated: preparation.activated, closed: preparation.closed, paused: preparation.paused, repliesUsed: preparation.replies_used, attemptsUsed: preparation.attempts_used };
    const plan: RecoveryPlan = { ...planBody, planHash: inputHash({ plan: planBody, state, packageState, reservations, originalError: operation.error }) };
    if (!options.applyPlan) return { status: "ready_for_review" as const, plan };
    requireRecovery(options.applyPlan === plan.planHash);
    // External evidence commits first; a later SQL rollback leaves the publication blocked until this exact recovery resumes.
    budget.reviewKnownRejection(binding, review.reviewId);
    const result: PublicationView = structuredClone(state);
    result.failureCode = "provider_quota_rejection_reviewed";
    result.failure = "The provider rejected this request because API credits were exhausted. The coordinator reviewed that rejection. Your 3 customer credits were released; all 3 preparation replies remain in this same package. The original attempt and its full maximum exposure stay recorded, not confirmed as a charge. Review a fresh preparation quote to use the one remaining retry; nothing was queued automatically.";
    const updated = await client.query("UPDATE preparation_package SET paused=false WHERE id=$1 RETURNING *", [preparation.id]);
    result.preparation = preparationView(updated.rows[0]);
    await settleCredits(client, target.ownerId, operation.id, false);
    await client.query("UPDATE operation SET status='failed',error=$2,updated_at=now() WHERE id=$1", [operation.id, result.failure]);
    await writePublication(client, result, "Quota rejection reviewed; customer credits released, provider exposure retained", result.cost);
    const marker: RecoveryMarker = { plan, originalError: operation.error, resultingVersion: result.version };
    await client.query("INSERT INTO operation_recovery(operation_id,owner_id,publication_id,review_id,plan_hash,marker) VALUES($1,$2,$3,$4,$5,$6)", [operation.id, target.ownerId, state.id, review.reviewId, plan.planHash, JSON.stringify(marker)]);
    if (options.failBeforeCommit) throw new Error("Injected recovery PostgreSQL rollback");
    return { status: "applied" as const, plan };
  });
}
