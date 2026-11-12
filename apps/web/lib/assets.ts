// Server-side asset loading. Paths are relative to the monorepo root, which is
// two levels above apps/web both locally and inside the Vercel function bundle.
// The files are traced explicitly via outputFileTracingIncludes in
// next.config.ts, so these dynamic reads are excluded from Turbopack analysis.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { DoomModuleFactory } from "@doom-player/doom-core/core";

const repoRoot = path.resolve(/*turbopackIgnore: true*/ process.cwd(), "../..");
const read = (p: string) => fs.readFile(/*turbopackIgnore: true*/ p);

let wad: Promise<Uint8Array> | undefined;
let wasm: Promise<Uint8Array> | undefined;
let factory: Promise<DoomModuleFactory> | undefined;
let viewer: Promise<string> | undefined;

export function loadWad(): Promise<Uint8Array> {
  return (wad ??= read(process.env.DOOM_IWAD ?? path.join(repoRoot, "wads/freedoom1.wad")));
}

export function loadWasm(): Promise<Uint8Array> {
  return (wasm ??= read(path.join(repoRoot, "engine/dist/doom.wasm")));
}

/** The Emscripten glue, loaded at runtime so the bundler never sees its Node-only branches. */
export function loadFactory(): Promise<DoomModuleFactory> {
  const url = pathToFileURL(path.join(repoRoot, "engine/dist/doom.mjs")).href;
  return (factory ??= import(/*turbopackIgnore: true*/ /*webpackIgnore: true*/ url).then((m) => m.default));
}

export function loadViewerHtml(): Promise<string> {
  const file = path.join(repoRoot, "apps/web/ui-dist/viewer.html");
  // Re-read in dev so `pnpm build:ui` changes show up without a restart.
  if (process.env.NODE_ENV !== "production") return read(file).then(String);
  return (viewer ??= read(file).then(String));
}
