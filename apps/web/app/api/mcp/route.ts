import { createMcpHandler } from "mcp-handler";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { ACTIONS, MAX_TICS_PER_STEP } from "@doom-player/doom-core/core";
import { loadViewerHtml, publicOrigin } from "@/lib/assets";
import { act, frame, inputLog, LIMITS, logResponse, newGame, observeSession, turn, type Result } from "@/lib/game";
import { observationText } from "@/lib/observe";
import { rateLimit } from "@/lib/ratelimit";
import { PERCEPTIONS, sessionStore } from "@/lib/session";

export const maxDuration = 60;

const VIEWER_URI = "ui://doom/viewer";

const INSTRUCTIONS = `You are playing DOOM (Freedoom Phase 1, E1M1 by default). The game is frozen between your tool calls: time only passes when you act, so think as long as you like.

How to play well:
- Start with doom_new_game, keep the session_id, and pass a short "caption" on every doom_act / doom_turn describing your intent (the audience sees it).
- Angles are degrees relative to where you face: negative = left, positive = right. To aim at an enemy, call doom_turn with its angle, then fire. "in_crosshair": true means a shot will hit.
- Hitscan weapons (pistol, shotgun, chaingun) only auto-aim vertically, so turn precisely first. Fire in bursts of 7-14 tics and re-observe.
- Move in short steps (7-21 tics) when enemies are near; longer steps (35+) only in cleared areas. "moved N units" in events tells you if you are stuck against a wall: back off and turn.
- Doors and switches: face them up close and press "use" (1-2 tics). Exits are usually a switch in a small room.
- Health below 30: retreat, strafe out of sight, and look for stimpacks/medikits (nearby_items).
- Shoot explosive barrels near groups of enemies, but not when you are within ~150 units of them.
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
          "Turn by an exact number of degrees: negative = left, positive = right (same convention as enemy angles in observations). Takes a few tics (max ~11°/tic). Use it to aim: doom_turn(enemy.angle), then doom_act fire.",
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
        inputSchema: z.object({ session_id: sessionId, since_version: z.number().int().optional() }),
        _meta: { ui: { resourceUri: VIEWER_URI, visibility: ["app"] } },
      },
      async ({ session_id, since_version }) => {
        const s = await sessionStore().get(session_id);
        if (since_version !== undefined && s.version === since_version) {
          return { content: [{ type: "text", text: "unchanged" }], structuredContent: { unchanged: true, version: s.version } };
        }
        const f = await frame(session_id);
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
            frame: f.png.toString("base64"),
          },
        };
      },
    );

    registerAppTool(
      server,
      "doom_log",
      {
        title: "DOOM: input log",
        description: "App-only: the session's full input log, so the viewer can rebuild the game locally (take over from Claude).",
        inputSchema: z.object({ session_id: sessionId }),
        _meta: { ui: { resourceUri: VIEWER_URI, visibility: ["app"] } },
      },
      async ({ session_id }) => {
        const log = await inputLog(session_id);
        return { content: [{ type: "text", text: `${log.steps.length} steps` }], structuredContent: log };
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
  return handler(req);
}

export { guarded as GET, guarded as POST, guarded as DELETE };
