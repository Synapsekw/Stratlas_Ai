# Maps from photos: the right survey date, and the project by name (design)

Date: 11 Oct 2026. Branch: `feat/photo-maps-project-and-date`.

## What the founder asked for

1. "The moment we process the map, it's tied to a specific project and it lands right away in the datasets. I don't have to do it myself."
2. "Is there a way to make this a little bit more intuitive so that we know exactly what we are processing and for which project?"

The first already holds for the project (a run lives in the project's `photogrammetry/<run>/` and its layers are written into the manifest when it finishes) but not for the survey date: the wizard's **Survey date** starts on "None", so the new layers land under no date unless the person opens **Options**.

## Scope

In this branch:

- The wizard works out the survey date from the photos and creates it when the project has none for that day.
- The wizard and the run panel name the project the maps are added to.

Not in this branch: the Jobs screen. Another session ("Jobs tab intuitiveness") is redesigning it so that jobs belong to the open project. This branch does not edit `screens/Jobs.tsx`, `jobTasks.ts` or `jobTaskActions.ts`, adds no navigation to the Jobs screen, and keeps `photoUi.openWizard()` and `openRun()` as they are. This branch lands first.

Not in this branch either: the processing tools (the Python pack). Nothing in the pack changes, so no pack update is needed.

## Behaviour

### The survey date

The estimate that sizes up the photos already reads the head of up to 300 of them. It now also counts the day each was taken (the local date in the photo, the same date an import files photos under).

The wizard picks a date by itself, in this order:

1. The photos are a layer of the project that already belongs to a survey date: that date.
2. The day most photos were taken has a survey date in the project: that date.
3. That day has no survey date yet: a new one for that day.
4. No photo carries a date: none.

The simple screen says what was picked, under the photo summary:

- `Survey date: 14 Mar 2026` (an existing date; its name follows when it is not the default "Survey")
- `Survey date: 14 Mar 2026 (new)`
- `No survey date. These photos carry no date. Choose one in Options.`

When the photos come from more than one day, one more line: `The photos are from 3 days. Most are from 14 Mar 2026.`

**Options**, **Survey date** keeps the list of the project's dates and "None", and gains `New: 14 Mar 2026` when the photos' day has no date yet. What the person chooses there wins over the automatic pick, also when they choose other photos afterwards.

### When the new date is created

Just before the maps are built, not when the run starts. Matching the photos can take hours and can fail or be cancelled; a date created at the start would then sit in the project empty. The date is created (or found, if it appeared meanwhile) right before the map-building job starts, and the layers carry it from the moment they are added.

If the date cannot be created, the maps are still built and land under no date, as today. The results panel says which date the layers went under, so this is never silent.

A new date is named "Survey", as an import names one. It can be renamed from the Datasets list as any other.

### Ground control first

With **I have ground control points** ticked, the run stops after matching and the person starts the maps later from the run panel. Today that start forgets the survey date chosen in the wizard. The wizard's pick is now kept with the run for the rest of the session and used by that **Create maps** button. After a restart of the app the pick is gone and the layers land under no date; the person files them from the Datasets list. (Keeping it across restarts would need a change to the pack's run file.)

**Create maps again** on a finished run is unchanged: the pack keeps the date the run's layers already have.

### The project by name

- Wizard header, under the title: `Project: <name>`.
- Wizard footer, when nothing is missing: `The maps are added to <name>.`
- Run panel header: the line under the title starts with the project's name.
- Results: `Added to <name> under 14 Mar 2026 as new layers:`, or `Added to <name> as new layers, under no survey date:`.

## How it is built

| Piece                 | Where                                                            | What                                                                             |
| --------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Photo days            | `main/photogrammetry.ts`                                         | `readPhotoSet` counts `takenAt` days; `estimateRun` puts them out as `photoDays` |
| Contract              | `@aio/schema`                                                    | `PhotoEstimate.photoDays?`; IPC `builder:ensureCapture`                          |
| Find or create a date | `@aio/project` `ensureCapture(root, date)`                       | shares one helper with the import's `addCapture`                                 |
| IPC handler           | `main/builder.ts`, `main/index.ts`, `preload`, `main/journal.ts` | refused on a package; journaled like `builder:updateCapture`                     |
| The pick              | `renderer/photogrammetry/surveyDate.ts` (new)                    | pure functions: the automatic pick, its sentence, the Options list               |
| Carrying the pick     | `renderer/photogrammetry/store.ts`, `actions.ts`                 | `PendingProducts.captureDate`, a per-run pick, `startProducts` ensures the date  |
| Screens               | `ProcessWizard.tsx`, `RunPanel.tsx`                              | the lines above                                                                  |
| Guide                 | `docs/guide/28-processing-photos.md`                             | the survey date and the project lines                                            |

## Contract changes

Both additive. One row in `docs/architecture/contract-changes.md`.

- `PhotoEstimate` gains the optional `photoDays`: `{ date, photos }[]`, at most 366, most photos first. Older builds ignore it.
- New IPC channel `builder:ensureCapture`: `{ projectId, date }` to `{ ok: true, manifest, captureId, created }` or `{ ok: false, error }`. Refused on a package. Journaled like `builder:updateCapture`.

## Edge cases

- A folder of several flights on several days: the day with the most photos wins and the wizard says so. One run makes one set of layers, so it can only go under one date.
- A flight over midnight: same rule.
- Large folders: days are counted on the sample of 300 and scaled, like the camera groups.
- TIFF photos: their heads are not read today, so they count as "no date".
- Two survey dates on the same day: the first one in date order is used.
- A read-only package: the wizard is already blocked there.
- The project is closed and another opened before matching finishes: the maps start for the run's own project folder as today; the date is created in that project only if it is still the open one, else the layers land under no date.

## Tests

- `@aio/project`: `ensureCapture` creates a date in date order, finds an existing one without writing, refuses a malformed date.
- `@aio/schema`: `photoDays` parses and stays optional; the new channel is registered.
- Main: `readPhotoSet` counts days; the estimate carries them; the `builder:ensureCapture` handler; the journal records it.
- Renderer: `surveyDate.test.ts` for every row of the pick, the sentences and the Options list.
- End to end, `photo-process.spec.ts`: the wizard names the project and the new date; after the run the date exists, the layers are under it and the results say so.
