---
type: session
date: 2026-10-11-1016
branch: feat/drag-group-to-date
status: complete
related:
  - ../plans/2026-10-11-drag-group-to-date-design.md
  - ../plans/2026-10-11-drag-group-to-date.md
---

# Move a whole group to another survey date

## What changed

- A group heading inside a survey date folder (Video, Photos, Panoramas, Models, Point clouds, Maps and rasters) drags onto another date folder, or moves from right-click **Move to date**. Every dataset of the group is filed there in one save. Single rows and flight rows behave as before.
- After a move of more than one dataset, a note pinned at the top of the list says how many moved and offers a one-step **Undo**. Undo only puts back datasets that are still where the move put them.
- No change to `@aio/schema`, IPC or project files. `@aio/ui`: `DatasetTree` gains optional `dragGroupIds` and `onGroupMenu`; `DateItemMenuRequest` gains `name`.
- Ten commits on `feat/drag-group-to-date`, handed to the Orchestrator at `9a865f0e` and taken into integration round 46 (`pnpm check` green after the rebase; `timeline.spec.ts` and `date-annotations.spec.ts` 14 passed the CI way). This note is on `docs/wrapup-group-move-to-survey-date`.

## Why

A survey imported under the wrong date holds many datasets, and filing them one by one was slow and easy to leave half done. Undo was added because a group dropped on the wrong folder mixes into that folder's own group.

## How to test

1. Open a project with at least two survey dates and several videos, photo sets or panoramas under one of them.
2. In the Datasets list, open that date's folder and drag the **Video** heading onto another date folder. Folders that can take it get a dashed outline; the one under the pointer lights up.
3. Drop. Every video of that date is in the other folder, and a note at the top of the list says how many datasets moved.
4. Scroll the list: the note stays in view. Click **Undo**: the videos are back where they were.
5. Right-click the **Photos** heading and pick a date under **Move to date**: all photo sets move.
6. Drag one single dataset onto another date: it moves alone, with no note.

## Open threads

- `docs/TESTING.md` fails `check-public-text.mjs` on lines that predate this branch (client and site names in older test steps). Not touched here; needs its own doc branch.
- When every dataset is dated, the pinned "Drop for no date" place covers a date folder sitting at the very foot of the visible list during a drag. Existing behaviour; bottom padding on the list during a drag would remove it.
- When a dataset stays under the date in its name and several others move, the note shows only the "stays" text (with Undo), not the count.
- Not built by choice: dragging a whole date folder onto another, and picking several rows with Ctrl or Shift.

## Next session entry point

Once the Orchestrator confirms round 46 has landed, run `node tools/agent/finish-task.mjs --cleanup feat/drag-group-to-date` from the main checkout, and the same for this note's branch after it lands.
