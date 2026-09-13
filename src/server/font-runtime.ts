import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { rendererFontsDirectory } from "./renderer-fonts";

let initialization: Promise<void> | undefined;
let ownedDirectory: string | undefined;

export function ensureFontRuntime(): Promise<void> {
  initialization ??= (async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "kely-font-runtime-"));
    ownedDirectory = directory;
    await chmod(directory, 0o700);
    const cache = path.join(directory, "cache");
    await mkdir(cache, { mode: 0o700 });
    const escape = (value: string) => value.replace(
      /[&<>"']/g,
      (character) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&apos;",
        })[character]!,
    );
    const configuration = path.join(directory, "fonts.conf");
    await writeFile(
      configuration,
      `<?xml version="1.0"?><fontconfig><dir>/System/Library/Fonts</dir><dir>/Library/Fonts</dir><dir>${escape(rendererFontsDirectory)}</dir><cachedir>${escape(cache)}</cachedir></fontconfig>`,
      { mode: 0o600, flag: "wx" },
    );
    process.env.FONTCONFIG_FILE = configuration;
    process.env.XDG_CACHE_HOME = cache;
  })();
  return initialization;
}

export async function disposeFontRuntime() {
  const directory = ownedDirectory;
  ownedDirectory = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
}
