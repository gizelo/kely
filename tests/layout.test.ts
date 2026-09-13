import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { LayoutOverflow, layoutApprovedText } from "../src/server/layout";

test("approved multilingual text renders complete within measured safe bounds without interpreting markup", async () => {
  const text =
    'A café & a new chapter.\nGrüße aus Köln – für schöne Momente.\nПривет, мир! Ёлка и тёплый чай.\n<span size="900">This stays literal.</span>';
  const area = { x: 73, y: 61, width: 610, height: 540 };
  const result = await layoutApprovedText({
    text,
    canvas: { width: 760, height: 680 },
    safeArea: area,
    fontSizePx: 36,
  });
  assert.equal(result.approvedText, text);
  assert.equal(result.font.sizePx, 36);
  const layer = await sharp(result.png)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const canvas = await sharp({
    create: { width: 760, height: 680, channels: 4, background: "#00000000" },
  })
    .composite([
      { input: result.png, left: result.bounds.x, top: result.bounds.y },
    ])
    .raw()
    .toBuffer({ resolveWithObject: true });
  let layerInk = 0;
  let canvasInk = 0;
  for (let index = 3; index < layer.data.length; index += 4)
    if (layer.data[index] > 0) layerInk++;
  for (let y = 0; y < canvas.info.height; y++) {
    for (let x = 0; x < canvas.info.width; x++) {
      if (canvas.data[(y * canvas.info.width + x) * 4 + 3] === 0) continue;
      canvasInk++;
      assert.ok(
        x >= area.x &&
          x < area.x + area.width &&
          y >= area.y &&
          y < area.y + area.height,
        "A rendered approved-text pixel escaped the safe area.",
      );
    }
  }
  assert.ok(
    layerInk > 1000,
    "The complete multilingual layer must contain actual rendered text.",
  );
  assert.equal(
    canvasInk,
    layerInk,
    "Compositing the measured layer must not clip a single ink pixel.",
  );
  assert.equal(layer.info.width, result.bounds.width);
  assert.equal(layer.info.height, result.bounds.height);
});

test("overflow follows real glyph metrics and full text height, without shrinking or truncating", async () => {
  const box = {
    canvas: { width: 300, height: 150 },
    safeArea: { x: 20, y: 20, width: 200, height: 60 },
    fontSizePx: 48,
  };
  await layoutApprovedText({ ...box, text: "iiiiiiii" });
  await assert.rejects(
    layoutApprovedText({ ...box, text: "WWWWWWWW" }),
    (error: unknown) => {
      assert.ok(error instanceof LayoutOverflow);
      assert.equal(error.fontSizePx, 48);
      assert.ok(
        error.measured.width > box.safeArea.width ||
          error.measured.height > box.safeArea.height,
      );
      return true;
    },
  );
  await assert.rejects(
    layoutApprovedText({
      ...box,
      text: "Eine Nachricht für alle. Привет всем! ".repeat(30),
    }),
    (error: unknown) => {
      assert.ok(error instanceof LayoutOverflow);
      assert.ok(error.measured.height > box.safeArea.height);
      assert.match(error.message, /no text was shortened/);
      return true;
    },
  );
  await assert.rejects(
    layoutApprovedText({ ...box, text: "Hello 🦄" }),
    /no glyph/,
  );
});

test("a long approved word overflows instead of being split between lines", async () => {
  await assert.rejects(
    layoutApprovedText({
      text: "Nachbarschaftsbäckerei",
      canvas: { width: 1080, height: 1350 },
      safeArea: { x: 72, y: 100, width: 520, height: 300 },
      fontSizePx: 76,
      font: "sans",
      weight: "bold",
    }),
    LayoutOverflow,
  );
});
