// Drives the MCP endpoint with a simple heuristic bot (no LLM): a smoke test
// for the tool surface, a latency benchmark, and a baseline for evals.
// Usage: pnpm tsx scripts/mcp-bot.ts [url] [actions] [perception]
//   url defaults to http://localhost:3000/api/mcp

const url = process.argv[2] ?? "http://localhost:3000/api/mcp";
const N = Number(process.argv[3] ?? 40);
const perception = process.argv[4] ?? "state";

type Enemy = { type: string; distance: number; angle: number; in_crosshair: boolean; on_screen: boolean };
type State = {
  status: string;
  health: number;
  ammo: number | null;
  weapon: string;
  kills: string;
  enemies: Enemy[];
  events: string[];
  position: { x: number; y: number };
};

let id = 0;
const latencies: number[] = [];

async function call(name: string, args: Record<string, unknown>): Promise<{ text: string; sc: Record<string, unknown>; bytes: number; ms: number }> {
  const t0 = performance.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
  });
  const raw = await res.text();
  const ms = performance.now() - t0;
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status} ${raw.slice(0, 200)}`);
  const data = raw.split("\n").find((l) => l.startsWith("data: "));
  const msg = JSON.parse(data ? data.slice(6) : raw);
  if (msg.error) throw new Error(`${name}: ${JSON.stringify(msg.error)}`);
  const r = msg.result;
  const text = r.content.find((c: { type: string }) => c.type === "text")?.text ?? "";
  if (r.isError) throw new Error(`${name}: ${text}`);
  latencies.push(ms);
  return { text, sc: r.structuredContent ?? {}, bytes: raw.length, ms };
}

const parse = (text: string): State => JSON.parse(text.slice(text.indexOf("\n") + 1));

const start = await call("doom_new_game", { skill: 2, perception });
const sessionId = start.sc.session_id as string;
let s = parse(start.text);
console.log(`session ${sessionId} (${perception}) new_game ${Math.round(start.ms)} ms`);

let stuck = 0;
for (let i = 0; i < N; i++) {
  let r;
  const target = s.enemies.find((e) => e.on_screen) ?? s.enemies[0];
  if (s.status === "dead" || s.status === "level_complete") {
    r = await call("doom_act", { session_id: sessionId, steps: [{ actions: ["use"], tics: 2 }, { actions: [], tics: 10 }], caption: "Continuing" });
  } else if (target && !target.in_crosshair && Math.abs(target.angle) > 1) {
    r = await call("doom_turn", { session_id: sessionId, degrees: target.angle, caption: `Aiming at the ${target.type}` });
  } else if (target) {
    r = await call("doom_act", { session_id: sessionId, steps: [{ actions: ["fire"], tics: 10 }], caption: `Shooting the ${target.type}` });
  } else if (stuck >= 2) {
    r = await call("doom_turn", { session_id: sessionId, degrees: 60 + ((i * 37) % 90), caption: "Blocked, turning" });
    stuck = 0;
  } else {
    r = await call("doom_act", { session_id: sessionId, steps: [{ actions: ["forward", "run"], tics: 14 }, { actions: ["use"], tics: 1 }], caption: "Exploring" });
  }
  s = parse(r.text);
  const moved = Number(s.events.find((e) => e.startsWith("moved"))?.split(" ")[1] ?? 0);
  stuck = moved < 20 && !target ? stuck + 1 : 0;
  console.log(
    `${String(i + 1).padStart(3)} ${String(Math.round(r.ms)).padStart(5)} ms ${String(r.bytes).padStart(7)} B  hp ${s.health} ammo ${s.ammo} kills ${s.kills} ${s.status}  ${s.events.filter((e) => !e.startsWith("moved")).join("; ")}`,
  );
}

const sorted = [...latencies].sort((a, b) => a - b);
const pct = (p: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!);
console.log(`\ncalls=${latencies.length} p50=${pct(50)} ms p95=${pct(95)} ms max=${pct(100)} ms  final: hp ${s.health} kills ${s.kills} status ${s.status}`);
