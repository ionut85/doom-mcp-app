// Inline DOOM viewer (Phase 3 version): follows the session started by
// doom_new_game by polling the app-only doom_frame tool.
import { App } from "@modelcontextprotocol/ext-apps/app-with-deps";

type Hud = { health: number; armor: number; weapon: string; ammo: number | null; kills: string; status: string };
type Caption = { tic: number; text: string; action: string };
type FrameResult = { unchanged?: boolean; version: number; hud?: Hud; captions?: Caption[]; frame?: string; perception?: string };

const POLL_MS = 400;

const canvas = document.getElementById("screen") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
ctx.imageSmoothingEnabled = false;
const statusEl = document.getElementById("status")!;
const hudEl = document.getElementById("hud")!;
const captionsEl = document.getElementById("captions")!;
const diagEl = document.getElementById("diag")!;

const diag: Record<string, unknown> = {};
const showDiag = () => (diagEl.textContent = JSON.stringify(diag, null, 1));

let sessionId: string | null = null;
let version = -1;
let polling = false;

async function drawPng(b64: string) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  try {
    const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  } catch (e) {
    const img = new Image();
    img.onload = () => ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    img.src = `data:image/png;base64,${b64}`;
    diag.bitmapError = String(e);
  }
}

function render(f: FrameResult) {
  version = f.version;
  if (f.frame) void drawPng(f.frame);
  if (f.hud) {
    const h = f.hud;
    hudEl.textContent = `❤ ${h.health}  🛡 ${h.armor}  ${h.weapon.replace(/_/g, " ")}${h.ammo === null ? "" : ` ${h.ammo}`}  ☠ ${h.kills}${h.status === "alive" ? "" : `  · ${h.status.toUpperCase()}`}`;
  }
  if (f.captions) {
    captionsEl.replaceChildren(
      ...f.captions.slice(0, 5).map((c) => {
        const li = document.createElement("li");
        li.textContent = c.text || c.action;
        if (c.text) {
          const small = document.createElement("small");
          small.textContent = `  ${c.action}`;
          li.append(small);
        }
        return li;
      }),
    );
  }
  statusEl.textContent = `v${version}${f.perception ? ` · ${f.perception}` : ""}`;
}

async function poll() {
  if (!sessionId || polling || document.hidden) return;
  polling = true;
  const t0 = performance.now();
  try {
    const r = await app.callServerTool({ name: "doom_frame", arguments: { session_id: sessionId, since_version: version } });
    const f = r.structuredContent as FrameResult | undefined;
    diag.lastPollMs = Math.round(performance.now() - t0);
    if (f && !f.unchanged) render(f);
  } catch (e) {
    diag.pollError = String(e);
    showDiag();
  } finally {
    polling = false;
  }
}

const app = new App({ name: "DOOM viewer", version: "0.2.0" });

app.ontoolresult = (result) => {
  const sc = result.structuredContent as { session_id?: string } | undefined;
  diag.toolResult = sc;
  showDiag();
  if (sc?.session_id && sc.session_id !== sessionId) {
    sessionId = sc.session_id;
    version = -1;
    void poll();
  }
};
app.onhostcontextchanged = (c) => {
  diag.hostContext = { theme: c.theme, displayMode: c.displayMode, platform: c.platform };
  showDiag();
};
app.onerror = (e) => {
  diag.appError = String(e);
  showDiag();
};

app
  .connect()
  .then(() => {
    statusEl.textContent = "waiting for game…";
    diag.connected = true;
    showDiag();
    setInterval(poll, POLL_MS);
  })
  .catch((e) => {
    statusEl.textContent = "connect failed";
    diag.connectError = String(e);
    showDiag();
  });
