---
type: session
date: 2026-10-25-0056
branch: feat/volumetrics-stage-c
status: complete
related:
  [
    plans/2026-10-24-volumetrics-redesign.md,
    plans/2026-10-24-volumetrics-redesign-design.md,
    sessions/2026-10-24-1517-volumetrics-redesign-a-b.md,
  ]
---

# Volumetrics redesign, stage C

## What changed

- This PR (`feat/volumetrics-stage-c`): pile figures, labels and totals follow the date in focus (`figureOn`, `resultOn`); piles sit in a project-level Stockpiles group in the sidebar; materials gain a colour and a density by survey date (`SiteMaterial.colour`, `densityHistory`; contract row 2026-10-24) and every density read and write is dated; one counting rule is shared by the Volumes header, the strip, the timelapse, the sidebar and Materials.
- The Volumes tab: a header for the date in focus (Volume, Tonnes, change vs the previous survey) and three panes. Inventory groups piles by material with subtotals and a site total. Cut & fill has From / To on a shared compare pair, Inside piles or Whole site, a threshold, per-pile bars and cached engine runs shared across views. Materials is an editable table: density from a date with history and an impact preview, pile assignment, CSV import and export that keep colour and history.
- One stage Show control (Photo / Elevation / Cut & fill, Outlines, Labels, Colour piles by material or change) replaces the duplicated kit controls; Show, Cut & fill with no pile selected drapes whole-site cut and fill between the compare pair with a legend.
- The 160 px dates chart strip under the stage: Volume / Tonnes / Cut & fill, survey markers, a playhead with readout, a compare band, play / step / speed / loop, a selected pile's line, and a Dates | Footage switch that drops to icons on a narrow bar. Timelapse crossfades dated orthos on the map (`MapController.setRasterBlend`), swaps 3D to the next survey halfway, estimates nothing between surveys and stops on a manual date change, a pile click or Esc.
- Folded fixes: chart clipping, "Cut + fill" naming, kit legend units, statuses on live cards. An independent review raised 18 findings, all fixed (materials draft per project and rebased on Save, dated density everywhere, CSV merge, the counting rule, the map blend cleared on its own map, per-project state, the engine run cache, honest strip gaps, same-day surveys).
- Evidence: `dates-strip` and `volumes-tab` 39/39 with `--repeat-each=3`, a wide CI-way run 134/134 over 31 specs, `pnpm check` green. Earlier in this block, already in the batch on local `main`: stages A and B, and fix branches for the kit pile click, kit DSM surfaces, the section window and two CI rounds (background prepare races).

## Why

Stage C is the dates half of the founder-approved redesign: a stockpile site is read survey by survey, so figures, tonnes and colours have to follow the date in focus, and density changes must not rewrite earlier tonnes.

## How to test

1. Open the quarry demo or any project with two or more survey dates: a 160 px dates chart strip sits under the view; switch Volume / Tonnes / Cut & fill; click a survey marker and the date, the sidebar Stockpiles rows, the 3D labels and the Volumes header all follow.
2. Drag the playhead and read its card; turn on Compare and drag the brackets; press Play: the map crossfades the orthos, 3D swaps to the next survey halfway, the notch reads "Playing · date"; Esc stops.
3. Volumes tab: the header shows Volume, Tonnes and the change vs the previous survey; Inventory groups piles by material with subtotals and a site total; click a row to open the pile.
4. Cut & fill tab: pick From and To, switch Inside piles / Whole site and the threshold; click a pile bar to open it.
5. Materials tab: change a material's density from a later survey date: earlier dates keep their tonnes and History shows both values; assign piles to a material; Save.
6. Show control (top left of the view with the Volumes tab open): Photo / Elevation / Cut & fill; with no pile selected Cut & fill colours the whole site and shows a legend; Outlines and Labels hide pile outlines and labels; on Materials, Colour piles by Material or Change.
7. In a video project with dates, the bottom bar has a Dates | Footage switch (icons only on a narrow window).

## Open threads

- Within 12 px of a line a click pins the line instead of opening the pile under it (zoomed out this can catch clicks meant for the pile).
- The whole-site cut and fill drape draws over models (depth test off, like the pile heat map); check it in the real app. With a pile's own heat map focused, the legend still names the compare pair.
- The pile History export takes dated density only through the card path (header and pile export are fixed). Kit swipe still compares only the first and last survey. Sidebar date rows do not say fading in or out during timelapse.
- The local-only `@realdata` stockpile spec is updated but not run (its real project was hand-edited).

## Next session entry point

This PR is handed to the local merge queue coordinator for the next batch; after the founder's test, pick up the open threads above, then volumetric parity Waves 2 and 3.
