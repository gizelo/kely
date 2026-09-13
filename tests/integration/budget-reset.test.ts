import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "pg";
import { BudgetStore } from "../../src/server/budget/store";
import { FakeProviderGateway } from "../../src/server/providers/gateway";
import { fakeAttempt, fakeResponse, initializeFakeBudget } from "../helpers/budget-fixture";

test("an actual disposable fixture database reset and gateway restart cannot reset external budget exposure", async () => {
  assert.match(process.env.KELY_DATABASE_URL ?? "", /\/kely_fixture_test$/);
  const name = `kely_budget_reset_${randomUUID().replaceAll("-", "")}`;
  assert.match(name, /^kely_budget_reset_[a-f0-9]{32}$/);
  const admin = new Client({ connectionString: process.env.KELY_DATABASE_URL });
  const disposableUrl = new URL(process.env.KELY_DATABASE_URL!);
  disposableUrl.pathname = `/${name}`;
  const fixture = new Client({ connectionString: disposableUrl.toString() });
  const directory = path.join(realpathSync(await mkdtemp(path.join(os.tmpdir(), "kely-budget-reset-"))), "authority");
  const location = initializeFakeBudget(directory);
  let budget = new BudgetStore(location);
  await admin.connect();
  let created = false;
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    created = true;
    await fixture.connect();
    const schema = (await Promise.all(["001_local", "002_paid_input", "003_generation_flow"].map((name) => readFile(new URL(`../../migrations/${name}.sql`, import.meta.url), "utf8")))).join("\n");
    await fixture.query(schema);
    await fixture.query('INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$2,$3,false)', [randomUUID(), "Disposable reset fixture", `${randomUUID()}@fixture.example.test`]);
    const complete = fakeAttempt();
    await new FakeProviderGateway(budget, { kind: "fake", async send(request) { return fakeResponse(request); } }).dispatch(complete);
    const unknown = fakeAttempt();
    await assert.rejects(new FakeProviderGateway(budget, { kind: "fake", async send() { throw new Error("fake timeout"); } }).dispatch(unknown), { code: "attempt_uncertain" });
    const before = budget.inspect();
    budget.close();
    assert.equal((await fixture.query("SELECT current_database() AS name")).rows[0].name, name);
    await fixture.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await fixture.query(schema);
    assert.equal((await fixture.query('SELECT count(*)::int AS total FROM "user"')).rows[0].total, 0);
    budget = new BudgetStore(location);
    assert.deepEqual(budget.inspect(), before);
    const restarted = new FakeProviderGateway(budget, { kind: "fake", async send() { assert.fail("Reset must not cause a repeated provider dispatch."); } });
    assert.equal((await restarted.dispatch(complete)).replayed, true);
    await assert.rejects(restarted.dispatch(unknown), { code: "attempt_uncertain" });
    assert.equal(budget.inspect().settledMicros, 44);
    assert.equal(budget.inspect().uncertainMicros, 532_373);
  } finally {
    budget.close();
    await fixture.end();
    if (created) await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  }
});
