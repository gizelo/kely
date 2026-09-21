import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/server/auth";
import { allowedLocalHost, allowedRequestOrigin, localHostDenied } from "@/server/request-boundary";
import { config } from "@/server/config";
import { accessRateKey, clientRateKey, enforceRateLimit } from "@/server/beta-access";
import { AppError } from "@/server/errors";

const handlers = toNextJsHandler(auth);

function replay(request: Request, body: string) {
  return new Request(request.url, { method: request.method, headers: request.headers, body });
}

export function GET(request: Request) {
  return allowedLocalHost(request) ? handlers.GET(request) : localHostDenied();
}

export async function POST(request: Request) {
  if (!allowedLocalHost(request) || !allowedRequestOrigin(request)) return localHostDenied();
  const pathname = new URL(request.url).pathname;
  const isSignUp = pathname === "/api/auth/sign-up/email";
  if (isSignUp) return Response.json({ message: "Account creation is currently closed." }, { status: 403 });
  if (!config.cloud) return handlers.POST(request);
  if (!["/api/auth/sign-in/email", "/api/auth/sign-up/email", "/api/auth/sign-out"].includes(pathname)) return localHostDenied();
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
      await enforceRateLimit(accessRateKey("sign-in", input.email), 10);
      await enforceRateLimit(clientRateKey("sign-in", request), 30);
      await enforceRateLimit("sign-in-global", 300);
    }
    return handlers.POST(replay(request, body));
  } catch (error) {
    if (!(error instanceof AppError)) {
      const failure = error as { name?: unknown; message?: unknown; code?: unknown };
      console.error("Kely account access failed.", {
        name: typeof failure?.name === "string" ? failure.name : "UnknownError",
        code: typeof failure?.code === "string" ? failure.code : undefined,
      });
    }
    return Response.json({ message: error instanceof AppError ? error.message : "Account access is temporarily unavailable." }, { status: error instanceof AppError ? error.status : 503 });
  }
}
