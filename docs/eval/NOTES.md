## Setup

- **Players.**
  - Claude Opus 5.5 at effort `medium` with adaptive thinking, through the live MCP endpoint: the same tools, server instructions and tool results as claude.ai. The harness starts the game, so Claude can't restart it.
  - A scripted bot (no AI) as a baseline. It turns to the nearest visible enemy, fires, and otherwise runs forward pressing *use*.
- **Budget.** 50 tool calls per run, on Freedoom E1M1 at skill 2 and 3.
- **Labels.**
  - `v1`: the first server version. Relative `angle` fields, DOOM's own heading convention, no map.
  - `v2`: the version after studying the v1 transcripts.
    - `turn` fields that are exactly the `doom_turn` argument, and a compass `heading`.
    - Nearby doors, switches, lifts and exits with `in_use_range`.
    - A 21×21 ASCII mini-map with visited cells.
    - A rewritten play guide with routing and fighting tactics.
    - The map and doors list only reach the model in the `state` and `both` modes.
  - `probe` / `v2-probe`: single exploratory runs used to check cost and behaviour.
- **Scoring.** The harness scores every run with the app-only `doom_stats` tool, which the model never sees. Kills are summed across deaths, because dying restarts the level and resets DOOM's counter.

## Findings (v2, 5 runs per cell)

1. **Claude beats the scripted bot on fighting.**
   - At skill 3 Claude averages 5.4–6.0 kills with structured state and 3.2 with vision only, against 2 for the bot.
   - Exploration is similar to the bot's (about 20 cells at skill 3), because both spend most of the budget on the first fights.
2. **Structured state roughly doubles kills over pure vision** at skill 3 (6.0 `both`, 5.4 `state`, 3.2 `vision`).
   - Vision-only Claude takes less damage, because it engages less: it often doesn't notice or can't line up enemies it would need to turn toward.
   - With `turn` and `in_crosshair`, aiming is reliable.
3. **No 50-action run reached the exit.**
   - 50 tool calls are only ~22 seconds of game time on average (range 15–32 s). Claude moves in short, careful steps of about 16 tics per action.
   - E1M1 takes much longer than that, so the exit rate here measures the budget, not Claude's ability to find the exit.
   - The longer-budget games below confirm this: both finish the level.
4. **The v2 changes fixed what the transcripts showed, but the headline numbers barely moved at this budget.**
   - In v1, Claude never opened a door. It spent ~35 of 50 actions turning to "look", pressing *use* on plain walls and re-deriving the heading sign.
   - In v2 it routes on the map and opens the first door within ~15 actions.
   - Kills and cells at skill 3 are within noise of v1 (v1 had only 2 runs per cell), because the extra progress is spent fighting the group behind that door.
   - At skill 2, with fewer enemies, v2 explores 30–33 cells.
5. **Behaviour is very consistent.** All five `both` runs at skill 3 ended with exactly 6 kills: DOOM is deterministic, and Claude makes similar decisions at the first door fight. The scripted bot is identical on every run.
6. **Cost per 50-action run** (Opus 5.5, list prices):
   - $0.51–0.54 with vision only, $0.67–0.68 with state, $0.80 with both.
   - Prompt caching does most of the work: well over 90% of input tokens are cache reads. Uncached input is a few hundred tokens per run.
   - About 15–26k total tokens per action, almost all cached history, and ~200 output tokens per action.
7. **No refusals or fallbacks** in any run.

## Long games: can Claude finish E1M1? (label `long-200`)

Two single runs with a 200-action budget, Opus 5.5 at medium effort, `both` perception. **Claude completed E1M1 at both difficulties**, without dying, by finding and pressing the exit switch.

| Skill | Actions to exit | Game time | Kills | Damage taken | Area explored | Cost |
|---|---|---|---|---|---|---|
| 2 (Hey, not too rough) | 74 | 22 s | 5 of 17 | 0 | 41 cells | $1.35 |
| 3 (Hurt me plenty, the demo default) | 140 | 47 s | 10 of 29 | 89 (finished at 39 health) | 55 cells | $3.43 |

- **The skill-3 game.** Claude got through the fight behind the first door, picked up a shotgun, crossed the level, and cleared a shotgun guy in the exit room. It then picked up the dropped shells, faced the exit switch and pressed it ("Pressing the exit switch!").
- **The skill-2 game.** Claude worked a stubborn door with repeated *use* presses from different angles, then lined up on the exit switch alcove in small turns.
- **Not a statistic.** These are one run each. They show the level is finishable, not how often it is finished.
- **Cost.** Lower than estimated, because both runs stopped at the exit. The skill-3 game made 92 requests with 9.4M cached input tokens and only 186 uncached.

