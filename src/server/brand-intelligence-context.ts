import type { BrandEvidenceRecord, BrandResearchInput } from "../shared/brand-intelligence";
import { MAX_RESEARCH_CONTEXT_BYTES } from "./providers/research-contract";

function utf8Prefix(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximumBytes) return value;
  return bytes.subarray(0, maximumBytes).toString("utf8").replace(/\uFFFD$/u, "");
}

export function assembleResearchContext(input: BrandResearchInput, evidence: BrandEvidenceRecord[]): string {
  const header = JSON.stringify({ businessName: input.businessName, category: input.category, location: input.location, idea: input.idea, platform: input.platform });
  const ordered = [...evidence].sort((a, b) => {
    const priority = { user_provided: 0, official: 1, external_context: 2 } as const;
    return priority[a.sourceRole] - priority[b.sourceRole] || a.id.localeCompare(b.id);
  });
  const lines = [`INPUT ${header}`];
  for (const item of ordered) {
    const prefix = `${item.sourceRole.toUpperCase()} ${item.id} ${item.sourceUrl} [${item.span.start},${item.span.end}] `;
    const remaining = MAX_RESEARCH_CONTEXT_BYTES - Buffer.byteLength(lines.join("\n"), "utf8") - Buffer.byteLength(prefix, "utf8") - 1;
    if (remaining <= 0) break;
    lines.push(prefix + utf8Prefix(item.excerpt, remaining));
  }
  return lines.join("\n");
}
