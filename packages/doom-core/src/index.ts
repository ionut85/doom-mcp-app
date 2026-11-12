// Node / default entry: core API plus the bundled-in Emscripten module factory.
import createDoomModule from "@doom-player/engine";
import { Engine, type EngineOptions } from "./core.ts";

export * from "./core.ts";

export function createEngine(opts: Omit<EngineOptions, "factory"> & Partial<Pick<EngineOptions, "factory">>): Promise<Engine> {
  return Engine.create({ factory: createDoomModule, ...opts });
}
