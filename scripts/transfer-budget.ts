import { open, readFile, stat } from "node:fs/promises";
import { Pool } from "pg";
import { BudgetStore, integrity } from "../src/server/budget/store";
import { CloudBudgetStore, type BudgetTransfer } from "../src/server/budget/cloud-store";
import { summarizeBudget } from "../src/server/budget/status";

async function main() {
const [command, filename, confirmation] = process.argv.slice(2);
const destination = process.env.KELY_BUDGET_DESTINATION ?? "";
if (!/^[a-zA-Z0-9_-]{16,120}$/.test(destination)) throw new Error("Set a unique KELY_BUDGET_DESTINATION before transfer.");

if (command === "preview" || command === "fence-export") {
  const budget = BudgetStore.openDevelopment();
  try {
    const history = budget.exportHistory();
    const hash = history.rows.at(-1)!.hash;
    console.log(JSON.stringify({ destination, hash, sequence: history.rows.length, budget: summarizeBudget(history.state) }));
    if (command === "fence-export") {
      integrity(confirmation === hash && Boolean(filename));
      const handle = await open(filename, "wx", 0o600);
      try {
        const fence = budget.fenceForTransfer(destination, confirmation);
        const current = budget.exportHistory();
        integrity(current.rows.at(-1)?.hash === fence.hash);
        await handle.writeFile(JSON.stringify({ ...fence, ...current } satisfies BudgetTransfer));
        await handle.sync();
      } finally { await handle.close(); }
      console.log("Local authority permanently fenced. Private export saved; cloud is not activated.");
    }
  } finally { budget.close(); }
} else {
  integrity(process.env.KELY_RUNTIME === "cloud" && Boolean(process.env.KELY_DATABASE_URL));
  const pool = new Pool({ connectionString: process.env.KELY_DATABASE_URL, max: 1 });
  try {
    const budget = new CloudBudgetStore(pool, destination);
    if (command === "import") {
      const metadata = await stat(filename);
      integrity(metadata.isFile() && (metadata.mode & 0o077) === 0 && metadata.size <= 200_000_000);
      const transfer = JSON.parse(await readFile(filename, "utf8")) as BudgetTransfer;
      integrity(confirmation === transfer.hash);
      console.log(JSON.stringify(summarizeBudget(await budget.importFencedHistory(transfer))));
      console.log("Imported and verified, still inactive.");
    } else if (command === "activate") {
      console.log(JSON.stringify(summarizeBudget(await budget.activate(filename))));
    } else if (command === "status") {
      console.log(JSON.stringify(summarizeBudget(await budget.inspect())));
    } else throw new Error("Use preview, fence-export <private-file> <head-hash>, import <private-file> <head-hash>, activate <head-hash>, or status.");
  } finally { await pool.end(); }
}
}

main().catch(() => { console.error("Budget transfer failed; preserve all history and fences for coordinator review."); process.exitCode = 1; });
