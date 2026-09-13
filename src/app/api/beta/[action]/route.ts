import { z } from "zod";
import { config } from "@/server/config";
import { allowedLocalHost, allowedRequestOrigin, localHostDenied } from "@/server/request-boundary";
import { acceptBetaInvite, accessRateKey, enforceRateLimit, recoverBetaAccount } from "@/server/beta-access";
import { AppError } from "@/server/errors";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ action: string }> }) {
  if (!config.cloud || !allowedLocalHost(request) || !allowedRequestOrigin(request)) return localHostDenied();
  try {
    await enforceRateLimit("beta-access-global", 300);
    const reader = request.body?.getReader();
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    while (reader) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 4096) { await reader.cancel(); return Response.json({ error: "Request too large." }, { status: 413 }); }
      chunks.push(chunk.value);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof input?.token !== "string" || input.token.length !== 43) return Response.json({ error: "This private link is invalid." }, { status: 400 });
    await enforceRateLimit(accessRateKey("beta-link", input.token), 10);
    const { action } = await context.params;
    if (action === "invite") {
      if (process.env.KELY_BETA_ACCESS_ENABLED !== "true" || !process.env.KELY_OPERATOR_NAME || !process.env.KELY_SUPPORT_EMAIL) return Response.json({ error: "Invitations are not open yet." }, { status: 403 });
      await acceptBetaInvite(input);
    } else if (action === "recover") await recoverBetaAccount(input);
    else return Response.json({ error: "Not found." }, { status: 404 });
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AppError) return Response.json({ error: error.message }, { status: error.status });
    if (error instanceof z.ZodError || error instanceof SyntaxError) return Response.json({ error: "Check your details and try again." }, { status: 400 });
    return Response.json({ error: "Unable to complete this request. Contact the person who invited you." }, { status: 500 });
  }
}
