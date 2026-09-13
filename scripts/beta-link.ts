import { mkdir, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { issueBetaLink } from "../src/server/beta-access";
import { config } from "../src/server/config";
import { pool } from "../src/server/db";

async function main() {
  const [purpose, email, output] = process.argv.slice(2);
  if (!config.cloud || !["invite", "recover"].includes(purpose) || !email || !output) throw new Error("Use cloud configuration and beta-link.ts invite|recover email .local/beta-links/filename.txt");
  if (purpose === "invite" && (process.env.KELY_BETA_ACCESS_ENABLED !== "true" || !process.env.KELY_OPERATOR_NAME || !process.env.KELY_SUPPORT_EMAIL)) throw new Error("Confirm operator/privacy information and enable invitations first.");
  const root = resolve(".local/beta-links");
  const target = resolve(output);
  const name = relative(root, target);
  if (!name || name.includes("/") || name.startsWith("..")) throw new Error("Link output must be directly inside .local/beta-links.");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const token = await issueBetaLink(email, purpose as "invite" | "recover");
  await writeFile(target, `${config.baseUrl}/${purpose === "invite" ? "invite" : "recover"}#token=${token}\n`, { flag: "wx", mode: 0o600 });
  console.log("Private link saved to the requested local file. Deliver it privately; do not paste it in logs.");
}

main().catch(() => { console.error("Could not issue the private link. Check the command, available beta places and output file without printing secrets."); process.exitCode = 1; }).finally(() => pool.end());
