import { createHash } from "node:crypto";
import { z } from "zod";
import type { BriefField, ProposedBrief } from "../shared/creative-intent";
import type { PreferenceProposal } from "../shared/preferences";
import { proposedBriefSchema, validateProposedBrief } from "./creative-intent";
import { requireCondition } from "./errors";
import { canonicalJson, type PaidInputSnapshot } from "./paid-input";

type SourceEntry = { id: string; basis: "user" | "business"; sourceId: string; start: number; end: number; text: string };
export function sourceCatalogueV4(snapshot: PaidInputSnapshot) {
  const users = snapshot.publication.messages.filter((message) => message.role === "user");
  const revision = snapshot.schemaVersion >= 9 && snapshot.kind === "revise" && snapshot.instruction.trim()
    ? [{ id: snapshot.quoteId, role: "user" as const, text: snapshot.instruction.trim() }]
    : [];
  const ordered = users.length ? [users[0], ...revision, ...users.slice(1).reverse()] : revision;
  const sources = [
    ...ordered.map((message) => ({ basis: "user" as const, sourceId: message.id, text: message.text })),
    { basis: "business" as const, sourceId: "name", text: snapshot.business.name },
    { basis: "business" as const, sourceId: "context", text: snapshot.business.context },
  ];
  const entries: SourceEntry[] = [];
  let omittedSpans = 0;
  for (const source of sources) {
    let start = 0;
    const ends = [...source.text.matchAll(/[.!?;](?=\s|$)/gu)].map((match) => match.index + match[0].length);
    if (ends.at(-1) !== source.text.length) ends.push(source.text.length);
    for (const end of ends) {
      const raw = source.text.slice(start, end);
      const text = raw.trim();
      const exactStart = start + raw.length - raw.trimStart().length;
      start = end;
      if (!text) continue;
      if (text.length > 500) { omittedSpans++; continue; }
      const data = { basis: source.basis, sourceId: source.sourceId, start: exactStart, end: exactStart + text.length, text };
      const entry = { id: `s_${createHash("sha256").update(canonicalJson(data)).digest("hex").slice(0, 40)}`, ...data };
      if (entries.some((item) => item.id === entry.id)) continue;
      if (entries.length === 31 || Buffer.byteLength(canonicalJson([...entries, entry])) > 16_384) { omittedSpans++; continue; }
      entries.push(entry);
    }
  }
  return { entries, omittedSpans };
}

const selectedField = z.object({ sourceRef: z.string(), proposal: z.string().max(500) }).strict();
const referencedBrief = z.object({ audience: selectedField, desiredAction: selectedField, facts: z.array(z.string()).max(5), requiredFacts: z.array(z.string().trim().min(1).max(300)).max(3) }).strict();

export function decodeBriefV4(value: unknown, snapshot: PaidInputSnapshot): ProposedBrief {
  const raw = referencedBrief.parse(value);
  const entries = sourceCatalogueV4(snapshot).entries;
  const source = (id: string): BriefField => {
    const entry = entries.find((item) => item.id === id);
    requireCondition(entry, "brief_evidence_invalid", "Select an exact source-catalogue entry or label the interpretation as proposed.", 422);
    return { value: entry.text, evidence: entry.text, basis: entry.basis, sourceId: entry.sourceId };
  };
  const field = (item: z.infer<typeof selectedField>): BriefField => item.sourceRef === "proposed" ? { value: item.proposal, basis: "proposed", sourceId: "", evidence: "" } : source(item.sourceRef);
  return validateProposedBrief(proposedBriefSchema.parse({ audience: field(raw.audience), desiredAction: field(raw.desiredAction), facts: [...new Set(raw.facts)].filter((id) => id !== "none").map(source), requiredFacts: raw.requiredFacts }), snapshot);
}

