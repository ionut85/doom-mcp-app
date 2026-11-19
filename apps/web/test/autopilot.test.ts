import { describe, expect, it } from "vitest";
import { autoAttack, autoGoto, autoPlay, clearEngineCache, newGame, observeSession } from "../lib/game";

const strip = <T extends { events: string[]; result?: string }>(s: T) => ({ ...s, events: [], result: undefined });

describe("assisted moves", () => {
  it("doom_goto walks to the nearest usable line, presses use, and replays identically", async () => {
    const g = await newGame({ skill: 3, episode: 1, map: 1, perception: "state" });
    const id = g.session.id;
    const door = g.obs.state.interactives.find((i) => i.how === "use");
    expect(door, JSON.stringify(g.obs.state.interactives)).toBeTruthy();
    let r = await autoGoto(id, { interactive_id: door!.id }, { maxSeconds: 6, stopOnEnemy: false, caption: "to the door" });
    for (let i = 0; i < 3 && /time's up/.test(r.obs.state.result ?? ""); i++) r = await autoGoto(id, { interactive_id: door!.id }, { maxSeconds: 6, stopOnEnemy: false });
    console.log(r.obs.state.result, r.obs.state.position, r.session.steps.length, "steps");
    expect(r.obs.state.result).toMatch(/reached the (lift|door|switch)/);
    const warm = await observeSession(id);
    clearEngineCache();
    const cold = await observeSession(id);
    expect(cold.stats.cacheHit).toBe(false);
    expect(strip(cold.obs.state)).toEqual(strip(warm.obs.state));
  });

  it("doom_goto rides E1M1's lift down, then explores the corridor below", async () => {
    const g = await newGame({ skill: 3, episode: 1, map: 1, perception: "state" });
    const id = g.session.id;
    const lift = g.obs.state.interactives.find((i) => i.kind === "lift" && i.how === "walk onto")!;
    let r = await autoGoto(id, { interactive_id: lift.id }, { maxSeconds: 6 });
    expect(r.obs.state.result).toMatch(/rode the lift down 124 units/);
    r = await autoGoto(id, { explore: true }, { maxSeconds: 6 });
    expect(r.obs.state.position.x).toBeGreaterThan(300); // east along the lower corridor
  });

  it("doom_goto explore moves somewhere new", async () => {
    const g = await newGame({ skill: 3, episode: 1, map: 1, perception: "state" });
    const r = await autoGoto(g.session.id, { explore: true }, { maxSeconds: 4 });
    console.log(r.obs.state.result, r.obs.state.position);
    const moved = Math.hypot(r.obs.state.position.x - g.obs.state.position.x, r.obs.state.position.y - g.obs.state.position.y);
    expect(moved).toBeGreaterThan(100);
  });

  it("doom_autoplay chains moves for the whole call, keeps its memory, and replays identically", async () => {
    const g = await newGame({ skill: 3, episode: 1, map: 1, perception: "state" });
    const id = g.session.id;
    let r = g;
    const results: string[] = [];
    for (let i = 0; i < 4 && r.obs.state.status === "alive"; i++) {
      r = await autoPlay(id, { goal: "exit", maxSeconds: 10 });
      results.push(r.obs.state.result ?? "");
    }
    console.log(results.join("\n"), r.obs.state.kills, r.obs.state.position);
    expect(results[0]).toMatch(/^autoplay \(\d+\.\d s\): .*; stopped: .*\. Moves: /);
    expect(r.session.autoplay?.levelTime).toBeGreaterThan(0);
    expect(Number(r.obs.state.kills.split("/")[0])).toBeGreaterThan(0);
    const warm = await observeSession(id);
    clearEngineCache();
    const cold = await observeSession(id);
    expect(strip(cold.obs.state)).toEqual(strip(warm.obs.state));
  });

  it("doom_attack with nothing in sight uses no time", async () => {
    const g = await newGame({ skill: 3, episode: 1, map: 1, perception: "state" });
    const r = await autoAttack(g.session.id, {});
    expect(r.obs.state.result).toMatch(/attack: no enemy in sight/);
    expect(r.session.steps).toHaveLength(0);
  });

  it("explores and fights through the start of E1M1", async () => {
    const g = await newGame({ skill: 3, episode: 1, map: 1, perception: "state" });
    const id = g.session.id;
    let r = g;
    const log: string[] = [];
    const failed = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const st = r.obs.state;
      if (st.status !== "alive") break;
      if (st.enemies.some((e) => e.distance <= 650)) r = await autoAttack(id, {});
      else {
        const t = st.interactives.find((x) => !failed.has(x.id) && ((x.kind === "door" && x.state === "closed") || x.kind === "exit_switch"));
        r = t ? await autoGoto(id, { interactive_id: t.id }, { maxSeconds: 6 }) : await autoGoto(id, { explore: true }, { maxSeconds: 6 });
        if (t && /no route|didn't open/.test(r.obs.state.result ?? "")) failed.add(t.id);
      }
      log.push(`${r.stats.tool} ${r.obs.state.result} | hp ${r.obs.state.health} kills ${r.obs.state.kills} at ${r.obs.state.position.x},${r.obs.state.position.y}`);
    }
    console.log(log.join("\n"), "\ngame time", r.obs.state.time_s, "s in", log.length, "calls;", r.session.steps.length, "log steps");
    expect(r.session.steps.length).toBeGreaterThan(0);
  });
});
