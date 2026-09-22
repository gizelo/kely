import assert from "node:assert/strict";
import test from "node:test";
import { SupabaseObjectTransport } from "../src/server/private-storage";

test("private object transport authenticates server-side, disables upsert and never constructs a public URL", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const request = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  const storage = new SupabaseObjectTransport("https://abcdefghijklmnopqrst.supabase.co", "secret-service-key", "kely-private", request);
  await storage.put("asset/00000000-0000-4000-a000-000000000001.png", Buffer.from("image"));
  assert.equal(requests[0].url, "https://abcdefghijklmnopqrst.supabase.co/storage/v1/object/kely-private/asset/00000000-0000-4000-a000-000000000001.png");
  assert.equal(new Headers(requests[0].init?.headers).get("authorization"), "Bearer secret-service-key");
  assert.equal(new Headers(requests[0].init?.headers).get("x-upsert"), "false");
  assert.equal(requests[0].init?.redirect, "error");
  assert.ok(requests[0].init?.signal);
  assert.doesNotMatch(requests[0].url, /public/u);
});

test("private object transport handles missing objects and rejects provider failures", async () => {
  const statuses = [404, 500, 404];
  const request = (async () => new Response(null, { status: statuses.shift()! })) as typeof fetch;
  const storage = new SupabaseObjectTransport("https://abcdefghijklmnopqrst.supabase.co", "secret", "private", request);
  assert.equal(await storage.get("material/missing.png"), undefined);
  await assert.rejects(storage.put("asset/failure.png", Buffer.from("x")), /upload failed \(500\)/u);
  await storage.delete("asset/already-gone.png");
});

test("private object transport accepts a duplicate only when downloaded bytes match exactly", async () => {
  const replies = [new Response(null, { status: 400 }), new Response(Buffer.from("same"), { status: 200 }), new Response(null, { status: 409 }), new Response(Buffer.from("diff"), { status: 200 })];
  const request = (async () => replies.shift()!) as typeof fetch;
  const storage = new SupabaseObjectTransport("https://abcdefghijklmnopqrst.supabase.co", "secret", "private", request);
  await storage.put("asset/existing.png", Buffer.from("same"));
  await assert.rejects(storage.put("asset/conflict.png", Buffer.from("same")), /upload failed \(409\)/u);
});

test("private object transport rejects non-project origins and streaming overflow", async () => {
  assert.throws(() => new SupabaseObjectTransport("https://storage.example.test", "secret", "private"), /Invalid Supabase/u);
  const request = (async () => new Response(Buffer.from("too long"), { status: 200 })) as typeof fetch;
  const storage = new SupabaseObjectTransport("https://abcdefghijklmnopqrst.supabase.co", "secret", "private", request);
  await assert.rejects(storage.get("asset/oversized.png", 3), /exceeds its manifest size/u);
});
