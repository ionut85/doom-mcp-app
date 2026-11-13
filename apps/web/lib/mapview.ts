// Map awareness for state/both perception: nearby interactive lines (doors,
// switches, lifts, exits) and a small north-up ASCII map around the player.
// Built from the engine's linedefs; vision-only play never sees any of this.

import type { GameObject, MapLine, PlayerState } from "@doom-player/doom-core/core";

export const CELL = 64; // map units per map character
const RADIUS = 10; // cells on each side of the player -> 21x21 map
const PLAYER_HEIGHT = 56;
const MAX_STEP = 24;
const USE_RANGE = 64;

// Vanilla DOOM linedef specials, grouped by what the player has to do.
const DOORS = new Set([1, 31, 117, 118]);
const LOCKED: Record<number, string> = { 26: "blue", 32: "blue", 27: "yellow", 34: "yellow", 28: "red", 33: "red" };
const EXIT_SWITCH = new Set([11, 51]);
const EXIT_WALK = new Set([52, 124]);
const LIFT_SWITCH = new Set([21, 62, 122, 123]);
const LIFT_WALK = new Set([10, 88, 120, 121]);
const TELEPORT = new Set([39, 97, 125, 126]);
const SWITCHES = new Set([
  7, 9, 14, 15, 18, 20, 23, 29, 41, 42, 43, 45, 49, 50, 55, 60, 61, 63, 64, 65, 66, 67, 68, 69, 70, 71, 101, 102, 103, 111,
  112, 113, 114, 115, 116, 127, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140,
]);
const IGNORED = new Set([48]); // scrolling wall texture

export type InteractiveKind = "door" | "locked_door" | "switch" | "exit_switch" | "exit" | "lift" | "teleporter" | "trigger";

export interface Interactive {
  kind: InteractiveKind;
  /** how to use it */
  how: "use" | "walk over" | "walk onto";
  /** for doors */
  state?: "open" | "closed";
  /** for locked doors */
  key?: string;
  distance: number;
  /** degrees to turn to face it: doom_turn(turn). Negative = left. */
  turn: number;
  /** close enough and roughly facing it, so "use" will work now */
  in_use_range?: boolean;
}

function classify(l: MapLine): { kind: InteractiveKind; how: Interactive["how"]; key?: string } | null {
  const s = l.special;
  if (!s || IGNORED.has(s)) return null;
  if (DOORS.has(s)) return { kind: "door", how: "use" };
  if (LOCKED[s]) return { kind: "locked_door", how: "use", key: LOCKED[s] };
  if (EXIT_SWITCH.has(s)) return { kind: "exit_switch", how: "use" };
  if (EXIT_WALK.has(s)) return { kind: "exit", how: "walk over" };
  if (LIFT_SWITCH.has(s)) return { kind: "lift", how: "use" };
  if (LIFT_WALK.has(s)) return { kind: "lift", how: "walk onto" };
  if (TELEPORT.has(s)) return { kind: "teleporter", how: "walk over" };
  if (SWITCHES.has(s)) return { kind: "switch", how: "use" };
  return { kind: "trigger", how: "walk over" };
}

/** Closed if there is no room for the player between the back sector's floor and ceiling. */
function doorState(l: MapLine): "open" | "closed" {
  if (l.backFloor === null || l.backCeil === null) return "closed";
  return l.backCeil - l.backFloor >= PLAYER_HEIGHT ? "open" : "closed";
}

/** Whether a line stops the player (wall, closed door, too-high step). */
function blocks(l: MapLine): boolean {
  if (l.backFloor === null || l.backCeil === null) return true;
  if (l.flags & 1) return true; // ML_BLOCKING
  const floor = Math.max(l.frontFloor, l.backFloor);
  const ceil = Math.min(l.frontCeil, l.backCeil);
  return ceil - floor < PLAYER_HEIGHT || Math.abs(l.frontFloor - l.backFloor) > MAX_STEP;
}

/** Compass heading: 0 = north, 90 = east, clockwise. doom_turn(+d) increases it by d. */
export function compassHeading(doomAngle: number): number {
  return Math.round((((90 - doomAngle) % 360) + 360) % 360);
}

export function compassName(h: number): string {
  return ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"][Math.round(h / 45) % 8]!;
}

/** Degrees to turn (doom_turn convention: positive = right) to face point (x, y). */
function turnTo(p: PlayerState, x: number, y: number): number {
  const bearing = (Math.atan2(x - p.x, y - p.y) * 180) / Math.PI; // 0 = north, clockwise
  const heading = compassHeading(p.angle);
  return Math.round((((bearing - heading + 540) % 360) - 180) * 10) / 10;
}

function closestPoint(l: MapLine, x: number, y: number): [number, number] {
  const dx = l.x2 - l.x1, dy = l.y2 - l.y1;
  const len2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((x - l.x1) * dx + (y - l.y1) * dy) / len2));
  return [l.x1 + t * dx, l.y1 + t * dy];
}

