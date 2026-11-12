import { Engine, type EngineOptions } from "@doom-player/doom-core/core";
import { loadFactory, loadWad, loadWasm } from "./assets";

/** Boots a fresh engine with server-side assets. */
export async function bootEngine(opts: Omit<EngineOptions, "wad" | "factory" | "moduleOptions"> = {}): Promise<Engine> {
  const [factory, wad, wasmBinary] = await Promise.all([loadFactory(), loadWad(), loadWasm()]);
  return Engine.create({ ...opts, factory, wad, moduleOptions: { wasmBinary } });
}
