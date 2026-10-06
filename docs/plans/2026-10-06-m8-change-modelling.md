# M8 Change and modelling

> Draft, 6 Oct 2026. Starts when M7 is merged and CI on `main` is green on Windows and macOS. Test steps go into stage M8 of `docs/TESTING.md`. Version 0.8.0 at the start of M8 (one minor per milestone). Pipeline pack 0.3.0.

**Goal:** Stratlas shows what changed between two capture dates for every layer type and turns the change into findings a person confirms. It builds 3D models from drawings and point clouds with agent help (BLD-11). It finds defects with a local ONNX model (BLD-10). It runs the agent on a local model with no data leaving the machine (AI-9 completed). All of it works offline and is tested on synthetic data only.

## Global constraints (principles)

- **Offline first.**
  - Change detection, model fitting, ONNX detection and the local agent make no requests, except to a loopback model server the person set up.
  - A non-loopback "local" address counts as cloud (`isLoopbackUrl`, existing rule).
- **A person decides.**
  - Change items, fitted model parts, ONNX detections and agent proposals all start as drafts.
  - Nothing changes an issue's status, severity or geometry until a person confirms it.
  - "Resolved" never closes an issue on its own (founder decision 6).
- **Never modify delivered data in place.**
  - Change results are new files (`change/`, derived layers) and new layers with `derived` provenance.
  - Every writer backs up and swaps atomically (`.bak`). Packages stay read-only.
- **Contracts are additive.**
  - Every schema change is an optional field, a new file schema, a new channel or a new pipeline name.
  - Each gets a row in `docs/architecture/contract-changes.md` before it merges.
  - An M7 build opens an M8 project and shows the derived layers as ordinary layers.
- **No client data, ever.**
  - Tests, fixtures, the demo and screenshots use only the seeded synthetic generator (C8) and procedural pytest fixtures.
  - `check-no-client-data` runs in CI on every artifact C8 produces.
- **Licences.**
  - No GPL or AGPL in customer builds: no Ultralytics code, and no model exports whose licence forbids it.
  - Pipeline pack dependencies stay MIT, BSD, Apache or PSF (`pyproject.toml` rule).
  - Every model file carries a model card with an SPDX licence.
- **Heavy work off the UI thread.**
  - Rasters, clouds, meshes and fitting run in the pipeline pack (JSON-RPC jobs, resumable, inputs hashed).
  - ONNX inference runs in an Electron utility process.
  - Issue, vector and pose comparisons run in the data utility process or a worker.
- **Tests.**
  - Windows stay off-screen (`STRATLAS_USER_DATA`) and e2e runs with `--workers=1` locally.
  - The zero-network guard stays on. Tests that need a loopback server use `AIO_NETWORK_GUARD_ALLOW`.
  - Two-view tests pin the Medium tier (as `compare.spec.ts` does).
  - `pnpm check`, `pnpm test:e2e` and `uv run pytest` must be green before each merge.

## Review focus

- **Registration.**
  - Two dates that are slightly misaligned must not show as change everywhere.
  - Every raster, cloud and mesh comparison reports how well the dates line up and refuses to run when the misalignment exceeds a stated tolerance.
- **Shadows and lighting.**
  - Sun angle, seasonal tint or exposure differences between orthos must not flood the change mask; the synthetic "lighting only" region must stay clean.
- **Scale.**
  - A 500 M point COPC pair computes cloud-to-cloud distance in bounded memory (tiled, streamed by octree level). Progress, cancel and resume work.
  - A two-date view of change layers holds the Medium-tier budget.
- **Local models on ordinary hardware.**
  - With a CPU-only local LLM, the agent stays responsive (streaming, cancel, clear timeouts).
  - ONNX detection on 300 photos on integrated graphics finishes without starving the UI.
- **Model files from outside.**
  - A corrupt, oversized or wrong-layout ONNX file, or a DXF with unknown units, blocks or huge coordinates, gives an exact error and never crashes main.
- **Package and player mode.**
  - Change sets and procedural models travel in packages and are read-only there.
  - Nothing in player mode starts a computation.

## Step 0: C0 contracts (serial, about 2 hours, integration lead)

Before the fan-out, one agent writes every contract below in `packages/schema` (new files `change.ts`, `procmodel.ts`, `inference.ts`; additions to `layers.ts`, `annotation.ts`, `ipc.ts`, `jobs.ts`).

Alongside the contracts, C0 adds:

- every new channel to `apps/desktop/src/preload/index.ts`;
- a stub handler per channel in `apps/desktop/src/main/index.ts` that answers "not available yet", in its own module file per stream;
- every new pipeline to `python/src/aio_pipelines/pipelines.py` as a stub step that raises `JobError("not implemented")`;
- the change-set writer `python/src/aio_pipelines/change/changeset.py`, which C2, C3 and C4 share;
- data-conventions sections 14 to 16 and the rows in `contract-changes.md`;
- an empty `packages/change` and `packages/modelling` with their public API and a failing test;
- `docs/architecture/SPEC.md` section 2 rows for the two new packages.

Tag `contracts-m8` when green.

## Streams

| Stream                                         | Scope                                                                                                                                                                                                                                                     | PRD                 |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| C1 Change core                                 | Change sets and register; explicit layer-to-date links; change of issues, detections and map vector layers; Changes panel; "Show changes" in Compare dates; make an issue from a change; agent tools `compare_captures` v2, `list_changes`, `show_change` | FUS-12, AI-5, ANN-8 |
| C2 Imagery and surface change                  | Ortho change (`change.raster`), DSM or point cloud volume change (`change.surface`); change heat maps and polygons as derived layers; map and ortho swipe and blend in the split                                                                          | FUS-12, REV-3       |
| C3 Point cloud and 3D model change             | Cloud-to-cloud distance (`change.cloud`) as a COPC with a Distance field; diverging colour mode, legend and threshold; 3D model deviation and model-part diff (`change.mesh`)                                                                             | FUS-8, FUS-12       |
| C4 Video and photo same-view change            | Pose-matched frame and photo pairs across dates; Frames compare pane with swipe and blend; optional `change.frames` writing draft change detections                                                                                                       | FUS-4, FUS-12       |
| C5 Models from drawings and point clouds       | DXF import (`drawing.import`), primitive fitting (`model.fit_cloud`), procedural model contract, TS mesher to GLB, Model builder screen, agent modelling tools on the `build` route                                                                       | BLD-11, BLD-2, AI-3 |
| C6 Local ONNX detection                        | onnxruntime in a utility process; detector model cards and import; tiled inference, NMS, class mapping; results as draft `source: 'model'` passes in the review; mask assist moves to the same runtime                                                    | BLD-10, BLD-5       |
| C7 Local AI agent                              | Local model server discovery, capability check, compact tool profile, tool-call repair, chat-only fallback, Offline agent preset; local vision for detection and narrative; optional local-server key in the OS vault                                     | AI-9, AI-1, AI-3    |
| C8 Synthetic data, fixtures and the M8 harness | Two-date synthetic site with known differences and `truth.json`; DXF plan; scan for modelling; operator-built ONNX test detector; pytest fixture generators; extended client-data check; e2e fixtures for two-date projects                               | Global constraint   |

### C1 Change core

**Owns:**

