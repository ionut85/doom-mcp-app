// Builds what Claude sees after each action: a frame (vision/both) and a
// compact structured state (state/both), plus events derived by diffing the
// player state before and after the action.

import type { Engine, GameObject, PlayerState } from "@doom-player/doom-core/core";
import { TICRATE } from "@doom-player/doom-core/core";
import { encodePng } from "./frame";
import { asciiMap, compassHeading, compassName, MAP_LEGEND, nearbyInteractives, type Interactive } from "./mapview";
import { friendlyName } from "./names";
import type { Perception } from "./session";

/** DOOM's horizontal field of view is 90°: things within ±45° are on screen. */
const HALF_FOV = 45;
const ENEMY_RANGE = 2048;
const ITEM_RANGE = 768;

const AMMO_FOR_WEAPON: Record<string, keyof PlayerState["ammo"] | null> = {
  fist: null,
  chainsaw: null,
  pistol: "bullets",
  chaingun: "bullets",
  shotgun: "shells",
  super_shotgun: "shells",
  rocket_launcher: "rockets",
  plasma_rifle: "cells",
  bfg9000: "cells",
};

export interface EnemyView {
  id: number;
  type: string;
  distance: number;
  /** degrees to turn to face it: doom_turn(turn). Negative = left, positive = right. */
  turn: number;
  /** within the 90° field of view */
  on_screen: boolean;
  /** crosshair is on it: |turn| is within its angular half-width */
  in_crosshair: boolean;
  health: number;
}

export interface ThingView {
  type: string;
  distance: number;
  /** degrees to turn to face it */
  turn: number;
}

export interface StateObservation {
  tic: number;
  time_s: number;
  status: "alive" | "dead" | "level_complete" | "intermission" | "finale";
  health: number;
  armor: number;
  weapon: string;
  ammo: number | null;
  ammo_all: PlayerState["ammo"];
  weapons: string[];
  keys: string[];
  position: { x: number; y: number };
  /** compass heading: 0 = north, 90 = east; doom_turn(+d) adds d */
  heading: number;
  heading_name: string;
  kills: string;
  items: string;
  secrets: string;
  enemies: EnemyView[];
  nearby_items: ThingView[];
  barrels: ThingView[];
  /** doors, switches, lifts and exits nearby */
  interactives: Interactive[];
  map_legend: string;
  map: string[];
  events: string[];
  hint?: string;
}

export interface HudLine {
  health: number;
  armor: number;
  weapon: string;
  ammo: number | null;
  kills: string;
  status: StateObservation["status"];
}

export interface Observation {
  state: StateObservation;
  hud: HudLine;
  /** 640×400 PNG for the model (vision / both) */
  png?: Buffer;
}

function status(s: PlayerState): StateObservation["status"] {
  if (s.gamestate === "intermission") return "level_complete";
  if (s.gamestate === "finale") return "finale";
  if (s.gamestate !== "level") return "intermission";
  return s.dead ? "dead" : "alive";
}

/** Events between two snapshots of the player state. */
export function diffEvents(prev: PlayerState | null, cur: PlayerState): string[] {
  if (!prev) return [];
  const ev: string[] = [];
  const dh = cur.health - prev.health;
  const da = cur.armor - prev.armor;
  if (dh < 0 || (da < 0 && dh <= 0)) {
    const dir = cur.attackerAngle === null ? "" : ` from ${describeAngle(cur.attackerAngle)}`;
    ev.push(`took ${-dh} damage${da < 0 ? ` (and ${-da} armor)` : ""}${dir}`);
  } else if (dh > 0) ev.push(`healed +${dh}`);
  if (da > 0) ev.push(`armor +${da}`);
  const dk = cur.kills - prev.kills;
  if (dk > 0) ev.push(`killed ${dk} ${dk === 1 ? "enemy" : "enemies"}`);
  if (cur.items > prev.items) ev.push(`picked up ${cur.items - prev.items} item(s)`);
  if (cur.secrets > prev.secrets) ev.push("found a secret");
  for (const w of cur.weaponsOwned) if (!prev.weaponsOwned.includes(w)) ev.push(`got the ${w.replace(/_/g, " ")}`);
  for (const k of cur.keys) if (!prev.keys.includes(k)) ev.push(`got the ${k.replace(/_/g, " ")}`);
  for (const [a, n] of Object.entries(cur.ammo)) {
    const d = n - prev.ammo[a as keyof PlayerState["ammo"]];
    if (d > 0) ev.push(`+${d} ${a}`);
  }
  if (cur.weapon !== prev.weapon) ev.push(`switched to ${cur.weapon.replace(/_/g, " ")}`);
  if (!prev.dead && cur.dead) ev.push("YOU DIED");
  if (prev.gamestate === "level" && cur.gamestate === "intermission") ev.push("LEVEL COMPLETE");
  if (prev.gamestate !== "level" && cur.gamestate === "level" && cur.map !== prev.map) ev.push(`entered E${cur.episode}M${cur.map}`);
  if (prev.dead && !cur.dead) ev.push("respawned (level restarted)");
  const moved = Math.hypot(cur.x - prev.x, cur.y - prev.y);
  if (cur.gamestate === "level" && !cur.dead) ev.push(`moved ${Math.round(moved)} units`);
  return ev;
}

