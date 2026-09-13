import { DEVELOPMENT_BUDGET_ID } from "../src/server/budget/identity";
import { LIVE_PROVIDER_DISPATCH_APPROVED } from "../src/server/providers/live-gate";

async function main() {
  const values = new Map<string, string>();
  for (const arg of process.argv.slice(2)) {
    const match = /^--(owner|operation|request-id|confirm-authority|plan|mode)=(.+)$/u.exec(arg);
    if (!match || values.has(match[1])) throw new Error("Invalid recovery arguments.");
    values.set(match[1], match[2]);
  }
  const mode = values.get("mode");
  if (values.get("confirm-authority") !== DEVELOPMENT_BUDGET_ID || !["dry-run", "apply"].includes(mode ?? "") || !values.get("owner") || !values.get("operation") || !values.get("request-id") || (mode === "apply" ? !/^[a-f0-9]{64}$/u.test(values.get("plan") ?? "") : values.has("plan")) || LIVE_PROVIDER_DISPATCH_APPROVED || process.env.KELY_LIVE_ENABLED === "true" || process.env.KELY_PROVIDER_MODE === "openai") throw new Error("Recovery needs exact coordinator targets and a closed live gate.");
  const { BudgetStore } = await import("../src/server/budget/store");
  const { pool } = await import("../src/server/db");
  try {
    const budget = BudgetStore.openDevelopment();
    try {
      const { recoverFirstQuotaRejection } = await import("../src/server/rejection-recovery");
      const result = await recoverFirstQuotaRejection({ ownerId: values.get("owner")!, operationId: values.get("operation")!, requestId: values.get("request-id")! }, budget, mode === "apply" ? { applyPlan: values.get("plan") } : {});
      console.log(JSON.stringify(result, null, 2));
    } finally { budget.close(); }
  } finally { await pool.end(); }
}

main().catch(() => {
  console.error("Quota recovery refused or incomplete. Preserve both authorities and the dry-run plan. The command neither retries a provider nor resets spending. Root must inspect the exact rejection, migration, ownership and any intervening application changes before retrying this same recovery.");
  process.exitCode = 1;
});