const local = /(?:this post only|only (?:for|in) this post|for this post|nur (?:für|in) diesem? (?:post|beitrag)|только (?:для|в) это(?:го|м) пост[ае])/iu;
const durable = /(?:\balways\b|\bfrom now on\b|\bfor (?:all|every|our brand)\b|\bimmer\b|\bab jetzt\b|всегда|для всех (?:постов|публикаций)|для нашего бренда)/iu;
function preferenceScope(entry: string, message: string, proposed: PreferenceProposal["scope"]): PreferenceProposal["scope"] {
  if (local.test(entry)) return "local";
  if (local.test(message) && durable.test(message)) return "ambiguous";
  if (local.test(message) || proposed === "local") return "local";
  return proposed === "durable" && durable.test(entry) && !entry.endsWith("?") ? "durable" : "ambiguous";
}
const suggestion = z.object({ sourceRef: z.string(), value: z.string().trim().min(1).max(500), scope: z.enum(["durable", "local", "ambiguous"]) }).strict();
const fieldEvidence = {
  audience: /(?:audience|customer|client|guest|visitor|reader|follower|people|person|founder|owner|team|who (?:this|it) is for|target|аудитор|клиент|гост|читател|подписчик|люд|человек|владел|команд|для кого|zielgruppe|kund|gast|leser|follower|menschen|gründer|inhaber|team)/iu,
  voice: /(?:voice|tone|style|sound|wording|write|copy|clear|direct|warm|friendly|calm|formal|casual|approachable|concise|avoid (?:claims|promises)|do not (?:claim|promise|make claims)|голос|тон|стил|формулиров|пис|текст|ясн|прям|тепл|дружелюб|спокой|формаль|неформаль|лаконич|не (?:утверждай|обещай)|stimme|ton|stil|formulier|schreib|text|klar|direkt|warm|freundlich|ruhig|formell|locker|prägnant|keine (?:behauptungen|versprechen))/iu,
  headlines: /(?:headline|heading|title|header|shorter headline|short title|заголов|короче заголов|коротк.*заголов|überschrift|titel|kürzere überschrift|kurzer titel)/iu,
} as const;
type DecodedPreference = Omit<PreferenceProposal, "id">;
export function decodePreferencesV4(value: unknown, snapshot: PaidInputSnapshot) {
  const entries = sourceCatalogueV4(snapshot).entries;
  const preferences: DecodedPreference[] = [];
  let omitted = false;
  const object = z.object({ audience: z.array(z.unknown()), voice: z.array(z.unknown()), headlines: z.array(z.unknown()) }).strict().safeParse(value);
  if (!object.success) return { preferences, omitted: true };
  for (const field of ["audience", "voice", "headlines"] as const) {
    for (const item of object.data[field]) {
      const parsed = suggestion.safeParse(item);
      if (!parsed.success) { omitted = true; continue; }
      if (parsed.data.sourceRef === "none") continue;
      const entry = entries.find((entry) => entry.id === parsed.data.sourceRef && entry.basis === "user");
      const message = entry?.sourceId === snapshot.quoteId && snapshot.schemaVersion >= 9 && snapshot.kind === "revise"
        ? { id: snapshot.quoteId, role: "user" as const, text: snapshot.instruction.trim() }
        : snapshot.publication.messages.find((message) => message.id === entry?.sourceId && message.role === "user");
      if (!entry || !message || !fieldEvidence[field].test(entry.text) || preferences.length === 5 || (field === "headlines" && !["default", "shorter"].includes(parsed.data.value))) { omitted = true; continue; }
      preferences.push({ field, value: parsed.data.value, scope: preferenceScope(entry.text, message.text, parsed.data.scope), messageId: entry.sourceId, evidence: entry.text, reason: "Suggestion from your selected source statement; not saved until confirmed." });
    }
  }
  return { preferences, omitted };
}

export function omittedPreferencesNoticeV4(snapshot: PaidInputSnapshot) {
  return snapshot.publication.language.startsWith("ru") ? "Некоторые предложения памяти не сохранены. Твои инструкции остаются в этом посте." : snapshot.publication.language.startsWith("de") ? "Einige Erinnerungsvorschläge wurden nicht gespeichert. Deine Anweisungen bleiben in diesem Beitrag." : "Some memory suggestions were not saved. Your instructions remain in this post.";
}
