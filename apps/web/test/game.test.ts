import { describe, expect, it } from "vitest";
import { act, clearEngineCache, newGame, observeSession, turn } from "../lib/game";
import { StaleSessionError } from "../lib/session";

const strip = <T extends { events: string[] }>(s: T) => ({ ...s, events: [] });

describe("game service", () => {
  it("replay on a cache miss reproduces the cached state exactly", async () => {
    const g = await newGame({ skill: 3, episode: 1, map: 1, perception: "state" });
    const id = g.session.id;
    await act(id, [{ actions: ["forward"], tics: 35 }], "walk");
    await turn(id, -45, "aim");
    await act(id, [{ actions: ["fire"], tics: 10 }, { actions: ["strafe_right", "run"], tics: 20 }]);
    const warm = await observeSession(id);
    expect(warm.stats.cacheHit).toBe(true);
    clearEngineCache();
    const cold = await observeSession(id);
    expect(cold.stats.cacheHit).toBe(false);
    expect(cold.stats.replayTics).toBe(35 + 4 + 10 + 20); // a 45° turn = 8192 units = 4 tics
    expect(strip(cold.obs.state)).toEqual(strip(warm.obs.state));
    expect(cold.session.captions.map((c) => c.text)).toEqual(["", "aim", "walk"]);
  });

  it("rejects a concurrent write with a stale version", async () => {
    const g = await newGame({ skill: 3, episode: 1, map: 1, perception: "state" });
    const results = await Promise.allSettled([
      act(g.session.id, [{ actions: ["forward"], tics: 5 }]),
      act(g.session.id, [{ actions: ["back"], tics: 5 }]),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(StaleSessionError);
    const now = await observeSession(g.session.id);
    expect(now.session.version).toBe(1);
    expect(now.session.steps).toHaveLength(1);
  });

  it("enforces per-call limits", async () => {
    const g = await newGame({ skill: 3, episode: 1, map: 1, perception: "state" });
    await expect(act(g.session.id, [{ actions: ["forward"], tics: 35 }, { actions: ["forward"], tics: 35 }, { actions: ["forward"], tics: 35 }, { actions: [], tics: 1 }])).rejects.toThrow(/105 tics/);
    await expect(act("nope-nope-nope", [{ actions: [], tics: 1 }])).rejects.toThrow(/Unknown or expired/);
  });

  it("vision mode returns a PNG, state mode does not", async () => {
    const v = await newGame({ skill: 3, episode: 1, map: 1, perception: "vision" });
    expect(v.obs.png?.subarray(1, 4).toString()).toBe("PNG");
    const s = await newGame({ skill: 3, episode: 1, map: 1, perception: "state" });
    expect(s.obs.png).toBeUndefined();
  });
});
