// Saves a finished eval run as a replay file: the session's input log (from the
// live server) plus Claude's captions with the game tic they ended at (from the
// eval transcript). Verifies the replay reaches the same end state.
// Usage: pnpm tsx scripts/export-replay.ts <eval-out run dir> <out.json> [title]
import fs from "node:fs";
import path from "node:path";
import { createEngine } from "@doom-player/doom-core";

const [runDir, outFile, title = ""] = process.argv.slice(2);
if (!runDir || !outFile) throw new Error("usage: export-replay <eval-out run dir> <out.json> [title]");
const ROOT = path.resolve(import.meta.dirname, "..");
const summary = JSON.parse(fs.readFileSync(path.resolve(ROOT, runDir, "summary.json"), "utf8"));
const transcript = JSON.parse(fs.readFileSync(path.resolve(ROOT, runDir, "transcript.json"), "utf8")) as any[];

const res = await fetch("https://doom-player.vercel.app/api/mcp", {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "doom_log", arguments: { session_id: summary.session_id, from: 0 } } }),
});
const log = JSON.parse((await res.text()).split("\n").find((l) => l.startsWith("data: "))!.slice(6)).result.structuredContent;

// Pair each tool call's caption with the game tic in its result.
const captions: { tic: number; text: string }[] = [];
let pending: string[] = [];
for (const e of transcript) {
  if (e.role === "assistant") pending = e.blocks.filter((b: any) => b.tool).map((b: any) => b.input?.caption ?? "");
  if (e.role === "tool_results") {
    e.results.forEach((r: any, i: number) => {
      const m = /"tic":(\d+)/.exec((r.text ?? []).join(" "));
      if (m && pending[i]) captions.push({ tic: Number(m[1]), text: pending[i]! });
    });
    pending = [];
  }
}

// Verify: replaying the log ends where the eval said it did.
const wad = fs.readFileSync(path.join(ROOT, "wads/freedoom1.wad"));
const engine = await createEngine({ wad, skill: log.skill, episode: log.episode, map: log.map });
engine.replay(log.steps.map(([f, s, t, b, n]: number[]) => ({ f, s, t, b, n })));
const end = engine.getState();
console.log(`replayed ${log.total_tics} tics -> ${end.gamestate}, kills ${end.kills}/${end.totalKills}, health ${end.health}; ${captions.length} captions`);
if (summary.exit_reached && end.gamestate !== "intermission") throw new Error("replay did not reach the exit");

const out = {
  title,
  model: summary.model,
  effort: summary.effort,
  perception: summary.perception,
  skill: log.skill,
  episode: log.episode,
  map: log.map,
  actions: summary.actions,
  kills: summary.kills,
  total_kills: summary.total_kills,
  cost_usd: summary.cost_usd,
  date: summary.date,
  total_tics: log.total_tics,
  steps: log.steps,
  captions,
};
fs.writeFileSync(path.resolve(ROOT, outFile), JSON.stringify(out));
console.log(`wrote ${outFile} (${Math.round(fs.statSync(path.resolve(ROOT, outFile)).size / 1024)} KB)`);
