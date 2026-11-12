import { createEngine, type Engine, type EngineOptions } from "@doom-player/doom-core";
import { loadWad, loadWasm } from "./assets";

/** Boots a fresh engine with server-side assets. */
export async function bootEngine(opts: Omit<EngineOptions, "wad" | "moduleOptions"> = {}): Promise<Engine> {
  const [wad, wasmBinary] = await Promise.all([loadWad(), loadWasm()]);
  return createEngine({ ...opts, wad, moduleOptions: { wasmBinary } });
}
