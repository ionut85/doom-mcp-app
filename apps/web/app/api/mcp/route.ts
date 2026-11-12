import { createMcpHandler } from "mcp-handler";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { loadViewerHtml } from "@/lib/assets";
import { bootEngine } from "@/lib/engine-host";
import { encodePng } from "@/lib/frame";

export const maxDuration = 60;

const VIEWER_URI = "ui://doom/viewer";

/** Phase 0 smoke test: a fresh engine, `tics` tics walking forward, one PNG frame. */
async function smokeFrame(tics: number, turn: number) {
  const t0 = performance.now();
  const engine = await bootEngine({ skill: 3, episode: 1, map: 1 });
  const bootMs = performance.now() - t0;
  if (turn) engine.turn(turn);
  if (tics > 0) engine.applyTicStep({ f: 25, s: 0, t: 0, b: 0, n: tics });
  const png = encodePng(engine.render(), engine.width, engine.height, 2);
  const state = engine.getState();
  return {
    tic: state.gametic,
    health: state.health,
    angle: state.angle,
    frame: png.toString("base64"),
    bootMs: Math.round(bootMs),
    totalMs: Math.round(performance.now() - t0),
    serverTime: new Date().toISOString(),
  };
}

const handler = createMcpHandler(
  (server) => {
    registerAppResource(
      server,
      "DOOM viewer",
      VIEWER_URI,
      { description: "Inline DOOM viewer" },
      async () => ({
        contents: [
          {
            uri: VIEWER_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: await loadViewerHtml(),
            _meta: { ui: { prefersBorder: true } },
          },
        ],
      }),
    );

    registerAppTool(
      server,
      "doom_smoke",
      {
        title: "DOOM smoke test",
        description:
          "Smoke test for the DOOM MCP App: boots DOOM (Freedoom E1M1) on the server and shows the start frame in an inline viewer. Takes no arguments.",
        inputSchema: z.object({}),
        _meta: { ui: { resourceUri: VIEWER_URI } },
      },
      async () => {
        const r = await smokeFrame(0, 0);
        return {
          content: [
            { type: "text", text: `DOOM booted in ${r.bootMs} ms (tic ${r.tic}). The viewer shows the E1M1 start frame.` },
            { type: "image", data: r.frame, mimeType: "image/png" },
          ],
          structuredContent: r,
        };
      },
    );

    registerAppTool(
      server,
      "doom_smoke_frame",
      {
        title: "DOOM smoke frame",
        description: "App-only: renders E1M1 after walking forward for `tics` tics.",
        inputSchema: z.object({
          tics: z.number().int().min(0).max(350),
          turn: z.number().min(-360).max(360).optional(),
        }),
        _meta: { ui: { resourceUri: VIEWER_URI, visibility: ["app"] } },
      },
      async ({ tics, turn }) => {
        const r = await smokeFrame(tics, turn ?? 0);
        return { content: [{ type: "text", text: `tic ${r.tic}` }], structuredContent: r };
      },
    );
  },
  { serverInfo: { name: "doom-player", version: "0.1.0" } },
);

export { handler as GET, handler as POST, handler as DELETE };
