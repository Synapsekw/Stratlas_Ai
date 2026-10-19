# Measurements as layers in the Datasets sidebar (design)

Draft, 18 Oct 2026, for the founder's review. Branch `feat/measurement-layers`. The mockup was shown in the brainstorming session: a Measurements group in the left tree, folders, right-click menus in the tree and in 3D.

## Why

Saved measurements today live only in the Measure workbench ("Saved in this project", `survey/MeasurementList.tsx`). To hide, recolour or rename one you open the workbench, find it in the list, select it and then edit it in the Selected panel. Measurements don't show up where the rest of the project's data is (the Datasets tree on the left), they can't be right-clicked anywhere, and you can't click them in 3D or on the map at all (their geometry raycast is switched off, `survey/measureScene.ts` ~:313/:337).

The founder wants each measurement to behave like a layer, so it is quick to turn on and off, edit and file into folders.

**The principle (founder):** the left sidebar holds everything the project contains, and the right workbench holds the tools for making and analysing things.

## Goals

1. **A Measurements group in the Datasets tree** (`packages/ui/src/tree`). It sits after "Maps and rasters" and before "Photos". This position is my call.
   - Each measurement is a row showing its colour swatch, label, primary value (for example `42.18 m`, `118.4°`, `312 m²`, formatted the way the list formats it today) and an eye.
   - Measurements with a `folder` are grouped under a collapsible folder row, using the same grouping as `groupByFolder` in `packages/survey/src/tools/list.ts`. Measurements without a folder sit directly under the group.
   - The group header and each folder row get an eye that hides or shows everything inside, with mixed state (`VisibilityEye`).
2. **Per-measurement visibility, personal and remembered.** A hidden measurement stays hidden after the project is closed and reopened, on this computer, for this user only (founder: "only for me"). Hiding is a viewing preference, not an edit. It never touches `measurements.json`, never marks the file unsaved, never adds a History/journal entry and never hides anything for anyone else.
3. **Right-click menu** on a measurement row. The items, in this order, come from the founder:
   - Rename (inline, F2)
   - Colour (preset swatches)
   - Hide/Show
   - Fly to
   - Move to folder
   - Delete

   It works through the existing actions registry (`packages/ui/src/actions`) with a new `MenuTarget` kind for measurements. The keyboard menu (Shift+F10 / Menu key) works as it does for layers.

