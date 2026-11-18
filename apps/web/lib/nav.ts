// Walkability grid and pathfinding over the map's linedefs, for doom_goto.
// Pure functions of the map geometry: deterministic, no engine needed.

import type { MapLine } from "@doom-player/doom-core/core";
import { blocks } from "./mapview";

/** Map units per grid cell. */
export const NAV_CELL = 16;
/** A cell is blocked if its centre is closer than this to a blocking line (player radius 16 + margin). */
const CLEARANCE = 20;
const MARGIN = 64;

export interface NavGrid {
  x0: number;
  y0: number;
  w: number;
  h: number;
  /** 1 = blocked */
  blocked: Uint8Array;
  /** Ledges: steps too high to climb but fine to drop down. Crossing is checked per direction. */
  ledges: MapLine[];
  /** cell index -> indices into `ledges` near that cell */
  ledgeAt: Map<number, number[]>;
  /** 1 = the floor here hurts (nukage, slime, lava): routes avoid it when they can */
  hurts: Uint8Array;
  /** 1 = near the foot of a ledge: routes keep away from it when they can */
  hug: Uint8Array;
  /** 1 = right at the foot of a ledge, where the player's body touches the wall: only reachable by dropping off it */
  band: Uint8Array;
}

/** Sector specials that damage the player standing on them. */
const HURT_SPECIALS = new Set([4, 5, 7, 11, 16]);
/** A step onto a damaging floor costs this many normal steps. */
const HURT_COST = 8;
/** A step along the foot of a ledge costs this many normal steps. */
const HUG_COST = 6;
/** Below a ledge, closer than this the player's body (radius 16) touches the wall. */
const BAND_DIST = 18;
const HUG_DIST = 30;

export interface GridExtras {
  /** Solid things (pillars, lamps, barrels) */
  obstacles?: { x: number; y: number; radius: number }[];
  /** Sector index at each cell centre, for a grid with these bounds (Engine.sectorGrid). */
  sectors?: (x0: number, y0: number, w: number, h: number, cell: number) => Int32Array;
  /** Line indices to treat as open (closed doors the route may go through). */
  passable?: Set<number>;
}

const PLAYER_HEIGHT = 56;
const MAX_STEP = 24;

/** Two-sided, passable headroom, but a floor step over 24 units: you can drop down it, not climb it. */
export function isLedge(l: MapLine): boolean {
  if (l.backFloor === null || l.backCeil === null || l.flags & 1) return false;
  const opening = Math.min(l.frontCeil, l.backCeil) - Math.max(l.frontFloor, l.backFloor);
  return opening >= PLAYER_HEIGHT && Math.abs(l.frontFloor - l.backFloor) > MAX_STEP;
}

/** Signed side of point p relative to line l: < 0 = front (right of x1,y1 -> x2,y2), > 0 = back. */
const side = (l: MapLine, x: number, y: number) => (l.x2 - l.x1) * (y - l.y1) - (l.y2 - l.y1) * (x - l.x1);

/** Moving a -> b crosses ledge l upward (low floor to high floor), which the player can't do. */
function climbsLedge(l: MapLine, a: Point, b: Point): boolean {
  // A point exactly on the line (grid cell centres often are, on 45° lines) counts as
  // being on the high side: you can drop off from it, but not step onto it from below.
  const high = l.frontFloor > l.backFloor! ? -1 : 1;
  const sa = side(l, a.x, a.y) || high, sb = side(l, b.x, b.y) || high;
  if (sa < 0 === sb < 0) return false;
  // Does segment a-b actually cross the line segment (not just its extension)?
  const dx = b.x - a.x, dy = b.y - a.y;
  const s1 = dx * (l.y1 - a.y) - dy * (l.x1 - a.x), s2 = dx * (l.y2 - a.y) - dy * (l.x2 - a.x);
  if (s1 < 0 === s2 < 0 && s1 !== 0 && s2 !== 0) return false;
  const fromFloor = sa < 0 ? l.frontFloor : l.backFloor!;
  const toFloor = sa < 0 ? l.backFloor! : l.frontFloor;
  return toFloor > fromFloor;
}

