import { pool } from "./db";
import { getBoss, QUEUE_NAME, RESEARCH_QUEUE_NAME, repairQueuedOperations } from "./queue";
import { runOperation } from "./generation-operations";
import { generationMode } from "./config";
import { runResearchJob } from "./research-service";

let started = false;

export async function startWorker() {
  if (started) throw new Error("Kely worker is already running in this process.");
  started = true;
  const boss = await getBoss();
  try {
    await repairQueuedOperations();
    await boss.work<{ operationId: string }>(QUEUE_NAME, { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds: 1 }, async (jobs) => {
      for (const job of jobs) await runOperation(job.data.operationId);
    });
    await boss.work<{ ownerId: string; runId: string }>(RESEARCH_QUEUE_NAME, { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds: 1 }, async (jobs) => {
      for (const job of jobs) await runResearchJob(job.data.ownerId, job.data.runId);
    });
    const repair = setInterval(() => { void repairQueuedOperations().catch(() => console.error("Kely queue recovery will retry persisted operations.")); }, 15_000);
    const mode = generationMode();
    console.log(`Kely worker ready. New-operation mode: ${mode}. ${mode === "openai" ? "Only approved, externally reserved text requests may dispatch." : "External AI calls are disabled."}`);
    let stopping = false;
    return async function stop() {
      if (stopping) return;
      stopping = true;
      clearInterval(repair);
      await boss.stop({ graceful: true });
    };
  } catch (error) {
    started = false;
    await boss.stop({ graceful: false }).catch(() => undefined);
    throw error;
  }
}
