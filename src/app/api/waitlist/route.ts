import { ZodError } from "zod";
import { AppError } from "@/server/errors";
import { allowedLocalHost, allowedRequestOrigin, localHostDenied } from "@/server/request-boundary";
import { clientRateKey, enforceRateLimit } from "@/server/beta-access";
import { joinWaitlist } from "@/server/waitlist";

async function input(request: Request) {
  const declared = Number(request.headers.get("content-length")) || 0;
  if (declared > 4096) throw new AppError("body_too_large", "The request is too large.", 413);
  const bytes = Buffer.from(await request.arrayBuffer());
  if (bytes.byteLength > 4096) throw new AppError("body_too_large", "The request is too large.", 413);
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { throw new AppError("invalid_json", "Send a valid request.", 400); }
}

export async function POST(request: Request) {
  if (!allowedLocalHost(request) || !allowedRequestOrigin(request)) return localHostDenied();
  try {
    const value = await input(request);
    await enforceRateLimit(clientRateKey("waitlist", request), 10);
    return Response.json(await joinWaitlist(value), {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof ZodError) return Response.json({ error: { code: "invalid_input", message: "Enter a valid email and accept the waitlist notice." } }, { status: 400 });
    if (error instanceof AppError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
    console.error("Kely waitlist request failed without logging submitted data.");
    return Response.json({ error: { code: "server_error", message: "The waitlist is temporarily unavailable." } }, { status: 503 });
  }
}
