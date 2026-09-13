import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { delimiter, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DEVELOPMENT_BUDGET_DIRECTORY, DEVELOPMENT_BUDGET_GENESIS_HASH } from "../src/server/budget/identity";
import { developmentBudgetStatus } from "../src/server/budget/status";
import { approvedProviderCredential } from "../src/server/providers/credential";
import { LIVE_PROVIDER_DISPATCH_APPROVED } from "../src/server/providers/live-gate";
import { acquireBenchmarkLock, assertBenchmarkApproval, assertBenchmarkBudget } from "./lib/live-benchmark";

async function requireFreePort() {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen({ host: "127.0.0.1", port: 3130, exclusive: true }, () => probe.close((error) => error ? reject(error) : resolve()));
  });
}

async function main() {
  assertBenchmarkApproval(process.argv.slice(2), LIVE_PROVIDER_DISPATCH_APPROVED, DEVELOPMENT_BUDGET_GENESIS_HASH);
  const status = developmentBudgetStatus();
  assertBenchmarkBudget(status);
  const releaseLock = acquireBenchmarkLock(DEVELOPMENT_BUDGET_DIRECTORY);
  const children: ChildProcess[] = [];
  let stopping = false;
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    for (const child of children) child.kill("SIGTERM");
    shutdownTimer = setTimeout(() => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 5000);
    shutdownTimer.unref();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await requireFreePort();
    if (stopping) return;
    process.env.KELY_PROVIDER_MODE = "openai";
    process.env.KELY_LIVE_ENABLED = "true";
    approvedProviderCredential();
    const environment = { ...process.env, PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter), NEXT_TELEMETRY_DISABLED: "1", WATCHPACK_POLLING: "1000" };
    console.log(JSON.stringify({ event: "coordinator_benchmark_start", budget: status }));
    const commands = [
      [fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url)), "dev", "--hostname", "127.0.0.1", "--port", "3130"],
      ["--import", "tsx", "src/server/worker.ts"],
    ];
    const exits = commands.map((args) => {
      const child = spawn(process.execPath, args, { stdio: "inherit", env: environment });
      children.push(child);
      return new Promise<void>((resolve) => {
        child.once("error", () => { process.exitCode = 1; stop(); });
        child.once("exit", (code) => { if (!stopping) { process.exitCode = code || 1; stop(); } });
        child.once("close", resolve);
      });
    });
    console.log("Kely coordinator benchmark: http://localhost:3130 — real text may incur API spend after accepted UI quotes. Images and real billing remain disabled. No automatic restart or provider retry.");
    await Promise.all(exits);
  } finally {
    if (shutdownTimer) clearTimeout(shutdownTimer);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    releaseLock();
  }
}

main().catch(() => {
  console.error("Benchmark launch stopped or refused. Check coordinator approval, verified budget status, private credential availability, port 3130 and any existing benchmark lock. No reset, repair or automatic retry was performed.");
  process.exitCode = 1;
});
