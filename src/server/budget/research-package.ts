import type { Pool, PoolClient } from "pg";
import { inputHash } from "../paid-input";
import { buildTextRequest } from "../providers/text-envelope";
import { providerMaximumMicros } from "../providers/provider-envelope";
import { buildWebSearchRequest } from "../providers/web-search-envelope";
import { requireCondition } from "../errors";
import type { BudgetPackage, BudgetPackageInput } from "./store";

export const RESEARCH_PACKAGE_POLICY = "brand-research-package.v1" as const;
export const RESEARCH_MATERIAL_MAXIMUM_MICROS = 532_373;

const boundedObjectSchema = {
  type: "object", additionalProperties: false, required: ["result"], properties: { result: { type: "string" } },
} as const;

function searchMaximum() {
  return providerMaximumMicros(buildWebSearchRequest({ input: "bounded entity discovery", instructions: "Find one business identity candidate.", schema: boundedObjectSchema }));
}

function textMaximum(maxOutputTokens: number) {
  return providerMaximumMicros(buildTextRequest({ model: "gpt-5.6-luna", input: "bounded research context", instructions: "Return only the requested structured research result.", maxOutputTokens, jsonSchema: { name: "kely_research_package_v1", schema: boundedObjectSchema } }));
}

export const RESEARCH_PACKAGE_STEPS = Object.freeze([
  { step: "entity-search-1", maximumMicros: searchMaximum() },
  { step: "entity-search-2", maximumMicros: searchMaximum() },
  { step: "extract:0", maximumMicros: textMaximum(2_048) },
  { step: "strategy:0", maximumMicros: textMaximum(4_096) },
  { step: "check:0", maximumMicros: textMaximum(2_048) },
]);

export function researchPackageInput(ownerId: string, runId: string, researchInputHash: string, materialIds: string[] = []): BudgetPackageInput {
  requireCondition(/^[a-f0-9]{64}$/u.test(researchInputHash), "research_package_input_invalid", "The saved research input hash is invalid.", 409);
  requireCondition(materialIds.length <= 3 && new Set(materialIds).size === materialIds.length, "research_package_input_invalid", "Research materials are invalid.", 409);
  const steps = [...(materialIds.length ? [{ step: "materials:0", maximumMicros: RESEARCH_MATERIAL_MAXIMUM_MICROS }] : []), ...RESEARCH_PACKAGE_STEPS];
  const scopeHash = inputHash({ policy: RESEARCH_PACKAGE_POLICY, ownerId, runId, researchInputHash, materialIds, steps });
  return { id: `research:${runId}:v1`, ownerId, operationId: runId, scopeHash, steps: steps.map((step) => ({ ...step })) };
}

export function bindResearchAttempt<T extends { ownerId: string; operationId: string; step: string }>(attempt: T, reservation: BudgetPackageInput): T & { packageId: string } {
  requireCondition(attempt.ownerId === reservation.ownerId && attempt.operationId === reservation.operationId && reservation.steps.some((item) => item.step === attempt.step), "research_package_scope_invalid", "That research step is outside its saved package reservation.", 409);
  return { ...attempt, packageId: reservation.id };
}

type PackageBudget = {
  reservePackage(input: BudgetPackageInput): BudgetPackage | Promise<BudgetPackage>;
  closePackage(input: { id: string; ownerId: string; operationId: string; scopeHash: string; outcome: "completed" | "released"; evidenceHash: string }): BudgetPackage | Promise<BudgetPackage>;
};

export function reserveResearchPackage(budget: PackageBudget, ownerId: string, runId: string, researchInputHash: string, materialIds: string[] = []) {
  return budget.reservePackage(researchPackageInput(ownerId, runId, researchInputHash, materialIds));
}

type QueryClient = Pick<Pool | PoolClient, "query">;

export async function closeResearchPackageFromDurableEvidence(database: QueryClient, budget: PackageBudget, ownerId: string, runId: string, researchInputHash: string, materialIds: string[] = []) {
  const reservation = researchPackageInput(ownerId, runId, researchInputHash, materialIds);
  const row = (await database.query(
    `SELECT r.input_hash,e.sequence,e.status,e.detail,s.id snapshot_id,s.version snapshot_version,s.snapshot_hash,
            COALESCE(src.content_hashes,'[]'::json) source_hashes,
            COALESCE(mat.material_ids,'[]'::json) material_ids,
            COALESCE(mat.request_hashes,'[]'::json) material_request_hashes
       FROM brand_research_run r
       JOIN LATERAL (
         SELECT sequence,status,detail FROM brand_research_event
          WHERE owner_id=r.owner_id AND run_id=r.id ORDER BY sequence DESC LIMIT 1
       ) e ON true
       LEFT JOIN LATERAL (
         SELECT id,version,snapshot_hash FROM brand_research_snapshot
          WHERE owner_id=r.owner_id AND run_id=r.id ORDER BY version DESC LIMIT 1
       ) s ON true
       LEFT JOIN LATERAL (
         SELECT json_agg(content_hash ORDER BY id) content_hashes FROM brand_research_source
          WHERE owner_id=r.owner_id AND run_id=r.id
       ) src ON true
       LEFT JOIN LATERAL (
         SELECT json_agg(material_id ORDER BY material_id) material_ids,
                json_agg(request_hash ORDER BY material_id) request_hashes
           FROM brand_research_material WHERE owner_id=r.owner_id AND run_id=r.id
       ) mat ON true
      WHERE r.owner_id=$1 AND r.id=$2`,
    [ownerId, runId],
  )).rows[0];
  requireCondition(row && row.input_hash === researchInputHash, "research_package_evidence_invalid", "The durable research input does not match its reservation.", 409);
  requireCondition(materialIds.length === 0 || (Array.isArray(row.material_ids) && row.material_ids.length === materialIds.length && materialIds.every((id) => row.material_ids.includes(id))), "research_package_evidence_invalid", "Durable material analysis does not match the reserved research package.", 409);
  const completed = row.status === "review_ready" && row.snapshot_id && row.snapshot_hash;
  const hasDurableWork = Boolean(row.snapshot_id && row.snapshot_hash) || (Array.isArray(row.source_hashes) && row.source_hashes.length > 0);
  const released = row.status === "failed" || ((row.status === "needs_input" || row.status === "partial") && hasDurableWork);
  requireCondition(completed || released, "research_package_not_terminal", "Research package funds remain reserved until durable completion or failure evidence exists.", 409);
  const evidenceHash = inputHash({
    policy: RESEARCH_PACKAGE_POLICY,
    ownerId,
    runId,
    inputHash: row.input_hash,
    event: { sequence: Number(row.sequence), status: row.status, detail: row.detail ?? null },
    sourceHashes: Array.isArray(row.source_hashes) ? row.source_hashes : [],
    materialRequestHashes: Array.isArray(row.material_request_hashes) ? row.material_request_hashes : [],
    snapshot: row.snapshot_id ? { id: row.snapshot_id, version: Number(row.snapshot_version), hash: row.snapshot_hash } : null,
  });
  return budget.closePackage({ id: reservation.id, ownerId, operationId: runId, scopeHash: reservation.scopeHash, outcome: completed ? "completed" : "released", evidenceHash });
}
