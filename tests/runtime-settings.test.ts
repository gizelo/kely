import assert from "node:assert/strict";
import { test } from "node:test";
import { runtimeSettings } from "../src/server/runtime-settings";

test("cloud requires exact HTTPS origin and persistent secret without localhost fallback", () => {
  const env = { KELY_RUNTIME: "cloud", KELY_BASE_URL: "https://kely-beta.example.test", KELY_DATABASE_URL: "postgresql://fixture", KELY_AUTH_SECRET: "fixture-secret-not-a-real-credential-123" };
  assert.deepEqual(runtimeSettings(env), { cloud: true, openSignup: false, baseUrl: env.KELY_BASE_URL, origins: [env.KELY_BASE_URL] });
  assert.equal(runtimeSettings({ ...env, KELY_OPEN_SIGNUP_ENABLED: "true" }).openSignup, true);
  assert.throws(() => runtimeSettings({ ...env, KELY_BASE_URL: "http://localhost:3130" }));
  assert.throws(() => runtimeSettings({ ...env, KELY_BASE_URL: `${env.KELY_BASE_URL}/arbitrary` }));
  assert.throws(() => runtimeSettings({ ...env, KELY_AUTH_SECRET: undefined }));
});
