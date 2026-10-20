# Measurements under their survey dates, and folder drag (design)

Draft, 20 Oct 2026, updated the same day with the founder's answers and a review. Branch `feat/measure-dates`. No product code yet.

## Intent and why

The sidebar files layers under date folders (`packages/ui/src/tree/DateTree.tsx`), but every measurement sits in one Measurements group below all of them, whatever date it was taken on. A volume measured on the March survey and one measured on the June survey look the same in the list, and the only way to file a measurement into a folder is the right-click "Move to folder" submenu.

The founder wants every measurement tied to the data it was measured on, filed under that data's survey date like a layer, and moved with the mouse: between its folders, and to another date, where it is measured again on that date's matching data.

## Goals

1. Every new measurement records the layer it was measured on and takes that layer's survey date. It shows inside that date's folder, next to the layers.
2. Measurement rows drag into, out of and between measurement folders. Each date has its own set of folders. Right-click "Move to folder" stays.
3. A measurement dragged onto another date folder moves there (it is not copied). Its plan shape stays and it is measured again on the target date's matching data.
4. A layer re-filed under another date takes the measurements made on it along.
5. Measurements saved before this change get a date where the app can tell which; the rest wait in a "Needs a date" group until dragged to one.

## Non-goals

- Copying a measurement to another date by drag. "Copy to another survey" in the Selected panel (`survey/MeasurementPanel.tsx` ~:412) stays as it is.
- Folders that exist with nothing in them. A folder is still just a name that measurements carry.
- Changing how layers drag between dates, beyond carrying their measurements.

## Anti-goals

- No measurement without a date, other than legacy ones waiting in "Needs a date". None can be made undated.
- No guessing the person cannot see or undo. Backfill files only clear matches, and says so with an Undo.
- No silent loss of values: a move that cannot be measured on the target date is refused, never left with blank or stale numbers that look current.
- No folders made on the person's behalf.

## Constraints

- Measurements autosave off by default: every change waits for **Save measurements** (`survey/measureStore.ts`:5), and derived numbers are written without marking the file unsaved (`setComputedResults`, :438).
- Read-only projects (a package, or a reviewer who may only look) cannot move or re-file anything (`Sidebar.tsx`:326 `canEdit`, :779 `canMeasureEdit`).
- `@aio/schema` is frozen; the new fields need a row in `docs/architecture/contract-changes.md` and the integration lead's sign-off.
- No em or en dashes in user-facing text. Renderer talks to main only through `window.aio`.

## Founder decisions

From the brief:

1. A measurement belongs to the survey date of the map or cloud layer it was measured on, set automatically when it is made, and shows inside that date's folder alongside layers.
2. Measurements drag into, out of and between their own folders, beside the right-click Move to folder. Each date has its own separate set of measurement folders.
3. A measurement dragged to another date folder moves (not copies) and is measured again on the new date's data: the geometry stays, the values are worked out again.

Answers to the first draft:

4. **Every measurement has a date.** "Whole site" goes as a choice: "Promote to the whole site" (`MeasurementPanel.tsx`:391) and the site-wide path are retired. `{ kind: 'site' }` survives only as a legacy state that backfill resolves.
5. **Measurements stay with the data they were measured on unless the person changes it.** Every new measurement records its source layer, and its date follows that layer. A date move is the deliberate change: it is measured again on the target date's matching data.
6. **A layer moved to another date takes its measurements with it**, measured again by the same rule.
7. **Antenna (telecom) measurements stay on their date.** They cannot be dragged to another date; the drop is refused with a short reason.

## My calls

From the brief:

- **No data, no move.** A move is refused with a short note when the target date has no data under every vertex.
- **Folders on a date move.** The measurement goes into the folder of the same name under the target date if one exists, else loose under that date. A folder is never made automatically.

Coordinator calls after the founder's answers and review:

- **Heights on a date move.** Every vertex is picked again on the target date's data at the same plan position, on the same kind of data it was picked on: a cloud or mesh pick stays a cloud or mesh pick, so a roof or pile-top point lands on the new date's roof or pile top, not the ground; a ground-clamped vertex takes the new ground. A vertex with no data under it on the target date refuses the whole move with a note.
- **Prepared surfaces first.** A move needs the target date's prepared surfaces. If they are not prepared, the drop offers **Prepare surfaces** instead of moving with stale results.
- **Readouts follow the measurement's date.** On-screen length, area and height readouts sample the measurement's own date, not the visible stage. In scope, as a separate task.
- **Backfill.** Legacy undated measurements are matched by height against each date's data; only clear matches are filed, with one note giving the count and an Undo. The rest sit in a temporary "Needs a date" group, the only undated state, until dragged to a date.
- **Telecom and a re-dated layer.** When the source layer of an antenna measurement moves to another date, the measurement follows the layer with its values unchanged (same data). The hand-over lists this as a call the founder can overturn.
- **Projects with no survey dates.** There are no date folders, so measurements stay in the plain Measurements group as today. The date rule applies once the project has dates, and backfill runs then.
- **Measured on an every-date layer** (a design, a basemap). The source layer is recorded; the date is the focused date, or the newest date when none is focused. It drags to any date like the others.
- **Model re-picks.** A date move loads the target date's matching layer (without showing it) to pick against. If it cannot be loaded, the move is refused with a note. The builder picks the mechanism.

My calls in this revision:

- **Map clicks.** A map pick takes the topmost shown dated raster under the cursor in that map view (DSM before orthophoto); with none, the focused date's base layer (its DSM, else its orthophoto, else its first dated layer). Its vertices count as ground-clamped.
- **Matching data on the target date.** The counterpart of the source layer: the target date's layer with the same `slot` in the capture index (kind, role and name with the date taken out, `packages/workspace/src/captures.ts`:31, :184-197). With no counterpart, a layer of the same kind; with none, the move is refused.

## Current state

**The date is already in the data model.** `SurveyMeasurement.scope` (`packages/schema/src/survey.ts`:438) is `MeasurementScope` (:406), either `{ kind: 'site' }` or `{ kind: 'survey', capture }`. The Selected panel's Scope section sets it ("Only in <date>", "Promote to the whole site", `MeasurementPanel.tsx`:377-410) through `setScope` (`measureStore.ts`:557), which also re-stores the points in the new date's line-up frame (`storedPoints`, `measureDates.ts`). But every new measurement is made with `scope: { kind: 'site' }` (`measureStore.ts`:853 for drawn shapes, `WholeSite.tsx`:231 for whole-site regions), so in practice almost all are undated.

**No source layer is recorded.** `SurveyMeasurement` has no layer field. A click in 3D raycasts the stage (`measureScene.ts`:271-282) and keeps only the hit point; the hit object carries its layer id up its parent chain (`userData.aioLayer`, set in `packages/engine/src/adapters/mesh.ts`:312, `raster.ts`:300). A map click carries only longitude and latitude (`measureScene.ts`:827-845). Vertex heights are stored as picked (E, N, Z), with nothing saying whether a vertex hit a model or was clamped to the ground.

**Captures and a layer's date.** `captureIndex` (`captures.ts`:129) maps each layer to a capture (`of[layerId]`) and gives counterparts across dates (`slot`). The sidebar reads it through `useCaptureIndex()` (`Sidebar.tsx`:301). Layers move between dates through `moveLayersToDate` and `undoDateMove` (`shell/dateFolders.ts`:32, :56).

**How values are computed.** Two paths, both in the renderer:

- Readouts (length, plan and surface area, heights, slope) come from `measurementReadout` (`packages/survey/src/tools/readout.ts`:263), computed on every render and never stored. Terrain rows sample `measureStore.surface`, the 3D stage's visible terrain (`MeasureToolbar.tsx`:83, `stageClamp` at `measureScene.ts`:196), not the measurement's date. Reports already sample one date's prepared surface (`reportPage/house/surveyData.ts`:330-375).
- Comparison results (volume, cut and fill) are stored in `results` with fingerprints and computed by the survey engine worker (`compareStore.ts`, `engine.worker.ts`, `packages/survey/src/engine`). `current` and `previous` resolve to the prepared surfaces of the measurement's own capture and the one before it (`resolver.ts`:107-126, `captureOf` at `compareStore.ts`:171). Changing the scope changes the fingerprints and the result reads **Stale, recompute** (`isStale`, :284); `computeAll` (:440) recomputes. Prepared height tiles come from the Python `survey.prepare` job (`compareStore.ts`:598-606).

