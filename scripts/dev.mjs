import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const preview = process.argv.includes("--ai-preview");
if (process.argv.slice(2).some((arg) => arg !== "--ai-preview")) throw new Error("Only --ai-preview is supported. Live dispatch remains disabled.");
const mode = preview ? "ai_preview" : "fixture";
const environment = { ...process.env, KELY_PROVIDER_MODE: mode, KELY_LIVE_ENABLED: "false", NEXT_TELEMETRY_DISABLED: "1", WATCHPACK_POLLING: "1000" };
if (preview) {
  const setup = spawn(process.execPath, ["--import", "tsx", "scripts/prepare-preview.ts"], { stdio: "inherit", env: environment });
  const code = await new Promise((resolve) => setup.on("exit", resolve));
  if (code !== 0) process.exit(1);
}
const children = [
  spawn(process.execPath, [fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url)), "dev", "--webpack", "--hostname", "127.0.0.1", "--port", "3130"], { stdio: "inherit", env: environment }),
  spawn(process.execPath, ["--import", "tsx", "src/server/worker.ts"], { stdio: "inherit", env: environment }),
];

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const child of children) child.on("exit", (code) => { if (!stopping) { process.exitCode = code ?? 1; stop(); } });
console.log(`Kely ${mode}: http://localhost:3130 — real AI and real billing are disabled.`);
