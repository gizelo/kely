import type { FakeTextTransport } from "./gateway";
import type { GeneratedReply } from "./generation";
import { previewAnalysisResponse } from "./analysis";
import type { BoundedVisionRequest } from "./vision-envelope";
import { previewCreativeDraft } from "./creative-preview";
import { isCreativePolicy } from "../../shared/creative-intent";

export const previewTransport: FakeTextTransport = {
  kind: "fake",
  async send(request, { attemptKey }) {
    if ("prompt" in request) throw new Error("Image generation requires the artwork provider.");
    if (typeof request.input !== "string") return previewAnalysisResponse(request as BoundedVisionRequest, attemptKey);
    const input = JSON.parse(request.input);
    const ru = input.language.startsWith("ru");
    const de = input.language.startsWith("de");
    const title = ru ? "Твоя идея, ясно и просто" : de ? "Deine Idee, klar erklärt" : "Your idea, clearly shared";
    const body = ru ? "Демонстрационный текст для проверки процесса. Это не ответ настоящего ИИ." : de ? "Beispieltext zum Testen des Ablaufs. Keine echte KI-Antwort." : "Sample copy to test the workflow. This is not a real AI response.";
    const reply: GeneratedReply = {
      kind: input.task === "prepare" ? "proposal" : "revision",
      message: "Fake Responses preview: this deterministic sample tests preparation and approval, not AI quality.",
      questions: [], uncertainFacts: ["Business facts have not been independently verified."],
      caption: input.task === "prepare" ? `${input.idea}\n\n${body}` : "",
      slides: input.task === "prepare" ? Array.from({ length: input.slideCount }, (_, index) => ({ title: index === 0 ? title : `${title} ${index + 1}`, body })) : input.scope.kind === "copy" ? [{ title: ru ? "Проще о главном" : de ? "Einfach auf den Punkt" : "A simpler explanation", body }] : [],
      palette: /green|forest|зелен|grün/iu.test(input.instruction) ? "forest" : /warm|rose|pink|тепл/iu.test(input.instruction) ? "rose" : "indigo",
    };
    if (input.artDirection) {
      reply.preferences = [];
      reply.artPalette = input.scope?.kind === "style" ? { background: "#FFF6F2", foreground: "#492C35", accent: "#B1405F", muted: "#F1D9DD" } : input.artDirection.palette;
    }
    if (isCreativePolicy(input.creativePolicy)) {
      const creative = previewCreativeDraft(input);
      reply.plans = input.task === "prepare" ? creative.plans : [];
      reply.brief = input.task === "prepare" ? creative.brief : input.proposedBrief;
      if ((input.creativePolicy === "creative-intent-v7" || input.creativePolicy === "creative-intent-v8" || input.creativePolicy === "creative-intent-v9") && input.task === "prepare") reply.slides = reply.slides.map((slide, index) => {
        const materialId = creative.plans[index]?.materialId;
        const label = input.selectedOriginals?.find((item: { id: string }) => item.id === materialId)?.label;
        return label ? { ...slide, body: `${slide.body} Selected original: ${label}.` } : slide;
      });
      if (input.scope?.kind === "plan") {
        const { scene: _scene, ...approvedPlan } = input.approvedPlans[input.scope.target - 1];
        reply.plans = [{ ...approvedPlan, recipe: "type-poster", materialId: "", heading: "large", alignment: "center", rationale: "Simulated composition-only revision; approved words and palette are preserved." }];
      }
      if (input.task === "prepare" && creative.brief.requiredFacts.length) {
        reply.kind = "questions"; reply.questions = creative.brief.requiredFacts; reply.slides = []; reply.caption = ""; reply.plans = [];
      }
    }
    if (input.planningFormat?.clarify) {
      const question = "How many slides should this publication contain? Choose one number from 1 to 6.";
      reply.kind = "questions"; reply.questions = [question]; reply.slides = []; reply.plans = []; reply.caption = "";
      if (reply.brief) reply.brief.requiredFacts = [question];
    }
    const { brief: _brief, ...revisionReply } = reply;
    const wireReply = { ...(input.task === "prepare" ? reply : revisionReply), plans: reply.plans?.map(({ recipe, materialId, ...plan }) => ({ ...plan, layoutChoice: materialId ? `${recipe}:${materialId}` : recipe })) };
    let output: unknown = input.creativePolicy === "creative-intent-v2" ? wireReply : reply;
    if (input.creativePolicy === "creative-intent-v3" || input.creativePolicy === "creative-intent-v4" || input.creativePolicy === "creative-intent-v5" || input.creativePolicy === "creative-intent-v6" || input.creativePolicy === "creative-intent-v7" || input.creativePolicy === "creative-intent-v8" || input.creativePolicy === "creative-intent-v9") {
      const { message: _message, ...withoutMessage } = wireReply;
      output = { ...withoutMessage, plans: wireReply.plans?.map(({ rationale: _rationale, ...plan }) => {
        if (Object.hasOwn(input.layoutChoices, plan.layoutChoice)) return plan;
        const originalId = plan.layoutChoice.split(":")[1];
        const suitable = Object.keys(input.layoutChoices).find((key) => key.endsWith(`:${originalId}`));
        return { ...plan, layoutChoice: suitable ?? "type-poster" };
      }) };
    }
    if (input.creativePolicy === "creative-intent-v4" || input.creativePolicy === "creative-intent-v5" || input.creativePolicy === "creative-intent-v6" || input.creativePolicy === "creative-intent-v7" || input.creativePolicy === "creative-intent-v8" || input.creativePolicy === "creative-intent-v9") {
      const value = output as Record<string, unknown>;
      value.preferences = { audience: [], voice: [], headlines: [] };
      if (input.task === "prepare") value.brief = { audience: { sourceRef: "proposed", proposal: reply.brief!.audience.value }, desiredAction: { sourceRef: "proposed", proposal: reply.brief!.desiredAction.value }, facts: [], requiredFacts: reply.brief!.requiredFacts };
      if (input.creativePolicy === "creative-intent-v9") value.semanticDirection = input.task === "prepare" && input.semanticDirection.mode === "propose" && !reply.brief!.requiredFacts.length
        ? { mode: "propose", tone: "warm", grammar: "soft-organic", background: "#FFF8F1", foreground: "#2F241F", accent: "#C85A3A", muted: "#E9D6C8", headingFont: "serif", spacing: "open", rationale: "A warm, tactile direction suited to an approachable local business story." }
        : { mode: "inherit", tone: "precise", grammar: "editorial-lines", background: "", foreground: "", accent: "", muted: "", headingFont: "sans", spacing: "open", rationale: "" };
    }
    if (["unified-creation-v2", "plan-first-v1"].includes(input.unifiedCreationPolicy) && request.text.format.type === "json_schema") {
      const properties = request.text.format.schema.properties as Record<string, unknown>;
      if (Object.hasOwn(properties, "slideCount")) (output as Record<string, unknown>).slideCount = String(reply.kind === "questions" ? input.planningFormat.current : input.planningFormat.proposed);
      if (Object.hasOwn(properties, "planStyle")) (output as Record<string, unknown>).planStyle = { palette: input.artDirection.palette, headingFont: input.artDirection.headingFont, spacing: input.artDirection.spacing };
      if (!Object.hasOwn(properties, "artPalette")) delete (output as Record<string, unknown>).artPalette;
      if (!Object.hasOwn(properties, "semanticDirection")) delete (output as Record<string, unknown>).semanticDirection;
    }
    return { id: `resp_preview_${attemptKey}`, model: request.model, service_tier: "default", status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }],
      usage: { input_tokens: 100, output_tokens: 200, total_tokens: 300, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
    };
  },
};