**Persistence.** `<project>/survey/measurements.json`, `aio.measurements/1` (`survey.ts`:455), a loose object, read and saved by `loadMeasurements` and `saveMeasurements` (`measureStore.ts`:287, :330). `folder` is an optional trimmed string (:437); `measureFolders` (:636) lists the names across the whole file.

**Undo.** Only deletions undo (`undoDeleteMeasurements`, :510). Folder and scope changes have none beyond **Revert** to the last save (:362). Layer date moves have their own Undo in the sidebar note (`Sidebar.tsx`:960-964).

**The tree.** `buildMeasureItems` (`survey/measureRows.ts`:44-90) builds folders then loose rows over the whole file, with folder ids `measure-folder:<name>`; a survey measurement whose date is off screen is dimmed (:61). The rows render once, below the date folders, through `DateTree`'s `after` prop (`Sidebar.tsx`:296-299, `DateTree.tsx`:375-377), with no drag source. Date folders take drops of layers only (`DateTree.tsx`:122-146, `onMove` to `moveLayersToDate`, `Sidebar.tsx`:479), and rows drag only through `datableLayerIds` (`model.ts`:281-295, `DatasetTree.tsx`:544-560). Move to folder offers every folder in the file (`measureActions.tsx`:143-176).

**Date focus and visibility.** Focusing a date (`timeline.focusSurvey`, `workspace/timeline.ts`:232) swaps the layer switches from the old date to the new, keeping any extra date the person turned on. A survey measurement is drawn only while one of its date's layers is shown (`scopeOnScreen`, `packages/workspace/src/dateVisibility.ts`:72, used by `measurementsOn`, `measureDates.ts`:24); each side of a split reads its own dates. So once measurements carry dates, focusing a date already hides the other dates' measurements. No new filter is needed.

**Tests.** Unit: `measureStore.test.ts`, `measureDates.test.ts`, `measureRows.test.ts`, `measureVisibility.test.ts`, `measureActions.test.ts`, `packages/ui/src/tree/DateTree.test.tsx`, `measureTree.test.tsx`, `dateModel.test.ts`. End to end: `measurement-layers.spec.ts`, `measure-tools.spec.ts`, `date-annotations.spec.ts`, `timeline.spec.ts`.

## Proposed approach

### Data model (contract change)

Two optional fields on `SurveyMeasurement`, optional so legacy files still parse:

- `source: { layer: Id }`: the layer it was measured on (or last re-measured on).
- `pickedOn: ('model' | 'ground')[]`: per vertex, same length as `points`; `model` is a cloud or mesh hit, `ground` a terrain or raster clamp.

The app writes both on every new or moved measurement. `scope` stays as it is in the file; `{ kind: 'survey', capture }` is the only state the app creates, and `capture` must equal the source layer's date. `{ kind: 'site' }` is read as "Needs a date". **The builder adds a row to `docs/architecture/contract-changes.md`** describing the fields, that `aio.measurements/1` stays (additive, optional), and that `site` scope is legacy only.

A folder belongs to a date by grouping: the key is (date, folder name), so "Piles" under March and "Piles" under June are separate folders.

### Source layer at creation

`pick` (`measureScene.ts`:271-282) returns the hit layer id (walk parents for `userData.aioLayer`) and whether the hit was a model or the ground, beside the point. The map pick takes the layer by the map rule above. The finished shape (`drawEvent`, `measureStore.ts`:850-860) takes the first vertex's layer as `source`, its date as `scope`, the per-vertex kinds as `pickedOn`, and stores its points through `storedPoints` for that date. Whole-site regions (`WholeSite.tsx`:231) take the date and surface layer they were run on.

### Selected panel

The Scope section loses "Promote to the whole site" and "Only in <date>"; it shows the date and source layer. "Copy to another survey" stays and re-measures the copy by the date-move rule.

### Sidebar

`buildMeasureItems` takes a capture and builds that date's folders and loose rows; folder ids gain the date (`measure-folder:<capture>:<name>`). `buildDateTree` puts each date's Measurements group inside its folder, as it does each date's Annotations group; the `after` group becomes "Needs a date" and shows only while legacy measurements wait there. Filter box, eyes, counts and new-folder row work per group.

