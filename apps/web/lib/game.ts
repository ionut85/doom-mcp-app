// Game operations behind the MCP tools. Each call: load session → get an
// engine at the session's state (warm cache or deterministic replay) → apply
// new TicSteps → observe → save with a version check.

import {
  compileStep,
  compileTurn,
  totalTics,
  type Engine,
  type PlayerState,
  type Step,
  type TicStep,
} from "@doom-player/doom-core/core";
import { bootEngine } from "./engine-host";
import { encodePng } from "./frame";
import { hudLine, observe, type Observation } from "./observe";
import {
  addCaption,
  newSessionId,
  sessionStore,
  type Perception,
  type Session,
} from "./session";

export const LIMITS = {
  maxStepsPerCall: 8,
  maxTicsPerCall: 105,
  /** ~14 minutes of game time per session */
  maxSessionTics: 30_000,
  maxCaptionLength: 140,
} as const;

// ---------------------------------------------------------------------------
// Warm engine cache. An engine is *checked out* (removed) while a call uses it
// and only put back after a successful save, so concurrent calls on the same
// instance never share a mutating engine. Replay is always the fallback.

interface CachedEngine {
  engine: Engine;
  version: number;
}
const MAX_CACHED = Number(process.env.DOOM_ENGINE_CACHE ?? 6);
const cache = new Map<string, CachedEngine>();

function checkout(id: string, version: number): Engine | null {
  const c = cache.get(id);
  cache.delete(id);
  return c && c.version === version ? c.engine : null;
}

function checkin(id: string, engine: Engine, version: number) {
  cache.delete(id);
  cache.set(id, { engine, version });
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
}

/** Test hook: drop all warm engines so the next call replays. */
export function clearEngineCache() {
  cache.clear();
}

interface Loaded {
  engine: Engine;
  cacheHit: boolean;
  replayTics: number;
  replayMs: number;
}

async function engineFor(s: Session): Promise<Loaded> {
  const hit = checkout(s.id, s.version);
  if (hit) return { engine: hit, cacheHit: true, replayTics: 0, replayMs: 0 };
  const t0 = performance.now();
  const engine = await bootEngine({ skill: s.skill, episode: s.episode, map: s.map });
  engine.replay(s.steps);
  return { engine, cacheHit: false, replayTics: totalTics(s.steps), replayMs: performance.now() - t0 };
}

// ---------------------------------------------------------------------------

export interface Result {
  session: Session;
  obs: Observation;
  stats: { tool: string; cacheHit: boolean; replayTics: number; replayMs: number; totalMs: number };
}

function log(stats: Result["stats"] & { session: string; bytes?: number }) {
  console.log(JSON.stringify({ evt: "doom_call", ...stats, replayMs: Math.round(stats.replayMs), totalMs: Math.round(stats.totalMs) }));
}

export function logResponse(r: Result, bytes: number) {
  log({ ...r.stats, session: r.session.id, bytes });
}

export async function newGame(opts: { skill: number; episode: number; map: number; perception: Perception }): Promise<Result> {
  const t0 = performance.now();
  const now = Date.now();
  const session: Session = { id: newSessionId(), ...opts, steps: [], captions: [], version: 0, createdAt: now, updatedAt: now };
  const engine = await bootEngine({ skill: opts.skill, episode: opts.episode, map: opts.map });
  const obs = observe(engine, null, opts.perception);
  await sessionStore().create(session);
  checkin(session.id, engine, session.version);
  return { session, obs, stats: { tool: "doom_new_game", cacheHit: false, replayTics: 0, replayMs: performance.now() - t0, totalMs: performance.now() - t0 } };
}

async function advance(tool: string, id: string, newSteps: TicStep[], caption: string | undefined, label: string): Promise<Result> {
  const t0 = performance.now();
  const store = sessionStore();
  const s = await store.get(id);
  const added = totalTics(newSteps);
  if (totalTics(s.steps) + added > LIMITS.maxSessionTics) {
    throw new Error(`Session length limit reached (${LIMITS.maxSessionTics} tics). Start a new game with doom_new_game.`);
  }
  const { engine, cacheHit, replayTics, replayMs } = await engineFor(s);
  const prev: PlayerState = engine.getState();
  for (const st of newSteps) engine.applyTicStep(st);
  const obs = observe(engine, prev, s.perception);

  const expected = s.version;
  const next: Session = { ...s, steps: [...s.steps, ...newSteps], version: expected + 1, updatedAt: Date.now() };
  if (caption || newSteps.length) {
    addCaption(next, { tic: obs.state.tic, text: (caption ?? "").slice(0, LIMITS.maxCaptionLength), action: label });
  }
  await store.save(next, expected); // throws StaleSessionError; the engine is then simply dropped
  checkin(next.id, engine, next.version);
  return { session: next, obs, stats: { tool, cacheHit, replayTics, replayMs, totalMs: performance.now() - t0 } };
}

export function describeSteps(steps: Step[]): string {
  return steps.map((s) => `${s.actions.length ? s.actions.join("+") : "wait"}×${s.tics}`).join(", ");
}

export async function act(id: string, steps: Step[], caption?: string): Promise<Result> {
  if (steps.length < 1 || steps.length > LIMITS.maxStepsPerCall) throw new Error(`Give 1..${LIMITS.maxStepsPerCall} steps.`);
  const compiled = steps.map(compileStep); // validates actions and tics
  const tics = totalTics(compiled);
  if (tics > LIMITS.maxTicsPerCall) throw new Error(`At most ${LIMITS.maxTicsPerCall} tics per call (got ${tics}).`);
  return advance("doom_act", id, compiled, caption, describeSteps(steps));
}

export async function turn(id: string, degrees: number, caption?: string): Promise<Result> {
  return advance("doom_turn", id, compileTurn(degrees), caption, `turn ${degrees > 0 ? "right" : "left"} ${Math.abs(Math.round(degrees))}°`);
}

export async function observeSession(id: string): Promise<Result> {
  const t0 = performance.now();
  const s = await sessionStore().get(id);
  const { engine, cacheHit, replayTics, replayMs } = await engineFor(s);
  const obs = observe(engine, null, s.perception);
  checkin(s.id, engine, s.version);
  return { session: s, obs, stats: { tool: "doom_observe", cacheHit, replayTics, replayMs, totalMs: performance.now() - t0 } };
}

/** Current frame (1×, PNG) + HUD for the viewer. Uses the warm engine when possible. */
export async function frame(id: string): Promise<{ session: Session; hud: Observation["hud"]; png: Buffer; tic: number; cacheHit: boolean; replayTics: number }> {
  const s = await sessionStore().get(id);
  const { engine, cacheHit, replayTics } = await engineFor(s);
  const png = encodePng(engine.render(), engine.width, engine.height, 1);
  const st = engine.getState();
  checkin(s.id, engine, s.version);
  return { session: s, hud: hudLine(st), png, tic: st.gametic, cacheHit, replayTics };
}

/** The session's full input log, for local replay in the viewer ("Play yourself", smooth playback). */
export async function inputLog(id: string) {
  const s = await sessionStore().get(id);
  return {
    session_id: s.id,
    version: s.version,
    skill: s.skill,
    episode: s.episode,
    map: s.map,
    /** [forwardmove, sidemove, angleturn, buttons, tics] per step */
    steps: s.steps.map((x) => [x.f, x.s, x.t, x.b, x.n] as const),
  };
}
