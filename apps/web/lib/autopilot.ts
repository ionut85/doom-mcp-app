// Assisted moves: doom_attack aims and fires, doom_goto plans a route and walks it.
// Both run one tic at a time against the engine and emit ordinary TicSteps, so the
// session log, replay, smooth playback and "Play yourself" work unchanged.
// Everything here is a pure function of the game state: deterministic.

import type { Engine, GameObject, MapLine, PlayerState, TicStep } from "@doom-player/doom-core/core";
import { cellKey, classify, closestPoint, doorState } from "./mapview";
import { buildGrid, findPath, type Goal, type Point } from "./nav";
import { friendlyName } from "./names";

/** Receives each tic's command. `left` is how many tics the call may still use. */
export interface TicSink {
  apply(step: TicStep): void;
  left(): number;
}

const BT_ATTACK = 1;
const BT_USE = 2;
const FRAC_DEG = 65536 / 360;
const MAX_TURN = 2048; // angleturn units per tic, as for doom_turn (~11°)
const RUN = 50;
const WALK = 25;
const SIGHT_RANGE = 2048;
/** Stop an attack once this much health is lost, so Claude can decide to back off. */
const HEAVY_DAMAGE = 25;
/** doom_goto re-plans its route this often (tics). */
const REPLAN_EVERY = 10;

const clampTurn = (units: number) => Math.max(-MAX_TURN, Math.min(MAX_TURN, Math.round(units)));
/** Rounds a turn to `step` units (0 when tiny) so consecutive tics often match and the log merges them. */
const quantize = (units: number, step: number) => (Math.abs(units) < step / 2 ? 0 : Math.round(units / step) * step);
const norm180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
const name = (o: GameObject) => friendlyName(o.type);

const MELEE = new Set(["fist", "chainsaw"]);
/** How far each weapon is worth firing from. The pistol and shotgun miss a lot beyond this. */
function weaponRange(weapon: string): number {
  if (MELEE.has(weapon)) return 640; // walk in to punch
  if (weapon === "shotgun" || weapon === "super_shotgun") return 700;
  if (weapon === "pistol" || weapon === "chaingun") return 900;
  return SIGHT_RANGE;
}

function liveEnemies(engine: Engine): GameObject[] {
  return engine.getObjects(SIGHT_RANGE).filter((o) => o.kind === "enemy" && o.health > 0);
}

function stopReason(start: PlayerState, s: PlayerState): string | null {
  if (s.gamestate === "intermission") return "level complete";
  if (s.gamestate !== "level") return "the level ended";
  if (s.dead) return "you died";
  return null;
}

// ---------------------------------------------------------------------------
// doom_attack

export interface AttackOptions {
  /** Enemy id to attack first (from state.enemies). Default: the nearest visible enemy. */
  targetId?: number;
}

