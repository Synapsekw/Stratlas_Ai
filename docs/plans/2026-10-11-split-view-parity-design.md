# Split view parity: design

Date: 11 Oct 2026. Branch: `fix/split-view-parity`.

## The problem

In a split that compares two survey dates, the two sides do not show the same things. The founder's example: on a stockpile project the left view can be coloured by elevation, the right view cannot. The request is one way of showing every measurement and control on both sides.

The cause is structural. The split has one fully wired 3D view (the main stage) and one main map. The second 3D view (`CompareScene.tsx`) and the second map (`CompareMap` in `CompareControls.tsx`) are reduced copies mounted with `primary={false}`. Every overlay, legend and tool binds to the single active stage (`@aio/engine` registry) or the single active map (`@aio/maps`). Three things follow:

1. The volumetric overlay (`VolumetricScene`, mounted by `VolumetricStage`) exists once, on the main stage, and draws the survey the volumetric store names (`shownEpoch()`). The second view gets no pile bodies, no toe lines, no surface colours and no legend. Under **Cut / fill** the store names the last survey, whose terrain the main view hides while it shows another date, so the left view loses its colours too.
2. Saved survey measurements are attached once to the main stage and once to the active map (`MeasureLayer`), so the second view and the second map draw none.
3. The point cloud legends and the change heat map legend are mounted in the main panes only, and the point cloud ones read the counts of every view added together.

## Scope

**Phase 1 (built on this branch): display parity** for two 3D views and two maps.

**Phase 2 (designed below, not built here): interaction parity**, a focused pane for the pointer tools, and designs, haul road and terrain overlays on both views.

Not in scope: the default split of a 3D view beside a map. The map has no elevation display of its own. What that would take is in the last section.

No `@aio/schema` change. No new IPC.

## Phase 1 design

### A view has its own survey

`VolumetricScene` takes an optional view description:

```ts
export interface VolumetricView {
  /** Draws only: no boundary edit, no swipe clipping (the second view of a comparison). */
  display?: boolean;
  /** May a drape texture of `bytes` be made? Absent: always. */
  budget?: (bytes: number) => boolean;
}
```

and a `setEpoch(epoch | null)` method: the survey this view shows. Null keeps today's rule (the store's `shownEpoch()`), so a single 3D view behaves exactly as before. With an epoch set, the view uses it everywhere it used `shownEpoch()`: which piles have a body, which toe ring is drawn, which terrain the surface colours are draped on, and the heights of the section line.

The surface switch (`surface`), the elevation ramp and range (`elevation`), the body mode, the selected pile and the shown piles stay single values in the volumetric store. One toolbar drives both views; only the date differs per view. This is the "shared setting, per view date" the brief asks for and needs no store change.

**Cut / fill.** The change colours are one raster (first to last survey). Each view drapes it on the terrain of its own date. The change bodies are the same on both views; their toe line is draped on the view's own survey so it does not sink into or float over the ground of the other date (`VolumeCompute.scene`: the toe heights come from `req.epoch` also in change mode; a single view always asks for the last survey there, so nothing changes for it).

**Display mode.** The second view's scene skips the boundary edit drawing and the swipe clipping (the swipe needs both terrains in one view). `VolumetricStage` in display mode mounts no handles, no swipe divider, no section panel, no edit bar, no toast and no keyboard handler. It claims a click only to select a lifted body's pile, as the main view does, and never while a section is picked or a boundary is edited. The section line itself is drawn on both views (it is a line across both surveys).

**Where the epoch comes from.** `VolumetricStage` gets `epoch`, `display`, `layerVisible` and `budget` props. The main pane passes the epoch of the date its pane shows whenever the split gives it one (`useCaptureEpoch(capture)` in `compare.ts`), the second view passes its own. The second view's hand-copied "hide the flat ortho" loop in `CompareScene` goes away: the scene controller already does it, and now also hides the toe lines baked into the terrain model there.

### Legends

Each view that shows a colouring carries its legend, in the same place as on the main stage (the legends are positioned inside their pane, so mounting the same component in the second pane puts it where the left one is).

- **Stockpile surface (elevation, cut and fill, body and toe keys).** The ramp and range are shared by both surveys (one automatic range over every survey, one hand-set range), so the numbers are the same on both sides. The left legend keeps the controls (ramp, range, hillshade). The right view shows the same legend read only: title, ramp, the three range figures, and the body and toe keys. The "click a pile" hint is not repeated on the right.
- **Point cloud elevation and classification.** `usePointcloudCounts`, `useElevationRange` and `useClassificationLegend` take an optional view: with it they read that view's clouds only. Each view's automatic elevation range is its own, so each side shows the range it actually draws. A single 3D view keeps the summed counts as before.
- **Point cloud change and change heat maps.** `ChangeLegend` (`@aio/pointcloud`) takes the same optional view; `ChangeLegends` (heat maps) takes the pane's scoped store, so a side shows the legend only when it shows the layer. Both are mounted in the second 3D view; the heat map legend also in the second map.

### Survey measurements

`attach3d(stage, frame, opts)` and `attachMap(ctl, frame, clampZ, opts)` take `{ display?: boolean; dates?: StoreApi<Workspace> }`.

