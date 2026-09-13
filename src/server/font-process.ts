import { spawn } from "node:child_process";
import path from "node:path";
import type { ApprovedTextLayoutInput, MeasuredTextLayout } from "./layout";
import { rendererProjectRoot } from "./renderer-root";

const worker = path.join(rendererProjectRoot!, "scripts/font-worker.ts");
const loader = path.join(rendererProjectRoot!, "node_modules/tsx/dist/loader.mjs");
const maximumResponse = 12 * 1024 * 1024;

export async function isolatedTextLayout(input: ApprovedTextLayoutInput): Promise<MeasuredTextLayout> {
  const request = JSON.stringify(input);
  if (Buffer.byteLength(request) > 64 * 1024) throw new RangeError("Typography request exceeds its bounded input.");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", loader, worker], {
      env: { NODE_ENV: "production", PATH: path.dirname(process.execPath), PANGOCAIRO_BACKEND: "fontconfig", KELY_FONT_WORKER: "1" },
      stdio: ["pipe", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let finished = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (error: Error) => {
      if (finished) return;
      finished = true; clearTimeout(timer); child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 500);
      killTimer.unref(); reject(error);
    };
    const timer = setTimeout(() => stop(new Error("Local typography exceeded its time limit; no text was shortened.")), 15_000);
    child.on("error", () => stop(new Error("The local typography process could not start.")));
    child.stdin.on("error", () => stop(new Error("The local typography request could not be delivered.")));
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maximumResponse) stop(new Error("Local typography exceeded its output bound."));
      else chunks.push(chunk);
    });
    child.on("close", (code) => {
      if (killTimer) clearTimeout(killTimer);
      if (finished) return;
      finished = true; clearTimeout(timer);
      try {
        if (code !== 0) throw new Error("The local typography worker failed.");
        const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (result.error) {
          const error = new Error(result.error.message);
          Object.assign(error, result.error);
          reject(error); return;
        }
        if (result.approvedText !== input.text || typeof result.png !== "string") throw new Error("Local typography returned inconsistent output.");
        resolve({ ...result, png: Buffer.from(result.png, "base64") });
      } catch { reject(new Error("The local typography response could not be verified.")); }
    });
    child.stdin.end(request);
  });
}
