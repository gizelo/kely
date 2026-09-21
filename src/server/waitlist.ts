import { randomUUID } from "node:crypto";
import { z } from "zod";
import { transaction } from "./db";
import { accessRateKey, enforceRateLimit } from "./beta-access";

const waitlistInput = z.object({
  email: z.string().trim().pipe(z.email().max(254)).transform((value) => value.toLowerCase()),
  consent: z.literal(true),
  source: z.literal("landing"),
}).strict();

export type WaitlistInput = z.input<typeof waitlistInput>;

export async function joinWaitlist(input: unknown) {
  const value = waitlistInput.parse(input);
  await enforceRateLimit(accessRateKey("waitlist", value.email), 3);
  await enforceRateLimit("waitlist-global", 120);
  await transaction(async (client) => {
    await client.query(
      `INSERT INTO waitlist_entry(id,email,source,consent_at)
       VALUES($1,$2,$3,now())
       ON CONFLICT(email) DO UPDATE SET updated_at=now()`,
      [randomUUID(), value.email, value.source],
    );
  });
  return { joined: true as const };
}
