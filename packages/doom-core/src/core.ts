// doom-core: a deterministic, tic-stepped DOOM engine for Node and the browser.
//
// The canonical session log is a list of TicSteps (resolved ticcmds). High
// level actions and exact turns compile to TicSteps, so replay never depends
// on how actions were mapped at the time they were played.

// This entry never imports the Emscripten glue itself (bundlers choke on its
// Node branches); callers pass the module factory. Node code can use the
// package root ("@doom-player/doom-core"), which supplies the default factory.
import type { DoomModule, DoomModuleOptions } from "@doom-player/engine";
import mobjTypes from "@doom-player/engine/mobjtypes.json" with { type: "json" };

// ---------------------------------------------------------------------------
// Public types

export const ACTIONS = [
  "forward", "back", "strafe_left", "strafe_right", "turn_left", "turn_right",
  "run", "fire", "use",
  "weapon_1", "weapon_2", "weapon_3", "weapon_4", "weapon_5", "weapon_6", "weapon_7",
] as const;
export type Action = (typeof ACTIONS)[number];

/** A high-level step: hold these actions for `tics` tics (35 tics = 1 s). */
export interface Step {
  actions: Action[];
  tics: number;
}

/** A resolved step, exactly what the engine consumes. This is what gets logged. */
export interface TicStep {
  /** forwardmove, -127..127 (walk 25, run 50) */
  f: number;
  /** sidemove, -127..127, positive = right (walk 24, run 40) */
  s: number;
  /** angleturn, positive = turn left; 65536 units = 360° */
  t: number;
  /** ticcmd buttons bitfield */
  b: number;
  /** number of tics to hold this command */
  n: number;
}

export type DoomModuleFactory = (opts?: DoomModuleOptions) => Promise<DoomModule>;

export interface EngineOptions {
  /** The Emscripten module factory (default export of @doom-player/engine). */
  factory: DoomModuleFactory;
  /** IWAD bytes (e.g. freedoom1.wad). */
  wad: Uint8Array;
  skill?: number;
  episode?: number;
  map?: number;
  /** Forward engine stdout/stderr to the console. */
  verbose?: boolean;
  /** Passed through to Emscripten (browser: where to fetch doom.wasm from). */
  moduleOptions?: DoomModuleOptions;
}

export const WEAPONS = [
  "fist", "pistol", "shotgun", "chaingun", "rocket_launcher", "plasma_rifle", "bfg9000", "chainsaw", "super_shotgun",
] as const;
export const AMMO = ["bullets", "shells", "cells", "rockets"] as const;
export const GAMESTATES = ["level", "intermission", "finale", "demoscreen"] as const;
export const CARDS = ["blue_card", "yellow_card", "red_card", "blue_skull", "yellow_skull", "red_skull"] as const;

export interface PlayerState {
  gametic: number;
  gamestate: (typeof GAMESTATES)[number] | "unknown";
  episode: number;
  map: number;
  dead: boolean;
  health: number;
  armor: number;
  armorType: number;
  ammo: Record<(typeof AMMO)[number], number>;
  maxAmmo: Record<(typeof AMMO)[number], number>;
  weapon: (typeof WEAPONS)[number];
  weaponsOwned: (typeof WEAPONS)[number][];
  /** Map units. */
  x: number;
  y: number;
  z: number;
  /** Degrees, 0 = east, counter-clockwise (DOOM convention). */
  angle: number;
  onGround: boolean;
  /** Map units per tic. */
  speed: number;
  kills: number;
  items: number;
  secrets: number;
  totalKills: number;
  totalItems: number;
  totalSecrets: number;
  /** Red screen flash intensity; > 0 means damage was taken recently. */
  damageCount: number;
  bonusCount: number;
  keys: (typeof CARDS)[number][];
  levelTime: number;
  /** Direction of the last attacker in degrees, negative = left. Null if none. */
  attackerAngle: number | null;
}

