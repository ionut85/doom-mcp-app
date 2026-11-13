import { createMcpHandler } from "mcp-handler";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { ACTIONS, MAX_TICS_PER_STEP } from "@doom-player/doom-core/core";
import { loadViewerHtml, publicOrigin } from "@/lib/assets";
import { act, frame, inputLog, LIMITS, logResponse, newGame, observeSession, stats, turn, type Result } from "@/lib/game";
import { observationText } from "@/lib/observe";
import { rateLimit } from "@/lib/ratelimit";
import { PERCEPTIONS, sessionStore } from "@/lib/session";

export const maxDuration = 60;

const VIEWER_URI = "ui://doom/viewer";

const INSTRUCTIONS = `You are playing DOOM (Freedoom Phase 1, E1M1 by default). The game is frozen between your tool calls: time only passes when you act, so think as long as you like.

Goal: kill what threatens you, and find the level's exit (an exit switch, X on the map). Keep the session_id and pass a short "caption" on every doom_act / doom_turn (the audience sees it).

Directions:
- "turn" values (on enemies, items, interactives) are exactly the argument for doom_turn: negative = left, positive = right.
- "heading" is a compass bearing: 0 = north, 90 = east, 180 = south, 270 = west. doom_turn(+30) adds 30 to it. The map is drawn north-up.

Fighting:
- To shoot an enemy: doom_turn(enemy.turn), then doom_act fire for 7-14 tics, then look again (enemies move, so "turn" changes). "in_crosshair": true means a shot will hit. Hitscan weapons only auto-aim vertically, so turn precisely first.
- The pistol is weak and misses a lot beyond ~300 units: close in, or switch to the shotgun (weapon_3) as soon as you pick one up.
- Against several enemies, don't stand in the open: back out of their line of sight into a doorway or corridor and let them come to you one at a time.
- Back off before health drops below 40, and pick up stimpacks / medikits (nearby_items) when hurt.
- Shoot explosive barrels near groups of enemies, but not when you are within ~150 units of one.

Moving and exploring (state/both perception includes a map and an "interactives" list):
- Plan routes on the map instead of turning around to look: walls are #, closed doors D, switches S, lifts =, the exit X, and "." marks cells you have already visited. Unvisited space next to a doorway or an open edge is where to explore next.
- Doors open with "use": get within 64 units, face the door (|turn| small) and doom_act ["use"] for 1-2 tics; the door stays open for a few seconds, so walk through right away. "in_use_range": true means use will work now. Locked doors (L) need the key of that color first.
- Walls that are not doors never open. If "moved 0 units" appears, you are against a wall: turn toward an opening on the map.
- Use longer moves (21-35 tics with run) through cleared areas, shorter ones (7-14 tics) near enemies.
- When dead, doom_act ["use"] restarts the level.`;

const caption = z.string().max(LIMITS.maxCaptionLength).optional().describe("One short sentence about what you are doing and why, shown to the audience, e.g. 'Turning to face the imp on the left'.");
const sessionId = z.string().min(10).max(40).describe("session_id returned by doom_new_game");

function toolResult(r: Result, extra: Record<string, unknown> = {}) {
  const text = `session_id: ${r.session.id}\n${observationText(r.obs, r.session.perception)}`;
  const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [];
  if (r.obs.png) content.push({ type: "image", data: r.obs.png.toString("base64"), mimeType: "image/png" });
  content.push({ type: "text", text });
  const result = { content, structuredContent: { session_id: r.session.id, version: r.session.version, hud: r.obs.hud, ...extra } };
  logResponse(r, JSON.stringify(result).length);
  return result;
}

