// Prints an eval run's transcript as a compact timeline, for failure analysis.
// Usage: pnpm tsx scripts/eval-timeline.ts [eval-out/<run-id>] [--thinking]
// With no run given, uses the most recent run.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const showThinking = args.includes("--thinking");
let dir = args.find((a) => !a.startsWith("--"));
if (!dir) {
  const runs = fs.readdirSync(path.join(ROOT, "eval-out")).filter((d) => fs.existsSync(path.join(ROOT, "eval-out", d, "transcript.json"))).sort();
  dir = path.join("eval-out", runs[runs.length - 1]!);
}
const t = JSON.parse(fs.readFileSync(path.resolve(ROOT, dir, "transcript.json"), "utf8")) as any[];
const summary = JSON.parse(fs.readFileSync(path.resolve(ROOT, dir, "summary.json"), "utf8"));
console.log(`${dir}\n${JSON.stringify({ kills: `${summary.kills}/${summary.total_kills}`, dmg: summary.damage_taken, deaths: summary.deaths, exit: summary.exit_reached, cells: summary.cells_explored, stop: summary.stop, cost: summary.cost_usd })}\n`);

let n = 0;
for (const e of t) {
  if (e.role === "assistant") {
    for (const b of e.blocks) {
      if (b.thinking && showThinking) console.log(`   · ${b.thinking.replace(/\s+/g, " ").slice(0, 300)}`);
      if (b.text) console.log(`   » ${b.text.replace(/\s+/g, " ").slice(0, 200)}`);
      if (b.tool) {
        const i = b.input ?? {};
        const what = b.tool === "doom_turn" ? `turn ${i.degrees}°` : b.tool === "doom_act" ? (i.steps ?? []).map((s: any) => `${s.actions.join("+") || "wait"}×${s.tics}`).join(", ") : b.tool;
        console.log(`${String(++n).padStart(3)} ${what.padEnd(40)} ${i.caption ?? ""}`);
      }
    }
    if (e.stop_reason !== "tool_use") console.log(`   [stop: ${e.stop_reason}]`);
  } else if (e.role === "tool_results") {
    for (const r of e.results) {
      const txt = (r.text as string[]).join(" ");
      let ev = "";
      try {
        const j = JSON.parse(txt.slice(txt.indexOf("\n") + 1));
        ev = [...(j.events ?? []).filter((x: string) => !x.startsWith("moved")), (j.events ?? []).find((x: string) => x.startsWith("moved")), j.enemies?.length ? `${j.enemies.length} enemies visible` : ""].filter(Boolean).join("; ");
      } catch {
        ev = txt.slice(0, 120);
      }
      console.log(`      ${r.error ? "ERROR " : ""}hp ${e.stats.hp} kills ${e.stats.kills}${e.stats.dead ? " DEAD" : ""}  ${ev}`);
    }
  } else if (e.role === "user" && e.text === "nudge") {
    console.log("   [nudged to keep playing]");
  }
}
