// Types for the Emscripten module built by engine/build.sh.
export interface DoomModule {
  FS: { writeFile(path: string, data: Uint8Array): void };
  HEAP32: Int32Array;
  HEAPU8: Uint8Array;
  _doom_init(skill: number, episode: number, map: number): number;
  _doom_step(forward: number, side: number, turn: number, buttons: number, tics: number): number;
  _doom_render(): void;
  _doom_frame_ptr(): number;
  _doom_frame_width(): number;
  _doom_frame_height(): number;
  _doom_get_state(): number;
  _doom_state_len(): number;
  _doom_get_objects(maxDist: number): number;
  _doom_objects_ptr(): number;
  _doom_object_stride(): number;
  _doom_push_key(pressed: number, key: number): void;
  _doom_get_lines(): number;
  _doom_lines_ptr(): number;
  _doom_line_stride(): number;
}
export interface DoomModuleOptions {
  print?: (s: string) => void;
  printErr?: (s: string) => void;
  wasmBinary?: ArrayBuffer | Uint8Array;
  locateFile?: (path: string, prefix: string) => string;
}
declare function createDoomModule(opts?: DoomModuleOptions): Promise<DoomModule>;
export default createDoomModule;
