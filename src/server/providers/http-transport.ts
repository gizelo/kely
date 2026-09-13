import { canonicalJson } from "../paid-input";
import { validateProviderRequest, type BoundedProviderRequest } from "./provider-envelope";

const RESPONSE_BYTES = 2_097_152;
export class ReceivedTransportError extends Error {
  constructor(readonly evidence: unknown) { super("A bounded provider response could not be verified."); }
}

export function serializeProviderRequest(request: BoundedProviderRequest) {
  const valid = validateProviderRequest(request);
  if ("accountingPolicy" in valid) {
    const { accountingPolicy: _policy, ...wire } = valid;
    return canonicalJson(wire);
  }
  return canonicalJson(valid);
}

export async function readProviderResponse(response: Response, image = false): Promise<unknown> {
  const requestId = (response.headers.get("x-request-id") ?? "").slice(0, 256);
  const evidence = { _request_id: requestId, http_status: response.status };
  const reader = response.body?.getReader();
  if (!reader) throw new ReceivedTransportError(evidence);
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > (image ? 16_777_216 : RESPONSE_BYTES)) { await reader.cancel(); throw new ReceivedTransportError({ ...evidence, response_limit_exceeded: true }); }
      parts.push(value);
    }
  } catch (error) {
    if (error instanceof ReceivedTransportError) throw error;
    throw new ReceivedTransportError(evidence);
  } finally { reader.releaseLock(); }
  const text = Buffer.concat(parts).toString("utf8");
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new ReceivedTransportError({ ...evidence, invalid_json: true, ...(image ? {} : { body_prefix: text.slice(0, 4096) }) }); }
  const result = body && typeof body === "object" && !Array.isArray(body) ? { ...body, ...evidence } : { ...evidence, body };
  if (!response.ok) throw new ReceivedTransportError(result);
  return result;
}
