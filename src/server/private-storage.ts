import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";

type Namespace = "asset" | "material";
export type ObjectTransport = {
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string, expectedSize?: number): Promise<Buffer | undefined>;
  delete(key: string): Promise<void>;
};

function storageName(namespace: Namespace, name: string) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.png$/u.test(name)) throw new Error("Invalid private storage key.");
  return `${namespace}/${name}`;
}

function encodedObjectPath(bucket: string, key: string) {
  return [bucket, ...key.split("/")].map(encodeURIComponent).join("/");
}

export class SupabaseObjectTransport implements ObjectTransport {
  constructor(
    private readonly origin: string,
    private readonly serviceKey: string,
    private readonly bucket: string,
    private readonly request: typeof fetch = fetch,
  ) {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || !/^[a-z0-9]{20}\.supabase\.co$/u.test(url.hostname)) throw new Error("Invalid Supabase storage origin.");
  }

  private endpoint(key: string) { return `${this.origin}/storage/v1/object/${encodedObjectPath(this.bucket, key)}`; }
  private headers() { return { apikey: this.serviceKey, Authorization: `Bearer ${this.serviceKey}` }; }

  async put(key: string, bytes: Buffer) {
    const response = await this.request(this.endpoint(key), { method: "POST", headers: { ...this.headers(), "Content-Type": "image/png", "x-upsert": "false" }, body: new Uint8Array(bytes), redirect: "error", signal: AbortSignal.timeout(15_000) });
    if ([400, 409].includes(response.status)) {
      const existing = await this.get(key, bytes.length);
      if (existing?.equals(bytes)) return;
    }
    if (!response.ok) throw new Error(`Private object upload failed (${response.status}).`);
  }

  async get(key: string, expectedSize = 16 * 1024 * 1024) {
    const maximum = Math.max(0, expectedSize);
    const response = await this.request(this.endpoint(key), { headers: this.headers(), cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (response.status === 404) return undefined;
    if (response.status === 400) {
      const failure = await response.clone().json().catch(() => undefined) as { statusCode?: unknown; error?: unknown; message?: unknown } | undefined;
      const missing = failure?.statusCode === "404" && failure?.error === "not_found" && failure?.message === "Object not found";
      if (missing) return undefined;
    }
    if (!response.ok) throw new Error(`Private object download failed (${response.status}).`);
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > maximum) throw new Error("Private object exceeds its manifest size.");
    const reader = response.body?.getReader();
    if (!reader) return Buffer.alloc(0);
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximum) { await reader.cancel(); throw new Error("Private object exceeds its manifest size."); }
      chunks.push(next.value);
    }
    return Buffer.concat(chunks);
  }

  async delete(key: string) {
    const response = await this.request(this.endpoint(key), { method: "DELETE", headers: this.headers(), redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (!response.ok && response.status !== 404) throw new Error(`Private object cleanup failed (${response.status}).`);
  }
}

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

export class SupabasePrivateStorage {
  constructor(private readonly pool: Pool, private readonly objects: ObjectTransport) {}

  async put(namespace: Namespace, name: string, bytes: Buffer, operationId?: string) {
    const objectKey = storageName(namespace, name);
    const hash = createHash("sha256").update(bytes).digest("hex");
    let state = "pending";
    await storageTransaction(this.pool, async (client) => {
      const { rows: [previous] } = await client.query<{ sha256: string; size_bytes: string; state: string }>("SELECT sha256,size_bytes,state FROM private_object WHERE namespace=$1 AND name=$2", [namespace, name]);
      if (previous) {
        if (previous.sha256 !== hash || Number(previous.size_bytes) !== bytes.length || previous.state === "delete_pending") throw new Error("An immutable private asset has different content.");
        state = previous.state;
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
      await client.query("INSERT INTO private_object(namespace,name,object_key,sha256,size_bytes,state,operation_id) VALUES($1,$2,$3,$4,$5,'pending',$6)", [namespace, name, objectKey, hash, bytes.length, operationId ?? null]);
    });

    if (state === "ready") {
      const saved = await this.objects.get(objectKey, bytes.length);
      if (!saved || saved.length !== bytes.length || createHash("sha256").update(saved).digest("hex") !== hash) throw new Error("Private asset integrity failed.");
      return;
    }

    const existing = await this.objects.get(objectKey, bytes.length);
    if (existing) {
      if (existing.length !== bytes.length || createHash("sha256").update(existing).digest("hex") !== hash) throw new Error("Private asset integrity failed.");
    } else await this.objects.put(objectKey, bytes);
    try {
      const completed = await this.pool.query("UPDATE private_object SET state='ready',updated_at=now() WHERE namespace=$1 AND name=$2 AND sha256=$3 AND size_bytes=$4 AND state='pending' RETURNING name", [namespace, name, hash, bytes.length]);
      if (completed.rowCount !== 1) throw new Error("Private asset state changed before upload completion.");
    } catch (error) {
      throw error;
    }
  }

  async get(namespace: Namespace, name: string) {
    storageName(namespace, name);
    const { rows: [object] } = await this.pool.query<{ object_key: string; sha256: string; size_bytes: string; state: string }>("SELECT object_key,sha256,size_bytes,state FROM private_object WHERE namespace=$1 AND name=$2", [namespace, name]);
    if (!object || object.state !== "ready") return undefined;
    const bytes = await this.objects.get(object.object_key, Number(object.size_bytes));
    if (!bytes || bytes.length !== Number(object.size_bytes) || createHash("sha256").update(bytes).digest("hex") !== object.sha256) throw new Error("Private asset integrity failed.");
    return bytes;
  }

  async discardUnlinkedMaterial(name: string) {
    const objectKey = storageName("material", name);
    let marked = await this.pool.query<{ size_bytes: string }>("UPDATE private_object SET state='delete_pending',updated_at=now() WHERE namespace='material' AND name=$1 AND state IN ('ready','pending') RETURNING size_bytes", [name]);
    if (!marked.rowCount) marked = await this.pool.query<{ size_bytes: string }>("SELECT size_bytes FROM private_object WHERE namespace='material' AND name=$1 AND state='delete_pending'", [name]);
    if (!marked.rowCount) return;
    await this.objects.delete(objectKey);
    const removed = await cleanupManifest(this.pool, "material", name, "delete_pending");
    if (!removed) throw new Error("Private asset deletion state changed before completion.");
  }
}

type ManifestRow = { namespace: Namespace; name: string; object_key: string; sha256: string; size_bytes: string; state: "pending" | "ready" | "delete_pending"; operation_id: string | null; linked: boolean };

async function cleanupManifest(pool: Pool, namespace: Namespace, name: string, expectedState: ManifestRow["state"]) {
  return storageTransaction(pool, async (client) => {
    const { rows: [row] } = await client.query<Pick<ManifestRow, "size_bytes" | "operation_id" | "state">>("SELECT size_bytes,operation_id,state FROM private_object WHERE namespace=$1 AND name=$2 FOR UPDATE", [namespace, name]);
    if (!row || row.state !== expectedState) return false;
    const size = Number(row.size_bytes);
    let restored = 0;
    if (row.operation_id) {
      const reservation = await client.query("UPDATE cloud_output_reservation SET remaining_bytes=remaining_bytes+$2 WHERE operation_id=$1 RETURNING operation_id", [row.operation_id, size]);
      if (reservation.rowCount) restored = size;
    }
    await client.query("DELETE FROM private_object WHERE namespace=$1 AND name=$2 AND state=$3", [namespace, name, expectedState]);
    await changeStorageUsage(client, -size, restored);
    return true;
  });
}

export async function reconcilePrivateStorage(pool: Pool, objects?: ObjectTransport) {
  const transport = objects ?? new SupabaseObjectTransport(process.env.KELY_STORAGE_URL!.replace(/\/$/u, ""), process.env.KELY_STORAGE_SERVICE_KEY!, process.env.KELY_STORAGE_BUCKET!);
  const { rows } = await pool.query<ManifestRow>(`SELECT p.namespace,p.name,p.object_key,p.sha256,p.size_bytes,p.state,p.operation_id,
      CASE WHEN p.namespace='material' THEN m.id IS NOT NULL ELSE a.id IS NOT NULL END AS linked
    FROM private_object p
    LEFT JOIN brand_material m ON p.namespace='material' AND m.stored_name=p.name
    LEFT JOIN asset a ON p.namespace='asset' AND a.filename=p.name
    WHERE p.state IN ('pending','delete_pending')
      OR (p.state='ready' AND ((p.namespace='material' AND m.id IS NULL) OR (p.namespace='asset' AND a.id IS NULL)))
    ORDER BY p.updated_at,p.namespace,p.name LIMIT 101`);
  if (rows.length > 100) throw new Error("Private storage reconciliation exceeds its safe startup bound.");
  for (const row of rows) {
    const size = Number(row.size_bytes);
    if (row.state === "pending") {
      const bytes = await transport.get(row.object_key, size);
      const exact = Boolean(bytes && bytes.length === size && createHash("sha256").update(bytes).digest("hex") === row.sha256);
      if (exact && row.linked) {
        const ready = await pool.query("UPDATE private_object SET state='ready',updated_at=now() WHERE namespace=$1 AND name=$2 AND state='pending' AND sha256=$3 AND size_bytes=$4 RETURNING name", [row.namespace, row.name, row.sha256, size]);
        if (ready.rowCount !== 1) throw new Error("Private storage reconciliation observed a concurrent state change.");
        continue;
      }
    }
    await transport.delete(row.object_key);
    const removed = await cleanupManifest(pool, row.namespace, row.name, row.state);
    if (!removed) throw new Error("Private storage reconciliation observed a concurrent state change.");
  }
}

export function privateStorage(pool: Pool) {
  if (!usesCloudStorage()) return new PostgresPrivateStorage(pool);
  const origin = process.env.KELY_STORAGE_URL!;
  const key = process.env.KELY_STORAGE_SERVICE_KEY!;
  const bucket = process.env.KELY_STORAGE_BUCKET!;
  return new SupabasePrivateStorage(pool, new SupabaseObjectTransport(origin.replace(/\/$/u, ""), key, bucket));
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
