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
}

export type Point = { x: number; y: number };

export function distToSegment(px: number, py: number, l: Pick<MapLine, "x1" | "y1" | "x2" | "y2">): number {
  const dx = l.x2 - l.x1, dy = l.y2 - l.y1;
  const len2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - l.x1) * dx + (py - l.y1) * dy) / len2));
  return Math.hypot(px - (l.x1 + t * dx), py - (l.y1 + t * dy));
}

export function buildGrid(lines: MapLine[]): NavGrid {
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
  for (const l of lines) {
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
  return { x0, y0, w, h, blocked };
}

const cellOf = (g: NavGrid, x: number, y: number): [number, number] => [Math.floor((x - g.x0) / NAV_CELL), Math.floor((y - g.y0) / NAV_CELL)];
const centre = (g: NavGrid, i: number): Point => ({ x: g.x0 + ((i % g.w) + 0.5) * NAV_CELL, y: g.y0 + (Math.floor(i / g.w) + 0.5) * NAV_CELL });

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
    if (isBlocked(g, a.x + ((b.x - a.x) * i) / n, a.y + ((b.y - a.y) * i) / n)) return false;
  }
  return true;
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
      const nc = cost[i]! + c;
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
      if (clearLine(g, cells[at]!, cells[j]!)) {
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
