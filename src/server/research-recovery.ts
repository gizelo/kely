import type { Pool } from "pg";
import { BrandIntelligenceStore } from "./brand-intelligence-store";
import type { CloudBudgetStore } from "./budget/cloud-store";
import { closeResearchPackageFromDurableEvidence } from "./budget/research-package";

const INTERRUPTED = ["resolving", "fetching", "extracting", "strategizing", "checking"];

export function interruptedResearchOutcome(statuses: string[]) {
  return statuses.some((status) => status === "dispatching" || status === "uncertain") ? "uncertain" as const : "failed" as const;
}

export async function reconcileInterruptedResearchRuns(database: Pool, budget: CloudBudgetStore) {
  const rows = (await database.query<{ id: string; owner_id: string; input_hash: string; input: { materialIds?: string[] } }>(
    `SELECT r.id,r.owner_id,r.input_hash,r.input
       FROM brand_research_run r
       JOIN LATERAL (
         SELECT status FROM brand_research_event WHERE run_id=r.id ORDER BY sequence DESC LIMIT 1
       ) e ON true
      WHERE e.status = ANY($1::text[])
      ORDER BY r.created_at`,
    [INTERRUPTED],
  )).rows;
  if (!rows.length) return 0;
  const state = await budget.inspect();
  const store = new BrandIntelligenceStore(database);
  for (const row of rows) {
    const reservation = state.packages.find((item) => item.operationId === row.id);
    const attempts = state.attempts.filter((item) => item.operationId === row.id);
    const outcome = interruptedResearchOutcome(attempts.map((item) => item.status));
    await store.appendStatus(row.owner_id, row.id, outcome, { reason: outcome === "uncertain" ? "provider_outcome_unknown" : "process_interrupted" });
    if (outcome === "failed" && reservation?.status === "active") {
      await closeResearchPackageFromDurableEvidence(database, budget, row.owner_id, row.id, row.input_hash, Array.isArray(row.input?.materialIds) ? row.input.materialIds : []);
    }
  }
  return rows.length;
}