## Assisted moves: `doom_goto` and `doom_attack` (labels `assist`, `assist-long-200`, 2026-11-18)

Same setup as the v2 `both` / skill 3 cell (Opus 5.5, medium effort, 50 actions), with the two assisted tools added. The v2 runs are the unassisted baseline; `pnpm eval --no-assist` reproduces it.

| | Runs | Kills | Game time per run | Game time per action | Exit | Cells | Cost/run |
|---|---|---|---|---|---|---|---|
| Unassisted (v2) | 5 | 6.0 every run | 23 s | 0.46 s | 0 of 5 | 20 | $0.80 |
| Assisted | 2 | 11 and 12 | 76 s | 1.5 s | **1 of 2, in 50 actions** | 30 | $1.03 |

- **Fluidity.** Each action covers about 3.3× more game time, so in claude.ai the viewer moves about a third of the time instead of a tenth.
- **Tool use.** Claude chose the assisted tools for most actions: 31 of 50 were `doom_goto` and 7–10 were `doom_attack`. It still used `doom_turn` and `doom_act` for stepping onto items and fine aiming.
- **Results.** Kills nearly doubled. One run reached the exit in 50 actions; unassisted, the only skill-3 finish took 140 actions.
- **Caveat.** Only 2 runs: the third failed before starting (an OAuth token refresh race between parallel runs, no cost).
- **The long run didn't finish.** With up to 200 actions it hit the $6 cost cap after 171 actions: 18 kills, no deaths, 76 cells explored, 235 s of game time, but no exit. The transcript shows it lost most of its actions around lifts and ledges. `doom_goto` can't plan through a lift or a drop off a ledge (it treats any height step over 24 units as a wall in both directions), so Claude worked them out step by step. One-way drops and lift riding are the next things to add to the route planner.
- **Cost per action** is higher (about $0.02 vs $0.016 at 50 actions), because results carry more game per call. The long run reached $0.035 per action as its history grew.

## Free bot run on the assisted tools (`--policy assisted`, 2026-11-18)

Before the next paid round: a no-AI bot that only calls `doom_goto` and `doom_attack` (exit, then closed doors, switches and lifts, else explore; fight anything within 900 units). It played 200 calls against production at skill 3: 22 kills over 3 lives, 2 deaths, 55 cells, no exit, $0. The call log is in `eval-out/<run>/transcript.json`. The bot is cruder than Claude (it never picks up items and keeps reopening doors), but it shows where the tools themselves waste calls:

- **Fists against imps: 75 calls.** Out of bullets, `doom_attack` walked in with the fist and stopped with "lost sight of the imp", and the next `doom_goto` stopped on the same imp. Neither result said the real problem: no ammo.
- **Nukage drains health: one death.** `explore` routes straight across damaging floors. It stops at "health is low, from the floor", then the next call walks back in. The sector specials are now exported, so the planner could give those cells a cost.
- **Back and forth "blocked: something is in the way": 9 calls**, between (690, 210) and (880, 400) near door 599. Probably a solid object the route map doesn't know about.
- **Doors need two calls.** "opened it; walk through now", then another call to go through. Routing through closed, unlocked doors would save a call per door.
- **The ledge and lift work held up.** Every lift ride worked, and no route failed because of a drop.

### After the fixes (same bot, 200 calls, $0)

The bot also improved along the way (it picks up ammo, health and weapons, follows the "closed doors you can reach" hint, and keeps a target after "time's up"), so both versions were rerun with the final bot: old tools against production, new tools against a local server.

| Skill | Old tools | New tools |
|---|---|---|
| 2 | 2 kills, no exit in 200 calls; 81 "blocked" stops | 5 kills, **exit in 21 calls** |
| 3 | 10 kills, no exit in 200 calls; 113 "blocked" stops | 11 kills, **exit in 55 calls** |

The old tools' "blocked" stops were mostly routes that climbed a ledge on a 45° line and routes squeezed between a solid thing and the foot of a ledge. One run each, and the game is chaotic: small changes move a run onto a different path, so take these as "the tools no longer trap the bot", not as precise rates.

## Spend

- About $30 before the assisted runs: about $20 for the v2 matrix, $4.78 for the two long games, and about $5 for probes, v1 and two v1 runs lost to a harness bug (fixed).
- Eval harness: parallel runs now share one API client, so they no longer race to refresh the login (the lost third run above).
- Assisted runs: $8.09 ($2.06 for the two 50-action runs, $6.03 for the long run). Total so far: about $38.
- Run cost scales faster than linearly with the action budget, since every request re-reads the growing history.
