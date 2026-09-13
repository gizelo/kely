import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import type { PoolClient } from "pg";
import type { AnalysisView } from "../shared/analysis";
import type { CostEvidence } from "../shared/contracts";
import { pool, transaction } from "./db";
import { lockWallet, requireEntitlement, reserveCredits, settleCredits, type Viewer } from "./credits";
import { readBrand, readBrandMaterial, readSourceBundle, requireBrandAccess, updateBrandRuleInTransaction } from "./brand";
import { AppError, requireCondition } from "./errors";
import { canonicalJson, inputHash } from "./paid-input";
import { generationMode } from "./config";
import { enqueueOperation } from "./queue";
import { analysisRequest, parseAnalysis, type AnalysisInput, type AnalysisPolicy } from "./providers/analysis";
import { validateVisionRequest, type BoundedVisionRequest } from "./providers/vision-envelope";
import { providerGateway } from "./providers/runtime";
import { BudgetError } from "./budget/store";
import type { FakeProviderGateway } from "./providers/gateway";

type Snapshot = { policy: AnalysisPolicy; ownerId: string; input: AnalysisInput; request: BoundedVisionRequest };
type Row = { id: string; owner_id: string; brand_version: number; origin: "ai_preview" | "openai"; snapshot: Snapshot; snapshot_hash: string; credits: number; expires_at: Date; operation_id: string | null; proposal: AnalysisView["proposal"] | null; applied: boolean; created_at: Date; status: AnalysisView["status"] | null; error: string | null; cost: CostEvidence | null };
const selection = "SELECT a.*,o.status,o.error,o.cost FROM brand_analysis a LEFT JOIN operation o ON o.id=a.operation_id";
function view(row: Row): AnalysisView {
  return { id: row.id, status: row.status ?? "quoted", brandVersion: row.brand_version, credits: row.credits, origin: row.origin, createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString(), guidance: row.snapshot.input.guidance, selected: row.snapshot.input.selected.map(({ id, label, role, width, height, derivativeHash }) => ({ id, label, role, width, height, derivativeHash })), applied: row.applied, ...(row.proposal ? { proposal: row.proposal } : {}), ...(row.cost ? { cost: row.cost } : {}), ...(row.error ? { error: row.error } : {}) };
}
async function readRow(ownerId: string, id: string, client: PoolClient | typeof pool = pool, lock = false) {
  const row = (await client.query<Row>(`${selection} WHERE a.owner_id=$1 AND a.id=$2${lock ? " FOR UPDATE OF a" : ""}`, [ownerId, id])).rows[0];
  requireCondition(row, "not_found", "That private reference analysis is unavailable.", 404);
  return row;
}
export async function readAnalysis(ownerId: string, id: string) { return view(await readRow(ownerId, id)); }
export async function analysisDerivative(ownerId: string, id: string, materialId: string) {
  const row = await readRow(ownerId, id);
  requireCondition(inputHash(row.snapshot) === row.snapshot_hash, "analysis_snapshot_invalid", "The analysis snapshot is invalid.", 409);
  const selected = row.snapshot.input.selected.find((item) => item.id === materialId);
  requireCondition(selected, "not_found", "That selected analysis image is unavailable.", 404);
  const bytes = Buffer.from(selected.dataUrl.slice(23), "base64");
  requireCondition(createHash("sha256").update(bytes).digest("hex") === selected.derivativeHash, "analysis_snapshot_invalid", "The selected analysis image failed its integrity check.", 409);
  return bytes;
}
export async function listAnalyses(ownerId: string) { return { analyses: (await pool.query<Row>(`${selection} WHERE a.owner_id=$1 ORDER BY a.created_at DESC LIMIT 30`, [ownerId])).rows.map(view) }; }
async function reconciled(client: PoolClient, ownerId: string) {
  const pending = await client.query("SELECT id FROM operation WHERE owner_id=$1 AND kind='brand_analysis' AND status IN ('queued','running','uncertain') LIMIT 1", [ownerId]);
  requireCondition(!pending.rowCount, "analysis_pending", "Finish or reconcile the existing reference analysis before accepting another. No duplicate analysis was sent.", 409);
}

