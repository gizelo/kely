import path from "node:path";

export const DEVELOPMENT_BUDGET_ID = "kely-development-2026-09-10-v1";
export const DEVELOPMENT_BUDGET_DIRECTORY = "/Users/robertgizelo/Library/Application Support/Kely/development-budget";
export const DEVELOPMENT_BUDGET_ACTIVATION_RECORD = "/Users/robertgizelo/Library/Application Support/Kely/development-budget.activation.jsonl";
export const DEVELOPMENT_BUDGET_CEILING_MICROS = 10_000_000;
export const DEVELOPMENT_BUDGET_GENESIS_HASH: string | null = "143c0500d069a442651adc6532536bd396942521ea6e5fc71fc5ffc73c944ba7";

export type BudgetLocation = { directory: string; id: string; purpose: "development" | "fake" };

export const developmentBudgetLocation: BudgetLocation = Object.freeze({
  directory: DEVELOPMENT_BUDGET_DIRECTORY, id: DEVELOPMENT_BUDGET_ID, purpose: "development",
});

export function budgetFiles(location: BudgetLocation) {
  if (location.purpose === "development") {
    if (location.directory !== DEVELOPMENT_BUDGET_DIRECTORY || location.id !== DEVELOPMENT_BUDGET_ID) throw new Error("Invalid canonical budget identity.");
  } else if (location.purpose !== "fake" || !/^fake-[a-z0-9-]{8,80}$/.test(location.id) || path.resolve(location.directory).startsWith(DEVELOPMENT_BUDGET_DIRECTORY)) {
    throw new Error("Fake budgets must be isolated from the development authority.");
  }
  return { database: path.join(location.directory, "budget.sqlite"), witness: path.join(location.directory, "witness.jsonl") };
}
