import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { CostEvidence, PublicationView } from "../shared/contracts";
import { pool, transaction } from "./db";
import { AppError, requireCondition } from "./errors";
import { BudgetError } from "./budget/store";
import { loadAcceptedInput } from "./accepted-input";
import { canonicalJson } from "./paid-input";
import { lockWallet, settleCredits } from "./credits";
import { readPublication, writePublication } from "./publications";
import { currentPreparation, preparationView } from "./preparation";
import { renderComposedSlide, validateComposedCopy } from "./renderer";
import { runFixtureOperation, type StoredOperation } from "./operations";
import { generationRequest, parseGeneratedReply } from "./providers/generation";
import { providerGateway } from "./providers/runtime";
import type { FakeProviderGateway } from "./providers/gateway";
import { verifyFrozenBrand } from "./brand";
import { assertBrandReady } from "./brand-policy";
import { pendingDirectionProposal } from "./semantic-direction";

type Options = { gateway?: FakeProviderGateway; failBeforeCommit?: boolean; failAfterSlide?: number; failBeforeGateway?: boolean };

export async function runOperation(id: string, options: Options = {}) {
  const { rows: [initial] } = await pool.query<StoredOperation>("SELECT * FROM operation WHERE id=$1", [id]);
  if (!initial || !["queued", "running"].includes(initial.status)) return;
  if (initial.kind === "create") return (await import("./creation-runner")).runCreation(id, options);
  if ((initial.kind as string) === "brand_analysis") return (await import("./brand-analysis")).runAnalysis(id, options);
  if (initial.origin === "fixture") return runFixtureOperation(id, options);
  requireCondition(initial.origin === "ai_preview" || initial.origin === "openai", "origin_conflict", "Unknown saved generation origin.", 409);
  requireCondition(!(options.gateway || options.failBeforeGateway) || initial.origin === "ai_preview", "origin_conflict", "Test transports cannot replace live provider accounting.", 409);
  const lease = await pool.connect();
  try {
    await lease.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [id]);
    const { rows: [operation] } = await pool.query<StoredOperation>("SELECT * FROM operation WHERE id=$1", [id]);
    if (!operation || !["queued", "running"].includes(operation.status)) return;
    await pool.query("UPDATE operation SET status='running',updated_at=now() WHERE id=$1", [id]);
    const { snapshot, hash } = await loadAcceptedInput(operation.owner_id, id);
    requireCondition(snapshot.generation?.origin === operation.origin && snapshot.generation.model === operation.model && canonicalJson(snapshot.generation.scope ?? null) === canonicalJson(operation.scope), "input_snapshot_conflict", "Saved generation policy is inconsistent.", 409);
    let result = structuredClone(snapshot.publication);
    let cost: CostEvidence | undefined;
    let attemptAdmitted = false;
    let preflightComplete = false;
    try {
      if (snapshot.schemaVersion >= 2 && snapshot.brand) {
        await verifyFrozenBrand(operation.owner_id, snapshot.brand);
        if (operation.kind === "cover" || operation.kind === "remaining" || (operation.kind === "revise" && !["copy", "plan"].includes(operation.scope?.kind ?? ""))) assertBrandReady(result, snapshot.brand);
      }
      preflightComplete = true;
      if (operation.kind === "prepare" || (operation.kind === "revise" && operation.scope?.kind !== "compose")) {
        if (options.failBeforeGateway) throw new AppError("provider_unavailable", "Injected unavailable provider runtime.", 409);
        const gateway = options.gateway ?? providerGateway(operation.origin as "ai_preview" | "openai");
        let reply;
        try {
          reply = await gateway.dispatch({ key: `kely:${id}:text`, ownerId: operation.owner_id, operationId: id, step: "text", snapshot: { acceptedHash: hash, input: snapshot }, request: generationRequest(snapshot) });
        } catch (error) {
          try {
            const exposure = await gateway.accountedExposure(`kely:${id}:text`);
            if (exposure) cost = { ...exposure, simulated: operation.origin === "ai_preview", model: operation.model };
          } catch { /* Integrity failures must remain blocked even if their ledger cannot be read. */ }
          throw error;
        }
        attemptAdmitted = true;
        cost = { basis: reply.assessment.basis, settledMicros: reply.assessment.settledMicros, uncertainMicros: reply.assessment.uncertainMicros, simulated: operation.origin === "ai_preview", model: operation.model };
        const output = parseGeneratedReply(reply.response, snapshot);
        result.uncertainFacts = output.uncertainFacts;
        const text = [output.message, ...output.questions].join("\n\n");
        if (operation.kind === "prepare") {
          if (snapshot.schemaVersion >= 3) result.preferenceProposals = output.preferences ?? [];
          if (snapshot.schemaVersion >= 4) result.proposedBrief = output.brief;
          if (output.kind === "proposal") {
            result.slides = output.slides.map((slide, index) => ({ ...slide, ...(snapshot.schemaVersion >= 4 ? { creativePlan: output.plans![index] } : {}), index, id: randomUUID(), copyOrigin: operation.origin, visualOrigin: "deterministic", palette: result.brandPalette ?? output.palette }));
            result.caption = output.caption;
            result.captionOrigin = operation.origin;
            result.status = "content_approval";
            if (snapshot.schemaVersion === 12 && output.semanticDirection) result.directionProposal = pendingDirectionProposal(output.semanticDirection, snapshot, operation.id);
            await validateComposedCopy(result);
          } else { result.status = "collecting"; if (snapshot.schemaVersion === 12) delete result.directionProposal; }
          result.outlineApproved = false;
          result.coverApproved = false;
        } else {
          const scope = operation.scope!;
          const target = result.slides[scope.target - 1];
          if (scope.kind === "copy" || scope.kind === "plan") {
            if (scope.kind === "copy") Object.assign(target, output.slides[0], { copyOrigin: operation.origin });
            else target.creativePlan = output.plans![0];
            delete target.assetId;
            result.pendingVisualTargets = [...new Set([...(result.pendingVisualTargets ?? []), scope.target])];
            result.outlineApproved = false;
            if (scope.target === 1) result.coverApproved = false;
            result.status = "content_approval";
            await validateComposedCopy({ ...result, slides: [target] });
          } else {
            target.palette = output.palette;
            if (result.artDirection && output.artPalette) target.artDirection = { ...(target.artDirection ?? result.artDirection), direction: { ...(target.artDirection ?? result.artDirection).direction, palette: output.artPalette } };
            target.assetId = await renderComposedSlide(operation.owner_id, result, target, id);
            if (scope.target === 1) { result.coverApproved = false; result.status = "cover_approval"; }
            else result.status = result.slides.every((slide) => slide.assetId) ? "ready" : "cover_approval";
          }
          if (snapshot.schemaVersion >= 9 && output.preferences?.length) result.preferenceProposals = [...(result.preferenceProposals ?? []), ...output.preferences];
          result.messages.push({ id: snapshot.schemaVersion >= 9 ? snapshot.quoteId : randomUUID(), role: "user", text: operation.instruction, createdAt: new Date().toISOString() });
        }
        result.messages.push({ id: randomUUID(), role: "assistant", origin: operation.origin, text: operation.origin === "ai_preview" ? `[FAKE RESPONSES PREVIEW — no real AI]\n${text}` : text, createdAt: new Date().toISOString() });
      } else if (operation.kind === "cover") {
        result.slides[0].assetId = await renderComposedSlide(operation.owner_id, result, result.slides[0], id);
        result.slides[0].visualOrigin = "deterministic";
        result.coverApproved = false;
        result.status = "cover_approval";
      } else if (operation.kind === "remaining") {
        for (let index = 1; index < result.slides.length; index++) {
          result.slides[index].assetId = await renderComposedSlide(operation.owner_id, result, result.slides[index], id);
          result.slides[index].visualOrigin = "deterministic";
          if (options.failAfterSlide === index) throw new AppError("composition_failed", "The composition stage could not be completed. Previous work is preserved.", 422);
        }
        result.status = "ready";
      } else {
        const target = operation.scope!.target;
        result.slides[target - 1].assetId = await renderComposedSlide(operation.owner_id, result, result.slides[target - 1], id);
        result.slides[target - 1].visualOrigin = "deterministic";
        result.pendingVisualTargets = result.pendingVisualTargets?.filter((item) => item !== target);
        if (target === 1) { result.coverApproved = false; result.status = "cover_approval"; }
        else result.status = result.slides.every((slide) => slide.assetId) ? "ready" : "cover_approval";
      }
    } catch (error) {
      if (!(error instanceof AppError || error instanceof BudgetError)) throw error;
      await recordFailure(operation, error, cost, attemptAdmitted, !preflightComplete);
      return;
    }
    result.origin = operation.origin;
    result.fixture = operation.origin !== "openai";
    if (cost) result.cost = cost;
    await transaction(async (client) => {
      await lockWallet(client, operation.owner_id);
      const current = await ownedCurrent(client, operation);
      if (operation.package_id) {
        const updated = await client.query("UPDATE preparation_package SET activated=true,replies_used=replies_used+1 WHERE id=$1 AND replies_used<3 AND NOT paused RETURNING *", [operation.package_id]);
        requireCondition(updated.rows[0], "package_changed", "The preparation package needs coordinator review.", 409);
        result.preparation = preparationView(updated.rows[0]);
      }
      result.version = current.version;
      result.history = current.history;
      delete result.pendingOperation; delete result.failure; delete result.failureCode; delete result.failedOperationKind;
      await writePublication(client, result, `${operation.origin === "ai_preview" ? "Fake Responses preview" : "OpenAI text / deterministic composition"}: ${operation.kind} completed`, cost);
      await settleCredits(client, operation.owner_id, id, true);
      await client.query("UPDATE operation SET status='completed',cost=$2,updated_at=now() WHERE id=$1", [id, cost ? JSON.stringify(cost) : null]);
      // Provider evidence is already durable outside PostgreSQL; rollback must replay it, never send again.
      if (options.failBeforeCommit) throw new Error("Injected useful-result PostgreSQL rollback");
    });
  } finally {
    await lease.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [id]);
    lease.release();
  }
}

