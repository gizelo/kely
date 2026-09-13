import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { Pool } from "pg";

export async function assertSchemaReady(pool: Pool) {
  const directory = new URL("../../migrations/", import.meta.url);
  const files = (await readdir(directory)).filter(file => /^\d+_[a-z_]+\.sql$/.test(file)).sort();
  const { rows } = await pool.query<{ name: string; sha256: string }>("SELECT name,sha256 FROM kely_schema_migration");
  const applied = new Map(rows.map(row => [row.name, row.sha256]));
  for (const name of files) {
    const hash = createHash("sha256").update(await readFile(new URL(name, directory))).digest("hex");
    if (applied.get(name) !== hash) throw new Error("Database migration manifest does not match this release.");
  }
}
