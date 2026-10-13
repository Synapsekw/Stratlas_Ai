# Drone panoramas P1: import and stitch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pick a folder of DJI drone frames, find the sphere panoramas in it, copy each sphere's frames into the project, show one marker per sphere at once, and stitch each sphere in the background with a new `pano.stitch` pipeline into a level, north-up equirect that opens in the existing sphere view.

**Architecture:** The scan and grouping run in the app (pure TypeScript in `@aio/project`, driven by `panos:scan` in main); the import copies frames to `panoramas/<layerId>/<panoId>/frames/`, writes one ordinary `panoramas` layer (items `stitch.status: 'queued'`) and starts one `pano.stitch` job per sphere. The Python pipeline (`python/src/aio_pipelines/pano/`) seeds rotations from the gimbal angles, matches SIFT features only between overlapping frames, runs a rotation-only bundle adjustment with one shared focal length (falling back to the seeds), and composes with OpenCV's `detail` module. Main files each job's outcome into the manifest before it tells the renderer, and reconciles finished stitches again when a project opens.

**Tech Stack:** TypeScript, zod 4, React, zustand, Vitest, Playwright (Electron); Python 3.13, numpy, OpenCV 5 headless (`cv2.SIFT_create`, `cv2.findHomography`, `cv2.detail`), scipy `least_squares`, Pillow; pytest.

**Spec:** `docs/plans/2026-10-13-drone-panoramas-design.md` (approved 13 Oct 2026; section "P0 findings (13 Oct 2026)" amends the thresholds, the fallback and the compose choices). Read both. Phase P1 only: P2 (viewer header, set north, hops, date strip), P3 (rename, restitch from the tree, details, export, removal and trash, packages) and P4 (Augment panel) are out of scope.

## Global Constraints

- **Output size:** `pano.jpg` is **8192 x 4096** by default (Standard); **16384 x 8192** (High) is offered only on GPUs whose WebGL `MAX_TEXTURE_SIZE` is at least 16384, and the option is hidden elsewhere (founder answer 3). JPEG quality 90; `thumb.jpg` 512 x 256.
- **Grouping thresholds** are named constants in `PANO_GROUPING` (`packages/project/src/builder/panoGroups.ts`), each marked "tuned by P0": horizontal **5 m**, vertical **3 m**, gap **30 s** (P0: was 60 s), at least **8 frames**, yaw coverage at least **270 degrees** for a sphere, **150 to 270 degrees** for a wide panorama, at least **2 pitch rows** (a row is at least 2 frames within **8 degrees** of pitch, so the lone nadir frame is not a row).
- **Stitch fallback** (P0): a frame without matches keeps its seed rotation; the whole sphere falls back to `aligned: 'metadata'` only when the **median** residual at the 1600 px working width exceeds **2 px** or any matched frame turns more than **5 degrees** from its seed. The adjustment refines one shared focal length.
- **Compose choices** (P0): exposure compensation `GAIN`; seams `DpSeamFinder('COLOR_GRAD')` on a small copy (scale 0.25 up to 8K, 0.125 above); multi-band blend; frames crossing the 180 degree meridian are split at the wrap; the sky fill is a heavily smoothed low-frequency gradient (wrap-around box blur over 1/12 of the width), written strip by strip so 16K never holds a float copy of the canvas.
- **Step weights** follow the P0 timings (8K, 24 cores, about 25 s per sphere): `read` 0.2, `seed` 0.1, `match` 5.7, `adjust` 6.0, `compose` 10.5, `fill` 2.4, `write` 1.0.
- **Raw frames never become map items**: they live only in `panoramas/<layerId>/<panoId>/frames/`, are not a photos layer, not `PanoRef` items and not in the manifest. One sphere is one marker from the moment of import.
- **Files per sphere:** `panoramas/<layerId>/<panoId>/frames/`, `pano.jpg`, `thumb.jpg`, `stitch.json` (`aio.pano-stitch/1`). The pipeline writes only `pano.jpg`, `thumb.jpg` and `stitch.json` there; the app alone writes the manifest.
- **No new layer kind.** One import is one `panoramas` layer bound to a survey date through `capture`.
- **Public repository:** no client, site, tester or person names, and no real imagery, in code, fixtures, test names, commit messages or docs. Fixtures are generated (`python/tests/pano_synth.py`); real folders are read only by tests gated on `QUADRION_PANO_REFERENCE` (never set in CI). Use generic synthetic coordinates only.
- **Windows only** (macOS parked). Python reads and writes images through `np.fromfile` + `cv2.imdecode` and `cv2.imencode` + `atomic_write_bytes`, never `cv2.imread`/`cv2.imwrite` (they fail on non-ASCII Windows paths).
- **One heavy run at a time:** e2e with `--workers=1`, one Playwright run at a time, pytest runs of the stitch tests one at a time; no benchmark runs by agents.
- Environment variables are `QUADRION_*`: `QUADRION_PANO_WIDTH` (test-only output width override, 512 to 16384, read by the pipeline), `QUADRION_PANO_REFERENCE` (local real-data folders).
- No em or en dashes in user-facing text (`i18n.test.ts` enforces it). Conventional commits ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; never `--no-verify`.
- Python tests sit directly in `python/tests/` (`tools/ci/pytest-parts.test.mjs`); each under the 300 s pytest timeout.

## Review Focus

1. **The same folder imported twice** (or a second card dump that repeats spheres): the scan marks a sphere whose frames (file name and size) already sit in a project pano layer as "Already in <layer>", unchecked by default, so nobody gets duplicate markers. Test in Task 7 (`knownPanoFrames` + `markAlreadyImported`) and Task 8 (scan answer).
2. **Not enough disk space for the copy** (a card folder is 2 to 3 GB): the import refuses before copying anything, naming what it needs and what is free, and leaves no half-copied folder or layer. Test in Task 7.
3. **A sphere whose `frames/` lost files before its stitch ran** (folder cleaned by hand, project copied without frames): the job fails with "The frames of this panorama are missing." when fewer than 8 readable frames remain, and the item shows failed, not a crash or an empty image. Test in Task 6.
4. **A project path with non-ASCII characters** (`Projets été`, `Проект`): every frame reads and `pano.jpg` writes. Test in Task 6 (the end-to-end job run in a `tmp_path / "Projet été"` folder).
5. **The renderer saving the manifest while a stitch finishes** (a visibility toggle at the same moment): main files the outcome with a read-change-save of the fresh manifest and only then forwards the job event, so the renderer reloads a manifest that holds both. Test in Task 8 (`fileThenSend` ordering and `applyStitchOutcome` keeping unrelated edits).

## Contract changes (rows written into `docs/architecture/contract-changes.md` in Task 1)

| Date       | Change                                                                                                                                                                                                                                                                                                                                                                                                              | Why                                                                   | Streams affected                             | Approved by            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------- | ---------------------- |
| 2026-10-13 | Additive: `PanoRef` gains optional `name`, `capturedAt` (ISO), `stitch` (`PanoStitchState`: optional `run` job id, `status` `queued`, `running`, `done` or `failed`, optional `error`) and `cov` (`PanoCov`: `top`, `bottom`, optional `left` and `right` yaw range for a wide panorama). An older build parses the item and drops the fields when it saves; the pano stays a plain pano                            | Drone panoramas P1: one marker per sphere with its stitch status      | `@aio/schema`, engine, renderer, main        | pending founder review |
| 2026-10-13 | Additive: `PipelineName` gains `pano.stitch` with `PanoStitchParams` (`layer`, `pano`, optional `quality` `standard` or `high`). Older builds' job index skips jobs of a pipeline they do not know, as for `walk.process`                                                                                                                                                                                           | Stitch one sphere per job                                             | `@aio/schema`, pipeline pack, main, renderer | pending founder review |
| 2026-10-13 | Additive: new file family `aio.pano-stitch/1` (`PanoStitchFile`, `panoramas/<layer>/<pano>/stitch.json`: `run`, `layer`, `pano`, `createdAt`, `engine`, `quality`, `shape` `sphere` or `wide`, `size`, `frames` used and dropped, `aligned` `features` or `metadata`, `residualPx`, `maxDriftDeg`, `focalScale`, `coverage`, `timings`, `warnings`); `versions.ts` row `home: project`; data-conventions section 34 | The run record of a stitch                                            | `@aio/schema`, pipeline pack                 | pending founder review |
| 2026-10-13 | Pipeline pack 0.7.0 is the minimum for `pano.stitch` (`PANO_STITCH_MIN_PACK`); `jobs:start` refuses `pano.stitch` on an older pack with the "update the processing tools" message walks use. The GPU add-on lock's `packRange` widens to `>=0.5.0 <0.8.0`                                                                                                                                                           | Ship the pipeline                                                     | pipeline pack, main, add-on                  | pending founder review |
| 2026-10-13 | IPC additive: `panos:scan` (`{ projectId, paths }` to `{ ok, scan: PanoScan }`), `panos:import` (`{ projectId, scanId, keys, layerName, date?, quality }` to `{ ok, manifest, layerId, started, notStarted? }`), `panos:cancelImport`; event `panos:progress` (`{ projectId, phase: 'scan' or 'copy', done, total, file }`); `builder:import` request gains optional `exclude` (absolute files to leave out)        | Scan and import of drone panoramas; Add data leaves sphere frames out | `@aio/schema`, preload, main, renderer       | pending founder review |
| 2026-10-13 | `@aio/workspace` additive: state `panoRequest` (`{ seq, layer, id } \| null`) and action `openPano(layer, id)`, which the panoramas adapter answers by entering that pano's sphere view                                                                                                                                                                                                                             | Open from a Datasets row                                              | `@aio/workspace`, engine, renderer           | pending founder review |

## Package ownership per task

| Task | Packages / folders                                                                                                                                                                                                                                                                                        |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1   | `packages/schema/src/{panoStitch.ts,panoStitch.test.ts,layers.ts,jobs.ts,ipc.ts,versions.ts,index.ts,__fixtures__/pano/}`, `packages/ui/src/i18n/en.ts`, `apps/desktop/src/preload/index.ts`, `tools/compat/pano-stitch-additive.test.mjs`, `docs/architecture/{contract-changes.md,data-conventions.md}` |
| T2   | `packages/project/src/builder/{panoGroups.ts,panoGroups.test.ts,panoGroups.realdata.test.ts,panoScan.ts,panoScan.test.ts,exif.ts,exif.test.ts,index.ts}`                                                                                                                                                  |
| T3   | `python/src/aio_pipelines/pano/{__init__.py,geometry.py,frames.py}`, `python/tests/{pano_synth.py,test_pano_geometry.py,test_pano_synth.py}`                                                                                                                                                              |
| T4   | `python/src/aio_pipelines/pano/align.py`, `python/tests/test_pano_align.py`                                                                                                                                                                                                                               |
| T5   | `python/src/aio_pipelines/pano/compose.py`, `python/tests/test_pano_compose.py`                                                                                                                                                                                                                           |
| T6   | `python/src/aio_pipelines/pano/{record.py,pipeline.py}`, `python/src/aio_pipelines/pipelines.py`, `python/tests/test_pano_stitch.py`                                                                                                                                                                      |
| T7   | `packages/project/src/builder/{panos.ts,panos.test.ts}` (and one export block in `index.ts`, after T2's)                                                                                                                                                                                                  |
| T8   | `apps/desktop/src/main/{panos.ts,panos.test.ts,index.ts,builder.ts,builder.test.ts,project.ts}`                                                                                                                                                                                                           |
| T9   | `packages/workspace/src/{index.ts,index.test.ts}`, `packages/engine/src/adapters/{panoramas.ts,panoramas.test.ts,markers.ts,panoMath.ts,panoMath.test.ts}`                                                                                                                                                |
| T10  | `apps/desktop/src/renderer/panos/{panos.ts,panos.test.ts,PanoImportDialog.tsx,PanoImportDialog.test.tsx}`, `apps/desktop/src/renderer/shell/Palette.tsx`, `apps/desktop/src/renderer/App.tsx`, `apps/desktop/src/renderer/panos/panos.css`                                                                |
| T11  | `apps/desktop/src/renderer/panos/{panoModel.ts,panoModel.test.ts,PanoSphereRows.tsx,PanoSphereRows.test.tsx,panoJobs.ts,panos.css}`, `apps/desktop/src/renderer/jobs.ts`, `apps/desktop/src/renderer/shell/Sidebar.tsx` (no `@aio/ui` change: the rows use the tree's `rowExtra` slot)                    |
| T12  | `apps/desktop/src/renderer/builder/{state.ts,ImportPanel.tsx,panoOffer.test.ts}`                                                                                                                                                                                                                          |
| T13  | `python/pyproject.toml`, `python/uv.lock`, `tools/pipeline-pack/accelerator-lock.json` (add-on 0.1.1, `packRange <0.8.0`), `tools/release/budgets.mjs`                                                                                                                                                    |
| T14  | `apps/desktop/e2e/{panoSynth.ts,drone-panoramas.spec.ts,drone-panoramas-photos.spec.ts}`                                                                                                                                                                                                                  |
| T15  | none (verification and hand-off)                                                                                                                                                                                                                                                                          |

## Execution DAG

```
T1 contracts ──┬─► T2 grouping ──► T7 import+filing ──► T8 main ──────────────┐
               ├─► T9 workspace+markers ──┐                                    │
               └─► T10 import dialog ─────┼─► T11 tree rows ──────────────────┤
                                          └─► T12 photo detector ─────────────┤
T3 geometry+synth ──┬─► T4 align ──┐                                           ▼
                    └─► T5 compose ┴─► T6 pano.stitch pipeline ─────────────► T14 e2e ──► T15 verify
T13 pack 0.7.0 ───────────────────────────────────────────────────────────────┘
```

| Batch | Tasks (dispatch in one message) | Depends on                                         | Shared files                                                                            |
| ----- | ------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------- |
| B1    | T1, T3, T13                     | none                                               | none                                                                                    |
| B2    | T2, T4, T5, T9, T10             | T2, T9, T10: T1; T4, T5: T3                        | none                                                                                    |
| B3    | T6, T7, T11, T12                | T6: T1, T4, T5; T7: T1, T2; T11: T9, T10; T12: T10 | none (T11 appends to `panos/panos.css`, which T10 created in B2; T12 does not touch it) |
| B4    | T8                              | T1, T2, T7                                         | none                                                                                    |
| B5    | T14                             | T6, T8, T9, T10, T11, T12, T13                     | none                                                                                    |
| B6    | T15                             | all                                                | none                                                                                    |

**Critical path:** T1 → T2 → T7 → T8 → T14 → T15. The Python chain T3 → T4 → T6 runs beside it and is about as long; start T6 as soon as T4 and T5 pass review.

Size: S under half a day, M about a day, L two days. T1 M, T2 M, T3 M, T4 L, T5 L, T6 M, T7 M, T8 L, T9 M, T10 L, T11 M, T12 S, T13 S, T14 M, T15 S. Roughly 15 agent-days, about 6 days elapsed with the batches.

## P0 values in this plan

The P0 probe (13 Oct) set the values above; the spec's "P0 findings" section records them. Every threshold is a named constant with a "tuned by P0" comment. If a later probe report changes a value, the owning task has a step "update from the P0 report": change the constant and its test expectation together, nothing else.

## Decisions this plan makes where the spec is silent

1. **`PanoRef.stitch.run` is optional.** A sphere is queued before a job exists (no pack yet, or the pack is too old); the row then offers **Stitch**.
2. **`headingDeg` carries the grid convergence.** The stitch aligns the centre column to true north; the local frame is grid north, so the import writes `headingDeg = -gridConvergenceDeg(lon, lat, epsg)` (the same turn photos get), not 0. Set north (P2) adjusts from there.
3. **`cov` is the renderer's coverage.** A stitched sphere is filled to the full sphere, so filing writes `cov: { top: 90, bottom: 90 }`; what real pixels cover is `stitch.json` `coverage`. A wide panorama writes `cov` with `top`, `bottom`, `left` and `right`, and the engine centres its image at `headingDeg + (left + right) / 2`.
4. **Ready-made panoramas without GPS** are listed as "No capture time or position" and not imported in P1 (placing by hand comes with P2).
5. **Main starts the jobs at import**, through the same pack check `jobs:start` applies; the renderer starts later stitches (the **Stitch** action) through `jobs:start`.
6. **`stitch.json` names its `run`** (the job id), so a project open can reconcile a finished stitch that was never filed (the app closed in between).
7. **The Datasets entry point** is a button beside **Add data** (`add-panos`) plus the palette; there is no add menu to extend.
8. **The sphere's thumbnail in the tree row** waits for P3 (row lifecycle); P1 rows show name and status.
9. **Pano markers stay a 3D view feature**; the 2D map does not draw panoramas today and P1 does not add it.
10. **The split-view Panoramas pane** (`PanoPane.tsx`) keeps reading `headingDeg` without the wide-panorama centre offset; P2 (viewer) brings it in line.
11. **Add data's photos wait for the panorama preview.** Taking the offer opens the (modal) preview; the remaining photos import when it closes, so the photo import's own camera-heights card is never hidden behind it.
12. **Scan answers carry each sphere's frame list** (`PanoScanSphere.files`) so Add data can leave those files out (`builder:import` `exclude`).
13. **The GPU add-on lock widens to `<0.8.0` as add-on 0.1.1** (its test requires the pack version inside the range). An installed add-on 0.1.0 is refused next to pack 0.7.0 until 0.1.1 is built, which the founder starts with an installer build.
14. **Stitch from a tree row uses Standard quality**; choosing the quality on a restitch is P3.

---

### Task 1: Contracts

**Files:**

- Create: `packages/schema/src/panoStitch.ts`, `packages/schema/src/panoStitch.test.ts`, `packages/schema/src/__fixtures__/pano/stitch.synthetic.json`, `tools/compat/pano-stitch-additive.test.mjs`
- Modify: `packages/schema/src/layers.ts:57-62` (`PanoRef`), `packages/schema/src/jobs.ts` (`PipelineName` after `'walk.process'` at :82, `PIPELINES` after the `walk.process` entry at :306, `PanoStitchParams` after `WalkProcessParams` at ~:1104, `PARAMS` at :1146), `packages/schema/src/ipc.ts` (`builder:import` request at :1362, new channels after `'builder:cancelImport'` at ~:2898, new event after `'builder:progress'` at :2965), `packages/schema/src/versions.ts` (row after `aio.walk-process` at ~:519), `packages/schema/src/index.ts` (export after `./walkProcess` at :44), `packages/ui/src/i18n/en.ts` (a `pano.*` block after the `walk.*` block, and two `stage.markers.*` keys after :580), `apps/desktop/src/preload/index.ts` (`CHANNELS` :9-233, `EVENTS` :235-255), `docs/architecture/contract-changes.md` (the six rows above, appended), `docs/architecture/data-conventions.md` (new section 34)

**Interfaces:**

- Consumes: `Id`, `IsoTime`, `IsoDate` from `./common`; `ProjectManifest` in `ipc.ts`.
- Produces (exported from `@aio/schema`):

```ts
export const PANO_STITCH_SCHEMA = 'aio.pano-stitch/1';
export const PANO_STITCH_MIN_PACK = '0.7.0';
export const PANO_STITCH_FEATURE = 'Stitching drone panoramas';
export const PANO_STITCH_MAX_BYTES = 256 * 1024;
export const PANO_WIDTH = { standard: 8192, high: 16384 } as const;
export const PANO_HIGH_MIN_TEXTURE = 16384;
export const PanoFolderId: z.ZodString; // /^[a-z0-9][a-z0-9-]*$/, 1..80
export const PanoQuality: z.ZodEnum<['standard', 'high']>;
export const PanoStitchStatus: z.ZodEnum<['queued', 'running', 'done', 'failed']>;
export const PanoStitchState; // { run?: Id; status: PanoStitchStatus; error?: string }
export const PanoCov; // { top; bottom; left?; right? }
export const PanoShape: z.ZodEnum<['sphere', 'wide']>;
export const PanoStitchFile; // aio.pano-stitch/1
export const PanoSkipReason: z.ZodEnum<
  ['unreadable', 'no-position', 'no-gimbal', 'few-frames', 'narrow-yaw', 'one-pitch-row']
>;
export const PanoScanSphere, PanoScanReady, PanoScanSkipped, PanoScan;
export const PanoStitchParams; // { layer: PanoFolderId; pano: PanoFolderId; quality?: PanoQuality }
export function panoFolder(layer: string, pano: string): string; // 'panoramas/<layer>/<pano>'
// types: PanoQuality, PanoStitchStatus, PanoStitchState, PanoCov, PanoShape, PanoStitchFile,
// PanoSkipReason, PanoScanSphere, PanoScanReady, PanoScanSkipped, PanoScan, PanoStitchParams
```

- IPC channels `panos:scan`, `panos:import`, `panos:cancelImport`; event `panos:progress`; `builder:import` request field `exclude?: string[]`.
- i18n keys (exact list in Step 7), used by Tasks 9 to 12.

- [ ] **Step 1: Write the failing schema tests**

Create `packages/schema/src/__fixtures__/pano/stitch.synthetic.json` (Task 6's Python checker reads the same file):

```json
{
  "schema": "aio.pano-stitch/1",
  "run": "20261013-101500-pano-stitch-a1b2",
  "layer": "panos-2026-09-10",
  "pano": "p01",
  "createdAt": "2026-10-13T10:16:00.000Z",
  "engine": { "version": "0.7.0", "opencv": "5.0.0" },
  "quality": "standard",
  "shape": "sphere",
  "size": { "width": 8192, "height": 4096 },
  "frames": {
    "used": ["SYN_0001.JPG", "SYN_0002.JPG"],
    "dropped": [{ "file": "SYN_0003.JPG", "reason": "No gimbal angles" }]
  },
  "aligned": "features",
  "residualPx": 0.84,
  "maxDriftDeg": 1.7,
  "focalScale": 1.014,
  "coverage": { "topDeg": 21.5, "bottomDeg": 90 },
  "timings": {
    "read": 0.2,
    "seed": 0.0,
    "match": 5.7,
    "adjust": 6.0,
    "compose": 10.5,
    "fill": 2.4,
    "write": 1.0
  },
  "warnings": []
}
```

Create `packages/schema/src/panoStitch.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ipc } from './ipc';
import { PIPELINES, PanoStitchParams, PipelineName, pipelineParams } from './jobs';
import { PanoRef } from './layers';
import {
  PANO_STITCH_MIN_PACK,
  PANO_STITCH_SCHEMA,
  PANO_WIDTH,
  PanoCov,
  PanoScan,
  PanoStitchFile,
  PanoStitchState,
  panoFolder,
} from './panoStitch';
import { SCHEMA_REGISTRY } from './versions';

const golden = JSON.parse(
  readFileSync(new URL('./__fixtures__/pano/stitch.synthetic.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

describe('aio.pano-stitch/1', () => {
  it('reads the golden run record', () => {
    const r = PanoStitchFile.safeParse(golden);
    expect(r.success).toBe(true);
    expect(r.data?.schema).toBe(PANO_STITCH_SCHEMA);
  });

  it('reads a metadata-only run and a wide panorama', () => {
    const meta = { ...golden, aligned: 'metadata', residualPx: null, maxDriftDeg: null };
    expect(PanoStitchFile.safeParse(meta).success).toBe(true);
    const wide = {
      ...golden,
      shape: 'wide',
      size: { width: 4400, height: 1800 },
      coverage: { topDeg: 24, bottomDeg: 55, leftDeg: -100, rightDeg: 93 },
    };
    expect(PanoStitchFile.safeParse(wide).success).toBe(true);
  });

  it('refuses frame names with folders and unknown alignments', () => {
    const bad = { ...golden, frames: { used: ['sub/SYN_0001.JPG'], dropped: [] } };
    expect(PanoStitchFile.safeParse(bad).success).toBe(false);
    expect(PanoStitchFile.safeParse({ ...golden, aligned: 'hugin' }).success).toBe(false);
  });

  it('is registered as a project file beside the sphere', () => {
    const row = SCHEMA_REGISTRY.find((e) => e.family === 'aio.pano-stitch');
    expect(row).toMatchObject({
      version: 1,
      home: 'project',
      where: 'panoramas/<layer>/<pano>/stitch.json',
    });
  });

  it('names the folder of a sphere and the sizes per quality', () => {
    expect(panoFolder('panos-2026-09-10', 'p01')).toBe('panoramas/panos-2026-09-10/p01');
    expect(PANO_WIDTH).toEqual({ standard: 8192, high: 16384 });
    expect(PANO_STITCH_MIN_PACK).toBe('0.7.0');
  });
});

describe('PanoRef gains optional fields', () => {
  const plain = { id: 'p01', src: { path: 'panoramas/l/p01/pano.jpg' }, pos: [0, 70, 0] };

  it('still reads an item without them', () => {
    expect(PanoRef.parse(plain)).toEqual({ ...plain, headingDeg: 0 });
  });

  it('reads name, capture time, stitch state and coverage', () => {
    const item = {
      ...plain,
      name: 'Pano 1',
      capturedAt: '2026-09-10T10:00:00+03:00',
      stitch: { status: 'queued' },
      cov: { top: 24, bottom: 55, left: -100, right: 93 },
    };
    expect(PanoRef.parse(item)).toMatchObject(item);
  });

  it('keeps a run id and an error with the state', () => {
    const s = {
      run: '20261013-101500-pano-stitch-a1b2',
      status: 'failed',
      error: 'Too few frames',
    };
    expect(PanoStitchState.parse(s)).toEqual(s);
    expect(PanoStitchState.safeParse({ status: 'stitched' }).success).toBe(false);
  });

  it('refuses a yaw range that runs backwards', () => {
    expect(PanoCov.safeParse({ top: 20, bottom: 50, left: 90, right: -90 }).success).toBe(false);
    expect(PanoCov.safeParse({ top: 20, bottom: 50, left: 90 }).success).toBe(false);
  });
});

describe('pano.stitch job', () => {
  it('is a pipeline with checked parameters', () => {
    expect(PipelineName.options).toContain('pano.stitch');
    expect(PIPELINES.find((p) => p.name === 'pano.stitch')?.title).toBe('Stitch drone panorama');
    expect(pipelineParams('pano.stitch')).toBe(PanoStitchParams);
    expect(PanoStitchParams.parse({ layer: 'panos-2026-09-10', pano: 'p01' })).toEqual({
      layer: 'panos-2026-09-10',
      pano: 'p01',
    });
    expect(PanoStitchParams.safeParse({ layer: '../x', pano: 'p01' }).success).toBe(false);
    expect(PanoStitchParams.safeParse({ layer: 'l', pano: 'p01', quality: 'ultra' }).success).toBe(
      false,
    );
    expect(PanoStitchParams.safeParse({ layer: 'l', pano: 'p01', width: 1024 }).success).toBe(
      false,
    );
  });
});

describe('scan and import channels', () => {
  const scan = {
    scanId: 'scan-1',
    spheres: [
      {
        key: 's1',
        shape: 'sphere',
        files: ['D:/card/SYN_0001.JPG'],
        frames: 26,
        bytes: 300_000_000,
        startedAt: '2026-09-10T10:00:00',
        lat: 46.5,
        lon: 7.5,
        absAlt: 620,
        relAlt: 70,
        incomplete: false,
      },
    ],
    ready: [],
    skipped: [{ file: 'D:/card/SYN_0100.JPG', reason: 'few-frames' }],
    files: 27,
    day: '2026-09-10',
  };

  it('answers a scan', () => {
    expect(PanoScan.safeParse(scan).success).toBe(true);
    const res = ipc['panos:scan'].response.safeParse({ ok: true, scan });
    expect(res.success).toBe(true);
  });

  it('asks for an import by scan keys', () => {
    const req = {
      projectId: 'p',
      scanId: 'scan-1',
      keys: ['s1'],
      layerName: 'Panoramas 10 Sep',
      date: '2026-09-10',
      quality: 'standard',
    };
    expect(ipc['panos:import'].request.safeParse(req).success).toBe(true);
    expect(ipc['panos:import'].request.safeParse({ ...req, keys: [] }).success).toBe(false);
  });

  it('lets Add data leave files out', () => {
    const req = { projectId: 'p', paths: ['D:/card'], exclude: ['D:/card/SYN_0001.JPG'] };
    expect(ipc['builder:import'].request.safeParse(req).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run packages/schema/src/panoStitch.test.ts`
Expected: FAIL, `Cannot find module './panoStitch'`.

- [ ] **Step 3: Write `packages/schema/src/panoStitch.ts`**

```ts
import { z } from 'zod';
import { Id, IsoDate, IsoTime } from './common';

/*
 * Drone sphere panoramas (spec docs/plans/2026-10-13-drone-panoramas-design.md, plan
 * 2026-10-13-drone-panoramas-p1). One `panoramas` layer per import; each sphere is one `PanoRef`
 * whose files live in `panoramas/<layerId>/<panoId>/`: `frames/` (the source frames, never map
 * items), `pano.jpg`, `thumb.jpg` and the run record `stitch.json` (`aio.pano-stitch/1`).
 * Data-conventions section 34.
 */

export const PANO_STITCH_SCHEMA = 'aio.pano-stitch/1';
/** The first pipeline pack with `pano.stitch`, and how Settings, Processing tools names it. */
export const PANO_STITCH_MIN_PACK = '0.7.0';
export const PANO_STITCH_FEATURE = 'Stitching drone panoramas';
/** Largest `stitch.json` a reader opens. */
export const PANO_STITCH_MAX_BYTES = 256 * 1024;
/** Equirect width per quality; the height is half. */
export const PANO_WIDTH = { standard: 8192, high: 16384 } as const;
/** WebGL `MAX_TEXTURE_SIZE` that High needs; below it the option is hidden. */
export const PANO_HIGH_MIN_TEXTURE = 16384;

/** Folder-safe id of a pano layer or sphere (`panos-2026-09-10`, `p03`). */
export const PanoFolderId = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'A panorama id is lower-case letters, digits and dashes');

export const PanoQuality = z.enum(['standard', 'high']);
export type PanoQuality = z.infer<typeof PanoQuality>;

export const PanoStitchStatus = z.enum(['queued', 'running', 'done', 'failed']);
export type PanoStitchStatus = z.infer<typeof PanoStitchStatus>;

/** `PanoRef.stitch`. `run` (the job id) is absent until a job was started. */
export const PanoStitchState = z
  .object({
    run: Id.optional(),
    status: PanoStitchStatus,
    error: z.string().max(400).optional(),
  })
  .strict();
export type PanoStitchState = z.infer<typeof PanoStitchState>;

/**
 * `PanoRef.cov`: the part of the sphere the image shows. `top` and `bottom`: degrees above and
 * below the horizon at the image's top and bottom edge. `left` and `right` (both or neither): the
 * yaw range of a wide panorama, degrees clockwise from north, `left < right <= left + 360`.
 */
export const PanoCov = z
  .object({
    top: z.number().min(-90).max(90),
    bottom: z.number().min(-90).max(90),
    left: z.number().min(-360).max(360).optional(),
    right: z.number().min(-360).max(720).optional(),
  })
  .strict()
  .refine((c) => (c.left === undefined) === (c.right === undefined), {
    message: 'A yaw range has both ends.',
  })
  .refine(
    (c) =>
      c.left === undefined ||
      c.right === undefined ||
      (c.right > c.left && c.right - c.left <= 360),
    { message: 'A yaw range runs clockwise and spans at most 360 degrees.' },
  );
export type PanoCov = z.infer<typeof PanoCov>;

export const PanoShape = z.enum(['sphere', 'wide']);
export type PanoShape = z.infer<typeof PanoShape>;

const FrameName = z
  .string()
  .min(1)
  .max(260)
  .regex(/^[^/\\]+$/, 'A frame is named by its file name');

export const PanoStitchFile = z.object({
  schema: z.literal(PANO_STITCH_SCHEMA),
  /** The job that wrote it. */
  run: Id,
  layer: PanoFolderId,
  pano: PanoFolderId,
  createdAt: IsoTime,
  engine: z.object({ version: z.string().min(1).max(40), opencv: z.string().max(40).optional() }),
  quality: PanoQuality,
  shape: PanoShape,
  size: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
  frames: z.object({
    used: z.array(FrameName).max(200),
    dropped: z.array(z.object({ file: FrameName, reason: z.string().min(1).max(200) })).max(200),
  }),
  aligned: z.enum(['features', 'metadata']),
  /** Median feature residual after the adjustment, pixels at the 1600 px working width. */
  residualPx: z.number().nonnegative().nullable(),
  /** Largest turn of a matched frame away from its gimbal seed, degrees. */
  maxDriftDeg: z.number().nonnegative().nullable(),
  /** The shared focal length the adjustment settled on, over the EXIF one (1 without features). */
  focalScale: z.number().positive(),
  /** What real pixels cover; a sphere's sky above `topDeg` is a gradient fill. */
  coverage: z.object({
    topDeg: z.number().min(-90).max(90),
    bottomDeg: z.number().min(-90).max(90),
    leftDeg: z.number().min(-360).max(360).optional(),
    rightDeg: z.number().min(-360).max(720).optional(),
  }),
  /** Seconds per step (`read`, `seed`, `match`, `adjust`, `compose`, `fill`, `write`). */
  timings: z.record(z.string(), z.number().nonnegative()),
  warnings: z.array(z.string().max(400)).max(50),
});
export type PanoStitchFile = z.infer<typeof PanoStitchFile>;

/** The folder of one sphere, project-relative. */
export function panoFolder(layer: string, pano: string): string {
  return `panoramas/${layer}/${pano}`;
}

// ------------------------------------------------------------------ scan (panos:scan)

/** Why a file of a scanned folder is not part of a panorama. */
export const PanoSkipReason = z.enum([
  'unreadable',
  'no-position',
  'no-gimbal',
  'few-frames',
  'narrow-yaw',
  'one-pitch-row',
]);
export type PanoSkipReason = z.infer<typeof PanoSkipReason>;

const Thumb = z.string().max(200_000).startsWith('data:image/jpeg;base64,');

export const PanoScanSphere = z.object({
  /** `s1`, `s2` ... in capture order; the import names spheres by it. */
  key: z.string().min(1).max(40),
  shape: PanoShape,
  /** Its frames, absolute, in capture order (Add data leaves them out of a photo import). */
  files: z.array(z.string().min(1).max(2048)).min(1).max(500),
  frames: z.number().int().positive(),
  bytes: z.number().int().nonnegative(),
  /** Local capture time of the first frame, `YYYY-MM-DDTHH:mm:ss`. */
  startedAt: z.string().max(40),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  absAlt: z.number().optional(),
  /** Height above the take-off point (the preview's "height above ground"). */
  relAlt: z.number().optional(),
  /** Fewer frames than its siblings. */
  incomplete: z.boolean(),
  /** The layer that holds these frames already (the row starts unchecked). */
  alreadyIn: z.string().max(200).optional(),
  thumb: Thumb.optional(),
});
export type PanoScanSphere = z.infer<typeof PanoScanSphere>;

/** A ready-made equirect (2:1 or `GPano`), imported as it is. */
export const PanoScanReady = z.object({
  key: z.string().min(1).max(40),
  file: z.string().min(1).max(2048),
  bytes: z.number().int().nonnegative(),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  absAlt: z.number().optional(),
  relAlt: z.number().optional(),
  takenAt: z.string().max(40).optional(),
  thumb: Thumb.optional(),
});
export type PanoScanReady = z.infer<typeof PanoScanReady>;

export const PanoScanSkipped = z.object({
  file: z.string().min(1).max(2048),
  reason: PanoSkipReason,
});
export type PanoScanSkipped = z.infer<typeof PanoScanSkipped>;

export const PanoScan = z.object({
  scanId: z.string().min(1).max(64),
  spheres: z.array(PanoScanSphere).max(500),
  ready: z.array(PanoScanReady).max(500),
  skipped: z.array(PanoScanSkipped).max(20_000),
  /** JPEG files looked at. */
  files: z.number().int().nonnegative(),
  /** The day most sphere frames carry, for the survey date and the layer name. */
  day: IsoDate.nullable(),
});
export type PanoScan = z.infer<typeof PanoScan>;
```

- [ ] **Step 4: Extend `PanoRef`, the jobs, the IPC contract, the registry and the index**

`packages/schema/src/layers.ts`: add `import { PanoCov, PanoStitchState } from './panoStitch';` beside the other imports and replace `PanoRef` (:57-62):

```ts
export const PanoRef = z.object({
  id: Id,
  src: AssetRef,
  pos: Vec3,
  headingDeg: z.number().default(0),
  /** Display name, "Pano 1, 2 ..." in capture order (drone panoramas). */
  name: z.string().min(1).max(120).optional(),
  /** ISO time of the sphere's first frame. */
  capturedAt: IsoTime.optional(),
  /** A stitched sphere's run; absent for a ready-made panorama. */
  stitch: PanoStitchState.optional(),
  /** The part of the sphere the image shows; absent: from the image size (or panoramas.json). */
  cov: PanoCov.optional(),
});
```

(`IsoTime` is already imported in `layers.ts` for `PhotoRef.takenAt`.)

`packages/schema/src/jobs.ts`: add `import { PanoFolderId, PanoQuality } from './panoStitch';`, then append to `PipelineName` after `'walk.process',`:

```ts
  // Drone panoramas (pipeline pack 0.7.0)
  'pano.stitch',
```

append to `PIPELINES` after the `walk.process` entry:

```ts
  {
    name: 'pano.stitch',
    title: 'Stitch drone panorama',
    description:
      'One level, north-up 360 panorama from the frames of a drone sphere, aligned from its gimbal angles and features.',
  },
```

after `export type WalkProcessParams = ...`:

```ts
/**
 * `pano.stitch` (python `aio_pipelines/pano/pipeline.py`; plan 2026-10-13-drone-panoramas-p1).
 * Reads `panoramas/<layer>/<pano>/frames/`, writes `pano.jpg`, `thumb.jpg` and `stitch.json` beside.
 */
export const PanoStitchParams = z
  .object({
    layer: PanoFolderId,
    pano: PanoFolderId,
    /** Standard 8192 x 4096 (default) or High 16384 x 8192. */
    quality: PanoQuality.optional(),
  })
  .strict();
export type PanoStitchParams = z.infer<typeof PanoStitchParams>;
```

and in `PARAMS` after `'walk.process': WalkProcessParams,`: `'pano.stitch': PanoStitchParams,`.

`packages/schema/src/ipc.ts`: import `PanoQuality, PanoScan` from `./panoStitch` and `IsoDate` from `./common` if not imported. In the `builder:import` request object, after `as360`:

```ts
        /**
         * Files to leave out, absolute (Add data leaves out the frames of drone panoramas that the
         * person imports as panoramas instead).
         */
        exclude: z.array(z.string().min(1).max(2048)).max(20_000).optional(),
```

after `'builder:cancelImport'`:

```ts
  // ---------------------------------------------------------------- drone panoramas (P1)
  /**
   * Read the JPEGs under `paths` (folders recursively) and group them into drone spheres, wide
   * panoramas and ready-made panoramas; everything else is listed with its reason. Progress
   * arrives as `panos:progress` (`phase: 'scan'`). Main keeps the result for `panos:import`.
   */
  'panos:scan': {
    request: z
      .object({
        projectId: z.string().min(1),
        paths: z.array(z.string().min(1).max(2048)).min(1).max(20_000),
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), scan: PanoScan }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  /**
   * Import the chosen spheres and ready-made panoramas of a scan as one `panoramas` layer: frames
   * copied (progress `phase: 'copy'`), the layer saved with every sphere queued, one `pano.stitch`
   * job started per sphere. `notStarted` says why no job started (no or an old pipeline pack).
   */
  'panos:import': {
    request: z
      .object({
        projectId: z.string().min(1),
        scanId: z.string().min(1).max(64),
        keys: z.array(z.string().min(1).max(40)).min(1).max(1000),
        layerName: z.string().min(1).max(120),
        date: IsoDate.optional(),
        quality: PanoQuality,
      })
      .strict(),
    response: z.discriminatedUnion('ok', [
      z.object({
        ok: z.literal(true),
        manifest: ProjectManifest,
        layerId: z.string().min(1),
        started: z.number().int().nonnegative(),
        notStarted: z.string().optional(),
      }),
      z.object({
        ok: z.literal(false),
        error: z.string(),
        code: z.enum(['space', 'cancelled', 'stale-scan']).optional(),
      }),
    ]),
  },
  /** Stop the copy of a running `panos:import`; what it copied is removed. */
  'panos:cancelImport': {
    request: z.object({ projectId: z.string().min(1) }).strict(),
    response: z.object({ ok: z.boolean() }),
  },
```

and in `ipcEvents` after `'builder:progress'`:

```ts
  /** Progress of `panos:scan` and of the frame copy of `panos:import`. */
  'panos:progress': z.object({
    projectId: z.string(),
    phase: z.enum(['scan', 'copy']),
    done: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    file: z.string(),
  }),
```

`packages/schema/src/versions.ts`, after the `aio.walk-process` row:

```ts
  // the run record of pano.stitch (panoStitch.ts), beside the sphere it stitched
  {
    family: 'aio.pano-stitch',
    version: 1,
    home: 'project',
    where: 'panoramas/<layer>/<pano>/stitch.json',
    since: '0.12',
  },
```

`packages/schema/src/index.ts`, after `export * from './walkProcess';`: `export * from './panoStitch';`

`apps/desktop/src/preload/index.ts`: add to `CHANNELS` (after `'walks:remove': true,`) `'panos:scan': true, 'panos:import': true, 'panos:cancelImport': true,` and to `EVENTS` `'panos:progress'` (the `satisfies Record<IpcChannel, true>` check fails until the channels are listed).

- [ ] **Step 5: Run the schema tests**

Run: `pnpm vitest run packages/schema/src`
Expected: PASS (the new file and every existing schema test, `versions.test.ts` included).

- [ ] **Step 6: The compatibility test**

Create `tools/compat/pano-stitch-additive.test.mjs`:

```js
// Drone panoramas P1 (plan 2026-10-13-drone-panoramas-p1) is additive, pinned against the 0.11
// schema (tools/compat/schema-0.11):
// - PanoRef's new fields are optional: 0.11 reads a new item and drops them when it saves;
// - the run record lives in `panoramas/<layer>/<pano>/stitch.json`, a file 0.11 never opens;
// - the job index lists pano.stitch jobs, which 0.11's index reader skips one by one.
import { describe, expect, it } from 'vitest';
import * as current from '../../packages/schema/src/index.ts';
import * as v011 from './schema-0.11/index.mjs';

const item = {
  id: 'p01',
  src: { path: 'panoramas/panos-2026-09-10/p01/pano.jpg' },
  pos: [10, 70, -20],
  headingDeg: -0.8,
  name: 'Pano 1',
  capturedAt: '2026-09-10T10:00:00+02:00',
  stitch: { run: '20261013-101500-pano-stitch-a1b2', status: 'done' },
  cov: { top: 90, bottom: 90 },
};

describe('drone panoramas are additive', () => {
  it('0.11 reads a new pano item and keeps its place', () => {
    expect(current.PanoRef.safeParse(item).success).toBe(true);
    const old = v011.PanoRef.safeParse(item);
    expect(old.success).toBe(true);
    expect(old.data).toEqual({ id: 'p01', src: item.src, pos: item.pos, headingDeg: -0.8 });
  });

  it('writes its run record where 0.11 never reads', () => {
    const row = current.SCHEMA_REGISTRY.find((e) => e.family === 'aio.pano-stitch');
    expect(row?.home).toBe('project');
    expect(row?.where.startsWith('panoramas/')).toBe(true);
  });

  it('the job index lists pano.stitch jobs that 0.11 skips one by one', () => {
    const job = {
      id: '20261013-101500-pano-stitch-a1b2',
      pipeline: 'pano.stitch',
      project: 'D:/data/projects/demo',
      params: { layer: 'panos-2026-09-10', pano: 'p01' },
      status: 'failed',
      progress: 0,
      steps: [],
      artifacts: [],
      createdAt: '2026-10-13T10:15:00Z',
      updatedAt: '2026-10-13T10:15:00Z',
    };
    expect(current.JobRecord.safeParse(job).success).toBe(true);
    expect(v011.JobRecord.safeParse(job).success).toBe(false);
  });
});
```

Run: `pnpm vitest run tools/compat/pano-stitch-additive.test.mjs`
Expected: PASS.

- [ ] **Step 7: The strings**

`packages/ui/src/i18n/en.ts`, after `'stage.markers.panos_other'` (:580):

```ts
  'stage.markers.stitching': 'Stitching',
  'stage.markers.stitchFailed': 'Stitch failed',
```

after the `walk.*` block:

```ts
  // drone panoramas (panoramas/<layer>/<pano>/): the import preview, the Datasets rows, the offer
  'pano.add': 'Add drone panoramas',
  'pano.add.tip': 'Add a folder of drone sphere panorama frames',
  'pano.pick': 'Choose the folder with the drone panoramas',
  'pano.noProject': 'Open the project first.',
  'pano.scanning': 'Looking for panoramas: {done} of {total} files',
  'pano.none': 'No drone panoramas were found there.',
  'pano.preview.title': 'Add drone panoramas',
  'pano.preview.found_one': '{count} panorama found ({frames} frames)',
  'pano.preview.found_other': '{count} panoramas found ({frames} frames)',
  'pano.preview.skipped_one': '{count} file is not panorama frames',
  'pano.preview.skipped_other': '{count} files are not panorama frames',
  'pano.preview.copied': 'about {size} copied',
  'pano.preview.row': '{frames} frames, {time}, {height} m above ground',
  'pano.preview.rowNoHeight': '{frames} frames, {time}',
  'pano.preview.wide': 'Wide panorama',
  'pano.preview.ready': 'Ready-made panorama',
  'pano.preview.incomplete': 'Incomplete',
  'pano.preview.already': 'Already in {layer}',
  'pano.preview.date': 'Survey date',
  'pano.preview.name': 'Layer name',
  'pano.preview.quality': 'Quality',
  'pano.preview.standard': 'Standard (8K)',
  'pano.preview.high': 'High (16K)',
  'pano.preview.import': 'Import',
  'pano.preview.cancel': 'Cancel',
  'pano.preview.copying': 'Copying frames: {done} of {total}',
  'pano.preview.notPano': 'Not panorama frames',
  'pano.preview.photosHint': 'Use Add data to bring these in as photos.',
  'pano.skip.unreadable': 'Could not be read',
  'pano.skip.no-position': 'No capture time or position',
  'pano.skip.no-gimbal': 'No gimbal angles',
  'pano.skip.few-frames': 'Moving drone or single shot',
  'pano.skip.narrow-yaw': 'Does not turn far enough round',
  'pano.skip.one-pitch-row': 'Only one row of frames',
  'pano.layerName': 'Panoramas {date}',
  'pano.layerNameUndated': 'Panoramas',
  'pano.itemName': 'Pano {n}',
  'pano.status.queued': 'Waiting to stitch',
  'pano.status.stitching': 'Stitching {pct} %',
  'pano.status.failed': 'Stitch failed: {message}',
  'pano.status.done': 'Stitched',
  'pano.action.open': 'Open {name}',
  'pano.action.flyTo': 'Fly to {name}',
  'pano.action.stitch': 'Stitch {name}',
  'pano.offer.text': '{frames} of these frames are {count} drone panoramas. Import them as panoramas?',
  'pano.offer.yes': 'Import as panoramas',
  'pano.offer.no': 'Import all as photos',
```

Run: `pnpm vitest run packages/ui/src/i18n`
Expected: PASS (no dashes, no placeholder problems).

- [ ] **Step 8: Contract rows and data conventions**

Append the six rows of "Contract changes" above to `docs/architecture/contract-changes.md`. Add to `docs/architecture/data-conventions.md`:

```md
## 33. Drone panoramas (`panoramas/<layerId>/<panoId>/`)

One import of drone sphere panoramas is one `panoramas` layer; each sphere is one `PanoRef`
(`name`, `capturedAt`, `stitch`, `cov`). Its folder holds `frames/` (the source frames as copied,
never map items), `pano.jpg` (equirect, 8192 x 4096 or 16384 x 8192, JPEG quality 90, centre column
true north, level; a wide panorama is cropped to what it covers), `thumb.jpg` (512 x 256) and
`stitch.json` (`aio.pano-stitch/1`, written last by `pano.stitch`). The pipeline never writes the
manifest; the app files a run's outcome into the item's `stitch` and, when done, its `cov`.
`headingDeg` starts at minus the grid convergence at the sphere (true north in the local frame).
Older `panoramas/panoramas.json` coverage is still read for items without `cov`.
```

Run: `npx prettier --write docs/architecture/contract-changes.md docs/architecture/data-conventions.md` then `node tools/agent/check-public-text.mjs docs/architecture/contract-changes.md docs/architecture/data-conventions.md`
Expected: "No client or site names".

- [ ] **Step 9: Typecheck and commit**

Run: `pnpm typecheck` (expected: no errors; the preload whitelist is complete) and `pnpm vitest run packages/schema tools/compat packages/ui/src/i18n` (expected: PASS).

```bash
git add packages/schema/src packages/ui/src/i18n/en.ts apps/desktop/src/preload/index.ts tools/compat/pano-stitch-additive.test.mjs docs/architecture/contract-changes.md docs/architecture/data-conventions.md
git commit -m "feat(schema): drone panorama contracts, pano.stitch job and scan channels" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Grouping frames into spheres (TypeScript, pure)

**Files:**

- Create: `packages/project/src/builder/panoGroups.ts`, `packages/project/src/builder/panoGroups.test.ts`, `packages/project/src/builder/panoScan.ts`, `packages/project/src/builder/panoScan.test.ts`, `packages/project/src/builder/panoGroups.realdata.test.ts`
- Modify: `packages/project/src/builder/exif.ts:6-26` (`PhotoMeta.gpano`), `exif.ts:139-166` (`parseXmp`), `packages/project/src/builder/exif.test.ts`, `packages/project/src/builder/index.ts` (one export block)

**Interfaces:**

- Consumes: `PanoSkipReason`, `PanoShape` (Task 1); `readPhotoMeta`, `PhotoMeta` (`exif.ts`); `withExif` (`testing.ts:357`) in tests.
- Produces (exported from `@aio/project/builder`):

```ts
export interface PanoFrameMeta {
  file: string;
  bytes: number;
  takenAt?: string;
  lat?: number;
  lon?: number;
  absAlt?: number;
  relAlt?: number;
  gimbal?: { yaw: number; pitch: number; roll: number };
  width?: number;
  height?: number;
  gpano?: boolean;
  unreadable?: boolean;
}
export const PANO_GROUPING: {
  maxHorizontalM: 5;
  maxVerticalM: 3;
  maxGapS: 30;
  minFrames: 8;
  minYawSpanDeg: 270;
  minWideYawSpanDeg: 150;
  minPitchRows: 2;
  pitchRowToleranceDeg: 8;
  minRowFrames: 2;
  incompleteFraction: 0.85;
  equirectAspectTolerance: 0.02;
  nadirPitchDeg: -85;
};
export type PanoGroupingThresholds = { readonly [K in keyof typeof PANO_GROUPING]: number };
export interface PanoSphereGroup {
  shape: PanoShape;
  frames: PanoFrameMeta[];
  lat: number;
  lon: number;
  absAlt?: number;
  relAlt?: number;
  startedAt: string;
  incomplete: boolean;
  bytes: number;
}
export interface PanoGrouping {
  spheres: PanoSphereGroup[];
  ready: PanoFrameMeta[];
  skipped: { file: string; reason: PanoSkipReason }[];
}
export function groupPanoFrames(
  frames: readonly PanoFrameMeta[],
  t?: PanoGroupingThresholds,
): PanoGrouping;
export function yawSpanDeg(yaws: readonly number[]): number;
export function pitchRows(pitches: readonly number[], tolDeg: number, minFrames: number): number;
export function horizontalM(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number;
export function isReadyMadePano(f: PanoFrameMeta, t?: PanoGroupingThresholds): boolean;
export function panoFrameMeta(file: string, bytes: number, meta: PhotoMeta): PanoFrameMeta;
export async function readPanoFrameMeta(file: string): Promise<PanoFrameMeta>;
// exif.ts: PhotoMeta gains `gpano?: { projection: string }`
```

- [ ] **Step 1: Failing tests for GPano in `readPhotoMeta`**

Append to `packages/project/src/builder/exif.test.ts`:

```ts
describe('readPhotoMeta and GPano', () => {
  const gpanoSegment = (projection: string) => {
    const xml = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:GPano="http://ns.google.com/photos/1.0/panorama/" GPano:ProjectionType="${projection}"/></rdf:RDF></x:xmpmeta>`;
    const head = new TextEncoder().encode('http://ns.adobe.com/xap/1.0/\0');
    const body = new TextEncoder().encode(xml);
    const payload = new Uint8Array(head.length + body.length);
    payload.set(head);
    payload.set(body, head.length);
    const seg = new Uint8Array(4 + payload.length);
    seg.set([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]);
    seg.set(payload, 4);
    return seg;
  };
  const jpegWith = (seg: Uint8Array) => {
    const base = withExif({ width: 1400, height: 700 });
    return new Uint8Array([...base.subarray(0, 2), ...seg, ...base.subarray(2)]);
  };

  it('reads an equirectangular projection', () => {
    expect(readPhotoMeta(jpegWith(gpanoSegment('equirectangular'))).gpano).toEqual({
      projection: 'equirectangular',
    });
  });

  it('leaves it out when the XMP has none', () => {
    expect(readPhotoMeta(withExif({ dji: { GimbalYawDegree: '10' } })).gpano).toBeUndefined();
  });
});
```

Run: `pnpm vitest run packages/project/src/builder/exif.test.ts`
Expected: FAIL (`gpano` is undefined for the first case).

- [ ] **Step 2: Read `GPano:ProjectionType`**

In `exif.ts` add to `PhotoMeta`:

```ts
  /** XMP `GPano` (a ready-made panorama): its projection, e.g. `equirectangular`. */
  gpano?: { projection: string };
```

and at the end of `parseXmp` (after `if (Object.keys(dji).length) meta.dji = dji;`):

```ts
const proj =
  /GPano:ProjectionType\s*=\s*"([^"]*)"|<GPano:ProjectionType>([^<]*)<\/GPano:ProjectionType>/.exec(
    xml,
  );
const projection = (proj?.[1] ?? proj?.[2])?.trim();
if (projection) meta.gpano = { projection };
```

Run: `pnpm vitest run packages/project/src/builder/exif.test.ts`
Expected: PASS.

- [ ] **Step 3: Failing grouping tests**

Create `packages/project/src/builder/panoGroups.test.ts`. The tables are synthetic: both capture patterns of the spec, wrapped file names, mapping photos, a return to the same spot, a short sphere, a wide panorama and frames without gimbal data.

```ts
import { describe, expect, it } from 'vitest';
import {
  groupPanoFrames,
  horizontalM,
  isReadyMadePano,
  PANO_GROUPING,
  pitchRows,
  yawSpanDeg,
  type PanoFrameMeta,
} from './panoGroups';

const LAT = 46.5;
const LON = 7.5;
const M_PER_DEG_LAT = 111_195;
const north = (m: number) => m / M_PER_DEG_LAT;
const east = (m: number) => m / (M_PER_DEG_LAT * Math.cos((LAT * Math.PI) / 180));

/** Deterministic jitter in [-1, 1). */
function jitter(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    return (s / 2_147_483_648) * 2 - 1;
  };
}

const time = (start: Date, s: number) =>
  new Date(start.getTime() + s * 1000).toISOString().slice(0, 19);

/** DJI file numbers wrap after 0999 to 0001. */
const fileName = (no: number) => `SYN_${String(((no - 1) % 999) + 1).padStart(4, '0')}.JPG`;

interface SphereOpts {
  start: Date;
  eastM: number;
  northM: number;
  firstNo: number;
  pattern: 'rows' | 'bursts';
  /** Keep only this many frames (a short sphere). */
  take?: number;
  /** Yaws to shoot (a wide panorama uses fewer). */
  yaws?: number[];
  seed?: number;
}

/** Pattern A: rows at 0, -35, -70 (8 yaws each) then nadir, 6 s apart. Pattern B: 7 yaws, a
 * burst of 3 pitches (+20, -17, -55) per yaw 1 s apart, 5 s between yaws, then nadir. */
function sphere(o: SphereOpts): PanoFrameMeta[] {
  const rnd = jitter(o.seed ?? 1);
  const shots: { yaw: number; pitch: number; t: number }[] = [];
  if (o.pattern === 'rows') {
    const yaws = o.yaws ?? [-180, -135, -90, -45, 0, 45, 90, 135];
    let t = 0;
    for (const pitch of [0, -35, -70])
      for (const yaw of yaws) {
        shots.push({ yaw, pitch, t });
        t += 6;
      }
    shots.push({ yaw: 0, pitch: -90, t });
  } else {
    const yaws = o.yaws ?? [-180, -128.6, -77.1, -25.7, 25.7, 77.1, 128.6];
    let t = 0;
    for (const yaw of yaws) {
      for (const pitch of [20, -17, -55]) {
        shots.push({ yaw, pitch, t });
        t += 1;
      }
      t += 4;
    }
    shots.push({ yaw: 0, pitch: -90, t });
  }
  return shots.slice(0, o.take ?? shots.length).map((s, i) => ({
    file: `D:/card/100MEDIA/${fileName(o.firstNo + i)}`,
    bytes: 11_000_000,
    takenAt: time(o.start, s.t),
    lat: LAT + north(o.northM + rnd() * 1.0),
    lon: LON + east(o.eastM + rnd() * 1.0),
    absAlt: 620 + rnd() * 1.5,
    relAlt: 70 + rnd() * 1.5,
    gimbal: { yaw: s.yaw + rnd() * 0.5, pitch: s.pitch + rnd() * 0.5, roll: 0 },
    width: 5472,
    height: 3648,
  }));
}

/** A mapping run: nadir photos 20 m apart, 2 s apart, one flight yaw. */
function mapping(start: Date, firstNo: number, n: number, eastM: number): PanoFrameMeta[] {
  return Array.from({ length: n }, (_, i) => ({
    file: `D:/card/100MEDIA/${fileName(firstNo + i)}`,
    bytes: 9_000_000,
    takenAt: time(start, i * 2),
    lat: LAT + north(300),
    lon: LON + east(eastM + i * 20),
    absAlt: 650,
    relAlt: 100,
    gimbal: { yaw: 92, pitch: -90, roll: 0 },
    width: 5472,
    height: 3648,
  }));
}

const names = (fs: readonly PanoFrameMeta[]) => fs.map((f) => f.file).sort();
const t0 = new Date('2026-09-10T10:00:00Z');
const later = (min: number) => new Date(t0.getTime() + min * 60_000);

describe('yawSpanDeg and pitchRows', () => {
  it('measures yaw coverage across the 180 degree wrap', () => {
    expect(yawSpanDeg([170, -170])).toBeCloseTo(20, 6);
    expect(yawSpanDeg([0, 90, 180, 270])).toBeCloseTo(270, 6);
    expect(yawSpanDeg([-180, -135, -90, -45, 0, 45, 90, 135])).toBeCloseTo(315, 6);
    expect(yawSpanDeg([])).toBe(0);
  });

  it('counts rows of at least two frames within the tolerance', () => {
    expect(pitchRows([0, 0.4, -35, -35.3, -70, -69.8, -90], 8, 2)).toBe(3);
    expect(pitchRows([20, -17, -55, -90], 8, 2)).toBe(0);
    expect(pitchRows([20, 20, -17, -17, -55, -55, -90], 8, 2)).toBe(3);
  });
});

describe('groupPanoFrames', () => {
  it('finds both capture patterns and leaves mapping photos out', () => {
    const a = sphere({ start: t0, eastM: 0, northM: 0, firstNo: 1, pattern: 'rows' });
    const b = sphere({ start: later(5), eastM: 150, northM: 0, firstNo: 40, pattern: 'bursts' });
    const c = sphere({
      start: later(10),
      eastM: 300,
      northM: 50,
      firstNo: 80,
      pattern: 'rows',
      seed: 3,
    });
    const m = mapping(later(15), 120, 6, 0);
    const g = groupPanoFrames([...m, ...c, ...a, ...b]);
    expect(g.spheres.map((s) => names(s.frames))).toEqual([names(a), names(b), names(c)]);
    expect(g.spheres.map((s) => s.shape)).toEqual(['sphere', 'sphere', 'sphere']);
    expect(g.skipped).toEqual(m.map((f) => ({ file: f.file, reason: 'few-frames' })));
    expect(g.ready).toEqual([]);
  });

  it('orders by capture time, not by file number, when numbers wrap', () => {
    const a = sphere({ start: t0, eastM: 0, northM: 0, firstNo: 990, pattern: 'rows' });
    expect(a.some((f) => f.file.endsWith('SYN_0001.JPG'))).toBe(true);
    const shuffled = [...a].sort((x, y) => x.file.localeCompare(y.file));
    const g = groupPanoFrames(shuffled);
    expect(g.spheres).toHaveLength(1);
    expect(g.spheres[0]?.frames.map((f) => f.takenAt)).toEqual(a.map((f) => f.takenAt));
  });

  it('starts a new sphere on a return to the same spot later in the flight', () => {
    const a = sphere({ start: t0, eastM: 0, northM: 0, firstNo: 1, pattern: 'rows' });
    const b = sphere({
      start: later(12),
      eastM: 0,
      northM: 0,
      firstNo: 60,
      pattern: 'rows',
      seed: 9,
    });
    const g = groupPanoFrames([...a, ...b]);
    expect(g.spheres.map((s) => names(s.frames))).toEqual([names(a), names(b)]);
  });

  it('splits two spheres 34 s apart even when they are close (P0: inter-sphere gap)', () => {
    const a = sphere({ start: t0, eastM: 0, northM: 0, firstNo: 1, pattern: 'rows' });
    const lastS = 24 * 6;
    const b = sphere({
      start: new Date(t0.getTime() + (lastS + 34) * 1000),
      eastM: 5.6,
      northM: 0,
      firstNo: 40,
      pattern: 'rows',
      seed: 4,
    });
    const g = groupPanoFrames([...a, ...b]);
    expect(g.spheres).toHaveLength(2);
  });

  it('flags a short sphere as incomplete and refuses one under 8 frames', () => {
    const a = sphere({ start: t0, eastM: 0, northM: 0, firstNo: 1, pattern: 'rows' });
    const b = sphere({
      start: later(5),
      eastM: 150,
      northM: 0,
      firstNo: 40,
      pattern: 'rows',
      seed: 2,
    });
    // 18 frames: rows 0 and -35 complete, two of row -70; yaw 315, three rows (two frames at -70)
    const short = sphere({
      start: later(10),
      eastM: 300,
      northM: 0,
      firstNo: 80,
      pattern: 'rows',
      take: 18,
      seed: 5,
    });
    const tiny = sphere({
      start: later(15),
      eastM: 450,
      northM: 0,
      firstNo: 120,
      pattern: 'rows',
      take: 6,
      seed: 6,
    });
    const g = groupPanoFrames([...a, ...b, ...short, ...tiny]);
    expect(g.spheres.map((s) => [s.frames.length, s.incomplete])).toEqual([
      [25, false],
      [25, false],
      [18, true],
    ]);
    expect(new Set(g.skipped.map((s) => s.reason))).toEqual(new Set(['few-frames']));
    expect(g.skipped.map((s) => s.file).sort()).toEqual(names(tiny));
  });

  it('takes a 150 to 270 degree cluster as a wide panorama (P0)', () => {
    // 7 yaws x 3 rows, 193 degrees of yaw: the real wide clusters P0 found
    const yaws = [-100, -67.8, -35.7, -3.5, 28.7, 60.8, 93];
    const w = sphere({
      start: t0,
      eastM: 0,
      northM: 0,
      firstNo: 1,
      pattern: 'bursts',
      yaws,
      seed: 8,
    });
    const g = groupPanoFrames(w);
    expect(g.spheres).toHaveLength(1);
    expect(g.spheres[0]?.shape).toBe('wide');
    expect(g.spheres[0]?.frames).toHaveLength(22);
  });

  it('refuses a cluster that turns less than 150 degrees, or keeps one pitch', () => {
    const narrow = sphere({
      start: t0,
      eastM: 0,
      northM: 0,
      firstNo: 1,
      pattern: 'rows',
      yaws: [0, 20, 40, 60],
      seed: 3,
    });
    const flat = sphere({
      start: later(5),
      eastM: 200,
      northM: 0,
      firstNo: 40,
      pattern: 'rows',
      take: 8,
      seed: 4,
    });
    const g = groupPanoFrames([...narrow, ...flat]);
    expect(g.spheres).toEqual([]);
    const reasons = new Map(g.skipped.map((s) => [s.file, s.reason]));
    expect(narrow.every((f) => reasons.get(f.file) === 'narrow-yaw')).toBe(true);
    expect(flat.every((f) => reasons.get(f.file) === 'one-pitch-row')).toBe(true);
  });

  it('lists frames without gimbal angles, time or position with their reason', () => {
    const a = sphere({ start: t0, eastM: 0, northM: 0, firstNo: 1, pattern: 'rows' });
    const noGimbal = { ...a[0]!, file: 'D:/card/IMG_1.JPG', gimbal: undefined };
    const noTime = { ...a[1]!, file: 'D:/card/IMG_2.JPG', takenAt: undefined };
    const noGps = { ...a[2]!, file: 'D:/card/IMG_3.JPG', lat: undefined, lon: undefined };
    const broken: PanoFrameMeta = { file: 'D:/card/broken.JPG', bytes: 10, unreadable: true };
    const g = groupPanoFrames([...a, noGimbal, noTime, noGps, broken]);
    expect(g.spheres).toHaveLength(1);
    expect(g.skipped).toEqual([
      { file: 'D:/card/IMG_1.JPG', reason: 'no-gimbal' },
      { file: 'D:/card/IMG_2.JPG', reason: 'no-position' },
      { file: 'D:/card/IMG_3.JPG', reason: 'no-position' },
      { file: 'D:/card/broken.JPG', reason: 'unreadable' },
    ]);
  });

  it('takes 2:1 and GPano frames as ready-made panoramas when they have a position', () => {
    const base = { bytes: 30_000_000, takenAt: '2026-09-10T10:00:00', lat: LAT, lon: LON };
    const twoToOne = { ...base, file: 'D:/Pano/a.jpg', width: 14400, height: 7200 };
    const gpano = { ...base, file: 'D:/Pano/b.jpg', width: 8000, height: 3000, gpano: true };
    const lost = { file: 'D:/Pano/c.jpg', bytes: 1, width: 4000, height: 2000 };
    const g = groupPanoFrames([twoToOne, gpano, lost]);
    expect(g.ready.map((f) => f.file)).toEqual(['D:/Pano/a.jpg', 'D:/Pano/b.jpg']);
    expect(g.skipped).toEqual([{ file: 'D:/Pano/c.jpg', reason: 'no-position' }]);
    expect(isReadyMadePano({ file: 'x', bytes: 1, width: 5472, height: 3648 })).toBe(false);
  });

  it('places a sphere at the median of its frames and starts it at its first frame', () => {
    const a = sphere({ start: t0, eastM: 40, northM: -30, firstNo: 1, pattern: 'rows' });
    const s = groupPanoFrames(a).spheres[0]!;
    expect(
      horizontalM({ lat: s.lat, lon: s.lon }, { lat: LAT + north(-30), lon: LON + east(40) }),
    ).toBeLessThan(0.6);
    expect(s.relAlt).toBeCloseTo(70, 0);
    expect(s.startedAt).toBe('2026-09-10T10:00:00');
    expect(s.bytes).toBe(25 * 11_000_000);
  });

  it('keeps its thresholds in one table (tuned by P0)', () => {
    expect(PANO_GROUPING).toMatchObject({
      maxHorizontalM: 5,
      maxVerticalM: 3,
      maxGapS: 30,
      minFrames: 8,
      minYawSpanDeg: 270,
      minWideYawSpanDeg: 150,
      minPitchRows: 2,
      pitchRowToleranceDeg: 8,
    });
  });
});
```

Run: `pnpm vitest run packages/project/src/builder/panoGroups.test.ts`
Expected: FAIL, `Cannot find module './panoGroups'`.

- [ ] **Step 4: Write `packages/project/src/builder/panoGroups.ts`**

```ts
import type { PanoShape, PanoSkipReason } from '@aio/schema';

/**
 * Grouping drone frames into sphere panoramas (spec section 2, "Grouping frames into spheres"):
 * by how a sphere is flown, the drone hovering in one spot while the gimbal sweeps, never by file
 * names or folders. Pure; the reader is `panoScan.ts`.
 */
export interface PanoFrameMeta {
  /** Absolute path. */
  file: string;
  bytes: number;
  /** Local capture time `YYYY-MM-DDTHH:mm:ss`. */
  takenAt?: string;
  lat?: number;
  lon?: number;
  absAlt?: number;
  relAlt?: number;
  gimbal?: { yaw: number; pitch: number; roll: number };
  width?: number;
  height?: number;
  /** XMP `GPano:ProjectionType` is equirectangular. */
  gpano?: boolean;
  unreadable?: boolean;
}

/** The grouping thresholds. Every value is tuned by P0 (spec, "P0 findings (13 Oct 2026)"). */
export const PANO_GROUPING = {
  /** A hovering drone stays this close to its cluster's median position (P0: spread <= 1.14 m). */
  maxHorizontalM: 5,
  /** ... and this close in altitude (P0: <= 1.79 m). */
  maxVerticalM: 3,
  /** Longest gap between frames of one sphere (P0: <= 10 s inside, >= 34 s between spheres). */
  maxGapS: 30,
  minFrames: 8,
  /** Yaw coverage of a full sphere. */
  minYawSpanDeg: 270,
  /** Yaw coverage of a wide panorama (P0: real ones cover 193 degrees). */
  minWideYawSpanDeg: 150,
  minPitchRows: 2,
  /** Pitches closer than this are one row. */
  pitchRowToleranceDeg: 8,
  /** Frames a row needs (the lone nadir frame is not a row). */
  minRowFrames: 2,
  /** A sphere with fewer frames than this share of the median sphere is "incomplete". */
  incompleteFraction: 0.85,
  /** 2:1 within this is a ready-made equirect. */
  equirectAspectTolerance: 0.02,
  /** Frames steeper than this are nadir shots: their yaw says nothing about coverage. */
  nadirPitchDeg: -85,
} as const;
export type PanoGroupingThresholds = { readonly [K in keyof typeof PANO_GROUPING]: number };

export interface PanoSphereGroup {
  shape: PanoShape;
  /** In capture order. */
  frames: PanoFrameMeta[];
  lat: number;
  lon: number;
  absAlt?: number;
  relAlt?: number;
  /** Local capture time of the first frame. */
  startedAt: string;
  incomplete: boolean;
  bytes: number;
}

export interface PanoGrouping {
  spheres: PanoSphereGroup[];
  ready: PanoFrameMeta[];
  skipped: { file: string; reason: PanoSkipReason }[];
}

const EARTH_R = 6_371_008.8;
const RAD = Math.PI / 180;

/** Horizontal distance in metres (equirectangular approximation, fine over a few km). */
export function horizontalM(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const dN = (b.lat - a.lat) * RAD * EARTH_R;
  const dE = (b.lon - a.lon) * RAD * EARTH_R * Math.cos(((a.lat + b.lat) / 2) * RAD);
  return Math.hypot(dN, dE);
}

/** Seconds of a local capture time (the zone is the same for every frame of a card). */
function seconds(takenAt: string): number {
  return Date.parse(`${takenAt}Z`) / 1000;
}

/** Degrees of yaw the frames cover: 360 minus the widest gap between neighbouring yaws. */
export function yawSpanDeg(yaws: readonly number[]): number {
  if (yaws.length === 0) return 0;
  const s = yaws.map((y) => ((y % 360) + 360) % 360).sort((a, b) => a - b);
  let gap = 360 - ((s[s.length - 1] ?? 0) - (s[0] ?? 0));
  for (let i = 1; i < s.length; i++) gap = Math.max(gap, (s[i] ?? 0) - (s[i - 1] ?? 0));
  return 360 - gap;
}

/** Rows of pitch: runs of sorted pitches no more than `tolDeg` apart, of at least `minFrames`. */
export function pitchRows(pitches: readonly number[], tolDeg: number, minFrames: number): number {
  const s = [...pitches].sort((a, b) => a - b);
  let rows = 0;
  let run = 0;
  for (let i = 0; i < s.length; i++) {
    run = i > 0 && (s[i] ?? 0) - (s[i - 1] ?? 0) <= tolDeg ? run + 1 : 1;
    if (run === minFrames) rows++;
  }
  return rows;
}

export function isReadyMadePano(
  f: PanoFrameMeta,
  t: PanoGroupingThresholds = PANO_GROUPING,
): boolean {
  if (f.gpano) return true;
  if (!f.width || !f.height) return false;
  return Math.abs(f.width / f.height - 2) < t.equirectAspectTolerance;
}

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] ?? 0) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
}

const altOf = (f: PanoFrameMeta): number | undefined => f.absAlt ?? f.relAlt;

/** Why a cluster is not a panorama, or its shape. */
function classify(
  c: readonly PanoFrameMeta[],
  t: PanoGroupingThresholds,
): PanoShape | PanoSkipReason {
  if (c.length < t.minFrames) return 'few-frames';
  const g = c.flatMap((f) => (f.gimbal ? [f.gimbal] : []));
  if (
    pitchRows(
      g.map((x) => x.pitch),
      t.pitchRowToleranceDeg,
      t.minRowFrames,
    ) < t.minPitchRows
  )
    return 'one-pitch-row';
  const span = yawSpanDeg(g.filter((x) => x.pitch > t.nadirPitchDeg).map((x) => x.yaw));
  if (span >= t.minYawSpanDeg) return 'sphere';
  if (span >= t.minWideYawSpanDeg) return 'wide';
  return 'narrow-yaw';
}

export function groupPanoFrames(
  frames: readonly PanoFrameMeta[],
  t: PanoGroupingThresholds = PANO_GROUPING,
): PanoGrouping {
  const skipped: PanoGrouping['skipped'] = [];
  const ready: PanoFrameMeta[] = [];
  const usable: { f: PanoFrameMeta; s: number; i: number }[] = [];
  frames.forEach((f, i) => {
    if (f.unreadable) skipped.push({ file: f.file, reason: 'unreadable' });
    else if (isReadyMadePano(f, t)) {
      if (f.lat === undefined || f.lon === undefined)
        skipped.push({ file: f.file, reason: 'no-position' });
      else ready.push(f);
    } else if (
      f.takenAt === undefined ||
      f.lat === undefined ||
      f.lon === undefined ||
      Number.isNaN(seconds(f.takenAt))
    )
      skipped.push({ file: f.file, reason: 'no-position' });
    else if (!f.gimbal) skipped.push({ file: f.file, reason: 'no-gimbal' });
    else usable.push({ f, s: seconds(f.takenAt), i });
  });
  // by capture time (file numbers wrap: 0975 is followed by 0001), stable on ties
  usable.sort((a, b) => a.s - b.s || a.i - b.i);

  const clusters: PanoFrameMeta[][] = [];
  let cur: PanoFrameMeta[] = [];
  let lastS = -Infinity;
  for (const { f, s } of usable) {
    if (cur.length > 0) {
      const lat = median(cur.map((c) => c.lat ?? 0));
      const lon = median(cur.map((c) => c.lon ?? 0));
      const alts = cur.flatMap((c) => (altOf(c) === undefined ? [] : [altOf(c) ?? 0]));
      const alt = altOf(f);
      const far =
        s - lastS > t.maxGapS ||
        horizontalM({ lat, lon }, { lat: f.lat ?? 0, lon: f.lon ?? 0 }) > t.maxHorizontalM ||
        (alt !== undefined && alts.length > 0 && Math.abs(alt - median(alts)) > t.maxVerticalM);
      if (far) {
        clusters.push(cur);
        cur = [];
      }
    }
    cur.push(f);
    lastS = s;
  }
  if (cur.length) clusters.push(cur);

  const accepted: { shape: PanoShape; frames: PanoFrameMeta[] }[] = [];
  for (const c of clusters) {
    const k = classify(c, t);
    if (k === 'sphere' || k === 'wide') accepted.push({ shape: k, frames: c });
    else for (const f of c) skipped.push({ file: f.file, reason: k });
  }
  const typical = accepted.length ? median(accepted.map((a) => a.frames.length)) : 0;
  const spheres = accepted.map(({ shape, frames: fs }): PanoSphereGroup => {
    const abs = fs.flatMap((f) => (f.absAlt === undefined ? [] : [f.absAlt]));
    const rel = fs.flatMap((f) => (f.relAlt === undefined ? [] : [f.relAlt]));
    return {
      shape,
      frames: fs,
      lat: median(fs.map((f) => f.lat ?? 0)),
      lon: median(fs.map((f) => f.lon ?? 0)),
      ...(abs.length ? { absAlt: median(abs) } : {}),
      ...(rel.length ? { relAlt: median(rel) } : {}),
      startedAt: fs[0]?.takenAt ?? '',
      incomplete: fs.length < t.incompleteFraction * typical,
      bytes: fs.reduce((n, f) => n + f.bytes, 0),
    };
  });
  return { spheres, ready, skipped };
}
```

Note on the tests: `skipped` lists `unreadable`, ready-made and metadata refusals in input order first, then the refused clusters in capture order; the tests above are written for that order.

- [ ] **Step 5: Run the grouping tests**

Run: `pnpm vitest run packages/project/src/builder/panoGroups.test.ts`
Expected: PASS. If the "short sphere" case is refused as `one-pitch-row`, check that `take: 18` leaves two frames at -70 (rows need `minRowFrames: 2`); the data, not the rule, is wrong.

- [ ] **Step 6: Failing test for the frame reader**

Create `packages/project/src/builder/panoScan.test.ts`:

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { panoFrameMeta, readPanoFrameMeta } from './panoScan';
import { withExif } from './testing';

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pano-scan-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('readPanoFrameMeta', () => {
  it('reads time, position, altitudes and gimbal angles of a DJI frame', async () => {
    const file = join(dir, 'SYN_0001.JPG');
    const bytes = withExif({
      make: 'DJI',
      dateTimeOriginal: '2026:09:10 10:00:06',
      width: 5472,
      height: 3648,
      dji: {
        GpsLatitude: '46.5',
        GpsLongitude: '7.5',
        AbsoluteAltitude: '+620.5',
        RelativeAltitude: '+70.2',
        GimbalYawDegree: '-45.1',
        GimbalPitchDegree: '-35.0',
        GimbalRollDegree: '0.0',
      },
    });
    await writeFile(file, bytes);
    expect(await readPanoFrameMeta(file)).toEqual({
      file,
      bytes: bytes.length,
      takenAt: '2026-09-10T10:00:06',
      lat: 46.5,
      lon: 7.5,
      absAlt: 620.5,
      relAlt: 70.2,
      gimbal: { yaw: -45.1, pitch: -35, roll: 0 },
      width: 5472,
      height: 3648,
    });
  });

  it('marks a file that is not a JPEG as unreadable', async () => {
    const file = join(dir, 'notes.jpg');
    await writeFile(file, 'hello');
    expect(await readPanoFrameMeta(file)).toEqual({ file, bytes: 5, unreadable: true });
  });

  it('falls back to EXIF GPS and flags GPano', () => {
    const m = panoFrameMeta('x.jpg', 10, {
      gps: { lat: 1, lon: 2, alt: 30 },
      gpano: { projection: 'equirectangular' },
      width: 8000,
      height: 4000,
    });
    expect(m).toEqual({
      file: 'x.jpg',
      bytes: 10,
      lat: 1,
      lon: 2,
      absAlt: 30,
      gpano: true,
      width: 8000,
      height: 4000,
    });
  });
});
```

Run: `pnpm vitest run packages/project/src/builder/panoScan.test.ts`
Expected: FAIL, `Cannot find module './panoScan'`.

- [ ] **Step 7: Write `packages/project/src/builder/panoScan.ts`**

```ts
import { open, stat } from 'node:fs/promises';
import { readPhotoMeta, type PhotoMeta } from './exif';
import type { PanoFrameMeta } from './panoGroups';

/** Bytes read from the head of a frame: EXIF and DJI XMP sit in the first segments. */
export const PANO_HEAD_BYTES = 512 * 1024;

async function readHead(file: string, bytes: number): Promise<Uint8Array> {
  const fh = await open(file, 'r');
  try {
    const b = new Uint8Array(bytes);
    const { bytesRead } = await fh.read(b, 0, bytes, 0);
    return b.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** The grouping's view of a photo's metadata (DJI XMP position first, then EXIF GPS). */
export function panoFrameMeta(file: string, bytes: number, meta: PhotoMeta): PanoFrameMeta {
  const out: PanoFrameMeta = { file, bytes };
  if (meta.takenAt) out.takenAt = meta.takenAt;
  const lat = meta.dji?.lat ?? meta.gps?.lat;
  const lon = meta.dji?.lon ?? meta.gps?.lon;
  if (lat !== undefined && lon !== undefined) {
    out.lat = lat;
    out.lon = lon;
  }
  const abs = meta.dji?.absAlt ?? meta.gps?.alt;
  if (abs !== undefined) out.absAlt = abs;
  if (meta.dji?.relAlt !== undefined) out.relAlt = meta.dji.relAlt;
  if (meta.dji?.gimbal) out.gimbal = { ...meta.dji.gimbal };
  if (meta.width !== undefined && meta.height !== undefined) {
    out.width = meta.width;
    out.height = meta.height;
  }
  if (meta.gpano?.projection.toLowerCase() === 'equirectangular') out.gpano = true;
  return out;
}

/** Read one JPEG's head; a file that is not a JPEG (or cannot be read) is `unreadable`. */
export async function readPanoFrameMeta(file: string): Promise<PanoFrameMeta> {
  let bytes = 0;
  try {
    bytes = (await stat(file)).size;
    return panoFrameMeta(file, bytes, readPhotoMeta(await readHead(file, PANO_HEAD_BYTES)));
  } catch {
    return { file, bytes, unreadable: true };
  }
}
```

Export from `packages/project/src/builder/index.ts` (one block):

```ts
export {
  PANO_GROUPING,
  groupPanoFrames,
  horizontalM,
  isReadyMadePano,
  pitchRows,
  yawSpanDeg,
  type PanoFrameMeta,
  type PanoGrouping,
  type PanoGroupingThresholds,
  type PanoSphereGroup,
} from './panoGroups';
export { PANO_HEAD_BYTES, panoFrameMeta, readPanoFrameMeta } from './panoScan';
```

Run: `pnpm vitest run packages/project/src/builder/panoScan.test.ts packages/project/src/builder/panoGroups.test.ts`
Expected: PASS.

- [ ] **Step 8: The local real-data check (never in CI)**

Create `packages/project/src/builder/panoGroups.realdata.test.ts`. `QUADRION_PANO_REFERENCE` holds `folder=count` pairs separated by `;` (for the three reference folders: 5, 5 and 11 spheres); unset, the test is skipped.

```ts
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { groupPanoFrames } from './panoGroups';
import { readPanoFrameMeta } from './panoScan';

const pairs = (process.env.QUADRION_PANO_REFERENCE ?? '')
  .split(';')
  .filter(Boolean)
  .map((p) => {
    const at = p.lastIndexOf('=');
    return { folder: p.slice(0, at), count: Number(p.slice(at + 1)) };
  });

async function jpegs(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await jpegs(p)));
    else if (/\.jpe?g$/i.test(e.name)) out.push(p);
  }
  return out;
}

describe.skipIf(pairs.length === 0)(
  '@realdata drone sphere grouping on the reference folders',
  () => {
    pairs.forEach(({ folder, count }, i) => {
      it(`finds ${String(count)} spheres in reference folder ${String(i + 1)}`, async () => {
        const metas = await Promise.all((await jpegs(folder)).map((f) => readPanoFrameMeta(f)));
        const g = groupPanoFrames(metas);
        expect(g.spheres.filter((s) => s.shape === 'sphere')).toHaveLength(count);
        const seen = new Set<string>();
        for (const s of g.spheres)
          for (const f of s.frames) {
            expect(seen.has(f.file)).toBe(false);
            seen.add(f.file);
          }
      }, 120_000);
    });
  },
);
```

(The title names no folder; the folders live only in the local variable. A local run: `$env:QUADRION_PANO_REFERENCE='<A date 1>=5;<A date 2>=5;<B>=11'; pnpm vitest run packages/project/src/builder/panoGroups.realdata.test.ts`.)

Run: `pnpm vitest run packages/project/src/builder/panoGroups.realdata.test.ts`
Expected: the suite reports skipped (no variable set).

- [ ] **Step 9: Update from the P0 report**

Compare `PANO_GROUPING` with the spec's "P0 findings" section (and any later probe report in `docs/plans/`). They match at the time of writing; if a value moved, change the constant and the `keeps its thresholds in one table` expectation together.

- [ ] **Step 10: Commit**

Run: `pnpm vitest run packages/project/src/builder` and `pnpm typecheck` (expected: PASS, no errors).

```bash
git add packages/project/src/builder/panoGroups.ts packages/project/src/builder/panoGroups.test.ts packages/project/src/builder/panoGroups.realdata.test.ts packages/project/src/builder/panoScan.ts packages/project/src/builder/panoScan.test.ts packages/project/src/builder/exif.ts packages/project/src/builder/exif.test.ts packages/project/src/builder/index.ts
git commit -m "feat(project): group drone frames into sphere and wide panoramas" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Geometry, frame reading and the synthetic spheres (Python)

**Files:**

- Create: `python/src/aio_pipelines/pano/__init__.py` (empty docstring module: `"""Drone sphere panoramas: the pano.stitch pipeline."""`), `python/src/aio_pipelines/pano/geometry.py`, `python/src/aio_pipelines/pano/frames.py`, `python/tests/pano_synth.py`, `python/tests/test_pano_geometry.py`, `python/tests/test_pano_synth.py`

**Interfaces:**

- Consumes: nothing from other tasks (numpy, OpenCV, Pillow).
- Produces:

```python
# aio_pipelines/pano/geometry.py
DIAG_35MM: float
def rot_from_gimbal(yaw_deg: float, pitch_deg: float, roll_deg: float) -> np.ndarray  # camera-to-world, columns right/down/forward in (east, north, up)
def gimbal_from_rot(rot: np.ndarray) -> tuple[float, float, float]
def angle_deg(ra: np.ndarray, rb: np.ndarray) -> float
def nearest_rotation(m: np.ndarray) -> np.ndarray
def rotvecs_to_matrices(v: np.ndarray) -> np.ndarray  # (n, 3) -> (n, 3, 3)
def focal_px(focal35: float, width: int, height: int) -> float
def principal(width: int, height: int) -> tuple[float, float]
def pixels_to_rays(pts: np.ndarray, f: float, width: int, height: int) -> np.ndarray
def equirect_dirs(width: int, height: int, x0: int, y0: int, x1: int, y1: int) -> np.ndarray  # float32 (h, w, 3)
def dirs_to_canvas(d: np.ndarray, width: int, height: int) -> tuple[np.ndarray, np.ndarray]
# aio_pipelines/pano/frames.py
class FrameError(Exception)  # str(e) is the reason in stitch.json
@dataclass(frozen=True) class FrameInfo: name, width, height, focal35, yaw, pitch, roll; .focal; .to_json(); FrameInfo.from_json(d)
def read_gimbal(head: bytes) -> tuple[float, float, float] | None
def read_frame_info(path: Path) -> FrameInfo
def list_frames(folder: Path) -> list[Path]
def read_image(path: Path, scale: float = 1.0, gray: bool = False) -> np.ndarray
def encode_jpeg(img: np.ndarray, quality: int) -> bytes
# tests/pano_synth.py
ROWS, BURSTS, PATTERNS; make_scene(width=4096, seed=7, textureless=False); render_frame(scene, rot, w, h, f)
xmp_packet(fields); write_frame(path, img, *, gimbal, focal35, lat, lon, abs_alt, rel_alt, taken_at)
@dataclass SynthFrame(path, truth, gimbal); perturbations(n, max_deg, seed)
make_sphere(folder, pattern="rows", *, scene=None, frame_w=640, focal35=None, perturb_deg=1.5, seed=1, start=START, east_m=0, north_m=0, first_no=1, shots=None, focal_error=0.0, blank=()) -> list[SynthFrame]
make_strays(folder, n, *, start, first_no, frame_w=320); make_folder(out, spheres=3, strays=4, frame_w=320) -> dict; CLI main()
```

Conventions every Python task relies on (also in the module docstring): world frame x east, y north, z up; camera frame OpenCV (x right, y down, z forward); `R` takes camera rays to world rays; the canvas centre column looks north.

- [ ] **Step 1: Write the failing tests**

`python/tests/test_pano_geometry.py`:

```python
"""``pano.stitch`` geometry and frame reading (plan 2026-10-13-drone-panoramas-p1, task 3)."""

from __future__ import annotations

import math

import cv2
import numpy as np
import pytest

import pano_synth as ps
from aio_pipelines.pano.frames import (
    FrameError,
    encode_jpeg,
    list_frames,
    read_frame_info,
    read_gimbal,
    read_image,
)
from aio_pipelines.pano.geometry import (
    angle_deg,
    dirs_to_canvas,
    equirect_dirs,
    focal_px,
    gimbal_from_rot,
    nearest_rotation,
    pixels_to_rays,
    rot_from_gimbal,
    rotvecs_to_matrices,
)


def test_level_north_camera_looks_north_with_down_down():
    r = rot_from_gimbal(0, 0, 0)
    assert np.allclose(r[:, 2], [0, 1, 0])  # forward: north
    assert np.allclose(r[:, 0], [1, 0, 0])  # right: east
    assert np.allclose(r[:, 1], [0, 0, -1])  # down: down


def test_yaw_is_clockwise_from_north_and_pitch_is_up():
    assert np.allclose(rot_from_gimbal(90, 0, 0)[:, 2], [1, 0, 0], atol=1e-12)
    assert np.allclose(rot_from_gimbal(0, -90, 0)[:, 2], [0, 0, -1], atol=1e-12)
    assert np.allclose(rot_from_gimbal(0, 30, 0)[:, 2], [0, math.cos(math.radians(30)), 0.5])


@pytest.mark.parametrize("angles", [(30, -35, 2), (-170, 20, -1), (10, -89, 0.5), (179.5, 0, 0)])
def test_gimbal_angles_round_trip(angles):
    r = rot_from_gimbal(*angles)
    assert np.allclose(r.T @ r, np.eye(3)) and math.isclose(np.linalg.det(r), 1.0)
    assert np.allclose(gimbal_from_rot(r), angles, atol=1e-9)


def test_rotation_helpers():
    v = np.array([[0.1, -0.2, 0.3], [0.0, 0.0, 0.0]])
    m = rotvecs_to_matrices(v)
    assert np.allclose(m[0], cv2.Rodrigues(v[0])[0]) and np.allclose(m[1], np.eye(3))
    noisy = rot_from_gimbal(10, 20, 30) + 0.01
    assert angle_deg(nearest_rotation(noisy), rot_from_gimbal(10, 20, 30)) < 1.0
    assert angle_deg(rot_from_gimbal(0, 0, 0), rot_from_gimbal(5, 0, 0)) == pytest.approx(5.0)


def test_focal_from_the_35mm_equivalent_uses_the_diagonal():
    assert focal_px(28, 5472, 3648) == pytest.approx(4256.0, abs=0.1)
    assert focal_px(24, 5280, 3956) == pytest.approx(3659.7, abs=0.1)


def test_canvas_centre_looks_north_and_round_trips():
    d = equirect_dirs(360, 180, 0, 0, 360, 180)
    assert np.allclose(
        d[90, 180],
        [math.sin(math.radians(0.5)), math.cos(math.radians(0.5)), -math.sin(math.radians(0.5))],
        atol=1e-4,
    )
    u, v = dirs_to_canvas(d, 360, 180)
    assert np.allclose(u[10:170], np.arange(360)[None], atol=1e-3)
    assert np.allclose(v[10:170], np.arange(10, 170)[:, None], atol=1e-3)


def test_pixel_rays_through_the_principal_point_look_forward():
    rays = pixels_to_rays(np.array([[319.5, 213.0], [639, 213.0]]), 500.0, 640, 427)
    assert np.allclose(rays[0], [0, 0, 1])
    assert rays[1][0] > 0 and math.isclose(np.linalg.norm(rays[1]), 1.0)


def test_xmp_gimbal_in_attribute_and_element_form():
    attr = b'<rdf:Description drone-dji:GimbalYawDegree="-45.1" drone-dji:GimbalPitchDegree="-35.0"/>'
    assert read_gimbal(attr) == (-45.1, -35.0, 0.0)
    elem = (
        b"<drone-dji:GimbalYawDegree>12.5</drone-dji:GimbalYawDegree>"
        b"<drone-dji:GimbalPitchDegree>+20</drone-dji:GimbalPitchDegree>"
        b"<drone-dji:GimbalRollDegree>0.3</drone-dji:GimbalRollDegree>"
    )
    assert read_gimbal(elem) == (12.5, 20.0, 0.3)
    assert read_gimbal(b"<x:xmpmeta/>") is None


def test_reads_a_synthetic_frame_under_a_non_ascii_folder(tmp_path):
    folder = tmp_path / "Projet Ã©tÃ©"
    frames = ps.make_sphere(folder, "rows", frame_w=320, seed=2)
    info = read_frame_info(frames[0].path)
    assert (info.width, info.height, info.focal35) == (320, 213, 28.0)
    assert (info.yaw, info.pitch, info.roll) == pytest.approx(frames[0].gimbal, abs=1e-5)
    img = read_image(frames[0].path, 0.5)
    assert img.shape == (106, 160, 3)
    assert [p.name for p in list_frames(folder)][:2] == ["SYN_0001.JPG", "SYN_0002.JPG"]


def test_frames_without_gimbal_angles_or_focal_length_are_refused(tmp_path):
    plain = tmp_path / "plain.jpg"
    plain.write_bytes(encode_jpeg(np.full((40, 60, 3), 90, np.uint8), 90))
    with pytest.raises(FrameError, match="No gimbal angles"):
        read_frame_info(plain)
    broken = tmp_path / "broken.jpg"
    broken.write_bytes(b"not a jpeg")
    with pytest.raises(FrameError, match="Could not be read"):
        read_frame_info(broken)
    no_focal = tmp_path / "no_focal.jpg"
    data = encode_jpeg(np.full((40, 60, 3), 90, np.uint8), 90)
    xmp = ps.xmp_packet({"GimbalYawDegree": 1.0, "GimbalPitchDegree": -10.0})
    seg = b"\xff\xe1" + (len(xmp) + 2).to_bytes(2, "big") + xmp
    no_focal.write_bytes(data[:2] + seg + data[2:])
    with pytest.raises(FrameError, match="No 35 mm focal length"):
        read_frame_info(no_focal)
```

`python/tests/test_pano_synth.py`:

```python
"""The synthetic drone spheres (tests/pano_synth.py): frames, metadata and the e2e folder."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np

import pano_synth as ps
from aio_pipelines.pano.frames import read_frame_info
from aio_pipelines.pano.geometry import angle_deg, rot_from_gimbal


def test_both_patterns_have_the_frame_counts_of_the_spec():
    assert len(ps.ROWS) == 25 and len(ps.BURSTS) == 22
    assert {p for _, p in ps.ROWS} == {0.0, -35.0, -70.0, -90.0}
    assert {p for _, p in ps.BURSTS} == {20.0, -17.0, -55.0, -90.0}


def test_perturbations_are_zero_mean_and_bounded():
    eps = ps.perturbations(25, 1.5, seed=4)
    assert np.allclose(eps.mean(axis=0), 0.0)
    assert np.degrees(np.abs(eps)).max() <= 3.0


def test_written_gimbal_angles_are_off_by_one_to_three_degrees(tmp_path):
    frames = ps.make_sphere(tmp_path, "bursts", frame_w=320, seed=3)
    errors = []
    for f in frames:
        info = read_frame_info(f.path)
        errors.append(angle_deg(rot_from_gimbal(info.yaw, info.pitch, info.roll), f.truth))
    assert 0.5 < max(errors) < 4.5
    assert (read_frame_info(frames[0].path).width, read_frame_info(frames[0].path).height) == (320, 240)


def test_file_numbers_wrap_after_0999(tmp_path):
    frames = ps.make_sphere(tmp_path, "rows", frame_w=160, first_no=990, seed=1)
    names = [f.path.name for f in frames]
    assert names[9] == "SYN_0999.JPG" and names[10] == "SYN_0001.JPG"


def test_the_e2e_folder_script(tmp_path):
    script = Path(ps.__file__)
    out = subprocess.run(
        [sys.executable, str(script), str(tmp_path / "card"), "--lat", "28.9", "--lon", "51.0"],
        capture_output=True,
        text=True,
        check=True,
        timeout=240,
    )
    summary = json.loads(out.stdout.strip().splitlines()[-1])
    assert summary["spheres"] == [25, 22, 25] and summary["strays"] == 4
    assert len(list((tmp_path / "card").glob("*.JPG"))) == 76
    first = read_frame_info(tmp_path / "card" / "SYN_0960.JPG")
    assert first.focal35 == 28.0
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd python; uv run pytest tests/test_pano_geometry.py tests/test_pano_synth.py -q`
Expected: FAIL at collection, `ModuleNotFoundError: No module named 'aio_pipelines.pano'` (and `pano_synth`).

- [ ] **Step 3: Write `python/src/aio_pipelines/pano/geometry.py`**

```python
"""Rotations and projections of ``pano.stitch``.

World frame W: x east, y north, z up (true north, from the gimbal). Camera frame C (OpenCV): x
right, y down, z forward. A frame's rotation ``R`` takes camera rays to world rays (``w = R @ c``);
its columns are the camera's right, down and forward axes in W. Pixel centres sit at integer
coordinates and the principal point at the image centre ``((w - 1) / 2, (h - 1) / 2)``.

Equirect canvas, W x H: column ``u`` looks along longitude ``(u + 0.5) / W * 360 - 180`` (0, north,
at the centre, growing east to the right), row ``v`` at latitude ``90 - (v + 0.5) / H * 180``.
"""

from __future__ import annotations

import math

import numpy as np

#: Diagonal of a 35 mm frame, millimetres (``FocalLengthIn35mmFilm`` is defined against it).
DIAG_35MM = 43.2666


def rot_from_gimbal(yaw_deg: float, pitch_deg: float, roll_deg: float) -> np.ndarray:
    """Camera-to-world rotation from DJI gimbal angles: yaw clockwise from true north, pitch up
    positive, roll clockwise looking forward."""
    y, p, r = (math.radians(a) for a in (yaw_deg, pitch_deg, roll_deg))
    fwd = np.array([math.sin(y) * math.cos(p), math.cos(y) * math.cos(p), math.sin(p)])
    right0 = np.array([math.cos(y), -math.sin(y), 0.0])
    down0 = np.cross(fwd, right0)
    right = math.cos(r) * right0 + math.sin(r) * down0
    down = -math.sin(r) * right0 + math.cos(r) * down0
    return np.stack([right, down, fwd], axis=1)


def gimbal_from_rot(rot: np.ndarray) -> tuple[float, float, float]:
    """The inverse of :func:`rot_from_gimbal` (straight down, roll takes the yaw)."""
    fwd = rot[:, 2]
    pitch = math.asin(max(-1.0, min(1.0, float(fwd[2]))))
    yaw = math.atan2(float(fwd[0]), float(fwd[1]))
    right0 = np.array([math.cos(yaw), -math.sin(yaw), 0.0])
    down0 = np.cross(fwd, right0)
    roll = math.atan2(float(rot[:, 0] @ down0), float(rot[:, 0] @ right0))
    return math.degrees(yaw), math.degrees(pitch), math.degrees(roll)


def angle_deg(ra: np.ndarray, rb: np.ndarray) -> float:
    """Angle of the rotation between two rotations, degrees."""
    c = (float(np.trace(ra.T @ rb)) - 1.0) / 2.0
    return math.degrees(math.acos(max(-1.0, min(1.0, c))))


def nearest_rotation(m: np.ndarray) -> np.ndarray:
    """The rotation closest to a 3 x 3 matrix (SVD)."""
    u, _, vt = np.linalg.svd(m)
    d = np.sign(np.linalg.det(u @ vt))
    return u @ np.diag([1.0, 1.0, d]) @ vt


def rotvecs_to_matrices(v: np.ndarray) -> np.ndarray:
    """Rodrigues for an (n, 3) array of rotation vectors, giving (n, 3, 3)."""
    v = np.asarray(v, float).reshape(-1, 3)
    theta = np.linalg.norm(v, axis=1)
    k = np.where(theta[:, None] > 1e-12, v / np.maximum(theta, 1e-12)[:, None], 0.0)
    kx = np.zeros((len(v), 3, 3))
    kx[:, 0, 1], kx[:, 0, 2] = -k[:, 2], k[:, 1]
    kx[:, 1, 0], kx[:, 1, 2] = k[:, 2], -k[:, 0]
    kx[:, 2, 0], kx[:, 2, 1] = -k[:, 1], k[:, 0]
    s, c = np.sin(theta)[:, None, None], np.cos(theta)[:, None, None]
    return np.eye(3)[None] + s * kx + (1 - c) * (kx @ kx)


def focal_px(focal35: float, width: int, height: int) -> float:
    """Focal length in pixels from the 35 mm equivalent (defined on the diagonal)."""
    return focal35 / DIAG_35MM * math.hypot(width, height)


def principal(width: int, height: int) -> tuple[float, float]:
    return (width - 1) / 2.0, (height - 1) / 2.0


def pixels_to_rays(pts: np.ndarray, f: float, width: int, height: int) -> np.ndarray:
    """Unit camera rays of (n, 2) pixel positions."""
    cx, cy = principal(width, height)
    pts = np.asarray(pts, float).reshape(-1, 2)
    rays = np.column_stack([(pts[:, 0] - cx) / f, (pts[:, 1] - cy) / f, np.ones(len(pts))])
    return rays / np.linalg.norm(rays, axis=1, keepdims=True)


def equirect_dirs(width: int, height: int, x0: int, y0: int, x1: int, y1: int) -> np.ndarray:
    """World rays (float32, (y1 - y0, x1 - x0, 3)) of a box of canvas pixels."""
    u = (np.arange(x0, x1, dtype=np.float32) + 0.5) / width * (2 * np.pi) - np.pi
    v = np.pi / 2 - (np.arange(y0, y1, dtype=np.float32) + 0.5) / height * np.pi
    lon, lat = np.meshgrid(u, v)
    cl = np.cos(lat)
    return np.stack([np.sin(lon) * cl, np.cos(lon) * cl, np.sin(lat)], axis=-1).astype(np.float32)


def dirs_to_canvas(d: np.ndarray, width: int, height: int) -> tuple[np.ndarray, np.ndarray]:
    """Canvas pixel coordinates (u, v) of world rays (..., 3)."""
    lon = np.arctan2(d[..., 0], d[..., 1])
    lat = np.arcsin(np.clip(d[..., 2], -1.0, 1.0))
    return (lon + np.pi) / (2 * np.pi) * width - 0.5, (np.pi / 2 - lat) / np.pi * height - 0.5
```

- [ ] **Step 4: Write `python/src/aio_pipelines/pano/frames.py`**

```python
"""Reading and writing the images of ``pano.stitch``.

Frames are read through ``np.fromfile`` + ``cv2.imdecode`` and written through ``cv2.imencode``,
never ``cv2.imread``/``cv2.imwrite``: those fail on Windows paths outside the ANSI code page.
Gimbal angles come from the DJI XMP packet, the 35 mm focal length from EXIF.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from PIL import Image

from .geometry import focal_px

#: Bytes of a frame searched for the XMP packet (it sits in the first segments).
HEAD_BYTES = 512 * 1024
JPEG_SUFFIXES = (".jpg", ".jpeg")
_EXIF_IFD = 0x8769
_FOCAL_35 = 0xA405


class FrameError(Exception):
    """A frame that cannot be used; the message is the reason shown in ``stitch.json``."""


def _xmp_number(head: bytes, name: str) -> float | None:
    key = re.escape(name).encode()
    m = re.search(rb"drone-dji:" + key + rb'\s*=\s*"([^"]*)"|<drone-dji:' + key + rb">([^<]*)<", head)
    if not m:
        return None
    raw = (m.group(1) if m.group(1) is not None else m.group(2)).strip()
    try:
        return float(raw)
    except ValueError:
        return None


def read_gimbal(head: bytes) -> tuple[float, float, float] | None:
    """Gimbal yaw, pitch and roll from DJI XMP (roll 0 when absent), or None."""
    yaw = _xmp_number(head, "GimbalYawDegree")
    pitch = _xmp_number(head, "GimbalPitchDegree")
    if yaw is None or pitch is None:
        return None
    return yaw, pitch, _xmp_number(head, "GimbalRollDegree") or 0.0


@dataclass(frozen=True)
class FrameInfo:
    name: str
    width: int
    height: int
    focal35: float
    yaw: float
    pitch: float
    roll: float

    @property
    def focal(self) -> float:
        return focal_px(self.focal35, self.width, self.height)

    def to_json(self) -> dict[str, Any]:
        return asdict(self)

    @staticmethod
    def from_json(d: dict[str, Any]) -> FrameInfo:
        return FrameInfo(**d)


def read_frame_info(path: Path) -> FrameInfo:
    try:
        with open(path, "rb") as fh:
            head = fh.read(HEAD_BYTES)
        with Image.open(path) as im:
            width, height = im.size
            focal35 = im.getexif().get_ifd(_EXIF_IFD).get(_FOCAL_35)
    except (OSError, ValueError, SyntaxError) as e:
        raise FrameError("Could not be read") from e
    gimbal = read_gimbal(head)
    if gimbal is None:
        raise FrameError("No gimbal angles")
    if not focal35 or float(focal35) <= 0:
        raise FrameError("No 35 mm focal length")
    return FrameInfo(path.name, int(width), int(height), float(focal35), *gimbal)


def list_frames(folder: Path) -> list[Path]:
    """The JPEGs of a frames folder, by name."""
    if not folder.is_dir():
        return []
    return sorted((p for p in folder.iterdir() if p.suffix.lower() in JPEG_SUFFIXES), key=lambda p: p.name)


def read_image(path: Path, scale: float = 1.0, gray: bool = False) -> np.ndarray:
    """Decode a JPEG (any path) and scale it with area averaging."""
    data = np.fromfile(str(path), dtype=np.uint8)
    flag = cv2.IMREAD_GRAYSCALE if gray else cv2.IMREAD_COLOR
    if scale <= 0.25:
        flag = cv2.IMREAD_REDUCED_GRAYSCALE_4 if gray else cv2.IMREAD_REDUCED_COLOR_4
    elif scale <= 0.5:
        flag = cv2.IMREAD_REDUCED_GRAYSCALE_2 if gray else cv2.IMREAD_REDUCED_COLOR_2
    img = cv2.imdecode(data, flag)
    if img is None:
        raise FrameError("Could not be read")
    with Image.open(path) as im:
        full_w, full_h = im.size
    size = (max(1, round(full_w * scale)), max(1, round(full_h * scale)))
    if (img.shape[1], img.shape[0]) != size:
        img = cv2.resize(img, size, interpolation=cv2.INTER_AREA)
    return img


def encode_jpeg(img: np.ndarray, quality: int) -> bytes:
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, int(quality)])
    if not ok:
        raise FrameError("The image could not be encoded.")
    return buf.tobytes()
```

- [ ] **Step 5: Write `python/tests/pano_synth.py`**

The scene has value noise and thousands of small coloured quadrilaterals: plain value noise with round blobs gave about 100 SIFT features per 640 px frame and most pairs failed to match; with the quadrilaterals every pair matches.

```python
"""Synthetic drone sphere panoramas: a procedural equirect scene cut into perspective frames.

No imagery is committed: every frame is rendered here from a seeded scene. Frames are JPEGs with
the EXIF (``Make``, ``DateTimeOriginal``, ``FocalLengthIn35mmFilm``) and DJI XMP (GPS, altitudes,
gimbal and flight yaw) the importer and the pipeline read.

Two capture patterns, as on the two reference sites of the spec (names withheld):

- ``rows``: rows at pitch 0, -35 and -70, 8 yaws each, row after row, then a nadir frame (25);
- ``bursts``: 7 yaws, a burst of 3 pitches (+20, -17, -55) per yaw, then a nadir frame (22).

The gimbal angles written are the true ones turned by a small world-frame rotation (zero mean over
the sphere), so a stitch that recovers the truth within 0.2 degrees has fixed the metadata error.
Run as a script for the e2e folder: ``python pano_synth.py <out> --spheres 3 --strays 4``.
"""

from __future__ import annotations

import argparse
import io
import json
import math
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from aio_pipelines.pano.geometry import (
    gimbal_from_rot,
    principal,
    rot_from_gimbal,
    rotvecs_to_matrices,
)

SCENE_W = 4096
#: Generic synthetic coordinates (no real site).
LAT, LON = 46.5, 7.5
M_PER_DEG = 111_195.0
#: Capture start of the synthetic flight: local camera time, as EXIF keeps it.
START = datetime.fromisoformat("2026-09-10T10:00:00")

ROWS = [(float(y), float(p)) for p in (0, -35, -70) for y in range(-180, 180, 45)] + [(0.0, -90.0)]
BURSTS = [(round(-180 + k * 360 / 7, 1), float(p)) for k in range(7) for p in (20, -17, -55)] + [(0.0, -90.0)]
PATTERNS = {"rows": ROWS, "bursts": BURSTS}


def make_scene(width: int = SCENE_W, seed: int = 7, textureless: bool = False) -> np.ndarray:
    """An equirect scene (H, W, 3) uint8: value noise of several octaves and dark blobs, so every
    direction has features; or, ``textureless``, a smooth sky to ground gradient."""
    h = width // 2
    rows = np.linspace(0.0, 1.0, h, dtype=np.float32)[:, None, None]
    sky = np.array([200, 160, 120], np.float32)  # BGR
    ground = np.array([70, 110, 120], np.float32)
    base = sky * (1 - rows) + ground * rows
    if textureless:
        return np.broadcast_to(base, (h, width, 3)).astype(np.uint8)
    rng = np.random.default_rng(seed)
    tex = np.zeros((h, width), np.float32)
    amp = 1.0
    for cells in (8, 32, 128, 512, 1024):
        g = rng.random((cells // 2 + 1, cells + 1)).astype(np.float32)
        tex += amp * cv2.resize(g, (width, h), interpolation=cv2.INTER_LINEAR)
        amp *= 0.8
    tex = (tex - tex.min()) / (np.ptp(tex) + 1e-6)
    img = base * (0.4 + 0.8 * tex[..., None])
    # random quadrilaterals of their own colour: corners and edges SIFT finds at every scale
    for _ in range(width * 2):
        cx, cy = rng.uniform(0, width), rng.uniform(0, h)
        r = rng.uniform(2, 18) * width / SCENE_W
        ang = np.sort(rng.uniform(0, 2 * np.pi, 4))
        pts = np.stack([cx + r * np.cos(ang), cy + r * rng.uniform(0.5, 1.0, 4) * np.sin(ang)], axis=1)
        cv2.fillPoly(img, [np.round(pts).astype(np.int32)], rng.uniform(20, 235, 3).tolist())
    return np.clip(img, 0, 255).astype(np.uint8)


def render_frame(scene: np.ndarray, rot: np.ndarray, width: int, height: int, f: float) -> np.ndarray:
    """The perspective view of the scene from a camera with this camera-to-world rotation."""
    cx, cy = principal(width, height)
    xs, ys = np.meshgrid(np.arange(width, dtype=np.float32), np.arange(height, dtype=np.float32))
    rays = np.stack([(xs - cx) / f, (ys - cy) / f, np.ones_like(xs)], axis=-1)
    w = rays @ rot.T.astype(np.float32)
    w /= np.linalg.norm(w, axis=-1, keepdims=True)
    sh, sw = scene.shape[:2]
    lon = np.arctan2(w[..., 0], w[..., 1])
    lat = np.arcsin(np.clip(w[..., 2], -1, 1))
    u = ((lon + np.pi) / (2 * np.pi) * sw - 0.5).astype(np.float32)
    v = ((np.pi / 2 - lat) / np.pi * sh - 0.5).astype(np.float32)
    return cv2.remap(scene, u, v, cv2.INTER_LINEAR, borderMode=cv2.BORDER_WRAP)


def xmp_packet(fields: dict[str, float]) -> bytes:
    attrs = "\n".join(f'   drone-dji:{k}="{v:+.6f}"' for k, v in fields.items())
    xml = (
        '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
        '<rdf:Description rdf:about="DJI Meta Data" xmlns:drone-dji="http://www.dji.com/drone-dji/1.0/"\n'
        f"{attrs}>\n</rdf:Description></rdf:RDF></x:xmpmeta>"
    )
    return b"http://ns.adobe.com/xap/1.0/\x00" + xml.encode()


def write_frame(
    path: Path,
    img: np.ndarray,
    *,
    gimbal: tuple[float, float, float],
    focal35: float,
    lat: float,
    lon: float,
    abs_alt: float,
    rel_alt: float,
    taken_at: datetime,
) -> None:
    """A JPEG with DJI-like EXIF and XMP."""
    exif = Image.Exif()
    exif[0x010F] = "DJI"
    ifd = exif.get_ifd(0x8769)
    ifd[0x9003] = taken_at.strftime("%Y:%m:%d %H:%M:%S")
    ifd[0xA405] = round(focal35)
    pil = Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
    buf = io.BytesIO()
    pil.save(buf, "JPEG", quality=92, exif=exif.tobytes())
    data = buf.getvalue()
    xmp = xmp_packet(
        {
            "GpsLatitude": lat,
            "GpsLongitude": lon,
            "AbsoluteAltitude": abs_alt,
            "RelativeAltitude": rel_alt,
            "GimbalYawDegree": gimbal[0],
            "GimbalPitchDegree": gimbal[1],
            "GimbalRollDegree": gimbal[2],
            "FlightYawDegree": gimbal[0],
        }
    )
    seg = b"\xff\xe1" + (len(xmp) + 2).to_bytes(2, "big") + xmp
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data[:2] + seg + data[2:])


@dataclass(frozen=True)
class SynthFrame:
    path: Path
    truth: np.ndarray
    gimbal: tuple[float, float, float]


def perturbations(n: int, max_deg: float, seed: int) -> np.ndarray:
    """World-frame rotation vectors (radians), uniform within +-max_deg per axis, zero mean."""
    rng = np.random.default_rng(seed)
    eps = rng.uniform(-max_deg, max_deg, (n, 3))
    eps -= eps.mean(axis=0)
    return np.radians(eps)


def frame_size(frame_w: int, aspect: tuple[int, int]) -> tuple[int, int]:
    return frame_w, round(frame_w * aspect[1] / aspect[0])


def make_sphere(
    folder: Path,
    pattern: str = "rows",
    *,
    scene: np.ndarray | None = None,
    frame_w: int = 640,
    focal35: float | None = None,
    perturb_deg: float = 1.5,
    seed: int = 1,
    start: datetime = START,
    east_m: float = 0.0,
    north_m: float = 0.0,
    first_no: int = 1,
    shots: list[tuple[float, float]] | None = None,
    focal_error: float = 0.0,
    blank: tuple[int, ...] = (),
    origin: tuple[float, float] = (LAT, LON),
) -> list[SynthFrame]:
    """Render one sphere into ``folder`` as ``SYN_<no>.JPG`` (numbers wrap after 0999)."""
    scene = make_scene() if scene is None else scene
    shots = PATTERNS[pattern] if shots is None else shots
    focal35 = focal35 if focal35 is not None else (28.0 if pattern == "rows" else 24.0)
    width, height = frame_size(frame_w, (3, 2) if pattern == "rows" else (4, 3))
    f = focal35 / 43.2666 * math.hypot(width, height)
    eps = rotvecs_to_matrices(perturbations(len(shots), perturb_deg, seed))
    rng = np.random.default_rng(seed + 1000)
    lat0 = origin[0] + north_m / M_PER_DEG
    lon0 = origin[1] + east_m / (M_PER_DEG * math.cos(math.radians(origin[0])))
    out: list[SynthFrame] = []
    t = 0.0
    for k, (yaw, pitch) in enumerate(shots):
        truth = rot_from_gimbal(yaw, pitch, 0.0)
        seeded = eps[k] @ truth
        g = gimbal_from_rot(seeded)
        no = (first_no + k - 1) % 999 + 1
        path = folder / f"SYN_{no:04d}.JPG"
        write_frame(
            path,
            (
                np.full((height, width, 3), 128, np.uint8)
                if k in blank
                else render_frame(scene, truth, width, height, f * (1 + focal_error))
            ),
            gimbal=g,
            focal35=focal35,
            lat=lat0 + rng.uniform(-0.5, 0.5) / M_PER_DEG,
            lon=lon0 + rng.uniform(-0.5, 0.5) / M_PER_DEG,
            abs_alt=620.0 + rng.uniform(-0.5, 0.5),
            rel_alt=70.0 + rng.uniform(-0.5, 0.5),
            taken_at=start + timedelta(seconds=t),
        )
        out.append(SynthFrame(path, truth, g))
        t += 6 if pattern == "rows" else (5 if k % 3 == 2 else 1)
    return out


def make_strays(
    folder: Path,
    n: int,
    *,
    start: datetime,
    first_no: int,
    frame_w: int = 320,
    origin: tuple[float, float] = (LAT, LON),
) -> list[Path]:
    """Mapping photos: nadir, 20 m apart, 2 s apart, one flight yaw, 300 m north of `origin`."""
    scene = make_scene(1024, seed=99)
    width, height = frame_size(frame_w, (3, 2))
    f = 28 / 43.2666 * math.hypot(width, height)
    m_per_deg_lon = M_PER_DEG * math.cos(math.radians(origin[0]))
    paths = []
    for i in range(n):
        path = folder / f"SYN_{(first_no + i - 1) % 999 + 1:04d}.JPG"
        rot = rot_from_gimbal(92.0, -90.0, 0.0)
        write_frame(
            path,
            render_frame(scene, rot, width, height, f),
            gimbal=(92.0, -90.0, 0.0),
            focal35=28,
            lat=origin[0] + 300 / M_PER_DEG,
            lon=origin[1] + (i * 20) / m_per_deg_lon,
            abs_alt=650.0,
            rel_alt=100.0,
            taken_at=start + timedelta(seconds=2 * i),
        )
        paths.append(path)
    return paths


def make_folder(
    out: Path,
    spheres: int = 3,
    strays: int = 4,
    frame_w: int = 320,
    origin: tuple[float, float] = (LAT, LON),
) -> dict:
    """The e2e card folder: spheres 150 m apart (east of `origin`), 4 minutes apart, alternating
    patterns, then a short mapping run; one folder, file numbers continuing (and wrapping)."""
    scene = make_scene(2048)
    no = 960
    t = START
    counts = []
    for s in range(spheres):
        pattern = "rows" if s % 2 == 0 else "bursts"
        frames = make_sphere(
            out,
            pattern,
            scene=scene,
            frame_w=frame_w,
            seed=s + 1,
            start=t,
            east_m=150.0 * s,
            first_no=no,
            origin=origin,
        )
        counts.append(len(frames))
        no += len(frames)
        t += timedelta(minutes=4)
    make_strays(out, strays, start=t, first_no=no, origin=origin)
    return {"folder": str(out), "spheres": counts, "strays": strays}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--spheres", type=int, default=3)
    ap.add_argument("--strays", type=int, default=4)
    ap.add_argument("--frame-width", type=int, default=320)
    ap.add_argument("--lat", type=float, default=LAT)
    ap.add_argument("--lon", type=float, default=LON)
    a = ap.parse_args(argv)
    print(json.dumps(make_folder(Path(a.out), a.spheres, a.strays, a.frame_width, (a.lat, a.lon))))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 6: Run the tests**

Run: `cd python; uv run pytest tests/test_pano_geometry.py tests/test_pano_synth.py -q`
Expected: PASS (about 20 tests, under 15 s). Then `uv run ruff check . ; uv run ruff format --check .` (expected: clean).

- [ ] **Step 7: Commit**

```bash
git add python/src/aio_pipelines/pano/__init__.py python/src/aio_pipelines/pano/geometry.py python/src/aio_pipelines/pano/frames.py python/tests/pano_synth.py python/tests/test_pano_geometry.py python/tests/test_pano_synth.py
git commit -m "feat(pipelines): drone panorama geometry, frame reader and synthetic spheres" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Seed, match and adjust (Python)

**Files:**

- Create: `python/src/aio_pipelines/pano/align.py`, `python/tests/test_pano_align.py`

**Interfaces:**

- Consumes (Task 3): `angle_deg`, `nearest_rotation`, `principal`, `rotvecs_to_matrices`; in tests `pano_synth.make_sphere`, `make_scene`, `ROWS`, `frames.read_frame_info`, `read_image`, `rot_from_gimbal`.
- Produces:

```python
WORK_WIDTH = 1600; SIFT_FEATURES = 4000; RATIO = 0.8; SEED_TOLERANCE_DEG = 8.0; RANSAC_PX = 3.0
MIN_MATCHES = 15; MIN_INLIERS = 20; MAX_PER_PAIR = 300; PRIOR_WEIGHT = 0.05; HUBER_PX = 2.0
MAX_EVALUATIONS = 200; MAX_MEDIAN_RESIDUAL_PX = 2.0; MAX_DRIFT_DEG = 5.0
@dataclass Features(pts, desc); @dataclass PairMatch(i, j, a, b)
@dataclass Alignment(rotations: list[np.ndarray], aligned: str, focal_scale: float,
                     residual_px: float | None, max_drift_deg: float | None,
                     unmatched: list[int] = [], reason: str | None = None)
def work_scale(width: int) -> float
def detect(gray: np.ndarray) -> Features
def overlap_pairs(seeds: list[np.ndarray], hfov_deg: float) -> list[tuple[int, int]]
def match_pair(fa, fb, seed_a, seed_b, k, rng) -> tuple[np.ndarray, np.ndarray] | None
def match_frames(grays, seeds, focal_work, check=lambda: None, progress=lambda f: None) -> list[PairMatch]
def adjust(seeds, matches, focal_work, size) -> tuple[list[np.ndarray], float, float, bool]  # rotations, focal scale, median residual px, converged
def align(seeds, matches, focal_work, size) -> Alignment
```

The P0 values (SIFT 4000 features, ratio 0.8, seed check 8 degrees, homography RANSAC 3 px, at least 20 inliers, at most 300 per pair, prior weight 0.05, Huber 2 px, one shared focal scale, re-anchoring to the seeds, the median-residual and 5 degree fallback, unmatched frames on their seed) are named constants marked "tuned by P0".

- [ ] **Step 1: Write the failing tests**

`python/tests/test_pano_align.py`:

```python
"""Seed, match and adjust of ``pano.stitch`` on synthetic spheres (plan task 4).

The frames are rendered with known rotations; the gimbal angles written into them are turned by
1 to 3 degrees. The stitch must recover the true rotations within 0.2 degrees (spec section 5).
"""

from __future__ import annotations

import numpy as np
import pytest

import pano_synth as ps
from aio_pipelines.pano import align
from aio_pipelines.pano.frames import read_frame_info, read_image
from aio_pipelines.pano.geometry import angle_deg, rot_from_gimbal


@pytest.fixture(scope="module")
def scene():
    return ps.make_scene()


def _align(frames):
    infos = [read_frame_info(f.path) for f in frames]
    s = align.work_scale(infos[0].width)
    grays = [read_image(f.path, s, gray=True) for f in frames]
    seeds = [rot_from_gimbal(i.yaw, i.pitch, i.roll) for i in infos]
    focal = infos[0].focal * s
    matches = align.match_frames(grays, seeds, focal)
    return align.align(seeds, matches, focal, (grays[0].shape[1], grays[0].shape[0])), seeds


@pytest.mark.parametrize("pattern", ["rows", "bursts"])
def test_recovers_the_true_rotations_within_a_fifth_of_a_degree(tmp_path, scene, pattern):
    frames = ps.make_sphere(tmp_path, pattern, scene=scene, frame_w=640, seed=3)
    a, seeds = _align(frames)
    assert a.aligned == "features" and a.unmatched == []
    assert max(angle_deg(s, f.truth) for s, f in zip(seeds, frames, strict=True)) > 1.0
    assert max(angle_deg(r, f.truth) for r, f in zip(a.rotations, frames, strict=True)) < 0.2
    assert a.residual_px is not None and a.residual_px < 1.0
    assert a.focal_scale == pytest.approx(1.0, abs=0.003)


def test_refines_one_shared_focal_length(tmp_path, scene):
    frames = ps.make_sphere(tmp_path, "rows", scene=scene, frame_w=640, seed=5, focal_error=0.015)
    a, _ = _align(frames)
    assert a.aligned == "features"
    assert a.focal_scale == pytest.approx(1.015, abs=0.003)


def test_frames_without_matches_keep_their_seed(tmp_path, scene):
    frames = ps.make_sphere(tmp_path, "rows", scene=scene, frame_w=640, seed=5, blank=(3, 24))
    a, seeds = _align(frames)
    assert a.aligned == "features" and a.unmatched == [3, 24]
    assert all(np.allclose(a.rotations[k], seeds[k]) for k in (3, 24))
    matched = [k for k in range(len(frames)) if k not in (3, 24)]
    assert max(angle_deg(a.rotations[k], frames[k].truth) for k in matched) < 0.2


def test_a_textureless_sphere_falls_back_to_the_gimbal_angles(tmp_path):
    frames = ps.make_sphere(tmp_path, "bursts", scene=ps.make_scene(textureless=True), frame_w=640, seed=3)
    a, seeds = _align(frames)
    assert a.aligned == "metadata" and a.residual_px is None and a.focal_scale == 1.0
    assert all(np.allclose(r, s) for r, s in zip(a.rotations, seeds, strict=True))
    assert a.reason == "No features matched between frames."


def _fake_matches():
    pts = np.zeros((30, 2), np.float32)
    return [align.PairMatch(0, 1, pts, pts)]


def test_a_large_residual_or_turn_falls_back_to_the_seeds(monkeypatch):
    seeds = [rot_from_gimbal(0, 0, 0), rot_from_gimbal(45, 0, 0)]
    turned = [rot_from_gimbal(6, 0, 0), rot_from_gimbal(45, 0, 0)]
    monkeypatch.setattr(align, "adjust", lambda *a: (turned, 1.01, 0.4, True))
    a = align.align(seeds, _fake_matches(), 500.0, (640, 427))
    assert a.aligned == "metadata" and "turned 6.0 degrees" in (a.reason or "")
    monkeypatch.setattr(align, "adjust", lambda *a: (seeds, 1.0, 2.5, True))
    a = align.align(seeds, _fake_matches(), 500.0, (640, 427))
    assert a.aligned == "metadata" and a.residual_px == 2.5 and "2.5 px" in (a.reason or "")
    monkeypatch.setattr(align, "adjust", lambda *a: (seeds, 1.0, 0.3, False))
    assert align.align(seeds, _fake_matches(), 500.0, (640, 427)).reason == "The adjustment did not converge."


def test_only_overlapping_seeds_are_paired():
    seeds = [rot_from_gimbal(y, p, 0) for y, p in ps.ROWS]
    pairs = align.overlap_pairs(seeds, 65.0)
    assert (0, 1) in pairs and (0, 7) in pairs  # yaw neighbours of -180, across the wrap too
    assert (0, 4) not in pairs  # -180 and 0 look opposite ways
    assert any(24 in p for p in pairs)  # the nadir meets the -70 row
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd python; uv run pytest tests/test_pano_align.py -q`
Expected: FAIL at collection, `cannot import name 'align' from 'aio_pipelines.pano'`.

- [ ] **Step 3: Write `python/src/aio_pipelines/pano/align.py`**

```python
"""Seed, match and adjust of ``pano.stitch`` (spec section 2; P0 findings, 13 Oct 2026).

The gimbal angles put every frame within a degree or two of the truth (the seed). Features are
matched only between frames whose seeds overlap; a rotation-only bundle adjustment with one shared
focal length then pulls the sphere tight and is re-anchored to the seeds, so north and level come
from the gimbal and the fine alignment from the features. A frame without matches keeps its seed.
The whole sphere falls back to the seeds (``aligned: 'metadata'``) when the median residual or a
frame's turn from its seed is too large, or the adjustment does not converge.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass, field

import cv2
import numpy as np
from scipy.optimize import least_squares

from .geometry import angle_deg, nearest_rotation, principal, rotvecs_to_matrices

#: Working copies for features are at most this wide (spec: about 1600 px).
WORK_WIDTH = 1600
SIFT_FEATURES = 4000
#: Lowe's ratio test.
RATIO = 0.8
#: A match must land within this angle of where the seeds put it (tuned by P0).
SEED_TOLERANCE_DEG = 8.0
#: RANSAC reprojection threshold of the homography check, working-copy pixels (tuned by P0).
RANSAC_PX = 3.0
MIN_MATCHES = 15
MIN_INLIERS = 20
MAX_PER_PAIR = 300
#: Weight of the pull towards the seed, per focal pixel per radian (tuned by P0).
PRIOR_WEIGHT = 0.05
HUBER_PX = 2.0
MAX_EVALUATIONS = 200
#: Fallback limits (spec, P0 findings): median residual at the working width, turn from the seed.
MAX_MEDIAN_RESIDUAL_PX = 2.0
MAX_DRIFT_DEG = 5.0


@dataclass
class Features:
    pts: np.ndarray  # (n, 2) float32, working-copy pixels
    desc: np.ndarray | None


@dataclass
class PairMatch:
    i: int
    j: int
    a: np.ndarray  # (m, 2) points in frame i, working-copy pixels
    b: np.ndarray  # (m, 2) the same points in frame j


@dataclass
class Alignment:
    rotations: list[np.ndarray]
    aligned: str  # 'features' | 'metadata'
    focal_scale: float
    residual_px: float | None
    max_drift_deg: float | None
    unmatched: list[int] = field(default_factory=list)
    reason: str | None = None


def work_scale(width: int) -> float:
    return min(1.0, WORK_WIDTH / width)


def detect(gray: np.ndarray) -> Features:
    sift = cv2.SIFT_create(nfeatures=SIFT_FEATURES)
    kps, desc = sift.detectAndCompute(gray, None)
    return Features(np.float32([k.pt for k in kps]).reshape(-1, 2), desc)


def overlap_pairs(seeds: list[np.ndarray], hfov_deg: float) -> list[tuple[int, int]]:
    """Pairs whose seed view directions are closer than the horizontal field of view."""
    pairs = []
    for i in range(len(seeds)):
        for j in range(i + 1, len(seeds)):
            if angle_between(seeds[i][:, 2], seeds[j][:, 2]) <= hfov_deg:
                pairs.append((i, j))
    return pairs


def angle_between(a: np.ndarray, b: np.ndarray) -> float:
    return math.degrees(math.acos(float(np.clip(a @ b / np.linalg.norm(a) / np.linalg.norm(b), -1, 1))))


def camera_matrix(f: float, width: int, height: int) -> np.ndarray:
    cx, cy = principal(width, height)
    return np.array([[f, 0, cx], [0, f, cy], [0, 0, 1]], float)


def match_pair(
    fa: Features,
    fb: Features,
    seed_a: np.ndarray,
    seed_b: np.ndarray,
    k: np.ndarray,
    rng: np.random.Generator,
) -> tuple[np.ndarray, np.ndarray] | None:
    """Matches between two frames that agree with the seeds and with one homography (a pure
    rotation between views), or None."""
    if fa.desc is None or fb.desc is None or len(fa.desc) < 10 or len(fb.desc) < 10:
        return None
    knn = cv2.BFMatcher(cv2.NORM_L2).knnMatch(fa.desc, fb.desc, k=2)
    good = [m[0] for m in knn if len(m) == 2 and m[0].distance < RATIO * m[1].distance]
    if len(good) < MIN_MATCHES:
        return None
    a = fa.pts[[m.queryIdx for m in good]]
    b = fb.pts[[m.trainIdx for m in good]]
    # where the seeds put a's points in b: H = K Rb^T Ra K^-1 (camera-to-world rotations)
    hs = k @ seed_b.T @ seed_a @ np.linalg.inv(k)
    pa = cv2.perspectiveTransform(a[None].astype(np.float64), hs)[0]
    keep = np.linalg.norm(pa - b, axis=1) < math.radians(SEED_TOLERANCE_DEG) * k[0, 0]
    a, b = a[keep], b[keep]
    if len(a) < MIN_MATCHES:
        return None
    hm, inl = cv2.findHomography(a, b, cv2.RANSAC, RANSAC_PX)
    if hm is None:
        return None
    inl = inl.ravel().astype(bool)
    if inl.sum() < MIN_INLIERS:
        return None
    a, b = a[inl], b[inl]
    if len(a) > MAX_PER_PAIR:
        sel = rng.choice(len(a), MAX_PER_PAIR, replace=False)
        a, b = a[sel], b[sel]
    return a, b


def match_frames(
    grays: list[np.ndarray],
    seeds: list[np.ndarray],
    focal_work: float,
    check: Callable[[], None] = lambda: None,
    progress: Callable[[float], None] = lambda f: None,
) -> list[PairMatch]:
    """Features of every working copy, then matches between overlapping pairs."""
    h, w = grays[0].shape[:2]
    feats = []
    for n, g in enumerate(grays):
        check()
        feats.append(detect(g))
        progress(0.6 * (n + 1) / len(grays))
    hfov = 2 * math.degrees(math.atan(w / 2 / focal_work))
    k = camera_matrix(focal_work, w, h)
    rng = np.random.default_rng(0)
    pairs = overlap_pairs(seeds, hfov)
    out = []
    for n, (i, j) in enumerate(pairs):
        check()
        m = match_pair(feats[i], feats[j], seeds[i], seeds[j], k, rng)
        if m is not None:
            out.append(PairMatch(i, j, m[0], m[1]))
        progress(0.6 + 0.4 * (n + 1) / max(1, len(pairs)))
    return out


def _residuals(x: np.ndarray, seeds: np.ndarray, f0: float, c: np.ndarray, data) -> np.ndarray:
    n = len(seeds)
    rots = seeds @ rotvecs_to_matrices(x[: 3 * n])  # R_k = S_k exp(w_k): turn in the camera frame
    f = f0 * x[-1]
    ii, jj, a, b = data

    def reproject(src, si, dst, di):
        ray = np.column_stack([(src - c) / f, np.ones(len(src))])
        world = np.einsum("nij,nj->ni", rots[si], ray)
        q = np.einsum("nji,nj->ni", rots[di], world)
        return f * q[:, :2] / q[:, 2:3] + c - dst

    r1 = reproject(a, ii, b, jj)
    r2 = reproject(b, jj, a, ii)
    return np.concatenate([r1.ravel(), r2.ravel(), PRIOR_WEIGHT * f0 * x[: 3 * n]])


def adjust(
    seeds: list[np.ndarray], matches: list[PairMatch], focal_work: float, size: tuple[int, int]
) -> tuple[list[np.ndarray], float, float, bool]:
    """Rotation-only bundle adjustment with one shared focal scale, re-anchored to the seeds.
    Gives rotations, focal scale, median residual (working pixels) and whether it converged."""
    n = len(seeds)
    s = np.stack(seeds)
    c = np.array(principal(*size))
    data = (
        np.concatenate([np.full(len(m.a), m.i) for m in matches]),
        np.concatenate([np.full(len(m.a), m.j) for m in matches]),
        np.concatenate([m.a for m in matches]).astype(float),
        np.concatenate([m.b for m in matches]).astype(float),
    )
    x0 = np.zeros(3 * n + 1)
    x0[-1] = 1.0
    sol = least_squares(
        _residuals,
        x0,
        args=(s, focal_work, c, data),
        loss="huber",
        f_scale=HUBER_PX,
        x_scale="jac",
        max_nfev=MAX_EVALUATIONS,
    )
    m2 = len(data[0])
    res = sol.fun[: 4 * m2].reshape(-1, 2)
    median_px = float(np.median(np.linalg.norm(res, axis=1)))
    rots = s @ rotvecs_to_matrices(sol.x[: 3 * n])
    # re-anchor: the world turn G that best maps the adjusted frames onto their seeds
    g = nearest_rotation(sum(seeds[k] @ rots[k].T for k in range(n)))
    return [g @ r for r in rots], float(sol.x[-1]), median_px, bool(sol.success)


def align(
    seeds: list[np.ndarray], matches: list[PairMatch], focal_work: float, size: tuple[int, int]
) -> Alignment:
    """The rotations to compose with, and how they were found."""
    n = len(seeds)
    matched = sorted({m.i for m in matches} | {m.j for m in matches})
    unmatched = [k for k in range(n) if k not in matched]
    if not matches:
        return Alignment(
            list(seeds), "metadata", 1.0, None, None, unmatched, "No features matched between frames."
        )
    rots, scale, median_px, ok = adjust(seeds, matches, focal_work, size)
    for k in unmatched:  # no features: the seed stands (P0)
        rots[k] = seeds[k]
    drift = max(angle_deg(rots[k], seeds[k]) for k in matched)
    reason = None
    if not ok:
        reason = "The adjustment did not converge."
    elif median_px > MAX_MEDIAN_RESIDUAL_PX:
        reason = f"Features disagree by {median_px:.1f} px."
    elif drift > MAX_DRIFT_DEG:
        reason = f"A frame turned {drift:.1f} degrees from its gimbal angles."
    if reason:
        return Alignment(list(seeds), "metadata", 1.0, round(median_px, 3), None, unmatched, reason)
    return Alignment(rots, "features", scale, round(median_px, 3), round(drift, 3), unmatched)
```

- [ ] **Step 4: Run the tests**

Run: `cd python; uv run pytest tests/test_pano_align.py -q --durations=5`
Expected: PASS (7 tests, about 20 s). Measured on the plan's prototype: both patterns recover the truth within 0.04 degrees from seeds 1.8 degrees off; a 1.5 % focal error comes back as `focal_scale` 1.015; two blank frames stay on their seeds while the rest stay within 0.1 degrees.

- [ ] **Step 5: Update from the P0 report**

Compare the constants with the spec's "P0 findings" (and any later probe report). They match at the time of writing; change a constant and its test together if a value moved.

- [ ] **Step 6: Commit**

```bash
git add python/src/aio_pipelines/pano/align.py python/tests/test_pano_align.py
git commit -m "feat(pipelines): align drone sphere frames from gimbal seeds and features" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Compose, fill and the wide crop (Python)

**Files:**

- Create: `python/src/aio_pipelines/pano/compose.py`, `python/tests/test_pano_compose.py`

**Interfaces:**

- Consumes (Task 3): `equirect_dirs`, `principal`; in tests `pano_synth`, `read_frame_info`, `read_image`, `rot_from_gimbal`.
- Produces:

```python
COMPOSE_OVERSAMPLE = 1.4; FOOTPRINT_STEP = 8; WARP_STRIP_ROWS = 512; SEAM_SCALE_8K = 0.25
SEAM_SCALE_16K = 0.125; FILL_BAND_PER_8K = 12; FILL_BLUR_SHARE = 1/12; ZENITH_GAIN = 1.05
FILL_STRIP_PIXELS = 1 << 19; FULL_COVERAGE_SHARE = 0.995; THUMB_SIZE = (512, 256)
@dataclass Piece(image: np.ndarray, mask: np.ndarray, corner: tuple[int, int])
def frame_scale(focal: float, canvas_width: int) -> float
def footprint(rot, f, w, h, cw, ch) -> list[tuple[int, int, int, int]]
def warp(img, rot, f, cw, ch) -> list[Piece]
def seam_scale(width: int) -> float
def wrap_pad(width: int) -> int
def blend(pieces, cw, ch, check=lambda: None) -> tuple[np.ndarray, np.ndarray]  # canvas uint8, coverage mask
def coverage_deg(covered) -> tuple[float, float]  # degrees above and below the horizon
def fill_sky(pano, covered) -> None  # in place
def fill_wide(pano, covered) -> None  # in place
def wide_crop(covered) -> tuple[int, int, int, int] | None  # (shift, top, bottom, width)
def apply_wide_crop(img, crop) -> np.ndarray
def yaw_range_deg(crop, canvas_width) -> tuple[float, float]
def lat_range_deg(crop, canvas_height) -> tuple[float, float]
def thumbnail(img) -> np.ndarray
```

Two things the plan's prototype found and the code handles: (1) a multi-band blend on a flat canvas leaves a step at the 180 degree meridian (edge columns differed by 12 levels against 5 between neighbours), so `blend` widens the canvas by `wrap_pad` columns with copies of the pieces near each edge and crops after; (2) the `GAIN` compensator writes into the image it is given, and the wrap copies share their image, so it is given a copy.

- [ ] **Step 1: Write the failing tests**

`python/tests/test_pano_compose.py`:

```python
"""Compose and fill of ``pano.stitch`` on synthetic spheres (plan task 5)."""

from __future__ import annotations

import tracemalloc

import cv2
import numpy as np
import pytest

import pano_synth as ps
from aio_pipelines.pano import compose
from aio_pipelines.pano.frames import read_frame_info, read_image
from aio_pipelines.pano.geometry import rot_from_gimbal

W, H = 2048, 1024
WIDE_SHOTS = [(y, p) for y in (-100, -67.8, -35.7, -3.5, 28.7, 60.8, 93) for p in (20, -17, -55)] + [
    (0.0, -90.0)
]


@pytest.fixture(scope="module")
def scene():
    return ps.make_scene()


def _stitch(frames):
    pieces = []
    for f in frames:
        info = read_frame_info(f.path)
        s = compose.frame_scale(info.focal, W)
        pieces += compose.warp(read_image(f.path, s), f.truth, info.focal * s, W, H)
    return compose.blend(pieces, W, H)


def test_frames_shrink_to_the_canvas_resolution():
    assert compose.frame_scale(4256.0, 8192) == pytest.approx(
        1.4 * 8192 / 360 / (4256.0 * np.pi / 180), rel=1e-6
    )
    assert compose.frame_scale(400.0, 16384) == 1.0


def test_footprints_split_at_the_wrap_and_span_the_pole():
    f, w, h = 500.0, 640, 427
    south = compose.footprint(rot_from_gimbal(180, 0, 0), f, w, h, W, H)
    assert len(south) == 2 and south[0][0] == 0 and south[1][2] == W
    nadir = compose.footprint(rot_from_gimbal(0, -90, 0), f, w, h, W, H)
    assert nadir == [(0, nadir[0][1], W, H)]
    (north,) = compose.footprint(rot_from_gimbal(0, 0, 0), f, w, h, W, H)
    assert north[0] < W / 2 < north[2] and north[1] < H / 2 < north[3]


@pytest.mark.parametrize(("pattern", "top"), [("rows", 22.4), ("bursts", 47.2)])
def test_a_sphere_composes_onto_the_scene(tmp_path, scene, pattern, top):
    frames = ps.make_sphere(tmp_path, pattern, scene=scene, frame_w=640, seed=3)
    pano, mask = _stitch(frames)
    cov = mask > 0
    ref = cv2.resize(scene, (W, H), interpolation=cv2.INTER_AREA)
    diff = np.abs(pano.astype(int) - ref.astype(int)).mean(axis=2)
    assert diff[cov].mean() < 8
    assert compose.coverage_deg(mask) == pytest.approx((top, 89.9), abs=1.5)
    assert compose.wide_crop(mask) is None
    # the 180 degree meridian: the two edges meet as smoothly as neighbouring columns do
    both = cov[:, 0] & cov[:, -1]
    wrap = np.abs(pano[:, 0].astype(int) - pano[:, -1].astype(int))[both].mean()
    inner = np.abs(pano[:, W // 2].astype(int) - pano[:, W // 2 + 1].astype(int))[cov[:, W // 2]].mean()
    assert wrap < 1.5 * inner


def test_the_sky_fill_is_smooth_and_leaves_no_hole(tmp_path, scene):
    frames = ps.make_sphere(tmp_path, "rows", scene=scene, frame_w=640, seed=3)
    pano, mask = _stitch(frames)
    compose.fill_sky(pano, mask)
    assert (pano.sum(axis=2) > 0).all()
    sky = pano[: H // 4].astype(int)
    assert np.abs(np.diff(sky, axis=1)).max() <= 3  # no streaks across the sky
    assert np.abs(np.diff(sky, axis=0)).max() <= 3


def test_the_sky_fill_works_strip_by_strip():
    big = np.full((2048, 4096, 3), 100, np.uint8)
    big[:, :, 1] = np.linspace(0, 255, 4096, dtype=np.uint8)[None]
    mask = np.zeros((2048, 4096), np.uint8)
    mask[700:] = 255
    tracemalloc.start()
    base = tracemalloc.get_traced_memory()[0]
    compose.fill_sky(big, mask)
    peak = tracemalloc.get_traced_memory()[1] - base
    tracemalloc.stop()
    # a float copy of the canvas alone would be 4 (float32) or 8 (float64) times the image
    assert peak < 2 * big.nbytes


def test_a_wide_panorama_is_cropped_to_what_it_covers(tmp_path, scene):
    frames = ps.make_sphere(tmp_path, "bursts", scene=scene, frame_w=640, seed=3, shots=WIDE_SHOTS)
    pano, mask = _stitch(frames)
    crop = compose.wide_crop(mask)
    assert crop is not None
    left, right = compose.yaw_range_deg(crop, W)
    assert -150 < left < -100 and 93 < right < 140
    top, bottom = compose.lat_range_deg(crop, H)
    assert 40 < top < 55 and bottom == pytest.approx(90, abs=1)
    out = compose.apply_wide_crop(pano, crop)
    assert out.shape[1] == crop[3] and out.shape[0] == crop[2] - crop[1]
    out_mask = compose.apply_wide_crop(mask, crop)
    compose.fill_wide(out, out_mask)
    assert (out.sum(axis=2) > 0).all()


def test_thumbnail_size():
    assert compose.thumbnail(np.zeros((1024, 2048, 3), np.uint8)).shape == (256, 512, 3)
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd python; uv run pytest tests/test_pano_compose.py -q`
Expected: FAIL at collection, `cannot import name 'compose'`.

- [ ] **Step 3: Write `python/src/aio_pipelines/pano/compose.py`**

```python
"""Compose and fill of ``pano.stitch`` (spec section 2; P0 findings, 13 Oct 2026).

Every frame is warped onto the equirect canvas as one piece, or two when it crosses the 180 degree
meridian, or the full width when it holds a pole. Exposure is evened with OpenCV's ``GAIN``
compensator and seams are found by dynamic programming on colour and gradient, both on a small
copy; a multi-band blender writes the canvas. A full sphere's sky above the top row is a heavily
smoothed gradient, written strip by strip so a 16K canvas never has a float copy; a wide panorama
is cropped to what it covers instead.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass

import cv2
import numpy as np

from .geometry import equirect_dirs, principal

#: Frames are scaled to this many times the canvas's pixels per degree (P0: 1.4).
COMPOSE_OVERSAMPLE = 1.4
#: Footprints are found on a grid of this many canvas pixels.
FOOTPRINT_STEP = 8
#: Canvas rows warped at a time (bounds the float32 ray buffer).
WARP_STRIP_ROWS = 512
#: Seams and exposure gains are found on a copy at this scale (P0: 0.25 up to 8K, 0.125 above).
SEAM_SCALE_8K = 0.25
SEAM_SCALE_16K = 0.125
#: Sky fill: rows sampled under the top edge per 8192 px of width, and the box blur width as a
#: share of the canvas width (P0: a heavy blur, or the fill streaks).
FILL_BAND_PER_8K = 12
FILL_BLUR_SHARE = 1 / 12
#: The zenith is this much brighter than the mean top edge colour.
ZENITH_GAIN = 1.05
#: Pixels of sky computed at a time (bounds the float32 work arrays).
FILL_STRIP_PIXELS = 1 << 19
#: A canvas whose covered columns are fewer than this share is a wide panorama.
FULL_COVERAGE_SHARE = 0.995
THUMB_SIZE = (512, 256)


@dataclass
class Piece:
    image: np.ndarray  # (h, w, 3) uint8
    mask: np.ndarray  # (h, w) uint8
    corner: tuple[int, int]  # (x, y) on the canvas


def frame_scale(focal: float, canvas_width: int) -> float:
    """How much to shrink a frame for a canvas: its pixels per degree to 1.4 times the canvas's."""
    ppd_canvas = canvas_width / 360.0
    ppd_frame = focal * math.pi / 180.0
    return min(1.0, COMPOSE_OVERSAMPLE * ppd_canvas / ppd_frame)


def _project(d: np.ndarray, rot: np.ndarray, f: float, w: int, h: int, margin: float):
    q = d @ rot.astype(np.float32)  # R^T d per ray
    z = q[..., 2]
    cx, cy = principal(w, h)
    with np.errstate(divide="ignore", invalid="ignore"):
        u = f * q[..., 0] / z + cx
        v = f * q[..., 1] / z + cy
    ok = (z > 1e-6) & (u >= -margin) & (u <= w - 1 + margin) & (v >= -margin) & (v <= h - 1 + margin)
    return u.astype(np.float32), v.astype(np.float32), ok


def footprint(rot: np.ndarray, f: float, w: int, h: int, cw: int, ch: int) -> list[tuple[int, int, int, int]]:
    """Canvas boxes (x0, y0, x1, y1) a frame lands in: one, two across the wrap, or full width."""
    s = FOOTPRINT_STEP
    gw, gh = math.ceil(cw / s), math.ceil(ch / s)
    d = equirect_dirs(gw, gh, 0, 0, gw, gh)
    _, _, ok = _project(d, rot, f, w, h, margin=2 * s)
    if not ok.any():
        return []
    rows = np.where(ok.any(axis=1))[0]
    y0, y1 = max(0, rows.min() * s - 2 * s), min(ch, rows.max() * s + 3 * s)
    cols = ok.any(axis=0)
    if cols.all() or ok[0].any() or ok[-1].any():
        return [(0, y0, cw, y1)]
    if cols[0] and cols[-1]:
        gap = np.where(~cols)[0]
        return [(0, y0, min(cw, gap.min() * s + s), y1), (max(0, gap.max() * s), y0, cw, y1)]
    idx = np.where(cols)[0]
    return [(max(0, idx.min() * s - 2 * s), y0, min(cw, idx.max() * s + 3 * s), y1)]


def warp(img: np.ndarray, rot: np.ndarray, f: float, cw: int, ch: int) -> list[Piece]:
    """The pieces of one frame on a cw x ch canvas."""
    h, w = img.shape[:2]
    out = []
    for x0, y0, x1, y1 in footprint(rot, f, w, h, cw, ch):
        mx = np.empty((y1 - y0, x1 - x0), np.float32)
        my = np.empty_like(mx)
        for r0 in range(y0, y1, WARP_STRIP_ROWS):
            r1 = min(y1, r0 + WARP_STRIP_ROWS)
            u, v, ok = _project(equirect_dirs(cw, ch, x0, r0, x1, r1), rot, f, w, h, margin=-1)
            u[~ok] = -1
            v[~ok] = -1
            mx[r0 - y0 : r1 - y0], my[r0 - y0 : r1 - y0] = u, v
        valid = (mx >= 0).astype(np.uint8) * 255
        valid = cv2.erode(valid, np.ones((3, 3), np.uint8))
        if not valid.any():
            continue
        piece = cv2.remap(img, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
        out.append(Piece(piece, valid, (x0, y0)))
    return out


def seam_scale(width: int) -> float:
    return SEAM_SCALE_8K if width <= 8192 else SEAM_SCALE_16K


def wrap_pad(width: int) -> int:
    """Columns copied across the 180 degree meridian on each side, so the blend sees the canvas
    as the closed ring it is and its two edges meet without a step."""
    return max(32, width // 32)


def _wrapped(pieces: list[Piece], cw: int, pad: int) -> list[Piece]:
    """Pieces on a canvas widened by `pad` on both sides, with copies of those near an edge."""
    out = []
    for p in pieces:
        x, y = p.corner
        w = p.image.shape[1]
        out.append(Piece(p.image, p.mask, (x + pad, y)))
        if x < pad:
            out.append(Piece(p.image, p.mask, (x + cw + pad, y)))
        if x + w > cw - pad:
            out.append(Piece(p.image, p.mask, (x - cw + pad, y)))
    return [q for q in out if q.corner[0] + q.image.shape[1] > 0 and q.corner[0] < cw + 2 * pad]


def blend(pieces: list[Piece], cw: int, ch: int, check: Callable[[], None] = lambda: None):
    """Exposure, seams and the multi-band blend: the canvas (uint8) and its coverage mask."""
    pad = wrap_pad(cw)
    pieces = [_clip(p, cw + 2 * pad) for p in _wrapped(pieces, cw, pad)]
    full_w = cw + 2 * pad
    ss = seam_scale(cw)
    small = [cv2.resize(p.image, None, fx=ss, fy=ss, interpolation=cv2.INTER_AREA) for p in pieces]
    smask = [
        cv2.resize(p.mask, (s.shape[1], s.shape[0]), interpolation=cv2.INTER_NEAREST)
        for p, s in zip(pieces, small, strict=True)
    ]
    scorn = [(round(p.corner[0] * ss), round(p.corner[1] * ss)) for p in pieces]
    comp = cv2.detail.ExposureCompensator_createDefault(cv2.detail.ExposureCompensator_GAIN)
    comp.feed(corners=scorn, images=[cv2.UMat(s) for s in small], masks=[cv2.UMat(m) for m in smask])
    check()
    seams = cv2.detail_DpSeamFinder("COLOR_GRAD").find(
        [cv2.UMat(s.astype(np.float32)) for s in small], scorn, [cv2.UMat(m) for m in smask]
    )
    check()
    blender = cv2.detail_MultiBandBlender()
    blender.setNumBands(max(1, int(math.log2(max(cw / 8, 1)) - 4)))
    blender.prepare((0, 0, full_w, ch))
    for k, p in enumerate(pieces):
        check()
        # a copy: the wrap duplicates share their image, and apply writes into it
        img = comp.apply(k, p.corner, p.image.copy(), p.mask)
        sm = seams[k].get() if isinstance(seams[k], cv2.UMat) else seams[k]
        sm = cv2.resize(sm, (p.mask.shape[1], p.mask.shape[0]), interpolation=cv2.INTER_LINEAR)
        sm = cv2.dilate(sm, np.ones((3, 3), np.uint8))
        blender.feed(np.asarray(img).astype(np.int16), cv2.bitwise_and(sm, p.mask), p.corner)
    res, mask = blender.blend(None, None)
    res = res.get() if isinstance(res, cv2.UMat) else res
    mask = mask.get() if isinstance(mask, cv2.UMat) else mask
    pano = np.clip(res[:, pad : pad + cw], 0, 255).astype(np.uint8)
    return pano, np.ascontiguousarray(mask[:, pad : pad + cw])


def _clip(p: Piece, width: int) -> Piece:
    """A piece cut to the canvas columns [0, width)."""
    x, y = p.corner
    a = max(0, -x)
    b = min(p.image.shape[1], width - x)
    if a == 0 and b == p.image.shape[1]:
        return p
    return Piece(p.image[:, a:b], p.mask[:, a:b], (x + a, y))


def _edges(covered: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    any_col = covered.any(axis=0)
    h = covered.shape[0]
    top = np.where(any_col, covered.argmax(axis=0), h // 2)
    bottom = np.where(any_col, h - 1 - covered[::-1].argmax(axis=0), h // 2)
    return any_col, top, bottom


def coverage_deg(covered: np.ndarray) -> tuple[float, float]:
    """Degrees above and below the horizon that real pixels reach (median over covered columns)."""
    any_col, top, bottom = _edges(covered > 0)
    h = covered.shape[0]
    if not any_col.any():
        return 0.0, 0.0
    t = float(np.median(top[any_col]))
    b = float(np.median(bottom[any_col]))
    return round(90 - (t + 0.5) / h * 180, 2), round((b + 0.5) / h * 180 - 90, 2)


def fill_sky(pano: np.ndarray, covered: np.ndarray) -> None:
    """In place: above each column's top edge, a gradient from a heavily smoothed edge colour to a
    zenith colour; holes below the top edge take a blurred copy of their surroundings."""
    h, w = covered.shape
    cov = covered > 0
    any_col, top, _ = _edges(cov)
    if not any_col.any():
        return
    band = FILL_BAND_PER_8K * w // 8192 + 4
    edge = np.empty((w, 3), np.float32)
    for x in range(w):
        t = int(top[x])
        edge[x] = np.median(pano[t : t + band, x], axis=0) if any_col[x] else np.nan
    edge[~any_col] = np.nanmean(edge[any_col], axis=0)
    k = int(w * FILL_BLUR_SHARE) // 2 * 2 + 1
    padded = np.concatenate([edge[-k:], edge, edge[:k]])
    edge = cv2.blur(padded[None], (k, 1))[0][k:-k]
    zenith = edge.mean(axis=0) * ZENITH_GAIN
    topf = np.maximum(top.astype(np.float32), 1.0)
    step = max(1, FILL_STRIP_PIXELS // w)
    span = (edge - zenith[None]).astype(np.float32)
    for r0 in range(0, int(top.max()), step):
        r1 = min(h, r0 + step)
        yy = np.arange(r0, r1, dtype=np.float32)[:, None]
        a = np.clip(yy / topf[None], 0, 1)
        sky = a[..., None] * span[None]
        sky += zenith
        above = yy < top[None]
        np.clip(sky, 0, 255, out=sky)
        pano[r0:r1][above] = sky[above].astype(np.uint8)
    _fill_holes(pano, cov, top)


def _fill_holes(pano: np.ndarray, cov: np.ndarray, top: np.ndarray) -> None:
    """Uncovered pixels below the top edge take a blurred copy of their surroundings."""
    h, w = cov.shape
    holes = ~cov
    holes[np.arange(h)[:, None] < top[None]] = False
    if holes.any():
        small = cv2.resize(pano, (max(1, w // 16), max(1, h // 16)), interpolation=cv2.INTER_AREA)
        smask = cv2.resize(
            holes.astype(np.uint8) * 255, (small.shape[1], small.shape[0]), interpolation=cv2.INTER_NEAREST
        )
        small = cv2.inpaint(small, smask, 3, cv2.INPAINT_TELEA)
        up = cv2.resize(small, (w, h), interpolation=cv2.INTER_LINEAR)
        pano[holes] = up[holes]


def fill_wide(pano: np.ndarray, covered: np.ndarray) -> None:
    """In place: a wide panorama's uncovered corners take a blurred copy of their surroundings."""
    cov = covered > 0
    _fill_holes(pano, cov, np.zeros(cov.shape[1], np.int64))


def wide_crop(covered: np.ndarray) -> tuple[int, int, int, int] | None:
    """For a canvas whose horizon band (30 degrees either side) is not covered all round: the
    shift that brings the covered run of columns to the left edge, and the box (shift, top,
    bottom, width) to keep after it; None for a full sphere. The nadir frame covers every column
    near the bottom, so only the band decides."""
    cov = covered > 0
    h = cov.shape[0]
    cols = cov[h // 3 : 2 * h // 3].any(axis=0)
    if cols.mean() >= FULL_COVERAGE_SHARE:
        return None
    w = cols.size
    # start of the longest circular run of covered columns
    doubled = np.concatenate([cols, cols])
    best_len, best_start, run = 0, 0, 0
    for i, c in enumerate(doubled):
        run = run + 1 if c else 0
        if run > best_len:
            best_len, best_start = run, i - run + 1
    best_len = min(best_len, w)
    shift = best_start % w
    kept = np.roll(cov, -shift, axis=1)[:, :best_len]
    _, top, bottom = _edges(kept)
    return shift, int(np.median(top)), int(np.median(bottom)) + 1, best_len


def apply_wide_crop(img: np.ndarray, crop: tuple[int, int, int, int]) -> np.ndarray:
    shift, y0, y1, width = crop
    rolled = np.roll(img, -shift, axis=1)
    return np.ascontiguousarray(rolled[y0:y1, :width])


def yaw_range_deg(crop: tuple[int, int, int, int], canvas_width: int) -> tuple[float, float]:
    """Yaw (clockwise from north) of a wide crop's left and right edges."""
    shift, _, _, width = crop
    left = shift / canvas_width * 360 - 180
    return round(left, 3), round(left + width / canvas_width * 360, 3)


def lat_range_deg(crop: tuple[int, int, int, int], canvas_height: int) -> tuple[float, float]:
    """Degrees above (top) and below (bottom) the horizon of a wide crop's edges."""
    _, y0, y1, _ = crop
    return round(90 - y0 / canvas_height * 180, 3), round(y1 / canvas_height * 180 - 90, 3)


def thumbnail(img: np.ndarray) -> np.ndarray:
    return cv2.resize(img, THUMB_SIZE, interpolation=cv2.INTER_AREA)
```

- [ ] **Step 4: Run the tests**

Run: `cd python; uv run pytest tests/test_pano_compose.py -q --durations=5`
Expected: PASS (8 tests, about 10 s). The strip-wise fill peaks at about 1.4 times the image on a 4096 x 2048 canvas (the test allows 2); a float64 copy of the canvas would be 8.

- [ ] **Step 5: Update from the P0 report**

Same check as Task 4 for `COMPOSE_OVERSAMPLE`, the seam scales, the band count rule, `FILL_BLUR_SHARE` and `ZENITH_GAIN`.

- [ ] **Step 6: Commit**

```bash
git add python/src/aio_pipelines/pano/compose.py python/tests/test_pano_compose.py
git commit -m "feat(pipelines): compose drone spheres with wrap-aware blending and sky fill" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The `pano.stitch` pipeline, its run record and registration (Python)

**Files:**

- Create: `python/src/aio_pipelines/pano/record.py`, `python/src/aio_pipelines/pano/pipeline.py`, `python/tests/test_pano_stitch.py`
- Modify: `python/src/aio_pipelines/pipelines.py` (import and list `PanoStitch`)

**Interfaces:**

- Consumes: Task 1 fixture `packages/schema/src/__fixtures__/pano/stitch.synthetic.json`; Task 3 `frames.*`, `rot_from_gimbal`; Task 4 `align.work_scale`, `match_frames`, `align`, `PairMatch`; Task 5 `compose.*`; runtime `Step`, `StepContext`, `JobError`, `atomic_write_bytes`, `atomic_write_json`, `commit_files`, `now_iso`; `params.known_keys`; `photo.native.check_disk`; `conftest.run_job` in tests.
- Produces: `PanoStitch` (`name = "pano.stitch"`, `validate`, `inputs`, `plan`), `pipeline.WIDTH_ENV = "QUADRION_PANO_WIDTH"`, `pipeline.WEIGHTS`, `pipeline.FRAMES_MISSING`, `pipeline.out_width(quality)`; `record.SCHEMA`, `record.check_record(doc)`. Output files `panoramas/<layer>/<pano>/{pano.jpg,thumb.jpg,stitch.json}`; `stitch.json` matches `PanoStitchFile` of Task 1 and names `run` (the job id).

The pipeline calls `align.match_frames` and `compose.blend` through their modules, so the cancel-and-resume test can wrap them.

- [ ] **Step 1: Write the failing tests**

`python/tests/test_pano_stitch.py` (the end-to-end runs use 480 px frames and `QUADRION_PANO_WIDTH=1024`; each takes 2 to 6 s):

```python
"""``pano.stitch`` end to end on synthetic spheres (plan task 6)."""

from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np
import pytest

import pano_synth as ps
from aio_pipelines.pano import align, compose, pipeline
from aio_pipelines.pano.pipeline import FRAMES_MISSING, PanoStitch
from aio_pipelines.pano.record import check_record
from aio_pipelines.runtime import Cancelled, JobError
from conftest import run_job

FIXTURE = (
    Path(__file__).resolve().parents[2]
    / "packages"
    / "schema"
    / "src"
    / "__fixtures__"
    / "pano"
    / "stitch.synthetic.json"
)
PARAMS = {"layer": "panos-2026-09-10", "pano": "p01"}
WIDE_SHOTS = [(y, p) for y in (-100, -67.8, -35.7, -3.5, 28.7, 60.8, 93) for p in (20, -17, -55)] + [
    (0.0, -90.0)
]


def stitch(project: Path, job_id: str = "j1") -> dict:
    return run_job(PanoStitch(), project, PARAMS, job_id=job_id)[0]


@pytest.fixture
def project(tmp_path, monkeypatch):
    monkeypatch.setenv(pipeline.WIDTH_ENV, "1024")
    root = tmp_path / "Projet Ã©tÃ©"  # a non-ASCII project path (Review Focus 4)
    root.mkdir()
    return root


def frames_dir(project: Path) -> Path:
    return project / "panoramas" / PARAMS["layer"] / PARAMS["pano"] / "frames"


def read_jpeg(path: Path) -> np.ndarray:
    return cv2.imdecode(np.fromfile(str(path), np.uint8), cv2.IMREAD_COLOR)


def test_parameters_are_checked():
    p = PanoStitch()
    assert p.validate(dict(PARAMS)) == PARAMS
    with pytest.raises(JobError, match="needs: pano"):
        p.validate({"layer": "l"})
    with pytest.raises(JobError, match="lower-case"):
        p.validate({"layer": "../x", "pano": "p01"})
    with pytest.raises(JobError, match="standard or high"):
        p.validate({**PARAMS, "quality": "ultra"})
    with pytest.raises(JobError, match="does not take: width"):
        p.validate({**PARAMS, "width": 1024})


def test_output_width_by_quality_and_the_test_override(monkeypatch):
    monkeypatch.delenv(pipeline.WIDTH_ENV, raising=False)
    assert pipeline.out_width("standard") == 8192 and pipeline.out_width("high") == 16384
    monkeypatch.setenv(pipeline.WIDTH_ENV, "1025")
    assert pipeline.out_width("standard") == 1024
    monkeypatch.setenv(pipeline.WIDTH_ENV, "100")
    with pytest.raises(JobError, match="512 to 16384"):
        pipeline.out_width("standard")


def test_stitches_a_sphere_into_a_non_ascii_project(project):
    ps.make_sphere(frames_dir(project), "rows", frame_w=480, seed=3)
    result = stitch(project)
    assert result["status"] == "done"
    folder = frames_dir(project).parent
    doc = json.loads((folder / "stitch.json").read_text("utf-8"))
    check_record(doc)
    assert doc["run"] == "j1" and doc["aligned"] == "features" and doc["shape"] == "sphere"
    assert doc["size"] == {"width": 1024, "height": 512} and len(doc["frames"]["used"]) == 25
    assert doc["coverage"]["bottomDeg"] > 85 and 15 < doc["coverage"]["topDeg"] < 30
    assert set(doc["timings"]) == set(pipeline.WEIGHTS)
    assert read_jpeg(folder / "pano.jpg").shape == (512, 1024, 3)
    assert read_jpeg(folder / "thumb.jpg").shape == (256, 512, 3)


def test_a_wide_panorama_is_cropped_and_records_its_yaw_range(project):
    ps.make_sphere(frames_dir(project), "bursts", frame_w=480, seed=3, shots=WIDE_SHOTS)
    stitch(project)
    doc = json.loads((frames_dir(project).parent / "stitch.json").read_text("utf-8"))
    assert doc["shape"] == "wide" and doc["size"]["width"] < 1024
    cov = doc["coverage"]
    assert cov["leftDeg"] < -100 and cov["rightDeg"] > 93 and cov["rightDeg"] - cov["leftDeg"] < 330


def test_a_textureless_sphere_still_gives_an_image_aligned_from_metadata(project):
    ps.make_sphere(frames_dir(project), "bursts", scene=ps.make_scene(textureless=True), frame_w=480, seed=3)
    stitch(project)
    doc = json.loads((frames_dir(project).parent / "stitch.json").read_text("utf-8"))
    assert doc["aligned"] == "metadata" and doc["residualPx"] is None and doc["focalScale"] == 1.0
    assert doc["warnings"] == ["Aligned from the gimbal angles only: No features matched between frames."]
    assert (frames_dir(project).parent / "pano.jpg").is_file()


def test_missing_frames_fail_with_a_message(project):
    with pytest.raises(JobError, match=FRAMES_MISSING):
        stitch(project)
    frames = ps.make_sphere(frames_dir(project), "rows", frame_w=320, seed=3)
    for f in frames[5:]:
        f.path.unlink()
    with pytest.raises(JobError, match=FRAMES_MISSING):
        stitch(project, "j2")


def test_unusable_frames_are_dropped_and_named(project):
    frames = ps.make_sphere(frames_dir(project), "rows", frame_w=480, seed=3)
    frames[0].path.write_bytes(b"not a jpeg")
    stitch(project)
    doc = json.loads((frames_dir(project).parent / "stitch.json").read_text("utf-8"))
    assert doc["frames"]["dropped"] == [{"file": frames[0].path.name, "reason": "Could not be read"}]
    assert len(doc["frames"]["used"]) == 24


def test_a_cancel_while_composing_resumes_without_matching_again(project, monkeypatch):
    ps.make_sphere(frames_dir(project), "rows", frame_w=480, seed=3)
    calls = {"match": 0, "blend": 0}
    real_match, real_blend = align.match_frames, compose.blend

    def counting_match(*a, **k):
        calls["match"] += 1
        return real_match(*a, **k)

    def cancelling_blend(*a, **k):
        calls["blend"] += 1
        if calls["blend"] == 1:
            raise Cancelled()
        return real_blend(*a, **k)

    monkeypatch.setattr(align, "match_frames", counting_match)
    monkeypatch.setattr(compose, "blend", cancelling_blend)
    with pytest.raises(Cancelled):
        stitch(project)
    assert not (frames_dir(project).parent / "pano.jpg").exists()
    assert stitch(project)["status"] == "done"
    assert calls == {"match": 1, "blend": 2}


def test_the_shared_fixture_passes_the_python_check():
    doc = json.loads(FIXTURE.read_text("utf-8"))
    check_record(doc)
    with pytest.raises(ValueError, match="the set of fields"):
        check_record({k: v for k, v in doc.items() if k != "run"})
    with pytest.raises(ValueError, match="frames"):
        check_record({**doc, "frames": {"used": ["a/b.jpg"], "dropped": []}})


def test_pano_stitch_is_registered():
    from aio_pipelines.pipelines import all_pipelines

    assert isinstance(all_pipelines()["pano.stitch"], PanoStitch)
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd python; uv run pytest tests/test_pano_stitch.py -q`
Expected: FAIL at collection, `No module named 'aio_pipelines.pano.pipeline'`.

- [ ] **Step 3: Write `python/src/aio_pipelines/pano/record.py`**

```python
"""``stitch.json`` (``aio.pano-stitch/1``): the run record of ``pano.stitch``.

The TypeScript schema is the contract (``packages/schema/src/panoStitch.ts`` ``PanoStitchFile``);
``check_record`` is a Python copy of its field set and types, run on every record before it is
written and tested against the shared fixture ``__fixtures__/pano/stitch.synthetic.json``.
"""

from __future__ import annotations

import re
from typing import Any

SCHEMA = "aio.pano-stitch/1"
PANO_ID = re.compile(r"^[a-z0-9][a-z0-9-]*$")
KEYS = {
    "schema",
    "run",
    "layer",
    "pano",
    "createdAt",
    "engine",
    "quality",
    "shape",
    "size",
    "frames",
    "aligned",
    "residualPx",
    "maxDriftDeg",
    "focalScale",
    "coverage",
    "timings",
    "warnings",
}


def _num(v: Any) -> bool:
    return isinstance(v, int | float) and not isinstance(v, bool)


def _frame_name(v: Any) -> bool:
    return isinstance(v, str) and 1 <= len(v) <= 260 and "/" not in v and "\\" not in v


def check_record(doc: Any) -> None:
    """Raise ValueError naming the first field that ``PanoStitchFile`` would refuse."""

    def bad(field: str) -> ValueError:
        return ValueError(f"stitch.json: {field} is not what aio.pano-stitch/1 allows")

    if not isinstance(doc, dict) or set(doc) != KEYS:
        raise bad("the set of fields")
    if doc["schema"] != SCHEMA:
        raise bad("schema")
    if not isinstance(doc["run"], str) or not 1 <= len(doc["run"]) <= 128:
        raise bad("run")
    for key in ("layer", "pano"):
        if not isinstance(doc[key], str) or not 1 <= len(doc[key]) <= 80 or not PANO_ID.match(doc[key]):
            raise bad(key)
    if not isinstance(doc["createdAt"], str) or not re.match(
        r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d", doc["createdAt"]
    ):
        raise bad("createdAt")
    eng = doc["engine"]
    if (
        not isinstance(eng, dict)
        or not isinstance(eng.get("version"), str)
        or not 1 <= len(eng["version"]) <= 40
    ):
        raise bad("engine")
    if doc["quality"] not in ("standard", "high"):
        raise bad("quality")
    if doc["shape"] not in ("sphere", "wide"):
        raise bad("shape")
    size = doc["size"]
    if not isinstance(size, dict) or not all(
        isinstance(size.get(k), int) and size[k] > 0 for k in ("width", "height")
    ):
        raise bad("size")
    fr = doc["frames"]
    if (
        not isinstance(fr, dict)
        or not isinstance(fr.get("used"), list)
        or not all(_frame_name(n) for n in fr["used"])
        or not isinstance(fr.get("dropped"), list)
        or not all(
            isinstance(d, dict)
            and _frame_name(d.get("file"))
            and isinstance(d.get("reason"), str)
            and d["reason"]
            for d in fr["dropped"]
        )
    ):
        raise bad("frames")
    if doc["aligned"] not in ("features", "metadata"):
        raise bad("aligned")
    for key in ("residualPx", "maxDriftDeg"):
        if doc[key] is not None and (not _num(doc[key]) or doc[key] < 0):
            raise bad(key)
    if not _num(doc["focalScale"]) or doc["focalScale"] <= 0:
        raise bad("focalScale")
    cov = doc["coverage"]
    if not isinstance(cov, dict) or not all(
        _num(cov.get(k)) and -90 <= cov[k] <= 90 for k in ("topDeg", "bottomDeg")
    ):
        raise bad("coverage")
    if not set(cov) <= {"topDeg", "bottomDeg", "leftDeg", "rightDeg"} or any(
        k in cov and not _num(cov[k]) for k in ("leftDeg", "rightDeg")
    ):
        raise bad("coverage")
    if not isinstance(doc["timings"], dict) or not all(_num(v) and v >= 0 for v in doc["timings"].values()):
        raise bad("timings")
    w = doc["warnings"]
    if not isinstance(w, list) or len(w) > 50 or not all(isinstance(s, str) and len(s) <= 400 for s in w):
        raise bad("warnings")
```

- [ ] **Step 4: Write `python/src/aio_pipelines/pano/pipeline.py`**

```python
"""``pano.stitch``: the frames of one drone sphere into a level, north-up equirect.

Plan ``docs/plans/2026-10-13-drone-panoramas-p1.md`` (task 6), spec section 2. Reads
``panoramas/<layer>/<pano>/frames/`` and writes ``pano.jpg``, ``thumb.jpg`` and, last,
``stitch.json`` beside it; never the manifest (the app files the outcome). Steps, weighted by the
P0 timings: ``read`` (frame metadata, disk check), ``seed`` (rotations from the gimbal angles),
``match`` (features between overlapping frames), ``adjust`` (bundle adjustment or the seeds),
``compose`` (warp, exposure, seams, blend), ``fill`` (sky fill or wide crop, JPEGs), ``write``
(run record, files moved into place together). Everything a later step needs is in the job's
staging folder or the step outputs, so a cancelled job resumes from its last finished step, and
the old ``pano.jpg`` stays until a new one is complete.
"""

from __future__ import annotations

import os
import re
import time
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from .. import __version__
from ..params import known_keys
from ..photo.native import check_disk
from ..runtime import (
    JobError,
    Step,
    StepContext,
    atomic_write_bytes,
    atomic_write_json,
    commit_files,
    now_iso,
)
from . import align, compose
from .frames import FrameError, FrameInfo, encode_jpeg, list_frames, read_frame_info, read_image
from .geometry import rot_from_gimbal
from .record import SCHEMA, check_record

PANO_ID = re.compile(r"^[a-z0-9][a-z0-9-]*$")
WIDTHS = {"standard": 8192, "high": 16384}
#: Test-only output width (e2e and pytest): 512 to 16384 pixels.
WIDTH_ENV = "QUADRION_PANO_WIDTH"
MIN_FRAMES = 8
JPEG_QUALITY = 90
#: Disk the job needs per output pixel: the staged canvas and mask, the JPEGs and headroom.
DISK_BYTES_PER_PIXEL = 8
FRAMES_MISSING = "The frames of this panorama are missing."
#: Step weights: seconds per step at 8K on 24 cores, measured by P0.
WEIGHTS = {"read": 0.2, "seed": 0.1, "match": 5.7, "adjust": 6.0, "compose": 10.5, "fill": 2.4, "write": 1.0}


def out_width(quality: str) -> int:
    raw = os.environ.get(WIDTH_ENV)
    if not raw:
        return WIDTHS[quality]
    try:
        width = int(raw)
    except ValueError:
        raise JobError(f"{WIDTH_ENV} must be a whole number of pixels.") from None
    if not 512 <= width <= 16384:
        raise JobError(f"{WIDTH_ENV} must be 512 to 16384.")
    return width // 2 * 2


def _png(img: np.ndarray) -> bytes:
    ok, buf = cv2.imencode(".png", img, [cv2.IMWRITE_PNG_COMPRESSION, 1])
    if not ok:
        raise JobError("The stitched image could not be staged.")
    return buf.tobytes()


def _unpng(path: Path, flag: int) -> np.ndarray:
    img = cv2.imdecode(np.fromfile(str(path), dtype=np.uint8), flag)
    if img is None:
        raise JobError("The staged image is missing; start the stitch again.")
    return img


def _thumb(img: np.ndarray, wide: bool) -> np.ndarray:
    if not wide:
        return compose.thumbnail(img)
    h, w = img.shape[:2]
    size = (compose.THUMB_SIZE[0], max(1, round(compose.THUMB_SIZE[0] * h / w)))
    return cv2.resize(img, size, interpolation=cv2.INTER_AREA)


class PanoStitch:
    name = "pano.stitch"
    title = "Stitch drone panorama"
    description = (
        "One level, north-up 360 panorama from the frames of a drone sphere, aligned from its gimbal angles "
        "and features."
    )
    keys = frozenset({"layer", "pano", "quality"})
    required = frozenset({"layer", "pano"})

    # --- parameters (PanoStitchParams in packages/schema/src/jobs.ts) ----------------------------

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        known_keys(params, set(self.keys), self.name)
        missing = sorted(k for k in self.required if params.get(k) is None)
        if missing:
            raise JobError(f"{self.name} needs: {', '.join(missing)}.")
        for key in ("layer", "pano"):
            v = params[key]
            if not isinstance(v, str) or not 1 <= len(v) <= 80 or not PANO_ID.match(v):
                raise JobError(f"{key} must be lower-case letters, digits and dashes, at most 80.")
        if params.get("quality") is not None and params["quality"] not in WIDTHS:
            raise JobError("quality must be standard or high.")
        return dict(params)

    def inputs(self, params: dict[str, Any]) -> list[str]:
        return [f"panoramas/{params['layer']}/{params['pano']}/frames"]

    def plan(self, params: dict[str, Any]) -> list[Step]:
        layer: str = params["layer"]
        pano: str = params["pano"]
        quality: str = params.get("quality") or "standard"
        rel = f"panoramas/{layer}/{pano}"

        def frames_dir(ctx: StepContext) -> Path:
            return ctx.out(f"{rel}/frames")

        def infos(ctx: StepContext) -> list[FrameInfo]:
            return [FrameInfo.from_json(d) for d in ctx.outputs("read")["frames"]]

        def seeds(ctx: StepContext) -> list[np.ndarray]:
            return [np.array(s, float) for s in ctx.outputs("seed")["seeds"]]

        # --- read --------------------------------------------------------------------------------
        def read(ctx: StepContext) -> dict[str, Any]:
            t0 = time.monotonic()
            width = out_width(quality)
            paths = list_frames(frames_dir(ctx))
            if not paths:
                raise JobError(FRAMES_MISSING)
            used: list[FrameInfo] = []
            dropped: list[dict[str, str]] = []
            for p in paths:
                ctx.check()
                try:
                    used.append(read_frame_info(p))
                except FrameError as e:
                    dropped.append({"file": p.name, "reason": str(e)})
            if len(used) < MIN_FRAMES:
                raise JobError(
                    f"Only {len(used)} of the frames can be used; a panorama needs at least {MIN_FRAMES}."
                    if len(paths) >= MIN_FRAMES
                    else FRAMES_MISSING
                )
            sizes = {(f.width, f.height) for f in used}
            if len(sizes) > 1:
                raise JobError("The frames of this panorama are not all the same size.")
            check_disk(ctx.project, width * (width // 2) * DISK_BYTES_PER_PIXEL)
            return {
                "frames": [f.to_json() for f in used],
                "dropped": dropped,
                "width": width,
                "seconds": time.monotonic() - t0,
            }

        # --- seed --------------------------------------------------------------------------------
        def seed(ctx: StepContext) -> dict[str, Any]:
            t0 = time.monotonic()
            rots = [rot_from_gimbal(f.yaw, f.pitch, f.roll).tolist() for f in infos(ctx)]
            return {"seeds": rots, "seconds": time.monotonic() - t0}

        # --- match -------------------------------------------------------------------------------
        def match(ctx: StepContext) -> dict[str, Any]:
            t0 = time.monotonic()
            fs = infos(ctx)
            scale = align.work_scale(fs[0].width)
            grays = []
            for n, f in enumerate(fs):
                ctx.check()
                grays.append(read_image(frames_dir(ctx) / f.name, scale, gray=True))
                ctx.progress(0.3 * (n + 1) / len(fs))
            focal = fs[0].focal * scale
            found = align.match_frames(
                grays, seeds(ctx), focal, ctx.check, lambda x: ctx.progress(0.3 + 0.7 * x)
            )
            size = [int(grays[0].shape[1]), int(grays[0].shape[0])]
            staged = ctx.stage("match.npz")
            empty = np.zeros((0, 2), np.float32)
            np.savez(
                staged,
                i=np.array([m.i for m in found], np.int32),
                j=np.array([m.j for m in found], np.int32),
                n=np.array([len(m.a) for m in found], np.int32),
                a=np.concatenate([m.a for m in found]) if found else empty,
                b=np.concatenate([m.b for m in found]) if found else empty,
            )
            return {
                "pairs": len(found),
                "focalWork": focal,
                "workSize": size,
                "seconds": time.monotonic() - t0,
            }

        # --- adjust ------------------------------------------------------------------------------
        def adjust(ctx: StepContext) -> dict[str, Any]:
            t0 = time.monotonic()
            m = ctx.outputs("match")
            with np.load(ctx.stage("match.npz")) as z:
                bounds = np.concatenate([[0], np.cumsum(z["n"])])
                found = [
                    align.PairMatch(int(i), int(j), z["a"][s:e], z["b"][s:e])
                    for i, j, s, e in zip(z["i"], z["j"], bounds[:-1], bounds[1:], strict=True)
                ]
            result = align.align(seeds(ctx), found, float(m["focalWork"]), tuple(m["workSize"]))
            if result.reason:
                ctx.log(f"Aligned from the gimbal angles only: {result.reason}", "warn")
            return {
                "rotations": [r.tolist() for r in result.rotations],
                "aligned": result.aligned,
                "focalScale": result.focal_scale,
                "residualPx": result.residual_px,
                "maxDriftDeg": result.max_drift_deg,
                "unmatched": result.unmatched,
                "reason": result.reason,
                "seconds": time.monotonic() - t0,
            }

        # --- compose -----------------------------------------------------------------------------
        def compose_step(ctx: StepContext) -> dict[str, Any]:
            t0 = time.monotonic()
            width = int(ctx.outputs("read")["width"])
            height = width // 2
            adj = ctx.outputs("adjust")
            fs = infos(ctx)
            pieces: list[compose.Piece] = []
            for n, (f, rot) in enumerate(zip(fs, adj["rotations"], strict=True)):
                ctx.check()
                focal = f.focal * float(adj["focalScale"])
                scale = compose.frame_scale(focal, width)
                img = read_image(frames_dir(ctx) / f.name, scale)
                pieces += compose.warp(img, np.array(rot, float), focal * scale, width, height)
                ctx.progress(0.6 * (n + 1) / len(fs))
            canvas, covered = compose.blend(pieces, width, height, ctx.check)
            del pieces
            atomic_write_bytes(ctx.stage("canvas.png"), _png(canvas))
            atomic_write_bytes(ctx.stage("covered.png"), _png(covered))
            return {"seconds": time.monotonic() - t0}

        # --- fill --------------------------------------------------------------------------------
        def fill(ctx: StepContext) -> dict[str, Any]:
            t0 = time.monotonic()
            canvas = _unpng(ctx.stage("canvas.png"), cv2.IMREAD_COLOR)
            covered = _unpng(ctx.stage("covered.png"), cv2.IMREAD_GRAYSCALE)
            h, w = covered.shape
            crop = compose.wide_crop(covered)
            if crop is None:
                top, bottom = compose.coverage_deg(covered)
                coverage: dict[str, float] = {"topDeg": top, "bottomDeg": bottom}
                compose.fill_sky(canvas, covered)
                out = canvas
            else:
                out = compose.apply_wide_crop(canvas, crop)
                compose.fill_wide(out, compose.apply_wide_crop(covered, crop))
                top, bottom = compose.lat_range_deg(crop, h)
                left, right = compose.yaw_range_deg(crop, w)
                coverage = {"topDeg": top, "bottomDeg": bottom, "leftDeg": left, "rightDeg": right}
            ctx.check()
            atomic_write_bytes(ctx.stage("pano.jpg"), encode_jpeg(out, JPEG_QUALITY))
            atomic_write_bytes(ctx.stage("thumb.jpg"), encode_jpeg(_thumb(out, crop is not None), 85))
            return {
                "shape": "sphere" if crop is None else "wide",
                "coverage": coverage,
                "size": {"width": int(out.shape[1]), "height": int(out.shape[0])},
                "seconds": time.monotonic() - t0,
            }

        # --- write -------------------------------------------------------------------------------
        def write(ctx: StepContext) -> dict[str, Any]:
            t0 = time.monotonic()
            rd, adj, fl = ctx.outputs("read"), ctx.outputs("adjust"), ctx.outputs("fill")
            timings = {
                s: round(float(ctx.outputs(s).get("seconds", 0.0)), 3) for s in WEIGHTS if s != "write"
            }
            warnings = [f"Aligned from the gimbal angles only: {adj['reason']}"] if adj.get("reason") else []
            if adj.get("unmatched") and adj["aligned"] == "features":
                warnings.append(
                    f"{len(adj['unmatched'])} frames had no matching features and keep their gimbal angles."
                )
            doc = {
                "schema": SCHEMA,
                "run": ctx.job.job_id,
                "layer": layer,
                "pano": pano,
                "createdAt": now_iso(),
                "engine": {"version": __version__, "opencv": cv2.__version__},
                "quality": quality,
                "shape": fl["shape"],
                "size": fl["size"],
                "frames": {"used": [f["name"] for f in rd["frames"]], "dropped": rd["dropped"]},
                "aligned": adj["aligned"],
                "residualPx": adj["residualPx"],
                "maxDriftDeg": adj["maxDriftDeg"],
                "focalScale": round(float(adj["focalScale"]), 5),
                "coverage": fl["coverage"],
                "timings": {**timings, "write": round(time.monotonic() - t0, 3)},
                "warnings": warnings,
            }
            check_record(doc)
            atomic_write_json(ctx.stage("stitch.json"), doc)
            # the images first, the record last: a reader never sees a record of images not there
            commit_files(
                ctx,
                [
                    ("pano.jpg", f"{rel}/pano.jpg"),
                    ("thumb.jpg", f"{rel}/thumb.jpg"),
                    ("stitch.json", f"{rel}/stitch.json"),
                ],
            )
            return {"seconds": time.monotonic() - t0}

        return [
            Step("read", "Read the frames", read, WEIGHTS["read"]),
            Step("seed", "Start from the gimbal angles", seed, WEIGHTS["seed"]),
            Step("match", "Match features", match, WEIGHTS["match"]),
            Step("adjust", "Align the frames", adjust, WEIGHTS["adjust"]),
            Step("compose", "Compose the panorama", compose_step, WEIGHTS["compose"]),
            Step("fill", "Fill the sky", fill, WEIGHTS["fill"]),
            Step("write", "Write the panorama", write, WEIGHTS["write"]),
        ]
```

- [ ] **Step 5: Register it**

In `python/src/aio_pipelines/pipelines.py` add `from .pano.pipeline import PanoStitch` (sorted with the other imports) and at the end of `items`:

```python
        # Drone panoramas (pipeline pack 0.7.0)
        PanoStitch(),
```

- [ ] **Step 6: Run the tests**

Run: `cd python; uv run pytest tests/test_pano_stitch.py tests/test_pano_geometry.py tests/test_pano_synth.py tests/test_pano_align.py tests/test_pano_compose.py -q --durations=10`
Expected: PASS (43 tests, about a minute). Then `uv run python -m aio_pipelines --list` lists `pano.stitch`, and `uv run ruff check . ; uv run ruff format --check .` is clean.

- [ ] **Step 7: Commit**

```bash
git add python/src/aio_pipelines/pano/record.py python/src/aio_pipelines/pano/pipeline.py python/src/aio_pipelines/pipelines.py python/tests/test_pano_stitch.py
git commit -m "feat(pipelines): pano.stitch pipeline with its aio.pano-stitch/1 run record" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Import and filing in `@aio/project`

**Files:**

- Create: `packages/project/src/builder/panos.ts`, `packages/project/src/builder/panos.test.ts`
- Modify: `packages/project/src/builder/index.ts` (one export block after Task 2's)

**Interfaces:**

- Consumes: Task 1 `PanoStitchFile`, `PANO_STITCH_MAX_BYTES`, `panoFolder`, `PanoQuality`, `PanoStitchStatus`, `PanoRef`; Task 2 `PanoFrameMeta`, `PanoGrouping`, `PanoSphereGroup`; existing `createProject`, `readManifestFile`, `updateManifestFile`, `captureForDate`, `uniqueId` (`create.ts`), `resolveHeights` (`altitude.ts`), `photoRef`, `PhotoFrame` (`photos.ts`), `ImageOps` (`raw.ts`), `defaultUtcOffsetMin`, `gridConvergenceDeg`, `fromWgs84`, `toWgs84` (`@aio/geo`).
- Produces (exported from `@aio/project/builder`):

```ts
export type PanoLayer = Extract<Layer, { kind: 'panoramas' }>;
export interface KeyedGrouping {
  spheres: (PanoSphereGroup & { key: string })[];
  ready: (PanoFrameMeta & { key: string; lat: number; lon: number })[];
}
export function keyGrouping(g: PanoGrouping): KeyedGrouping; // s1, s2 ... and r1, r2 ...
export interface PanoImportChoice {
  keys: readonly string[];
  layerName: string;
  date?: string;
  quality: PanoQuality;
}
export interface PanoImportDeps {
  images: Pick<ImageOps, 'resizeJpeg'>;
  freeBytes(dir: string): Promise<number>;
  onProgress?(done: number, total: number, file: string): void;
  signal?: AbortSignal;
}
export class PanoImportError extends Error {
  readonly code: 'space' | 'cancelled' | 'empty';
}
export const PANO_COPY_HEADROOM: number; // 256 MB
export interface PanoImportResult {
  manifest: ProjectManifest;
  layerId: string;
  stitch: string[];
}
export async function importPanoGroups(
  root: string,
  g: KeyedGrouping,
  choice: PanoImportChoice,
  deps: PanoImportDeps,
): Promise<PanoImportResult>;
export function setPanoRuns(
  m: ProjectManifest,
  layerId: string,
  runs: Readonly<Record<string, string>>,
): ProjectManifest | null;
export interface StitchOutcome {
  layer: string;
  pano: string;
  run: string;
  status: PanoStitchStatus;
  error?: string;
}
export function applyStitchOutcome(
  m: ProjectManifest,
  o: StitchOutcome,
  record?: PanoStitchFile | null,
): ProjectManifest | null;
export async function readStitchRecord(
  root: string,
  layer: string,
  pano: string,
): Promise<PanoStitchFile | null>;
export async function reconcilePanoStitches(
  root: string,
  m: ProjectManifest,
): Promise<ProjectManifest | null>;
export async function knownPanoFrames(
  root: string,
  m: ProjectManifest,
): Promise<Map<string, string>>; // `${name lower}|${bytes}` -> layer name
export function markAlreadyImported(
  g: KeyedGrouping,
  known: ReadonlyMap<string, string>,
): Map<string, string>; // sphere key -> layer name
```

- [ ] **Step 1: Write the failing tests**

`packages/project/src/builder/panos.test.ts`:

```ts
import { gridConvergenceDeg, toWgs84 } from '@aio/geo';
import type { PanoStitchFile } from '@aio/schema';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProject, readManifestFile, writeManifestFile } from './create';
import type { PanoFrameMeta, PanoGrouping } from './panoGroups';
import {
  applyStitchOutcome,
  importPanoGroups,
  keyGrouping,
  knownPanoFrames,
  markAlreadyImported,
  PanoImportError,
  reconcilePanoStitches,
  setPanoRuns,
  type PanoImportDeps,
} from './panos';

let dir: string;
let root: string;
let card: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-panos-'));
  root = (
    await createProject(dir, {
      name: 'Panos',
      type: 'inspection',
      epsg: 32639,
      origin: [500000, 3200000, 0],
      severityTemplate: null,
    })
  ).root;
  card = join(dir, 'card');
  await mkdir(card);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A point `e` m east and `n` m north of the project origin, as GPS. */
const gps = (e: number, n: number) => {
  const [lon, lat] = toWgs84([500000 + e, 3200000 + n, 0], 32639);
  return { lat, lon };
};

async function frames(prefix: string, count: number): Promise<PanoFrameMeta[]> {
  const out: PanoFrameMeta[] = [];
  for (let i = 1; i <= count; i++) {
    const file = join(card, `${prefix}_${String(i).padStart(4, '0')}.JPG`);
    await writeFile(file, `frame ${prefix} ${String(i)}`);
    out.push({ file, bytes: (await stat(file)).size, takenAt: '2026-09-10T10:00:00' });
  }
  return out;
}

async function grouping(): Promise<PanoGrouping> {
  const a = await frames('SYN', 9);
  const b = await frames('SYM', 8);
  const readyFile = join(card, 'pano.jpg');
  await writeFile(readyFile, 'ready');
  return {
    spheres: [
      {
        shape: 'sphere',
        frames: a,
        ...gps(100, 50),
        relAlt: 70,
        absAlt: 620,
        startedAt: '2026-09-10T10:00:00',
        incomplete: false,
        bytes: a.reduce((n, f) => n + f.bytes, 0),
      },
      {
        shape: 'wide',
        frames: b,
        ...gps(-80, 10),
        relAlt: 65,
        startedAt: '2026-09-10T10:05:00',
        incomplete: false,
        bytes: b.reduce((n, f) => n + f.bytes, 0),
      },
    ],
    ready: [{ file: readyFile, bytes: 5, ...gps(0, 0), width: 4000, height: 2000 }],
    skipped: [],
  };
}

const deps = (over: Partial<PanoImportDeps> = {}): PanoImportDeps => ({
  images: {
    resizeJpeg: async (_src, dst) => {
      await writeFile(dst, 'thumb');
    },
  },
  freeBytes: async () => 1e12,
  ...over,
});

const choice = {
  keys: ['s1', 's2', 'r1'],
  layerName: 'Panoramas 10 Sep',
  date: '2026-09-10',
  quality: 'standard' as const,
};

describe('importPanoGroups', () => {
  it('copies frames per sphere, saves one queued layer and names the spheres to stitch', async () => {
    const seen: number[] = [];
    const r = await importPanoGroups(
      root,
      keyGrouping(await grouping()),
      choice,
      deps({ onProgress: (d) => seen.push(d) }),
    );
    expect(r.layerId).toBe('panos-2026-09-10');
    expect(r.stitch).toEqual(['p01', 'p02']);
    expect(seen).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
    expect((await readdir(join(root, 'panoramas', r.layerId, 'p01', 'frames'))).length).toBe(9);
    expect(await readFile(join(root, 'panoramas', r.layerId, 'p03', 'pano.jpg'), 'utf8')).toBe(
      'ready',
    );
    const m = await readManifestFile(root);
    const layer = m.layers.find((l) => l.id === r.layerId);
    expect(layer?.kind).toBe('panoramas');
    if (layer?.kind !== 'panoramas') return;
    expect(layer.name).toBe('Panoramas 10 Sep');
    expect(layer.capture).toBe(m.captures.find((c) => c.date === '2026-09-10')?.id);
    expect(layer.items.map((p) => [p.id, p.name, p.stitch?.status])).toEqual([
      ['p01', 'Pano 1', 'queued'],
      ['p02', 'Pano 2', 'queued'],
      ['p03', 'Pano 3', undefined],
    ]);
    const [p1] = layer.items;
    expect(p1?.src).toEqual({ path: 'panoramas/panos-2026-09-10/p01/pano.jpg' });
    expect(p1?.pos[0]).toBeCloseTo(100, 1);
    expect(p1?.pos[1]).toBeCloseTo(70, 1); // relative altitude over the origin height
    expect(p1?.pos[2]).toBeCloseTo(-50, 1);
    const at = gps(100, 50);
    expect(p1?.headingDeg).toBeCloseTo(-gridConvergenceDeg(at.lon, at.lat, 32639), 3); // true north in the grid
    expect(p1?.capturedAt).toMatch(/^2026-09-10T10:00:00[+-]\d\d:\d\d$/);
    // raw frames are never layer items or manifest entries
    expect(JSON.stringify(m)).not.toContain('SYN_0001');
  });

  it('refuses before copying when the drive is too full (Review Focus 2)', async () => {
    const g = keyGrouping(await grouping());
    const err = await importPanoGroups(
      root,
      g,
      choice,
      deps({ freeBytes: async () => 1000 }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PanoImportError);
    expect((err as PanoImportError).code).toBe('space');
    expect((err as Error).message).toMatch(/needs .* free, and .* is free/);
    expect(await readdir(root)).not.toContain('panoramas');
    expect((await readManifestFile(root)).layers.some((l) => l.kind === 'panoramas')).toBe(false);
  });

  it('removes what it copied when cancelled', async () => {
    const ctl = new AbortController();
    const g = keyGrouping(await grouping());
    const err = await importPanoGroups(
      root,
      g,
      choice,
      deps({
        signal: ctl.signal,
        onProgress: (d) => {
          if (d === 3) ctl.abort();
        },
      }),
    ).catch((e: unknown) => e);
    expect((err as PanoImportError).code).toBe('cancelled');
    expect(await readdir(join(root, 'panoramas'))).toEqual([]);
    expect((await readManifestFile(root)).layers.some((l) => l.kind === 'panoramas')).toBe(false);
  });

  it('refuses an empty choice and gives a second import its own layer', async () => {
    const g = keyGrouping(await grouping());
    await expect(importPanoGroups(root, g, { ...choice, keys: [] }, deps())).rejects.toMatchObject({
      code: 'empty',
    });
    await importPanoGroups(root, g, { ...choice, keys: ['s1'] }, deps());
    const again = await importPanoGroups(root, g, { ...choice, keys: ['s2'] }, deps());
    expect(again.layerId).toBe('panos-2026-09-10-2');
  });
});

describe('already imported frames (Review Focus 1)', () => {
  it('marks a sphere whose frames sit in a pano layer already', async () => {
    const g = keyGrouping(await grouping());
    await importPanoGroups(root, g, { ...choice, keys: ['s1'] }, deps());
    const known = await knownPanoFrames(root, await readManifestFile(root));
    expect(known.size).toBe(9);
    expect(markAlreadyImported(g, known)).toEqual(new Map([['s1', 'Panoramas 10 Sep']]));
  });
});

const record = (over: Partial<PanoStitchFile> = {}): PanoStitchFile => ({
  schema: 'aio.pano-stitch/1',
  run: '20261013-101500-pano-stitch-a1b2',
  layer: 'panos-2026-09-10',
  pano: 'p01',
  createdAt: '2026-10-13T10:16:00.000Z',
  engine: { version: '0.7.0' },
  quality: 'standard',
  shape: 'sphere',
  size: { width: 8192, height: 4096 },
  frames: { used: ['SYN_0001.JPG'], dropped: [] },
  aligned: 'features',
  residualPx: 0.8,
  maxDriftDeg: 1.7,
  focalScale: 1.01,
  coverage: { topDeg: 22, bottomDeg: 90 },
  timings: {},
  warnings: [],
  ...over,
});

describe('filing stitch outcomes', () => {
  async function imported() {
    const r = await importPanoGroups(root, keyGrouping(await grouping()), choice, deps());
    return { m: await readManifestFile(root), layer: r.layerId };
  }
  const itemOf = (m: Awaited<ReturnType<typeof readManifestFile>>, id: string) => {
    const l = m.layers.find((x) => x.kind === 'panoramas');
    return l?.kind === 'panoramas' ? l.items.find((p) => p.id === id) : undefined;
  };

  it('records runs on queued items only', async () => {
    const { m, layer } = await imported();
    const next = setPanoRuns(m, layer, { p01: 'run-a', p02: 'run-b' });
    expect(itemOf(next!, 'p01')?.stitch).toEqual({ run: 'run-a', status: 'queued' });
    const failed = applyStitchOutcome(next!, {
      layer,
      pano: 'p02',
      run: 'run-b',
      status: 'failed',
      error: 'x',
    });
    expect(setPanoRuns(failed!, layer, { p02: 'run-c' })).toBeNull();
  });

  it('files done with the full-sphere coverage, and a wide panorama with its yaw range', async () => {
    const { m, layer } = await imported();
    const done = applyStitchOutcome(
      m,
      { layer, pano: 'p01', run: 'r1', status: 'done' },
      record({ run: 'r1' }),
    );
    expect(itemOf(done!, 'p01')).toMatchObject({
      stitch: { run: 'r1', status: 'done' },
      cov: { top: 90, bottom: 90 },
    });
    const wide = applyStitchOutcome(
      m,
      { layer, pano: 'p02', run: 'r2', status: 'done' },
      record({
        run: 'r2',
        pano: 'p02',
        shape: 'wide',
        coverage: { topDeg: 24, bottomDeg: 55, leftDeg: -100, rightDeg: 93 },
      }),
    );
    expect(itemOf(wide!, 'p02')?.cov).toEqual({ top: 24, bottom: 55, left: -100, right: 93 });
  });

  it('files a failure with its reason and keeps unrelated edits (Review Focus 5)', async () => {
    const { m, layer } = await imported();
    const edited = {
      ...m,
      layers: m.layers.map((l) => (l.id === layer ? { ...l, visible: false } : l)),
    };
    const failed = applyStitchOutcome(edited, {
      layer,
      pano: 'p01',
      run: 'r1',
      status: 'failed',
      error: 'Too few frames',
    });
    expect(itemOf(failed!, 'p01')?.stitch).toEqual({
      run: 'r1',
      status: 'failed',
      error: 'Too few frames',
    });
    expect(failed!.layers.find((l) => l.id === layer)?.visible).toBe(false);
  });

  it('ignores an older run, an unknown item and a no-op', async () => {
    const { m, layer } = await imported();
    const newer = setPanoRuns(m, layer, { p01: '20261013-120000-pano-stitch-bbbb' })!;
    expect(
      applyStitchOutcome(newer, {
        layer,
        pano: 'p01',
        run: '20261013-100000-pano-stitch-aaaa',
        status: 'failed',
      }),
    ).toBeNull();
    expect(
      applyStitchOutcome(newer, { layer, pano: 'p99', run: 'x', status: 'failed' }),
    ).toBeNull();
    expect(
      applyStitchOutcome(newer, {
        layer,
        pano: 'p01',
        run: '20261013-120000-pano-stitch-bbbb',
        status: 'queued',
      }),
    ).toBeNull();
  });

  it('reconciles a finished stitch found on disk when the project opens', async () => {
    const { m, layer } = await imported();
    await writeManifestFile(root, setPanoRuns(m, layer, { p01: 'r1' })!);
    const folder = join(root, 'panoramas', layer, 'p01');
    await writeFile(join(folder, 'stitch.json'), JSON.stringify(record({ run: 'r1', layer })));
    const next = await reconcilePanoStitches(root, await readManifestFile(root));
    expect(itemOf(next!, 'p01')?.stitch?.status).toBe('done');
    expect(itemOf(next!, 'p02')?.stitch?.status).toBe('queued');
    expect(await reconcilePanoStitches(root, next!)).toBeNull();
  });
});
```

Run: `pnpm vitest run packages/project/src/builder/panos.test.ts`
Expected: FAIL, `Cannot find module './panos'`.

- [ ] **Step 2: Write `packages/project/src/builder/panos.ts`**

```ts
import { defaultUtcOffsetMin, gridConvergenceDeg } from '@aio/geo';
import {
  PANO_STITCH_MAX_BYTES,
  PanoStitchFile,
  panoFolder,
  type Layer,
  type PanoCov,
  type PanoQuality,
  type PanoRef,
  type PanoStitchStatus,
  type ProjectManifest,
} from '@aio/schema';
import { copyFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { resolveHeights } from './altitude';
import { captureForDate, readManifestFile, uniqueId, updateManifestFile } from './create';
import type { PanoFrameMeta, PanoGrouping, PanoSphereGroup } from './panoGroups';
import { photoRef, type PhotoFrame } from './photos';
import type { ImageOps } from './raw';

/*
 * Drone panoramas in a project (data-conventions section 34): the import copies each sphere's
 * frames into `panoramas/<layerId>/<panoId>/frames/` and saves one `panoramas` layer whose spheres
 * are queued; `pano.stitch` writes the images and `stitch.json`; the app files the outcome here.
 */

export type PanoLayer = Extract<Layer, { kind: 'panoramas' }>;

export interface KeyedGrouping {
  spheres: (PanoSphereGroup & { key: string })[];
  ready: (PanoFrameMeta & { key: string; lat: number; lon: number })[];
}

/** Scan keys: `s1`, `s2` ... for spheres and wide panoramas, `r1`, `r2` ... for ready-made ones. */
export function keyGrouping(g: PanoGrouping): KeyedGrouping {
  return {
    spheres: g.spheres.map((s, i) => ({ ...s, key: `s${String(i + 1)}` })),
    ready: g.ready.flatMap((r, i) =>
      r.lat === undefined || r.lon === undefined
        ? []
        : [{ ...r, lat: r.lat, lon: r.lon, key: `r${String(i + 1)}` }],
    ),
  };
}

export interface PanoImportChoice {
  keys: readonly string[];
  layerName: string;
  /** Survey date `YYYY-MM-DD`; the layer is filed under it (created when the project has none). */
  date?: string;
  quality: PanoQuality;
}

export interface PanoImportDeps {
  images: Pick<ImageOps, 'resizeJpeg'>;
  /** Free bytes on the drive of `dir`. */
  freeBytes(dir: string): Promise<number>;
  onProgress?(done: number, total: number, file: string): void;
  signal?: AbortSignal;
}

export class PanoImportError extends Error {
  constructor(
    message: string,
    readonly code: 'space' | 'cancelled' | 'empty',
  ) {
    super(message);
    this.name = 'PanoImportError';
  }
}

/** Room left beyond the frames: the stitch's images and its staging. */
export const PANO_COPY_HEADROOM = 256 * 1024 * 1024;

export interface PanoImportResult {
  manifest: ProjectManifest;
  layerId: string;
  /** The sphere ids to stitch (ready-made panoramas need none). */
  stitch: string[];
}

const GB = 1024 ** 3;
const size = (n: number) =>
  n >= GB ? `${(n / GB).toFixed(1)} GB` : `${String(Math.round(n / 1024 ** 2))} MB`;

function epsgOf(m: ProjectManifest): number {
  if (!('epsg' in m.crs))
    throw new Error('Drone panoramas need a project CRS given as an EPSG code.');
  return m.crs.epsg;
}

const itemId = (n: number) => `p${String(n).padStart(2, '0')}`;

/** A file name not used yet in one folder (Windows compares names without case). */
function freeName(name: string, used: Set<string>): string {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let out = name;
  for (let k = 2; used.has(out.toLowerCase()); k++) out = `${stem}-${String(k)}${ext}`;
  used.add(out.toLowerCase());
  return out;
}

interface Where {
  lat: number;
  lon: number;
  absAlt?: number;
  relAlt?: number;
  takenAt?: string;
}

/** A pano item: position like a photo's camera; centre column true north, so heading = -convergence. */
function panoRef(
  id: string,
  layerId: string,
  n: number,
  w: Where,
  f: PhotoFrame,
  stitched: boolean,
): PanoRef {
  const path = `${panoFolder(layerId, id)}/pano.jpg`;
  const cam = photoRef(
    id,
    path,
    {
      ...(w.takenAt ? { takenAt: w.takenAt } : {}),
      dji: {
        lat: w.lat,
        lon: w.lon,
        ...(w.absAlt !== undefined ? { absAlt: w.absAlt } : {}),
        ...(w.relAlt !== undefined ? { relAlt: w.relAlt } : {}),
      },
    },
    f,
  );
  return {
    id,
    src: { path },
    pos: cam.pos ?? [0, 0, 0],
    headingDeg: Math.round(-gridConvergenceDeg(w.lon, w.lat, f.epsg) * 1000) / 1000,
    name: `Pano ${String(n)}`,
    ...(cam.takenAt ? { capturedAt: cam.takenAt } : {}),
    ...(stitched ? { stitch: { status: 'queued' as const } } : {}),
  };
}

export async function importPanoGroups(
  root: string,
  g: KeyedGrouping,
  choice: PanoImportChoice,
  deps: PanoImportDeps,
): Promise<PanoImportResult> {
  const atStart = await readManifestFile(root);
  const epsg = epsgOf(atStart);
  const frame: PhotoFrame = {
    epsg,
    origin: atStart.origin,
    utcOffsetMin: defaultUtcOffsetMin(atStart.origin, epsg),
    heights: resolveHeights(atStart).rule,
  };
  const chosen = new Set(choice.keys);
  const spheres = g.spheres.filter((s) => chosen.has(s.key));
  const ready = g.ready.filter((r) => chosen.has(r.key));
  if (spheres.length + ready.length === 0)
    throw new PanoImportError('Choose at least one panorama to import.', 'empty');
  const total = spheres.reduce((n, s) => n + s.frames.length, 0) + ready.length;
  const bytes = spheres.reduce((n, s) => n + s.bytes, 0) + ready.reduce((n, r) => n + r.bytes, 0);
  const free = await deps.freeBytes(root);
  if (bytes + PANO_COPY_HEADROOM > free)
    throw new PanoImportError(
      `Importing these panoramas needs ${size(bytes + PANO_COPY_HEADROOM)} free, and ${size(free)} is free.`,
      'space',
    );
  const taken = (id: string) => atStart.layers.some((l) => l.id === id);
  const layerId = uniqueId(choice.date ? `panos-${choice.date}` : 'panos', taken);
  const layerDir = join(root, 'panoramas', layerId);
  const items: PanoRef[] = [];
  const stitch: string[] = [];
  let done = 0;
  const tick = (file: string) => {
    if (deps.signal?.aborted) throw new PanoImportError('The import was cancelled.', 'cancelled');
    deps.onProgress?.(++done, total, basename(file));
  };
  try {
    let n = 0;
    for (const s of spheres) {
      const id = itemId(++n);
      const dir = join(layerDir, id, 'frames');
      await mkdir(dir, { recursive: true });
      const used = new Set<string>();
      for (const f of s.frames) {
        if (deps.signal?.aborted)
          throw new PanoImportError('The import was cancelled.', 'cancelled');
        await copyFile(f.file, join(dir, freeName(basename(f.file), used)));
        tick(f.file);
      }
      items.push(panoRef(id, layerId, n, { ...s, takenAt: s.startedAt }, frame, true));
      stitch.push(id);
    }
    for (const r of ready) {
      const id = itemId(++n);
      const dir = join(layerDir, id);
      await mkdir(dir, { recursive: true });
      await copyFile(r.file, join(dir, 'pano.jpg'));
      await deps.images.resizeJpeg(r.file, join(dir, 'thumb.jpg'), 512);
      tick(r.file);
      items.push(panoRef(id, layerId, n, r, frame, false));
    }
    const layer: PanoLayer = {
      kind: 'panoramas',
      id: layerId,
      name: choice.layerName,
      visible: true,
      items,
    };
    const saved = await updateManifestFile(root, (fresh) => {
      if (fresh.layers.some((l) => l.id === layerId))
        throw new Error('Another import added the same layer meanwhile; import again.');
      let m = fresh;
      let capture: string | undefined;
      if (choice.date) {
        const c = captureForDate(m, choice.date);
        m = c.manifest;
        capture = c.captureId;
      }
      return { manifest: { ...m, layers: [...m.layers, capture ? { ...layer, capture } : layer] } };
    });
    return { manifest: saved.manifest, layerId, stitch };
  } catch (e) {
    await rm(layerDir, { recursive: true, force: true });
    throw e;
  }
}

function mapItems(
  m: ProjectManifest,
  layerId: string,
  edit: (p: PanoRef) => PanoRef,
): ProjectManifest | null {
  let changed = false;
  const layers = m.layers.map((l) => {
    if (l.kind !== 'panoramas' || l.id !== layerId) return l;
    const items = l.items.map((p) => {
      const next = edit(p);
      if (next !== p) changed = true;
      return next;
    });
    return { ...l, items };
  });
  return changed ? { ...m, layers } : null;
}

/** Record the started runs on items still queued without one (another outcome may have won). */
export function setPanoRuns(
  m: ProjectManifest,
  layerId: string,
  runs: Readonly<Record<string, string>>,
): ProjectManifest | null {
  return mapItems(m, layerId, (p) => {
    const run = runs[p.id];
    if (!run || p.stitch?.status !== 'queued' || p.stitch.run !== undefined) return p;
    return { ...p, stitch: { run, status: 'queued' } };
  });
}

export interface StitchOutcome {
  layer: string;
  pano: string;
  run: string;
  status: PanoStitchStatus;
  error?: string;
}

const FULL: PanoCov = { top: 90, bottom: 90 };

function covOf(r: PanoStitchFile): PanoCov {
  const c = r.coverage;
  if (r.shape === 'wide' && c.leftDeg !== undefined && c.rightDeg !== undefined)
    return { top: c.topDeg, bottom: c.bottomDeg, left: c.leftDeg, right: c.rightDeg };
  return FULL;
}

/**
 * The manifest with a stitch outcome filed into its item, or null when nothing changes: an
 * unknown item, an outcome of a run older than the item's (job ids sort by start time), or the
 * same state again. `done` needs the run's record (its coverage).
 */
export function applyStitchOutcome(
  m: ProjectManifest,
  o: StitchOutcome,
  record?: PanoStitchFile | null,
): ProjectManifest | null {
  return mapItems(m, o.layer, (p) => {
    if (p.id !== o.pano) return p;
    const prev = p.stitch?.run;
    if (prev !== undefined && o.run < prev) return p;
    if (o.status === 'done') {
      if (!record || record.run !== o.run) return p;
      const cov = covOf(record);
      if (
        p.stitch?.status === 'done' &&
        p.stitch.run === o.run &&
        JSON.stringify(p.cov) === JSON.stringify(cov)
      )
        return p;
      return { ...p, stitch: { run: o.run, status: 'done' }, cov };
    }
    const stitch = {
      run: o.run,
      status: o.status,
      ...(o.error ? { error: o.error.slice(0, 400) } : {}),
    };
    if (JSON.stringify(p.stitch) === JSON.stringify(stitch)) return p;
    return { ...p, stitch };
  });
}

/** A sphere's `stitch.json`, or null when absent, too large or not readable as `aio.pano-stitch/1`. */
export async function readStitchRecord(
  root: string,
  layer: string,
  pano: string,
): Promise<PanoStitchFile | null> {
  const file = join(root, panoFolder(layer, pano), 'stitch.json');
  try {
    if ((await stat(file)).size > PANO_STITCH_MAX_BYTES) return null;
    const r = PanoStitchFile.safeParse(JSON.parse(await readFile(file, 'utf8')));
    return r.success && r.data.layer === layer && r.data.pano === pano ? r.data : null;
  } catch {
    return null;
  }
}

/** File the stitches that finished without being filed (the app closed in between). */
export async function reconcilePanoStitches(
  root: string,
  m: ProjectManifest,
): Promise<ProjectManifest | null> {
  let next = m;
  let changed = false;
  for (const l of m.layers) {
    if (l.kind !== 'panoramas') continue;
    for (const p of l.items) {
      if (!p.stitch || p.stitch.status === 'done') continue;
      const r = await readStitchRecord(root, l.id, p.id);
      if (!r || (p.stitch.run !== undefined && r.run < p.stitch.run)) continue;
      const filed = applyStitchOutcome(
        next,
        { layer: l.id, pano: p.id, run: r.run, status: 'done' },
        r,
      );
      if (filed) {
        next = filed;
        changed = true;
      }
    }
  }
  return changed ? next : null;
}

const frameKey = (name: string, bytes: number) => `${name.toLowerCase()}|${String(bytes)}`;

/** Every frame already in the project's pano layers, by file name and size, to its layer's name. */
export async function knownPanoFrames(
  root: string,
  m: ProjectManifest,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const l of m.layers) {
    if (l.kind !== 'panoramas') continue;
    for (const p of l.items) {
      const dir = join(root, panoFolder(l.id, p.id), 'frames');
      const names = await readdir(dir).catch(() => [] as string[]);
      for (const n of names) {
        const s = await stat(join(dir, n)).catch(() => null);
        if (s?.isFile()) out.set(frameKey(n, s.size), l.name);
      }
    }
  }
  return out;
}

/** Spheres whose frames, at least half of them, are in a pano layer already: key to layer name. */
export function markAlreadyImported(
  g: KeyedGrouping,
  known: ReadonlyMap<string, string>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of g.spheres) {
    const hits = s.frames.flatMap((f) => {
      const layer = known.get(frameKey(basename(f.file), f.bytes));
      return layer === undefined ? [] : [layer];
    });
    if (hits.length * 2 >= s.frames.length && hits[0] !== undefined) out.set(s.key, hits[0]);
  }
  return out;
}
```

Export from `packages/project/src/builder/index.ts`:

```ts
export {
  PANO_COPY_HEADROOM,
  PanoImportError,
  applyStitchOutcome,
  importPanoGroups,
  keyGrouping,
  knownPanoFrames,
  markAlreadyImported,
  readStitchRecord,
  reconcilePanoStitches,
  setPanoRuns,
  type KeyedGrouping,
  type PanoImportChoice,
  type PanoImportDeps,
  type PanoImportResult,
  type PanoLayer,
  type StitchOutcome,
} from './panos';
```

- [ ] **Step 3: Run the tests**

Run: `pnpm vitest run packages/project/src/builder/panos.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 4: Typecheck and commit**

Run: `pnpm typecheck` (expected: no errors) and `pnpm vitest run packages/project/src/builder`.

```bash
git add packages/project/src/builder/panos.ts packages/project/src/builder/panos.test.ts packages/project/src/builder/index.ts
git commit -m "feat(project): import drone sphere frames and file stitch outcomes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Main: scan, import, job filing, pack gate and Add data's exclusion

**Files:**

- Create: `apps/desktop/src/main/panos.ts`, `apps/desktop/src/main/panos.test.ts`
- Modify: `apps/desktop/src/main/index.ts` (imports; `jobs:start` gate at :1134-1155; the runner's `emit` at :685-695; handlers after `builder:cancelImport` at :1293; Settings features at :1573), `apps/desktop/src/main/builder.ts` (`builderImport` at :289, plus `withoutExcluded`), `apps/desktop/src/main/builder.test.ts`, `apps/desktop/src/main/project.ts:244` (reconcile on open), `apps/desktop/src/main/journal.ts:956-981` and `journal.test.ts:950-962` (`panos:import` writes the manifest)

**Interfaces:**

- Consumes: Task 1 contracts (`panos:*`, `PanoScan`, `PANO_STITCH_MIN_PACK`, `PANO_STITCH_FEATURE`, `PanoQuality`, `JobEvent`, `JobRecord`); Task 2 `groupPanoFrames`, `readPanoFrameMeta`; Task 7 `keyGrouping`, `KeyedGrouping`, `importPanoGroups`, `PanoImportError`, `setPanoRuns`, `applyStitchOutcome`, `readStitchRecord`, `reconcilePanoStitches`, `knownPanoFrames`, `markAlreadyImported`, `StitchOutcome`; existing `expandImportPaths`, `MAX_FOLDER_FILES`, `readManifestFile`, `updateManifestFile` (`@aio/project/builder`), `compareVersions` (`./jobs/pack`), `createImportRuns` (`./importRuns`), `nativeImageOps` (`./images`).
- Produces (`apps/desktop/src/main/panos.ts`):

```ts
export const PANO_PACK_FEATURE: { label: string; minVersion: string };
export function panoPackRefusal(pipeline: string, packVersion: string | null): string | null;
export interface PanoScanDeps {
  thumb(file: string): Promise<string | undefined>;
  onProgress?(done: number, total: number, file: string): void;
  limit?: number;
  newId?: () => string;
}
export async function scanPanoPaths(
  root: string,
  paths: readonly string[],
  deps: PanoScanDeps,
): Promise<{ scan: PanoScan; grouping: KeyedGrouping } | { error: string }>;
export function panoScanCache(max?: number): {
  put(projectId: string, scan: PanoScan, grouping: KeyedGrouping): void;
  get(scanId: string, projectId: string): KeyedGrouping | null;
  drop(scanId: string): void;
};
export interface StitchStarter {
  start(req: {
    pipeline: 'pano.stitch';
    project: string;
    params: Record<string, unknown>;
  }): Promise<{ ok: true; job: { id: string } } | { ok: false; error: string }>;
}
export async function startPanoStitches(o: {
  root: string;
  layerId: string;
  panos: readonly string[];
  quality: PanoQuality;
  jobs: StitchStarter;
  packVersion(): Promise<string | null>;
}): Promise<{ runs: Record<string, string>; refused?: string }>;
export function stitchOutcome(job: JobRecord): StitchOutcome | null;
export function panoStitchFiler(deps: {
  update(root: string, change: (m: ProjectManifest) => ProjectManifest | null): Promise<void>;
  readRecord(root: string, layer: string, pano: string): Promise<PanoStitchFile | null>;
  log?(line: string): void;
}): { files(e: JobEvent): boolean; file(e: JobEvent): Promise<void> };
export async function fileThenSend(
  filer: { files(e: JobEvent): boolean; file(e: JobEvent): Promise<void> },
  e: JobEvent,
  send: () => void,
): Promise<void>;
export const panoFiler: ReturnType<typeof panoStitchFiler>; // main's instance: updateManifestFile + readStitchRecord
export async function withPanoStitches(
  root: string,
  manifest: { ok: true; value: ProjectManifest } | { ok: false; error: string },
  log: (line: string) => void,
  reread: (
    root: string,
  ) => Promise<{ ok: true; value: ProjectManifest } | { ok: false; error: string }>,
): Promise<{ ok: true; value: ProjectManifest } | { ok: false; error: string }>;
export async function freeBytes(dir: string): Promise<number>;
export const panoImports: ImportRuns;
// builder.ts
export function withoutExcluded(
  files: readonly string[],
  exclude: readonly string[] | undefined,
): string[];
```

- [ ] **Step 1: Write the failing tests**

`apps/desktop/src/main/panos.test.ts` (no Electron: thumbnails and jobs are injected):

```ts
import { createProject } from '@aio/project/builder';
import { withExif } from '@aio/project/builder/testing';
import type { JobEvent, JobRecord, PanoStitchFile, ProjectManifest } from '@aio/schema';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fileThenSend,
  panoPackRefusal,
  panoScanCache,
  panoStitchFiler,
  scanPanoPaths,
  startPanoStitches,
  stitchOutcome,
} from './panos';

let dir: string;
let root: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-main-panos-'));
  root = (
    await createProject(dir, {
      name: 'P',
      type: 'inspection',
      epsg: 32639,
      origin: [500000, 3200000, 0],
      severityTemplate: null,
    })
  ).root;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A card folder with one sphere (rows at 0 and -35, 8 yaws each) and two mapping photos. */
async function card(): Promise<string> {
  const folder = join(dir, 'card', '100MEDIA');
  await mkdir(folder, { recursive: true });
  let n = 0;
  const shot = async (yaw: number, pitch: number, s: number, lon = 51.0) => {
    n++;
    const time = `2026:09:10 10:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    await writeFile(
      join(folder, `SYN_${String(n).padStart(4, '0')}.JPG`),
      withExif({
        make: 'DJI',
        dateTimeOriginal: time,
        width: 5472,
        height: 3648,
        dji: {
          GpsLatitude: '28.9',
          GpsLongitude: String(lon),
          AbsoluteAltitude: '620',
          RelativeAltitude: '70',
          GimbalYawDegree: String(yaw),
          GimbalPitchDegree: String(pitch),
          GimbalRollDegree: '0',
        },
      }),
    );
  };
  let s = 0;
  for (const pitch of [0, -35])
    for (let yaw = -180; yaw < 180; yaw += 45) await shot(yaw, pitch, (s += 6));
  await shot(90, -90, 600, 51.01);
  await shot(90, -90, 602, 51.0102);
  return join(dir, 'card');
}

describe('scanPanoPaths', () => {
  it('finds the sphere, lists the mapping photos and keeps thumbnails and the day', async () => {
    const seen: number[] = [];
    const r = await scanPanoPaths(root, [await card()], {
      thumb: async () => 'data:image/jpeg;base64,AAAA',
      onProgress: (d) => seen.push(d),
      newId: () => 'scan-1',
    });
    if ('error' in r) throw new Error(r.error);
    expect(r.scan).toMatchObject({ scanId: 'scan-1', files: 18, day: '2026-09-10' });
    expect(r.scan.spheres).toHaveLength(1);
    expect(r.scan.spheres[0]).toMatchObject({
      key: 's1',
      shape: 'sphere',
      frames: 16,
      incomplete: false,
      relAlt: 70,
      thumb: 'data:image/jpeg;base64,AAAA',
    });
    expect(r.scan.skipped.map((s) => s.reason)).toEqual(['few-frames', 'few-frames']);
    expect(seen.at(-1)).toBe(18);
    expect(r.grouping.spheres[0]?.frames).toHaveLength(16);
    expect(r.scan.spheres[0]?.files[0]).toMatch(/SYN_0001\.JPG$/);
  });

  it('says so when there is nothing to read', async () => {
    await mkdir(join(dir, 'empty'));
    expect(
      await scanPanoPaths(root, [join(dir, 'empty')], { thumb: async () => undefined }),
    ).toEqual({
      error: 'There are no JPEG files there.',
    });
  });
});

describe('panoScanCache', () => {
  it('keeps the newest scans per project and forgets the oldest', () => {
    const c = panoScanCache(2);
    const g = { spheres: [], ready: [] };
    const scan = (id: string) => ({
      scanId: id,
      spheres: [],
      ready: [],
      skipped: [],
      files: 0,
      day: null,
    });
    c.put('p', scan('a'), g);
    c.put('p', scan('b'), g);
    c.put('p', scan('c'), g);
    expect(c.get('a', 'p')).toBeNull();
    expect(c.get('c', 'p')).toBe(g);
    expect(c.get('c', 'other')).toBeNull();
    c.drop('c');
    expect(c.get('c', 'p')).toBeNull();
  });
});

describe('pack gate', () => {
  it('asks for processing tools 0.7.0 for pano.stitch only', () => {
    expect(panoPackRefusal('pano.stitch', '0.6.0')).toBe(
      'Stitching drone panoramas needs processing tools 0.7.0 or later (these are 0.6.0). Update them in Settings, Processing tools.',
    );
    expect(panoPackRefusal('pano.stitch', '0.7.0')).toBeNull();
    expect(panoPackRefusal('pano.stitch', 'dev')).toBeNull();
    expect(panoPackRefusal('pano.stitch', null)).toBeNull();
    expect(panoPackRefusal('walk.process', '0.6.0')).toBeNull();
  });
});

describe('startPanoStitches', () => {
  it('starts one job per sphere and stops at the first refusal', async () => {
    const start = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, job: { id: 'j1' } })
      .mockResolvedValueOnce({ ok: false, error: 'No processing tools.' });
    const r = await startPanoStitches({
      root,
      layerId: 'l',
      panos: ['p01', 'p02', 'p03'],
      quality: 'standard',
      jobs: { start },
      packVersion: async () => '0.7.0',
    });
    expect(r).toEqual({ runs: { p01: 'j1' }, refused: 'No processing tools.' });
    expect(start).toHaveBeenCalledWith({
      pipeline: 'pano.stitch',
      project: root,
      params: { layer: 'l', pano: 'p01', quality: 'standard' },
    });
  });

  it('starts nothing on a pack that is too old', async () => {
    const start = vi.fn();
    const r = await startPanoStitches({
      root,
      layerId: 'l',
      panos: ['p01'],
      quality: 'high',
      jobs: { start },
      packVersion: async () => '0.6.0',
    });
    expect(r.runs).toEqual({});
    expect(r.refused).toMatch(/needs processing tools 0.7.0/);
    expect(start).not.toHaveBeenCalled();
  });
});

const job = (over: Partial<JobRecord>): JobRecord =>
  ({
    id: '20261013-101500-pano-stitch-a1b2',
    pipeline: 'pano.stitch',
    project: 'D:/p',
    params: { layer: 'l', pano: 'p01' },
    status: 'running',
    progress: 0.5,
    steps: [],
    artifacts: [],
    createdAt: '2026-10-13T10:15:00Z',
    updatedAt: '2026-10-13T10:16:00Z',
    ...over,
  }) as JobRecord;

describe('stitchOutcome', () => {
  it('maps job states to item states and leaves running jobs to the live view', () => {
    expect(stitchOutcome(job({ status: 'done' }))).toEqual({
      layer: 'l',
      pano: 'p01',
      run: job({}).id,
      status: 'done',
    });
    expect(stitchOutcome(job({ status: 'failed', error: 'Too few frames' }))).toMatchObject({
      status: 'failed',
      error: 'Too few frames',
    });
    expect(stitchOutcome(job({ status: 'interrupted' }))).toMatchObject({
      status: 'failed',
      error: 'The stitch stopped when the app closed. Stitch again.',
    });
    expect(stitchOutcome(job({ status: 'cancelled' }))).toMatchObject({ status: 'queued' });
    expect(stitchOutcome(job({ status: 'running' }))).toBeNull();
    expect(stitchOutcome(job({ pipeline: 'walk.process', status: 'done' }))).toBeNull();
    expect(stitchOutcome(job({ status: 'done', params: { layer: 'l' } }))).toBeNull();
  });
});

describe('panoStitchFiler and fileThenSend (Review Focus 5)', () => {
  const done: JobEvent = { type: 'update', job: job({ status: 'done' }) };

  it('files a finished stitch once, with its record, before the renderer hears of it', async () => {
    const order: string[] = [];
    const update = vi.fn(
      async (_root: string, change: (m: ProjectManifest) => ProjectManifest | null) => {
        order.push('file');
        void change;
      },
    );
    const readRecord = vi.fn(async () => ({ run: job({}).id }) as PanoStitchFile);
    const filer = panoStitchFiler({ update, readRecord });
    expect(filer.files(done)).toBe(true);
    expect(filer.files({ type: 'update', job: job({}) })).toBe(false);
    await fileThenSend(filer, done, () => order.push('send'));
    await fileThenSend(filer, done, () => order.push('send'));
    expect(order).toEqual(['file', 'send', 'send']);
    expect(readRecord).toHaveBeenCalledWith('D:/p', 'l', 'p01');
  });

  it('still sends the event when filing fails', async () => {
    const filer = panoStitchFiler({
      update: async () => {
        throw new Error('disk');
      },
      readRecord: async () => null,
      log: () => undefined,
    });
    const send = vi.fn();
    await fileThenSend(filer, done, send);
    expect(send).toHaveBeenCalledOnce();
  });
});
```

Add to `apps/desktop/src/main/builder.test.ts`:

```ts
import { withoutExcluded } from './builder';

describe('withoutExcluded', () => {
  it('leaves out the excluded files, without case on Windows', () => {
    const files = ['D:\\card\\SYN_0001.JPG', 'D:\\card\\SYN_0002.JPG', 'D:\\card\\notes.las'];
    const out = withoutExcluded(files, ['d:\\card\\dji_0001.jpg']);
    expect(out).toEqual(process.platform === 'win32' ? files.slice(1) : files);
    expect(withoutExcluded(files, undefined)).toBe(files);
  });
});
```

Run: `pnpm vitest run apps/desktop/src/main/panos.test.ts apps/desktop/src/main/builder.test.ts`
Expected: FAIL, `Cannot find module './panos'` and `withoutExcluded` not exported.

- [ ] **Step 2: Write `apps/desktop/src/main/panos.ts`**

```ts
import {
  MAX_FOLDER_FILES,
  applyStitchOutcome,
  expandImportPaths,
  groupPanoFrames,
  keyGrouping,
  knownPanoFrames,
  markAlreadyImported,
  readManifestFile,
  readPanoFrameMeta,
  readStitchRecord,
  reconcilePanoStitches,
  updateManifestFile,
  type KeyedGrouping,
  type StitchOutcome,
} from '@aio/project/builder';
import {
  PANO_STITCH_FEATURE,
  PANO_STITCH_MIN_PACK,
  type JobEvent,
  type JobRecord,
  type PanoQuality,
  type PanoScan,
  type PanoStitchFile,
  type ProjectManifest,
} from '@aio/schema';
import { statfs } from 'node:fs/promises';
import { basename } from 'node:path';
import { createImportRuns } from './importRuns';
import { compareVersions } from './jobs/pack';

/** What the processing tools must be for `pano.stitch` (Settings, Processing tools lists it). */
export const PANO_PACK_FEATURE = { label: PANO_STITCH_FEATURE, minVersion: PANO_STITCH_MIN_PACK };

/** Why `jobs:start` refuses `pano.stitch` on the installed pack, or null (as `walkPackRefusal`). */
export function panoPackRefusal(pipeline: string, packVersion: string | null): string | null {
  if (pipeline !== 'pano.stitch' || packVersion === null || packVersion === 'dev') return null;
  if (compareVersions(packVersion, PANO_STITCH_MIN_PACK) >= 0) return null;
  return `${PANO_STITCH_FEATURE} needs processing tools ${PANO_STITCH_MIN_PACK} or later (these are ${packVersion}). Update them in Settings, Processing tools.`;
}

export interface PanoScanDeps {
  /** A small JPEG data URL of a frame for the preview, or undefined. */
  thumb(file: string): Promise<string | undefined>;
  onProgress?(done: number, total: number, file: string): void;
  limit?: number;
  newId?: () => string;
}

const JPEG = /\.jpe?g$/i;
const newScanId = () =>
  `scan-${Date.now().toString(36)}-${Math.floor(Math.random() * 36 ** 4).toString(36)}`;

/** The day most spheres start on, the earlier one on a tie. */
function dayOf(g: KeyedGrouping): string | null {
  const counts = new Map<string, number>();
  for (const s of g.spheres) {
    const d = s.startedAt.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [d, n] of [...counts].sort(([a], [b]) => a.localeCompare(b)))
    if (best === null || n > (counts.get(best) ?? 0)) best = d;
  return best;
}

export async function scanPanoPaths(
  root: string,
  paths: readonly string[],
  deps: PanoScanDeps,
): Promise<{ scan: PanoScan; grouping: KeyedGrouping } | { error: string }> {
  const ex = await expandImportPaths(
    paths,
    (ext) => ext === '.jpg' || ext === '.jpeg',
    deps.limit ?? MAX_FOLDER_FILES,
  );
  if (ex.tooMany !== null)
    return {
      error: `${ex.tooMany} holds more than ${String(deps.limit ?? MAX_FOLDER_FILES)} files. Choose a smaller folder.`,
    };
  const jpegs = ex.files.filter((f) => JPEG.test(f));
  if (jpegs.length === 0) return { error: 'There are no JPEG files there.' };
  const metas = [];
  for (const [i, f] of jpegs.entries()) {
    metas.push(await readPanoFrameMeta(f));
    deps.onProgress?.(i + 1, jpegs.length, basename(f));
  }
  const raw = groupPanoFrames(metas);
  const grouping = keyGrouping(raw);
  const already = markAlreadyImported(
    grouping,
    await knownPanoFrames(root, await readManifestFile(root)),
  );
  const spheres = [];
  for (const s of grouping.spheres) {
    // the preview shows a frame of the horizon row
    const face = [...s.frames].sort(
      (a, b) => Math.abs(a.gimbal?.pitch ?? 90) - Math.abs(b.gimbal?.pitch ?? 90),
    )[0];
    const thumb = face ? await deps.thumb(face.file) : undefined;
    const alreadyIn = already.get(s.key);
    spheres.push({
      key: s.key,
      shape: s.shape,
      files: s.frames.map((f) => f.file),
      frames: s.frames.length,
      bytes: s.bytes,
      startedAt: s.startedAt,
      lat: s.lat,
      lon: s.lon,
      ...(s.absAlt !== undefined ? { absAlt: s.absAlt } : {}),
      ...(s.relAlt !== undefined ? { relAlt: s.relAlt } : {}),
      incomplete: s.incomplete,
      ...(alreadyIn !== undefined ? { alreadyIn } : {}),
      ...(thumb ? { thumb } : {}),
    });
  }
  const ready = [];
  for (const r of grouping.ready) {
    const thumb = await deps.thumb(r.file);
    ready.push({
      key: r.key,
      file: r.file,
      bytes: r.bytes,
      lat: r.lat,
      lon: r.lon,
      ...(r.absAlt !== undefined ? { absAlt: r.absAlt } : {}),
      ...(r.relAlt !== undefined ? { relAlt: r.relAlt } : {}),
      ...(r.takenAt ? { takenAt: r.takenAt } : {}),
      ...(thumb ? { thumb } : {}),
    });
  }
  const scan: PanoScan = {
    scanId: (deps.newId ?? newScanId)(),
    spheres,
    ready,
    skipped: raw.skipped,
    files: jpegs.length,
    day: dayOf(grouping),
  };
  return { scan, grouping };
}

/** The scans main keeps for `panos:import` (newest `max`, any project). */
export function panoScanCache(max = 4) {
  const kept = new Map<string, { projectId: string; grouping: KeyedGrouping }>();
  return {
    put(projectId: string, scan: PanoScan, grouping: KeyedGrouping): void {
      kept.set(scan.scanId, { projectId, grouping });
      while (kept.size > max) kept.delete(kept.keys().next().value as string);
    },
    get(scanId: string, projectId: string): KeyedGrouping | null {
      const k = kept.get(scanId);
      return k && k.projectId === projectId ? k.grouping : null;
    },
    drop(scanId: string): void {
      kept.delete(scanId);
    },
  };
}

/** The copy of a running `panos:import`, per project (`panos:cancelImport` stops it). */
export const panoImports = createImportRuns();

export async function freeBytes(dir: string): Promise<number> {
  const s = await statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
}

export interface StitchStarter {
  start(req: {
    pipeline: 'pano.stitch';
    project: string;
    params: Record<string, unknown>;
  }): Promise<{ ok: true; job: { id: string } } | { ok: false; error: string }>;
}

/** One `pano.stitch` job per sphere; the first refusal (no pack, an old pack) stops the rest. */
export async function startPanoStitches(o: {
  root: string;
  layerId: string;
  panos: readonly string[];
  quality: PanoQuality;
  jobs: StitchStarter;
  packVersion(): Promise<string | null>;
}): Promise<{ runs: Record<string, string>; refused?: string }> {
  const runs: Record<string, string> = {};
  if (o.panos.length === 0) return { runs };
  const tooOld = panoPackRefusal('pano.stitch', await o.packVersion());
  if (tooOld) return { runs, refused: tooOld };
  for (const pano of o.panos) {
    const r = await o.jobs.start({
      pipeline: 'pano.stitch',
      project: o.root,
      params: { layer: o.layerId, pano, quality: o.quality },
    });
    if (!r.ok) return { runs, refused: r.error };
    runs[pano] = r.job.id;
  }
  return { runs };
}

const INTERRUPTED = 'The stitch stopped when the app closed. Stitch again.';

/** The item state a job's update files, or null (running jobs show live; other pipelines). */
export function stitchOutcome(job: JobRecord): StitchOutcome | null {
  if (job.pipeline !== 'pano.stitch') return null;
  const { layer, pano } = job.params;
  if (typeof layer !== 'string' || typeof pano !== 'string') return null;
  const at = { layer, pano, run: job.id };
  switch (job.status) {
    case 'done':
      return { ...at, status: 'done' };
    case 'failed':
      return { ...at, status: 'failed', error: job.error ?? 'The stitch failed.' };
    case 'interrupted':
      return { ...at, status: 'failed', error: INTERRUPTED };
    case 'cancelled':
      return { ...at, status: 'queued' };
    default:
      return null;
  }
}

export function panoStitchFiler(deps: {
  update(root: string, change: (m: ProjectManifest) => ProjectManifest | null): Promise<void>;
  readRecord(root: string, layer: string, pano: string): Promise<PanoStitchFile | null>;
  log?(line: string): void;
}) {
  const filed = new Map<string, string>();
  const outcomeOf = (e: JobEvent) => (e.type === 'update' ? stitchOutcome(e.job) : null);
  return {
    files(e: JobEvent): boolean {
      const o = outcomeOf(e);
      return o !== null && filed.get(o.run) !== o.status;
    },
    async file(e: JobEvent): Promise<void> {
      const o = outcomeOf(e);
      if (!o || e.type !== 'update' || filed.get(o.run) === o.status) return;
      filed.set(o.run, o.status);
      const record =
        o.status === 'done' ? await deps.readRecord(e.job.project, o.layer, o.pano) : null;
      await deps.update(e.job.project, (m) => applyStitchOutcome(m, o, record));
    },
  };
}

/**
 * File a finished stitch into the manifest, then forward the job event: the renderer reloads the
 * manifest on that event and must find the outcome in it (Review Focus 5). The event goes out
 * even when filing fails; the project open reconciles a done stitch again.
 */
export async function fileThenSend(
  filer: { files(e: JobEvent): boolean; file(e: JobEvent): Promise<void> },
  e: JobEvent,
  send: () => void,
): Promise<void> {
  if (!filer.files(e)) {
    send();
    return;
  }
  try {
    await filer.file(e);
  } catch {
    // reconciled at the next open
  } finally {
    send();
  }
}

/** Main's filer: a read-change-save of the fresh manifest. */
export const panoFiler = panoStitchFiler({
  update: async (root, change) => {
    await updateManifestFile(root, (m) => ({ manifest: change(m) }));
  },
  readRecord: readStitchRecord,
});

type Loaded = { ok: true; value: ProjectManifest } | { ok: false; error: string };

/** At project open: file the stitches that finished without being filed. */
export async function withPanoStitches(
  root: string,
  manifest: Loaded,
  log: (line: string) => void,
  reread: (root: string) => Promise<Loaded>,
): Promise<Loaded> {
  if (!manifest.ok) return manifest;
  try {
    const u = await updateManifestFile(root, (m) =>
      reconcilePanoStitches(root, m).then((next) => ({ manifest: next })),
    );
    return u.saved ? reread(root) : manifest;
  } catch (e) {
    log(`Finished panorama stitches were not filed: ${e instanceof Error ? e.message : String(e)}`);
    return manifest;
  }
}
```

- [ ] **Step 3: `withoutExcluded` in `builder.ts`**

```ts
/** `files` without `exclude` (the frames Add data hands to the panorama import instead). */
export function withoutExcluded(
  files: readonly string[],
  exclude: readonly string[] | undefined,
): string[] {
  if (!exclude?.length) return files as string[];
  const key = (p: string) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
  const out = new Set(exclude.map(key));
  return files.filter((f) => !out.has(key(f)));
}
```

(import `resolve` from `node:path`), and in `builderImport`, right after the `tooMany` check, `const files = withoutExcluded(ex.files, req.exclude);`; use `files` for the empty-folder check (`files.length === 0 && ex.leftOut.length === 0`), the progress total (`stitchProgress(..., files.length)`) and `importRawFiles(root, files, {`, so the import card counts only what it imports.

Run: `pnpm vitest run apps/desktop/src/main/panos.test.ts apps/desktop/src/main/builder.test.ts`
Expected: PASS.

- [ ] **Step 4: Wire it into `index.ts`, `project.ts` and the journal**

`apps/desktop/src/main/index.ts`:

1. Imports: `import { PANO_PACK_FEATURE, fileThenSend, freeBytes, panoFiler, panoImports, panoPackRefusal, panoScanCache, scanPanoPaths, startPanoStitches } from './panos';` and `importPanoGroups, PanoImportError, setPanoRuns, updateManifestFile` from `@aio/project/builder` (beside the existing builder imports).
2. The runner's `emit` (:685-695) becomes:

```ts
  emit: (event) => {
    const safe = safeJobEvent(event);
    if (!safe) {
      console.error(`Dropped an invalid jobs:event of type ${event.type}.`);
      return;
    }
    // a finished stitch is filed into the manifest before the renderer hears of it
    void fileThenSend(panoFiler, safe, () => {
      const win = mainWindow ?? BrowserWindow.getAllWindows()[0];
      if (win && !win.isDestroyed()) win.webContents.send('jobs:event', safe);
    });
    void journal.jobEvent(safe);
    void surveyQaJobs(safe);
  },
```

3. The `jobs:start` gate (:1144-1153) covers both pipelines:

```ts
if ('pipeline' in req && (req.pipeline === 'walk.process' || req.pipeline === 'pano.stitch')) {
  const found = await findPack({
    dataRoot: settings.current().dataRoot,
    env: process.env,
    app: packApp,
  });
  const version = found.pack?.version ?? null;
  const tooOld = walkPackRefusal(req.pipeline, version) ?? panoPackRefusal(req.pipeline, version);
  if (tooOld) return { ok: false, error: tooOld };
}
```

4. After `handle('builder:cancelImport', ...)`:

```ts
// drone panoramas (P1): scan a folder, import the chosen spheres, start their stitches
const panoScans = panoScanCache();
const panoProgress = (e: {
  projectId: string;
  phase: 'scan' | 'copy';
  done: number;
  total: number;
  file: string;
}) => {
  const parsed = ipcEvents['panos:progress'].safeParse(e);
  if (parsed.success) targetWindow()?.webContents.send('panos:progress', parsed.data);
};
const thumbOf = async (file: string) => {
  const img = nativeImage.createFromPath(file);
  if (img.isEmpty()) return undefined;
  return `data:image/jpeg;base64,${img.resize({ width: 160, quality: 'good' }).toJPEG(70).toString('base64')}`;
};
handle('panos:scan', async ({ projectId, paths }) => {
  const refused = packageRefusal(projectId);
  if (refused) return refused;
  const root = registry.root(projectId);
  if (root === undefined)
    return { ok: false, error: `Project "${projectId}" is not open. Open it, then add panoramas.` };
  const r = await scanPanoPaths(root, paths, {
    thumb: thumbOf,
    onProgress: (done, total, file) =>
      panoProgress({ projectId, phase: 'scan', done, total, file }),
  });
  if ('error' in r) return { ok: false, error: r.error };
  panoScans.put(projectId, r.scan, r.grouping);
  return { ok: true, scan: r.scan };
});
handle('panos:import', async (req) => {
  const refused = packageRefusal(req.projectId);
  if (refused) return refused;
  const root = registry.root(req.projectId);
  if (root === undefined) return { ok: false, error: `Project "${req.projectId}" is not open.` };
  const grouping = panoScans.get(req.scanId, req.projectId);
  if (!grouping)
    return {
      ok: false,
      error: 'This scan is no longer kept. Choose the folder again.',
      code: 'stale-scan' as const,
    };
  const run = panoImports.begin(req.projectId);
  try {
    const r = await importPanoGroups(root, grouping, req, {
      images: nativeImageOps,
      freeBytes,
      signal: run.signal,
      onProgress: (done, total, file) =>
        panoProgress({ projectId: req.projectId, phase: 'copy', done, total, file }),
    });
    const started = await startPanoStitches({
      root,
      layerId: r.layerId,
      panos: r.stitch,
      quality: req.quality,
      jobs,
      packVersion: async () =>
        (await findPack({ dataRoot: settings.current().dataRoot, env: process.env, app: packApp }))
          .pack?.version ?? null,
    });
    const ran = Object.keys(started.runs).length;
    const manifest = ran
      ? (
          await updateManifestFile(root, (m) => ({
            manifest: setPanoRuns(m, r.layerId, started.runs),
          }))
        ).manifest
      : r.manifest;
    panoScans.drop(req.scanId);
    return {
      ok: true,
      manifest,
      layerId: r.layerId,
      started: ran,
      ...(started.refused ? { notStarted: started.refused } : {}),
    };
  } catch (e) {
    if (e instanceof PanoImportError && e.code !== 'empty')
      return { ok: false, error: e.message, code: e.code };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    run.end();
  }
});
handle('panos:cancelImport', ({ projectId }) => ({ ok: panoImports.cancel(projectId) }));
```

(`jobs` is the `JobRunner`; its `start` answers the `jobs:start` response, which fits `StitchStarter`. `nativeImage` comes from `electron` beside `dialog`.)

5. Settings features (:1573): `[{ label: 'Creating maps from photos', minVersion: PHOTO_PACK }, WALK_PACK_FEATURE, PANO_PACK_FEATURE]`.

`apps/desktop/src/main/project.ts` after `manifest = await withWalkLayers(root, manifest, log);` (:244):

```ts
manifest = await withPanoStitches(root, manifest, log, readManifest);
if (!manifest.ok) return manifest;
```

(import `withPanoStitches` from `./panos`; `readManifest` is the wrapper at :129.)

`apps/desktop/src/main/journal.ts`: add `channel === 'panos:import' ||` to the list at :956-961 and `| 'panos:import'` to its request type, so a journaled project reconciles `manifest.json` after an import; add `'panos:import'` to the `writers` list in `journal.test.ts:950-961`.

- [ ] **Step 5: Run the main tests and typecheck**

Run: `pnpm vitest run apps/desktop/src/main` and `pnpm typecheck`
Expected: PASS, no errors (`journal.test.ts` included).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/panos.ts apps/desktop/src/main/panos.test.ts apps/desktop/src/main/index.ts apps/desktop/src/main/builder.ts apps/desktop/src/main/builder.test.ts apps/desktop/src/main/project.ts apps/desktop/src/main/journal.ts apps/desktop/src/main/journal.test.ts
git commit -m "feat(desktop): scan and import drone panoramas, file stitch outcomes in main" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Open requests, marker status and coverage from the item (workspace and engine)

**Files:**

- Modify: `packages/workspace/src/index.ts` (`WorkspaceState` :49-90, `WorkspaceActions` :99-140, `initial`, `createWorkspace` :157-270), `packages/workspace/src/index.test.ts`, `packages/engine/src/config.ts:24-33` (`EngineTextKey`), `packages/engine/src/adapters/markers.ts` (`MarkerMember` :20-26, CSS :58-74, `tipText` :295-316, paint :470-483), `packages/engine/src/adapters/panoMath.ts`, `packages/engine/src/adapters/panoMath.test.ts`, `packages/engine/src/adapters/panoramas.ts` (`create` :250-300, `loadPano` :365-375, `show` :386-394, the store subscription :557-568), `packages/engine/src/adapters/panoramas.test.ts`

**Interfaces:**

- Consumes: Task 1 `PanoRef.stitch`, `PanoRef.cov`, `PanoRef.name`; i18n keys `stage.markers.stitching`, `stage.markers.stitchFailed`.
- Produces:

```ts
// @aio/workspace
interface WorkspaceState {
  panoRequest: { seq: number; layer: string; id: string } | null;
}
interface WorkspaceActions {
  openPano(layer: string, id: string): void;
}
// engine markers.ts
interface MarkerMember {
  label?: string;
  status?: 'stitching' | 'failed';
}
// engine panoMath.ts
export function itemCoverage(
  cov: { top: number; bottom: number; left?: number; right?: number } | undefined,
): PanoCoverage | null;
export function imageCentreDeg(headingDeg: number, cov?: { left?: number; right?: number }): number;
export function panoMarkerStatus(p: {
  stitch?: { status: string };
}): 'stitching' | 'failed' | undefined;
export function panoOpenable(p: { stitch?: { status: string } }): boolean;
```

- [ ] **Step 1: Failing tests**

Append to `packages/workspace/src/index.test.ts` (inside `describe('workspace store', ...)`):

```ts
it('asks to open a panorama, a new request every time', () => {
  const ws = createWorkspace();
  expect(ws.getState().panoRequest).toBeNull();
  ws.getState().openPano('panos-1', 'p01');
  const first = ws.getState().panoRequest;
  expect(first).toMatchObject({ layer: 'panos-1', id: 'p01' });
  ws.getState().openPano('panos-1', 'p01');
  expect(ws.getState().panoRequest?.seq).toBe((first?.seq ?? 0) + 1);
});
```

Append to `packages/engine/src/adapters/panoMath.test.ts`:

```ts
import { imageCentreDeg, itemCoverage, panoMarkerStatus, panoOpenable } from './panoMath';

describe('coverage and status from the item', () => {
  it('reads a full sphere and a wide panorama', () => {
    expect(itemCoverage(undefined)).toBeNull();
    expect(itemCoverage({ top: 90, bottom: 90 })).toEqual({
      hspanDeg: 360,
      vtopDeg: 90,
      vbotDeg: 90,
    });
    expect(itemCoverage({ top: 24, bottom: 55, left: -100, right: 93 })).toEqual({
      hspanDeg: 193,
      vtopDeg: 24,
      vbotDeg: 55,
    });
  });

  it('centres a wide panorama between its yaw range, after the north correction', () => {
    expect(imageCentreDeg(-0.8)).toBe(-0.8);
    expect(imageCentreDeg(-0.8, { left: -100, right: 93 })).toBeCloseTo(-4.3, 6);
  });

  it('badges queued, running and failed stitches and opens only stitched or ready-made ones', () => {
    expect(panoMarkerStatus({ stitch: { status: 'queued' } })).toBe('stitching');
    expect(panoMarkerStatus({ stitch: { status: 'running' } })).toBe('stitching');
    expect(panoMarkerStatus({ stitch: { status: 'failed' } })).toBe('failed');
    expect(panoMarkerStatus({ stitch: { status: 'done' } })).toBeUndefined();
    expect(panoMarkerStatus({})).toBeUndefined();
    expect(panoOpenable({})).toBe(true);
    expect(panoOpenable({ stitch: { status: 'done' } })).toBe(true);
    expect(panoOpenable({ stitch: { status: 'queued' } })).toBe(false);
  });
});
```

Append to `packages/engine/src/adapters/panoramas.test.ts` (inside `describe('panoramas layer', ...)`; `setup`, `click` and the `layer` fixture are the file's own):

```ts
it('badges a sphere still stitching and does not enter it', async () => {
  const { host, canvas, camera, h, frames } = setup();
  const store = createWorkspace();
  const queued: PanoLayer = {
    ...layer,
    items: [{ ...layer.items[0]!, name: 'Pano 1', stitch: { status: 'queued' } }, layer.items[1]!],
  };
  const lh = await createPanoramasAdapter(store).create(queued, { url: () => '', scene: h });
  for (const f of frames) f(16);
  const icon = [...host.querySelectorAll<HTMLElement>('[data-markers=pano] .aio-mk')].find(
    (e) => e.style.display !== 'none',
  );
  expect(icon?.dataset.status).toBe('stitching');
  click(canvas, 100, 100);
  expect(store.getState().selection).toEqual({ kind: 'pano', id: 'a', layer: 'panos' });
  expect(camera.layers.mask).toBe(1); // nothing to show yet
  lh.dispose();
  host.remove();
});

it('enters a panorama asked for by openPano', async () => {
  const { host, camera, h } = setup();
  const store = createWorkspace();
  const lh = await createPanoramasAdapter(store).create(layer, { url: () => '', scene: h });
  store.getState().openPano('other-layer', 'a');
  expect(camera.layers.mask).toBe(1);
  store.getState().openPano('panos', 'b');
  expect(camera.layers.mask).toBe(2 ** 31);
  expect(camera.position.toArray()).toEqual([300, 40, -100]);
  expect(store.getState().selection).toEqual({ kind: 'pano', id: 'b', layer: 'panos' });
  lh.dispose();
  host.remove();
});
```

Run: `pnpm vitest run packages/workspace packages/engine/src/adapters/panoMath.test.ts packages/engine/src/adapters/panoramas.test.ts`
Expected: FAIL (`openPano` is not a function; `itemCoverage` not exported; no `data-status`).

- [ ] **Step 2: Workspace**

In `WorkspaceState` add:

```ts
  /**
   * The latest ask to open a panorama's sphere view (a Datasets row's Open): the panoramas adapter
   * of that layer enters it. `seq` makes the same pano asked twice a new request.
   */
  panoRequest: { seq: number; layer: string; id: string } | null;
```

in `WorkspaceActions`: `openPano(layer: string, id: string): void;`, in `initial`: `panoRequest: null,`, and in `createWorkspace` (beside `flyTo`, with its own counter `let panoSeq = 0;` next to `let seq = 0;`):

```ts
    openPano: (layer, id) => {
      panoSeq += 1;
      set({ panoRequest: { seq: panoSeq, layer, id } });
    },
```

- [ ] **Step 3: `panoMath.ts` helpers**

```ts
/** Coverage from a `PanoRef.cov` (drone panoramas), or null to fall back to panoramas.json. */
export function itemCoverage(
  cov: { top: number; bottom: number; left?: number; right?: number } | undefined,
): PanoCoverage | null {
  if (!cov) return null;
  const hspan = cov.left !== undefined && cov.right !== undefined ? cov.right - cov.left : 360;
  return { hspanDeg: Math.min(360, Math.max(1, hspan)), vtopDeg: cov.top, vbotDeg: cov.bottom };
}

/**
 * Where the image's centre column looks: `headingDeg` is where true north is (the north
 * correction); a wide panorama's centre sits halfway between its yaw range from there.
 */
export function imageCentreDeg(
  headingDeg: number,
  cov?: { left?: number; right?: number },
): number {
  return cov?.left !== undefined && cov.right !== undefined
    ? headingDeg + (cov.left + cov.right) / 2
    : headingDeg;
}

/** The marker badge of a drone sphere: queued and running stitch, or failed. */
export function panoMarkerStatus(p: {
  stitch?: { status: string };
}): 'stitching' | 'failed' | undefined {
  const s = p.stitch?.status;
  if (s === 'queued' || s === 'running') return 'stitching';
  return s === 'failed' ? 'failed' : undefined;
}

/** Whether there is an image to enter: ready-made, or stitched. */
export function panoOpenable(p: { stitch?: { status: string } }): boolean {
  return p.stitch === undefined || p.stitch.status === 'done';
}
```

- [ ] **Step 4: Markers**

`config.ts` `EngineTextKey`: add `| 'stage.markers.stitching' | 'stage.markers.stitchFailed'`.

`markers.ts` `MarkerMember`:

```ts
  /** Shown in the tooltip instead of `id` (a panorama's name). */
  label?: string | undefined;
  /** A drone sphere still stitching, or whose stitch failed. */
  status?: 'stitching' | 'failed' | undefined;
```

CSS, after the `.aio-mk.is-sel` rule:

```css
.aio-mk[data-status='stitching'] .aio-mk-p {
  border-style: dashed;
  opacity: 0.82;
}
.aio-mk[data-status='failed'] .aio-mk-p {
  border-color: var(--warn, oklch(0.75 0.15 60));
}
```

`tipText`: use `this.o.member(first).label ?? this.o.member(first).id` for `id`, and add the status to the second line:

```ts
const status =
  members.length === 1 && first !== undefined ? this.o.member(first).status : undefined;
const state =
  status === 'stitching'
    ? t('stage.markers.stitching')
    : status === 'failed'
      ? t('stage.markers.stitchFailed')
      : '';
const action = status ? '' : t(members.length === 1 ? 'stage.markers.open' : 'stage.markers.list');
return [head, [state, when, action].filter(Boolean).join(' · ')];
```

paint (after `m.root.dataset.count = String(count);`):

```ts
const statuses = this.membersOf(c).map((i) => this.o.member(i).status);
const status = statuses.includes('failed')
  ? 'failed'
  : statuses.includes('stitching')
    ? 'stitching'
    : '';
if ((m.root.dataset.status ?? '') !== status) {
  if (status) m.root.dataset.status = status;
  else delete m.root.dataset.status;
}
```

- [ ] **Step 5: The adapter**

In `panoramas.ts` import `imageCentreDeg, itemCoverage, panoMarkerStatus, panoOpenable` from `./panoMath`. In `create`:

```ts
        member: (i) => {
          const p = items[i];
          if (!p) return { id: '' };
          return {
            id: p.id,
            label: p.name,
            status: panoMarkerStatus(p),
            full: panoOpenable(p) ? ctx.url(p.src) : undefined,
          };
        },
        open: (i) => {
          const p = items[i];
          if (!p) return;
          store.getState().select({ kind: 'pano', id: p.id, layer: layer.id });
          if (panoOpenable(p)) enter(i);
        },
```

`coverageOf` (:354) becomes `(p: PanoRef): PanoCoverage => itemCoverage(p.cov) ?? coverage.get(p.id) ?? FULL_SPHERE;`, the image-size fallback in `loadPano` (:370) becomes `if (!p.cov && !coverage.has(p.id)) {` and passes `imageCentreDeg(p.headingDeg, p.cov)`, and `show` (:392-393) uses `const centre = imageCentreDeg(p.headingDeg, p.cov);` for `pano.setFrame(centre, cov)` and `startLook(centre, cov)`.

In the store subscription (:557), before `if (s.selection === prev.selection) return;`:

```ts
const ask = s.panoRequest;
if (ask && ask !== prev.panoRequest && ask.layer === layer.id) {
  const i = items.findIndex((p) => p.id === ask.id);
  const p = items[i];
  if (p) {
    store.getState().select({ kind: 'pano', id: p.id, layer: layer.id });
    if (panoOpenable(p)) enter(i);
  }
  return;
}
```

(The `select` inside fires this subscription again with the same `panoRequest`, so it falls through to the selection branch, which only repaints.)

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run packages/workspace packages/engine`
Expected: PASS (the existing adapter tests unchanged).

- [ ] **Step 7: Commit**

```bash
git add packages/workspace/src packages/engine/src/config.ts packages/engine/src/adapters/markers.ts packages/engine/src/adapters/panoMath.ts packages/engine/src/adapters/panoMath.test.ts packages/engine/src/adapters/panoramas.ts packages/engine/src/adapters/panoramas.test.ts
git commit -m "feat(engine): stitch status on pano markers, open requests and wide coverage" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: The import preview dialog and its entry points (renderer)

Load the `impeccable` and `frontend-design` skills before the dialog's markup and CSS (CLAUDE.md working agreement 1). The dialog follows `shell/PackageExport.tsx` (`dlg-scrim`, `dlg wide`, `dlg-h`, `dlg-b`, `dlg-sec`, `dlg-f`, `useFocusTrap`, Escape closes).

**Files:**

- Create: `apps/desktop/src/renderer/panos/panos.ts`, `apps/desktop/src/renderer/panos/panos.test.ts`, `apps/desktop/src/renderer/panos/PanoImportDialog.tsx`, `apps/desktop/src/renderer/panos/PanoImportDialog.test.tsx`, `apps/desktop/src/renderer/panos/panos.css`
- Modify: `apps/desktop/src/renderer/shell/Palette.tsx` (after the `builder:import-360` entry at :476-484), `apps/desktop/src/renderer/App.tsx` (import and mount beside `<PackageExportDialog />` at :425)

**Interfaces:**

- Consumes: Task 1 `panos:scan`, `panos:import`, `panos:cancelImport`, `panos:progress`, `PanoScan`, `PanoQuality`, `PANO_HIGH_MIN_TEXTURE`, the `pano.*` strings; `bridge` from `../shell`; `workspace`.
- Produces (`renderer/panos/panos.ts`):

```ts
export interface PanoImportState {
  open: boolean;
  scan: PanoScan | null;
  busy: { phase: 'scan' | 'copy'; done: number; total: number } | null;
  error: string | null;
  /** After an import whose stitches could not start: why (the dialog stays open to say so). */
  notStarted: string | null;
}
export const panoImport: StoreApi<PanoImportState>;
export function usePanoImport<T>(selector: (s: PanoImportState) => T): T;
export function defaultLayerName(day: string | null): string; // "Panoramas 10 Sep"
export function defaultKeys(scan: PanoScan): string[]; // every sphere not already imported, every ready-made one
export function summaryText(scan: PanoScan, keys: readonly string[]): string;
export function canUseHigh(maxTexture: number): boolean;
export function maxTextureSize(): number;
export async function scanPanoPaths(paths: readonly string[]): Promise<void>;
export async function pickAndScanPanos(): Promise<void>;
export async function importPanos(choice: {
  keys: string[];
  layerName: string;
  date?: string;
  quality: PanoQuality;
}): Promise<string | null>; // error or null
export async function closePanoImport(): Promise<void>;
export function openPanoScan(scan: PanoScan): void; // Task 12 opens a scan it already has
```

- `PanoImportDialog` (no props), test ids: `pano-import`, `pano-summary`, `pano-map`, `pano-row-<key>`, `pano-skipped`, `pano-name`, `pano-date`, `pano-quality-high`, `pano-import-go`, `pano-progress`.

- [ ] **Step 1: Failing store tests**

`apps/desktop/src/renderer/panos/panos.test.ts`:

```ts
import type { PanoScan } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../shell', () => ({ bridge: { call } }));

import {
  canUseHigh,
  defaultKeys,
  defaultLayerName,
  importPanos,
  panoImport,
  pickAndScanPanos,
  summaryText,
} from './panos';

const sphere = (key: string, frames: number, over: Partial<PanoScan['spheres'][number]> = {}) => ({
  key,
  shape: 'sphere' as const,
  files: [`D:/card/${key}.JPG`],
  frames,
  bytes: frames * 20_000_000,
  startedAt: '2026-09-10T10:00:00',
  lat: 46.5,
  lon: 7.5,
  relAlt: 70,
  incomplete: false,
  ...over,
});
const scan: PanoScan = {
  scanId: 'scan-1',
  spheres: [sphere('s1', 26), sphere('s2', 26), sphere('s3', 27, { alreadyIn: 'Panoramas 4 Sep' })],
  ready: [],
  skipped: [
    { file: 'D:/card/SYN_0100.JPG', reason: 'few-frames' },
    { file: 'D:/card/SYN_0101.JPG', reason: 'few-frames' },
  ],
  files: 81,
  day: '2026-09-10',
};

beforeEach(() => {
  call.mockReset();
  panoImport.setState({ open: false, scan: null, busy: null, error: null, notStarted: null });
  workspace.getState().openProject({
    id: 'p1',
    root: 'D:/projects/p1',
    manifest: {
      schema: 'aio.project/1',
      id: 'p1',
      name: 'P',
      crs: { epsg: 32639 },
      origin: [0, 0, 0],
      captures: [],
      layers: [],
      severityModels: [],
      classCatalogues: [],
    },
  } as never);
});

describe('preview text', () => {
  it('names the layer after the survey day', () => {
    expect(defaultLayerName('2026-09-10')).toBe('Panoramas 10 Sep');
    expect(defaultLayerName(null)).toBe('Panoramas');
  });

  it('checks every sphere not imported already', () => {
    expect(defaultKeys(scan)).toEqual(['s1', 's2']);
  });

  it('sums up what is found, what is not and what is copied', () => {
    expect(summaryText(scan, ['s1', 's2'])).toBe(
      '2 panoramas found (26 + 26 frames) · 2 files are not panorama frames · about 992 MB copied',
    );
  });

  it('offers High only on GPUs that take 16384 px textures', () => {
    expect(canUseHigh(16384)).toBe(true);
    expect(canUseHigh(8192)).toBe(false);
  });
});

describe('pickAndScanPanos', () => {
  it('scans the chosen folder and opens the preview', async () => {
    call.mockImplementation((channel: string) => {
      if (channel === 'dialog:openFolder')
        return Promise.resolve({ ok: true, value: { path: 'D:/card' } });
      if (channel === 'panos:scan') return Promise.resolve({ ok: true, value: { ok: true, scan } });
      throw new Error(channel);
    });
    await pickAndScanPanos();
    expect(call).toHaveBeenCalledWith('panos:scan', { projectId: 'p1', paths: ['D:/card'] });
    expect(panoImport.getState()).toMatchObject({ open: true, scan, busy: null, error: null });
  });

  it('does nothing when the picker is cancelled', async () => {
    call.mockResolvedValue({ ok: true, value: { path: null } });
    await pickAndScanPanos();
    expect(panoImport.getState().open).toBe(false);
  });
});

describe('importPanos', () => {
  it('imports, takes the saved manifest and closes', async () => {
    panoImport.setState({ open: true, scan });
    const manifest = {
      ...workspace.getState().project!.manifest,
      layers: [
        {
          kind: 'panoramas',
          id: 'panos-2026-09-10',
          name: 'Panoramas 10 Sep',
          visible: true,
          items: [],
        },
      ],
    };
    call.mockResolvedValue({
      ok: true,
      value: { ok: true, manifest, layerId: 'panos-2026-09-10', started: 2 },
    });
    expect(
      await importPanos({
        keys: ['s1', 's2'],
        layerName: 'Panoramas 10 Sep',
        date: '2026-09-10',
        quality: 'standard',
      }),
    ).toBeNull();
    expect(call).toHaveBeenCalledWith('panos:import', {
      projectId: 'p1',
      scanId: 'scan-1',
      keys: ['s1', 's2'],
      layerName: 'Panoramas 10 Sep',
      date: '2026-09-10',
      quality: 'standard',
    });
    expect(workspace.getState().project?.manifest.layers.map((l) => l.id)).toEqual([
      'panos-2026-09-10',
    ]);
    expect(panoImport.getState().open).toBe(false);
  });

  it('stays open to say why the stitches did not start', async () => {
    panoImport.setState({ open: true, scan });
    const manifest = workspace.getState().project!.manifest;
    call.mockResolvedValue({
      ok: true,
      value: {
        ok: true,
        manifest,
        layerId: 'l',
        started: 0,
        notStarted: 'Install the processing tools.',
      },
    });
    await importPanos({ keys: ['s1'], layerName: 'P', quality: 'standard' });
    expect(panoImport.getState()).toMatchObject({
      open: true,
      notStarted: 'Install the processing tools.',
    });
  });

  it('keeps the dialog open with main’s reason on a refusal', async () => {
    panoImport.setState({ open: true, scan });
    call.mockResolvedValue({
      ok: true,
      value: {
        ok: false,
        error: 'Importing these panoramas needs 3.1 GB free, and 1.0 GB is free.',
        code: 'space',
      },
    });
    expect(await importPanos({ keys: ['s1'], layerName: 'P', quality: 'standard' })).toMatch(
      /needs 3.1 GB/,
    );
    expect(panoImport.getState()).toMatchObject({
      open: true,
      busy: null,
      error: expect.stringMatching(/needs 3.1 GB/),
    });
  });
});
```

(The apostrophe in "main’s" is typographic, so the string has no escape; any test title works.)

Run: `pnpm vitest run apps/desktop/src/renderer/panos/panos.test.ts`
Expected: FAIL, `Cannot find module './panos'`.

- [ ] **Step 2: Write `apps/desktop/src/renderer/panos/panos.ts`**

```ts
import { PANO_HIGH_MIN_TEXTURE, type PanoQuality, type PanoScan } from '@aio/schema';
import { formatBytes, t } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { bridge } from '../shell';

export interface PanoImportState {
  open: boolean;
  scan: PanoScan | null;
  busy: { phase: 'scan' | 'copy'; done: number; total: number } | null;
  error: string | null;
  notStarted: string | null;
}

const CLOSED: PanoImportState = {
  open: false,
  scan: null,
  busy: null,
  error: null,
  notStarted: null,
};

/** The drone panorama import: the preview's scan, progress and outcome. */
export const panoImport = createStore<PanoImportState>()(() => ({ ...CLOSED }));

export function usePanoImport<T>(selector: (s: PanoImportState) => T): T {
  return useStore(panoImport, selector);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function defaultLayerName(day: string | null): string {
  const m = day === null ? null : /^\d{4}-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return t('pano.layerNameUndated');
  return t('pano.layerName', { date: `${String(Number(m[2]))} ${MONTHS[Number(m[1]) - 1] ?? ''}` });
}

export function defaultKeys(scan: PanoScan): string[] {
  return [
    ...scan.spheres.filter((s) => s.alreadyIn === undefined).map((s) => s.key),
    ...scan.ready.map((r) => r.key),
  ];
}

export function summaryText(scan: PanoScan, keys: readonly string[]): string {
  const chosen = new Set(keys);
  const spheres = scan.spheres.filter((s) => chosen.has(s.key));
  const ready = scan.ready.filter((r) => chosen.has(r.key));
  const count = spheres.length + ready.length;
  const frames = spheres.map((s) => String(s.frames)).join(' + ') || '0';
  const bytes = spheres.reduce((n, s) => n + s.bytes, 0) + ready.reduce((n, r) => n + r.bytes, 0);
  const parts = [t('pano.preview.found', { count, frames })];
  if (scan.skipped.length) parts.push(t('pano.preview.skipped', { count: scan.skipped.length }));
  parts.push(t('pano.preview.copied', { size: formatBytes(bytes) }));
  return parts.join(' · ');
}

export function canUseHigh(maxTexture: number): boolean {
  return maxTexture >= PANO_HIGH_MIN_TEXTURE;
}

/** The GPU's largest texture edge (WebGL 2), or 0 when it cannot be asked. */
export function maxTextureSize(): number {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    const n = gl ? (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number) : 0;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return n;
  } catch {
    return 0;
  }
}

let unlisten: (() => void) | null = null;
function listen(): void {
  if (unlisten || typeof window === 'undefined' || !('aio' in window)) return;
  unlisten = window.aio.on('panos:progress', (e) => {
    if (e.projectId !== workspace.getState().project?.id) return;
    panoImport.setState({ busy: { phase: e.phase, done: e.done, total: e.total } });
  });
}

export function openPanoScan(scan: PanoScan): void {
  panoImport.setState({ ...CLOSED, open: true, scan });
}

export async function scanPanoPaths(paths: readonly string[]): Promise<void> {
  const project = workspace.getState().project;
  if (!project) {
    panoImport.setState({ ...CLOSED, open: true, error: t('pano.noProject') });
    return;
  }
  listen();
  panoImport.setState({ ...CLOSED, open: true, busy: { phase: 'scan', done: 0, total: 0 } });
  const r = await bridge.call('panos:scan', { projectId: project.id, paths: [...paths] });
  if (!r.ok) panoImport.setState({ busy: null, error: r.error });
  else if (!r.value.ok) panoImport.setState({ busy: null, error: r.value.error });
  else panoImport.setState({ busy: null, scan: r.value.scan });
}

export async function pickAndScanPanos(): Promise<void> {
  const r = await bridge.call('dialog:openFolder', { title: t('pano.pick') });
  if (!r.ok || r.value.path === null) return;
  await scanPanoPaths([r.value.path]);
}

export async function importPanos(choice: {
  keys: string[];
  layerName: string;
  date?: string;
  quality: PanoQuality;
}): Promise<string | null> {
  const project = workspace.getState().project;
  const scan = panoImport.getState().scan;
  if (!project || !scan) return t('pano.noProject');
  listen();
  panoImport.setState({ busy: { phase: 'copy', done: 0, total: 0 }, error: null });
  const r = await bridge.call('panos:import', {
    projectId: project.id,
    scanId: scan.scanId,
    keys: choice.keys,
    layerName: choice.layerName,
    ...(choice.date ? { date: choice.date } : {}),
    quality: choice.quality,
  });
  const error = !r.ok ? r.error : !r.value.ok ? r.value.error : null;
  if (error !== null || !r.ok || !r.value.ok) {
    panoImport.setState({ busy: null, error });
    return error;
  }
  workspace.getState().replaceManifest(r.value.manifest);
  if (r.value.notStarted) panoImport.setState({ busy: null, notStarted: r.value.notStarted });
  else panoImport.setState({ ...CLOSED });
  return null;
}

export async function closePanoImport(): Promise<void> {
  const { busy } = panoImport.getState();
  const project = workspace.getState().project;
  if (busy?.phase === 'copy' && project)
    await bridge.call('panos:cancelImport', { projectId: project.id });
  panoImport.setState({ ...CLOSED });
}
```

(`window.aio.on` is the preload bridge's typed event subscription, as `builder/state.ts:256` uses it for `builder:progress`.)

Run: `pnpm vitest run apps/desktop/src/renderer/panos/panos.test.ts`
Expected: PASS.

- [ ] **Step 3: Failing dialog test**

`apps/desktop/src/renderer/panos/PanoImportDialog.test.tsx`:

```tsx
// @vitest-environment jsdom
import type { PanoScan } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { importPanos, closePanoImport } = vi.hoisted(() => ({
  importPanos: vi.fn(),
  closePanoImport: vi.fn(),
}));
vi.mock('./panos', async (orig) => ({
  ...(await orig<typeof import('./panos')>()),
  importPanos,
  closePanoImport,
  maxTextureSize: () => 8192,
}));
vi.mock('../shell', () => ({ bridge: { call: vi.fn() } }));

import { panoImport } from './panos';
import { PanoImportDialog } from './PanoImportDialog';

const scan: PanoScan = {
  scanId: 'scan-1',
  spheres: [
    {
      key: 's1',
      shape: 'sphere',
      files: ['D:/card/a.JPG'],
      frames: 26,
      bytes: 5e8,
      startedAt: '2026-09-10T10:00:00',
      lat: 46.5,
      lon: 7.5,
      relAlt: 70,
      incomplete: false,
    },
    {
      key: 's2',
      shape: 'wide',
      files: ['D:/card/b.JPG'],
      frames: 21,
      bytes: 4e8,
      startedAt: '2026-09-10T10:06:00',
      lat: 46.501,
      lon: 7.501,
      relAlt: 65,
      incomplete: false,
    },
  ],
  ready: [],
  skipped: [{ file: 'D:/card/SYN_0100.JPG', reason: 'few-frames' }],
  files: 48,
  day: '2026-09-10',
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  importPanos.mockResolvedValue(null);
  panoImport.setState({ open: true, scan, busy: null, error: null, notStarted: null });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('PanoImportDialog', () => {
  it('lists the spheres with the summary, the map and the files left out', () => {
    act(() => root.render(<PanoImportDialog />));
    expect(q('pano-summary')?.textContent).toBe(
      '2 panoramas found (26 + 21 frames) · 1 file is not panorama frames · about 858 MB copied',
    );
    expect(q('pano-row-s2')?.textContent).toContain('Wide panorama');
    expect(q('pano-map')?.querySelectorAll('circle')).toHaveLength(2);
    expect(q('pano-skipped')?.textContent).toContain('SYN_0100.JPG');
    expect(q('pano-skipped')?.textContent).toContain('Moving drone or single shot');
    expect((q('pano-name') as HTMLInputElement).value).toBe('Panoramas 10 Sep');
    expect((q('pano-date') as HTMLInputElement).value).toBe('2026-09-10');
    expect(q('pano-quality-high')).toBeNull(); // the GPU takes 8192 px only
  });

  it('imports the checked spheres', async () => {
    act(() => root.render(<PanoImportDialog />));
    const box = q('pano-row-s1')?.querySelector('input') as HTMLInputElement;
    act(() => box.click());
    await act(async () => q('pano-import-go')?.click());
    expect(importPanos).toHaveBeenCalledWith({
      keys: ['s2'],
      layerName: 'Panoramas 10 Sep',
      date: '2026-09-10',
      quality: 'standard',
    });
  });

  it('shows the copy progress and cannot import twice', () => {
    panoImport.setState({ busy: { phase: 'copy', done: 10, total: 47 } });
    act(() => root.render(<PanoImportDialog />));
    expect(q('pano-progress')?.textContent).toBe('Copying frames: 10 of 47');
    expect((q('pano-import-go') as HTMLButtonElement).disabled).toBe(true);
  });
});
```

(`formatBytes` in `packages/ui/src/format.ts` uses 1024 steps and no decimal from 10 up: 9e8 bytes is `858 MB`, 1.04e9 is `992 MB`.)

Run: `pnpm vitest run apps/desktop/src/renderer/panos/PanoImportDialog.test.tsx`
Expected: FAIL, `Cannot find module './PanoImportDialog'`.

- [ ] **Step 4: Write `apps/desktop/src/renderer/panos/PanoImportDialog.tsx`**

```tsx
import type { PanoQuality, PanoScan } from '@aio/schema';
import { Icon, t, useFocusTrap } from '@aio/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  canUseHigh,
  closePanoImport,
  defaultKeys,
  defaultLayerName,
  importPanos,
  maxTextureSize,
  summaryText,
  usePanoImport,
} from './panos';
import './panos.css';

const MAP_W = 220;
const MAP_H = 120;

/** Where the spheres sit, in metres around their middle, fitted into a small box. */
function SphereMap({ scan, keys }: { scan: PanoScan; keys: ReadonlySet<string> }) {
  const pts = [...scan.spheres, ...scan.ready].map((p) => ({ key: p.key, lat: p.lat, lon: p.lon }));
  if (pts.length === 0) return null;
  const lat0 = pts.reduce((n, p) => n + p.lat, 0) / pts.length;
  const lon0 = pts.reduce((n, p) => n + p.lon, 0) / pts.length;
  const m = pts.map((p) => ({
    key: p.key,
    x: (p.lon - lon0) * 111_320 * Math.cos((lat0 * Math.PI) / 180),
    y: (p.lat - lat0) * 110_540,
  }));
  const span = Math.max(
    50,
    ...m.map((p) => Math.abs(p.x) * 2),
    ...m.map((p) => Math.abs(p.y) * 2 * (MAP_W / MAP_H)),
  );
  const s = (MAP_W - 24) / span;
  return (
    <svg
      className="pano-map"
      data-testid="pano-map"
      viewBox={`0 0 ${String(MAP_W)} ${String(MAP_H)}`}
      role="img"
      aria-label="Where the panoramas sit"
    >
      {m.map((p, i) => (
        <g
          key={p.key}
          className={keys.has(p.key) ? 'on' : 'off'}
          transform={`translate(${String(MAP_W / 2 + p.x * s)} ${String(MAP_H / 2 - p.y * s)})`}
        >
          <circle r={7} />
          <text dy="3.5">{i + 1}</text>
        </g>
      ))}
    </svg>
  );
}

function rowText(frames: number, startedAt: string, relAlt: number | undefined): string {
  const time = startedAt.slice(11, 16);
  return relAlt === undefined
    ? t('pano.preview.rowNoHeight', { frames, time })
    : t('pano.preview.row', { frames, time, height: Math.round(relAlt) });
}

/** "Add drone panoramas": the scan's spheres to tick, the layer's name, date and quality. */
export function PanoImportDialog() {
  const open = usePanoImport((s) => s.open);
  if (!open) return null;
  return <Dialog />;
}

function Dialog() {
  const { scan, busy, error, notStarted } = usePanoImport((s) => s);
  const dlg = useRef<HTMLDivElement>(null);
  useFocusTrap(dlg, true);
  const [keys, setKeys] = useState<Set<string>>(() => new Set(scan ? defaultKeys(scan) : []));
  const [name, setName] = useState(() => defaultLayerName(scan?.day ?? null));
  const [date, setDate] = useState(scan?.day ?? '');
  const [quality, setQuality] = useState<PanoQuality>('standard');
  const high = useMemo(() => canUseHigh(maxTextureSize()), []);
  useEffect(() => {
    if (!scan) return;
    setKeys(new Set(defaultKeys(scan)));
    setName(defaultLayerName(scan.day));
    setDate(scan.day ?? '');
  }, [scan]);
  const toggle = (k: string) =>
    setKeys((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const copying = busy?.phase === 'copy';
  const found = scan ? scan.spheres.length + scan.ready.length : 0;
  const go = () =>
    void importPanos({
      keys: [...keys],
      layerName: name.trim(),
      ...(date ? { date } : {}),
      quality,
    });

  return (
    <div
      className="dlg-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !copying) void closePanoImport();
      }}
    >
      <div
        ref={dlg}
        className="dlg wide pano-import"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pano-import-title"
        data-testid="pano-import"
        onKeyDown={(e) => {
          if (e.key === 'Escape') void closePanoImport();
        }}
      >
        <div className="dlg-h">
          <Icon name="pano" size={16} />
          <h2 id="pano-import-title">{t('pano.preview.title')}</h2>
          <button
            type="button"
            className="btn ghost icon sm"
            aria-label={t('pano.preview.cancel')}
            onClick={() => void closePanoImport()}
          >
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="dlg-b">
          {busy?.phase === 'scan' && (
            <p className="pano-busy" data-testid="pano-progress" aria-live="polite">
              {t('pano.scanning', { done: busy.done, total: busy.total })}
            </p>
          )}
          {error && (
            <p className="notice danger" role="alert">
              <Icon name="warn" size={14} />
              {error}
            </p>
          )}
          {notStarted && (
            <p className="notice" role="status">
              <Icon name="clock" size={14} />
              {notStarted}
            </p>
          )}
          {scan && !notStarted && (
            <>
              <section className="dlg-sec pano-head">
                <p data-testid="pano-summary">
                  {found ? summaryText(scan, [...keys]) : t('pano.none')}
                </p>
                <SphereMap scan={scan} keys={keys} />
              </section>
              <section className="dlg-sec pano-rows">
                {scan.spheres.map((s, i) => (
                  <label
                    key={s.key}
                    className={`pano-row${keys.has(s.key) ? '' : ' off'}`}
                    data-testid={`pano-row-${s.key}`}
                  >
                    <input
                      type="checkbox"
                      checked={keys.has(s.key)}
                      disabled={copying}
                      onChange={() => toggle(s.key)}
                    />
                    {s.thumb ? <img src={s.thumb} alt="" /> : <span className="pano-thumb" />}
                    <span className="pano-row-t">
                      <b>{t('pano.itemName', { n: i + 1 })}</b>
                      <small>{rowText(s.frames, s.startedAt, s.relAlt)}</small>
                    </span>
                    {s.shape === 'wide' && (
                      <span className="tbadge info">{t('pano.preview.wide')}</span>
                    )}
                    {s.incomplete && (
                      <span className="tbadge warn">{t('pano.preview.incomplete')}</span>
                    )}
                    {s.alreadyIn && (
                      <span className="tbadge warn">
                        {t('pano.preview.already', { layer: s.alreadyIn })}
                      </span>
                    )}
                  </label>
                ))}
                {scan.ready.map((r, i) => (
                  <label
                    key={r.key}
                    className={`pano-row${keys.has(r.key) ? '' : ' off'}`}
                    data-testid={`pano-row-${r.key}`}
                  >
                    <input
                      type="checkbox"
                      checked={keys.has(r.key)}
                      disabled={copying}
                      onChange={() => toggle(r.key)}
                    />
                    {r.thumb ? <img src={r.thumb} alt="" /> : <span className="pano-thumb" />}
                    <span className="pano-row-t">
                      <b>{t('pano.itemName', { n: scan.spheres.length + i + 1 })}</b>
                      <small>{r.file.split(/[\\/]/).pop()}</small>
                    </span>
                    <span className="tbadge info">{t('pano.preview.ready')}</span>
                  </label>
                ))}
              </section>
              {scan.skipped.length > 0 && (
                <details className="dlg-sec pano-skipped" data-testid="pano-skipped">
                  <summary>
                    {t('pano.preview.notPano')} ({scan.skipped.length})
                  </summary>
                  <ul>
                    {scan.skipped.slice(0, 200).map((s) => (
                      <li key={s.file}>
                        <span className="mono">{s.file.split(/[\\/]/).pop()}</span>{' '}
                        {t(`pano.skip.${s.reason}`)}
                      </li>
                    ))}
                  </ul>
                  <p className="dim">{t('pano.preview.photosHint')}</p>
                </details>
              )}
              <section className="dlg-sec pano-fields">
                <label>
                  <span>{t('pano.preview.name')}</span>
                  <input
                    data-testid="pano-name"
                    value={name}
                    disabled={copying}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <label>
                  <span>{t('pano.preview.date')}</span>
                  <input
                    data-testid="pano-date"
                    type="date"
                    value={date}
                    disabled={copying}
                    onChange={(e) => setDate(e.target.value)}
                  />
                </label>
                <fieldset>
                  <legend>{t('pano.preview.quality')}</legend>
                  <label>
                    <input
                      type="radio"
                      name="pano-q"
                      checked={quality === 'standard'}
                      onChange={() => setQuality('standard')}
                    />
                    {t('pano.preview.standard')}
                  </label>
                  {high && (
                    <label>
                      <input
                        data-testid="pano-quality-high"
                        type="radio"
                        name="pano-q"
                        checked={quality === 'high'}
                        onChange={() => setQuality('high')}
                      />
                      {t('pano.preview.high')}
                    </label>
                  )}
                </fieldset>
              </section>
            </>
          )}
          {copying && (
            <p className="pano-busy" data-testid="pano-progress" aria-live="polite">
              {t('pano.preview.copying', { done: busy.done, total: busy.total })}
            </p>
          )}
        </div>
        <div className="dlg-f">
          <button type="button" className="btn ghost" onClick={() => void closePanoImport()}>
            {t('pano.preview.cancel')}
          </button>
          {!notStarted && (
            <button
              type="button"
              className="btn primary"
              data-testid="pano-import-go"
              disabled={busy !== null || keys.size === 0 || !name.trim()}
              onClick={go}
            >
              {t('pano.preview.import')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
```

(`t(\`pano.skip.${s.reason}\`)`is typed through the catalogue: the six`pano.skip.*`keys of Task 1 cover`PanoSkipReason`; if `MessageKey`refuses a template literal, map the reason through a`Record<PanoSkipReason, MessageKey>` instead.)

`apps/desktop/src/renderer/panos/panos.css` (scoped to the dialog; tokens as the rest of the app):

```css
.pano-import .pano-head {
  display: flex;
  gap: 16px;
  align-items: flex-start;
  justify-content: space-between;
}
.pano-import .pano-head p {
  margin: 0;
  font-variant-numeric: tabular-nums;
}
.pano-map {
  inline-size: 220px;
  block-size: 120px;
  flex: none;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--bg-2);
}
.pano-map circle {
  fill: var(--bg-3);
  stroke: var(--fg-3);
  stroke-width: 1.25;
}
.pano-map .on circle {
  fill: var(--acc);
  stroke: var(--acc-strong);
}
.pano-map text {
  font: 600 9px var(--f-mono);
  text-anchor: middle;
  fill: var(--fg-0);
}
.pano-map .on text {
  fill: var(--acc-ink);
}
.pano-rows {
  display: grid;
  gap: 4px;
  max-block-size: 300px;
  overflow-y: auto;
}
.pano-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-block-size: 44px;
  padding: 4px 6px;
  border-radius: 4px;
  cursor: pointer;
}
.pano-row:hover {
  background: var(--bg-3);
}
.pano-row.off {
  color: var(--fg-2);
}
.pano-row img,
.pano-row .pano-thumb {
  inline-size: 64px;
  block-size: 43px;
  object-fit: cover;
  border-radius: 3px;
  background: var(--bg-3);
  flex: none;
}
.pano-row-t {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-inline-size: 0;
  margin-inline-end: auto;
}
.pano-row-t small {
  color: var(--fg-2);
  font-variant-numeric: tabular-nums;
}
.pano-skipped ul {
  margin: 6px 0;
  padding-inline-start: 18px;
  max-block-size: 120px;
  overflow-y: auto;
}
.pano-fields {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 10px 16px;
  align-items: end;
}
.pano-fields label {
  display: grid;
  gap: 4px;
}
.pano-fields fieldset {
  grid-column: 1 / -1;
  display: flex;
  gap: 16px;
  border: 0;
  padding: 0;
  margin: 0;
}
.pano-busy {
  font-variant-numeric: tabular-nums;
  color: var(--fg-1);
}
```

Run: `pnpm vitest run apps/desktop/src/renderer/panos`
Expected: PASS.

- [ ] **Step 5: Palette entry and mount**

`Palette.tsx`, after the `builder:import-360` entry:

```ts
list.push({
  id: 'panos:add',
  title: t('pano.add'),
  group: 'Actions',
  icon: 'pano',
  hint: t('pano.add.tip'),
  keywords: ['pano', 'panorama', '360', 'sphere', 'drone', 'dji'],
  run: () => void pickAndScanPanos(),
});
```

(import `pickAndScanPanos` from `../panos/panos`; `t` is already imported there if the file uses it, else from `@aio/ui`).

`App.tsx`: `import { PanoImportDialog } from './panos/PanoImportDialog';` and `<PanoImportDialog />` next to `<PackageExportDialog />`.

Run: `pnpm vitest run apps/desktop/src/renderer` and `pnpm typecheck`
Expected: PASS, no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/panos apps/desktop/src/renderer/shell/Palette.tsx apps/desktop/src/renderer/App.tsx
git commit -m "feat(desktop): drone panorama import preview with sphere map and quality" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Sphere rows in the Datasets tree, the entry button and the reloads (renderer)

The layer row stays as it is (count of spheres); under it, through the tree's existing `rowExtra` slot, one row per sphere with its name, stitch status (a progress line while stitching, the walk pattern), and **Open**, **Fly to** and, when queued or failed, **Stitch**. No change to `@aio/ui`'s tree is needed.

**Files:**

- Create: `apps/desktop/src/renderer/panos/panoModel.ts`, `apps/desktop/src/renderer/panos/panoModel.test.ts`, `apps/desktop/src/renderer/panos/PanoSphereRows.tsx`, `apps/desktop/src/renderer/panos/PanoSphereRows.test.tsx`, `apps/desktop/src/renderer/panos/panoJobs.ts`
- Modify: `apps/desktop/src/renderer/jobs.ts:68-89` (`MANIFEST_WRITERS`), `apps/desktop/src/renderer/shell/Sidebar.tsx` (`walkLine`/`drawingProps.rowExtra` :399-415, the `add-data` button :465-476), `apps/desktop/src/renderer/panos/panos.css` (row styles appended)

**Interfaces:**

- Consumes: Task 1 `PanoRef`, `JobRecord`; Task 9 `workspace.openPano`; Task 10 `pickAndScanPanos`; `jobs`, `useJobs`, `shell`, `bridge` from `../shell`; `folderKey`, `sameFolder`, `isActive` from `../jobs`; `workspace.flyTo`, `setLayerVisible`.
- Produces:

```ts
// panoModel.ts
export type PanoStatus =
  | { kind: 'ready' }
  | { kind: 'queued' }
  | { kind: 'stitching'; pct: number; jobId: string }
  | { kind: 'done' }
  | { kind: 'failed'; message: string };
export function jobForPano<T extends Pick<JobRecord, 'pipeline' | 'project' | 'params'>>(
  jobs: readonly T[],
  root: string,
  layer: string,
  pano: string,
): T | undefined;
export function panoStatus(item: PanoRef, job: JobRecord | undefined): PanoStatus;
export function panoStatusText(s: PanoStatus): string;
export function finishedPanoStitch(
  prev: readonly JobRecord[],
  next: readonly JobRecord[],
  root: string,
): boolean; // failed, interrupted or cancelled just now
export const PANO_FLY_DISTANCE_M = 120;
// PanoSphereRows.tsx
export function PanoSphereRows(p: { layer: PanoLayer; canEdit: boolean }): JSX.Element;
// test ids: pano-sphere-<layerId>-<panoId>, pano-open-<panoId>, pano-fly-<panoId>, pano-stitch-<panoId>, pano-status-<panoId>; Sidebar: add-panos
```

- [ ] **Step 1: Failing model tests**

`apps/desktop/src/renderer/panos/panoModel.test.ts`:

```ts
import type { JobRecord, PanoRef } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { finishedPanoStitch, jobForPano, panoStatus, panoStatusText } from './panoModel';

const item = (stitch?: PanoRef['stitch']): PanoRef => ({
  id: 'p01',
  src: { path: 'panoramas/l/p01/pano.jpg' },
  pos: [0, 70, 0],
  headingDeg: 0,
  name: 'Pano 1',
  ...(stitch ? { stitch } : {}),
});
const job = (over: Partial<JobRecord>): JobRecord =>
  ({
    id: '20261013-101500-pano-stitch-a1b2',
    pipeline: 'pano.stitch',
    project: 'D:\\projects\\p1',
    params: { layer: 'l', pano: 'p01' },
    status: 'running',
    progress: 0.42,
    steps: [],
    artifacts: [],
    createdAt: '2026-10-13T10:15:00Z',
    updatedAt: '2026-10-13T10:16:00Z',
    ...over,
  }) as JobRecord;

describe('panoStatus', () => {
  it('is ready for a ready-made panorama', () => {
    expect(panoStatus(item(), undefined)).toEqual({ kind: 'ready' });
  });

  it('follows the live job first, then the item', () => {
    expect(panoStatus(item({ status: 'queued' }), job({}))).toEqual({
      kind: 'stitching',
      pct: 42,
      jobId: job({}).id,
    });
    expect(panoStatus(item({ status: 'queued' }), job({ status: 'done', progress: 1 }))).toEqual({
      kind: 'done',
    });
    expect(
      panoStatus(item({ status: 'queued' }), job({ status: 'failed', error: 'Too few frames' })),
    ).toEqual({ kind: 'failed', message: 'Too few frames' });
    expect(panoStatus(item({ status: 'queued' }), job({ status: 'cancelled' }))).toEqual({
      kind: 'queued',
    });
    expect(panoStatus(item({ status: 'done', run: 'a' }), undefined)).toEqual({ kind: 'done' });
    expect(panoStatus(item({ status: 'failed', error: 'x' }), undefined)).toEqual({
      kind: 'failed',
      message: 'x',
    });
    expect(panoStatus(item({ status: 'running', run: 'a' }), undefined)).toEqual({
      kind: 'queued',
    });
  });

  it('ignores a job older than the item’s run', () => {
    const it2 = item({ status: 'done', run: '20261013-120000-pano-stitch-bbbb' });
    expect(panoStatus(it2, job({ status: 'failed' }))).toEqual({ kind: 'done' });
  });

  it('caps a running job at 99 % and words each state', () => {
    expect(panoStatus(item({ status: 'queued' }), job({ progress: 1 }))).toMatchObject({ pct: 99 });
    expect(panoStatusText({ kind: 'stitching', pct: 42, jobId: 'j' })).toBe('Stitching 42 %');
    expect(panoStatusText({ kind: 'queued' })).toBe('Waiting to stitch');
    expect(panoStatusText({ kind: 'failed', message: 'x' })).toBe('Stitch failed: x');
  });
});

describe('jobForPano and finishedPanoStitch', () => {
  it('finds the newest job of a sphere in the open project', () => {
    const jobs = [
      job({ id: 'b' }),
      job({ id: 'a' }),
      job({ id: 'c', params: { layer: 'l', pano: 'p02' } }),
    ];
    expect(jobForPano(jobs, 'd:/projects/p1/', 'l', 'p01')?.id).toBe('b');
    expect(jobForPano(jobs, 'D:/other', 'l', 'p01')).toBeUndefined();
  });

  it('tells when a stitch just failed, stopped or was cancelled', () => {
    const before = [job({})];
    expect(finishedPanoStitch(before, [job({ status: 'failed' })], 'D:/projects/p1')).toBe(true);
    expect(finishedPanoStitch(before, [job({ status: 'cancelled' })], 'D:/projects/p1')).toBe(true);
    expect(finishedPanoStitch(before, [job({ status: 'done' })], 'D:/projects/p1')).toBe(false);
    expect(
      finishedPanoStitch(
        [job({ status: 'failed' })],
        [job({ status: 'failed' })],
        'D:/projects/p1',
      ),
    ).toBe(false);
  });
});
```

Run: `pnpm vitest run apps/desktop/src/renderer/panos/panoModel.test.ts`
Expected: FAIL, `Cannot find module './panoModel'`.

- [ ] **Step 2: Write `apps/desktop/src/renderer/panos/panoModel.ts`**

```ts
import type { JobRecord, PanoRef } from '@aio/schema';
import { t } from '@aio/ui';
import { folderKey, isActive, sameFolder } from '../jobs';

export type PanoStatus =
  | { kind: 'ready' }
  | { kind: 'queued' }
  | { kind: 'stitching'; pct: number; jobId: string }
  | { kind: 'done' }
  | { kind: 'failed'; message: string };

/** How far Fly to stands back from a sphere, metres (spheres are shot 60 to 75 m up). */
export const PANO_FLY_DISTANCE_M = 120;

/** The newest `pano.stitch` job of a sphere in the project at `root` (jobs are newest first). */
export function jobForPano<T extends Pick<JobRecord, 'pipeline' | 'project' | 'params'>>(
  jobs: readonly T[],
  root: string,
  layer: string,
  pano: string,
): T | undefined {
  const key = folderKey(root);
  return jobs.find(
    (j) =>
      j.pipeline === 'pano.stitch' &&
      j.params.layer === layer &&
      j.params.pano === pano &&
      folderKey(j.project) === key,
  );
}

/** A sphere's state: its live job when there is one at least as new as its run, else the item. */
export function panoStatus(item: PanoRef, job: JobRecord | undefined): PanoStatus {
  const s = item.stitch;
  if (!s) return { kind: 'ready' };
  if (job && (s.run === undefined || job.id >= s.run)) {
    if (isActive(job))
      return {
        kind: 'stitching',
        pct: Math.min(99, Math.round(job.progress * 100)),
        jobId: job.id,
      };
    if (job.status === 'done') return { kind: 'done' };
    if (job.status === 'failed' || job.status === 'interrupted')
      return { kind: 'failed', message: job.error ?? 'The stitch failed.' };
    if (job.status === 'cancelled') return { kind: 'queued' };
  }
  if (s.status === 'done') return { kind: 'done' };
  if (s.status === 'failed') return { kind: 'failed', message: s.error ?? '' };
  // queued, or running without a live job (the app closed while it ran)
  return { kind: 'queued' };
}

export function panoStatusText(s: PanoStatus): string {
  switch (s.kind) {
    case 'ready':
    case 'done':
      return t('pano.status.done');
    case 'queued':
      return t('pano.status.queued');
    case 'stitching':
      return t('pano.status.stitching', { pct: s.pct });
    case 'failed':
      return t('pano.status.failed', { message: s.message });
  }
}

const ENDED = new Set(['failed', 'interrupted', 'cancelled']);

/** A stitch of this project just failed, stopped or was cancelled: main filed it, reload. */
export function finishedPanoStitch(
  prev: readonly JobRecord[],
  next: readonly JobRecord[],
  root: string,
): boolean {
  return next.some(
    (j) =>
      j.pipeline === 'pano.stitch' &&
      ENDED.has(j.status) &&
      sameFolder(j.project, root) &&
      prev.find((p) => p.id === j.id)?.status !== j.status,
  );
}
```

Run: `pnpm vitest run apps/desktop/src/renderer/panos/panoModel.test.ts`
Expected: PASS.

- [ ] **Step 3: Failing rows test**

`apps/desktop/src/renderer/panos/PanoSphereRows.test.tsx`:

```tsx
// @vitest-environment jsdom
import type { JobRecord, Layer } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { start, go, jobsList } = vi.hoisted(() => ({
  start: vi.fn(),
  go: vi.fn(),
  jobsList: { jobs: [] as JobRecord[] },
}));
vi.mock('../shell', () => ({
  jobs: { getState: () => ({ start }) },
  useJobs: <T,>(sel: (s: { jobs: JobRecord[] }) => T) => sel(jobsList),
  shell: { getState: () => ({ go }) },
  bridge: { call: vi.fn() },
}));

import { PanoSphereRows } from './PanoSphereRows';

type PanoLayer = Extract<Layer, { kind: 'panoramas' }>;
const layer: PanoLayer = {
  kind: 'panoramas',
  id: 'panos-2026-09-10',
  name: 'Panoramas 10 Sep',
  visible: false,
  items: [
    {
      id: 'p01',
      src: { path: 'x' },
      pos: [10, 70, -20],
      headingDeg: 0,
      name: 'Pano 1',
      stitch: { run: 'r1', status: 'done' },
    },
    {
      id: 'p02',
      src: { path: 'y' },
      pos: [150, 70, -20],
      headingDeg: 0,
      name: 'Pano 2',
      stitch: { status: 'failed', error: 'Too few frames' },
    },
  ],
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  start.mockResolvedValue(null);
  workspace.getState().openProject({
    id: 'p1',
    root: 'D:/projects/p1',
    manifest: {
      schema: 'aio.project/1',
      id: 'p1',
      name: 'P',
      crs: { epsg: 32639 },
      origin: [0, 0, 0],
      captures: [],
      layers: [layer],
      severityModels: [],
      classCatalogues: [],
    },
  } as never);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('PanoSphereRows', () => {
  it('lists each sphere with its state', () => {
    act(() => root.render(<PanoSphereRows layer={layer} canEdit />));
    expect(q('pano-status-p01')?.textContent).toBe('Stitched');
    expect(q('pano-status-p02')?.textContent).toBe('Stitch failed: Too few frames');
    expect(q('pano-stitch-p01')).toBeNull();
    expect(q('pano-open-p02')).toBeNull(); // nothing to open yet
  });

  it('opens a stitched sphere: layer shown, 3D view, sphere view asked for', () => {
    act(() => root.render(<PanoSphereRows layer={layer} canEdit />));
    act(() => q('pano-open-p01')?.click());
    expect(workspace.getState().isLayerVisible('panos-2026-09-10')).toBe(true);
    expect(go).toHaveBeenCalledWith('scene');
    expect(workspace.getState().panoRequest).toMatchObject({
      layer: 'panos-2026-09-10',
      id: 'p01',
    });
  });

  it('flies to a sphere and stitches a failed one again', async () => {
    act(() => root.render(<PanoSphereRows layer={layer} canEdit />));
    act(() => q('pano-fly-p02')?.click());
    expect(workspace.getState().camera?.target).toEqual({
      kind: 'point',
      p: [150, 70, -20],
      distance: 120,
    });
    await act(async () => q('pano-stitch-p02')?.click());
    expect(start).toHaveBeenCalledWith({
      pipeline: 'pano.stitch',
      project: 'D:/projects/p1',
      params: { layer: 'panos-2026-09-10', pano: 'p02', quality: 'standard' },
    });
  });

  it('offers no Stitch to someone who may only look', () => {
    act(() => root.render(<PanoSphereRows layer={layer} canEdit={false} />));
    expect(q('pano-stitch-p02')).toBeNull();
  });
});
```

Run: `pnpm vitest run apps/desktop/src/renderer/panos/PanoSphereRows.test.tsx`
Expected: FAIL, `Cannot find module './PanoSphereRows'`.

- [ ] **Step 4: Write `apps/desktop/src/renderer/panos/PanoSphereRows.tsx`**

```tsx
import type { Layer, PanoRef } from '@aio/schema';
import { Icon, t } from '@aio/ui';
import { workspace, useWorkspace } from '@aio/workspace';
import { jobs, shell, useJobs } from '../shell';
import { jobForPano, PANO_FLY_DISTANCE_M, panoStatus, panoStatusText } from './panoModel';
import './panos.css';

type PanoLayer = Extract<Layer, { kind: 'panoramas' }>;

function open(layerId: string, p: PanoRef) {
  const ws = workspace.getState();
  ws.setLayerVisible(layerId, true);
  shell.getState().go('scene');
  ws.openPano(layerId, p.id);
}

function SphereRow({
  layer,
  item,
  canEdit,
  root,
}: {
  layer: PanoLayer;
  item: PanoRef;
  canEdit: boolean;
  root: string;
}) {
  const job = useJobs((s) => jobForPano(s.jobs, root, layer.id, item.id));
  const status = panoStatus(item, job);
  const name = item.name ?? item.id;
  const act = (
    kind: string,
    icon: 'pano' | 'target' | 'refresh',
    label: string,
    run: () => void,
  ) => (
    <button
      type="button"
      className="eye tact"
      aria-label={label}
      title={label}
      data-testid={`pano-${kind}-${item.id}`}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
      }}
      onClick={(e) => {
        e.stopPropagation();
        run();
      }}
    >
      <Icon name={icon} size={14} />
    </button>
  );
  return (
    <div
      className={`pano-sphere ${status.kind}`}
      data-testid={`pano-sphere-${layer.id}-${item.id}`}
    >
      <span className="tn">{name}</span>
      <span className="pano-st" data-testid={`pano-status-${item.id}`}>
        {panoStatusText(status)}
      </span>
      {status.kind === 'stitching' && (
        <span className="walk-meter" aria-hidden="true">
          <span style={{ inlineSize: `${String(status.pct)}%` }} />
        </span>
      )}
      <span className="tacts">
        {(status.kind === 'done' || status.kind === 'ready') &&
          act('open', 'pano', t('pano.action.open', { name }), () => open(layer.id, item))}
        {act('fly', 'target', t('pano.action.flyTo', { name }), () =>
          workspace.getState().flyTo({ kind: 'point', p: item.pos, distance: PANO_FLY_DISTANCE_M }),
        )}
        {canEdit &&
          (status.kind === 'queued' || status.kind === 'failed') &&
          act('stitch', 'refresh', t('pano.action.stitch', { name }), () => {
            void jobs.getState().start({
              pipeline: 'pano.stitch',
              project: root,
              params: { layer: layer.id, pano: item.id, quality: 'standard' },
            });
          })}
      </span>
    </div>
  );
}

/** One row per sphere under a panoramas layer's row in the Datasets tree. */
export function PanoSphereRows({ layer, canEdit }: { layer: PanoLayer; canEdit: boolean }) {
  const root = useWorkspace((s) => s.project?.root);
  if (root === undefined) return null;
  return (
    <div className="pano-spheres" role="group" aria-label={layer.name}>
      {layer.items.map((p) => (
        <SphereRow key={p.id} layer={layer} item={p} canEdit={canEdit} root={root} />
      ))}
    </div>
  );
}
```

(`walk-meter` is the walk progress line's class from `walks/walks.css`, reused for the same look; `useWorkspace` is `@aio/workspace`'s hook. A failed **Stitch** start shows nothing extra in P1; the Jobs panel lists the refusal.)

Append to `panos.css`:

```css
.pano-spheres {
  display: grid;
  gap: 1px;
  padding-inline-start: 22px;
}
.pano-sphere {
  display: flex;
  align-items: center;
  gap: 8px;
  min-block-size: 28px;
  font-size: 12px;
}
.pano-sphere .tn {
  flex: 0 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pano-sphere .pano-st {
  margin-inline-end: auto;
  color: var(--fg-2);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.pano-sphere.failed .pano-st {
  color: var(--warn);
}
.pano-sphere .walk-meter {
  inline-size: 48px;
}
```

Run: `pnpm vitest run apps/desktop/src/renderer/panos`
Expected: PASS.

- [ ] **Step 5: Reloads after a stitch ends, and the manifest writer**

`apps/desktop/src/renderer/jobs.ts`, in `MANIFEST_WRITERS` after `'walk.process',`:

```ts
  // drone panoramas: main files a finished stitch into the manifest before the event arrives
  'pano.stitch',
```

`apps/desktop/src/renderer/panos/panoJobs.ts` (failures and cancels are filed by main too; the open manifest takes them):

```ts
import { workspace } from '@aio/workspace';
import { bridge, jobs } from '../shell';
import { finishedPanoStitch } from './panoModel';

let watching = false;

/** Reload the open manifest when a stitch of it failed, stopped or was cancelled. */
export function watchPanoStitches(): void {
  if (watching) return;
  watching = true;
  jobs.subscribe((s, prev) => {
    const project = workspace.getState().project;
    if (!project || s.jobs === prev.jobs || !finishedPanoStitch(prev.jobs, s.jobs, project.root))
      return;
    void bridge.call('project:open', { path: project.root }).then((r) => {
      const ws = workspace.getState();
      if (r.ok && r.value.ok && ws.project?.id === project.id) ws.replaceManifest(r.value.manifest);
    });
  });
}
```

- [ ] **Step 6: Sidebar**

In `Sidebar.tsx`:

1. Imports: `import { PanoSphereRows } from '../panos/PanoSphereRows';`, `import { pickAndScanPanos } from '../panos/panos';`, `import { watchPanoStitches } from '../panos/panoJobs';` and, once at module level, `watchPanoStitches();`.
2. Under a panoramas layer's row, its spheres (drawings and walks keep theirs):

```tsx
const panoLines = (it: TreeItem) => {
  if (it.layerKind !== 'panoramas') return null;
  const layer = project.manifest.layers.find((l) => l.id === it.layerId);
  return layer?.kind === 'panoramas' && layer.items.some((p) => p.stitch !== undefined) ? (
    <PanoSphereRows layer={layer} canEdit={canEdit} />
  ) : null;
};
```

and in `drawingProps.rowExtra` replace `walkLine(it)` with `walkLine(it) ?? panoLines(it)`. (Older pano layers without stitched spheres keep their single row.)

3. Beside the `add-data` button, for projects that can be edited:

```tsx
{
  !readOnly && (
    <button
      type="button"
      className="tree-add"
      data-testid="add-panos"
      title={t('pano.add.tip')}
      onClick={() => void pickAndScanPanos()}
    >
      <Icon name="pano" size={14} />
      {t('pano.add')}
    </button>
  );
}
```

Load the `impeccable` skill before this step and check the header at 1100 px: if the two buttons crowd the "Datasets" header, show the panorama button as an icon button (`className="eye"`, `aria-label={t('pano.add')}`) like the header's other icon buttons.

Run: `pnpm vitest run apps/desktop/src/renderer` and `pnpm typecheck`
Expected: PASS, no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/panos apps/desktop/src/renderer/jobs.ts apps/desktop/src/renderer/shell/Sidebar.tsx
git commit -m "feat(desktop): sphere rows with stitch status, Open and Fly to in the Datasets tree" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Add data offers the panorama import (renderer)

When **Add data** (or a flight folder import) holds sphere frames, the import stops at a card: "130 of these frames are 5 drone panoramas. Import them as panoramas?". **Import as panoramas** opens the preview with that scan; when the preview closes (imported or cancelled) the rest is imported as before, leaving the sphere frames out of the photo layer. The photo import waits for the preview because the preview is modal and the photo import may stop at its own camera-heights card. **Import all as photos** imports everything as photos. Drawings and 360 video imports are not checked.

**Files:**

- Create: `apps/desktop/src/renderer/builder/panoOffer.test.ts`
- Modify: `apps/desktop/src/renderer/builder/state.ts` (`BuilderState` :24-55, `BuilderActions` :57-88, `ImportOptions` :91-96, initial state :~202, `importFiles` :219-338), `apps/desktop/src/renderer/builder/ImportPanel.tsx` (`ImportStatus` :236-244 and a new `PanoOfferCard`)

**Interfaces:**

- Consumes: Task 1 `panos:scan`, `PanoScan` (spheres carry `files`), `builder:import` `exclude`, strings `pano.offer.*`; Task 10 `openPanoScan(scan)` and the `panoImport` store (its `open` flag).
- Produces:

```ts
export interface PanoOffer {
  paths: readonly string[];
  altitude?: AltitudeChoice;
  scan: PanoScan;
  /** The sphere frames, absolute: left out of the photo import when the offer is taken. */
  frames: string[];
  spheres: number;
}
export function panoOfferFrom(
  paths: readonly string[],
  scan: PanoScan,
  altitude?: AltitudeChoice,
): PanoOffer | null;
// BuilderState: panoOffer: PanoOffer | null
// BuilderActions: acceptPanoOffer(): Promise<void>; declinePanoOffer(): Promise<void>; dismissPanoOffer(): void
// ImportOptions: exclude?: readonly string[]  (also marks the offer as already answered)
// test ids: pano-offer, pano-offer-yes, pano-offer-no
```

- [ ] **Step 1: Failing tests**

`apps/desktop/src/renderer/builder/panoOffer.test.ts`:

```ts
import type { PanoScan } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { call, openPanoScan } = vi.hoisted(() => ({ call: vi.fn(), openPanoScan: vi.fn() }));
vi.mock('../shell', () => ({
  bridge: { call },
  shell: { getState: () => ({ setPalette: vi.fn(), openProject: vi.fn(), go: vi.fn() }) },
}));
vi.mock('../panos/panos', async () => {
  const { createStore } = await import('zustand/vanilla');
  const panoImport = createStore(() => ({ open: false }));
  return {
    panoImport,
    openPanoScan: (scan: unknown) => {
      openPanoScan(scan);
      panoImport.setState({ open: true });
    },
  };
});

import { panoImport } from '../panos/panos';
import { builder, panoOfferFrom } from './state';

const frames = Array.from(
  { length: 25 },
  (_, i) => `D:/card/SYN_${String(i + 1).padStart(4, '0')}.JPG`,
);
const scan: PanoScan = {
  scanId: 'scan-1',
  spheres: [
    {
      key: 's1',
      shape: 'sphere',
      files: frames,
      frames: 25,
      bytes: 1,
      startedAt: '2026-09-10T10:00:00',
      lat: 0,
      lon: 0,
      incomplete: false,
    },
  ],
  ready: [],
  skipped: [{ file: 'D:/card/SYN_0100.JPG', reason: 'few-frames' }],
  files: 26,
  day: '2026-09-10',
};
const none: PanoScan = { ...scan, spheres: [] };

function main(found: PanoScan) {
  call.mockImplementation((channel: string) => {
    if (channel === 'panos:scan')
      return Promise.resolve({ ok: true, value: { ok: true, scan: found } });
    if (channel === 'builder:altitudePlan')
      return Promise.resolve({ ok: false, error: 'not needed here' });
    if (channel === 'builder:import')
      return Promise.resolve({
        ok: true,
        value: { ok: true, manifest: workspace.getState().project!.manifest, items: [] },
      });
    return Promise.resolve({ ok: false, error: channel });
  });
}

beforeEach(() => {
  call.mockReset();
  openPanoScan.mockReset();
  builder.setState({ panoOffer: null, importing: null, importResult: null, heightsPrompt: null });
  workspace.getState().openProject({
    id: 'p1',
    root: 'D:/projects/p1',
    manifest: {
      schema: 'aio.project/1',
      id: 'p1',
      name: 'P',
      crs: { epsg: 32639 },
      origin: [0, 0, 0],
      captures: [],
      layers: [],
      severityModels: [],
      classCatalogues: [],
    },
  } as never);
});

const imports = () =>
  call.mock.calls
    .filter(([c]) => c === 'builder:import')
    .map(([, req]) => req as Record<string, unknown>);

describe('panoOfferFrom', () => {
  it('offers only when spheres were found', () => {
    expect(panoOfferFrom(['D:/card'], none)).toBeNull();
    expect(panoOfferFrom(['D:/card'], scan)).toMatchObject({
      frames,
      spheres: 1,
      paths: ['D:/card'],
    });
  });
});

describe('Add data and drone spheres', () => {
  it('stops at the offer when the files hold spheres', async () => {
    main(scan);
    await builder.getState().importFiles(['D:/card']);
    expect(builder.getState().panoOffer).toMatchObject({ spheres: 1, frames });
    expect(imports()).toEqual([]);
  });

  it('opens the panorama preview on yes, and imports the rest as photos once it closes', async () => {
    main(scan);
    await builder.getState().importFiles(['D:/card']);
    const accepting = builder.getState().acceptPanoOffer();
    expect(openPanoScan).toHaveBeenCalledWith(scan);
    expect(builder.getState().panoOffer).toBeNull();
    await Promise.resolve();
    expect(imports()).toEqual([]); // the preview is modal: the photo import waits for it
    panoImport.setState({ open: false });
    await accepting;
    expect(imports()).toHaveLength(1);
    expect(imports()[0]).toEqual(expect.objectContaining({ paths: ['D:/card'], exclude: frames }));
  });

  it('imports everything as photos on no, without asking again', async () => {
    main(scan);
    await builder.getState().importFiles(['D:/card']);
    await builder.getState().declinePanoOffer();
    expect(openPanoScan).not.toHaveBeenCalled();
    expect(imports()).toEqual([expect.objectContaining({ paths: ['D:/card'] })]);
    expect(imports()[0]?.exclude).toBeUndefined();
  });

  it('goes straight on when there is no sphere, and never checks drawings or 360 video', async () => {
    main(none);
    await builder.getState().importFiles(['D:/card']);
    expect(imports()).toHaveLength(1);
    call.mockClear();
    main(scan);
    await builder.getState().importFiles(['D:/plan.pdf'], undefined, { drawings: true });
    await builder.getState().importFiles(['D:/walk.insv'], undefined, { as360: true });
    expect(call.mock.calls.some(([c]) => c === 'panos:scan')).toBe(false);
  });
});
```

Run: `pnpm vitest run apps/desktop/src/renderer/builder/panoOffer.test.ts`
Expected: FAIL (`panoOfferFrom` is not exported; `panoOffer` stays null).

- [ ] **Step 2: The store**

In `state.ts`:

1. Imports: `type PanoScan` from `@aio/schema`; `import { openPanoScan, panoImport } from '../panos/panos';`.
2. Types and helper (after `ImportOptions`, which gains `exclude`):

```ts
export interface ImportOptions {
  /** Add drawing: every picture becomes a drawing, not a photo or an ortho. */
  drawings?: boolean;
  /** "Add 360 video": MP4 and MOV files are stitched 360 video, not drone clips. */
  as360?: boolean;
  /**
   * Files to leave out (the frames of drone spheres imported as panoramas instead). Present,
   * even empty, it also says the panorama offer was answered.
   */
  exclude?: readonly string[];
}

export interface PanoOffer {
  paths: readonly string[];
  altitude?: AltitudeChoice;
  scan: PanoScan;
  frames: string[];
  spheres: number;
}

/** The offer to import a scan's spheres as panoramas, or null when it found none. */
export function panoOfferFrom(
  paths: readonly string[],
  scan: PanoScan,
  altitude?: AltitudeChoice,
): PanoOffer | null {
  if (scan.spheres.length === 0) return null;
  return {
    paths,
    ...(altitude ? { altitude } : {}),
    scan,
    frames: scan.spheres.flatMap((s) => s.files),
    spheres: scan.spheres.length,
  };
}
```

3. `BuilderState` gains `panoOffer: PanoOffer | null;` (initial `panoOffer: null`), `BuilderActions` gains:

```ts
  /** Import the offered spheres as panoramas (the preview opens) and the rest as photos. */
  acceptPanoOffer: () => Promise<void>;
  /** Import everything as photos. */
  declinePanoOffer: () => Promise<void>;
  dismissPanoOffer: () => void;
```

4. In `importFiles`, right after `if (!paths.length || get().importing) return;`:

```ts
// drone sphere frames go to the panorama import, not into a photo layer (spec section 2)
if (!opts?.drawings && !opts?.as360 && opts?.exclude === undefined) {
  const found = await bridge.call('panos:scan', { projectId: project.id, paths: [...paths] });
  const offer =
    found.ok && found.value.ok ? panoOfferFrom(paths, found.value.scan, altitude) : null;
  if (offer) {
    set({ panoOffer: offer, importResult: null });
    return;
  }
}
```

and pass the exclusion to main in the `builder:import` request: `...(opts?.exclude?.length ? { exclude: [...opts.exclude] } : {}),`.

5. The actions:

```ts
  acceptPanoOffer: async () => {
    const o = get().panoOffer;
    if (!o) return;
    set({ panoOffer: null });
    openPanoScan(o.scan);
    // the preview is modal; the rest goes in as photos once it closes, imported or cancelled
    await new Promise<void>((done) => {
      const stop = panoImport.subscribe((s) => {
        if (s.open) return;
        stop();
        done();
      });
    });
    await get().importFiles(o.paths, o.altitude, { exclude: o.frames });
  },
  declinePanoOffer: async () => {
    const o = get().panoOffer;
    if (!o) return;
    set({ panoOffer: null });
    await get().importFiles(o.paths, o.altitude, { exclude: [] });
  },
  dismissPanoOffer: () => {
    set({ panoOffer: null });
  },
```

(A scan that fails, for example a folder of only PDFs, is no offer: the import goes on as before. The preview opened by **yes** imports through its own scan id, which main keeps.)

- [ ] **Step 3: The card**

In `ImportPanel.tsx`, a card in the `HeightsCard` style:

```tsx
function PanoOfferCard({ o }: { o: PanoOffer }) {
  const t = useT();
  return (
    <section className="b-import" aria-label={t('pano.add')} data-testid="pano-offer">
      <header role="none">
        <Icon name="pano" size={14} />
        {t('pano.add')}
      </header>
      <p className="small">{t('pano.offer.text', { frames: o.frames.length, count: o.spheres })}</p>
      <div className="b-actions">
        <button
          type="button"
          className="btn ghost sm"
          data-testid="pano-offer-no"
          onClick={() => void builder.getState().declinePanoOffer()}
        >
          {t('pano.offer.no')}
        </button>
        <button
          type="button"
          className="btn primary sm"
          data-testid="pano-offer-yes"
          onClick={() => void builder.getState().acceptPanoOffer()}
        >
          {t('pano.offer.yes')}
        </button>
      </div>
    </section>
  );
}
```

and in `ImportStatus`, first: `const offer = useBuilder((s) => s.panoOffer);` and `if (offer && !importing) return <PanoOfferCard o={offer} />;` before the heights prompt line. (Use the class names of `HeightsCard`'s own action row if it is not `b-actions`.)

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run apps/desktop/src/renderer/builder` and `pnpm typecheck`
Expected: PASS (the existing builder tests too: they import drawings, 360 video, or mock `panos:scan` as "nothing found" through their bridge stub; a stub that throws on unknown channels needs a `panos:scan` answer `{ ok: true, value: { ok: true, scan: { ...empty } } }`).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/builder/state.ts apps/desktop/src/renderer/builder/ImportPanel.tsx apps/desktop/src/renderer/builder/panoOffer.test.ts
git commit -m "feat(desktop): Add data offers drone sphere frames to the panorama import" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Pipeline pack 0.7.0

`pano.stitch` adds Python sources only (OpenCV 5 and SciPy are in the pack already), so the pack's size budget does not move. The GPU add-on's lock names the packs it fits; its test checks that the pack version is inside that range, so the range widens with the bump.

**Files:**

- Modify: `python/pyproject.toml:3`, `python/uv.lock` (the `aio-pipelines` entry, :27), `tools/pipeline-pack/accelerator-lock.json` (`version`, `packRange`), `tools/release/budgets.mjs:36-44` (the pack comment)

**Interfaces:**

- Consumes: nothing.
- Produces: pack version `0.7.0` (the folder `pipeline-pack-0.7.0`; `PANO_STITCH_MIN_PACK` of Task 1 names it); add-on lock `version: "0.1.1"`, `packRange: ">=0.5.0 <0.8.0"`.

- [ ] **Step 1: See the add-on test fail after the bump**

Set `version = "0.7.0"` in `python/pyproject.toml`, then run `pnpm vitest run tools/pipeline-pack/accelerator.test.mjs`.
Expected: FAIL in "the pack's version is inside the range the add-on claims" (`0.7.0` is not below `0.7.0`).

- [ ] **Step 2: Widen the add-on range and refresh the lock**

`tools/pipeline-pack/accelerator-lock.json`: `"version": "0.1.1"` and `"packRange": ">=0.5.0 <0.8.0"` (the lock's own comment asks for a new version with every change; the wheels are unchanged). Then `cd python; uv lock` (only the `aio-pipelines` version line changes; check with `git diff python/uv.lock`).

An add-on 0.1.0 already installed carries the old range in its own manifest and is refused next to pack 0.7.0 until add-on 0.1.1 is built and installed: building it is an installer-time step the founder starts (handover section 4); say so in the hand-off.

- [ ] **Step 3: The budget comment**

In `tools/release/budgets.mjs`, append to the pack comment: `Pack 0.7.0 (drone panoramas, pano.stitch) adds Python sources only; the budget is unchanged.`

- [ ] **Step 4: Run the tool tests**

Run: `pnpm vitest run tools/pipeline-pack tools/release`
Expected: PASS. Then `cd python; uv run python -c "import aio_pipelines; print(aio_pipelines.__version__)"` prints `0.7.0` after `uv sync --frozen`.

- [ ] **Step 5: Commit**

```bash
git add python/pyproject.toml python/uv.lock tools/pipeline-pack/accelerator-lock.json tools/release/budgets.mjs
git commit -m "chore(pipelines): pipeline pack 0.7.0 for pano.stitch" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: End to end, the way CI runs it

Two specs on a generated card folder (3 spheres of 25, 22 and 25 frames in both capture patterns, file numbers wrapping, then 4 mapping photos), rendered by `python/tests/pano_synth.py` through the pipeline Python, near the tiny e2e project's origin. Stitches run at `QUADRION_PANO_WIDTH=1024` so a run takes seconds.

**Files:**

- Create: `apps/desktop/e2e/panoSynth.ts`, `apps/desktop/e2e/drone-panoramas.spec.ts`, `apps/desktop/e2e/drone-panoramas-photos.spec.ts`

**Interfaces:**

- Consumes: everything above; e2e fixtures `test`, `expect`, `VENV_PYTHON` (`e2e/fixtures.ts`), the tiny project `E2E tiny project` (EPSG 32639, origin 500000, 3200000), `toWgs84` from `@aio/geo`; test ids `add-panos`, `pano-import`, `pano-summary`, `pano-import-go`, `pano-sphere-*`, `pano-status-*`, `pano-open-*`, `pano-fly-*`, `add-data`, `pano-offer`, `pano-offer-yes`, `import-panel`, `import-heights`.
- Produces: `hasPanoStitch(python): boolean`, `makeSynthCard(python, outDir, { lat, lon }): { folder: string; spheres: number[]; strays: number }`.

- [ ] **Step 1: The fixture helper**

`apps/desktop/e2e/panoSynth.ts`:

```ts
/**
 * A synthetic drone card for the drone panorama specs: the pipeline Python renders it with
 * `python/tests/pano_synth.py` (three spheres in both capture patterns and four mapping photos,
 * DJI-like EXIF and XMP), so no imagery is in the repo.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..', '..', '..');

/** Whether `python` has the pano.stitch pipeline (a pack older than 0.7.0 has none). */
export function hasPanoStitch(python: string): boolean {
  try {
    const r = spawnSync(python, ['-c', 'import aio_pipelines.pano.pipeline'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60_000,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

export interface SynthCard {
  folder: string;
  spheres: number[];
  strays: number;
}

export function makeSynthCard(
  python: string,
  outDir: string,
  at: { lat: number; lon: number },
): SynthCard {
  const r = spawnSync(
    python,
    [
      join(REPO, 'python', 'tests', 'pano_synth.py'),
      outDir,
      '--lat',
      String(at.lat),
      '--lon',
      String(at.lon),
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 300_000,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    },
  );
  if (r.status !== 0) throw new Error(`the synthetic card failed: ${r.stderr || String(r.error)}`);
  const line = r.stdout.trim().split(/\r?\n/).pop() ?? '';
  return JSON.parse(line) as SynthCard;
}
```

- [ ] **Step 2: The import spec**

`apps/desktop/e2e/drone-panoramas.spec.ts`:

```ts
import { toWgs84 } from '@aio/geo';
import type { ElectronApplication } from '@playwright/test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, VENV_PYTHON } from './fixtures';
import { hasPanoStitch, makeSynthCard } from './panoSynth';

/** Make the next native open dialog return these paths (Electron main process). */
async function nextOpenDialog(app: ElectronApplication, paths: string[]) {
  await app.evaluate(({ dialog }, files) => {
    const orig = dialog.showOpenDialog.bind(dialog);
    (dialog as { showOpenDialog: unknown }).showOpenDialog = () => {
      (dialog as { showOpenDialog: unknown }).showOpenDialog = orig;
      return Promise.resolve({ canceled: false, filePaths: files });
    };
  }, paths);
}

interface Manifest {
  layers: {
    kind: string;
    id: string;
    items?: { id: string; name?: string; stitch?: { status: string }; cov?: unknown }[];
  }[];
}

test.describe('drone panoramas', () => {
  test.skip(
    !hasPanoStitch(VENV_PYTHON),
    `no pipeline Python with pano.stitch at ${VENV_PYTHON} (set QUADRION_E2E_PYTHON)`,
  );
  test.use({ appEnv: { QUADRION_PIPELINE_PYTHON: VENV_PYTHON, QUADRION_PANO_WIDTH: '1024' } });

  test('imports a card folder as three spheres, stitches them and opens one', async ({
    app,
    win,
    dataRoot,
  }) => {
    test.setTimeout(420_000);
    const [lon, lat] = toWgs84([500050, 3200050, 0], 32639);
    const card = makeSynthCard(VENV_PYTHON, join(dataRoot.base, 'card'), { lat, lon });
    expect(card.spheres).toEqual([25, 22, 25]);

    await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).first().click();
    await expect(win.locator('[data-scene-view] canvas')).toBeVisible();

    // 1. pick the folder: the preview finds three panoramas and leaves the mapping photos out
    await nextOpenDialog(app, [card.folder]);
    await win.getByTestId('add-panos').click();
    const dlg = win.getByTestId('pano-import');
    await expect(dlg.getByTestId('pano-summary')).toHaveText(
      /^3 panoramas found \(25 \+ 22 \+ 25 frames\) · 4 files are not panorama frames · about .+ copied$/,
      { timeout: 60_000 },
    );
    await expect(dlg.getByTestId('pano-skipped')).toContainText('Moving drone or single shot');
    await expect(dlg.getByTestId('pano-name')).toHaveValue('Panoramas 10 Sep');

    // 2. import: one layer, three queued spheres, frames copied, nothing as photos
    await dlg.getByTestId('pano-import-go').click();
    await expect(dlg).toBeHidden({ timeout: 60_000 });
    const read = async () =>
      JSON.parse(await readFile(join(dataRoot.projectDir, 'manifest.json'), 'utf8')) as Manifest;
    const m = await read();
    const layer = m.layers.find((l) => l.kind === 'panoramas');
    expect(layer?.items?.map((p) => p.name)).toEqual(['Pano 1', 'Pano 2', 'Pano 3']);
    expect(m.layers.some((l) => l.kind === 'photos')).toBe(false);
    expect(
      existsSync(
        join(dataRoot.projectDir, 'panoramas', layer!.id, 'p02', 'frames', 'SYN_0985.JPG'),
      ),
    ).toBe(true);

    // 3. one marker per sphere on the stage (merged icons carry a count)
    await expect
      .poll(
        () =>
          win.evaluate(() =>
            [...document.querySelectorAll<HTMLElement>('[data-markers=pano] .aio-mk')]
              .filter((e) => e.style.display !== 'none')
              .reduce((n, e) => n + Number(e.dataset.count ?? '1'), 0),
          ),
        { timeout: 30_000 },
      )
      .toBe(3);

    // 4. the stitches finish (one heavy run at a time): every row says Stitched
    for (const id of ['p01', 'p02', 'p03'])
      await expect(win.getByTestId(`pano-status-${id}`)).toHaveText('Stitched', {
        timeout: 300_000,
      });
    const done = await read();
    const items = done.layers.find((l) => l.kind === 'panoramas')?.items ?? [];
    expect(items.map((p) => p.stitch?.status)).toEqual(['done', 'done', 'done']);
    expect(
      existsSync(join(dataRoot.projectDir, 'panoramas', layer!.id, 'p01', 'stitch.json')),
    ).toBe(true);

    // 5. Open enters the sphere view; Esc returns; Fly to moves the camera to the sphere
    await win.getByTestId('pano-open-p01').click();
    await expect(win.locator('.aio-pano-hud')).toBeVisible({ timeout: 30_000 });
    await win.keyboard.press('Escape');
    await expect(win.locator('.aio-pano-hud')).toBeHidden();
    await win.getByTestId('pano-fly-p02').click();
    await expect
      .poll(() =>
        win.evaluate(() => {
          const s = (
            window as unknown as {
              __stratlas: {
                workspace: { getState(): { lastCamera: { target: { kind: string } } | null } };
              };
            }
          ).__stratlas;
          return s.workspace.getState().lastCamera?.target.kind ?? null;
        }),
      )
      .toBe('point');
  });
});
```

- [ ] **Step 3: The Add data spec**

`apps/desktop/e2e/drone-panoramas-photos.spec.ts`:

```ts
import { toWgs84 } from '@aio/geo';
import type { ElectronApplication } from '@playwright/test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, VENV_PYTHON } from './fixtures';
import { hasPanoStitch, makeSynthCard } from './panoSynth';

async function nextOpenDialog(app: ElectronApplication, paths: string[]) {
  await app.evaluate(({ dialog }, files) => {
    const orig = dialog.showOpenDialog.bind(dialog);
    (dialog as { showOpenDialog: unknown }).showOpenDialog = () => {
      (dialog as { showOpenDialog: unknown }).showOpenDialog = orig;
      return Promise.resolve({ canceled: false, filePaths: files });
    };
  }, paths);
}

test.describe('Add data with drone sphere frames', () => {
  test.skip(
    !hasPanoStitch(VENV_PYTHON),
    `no pipeline Python with pano.stitch at ${VENV_PYTHON} (set QUADRION_E2E_PYTHON)`,
  );
  test.use({ appEnv: { QUADRION_PIPELINE_PYTHON: VENV_PYTHON, QUADRION_PANO_WIDTH: '1024' } });

  test('offers the spheres as panoramas and imports only the mapping photos as photos', async ({
    app,
    win,
    dataRoot,
  }) => {
    test.setTimeout(300_000);
    const [lon, lat] = toWgs84([500050, 3200050, 0], 32639);
    const card = makeSynthCard(VENV_PYTHON, join(dataRoot.base, 'card'), { lat, lon });
    const files = (await readdir(card.folder)).map((n) => join(card.folder, n));

    await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).first().click();
    await expect(win.locator('[data-scene-view] canvas')).toBeVisible();

    await nextOpenDialog(app, files);
    await win.getByTestId('add-data').click();
    const offer = win.getByTestId('pano-offer');
    await expect(offer).toContainText(
      '72 of these frames are 3 drone panoramas. Import them as panoramas?',
      { timeout: 60_000 },
    );
    await offer.getByTestId('pano-offer-yes').click();

    // the preview first; the photos wait for it
    const dlg = win.getByTestId('pano-import');
    await expect(dlg.getByTestId('pano-summary')).toContainText('3 panoramas found');
    await dlg.getByTestId('pano-import-go').click();
    await expect(dlg).toBeHidden({ timeout: 60_000 });

    // then the four mapping photos, through the camera-heights card when it asks
    const heights = win.getByTestId('import-heights');
    const panel = win.getByTestId('import-panel');
    await expect(heights.or(panel)).toBeVisible({ timeout: 60_000 });
    if (await heights.isVisible())
      await heights.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(panel).toContainText('Imported 4 of 4 files', { timeout: 60_000 });

    const m = JSON.parse(await readFile(join(dataRoot.projectDir, 'manifest.json'), 'utf8')) as {
      layers: { kind: string; items?: unknown[] }[];
    };
    expect(m.layers.find((l) => l.kind === 'photos')?.items).toHaveLength(4);
    expect(m.layers.find((l) => l.kind === 'panoramas')?.items).toHaveLength(3);
  });
});
```

- [ ] **Step 4: Run both the CI way**

From `apps/desktop`, in PowerShell (one Playwright run at a time, the pipeline Python of the main checkout because worktrees have no `python/.venv`):

```powershell
$env:QUADRION_E2E_PYTHON = 'E:\Dev\AIO Software\python\.venv\Scripts\python.exe'
pnpm demo:build --quick
pnpm demo:change --quick
$env:QUADRION_WINDOW_SIZE = '1100x720'; $env:QUADRION_E2E_SCALE = '1'; $env:QUADRION_E2E_SWGL = 'warp'
npx electron-vite build
npx playwright test e2e/drone-panoramas.spec.ts e2e/drone-panoramas-photos.spec.ts --workers=1
```

Expected: both pass; the log prints `[e2e] window 1100 x 720 px at display scale 1`. Then once with `--repeat-each=3`. The main checkout's venv must have this branch's `aio_pipelines.pano` (install it with `uv pip install -e <worktree>\python` into a scratch venv, or point `QUADRION_E2E_PYTHON` at a venv synced from the worktree with `uv sync --frozen`); `hasPanoStitch` skips the specs otherwise, and a skip is not a pass. If the add-panos button was made an icon button in Task 11, the specs still find it by test id.

Expected failure modes and what they mean: the summary never shows (scan or `panos:scan` wiring, Task 8); 0 markers (adapter or layer sync, Task 9); `Waiting to stitch` forever (no pack: the specs set `QUADRION_PIPELINE_PYTHON`; or the `jobs:start` gate, Task 8); the photos test sees 76 photos (the `exclude` path, Tasks 8 and 12).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/e2e/panoSynth.ts apps/desktop/e2e/drone-panoramas.spec.ts apps/desktop/e2e/drone-panoramas-photos.spec.ts
git commit -m "test(e2e): drone panorama import, stitch, open and the Add data offer" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Verification and hand-off

**Files:** none (a session note comes with `/wrapup`).

- [ ] **Step 1: The repository checks**

Run from the worktree: `pnpm check` (lint, format, typecheck, every Vitest test). Expected: green.

- [ ] **Step 2: Python**

Run: `cd python; uv sync --frozen; uv run ruff check .; uv run ruff format --check .; uv run pytest tests/test_pano_geometry.py tests/test_pano_synth.py tests/test_pano_align.py tests/test_pano_compose.py tests/test_pano_stitch.py -q; uv run python -m aio_pipelines --list`
Expected: clean, 43 passed, `pano.stitch` listed. Then the whole suite once, alone on the machine: `uv run pytest -q` (green; the walk and photo suites unchanged).

- [ ] **Step 3: End to end, CI style**

Task 14 Step 4 for both specs, plus `e2e/processing-tools.spec.ts`, `e2e/builder.spec.ts` and `e2e/walk-360.spec.ts` (they touch the pack gate, Add data and the jobs event path this branch changed), each the CI way, `--workers=1`.

- [ ] **Step 4: Public text and contracts**

Run: `node tools/agent/check-public-text.mjs docs/architecture/contract-changes.md docs/architecture/data-conventions.md docs/plans/2026-10-13-drone-panoramas-p1.md` and scan the added lines (`git diff origin/main --stat`, then the diff) for client, site and person names, as handover section 3 says. Confirm the six contract rows are in `docs/architecture/contract-changes.md`.

- [ ] **Step 5: Prepare the merge**

Run: `node tools/agent/finish-task.mjs` in the worktree (rebase onto `origin/main`, checks, commit-message scan). Then follow CLAUDE.md "Every session merges its own branch": coordinate, lock, draft PR, `node tools/agent/watch-ci.mjs pr <number>`, fast-forward, release, announce. This branch touches many files: say so when announcing, and merge after smaller branches.

- [ ] **Step 6: The hand-off note**

Write the "How to test" walkthrough for the founder (in the closing message and the session note):

1. Open a project (with a CRS), click **Add drone panoramas** next to **Add data** (or Ctrl+K, "pano").
2. Choose a card folder with sphere frames (a folder of one flight is fine; subfolders are searched).
3. The preview says "N panoramas found (…) · M files are not panorama frames · about X copied", shows a small map and a row per sphere; wide panoramas say so. Set the survey date and name, keep Standard (High shows only on a GPU that takes 16K textures), click **Import**.
4. One marker per sphere appears at once with a dashed outline (stitching); the Datasets tree shows the layer with a row per sphere and "Stitching NN %".
5. When a row says **Stitched**, click its **Open** button: the sphere view opens level, north up. **Fly to** frames it from above.
6. Drop the same folder into **Add data**: the card offers the spheres as panoramas; **Import as panoramas** opens the preview, and only the other photos land in the photo layer.
7. Known in P1: Set north, hop to neighbours, date strip (P2); rename, restitch with a quality choice, details, export, remove (P3); the Augment panel (P4). The GPU add-on needs its 0.1.1 build to work with pack 0.7.0.

---

## Verification before hand-off

- `pnpm check` green; the Python suite green with the 43 new tests; `python -m aio_pipelines --list` shows `pano.stitch`.
- `drone-panoramas.spec.ts` and `drone-panoramas-photos.spec.ts` green the CI way (1100 x 720, scale 1, WARP, every demo built), `--repeat-each=3` once; `processing-tools`, `builder` and `walk-360` specs unchanged and green.
- Contract rows written; data-conventions section 34 written; the spec's P0 section matches the constants.
- No client, site, tester or person name, and no real image, anywhere in the diff.

## How to test (for the founder, after the build)

See Task 15 Step 6.
