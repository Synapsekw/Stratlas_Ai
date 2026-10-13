# Walk placing by start and end: design

Status: approved by the founder in brainstorming, 13 Oct 2026. Builds on the W2 spec (`2026-10-12-walk-layer-and-placing-design.md`) and replaces its placing flow; the fit, the calibration and the pose file stay.

## Why

The founder found Place walk unintuitive and clunky, never saw the walk's shape while placing, and got a perfectly straight line between the two clicks. The investigation (13 Oct) showed the fit is sound: replaying a real processed walk through `fitWalk` with two pins keeps a 9.7 m bow over a 60 m chord. The straight line came from placing a walk whose processing had been interrupted (the app closed at 31 %): with no `raw-path.json` the layer has no `path`, `loadWalkInputs` returns no inputs and the fit falls back to pins only (`buildPinsOnly`), with only a small note in the strip.

The goal is placing the way DroneDeploy does it: the path's shape is already known from the video, the user sets a start and an end, and the app places, rotates and scales the whole shape between them, with full edit and delete afterwards.

## What the founder chose

- Interaction style A: the whole shape follows the cursor between the clicks; two draggable handles after; Remove placement; the correction pins move to an optional Fine-tune.
- Surfaces: the 2D map, drawings and the 3D scene. The Globe is out of scope.
- Approach 1: a placement stays a start pin and an end pin (plus optional fine-tune pins); only the interaction changes.

## The flow

1. **Path check.** Place walk first checks that the walk has a computed path. If processing never ran, is running, failed or was interrupted, a notice says so and offers **Process walk** (or **Process again**), with a plainly labelled secondary **Place between two points anyway** for walks that will never process. No silent straight line.
2. **Surface.** Map, 3D or a drawing (the existing `placeSurfaces` order, with 3D added; the map only with a coordinate system, 3D always). The surface fills the stage with a slim placing toolbar; no 360 pane and no video scrubbing.
3. **Ghost.** Before the first click a faint copy of the whole levelled shape follows the cursor, its first point under the cursor, scaled at about 0.7 m per step, heading as the raw path has it.
4. **Start.** A click sets the start pin (`t = walking.startT`). From then on the whole outline is fitted live between the start and the cursor, so it rotates and scales as the cursor moves.
5. **End.** A click sets the end pin (`t = walking.endT`). The walk is placed as a draft.
6. **Handles.** Start and End are round handles that can be dragged; the shape refits live during the drag.
7. **Toolbar.** A hint for the current step, the survey date field (only when the walk has none), **Save**, **Cancel**, **Fine-tune**, **Remove placement**. Fine-tune opens the 360 pane beside the surface with today's tools: Pin here, Align view, the heading field, pin Move and remove.
8. **Edit later.** The walk row gets **Edit placement**, which reopens the handles on the surface the walk was placed on (for `@model`: the map when the stage shows the map, otherwise 3D).
9. **Delete.** **Remove placement** (row and toolbar, inline confirm) clears the placement and keeps the walk. **Remove walk** is unchanged.

The map and 3D share the model frame, so a walk placed on either shows on both. A walk placed on a drawing shows on that drawing.

## Data

No contract change.

- 3D pins use the existing `MODEL_SURFACE` (`@model`): `at = [x, z]` in the model frame and `y` the clicked height, the same frame the map uses.
- `placedOn` stays `@model` for the map and 3D, the drawing's layer id for a drawing.
- Remove placement sends the existing `{ walk: null }` patch (`packages/project/src/builder/create.ts`), which drops `place` and `flight`.
- Start and end pins keep their video times (`walking.startT`, `walking.endT`; 0 and `durationS` when the raw path has no `walking`).

## Units

1. **Preview maths** (`packages/geo/src/walk/preview.ts`, pure):
   - `previewPath(raw, start, cursor)`: the levelled shape fitted between the start and the cursor through the existing two-point similarity; returns the polyline in surface coordinates.
   - `ghostPath(raw, cursor, metresPerUnit)`: the shape anchored at the cursor at about 0.7 m per step. On a drawing `metresPerUnit` comes from the drawing's scale; when it has none the ghost uses a fixed on-screen length.
