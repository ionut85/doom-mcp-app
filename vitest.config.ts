import path from "node:path";
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["packages/*/test/**/*.test.ts", "apps/web/test/**/*.test.ts"], testTimeout: 60_000 }, resolve: { alias: { "@": path.join(import.meta.dirname, "apps/web") } } });
