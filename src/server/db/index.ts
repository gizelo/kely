import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import { config } from "../config";
import * as schema from "./schema";

const shared = globalThis as unknown as { kelyPool?: Pool };
export const pool = shared.kelyPool ?? new Pool({ connectionString: config.databaseUrl, max: 6 });
shared.kelyPool = pool;
export const db = drizzle(pool, { schema });

export async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
