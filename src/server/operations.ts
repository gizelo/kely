import { randomUUID } from "node:crypto";
import type { CostEvidence, GenerationOrigin, OperationKind, OperationView, PublicationView, RevisionScope } from "../shared/contracts";
import { pool, transaction } from "./db";
import { lockWallet, settleCredits } from "./credits";
import { requireCondition } from "./errors";
import { readPublication, writePublication } from "./publications";
import { fixtureRevisionTarget, prepareFixture } from "./fixture-provider";
import { renderSlide } from "./renderer";
import { loadAcceptedInput } from "./accepted-input";
import { verifyFrozenBrand } from "./brand";
import { assertBrandReady } from "./brand-policy";

export type StoredOperation = { id: string; owner_id: string; publication_id: string; kind: OperationKind; status: string; input_state: PublicationView; business_context: { name: string; context: string }; instruction: string; error: string | null; origin: GenerationOrigin; model: string; scope: RevisionScope | null; package_id: string | null; cost: CostEvidence | null };

export async function operationView(ownerId: string, id: string): Promise<OperationView> {
  const { rows: [operation] } = await pool.query<StoredOperation>("SELECT * FROM operation WHERE id=$1 AND owner_id=$2", [id, ownerId]);
  requireCondition(operation, "not_found", "That operation is not available.", 404);
  return { id, publicationId: operation.publication_id, kind: operation.kind, status: operation.status as OperationView["status"], error: operation.error ?? undefined, fixture: operation.origin !== "openai", origin: operation.origin, ...(operation.cost ? { cost: operation.cost } : {}) };
}

export async function runFixtureOperation(id: string, options: { failAfterSlide?: number } = {}) {
  const lease = await pool.connect();
  try {
    await lease.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [id]);
    const { rows: [operation] } = await pool.query<StoredOperation>("SELECT * FROM operation WHERE id=$1", [id]);
    if (!operation || !["queued", "running"].includes(operation.status)) return;
    requireCondition(operation.origin === "fixture", "origin_conflict", "The fixture processor cannot process a non-fixture operation.", 409);
    await pool.query("UPDATE operation SET status='running',updated_at=now() WHERE id=$1", [id]);
    try {
      let result = structuredClone(operation.input_state);
      const { snapshot } = await loadAcceptedInput(operation.owner_id, id);
      if (snapshot.schemaVersion >= 2 && snapshot.brand) {
        await verifyFrozenBrand(operation.owner_id, snapshot.brand);
        if (operation.kind !== "prepare") assertBrandReady(result, snapshot.brand);
      }
      if (operation.kind === "prepare") {
        result = prepareFixture(result, operation.business_context);
      } else if (operation.kind === "cover") {
        result.slides[0].assetId = await renderSlide(operation.owner_id, result, result.slides[0], id);
        result.coverApproved = false;
        result.status = "cover_approval";
      } else if (operation.kind === "remaining") {
        for (let index = 1; index < result.slides.length; index++) {
          result.slides[index].assetId = await renderSlide(operation.owner_id, result, result.slides[index], id);
          if (options.failAfterSlide === index) throw new Error("Injected fixture stage failure");
        }
        result.status = "ready";
      } else {
        const index = fixtureRevisionTarget(result, operation.instruction);
        result.slides[index].assetId = await renderSlide(operation.owner_id, result, result.slides[index], id, 1 + (result.version % 2));
        result.messages.push({ id: randomUUID(), role: "user", text: operation.instruction, createdAt: new Date().toISOString() });
        result.messages.push({ id: randomUUID(), role: "assistant", text: `Fixture visual revision saved for slide ${index + 1}. The fixture changes the color treatment while preserving approved text; it does not understand or perform AI copywriting instructions. Earlier versions remain available.`, createdAt: new Date().toISOString() });
        if (result.status !== "ready") { result.status = "cover_approval"; result.coverApproved = false; }
      }
      await transaction(async (client) => {
        await lockWallet(client, operation.owner_id);
        const current = await readPublication(operation.owner_id, operation.publication_id, client, true);
        requireCondition(current.pendingOperation?.id === id, "operation_conflict", "The operation no longer owns the active publication.", 409);
        result.version = current.version;
        result.history = current.history;
        delete result.pendingOperation;
        delete result.failure;
        delete result.failedOperationKind;
        await writePublication(client, result, operation.kind === "revise" ? "Fixture visual revision" : `Fixture ${operation.kind} completed`);
        await settleCredits(client, operation.owner_id, id, true);
        await client.query("UPDATE operation SET status='completed',updated_at=now() WHERE id=$1", [id]);
      });
    } catch {
      await transaction(async (client) => {
        await lockWallet(client, operation.owner_id);
        const { rows: [persisted] } = await client.query("SELECT status FROM operation WHERE id=$1 FOR UPDATE", [id]);
        if (persisted.status === "completed") return;
        const current = await readPublication(operation.owner_id, operation.publication_id, client, true);
        requireCondition(current.pendingOperation?.id === id, "operation_conflict", "The operation no longer owns the active publication.", 409);
        const restored = structuredClone(operation.input_state);
        restored.version = current.version;
        restored.history = current.history;
        restored.status = "failed";
        restored.failure = "This fixture stage failed. Its credits were released and the previous successful work is preserved.";
        restored.failedOperationKind = operation.kind;
        delete restored.pendingOperation;
        await writePublication(client, restored, "Fixture stage failed; prior work preserved");
        await settleCredits(client, operation.owner_id, id, false);
        await client.query("UPDATE operation SET status='failed',error=$2,updated_at=now() WHERE id=$1", [id, restored.failure]);
      });
    }
  } finally {
    await lease.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [id]);
    lease.release();
  }
}
