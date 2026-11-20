---
type: session
date: 2026-11-20-1347
branch: fix/volumetrics-test-fixes
status: complete
related: [../plans/2026-11-18-volumetrics-finalize.md]
---

# Four fixes from the founder's volumetrics test

## What changed

- **Pile panel, Profile.** Open larger, Export PNG and Add to report are the first row of the tab, above the chips and the chart (they sat under the chart and its figures). What Add to report did is said right under the row.
- **Pile panel, History.** Export CSV sits beside the m³ | t | Both switch on the tab's first line. That line keeps to the panel's width however wide the table under it is; in a panel too narrow for the title beside the two, the title goes under them, over its chart.
- **A picked tab brings its first row into view.** In a small window the panel's head fills the panel, so the tab's first row lay at the fold wherever it was put. Picking Profile or History now moves the panel by the least that shows that row (17 to 26 px at 1100 x 720). A pile opened on the tab it was left on stays where it was scrolled.
- **A pile with no volume says so.** A volume outline with no comparison shows "This pile has no volume yet" in History in place of an empty chart and table, with Recompute beside it where the volume card would offer it (a project that can be written, a prepared surface). It is the card's own Recompute, now one function (`recomputeVolume`), not a second way to compute.
- **Show, Elevation on a kit project.** The kit drapes its elevation colours in 3D only. Picked in Map view, Elevation now switches the stage to 3D and a notice says "Elevation colours show in 3D"; a split with a 3D side stays as it is with no notice, a split without one keeps its sides and shows the notice. The 3D legend says "The survey heights could not be read" when the read failed, where it said "Reading the survey heights" for good. In a survey project without a height map, the greyed Elevation says why in its tooltip.
- **After an independent review** (follow-up commits on the same branch): History says why a Recompute could not start or failed after it started, with the reasons the volume card shows (the engine's own trouble, then this pile's last run), also once the failed run left rows with no figure. A pile whose figure is carried from the kit gets the card's "Recompute with the standard base" there, never the plain Recompute; the card and History read one rule (`carriedItem`).
- No contract change, no pack change. One screenshot label in `e2e/compare.spec.ts` no longer carries a site name.

## Why

The founder's test of the volumetrics section (feature freeze, one section at a time): two actions he could not find, one empty table with no reason and one button that did nothing.

## How to test

1. Open a project with stockpiles, Project, Volumes, click a pile, then the Profile tab. Open larger, Export PNG and Add to report are the first row under the tabs, with no scrolling. Open larger opens the larger chart window.
2. Click the History tab. The m³ | t | Both switch and Export CSV are on the first line, with no scrolling up, down or sideways. Export CSV saves a file named after the pile.
3. Draw a new volume outline (Measure, Volume) and leave it without a base or a result, or pick a volume that shows no figure on any date. Open it and click History: "This pile has no volume yet", Export CSV greyed, Recompute beside the line. Click Recompute: the table fills with a row per survey date.
4. Open an old stockpile project (one made from a stockpile kit result), switch the stage to Map, then Layers & display, Surface and piles, Elevation. The stage switches to 3D with the elevation colours and their legend, and a notice reads "Elevation colours show in 3D".
5. In a survey project that has no height map, the same Elevation button is greyed; rest the pointer on it: "This project has no height map to show".

Steps 1 and 2 are driven by `e2e/pile-panel.spec.ts` ("Profile and History show their actions without scrolling", "Open larger opens one section window") and the file saved in step 2 by `e2e/volumes-finalize.spec.ts`. Step 3 is driven by `e2e/pile-panel.spec.ts` ("a volume outline with no volume yet says so in History, and Recompute works it out") from the point where the outline exists; drawing it by hand is not part of that test. Step 4 is driven by `e2e/kit-migration.spec.ts` ("Elevation picked in Map view on a kit project brings the 3D view and says why"). Step 5 is covered by a unit test only (`StageShow.test.tsx`); the tooltip was not looked at in the running app. The legend's "could not be read" line is covered by unit tests only: no project at hand fails that read.

## Open threads

- The pile panel's head is about 450 px tall in the 287 px panel of a 1100 x 720 window, which leaves 20 to 40 px for a tab. The scroll on a tab pick works around that; a shorter head is a design call and was left alone.
- At that panel width Add to report wraps under Open larger and Export PNG, and the History table is still wider than the panel (it scrolls sideways as before).
- The notice waits behind a stage hint, as every plain notice does, so it can show a moment after the switch to 3D.
- The scroll on a tab pick uses `scrollIntoView`, as other lists in the app do; scrolling only the panel's own scroll box would take finding that box and working out the distance, and was left as it is.
- The reasons a Recompute failed are covered by unit tests only: no project at hand makes a started run fail.
- Other screenshot labels in `e2e/compare.spec.ts` and a fixture in `packages/volumetric/src/store.test.ts` still carry site names (the engineering review's clean-up item); only the one label named in the brief was changed.

## Next session entry point

The founder runs the five steps as part of the volumetrics section; the volumetric report is designed separately and was not touched.
