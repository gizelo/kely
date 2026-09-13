import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { initializePreviewBudget } from "../src/server/budget/fake-store";
import { BudgetStore } from "../src/server/budget/store";

if (process.env.KELY_PROVIDER_MODE !== "ai_preview" || process.env.KELY_LIVE_ENABLED !== "false") throw new Error("Preview setup requires fake-only launcher mode.");
mkdirSync(resolve(".local"), { recursive: true, mode: 0o700 });
const location = { directory: resolve(".local/ai-preview-budget"), id: "fake-kely-ai-preview-v1", purpose: "fake" as const };
if (!existsSync(location.directory)) initializePreviewBudget(location.directory, location.id);
new BudgetStore(location).close();
console.log("Fake preview ledger ready. The canonical lifetime API authority was not opened or initialized.");