export type Point = { x: number; y: number };

export function distToSegment(px: number, py: number, l: Pick<MapLine, "x1" | "y1" | "x2" | "y2">): number {
  const dx = l.x2 - l.x1, dy = l.y2 - l.y1;
  const len2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - l.x1) * dx + (py - l.y1) * dy) / len2));
  return Math.hypot(px - (l.x1 + t * dx), py - (l.y1 + t * dy));
}

export function buildGrid(lines: MapLine[], extras: GridExtras = {}): NavGrid {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const l of lines) {
    minX = Math.min(minX, l.x1, l.x2);
    minY = Math.min(minY, l.y1, l.y2);
    maxX = Math.max(maxX, l.x1, l.x2);
    maxY = Math.max(maxY, l.y1, l.y2);
  }
  const x0 = Math.floor((minX - MARGIN) / NAV_CELL) * NAV_CELL;
  const y0 = Math.floor((minY - MARGIN) / NAV_CELL) * NAV_CELL;
  const w = Math.ceil((maxX + MARGIN - x0) / NAV_CELL);
  const h = Math.ceil((maxY + MARGIN - y0) / NAV_CELL);
  const blocked = new Uint8Array(w * h);
  const ledges: MapLine[] = [];
  const ledgeAt = new Map<number, number[]>();
  for (let li = 0; li < lines.length; li++) {
    const l = lines[li]!;
    if (extras.passable?.has(li)) continue;
    if (isLedge(l)) {
      // Not inflated: dropping off lands right next to it. Remember which cells it passes near.
      const k = ledges.push(l) - 1;
      const n = Math.max(1, Math.ceil(Math.hypot(l.x2 - l.x1, l.y2 - l.y1) / 8));
      for (let i = 0; i <= n; i++) {
        const cx = Math.floor((l.x1 + ((l.x2 - l.x1) * i) / n - x0) / NAV_CELL);
        const cy = Math.floor((l.y1 + ((l.y2 - l.y1) * i) / n - y0) / NAV_CELL);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const list = ledgeAt.get(ny * w + nx);
            if (!list) ledgeAt.set(ny * w + nx, [k]);
            else if (list[list.length - 1] !== k) list.push(k);
          }
        }
      }
      continue;
    }
    if (!blocks(l)) continue;
    const cx0 = Math.max(0, Math.floor((Math.min(l.x1, l.x2) - CLEARANCE - x0) / NAV_CELL));
    const cx1 = Math.min(w - 1, Math.floor((Math.max(l.x1, l.x2) + CLEARANCE - x0) / NAV_CELL));
    const cy0 = Math.max(0, Math.floor((Math.min(l.y1, l.y2) - CLEARANCE - y0) / NAV_CELL));
    const cy1 = Math.min(h - 1, Math.floor((Math.max(l.y1, l.y2) + CLEARANCE - y0) / NAV_CELL));
    for (let cy = cy0; cy <= cy1; cy++) {
      const py = y0 + (cy + 0.5) * NAV_CELL;
      for (let cx = cx0; cx <= cx1; cx++) {
        if (blocked[cy * w + cx]) continue;
        if (distToSegment(x0 + (cx + 0.5) * NAV_CELL, py, l) < CLEARANCE) blocked[cy * w + cx] = 1;
      }
    }
  }
  for (const o of extras.obstacles ?? []) {
    const r = o.radius + CLEARANCE;
    const cx0 = Math.max(0, Math.floor((o.x - r - x0) / NAV_CELL)), cx1 = Math.min(w - 1, Math.floor((o.x + r - x0) / NAV_CELL));
    const cy0 = Math.max(0, Math.floor((o.y - r - y0) / NAV_CELL)), cy1 = Math.min(h - 1, Math.floor((o.y + r - y0) / NAV_CELL));
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        // Things are square in DOOM: block cells whose centre is inside the inflated box.
        const px = x0 + (cx + 0.5) * NAV_CELL, py = y0 + (cy + 0.5) * NAV_CELL;
        if (Math.abs(px - o.x) < r && Math.abs(py - o.y) < r) blocked[cy * w + cx] = 1;
      }
    }
  }
  const hurts = new Uint8Array(w * h);
  if (extras.sectors) {
    const special = new Map<number, number>();
    for (const l of lines) {
      if (l.frontSector >= 0) special.set(l.frontSector, l.frontSectorSpecial);
      if (l.backSector >= 0) special.set(l.backSector, l.backSectorSpecial);
    }
    const sec = extras.sectors(x0, y0, w, h, NAV_CELL);
    for (let i = 0; i < w * h; i++) if (HURT_SPECIALS.has(special.get(sec[i]!) ?? 0)) hurts[i] = 1;
  }
  // The foot of each ledge: cells on its low side closer than the player's clearance.
  const hug = new Uint8Array(w * h);
  const band = new Uint8Array(w * h);
  for (const l of ledges) {
    const low = l.frontFloor < l.backFloor! ? -1 : 1;
    const r = HUG_DIST;
    const cx0 = Math.max(0, Math.floor((Math.min(l.x1, l.x2) - r - x0) / NAV_CELL)), cx1 = Math.min(w - 1, Math.floor((Math.max(l.x1, l.x2) + r - x0) / NAV_CELL));
    const cy0 = Math.max(0, Math.floor((Math.min(l.y1, l.y2) - r - y0) / NAV_CELL)), cy1 = Math.min(h - 1, Math.floor((Math.max(l.y1, l.y2) + r - y0) / NAV_CELL));
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const px = x0 + (cx + 0.5) * NAV_CELL, py = y0 + (cy + 0.5) * NAV_CELL;
        if (Math.sign(side(l, px, py)) !== low) continue;
        const d = distToSegment(px, py, l);
        if (d < r) hug[cy * w + cx] = 1;
        if (d < BAND_DIST) band[cy * w + cx] = 1;
      }
    }
  }
  return { x0, y0, w, h, blocked, ledges, ledgeAt, hurts, hug, band };
}

