import assert from "node:assert/strict";
import test from "node:test";
import { secureDatabaseUrl } from "../src/server/database-url";

test("adds the pinned Supabase CA and strict TLS mode to the cloud pooler URL", () => {
  const original = "postgresql://postgres.fixture:secret@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require&uselibpqcompat=true";
  const secured = new URL(secureDatabaseUrl(original, true));

  assert.equal(secured.hostname, "aws-0-eu-central-1.pooler.supabase.com");
  assert.equal(secured.searchParams.get("sslmode"), "verify-full");
  assert.match(secured.searchParams.get("sslrootcert") ?? "", /certs\/supabase-prod-ca-2021\.crt$/u);
  assert.equal(secured.searchParams.has("uselibpqcompat"), false);
});

test("does not alter local or non-Supabase database URLs", () => {
  const local = "postgresql://kely:secret@127.0.0.1:55432/kely_fixture";
  const otherCloud = "postgresql://kely:secret@database.example.com:5432/kely?sslmode=verify-full";

  assert.equal(secureDatabaseUrl(local, false), local);
  assert.equal(secureDatabaseUrl(otherCloud, true), otherCloud);
});
