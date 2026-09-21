import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { Platform, PublicationView, QuoteView } from "../shared/contracts";
import type { CreationResponse, CreationQuoteView } from "../shared/creation";
import { pool, transaction } from "./db";
import { lockWallet, requireEntitlement, reserveCredits, settleCredits, type Viewer } from "./credits";
import { assertCurrentBrand, freezeBrand, verifyFrozenBrand } from "./brand";
import { createPublication, readPublication, writePublication } from "./publications";
import { requireCondition } from "./errors";
import { generationMode } from "./config";
import { inputHash, snapshotPaidInput } from "./paid-input";
import { enqueueOperation } from "./queue";
import { CREATION_CREDITS, CREATION_REVISION_CREDITS, applySelectedOriginals, creationAnalysis, creationPlanHash, suggestedSlideCount, verifyCreationInput, type CreationInput } from "./creation-input";
import { interpretRevision } from "./revision-scope";

export interface QuoteCreationInput { idea: string; context?: string; platform: Platform; slideCount?: number; language?: string; sourceAnalysisId?: string; analysisMaterialIds?: string[] }

export async function quoteCreation(viewer: Viewer, input: QuoteCreationInput) {
  const mode = generationMode();
  requireCondition(mode !== "fixture", "provider_unavailable", "Creation is unavailable in this runtime. Your idea can be kept until the service is ready.", 409);
  requireCondition(!(input.sourceAnalysisId && input.analysisMaterialIds?.length), "analysis_input", "Reuse a saved analysis or choose images for the included analysis, not both.");
  const slideCount = input.slideCount ?? suggestedSlideCount(input.idea);
  const draft = await createPublication(viewer, { ...input, slideCount });
  return transaction(async (client) => {
    await requireEntitlement(client, await lockWallet(client, viewer.id));
    const state = await readPublication(viewer.id, draft.id, client, true);
    if (input.context?.trim()) state.messages.push({ id: randomUUID(), role: "user", text: input.context.trim(), createdAt: new Date().toISOString() });
    state.origin = mode;
    state.fixture = mode !== "openai";
    if (!state.brandBrief!.direction) state.brandBrief!.direction = "decide";
    state.messages = state.messages.filter((message) => message.role === "user");
    let brand = await freezeBrand(viewer.id, state, client);
    if (input.sourceAnalysisId) {
      const saved = (await client.query("SELECT a.snapshot FROM brand_analysis a JOIN operation o ON o.id=a.operation_id WHERE a.id=$1 AND a.owner_id=$2 AND o.status='completed'", [input.sourceAnalysisId, viewer.id])).rows[0];
      requireCondition(saved?.snapshot?.policy === "brand-analysis-v2" && saved.snapshot.input.selected.every((selected: { id: string; version: number; originalHash: string; role: string }) => brand.materials.some((material) => material.id === selected.id && material.version === selected.version && material.contentHash === selected.originalHash && material.role === selected.role)), "analysis_stale", "The saved analysis refers to changed or unavailable images. Choose the current images for included analysis.", 409);
    }
    const ids = input.analysisMaterialIds ?? (input.sourceAnalysisId ? [] : brand.materials.filter((item) => item.kind === "image" && item.role === "reference").slice(0, 3).map((item) => item.id));
    brand = applySelectedOriginals(brand, ids);
    const analysis = await creationAnalysis(viewer.id, ids, brand, `${input.idea}${input.context ? `\n${input.context}` : ""}`);
    const quote: CreationQuoteView = { id: randomUUID(), publicationId: state.id, credits: CREATION_CREDITS, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), summary: `Create the complete ${slideCount === 1 ? "post" : `${slideCount}-slide carousel`}, including necessary clarification${analysis ? `, analysis of ${ids.length} selected images (${analysis.selected.map((item) => item.label).join(", ")}; only these images are analyzed)` : ""}, design, caption and downloads. No separate stage charges.`, format: { platform: input.platform, slideCount, basis: input.slideCount ? "chosen" : "suggested" } };
    state.creation = { status: "quoted", phase: "context", credits: CREATION_CREDITS, questions: [], canReply: false, quote };
    await writePublication(client, state, "Complete creation quote saved; no AI called");
    const business = (await client.query("SELECT name,context,website FROM business WHERE owner_id=$1", [viewer.id])).rows[0];
    const snapshot: CreationInput = { schemaVersion: 15, policy: "plan-first-v1", ownerId: viewer.id, quoteId: quote.id, origin: mode, publication: state, brand, business: snapshotPaidInput(viewer.id, quote.id, "prepare", "", state, business).business, analysis, credits: CREATION_CREDITS, format: quote.format };
    await client.query("INSERT INTO quote(id,owner_id,publication_id,kind,publication_version,credits,instruction,expires_at,business_context,input_snapshot,input_hash,origin,model) VALUES($1,$2,$3,'create',$4,$5,'',$6,$7,$8,$9,$10,'gpt-5.6-luna')", [quote.id, viewer.id, state.id, state.version, quote.credits, quote.expiresAt, JSON.stringify(snapshot.business), JSON.stringify(snapshot), inputHash(snapshot), mode]);
    return { quote, publication: state };
  });
}