2. **Placing state** (`apps/desktop/src/renderer/walks/placeStore.ts`): phases `check`, `start`, `end`, `placed`, `fine-tune`; `hover(at, y?)` drives the preview; `dragHandle('start' | 'end', at, y?)`; `removePlacement()`; the date as a field, not a step. The 5 m minimum shows live in the hint while hovering, not as a refusal after the click. `y` is kept for map and 3D pins.
3. **Path readiness** (`placeModel.ts`): `walkPathState(layer, jobs)` returns `ready`, `none`, `running`, `failed` or `interrupted` from the layer's `path` and the walk's latest `walk.process` job; drives the notice.
4. **Map interaction** (`packages/maps`): a pointer session on the controller with hover-move events, click and drag of named handles (camera pan paused while dragging), replacing the one-shot `pickPoint` for placing. Walk overlays update their GeoJSON sources in place during hover and drag.
5. **Drawing interaction** (`WalkSheetOverlay.tsx`): hover-follow before each click; the handle drag that exists today stays.
6. **3D layer** (`apps/desktop/src/renderer/walks/walkScene.ts`, after the measure tool's `attach3d`): the path as a ground line at the height of the clicked points (heights between the start and end interpolated by time), Start and End handles, hover preview through `stage.raycast`, clicks through `stage.claimClicks`, handle drag with `controls.enabled = false`, depth test off and a raised render order. Placed walks are drawn faintly when not being edited.
7. **Toolbar and row actions** (`PlaceWalkStrip.tsx` reshaped into the toolbar; `DatasetTree.tsx` and `Sidebar.tsx` for **Edit placement** and **Remove placement**; `placeWalk.ts` for opening the 3D surface and the remove flow).

## Errors

- Start and end closer than 5 m: the hint says so while hovering and the click is ignored.
- Cancel or close with unsaved changes asks "Keep these changes?" as today.
- A fit error shows its reason in the toolbar and keeps the draft.
- A walk whose path appears while placing (processing finishes) refits on the next hover; a path that disappears (walk reprocessed) ends the session with a notice.

## Tests

- Unit: each unit above (`preview.test.ts`, `placeStore.test.ts`, `placeModel.test.ts`, the maps controller pointer session, `WalkSheetOverlay.test.tsx`, `walkScene.test.ts`, `PlaceWalkStrip.test.tsx`, the tree row actions).
- e2e, rewritten: `apps/desktop/e2e/walk-place.spec.ts` for the drawing flow: start, end, drag a handle, save, Remove placement.
- e2e, new: `walk-place-map.spec.ts` (the walk fixture gains a coordinate system) and `walk-place-3d.spec.ts`. Each places the fixture walk and checks the saved pose has the fixture's known bend (the L shape of `tools/fixtures/walk-truth.mjs`), not a straight line.
- e2e, new case: an unprocessed walk shows the path notice and offers Process walk, and draws no line.

## Also in this branch: stitched 360 import

Founder, 13 Oct 2026. A stitched 360 export (an equirectangular MP4 or MOV, by its spherical metadata or a 2:1 frame) is recognised as a walk on every import route (drop, Add data, folder import), not only through **Add 360 video**: an MP4 or MOV without a drone's SRT is read first, and a stitched one becomes a walk. A 16:9 video without an SRT is still skipped, and its reason now names Add 360 video. A drop made while an import runs or is being prepared is queued, with a note, instead of being dropped silently. Every import says for each file where it went ("Added as a walk under 360 walks", "Added to Datasets, Video", "Skipped: why") or why it failed. Task 13 of the plan; no contract change (`ImportItem` is unchanged).

## Out of scope

- Restoring a removed walk's processed files from `.trash` when the same video is imported again (a follow-up).
- The Globe; the rest of W3 (map dot and view cone, click-to-seek, world-locked view).
- A width-stretch handle (option B in brainstorming).