const handler = createMcpHandler(
  (server) => {
    registerAppResource(server, "DOOM viewer", VIEWER_URI, { description: "Inline DOOM viewer" }, async () => {
      const origin = publicOrigin();
      return {
        contents: [
          {
            uri: VIEWER_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: await loadViewerHtml(),
            _meta: {
              ui: {
                prefersBorder: true,
                // "Play yourself" loads the engine glue (module script), wasm and WAD from our own domain.
                csp: { resourceDomains: [origin], connectDomains: [origin] },
                // Optional: push-to-talk in the viewer ("Tell Claude" by voice). Hosts may refuse it; typing still works.
                permissions: { microphone: {} },
              },
            },
          },
        ],
      };
    });

    registerAppTool(
      server,
      "doom_new_game",
      {
        title: "New DOOM game",
        description:
          "Start a new game of DOOM and show it in an inline viewer. Returns a session_id and the first observation (screenshot and/or structured state, depending on `perception`). The game is frozen until you call doom_act or doom_turn.",
        inputSchema: z.object({
          skill: z.number().int().min(1).max(5).default(3).describe("1 = easiest, 3 = normal (Hurt me plenty), 5 = nightmare"),
          episode: z.number().int().min(1).max(4).default(1),
          map: z.number().int().min(1).max(9).default(1),
          perception: z.enum(PERCEPTIONS).default("both").describe("What you get back after each action: 'vision' = screenshot + HUD numbers only; 'state' = structured state only (no image); 'both' = screenshot + structured state"),
        }),
        _meta: { ui: { resourceUri: VIEWER_URI } },
      },
      async ({ skill, episode, map, perception }) => toolResult(await newGame({ skill, episode, map, perception })),
    );

    server.registerTool(
      "doom_act",
      {
        title: "DOOM: act",
        description: `Hold actions for a number of tics (35 tics = 1 second), as a sequence of up to ${LIMITS.maxStepsPerCall} steps, ${LIMITS.maxTicsPerCall} tics total. Returns the observation after the last step. Actions: ${ACTIONS.join(", ")}. "run" doubles move/turn speed. turn_left/turn_right turn ~3.5°/tic (7° with run); for exact aiming prefer doom_turn. "use" opens doors and presses switches when facing them up close. weapon_N switches weapon (1 fist/chainsaw, 2 pistol, 3 shotgun, 4 chaingun, 5 rocket launcher, 6 plasma, 7 BFG). An empty actions list waits.`,
        inputSchema: z.object({
          session_id: sessionId,
          steps: z
            .array(
              z.object({
                actions: z.array(z.enum(ACTIONS)).max(6),
                tics: z.number().int().min(1).max(MAX_TICS_PER_STEP),
              }),
            )
            .min(1)
            .max(LIMITS.maxStepsPerCall),
          caption,
        }),
      },
      async ({ session_id, steps, caption }) => toolResult(await act(session_id, steps, caption)),
    );

    server.registerTool(
      "doom_turn",
      {
        title: "DOOM: turn",
        description:
          "Turn by an exact number of degrees: negative = left, positive = right. Every \"turn\" value in observations is the exact argument to face that thing: doom_turn(enemy.turn), then doom_act fire. Adds the degrees to your compass heading. Takes a few tics (max ~11°/tic).",
        inputSchema: z.object({ session_id: sessionId, degrees: z.number().min(-180).max(180), caption }),
      },
      async ({ session_id, degrees, caption }) => toolResult(await turn(session_id, degrees, caption)),
    );

    server.registerTool(
      "doom_observe",
      {
        title: "DOOM: observe",
        description: "Get the current observation without letting any time pass.",
        inputSchema: z.object({ session_id: sessionId }),
      },
      async ({ session_id }) => toolResult(await observeSession(session_id)),
    );

    registerAppTool(
      server,
      "doom_frame",
      {
        title: "DOOM: viewer frame",
        description: "App-only: latest frame, HUD and captions for the inline viewer. Returns {unchanged: true} if the session version equals since_version.",
        inputSchema: z.object({
          session_id: sessionId,
          since_version: z.number().int().optional(),
          include_frame: z.boolean().default(true).describe("false when the viewer renders frames itself (smooth playback)"),
        }),
        _meta: { ui: { resourceUri: VIEWER_URI, visibility: ["app"] } },
      },
      async ({ session_id, since_version, include_frame }) => {
        const s = await sessionStore().get(session_id);
        if (since_version !== undefined && s.version === since_version) {
          return { content: [{ type: "text", text: "unchanged" }], structuredContent: { unchanged: true, version: s.version } };
        }
        const f = await frame(session_id, include_frame);
        return {
          content: [{ type: "text", text: `version ${f.session.version}` }],
          structuredContent: {
            session_id,
            version: f.session.version,
            perception: f.session.perception,
            skill: f.session.skill,
            episode: f.session.episode,
            map: f.session.map,
            tic: f.tic,
            hud: f.hud,
            captions: f.session.captions.slice(0, 8),
            replayed: !f.cacheHit,
            replay_tics: f.replayTics,
            ...(f.png ? { frame: f.png.toString("base64") } : {}),
          },
        };
      },
    );

    registerAppTool(
      server,
      "doom_log",
      {
        title: "DOOM: input log",
        description: "App-only: the session's input log from step `from` on, so the viewer can rebuild the game locally (smooth playback, take over from Claude).",
        inputSchema: z.object({ session_id: sessionId, from: z.number().int().min(0).default(0) }),
        _meta: { ui: { resourceUri: VIEWER_URI, visibility: ["app"] } },
      },
      async ({ session_id, from }) => {
        const log = await inputLog(session_id, from);
        return { content: [{ type: "text", text: `${log.steps.length} steps` }], structuredContent: log };
      },
    );

    registerAppTool(
      server,
      "doom_stats",
      {
        title: "DOOM: stats",
        description: "App-only: full player state (position, kills, health, map) regardless of perception mode. Used by the eval harness for scoring; never shown to the model.",
        inputSchema: z.object({ session_id: sessionId }),
        _meta: { ui: { resourceUri: VIEWER_URI, visibility: ["app"] } },
      },
      async ({ session_id }) => {
        const st = await stats(session_id);
        return { content: [{ type: "text", text: JSON.stringify(st) }], structuredContent: st };
      },
    );
  },
  { serverInfo: { name: "doom-player", version: "0.3.0" }, instructions: INSTRUCTIONS },
);

