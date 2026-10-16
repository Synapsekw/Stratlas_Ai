# Cloud ground Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A point cloud or model that floats above (or sinks below) the site can be put on the ground without rewriting its file: a per-layer height offset for point clouds, a "Drop to ground" action for clouds and models, an automatic offset for Bentley `.zpc` clouds at import, and a street map that lowers under clouds as it does under models.

**Architecture:** The offset is one optional manifest field, `heightOffsetM`, on `pointcloud` layers. The viewer applies it by decoding a COPC against a per-layer _frame origin_ `[E, N, H - heightOffsetM]` (png-packed: shifted chunk bounds), so every in-app reader of decoded points (picks, measures, cleanup, elevation ramp, ray casts) agrees with what is drawn; the cleanup recipes stay in file coordinates. Main and the pipelines add the offset to Z wherever a cloud is read against other data. "Drop to ground" is a renderer store like Align to: it measures the item's low point and the ground under its footprint, writes one `builder:updateLayers` patch per item, and shows a notice with Undo.

**Tech Stack:** TypeScript (zod schema, zustand stores, three.js viewer, Vitest), Electron e2e (Playwright), Python pipelines (PDAL, numpy, pytest).

**Spec:** The brief of 16 Oct 2026 (founder skipped the questions and asked for the full fix). The diagnosis: a Bentley `.zpc` test project's cloud floats about 31 m over its ortho because its heights are WGS84 ellipsoidal, the project's height H is about 0 at the origin, and the project's `verticalDatum.absAltOffsetM` (-30.81) is used for photos only; clouds get no vertical handling (`python/src/aio_pipelines/pointcloud.py` reprojects horizontally only; the viewer draws y = Z - origin H). This plan carries the decisions below as the spec of record.

## Decisions (for the founder)