async function ownedCurrent(client: PoolClient, operation: StoredOperation) {
  const current = await readPublication(operation.owner_id, operation.publication_id, client, true);
  requireCondition(current.pendingOperation?.id === operation.id, "operation_conflict", "This operation no longer owns the publication.", 409);
  return current;
}

async function recordFailure(operation: StoredOperation, error: AppError | BudgetError, cost: CostEvidence | undefined, admitted: boolean, preflightFailure: boolean) {
  cost ??= operation.status === "running" ? operation.cost ?? undefined : undefined;
  const needsProvider = operation.kind === "prepare" || (operation.kind === "revise" && operation.scope?.kind !== "compose");
  const uncertain = (operation.status === "running" && (preflightFailure || (needsProvider && !admitted))) || (error instanceof BudgetError && ["attempt_uncertain", "attempt_conflict", "budget_integrity"].includes(error.code));
  const noAttempt = !uncertain && ((preflightFailure && operation.status === "queued") || ((["budget_exhausted", "dispatch_in_progress", "budget_integrity", "provider_unavailable"].includes(error.code)) && !admitted));
  await transaction(async (client) => {
    await lockWallet(client, operation.owner_id);
    const current = await ownedCurrent(client, operation);
    const result = structuredClone(operation.input_state);
    result.version = current.version; result.history = current.history;
    result.status = "failed"; result.failedOperationKind = operation.kind; result.failureCode = error.code;
    result.failure = `${error.message} ${uncertain ? "This attempt is paused for coordinator reconciliation; no retry was sent and its reservation is retained." : "This stage's customer reservation was released; earlier completed work and provider spending remain recorded."}`;
    if (operation.package_id) {
      if (noAttempt) await client.query("UPDATE preparation_package SET attempts_used=greatest(0,attempts_used-1) WHERE id=$1", [operation.package_id]);
      await client.query("UPDATE preparation_package SET paused=$2 OR attempts_used>=4 OR attempts_used-replies_used>=2 WHERE id=$1", [operation.package_id, uncertain]);
      const preparation = await currentPreparation(operation.owner_id, operation.publication_id, client);
      if (preparation) result.preparation = preparationView(preparation);
    }
    if (cost) result.cost = cost;
    delete result.pendingOperation;
    await writePublication(client, result, uncertain ? "Provider attempt paused; exposure retained" : "Stage failed; prior work preserved", cost);
    if (!uncertain) await settleCredits(client, operation.owner_id, operation.id, false);
    await client.query("UPDATE operation SET status=$2,error=$3,cost=$4,updated_at=now() WHERE id=$1", [operation.id, uncertain ? "uncertain" : "failed", result.failure, cost ? JSON.stringify(cost) : null]);
  });
}