- `packages/change/**` (new): `register.ts`, `issues.ts`, `detections.ts`, `vector.ts`, `pairs.ts`, `store.ts`, `ChangePanel.tsx`, `overlay.ts`
- `packages/workspace/src/captures.ts`
- `apps/desktop/src/main/change.ts`
- `apps/desktop/src/renderer/change/**` (new)
- `apps/desktop/src/renderer/workspace/CompareControls.tsx`, `compare.ts`, `splitModel.ts`, `SplitPanes.tsx`
- the survey-date picker in `apps/desktop/src/renderer/builder/**` (import step only)
- `packages/ai/src/change-tools.ts` (new) and `compare_captures` in `analysis-tools.ts`
- `apps/desktop/e2e/change-core.spec.ts`

**Scope:**

- **Explicit layer dates.**
  - `Layer.capture` (C0) wins over the naming heuristics in `captureIndex`. The order becomes: explicit `capture`, then volumes hints, then names.
  - The import step gains a "Survey date" choice (existing captures, or a new one), which sets `capture` on the new layers.
  - A layer menu entry "Belongs to date..." uses `LayerPatch.capture`. This delivers the "align survey dates" part of BLD-3.
- **Change sets.**
  - Load, merge and review `aio.change/1` files (`<project>/change/<id>.json`, one per date pair and producer).
  - The register lists every item of the chosen pair by kind (issue, detection, vector, region, component, frame) and verdict, with filters and sort.
  - A click flies to the item in the main view, and in both views while comparing.
  - Review: confirm, dismiss, note. **Make issue from change** creates a draft issue with the right sightings, the `to` capture and `track`, and links it on the item (`review.issueId`).
- **Issue change (TypeScript).**
  - Issues are assigned to dates by `Issue.capture`; without one, by their sightings' layer dates, then by `createdAt` against capture dates.
  - They are matched across dates by class and 3D distance of the mesh or point cloud sighting (back-projected when only image sightings exist, using `annotate/crossview`), within `max(0.5 m, 2% of the model height)`.
  - Size comes from measurements, else the sighting geometry (patch area, polygon area, box size placed in metres).
  - Verdicts:
    - `new`: on the later date only;
    - `resolved`: absent on the later date where that date's layers saw the place, otherwise `not-seen`;
    - `grown` / `shrunk`: area beyond threshold;
    - `worsened` / `improved`: severity level change;
    - `unchanged`.
  - Matched issues share `track`, which is written only when the person confirms.
- **Detection change.**
  - Detection passes are assigned to dates through their photos layer's capture.
  - Counts per class and zone per date; matched pairs by placed position when the inspection pipeline placed them, else by photo-pose pairing from C4's helper once C4 merges.
  - Until then, detection change is per class and zone only.
- **Vector change (TypeScript).**
  - Features of counterpart vector layers are matched by a stable property (`id`, `fid`, `name`, configurable), else by geometry: centroid distance plus bounding-box overlap, then a Hausdorff check on vertices.
  - Verdicts: `added`, `removed`, `moved` (with distance), `reshaped`, `attributes` (changed keys).
- **Compare dates.**
  - A **Show changes** toggle in the split draws verdict pins and outlines on both views, with the item list in the right panel.
  - Selection of an item outlines its counterparts on both dates (extends `captureSelection`).
  - Slots for C2, C3 and C4: the panel offers "Run ..." actions registered by those streams through a small registry in `packages/change` (`registerChangeProducer`), so later streams never edit the panel.
- **Agent tools.**
  - `compare_captures` reads change sets when present (any kind), else today's volumes and issue counts.
  - New `list_changes` (read) and `show_change` (navigate).
  - `run_change_detection` (write, approval) starts the TS producers or the C2 to C4 jobs through the registry.

**Contracts used (C0):** `Layer.capture?`, `Layer.derived?`, `Issue.capture?` / `track?` / `resolvedIn?`, `aio.change/1`, `change:list|read|write|compute|cancel`, event `change:progress`, `LayerPatch.capture`.

**Tests:**

- **Vitest.**
  - `captureIndex` with explicit `capture` beats names, and the mixed explicit-plus-names case.
  - Issue matching on table-driven fixtures: new, resolved, `not-seen` when the later date did not cover the place, grown with an area threshold, and severity change.
  - Vector diff: id match, geometry match, a moved feature (with distance), attribute-only change.
  - Change-set merge keeps reviews byte-for-byte on recompute (same item ids); register filters.
  - `compare_captures` v2 against change sets.
  - IPC handlers: atomic write with `.bak`; refused for a read-only package.
- **Playwright e2e** (`change-core.spec.ts`, C8 two-date fixture, Medium tier pinned):
  - Compare dates, then Show changes: the panel lists the seeded new, resolved, grown and unchanged issues exactly as `truth.json` says.
  - Click "new": both views fly to it. Make issue: a draft issue with the later date appears in Issues.
  - Reopen the project: reviews persist.
  - Zero-network guard passes.
- **pytest:** `changeset.py` writer round-trips against the zod schema fixtures (JSON fixtures shared in `packages/schema/src/__fixtures__/change/`).

**Risks:**

- Issue matching on projects without 3D placements (photo-only inspections): falls back to photo-pose pairing (C4) or class and zone counts. The panel says which method it used.
- "Resolved" versus "not looked at": the visibility test needs the later date's camera footprints. The verdict must be `not-seen`, never `resolved`, when coverage is unknown.
- Split code is busy (M6.1 fixes landed there). C1 owns it for M8; C2 and C4 add one mount line each.

**Founder test steps (stage M8, Change core, demo tank farm, two dates):**

- [ ] **Compare dates** opens both dates. **Show changes** lists the issues: 1 new, 1 resolved, 1 grown, the rest unchanged. Each row shows the dates and the size change.
- [ ] Click the grown issue: both views fly to it, and its outline shows on both dates.
- [ ] **Make issue** on the new one: a draft issue appears in **Issues** with the later date. Close and reopen the project: still there, still reviewed.
- [ ] Import a photo set with **Survey date** set to the first date: it shows only in the left view while comparing.
- [ ] Map, Compare dates: the fence line shows as **moved** with its distance; the new track shows as **added**.
- [ ] Agent: "What changed between the two surveys?" gives the same counts as the panel.

### C2 Imagery and surface change

**Owns:**

