export function runtimeSettings(env: Record<string, string | undefined>) {
  const cloud = env.KELY_RUNTIME === "cloud";
  if (env.KELY_RUNTIME && !["cloud", "local"].includes(env.KELY_RUNTIME)) throw new Error("Unsupported Kely runtime.");
  if (!cloud) return { cloud: false, baseUrl: "http://localhost:3130", origins: ["http://localhost:3130", "http://127.0.0.1:3130"] };
  const url = new URL(env.KELY_BASE_URL ?? "");
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || ["localhost", "127.0.0.1", "::1"].includes(url.hostname)) throw new Error("Cloud Kely requires one HTTPS origin.");
  if (!env.KELY_DATABASE_URL || !env.KELY_AUTH_SECRET || env.KELY_AUTH_SECRET.length < 32) throw new Error("Cloud Kely requires persistent database and authentication configuration.");
  return { cloud: true, baseUrl: url.origin, origins: [url.origin] };
}
