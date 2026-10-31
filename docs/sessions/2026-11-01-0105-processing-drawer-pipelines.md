---
type: session
date: 2026-11-01-0105
branch: fix/processing-drawer-pipelines
status: complete
related: []
---

# Processing drawer spec reads the bench-only pipelines from the product

## What changed

- `apps/desktop/e2e/processing-drawer.spec.ts` ("Settings, Advanced holds every pipeline by area and every job on this computer") failed on local main: it expected `thermal.hotspots` and `flyability.import` in the Advanced pipeline list, and the product hides both.
- This PR changes the spec, not the product. The spec no longer keeps its own list of bench-only pipelines (it held only `thermal.decode`); it imports `BENCH_ONLY` from `apps/desktop/src/renderer/processing/pipelines.ts`, so the next bench-only job cannot break it.

## Why

- `BENCH_ONLY` already lists all three, and that is right:
  - `thermal.decode` and `thermal.hotspots` start from the Thermal bench only ("Find hot spots" for the second).
  - `flyability.import` needs an inspection selection that only the import picker supplies (Add data or a library drop), so starting it from Advanced could only fail validation.

## Checks

- `processing-drawer.spec.ts` run the CI way (every demo built, 1100 x 720, scale 1, WARP, `--workers=1`) three times, all green.

## How to test

Nothing is user-facing: this PR changes one end to end spec.
