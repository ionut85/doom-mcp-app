// Phase 5 eval: has Claude (or a scripted baseline) play DOOM through the real
// MCP endpoint and scores each run.
//
//   pnpm eval --perception all --skill 2,3 --runs 5           # full matrix, Claude
//   pnpm eval --policy scripted --perception state --runs 5    # no-AI baseline
//   pnpm eval --dry-run                                        # plumbing check, no API calls
//
// Per run it writes eval-out/<run>/{summary.json,transcript.json} and appends
// the summary to docs/eval/results.jsonl. `pnpm eval:report` turns that into docs/EVAL.md.
//
// Claude sees exactly what claude.ai sees: the server's `instructions` as the
// system prompt, the model-visible tools from tools/list (minus doom_new_game:
// the harness starts the game), and the same tool results. Scoring uses the
// app-only doom_stats tool, which the model never sees.

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";

const { values: opt } = parseArgs({
  options: {
    policy: { type: "string", default: "claude" }, // claude | scripted
    model: { type: "string", default: "claude-opus-5-5" },
    effort: { type: "string", default: "medium" }, // low | medium | high | xhigh | max
    perception: { type: "string", default: "both" }, // vision | state | both | all
    skill: { type: "string", default: "3" }, // comma list
    runs: { type: "string", default: "1" },
    actions: { type: "string", default: "50" },
    concurrency: { type: "string", default: "3" },
    endpoint: { type: "string", default: "https://doom-player.vercel.app/api/mcp" },
    label: { type: "string", default: "" },
    "dry-run": { type: "boolean", default: false },
  },
});

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "eval-out");
const RESULTS = path.join(ROOT, "docs/eval/results.jsonl");
const MAX_ACTIONS = Number(opt.actions);
const MAX_NUDGES = 3;
const CELL = 64; // map units per exploration grid cell

// $ per 1M tokens: input, output, cache read, 5-minute cache write.
const PRICES: Record<string, [number, number, number, number]> = {
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-sonnet-5-5": [2, 10, 0.1, 2.5],
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125],
};

// ---------------------------------------------------------------------------
// MCP over Streamable HTTP (stateless JSON-RPC POSTs)

let rpcId = 0;
async function rpc<T = any>(method: string, params: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(opt.endpoint!, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    });
    if (res.status === 429 && attempt < 5) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    const raw = await res.text();
    if (!res.ok) throw new Error(`${method}: HTTP ${res.status} ${raw.slice(0, 200)}`);
    const line = raw.split("\n").find((l) => l.startsWith("data: "));
    const msg = JSON.parse(line ? line.slice(6) : raw);
    if (msg.error) throw new Error(`${method}: ${JSON.stringify(msg.error)}`);
    return msg.result as T;
  }
}

type McpContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type McpResult = { content: McpContent[]; structuredContent?: any; isError?: boolean };
const callTool = (name: string, args: Record<string, unknown>) => rpc<McpResult>("tools/call", { name, arguments: args });

type Stats = {
  gamestate: string; map: number; dead: boolean; health: number; armor: number;
  kills: number; total_kills: number; items: number; total_items: number; secrets: number;
  x: number; y: number; tics_played: number;
};
const getStats = async (sid: string) => (await callTool("doom_stats", { session_id: sid })).structuredContent as Stats;

function toBlocks(content: McpContent[]): Anthropic.Beta.BetaToolResultBlockParam["content"] {
  return content.map((c) =>
    c.type === "image"
      ? { type: "image" as const, source: { type: "base64" as const, media_type: c.mimeType as "image/png", data: c.data } }
      : { type: "text" as const, text: c.text },
  );
}

// ---------------------------------------------------------------------------
// Scoring

class Scorer {
  readonly cells = new Set<string>();
  damage = 0;
  deaths = 0;
  exited = false;
  last: Stats;
  readonly start: { x: number; y: number };
  maxDist = 0;

  constructor(first: Stats) {
    this.last = first;
    this.start = { x: first.x, y: first.y };
    this.visit(first);
  }

