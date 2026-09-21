import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "../src/server/config";
import { pool } from "../src/server/db";
import { createTestAccount, grantTestAllowance, revokeTestAllowance } from "../src/server/operator-access";

function args() {
  const [action, ...rest] = process.argv.slice(2);
  const values = Object.fromEntries(rest.map((part) => {
    const match = /^--([^=]+)=(.*)$/u.exec(part);
    if (!match) throw new Error("Use named --key=value arguments.");
    return [match[1], match[2]];
  }));
  return { action, values };
}

async function main() {
  if (!config.cloud) throw new Error("Operator access commands require cloud configuration.");
  const { action, values } = args();
  if (action === "create") {
    if (!values.email || !values.name || !values.passwordFile || !values.commandKey) throw new Error("Create requires email, name, passwordFile and commandKey.");
    const passwordPath = resolve(values.passwordFile);
    const password = (await readFile(passwordPath, { encoding: "utf8" })).trimEnd();
    const result = await createTestAccount({ email: values.email, name: values.name, password, commandKey: values.commandKey });
    console.log(`Test account ${result.created ? "created" : "already created by this command"}; owner ${result.ownerId}. Password was not printed.`);
  } else if (action === "grant") {
    const result = await grantTestAllowance({ email: values.email, tier: values.tier, commandKey: values.commandKey });
    console.log(`Test allowance ${result.granted ? "granted" : "already granted by this command"}; owner ${result.ownerId}.`);
  } else if (action === "revoke") {
    const result = await revokeTestAllowance({ email: values.email, commandKey: values.commandKey });
    console.log(`Test allowance ${result.revoked ? "revoked" : "already revoked by this command"}; owner ${result.ownerId}.`);
  } else throw new Error("Use create, grant or revoke.");
}

main().catch(() => { console.error("Operator access command failed. Check its named arguments and cloud database access; no secret was printed."); process.exitCode = 1; }).finally(() => pool.end());
