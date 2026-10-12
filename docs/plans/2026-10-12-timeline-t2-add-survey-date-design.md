# Timeline T2: add a survey date

Status: spec written 12 Oct 2026 by a scoping session; the founder approved the spec, the plan and
the decisions under "Decisions taken" on 12 Oct 2026. Plan:
`docs/plans/2026-10-12-timeline-t2-add-survey-date.md`. Parent design:
`docs/plans/2026-10-07-timeline-design.md` (T1 merged).

## Intent

Construction progress is flown weekly or monthly. The founder's use cases are progress review and
monthly reporting: every flight must land in the project as its own survey date, with every layer
it brings filed under that date, so the T1 date folders, date bar and calendar show the project's
real history. Today the user cannot do that on purpose:

- A survey date cannot be created by hand (north star).
- The import already reads the day of each photo (EXIF `DateTimeOriginal`) and video (DJI SRT
  clock) and quietly adds a survey date per day (`addCapture` in
  `packages/project/src/builder/raw.ts`), but it does not file the layers under it. They land in
  **Every date** next to an empty date folder.
- All photos of every import go into one project-wide `photos` layer, so two flights' photos
  cannot be told apart by date.
- A folder cannot be imported: `builder:import` takes files only, so a flight folder needs every
  file picked by hand.
- The import step's **Survey date** select (`renderer/builder/SurveyDate.tsx`, built on
  `renderer/change/SurveyDate.tsx`) hides itself below two dates and only lists dates that exist.
  The string `change.surveyDateNew` ("New survey date") is unused.
- Projects imported before this (the reference construction project: one survey date, five video
  layers and a photos layer, none filed) keep their datasets in Every date.

Success: a founder drops a flight folder on a project, sees "6 Nov 2024 (new survey date, read
from the files)" in the import card, can change it in one step, and finds every dataset of that
flight in the 6 Nov folder. An empty date can be added from Datasets. An older project offers once
to file its recorded datasets under their days.

## What exists and is reused

| Piece                                                             | Where                                                            | Use in T2                                        |
| ----------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------ |
| `captureForDate`, `ensureCapture` (find or add the date of a day) | `packages/project/src/builder/create.ts`                         | Import, Add survey date, New survey date         |
| `builder:ensureCapture` IPC                                       | `packages/schema/src/ipc.ts`, `apps/desktop/src/main/builder.ts` | Add survey date, New survey date, the prompt     |
| `builder:updateCapture` (label, colour, icon)                     | same                                                             | Name typed in Add survey date                    |
| `builder:updateLayers` with `{ capture }`, `setLayersCapture`     | `renderer/change/SurveyDate.tsx`                                 | Re-dating an import                              |
| `moveLayersToDate`, `undoDateMove`, the Datasets note with Undo   | `renderer/shell/dateFolders.ts`, `Sidebar.tsx`                   | The one-time prompt                              |
| `mergeImport` (keeps a date a filed layer names)                  | `packages/project/src/builder/importMerge.ts`                    | Unchanged: already handles layers with `capture` |
| `daysOfItems`, `pickSurveyDate` (photo days)                      | `renderer/photogrammetry/surveyDate.ts`                          | Pattern for the day reading                      |
| `timeline.focusSurvey`                                            | `renderer/workspace/timeline.ts`                                 | Focus a date just added                          |
| `dialog:openFolder`                                               | `packages/schema/src/ipc.ts`                                     | Import a flight folder                           |

## Design

### 1. One import, one survey date (main, `@aio/project`)

`importRawFiles` changes how it dates what it imports:

- It collects the local day of every dated file it reads: a photo's `takenAt` day, a video's start
  day (`startUtcMs` plus the import's UTC offset, as the layer name already uses).
- After the files are read, **the import's day** is the day most dated files carry (one file, one
  vote; a tie goes to the earlier day). Only that day gets a survey date (`captureForDate`: the
  existing one for that day, else a new `capture-<date>` labelled "Survey"). Today's per-day
  `addCapture` calls go.
- **Every layer this import creates gets `capture` set to that date**, dated or not: an ortho,
  model or point cloud dropped with the flight belongs to that survey. A pipeline job (point cloud,
  large raster, OPF, drawing, design) is out of reach here: its layer is written later by the job
  and stays undated; the user files it with drag or Move to date (known limit).
- Photos are filed in **the photos layer of that date**: the photos layer whose `capture` is the
  import's date, else a new one (`photos-<date>`, named "Photos", `capture` set). The project-wide
  `photos` layer is only used for photos of an import with no day at all (no dated file), as today.
