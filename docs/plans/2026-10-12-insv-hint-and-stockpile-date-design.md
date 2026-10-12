# Raw 360 hint and stockpile reopen date: design

Date: 2026-10-12. Branch `fix/insv-hint-and-stockpile-date`. Plan: [2026-10-12-insv-hint-and-stockpile-date.md](2026-10-12-insv-hint-and-stockpile-date.md).

Two small fixes on one branch. Neither changes `@aio/schema`.

## 1. Raw Insta360 files play unstabilised: say so

### Problem

A raw camera file (`.insv`, or its `.lrv` proxy) is stitched on import by ffmpeg `v360` with a fixed 195 degree dual-fisheye guess (`packages/project/src/import/stitch.ts`). The camera's gyro data in the file trailer is not read, so the walk plays with every shake of the walk in it. On 12 Oct the founder decided: ship a hint now; real gyro stabilisation comes later as a `walk.process` pipeline step.

### What the user sees

- **Import panel.** When an import has at least one raw camera file with status `imported`, the panel shows one notice line under the heading, above the file list:

  > Raw 360 camera files play unstabilised. For a steady picture, export the clip from Insta360 Studio with FlowState on and add that MP4 with **Add 360 video**.

  `data-testid="import-raw-360-hint"`. One line per import, however many raw files it had. Not shown when the raw file was skipped, failed or cancelled, and not for a stitched MP4 or MOV.

- **360 video pane.** In the pane bar, beside the walk's name (where **Low resolution copy** already shows), a faint label **Not stabilised** for a walk whose source layout is not `equirect` (it was stitched from a camera file). Its `title` (tooltip) carries the same sentence as the import hint. `data-testid="walk-unstabilised"`. A walk added from a stitched MP4 shows no label.
- **KNOWN-LIMITS.** The "360 video: stitch" line says the picture is not stabilised because the camera's gyro data is not read yet, and names the workaround (Insta360 Studio, FlowState, export MP4, **Add 360 video**).
- **User guide.** `docs/guide/08-building-projects.md`, section "360 video from a 360 camera": a line in the notes saying raw files play unstabilised, with the same workaround.

### How it is decided

- Import panel: a pure helper `rawCameraImported(items)` over the import result's `ImportItem`s (file name by extension `/\.(insv|lrv)$/i`, status `imported`). The import result already carries the file name and status, so nothing in main or the schema changes.
- Pane: a pure helper `walkUnstabilised(walk)`, true when `walk.source.layout !== 'equirect'`. The layout is always written; the walk record's `trailer?` flag is optional and only says the trailer mark was found, so it is not used to decide.
- Strings go in `packages/ui/src/i18n/en.ts` (`walk.unstabilised`, `walk.rawHint`) and both surfaces read them with `t()`, so the sentence is written once.

## 2. Stockpile projects do not reopen on the saved survey date

### Root cause (confirmed by reading the code)

Two independent faults, both in `apps/desktop/src/renderer/workspace/`.

**A. The volumes' default date overrides the saved one.** `@aio/volumetric`'s `load()` always starts on the last survey (`epoch: epochs.at(-1)`, `packages/volumetric/src/store.ts`). `connectVolumeDates` (`volumeDates.ts`) then mirrors the volumes' survey into the date bar. Two orders happen on open, and both lose the saved date:

1. Date bar attaches first (the usual order: `useTimelineSync` runs in an effect, the volumes load over IPC). `attach` focuses the saved date (`initialFocus(index, pref.focus)`). When the volumes turn `ready`, `sync()` hands them the layers (`setVolumes`) and then calls `mirrorFocus(<last survey>)`, which moves the focus to the last survey **and persists it**, overwriting the saved date in storage.
2. Volumes ready first. `attach`'s volumetric branch focuses whatever the volumes show (`vol.epoch()`, the last survey) and ignores `pref.focus`.

So a stockpile project always reopens on its last survey, and the saved date is gone after the first open.

