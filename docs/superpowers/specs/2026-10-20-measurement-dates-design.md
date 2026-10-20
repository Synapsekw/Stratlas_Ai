# Measurements under their survey dates, and folder drag (design)

Draft, 20 Oct 2026, for the founder's review. Branch `feat/measure-dates`. No product code yet.

## Intent and why

The sidebar files layers under date folders (`packages/ui/src/tree/DateTree.tsx`), but every measurement sits in one Measurements group below all of them, whatever date it was taken on. A volume measured on the March survey and one measured on the June survey look the same in the list, and the only way to file a measurement into a folder is the right-click "Move to folder" submenu.

The founder wants a measurement to live with the survey date it was measured on, like a layer does, and to move it with the mouse: between its folders, and to another date, where it is measured again on that date's surface.

## Goals

1. A new measurement takes the survey date of the map or cloud layer it was measured on and shows inside that date's folder, next to the layers.
2. Measurement rows drag into, out of and between measurement folders. Each date has its own set of folders. Right-click "Move to folder" stays.
3. A measurement dragged onto another date folder moves there (it is not copied). Its shape stays where it is and its values (length, area, volume, heights) are worked out again on the new date's surface.
4. Measurements saved before this change land under a date where the app can tell which, and stay in a loose undated group where it cannot.

## Non-goals

- Copying a measurement to another date by drag. "Copy to another survey" in the Selected panel (`survey/MeasurementPanel.tsx` ~:412) already does that and stays.
- Folders that exist with nothing in them. A folder is still just a name that measurements carry.
- Moving a measurement when its layer is re-filed under another date (see open points).
- Changing how layers drag between dates.

## Anti-goals

- No guessing of dates the person cannot see or undo. A backfill only files a measurement when one date clearly fits.
- No silent loss of values: a move that cannot be measured on the target date is refused, never left with blank or old numbers that look current.
- No folders made on the person's behalf.

## Constraints

- Measurements autosave off by default: every change waits for **Save measurements** (`survey/measureStore.ts`:5), and derived numbers are written without marking the file unsaved (`setComputedResults`, :438).
- Read-only projects (a package, or a reviewer who may only look) cannot move or re-file anything (`Sidebar.tsx`:326 `canEdit`, :779 `canMeasureEdit`).
- `@aio/schema` is frozen; any field change needs a row in `docs/architecture/contract-changes.md`.
- No em or en dashes in user-facing text. Renderer talks to main only through `window.aio`.

## Founder decisions

1. A measurement belongs to the survey date of the map or cloud layer it was measured on, set automatically when it is made, and shows inside that date's folder in the sidebar alongside layers.
2. Measurements drag into, out of and between their own folders, beside the existing right-click Move to folder. Each date has its own separate set of measurement folders.
3. A measurement dragged to another date folder moves (not copies) and is measured again on the new date's map or surface: the geometry stays, the values are worked out again against that date's surface.

## My calls

- **Undated measurements.** Existing measurements get a date from the layer they were measured on where that can be determined (see Backfill); the rest stay in a loose "Measurements" group with no date until dragged.
- **No surface, no move.** A move is refused with a short note when the target date has no layer covering the shape.
- **Folders on a date move.** The measurement goes into the folder of the same name under the target date if one exists, else loose under that date. A folder is never made automatically.
- **Measured on a common layer.** A measurement drawn on a layer that belongs to no date (a basemap, a design) takes the date in focus; with no date in focus it stays undated.

## Current state

**The date is already in the data model.** `SurveyMeasurement.scope` (`packages/schema/src/survey.ts`:438) is `MeasurementScope` (:406), either `{ kind: 'site' }` or `{ kind: 'survey', capture }`, where `capture` is a survey date's capture id. A person can set it today in the Selected panel's Scope section ("Only in <date>", "Promote to the whole site", `MeasurementPanel.tsx`:377-410) through `setScope` (`measureStore.ts`:557), which also re-stores the points in the new date's line-up frame (`storedPoints`, `measureDates.ts`). But every new measurement is made with `scope: { kind: 'site' }` (`measureStore.ts`:853 for drawn shapes, `WholeSite.tsx`:231 for whole-site regions), so in practice almost all are undated.

**No source layer is recorded.** `SurveyMeasurement` has no layer field. A click in 3D raycasts the stage (`measureScene.ts`:271-282) and keeps only the hit point; the hit object does carry its layer id up its parent chain (`userData.aioLayer`, set in `packages/engine/src/adapters/mesh.ts`:312, `raster.ts`:300). A map click carries only longitude and latitude (`measureScene.ts`:827-845). Vertex heights are stored as picked (E, N, Z).