- An import with no dated file adds no date and tags nothing (today's behaviour).
- Walks (360 video) do not write the manifest and are not layers: unchanged.

`mergeImport` already keeps a date that a filed layer names, so a job writing the manifest at the
same moment does not lose the date.

### 2. Folders in an import (main)

`builder:import` and `builder:altitudePlan` accept folder paths. Main expands every folder before
the import starts, so the progress total counts files:

- Recursive, entries sorted by path, dot files and dot folders skipped, symlinks not followed.
- From a folder, only files with an extension the import knows are kept (photos, video, SRT, GLB,
  OBJ and textures, GeoTIFF, point clouds, DXF and drawings, OPF, designs). The rest (DJI `.LRF`
  proxies, `.txt`, `Thumbs.db`) are left out and summarised in one `skipped` row per folder:
  "12 files in FLIGHT_202411 are not data this app imports (.LRF, .txt)." Files picked one by one keep
  today's per-file rows.
- A folder holding more than 20,000 files is refused with a message (one row, `error`) instead of
  starting.
- A folder dropped on the window works the same way (the drop handler already passes the path).

No schema type changes: `paths` is still `string[]`. The doc comment of both channels says
"files or folders". Recorded in the contract-changes row (behaviour change).

### 3. The import card's Survey date (renderer)

`SurveyDateSelect` works with any number of dates (0, 1 or more) and gains **New survey date...**:

```
Survey date  [ 6 Nov 2024 · Survey (new)            v ]
             Read from the photos and video.
```

- Options: **Not dated**, each existing date oldest first ("6 Nov 2024 · Survey"), then
  **New survey date...**.
- The import card shows it whenever the import has imported layers. Its value is what the layers
  carry, so after a dated import it already shows the import's date. A faint line under it says
  where the date came from when the import set it ("Read from the photos and video.", "Read from
  the photos.", "Read from the video.").
- Picking **New survey date...** swaps the select for an inline row: a date field (prefilled with
  the import's day, else today), **Add** and **Cancel**. **Add** calls `builder:ensureCapture`, then
  files the layers there (`setLayersCapture`). A day that already has a date files them under that
  date.
- **Tidy up**: when the layers leave a date that this import created and that is now empty, that
  date is removed (`builder:removeCapture`, below). A date that existed before the import is never
  removed. The card knows which dates the import created by comparing the captures before and
  after the import (renderer state only).
- The Selection card's **Belongs to date...** uses the same select, so it also shows with zero or
  one date and offers **New survey date...** (no tidy up there: the date it leaves was not made by
  it).
- Read-only (package, look-only reviewer): disabled, as today.

### 4. Add survey date in Datasets (renderer)

A calendar-plus icon button in the Datasets header, after **Add data** and the drawing button
(`aria-label` "Add survey date"). It opens a small popover anchored to the button, in the style of
the date folder menu (`dmenu`), not a modal:

```
Add survey date
  Date  [ 2026-10-12 ]
  Name  [ Survey      ]   (optional)
  [ Add date ]
  ------------------------------
  Import a flight folder...
  The date is read from the files.
```

- **Add date**: `builder:ensureCapture(date)`; if a name was typed and the date is new,
  `builder:updateCapture` with that label; then the date is focused (`timeline.focusSurvey`) and the
  popover closes. The new folder is empty and greyed (T1 rule) until datasets are dragged or
  imported into it. If the day already had a date, the popover closes, that date is focused and the
  Datasets note says "6 Nov 2024 is already a survey date."
- Date field: defaults to today; a date in the future is allowed (a planned flight). Enter in a
  field submits; Escape closes and returns focus to the button.
- **Import a flight folder...**: closes the popover, opens the folder dialog (`dialog:openFolder`,
  title "Import a flight folder") and imports the folder (section 2). The date comes from the files
  (section 1) and is changed in the import card (section 3).
- With zero dates the tree is type-first (T1). After the first date is added it switches to the
  date-first tree with that one folder, focused.
- Hidden in a package and for a look-only reviewer (the same rule as **Add data**).
- Ctrl+K gains **Add survey date...** (opens the popover) and **Import a flight folder...**.

### 5. One-time prompt for recorded datasets in Every date (renderer)

When a project opens and has datasets that **carry their own recording day but sit in Every
date** (no `capture`, and not filed by a date in their name), a note shows once at the top of the
Datasets list:

```
6 datasets in Every date were recorded on survey days.
5 go under 4 Sep 2024, 1 under a new date, 5 Sep 2024.
[ File them ]  [ Not now ]
```

- Counted: photos layers with dated items (the day most of their photos carry) and video layers
  (their start day in the project's local time, from the flight's `startUtcMs` and the project's
  default UTC offset, the same rule the import uses). Models, maps, point clouds, drawings and
  designs have no recording day and are left alone: a design must not be dated by guess.
- **File them**: for each day, `builder:ensureCapture` (adds a missing date), then
  `moveLayersToDate` for that date's layers. Afterwards the usual note reports the result; when all
  went under one date it offers **Undo** (the existing note and `undoDateMove`).
- **Not now** or **File them** ends the prompt for that project on this machine (localStorage
  `stratlas.datePrompt`, per project id, like the timeline pref). It never comes back for that
  project, even if more undated datasets appear (new imports date themselves).
- Not shown in a package or to a look-only reviewer, and not while an import is running.
- Works with zero dates too: it creates them, and the tree switches to date-first.

### Visual direction

The app's existing restrained system, no new look: the popover reuses the `dmenu` surface, rows and
focus ring; the prompt reuses `.dtree-note` (status tone, not danger); the import card's row reuses
`.survey-date` and `.input`. One new icon (`calendar-plus`) in `packages/ui/src/icons/paths.tsx`,
drawn on the same 24 px grid and stroke as `folder` and `plus`. Copy is sentence case, plain verbs,
no em dashes, and each action keeps its name through the flow ("Add date" adds a date; "File them"
reports "Filed 6 datasets").

## Decisions taken (approved by the founder, 12 Oct 2026)

The founder was not available to the scoping session. Each was answered with the recommended
option, and the founder approved them all on 12 Oct 2026:

1. **One import is one survey date.** Files from several days in one import all go under the day
   most of them carry, instead of one date per day. A flight folder is one survey; the date can be
   changed in the import card. (Alternative: one date per day, which splits a survey flown across
   midnight or over two days.)
2. **Every layer of a dated import is filed under its date, undated kinds included** (an ortho or
   model dropped with the flight). Pipeline jobs that write their layer later stay undated.
3. **Photos get one photos layer per survey date**, instead of the single project-wide photos
   layer. Existing projects keep their photos layer as it is.
4. **Re-dating an import removes the empty date it created**, which needs one new IPC channel,
   `builder:removeCapture` (refused when any layer still names the date). Without it every
   corrected import would leave a stray empty folder behind.
5. **Folders are expanded in main, recursively, keeping only known data files**, with one summary
   row per folder for what was left out, and a 20,000 file limit per import.
6. **"Add survey date" lives in the Datasets header as a popover** with a date, an optional name and
   "Import a flight folder...", plus two Ctrl+K commands. No modal, no wizard.
7. **The one-time prompt only covers photos and video**, the datasets that carry a recording day.
   Models, maps and drawings are never dated by guess. It is shown once per project per machine.
8. **A future date is allowed** in Add survey date (planning the next flight).
9. **Two dates on the same day stay out of scope**: Add survey date on a day that has a date
   focuses that date (the existing `captureForDate` rule), it does not create a second one.

## Contract change

One additive change in `@aio/schema`, plus a behaviour change on two existing channels:

- New IPC channel `builder:removeCapture`: `{ projectId, captureId }` to `{ ok: true, manifest,
backup }` or `{ ok: false, error }`. Removes the capture from `manifest.captures` only when no
  layer's `capture` names it; refused otherwise, for an unknown id and on a package. Journalled
  like `builder:updateCapture` so Undo in the edit history works.
- `builder:import` and `builder:altitudePlan`: `paths` may name folders (expanded in main).
- `builder:import`: the layers it creates carry `capture` (the import's day). No type changes, no
  manifest version change; older builds read `capture` since M8.

Row text is in the plan (task 13).

## Edge cases

- Import into a project with no dates: the import adds the first date; the tree switches to
  date-first with that folder focused (T1 behaviour on a manifest change).
- Import of undated files only (a design model): no date, layers in Every date, the card's select
  shows **Not dated** and offers the dates and **New survey date...**.
- A photo without `DateTimeOriginal` in a dated import: filed with the rest under the import's day.
- Re-dating to **Not dated**: layers lose `capture`; the date the import created is removed if
  empty.
- A job (maps from photos) writing the manifest during the import: `mergeImport` keeps the date
  the import's layers name (existing rule).
- Cancelled import: what was imported is filed under the import's day (computed from the files read
  before the cancel).
- Large folders: the expansion is a directory walk without reading file contents; 20,000 files is
  far above a flight (a few hundred to a few thousand).

## Testing

- Unit, `@aio/project`: majority day, tie to the earlier day, every created layer tagged, photos in
  the date's photos layer (existing or new), undated import unchanged, cancelled import filed;
  folder expansion (recursion, dot entries, unknown extensions summarised, limit); `removeCapture`
  (removes an empty date, refuses a named one, unknown id).
- Unit, `@aio/geo`: default UTC offset from the project origin.
- Unit, `@aio/workspace`: recording day of a photos and a video layer; the prompt's plan (which
  layers, which days, existing or new date, name-dated layers left out).
- Unit, renderer: the select with 0, 1 and 3 dates; New survey date flow and tidy up; Add survey
  date popover (submit, existing day, name, Escape, read-only hidden); prompt (shown once, File
  them, Not now, persisted, hidden in a package).
- Unit, main: folder expansion in `builderImport` and `builderAltitudePlan` (progress total, summary
  row), `builderRemoveCapture`, journal entry.
- e2e: new `apps/desktop/e2e/survey-dates-add.spec.ts` (flight folder import with a new date and a
  re-date, Add survey date by hand, the one-time prompt). Re-run `builder.spec.ts`,
  `timeline.spec.ts` and `project-types.spec.ts`, which import or add dates.
- TESTING.md: a Timeline T2 stage. User guide: `docs/guide/28-survey-dates.md` gains "Adding a
  survey date".

## Out of scope

Two dates on one day, removing a date that still has datasets (Datasets "Remove date" on a folder),
reading dates from GeoTIFF or model metadata, dating pipeline-job layers on arrival, splitting an
existing mixed photos layer by day, T3 compare and T4 reporting.
