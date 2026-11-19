// doom_autoplay: a server-side autopilot that chains doom_goto and doom_attack
// until something worth a decision happens, so one call plays several seconds of
// uninterrupted game. Same decision rules as the free eval bot (scripts/eval.ts,
// --policy assisted). Pure function of the game state plus a small memory kept in
// the session (doors walked through, targets that failed): deterministic.

import type { Engine, PlayerState } from "@doom-player/doom-core/core";
import { ammoAdvice, attack, goto, reachableDoors, stopReason, weaponRange, type GotoTarget, type TicSink } from "./autopilot";
import { nearbyInteractives, type Interactive } from "./mapview";
import { friendlyName } from "./names";

export type AutoGoal = "exit" | "explore";

/** Kept in the session between calls; ids are line indices of the current level. */
export interface AutoMemory {
  /** switches and lifts used */
  used: number[];
  /** [door id, levelTime when last walked through] */
  doors?: [number, number][];
  /** [interactive id, levelTime when it failed] */
  failed: [number, number][];
  /** levelTime when last written: a smaller one means the level restarted */
  levelTime: number;
}

const SIGHT = 2048;
const ITEM_RANGE = 768;
const FIST_REACH = 200;
/** Forget a failed target after this long: the way there may be open by then. */
const RETRY_AFTER = 35 * 20;
/**
 * Hand back to the player below this health or after losing MAX_LOSS in one call (hits come in
 * steps of up to ~20); a call that starts below LOW_HEALTH hands back after losing LOW_START_LOSS.
 */
const LOW_HEALTH = 50;
const MAX_LOSS = 35;
const LOW_START_LOSS = 20;
const MAX_IDLE = 4;
/** Explore in slices this long, so the exit, items and doors that come into view are picked up. */
const EXPLORE_SLICE = 105;

export const emptyMemory = (): AutoMemory => ({ used: [], failed: [], levelTime: 0 });

const short = (r: string) => {
  const t = r
    .replace(/^(goto|attack)( [^:]*)?: /, "")
    .replace(/^no route to (.+?) from here\..*/, "no route to $1")
    .replace(/^everything reachable from here is explored\. Closed doors you can reach: id (\d+).*/, "explored everything reachable; next, door $1")
    .replace(/^everything reachable from here is explored, and no closed door is reachable.*/, "explored everything reachable");
  return t.length > 90 ? `${t.slice(0, 87)}...` : t;
};

