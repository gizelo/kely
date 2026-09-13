import { lookup as dnsLookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { request as httpsRequest } from "node:https";
import { AppError, requireCondition } from "./errors";
import { MAX_UPLOAD_BYTES, normalizeMaterial } from "./brand-materials";
import type { BrandSourceKind, BrandSourceOutcomeCode, BrandSourceState } from "../shared/brand";

const HTML_LIMIT = 512 * 1024;
const TIMEOUT_MS = 5_000;
const SOCIAL_HOSTS = new Set(["instagram.com", "www.instagram.com", "linkedin.com", "www.linkedin.com"]);

export interface AcquiredReference {
  sourceUrl: string;
  data: Buffer;
  width: number;
  height: number;
  bytes: number;
  hash: string;
}

export interface SourceAcquisitionOutcome {
  status: "imported" | "partial" | "fallback";
  imported: number;
  message: string;
  sourceUrl: string;
  kind: Exclude<BrandSourceKind, "upload" | "legacy">;
  state: BrandSourceState;
  code: Exclude<BrandSourceOutcomeCode, "upload_normalized">;
}

export type ResolvedAddress = { address: string; family: number };
type FetchResult = { contentType: string; bytes: Buffer };
type AcquisitionDependencies = {
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
  fetch?: (url: URL, addresses: ResolvedAddress[], limit: number) => Promise<FetchResult>;
};

function ipv4Number(address: string) {
  return address.split(".").reduce((value, part) => value * 256 + Number(part), 0) >>> 0;
}

function inV4(address: string, base: string, bits: number) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4Number(address) & mask) === (ipv4Number(base) & mask);
}

export function isPublicAddress(address: string) {
  const family = isIP(address);
  if (family === 4) {
    const blocked: [string, number][] = [
      ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
      ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
      ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
      ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
    ];
    return !blocked.some(([base, bits]) => inV4(address, base, bits));
  }
  if (family !== 6) return false;
  const normalized = address.toLowerCase();
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u)?.[1];
  if (mapped) return isPublicAddress(mapped);
  const mappedHex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u);
  if (mappedHex) {
    const value = parseInt(mappedHex[1], 16) * 65536 + parseInt(mappedHex[2], 16);
    return isPublicAddress(`${value >>> 24}.${(value >>> 16) & 255}.${(value >>> 8) & 255}.${value & 255}`);
  }
  return /^[23]/u.test(normalized) &&
    !/^2001:db8(?::|$)/u.test(normalized) &&
    !/^2001:(?:0{1,4})?(?::|$)/u.test(normalized) &&
    !/^2002(?::|$)/u.test(normalized);
}

export function parsePublicSource(value: string) {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new AppError("invalid_source", "Enter a complete public HTTPS URL."); }
  requireCondition(url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443"), "invalid_source", "Use a public HTTPS URL on the default port, without embedded credentials.");
  return url;
}

export function assertPublicResolution(addresses: ResolvedAddress[]) {
  requireCondition(addresses.length > 0 && addresses.length <= 16 && addresses.every((item) => (item.family === 4 || item.family === 6) && isPublicAddress(item.address)), "unsafe_source", "That source does not resolve only to public internet addresses.", 422);
}

async function resolvePublic(hostname: string) {
  let addresses: ResolvedAddress[];
  try { addresses = await dnsLookup(hostname, { all: true, verbatim: true }); }
  catch { throw new AppError("source_unavailable", "Kely could not resolve that public source. Upload screenshots instead.", 422); }
  assertPublicResolution(addresses);
  return addresses;
}

export function pinnedLookup(selected: ResolvedAddress): LookupFunction {
  return ((_hostname: string, options: { all?: boolean }, callback: (...args: any[]) => void) => {
    if (options?.all) callback(null, [{ address: selected.address, family: selected.family }]);
    else callback(null, selected.address, selected.family);
  }) as LookupFunction;
}

