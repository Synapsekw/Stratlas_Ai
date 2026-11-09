---
type: session
date: 2026-11-09-1826
branch: fix/flyability-mission-folder
status: complete
related:
  [
    sessions/2026-11-09-0926-flyability-real-export-run.md,
    superpowers/specs/2026-10-31-flyability-inspector-import-design.md,
  ]
---

# Flyability mission folder import and real-export fixes

## What changed

- A whole mission folder can be picked or dropped: the app walks it (5 levels, links followed once, names matched in any case), lists every Inspector export as a chamber with photos, point clouds and findings, says what it skipped, and imports the ticked chambers into one project, one space each, one job at a time. Cancel, project close, opening another project and quit drop the waiting chambers; an empty chamber the import made ahead is tidied, a chamber the user emptied is kept. Add data on an ordinary folder still looks only one level down.
- Real-export fixes: the wall distance check adds 0.14 m (the drone measures from behind the camera), unnamed flights get `flight-<id8>` cloud names while existing layers keep their files, only the merged cloud shows at first, a chamber is framed on its own points (lidar strays and coarse octree nodes ignored), and a chamber shows no street map offer, basemap chip or UTM readout.
- Real run of a four-chamber mission from its root: 4 chambers, 587 findings, 892 s; disagreements 98 to 51; re-drop reopens the same project. Contract rows and data conventions section 40 updated.

## Why

The founder found adding a mission confusing ("so many files"), and the first real run found the check bias and viewing issues.

## How to test

1. Run `pnpm dev`. On the library, choose Add a project folder and pick the whole mission folder, not a chamber. (Corrected 9 Nov: dropping the folder on the library did not work until `2026-11-09-2228-inspector-export-root.md`.)
2. The Inspector window lists every chamber with its photos, point clouds and findings, and a line saying how many other folders were skipped. Leave them ticked and choose Import.
3. The import card shows each chamber as Queued, then Running, then Imported; the card closes when all are in.
4. Switch chambers in the title bar: only the merged cloud is on, the readout says Local frame, and there is no street map chip. (Corrected 9 Nov: the view was not re-framed on a switch; Home did that. The framing on a switch came in `2026-11-09-2228-inspector-export-root.md`.)
5. Drop the same mission folder again: the same project opens and the chambers are marked as already imported.
6. Start a mission import and cancel the running chamber: the waiting chambers show Not imported and no empty chamber stays in the switcher.

## Open threads

- Switching chamber does not re-frame the view by itself; Home does. (Fixed in `2026-11-09-2228-inspector-export-root.md`.)
- The remaining wall distance disagreements (51 of 587) are not investigated.

## Next session entry point

Phase 2: video projected on the cloud.
