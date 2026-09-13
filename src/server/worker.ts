import { pool } from "./db";
import { getBoss, QUEUE_NAME, repairQueuedOperations } from "./queue";
import { runOperation } from "./generation-operations";
import { generationMode } from "./config";

async function main() {
  const boss = await getBoss();
  await repairQueuedOperations();
  await boss.work<{ operationId: string }>(QUEUE_NAME, { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds: 1 }, async (jobs) => {
    for (const job of jobs) await runOperation(job.data.operationId);
  });
  const repair = setInterval(() => { void repairQueuedOperations().catch(() => console.error("Kely queue recovery will retry persisted operations.")); }, 15_000);
  const mode = generationMode();
  console.log(`Kely worker ready. New-operation mode: ${mode}. ${mode === "openai" ? "Only approved, externally reserved text requests may dispatch." : "External AI calls are disabled."}`);
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    clearInterval(repair);
    await boss.stop({ graceful: true });
    await pool.end();
  }
  process.on("SIGINT", () => { void stop(); });
  process.on("SIGTERM", () => { void stop(); });
}

main().catch(() => { console.error("Kely worker could not start. Check local migration, mode and runtime readiness without exposing credentials."); process.exitCode = 1; });
