# Demo script

Three modes on stage: **autonomous** (Claude plays alone), **directed** (you tell Claude what to do), and **human** (you play, or take over from Claude).

MCP endpoint: `https://doom-player.vercel.app/api/mcp`

## Before the talk

- [ ] **Add the connector.** In claude.ai (Settings → Connectors → Add custom connector), add the endpoint above on the account and app you'll present from (web or desktop). Start a new chat and make sure the DOOM tools are enabled.
- [ ] **Do one full rehearsal on the presenting machine, network and app.** Check that:
  - the viewer appears;
  - the **35 FPS** badge shows (smooth playback);
  - **Play yourself** works;
  - one `doom_autoplay` call: the viewer plays its 10–20 s of game smoothly at normal speed, and the captions keep up;
  - a full autonomous run with the prompt below. Autoplay's hand-back rules changed after the last paid eval (it now stops mid-fight below 50 health), so the rehearsal is the first time Claude plays with them.
- [ ] **Warm the server** 5 minutes before going on. Start any game, so the first call on stage doesn't pay the ~2 s cold start.
- [ ] **Record the fallback video.** Open https://doom-player.vercel.app/replay, pick **Skill 3**, set **1×**, click **Record video**, and save the WebM file locally. That's Claude's real E1M1 completion, re-rendered exactly from its inputs.
- [ ] **Have Claude Code ready** in a terminal as the backup (see Fallbacks).
- [ ] **Set the browser zoom** so the viewer's canvas is big. Use **Fullscreen** in the viewer if your host offers it.

## 1. Autonomous: "Claude, clear E1M1 by yourself"

Prompt (the most fluid run):

> Start a game of DOOM on skill 2 and clear E1M1. Use doom_autoplay to cover ground, and take over yourself for hard fights, healing and anything it gets stuck on. Caption every move so the audience can follow your thinking.

- **Pick the style.** Claude has three ways to play. They differ in how much the game moves while Claude thinks, and in how much of the play is Claude's own:

  | Style | Add to the prompt | Game per call | What the audience sees |
  |---|---|---|---|
  | Autopilot plus Claude (above) | "Use doom_autoplay to cover ground…" | 6–8 s | The game keeps moving. Claude picks the goal and takes over when autoplay hands back |
  | Assisted moves | "Use doom_goto and doom_attack, not doom_autoplay" | about 1.5 s | Claude chooses every destination and fight; short pauses between moves |
  | Claude alone | "Use doom_turn and doom_act only" | about 0.5 s | Claude aiming and stepping itself; the game mostly waits for it |

  Without a hint, Claude picks for itself; in our runs it used autoplay for about a third of its calls and `doom_goto` for most of the rest.
- **Skill 2 is the safer choice live.** With the assisted tools, Claude cleared E1M1 on **skill 3** ("Hurt me plenty", the default) in all 4 recent runs: 23 and 43 actions with autoplay, 39 and 42 without. Skill 2 has fewer and weaker monsters; the autopilot alone clears it in 2–4 calls. Unassisted, Claude needed 74 moves on skill 2 and 140 on skill 3.
- **Claude.ai stops a long turn after a number of tool calls.** When Claude stops and summarizes, type **continue**. With autoplay a level takes 23–43 calls instead of 74–140, so expect fewer "continues".
- **The viewer can run behind the chat** by up to about 20 s after an autoplay call: Claude has already moved on while the viewer is still playing what happened. That's normal. Past 21 s of backlog it plays at 2× and the badge says **catching up 2×**.
- **What to point out while it plays:**
  - captions under the screen;
  - the game freezing on the server while Claude thinks (virtual time), while the viewer keeps playing the backlog;
  - autoplay handing back: its result says why ("health 59, down 41 this call: your call"), and Claude decides whether to heal, retreat or fight on;
  - aiming by exact angle when Claude takes over a fight;
  - Claude opening doors and heading for the exit switch.
- **If autoplay says it's stuck, or that everything reachable is explored,** Claude usually takes over by itself. If not, nudge it: "use the map, head for the door".

## 2. Directed: you give the orders

Prompt to start:

