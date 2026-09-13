import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { delimiter, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DEVELOPMENT_BUDGET_DIRECTORY, DEVELOPMENT_BUDGET_GENESIS_HASH } from "../src/server/budget/identity";
import { developmentBudgetStatus } from "../src/server/budget/status";
import { approvedProviderCredential } from "../src/server/providers/credential";
import { assertLiveDispatchApproved } from "../src/server/providers/live-gate";
import { acquireBenchmarkLock, assertBenchmarkBudget } from "./lib/live-benchmark";

async function requireFreePort() {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen({ host: "127.0.0.1", port: 3130, exclusive: true }, () => probe.close(error => error ? reject(error) : resolve()));
  });
}

async function main() {
  if (process.argv.length !== 2) throw new Error("Unsupported launcher option.");
  process.env.KELY_PROVIDER_MODE = "openai";
  process.env.KELY_LIVE_ENABLED = "true";
  assertLiveDispatchApproved();
  if (!DEVELOPMENT_BUDGET_GENESIS_HASH || !/^[a-f0-9]{64}$/u.test(DEVELOPMENT_BUDGET_GENESIS_HASH)) throw new Error("Budget authority is not pinned.");
  assertBenchmarkBudget(developmentBudgetStatus());
  const releaseLock = acquireBenchmarkLock(DEVELOPMENT_BUDGET_DIRECTORY);
  const children: ChildProcess[] = [];
  let stopping = false;
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    for (const child of children) child.kill("SIGTERM");
    shutdownTimer = setTimeout(() => {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 5000);
    shutdownTimer.unref();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await requireFreePort();
    if (stopping) return;
    approvedProviderCredential();
    const environment = { ...process.env, PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter), NEXT_TELEMETRY_DISABLED: "1", WATCHPACK_POLLING: "1000" };
    const commands = [
      [fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url)), "dev", "--webpack", "--hostname", "127.0.0.1", "--port", "3130"],
      ["--import", "tsx", "src/server/worker.ts"],
    ];
    const exits = commands.map(args => {
      const child = spawn(process.execPath, args, { stdio: "inherit", env: environment });
      children.push(child);
      return new Promise<void>(resolve => {
        child.once("error", () => { process.exitCode = 1; stop(); });
        child.once("exit", code => { if (!stopping) { process.exitCode = code || 1; stop(); } });
        child.once("close", resolve);
      });
    });
    console.log("Kely: http://localhost:3130 — real generation is available within the remaining development allowance.");
    await Promise.all(exits);
  } finally {
    if (shutdownTimer) clearTimeout(shutdownTimer);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    releaseLock();
  }
}

main().catch(() => {
  console.error("Kely could not start. Check the coordinator gate, saved budget, existing runtime lock, API credential and port 3130. No fallback or automatic retry was started.");
  process.exitCode = 1;
});
