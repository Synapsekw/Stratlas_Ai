---
type: session
date: 2026-10-13-1700
branch: docs/wrapup-delete-and-start-over
status: complete
related:
  - ../plans/2026-10-13-delete-and-start-over-design.md
  - ../plans/2026-10-13-delete-and-start-over.md
---

# Delete and Start over

## What changed

- Built and merged **Delete and Start over** (PR #111, `main` e6bb392a to 0d994a51, 35 commits). Contract row in `architecture/contract-changes.md` (`builder:removePlan/remove/trash/emptyTrash`, `aio.trash/1`, `photo:readRun` `missingFolders`); `data-conventions` section 33 covers the project trash and `held-` entries.
- Delete... on Datasets rows, group headers and survey-date folders, with Ctrl/Shift-click and keyboard multi-select (Shift+Arrow, Ctrl+Space, Delete). One confirm dialog lists what goes along (runs, map layers, comparisons, tilesets) and what stays.
- Files go to `<project>/.trash/` for 7 days (swept on open); Empty project trash sits in a Datasets footer line and the library project menu. Nothing outside the project root moves (links and junctions refuse). Removals work in `held-` entries with an in-progress note and become trash only after the manifest save.
- Processing drawer: Delete run, and Start over... on failed or cancelled runs (wizard prefilled; the old run is trashed only after the new run started). A survey date takes its runs whose layers all go. Issues on a removed dataset show "Dataset removed". Walk Remove uses the shared dialog.
- Process: subagent-driven, 15 tasks, each independently reviewed (caught a top-level photos folder ownership bug, three rounds of trash held races, a Start over double-start, a project switch mid-dialog). `pnpm check` green (7306 tests); CI-way e2e green. First CI run failed on a race in the new spec (it picked a `held-` entry); fixed test-only, CI 17/17 green.

## Why

Users could not remove a dataset or a failed run and begin again without leaving files and layers behind. Founder decisions of 13 Oct: trash and Empty now; dependents shown and taken along; Start over is a prefilled wizard; issues are kept; deleting a date folder removes the date unless still used; peer file cleanup, in-app Restore and the eye staying visible while marked were settled as stated in the plan.

## How to test

1. Datasets: delete one dataset; the dialog lists what goes along and what stays.
2. Delete the Video group, then a survey-date folder (the date goes, or the dialog says why it stays).
3. Ctrl/Shift-click or Shift+Arrow three rows, press Delete.
4. Delete a photos dataset a run used: the dialog lists the run and its maps.
5. Processing drawer: Delete run; on a failed run use Start over... (Cancel leaves it; Start replaces it only after the new run started).
6. Datasets footer "Trash ... Empty" and the library project menu "Empty project trash".
7. An issue on a removed dataset shows "Dataset removed".
8. Files sit in `<project>\.trash\` for 7 days; `held-` folders are protected.

## Open threads

- Founder reported DJI drag-drop showing MP4 + .SRT + .LRF "as a separate dataset under Video". Code reading shows SRT pairs with its MP4 on every import path; likely cause is ungrouped per-clip rows in a new survey-date folder plus one "Not a file type" row per LRF on loose drops. Unconfirmed: needs a screenshot or the project path.
- Follow-ups: in-app Restore; peer file cleanup on hub sync; the eye plus "N selected, Delete..." header fit at 252 px not seen visually; minors (keyboard Delete on a focused row button asks for the row; held entries from failed removals can leak space by design).
- The photo-scale branch (pipeline pack 0.6.1, untwine COPC, new work layout) rebases on this and merges later. Installer 0.12.0 in `apps/desktop/dist` predates this feature.
- The `_draft-*.md` stubs in the main checkout are empty and gitignored; they can be deleted by hand.

## Next session entry point

Get the DJI screenshot from the founder, then pick from Walks W3 to W5, Timeline T4 or the in-app Restore follow-up.
