---
type: session
date: 2026-10-12-0858
branch: chore/housekeeping-12-oct
status: complete
related: [architecture/adr/0011-magic-polygon-model.md]
---

# Housekeeping: CI draws with WARP, the Globe tests wait for tiles, a morning nightly check

## What changed

- The CI window reads 1100 x 720 at display scale 1 in `develop.md`, `finish-task.mjs` and four spec comments (`CLAUDE.md` got it from `main`). Specs that ask for the smallest window, 1100 x 700, keep it on purpose.
- The north star no longer says the M11 G12 AI helpers wait for the founder (ADR 0011: approved and built 10 Oct). `KNOWN-LIMITS.md` says **Outline** uses the pack's MobileSAM (0.5.1 on).
- The occasional Globe failures (CI runs 38170329846 and 38181308082, shard 4, first attempt) come from the renderer: `ci.yml` sets no `QUADRION_E2E_SWGL`, so the runners draw with D3D11 WARP, not SwiftShader as the docs said, and WARP blocks the renderer for tens of seconds while the Globe streams tiles. The founder keeps WARP on CI. `CONTRIBUTING.md`, `CLAUDE.md`, `develop.md` and `playwright.config.ts` now say WARP, and the local recipe is `QUADRION_E2E_SWGL=warp`.
- `globe.spec.ts` settles while frames or tiles still advance (fails after 20 s without progress, at most 150 s), settles before the clicks that timed out, and a failure now reports street tile stats, long tasks and the tier.
- A cloud routine, "Nightly installers morning check", reads the nightly every day at 04:00 UTC (07:00 Riyadh), read-only; reports are its runs at claude.ai/code/routines.
- The 11 Stop-hook drafts of 11 and 12 Oct were empty stubs: nothing to fold. Two of them listed untracked `.playwright-mcp/` files in the main checkout from 10 Oct, left for the founder.

## Why

Nobody watches the nightly since the Orchestrator stopped, and a doc recipe that tests on a faster renderer than CI hides exactly the timing failures CI then shows.

## How to test

No user-facing behaviour to test; the Globe change is verified by CI on the pull request (the founder chose CI over a local ten-fold run).

## Open threads

- A lighter Globe on the Low tier (WARP users without a graphics card): throttle street and imagery tiles per frame.
- If a Globe test still fails on CI, its message now names the stall; read it before rerunning.
- The untracked `.playwright-mcp/` files and the empty drafts in the main checkout wait for the founder to delete.

## Next session entry point

Read the first morning routine run on 13 Oct; the north star's Owed list is unchanged otherwise.
