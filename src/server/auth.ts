import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { config, localAuthSecret } from "./config";
import { db } from "./db";
import * as schema from "./db/schema";

export const auth = betterAuth({
  appName: "Kely",
  baseURL: config.baseUrl,
  secret: localAuthSecret(),
  telemetry: { enabled: false },
  trustedOrigins: config.origins,
  database: drizzleAdapter(db, { provider: "pg", schema }),
  emailAndPassword: { enabled: true, minPasswordLength: 10, requireEmailVerification: false, disableSignUp: config.cloud },
  advanced: { useSecureCookies: config.cloud },
});