> Start a game of DOOM with perception "state". Don't play on your own: wait for my instructions, carry out each one with a single tool call, then tell me in one sentence what happened.

- **Why this prompt:** each instruction becomes one assisted move ("go through the door" is one `doom_goto`), so you wait for one round of thinking instead of several. `state` means no screenshot for the model to read, which makes each call faster. The audience still sees the game in the viewer. The server instructions ask for the same, so it mostly happens without the prompt too.
- **Time freeze is visible:** while the model works out what you said, the badge reads **⏸ frozen until Claude moves** (or ChatGPT). Nothing moves on the server either. Point this out: you can take your time giving orders.
- **The viewer jumps to the live game** when you click into the **Tell Claude** box or press 🎤. If moves were still playing back, your order applies to what you now see.

Then give commands, either typed or dictated:
- in the chat box;
- with the composer's dictation;
- in the viewer's **Tell Claude** box under the screen (type, or press 🎤 where the host allows the microphone).

Commands that work well:
- "Go through the door on the left." (`doom_goto` opens it and walks through.)
- "Turn to the zombie on the left and shoot it." (`doom_attack`, or an exact turn and fire.)
- "Back off to the corridor, you're taking damage."
- "Grab the shotgun and switch to it."
- "Explore this area and deal with anything you meet." (`doom_autoplay` with goal `explore`, which never presses the exit.)
- "Find the exit switch." (`doom_autoplay` with goal `exit`.)

Short, concrete commands work best. Each becomes one tool call. Voice details and what's verified are in `docs/voice.md`.

**Live voice (ChatGPT voice mode).** ChatGPT's voice conversation calls the DOOM tools (check 10 below). Start with the directed prompt above, spoken. Claude's voice mode can't call connector tools yet; in Claude, use dictation or the viewer's 🎤.

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
| Autoplay keeps handing back at low health | Expected on skill 3: it stops below 50 health so Claude decides. Prompt "grab health, then carry on", or switch to skill 2. |
| Claude seems to have finished but the viewer is still playing | Wait: the viewer is playing the last autoplay call (up to ~20 s). |
| "Unknown or expired session_id" | Sessions last 24 hours. Start a new game. |

## Talking points (numbers from `docs/EVAL.md`)

- **Claude finishes E1M1.** With the assisted tools: 23–43 actions on Hurt me plenty, $0.41–0.90 of API cost, in all 4 recent runs. Unassisted, the one finish took 140 moves and $3.43.
- **Why assisted moves exist.** Claude thinks for about 4 s per call. Unassisted, each call played about 0.5 s of game, so the viewer stood still most of the time. With autoplay a call plays 6–8 s, more than the thinking time, so the game keeps moving. It's an assist and labelled as one: the autopilot runs on the server with simple rules, and Claude chooses the goal and when to take over.
- **Claude vs a scripted bot.** Over 50 moves Claude kills about 3× as many monsters (6.0 vs 2 at skill 3).
- **Seeing vs knowing.** With structured state (exact angles, a mini-map, nearby doors) Claude gets roughly twice the kills it gets from screenshots alone.
- **Virtual time.** The game only moves when Claude acts, so it can think as long as it likes.
- **Determinism.** A game is just its list of inputs. Any server, or your browser, can rebuild it exactly. That's how the viewer plays smoothly, how "Play yourself" takes over mid-game, and how `/replay` re-renders the winning run. The assisted moves keep that property: they log ordinary per-tic inputs, and replaying Claude's tool calls rebuilds the same game exactly.
- **What a move costs.** About $0.01–0.02 per move with prompt caching. A full assisted level costs $0.41–0.90.

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
| 1 | Look at the app's tool list | `doom_new_game`, `doom_act`, `doom_turn`, `doom_goto`, `doom_attack`, `doom_autoplay`, `doom_observe`. The viewer-only tools (`doom_frame`, `doom_log`, `doom_stats`) should not be offered to the model | Which tools appear. If the viewer-only ones show up, ChatGPT ignores `visibility: ["app"]` |
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
| 10 | Pass (2026-11-18) | Voice mode calls the DOOM tools and the game plays. Claude's voice mode can't (see `docs/voice.md`) |

Tester, date, plan, browser:
