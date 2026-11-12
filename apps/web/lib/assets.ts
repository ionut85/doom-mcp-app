// Server-side asset loading. Paths are relative to the monorepo root, which is
// two levels above apps/web both locally and inside the Vercel function bundle
// (see outputFileTracingRoot / outputFileTracingIncludes in next.config.ts).
import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(process.cwd(), "../..");

let wad: Promise<Uint8Array> | undefined;
let wasm: Promise<Uint8Array> | undefined;
let viewer: Promise<string> | undefined;

export function loadWad(): Promise<Uint8Array> {
  return (wad ??= fs.readFile(process.env.DOOM_IWAD ?? path.join(repoRoot, "wads/freedoom1.wad")));
}

export function loadWasm(): Promise<Uint8Array> {
  return (wasm ??= fs.readFile(path.join(repoRoot, "engine/dist/doom.wasm")));
}

export function loadViewerHtml(): Promise<string> {
  // Re-read in dev so `pnpm build:ui` changes show up without restarting.
  if (process.env.NODE_ENV !== "production") return fs.readFile(path.join(process.cwd(), "ui-dist/viewer.html"), "utf8");
  return (viewer ??= fs.readFile(path.join(process.cwd(), "ui-dist/viewer.html"), "utf8"));
}