async function guarded(req: Request): Promise<Response> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (req.method === "POST" && !(await rateLimit(ip))) {
    return new Response(JSON.stringify({ error: "rate limited" }), { status: 429, headers: { "content-type": "application/json", "retry-after": "10" } });
  }
  if (req.method !== "POST") return handler(req);
  // One log line when a request starts and one when its response body ends, so a
  // request that hangs shows up as a start with no end.
  const t0 = performance.now();
  const body = await req.text();
  const info = describeRpc(body);
  const meta = { ...info, pv: req.headers.get("mcp-protocol-version"), ua: req.headers.get("user-agent")?.slice(0, 40) };
  // The viewer polls doom_frame a few times a second: log those only when slow.
  const quiet = /doom_frame|^ping/.test(info.rpc);
  if (!quiet) console.log(JSON.stringify({ evt: "mcp_start", ...meta }));
  const res = await handler(new Request(req.url, { method: "POST", headers: req.headers, body }));
  if (!res.body) return res;
  let bytes = 0;
  const counted = res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, c) {
        bytes += chunk.byteLength;
        c.enqueue(chunk);
      },
      flush() {
        if (quiet && performance.now() - t0 < 2000) return;
        console.log(JSON.stringify({ evt: "mcp_end", ...meta, status: res.status, bytes, ms: Math.round(performance.now() - t0) }));
      },
    }),
  );
  return new Response(counted, { status: res.status, statusText: res.statusText, headers: res.headers });
}

function describeRpc(body: string) {
  try {
    const msgs = [JSON.parse(body)].flat() as { id?: unknown; method?: string; params?: { name?: string; uri?: string } }[];
    return { rpc: msgs.map((m) => [m.method ?? "response", m.params?.name ?? m.params?.uri, m.id].filter((x) => x !== undefined).join(" ")).join(", ") };
  } catch {
    return { rpc: `unparsable (${body.length} bytes)` };
  }
}

export { guarded as GET, guarded as POST, guarded as DELETE };
