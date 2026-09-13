import { z } from "zod";
import type { CreativePlan } from "../shared/creative-intent";
import { layoutChoicesV2, wirePlanV2, type LayoutChoice } from "./creative-contract-v2";
import { validateCreativePlan } from "./creative-intent";
import { requireCondition } from "./errors";
import type { PaidInputSnapshot } from "./paid-input";
import { createDesignScene } from "./design-scene";

export function materialPurposesV3(snapshot: PaidInputSnapshot) {
  return Object.fromEntries(snapshot.brand!.art!.originals.map(({ id }) => [id,
    snapshot.publication.sourceAnalysis?.observations.find((item) => item.materialId === id)?.purpose ?? "unknown",
  ]));
}

export function layoutChoicesV3(snapshot: PaidInputSnapshot): Record<string, LayoutChoice> {
  const art = snapshot.brand!.art!;
  const purposes = materialPurposesV3(snapshot);
  return Object.fromEntries(Object.entries(layoutChoicesV2(art)).filter(([, choice]) => {
    if (purposes[choice.materialId] !== "screenshot") return true;
    const original = art.originals.find((item) => item.id === choice.materialId)!;
    const landscape = original.width >= original.height;
    if (landscape && choice.recipe === "image-evidence") {
      const scale = Math.min(1, 936 / original.width, 560 / original.height);
      return original.width * scale >= 840 && original.height * scale >= 280;
    }
    if (!landscape && choice.recipe === "split-proof") {
      const scale = Math.min(1, 440 / original.width, 970 / original.height);
      return original.width * scale >= 400 && original.height * scale >= 640;
    }
    return false;
  }));
}

const descriptions = {
  en: { "type-poster": "Typography-led composition; no hero original.", "graphic-stage": "Selected original above the copy.", "split-proof": "Selected original beside the copy.", "image-evidence": "Selected original in a full-width evidence area.", closing: "Typography-led closing; no hero original." },
  de: { "type-poster": "Typografische Komposition ohne Hauptbild.", "graphic-stage": "Ausgewähltes Original über dem Text.", "split-proof": "Ausgewähltes Original neben dem Text.", "image-evidence": "Ausgewähltes Original in einem breiten Bildbereich.", closing: "Typografischer Abschluss ohne Hauptbild." },
  ru: { "type-poster": "Типографическая композиция без основного изображения.", "graphic-stage": "Выбранный оригинал над текстом.", "split-proof": "Выбранный оригинал рядом с текстом.", "image-evidence": "Выбранный оригинал в широкой области изображения.", closing: "Типографический финал без основного изображения." },
};
function language(snapshot: PaidInputSnapshot) { return snapshot.publication.language.startsWith("ru") ? "ru" : snapshot.publication.language.startsWith("de") ? "de" : "en"; }
const wirePlanV3 = wirePlanV2.omit({ rationale: true }).strict();

export function decodePlansV3(value: unknown, snapshot: PaidInputSnapshot): CreativePlan[] {
  const choices = layoutChoicesV3(snapshot);
  return z.array(wirePlanV3).max(6).parse(value).map(({ layoutChoice, ...plan }) => {
    requireCondition(Object.hasOwn(choices, layoutChoice), "creative_plan_invalid", "Choose a quoted composition with enough space for the selected interface evidence. No crop or substitute was accepted.", 422);
    return validateCreativePlan({ ...plan, ...choices[layoutChoice], rationale: descriptions[language(snapshot)][choices[layoutChoice].recipe] }, snapshot.brand!.art!);
  });
}

export function plannedSummaryV3(kind: string, plans: CreativePlan[], snapshot: PaidInputSnapshot) {
  const lang = language(snapshot);
  if (kind === "questions") return { en: "A few essential details are still needed before a draft can be prepared.", de: "Für den Entwurf fehlen noch wichtige Angaben.", ru: "Для подготовки черновика нужны ещё несколько важных деталей." }[lang];
  const scope = snapshot.generation?.scope;
  if (scope && scope.kind !== "plan") return lang === "ru" ? `Обновление слайда ${scope.target} подготовлено в рамках согласованной правки.` : lang === "de" ? `Die vereinbarte Änderung für Folie ${scope.target} ist vorbereitet.` : `The agreed update for slide ${scope.target} is prepared.`;
  const label = (id: string) => snapshot.brand!.materials.find((item) => item.id === id)?.label ?? (lang === "ru" ? "выбранный оригинал" : lang === "de" ? "ausgewähltes Original" : "selected original");
  const slide = lang === "ru" ? "Слайд" : lang === "de" ? "Folie" : "Slide";
  const typography = lang === "ru" ? "без основного изображения" : lang === "de" ? "ohne Hauptbild" : "no hero original";
  const entries = plans.map((plan, index) => `${slide} ${scope?.target ?? index + 1}: ${plan.materialId ? label(plan.materialId) : typography}.`);
  const logo = snapshot.brand!.art!.direction.logoMaterialId;
  if (logo) entries.push(`${lang === "ru" ? "Логотип" : "Logo"}: ${label(logo)}.`);
  const prefix = lang === "ru" ? "План для проверки. Запланированные оригиналы:" : lang === "de" ? "Plan zur Prüfung. Geplante Originale:" : "Plan for review. Planned originals:";
  const suffix = lang === "ru" ? "Изображения по этому плану ещё не созданы." : lang === "de" ? "Die Bilder für diesen Plan wurden noch nicht erstellt." : "Visuals for this plan have not been rendered yet.";
  return `${prefix} ${entries.join(" ")} ${suffix}`;
}

export function attachDesignScenesV8(plans: CreativePlan[], snapshot: PaidInputSnapshot): CreativePlan[] {
  const offset = snapshot.generation?.scope?.kind === "plan" ? (snapshot.generation.scope.target - 1) : 0;
  return plans.map((plan, index) => validateCreativePlan({ ...plan, scene: createDesignScene(plan, snapshot.brand!.art!, snapshot.quoteId, offset + index) }, snapshot.brand!.art!));
}