/** Turns to the target, fires whenever it's in the crosshair, and moves on to the next visible enemy after a kill. */
export function attack(engine: Engine, sink: TicSink, opts: AttackOptions = {}): string {
  const start = engine.getState();
  const early = stopReason(start, start);
  if (early) return `attack: nothing to attack: ${early}`;
  const range = () => weaponRange(engine.getState().weapon);
  const pick = (id?: number) => {
    const all = liveEnemies(engine).filter((o) => o.distance <= range());
    return (id !== undefined ? all.find((o) => o.id === id) : undefined) ?? all.find((o) => o.visible);
  };
  let target = pick(opts.targetId);
  if (!target) {
    const far = liveEnemies(engine).find((o) => o.visible);
    if (far) return `attack: the nearest enemy (${name(far)}, ${far.distance} units, turn ${far.angle}) is too far for the ${start.weapon.replace(/_/g, " ")} (${range()} units). Close in with doom_goto or doom_act, or take cover.`;
    return opts.targetId !== undefined ? `attack: enemy ${opts.targetId} isn't alive and in range, and no other enemy is in sight` : "attack: no enemy in sight";
  }
  if (!target.visible && opts.targetId !== undefined) {
    const other = pick();
    if (other) target = other;
  }
  const killed: string[] = [];
  let unseen = 0;
  let reason = "";
  while (sink.left() > 0) {
    const s = engine.getState();
    const end = stopReason(start, s);
    if (end) {
      reason = end;
      break;
    }
    if (start.health - s.health >= HEAVY_DAMAGE) {
      reason = `taking heavy damage (health ${s.health})`;
      break;
    }
    if (MELEE.has(s.weapon) && !MELEE.has(start.weapon)) {
      reason = `out of ammo (switched to the ${s.weapon})`;
      break;
    }
    const enemies = liveEnemies(engine);
    let cur = enemies.find((o) => o.id === target!.id);
    if (!cur) {
      killed.push(name(target));
      const next = enemies.find((o) => o.visible && o.distance <= range());
      if (!next) {
        reason = "no enemies left in sight";
        break;
      }
      target = cur = next;
      unseen = 0;
    }
    unseen = cur.visible ? 0 : unseen + 1;
    if (unseen > 10) {
      reason = `lost sight of the ${name(cur)}`;
      break;
    }
    target = cur;
    const t = clampTurn(quantize(-cur.angle * FRAC_DEG, 32)); // angle < 0 = left; angleturn > 0 turns left
    const residual = cur.angle + t / FRAC_DEG;
    const halfWidth = (Math.atan2(Math.max(cur.radius - 4, 6), Math.max(cur.distance, 1)) * 180) / Math.PI;
    const melee = MELEE.has(s.weapon);
    if (!melee && cur.distance > range() + 200) {
      reason = `the ${name(cur)} backed off out of range (${cur.distance} units)`;
      break;
    }
    const aimed = Math.abs(residual) <= Math.max(halfWidth, 1.5);
    // Fists and chainsaw: walk in while aiming; swing when close.
    const f = melee && cur.distance > 56 && Math.abs(residual) < 20 ? RUN : 0;
    const fire = cur.visible && aimed && (!melee || cur.distance <= 80);
    sink.apply({ f, s: 0, t, b: fire ? BT_ATTACK : 0, n: 1 });
  }
  if (!reason) {
    const t = liveEnemies(engine).find((o) => o.id === target!.id);
    reason = t ? `time's up; the ${name(t)} is still alive (${t.distance} units, turn ${t.angle})` : "time's up";
  }
  const k = killed.length ? `killed ${killed.length === 1 ? `the ${killed[0]}` : `${killed.length} enemies (${killed.join(", ")})`}; ` : "";
  return `attack: ${k}stopped: ${reason}`;
}

// ---------------------------------------------------------------------------
// doom_goto

function heightSignature(lines: MapLine[]): number {
  let h = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    h = (h * 31 + l.frontFloor * 7 + l.frontCeil * 3 + (l.backFloor ?? 1) * 5 + (l.backCeil ?? 1)) | 0;
  }
  return h;
}

export type GotoTarget =
  | { kind: "interactive"; id: number }
  | { kind: "item"; id: number }
  | { kind: "position"; x: number; y: number }
  | { kind: "explore"; visited: Set<string> };

export interface GotoOptions {
  /** Press "use" on arrival at a door, switch or lift (default true). */
  use?: boolean;
  /** Stop when an enemy that wasn't visible at the start comes into sight (default true). */
  stopOnEnemy?: boolean;
}

interface Plan {
  goal: Goal;
  label: string;
  /** Line to face and press use on at the end. */
  useLine?: { line: MapLine; index: number };
}

function planTarget(engine: Engine, lines: MapLine[], p: PlayerState, target: GotoTarget): Plan | string {
  switch (target.kind) {
    case "interactive": {
      const l = lines[target.id];
      const c = l && classify(l);
      if (!l || !c) return `no door, switch or exit with id ${target.id} (use an id from state.interactives)`;
      const [cx, cy] = closestPoint(l, p.x, p.y);
      // Unit normal of the line, pointing to the player's side.
      const len = Math.hypot(l.x2 - l.x1, l.y2 - l.y1) || 1;
      let nx = -(l.y2 - l.y1) / len, ny = (l.x2 - l.x1) / len;
      if ((p.x - cx) * nx + (p.y - cy) * ny < 0) (nx = -nx), (ny = -ny);
      const what = c.kind.replace("_", " ");
      if (c.how === "use") {
        return { goal: { point: { x: cx + nx * 36, y: cy + ny * 36 }, tolerance: 20 }, label: `the ${what}`, useLine: { line: l, index: target.id } };
      }
      // Walk-over lines (exits, teleporters, lifts): cross the line.
      return { goal: { point: { x: cx - nx * 32, y: cy - ny * 32 }, tolerance: 20 }, label: `the ${what}` };
    }
    case "item": {
      const o = engine.getObjects(4096).find((x) => x.id === target.id && x.kind === "item");
      if (!o) return `no item with id ${target.id} (use an id from state.nearby_items)`;
      return { goal: { point: { x: o.x, y: o.y }, tolerance: 10 }, label: `the ${name(o)}` };
    }
    case "position":
      return { goal: { point: { x: target.x, y: target.y }, tolerance: 24 }, label: `(${Math.round(target.x)}, ${Math.round(target.y)})` };
    case "explore": {
      const from = { x: p.x, y: p.y };
      return {
        goal: { test: (q: Point) => !target.visited.has(cellKey(q.x, q.y)) && Math.hypot(q.x - from.x, q.y - from.y) >= 256 },
        label: "unexplored space",
      };
    }
  }
}

