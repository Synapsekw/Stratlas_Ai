---
type: session
date: 2026-10-24-1517
branch: feat/volumetrics-redesign
status: complete
related:
  [
    plans/2026-10-24-volumetrics-redesign.md,
    plans/2026-10-24-volumetrics-redesign-design.md,
    architecture/adr/0013-one-volume-engine.md,
  ]
---

# Volumetrics redesign, stages A and B

## What changed

- Stage A (this PR): old-kit piles get real heights at conversion (the kit DSM through `volumes.grids` or the legacy path, else a prepared surface), with a one-time quiet repair (`MeasurementsFile.kitHeightsRepaired`); map picks never fall back to height 0.
- Survey surfaces prepare in the background when a project opens (`Settings.autoPrepareSurfaces`, a quiet cancellable job after 3 s, one at a time), with a preparing card on the stage and a per-date status in the sidebar. Cards list every survey date with its state (preparing N %, Prepare, Not prepared yet, Not measured on this date) instead of "No survey data".
- Converted piles quietly accept the standard-base figure once surfaces exist; the kit figure stays as "was" in History (ADR 0013 point 4 amended). Contract rows for both new fields.
- Stage B (this PR): a pile panel in the Volumes tab (material, editable density saved to the site material, Volume, Tonnes, change vs the previous survey, Overview / Profile / History, card menu). A pile click in 3D, on the Map, in the sidebar or the list opens it, bringing the drawer out when folded.
- Long-axis pile profile with survey chips and A / B / rotate handles in the scene (keyboard too). Linked hover between chart and 3D / Map / Split both ways (a dot per survey, dashed gap, tag); click pins, Esc clears the pin then the pile, double-click or F flies. Line cards, the section window (now non-modal, fits narrow stages, Add pin here) and the kit section line join it; a stage hint line.
- Evidence: `pnpm check` green; e2e the CI way: pile-panel 21/21 and linked-hover 18/18 with `--repeat-each=3`, surfaces-auto 12/12 repeated, a wide run of 80/80 over 25 spec files. Two independent reviews (Stage A 13 findings, Stage B 12), all fixed.

## Why

The founder's review of volumetrics on the founder's two-date stockpile project: converted pile outlines drew about 51 m under the ground (heights stored as 0), profile cards said "No data" because surfaces were never prepared, and there was no pile pop-up and no link from chart to scene. The founder approved 11 mock-up boards and waived the plan checkpoint.

## How to test

1. Open a project whose piles came from the old stockpile kit; in 3D, tilt the view: pile outlines sit on the piles, not under the ground.
2. Open a project with two or more never-prepared survey dates: a "Preparing survey surfaces" card shows in a bottom corner and the sidebar date rows read "preparing N %" then "ready"; Jobs lists it and Cancel stops it. Settings > Processing tools has "Prepare survey surfaces when a project opens".
3. Draw a distance line: its card lists every survey date as a chip; turn both surveys on and the profile shows both with cut and fill shading.
4. Old kit piles show the standard figure once surfaces are ready; History shows "was ... earlier version"; the project is not marked unsaved.
5. Click a pile in 3D, on the Map or in the sidebar (also with the right sidebar folded): the Volumes tab opens its panel with Volume, Tonnes and the change vs the previous survey; change the density and tab away; the "⋯" menu renames.
6. Profile tab: hover the chart and a tagged marker follows on the pile in 3D; drag the A, B or rotate handle; click the chart to pin, Esc clears the pin, Esc again returns to the inventory; double-click flies to the point.
7. Hover a distance line on the Map: the chart crosshair follows. In Split view the marker shows in both panes.
8. On a section card, Open larger opens a window over the lower stage that leaves the scene usable; point at the chart and press Add pin here.

Try it on any old-kit stockpile project, the quarry demo and the founder's two-date stockpile project.

## Open threads

- Stage C of the plan: figures follow the date, Stockpiles group, dates strip with timelapse, Volumes tab Inventory / Cut & fill / Materials, materials with dated density, one Show control, chart clipping.
- A Map fly with the section window open still centres the point under it (needs a screen offset on the workspace point fly).
- The local-only `@realdata` stockpile spec expects 19 piles, but the founder replaced them on 24 Oct with 6 hand-drawn volumes: decide whether to update it.
- The preparing card is half the view wide, narrower than the 330 px mock-up at 1100 px. Re-clicking a kit pile from callout plates or register rows does not reopen it.

## Next session entry point

Merge this PR through finish-task under the merge lock; then Stage C of `plans/2026-10-24-volumetrics-redesign.md`, rebased on the new main.
