import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Viewer } from "./credits";
import { lockWallet, requireEntitlement } from "./credits";
import { pool, transaction } from "./db";
import { AppError, requireCondition } from "./errors";
import { BrandIntelligenceStore, type ResearchRunView } from "./brand-intelligence-store";
import { canonicalEvidenceUrl, createBrandIntelligenceSnapshot, evidenceRecordFromSpan } from "./brand-intelligence";
import type { BrandResearchInput } from "../shared/brand-intelligence";
import { researchPackageInput, reserveResearchPackage, closeResearchPackageFromDurableEvidence } from "./budget/research-package";
import { config } from "./config";
import { dispatchEntitySearch } from "./providers/research-dispatcher";
import { runLiveResearch } from "./research-live-orchestrator";
import { researchBriefFormatConflict } from "./providers/research-stages";

const commandKey = z.string().min(8).max(100);
const httpsUrl = z.string().trim().max(2000).transform((value, context) => {
  try { return canonicalEvidenceUrl(value); } catch { context.addIssue({ code: "custom", message: "Use a public HTTPS URL." }); return z.NEVER; }
});

export const researchStartSchema = z.object({
  businessName: z.string().trim().min(1).max(160),
  category: z.string().trim().max(160).optional(),
  location: z.string().trim().max(160).optional(),
  idea: z.string().trim().min(1).max(2000),
  platform: z.enum(["instagram", "linkedin"]),
  userSuppliedUrls: z.array(httpsUrl).max(5).default([]),
  materialIds: z.array(z.uuid()).max(3).default([]),
  commandKey,
}).strict().superRefine((value, context) => {
  const conflict = researchBriefFormatConflict(value.idea);
  if (conflict) context.addIssue({ code: "custom", path: ["idea"], message: conflict });
});

export const researchAnswerSchema = z.object({
  commandKey,
  answers: z.array(z.object({ code: z.enum(["entity_conflict", "missing_fact", "missing_asset", "regulated_ambiguity", "offer_ambiguity", "source_conflict"]), key: z.string().trim().min(1).max(100), value: z.string().trim().min(1).max(1000) }).strict()).min(1).max(3),
}).strict();

export const researchCorrectionSchema = z.object({
  commandKey,
  businessName: z.string().trim().min(1).max(160).optional(), category: z.string().trim().max(160).optional(), location: z.string().trim().max(160).optional(),
  idea: z.string().trim().min(1).max(2000).optional(), platform: z.enum(["instagram", "linkedin"]).optional(), userSuppliedUrls: z.array(httpsUrl).max(5).optional(),
}).strict().superRefine((value, context) => {
  if (!Object.keys(value).some((key) => key !== "commandKey")) context.addIssue({ code: "custom", message: "Provide at least one correction." });
  const conflict = value.idea ? researchBriefFormatConflict(value.idea) : null;
  if (conflict) context.addIssue({ code: "custom", path: ["idea"], message: conflict });
});

type StartInput = z.infer<typeof researchStartSchema>;
type AnswerInput = z.infer<typeof researchAnswerSchema>;
type CorrectionInput = z.infer<typeof researchCorrectionSchema>;
type DurableResearchInput = { type: "start" | "answer" | "correct"; researchMode: "fixture" | "openai"; research: BrandResearchInput; materialIds: string[]; answers?: AnswerInput["answers"] };

interface ResearchStore {
  list(ownerId: string, limit?: number): Promise<ResearchRunView[]>;
  start(ownerId: string, input: unknown, commandKey: string, supersedesRunId?: string | null): Promise<ResearchRunView>;
  read(ownerId: string, runId: string): Promise<ResearchRunView>;
  appendStatus(ownerId: string, runId: string, status: "resolving" | "needs_input" | "failed", detail?: unknown): Promise<ResearchRunView>;
  addSource(ownerId: string, runId: string, evidence: ReturnType<typeof evidenceRecordFromSpan>, outcome: "complete"): Promise<ResearchRunView>;
  acceptSnapshot(ownerId: string, runId: string, snapshot: ReturnType<typeof createBrandIntelligenceSnapshot>, supersedesSnapshotId?: string | null): Promise<{ id: string; version: number; hash: string }>;
}

