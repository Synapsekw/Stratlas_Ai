# Point cloud cleanup: design

Date: 2026-10-15. Branch: `feat/pointcloud-cleanup`. PRD: FUS-9 (box clip), ANN-4 (selection of points).

## Problem

Imported point clouds (for example an old Pix4D densified LAS of 21.7M points) are noisy: stray points in the air, low points under the ground, scaffolding and vehicles nobody wants. The app can only hide classes (the Classification legend, one global setting) and cut with one section plane (`packages/engine/src/tools/section.ts`). There is no clip box, no point selection or delete, no noise filter, no height filter, and export always writes the whole cloud.

## Goals

1. A clip box on a point cloud layer: drag handles in 3D, axis-aligned then rotatable about the vertical axis; outside (or inside) points hidden live; keep or reset; works together with the section plane.
2. Remove noise: one action that runs a PDAL statistical outlier filter (optionally `filters.elm` for low points) as a pipeline job, marks noise as class 7 so the legend hides it, shows how many points it marked, and can be undone.
3. Box or lasso select points in 3D, then hide, delete or set a class on them, each as one undo step.
4. A height range (min and max elevation) per layer.
5. Save cleaned copy: a new derived COPC layer; the original file is never changed. Point cloud export writes the cleaned version.
6. The actions are also in the layer's right-click menu.

Out of scope: editing single points by click, per-point painting, merging clouds, reprojection during cleanup, cleanup of `png-packed` or `kit-packed` clouds (COPC only; the panel says so for other formats).

## Founder decisions (15 Oct)

- All five pieces ship on one branch.
- Edits live as a **recipe per layer** in the project, shown live; nothing is rewritten until Save cleaned copy or Export. Undo removes the last step.
- Hidden classes become **per layer** (in the recipe) for clouds that have a recipe; the legend edits the selected cloud's set.
- **Hide** is view-only and kept in a saved copy; **Delete** removes points from saves and exports.
- Box rotation is about the vertical axis only.

## Why a recipe and not a list of points

The viewer holds only the loaded level-of-detail subset (default budget 6M points, `packages/pointcloud/src/settings.ts`), so a picked point list cannot cover a 21.7M cloud. Every edit is therefore geometric (a box, a screen-space lasso extruded through the view, a height range, a class rule) and is evaluated twice: live per chunk in the viewer, and over the full cloud in the pipeline. The noise step is the exception because it needs every point; it runs as a job that writes a working copy.

## Design

### 1. The recipe (contract)

New on-disk family `aio.pccleanup/1` (since 0.16), file `edits/pointcloud/<layerId>.json`, journaled like `edits/boundaries.json`. Zod schema `PointcloudCleanup` in `packages/schema/src/pointcloudCleanup.ts`:

```
{
  schema: 'aio.pccleanup/1',
  layerId: string,
  clipBox?: { center: [x,y,z], size: [sx,sy,sz], yaw: number /* radians about +Z */, keep: 'inside' | 'outside' },
  height?: { min?: number, max?: number },          // world elevation, project CRS units
  hiddenClasses: number[],                          // 0..255
  regions: Array<{
    id: string,
    shape: 'box' | 'lasso',
    viewProj: number[16],                           // column-major, world -> clip, at the time of drawing
    polygon: Array<[ndcX, ndcY]>,                   // 4 corners for box, 3..256 for lasso
    action: { kind: 'hide' } | { kind: 'delete' } | { kind: 'class', value: number },
  }>,
  noise?: { path: string /* project-relative COPC */, params: NoiseParams, marked: number, total: number, runId: string },
}
```

Coordinates are world (project CRS) like the layer's COPC header, not the viewer's local origin; the viewer converts with the layer's offset.

**Evaluation, per point, in order:**

1. Read class `c`: the point's class from the noise copy if present, else the original.
2. Apply regions in order: if the point projects (`viewProj`, `w > 0`) inside the polygon, `class` sets `c`, `hide` marks it hidden, `delete` marks it deleted. Later regions win over earlier ones on class. `hide` and `delete` marks accumulate and never undo each other: a point deleted by any region stays deleted, whatever the order of regions (a `hide` drawn over an earlier `delete` does not bring the point back).
3. Outside the clip box (or inside, for `keep: 'outside'`), or outside the height range: dropped.
4. `c` in `hiddenClasses`: hidden.

Boundaries are inclusive: a point exactly on a face of the clip box is inside it, and a point at exactly `height.min` or `height.max` is inside the range (polygon edges in NDC are not pinned). One outcome per point, by precedence: dropped, then deleted, then hidden by class, then hidden by a `hide` region, then kept. A point in a hidden class or hidden by class is therefore removed on save and export even when a `hide` region also covers it.

