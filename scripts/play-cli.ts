// Runs a scripted step list headlessly and writes PNG frames to out/.
// Usage: pnpm play-cli [script.json]   (default: a short E1M1 walk)
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { createEngine, upscale, type Step, type TicStep } from "@doom-player/doom-core";

type ScriptItem = Step | { turn: number } | { snapshot: string };

const DEFAULT_SCRIPT: ScriptItem[] = [
  { snapshot: "00-start" },
  { actions: ["forward"], tics: 35 },
  { snapshot: "01-forward" },
  { turn: 90 },
  { snapshot: "02-turned-right-90" },
  { actions: ["fire"], tics: 10 },
  { snapshot: "03-fire" },
  { turn: -180 },
  { actions: ["forward", "run"], tics: 35 },
  { snapshot: "04-run-back" },
];

const root = path.resolve(import.meta.dirname, "..");
const wadPath = process.env.DOOM_IWAD ?? path.join(root, "wads/freedoom1.wad");
const script: ScriptItem[] = process.argv[2] ? JSON.parse(fs.readFileSync(process.argv[2], "utf8")) : DEFAULT_SCRIPT;
const outDir = path.join(root, "out");
fs.mkdirSync(outDir, { recursive: true });

const engine = await createEngine({ wad: fs.readFileSync(wadPath), skill: 3, episode: 1, map: 1 });
const log: TicStep[] = [];

function snapshot(name: string) {
  const frame = upscale(engine.render(), engine.width, engine.height, 2);
  const png = new PNG({ width: engine.width * 2, height: engine.height * 2 });
  png.data = Buffer.from(frame.buffer);
  const file = path.join(outDir, `${name}.png`);
  fs.writeFileSync(file, PNG.sync.write(png));
  const s = engine.getState();
  const near = engine.getObjects(1024).filter((o) => o.visible).slice(0, 3);
  console.log(
    `${name}: tic=${s.gametic} hp=${s.health} ammo=${s.ammo.bullets} pos=(${s.x},${s.y}) angle=${s.angle}°`,
    near.map((o) => `${o.type}@${o.distance}u/${o.angle}°`).join(" "),
    `→ ${path.relative(root, file)}`,
  );
}

for (const item of script) {
  if ("snapshot" in item) snapshot(item.snapshot);
  else if ("turn" in item) log.push(...engine.turn(item.turn));
  else log.push(engine.applyStep(item));
}
fs.writeFileSync(path.join(outDir, "log.json"), JSON.stringify(log));
console.log(`steps=${log.length} state=${(await engine.stateHash()).slice(0, 16)}`);
