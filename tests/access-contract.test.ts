import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "../src/app/api/auth/[...all]/route";
import { POST as betaPost } from "../src/app/api/beta/[action]/route";
import { clientRateKey } from "../src/server/beta-access";

test("email signup is closed server-side even when the legacy env flag is set", async () => {
  const response = await POST(new Request("http://localhost:3130/api/auth/sign-up/email", {
    method: "POST",
    headers: { host: "localhost:3130", origin: "http://localhost:3130", "content-type": "application/json" },
    body: JSON.stringify({ email: "new@example.test", name: "New", password: "password-long-enough" }),
  }));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { message: "Account creation is currently closed." });
});

test("client limiter uses the proxy-appended address rather than a spoofable first value", () => {
  const request = new Request("http://localhost:3130", { headers: { "x-forwarded-for": "spoofed, 203.0.113.8" } });
  assert.equal(clientRateKey("sign-in", request), clientRateKey("sign-in", new Request("http://localhost:3130", { headers: { "x-real-ip": "203.0.113.8" } })));
});

test("legacy invite action stays unavailable regardless of invitation environment flags", async () => {
  const response = await betaPost(new Request("http://localhost:3130/api/beta/invite", {
    method: "POST",
    headers: { host: "localhost:3130", origin: "http://localhost:3130", "content-type": "application/json" },
    body: JSON.stringify({ token: "A".repeat(43) }),
  }), { params: Promise.resolve({ action: "invite" }) });
  assert.equal(response.status, 404);
});
