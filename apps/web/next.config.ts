import path from "node:path";
import type { NextConfig } from "next";

const repoRoot = path.join(import.meta.dirname, "../..");

const config: NextConfig = {
  // Trace files from the monorepo root so the WAD and engine land in the function bundle.
  outputFileTracingRoot: repoRoot,
  outputFileTracingIncludes: {
    "/api/mcp": ["../../wads/freedoom1.wad", "../../engine/dist/**", "./ui-dist/**"],
  },
  transpilePackages: ["@doom-player/doom-core"],
  // The engine glue is loaded at runtime from engine/dist (see lib/assets.ts).

  // Browser runtime for /play (scripts/web-assets.mjs): hashed files never change.
  async headers() {
    return [
      { source: "/doom/manifest.json", headers: [{ key: "Cache-Control", value: "public, max-age=0, must-revalidate" }] },
      { source: "/doom/:file((?!manifest).*)", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
    ];
  },
};

export default config;
