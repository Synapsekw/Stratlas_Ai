# Area-scoped change detection: design

Date: 2026-10-19. Branch `feat/area-change-detection`.

## Intent

Survey-to-survey change detection (the Changes tab, after the alignment and line-up work) runs on the whole map. On a typical project the construction sits in one part of a much larger site, so a whole-map run buries the real progress under changes nobody cares about: vegetation, shadows, vehicles, stockpiles elsewhere. The founder wants to look at progress in one area only, with as little ceremony as possible.

## The flow (founder's)

1. Open a survey and draw a polygon around the area of interest with the existing measure tools.
2. Right-click the polygon, on the map or on its sidebar row, and choose **Compare with previous survey**.
3. The app picks the survey just before the current one and runs change detection inside the polygon only.
4. Results appear clipped to that area. Nothing outside the polygon is flagged.

## What "change" means here (founder's)

- **Imagery change** always runs: `change.raster` with the polygon as `mask`. Output is the usual heat map and change outlines, only inside the polygon.
- **Volume change is opt-in.** On a building site most change is structures going up, not ground moving, so volumes are often noise. The action opens a small confirm box (pair of dates, polygon name, an "Include volumes (cut and fill)" checkbox, off by default, last choice remembered per computer). When ticked, `change.surface` runs too, with the polygon both as the volume area and as a mask, so cut and fill regions and the heat map are clipped to the polygon, not just the totals. When either date has no elevation (DSM or point cloud), the checkbox is disabled with the reason.

## Changes tab (founder's)

For a pair of dates the list shows the whole-map result plus one entry per area, named after its polygon. Selecting an entry shows only that result. Imagery and volumes of one area show as one entry.

## Goals

- A single right-click action on a polygon measurement starts the scoped comparison.
- The scoped run reuses the existing pipeline jobs, results display and change sets. It is not a parallel system.
- Results are named after the polygon so several areas can be compared side by side.

## Non-goals

- No new analysis methods, thresholds UI or presets. The defaults stay the same as the Changes tab.
- No picking of an arbitrary comparison date from the menu. "Previous" means the survey before.
- No masks for `change.cloud`, `change.mesh` or `change.frames` in this round.
- No ignore polygons ("never inside") in the UI.

## Anti-goals

- Changes flagged outside the polygon.
- A whole-map run started by mistake (for example when the polygon is invalid).
- Overwriting an existing whole-map result for the same pair of dates: scoped results go to their own folder.

## Constraints and facts found

- `ChangeRasterParams.mask` (lon/lat ring) already exists and is honoured by `raster.py`. `ChangeSurfaceParams.areas` only adds volume totals; the DoD regions and heat map are still whole-map, so `change.surface` needs a `mask` too (Python, `ring_mask` exists in the raster step).
- **Contract change (needed):** the change set id is `change_set_id(from, to, producer)` in Python, and `commit_run` replaces the set, its layers (`{set_id}-heat`, `{set_id}-regions`) and carries reviews by that id. A scoped run would therefore overwrite the whole-map set. Add an optional scope to both job params (for example `scope: { id, name }` with the measurement id and label) that suffixes the set id and layer ids and names the layers; plus whatever the change set file needs to carry the scope so the Changes tab can list and name it. Row in `docs/architecture/contract-changes.md`.
- Polygons are `SurveyMeasurement` with `family: 'polygon'` and points (E, N, Z) in the project CRS. They must be converted to lon/lat for the jobs.
- The right-click menu is the shared action registry (`packages/ui/src/actions`). The canvas right-click (`survey/MeasureMenu.tsx`) and the sidebar row both resolve actions from it, so one registered action covers both.
- "Previous survey" uses the timeline order (`stepCapture` in `packages/workspace/src/timeline.ts`).

## Decisions left to the builder (calls made in this design, check them)

- **Which survey is "current"**: a survey-scoped polygon uses its own capture. A site-scoped polygon uses the date the main view is showing. If there is no earlier survey, the action is shown disabled with the reason "No earlier survey".
- **Which layers**: the ortho of each date for imagery, chosen the way the Changes tab chooses them. For volumes, prefer the DSM, else the point cloud, of each date.
- **Multi-selection**: the action applies to one polygon at a time. It is hidden or disabled for several selected items, or for lines and points.
- **Where results show**: the run hands off to the Changes tab with the pair loaded and the area entry selected. Label: "<polygon label>: <earlier date> to <later date>".
- **Identity and reruns**: a scoped set is keyed to the measurement id. Running again on the same polygon replaces that area's result and keeps its reviews, like a whole-map rerun. Editing or deleting the polygon later leaves the result as a snapshot until rerun.
- **Partial outcomes**: if imagery succeeds and volumes are refused (no elevation, misaligned), the area entry shows imagery with a note on why volumes are missing.
- **Polygon validity**: fewer than 3 points, self-intersection or zero area disables the action with a reason, never a whole-map run.
- **Alignment**: if the pair has not been lined up yet, the same check and message as the Changes tab apply. No new behaviour.

## Tests (expected)

- Python: `change.surface` with `mask` keeps no region outside the ring; scoped set ids do not collide with whole-map ids for both steps.
- Unit: polygon to lon/lat ring conversion; previous-survey resolution (survey scope, site scope, no earlier survey); params built for both jobs pass the schema parsers; action enablement rules.
- E2E: a new spec draws (or seeds) a polygon on the synthetic change demo, right-clicks it, chooses Compare with previous survey, and checks the scoped result shows and no outline lies outside the polygon.