async function assertNoUnresolved(client: PoolClient, ownerId: string, publicationId: string) {
  const result = await client.query("SELECT id FROM operation WHERE owner_id=$1 AND publication_id=$2 AND status IN ('queued','running','uncertain','waiting_input') LIMIT 1", [ownerId, publicationId]);
  requireCondition(!result.rowCount, "creation_pending", "Finish or reconcile the saved creation before starting another.", 409);
}

export async function acceptCreation(viewer: Viewer, quoteId: string, requestKey: string) {
  const result = await transaction(async (client) => {
    const wallet = await lockWallet(client, viewer.id);
    const quote = (await client.query("SELECT * FROM quote WHERE id=$1 AND owner_id=$2 AND kind='create' FOR UPDATE", [quoteId, viewer.id])).rows[0];
    requireCondition(quote, "not_found", "That creation quote is unavailable.", 404);
    if (quote.accepted_operation_id) return { operationId: quote.accepted_operation_id as string, publicationId: quote.publication_id as string };
    requireCondition(!(await client.query("SELECT id FROM operation WHERE owner_id=$1 AND request_key=$2", [viewer.id, requestKey])).rowCount, "idempotency_conflict", "That request key belongs to another quote.", 409);
    await requireEntitlement(client, wallet);
    requireCondition(new Date(quote.expires_at) > new Date(), "quote_expired", "The quote expired. Review a current creation price.", 409);
    const state = await readPublication(viewer.id, quote.publication_id, client, true);
    requireCondition(state.version === quote.publication_version && ["quoted", "ready"].includes(state.creation?.status ?? ""), "stale_version", "The post changed. Review a current quote.", 409);
    await assertNoUnresolved(client, viewer.id, state.id);
    const snapshot = verifyCreationInput(quote.input_snapshot, quote.input_hash);
    requireCondition(snapshot.revision ? state.status === "ready" : state.creation?.status === "quoted", "stale_version", "The creation scope no longer matches this post.", 409);
    requireCondition(snapshot.ownerId === viewer.id && snapshot.quoteId === quoteId && snapshot.publication.id === state.id && snapshot.publication.version === state.version, "creation_snapshot_invalid", "The quote does not match this post.", 409);
    await assertCurrentBrand(viewer.id, snapshot.brand.version, client);
    await verifyFrozenBrand(viewer.id, snapshot.brand, client);
    const active = await client.query("SELECT o.id FROM creation_run r JOIN operation o ON o.id=r.operation_id WHERE r.owner_id=$1 AND o.status IN ('queued','running','uncertain','waiting_input') LIMIT 1", [viewer.id]);
    requireCondition(!active.rowCount, "creation_pending", "Finish the current creation before starting another.", 409);
    const operationId = randomUUID();
    await client.query("INSERT INTO operation(id,owner_id,publication_id,quote_id,request_key,kind,status,input_state,instruction,business_context,input_snapshot,input_hash,origin,model) VALUES($1,$2,$3,$4,$5,'create','queued',$6,'',$7,$8,$9,$10,'gpt-5.6-luna')", [operationId, viewer.id, state.id, quoteId, requestKey, JSON.stringify(snapshot.publication), JSON.stringify(snapshot.business), JSON.stringify(snapshot), quote.input_hash, snapshot.origin]);
    state.creation = { ...state.creation!, credits: quote.credits, status: "queued", phase: "context", operationId, quote: undefined };
    state.pendingOperation = { id: operationId, kind: "create", status: "queued", origin: snapshot.origin };
    state.status = "running";
    await reserveCredits(client, wallet, operationId, quote.credits);
    await client.query("INSERT INTO creation_run(operation_id,owner_id,publication_id,state) VALUES($1,$2,$3,$4)", [operationId, viewer.id, state.id, JSON.stringify(state)]);
    await client.query("UPDATE quote SET accepted_operation_id=$2 WHERE id=$1", [quoteId, operationId]);
    await writePublication(client, state, "Complete creation accepted");
    return { operationId, publicationId: state.id };
  });
  try { await enqueueOperation(result.operationId); } catch { /* Durable queued work is repaired by the worker. */ }
  return result;
}

