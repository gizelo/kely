import { developmentBudgetStatus } from "../src/server/budget/status";

if (process.argv.length !== 2) {
  console.error("Budget status accepts no path, key or override arguments.");
  process.exitCode = 1;
} else {
  try { console.log(JSON.stringify(developmentBudgetStatus(), null, 2)); }
  catch {
    console.error(JSON.stringify({ status: "unavailable", reason: "Canonical authority is unapproved, missing or invalid. Spending is closed; this is not a zero balance." }));
    process.exitCode = 1;
  }
}
