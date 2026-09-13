import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { AppError } from "../errors";
import { assertLiveDispatchApproved } from "./live-gate";

export function approvedProviderCredential(): string {
  assertLiveDispatchApproved();
  try {
    let key = process.env.OPENAI_API_KEY;
    if (!key) {
      const file = openSync(resolve(".env.local"), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(file);
        if (!stat.isFile() || stat.size > 65_536 || stat.uid !== process.getuid?.()) throw new Error("Invalid credential file.");
        key = parseEnv(readFileSync(file, "utf8")).OPENAI_API_KEY;
      } finally { closeSync(file); }
    }
    if (!key || key.length > 1000 || /[\r\n]/u.test(key)) throw new Error("Credential unavailable.");
    return key;
  } catch {
    throw new AppError("provider_unavailable", "The approved worker credential is unavailable. Ask the local coordinator to check private runtime setup; no provider request was sent.", 503);
  }
}
