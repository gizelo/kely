import { closeSync, constants, fsyncSync, fstatSync, lstatSync, openSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEVELOPMENT_BUDGET_CEILING_MICROS, DEVELOPMENT_BUDGET_ID } from "../../src/server/budget/identity";
import type { summarizeBudget } from "../../src/server/budget/status";

export function assertBenchmarkApproval(args: string[], approved: boolean, genesis: string | null) {
  if (!approved || !genesis || !/^[a-f0-9]{64}$/u.test(genesis) || args.length !== 1 || args[0] !== `--confirm-coordinator-benchmark=${DEVELOPMENT_BUDGET_ID}`) {
    throw new Error("Benchmark launch refused: separate coordinator code approval, pinned authority and exact confirmation are required.");
  }
}

export function assertBenchmarkBudget(status: ReturnType<typeof summarizeBudget>) {
  if (status.status !== "verified" || status.identity !== DEVELOPMENT_BUDGET_ID || status.purpose !== "development" || status.ceiling !== DEVELOPMENT_BUDGET_CEILING_MICROS || status.reserved !== 0 || status.uncertain !== status.settledBounded || status.dispatchingAttempts !== 0 || status.uncertainAttempts !== 0 || status.remaining <= 0) {
    throw new Error("Benchmark launch refused: the fixed development authority is unavailable, exhausted or requires reconciliation.");
  }
}

export function acquireBenchmarkLock(directory: string) {
  const parent = lstatSync(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0 || realpathSync(directory) !== directory) throw new Error("Benchmark lock directory is not private.");
  const path = join(directory, "live-benchmark.lock");
  const file = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  let identity: string;
  try {
    const stat = fstatSync(file);
    identity = `${stat.dev}:${stat.ino}`;
    writeFileSync(file, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
    fsyncSync(file);
  } finally { closeSync(file); }
  let released = false;
  return () => {
    if (released) return;
    const current = lstatSync(path);
    if (!current.isFile() || current.isSymbolicLink() || `${current.dev}:${current.ino}` !== identity) throw new Error("Benchmark lock changed; preserve it for coordinator review.");
    unlinkSync(path);
    released = true;
  };
}
