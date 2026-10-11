# Move a whole group to another survey date: design

Date: 11 Oct 2026. Branch: `feat/drag-group-to-date`.

## Why

A project that is flown again and again keeps each flight under a survey date folder in the Datasets list. Filing a dataset under another date works today by dragging its row onto a date folder, one dataset at a time (a flight row carries its clips). A survey that was imported under the wrong date has many datasets: a dozen video flights, several photo sets, several panorama sets. Moving them one by one is slow and easy to get half done.

## What the founder asked for

- Grab a whole type group inside a date folder (Video with all its flights and clips, Photos, Panoramas, and the same for Models, Point clouds and Maps and rasters) and drop it on another date folder. Everything in the group moves together.
- Dragging a single dataset stays as it is.
- It is a move, not a copy. A dataset still belongs to one date.

Chosen scope (asked on 11 Oct 2026): **group headers**. Not in scope: dragging a whole date folder onto another, and picking several rows with Ctrl or Shift before dragging.

## Assumptions

- The right-click **Move to date** menu offers the same on a group header, so the keyboard can do it too (menu key, Shift+F10).
- Dropping a group on **Every date** takes the date off every dataset in it, with the rule that already holds: a dataset whose name carries a date stays under that date, and the list says so.
- Rows hidden behind "N more" in a long group move with the group. The group is what its count says.
- Offline basemaps and original reviews never belong to a date. A group that holds one moves its other datasets and leaves that one where it is. A group with nothing that can be dated (Annotations, or Maps and rasters with only a basemap) cannot be dragged and has no menu.
- Group headers drag only inside date folders. A project without survey dates has no folders to drop on, and the icon rail has no headers to grab.
- A read-only package and a look-only reviewer get neither the drag nor the menu, as for rows.

## Behaviour

1. Inside a date folder, a group header whose group holds at least one datable dataset can be dragged. The existing drop feedback applies unchanged: folders that can take the drop get a dashed outline, the one under the pointer lights up in its colour, the list scrolls when the drag is held at its edge, and **Every date** appears at the foot of the list when it is not in the list.
2. Dropping on a date folder files every datable dataset of the group under that date, in one save. Dropping on the folder the group is already in does nothing.
3. Right-click on a group header (or the menu key on its button) opens **Move to date** with the heading "Move to date · Video · 12 datasets". The folder the group is in is disabled, as for a row.
4. After a move that filed more than one dataset (a group, or a flight row with several clips) the note at the top of the list says what happened and offers **Undo**: "12 datasets moved to 2 Oct 2024." The note stays in view while the list scrolls. Undo puts each dataset back under the date it had, in the manifest terms it had (a date of its own, or none); a dataset that was filed under a different date since the move is left where it is. The note goes when it is dismissed, when Undo is used, or when the next move is made. Undo is one step, for the last move only, and is gone once the project is closed.

Point 4 is the one addition beyond the request. Reason: a group dropped on the wrong folder mixes into that folder's own group, and without Undo the only way back is one dataset at a time, which is the problem this work removes. It is a separate task in the plan and can be struck without touching the rest.

## How it is built

No change to `@aio/schema`, to IPC or to the project files. `builder:updateLayers` already takes a list of layers and one `{ capture }`, and `planDateMove` already plans a move for any list.

**`@aio/ui`**

- `tree/model.ts`: `groupDatableLayerIds(group)`, the datable layers of every row of a group (`datableLayerIds` per item).
- `tree/DatasetTree.tsx`: two optional props beside `dragIds` and `onItemMenu`. `dragGroupIds(group)` returns the layers a header carries, none for a header that stays put; a header with layers is `draggable` and reports through the existing `onDragItem`. `onGroupMenu(group, layerIds, at)` hears a right-click on a header. Neither applies in rail mode. The header row gets `data-testid="tree-group-<kind>"`.
- `tree/DateTree.tsx`: passes both through for each folder. `DateItemMenuRequest` gains `name` (the heading the menu shows: the row's name, or the group label with how many datasets it moves); `item` becomes optional and is set for a row only. Additive for the one caller.
- `i18n/en.ts`: the group heading, the moved note and Undo.
- `mission.css`: the header drags as an element (as rows do); no new colours or shapes.

**Desktop shell**

- `shell/DateMenus.tsx`: `LayerDateMenu` reads `menu.name`.
- `shell/dateUndo.ts` (new, pure): what a move wrote (`MovedLayer`: a layer and the `capture` it had of its own before, `null` for none) and the writes that put it back, one per distinct earlier value, skipping a layer removed since.
- `shell/dateFolders.ts`: `moveLayersToDate` also returns `moved`. `undoDateMove(moved)` writes them back, one `builder:updateLayers` call per batch.
- `shell/Sidebar.tsx`: the note may carry an Undo action; `onMove` sets it when more than one layer was written.

## Errors

- A failed save shows the existing red note; nothing is half moved, because a group is one `builder:updateLayers` call.
- Undo that fails part way (two earlier values, second call refused) shows the red note with the error; the list shows the manifest as it now is.

## Tests

- Unit, `@aio/ui`: `groupDatableLayerIds`; a header drags and drops its group; a header with nothing datable does not drag; no drag in read-only or rail mode; right-click on a header asks for the menu with the group's layers, name and folder.
- Unit, desktop: `LayerDateMenu` shows the group heading; `priorCaptures` and `undoBatches` (each earlier value restored, a removed layer skipped).
- End to end, `apps/desktop/e2e/timeline.spec.ts`: a group header dragged onto another date folder files every dataset of the group there and leaves the files untouched; Undo puts them back; **Move to date** from a group header does the same move. The three-date fixture is not changed: the test first files the undated outline under November so that November's Maps and rasters group holds two datasets.

## Docs

`docs/guide/28-survey-dates.md` (Moving a dataset to another date) and the survey date steps of `docs/TESTING.md`.