/** The floor at (x, y) damages the player. */
export function hurtsAt(g: NavGrid, x: number, y: number): boolean {
  const [cx, cy] = cellOf(g, x, y);
  return cx >= 0 && cy >= 0 && cx < g.w && cy < g.h && g.hurts[cy * g.w + cx] === 1;
}

/** Whether going straight from a to b would have to climb a ledge. */
function climbsAny(g: NavGrid, a: Point, b: Point): boolean {
  if (!g.ledgeAt.size) return false;
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  const n = Math.max(1, Math.ceil(d / NAV_CELL));
  const seen = new Set<number>();
  for (let i = 0; i <= n; i++) {
    const [cx, cy] = cellOf(g, a.x + ((b.x - a.x) * i) / n, a.y + ((b.y - a.y) * i) / n);
    for (const k of g.ledgeAt.get(cy * g.w + cx) ?? []) {
      if (seen.has(k)) continue;
      seen.add(k);
      if (climbsLedge(g.ledges[k]!, a, b)) return true;
    }
  }
  return false;
}

/** Whether going straight from a to b drops down a ledge. */
function dropsAny(g: NavGrid, a: Point, b: Point): boolean {
  const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / NAV_CELL));
  for (let i = 0; i <= n; i++) {
    const [cx, cy] = cellOf(g, a.x + ((b.x - a.x) * i) / n, a.y + ((b.y - a.y) * i) / n);
    for (const k of g.ledgeAt.get(cy * g.w + cx) ?? []) if (climbsLedge(g.ledges[k]!, b, a)) return true; // b->a climbs = a->b drops
  }
  return false;
}

const cellOf = (g: NavGrid, x: number, y: number): [number, number] => [Math.floor((x - g.x0) / NAV_CELL), Math.floor((y - g.y0) / NAV_CELL)];
const centre = (g: NavGrid, i: number): Point => ({ x: g.x0 + ((i % g.w) + 0.5) * NAV_CELL, y: g.y0 + (Math.floor(i / g.w) + 0.5) * NAV_CELL });