function mode() {
  const value = process.env.KELY_RESEARCH_MODE ?? "fixture";
  requireCondition(value === "fixture" || value === "openai", "research_mode_invalid", "Brand research mode is not supported.", 503);
  return value;
}

function inputFromRun(run: ResearchRunView): DurableResearchInput {
  const parsed = z.object({ type: z.enum(["start", "answer", "correct"]), researchMode: z.enum(["fixture", "openai"]).default("fixture"), research: z.object({ businessName: z.string(), category: z.string().optional(), location: z.string().optional(), idea: z.string(), platform: z.enum(["instagram", "linkedin"]), userSuppliedUrls: z.array(z.string()) }), materialIds: z.array(z.string()), answers: z.array(z.any()).optional() }).parse(run.input);
  return parsed as DurableResearchInput;
}

function publicView(run: ResearchRunView, selectedMode: "fixture" | "openai" = "fixture") {
  return selectedMode === "fixture" ? { ...run, researchMode: "simulated_fixture" as const, simulated: true, notice: "Fixture research uses only the information you supplied. It does not search the web." } : { ...run, researchMode: "openai" as const, simulated: false };
}

async function simulate(store: ResearchStore, ownerId: string, run: ResearchRunView, input: DurableResearchInput) {
  if (run.status !== "queued") return publicView(run);
  await store.appendStatus(ownerId, run.id, "resolving", { simulated: true });
  const content = JSON.stringify({ businessName: input.research.businessName, category: input.research.category, location: input.research.location, idea: input.research.idea, answers: input.answers ?? [] });
  const bounded = content.slice(0, 500);
  const evidence = evidenceRecordFromSpan({ id: randomUUID(), sourceKind: "user", sourceRole: "user_provided", sourceUrl: `https://fixture.kely.invalid/research/${run.id}`, content: bounded, span: { start: 0, end: bounded.length }, fetchedAt: new Date().toISOString() });
  await store.addSource(ownerId, run.id, evidence, "complete");
  const candidate = input.research.userSuppliedUrls[0] ? [{ id: `candidate-${run.id}`, displayName: input.research.businessName, canonicalUrl: input.research.userSuppliedUrls[0], evidenceIds: [evidence.id], signals: { userSuppliedUrl: true, officialSiteClaim: false, exactNameMatch: true, crossLinkedProfile: false } }] : [];
  const snapshot = createBrandIntelligenceSnapshot({ id: randomUUID(), version: 1, createdAt: new Date().toISOString(), query: { businessName: input.research.businessName, userSuppliedUrls: input.research.userSuppliedUrls }, evidence: [evidence], entityCandidates: candidate, claims: [{ key: "creative_brief", kind: "creative", value: input.research.idea, status: "confirmed", confidence: "high", evidenceIds: [evidence.id] }], requiredAssets: [] });
  await store.acceptSnapshot(ownerId, run.id, snapshot);
  return publicView(await store.appendStatus(ownerId, run.id, "needs_input", { simulated: true, reason: "Web research was not performed. Confirm the business identity when live research is enabled." }));
}

export class ResearchService {
  constructor(private readonly store: ResearchStore = new BrandIntelligenceStore(pool), private readonly entitlement: (viewer: Viewer) => Promise<void> = async (viewer) => transaction(async (client) => requireEntitlement(client, await lockWallet(client, viewer.id))), private readonly liveExecutor: ((viewer: Viewer, run: ResearchRunView, input: DurableResearchInput) => Promise<ResearchRunView>) | null = defaultLiveExecutor, private readonly enqueueLive?: (ownerId: string, runId: string) => Promise<void>) {}

