---
type: session
date: 2026-10-18-0743
branch: feat/rf-followups
status: complete
related: [2026-10-18-0424-rf-coverage-ui.md]
---

# RF coverage follow-ups

## What changed

- The preview's estimated tower-base ground now reads DSMs the way the job does: only `role: 'dsm'` COG rasters, in manifest order, over the full +/- 30 m square, not a disc (`rf/dsmGround.ts`, `dsmGroundLayers`).
- The preview Worker's path-loss cache has a byte budget beside its 64-grid cap: 512 MiB (`MAX_PATH_LOSS_BYTES` in `packages/rf/src/preview.ts`), trimmed by the same least-recently-used rule that never drops grids the last preview used.
- The coverage legend stands above the map's "No map pack installed" note. In a narrow map the note goes above the scale bar and credits, into the bottom corners; the note is now a CSS anchor (`--aio-map-note`) and the legend's corner rises above it. The RF e2e now runs in a 1100 x 720 window and checks the legend clears the note (it failed with the note covered before the fix).
- Ruling: no separate "run only these sectors" pick. Each sector row's switch already takes a sector out of a run (it shows as "marked inactive" in the run's left-out list), so a second session-only pick would put two toggles on one row. The job's `sectorIds` parameter stays for later.

## Why

The follow-ups the RF UI note left open, picked up while the merge queue was free.

## How to test

1. Open a project with antennas and a COG DSM but no ground height in its antenna file; open the RF tab and change a tilt: the estimated height in the unit fields should match what a run reports in its warnings within a few decimetres.
2. With no map pack installed, make the window small, open the RF tab, run coverage and switch the stage to Map: the "No map pack installed" note wraps above the scale bar and the legend sits above it, not over it.
3. To run only some sectors, switch the others off in the sector list, then Run coverage: they are listed as left out ("marked inactive").

## Open threads

- RF follow-ups still open: Edit RF... in the antenna list, the island Coverage tile, the preview reading the run's path-loss cache, a captureId on runs, the DSM sample step (2 m against every pixel), catalogue verification.
- Other stage corner overlays (the volumes hint) can still sit over the map note; the anchor is there for a general fix in the corner registry.

## Next session entry point

Land this PR, then the remaining RF follow-ups once antenna detection merge 2 and the corner registry exist.
