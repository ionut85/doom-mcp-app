# Demo script

Three modes on stage: **autonomous** (Claude plays alone), **directed** (you tell Claude what to do), and **human** (you play, or take over from Claude).

MCP endpoint: `https://doom-player.vercel.app/api/mcp`

## Before the talk

- [ ] **Add the connector.** In claude.ai (Settings → Connectors → Add custom connector), add the endpoint above on the account and app you'll present from (web or desktop). Start a new chat and make sure the DOOM tools are enabled.
- [ ] **Do one full rehearsal on the presenting machine, network and app.** Check that:
  - the viewer appears;
  - the **35 FPS** badge shows (smooth playback);
  - **Play yourself** works.
- [ ] **Warm the server** 5 minutes before going on. Start any game, so the first call on stage doesn't pay the ~2 s cold start.
- [ ] **Record the fallback video.** Open https://doom-player.vercel.app/replay, pick **Skill 3**, set **1×**, click **Record video**, and save the WebM file locally. That's Claude's real E1M1 completion, re-rendered exactly from its inputs.
- [ ] **Have Claude Code ready** in a terminal as the backup (see Fallbacks).
- [ ] **Set the browser zoom** so the viewer's canvas is big. Use **Fullscreen** in the viewer if your host offers it.

## 1. Autonomous: "Claude, clear E1M1 by yourself"

Prompt:

> Start a game of DOOM on skill 2 and clear E1M1 by yourself. Caption every move so the audience can follow your thinking.

- **Skill 2** is the safer choice live: in our evals Claude finished it in 74 moves without taking damage. On **skill 3**, the default ("Hurt me plenty"), it took 140 moves and finished with 39 health.
- **Claude.ai stops a long turn after a number of tool calls.** When Claude stops and summarizes, type **continue**. A full level takes a few "continues".
- **What to point out while it plays:**
  - captions under the screen;
  - the game freezing while Claude thinks (virtual time);
  - aiming by exact angle;
  - Claude opening doors and heading for the exit switch.
- **If Claude stands still or bumps a wall twice,** nudge it: "use the map, head for the door".

## 2. Directed: you give the orders

Prompt to start:

> Start a game of DOOM. Don't play on your own: wait for my instructions, then carry them out with a few moves each and tell me what you see.

Then give commands, either typed or dictated:
- in the chat box;
- with the composer's dictation;
- in the viewer's **Tell Claude** box under the screen (type, or press 🎤 where the host allows the microphone).

Commands that work well:
- "Walk forward until you reach the door, then open it."
- "Turn to the zombie on the left and shoot it."
- "Back off to the corridor, you're taking damage."
- "Grab the shotgun and switch to it."
- "Find the exit switch."

Short, concrete commands work best. Each becomes a handful of tool calls. Voice details and what's verified are in `docs/voice.md`.

## 3. Human: play it yourself

- **In the viewer:** click **Play yourself** at any point. Your copy of the game starts at Claude's exact position, Claude's own game is unaffected, and **Back to Claude's game** resumes watching.
  - Keys: WASD or arrows to move, click or Ctrl to fire, Space to open doors, 1–7 for weapons.
  - Click the screen first so it has keyboard focus.
- **Full screen in a browser tab:** https://doom-player.vercel.app/play, with keyboard and mouse on desktop and touch controls on phones.

## Fallbacks

| Problem | What to do |
|---|---|
| The viewer doesn't appear or stays blank | Keep going: Claude still plays and gets screenshots in the chat. Or switch to the fallback video. |
| "Play yourself" or smooth playback fails (the host blocks WebAssembly) | The viewer falls back to still frames by itself. Show `/play` in a browser tab instead. |
| Claude stops after a burst of moves | Type **continue** (claude.ai limits tool calls per turn). |
| The network is slow or down | Play the recorded video from `/replay`. |
| claude.ai is having problems | Use Claude Code: `claude mcp add --transport http doom https://doom-player.vercel.app/api/mcp`, then the autonomous prompt. Same tools, no inline viewer. |
| Claude dies | It can say `use` to restart, or you prompt "you died, restart and be more careful". |
| "Unknown or expired session_id" | Sessions last 24 hours. Start a new game. |

## Talking points (numbers from `docs/EVAL.md`)

