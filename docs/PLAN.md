# Claude Plays DOOM — Project Plan

> Handoff brief for a Claude Code session. Work phase by phase, commit at the end of each phase, and keep this file at `docs/PLAN.md` in the repo, ticking off checkboxes as you go.

## 1. Goal

Build a live demo for a presentation where **Claude plays DOOM by itself, inside the Claude app**, rendered as an **MCP App** (interactive UI inline in the chat). Three demo modes:

1. **Human mode**: I play DOOM inline in Claude (proves the MCP App works).
2. **Autonomous mode**: "Claude, clear E1M1 by yourself." Claude perceives the game (vision and/or structured state) and plays via tool calls, while the inline viewer shows what happens.
3. **Directed mode**: I give high-level commands (typed or dictated by voice), e.g. "go through the door on the left and kill the imp", and Claude translates them into game actions.

Bonus for the talk: a `perception` switch (`vision` | `state` | `both`) so the audience can compare pure-vision play with state-assisted play.

## 2. Core design decisions (read before coding)

### 2.1 The real-time problem → virtual time
DOOM runs at 35 tics/s; Claude acts turn by turn, with seconds between tool calls. **The game must only advance when Claude acts.** Use a headless engine whose clock is virtual: each tool call advances exactly N tics, then the game freezes until the next call. This is also how the existing `doom-mcp` project works (doomgeneric + virtual clock).