export async function quoteCreationRevision(viewer: Viewer, publicationId: string, version: number, instruction: string): Promise<QuoteView> {
  return transaction(async (client) => {
    await requireEntitlement(client, await lockWallet(client, viewer.id));
    const state = await readPublication(viewer.id, publicationId, client, true);
    requireCondition(state.creation && state.status === "ready" && state.version === version && !state.pendingOperation, "revision_unavailable", "Describe a revision to the current complete post.", 409);
    await assertNoUnresolved(client, viewer.id, publicationId);
    const scope = interpretRevision(state, instruction);
    requireCondition(scope.kind !== "compose", "revision_scope_required", "Describe what should change; composition is included in the revision price.", 409);
    const origin = state.origin;
    requireCondition(origin === "ai_preview" || origin === "openai", "origin_conflict", "This post needs a supported saved generation origin.", 409);
    const brand = await freezeBrand(viewer.id, state, client);
    const id = randomUUID();
    const business = (await client.query("SELECT name,context,website FROM business WHERE owner_id=$1", [viewer.id])).rows[0];
    const snapshot: CreationInput = { schemaVersion: 14, policy: "unified-creation-v2", ownerId: viewer.id, quoteId: id, origin, publication: state, brand, business: snapshotPaidInput(viewer.id, id, "revise", instruction, state, business).business, analysis: null, credits: CREATION_REVISION_CREDITS, format: { platform: state.platform, slideCount: state.slideCount, basis: "chosen" }, revision: { scope, instruction } };
    const quote: QuoteView = { id, publicationId, kind: "revise", version, credits: CREATION_REVISION_CREDITS, summary: `Revise ${scope.kind === "plan" ? "the visual design" : scope.kind} on slide ${scope.target}, including its finished image. Keep the other slides and caption unchanged. Total: ${CREATION_REVISION_CREDITS} credits. Your request: ${instruction}`, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), fixture: origin !== "openai", origin, scope };
    await client.query("INSERT INTO quote(id,owner_id,publication_id,kind,publication_version,credits,instruction,expires_at,business_context,input_snapshot,input_hash,origin,model,scope) VALUES($1,$2,$3,'create',$4,$5,$6,$7,$8,$9,$10,$11,'gpt-5.6-luna',$12)", [id, viewer.id, publicationId, version, quote.credits, instruction, quote.expiresAt, JSON.stringify(snapshot.business), JSON.stringify(snapshot), inputHash(snapshot), origin, JSON.stringify(scope)]);
    return quote;
  });
}

export async function readCreation(ownerId: string, publicationId: string): Promise<CreationResponse> {
  const publication = await readPublication(ownerId, publicationId);
  requireCondition(publication.creation, "not_found", "That complete creation is unavailable.", 404);
  return { publication, creation: publication.creation };
}

export async function replyCreation(viewer: Viewer, publicationId: string, input: { version: number; message: string; requestKey: string }) {
  const result = await transaction(async (client) => {
    await lockWallet(client, viewer.id);
    const state = await readPublication(viewer.id, publicationId, client, true);
    const operationId = state.creation?.operationId;
    requireCondition(operationId, "not_found", "That creation is unavailable.", 404);
    const previous = (await client.query("SELECT * FROM creation_answer WHERE operation_id=$1 AND request_key=$2", [operationId, input.requestKey])).rows[0];
    if (previous) {
      requireCondition(previous.message === input.message && previous.publication_version === input.version, "idempotency_conflict", "That answer key belongs to different input.", 409);
      return { operationId, publicationId };
    }
    requireCondition(state.version === input.version && ["needs_input", "plan_ready"].includes(state.creation?.status ?? "") && state.creation?.canReply, "stale_version", "This creation is not waiting for that answer.", 409);
    const operation = (await client.query("SELECT status FROM operation WHERE id=$1 AND owner_id=$2 AND publication_id=$3 FOR UPDATE", [operationId, viewer.id, publicationId])).rows[0];
    requireCondition(operation?.status === "waiting_input", "creation_pending", "The current step must finish before another answer.", 409);
    requireCondition(state.messages.length < 30, "context_limit", "This creation has reached its context limit. Your work is preserved.", 409);
    state.messages.push({ id: randomUUID(), role: "user", text: input.message, createdAt: new Date().toISOString() });
    if (state.brandBrief?.blockingFacts.length === 1 && state.brandBrief.blockingFacts[0] === "Discount amount or offer terms have not been provided." && /(?:\d+(?:[.,]\d+)?\s*%|(?:omit|remove|no|without)\s+(?:the\s+)?discount|без\s+скид|ohne\s+rabatt)/iu.test(input.message)) {
      state.brandBrief.blockingFacts = [];
      state.brandBrief.factResolution = input.message;
    }
    state.creation = { ...state.creation, status: "queued", phase: "design", questions: [], canReply: false, ...(state.creation.plan ? { plan: { ...state.creation.plan, approved: false } } : {}) };
    state.status = "running";
    state.pendingOperation = { id: operationId, kind: "create", status: "queued", origin: state.origin };
    await writePublication(client, state, "Creation clarification saved; original price unchanged");
    await client.query("INSERT INTO creation_answer(operation_id,request_key,publication_version,message,resulting_version) VALUES($1,$2,$3,$4,$5)", [operationId, input.requestKey, input.version, input.message, state.version]);
    await client.query("UPDATE creation_run SET state=$2 WHERE operation_id=$1", [operationId, JSON.stringify(state)]);
    await client.query("UPDATE operation SET status='queued',updated_at=now() WHERE id=$1", [operationId]);
    return { operationId, publicationId };
  });
  try { await enqueueOperation(result.operationId); } catch { /* The saved answer remains resumable. */ }
  return result;
}

