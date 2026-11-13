// Inline DOOM viewer (MCP App). Two modes:
//  - watch: follows Claude's session by polling the app-only doom_frame tool.
//           With smooth playback (default), the viewer replays Claude's moves in
//           its own engine at 35 tics/s; otherwise it shows the server's frames;
//  - play:  "Play yourself" rebuilds Claude's game locally from its input log
//           (doom_log + deterministic replay) and hands the controls to the user.
//           Claude's server-side game is not affected.
import { App } from "@modelcontextprotocol/ext-apps/app-with-deps";
import type { TicStep } from "@doom-player/doom-core/core";
import { PlayerInput } from "../../../lib/play/input";
import { GameLoop } from "../../../lib/play/loop";
import { loadEngine } from "../../../lib/play/load";
import { SmoothPlayer } from "./smooth";

// Replaced by the server when it serves the resource (lib/assets.ts).
const ORIGIN = "__DOOM_PUBLIC_ORIGIN__";
const ASSET_BASE = `${ORIGIN}/doom/`;
const POLL_MS = 400;
const SYNC_INDICATOR_MS = 350;

type Hud = { health: number; armor: number; weapon: string; ammo: number | null; kills: string; status: string };
type Caption = { tic: number; text: string; action: string };
type FrameResult = {
  unchanged?: boolean;
  version: number;
  perception?: string;
  skill?: number;
  episode?: number;
  map?: number;
  tic?: number;
  hud?: Hud;
  captions?: Caption[];
  frame?: string;
  replayed?: boolean;
  replay_tics?: number;
};
type LogResult = {
  skill: number; episode: number; map: number; version: number;
  from: number; total_steps: number; total_tics: number;
  steps: [number, number, number, number, number][];
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const appEl = $("app");
const canvas = $<HTMLCanvasElement>("canvas");
const ctx = canvas.getContext("2d")!;
const screen = $("screen");
const stage = $("stage");
const diagEl = $("diag");
const diag: Record<string, unknown> = { origin: ORIGIN };
const showDiag = () => (diagEl.textContent = JSON.stringify(diag, null, 1));
const cspViolations: string[] = [];
document.addEventListener("securitypolicyviolation", (e) => {
  cspViolations.push(`${e.effectiveDirective} blocked ${e.blockedURI}`);
  diag.cspViolations = cspViolations.slice(-5);
  showDiag();
});

let sessionId: string | null = null;
let version = -1;
let inflight = false;
let last: FrameResult | null = null;
let mode: "watch" | "play" = "watch";
let player: { loop: GameLoop; input: PlayerInput } | null = null;

// Smooth playback state
let smooth: SmoothPlayer | null = null;
let smoothState: "off" | "loading" | "on" | "failed" = "off";
let smoothBaseTic = 0; // engine gametic right after boot, before any of Claude's moves
let smoothTotalTics = 0; // server-side tics covered by the log we have fetched
let fetchingLog = false;
const smoothToggle = $<HTMLInputElement>("smooth-toggle");

// ---------------------------------------------------------------------------
// Watch mode

async function drawPng(b64: string) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  try {
    const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  } catch (e) {
    diag.bitmapError = String(e);
    const img = new Image();
    img.onload = () => ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    img.src = `data:image/png;base64,${b64}`;
  }
}

