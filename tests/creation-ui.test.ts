import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CreationWorkspace } from "../src/components/creation-workspace";
import type { PublicationView } from "../src/shared/contracts";

function render(status: "plan_ready" | "needs_input", canReply: boolean) {
  const publication: PublicationView = {
    fixture: true, title: "Seasonal drink", language: "en", status: "collecting", version: 2,
    outlineApproved: false, coverApproved: false, createdAt: "2026-09-13T00:00:00Z", updatedAt: "2026-09-13T00:00:00Z",
    id: "post", idea: "A seasonal drink", platform: "instagram", slideCount: 1,
    caption: "Come say hello.", messages: [], history: [],
    slides: [{ id: "slide", index: 0, title: "Seasonal maple latte", body: "Warm and welcoming." }],
    creation: { status, phase: "plan", credits: 30, canReply, questions: ["What is the price?"],
      ...(status === "plan_ready" ? { plan: { version: 2, hash: "plan-hash", approved: false, visualDirection: "Forest green with a large coffee illustration." } } : {}) },
  };
  return renderToStaticMarkup(createElement(CreationWorkspace, {
    publication, busy: false, quote: null, onAccept() {}, onGenerate() {}, onCancel() {},
    onReply: async () => true, onRevise: async () => true, onNew() {},
    run: async () => true, onError() {}, onConfirmPreference: async () => { throw new Error("Not used"); },
  }));
}

test("a completed plan exposes exact copy and direction with Generate, even when discussion is exhausted", () => {
  const html = render("plan_ready", false);
  for (const value of ["Seasonal maple latte", "Warm and welcoming.", "Come say hello.", "Forest green with a large coffee illustration.", "Generate post"]) assert.ok(html.includes(value));
  assert.ok(!html.includes("30 credits"));
  assert.ok(!html.includes("Update plan"));
});

test("unresolved questions cannot offer Generate or another reply after the planning limit", () => {
  const html = render("needs_input", false);
  assert.ok(html.includes("What is the price?"));
  assert.ok(html.includes("reached its limit"));
  assert.ok(!html.includes("Generate post"));
  assert.ok(!html.includes("textarea"));
  assert.ok(html.includes("Stop planning"));
});
