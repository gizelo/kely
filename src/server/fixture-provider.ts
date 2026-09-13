import { randomUUID } from "node:crypto";
import type { PublicationView } from "../shared/contracts";
import { requireCondition } from "./errors";
import { previewCreativeDraft } from "./providers/creative-preview";
import { isCreativePolicy } from "../shared/creative-intent";

export function prepareFixture(input: PublicationView, business: { name: string; context: string }) {
  const state = structuredClone(input);
  const language = state.language.startsWith("ru") ? "ru" : state.language.startsWith("de") ? "de" : "en";
  const words = {
    en: { context: "What matters", next: "A small next step", question: "What would you like to know?", example: "Sample layout using your supplied idea. Review the facts before publication." },
    de: { context: "Was wichtig ist", next: "Der nächste Schritt", question: "Was möchtest du wissen?", example: "Beispiellayout mit deiner Idee. Prüfe die Fakten vor der Veröffentlichung." },
    ru: { context: "Что важно", next: "Следующий шаг", question: "Что ты хочешь узнать?", example: "Пример оформления с твоей идеей. Проверь факты перед публикацией." },
  }[language];
  const userContext = state.messages.filter((message) => message.role === "user").slice(1).map((message) => message.text).join(" ");
  state.caption = `${state.idea}\n\n${words.question}\n\n[LOCAL FIXTURE — ${words.example}]`;
  state.slides = Array.from({ length: state.slideCount }, (_, index) => ({
    id: randomUUID(), index,
    title: index === 0 ? state.idea.slice(0, 120) : index === state.slideCount - 1 ? words.next : words.context,
    body: index === 0 ? (business.name === "Your business" ? words.example : business.name) : index === state.slideCount - 1 ? words.question : (userContext || business.context || words.example).slice(0, 300),
  }));
  if (isCreativePolicy(state.designPolicy) && state.artDirection) {
    const creative = previewCreativeDraft({ slideCount: state.slideCount, artDirection: state.artDirection.direction, selectedOriginals: state.artDirection.originals, selectedReferenceAnalysis: state.sourceAnalysis, postBrief: { unresolvedRequiredFacts: state.brandBrief?.blockingFacts ?? [] } });
    state.proposedBrief = creative.brief;
    state.slides.forEach((slide, index) => { slide.creativePlan = creative.plans[index]; });
  }
  state.outlineApproved = false;
  state.coverApproved = false;
  state.status = "content_approval";
  state.messages.push({ id: randomUUID(), role: "assistant", text: "Fixture preparation is ready. This is deterministic sample copy, not an AI-written recommendation. Approve the displayed content or add factual context before creating the cover.", createdAt: new Date().toISOString() });
  return state;
}

export function fixtureRevisionTarget(state: PublicationView, instruction: string) {
  const match = instruction.match(/(?:slide|слайд|folie)\s*(\d+)/iu);
  const index = match ? Number(match[1]) - 1 : 0;
  requireCondition(index >= 0 && index < state.slides.length, "unknown_slide", "That slide does not exist. Specify one of the displayed slide numbers.");
  return index;
}
