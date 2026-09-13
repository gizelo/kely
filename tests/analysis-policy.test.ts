import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { analysisRequest, parseAnalysis, previewAnalysisResponse, type AnalysisInput } from "../src/server/providers/analysis";
import { inputHash } from "../src/server/paid-input";

test("v2 constrains one combined observation per selected ID without changing saved v1 requests", async () => {
  const image = await sharp({ create: { width: 16, height: 16, channels: 3, background: "#224466" } }).jpeg({ quality: 90 }).toBuffer();
  const input: AnalysisInput = { guidance: "Inspect selected sources", rules: { audience: "Owners", headlines: "default", palette: null }, selected: [{ id: "00000000-0000-4000-a000-000000000001", label: "Source", role: "original", version: 1, originalHash: "a".repeat(64), derivativeHash: "b".repeat(64), width: 16, height: 16, dataUrl: `data:image/jpeg;base64,${image.toString("base64")}` }] };
  assert.equal(inputHash(analysisRequest(input, "brand-analysis-v1")), "6d1c50ab0b1b012108d0a129a03518e9715074093174949fb5077783b60ff780");
  input.selected.push({ ...input.selected[0], id: "00000000-0000-4000-a000-000000000002", role: "reference" });
  const request = analysisRequest(input, "brand-analysis-v2");
  assert.equal(request.text.format.type, "json_schema");
  const schema = (request.text.format as { schema: any }).schema;
  assert.equal(schema.properties.observations.additionalProperties, false);
  assert.deepEqual(schema.properties.observations.required, input.selected.map((item) => item.id));
  assert.deepEqual(Object.keys(schema.properties.observations.properties), input.selected.map((item) => item.id));
  const response = previewAnalysisResponse(request, "policy-test");
  assert.equal(parseAnalysis(response, input, "brand-analysis-v2").observations.length, 2);
  const output = JSON.parse(response.output[0].content[0].text);
  output.observations.extra = output.observations[input.selected[0].id];
  response.output[0].content[0].text = JSON.stringify(output);
  assert.throws(() => parseAnalysis(response, input, "brand-analysis-v2"), /analysis_unusable/);
  delete output.observations.extra; delete output.observations[input.selected[1].id];
  response.output[0].content[0].text = JSON.stringify(output);
  assert.throws(() => parseAnalysis(response, input, "brand-analysis-v2"), /analysis_unusable/);
});