Viewer: dropped, hidden and deleted points are not drawn. Save and export: dropped, deleted and hidden-class points are removed. Points hidden by a `hide` region are kept. Set-class points are written with their new class.

The evaluator is written once in TypeScript (`packages/pointcloud/src/cleanup/evaluate.ts`) and once in Python (`python/src/aio_pipelines/pointcloud_cleanup/evaluate.py`, numpy). A shared vector file (`packages/schema/test-data/pccleanup-vectors.json`: recipes, points, expected per-point outcome) is checked by tests on both sides, so viewer and output agree.

### 2. Undo

A renderer store per layer keeps the recipe history (snapshots, cap 50). Each user edit is one step: a region, a clip-box drag on release, a height change on commit, a class toggle, a noise run, Reset. Ctrl+Z / Ctrl+Shift+Z work while the Clean up panel or a cleanup tool is active, and a toast offers Undo after delete, set class, noise and reset. Every step writes the recipe file through a new IPC channel `pointcloud:writeCleanup { projectId, layerId, recipe | null }` (validates, atomic write with `.bak`, journaled). Undoing a noise run clears `recipe.noise`; the working copy moves to `.trash/` on the next save or when the recipe is reset.

### 3. Viewer

- **Clip box and height range**: shader uniforms in `packages/pointcloud/src/material.ts` (`uBoxInv` mat4, `uBoxOn`, `uBoxKeepInside`, `uZMin`, `uZMax`), tested in the same off-screen path as hidden classes. They are separate from the section plane, so both apply. `pick.ts` and `drawnPoints()` honour them on the CPU.
- **Regions and per-layer classes**: a new `aMask` Uint8 attribute per chunk (0 shown, 1 hidden). A region's set-class result is written into a per-chunk class override (`aClass` copy). Both are computed when a chunk uploads and recomputed for loaded chunks when the recipe changes. The work goes through the existing worker pool for chunks above 50k points. `uClassShown` is driven by the layer's `hiddenClasses` when the layer has a recipe, else by the global setting.
- **Noise copy**: when `recipe.noise` is set, the layer streams `noise.path` instead of `src.path` (same `copcLayer` code; the manager swaps the source and reloads the layer's chunks).
- **Clip box gizmo**: a new engine tool `clipbox` (the closed `StageTool` union gains it), `packages/engine/src/tools/clipbox.ts`: a wire box, 6 face handles (drag along the face normal, snaps to 0.1 m), a yaw ring on the top face, and the size readout. Fit to layer sets the box to the layer bounds. Releasing a drag commits one undo step.
- **Selection tool**: a new tool `pcselect`, `packages/engine/src/tools/pcselect.ts`, drawing a screen rectangle (Box) or a freehand path (Lasso, simplified to at most 256 vertices) in an overlay. On release it records `viewProj` and the polygon, counts the loaded drawn points inside, and shows a bar: "N loaded points selected" with Hide, Delete, Set class (class list from `classes.ts`) and Cancel. Escape cancels.

### 4. Pipeline (pack bump)

New pipeline `pointcloud.clean` (`PointcloudCleanParams`), module `python/src/aio_pipelines/pointcloud_cleanup/`, registered in `pipelines.py`; `MANIFEST_WRITERS` in the renderer gets it.

- `mode: 'noise'`, params `{ layerId, src, outlier: { meanK: 8, multiplier: 2.0 }, elm?: { cell: 10, threshold: 1.0 } }`: PDAL `readers.copc` to `filters.outlier` (`method: statistical`) plus optional `filters.elm`; both set class 7 on outliers (other classes untouched). Writes `edits/pointcloud/<layerId>.noise-<runId>.copc.laz` through `cloud_out.write_copc` (untwine, keeps classes). Returns `{ path, marked, total }`. The renderer then writes `recipe.noise`. Defaults are shown in a settings disclosure. After a run the panel shows "N points (x%) marked as noise", the legend's class 7 row is hidden by default, and there is Undo.
- `mode: 'save'`, params `{ layerId, src, recipe, name }`: PDAL `readers.copc` (on `noise.path` when set) to staged LAS, the numpy evaluator applies the recipe by streaming over the LAS records (chunks of 2M points, memory bounded), then `write_copc` writes `clouds/<newId>.copc.laz`. A new layer is appended to the manifest: `{ kind: 'pointcloud', format: 'copc', name: '<name> (cleaned)', derived: { kind: 'cleanup', source: [layerId], runId } }`. The original layer is hidden and its file is untouched.
- `survey.export` with `what: 'cloud'` gains an optional `cleanup` (a recipe object). The export applies the same evaluator on its staged LAS before writing LAS or LAZ.
- `tools/pipeline-pack/pdal.mjs` `DRIVERS` and its test add `filters.outlier` and `filters.elm`.
- Pack version: the next free version at merge time; bentley-import took 0.10.0, engineering-model expects 0.11.0, this branch is provisionally 0.12.0. `POINTCLOUD_CLEAN_MIN_PACK` in `packages/schema/src/pointcloudCleanup.ts` matches it; with an older pack the noise run and save show "Update the pipeline pack in Settings > Processing tools". The live tools (clip box, height, regions) work with any pack.

**Contract changes** (rows in `docs/architecture/contract-changes.md`):

- `aio.pccleanup/1` family (since 0.16).
- `LayerDerived.kind` gains `'cleanup'`.
- `PipelineName` gains `pointcloud.clean` (`PointcloudCleanParams`).
- `SurveyExportParams` gains optional `cleanup`.
- IPC `pointcloud:writeCleanup` and `pointcloud:readCleanup`.

All are additive, with compat fixtures in `tools/compat`.

### 5. UI

- **Clean up panel**: a stage toolbar button next to Cutaway (`apps/desktop/src/renderer/workspace/StageTools.tsx`), acting on the selected point cloud layer (or the only one). Sections:
  - Clip box: Edit (activates the gizmo), Fit to layer, Keep inside / outside, Reset.
  - Height range: min and max fields plus a two-thumb slider over the layer's z range.
  - Select: Box, Lasso.
  - Remove noise: Run, a Settings disclosure, the result line, Undo.
  - Save cleaned copy: a name field and Save, with job progress in the jobs tray.
  - Footer: Undo and Redo buttons, and Reset all cleanup.
- Built with the design skills (`impeccable`, `frontend-design`) and the existing panel styles. Strings go in `packages/ui/src/i18n/en.ts`.
- **Right-click menu** on a point cloud layer row: Clean up..., Remove noise..., Save cleaned copy..., Reset cleanup. Today these go in `DateMenus.tsx` (`LayerDateMenu`), gated on `kind === 'pointcloud'` and COPC. The sidebar context-menu session (`feat/sidebar-context-menus`) will move them into its shared action registry when it rebases. To make that easy, each action is a plain record in `apps/desktop/src/renderer/pointcloud/cleanupActions.ts` with the shape `{ id: 'pointcloud.cleanup' | 'pointcloud.removeNoise' | 'pointcloud.saveCleaned' | 'pointcloud.resetCleanup', label: <i18n key>, applies(target) -> boolean, multi: false, run(target, ctx) }`. The menu items call `run`, with no handler logic inline in JSX.
- **Export dialog** (`ExportDialog.tsx`): for a cloud with a recipe, an "Apply cleanup" checkbox, on by default, with a one-line summary of what it removes.

### 6. Errors and limits

- A recipe whose layer is gone is ignored and cleaned up on project open.
- A noise or save job failure leaves the recipe unchanged and shows the job error. A cancelled job leaves no files (staging only).
- Save on a cloud above the in-memory COPC budget uses untwine (out of core). A disk-space check (`check_space`) runs before the staged LAS.
- Regions are capped at 200 per layer. The panel suggests saving a cleaned copy when the cap is near.
- Region and clip edits on a `png-packed` or `kit-packed` cloud are disabled with a hint, since those formats have no COPC source to save from.

## Testing

- **Vitest**:
  - The TS evaluator against the shared vectors.
  - The material uniforms and `aMask`.
  - Pick and `drawnPoints` with box, height and mask.
  - Gizmo handle math (drag along a normal, yaw).
  - Lasso simplification and the point-in-polygon test.
  - The undo store.
  - Schema and compat fixtures.
  - The IPC handler (validation and atomic write).
- **Pytest**:
  - The Python evaluator against the same vectors.
  - Noise on a synthetic cloud with planted outliers (marked count within tolerance, all other classes unchanged).
  - Save (output point count, classes, derived layer in the manifest, original untouched).
  - Export with a cleanup recipe.
  - The pack DRIVERS test.
- **e2e** (run the CI way, 1100 x 720, scale 1, WARP):
  - `pointcloud-clipbox.spec.ts`: fit, shrink with a handle, outside points not drawn, Reset restores.
  - `pointcloud-noise.spec.ts`: run noise on a COPC with planted outliers, count shown, class 7 hidden, Undo restores the original stream.
  - `pointcloud-clean-export.spec.ts`: a lasso delete plus a clip box, then Save cleaned copy (a new layer with the expected point count), then export LAZ (the expected point count read back with PDAL).

  The specs use a COPC fixture generated with planted outliers, built like `synthetic.copc.laz`.