Drag: measurement rows and measurement folder rows become drag sources (`measures` props gain `dragMeasureIds` and `onDragMeasures`). `DateTree` keeps one drag state with a kind (`layers` or `measurements`). Targets for a measurement drag:

- a measurement folder of the same date: `setFolder(ids, name)`;
- the date's Measurements group header: `setFolder(ids, '')`;
- another date folder: the date move below. Telecom rows show the folder as refused, and a drop says "Antenna measurements stay on the date they were picked on."

There is no drop target for "no date". Layer drags ignore measurement targets and the reverse. Move to folder lists only the marked measurements' date's folders, and is disabled with a reason when the marks span dates. No drag starts when `canMeasureEdit` is false.

### Date move and re-measure

A store action `moveToDate(ids, capture)`, all or nothing for the dragged set:

1. Refuse telecom measurements.
2. Find the target's counterpart of each source layer (slot, then kind). None: refuse.
3. Target surfaces not prepared: the note offers **Prepare surfaces** and nothing moves.
4. Re-pick every vertex at the same plan position: `model` vertices by a vertical ray against the counterpart layer, `ground` vertices from the target date's prepared ground surface. Any vertex with no data: refuse, naming the date.
5. Apply: `scope` to the target, `source` to the counterpart, new heights, points re-stored in the target's line-up frame, folder kept if the target has that name, else cleared.
6. Mark comparison results stale and run `computeAll(ids)`.
7. One sidebar note with an Undo restoring scope, source, folder, points and results.

### Layer moved to another date

After `moveLayersToDate` succeeds, every measurement whose `source.layer` moved takes the layer's new date and is re-measured by the same rule; since the data is the same layer, heights do not change and only comparisons recompute. Telecom measurements follow with values unchanged. `undoDateMove` takes them back too.

### Readouts on their own date

A separate task: `MeasurementPanel` and tree values sample the measurement's date surface (the pattern in `surveyData.ts`:330-375) instead of `measureStore.surface`.

### Backfill

On load, for each `site`-scoped measurement, sample every date's prepared surfaces at its vertices and compare with the stored heights. Exactly one clear match (median difference under a small tolerance and clearly better than the next) files it: date, `source` to that date's best matching layer, `pickedOn` guessed per vertex. One note gives the count with an Undo. Not done in read-only projects. The rest wait in "Needs a date".

### Errors

Short notes in the sidebar note slot, no dialogs: antenna measurement refused; no matching data on the target date; surfaces not prepared (with Prepare surfaces); the matching layer could not be loaded; no data under a vertex.

## Open points for the builder

- **Explicit surface refs.** Comparison items that name a prepared surface (`{ kind: 'survey', surface }`) rather than `current` do not follow the date; decide whether a move rewrites them to the counterpart surface.
- **Stockpile projects** where the volumes own the date focus (`timeline.ts`:238): check drops and visibility there.

## Tests and end to end expected

Unit:

- `@aio/schema`: the new optional fields parse, legacy files still parse, `pickedOn` longer than `points` is refused.
- `measureRows.test.ts`: groups per date, same folder name under two dates stays separate, "Needs a date" only for legacy rows.
- `measureStore.test.ts`: source, date and per-vertex kind at creation (3D model hit, ground, map rule); `moveToDate` re-picks by kind, keeps or clears the folder, refuses telecom, missing counterpart, unprepared surfaces and a vertex with no data, and Undo restores; a re-dated layer carries its measurements; backfill files only clear matches with one Undo.
- `DateTree.test.tsx`, `measureTree.test.tsx`: measurement drag targets, no cross drops with layers, refused telecom drop, no drag in read-only.
- `measureActions.test.ts`: Move to folder lists only the date's folders and is disabled across dates.
- `MeasurementPanel.test.tsx`: no Promote to the whole site.

End to end (run the CI way, 1100 x 720 at scale 1 on WARP):

- `measurement-layers.spec.ts`: drag a row into a folder and out again, wait for Save.
- A new `measurement-dates.spec.ts` on a two-date project: draw on date A, see the row under A; focus B and the shape hides; drag it to B, its height and value change and it lands in B's same-named folder; a drop on a date without prepared surfaces offers Prepare surfaces; a telecom drop is refused; moving the source layer to B carries the measurement.
