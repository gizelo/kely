import { PgBoss } from "pg-boss";
import { config } from "./config";
import { pool } from "./db";

export const QUEUE_NAME = "kely-fixture-operations";
export const RESEARCH_QUEUE_NAME = "kely-brand-research";
let bossPromise: Promise<PgBoss> | undefined;

export function getBoss() {
  if (!bossPromise) {
    bossPromise = (async () => {
      const boss = new PgBoss({ connectionString: config.databaseUrl, schema: "kely_queue" });
      boss.on("error", () => console.error("Kely queue connection error; persisted operations are preserved."));
      await boss.start();
      await boss.createQueue(QUEUE_NAME, { retryLimit: 0, expireInSeconds: 120 });
      await boss.createQueue(RESEARCH_QUEUE_NAME, { retryLimit: 0, expireInSeconds: 600 });
      return boss;
    })().catch((error) => { bossPromise = undefined; throw error; });
  }
  return bossPromise;
}

export async function enqueueResearch(ownerId: string, runId: string) {
  const { rows: [run] } = await pool.query("SELECT status FROM brand_research_run r JOIN LATERAL (SELECT status FROM brand_research_event WHERE run_id=r.id ORDER BY sequence DESC LIMIT 1) e ON true WHERE r.id=$1 AND r.owner_id=$2", [runId, ownerId]);
  if (!run || run.status !== "queued") return;
  const boss = await getBoss();
  await boss.send(RESEARCH_QUEUE_NAME, { ownerId, runId }, { singletonKey: runId, retryLimit: 0, expireInSeconds: 600 });
}

export async function enqueueOperation(operationId: string) {
  const { rows: [operation] } = await pool.query("SELECT status,queue_id FROM operation WHERE id=$1", [operationId]);
  if (!operation || !["queued", "running"].includes(operation.status)) return;
  const boss = await getBoss();
  const queueId = await boss.send(QUEUE_NAME, { operationId }, { singletonKey: operationId, retryLimit: 0, expireInSeconds: 120 });
  if (queueId) await pool.query("UPDATE operation SET queue_id=$2 WHERE id=$1", [operationId, queueId]);
}

export async function repairQueuedOperations() {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM operation WHERE status IN ('queued','running') ORDER BY created_at LIMIT 100");
  for (const row of rows) await enqueueOperation(row.id);
  const research = await pool.query<{ id: string; owner_id: string }>("SELECT r.id,r.owner_id FROM brand_research_run r JOIN LATERAL (SELECT status FROM brand_research_event WHERE run_id=r.id ORDER BY sequence DESC LIMIT 1) e ON true WHERE e.status='queued' ORDER BY r.created_at LIMIT 100");
  for (const row of research.rows) await enqueueResearch(row.owner_id, row.id);
}
