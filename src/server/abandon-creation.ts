import type { PoolClient } from "pg";
import type { PublicationView } from "../shared/contracts";
import { BudgetStore } from "./budget/store";
import type { AbandonmentBinding, AbandonmentReview } from "./budget/undeliverable";
import { settleCredits } from "./credits";
import { verifyCreationInput, type CreationInput } from "./creation-input";
import { transaction } from "./db";
import { requireCondition } from "./errors";
import { canonicalJson, inputHash } from "./paid-input";
import { writePublication } from "./publications";
import type { StoredOperation } from "./operations";

type Target = { ownerId: string; operationId: string; requestId: string };
type Operation = StoredOperation & { quote_id: string; input_snapshot: CreationInput; input_hash: string };
type Plan = { policy: "received-lost-image-abandonment-v1" | "unsupported-image-model-abandonment-v1"; ownerId: string; operationId: string; publicationId: string; publicationVersion: number; customerReleaseCredits: number; review: AbandonmentReview; planHash: string };
type Marker = { plan: Plan; originalError: string | null; resultingVersion: number; resultingStateHash: string };
type Options = { applyPlan?: string; failBeforeCommit?: boolean };

function requireClosure(condition: unknown): asserts condition {
  requireCondition(condition, "abandonment_conflict", "The exact lost-image order, evidence, reservation or saved version changed. Nothing can be retried or reset by this command.", 409);
}

async function ownedOperation(client: PoolClient, target: Target, lock = false) {
  const row = (await client.query<Operation>(`SELECT * FROM operation WHERE id=$1 AND owner_id=$2${lock ? " FOR UPDATE" : ""}`, [target.operationId, target.ownerId])).rows[0];
  requireClosure(row);
  return row;
}