export function autoplay(engine: Engine, sink: TicSink, visited: Set<string>, goal: AutoGoal, mem: AutoMemory): string {
  const start = engine.getState();
  const early = stopReason(start, start);
  if (early) return `autoplay: can't play: ${early}${start.dead ? ". doom_act ['use'] restarts the level." : ""}`;
  if (start.levelTime < mem.levelTime) Object.assign(mem, emptyMemory()); // died or restarted: doors are closed again
  const budget = sink.left();
  const floor = start.health >= LOW_HEALTH ? Math.max(start.health - MAX_LOSS, LOW_HEALTH) : Math.max(start.health - LOW_START_LOSS, 10);
  const used = new Set(mem.used);
  const failed = new Map(mem.failed);
  const doorsAt = new Map(mem.doors ?? []);
  const skipItems = new Set<number>();
  const moves: string[] = [];
  let tooFar = false;
  let suggested: number | null = null;
  let idle = 0;
  let reason = "";

  while (sink.left() > 0) {
    const s = engine.getState();
    const over = stopReason(start, s);
    if (over) {
      reason = over;
      break;
    }
    if (s.health < floor) {
      reason = `health ${s.health}, down ${start.health - s.health} this call: your call (heal, retreat, or doom_autoplay again to fight on)`;
      break;
    }
    const objs = engine.getObjects(SIGHT);
    const reach = s.weapon === "fist" ? FIST_REACH : weaponRange(s.weapon);
    const enemies = objs.filter((o) => o.kind === "enemy" && o.health > 0 && o.visible);
    const recent = (id: number) => s.levelTime - (failed.get(id) ?? -RETRY_AFTER) < RETRY_AFTER;
    const items = objs.filter((o) => o.kind === "item" && o.visible && o.distance <= ITEM_RANGE && !skipItems.has(o.id) && !recent(o.id));
    const want = (re: RegExp) => items.find((o) => re.test(friendlyName(o.type)));
    const item =
      (s.weapon === "fist" && want(/^(ammo_clip|box_of_bullets|shells|box_of_shells|shotgun|chaingun|backpack|chainsaw)$/)) ||
      want(/_keycard$|_skull_key$/) ||
      (s.health < 50 && want(/^(stimpack|medikit|soulsphere|megasphere)$/)) ||
      want(/^(shotgun|super_shotgun|chaingun|rocket_launcher|plasma_rifle|backpack|green_armor|blue_armor|soulsphere|megasphere|box_of_bullets|box_of_shells)$/) ||
      undefined;
    const ok = (i: Interactive) => !used.has(i.id) && !recent(i.id);
    const list = nearbyInteractives(engine.getLines(), s);
    const isExit = (i: Interactive) => i.kind === "exit_switch" || i.kind === "exit";
    const pick =
      (goal === "exit" ? list.find((i) => isExit(i) && ok(i)) : undefined) ??
      list.find((i) => i.kind === "door" && i.state === "closed" && ok(i) && !doorsAt.has(i.id)) ??
      list.find((i) => i.kind === "locked_door" && i.state === "closed" && s.keys.some((k) => k.startsWith(i.key ?? "?")) && ok(i) && !doorsAt.has(i.id)) ??
      list.find((i) => (i.kind === "switch" || i.kind === "lift") && ok(i));

    if (s.weapon === "fist" && !item && enemies.some((e) => e.distance <= 600)) {
      reason = `out of ammo with enemies around. ${ammoAdvice(engine)}`;
      break;
    }

    const before = sink.left();
    let r: string;
    let target: GotoTarget | null = null;
    let picked: Interactive | undefined;
    if (!tooFar && enemies.some((e) => e.distance <= reach)) r = attack(engine, sink, { minHealth: floor });
    else {
      if (item) target = { kind: "item", id: item.id };
      else if (suggested !== null && !(pick && isExit(pick))) target = { kind: "interactive", id: suggested };
      else if (pick) (target = { kind: "interactive", id: pick.id }), (picked = pick);
      else target = { kind: "explore", visited };
      // Explore in short slices: a route to unexplored space doesn't look out for the exit or items on the way.
      const slice = target.kind === "explore" ? Math.min(EXPLORE_SLICE, sink.left()) : sink.left();
      const spent0 = sink.left();
      const sub: TicSink = { apply: (st) => sink.apply(st), left: () => slice - (spent0 - sink.left()) };
      r = goto(engine, sub, target, { minHealth: floor });
    }
    const ex = /^goto unexplored space: stopped: time's up \(explored (\d+)/.exec(r);
    const lastEx = /^explored (\d+) new areas?$/.exec(moves[moves.length - 1] ?? "");
    if (ex && lastEx) moves[moves.length - 1] = `explored ${Number(lastEx[1]) + Number(ex[1])} new areas`;
    else moves.push(ex ? `explored ${ex[1]} new area${ex[1] === "1" ? "" : "s"}` : short(r));

    tooFar = r.startsWith("attack") && /too far|out of range/.test(r);
    // Everything reachable explored: next, a closed door with unexplored space behind it, else one not yet walked through
    // this life (explore only names the nearest three, and "explored" is per 64-unit cell, so the way on may be behind any).
    suggested = null;
    if (/everything reachable from here is explored\. Closed doors/.test(r)) {
      // Unexplored behind it first, then doors never walked through, then the one walked through longest ago.
      const next = reachableDoors(engine, visited)
        .filter((d) => !recent(d.id) && engine.getState().levelTime - (doorsAt.get(d.id) ?? -RETRY_AFTER) >= RETRY_AFTER)
        .sort((a, b) => Number(b.fresh) - Number(a.fresh) || (doorsAt.get(a.id) ?? -1) - (doorsAt.get(b.id) ?? -1))[0];
      suggested = next ? next.id : null;
    }
    if (target?.kind === "item") {
      skipItems.add(target.id);
      if (/no route|got as close|blocked/.test(r)) failed.set(target.id, s.levelTime);
    }
    const tid = target?.kind === "interactive" ? target.id : null;
    if (tid !== null) {
      const kind = picked?.kind ?? "door";
      if (/no route|didn't open|got as close|blocked/.test(r)) failed.set(tid, s.levelTime);
      // An exit that worked ends the level; one that didn't (wrong side, not in range) is worth another try later.
      else if (kind === "exit_switch" || kind === "exit") failed.set(tid, s.levelTime);
      else if (kind === "door" || kind === "locked_door") {
        if (/walked through|opened it/.test(r)) doorsAt.set(tid, engine.getState().levelTime);
      } else if (/reached|pressed|rode/.test(r)) used.add(tid);
    }
    if (target?.kind === "explore" && /everything reachable from here is explored/.test(r) && suggested === null) {
      reason = /no closed door is reachable/.test(r)
        ? "nothing left to explore from here and no door to open: look for a key, a switch or a lift"
        : "everything reachable is explored, and autoplay went through every closed door it can reach in the last 20 s: look for a key, a switch, a lift, or the exit";
      break;
    }
    if (before - sink.left() === 0) {
      if (++idle >= MAX_IDLE) {
        reason = `stuck: the last ${MAX_IDLE} moves went nowhere (${short(r)})`;
        break;
      }
    } else idle = 0;
  }
  if (!reason) reason = "time's up";

  const end = engine.getState();
  mem.used = [...used].slice(-64);
  mem.doors = [...doorsAt].slice(-64);
  mem.failed = [...failed].filter(([, t]) => end.levelTime - t < RETRY_AFTER).slice(-32);
  mem.levelTime = end.levelTime;
  return `autoplay (${((budget - sink.left()) / 35).toFixed(1)} s): ${summary(start, end)}; stopped: ${reason}. Moves: ${moves.slice(-6).join(" | ") || "none"}`;
}

function summary(a: PlayerState, b: PlayerState): string {
  const parts: string[] = [];
  if (b.kills > a.kills) parts.push(`killed ${b.kills - a.kills}`);
  if (b.items > a.items) parts.push(`picked up ${b.items - a.items} item${b.items - a.items === 1 ? "" : "s"}`);
  const keys = b.keys.filter((k) => !a.keys.includes(k));
  if (keys.length) parts.push(`got the ${keys.join(", ")} key`);
  const weapons = b.weaponsOwned.filter((w) => !a.weaponsOwned.includes(w));
  if (weapons.length) parts.push(`got the ${weapons.join(", ")}`);
  if (b.health !== a.health) parts.push(`health ${a.health} -> ${b.health}`);
  return parts.join(", ") || "nothing notable";
}
