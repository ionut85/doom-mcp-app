import path from "node:path";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [viteSingleFile()],
  build: {
    outDir: path.join(import.meta.dirname, "../../ui-dist"),
    emptyOutDir: true,
    rollupOptions: { input: { viewer: path.join(import.meta.dirname, "viewer.html") } },
  },
});
