import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { createEngine } from "../src/index.ts";
import { SELFTEST, runSelftest } from "../src/selftest.ts";
import { WAD } from "./fixtures.ts";

it("self-test hashes match the pinned values (same as the browser)", async () => {
  expect(createHash("sha256").update(WAD).digest("hex")).toBe(SELFTEST.wadSha256);
  const e = await createEngine({ wad: WAD, skill: SELFTEST.skill, episode: SELFTEST.episode, map: SELFTEST.map });
  const r = await runSelftest(e);
  console.log(JSON.stringify({ stateHash: r.stateHash, frameHash: r.frameHash }));
  expect(r.stateHash).toBe(SELFTEST.stateHash);
  expect(r.frameHash).toBe(SELFTEST.frameHash);
  expect(r.ok).toBe(true);
});