- **Claude finishes E1M1.** 140 moves on Hurt me plenty, $3.43 of API cost. Skill 2: 74 moves, $1.35.
- **Claude vs a scripted bot.** Over 50 moves Claude kills about 3× as many monsters (6.0 vs 2 at skill 3).
- **Seeing vs knowing.** With structured state (exact angles, a mini-map, nearby doors) Claude gets roughly twice the kills it gets from screenshots alone.
- **Virtual time.** The game only moves when Claude acts, so it can think as long as it likes.
- **Determinism.** A game is just its list of inputs. Any server, or your browser, can rebuild it exactly. That's how the viewer plays smoothly, how "Play yourself" takes over mid-game, and how `/replay` re-renders the winning run.
- **What a move costs.** About $0.01 per move with prompt caching (50-move runs: $0.51–0.80).

## Testing in ChatGPT

ChatGPT implements the same MCP Apps standard as Claude, so the same server and viewer should work there, but nobody has tested it yet. This checklist is for a first run.
- The viewer names the assistant after the host, so it should read "ChatGPT is playing" there.
- When something fails, expand **Diagnostics** at the bottom of the viewer and copy its JSON into the results. It shows what ChatGPT allowed or blocked.

### What you need

- **A ChatGPT plan with full MCP support.** Business, Enterprise or Edu, where full MCP is in beta. Pro may only allow read-only tools, which wouldn't let the game's actions run.
- **Developer mode, switched on by a workspace admin.** It's in the workspace's admin settings (around *Permissions & roles → Connected data*); menu names vary by plan. Then each user turns it on under *Settings → Apps → Advanced settings*.
- **ChatGPT on the web** for the first run. Mobile comes later in the checklist.

### Setup

1. With Developer mode on, create a new app (connector) with:
   - **Name:** DOOM
   - **MCP server URL:** `https://doom-player.vercel.app/api/mcp`
   - **Authentication:** none
2. Start a new chat and enable the DOOM app for it.

### Checks

| # | Do | Expected | If not, note |
|---|---|---|---|
| 1 | Look at the app's tool list | `doom_new_game`, `doom_act`, `doom_turn`, `doom_observe`. The viewer-only tools (`doom_frame`, `doom_log`, `doom_stats`) should not be offered to the model | Which tools appear. If the viewer-only ones show up, ChatGPT ignores `visibility: ["app"]` |
| 2 | Send "Start a game of DOOM" | The DOOM viewer renders inline under the reply, with the header saying **ChatGPT is playing** and the E1M1 start frame | Whether a viewer appears at all. If the header says Claude, note `hostName` in Diagnostics |
| 3 | Send "Clear E1M1 by yourself. Caption every move." | The game moves, captions update under the screen, and the header badge says **35 FPS** (smooth playback) | Badge says *still frames* or *loading engine…* → note `smoothError` and `cspViolations` |
| 4 | Let it play | It keeps playing until it stops on its own | How many moves before it stops; whether "continue" resumes it |
| 5 | Click **Play yourself**, then click the screen and use WASD / Space / Ctrl | You play from the assistant's position; **Back to ChatGPT's game** returns | The error text shown next to the button, plus Diagnostics |
| 6 | Look under the move list for the **Tell ChatGPT** box. Type "turn around and walk forward", press Enter | The text appears in the chat as your message and ChatGPT makes the moves | Box missing → note `talk.hostAcceptsMessages`. Sent but nothing happens → note `messageError` |
| 7 | Click **🎤** and say "open the door in front of you" | ChatGPT or the browser asks for the microphone; the words are sent when you stop | Note `speechError`, and whether any permission prompt appeared |
| 8 | Click **Fullscreen** (if shown) | The viewer goes fullscreen | Whether the button appears, and what happens |
| 9 | Repeat 2–3 in the ChatGPT phone app | The viewer renders and updates | What the phone shows |
| 10 | Try ChatGPT's voice mode: "start a game of DOOM and walk forward" | It calls the DOOM tools and the viewer appears | Whether tools run in voice mode at all |

### Results

| # | Pass / fail | Notes / Diagnostics |
|---|---|---|
| 1 | | |
| 2 | | |
| 3 | | |
| 4 | | |
| 5 | | |
| 6 | | |
| 7 | | |
| 8 | | |
| 9 | | |
| 10 | | |

Tester, date, plan, browser:
