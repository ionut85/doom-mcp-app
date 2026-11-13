"use client";

// A minimal MCP Apps host, for local testing of ui://doom/viewer:
// - reads the resource from /api/mcp and renders it in a sandboxed, opaque-origin
//   iframe whose CSP is built ONLY from the resource's declared csp domains
//   (stricter than most hosts; adds 'wasm-unsafe-eval' unless disabled);
// - bridges the App protocol with AppBridge and forwards tool calls to /api/mcp;
// - lets you start a game and send scripted "Claude" moves.

import { useEffect, useRef, useState } from "react";
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

const ENDPOINT = "/api/mcp";
let rpcId = 0;

async function rpc(method: string, params: unknown) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const raw = await res.text();
  const line = raw.split("\n").find((l) => l.startsWith("data: "));
  const msg = JSON.parse(line ? line.slice(6) : raw);
  if (msg.error) throw new Error(JSON.stringify(msg.error));
  return msg.result;
}

type Csp = { connectDomains?: string[]; resourceDomains?: string[]; frameDomains?: string[] };

function cspMeta(csp: Csp | undefined, wasm: boolean) {
  const res = (csp?.resourceDomains ?? []).join(" ");
  const con = (csp?.connectDomains ?? []).join(" ");
  const policy = [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${wasm ? "'wasm-unsafe-eval'" : ""} ${res}`,
    "style-src 'unsafe-inline'",
    `img-src data: blob: ${res}`,
    `connect-src ${con}`,
    "frame-src 'none'",
  ].join("; ");
  return `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
}

export default function HostHarness() {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const bridgeRef = useRef<AppBridge | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [session, setSession] = useState<string | null>(null);
  const [wasm, setWasm] = useState(true);
  const [mode, setMode] = useState<"inline" | "fullscreen">("inline");
  const add = (s: string) => setLog((l) => [`${new Date().toLocaleTimeString()} ${s}`, ...l].slice(0, 40));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await rpc("resources/read", { uri: "ui://doom/viewer" });
      const c = r.contents[0];
      const html: string = c.text.replace("<head>", `<head>${cspMeta(c._meta?.ui?.csp, wasm)}`);
      add(`resource: ${Math.round(html.length / 1024)} KB, csp ${JSON.stringify(c._meta?.ui?.csp)}`);
      const iframe = frameRef.current!;
      // ?host=chatgpt reports a different host name, to test host-specific viewer behaviour.
      const hostName = new URLSearchParams(location.search).get("host") ?? "doom-dev-host";
      const bridge = new AppBridge(null, { name: hostName, version: "0.1.0" }, { serverTools: {}, logging: {}, message: { text: {} } }, {
        hostContext: { theme: "dark", displayMode: "inline", availableDisplayModes: ["inline", "fullscreen"], platform: "web" },
      });
      bridge.oncalltool = async (params) => {
        const t0 = performance.now();
        const out = await rpc("tools/call", params);
        if (params.name !== "doom_frame" || !(out.structuredContent as { unchanged?: boolean })?.unchanged) {
          add(`app → ${params.name} (${Math.round(performance.now() - t0)} ms)`);
        }
        return out;
      };
      bridge.onrequestdisplaymode = async ({ mode }) => {
        setMode(mode === "fullscreen" ? "fullscreen" : "inline");
        bridge.setHostContext({ displayMode: mode });
        add(`app requested display mode ${mode}`);
        return { mode };
      };
      bridge.oninitialized = () => add("viewer initialized");
      bridge.onmessage = async ({ role, content }) => {
        const text = content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join(" ");
        add(`viewer → chat (${role}): "${text}"`);
        return {};
      };
      if (cancelled) return;
      bridgeRef.current = bridge;
      // Listen before the view loads, so its ui/initialize request isn't missed.
      await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
      iframe.srcdoc = html;
    })().catch((e) => add(`error: ${e}`));
    return () => {
      cancelled = true;
    };
  }, [wasm]);

  async function newGame() {
    const args = { skill: 3, perception: "both" };
    bridgeRef.current?.sendToolInput({ arguments: args });
    const r = await rpc("tools/call", { name: "doom_new_game", arguments: args });
    setSession(r.structuredContent.session_id);
    bridgeRef.current?.sendToolResult(r);
    add(`doom_new_game → ${r.structuredContent.session_id}`);
  }

  async function claudeMoves(n: number) {
    if (!session) return;
    const moves = [
      { name: "doom_act", arguments: { session_id: session, steps: [{ actions: ["forward"], tics: 21 }], caption: "Walking into the courtyard" } },
      { name: "doom_turn", arguments: { session_id: session, degrees: -30, caption: "Checking the left side" } },
      { name: "doom_act", arguments: { session_id: session, steps: [{ actions: ["fire"], tics: 7 }], caption: "Testing the pistol" } },
      { name: "doom_turn", arguments: { session_id: session, degrees: 60, caption: "Sweeping right" } },
      { name: "doom_act", arguments: { session_id: session, steps: [{ actions: ["forward", "run"], tics: 14 }, { actions: ["use"], tics: 1 }], caption: "Running for the door" } },
    ];
    for (let i = 0; i < n; i++) {
      const m = moves[i % moves.length]!;
      await rpc("tools/call", m);
      add(`claude → ${m.name}: ${m.arguments.caption}`);
      await new Promise((r) => setTimeout(r, 700));
    }
  }

  return (
    <main style={{ display: "grid", gridTemplateColumns: "minmax(0, 720px) minmax(240px, 1fr)", gap: 16, padding: 16 }}>
      <div style={{ display: "grid", gap: 8, alignContent: "start" }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <button onClick={newGame}>doom_new_game</button>
          <button onClick={() => claudeMoves(5)} disabled={!session}>Claude: 5 moves</button>
          <label><input type="checkbox" checked={wasm} onChange={(e) => setWasm(e.target.checked)} /> allow wasm in CSP</label>
          <span style={{ opacity: 0.6 }}>mode: {mode}</span>
        </div>
        <iframe
          id="viewer"
          ref={frameRef}
          title="DOOM viewer"
          sandbox="allow-scripts allow-pointer-lock"
          style={{ width: "100%", height: mode === "fullscreen" ? "90vh" : 820, border: "1px solid #444", borderRadius: 8, background: "#000" }}
        />
      </div>
      <pre id="host-log" style={{ fontSize: 12, whiteSpace: "pre-wrap", opacity: 0.85 }}>{log.join("\n")}</pre>
    </main>
  );
}