export async function generateCreation(viewer: Viewer, publicationId: string, input: { version: number; planVersion: number; planHash: string; requestKey: string }) {
  const result = await transaction(async (client) => {
    await lockWallet(client, viewer.id);
    const state = await readPublication(viewer.id, publicationId, client, true);
    const plan = state.creation?.plan;
    const operationId = state.creation?.operationId;
    requireCondition(plan && operationId, "plan_required", "Review the saved plan before generating.", 409);
    if (plan.approved && plan.approvalRequestKey === input.requestKey) {
      requireCondition(plan.version === input.planVersion && plan.hash === input.planHash && plan.approvedPublicationVersion === input.version, "idempotency_conflict", "That approval key belongs to another plan.", 409);
      return { operationId, publicationId };
    }
    requireCondition(state.version === input.version && state.creation?.status === "plan_ready" && !plan.approved && plan.version === input.planVersion && plan.hash === input.planHash && creationPlanHash(state) === plan.hash, "stale_version", "The plan changed. Review its current version before generating.", 409);
    const operation = (await client.query("SELECT status,input_snapshot,input_hash FROM operation WHERE id=$1 AND owner_id=$2 AND publication_id=$3 FOR UPDATE", [operationId, viewer.id, publicationId])).rows[0];
    requireCondition(operation?.status === "waiting_input", "creation_pending", "The current step must finish first.", 409);
    const snapshot = verifyCreationInput(operation.input_snapshot, operation.input_hash);
    requireCondition(snapshot.policy === "plan-first-v1" && !snapshot.revision, "plan_required", "This operation does not accept a plan approval.", 409);
    await verifyFrozenBrand(viewer.id, snapshot.brand, client);
    state.creation = { ...state.creation, plan: { ...plan, approved: true, approvalRequestKey: input.requestKey, approvedPublicationVersion: input.version }, status: "queued", phase: "composition", canReply: false };
    state.status = "running";
    state.pendingOperation = { id: operationId, kind: "create", status: "queued", origin: state.origin };
    await writePublication(client, state, "Exact saved plan approved for generation");
    await client.query("UPDATE creation_run SET state=$2 WHERE operation_id=$1", [operationId, JSON.stringify(state)]);
    await client.query("UPDATE operation SET status='queued',updated_at=now() WHERE id=$1", [operationId]);
    return { operationId, publicationId };
  });
  try { await enqueueOperation(result.operationId); } catch { /* Persisted approval is resumed by queue repair. */ }
  return result;
}

export async function cancelCreation(viewer: Viewer, publicationId: string, version: number) {
  return transaction(async (client) => {
    await lockWallet(client, viewer.id);
    const state = await readPublication(viewer.id, publicationId, client, true);
    if (state.creation?.cancelled) return { publication: state, creation: state.creation };
    requireCondition(state.version === version && state.creation && ["needs_input", "plan_ready"].includes(state.creation.status), "stale_version", "Only a paused discussion can be cancelled.", 409);
    const operationId = state.creation.operationId!;
    const operation = (await client.query("SELECT status FROM operation WHERE id=$1 AND owner_id=$2 FOR UPDATE", [operationId, viewer.id])).rows[0];
    requireCondition(operation?.status === "waiting_input", "creation_pending", "A running or uncertain generation cannot be cancelled here.", 409);
    state.creation = { ...state.creation, status: "paused", canReply: false, cancelled: true };
    state.status = "collecting";
    delete state.pendingOperation;
    await settleCredits(client, viewer.id, operationId, false);
    await client.query("UPDATE operation SET status='failed',error='Discussion cancelled by owner',updated_at=now() WHERE id=$1", [operationId]);
    await writePublication(client, state, "Discussion cancelled; draft preserved and unused allowance released");
    await client.query("UPDATE creation_run SET state=$2 WHERE operation_id=$1", [operationId, JSON.stringify(state)]);
    return { publication: state, creation: state.creation };
  });
}