export async function pinnedFetch(url: URL, addresses: ResolvedAddress[], limit: number, requestImpl: typeof httpsRequest = httpsRequest): Promise<FetchResult> {
  const selected = addresses.find((item) => item.family === 4) ?? addresses[0];
  return new Promise((resolve, reject) => {
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error, value?: FetchResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) reject(error); else resolve(value!);
    };
    const request = requestImpl(url, {
      method: "GET",
      agent: false,
      headers: { Accept: "image/png,image/jpeg,text/html;q=0.8", "Accept-Encoding": "identity", "User-Agent": "Kely-Reference-Importer/1.0", Connection: "close" },
      lookup: pinnedLookup(selected),
    }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) { response.destroy(); finish(new AppError("source_redirect", "This source redirects. Paste its final public HTTPS URL or upload screenshots instead.", 422)); return; }
      if (status !== 200) { response.destroy(); finish(new AppError("source_unavailable", "That public source did not return usable content. Upload screenshots instead.", 422)); return; }
      if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") { response.destroy(); finish(new AppError("unsupported_source", "That source returned encoded content Kely cannot safely import. Upload screenshots instead.", 415)); return; }
      const chunks: Buffer[] = [];
      let total = 0;
      response.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > limit) response.destroy(new AppError("source_too_large", "That source is too large to import safely. Upload selected screenshots instead.", 413));
        else chunks.push(chunk);
      });
      response.on("end", () => finish(undefined, { contentType: String(response.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase(), bytes: Buffer.concat(chunks) }));
      response.on("error", (error) => finish(error instanceof AppError ? error : new AppError("source_unavailable", "Kely could not read that public source. Upload screenshots instead.", 422)));
    });
    deadline = setTimeout(() => {
      const error = new AppError("source_timeout", "That source took too long to respond. Upload screenshots instead.", 422);
      request.destroy(error);
      finish(error);
    }, TIMEOUT_MS);
    request.on("error", (error) => finish(error instanceof AppError ? error : new AppError("source_unavailable", "Kely could not read that public source. Upload screenshots instead.", 422)));
    request.end();
  });
}