  private visit(s: Stats) {
    if (s.gamestate !== "level" || s.dead) return;
    this.cells.add(`${Math.floor(s.x / CELL)},${Math.floor(s.y / CELL)}`);
    this.maxDist = Math.max(this.maxDist, Math.hypot(s.x - this.start.x, s.y - this.start.y));
  }

  update(s: Stats) {
    const p = this.last;
    const respawned = p.dead && !s.dead;
    if (!respawned && s.map === p.map) {
      this.damage += Math.max(0, p.health - s.health) + Math.max(0, p.armor - s.armor);
    }
    if (!p.dead && s.dead) this.deaths++;
    if (s.gamestate === "intermission" || s.map !== p.map) this.exited = true;
    this.visit(s);
    this.last = s;
  }
}

// ---------------------------------------------------------------------------
// One run

interface RunSpec { policy: string; model: string; effort: string; perception: string; skill: number; index: number; label: string }

async function runOnce(spec: RunSpec, tools: Anthropic.Beta.BetaTool[], instructions: string) {
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${spec.policy}-${spec.perception}-s${spec.skill}-${spec.index}`;
  const t0 = Date.now();
  const started = await callTool("doom_new_game", { skill: spec.skill, episode: 1, map: 1, perception: spec.perception });
  const sid = started.structuredContent.session_id as string;
  const scorer = new Scorer(await getStats(sid));
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 };
  const toolCounts: Record<string, number> = {};
  let actions = 0, errors = 0, nudges = 0, fallbackRequests = 0;
  let stop = "budget";

  const finish = (sc: Scorer) => sc.exited;

  if (spec.policy === "scripted") {
    let obs = started;
    let stuck = 0;
    while (actions < MAX_ACTIONS && !finish(scorer)) {
      const st = JSON.parse(obs.content.find((c) => c.type === "text")!.text.split("\n").slice(1).join("\n"));
      const target = st.enemies?.find((e: any) => e.on_screen) ?? st.enemies?.[0];
      let name = "doom_act", args: Record<string, unknown>;
      if (st.status === "dead") args = { session_id: sid, steps: [{ actions: ["use"], tics: 2 }, { actions: [], tics: 10 }] };
      else if (target && !target.in_crosshair && Math.abs(target.turn) > 1) (name = "doom_turn"), (args = { session_id: sid, degrees: target.turn });
      else if (target) args = { session_id: sid, steps: [{ actions: ["fire"], tics: 10 }] };
      else if (stuck >= 2) (name = "doom_turn"), (args = { session_id: sid, degrees: 60 + ((actions * 37) % 90) }), (stuck = 0);
      else args = { session_id: sid, steps: [{ actions: ["forward", "run"], tics: 14 }, { actions: ["use"], tics: 1 }] };
      obs = await callTool(name, args);
      toolCounts[name] = (toolCounts[name] ?? 0) + 1;
      actions++;
      const before = scorer.last;
      scorer.update(await getStats(sid));
      const moved = Math.hypot(scorer.last.x - before.x, scorer.last.y - before.y);
      stuck = moved < 20 && !target ? stuck + 1 : 0;
    }
    if (finish(scorer)) stop = "exit";
    return summarize();
  }

  // --- Claude policy -------------------------------------------------------
  const client = new Anthropic();
  const transcript: unknown[] = [];
  const firstText = started.content.find((c) => c.type === "text")?.text ?? "";
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text:
            `Play DOOM: clear E1M1 by yourself. Find and kill the enemies and reach the exit. Caption each move.\n` +
            `A game is already running (skill ${spec.skill}, perception "${spec.perception}"). You have a budget of ${MAX_ACTIONS} tool calls.\n` +
            `Here is the first observation from doom_new_game:`,
        },
        ...(toBlocks(started.content) as Anthropic.Beta.BetaContentBlockParam[]),
      ],
    },
  ];
  transcript.push({ role: "user", text: firstText.slice(0, 2000), image: started.content.some((c) => c.type === "image") });

  while (actions < MAX_ACTIONS && !finish(scorer)) {
    let resp: Anthropic.Beta.BetaMessage;
    try {
      resp = await client.beta.messages.create({
        model: spec.model,
        max_tokens: 16000,
        system: instructions,
        tools,
        messages,
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: spec.effort as "low" | "medium" | "high" | "xhigh" | "max" },
        cache_control: { type: "ephemeral" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError || e instanceof Anthropic.APIConnectionError) {
        await new Promise((r) => setTimeout(r, 15_000));
        continue;
      }
      throw e;
    }
    usage.requests++;
    usage.input += resp.usage.input_tokens;
    usage.output += resp.usage.output_tokens;
    usage.cacheRead += resp.usage.cache_read_input_tokens ?? 0;
    usage.cacheWrite += resp.usage.cache_creation_input_tokens ?? 0;
    if ((resp.usage.iterations ?? []).some((it) => it.type === "fallback_message")) fallbackRequests++;

    // Append the assistant turn unchanged (preserved thinking requires an append-only history).
    messages.push({ role: "assistant", content: resp.content });
    transcript.push({
      role: "assistant",
      stop_reason: resp.stop_reason,
      blocks: resp.content.map((b) =>
        b.type === "thinking" ? { thinking: b.thinking } : b.type === "text" ? { text: b.text } : b.type === "tool_use" ? { tool: b.name, input: b.input } : { type: b.type },
      ),
    });

    if (resp.stop_reason === "refusal") {
      stop = "refusal";
      break;
    }
    const uses = resp.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (!uses.length) {
      if (nudges++ >= MAX_NUDGES) {
        stop = "model_stopped";
        break;
      }
      messages.push({ role: "user", content: `Keep playing: use the tools. ${MAX_ACTIONS - actions} tool calls left.` });
      transcript.push({ role: "user", text: "nudge" });
      continue;
    }

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const u of uses) {
      toolCounts[u.name] = (toolCounts[u.name] ?? 0) + 1;
      if (actions >= MAX_ACTIONS || finish(scorer)) {
        results.push({ type: "tool_result", tool_use_id: u.id, is_error: true, content: "Not run: the action budget is used up." });
        continue;
      }
      let r: McpResult;
      try {
        r = await callTool(u.name, u.input as Record<string, unknown>);
      } catch (e) {
        r = { content: [{ type: "text", text: String(e) }], isError: true };
      }
      actions++;
      if (r.isError) errors++;
      results.push({ type: "tool_result", tool_use_id: u.id, is_error: r.isError || undefined, content: toBlocks(r.content) });
      scorer.update(await getStats(sid));
    }
    messages.push({ role: "user", content: results });
    transcript.push({
      role: "tool_results",
      results: results.map((r) => ({ error: r.is_error ?? false, text: (r.content as any[]).filter((c) => c.type === "text").map((c) => c.text.slice(0, 600)) })),
      stats: { hp: scorer.last.health, kills: scorer.last.kills, dead: scorer.last.dead, gamestate: scorer.last.gamestate },
    });
  }
  if (finish(scorer)) stop = "exit";

  const s = summarize();
  fs.mkdirSync(path.join(OUT, runId), { recursive: true });
  fs.writeFileSync(path.join(OUT, runId, "transcript.json"), JSON.stringify(transcript, null, 1));
  return s;

  function summarize() {
    const last = scorer.last;
    const p = PRICES[spec.model] ?? [0, 0, 0, 0];
    const cost = spec.policy === "claude" ? (usage.input * p[0] + usage.output * p[1] + usage.cacheRead * p[2] + usage.cacheWrite * p[3]) / 1e6 : 0;
    const summary = {
      run_id: runId,
      date: new Date().toISOString(),
      label: spec.label,
      policy: spec.policy,
      model: spec.policy === "claude" ? spec.model : null,
      effort: spec.policy === "claude" ? spec.effort : null,
      perception: spec.perception,
      skill: spec.skill,
      session_id: sid,
      stop,
      actions,
      tool_counts: toolCounts,
      tool_errors: errors,
      nudges,
      kills: last.kills,
      total_kills: last.total_kills,
      items: last.items,
      secrets: last.secrets,
      damage_taken: scorer.damage,
      deaths: scorer.deaths,
      exit_reached: scorer.exited,
      cells_explored: scorer.cells.size,
      max_distance: Math.round(scorer.maxDist),
      tics_played: last.tics_played,
      final_health: last.health,
      requests: usage.requests,
      tokens: { input: usage.input, output: usage.output, cache_read: usage.cacheRead, cache_write: usage.cacheWrite },
      tokens_per_action: actions ? Math.round((usage.input + usage.output + usage.cacheRead + usage.cacheWrite) / actions) : 0,
      output_tokens_per_action: actions ? Math.round(usage.output / actions) : 0,
      fallback_requests: fallbackRequests,
      cost_usd: Math.round(cost * 1000) / 1000,
      wall_s: Math.round((Date.now() - t0) / 1000),
    };
    fs.mkdirSync(path.join(OUT, runId), { recursive: true });
    fs.writeFileSync(path.join(OUT, runId, "summary.json"), JSON.stringify(summary, null, 2));
    return summary;
  }
}

// ---------------------------------------------------------------------------
// Main

const init = await rpc<{ instructions?: string; serverInfo: { version: string } }>("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "doom-eval", version: "1.0.0" },
});
const listed = await rpc<{ tools: { name: string; description: string; inputSchema: any; _meta?: any }[] }>("tools/list", {});
const tools: Anthropic.Beta.BetaTool[] = listed.tools
  .filter((t) => !(t._meta?.ui?.visibility ?? ["model"]).every((v: string) => v === "app")) // model-visible only
  .filter((t) => t.name !== "doom_new_game") // the harness starts the game
  .map((t) => {
    const { $schema: _drop, ...schema } = t.inputSchema;
    return { name: t.name, description: t.description, input_schema: schema };
  });
const instructions = init.instructions ?? "";

const perceptions = opt.perception === "all" ? ["vision", "state", "both"] : opt.perception!.split(",");
const skills = opt.skill!.split(",").map(Number);
const specs: RunSpec[] = [];
for (const perception of perceptions)
  for (const skill of skills)
    for (let i = 0; i < Number(opt.runs); i++)
      specs.push({ policy: opt.policy!, model: opt.model!, effort: opt.effort!, perception, skill, index: i, label: opt.label! });

console.log(`server ${init.serverInfo.version} · tools for the model: ${tools.map((t) => t.name).join(", ")} · instructions ${instructions.length} chars`);
console.log(`${specs.length} run(s): policy=${opt.policy} model=${opt.model} effort=${opt.effort} perception=${perceptions} skill=${skills} actions<=${MAX_ACTIONS}`);
if (opt["dry-run"]) {
  console.log("dry run: no runs started");
  process.exit(0);
}

fs.mkdirSync(path.dirname(RESULTS), { recursive: true });
const queue = [...specs];
let totalCost = 0;
async function worker() {
  for (let spec = queue.shift(); spec; spec = queue.shift()) {
    try {
      const s = await runOnce(spec, tools, instructions);
      totalCost += s.cost_usd;
      fs.appendFileSync(RESULTS, JSON.stringify(s) + "\n");
      console.log(
        `${s.perception.padEnd(6)} s${s.skill} #${spec.index}  kills ${s.kills}/${s.total_kills}  dmg ${s.damage_taken}  deaths ${s.deaths}  exit ${s.exit_reached ? "YES" : "no"}  cells ${s.cells_explored}  actions ${s.actions}  stop ${s.stop}  $${s.cost_usd.toFixed(2)}  ${s.wall_s}s`,
      );
    } catch (e) {
      console.error(`run failed (${spec.perception} s${spec.skill} #${spec.index}):`, e instanceof Error ? e.message : e);
    }
  }
}
await Promise.all(Array.from({ length: Math.min(Number(opt.concurrency), specs.length) }, worker));
console.log(`done · total cost $${totalCost.toFixed(2)}`);
