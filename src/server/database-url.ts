import path from "node:path";

const SUPABASE_POOLER_SUFFIX = ".pooler.supabase.com";
const SUPABASE_CA_PATH = path.resolve("certs/supabase-prod-ca-2021.crt");

export function secureDatabaseUrl(databaseUrl: string, cloud: boolean) {
  if (!cloud) return databaseUrl;

  const parsed = new URL(databaseUrl);
  if (!parsed.hostname.endsWith(SUPABASE_POOLER_SUFFIX)) return databaseUrl;

  parsed.searchParams.delete("uselibpqcompat");
  parsed.searchParams.set("sslmode", "verify-full");
  parsed.searchParams.set("sslrootcert", SUPABASE_CA_PATH);
  return parsed.toString();
}
