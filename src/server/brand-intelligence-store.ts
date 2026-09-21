import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { BrandEvidenceRecord, BrandIntelligenceSnapshot, ResearchStage } from "../shared/brand-intelligence";
import { AppError, requireCondition } from "./errors";

export type ResearchStatus = ResearchStage;
export type SourceOutcome = "complete" | "partial" | "failed";

export interface ResearchRunView {
  id: string;
  ownerId: string;
  commandKey: string;
  inputHash: string;
  input: unknown;
  supersedesRunId: string | null;
  status: ResearchStatus;
  statusDetail: unknown;
  createdAt: string;
  sources: (BrandEvidenceRecord & { outcome: SourceOutcome })[];
  snapshots: { id: string; version: number; hash: string; value: BrandIntelligenceSnapshot; supersedesSnapshotId: string | null; acceptedAt: string }[];
}

function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}

function hashJson(value: unknown) {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

const TRANSITIONS: Record<ResearchStatus, ReadonlySet<ResearchStatus>> = {
  queued: new Set(["resolving", "failed"]), resolving: new Set(["fetching", "needs_input", "partial", "failed", "uncertain"]),
  fetching: new Set(["extracting", "partial", "failed", "uncertain"]), extracting: new Set(["strategizing", "needs_input", "partial", "failed", "uncertain"]),
  strategizing: new Set(["checking", "needs_input", "partial", "failed", "uncertain"]), checking: new Set(["review_ready", "needs_input", "partial", "failed", "uncertain"]),
  review_ready: new Set(), needs_input: new Set(["strategizing", "failed"]), partial: new Set(["strategizing", "checking", "review_ready", "failed"]), failed: new Set(), uncertain: new Set(),
};

export function researchStatusCanTransition(from: ResearchStatus, to: ResearchStatus) {
  return TRANSITIONS[from].has(to);
}

async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export class BrandIntelligenceStore {
  constructor(private readonly pool: Pool) {}

  async start(ownerId: string, input: unknown, commandKey: string, supersedesRunId: string | null = null): Promise<ResearchRunView> {
    requireCondition(commandKey.length >= 8 && commandKey.length <= 100, "command_key_invalid", "Research command key must contain 8–100 characters.");
    const serialized = stableJson(input);
    requireCondition(Buffer.byteLength(serialized) <= 32768, "research_input_too_large", "Research input is too large.");
    const inputHash = hashJson(input);
    const id = await inTransaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${ownerId}:${commandKey}`]);
      const prior = (await client.query("SELECT id,input_hash,supersedes_run_id FROM brand_research_run WHERE owner_id=$1 AND command_key=$2", [ownerId, commandKey])).rows[0];
      if (prior) {
        requireCondition(prior.input_hash === inputHash && prior.supersedes_run_id === supersedesRunId, "idempotency_conflict", "That research command key belongs to different inputs.", 409);
        return prior.id as string;
      }
      if (supersedesRunId) requireCondition((await client.query("SELECT 1 FROM brand_research_run WHERE owner_id=$1 AND id=$2", [ownerId, supersedesRunId])).rowCount, "research_not_found", "The research run to correct was not found.", 404);
      const runId = randomUUID();
      await client.query("INSERT INTO brand_research_run(id,owner_id,command_key,input_hash,input,supersedes_run_id) VALUES($1,$2,$3,$4,$5,$6)", [runId, ownerId, commandKey, inputHash, serialized, supersedesRunId]);
      await client.query("INSERT INTO brand_research_event(id,owner_id,run_id,status) VALUES($1,$2,$3,'queued')", [randomUUID(), ownerId, runId]);
      return runId;
    });
    return this.read(ownerId, id);
  }

  async appendStatus(ownerId: string, runId: string, status: ResearchStatus, detail: unknown = {}): Promise<ResearchRunView> {
    const serialized = stableJson(detail);
    requireCondition(Buffer.byteLength(serialized) <= 8192, "research_detail_too_large", "Research status detail is too large.");
    await inTransaction(this.pool, async (client) => {
      requireCondition((await client.query("SELECT 1 FROM brand_research_run WHERE owner_id=$1 AND id=$2", [ownerId, runId])).rowCount, "research_not_found", "Research run not found.", 404);
      const current = (await client.query("SELECT status FROM brand_research_event WHERE owner_id=$1 AND run_id=$2 ORDER BY sequence DESC LIMIT 1 FOR UPDATE", [ownerId, runId])).rows[0]?.status as ResearchStatus | undefined;
      requireCondition(current && researchStatusCanTransition(current, status), "research_transition_invalid", `Research cannot move from ${current ?? "unknown"} to ${status}.`, 409);
      await client.query("INSERT INTO brand_research_event(id,owner_id,run_id,status,detail) VALUES($1,$2,$3,$4,$5)", [randomUUID(), ownerId, runId, status, serialized]);
    });
    return this.read(ownerId, runId);
  }

  async addSource(ownerId: string, runId: string, evidence: BrandEvidenceRecord, outcome: SourceOutcome): Promise<ResearchRunView> {
    await inTransaction(this.pool, async (client) => {
      requireCondition((await client.query("SELECT 1 FROM brand_research_run WHERE owner_id=$1 AND id=$2", [ownerId, runId])).rowCount, "research_not_found", "Research run not found.", 404);
      await client.query(
        "INSERT INTO brand_research_source(id,owner_id,run_id,source_kind,source_role,source_url,excerpt,excerpt_start,excerpt_end,content_hash,fetched_at,outcome) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
        [evidence.id, ownerId, runId, evidence.sourceKind, evidence.sourceRole, evidence.sourceUrl, evidence.excerpt, evidence.span.start, evidence.span.end, evidence.contentHash, evidence.fetchedAt, outcome],
      );
    });
    return this.read(ownerId, runId);
  }

  async acceptSnapshot(ownerId: string, runId: string, snapshot: BrandIntelligenceSnapshot, supersedesSnapshotId: string | null = null) {
    requireCondition(snapshot.schemaVersion === "brand-intelligence.v1", "snapshot_schema_invalid", "Unsupported brand intelligence snapshot.");
    const row = await inTransaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${ownerId}:${runId}:snapshot`]);
      requireCondition((await client.query("SELECT 1 FROM brand_research_run WHERE owner_id=$1 AND id=$2", [ownerId, runId])).rowCount, "research_not_found", "Research run not found.", 404);
      if (supersedesSnapshotId) requireCondition((await client.query("SELECT 1 FROM brand_research_snapshot WHERE owner_id=$1 AND run_id=$2 AND id=$3", [ownerId, runId, supersedesSnapshotId])).rowCount, "snapshot_not_found", "Snapshot to correct was not found.", 404);
      const persisted = (await client.query("SELECT id,source_kind,source_role,source_url,excerpt,excerpt_start,excerpt_end,content_hash,fetched_at FROM brand_research_source WHERE owner_id=$1 AND run_id=$2 ORDER BY id", [ownerId, runId])).rows;
      const expected = [...snapshot.evidence].sort((a, b) => a.id.localeCompare(b.id));
      requireCondition(persisted.length === expected.length && persisted.every((item, index) => {
        const value = expected[index]; return item.id === value.id && item.source_kind === value.sourceKind && item.source_role === value.sourceRole && item.source_url === value.sourceUrl && item.excerpt === value.excerpt && item.excerpt_start === value.span.start && item.excerpt_end === value.span.end && item.content_hash === value.contentHash && new Date(item.fetched_at).toISOString() === value.fetchedAt;
      }), "snapshot_evidence_mismatch", "Snapshot evidence does not match persisted research evidence.", 409);
      const prior = (await client.query("SELECT id,version,snapshot_hash,supersedes_snapshot_id,snapshot FROM brand_research_snapshot WHERE owner_id=$1 AND run_id=$2 ORDER BY version DESC LIMIT 1", [ownerId, runId])).rows[0];
      if (prior && prior.supersedes_snapshot_id === supersedesSnapshotId) {
        const priorContent = { ...prior.snapshot, id: snapshot.id, version: snapshot.version };
        if (stableJson(priorContent) === stableJson(snapshot)) return prior;
      }
      const value = { id: randomUUID(), version: Number(prior?.version ?? 0) + 1 };
      const persistedSnapshot = { ...snapshot, id: value.id, version: value.version };
      const serialized = stableJson(persistedSnapshot); const hash = hashJson(persistedSnapshot);
      requireCondition(Buffer.byteLength(serialized) <= 131072, "snapshot_too_large", "Brand intelligence snapshot is too large.");
      await client.query("INSERT INTO brand_research_snapshot(id,owner_id,run_id,version,snapshot_hash,snapshot,supersedes_snapshot_id) VALUES($1,$2,$3,$4,$5,$6,$7)", [value.id, ownerId, runId, value.version, hash, serialized, supersedesSnapshotId]);
      return { ...value, snapshot_hash: hash };
    });
    return { id: row.id as string, version: Number(row.version), hash: row.snapshot_hash as string };
  }

  async read(ownerId: string, runId: string): Promise<ResearchRunView> {
    const run = (await this.pool.query(
      `SELECT r.*,e.status,e.detail status_detail
       FROM brand_research_run r
       JOIN LATERAL (SELECT status,detail FROM brand_research_event WHERE owner_id=r.owner_id AND run_id=r.id ORDER BY sequence DESC LIMIT 1) e ON true
       WHERE r.owner_id=$1 AND r.id=$2`, [ownerId, runId],
    )).rows[0];
    if (!run) throw new AppError("research_not_found", "Research run not found.", 404);
    const sources = (await this.pool.query("SELECT * FROM brand_research_source WHERE owner_id=$1 AND run_id=$2 ORDER BY created_at,id", [ownerId, runId])).rows;
    const snapshots = (await this.pool.query("SELECT * FROM brand_research_snapshot WHERE owner_id=$1 AND run_id=$2 ORDER BY version", [ownerId, runId])).rows;
    return {
      id: run.id, ownerId: run.owner_id, commandKey: run.command_key, inputHash: run.input_hash, input: run.input,
      supersedesRunId: run.supersedes_run_id, status: run.status, statusDetail: run.status_detail, createdAt: new Date(run.created_at).toISOString(),
      sources: sources.map((item) => ({ id: item.id, sourceKind: item.source_kind, sourceRole: item.source_role ?? "official", sourceUrl: item.source_url, excerpt: item.excerpt, span: { start: item.excerpt_start ?? 0, end: item.excerpt_end ?? item.excerpt.length }, contentHash: item.content_hash, fetchedAt: new Date(item.fetched_at).toISOString(), outcome: item.outcome })),
      snapshots: snapshots.map((item) => ({ id: item.id, version: item.version, hash: item.snapshot_hash, value: item.snapshot, supersedesSnapshotId: item.supersedes_snapshot_id, acceptedAt: new Date(item.accepted_at).toISOString() })),
    };
  }
}