const PERCEPTION_LABEL: Record<string, string> = { vision: "vision only", state: "state only", both: "vision + state" };
const WEAPON_LABEL = (w: string) => w.replace(/_/g, " ");
const clock = (tic: number) => {
  const s = Math.floor(tic / 35);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

function renderHud(h: Hud, tic?: number) {
  $("hud").hidden = false;
  $("h-health").textContent = String(h.health);
  $("h-health").classList.toggle("low", h.health < 30);
  $("h-armor").textContent = String(h.armor);
  $("h-weapon").textContent = WEAPON_LABEL(h.weapon);
  $("h-ammo").textContent = h.ammo === null ? "" : `· ${h.ammo} ammo`;
  $("h-kills").textContent = h.kills;
  $("h-time").textContent = tic === undefined ? "" : `game time ${clock(tic)}`;
  const banner = $("banner");
  banner.hidden = h.status === "alive";
  banner.classList.toggle("good", h.status === "level_complete");
  banner.textContent = h.status === "dead" ? (mode === "watch" ? "Claude died" : "You died · press use") : h.status === "level_complete" ? "Level complete!" : h.status;
}

function renderCaptions(list: Caption[]) {
  const ol = $("captions");
  if (!list.length) return;
  ol.replaceChildren(
    ...list.slice(0, 6).map((c) => {
      const li = document.createElement("li");
      const t = document.createElement("span");
      t.className = "t";
      t.textContent = clock(c.tic);
      const body = document.createElement("span");
      const text = document.createElement("span");
      text.className = "text";
      text.textContent = c.text || c.action;
      body.append(text);
      if (c.text) {
        const act = document.createElement("span");
        act.className = "act";
        act.textContent = c.action;
        body.append(act);
      }
      li.append(t, body);
      return li;
    }),
  );
}

function render(f: FrameResult) {
  version = f.version;
  last = f;
  $("empty").hidden = true;
  if (f.frame) void drawPng(f.frame);
  if (f.episode && f.map) $("mapinfo").textContent = `E${f.episode}M${f.map} · skill ${f.skill}`;
  if (f.perception) {
    const p = $("perception");
    p.hidden = false;
    p.textContent = PERCEPTION_LABEL[f.perception] ?? f.perception;
  }
  if (f.hud) renderHud(f.hud, f.tic);
  if (f.captions) renderCaptions(f.captions);
  if (f.replayed && f.replay_tics) diag.lastReplay = `${f.replay_tics} tics`;
}

async function poll() {
  if (mode !== "watch" || !sessionId || inflight || document.hidden) return;
  inflight = true;
  const t0 = performance.now();
  const slow = setTimeout(() => {
    $("sync-text").textContent = "replaying…";
    $("sync").hidden = false;
  }, SYNC_INDICATOR_MS);
  try {
    const smoothOn = smoothState === "on";
    const r = await app.callServerTool({
      name: "doom_frame",
      arguments: { session_id: sessionId, since_version: version, include_frame: !smoothOn },
    });
    diag.lastPollMs = Math.round(performance.now() - t0);
    const f = r.structuredContent as FrameResult | undefined;
    if (r.isError) diag.pollError = JSON.stringify(r.content).slice(0, 300);
    else if (f && !f.unchanged && mode === "watch") {
      if (smoothOn) {
        // The local engine draws the frame and the HUD in step with the motion.
        render({ ...f, frame: undefined, hud: undefined });
        void fetchNewSteps();
      } else render(f);
    }
  } catch (e) {
    diag.pollError = String(e);
  } finally {
    clearTimeout(slow);
    $("sync").hidden = true;
    inflight = false;
    showDiag();
  }
}

// ---------------------------------------------------------------------------
// Smooth playback

const toSteps = (rows: LogResult["steps"]): TicStep[] => rows.map(([f, s, t, b, n]) => ({ f, s, t, b, n }));

function setSmoothBadge(text: string | null) {
  const b = $("smooth-badge");
  b.hidden = !text;
  b.textContent = text ?? "";
  b.classList.toggle("smooth", smoothState === "on");
}

function onSmoothState(st: ReturnType<SmoothPlayer["engine"]["getState"]>, behind: number) {
  if (mode !== "watch") return;
  renderHud(
    { health: st.health, armor: st.armor, weapon: st.weapon, ammo: ammoFor(st), kills: `${st.kills}/${st.totalKills}`, status: st.gamestate === "intermission" ? "level_complete" : st.dead ? "dead" : "alive" },
    st.gametic,
  );
  setSmoothBadge(behind > 105 ? "catching up 2×" : "35 fps");
  // Safety net: once the queue is drained, the local game must be exactly where the server's is.
  if (behind === 0 && smooth && !fetchingLog && st.gametic !== smoothBaseTic + smoothTotalTics) {
    diag.desync = { local: st.gametic, expected: smoothBaseTic + smoothTotalTics, at: new Date().toISOString() };
    diag.resyncs = ((diag.resyncs as number) ?? 0) + 1;
    showDiag();
    void initSmooth();
  }
}

async function initSmooth() {
  if (!sessionId || !smoothToggle.checked) return;
  const sid = sessionId;
  smooth?.stop();
  smooth = null;
  smoothState = "loading";
  setSmoothBadge("loading engine…");
  try {
    const r = await app.callServerTool({ name: "doom_log", arguments: { session_id: sid, from: 0 } });
    const log = r.structuredContent as LogResult | undefined;
    if (!log || r.isError) throw new Error("could not fetch the game log");
    const engine = await loadEngine({ skill: log.skill, episode: log.episode, map: log.map }, undefined, ASSET_BASE);
    if (sid !== sessionId || !smoothToggle.checked) return; // superseded
    smoothBaseTic = engine.getState().gametic;
    smoothTotalTics = log.total_tics;
    smooth = new SmoothPlayer(engine, canvas, onSmoothState);
    smooth.replayNow(toSteps(log.steps));
    smooth.appliedSteps = log.total_steps;
    smoothState = "on";
    $("empty").hidden = true;
    if (mode === "watch") smooth.start();
    diag.smooth = { steps: log.total_steps, tics: log.total_tics };
  } catch (e) {
    smoothState = "failed";
    setSmoothBadge("still frames");
    diag.smoothError = String(e);
    version = -1; // fall back: ask the server for a full frame
  }
  showDiag();
}

async function fetchNewSteps() {
  if (!smooth || !sessionId || fetchingLog) return;
  fetchingLog = true;
  try {
    const r = await app.callServerTool({ name: "doom_log", arguments: { session_id: sessionId, from: smooth.appliedSteps } });
    const log = r.structuredContent as LogResult | undefined;
    if (log && !r.isError && smooth) {
      smooth.enqueue(toSteps(log.steps));
      smooth.appliedSteps = log.total_steps;
      smoothTotalTics = log.total_tics;
    }
  } catch (e) {
    diag.logError = String(e);
  } finally {
    fetchingLog = false;
  }
}

smoothToggle.onchange = () => {
  if (smoothToggle.checked) void initSmooth();
  else {
    smooth?.stop();
    smooth = null;
    smoothState = "off";
    setSmoothBadge(null);
    version = -1; // show the server's frame again
    void poll();
  }
};

// ---------------------------------------------------------------------------
// Play mode

const WEAPON_SLOT: Record<string, number> = {
  fist: 1, chainsaw: 1, pistol: 2, shotgun: 3, super_shotgun: 3, chaingun: 4, rocket_launcher: 5, plasma_rifle: 6, bfg9000: 7,
};
const coarse = matchMedia("(pointer: coarse)").matches;

async function startPlaying() {
  const btn = $<HTMLButtonElement>("play-btn");
  btn.disabled = true;
  const hint = $("hint");
  try {
    let opts = { skill: last?.skill ?? 3, episode: last?.episode ?? 1, map: last?.map ?? 1 };
    let steps: TicStep[] = [];
    if (sessionId) {
      hint.textContent = "Fetching Claude's moves…";
      const r = await app.callServerTool({ name: "doom_log", arguments: { session_id: sessionId } });
      const log = r.structuredContent as LogResult | undefined;
      if (!log || r.isError) throw new Error("could not fetch the game log");
      opts = { skill: log.skill, episode: log.episode, map: log.map };
      steps = log.steps.map(([f, s, t, b, n]) => ({ f, s, t, b, n }));
    }
    hint.textContent = "Loading the engine…";
    const engine = await loadEngine(opts, (p) => {
      if (p.phase === "wad" && p.total) hint.textContent = `Downloading game data ${Math.round(((p.loaded ?? 0) / p.total) * 100)}%`;
    }, ASSET_BASE);
    const t0 = performance.now();
    engine.replay(steps);
    diag.localReplay = { tics: steps.reduce((a, s) => a + s.n, 0), ms: Math.round(performance.now() - t0) };

    smooth?.stop();
    mode = "play";
    appEl.dataset.mode = "play";
    $("mode-badge").textContent = "You're playing";
    $("empty").hidden = true;
    const input = new PlayerInput({
      alwaysRun: true,
      ownedSlots: () => [...new Set((latestState?.weaponsOwned ?? ["pistol"]).map((w) => WEAPON_SLOT[w] ?? 2))].sort(),
    });
    input.attachDesktop(screen);
    input.attachTouch(stage, showStick);
    wireTouchButtons(input);
    $("pad").hidden = !coarse;
    let latestState: ReturnType<typeof engine.getState> | null = null;
    const loop = new GameLoop({
      engine,
      canvas,
      nextCmd: () => input.next(),
      onState: (s) => {
        latestState = s;
        renderHud({ health: s.health, armor: s.armor, weapon: s.weapon, ammo: ammoFor(s), kills: `${s.kills}/${s.totalKills}`, status: s.gamestate === "intermission" ? "level_complete" : s.dead ? "dead" : "alive" }, s.gametic);
      },
    });
    loop.start();
    player = { loop, input };
    screen.focus({ preventScroll: true });
    btn.hidden = true;
    $("watch-btn").hidden = false;
    hint.textContent = steps.length
      ? "You took over from Claude's position. This copy runs in your browser; Claude's game is unaffected."
      : "A local game. Click the screen, then WASD/arrows to move, click or Ctrl to fire, Space to open doors.";
  } catch (e) {
    diag.playError = String(e);
    hint.textContent = `Couldn't start local play: ${e instanceof Error ? e.message : e}. This host may block WebAssembly or downloads from ${new URL(ORIGIN).host}.`;
    showDiag();
  } finally {
    btn.disabled = false;
  }
}

function ammoFor(s: { weapon: string; ammo: Record<string, number> }): number | null {
  const k = ({ pistol: "bullets", chaingun: "bullets", shotgun: "shells", super_shotgun: "shells", rocket_launcher: "rockets", plasma_rifle: "cells", bfg9000: "cells" } as Record<string, string>)[s.weapon];
  return k ? (s.ammo[k] ?? null) : null;
}

function stopPlaying() {
  player?.loop.stop();
  player?.input.detach();
  player = null;
  mode = "watch";
  appEl.dataset.mode = "watch";
  $("mode-badge").textContent = "Claude is playing";
  $("pad").hidden = true;
  $("play-btn").hidden = false;
  $("watch-btn").hidden = true;
  $("hint").textContent = "";
  if (document.pointerLockElement) document.exitPointerLock();
  if (smooth) {
    smooth.draw();
    smooth.start();
  } else version = -1; // force a full frame
  if (!sessionId) $("empty").hidden = false;
  void poll();
}

let stickEl: HTMLDivElement | null = null;
function showStick(s: { x0: number; y0: number; dx: number; dy: number } | null) {
  if (!s) {
    stickEl?.remove();
    stickEl = null;
    return;
  }
  if (!stickEl) {
    stickEl = document.createElement("div");
    stickEl.className = "stick";
    stickEl.innerHTML = '<div class="knob"></div>';
    document.body.append(stickEl);
  }
  stickEl.style.left = `${s.x0}px`;
  stickEl.style.top = `${s.y0}px`;
  const c = (v: number) => Math.max(-36, Math.min(36, v));
  (stickEl.firstElementChild as HTMLElement).style.transform = `translate(${c(s.dx)}px, ${c(s.dy)}px)`;
}

function wireTouchButtons(input: PlayerInput) {
  const hold = (id: string, name: "fire" | "use") => {
    const b = $(id);
    b.ontouchstart = (e) => (e.preventDefault(), input.setButton(name, true));
    b.ontouchend = b.ontouchcancel = () => input.setButton(name, false);
  };
  hold("t-fire", "fire");
  hold("t-use", "use");
  $("t-wpn").ontouchstart = (e) => (e.preventDefault(), input.nextWeapon());
}

// ---------------------------------------------------------------------------
// Talk to Claude: type (or dictate) an instruction; it arrives in the chat as
// the user's message, and Claude turns it into game actions.

// Not a <form>: sandboxed iframes without allow-forms never fire "submit".
const talkForm = $("talk");
const talkText = $<HTMLInputElement>("talk-text");
const talkStatus = $("talk-status");
const micBtn = $<HTMLButtonElement>("mic-btn");
type Recognition = {
  lang: string; interimResults: boolean; continuous: boolean;
  start(): void; stop(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};
const SpeechRecognitionCtor = ((window as unknown as Record<string, unknown>).SpeechRecognition ??
  (window as unknown as Record<string, unknown>).webkitSpeechRecognition) as (new () => Recognition) | undefined;
let recognition: Recognition | null = null;

function setTalkStatus(text: string) {
  talkStatus.hidden = !text;
  talkStatus.textContent = text;
}

async function sendToClaude(text: string) {
  const msg = text.trim();
  if (!msg) return;
  setTalkStatus("Sending…");
  try {
    const r = await app.sendMessage({ role: "user", content: [{ type: "text", text: msg }] });
    if (r.isError) throw new Error("the host declined the message");
    talkText.value = "";
    setTalkStatus(`Sent: "${msg}"`);
    diag.lastMessage = msg;
  } catch (e) {
    setTalkStatus(`Couldn't send it: ${e instanceof Error ? e.message : e}. Type it in the chat instead.`);
    diag.messageError = String(e);
  }
  showDiag();
}

$("talk-send").onclick = () => void sendToClaude(talkText.value);
talkText.onkeydown = (e) => {
  if (e.key === "Enter" && !e.isComposing) {
    e.preventDefault();
    void sendToClaude(talkText.value);
  }
};

function toggleListening() {
  if (recognition) {
    recognition.stop();
    return;
  }
  if (!SpeechRecognitionCtor) return;
  const rec = new SpeechRecognitionCtor();
  rec.lang = navigator.language || "en-US";
  rec.interimResults = true;
  rec.continuous = false;
  let finalText = "";
  rec.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i]!;
      if (res.isFinal) finalText += res[0]!.transcript;
      else interim += res[0]!.transcript;
    }
    talkText.value = (finalText + interim).trim();
  };
  rec.onerror = (e) => {
    const reason =
      e.error === "not-allowed" || e.error === "service-not-allowed"
        ? "The microphone isn't available here. Type instead."
        : e.error === "network"
          ? "The browser's speech service couldn't be reached. Type instead."
          : e.error === "no-speech"
            ? "Didn't catch that. Try again."
            : `Speech recognition stopped (${e.error}).`;
    setTalkStatus(reason);
    diag.speechError = e.error;
    showDiag();
  };
  rec.onend = () => {
    recognition = null;
    micBtn.classList.remove("listening");
    if (finalText.trim()) void sendToClaude(finalText);
  };
  try {
    rec.start();
    recognition = rec;
    micBtn.classList.add("listening");
    setTalkStatus("Listening… say what Claude should do.");
  } catch (e) {
    setTalkStatus("The microphone isn't available here. Type instead.");
    diag.speechError = String(e);
  }
}
micBtn.onclick = toggleListening;

