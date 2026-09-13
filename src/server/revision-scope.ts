import type { PublicationView, RevisionScope } from "../shared/contracts";
import { requireCondition } from "./errors";
import { isCreativePolicy } from "../shared/creative-intent";

export function interpretRevision(state: PublicationView, instruction: string): RevisionScope {
  const change = instruction.split(/(?:[.;]|,?\s+but\s+|,?\s+но\s+)/iu)
    .filter((clause) => !/^\s*(?:(?:keep|preserve|leave|do not|don't)\b|сохрани|оставь|не меняй)/iu.test(clause))
    .map((clause) => clause.replace(/\s+(?:(?:without|while keeping|preserving)\b|не\s+меняя).*$/iu, ""))
    .join(" ");
  const targets = [...new Set([...change.matchAll(/(?:slide|слайд(?:а|е)?|folie)\s*(\d+)/giu)].map((match) => Number(match[1])))];
  requireCondition(!/(?:slide|слайд(?:а|е)?|folie)\s*\d+\s*(?:,|and|&|to|-|и)\s*\d+/iu.test(change), "revision_scope_required", "Please name one slide per revision quote.", 409);
  const target = targets.length === 1 ? targets[0] : targets.length === 0 && state.slideCount === 1 ? 1 : 0;
  requireCondition(target >= 1 && target <= state.slideCount, "revision_scope_required", "Name the slide and whether to change its copy or style, for example: 'Shorten the title on slide 2'.", 409);
  const compose = /^\s*compose\s+approved\s+slide\s+\d+\s*$/iu.test(change);
  const contentChanges = change.replace(/\b(?:above|below|beside|under|underneath|next to)\s+(?:the\s+)?(?:copy|text|title|body)\b/giu, "");
  const copy = /\b(copy|text|title|headlines?|body|shorten|rewrite|wording|explain|simplify|überschrift|texten)\b|текст|заголов|сократ|перепиш|объясн/iu.test(contentChanges);
  const style = /\b(style|colo[u]?rs?|palette|warmer|cooler|green|blue|pink|farbe)\b|цвет|стил|палитр|теплее|холоднее/iu.test(change);
  const plan = /\b(visual plan|composition|layout|image-led|typography-only)\b|композиц|макет|визуальн(?:ый|ого) план/iu.test(change);
  if (plan) {
    requireCondition(isCreativePolicy(state.designPolicy) && !copy && !style && !compose, "revision_scope_required", "A visual-plan revision changes only one new-policy slide's composition. Keep copy and palette changes separate; older posts require a new creative draft.", 409);
    return { target, kind: "plan" };
  }
  requireCondition(compose || copy !== style, "revision_scope_required", "Should this change only the slide's copy, or only its color/style? Confirm one scope so we can quote it before starting.", 409);
  return { target, kind: compose ? "compose" : copy ? "copy" : "style" };
}
