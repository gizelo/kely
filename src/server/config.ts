import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { GenerationOrigin } from "../shared/contracts";
import { secureDatabaseUrl } from "./database-url";
import { assertLiveDispatchApproved } from "./providers/live-gate";
import { runtimeSettings } from "./runtime-settings";

export function assertFixtureMode() {
  if ((process.env.KELY_PROVIDER_MODE ?? "fixture") !== "fixture" || process.env.KELY_LIVE_ENABLED === "true") {
    throw new Error("This local milestone supports fixture mode only. Live providers are disabled.");
  }
}

export function generationMode(): GenerationOrigin {
  const mode = process.env.KELY_PROVIDER_MODE ?? "fixture";
  if (mode === "openai") { assertLiveDispatchApproved(); return "openai"; }
  if (!["fixture", "ai_preview"].includes(mode) || process.env.KELY_LIVE_ENABLED === "true") throw new Error("Unsupported or unapproved generation mode.");
  return mode as GenerationOrigin;
}

generationMode();
const settings = runtimeSettings(process.env);
const databaseUrl = process.env.KELY_DATABASE_URL ?? "postgresql://kely:kely_local_only@127.0.0.1:55432/kely_fixture";
export const config = {
  databaseUrl: secureDatabaseUrl(databaseUrl, settings.cloud),
  baseUrl: settings.baseUrl,
  cloud: settings.cloud,
  origins: settings.origins,
  assetRoot: path.resolve(".local/assets"),
  fixture: !settings.cloud,
};

export function localAuthSecret() {
  if (config.cloud) return process.env.KELY_AUTH_SECRET!;
  const root = path.resolve(".local/runtime");
  const filename = path.join(root, "auth-secret");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(filename, randomBytes(48).toString("base64url"), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return readFileSync(filename, "utf8");
}
