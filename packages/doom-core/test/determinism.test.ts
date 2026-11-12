import { describe, expect, it } from "vitest";
import { compileTurn, createEngine, totalTics } from "../src/index.ts";
import { WAD, randomLog } from "./fixtures.ts";

const opts = { wad: WAD, skill: 3, episode: 1, map: 1 };

describe("determinism", () => {
  const log = randomLog(3000, 42);

  it("same log gives the same state and frame, twice", async () => {
    const results = [];
    for (let run = 0; run < 2; run++) {
      const e = await createEngine(opts);
      e.replay(log);
      results.push({ state: await e.stateHash(), frame: await e.frameHash(), s: e.getState(), o: e.getObjects() });
    }
    expect(results[0]!.s.gametic).toBe(2 + totalTics(log));
    expect(results[1]).toEqual(results[0]);
  });

  it("rendering and observing between steps does not change the game", async () => {
    const quiet = await createEngine(opts);
    quiet.replay(log);
    const noisy = await createEngine(opts);
    for (const step of log) {
      noisy.applyTicStep(step);
      noisy.render();
      noisy.getObjects();
      noisy.getState();
    }
    expect(await noisy.stateHash()).toBe(await quiet.stateHash());
    expect(await noisy.frameHash()).toBe(await quiet.frameHash());
  });

  it("different logs diverge", async () => {
    const a = await createEngine(opts);
    a.replay(randomLog(500, 1));
    const b = await createEngine(opts);
    b.replay(randomLog(500, 2));
    expect(await a.stateHash()).not.toBe(await b.stateHash());
  });
});

describe("control", () => {
  it("turns exactly", async () => {
    const e = await createEngine(opts);
    const a0 = e.getState().angle;
    e.turn(90);
    expect(e.getState().angle).toBeCloseTo((a0 - 90 + 360) % 360, 1);
    e.turn(-37.5);
    expect(e.getState().angle).toBeCloseTo((a0 - 90 + 37.5 + 360) % 360, 1);
    expect(compileTurn(0)).toEqual([]);
  });

  it("moves forward and fires", async () => {
    const e = await createEngine(opts);
    const s0 = e.getState();
    e.applyStep({ actions: ["forward"], tics: 35 });
    const s1 = e.getState();
    expect(s1.x).toBeGreaterThan(s0.x + 100); // facing east at E1M1 start
    e.applyStep({ actions: ["fire"], tics: 10 });
    expect(e.getState().ammo.bullets).toBeLessThan(s1.ammo.bullets);
  });

  it("rejects bad steps", async () => {
    const e = await createEngine(opts);
    expect(() => e.applyStep({ actions: ["forward"], tics: 0 })).toThrow(RangeError);
    expect(() => e.applyStep({ actions: ["jump" as never], tics: 1 })).toThrow(RangeError);
  });
});
