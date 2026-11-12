// Loads the engine in the browser from the hashed assets in /doom/
// (see scripts/web-assets.mjs).

import { Engine, type DoomModuleFactory } from "@doom-player/doom-core/core";

export interface Manifest {
  glue: string;
  wasm: string;
  wad: string;
  wadBytes: number;
  wadSha256: string;
}

export interface LoadProgress {
  phase: "manifest" | "wad" | "engine";
  loaded?: number;
  total?: number;
}

/** fetch() that says which URL failed (a bare "Failed to fetch" is useless in a sandbox). */
async function get(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    throw new Error(`${e instanceof Error ? e.message : e} (${url})`);
  }
}

export async function loadManifest(base = "/doom/"): Promise<Manifest> {
  const r = await get(`${base}manifest.json`, { cache: "no-cache" });
  if (!r.ok) throw new Error(`Could not load ${base}manifest.json (${r.status})`);
  return r.json();
}

async function fetchWad(url: string, onProgress?: (p: LoadProgress) => void): Promise<Uint8Array> {
  const r = await get(url);
  if (!r.ok || !r.body) throw new Error(`Could not download the game data (${r.status})`);
  const total = Number(r.headers.get("content-length") ?? 0) || undefined;
  let loaded = 0;
  const counted = r.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        loaded += chunk.byteLength;
        onProgress?.({ phase: "wad", loaded, total });
        ctl.enqueue(chunk);
      },
    }),
  );
  const inflated = counted.pipeThrough(new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(inflated).arrayBuffer());
}

let factory: Promise<DoomModuleFactory> | undefined;
let wad: Promise<Uint8Array> | undefined;

async function importGlue(url: string): Promise<DoomModuleFactory> {
  try {
    const mod = await import(/* @vite-ignore */ /* webpackIgnore: true */ /* turbopackIgnore: true */ url);
    return mod.default;
  } catch (e) {
    throw new Error(`could not load the engine script: ${e instanceof Error ? e.message : e} (${url})`);
  }
}

/** Boots a fresh engine. Assets are fetched once per page load and reused. */
export async function loadEngine(
  opts: { skill: number; episode: number; map: number },
  onProgress?: (p: LoadProgress) => void,
  base = "/doom/",
): Promise<Engine> {
  onProgress?.({ phase: "manifest" });
  const m = await loadManifest(base);
  factory ??= importGlue(`${base}${m.glue}`);
  wad ??= fetchWad(`${base}${m.wad}`, onProgress);
  const [f, w] = await Promise.all([factory, wad]).catch((e) => {
    factory = wad = undefined; // allow a retry
    throw e;
  });
  onProgress?.({ phase: "engine" });
  try {
    return await Engine.create({
      ...opts,
      factory: f,
      wad: w,
      moduleOptions: { locateFile: (p) => (p.endsWith(".wasm") ? `${base}${m.wasm}` : `${base}${p}`) },
    });
  } catch (e) {
    throw new Error(`the engine failed to start (WebAssembly blocked?): ${e instanceof Error ? e.message : e}`);
  }
}