export type ObjectKind = "enemy" | "item" | "shootable";

export interface GameObject {
  id: number;
  type: string;
  kind: ObjectKind;
  x: number;
  y: number;
  health: number;
  /** Map units from the player. */
  distance: number;
  /** Degrees relative to where the player faces; negative = left, positive = right. */
  angle: number;
  /** In line of sight (P_CheckSight). */
  visible: boolean;
}

// ---------------------------------------------------------------------------
// Constants

const BT_ATTACK = 1;
const BT_USE = 2;
const BT_CHANGE = 4;
const BT_WEAPONSHIFT = 3;

const FORWARD = [25, 50] as const;
const SIDE = [24, 40] as const;
const TURN = [640, 1280] as const;
/** Max angleturn per tic for exact turns (~11.25°/tic, 90° in 8 tics). */
const MAX_TURN_PER_TIC = 2048;

export const TICRATE = 35;
export const MAX_TICS_PER_STEP = 35;

// Mirrors the enum in engine/dg_exports.c.
const S = {
  GAMETIC: 0, GAMESTATE: 1, EPISODE: 2, MAP: 3, PLAYERSTATE: 4, HEALTH: 5, ARMOR: 6, ARMORTYPE: 7,
  AMMO0: 8, MAXAMMO0: 12, READYWEAPON: 16, PENDINGWEAPON: 17, WEAPONS_MASK: 18,
  X: 19, Y: 20, Z: 21, ANGLE: 22, ONGROUND: 23, MOMX: 24, MOMY: 25,
  KILLS: 26, ITEMS: 27, SECRETS: 28, TOTALKILLS: 29, TOTALITEMS: 30, TOTALSECRETS: 31,
  DAMAGECOUNT: 32, BONUSCOUNT: 33, CARDS_MASK: 34, LEVELTIME: 35, ATTACKER_ANGLE: 36, HAS_ATTACKER: 37,
} as const;
const O = { ID: 0, TYPE: 1, X: 2, Y: 3, Z: 4, HEALTH: 5, FLAGS: 6, DIST: 7, ANGLE: 8, VISIBLE: 9 } as const;
const MF_SPECIAL = 0x1;
const MF_COUNTKILL = 0x400000;

const FRAC = 65536;
const MOBJ_TYPES = mobjTypes as string[];

// ---------------------------------------------------------------------------
// Pure helpers (no engine needed)

/** Compiles a high-level step to a TicStep. */
export function compileStep(step: Step): TicStep {
  const tics = Math.trunc(step.tics);
  if (!(tics >= 1 && tics <= MAX_TICS_PER_STEP)) throw new RangeError(`tics must be 1..${MAX_TICS_PER_STEP}, got ${step.tics}`);
  const a = new Set(step.actions);
  for (const x of a) if (!ACTIONS.includes(x)) throw new RangeError(`unknown action: ${x}`);
  const run = a.has("run") ? 1 : 0;
  let f = 0, s = 0, t = 0, b = 0;
  if (a.has("forward")) f += FORWARD[run];
  if (a.has("back")) f -= FORWARD[run];
  if (a.has("strafe_right")) s += SIDE[run];
  if (a.has("strafe_left")) s -= SIDE[run];
  if (a.has("turn_left")) t += TURN[run];
  if (a.has("turn_right")) t -= TURN[run];
  if (a.has("fire")) b |= BT_ATTACK;
  if (a.has("use")) b |= BT_USE;
  for (let w = 7; w >= 1; w--) {
    if (a.has(`weapon_${w}` as Action)) {
      b |= BT_CHANGE | ((w - 1) << BT_WEAPONSHIFT);
      break;
    }
  }
  return { f, s, t, b, n: tics };
}

