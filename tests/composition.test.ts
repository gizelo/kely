import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import type { PublicationView } from "../src/shared/contracts";
import { AppError } from "../src/server/errors";
import {
  composeSlideImage,
  exportOriginNotice,
  measureComposedSlide,
  renderComposedSlide,
  validateComposedCopy,
} from "../src/server/renderer";

function publication(): PublicationView {
  return {
    fixture: false,
    origin: "ai_preview",
    id: "composition-example",
    title: "A quiet opening",
    idea: "A café opening",
    platform: "instagram",
    language: "de",
    slideCount: 1,
    status: "content_approval",
    version: 2,
    outlineApproved: false,
    coverApproved: false,
    caption: "An invitation to the neighbourhood.",
    slides: [
      {
        id: "slide-1",
        index: 0,
        title: "Grüße aus Köln.\nПривет, соседи!",
        body: "A quiet corner, a warm welcome.\nSchöner Kaffee für unsere Nachbarn.\nТёплый чай и время для друзей.",
        copyOrigin: "ai_preview",
        visualOrigin: "deterministic",
      },
    ],
    messages: [],
    history: [],
    createdAt: "2026-09-10T00:00:00Z",
    updatedAt: "2026-09-10T00:00:00Z",
  };
}

test("composition preserves approved multilingual body pixels and disjoint measured safe regions in the final PNG", async () => {
  const state = publication();
  await validateComposedCopy(state);
  const plan = await measureComposedSlide(state, state.slides[0]);
  assert.equal(plan.layers[1].approvedText, state.slides[0].title);
  assert.equal(plan.layers[2].approvedText, state.slides[0].body);
  for (let index = 1; index < plan.layers.length; index++) {
    const previous = plan.layers[index - 1].safeArea;
    assert.ok(previous.y + previous.height <= plan.layers[index].safeArea.y);
  }
  const png = await composeSlideImage(state, state.slides[0]);
  const metadata = await sharp(png).metadata();
  assert.equal(metadata.width, 1080);
  assert.equal(metadata.height, 1350);
  const body = plan.layers[2];
  const actual = await sharp(png)
    .extract({
      left: body.bounds.x,
      top: body.bounds.y,
      width: body.bounds.width,
      height: body.bounds.height,
    })
    .ensureAlpha()
    .raw()
    .toBuffer();
  const expected = await sharp({
    create: {
      width: body.bounds.width,
      height: body.bounds.height,
      channels: 4,
      background: plan.palette.background,
    },
  })
    .composite([{ input: body.png }])
    .raw()
    .toBuffer();
  assert.deepEqual(
    actual,
    expected,
    "The final image must retain every shaped body-text pixel, without rerendering or clipping.",
  );
});

test("invalid copy stops before approval or asset persistence, with explicit actionable application errors", async () => {
  const state = publication();
  state.slides[0].body =
    "Eine lange Nachricht für Nachbarn. Привет, друзья! ".repeat(20);
  await assert.rejects(
    validateComposedCopy(state),
    (error: unknown) =>
      error instanceof AppError && error.code === "layout_overflow",
  );
  state.slides[0].body = "Hello 🦄";
  await assert.rejects(
    validateComposedCopy(state),
    (error: unknown) =>
      error instanceof AppError && error.code === "unsupported_glyph",
  );
  await assert.rejects(
    renderComposedSlide("owner", state, state.slides[0], "operation"),
    (error: unknown) =>
      error instanceof AppError && error.code === "content_approval_required",
  );
});

test("mixed-history export provenance follows each saved slide, including legacy fixture fallback", () => {
  const state = publication();
  state.origin = "ai_preview";
  state.captionOrigin = "openai";
  state.slides = [
    { ...state.slides[0], copyOrigin: undefined, visualOrigin: undefined },
    { ...state.slides[0], id: "slide-2", index: 1, copyOrigin: "ai_preview" },
    { ...state.slides[0], id: "slide-3", index: 2, copyOrigin: "openai" },
  ];
  const notice = exportOriginNotice(state);
  assert.match(notice, /Caption: OpenAI copy/);
  assert.match(notice, /Slide 1: Fixture copy/);
  assert.match(notice, /Slide 2: Simulated Responses copy/);
  assert.match(
    notice,
    /Slide 3: OpenAI copy. Visual: deterministic typography; not AI artwork/,
  );
});
