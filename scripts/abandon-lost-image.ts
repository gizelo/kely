import { DEVELOPMENT_BUDGET_ID } from "../src/server/budget/identity";
import { LIVE_PROVIDER_DISPATCH_APPROVED } from "../src/server/providers/live-gate";

async function main() {
  const values = new Map<string, string>();
  for (const arg of process.argv.slice(2)) {
    const match = /^--(owner|operation|request-id|confirm-authority|plan|mode)=(.+)$/u.exec(arg);
    if (!match || values.has(match[1])) throw new Error("Invalid closure arguments.");
    values.set(match[1], match[2]);
  }
  const mode = values.get("mode");
  if (values.get("confirm-authority") !== DEVELOPMENT_BUDGET_ID || !["dry-run", "apply"].includes(mode ?? "") || !values.get("owner") || !values.get("operation") || !values.get("request-id") || (mode === "apply" ? !/^[a-f0-9]{64}$/u.test(values.get("plan") ?? "") : values.has("plan")) || LIVE_PROVIDER_DISPATCH_APPROVED || process.env.KELY_LIVE_ENABLED === "true" || process.env.KELY_PROVIDER_MODE === "openai") throw new Error("Closure needs exact coordinator targets and a closed live gate.");
  const { BudgetStore } = await import("../src/server/budget/store");
  const { pool } = await import("../src/server/db");
  try {
    const budget = BudgetStore.openDevelopment();
    try {
      const { abandonLostImageCreation } = await import("../src/server/abandon-creation");
      const result = await abandonLostImageCreation({ ownerId: values.get("owner")!, operationId: values.get("operation")!, requestId: values.get("request-id")! }, budget, mode === "apply" ? { applyPlan: values.get("plan") } : {});
      console.log(JSON.stringify(result, null, 2));
    } finally { budget.close(); }
  } finally { await pool.end(); }
}

main().catch(() => {
  console.error("Image-failure closure refused or incomplete. Preserve both authorities and the exact dry-run plan. No provider retry, spending reset or image recovery was performed. Root must review any partial closure before applying that same plan again.");
  process.exitCode = 1;
});