/** Compiles an exact turn (positive degrees = right/clockwise) to TicSteps. */
export function compileTurn(degrees: number): TicStep[] {
  if (!Number.isFinite(degrees)) throw new RangeError("degrees must be finite");
  const units = Math.round((-degrees * FRAC) / 360); // angleturn > 0 turns left
  if (units === 0) return [];
  const tics = Math.ceil(Math.abs(units) / MAX_TURN_PER_TIC);
  const per = Math.trunc(units / tics);
  const last = units - per * (tics - 1);
  const out: TicStep[] = [];
  if (tics > 1) out.push({ f: 0, s: 0, t: per, b: 0, n: tics - 1 });
  out.push({ f: 0, s: 0, t: last, b: 0, n: 1 });
  return out;
}

export function totalTics(steps: readonly TicStep[]): number {
  return steps.reduce((sum, s) => sum + s.n, 0);
}

/** Signed BAM (int32) to degrees in (-180, 180], negative = left. */
function relBamToDegrees(bam: number): number {
  return -((bam | 0) / 2 ** 32) * 360;
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

// ---------------------------------------------------------------------------
// Engine

export class Engine {
  private constructor(private readonly m: DoomModule) {}

  static async create(opts: EngineOptions): Promise<Engine> {
    const quiet = () => {};
    const m = await opts.factory({
      print: opts.verbose ? console.log : quiet,
      printErr: opts.verbose ? console.error : quiet,
      ...opts.moduleOptions,
    });
    m.FS.writeFile("/doom.wad", opts.wad);
    m._doom_init(opts.skill ?? 3, opts.episode ?? 1, opts.map ?? 1);
    return new Engine(m);
  }

  /** Applies one resolved step. Throws if the engine clock misbehaves. */
  applyTicStep(step: TicStep): void {
    let left = step.n;
    while (left > 0) {
      const n = Math.min(left, 1000);
      const r = this.m._doom_step(step.f, step.s, step.t, step.b, n);
      if (r < 0) throw new Error(`engine did not advance exactly one tic (tic ${-r} of ${n})`);
      left -= n;
    }
  }

  /** Compiles and applies a high-level step; returns the TicStep to log. */
  applyStep(step: Step): TicStep {
    const ts = compileStep(step);
    this.applyTicStep(ts);
    return ts;
  }

  /** Exact turn; returns the TicSteps to log. */
  turn(degrees: number): TicStep[] {
    const steps = compileTurn(degrees);
    for (const s of steps) this.applyTicStep(s);
    return steps;
  }

  replay(steps: readonly TicStep[]): void {
    for (const s of steps) this.applyTicStep(s);
  }

  get width(): number {
    return this.m._doom_frame_width();
  }

  get height(): number {
    return this.m._doom_frame_height();
  }

  /** Renders the current state and returns a fresh RGBA buffer (width × height × 4). */
  render(): Uint8ClampedArray {
    this.m._doom_render();
    const w = this.width, h = this.height;
    const p = this.m._doom_frame_ptr();
    const src = this.m.HEAPU8.subarray(p, p + w * h * 4);
    const out = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < out.length; i += 4) {
      // XRGB8888 little endian: B, G, R, X
      out[i] = src[i + 2]!;
      out[i + 1] = src[i + 1]!;
      out[i + 2] = src[i]!;
      out[i + 3] = 255;
    }
    return out;
  }

  private rawState(): Int32Array {
    const p = this.m._doom_get_state() >> 2;
    return this.m.HEAP32.slice(p, p + this.m._doom_state_len());
  }

  getState(): PlayerState {
    const r = this.rawState();
    const g = (i: number) => r[i]!;
    const ammo = (base: number) =>
      Object.fromEntries(AMMO.map((n, i) => [n, g(base + i)])) as Record<(typeof AMMO)[number], number>;
    const wmask = g(S.WEAPONS_MASK), cmask = g(S.CARDS_MASK);
    return {
      gametic: g(S.GAMETIC),
      gamestate: GAMESTATES[g(S.GAMESTATE)] ?? "unknown",
      episode: g(S.EPISODE),
      map: g(S.MAP),
      dead: g(S.PLAYERSTATE) !== 0,
      health: g(S.HEALTH),
      armor: g(S.ARMOR),
      armorType: g(S.ARMORTYPE),
      ammo: ammo(S.AMMO0),
      maxAmmo: ammo(S.MAXAMMO0),
      weapon: WEAPONS[g(S.READYWEAPON)] ?? "fist",
      weaponsOwned: WEAPONS.filter((_, i) => wmask & (1 << i)),
      x: round1(g(S.X) / FRAC),
      y: round1(g(S.Y) / FRAC),
      z: round1(g(S.Z) / FRAC),
      angle: round1((((g(S.ANGLE) >>> 0) / 2 ** 32) * 360) % 360),
      onGround: g(S.ONGROUND) !== 0,
      speed: round1(Math.hypot(g(S.MOMX), g(S.MOMY)) / FRAC),
      kills: g(S.KILLS),
      items: g(S.ITEMS),
      secrets: g(S.SECRETS),
      totalKills: g(S.TOTALKILLS),
      totalItems: g(S.TOTALITEMS),
      totalSecrets: g(S.TOTALSECRETS),
      damageCount: g(S.DAMAGECOUNT),
      bonusCount: g(S.BONUSCOUNT),
      keys: CARDS.filter((_, i) => cmask & (1 << i)),
      levelTime: g(S.LEVELTIME),
      attackerAngle: g(S.HAS_ATTACKER) ? round1(relBamToDegrees(g(S.ATTACKER_ANGLE))) : null,
    };
  }

  /** Monsters, pickups and shootables within `maxDistance` map units, nearest first. */
  getObjects(maxDistance = 2048): GameObject[] {
    const n = this.m._doom_get_objects(maxDistance);
    const stride = this.m._doom_object_stride();
    const p = this.m._doom_objects_ptr() >> 2;
    const raw = this.m.HEAP32.subarray(p, p + n * stride);
    const out: GameObject[] = [];
    for (let i = 0; i < n; i++) {
      const o = (k: number) => raw[i * stride + k]!;
      const flags = o(O.FLAGS);
      const kind: ObjectKind = flags & MF_COUNTKILL ? "enemy" : flags & MF_SPECIAL ? "item" : "shootable";
      out.push({
        id: o(O.ID) >>> 0,
        type: MOBJ_TYPES[o(O.TYPE)] ?? `MT_${o(O.TYPE)}`,
        kind,
        x: round1(o(O.X) / FRAC),
        y: round1(o(O.Y) / FRAC),
        health: o(O.HEALTH),
        distance: o(O.DIST),
        angle: round1(relBamToDegrees(o(O.ANGLE))),
        visible: o(O.VISIBLE) !== 0,
      });
    }
    return out.sort((a, b) => a.distance - b.distance || a.id - b.id);
  }

  /** SHA-256 of the raw state vector (positions at full fixed-point precision). */
  async stateHash(): Promise<string> {
    const r = this.rawState();
    // Drop the frame counter and sleep-ms diagnostics: they depend on how often we render.
    return sha256(new Uint8Array(r.slice(0, S.HAS_ATTACKER + 1).buffer));
  }

  async frameHash(): Promise<string> {
    return sha256(this.render());
  }
}

async function sha256(data: Uint8Array | Uint8ClampedArray): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Nearest-neighbour upscale of an RGBA buffer by an integer factor. */
export function upscale(rgba: Uint8ClampedArray, w: number, h: number, k: number): Uint8ClampedArray {
  const W = w * k;
  const out = new Uint8ClampedArray(W * h * k * 4);
  const src = new Uint32Array(rgba.buffer, rgba.byteOffset, w * h);
  const dst = new Uint32Array(out.buffer);
  for (let y = 0; y < h * k; y++) {
    const sy = ((y / k) | 0) * w;
    for (let x = 0; x < W; x++) dst[y * W + x] = src[sy + ((x / k) | 0)]!;
  }
  return out;
}
