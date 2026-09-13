import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { budgetFiles, DEVELOPMENT_BUDGET_ACTIVATION_RECORD, DEVELOPMENT_BUDGET_CEILING_MICROS, DEVELOPMENT_BUDGET_GENESIS_HASH, developmentBudgetLocation, type BudgetLocation } from "../../src/server/budget/identity";
import { BUDGET_SCHEMA, type BudgetIdentity } from "../../src/server/budget/store";
import { canonicalJson, inputHash } from "../../src/server/paid-input";

function requireSafe(condition: unknown): asserts condition {
  if (!condition) throw new Error("Activation refused. Preserve any existing or partial authority/receipt for coordinator review; no reset is supported.");
}

function requireAbsent(path: string) {
  try { lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  requireSafe(false);
}

function privateDirectory(path: string) {
  const stat = lstatSync(path);
  requireSafe(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0 && realpathSync(path) === path);
}

function privateFile(path: string) {
  const stat = lstatSync(path);
  requireSafe(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0);
  return `${stat.dev}:${stat.ino}`;
}

function syncPath(path: string, directory = false) {
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | (directory ? constants.O_DIRECTORY : 0));
  try { fsyncSync(file); } finally { closeSync(file); }
}

function appendReceipt(path: string, value: unknown, first = false) {
  const file = openSync(path, constants.O_WRONLY | constants.O_NOFOLLOW | (first ? constants.O_CREAT | constants.O_EXCL : constants.O_APPEND), 0o600);
  try { writeFileSync(file, `${canonicalJson(value)}\n`); fsyncSync(file); } finally { closeSync(file); }
}

function validateLocation(location: BudgetLocation, receipt: string) {
  budgetFiles(location);
  requireSafe(receipt === `${location.directory}.activation.jsonl`);
  if (location.purpose === "development") requireSafe(receipt === DEVELOPMENT_BUDGET_ACTIVATION_RECORD && DEVELOPMENT_BUDGET_GENESIS_HASH === null);
}

export function verifyFreshActivation(location: BudgetLocation, receipt: string, proposedHash: string) {
  validateLocation(location, receipt);
  privateDirectory(location.directory);
  privateFile(receipt);
  const files = budgetFiles(location);
  const fileIdentity = privateFile(files.database);
  privateFile(files.witness);
  requireSafe(/^[a-f0-9]{64}$/u.test(proposedHash));
  const database = new DatabaseSync(files.database, { readOnly: true, allowExtension: false, defensive: true, enableDoubleQuotedStringLiterals: false });
  const expectedSchema = new DatabaseSync(":memory:");
  try {
    requireSafe(database.prepare("PRAGMA quick_check").get()?.quick_check === "ok");
    expectedSchema.exec(BUDGET_SCHEMA);
    const schemaQuery = "SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name";
    requireSafe(JSON.stringify(database.prepare(schemaQuery).all()) === JSON.stringify(expectedSchema.prepare(schemaQuery).all()));
    const expected: BudgetIdentity = { ...location, schemaVersion: 1, ceilingMicros: DEVELOPMENT_BUDGET_CEILING_MICROS, fileIdentity };
    const authorities = database.prepare("SELECT singleton,identity FROM authority").all();
    requireSafe(authorities.length === 1 && authorities[0].singleton === 1 && authorities[0].identity === canonicalJson(expected));
    const events = database.prepare("SELECT sequence,payload,previous_hash,hash FROM event").all();
    const payload = canonicalJson({ type: "initialized", identity: expected });
    const previousHash = "0".repeat(64);
    const hash = inputHash({ sequence: 1, payload, previousHash });
    requireSafe(events.length === 1 && events[0].sequence === 1 && events[0].payload === payload && events[0].previous_hash === previousHash && events[0].hash === hash && proposedHash === hash);
    requireSafe(lstatSync(files.witness).size <= 256 && lstatSync(receipt).size <= 4096);
    requireSafe(readFileSync(files.witness, "utf8") === `${JSON.stringify({ sequence: 1, hash })}\n`);
    const receiptText = readFileSync(receipt, "utf8");
    requireSafe(Buffer.byteLength(receiptText) <= 4096 && receiptText.endsWith("\n"));
    const records = receiptText.trimEnd().split("\n").map((line) => JSON.parse(line));
    requireSafe(records.length >= 1 && records.length <= 2 && records[0].type === "activation_started" && records[0].id === location.id && records[0].directory === location.directory && records[0].purpose === location.purpose && records[0].ceilingMicros === DEVELOPMENT_BUDGET_CEILING_MICROS && records[0].confirmedPriorSpendMicros === 0);
    if (records.length === 2) requireSafe(records[1].type === "activation_verified" && records[1].genesisHash === proposedHash);
    return { identity: location.id, purpose: location.purpose, genesisHash: hash, ceilingMicros: DEVELOPMENT_BUDGET_CEILING_MICROS, settledMicros: 0, reservedMicros: 0, uncertainMicros: 0, remainingMicros: DEVELOPMENT_BUDGET_CEILING_MICROS };
  } finally { expectedSchema.close(); database.close(); }
}