export async function quoteAnalysis(viewer: Viewer, input: { materialIds: string[]; guidance: string; version: number }) {
  requireCondition(input.materialIds.length >= 1 && input.materialIds.length <= 3 && new Set(input.materialIds).size === input.materialIds.length && input.guidance.length <= 8000, "analysis_input", "Choose one to three distinct images and a short analysis brief.");
  await requireBrandAccess(viewer);
  const mode = generationMode();
  requireCondition(mode !== "fixture", "analysis_preview_required", "Reference analysis requires the explicit safe Responses preview launcher, or coordinator-approved live mode. No credits were reserved.", 409);
  return transaction(async (client) => {
    await requireEntitlement(client, await lockWallet(client, viewer.id));
    await reconciled(client, viewer.id);
    const brand = await readBrand(viewer.id, client);
    requireCondition(brand.version === input.version, "brand_changed", "The brand changed. Review current materials before quoting analysis.", 409);
    const selectable = new Set((await readSourceBundle(viewer.id, client)).completeness.selectableAnalysisMaterialIds);
    const selected: AnalysisInput["selected"] = [];
    for (const id of input.materialIds) {
      requireCondition(selectable.has(id) && brand.materials.some((item) => item.id === id && item.kind === "image"), "analysis_input", "Only available active owner reference images can be analyzed. Links and inaccessible sources have not been read.", 409);
      const original = await readBrandMaterial(viewer.id, id, client);
      const { data, info } = await sharp(original.bytes, { limitInputPixels: 16_000_000, failOn: "warning" }).resize({ width: 1536, height: 1536, fit: "inside", withoutEnlargement: true }).flatten({ background: "#FFFFFF" }).jpeg({ quality: 90, chromaSubsampling: "4:4:4" }).toBuffer({ resolveWithObject: true });
      requireCondition(data.length <= 1_048_576, "analysis_image_large", "This reference exceeds the analysis derivative limit at the agreed quality. Supply a smaller image; it was not silently degraded.", 422);
      selected.push({ id, label: original.view.label, role: original.view.role, version: original.view.version, originalHash: original.view.contentHash!, derivativeHash: createHash("sha256").update(data).digest("hex"), width: info.width, height: info.height, dataUrl: `data:image/jpeg;base64,${data.toString("base64")}` });
    }
    const analysisInput = { selected, guidance: input.guidance, rules: brand.rules };
    const snapshot: Snapshot = { policy: "brand-analysis-v2", ownerId: viewer.id, input: analysisInput, request: analysisRequest(analysisInput, "brand-analysis-v2") };
    const serialized = canonicalJson(snapshot);
    const quota = (await client.query("SELECT count(*)::int AS count,coalesce(sum(octet_length(snapshot::text)),0)::bigint AS bytes FROM brand_analysis WHERE owner_id=$1", [viewer.id])).rows[0];
    requireCondition(quota.count < 50 && Number(quota.bytes) + Buffer.byteLength(serialized) <= 64 * 1024 * 1024, "analysis_storage_limit", "The local analysis archive has reached its retained storage limit. Coordinator review is required; old evidence is not deleted automatically.", 409);
    const id = randomUUID();
    const origin = mode;
    await client.query("INSERT INTO brand_analysis(id,owner_id,brand_version,origin,snapshot,snapshot_hash,credits,expires_at) VALUES($1,$2,$3,$4,$5,$6,3,now()+interval '10 minutes')", [id, viewer.id, brand.version, origin, serialized, inputHash(snapshot)]);
    return view(await readRow(viewer.id, id, client));
  });
}