**Captures and a layer's date.** `captureIndex` (`packages/workspace/src/captures.ts`:129) maps each layer to a capture (`of[layerId]`): the layer's own `capture` first, then the volume lists, then a date or capture id in the layer's name. The sidebar reads it through `useCaptureIndex()` (`Sidebar.tsx`:301).

**How values are computed.** Two paths, both in the renderer:

- Readouts (length, plan and surface area, heights, slope) come from `measurementReadout` (`packages/survey/src/tools/readout.ts`:263), computed on every render and never stored. Terrain rows sample `measureStore.surface`, which is the 3D stage's visible terrain (`MeasureToolbar.tsx`:83, `stageClamp` at `measureScene.ts`:196), not the measurement's date. Reports already sample one date's prepared surface instead (`reportPage/house/surveyData.ts`:330-375).
- Comparison results (volume, cut and fill) are stored in `results` with fingerprints, computed by the survey engine worker (`compareStore.ts`, `engine.worker.ts`, `packages/survey/src/engine`). `current` and `previous` resolve to the prepared surfaces of the measurement's own capture and the one before it (`resolver.ts`:107-126, the capture from `captureOf`, `compareStore.ts`:171). So changing the scope changes the fingerprints and the result reads **Stale, recompute** (`isStale`, :284); `computeAll` (:440) is the recompute path. The prepared height tiles themselves come from the Python `survey.prepare` job (`compareStore.ts`:598-606).

**Persistence.** `<project>/survey/measurements.json`, `aio.measurements/1` (`survey.ts`:455), a loose object, read and saved by `loadMeasurements` and `saveMeasurements` (`measureStore.ts`:287, :330). `folder` is an optional trimmed string (:437); `measureFolders` (:636) lists the names across the whole file.

**Undo.** Only deletions undo (`undoDeleteMeasurements`, :510). Folder and scope changes have none beyond **Revert** to the last save (:362). Layer date moves have their own Undo in the sidebar note (`undoDateMove`, `Sidebar.tsx`:960-964).

**The tree.** `buildMeasureItems` (`survey/measureRows.ts`:44-90) builds folders then loose rows over the whole file, with folder ids `measure-folder:<name>`; a survey measurement whose date is off screen is dimmed (:61). The rows render once, below the date folders, through `DateTree`'s `after` prop (`Sidebar.tsx`:296-299, `DateTree.tsx`:375-377), with no drag source. Date folders take drops of layers only (`DateTree.tsx`:122-146, `onMove` to `moveLayersToDate`, `Sidebar.tsx`:479), and rows drag only through `datableLayerIds` (`model.ts`:281-295, `DatasetTree.tsx`:544-560). The Move to folder submenu offers every folder in the file (`measureActions.tsx`:143-176).

**Date focus and visibility.** Focusing a date (`timeline.focusSurvey`, `workspace/timeline.ts`:232) swaps the layer switches from the old date to the new, keeping any extra date the person turned on. A survey measurement is drawn only while one of its date's layers is shown (`scopeOnScreen`, `packages/workspace/src/dateVisibility.ts`:72, used by `measurementsOn`, `measureDates.ts`:24); each side of a split reads its own dates (`primaryScene`, `primaryMap`). So once measurements carry their dates, focusing a date already hides the other dates' measurements. No new filter is needed.

**Tests.** Unit: `measureStore.test.ts`, `measureDates.test.ts`, `measureRows.test.ts`, `measureVisibility.test.ts`, `measureActions.test.ts`, `packages/ui/src/tree/DateTree.test.tsx`, `measureTree.test.tsx`, `dateModel.test.ts`. End to end: `measurement-layers.spec.ts` (tree rows, Move to folder), `measure-tools.spec.ts`, `date-annotations.spec.ts` and `timeline.spec.ts` (dates and focus).

## Proposed approach

### Data model

No schema change. The date is `scope.capture`; undated is `scope.kind === 'site'`. A folder belongs to a date by grouping: the key is the pair (date or none, folder name), so "Piles" under March and "Piles" under June are separate folders. No contract row is needed unless the builder adds the optional source layer field (open points).

### Date at creation

When a shape is finished (`drawEvent`, `measureStore.ts`:850-860), pick its date:

1. In 3D, the layer of the hit under the first vertex: walk the hit object's parents for `userData.aioLayer` and look it up in `captureIndex().of`. `pick` returns that layer id beside the point.
2. Otherwise (a map click, or a common layer), the date of the view: the one date on screen in that view's dates, else the focused date.
3. Otherwise undated.