function provision(location: BudgetLocation, receipt: string) {
  validateLocation(location, receipt);
  requireAbsent(location.directory);
  requireAbsent(receipt);
  const parent = dirname(location.directory);
  try { privateDirectory(parent); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const ancestor = dirname(parent);
    const stat = lstatSync(ancestor);
    requireSafe(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && realpathSync(ancestor) === ancestor);
    mkdirSync(parent, { mode: 0o700 });
    syncPath(ancestor, true);
    privateDirectory(parent);
  }
  // The receipt survives partial creation, so a later checkout cannot mistake failure for a fresh zero budget.
  appendReceipt(receipt, { type: "activation_started", id: location.id, directory: location.directory, purpose: location.purpose, ceilingMicros: DEVELOPMENT_BUDGET_CEILING_MICROS, confirmedPriorSpendMicros: 0, startedAt: new Date().toISOString() }, true);
  syncPath(parent, true);
  mkdirSync(location.directory, { mode: 0o700 });
  privateDirectory(location.directory);
  syncPath(parent, true);
  const files = budgetFiles(location);
  closeSync(openSync(files.database, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600));
  const identity: BudgetIdentity = { ...location, schemaVersion: 1, ceilingMicros: DEVELOPMENT_BUDGET_CEILING_MICROS, fileIdentity: privateFile(files.database) };
  const payload = canonicalJson({ type: "initialized", identity });
  const previousHash = "0".repeat(64);
  const hash = inputHash({ sequence: 1, payload, previousHash });
  const database = new DatabaseSync(files.database, { allowExtension: false, defensive: true, enableDoubleQuotedStringLiterals: false });
  try {
    database.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; BEGIN IMMEDIATE;");
    database.exec(BUDGET_SCHEMA);
    database.prepare("INSERT INTO authority(singleton,identity) VALUES(1,?)").run(canonicalJson(identity));
    database.prepare("INSERT INTO event(sequence,payload,previous_hash,hash) VALUES(1,?,?,?)").run(payload, previousHash, hash);
    const witness = openSync(files.witness, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(witness, `${JSON.stringify({ sequence: 1, hash })}\n`); fsyncSync(witness); } finally { closeSync(witness); }
    database.exec("COMMIT");
  } finally { database.close(); }
  syncPath(files.database);
  syncPath(location.directory, true);
  const result = verifyFreshActivation(location, receipt, hash);
  appendReceipt(receipt, { type: "activation_verified", genesisHash: hash, verifiedAt: new Date().toISOString() });
  syncPath(parent, true);
  verifyFreshActivation(location, receipt, hash);
  return result;
}

export function rehearseFakeActivation(location: BudgetLocation) {
  requireSafe(location.purpose === "fake");
  return provision(location, `${location.directory}.activation.jsonl`);
}

export function activateCanonicalBudget(confirmation: { identity: string; zeroPriorSpend: true }) {
  requireSafe(confirmation.identity === developmentBudgetLocation.id && confirmation.zeroPriorSpend === true && DEVELOPMENT_BUDGET_GENESIS_HASH === null);
  return provision(developmentBudgetLocation, DEVELOPMENT_BUDGET_ACTIVATION_RECORD);
}
