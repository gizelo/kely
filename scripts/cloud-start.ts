import { spawn, type ChildProcess } from "node:child_process";
import { config, generationMode } from "../src/server/config";
import { CloudBudgetStore } from "../src/server/budget/cloud-store";
import { pool } from "../src/server/db";
import { assertSchemaReady } from "./lib/schema-ready";

const children: ChildProcess[] = [];
let stopping = false;
let startupStage = "configuration";

function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  const deadline = setTimeout(() => { for (const child of children) child.kill("SIGKILL"); }, 15_000);
  deadline.unref();
}

async function main() {
  if (!config.cloud) throw new Error("The hosted launcher requires cloud configuration.");
  startupStage = "schema readiness";
  await assertSchemaReady(pool);
  console.log("Kely cloud schema is ready.");
  if (generationMode() === "openai") {
    startupStage = "budget readiness";
    const budget = new CloudBudgetStore(pool, process.env.KELY_BUDGET_DESTINATION ?? "");
    await budget.inspect();
    console.log("Kely cloud budget is ready.");
  }
  startupStage = "process launch";
  await pool.end();
  console.log("Kely cloud startup checks are complete.");
  const port = Number(process.env.PORT ?? 10000);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid web port.");
  const commands = [
    ["node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0", "--port", String(port)],
    ["--import", "tsx", "src/server/worker.ts"],
  ];
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  await Promise.all(commands.map(args => new Promise<void>(resolve => {
    const child = spawn(process.execPath, args, { stdio: "inherit", env: process.env });
    children.push(child);
    child.once("error", () => { process.exitCode = 1; stop(); resolve(); });
    child.once("exit", code => { if (!stopping) { process.exitCode = code || 1; stop(); } resolve(); });
  })));
}

main().catch(error => {
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? ` (${error.code})`
    : "";
  const detail = error instanceof Error && /^Database migration (?:is missing|checksum differs): \d{3}_[a-z_]+\.sql\.$/.test(error.message)
    ? ` ${error.message}`
    : "";
  console.error(`Kely cloud startup stopped during ${startupStage}${code}.${detail} No credentials are logged.`);
  process.exitCode = 1;
  stop();
});