The measurement is made with `{ kind: 'survey', capture }` and its points stored through `storedPoints` for that date. Telecom picks and whole-site regions follow the same rule.

### Sidebar

`buildMeasureItems` takes a capture (or none) and builds that date's folders and loose rows; folder ids gain the date (`measure-folder:<capture>:<name>`). `buildDateTree` puts each date's Measurements group inside its folder, as it does each date's Annotations group; the `after` group holds only undated measurements. The filter box, eyes, counts and new-folder row work per group.

Drag: measurement rows and measurement folder rows become drag sources (`measures` props gain `dragMeasureIds` and `onDragMeasures`). `DateTree` keeps one drag state with a kind (`layers` or `measurements`). Drop targets for a measurement drag:

- a measurement folder row of the same date: `setFolder(ids, name)`;
- the date's Measurements group header: `setFolder(ids, '')`;
- another date folder: the date move below;
- the undated group: back to `{ kind: 'site' }`, no recompute of comparison results needed beyond the stale mark.

Layer drags ignore measurement targets and the reverse. Move to folder lists only the folders of the marked measurements' date, and is disabled with a reason when the marks span dates. All drag wiring is left out when `canMeasureEdit` is false.

### Date move and re-measure

A new store action `moveToDate(ids, capture)`:

1. Check coverage first: the target date's prepared surface (`surfaceOfCapture`) must have data under every vertex (its `bounds`, then a sample). If it has none, check that a layer of that date is loaded in the stage and covers the shape. Refuse with a note naming the date when neither holds.
2. `setScope` to the new date (points re-stored in its frame), and `folder` set to the same name if that date already has it, else cleared.
3. Re-sample vertex heights from the target surface, so heights and 3D lengths follow the new date.
4. Mark comparison results stale and run `computeAll(ids)`; `current` and `previous` now resolve to the new date. Readouts recompute on render.
5. One sidebar note for the move with an Undo that restores scope, folder, points and results.

### Backfill

On load, for each undated measurement, sample every date's prepared surface at its vertices and compare with the stored heights. If exactly one date matches (median height difference under a small tolerance, and clearly better than the next), file it there. The change is derived, like `setComputedResults`: not a person's edit, not unsaved, written with the next save; in a read-only project it is shown but never written. Anything else stays undated.

### Errors

Short notes in the sidebar note slot, no dialogs: target date has no surface under the shape; surface not prepared yet (offer Prepare surfaces); read-only project (no drag starts at all).

## Open points for the builder

- **Whole-site measurements.** Today "Promote to the whole site" is a deliberate choice, and it cannot be told apart from never dated. Founder question: keep site-wide as an option, or is undated only a holdover?
- **Source layer field.** An optional `measuredOn` layer id would make later moves and re-dated layers exact. It is a contract change; leave it out unless needed.
- **A layer re-filed under another date.** Do its measurements follow? Without a source layer they cannot. Founder question.
- **Telecom measurements.** Azimuth, tilt and clearance pick antenna features; re-sampling their heights on another date would break them. Suggest moving them with heights kept, or refusing the move.
- **Explicit surface refs.** Comparison items that name a prepared surface (`{ kind: 'survey', surface }`) rather than `current` do not follow the date; decide whether a move rewrites them to the new date's surface.
- **Stockpile projects** where the volumes own the date focus (`timeline.ts`:238): check the drop and the visibility there.
- **Readouts on screen** sample the visible stage terrain, not the measurement's date; with split dates that can differ. Consider sampling the measurement's date surface instead.

## Tests and end to end expected

Unit:

- `measureRows.test.ts`: groups per date, same folder name under two dates stays separate, undated group.
- `measureStore.test.ts`: date chosen at creation (3D hit layer, view date, none); `moveToDate` re-scopes, re-stores points, keeps or clears the folder, refuses without coverage, Undo restores; backfill files only clear matches and does not mark the file unsaved.
- `DateTree.test.tsx` and `measureTree.test.tsx`: measurement drag targets, no layer and measurement cross drops, no drag in read-only.
- `measureActions.test.ts`: Move to folder lists only the date's folders and is disabled across dates.

End to end (run the CI way, 1100 x 720 at scale 1 on WARP):

- `measurement-layers.spec.ts`: drag a row into a folder and out again, wait for Save.
- A new `measurement-dates.spec.ts` on a two-date project: draw on date A, see the row under A; focus B and the shape hides; drag it to B, the value changes, the row moves into B's same-named folder; a move to a date without a surface shows the note.