4. **The same menu when you right-click the measurement's shape in 3D or on the map.** This follows the screen-space hit-test pattern in `pins/PinMenu.tsx` (project candidate points and segments to the screen, test the cursor within a few pixels, `claimEvent`). A left-click on a shape selects that measurement (selection in the tree and the Selected panel follow).
5. **Multi-select.** With several measurement rows marked (the tree's existing marks), the menu applies Hide/Show, Colour, Move to folder and Delete to all of them. Rename and Fly to apply to the clicked one only. This is my call, following how layer actions treat `multi`.
6. **Remove "Saved in this project" from the Measure workbench** (`MeasureBench.tsx` ~:833-853). The bench keeps the drawing tools and the Selected panel (`MeasurementPanel.tsx`) for detailed editing: vertices, description, custom fields, scope, full style.
   - Anything the old list could do that the tree can't yet do moves to the tree or is dropped on purpose. See "What the old list did" below.

## Non-goals

- Manual drag-to-reorder of measurements within a folder. The tree sorts by label within a folder (my call). Moving a measurement means moving it to a folder.
- Nested folders. `folder` stays a single string.
- Merging measurement visibility into `workspace.hidden` (the layer visibility map). Measurements keep their own state in `measureStore`. The tree just reads and writes it.
- Changes to how measurements are drawn, styled or computed. Changes to telecom/antenna rows.
- A shared custom colour picker component. The menu offers presets, and the Selected panel keeps the native picker.

## Anti-goals (would make this a failure even if it works)

- The tree gets slow or jumpy on a project with hundreds of measurements.
- Right-click in 3D steals clicks from drawing or vertex editing. While a measure tool is active or a measurement is being edited, the 3D/map menu stays off and clicks go to the tool as they do today.
- Hiding a measurement marks the file unsaved, saves it, or shows up in History.
- Two eyes for the same thing (one in the tree, one somewhere else) that disagree.

## Constraints

- **Repo rules:** worktree only, `pnpm check` green, e2e run the way CI runs it. No contract change is expected, because there is no schema or IPC change. Public text must not contain client or site names.
- **No schema change.** Visibility lives in the renderer's `localStorage`, keyed by project id. This follows the existing per-project view-state pattern (`lineup/lineUpStart.ts`, with the guarded `storage()` accessor). The value is a list of hidden measurement ids, plus the group's all-hidden state if the builder needs it.
  - `measureStore.hiddenMeasurements` and `measurementsVisible` stay as view state. They are loaded from storage when a project opens and written back on every change.
  - The group eye replaces "Show all / Hide all".
  - Ids that no longer exist are dropped on load.
  - If storage is unavailable, visibility works for the session only.
- **Saving.** Eye clicks don't affect saving. Rename, Colour, Move to folder and Delete are ordinary measurement edits. They mark the file unsaved and save with Save measurements (or autosave when it is on), as they do today.
- **Read-only projects and packages** (`writeMeasurements` refuses packages): visibility works and is remembered, because it is personal view state. Rename, Colour, Move to folder and Delete are disabled in the menu (via `Action.disabled`).
- **Date line-up.** Survey-scoped measurements already hide when their date's layers are hidden (`measurementsOn` in `survey/measureDates.ts`). That rule stays. A measurement hidden because its date is hidden shows its row dimmed but keeps its own eye state. When the sidebar shows the date tree (`DateTree.tsx`), the Measurements group still appears once at site level, not split by date (my call). The row's meta shows the survey date for survey-scoped ones.
- **Labels allow 200 characters** (`label` max 200). The tree's `RenameField` caps at 80. Inline rename for measurements uses a 200 cap (a prop on `RenameField`).
- **The 3D renderer rebuilds the whole measurement group on each store change** (`measureScene.ts` ~:584). Picking must not depend on stable three.js objects. Hit-test against the measurements' projected points and segments, as PinMenu does, instead of re-enabling three.js raycast.
- **Coordination:** the antenna-review session (`feat/antenna-review`) touches `MeasureBench.tsx` (one line, the AntennaSection) and may extract pure helpers from `measureScene.ts`. It is building a shared "frame this box/point" camera helper. Use that for Fly to if it lands first; otherwise use the existing Fly to path in `MeasurementList` `ItemMenu` (~:484).

## What the old list did, and where it goes

| Old list (`MeasurementList.tsx`)    | After                                                              |
| ----------------------------------- | ------------------------------------------------------------------ |
| Show all / Hide all                 | Group eye in the tree                                              |
| Per-row eye                         | Row eye in the tree                                                |
| Folders                             | Folder rows in the tree                                            |
| Bulk select, Move to folder, Delete | Tree marks + right-click menu                                      |
| ⋯ menu: Fly to, Delete              | Right-click menu                                                   |
| Click a row to select               | Click a tree row to select (Selected panel follows)                |
| Search                              | Tree's existing filter, if it has one; otherwise dropped (my call) |
| Sort (newest/oldest/name/tool)      | Dropped; tree sorts by label (my call)                             |
| Filters (by tool etc.)              | Dropped (my call)                                                  |

`MeasurementList.tsx` and its test are deleted if nothing else uses them.

**What stays in the bench (my call).** These live in the old "Saved in this project" section but are not list chrome. They stay in the Measure bench as a compact "Saved" footer under the Selected panel:

- the Autosave checkbox
- Revert
- the three-state status line ("Unsaved changes" / "New results not saved yet" / "All saved") with its Save button
- the load-error notice
- the read-only package notice
- `<BulkTotals />`, which keeps working on the tree's marked polygons

**What used to open the list (my call).** `setListOpen(true)` on finishing a shape (measureStore ~:694/699), and the telecom card's "Measurements" button (`TelecomTools.tsx:126`), now reveal the measurement in the tree instead. That means expanding the Measurements group and its folder, scrolling the row into view, and making sure the left sidebar is open. `listOpen` goes away.

## Decisions from the builder check (my calls)

- **Drawing and editing don't unhide.** `startTool`, `addMeasurement` and `startEditing` no longer force everything visible. Hidden measurements stay hidden while drawing. A measurement being vertex-edited is drawn while it is edited, as `measurementsOn` does today. A newly added measurement is visible. Since hiding never edits the file, nothing here can mark it unsaved. Drawing tools do not snap to hidden measurements.
- **Mixed marks.** When the marked rows mix layers and measurements, right-clicking a measurement row acts on the marked measurements only, and the layer marks are ignored. Right-clicking a layer row acts on the layers only. Marks keep one set, but measurement ids are namespaced (for example `measure:<id>`) so the two can't collide.
- **Clicks in 3D and on the map.** Within the hit tolerance, pins, photo markers and drone hits keep priority, because they are smaller point targets. A measurement beats layer/ground picking. A left-click on a measurement selects it and brings the Measure tab forward (today's `measureFollow` behaviour). A click on empty ground clears the measurement selection. None of this runs while a tool is drawing or a vertex is being edited.
- **Telecom measurements** (azimuth, tilt, clearance…) get tree rows like any other measurement and the same menu. Their value column uses the existing telecom readout, including "Invalid picks". Nothing about how they are drawn or computed changes.
- **Views in scope:** the main 3D view and the main map. Split, compare and display-only panes draw measurements as today but get no click or menu handling this round.

## Move to folder

The submenu lists existing folders, "No folder" and "New folder…". "New folder…" asks for a name inline (in the tree, as a new folder row in rename mode) and moves the selection into it. A folder exists while at least one measurement is in it. Renaming or deleting a folder row is out of scope for this round. Dragging measurement rows onto a folder row is in scope only if the tree's existing drag support takes it cheaply; otherwise it is deferred. Both are my call.

## Colour presets

Six to eight swatches, including the default measure yellow `#ffd166`. They are drawn with `SubItem.swatch` in the actions registry. Picking one sets `style.color`, and `fill` too when it was equal to the old colour. The exact palette is the builder's call, taken from the app's tokens where possible.

## Left to the builder

- The data shape for measurement rows in `buildDatasetTree`: a new group kind `measurements` with `TreeItem`s that carry a measurement id (like annotation rows that have no `layerId`), or a separate subtree component.
- The action ids, sections and icons. The pixel tolerance for 3D/map hit-tests. How the tree rows get the primary value (reuse whatever the list uses).
- Wiring selection between tree, store and panel.
- Tests:
  - unit tests for the tree model, actions, hit-test and visibility storage
  - updating `MeasureBench.test.tsx`
  - an e2e spec that hides a measurement in the tree, checks the file is not marked unsaved, reopens the project and checks it is still hidden, and right-clicks a shape in 3D to open the menu.

## Open questions

- None. The builder check's one question for the founder (shared or personal visibility) is answered: personal.