function describeAngle(a: number): string {
  const abs = Math.abs(a);
  if (abs <= 15) return "ahead";
  if (abs >= 150) return "behind";
  return `${Math.round(abs)}° ${a < 0 ? "left" : "right"}`;
}

function enemyView(o: GameObject): EnemyView {
  // Angular half-width of the target as seen from the player.
  const halfWidth = (Math.atan2(Math.max(o.radius - 4, 6), Math.max(o.distance, 1)) * 180) / Math.PI;
  return {
    id: o.id,
    type: friendlyName(o.type),
    distance: o.distance,
    turn: o.angle,
    on_screen: Math.abs(o.angle) <= HALF_FOV,
    in_crosshair: Math.abs(o.angle) <= halfWidth,
    health: o.health,
  };
}

const thing = (o: GameObject): ThingView => ({ type: friendlyName(o.type), distance: o.distance, turn: o.angle });

export function hudLine(s: PlayerState): HudLine {
  const ammoKey = AMMO_FOR_WEAPON[s.weapon];
  return {
    health: s.health,
    armor: s.armor,
    weapon: s.weapon,
    ammo: ammoKey ? s.ammo[ammoKey] : null,
    kills: `${s.kills}/${s.totalKills}`,
    status: status(s),
  };
}

export function observe(engine: Engine, prev: PlayerState | null, perception: Perception, visited: Set<string> = new Set()): Observation {
  const s = engine.getState();
  const objs = engine.getObjects(ENEMY_RANGE);
  const enemies = objs
    .filter((o) => o.kind === "enemy" && o.health > 0 && o.visible)
    .slice(0, 8)
    .map(enemyView);
  const nearbyItems = objs
    .filter((o) => o.kind === "item" && o.visible && o.distance <= ITEM_RANGE)
    .slice(0, 6)
    .map(thing);
  const barrels = objs
    .filter((o) => o.type === "MT_BARREL" && o.health > 0 && o.visible && o.distance <= ITEM_RANGE)
    .slice(0, 4)
    .map(thing);
  const hud = hudLine(s);
  // Map awareness is part of the structured state only; vision-only play never sees it.
  const lines = perception === "vision" ? [] : engine.getLines();
  const interactives = perception === "vision" || s.gamestate !== "level" ? [] : nearbyInteractives(lines, s);
  const map = perception === "vision" || s.gamestate !== "level" ? [] : asciiMap(lines, s, objs, visited);
  const st: StateObservation = {
    tic: s.gametic,
    time_s: Math.round((s.levelTime / TICRATE) * 10) / 10,
    status: hud.status,
    health: s.health,
    armor: s.armor,
    weapon: s.weapon,
    ammo: hud.ammo,
    ammo_all: s.ammo,
    weapons: s.weaponsOwned,
    keys: s.keys,
    position: { x: Math.round(s.x), y: Math.round(s.y) },
    heading: compassHeading(s.angle),
    heading_name: compassName(compassHeading(s.angle)),
    kills: `${s.kills}/${s.totalKills}`,
    items: `${s.items}/${s.totalItems}`,
    secrets: `${s.secrets}/${s.totalSecrets}`,
    enemies,
    nearby_items: nearbyItems,
    barrels,
    interactives,
    map_legend: map.length ? MAP_LEGEND : "",
    map,
    events: diffEvents(prev, s),
  };
  if (st.status === "dead") st.hint = "You are dead. doom_act with actions ['use'] restarts the level.";
  else if (st.status === "level_complete") st.hint = "Level complete! doom_act with ['use'] a few times to continue to the next map.";
  else if (enemies.some((e) => e.in_crosshair)) st.hint = "An enemy is in your crosshair: fire.";
  else if (enemies.length) st.hint = `Nearest enemy is ${describeAngle(enemies[0]!.turn)}: doom_turn(${enemies[0]!.turn}) to aim, then fire.`;
  else if (interactives.some((i) => i.in_use_range && i.kind !== "locked_door" && i.state !== "open"))
    st.hint = "Something usable is right in front of you: doom_act ['use'] for 1-2 tics.";
  else if (interactives.length)
    st.hint = `No enemies in sight. Nearest ${interactives[0]!.kind.replace("_", " ")} is ${interactives[0]!.distance} units away: doom_turn(${interactives[0]!.turn}) then move to it. Or head for blank (unvisited) space on the map.`;

  const png = perception === "state" ? undefined : encodePng(engine.render(), engine.width, engine.height, 2);
  return { state: st, hud, png };
}

/** The text block Claude reads. In vision mode only the on-screen HUD numbers are given. */
export function observationText(o: Observation, perception: Perception): string {
  if (perception === "vision") {
    const h = o.hud;
    return JSON.stringify({ hud: { health: h.health, armor: h.armor, ammo: h.ammo, weapon: h.weapon }, status: h.status });
  }
  return JSON.stringify(o.state);
}
