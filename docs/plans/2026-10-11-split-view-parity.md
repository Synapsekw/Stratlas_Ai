# Split view parity: implementation plan

**Goal:** In a split that compares two survey dates, both 3D views and both maps show the same things: surface colours, pile bodies and toe lines, legends and saved survey measurements, each side for its own date.

**Spec:** `docs/plans/2026-10-11-split-view-parity-design.md` (phase 1 is built here; phase 2 is design only).

**Tech stack:** TypeScript, React, three.js, MapLibre, zustand, vitest, Playwright with Electron.

## Global constraints

- Work only in the worktree `.claude/worktrees/split-view-parity`, branch `fix/split-view-parity`.
- Two sibling branches each add a pane kind in `workspace/splitModel.ts` and `workspace/SplitPanes.tsx`: this plan does not edit either file.
- No `@aio/schema` change, no new IPC channel.
- A single 3D view and a single map must behave exactly as before: every new parameter is optional and its absence keeps today's code path.
- User-facing text: plain words, no emoji, no em or en dashes. No client, site or person names anywhere.
- Heavy commands (check, demos, Playwright, commits) go through the shared one-at-a-time runner.

## Execution DAG

```
T1 compute: toe on the view's survey ─────────────┐
T2 scene controller: per-view survey, display ────┼─> T3 VolumetricStage props, ──┐
                                                  │      read-only legend, notice │
T4 pointcloud: per-view counts and legends ───────┼───────────────────────────────┼─> T6 panes ─> T7 e2e
T5 survey: display attach, per-view dates ────────┘                               │      │
                                                                                  │      └─────> T8 docs
```

