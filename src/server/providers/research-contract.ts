import { z } from "zod";

export const MAX_RESEARCH_CONTEXT_BYTES = 48 * 1024;
export const MAX_DISCOVERY_CANDIDATES = 10;

const candidateSchema = z.object({
  id: z.string().trim().min(1).max(100),
  displayName: z.string().trim().min(1).max(200),
  canonicalUrl: z.string().url().refine((value) => new URL(value).protocol === "https:"),
  snippet: z.string().trim().max(500),
  sourceRole: z.enum(["official", "external_context"]),
  signals: z.object({ userSuppliedUrl: z.boolean(), officialSiteClaim: z.boolean(), exactNameMatch: z.boolean(), crossLinkedProfile: z.boolean() }).strict(),
}).strict();

const discoveryOutputSchema = z.object({ kind: z.literal("entity_discovery"), candidates: z.array(candidateSchema).max(MAX_DISCOVERY_CANDIDATES) }).strict();

export interface EntityDiscoveryRequest {
  kind: "entity_discovery";
  schemaVersion: "kely.entity-discovery.v1";
  stableInstructions: string;
  dynamicContext: string;
  maximumCandidates: 10;
}

export type EntityDiscoveryOutput = z.infer<typeof discoveryOutputSchema>;

export function buildEntityDiscoveryRequest(input: Pick<EntityDiscoveryRequest, "stableInstructions" | "dynamicContext">): EntityDiscoveryRequest {
  if (!input.stableInstructions.trim()) throw new Error("research_instructions_required");
  if (Buffer.byteLength(input.stableInstructions, "utf8") > 16 * 1024) throw new Error("research_instructions_too_large");
  if (Buffer.byteLength(input.dynamicContext, "utf8") > MAX_RESEARCH_CONTEXT_BYTES) throw new Error("research_context_too_large");
  return { kind: "entity_discovery", schemaVersion: "kely.entity-discovery.v1", maximumCandidates: 10, ...input };
}

export function parseEntityDiscoveryOutput(value: unknown): EntityDiscoveryOutput {
  const parsed = discoveryOutputSchema.parse(value);
  if (new Set(parsed.candidates.map((item) => item.id)).size !== parsed.candidates.length) throw new Error("discovery_candidate_duplicate");
  return parsed;
}
