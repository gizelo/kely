import { resolve } from "node:path";
import { BudgetStore } from "../budget/store";
import { createLiveGateway, FakeProviderGateway } from "./gateway";
import { previewTransport } from "./preview-transport";

let preview: FakeProviderGateway | undefined;
export function providerGateway(origin: "ai_preview" | "openai") {
  if (origin === "openai") return createLiveGateway();
  if (!preview) preview = new FakeProviderGateway(new BudgetStore({ directory: resolve(".local/ai-preview-budget"), id: "fake-kely-ai-preview-v1", purpose: "fake" }), previewTransport);
  return preview;
}