async function verifySnapshot(row: Row, client: PoolClient | typeof pool = pool) {
  requireCondition(["brand-analysis-v1", "brand-analysis-v2"].includes(row.snapshot.policy) && row.snapshot.ownerId === row.owner_id && inputHash(row.snapshot) === row.snapshot_hash, "analysis_snapshot_invalid", "The immutable analysis snapshot could not be verified.", 409);
  const request = validateVisionRequest(row.snapshot.request);
  requireCondition(canonicalJson(request) === canonicalJson(analysisRequest(row.snapshot.input, row.snapshot.policy)), "analysis_snapshot_invalid", "The saved images and the quoted provider body disagree.", 409);
  for (const selected of row.snapshot.input.selected) {
    const material = await readBrandMaterial(row.owner_id, selected.id, client);
    requireCondition(material.view.version === selected.version && material.view.contentHash === selected.originalHash && material.view.role === selected.role, "material_unavailable", "A selected original material version could not be verified.", 409);
    requireCondition(createHash("sha256").update(Buffer.from(selected.dataUrl.slice(23), "base64")).digest("hex") === selected.derivativeHash, "analysis_snapshot_invalid", "An analysis derivative does not match its accepted hash.", 409);
  }
}

export async function acceptAnalysis(viewer: Viewer, id: string, requestKey: string) {
  const operationId = await transaction(async (client) => {
    const wallet = await lockWallet(client, viewer.id);
    await requireEntitlement(client, wallet);
    const row = await readRow(viewer.id, id, client, true);
    if (row.operation_id) return row.operation_id;
    await reconciled(client, viewer.id);
    requireCondition(row.expires_at.getTime() > Date.now(), "quote_expired", "The analysis quote expired. Review a new quote before spending credits.", 409);
    requireCondition((await readBrand(viewer.id, client)).version === row.brand_version, "brand_changed", "The brand changed after this quote. Request a new analysis quote.", 409);
    await verifySnapshot(row, client);
    const reused = await client.query("SELECT id FROM operation WHERE owner_id=$1 AND request_key=$2", [viewer.id, requestKey]);
    requireCondition(!reused.rowCount, "idempotency_conflict", "This request key belongs to another accepted action.", 409);
    const operation = randomUUID();
    await client.query("INSERT INTO operation(id,owner_id,publication_id,quote_id,request_key,kind,status,input_state,origin,model) VALUES($1,$2,NULL,NULL,$3,'brand_analysis','queued',$4,$5,'gpt-5.6-luna')", [operation, viewer.id, requestKey, JSON.stringify({ analysisId: row.id, snapshotHash: row.snapshot_hash }), row.origin]);
    await client.query("UPDATE brand_analysis SET operation_id=$2 WHERE id=$1", [id, operation]);
    await reserveCredits(client, wallet, operation, row.credits);
    return operation;
  });
  try { await enqueueOperation(operationId); } catch { /* Durable queued work is recovered by the existing worker. */ }
  return readAnalysis(viewer.id, id);
}

