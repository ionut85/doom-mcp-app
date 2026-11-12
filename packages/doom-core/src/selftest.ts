// Cross-host determinism check. The same seeded log is replayed in Node (test)
// and in the browser (/play?selftest=1); both must produce these hashes.
// If the engine, the doom-core state layout or the WAD changes, regenerate with
// `pnpm vitest run packages/doom-core/test/selftest.test.ts` and update below.

import { ACTIONS, compileStep, compileTurn, type Action, type Engine, type TicStep } from "./core.ts";

/** Deterministic pseudo-random play log of at least `tics` tics (mulberry32). */
export function randomLog(tics: number, seed = 1): TicStep[] {
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const log: TicStep[] = [];
  let total = 0;
  while (total < tics) {
    if (rnd() < 0.15) {
      for (const s of compileTurn(Math.round((rnd() - 0.5) * 360))) log.push(s);
    } else {
      const actions = ACTIONS.filter(() => rnd() < 0.2) as Action[];
      log.push(compileStep({ actions, tics: 1 + Math.floor(rnd() * 20) }));
    }
    total = log.reduce((s, x) => s + x.n, 0);
  }
  return log;
}

export const SELFTEST = {
  skill: 3,
  episode: 1,
  map: 1,
  tics: 3000,
  seed: 42,
  /** sha256 of freedoom1.wad 0.13.0 */
  wadSha256: "7323bcc168c5a45ff10749b339960e98314740a734c30d4b9f3337001f9e703d",
  stateHash: "80ec6f30f0d404abed6d8dcfe35ac3c5522f01b4c619baafb33671873dabe068",
  frameHash: "2cf19a3f8e1acf6cd5f1b2b6833678267544c2aeeedab633818cd9351437f279",
} as const;

export interface SelftestResult {
  ok: boolean;
  stateHash: string;
  frameHash: string;
  gametic: number;
  ms: number;
}

/** Replays the self-test log on a freshly created engine and compares hashes. */
export async function runSelftest(engine: Engine): Promise<SelftestResult> {
  const t0 = performance.now();
  engine.replay(randomLog(SELFTEST.tics, SELFTEST.seed));
  const stateHash = await engine.stateHash();
  const frameHash = await engine.frameHash();
  return {
    ok: stateHash === SELFTEST.stateHash && frameHash === SELFTEST.frameHash,
    stateHash,
    frameHash,
    gametic: engine.getState().gametic,
    ms: performance.now() - t0,
  };
}