function inBand(g: NavGrid, x: number, y: number): boolean {
  const [cx, cy] = cellOf(g, x, y);
  return cx >= 0 && cy >= 0 && cx < g.w && cy < g.h && g.band[cy * g.w + cx] === 1;
}

export function isBlocked(g: NavGrid, x: number, y: number): boolean {
  const [cx, cy] = cellOf(g, x, y);
  if (cx < 0 || cy < 0 || cx >= g.w || cy >= g.h) return true;
  return g.blocked[cy * g.w + cx] === 1;
}

/** Nearest free cell to (x, y) within `radius` cells, or -1. */
function nearestFree(g: NavGrid, x: number, y: number, radius = 3): number {
  const [cx, cy] = cellOf(g, x, y);
  let best = -1, bestD = Infinity;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= g.w || ny >= g.h || g.blocked[ny * g.w + nx]) continue;
      const d = dx * dx + dy * dy;
      if (d < bestD) (bestD = d), (best = ny * g.w + nx);
    }
  }
  return best;
}

/** Straight line from a to b stays clear of blocked cells (sampled every 8 units). */
export function clearLine(g: NavGrid, a: Point, b: Point): boolean {
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  const n = Math.max(1, Math.ceil(d / 8));
  for (let i = 0; i <= n; i++) {
    const x = a.x + ((b.x - a.x) * i) / n, y = a.y + ((b.y - a.y) * i) / n;
    if (isBlocked(g, x, y)) return false;
    // Along the foot of a ledge the wall catches the player (fine right where we start: just dropped off it).
    if ((i * d) / n > 24 && inBand(g, x, y)) return false;
  }
  return !climbsAny(g, a, b);
}

/** Cells routes prefer to stay off: damaging floors and the foot of ledges. */
function avoidAt(g: NavGrid, x: number, y: number): boolean {
  const [cx, cy] = cellOf(g, x, y);
  if (cx < 0 || cy < 0 || cx >= g.w || cy >= g.h) return false;
  const i = cy * g.w + cx;
  return g.hurts[i] === 1 || g.hug[i] === 1;
}

function crossesAvoid(g: NavGrid, a: Point, b: Point): boolean {
  const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 8));
  for (let i = 0; i <= n; i++) if (avoidAt(g, a.x + ((b.x - a.x) * i) / n, a.y + ((b.y - a.y) * i) / n)) return true;
  return false;
}

/** Binary min-heap of cell indices keyed by f-score. */
class Heap {
  private idx: number[] = [];
  private key: number[] = [];
  get size() {
    return this.idx.length;
  }
  push(i: number, k: number) {
    this.idx.push(i);
    this.key.push(k);
    let c = this.idx.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (this.key[p]! <= this.key[c]!) break;
      this.swap(p, c);
      c = p;
    }
  }
  pop(): number {
    const top = this.idx[0]!;
    const li = this.idx.pop()!, lk = this.key.pop()!;
    if (this.idx.length) {
      this.idx[0] = li;
      this.key[0] = lk;
      let c = 0;
      for (;;) {
        const l = 2 * c + 1, r = l + 1;
        let m = c;
        if (l < this.idx.length && this.key[l]! < this.key[m]!) m = l;
        if (r < this.idx.length && this.key[r]! < this.key[m]!) m = r;
        if (m === c) break;
        this.swap(m, c);
        c = m;
      }
    }
    return top;
  }
  private swap(a: number, b: number) {
    [this.idx[a], this.idx[b]] = [this.idx[b]!, this.idx[a]!];
    [this.key[a], this.key[b]] = [this.key[b]!, this.key[a]!];
  }
}

export type Goal = { point: Point; tolerance: number } | { test: (p: Point) => boolean };

export interface PathResult {
  /** Waypoints after the start, smoothed to straight runs. */
  waypoints: Point[];
  /** True when the goal itself is unreachable and this path only gets as close as possible. */
  partial: boolean;
  /** Path length in map units. */
  length: number;
}

const NEIGHBOURS: [number, number, number][] = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

