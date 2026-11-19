// Assisted moves: doom_attack aims and fires, doom_goto plans a route and walks it.
// Both run one tic at a time against the engine and emit ordinary TicSteps, so the
// session log, replay, smooth playback and "Play yourself" work unchanged.
// Everything here is a pure function of the game state: deterministic.

import type { Engine, GameObject, MapLine, PlayerState, TicStep } from "@doom-player/doom-core/core";
import { cellKey, classify, closestPoint, doorState, nearbyInteractives } from "./mapview";
import { buildGrid, clearLine, findPath, hurtsAt, isBlocked, type Goal, type NavGrid, type Point } from "./nav";
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
export function weaponRange(weapon: string): number {
  if (MELEE.has(weapon)) return 640; // walk in to punch
  if (weapon === "shotgun" || weapon === "super_shotgun") return 700;
  if (weapon === "pistol" || weapon === "chaingun") return 900;
  return SIGHT_RANGE;
}

/** Fists only: a punch needs the enemy right next to you, so don't chase anything farther than this. */
const FIST_REACH = 200;
const AMMO_PICKUP = /^(ammo_clip|box_of_bullets|shells|box_of_shells|shotgun|super_shotgun|chaingun|chainsaw|backpack|rocket|box_of_rockets|rocket_launcher|energy_cell|energy_cell_pack|plasma_rifle)$/;

/** Where to get ammo, for out-of-ammo messages. */
export function ammoAdvice(engine: Engine): string {
  const near = engine.getObjects(SIGHT_RANGE).find((o) => o.kind === "item" && AMMO_PICKUP.test(name(o)));
  return near
    ? `Nearest ammo or weapon: ${name(near)} (item_id ${near.id}, ${near.distance} units): doom_goto(item_id=${near.id}).`
    : "No ammo nearby that I know of: explore for some (doom_goto explore=true) and avoid fights meanwhile.";
}

/** Route grid with solid things and damaging floors, for the map as it is now. */
function navGrid(engine: Engine, lines: MapLine[], passable?: Set<number>): NavGrid {
  return buildGrid(lines, { obstacles: engine.getObstacles(), sectors: (x0, y0, w, h, c) => engine.sectorGrid(x0, y0, w, h, c), passable });
}

/**
 * Closed doors the player can open (unlocked, or locked with the key in hand). Returns every
 * line around each door's sector (so the route can pass through it) mapped to the usable face
 * nearest the player.
 */
function openableDoors(lines: MapLine[], p: PlayerState): Map<number, number> {
  const faces = new Map<number, number[]>(); // door sector -> usable face lines
  lines.forEach((l, i) => {
    const c = classify(l);
    if (!c || (c.kind !== "door" && c.kind !== "locked_door") || c.how !== "use" || doorState(l) !== "closed") return;
    if (c.kind === "locked_door" && !p.keys.some((k) => k.startsWith(c.key ?? "?"))) return;
    const sec = l.backSector;
    if (sec < 0) return;
    (faces.get(sec) ?? faces.set(sec, []).get(sec)!).push(i);
  });
  const out = new Map<number, number>();
  for (const [sec, fs] of faces) {
    const d = (i: number) => {
      const [cx, cy] = closestPoint(lines[i]!, p.x, p.y);
      return Math.hypot(cx - p.x, cy - p.y);
    };
    const face = fs.sort((a, b) => d(a) - d(b) || a - b)[0]!;
    lines.forEach((l, j) => {
      if (l.backFloor !== null && (l.frontSector === sec || l.backSector === sec)) out.set(j, face);
    });
  }
  return out;
}

