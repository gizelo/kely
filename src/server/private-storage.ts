import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";

export const CLOUD_STORAGE_CEILING = 200_000_000;
export function usesCloudStorage() { return process.env.KELY_RUNTIME === "cloud"; }

export async function changeStorageUsage(client: PoolClient, usedDelta: number, reservedDelta = 0) {
  if (![usedDelta, reservedDelta].every(Number.isSafeInteger)) throw new Error("Invalid storage accounting.");
  const result = await client.query(`UPDATE cloud_storage_quota SET used_bytes=used_bytes+$1,reserved_bytes=reserved_bytes+$2
    WHERE singleton AND used_bytes+$1>=0 AND reserved_bytes+$2>=0
      AND used_bytes+$1+reserved_bytes+$2<=ceiling_bytes RETURNING singleton`, [usedDelta, reservedDelta]);
  if (!result.rowCount) throw new Error("Private storage capacity reached. Existing work is preserved.");
}

export async function storageTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT singleton FROM cloud_storage_quota WHERE singleton FOR UPDATE");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export class PostgresPrivateStorage {
  constructor(private readonly pool: Pool) {}

  async put(namespace: "asset" | "material", name: string, bytes: Buffer, operationId?: string) {
    const hash = createHash("sha256").update(bytes).digest("hex");
    await storageTransaction(this.pool, async (client) => {
      const { rows: [previous] } = await client.query("SELECT sha256 FROM private_blob WHERE namespace=$1 AND name=$2", [namespace, name]);
      if (previous) {
        if (previous.sha256 !== hash) throw new Error("An immutable private asset has different content.");
        return;
      }
      let reserved = 0;
      if (operationId) {
        const { rows: [reservation] } = await client.query("SELECT remaining_bytes FROM cloud_output_reservation WHERE operation_id=$1 FOR UPDATE", [operationId]);
        if (reservation) {
          if (Number(reservation.remaining_bytes) < bytes.length) throw new Error("The reserved output storage cannot cover this artifact.");
          reserved = bytes.length;
          await client.query("UPDATE cloud_output_reservation SET remaining_bytes=remaining_bytes-$2 WHERE operation_id=$1", [operationId, reserved]);
        }
      }
      await changeStorageUsage(client, bytes.length, -reserved);
      await client.query("INSERT INTO private_blob(namespace,name,content,sha256) VALUES($1,$2,$3,$4)", [namespace, name, bytes, hash]);
    });
  }

  async get(namespace: "asset" | "material", name: string) {
    const { rows: [blob] } = await this.pool.query<{ content: Buffer; sha256: string }>("SELECT content,sha256 FROM private_blob WHERE namespace=$1 AND name=$2", [namespace, name]);
    if (!blob) return undefined;
    if (createHash("sha256").update(blob.content).digest("hex") !== blob.sha256) throw new Error("Private asset integrity failed.");
    return blob.content;
  }

  async discardUnlinkedMaterial(name: string) {
    await storageTransaction(this.pool, async (client) => {
      const { rows } = await client.query("DELETE FROM private_blob WHERE namespace='material' AND name=$1 RETURNING octet_length(content) AS bytes", [name]);
      if (rows[0]) await changeStorageUsage(client, -rows[0].bytes);
    });
  }
}

export async function reserveOutputStorage(pool: Pool, operationId: string) {
  await storageTransaction(pool, async (client) => {
    if ((await client.query("SELECT 1 FROM cloud_output_reservation WHERE operation_id=$1", [operationId])).rowCount) return;
    const bytes = 64_000_000;
    await changeStorageUsage(client, 0, bytes);
    await client.query("INSERT INTO cloud_output_reservation(operation_id,remaining_bytes) VALUES($1,$2)", [operationId, bytes]);
  });
}

export async function releaseOutputStorage(pool: Pool, operationId: string) {
  await storageTransaction(pool, async (client) => {
    const { rows: [reservation] } = await client.query("DELETE FROM cloud_output_reservation WHERE operation_id=$1 RETURNING remaining_bytes", [operationId]);
    if (reservation) await changeStorageUsage(client, 0, -Number(reservation.remaining_bytes));
  });
}