/** A* (or Dijkstra for predicate goals) from `start` on the grid. Null if nothing useful is reachable. */
export function findPath(g: NavGrid, start: Point, goal: Goal, maxNodes = 120_000): PathResult | null {
  const [scx, scy] = cellOf(g, start.x, start.y);
  const s = isBlocked(g, start.x, start.y) ? nearestFree(g, start.x, start.y) : scy * g.w + scx;
  if (s < 0) return null;
  const n = g.w * g.h;
  const cost = new Float64Array(n).fill(Infinity);
  const parent = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const point = "point" in goal ? goal.point : null;
  const tolerance = "point" in goal ? goal.tolerance : 0;
  const h = (i: number) => {
    if (!point) return 0;
    const c = centre(g, i);
    return Math.max(0, Math.hypot(c.x - point.x, c.y - point.y) - tolerance) / NAV_CELL;
  };
  const reached = (i: number) => (point ? h(i) === 0 : (goal as { test: (p: Point) => boolean }).test(centre(g, i)));
  const heap = new Heap();
  cost[s] = 0;
  heap.push(s, h(s));
  let found = -1, best = s, bestH = h(s), expanded = 0;
  while (heap.size && expanded < maxNodes) {
    const i = heap.pop();
    if (closed[i]) continue;
    closed[i] = 1;
    expanded++;
    if (reached(i)) {
      found = i;
      break;
    }
    const hi = h(i);
    if (hi < bestH) (bestH = hi), (best = i);
    const cx = i % g.w, cy = Math.floor(i / g.w);
    for (const [dx, dy, c] of NEIGHBOURS) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= g.w || ny >= g.h) continue;
      const j = ny * g.w + nx;
      if (g.blocked[j] || closed[j]) continue;
      if (dx && dy && (g.blocked[cy * g.w + nx] || g.blocked[ny * g.w + cx])) continue; // no corner cutting
      if (g.ledgeAt.has(i) || g.ledgeAt.has(j)) {
        if (climbsAny(g, centre(g, i), centre(g, j))) continue; // can drop off a ledge, not climb it
      }
      // Right under a ledge the wall catches the player: only land there by dropping off it.
      if (g.band[j] && !dropsAny(g, centre(g, i), centre(g, j))) continue;
      const nc = cost[i]! + (g.hurts[j] ? c * HURT_COST : g.hug[j] ? c * HUG_COST : c);
      if (nc < cost[j]!) {
        cost[j] = nc;
        parent[j] = i;
        heap.push(j, nc + h(j));
      }
    }
  }
  let partial = false;
  if (found < 0) {
    // Unreachable: go as close as we can, if that is meaningfully closer than where we are.
    if (!point || best === s || h(s) - bestH < 2 || bestH * NAV_CELL > 96) return null;
    found = best;
    partial = true;
  }
  const cells: Point[] = [];
  for (let i = found; i >= 0; i = parent[i]!) cells.push(centre(g, i));
  cells.reverse();
  cells[0] = { x: start.x, y: start.y };
  // Final point: the goal itself when it's free and in a straight line from the last cell.
  if (point && !partial && !isBlocked(g, point.x, point.y) && clearLine(g, cells[cells.length - 1]!, point)) cells.push(point);
  const waypoints: Point[] = [];
  let at = 0;
  while (at < cells.length - 1) {
    let next = at + 1;
    for (let j = cells.length - 1; j > at + 1; j--) {
      // A shortcut may not cut across damaging floor or a ledge's foot that the route itself went around.
      if (clearLine(g, cells[at]!, cells[j]!) && (!crossesAvoid(g, cells[at]!, cells[j]!) || cells.slice(at, j + 1).some((c) => avoidAt(g, c.x, c.y)))) {
        next = j;
        break;
      }
    }
    waypoints.push(cells[next]!);
    at = next;
  }
  let length = 0;
  let prev = cells[0]!;
  for (const w of waypoints) (length += Math.hypot(w.x - prev.x, w.y - prev.y)), (prev = w);
  return { waypoints, partial, length: Math.round(length) };
}
