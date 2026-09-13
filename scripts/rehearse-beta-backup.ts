import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "pg";

const sourceName = "kely_beta_test";
const targetName = "kely_beta_restore_test";
const container = "kely-local-postgres-1";
const command = promisify(execFile);
const connection = (database: string) => new Client({ host: "127.0.0.1", port: 55432, user: "kely", password: "kely_local_only", database });
const source = connection(sourceName);
const admin = connection("postgres");
const target = connection(targetName);
let targetConnected = false;

async function docker(args: string[]) {
  return (await command("/usr/local/bin/docker", ["exec", container, ...args], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 })).stdout;
}

async function manifest(client: Client) {
  const { rows: tables } = await client.query<{ schema: string; name: string }>("SELECT schemaname AS schema,tablename AS name FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY schemaname,tablename");
  const result = [];
  for (const table of tables) {
    const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
    const { rows: [row] } = await client.query(`SELECT count(*)::integer AS count,md5(coalesce(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text),'')) AS data_hash FROM ${quote(table.schema)}.${quote(table.name)} t`);
    result.push({ table: `${table.schema}.${table.name}`, ...row });
  }
  return result;
}

function schemaHash(bytes: Buffer) {
  const normalized = bytes.toString("utf8").split("\n").filter((line) => !/^\\(?:un)?restrict /u.test(line)).join("\n");
  return createHash("sha256").update(normalized).digest("hex");
}

async function main() {
try {
  await admin.connect();
  const { rows } = await admin.query("SELECT datname FROM pg_database WHERE datname=ANY($1)", [[sourceName, targetName]]);
  assert(rows.some((row) => row.datname === sourceName), "The approved isolated source database must already exist.");
  assert(!rows.some((row) => row.datname === targetName), "Restore target exists; refusing to overwrite or reset it.");
  await source.connect();
  await source.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const snapshot = (await source.query("SELECT pg_export_snapshot() AS id")).rows[0].id;
  const args = ["-U", "kely", "--no-owner", "--no-privileges"];
  const archive = await docker(["pg_dump", ...args, "-Fc", "--snapshot", snapshot, "-d", sourceName]);
  const sourceSchema = await docker(["pg_dump", ...args, "--schema-only", "--snapshot", snapshot, "-d", sourceName]);
  const sourceTables = await manifest(source);
  const migrationHashes = (await source.query("SELECT name,sha256 FROM kely_schema_migration ORDER BY name")).rows;
  await source.query("COMMIT");

  const directory = path.resolve(".local/backups");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const archivePath = path.join(directory, `${stamp}-${sourceName}.dump`);
  const archiveFile = await open(archivePath, "wx", 0o600);
  try { await archiveFile.writeFile(archive); await archiveFile.sync(); } finally { await archiveFile.close(); }
  await admin.query(`CREATE DATABASE ${targetName} TEMPLATE template0`);
  await new Promise<void>((resolve, reject) => {
    const child = execFile("/usr/local/bin/docker", ["exec", "-i", container, "pg_restore", "-U", "kely", "--exit-on-error", "--no-owner", "--no-privileges", "-d", targetName], (error) => error ? reject(new Error("Restore failed; preserve the isolated target for inspection.")) : resolve());
    child.stdin!.end(archive);
  });
  await target.connect(); targetConnected = true;
  const targetTables = await manifest(target);
  const targetSchema = await docker(["pg_dump", ...args, "--schema-only", "-d", targetName]);
  assert.deepEqual(targetTables, sourceTables, "Restored row counts or content digests differ.");
  assert.equal(schemaHash(sourceSchema), schemaHash(targetSchema), "Restored schema differs.");
  assert.deepEqual((await target.query("SELECT name,sha256 FROM kely_schema_migration ORDER BY name")).rows, migrationHashes);
  const summary = { source: sourceName, target: targetName, archivePath, archiveBytes: archive.length, archiveSha256: createHash("sha256").update(archive).digest("hex"), schemaSha256: schemaHash(sourceSchema), tables: sourceTables, migrationHashes, restoredAt: new Date().toISOString(), generationEnabled: false };
  const manifestFile = await open(`${archivePath}.manifest.json`, "wx", 0o600);
  try { await manifestFile.writeFile(JSON.stringify(summary, null, 2)); await manifestFile.sync(); } finally { await manifestFile.close(); }
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await source.end();
  if (targetConnected) await target.end();
  await admin.end();
}
}

main().catch((error) => { console.error(error instanceof Error ? error.message : "Backup rehearsal failed."); process.exitCode = 1; });
