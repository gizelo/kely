import type { NextConfig } from "next";

const config: NextConfig = {
  serverExternalPackages: ["pg", "pg-boss", "sharp"],
  poweredByHeader: false,
  devIndicators: false,
  agentRules: false,
  watchOptions: { pollIntervalMs: 1000 },
  async headers() {
    return [{ source: "/:path*", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "same-origin" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "X-Robots-Tag", value: "noindex, nofollow" },
    ] }];
  },
};

export default config;
