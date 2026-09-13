import { PgBoss } from "pg-boss";
import { config } from "./config";
import { pool } from "./db";

export const QUEUE_NAME = "kely-fixture-operations";
let bossPromise: Promise<PgBoss> | undefined;

export function getBoss() {
  if (!bossPromise) {
    bossPromise = (async () => {
      const boss = new PgBoss({ connectionString: config.databaseUrl, schema: "kely_queue" });
      boss.on("error", () => console.error("Kely queue connection error; persisted operations are preserved."));
      await boss.start();
      await boss.createQueue(QUEUE_NAME, { retryLimit: 0, expireInSeconds: 120 });
      return boss;
    })().catch((error) => { bossPromise = undefined; throw error; });
  }
  return bossPromise;
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
}
