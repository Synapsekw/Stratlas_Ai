---
type: session
date: 2026-10-25-2120
branch: fix/change-detection-layers
status: complete
related: [plans/2026-10-19-area-change-detection-design.md]
---

# Area compare leaves one layer, and date moves can be undone

## What changed

- A polygon's "Compare with previous survey" leaves one row, `<area>: change, A to B` (`area_layer_id` / `place_area_layer` in `change/derived.py`), instead of two to four heat and regions rows. With volumes it shows the cut and fill heat map, without them the imagery heat map. Deleting the row removes both change sets and their files. A rerun keeps the name, date and visibility the person gave the row. Old `-heat` / `-regions` rows go away on the next run. Whole-map runs are unchanged.
- Change pipelines write `manifest.json` under a cross-process lock (`runtime.manifest_lock`, `derived.update_manifest`). The raster and surface jobs commit in parallel and could drop each other's layers.
- The removal plan refuses to delete an area row while one of its jobs still runs (`areaLayerId` in `removePlan.ts`, pinned to the Python formula).
- Every re-file of a layer to another date (drag, right-click File under, the Selection card picker) shows "Moved ... / Undo", for one layer too. Undo of a move to a new survey date removes that date if it is left empty. File under has its own menu group, apart from Compare.
- Contract row in `architecture/contract-changes.md`. The pipeline pack needs a bump; the coordinator assigns the number.

## Why

The founder reported that an area compare "made an ortho disappear" and added too many layers. The project files showed that no job touched the ortho. An app write re-filed it under an older date two minutes after the run, and a single-layer move had no notice or Undo, so its row seemed to vanish.

## How to test

1. Install the new pipeline pack, then open a project with two dated surveys that each have an ortho.
2. Draw a polygon, right-click it, pick Compare with previous survey, tick Include volumes and run it. When both jobs end, Maps and rasters gains exactly one row, `<polygon>: change, A to B`, showing the cut and fill heat map inside the polygon. Every original ortho and DSM stays in its date folder.
3. While the second job is still running, try to delete the row: it is refused with a "Cancel it first" message.
4. After both jobs end, delete the row: the layer list and the Changes tab are back to how they were before the run.
5. Drag an ortho onto another date folder, or right-click > File under another date: a "Moved ... to ..." note appears with Undo, and Undo puts it back.
6. On the Selection card, set "Belongs to date" to New survey date, then Undo: the layer is back and the new date is gone.

## Open threads

- Cut and fill regions and the imagery heat map no longer get rows of their own. Their pins show in the Changes tab.
- The app's own manifest saves and non-change pipelines are not under the new lock.
- The "Moved" note pushes the list down, so the pinned "Drop for no date" place can land under the pointer near the list's foot (seen in the timeline e2e, not tried by hand).
- The Selection card's Undo note shows only while the sidebar is open.

## Next session entry point

Hand-off to the merge coordinator with a pack number, then the founder's How to test above.
