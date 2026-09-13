import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { budgetFiles, DEVELOPMENT_BUDGET_CEILING_MICROS, type BudgetLocation } from "./identity";
import { BUDGET_SCHEMA, BudgetStore, type BudgetIdentity } from "./store";
import { canonicalJson, inputHash } from "../paid-input";

export function initializePreviewBudget(directory: string, id: string): BudgetLocation {
  const location: BudgetLocation = { directory, id, purpose: "fake" };
  const files = budgetFiles(location);
  mkdirSync(directory, { mode: 0o700 });
  if (realpathSync(directory) !== directory) throw new Error("Use a canonical private fake-budget directory.");
  closeSync(openSync(files.database, "wx", 0o600));
  const stat = lstatSync(files.database);
  const identity: BudgetIdentity = { ...location, schemaVersion: 1, ceilingMicros: DEVELOPMENT_BUDGET_CEILING_MICROS, fileIdentity: `${stat.dev}:${stat.ino}` };
  const payload = canonicalJson({ type: "initialized", identity });
  const previousHash = "0".repeat(64);
  const hash = inputHash({ sequence: 1, payload, previousHash });
  const database = new DatabaseSync(files.database);
  try {
    database.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; BEGIN IMMEDIATE;");
    database.exec(BUDGET_SCHEMA);
    database.prepare("INSERT INTO authority(singleton,identity) VALUES(1,?)").run(canonicalJson(identity));
    database.prepare("INSERT INTO event(sequence,payload,previous_hash,hash) VALUES(1,?,?,?)").run(payload, previousHash, hash);
    const witness = openSync(files.witness, "wx", 0o600);
    try { writeFileSync(witness, `${JSON.stringify({ sequence: 1, hash })}\n`); fsyncSync(witness); } finally { closeSync(witness); }
    database.exec("COMMIT");
    const directoryFd = openSync(directory, "r");
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  } finally { database.close(); }
  new BudgetStore(location).close();
  return location;
}