export async function abandonLostImageCreation(target: Target, budget: BudgetStore, options: Options = {}) {
  requireClosure(/^[a-zA-Z0-9_-]{1,160}$/u.test(target.ownerId) && /^[a-f0-9-]{36}$/u.test(target.operationId) && /^req_[a-zA-Z0-9_-]{1,240}$/u.test(target.requestId));
  requireClosure(!options.applyPlan || /^[a-f0-9]{64}$/u.test(options.applyPlan));
  requireClosure(!options.failBeforeCommit || budget.location.purpose === "fake");
  return transaction(async (client) => {
    const first = await ownedOperation(client, target);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [target.operationId]);
    requireClosure((await client.query("SELECT owner_id FROM credit_account WHERE owner_id=$1 FOR UPDATE", [target.ownerId])).rowCount === 1);
    const state = (await client.query<{ state: PublicationView }>("SELECT state FROM publication WHERE id=$1 AND owner_id=$2 FOR UPDATE", [first.publication_id, target.ownerId])).rows[0]?.state;
    requireClosure(state);
    const operation = await ownedOperation(client, target, true);
    const snapshot = verifyCreationInput(operation.input_snapshot, operation.input_hash);
    const run = (await client.query("SELECT * FROM creation_run WHERE operation_id=$1 AND owner_id=$2 AND publication_id=$3 FOR UPDATE", [operation.id, target.ownerId, state.id])).rows[0];
    requireClosure(run && operation.kind === "create" && operation.model === "gpt-5.6-luna" && !snapshot.revision && snapshot.credits === 30);
    requireClosure(snapshot.ownerId === target.ownerId && snapshot.quoteId === operation.quote_id && snapshot.publication.id === state.id && operation.publication_id === state.id);
    requireClosure(operation.origin === (budget.location.purpose === "fake" ? "ai_preview" : "openai") && snapshot.origin === operation.origin);
    const steps = (await client.query("SELECT * FROM creation_step WHERE operation_id=$1 ORDER BY step_key", [operation.id])).rows;
    const artwork = steps.find((step) => step.step_key === "artwork:0");
    requireClosure(artwork && artwork.output === null && artwork.input.acceptedHash === operation.input_hash && inputHash(artwork.input) === artwork.input_hash);
    requireClosure(steps.every((step) => inputHash(step.input) === step.input_hash && (step === artwork || step.output !== null)));
    const binding: AbandonmentBinding = { key: `kely:${operation.id}:artwork:0`, ownerId: target.ownerId, operationId: operation.id, acceptedHash: operation.input_hash, stepHash: artwork.input_hash, requestId: target.requestId };
    const review = budget.previewAbandonment(binding);
    const policy = review.classification === "unsupported_image_model_400" ? "unsupported-image-model-abandonment-v1" as const : "received-lost-image-abandonment-v1" as const;
    const attempts = budget.inspect().attempts.filter((attempt) => attempt.operationId === operation.id);
    const attempt = attempts.find((item) => item.key === binding.key);
    requireClosure(attempt && canonicalJson(attempt.request) === canonicalJson(artwork.input.request) && canonicalJson(attempt.snapshot.input) === canonicalJson(artwork.input.snapshot));
    requireClosure(attempts.every((item) => item.ownerId === target.ownerId && (item === attempt || item.status === "settled")));
    requireClosure(!(await client.query("SELECT id FROM operation WHERE owner_id=$1 AND publication_id=$2 AND id<>$3", [target.ownerId, state.id, operation.id])).rowCount);
    const saved = (await client.query<{ owner_id: string; publication_id: string; review_id: string; plan_hash: string; marker: Marker }>("SELECT * FROM operation_recovery WHERE operation_id=$1", [operation.id])).rows[0];
    const reservations = (await client.query<{ bucket_id: string; amount: number; settled: boolean; owner_id: string }>("SELECT r.bucket_id,r.amount,r.settled,b.owner_id FROM credit_reservation r JOIN credit_bucket b ON b.id=r.bucket_id WHERE r.operation_id=$1 ORDER BY r.bucket_id FOR UPDATE OF r,b", [operation.id])).rows;
    requireClosure(reservations.length && reservations.every((row) => row.owner_id === target.ownerId && Number.isSafeInteger(row.amount) && row.amount > 0) && reservations.reduce((sum, row) => sum + row.amount, 0) === 30);
    const quote = (await client.query("SELECT credits,accepted_operation_id,input_hash FROM quote WHERE id=$1 AND owner_id=$2", [operation.quote_id, target.ownerId])).rows[0];
    requireClosure(quote?.credits === 30 && quote.accepted_operation_id === operation.id && quote.input_hash === operation.input_hash);
    if (saved) {
      requireClosure(saved.marker.plan.policy === policy && saved.owner_id === target.ownerId && saved.publication_id === state.id && saved.review_id === review.reviewId && saved.plan_hash === saved.marker.plan.planHash && canonicalJson(saved.marker.plan.review) === canonicalJson(review));
      requireClosure(!options.applyPlan || options.applyPlan === saved.plan_hash);
      requireClosure(attempt.status === "abandoned" && operation.status === "failed" && state.version === saved.marker.resultingVersion && inputHash(state) === saved.marker.resultingStateHash && state.creation?.status === "failed" && state.failureCode === "abandoned_undeliverable" && !state.pendingOperation && reservations.every((row) => row.settled));
      return { status: "already_applied" as const, plan: saved.marker.plan };
    }
    requireClosure(operation.status === "uncertain" && state.status === "failed" && state.creation?.status === "paused" && state.creation.operationId === operation.id && state.creation.phase === "artwork" && state.failureCode === "attempt_uncertain" && !state.pendingOperation && !state.artwork);
    requireClosure(run.state.creation?.operationId === operation.id && run.state.creation.phase === "artwork" && !run.state.artwork && reservations.every((row) => !row.settled));
    const body = { policy, ownerId: target.ownerId, operationId: operation.id, publicationId: state.id, publicationVersion: state.version, customerReleaseCredits: 30, review };
    const runState = { operationId: run.operation_id, ownerId: run.owner_id, publicationId: run.publication_id, state: run.state, textReplies: run.text_replies };
    const stepState = steps.map((step) => ({ key: step.step_key, inputHash: step.input_hash, outputHash: step.output === null ? null : inputHash(step.output) }));
    const plan: Plan = { ...body, planHash: inputHash({ plan: body, state, runState, stepState, quote, reservations, originalError: operation.error, cost: operation.cost }) };
    if (!options.applyPlan) return { status: "ready_for_review" as const, plan };
    requireClosure(options.applyPlan === plan.planHash);
    // Keep the complete external liability even if the subsequent customer transaction rolls back.
    budget.abandonUndeliverable(binding, review.reviewId);
    const result = structuredClone(state);
    result.creation = { ...result.creation!, status: "failed", canReply: false };
    result.failureCode = "abandoned_undeliverable";
    result.failure = review.classification === "unsupported_image_model_400" ? "The image service rejected Kely's requested model, so this order was closed without a deliverable. Your 30 creation credits were released. Your idea is preserved; nothing was retried." : "Kely could not retain the generated image, so this order was closed without a deliverable. Your 30 creation credits were released. Your idea is preserved; nothing was retried.";
    await settleCredits(client, target.ownerId, operation.id, false);
    await client.query("UPDATE operation SET status='failed',error=$2,updated_at=now() WHERE id=$1", [operation.id, result.failure]);
    await writePublication(client, result, "Undeliverable order closed; customer credits released, full API liability retained", result.cost);
    const marker: Marker = { plan, originalError: operation.error, resultingVersion: result.version, resultingStateHash: inputHash(result) };
    await client.query("INSERT INTO operation_recovery(operation_id,owner_id,publication_id,review_id,plan_hash,marker) VALUES($1,$2,$3,$4,$5,$6)", [operation.id, target.ownerId, state.id, review.reviewId, plan.planHash, JSON.stringify(marker)]);
    if (options.failBeforeCommit) throw new Error("Injected abandonment PostgreSQL rollback");
    return { status: "applied" as const, plan };
  });
}
