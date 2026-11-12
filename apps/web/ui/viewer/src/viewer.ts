// Phase 0 smoke viewer: proves inline render, tool-result delivery, app-only
// tool calls via callServerTool, and which image path the host CSP allows.
import { App } from "@modelcontextprotocol/ext-apps/app-with-deps";

type Frame = { tic: number; frame: string; bootMs: number; totalMs: number; angle: number; serverTime: string };

const canvas = document.getElementById("screen") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
ctx.imageSmoothingEnabled = false;
const statusEl = document.getElementById("status")!;
const diagEl = document.getElementById("diag")!;
const advanceBtn = document.getElementById("advance") as HTMLButtonElement;
const turnBtn = document.getElementById("turn") as HTMLButtonElement;

const diag: Record<string, unknown> = { ua: navigator.userAgent };
const showDiag = () => (diagEl.textContent = JSON.stringify(diag, null, 1));

let tics = 0;
let turn = 0;

/** Decodes a base64 PNG without data:/blob: URLs (in case the host CSP blocks them). */
async function drawPng(b64: string) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  try {
    const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    diag.imagePath = "createImageBitmap(Blob)";
  } catch (e) {
    diag.bitmapError = String(e);
    await new Promise<void>((resolve, reject) => {
      const img = new Image();
      img.onload = () => (ctx.drawImage(img, 0, 0, canvas.width, canvas.height), resolve());
      img.onerror = () => reject(new Error("data: URL blocked"));
      img.src = `data:image/png;base64,${b64}`;
    }).then(
      () => (diag.imagePath = "img data: URL"),
      (err) => (diag.imageError = String(err)),
    );
  }
  showDiag();
}

function show(f: Frame, via: string) {
  statusEl.textContent = `tic ${f.tic} · angle ${f.angle}° · server ${f.totalMs} ms (boot ${f.bootMs} ms) · via ${via}`;
  void drawPng(f.frame);
}

const app = new App({ name: "DOOM viewer", version: "0.1.0" });

app.ontoolresult = (result) => {
  diag.toolResultAt = new Date().toISOString();
  const f = result.structuredContent as Frame | undefined;
  if (f?.frame) show(f, "tool result");
  else diag.toolResultKeys = Object.keys(result);
  showDiag();
};
app.onhostcontextchanged = (c) => {
  diag.hostContext = { theme: c.theme, displayMode: c.displayMode, platform: c.platform };
  showDiag();
};
app.onerror = (e) => {
  diag.appError = String(e);
  showDiag();
};

async function step(dTics: number, dTurn: number) {
  tics = Math.min(350, tics + dTics);
  turn = (turn + dTurn) % 360;
  advanceBtn.disabled = turnBtn.disabled = true;
  const t0 = performance.now();
  try {
    const r = await app.callServerTool({ name: "doom_smoke_frame", arguments: { tics, turn } });
    diag.callServerToolMs = Math.round(performance.now() - t0);
    const f = r.structuredContent as Frame | undefined;
    if (f?.frame) show(f, "callServerTool");
    else diag.callResult = r;
  } catch (e) {
    diag.callError = String(e);
  }
  advanceBtn.disabled = turnBtn.disabled = false;
  showDiag();
}

advanceBtn.onclick = () => step(35, 0);
turnBtn.onclick = () => step(0, 90);

app
  .connect()
  .then(() => {
    statusEl.textContent = "connected, waiting for tool result…";
    diag.connected = true;
    diag.hostVersion = app.getHostVersion?.();
    diag.hostCapabilities = app.getHostCapabilities?.();
    advanceBtn.disabled = turnBtn.disabled = false;
    showDiag();
  })
  .catch((e) => {
    statusEl.textContent = "connect failed";
    diag.connectError = String(e);
    showDiag();
  });