/** Plans a route to the target and walks it at running speed, opening doors and pressing switches at the end. */
export function goto(engine: Engine, sink: TicSink, target: GotoTarget, opts: GotoOptions = {}): string {
  const use = opts.use ?? true;
  const stopOnEnemy = opts.stopOnEnemy ?? true;
  const start = engine.getState();
  const early = stopReason(start, start);
  if (early) return `goto: can't move: ${early}`;
  const lines = engine.getLines();
  const planned = planTarget(engine, lines, start, target);
  if (typeof planned === "string") return `goto: ${planned}`;
  let plan: Plan = planned;
  let legs = 0;
  let grid = buildGrid(lines);
  let heights = heightSignature(lines);
  let path = findPath(grid, { x: start.x, y: start.y }, plan.goal);
  if (!path) {
    return `goto: no route to ${plan.label} from here. A closed door, a wall or a height difference is in the way: open a door first, ride a lift (walk onto it, wait for it to move), or pick another target.`;
  }
  const seen = new Set(liveEnemies(engine).filter((o) => o.visible).map((o) => o.id));
  let wps = path.waypoints;
  let wi = 0;
  let sincePlan = 0;
  let noRoute = 0;
  let ref = { x: start.x, y: start.y, left: sink.left() };
  let unstuck = 0;
  let reason = "";
  let arrived = false;

  const interrupt = (s: PlayerState): string | null => {
    const end = stopReason(start, s);
    if (end) return end;
    if (s.health < start.health) return `took damage (health ${s.health})`;
    if (stopOnEnemy) {
      const e = liveEnemies(engine).find((o) => o.visible && !seen.has(o.id) && o.distance < 1000);
      if (e) return `spotted a ${name(e)} (id ${e.id}, ${e.distance} units, turn ${e.angle})`;
    }
    return null;
  };

  while (sink.left() > 0) {
    const s = engine.getState();
    const stop = interrupt(s);
    if (stop) {
      reason = stop;
      break;
    }
    // Momentum drifts the player off the planned line: re-plan from where it actually is.
    // Doors and lifts move, so rebuild the grid when any floor or ceiling height changed.
    if (++sincePlan >= REPLAN_EVERY || noRoute) {
      sincePlan = 0;
      const now = engine.getLines();
      const sig = heightSignature(now);
      if (sig !== heights) (grid = buildGrid(now)), (heights = sig);
      const again = findPath(grid, { x: s.x, y: s.y }, plan.goal);
      if (again) (path = again), (wps = again.waypoints), (wi = 0), (noRoute = 0);
      else if (++noRoute > 35) {
        reason = "the way got blocked (a door closed or a lift moved)";
        break;
      } else {
        sink.apply({ f: 0, s: 0, t: 0, b: 0, n: 1 }); // wait for the lift or door
        continue;
      }
    }
    while (wi < wps.length - 1 && Math.hypot(wps[wi]!.x - s.x, wps[wi]!.y - s.y) < 32) wi++;
    const wp = wps[wi]!;
    const final = wi === wps.length - 1;
    const d = Math.hypot(wp.x - s.x, wp.y - s.y);
    const diff = norm180((Math.atan2(wp.y - s.y, wp.x - s.x) * 180) / Math.PI - s.angle); // > 0: target is to the left
    if (final && (d < 20 || (d < 48 && Math.abs(diff) > 90))) {
      legs++;
      if (target.kind === "explore") {
        // Keep exploring: head for the next unvisited area until time is up or something happens.
        plan = planTarget(engine, lines, s, target) as Plan;
        const next = findPath(grid, { x: s.x, y: s.y }, plan.goal);
        if (next) {
          (path = next), (wps = next.waypoints), (wi = 0), (sincePlan = 0);
          continue;
        }
      }
      arrived = true;
      break;
    }
    const t = clampTurn(quantize(diff * FRAC_DEG, 256)); // ~1.4° steps are plenty for walking
    const residual = Math.abs(diff - t / FRAC_DEG);
    const f = residual < 25 ? (final && d < 96 ? WALK : RUN) : residual < 50 ? 15 : 0;
    sink.apply({ f, s: 0, t, b: 0, n: 1 });
    // Stuck check every 12 tics: try "use" once (an unseen door), then give up.
    if (ref.left - sink.left() >= 12) {
      const now = engine.getState();
      if (Math.hypot(now.x - ref.x, now.y - ref.y) < 8 && f > 0) {
        if (unstuck >= 2) {
          reason = "blocked: something is in the way";
          break;
        }
        // First try "use" (an unmarked door) and a sidestep right, then a sidestep left.
        const side = unstuck === 0 ? 40 : -40;
        if (sink.left() > 0) sink.apply({ f: 0, s: 0, t: 0, b: unstuck === 0 ? BT_USE : 0, n: 1 });
        for (let i = 0; i < 8 && sink.left() > 0; i++) sink.apply({ f: -WALK, s: side, t: 0, b: 0, n: 1 });
        unstuck++;
        sincePlan = REPLAN_EVERY; // re-plan from the new spot
      }
      ref = { x: now.x, y: now.y, left: sink.left() };
    }
  }

  const s = engine.getState();
  if (!arrived) {
    if (!reason) {
      const last = wps[wps.length - 1]!;
      reason = target.kind === "explore" ? `time's up (explored ${legs} new area${legs === 1 ? "" : "s"})` : `time's up, ${Math.round(Math.hypot(last.x - s.x, last.y - s.y))} units still to go`;
    }
    return `goto ${plan.label}: stopped: ${reason}`;
  }
  const where = path.partial ? `got as close as possible to ${plan.label} (the way there is blocked)` : `reached ${plan.label}`;
  if (!plan.useLine || !use || path.partial) return `goto: ${where}`;

  // Face the line and press use.
  const l = plan.useLine.line;
  for (let i = 0; i < 12 && sink.left() > 0; i++) {
    const now = engine.getState();
    const [cx, cy] = closestPoint(l, now.x, now.y);
    const diff = norm180((Math.atan2(cy - now.y, cx - now.x) * 180) / Math.PI - now.angle);
    if (Math.abs(diff) < 3) break;
    sink.apply({ f: 0, s: 0, t: clampTurn(diff * FRAC_DEG), b: 0, n: 1 });
  }
  if (sink.left() <= 0) return `goto: ${where}, but ran out of time before pressing use`;
  sink.apply({ f: 0, s: 0, t: 0, b: BT_USE, n: 1 });
  const c = classify(l)!;
  if (c.kind === "door" || c.kind === "locked_door") {
    // Wait for the door to open (it takes about a second).
    for (let i = 0; i < 40 && sink.left() > 0; i++) {
      const now = engine.getState();
      const stop = interrupt(now);
      if (stop) return `goto: ${where} and pressed use; then stopped: ${stop}`;
      if (doorState(engine.getLines()[plan.useLine.index]!) === "open") return `goto: ${where} and opened it; walk through now`;
      sink.apply({ f: 0, s: 0, t: 0, b: 0, n: 1 });
    }
    return c.kind === "locked_door" && !engine.getState().keys.some((k) => k.startsWith(c.key ?? "?"))
      ? `goto: ${where} and pressed use, but it didn't open: it needs a key`
      : `goto: ${where} and pressed use, but it didn't open`;
  }
  for (let i = 0; i < 4 && sink.left() > 0; i++) sink.apply({ f: 0, s: 0, t: 0, b: 0, n: 1 });
  const after = stopReason(start, engine.getState());
  return `goto: ${where} and pressed use${after ? `: ${after}` : ""}`;
}
