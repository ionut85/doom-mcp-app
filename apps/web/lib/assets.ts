// Server-side asset loading. Paths are relative to the monorepo root, which is
// two levels above apps/web both locally and inside the Vercel function bundle.
// The files are traced explicitly via outputFileTracingIncludes in
// next.config.ts, so these dynamic reads are excluded from Turbopack analysis.
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { DoomModuleFactory } from "@doom-player/doom-core/core";

// apps/web locally and on Vercel (cwd = <root>/apps/web); the repo root in tests and scripts.
const repoRoot =
  [path.resolve(/*turbopackIgnore: true*/ process.cwd(), "../.."), path.resolve(/*turbopackIgnore: true*/ process.cwd())].find((d) =>
    existsSync(/*turbopackIgnore: true*/ path.join(d, "engine/dist/doom.wasm")),
  ) ?? path.resolve(/*turbopackIgnore: true*/ process.cwd(), "../..");
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

/**
 * Public origin the viewer loads the engine and WAD from (/doom/*): the
 * production domain on Vercel, localhost in dev. Override with DOOM_PUBLIC_ORIGIN.
 */
export function publicOrigin(): string {
  if (process.env.DOOM_PUBLIC_ORIGIN) return process.env.DOOM_PUBLIC_ORIGIN.replace(/\/$/, "");
  if (process.env.VERCEL_ENV === "production" && process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return `http://localhost:${process.env.PORT ?? 3000}`;
}

export function loadViewerHtml(): Promise<string> {
  const file = path.join(repoRoot, "apps/web/ui-dist/viewer.html");
  const inject = (html: string) => html.replaceAll("__DOOM_PUBLIC_ORIGIN__", publicOrigin());
  // Re-read in dev so `pnpm build:ui` changes show up without a restart.
  if (process.env.NODE_ENV !== "production") return read(file).then(String).then(inject);
  return (viewer ??= read(file).then(String).then(inject));
}