1. **Field:** `heightOffsetM` (metres, added to the file's Z; absent means 0) on `pointcloud` layers only. The COPC is never rewritten. A model already has its `transform` (and `georef`), so models move through those, as Place model does.
2. **Where the offset applies:** the 3D view (COPC and png-packed), picks and measures, cleanup (clip box, brush and polygon are converted to file coordinates with the layer's frame origin), elevation colours, `layer:info` extent, `builder:layerExtents` (far-content check), the `layer:export` sidecar (`heightOffsetM` written, files unchanged), the street map's floor, Drop to ground, and every pipeline job that reads a cloud against other data (change, surfaces, survey prepare, cleanup and export, engineering model evidence, model fit, 3D Tiles). A cleaned copy (`pointcloud.clean` register) inherits its source's offset. A change result cloud has the offset baked in (it is computed in corrected heights) and gets none.
3. **kit-packed clouds** (legacy demo format, decoded without an origin) cannot take an offset: the project writer refuses it, and Drop to ground is greyed with a reason.
4. **Low point:** a cloud's low point is the 2nd percentile of its sampled point heights (`DROP_CLOUD_PERCENTILE = 0.02`), so stray points below the ground are ignored. A model's low point is its lowest vertex (scene box `min.y`): models have no noise, and a percentile would lift a model whose base has few vertices.
5. **Ground:** the DSM, sampled straight down on a 7 x 7 grid over the item's footprint (its plan box); with at least 5 hits the ground is the 10th percentile of the hits. Otherwise the project ground level, y = 0 (origin H, where the ortho and the stage ground lie). Terrain packs and the street map are never the ground: they are laid under the content itself (`settleUnder`) and are on another datum.
6. **Which models:** every `mesh` layer except change results (`derived.kind === 'change'`) and drafts (`derived.draft`). Engineering models (`derived.kind === 'model'`) and georeferenced models get their `georef` rewritten with the transform through `layerTransformToGeoref(..., 'place-model')`, as Place model saves.
7. **Import:** a cloud from a Bentley `.zpc` whose tiles declare no vertical CRS, in a project with `verticalDatum.absAltOffsetM`, gets `heightOffsetM = absAltOffsetM` (rounded to mm) and a log line. A generic LAS/LAZ gets **no** automatic offset (nothing in a LAS without a vertical CRS says its heights are ellipsoidal); the job logs a hint to use Drop to ground instead. A re-import of the same file leaves an existing layer's offset alone.
8. **Undo:** one notice per drop with Undo and Redo (Ctrl+Z / Ctrl+Y while it shows), tied to the project it was raised for, like Align to. Setting the offset in Properties goes through the same store and notice.

## Global Constraints

- TypeScript strict, no `any`, no non-null assertions; packages export from `src/index.ts` and keep the SPEC section 2 dependencies (`@aio/pointcloud` already depends on `@aio/schema`, `@aio/geo`, `@aio/engine`, `@aio/workspace`).
- Renderer never imports `electron` or `node:*`.
- No em or en dashes in user-facing text; strings live in `packages/ui/src/i18n/en.ts` only.
- Public repo: no client, site or person names in code, tests, docs, commits.
- Heights are rounded to the millimetre where written (`Math.round(v * 1000) / 1000`, Python `round(v, 3)`).
- `heightOffsetM` range: finite, `-2000 <= v <= 2000` (as `absAltOffsetM`).
- Conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; `pnpm check` green; changed e2e specs run the CI way (CONTRIBUTING.md, "End to end the way CI runs it") with `--workers=1`.
- Contract change: one row in `docs/architecture/contract-changes.md` (Task 1).

## Review Focus

1. **A cloud that is hidden or has not streamed yet** when Drop to ground is chosen: no write, a notice "has not loaded yet" (Task 9 test `refuses a cloud with no height samples`).
2. **A DSM that covers only part of the footprint** (fewer than 5 of 49 samples hit): the project ground level is used and the notice says so (Task 9 test `falls back to the project ground with too few DSM hits`).
3. **Re-importing the same `.zpc`** after the person dropped it: the existing layer's offset is kept, not reset to `absAltOffsetM` (Task 3 test `test_reimport_keeps_the_layer_offset`).
4. **Cleaning an offset cloud:** a clip box drawn round the shifted cloud removes the same points in the save job as in the preview (Task 7 test `converts the clip box with the layer frame origin`).
5. **Undo after switching projects:** the notice goes, and its Undo never writes into the other project (Task 9 test `drops the notice and writes nothing when another project opens`).

---

## Execution DAG

| Task | Title                                                  | Depends on | Packages                            | Model                |
| ---- | ------------------------------------------------------ | ---------- | ----------------------------------- | -------------------- |
| 1    | Schema field, patch and frame origin                   | none       | `@aio/schema`, docs                 | sonnet               |
| 2    | Python offset helper                                   | none       | python                              | haiku                |
| 3    | Import: automatic offset for Bentley clouds            | none       | python                              | sonnet               |
| 4    | Project writer, extents, export sidecar                | 1          | `@aio/project`                      | sonnet               |
| 5    | Pipelines: surfaces and survey jobs                    | 2          | python                              | sonnet               |
| 6    | Pipelines: cloud change                                | 2          | python                              | opus                 |
| 7    | Viewer: frame origin, cleanup, low height              | 1          | `@aio/pointcloud`, desktop renderer | opus                 |
| 8    | Pipelines: evidence, model fit, cleanup copy, 3D Tiles | 2          | python                              | sonnet               |
| 9    | Drop to ground store, notice and strings               | 4, 7       | desktop renderer, `@aio/ui` (en.ts) | sonnet (opus review) |
| 10   | Street map floor under clouds                          | 7          | desktop renderer                    | sonnet               |
| 11   | Menu action and Properties field                       | 9          | desktop renderer                    | sonnet               |
| 12   | Docs: known limits and guide                           | 9          | docs                                | haiku                |
| 13   | End to end specs                                       | 3, 10, 11  | desktop e2e                         | sonnet               |

**Parallel batches** (no shared files inside a batch; dispatch each batch in one message):

- **Batch A:** 1, 2, 3
- **Batch B:** 4, 5, 6, 7, 8 (4 and 7 need 1; 5, 6, 8 need 2)
- **Batch C:** 9, 10 (9 needs 4 and 7; 10 needs 7)
- **Batch D:** 11, 12
- **Batch E:** 13, then the whole-branch review and `pnpm check`

**Critical path:** 1 -> 7 -> 9 -> 11 -> 13.

**Shared-file owners** (only this task edits the file): `packages/ui/src/i18n/en.ts` Task 9 (it adds every string of Tasks 9 and 11); `docs/architecture/data-conventions.md` Task 1; `python/src/aio_pipelines/change/sources.py` Task 2; `apps/desktop/src/renderer/builder/AlignToNotice.tsx` Task 9.

**Contract change:** Task 1 (manifest field, `LayerPatch` variant, `layer:export` sidecar key, `@aio/schema` helper `cloudFrameOrigin`).

**e2e specs:** new `apps/desktop/e2e/drop-to-ground.spec.ts` (synthetic COPC and tiny GLB; needs no demo build, runs everywhere); changed `apps/desktop/e2e/bentley-import.spec.ts` (needs PDAL and the pipeline Python, skips without them as today). Before running, build demos as CI does (`pnpm demo:build --quick`).

---

### Task 1: Schema field, patch and frame origin

**Files:**

- Modify: `packages/schema/src/layers.ts` (pointcloud variant, about line 186)
- Create: `packages/schema/src/cloudFrame.ts`
- Modify: `packages/schema/src/index.ts` (export)
- Modify: `packages/schema/src/builder.ts:206-247` (`LayerPatch`)
- Test: `packages/schema/src/layers.test.ts`, `packages/schema/src/builder.test.ts`, create `packages/schema/src/cloudFrame.test.ts`
- Docs: `docs/architecture/contract-changes.md` (new row, date 2026-10-16), `docs/architecture/data-conventions.md` section 4 (the offset and the frame origin) and section 36 (the import rule of Decision 7)

**Interfaces:**

- Produces: `Layer` pointcloud gains `heightOffsetM?: number` (`z.number().min(-2000).max(2000).optional()`, doc comment: metres added to the file's heights, never written into the file).
- Produces: `LayerPatch` gains `z.object({ heightOffsetM: z.number().min(-2000).max(2000).nullable() }).strict()` (`null` clears).
- Produces: `cloudFrameOrigin(origin: Vec3, layer: { heightOffsetM?: number }): Vec3` returning `[origin[0], origin[1], origin[2] - (layer.heightOffsetM ?? 0)]`. Doc: "The origin a cloud's file coordinates are taken from, so that y = Z - H + heightOffsetM."

- [ ] **Step 1: Write the failing tests**
  - `layers.test.ts` `it('keeps a point cloud height offset')`: `Layer.parse({ kind: 'pointcloud', id: 'c', name: 'C', src: { path: 'c.laz' }, format: 'copc', heightOffsetM: -30.81 }).heightOffsetM` is `-30.81`; `it('refuses a height offset beyond 2000 m')`: `safeParse` with `2500` fails.
  - `builder.test.ts` `it('takes a height offset patch and null')`: `LayerPatch.parse({ heightOffsetM: 12.5 })` and `{ heightOffsetM: null }` pass; `{ heightOffsetM: 1, name: 'x' }` fails.
  - `cloudFrame.test.ts` `it('lowers the frame origin by the offset')`: `cloudFrameOrigin([500000, 3200000, 10], { heightOffsetM: -30.81 })` equals `[500000, 3200000, 40.81]`; no offset gives the origin unchanged.
- [ ] **Step 2:** Run `pnpm --filter @aio/schema test` and see the new tests fail.
- [ ] **Step 3:** Implement the field, the patch variant and `cloudFrameOrigin`; export from `index.ts`.
- [ ] **Step 4:** Run `pnpm --filter @aio/schema test` and `pnpm --filter @aio/schema typecheck`: pass. `pnpm typecheck` at the root will now flag `patchLayers` (Task 4) only if the union is exhaustively narrowed there; if it does, note it for Task 4 and do not edit `create.ts`.
- [ ] **Step 5:** Write the contract row: "Point cloud layers gain optional `heightOffsetM` (metres added to the file's Z, -2000..2000; the file is not rewritten). `LayerPatch` gains `{ heightOffsetM: number | null }` (point clouds other than kit-packed; `null` clears). `@aio/schema` `cloudFrameOrigin(origin, layer)`. The `layer:export` sidecar of a cloud carries `heightOffsetM`. Builds before this ignore the field and drop it on their next manifest save (the cloud then shows at its file heights)." Update data-conventions sections 4 and 36.
- [ ] **Step 6:** Commit `feat(schema): point cloud height offset`.

### Task 2: Python offset helper

**Files:**

- Modify: `python/src/aio_pipelines/change/sources.py`
- Test: `python/tests/test_change_sources.py`

**Interfaces:**

- Produces: `height_offset_m(layer: dict[str, Any]) -> float` in `aio_pipelines.change.sources`: `float(layer.get("heightOffsetM") or 0.0)`; a non-number or non-finite value counts as 0.

- [ ] **Step 1:** Tests `test_height_offset_reads_the_layer` (`{"heightOffsetM": -30.81}` gives `-30.81`), `test_height_offset_defaults_to_zero` (missing, `None`, `"x"`, `float("nan")` give `0.0`).
- [ ] **Step 2:** `cd python; uv run pytest tests/test_change_sources.py -k height_offset -q`: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command: PASS.
- [ ] **Step 5:** Commit `feat(pipelines): height offset helper`.

### Task 3: Import: automatic offset for Bentley clouds

**Files:**

- Modify: `python/src/aio_pipelines/pointcloud.py` (`convert_zpc` about 546-612, `PointcloudToCopc.plan` `convert` 665-706 and `register` 709-744)
- Test: `python/tests/test_pointcloud_zpc.py`, `python/tests/test_pointcloud.py`

**Interfaces:**

- Produces: `has_vertical_crs(srs: dict[str, Any]) -> bool` in `pointcloud.py`: true when PDAL's summary names a vertical CRS (a non-empty `srs["vertical"]`, or a WKT or PROJJSON that is compound or carries a vertical part: `COMPD_CS`, `COMPOUNDCRS`, `VERT_CS`, `VERTCRS`, PROJJSON `type` `CompoundCRS`).
- Produces: the `convert` step's output gains `"source": "zpc" | "file"` and `"vertical": bool` (any tile, or the file, declares a vertical CRS). `convert_zpc` returns them too.
- Produces: a new layer written by `register` carries `heightOffsetM` per Decision 7.

- [ ] **Step 1: Write the failing tests** (monkeypatch `read_summary` / the convert output as the existing zpc tests do)
  - `test_has_vertical_crs_reads_compound_and_vertical` (a compound WKT, `{"vertical": "EGM96 height"}` true; a plain projected WKT and `{}` false).
  - `test_a_zpc_without_vertical_crs_takes_the_project_offset`: manifest with `"verticalDatum": {"absAltOffsetM": -30.81}`, convert output `{"source": "zpc", "vertical": False}`; the new layer has `heightOffsetM == -30.81` and the log has a line containing `-30.81 m` and `Drop to ground`.
  - `test_a_zpc_with_a_vertical_crs_gets_no_offset` and `test_a_project_without_a_height_offset_gives_none`: no `heightOffsetM` key.
  - `test_a_las_never_gets_an_automatic_offset` (in `test_pointcloud.py`): source `file`, no vertical CRS, project with the offset: no key, and a log line suggesting Drop to ground.
  - `test_reimport_keeps_the_layer_offset`: an existing layer for the same `out` with `heightOffsetM: -5` stays `-5`.
- [ ] **Step 2:** `uv run pytest tests/test_pointcloud_zpc.py tests/test_pointcloud.py -q`: the new ones FAIL.
- [ ] **Step 3:** Implement. Log lines (exact): zpc: `f"The tiles name no height datum; heights are taken as ellipsoidal (a Bentley export) and shifted by the project's height offset, {off:+.2f} m. The points are unchanged; use Drop to ground if the cloud is off."` LAS hint (only when the project has `absAltOffsetM` and the file has no vertical CRS): `"The file names no height datum; its heights are used as they are. If the cloud floats or sinks, use Drop to ground."`
- [ ] **Step 4:** Same command: PASS; then `uv run pytest tests -k "pointcloud or zpc" -q`.
- [ ] **Step 5:** Commit `feat(pipelines): bentley clouds take the project height offset`.

### Task 4: Project writer, extents, export sidecar

**Files:**

- Modify: `packages/project/src/builder/create.ts` (`patchLayers`, before the video fall-through about line 270; update the doc comment at 104-116)
- Modify: `packages/project/src/builder/extents.ts:102-107` (`layerExtent` copc branch; png-packed branch adds the offset to `bounds` y)
- Modify: `packages/project/src/builder/layerFiles.ts:68-79` (`crsSidecar`)
- Test: create `packages/project/src/builder/heightOffset.test.ts` (pattern: `rename.test.ts`), `extents.test.ts`, `layerFiles.test.ts`

**Interfaces:**

- Consumes: Task 1 field and patch.
- Produces: `builder:updateLayers` with `{ heightOffsetM }` sets it (mm rounding) on COPC and png-packed clouds; `0` or `null` removes the key; any other kind throws `` `"${name}" is not a point cloud; only point clouds take a height offset.` ``; kit-packed throws `` `"${name}" is a kit-packed cloud, which cannot be moved.` ``

- [ ] **Step 1: Write the failing tests**
  - `heightOffset.test.ts`: `it('sets, rounds and clears a cloud height offset')` (12.34567 -> 12.346; null and 0 delete the key; nothing else of the layer changes); `it('refuses a height offset on a model and on a kit-packed cloud')`.
  - `extents.test.ts` `it('lifts a COPC extent by its height offset')`: the synthetic COPC fixture with `heightOffsetM: 10` gives `min[1]` and `max[1]` 10 m above the same layer without it; png-packed likewise.
  - `layerFiles.test.ts` `it('writes the cloud height offset into the sidecar')`: `crsSidecar(m, cloudWithOffset).heightOffsetM === -30.81`; a cloud without one has no key.
- [ ] **Step 2:** `pnpm --filter @aio/project test -- heightOffset extents layerFiles`: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command, then `pnpm --filter @aio/project typecheck`: PASS.
- [ ] **Step 5:** Commit `feat(project): save a cloud height offset`.

### Task 5: Pipelines: surfaces and survey jobs

**Files:**

- Modify: `python/src/aio_pipelines/change/surface.py` (`Surface.points`, about 148-201: add the offset to local y in the kit-packed, plain LAS and COPC branches)
- Modify: `python/src/aio_pipelines/survey/cleanup.py:~303` (`run_dtm_filter` LAS branch: add to z; the kit-packed branch already gets it through `Surface.points`)
- Modify: `python/src/aio_pipelines/survey/prepare.py:494-505` (fingerprint includes the layer's offset; `read_cloud` gets it from `Surface.points`, add nothing there)
- Modify: `python/src/aio_pipelines/survey/export.py:~834-875` (`export_cloud`: add to `xyz[:, 2]` before `frame.forward_xyz` for LAS and for cleanup after `cleaned_las`; the kit-packed branch gets it already)
- Test: `python/tests/test_change_surface.py`, `test_survey_cleanup.py`, `test_survey_prepare.py`, `test_survey_export.py`

**Interfaces:** Consumes `height_offset_m` (Task 2).

- [ ] **Step 1:** Tests, each with a layer `heightOffsetM: 5.0` against the same layer without it: `test_surface_points_carry_the_height_offset` (every y +5, x and z equal, all three formats the module reads); `test_dtm_filter_reads_offset_heights`; `test_prepare_reruns_when_the_offset_changes` (fingerprint differs) and `test_prepare_heights_carry_the_offset`; `test_export_cloud_carries_the_offset` (exported Z +5).
- [ ] **Step 2:** `uv run pytest tests/test_change_surface.py tests/test_survey_cleanup.py tests/test_survey_prepare.py tests/test_survey_export.py -q`: the new ones FAIL.
- [ ] **Step 3:** Implement, without counting the offset twice where `Surface.points` already applied it.
- [ ] **Step 4:** Same command: PASS.
- [ ] **Step 5:** Commit `fix(pipelines): surfaces and survey read cloud heights with the offset`.

### Task 6: Pipelines: cloud change

**Files:**

- Modify: `python/src/aio_pipelines/change/cloud.py` (`prepare`/`context` keep each side's offset in `prep`; `PdalSource.read` about 727 adds it to `las.xyz` z; PDAL `bounds` z ranges about 862 and 893 and the `_info` z bounds are shifted by minus the offset; the distance layer about 1047 gets no offset)
- Test: `python/tests/test_change_cloud.py`

**Interfaces:** Consumes `height_offset_m`.

- [ ] **Step 1:** Tests: `test_cloud_change_applies_each_side_offset` (cloud B identical to A but its file 5 m higher and `heightOffsetM: -5`: distances about 0); `test_cloud_change_crop_bounds_follow_the_offset` (the z range sent to PDAL for B is in file heights); `test_the_change_layer_has_no_offset`.
- [ ] **Step 2:** `uv run pytest tests/test_change_cloud.py -q`: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command: PASS.
- [ ] **Step 5:** Commit `fix(pipelines): cloud change reads heights with the offset`.

### Task 7: Viewer: frame origin, cleanup, low height

**Files:**

- Modify: `packages/pointcloud/src/adapter.ts` (`create` COPC branch and `followNoise`: pass `cloudFrameOrigin(originOf(), layer)` to `loadCopc`; png-packed: shift each chunk seed's `bounds` y and, when explicit, `quant.offset[1]` by the offset, and the framing `box`)
- Modify: `packages/pointcloud/src/heights.ts` (new pure `lowHeight`)
- Modify: `packages/pointcloud/src/manager.ts` (new method `CloudManager.lowHeight(layerId, p)`)
- Modify: `packages/pointcloud/src/index.ts` (export `cloudLowHeight`, `lowHeight`)
- Modify: `apps/desktop/src/renderer/pointcloud/cleanupScene.ts:101` and every other `manifest.origin` read under `apps/desktop/src/renderer/pointcloud/` that converts a cloud's local coordinates to file coordinates (grep them): use the layer's `cloudFrameOrigin`
- Test: `packages/pointcloud/src/adapter.test.ts`, `packages/pointcloud/src/heights.test.ts`, `apps/desktop/src/renderer/pointcloud/cleanupScene.test.ts`

**Interfaces:**

- Consumes: `cloudFrameOrigin` (Task 1).
- Produces: `lowHeight(samples: readonly HeightSample[], p: number): number | null` (weighted percentile, as `robustHeightRange`; null without a finite height).
- Produces: `cloudLowHeight(handle: SceneHandle, layerId: string, p = 0.02): number | null` (adapter.ts, next to `cloudWorldBounds`): local y of the layer's coarsest decoded LOD samples; null when the layer is unknown, hidden in the manager, or has no samples yet.

- [ ] **Step 1: Write the failing tests**
  - `adapter.test.ts` `it('streams a COPC from the layer frame origin')`: with `origin: () => [0, 0, 100]` and a layer `heightOffsetM: -30`, `loadCopc` sees origin `[0, 0, 130]` (assert through the chunk seeds' `source.origin`); `it('lifts png-packed chunks by the offset')`: seeds' `bounds.min[1]` and `max[1]` +2 for `heightOffsetM: 2`.
  - `heights.test.ts` `it('takes a low percentile that ignores a stray point')`: 999 heights at 10 and one at -50, `lowHeight([...], 0.02)` is 10; empty gives null.
  - `cleanupScene.test.ts` `it('converts the clip box with the layer frame origin')`: a recipe clip box in file coordinates shows at local y lowered by the offset, and a box drawn there converts back to the same file coordinates.
- [ ] **Step 2:** `pnpm --filter @aio/pointcloud test -- adapter heights` and `pnpm --filter @aio/desktop test -- cleanupScene`: FAIL. (Use the package names in each `package.json` if they differ.)
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same commands: PASS; then `pnpm --filter @aio/pointcloud test` whole.
- [ ] **Step 5:** Commit `feat(pointcloud): draw a cloud at its height offset`.

### Task 8: Pipelines: evidence, model fit, cleanup copy, 3D Tiles

**Files:**

- Modify: `python/src/aio_pipelines/engineer/cloud.py` (`read_region` gains `offset_m: float = 0.0`, applied in `_stream_las`, the kit/png branch and `_world_bounds` z) and `python/src/aio_pipelines/engineer/pipeline.py:~316-318` (passes `height_offset_m(layer)`)
- Modify: `python/src/aio_pipelines/modelfit/segment.py` (`load_layer_points`, all three formats)
- Modify: `python/src/aio_pipelines/pointcloud_cleanup/pipeline.py:450-467` (`register`: the "(cleaned)" layer copies `heightOffsetM` from its source; the recipe evaluation stays in file coordinates)
- Modify: `python/src/aio_pipelines/tiles/cloud.py` (the `read` step passes the offset in `info`; `read_points` adds it to z before `crs_to_local` and shifts the cube's z)
- Test: `python/tests/test_engineer_cloud.py`, `test_modelfit.py`, `test_pccleanup_save.py`, `test_tiles.py`

**Interfaces:** Consumes `height_offset_m`.

- [ ] **Step 1:** Tests: `test_read_region_carries_the_offset` (and its bounds query in file heights); `test_fit_points_carry_the_offset`; `test_cleaned_copy_keeps_the_source_offset`; `test_cloud_tiles_carry_the_offset` (tile root z +5 for `heightOffsetM: 5`).
- [ ] **Step 2:** `uv run pytest tests/test_engineer_cloud.py tests/test_modelfit.py tests/test_pccleanup_save.py tests/test_tiles.py -q`: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command: PASS.
- [ ] **Step 5:** Commit `fix(pipelines): evidence, fit, cleanup and tiles keep the cloud offset`.

### Task 9: Drop to ground store, notice and strings

**Files:**

- Create: `apps/desktop/src/renderer/builder/dropToGround.ts` (pure planning)
- Create: `apps/desktop/src/renderer/builder/dropStore.ts` (store), `apps/desktop/src/renderer/builder/dropSession.ts` (the app instance and `useDrop`)
- Create: `apps/desktop/src/renderer/builder/DropNotice.tsx`
- Modify: `apps/desktop/src/renderer/builder/AlignToNotice.tsx` (export `otherUndo`; no behaviour change)
- Modify: `apps/desktop/src/renderer/exports/Toasts.tsx` (render `<DropNotice />` after `<AlignToNotice />`)
- Modify: `packages/ui/src/i18n/en.ts` (all strings below)
- Test: create `dropToGround.test.ts`, `dropStore.test.ts`, `DropNotice.test.tsx` next to them

**Interfaces:**

- Consumes: `LayerPatch` `{ heightOffsetM }` and Task 4's writer; `cloudLowHeight` (Task 7); `boundsOf`, `layerBox`-based `sceneBox` and `rayDown` from `shell/appBounds.ts` / `shell/layerBounds.ts`; `layerTransformToGeoref` (`@aio/geo`); `builder.getState().saveLayers(layerIds, patch)`.
- Produces in `dropToGround.ts`:
  - constants `DROP_CLOUD_PERCENTILE = 0.02`, `GROUND_GRID = 7`, `GROUND_PERCENTILE = 0.1`, `MIN_GROUND_HITS = 5`, `MIN_DROP_M = 0.05`
  - `percentile(values: readonly number[], p: number): number | null`
  - `groundUnder(box: Box, sample: (x: number, z: number) => number | null): { y: number; source: 'dsm' | 'project' }` (grid of `GROUND_GRID` x `GROUND_GRID` points spanning the box's x and z, inclusive)
  - `type DropItem = { kind: 'pointcloud'; layerId: string; name: string; low: number; heightOffsetM: number } | { kind: 'mesh'; layerId: string; name: string; low: number; transform: Mat4; georef?: Georef; placement?: Placement }`
  - `interface DropStep { layerId: string; name: string; shift: number; patch: LayerPatch; undo: LayerPatch }`
  - `planDrop(item: DropItem, groundY: number, project: ProjectGeo): DropStep | null` (null when `|groundY - low| < MIN_DROP_M`). Cloud: `patch = { heightOffsetM: r3(cur + shift) || null }`, `undo = { heightOffsetM: cur || null }`. Mesh: translation y (column-major element 13) plus `shift`; with a `georef`, `patch = { transform, georef: layerTransformToGeoref(transform, project, georef, 'place-model'), placement: 'placed' }` and `undo` the previous three; without, `{ transform }` both ways.
  - `formatShift(m: number): string` gives `"31.2 m"` (one decimal, absolute value; `formatDistance` from 1 km up).
  - `droppable(l: Layer): 'ok' | 'kit' | 'no'` (`ok`: COPC or png-packed cloud without `derived.kind === 'change'`, or a mesh without `derived.kind === 'change'` and not `derived.draft`; `kit`: a kit-packed cloud).
- Produces in `dropStore.ts`: `createDropStore(deps: DropDeps): StoreApi<DropStore>` with
  - `DropDeps { workspace: StoreApi<Workspace>; save(layerId: string, patch: LayerPatch): Promise<string | null>; low(layerId: string): Promise<number | null>; footprint(layerId: string): Promise<Box | null>; ground(x: number, z: number): number | null }`
  - `DropStore { notice: DropNotice | null; drop(layerIds: readonly string[]): Promise<void>; setOffset(layerId: string, heightOffsetM: number | null): Promise<void>; apply(): Promise<void>; dismiss(): void }`
  - `DropNotice { projectId: string | null; text: string; action: { kind: 'undo' | 'redo'; steps: { layerId: string; patch: LayerPatch }[] } | null }`
  - one run at a time (`busy`), re-reading the manifest after each await, as `alignToStore.ts` does; writes one layer at a time; a failed write stops there, keeps Undo for the ones done and shows the error; the notice goes when another project opens.
- Produces in `dropSession.ts`: `export const dropToGround = createDropStore({...})` wired to `builder.getState().saveLayers([id], patch)`, `cloudLowHeight(getActiveScene(), id, DROP_CLOUD_PERCENTILE)` for clouds and the scene box `min[1]` (else `layer:info` extent) for meshes, `boundsOf([id], appBoundsDeps())`, and ground from the DSM layers' `rayDown` (the same DSM rule as `groundAt`, sampled synchronously); `useDrop(selector)`.
- Strings (exact, `packages/ui/src/i18n/en.ts`):
  - `'actions.layer.dropToGround': 'Drop to ground'`
  - `'actions.reason.kitCloud': 'This cloud format cannot be moved.'`
  - `'drop.notice': 'Drop to ground'`
  - `'drop.lowered': 'Lowered {name} {distance} ({ground}).'`
  - `'drop.raised': 'Raised {name} {distance} ({ground}).'`
  - `'drop.many_one'` / `'drop.many_other'`: `'Moved {count} dataset onto the ground (largest move {distance}).'` / `'Moved {count} datasets onto the ground (largest move {distance}).'`
  - `'drop.onDsm': 'on the DSM'`, `'drop.onProject': 'to the project ground level'`
  - `'drop.inPlace': 'Already on the ground'`
  - `'drop.notLoaded': '{name} has not loaded yet. Show it, let it load, then try again.'`
  - `'drop.set': 'Height offset of {name} set to {distance}.'`
  - `'drop.undone': 'Drop undone.'`, `'drop.redone': 'Dropped again.'`
  - `'layerProps.heightOffset': 'Height offset'`, `'layerProps.heightOffsetSave': 'Save offset'`

- [ ] **Step 1: Write the failing tests**
  - `dropToGround.test.ts`: `it('lowers a cloud 31.2 m onto the project ground')` (`low` 31.2, offset 0, ground 0: patch `{ heightOffsetM: -31.2 }`, undo `{ heightOffsetM: null }`, shift -31.2); `it('adds to an existing offset and clears it at zero')`; `it('moves a model by its transform and rewrites its georef')` (element 13 changes by the shift, the patch has `georef` with `provenance.by === 'place-model'` and `placement: 'placed'`); `it('leaves an item within 5 cm')` (null); `it('uses the 10th percentile of the DSM hits')` (49 hits with two spikes); `it('falls back to the project ground with too few DSM hits')` (4 hits: `{ y: 0, source: 'project' }`); `it('names what cannot drop')` (`droppable` for kit-packed, change result, draft, photos).
  - `dropStore.test.ts` (fake deps): `it('drops two datasets and undoes both')` (one save per layer, notice text `Moved 2 datasets onto the ground (largest move 31.2 m).`, `apply()` writes the undo patches and the notice turns to Redo); `it('says Lowered for one cloud')` (exact `Lowered Cloud 31.2 m (to the project ground level).`); `it('refuses a cloud with no height samples')` (no save, `drop.notLoaded` text); `it('stops at a failed write and keeps undo for the ones done')`; `it('drops the notice and writes nothing when another project opens')`; `it('sets an offset from Properties with undo')`.
  - `DropNotice.test.tsx`: `it('shows the text and undoes on Ctrl+Z')` (testids `drop-notice`, `drop-text`, `drop-undo`/`drop-redo`), `it('leaves Ctrl+Z to a field')`.
- [ ] **Step 2:** `pnpm --filter @aio/desktop test -- dropToGround dropStore DropNotice`: FAIL.
- [ ] **Step 3:** Implement (strings first, then `dropToGround.ts`, the store, the session, the notice, `Toasts.tsx`).
- [ ] **Step 4:** Same command, then `pnpm --filter @aio/desktop typecheck` and `pnpm --filter @aio/ui test -- i18n`: PASS.
- [ ] **Step 5:** Commit `feat(desktop): drop to ground with undo`.

### Task 10: Street map floor under clouds

**Files:**

- Modify: `apps/desktop/src/renderer/workspace/siteBasemap.ts:331-346` (`contentFloor`)
- Test: `apps/desktop/src/renderer/workspace/siteBasemap.test.ts`

**Interfaces:**

- Consumes: `cloudLowHeight` (Task 7).
- Produces: `contentFloor(stage, manifest)` also takes, for each `pointcloud` layer, `cloudLowHeight(stage, l.id, 0.02)` when not null (null covers hidden and not yet streamed). Update the doc comment ("shown mesh and point cloud layers").

- [ ] **Step 1:** Tests (mock `@aio/pointcloud` `cloudLowHeight`): `it('lowers the floor under a cloud below the models')` (mesh min -1, cloud low -6: floor -6); `it('ignores a cloud with no samples or hidden')` (null: floor from the mesh).
- [ ] **Step 2:** `pnpm --filter @aio/desktop test -- siteBasemap`: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command: PASS.
- [ ] **Step 5:** Commit `fix(desktop): the street map goes under point clouds too`.

### Task 11: Menu action and Properties field

**Files:**

- Modify: `apps/desktop/src/renderer/shell/actions/kindActions.tsx` (new action after `mesh.place`, about line 221)
- Modify: `apps/desktop/src/renderer/shell/LayerProperties.tsx` (a "Height offset" row for clouds)
- Test: `apps/desktop/src/renderer/shell/actions/kindActions.test.ts` (mock `../../builder/dropSession` as the file mocks `alignSession`), `apps/desktop/src/renderer/shell/LayerProperties.test.tsx`

**Interfaces:**

- Consumes: `dropToGround` and `droppable` (Task 9), strings (Task 9), `editBlocked`.
- Produces: action `defineAction({ id: 'layer.dropToGround', label: 'actions.layer.dropToGround', icon: 'target', section: 'edit', targets: ['layers'], multi: true, testId: 'menu-drop-to-ground', ... })`: applies when every target layer's `droppable` is `ok` or `kit`; disabled by `editBlocked(ctx)`, else `t('actions.reason.kitCloud')` when any is `kit`; runs `dropToGround.getState().drop(tg.layerIds)`.
- Produces: in Properties, for a `pointcloud` layer that is not kit-packed: a row `layerProps.heightOffset` with a number input (`data-testid="layer-props-height-offset"`, step 0.01, metres, shows the current value or 0) and a button `layerProps.heightOffsetSave` (`data-testid="layer-props-height-save"`) that calls `dropToGround.getState().setOffset(id, v === 0 ? null : v)`; both hidden in a package and disabled for a reviewer (as Rename is).

- [ ] **Step 1:** Tests: `kindActions.test.ts` `it('offers Drop to ground on clouds and models, also marked together')`, `it('greys Drop to ground for a kit-packed cloud with its reason')`, `it('leaves Drop to ground off photos and change results')`, `it('drops the marked set')` (the mock's `drop` gets both ids). `LayerProperties.test.tsx` `it('edits a cloud height offset')` (type -30.81, Save: `setOffset('c', -30.81)`), `it('shows no height offset for a model or in a package')`.
- [ ] **Step 2:** `pnpm --filter @aio/desktop test -- kindActions LayerProperties parity`: the new ones FAIL (`parity.test.ts` must stay green).
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command: PASS.
- [ ] **Step 5:** Commit `feat(desktop): drop to ground in the dataset menu and properties`.

### Task 12: Docs: known limits and guide

**Files:**

- Modify: `docs/KNOWN-LIMITS.md` (the lines about heights taken as they are, about 248, 274 and 319, and the Bentley limits): clouds keep their file heights unless an offset is set; a Bentley `.zpc` without a height datum takes the project's height offset at import, which is right only when that offset is the ellipsoid to project height difference; generic LAS gets none; kit-packed clouds cannot be moved; a 3D Tiles set or a change result made before an offset changed keeps the old height (make it again); builds before this one ignore the offset and drop it on their next save; Bentley AT photos keep their heights as they are (use Align to).
- Modify: `docs/guide/03-scene.md` "Point clouds" (Drop to ground, the Properties height offset, the import rule)
- Modify: `docs/guide/44-engineering-models.md` "Place a model" (Drop to ground as the quick way to set a model's height; Place model for the rest)
- Check: `node tools/agent/check-public-text.mjs docs/KNOWN-LIMITS.md docs/guide/03-scene.md docs/guide/44-engineering-models.md`

- [ ] **Step 1:** Write the text (UI names exactly as Task 9's strings; no dashes).
- [ ] **Step 2:** `pnpm format:check` and the public-text check: pass.
- [ ] **Step 3:** Commit `docs: cloud heights and drop to ground`.

### Task 13: End to end specs

**Files:**

- Create: `apps/desktop/e2e/drop-to-ground.spec.ts`
- Modify: `apps/desktop/e2e/bentley-import.spec.ts`

**Interfaces:** Consumes everything above; the fixtures `test`, `tinyManifest`, `tinyGlb`, `openProject` (`e2e/fixtures.ts`), the synthetic COPC `packages/pointcloud/test-data/synthetic.copc.laz` (as `copc.spec.ts` seeds it), the row menu as `sidebar-menus.spec.ts` opens it.

- [ ] **Step 1: Write the specs**
  - `drop-to-ground.spec.ts` (header comment: synthetic data, off-screen, zero network; no `@realdata`):
    - `test('a floating cloud drops onto the project ground and Undo lifts it back')`: seed the synthetic COPC with `heightOffsetM: 31` (tiny manifest, no DSM). Open the project, wait for the scene canvas and for points (`perfStats().points > 0`). Right-click the cloud's row, click `menu-drop-to-ground`. Expect `drop-text` to match `/^Lowered Synthetic COPC cloud \d+\.\d m \(to the project ground level\)\.$/`. Read `manifest.json`: `heightOffsetM` equals `31 - shown distance` within 0.05. Poll the drawn points (walk the scene's `Points` as `readRamp` in `copc.spec.ts` does): their 2nd percentile local y is within 0.3 m of 0. Press Ctrl+Z on the scene: the manifest's `heightOffsetM` is back to 31 and `drop-redo` shows.
    - `test('a model and a cloud marked together drop in one step')`: add a tiny GLB mesh layer whose transform lifts it 12 m; mark both rows (Ctrl+click), right-click, Drop to ground. Expect `Moved 2 datasets onto the ground`. The mesh's new transform element 13 equals `-glbBounds(tinyGlb).min[1]` within 0.01 (the model's lowest vertex at y = 0).
  - `bentley-import.spec.ts`: the tiny project gets `verticalDatum: { absAltOffsetM: -30.81 }`; after the import, assert the cloud layer's `heightOffsetM === -30.81` (the synthetic `.zpc` names no height datum). Keep its PDAL and pipeline Python skips.
- [ ] **Step 2:** From `apps/desktop`: `pnpm demo:build --quick`, then in PowerShell `$env:QUADRION_WINDOW_SIZE = '1100x720'; $env:QUADRION_E2E_SCALE = '1'; $env:QUADRION_E2E_SWGL = 'warp'` and `npx playwright test e2e/drop-to-ground.spec.ts e2e/bentley-import.spec.ts --workers=1 --repeat-each=3`. The log prints `[e2e] window 1100 x 720 px at display scale 1`; all pass (the Bentley spec needs `AIO_PDAL` and the main checkout's venv as `QUADRION_E2E_PYTHON`; see the worktree e2e note).
- [ ] **Step 3:** Run neighbours the change can touch: `e2e/copc.spec.ts`, `e2e/align-to.spec.ts`, `e2e/sidebar-menus.spec.ts`, `e2e/pointcloud-noise.spec.ts`, the same way.
- [ ] **Step 4:** Commit `test(desktop): drop to ground end to end`.

## Finish

- [ ] `pnpm check` green; `cd python; uv run pytest -q` green for the touched suites (the full suite the CI way if time allows).
- [ ] Independent review of the whole branch on the strongest model (focus: the frame-origin consistency between viewer, cleanup and pipelines; the Review Focus list).
- [ ] Session note with a "How to test" walkthrough: open a project with a floating cloud, right-click the cloud in the sidebar, Drop to ground, see "Lowered ... m", check the street map sits under it, press Ctrl+Z; Properties shows and edits the height offset; right-click an engineering model, Drop to ground; import a Bentley `.zpc` into a project with a height offset and read the job log line.
