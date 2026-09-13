import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { PublicationView } from "../src/shared/contracts";
import { defaultArtDirection } from "../src/server/brand-policy";
import { generationRequest, parseGeneratedReply } from "../src/server/providers/generation";
import { snapshotPaidInput } from "../src/server/paid-input";

function sample() {
  const messageId = randomUUID();
  const state = { idea: "A local workshop", language: "en", platform: "instagram", slideCount: 1, caption: "", slides: [], messages: [{ id: messageId, role: "user", text: "Always use short headlines." }], artDirection: { direction: defaultArtDirection(null), originals: [] } } as unknown as PublicationView;
  const snapshot = snapshotPaidInput("test-owner", randomUUID(), "prepare", "", state);
  snapshot.schemaVersion = 3;
  snapshot.generation = { origin: "ai_preview", model: "gpt-5.6-luna" };
  snapshot.brand = { version: 1, rules: { audience: "Local customers", palette: null, headlines: "shorter" }, materials: [], brief: { audience: "Local customers", direction: "decide", requiredMaterialIds: [], noPhoto: false, blockingFacts: [], factResolution: "" }, hash: "not-used-by-output-parser", rendererPolicy: "art-direction-v1", art: state.artDirection };
  const output = { kind: "proposal", message: "A concise draft.", questions: [], uncertainFacts: [], caption: "Meet the workshop.", slides: [{ title: "Make something meaningful", body: "Visit our local workshop." }], palette: "indigo", artPalette: state.artDirection!.direction.palette, preferences: [{ field: "headlines", value: "shorter", scope: "durable", messageId, evidence: "Always use short headlines.", reason: "Explicit standing wording." }] };
  const response = () => ({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }] });
  return { snapshot, output, response };
}

test("new preparation includes confirmed preferences and validates exact user evidence without upgrading old request policies", () => {
  const { snapshot, output, response } = sample();
  const request = generationRequest(snapshot);
  const input = JSON.parse(request.input);
  assert.equal(input.standingPreferences.headlines, "shorter");
  assert.equal(input.messages[0].id, output.preferences[0].messageId);
  const reply = parseGeneratedReply(response(), snapshot);
  assert.equal(reply.preferences?.[0].scope, "durable");
  const firstId = reply.preferences![0].id;
  assert.equal(parseGeneratedReply(response(), snapshot).preferences![0].id, firstId);
  snapshot.publication.messages[0].role = "assistant";
  assert.throws(() => parseGeneratedReply(response(), snapshot), { code: "provider_output_unusable" });
  snapshot.publication.messages[0].role = "user";
  output.preferences[0].evidence = "User never said this";
  assert.throws(() => parseGeneratedReply(response(), snapshot), { code: "provider_output_unusable" });
  snapshot.schemaVersion = 2;
  snapshot.brand!.rendererPolicy = "brand-palette-v1";
  const old = JSON.parse(generationRequest(snapshot).input);
  assert.deepEqual(old.messages, [{ role: "user", text: "Always use short headlines." }]);
  assert.equal(Object.hasOwn(old, "standingPreferences"), false);
});

test("local evidence stays local and unhonored short-copy rules or unquoted palette changes are unusable", () => {
  const { snapshot, output, response } = sample();
  snapshot.publication.messages[0].text = "For this post only, use short headlines.";
  output.preferences[0].evidence = "use short headlines.";
  assert.equal(parseGeneratedReply(response(), snapshot).preferences![0].scope, "local");
  output.slides[0].title = "An overlong approved heading ".repeat(5);
  assert.throws(() => parseGeneratedReply(response(), snapshot), { code: "provider_output_unusable" });
  output.slides[0].title = "Short enough";
  output.artPalette = { ...output.artPalette, background: "#FFFFFF" };
  assert.throws(() => parseGeneratedReply(response(), snapshot), { code: "provider_output_unusable" });
});
