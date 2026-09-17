import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/server/auth";
import { allowedLocalHost, allowedRequestOrigin, localHostDenied } from "@/server/request-boundary";
import { config } from "@/server/config";
import { accessRateKey, assertPublicSignupCapacity, enforceRateLimit, reservedInviteEmail } from "@/server/beta-access";
import { AppError } from "@/server/errors";

const handlers = toNextJsHandler(auth);
let activeSignups = 0;

export function GET(request: Request) {
  return allowedLocalHost(request) ? handlers.GET(request) : localHostDenied();
}

export async function POST(request: Request) {
  if (!allowedLocalHost(request) || !allowedRequestOrigin(request)) return localHostDenied();
  if (!config.cloud) return handlers.POST(request);
  const pathname = new URL(request.url).pathname;
  const isSignUp = pathname === "/api/auth/sign-up/email";
  if (!["/api/auth/sign-in/email", "/api/auth/sign-up/email", "/api/auth/sign-out"].includes(pathname)) return localHostDenied();
  if (isSignUp && !config.openSignup) return localHostDenied();
  try {
    const reader = request.body?.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    while (reader) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 8192) { await reader.cancel(); return Response.json({ message: "Request too large." }, { status: 413 }); }
      chunks.push(next.value);
    }
    const body = Buffer.concat(chunks).toString("utf8");
    if (pathname === "/api/auth/sign-in/email" || isSignUp) {
      const input = JSON.parse(body);
      if (typeof input.email !== "string" || input.email.length > 254) return Response.json({ message: "Check your sign-in details." }, { status: 400 });
      const kind = isSignUp ? "sign-up" : "sign-in";
      await enforceRateLimit(accessRateKey(kind, input.email), isSignUp ? 3 : 10);
      await enforceRateLimit(`${kind}-global`, isSignUp ? 60 : 300);
      if (isSignUp) {
        if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 100 || typeof input.password !== "string" || input.password.length < 10 || input.password.length > 128) return Response.json({ message: "Check your account details." }, { status: 400 });
        if (await reservedInviteEmail(input.email)) return Response.json({ message: "This email already has a private access link. Use that link to finish setup." }, { status: 409 });
        await assertPublicSignupCapacity();
        if (activeSignups >= 4) return Response.json({ message: "Account creation is busy. Try again in a moment." }, { status: 429 });
        activeSignups += 1;
        try { return await handlers.POST(new Request(request, { body })); }
        finally { activeSignups -= 1; }
      }
    }
    return handlers.POST(new Request(request, { body }));
  } catch (error) {
    return Response.json({ message: error instanceof AppError ? error.message : "Account access is temporarily unavailable." }, { status: error instanceof AppError ? error.status : 503 });
  }
}
