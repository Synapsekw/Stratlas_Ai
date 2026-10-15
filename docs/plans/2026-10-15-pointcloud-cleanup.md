# Point cloud cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clean up a COPC point cloud layer in place: a clip box with 3D handles, a height range, box and lasso selections that hide, delete or reclassify points, a PDAL noise run that marks noise as class 7, per-layer hidden classes, all as one recipe per layer with undo; then save a cleaned copy as a new layer or export the cleaned cloud.

**Architecture:** One recipe file per layer (`edits/pointcloud/<layerId>.json`, `aio.pccleanup/1`) is the only state. It is evaluated twice by the same rules: live in the viewer (shader uniforms for the clip box and height range, a per-chunk `aMask` and class override for selections, per-layer `uClassShown`) and over the full cloud in the pipeline (a numpy evaluator streaming over a staged LAS). A shared vector file pins both evaluators to the same answers. The renderer keeps the undo history (snapshots, cap 50) and writes every step through `pointcloud:writeCleanup`; the noise run and the cleaned copy are a new pipeline, `pointcloud.clean`, in a pack bump; `survey.export` applies the recipe on export.

**Tech Stack:** TypeScript, three.js `ShaderMaterial`, zustand, zod 4 (`@aio/schema`), React 19 (component tests with `createRoot` and `act`, jsdom pragma), Vitest, Electron main with validated `handle()` IPC, Python 3.13 with numpy, PDAL CLI 2.10 (`readers.copc`, `filters.outlier`, `filters.elm`, `writers.las`), untwine through `cloud_out.write_copc`, pytest, Playwright e2e.

**Spec:** `docs/plans/2026-10-15-pointcloud-cleanup-design.md` (approved by the founder on 15 Oct 2026). It is the source of truth; executors read it before their task.

## Global Constraints

- Work only in the worktree `E:\Dev\AIO Software\.claude\worktrees\pointcloud-cleanup` on branch `feat/pointcloud-cleanup`. Never edit the main checkout or another session's worktree.
- Stage files by path (`git add <path>`), never `git add -A` or `git add .`; never a bare `git stash` (the stash is shared by every worktree); never `--no-verify`. Parallel agents in one batch do not commit: the coordinator runs each task's commit step, one at a time, after the batch's agents have stopped (lint-staged backs up with a stash).
- Recipe file: `edits/pointcloud/<layerId>.json`, family `aio.pccleanup/1`, since `0.16`, journaled like `edits/boundaries.json` (a wrapped writer, one op per save).
- Recipe coordinates are world (project CRS, like the COPC header), never the viewer's local frame; the viewer converts with the project origin (`x = E - oE`, `y = H - oH`, `z = oN - N`).
- `clipBox`: `center` [E, N, H], `size` [east, north, up] metres, `yaw` radians about +Z (counter-clockwise seen from above, east toward north), `keep: 'inside' | 'outside'`. Rotation is about the vertical axis only.
- `height`: `{ min?, max? }`, world elevation, project CRS units.
- `hiddenClasses`: integers 0 to 255. For a layer with a recipe they replace the global hidden classes; the legend edits the selected cloud's set.
- `regions`: at most 200 per layer; `viewProj` is 16 numbers, column-major, world to clip at the time of drawing; `polygon` is NDC, 4 corners for a box, 3 to 256 vertices for a lasso; action `hide`, `delete` or `{ kind: 'class', value }`.
- Evaluation per point, in this order: class from the noise copy if present, else the original; regions in order (`w > 0` and inside the polygon: class sets the class, later regions win, `hide` marks hidden, `delete` marks deleted); outside the clip box (inside for `keep: 'outside'`) or outside the height range: dropped; class in `hiddenClasses`: hidden. Viewer: dropped, hidden and deleted are not drawn. Save and export: dropped, deleted and hidden-class points are removed; `hide` points are kept; set-class points are written with the new class.
- Outcome precedence (one outcome per point, used by both evaluators and the vectors): `dropped` > `deleted` > `classHidden` > `hidden` > `kept`.
- Noise defaults: `filters.outlier` `method: statistical`, `mean_k` 8, `multiplier` 2.0; optional `filters.elm` `cell` 10, `threshold` 1.0; both set class 7, other classes untouched. Working copy `edits/pointcloud/<layerId>.noise-<runId>.copc.laz` (runId is the job id).
- Save: `clouds/<newId>.copc.laz`, layer `{ kind: 'pointcloud', format: 'copc', name: '<name> (cleaned)', derived: { kind: 'cleanup', source: [layerId], runId } }`; the original layer is hidden, its file untouched. Save streams in chunks of 2,000,000 points.
- Undo: per layer, snapshots, cap 50. One step each: a region, a clip-box drag on release, a height change on commit, a class toggle, a noise run, Reset. Ctrl+Z and Ctrl+Shift+Z (and Ctrl+Y) while the Clean up panel or a cleanup tool is active. A notice offers Undo after delete, set class, noise and reset.
- Live tools (clip box, height, regions) work with any pipeline pack; the noise run and the save need `POINTCLOUD_CLEAN_MIN_PACK`, one constant in `packages/schema/src/pointcloudCleanup.ts` (0.10.0 if the engineering-model branch has not landed a 0.10.0 pack at merge time, else 0.11.0: a one-line change in Task 18).
- COPC only: region and clip edits on `png-packed` and `kit-packed` clouds are disabled with a hint.
- Engine tools: `clipbox` and `pcselect` join the closed `StageTool` union. Box face drags snap the size to 0.1 m (minimum 0.1 m); a lasso is simplified to at most 256 vertices; Escape cancels a selection.
- Selections are processed for chunks above 50,000 points in the decode worker pool.
- Right-click actions are plain records in `apps/desktop/src/renderer/pointcloud/cleanupActions.ts` with ids `pointcloud.cleanup`, `pointcloud.removeNoise`, `pointcloud.saveCleaned`, `pointcloud.resetCleanup`, `multi: false`; menu items call `run`, no handler logic in JSX.
- User-facing text: in `packages/ui/src/i18n/en.ts`, no emoji, no em or en dashes (`i18n.test.ts` checks some of it). Docs, session notes and commit messages carry no client, site or person names (`node tools/agent/check-public-text.mjs <files>`).
- Electron e2e windows stay off-screen through the existing fixtures (`e2e/fixtures.ts`); never launch the app another way. One Playwright run at a time, `--workers=1`.
- Python in this worktree: there is no `python/.venv` here. Run pytest with the main checkout's interpreter read-only, from `python/` of this worktree, with the worktree's code first on the path (`PYTHONPATH=src;tests`, `PYTHONDONTWRITEBYTECODE=1`). Never run `uv sync` here and never junction or symlink the main venv into the worktree: uv re-points the shared editable `aio-pipelines` install at the worktree. After any Python tooling, check `"E:\Dev\AIO Software\python\.venv\Scripts\python.exe" -c "import aio_pipelines; print(aio_pipelines.__file__)"` still names `E:\Dev\AIO Software\python\src`.
- `pnpm check` green on the branch before hand-off (the coordinator runs it once per batch, after the batch's commits).

## Review Focus

1. **A region drawn on a cloud whose project origin is far from zero** (UTM coordinates, origin [500000, 3200000, 5]): the selection must hit the same points in the viewer (local frame) as in the pipeline (world). Expected: the stored `viewProj` is world to clip and both evaluators agree. Tests: Task 3, "gives the same outcome in the local frame of a far origin as in world coordinates"; Task 14, "stores world-to-clip matrices that project a world point where the stage draws it".
2. **A lasso dragged for several seconds** (thousands of pointer samples, crossing itself): expected at most 256 vertices, the outline kept within a pixel or two, and the recipe accepted by the schema. Tests: Task 8, "simplifies a 5000-sample lasso to at most 256 vertices near the drawn path"; Task 1, "refuses a lasso of 257 vertices and a box of 3 corners".
3. **Remove noise on a cloud that has no new noise** (0 marked): expected the job succeeds with `marked: 0`, the recipe is not changed, the panel says nothing was marked, and the unused working copy goes to the trash on the next write. Tests: Task 11, "a cloud whose noise is already class 7 gives marked 0 and keeps every other class"; Task 14, "a noise run that marked nothing leaves the recipe as it was and says so".
4. **Save cleaned copy when the hidden classes cover every class of the cloud**: expected a clear refusal, no layer added, no file left in `clouds/`. Tests: Task 12, "refuses when the cleanup removes every point and adds nothing"; Task 13, "refuses an export that would remove every point".
5. **A recipe left behind after its layer was deleted** (the removal does not know the recipe file): expected the next project open ignores it, removes the file (kept as `.bak`) and moves its noise copies to the project trash. Tests: Task 10, "load sweeps recipes whose layer is gone"; Task 9, "a null recipe removes the file, keeps a .bak and trashes the layer's noise copies".

Also covered: export of a `png-packed` cloud with no recipe sends no `cleanup` and is unchanged (Task 13, "sends cleanup only for a cloud export with a recipe"; Task 16, "hides Apply cleanup for a cloud without a recipe"); a noise copy that fails to load falls back to the original stream (Task 6); undo of a noise run whose copy is still referenced by redo is not trashed (Task 9, "keeps copies the history still names"); writes that arrive out of order (Task 10, "writes one layer's steps in order").

---

## File Structure

| File                                                                                                                                          | Responsibility                                                                      | Task                   |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------- |
| `packages/schema/src/pointcloudCleanup.ts` (new)                                                                                              | recipe zod, `NoiseRun`, `PointcloudCleanParams`, paths, `POINTCLOUD_CLEAN_MIN_PACK` | 1 (18: version only)   |
| `packages/schema/src/pointcloudCleanup.test.ts` (new)                                                                                         | contract tests                                                                      | 1                      |
| `packages/schema/test-data/pccleanup-vectors.json` (new)                                                                                      | shared evaluator vectors                                                            | 1                      |
| `packages/schema/src/layers.ts`                                                                                                               | `LayerDerived.kind` gains `'cleanup'`                                               | 1                      |
| `packages/schema/src/jobs.ts`, `jobs.test.ts`                                                                                                 | `pointcloud.clean`, `SurveyExportParams.cleanup`                                    | 1                      |
| `packages/schema/src/ipc.ts`                                                                                                                  | `pointcloud:readCleanup`, `pointcloud:writeCleanup`                                 | 1                      |
| `packages/schema/src/versions.ts`, `index.ts`                                                                                                 | registry row, export                                                                | 1                      |
| `apps/desktop/src/preload/index.ts`                                                                                                           | channel whitelist                                                                   | 1                      |
| `apps/desktop/src/renderer/jobs.ts`                                                                                                           | `FORMS`, `MANIFEST_WRITERS`                                                         | 1                      |
| `apps/desktop/src/renderer/processing/pipelines.ts`                                                                                           | `PIPELINE_GROUP`, `JOB_KIND`                                                        | 1                      |
| `tools/compat/pointcloud-cleanup-additive.test.mjs` (new)                                                                                     | compat pins against schema-0.11                                                     | 1                      |
| `docs/architecture/contract-changes.md`                                                                                                       | five rows                                                                           | 1                      |
| `packages/ui/src/i18n/en.ts`                                                                                                                  | every new string                                                                    | 2                      |
| `packages/ui/src/shortcuts.ts`                                                                                                                | `cleanup` scope, undo and redo                                                      | 2                      |
| `packages/pointcloud/src/cleanup/frame.ts` (new)                                                                                              | local and world matrices, `mul4`, box inverse                                       | 3                      |
| `packages/pointcloud/src/cleanup/polygon.ts` (new)                                                                                            | even-odd point in polygon                                                           | 3                      |
| `packages/pointcloud/src/cleanup/evaluate.ts` (new)                                                                                           | compile and evaluate a recipe                                                       | 3                      |
| `packages/pointcloud/src/cleanup/store.ts` (new)                                                                                              | package-level live recipes store                                                    | 3                      |
| `packages/pointcloud/src/cleanup/evaluate.test.ts`, `store.test.ts` (new)                                                                     | vectors, frames                                                                     | 3                      |
| `packages/pointcloud/src/index.ts`                                                                                                            | exports                                                                             | 5 (B1), 3 (B2), 6 (B3) |
| `python/src/aio_pipelines/pointcloud_cleanup/__init__.py`, `recipe.py`, `evaluate.py`, `lasstream.py` (new)                                   | validation, numpy evaluator, LAS streaming                                          | 4                      |
| `python/tests/pccleanup_synth.py` (new)                                                                                                       | synthetic clouds with planted noise, COPC helper                                    | 4                      |
| `python/tests/test_pccleanup_evaluate.py`, `test_pccleanup_lasstream.py` (new)                                                                | vectors, streaming                                                                  | 4                      |
| `packages/pointcloud/src/material.ts`, `material.test.ts`                                                                                     | box, height and mask uniforms                                                       | 5                      |
| `packages/pointcloud/src/pick.ts`                                                                                                             | `drawnPoints` honours box, height, mask                                             | 5                      |
| `packages/pointcloud/src/cleanup/count.ts`, `cleanup/drawn.test.ts` (new)                                                                     | `countDrawn`                                                                        | 5                      |
| `packages/pointcloud/src/cleanup/chunk.ts`, `chunk.test.ts` (new)                                                                             | per-chunk mask and class override                                                   | 6                      |
| `packages/pointcloud/src/manager.ts`, `adapter.ts`, `protocol.ts`, `pool.ts`                                                                  | recipe application, noise source, mask jobs                                         | 6                      |
| `packages/pointcloud/src/cleanup/manager.test.ts` (new)                                                                                       | manager integration                                                                 | 6                      |
| `packages/engine/src/types.ts`, `stage/Stage.ts`, `index.ts`                                                                                  | `StageTool` union, cursor, exports                                                  | 7 (8: index export)    |
| `packages/engine/src/tools/clipbox.ts`, `clipbox.test.ts` (new)                                                                               | clip box gizmo                                                                      | 7                      |
| `packages/engine/src/tools/pcselect.ts`, `pcselect.test.ts` (new)                                                                             | box and lasso selection                                                             | 8                      |
| `apps/desktop/src/main/pointcloudCleanup.ts`, `pointcloudCleanup.test.ts` (new)                                                               | IPC, trash, pack gate                                                               | 9                      |
| `apps/desktop/src/main/index.ts`, `journal.ts`, `journal.test.ts`                                                                             | registration, refusal, journal writer                                               | 9                      |
| `packages/project/src/builder/removePlan.ts`, `removePlan.test.ts`                                                                            | a cleaned copy outlives its source                                                  | 9                      |
| `apps/desktop/src/renderer/change/producers/cloud.ts`, `cloud.test.ts`                                                                        | a cleaned copy is comparable                                                        | 9                      |
| `apps/desktop/src/renderer/pointcloud/cleanupHistory.ts`, `cleanupStore.ts` + tests (new)                                                     | undo history, store, writes                                                         | 10                     |
| `python/src/aio_pipelines/pointcloud_cleanup/pipeline.py` (new), `pipelines.py`                                                               | `pointcloud.clean`                                                                  | 11, 12                 |
| `python/tests/test_pccleanup_noise.py`, `test_pccleanup_save.py` (new)                                                                        | pipeline tests                                                                      | 11, 12                 |
| `python/src/aio_pipelines/survey/export.py`, `python/tests/test_pccleanup_export.py` (new)                                                    | export applies the recipe                                                           | 13                     |
| `apps/desktop/src/renderer/survey/exportHelpers.ts`, `exportHelpers.test.ts`                                                                  | `cleanup` param                                                                     | 13                     |
| `apps/desktop/src/renderer/pointcloud/cleanupFrame.ts`, `cleanupJobs.ts`, `cleanupScene.ts`, `cleanupActions.ts` + tests (new)                | glue between store, stage tools, jobs and menus                                     | 14                     |
| `apps/desktop/src/renderer/pointcloud/CleanupPanel.tsx`, `CleanupHost.tsx`, `cleanup.css`, `CleanupPanel.test.tsx` (new)                      | the panel and its notice                                                            | 15                     |
| `apps/desktop/src/renderer/workspace/StageTools.tsx`, `workspace/Stage.tsx`, `bootstrap.ts`                                                   | toolbar button, mount, test hooks                                                   | 15                     |
| `apps/desktop/src/renderer/shell/DateMenus.tsx`, `DateMenus.test.tsx`, `shell/Sidebar.tsx`                                                    | right-click actions                                                                 | 16                     |
| `apps/desktop/src/renderer/survey/ExportDialog.tsx`, `survey/exportCleanup.test.tsx` (new), `workspace/StageLegends.tsx`                      | Apply cleanup, per-layer legend                                                     | 16                     |
| `tools/pointcloud/synthetic-cloud.mjs`, `tools/pointcloud/README.md`, `packages/pointcloud/test-data/noisy.copc.laz` (new)                    | e2e fixture                                                                         | 17                     |
| `apps/desktop/e2e/cleanupHelpers.ts`, `pointcloud-clipbox.spec.ts`, `pointcloud-noise.spec.ts`, `pointcloud-clean-export.spec.ts` (new)       | end to end                                                                          | 17                     |
| `tools/pipeline-pack/pdal.mjs`, `pdal.test.mjs`, `python/pyproject.toml`, `python/uv.lock`, `apps/desktop/src/main/jobs/packVersions.test.ts` | pack bump                                                                           | 18                     |
| `docs/TESTING.md`, `docs/guide/03-scene.md`, `docs/guide/12-settings.md`, `docs/KNOWN-LIMITS.md`, `docs/architecture/data-conventions.md`     | docs and guide                                                                      | 18                     |

## Execution DAG

Dependencies (an arrow means "needs"):

- T1 Contracts: none
- T2 Strings and shortcuts: none
- T5 Material, `drawnPoints`, `countDrawn`: none
- T7 Engine clip box tool: none
- T3 TS evaluator and live recipe store: T1 (types, vectors)
- T4 Python evaluator and LAS streaming: T1 (vectors, recipe rules)
- T8 Engine selection tool: T7 (`StageTool` union and engine `index.ts`)
- T9 Main IPC, journal, pack gate, derived-copy rules: T1
- T6 CloudManager and adapter integration: T3, T5
- T10 Renderer store and history: T1, T3
- T11 Python noise mode: T4
- T13 Export applies the recipe: T1, T4
- T12 Python save mode: T11 (same `pipeline.py`)
- T14 Renderer glue (jobs, scene, actions): T2, T5, T7, T8, T10 (T9 at run time; its tests stub the bridge)
- T15 Clean up panel, toolbar button, hooks: T2, T14
- T16 Menus, Apply cleanup, per-layer legend: T2, T13, T14
- T17 e2e fixture and three specs: T6, T9, T12, T15, T16
- T18 Pack bump, drivers, docs, guide: T11, T12, T15, T16

Parallel batches (each batch dispatched in one message; no two tasks of a batch share a file; every dependency is in an earlier batch):

| Batch | Tasks             | Shared-file check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1    | T1, T2, T5, T7    | T1 owns `packages/schema/**`, `preload/index.ts`, `renderer/jobs.ts`, `renderer/processing/pipelines.ts`, `tools/compat/pointcloud-cleanup-additive.test.mjs`, `docs/architecture/contract-changes.md`; T2 owns `packages/ui/src/i18n/en.ts`, `packages/ui/src/shortcuts.ts`; T5 owns `packages/pointcloud/src/material.ts`, `material.test.ts`, `pick.ts`, `cleanup/count.ts`, `cleanup/drawn.test.ts`, `packages/pointcloud/src/index.ts`; T7 owns `packages/engine/src/types.ts`, `stage/Stage.ts`, `packages/engine/src/index.ts`, `tools/clipbox.ts`, `tools/clipbox.test.ts`                                                                                   |
| B2    | T3, T4, T8, T9    | T3 owns `packages/pointcloud/src/cleanup/{frame,polygon,evaluate,store}.ts` and their tests, `packages/pointcloud/src/index.ts`; T4 owns `python/src/aio_pipelines/pointcloud_cleanup/{__init__,recipe,evaluate,lasstream}.py`, `python/tests/pccleanup_synth.py`, `test_pccleanup_evaluate.py`, `test_pccleanup_lasstream.py`; T8 owns `packages/engine/src/tools/pcselect.ts`, `pcselect.test.ts`, `packages/engine/src/index.ts`; T9 owns `apps/desktop/src/main/pointcloudCleanup.ts` and test, `main/index.ts`, `main/journal.ts`, `main/journal.test.ts`, `packages/project/src/builder/removePlan.ts` and test, `renderer/change/producers/cloud.ts` and test |
| B3    | T6, T10, T11, T13 | T6 owns `packages/pointcloud/src/{manager,adapter,protocol,pool}.ts`, `cleanup/chunk.ts`, `cleanup/chunk.test.ts`, `cleanup/manager.test.ts`, `packages/pointcloud/src/index.ts`; T10 owns `apps/desktop/src/renderer/pointcloud/cleanupHistory.ts`, `cleanupStore.ts` and tests; T11 owns `python/src/aio_pipelines/pointcloud_cleanup/pipeline.py`, `python/src/aio_pipelines/pipelines.py`, `python/tests/test_pccleanup_noise.py`; T13 owns `python/src/aio_pipelines/survey/export.py`, `python/tests/test_pccleanup_export.py`, `apps/desktop/src/renderer/survey/exportHelpers.ts` and test                                                                   |
| B4    | T12, T14          | T12 owns `pipeline.py`, `test_pccleanup_save.py`; T14 owns `apps/desktop/src/renderer/pointcloud/{cleanupFrame,cleanupJobs,cleanupScene,cleanupActions}.ts` and tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| B5    | T15, T16          | T15 owns `renderer/pointcloud/{CleanupPanel,CleanupHost}.tsx`, `cleanup.css`, `CleanupPanel.test.tsx`, `workspace/StageTools.tsx`, `workspace/Stage.tsx`, `renderer/bootstrap.ts`; T16 owns `shell/DateMenus.tsx`, `DateMenus.test.tsx`, `shell/Sidebar.tsx`, `survey/ExportDialog.tsx`, `survey/exportCleanup.test.tsx`, `workspace/StageLegends.tsx`                                                                                                                                                                                                                                                                                                               |
| B6    | T17, T18          | T17 owns `tools/pointcloud/synthetic-cloud.mjs` (and a `.d.mts` beside it if needed), `tools/pointcloud/README.md`, `packages/pointcloud/test-data/noisy.copc.laz`, `apps/desktop/e2e/cleanupHelpers.ts`, the three specs, and one hook line in `renderer/bootstrap.ts` if the export dialog needs it; T18 owns `tools/pipeline-pack/pdal.mjs`, `pdal.test.mjs`, `python/pyproject.toml`, `python/uv.lock`, `apps/desktop/src/main/jobs/packVersions.test.ts`, `packages/schema/src/pointcloudCleanup.ts` (the version constant only, if 0.11.0), the five docs                                                                                                      |

The hot shared files each have one owner per batch: `packages/ui/src/i18n/en.ts` (T2 only; later tasks use its keys and never add any; a missing key is reported to the coordinator, who adds it in a follow-up commit between batches), `packages/schema/src/jobs.ts` and `index.ts` (T1 only), `StageTools.tsx` (T15), `DateMenus.tsx` (T16), `Stage.ts` and engine `types.ts` (T7), `material.ts` (T5), `manager.ts` (T6), `pipelines.py` (T11), `packages/pointcloud/src/index.ts` (T5 in B1, T3 in B2, T6 in B3), `packages/engine/src/index.ts` (T7 in B1, T8 in B2).

Critical path: **T1 → T3 → T10 → T14 → T15 → T17** (six batches). The Python chain T4 → T11 → T12 runs beside it and ends one batch earlier; T6 is the heaviest B3 task and must finish before T17.

Run one heavy check at a time (founder rule): batch agents run only their own test files; `pnpm check`, pytest of the whole suite and e2e runs happen once per batch, by the coordinator, after the batch's commits.

## Contract changes

Rows Task 1 appends to `docs/architecture/contract-changes.md` (format `| Date | Change | Why | Streams affected | Approved by |`, after the last row):

```markdown
| 2026-10-15 | New file family `aio.pccleanup/1` (since 0.16): `edits/pointcloud/<layer>.json`, the cleanup recipe of one point cloud layer (`PointcloudCleanup`: optional `clipBox`, optional `height`, `hiddenClasses`, up to 200 `regions`, optional `noise`), in world coordinates of the project CRS. Beside it a noise run writes its record `<layer>.noise-<run>.json` (`NoiseRun`, no schema tag, read once by the app) and its working copy `<layer>.noise-<run>.copc.laz`. Journaled through the wrapped writer `pointcloud:writeCleanup` | Point cloud cleanup is one recipe per layer, evaluated live in the viewer and over the full cloud in the pipeline; nothing is rewritten until a save or an export | `@aio/schema`, `@aio/pointcloud`, desktop main and renderer, pipelines | Point cloud cleanup design (founder, 15 Oct 2026) |
| 2026-10-15 | `LayerDerived.kind` gains `'cleanup'` (a cleaned copy: `source` is the layer it was cleaned from, `runId` the save job). Not additive for older builds: `LayerDerived` is strict, so 0.15 and earlier refuse a manifest that holds a cleaned copy (pinned in `tools/compat/pointcloud-cleanup-additive.test.mjs`). A cleaned copy is not removed with its source and takes part in cloud change like an imported cloud | Provenance of the cleaned copy, as the spec asks | `@aio/schema`, `@aio/project` (removal), desktop renderer (change) | Point cloud cleanup design (founder, 15 Oct 2026); forward-compatibility break accepted by the founder (15 Oct 2026: a project with a cleaned copy needs 0.16+) |
| 2026-10-15 | `PipelineName` gains `pointcloud.clean` (`PointcloudCleanParams`: `mode: 'noise'` with `layerId`, `src`, `outlier`, optional `elm`; `mode: 'save'` with `layerId`, `src`, `recipe`, `name`), pipeline pack `POINTCLOUD_CLEAN_MIN_PACK` | Noise marking and cleaned copies need every point: they run as pipeline jobs | `@aio/schema`, desktop main and renderer, pipelines | Point cloud cleanup design (founder, 15 Oct 2026) |
| 2026-10-15 | `SurveyExportParams` gains optional `cleanup` (a `PointcloudCleanup`, only with `what: 'cloud'`) | Point cloud export writes the cleaned version | `@aio/schema`, desktop renderer, pipelines | Point cloud cleanup design (founder, 15 Oct 2026) |
| 2026-10-15 | IPC `pointcloud:readCleanup` (`{ projectId, noiseRun? }` to `{ ok, recipes, noise?, readOnly }`) and `pointcloud:writeCleanup` (`{ projectId, layerId, recipe \| null, keep? }` to `{ ok, trashed }`; atomic with a `.bak`, journaled, refused for packages; unreferenced noise copies of the layer go to the project trash) | The renderer's undo history writes every cleanup step | `@aio/schema`, desktop main, preload and renderer | Point cloud cleanup design (founder, 15 Oct 2026) |
```

Compat fixtures: no file under `tools/compat/schema-*` changes (those are frozen snapshots of released builds). Task 1 adds `tools/compat/pointcloud-cleanup-additive.test.mjs`, pinned against `tools/compat/schema-0.11`: the registry row lives under `edits/pointcloud/`, a folder 0.11 never reads; the job index lists `pointcloud.clean` jobs that 0.11 skips one by one; a `survey.export` job with `cleanup` is skipped the same way; a manifest without a cleaned copy still parses with 0.11, and one with a cleaned copy is refused by 0.11 (the known break, row 2).

## End to end

Three new specs (Task 17), on a new fixture `packages/pointcloud/test-data/noisy.copc.laz`: the 16,000-point synthetic cloud of `tools/pointcloud/synthetic-cloud.mjs` (ground class 2, a building class 6, trees class 5, around E 500000, N 3200000, EPSG 32639) plus 40 isolated high points (25 to 40 m up) and 20 isolated low points (6 to 8 m under the ground), all class 1, from the same seeded generator (`--outliers 40`), converted with the PDAL command of `tools/pointcloud/README.md`, "Test fixture".

- `pointcloud-clipbox.spec.ts` (runs everywhere, no PDAL): open the layer's Clean up from its right-click menu, Fit to layer, drag the east face handle inward, points outside are no longer drawn (`__stratlas.pointcloudCleanup.drawn()` falls), Reset restores the count, Ctrl+Z brings the box back.
- `pointcloud-noise.spec.ts` (needs the pipeline Python and PDAL): Remove noise, "N points (x %) marked as noise" with N at least 60, class 7 hidden in the legend, the layer streams the working copy, Undo returns to the original stream.
- `pointcloud-clean-export.spec.ts` (needs the pipeline Python and PDAL): a lasso delete plus a clip box, Save cleaned copy gives a new layer with the expected point count (the TS evaluator over the regenerated fixture points), export LAZ of the original with Apply cleanup gives the same count read back with `pdal info --summary`.

How they run, the CI way, from `apps/desktop` of this worktree (PowerShell; one run at a time):

```powershell
pnpm demo:build --quick --python "E:/Dev/AIO Software/python/.venv/Scripts/python.exe"
$env:QUADRION_WINDOW_SIZE = '1100x720'; $env:QUADRION_E2E_SCALE = '1'; $env:QUADRION_E2E_SWGL = 'warp'
$env:QUADRION_E2E_PYTHON = '<scratch venv python, see below>'
$env:AIO_PDAL = 'E:/Dev/tools/pdal/Library/bin/pdal.exe'
npx playwright test e2e/pointcloud-clipbox.spec.ts e2e/pointcloud-noise.spec.ts e2e/pointcloud-clean-export.spec.ts --workers=1
```

Always name the spec files in full (`e2e/<name>.spec.ts`): Playwright's filter is a regex over the full path, and this worktree's folder is called `pointcloud-cleanup`, so a bare `pointcloud` would match every spec. Check with `--list` first. The run must print `[e2e] window 1100 x 720 px at display scale 1`.

The branch changes `python/`, so the main venv's editable install (which points at the main checkout) would run the old pipelines. For the two pipeline specs make a scratch venv whose path puts this worktree's `python/src` first (never touch the main venv):

```powershell
$base = & "E:\Dev\AIO Software\python\.venv\Scripts\python.exe" -c "import sys; print(sys.base_prefix)"
$venv = "$env:TEMP\pcc-e2e-venv"
& "$base\python.exe" -m venv $venv
Set-Content -Encoding ascii "$venv\Lib\site-packages\aio-worktree.pth" "E:\Dev\AIO Software\.claude\worktrees\pointcloud-cleanup\python\src`r`nE:\Dev\AIO Software\python\.venv\Lib\site-packages"
& "$venv\Scripts\python.exe" -c "import aio_pipelines, numpy; print(aio_pipelines.__file__)"
$env:QUADRION_E2E_PYTHON = "$venv\Scripts\python.exe"
```

The last command must print the worktree's `python\src\aio_pipelines\__init__.py` (the main venv's own `.pth` files are not processed from an added path, so its editable mapping does not apply).

**PDAL in CI e2e: an open risk.** The CI `e2e` job installs the pipeline venv (`uv sync --frozen`) but not PDAL (only the `pipelines` job runs `tools/pipeline-pack/pdal.mjs`). `jobs.spec.ts` and `change-cloud.spec.ts` already skip their PDAL tests there with `test.skip(!hasPdal(), ...)`. The noise and clean-export specs do the same (`hasPipelinePython()` and `hasPdal()` from `e2e/fixtures.ts`), so in CI only `pointcloud-clipbox.spec.ts` runs; the PDAL paths are covered in CI by the Python tests of Tasks 11 to 13 (the `pipelines` job has PDAL), and locally by the two specs. Closing the gap means adding the `PDAL (conda-forge, as in the pack)` step and its conda cache to the `e2e` job in `.github/workflows/ci.yml` (about a minute per shard with a warm cache). Founder decision 15 Oct 2026: keep skipping in CI and run both specs locally the CI way before hand-off. Update 16 Oct 2026: the engineering model branch added that PDAL step to the `e2e` job, so both specs now run in CI too (PDAL and untwine through `AIO_PDAL` and `AIO_UNTWINE`, the pipeline Python from `python/.venv`).

---

### Task 1: Contracts (schema, vectors, IPC, compat, contract rows)

**Packages touched:** `@aio/schema`, desktop preload, desktop renderer (`jobs.ts`, `processing/pipelines.ts`), `tools/compat`, docs (contract rows).
**Contract change:** yes (the five rows above). **E2E:** none.

**Files:**

- Create: `packages/schema/src/pointcloudCleanup.ts`
- Create: `packages/schema/src/pointcloudCleanup.test.ts`
- Create: `packages/schema/test-data/pccleanup-vectors.json`
- Modify: `packages/schema/src/layers.ts:84` (`LayerDerived.kind`)
- Modify: `packages/schema/src/jobs.ts` (`PipelineName` after `'pano.stitch'` ~line 87; `PIPELINES` last entry; `SurveyExportParams` ~line 890; `PARAMS` ~line 1171; import at top)
- Modify: `packages/schema/src/jobs.test.ts:61-103` (the pipeline list)
- Modify: `packages/schema/src/ipc.ts` (imports lines 5-32; two channels after `'survey:writeTerrainEdits'` ~line 2867)
- Modify: `packages/schema/src/versions.ts` (row after `aio.pano-stitch`, ~line 573)
- Modify: `packages/schema/src/index.ts:45` (export)
- Modify: `apps/desktop/src/preload/index.ts:240` (after `'survey:writeTerrainEdits': true,`)
- Modify: `apps/desktop/src/renderer/jobs.ts:95` (`MANIFEST_WRITERS`) and `:933` (`FORMS`)
- Modify: `apps/desktop/src/renderer/processing/pipelines.ts:69` (`PIPELINE_GROUP`) and `:160` (`JOB_KIND`)
- Create: `tools/compat/pointcloud-cleanup-additive.test.mjs`
- Modify: `docs/architecture/contract-changes.md` (append the five rows of "Contract changes")

**Interfaces:**

- Consumes: `Id`, `ProjectPath` (`common.ts`); `JobId`, `ProjectId`, `Failure` (`ipc.ts` locals).
- Produces (all from `@aio/schema`):
  - `PCCLEANUP_SCHEMA = 'aio.pccleanup/1'`, `PCCLEANUP_DIR = 'edits/pointcloud'`, `MAX_REGIONS = 200`, `MAX_LASSO_VERTICES = 256`, `NOISE_CLASS = 7`, `POINTCLOUD_CLEAN_MIN_PACK = '0.10.0'`, `POINTCLOUD_CLEAN_FEATURE = 'Point cloud noise removal and cleaned copies'`, `DEFAULT_OUTLIER = { meanK: 8, multiplier: 2 }`, `DEFAULT_ELM = { cell: 10, threshold: 1 }`
  - zod and types `ClipBox`, `HeightRange`, `RegionAction`, `CleanupRegion`, `OutlierParams`, `ElmParams`, `NoiseParams`, `NoiseRun`, `PointcloudCleanup`, `PointcloudCleanParams`
  - `pccleanupPath(layerId: string): string`, `noiseCopyPath(layerId: string, runId: string): string`, `noiseRunPath(layerId: string, runId: string): string`, `emptyCleanup(layerId: string): PointcloudCleanup`, `isEmptyCleanup(r: PointcloudCleanup): boolean`, `cleanupRemoves(r: PointcloudCleanup): { box: 'inside' | 'outside' | null; height: boolean; deletes: number; hiddenClasses: number[] }`
  - `PipelineName` member `'pointcloud.clean'`; `SurveyExportParams.cleanup?: PointcloudCleanup`
  - IPC `'pointcloud:readCleanup'`: request `{ projectId: string; noiseRun?: { layerId: string; runId: string } }`, response `{ ok: true; recipes: PointcloudCleanup[]; noise?: NoiseRun | null; readOnly: boolean } | { ok: false; error: string }`
  - IPC `'pointcloud:writeCleanup'`: request `{ projectId: string; layerId: string; recipe: PointcloudCleanup | null; keep?: string[] }`, response `{ ok: true; trashed: string[] } | { ok: false; error: string }`
  - `pccleanup-vectors.json`: `{ points: { id, xyz: [E, N, H], cls }[]; cases: { name, recipe, expect: { state: CleanupState[]; cls: number[] } }[] }`, states `'kept' | 'hidden' | 'classHidden' | 'deleted' | 'dropped'`

- [ ] **Step 1: Write the failing schema test**

Create `packages/schema/src/pointcloudCleanup.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ipc } from './ipc';
import { LayerDerived } from './layers';
import { PIPELINES, PipelineName, SurveyExportParams, pipelineParams } from './jobs';
import {
  MAX_LASSO_VERTICES,
  NoiseRun,
  POINTCLOUD_CLEAN_MIN_PACK,
  PointcloudCleanParams,
  PointcloudCleanup,
  cleanupRemoves,
  emptyCleanup,
  isEmptyCleanup,
  noiseCopyPath,
  noiseRunPath,
  pccleanupPath,
} from './pointcloudCleanup';
import { SCHEMA_REGISTRY, readerFor } from './versions';

const ORTHO = [0.02, 0, 0, 0, 0, 0.02, 0, 0, 0, 0, 0, 0, -10001, -64001, 0, 1];
const square = (): [number, number][] => [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];
const region = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  shape: 'box',
  viewProj: ORTHO,
  polygon: square(),
  action: { kind: 'delete' },
  ...over,
});
const recipe = (over: Record<string, unknown> = {}) => ({
  ...emptyCleanup('cloud-a'),
  ...over,
});

describe('the cleanup recipe (aio.pccleanup/1)', () => {
  it('starts empty and knows when it changes nothing', () => {
    const r = emptyCleanup('cloud-a');
    expect(r).toEqual({
      schema: 'aio.pccleanup/1',
      layerId: 'cloud-a',
      hiddenClasses: [],
      regions: [],
    });
    expect(PointcloudCleanup.parse(r)).toEqual(r);
    expect(isEmptyCleanup(r)).toBe(true);
    expect(isEmptyCleanup({ ...r, hiddenClasses: [7] })).toBe(false);
    expect(isEmptyCleanup({ ...r, height: {} })).toBe(true);
  });

  it('takes a clip box, a height range, classes, regions and a noise run', () => {
    const r = recipe({
      clipBox: { center: [500050, 3200050, 20], size: [60, 60, 40], yaw: 0.5, keep: 'inside' },
      height: { min: 0, max: 20 },
      hiddenClasses: [7, 18],
      regions: [
        region(),
        region({ id: 'r2', shape: 'lasso', action: { kind: 'class', value: 2 } }),
      ],
      noise: {
        path: noiseCopyPath('cloud-a', '20261015-101500-pointcloud-clean-a1b2'),
        params: { outlier: { meanK: 8, multiplier: 2 } },
        marked: 12,
        total: 16000,
        runId: '20261015-101500-pointcloud-clean-a1b2',
      },
    });
    expect(PointcloudCleanup.safeParse(r).success).toBe(true);
  });

  it('refuses a lasso of 257 vertices and a box of 3 corners', () => {
    const many = Array.from({ length: MAX_LASSO_VERTICES + 1 }, (_, i): [number, number] => [
      Math.cos(i),
      Math.sin(i),
    ]);
    expect(
      PointcloudCleanup.safeParse(recipe({ regions: [region({ shape: 'lasso', polygon: many })] }))
        .success,
    ).toBe(false);
    expect(
      PointcloudCleanup.safeParse(
        recipe({ regions: [region({ shape: 'lasso', polygon: many.slice(0, 256) })] }),
      ).success,
    ).toBe(true);
    expect(
      PointcloudCleanup.safeParse(recipe({ regions: [region({ polygon: square().slice(0, 3) })] }))
        .success,
    ).toBe(false);
  });

  it('caps regions at 200 and checks the matrix, classes and heights', () => {
    const r200 = Array.from({ length: 200 }, (_, i) => region({ id: `r${String(i)}` }));
    expect(PointcloudCleanup.safeParse(recipe({ regions: r200 })).success).toBe(true);
    expect(
      PointcloudCleanup.safeParse(recipe({ regions: [...r200, region({ id: 'x' })] })).success,
    ).toBe(false);
    expect(
      PointcloudCleanup.safeParse(recipe({ regions: [region({ viewProj: ORTHO.slice(1) })] }))
        .success,
    ).toBe(false);
    expect(PointcloudCleanup.safeParse(recipe({ hiddenClasses: [256] })).success).toBe(false);
    expect(PointcloudCleanup.safeParse(recipe({ hiddenClasses: [7, 7] })).success).toBe(false);
    expect(PointcloudCleanup.safeParse(recipe({ height: { min: 5, max: 1 } })).success).toBe(false);
    expect(
      PointcloudCleanup.safeParse(
        recipe({ clipBox: { center: [0, 0, 0], size: [0, 1, 1], yaw: 0, keep: 'inside' } }),
      ).success,
    ).toBe(false);
    expect(PointcloudCleanup.safeParse({ ...recipe(), extra: 1 }).success).toBe(false);
  });

  it('keeps the working copy and its record inside edits/pointcloud', () => {
    expect(pccleanupPath('cloud-a')).toBe('edits/pointcloud/cloud-a.json');
    expect(noiseCopyPath('cloud-a', 'j1')).toBe('edits/pointcloud/cloud-a.noise-j1.copc.laz');
    expect(noiseRunPath('cloud-a', 'j1')).toBe('edits/pointcloud/cloud-a.noise-j1.json');
    const run = {
      path: 'clouds/a.copc.laz',
      params: { outlier: { meanK: 8, multiplier: 2 } },
      marked: 0,
      total: 1,
      runId: 'j1',
    };
    expect(NoiseRun.safeParse(run).success).toBe(false);
    expect(NoiseRun.safeParse({ ...run, path: noiseCopyPath('cloud-a', 'j1') }).success).toBe(true);
  });

  it('says what a save or an export removes', () => {
    expect(
      cleanupRemoves(
        recipe({
          clipBox: { center: [0, 0, 0], size: [1, 1, 1], yaw: 0, keep: 'outside' },
          height: { max: 3 },
          hiddenClasses: [7],
          regions: [region(), region({ id: 'r2', action: { kind: 'hide' } })],
        }) as PointcloudCleanup,
      ),
    ).toEqual({ box: 'inside', height: true, deletes: 1, hiddenClasses: [7] });
  });
});

describe('the pointcloud.clean pipeline and the export', () => {
  it('is a pipeline with a title and two modes', () => {
    expect(PipelineName.options).toContain('pointcloud.clean');
    expect(PIPELINES.find((p) => p.name === 'pointcloud.clean')?.title).toBe(
      'Clean up a point cloud',
    );
    const p = pipelineParams('pointcloud.clean');
    expect(
      p.safeParse({
        mode: 'noise',
        layerId: 'cloud-a',
        src: 'clouds/a.copc.laz',
        outlier: { meanK: 8, multiplier: 2 },
      }).success,
    ).toBe(true);
    expect(
      p.safeParse({
        mode: 'save',
        layerId: 'cloud-a',
        src: 'clouds/a.copc.laz',
        recipe: emptyCleanup('cloud-a'),
        name: 'Site scan',
      }).success,
    ).toBe(true);
    expect(PointcloudCleanParams.safeParse({ mode: 'save', layerId: 'a' }).success).toBe(false);
    expect(
      PointcloudCleanParams.safeParse({
        mode: 'noise',
        layerId: 'a',
        src: '../a.copc.laz',
        outlier: { meanK: 8, multiplier: 2 },
      }).success,
    ).toBe(false);
  });

  it('lets a cloud export carry a recipe', () => {
    const base = { what: 'cloud', format: 'laz', crs: 'site', layer: 'cloud-a', out: 'C:/x.laz' };
    expect(SurveyExportParams.safeParse(base).success).toBe(true);
    expect(
      SurveyExportParams.safeParse({ ...base, cleanup: emptyCleanup('cloud-a') }).success,
    ).toBe(true);
  });

  it('names a cleaned copy as derived from its source', () => {
    expect(
      LayerDerived.safeParse({ kind: 'cleanup', source: ['cloud-a'], runId: 'j1' }).success,
    ).toBe(true);
  });

  it('needs pack 0.10.0 or later', () => {
    expect(POINTCLOUD_CLEAN_MIN_PACK).toMatch(/^0\.1[01]\.0$/);
  });
});

describe('the cleanup channels and registry', () => {
  it('reads every recipe and writes one at a time', () => {
    const read = ipc['pointcloud:readCleanup'].request;
    expect(read.safeParse({ projectId: 'p' }).success).toBe(true);
    expect(
      read.safeParse({ projectId: 'p', noiseRun: { layerId: 'a', runId: 'j1' } }).success,
    ).toBe(true);
    const write = ipc['pointcloud:writeCleanup'].request;
    expect(write.safeParse({ projectId: 'p', layerId: 'a', recipe: null }).success).toBe(true);
    expect(
      write.safeParse({ projectId: 'p', layerId: 'a', recipe: emptyCleanup('a'), keep: [] })
        .success,
    ).toBe(true);
    expect(write.safeParse({ projectId: 'p', layerId: 'a' }).success).toBe(false);
  });

  it('registers aio.pccleanup/1 under edits/pointcloud since 0.16', () => {
    expect(SCHEMA_REGISTRY.find((e) => e.family === 'aio.pccleanup')).toMatchObject({
      version: 1,
      home: 'project',
      where: 'edits/pointcloud/<layer>.json',
      since: '0.16',
    });
    expect(readerFor('aio.pccleanup/1').kind).toBe('current');
  });
});

describe('the shared evaluator vectors', () => {
  const file = join(import.meta.dirname, '..', 'test-data', 'pccleanup-vectors.json');
  const v = JSON.parse(readFileSync(file, 'utf8')) as {
    points: { id: string; xyz: number[]; cls: number }[];
    cases: { name: string; recipe: unknown; expect: { state: string[]; cls: number[] } }[];
  };

  it('holds valid recipes and one outcome per point', () => {
    expect(v.cases.length).toBeGreaterThanOrEqual(14);
    for (const c of v.cases) {
      const r = PointcloudCleanup.safeParse(c.recipe);
      expect(r.success, `${c.name}: ${r.success ? '' : r.error.message}`).toBe(true);
      expect(c.expect.state).toHaveLength(v.points.length);
      expect(c.expect.cls).toHaveLength(v.points.length);
    }
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm exec vitest run packages/schema/src/pointcloudCleanup.test.ts`
Expected: FAIL (`Cannot find module './pointcloudCleanup'`).

- [ ] **Step 3: Write `pointcloudCleanup.ts`**

```ts
import { z } from 'zod';
import { Id, ProjectPath } from './common';

/*
 * Point cloud cleanup (spec docs/plans/2026-10-15-pointcloud-cleanup-design.md): one recipe per
 * point cloud layer in `edits/pointcloud/<layerId>.json` (`aio.pccleanup/1`), evaluated live in the
 * viewer (`@aio/pointcloud` cleanup/evaluate.ts) and over the full cloud in the pipeline
 * (python `aio_pipelines/pointcloud_cleanup/evaluate.py`). Coordinates are world: the project CRS,
 * like the COPC header. Nothing here imports `jobs.ts` (it imports this file).
 */

export const PCCLEANUP_SCHEMA = 'aio.pccleanup/1';
export const PCCLEANUP_DIR = 'edits/pointcloud';
export const MAX_REGIONS = 200;
export const MAX_LASSO_VERTICES = 256;
/** ASPRS class 7 (low noise): what the noise filters mark. */
export const NOISE_CLASS = 7;

/** The first pipeline pack with `pointcloud.clean`; one constant, set at merge time (0.10.0 or 0.11.0). */
export const POINTCLOUD_CLEAN_MIN_PACK = '0.10.0';
export const POINTCLOUD_CLEAN_FEATURE = 'Point cloud noise removal and cleaned copies';

export const DEFAULT_OUTLIER = { meanK: 8, multiplier: 2 } as const;
export const DEFAULT_ELM = { cell: 10, threshold: 1 } as const;

export const pccleanupPath = (layerId: string): string => `${PCCLEANUP_DIR}/${layerId}.json`;
export const noiseCopyPath = (layerId: string, runId: string): string =>
  `${PCCLEANUP_DIR}/${layerId}.noise-${runId}.copc.laz`;
export const noiseRunPath = (layerId: string, runId: string): string =>
  `${PCCLEANUP_DIR}/${layerId}.noise-${runId}.json`;

/** A job id (same rule as `JobId` in jobs.ts, repeated to keep this file free of jobs.ts). */
const RunId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/, 'Not a valid job id');
const V3 = z.tuple([z.number(), z.number(), z.number()]);
const Size = z.number().min(0.01).max(1e6);
const ClassCode = z.number().int().min(0).max(255);
/** NDC of a selection vertex; a lasso may leave the view a little. */
const Ndc = z.tuple([z.number().min(-100).max(100), z.number().min(-100).max(100)]);

export const ClipBox = z
  .object({
    /** World centre [E, N, H]. */
    center: V3,
    /** Extent along the box's east, north and up axes, metres. */
    size: z.tuple([Size, Size, Size]),
    /** Radians about +Z, counter-clockwise seen from above (east toward north). */
    yaw: z.number().min(-10).max(10),
    keep: z.enum(['inside', 'outside']),
  })
  .strict();
export type ClipBox = z.infer<typeof ClipBox>;

export const HeightRange = z
  .object({ min: z.number().optional(), max: z.number().optional() })
  .strict()
  .refine((h) => h.min === undefined || h.max === undefined || h.min <= h.max, {
    message: 'The lowest height is above the highest.',
  });
export type HeightRange = z.infer<typeof HeightRange>;

export const RegionAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('hide') }).strict(),
  z.object({ kind: z.literal('delete') }).strict(),
  z.object({ kind: z.literal('class'), value: ClassCode }).strict(),
]);
export type RegionAction = z.infer<typeof RegionAction>;

export const CleanupRegion = z
  .object({
    id: z.string().min(1).max(64),
    shape: z.enum(['box', 'lasso']),
    /** World to clip, column-major, as the view was when the region was drawn. */
    viewProj: z.array(z.number()).length(16),
    /** NDC vertices: 4 corners for a box, 3 to 256 for a lasso. */
    polygon: z.array(Ndc).min(3).max(MAX_LASSO_VERTICES),
    action: RegionAction,
  })
  .strict()
  .refine((r) => r.shape !== 'box' || r.polygon.length === 4, {
    message: 'A box selection has 4 corners.',
  });
export type CleanupRegion = z.infer<typeof CleanupRegion>;

export const OutlierParams = z
  .object({
    meanK: z.number().int().min(2).max(64),
    multiplier: z.number().min(0.1).max(10),
  })
  .strict();
export const ElmParams = z
  .object({ cell: z.number().min(0.5).max(100), threshold: z.number().min(0.1).max(50) })
  .strict();
export const NoiseParams = z.object({ outlier: OutlierParams, elm: ElmParams.optional() }).strict();
export type NoiseParams = z.infer<typeof NoiseParams>;

/** A noise run: its working copy, the settings, what it marked. Also the record file beside the copy. */
export const NoiseRun = z
  .object({
    path: ProjectPath.refine(
      (p) => p.startsWith(`${PCCLEANUP_DIR}/`) && p.endsWith('.copc.laz'),
      'A noise working copy lives in edits/pointcloud and is a COPC file',
    ),
    params: NoiseParams,
    marked: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    runId: RunId,
  })
  .strict();
export type NoiseRun = z.infer<typeof NoiseRun>;

export const PointcloudCleanup = z
  .object({
    schema: z.literal(PCCLEANUP_SCHEMA),
    layerId: Id,
    clipBox: ClipBox.optional(),
    height: HeightRange.optional(),
    hiddenClasses: z
      .array(ClassCode)
      .max(256)
      .refine((a) => new Set(a).size === a.length, 'A class is listed twice'),
    regions: z.array(CleanupRegion).max(MAX_REGIONS),
    noise: NoiseRun.optional(),
  })
  .strict();
export type PointcloudCleanup = z.infer<typeof PointcloudCleanup>;

export function emptyCleanup(layerId: string): PointcloudCleanup {
  return { schema: PCCLEANUP_SCHEMA, layerId, hiddenClasses: [], regions: [] };
}

/** True when the recipe changes nothing in the view, a save or an export. */
export function isEmptyCleanup(r: PointcloudCleanup): boolean {
  return (
    !r.clipBox &&
    r.height?.min === undefined &&
    r.height?.max === undefined &&
    r.hiddenClasses.length === 0 &&
    r.regions.length === 0 &&
    !r.noise
  );
}

/** What a save or an export removes (the Apply cleanup line of the export dialog). */
export function cleanupRemoves(r: PointcloudCleanup): {
  box: 'inside' | 'outside' | null;
  height: boolean;
  deletes: number;
  hiddenClasses: number[];
} {
  return {
    // keep inside removes what is outside, and the other way round
    box: r.clipBox ? (r.clipBox.keep === 'inside' ? 'outside' : 'inside') : null,
    height: r.height?.min !== undefined || r.height?.max !== undefined,
    deletes: r.regions.filter((g) => g.action.kind === 'delete').length,
    hiddenClasses: [...r.hiddenClasses].sort((a, b) => a - b),
  };
}

/** `pointcloud.clean` (python `aio_pipelines/pointcloud_cleanup/pipeline.py`). */
export const PointcloudCleanParams = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('noise'),
      layerId: Id,
      /** The layer's COPC file, project-relative (checked against the manifest). */
      src: ProjectPath,
      outlier: OutlierParams,
      elm: ElmParams.optional(),
    })
    .strict(),
  z
    .object({
      mode: z.literal('save'),
      layerId: Id,
      src: ProjectPath,
      recipe: PointcloudCleanup,
      /** The new layer is named "<name> (cleaned)". */
      name: z.string().trim().min(1).max(120),
    })
    .strict(),
]);
export type PointcloudCleanParams = z.infer<typeof PointcloudCleanParams>;
```

`cleanupRemoves().box` names **which side of the box goes**: with `keep: 'outside'` the inside goes, so the test expects `'inside'`.

- [ ] **Step 4: Write the shared vectors**

Create `packages/schema/test-data/pccleanup-vectors.json` (prettier keeps arrays short; run it in Step 9). The orthographic matrix maps `E` to `(E - 500050) / 50` and `N` to `(N - 3200050) / 50` with `w = 1`; the perspective one has `w = 0.1 H - 2`, so points under 20 m are behind its camera. No point lies on a polygon edge or a box face.

```json
{
  "about": "Shared cases for the point cloud cleanup evaluators (aio.pccleanup/1): packages/pointcloud/src/cleanup/evaluate.test.ts and python/tests/test_pccleanup_evaluate.py. States: kept, hidden, classHidden, deleted, dropped (that precedence, the last wins).",
  "points": [
    { "id": "P0", "xyz": [500050, 3200050, 10], "cls": 2 },
    { "id": "P1", "xyz": [500010, 3200010, 10], "cls": 2 },
    { "id": "P2", "xyz": [500090, 3200090, 30], "cls": 6 },
    { "id": "P3", "xyz": [500050, 3200090, 45], "cls": 5 },
    { "id": "P4", "xyz": [500022, 3200078, -5], "cls": 7 },
    { "id": "P5", "xyz": [500078, 3200022, 2], "cls": 1 }
  ],
  "cases": [
    {
      "name": "an empty recipe keeps every point",
      "recipe": { "schema": "aio.pccleanup/1", "layerId": "v", "hiddenClasses": [], "regions": [] },
      "expect": {
        "state": ["kept", "kept", "kept", "kept", "kept", "kept"],
        "cls": [2, 2, 6, 5, 7, 1]
      }
    },
    {
      "name": "a hidden class",
      "recipe": {
        "schema": "aio.pccleanup/1",
        "layerId": "v",
        "hiddenClasses": [7],
        "regions": []
      },
      "expect": {
        "state": ["kept", "kept", "kept", "kept", "classHidden", "kept"],
        "cls": [2, 2, 6, 5, 7, 1]
      }
    },
    {
      "name": "a clip box keeps what is inside",
      "recipe": {
        "schema": "aio.pccleanup/1",
        "layerId": "v",
        "hiddenClasses": [],
        "regions": [],
        "clipBox": {
          "center": [500050, 3200050, 20],
          "size": [60, 60, 40],
          "yaw": 0,
          "keep": "inside"
        }
      },
      "expect": {
        "state": ["kept", "dropped", "dropped", "dropped", "dropped", "kept"],
        "cls": [2, 2, 6, 5, 7, 1]
      }
    },
    {
      "name": "a clip box keeps what is outside",
      "recipe": {
        "schema": "aio.pccleanup/1",
        "layerId": "v",
        "hiddenClasses": [],
        "regions": [],
        "clipBox": {
          "center": [500050, 3200050, 20],
          "size": [60, 60, 40],
          "yaw": 0,
          "keep": "outside"
        }
      },
      "expect": {
        "state": ["dropped", "kept", "kept", "kept", "kept", "dropped"],
        "cls": [2, 2, 6, 5, 7, 1]
      }
    },
    {
      "name": "a clip box turned 45 degrees",
      "recipe": {
        "schema": "aio.pccleanup/1",
        "layerId": "v",
        "hiddenClasses": [],
        "regions": [],
        "clipBox": {
          "center": [500050, 3200050, 20],
          "size": [20, 100, 100],
          "yaw": 0.7853981633974483,
          "keep": "inside"
        }
      },
      "expect": {
        "state": ["kept", "dropped", "dropped", "dropped", "kept", "kept"],
        "cls": [2, 2, 6, 5, 7, 1]
      }
    },
    {
      "name": "a height range",
      "recipe": {
        "schema": "aio.pccleanup/1",
        "layerId": "v",
        "hiddenClasses": [],
        "regions": [],
        "height": { "min": 0, "max": 20 }
      },
      "expect": {
        "state": ["kept", "kept", "dropped", "dropped", "dropped", "kept"],
        "cls": [2, 2, 6, 5, 7, 1]
      }
    },
    {
      "name": "only a lowest height",
      "recipe": {
        "schema": "aio.pccleanup/1",
        "layerId": "v",
        "hiddenClasses": [],
        "regions": [],
        "height": { "min": 5 }
      },
      "expect": {
        "state": ["kept", "kept", "kept", "kept", "dropped", "dropped"],
        "cls": [2, 2, 6, 5, 7, 1]
      }
    },
    {
      "name": "a deleted box selection",
      "recipe": {
        "schema": "aio.pccleanup/1",
        "layerId": "v",
        "hiddenClasses": [],
        "regions": [
          {
            "id": "a",
            "shape": "box",
            "viewProj": [0.02, 0, 0, 0, 0, 0.02, 0, 0, 0, 0, 0, 0, -10001, -64001, 0, 1],
            "polygon": [
              [-1, -1],
              [0.2, -1],
              [0.2, 0.2],
              [-1, 0.2]
            ],
            "action": { "kind": "delete" }
          }
        ]
      },
      "expect": {
        "state": ["deleted", "deleted", "kept", "kept", "kept", "kept"],
        "cls": [2, 2, 6, 5, 7, 1]
      }
    },
    {
      "name": "a lasso sets a class that is hidden",
      "recipe": {
        "schema": "aio.pccleanup/1",
        "layerId": "v",
        "hiddenClasses": [7],
        "regions": [
          {
            "id": "a",
            "shape": "lasso",
            "viewProj": [0.02, 0, 0, 0, 0, 0.02, 0, 0, 0, 0, 0, 0, -10001, -64001, 0, 1],
            "polygon": [
              [-1, -1],
              [0.9, -1],
              [-1, 0.9]
            ],
            "action": { "kind": "class", "value": 7 }
          }
        ]
      },
      "expect": {
        "state": ["kept", "classHidden", "kept", "kept", "classHidden", "kept"],
        "cls": [2, 7, 6, 5, 7, 1]
      }
    },
    {
      "name": "the later selection wins on class",
      "recipe": {
        "schema": "aio.pccleanup/1",
        "layerId": "v",
        "hiddenClasses": [],
        "regions": [
          {
            "id": "a",
            "shape": "box",
            "viewProj": [0.02, 0, 0, 0, 0, 0.02, 0, 0, 0, 0, 0, 0, -10001, -64001, 0, 1],
            "polygon": [
              [-1, -1],
              [1, -1],
              [1, 1],
              [-1, 1]
            ],
            "action": { "kind": "class", "value": 3 }
          },
          {
            "id": "b",
            "shape": "box",
            "viewProj": [0.02, 0, 0, 0, 0, 0.02, 0, 0, 0, 0, 0, 0, -10001, -64001, 0, 1],
            "polygon": [
              [-1, -1],
              [0.2, -1],
              [0.2, 0.2],
              [-1, 0.2]
            ],
            "action": { "kind": "class", "value": 4 }
          }
        ]
      },
      "expect": {
        "state": ["kept", "kept", "kept", "kept", "kept", "kept"],
        "cls": [4, 4, 3, 3, 3, 3]
      }
    },
    {
      "name": "hidden selections are kept and deletions win over them",
      "recipe": {
        "schema": "aio.pccleanup/1",
        "layerId": "v",
        "hiddenClasses": [],
        "regions": [
          {
            "id": "a",
            "shape": "box",
            "viewProj": [0.02, 0, 0, 0, 0, 0.02, 0, 0, 0, 0, 0, 0, -10001, -64001, 0, 1],
            "polygon": [
              [-1, -1],
              [1, -1],
              [1, 1],
              [-1, 1]
            ],
            "action": { "kind": "hide" }
          },
          {
            "id": "b",
            "shape": "box",
            "viewProj": [0.02, 0, 0, 0, 0, 0.02, 0, 0, 0, 0, 0, 0, -10001, -64001, 0, 1],
            "polygon": [
              [-1, -1],
              [0.2, -1],
              [0.2, 0.2],
              [-1, 0.2]
            ],
            "action": { "kind": "delete" }
          }
        ]
      },
      "expect": {
        "state": ["deleted", "deleted", "hidden", "hidden", "hidden", "hidden"],
        "cls": [2, 2, 6, 5, 7, 1]
      }
    },
    {
      "name": "a perspective selection skips points behind the camera",
      "recipe": {
        "schema": "aio.pccleanup/1",
        "layerId": "v",
        "hiddenClasses": [],
        "regions": [
          {
            "id": "a",
            "shape": "box",
            "viewProj": [0.02, 0, 0, 0, 0, 0.02, 0, 0, 0, 0, 0, 0.1, -10001, -64001, 0, -2],
            "polygon": [
              [-1, -1],
              [1, -1],
              [1, 1],
              [-1, 1]
            ],
            "action": { "kind": "delete" }
          }
        ]
      },
      "expect": {
        "state": ["kept", "kept", "deleted", "deleted", "kept", "kept"],
        "cls": [2, 2, 6, 5, 7, 1]
      }
    },
    {
      "name": "a dropped point wins over a deletion",
      "recipe": {
        "schema": "aio.pccleanup/1",
        "layerId": "v",
        "hiddenClasses": [],
        "clipBox": {
          "center": [500050, 3200050, 20],
          "size": [60, 60, 40],
          "yaw": 0,
          "keep": "inside"
        },
        "regions": [
          {
            "id": "a",
            "shape": "box",
            "viewProj": [0.02, 0, 0, 0, 0, 0.02, 0, 0, 0, 0, 0, 0, -10001, -64001, 0, 1],
            "polygon": [
              [-1, -1],
              [1, -1],
              [1, 1],
              [-1, 1]
            ],
            "action": { "kind": "delete" }
          }
        ]
      },
      "expect": {
        "state": ["deleted", "dropped", "dropped", "dropped", "dropped", "deleted"],
        "cls": [2, 2, 6, 5, 7, 1]
      }
    },
    {
      "name": "every class hidden",
      "recipe": {
        "schema": "aio.pccleanup/1",
        "layerId": "v",
        "hiddenClasses": [1, 2, 5, 6, 7],
        "regions": []
      },
      "expect": {
        "state": [
          "classHidden",
          "classHidden",
          "classHidden",
          "classHidden",
          "classHidden",
          "classHidden"
        ],
        "cls": [2, 2, 6, 5, 7, 1]
      }
    }
  ]
}
```

Hand check of the 45 degree case (cos = sin = 0.7071): with d = point minus centre, u = (cos dE + sin dN) / 20, v = (-sin dE + cos dN) / 100, w = dH / 100. P3 has d = (0, 40): u = 1.41, outside. P4 has d = (-28, 28, -25): u = 0, v = 0.40, w = -0.25, inside. P5 has d = (28, -28, -18): u = 0, v = -0.40, inside. Without the turn P3 would be inside and P4 outside, so the case catches a wrong yaw sign or axis.

- [ ] **Step 5: Wire the schema files**

`packages/schema/src/layers.ts:84`: `kind: z.enum(['change', 'model', 'cleanup']),` and extend the doc comment above `LayerDerived`: "..., or a cleaned copy of a point cloud (`cleanup`: `source` is the cleaned layer, `runId` the save job)."

`packages/schema/src/jobs.ts`:

```ts
// top, with the other imports
import { PointcloudCleanParams, PointcloudCleanup } from './pointcloudCleanup';

// PipelineName, after 'pano.stitch'
  // Point cloud cleanup (pipeline pack POINTCLOUD_CLEAN_MIN_PACK)
  'pointcloud.clean',

// PIPELINES, last entry
  {
    name: 'pointcloud.clean',
    title: 'Clean up a point cloud',
    description:
      'Marks noise with PDAL outlier filters, or writes a cleaned copy of a COPC cloud as a new layer.',
  },

// SurveyExportParams, after `measurements`
    /** `what: 'cloud'`: the layer's cleanup recipe, applied before writing (python checks the layer). */
    cleanup: PointcloudCleanup.optional(),

// PARAMS, last entry
  'pointcloud.clean': PointcloudCleanParams,
```

`packages/schema/src/jobs.test.ts`: append `'pointcloud.clean'` to the expected list after `'pano.stitch'`.

`packages/schema/src/ipc.ts`: add `Id, ProjectPath` to the `./common` import, and `import { NoiseRun, PointcloudCleanup } from './pointcloudCleanup';`. After `'survey:writeTerrainEdits'`:

```ts
  /**
   * Every cleanup recipe of a project (`edits/pointcloud/<layer>.json`, `aio.pccleanup/1`); with
   * `noiseRun`, also the record a `pointcloud.clean` noise job wrote beside its working copy
   * (null when it is missing). `readOnly` for a package.
   */
  'pointcloud:readCleanup': {
    request: z
      .object({
        projectId: ProjectId,
        noiseRun: z.object({ layerId: Id, runId: JobId }).strict().optional(),
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        recipes: z.array(PointcloudCleanup),
        noise: NoiseRun.nullable().optional(),
        readOnly: z.boolean(),
      }),
      Failure,
    ]),
  },
  /**
   * Write one layer's recipe atomically (`.bak`, journaled), or with `recipe: null` remove it
   * (kept as `.bak`). Noise working copies of the layer named neither by the recipe nor in `keep`
   * (the renderer's undo history) move to the project trash; `trashed` names them. Refused for
   * packages.
   */
  'pointcloud:writeCleanup': {
    request: z
      .object({
        projectId: ProjectId,
        layerId: Id,
        recipe: PointcloudCleanup.nullable(),
        keep: z.array(ProjectPath).max(200).optional(),
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), trashed: z.array(z.string()) }),
      Failure,
    ]),
  },
```

`packages/schema/src/versions.ts`, after the `aio.pano-stitch` row:

```ts
  // the cleanup recipe of a point cloud layer (pointcloudCleanup.ts); its noise run records and
  // working copies sit beside it
  {
    family: 'aio.pccleanup',
    version: 1,
    home: 'project',
    where: 'edits/pointcloud/<layer>.json',
    since: '0.16',
  },
```

`packages/schema/src/index.ts`, after `export * from './panoStitch';`: `export * from './pointcloudCleanup';`

- [ ] **Step 6: Wire the app's pipeline tables and the preload**

`apps/desktop/src/preload/index.ts`, after `'survey:writeTerrainEdits': true,`:

```ts
  'pointcloud:readCleanup': true,
  'pointcloud:writeCleanup': true,
```

`apps/desktop/src/renderer/jobs.ts`: in `MANIFEST_WRITERS` after `'pano.stitch',`:

```ts
  // Point cloud cleanup: a cleaned copy is a new layer (the noise run writes edits/ only, and the
  // reload is harmless for it)
  'pointcloud.clean',
```

and in `FORMS` after `'pano.stitch': [],`: `// started from the Clean up panel only` then `'pointcloud.clean': [],`.

`apps/desktop/src/renderer/processing/pipelines.ts`: `PIPELINE_GROUP` gets `'pointcloud.clean': 'import',` after `'pointcloud.to_copc': 'import',`; `JOB_KIND` gets `'pointcloud.clean': 'files',` after `'pointcloud.to_copc': 'files',`.

- [ ] **Step 7: Write the compat pin**

Create `tools/compat/pointcloud-cleanup-additive.test.mjs`:

```js
// Point cloud cleanup (plan 2026-10-15-pointcloud-cleanup), pinned against the 0.11 schema
// (tools/compat/schema-0.11):
// - the recipes, noise records and working copies live in `edits/pointcloud/`, which 0.11 never reads;
// - the job index lists pointcloud.clean jobs and survey.export jobs with a recipe, which 0.11's index
//   reader skips one by one instead of refusing the file;
// - the known break: a manifest holding a cleaned copy (`derived.kind: 'cleanup'`) is refused by
//   0.11 and every build before this one (LayerDerived is strict). Contract row of 15 Oct 2026.
import { describe, expect, it } from 'vitest';
import * as current from '../../packages/schema/src/index.ts';
import * as v011 from './schema-0.11/index.mjs';

const job = (pipeline, params) => ({
  id: '20261015-101500-pointcloud-clean-a1b2',
  pipeline,
  project: 'D:/data/projects/demo',
  params,
  status: 'done',
  progress: 1,
  steps: [],
  artifacts: [],
  createdAt: '2026-10-15T10:15:00Z',
  updatedAt: '2026-10-15T10:16:00Z',
});

const manifest = (layers) => ({
  schema: 'aio.project/1',
  id: 'demo',
  name: 'Demo',
  customer: 'Demo',
  site: 'Synthetic',
  crs: { epsg: 32639 },
  origin: [500000, 3200000, 0],
  captures: [],
  layers,
  severityModels: [],
  classCatalogues: [],
});
const cloud = {
  kind: 'pointcloud',
  id: 'cloud-a',
  name: 'Scan',
  visible: false,
  src: { path: 'clouds/a.copc.laz' },
  format: 'copc',
};

describe('point cloud cleanup is additive, but for cleaned copies', () => {
  it('keeps its files in edits/pointcloud, which 0.11 never reads', () => {
    const row = current.SCHEMA_REGISTRY.find((e) => e.family === 'aio.pccleanup');
    expect(row?.home).toBe('project');
    expect(row?.where.startsWith('edits/pointcloud/')).toBe(true);
    expect(v011.SCHEMA_REGISTRY.some((e) => e.family === 'aio.pccleanup')).toBe(false);
  });

  it('lists pointcloud.clean jobs that 0.11 skips one by one', () => {
    const j = job('pointcloud.clean', {
      mode: 'noise',
      layerId: 'cloud-a',
      src: 'clouds/a.copc.laz',
      outlier: { meanK: 8, multiplier: 2 },
    });
    expect(current.JobRecord.safeParse(j).success).toBe(true);
    expect(v011.JobRecord.safeParse(j).success).toBe(false);
  });

  it('keeps survey.export jobs without a recipe readable by 0.11', () => {
    const params = { what: 'cloud', format: 'laz', crs: 'site', layer: 'cloud-a', out: 'D:/a.laz' };
    expect(v011.SurveyExportParams.safeParse(params).success).toBe(true);
    expect(
      current.SurveyExportParams.safeParse({ ...params, cleanup: current.emptyCleanup('cloud-a') })
        .success,
    ).toBe(true);
    expect(
      v011.SurveyExportParams.safeParse({ ...params, cleanup: current.emptyCleanup('cloud-a') })
        .success,
    ).toBe(false);
  });

  it('a manifest without a cleaned copy still opens in 0.11; one with a copy does not', () => {
    expect(v011.ProjectManifest.safeParse(manifest([cloud])).success).toBe(true);
    const copy = {
      ...cloud,
      id: 'cloud-a-cleaned',
      name: 'Scan (cleaned)',
      visible: true,
      src: { path: 'clouds/cloud-a-cleaned.copc.laz' },
      derived: { kind: 'cleanup', source: ['cloud-a'], runId: 'j1' },
    };
    expect(current.ProjectManifest.safeParse(manifest([cloud, copy])).success).toBe(true);
    expect(v011.ProjectManifest.safeParse(manifest([cloud, copy])).success).toBe(false);
  });
});
```

If `schema-0.11/index.mjs` does not export `SCHEMA_REGISTRY`, drop that one assertion (the snapshot predates the family either way); read the snapshot's exports first.

- [ ] **Step 8: Append the contract rows**

Append the five rows of the "Contract changes" section of this plan to `docs/architecture/contract-changes.md`, after its last row.

- [ ] **Step 9: Run the tests and the type check**

Run:

```bash
pnpm exec prettier --write packages/schema/test-data/pccleanup-vectors.json
pnpm exec vitest run packages/schema/src/pointcloudCleanup.test.ts packages/schema/src/jobs.test.ts packages/schema/src/versions.test.ts tools/compat/pointcloud-cleanup-additive.test.mjs apps/desktop/src/renderer/processing/pipelines.test.ts
pnpm typecheck
```

Expected: all PASS; `versions.test.ts` "lists every aio.* schema id" passes with the new row; `tsc -b` clean (the `Record<PipelineName, ...>` tables compile).

- [ ] **Step 10: Commit**

```bash
git add packages/schema/src/pointcloudCleanup.ts packages/schema/src/pointcloudCleanup.test.ts packages/schema/test-data/pccleanup-vectors.json packages/schema/src/layers.ts packages/schema/src/jobs.ts packages/schema/src/jobs.test.ts packages/schema/src/ipc.ts packages/schema/src/versions.ts packages/schema/src/index.ts apps/desktop/src/preload/index.ts apps/desktop/src/renderer/jobs.ts apps/desktop/src/renderer/processing/pipelines.ts tools/compat/pointcloud-cleanup-additive.test.mjs docs/architecture/contract-changes.md
git commit -m "feat(schema): point cloud cleanup recipe, pointcloud.clean and cleanup channels"
```

---

### Task 2: Strings and shortcuts

**Packages touched:** `@aio/ui`.
**Contract change:** no. **E2E:** none.

**Files:**

- Modify: `packages/ui/src/i18n/en.ts` (a `// Point cloud cleanup` block after the `stage.cutaway.*` keys, ~line 700; the `keys.*` labels next to `keys.volumes.undo`, ~line 1073; `keys.scope.cleanup` next to `keys.scope.volumes`, ~line 1025)
- Modify: `packages/ui/src/shortcuts.ts` (`ShortcutScope` line 17; `SHORTCUT_SCOPES` line 50; `CONCURRENT_SCOPES` line 74; two shortcuts after `volumes.undo`, ~line 184)
- Create: `packages/ui/src/cleanupStrings.test.ts`

**Interfaces:**

- Produces: the message keys below (later tasks use exactly these and add none); `ShortcutScope` member `'cleanup'`; `ShortcutId`s `'cleanup.undo'` (Ctrl+Z) and `'cleanup.redo'` (Ctrl+Y, Ctrl+Shift+Z).

- [ ] **Step 1: Write the failing test**

Create `packages/ui/src/cleanupStrings.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { en } from './i18n/en';
import { t } from './i18n';
import { SHORTCUTS, SHORTCUT_SCOPES, shortcutConflicts } from './shortcuts';

const KEYS = [
  'cleanup.tool',
  'cleanup.title',
  'cleanup.layer',
  'cleanup.none',
  'cleanup.copcOnly',
  'cleanup.readOnly',
  'cleanup.box.title',
  'cleanup.box.edit',
  'cleanup.box.editing',
  'cleanup.box.fit',
  'cleanup.box.keep',
  'cleanup.box.inside',
  'cleanup.box.outside',
  'cleanup.box.reset',
  'cleanup.box.size',
  'cleanup.height.title',
  'cleanup.height.min',
  'cleanup.height.max',
  'cleanup.height.clear',
  'cleanup.select.title',
  'cleanup.select.box',
  'cleanup.select.lasso',
  'cleanup.select.hint',
  'cleanup.select.count_one',
  'cleanup.select.count_other',
  'cleanup.select.hide',
  'cleanup.select.delete',
  'cleanup.select.setClass',
  'cleanup.select.cancel',
  'cleanup.select.near',
  'cleanup.select.full',
  'cleanup.noise.title',
  'cleanup.noise.run',
  'cleanup.noise.running',
  'cleanup.noise.settings',
  'cleanup.noise.neighbours',
  'cleanup.noise.multiplier',
  'cleanup.noise.low',
  'cleanup.noise.cell',
  'cleanup.noise.threshold',
  'cleanup.noise.result',
  'cleanup.noise.none',
  'cleanup.noise.undo',
  'cleanup.save.title',
  'cleanup.save.name',
  'cleanup.save.run',
  'cleanup.save.started',
  'cleanup.undo',
  'cleanup.redo',
  'cleanup.reset',
  'cleanup.notice.hidden',
  'cleanup.notice.deleted',
  'cleanup.notice.classSet',
  'cleanup.notice.noise',
  'cleanup.notice.reset',
  'cleanup.notice.undo',
  'cleanup.notice.dismiss',
  'cleanup.notice.error',
  'cleanup.menu.open',
  'cleanup.menu.noise',
  'cleanup.menu.save',
  'cleanup.menu.reset',
  'cleanup.export.apply',
  'cleanup.export.removes',
  'cleanup.export.nothing',
  'cleanup.part.boxOutside',
  'cleanup.part.boxInside',
  'cleanup.part.height',
  'cleanup.part.deletes_one',
  'cleanup.part.deletes_other',
  'cleanup.part.classes',
  'keys.scope.cleanup',
  'keys.cleanup.undo',
  'keys.cleanup.redo',
] as const;

describe('point cloud cleanup strings', () => {
  it('has every key, without dashes or emoji', () => {
    const cat = en as Record<string, string>;
    for (const k of KEYS) {
      expect(cat[k], k).toBeTruthy();
      expect(cat[k], k).not.toMatch(/[\u2013\u2014]|\p{Extended_Pictographic}/u);
    }
  });

  it('counts selected points and fills the noise result', () => {
    expect(t('cleanup.select.count', { count: 1 })).toBe('1 loaded point selected');
    expect(t('cleanup.select.count', { count: 1200 })).toBe('1200 loaded points selected');
    expect(t('cleanup.noise.result', { count: 60, share: '0.4 %' })).toBe(
      '60 points (0.4 %) marked as noise',
    );
  });
});

describe('cleanup shortcuts', () => {
  it('undo and redo in their own scope, shadowing the issue editor on purpose', () => {
    expect(SHORTCUT_SCOPES.some((s) => s.scope === 'cleanup')).toBe(true);
    const undo = SHORTCUTS.find((s) => s.id === 'cleanup.undo');
    const redo = SHORTCUTS.find((s) => s.id === 'cleanup.redo');
    expect(undo?.keys).toEqual(['Ctrl+Z']);
    expect(redo?.keys).toEqual(['Ctrl+Y', 'Ctrl+Shift+Z']);
    expect(shortcutConflicts()).toEqual([]);
  });
});
```

Check `shortcutConflicts`'s real signature in `shortcuts.ts` (near line 630) before writing the last line; if it takes the table, pass `SHORTCUTS`.

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm exec vitest run packages/ui/src/cleanupStrings.test.ts`
Expected: FAIL (missing keys; `cleanup` scope unknown).

- [ ] **Step 3: Add the strings**

In `packages/ui/src/i18n/en.ts`, after the `stage.cutaway.*` block:

```ts
  // Point cloud cleanup (Clean up panel, right-click menu, export)
  'cleanup.tool': 'Clean up the point cloud',
  'cleanup.title': 'Clean up',
  'cleanup.layer': 'Point cloud',
  'cleanup.none': 'Select a COPC point cloud layer to clean up.',
  'cleanup.copcOnly': 'Cleanup works on COPC clouds. Convert this cloud to COPC to clean it up.',
  'cleanup.readOnly': 'This project is a read-only package: the cleanup is shown, not changed.',
  'cleanup.box.title': 'Clip box',
  'cleanup.box.edit': 'Edit box',
  'cleanup.box.editing': 'Drag a face to resize the box, the ring to turn it.',
  'cleanup.box.fit': 'Fit to layer',
  'cleanup.box.keep': 'Keep',
  'cleanup.box.inside': 'Inside',
  'cleanup.box.outside': 'Outside',
  'cleanup.box.reset': 'Remove box',
  'cleanup.box.size': '{x} x {y} x {z} m',
  'cleanup.height.title': 'Height range',
  'cleanup.height.min': 'Lowest (m)',
  'cleanup.height.max': 'Highest (m)',
  'cleanup.height.clear': 'Clear',
  'cleanup.select.title': 'Select points',
  'cleanup.select.box': 'Box',
  'cleanup.select.lasso': 'Lasso',
  'cleanup.select.hint': 'Drag over the view. Esc cancels.',
  'cleanup.select.count_one': '{count} loaded point selected',
  'cleanup.select.count_other': '{count} loaded points selected',
  'cleanup.select.hide': 'Hide',
  'cleanup.select.delete': 'Delete',
  'cleanup.select.setClass': 'Set class',
  'cleanup.select.cancel': 'Cancel',
  'cleanup.select.near': 'Many selections ({count} of {max}): save a cleaned copy soon.',
  'cleanup.select.full':
    'This cloud has {max} selections. Save a cleaned copy and go on cleaning that.',
  'cleanup.noise.title': 'Remove noise',
  'cleanup.noise.run': 'Remove noise',
  'cleanup.noise.running': 'Finding noise…',
  'cleanup.noise.settings': 'Settings',
  'cleanup.noise.neighbours': 'Neighbours',
  'cleanup.noise.multiplier': 'Distance limit (standard deviations)',
  'cleanup.noise.low': 'Also mark low points',
  'cleanup.noise.cell': 'Cell size (m)',
  'cleanup.noise.threshold': 'Height threshold (m)',
  'cleanup.noise.result': '{count} points ({share}) marked as noise',
  'cleanup.noise.none': 'No new noise found: nothing was marked.',
  'cleanup.noise.undo': 'Undo',
  'cleanup.save.title': 'Save cleaned copy',
  'cleanup.save.name': 'Name',
  'cleanup.save.run': 'Save',
  'cleanup.save.started': 'Saving the cleaned copy. It appears in Datasets when it is done.',
  'cleanup.undo': 'Undo',
  'cleanup.redo': 'Redo',
  'cleanup.reset': 'Reset all cleanup',
  'cleanup.notice.hidden': 'Points hidden in the view.',
  'cleanup.notice.deleted': 'Points deleted from saves and exports.',
  'cleanup.notice.classSet': 'Class set to {name}.',
  'cleanup.notice.noise': '{count} points marked as noise.',
  'cleanup.notice.reset': 'Cleanup reset.',
  'cleanup.notice.undo': 'Undo',
  'cleanup.notice.dismiss': 'Dismiss',
  'cleanup.notice.error': 'The cleanup was not saved: {error}',
  'cleanup.menu.open': 'Clean up…',
  'cleanup.menu.noise': 'Remove noise…',
  'cleanup.menu.save': 'Save cleaned copy…',
  'cleanup.menu.reset': 'Reset cleanup',
  'cleanup.export.apply': 'Apply cleanup',
  'cleanup.export.removes': 'Removes {parts}.',
  'cleanup.export.nothing': 'Nothing is removed: the cleanup only hides points in the view.',
  'cleanup.part.boxOutside': 'points outside the clip box',
  'cleanup.part.boxInside': 'points inside the clip box',
  'cleanup.part.height': 'points outside the height range',
  'cleanup.part.deletes_one': '{count} deleted selection',
  'cleanup.part.deletes_other': '{count} deleted selections',
  'cleanup.part.classes': 'the hidden classes ({list})',
```

Next to `'keys.scope.volumes'`: `'keys.scope.cleanup': 'Cleaning up a point cloud',`. Next to `'keys.volumes.undo'`: `'keys.cleanup.undo': 'Undo the last cleanup step',` and `'keys.cleanup.redo': 'Redo the cleanup step',`.

- [ ] **Step 4: Add the scope and the shortcuts**

`packages/ui/src/shortcuts.ts`: add `| 'cleanup'` to `ShortcutScope` after `'volumes'`; `{ scope: 'cleanup', label: 'keys.scope.cleanup' },` in `SHORTCUT_SCOPES` after the volumes row; `['scene', 'cleanup'],` and `['cleanup', 'issues'],` in `CONCURRENT_SCOPES`; after the `volumes.undo` entry:

```ts
  // the point cloud Clean up panel or one of its tools (renderer/pointcloud/cleanupScene.ts)
  {
    id: 'cleanup.undo',
    scope: 'cleanup',
    keys: ['Ctrl+Z'],
    label: 'keys.cleanup.undo',
    shadows: ['issues.undo'],
  },
  {
    id: 'cleanup.redo',
    scope: 'cleanup',
    keys: ['Ctrl+Y', 'Ctrl+Shift+Z'],
    label: 'keys.cleanup.redo',
    shadows: ['issues.redo'],
  },
```

- [ ] **Step 5: Run the tests**

Run: `pnpm exec vitest run packages/ui/src/cleanupStrings.test.ts packages/ui/src/i18n/i18n.test.ts packages/ui/src/shortcuts.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/i18n/en.ts packages/ui/src/shortcuts.ts packages/ui/src/cleanupStrings.test.ts
git commit -m "feat(ui): strings and undo shortcuts for point cloud cleanup"
```

---

### Task 3: TS evaluator, frame helpers and the live recipe store

**Packages touched:** `@aio/pointcloud`.
**Contract change:** no. **E2E:** none.

**Files:**

- Create: `packages/pointcloud/src/cleanup/frame.ts`
- Create: `packages/pointcloud/src/cleanup/polygon.ts`
- Create: `packages/pointcloud/src/cleanup/evaluate.ts`
- Create: `packages/pointcloud/src/cleanup/store.ts`
- Create: `packages/pointcloud/src/cleanup/evaluate.test.ts`
- Create: `packages/pointcloud/src/cleanup/store.test.ts`
- Modify: `packages/pointcloud/src/index.ts` (exports, appended)

**Interfaces:**

- Consumes: `PointcloudCleanup` (Task 1); `CleanupUniforms` type from `../material` (Task 5); the vectors file (Task 1).
- Produces:
  - `frame.ts`: `type M4 = Float64Array` (16, column-major); `mul4(a: ArrayLike<number>, b: ArrayLike<number>): M4`; `localToWorld(origin: V3): M4`; `worldToLocal(origin: V3): M4`; `boxInverseWorld(box: ClipBox): M4` (world to the unit box `[-0.5, 0.5]^3`)
  - `polygon.ts`: `type Ring = Float64Array`; `ringOf(poly: readonly (readonly [number, number])[]): Ring`; `pointInPolygon(ring: Ring, x: number, y: number): boolean` (even-odd)
  - `evaluate.ts`: `type CleanupState = 'kept' | 'hidden' | 'classHidden' | 'deleted' | 'dropped'`; `STATE: { kept: 0; hidden: 1; classHidden: 2; deleted: 3; dropped: 4 }`; `STATE_NAMES: readonly CleanupState[]`; `interface CompiledCleanup`; `compileCleanup(r: PointcloudCleanup, frame?: { origin: V3 } | null): CompiledCleanup`; `applyRegions(c, x, y, z, cls, out: RegionHit): RegionHit`; `evaluatePoint(c, x, y, z, cls): { state: number; cls: number }`; `evaluateAll(c, xyz: ArrayLike<number>, cls: ArrayLike<number>): { state: Uint8Array; cls: Uint8Array }`; `cleanupUniformsOf(c: CompiledCleanup | null): CleanupUniforms`
  - `store.ts`: `interface CleanupRecipes { recipes: Readonly<Record<string, PointcloudCleanup>>; set(layerId: string, r: PointcloudCleanup | null): void; clear(): void }`; `createCleanupRecipes(): StoreApi<CleanupRecipes>`; `pointcloudCleanup: StoreApi<CleanupRecipes>` (the app's one instance)

- [ ] **Step 1: Write the failing tests**

Create `packages/pointcloud/src/cleanup/evaluate.test.ts`:

```ts
import { emptyCleanup, PointcloudCleanup } from '@aio/schema';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  STATE_NAMES,
  cleanupUniformsOf,
  compileCleanup,
  evaluateAll,
  evaluatePoint,
} from './evaluate';
import { localToWorld, mul4, worldToLocal } from './frame';
import { pointInPolygon, ringOf } from './polygon';

const file = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'schema',
  'test-data',
  'pccleanup-vectors.json',
);
const V = JSON.parse(readFileSync(file, 'utf8')) as {
  points: { id: string; xyz: [number, number, number]; cls: number }[];
  cases: { name: string; recipe: unknown; expect: { state: string[]; cls: number[] } }[];
};
const xyz = V.points.flatMap((p) => p.xyz);
const cls = V.points.map((p) => p.cls);

describe('the shared vectors', () => {
  for (const c of V.cases) {
    it(c.name, () => {
      const r = PointcloudCleanup.parse(c.recipe);
      const out = evaluateAll(compileCleanup(r), xyz, cls);
      expect([...out.state].map((s) => STATE_NAMES[s])).toEqual(c.expect.state);
      expect([...out.cls]).toEqual(c.expect.cls);
    });
  }

  it('gives the same outcome in the local frame of a far origin as in world coordinates', () => {
    const origin = [500000, 3200000, 5] as const;
    // local: x = E - oE, y = H - oH, z = oN - N (data-conventions section 1)
    const local = V.points.flatMap((p) => [
      p.xyz[0] - origin[0],
      p.xyz[2] - origin[2],
      origin[1] - p.xyz[1],
    ]);
    for (const c of V.cases) {
      const r = PointcloudCleanup.parse(c.recipe);
      const out = evaluateAll(compileCleanup(r, { origin }), local, cls);
      expect(
        [...out.state].map((s) => STATE_NAMES[s]),
        c.name,
      ).toEqual(c.expect.state);
      expect([...out.cls], c.name).toEqual(c.expect.cls);
    }
  });
});

describe('frames', () => {
  it('maps world to local and back', () => {
    const o = [500000, 3200000, 5] as const;
    const id = mul4(worldToLocal(o), localToWorld(o));
    expect([...id].map((v) => Math.round(v * 1e9) / 1e9)).toEqual([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
    ]);
    const w2l = worldToLocal(o);
    const [e, n, h] = [500012, 3200034, 9];
    const m = (i: number) => w2l[i] ?? 0;
    const x = m(0) * e + m(4) * n + m(8) * h + m(12);
    const y = m(1) * e + m(5) * n + m(9) * h + m(13);
    const z = m(2) * e + m(6) * n + m(10) * h + m(14);
    expect([x, y, z]).toEqual([12, 4, -34]);
  });
});

describe('polygons', () => {
  it('uses the even-odd rule', () => {
    const ring = ringOf([
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
    ]);
    expect(pointInPolygon(ring, 2, 2)).toBe(true);
    expect(pointInPolygon(ring, 5, 2)).toBe(false);
    // a bow tie: inside its left lobe, outside the gap under the crossing
    const bow = ringOf([
      [0, 0],
      [4, 4],
      [4, 0],
      [0, 4],
    ]);
    expect(pointInPolygon(bow, 1, 2)).toBe(true);
    expect(pointInPolygon(bow, 2, 1)).toBe(false);
  });
});

describe('points and uniforms', () => {
  it('drops a point under the lowest height in the local frame', () => {
    const r = { ...emptyCleanup('a'), height: { min: 5 } };
    const c = compileCleanup(r, { origin: [0, 0, 2] });
    // local y 2 is world height 4: under 5
    expect(evaluatePoint(c, 0, 2, 0, 1).state).toBe(4);
    expect(evaluatePoint(c, 0, 4, 0, 1).state).toBe(0);
  });

  it('gives shader uniforms without a box and with one', () => {
    expect(cleanupUniformsOf(null)).toEqual({
      boxInv: null,
      keepInside: true,
      zMin: -1e30,
      zMax: 1e30,
    });
    const r = {
      ...emptyCleanup('a'),
      clipBox: {
        center: [10, 20, 3] as [number, number, number],
        size: [2, 4, 6] as [number, number, number],
        yaw: 0,
        keep: 'outside' as const,
      },
      height: { max: 8 },
    };
    const u = cleanupUniformsOf(compileCleanup(r, { origin: [10, 20, 0] }));
    expect(u.keepInside).toBe(false);
    expect(u.zMax).toBe(8);
    expect(u.boxInv).toHaveLength(16);
    // the box centre (local 0, 3, 0) maps to the unit box centre
    const b = u.boxInv ?? [];
    expect((b[1] ?? 0) * 0 + (b[5] ?? 0) * 3 + (b[9] ?? 0) * 0 + (b[13] ?? 0)).toBeCloseTo(0, 9);
  });
});
```

Create `packages/pointcloud/src/cleanup/store.test.ts`:

```ts
import { emptyCleanup } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { createCleanupRecipes } from './store';

describe('the live recipes', () => {
  it('sets, replaces and removes a layer recipe, a new object each time', () => {
    const s = createCleanupRecipes();
    const before = s.getState().recipes;
    s.getState().set('a', emptyCleanup('a'));
    expect(s.getState().recipes.a?.layerId).toBe('a');
    expect(s.getState().recipes).not.toBe(before);
    s.getState().set('a', null);
    expect(s.getState().recipes.a).toBeUndefined();
    s.getState().set('b', emptyCleanup('b'));
    s.getState().clear();
    expect(s.getState().recipes).toEqual({});
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run packages/pointcloud/src/cleanup/evaluate.test.ts packages/pointcloud/src/cleanup/store.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Write `frame.ts` and `polygon.ts`**

`packages/pointcloud/src/cleanup/frame.ts`:

```ts
/**
 * 4 x 4 matrices (Float64, column-major, as three.js stores them) between the project CRS
 * (E, N, H) and the viewer's local frame (x east, y up, z south, from the project origin;
 * data-conventions section 1). Float64 throughout: UTM coordinates lose centimetres in float32.
 */
import type { ClipBox } from '@aio/schema';

type V3 = readonly [number, number, number];
export type M4 = Float64Array;

export function mul4(a: ArrayLike<number>, b: ArrayLike<number>): M4 {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += (a[k * 4 + r] ?? 0) * (b[c * 4 + k] ?? 0);
      out[c * 4 + r] = s;
    }
  return out;
}

/** Local to world: E = x + oE, N = oN - z, H = y + oH. */
export function localToWorld(o: V3): M4 {
  return Float64Array.of(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, o[0], o[1], o[2], 1);
}

/** World to local: x = E - oE, y = H - oH, z = oN - N. */
export function worldToLocal(o: V3): M4 {
  return Float64Array.of(1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, -o[0], -o[2], o[1], 1);
}

/**
 * World to the clip box's unit cube: u along the box's east axis, v along its north axis, w up,
 * each divided by the size, so the box is |u|, |v|, |w| <= 0.5.
 */
export function boxInverseWorld(b: ClipBox): M4 {
  const c = Math.cos(b.yaw);
  const s = Math.sin(b.yaw);
  const [cx, cy, cz] = b.center;
  const [sx, sy, sz] = b.size;
  return Float64Array.of(
    c / sx,
    -s / sy,
    0,
    0,
    s / sx,
    c / sy,
    0,
    0,
    0,
    0,
    1 / sz,
    0,
    -(c * cx + s * cy) / sx,
    (s * cx - c * cy) / sy,
    -cz / sz,
    1,
  );
}
```

(prettier reflows the `Float64Array.of` argument list; the order above is column by column.)

`packages/pointcloud/src/cleanup/polygon.ts`:

```ts
/** Point in polygon by the even-odd rule, the same loop as python `in_polygon` (evaluate.py). */
export type Ring = Float64Array;

export function ringOf(poly: readonly (readonly [number, number])[]): Ring {
  const ring = new Float64Array(poly.length * 2);
  poly.forEach(([x, y], i) => {
    ring[2 * i] = x;
    ring[2 * i + 1] = y;
  });
  return ring;
}

export function pointInPolygon(ring: Ring, x: number, y: number): boolean {
  const n = ring.length / 2;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[2 * i] ?? 0;
    const yi = ring[2 * i + 1] ?? 0;
    const xj = ring[2 * j] ?? 0;
    const yj = ring[2 * j + 1] ?? 0;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
```

- [ ] **Step 4: Write `evaluate.ts`**

```ts
/**
 * The cleanup recipe (`aio.pccleanup/1`) per point. Two uses: the viewer (local frame, compiled
 * with the project origin; Task 6 masks chunks with `applyRegions`, the shader does the box and
 * the heights) and the shared vectors, which pin it to the pipeline's numpy evaluator
 * (python/src/aio_pipelines/pointcloud_cleanup/evaluate.py). Pure: no three.js, worker safe.
 */
import type { PointcloudCleanup } from '@aio/schema';
import type { CleanupUniforms } from '../material';
import { boxInverseWorld, localToWorld, mul4, type M4 } from './frame';
import { pointInPolygon, ringOf, type Ring } from './polygon';

type V3 = readonly [number, number, number];

export type CleanupState = 'kept' | 'hidden' | 'classHidden' | 'deleted' | 'dropped';
/** One byte a point; a higher code wins (dropped > deleted > classHidden > hidden > kept). */
export const STATE = { kept: 0, hidden: 1, classHidden: 2, deleted: 3, dropped: 4 } as const;
export const STATE_NAMES: readonly CleanupState[] = [
  'kept',
  'hidden',
  'classHidden',
  'deleted',
  'dropped',
];

export interface CompiledRegion {
  /** Frame (world or local) to clip, column-major. */
  m: M4;
  ring: Ring;
  /** NDC bounding box of the ring: [minX, minY, maxX, maxY]. */
  bbox: [number, number, number, number];
  kind: 'hide' | 'delete' | 'class';
  value: number;
}

export interface CompiledCleanup {
  regions: CompiledRegion[];
  /** Frame to the unit box; null without a clip box. */
  boxInv: M4 | null;
  keepInside: boolean;
  /** Height range along the frame's up axis. */
  zMin: number;
  zMax: number;
  /** Index of the up coordinate: 2 in world (E, N, H), 1 in the local frame. */
  up: 1 | 2;
  /** 1 for each hidden class code. */
  hidden: Uint8Array;
}

/** Compile for world coordinates, or with `frame` for the viewer's local frame. */
export function compileCleanup(
  r: PointcloudCleanup,
  frame: { origin: V3 } | null = null,
): CompiledCleanup {
  const toWorld = frame ? localToWorld(frame.origin) : null;
  const regions = r.regions.map((g): CompiledRegion => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of g.polygon) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    return {
      m: toWorld ? mul4(g.viewProj, toWorld) : Float64Array.from(g.viewProj),
      ring: ringOf(g.polygon),
      bbox: [minX, minY, maxX, maxY],
      kind: g.action.kind,
      value: g.action.kind === 'class' ? g.action.value : 0,
    };
  });
  const box = r.clipBox ? boxInverseWorld(r.clipBox) : null;
  const dz = frame ? frame.origin[2] : 0;
  const hidden = new Uint8Array(256);
  for (const c of r.hiddenClasses) hidden[c] = 1;
  return {
    regions,
    boxInv: box && toWorld ? mul4(box, toWorld) : box,
    keepInside: r.clipBox?.keep !== 'outside',
    zMin: (r.height?.min ?? -Infinity) - dz,
    zMax: (r.height?.max ?? Infinity) - dz,
    up: frame ? 1 : 2,
    hidden,
  };
}

export interface RegionHit {
  cls: number;
  hide: boolean;
  del: boolean;
}

/** Step 2 of the evaluation: the regions in order (later ones win on class). */
export function applyRegions(
  c: CompiledCleanup,
  x: number,
  y: number,
  z: number,
  cls: number,
  out: RegionHit,
): RegionHit {
  out.cls = cls;
  out.hide = false;
  out.del = false;
  for (const g of c.regions) {
    const m = g.m;
    const w = (m[3] ?? 0) * x + (m[7] ?? 0) * y + (m[11] ?? 0) * z + (m[15] ?? 0);
    if (!(w > 0)) continue;
    const nx = ((m[0] ?? 0) * x + (m[4] ?? 0) * y + (m[8] ?? 0) * z + (m[12] ?? 0)) / w;
    const ny = ((m[1] ?? 0) * x + (m[5] ?? 0) * y + (m[9] ?? 0) * z + (m[13] ?? 0)) / w;
    if (nx < g.bbox[0] || ny < g.bbox[1] || nx > g.bbox[2] || ny > g.bbox[3]) continue;
    if (!pointInPolygon(g.ring, nx, ny)) continue;
    if (g.kind === 'class') out.cls = g.value;
    else if (g.kind === 'hide') out.hide = true;
    else out.del = true;
  }
  return out;
}

const hit: RegionHit = { cls: 0, hide: false, del: false };

/** Steps 3 and 4: clip box and heights drop, then hidden classes hide. */
export function evaluatePoint(
  c: CompiledCleanup,
  x: number,
  y: number,
  z: number,
  cls: number,
): { state: number; cls: number } {
  applyRegions(c, x, y, z, cls, hit);
  const h = c.up === 2 ? z : y;
  let dropped = h < c.zMin || h > c.zMax;
  const b = c.boxInv;
  if (!dropped && b) {
    const u = (b[0] ?? 0) * x + (b[4] ?? 0) * y + (b[8] ?? 0) * z + (b[12] ?? 0);
    const v = (b[1] ?? 0) * x + (b[5] ?? 0) * y + (b[9] ?? 0) * z + (b[13] ?? 0);
    const w = (b[2] ?? 0) * x + (b[6] ?? 0) * y + (b[10] ?? 0) * z + (b[14] ?? 0);
    const inside = Math.abs(u) <= 0.5 && Math.abs(v) <= 0.5 && Math.abs(w) <= 0.5;
    dropped = inside !== c.keepInside;
  }
  const state = dropped
    ? STATE.dropped
    : hit.del
      ? STATE.deleted
      : c.hidden[hit.cls]
        ? STATE.classHidden
        : hit.hide
          ? STATE.hidden
          : STATE.kept;
  return { state, cls: hit.cls };
}

/** Every point of a flat xyz list (the vectors, tests). */
export function evaluateAll(
  c: CompiledCleanup,
  xyz: ArrayLike<number>,
  cls: ArrayLike<number>,
): { state: Uint8Array; cls: Uint8Array } {
  const n = cls.length;
  const state = new Uint8Array(n);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const e = evaluatePoint(
      c,
      xyz[3 * i] ?? 0,
      xyz[3 * i + 1] ?? 0,
      xyz[3 * i + 2] ?? 0,
      cls[i] ?? 0,
    );
    state[i] = e.state;
    out[i] = e.cls;
  }
  return { state, cls: out };
}

/** The shader's share (material.ts `applyCleanupUniforms`), for a recipe compiled in the local frame. */
export function cleanupUniformsOf(c: CompiledCleanup | null): CleanupUniforms {
  return {
    boxInv: c?.boxInv ? Array.from(c.boxInv) : null,
    keepInside: c?.keepInside ?? true,
    zMin: Math.max(c?.zMin ?? -Infinity, -1e30),
    zMax: Math.min(c?.zMax ?? Infinity, 1e30),
  };
}
```

- [ ] **Step 5: Write `store.ts` and the exports**

`packages/pointcloud/src/cleanup/store.ts`:

```ts
/**
 * The cleanup recipes the viewer shows, by layer id. The app's cleanup store
 * (apps/desktop/src/renderer/pointcloud/cleanupStore.ts) owns history and saving and pushes the
 * current recipe here; CloudManager and the adapter (Task 6) follow it. A drag of the clip box
 * pushes live values here without an undo step.
 */
import type { PointcloudCleanup } from '@aio/schema';
import { createStore, type StoreApi } from 'zustand/vanilla';

export interface CleanupRecipes {
  recipes: Readonly<Record<string, PointcloudCleanup>>;
  set(layerId: string, recipe: PointcloudCleanup | null): void;
  clear(): void;
}

export function createCleanupRecipes(): StoreApi<CleanupRecipes> {
  return createStore<CleanupRecipes>()((set) => ({
    recipes: {},
    set: (layerId, recipe) => {
      set((s) => {
        const next = { ...s.recipes };
        if (recipe) next[layerId] = recipe;
        else delete next[layerId];
        return { recipes: next };
      });
    },
    clear: () => {
      set({ recipes: {} });
    },
  }));
}

export const pointcloudCleanup = createCleanupRecipes();
```

Append to `packages/pointcloud/src/index.ts`:

```ts
export {
  STATE,
  STATE_NAMES,
  applyRegions,
  cleanupUniformsOf,
  compileCleanup,
  evaluateAll,
  evaluatePoint,
  type CleanupState,
  type CompiledCleanup,
  type RegionHit,
} from './cleanup/evaluate';
export { boxInverseWorld, localToWorld, mul4, worldToLocal, type M4 } from './cleanup/frame';
export { pointInPolygon, ringOf, type Ring } from './cleanup/polygon';
export { createCleanupRecipes, pointcloudCleanup, type CleanupRecipes } from './cleanup/store';
```

- [ ] **Step 6: Run the tests**

Run: `pnpm exec vitest run packages/pointcloud/src/cleanup/evaluate.test.ts packages/pointcloud/src/cleanup/store.test.ts`
Expected: PASS (14 vector cases twice, frames, polygons, uniforms, store). A vector case that fails on one frame only is a matrix order bug in `frame.ts`, not a vector to change.

- [ ] **Step 7: Commit**

```bash
git add packages/pointcloud/src/cleanup/frame.ts packages/pointcloud/src/cleanup/polygon.ts packages/pointcloud/src/cleanup/evaluate.ts packages/pointcloud/src/cleanup/store.ts packages/pointcloud/src/cleanup/evaluate.test.ts packages/pointcloud/src/cleanup/store.test.ts packages/pointcloud/src/index.ts
git commit -m "feat(pointcloud): cleanup recipe evaluator and live recipe store"
```

---

### Task 4: Python evaluator, recipe checks and LAS streaming

**Packages touched:** `python/` (`aio_pipelines.pointcloud_cleanup`, tests).
**Contract change:** no (mirrors Task 1). **E2E:** none.

**Files:**

- Create: `python/src/aio_pipelines/pointcloud_cleanup/__init__.py`
- Create: `python/src/aio_pipelines/pointcloud_cleanup/recipe.py`
- Create: `python/src/aio_pipelines/pointcloud_cleanup/evaluate.py`
- Create: `python/src/aio_pipelines/pointcloud_cleanup/lasstream.py`
- Create: `python/tests/pccleanup_synth.py`
- Create: `python/tests/test_pccleanup_evaluate.py`
- Create: `python/tests/test_pccleanup_lasstream.py`

**Interfaces:**

- Consumes: `packages/schema/test-data/pccleanup-vectors.json` (Task 1); `aio_pipelines.runtime.JobError`; `aio_pipelines.change.las.write_las` (synthetic LAS 1.4, point format 6); `aio_pipelines.pointcloud.find_pdal`, `pdal_env`.
- Produces:
  - `recipe.py`: `SCHEMA = "aio.pccleanup/1"`, `MAX_REGIONS = 200`, `MAX_LASSO = 256`, `NOISE_CLASS = 7`, `validate_recipe(raw: Any, layer_id: str | None = None) -> dict[str, Any]` (raises `JobError`)
  - `evaluate.py`: `KEPT, HIDDEN, CLASS_HIDDEN, DELETED, DROPPED = 0, 1, 2, 3, 4`; `STATE_NAMES`; `in_polygon(ring: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray`; `evaluate(recipe: dict, xyz: np.ndarray, cls: np.ndarray) -> tuple[np.ndarray, np.ndarray]` (world xyz float64 (n, 3), classes uint8; returns state uint8, class uint8); `kept_for_save(state: np.ndarray) -> np.ndarray`
  - `lasstream.py`: `CHUNK = 2_000_000`; `LasHead` dataclass; `read_head(path: Path) -> LasHead`; `chunks(path: Path, head: LasHead, size: int = CHUNK) -> Iterator[np.ndarray]`; `xyz_of(head, rec) -> np.ndarray`; `classes_of(rec) -> np.ndarray`; `class_histogram(path: Path) -> np.ndarray` (256 counts); `filter_las(src: Path, dst: Path, rule: Callable[[np.ndarray, np.ndarray], tuple[np.ndarray, np.ndarray]], check: Callable[[], None] | None = None, progress: Callable[[float], None] | None = None, size: int = CHUNK) -> dict[str, int]` (`points_in`, `points_out`)
  - `pccleanup_synth.py`: `E0, N0`; `planted_cloud(ground_step=0.5, high=40, low=20, seed=7) -> tuple[np.ndarray, np.ndarray, np.ndarray]` (xyz, cls, outlier mask); `write_las14(path, xyz, cls) -> Path`; `to_copc(las: Path, copc: Path) -> Path` (PDAL); `copc_to_las(copc: Path, las: Path) -> Path` (PDAL, forward all); `cloud_project(tmp_path, xyz, cls, layer_id="cloud-a") -> Path` (a project with `clouds/<layer>.copc.laz` and its manifest)

- [ ] **Step 1: Write the failing tests**

Create `python/tests/test_pccleanup_evaluate.py`:

```python
"""The numpy cleanup evaluator against the shared vectors (packages/schema/test-data), the same
cases the TS evaluator checks (packages/pointcloud/src/cleanup/evaluate.test.ts)."""

import json
from pathlib import Path

import numpy as np
import pytest

from aio_pipelines.pointcloud_cleanup.evaluate import STATE_NAMES, evaluate, in_polygon, kept_for_save
from aio_pipelines.pointcloud_cleanup.recipe import validate_recipe
from aio_pipelines.runtime import JobError

VECTORS = Path(__file__).resolve().parents[2] / "packages" / "schema" / "test-data" / "pccleanup-vectors.json"
V = json.loads(VECTORS.read_text("utf-8"))
XYZ = np.array([p["xyz"] for p in V["points"]], dtype=np.float64)
CLS = np.array([p["cls"] for p in V["points"]], dtype=np.uint8)


@pytest.mark.parametrize("case", V["cases"], ids=[c["name"] for c in V["cases"]])
def test_vectors(case):
    state, cls = evaluate(validate_recipe(case["recipe"]), XYZ, CLS)
    assert [STATE_NAMES[s] for s in state] == case["expect"]["state"]
    assert cls.tolist() == case["expect"]["cls"]


def test_save_keeps_kept_and_hidden_only():
    state = np.array([0, 1, 2, 3, 4], dtype=np.uint8)
    assert kept_for_save(state).tolist() == [True, True, False, False, False]


def test_even_odd_rule():
    ring = np.array([[0, 0], [4, 4], [4, 0], [0, 4]], dtype=np.float64)
    inside = in_polygon(ring, np.array([1.0, 2.0]), np.array([2.0, 1.0]))
    assert inside.tolist() == [True, False]


def empty(**over):
    return {"schema": "aio.pccleanup/1", "layerId": "a", "hiddenClasses": [], "regions": [], **over}


def region(**over):
    return {
        "id": "r",
        "shape": "box",
        "viewProj": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        "polygon": [[-1, -1], [1, -1], [1, 1], [-1, 1]],
        "action": {"kind": "delete"},
        **over,
    }


@pytest.mark.parametrize(
    "raw, message",
    [
        ({**empty(), "schema": "aio.pccleanup/2"}, "aio.pccleanup/1"),
        (empty(regions=[region()] * 201), "200"),
        (empty(regions=[region(polygon=[[0, 0], [1, 0], [1, 1]])]), "4 corners"),
        (empty(regions=[region(shape="lasso", polygon=[[0, 0]] * 257)]), "256"),
        (empty(regions=[region(viewProj=[1] * 15)]), "16 numbers"),
        (empty(regions=[region(action={"kind": "paint"})]), "hide, delete or class"),
        (empty(hiddenClasses=[300]), "0 to 255"),
        (empty(height={"min": 5, "max": 1}), "lowest"),
        (empty(clipBox={"center": [0, 0, 0], "size": [0, 1, 1], "yaw": 0, "keep": "inside"}), "size"),
        (empty(noise={"path": "clouds/x.copc.laz", "params": {}, "marked": 0, "total": 0, "runId": "j"}), "edits/pointcloud"),
    ],
)
def test_validate_refuses(raw, message):
    with pytest.raises(JobError, match=message):
        validate_recipe(raw)


def test_validate_checks_the_layer():
    with pytest.raises(JobError, match="another layer"):
        validate_recipe(empty(), layer_id="b")
    assert validate_recipe(empty(), layer_id="a")["layerId"] == "a"
```

Create `python/tests/test_pccleanup_lasstream.py`:

```python
"""Streaming over a LAS 1.4 file: chunks, classes, and a filtered copy with a rewritten header."""

import struct

import numpy as np
import pytest

from aio_pipelines.change.las import read_las
from aio_pipelines.pointcloud_cleanup.lasstream import class_histogram, filter_las, read_head
from pccleanup_synth import planted_cloud, write_las14


def test_head_and_histogram(tmp_path):
    xyz, cls, _ = planted_cloud(ground_step=2.0, high=4, low=2)
    las = write_las14(tmp_path / "a.las", xyz, cls)
    head = read_head(las)
    assert head.count == len(xyz)
    assert head.pdrf == 6
    hist = class_histogram(las)
    assert hist[2] == int((cls == 2).sum())
    assert hist.sum() == len(xyz)


def test_filter_streams_in_chunks_and_rewrites_counts_and_bounds(tmp_path):
    xyz, cls, outlier = planted_cloud(ground_step=2.0, high=4, low=2)
    src = write_las14(tmp_path / "a.las", xyz, cls)

    def rule(p, c):
        keep = p[:, 2] < 20  # the high outliers go
        out = c.copy()
        out[p[:, 2] < -3] = 7  # the low ones become noise
        return keep, out

    # a chunk of 50 points: many chunks, and the result must not depend on them
    counts = filter_las(src, tmp_path / "b.las", rule, size=50)
    keep = xyz[:, 2] < 20
    assert counts == {"points_in": len(xyz), "points_out": int(keep.sum())}
    out = read_las(tmp_path / "b.las")
    assert out.count == int(keep.sum())
    np.testing.assert_allclose(out.xyz, xyz[keep], atol=1e-3)
    assert int((out.field("Classification") == 7).sum()) == int((xyz[keep][:, 2] < -3).sum())
    raw = (tmp_path / "b.las").read_bytes()
    max_x, min_x, max_y, min_y, max_z, min_z = struct.unpack_from("<6d", raw, 179)
    assert max_z < 20
    assert min_z == pytest.approx(xyz[keep][:, 2].min(), abs=1e-3)
    assert (max_x, min_x) == pytest.approx((xyz[keep][:, 0].max(), xyz[keep][:, 0].min()), abs=1e-3)
    assert (max_y, min_y) == pytest.approx((xyz[keep][:, 1].max(), xyz[keep][:, 1].min()), abs=1e-3)
    assert struct.unpack_from("<Q", raw, 247)[0] == int(keep.sum())


def test_filter_of_nothing_kept_writes_an_empty_cloud(tmp_path):
    xyz, cls, _ = planted_cloud(ground_step=4.0, high=0, low=0)
    src = write_las14(tmp_path / "a.las", xyz, cls)
    counts = filter_las(src, tmp_path / "b.las", lambda p, c: (np.zeros(len(p), bool), c))
    assert counts["points_out"] == 0
    assert read_head(tmp_path / "b.las").count == 0
```

- [ ] **Step 2: Run them to see them fail**

From `python/` of this worktree (PowerShell):

```powershell
$env:PYTHONPATH = 'src;tests'; $env:PYTHONDONTWRITEBYTECODE = '1'
& 'E:\Dev\AIO Software\python\.venv\Scripts\python.exe' -m pytest tests/test_pccleanup_evaluate.py tests/test_pccleanup_lasstream.py
```

Expected: FAIL (`ModuleNotFoundError: aio_pipelines.pointcloud_cleanup`).

- [ ] **Step 3: Write `recipe.py`**

`python/src/aio_pipelines/pointcloud_cleanup/__init__.py`:

```python
"""Point cloud cleanup (aio.pccleanup/1): the recipe checks, the numpy evaluator, LAS streaming and
the ``pointcloud.clean`` pipeline. Mirrors packages/schema/src/pointcloudCleanup.ts."""
```

`python/src/aio_pipelines/pointcloud_cleanup/recipe.py`:

```python
"""Checks of a cleanup recipe as it arrives in job params (the app validated it with zod first;
this keeps the pipeline safe on its own). Messages are sentences a person can act on."""

from __future__ import annotations

import math
from typing import Any

from ..runtime import JobError

SCHEMA = "aio.pccleanup/1"
MAX_REGIONS = 200
MAX_LASSO = 256
NOISE_CLASS = 7
NOISE_DIR = "edits/pointcloud/"


def _num(v: Any) -> bool:
    return isinstance(v, int | float) and not isinstance(v, bool) and math.isfinite(v)


def _vec(v: Any, n: int) -> bool:
    return isinstance(v, list) and len(v) == n and all(_num(x) for x in v)


def validate_recipe(raw: Any, layer_id: str | None = None) -> dict[str, Any]:
    if not isinstance(raw, dict) or raw.get("schema") != SCHEMA:
        raise JobError(f"The cleanup is not an {SCHEMA} recipe.")
    if layer_id is not None and raw.get("layerId") != layer_id:
        raise JobError("The cleanup belongs to another layer.")
    regions = raw.get("regions")
    if not isinstance(regions, list) or len(regions) > MAX_REGIONS:
        raise JobError(f"A cleanup holds at most {MAX_REGIONS} selections.")
    for r in regions:
        if not isinstance(r, dict) or r.get("shape") not in ("box", "lasso"):
            raise JobError("A selection is a box or a lasso.")
        if not _vec(r.get("viewProj"), 16):
            raise JobError("A selection's view matrix is 16 numbers.")
        poly = r.get("polygon")
        if not isinstance(poly, list) or not all(_vec(p, 2) for p in poly):
            raise JobError("A selection's outline is a list of points.")
        if r["shape"] == "box" and len(poly) != 4:
            raise JobError("A box selection has 4 corners.")
        if not 3 <= len(poly) <= MAX_LASSO:
            raise JobError(f"A lasso has 3 to {MAX_LASSO} points.")
        a = r.get("action")
        kind = a.get("kind") if isinstance(a, dict) else None
        if kind not in ("hide", "delete", "class"):
            raise JobError("A selection hides, deletes or sets a class: hide, delete or class.")
        if kind == "class" and not (isinstance(a.get("value"), int) and 0 <= a["value"] <= 255):
            raise JobError("A class is a number from 0 to 255.")
    hidden = raw.get("hiddenClasses")
    if not isinstance(hidden, list) or not all(isinstance(c, int) and 0 <= c <= 255 for c in hidden):
        raise JobError("Hidden classes are numbers from 0 to 255.")
    h = raw.get("height")
    if h is not None:
        lo, hi = (h or {}).get("min"), (h or {}).get("max")
        if any(v is not None and not _num(v) for v in (lo, hi)):
            raise JobError("A height is a number.")
        if lo is not None and hi is not None and lo > hi:
            raise JobError("The lowest height is above the highest.")
    box = raw.get("clipBox")
    if box is not None:
        if not (_vec(box.get("center"), 3) and _vec(box.get("size"), 3) and _num(box.get("yaw"))):
            raise JobError("A clip box has a centre, a size and a turn.")
        if any(s <= 0 for s in box["size"]):
            raise JobError("A clip box size is above 0 m.")
        if box.get("keep") not in ("inside", "outside"):
            raise JobError("A clip box keeps what is inside or outside.")
    noise = raw.get("noise")
    if noise is not None:
        path = noise.get("path") if isinstance(noise, dict) else None
        if not (isinstance(path, str) and path.startswith(NOISE_DIR) and path.endswith(".copc.laz") and ".." not in path):
            raise JobError("A noise working copy lives in edits/pointcloud.")
    return raw
```

- [ ] **Step 4: Write `evaluate.py`**

```python
"""The cleanup recipe over many points, in world coordinates (project CRS), with numpy. The same
rules as the viewer (packages/pointcloud/src/cleanup/evaluate.ts), pinned by the shared vectors.

Per point, in order: the regions (``w > 0`` and inside the NDC polygon: ``class`` sets the class,
later regions win; ``hide`` hides; ``delete`` deletes); outside the clip box (inside, for
``keep: outside``) or outside the height range: dropped; a hidden class: class-hidden. One outcome,
the highest code: dropped > deleted > class-hidden > hidden > kept.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

KEPT, HIDDEN, CLASS_HIDDEN, DELETED, DROPPED = 0, 1, 2, 3, 4
STATE_NAMES = ("kept", "hidden", "classHidden", "deleted", "dropped")


def in_polygon(ring: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Even-odd rule, edge by edge over all points (the TS loop pairs each vertex with the one before)."""
    inside = np.zeros(x.shape, dtype=bool)
    xj, yj = ring[-1]
    for xi, yi in ring:
        crosses = (yi > y) != (yj > y)
        with np.errstate(divide="ignore", invalid="ignore"):
            at = (xj - xi) * (y - yi) / (yj - yi) + xi
        inside ^= crosses & (x < at)
        xj, yj = xi, yi
    return inside


def _in_box(box: dict[str, Any], xyz: np.ndarray) -> np.ndarray:
    c, s = math.cos(box["yaw"]), math.sin(box["yaw"])
    d = xyz - np.asarray(box["center"], dtype=np.float64)
    sx, sy, sz = box["size"]
    u = (c * d[:, 0] + s * d[:, 1]) / sx
    v = (-s * d[:, 0] + c * d[:, 1]) / sy
    w = d[:, 2] / sz
    return (np.abs(u) <= 0.5) & (np.abs(v) <= 0.5) & (np.abs(w) <= 0.5)


def evaluate(recipe: dict[str, Any], xyz: np.ndarray, cls: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """State (uint8) and class after the regions (uint8) of each point."""
    xyz = np.asarray(xyz, dtype=np.float64)
    n = len(xyz)
    out = np.asarray(cls, dtype=np.uint8).copy()
    hide = np.zeros(n, dtype=bool)
    dele = np.zeros(n, dtype=bool)
    if n and recipe.get("regions"):
        h = np.concatenate([xyz, np.ones((n, 1))], axis=1)
        for r in recipe["regions"]:
            m = np.asarray(r["viewProj"], dtype=np.float64).reshape(4, 4).T  # column-major
            clip = h @ m.T
            w = clip[:, 3]
            front = w > 0
            sel = np.zeros(n, dtype=bool)
            if front.any():
                nx = clip[front, 0] / w[front]
                ny = clip[front, 1] / w[front]
                sel[front] = in_polygon(np.asarray(r["polygon"], dtype=np.float64), nx, ny)
            a = r["action"]
            if a["kind"] == "class":
                out[sel] = a["value"]
            elif a["kind"] == "hide":
                hide |= sel
            else:
                dele |= sel
    drop = np.zeros(n, dtype=bool)
    height = recipe.get("height") or {}
    if height.get("min") is not None:
        drop |= xyz[:, 2] < height["min"]
    if height.get("max") is not None:
        drop |= xyz[:, 2] > height["max"]
    box = recipe.get("clipBox")
    if box:
        inside = _in_box(box, xyz)
        drop |= ~inside if box["keep"] == "inside" else inside
    hidden = np.zeros(256, dtype=bool)
    hidden[np.asarray(recipe.get("hiddenClasses") or [], dtype=np.int64)] = True
    state = np.zeros(n, dtype=np.uint8)
    state[hide] = HIDDEN
    state[hidden[out]] = CLASS_HIDDEN
    state[dele] = DELETED
    state[drop] = DROPPED
    return state, out


def kept_for_save(state: np.ndarray) -> np.ndarray:
    """Points a save or an export writes: kept, and hidden by a hide selection (view only)."""
    return state <= HIDDEN
```

- [ ] **Step 5: Write `lasstream.py`**

```python
"""Point records of a LAS 1.4 file (point formats 6, 7 and 8, as PDAL's writers.las writes a COPC
out), read in chunks through a memory map so a 20 M point cloud never sits in memory whole, and a
filtered copy whose header counts and bounds are rewritten."""

from __future__ import annotations

import shutil
import struct
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from ..runtime import JobError

CHUNK = 2_000_000
CLASS_BYTE = 16
RETURN_BYTE = 14
FORMATS = frozenset({6, 7, 8})

Rule = Callable[[np.ndarray, np.ndarray], tuple[np.ndarray, np.ndarray]]


@dataclass(frozen=True)
class LasHead:
    minor: int
    point_offset: int
    pdrf: int
    record_length: int
    count: int
    legacy_count: int
    scale: tuple[float, float, float]
    offset: tuple[float, float, float]
    evlr_start: int
    evlr_count: int


def read_head(path: Path) -> LasHead:
    with open(path, "rb") as f:
        b = f.read(375)
    if len(b) < 227 or b[:4] != b"LASF":
        raise JobError(f"{Path(path).name} is not a LAS file.")
    minor = b[25]
    pdrf = b[104] & 0x3F
    if pdrf not in FORMATS:
        raise JobError(f"Point format {pdrf} is not supported here (expected 6, 7 or 8).")
    legacy = struct.unpack_from("<I", b, 107)[0]
    wide = minor >= 4 and len(b) >= 255
    count = struct.unpack_from("<Q", b, 247)[0] if wide else 0
    evlr_start, evlr_count = struct.unpack_from("<QI", b, 235) if wide else (0, 0)
    return LasHead(
        minor=minor,
        point_offset=struct.unpack_from("<I", b, 96)[0],
        pdrf=pdrf,
        record_length=struct.unpack_from("<H", b, 105)[0],
        count=count or legacy,
        legacy_count=legacy,
        scale=struct.unpack_from("<3d", b, 131),
        offset=struct.unpack_from("<3d", b, 155),
        evlr_start=evlr_start,
        evlr_count=evlr_count,
    )


def chunks(path: Path, head: LasHead, size: int = CHUNK) -> Iterator[np.ndarray]:
    if head.count == 0:
        return
    mm = np.memmap(path, dtype=np.uint8, mode="r", offset=head.point_offset, shape=(head.count, head.record_length))
    try:
        for start in range(0, head.count, size):
            yield mm[start : start + size]
    finally:
        del mm  # Windows keeps the file locked while the map lives


def xyz_of(head: LasHead, rec: np.ndarray) -> np.ndarray:
    q = np.ascontiguousarray(rec[:, :12]).view("<i4").reshape(-1, 3)
    return q * np.asarray(head.scale) + np.asarray(head.offset)


def classes_of(rec: np.ndarray) -> np.ndarray:
    return np.array(rec[:, CLASS_BYTE], dtype=np.uint8)


def class_histogram(path: Path) -> np.ndarray:
    head = read_head(path)
    hist = np.zeros(256, dtype=np.int64)
    for rec in chunks(path, head):
        hist += np.bincount(rec[:, CLASS_BYTE], minlength=256)
    return hist


def filter_las(
    src: Path,
    dst: Path,
    rule: Rule,
    check: Callable[[], None] | None = None,
    progress: Callable[[float], None] | None = None,
    size: int = CHUNK,
) -> dict[str, int]:
    """Copy ``src`` to ``dst`` with the points ``rule(xyz, cls) -> (keep, new_cls)`` keeps, written
    with their new class. Header, VLRs and EVLRs are copied; counts, counts by return and bounds
    are rewritten."""
    head = read_head(src)
    with open(src, "rb") as f:
        header = f.read(head.point_offset)
    lo = np.full(3, np.inf)
    hi = np.full(3, -np.inf)
    kept = 0
    by_return = np.zeros(15, dtype=np.int64)
    done = 0
    with open(dst, "wb") as out:
        out.write(header)
        for rec in chunks(src, head, size):
            if check:
                check()
            xyz = xyz_of(head, rec)
            keep, cls = rule(xyz, classes_of(rec))
            if keep.any():
                part = np.array(rec[keep])
                part[:, CLASS_BYTE] = cls[keep]
                out.write(part.tobytes())
                k = xyz[keep]
                lo = np.minimum(lo, k.min(axis=0))
                hi = np.maximum(hi, k.max(axis=0))
                kept += len(part)
                rn = np.clip(part[:, RETURN_BYTE] & 0x0F, 1, 15).astype(np.int64) - 1
                by_return += np.bincount(rn, minlength=15)[:15]
            done += len(rec)
            if progress:
                progress(done / max(head.count, 1))
        evlr_at = 0
        if head.evlr_count:
            evlr_at = out.tell()
            with open(src, "rb") as f:
                f.seek(head.evlr_start)
                shutil.copyfileobj(f, out)
    if not kept:
        lo = hi = np.zeros(3)
    legacy = head.legacy_count != 0 and kept < 2**32
    with open(dst, "r+b") as f:
        f.seek(107)
        f.write(struct.pack("<I", kept if legacy else 0))
        f.write(struct.pack("<5I", *(int(v) if legacy else 0 for v in by_return[:5])))
        f.seek(179)
        f.write(struct.pack("<6d", hi[0], lo[0], hi[1], lo[1], hi[2], lo[2]))
        if head.minor >= 4:
            if head.evlr_count:
                f.seek(235)
                f.write(struct.pack("<Q", evlr_at))
            f.seek(247)
            f.write(struct.pack("<Q", kept))
            f.write(struct.pack("<15Q", *(int(v) for v in by_return)))
    return {"points_in": head.count, "points_out": kept}
```

- [ ] **Step 6: Write the synthetic helper**

`python/tests/pccleanup_synth.py`:

```python
"""Synthetic clouds for the cleanup tests: a ground grid (class 2) with a building block (class 6)
around E 500000, N 3200000, and planted outliers (class 1): isolated high points 25 to 40 m up and
low points 6 to 8 m under the ground. Deterministic, no client data."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import numpy as np

from aio_pipelines.change.las import write_las
from aio_pipelines.pointcloud import find_pdal, pdal_env

E0, N0 = 500000.0, 3200000.0
EPSG = 32639


def planted_cloud(ground_step: float = 0.5, high: int = 40, low: int = 20, seed: int = 7):
    rng = np.random.default_rng(seed)
    g = np.arange(0.25, 40, ground_step)
    gx, gy = np.meshgrid(g, g)
    ground = np.c_[gx.ravel(), gy.ravel(), 0.02 * np.sin(gx.ravel())]
    bx, by = np.meshgrid(np.arange(15.25, 25, ground_step), np.arange(15.25, 25, ground_step))
    roof = np.c_[bx.ravel(), by.ravel(), np.full(bx.size, 10.0)]
    hi = np.c_[rng.uniform(2, 38, high), rng.uniform(2, 38, high), rng.uniform(25, 40, high)]
    lo = np.c_[rng.uniform(2, 38, low), rng.uniform(2, 38, low), rng.uniform(-8, -6, low)]
    xyz = np.vstack([ground, roof, hi, lo]) + [E0, N0, 0.0]
    cls = np.concatenate(
        [np.full(len(ground), 2), np.full(len(roof), 6), np.full(high + low, 1)]
    ).astype(np.uint8)
    outlier = np.r_[np.zeros(len(ground) + len(roof), bool), np.ones(high + low, bool)]
    return np.round(xyz, 3), cls, outlier


def write_las14(path: Path, xyz: np.ndarray, cls: np.ndarray) -> Path:
    write_las(Path(path), xyz, pdrf=6, classification=cls)
    return Path(path)


def _pdal(stages: list, where: Path) -> None:
    pdal = find_pdal()
    assert pdal, "PDAL not found (set AIO_PDAL)"
    pipe = where.with_suffix(".pipeline.json")
    pipe.write_text(json.dumps({"pipeline": stages}))
    subprocess.run([pdal, "pipeline", str(pipe)], check=True, capture_output=True, env=pdal_env(pdal))
    pipe.unlink()


def to_copc(las: Path, copc: Path) -> Path:
    _pdal(
        [
            {"type": "readers.las", "filename": str(las), "override_srs": f"EPSG:{EPSG}"},
            {"type": "writers.copc", "filename": str(copc), "scale_x": 0.001, "scale_y": 0.001, "scale_z": 0.001,
             "offset_x": "auto", "offset_y": "auto", "offset_z": "auto"},
        ],
        copc,
    )  # fmt: skip
    return copc


def copc_to_las(copc: Path, las: Path) -> Path:
    _pdal(
        [
            {"type": "readers.copc", "filename": str(copc)},
            {"type": "writers.las", "filename": str(las), "minor_version": 4, "forward": "all", "extra_dims": "all"},
        ],
        las,
    )  # fmt: skip
    return las


def cloud_project(tmp_path: Path, xyz: np.ndarray, cls: np.ndarray, layer_id: str = "cloud-a") -> Path:
    root = tmp_path / "proj"
    (root / "clouds").mkdir(parents=True)
    las = write_las14(tmp_path / f"{layer_id}.las", xyz, cls)
    to_copc(las, root / "clouds" / f"{layer_id}.copc.laz")
    manifest = {
        "schema": "aio.project/1",
        "id": "p",
        "name": "Cleanup test",
        "crs": {"epsg": EPSG},
        "origin": [E0, N0, 0.0],
        "captures": [{"id": "d1", "label": "Day one", "date": "2026-10-01"}],
        "layers": [
            {"kind": "pointcloud", "id": layer_id, "name": "Scan", "visible": True, "capture": "d1",
             "src": {"path": f"clouds/{layer_id}.copc.laz"}, "format": "copc", "pointCount": len(xyz)},
        ],
    }  # fmt: skip
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2), "utf-8")
    return root
```

`write_las` (`change/las.py:217`) takes keyword-only `pdrf=` and `classification=` and writes LAS 1.4 with "return 1 of 1" on every point and no SRS record; `to_copc` sets the CRS with `override_srs`.

- [ ] **Step 7: Run the tests**

Same command as Step 2. Expected: PASS (14 vector cases, the refusals, the streaming tests). Then check the shared venv was not touched:

```powershell
& 'E:\Dev\AIO Software\python\.venv\Scripts\python.exe' -c "import aio_pipelines; print(aio_pipelines.__file__)"
```

Expected (without `PYTHONPATH`): `E:\Dev\AIO Software\python\src\aio_pipelines\__init__.py`. Then `& 'E:\Dev\AIO Software\python\.venv\Scripts\python.exe' -m ruff check src/aio_pipelines/pointcloud_cleanup tests/pccleanup_synth.py tests/test_pccleanup_evaluate.py tests/test_pccleanup_lasstream.py` and `-m ruff format --check` on the same paths.

- [ ] **Step 8: Commit**

```bash
git add python/src/aio_pipelines/pointcloud_cleanup/__init__.py python/src/aio_pipelines/pointcloud_cleanup/recipe.py python/src/aio_pipelines/pointcloud_cleanup/evaluate.py python/src/aio_pipelines/pointcloud_cleanup/lasstream.py python/tests/pccleanup_synth.py python/tests/test_pccleanup_evaluate.py python/tests/test_pccleanup_lasstream.py
git commit -m "feat(pipelines): cleanup recipe evaluator and chunked LAS filtering"
```

---

### Task 5: Material uniforms, `drawnPoints` and `countDrawn`

**Packages touched:** `@aio/pointcloud`.
**Contract change:** no. **E2E:** none.

**Files:**

- Modify: `packages/pointcloud/src/material.ts` (vertex shader lines 39-94, `PointMaterialOptions` ~line 155, `PointMaterial` ~line 168, `createPointMaterial` ~line 236; new exports at the end)
- Modify: `packages/pointcloud/src/material.test.ts` (new `describe` at the end)
- Modify: `packages/pointcloud/src/pick.ts:29-56` (`drawnPoints`)
- Create: `packages/pointcloud/src/cleanup/count.ts`
- Create: `packages/pointcloud/src/cleanup/drawn.test.ts`
- Modify: `packages/pointcloud/src/index.ts` (exports)

**Interfaces:**

- Produces:
  - `PointMaterialOptions.hasMask?: boolean` (defines `HAS_MASK`, reads `attribute float aMask`; COPC layers only, Task 6)
  - `PointMaterial.uniforms` gains `uBoxInv: { value: Matrix4 }`, `uBoxOn`, `uBoxKeepInside`, `uZMin`, `uZMax` (`{ value: number }`)
  - `interface CleanupUniforms { boxInv: readonly number[] | null; keepInside: boolean; zMin: number; zMax: number }` (local frame; `boxInv` column-major local to unit box)
  - `NO_CLEANUP: CleanupUniforms` (`{ boxInv: null, keepInside: true, zMin: -1e30, zMax: 1e30 }`)
  - `applyCleanupUniforms(m: PointMaterial, c: CleanupUniforms): void`
  - `drawnPoints(obj)` also rejects masked points, points outside `[uZMin, uZMax]` (local y) and points on the wrong side of the clip box
  - `countDrawn(handle: SceneHandle, layerId?: string, inside?: (x: number, y: number, z: number) => boolean): { drawn: number; loaded: number }` (local-frame coordinates; loaded chunks of visible layers; also honours the shared section planes)

- [ ] **Step 1: Write the failing tests**

Append to `packages/pointcloud/src/material.test.ts`:

```ts
describe('cleanup uniforms', () => {
  it('read the mask only when asked and start with nothing clipped', () => {
    const base = { hasRgb: false, hasIntensity: true, hasClass: true, baseSize: 1, tint: '#000' };
    expect(createPointMaterial(base).defines).not.toHaveProperty('HAS_MASK');
    const m = createPointMaterial({ ...base, hasMask: true });
    expect(m.defines).toHaveProperty('HAS_MASK', '');
    expect(m.vertexShader).toContain('attribute float aMask');
    expect(m.vertexShader).toContain('uBoxInv * world');
    expect(m.uniforms.uBoxOn.value).toBe(0);
    expect(m.uniforms.uZMin.value).toBe(-1e30);
    expect(m.uniforms.uZMax.value).toBe(1e30);
  });

  it('applies a box and a height range, and clears them', () => {
    const m = createPointMaterial({ hasRgb: false, hasIntensity: true, baseSize: 1, tint: '#000' });
    const inv = [0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1];
    applyCleanupUniforms(m, { boxInv: inv, keepInside: false, zMin: 1, zMax: 9 });
    expect(m.uniforms.uBoxOn.value).toBe(1);
    expect(m.uniforms.uBoxKeepInside.value).toBe(0);
    expect(m.uniforms.uBoxInv.value.elements[0]).toBe(0.5);
    expect([m.uniforms.uZMin.value, m.uniforms.uZMax.value]).toEqual([1, 9]);
    applyCleanupUniforms(m, NO_CLEANUP);
    expect(m.uniforms.uBoxOn.value).toBe(0);
    expect(m.uniforms.uZMin.value).toBe(-1e30);
  });
});
```

(add `applyCleanupUniforms`, `NO_CLEANUP` to the file's import from `./material`.)

Create `packages/pointcloud/src/cleanup/drawn.test.ts`:

```ts
import type { SceneHandle } from '@aio/engine';
import {
  BufferAttribute,
  BufferGeometry,
  PerspectiveCamera,
  Points,
  Scene,
  type Vector2,
} from 'three';
import { describe, expect, it } from 'vitest';
import { createPointcloudAdapter, getCloudManager } from '../adapter';
import { applyCleanupUniforms, createPointMaterial, NO_CLEANUP } from '../material';
import { drawnPoints } from '../pick';
import type { Decoder } from '../pool';
import { createPointcloudSettings } from '../settings';
import { countDrawn } from './count';

/** Four points along x at 0, 1, 2 and 3 m, heights 0, 1, 2 and 3 m. */
function points(mask?: number[]) {
  const geo = new BufferGeometry();
  geo.setAttribute(
    'position',
    new BufferAttribute(new Float32Array([0, 0, 0, 1, 1, 0, 2, 2, 0, 3, 3, 0]), 3),
  );
  geo.setAttribute('aClass', new BufferAttribute(new Uint8Array([2, 2, 6, 2]), 1));
  if (mask) geo.setAttribute('aMask', new BufferAttribute(new Uint8Array(mask), 1));
  const m = createPointMaterial({
    hasRgb: false,
    hasIntensity: false,
    hasClass: true,
    hasMask: mask !== undefined,
    baseSize: 1,
    tint: '#000',
  });
  return { obj: new Points(geo, m), m };
}
const drawnOf = (obj: Points) => {
  const d = drawnPoints(obj);
  if (d === false) return [];
  return [0, 1, 2, 3].filter((i) => d === undefined || d(i));
};

describe('drawnPoints and the cleanup', () => {
  it('draws every point without a cleanup', () => {
    expect(drawnPoints(points().obj)).toBeUndefined();
  });

  it('skips masked points', () => {
    expect(drawnOf(points([0, 1, 0, 0]).obj)).toEqual([0, 2, 3]);
  });

  it('skips points outside the height range (local y)', () => {
    const { obj, m } = points();
    applyCleanupUniforms(m, { ...NO_CLEANUP, zMin: 0.5, zMax: 2.5 });
    expect(drawnOf(obj)).toEqual([1, 2]);
  });

  it('keeps the inside or the outside of the clip box', () => {
    const { obj, m } = points();
    // unit box scaled to 2 m around x = 1: inside for 0 <= x <= 2 (|u| <= 0.5)
    const inv = [0.5, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 0.1, 0, -0.5, 0, 0, 1];
    applyCleanupUniforms(m, { boxInv: inv, keepInside: true, zMin: -1e30, zMax: 1e30 });
    expect(drawnOf(obj)).toEqual([0, 1, 2]);
    applyCleanupUniforms(m, { boxInv: inv, keepInside: false, zMin: -1e30, zMax: 1e30 });
    expect(drawnOf(obj)).toEqual([3]);
  });
});

describe('countDrawn', () => {
  it('counts the loaded points the materials draw, also inside a test region', async () => {
    const frames = new Set<() => void>();
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.set(0, 0, 10);
    camera.updateMatrixWorld();
    const handle = {
      scene: new Scene(),
      camera,
      renderer: {
        getPixelRatio: () => 1,
        getDrawingBufferSize: (v: Vector2) => v.set(500, 500),
        domElement: { clientWidth: 500, clientHeight: 500 },
      },
      projectId: 'p',
      clippingPlanes: [],
      addRaycastProvider: () => () => undefined,
      addContentBounds: () => () => undefined,
      requestRender: () => undefined,
      onFrame: (cb: () => void) => {
        frames.add(cb);
        return () => frames.delete(cb);
      },
    } as unknown as SceneHandle;
    // kit raw units are millimetres: (0, 0, 0), (0, 0, 2) and (3, 0, 0) m
    const decoder: Decoder = {
      decode: () =>
        Promise.resolve({
          id: 0,
          count: 3,
          position: new Int16Array([0, 0, 0, 0, 0, 2000, 3000, 0, 0]),
          intensity: new Uint8Array(3),
          bounds: { min: [0, 0, 0], max: [3, 0, 2] },
        }),
      dispose: () => undefined,
    };
    const adapter = createPointcloudAdapter({
      decoder: () => decoder,
      settings: createPointcloudSettings(null),
    });
    await adapter.create(
      {
        kind: 'pointcloud',
        id: 'k',
        name: 'k',
        visible: true,
        src: { path: 'a.bin' },
        format: 'kit-packed',
      },
      { scene: handle, url: () => 'x' },
    );
    for (const f of frames) f();
    await new Promise((r) => setTimeout(r, 0));
    for (const f of frames) f();
    expect(countDrawn(handle)).toEqual({ drawn: 3, loaded: 3 });
    expect(countDrawn(handle, 'k', (x) => x > 1)).toEqual({ drawn: 1, loaded: 3 });
    expect(countDrawn(handle, 'other')).toEqual({ drawn: 0, loaded: 0 });
    const m = getCloudManager(handle)?.layers.get('k')?.material;
    if (!m) throw new Error('no material');
    // keep x <= 1.5 only (a 3 m box around the origin)
    applyCleanupUniforms(m, {
      boxInv: [1 / 3, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 1],
      keepInside: true,
      zMin: -1e30,
      zMax: 1e30,
    });
    expect(countDrawn(handle, 'k').drawn).toBe(2);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run packages/pointcloud/src/material.test.ts packages/pointcloud/src/cleanup/drawn.test.ts`
Expected: FAIL (`applyCleanupUniforms` is not exported; `./count` missing).

- [ ] **Step 3: Extend the material**

In `material.ts` import `Matrix4` from three. In the vertex shader, after `uniform float uHideNoScalar;`:

```glsl
#ifdef HAS_MASK
attribute float aMask;
#endif
uniform mat4 uBoxInv;
uniform float uBoxOn;
uniform float uBoxKeepInside;
uniform float uZMin;
uniform float uZMax;
```

In `main()`, after the hidden-class `if` block and before `bool changeMode`, and remove the later `vec4 world = modelMatrix * vec4(position, 1.0);` line (keep `vec4 mvPosition = viewMatrix * world;`):

```glsl
#ifdef HAS_MASK
  if (aMask > 0.5) {
    // hidden or deleted by a cleanup selection
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }
#endif
  vec4 world = modelMatrix * vec4(position, 1.0);
  // cleanup height range and clip box, in the local frame (independent of the section planes)
  bool cut = world.y < uZMin || world.y > uZMax;
  if (!cut && uBoxOn > 0.5) {
    vec3 b = (uBoxInv * world).xyz;
    bool inside = abs(b.x) <= 0.5 && abs(b.y) <= 0.5 && abs(b.z) <= 0.5;
    cut = inside != (uBoxKeepInside > 0.5);
  }
  if (cut) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }
```

`PointMaterialOptions`: `/** A per-point cleanup mask (`aMask`, 1 = not drawn); COPC layers. */ hasMask?: boolean;`. In `createPointMaterial`: `if (o.hasMask) defines.HAS_MASK = '';` and the uniforms:

```ts
      uBoxInv: { value: new Matrix4() },
      uBoxOn: { value: 0 },
      uBoxKeepInside: { value: 1 },
      uZMin: { value: -1e30 },
      uZMax: { value: 1e30 },
```

`PointMaterial['uniforms']` gains:

```ts
/** Cleanup clip box: local frame to the unit box (|x|, |y|, |z| <= 0.5 is inside). */
uBoxInv: {
  value: Matrix4;
}
uBoxOn: {
  value: number;
}
uBoxKeepInside: {
  value: number;
}
/** Cleanup height range, local y. */
uZMin: {
  value: number;
}
uZMax: {
  value: number;
}
```

At the end of the file:

```ts
/** The cleanup's share of a layer's material (local frame); see cleanup/evaluate.ts `cleanupUniformsOf`. */
export interface CleanupUniforms {
  boxInv: readonly number[] | null;
  keepInside: boolean;
  zMin: number;
  zMax: number;
}

export const NO_CLEANUP: CleanupUniforms = {
  boxInv: null,
  keepInside: true,
  zMin: -1e30,
  zMax: 1e30,
};

/** Sets the clip box and height range; the depth materials share these uniform objects. */
export function applyCleanupUniforms(m: PointMaterial, c: CleanupUniforms): void {
  m.uniforms.uBoxOn.value = c.boxInv ? 1 : 0;
  if (c.boxInv) m.uniforms.uBoxInv.value.fromArray(c.boxInv);
  m.uniforms.uBoxKeepInside.value = c.keepInside ? 1 : 0;
  m.uniforms.uZMin.value = c.zMin;
  m.uniforms.uZMax.value = c.zMax;
}
```

- [ ] **Step 4: Extend `drawnPoints`**

Replace the body of `drawnPoints` in `pick.ts` from `const shown = u.uClassShown.value;` on:

```ts
const shown = u.uClassShown.value;
const change = u.uMode.value === MODE_INDEX.change;
if (change && !hasScalar && u.uHideNoScalar.value > 0.5) return false;
// without the class field every point is unclassified (1)
if (!hasClass && (shown[1] ?? 1) < 0.5) return false;
const byClass = hasClass && shown.some((v) => v < 0.5);
const threshold = change && hasScalar ? u.uThreshold.value : 0;
// cleanup (material.ts): the mask, the height range and the clip box, as the shader decides
const mask =
  'HAS_MASK' in defines
    ? (obj.geometry.getAttribute('aMask') as BufferAttribute | undefined)
    : undefined;
const zMin = u.uZMin?.value ?? -1e30;
const zMax = u.uZMax?.value ?? 1e30;
const boxOn = (u.uBoxOn?.value ?? 0) > 0.5;
const keepInside = (u.uBoxKeepInside?.value ?? 1) > 0.5;
const bounded = zMin > -1e29 || zMax < 1e29 || boxOn;
if (!byClass && threshold <= 0 && !mask && !bounded) return undefined;
obj.updateMatrixWorld();
const e = obj.matrixWorld.elements;
const b = u.uBoxInv?.value.elements ?? [];
const pos = obj.geometry.getAttribute('position');
const at = (k: number) => e[k] ?? 0;
const bt = (k: number) => b[k] ?? 0;
return (i) => {
  if (byClass) {
    const c = Math.round(Math.min(cls?.getX(i) ?? 0, CLASS_SLOTS - 1));
    if ((shown[c] ?? 1) < 0.5) return false;
  }
  if (mask && mask.getX(i) > 0.5) return false;
  if (bounded) {
    const px = pos.getX(i);
    const py = pos.getY(i);
    const pz = pos.getZ(i);
    const wy = at(1) * px + at(5) * py + at(9) * pz + at(13);
    if (wy < zMin || wy > zMax) return false;
    if (boxOn) {
      const wx = at(0) * px + at(4) * py + at(8) * pz + at(12);
      const wz = at(2) * px + at(6) * py + at(10) * pz + at(14);
      const inside =
        Math.abs(bt(0) * wx + bt(4) * wy + bt(8) * wz + bt(12)) <= 0.5 &&
        Math.abs(bt(1) * wx + bt(5) * wy + bt(9) * wz + bt(13)) <= 0.5 &&
        Math.abs(bt(2) * wx + bt(6) * wy + bt(10) * wz + bt(14)) <= 0.5;
      if (inside !== keepInside) return false;
    }
  }
  return threshold <= 0 || Math.abs(scalar?.getX(i) ?? 0) >= threshold;
};
```

Update the doc comment above it: "... not those of a hidden class, not those a cleanup mask, height range or clip box removes and, coloured by change, ...". The `u` type there is `Partial<PointMaterial['uniforms']>`, so the new uniforms are optional reads already.

- [ ] **Step 5: Write `countDrawn`**

`packages/pointcloud/src/cleanup/count.ts`:

```ts
/**
 * Loaded points the materials draw (the Clean up panel's "N loaded points selected", the e2e
 * checks): every loaded chunk of the visible layers, or of one layer, through `drawnPoints`, the
 * shared section planes and an optional test in the local frame.
 */
import type { SceneHandle } from '@aio/engine';
import { Vector3, type Plane } from 'three';
import { getCloudManager } from '../adapter';
import { drawnPoints } from '../pick';

const p = new Vector3();

export function countDrawn(
  handle: SceneHandle,
  layerId?: string,
  inside?: (x: number, y: number, z: number) => boolean,
): { drawn: number; loaded: number } {
  const manager = getCloudManager(handle);
  let drawn = 0;
  let loaded = 0;
  if (!manager) return { drawn, loaded };
  const planes: readonly Plane[] = handle.clippingPlanes;
  for (const layer of manager.layers.values()) {
    if (!layer.visible || (layerId !== undefined && layer.id !== layerId)) continue;
    for (const c of layer.loaded) {
      const obj = c.object;
      if (!obj) continue;
      const pos = obj.geometry.getAttribute('position');
      loaded += pos.count;
      const d = drawnPoints(obj);
      if (d === false) continue;
      obj.updateMatrixWorld();
      for (let i = 0; i < pos.count; i++) {
        if (d && !d(i)) continue;
        if (planes.length || inside) {
          p.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(obj.matrixWorld);
          if (!planes.every((pl) => pl.distanceToPoint(p) >= 0)) continue;
          if (inside && !inside(p.x, p.y, p.z)) continue;
        }
        drawn++;
      }
    }
  }
  return { drawn, loaded };
}
```

Append to `packages/pointcloud/src/index.ts`:

```ts
export {
  NO_CLEANUP,
  applyCleanupUniforms,
  createPointMaterial,
  type CleanupUniforms,
  type PointMaterial,
} from './material';
export { drawnPoints } from './pick';
export { countDrawn } from './cleanup/count';
```

(If `index.ts` already re-exports some of these names from `./material`, merge them into that line.)

- [ ] **Step 6: Run the tests**

Run: `pnpm exec vitest run packages/pointcloud/src/material.test.ts packages/pointcloud/src/cleanup/drawn.test.ts packages/pointcloud/src/pick.test.ts`
Expected: PASS, the existing pick tests unchanged.

- [ ] **Step 7: Commit**

```bash
git add packages/pointcloud/src/material.ts packages/pointcloud/src/material.test.ts packages/pointcloud/src/pick.ts packages/pointcloud/src/cleanup/count.ts packages/pointcloud/src/cleanup/drawn.test.ts packages/pointcloud/src/index.ts
git commit -m "feat(pointcloud): clip box, height range and mask in the point material"
```

---

### Task 6: CloudManager and adapter: masks, per-layer classes, the noise stream

**Packages touched:** `@aio/pointcloud`.
**Contract change:** no. **E2E:** through Task 17.

**Files:**

- Create: `packages/pointcloud/src/cleanup/chunk.ts`
- Create: `packages/pointcloud/src/cleanup/chunk.test.ts`
- Create: `packages/pointcloud/src/cleanup/manager.test.ts`
- Modify: `packages/pointcloud/src/manager.ts` (`ChunkState` line 61, `CloudLayerState` line 86, constructor line 159, `addLayer` line 223, `attach` line 625, new private methods)
- Modify: `packages/pointcloud/src/adapter.ts` (options line 17, `managerFor` line 92, the COPC branch line 151, the returned handle line 199; two exported helpers)
- Modify: `packages/pointcloud/src/protocol.ts` (`WorkerRequest`, `WorkerResult`, `handleRequest`)
- Modify: `packages/pointcloud/src/pool.ts` (`Decoder.mask`, `createWorkerPool`)
- Modify: `packages/pointcloud/src/index.ts` (exports)

**Interfaces:**

- Consumes: Task 3 (`compileCleanup`, `applyRegions`, `cleanupUniformsOf`, `pointcloudCleanup`, `CleanupRecipes`); Task 5 (`hasMask`, `applyCleanupUniforms`).
- Produces:
  - `chunk.ts`: `WORKER_MIN_POINTS = 50_000`; `interface ChunkMaskInput { count: number; positions: ArrayLike<number>; quant: { offset: readonly [number, number, number]; scale: readonly [number, number, number] }; classes: Uint8Array | null }`; `interface ChunkMask { mask: Uint8Array; cls: Uint8Array | null; classes: Record<number, number> | null }`; `chunkMask(c: CompiledCleanup, input: ChunkMaskInput): ChunkMask`; `chunkMaskFor(recipe: PointcloudCleanup, origin: V3, input: ChunkMaskInput): ChunkMask`
  - `protocol.ts`: `MaskRequest` (`kind: 'mask'`, `recipe`, `origin`, `count`, `positions: Uint16Array`, `quant`, `classes`), its result `{ id } & ChunkMask`
  - `Decoder.mask?(job: Omit<MaskRequest, 'id'>): Promise<ChunkMask>`
  - `PointcloudAdapterOptions.cleanup?: StoreApi<CleanupRecipes>`; `CloudManager` constructor gains `cleanup: StoreApi<CleanupRecipes> = pointcloudCleanup`
  - `cloudSourceUrl(handle: SceneHandle, layerId: string): string | null`
  - `cloudWorldBounds(handle: SceneHandle, layerId: string): { min: [number, number, number]; max: [number, number, number] } | null` (project CRS, from the COPC header)

Behaviour (spec section 3): a layer with a recipe uses the recipe's `hiddenClasses` for `uClassShown`, else the global setting; the clip box and height range are uniforms (live while dragging, no re-upload); selections become `aMask` and an `aClass` override per chunk, computed when a chunk uploads and again for loaded chunks when the recipe's regions change, in the worker pool above 50,000 points; a recipe with `noise.path` streams that COPC instead of the layer's `src` (removed and added again), and falls back to `src` with a warning when the copy cannot be read. `png-packed` and `kit-packed` layers ignore recipes.

- [ ] **Step 1: Write the failing tests**

Create `packages/pointcloud/src/cleanup/chunk.test.ts`:

```ts
import { emptyCleanup, type PointcloudCleanup } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { compileCleanup } from './evaluate';
import { chunkMask, chunkMaskFor } from './chunk';

/** Ten points along local x at 0..9 m (world E = x with this origin), y = z = 0. */
const input = {
  count: 10,
  positions: Uint16Array.from({ length: 30 }, (_, k) => (k % 3 === 0 ? k / 3 : 0)),
  quant: { offset: [0, 0, 0] as const, scale: [1, 1, 1] as const },
  classes: new Uint8Array(10).fill(2),
};
const origin = [0, 64, 0] as const;
/** World to clip: ndc x = 0.1 E - 0.45 (E < 4.5 is left of 0), ndc y = 0, w = 1. */
const VP = [0.1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -0.45, 0, 0, 1];
const left: [number, number][] = [
  [-1, -1],
  [0, -1],
  [0, 1],
  [-1, 1],
];
const withRegion = (action: PointcloudCleanup['regions'][number]['action']): PointcloudCleanup => ({
  ...emptyCleanup('a'),
  regions: [{ id: 'r', shape: 'box', viewProj: VP, polygon: left, action }],
});

describe('chunk masks', () => {
  it('masks nothing without regions', () => {
    const r = chunkMask(compileCleanup(emptyCleanup('a'), { origin }), input);
    expect([...r.mask]).toEqual(new Array(10).fill(0));
    expect(r.cls).toBeNull();
  });

  it('masks a deleted or hidden selection', () => {
    for (const kind of ['delete', 'hide'] as const) {
      const r = chunkMaskFor(withRegion({ kind }), origin, input);
      expect([...r.mask]).toEqual([1, 1, 1, 1, 1, 0, 0, 0, 0, 0]);
    }
  });

  it('overrides the class of a selection and counts the new classes', () => {
    const r = chunkMaskFor(withRegion({ kind: 'class', value: 7 }), origin, input);
    expect([...r.mask]).toEqual(new Array(10).fill(0));
    expect([...(r.cls ?? [])]).toEqual([7, 7, 7, 7, 7, 2, 2, 2, 2, 2]);
    expect(r.classes).toEqual({ 2: 5, 7: 5 });
  });
});
```

Create `packages/pointcloud/src/cleanup/manager.test.ts` on the harness of `changeCloud.test.ts` (copy its `fakeHandle`, `flush` and `layout`; one decoder for the scene):

```ts
import type { SceneHandle } from '@aio/engine';
import { emptyCleanup, type PointcloudCleanup } from '@aio/schema';
import type { BufferAttribute, Points, Vector2 } from 'three';
import { PerspectiveCamera, Scene } from 'three';
import { describe, expect, it, vi } from 'vitest';
import {
  cloudSourceUrl,
  cloudWorldBounds,
  createPointcloudAdapter,
  getCloudManager,
} from '../adapter';
import type { CopcSource } from '../copc';
import type { Decoder } from '../pool';
import { createPointcloudSettings } from '../settings';
import { pointcloudStats } from '../stats';
import { createCleanupRecipes } from './store';

// fakeHandle, flush and layout: as in changeCloud.test.ts (copy them here)

const VP = [0.1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -0.45, 0, 0, 1];
const left: [number, number][] = [
  [-1, -1],
  [0, -1],
  [0, 1],
  [-1, 1],
];

function decoderFor(n: number, failNoise = false) {
  const mask = vi.fn();
  const source: CopcSource = {
    layout,
    cube: { min: [0, 0, 0], max: [64, 64, 64] },
    bounds: { min: [0, 54, 0], max: [9, 64, 3] },
    spacing: 1,
    pointCount: n,
    rootPage: { pageOffset: 10, pageLength: 64 },
  };
  const decoder: Decoder = {
    decode: () =>
      Promise.resolve({
        id: 0,
        count: n,
        position: Uint16Array.from({ length: 3 * n }, (_, k) => (k % 3 === 0 ? (k / 3) % 10 : 0)),
        classification: new Uint8Array(n).fill(2),
        intensity: new Uint8Array(n),
        quant: { offset: [0, 0, 0], scale: [1, 1, 1] },
        bounds: { min: [0, 0, 0], max: [9, 0, 0] },
        heights: Float32Array.from([0]),
      }),
    copcSource: (url) =>
      failNoise && url.includes('.noise-')
        ? Promise.reject(new Error('missing file'))
        : Promise.resolve(source),
    copcPage: () =>
      Promise.resolve({
        nodes: { '0-0-0-0': { pointCount: n, pointDataOffset: 1000, pointDataLength: 100 } },
        pages: {},
      }),
    mask: (job) => {
      mask(job.count);
      return Promise.resolve({ mask: new Uint8Array(job.count).fill(1), cls: null, classes: null });
    },
    dispose: vi.fn(),
  };
  return { decoder, mask };
}

async function scene(n = 10, failNoise = false) {
  const { handle, frame } = fakeHandle();
  const settings = createPointcloudSettings(null);
  settings.getState().setEdl(false);
  const recipes = createCleanupRecipes();
  const d = decoderFor(n, failNoise);
  const adapter = createPointcloudAdapter({
    decoder: () => d.decoder,
    settings,
    cleanup: recipes,
    origin: () => [0, 64, 0],
  });
  await adapter.create(
    {
      kind: 'pointcloud',
      id: 'a',
      name: 'a',
      visible: true,
      src: { path: 'clouds/a.copc.laz' },
      format: 'copc',
    },
    { scene: handle, url: (r) => ('path' in r ? `aio://project/p/${r.path}` : 'x') },
  );
  const settle = async () => {
    frame();
    await flush();
    frame();
    await flush();
    frame();
  };
  await settle();
  const pts = () => {
    const out: Points[] = [];
    handle.scene.traverse((o) => {
      if ((o as Points).isPoints) out.push(o as Points);
    });
    return out;
  };
  return { handle, settings, recipes, settle, pts, d };
}
const maskOf = (p: Points) => [...(p.geometry.getAttribute('aMask') as BufferAttribute).array];

describe('the cleanup in the viewer', () => {
  it('uses the recipe hidden classes for its layer instead of the global ones', async () => {
    const s = await scene();
    const m = getCloudManager(s.handle)?.layers.get('a')?.material;
    expect(m?.uniforms.uClassShown.value[2]).toBe(1);
    s.recipes.getState().set('a', { ...emptyCleanup('a'), hiddenClasses: [2] });
    expect(m?.uniforms.uClassShown.value[2]).toBe(0);
    s.settings.getState().toggleClass(6); // a global change does not undo the layer's set
    expect(m?.uniforms.uClassShown.value[2]).toBe(0);
    expect(m?.uniforms.uClassShown.value[6]).toBe(1);
    s.recipes.getState().set('a', null);
    expect(m?.uniforms.uClassShown.value[2]).toBe(1);
    expect(m?.uniforms.uClassShown.value[6]).toBe(0);
  });

  it('masks the points a selection covers on upload and when the regions change', async () => {
    const s = await scene();
    const [p] = s.pts();
    if (!p) throw new Error('no points');
    expect(maskOf(p)).toEqual(new Array(10).fill(0));
    const r: PointcloudCleanup = {
      ...emptyCleanup('a'),
      regions: [{ id: 'r', shape: 'box', viewProj: VP, polygon: left, action: { kind: 'delete' } }],
    };
    s.recipes.getState().set('a', r);
    expect(maskOf(p)).toEqual([1, 1, 1, 1, 1, 0, 0, 0, 0, 0]);
    s.recipes
      .getState()
      .set('a', { ...r, regions: [{ ...r.regions[0]!, action: { kind: 'class', value: 7 } }] });
    expect(maskOf(p)).toEqual(new Array(10).fill(0));
    expect([...(p.geometry.getAttribute('aClass') as BufferAttribute).array].slice(0, 6)).toEqual([
      7, 7, 7, 7, 7, 2,
    ]);
    s.recipes.getState().set('a', emptyCleanup('a'));
    expect([...(p.geometry.getAttribute('aClass') as BufferAttribute).array].slice(0, 6)).toEqual([
      2, 2, 2, 2, 2, 2,
    ]);
  });

  it('puts the clip box and heights in the uniforms every depth material shares', async () => {
    const s = await scene();
    s.recipes.getState().set('a', {
      ...emptyCleanup('a'),
      clipBox: { center: [4.5, 64, 0], size: [5, 5, 5], yaw: 0, keep: 'inside' },
      height: { min: -1, max: 2 },
    });
    for (const p of s.pts()) {
      const u = (p.material as { uniforms: Record<string, { value: unknown }> }).uniforms;
      expect(u.uBoxOn?.value).toBe(1);
      expect(u.uZMin?.value).toBe(-1);
      expect(u.uZMax?.value).toBe(2);
    }
  });

  it('masks a chunk above 50,000 points in the worker', async () => {
    const s = await scene(60_000);
    s.recipes.getState().set('a', {
      ...emptyCleanup('a'),
      regions: [{ id: 'r', shape: 'box', viewProj: VP, polygon: left, action: { kind: 'hide' } }],
    });
    await flush();
    expect(s.d.mask).toHaveBeenCalledWith(60_000);
    const [p] = s.pts();
    expect(p && maskOf(p).every((v) => v === 1)).toBe(true);
  });

  it('streams the noise copy, and the original again when the copy cannot be read', async () => {
    const s = await scene();
    expect(cloudSourceUrl(s.handle, 'a')).toBe('aio://project/p/clouds/a.copc.laz');
    const noise = {
      path: 'edits/pointcloud/a.noise-j1.copc.laz',
      params: { outlier: { meanK: 8, multiplier: 2 } },
      marked: 3,
      total: 10,
      runId: 'j1',
    };
    s.recipes.getState().set('a', { ...emptyCleanup('a'), noise });
    await s.settle();
    expect(cloudSourceUrl(s.handle, 'a')).toBe(
      'aio://project/p/edits/pointcloud/a.noise-j1.copc.laz',
    );
    s.recipes.getState().set('a', emptyCleanup('a'));
    await s.settle();
    expect(cloudSourceUrl(s.handle, 'a')).toBe('aio://project/p/clouds/a.copc.laz');

    const broken = await scene(10, true);
    broken.recipes.getState().set('a', { ...emptyCleanup('a'), noise });
    await broken.settle();
    expect(cloudSourceUrl(broken.handle, 'a')).toBe('aio://project/p/clouds/a.copc.laz');
    expect(pointcloudStats.getState().errors.some((e) => e.includes('a.noise-j1'))).toBe(true);
  });

  it('gives the layer bounds in the project CRS', async () => {
    const s = await scene();
    expect(cloudWorldBounds(s.handle, 'a')).toEqual({ min: [0, 54, 0], max: [9, 64, 3] });
    expect(cloudWorldBounds(s.handle, 'b')).toBeNull();
  });
});
```

`pointcloudStats` keeps the last ten messages in `errors` (stats.ts:39). The non-null assertion `r.regions[0]!` may need `?? fail()` if lint forbids it.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run packages/pointcloud/src/cleanup/chunk.test.ts packages/pointcloud/src/cleanup/manager.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `chunk.ts`**

```ts
/**
 * A chunk's cleanup mask and class override (the selections only; the clip box and heights are
 * shader uniforms): 1 in `mask` for a point a hide or delete selection covers; `cls` the classes
 * after the class selections (null when there are none). Runs on the main thread for small chunks
 * and in the decode workers above WORKER_MIN_POINTS (protocol.ts `mask`).
 */
import type { PointcloudCleanup } from '@aio/schema';
import { applyRegions, compileCleanup, type CompiledCleanup, type RegionHit } from './evaluate';

type V3 = readonly [number, number, number];

export const WORKER_MIN_POINTS = 50_000;

export interface ChunkMaskInput {
  count: number;
  /** Quantised positions: local = quant.offset + quant.scale * u. */
  positions: ArrayLike<number>;
  quant: { offset: V3; scale: V3 };
  classes: Uint8Array | null;
}

export interface ChunkMask {
  mask: Uint8Array;
  cls: Uint8Array | null;
  classes: Record<number, number> | null;
}

export function chunkMask(c: CompiledCleanup, input: ChunkMaskInput): ChunkMask {
  const { count, positions, quant, classes } = input;
  const mask = new Uint8Array(count);
  if (c.regions.length === 0) return { mask, cls: null, classes: null };
  const cls = c.regions.some((g) => g.kind === 'class') ? new Uint8Array(count) : null;
  const hist: Record<number, number> = {};
  const [ox, oy, oz] = quant.offset;
  const [sx, sy, sz] = quant.scale;
  const hit: RegionHit = { cls: 0, hide: false, del: false };
  for (let i = 0; i < count; i++) {
    applyRegions(
      c,
      ox + sx * (positions[3 * i] ?? 0),
      oy + sy * (positions[3 * i + 1] ?? 0),
      oz + sz * (positions[3 * i + 2] ?? 0),
      classes?.[i] ?? 1,
      hit,
    );
    if (hit.hide || hit.del) mask[i] = 1;
    if (cls) {
      cls[i] = hit.cls;
      hist[hit.cls] = (hist[hit.cls] ?? 0) + 1;
    }
  }
  return { mask, cls, classes: cls ? hist : null };
}

/** Worker entry: the compiled matrices are made where they are used. */
export function chunkMaskFor(
  recipe: PointcloudCleanup,
  origin: V3,
  input: ChunkMaskInput,
): ChunkMask {
  return chunkMask(compileCleanup(recipe, { origin }), input);
}
```

- [ ] **Step 4: Worker protocol and pool**

`protocol.ts`:

```ts
import type { PointcloudCleanup } from '@aio/schema';
import { chunkMaskFor, type ChunkMask } from './cleanup/chunk';

/** A chunk's cleanup mask, computed off the main thread (Task 6). Positions are a copy. */
export interface MaskRequest {
  id: number;
  kind: 'mask';
  recipe: PointcloudCleanup;
  origin: V3;
  count: number;
  positions: Uint16Array;
  quant: { offset: [number, number, number]; scale: [number, number, number] };
  classes: Uint8Array | null;
}

export type WorkerRequest = DecodeRequest | InfoRequest | MaskRequest;

export type WorkerResult =
  | DecodeResult
  | { id: number; source: CopcSource }
  | { id: number; hierarchy: CopcHierarchy }
  | ({ id: number } & ChunkMask);
```

and in `handleRequest`'s `switch`, a first case:

```ts
      case 'mask': {
        const r = chunkMaskFor(req.recipe, req.origin, req);
        const transfer = [r.mask.buffer as ArrayBuffer];
        if (r.cls) transfer.push(r.cls.buffer as ArrayBuffer);
        return { result: { id: req.id, ...r }, transfer };
      }
```

`pool.ts`: in `Decoder`, `/** A chunk's cleanup mask (workers only; without it the manager masks on the main thread). */ mask?(job: Omit<MaskRequest, 'id'>): Promise<ChunkMask>;` and in `createWorkerPool`'s returned object:

```ts
    async mask(job) {
      const r = await send(job);
      if (!('mask' in r)) throw new Error('Unexpected mask result');
      return { mask: r.mask, cls: r.cls, classes: r.classes };
    },
```

The decode result guard `if (!('count' in r))` in `decode` stays right: a mask result has no `count`.

- [ ] **Step 5: The manager**

`manager.ts` imports: `applyCleanupUniforms` (material), `cleanupUniformsOf`, `compileCleanup`, `type CompiledCleanup` (`./cleanup/evaluate`), `chunkMask`, `WORKER_MIN_POINTS`, `type ChunkMask` (`./cleanup/chunk`), `pointcloudCleanup`, `type CleanupRecipes` (`./cleanup/store`), `type PointcloudCleanup` (`@aio/schema`).

`ChunkState` gains:

```ts
  /** COPC: the decoder's quantisation, kept to mask the chunk again. */
  quant?: { offset: [number, number, number]; scale: [number, number, number] };
  /** COPC: the decoded classes, before any cleanup class selection. */
  baseClass?: Uint8Array;
  baseClasses?: Record<number, number>;
```

`CloudLayerState` gains:

```ts
  /** The layer's cleanup recipe compiled in the local frame (COPC only), or null. */
  cleanup: { recipe: PointcloudCleanup; compiled: CompiledCleanup; regionsKey: string } | null;
  /** Bumped when the selections change; a worker mask from before is dropped. */
  maskVersion: number;
```

(initialised `cleanup: null, maskVersion: 0` in `addLayer`).

Constructor: add the parameter `readonly cleanup: StoreApi<CleanupRecipes> = pointcloudCleanup` after `settings`; in the settings subscription replace the hidden-class loop with `if (l.material) applyHiddenClasses(l.material, this.hiddenFor(l));`; and subscribe:

```ts
this.unsubscribers.push(
  cleanup.subscribe((s, prev) => {
    if (s.recipes === prev.recipes) return;
    for (const l of this.layers.values()) {
      const r = s.recipes[l.id] ?? null;
      if (r !== (prev.recipes[l.id] ?? null)) this.applyRecipe(l, r);
    }
    handle.requestRender();
  }),
);
```

New private methods:

```ts
  /** The layer's hidden classes: its recipe's set, else the global one. */
  private hiddenFor(l: CloudLayerState): readonly number[] {
    return (
      this.cleanup.getState().recipes[l.id]?.hiddenClasses ??
      this.settings.getState().hiddenClasses
    );
  }

  private applyRecipe(l: CloudLayerState, r: PointcloudCleanup | null): void {
    // png-packed and kit-packed clouds have no COPC source to save from: no cleanup (the panel says so)
    if (!l.copc) return;
    const before = l.cleanup?.regionsKey ?? '';
    l.cleanup = r
      ? {
          recipe: r,
          compiled: compileCleanup(r, { origin: l.copc.origin }),
          regionsKey: JSON.stringify(r.regions),
        }
      : null;
    if (l.material) {
      applyCleanupUniforms(l.material, cleanupUniformsOf(l.cleanup?.compiled ?? null));
      applyHiddenClasses(l.material, this.hiddenFor(l));
    }
    if ((l.cleanup?.regionsKey ?? '') !== before) {
      l.maskVersion++;
      for (const c of l.loaded) this.maskChunk(l, c);
    }
  }

  private maskChunk(l: CloudLayerState, c: ChunkState): void {
    const obj = c.object;
    const quant = c.quant;
    const copc = l.copc;
    if (!obj || !quant || !copc) return;
    const position = obj.geometry.getAttribute('position');
    const count = position.count;
    const cu = l.cleanup;
    if (!cu || cu.compiled.regions.length === 0) {
      this.setMask(c, { mask: new Uint8Array(count), cls: null, classes: null });
      return;
    }
    const positions = position.array as Uint16Array;
    const input = { count, positions, quant, classes: c.baseClass ?? null };
    const dec = this.getDecoder();
    const version = l.maskVersion;
    if (count > WORKER_MIN_POINTS && dec.mask) {
      dec
        .mask({
          kind: 'mask',
          recipe: cu.recipe,
          origin: copc.origin,
          count,
          positions: positions.slice(),
          quant,
          classes: c.baseClass?.slice() ?? null,
        })
        .then((r) => {
          if (l.maskVersion === version && c.object === obj) this.setMask(c, r);
        })
        .catch((e: unknown) => {
          console.warn(`Cleanup mask of ${c.key} on the main thread: ${String(e)}`);
          if (l.maskVersion === version && c.object === obj) this.setMask(c, chunkMask(cu.compiled, input));
        });
      return;
    }
    this.setMask(c, chunkMask(cu.compiled, input));
  }

  private setMask(c: ChunkState, r: ChunkMask): void {
    const geo = c.object?.geometry;
    if (!geo) return;
    geo.setAttribute('aMask', new BufferAttribute(r.mask, 1));
    if (c.baseClass) geo.setAttribute('aClass', new BufferAttribute(r.cls ?? c.baseClass, 1));
    c.classes = r.classes ?? c.baseClasses ?? c.classes;
    this.statsDirty = true;
    this.handle.requestRender();
  }
```

In `addLayer`, after `this.layers.set(id, layer);`: `this.applyRecipe(layer, this.cleanup.getState().recipes[id] ?? null);`.

In `attach`: the material options gain `hasMask: c.source.kind === 'copc'` (use `src.kind`; move `const src = c.source;` above the material block), and after `applyHiddenClasses(...)` replace its argument with `this.hiddenFor(l)` and add `applyCleanupUniforms(l.material, cleanupUniformsOf(l.cleanup?.compiled ?? null));`. For COPC chunks, before `const pts = new Points(...)`:

```ts
if (src.kind === 'copc') {
  geo.setAttribute('aMask', new BufferAttribute(new Uint8Array(d.count), 1));
  if (d.quant) c.quant = d.quant;
  if (d.classification) {
    c.baseClass = d.classification;
    if (d.classes) c.baseClasses = d.classes;
  }
}
```

and at the end of `attach`, after `l.group.add(pts);`: `if (src.kind === 'copc' && l.cleanup?.compiled.regions.length) this.maskChunk(l, c);`.

Note that `hasMask` changes the material identity check in `attach` only through `src.kind`, which is the same for every chunk of a layer, so materials are not rebuilt per chunk.

- [ ] **Step 6: The adapter**

`adapter.ts`:

- `PointcloudAdapterOptions` gains `/** The live cleanup recipes; default the app's (cleanup/store.ts). */ cleanup?: StoreApi<CleanupRecipes>;`; `const cleanup = opts.cleanup ?? pointcloudCleanup;`; `managerFor` creates `new CloudManager(handle, makeDecoder, settings, cleanup)`.
- Move the body of the COPC branch's `try` into a local `const loadCopc = async (url: string) => { ...; return { chunks, baseSize, copc, scalar, box }; }` (same code, returning what it assigned). The branch becomes:

```ts
      } else if (layer.format === 'copc') {
        const origin = originOf();
        if (!origin) throw new Error('A COPC layer needs the project origin');
        const m = managerFor(handle);
        noisePath = cleanup.getState().recipes[layer.id]?.noise?.path ?? null;
        try {
          let r;
          try {
            r = await loadCopc(noisePath ? ctx.url({ path: noisePath }) : url, origin, m);
          } catch (e) {
            if (!noisePath) throw e;
            noiseFailed(noisePath, e);
            noisePath = null;
            r = await loadCopc(url, origin, m);
          }
          ({ chunks, baseSize, copc, scalar, box } = r);
        } catch (e) {
          release(handle, m);
          throw e;
        }
      }
```

with `let noisePath: string | null = null;` declared next to `let box` and

```ts
const noiseFailed = (path: string, e: unknown) => {
  const msg = `${path}: the noise working copy could not be read (${e instanceof Error ? e.message : String(e)}); showing the original cloud`;
  console.warn(msg);
  pointcloudStats.getState().addError(msg);
};
```

(`loadCopc` takes `origin` and the manager as arguments so it can live outside `create`.)

- After `m.addLayer(...)`, follow the recipe's noise path for COPC layers:

```ts
let disposed = false;
let swap = 0;
const offNoise =
  layer.format === 'copc'
    ? cleanup.subscribe((s) => {
        const want = s.recipes[layer.id]?.noise?.path ?? null;
        if (want === noisePath) return;
        noisePath = want;
        const mine = ++swap;
        const origin = originOf();
        if (!origin) return;
        const load = (path: string | null) =>
          loadCopc(path ? ctx.url({ path }) : url, origin, m).then((r) => {
            if (mine !== swap || disposed) return;
            m.removeLayer(layer.id);
            m.addLayer(layer.id, r.chunks, r.baseSize, rgbHint, r.copc, r.scalar);
            if (!shown) m.setVisible(layer.id, false);
          });
        load(want).catch((e: unknown) => {
          if (!want) return;
          noiseFailed(want, e);
          noisePath = null;
          void load(null).catch(() => undefined);
        });
      })
    : () => undefined;
```

and in the returned `dispose`: `disposed = true; offNoise();` before `unframe()`.

- Two helpers at the end of the file:

```ts
/** The COPC file a cloud layer streams now (its own, or its noise working copy). */
export function cloudSourceUrl(handle: SceneHandle, layerId: string): string | null {
  return getCloudManager(handle)?.layers.get(layerId)?.copc?.url ?? null;
}

/** A COPC layer's bounds in the project CRS (the header's, else the octree cube). */
export function cloudWorldBounds(
  handle: SceneHandle,
  layerId: string,
): { min: [number, number, number]; max: [number, number, number] } | null {
  const s = getCloudManager(handle)?.layers.get(layerId)?.copc?.source;
  const b = s?.bounds ?? s?.cube;
  return b ? { min: [...b.min], max: [...b.max] } : null;
}
```

`index.ts`: add `cloudSourceUrl`, `cloudWorldBounds`, `getCloudManager` to the `./adapter` export, and `export { WORKER_MIN_POINTS, chunkMask, type ChunkMask } from './cleanup/chunk';`.

- [ ] **Step 7: Run the package suite**

Run: `pnpm exec vitest run packages/pointcloud`
Expected: PASS, including the existing adapter, change cloud, pick and protocol tests.

- [ ] **Step 8: Commit**

```bash
git add packages/pointcloud/src/cleanup/chunk.ts packages/pointcloud/src/cleanup/chunk.test.ts packages/pointcloud/src/cleanup/manager.test.ts packages/pointcloud/src/manager.ts packages/pointcloud/src/adapter.ts packages/pointcloud/src/protocol.ts packages/pointcloud/src/pool.ts packages/pointcloud/src/index.ts
git commit -m "feat(pointcloud): apply cleanup recipes per layer in the viewer"
```

---

### Task 7: Engine clip box tool

**Packages touched:** `@aio/engine`.
**Contract change:** no (the `StageTool` union is engine-internal API; no file format). **E2E:** through Task 17.

**Files:**

- Modify: `packages/engine/src/types.ts:128` (`StageTool`)
- Modify: `packages/engine/src/stage/Stage.ts:512-519` (`setTool`)
- Create: `packages/engine/src/tools/clipbox.ts`
- Create: `packages/engine/src/tools/clipbox.test.ts`
- Modify: `packages/engine/src/index.ts` (export after the section exports, line 55)

**Interfaces:**

- Produces:
  - `type StageTool = 'select' | 'measure' | 'section' | 'clipbox' | 'pcselect'`
  - `interface ClipBoxLocal { center: [number, number, number]; size: [number, number, number]; yaw: number }` (local frame centre; size east, north, up; yaw as the recipe)
  - `type BoxFace = 'east' | 'west' | 'north' | 'south' | 'top' | 'bottom'`; `type BoxHandle = BoxFace | 'ring'`
  - `SNAP_M = 0.1`, `MIN_SIZE_M = 0.1`
  - `boxAxes(yaw: number): { east: Vector3; north: Vector3; up: Vector3 }` (local frame)
  - `faceNormal(face: BoxFace, yaw: number): Vector3`; `faceCentre(box: ClipBoxLocal, face: BoxFace): Vector3`
  - `closestOnLine(p: Vector3, d: Vector3, o: Vector3, r: Vector3): number | null`
  - `dragFace(start: ClipBoxLocal, face: BoxFace, along: number): ClipBoxLocal`
  - `headingOf(center: Vector3, at: Vector3): number` (radians, east toward north)
  - `pickHandle(points: readonly { id: BoxHandle; at: Vector3 }[], camera: Camera, ndc: { x: number; y: number }, size: { w: number; h: number }, radiusPx?: number): BoxHandle | null`
  - `formatBoxSize(box: ClipBoxLocal): [string, string, string]` (metres, one decimal)
  - `class ClipBoxTool { constructor(stage: EngineStage, opts: { box: ClipBoxLocal; onChange(box: ClipBoxLocal, done: boolean): void }); setBox(box: ClipBoxLocal): void; attach(): () => void; handleScreen(h: BoxHandle): { x: number; y: number } | null }`

- [ ] **Step 1: Write the failing test**

Create `packages/engine/src/tools/clipbox.test.ts`:

```ts
import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  boxAxes,
  closestOnLine,
  dragFace,
  faceCentre,
  formatBoxSize,
  headingOf,
  pickHandle,
  type ClipBoxLocal,
} from './clipbox';

const box: ClipBoxLocal = { center: [0, 5, 0], size: [10, 20, 4], yaw: 0 };

describe('clip box handle maths', () => {
  it('turns the box axes with the yaw (east toward north, local z is south)', () => {
    const a = boxAxes(Math.PI / 2);
    expect(a.east.x).toBeCloseTo(0, 9);
    expect(a.east.z).toBeCloseTo(-1, 9); // east turned a quarter points north
    expect(a.north.x).toBeCloseTo(-1, 9); // north turned a quarter points west
    expect(a.up.y).toBe(1);
  });

  it('puts face handles at the face centres', () => {
    expect(faceCentre(box, 'east').toArray()).toEqual([5, 5, 0]);
    expect(faceCentre(box, 'north').toArray()).toEqual([0, 5, -10]);
    expect(faceCentre(box, 'top').toArray()).toEqual([0, 7, 0]);
  });

  it('drags a face along its normal, snapping to 0.1 m, the opposite face fixed', () => {
    const b = dragFace(box, 'east', 1.234);
    expect(b.size[0]).toBeCloseTo(11.2, 9);
    expect(b.center[0]).toBeCloseTo(0.6, 9);
    expect(faceCentre(b, 'west').x).toBeCloseTo(-5, 9);
    const top = dragFace(box, 'top', -3);
    expect(top.size[2]).toBeCloseTo(1, 9);
    expect(top.center[1]).toBeCloseTo(3.5, 9);
  });

  it('never shrinks a face below 0.1 m', () => {
    expect(dragFace(box, 'south', -50).size[1]).toBeCloseTo(0.1, 9);
  });

  it('finds where a pointer ray passes closest to a handle line', () => {
    // the line is the x axis; a ray straight down through x = 3
    const t = closestOnLine(
      new Vector3(0, 0, 0),
      new Vector3(1, 0, 0),
      new Vector3(3, 10, 0),
      new Vector3(0, -1, 0),
    );
    expect(t).toBeCloseTo(3, 9);
    expect(
      closestOnLine(
        new Vector3(),
        new Vector3(1, 0, 0),
        new Vector3(0, 1, 0),
        new Vector3(1, 0, 0),
      ),
    ).toBeNull();
  });

  it('measures headings east toward north', () => {
    const c = new Vector3(0, 0, 0);
    expect(headingOf(c, new Vector3(1, 0, 0))).toBeCloseTo(0, 9);
    expect(headingOf(c, new Vector3(0, 0, -1))).toBeCloseTo(Math.PI / 2, 9); // north
  });

  it('picks the nearest handle within the radius', () => {
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const pts = [
      { id: 'east' as const, at: new Vector3(0, 0, 0) },
      { id: 'west' as const, at: new Vector3(3, 0, 0) },
    ];
    expect(pickHandle(pts, camera, { x: 0.01, y: 0 }, { w: 500, h: 500 })).toBe('east');
    expect(pickHandle(pts, camera, { x: 0.9, y: 0.9 }, { w: 500, h: 500 })).toBeNull();
  });

  it('reads the size in metres with one decimal', () => {
    expect(formatBoxSize({ ...box, size: [12.04, 8.46, 4] })).toEqual(['12.0', '8.5', '4.0']);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm exec vitest run packages/engine/src/tools/clipbox.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Widen the tool union**

`packages/engine/src/types.ts:128`:

```ts
/**
 * `clipbox` and `pcselect` are the point cloud cleanup tools (tools/clipbox.ts, tools/pcselect.ts):
 * the app attaches them while the tool is on; the stage only knows the cursor.
 */
export type StageTool = 'select' | 'measure' | 'section' | 'clipbox' | 'pcselect';
```

`Stage.ts` `setTool`: replace the cursor line with
`this.canvas.style.cursor = tool === 'measure' || tool === 'pcselect' ? 'crosshair' : '';`. In `onPointerMove` (~line 1508) keep `crosshair` for `pcselect` too: `this.canvas.style.cursor = this._tool === 'measure' || this._tool === 'pcselect' ? 'crosshair' : node ? 'pointer' : '';` and skip hover picking for `pcselect` like `measure`.

- [ ] **Step 4: Write `clipbox.ts`**

```ts
/**
 * The point cloud clip box gizmo (cleanup, FUS-9): a wire box, six face handles that drag along
 * their normals (the size snaps to 0.1 m, the opposite face stays put), a ring above the top face
 * that turns the box about the vertical axis, all in the local frame (x east, y up, z south). The
 * app owns the box (world coordinates in the recipe) and converts; this file only edits.
 */
import {
  BoxGeometry,
  BufferGeometry,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineLoop,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  Plane,
  Raycaster,
  SphereGeometry,
  Vector2,
  Vector3,
  type Camera,
} from 'three';
import type { EngineStage } from '../types';

export interface ClipBoxLocal {
  center: [number, number, number];
  /** Along the box's east, north and up axes, metres. */
  size: [number, number, number];
  /** Radians about up, east toward north (the recipe's yaw). */
  yaw: number;
}
export type BoxFace = 'east' | 'west' | 'north' | 'south' | 'top' | 'bottom';
export type BoxHandle = BoxFace | 'ring';

export const SNAP_M = 0.1;
export const MIN_SIZE_M = 0.1;
const FACES: readonly BoxFace[] = ['east', 'west', 'north', 'south', 'top', 'bottom'];
const AXIS: Record<BoxFace, 0 | 1 | 2> = {
  east: 0,
  west: 0,
  north: 1,
  south: 1,
  top: 2,
  bottom: 2,
};
const SIGN: Record<BoxFace, 1 | -1> = {
  east: 1,
  west: -1,
  north: 1,
  south: -1,
  top: 1,
  bottom: -1,
};

export function boxAxes(yaw: number): { east: Vector3; north: Vector3; up: Vector3 } {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  // world east (c, s) and north (-s, c) in E, N; local x = E, z = -N
  return { east: new Vector3(c, 0, -s), north: new Vector3(-s, 0, -c), up: new Vector3(0, 1, 0) };
}

export function faceNormal(face: BoxFace, yaw: number): Vector3 {
  const a = boxAxes(yaw);
  const axis = [a.east, a.north, a.up][AXIS[face]] ?? a.up;
  return axis.multiplyScalar(SIGN[face]);
}

export function faceCentre(box: ClipBoxLocal, face: BoxFace): Vector3 {
  const half = box.size[AXIS[face]] / 2;
  return new Vector3(...box.center).addScaledVector(faceNormal(face, box.yaw), half);
}

/** Where along the line p + s d a ray o + t r passes closest; null when they are parallel. */
export function closestOnLine(p: Vector3, d: Vector3, o: Vector3, r: Vector3): number | null {
  const w = p.clone().sub(o);
  const a = d.dot(d);
  const b = d.dot(r);
  const c = r.dot(r);
  const dd = d.dot(w);
  const e = r.dot(w);
  const den = a * c - b * b;
  if (Math.abs(den) < 1e-9) return null;
  return (b * e - c * dd) / den;
}

/** The box with one face moved `along` metres outward (negative: inward), snapped. */
export function dragFace(start: ClipBoxLocal, face: BoxFace, along: number): ClipBoxLocal {
  const axis = AXIS[face];
  const raw = (start.size[axis] ?? 0) + along;
  const size = Math.max(MIN_SIZE_M, Math.round(raw / SNAP_M) * SNAP_M);
  const grow = size - (start.size[axis] ?? 0);
  const c = new Vector3(...start.center).addScaledVector(faceNormal(face, start.yaw), grow / 2);
  const next: [number, number, number] = [...start.size];
  next[axis] = size;
  return { center: [c.x, c.y, c.z], size: next, yaw: start.yaw };
}

/** Heading of `at` seen from `center` on the horizontal plane, east toward north. */
export function headingOf(center: Vector3, at: Vector3): number {
  return Math.atan2(-(at.z - center.z), at.x - center.x);
}

const projected = new Vector3();

/** The handle nearest to the pointer on screen, within `radiusPx` CSS pixels. */
export function pickHandle(
  points: readonly { id: BoxHandle; at: Vector3 }[],
  camera: Camera,
  ndc: { x: number; y: number },
  size: { w: number; h: number },
  radiusPx = 14,
): BoxHandle | null {
  let best: BoxHandle | null = null;
  let bestD = radiusPx;
  for (const p of points) {
    projected.copy(p.at).project(camera);
    if (projected.z < -1 || projected.z > 1) continue;
    const dx = ((projected.x - ndc.x) * size.w) / 2;
    const dy = ((projected.y - ndc.y) * size.h) / 2;
    const d = Math.hypot(dx, dy);
    if (d <= bestD) {
      bestD = d;
      best = p.id;
    }
  }
  return best;
}

export function formatBoxSize(box: ClipBoxLocal): [string, string, string] {
  return [box.size[0].toFixed(1), box.size[1].toFixed(1), box.size[2].toFixed(1)];
}

const COLOUR = 0xffb020;

export class ClipBoxTool {
  readonly group = new Group();
  private box: ClipBoxLocal;
  private readonly wire: LineSegments;
  private readonly ring: LineLoop;
  private readonly knobs = new Map<BoxFace, Mesh>();
  private drag:
    | { kind: 'face'; face: BoxFace; start: ClipBoxLocal; t0: number }
    | { kind: 'ring'; start: ClipBoxLocal; h0: number }
    | null = null;
  private readonly ray = new Raycaster();

  constructor(
    private readonly stage: EngineStage,
    private readonly opts: { box: ClipBoxLocal; onChange(box: ClipBoxLocal, done: boolean): void },
  ) {
    this.box = opts.box;
    this.group.name = 'engine:clipbox';
    this.group.renderOrder = 31;
    const line = new LineBasicMaterial({ color: COLOUR, depthTest: false, transparent: true });
    this.wire = new LineSegments(new EdgesGeometry(new BoxGeometry(1, 1, 1)), line);
    const pts = Array.from({ length: 64 }, (_, i) => {
      const a = (i / 64) * Math.PI * 2;
      return new Vector3(Math.cos(a), 0, Math.sin(a));
    });
    this.ring = new LineLoop(new BufferGeometry().setFromPoints(pts), line);
    const knob = new MeshBasicMaterial({ color: COLOUR, depthTest: false, transparent: true });
    const ball = new SphereGeometry(1, 12, 8);
    for (const f of FACES) {
      const m = new Mesh(ball, knob);
      m.name = `engine:clipbox:${f}`;
      this.knobs.set(f, m);
      this.group.add(m);
    }
    this.group.add(this.wire, this.ring);
    for (const o of [this.wire, this.ring, ...this.knobs.values()]) {
      o.raycast = () => undefined;
      o.frustumCulled = false;
    }
    this.sync();
  }

  setBox(box: ClipBoxLocal): void {
    this.box = box;
    this.sync();
  }

  /** Screen position (client pixels) of a handle, for the e2e specs. */
  handleScreen(h: BoxHandle): { x: number; y: number } | null {
    const at = h === 'ring' ? this.ringPoint() : faceCentre(this.box, h);
    const r = this.stage.renderer.domElement.getBoundingClientRect();
    const p = at.project(this.stage.camera);
    if (p.z < -1 || p.z > 1) return null;
    return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height };
  }

  attach(): () => void {
    const canvas = this.stage.renderer.domElement;
    this.stage.scene.add(this.group);
    const offFrame = this.stage.onFrame(() => {
      this.scaleKnobs();
    });
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const ndc = this.ndc(e);
      const r = canvas.getBoundingClientRect();
      const hit = pickHandle(this.handles(), this.stage.camera, ndc, { w: r.width, h: r.height });
      if (!hit) return;
      e.stopImmediatePropagation();
      this.stage.controls.enabled = false;
      this.ray.setFromCamera(new Vector2(ndc.x, ndc.y), this.stage.camera);
      if (hit === 'ring') {
        const at = this.onTopPlane();
        this.drag = at
          ? { kind: 'ring', start: this.box, h0: headingOf(new Vector3(...this.box.center), at) }
          : null;
      } else {
        const t0 = closestOnLine(
          faceCentre(this.box, hit),
          faceNormal(hit, this.box.yaw),
          this.ray.ray.origin,
          this.ray.ray.direction,
        );
        this.drag = t0 === null ? null : { kind: 'face', face: hit, start: this.box, t0 };
      }
      if (!this.drag) this.stage.controls.enabled = true;
    };
    const move = (e: PointerEvent) => {
      const d = this.drag;
      if (!d) return;
      const ndc = this.ndc(e);
      this.ray.setFromCamera(new Vector2(ndc.x, ndc.y), this.stage.camera);
      if (d.kind === 'face') {
        const t = closestOnLine(
          faceCentre(d.start, d.face),
          faceNormal(d.face, d.start.yaw),
          this.ray.ray.origin,
          this.ray.ray.direction,
        );
        if (t === null) return;
        this.setBox(dragFace(d.start, d.face, t - d.t0));
      } else {
        const at = this.onTopPlane();
        if (!at) return;
        const h = headingOf(new Vector3(...d.start.center), at);
        this.setBox({ ...d.start, yaw: d.start.yaw + (h - d.h0) });
      }
      this.opts.onChange(this.box, false);
      this.stage.requestRender();
    };
    const up = () => {
      if (!this.drag) return;
      this.drag = null;
      this.stage.controls.enabled = true;
      this.opts.onChange(this.box, true);
    };
    canvas.addEventListener('pointerdown', down, { capture: true });
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    this.stage.requestRender();
    return () => {
      canvas.removeEventListener('pointerdown', down, { capture: true });
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      offFrame();
      if (this.drag) this.stage.controls.enabled = true;
      this.drag = null;
      this.group.removeFromParent();
      this.wire.geometry.dispose();
      this.ring.geometry.dispose();
      this.knobs.values().next().value?.geometry.dispose();
      this.stage.requestRender();
    };
  }

  private ndc(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.stage.renderer.domElement.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * 2 - 1,
      y: -((e.clientY - r.top) / r.height) * 2 + 1,
    };
  }

  private ringPoint(): Vector3 {
    const top = faceCentre(this.box, 'top');
    const r = Math.max(this.box.size[0], this.box.size[1]) * 0.6;
    return top.addScaledVector(boxAxes(this.box.yaw).east, r);
  }

  private handles(): { id: BoxHandle; at: Vector3 }[] {
    return [
      ...FACES.map((f) => ({ id: f, at: faceCentre(this.box, f) })),
      { id: 'ring' as const, at: this.ringPoint() },
    ];
  }

  /** The pointer ray on the horizontal plane through the top face. */
  private onTopPlane(): Vector3 | null {
    const top = faceCentre(this.box, 'top');
    const plane = new Plane(new Vector3(0, 1, 0), -top.y);
    return this.ray.ray.intersectPlane(plane, new Vector3());
  }

  private sync(): void {
    const [cx, cy, cz] = this.box.center;
    this.wire.position.set(cx, cy, cz);
    this.wire.rotation.set(0, this.box.yaw, 0);
    // BoxGeometry x is east, y up, z south: size [east, north, up] -> scale [east, up, north]
    this.wire.scale.set(this.box.size[0], this.box.size[2], this.box.size[1]);
    const top = faceCentre(this.box, 'top');
    const r = Math.max(this.box.size[0], this.box.size[1]) * 0.6;
    this.ring.position.copy(top);
    this.ring.scale.setScalar(r);
    for (const f of FACES) this.knobs.get(f)?.position.copy(faceCentre(this.box, f));
    this.scaleKnobs();
    this.stage.requestRender();
  }

  /** Handles keep about 7 pixels on screen whatever the distance. */
  private scaleKnobs(): void {
    const cam = this.stage.camera;
    const h = this.stage.renderer.domElement.clientHeight || 1;
    const perPx = (d: number) => (2 * d * Math.tan((cam.fov * Math.PI) / 360)) / h;
    for (const m of this.knobs.values())
      m.scale.setScalar(perPx(cam.position.distanceTo(m.position)) * 7);
  }
}
```

Check the rotation sign once in the running app (Task 15 manual check): `rotation.y = yaw` turns local +x toward local -z (north) for a positive yaw, which is what `boxAxes` says. `this.knobs.values().next().value?.geometry.dispose()` disposes the shared sphere; if lint objects to the iterator helper, keep a `ball` field and dispose it.

`packages/engine/src/index.ts`, after `export { DEFAULT_SECTION } from './tools/section';`:

```ts
export {
  ClipBoxTool,
  MIN_SIZE_M,
  SNAP_M,
  boxAxes,
  closestOnLine,
  dragFace,
  faceCentre,
  faceNormal,
  formatBoxSize,
  headingOf,
  pickHandle,
  type BoxFace,
  type BoxHandle,
  type ClipBoxLocal,
} from './tools/clipbox';
```

- [ ] **Step 5: Run the tests and the engine suite**

Run: `pnpm exec vitest run packages/engine/src/tools/clipbox.test.ts packages/engine/src/stage/Stage.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/types.ts packages/engine/src/stage/Stage.ts packages/engine/src/tools/clipbox.ts packages/engine/src/tools/clipbox.test.ts packages/engine/src/index.ts
git commit -m "feat(engine): clip box gizmo tool and the cleanup stage tools"
```

---

### Task 8: Engine selection tool (box and lasso)

**Packages touched:** `@aio/engine`.
**Contract change:** no. **E2E:** through Task 17.

**Files:**

- Create: `packages/engine/src/tools/pcselect.ts`
- Create: `packages/engine/src/tools/pcselect.test.ts`
- Modify: `packages/engine/src/index.ts` (export after the clip box exports of Task 7)

**Interfaces:**

- Consumes: `StageTool` member `'pcselect'` (Task 7); `EngineStage`.
- Produces:
  - `type SelectShape = 'box' | 'lasso'`
  - `interface PointSelection { shape: SelectShape; polygon: [number, number][]; viewProj: number[] }` (NDC polygon; `viewProj` is the stage camera's projection times view, local frame to clip, column-major)
  - `MAX_LASSO_VERTICES = 256`
  - `rectPolygon(a: [number, number], b: [number, number]): [number, number][]` (4 corners, counter-clockwise from the lower left)
  - `simplifyPath(pts: readonly [number, number][], max?: number): [number, number][]` (Ramer-Douglas-Peucker with a growing tolerance until at most `max` vertices; consecutive duplicates removed)
  - `class PointSelectTool { constructor(stage: EngineStage, opts: { shape: SelectShape; onSelect(sel: PointSelection): void; onCancel(): void }); setShape(shape: SelectShape): void; attach(): () => void }`

- [ ] **Step 1: Write the failing test**

Create `packages/engine/src/tools/pcselect.test.ts`:

```ts
// @vitest-environment jsdom
import { Matrix4, PerspectiveCamera } from 'three';
import { describe, expect, it } from 'vitest';
import type { EngineStage } from '../types';
import { MAX_LASSO_VERTICES, PointSelectTool, rectPolygon, simplifyPath } from './pcselect';

describe('selection outlines', () => {
  it('makes a box from two corners in any order', () => {
    expect(rectPolygon([0.5, 0.5], [-0.5, -0.25])).toEqual([
      [-0.5, -0.25],
      [0.5, -0.25],
      [0.5, 0.5],
      [-0.5, 0.5],
    ]);
  });

  it('simplifies a 5000-sample lasso to at most 256 vertices near the drawn path', () => {
    // a wobbly circle drawn for several seconds, crossing itself at the end
    const pts: [number, number][] = Array.from({ length: 5000 }, (_, i) => {
      const a = (i / 4800) * Math.PI * 2;
      const r = 0.5 + 0.01 * Math.sin(i * 0.7);
      return [r * Math.cos(a), r * Math.sin(a)];
    });
    const out = simplifyPath(pts);
    expect(out.length).toBeLessThanOrEqual(MAX_LASSO_VERTICES);
    expect(out.length).toBeGreaterThanOrEqual(3);
    for (const [x, y] of out) expect(Math.abs(Math.hypot(x, y) - 0.5)).toBeLessThan(0.02);
  });

  it('keeps a short path as it is, without repeated points', () => {
    expect(
      simplifyPath([
        [0, 0],
        [0, 0],
        [1, 0],
        [1, 1],
      ]),
    ).toEqual([
      [0, 0],
      [1, 0],
      [1, 1],
    ]);
  });
});

function fakeStage() {
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  canvas.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100 }) as DOMRect;
  const camera = new PerspectiveCamera(60, 2, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.updateMatrixWorld();
  const stage = {
    camera,
    renderer: { domElement: canvas },
    controls: { enabled: true },
    requestRender: () => undefined,
  } as unknown as EngineStage;
  return { stage, canvas };
}
const ev = (type: string, x: number, y: number) =>
  new PointerEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true });

describe('PointSelectTool', () => {
  it('reports a box in NDC with the view at the time of drawing', () => {
    const { stage, canvas } = fakeStage();
    const got: unknown[] = [];
    const tool = new PointSelectTool(stage, {
      shape: 'box',
      onSelect: (s) => got.push(s),
      onCancel: () => got.push('cancel'),
    });
    const off = tool.attach();
    canvas.dispatchEvent(ev('pointerdown', 50, 25));
    expect(stage.controls.enabled).toBe(false);
    window.dispatchEvent(ev('pointermove', 150, 75));
    window.dispatchEvent(ev('pointerup', 150, 75));
    expect(stage.controls.enabled).toBe(true);
    expect(got).toHaveLength(1);
    const sel = got[0] as { shape: string; polygon: number[][]; viewProj: number[] };
    expect(sel.shape).toBe('box');
    expect(sel.polygon).toEqual([
      [-0.5, -0.5],
      [0.5, -0.5],
      [0.5, 0.5],
      [-0.5, 0.5],
    ]);
    const vp = new Matrix4().multiplyMatrices(
      stage.camera.projectionMatrix,
      stage.camera.matrixWorldInverse,
    );
    expect(sel.viewProj).toEqual(vp.toArray());
    off();
  });

  it('cancels on Escape and ignores a click without a drag', () => {
    const { stage, canvas } = fakeStage();
    const got: unknown[] = [];
    const tool = new PointSelectTool(stage, {
      shape: 'lasso',
      onSelect: (s) => got.push(s),
      onCancel: () => got.push('cancel'),
    });
    const off = tool.attach();
    canvas.dispatchEvent(ev('pointerdown', 10, 10));
    window.dispatchEvent(ev('pointermove', 60, 10));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    window.dispatchEvent(ev('pointerup', 60, 60));
    expect(got).toEqual(['cancel']);
    canvas.dispatchEvent(ev('pointerdown', 10, 10));
    window.dispatchEvent(ev('pointerup', 11, 10));
    expect(got).toEqual(['cancel']);
    off();
  });
});
```

(jsdom has no `PointerEvent` in some versions: if `PointerEvent` is undefined, define `globalThis.PointerEvent = MouseEvent as never` at the top of the test, after the pragma.)

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm exec vitest run packages/engine/src/tools/pcselect.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Write `pcselect.ts`**

```ts
/**
 * Box and lasso selection of cloud points (cleanup, ANN-4): a screen rectangle or a freehand path
 * drawn over the view in an SVG overlay, reported in NDC with the camera's view-projection (local
 * frame to clip) at the time of drawing. A lasso keeps at most 256 vertices. Escape cancels. The
 * app counts and stores the selection (renderer/pointcloud/cleanupScene.ts).
 */
import { Matrix4 } from 'three';
import type { EngineStage } from '../types';

export type SelectShape = 'box' | 'lasso';
export interface PointSelection {
  shape: SelectShape;
  polygon: [number, number][];
  viewProj: number[];
}

export const MAX_LASSO_VERTICES = 256;
/** A drag shorter than this (CSS pixels) is a click, not a selection. */
const MIN_DRAG_PX = 4;
const SVG = 'http://www.w3.org/2000/svg';

export function rectPolygon(a: [number, number], b: [number, number]): [number, number][] {
  const x0 = Math.min(a[0], b[0]);
  const x1 = Math.max(a[0], b[0]);
  const y0 = Math.min(a[1], b[1]);
  const y1 = Math.max(a[1], b[1]);
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

function segDist(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  const t = len > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function rdp(pts: readonly [number, number][], eps: number): [number, number][] {
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop() ?? [0, 0];
    let far = -1;
    let farD = eps;
    for (let k = i + 1; k < j; k++) {
      const d = segDist(pts[k] ?? [0, 0], pts[i] ?? [0, 0], pts[j] ?? [0, 0]);
      if (d > farD) {
        farD = d;
        far = k;
      }
    }
    if (far >= 0) {
      keep[far] = 1;
      stack.push([i, far], [far, j]);
    }
  }
  return pts.filter((_, k) => keep[k] === 1);
}

export function simplifyPath(
  pts: readonly [number, number][],
  max = MAX_LASSO_VERTICES,
): [number, number][] {
  const clean: [number, number][] = [];
  for (const p of pts) {
    const last = clean[clean.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-9) clean.push(p);
  }
  if (clean.length <= max) return clean;
  let eps = 1e-4;
  let out = rdp(clean, eps);
  while (out.length > max) {
    eps *= 1.5;
    out = rdp(clean, eps);
  }
  return out;
}

export class PointSelectTool {
  private shape: SelectShape;
  private path: [number, number][] = [];
  private start: { x: number; y: number } | null = null;
  private overlay: SVGSVGElement | null = null;
  private outline: SVGPolylineElement | null = null;

  constructor(
    private readonly stage: EngineStage,
    private readonly opts: {
      shape: SelectShape;
      onSelect(sel: PointSelection): void;
      onCancel(): void;
    },
  ) {
    this.shape = opts.shape;
  }

  setShape(shape: SelectShape): void {
    this.shape = shape;
  }

  attach(): () => void {
    const canvas = this.stage.renderer.domElement;
    const parent = canvas.parentElement ?? document.body;
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('data-testid', 'pcselect-overlay');
    svg.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:5';
    const line = document.createElementNS(SVG, 'polyline');
    line.setAttribute('fill', 'rgba(255,176,32,0.12)');
    line.setAttribute('stroke', '#ffb020');
    line.setAttribute('stroke-width', '1.5');
    line.setAttribute('stroke-dasharray', '4 3');
    svg.append(line);
    parent.append(svg);
    this.overlay = svg;
    this.outline = line;

    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.stopImmediatePropagation();
      this.stage.controls.enabled = false;
      this.start = { x: e.clientX, y: e.clientY };
      this.path = [this.ndc(e)];
      this.draw();
    };
    const move = (e: PointerEvent) => {
      if (!this.start) return;
      if (this.shape === 'box') this.path = [this.path[0] ?? this.ndc(e), this.ndc(e)];
      else this.path.push(this.ndc(e));
      this.draw();
    };
    const up = (e: PointerEvent) => {
      const s = this.start;
      if (!s) return;
      this.start = null;
      this.stage.controls.enabled = true;
      const moved = Math.hypot(e.clientX - s.x, e.clientY - s.y) >= MIN_DRAG_PX;
      const first = this.path[0];
      const polygon =
        this.shape === 'box'
          ? first && moved
            ? rectPolygon(first, this.ndc(e))
            : []
          : simplifyPath([...this.path, this.ndc(e)]);
      this.path = [];
      this.draw();
      if (!moved || polygon.length < 3) return;
      const cam = this.stage.camera;
      cam.updateMatrixWorld();
      const viewProj = new Matrix4()
        .multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
        .toArray();
      this.opts.onSelect({ shape: this.shape, polygon, viewProj });
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (this.start) {
        this.start = null;
        this.path = [];
        this.stage.controls.enabled = true;
        this.draw();
      }
      e.stopImmediatePropagation();
      this.opts.onCancel();
    };
    canvas.addEventListener('pointerdown', down, { capture: true });
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('keydown', key, { capture: true });
    return () => {
      canvas.removeEventListener('pointerdown', down, { capture: true });
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', key, { capture: true });
      if (this.start) this.stage.controls.enabled = true;
      this.start = null;
      svg.remove();
      this.overlay = null;
      this.outline = null;
    };
  }

  private ndc(e: { clientX: number; clientY: number }): [number, number] {
    const r = this.stage.renderer.domElement.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1];
  }

  /** The outline in overlay pixels (the overlay covers the canvas's parent). */
  private draw(): void {
    const line = this.outline;
    const svg = this.overlay;
    if (!line || !svg) return;
    const r = this.stage.renderer.domElement.getBoundingClientRect();
    const o = svg.getBoundingClientRect();
    const px = ([x, y]: [number, number]) =>
      `${String(r.left - o.left + ((x + 1) / 2) * r.width)},${String(r.top - o.top + ((1 - y) / 2) * r.height)}`;
    const pts =
      this.shape === 'box' && this.path.length === 2
        ? rectPolygon(this.path[0] ?? [0, 0], this.path[1] ?? [0, 0])
        : this.path;
    line.setAttribute('points', pts.length ? [...pts, pts[0] ?? [0, 0]].map(px).join(' ') : '');
  }
}
```

Note for the e2e (Task 17): the canvas listener is a capture listener and calls `stopImmediatePropagation`, so the orbit controls and the stage's own click selection never see a drag that draws a selection.

`packages/engine/src/index.ts`:

```ts
export {
  MAX_LASSO_VERTICES,
  PointSelectTool,
  rectPolygon,
  simplifyPath,
  type PointSelection,
  type SelectShape,
} from './tools/pcselect';
```

- [ ] **Step 4: Run the test**

Run: `pnpm exec vitest run packages/engine/src/tools/pcselect.test.ts`
Expected: PASS. In the box test the corners map 50,25 to (-0.5, 0.5) and 150,75 to (0.5, -0.5) on the 200 x 100 canvas.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/tools/pcselect.ts packages/engine/src/tools/pcselect.test.ts packages/engine/src/index.ts
git commit -m "feat(engine): box and lasso point selection tool"
```

---

### Task 9: Main IPC, journal, pack gate and the cleaned-copy rules

**Packages touched:** desktop main, `@aio/project` (removal plan), desktop renderer (change producer).
**Contract change:** implements rows 2 and 5. **E2E:** through Task 17.

**Files:**

- Create: `apps/desktop/src/main/pointcloudCleanup.ts`
- Create: `apps/desktop/src/main/pointcloudCleanup.test.ts`
- Modify: `apps/desktop/src/main/index.ts` (import near line 98; `jobs:start` refusal line 1285; pack features list line 1810; registration after `registerSurveyHaulIpc` ~line 1775)
- Modify: `apps/desktop/src/main/journal.ts` (`WRITERS` after `'survey:writeTerrainEdits'`, line 237; `READS` set ~line 250)
- Modify: `apps/desktop/src/main/journal.test.ts` (one case)
- Modify: `packages/project/src/builder/removePlan.ts:410-414`, `packages/project/src/builder/removePlan.test.ts`
- Modify: `apps/desktop/src/renderer/change/producers/cloud.ts:68`, its test file next to it (`cloud.test.ts`; create the case in the existing file)

**Interfaces:**

- Consumes: Task 1 (`PointcloudCleanup`, `NoiseRun`, `noiseRunPath`, `pccleanupPath`, `POINTCLOUD_CLEAN_MIN_PACK`, `POINTCLOUD_CLEAN_FEATURE`, IPC types); `readJsonSeen`, `writeJsonSeen`, `isChangedOnDisk` (`fsutil.ts`); `compareVersions` (`jobs/pack.ts`); `freeTrashEntry` (`@aio/project/builder`, lazy import as `panos.ts` does); `collectHandlers` (`notYet.ts`).
- Produces:
  - `CLEAN_PACK_FEATURE: { label: string; minVersion: string }`
  - `cleanPackRefusal(pipeline: string, packVersion: string | null): string | null`
  - `readCleanups(root: string): Promise<PointcloudCleanup[]>`
  - `readNoiseRun(root: string, layerId: string, runId: string): Promise<NoiseRun | null>`
  - `writeCleanup(root: string, layerId: string, recipe: PointcloudCleanup | null, keep: readonly string[], now?: Date): Promise<IpcResponse<'pointcloud:writeCleanup'>>`
  - `registerPointcloudCleanupIpc(deps: { handle: Handle; projects: { root(id: string): string | undefined; package(id: string): unknown }; projectPackage?: (id: string) => { entries: ReadonlyMap<string, unknown>; read(name: string): Promise<Buffer> } | undefined; now?: () => Date }): void`

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/src/main/pointcloudCleanup.test.ts`:

```ts
import { emptyCleanup, noiseCopyPath, noiseRunPath, type PointcloudCleanup } from '@aio/schema';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectHandlers } from './notYet';
import { cleanPackRefusal, registerPointcloudCleanupIpc } from './pointcloudCleanup';

const NOW = new Date('2026-10-15T09:00:00.000Z');
const run = (layerId: string, runId: string) => ({
  path: noiseCopyPath(layerId, runId),
  params: { outlier: { meanK: 8, multiplier: 2 } },
  marked: 60,
  total: 16060,
  runId,
});

describe('point cloud cleanup IPC', () => {
  let root = '';
  let ipc: ReturnType<typeof collectHandlers>;
  const archive = new Map<string, Buffer>();

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pccleanup-'));
    ipc = collectHandlers((handle) => {
      registerPointcloudCleanupIpc({
        handle,
        projects: {
          root: (id) => (id === 'p' ? root : undefined),
          package: (id) => (id === 'pkg' ? {} : undefined),
        },
        projectPackage: () => ({
          entries: archive,
          read: (n) => Promise.resolve(archive.get(n) ?? Buffer.alloc(0)),
        }),
        now: () => NOW,
      });
    });
  });
  afterEach(async () => {
    archive.clear();
    await rm(root, { recursive: true, force: true });
  });

  const put = async (rel: string, body: string) => {
    await mkdir(join(root, 'edits', 'pointcloud'), { recursive: true });
    await writeFile(join(root, rel), body);
  };

  it('registers the two channels', () => {
    expect(ipc.channels()).toEqual(['pointcloud:readCleanup', 'pointcloud:writeCleanup']);
  });

  it('reads no recipes, then every valid one, skipping damaged files and noise records', async () => {
    expect(await ipc.call('pointcloud:readCleanup', { projectId: 'p' })).toEqual({
      ok: true,
      recipes: [],
      readOnly: false,
    });
    await put(
      'edits/pointcloud/a.json',
      JSON.stringify({ ...emptyCleanup('a'), hiddenClasses: [7] }),
    );
    await put('edits/pointcloud/b.json', '{ not json');
    await put('edits/pointcloud/c.json', JSON.stringify(emptyCleanup('other'))); // wrong layer
    await put(noiseRunPath('a', 'j1'), JSON.stringify(run('a', 'j1')));
    const r = await ipc.call('pointcloud:readCleanup', { projectId: 'p' });
    expect(r.ok && r.recipes.map((x) => x.layerId)).toEqual(['a']);
  });

  it('reads the record of a noise run, or null', async () => {
    await put(noiseRunPath('a', 'j1'), JSON.stringify(run('a', 'j1')));
    const r = await ipc.call('pointcloud:readCleanup', {
      projectId: 'p',
      noiseRun: { layerId: 'a', runId: 'j1' },
    });
    expect(r.ok && r.noise?.marked).toBe(60);
    const none = await ipc.call('pointcloud:readCleanup', {
      projectId: 'p',
      noiseRun: { layerId: 'a', runId: 'j2' },
    });
    expect(none.ok && none.noise).toBeNull();
  });

  it('writes a recipe atomically with a .bak of the one before', async () => {
    const first = emptyCleanup('a');
    expect(
      await ipc.call('pointcloud:writeCleanup', { projectId: 'p', layerId: 'a', recipe: first }),
    ).toEqual({
      ok: true,
      trashed: [],
    });
    const second: PointcloudCleanup = { ...first, hiddenClasses: [7] };
    await ipc.call('pointcloud:writeCleanup', { projectId: 'p', layerId: 'a', recipe: second });
    const path = join(root, 'edits', 'pointcloud', 'a.json');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(second);
    expect(JSON.parse(await readFile(`${path}.bak`, 'utf8'))).toEqual(first);
  });

  it('refuses a recipe of another layer, an unsafe layer id and a package', async () => {
    const other = await ipc.call('pointcloud:writeCleanup', {
      projectId: 'p',
      layerId: 'a',
      recipe: emptyCleanup('b'),
    });
    expect(other.ok).toBe(false);
    const unsafe = await ipc.call('pointcloud:writeCleanup', {
      projectId: 'p',
      layerId: '../a',
      recipe: emptyCleanup('../a'),
    });
    expect(unsafe.ok).toBe(false);
    const pkg = await ipc.call('pointcloud:writeCleanup', {
      projectId: 'pkg',
      layerId: 'a',
      recipe: emptyCleanup('a'),
    });
    expect(pkg).toMatchObject({ ok: false });
  });

  it('keeps copies the history still names and trashes the others', async () => {
    await put(noiseCopyPath('a', 'j1'), 'copc 1');
    await put(noiseRunPath('a', 'j1'), JSON.stringify(run('a', 'j1')));
    await put(noiseCopyPath('a', 'j2'), 'copc 2');
    await put(noiseRunPath('a', 'j2'), JSON.stringify(run('a', 'j2')));
    await put(noiseCopyPath('b', 'j3'), 'another layer');
    const recipe = { ...emptyCleanup('a'), noise: run('a', 'j2') };
    const r = await ipc.call('pointcloud:writeCleanup', {
      projectId: 'p',
      layerId: 'a',
      recipe,
      keep: [],
    });
    expect(r).toEqual({
      ok: true,
      trashed: [noiseCopyPath('a', 'j1'), noiseRunPath('a', 'j1')],
    });
    expect(existsSync(join(root, noiseCopyPath('a', 'j1')))).toBe(false);
    expect(existsSync(join(root, noiseCopyPath('a', 'j2')))).toBe(true);
    expect(existsSync(join(root, noiseCopyPath('b', 'j3')))).toBe(true);
    const trash = await readdir(join(root, '.trash'));
    expect(trash).toHaveLength(1);
    // undo of the noise run: j2 is no longer in the recipe, but redo still names it
    const undone = await ipc.call('pointcloud:writeCleanup', {
      projectId: 'p',
      layerId: 'a',
      recipe: emptyCleanup('a'),
      keep: [noiseCopyPath('a', 'j2')],
    });
    expect(undone).toEqual({ ok: true, trashed: [] });
  });

  it("a null recipe removes the file, keeps a .bak and trashes the layer's noise copies", async () => {
    await put('edits/pointcloud/a.json', JSON.stringify(emptyCleanup('a')));
    await put(noiseCopyPath('a', 'j1'), 'copc 1');
    const r = await ipc.call('pointcloud:writeCleanup', {
      projectId: 'p',
      layerId: 'a',
      recipe: null,
    });
    expect(r).toEqual({ ok: true, trashed: [noiseCopyPath('a', 'j1')] });
    expect(existsSync(join(root, 'edits', 'pointcloud', 'a.json'))).toBe(false);
    expect(existsSync(join(root, 'edits', 'pointcloud', 'a.json.bak'))).toBe(true);
  });

  it('reads the recipes of a package and calls it read-only', async () => {
    archive.set('edits/pointcloud/a.json', Buffer.from(JSON.stringify(emptyCleanup('a'))));
    const r = await ipc.call('pointcloud:readCleanup', { projectId: 'pkg' });
    expect(r).toEqual({ ok: true, recipes: [emptyCleanup('a')], readOnly: true });
  });
});

describe('the pack gate', () => {
  it('refuses pointcloud.clean on an older pack only', () => {
    expect(cleanPackRefusal('pointcloud.clean', '0.9.0')).toMatch(
      /needs processing tools 0\.1[01]\.0 or later \(these are 0\.9\.0\)/,
    );
    expect(cleanPackRefusal('pointcloud.clean', '0.11.0')).toBeNull();
    expect(cleanPackRefusal('pointcloud.clean', 'dev')).toBeNull();
    expect(cleanPackRefusal('pointcloud.clean', null)).toBeNull();
    expect(cleanPackRefusal('pointcloud.to_copc', '0.9.0')).toBeNull();
  });
});
```

`packages/project/src/builder/removePlan.test.ts`, inside `describe('planRemoval', ...)`:

```ts
it('keeps a cleaned copy when the cloud it came from is removed', async () => {
  const cloud = (id: string, extra: Partial<Layer> = {}): Layer =>
    ({
      kind: 'pointcloud',
      id,
      name: id,
      visible: true,
      src: { path: `clouds/${id}.copc.laz` },
      format: 'copc',
      ...extra,
    }) as Layer;
  await put('clouds/scan.copc.laz');
  await put('clouds/scan-cleaned.copc.laz');
  await addLayers(
    cloud('scan'),
    cloud('scan-cleaned', { derived: { kind: 'cleanup', source: ['scan'], runId: 'j1' } }),
  );
  const p = await planRemoval(root, [{ layer: 'scan' }], { jobs: [] });
  expect(ids(p.layers)).toEqual(['scan']);
  expect(p.files).not.toContain('clouds/scan-cleaned.copc.laz');
});
```

(the existing first test keeps covering the cascade of change layers.)

`apps/desktop/src/renderer/change/producers/cloud.test.ts`:

```ts
it('pairs a cleaned copy like an imported cloud, but not a change cloud', () => {
  const plain = {
    kind: 'pointcloud',
    id: 'a',
    name: 'Scan',
    visible: true,
    src: { path: 'clouds/a.copc.laz' },
    format: 'copc',
  } as Layer;
  const cleaned = {
    ...plain,
    id: 'b',
    name: 'Scan (cleaned)',
    derived: { kind: 'cleanup', source: ['b0'], runId: 'j1' },
  } as Layer;
  const change = { ...plain, id: 'c', derived: { kind: 'change' } } as Layer;
  const ctx = {
    from: 'd1',
    to: 'd2',
    layersFrom: [plain],
    layersTo: [cleaned],
  } as unknown as ChangePairContext;
  expect(cloudPair(ctx)).toEqual({ from: plain, to: cleaned });
  expect(cloudPair({ ...ctx, layersTo: [change] } as unknown as ChangePairContext)).toBe(
    'Each date needs a point cloud of its own.',
  );
});
```

(import `ChangePairContext` from `@aio/change` and `Layer` from `@aio/schema` if the file does not yet; match the context's real fields in `@aio/change`.)

`apps/desktop/src/main/journal.test.ts`: a case "journals a cleanup recipe write as one op" that wraps `pointcloud:writeCleanup` the way the `tilesets:write` case of the "M10 tilesets, ground control and runs" block does (`journal.test.ts` ~line 462: `s.journal.wrap(channel, handler)`, write, read the appended ops), writes a recipe and expects one labelled `record.external` op for `edits/pointcloud/a.json` ("Point cloud cleanup edited").

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run apps/desktop/src/main/pointcloudCleanup.test.ts packages/project/src/builder/removePlan.test.ts apps/desktop/src/renderer/change/producers/cloud.test.ts apps/desktop/src/main/journal.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `pointcloudCleanup.ts`**

```ts
/**
 * Point cloud cleanup recipes (`edits/pointcloud/<layer>.json`, `aio.pccleanup/1`; spec
 * docs/plans/2026-10-15-pointcloud-cleanup-design.md):
 * - `pointcloud:readCleanup`: every valid recipe (a damaged or foreign file is skipped with a
 *   warning), and the record of one noise run when asked; packages read from the archive;
 * - `pointcloud:writeCleanup`: one layer's recipe, atomic with a `.bak`, a wrapped writer of the
 *   journal service (journal.ts); null removes it (kept as `.bak`). Noise working copies of the
 *   layer that neither the recipe nor `keep` names move to the project trash.
 * The pack gate for `pointcloud.clean` sits here too (as walks.ts and panos.ts do theirs).
 */
import {
  NoiseRun,
  PCCLEANUP_DIR,
  POINTCLOUD_CLEAN_FEATURE,
  POINTCLOUD_CLEAN_MIN_PACK,
  PointcloudCleanup,
  noiseRunPath,
  type IpcResponse,
} from '@aio/schema';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isChangedOnDisk, readJsonSeen, writeJsonSeen } from './fsutil';
import { compareVersions } from './jobs/pack';
import type { Handle } from './notYet';

const lib = () => import('@aio/project/builder');

export const CLEAN_PACK_FEATURE = {
  label: POINTCLOUD_CLEAN_FEATURE,
  minVersion: POINTCLOUD_CLEAN_MIN_PACK,
};

/** Why `jobs:start` refuses `pointcloud.clean` on the installed pack, or null. */
export function cleanPackRefusal(pipeline: string, packVersion: string | null): string | null {
  if (pipeline !== 'pointcloud.clean' || packVersion === null || packVersion === 'dev') return null;
  if (compareVersions(packVersion, POINTCLOUD_CLEAN_MIN_PACK) >= 0) return null;
  return `${POINTCLOUD_CLEAN_FEATURE} needs processing tools ${POINTCLOUD_CLEAN_MIN_PACK} or later (these are ${packVersion}). Update them in Settings, Processing tools.`;
}

/** A layer id that can name a file in edits/pointcloud. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/;
const isRecipeName = (n: string) => n.endsWith('.json') && !n.includes('.noise-');
const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function readCleanups(root: string): Promise<PointcloudCleanup[]> {
  let names: string[];
  try {
    names = (await readdir(join(root, PCCLEANUP_DIR))).filter(isRecipeName).sort();
  } catch {
    return [];
  }
  const out: PointcloudCleanup[] = [];
  for (const name of names) {
    const stem = name.slice(0, -'.json'.length);
    try {
      const r = PointcloudCleanup.safeParse(await readJsonSeen(join(root, PCCLEANUP_DIR, name)));
      if (r.success && r.data.layerId === stem) out.push(r.data);
      else
        console.warn(`${PCCLEANUP_DIR}/${name} is not a cleanup recipe of layer ${stem}; skipped.`);
    } catch (e) {
      console.warn(`${PCCLEANUP_DIR}/${name} could not be read: ${why(e)}`);
    }
  }
  return out;
}

export async function readNoiseRun(
  root: string,
  layerId: string,
  runId: string,
): Promise<NoiseRun | null> {
  if (!SAFE_ID.test(layerId)) return null;
  try {
    const r = NoiseRun.safeParse(await readJsonSeen(join(root, noiseRunPath(layerId, runId))));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export async function writeCleanup(
  root: string,
  layerId: string,
  recipe: PointcloudCleanup | null,
  keep: readonly string[],
  now: Date = new Date(),
): Promise<IpcResponse<'pointcloud:writeCleanup'>> {
  if (!SAFE_ID.test(layerId) || layerId.includes('..'))
    return { ok: false, error: `The layer id "${layerId}" cannot name a cleanup file.` };
  if (recipe && recipe.layerId !== layerId)
    return { ok: false, error: 'The cleanup belongs to another layer.' };
  const dir = join(root, PCCLEANUP_DIR);
  const file = join(dir, `${layerId}.json`);
  try {
    await mkdir(dir, { recursive: true });
    if (recipe) {
      await writeJsonSeen(file, recipe, { backup: true, name: `${PCCLEANUP_DIR}/${layerId}.json` });
    } else {
      await rm(`${file}.bak`, { force: true });
      await rename(file, `${file}.bak`).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'ENOENT') throw e;
      });
    }
  } catch (e) {
    if (isChangedOnDisk(e)) return { ok: false, error: e.message };
    return { ok: false, error: `The cleanup was not saved: ${why(e)}` };
  }
  // noise working copies (and their records) nobody names any more go to the project trash
  const named = new Set([...(recipe?.noise ? [recipe.noise.path] : []), ...keep]);
  const prefix = `${layerId}.noise-`;
  const names = (await readdir(dir)).filter((n) => n.startsWith(prefix)).sort();
  const loose = names.filter((n) => {
    const copy = n.endsWith('.json') ? n.replace(/\.json$/, '.copc.laz') : n;
    return !named.has(`${PCCLEANUP_DIR}/${copy}`);
  });
  const trashed: string[] = [];
  if (loose.length) {
    const { freeTrashEntry } = await lib();
    const slug = `pccleanup-${layerId.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    const entry = await freeTrashEntry(root, now, slug);
    await mkdir(join(entry, PCCLEANUP_DIR), { recursive: true });
    // the copy before its record, so the listing reads copy, record
    for (const n of loose.sort(
      (a, b) => Number(a.endsWith('.json')) - Number(b.endsWith('.json')) || a.localeCompare(b),
    )) {
      try {
        await rename(join(dir, n), join(entry, PCCLEANUP_DIR, n));
        trashed.push(`${PCCLEANUP_DIR}/${n}`);
      } catch (e) {
        console.warn(`${PCCLEANUP_DIR}/${n} stays: ${why(e)}`);
      }
    }
  }
  return { ok: true, trashed };
}

interface Deps {
  handle: Handle;
  projects: { root(id: string): string | undefined; package(id: string): unknown };
  projectPackage?: (
    id: string,
  ) => { entries: ReadonlyMap<string, unknown>; read(name: string): Promise<Buffer> } | undefined;
  now?: () => Date;
}

const NOT_OPEN = { ok: false as const, error: 'The project is not open.' };

export function registerPointcloudCleanupIpc(deps: Deps): void {
  const { handle, projects } = deps;

  handle('pointcloud:readCleanup', async ({ projectId, noiseRun }) => {
    if (projects.package(projectId)) {
      const archive = deps.projectPackage?.(projectId);
      const recipes: PointcloudCleanup[] = [];
      for (const name of [...(archive?.entries.keys() ?? [])].sort()) {
        if (!name.startsWith(`${PCCLEANUP_DIR}/`) || !isRecipeName(name)) continue;
        try {
          const r = PointcloudCleanup.safeParse(
            JSON.parse((await archive?.read(name))?.toString('utf8') ?? ''),
          );
          if (r.success) recipes.push(r.data);
        } catch {
          // a damaged member is skipped, as in a folder
        }
      }
      return { ok: true, recipes, readOnly: true };
    }
    const root = projects.root(projectId);
    if (root === undefined) return NOT_OPEN;
    const recipes = await readCleanups(root);
    if (!noiseRun) return { ok: true, recipes, readOnly: false };
    const noise = await readNoiseRun(root, noiseRun.layerId, noiseRun.runId);
    return { ok: true, recipes, noise, readOnly: false };
  });

  handle('pointcloud:writeCleanup', ({ projectId, layerId, recipe, keep }) => {
    if (projects.package(projectId))
      return Promise.resolve({
        ok: false as const,
        error: 'This project is a read-only package. Its cleanup cannot be changed.',
      });
    const root = projects.root(projectId);
    if (root === undefined) return Promise.resolve(NOT_OPEN);
    return writeCleanup(root, layerId, recipe, keep ?? [], deps.now?.() ?? new Date());
  });
}
```

Check the sort in the trash loop against the test's expected order (`copy j1`, then `record j1`): `Number(endsWith('.json'))` puts the `.copc.laz` first. Simplify the sort line if lint flags its length.

- [ ] **Step 4: Register, gate and journal**

`apps/desktop/src/main/index.ts`:

```ts
// with the other module imports (near panos)
import {
  CLEAN_PACK_FEATURE,
  cleanPackRefusal,
  registerPointcloudCleanupIpc,
} from './pointcloudCleanup';

// jobs:start, line 1285
walkPackRefusal(req.pipeline, version) ??
  panoPackRefusal(req.pipeline, version) ??
  cleanPackRefusal(req.pipeline, version);

// pack features, after PANO_PACK_FEATURE (line 1812)
(CLEAN_PACK_FEATURE,
  // after registerSurveyHaulIpc({ handle, ...survey });
  registerPointcloudCleanupIpc({
    handle,
    projects: registry,
    projectPackage: (id) => registry.package(id)?.archive,
  }));
```

`apps/desktop/src/main/journal.ts`, in `WRITERS` after `'survey:writeTerrainEdits'`:

```ts
  // point cloud cleanup: one record.external op per step of the recipe (null removes the file)
  'pointcloud:writeCleanup': (r: IpcRequest<'pointcloud:writeCleanup'>) => ({
    projectId: r.projectId,
    rel: `edits/pointcloud/${r.layerId}.json`,
    after: r.recipe,
    commands: [{ label: 'Point cloud cleanup edited', ids: ['file'] }],
  }),
```

and add `'pointcloud:readCleanup'` to the `READS` set.

- [ ] **Step 5: A cleaned copy outlives its source and can be compared**

`packages/project/src/builder/removePlan.ts`, the loop at line 409:

```ts
for (const l of m.layers) {
  const d = l.derived;
  if (d?.changeId && changeWhy.has(d.changeId) && take(l.id, { madeBy: d.changeId })) grew = true;
  // a cleaned copy is a cloud of its own: removing the cloud it came from keeps it
  if (d?.kind === 'cleanup') continue;
  const src = d?.source?.find((s) => layerWhy.has(s));
  if (src !== undefined && take(l.id, { usedBy: src })) grew = true;
}
```

`apps/desktop/src/renderer/change/producers/cloud.ts:68`:

```ts
/** Clouds a person brought in (imported, or a cleaned copy of one); not change results. */
const isCloud = (l: Layer): l is CloudLayer =>
  l.kind === 'pointcloud' && (!l.derived || l.derived.kind === 'cleanup') && !l.scalar;
```

- [ ] **Step 6: Run the tests**

Run: `pnpm exec vitest run apps/desktop/src/main/pointcloudCleanup.test.ts packages/project/src/builder/removePlan.test.ts apps/desktop/src/renderer/change/producers/cloud.test.ts apps/desktop/src/main/journal.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/main/pointcloudCleanup.ts apps/desktop/src/main/pointcloudCleanup.test.ts apps/desktop/src/main/index.ts apps/desktop/src/main/journal.ts apps/desktop/src/main/journal.test.ts packages/project/src/builder/removePlan.ts packages/project/src/builder/removePlan.test.ts apps/desktop/src/renderer/change/producers/cloud.ts apps/desktop/src/renderer/change/producers/cloud.test.ts
git commit -m "feat(desktop): cleanup recipe channels, journal writer and pack gate"
```

---

### Task 10: Renderer cleanup store and undo history

**Packages touched:** desktop renderer.
**Contract change:** no. **E2E:** through Task 17.

**Files:**

- Create: `apps/desktop/src/renderer/pointcloud/cleanupHistory.ts`
- Create: `apps/desktop/src/renderer/pointcloud/cleanupHistory.test.ts`
- Create: `apps/desktop/src/renderer/pointcloud/cleanupStore.ts`
- Create: `apps/desktop/src/renderer/pointcloud/cleanupStore.test.ts`

**Interfaces:**

- Consumes: Task 1 (`PointcloudCleanup`, `CleanupRegion`, `Layer`, IPC types); Task 3 (`pointcloudCleanup`, `CleanupRecipes`); `bridge` (`../shell`, `Bridge['call']` returns `Res<IpcResponse<C>>`).
- Produces:
  - `cleanupHistory.ts`: `HISTORY_CAP = 50`; `type Recipe = PointcloudCleanup | null`; `interface History { past: Recipe[]; present: Recipe; future: Recipe[] }`; `initial(present: Recipe): History`; `push(h: History, next: Recipe): History` (same object when nothing changes); `undo(h: History): History | null`; `redo(h: History): History | null`; `referencedCopies(h: History): string[]`
  - `cleanupStore.ts`:
    - `isCleanable(l: Layer): boolean` (a COPC point cloud layer)
    - `type NoticeKind = 'hidden' | 'deleted' | 'classSet' | 'noise' | 'reset'`
    - `interface CleanupNotice { text: string; undo: boolean; error: boolean; layerId: string | null; at: number }`
    - `interface PendingSelection { layerId: string; shape: 'box' | 'lasso'; polygon: [number, number][]; viewProj: number[]; count: number }` (`viewProj` world to clip)
    - `interface CleanupState { projectId: string | null; readOnly: boolean; layers: Record<string, History>; active: string | null; panelOpen: boolean; section: 'noise' | 'save' | null; selectShape: 'box' | 'lasso'; pending: PendingSelection | null; busy: 'noise' | 'save' | null; notice: CleanupNotice | null }`
    - `createCleanup(deps: { call: Bridge['call']; recipes: StoreApi<CleanupRecipes>; now?: () => number })` returning `{ store, load, commit, preview, undo, redo, reset, recipeOf, setActive, openPanel, closePanel, setShape, setPending, setBusy, notify, dismiss }` with
      - `load(projectId: string, layers: readonly Layer[]): Promise<void>`
      - `recipeOf(layerId: string): PointcloudCleanup | null` (the present recipe)
      - `commit(layerId: string, next: PointcloudCleanup | null, notice?: { kind: NoticeKind; name?: string; count?: number }): Promise<boolean>`
      - `preview(layerId: string, recipe: PointcloudCleanup | null): void` (live, no step, no write)
      - `undo(layerId?: string): Promise<boolean>`, `redo(layerId?: string): Promise<boolean>`, `reset(layerId: string): Promise<boolean>`
      - `setActive(id: string | null)`, `openPanel(layerId?: string, section?: 'noise' | 'save')`, `closePanel()`, `setShape(s)`, `setPending(p | null)`, `setBusy(b)`, `notify(n: Omit<CleanupNotice, 'at'>)`, `dismiss()`
    - `cleanup` (the app's instance over `bridge` and `pointcloudCleanup`) and `useCleanup<T>(selector: (s: CleanupState) => T): T`

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/src/renderer/pointcloud/cleanupHistory.test.ts`:

```ts
import { emptyCleanup, noiseCopyPath } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { HISTORY_CAP, initial, push, redo, referencedCopies, undo } from './cleanupHistory';

const r = (n: number) => ({ ...emptyCleanup('a'), hiddenClasses: [n] });

describe('cleanup history', () => {
  it('pushes, undoes and redoes snapshots', () => {
    let h = initial(null);
    h = push(h, r(1));
    h = push(h, r(2));
    expect(h.present).toEqual(r(2));
    const u = undo(h);
    expect(u?.present).toEqual(r(1));
    const back = u && redo(u);
    expect(back?.present).toEqual(r(2));
    expect(undo(initial(null))).toBeNull();
    expect(redo(h)).toBeNull();
  });

  it('a new step drops the redo steps; the same recipe again is no step', () => {
    const h = push(push(initial(null), r(1)), r(2));
    const u = undo(h);
    if (!u) throw new Error('no undo');
    const n = push(u, r(3));
    expect(n.future).toEqual([]);
    expect(push(n, r(3))).toBe(n);
  });

  it('keeps at most 50 steps back', () => {
    let h = initial(null);
    for (let i = 0; i < 80; i++) h = push(h, r(i));
    expect(h.past).toHaveLength(HISTORY_CAP);
    expect(h.past[0]).toEqual(r(29));
  });

  it('names every noise copy the history holds', () => {
    const noise = (id: string) => ({
      path: noiseCopyPath('a', id),
      params: { outlier: { meanK: 8, multiplier: 2 } },
      marked: 1,
      total: 2,
      runId: id,
    });
    let h = push(initial(null), { ...emptyCleanup('a'), noise: noise('j1') });
    h = push(h, { ...emptyCleanup('a'), noise: noise('j2') });
    const u = undo(h);
    expect(u && referencedCopies(u).sort()).toEqual([
      noiseCopyPath('a', 'j1'),
      noiseCopyPath('a', 'j2'),
    ]);
  });
});
```

Create `apps/desktop/src/renderer/pointcloud/cleanupStore.test.ts`:

```ts
import { createCleanupRecipes } from '@aio/pointcloud';
import { emptyCleanup, type Layer, type PointcloudCleanup } from '@aio/schema';
import { describe, expect, it, vi } from 'vitest';
import { createCleanup, isCleanable } from './cleanupStore';

const cloud = (id: string, format: 'copc' | 'png-packed' = 'copc'): Layer =>
  ({
    kind: 'pointcloud',
    id,
    name: id,
    visible: true,
    src: { path: `clouds/${id}` },
    format,
  }) as Layer;

function setup(
  recipes: PointcloudCleanup[] = [],
  opts: { readOnly?: boolean; fail?: boolean } = {},
) {
  const writes: { layerId: string; recipe: PointcloudCleanup | null; keep?: string[] }[] = [];
  const call = vi.fn((channel: string, req: unknown) => {
    if (channel === 'pointcloud:readCleanup')
      return Promise.resolve({
        ok: true,
        value: { ok: true, recipes, readOnly: opts.readOnly ?? false },
      });
    if (channel === 'pointcloud:writeCleanup') {
      writes.push(req as (typeof writes)[number]);
      return Promise.resolve(
        opts.fail
          ? { ok: true, value: { ok: false, error: 'disk full' } }
          : { ok: true, value: { ok: true, trashed: [] } },
      );
    }
    return Promise.resolve({ ok: false, error: `unexpected ${channel}` });
  });
  const live = createCleanupRecipes();
  const c = createCleanup({ call: call as never, recipes: live, now: () => 1 });
  return { c, live, writes, call };
}

describe('the cleanup store', () => {
  it('knows which layers can be cleaned up', () => {
    expect(isCleanable(cloud('a'))).toBe(true);
    expect(isCleanable(cloud('b', 'png-packed'))).toBe(false);
  });

  it('load sweeps recipes whose layer is gone', async () => {
    const s = setup([emptyCleanup('a'), emptyCleanup('gone'), emptyCleanup('png')]);
    await s.c.load('p', [cloud('a'), cloud('png', 'png-packed')]);
    expect(Object.keys(s.c.store.getState().layers)).toEqual(['a']);
    expect(s.live.getState().recipes.a).toEqual(emptyCleanup('a'));
    // the recipe of a deleted layer is removed; a png-packed cloud's is only ignored
    expect(s.writes).toEqual([{ projectId: 'p', layerId: 'gone', recipe: null }]);
  });

  it('commits a step, shows it live and writes it; undo and redo write back', async () => {
    const s = setup();
    await s.c.load('p', [cloud('a')]);
    const r1 = { ...emptyCleanup('a'), hiddenClasses: [7] };
    expect(await s.c.commit('a', r1, { kind: 'reset' })).toBe(true);
    expect(s.live.getState().recipes.a).toEqual(r1);
    expect(s.c.store.getState().notice).toMatchObject({ undo: true, error: false, layerId: 'a' });
    expect(await s.c.undo('a')).toBe(true);
    expect(s.live.getState().recipes.a).toBeUndefined();
    expect(await s.c.redo('a')).toBe(true);
    expect(s.writes.map((w) => w.recipe)).toEqual([r1, null, r1]);
  });

  it('keeps the step out when the write fails, and says why', async () => {
    const s = setup([], { fail: true });
    await s.c.load('p', [cloud('a')]);
    expect(await s.c.commit('a', emptyCleanup('a'))).toBe(false);
    expect(s.c.recipeOf('a')).toBeNull();
    expect(s.live.getState().recipes.a).toBeUndefined();
    expect(s.c.store.getState().notice).toMatchObject({ error: true });
    expect(s.c.store.getState().notice?.text).toContain('disk full');
  });

  it("writes one layer's steps in order", async () => {
    const s = setup();
    await s.c.load('p', [cloud('a')]);
    let release: () => void = () => undefined;
    const order: string[] = [];
    s.call.mockImplementation((channel: string, req: unknown) => {
      if (channel !== 'pointcloud:writeCleanup') return Promise.resolve({ ok: false, error: 'x' });
      const r = (req as { recipe: PointcloudCleanup }).recipe;
      order.push(`start ${String(r.hiddenClasses[0])}`);
      const done = () => {
        order.push(`end ${String(r.hiddenClasses[0])}`);
        return { ok: true, value: { ok: true, trashed: [] } };
      };
      return r.hiddenClasses[0] === 1
        ? new Promise((res) => {
            release = () => res(done());
          })
        : Promise.resolve(done());
    });
    const a = s.c.commit('a', { ...emptyCleanup('a'), hiddenClasses: [1] });
    const b = s.c.commit('a', { ...emptyCleanup('a'), hiddenClasses: [2] });
    await Promise.resolve();
    release();
    await Promise.all([a, b]);
    expect(order).toEqual(['start 1', 'end 1', 'start 2', 'end 2']);
  });

  it('previews live without a step or a write', async () => {
    const s = setup();
    await s.c.load('p', [cloud('a')]);
    s.c.preview('a', { ...emptyCleanup('a'), hiddenClasses: [3] });
    expect(s.live.getState().recipes.a?.hiddenClasses).toEqual([3]);
    expect(s.c.recipeOf('a')).toBeNull();
    expect(s.writes).toEqual([]);
  });

  it('refuses steps in a read-only package', async () => {
    const s = setup([emptyCleanup('a')], { readOnly: true });
    await s.c.load('pkg', [cloud('a')]);
    expect(await s.c.commit('a', null)).toBe(false);
    expect(s.writes).toEqual([]);
  });

  it('opens the panel on a layer and a section', () => {
    const s = setup();
    s.c.openPanel('a', 'noise');
    expect(s.c.store.getState()).toMatchObject({ panelOpen: true, active: 'a', section: 'noise' });
    s.c.closePanel();
    expect(s.c.store.getState().panelOpen).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run apps/desktop/src/renderer/pointcloud/cleanupHistory.test.ts apps/desktop/src/renderer/pointcloud/cleanupStore.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `cleanupHistory.ts`**

```ts
/** Undo history of one layer's cleanup recipe: whole snapshots, 50 steps back (spec section 2). */
import type { PointcloudCleanup } from '@aio/schema';

export const HISTORY_CAP = 50;
export type Recipe = PointcloudCleanup | null;
export interface History {
  past: Recipe[];
  present: Recipe;
  future: Recipe[];
}

const same = (a: Recipe, b: Recipe) => JSON.stringify(a) === JSON.stringify(b);

export const initial = (present: Recipe): History => ({ past: [], present, future: [] });

export function push(h: History, next: Recipe): History {
  if (same(h.present, next)) return h;
  return { past: [...h.past, h.present].slice(-HISTORY_CAP), present: next, future: [] };
}

export function undo(h: History): History | null {
  if (h.past.length === 0) return null;
  const prev = h.past[h.past.length - 1] ?? null;
  return { past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future] };
}

export function redo(h: History): History | null {
  if (h.future.length === 0) return null;
  const [next = null, ...rest] = h.future;
  return { past: [...h.past, h.present].slice(-HISTORY_CAP), present: next, future: rest };
}

/** Noise working copies any step names: main must not trash them (`pointcloud:writeCleanup` keep). */
export function referencedCopies(h: History): string[] {
  const out = new Set<string>();
  for (const r of [...h.past, h.present, ...h.future]) if (r?.noise) out.add(r.noise.path);
  return [...out];
}
```

- [ ] **Step 4: Write `cleanupStore.ts`**

```ts
/**
 * The open project's point cloud cleanup (spec sections 2 and 5): one undo history per layer, the
 * Clean up panel's state, and the notice with Undo. Every step is written through
 * `pointcloud:writeCleanup` (one write at a time per layer); the present recipe is pushed to the
 * viewer's live store (`@aio/pointcloud` `pointcloudCleanup`). A failed write takes the step back
 * and the notice says why.
 */
import { pointcloudCleanup, type CleanupRecipes } from '@aio/pointcloud';
import type { Layer, PointcloudCleanup } from '@aio/schema';
import { t } from '@aio/ui';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { Bridge } from '../bridge';
import { bridge } from '../shell';
import { initial, push, redo, referencedCopies, undo, type History } from './cleanupHistory';

export const isCleanable = (l: Layer): boolean => l.kind === 'pointcloud' && l.format === 'copc';

export type NoticeKind = 'hidden' | 'deleted' | 'classSet' | 'noise' | 'reset';

export interface CleanupNotice {
  text: string;
  undo: boolean;
  error: boolean;
  layerId: string | null;
  at: number;
}

export interface PendingSelection {
  layerId: string;
  shape: 'box' | 'lasso';
  polygon: [number, number][];
  /** World to clip (cleanupFrame.ts `worldViewProj`). */
  viewProj: number[];
  count: number;
}

export interface CleanupState {
  projectId: string | null;
  readOnly: boolean;
  layers: Record<string, History>;
  active: string | null;
  panelOpen: boolean;
  section: 'noise' | 'save' | null;
  selectShape: 'box' | 'lasso';
  pending: PendingSelection | null;
  busy: 'noise' | 'save' | null;
  notice: CleanupNotice | null;
}

interface Deps {
  call: Bridge['call'];
  recipes: StoreApi<CleanupRecipes>;
  now?: () => number;
}

function noticeText(n: { kind: NoticeKind; name?: string; count?: number }): string {
  switch (n.kind) {
    case 'hidden':
      return t('cleanup.notice.hidden');
    case 'deleted':
      return t('cleanup.notice.deleted');
    case 'classSet':
      return t('cleanup.notice.classSet', { name: n.name ?? '' });
    case 'noise':
      return t('cleanup.notice.noise', { count: n.count ?? 0 });
    case 'reset':
      return t('cleanup.notice.reset');
  }
}

export function createCleanup(deps: Deps) {
  const now = deps.now ?? (() => Date.now());
  const store = createStore<CleanupState>()(() => ({
    projectId: null,
    readOnly: false,
    layers: {},
    active: null,
    panelOpen: false,
    section: null,
    selectShape: 'box',
    pending: null,
    busy: null,
    notice: null,
  }));
  /** One write at a time per layer, in the order the steps were made. */
  const queues = new Map<string, Promise<unknown>>();

  const notify = (n: Omit<CleanupNotice, 'at'>) => {
    store.setState({ notice: { ...n, at: now() } });
  };
  const fail = (layerId: string | null, error: string) => {
    notify({ text: t('cleanup.notice.error', { error }), undo: false, error: true, layerId });
  };
  const show = (layerId: string, h: History) => {
    store.setState((s) => ({ layers: { ...s.layers, [layerId]: h } }));
    deps.recipes.getState().set(layerId, h.present);
  };
  const write = (layerId: string, h: History): Promise<string | null> => {
    const projectId = store.getState().projectId;
    if (!projectId) return Promise.resolve('No project is open.');
    const run = async (): Promise<string | null> => {
      const r = await deps.call('pointcloud:writeCleanup', {
        projectId,
        layerId,
        recipe: h.present,
        keep: referencedCopies(h),
      });
      if (!r.ok) return r.error;
      return r.value.ok ? null : r.value.error;
    };
    const next = (queues.get(layerId) ?? Promise.resolve()).then(run, run);
    queues.set(layerId, next);
    return next;
  };
  /** Show `next`, write it; on a refusal show `back` again. */
  const step = async (layerId: string, back: History, next: History): Promise<boolean> => {
    show(layerId, next);
    const error = await write(layerId, next);
    if (error === null) return true;
    if (store.getState().layers[layerId] === next) show(layerId, back);
    fail(layerId, error);
    return false;
  };
  const historyOf = (layerId: string) => store.getState().layers[layerId] ?? initial(null);
  const writable = () => {
    const s = store.getState();
    return s.projectId !== null && !s.readOnly;
  };

  return {
    store,
    notify,
    recipeOf: (layerId: string) => store.getState().layers[layerId]?.present ?? null,

    async load(projectId: string, layers: readonly Layer[]): Promise<void> {
      store.setState({
        projectId,
        readOnly: false,
        layers: {},
        active: null,
        pending: null,
        busy: null,
        notice: null,
      });
      deps.recipes.getState().clear();
      const r = await deps.call('pointcloud:readCleanup', { projectId });
      if (store.getState().projectId !== projectId) return; // another project opened meanwhile
      if (!r.ok || !r.value.ok) {
        fail(null, r.ok ? (r.value.ok ? '' : r.value.error) : r.error);
        return;
      }
      const { recipes, readOnly } = r.value;
      const ids = new Set(layers.filter(isCleanable).map((l) => l.id));
      const known = new Set(layers.map((l) => l.id));
      const next: Record<string, History> = {};
      for (const recipe of recipes) {
        if (ids.has(recipe.layerId)) {
          next[recipe.layerId] = initial(recipe);
          deps.recipes.getState().set(recipe.layerId, recipe);
        } else if (!known.has(recipe.layerId) && !readOnly) {
          // its layer was deleted: remove the recipe (kept as .bak) and trash its noise copies
          void deps.call('pointcloud:writeCleanup', {
            projectId,
            layerId: recipe.layerId,
            recipe: null,
          });
        }
      }
      store.setState({ layers: next, readOnly });
    },

    async commit(
      layerId: string,
      next: PointcloudCleanup | null,
      notice?: { kind: NoticeKind; name?: string; count?: number },
    ): Promise<boolean> {
      if (!writable()) return false;
      const h = historyOf(layerId);
      const n = push(h, next);
      if (n === h) return true;
      const ok = await step(layerId, h, n);
      if (ok && notice) notify({ text: noticeText(notice), undo: true, error: false, layerId });
      return ok;
    },

    preview(layerId: string, recipe: PointcloudCleanup | null): void {
      deps.recipes.getState().set(layerId, recipe);
    },

    async undo(layerId?: string): Promise<boolean> {
      const id = layerId ?? store.getState().active;
      if (!id || !writable()) return false;
      const h = historyOf(id);
      const u = undo(h);
      return u ? step(id, h, u) : false;
    },

    async redo(layerId?: string): Promise<boolean> {
      const id = layerId ?? store.getState().active;
      if (!id || !writable()) return false;
      const h = historyOf(id);
      const r = redo(h);
      return r ? step(id, h, r) : false;
    },

    async reset(layerId: string): Promise<boolean> {
      if (!writable()) return false;
      const h = historyOf(layerId);
      const n = push(h, null);
      if (n === h) return true;
      const ok = await step(layerId, h, n);
      if (ok) notify({ text: noticeText({ kind: 'reset' }), undo: true, error: false, layerId });
      return ok;
    },

    setActive: (id: string | null) => {
      store.setState({ active: id, pending: null });
    },
    openPanel: (layerId?: string, section?: 'noise' | 'save') => {
      store.setState((s) => ({
        panelOpen: true,
        active: layerId ?? s.active,
        section: section ?? null,
      }));
    },
    closePanel: () => {
      store.setState({ panelOpen: false, pending: null, section: null });
    },
    setShape: (selectShape: 'box' | 'lasso') => {
      store.setState({ selectShape });
    },
    setPending: (pending: PendingSelection | null) => {
      store.setState({ pending });
    },
    setBusy: (busy: 'noise' | 'save' | null) => {
      store.setState({ busy });
    },
    dismiss: () => {
      store.setState({ notice: null });
    },
  };
}

export type Cleanup = ReturnType<typeof createCleanup>;

export const cleanup: Cleanup = createCleanup({
  call: (channel, req) => bridge.call(channel, req),
  recipes: pointcloudCleanup,
});

export function useCleanup<T>(selector: (s: CleanupState) => T): T {
  return useStore(cleanup.store, selector);
}
```

`reset` uses the `reset` notice; `commit` callers in Task 14 pass `{ kind: 'deleted' }`, `{ kind: 'classSet', name }`, `{ kind: 'noise', count }`, and no notice for box, height, hide-class toggles and the hide selection's own step when the spec gives it none (the spec asks for the Undo notice after delete, set class, noise and reset; `hidden` exists for the hide selection and Task 14 uses it). `load` is called by Task 15 whenever the open project changes (and after a manifest reload, so a cleaned copy's layer list is current).

- [ ] **Step 5: Run the tests**

Run: `pnpm exec vitest run apps/desktop/src/renderer/pointcloud/cleanupHistory.test.ts apps/desktop/src/renderer/pointcloud/cleanupStore.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/pointcloud/cleanupHistory.ts apps/desktop/src/renderer/pointcloud/cleanupHistory.test.ts apps/desktop/src/renderer/pointcloud/cleanupStore.ts apps/desktop/src/renderer/pointcloud/cleanupStore.test.ts
git commit -m "feat(desktop): point cloud cleanup store with undo history"
```

---

### Task 11: `pointcloud.clean`, noise mode

**Packages touched:** `python/` (`aio_pipelines.pointcloud_cleanup`, `pipelines.py`).
**Contract change:** implements row 3 (mode `noise`). **E2E:** `pointcloud-noise.spec.ts` (Task 17).

**Files:**

- Create: `python/src/aio_pipelines/pointcloud_cleanup/pipeline.py`
- Modify: `python/src/aio_pipelines/pipelines.py` (import and `all_pipelines` list, after `PanoStitch()`)
- Create: `python/tests/test_pccleanup_noise.py`

**Interfaces:**

- Consumes: Task 4 (`validate_recipe`, `NOISE_CLASS`, `class_histogram`); `aio_pipelines.pointcloud` (`find_pdal`, `_run`, `read_summary`, `check_space`, `PDAL_MISSING`, `DEFAULT_RECORD`, `UNTWINE_TEMP_BYTES_PER_POINT`, `COPC_BYTES_PER_POINT`); `aio_pipelines.photo.cloud_out.write_copc`, `aio_pipelines.photo.native.memory_budget`; `aio_pipelines.runtime` (`Step`, `StepContext`, `JobError`, `atomic_write_json`, `commit_files`, `safe_project_path`); `aio_pipelines.params` (`known_keys`, `text`, `number`).
- Produces: `class PointcloudClean` (`name = "pointcloud.clean"`, `title = "Clean up a point cloud"`), `validate(params) -> dict`, `inputs(params) -> list[str]`, `plan(params) -> list[Step]`. Noise mode steps `stage`, `mark`, `write`, `commit`; `result["outputs"]["commit"]` is the `NoiseRun` record `{ path, params, marked, total, runId }`, also committed as `edits/pointcloud/<layer>.noise-<job>.json` beside the copy `edits/pointcloud/<layer>.noise-<job>.copc.laz`.

- [ ] **Step 1: Write the failing tests**

Create `python/tests/test_pccleanup_noise.py`:

```python
"""pointcloud.clean, noise mode: PDAL's statistical outlier filter (and optionally filters.elm) marks
noise as class 7 in a working copy; every other class stays; the original file is untouched."""

import hashlib
import json

import numpy as np
import pytest

from aio_pipelines.pipelines import all_pipelines
from aio_pipelines.pointcloud import find_pdal
from aio_pipelines.pointcloud_cleanup.lasstream import class_histogram
from aio_pipelines.pointcloud_cleanup.pipeline import PointcloudClean
from aio_pipelines.runtime import JobError
from conftest import run_job
from pccleanup_synth import cloud_project, copc_to_las, planted_cloud

needs_pdal = pytest.mark.skipif(find_pdal() is None, reason="PDAL not found (set AIO_PDAL)")
SRC = "clouds/cloud-a.copc.laz"
NOISE = {"mode": "noise", "layerId": "cloud-a", "src": SRC, "outlier": {"meanK": 8, "multiplier": 2.0}}


def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def test_is_registered():
    assert isinstance(all_pipelines()["pointcloud.clean"], PointcloudClean)


@pytest.mark.parametrize(
    "params, message",
    [
        ({**NOISE, "mode": "paint"}, "noise or save"),
        ({**NOISE, "extra": 1}, "does not take: extra"),
        ({**NOISE, "outlier": {"meanK": 1, "multiplier": 2}}, "meanK"),
        ({**NOISE, "outlier": {"meanK": 8, "multiplier": 20}}, "multiplier"),
        ({**NOISE, "src": "../x.copc.laz"}, "inside the project"),
        ({**NOISE, "elm": {"cell": 0, "threshold": 1}}, "cell"),
    ],
)
def test_validate_refuses(params, message):
    with pytest.raises(JobError, match=message):
        PointcloudClean().validate(params)


@needs_pdal
def test_marks_the_planted_outliers_and_keeps_every_other_class(tmp_path):
    xyz, cls, outlier = planted_cloud()
    root = cloud_project(tmp_path, xyz, cls)
    before = sha(root / SRC)
    result, _ = run_job(PointcloudClean(), root, NOISE, job_id="j-noise")
    record = result["outputs"]["commit"]
    assert record["path"] == "edits/pointcloud/cloud-a.noise-j-noise.copc.laz"
    assert record["runId"] == "j-noise" and record["total"] == len(xyz)
    assert json.loads((root / "edits/pointcloud/cloud-a.noise-j-noise.json").read_text("utf-8")) == record
    assert sha(root / SRC) == before  # the original is never changed
    las = copc_to_las(root / record["path"], tmp_path / "copy.las")
    hist = class_histogram(las)
    # every planted outlier (isolated, 25 m up or 6 m under) is marked; some ground edge points may be
    assert record["marked"] == int(hist[7])
    assert int(outlier.sum()) <= record["marked"] <= int(outlier.sum()) + 0.02 * len(xyz)
    from aio_pipelines.change.las import read_las

    out = read_las(las)
    z, c = out.xyz[:, 2], out.field("Classification")
    assert np.all(c[(z > 20) | (z < -3)] == 7)
    # other classes only lose points to class 7
    orig = np.bincount(cls, minlength=256)
    for k in (1, 2, 6):
        assert hist[k] <= orig[k]
    assert hist.sum() == len(xyz)


@needs_pdal
def test_low_points_with_elm(tmp_path):
    xyz, cls, _ = planted_cloud(high=0, low=20)
    root = cloud_project(tmp_path, xyz, cls)
    params = {**NOISE, "elm": {"cell": 10, "threshold": 1.0}}
    result, _ = run_job(PointcloudClean(), root, params, job_id="j-elm")
    record = result["outputs"]["commit"]
    assert record["params"] == {"outlier": {"meanK": 8, "multiplier": 2.0}, "elm": {"cell": 10.0, "threshold": 1.0}}
    from aio_pipelines.change.las import read_las

    out = read_las(copc_to_las(root / record["path"], tmp_path / "copy.las"))
    assert np.all(out.field("Classification")[out.xyz[:, 2] < -3] == 7)


@needs_pdal
def test_a_cloud_whose_noise_is_already_class_7_gives_marked_0_and_keeps_every_other_class(tmp_path):
    xyz, cls, outlier = planted_cloud()
    cls = cls.copy()
    cls[outlier] = 7  # an earlier run marked them
    root = cloud_project(tmp_path, xyz, cls)
    # a large multiplier: only the planted (already class 7) points are outliers
    params = {**NOISE, "outlier": {"meanK": 8, "multiplier": 8.0}}
    result, _ = run_job(PointcloudClean(), root, params, job_id="j-again")
    record = result["outputs"]["commit"]
    assert record["marked"] == 0
    hist = class_histogram(copc_to_las(root / record["path"], tmp_path / "copy.las"))
    assert hist.tolist() == np.bincount(cls, minlength=256).tolist()


@needs_pdal
def test_refuses_a_layer_that_is_not_copc_or_has_moved(tmp_path):
    xyz, cls, _ = planted_cloud(ground_step=2.0, high=2, low=0)
    root = cloud_project(tmp_path, xyz, cls)
    with pytest.raises(JobError, match="file changed"):
        run_job(PointcloudClean(), root, {**NOISE, "src": "clouds/other.copc.laz"}, job_id="j-moved")
    manifest = json.loads((root / "manifest.json").read_text("utf-8"))
    manifest["layers"][0]["format"] = "png-packed"
    (root / "manifest.json").write_text(json.dumps(manifest), "utf-8")
    with pytest.raises(JobError, match="COPC"):
        run_job(PointcloudClean(), root, NOISE, job_id="j-png")
    assert not (root / "edits").exists()
```

The multiplier 8 test relies on the statistics: with only isolated planted points far from the ground, their mean neighbour distance is many standard deviations above the ground's; if PDAL marks a ground point at 8 standard deviations on this grid, raise the multiplier to 10 (the schema's maximum), not the tolerance of the other test.

- [ ] **Step 2: Run them to see them fail**

From `python/` (PowerShell, as in Task 4, with `$env:AIO_PDAL = 'E:/Dev/tools/pdal/Library/bin/pdal.exe'` so PDAL is found):

```powershell
& 'E:\Dev\AIO Software\python\.venv\Scripts\python.exe' -m pytest tests/test_pccleanup_noise.py
```

Expected: FAIL (`pipeline` module missing).

- [ ] **Step 3: Write `pipeline.py` (validation and noise mode)**

```python
"""``pointcloud.clean`` (spec docs/plans/2026-10-15-pointcloud-cleanup-design.md, section 4).

- ``mode: noise``: the layer's COPC to a staged LAS, PDAL ``filters.outlier`` (statistical) and
  optionally ``filters.elm`` set class 7 on noise (other classes untouched), then a COPC working
  copy ``edits/pointcloud/<layer>.noise-<job>.copc.laz`` and its record ``.json`` beside it
  (``NoiseRun``). The app writes the record into the layer's recipe.
- ``mode: save`` (Task 12): the recipe applied over every point, streamed, to a new layer.

The original file is never written. A cancelled job leaves only its staging folder.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

from ..params import known_keys, number, text
from ..pointcloud import (
    COPC_BYTES_PER_POINT,
    DEFAULT_RECORD,
    PDAL_MISSING,
    UNTWINE_TEMP_BYTES_PER_POINT,
    _run,
    check_space,
    find_pdal,
    read_summary,
)
from ..runtime import JobError, Step, StepContext, atomic_write_json, commit_files, safe_project_path
from .lasstream import class_histogram
from .recipe import NOISE_CLASS, validate_recipe

NOISE_DIR = "edits/pointcloud"


def _layer_id(params: dict[str, Any]) -> str:
    lid = text(params, "layerId", required=True)
    assert lid is not None
    if len(lid) > 128 or any(c in lid for c in '/\\:*?"<>|') or ".." in lid:
        raise JobError("layerId must be a layer id.")
    return lid


def _src(params: dict[str, Any]) -> str:
    src = text(params, "src", required=True)
    assert src is not None
    safe_project_path(Path("."), src)  # refuses absolute paths and ".." with a sentence
    if not src.lower().endswith(".copc.laz"):
        raise JobError("src must be the layer's COPC file.")
    return src.replace("\\", "/")


def _outlier(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise JobError("outlier needs meanK and multiplier.")
    known_keys(raw, {"meanK", "multiplier"}, "outlier")
    return {
        "meanK": number(raw, "meanK", None, 2, 64, integer=True),
        "multiplier": number(raw, "multiplier", None, 0.1, 10),
    }


def _elm(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise JobError("elm needs cell and threshold.")
    known_keys(raw, {"cell", "threshold"}, "elm")
    return {"cell": number(raw, "cell", None, 0.5, 100), "threshold": number(raw, "threshold", None, 0.1, 50)}


def _manifest(project: Path) -> tuple[Path, dict[str, Any]]:
    path = safe_project_path(project, "manifest.json")
    return path, json.loads(path.read_text("utf-8"))


def _cloud_layer(project: Path, layer_id: str, src: str) -> dict[str, Any]:
    _, manifest = _manifest(project)
    layer = next((x for x in manifest.get("layers") or [] if x.get("id") == layer_id), None)
    if layer is None:
        raise JobError(f'The layer "{layer_id}" is not in the project any more.')
    if layer.get("kind") != "pointcloud" or layer.get("format") != "copc":
        raise JobError(f'"{layer.get("name") or layer_id}" is not a COPC point cloud, so it cannot be cleaned up.')
    if (layer.get("src") or {}).get("path") != src:
        raise JobError("The layer's file changed since the job started. Start it again.")
    return layer


def _pdal() -> str:
    pdal = find_pdal()
    if not pdal:
        raise JobError(PDAL_MISSING)
    return pdal


def _las_writer(path: Path) -> dict[str, Any]:
    # forward the header (point format, scale, offset, CRS) and keep every extra dimension
    return {"type": "writers.las", "filename": str(path), "minor_version": 4, "forward": "all", "extra_dims": "all"}


def _stage_las(ctx: StepContext, pdal: str, src: Path, out: Path, band: tuple[float, float]) -> int:
    """The COPC as a staged LAS; refuses up front when the staging drive is too small. Answers the count."""
    count = int(read_summary(ctx, pdal, src).get("num_points") or 0)
    check_space(ctx.staging, count * (2 * DEFAULT_RECORD + UNTWINE_TEMP_BYTES_PER_POINT + COPC_BYTES_PER_POINT))
    pipe = ctx.stage("work/to-las.json")
    atomic_write_json(pipe, {"pipeline": [{"type": "readers.copc", "filename": str(src)}, _las_writer(out)]})
    _run(ctx, [pdal, "pipeline", str(pipe)], "Reading the cloud", band)
    return count


def _write_copc(ctx: StepContext, las: Path, out: Path, count: int, band: tuple[float, float]) -> str:
    from ..photo import cloud_out, native

    work = ctx.stage("copc-work")
    writer = cloud_out.write_copc(ctx, las, out, count, None, work, native.memory_budget(), progress=band)
    las.unlink(missing_ok=True)  # as big as the cloud: never keep it
    return writer


class PointcloudClean:
    name = "pointcloud.clean"
    title = "Clean up a point cloud"
    description = "Marks noise with PDAL outlier filters, or writes a cleaned copy of a COPC cloud as a new layer."

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        mode = params.get("mode")
        if mode == "noise":
            known_keys(params, {"mode", "layerId", "src", "outlier", "elm"}, self.name)
            out: dict[str, Any] = {
                "mode": "noise",
                "layerId": _layer_id(params),
                "src": _src(params),
                "outlier": _outlier(params.get("outlier")),
            }
            if params.get("elm") is not None:
                out["elm"] = _elm(params["elm"])
            return out
        if mode == "save":
            known_keys(params, {"mode", "layerId", "src", "recipe", "name"}, self.name)
            lid = _layer_id(params)
            name = (text(params, "name", required=True) or "").strip()
            if len(name) > 120:
                raise JobError("The name of the cleaned copy is at most 120 characters.")
            return {
                "mode": "save",
                "layerId": lid,
                "src": _src(params),
                "recipe": validate_recipe(params.get("recipe"), lid),
                "name": name,
            }
        raise JobError("mode must be noise or save.")

    def inputs(self, params: dict[str, Any]) -> list[str]:
        noise = (params.get("recipe") or {}).get("noise")
        return [params["src"], *([noise["path"]] if noise else [])]

    def plan(self, params: dict[str, Any]) -> list[Step]:
        return self._noise(params) if params["mode"] == "noise" else self._save(params)

    def _noise(self, params: dict[str, Any]) -> list[Step]:
        lid = params["layerId"]

        def stage(ctx: StepContext) -> dict[str, Any]:
            _cloud_layer(ctx.project, lid, params["src"])
            pdal = _pdal()
            src_las = ctx.stage("source.las")
            count = _stage_las(ctx, pdal, ctx.input(params["src"]), src_las, (0.02, 0.25))
            before = class_histogram(src_las)
            ctx.log(f"{count:,} points, {int(before[NOISE_CLASS]):,} already marked as noise.")
            return {"points": count, "before7": int(before[NOISE_CLASS])}

        def mark(ctx: StepContext) -> dict[str, Any]:
            pdal = _pdal()
            src_las, marked = ctx.stage("source.las"), ctx.stage("marked.las")
            o = params["outlier"]
            stages: list[Any] = [
                {"type": "readers.las", "filename": str(src_las)},
                {"type": "filters.outlier", "method": "statistical", "mean_k": o["meanK"], "multiplier": o["multiplier"]},
            ]
            if "elm" in params:
                e = params["elm"]
                stages.append({"type": "filters.elm", "cell": e["cell"], "threshold": e["threshold"]})
            stages.append(_las_writer(marked))
            pipe = ctx.stage("work/mark.json")
            atomic_write_json(pipe, {"pipeline": stages})
            _run(ctx, [pdal, "pipeline", str(pipe)], "Finding noise", (0.25, 0.6))
            after = class_histogram(marked)
            src_las.unlink(missing_ok=True)
            n = max(0, int(after[NOISE_CLASS]) - int(ctx.outputs("stage").get("before7") or 0))
            ctx.log(f"Marked {n:,} points as noise.")
            return {"marked": n, "total": int(after.sum())}

        def write(ctx: StepContext) -> dict[str, Any]:
            total = int(ctx.outputs("mark").get("total") or 0)
            writer = _write_copc(ctx, ctx.stage("marked.las"), ctx.stage("noise.copc.laz"), total, (0.6, 0.95))
            return {"writer": writer}

        def commit(ctx: StepContext) -> dict[str, Any]:
            run_id = ctx.job.job_id
            rel = f"{NOISE_DIR}/{lid}.noise-{run_id}.copc.laz"
            m = ctx.outputs("mark")
            record = {
                "path": rel,
                "params": {"outlier": params["outlier"], **({"elm": params["elm"]} if "elm" in params else {})},
                "marked": int(m["marked"]),
                "total": int(m["total"]),
                "runId": run_id,
            }
            atomic_write_json(ctx.stage("noise.json"), record)
            commit_files(ctx, [("noise.copc.laz", rel), ("noise.json", f"{NOISE_DIR}/{lid}.noise-{run_id}.json")])
            return record

        return [
            Step("stage", "Read the cloud", stage, weight=3),
            Step("mark", "Find noise", mark, weight=4),
            Step("write", "Build the working copy", write, weight=4),
            Step("commit", "Save the result", commit, weight=0.2),
        ]

    def _save(self, params: dict[str, Any]) -> list[Step]:
        raise JobError("Saving a cleaned copy comes with the next step of this plan.")  # replaced in Task 12
```

`safe_project_path(Path("."), src)` is used only for its check (it raises "must stay inside the project folder" for `..` and drive letters); `Path(".")` never leaves the call. If `ruff` flags the unused result, assign it to `_`.

`pipelines.py`: `from .pointcloud_cleanup.pipeline import PointcloudClean` and, after `PanoStitch(),`:

```python
        # Point cloud cleanup (pipeline pack POINTCLOUD_CLEAN_MIN_PACK)
        PointcloudClean(),
```

- [ ] **Step 4: Run the tests**

Same command as Step 2. Expected: PASS (validation tests always; the PDAL tests where PDAL is found). Check the import path afterwards as in Task 4 Step 7, then `ruff check` and `ruff format --check` on the new files.

- [ ] **Step 5: Commit**

```bash
git add python/src/aio_pipelines/pointcloud_cleanup/pipeline.py python/src/aio_pipelines/pipelines.py python/tests/test_pccleanup_noise.py
git commit -m "feat(pipelines): pointcloud.clean marks noise in a working copy"
```

---

### Task 12: `pointcloud.clean`, save mode

**Packages touched:** `python/`.
**Contract change:** implements rows 2 and 3 (mode `save`, the derived layer). **E2E:** `pointcloud-clean-export.spec.ts` (Task 17).

**Files:**

- Modify: `python/src/aio_pipelines/pointcloud_cleanup/pipeline.py` (`_save`)
- Create: `python/tests/test_pccleanup_save.py`

**Interfaces:**

- Consumes: Task 4 (`evaluate`, `kept_for_save`, `filter_las`); Task 11 helpers in `pipeline.py`.
- Produces: save mode steps `stage`, `apply`, `write`, `register`; `result["outputs"]["register"]` = `{ layer, path, points }`; the manifest gains `{ kind: 'pointcloud', id: '<layer>-cleaned[-n]', name: '<name> (cleaned)', visible: true, capture: <the source's>, src: { path: 'clouds/<id>.copc.laz' }, format: 'copc', pointCount, derived: { kind: 'cleanup', source: [layerId], runId: <job id> } }`; the source layer gets `visible: false`; `manifest.json.bak` is the manifest before.

- [ ] **Step 1: Write the failing tests**

Create `python/tests/test_pccleanup_save.py`:

```python
"""pointcloud.clean, save mode: the recipe over every point, streamed, written as a new COPC layer;
the original layer is hidden, its file untouched."""

import hashlib
import json

import numpy as np
import pytest

from aio_pipelines.change.las import read_las
from aio_pipelines.pointcloud import find_pdal
from aio_pipelines.pointcloud_cleanup.evaluate import evaluate, kept_for_save
from aio_pipelines.pointcloud_cleanup.pipeline import PointcloudClean
from aio_pipelines.runtime import JobError
from conftest import run_job
from pccleanup_synth import E0, N0, cloud_project, copc_to_las, planted_cloud

pytestmark = pytest.mark.skipif(find_pdal() is None, reason="PDAL not found (set AIO_PDAL)")
SRC = "clouds/cloud-a.copc.laz"

#: world to clip: ndc x = (E - E0 - 20) / 20, ndc y = (N - N0 - 20) / 20, w = 1
VP = [0.05, 0, 0, 0, 0, 0.05, 0, 0, 0, 0, 0, 0, -(E0 + 20) * 0.05, -(N0 + 20) * 0.05, 0, 1]


def recipe(**over):
    return {
        "schema": "aio.pccleanup/1",
        "layerId": "cloud-a",
        "hiddenClasses": [],
        "regions": [],
        **over,
    }


def save(root, r, job_id="j-save", name="Scan"):
    return run_job(
        PointcloudClean(),
        root,
        {"mode": "save", "layerId": "cloud-a", "src": SRC, "recipe": r, "name": name},
        job_id=job_id,
    )


def test_writes_the_cleaned_copy_as_a_new_layer_and_hides_the_original(tmp_path):
    xyz, cls, _ = planted_cloud()
    root = cloud_project(tmp_path, xyz, cls)
    before = hashlib.sha256((root / SRC).read_bytes()).hexdigest()
    r = recipe(
        # keep inside a 30 m box around the middle, 60 m tall: the high outliers go
        clipBox={"center": [E0 + 20, N0 + 20, 5], "size": [30, 30, 60], "yaw": 0, "keep": "inside"},
        regions=[
            # delete the left quarter, set the right quarter to class 3
            {"id": "d", "shape": "box", "viewProj": VP, "polygon": [[-1, -1], [-0.5, -1], [-0.5, 1], [-1, 1]],
             "action": {"kind": "delete"}},
            {"id": "c", "shape": "lasso", "viewProj": VP, "polygon": [[0.5, -1], [1, -1], [1, 1], [0.5, 1]],
             "action": {"kind": "class", "value": 3}},
        ],
        hiddenClasses=[1],
    )  # fmt: skip
    result, _ = save(root, r)
    out = result["outputs"]["register"]
    state, new_cls = evaluate(r, xyz, cls)
    keep = kept_for_save(state)
    assert out["points"] == int(keep.sum()) > 0
    las = read_las(copc_to_las(root / out["path"], tmp_path / "cleaned.las"))
    assert las.count == int(keep.sum())
    assert np.bincount(las.field("Classification"), minlength=256).tolist() == np.bincount(
        new_cls[keep], minlength=256
    ).tolist()
    manifest = json.loads((root / "manifest.json").read_text("utf-8"))
    original, copy = manifest["layers"]
    assert original["visible"] is False
    assert copy == {
        "kind": "pointcloud",
        "id": "cloud-a-cleaned",
        "name": "Scan (cleaned)",
        "visible": True,
        "capture": "d1",
        "src": {"path": "clouds/cloud-a-cleaned.copc.laz"},
        "format": "copc",
        "pointCount": int(keep.sum()),
        "derived": {"kind": "cleanup", "source": ["cloud-a"], "runId": "j-save"},
    }
    assert (root / "manifest.json.bak").is_file()
    assert hashlib.sha256((root / SRC).read_bytes()).hexdigest() == before
    # a second save gets its own id
    result2, _ = save(root, r, job_id="j-save-2")
    assert result2["outputs"]["register"]["layer"] == "cloud-a-cleaned-2"


def test_with_a_noise_copy_it_reads_the_copy(tmp_path):
    xyz, cls, outlier = planted_cloud()
    root = cloud_project(tmp_path, xyz, cls)
    noise, _ = run_job(
        PointcloudClean(),
        root,
        {"mode": "noise", "layerId": "cloud-a", "src": SRC, "outlier": {"meanK": 8, "multiplier": 2.0}},
        job_id="j-noise",
    )
    record = noise["outputs"]["commit"]
    result, _ = save(root, recipe(hiddenClasses=[7], noise=record))
    assert result["outputs"]["register"]["points"] == record["total"] - record["marked"]


def test_refuses_when_the_cleanup_removes_every_point_and_adds_nothing(tmp_path):
    xyz, cls, _ = planted_cloud(ground_step=2.0, high=4, low=2)
    root = cloud_project(tmp_path, xyz, cls)
    manifest = (root / "manifest.json").read_text("utf-8")
    with pytest.raises(JobError, match="removes every point"):
        save(root, recipe(hiddenClasses=[1, 2, 6]))
    assert (root / "manifest.json").read_text("utf-8") == manifest
    assert sorted(p.name for p in (root / "clouds").iterdir()) == ["cloud-a.copc.laz"]


def test_refuses_a_recipe_of_another_layer(tmp_path):
    with pytest.raises(JobError, match="another layer"):
        PointcloudClean().validate(
            {"mode": "save", "layerId": "cloud-a", "src": SRC, "recipe": recipe(layerId="b"), "name": "x"}
        )
```

Check of the first test's numbers: the ground grid sits at 0.25 + 0.5 k m, the box faces at 5 and 35 m and the region edges at E0 + 10 and E0 + 30 (NDC -0.5 and 0.5), so no point lies on an edge.

- [ ] **Step 2: Run them to see them fail**

`& 'E:\Dev\AIO Software\python\.venv\Scripts\python.exe' -m pytest tests/test_pccleanup_save.py` (from `python/`, the environment of Task 4 and `AIO_PDAL`). Expected: FAIL ("comes with the next step").

- [ ] **Step 3: Write `_save`**

Replace `_save` in `pipeline.py`, and add to the imports `from .evaluate import evaluate, kept_for_save` and `from .lasstream import class_histogram, filter_las`:

```python
    def _save(self, params: dict[str, Any]) -> list[Step]:
        lid, recipe = params["layerId"], params["recipe"]
        noise = recipe.get("noise")

        def stage(ctx: StepContext) -> dict[str, Any]:
            _cloud_layer(ctx.project, lid, params["src"])
            src = ctx.input(noise["path"] if noise else params["src"])
            count = _stage_las(ctx, _pdal(), src, ctx.stage("source.las"), (0.02, 0.25))
            return {"points": count}

        def apply(ctx: StepContext) -> dict[str, Any]:
            src_las, out = ctx.stage("source.las"), ctx.stage("cleaned.las")

            def rule(xyz, cls):
                state, new_cls = evaluate(recipe, xyz, cls)
                return kept_for_save(state), new_cls

            counts = filter_las(
                src_las,
                out,
                rule,
                check=ctx.check,
                progress=lambda f: ctx.progress(0.25 + 0.3 * f, "Applying the cleanup"),
            )
            src_las.unlink(missing_ok=True)
            if counts["points_out"] == 0:
                out.unlink(missing_ok=True)
                raise JobError(
                    "The cleanup removes every point of this cloud. Undo a step or show a class again, then save."
                )
            ctx.log(f"Kept {counts['points_out']:,} of {counts['points_in']:,} points.")
            return counts

        def write(ctx: StepContext) -> dict[str, Any]:
            n = int(ctx.outputs("apply")["points_out"])
            return {"writer": _write_copc(ctx, ctx.stage("cleaned.las"), ctx.stage("cloud.copc.laz"), n, (0.55, 0.95))}

        def register(ctx: StepContext) -> dict[str, Any]:
            mpath, manifest = _manifest(ctx.project)
            layers = manifest.setdefault("layers", [])
            source = next((x for x in layers if x.get("id") == lid), None)
            if source is None:
                raise JobError(f'The layer "{lid}" is not in the project any more.')
            points = int(ctx.outputs("apply")["points_out"])
            existing = next((x for x in layers if (x.get("derived") or {}).get("runId") == ctx.job.job_id), None)
            if existing is not None:  # a resumed job that already registered
                return {"layer": existing["id"], "path": existing["src"]["path"], "points": points}
            taken = {str(x.get("id")) for x in layers}
            new_id, n = f"{lid}-cleaned", 2
            while new_id in taken:
                new_id, n = f"{lid}-cleaned-{n}", n + 1
            rel = f"clouds/{new_id}.copc.laz"
            commit_files(ctx, [("cloud.copc.laz", rel)])
            layers.append(
                {
                    "kind": "pointcloud",
                    "id": new_id,
                    "name": f"{params['name']} (cleaned)",
                    "visible": True,
                    **({"capture": source["capture"]} if source.get("capture") else {}),
                    "src": {"path": rel},
                    "format": "copc",
                    "pointCount": points,
                    "derived": {"kind": "cleanup", "source": [lid], "runId": ctx.job.job_id},
                }
            )
            source["visible"] = False  # the original stays, hidden; its file is untouched
            shutil.copyfile(mpath, mpath.with_name("manifest.json.bak"))
            atomic_write_json(mpath, manifest, indent=2)
            ctx.log(f"Added layer {new_id} ({rel}).")
            return {"layer": new_id, "path": rel, "points": points}

        return [
            Step("stage", "Read the cloud", stage, weight=3),
            Step("apply", "Apply the cleanup", apply, weight=3),
            Step("write", "Build the cleaned copy", write, weight=4),
            Step("register", "Add the layer to the project", register, weight=0.5),
        ]
```

(Key order of the new layer: the test compares dicts, so order does not matter; the manifest keeps insertion order for readers of the file.)

- [ ] **Step 4: Run the tests**

`-m pytest tests/test_pccleanup_save.py tests/test_pccleanup_noise.py tests/test_replace_over_callers.py tests/test_unknown_fields.py` from `python/`. Expected: PASS (`test_replace_over_callers` passes because every rename goes through `commit_files`, `write_copc` or `atomic_write_json`). Check the import path afterwards, then ruff.

- [ ] **Step 5: Commit**

```bash
git add python/src/aio_pipelines/pointcloud_cleanup/pipeline.py python/tests/test_pccleanup_save.py
git commit -m "feat(pipelines): pointcloud.clean saves a cleaned copy as a new layer"
```

---

### Task 13: Export applies the recipe

**Packages touched:** `python/` (`survey/export.py`), desktop renderer (`survey/exportHelpers.ts`).
**Contract change:** implements row 4. **E2E:** `pointcloud-clean-export.spec.ts` (Task 17).

**Files:**

- Modify: `python/src/aio_pipelines/survey/export.py` (`SurveyExport.keys` and `validate` ~line 1197; `export_cloud` line 803)
- Create: `python/tests/test_pccleanup_export.py`
- Modify: `apps/desktop/src/renderer/survey/exportHelpers.ts` (`ExportChoice`, `exportParams` line 265)
- Modify: `apps/desktop/src/renderer/survey/exportHelpers.test.ts`

**Interfaces:**

- Consumes: Task 1 (`SurveyExportParams.cleanup`, `PointcloudCleanup`); Task 4 (`validate_recipe`, `evaluate`, `kept_for_save`).
- Produces: `ExportChoice.cleanup?: PointcloudCleanup | null`; `exportParams(c, out)` adds `cleanup` only for `what: 'cloud'` with a recipe; `survey.export` with `cleanup` reads the noise copy when the recipe has one, applies the recipe before decimating and writing, and refuses an export that would remove every point.

- [ ] **Step 1: Write the failing tests**

Create `python/tests/test_pccleanup_export.py`:

```python
"""survey.export of a cloud with a cleanup recipe: the same points a cleaned copy would hold."""

import json
import subprocess

import numpy as np
import pytest

from aio_pipelines.pointcloud import find_pdal, pdal_env
from aio_pipelines.pointcloud_cleanup.evaluate import evaluate, kept_for_save
from aio_pipelines.runtime import JobError
from aio_pipelines.survey.export import SurveyExport
from conftest import run_job
from pccleanup_synth import E0, N0, cloud_project, planted_cloud

PDAL = find_pdal()
needs_pdal = pytest.mark.skipif(PDAL is None, reason="PDAL not found (set AIO_PDAL)")
VP = [0.05, 0, 0, 0, 0, 0.05, 0, 0, 0, 0, 0, 0, -(E0 + 20) * 0.05, -(N0 + 20) * 0.05, 0, 1]
BASE = {"what": "cloud", "format": "laz", "crs": "site", "layer": "cloud-a"}


def recipe(**over):
    return {"schema": "aio.pccleanup/1", "layerId": "cloud-a", "hiddenClasses": [], "regions": [], **over}


def count(path):
    out = subprocess.run([PDAL, "info", "--summary", str(path)], capture_output=True, check=True, env=pdal_env(PDAL))
    return json.loads(out.stdout)["summary"]["num_points"]


def test_cleanup_only_with_a_cloud_export():
    with pytest.raises(JobError, match="cloud"):
        SurveyExport().validate({**BASE, "what": "surface", "format": "geotiff", "surface": "s", "out": "C:/x.tif",
                                 "cleanup": recipe()})  # fmt: skip
    with pytest.raises(JobError, match="another layer"):
        SurveyExport().validate({**BASE, "out": "C:/x.laz", "cleanup": recipe(layerId="b")})


@needs_pdal
def test_export_with_and_without_a_cleanup(tmp_path):
    xyz, cls, _ = planted_cloud()
    root = cloud_project(tmp_path, xyz, cls)
    plain = tmp_path / "plain.laz"
    run_job(SurveyExport(), root, {**BASE, "out": str(plain)}, job_id="j-plain")
    assert count(plain) == len(xyz)  # no recipe: the cloud as it is
    r = recipe(
        height={"min": -1},
        regions=[{"id": "d", "shape": "box", "viewProj": VP, "polygon": [[-1, -1], [-0.5, -1], [-0.5, 1], [-1, 1]],
                  "action": {"kind": "delete"}}],
        hiddenClasses=[1],
    )  # fmt: skip
    cleaned = tmp_path / "cleaned.laz"
    run_job(SurveyExport(), root, {**BASE, "out": str(cleaned), "cleanup": r}, job_id="j-clean")
    state, _ = evaluate(r, xyz, cls)
    assert count(cleaned) == int(kept_for_save(state).sum())


@needs_pdal
def test_refuses_an_export_that_would_remove_every_point(tmp_path):
    xyz, cls, _ = planted_cloud(ground_step=2.0, high=2, low=0)
    root = cloud_project(tmp_path, xyz, cls)
    with pytest.raises(JobError, match="removes every point"):
        run_job(SurveyExport(), root, {**BASE, "out": str(tmp_path / "x.laz"), "cleanup": recipe(hiddenClasses=[1, 2, 6])})
```

`cloud_project`'s manifest has no `site` calibration: if `crs: "site"` needs one in `export.py` (`build_frame`), use `"crs": {"epsg": 32639}` in `BASE` instead (read `build_frame` first).

Append to `apps/desktop/src/renderer/survey/exportHelpers.test.ts`:

```ts
describe('exportParams and the cleanup', () => {
  const base = {
    what: 'cloud' as const,
    format: 'laz' as const,
    crs: 'site' as const,
    units: 'm' as const,
    detail: 1,
    source: { key: 'layer:cloud-a', label: 'Scan', param: { layer: 'cloud-a' } },
    measurements: [],
    surface: null,
  };

  it('sends cleanup only for a cloud export with a recipe', () => {
    const r = { ...emptyCleanup('cloud-a'), hiddenClasses: [7] };
    expect(exportParams({ ...base, cleanup: r }, 'C:/x.laz').cleanup).toEqual(r);
    expect(exportParams({ ...base, cleanup: null }, 'C:/x.laz')).not.toHaveProperty('cleanup');
    expect(exportParams(base, 'C:/x.laz')).not.toHaveProperty('cleanup');
  });
});
```

(import `emptyCleanup` from `@aio/schema`; match `source`'s real `ExportSource` shape in `exportHelpers.ts` before running.)

- [ ] **Step 2: Run them to see them fail**

`pnpm exec vitest run apps/desktop/src/renderer/survey/exportHelpers.test.ts`, and from `python/`: `-m pytest tests/test_pccleanup_export.py`. Expected: FAIL.

- [ ] **Step 3: The export**

`export.py`: add `"cleanup"` to `SurveyExport.keys`, and at the end of `validate` (before its return):

```python
        cleanup = params.get("cleanup")
        if cleanup is not None:
            if params["what"] != "cloud":
                raise JobError("A cleanup applies to a point cloud export only.")
            from ..pointcloud_cleanup.recipe import validate_recipe

            validate_recipe(cleanup, params.get("layer"))
```

In `export_cloud`, after `layer = _manifest_layer(...)` and its kind check:

```python
    cleanup = params.get("cleanup")
    if cleanup and layer.get("format") != "copc":
        raise JobError("A cleanup applies to COPC clouds only.")
```

replace `src = cs.path` with:

```python
        # the noise run's working copy carries the noise marks the recipe hides
        src = ctx.input(cleanup["noise"]["path"]) if cleanup and cleanup.get("noise") else cs.path
```

and after the `xyz = ...` / `las_from_xyz` block, before the decimation:

```python
    if cleanup:
        from ..pointcloud_cleanup.evaluate import evaluate, kept_for_save

        state, new_cls = evaluate(cleanup, xyz, las.field("Classification"))
        keep = kept_for_save(state)
        if not keep.any():
            raise JobError("The cleanup removes every point of this cloud, so there is nothing to export.")
        records = las.records[keep].copy()
        records[:, 16] = new_cls[keep]  # set-class selections are written with their class
        las.records = records
        xyz = xyz[keep]
        ctx.log(f"Cleanup: {int(keep.sum()):,} of {len(keep):,} points kept.")
```

(The staged plain LAS of the export is point format 7 with the class byte at offset 16, `change/las.py` `BASE_FIELDS`.)

`exportHelpers.ts`: `ExportChoice` gains `/** A cloud export: the layer's cleanup recipe when Apply cleanup is on. */ cleanup?: PointcloudCleanup | null;` and in `exportParams`, after the source params: `if (c.what === 'cloud' && c.cleanup) p.cleanup = c.cleanup;`.

- [ ] **Step 4: Run the tests**

Same commands as Step 2, plus `-m pytest tests/test_survey_export.py` (unchanged behaviour). Expected: PASS. Check the import path and ruff as in Task 4.

- [ ] **Step 5: Commit**

```bash
git add python/src/aio_pipelines/survey/export.py python/tests/test_pccleanup_export.py apps/desktop/src/renderer/survey/exportHelpers.ts apps/desktop/src/renderer/survey/exportHelpers.test.ts
git commit -m "feat(survey): point cloud export applies the cleanup recipe"
```

---

### Task 14: Renderer glue: frames, jobs, the stage tools and the action records

**Packages touched:** desktop renderer.
**Contract change:** no. **E2E:** through Task 17.

**Files:**

- Create: `apps/desktop/src/renderer/pointcloud/cleanupFrame.ts`, `cleanupFrame.test.ts`
- Create: `apps/desktop/src/renderer/pointcloud/cleanupJobs.ts`, `cleanupJobs.test.ts`
- Create: `apps/desktop/src/renderer/pointcloud/cleanupScene.ts`, `cleanupScene.test.ts`
- Create: `apps/desktop/src/renderer/pointcloud/cleanupActions.ts`, `cleanupActions.test.ts`

**Interfaces:**

- Consumes: Task 2 (keys `cleanup.*`, shortcuts `cleanup.undo` and `cleanup.redo`); Task 3 (`mul4`, `worldToLocal`, `pointInPolygon`, `ringOf`, `pointcloudCleanup`); Task 5 (`countDrawn`); Task 6 at run time (`cloudWorldBounds`); Task 7 (`ClipBoxTool`, `ClipBoxLocal`, `BoxHandle`); Task 8 (`PointSelectTool`, `PointSelection`); Task 10 (`cleanup`, `Cleanup`, `PendingSelection`, `isCleanable`); `className` (`@aio/pointcloud`), `isShortcut` and `t` (`@aio/ui`), `isTyping` (`../keys`), `bridge`, `jobs` (`../shell`).
- Produces:
  - `cleanupFrame.ts`: `boxToLocal(b: ClipBox, origin: V3): ClipBoxLocal`; `boxToWorld(l: ClipBoxLocal, origin: V3, keep: 'inside' | 'outside'): ClipBox`; `worldViewProj(localViewProj: readonly number[], origin: V3): number[]`; `fitBox(b: { min: V3; max: V3 }): ClipBox` (keep inside, yaw 0, 1 % margin, at least 0.1 m)
  - `cleanupJobs.ts`: `applyNoiseRun(r: PointcloudCleanup | null, layerId: string, run: NoiseRun): PointcloudCleanup`; `noiseShare(marked: number, total: number): string`; `interface JobsDeps { call: Bridge['call']; cleanup: Cleanup; project(): { id: string; root: string } | null; waitForJob(id: string): Promise<JobRecord> }`; `runNoise(deps: JobsDeps, layer: CloudLayer, params: NoiseParams): Promise<string | null>`; `saveCleaned(deps: JobsDeps, layer: CloudLayer, name: string): Promise<string | null>`; `defaultJobsDeps: JobsDeps`
  - `cleanupScene.ts`: `selectionTest(viewProjLocal: readonly number[], polygon: readonly [number, number][]): (x: number, y: number, z: number) => boolean`; `applyPending(c: Cleanup, action: RegionAction, newId?: () => string): Promise<boolean>`; `cleanupKey(e: KeyboardEvent, c: Cleanup, toolActive: boolean): boolean`; `mountCleanupScene(stage: EngineStage, c?: Cleanup): () => void`; `cleanupDebug: { handleScreen(h: BoxHandle): { x: number; y: number } | null }`
  - `cleanupActions.ts`: `interface CleanupTarget { layer: Layer; readOnly: boolean; hasRecipe: boolean }`; `interface CleanupActionContext { openPanel(layerId: string, section?: 'noise' | 'save'): void; reset(layerId: string): Promise<boolean> }`; `interface CleanupAction { id: 'pointcloud.cleanup' | 'pointcloud.removeNoise' | 'pointcloud.saveCleaned' | 'pointcloud.resetCleanup'; label: MessageKey; applies(target: CleanupTarget): boolean; multi: false; run(target: CleanupTarget, ctx: CleanupActionContext): void | Promise<unknown> }`; `CLEANUP_ACTIONS: readonly CleanupAction[]`; `cleanupActionContext: CleanupActionContext` (over the app's `cleanup`)

- [ ] **Step 1: Write the failing tests**

`apps/desktop/src/renderer/pointcloud/cleanupFrame.test.ts`:

```ts
import { Matrix4, PerspectiveCamera, Vector3, Vector4 } from 'three';
import { describe, expect, it } from 'vitest';
import { boxToLocal, boxToWorld, fitBox, worldViewProj } from './cleanupFrame';

const origin = [500000, 3200000, 5] as const;

describe('cleanup frames', () => {
  it('moves a clip box between world and local without changing it', () => {
    const world = {
      center: [500012, 3200034, 9] as [number, number, number],
      size: [4, 6, 8] as [number, number, number],
      yaw: 0.3,
      keep: 'outside' as const,
    };
    const local = boxToLocal(world, origin);
    expect(local).toEqual({ center: [12, 4, -34], size: [4, 6, 8], yaw: 0.3 });
    expect(boxToWorld(local, origin, 'outside')).toEqual(world);
  });

  it('stores world-to-clip matrices that project a world point where the stage draws it', () => {
    const cam = new PerspectiveCamera(50, 1.5, 0.1, 5000);
    cam.position.set(30, 40, 60);
    cam.lookAt(10, 0, -20);
    cam.updateMatrixWorld();
    const local = new Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    const vp = worldViewProj(local.toArray(), origin);
    const p = new Vector3(12, 3, -25); // local
    const clipLocal = new Vector4(p.x, p.y, p.z, 1).applyMatrix4(local);
    const w = new Vector4(origin[0] + p.x, origin[1] - p.z, origin[2] + p.y, 1);
    const e = vp;
    const at = (r: number) =>
      (e[r] ?? 0) * w.x + (e[4 + r] ?? 0) * w.y + (e[8 + r] ?? 0) * w.z + (e[12 + r] ?? 0) * w.w;
    const clipWorld = [at(0), at(1), at(2), at(3)];
    expect(clipWorld[0]! / clipWorld[3]!).toBeCloseTo(clipLocal.x / clipLocal.w, 6);
    expect(clipWorld[1]! / clipWorld[3]!).toBeCloseTo(clipLocal.y / clipLocal.w, 6);
  });

  it('fits a box to the layer bounds with a small margin', () => {
    expect(fitBox({ min: [10, 20, 0], max: [110, 70, 10] })).toEqual({
      center: [60, 45, 5],
      size: [101, 50.5, 10.1],
      yaw: 0,
      keep: 'inside',
    });
    expect(fitBox({ min: [0, 0, 3], max: [0, 0, 3] }).size).toEqual([0.1, 0.1, 0.1]);
  });
});
```

(Replace the two `!` with `?? 0` if lint forbids non-null assertions.)

`apps/desktop/src/renderer/pointcloud/cleanupJobs.test.ts`:

```ts
import { createCleanupRecipes } from '@aio/pointcloud';
import { emptyCleanup, noiseCopyPath, type JobRecord, type Layer } from '@aio/schema';
import { describe, expect, it, vi } from 'vitest';
import { applyNoiseRun, noiseShare, runNoise, saveCleaned, type JobsDeps } from './cleanupJobs';
import { createCleanup } from './cleanupStore';

type CloudLayer = Extract<Layer, { kind: 'pointcloud' }>;
const layer: CloudLayer = {
  kind: 'pointcloud',
  id: 'a',
  name: 'Scan',
  visible: true,
  src: { path: 'clouds/a.copc.laz' },
  format: 'copc',
};
const run = (marked: number) => ({
  path: noiseCopyPath('a', 'job1'),
  params: { outlier: { meanK: 8, multiplier: 2 } },
  marked,
  total: 16060,
  runId: 'job1',
});

function deps(marked: number, status: JobRecord['status'] = 'done') {
  const started: unknown[] = [];
  const call = vi.fn((channel: string, req: unknown) => {
    if (channel === 'jobs:start') {
      started.push(req);
      return Promise.resolve({ ok: true, value: { ok: true, job: { id: 'job1' } } });
    }
    if (channel === 'pointcloud:readCleanup')
      return Promise.resolve({
        ok: true,
        value: { ok: true, recipes: [], noise: run(marked), readOnly: false },
      });
    if (channel === 'pointcloud:writeCleanup')
      return Promise.resolve({ ok: true, value: { ok: true, trashed: [] } });
    return Promise.resolve({ ok: false, error: channel });
  });
  const cleanup = createCleanup({
    call: call as never,
    recipes: createCleanupRecipes(),
    now: () => 1,
  });
  const d: JobsDeps = {
    call: call as never,
    cleanup,
    project: () => ({ id: 'p', root: 'D:/p' }),
    waitForJob: () =>
      Promise.resolve({
        id: 'job1',
        status,
        error: status === 'failed' ? 'PDAL failed' : undefined,
      } as JobRecord),
  };
  return { d, cleanup, started };
}

describe('noise runs', () => {
  it('adds the run and hides class 7 once', () => {
    const r = applyNoiseRun({ ...emptyCleanup('a'), hiddenClasses: [7, 2] }, 'a', run(5));
    expect(r.hiddenClasses).toEqual([2, 7]);
    expect(r.noise?.runId).toBe('job1');
    expect(applyNoiseRun(null, 'a', run(5)).hiddenClasses).toEqual([7]);
  });

  it('formats the share of marked points', () => {
    expect(noiseShare(60, 16060)).toBe('0.4 %');
    expect(noiseShare(5, 16060)).toBe('0.03 %');
    expect(noiseShare(0, 0)).toBe('0 %');
  });

  it('starts the job, then writes the run into the recipe as one step', async () => {
    const { d, cleanup, started } = deps(60);
    await cleanup.load('p', [layer]);
    expect(await runNoise(d, layer, { outlier: { meanK: 8, multiplier: 2 } })).toBeNull();
    expect(started).toEqual([
      {
        pipeline: 'pointcloud.clean',
        project: 'D:/p',
        params: {
          mode: 'noise',
          layerId: 'a',
          src: 'clouds/a.copc.laz',
          outlier: { meanK: 8, multiplier: 2 },
        },
      },
    ]);
    expect(cleanup.recipeOf('a')?.noise?.marked).toBe(60);
    expect(cleanup.store.getState().notice).toMatchObject({ undo: true });
    expect(cleanup.store.getState().busy).toBeNull();
  });

  it('a noise run that marked nothing leaves the recipe as it was and says so', async () => {
    const { d, cleanup } = deps(0);
    await cleanup.load('p', [layer]);
    expect(await runNoise(d, layer, { outlier: { meanK: 8, multiplier: 2 } })).toBeNull();
    expect(cleanup.recipeOf('a')).toBeNull();
    expect(cleanup.store.getState().notice?.text).toBe('No new noise found: nothing was marked.');
  });

  it('a failed job leaves the recipe and gives its error', async () => {
    const { d, cleanup } = deps(60, 'failed');
    await cleanup.load('p', [layer]);
    expect(await runNoise(d, layer, { outlier: { meanK: 8, multiplier: 2 } })).toBe('PDAL failed');
    expect(cleanup.recipeOf('a')).toBeNull();
  });
});

describe('save cleaned copy', () => {
  it('sends the present recipe and the name', async () => {
    const { d, cleanup, started } = deps(0);
    await cleanup.load('p', [layer]);
    await cleanup.commit('a', { ...emptyCleanup('a'), hiddenClasses: [7] });
    expect(await saveCleaned(d, layer, 'Scan')).toBeNull();
    expect(started[0]).toMatchObject({
      pipeline: 'pointcloud.clean',
      params: { mode: 'save', layerId: 'a', name: 'Scan', recipe: { hiddenClasses: [7] } },
    });
  });
});
```

`apps/desktop/src/renderer/pointcloud/cleanupScene.test.ts`:

```ts
import { createCleanupRecipes } from '@aio/pointcloud';
import { emptyCleanup, type Layer } from '@aio/schema';
import { describe, expect, it, vi } from 'vitest';
import { applyPending, cleanupKey, selectionTest } from './cleanupScene';
import { createCleanup } from './cleanupStore';

const cloud = {
  kind: 'pointcloud',
  id: 'a',
  name: 'a',
  visible: true,
  src: { path: 'clouds/a.copc.laz' },
  format: 'copc',
} as Layer;
const ID = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

async function store() {
  const call = vi.fn((channel: string) =>
    Promise.resolve(
      channel === 'pointcloud:readCleanup'
        ? { ok: true, value: { ok: true, recipes: [], readOnly: false } }
        : { ok: true, value: { ok: true, trashed: [] } },
    ),
  );
  const c = createCleanup({ call: call as never, recipes: createCleanupRecipes(), now: () => 1 });
  await c.load('p', [cloud]);
  c.setActive('a');
  return c;
}

describe('the selection tools', () => {
  it('tests points against the drawn outline through the view of the time', () => {
    const inside = selectionTest(ID, [
      [-0.5, -0.5],
      [0.5, -0.5],
      [0.5, 0.5],
      [-0.5, 0.5],
    ]);
    expect(inside(0, 0, 0)).toBe(true);
    expect(inside(0.9, 0, 0)).toBe(false);
    // behind the camera (w <= 0) is never selected
    const behind = selectionTest(
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -1, 0, 0, 0, 0],
      [
        [-9, -9],
        [9, -9],
        [9, 9],
      ],
    );
    expect(behind(0, 0, 1)).toBe(false);
  });

  it('turns the pending selection into one step with its notice', async () => {
    const c = await store();
    c.setPending({
      layerId: 'a',
      shape: 'lasso',
      polygon: [
        [0, 0],
        [1, 0],
        [0, 1],
      ],
      viewProj: ID,
      count: 12,
    });
    expect(await applyPending(c, { kind: 'class', value: 6 }, () => 'r1')).toBe(true);
    expect(c.recipeOf('a')?.regions).toEqual([
      {
        id: 'r1',
        shape: 'lasso',
        viewProj: ID,
        polygon: [
          [0, 0],
          [1, 0],
          [0, 1],
        ],
        action: { kind: 'class', value: 6 },
      },
    ]);
    expect(c.store.getState().pending).toBeNull();
    expect(c.store.getState().notice?.text).toBe('Class set to Building.');
  });

  it('refuses a 201st selection and says to save a cleaned copy', async () => {
    const c = await store();
    const regions = Array.from({ length: 200 }, (_, i) => ({
      id: `r${String(i)}`,
      shape: 'box' as const,
      viewProj: ID,
      polygon: [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ] as [number, number][],
      action: { kind: 'hide' as const },
    }));
    await c.commit('a', { ...emptyCleanup('a'), regions });
    c.setPending({
      layerId: 'a',
      shape: 'box',
      polygon: [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
      viewProj: ID,
      count: 1,
    });
    expect(await applyPending(c, { kind: 'delete' })).toBe(false);
    expect(c.store.getState().notice).toMatchObject({ error: true });
    expect(c.recipeOf('a')?.regions).toHaveLength(200);
  });

  it('undoes and redoes with the keyboard while the panel or a tool is active', async () => {
    const c = await store();
    await c.commit('a', { ...emptyCleanup('a'), hiddenClasses: [2] });
    const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);
    expect(cleanupKey(key({ key: 'z', ctrlKey: true }), c, false)).toBe(false); // panel closed, no tool
    c.openPanel('a');
    expect(cleanupKey(key({ key: 'z', ctrlKey: true }), c, false)).toBe(true);
    await vi.waitFor(() => expect(c.recipeOf('a')).toBeNull());
    expect(cleanupKey(key({ key: 'Z', ctrlKey: true, shiftKey: true }), c, false)).toBe(true);
    await vi.waitFor(() => expect(c.recipeOf('a')?.hiddenClasses).toEqual([2]));
  });
});
```

(`// @vitest-environment jsdom` at the top for `KeyboardEvent`.)

`apps/desktop/src/renderer/pointcloud/cleanupActions.test.ts`:

```ts
import type { Layer } from '@aio/schema';
import { describe, expect, it, vi } from 'vitest';
import { CLEANUP_ACTIONS, type CleanupTarget } from './cleanupActions';

const copc = {
  kind: 'pointcloud',
  id: 'a',
  name: 'a',
  visible: true,
  src: { path: 'x' },
  format: 'copc',
} as Layer;
const png = { ...copc, format: 'png-packed' } as Layer;
const ids = (t: CleanupTarget) => CLEANUP_ACTIONS.filter((a) => a.applies(t)).map((a) => a.id);

describe('cleanup action records', () => {
  it('are plain records with the shared action shape', () => {
    expect(CLEANUP_ACTIONS.map((a) => [a.id, a.label, a.multi])).toEqual([
      ['pointcloud.cleanup', 'cleanup.menu.open', false],
      ['pointcloud.removeNoise', 'cleanup.menu.noise', false],
      ['pointcloud.saveCleaned', 'cleanup.menu.save', false],
      ['pointcloud.resetCleanup', 'cleanup.menu.reset', false],
    ]);
  });

  it('apply to COPC clouds; editing ones not in a package; reset only with a recipe', () => {
    expect(ids({ layer: copc, readOnly: false, hasRecipe: true })).toHaveLength(4);
    expect(ids({ layer: copc, readOnly: false, hasRecipe: false })).not.toContain(
      'pointcloud.resetCleanup',
    );
    expect(ids({ layer: copc, readOnly: true, hasRecipe: true })).toEqual(['pointcloud.cleanup']);
    expect(ids({ layer: png, readOnly: false, hasRecipe: false })).toEqual([]);
  });

  it('open the panel at a section, or reset', async () => {
    const ctx = { openPanel: vi.fn(), reset: vi.fn(() => Promise.resolve(true)) };
    const t = { layer: copc, readOnly: false, hasRecipe: true };
    for (const a of CLEANUP_ACTIONS) await a.run(t, ctx);
    expect(ctx.openPanel.mock.calls).toEqual([['a'], ['a', 'noise'], ['a', 'save']]);
    expect(ctx.reset).toHaveBeenCalledWith('a');
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run apps/desktop/src/renderer/pointcloud/cleanupFrame.test.ts apps/desktop/src/renderer/pointcloud/cleanupJobs.test.ts apps/desktop/src/renderer/pointcloud/cleanupScene.test.ts apps/desktop/src/renderer/pointcloud/cleanupActions.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Write `cleanupFrame.ts`**

```ts
/**
 * The recipe is in world coordinates (project CRS); the stage and its tools in the local frame
 * (x east, y up, z south from the project origin). Conversions for the clip box and the view of a
 * selection. Float64 (three's Matrix4 elements are plain numbers).
 */
import type { ClipBoxLocal } from '@aio/engine';
import { mul4, worldToLocal } from '@aio/pointcloud';
import type { ClipBox } from '@aio/schema';

type V3 = readonly [number, number, number];

export function boxToLocal(b: ClipBox, o: V3): ClipBoxLocal {
  return {
    center: [b.center[0] - o[0], b.center[2] - o[2], o[1] - b.center[1]],
    size: [b.size[0], b.size[1], b.size[2]],
    yaw: b.yaw,
  };
}

export function boxToWorld(l: ClipBoxLocal, o: V3, keep: 'inside' | 'outside'): ClipBox {
  return {
    center: [l.center[0] + o[0], o[1] - l.center[2], l.center[1] + o[2]],
    size: [l.size[0], l.size[1], l.size[2]],
    yaw: l.yaw,
    keep,
  };
}

/** A selection's view (local to clip) as the recipe stores it (world to clip). */
export function worldViewProj(localViewProj: readonly number[], o: V3): number[] {
  return Array.from(mul4(localViewProj, worldToLocal(o)));
}

/** A box around the layer's bounds (project CRS), 1 % larger, at least 0.1 m a side. */
export function fitBox(b: { min: V3; max: V3 }): ClipBox {
  const size = [0, 1, 2].map((a) =>
    Math.max(0.1, Math.round(((b.max[a] ?? 0) - (b.min[a] ?? 0)) * 1.01 * 1000) / 1000),
  ) as [number, number, number];
  const center = [0, 1, 2].map((a) => ((b.max[a] ?? 0) + (b.min[a] ?? 0)) / 2) as [
    number,
    number,
    number,
  ];
  return { center, size, yaw: 0, keep: 'inside' };
}
```

- [ ] **Step 4: Write `cleanupJobs.ts`**

```ts
/**
 * Remove noise and Save cleaned copy: `pointcloud.clean` jobs from the Clean up panel. A finished
 * noise run's record (beside its working copy) becomes one step of the layer's recipe, with class 7
 * hidden; a run that marked nothing changes nothing. A saved copy arrives as a new layer through the
 * manifest reload of MANIFEST_WRITERS (jobs.ts).
 */
import {
  NOISE_CLASS,
  emptyCleanup,
  type JobRecord,
  type Layer,
  type NoiseParams,
  type NoiseRun,
  type PointcloudCleanup,
} from '@aio/schema';
import { t } from '@aio/ui';
import { workspace } from '@aio/workspace';
import type { Bridge } from '../bridge';
import { bridge, jobs } from '../shell';
import { cleanup as appCleanup, type Cleanup } from './cleanupStore';

type CloudLayer = Extract<Layer, { kind: 'pointcloud' }>;

export function applyNoiseRun(
  r: PointcloudCleanup | null,
  layerId: string,
  run: NoiseRun,
): PointcloudCleanup {
  const base = r ?? emptyCleanup(layerId);
  const hidden = [...new Set([...base.hiddenClasses, NOISE_CLASS])].sort((a, b) => a - b);
  return { ...base, noise: run, hiddenClasses: hidden };
}

export function noiseShare(marked: number, total: number): string {
  if (!total || !marked) return '0 %';
  const pct = (100 * marked) / total;
  return `${pct.toFixed(pct < 0.1 ? 2 : 1)} %`;
}

export interface JobsDeps {
  call: Bridge['call'];
  cleanup: Cleanup;
  project(): { id: string; root: string } | null;
  waitForJob(id: string): Promise<JobRecord>;
}

const FINISHED = new Set(['done', 'failed', 'cancelled', 'interrupted']);

export const defaultJobsDeps: JobsDeps = {
  call: (c, r) => bridge.call(c, r),
  cleanup: appCleanup,
  project: () => {
    const p = workspace.getState().project;
    return p ? { id: p.id, root: p.root } : null;
  },
  waitForJob: (id) =>
    new Promise((resolve) => {
      const check = (s: { jobs: JobRecord[] }) => {
        const j = s.jobs.find((x) => x.id === id);
        if (j && FINISHED.has(j.status)) {
          stop();
          resolve(j);
        }
      };
      const stop = jobs.subscribe(check);
      check(jobs.getState());
    }),
};

const srcOf = (layer: CloudLayer): string | null => ('path' in layer.src ? layer.src.path : null);

async function start(
  d: JobsDeps,
  params: Record<string, unknown>,
): Promise<{ job: JobRecord } | { error: string }> {
  const p = d.project();
  if (!p) return { error: 'No project is open.' };
  const r = await d.call('jobs:start', { pipeline: 'pointcloud.clean', project: p.root, params });
  if (!r.ok) return { error: r.error };
  if (!r.value.ok) return { error: r.value.error };
  return { job: await d.waitForJob(r.value.job.id) };
}

export async function runNoise(
  d: JobsDeps,
  layer: CloudLayer,
  params: NoiseParams,
): Promise<string | null> {
  const src = srcOf(layer);
  const p = d.project();
  if (!src || !p) return 'This cloud has no file in the project.';
  d.cleanup.setBusy('noise');
  try {
    const started = await start(d, {
      mode: 'noise',
      layerId: layer.id,
      src,
      outlier: params.outlier,
      ...(params.elm ? { elm: params.elm } : {}),
    });
    if ('error' in started) return started.error;
    const { job } = started;
    if (job.status !== 'done') return job.error ?? 'The noise run did not finish.';
    const r = await d.call('pointcloud:readCleanup', {
      projectId: p.id,
      noiseRun: { layerId: layer.id, runId: job.id },
    });
    const run = r.ok && r.value.ok ? r.value.noise : null;
    if (!run) return 'The noise run left no result.';
    if (run.marked === 0) {
      d.cleanup.notify({
        text: t('cleanup.noise.none'),
        undo: false,
        error: false,
        layerId: layer.id,
      });
      return null;
    }
    const next = applyNoiseRun(d.cleanup.recipeOf(layer.id), layer.id, run);
    await d.cleanup.commit(layer.id, next, { kind: 'noise', count: run.marked });
    return null;
  } finally {
    d.cleanup.setBusy(null);
  }
}

export async function saveCleaned(
  d: JobsDeps,
  layer: CloudLayer,
  name: string,
): Promise<string | null> {
  const src = srcOf(layer);
  if (!src) return 'This cloud has no file in the project.';
  const recipe = d.cleanup.recipeOf(layer.id) ?? emptyCleanup(layer.id);
  d.cleanup.setBusy('save');
  d.cleanup.notify({
    text: t('cleanup.save.started'),
    undo: false,
    error: false,
    layerId: layer.id,
  });
  try {
    const started = await start(d, {
      mode: 'save',
      layerId: layer.id,
      src,
      recipe,
      name: name.trim() || layer.name,
    });
    if ('error' in started) return started.error;
    return started.job.status === 'done' ? null : (started.job.error ?? 'The save did not finish.');
  } finally {
    d.cleanup.setBusy(null);
  }
}
```

- [ ] **Step 5: Write `cleanupScene.ts`**

```ts
/**
 * The cleanup tools on the stage: the clip box gizmo while the stage tool is `clipbox`, the box or
 * lasso selection while it is `pcselect`, for the active layer of the Clean up panel. A box drag
 * shows live (no step) and commits one step on release; a drawn selection counts the loaded points
 * it covers and waits in `pending` for Hide, Delete or Set class (the panel's bar). Ctrl+Z and
 * Ctrl+Shift+Z (Ctrl+Y) undo and redo while the panel or a cleanup tool is active.
 */
import {
  ClipBoxTool,
  PointSelectTool,
  type BoxHandle,
  type ClipBoxLocal,
  type EngineStage,
  type PointSelection,
} from '@aio/engine';
import { className, countDrawn, pointcloudCleanup, pointInPolygon, ringOf } from '@aio/pointcloud';
import { MAX_REGIONS, emptyCleanup, type RegionAction } from '@aio/schema';
import { isShortcut, t } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { isTyping } from '../keys';
import { boxToLocal, boxToWorld, worldViewProj } from './cleanupFrame';
import { cleanup as appCleanup, type Cleanup } from './cleanupStore';

type V3 = readonly [number, number, number];

export function selectionTest(
  m: readonly number[],
  polygon: readonly [number, number][],
): (x: number, y: number, z: number) => boolean {
  const ring = ringOf(polygon);
  const e = (i: number) => m[i] ?? 0;
  return (x, y, z) => {
    const w = e(3) * x + e(7) * y + e(11) * z + e(15);
    if (!(w > 0)) return false;
    return pointInPolygon(
      ring,
      (e(0) * x + e(4) * y + e(8) * z + e(12)) / w,
      (e(1) * x + e(5) * y + e(9) * z + e(13)) / w,
    );
  };
}

const newRegionId = () =>
  `r${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

export async function applyPending(
  c: Cleanup,
  action: RegionAction,
  newId: () => string = newRegionId,
): Promise<boolean> {
  const p = c.store.getState().pending;
  if (!p) return false;
  const base = c.recipeOf(p.layerId) ?? emptyCleanup(p.layerId);
  if (base.regions.length >= MAX_REGIONS) {
    c.notify({
      text: t('cleanup.select.full', { max: MAX_REGIONS }),
      undo: false,
      error: true,
      layerId: p.layerId,
    });
    return false;
  }
  const region = { id: newId(), shape: p.shape, viewProj: p.viewProj, polygon: p.polygon, action };
  c.setPending(null);
  return c.commit(
    p.layerId,
    { ...base, regions: [...base.regions, region] },
    action.kind === 'class'
      ? { kind: 'classSet', name: className(action.value) }
      : { kind: action.kind === 'hide' ? 'hidden' : 'deleted' },
  );
}

/** Undo or redo for the cleanup scope; true when the key was taken. */
export function cleanupKey(e: KeyboardEvent, c: Cleanup, toolActive: boolean): boolean {
  const s = c.store.getState();
  if (!(s.panelOpen || toolActive) || !s.active || isTyping(e.target)) return false;
  if (isShortcut('cleanup.undo', e)) void c.undo(s.active);
  else if (isShortcut('cleanup.redo', e)) void c.redo(s.active);
  else return false;
  e.preventDefault();
  e.stopImmediatePropagation();
  return true;
}

let liveBox: ClipBoxTool | null = null;
/** For the e2e specs (`__stratlas.pointcloudCleanup.handle`). */
export const cleanupDebug = {
  handleScreen: (h: BoxHandle) => liveBox?.handleScreen(h) ?? null,
};

const originOf = (): V3 | null => workspace.getState().project?.manifest.origin ?? null;

export function mountCleanupScene(stage: EngineStage, c: Cleanup = appCleanup): () => void {
  let box: { tool: ClipBoxTool; off: () => void; layerId: string } | null = null;
  let select: { tool: PointSelectTool; off: () => void; layerId: string } | null = null;

  const boxOf = (layerId: string, origin: V3): ClipBoxLocal | null => {
    const r = pointcloudCleanup.getState().recipes[layerId];
    return r?.clipBox ? boxToLocal(r.clipBox, origin) : null;
  };

  const sync = () => {
    const s = c.store.getState();
    const origin = originOf();
    const layerId = s.active;
    const wantBox = stage.tool === 'clipbox' && layerId && origin ? boxOf(layerId, origin) : null;
    if (box && (!wantBox || box.layerId !== layerId)) {
      box.off();
      box = null;
      liveBox = null;
    }
    if (wantBox && layerId && origin && !box) {
      const tool = new ClipBoxTool(stage, {
        box: wantBox,
        onChange: (local, done) => {
          const base = c.recipeOf(layerId) ?? emptyCleanup(layerId);
          const keep = base.clipBox?.keep ?? 'inside';
          const next = { ...base, clipBox: boxToWorld(local, origin, keep) };
          if (done) void c.commit(layerId, next);
          else c.preview(layerId, next);
        },
      });
      box = { tool, off: tool.attach(), layerId };
      liveBox = tool;
    }
    const wantSelect = stage.tool === 'pcselect' && layerId && origin && !s.readOnly;
    if (select && (!wantSelect || select.layerId !== layerId)) {
      select.off();
      select = null;
    }
    if (wantSelect && layerId && origin && !select) {
      const tool = new PointSelectTool(stage, {
        shape: s.selectShape,
        onSelect: (sel: PointSelection) => {
          const count = countDrawn(stage, layerId, selectionTest(sel.viewProj, sel.polygon)).drawn;
          c.setPending({
            layerId,
            shape: sel.shape,
            polygon: sel.polygon,
            viewProj: worldViewProj(sel.viewProj, origin),
            count,
          });
        },
        onCancel: () => {
          c.setPending(null);
          stage.setTool('select');
        },
      });
      select = { tool, off: tool.attach(), layerId };
    }
    select?.tool.setShape(s.selectShape);
  };

  // undo, redo and a recipe from elsewhere move the gizmo too
  const offRecipes = pointcloudCleanup.subscribe(() => {
    const origin = originOf();
    if (!box || !origin) return;
    const local = boxOf(box.layerId, origin);
    if (local) box.tool.setBox(local);
  });
  const offStage = stage.onStateChange(sync);
  const offStore = c.store.subscribe(sync);
  const onKey = (e: KeyboardEvent) => {
    cleanupKey(e, c, stage.tool === 'clipbox' || stage.tool === 'pcselect');
  };
  window.addEventListener('keydown', onKey, { capture: true });
  sync();
  return () => {
    window.removeEventListener('keydown', onKey, { capture: true });
    offRecipes();
    offStage();
    offStore();
    box?.off();
    select?.off();
    box = null;
    select = null;
    liveBox = null;
    if (stage.tool === 'clipbox' || stage.tool === 'pcselect') stage.setTool('select');
  };
}
```

Box editing needs a box to edit: the panel's Edit box button (Task 15) commits `fitBox` first when the recipe has no `clipBox`, then sets the stage tool to `clipbox`.

- [ ] **Step 6: Write `cleanupActions.ts`**

```ts
/**
 * The point cloud cleanup actions of a layer's right-click menu, as plain records in the shape of
 * the sidebar's shared action registry (feat/sidebar-context-menus moves them there when it
 * rebases): `{ id, label, applies(target), multi, run(target, ctx) }`. The menu calls `run`; no
 * handler logic lives in JSX.
 */
import type { Layer } from '@aio/schema';
import type { MessageKey } from '@aio/ui';
import { cleanup, isCleanable } from './cleanupStore';

export interface CleanupTarget {
  layer: Layer;
  readOnly: boolean;
  hasRecipe: boolean;
}

export interface CleanupActionContext {
  openPanel(layerId: string, section?: 'noise' | 'save'): void;
  reset(layerId: string): Promise<boolean>;
}

export interface CleanupAction {
  id:
    | 'pointcloud.cleanup'
    | 'pointcloud.removeNoise'
    | 'pointcloud.saveCleaned'
    | 'pointcloud.resetCleanup';
  label: MessageKey;
  applies(target: CleanupTarget): boolean;
  multi: false;
  run(target: CleanupTarget, ctx: CleanupActionContext): void | Promise<unknown>;
}

const editable = (t: CleanupTarget) => isCleanable(t.layer) && !t.readOnly;

export const CLEANUP_ACTIONS: readonly CleanupAction[] = [
  {
    id: 'pointcloud.cleanup',
    label: 'cleanup.menu.open',
    applies: (t) => isCleanable(t.layer),
    multi: false,
    run: (t, ctx) => {
      ctx.openPanel(t.layer.id);
    },
  },
  {
    id: 'pointcloud.removeNoise',
    label: 'cleanup.menu.noise',
    applies: editable,
    multi: false,
    run: (t, ctx) => {
      ctx.openPanel(t.layer.id, 'noise');
    },
  },
  {
    id: 'pointcloud.saveCleaned',
    label: 'cleanup.menu.save',
    applies: editable,
    multi: false,
    run: (t, ctx) => {
      ctx.openPanel(t.layer.id, 'save');
    },
  },
  {
    id: 'pointcloud.resetCleanup',
    label: 'cleanup.menu.reset',
    applies: (t) => editable(t) && t.hasRecipe,
    multi: false,
    run: (t, ctx) => ctx.reset(t.layer.id),
  },
];

export const cleanupActionContext: CleanupActionContext = {
  openPanel: (layerId, section) => {
    cleanup.openPanel(layerId, section);
  },
  reset: (layerId) => cleanup.reset(layerId),
};
```

Remove noise and Save cleaned copy open the panel at their section (they need settings and a name); the panel shows the action there (spec: "Remove noise...", "Save cleaned copy..." end with an ellipsis because they open a form).

- [ ] **Step 7: Run the tests**

Same command as Step 2. Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/renderer/pointcloud/cleanupFrame.ts apps/desktop/src/renderer/pointcloud/cleanupFrame.test.ts apps/desktop/src/renderer/pointcloud/cleanupJobs.ts apps/desktop/src/renderer/pointcloud/cleanupJobs.test.ts apps/desktop/src/renderer/pointcloud/cleanupScene.ts apps/desktop/src/renderer/pointcloud/cleanupScene.test.ts apps/desktop/src/renderer/pointcloud/cleanupActions.ts apps/desktop/src/renderer/pointcloud/cleanupActions.test.ts
git commit -m "feat(desktop): cleanup jobs, stage tools binding and menu action records"
```

---

### Task 15: Clean up panel, toolbar button and test hooks

**Packages touched:** desktop renderer.
**Contract change:** no. **E2E:** all three specs (Task 17).

Before building, read the design guidance of the `impeccable` and `frontend-design` skills if the agent can load skills (the coordinator loads them and passes their notes otherwise), and follow the existing stage panel styles: `overlay-box`, `pop-form`, `pop-title`, `pop-row`, `seg pop-seg`, `pop-note`, `btn sm` (see `workspace/CutawayTool.tsx` and `StageTools.tsx`). The panel is on the stage, which is dark in every theme (`data-surface="dark"` like the toolbar).

**Files:**

- Create: `apps/desktop/src/renderer/pointcloud/CleanupPanel.tsx`
- Create: `apps/desktop/src/renderer/pointcloud/CleanupHost.tsx`
- Create: `apps/desktop/src/renderer/pointcloud/cleanup.css`
- Create: `apps/desktop/src/renderer/pointcloud/CleanupPanel.test.tsx`
- Modify: `apps/desktop/src/renderer/workspace/StageTools.tsx:514-549` (`CloudTools`: the Clean up button)
- Modify: `apps/desktop/src/renderer/workspace/Stage.tsx:175-178` (mount `CleanupHost` in the 3D pane)
- Modify: `apps/desktop/src/renderer/bootstrap.ts:119` (`__stratlas.pointcloudCleanup`)

**Interfaces:**

- Consumes: Tasks 2, 5, 6, 7, 8, 10, 14 (`cleanup`, `useCleanup`, `isCleanable`, `fitBox`, `runNoise`, `saveCleaned`, `defaultJobsDeps`, `applyPending`, `mountCleanupScene`, `cleanupDebug`, `noiseShare`, `formatBoxSize`, `boxToLocal`, `cloudWorldBounds`, `countDrawn`, `cloudSourceUrl`, `ASPRS_CLASSES`).
- Produces:
  - `CleanupPanel({ stage }: { stage: EngineStage | null })` (`data-testid="cleanup-panel"`)
  - `CleanupHost({ engine }: { engine: EngineStage | null })`: loads the store when the open project changes (`cleanup.load(project.id, project.manifest.layers)`, once per project id), mounts `mountCleanupScene(engine)` while the panel is open, renders `CleanupPanel` and `CleanupNotice`
  - `CleanupNotice()` (`data-testid="cleanup-notice"`, Undo `cleanup-notice-undo`), in `CleanupHost.tsx`
  - `window.__stratlas.pointcloudCleanup = { store, recipes, drawn(layerId?), source(layerId), handle(face) }`
  - Test ids: `cleanup-tool`, `cleanup-panel`, `cleanup-layer`, `cleanup-hint`, `cleanup-box-edit`, `cleanup-box-fit`, `cleanup-box-keep-inside`, `cleanup-box-keep-outside`, `cleanup-box-reset`, `cleanup-box-size`, `cleanup-height-min`, `cleanup-height-max`, `cleanup-height-clear`, `cleanup-select-box`, `cleanup-select-lasso`, `cleanup-selection-bar`, `cleanup-selection-count`, `cleanup-hide`, `cleanup-delete`, `cleanup-set-class`, `cleanup-class-list`, `cleanup-cancel`, `cleanup-noise-run`, `cleanup-noise-settings`, `cleanup-noise-result`, `cleanup-noise-undo`, `cleanup-save-name`, `cleanup-save`, `cleanup-undo`, `cleanup-redo`, `cleanup-reset`, `cleanup-error`

Panel behaviour (spec section 5):

- Acts on `active` from the store, else the selected layer (`workspace.selection` of kind `layer` that is a cloud), else the only cloud; a `<select>` (`cleanup-layer`) when the project has several clouds. Setting it calls `cleanup.setActive`.
- A cloud that is not COPC: every section is disabled and `cleanup-hint` says `cleanup.copcOnly`. A package: `cleanup.readOnly`, view only (box and selection tools off, buttons disabled).
- **Clip box:** Edit box toggles the stage tool `clipbox` (if the recipe has no box yet, it first commits `fitBox(cloudWorldBounds(stage, id))` as one step); Fit to layer commits `fitBox(...)` keeping the current `keep`; Keep Inside / Outside is a `seg` of two buttons committing `keep`; Remove box commits the recipe without `clipBox`; the size line (`cleanup-box-size`) shows `t('cleanup.box.size', { x, y, z })` from `formatBoxSize(boxToLocal(...))`; `cleanup.box.editing` under it while the tool is on.
- **Height range:** two number inputs in metres of elevation (`cleanup-height-min`, `cleanup-height-max`) and a two-thumb slider (two overlaid `input type="range"` over the layer's z range from `cloudWorldBounds`); a change commits on `change` of the range thumbs (pointer released) and on blur or Enter of the fields, never while typing; Clear commits the recipe without `height`.
- **Select:** Box and Lasso set `cleanup.setShape` and the stage tool `pcselect` (pressed state follows `stage.tool` and the shape). With `pending` set, a bar over the bottom of the stage (`cleanup-selection-bar`, rendered by `CleanupHost` so it shows with the panel scrolled) reads `t('cleanup.select.count', { count })` and offers Hide, Delete, Set class (a list of `ASPRS_CLASSES` names, `cleanup-class-list`, each item `cleanup-class-<code>`) and Cancel; each calls `applyPending(cleanup, action)` or `cleanup.setPending(null)`. With 180 or more regions a `pop-note` shows `cleanup.select.near` (`count`, `max` 200); at 200 the tools are disabled with `cleanup.select.full`.
- **Remove noise:** Run (`cleanup-noise-run`, disabled while `busy`; label `cleanup.noise.running` while busy) calls `runNoise(defaultJobsDeps, layer, params)`; a `<details>` Settings (`cleanup-noise-settings`) holds Neighbours (2 to 64, default 8), Distance limit (0.1 to 10, default 2), Also mark low points (checkbox, off), Cell size (default 10) and Height threshold (default 1) with `DEFAULT_OUTLIER` and `DEFAULT_ELM`; after a run with a recipe noise the result line `cleanup-noise-result` reads `t('cleanup.noise.result', { count: marked, share: noiseShare(marked, total) })` with an Undo (`cleanup-noise-undo`) that calls `cleanup.undo(id)` when the last step is the noise step (otherwise it commits the recipe without `noise` and without class 7 in `hiddenClasses` if the run added it). A job error shows in `cleanup-error`.
- **Save cleaned copy:** a name field (default the layer's name) and Save (`cleanup-save`) calling `saveCleaned`; disabled while busy.
- **Footer:** Undo (`cleanup-undo`, disabled without past steps), Redo (`cleanup-redo`, disabled without future steps; the `undo` icon mirrored with `transform: scaleX(-1)`), Reset all cleanup (`cleanup-reset`, `btn sm danger`, disabled without a recipe) calling `cleanup.reset(id)` (one step, Undo in the notice).
- The section named in the store's `section` (`noise` or `save`, from the right-click menu) scrolls into view and takes focus when the panel opens.
- Close: an `x` button in the title row and Escape when focus is in the panel (`cleanup.closePanel()`; the stage tool goes back to `select`).

- [ ] **Step 1: Write the failing component test**

Create `apps/desktop/src/renderer/pointcloud/CleanupPanel.test.tsx`:

```tsx
// @vitest-environment jsdom
import { ProjectManifest, emptyCleanup, type Layer } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CleanupPanel } from './CleanupPanel';
import { cleanup } from './cleanupStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | undefined;
const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);

const copc = (id: string, format = 'copc'): Layer =>
  ({
    kind: 'pointcloud',
    id,
    name: `Scan ${id}`,
    visible: true,
    src: { path: `clouds/${id}.copc.laz` },
    format,
  }) as Layer;

function project(layers: Layer[]) {
  workspace.getState().openProject({
    id: 'p',
    root: 'D:/p',
    manifest: ProjectManifest.parse({
      schema: 'aio.project/1',
      id: 'p',
      name: 'P',
      origin: [500000, 3200000, 0],
      crs: { epsg: 32639 },
      captures: [],
      layers,
      severityModels: [],
      classCatalogues: [],
    }),
  });
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  cleanup.store.setState({
    projectId: 'p',
    readOnly: false,
    layers: {},
    active: null,
    panelOpen: true,
    pending: null,
    busy: null,
    notice: null,
  });
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});
const render = () => {
  root = createRoot(host);
  act(() => root?.render(<CleanupPanel stage={null} />));
};

describe('CleanupPanel', () => {
  it('acts on the only cloud and offers every section', () => {
    project([copc('a')]);
    render();
    expect(q('cleanup-panel')).not.toBeNull();
    expect(q('cleanup-layer')).toBeNull(); // one cloud: no picker
    for (const id of [
      'cleanup-box-fit',
      'cleanup-height-min',
      'cleanup-select-lasso',
      'cleanup-noise-run',
      'cleanup-save',
    ])
      expect(q(id), id).not.toBeNull();
    expect((q('cleanup-save-name') as HTMLInputElement).value).toBe('Scan a');
  });

  it('says COPC only and disables the tools for a png-packed cloud', () => {
    project([copc('a', 'png-packed')]);
    render();
    expect(q('cleanup-hint')?.textContent).toBe(
      'Cleanup works on COPC clouds. Convert this cloud to COPC to clean it up.',
    );
    expect((q('cleanup-noise-run') as HTMLButtonElement).disabled).toBe(true);
    expect((q('cleanup-select-box') as HTMLButtonElement).disabled).toBe(true);
  });

  it('commits a height range on blur, not while typing', async () => {
    project([copc('a')]);
    const commit = vi.spyOn(cleanup, 'commit').mockResolvedValue(true);
    render();
    const min = q('cleanup-height-min') as HTMLInputElement;
    act(() => {
      // React tracks the value setter: set it the native way, then fire input
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(min, '12.5');
      min.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(commit).not.toHaveBeenCalled();
    act(() => {
      min.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(commit).toHaveBeenCalledWith('a', expect.objectContaining({ height: { min: 12.5 } }));
    commit.mockRestore();
  });

  it('shows the noise result with an Undo', () => {
    project([copc('a')]);
    const r = {
      ...emptyCleanup('a'),
      hiddenClasses: [7],
      noise: {
        path: 'edits/pointcloud/a.noise-j1.copc.laz',
        params: { outlier: { meanK: 8, multiplier: 2 } },
        marked: 60,
        total: 16060,
        runId: 'j1',
      },
    };
    cleanup.store.setState({ layers: { a: { past: [null], present: r, future: [] } } });
    render();
    expect(q('cleanup-noise-result')?.textContent).toContain('60 points (0.4 %) marked as noise');
    expect(q('cleanup-noise-undo')).not.toBeNull();
    expect((q('cleanup-undo') as HTMLButtonElement).disabled).toBe(false);
    expect((q('cleanup-redo') as HTMLButtonElement).disabled).toBe(true);
  });

  it('picks among several clouds', () => {
    project([copc('a'), copc('b')]);
    render();
    const pick = q('cleanup-layer') as HTMLSelectElement;
    act(() => {
      pick.value = 'b';
      pick.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(cleanup.store.getState().active).toBe('b');
  });
});
```

`workspace.getState().openProject` is the store's own action (packages/workspace/src/index.ts:111); add `customer` and `site` to the manifest if `ProjectManifest.parse` asks for them (as `e2e/fixtures.ts` `tinyManifest` does).

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm exec vitest run apps/desktop/src/renderer/pointcloud/CleanupPanel.test.tsx`
Expected: FAIL (module missing).

- [ ] **Step 3: Write the panel, the host and the styles**

Build `CleanupPanel.tsx` to the behaviour list above. Code sketch of the parts with logic (the JSX of each section follows the `CutawayPanel` pattern: a `pop-title`, `pop-row`s, a `seg pop-seg`, `pop-note`s, `btn sm`):

```tsx
import type { EngineStage } from '@aio/engine';
import { formatBoxSize } from '@aio/engine';
import { ASPRS_CLASSES, cloudWorldBounds } from '@aio/pointcloud';
import {
  DEFAULT_ELM,
  DEFAULT_OUTLIER,
  MAX_REGIONS,
  NOISE_CLASS,
  emptyCleanup,
  type Layer,
  type PointcloudCleanup,
} from '@aio/schema';
import { Icon, useT } from '@aio/ui';
import { useWorkspace, workspace } from '@aio/workspace';
import { useEffect, useRef, useState } from 'react';
import { boxToLocal, fitBox } from './cleanupFrame';
import { defaultJobsDeps, noiseShare, runNoise, saveCleaned } from './cleanupJobs';
import { cleanup, isCleanable, useCleanup } from './cleanupStore';
import './cleanup.css';

type CloudLayer = Extract<Layer, { kind: 'pointcloud' }>;

/** The cloud the panel acts on: the store's, else the selected cloud, else the only one. */
export function useCleanupLayer(): { layer: CloudLayer | null; clouds: CloudLayer[] } {
  const layers = useWorkspace((s) => s.project?.manifest.layers);
  const selected = useWorkspace((s) => (s.selection?.kind === 'layer' ? s.selection.id : null));
  const active = useCleanup((s) => s.active);
  const clouds = (layers ?? []).filter((l): l is CloudLayer => l.kind === 'pointcloud');
  const layer =
    clouds.find((l) => l.id === active) ??
    clouds.find((l) => l.id === selected) ??
    (clouds.length === 1 ? (clouds[0] ?? null) : null);
  return { layer, clouds };
}

export function CleanupPanel({ stage }: { stage: EngineStage | null }) {
  const t = useT();
  const { layer, clouds } = useCleanupLayer();
  const id = layer?.id ?? null;
  const history = useCleanup((s) => (id ? s.layers[id] : undefined));
  const readOnly = useCleanup((s) => s.readOnly);
  const busy = useCleanup((s) => s.busy);
  const shape = useCleanup((s) => s.selectShape);
  const section = useCleanup((s) => s.section);
  const recipe = history?.present ?? null;
  const copc = layer ? isCleanable(layer) : false;
  const can = copc && !readOnly;
  const [error, setError] = useState<string | null>(null);
  // keep the store's active layer in step with what the panel shows
  useEffect(() => {
    if (id && useCleanupActive() !== id) cleanup.setActive(id);
  }, [id]);
  const base = (): PointcloudCleanup => recipe ?? emptyCleanup(id ?? '');
  const commit = (next: PointcloudCleanup | null) =>
    id ? cleanup.commit(id, next) : Promise.resolve(false);
  const bounds = stage && id ? cloudWorldBounds(stage, id) : null;
  // ... sections; see the behaviour list
}
```

(`useCleanupActive()` stands for `cleanup.store.getState().active`; write it inline.)

Height fields keep a local draft (`useState<string>`) per field, commit in `onBlur` and on Enter, parse with `Number.parseFloat`, an empty field removes that end, and a min above max shows `cleanup-error` instead of committing (the schema refuses it).

Noise Undo: `history?.past.length && history.past[history.past.length - 1]?.noise === undefined && recipe?.noise` means the last step was the run: `cleanup.undo(id)`; otherwise commit `{ ...base(), noise: undefined, hiddenClasses: base().hiddenClasses.filter((c) => c !== NOISE_CLASS) }` with the `noise` key deleted (no `undefined` values in a recipe: build the object without the key).

`CleanupHost.tsx`:

```tsx
import type { EngineStage } from '@aio/engine';
import { Icon, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect } from 'react';
import { CleanupPanel } from './CleanupPanel';
import { applyPending, mountCleanupScene } from './cleanupScene';
import { cleanup, useCleanup } from './cleanupStore';

const SHOW_MS = 8000;

/** Loads the open project's recipes, binds the stage tools while the panel is open, draws the panel. */
export function CleanupHost({ engine }: { engine: EngineStage | null }) {
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  const open = useCleanup((s) => s.panelOpen);
  useEffect(() => {
    if (!projectId) return;
    const layers = useWorkspaceLayers();
    void cleanup.load(projectId, layers);
  }, [projectId]);
  useEffect(() => (open && engine ? mountCleanupScene(engine) : undefined), [open, engine]);
  return (
    <>
      {open && <CleanupPanel stage={engine} />}
      {open && <SelectionBar />}
      <CleanupNotice />
    </>
  );
}
```

(`useWorkspaceLayers()` stands for `workspace.getState().project?.manifest.layers ?? []`, read once per project id: a manifest reload after Save cleaned copy must not reset the undo history.) `SelectionBar` renders `pending` with Hide, Delete, Set class and Cancel (each `applyPending(cleanup, action)` or `cleanup.setPending(null)`), and `CleanupNotice` is `ClassNotice` (`classes/ClassNotice.tsx`) with `useCleanup((s) => s.notice)`, `cleanup.undo(notice.layerId)` and `cleanup.dismiss`, test ids `cleanup-notice` and `cleanup-notice-undo`.

`cleanup.css`: `.cleanup-panel` absolute at the top right of the stage under the toolbar (`top: 52px; right: 12px; width: min(300px, calc(100% - 24px)); max-height: calc(100% - 140px); overflow: auto; z-index` like `.stage-pop`), sections separated like `.dmenu-sep`; `.cleanup-bar` bottom centre (`bottom: 16px; left: 50%; transform: translateX(-50%)`), `overlay-box` look; `.cleanup-range` two overlaid ranges with `pointer-events: none` on the track and `auto` on the thumbs; `.flip-x { transform: scaleX(-1); }`. Colours only from the existing tokens (`var(--...)` as `builder/builder.css` and `StageTools` use them); no new colour literals.

- [ ] **Step 4: The toolbar button, the mount and the hooks**

`StageTools.tsx` `CloudTools`: return a fragment with the existing `PopTool` and, after it:

```tsx
<Tool
  icon="boxclip"
  label={t('cleanup.tool')}
  pressed={cleanupOpen}
  testId="cleanup-tool"
  onClick={() => {
    if (cleanupOpen) cleanup.closePanel();
    else cleanup.openPanel();
  }}
/>
```

with `const t = useT();` and `const cleanupOpen = useCleanup((s) => s.panelOpen);` at the top of `CloudTools`, and imports from `../pointcloud/cleanupStore`. (The clouds group folds into More tools at 1100 px; the right-click menu of Task 16 is the other way in.)

`Stage.tsx`, in the 3D pane after `<StageClassLegend view={view} />`: `{!hidden && <CleanupHost engine={engine} />}` (import from `../pointcloud/CleanupHost`).

`bootstrap.ts`, inside `__stratlas`:

```ts
      /** Point cloud cleanup (e2e): the store, the live recipes, drawn points, the stream, a handle. */
      pointcloudCleanup: {
        store: cleanup.store,
        recipes: pointcloudCleanup,
        drawn: (layerId?: string) => {
          const s = getActiveStage();
          return s ? countDrawn(s, layerId) : null;
        },
        source: (layerId: string) => {
          const s = getActiveStage();
          return s ? cloudSourceUrl(s, layerId) : null;
        },
        handle: (h: BoxHandle) => cleanupDebug.handleScreen(h),
      },
```

- [ ] **Step 5: Run the tests and look at it**

Run: `pnpm exec vitest run apps/desktop/src/renderer/pointcloud/CleanupPanel.test.tsx apps/desktop/src/renderer/workspace/StageTools.test.tsx`
Expected: PASS.

Then open the app on a COPC project the e2e way (off-screen fixtures; a short throwaway Playwright script under the scratchpad that launches through `e2e/fixtures.ts`, or the `copc.spec.ts` project) and take one screenshot of the panel at 1100 x 720: the panel must not cover the toolbar or the legends, and a click in the middle of the view must reach the canvas (`document.elementFromPoint`). Look at the screenshot before going on.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/pointcloud/CleanupPanel.tsx apps/desktop/src/renderer/pointcloud/CleanupHost.tsx apps/desktop/src/renderer/pointcloud/cleanup.css apps/desktop/src/renderer/pointcloud/CleanupPanel.test.tsx apps/desktop/src/renderer/workspace/StageTools.tsx apps/desktop/src/renderer/workspace/Stage.tsx apps/desktop/src/renderer/bootstrap.ts
git commit -m "feat(desktop): Clean up panel for point clouds"
```

---

### Task 16: Right-click actions, Apply cleanup on export, per-layer legend

**Packages touched:** desktop renderer.
**Contract change:** no. **E2E:** `pointcloud-clipbox.spec.ts` opens the panel from the menu; `pointcloud-clean-export.spec.ts` uses Apply cleanup.

**Files:**

- Modify: `apps/desktop/src/renderer/shell/DateMenus.tsx:463-660` (`LayerDateMenuProps.actions`, rendering, the empty check)
- Modify: `apps/desktop/src/renderer/shell/DateMenus.test.tsx` (`LayerDateMenu` block, line 266)
- Modify: `apps/desktop/src/renderer/shell/Sidebar.tsx:771-785` (build the actions)
- Modify: `apps/desktop/src/renderer/survey/ExportDialog.tsx` (state, the checkbox after the Level of detail field ~line 425, `choice`)
- Modify: `apps/desktop/src/renderer/workspace/StageLegends.tsx:38-48` (`StageClassLegend`)

**Interfaces:**

- Consumes: Task 14 (`CLEANUP_ACTIONS`, `cleanupActionContext`, `CleanupTarget`); Task 10 (`useCleanup`, `cleanup`); Task 13 (`ExportChoice.cleanup`); Task 1 (`cleanupRemoves`, `isEmptyCleanup`); Task 3 (`pointcloudCleanup`).
- Produces:
  - `interface LayerMenuAction { id: string; label: string; testId: string; danger?: boolean; run(): void }`; `LayerDateMenuProps.actions?: readonly LayerMenuAction[]` (rendered first, a separator after; the menu is not empty when it has actions)
  - test ids `menu-pointcloud-cleanup`, `menu-pointcloud-removeNoise`, `menu-pointcloud-saveCleaned`, `menu-pointcloud-resetCleanup`; `survey-export-cleanup` (checkbox), `survey-export-cleanup-summary`
  - `cleanupSummary(r: PointcloudCleanup): string` in `ExportDialog.tsx` (exported for its test): `t('cleanup.export.removes', { parts })` with the parts joined by `Intl.ListFormat('en', { type: 'conjunction' })`, or `t('cleanup.export.nothing')`

- [ ] **Step 1: Write the failing tests**

In `DateMenus.test.tsx`, inside `describe('LayerDateMenu', ...)`:

```tsx
it('lists the layer actions first and runs them, closing the menu', () => {
  const run = vi.fn();
  const { onClose } = open('oct', true, {
    actions: [
      { id: 'pointcloud.cleanup', label: 'Clean up…', testId: 'menu-pointcloud-cleanup', run },
      {
        id: 'pointcloud.resetCleanup',
        label: 'Reset cleanup',
        testId: 'menu-pointcloud-resetCleanup',
        run,
      },
    ],
  });
  const items = [...document.body.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')];
  expect(items[0]?.getAttribute('data-testid')).toBe('menu-pointcloud-cleanup');
  click('menu-pointcloud-cleanup');
  expect(run).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('opens for actions alone in a read-only project', () => {
  open('oct', false, {
    actions: [
      {
        id: 'pointcloud.cleanup',
        label: 'Clean up…',
        testId: 'menu-pointcloud-cleanup',
        run: vi.fn(),
      },
    ],
    dateMoves: false,
  });
  expect(q('menu-pointcloud-cleanup')).not.toBeNull();
});
```

A new test file `apps/desktop/src/renderer/survey/exportCleanup.test.tsx` (jsdom pragma):

```tsx
// @vitest-environment jsdom
import { emptyCleanup } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { cleanupSummary } from './ExportDialog';

describe('the Apply cleanup line', () => {
  it('says what goes', () => {
    expect(
      cleanupSummary({
        ...emptyCleanup('a'),
        clipBox: { center: [0, 0, 0], size: [1, 1, 1], yaw: 0, keep: 'inside' },
        hiddenClasses: [7, 18],
        regions: [
          {
            id: 'r',
            shape: 'box',
            viewProj: new Array(16).fill(0),
            polygon: [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 1],
            ],
            action: { kind: 'delete' },
          },
        ],
      }),
    ).toBe(
      'Removes points outside the clip box, 1 deleted selection, and the hidden classes (7, 18).',
    );
    expect(cleanupSummary({ ...emptyCleanup('a'), regions: [] })).toBe(
      'Nothing is removed: the cleanup only hides points in the view.',
    );
  });
});
```

Add this file to the Files list and its commit. Also a test for the dialog's behaviour, "hides Apply cleanup for a cloud without a recipe": render `ExportDialog` the way existing dialog tests in `survey/` do (read one first; if none renders `ExportDialog`, test the pure helper `exportCleanupFor(layerId, recipes): PointcloudCleanup | null` that the dialog uses, exported from `ExportDialog.tsx`: it is null for a layer without a recipe or with an empty one, and the recipe otherwise).

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run apps/desktop/src/renderer/shell/DateMenus.test.tsx apps/desktop/src/renderer/survey/exportCleanup.test.tsx`
Expected: FAIL.

- [ ] **Step 3: The menu**

`DateMenus.tsx`:

```tsx
/** A layer command at the top of the menu (point cloud cleanup today; the shared registry later). */
export interface LayerMenuAction {
  id: string;
  label: string;
  testId: string;
  danger?: boolean;
  run(): void;
}
```

`LayerDateMenuProps` gains `/** Commands of the layer, listed first (single-layer menus). */ actions?: readonly LayerMenuAction[] | undefined;`. In `LayerDateMenu`: `const acts = actions ?? [];`, `const empty = !compare && !moves && !del && acts.length === 0;`, the height estimate passed to `usePlace` adds `acts.length * 30`, and at the top of the menu body (inside the `<>` of the `menu` view, after the heading):

```tsx
{
  acts.map((a) => (
    <button
      key={a.id}
      type="button"
      role="menuitem"
      className={`dmenu-item${a.danger ? ' danger' : ''}`}
      data-testid={a.testId}
      onClick={() => {
        onClose();
        a.run();
      }}
    >
      <span>{a.label}</span>
    </button>
  ));
}
{
  acts.length > 0 && (compare || moves || del) && <div className="dmenu-sep" role="separator" />;
}
```

`Sidebar.tsx`, where `LayerDateMenu` is rendered (line 772):

```tsx
          actions={layerActions(itemMenu)}
```

with, in the component body:

```tsx
const cleanupLayers = useCleanup((s) => s.layers);
const layerActions = (m: DateItemMenuRequest): LayerMenuAction[] => {
  const [only] = m.layerIds;
  const layer =
    m.layerIds.length === 1 ? project.manifest.layers.find((l) => l.id === only) : undefined;
  if (!layer) return [];
  const target = {
    layer,
    readOnly: !canEdit,
    hasRecipe: Boolean(cleanupLayers[layer.id]?.present),
  };
  return CLEANUP_ACTIONS.filter((a) => a.applies(target)).map((a) => ({
    id: a.id,
    label: t(a.label),
    testId: `menu-${a.id.replace('.', '-')}`,
    danger: a.id === 'pointcloud.resetCleanup',
    run: () => void a.run(target, cleanupActionContext),
  }));
};
```

(`menu-pointcloud-cleanup`, `menu-pointcloud-removeNoise`, `menu-pointcloud-saveCleaned`, `menu-pointcloud-resetCleanup`.)

- [ ] **Step 4: Apply cleanup in the export dialog**

`ExportDialog.tsx`:

```tsx
/** The layer's recipe when it changes anything (Apply cleanup is offered then), else null. */
export function exportCleanupFor(
  layerId: string | null | undefined,
  recipes: Readonly<Record<string, PointcloudCleanup>>,
): PointcloudCleanup | null {
  const r = layerId ? recipes[layerId] : undefined;
  return r && !isEmptyCleanup(r) ? r : null;
}

export function cleanupSummary(r: PointcloudCleanup): string {
  const x = cleanupRemoves(r);
  const parts: string[] = [];
  if (x.box)
    parts.push(t(x.box === 'outside' ? 'cleanup.part.boxOutside' : 'cleanup.part.boxInside'));
  if (x.height) parts.push(t('cleanup.part.height'));
  if (x.deletes) parts.push(t('cleanup.part.deletes', { count: x.deletes }));
  if (x.hiddenClasses.length)
    parts.push(t('cleanup.part.classes', { list: x.hiddenClasses.join(', ') }));
  if (!parts.length) return t('cleanup.export.nothing');
  return t('cleanup.export.removes', {
    parts: new Intl.ListFormat('en', { type: 'conjunction' }).format(parts),
  });
}
```

Check `Intl.ListFormat('en')` with three parts gives "a, b, and c" (Oxford comma), as the test expects; with two parts "a and b".

In the component: `const recipes = useStore(pointcloudCleanup, (s) => s.recipes);`, `const layerParam = what === 'cloud' ? (source?.param as { layer?: string } | undefined)?.layer : undefined;`, `const recipe = exportCleanupFor(layerParam, recipes);`, `const [applyCleanup, setApplyCleanup] = useState(true);`; `choice` gains `cleanup: recipe && applyCleanup ? recipe : null`; after the Level of detail field:

```tsx
{
  recipe && (
    <label className="sv-check">
      <input
        type="checkbox"
        checked={applyCleanup}
        data-testid="survey-export-cleanup"
        onChange={(e) => {
          setApplyCleanup(e.target.checked);
        }}
      />
      <span>{t('cleanup.export.apply')}</span>
      <span className="small faint" data-testid="survey-export-cleanup-summary">
        {cleanupSummary(recipe)}
      </span>
    </label>
  );
}
```

(match the checkbox markup the dialog already uses for One file per measurement, `survey-export-each`.)

- [ ] **Step 5: The legend edits the selected cloud's classes**

`StageLegends.tsx` `StageClassLegend`:

```tsx
export function StageClassLegend({ view }: LegendProps) {
  const { counts, hidden } = useClassificationLegend(pointcloudSettings, view);
  const active = useCleanup((s) => s.active);
  const own = useStore(pointcloudCleanup, (s) => (active ? s.recipes[active] : undefined));
  const readOnly = useCleanup((s) => s.readOnly);
  return (
    <ClassificationLegend
      className="elev-legend class-legend overlay-box"
      counts={counts}
      hidden={own ? own.hiddenClasses : hidden}
      onToggle={(c) => {
        if (!own || !active) {
          pointcloudSettings.getState().toggleClass(c);
          return;
        }
        if (readOnly) return;
        const set = own.hiddenClasses.includes(c)
          ? own.hiddenClasses.filter((x) => x !== c)
          : [...own.hiddenClasses, c].sort((a, b) => a - b);
        void cleanup.commit(active, { ...own, hiddenClasses: set });
      }}
    />
  );
}
```

(A class toggle is one undo step; the legend's counts stay those of every cloud on screen.)

- [ ] **Step 6: Run the tests**

Run: `pnpm exec vitest run apps/desktop/src/renderer/shell/DateMenus.test.tsx apps/desktop/src/renderer/shell/Sidebar.test.tsx apps/desktop/src/renderer/survey/exportCleanup.test.tsx apps/desktop/src/renderer/survey/exportHelpers.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/shell/DateMenus.tsx apps/desktop/src/renderer/shell/DateMenus.test.tsx apps/desktop/src/renderer/shell/Sidebar.tsx apps/desktop/src/renderer/survey/ExportDialog.tsx apps/desktop/src/renderer/survey/exportCleanup.test.tsx apps/desktop/src/renderer/workspace/StageLegends.tsx
git commit -m "feat(desktop): cleanup in the layer menu, the cloud export and the legend"
```

---

### Task 17: e2e fixture and the three specs

**Packages touched:** `tools/pointcloud`, `@aio/pointcloud` test data, desktop e2e.
**Contract change:** no. **E2E:** this task.

**Files:**

- Modify: `tools/pointcloud/synthetic-cloud.mjs` (an exported generator; an optional outlier count)
- Modify: `tools/pointcloud/README.md` ("Test fixture": the noisy fixture command)
- Create: `packages/pointcloud/test-data/noisy.copc.laz` (binary, generated)
- Create: `apps/desktop/e2e/cleanupHelpers.ts`
- Create: `apps/desktop/e2e/pointcloud-clipbox.spec.ts`
- Create: `apps/desktop/e2e/pointcloud-noise.spec.ts`
- Create: `apps/desktop/e2e/pointcloud-clean-export.spec.ts`

**Interfaces:**

- Consumes: everything user-facing from Tasks 6 to 16; `window.__stratlas.pointcloudCleanup` (Task 15); `e2e/fixtures.ts` (`test`, `expect`, `tinyManifest`, `PIPELINE_ENV`, `hasPipelinePython`, `hasPdal`, `PDAL`); the TS evaluator (`packages/pointcloud/src/cleanup/evaluate.ts`, imported by relative path in node).
- Produces: `synthetic-cloud.mjs` exports `generate(total = 40000, outliers = 0): string[]` (CSV rows with header; the first `total` rows are exactly those of today's script, so `synthetic.copc.laz` regenerates byte for byte); `cleanupHelpers.ts` exports `NOISY_FIXTURE`, `NOISY_POINTS` (16060), `writeNoisyProject(projectDir: string): Promise<void>`, `openNoisyProject(win: Page): Promise<void>`, `openCleanupFromMenu(win: Page): Promise<void>`, `drawn(win: Page): Promise<number>`, `recipeOf(win: Page): Promise<PointcloudCleanup | null>`, `expectedKept(recipe: PointcloudCleanup): number`.

- [ ] **Step 1: The fixture generator**

`tools/pointcloud/synthetic-cloud.mjs`: wrap today's loop in `export function generate(total = 40000, outliers = 0)` returning the rows (header first), keeping the seed and every `rnd()` call in the same order; after the loop, if `outliers > 0`, append `outliers` high points and `Math.floor(outliers / 2)` low points from the same generator:

```js
for (let i = 0; i < outliers + Math.floor(outliers / 2); i++) {
  const high = i < outliers;
  const x = 2 + rnd() * 36;
  const y = 2 + rnd() * 36;
  // isolated: 25 to 40 m over the ground, or 6 to 8 m under it
  const z = high ? 25 + rnd() * 15 : -6 - rnd() * 2;
  const g = Math.round((0.5 + 0.2 * rnd()) * 65535);
  const I = Math.round(rnd() * 60000);
  rows.push(`${(E0 + x).toFixed(3)},${(N0 + y).toFixed(3)},${z.toFixed(3)},${g},${g},${g},${I},1`);
}
```

and run the old main only when the file is the entry point (`if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)`), reading `<out.csv> [points] [outliers]`. Usage line: `node tools/pointcloud/synthetic-cloud.mjs <out.csv> [points] [outliers]`.

Check that nothing changed for the old fixture: `node tools/pointcloud/synthetic-cloud.mjs %TEMP%\a.csv 16000` must give the same file as the script on `main` (compare with `git show main:tools/pointcloud/synthetic-cloud.mjs` run to another file).

- [ ] **Step 2: Build the fixture**

```powershell
node tools/pointcloud/synthetic-cloud.mjs "$env:TEMP\noisy.csv" 16000 40
& 'E:\Dev\tools\pdal\Library\bin\pdal.exe' translate "$env:TEMP\noisy.csv" packages/pointcloud/test-data/noisy.copc.laz -w writers.copc `
  --writers.copc.a_srs=EPSG:32639 --writers.copc.scale_x=0.001 --writers.copc.scale_y=0.001 `
  --writers.copc.scale_z=0.001 --writers.copc.offset_x=auto --writers.copc.offset_y=auto `
  --writers.copc.offset_z=auto
& 'E:\Dev\tools\pdal\Library\bin\pdal.exe' info --summary packages/pointcloud/test-data/noisy.copc.laz
```

Expected: `num_points` 16060. Add the same commands under "Test fixture" in `tools/pointcloud/README.md` ("`noisy.copc.laz`: the same cloud with 40 high and 20 low isolated points, class 1, for the cleanup e2e").

- [ ] **Step 3: The helpers**

`apps/desktop/e2e/cleanupHelpers.ts`:

```ts
/**
 * Point cloud cleanup e2e: the noisy synthetic COPC (tools/pointcloud/synthetic-cloud.mjs with 40
 * outliers, no client data) in the tiny project, the Clean up panel opened from the layer's
 * right-click menu, and the window hooks of bootstrap.ts.
 */
import { ProjectManifest, type PointcloudCleanup, type ProjectManifestInput } from '@aio/schema';
import type { Page } from '@playwright/test';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compileCleanup, evaluateAll } from '../../../packages/pointcloud/src/cleanup/evaluate';
// @ts-expect-error: a plain .mjs tool without types
import { generate } from '../../../tools/pointcloud/synthetic-cloud.mjs';
import { expect, tinyManifest } from './fixtures';

export const NOISY_FIXTURE = join(
  import.meta.dirname,
  '../../../packages/pointcloud/test-data/noisy.copc.laz',
);
export const NOISY_POINTS = 16060;
export const LAYER = 'noisy';

export async function writeNoisyProject(projectDir: string): Promise<void> {
  const base = tinyManifest();
  const manifest: ProjectManifestInput = {
    ...base,
    layers: [
      {
        kind: 'pointcloud',
        id: LAYER,
        name: 'Noisy scan',
        src: { path: 'clouds/noisy.copc.laz' },
        format: 'copc',
        pointCount: NOISY_POINTS,
        capture: base.captures[0]?.id,
      },
    ],
  };
  await mkdir(join(projectDir, 'clouds'), { recursive: true });
  await copyFile(NOISY_FIXTURE, join(projectDir, 'clouds', 'noisy.copc.laz'));
  await writeFile(
    join(projectDir, 'manifest.json'),
    JSON.stringify(ProjectManifest.parse(manifest), null, 2),
  );
}

interface Hooks {
  __stratlas: {
    stage(): {
      restoreView(v: { position: number[]; target: number[] }, animate?: boolean): void;
    } | null;
    pointcloudCleanup: {
      store: { getState(): { layers: Record<string, { present: PointcloudCleanup | null }> } };
      drawn(layerId?: string): { drawn: number; loaded: number } | null;
      source(layerId: string): string | null;
      handle(h: string): { x: number; y: number } | null;
    };
  };
}

export async function openNoisyProject(win: Page): Promise<void> {
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).first().click();
  await expect(win.locator('[data-scene-view] canvas')).toBeVisible();
  // the whole cloud from above and to the south (local frame: the cloud spans x 0..40, z -40..0)
  await win.evaluate(() => {
    (window as unknown as Hooks).__stratlas
      .stage()
      ?.restoreView({ position: [20, 70, 35], target: [20, 0, -20] }, false);
  });
  // 16 060 points in a handful of nodes: every one loads at this view
  await expect.poll(() => drawn(win), { timeout: 30_000 }).toBe(NOISY_POINTS);
}

export async function openCleanupFromMenu(win: Page): Promise<void> {
  const row = win.getByTestId(`tree-row-${LAYER}`);
  // expand the date folder first when the row is folded away (see delete-and-start-over.spec.ts `row`)
  await row.scrollIntoViewIfNeeded();
  await row.click({ button: 'right' });
  await win.getByTestId('menu-pointcloud-cleanup').click();
  await expect(win.getByTestId('cleanup-panel')).toBeVisible();
}

export const drawn = (win: Page): Promise<number> =>
  win.evaluate(
    (id) => (window as unknown as Hooks).__stratlas.pointcloudCleanup.drawn(id)?.drawn ?? 0,
    LAYER,
  );

export const recipeOf = (win: Page): Promise<PointcloudCleanup | null> =>
  win.evaluate(
    (id) =>
      (window as unknown as Hooks).__stratlas.pointcloudCleanup.store.getState().layers[id]
        ?.present ?? null,
    LAYER,
  );

export const sourceOf = (win: Page): Promise<string | null> =>
  win.evaluate((id) => (window as unknown as Hooks).__stratlas.pointcloudCleanup.source(id), LAYER);

export const handleAt = (win: Page, h: string) =>
  win.evaluate((face) => (window as unknown as Hooks).__stratlas.pointcloudCleanup.handle(face), h);

/** How many fixture points a save or an export keeps under `recipe` (the evaluator over every point). */
export function expectedKept(recipe: PointcloudCleanup): number {
  const rows = (generate(16000, 40) as string[]).slice(1).map((r) => r.split(',').map(Number));
  const xyz = rows.flatMap((r) => [r[0] ?? 0, r[1] ?? 0, r[2] ?? 0]);
  const cls = rows.map((r) => r[7] ?? 0);
  const { state } = evaluateAll(compileCleanup(recipe), xyz, cls);
  return state.filter((s) => s <= 1).length;
}
```

The relative imports into `packages/` and `tools/` work in Playwright's TypeScript loader (no bundling); if the e2e `tsconfig` refuses the `.mjs` import, add a `tools/pointcloud/synthetic-cloud.d.mts` declaring `export function generate(total?: number, outliers?: number): string[];` instead of the `@ts-expect-error`.

- [ ] **Step 4: `pointcloud-clipbox.spec.ts` (runs everywhere)**

```ts
/**
 * Point cloud cleanup, the clip box (FUS-9) on the noisy synthetic COPC: opened from the layer's
 * right-click menu, Fit to layer, the east face dragged inward hides the points beyond it, Reset
 * and Undo. No PDAL, no pipeline: runs on every CI shard.
 */
import { expect, test } from './fixtures';
import {
  drawn,
  handleAt,
  openCleanupFromMenu,
  openNoisyProject,
  recipeOf,
  writeNoisyProject,
} from './cleanupHelpers';

test.beforeEach(async ({ dataRoot }) => {
  await writeNoisyProject(dataRoot.projectDir);
});

test('a clip box hides the points outside it, and Reset and Undo bring them back', async ({
  win,
}) => {
  await openNoisyProject(win);
  const all = await drawn(win);
  await openCleanupFromMenu(win);

  // the panel leaves the middle of the view to the view
  const reaches = await win.evaluate(() => {
    const c = document.querySelector('[data-scene-view] canvas');
    const r = c?.getBoundingClientRect();
    return r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === c : false;
  });
  expect(reaches).toBe(true);

  await win.getByTestId('cleanup-box-fit').click();
  await expect.poll(async () => (await recipeOf(win))?.clipBox?.keep).toBe('inside');
  await expect.poll(() => drawn(win)).toBe(all); // the box holds the whole cloud

  await win.getByTestId('cleanup-box-edit').click();
  const east = await handleAt(win, 'east');
  const west = await handleAt(win, 'west');
  if (!east || !west) throw new Error('box handles are off screen');
  // drag the east face half way to the west face
  await win.mouse.move(east.x, east.y);
  await win.mouse.down();
  await win.mouse.move((east.x + west.x) / 2, (east.y + west.y) / 2, { steps: 8 });
  await win.mouse.up();
  await expect.poll(async () => (await recipeOf(win))?.clipBox?.size[0] ?? 0).toBeLessThan(25);
  const cut = await drawn(win);
  expect(cut).toBeLessThan(all * 0.75);
  expect(cut).toBeGreaterThan(all * 0.25);
  await expect(win.getByTestId('cleanup-box-size')).toContainText(' m');

  // Reset all cleanup: one step, every point again
  await win.getByTestId('cleanup-reset').click();
  await expect.poll(() => drawn(win)).toBe(all);
  await expect(win.getByTestId('cleanup-notice')).toContainText('Cleanup reset.');

  // Ctrl+Z brings the cut box back
  await win.keyboard.press('Control+Z');
  await expect.poll(() => drawn(win)).toBe(cut);
});
```

If the fitted box's faces sit off screen at 1100 x 720, set a top view first (`restoreView({ position: [20, 90, -20], target: [20, 0, -20.01] })`): the east and west handles are then left and right of the centre.

- [ ] **Step 5: `pointcloud-noise.spec.ts` (pipeline Python and PDAL)**

```ts
/**
 * Point cloud cleanup, Remove noise (pointcloud.clean, noise mode) on the noisy synthetic COPC: the
 * 60 planted outliers are marked as class 7, the count shows, class 7 is hidden in the legend, the
 * layer streams the working copy, and Undo returns to the original stream. Needs the pipeline
 * Python and PDAL (skipped without them, as on the CI e2e runners).
 */
import { PIPELINE_ENV, PDAL, expect, hasPdal, hasPipelinePython, test } from './fixtures';
import {
  drawn,
  openCleanupFromMenu,
  openNoisyProject,
  recipeOf,
  sourceOf,
  writeNoisyProject,
} from './cleanupHelpers';

test.use({ appEnv: PIPELINE_ENV });
test.skip(!hasPipelinePython(), 'no pipeline Python (uv sync in python/, or QUADRION_E2E_PYTHON)');
test.skip(!hasPdal(), `no PDAL at ${PDAL} (set AIO_PDAL)`);

test.beforeEach(async ({ dataRoot }) => {
  await writeNoisyProject(dataRoot.projectDir);
});

test('Remove noise marks the outliers, hides class 7 and undoes to the original', async ({
  win,
}) => {
  test.setTimeout(240_000);
  await openNoisyProject(win);
  await openCleanupFromMenu(win);
  const before = await drawn(win);
  await win.getByTestId('cleanup-noise-run').click();
  const result = win.getByTestId('cleanup-noise-result');
  await expect(result).toContainText('marked as noise', { timeout: 180_000 });
  const r = await recipeOf(win);
  expect(r?.noise?.marked ?? 0).toBeGreaterThanOrEqual(60);
  expect(r?.hiddenClasses).toContain(7);
  await expect.poll(() => sourceOf(win)).toContain('edits/pointcloud/noisy.noise-');
  await expect.poll(() => drawn(win), { timeout: 30_000 }).toBeLessThan(before);

  // the legend shows class 7 hidden (colour by classification)
  await win.evaluate(() =>
    (
      window as unknown as {
        __stratlas: { pointcloud: { getState(): { setColourMode(m: string): void } } };
      }
    ).__stratlas.pointcloud
      .getState()
      .setColourMode('classification'),
  );
  const legend = win.locator('[data-component="classification-legend"]');
  await expect(legend.getByRole('button', { name: 'Show Low noise' })).toBeVisible({
    timeout: 30_000,
  });

  await win.getByTestId('cleanup-noise-undo').click();
  await expect.poll(async () => (await recipeOf(win))?.noise).toBeUndefined();
  await expect.poll(() => sourceOf(win)).toContain('clouds/noisy.copc.laz');
});
```

- [ ] **Step 6: `pointcloud-clean-export.spec.ts` (pipeline Python and PDAL)**

```ts
/**
 * Point cloud cleanup end to end on the noisy synthetic COPC: a lasso delete and a clip box, Save
 * cleaned copy gives a new layer with the expected point count (the evaluator over the regenerated
 * fixture), and a LAZ export of the original with Apply cleanup holds the same count (read back with
 * PDAL). Needs the pipeline Python and PDAL.
 */
import { execFileSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { PIPELINE_ENV, PDAL, expect, hasPdal, hasPipelinePython, test } from './fixtures';
import {
  expectedKept,
  openCleanupFromMenu,
  openNoisyProject,
  recipeOf,
  writeNoisyProject,
} from './cleanupHelpers';

test.use({ appEnv: PIPELINE_ENV });
test.skip(!hasPipelinePython(), 'no pipeline Python (uv sync in python/, or QUADRION_E2E_PYTHON)');
test.skip(!hasPdal(), `no PDAL at ${PDAL} (set AIO_PDAL)`);

test.beforeEach(async ({ dataRoot }) => {
  await writeNoisyProject(dataRoot.projectDir);
});

test('lasso delete and clip box, saved as a copy and exported with the same points', async ({
  app,
  win,
  dataRoot,
}) => {
  test.setTimeout(300_000);
  await openNoisyProject(win);
  await openCleanupFromMenu(win);

  // a lasso around the lower left of the view, then Delete
  await win.getByTestId('cleanup-select-lasso').click();
  const box = await win.locator('[data-scene-view] canvas').boundingBox();
  if (!box) throw new Error('no canvas');
  const at = (fx: number, fy: number) => [box.x + box.width * fx, box.y + box.height * fy] as const;
  const path = [at(0.2, 0.55), at(0.45, 0.5), at(0.5, 0.8), at(0.25, 0.85)];
  await win.mouse.move(...(path[0] ?? at(0.2, 0.55)));
  await win.mouse.down();
  for (const p of path.slice(1)) await win.mouse.move(...p, { steps: 6 });
  await win.mouse.up();
  await expect(win.getByTestId('cleanup-selection-count')).toContainText('loaded points selected');
  await win.getByTestId('cleanup-delete').click();
  await expect.poll(async () => (await recipeOf(win))?.regions.length).toBe(1);

  // a fitted clip box (it keeps every point) and a height range that drops the high outliers
  await win.getByTestId('cleanup-box-fit').click();
  await expect.poll(async () => (await recipeOf(win))?.clipBox).toBeTruthy();
  // drop the high outliers: Highest 20 m
  await win.getByTestId('cleanup-height-max').fill('20');
  await win.getByTestId('cleanup-height-max').press('Enter');
  await expect.poll(async () => (await recipeOf(win))?.height?.max).toBe(20);

  const recipe = await recipeOf(win);
  if (!recipe) throw new Error('no recipe');
  const expected = expectedKept(recipe);
  expect(expected).toBeLessThan(16060);

  // Save cleaned copy: a new layer with that many points
  await win.getByTestId('cleanup-save-name').fill('Noisy scan');
  await win.getByTestId('cleanup-save').click();
  await expect
    .poll(
      () =>
        win.evaluate(
          () =>
            (
              window as unknown as {
                __stratlas: {
                  workspace: {
                    getState(): {
                      project: {
                        manifest: { layers: { id: string; pointCount?: number }[] };
                      } | null;
                    };
                  };
                };
              }
            ).__stratlas.workspace
              .getState()
              .project?.manifest.layers.find((l) => l.id === 'noisy-cleaned')?.pointCount ?? 0,
        ),
      { timeout: 240_000 },
    )
    .toBe(expected);

  // export the original as LAZ with Apply cleanup: the same points
  const out = join(dataRoot.base, 'exports');
  await app.evaluate(
    ({ dialog }, folder) => {
      dialog.showSaveDialog = (...args: unknown[]) => {
        const opts = (args.length > 1 ? args[1] : args[0]) as { defaultPath?: string };
        const name = String(opts.defaultPath).split(/[\\/]/).pop() ?? 'export';
        return Promise.resolve({ canceled: false, filePath: `${folder}/${name}` });
      };
    },
    out.replace(/\\/g, '/'),
  );
  // open Export survey data as survey-export.spec.ts does (Survey measurements, survey-export-open)
  await win.getByRole('button', { name: 'Survey measurements' }).click();
  await win.getByTestId('survey-export-open').click();
  const dlg = win.getByTestId('survey-export-dialog');
  await dlg.getByTestId('survey-export-what').selectOption('cloud');
  await dlg.getByTestId('survey-export-source').selectOption({ label: 'Noisy scan' });
  await expect(dlg.getByTestId('survey-export-cleanup')).toBeChecked();
  await dlg.getByTestId('survey-export-run').click();
  await expect(dlg.getByTestId('survey-export-note')).toContainText('Saved', { timeout: 120_000 });
  const [file] = (await readdir(out)).filter((f) => f.endsWith('.laz'));
  if (!file) throw new Error('no export');
  const info = JSON.parse(
    execFileSync(PDAL, ['info', '--summary', join(out, file)], { encoding: 'utf8' }),
  ) as {
    summary: { num_points: number };
  };
  expect(info.summary.num_points).toBe(expected);
});
```

Before running, read `survey-export.spec.ts` for how the dialog is opened in a project without survey data: if the tiny project has no **Survey measurements** button, open the dialog through the command palette entry the app has for it, or add `openExportDialog` to `__stratlas` in `bootstrap.ts` (this task owns that one line in B6, no other B6 task touches the file) and call it. The `survey-export-what` and `survey-export-source` controls may be buttons rather than `<select>`s: use what the dialog renders.

- [ ] **Step 7: Run the specs the CI way**

From `apps/desktop` of this worktree, as in "End to end" above (demo build, the CI environment variables, the scratch venv, `AIO_PDAL`), first `--list`, then:

```powershell
npx playwright test e2e/pointcloud-clipbox.spec.ts e2e/pointcloud-noise.spec.ts e2e/pointcloud-clean-export.spec.ts --workers=1
npx playwright test e2e/pointcloud-clipbox.spec.ts --workers=1 --repeat-each=3
```

Expected: 3 passed (or the two pipeline specs skipped with their reasons when the scratch venv or PDAL is missing; then they must be run before hand-off on a machine that has them). Also run the specs this branch touches indirectly: `e2e/copc.spec.ts`, `e2e/change-cloud.spec.ts`, `e2e/survey-export.spec.ts`, `e2e/timeline.spec.ts` (the layer menu), with the same command.

- [ ] **Step 8: Commit**

```bash
git add tools/pointcloud/synthetic-cloud.mjs tools/pointcloud/README.md packages/pointcloud/test-data/noisy.copc.laz apps/desktop/e2e/cleanupHelpers.ts apps/desktop/e2e/pointcloud-clipbox.spec.ts apps/desktop/e2e/pointcloud-noise.spec.ts apps/desktop/e2e/pointcloud-clean-export.spec.ts
git commit -m "test(e2e): point cloud clip box, noise run and cleaned copy with export"
```

(add `apps/desktop/src/renderer/bootstrap.ts` and `tools/pointcloud/synthetic-cloud.d.mts` to the list if Step 3 or 6 needed them.)

---

### Task 18: Pack bump, PDAL drivers, docs and the guide

**Packages touched:** `tools/pipeline-pack`, `python/` (version), desktop main tests, docs.
**Contract change:** no (the version constant of row 3). **E2E:** none.

**Files:**

- Modify: `tools/pipeline-pack/pdal.mjs:68-80` (`DRIVERS`), `tools/pipeline-pack/pdal.test.mjs`
- Modify: `python/pyproject.toml:3`, `python/uv.lock`
- Modify: `packages/schema/src/pointcloudCleanup.ts` (`POINTCLOUD_CLEAN_MIN_PACK`, only if the version is 0.11.0)
- Modify: `apps/desktop/src/main/jobs/packVersions.test.ts` (`BEFORE`, if the pack handed over before changes)
- Modify: `docs/guide/03-scene.md` (a section after "Point clouds"), `docs/guide/12-settings.md:30`, `docs/KNOWN-LIMITS.md`, `docs/TESTING.md`, `docs/architecture/data-conventions.md` (section 35)

**Interfaces:**

- Consumes: the merged state of `main` at merge time (whether the engineering-model branch landed pack 0.10.0).
- Produces: the pack version `V` (0.10.0, or 0.11.0 if `main` already has a 0.10.0 pack), `POINTCLOUD_CLEAN_MIN_PACK === V`, `DRIVERS` with `filters.outlier` and `filters.elm`.

- [ ] **Step 1: Decide the version**

```bash
git fetch origin
git show origin/main:python/pyproject.toml | sed -n 3p
```

If `main` says `version = "0.9.0"`, `V` is 0.10.0; if it says `0.10.0` (the engineering-model branch landed first), `V` is 0.11.0. (Agreed between the two branches in the spec: the first to merge takes 0.10.0.)

- [ ] **Step 2: Write the failing driver test**

Append to `tools/pipeline-pack/pdal.test.mjs` (its imports already bring `DRIVERS` in, or add it to the import from `./pdal.mjs`):

```js
describe('the drivers the pipelines need', () => {
  it('include the noise filters of point cloud cleanup', () => {
    expect(DRIVERS).toEqual(
      expect.arrayContaining(['filters.outlier', 'filters.elm', 'readers.copc', 'writers.las']),
    );
    for (const d of DRIVERS) expect(d).toMatch(/^(readers|writers|filters)\.[a-z0-9_]+$/);
    expect(new Set(DRIVERS).size).toBe(DRIVERS.length);
  });
});
```

Run: `pnpm exec vitest run tools/pipeline-pack/pdal.test.mjs`. Expected: FAIL.

- [ ] **Step 3: Drivers, version, lock**

`pdal.mjs`: add `'filters.outlier',` and `'filters.elm',` to `DRIVERS` and `cleanup` to the comment's list of pipelines. `checkPdal` then also requires them of an installed PDAL (`pdal --drivers`): check the workstation's PDAL once, `node -e "import('./tools/pipeline-pack/pdal.mjs').then(m => console.log(m.checkPdal('E:/Dev/tools/pdal/Library/bin/pdal.exe')))"`, expected `missing: []`.

`python/pyproject.toml`: `version = "V"`. Then from `python/`: `uv lock --offline` (it only rewrites the project's own version in `uv.lock`; it must not touch any venv: no `uv sync`, no `uv run`). Check `git diff python/uv.lock` shows the version line of `aio-pipelines` only. `APP_RANGE` in `python/src/aio_pipelines/__init__.py` stays `>=0.16.0 <2.0.0` (asserted by `test_app_range.py`).

If `V` is 0.11.0: `POINTCLOUD_CLEAN_MIN_PACK = '0.11.0'` in `pointcloudCleanup.ts` (the only place).

`packVersions.test.ts`: its tests read the versions from the files; update `BEFORE` only if the pack handed over to the founder before this one changed (ask the coordinator; with 0.11.0 it is the engineering-model pack 0.10.0 and its `APP_RANGE`).

Run: `pnpm exec vitest run tools/pipeline-pack/pdal.test.mjs apps/desktop/src/main/jobs/packVersions.test.ts apps/desktop/src/main/pointcloudCleanup.test.ts packages/schema/src/pointcloudCleanup.test.ts` and from `python/` `-m pytest tests/test_app_range.py`. Expected: PASS.

- [ ] **Step 4: Docs and the guide**

`docs/guide/03-scene.md`, a new section after "## Point clouds":

```markdown
## Clean up a point cloud

Click **Clean up the point cloud** in the stage toolbar (next to **Point cloud**), or right-click a point cloud in **Datasets** and pick **Clean up…**. The panel works on the selected cloud; with several clouds, pick one at the top. Cleanup works on COPC clouds only: convert others first.

Nothing is rewritten while you clean up. Every change is one step you can undo with **Undo** (**Ctrl+Z**) and redo with **Redo** (**Ctrl+Shift+Z**), and the points come back when you undo.

- **Clip box**: **Fit to layer** puts a box around the cloud. **Edit box** shows handles: drag a face to move it (in steps of 10 cm), drag the ring above the box to turn it. **Keep** **Inside** or **Outside**. **Remove box** takes it away. The box works together with the section plane.
- **Height range**: type the lowest and highest elevation, or drag the two handles of the slider. Points outside are hidden.
- **Select points**: pick **Box** or **Lasso** and drag over the view (**Esc** cancels). The bar says how many of the loaded points you caught, then **Hide** (only in the view), **Delete** (left out of saves and exports) or **Set class**. A selection reaches through the whole cloud along your view, also the points not loaded yet.
- **Remove noise**: finds stray points in the air and under the ground and marks them as class 7 (Low noise), which is then hidden. It runs as a job; the panel then says how many points it marked. **Settings** has the number of neighbours, the distance limit and **Also mark low points**. **Undo** takes the run back.
- **Save cleaned copy**: writes a new point cloud layer, "<name> (cleaned)", without the deleted, clipped and hidden-class points. The original is hidden and its file is never changed.
- **Reset all cleanup** starts over (also one step you can undo). The Classification legend shows and hides the classes of the cloud you clean up.

Exporting a cloud with a cleanup (**Survey measurements**, **Export**) has **Apply cleanup**, on by default, with a line that says what it removes.

**Remove noise** and **Save cleaned copy** need the processing tools {version} or later (see [Processing tools](12-settings.md#processing-tools)).
```

(write the real version `V` for `{version}`; check the anchor name of the processing tools section in `12-settings.md`.)

`docs/guide/12-settings.md:30`: after "Drone panoramas need version 0.7.0 or later." add " Removing point cloud noise and saving cleaned copies need version V or later."

`docs/KNOWN-LIMITS.md`, new bullets:

- **Point cloud cleanup: COPC only.** The clip box, height range, selections and noise run work on COPC clouds; `png-packed` and kit clouds show a hint. Convert them to COPC first.
- **Point cloud cleanup: older versions.** A project with a cleaned copy (a layer saved by **Save cleaned copy**) does not open in version 0.15 or earlier: their manifest check does not know the cleaned copy's record. Projects without one open as before.
- **Remove noise holds the whole cloud in memory.** PDAL's outlier filter reads every point (about 100 bytes a point: 2 GB for 20 million). Very large clouds may need a tiled conversion first.
- **Selections reach through the cloud.** A box or lasso selects every point that falls inside it in the view it was drawn in, near and far, also the points not loaded at the time. Undo a selection that caught too much.
- **Packages carry recipes, not working copies.** A package of a project keeps each cloud's cleanup recipe but not the noise working copy, so noise marks are not shown there; save a cleaned copy before packaging.
- **Cleanup of a large cloud is not shared in a team folder as one step.** Each step rewrites the layer's recipe file (last writer wins, like other whole-file records).

`docs/TESTING.md`: a row in the milestone table ("Point cloud cleanup | Clip box, height range, box and lasso selections, Remove noise, Save cleaned copy, Apply cleanup on export, right-click actions | The build of this branch with pipeline pack V | Built; not yet tested by the founder") and a section with the checklist of "How to test" below (each step a `- [ ]` item), in the style of the other milestone sections.

`docs/architecture/data-conventions.md`, a new section "## 35. Point cloud cleanup (`edits/pointcloud/`)":

```markdown
## 35. Point cloud cleanup (`edits/pointcloud/`)

    edits/pointcloud/<layer>.json                       aio.pccleanup/1: the cleanup recipe of one point cloud layer
    edits/pointcloud/<layer>.json.bak                   the recipe before the last write (or after Reset)
    edits/pointcloud/<layer>.noise-<job>.copc.laz       a noise run's working copy: every point, noise as class 7
    edits/pointcloud/<layer>.noise-<job>.json           that run's record (NoiseRun: path, params, marked, total, runId)

- The recipe (`PointcloudCleanup`, `packages/schema/src/pointcloudCleanup.ts`) is in world coordinates of the project CRS: an optional clip box (centre, size along its east, north and up axes, yaw about +Z counter-clockwise from above, keep inside or outside), an optional height range, the hidden classes (they replace the global ones for this layer), up to 200 selections (NDC polygon and the world-to-clip matrix of the view they were drawn in; hide, delete or set class) and the noise run in use.
- Evaluation per point: class (from the noise copy when there is one); the selections in order (later ones win on class); outside the box or the height range: dropped; a hidden class: hidden. One outcome per point, dropped > deleted > class hidden > hidden > kept. The viewer draws only kept points; a save or an export writes kept points and points hidden by a hide selection, with their new class. `packages/schema/test-data/pccleanup-vectors.json` holds the cases both evaluators are tested against.
- Written only through IPC `pointcloud:writeCleanup` (atomic with a `.bak`, journaled as one labelled `record.external` op per step; refused for packages). Noise copies no step of the renderer's undo history names move to the project trash (section 33) on the next write. A recipe whose layer is gone is removed when the project opens.
- `pointcloud.clean` with `mode: save` writes `clouds/<layer>-cleaned[-n].copc.laz` and a layer with `derived: { kind: 'cleanup', source: [<layer>], runId }`; the source layer is hidden, its file untouched. A cleaned copy is not removed with its source and takes part in cloud change like an imported cloud.
```

Run the public-text check on every doc touched: `node tools/agent/check-public-text.mjs docs/guide/03-scene.md docs/guide/12-settings.md docs/KNOWN-LIMITS.md docs/TESTING.md docs/architecture/data-conventions.md` (expected: no findings), then `pnpm exec prettier --write` on them.

- [ ] **Step 5: Commit**

```bash
git add tools/pipeline-pack/pdal.mjs tools/pipeline-pack/pdal.test.mjs python/pyproject.toml python/uv.lock docs/guide/03-scene.md docs/guide/12-settings.md docs/KNOWN-LIMITS.md docs/TESTING.md docs/architecture/data-conventions.md
git commit -m "chore(pipelines): pack V with the PDAL noise filters; cleanup docs and guide"
```

(add `packages/schema/src/pointcloudCleanup.ts` and `apps/desktop/src/main/jobs/packVersions.test.ts` when Step 3 changed them; write the real version in the subject.)

---

## Final checks (coordinator, after B6)

- [ ] `pnpm check` green on the branch.
- [ ] The whole Python suite from `python/` with the main venv read-only (`PYTHONPATH=src;tests`), `AIO_PDAL` set: `-m pytest` (the photo part can be left to CI if the founder needs the machine; ask first, founder rule on heavy runs); then the import-path check.
- [ ] The three new specs and the touched specs the CI way (Task 17 Step 7), one run at a time.
- [ ] `node tools/agent/check-public-text.mjs` on the plan's docs and every commit subject of the branch (`node tools/agent/finish-task.mjs` does the latter).
- [ ] The founder confirms the forward-compatibility break of contract row 2 (or picks the alternative in "Self-review notes") before the merge.

## How to test (for the founder)

Use the build of this branch with the pipeline pack V installed (**Settings**, **Processing tools**, **Status** shows V).

1. Open a project with a COPC point cloud (or import a LAS file: it becomes COPC). In **Datasets**, right-click the cloud: the menu has **Clean up…**, **Remove noise…**, **Save cleaned copy…** (and **Reset cleanup** once you changed something). Click **Clean up…**: the Clean up panel opens on the right of the 3D view.
2. **Clip box**: click **Fit to layer**, then **Edit box**. Drag the orange handle on one side inward: points beyond the box disappear as you drag; the size line updates. Drag the ring above the box: the box turns. Click **Outside**: now only what is outside the box shows. Press **Ctrl+Z**: the last change goes back.
3. **Height range**: type a lowest and highest elevation, press **Enter**: points above and below disappear. **Clear** brings them back.
4. **Select points**: click **Lasso**, drag around a car or a scaffold. The bar at the bottom says how many loaded points you caught. Click **Delete**: they disappear, and a notice offers **Undo**. Try **Set class**, **Building**, on another selection with **Colour by Classification**: the points turn red.
5. **Remove noise**: click **Remove noise**. A job runs (the jobs tray shows it). Then the panel says "N points (x %) marked as noise" and the stray points in the air are gone. Open the Classification legend: **Low noise** is hidden; click it to see what was marked. **Undo** next to the result brings the original back.
6. **Save cleaned copy**: type a name, **Save**. A new layer "<name> (cleaned)" appears in **Datasets** when the job is done; the original is hidden. Show the original again: it is unchanged.
7. **Export**: **Survey measurements**, **Export**, **Point cloud**, pick the original cloud: **Apply cleanup** is ticked with a line saying what it removes. Export as LAZ and open it in another viewer: the deleted and clipped points are not in it.
8. Close and reopen the project: the cleanup is still there (Undo history starts fresh). Right-click the cloud, **Reset cleanup**: everything shows again, with **Undo** in the notice.
9. With an older pipeline pack, **Remove noise** says the processing tools need V or later; the clip box, height range and selections still work.

## Self-review notes

- **Spec coverage:** goals 1 to 6 map to Tasks 5 to 7 and 15 (clip box), 11, 14 and 15 (noise), 8, 14 and 15 (selection), 5, 14 and 15 (height range), 12 and 13 (save and export), 14 and 16 (menu). Section 2 (undo) is Task 10 with the keys of Tasks 2 and 14; section 6 (errors and limits) is in Tasks 9 to 12 and the KNOWN-LIMITS bullets of Task 18; the testing list of the spec is in Tasks 1 to 17.
- **Resolved in this plan (spec ambiguities):**
  1. The spec calls every contract change additive, but `LayerDerived` is strict: 0.15 and earlier refuse a manifest holding a `derived.kind: 'cleanup'` layer. The plan keeps the spec's record and pins the break (contract row 2, compat test, KNOWN-LIMITS). If the founder wants strict additivity, drop `'cleanup'` from the enum (Task 1) and write the copy without `derived` (Task 12, one dict entry); provenance is then only the layer name.
  2. Following the spec's `derived.source` literally would delete the cleaned copy together with its source (`removePlan`) and leave it out of cloud change (`isCloud` skips derived clouds). Task 9 makes a cleaned copy stand alone in both.
  3. The job record carries no result, so the noise run's `{ path, marked, total }` is committed as a record file beside the working copy and read through `pointcloud:readCleanup` with `noiseRun` (no third channel).
  4. "The working copy moves to .trash on the next save": main cannot see the renderer's redo steps, so `pointcloud:writeCleanup` takes `keep` (the copies the history names) and trashes only the others.
  5. "A toolbar button next to Cutaway": Cutaway sits in the video group, which has nothing to do with clouds; the button goes in the point cloud group beside **Point cloud**, and the right-click menu reaches the panel when that group folds into More tools.
  6. The spec's pack message reads "Settings > Processing tools"; the app's existing sentence ("Update them in Settings, Processing tools.") is used, as walks and panoramas do.
  7. Remove noise and Save cleaned copy from the right-click menu open the panel at their section (the run needs settings and the save a name), which the ellipsis in their labels promises.
  8. A noise run that marks nothing does not add a step (nothing to undo) and says so; its unused copy is trashed on the next write.
- **Type consistency:** `PointcloudCleanup`, `NoiseRun`, `CleanupRegion` and `RegionAction` come from `@aio/schema` everywhere; `CleanupUniforms` from `material.ts`; `ClipBoxLocal` from `@aio/engine`; `PendingSelection.viewProj` is world to clip, `PointSelection.viewProj` local to clip, converted once in `cleanupScene.ts`.
- **Known gaps:** the panel's two-thumb slider is covered by the component test of the fields and by the founder walkthrough only.