**B. Two stores share one storage key.** `timeline.ts` saves the date prefs under `stratlas.timeline` (`TIMELINE_KEY`, a map of project id to `DatePref`). `timelinePref.ts` saves whether the timeline is shown, also under `'stratlas.timeline'` (a map of project id to boolean). Whenever the user shows or hides the timeline (T, the thin bar, the palette), `timelinePref` rewrites the key with its booleans, wiping every project's saved date; the date store's loader then drops the booleans as malformed. The other way round, every date change rewrites the key with date prefs, so the shown-or-hidden choice is lost on the next start. This hits every project type, but stockpile projects most: they have no video, so their timeline starts hidden and people toggle it.

### Fix

- **A.** The saved date wins over the volumes' default when the volumes take over the project:
  - In `connectVolumeDates`, when the volumes become ready for a project and the date bar is already attached to it with a focus the volumes have (`epochOf(focus)`) and that differs from what they show, ask the volumes for it (`setEpoch`) instead of mirroring their default. The volumes' change comes back through the existing subscription and `mirrorFocus` is a no-op.
  - In `timeline.attach`'s volumetric branch, prefer `pref.focus` when the volumes have it: focus it and call `vol.setEpoch(epoch)`.
  - Unchanged: no saved date, or a saved date the volumes do not have, falls back to the volumes' survey (the last one). While the compare split is open the volumes follow the 3D pane's date (`useVolumesFollowDate`), so `connectVolumeDates` does not push the saved date then.
- **B.** `timelinePref` moves to its own key `stratlas.timeline.shown`. On first start after the update it reads the boolean entries from the old key once (the date store ignores booleans, so nothing else changes), and from then on writes only the new key.

No change to `@aio/volumetric`: loading the volumes on a given epoch would be a cross-package change for the same result.

## Decisions taken (founder to confirm)

The founder was not available during scoping; each question below was answered with the recommended option.

1. **Where does the raw-file hint show?** Both: one line in the import panel after the import, and a persistent **Not stabilised** label with a tooltip in the 360 video pane. The panel is dismissed after the import; the label stays with the walk, so whoever opens it later learns why it shakes.
2. **Wording and spelling.** British spelling, as the app and the docs use ("stabilised", "colour"): "Not stabilised" and the sentence above. "FlowState" as Insta360 writes it.
3. **Which files trigger it?** `.insv` and `.lrv` (anything stitched in the app), decided by the walk's layout (`insv-dual-stream` or `dual-fisheye`), not by the optional `trailer` flag. A stitched MP4 never shows it, even when it came from Insta360 Studio without FlowState (we cannot tell).
4. **Hint, not a block or a setting.** The import goes ahead as today; there is no "don't show again". It is one quiet line.
5. **Saved date versus the volumes.** The date the user left the project on wins, as on every other project type; the last survey is only the default when nothing is saved or the saved survey is gone.
6. **Also fix the shared storage key (fault B).** It is a second cause of the same symptom and a one-file fix; leaving it would make fix A look flaky.
7. **Migration of the shown-or-hidden choice.** Read the boolean entries from the old key once; no cleanup of the old key (the date store owns it).
8. **No schema or IPC change**, so no row in `docs/architecture/contract-changes.md`.

## Out of scope

- Gyro stabilisation, horizon levelling and lens calibration from the trailer (later, `walk.process`).
- Any change to the stitch itself.
- Remembering the volumes' other choices (base, swipe, surface) across reopen.

## Risks

- The new stockpile e2e builds a minimal stockpile project in the test (a manifest, `volumes.json`, tiny GLB terrains, no height grids). If the volume worker needs the grids before the store reports `ready`, the fixture writes small grids as the volumetric unit fixtures do; the plan's Task 7 says how to check.
- A user who had both a saved date and a hidden timeline before the update keeps whichever of the two was written last under the old key; the other is lost once. Acceptable for an internal build.
