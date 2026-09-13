import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { acquirePublicReferences, assertPublicResolution, extractImageCandidates, isPublicAddress, parsePublicSource, pinnedLookup } from "../src/server/source-acquisition";
import { AppError } from "../src/server/errors";

test("public source validation rejects credentials, non-default ports and every private or mixed DNS resolution", () => {
  assert.equal(parsePublicSource("https://example.com/post").href, "https://example.com/post");
  assert.throws(() => parsePublicSource("http://example.com"), { code: "invalid_source" });
  assert.throws(() => parsePublicSource("https://user:secret@example.com"), { code: "invalid_source" });
  assert.throws(() => parsePublicSource("https://example.com:8443"), { code: "invalid_source" });
  for (const address of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "192.168.1.2", "::1", "::ffff:7f00:1", "fd00::1", "fe80::1", "ff02::1", "2001:db8::1", "2001::1", "64:ff9b::a00:1", "2002::1"]) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress("93.184.216.34"), true);
  assert.equal(isPublicAddress("2606:2800:220:1:248:1893:25c8:1946"), true);
  assert.equal(isPublicAddress("2606:4700::1111"), true);
  assert.throws(() => assertPublicResolution([{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }]), { code: "unsafe_source" });
});

test("pinned lookup preserves the validated address for Node single and all-address callbacks", () => {
  const lookup = pinnedLookup({ address: "93.184.216.34", family: 4 });
  let single: unknown[] = [];
  let all: unknown[] = [];
  lookup("example.com", {}, (...args) => { single = args; });
  lookup("example.com", { all: true }, (...args) => { all = args; });
  assert.deepEqual(single, [null, "93.184.216.34", 4]);
  assert.deepEqual(all, [null, [{ address: "93.184.216.34", family: 4 }]]);
});

test("a generic HTML Open Graph result is explicitly partial, while a direct raster is imported", async () => {
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: "red" } }).png().toBuffer();
  const resolve = async () => [{ address: "93.184.216.34", family: 4 }];
  const html = await acquirePublicReferences("https://example.com/page", {
    resolve,
    async fetch(url) { return url.pathname === "/page" ? { contentType: "text/html", bytes: Buffer.from('<meta property="og:image" content="https://example.com/card.png">') } : { contentType: "image/png", bytes: png }; },
  });
  assert.equal(html.outcome.status, "partial");
  assert.deepEqual([html.outcome.kind, html.outcome.state, html.outcome.code], ["website", "partial", "page_preview_imported"]);
  assert.match(html.outcome.message, /not a complete reading/u);
  const direct = await acquirePublicReferences("https://example.com/card.png", { resolve, async fetch() { return { contentType: "image/png", bytes: png }; } });
  assert.equal(direct.outcome.status, "imported");
  assert.deepEqual([direct.outcome.kind, direct.outcome.state, direct.outcome.code], ["direct_url", "available", "direct_image_imported"]);
});

test("metadata extraction accepts only bounded HTTPS Open Graph and Twitter candidates", () => {
  const html = `<meta content="/one.jpg" property="og:image"><meta name='twitter:image' content='https://cdn.example/two.png'><meta property="og:image" content="http://unsafe.example/a.jpg"><meta property="og:image" content="https://cdn.example:8443/b.jpg"><meta property="og:image" content="https://cdn.example/two.png">`;
  assert.deepEqual(extractImageCandidates(html, new URL("https://example.com/post")), ["https://example.com/one.jpg", "https://cdn.example/two.png"]);
});

test("acquisition pins each distinct host once, normalizes previews, stays reference-only and reports social links as partial", async () => {
  const png = await sharp({ create: { width: 8, height: 6, channels: 3, background: "#123456" } }).png().toBuffer();
  const calls: string[] = [];
  const result = await acquirePublicReferences("https://www.instagram.com/p/example", {
    async resolve(hostname) { calls.push(`resolve:${hostname}`); return [{ address: "93.184.216.34", family: 4 }]; },
    async fetch(url) {
      calls.push(`fetch:${url.href}`);
      if (url.hostname === "www.instagram.com") return { contentType: "text/html", bytes: Buffer.from(`<meta property="og:image" content="https://cdn.example/preview.jpg">`) };
      return { contentType: "image/jpeg", bytes: await sharp(png).jpeg().toBuffer() };
    },
  });
  assert.equal(result.references.length, 1);
  assert.equal(result.references[0].sourceUrl, "https://cdn.example/preview.jpg");
  assert.equal((await sharp(result.references[0].data).metadata()).format, "png");
  assert.equal(result.outcome.status, "partial");
  assert.deepEqual([result.outcome.kind, result.outcome.state, result.outcome.code], ["social", "partial", "social_preview_partial"]);
  assert.match(result.outcome.message, /Upload screenshots/u);
  assert.deepEqual(calls, ["resolve:www.instagram.com", "fetch:https://www.instagram.com/p/example", "resolve:cdn.example", "fetch:https://cdn.example/preview.jpg"]);
});

test("unsafe initial resolution stops before any network request", async () => {
  let fetched = false;
  await assert.rejects(acquirePublicReferences("https://example.com", {
    async resolve() { return [{ address: "127.0.0.1", family: 4 }]; },
    async fetch() { fetched = true; return { contentType: "text/html", bytes: Buffer.alloc(0) }; },
  }), { code: "unsafe_source" });
  assert.equal(fetched, false);
});

test("an inaccessible known social URL returns an honest upload fallback, but an unsafe host still hard-fails", async () => {
  const result = await acquirePublicReferences("https://www.linkedin.com/posts/example", {
    async resolve() { return [{ address: "93.184.216.34", family: 4 }]; },
    async fetch() { throw new AppError("source_unavailable", "login wall", 422); },
  });
  assert.equal(result.outcome.status, "fallback");
  assert.deepEqual([result.outcome.kind, result.outcome.state, result.outcome.code], ["social", "needs_upload", "social_preview_missing"]);
  assert.equal(result.references.length, 0);
  assert.match(result.outcome.message, /did not read the post/u);
});