/** Show the talk box only when the host accepts messages from the app. */
function updateTalk() {
  const caps = app.getHostCapabilities?.() as { message?: unknown } | undefined;
  talkForm.hidden = !caps?.message;
  micBtn.hidden = !SpeechRecognitionCtor;
  diag.talk = { hostAcceptsMessages: !!caps?.message, speechRecognition: !!SpeechRecognitionCtor };
}

// ---------------------------------------------------------------------------
// Host connection

const app = new App({ name: "DOOM viewer", version: "0.4.0" });

app.ontoolinput = () => {
  $("empty").textContent = "Starting the game…";
};
app.ontoolresult = (result) => {
  const sc = result.structuredContent as { session_id?: string } | undefined;
  diag.toolResult = sc;
  if (sc?.session_id && sc.session_id !== sessionId) {
    sessionId = sc.session_id;
    version = -1;
    void poll();
    void initSmooth();
  }
  showDiag();
};
app.onhostcontextchanged = (c) => {
  diag.hostContext = { theme: c.theme, displayMode: c.displayMode, platform: c.platform, availableDisplayModes: c.availableDisplayModes };
  updateFullscreenButton();
  showDiag();
};
app.onerror = (e) => {
  diag.appError = String(e);
  showDiag();
};

function updateFullscreenButton() {
  const c = app.getHostContext();
  const b = $("fullscreen-btn");
  b.hidden = !c?.availableDisplayModes?.includes("fullscreen");
  b.textContent = c?.displayMode === "fullscreen" ? "Exit fullscreen" : "Fullscreen";
}

$("play-btn").onclick = () => void startPlaying();
$("watch-btn").onclick = stopPlaying;
$("fullscreen-btn").onclick = async () => {
  const c = app.getHostContext();
  try {
    await app.requestDisplayMode({ mode: c?.displayMode === "fullscreen" ? "inline" : "fullscreen" });
  } catch (e) {
    diag.displayModeError = String(e);
  }
  updateFullscreenButton();
};
document.addEventListener("visibilitychange", () => {
  if (!player) return;
  if (document.hidden) player.loop.stop();
  else player.loop.start();
});

// Poll from the start: poll() is a no-op until a tool result gives us a session,
// and it must not depend on the initialize handshake finishing.
setInterval(poll, POLL_MS);

app
  .connect()
  .then(() => {
    diag.connected = true;
    diag.hostVersion = app.getHostVersion?.();
    updateFullscreenButton();
    updateTalk();
    showDiag();
  })
  .catch((e) => {
    $("empty").textContent = "Couldn't connect to the host.";
    diag.connectError = String(e);
    showDiag();
  });
