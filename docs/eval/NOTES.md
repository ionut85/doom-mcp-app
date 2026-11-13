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
3. **No run reached the exit.**
   - 50 tool calls are only ~22 seconds of game time on average (range 15–32 s). Claude moves in short, careful steps of about 16 tics per action.
   - E1M1 takes much longer than that, so the exit rate here measures the budget, not Claude's ability to find the exit.
   - A longer-budget run is the next experiment.
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

## Spend

- About $25 in total: about $20 for the v2 matrix and about $5 for probes, v1 and two v1 runs lost to a harness bug (fixed).
- Run cost scales faster than linearly with the action budget, since every request re-reads the growing history.