function attributes(tag: string) {
  const result = new Map<string, string>();
  for (const match of tag.matchAll(/([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)) result.set(match[1].toLowerCase(), match[2] ?? match[3] ?? "");
  return result;
}

export function extractImageCandidates(html: string, pageUrl: URL) {
  const candidates: string[] = [];
  for (const match of html.matchAll(/<meta\b[^>]*>/giu)) {
    const attrs = attributes(match[0]);
    const key = (attrs.get("property") ?? attrs.get("name") ?? "").toLowerCase();
    if (!["og:image", "og:image:secure_url", "twitter:image", "twitter:image:src"].includes(key)) continue;
    try {
      const candidate = new URL(attrs.get("content") ?? "", pageUrl);
      if (candidate.protocol === "https:" && !candidate.username && !candidate.password && (!candidate.port || candidate.port === "443") && !candidates.includes(candidate.href)) candidates.push(candidate.href);
    } catch { /* Ignore malformed metadata and keep the truthful fallback. */ }
    if (candidates.length === 3) break;
  }
  return candidates;
}

function socialSource(url: URL) {
  const hostname = url.hostname.toLowerCase();
  return SOCIAL_HOSTS.has(hostname) || hostname.endsWith(".instagram.com") || hostname.endsWith(".linkedin.com");
}

export async function acquirePublicReferences(value: string, dependencies: AcquisitionDependencies = {}): Promise<{ references: AcquiredReference[]; outcome: SourceAcquisitionOutcome }> {
  const source = parsePublicSource(value);
  const resolve = dependencies.resolve ?? resolvePublic;
  const fetch = dependencies.fetch ?? pinnedFetch;
  const sourceAddresses = await resolve(source.hostname);
  assertPublicResolution(sourceAddresses);
  let first: FetchResult;
  try { first = await fetch(source, sourceAddresses, MAX_UPLOAD_BYTES); }
  catch (error) {
    if (error instanceof AppError && ["source_unavailable", "source_timeout", "source_redirect", "source_too_large", "unsupported_source"].includes(error.code)) {
      return {
        references: [],
        outcome: {
          status: "fallback" as const,
          imported: 0,
          sourceUrl: source.href,
          kind: socialSource(source) ? "social" : "website",
          state: "needs_upload",
          code: socialSource(source) ? "social_preview_missing" : "page_preview_missing",
          message: socialSource(source)
            ? "This social link did not expose a usable public preview. Kely did not read the post; upload screenshots of the exact posts for reliable reference quality."
            : "This public source did not expose a usable bounded preview. Upload selected screenshots instead.",
        },
      };
    }
    throw error;
  }
  const references: AcquiredReference[] = [];
  let pagePreview = false;
  if (["image/png", "image/jpeg"].includes(first.contentType)) {
    const normalized = await normalizeMaterial(first.bytes);
    references.push({ sourceUrl: source.href, ...normalized });
  } else {
    pagePreview = true;
    if (first.contentType !== "text/html") return { references, outcome: { status: "fallback", imported: 0, sourceUrl: source.href, kind: socialSource(source) ? "social" : "website", state: "needs_upload", code: socialSource(source) ? "social_preview_missing" : "page_preview_missing", message: "That URL is not a PNG, JPEG, or HTML page with public preview images. Upload selected screenshots instead." } };
    if (first.bytes.length > HTML_LIMIT) return { references, outcome: { status: "fallback", imported: 0, sourceUrl: source.href, kind: socialSource(source) ? "social" : "website", state: "needs_upload", code: socialSource(source) ? "social_preview_missing" : "page_preview_missing", message: "That page is too large to inspect safely. Upload selected screenshots instead." } };
    for (const value of extractImageCandidates(first.bytes.toString("utf8"), source)) {
      const imageUrl = parsePublicSource(value);
      try {
        const addresses = await resolve(imageUrl.hostname);
        assertPublicResolution(addresses);
        const image = await fetch(imageUrl, addresses, MAX_UPLOAD_BYTES);
        requireCondition(["image/png", "image/jpeg"].includes(image.contentType), "unsupported_image", "A public preview was not a PNG or JPEG.", 415);
        const normalized = await normalizeMaterial(image.bytes);
        references.push({ sourceUrl: imageUrl.href, ...normalized });
      } catch { /* One failed candidate does not turn another distinct candidate into a retry. */ }
      if (references.length === 3) break;
    }
  }
  const social = socialSource(source);
  const status: SourceAcquisitionOutcome["status"] = social || (pagePreview && references.length > 0) ? "partial" : references.length ? "imported" : "fallback";
  const message = social
    ? references.length
      ? `Imported ${references.length} public preview image${references.length === 1 ? "" : "s"}, but social platforms may expose only partial previews. Upload screenshots of the exact posts for reliable reference quality.`
      : "This social link did not expose usable public preview images. Upload screenshots of the exact posts for reliable reference quality."
    : references.length
      ? pagePreview
        ? `Imported ${references.length} public preview image${references.length === 1 ? "" : "s"}. A page preview is not a complete reading of the page or brand; upload exact screenshots when details matter.`
        : "Imported one direct public reference image. Nothing was analyzed or treated as reusable original material."
      : "No usable public preview images were exposed. Upload selected screenshots instead.";
  const kind = social ? "social" as const : pagePreview ? "website" as const : "direct_url" as const;
  const state: BrandSourceState = social ? references.length ? "partial" : "needs_upload" : pagePreview ? references.length ? "partial" : "needs_upload" : references.length ? "available" : "needs_upload";
  const code: Exclude<BrandSourceOutcomeCode, "upload_normalized"> = social ? references.length ? "social_preview_partial" : "social_preview_missing" : pagePreview ? references.length ? "page_preview_imported" : "page_preview_missing" : "direct_image_imported";
  return { references, outcome: { status, imported: references.length, message, sourceUrl: source.href, kind, state, code } satisfies SourceAcquisitionOutcome };
}