- **Batch A (parallel, no shared files):** T1, T2, T4, T5.
- **Batch B:** T3 (needs T2's `VolumetricView`).
- **Batch C:** T6 (needs T3, T4, T5).
- **Batch D (parallel):** T7 (needs T6), T8 (needs T6's final wording).
- **Critical path:** T2, T3, T6, T7.

The tasks are small and the heavy runner is shared with other sessions, so one agent builds them in this order rather than dispatching subagents: T1, T2, T3, T4, T5, T6, T7, T8.

## Tasks

### T1: Change bodies' toe line on the view's survey

- **Package:** `@aio/volumetric` (`src/model/compute.ts`).
- **Change:** in `scene()`, change mode, the toe is draped on the DSM of `req.epoch` instead of always the last survey. The change body itself is unchanged.
- **Tests:** `src/model/compute.test.ts`: a change-mode request for the first survey returns toe heights of the first survey; for the last survey the result is what it was.

### T2: `VolumetricScene` per view

- **Package:** `@aio/volumetric` (`src/scene/controller.ts`, `src/index.ts`).
- **Change:** optional `VolumetricView` (`display`, `budget`) as a fourth constructor argument; `setEpoch(epoch | null)`; `onDrapeRefused(listener)`. The view's survey replaces `shownEpoch()` in `updateBodies`, `updateSection` and `wantedDrapes`. Display mode skips `updateEdit` and `reconcileSwipe`. A refused drape is remembered per survey and colouring.
- **Tests (new `src/scene/controller.test.ts`, a fake stage around a real three.js scene and a fake volume service):**
  - without a view epoch the elevation drape is built for the store's survey (as today);
  - with `setEpoch('e2')` while the store shows `e1`, the drape is `drape:e2` on the `e2` terrain, and the bodies are requested for `e2`;
  - under `change` each view drapes its own survey;
  - display mode draws no edit line while the store has an edit;
  - a budget that refuses builds no drape, tells the listener once, and does not ask the worker again on the next frames; changing the colouring asks again.

### T3: `VolumetricStage` for a second view

- **Packages:** `@aio/volumetric` (`src/components/VolumetricStage.tsx`, `src/components/styles.tsx`), `@aio/ui` (`src/i18n/en.ts`: `vol.compare.noDrape`, `vol.legend.readOnly`).
- **Change:** props `epoch`, `display`, `layerVisible`, `budget`. Display mode: no handles, swipe divider, section panel, edit bar, toast or key handler; click claiming only selects a lifted body; a read-only legend (`data-testid="vol-legend-view"`); the one-line notice (`data-testid="vol-no-drape"`) when a drape was refused.
- **Tests:** covered by T2's unit tests (scene) and T7 (the component in the app). `pnpm --filter @aio/volumetric exec tsc --noEmit`.

### T4: Point cloud legends per view

- **Package:** `@aio/pointcloud` (`src/stats.ts`, `src/ElevationLegend.tsx`, `src/ClassificationLegend.tsx`, `src/ChangeLegend.tsx`).
- **Change:** `usePointcloudCounts(view?)`, `useElevationRange(store, view?)`, `useClassificationLegend(store, view?)`, `ChangeLegend` prop `view`. With a view: that view's clouds only. Without: every view, as today.
- **Tests:** `src/stats.test.ts` (new): `countsOf(byScene, view)` returns one view's counts, empty counts for an unknown view, the total without a view.

### T5: Survey measurements, display attach and per-view dates

- **Package:** `apps/desktop` renderer (`survey/measureScene.ts`, `survey/measureDisplay.ts` new, `survey/MeasureToolbar.tsx`).
- **Change:** `attach3d` and `attachMap` take `{ display?, dates? }`; measurement objects are named `measure:<id>`; `useMeasureDisplay3d(stage, store)` and `useMeasureDisplayMap(ctl, store)`; `MeasureLayer` passes `primaryScene` and `primaryMap` as `dates`.
- **Tests:** `survey/measureScene.test.ts` (new): `measurementsOn(state, dates)` keeps site-wide measurements on every view and a survey's on the view that shows it.

### T6: The panes

- **Package:** `apps/desktop` renderer (`workspace/compare.ts`, `CompareScene.tsx`, `CompareControls.tsx`, `Stage.tsx`, `MapSwipe.tsx`).
- **Change:**
  - `compare.ts`: `useCaptureEpoch(capture)`, `drapeAllowed(used, bytes, tier)`.
  - `CompareScene`: mounts `VolumetricStage display` with its epoch and the budget, the point cloud legends for its view, the change legends for its store, the display measurements; the hand-copied ortho loop is removed.
  - `CompareMap`: display measurements and the heat map legend for its store.
  - `Stage.tsx`: `ScenePane` gets the pane's date (`capture`), passes its epoch to `VolumetricStage` and, when the pane has a date, reads the point cloud legends for its own view. No other change.
  - `MapSwipe.tsx`: `ChangeLegends` takes an optional store.
- **Tests:** `workspace/compare.test.ts`: `drapeAllowed` against each tier's limit.

### T7: End to end

- `e2e/compare.spec.ts`, synthetic two-date project (runs in CI): seed `survey/measurements.json` with one site-wide measurement and one per date; after **Compare dates** the main view draws the site and January ones, the second view the site and June ones (`__stratlas.compare().second`, objects named `measure:<id>`).
- `e2e/volumetric-build.spec.ts` (runs in CI where the pipeline Python is present): after the project opens, **Compare dates** with **Elevation** on: `drape:e1` on the main stage and `drape:e2` on the second, the read-only legend in the second pane; **Cut / fill**: both drapes again; clicks reach the second view's canvas beside the legend (`document.elementFromPoint`).
- `e2e/compare.spec.ts`, `@realdata` stockpile test: the same drape assertions on the real surveys, a seeded measurement on the second 3D view and the second map.
- Neighbours rerun unchanged: `stage-display.spec.ts`, the real-data stockpile spec, `measure-tools.spec.ts`.

### T8: Docs

- `docs/KNOWN-LIMITS.md`, `docs/guide/04-compare-dates.md` ("What works on which side"), `docs/TESTING.md` (compare steps): what shows on both sides now, what is still left view only.
- `node tools/agent/check-public-text.mjs` on the docs written.

## Contract changes

None. `@aio/schema` is not touched.

## Amendments made during the build

- **T3:** one new string only (`vol.compare.noDrape`). The notice is a line inside the second view's legend box, not a box of its own, so it can never lie over the pane's date selector.
- **T5:** the rule "which measurements a view draws" went into its own small module, `survey/measureDates.ts` (`measurementsOn`), tested in `survey/measureDates.test.ts`. `measureScene.ts` pulls in the measurement store and three.js, which a unit test of one pure function should not need.
- **T5:** `attachMap` now waits for the map to settle once when its style is not loaded yet. The main map was redrawn by later events; a map that only draws got none, so the second map stayed empty (found by the new end to end test).
- **T6:** the two point cloud legends moved from `Stage.tsx` into `workspace/StageLegends.tsx`, so the second view can mount them without importing `Stage.tsx` (which imports the second view). `CloudChangeLegend` takes the same optional view.
- **T7:** the synthetic measurements check is a test of its own in `e2e/compare.spec.ts` (3D views, then two maps) instead of more steps in the existing synthetic test; both share one project writer.

### After the review

- **Refused restyle.** A drape a view already holds is replaced by its restyle, so only the memory beyond what it holds is asked of the budget; a restyle of the same size is never refused. Should a refusal still come with a drape present, the drape is removed, so the view shows the photo its legend says it shows.
- **A second view on a date without volumes** draws no bodies, toe lines, section line or surface colours and shows no legend. The main view still falls back to the survey the volumes panel shows.
- **End to end:** the synthetic measurements test has its own 180 s timeout and 30 s polls; the legend's "does not take clicks" check is polled; the surface switch helper retries the look and the click together, in case the toolbar folds in between.

## After the last task

`pnpm check` green, the specs above green the CI way (1100 x 700, software renderer, every demo built), then `node tools/agent/finish-task.mjs`.
