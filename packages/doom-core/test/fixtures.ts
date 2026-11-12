import fs from "node:fs";
import path from "node:path";
import { ACTIONS, compileStep, compileTurn, type Action, type TicStep } from "../src/index.ts";

const root = path.resolve(import.meta.dirname, "../../..");
export const WAD = fs.readFileSync(process.env.DOOM_IWAD ?? path.join(root, "wads/freedoom1.wad"));

/** Deterministic pseudo-random play log of roughly `tics` tics (mulberry32). */
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
