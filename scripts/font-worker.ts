import { layoutApprovedText, LayoutOverflow, UnsupportedGlyph } from "../src/server/layout";
import { disposeFontRuntime } from "../src/server/font-runtime";

async function main() {
  if (process.env.KELY_FONT_WORKER !== "1" || process.env.PANGOCAIRO_BACKEND !== "fontconfig") throw new Error("Private typography worker configuration is missing.");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 64 * 1024) throw new Error("Typography input exceeds the bound.");
    chunks.push(chunk);
  }
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!["sans", "serif", "unbounded"].includes(input.font)) throw new Error("Only bundled typography is accepted.");
    const result = await layoutApprovedText(input);
    process.stdout.write(JSON.stringify({ ...result, png: result.png.toString("base64") }));
  } catch (error) {
    if (error instanceof LayoutOverflow) process.stdout.write(JSON.stringify({ error: { name: "LayoutOverflow", message: error.message, measured: error.measured, available: error.available, fontSizePx: error.fontSizePx } }));
    else if (error instanceof UnsupportedGlyph) process.stdout.write(JSON.stringify({ error: { name: "UnsupportedGlyph", message: error.message, codePoint: error.codePoint } }));
    else process.stdout.write(JSON.stringify({ error: { name: "Error", message: "Bundled typography could not be measured. No fallback font was accepted." } }));
  }
}
main().catch(() => { process.exitCode = 1; }).finally(disposeFontRuntime);
