export function runtimeSettings(env: Record<string, string | undefined>) {
  const cloud = env.KELY_RUNTIME === "cloud";
  if (env.KELY_RUNTIME && !["cloud", "local"].includes(env.KELY_RUNTIME)) throw new Error("Unsupported Kely runtime.");
  if (!cloud) return { cloud: false, baseUrl: "http://localhost:3130", origins: ["http://localhost:3130", "http://127.0.0.1:3130"] };
  const url = new URL(env.KELY_BASE_URL ?? "");
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || ["localhost", "127.0.0.1", "::1"].includes(url.hostname)) throw new Error("Cloud Kely requires one HTTPS origin.");
  if (!env.KELY_DATABASE_URL || !env.KELY_AUTH_SECRET || env.KELY_AUTH_SECRET.length < 32) throw new Error("Cloud Kely requires persistent database and authentication configuration.");
  const missingStorage = ["KELY_STORAGE_URL", "KELY_STORAGE_SERVICE_KEY", "KELY_STORAGE_BUCKET"]
    .filter((name) => !env[name]);
  if (missingStorage.length > 0) throw new Error(`Cloud Kely requires private object storage configuration: ${missingStorage.join(", ")}.`);
  const storageUrl = new URL(env.KELY_STORAGE_URL);
  if (storageUrl.protocol !== "https:" || storageUrl.username || storageUrl.password || storageUrl.pathname !== "/" || storageUrl.search || storageUrl.hash || !/^[a-z0-9]{20}\.supabase\.co$/u.test(storageUrl.hostname)) throw new Error("Cloud Kely requires one Supabase project storage origin.");
  if (!/^[a-z0-9][a-z0-9._-]{0,62}$/u.test(env.KELY_STORAGE_BUCKET)) throw new Error("Cloud Kely requires a valid private storage bucket name.");
  return { cloud: true, baseUrl: url.origin, origins: [url.origin] };
}