  private async beginLive(viewer: Viewer, run: ResearchRunView, durable: DurableResearchInput) {
    requireCondition(this.liveExecutor, "research_dispatch_unavailable", "Live research is not configured.", 503);
    if (this.enqueueLive) { await this.enqueueLive(viewer.id, run.id); return publicView(run, "openai"); }
    return publicView(await this.liveExecutor(viewer, run, durable), "openai");
  }

  async start(viewer: Viewer, raw: unknown) {
    const selectedMode = mode(); const input = researchStartSchema.parse(raw); await this.entitlement(viewer);
    const durable: DurableResearchInput = { type: "start", researchMode: selectedMode, research: { businessName: input.businessName, category: input.category, location: input.location, idea: input.idea, platform: input.platform, userSuppliedUrls: input.userSuppliedUrls }, materialIds: input.materialIds };
    const run = await this.store.start(viewer.id, durable, input.commandKey);
    if (selectedMode === "openai") return this.beginLive(viewer, run, durable);
    return simulate(this.store, viewer.id, run, durable);
  }

  async read(ownerId: string, id: string) { const run = await this.store.read(ownerId, id); return publicView(run, inputFromRun(run).researchMode); }

  async list(ownerId: string) {
    const runs = await this.store.list(ownerId);
    return runs.map((run) => {
      const selectedMode = inputFromRun(run).researchMode;
      return {
        id: run.id,
        input: run.input,
        supersedesRunId: run.supersedesRunId,
        status: run.status,
        statusDetail: run.statusDetail,
        createdAt: run.createdAt,
        snapshots: run.snapshots.map(({ id, version, hash, supersedesSnapshotId, acceptedAt }) => ({ id, version, hash, supersedesSnapshotId, acceptedAt })),
        researchMode: selectedMode === "fixture" ? "simulated_fixture" as const : "openai" as const,
        simulated: selectedMode === "fixture",
      };
    });
  }

  async answer(viewer: Viewer, id: string, raw: unknown) {
    const selectedMode = mode(); const input = researchAnswerSchema.parse(raw); const parent = await this.store.read(viewer.id, id); const prior = inputFromRun(parent);
    requireCondition(parent.status === "needs_input" || parent.status === "partial", "research_answer_unavailable", "This research run is not waiting for an answer.", 409);
    const durable: DurableResearchInput = { ...prior, type: "answer", researchMode: selectedMode, answers: input.answers };
    const run = await this.store.start(viewer.id, durable, input.commandKey, parent.id);
    if (selectedMode === "openai") return this.beginLive(viewer, run, durable);
    return simulate(this.store, viewer.id, run, durable);
  }

  async correct(viewer: Viewer, id: string, raw: unknown) {
    const selectedMode = mode(); const input = researchCorrectionSchema.parse(raw); const parent = await this.store.read(viewer.id, id); const prior = inputFromRun(parent);
    const { commandKey: key, ...correction } = input;
    const durable: DurableResearchInput = { ...prior, type: "correct", researchMode: selectedMode, research: { ...prior.research, ...correction } };
    const run = await this.store.start(viewer.id, durable, key, parent.id);
    if (selectedMode === "openai") return this.beginLive(viewer, run, durable);
    return simulate(this.store, viewer.id, run, durable);
  }
}

