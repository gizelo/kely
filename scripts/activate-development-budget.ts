import { DEVELOPMENT_BUDGET_ID } from "../src/server/budget/identity";
import { activateCanonicalBudget } from "./lib/budget-activation";

const expected = [`--confirm-first-activation=${DEVELOPMENT_BUDGET_ID}`, "--confirm-zero-prior-api-spend"];
if (process.argv.length !== 4 || !expected.every((value, index) => process.argv[index + 2] === value)) {
  console.error("Refused: this is a separate operator-only, one-time activation command. Follow the reviewed runbook; no files were touched.");
  process.exitCode = 1;
} else {
  try {
    const result = activateCanonicalBudget({ identity: DEVELOPMENT_BUDGET_ID, zeroPriorSpend: true });
    console.log(JSON.stringify({ status: "verified_unpinned", ...result, notice: "Record the proposed genesis with root. No pin, live approval, credential read or provider dispatch occurred." }, null, 2));
  } catch {
    console.error("Activation refused or incomplete. Preserve existing authority/receipt files for coordinator review. Do not rerun, remove, reset or overwrite them.");
    process.exitCode = 1;
  }
}
