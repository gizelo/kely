import { createHash } from "node:crypto";
import type { GenerationOrigin, OperationKind, PublicationView, RevisionScope } from "../shared/contracts";
import { semanticTones, visualGrammars } from "../shared/semantic-direction";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  throw new Error("Paid input must contain only finite JSON data.");
}

export function inputHash(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export type PaidInputSnapshot = {
  schemaVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;
  semanticDirection?: {
    mode: "propose" | "inherit";
    allowedTones: import("../shared/semantic-direction").SemanticTone[];
    allowedGrammars: import("../shared/semantic-direction").VisualGrammar[];
    inherited: import("../shared/art-direction").ArtDirection;
  };
  brand?: import("../shared/brand").FrozenBrand;
  ownerId: string;
  quoteId: string;
  capturedAt: string;
  kind: OperationKind;
  instruction: string;
  generation?: { origin: GenerationOrigin; model: string; scope?: RevisionScope };
  publication: PublicationView;
  business: { name: string; context: string; website: string; provenance: "user_statement" | "not_provided"; websiteFetched: false };
};

export function snapshotPaidInput(ownerId: string, quoteId: string, kind: OperationKind, instruction: string, publication: PublicationView, business?: { name: string; context: string; website: string }): PaidInputSnapshot {
  return JSON.parse(canonicalJson({
    schemaVersion: 1, ownerId, quoteId, capturedAt: new Date().toISOString(), kind, instruction,
    publication,
    business: { name: business?.name ?? "Your business", context: business?.context ?? "", website: business?.website ?? "", provenance: business ? "user_statement" : "not_provided", websiteFetched: false },
  }));
}

export function verifyPaidInput(value: PaidInputSnapshot, hash: string) {
  const semanticValid = value?.schemaVersion !== 12 || Boolean(value.semanticDirection
    && ["propose", "inherit"].includes(value.semanticDirection.mode)
    && canonicalJson(value.semanticDirection.allowedTones) === canonicalJson([...semanticTones])
    && canonicalJson(value.semanticDirection.allowedGrammars) === canonicalJson([...visualGrammars])
    && value.semanticDirection.inherited?.policy === "art-direction-v1"
    && canonicalJson(value.semanticDirection.inherited) === canonicalJson(value.brand?.art?.direction));
  if (!value || !semanticValid || ![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].includes(value.schemaVersion) || (value.schemaVersion >= 2 && !value.brand) || (value.schemaVersion >= 3 && value.brand?.rendererPolicy !== "art-direction-v1") || (value.schemaVersion === 4 && value.publication.designPolicy !== "creative-intent-v1") || (value.schemaVersion === 5 && value.publication.designPolicy !== "creative-intent-v2") || (value.schemaVersion === 6 && value.publication.designPolicy !== "creative-intent-v3") || (value.schemaVersion === 7 && value.publication.designPolicy !== "creative-intent-v4") || (value.schemaVersion === 8 && value.publication.designPolicy !== "creative-intent-v5") || (value.schemaVersion === 9 && value.publication.designPolicy !== "creative-intent-v6") || (value.schemaVersion === 10 && value.publication.designPolicy !== "creative-intent-v7") || (value.schemaVersion === 11 && value.publication.designPolicy !== "creative-intent-v8") || (value.schemaVersion === 12 && (value.publication.designPolicy !== "creative-intent-v9" || !value.semanticDirection)) || (value.schemaVersion < 12 && value.semanticDirection) || (value.schemaVersion === 1 && value.brand) || !hash || inputHash(value) !== hash) throw new Error("Paid input snapshot is missing or invalid; request a new quote.");
  return structuredClone(value);
}
