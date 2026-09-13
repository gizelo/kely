import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/server/auth";
import { allowedLocalHost, allowedRequestOrigin, localHostDenied } from "@/server/request-boundary";
import { config } from "@/server/config";
import { accessRateKey, enforceRateLimit } from "@/server/beta-access";
import { AppError } from "@/server/errors";

const handlers = toNextJsHandler(auth);

export function GET(request: Request) {
  return allowedLocalHost(request) ? handlers.GET(request) : localHostDenied();
}

export async function POST(request: Request) {
  if (!allowedLocalHost(request) || !allowedRequestOrigin(request)) return localHostDenied();
  if (!config.cloud) return handlers.POST(request);
  const pathname = new URL(request.url).pathname;
  if (!["/api/auth/sign-in/email", "/api/auth/sign-out"].includes(pathname)) return localHostDenied();
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
    if (pathname === "/api/auth/sign-in/email") {
      const input = JSON.parse(body);
      if (typeof input.email !== "string" || input.email.length > 254) return Response.json({ message: "Check your sign-in details." }, { status: 400 });
      await enforceRateLimit(accessRateKey("sign-in", input.email), 10);
      await enforceRateLimit("sign-in-global", 300);
    }
    return handlers.POST(new Request(request, { body }));
  } catch (error) {
    return Response.json({ message: error instanceof AppError ? error.message : "Sign in is temporarily unavailable." }, { status: error instanceof AppError ? error.status : 503 });
  }
}
