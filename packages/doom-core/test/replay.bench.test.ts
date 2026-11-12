// Replay cost: what every doom_act pays on a cache miss (fresh instance + full replay).
import { describe, expect, it } from "vitest";
import { compileStep, compileTurn, createEngine, type TicStep } from "../src/index.ts";
import { WAD, randomLog } from "./fixtures.ts";

/** Holds fire while walking and sweeping: wakes monsters, so tics cost more. */
function combatLog(tics: number): TicStep[] {
  const log: TicStep[] = [];
  for (let t = 0; t < tics; ) {
    const s = compileStep({ actions: ["forward", "fire", "turn_right"], tics: 35 });
    log.push(s, ...compileTurn(45));
    t += s.n + 4;
  }
  return log;
}

describe("replay benchmark", () => {
  for (const [kind, tics] of [["wander", 1000], ["wander", 5000], ["wander", 10000], ["combat", 1000], ["combat", 5000], ["combat", 10000]] as const) {
    it(`${kind} ${tics} tics`, async () => {
      const log = kind === "wander" ? randomLog(tics, 7) : combatLog(tics);
      const t0 = performance.now();
      const e = await createEngine({ wad: WAD });
      const t1 = performance.now();
      e.replay(log);
      const t2 = performance.now();
      e.render();
      const t3 = performance.now();
      const ms = (x: number) => x.toFixed(1).padStart(7);
      console.log(`${kind.padEnd(6)} ${String(tics).padStart(5)} tics: boot ${ms(t1 - t0)} ms  replay ${ms(t2 - t1)} ms  render ${ms(t3 - t2)} ms  (${Math.round(tics / ((t2 - t1) / 1000))} tics/s)`);
      expect(t2 - t1).toBeLessThan(tics); // generous: > 1000 tics/s
    });
  }
});
