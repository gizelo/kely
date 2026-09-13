import { z, ZodError } from "zod";
import { auth } from "./auth";
import { accountView, saveBusiness, simulateBilling, type Viewer } from "./credits";
import { AppError, requireCondition } from "./errors";
import { acceptQuote, addMessage, approvePublication, createPublication, listPublications, quoteOperation, readPublication, updatePublicationBrief } from "./publications";
import { operationView } from "./operations";
import { exportPublication, readAsset } from "./renderer";
import { config } from "./config";
import { allowedLocalHost, allowedRequestOrigin } from "./request-boundary";
import { enforceRateLimit } from "./beta-access";
import { archiveBrandMaterial, importBrandReferences, readBrand, readBrandMaterial, readSourceBundle, rememberBrand, requireBrandAccess, undoBrand, updateBrandRule, updateSourceStrategy, uploadBrandMaterial } from "./brand";
import { readUpload } from "./brand-materials";
import { artDirectionSchema } from "./art-direction";
import { confirmPreference } from "./preferences";
import { acceptAnalysis, analysisDerivative, applyAnalysis, listAnalyses, quoteAnalysis, readAnalysis } from "./brand-analysis";
import { acceptCreation, cancelCreation, generateCreation, quoteCreation, quoteCreationRevision, readCreation, replyCreation } from "./creation";

const uuid = z.uuid();
const version = z.number().int().positive();
const smallText = z.string().trim().min(1).max(2000);

async function body(request: Request) {
  requireCondition((Number(request.headers.get("content-length")) || 0) <= 24_000, "body_too_large", "The request is too large.", 413);
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (reader) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > 24_000) { await reader.cancel(); throw new AppError("body_too_large", "The request is too large.", 413); }
    chunks.push(chunk.value);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try { return JSON.parse(text); } catch { throw new AppError("invalid_json", "Send a valid JSON request."); }
}

async function viewer(request: Request): Promise<Viewer> {
  const session = await auth.api.getSession({ headers: request.headers });
  requireCondition(session, "unauthenticated", "Sign in to your local Kely account.", 401);
  return { id: session.user.id, name: session.user.name, email: session.user.email };
}