- `dates` is the store whose survey dates decide which measurements show: the view's scoped store. A site-wide measurement shows on both sides; a measurement of one survey shows on the side that shows that survey. Without a scope (a single view) the scoped store is the workspace itself, so nothing changes outside the split.
- `display` draws the saved measurements, their labels and a drawing in progress, and attaches no pointer or keyboard input and no vertex handles.

The second 3D view and the second map each attach a display copy for their own view (`useMeasureDisplay` in `survey/measureDisplay.ts`). The main view and main map pass their own scoped stores (`primaryScene`, `primaryMap`), which fixes a side effect of the old rule: in a comparison the left view drew the measurements of whatever date the layer tree had on, not of the date it showed.

### Graphics memory

`COMPARE_GPU_BYTES` (`compare.ts`) is the memory two 3D views may use together, per tier. Until now only the end to end test read it. The second view's drape now asks first: `budget(bytes)` gets the size of the texture it would upload (width x height x 4; the drape reuses the terrain's geometry) and answers from `memoryEstimate()` of both stages against the tier's limit. When the answer is no, the drape is not built, the view keeps the survey photo, and the pane shows one line: "Not enough graphics memory to colour this view. It shows the photo." The refusal is remembered per survey and colouring so the worker is not asked again every frame; it is asked again when the colouring or the date changes.

## Decisions taken without the founder

1. **Per view dates for measurements**, also on the main view (see above), rather than every measurement on both sides whatever its date. It follows the existing rule (a survey's measurements go with its date) and matches how issues are drawn per side.
2. **Read-only legend on the right** for the stockpile surface. The controls stay on the left because the setting is shared; two sets of sliders for one value would look like two settings.
3. **Cut / fill is draped on each side's own terrain**, the same colours on both. The alternative (colours only on the last survey) left one side uncoloured.
4. **A lifted body can be clicked on the right view** to select its pile. Selection is already shared; nothing can be edited from the right view.
5. **Phase 2 is not built** on this branch.

## Phase 2 design: a focused pane

Today `getActiveStage()` and `getActiveMap()` answer "the main one". The pointer tools (ruler, section, survey measure tools, annotation, map drawing) attach to that one.

Proposal:

1. **A pane registry** in the renderer (`workspace/panes.ts`): each 3D pane and map pane registers `{ side, kind, stage | map, store }` on mount. `compareRuntime.second` and `compareRuntime.maps` become views of it.
2. **Focus.** `FocusZone` already marks the pane the keyboard is in. Add pointer focus: the pane under the pointer on `pointerenter` (kept while a button is down, so a drag that leaves the pane stays with it). The focused 3D pane and the focused map pane are published as `focusedStage()` and `focusedMap()` with a subscribe, next to the engine's and the maps' own "active" getters, which stay as "the main one" for everything that must not move (video, the agent, saved views).
3. **Tools follow focus.** `attach3d` and `attachMap` already separate drawing from input after phase 1. Each pane keeps its display attach; the input half attaches to the focused pane and moves with it. A drawing in progress keeps its points (they are site coordinates, not pane coordinates), so a line can start on the left date and end on the right. Terrain clamping uses the focused view's terrain; a measurement made on a pane with a date takes that date as its scope.
4. **The stage's own tools** (`stage.setTool('measure')`, section planes): mirror the tool to the second stage as `mirror()` already mirrors the section, and let the engine's measure tool report its points to a shared model, or retire it in favour of the survey distance tool. This is the largest open part and needs a look inside `@aio/engine`.
5. **Annotation.** `AnnotationToolbar store={primaryScene}` draws on the main scene. With a focused pane it takes that pane's store and stage; a sighting is saved on the layer under the pointer, which already carries its date.
6. **Designs, haul road, terrain overlays.** `DesignsMount`, `HaulRoadMount` and `attachOverlaysMap` take a stage or a map. The same split as for measurements applies: a display attach per pane, input on the focused one. Each adds GPU memory on the second stage (design surfaces, the overlay raster), so each goes through the same `budget` gate.

Order: registry and focus (small), survey measure tools (medium, mostly done by the phase 1 split), overlays and designs display (medium), annotation (medium), engine tools (large). Each step can ship on its own.

## The default split (3D beside a map): elevation on the map

Not built. The map draws orthos and vectors; it has no elevation colouring unless a terrain overlay was computed (**Survey measurements**, **Terrain overlays**). To give the map side of a stockpile project the same Photo, Elevation and Cut / fill switch:

1. Ask the volume worker for the same rasters the 3D drape uses (`reliefRaster(epoch, style)`, `changeRaster()`), turn them into an image (canvas to blob URL) and add them to the map as a MapLibre image source with the four corners of the survey grid (`grid()` gives origin, size and resolution; `@aio/geo` converts the corners to longitude and latitude). One image layer above the ortho of the date the map shows.
2. Mount the read-only legend from this branch in the map pane.
3. Follow the map pane's date as the 3D views now do, and rebuild on a ramp or range change (debounced; the 3D drape already swaps only when the new one is ready).

About two days with tests; no schema change. For projects without the stockpile data the terrain overlays already do this once computed, so the remaining gap there is only that they are attached to the main map (phase 2, step 6).