async function defaultLiveExecutor(viewer: Viewer, run: ResearchRunView, durable: DurableResearchInput) {
  if (run.status !== "queued") return run;
  const materialInput = await (await import("./research-materials")).researchMaterialInput(viewer.id, durable.materialIds, durable.research.idea);
  const budget = config.cloud ? new (await import("./budget/cloud-store")).CloudBudgetStore(pool, process.env.KELY_BUDGET_DESTINATION ?? "") : (await import("./budget/store")).BudgetStore.openDevelopment();
  const reservationInput = researchPackageInput(viewer.id, run.id, run.inputHash, durable.materialIds);
  const liveStore = new BrandIntelligenceStore(pool);
  if (run.status === "queued" && run.sources.length === 0) {
    const content = JSON.stringify({ research: durable.research, answers: durable.answers ?? [], materialIds: durable.materialIds });
    for (let start = 0, index = 0; start < content.length; start += 500, index += 1) {
      const end = Math.min(content.length, start + 500); const hex = createHash("sha256").update(`${run.id}:input:${index}`, "utf8").digest("hex").slice(0, 32);
      const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      await liveStore.addSource(viewer.id, run.id, evidenceRecordFromSpan({ id, sourceKind: "user", sourceRole: "user_provided", sourceUrl: `https://kely.invalid/research/${run.id}/input`, content, span: { start, end }, fetchedAt: run.createdAt }), "complete");
    }
  }
  const gateway = (await import("./providers/runtime")).providerGateway("openai");
  const reserved = await reserveResearchPackage(budget, viewer.id, run.id, run.inputHash, durable.materialIds);
  requireCondition(reserved.status === "active", "research_package_reservation_inactive", "Research package reservation is not active.", 409);
  const research = { ...durable.research, ...(durable.answers?.length ? { idea: `${durable.research.idea}\nOwner clarifications: ${durable.answers.map((item) => `${item.key}: ${item.value}`).join("; ")}` } : {}) };
  try {
    return await runLiveResearch(viewer.id, run.id, research, reservationInput, {
      store: liveStore, gateway, materialInput,
      resolvedAssetKeys: (durable.answers ?? []).filter((item) => item.code === "missing_asset").map((item) => item.key),
      async persistMaterialAnalysis(proposal, requestHash) {
        for (const observation of proposal.observations) {
          const selected = materialInput!.selected.find((item) => item.id === observation.materialId)!;
          const values = [viewer.id, run.id, selected.id, selected.version, selected.originalHash, selected.derivativeHash, selected.role, JSON.stringify(observation), requestHash];
          const inserted = await pool.query(`INSERT INTO brand_research_material(owner_id,run_id,material_id,material_version,original_hash,derivative_hash,role,observation,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(owner_id,run_id,material_id) DO NOTHING RETURNING material_id`, values);
          if (!inserted.rowCount) {
            const existing = (await pool.query("SELECT material_version,original_hash,derivative_hash,role,observation,request_hash FROM brand_research_material WHERE owner_id=$1 AND run_id=$2 AND material_id=$3", [viewer.id, run.id, selected.id])).rows[0];
            requireCondition(existing && existing.material_version === selected.version && existing.original_hash === selected.originalHash && existing.derivative_hash === selected.derivativeHash && existing.role === selected.role && JSON.stringify(existing.observation) === JSON.stringify(observation) && existing.request_hash === requestHash, "research_material_evidence_conflict", "Saved material analysis does not match this research run.", 409);
          }
        }
      },
      async verifyReservation(value) { requireCondition(value.id === reservationInput.id && value.scopeHash === reservationInput.scopeHash, "research_package_reservation_invalid", "Research package reservation does not match this run.", 409); },
      async search(input) { return dispatchEntitySearch(gateway, input); },
      async closeFromDurableEvidence() { await closeResearchPackageFromDurableEvidence(pool, budget, viewer.id, run.id, run.inputHash, durable.materialIds); },
    });
  } finally { if (!config.cloud && "close" in budget) budget.close(); }
}

export async function runResearchJob(ownerId: string, runId: string) {
  const store = new BrandIntelligenceStore(pool);
  const run = await store.read(ownerId, runId);
  if (run.status !== "queued") return;
  await defaultLiveExecutor({ id: ownerId, name: "", email: "" }, run, inputFromRun(run));
}

export const researchService = new ResearchService(undefined, undefined, defaultLiveExecutor, async (ownerId, runId) => {
  const { enqueueResearch } = await import("./queue");
  await enqueueResearch(ownerId, runId);
});
