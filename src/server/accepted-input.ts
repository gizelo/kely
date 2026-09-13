import { pool } from "./db";
import { requireCondition } from "./errors";
import { verifyPaidInput } from "./paid-input";

export async function loadAcceptedInput(ownerId: string, operationId: string) {
  const { rows: [operation] } = await pool.query("SELECT quote_id,publication_id,input_snapshot,input_hash FROM operation WHERE id=$1 AND owner_id=$2", [operationId, ownerId]);
  requireCondition(operation, "not_found", "That accepted operation is not available.", 404);
  const snapshot = verifyPaidInput(operation.input_snapshot, operation.input_hash);
  requireCondition(snapshot.ownerId === ownerId && snapshot.quoteId === operation.quote_id && snapshot.publication.id === operation.publication_id, "input_snapshot_conflict", "The accepted inputs do not match this operation.", 409);
  return { snapshot, hash: operation.input_hash as string };
}
