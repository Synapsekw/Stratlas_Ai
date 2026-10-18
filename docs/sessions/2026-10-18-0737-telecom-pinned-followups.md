---
type: session
date: 2026-10-18-0737
branch: fix/telecom-pinned-followups
status: complete
related: [2026-10-17-1117-telecom-azimuth-picks.md, 2026-10-17-1822-pinned-media.md]
---

# Telecom and pinned media follow-ups

## What changed

- The azimuth tool's hint now asks for three points along the top or bottom edge of the antenna front face (`TelecomTools.tsx`), matching how `antennaAzimuth` reads level picks since #163; the two pick-count messages in `packages/survey/src/tools/telecom.ts` say the same.
- A click on an unplaced 360's Media tile starts Place on site (the placing strip) instead of opening an empty scene; from a package or for a look-only reviewer it notes why it cannot (`useTileMenu().place` runs the registered `media.place` action). The guide's Place on site step says so.
- DroneMenu, AlignCamera, AlignPhoto and CalibrateVideo read the 3D view and the map through `builder/activeViews.ts` instead of their own copies, which missed a view that came up between their first render and their effect. A source guard test keeps copies out.
- `pinned-media.spec.ts`: the shorter-window test places by a tile click, the other by the right-click menu; both check the strip starts at the pick step and take evidence screenshots under `AIO_EVIDENCE_DIR`.

## Why

The three items were owed in the north star after the UI rework and pinned media; stage-island cleared this session to pick them up once 0.20.0 was built.

## How to test

1. Measure workbench, Telecom, Azimuth: the hint reads "Pick three points along the top or bottom edge of the antenna front face."
2. Import a 360 with no GPS (it shows "Not placed" in Media), then click its tile: the scene opens with the strip "Click where ... was taken". Cancel, then click a placed 360's tile: it opens in the scene as before.
3. The drone, align and calibrate panels look and behave as before; the fix only matters when a view comes up while they open, and it is covered by tests.

## Open threads

- None from this block.

## Next session entry point

Nothing telecom or pinned media is owed by agents; wait for founder feedback on the 0.20.0 steps.
