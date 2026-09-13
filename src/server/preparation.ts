import type { PoolClient } from "pg";
import type { GenerationOrigin, PublicationView } from "../shared/contracts";
import { pool } from "./db";

export type PreparationPackage = { id: string; owner_id: string; publication_id: string; origin: Exclude<GenerationOrigin, "fixture">; model: string; activated: boolean; replies_used: number; attempts_used: number; closed: boolean; paused: boolean };

export async function currentPreparation(ownerId: string, publicationId: string, client: PoolClient | typeof pool = pool, lock = false): Promise<PreparationPackage | undefined> {
  const { rows: [row] } = await client.query<PreparationPackage>(`SELECT * FROM preparation_package WHERE owner_id=$1 AND publication_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1${lock ? " FOR UPDATE" : ""}`, [ownerId, publicationId]);
  return row;
}

export function preparationView(row: PreparationPackage): NonNullable<PublicationView["preparation"]> {
  return { id: row.id, origin: row.origin, activated: row.activated, repliesUsed: row.replies_used, repliesRemaining: 3 - row.replies_used, retryRemaining: row.paused ? 0 : Math.min(1, 4 - row.attempts_used), attemptsUsed: row.attempts_used, closed: row.closed, paused: row.paused };
}
