# doom-player conventions

- **Plan:** `docs/PLAN.md`. Tick checkboxes as work lands; record deviations in section 8.
- **Engine:** never edit `engine/doomgeneric/` (submodule). Changes to upstream C go in `engine/patches/*.patch`; our own C is `engine/dg_headless.c` and `engine/dg_exports.c`.
- **Rebuilding:** `source ~/emsdk/emsdk_env.sh && pnpm build:engine` (emsdk version pinned in `engine/emsdk-version.txt`). `engine/dist/` is committed because Vercel has no emsdk; rebuild and commit it with any C change.
- **State layout:** the int32 state/object layouts in `dg_exports.c` are mirrored in `packages/doom-core/src/index.ts`. Change both together, append-only.
- **Determinism is a hard requirement:** no wall clock, no `Math.random` in anything that feeds the engine. Session logs are resolved `TicStep`s. `pnpm test` must pass.
- **WADs:** Freedoom only (`pnpm get-wad`); never commit id Software WADs. `DOOM_IWAD` overrides the path locally.
- **Tools:** pnpm workspace, TypeScript run via tsx, tests in Vitest. Prefer pure-JS deps (no native modules) for anything deployed to Vercel.
- **Secrets:** none in git; use Vercel env vars.
- **Ask first:** before making the repo public, adding paid Vercel/Upstash resources, or changing the license.
