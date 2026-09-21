import { pool } from "../src/server/db";
import { startWorker } from "../src/server/worker";

let stopWorker: (() => Promise<void>) | undefined;
let stopping = false;

async function stop() {
  if (stopping) return;
  stopping = true;
  await stopWorker?.();
  await pool.end();
}

startWorker().then((stop) => {
  stopWorker = stop;
  process.on("SIGINT", () => { void stop().catch(() => console.error("Kely worker cleanup did not finish cleanly.")); });
  process.on("SIGTERM", () => { void stop().catch(() => console.error("Kely worker cleanup did not finish cleanly.")); });
}).catch(() => {
  console.error("Kely worker could not start. Check local migration, mode and runtime readiness without exposing credentials.");
  process.exitCode = 1;
});