export async function handleApi(request: Request, path: string[]) {
  try {
    const url = new URL(request.url);
    requireCondition(allowedLocalHost(request), "origin_denied", "The request host is not allowed.", 403);
    if (request.method !== "GET") requireCondition(allowedRequestOrigin(request), "origin_denied", "The request origin is not allowed.", 403);
    const user = await viewer(request);
    if (config.cloud && request.method !== "GET") await enforceRateLimit(`write:${user.id}`, 30);
    const [resource, id, action] = path;
    let result: unknown;
    if (resource === "creations") {
      if (id === "quote" && request.method === "POST") result = await quoteCreation(user, z.object({ idea: smallText, context: z.string().trim().max(1800).optional(), platform: z.enum(["linkedin", "instagram"]), slideCount: z.number().int().min(1).max(6).optional(), language: z.string().trim().max(40).optional(), sourceAnalysisId: uuid.optional(), analysisMaterialIds: z.array(uuid).max(3).optional() }).strict().parse(await body(request)));
      else if (id === "accept" && request.method === "POST") {
        const input = z.object({ quoteId: uuid, requestKey: z.string().min(8).max(100) }).strict().parse(await body(request));
        result = await acceptCreation(user, input.quoteId, input.requestKey);
      } else if (id) {
        uuid.parse(id);
        if (!action && request.method === "GET") result = await readCreation(user.id, id);
        else if (action === "reply" && request.method === "POST") result = await replyCreation(user, id, z.object({ version, message: smallText, requestKey: z.string().min(8).max(100) }).strict().parse(await body(request)));
        else if (action === "generate" && request.method === "POST") result = await generateCreation(user, id, z.object({ version, planVersion: version, planHash: z.string().regex(/^[a-f0-9]{64}$/u), requestKey: z.string().min(8).max(100) }).strict().parse(await body(request)));
        else if (action === "cancel" && request.method === "POST") result = await cancelCreation(user, id, z.object({ version }).strict().parse(await body(request)).version);
      }
    } else if (resource === "brand-analyses") {
      if (!id && request.method === "GET") result = await listAnalyses(user.id);
      else if (id === "quote" && request.method === "POST") result = await quoteAnalysis(user, z.object({ materialIds: z.array(uuid).min(1).max(3), guidance: z.string().max(8000), version: z.number().int().min(0) }).strict().parse(await body(request)));
      else if (id) {
        uuid.parse(id);
        if (!action && request.method === "GET") result = await readAnalysis(user.id, id);
        else if (action === "image" && request.method === "GET") {
          const bytes = await analysisDerivative(user.id, id, uuid.parse(url.searchParams.get("materialId")));
          return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
        } else if (action === "accept" && request.method === "POST") result = await acceptAnalysis(user, id, z.object({ requestKey: z.string().min(8).max(100) }).strict().parse(await body(request)).requestKey);
        else if (action === "apply" && request.method === "POST") result = await applyAnalysis(user, id, z.object({ version: z.number().int().min(0), commandKey: z.string().min(8).max(100) }).strict().parse(await body(request)));
      }
    }
    else if (resource === "brand" && !id && request.method === "GET") result = await readBrand(user.id);
    else if (resource === "brand" && id === "source-bundle" && request.method === "GET") result = await readSourceBundle(user.id);
    else if (resource === "brand" && request.method === "POST") {
      const brandVersion = z.number().int().min(0);
      const commandKey = z.string().min(8).max(100);
      if (id === "rules") result = await updateBrandRule(user, z.object({ field: z.enum(["audience", "palette", "headlines", "voice"]), value: z.string().max(500).nullable(), version: brandVersion, commandKey }).strict().parse(await body(request)));
      else if (id === "source-strategy") {
        const input = z.object({ strategy: z.enum(["use_materials", "use_preferences", "decide_for_me"]), version: brandVersion, commandKey }).strict().parse(await body(request));
        result = await updateSourceStrategy(user, input.strategy, input.version, input.commandKey);
      }
      else if (id === "direction") {
        const input = z.object({ direction: artDirectionSchema.nullable(), version: brandVersion, commandKey }).strict().parse(await body(request));
        result = await updateBrandRule(user, { field: "artDirection", value: input.direction, version: input.version, commandKey: input.commandKey });
      }
      else if (id === "memory") {
        const input = z.object({ text: z.string().trim().min(1).max(1000), version: brandVersion, commandKey }).strict().parse(await body(request));
        result = await rememberBrand(user, input.text, input.version, input.commandKey);
      } else if (id === "undo") {
        const input = z.object({ eventId: uuid, commandKey }).strict().parse(await body(request));
        result = await undoBrand(user, input.eventId, input.commandKey);
      } else if (id === "import") result = await importBrandReferences(user, z.object({ label: z.string().trim().min(1).max(100), sourceUrl: z.string().trim().max(2000), version: brandVersion, commandKey: z.string().min(8).max(100).optional() }).strict().parse(await body(request)));
      else if (id === "upload") {
        await requireBrandAccess(user);
        requireCondition(["image/png", "image/jpeg"].includes(request.headers.get("content-type") ?? ""), "unsupported_image", "Send a PNG or JPEG image directly, not multipart data.", 415);
        const input = z.object({ role: z.enum(["reference", "original"]), label: z.string().trim().min(1).max(100), version: z.coerce.number().int().min(0), fallbackForSourceId: z.uuid().optional(), commandKey: z.string().min(8).max(100).optional() }).parse(Object.fromEntries(url.searchParams));
        result = await uploadBrandMaterial(user, { ...input, bytes: await readUpload(request) });
      }
    } else if (resource === "brand-materials" && id) {
      uuid.parse(id);
      if (request.method === "GET" && !action) {
        const material = await readBrandMaterial(user.id, id);
        return new Response(new Uint8Array(material.bytes), { headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
      } else if (request.method === "POST" && action === "archive") {
        const input = z.object({ version: z.number().int().min(0) }).strict().parse(await body(request));
        result = await archiveBrandMaterial(user, id, input.version);
      }
    } else if (resource === "account" && request.method === "GET") result = await accountView(user);
    else if (resource === "business" && request.method === "POST") {
      const input = z.object({ name: z.string().trim().min(1).max(100), context: z.string().max(6000).default(""), website: z.string().max(2000).default("") }).parse(await body(request));
      result = await saveBusiness(user, input);
    } else if (resource === "billing" && id === "simulate" && request.method === "POST") {
      requireCondition(!config.cloud, "not_available", "Billing is not available during the private beta.", 403);
      const input = z.object({ action: z.enum(["activate", "upgrade", "topup", "cancel", "resume", "schedule_change", "clear_change", "renew"]), tier: z.enum(["starter", "studio"]).optional(), cadence: z.enum(["monthly", "annual"]).optional(), eventKey: z.string().min(8).max(100).optional() }).strict().parse(await body(request));
      result = await simulateBilling(user, input.action, input.tier, input.cadence, new Date(), input.eventKey);
    } else if (resource === "publications" && !id && request.method === "GET") result = await listPublications(user.id);
    else if (resource === "publications" && !id && request.method === "POST") {
      const input = z.object({ idea: smallText, platform: z.enum(["linkedin", "instagram"]), slideCount: z.number().int().min(1).max(6), language: z.string().trim().max(40).optional(), sourceAnalysisId: z.uuid().optional() }).parse(await body(request));
      result = await createPublication(user, input);
    } else if (resource === "publications" && id) {
      uuid.parse(id);
      if (!action && request.method === "GET") result = await readPublication(user.id, id);
      else if (action === "preferences" && request.method === "POST") result = await confirmPreference(user, id, z.object({ proposalId: uuid, scope: z.enum(["durable", "local"]), version, brandVersion: z.number().int().min(0), commandKey: z.string().min(8).max(100) }).strict().parse(await body(request)));
      else if (action === "brief" && request.method === "POST") {
        const input = z.object({ version, audience: z.string().trim().max(500), direction: z.enum(["indigo", "forest", "rose", "sand", "decide"]).nullable(), requiredMaterialIds: z.array(uuid).max(20), noPhoto: z.boolean(), blockingFacts: z.array(z.string().trim().min(1).max(200)).max(5).default([]), factResolution: z.string().trim().max(1000).default("") }).strict().parse(await body(request));
        const { version: expected, ...brief } = input;
        result = await updatePublicationBrief(user, id, expected, brief);
      }
      else if (action === "messages" && request.method === "POST") {
        const input = z.object({ text: smallText, version }).parse(await body(request));
        result = await addMessage(user, id, input.text, input.version);
      } else if (action === "approve" && request.method === "POST") {
        const input = z.object({ stage: z.enum(["content", "cover"]), version }).parse(await body(request));
        result = await approvePublication(user, id, input.stage, input.version);
      } else if (action === "quote" && request.method === "POST") {
        const input = z.object({ kind: z.enum(["prepare", "cover", "remaining", "revise"]), version, instruction: z.string().trim().max(2000).optional() }).strict().parse(await body(request));
        const publication = await readPublication(user.id, id);
        result = publication.creation && input.kind === "revise" ? await quoteCreationRevision(user, id, input.version, input.instruction ?? "") : await quoteOperation(user, id, input.kind, input.version, input.instruction);
      } else if (action === "export" && request.method === "GET") {
        const format = z.enum(["png", "zip", "pdf", "caption"]).parse(url.searchParams.get("format") ?? "zip");
        const selectedVersion = url.searchParams.has("version") ? z.coerce.number().int().positive().parse(url.searchParams.get("version")) : undefined;
        const exported = await exportPublication(user.id, id, format, selectedVersion);
        return new Response(new Uint8Array(exported.bytes), { headers: { "Content-Type": exported.contentType, "Content-Disposition": `attachment; filename="${exported.filename}"`, "Cache-Control": "private, no-store" } });
      }
    } else if (resource === "quotes" && id && action === "accept" && request.method === "POST") {
      uuid.parse(id);
      const input = z.object({ idempotencyKey: z.string().min(8).max(100) }).parse(await body(request));
      result = await acceptQuote(user, id, input.idempotencyKey);
    } else if (resource === "operations" && id && request.method === "GET") result = await operationView(user.id, uuid.parse(id));
    else if (resource === "assets" && id && request.method === "GET") {
      const asset = await readAsset(user.id, uuid.parse(id));
      return new Response(new Uint8Array(asset.bytes), { headers: { "Content-Type": asset.contentType, "Cache-Control": "private, no-store" } });
    }
    requireCondition(result !== undefined, "not_found", "That endpoint is not available.", 404);
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof ZodError) return Response.json({ error: { code: "invalid_input", message: "Check the required fields and their allowed lengths." } }, { status: 400 });
    if (error instanceof AppError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
    console.error("Kely request failed; no credentials or request bodies are logged.");
    return Response.json({ error: { code: "server_error", message: "The local service could not complete this request. Your saved work is preserved." } }, { status: 500 });
  }
}
