# doom-player

Claude plays DOOM inside the Claude app, rendered inline as an MCP App. The game advances only when Claude acts (virtual time), using a headless doomgeneric build compiled to WebAssembly.

See [docs/PLAN.md](docs/PLAN.md) for the plan and progress.

## Quick start (engine)

```bash
source ~/emsdk/emsdk_env.sh   # only needed to rebuild engine/dist
pnpm install
pnpm get-wad                  # Freedoom Phase 1 → wads/freedoom1.wad
pnpm test                     # determinism + replay benchmark
pnpm play-cli                 # scripted E1M1 run → out/*.png
```

License: GPL-2.0 (see LICENSE and NOTICE).