export async function runAnalysis(operationId: string, options: { gateway?: FakeProviderGateway; failBeforeCommit?: boolean; failBeforeGateway?: boolean } = {}) {
  const lease = await pool.connect();
  try {
    await lease.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [operationId]);
    const row = (await pool.query<Row>(`${selection} WHERE a.operation_id=$1`, [operationId])).rows[0];
    if (!row || !["queued", "running"].includes(row.status ?? "")) return;
    requireCondition(!options.gateway || row.origin === "ai_preview", "origin_conflict", "A fake transport cannot replace live analysis accounting.", 409);
    requireCondition(!options.failBeforeGateway || row.origin === "ai_preview", "origin_conflict", "Injected runtime failures are confined to fake analysis.", 409);
    const operation = (await pool.query("SELECT kind,owner_id,origin,input_state FROM operation WHERE id=$1", [operationId])).rows[0];
    requireCondition(operation.kind === "brand_analysis" && operation.owner_id === row.owner_id && operation.origin === row.origin && operation.input_state.analysisId === row.id && operation.input_state.snapshotHash === row.snapshot_hash, "analysis_snapshot_invalid", "The analysis operation does not match its accepted quote.", 409);
    await pool.query("UPDATE operation SET status='running',updated_at=now() WHERE id=$1", [operationId]);
    let cost: CostEvidence | undefined;
    let providerOutcomeKnown = false;
    let proposal: AnalysisView["proposal"];
    try {
      await verifySnapshot(row);
      if (options.failBeforeGateway) throw new AppError("provider_unavailable", "Injected unavailable provider runtime.", 409);
      const gateway = options.gateway ?? providerGateway(row.origin);
      const key = `kely:${operationId}:vision`;
      let reply;
      try { reply = await gateway.dispatch({ key, ownerId: row.owner_id, operationId, step: "brand-analysis", snapshot: { acceptedHash: row.snapshot_hash, input: row.snapshot }, request: row.snapshot.request }); }
      catch (error) { const evidence = await gateway.accountedExposure(key); if (evidence) cost = { ...evidence, simulated: row.origin === "ai_preview", model: "gpt-5.6-luna" }; throw error; }
      cost = { basis: reply.assessment.basis, settledMicros: reply.assessment.settledMicros, uncertainMicros: reply.assessment.uncertainMicros, simulated: row.origin === "ai_preview", model: "gpt-5.6-luna" };
      providerOutcomeKnown = true;
      proposal = parseAnalysis(reply.response, row.snapshot.input, row.snapshot.policy);
    } catch (error) {
      const uncertain = (!providerOutcomeKnown && row.status === "running") || error instanceof BudgetError && ["attempt_uncertain", "attempt_conflict", "budget_integrity"].includes(error.code);
      const safeError = error instanceof AppError || error instanceof BudgetError ? error.message : "The analysis result was unusable or could not be verified.";
      const savedCost = cost ?? (!providerOutcomeKnown && row.status === "running" ? row.cost : null);
      await transaction(async (client) => {
        await lockWallet(client, row.owner_id);
        await client.query("UPDATE operation SET status=$2,error=$3,cost=$4,updated_at=now() WHERE id=$1", [operationId, uncertain ? "uncertain" : "failed", `${safeError} ${uncertain ? "Exposure and customer credits are retained for reconciliation; no retry is allowed." : "This action's customer credits were released. Any provider spending remains recorded."}`, savedCost ? JSON.stringify(savedCost) : null]);
        if (!uncertain) await settleCredits(client, row.owner_id, operationId, false);
      });
      return;
    }
    await transaction(async (client) => {
      await lockWallet(client, row.owner_id);
      await client.query("UPDATE brand_analysis SET proposal=$2 WHERE id=$1", [row.id, JSON.stringify(proposal)]);
      await settleCredits(client, row.owner_id, operationId, true);
      await client.query("UPDATE operation SET status='completed',cost=$2,error=NULL,updated_at=now() WHERE id=$1", [operationId, JSON.stringify(cost)]);
      if (options.failBeforeCommit) throw new Error("Injected analysis useful-result rollback");
    });
  } finally { await lease.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [operationId]); lease.release(); }
}

export async function applyAnalysis(viewer: Viewer, id: string, input: { version: number; commandKey: string }) {
  return transaction(async (client) => {
    await requireEntitlement(client, await lockWallet(client, viewer.id));
    const row = await readRow(viewer.id, id, client, true);
    requireCondition(row.status === "completed" && row.proposal, "analysis_unavailable", "Only a completed usable analysis can be confirmed.", 409);
    if (row.applied) return { analysis: view(row), brand: await readBrand(viewer.id, client) };
    requireCondition(input.version === row.brand_version, "brand_changed", "This proposal was made for a different brand version. Review a fresh analysis instead of overwriting newer rules.", 409);
    const brand = await updateBrandRuleInTransaction(client, viewer, { field: "artDirection", value: row.proposal.direction, version: input.version, commandKey: input.commandKey });
    await client.query("UPDATE brand_analysis SET applied=true WHERE id=$1", [id]);
    return { analysis: view({ ...row, applied: true }), brand };
  });
}
