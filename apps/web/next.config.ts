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
  // Keep the Emscripten module out of the bundler; we pass the wasm bytes explicitly.
  serverExternalPackages: ["@doom-player/engine"],
};

export default config;