### 2.2 Engine: doomgeneric → WebAssembly (one build, two hosts)
- Use **doomgeneric** (portable C DOOM, GPL-2.0) compiled with **Emscripten** into a single modular wasm (`MODULARIZE=1`, `ENVIRONMENT=node,web`, no emscripten main loop).
- JS drives the engine: `tick(n)` from the outside. Same `.wasm` runs:
  - **server-side in a Vercel Node function** (Claude's game), and
  - **in the browser** (human play page + MCP App viewer).
- Implement the doomgeneric platform hooks headlessly:
  - `DG_GetTicksMs` → returns virtual time (`tic * 1000/35`), never wall clock.
  - `DG_SleepMs` → no-op.
  - `DG_DrawFrame` → copy `DG_ScreenBuffer` into an exported buffer.
  - `DG_GetKey` → read from a JS-filled queue (fallback input path).
- **Preferred input path: inject `ticcmd_t` directly** (hook `G_BuildTiccmd`): JS sets `forwardmove`, `sidemove`, `angleturn`, `buttons` (fire/use/weapon change) for the next tics. This gives exact, repeatable control (e.g. "turn exactly 30°") without key-repeat/acceleration effects.
- Boot straight into a map: `-iwad freedoom1.wad -skill N -warp E M`, so no menus.
- Add a "skip render" flag so replay (see 2.4) only renders the final frame.

### 2.3 WAD / licensing
- Use **Freedoom Phase 1** (`freedoom1.wad`, BSD-3), so the repo stays redistributable. Never commit id Software WADs. Allow an env var to point to a user-supplied IWAD locally.
- doomgeneric is GPL-2.0, so the **repo is GPL-2.0**. Add LICENSE and a NOTICE crediting doomgeneric, Freedoom and id Software.

### 2.4 State on Vercel (serverless is stateless) → deterministic replay
Vercel functions don't keep a process alive between calls, so a running engine can't be kept in memory reliably. Use DOOM's determinism instead (the same mechanism that makes classic `.lmp` demos work):

- A session = `{ id, wad, skill, episode, map, perception, actions: TicStep[], version }`, stored in **Upstash Redis** (Vercel Marketplace integration).
- On each `doom_act`: load the session → boot the engine → **replay all prior steps with rendering off** → apply the new step(s) → render → read state → append the steps → save.
- Headless DOOM replays thousands of tics per second, so a demo-length session (a few thousand tics) replays in well under a second. Measure it and log it.
- **Optimization (do after it works):** a module-level `Map<sessionId, {engine, appliedSteps}>` cache. With Fluid compute, warm instances are reused, so a cache hit skips replay. Replay stays the fallback, so correctness never depends on the cache.
- **Optional checkpointing:** every K steps, save a DOOM savegame from the Emscripten FS into Vercel Blob and replay from the latest checkpoint. Only do this if replay time becomes a problem; verify determinism after loading.
- Concurrency: optimistic `version` check on save; reject a stale write and tell the caller to re-observe.
- **Determinism test is mandatory:** the same step log must give the same frame hash and player state, run twice and across Node and the browser.

### 2.5 MCP server on Vercel
- **Next.js (App Router) on Vercel**, MCP over **Streamable HTTP** using Vercel's `mcp-handler` package (route like `app/api/[transport]/route.ts`; endpoint `/api/mcp`).
- **MCP Apps** via `@modelcontextprotocol/ext-apps` (SEP-1865; stable since 2026-01-26). Tools declare `_meta.ui.resourceUri: "ui://doom/viewer"`; the resource is served with MIME `text/html;profile=mcp-app` as a **single self-contained HTML file** (Vite + `vite-plugin-singlefile`; wasm inlined as base64 or fetched from our own domain, declared in the resource's CSP metadata).
- ⚠️ These APIs are young and evolve quickly. **Before writing code, read the current READMEs/examples** of `@modelcontextprotocol/ext-apps` and `mcp-handler`, and follow them where they differ from this plan (helper names like `registerAppTool`/`registerAppResource`, the `App` client class, `callServerTool`, tool `visibility`, CSP fields).
- **No nested iframes** in the viewer. The DOOM canvas lives directly in the app view. A prior "DOOM in Claude" MCP app found that host CSP and nested frames were the main cause of failed inline rendering.
- Auth: authless for the demo (claude.ai custom connectors support it), but use unguessable session IDs (nanoid 21), per-IP rate limiting, a cap on tics per call, and a cap on session length.

### 2.6 Perception (what Claude gets back from each action)
Every `doom_act` / `doom_observe` returns, depending on the session's `perception` setting:
- **Image**: the 320×200 frame upscaled 2× (nearest neighbour) to 640×400 PNG, as MCP `image` content (`pngjs`, no native deps).
- **Structured state** (text/JSON), read from engine memory via small exported C helpers:
  - player: health, armor, ammo by type, current/owned weapons, x/y/angle, `onground`, attacked-this-step
  - visible enemies (filtered with `P_CheckSight` so walls hide them): type, id, distance, **relative angle in degrees (negative = left)**, rough health state
  - nearby items, and doors/switches/exits within range with relative angle
  - events since the last step: damage taken, kills, pickups, door opened, level exit
  - optional (stretch): a small ASCII top-down local map around the player from the automap line data
- `vision` mode returns only the image plus the HUD numbers visible on screen. `state` mode returns no image. `both` is the default.

### 2.7 Tool surface (model-facing)
| Tool | Purpose |
|---|---|
| `doom_new_game({skill=3, episode=1, map=1, perception="both"})` | Creates a session, returns `session_id` and the first observation. **Renders the inline viewer** (`_meta.ui.resourceUri`). |
| `doom_act({session_id, steps: [{actions: string[], tics: 1..35}] (max 8 steps, ≤105 tics total)})` | Applies a short action sequence, returns an observation. Actions: `forward, back, strafe_left, strafe_right, turn_left, turn_right, run, fire, use, weapon_1..weapon_7`. |
| `doom_turn({session_id, degrees})` | Exact turn via `angleturn` (assist; makes aiming feasible). |
| `doom_observe({session_id})` | Current observation, no time passes. |
| `doom_frame({session_id})` | **App-only** (visibility `["app"]` if the host supports it): latest frame + HUD + last action + Claude's caption, for the viewer to poll. |

Tool descriptions must teach Claude how to play, e.g.: "short steps (7–14 tics) near enemies; turn toward an enemy using its relative angle, then fire; press `use` facing doors/switches; check health and back off below 30." Add an optional `caption` string on `doom_act` ("Turning to face the imp") that the viewer shows. Great for the audience.

Optional, clearly labelled as assist: `doom_aim_nearest({session_id})`. Keep it off by default, so the "pure" demo stays honest.

### 2.8 Inline viewer (MCP App UI)
- Created by `doom_new_game`. Shows: the frame canvas (crisp scaling), a HUD strip, the last N actions with Claude's captions, a perception badge, and a "replaying…" spinner.
- Live updates: poll `doom_frame` via the App SDK's `callServerTool` every ~400 ms (no extra CSP `connect-src` needed). Pause polling when the iframe is hidden.
- **Smooth playback (stretch, big wow factor):** the viewer loads the same wasm, receives the step log, and replays it locally at real 35 Hz. The audience sees fluid motion between Claude's moves instead of still frames. Determinism (2.4) makes this exact.
- **Human mode:** a "Play yourself" toggle in the viewer runs the local wasm interactively (keyboard + on-screen touch controls; target web and desktop first, since the iOS app has been unreliable for this in earlier projects).

### 2.9 Voice-directed mode
- Phase 1 approach: the user **dictates** into the Claude composer (mobile/desktop speech-to-text). Claude interprets the intent and issues `doom_act`/`doom_turn` calls. Nothing extra to build except good tool descriptions and a documented demo prompt.
- Investigate (don't block on it): whether Claude's voice mode can call connector tools; and whether the MCP App iframe can get microphone permission (Web Speech API) to send commands with the App SDK's message API. Write findings to `docs/voice.md`.

## 3. Repository layout

```
claude-plays-doom/
├─ engine/
│  ├─ doomgeneric/            # git submodule (upstream doomgeneric)
│  ├─ dg_headless.c           # DG_* hooks, virtual clock, frame buffer, skip-render flag
│  ├─ dg_exports.c            # ticcmd injection, get_player_state, get_visible_enemies, events…
│  ├─ build.sh                # emcc build → dist/doom.mjs + doom.wasm
│  └─ dist/                   # committed build artifacts (Vercel has no emsdk)
├─ packages/doom-core/        # TS wrapper: createEngine(wad, opts), applyStep, render, getState, replay
│  └─ test/                   # determinism + replay perf tests (vitest)
├─ apps/web/                  # Next.js on Vercel
│  ├─ app/api/[transport]/route.ts   # MCP endpoint (mcp-handler)
│  ├─ app/play/page.tsx       # standalone browser DOOM (human play, no Claude)
│  ├─ lib/session.ts          # Upstash Redis session store, versioning
│  ├─ lib/observe.ts          # perception: PNG + structured state
│  └─ ui/viewer/              # Vite single-file MCP App (built into resource HTML)
├─ wads/freedoom1.wad         # or fetched by scripts/get-wad.sh
├─ scripts/                   # get-wad.sh, play-cli.ts (local harness), bench-replay.ts
├─ docs/PLAN.md  docs/voice.md  docs/DEMO.md
├─ .github/workflows/ci.yml   # build engine (emsdk), tests, typecheck
├─ LICENSE (GPL-2.0)  NOTICE  README.md  CLAUDE.md
└─ pnpm-workspace.yaml
```

## 4. Phases & acceptance criteria

### Phase 0: Repo & pipeline
- [x] `gh repo create claude-plays-doom --public` (ask me before making it public; private is fine to start), pnpm monorepo, GPL-2.0 LICENSE, NOTICE, README stub, CLAUDE.md with conventions.
- [x] Next.js app deployed to Vercel from the GitHub repo (preview deploys on PRs).
- [x] Upstash Redis added via Vercel Marketplace; env vars pulled with `vercel env pull`.
- [x] MCP Apps smoke test in claude.ai (web + desktop): `doom_smoke` renders the inline viewer; its buttons call the app-only `doom_smoke_frame`.
- [x] CI: install emsdk, build the engine, run tests.
- **Done when:** a hello-world page is live on the Vercel URL and CI is green.

### Phase 1: Headless engine
- [x] doomgeneric submodule + headless hooks + Emscripten build; Freedoom loads; `-warp` boots E1M1.
- [x] `doom-core` TS API: `createEngine`, `applyStep(ticcmd, tics)`, `render() → RGBA`, `getState()`.
- [x] `scripts/play-cli.ts`: run a scripted step list in Node, write PNGs to `out/`.
- [x] Tests: determinism (same log → same frame hash + state, ×2 runs); replay benchmark for 1k/5k/10k tics.
- **Done when:** the CLI writes a correct E1M1 frame after scripted moves, and the determinism test passes.

### Phase 2: DOOM on the web (human play)
- [x] `/play` page: the same wasm in the browser, 35 Hz loop driven by `requestAnimationFrame`, keyboard + touch controls, audio optional (skip for v1).
- **Done when:** I can play E1M1 at `<vercel-url>/play` on desktop and mobile browsers.

### Phase 3: MCP server (text + image, no UI yet)
- [x] `/api/mcp` with `doom_new_game`, `doom_act`, `doom_turn`, `doom_observe`; Redis sessions; replay; limits.
- [x] Observation builder (PNG + structured state, perception modes).
- [ ] *(protocol and latency verified with a JSON-RPC client and `scripts/mcp-bot.ts`; a Claude-driven run is still to do)* Verify with MCP Inspector, then with Claude Code (`claude mcp add --transport http doom <url>/api/mcp`): Claude can walk E1M1 and shoot something.
- [x] Log per call: replay tics, replay ms, total ms, response size.
- **Done when:** Claude Code plays 30+ actions in a row with p95 tool latency < 2 s.

### Phase 4: MCP App viewer
- [x] `ui://doom/viewer` resource (single-file HTML), linked from `doom_new_game`; `doom_frame` app-only polling; captions; human "Play yourself" mode.
- [x] Test with an MCP Apps-capable test host *(our own `/dev/host` on AppBridge; installing the ext-apps repo's basic host was blocked by the agent sandbox)*.
- [x] Test the full viewer in **Claude** as a custom connector *(confirmed working by the user on 2026-11-13: the viewer updates live while Claude plays; Play yourself works)*.
- **Done when:** in claude.ai, "Start a game of DOOM and play it" shows the inline viewer updating while Claude plays.

### Phase 5: Play quality
- [x] Tune tool descriptions + server instructions; a system-prompt-style "how to play DOOM" guide in the server `instructions`.
- [x] Evaluate 5 runs per perception mode on E1M1 (skill 2 and 3): kills, damage taken, distance explored, exits reached, tokens/action. Record results in `docs/EVAL.md`. Good slide material.
- [x] Optional ASCII local map *(done, in state/both perception)*.
- [ ] Optional `doom_aim_nearest` assist *(not built: `turn` + `in_crosshair` already make aiming reliable)*.

### Phase 6: Demo polish
- [ ] Smooth local replay in the viewer (stretch).
- [ ] `docs/DEMO.md`: exact prompts for the three modes (autonomous, directed/voice, human), fallback plan (pre-recorded video, Claude Code backup), known failure modes.
- [ ] `docs/voice.md` findings.
- [ ] README with architecture diagram (Mermaid): Claude ⇄ MCP (Vercel) ⇄ Redis log ⇄ wasm engine; viewer ⇄ `doom_frame`.

## 5. Working agreements for Claude Code
- Verify the current docs of `@modelcontextprotocol/ext-apps`, `mcp-handler`, Next.js and Upstash before coding against them; note any deviations from this plan in `docs/PLAN.md`.
- Small commits; one PR (or commit series) per phase; keep CI green.
- Ask me before: making the repo public, adding paid Vercel/Upstash resources, or changing the license.
- Don't commit secrets; use Vercel env vars.
- Prefer pure-JS deps on Vercel (no native modules like `sharp` unless needed).

## 6. Known risks / open questions
- **Tool-call limits per turn** in claude.ai may stop long autonomous runs. Mitigation: a "say *continue*" loop, and Claude Code as backup.
- **MCP Apps host differences** (CSP, `visibility`, polling, iOS rendering). Test early in Phase 4 with a trivial viewer before building the full UI.
- **Determinism breaks** (wall clock use, uninitialized memory, float differences between hosts). Covered by tests; the viewer's smooth replay depends on it.
- **Cold starts** loading wasm + WAD (~a few MB). Measure; use Fluid compute; keep the function on the Node runtime with WAD files included via `outputFileTracingIncludes`.
- **Play quality** is modest: prior art gets ~5–10 kills per 50 actions on E1M1 and does better when directed. Present this honestly; the vision-vs-state comparison is part of the story.

## 7. Prior art to study (don't copy GPL code without keeping the license)
- `gunnargrosch/doom-mcp`: doomgeneric via Rust FFI, virtual clock, structured observations + thumbnail (closest to the Claude-plays part).
- Chris Nager's DOOM MCP App ("DOOM runs in ChatGPT and Claude", Apr 2026): inline MCP App using `cloudflare/doom-wasm` + Freedoom; lessons on CSP and nested iframes (closest to the inline part; human play only).
- `cloudflare/doom-wasm`: Chocolate Doom wasm port (fallback for the human-play page if the doomgeneric browser build is slow to get right).
- `modelcontextprotocol/ext-apps`: SDK, examples, and the `create-mcp-app` skill/plugin for Claude Code.

## 8. Execution log

**Order:** Phase 1 (engine spike) → 0 → 2 / 3 → 4 → 5 → 6. Vercel project name: `doom-player`.

### Repository
- **Main repo (public):** https://github.com/ionut85/doom-mcp-app (`origin`).
- **Backup (private):** `eros902002/doom-player` (`private` remote). `git push` on `origin` pushes to both.
- **Commit emails** use the GitHub noreply address; history was rewritten once before going public.
- **Vercel still deploys from the private backup.** Its Git integration can't be switched until the Vercel GitHub app is installed on `ionut85`'s account (only the owner can do that). Then: `vercel git disconnect --yes && vercel git connect https://github.com/ionut85/doom-mcp-app --yes`.

### Deviations from this plan (checked 2026-11-12)
- **MCP SDK v2 split.** `mcp-handler@2.4` and `@modelcontextprotocol/ext-apps@2.0.4` need `@modelcontextprotocol/server@^2` and `zod@^4.2`, not `@modelcontextprotocol/sdk` 1.x.
- **mcp-handler 2.x routing.** No `[transport]` route, `basePath`, `redisUrl` or SSE. Mount `createMcpHandler(init, options)` at `apps/web/app/api/mcp/route.ts`. Redis is only for our session log.
- **ext-apps helpers.** `registerAppTool` / `registerAppResource` / `RESOURCE_MIME_TYPE` come from `@modelcontextprotocol/ext-apps/server`; `App` from `@modelcontextprotocol/ext-apps`. Reference: `examples/basic-server-vanillajs`.
- **MCP Apps spec 2026-01-26.**
  - Tool `visibility: ["model","app"] | ["app"]`.
  - Resource CSP: `connectDomains` / `resourceDomains` / `frameDomains`.
  - `permissions.microphone` exists, which is relevant to `docs/voice.md`.
- **Runtime.** Next.js 16.4. Vercel's default is Node 24 (`.nvmrc` = 24).
- **Toolchain.** emsdk 7.0.0 (pinned in `engine/emsdk-version.txt`) needs Python ≥ 3.10 (`EMSDK_PYTHON`, installed via `uv python install 3.12`).
- **Engine output.** Native 320×200 (`-DDOOMGENERIC_RESX=320`), upscaled in JS.
- **Input path.** No `G_BuildTiccmd` replacement. A single patch (`engine/patches/0001-ticcmd-injection-hook.patch`) calls `DG_PostBuildTiccmd()` right after the engine builds each ticcmd, and the patch is applied to a copy in `engine/build/src`, so the submodule stays pristine.
- **Virtual time.** Via DOOM's own `singletics` (timedemo mode): exactly one tic per `TryRunTics`, and `doom_step` asserts it. `DG_SleepMs` advances virtual ms, so the engine's busy-wait (boot screen wipe) terminates. Our own `doom_render()` sets `wipegamestate = gamestate` so no further wipes start.
- **No skip-render flag needed.** `doom_step` never renders; `doom_render()` is separate. A test proves rendering/observing between steps doesn't change the game.
- **Session log format.** Resolved `TicStep {f,s,t,b,n}` (ticcmd + count), not action names, so the action mapping can change without breaking stored sessions.
- **Events.** Damage/kills/pickups are derived by diffing `getState()` between steps instead of a C event ring buffer.

### Phase 1 results
- Boot (fresh wasm instance + WAD into MEMFS + `-warp`) takes ~8–18 ms. The wasm is 380 KB.
- Replay speed:
  - warm: ~300k–800k tics/s (10k tics in ~14 ms);
  - first cold run in a new process: one measurement of ~330 ms for 5k tics.
  - Replay is not a bottleneck, so the warm-instance cache is optional.
- Determinism: same log gives the same state and frame hashes across runs; rendering between steps gives the same result as rendering only at the end. Exact turns are verified (±0.1°).
- Not yet verified: determinism across Node vs browser (Phase 2 selftest).

### Phase 0 results
- **Repo and deploys.** Started as the private repo `eros902002/doom-player`. Moved on 2026-11-12 to the public repo `ionut85/doom-mcp-app` (see Repository below). The Vercel project `doom-player` (personal team) has root `apps/web`, Node 24 and Fluid compute, and is Git-connected. Production: https://doom-player.vercel.app, MCP endpoint `/api/mcp`.
- **Vercel needs corepack for pnpm 12.** Set `ENABLE_EXPERIMENTAL_COREPACK=1` (all environments) so the build uses `packageManager: pnpm@12.18.0`. pnpm doesn't run `pre*` scripts, so `build` runs `pnpm assets`: `get-wad.sh` (downloaded at build time, checksum-verified) plus the viewer build.
- **Bundling.** Turbopack bundled the Emscripten glue even with `serverExternalPackages`, which traced the whole project. Fixed with:
  - a bundler-safe `@doom-player/doom-core/core` entry that takes the module factory;
  - `apps/web/lib/assets.ts` loading `engine/dist/doom.mjs` at runtime with `turbopackIgnore`;
  - explicit `outputFileTracingIncludes`.
  - The function now traces 118 files.
- **Smoke tools.** `doom_smoke` (model-visible, renders `ui://doom/viewer`) and `doom_smoke_frame` (`visibility: ["app"]`). Each boots a fresh engine and returns a PNG.
  - Production timings: cold call ~1.8 s round trip (boot ~450–600 ms); warm ~0.65 s round trip (boot 66–145 ms, server total ~180–270 ms).
- **Viewer.** A single-file Vite build (`@modelcontextprotocol/ext-apps/app-with-deps`, 524 KB). It shows a diagnostics panel: which image-decode path the host CSP allows, `callServerTool` latency, and host context.
- **CI.** Green in ~1m40s. The Linux emsdk 7.0.0 rebuild yields byte-identical `doom.mjs` glue; determinism tests pass on Linux.

### Phase 3 results
- **Upstash.** `doom-player-sessions`, free plan, connected to all environments (`KV_REST_API_URL` / `KV_REST_API_TOKEN`).
- **Sessions.** The JSON session is the TicStep log plus captions and a version. Saves go through an atomic Lua compare-and-set, so a stale concurrent write fails with "call doom_observe". The TTL is 24 h. An in-memory store is the fallback when Redis isn't configured (local tests).
- **Engine cache.** Warm engines are *checked out* while a call uses them and checked back in only after a successful save, so two concurrent calls can never share a mutating engine. `DOOM_ENGINE_CACHE=0` disables the cache. A test proves that cold replay equals the warm state.
- **Tools.**
  - `doom_new_game` renders the viewer.
  - `doom_act`, `doom_turn` and `doom_observe` return a 640×400 PNG and/or JSON, by perception mode.
  - `doom_frame` (`visibility: ["app"]`) returns a 1× PNG, HUD and captions. It returns early when `since_version` is unchanged.
  - The server `instructions` carry the play guide.
- **Observation.**
  - Enemies are filtered by line of sight. Each has distance, relative angle, `on_screen` (±45°) and `in_crosshair` (angular half-width from the mobj radius, which the engine now exports).
  - Also included: nearby items, barrels, and events diffed from player state (damage plus direction, kills, pickups, weapons, keys, death, level complete, distance moved).
  - Hints are added for death, level complete and aiming.
- **Limits.** 8 steps / 105 tics per call; 30k tics per session; 300 requests/min/IP (Upstash ratelimit).
- **Production latency** (scripted bot, 41 calls, timed from a laptop):

  | Perception | p50 | p95 | Max |
  |---|---|---|---|
  | `both` | 292 ms | 497 ms | 2.05 s (cold) |
  | `state` | 148 ms | 209 ms | 316 ms |

  The same game outcome as the local run, so the session is deterministic across environments.
- **Architecture explainer** (private artifact): https://claude.ai/artifact/F5uGrMYXP7UnsTLz2EJsm1

### Phase 2 results
- **`/play`** runs the same wasm in the browser.
  - The loop is fixed-step at 35 Hz on `requestAnimationFrame`, capped at 4 tics per frame, and pauses when the tab is hidden.
  - Desktop: keyboard and mouse (pointer lock to aim, click to fire, right-click to use).
  - Touch: the left half is a movement stick, dragging on the right half turns, plus FIRE / USE / WPN buttons. The controls sit in a pad under the screen in portrait and float over it in landscape.
  - Skill and map selectors, an always-run toggle, pause and restart.
- **Reusable modules.** Input and loop live in `apps/web/lib/play/` (framework-agnostic), so the Phase 4 viewer can reuse them.
- **Assets.** `scripts/web-assets.mjs` publishes content-hashed glue, wasm and a gzipped WAD (28.8 MB → 10.2 MB, inflated with `DecompressionStream`) to `public/doom/`, plus a `manifest.json`.
  - Hashed files are cached as immutable; the manifest always revalidates.
  - Stripping sound and music would only save ~3 MB, so the WAD ships unmodified to keep determinism safe.
- **Cross-host determinism verified.** `/play?selftest=1` replays the seeded log from `doom-core/selftest.ts`, and the browser gives the same state and frame hashes as Node. The hashes are pinned in a Node test, so CI catches drift.

### Phase 4 results
- **Verified in claude.ai on 2026-11-13** (by the user). With the custom connector, Claude plays and the inline viewer updates live. Play yourself works too, so Claude's host permits wasm and our declared asset domain.
- **Viewer.** It shows:
  - a header with map, skill and perception badge, and a mode badge ("Claude is playing" / "You're playing");
  - the 4:3 screen, a "replaying…" indicator on cache-miss polls, and banners for death and level complete;
  - a HUD strip, and Claude's last 6 captions with game time and action labels;
  - a Fullscreen button when the host lists that display mode.
- **Polling.** It starts at load and doesn't depend on the `ui/initialize` handshake. It's a no-op until a tool result gives a session.
- **Play yourself = take over.** The app-only `doom_log` returns the session's TicSteps. The viewer replays them locally in the iframe's own wasm engine and hands over the controls from Claude's exact position. Claude's server game is unaffected, and "Back to Claude's game" resumes polling.
  - Verified in the harness: the HUD continued from Claude's state (101 health, 49 ammo), and keyboard move and fire worked inside the sandboxed iframe.
- **Assets cross-origin.** The viewer resource declares `csp.resourceDomains` / `connectDomains` = the public origin, which is injected into the HTML as `__DOOM_PUBLIC_ORIGIN__`. `/doom/*` is served with `Access-Control-Allow-Origin: *` and `CORP: cross-origin`.
  - Verified: from an opaque-origin sandbox, under a CSP limited to the declared domain, the manifest, the module glue and the 10 MB WAD all load from production.
- **Local testing gotcha.** Chrome blocks requests from opaque-origin (sandboxed) frames to `localhost`, so locally set `DOOM_PUBLIC_ORIGIN=https://doom-player.vercel.app`.
- **Input fixes found while testing.** Key taps shorter than one tic are latched for one tic, and clicks fire when pointer lock is refused (common in sandboxed iframes).
- **Known.** The bundled SDK (zod) probes `eval`, which shows up as a CSP violation in strict hosts. It falls back without eval, so it's harmless.
- **Dev harness.** `/dev/host` (404 in production) is a minimal MCP Apps host for local viewer testing. It renders the viewer in an opaque-origin sandbox with a CSP built only from the declared domains, forwards tool calls, and can script "Claude" moves.

### Phase 5 results
- **Eval harness.** `pnpm eval`, with `pnpm eval:report` for the table and `scripts/eval-timeline.ts` for reading transcripts. Results are in `docs/EVAL.md`, with the analysis in `docs/eval/NOTES.md`.
- **Map awareness (v2).** The engine exports linedefs. State observations gain:
  - `turn` values that are exactly the `doom_turn` argument, and a compass `heading`;
  - nearby `interactives` (doors with open/closed state and key color, switches, lifts, exits, `in_use_range`);
  - a 21×21 north-up ASCII map with the cells visited this session.
- **Headline numbers** (Opus 5.5, medium effort, 50 actions, skill 3): 5.4–6.0 kills with structured state vs 3.2 vision-only vs 2 for a scripted bot. No run reached the exit: 50 actions is only ~22 s of game time. Cost per run: $0.51 (vision) to $0.80 (both).
- **Claude finishes E1M1.** With a 200-action budget (`both` perception, one run each), Claude reached the exit at skill 2 in 74 actions ($1.35) and at skill 3 in 140 actions ($3.43), without dying.

### References
- MCP Apps in Claude: https://claude.com/resources/articles/interactive-connectors-full-tool
- MCP Apps overview: https://modelcontextprotocol.io/extensions/apps/overview
- Cloudflare DOOM multiplayer on Workers (doom-wasm; multiplayer not needed here): https://blog.cloudflare.com/doom-multiplayer-workers/