/** Interactive lines within `range`, merged when they belong to the same object (e.g. both faces of a door). */
export function nearbyInteractives(lines: MapLine[], p: PlayerState, range = 768, max = 6): Interactive[] {
  const found: (Interactive & { cx: number; cy: number; special: number })[] = [];
  for (const l of lines) {
    const c = classify(l);
    if (!c || c.kind === "trigger") continue;
    const [cx, cy] = closestPoint(l, p.x, p.y);
    const distance = Math.round(Math.hypot(cx - p.x, cy - p.y));
    if (distance > range) continue;
    const mx = (l.x1 + l.x2) / 2, my = (l.y1 + l.y2) / 2;
    if (found.some((f) => f.special === l.special && Math.hypot(f.cx - mx, f.cy - my) < 96 && f.distance <= distance)) continue;
    const turn = turnTo(p, cx, cy);
    const item: Interactive & { cx: number; cy: number; special: number } = {
      kind: c.kind,
      how: c.how,
      ...(c.key ? { key: c.key } : {}),
      ...(c.kind === "door" || c.kind === "locked_door" ? { state: doorState(l) } : {}),
      distance,
      turn,
      ...(c.how === "use" ? { in_use_range: distance <= USE_RANGE && Math.abs(turn) <= 35 } : {}),
      cx: mx,
      cy: my,
      special: l.special,
    };
    const dup = found.findIndex((f) => f.special === l.special && Math.hypot(f.cx - mx, f.cy - my) < 96);
    if (dup >= 0) found.splice(dup, 1, item);
    else found.push(item);
  }
  return found
    .sort((a, b) => a.distance - b.distance)
    .slice(0, max)
    .map(({ cx: _x, cy: _y, special: _s, ...rest }) => rest);
}

export const cellKey = (x: number, y: number) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;

const PRIORITY: Record<string, number> = { X: 9, L: 8, D: 7, S: 6, "=": 5, T: 4, d: 3, "#": 2 };

/** 21x21 north-up map around the player. One character = 64x64 map units. */
export function asciiMap(lines: MapLine[], p: PlayerState, objects: GameObject[], visited: Set<string>): string[] {
  const size = RADIUS * 2 + 1;
  const pcx = Math.floor(p.x / CELL), pcy = Math.floor(p.y / CELL);
  const grid: string[][] = Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, col) => (visited.has(`${pcx + col - RADIUS},${pcy + RADIUS - row}`) ? "." : " ")),
  );
  const put = (x: number, y: number, ch: string, force = false) => {
    const col = Math.floor(x / CELL) - pcx + RADIUS;
    const row = pcy - Math.floor(y / CELL) + RADIUS;
    if (row < 0 || row >= size || col < 0 || col >= size) return;
    const cur = grid[row]![col]!;
    if (force || (PRIORITY[ch] ?? 0) > (PRIORITY[cur] ?? 0)) grid[row]![col] = ch;
  };
  const reach = (RADIUS + 2) * CELL;
  for (const l of lines) {
    if (Math.min(l.x1, l.x2) > p.x + reach || Math.max(l.x1, l.x2) < p.x - reach) continue;
    if (Math.min(l.y1, l.y2) > p.y + reach || Math.max(l.y1, l.y2) < p.y - reach) continue;
    const c = classify(l);
    let ch: string | null = null;
    if (c?.kind === "exit_switch" || c?.kind === "exit") ch = "X";
    else if (c?.kind === "locked_door") ch = doorState(l) === "open" ? "d" : "L";
    else if (c?.kind === "door") ch = doorState(l) === "open" ? "d" : "D";
    else if (c?.kind === "switch" || (c?.kind === "lift" && c.how === "use")) ch = "S";
    else if (c?.kind === "lift") ch = "=";
    else if (c?.kind === "teleporter") ch = "T";
    else if (blocks(l)) ch = "#";
    if (!ch) continue;
    const len = Math.hypot(l.x2 - l.x1, l.y2 - l.y1);
    const steps = Math.max(1, Math.ceil(len / 16));
    for (let i = 0; i <= steps; i++) put(l.x1 + ((l.x2 - l.x1) * i) / steps, l.y1 + ((l.y2 - l.y1) * i) / steps, ch);
  }
  for (const o of objects) {
    if (!o.visible) continue;
    if (o.kind === "enemy" && o.health > 0) put(o.x, o.y, "M", true);
    else if (o.kind === "item") put(o.x, o.y, /key|skull/.test(o.type) ? "K" : "+", true);
    else if (o.type === "MT_BARREL" && o.health > 0) put(o.x, o.y, "O", true);
  }
  // Player and a facing arrow in the next cell (if that cell is free).
  grid[RADIUS]![RADIUS] = "@";
  const h = compassHeading(p.angle);
  const dirs: [number, number, string][] = [[-1, 0, "^"], [0, 1, ">"], [1, 0, "v"], [0, -1, "<"]];
  const [dr, dc, arrow] = dirs[Math.round(h / 90) % 4]!;
  const ar = grid[RADIUS + dr]!;
  if (ar[RADIUS + dc] === " " || ar[RADIUS + dc] === ".") ar[RADIUS + dc] = arrow;
  return grid.map((r) => r.join(""));
}

export const MAP_LEGEND =
  "map: north is up, 1 char = 64 units, @ = you (arrow = facing), # wall, D closed door, d open door, L locked door, S switch, = lift, T teleporter, X exit, M enemy, + item, K key, O barrel, . visited, blank = not visited";
