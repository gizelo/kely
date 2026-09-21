import { createHash } from "node:crypto";
import type { BrandEvidenceRecord, EvidenceRole, EvidenceSourceKind } from "../shared/brand-intelligence";
import { evidenceRecordFromSpan } from "./brand-intelligence";
import { extractPublicSourceSignals } from "./source-discovery";
import { assertPublicResolution, parsePublicSource, pinnedFetch, resolvePublic, type AcquisitionDependencies } from "./source-acquisition";

const HTML_LIMIT = 512 * 1024;
export const RESEARCH_SOURCE_CAPS = { officialPages: 5, socialSources: 2, externalSources: 3 } as const;

export interface ResearchSourceSeed { url: string; role: EvidenceRole; kind: EvidenceSourceKind; candidateId?: string; expectedName?: string }
export interface ResearchSourceOutcome { url: string; role: EvidenceRole; kind: EvidenceSourceKind; candidateId?: string; status: "complete" | "partial" | "failed"; reason?: string; identity?: { exactNameMatch: boolean; canonicalSameHost: boolean; linkedSocialProfile: boolean } }
export interface ResearchAcquisitionResult { evidence: BrandEvidenceRecord[]; outcomes: ResearchSourceOutcome[] }

function evidenceId(namespace: string, url: string, excerpt: string, index: number) {
  const hash = createHash("sha256").update(`${namespace}\n${url}\n${excerpt}\n${index}`, "utf8").digest("hex").slice(0, 32);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`;
}

function exactSpans(content: string) {
  const spans: { start: number; end: number }[] = [];
  let start = 0;
  while (start < content.length && spans.length < 8) {
    const end = Math.min(content.length, start + 500);
    if (content.slice(start, end).trim()) spans.push({ start, end });
    start = end;
  }
  return spans;
}

function boundedSeeds(seeds: ResearchSourceSeed[]) {
  const counts = { official: 0, social: 0, external: 0 };
  const seen = new Set<string>();
  return seeds.filter((seed) => {
    const url = parsePublicSource(seed.url).href;
    if (seen.has(url)) return false;
    if (seed.role === "external_context") { if (++counts.external > RESEARCH_SOURCE_CAPS.externalSources) return false; }
    else if (seed.kind === "social") { if (++counts.social > RESEARCH_SOURCE_CAPS.socialSources) return false; }
    else if (++counts.official > RESEARCH_SOURCE_CAPS.officialPages) return false;
    seen.add(url); return true;
  });
}

function normalizedName(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("en").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function pageNames(title: string) {
  return title.split(/\s(?:\||—|–|-)\s/gu).map(normalizedName).filter(Boolean);
}

export async function acquireResearchSources(seeds: ResearchSourceSeed[], fetchedAt: string, dependencies: AcquisitionDependencies = {}, evidenceNamespace = "standalone"): Promise<ResearchAcquisitionResult> {
  const resolve = dependencies.resolve ?? resolvePublic;
  const fetch = dependencies.fetch ?? pinnedFetch;
  const queue = boundedSeeds(seeds);
  const evidence: BrandEvidenceRecord[] = [];
  const outcomes: ResearchSourceOutcome[] = [];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const seed = queue[cursor]; const url = parsePublicSource(seed.url);
    try {
      const addresses = await resolve(url.hostname); assertPublicResolution(addresses);
      const response = await fetch(url, addresses, HTML_LIMIT);
      if (response.contentType !== "text/html" || response.bytes.length > HTML_LIMIT) { outcomes.push({ ...seed, url: url.href, status: "failed", reason: "unsupported_content" }); continue; }
      const signals = extractPublicSourceSignals(response.bytes.toString("utf8"), url);
      const content = signals.visibleText;
      for (const [index, span] of exactSpans(content).entries()) evidence.push(evidenceRecordFromSpan({ id: evidenceId(evidenceNamespace, url.href, content.slice(span.start, span.end), index), sourceKind: seed.kind, sourceRole: seed.role, sourceUrl: url.href, content, span, fetchedAt }));
      const identity = seed.candidateId && seed.expectedName ? {
        exactNameMatch: pageNames(signals.title).includes(normalizedName(seed.expectedName)),
        canonicalSameHost: Boolean(signals.canonicalUrl && new URL(signals.canonicalUrl).hostname === url.hostname),
        linkedSocialProfile: signals.socialProfiles.length > 0,
      } : undefined;
      outcomes.push({ ...seed, url: url.href, status: content ? "complete" : "partial", ...(content ? {} : { reason: "no_visible_text" }), ...(identity ? { identity } : {}) });
      if (seed.role === "official" && seed.kind === "website") {
        const additions: ResearchSourceSeed[] = [
          ...signals.sameOriginPages.map((page) => ({ url: page, role: "official" as const, kind: "website" as const })),
          ...signals.socialProfiles.map((profile) => ({ url: profile, role: "official" as const, kind: "social" as const })),
        ];
        queue.push(...boundedSeeds([...queue, ...additions]).filter((item) => !queue.some((existing) => parsePublicSource(existing.url).href === parsePublicSource(item.url).href)));
      }
    } catch (error) {
      outcomes.push({ ...seed, url: url.href, status: "failed", reason: error instanceof Error ? error.name : "source_unavailable" });
    }
  }
  return { evidence, outcomes };
}