/** First line in `set` crossed walking start -> waypoints. */
function firstCrossed(lines: MapLine[], set: Map<number, number>, start: Point, wps: Point[]): number | null {
  let a = start;
  for (const b of wps) {
    let best: number | null = null, bestT = Infinity;
    for (const j of set.keys()) {
      const l = lines[j]!;
      const d = (b.x - a.x) * (l.y2 - l.y1) - (b.y - a.y) * (l.x2 - l.x1);
      if (!d) continue;
      const t = ((l.x1 - a.x) * (l.y2 - l.y1) - (l.y1 - a.y) * (l.x2 - l.x1)) / d;
      const u = ((l.x1 - a.x) * (b.y - a.y) - (l.y1 - a.y) * (b.x - a.x)) / d;
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1 && t < bestT) (bestT = t), (best = j);
    }
    if (best !== null) return set.get(best)!;
    a = b;
  }
  return null;
}

function liveEnemies(engine: Engine): GameObject[] {
  return engine.getObjects(SIGHT_RANGE).filter((o) => o.kind === "enemy" && o.health > 0);
}

export function stopReason(start: PlayerState, s: PlayerState): string | null {
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
  if (start.weapon === "fist" && target && target.distance > FIST_REACH) {
    return `attack: out of ammo, only the fist: the ${name(target)} is ${target.distance} units away and punching needs it right next to you. ${ammoAdvice(engine)}`;
  }
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
      reason = `out of ammo (switched to the ${s.weapon}). ${ammoAdvice(engine)}`;
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
    if (s.weapon === "fist" && cur.distance > FIST_REACH + 100) {
      reason = `out of ammo, only the fist, and the ${name(cur)} keeps its distance (${cur.distance} units). ${ammoAdvice(engine)}`;
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
  /** Internal: how many closed doors this call has already opened on the way. */
  doorsOpened?: number;
  /** Stop when an enemy that wasn't visible at the start comes into sight (default true). */
  stopOnEnemy?: boolean;
}

interface Plan {
  goal: Goal;
  label: string;
  /** "walk": a lift that starts when you step on it: wait on it until it stops. */
  lift?: "walk";
  /** Line to face and press use on at the end. */
  useLine?: { line: MapLine; index: number };
  /** For doors: a point just past the door, to walk to once it's open. */
  through?: Point;
}

function planTarget(engine: Engine, lines: MapLine[], grid: NavGrid, p: PlayerState, target: GotoTarget): Plan | string {
  switch (target.kind) {
    case "interactive": {
      const l = lines[target.id];
      const c = l && classify(l);
      if (!l || !c) return `no door, switch or exit with id ${target.id} (use an id from state.interactives)`;
      if (c.how === "use") {
        // Lines only work from their front side. A door has a face on each side of its sector:
        // use the one whose front we can walk to (any of them, if the model named the far face).
        const isDoor = c.kind === "door" || c.kind === "locked_door";
        const faces = isDoor && l.backSector >= 0
          ? lines.flatMap((x, i) => (x.backSector === l.backSector && classify(x)?.how === "use" ? [i] : []))
          : [target.id];
        const options = faces.map((i) => {
          const f = lines[i]!;
          const len = Math.hypot(f.x2 - f.x1, f.y2 - f.y1) || 1;
          const along = ((p.x - f.x1) * (f.x2 - f.x1) + (p.y - f.y1) * (f.y2 - f.y1)) / (len * len);
          // Doors are narrow (often 64 units for a 32-unit-wide player): always go through the middle.
          const t = isDoor ? 0.5 : Math.max(0.2, Math.min(0.8, along));
          const cx = f.x1 + t * (f.x2 - f.x1), cy = f.y1 + t * (f.y2 - f.y1);
          const nx = -(f.y2 - f.y1) / len, ny = (f.x2 - f.x1) / len; // towards the back side
          const point = { x: cx - nx * 36, y: cy - ny * 36 };
          const r = findPath(grid, { x: p.x, y: p.y }, { point, tolerance: 20 });
          const rank = r && !r.partial ? r.length : 1e7 + 1e6 * Number(isBlocked(grid, point.x, point.y)) + Math.hypot(point.x - p.x, point.y - p.y);
          return { i, point, through: { x: cx + nx * 72, y: cy + ny * 72 }, rank };
        });
        const best = options.sort((a, b) => a.rank - b.rank || a.i - b.i)[0]!;
        return { goal: { point: best.point, tolerance: 20 }, label: `the ${c.kind.replace("_", " ")}`, useLine: { line: lines[best.i]!, index: best.i }, ...(isDoor ? { through: best.through } : {}) };
      }
      // Walk-over lines (exits, teleporters, lifts). Aim at the closest point, away from the line's ends.
      const len = Math.hypot(l.x2 - l.x1, l.y2 - l.y1) || 1;
      const along = ((p.x - l.x1) * (l.x2 - l.x1) + (p.y - l.y1) * (l.y2 - l.y1)) / (len * len);
      const t = Math.max(0.2, Math.min(0.8, along));
      const cx = l.x1 + t * (l.x2 - l.x1), cy = l.y1 + t * (l.y2 - l.y1);
      const nx = -(l.y2 - l.y1) / len, ny = (l.x2 - l.x1) / len;
      const what = c.kind.replace("_", " ");
      // Which side do we reach first? Plan to a point on each side and compare.
      const d = 40;
      const sides = [1, -1].map((k) => {
        const point = { x: cx + nx * d * k, y: cy + ny * d * k };
        const r = findPath(grid, { x: p.x, y: p.y }, { point, tolerance: 20 });
        // Neither side reachable yet (a closed door in between): rank by "not inside a wall", then distance.
        const fallback = 1e6 * Number(isBlocked(grid, point.x, point.y)) + Math.hypot(point.x - p.x, point.y - p.y);
        return { point, length: r && !r.partial ? r.length : Infinity, fallback };
      });
      const firstIsNear = sides[0]!.length !== sides[1]!.length ? sides[0]!.length < sides[1]!.length : sides[0]!.fallback <= sides[1]!.fallback;
      let [near, far] = firstIsNear ? [sides[0]!, sides[1]!] : [sides[1]!, sides[0]!];
      // A lift's trigger line is tagged with the lift's sector: the platform is the side with that tag.
      // (The normal points to the back side.)
      const liftSide = c.kind === "lift" && l.tag ? (l.backSectorTag === l.tag ? 0 : l.frontSectorTag === l.tag ? 1 : -1) : -1;
      if (liftSide >= 0) [near, far] = liftSide === 0 ? [sides[1]!, sides[0]!] : [sides[0]!, sides[1]!];
      // Walk-over lines (exits, teleporters, lifts): reach the near side, then cross to the far side.
      return { goal: { point: far.point, tolerance: 20 }, label: `the ${what}`, ...(c.kind === "lift" ? { lift: "walk" as const } : {}) };
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
        goal: { test: (q: Point) => !target.visited.has(cellKey(q.x, q.y)) && Math.hypot(q.x - from.x, q.y - from.y) >= 256 && !hurtsAt(grid, q.x, q.y) },
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
  let grid = navGrid(engine, lines);
  let heights = heightSignature(lines);
  const planned = planTarget(engine, lines, grid, start, target);
  if (typeof planned === "string") return `goto: ${planned}`;
  let plan: Plan = planned;
  let legs = 0;
  let path = findPath(grid, { x: start.x, y: start.y }, plan.goal);
  if (!path && target.kind === "explore") {
    // Everything reachable has been seen: the rest is behind closed doors. Say which ones we can get to.
    // Doors with unexplored space behind them first, then the nearest.
    const doors = nearbyInteractives(lines, start, 3000, 40)
      .filter((i) => (i.kind === "door" || (i.kind === "locked_door" && start.keys.some((k) => k.startsWith(i.key ?? "?")))) && i.state === "closed")
      .flatMap((i) => {
        const p = planTarget(engine, lines, grid, start, { kind: "interactive", id: i.id });
        if (typeof p === "string" || findPath(grid, { x: start.x, y: start.y }, p.goal)?.partial !== false) return [];
        return [{ ...i, fresh: !!p.through && !target.visited.has(cellKey(p.through.x, p.through.y)) }];
      })
      .sort((a, b) => Number(b.fresh) - Number(a.fresh) || a.distance - b.distance)
      .slice(0, 3);
    return doors.length
      ? `goto: everything reachable from here is explored. Closed doors you can reach: ${doors.map((d) => `id ${d.id} (${d.distance} units${d.fresh ? ", unexplored behind it" : ", been through it"})`).join(", ")}. doom_goto(interactive_id=${doors[0]!.id}) opens it and walks through.`
      : "goto: everything reachable from here is explored, and no closed door is reachable. Look for a lift, a switch, or a key in state.interactives and nearby_items.";
  }
  if (!path && target.kind !== "explore" && (opts.doorsOpened ?? 0) < 3) {
    // No open route: is there one through closed doors we can open? Then open the first and carry on.
    const doors = openableDoors(lines, start);
    if (target.kind === "interactive") {
      const sec = lines[target.id]?.backSector ?? -2;
      for (const [j, f] of [...doors]) if (f === target.id || lines[f]!.backSector === sec) doors.delete(j); // the target itself isn't "on the way"
    }
    if (doors.size) {
      const via = findPath(navGrid(engine, lines, new Set(doors.keys())), { x: start.x, y: start.y }, plan.goal);
      const door = via && !via.partial ? firstCrossed(lines, doors, { x: start.x, y: start.y }, via.waypoints) : null;
      if (door !== null) {
        const r = goto(engine, sink, { kind: "interactive", id: door }, { ...opts, doorsOpened: (opts.doorsOpened ?? 0) + 1 });
        if (!/walked through/.test(r) || sink.left() <= 0) return `goto: the way to ${plan.label} is through door ${door}: ${r.replace(/^goto:? ?/, "")}`;
        const rest = goto(engine, sink, target, { ...opts, doorsOpened: (opts.doorsOpened ?? 0) + 1 });
        return `goto: opened door ${door} on the way and walked through; then ${rest.replace(/^goto:? ?/, "")}`;
      }
    }
  }
  if (!path) {
    const lifts = nearbyInteractives(lines, start, 1024, 12).filter((i) => i.kind === "lift");
    const hint = lifts.length ? ` Lifts nearby: ${lifts.map((i) => `id ${i.id} (${i.how}, ${i.distance} units)`).join(", ")}; doom_goto a lift rides it.` : "";
    return `goto: no route to ${plan.label} from here. A closed door, a wall or a climb is in the way: open the door first, ride a lift, or pick another target.${hint}`;
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

  let lastHealth = start.health;
  const interrupt = (s: PlayerState, onLift = false): string | null => {
    const end = stopReason(start, s);
    if (end) return end;
    // Stop when attacked. Damage from the floor (nukage, slime) has no attacker: keep going, the route leads out.
    const hurt = s.health < lastHealth;
    lastHealth = s.health;
    if (hurt && s.attackerAngle !== null) return `took damage (health ${s.health}, attacked from ${describeTurn(s.attackerAngle)})`;
    if (s.health < 25 && hurt) return `health is low (${s.health}), from the floor`;
    if (stopOnEnemy && !onLift) {
      // With only the fist there's nothing to do about a distant enemy: only stop for close ones.
      const reach = s.weapon === "fist" ? FIST_REACH + 100 : 1000;
      const e = liveEnemies(engine).find((o) => o.visible && !seen.has(o.id) && o.distance < reach);
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
      if (sig !== heights) (grid = navGrid(engine, now)), (heights = sig);
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
    // Skip a waypoint we're close to, but only if heading straight for the next one is clear.
    while (wi < wps.length - 1 && Math.hypot(wps[wi]!.x - s.x, wps[wi]!.y - s.y) < 32 && clearLine(grid, { x: s.x, y: s.y }, wps[wi + 1]!)) wi++;
    const wp = wps[wi] ?? { x: s.x, y: s.y }; // empty route: already there
    const final = wi === wps.length - 1;
    const d = Math.hypot(wp.x - s.x, wp.y - s.y);
    const diff = norm180((Math.atan2(wp.y - s.y, wp.x - s.x) * 180) / Math.PI - s.angle); // > 0: target is to the left
    if (final && (d < 20 || (d < 48 && Math.abs(diff) > 90))) {
      legs++;
      if (target.kind === "explore") {
        // Keep exploring: head for the next unvisited area until time is up or something happens.
        plan = planTarget(engine, lines, grid, s, target) as Plan;
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
        // Never press use next to an open door: that closes it.
        const side = unstuck === 0 ? 40 : -40;
        const openDoorNear = nearbyInteractives(engine.getLines(), now, 128, 4).some((i) => (i.kind === "door" || i.kind === "locked_door") && i.state === "open");
        if (sink.left() > 0) sink.apply({ f: 0, s: 0, t: 0, b: unstuck === 0 && !openDoorNear ? BT_USE : 0, n: 1 });
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
  if (plan.lift === "walk" && !path.partial) return `goto: ${where}; ${rideLift(engine, sink, interrupt)}`;
  if (!plan.useLine || !use || path.partial) return `goto: ${where}`;

  // Face the line (a door's middle: its ends are the frame) and get within use range (64 units).
  // Momentum carries the player on after running in, so steer while sliding instead of stopping first.
  const l = plan.useLine.line;
  const isDoor = classify(l)?.kind === "door" || classify(l)?.kind === "locked_door";
  for (let i = 0; i < 45 && sink.left() > 0; i++) {
    const now = engine.getState();
    const [cx, cy] = isDoor ? [(l.x1 + l.x2) / 2, (l.y1 + l.y2) / 2] : closestPoint(l, now.x, now.y);
    const dc = Math.hypot(cx - now.x, cy - now.y);
    const diff = norm180((Math.atan2(cy - now.y, cx - now.x) * 180) / Math.PI - now.angle);
    if (dc < 56 && Math.abs(diff) < 4) break;
    const t = clampTurn(diff * FRAC_DEG);
    const f = dc > 44 && Math.abs(diff - t / FRAC_DEG) < 30 ? (dc > 80 ? WALK : 12) : 0;
    sink.apply({ f, s: 0, t, b: 0, n: 1 });
  }
  if (sink.left() <= 0) return `goto: ${where}, but ran out of time before pressing use`;
  const c = classify(l)!;
  // A door that's already opening would close again if used: then just wait. (A closing one reopens.)
  let opening = false;
  if (isDoor && sink.left() > 1) {
    const before = engine.getLines()[plan.useLine.index]!.backCeil ?? 0;
    sink.apply({ f: 0, s: 0, t: 0, b: 0, n: 1 });
    opening = (engine.getLines()[plan.useLine.index]!.backCeil ?? 0) > before;
  }
  const alreadyOpen = isDoor && doorState(engine.getLines()[plan.useLine.index]!) === "open"; // using it would close it
  if (!opening && !alreadyOpen) sink.apply({ f: 0, s: 0, t: 0, b: BT_USE, n: 1 });
  if (c.kind === "lift") return `goto: ${where} and pressed use; ${boardLift(engine, sink, plan.useLine.index, interrupt)}`;
  if (c.kind === "door" || c.kind === "locked_door") {
    // Wait for the door to open (it takes about a second).
    for (let i = 0; i < 40 && sink.left() > 0; i++) {
      const now = engine.getState();
      const stop = interrupt(now);
      if (stop) return `goto: ${where} and pressed use; then stopped: ${stop}`;
      if (doorState(engine.getLines()[plan.useLine.index]!) === "open") {
        // Walk through while it's open (doors close again after about 4 seconds).
        if (!plan.through || sink.left() <= 0) return `goto: ${where} and opened it; walk through now`;
        const r = goto(engine, sink, { kind: "position", x: plan.through.x, y: plan.through.y }, { use: false, stopOnEnemy });
        if (r.startsWith("goto: reached")) return `goto: ${where}, opened it and walked through`;
        return `goto: ${where} and opened it; walking through: ${r.replace(/^goto (\([^)]*\))?:? ?/, "")}`;
      }
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

function describeTurn(a: number): string {
  const abs = Math.abs(a);
  if (abs <= 15) return "ahead";
  if (abs >= 150) return "behind";
  return `${Math.round(abs)}° ${a < 0 ? "left" : "right"}`;
}

/** Waits on a lift until it has moved and stopped (up to ~4 s). */
function rideLift(engine: Engine, sink: TicSink, interrupt: (s: PlayerState, onLift?: boolean) => string | null): string {
  const z0 = engine.getState().z;
  let moved = false, still = 0, lastZ = z0;
  for (let i = 0; i < 140 && sink.left() > 0; i++) {
    const s = engine.getState();
    const stop = interrupt(s, true); // a ride can't be stopped halfway: only an attack or death ends it early
    if (stop) return `stopped on the lift: ${stop}`;
    if (Math.abs(s.z - z0) > 2) moved = true;
    still = Math.abs(s.z - lastZ) < 0.5 ? still + 1 : 0;
    lastZ = s.z;
    if (moved && still >= 6) return `rode the lift ${s.z < z0 ? "down" : "up"} ${Math.round(Math.abs(s.z - z0))} units; walk off now`;
    if (!moved && i >= 50) return "the lift didn't move";
    sink.apply({ f: 0, s: 0, t: 0, b: 0, n: 1 });
  }
  return moved ? "still riding the lift (time's up)" : "the lift didn't move (time's up)";
}

/** After pressing use on a lift: wait until it's level with you, step on, and ride it. */
function boardLift(engine: Engine, sink: TicSink, index: number, interrupt: (s: PlayerState, onLift?: boolean) => string | null): string {
  const level = () => {
    const l = engine.getLines()[index]!;
    return l.backFloor !== null && Math.abs(l.frontFloor - l.backFloor) <= 24;
  };
  for (let i = 0; i < 105 && !level() && sink.left() > 0; i++) {
    const stop = interrupt(engine.getState(), true);
    if (stop) return `waiting for the lift: ${stop}`;
    sink.apply({ f: 0, s: 0, t: 0, b: 0, n: 1 });
  }
  if (!level()) return "the lift didn't come down to you";
  // Step across the line onto the platform.
  const p = engine.getState();
  const l = engine.getLines()[index]!;
  const [cx, cy] = closestPoint(l, p.x, p.y);
  const len = Math.hypot(l.x2 - l.x1, l.y2 - l.y1) || 1;
  let nx = -(l.y2 - l.y1) / len, ny = (l.x2 - l.x1) / len; // points to the back side
  const onBack = l.tag && l.backSectorTag === l.tag, onFront = l.tag && l.frontSectorTag === l.tag;
  if (onFront || (!onBack && (p.x - cx) * nx + (p.y - cy) * ny > 0)) (nx = -nx), (ny = -ny); // towards the platform
  const tx = cx + nx * 48, ty = cy + ny * 48;
  for (let i = 0; i < 35 && sink.left() > 0; i++) {
    const s = engine.getState();
    const d = Math.hypot(tx - s.x, ty - s.y);
    if (d < 16) break;
    const diff = norm180((Math.atan2(ty - s.y, tx - s.x) * 180) / Math.PI - s.angle);
    const t = clampTurn(diff * FRAC_DEG);
    sink.apply({ f: Math.abs(diff - t / FRAC_DEG) < 30 ? WALK : 0, s: 0, t, b: 0, n: 1 });
  }
  return rideLift(engine, sink, interrupt);
}