- `python/src/aio_pipelines/change/raster.py`, `surface.py`, `register.py` (co-registration check)
- `python/tests/test_change_raster.py`, `test_change_surface.py`
- `packages/maps/src/swipe.ts`, `changeStyle.ts` (new)
- `apps/desktop/src/renderer/workspace/RasterPane.tsx`, `MapSwipe.tsx` (new)
- `apps/desktop/src/renderer/change/producers/raster.ts` (registered with C1's registry)
- `apps/desktop/e2e/change-raster.spec.ts`

**Scope:**

- **`change.raster`** (two orthos of the same area).
  - Resample both to a common grid, then check the co-registration offset with a phase correlation over tiles (refuse above `maxShiftPx`, report the shift).
  - Use an illumination-robust difference: per-channel normalisation plus gradient-magnitude difference, with the option of a structural-similarity distance (scikit-image).
  - Threshold, morphological clean-up and minimum area give polygons (shapely) with area and mean score.
  - Outputs:
    - a change heat map as a `kit-pyramid` raster layer with `derived: { kind: 'change', from, to }`;
    - a GeoJSON vector layer of change polygons;
    - `region` items in a change set.
  - Optional mask polygon (only this area) and ignore polygons (water, roads with traffic).
- **`change.surface`** (DSM or point cloud per date; clouds are gridded with the existing `volumetric/cloud.py`).
  - The DEM of difference at a common cell yields cut and fill per cell. Regions above `minDepthM` and `minAreaM2` become polygons with cut, fill and net volume.
  - Optional boundary polygons (for example user-drawn areas) report volumes per area.
  - Outputs: a diverging heat-map raster, region polygons, `region` items with `volume`, and a site total.
  - It does not replace the stockpile workflow (`volumetric.build`); it extends cut and fill to any project with two surfaces.
- **Map and ortho swipe and blend.**
  - In Compare dates with two maps or two orthos: a **Swipe** mode (one map, two date rasters, a draggable divider) and a **Blend** slider, as an alternative to the side-by-side view.
  - Change heat maps and polygons are drawn with a fixed legend (`changeStyle.ts`). In 3D the heat map drapes on the ground like an ortho.
- The C1 panel shows **Run imagery change** and **Run surface change** when the pair has counterpart orthos or DSMs or clouds.

**Contracts used:** `PipelineName` `change.raster` (`ChangeRasterParams`: `from`, `to`, `layerFrom`, `layerTo`, `method` `gradient|ssim|rgb`, `threshold?`, `minAreaM2?`, `maxShiftPx?`, `mask?`, `ignore?`, `out?`) and `change.surface` (`ChangeSurfaceParams`: `from` and `to` each `{ layer, kind: 'dsm'|'cloud' }`, `cellM?`, `minDepthM?`, `minAreaM2?`, `areas?`, `out?`); `Layer.derived?`; `aio.change/1` `region` items.

**Tests:**

- **pytest** (procedural fixtures from C8's `python/tests/synth.py`):
  - A known square painted on date 2 gives one polygon with area within 2%.
  - A lighting-only region gives no polygon.
  - A 3 px shift is detected and reported; 20 px is refused.
  - Surface: a known 1,000 m³ cone added gives fill within 1%, and an excavation gives cut.
  - Noise of ±2 cm gives no region.
  - Cloud inputs give the same result as DSM inputs within tolerance.
  - Resume with changed inputs is refused.
- **Vitest:** swipe geometry (divider to clip rectangle), blend opacity, legend stops, producer registry wiring.
- **Playwright** (`change-raster.spec.ts`):
  - Run imagery change on the demo, then: the job finishes, a heat map layer and a polygon layer appear, the panel lists the regions, and clicking one flies there.
  - Swipe drag moves the divider; Blend at 50% shows both dates.
  - Uses the bundled pipeline Python (`STRATLAS_E2E_PYTHON`), as `volumetric-build.spec.ts` does.

**Risks:**

- Real orthos differ in exposure, season and moving vehicles, so false positives are likely. Ship conservative defaults (decision 5) and ignore masks, and label results "proposed".
- Different ground sampling distance (GSD) and partial overlap between dates: compute on the overlap only and report coverage.
- Memory on large GeoTIFFs: process in windows (rasterio windows), never whole.

**Founder test steps:**

- [ ] Demo, **Changes**, **Run imagery change**: the job finishes. The new building footprint and the removed container are marked; the shadow-only area is not.
- [ ] **Run surface change**: the grown pile shows fill close to the number in the demo's notes, the new pit shows cut, and the site total shows.
- [ ] Compare dates on **Map**, then **Swipe**: drag the divider across the site. **Blend**: the slider fades between dates.
- [ ] The heat map lies on the ground in 3D, with a legend in metres.

### C3 Point cloud and 3D model change

**Owns:**

- `python/src/aio_pipelines/change/cloud.py`, `mesh.py`
- `python/tests/test_change_cloud.py`, `test_change_mesh.py`
- `packages/pointcloud/src/extraBytes.ts` (new); in `copcDecode.ts`, `material.ts`, `settings.ts`: the scalar attribute and the `change` colour mode
- `packages/pointcloud/src/ChangeLegend.tsx` (new)
- `packages/engine/src/adapters/model.ts` (vertex-colour path only, if needed)
- `apps/desktop/src/renderer/change/producers/cloud.ts`, `mesh.ts`
- `apps/desktop/e2e/change-cloud.spec.ts`

**Scope:**

- **`change.cloud`** (two point cloud layers).
  - Read both clouds through PDAL `readers.copc` by tiles with a resolution or level cap (bounded memory).
  - Distance from each point of the later date to the nearest point of the earlier one, using a SciPy KD-tree.
  - Optional signed distance along a local normal (PCA of neighbours), plus a "far" class above `maxDistM`.
  - Write a COPC of the later cloud with an extra-bytes dimension `Distance` (float32, metres) through PDAL `writers.copc` `extra_dims`.
  - Summary statistics, and `region` items from clustering of points above threshold (DBSCAN-lite on a grid) with an outline, centroid and mean and max distance.
  - Registration check: the median distance over a stable sample must stay under the tolerance, else the result is flagged "dates not aligned".
- **Cloud volume change** is not duplicated: the cloud change dialog offers **Volume change**, which starts C2's `change.surface` with `kind: 'cloud'` inputs.
- **Viewer.**
  - Decode the LAS 1.4 extra-bytes VLR (one float scalar, plus `scalar` metadata on the layer).
  - A new colour mode **Change**: diverging ramp, symmetric range, threshold slider that hides points below it, and a legend in metres.
  - Hover read-out of the distance.
  - Point budget unchanged: one more attribute per point (4 bytes) is accounted for in the memory caps.
- **`change.mesh`** (two mesh layers).
  - Sample N points on the later model, take the distance to the earlier one (trimesh proximity with rtree), and write a copy of the later GLB with `COLOR_0` deviation colours as a derived mesh layer.
  - Diff tagged parts by node name with the survey key stripped (`captures.ts` rules): `added`, `removed`, `moved` (bounding-box centre offset), `changed` (mean deviation of that part above threshold).
  - These become `component` items; a click selects the part on both dates.

**Contracts used:** `PipelineName` `change.cloud` (`ChangeCloudParams`: `layerFrom`, `layerTo`, `maxDistM?`, `signed?`, `spacingM?`, `region?`, `out?`) and `change.mesh` (`ChangeMeshParams`: `layerFrom`, `layerTo`, `samples?`, `maxDistM?`, `out?`); point cloud layer `scalar?` (`{ dim, label, unit, range, diverging }`); `Layer.derived?`; `component` and `region` items.

**Tests:**

- **pytest** (procedural):
  - A plane plus a box moved 0.30 m measures 0.30 ± 0.01 m on the box faces and less than 1 cm elsewhere.
  - A new cylinder becomes a region with the right centroid; a removed object is found in the reverse direction.
  - Extra-bytes output reads back with PDAL `info`.
  - Tiles: the result is the same as untiled for a small cloud.
  - Mesh: a part moved by a known offset reports `moved` with that offset; an added part reports `added`; a dent of known depth gives the right deviation.
  - Tests that need PDAL are skipped with a reason when it is not available (as `test_pointcloud.py` does).
- **Vitest:** extra-bytes VLR parse (fixture bytes); decode returns the scalar; ramp and threshold uniforms; legend.
- **Playwright** (`change-cloud.spec.ts`): Run cloud change on the demo, then colour mode **Change**: pixels in the moved-pipe area are warm and the static tank is neutral (sampled through the inspection hook). Threshold hides unchanged points. Mesh change: the moved part is outlined on both dates.

**Risks:**

- Extra-bytes support in the in-house COPC decoder: keep it to one float scalar, and refuse other layouts with a message.
- Distance on very different densities (terrestrial laser vs drone LiDAR): the defaults use spacing-aware thresholds, and the plan documents "nearest-neighbour distance overstates change on sparse clouds" in KNOWN-LIMITS.
- Mesh vertex colours: if the engine's model adapter ignores `COLOR_0` with textures, C3 adds a small material switch (declared engine touch, reviewed by the integration lead).

**Founder test steps:**

- [ ] Demo, point cloud, **Changes**, **Run cloud change**: the job finishes and a new cloud layer "Change" appears.
- [ ] Colour mode **Change**: the moved pipe is red or blue, and tanks and ground are grey. The legend reads in metres. The threshold slider hides small changes.
- [ ] Hover a point: its distance shows.
- [ ] **Volume change** from the cloud dialog gives the same pile volumes as the surface change.
- [ ] **Run model change**: the moved part, the new part and the removed part are listed. Click each: it is outlined on both dates. The deviation model colours the dent.

### C4 Video and photo same-view change

**Owns:**

- `packages/video/src/pairing.ts` (new): pose matching across flights
- `packages/video/src/FramesCompare.tsx` (new)
- `apps/desktop/src/renderer/workspace/FramesPane.tsx` (new), plus one `PaneKind` entry in `splitModel.ts` (declared overlap with C1)
- `python/src/aio_pipelines/change/frames.py` (optional), `python/tests/test_change_frames.py`
- `apps/desktop/src/renderer/change/producers/frames.ts`
- `apps/desktop/e2e/change-frames.spec.ts`

**Scope:**

- **Same view on the other date.**
  - For the current frame (video) or photo of date A, find the frame or photo of date B whose camera is closest.
  - The cost combines position distance, view-direction angle and footprint overlap on the ground or model, using `flight.ts` interpolation, lens and orientation calibration.
  - Coarse search over all clips of date B, refined to the frame.
  - Exposes a `pairsFor(captureA, captureB)` helper that C1 uses for photo-only detection matching.
- **Frames compare pane.**
  - A split pane kind "Frames": left date A video or photo, right date B best match, with a score ("2.1 m, 4 degrees apart").
  - **Swipe** and **Blend** modes, with the second frame optionally warped by a homography from the pose difference over the ground plane (in TypeScript).
  - Scrub date A and date B follows.
- **`change.frames`** (optional, in M8 only if time allows).
  - For a list of matched pairs: ORB features plus a RANSAC homography (scikit-image), difference after alignment, and a change mask.
  - Results become draft detections `source: 'model'` with `label: 'change'` in `detections/change-frames-<run>.json`, so they flow into the existing review, and `frame` items in the change set.

**Contracts used:** `aio.change/1` `frame` items; `PipelineName` `change.frames` (`ChangeFramesParams`: `pairs` or `{ from, to, maxPoseM, maxAngleDeg }`, `minAreaPx?`, `out?`); the existing detection `frame` field.

**Tests:**

- **Vitest:**
  - Pairing on synthetic flights: the known pair list from C8's `truth.json` is found exactly; there is no pair when footprints do not overlap.
  - Frame refinement; homography from poses on a flat ground plane.
  - Scrub follow.
- **pytest:** a known patch added on frame B gives one mask region; a viewpoint offset only gives none after alignment.
- **Playwright** (`change-frames.spec.ts`): Split, Frames, play date A, then the right pane shows the seeded matching frame of date B (frame index from truth, ±1). Swipe works, and the score text shows.

**Risks:**

- Pose error in real logs (Al-Zour showed 20 to 44 m height errors before calibration): pairing relies on calibrated poses, and the pane shows the score so a poor match is visible.
- Video decode of two clips at once on low-end GPUs: the second pane uses a paused exact-frame decode (WebCodecs), not playback.
- Overlap with C1 in `splitModel.ts`: one enum entry and one factory branch. C1 merges first.

**Founder test steps:**

- [ ] Demo, **Split**, **Frames** on the right: play the date-1 flight, and the right side shows the same view from date 2, with the distance and angle shown.
- [ ] **Swipe** across the frame; **Blend** halfway: the new structure appears.
- [ ] Open a date-1 photo, then **Same view on the other date**: the matching date-2 photo opens.
- [ ] (If `change.frames` lands) **Find changes in matched frames**: the change boxes appear as drafts in **Detections**.

### C5 Models from drawings and point clouds (BLD-11)

**Owns:**

- `packages/modelling/**` (new):
  - `procmodel.ts`: helpers and validation beyond zod;
  - `mesher.ts`: primitives to triangles with tagged nodes;
  - `glb.ts`: GLB writer, reusing the approach of `packages/project/src/builder/obj.ts` and `tools/demo/glb.mjs`;
  - `ModelBuilder.tsx`.
- `python/src/aio_pipelines/drawing/**`: `dxf.py` with `ezdxf` (MIT), units, layers, blocks, georeference by control points
- `python/src/aio_pipelines/modelfit/**`: `ransac.py` (planes, cylinders, boxes), `segment.py` (ground removal, clustering), `fit.py`
- `python/tests/test_drawing.py`, `test_modelfit.py`
- `apps/desktop/src/main/modelBuilder.ts`
- `apps/desktop/src/renderer/modeller/**`
- `packages/ai/src/modelling-tools.ts` (new), plus a registration line in `tools.ts`
- `python/pyproject.toml` / `uv.lock` (adds `ezdxf`; the integration lead re-locks)
- `apps/desktop/e2e/model-builder.spec.ts`

**Scope:**

- **Drawings in.**
  - `drawing.import` reads a DXF in its units (refuses unitless files without a stated unit).
  - Georeferences by two or more control points: picked in the app on the drawing and the map or model, or given as coordinates.
  - Writes a GeoJSON vector layer per chosen DXF layer group and a rendered raster plan (`role: 'plan'`, `format: 'image'`, `corners`) for tracing.
  - Text entities with numbers near closed shapes become height hints (`height=12.5`, `EL +12.500`).
  - DWG is out of scope (decision 7). Raster or PDF plans continue to come in as `plan` rasters and are traced by hand or by the agent.
- **Point clouds in.**
  - `model.fit_cloud` on a cloud layer, inside an optional box or polygon region.
  - Steps: ground removal, Euclidean clustering, and per cluster a RANSAC choice among vertical cylinder (tank or vessel), box (building, skid, container), plane set (roof or walls into an extrusion footprint) and pipe run (cylinder chain along a skeleton), ranked by residual and inlier share.
  - Writes draft parts with `origin: { by: 'fit', residualM, inliers }` into `models/<id>.procmodel.json`.
- **Procedural model and mesher.**
  - Parts are `extrusion`, `cylinder` (with flat, cone or dome roof), `box`, `pipe` and `sphere`, each with id, name or tag, class, status, confidence and origin.
  - The TypeScript mesher builds the GLB with one node per part, named by tag, so issues, tags and `captures.ts` part matching work. Main writes `models/<id>.glb` atomically and adds or updates a mesh layer with `derived: { kind: 'model', source }`.
  - Preview: the draft GLB is written to `models/draft-<id>.glb` and shown as a hidden-in-reports draft layer. This avoids any engine change.
- **Model builder screen.**
  - Parts list with status; accept or reject one or all (keyboard); edit dimensions numerically or with handles on the plan and in 3D for position and height.
  - Overlay of the part on the cloud with the residual colour.
  - **Build model** turns accepted parts into the GLB.
- **Agent assistance** on the `build` route.
  - Tools: `propose_model_parts` (write, approval; from drawing text, plan raster or cloud statistics), `fit_primitives` (starts `model.fit_cloud`, approval), `edit_model_part` (write), `build_model` (write).
  - Every result is a draft part shown as a step.
  - Sending a plan image to a cloud model goes through the consent preview and the project AI policy. A local model (C7) works for text-only drawings.

**Contracts used:**

- `aio.procmodel/1` (`ProcModel`, `ProcPart` union, `PartStatus`, `PartOrigin`)
- `Layer.derived?` (`kind: 'model'`)
- `PipelineName` `drawing.import` (`DrawingImportParams`: `src`, `units?`, `layers?`, `control?` point pairs, `out?`) and `model.fit_cloud` (`ModelFitParams`: `layer`, `region?`, `kinds?`, `distM?`, `minInliers?`, `model?` id to append to)
- IPC `model:list`, `model:read`, `model:write` (atomic, `.bak`, refused for packages), `model:build` (`{ projectId, id, draft? }` to `{ ok, layer, glb }`)
- `ImportItem.kind` gains `drawing` (enum value used by the builder import list only)

**Tests:**

- **pytest:**
  - DXF fixture (C8): units, blocks, layer filter, control-point transform within 1 cm; height hints parsed; unitless file refused with a message.
  - Fitting on a synthetic scan with ground truth: cylinder radius and height within 2%, box size within 3%, pipe diameter within 5%. An occluded half-cylinder still fits.
  - Noise-only cluster gives no part.
  - Resume with changed inputs is refused.
- **Vitest:**
  - Mesher: watertight primitives, node names, normals, the GLB validates (glTF validator in dev).
  - Procmodel validation messages.
  - Agent tool schemas, and that their risk tiers are `write`.
- **Playwright** (`model-builder.spec.ts`, demo modelling area):
  - Import the DXF and place it by two points: the plan lies on the map.
  - Fit primitives: draft parts listed. Accept all, then Build: a mesh layer appears with tagged parts, and clicking a tank selects "T-101".
  - Scripted agent (existing `scripted.ts` pattern): "make the tanks from the drawing" produces draft parts awaiting approval.

**Risks:**

- Scope creep (full plant modelling): M8 targets massing and plant primitives only (decision 7). LOD3 and IFC export are later.
- Real DXFs: inconsistent units, blocks, 3D polylines, huge coordinates. Every refusal names the entity and the fix. Coordinates are shifted to the project origin in float64 before float32 meshes.
- RANSAC tuning on real scans: parts carry residuals and stay drafts.

**Founder test steps:**

- [ ] Demo, **Builder**, **Import** the demo plot plan (DXF), pick two points on the plan and two on the map: the plan lies over the site.
- [ ] **Model builder**, **From drawing**: the tanks and buildings appear as draft parts with their heights. Change one height, then **Build model**: the 3D view shows the new model, and tanks carry their tags.
- [ ] **From point cloud** on the modelling area: tanks, boxes and the pipe come out as drafts with a fit quality. Reject one, accept the rest, Build.
- [ ] Agent: "Build the tank T-102 from the drawing": a draft part waits for **Approve**.
- [ ] A DXF without units is refused with "set the drawing units".

### C6 Local ONNX detection (BLD-10)

**Owns:**

- `apps/desktop/src/main/inference/**` (new): `utility.ts` (utility process host), `worker.ts` (onnxruntime session, pre- and post-processing), `models.ts` (model registry: pipeline pack `models/detect/*` and userData `models/detect/*`), `tile.ts`, `nms.ts`, `layouts.ts` (output layouts)
- `apps/desktop/src/main/maskAssist.ts` (moves its session into the same utility process; same `OrtLike` seam)
- `apps/desktop/src/renderer/detections/AiDetectDialog.tsx`, which becomes the **Detect** dialog with Cloud vision or Local model
- `apps/desktop/src/renderer/screens/settings/DetectionModels.tsx` (new), plus one mount line in `Settings.tsx`
- `apps/desktop/package.json` and `electron-builder.yml` entries for `onnxruntime-node` (decision 3)
- `apps/desktop/e2e/detect-local.spec.ts`

**Scope:**

- **Runtime.**
  - `onnxruntime-node` (MIT) in a dedicated Electron utility process, so main and the UI never block.
  - Execution providers in order: DirectML (Windows), CoreML (macOS), CPU. The chosen one shows in Settings and the diagnostics bundle.
  - A memory cap; one session per model, kept warm.
- **Model cards.**
  - `model.onnx` plus `model.json` (`aio.detector/1`): name, version, layout (`yolo-v8` / `yolo-v5` / `detr` / `ssd` / `generic`), input size and normalisation, class names, SPDX licence, source, sha256.
  - **Import model** in Settings copies into userData after an sha256 check, a layout probe (one dummy inference, output shape check) and a licence acknowledgement.
  - Models without a card or an allowed licence are refused for customer builds (licence gate, decision 4).
- **Run.**
  - On photos or video frames (same item picker as AI detect), with optional tiling for large photos (tile size, overlap, merge with NMS across tiles).
  - Confidence threshold; class mapping (model class to project catalogue class, remembered per project and model).
  - Progress, cancel, and resume by skipping done items.
  - Results go to `detections/model-<run>.json` (`source: 'model'`, `status: 'draft'`, `origin: { model, runId }`, `run`) and appear in the existing review. Nothing counts until accepted.
- **Mask assist** (Outline) uses the same runtime and the model folder `models/sam/`. If the founder approves shipping MobileSAM (Apache-2.0), it ships in the pack (decision 4).

**Contracts used:**

- `aio.detector/1` (`DetectorModelCard`, `DetectorLayout`)
- IPC `inference:models` (list, with available EP), `inference:importModel` (`{ path, acceptLicence }`), `inference:removeModel`, `inference:run` (`{ runId, projectId, model, items, classMap, minConfidence, tile? }` to `{ ok, file, count }`), `inference:cancel`
- event `inference:progress`
- detections `source: 'model'` (exists)

**Tests:**

- **Vitest:**
  - Pre-processing (letterbox, normalisation) on a fixture image; post-processing per layout with recorded output tensors.
  - NMS and tile merge (a box across a tile seam is kept once).
  - Class mapping persistence; model-card validation; licence gate.
  - Utility-process protocol with a fake ORT (`OrtLike` stand-in, as `maskAssist` tests do).
- **Playwright** (`detect-local.spec.ts`, C8's operator-built test detector):
  - Settings, Import model: the card shows with its licence.
  - Detections, Detect, Local model: on the demo photos, finds exactly the seeded marker patches (count and boxes within 4 px of `truth.json`); drafts appear; accept one.
  - A corrupt model gives an exact error; cancel mid-run keeps the done items.
  - Zero-network guard passes.
- **pytest:** none (no Python runtime involved) unless decision 3 moves the runtime to the pack.

**Risks:**

- Native module packaging (MSIX, macOS universal, signing of the bundled DLLs, `asarUnpack`). Mitigation: the M7 smoke test of packaged builds (`tools/release/smoke-packaged.mjs`) gains an ONNX probe.
- DirectML differences from CPU: the e2e test runs on CPU for determinism; a unit test compares EPs when available.
- Licences of model exports: Ultralytics' licence claims AGPL over trained YOLOv5/v8/v11 weights, so they are allowed only with an Enterprise licence (PRD BLD-10). The import flow states this.

**Founder test steps:**

- [ ] **Settings, Detection models**: the runtime shows "DirectML" (or CPU). **Import model** with the demo test model: its card, classes and licence show.
- [ ] Demo, **Detections**, **Detect**, **Local model**: the run shows progress with no cost. Draft boxes land on the marked patches. Accept two with the keyboard.
- [ ] Turn off Wi-Fi and repeat: it still works.
- [ ] Import a broken file: an exact error, and the app stays up.
- [ ] (If MobileSAM ships) **Outline** in the review traces the object in a box.

### C7 Local AI agent

**Owns:**

- `packages/ai/src/providers.ts`, `main.ts` (runtime gates, timeouts, tool profile, repair), `routes.ts`, `prompt.ts` (compact prompts)
- `packages/ai/src/local.ts` (new): discovery and probing, server kinds
- `packages/ai/src/tools.ts`: `toolsForWindow` profile filter only
- `apps/desktop/src/main/localModels.ts` (new)
- `apps/desktop/src/renderer/screens/settings/LocalModel.tsx` (new; moves the Local model card out of `Settings.tsx` with a one-line mount)
- `apps/desktop/e2e/fake-llm.ts` (new loopback OpenAI-compatible fake), `agent-local.spec.ts`

**Scope:**

- **Server discovery**, on click only, loopback only unless the person accepts the cloud warning.
  - Ollama (`/api/version`, `/api/tags`, `/api/show` for context and capabilities), and OpenAI-compatible servers (`/v1/models`: LM Studio, llama.cpp server, vLLM).
  - Model picker with badges (tools, vision, context).
- **Capability probe** (`ai:localProbe`): one tiny tool-call request, one tiny image request when vision is claimed, and latency.
  - Routes are checked against capabilities: a chat route on a model without tool calling turns the agent into **answer-only mode** with a clear notice.
  - A vision route needs vision.
- **Small-model adaptations.**
  - `toolProfile: 'compact'`: per window, a short list of the most-used tools with shortened descriptions, with C1 and C5 tools included by name. Fewer steps (6) and output tokens bounded by `contextTokens`.
  - Conversation trimming with a running summary when over budget.
  - AI SDK tool-call repair for malformed JSON (one retry with the schema error), and no parallel tool calls.
  - Longer first-token timeout (model load), with cancel always available.
- **Offline agent preset** in Settings: routes chat, vision, report, extract and build to the local model in one click, and back.
  - The status bar shows "Agent: local (offline)".
  - The meter shows "free" (exists).
  - The send-preview step is skipped for loopback (no data leaves the machine). A non-loopback "local" server keeps the cloud gates (existing rule).
- **Optional local-server key**: some servers (LM Studio, a secured llama.cpp server) want a bearer key. It is stored in Windows Credential Manager or macOS Keychain under the `local` account (`AiProvider` already includes `local`), used when present, and never logged.
- **Local vision for detection (R2)** and narrative (R3) through the existing `ai:detect` and `ai:draftText` with the local route, verified end to end with the fake server.
- **If decision 1 chooses bundling:** a `llama-server` sidecar managed by main, with start, stop, health and GGUF files in the data root `runtime/models/`. Otherwise a guided "Set up a local model" page in the user guide (D8) and Settings.

**Contracts used:**

- `LocalModelSettings` gains optional `kind` (`ollama` | `openai-compatible` | `bundled`), `contextTokens`, `toolProfile` (`full` | `compact`), `capabilities` (`{ tools, vision }`), `timeoutMs`
- IPC `ai:localModels` (`{ baseUrl? }` to `{ ok, server?, models[] } | { ok: false, error }`), `ai:localProbe` (`{ model }` to `{ ok, tools, vision, contextTokens?, latencyMs } | { ok: false, error }`)
- `ai:status` reason gains `answer-only` (optional enum value; readers ignore unknown values)
- `ai:setKey` and `ai:hasKey` accept `local` (already in the `AiProvider` enum)

**Tests:**

- **Vitest:**
  - Discovery parsers (Ollama and OpenAI shapes, recorded JSON).
  - Probe logic; route-capability checks; compact profile contents per window.
  - Tool-call repair with a mock model that emits broken JSON once.
  - Trimming keeps the system prompt and the last turns; answer-only mode.
  - Loopback versus remote gating (extends existing tests in `main.test.ts`); local key read but never logged (log capture).
- **Playwright** (`agent-local.spec.ts`; fake LLM on `127.0.0.1:<port>` through `AIO_NETWORK_GUARD_ALLOW`, cloud AI off):
  - Settings, Local model: Find models lists the fake's two models; Test shows "tools yes, vision no"; the Offline agent preset is set.
  - Agent: "fly to the tank" makes a tool call that is approved and the camera moves, and `__aioNetworkLog` stays empty.
  - The answer-only model gets a notice and no tool steps.
  - Local vision detect on two photos gives drafts.
  - Cancel during a slow (delayed) reply stops at once.

**Risks:**

- Small local models call tools badly. Mitigations: compact profile, repair, answer-only fallback, and an honest notice. The plan recommends a model class, not a guarantee (decision 2).
- Hardware: CPU-only 7B models answer in tens of seconds, so streaming and cancel are mandatory, and Settings shows measured latency.
- Model weight licences (Llama community licence, Gemma terms, Qwen Apache-2.0) matter only if bundling (decision 1).

**Founder test steps:**

- [ ] Install Ollama yourself and pull the recommended model (the guide names it). **Settings, AI providers, Local model**: **Find models** lists it with its badges, and **Test** reports tools and vision.
- [ ] **Offline agent**, then turn Wi-Fi off. Agent: "Show me the issues near tank T-101": the steps run and the camera moves. The meter says free.
- [ ] A model without tool support: the agent answers in text and says it cannot act.
- [ ] **Detect** with the vision route on the local model: drafts arrive, with no cost.
- [ ] Set a key for the local server: it is kept after a restart and never shown again (Credential Manager has a "Stratlas local" entry).

### C8 Synthetic data, fixtures and the M8 harness

**Owns:**

- `tools/demo/**` (after M7's demo branch is merged)
- `python/tests/synth.py` (new): procedural generators for pytest
- `tools/demo/onnx-test-model.py` (new, dev-only `onnx` package, Apache-2.0)
- `apps/desktop/e2e/fixtures.ts`: new `twoDateProject` and `demoProject` fixtures only
- `tools/demo/check-no-client-data.mjs` (extended to DXF, ONNX metadata, GLB extras, `truth.json`)
- CI job `demo` (build and check)

**Scope:** see "Synthetic test data" below. Delivers a `--quick` CI variant, stable seeds, and one `truth.json` per demo project with the exact expected change, pairing, fitting and detection results that other streams' tests assert against.

**Tests:**

- **Vitest / node:test:** the generator is deterministic (same seed, same hashes); `truth.json` agrees with the generated geometry (recomputed checks); the client-data check finds planted client-like strings in DXF text, ONNX `doc_string` and GLB extras.
- **pytest:** `synth.py` generators produce the documented shapes.
- **CI:** build the demo `--quick`, run the check, keep the size under budget (decision 9).

**Risks:**

- Installer size growth from a second date (video, cloud, ortho). Mitigation: `--quick` resolution for CI, a size budget, and the change demo as a separate bundled project only if decision 9 allows.
- Merge order: C8 depends on the M7 demo commit reaching `main`.

**Founder test steps:**

- [ ] The first-start welcome still opens the demo; the library shows "2 dates" on it.
- [ ] Nothing in the demo names a client, a real site or a real camera (the check report is in the build log).

## Contract changes (rows for `contract-changes.md`, written by C0 unless noted)

| Change                                                                                                                                                                                                                                                                                                                                                                                                  | Why                                                                                                                          | Streams           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| Layer base gains optional `capture?: Id` (the survey date it belongs to; wins over the naming heuristics of data-conventions 13) and `derived?: LayerDerived` (`{ kind: 'change' \| 'model', from?, to?, changeId?, runId?, source?: Id[] }`). `LayerPatch` accepts `capture` (`null` clears)                                                                                                           | Explicit layer dates for change across every type; derived layers carry provenance, and old builds show them as plain layers | C1 to C5, builder |
| Point cloud layer gains optional `scalar?` (`{ dim, label, unit, range: [min, max], diverging }`)                                                                                                                                                                                                                                                                                                       | Cloud-to-cloud distance stored as a COPC extra-bytes dimension                                                               | C3                |
| `Issue` gains optional `capture?: Id`, `track?: Id` (same defect across dates), `resolvedIn?: Id`                                                                                                                                                                                                                                                                                                       | Issue change (new, resolved, grown) without changing the status workflow                                                     | C1                |
| New `change.ts`: `ChangeSet` (`aio.change/1`, `<project>/change/<id>.json`: `id`, `from`, `to`, `producer`, `run?`, `createdAt`, `items[]`, `layers`, `stats`), `ChangeItem` union by `kind` (`issue`, `detection`, `vector`, `region`, `component`, `frame`), `ChangeVerdict`, `ChangeReview` (`status: open \| confirmed \| dismissed`, `by`, `at`, `note?`, `issueId?`); data-conventions section 14 | One register for every layer type; reviews survive recompute through stable item ids                                         | C1 to C4          |
| IPC `change:list`, `change:read`, `change:write` (atomic, `.bak`, refused for packages), `change:compute` (`{ jobId, projectId, from, to, kinds }`, TS producers), `change:cancel`; event `change:progress`                                                                                                                                                                                             | Change sets and the in-app producers                                                                                         | C1                |
| `PipelineName` gains `change.raster`, `change.surface`, `change.cloud`, `change.mesh`, `change.frames`, `drawing.import`, `model.fit_cloud`, with their params (see streams); `PIPELINES` lists them; pipeline pack 0.3.0                                                                                                                                                                               | Heavy change and modelling work in the pipeline pack                                                                         | C2 to C5          |
| New `procmodel.ts`: `ProcModel` (`aio.procmodel/1`, `<project>/models/<id>.procmodel.json`), `ProcPart` (`extrusion`, `cylinder`, `box`, `pipe`, `sphere`), `PartStatus`, `PartOrigin`; IPC `model:list`, `model:read`, `model:write`, `model:build`; `ImportItem.kind` gains `drawing`; data-conventions section 15                                                                                    | BLD-11 procedural models built into tagged GLBs                                                                              | C5                |
| New `inference.ts`: `DetectorModelCard` (`aio.detector/1`), `DetectorLayout`; IPC `inference:models`, `inference:importModel`, `inference:removeModel`, `inference:run`, `inference:cancel`; event `inference:progress`; data-conventions section 16                                                                                                                                                    | BLD-10 local detection with licensed model cards                                                                             | C6                |
| `LocalModelSettings` gains optional `kind`, `contextTokens`, `toolProfile`, `capabilities`, `timeoutMs`; IPC `ai:localModels`, `ai:localProbe`; `ai:status` reason gains `answer-only`                                                                                                                                                                                                                  | AI-9 completed: discovery, probing and small-model behaviour                                                                 | C7                |
| (Integration) `ReportSectionId` gains `changes`; `EXPORT_FORMATS` gains `change-csv` and `change-geojson` (package kind `csv` / `geojson`)                                                                                                                                                                                                                                                              | Change register in the house report and exports                                                                              | Integration       |

## Synthetic test data

No client data, ever: no client file, name, place, camera serial or path. The M7 generator (`tools/demo/build-demo.mjs`, merged to `integration/m7`, not yet to `main`) is extended. Everything is seeded and procedural, at the existing fictional desert location. Each demo writes `truth.json` with the exact expected results. What M8 needs:

1. **A second capture date** for the fusion demo site, with every layer type present on both dates and seeded, known differences:
   - **Ortho:** a new structure footprint, a removed object (container), a lighting-only or shadow-only region, and a slight overall tint shift. Neither of the last two may be flagged.
   - **DSM or terrain:** one pile grown by a known volume, a new excavation of known volume, and ±2 cm noise elsewhere.
   - **Point cloud:** one object moved by a known offset, one added, one removed, with realistic noise, occlusion and density differences between dates. Written as LAS so the pipeline makes COPC, and as numpy arrays for pytest.
   - **3D model:** one tagged part added, one removed, one moved by a known offset, and one locally deformed (a dent of known depth).
   - **Video:** a second flight over a similar path with small pose differences, rendered from the date-2 world, with the ground-truth list of best-matching frame pairs.
   - **Photos with poses** on both dates.
   - **Map vector layers** per date: a rerouted fence, an added track segment, and an attribute-only change.
   - **Issues and detections:** date-1 issues, then on date 2 one new, one repaired (resolved), one grown by a known factor, and the rest unchanged. Detection passes per date.
2. **Drawings:** a fictional DXF plot plan of the site (tank circles with tags, building outlines, pipe centrelines, height text, set units, some blocks) with known control points, plus a raster plan render of it. Also a unitless DXF and a malformed one for error tests.
3. **A modelling scan:** a synthetic point cloud of tanks, boxes and a pipe run with noise and occlusion, and the ground-truth primitive parameters.
4. **An ONNX test detector built from plain operators.**
   - It finds a seeded marker colour, using thresholds and pooling to boxes, in a YOLO-like output layout. There are no trained weights, so there is no licence or training-data question.
   - Built at test time by a dev-only script, with a model card (licence MIT, source "Stratlas test fixture").
   - Plus a corrupt file and a wrong-layout model for error paths.
5. **A fake local LLM server** (owned by C7, not data): scripted replies including tool calls, malformed tool-call JSON, a model without tools, a vision reply, and a slow reply.
6. **pytest generators** (`python/tests/synth.py`) for small rasters, clouds and meshes with known change, so pipeline tests never need the full demo.
7. **The client-data check is extended** to DXF text and attributes, ONNX metadata, GLB extras and `truth.json`, and runs in CI on every artifact.
8. **Size:** a `--quick` CI variant, and a bundled size budget (decision 9).

## Merge order

1. **C0 contracts** (serial). Tag `contracts-m8`.
2. **C8 data and fixtures:** the M7 demo must be on `main` first, and every e2e test needs it. It can land in two parts: two dates first, then DXF, scan and ONNX.
3. **C7 local agent:** independent and low overlap. Landing early de-risks the local-model gates that C5's agent tools and C6 rely on.
4. **C1 change core:** owns the split, the panel and the producer registry that C2 to C4 plug into.
5. **C6 ONNX detection:** independent of change. Its native-module packaging needs the longest installer soak.
6. **C2 imagery and surface:** needs the C1 panel; C3's cloud volume button calls its pipeline.
7. **C3 point cloud and model change.**
8. **C4 frames:** adds a pane kind to C1's split. Its pairing helper upgrades C1's photo-only detection matching in the same merge.
9. **C5 models:** last, because it touches `packages/ai` after C7 (tool registration and compact profile list) and `pyproject.toml` after any other lock change.

The integration lead merges when green, re-locks `uv.lock`, rebuilds the pipeline pack 0.3.0 and the installer, then runs the smoke checks below.

## Integration follow-ups (after all streams)

- **House report** (R4): a "Changes between <date> and <date>" section (register table, before and after crops from both dates, volume table), as `ReportSectionId` `changes`. Change CSV and GeoJSON exports.
- **Packages** (X1): carry `change/`, `models/*.procmodel.json` and derived layers. Player mode is read-only and never starts computations. `excludedLayers` works for derived layers.
- **Agent:** compact-profile tool lists include C1 and C5 tools; scripted-provider rules for the new tools; the zero-network suite runs with the local agent on and the fake server allowed.
- **Performance** (D7): two views with a change-coloured cloud and a heat-map drape within the Medium budget; re-estimate `COMPARE_GPU_BYTES` with the extra attribute.
- **Accessibility** (D6): axe on the Changes panel, Frames pane, Model builder and Detection models; keyboard review of change items and parts.
- **Diagnostics** (D5): the bundle adds the ONNX execution provider, local server kind and version, and model cards (never prompts or keys).
- **macOS and Store:** onnxruntime-node universal binaries and CoreML; MSIX native DLL signing; macOS Keychain entry for the local key.
- **User guide** (D8): chapters on change detection, model builder, local detection and the offline agent, with screenshots from e2e.
- **Docs:**
  - `ROADMAP.md`: add "local AI agent" to the M8 row.
  - `PRD.md`: FUS-12, BLD-10, BLD-11 and AI-9 status.
  - `SPEC.md`: new packages, and section 7 (ONNX runtime location).
  - Data-conventions sections 13 (explicit `capture`) and 14 to 16.
  - `KNOWN-LIMITS.md`: nearest-neighbour distance on sparse clouds, no DWG, local model quality, change on unregistered dates.
- **TESTING.md:** stage M8 from the founder steps above.
- **Smoke tests on the founder machine:**
  - Masafi (two dates): surface change against its existing volumes.
  - Al-Zour: local agent and ONNX on photos.
  - The demo, end to end.
  - Client projects are used only on the founder's machine and never in the repo, CI or fixtures.

## Founder decisions needed

1. **Local agent runtime.** M8 supports user-installed servers (Ollama, LM Studio, llama.cpp server) with a guided setup (recommended). The alternative is to bundle a `llama-server` sidecar and a default GGUF model (adds 4 to 8 GB of download, and model licence terms).
2. **Recommended local model(s)** named in the guide and the minimum hardware statement (needs tool calling, ideally vision). Licence check: Qwen-family models are Apache-2.0; Llama and Gemma have their own terms.
3. **Where onnxruntime ships.**
   - In the app as `onnxruntime-node` (recommended: works without the pipeline pack, GPU through DirectML or CoreML, but makes the installer larger),
   - or in the pipeline pack (keeps the installer small, but detection then needs the pack).
4. **Which models ship.**
   - Detectors: none in M8, importing your own ONNX with a licence card (recommended), or a permissively licensed architecture later. Ultralytics YOLO exports only with an Enterprise licence.
   - Mask assist: whether to ship MobileSAM (Apache-2.0, about 40 MB), which removes the KNOWN-LIMITS line.
5. **Change defaults** per project type. Proposed:
   - clouds: 5 cm significant, 30 cm far;
   - surfaces: 10 cm depth and 1 m² minimum;
   - orthos: conservative;
   - "grown": area +20% or severity up one level;
   - registration tolerance: 2 px or 5 cm.
6. **Issue lifecycle across dates.** "Resolved" only proposes: a person confirms, then the status becomes `closed` with `resolvedIn` (recommended). Never automatic.
7. **BLD-11 scope.**
   - Inputs: DXF plus georeferenced raster or PDF plans traced by hand or by the agent. DWG is excluded (needs the commercial ODA SDK).
   - Parts: tanks and vessels, buildings (extrusions), boxes (skids, racks) and pipes.
   - No IFC export in M8.
8. **Cloud AI for modelling.** May plan images and drawings be sent to a cloud model on the `build` route (with consent preview and project policy), or local only?
9. **Demo size.** Whether the bundled demo grows with the second date and modelling data (installer size), or the change demo becomes a separate bundled project with a size budget.
10. **Plans and feature flags** (recorded for M10, not blocking): which plan includes change detection, model building and local detection (for example Pro Reviewer views change sets; Builder computes them).

## Exit

- On the founder's machine, with Wi-Fi off:
  - the demo shows change for every layer type with the counts in its `truth.json`;
  - a model is built from the demo DXF and from the demo scan;
  - local ONNX detection finds the seeded markers;
  - the agent answers and acts on a local model.
- CI is green on Windows and macOS (Vitest, Playwright `--workers=1` off-screen, pytest), including the zero-network suite with the local agent on.
- Pipeline pack 0.3.0 and the 0.8.0 installer are built. Stage M8 of `docs/TESTING.md` is written, with every M8 PRD line checked by a test or a screenshot.

### Critical files for implementation

- `E:\Dev\AIO Software\packages\schema\src\layers.ts`, `annotation.ts`, `ipc.ts`, `jobs.ts` (C0 contracts)
- `E:\Dev\AIO Software\packages\workspace\src\captures.ts` and `E:\Dev\AIO Software\apps\desktop\src\renderer\workspace\CompareControls.tsx`, `splitModel.ts`, `compare.ts` (C1, extending Compare dates)
- `E:\Dev\AIO Software\packages\ai\src\providers.ts`, `main.ts`, `routes.ts` (C7: the existing local provider seam; the `build` route for C5)
- `E:\Dev\AIO Software\apps\desktop\src\main\maskAssist.ts` (C6: the existing `OrtLike` and onnxruntime seam)
- `E:\Dev\AIO Software\python\src\aio_pipelines\pipelines.py` and `pointcloud.py` (C2, C3 and C5 pipelines; PDAL discovery)
- `tools/demo/build-demo.mjs` and `tools/demo/scene.mjs` on `integration/m7` (C8 synthetic data)
