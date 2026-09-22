import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pool, transaction } from "../src/server/db";

let activeMigration = "bootstrap";

async function main() {
  const directory = new URL("../migrations/", import.meta.url);
  const files = (await readdir(directory)).filter((file) => /^\d+_[a-z_]+\.sql$/.test(file)).sort();
  const migrations = await Promise.all(files.map((file) => readFile(new URL(file, directory), "utf8")));
  await transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(6381041)");
    await client.query("CREATE TABLE IF NOT EXISTS kely_schema_migration(name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())");
    for (const [index, sql] of migrations.entries()) {
      const name = files[index];
      activeMigration = name;
      const hash = createHash("sha256").update(sql).digest("hex");
      const { rows: [existing] } = await client.query("SELECT sha256 FROM kely_schema_migration WHERE name=$1", [name]);
      if (existing) {
        if (existing.sha256 !== hash) throw new Error(`Applied migration differs: ${name}`);
        continue;
      }
      await client.query(sql);
      await client.query("INSERT INTO kely_schema_migration(name,sha256) VALUES($1,$2)", [name, hash]);
    }
  });
  console.log("Kely schema is ready. No AI or payment request was made.");
}

main().catch((error: unknown) => {
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : "unknown";
  console.error(`Kely migration failed at ${activeMigration} (SQLSTATE ${code}).`);
  process.exitCode = 1;
}).finally(() => pool.end());
