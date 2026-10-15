# Bentley import: a ZPC cloud and an AT block with its photos. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add data reads what a Bentley iTwin Capture Modeler (formerly ContextCapture) job delivers: a `.zpc` (a ZIP of LAS/LAZ tiles) becomes one COPC point cloud layer, and a BlocksExchange AT `.xml` plus the folder of its photos becomes a processing run and a photos layer placed by the calibrated poses, both in the project frame so they line up.

**Architecture:** `pointcloud.to_copc` learns `.zpc`: it lists the ZIP's tiles safely, unpacks them into the job's staging folder, reads each tile's summary, reprojects tile by tile when needed, and hands the whole folder of tiles to the shared COPC writer, which gives untwine the folder (untwine merges its inputs out of core) or PDAL a `filters.merge` pipeline. A new `bentley.import` job (`python/src/aio_pipelines/bentley/`) parses BlocksExchange 3.x, converts Bentley's world-to-camera rotations, centres and Brown distortion to our conventions (reusing `opf.import`'s frame, pose and sparse-model writers), matches photos by file name under the chosen folder, makes 2560 px review copies for the layer as `opf.import` does, and writes a run under `photogrammetry/<run>/`. In the app, Add data routes `.zpc` to the cloud job and sniffs `.xml` for `<BlocksExchange`, asking main for the photos folder through an injected folder picker.

**Tech Stack:** Python 3.13 (`zipfile`, `xml.etree.ElementTree`, numpy, rasterio through `opf.geometry`), `aio_pipelines` job runtime, conda-forge PDAL and untwine from the pipeline pack, zod in `@aio/schema`, `@aio/project` raw import, Electron main and React renderer, Vitest, pytest, Playwright with Electron.

**Spec:** `docs/plans/2026-10-15-bentley-import-design.md` (founder decisions of 15 Oct 2026). Read it before any task.

## Global Constraints

- BlocksExchange: major version 3 only; `CameraOrientation` `XRightYDown` only; rotations as `M_00`..`M_22` matrices only (Omega/Phi/Kappa or Heading/Pitch/Roll are refused with a message asking for a matrix export); block SRS must be an `EPSG:` code of a projected CRS (a geographic, local or unknown SRS is refused).
- Bentley's rotation is **world to camera**, camera axes x right, y down, z forward (COLMAP's own convention), so `R_colmap = R_bentley` and `x_cam = R (X - C)`. Measured on the reference block: the third row of `M` points from the camera centre towards the tower (median 26 degrees off the cloud centre for 560 photos; the third column is 73 degrees off), and the second row has a negative z (image down is world down).
- Only the direct children `Pose/Rotation` and `Pose/Center` are the adjusted pose. `Pose/Metadata/Rotation` and `Pose/Metadata/Center` are the GNSS/EXIF prior in another SRS (`Metadata/SRSId`, WGS 84 on the reference block) and are never read.
- Focal length in pixels: `FocalLengthPixels` when present, else `FocalLength (mm) * max(width, height) / SensorSize (mm)` (BlocksExchange: `SensorSize` is the largest sensor dimension). `AspectRatio` must be 1 and `Skew` 0 (within 1e-6), else the photogroup is refused.
- Principal point: Bentley pixels from the image's top-left corner, used as `cx, cy` as they are (COLMAP: the image's top-left corner at (0, 0)).
- Distortion: Bentley `K1 K2 K3` are OpenCV `k1 k2 k3`; Bentley's tangential terms are swapped against OpenCV: **OpenCV `p1` = Bentley `P2`, OpenCV `p2` = Bentley `P1`** (`TANGENTIAL_SWAP = True` in `bentley/convert.py`), Bentley's model being `x_d = x(1 + K1 r² + K2 r⁴ + K3 r⁶) + P1 (r² + 2x²) + 2 P2 x y`, `y_d = y(1 + ...) + P2 (r² + 2y²) + 2 P1 x y` on normalised coordinates. The reference export has no tie points, so this is confirmed only by Task 12 (see Review Focus 1).
- `PhotoRef.lens` (pinhole variant) gains optional `cx`, `cy`, `k1`, `k2`, `k3`, `p1`, `p2`, OpenCV convention, normalised coordinates, pixels for `cx`/`cy`. Nobody reads them yet.
- Job `bentley.import`, params `{ xml, photos, name? }` (`xml` and `photos` absolute; `name` 1 to 120 characters). Run id `bentley-<YYYYMMDD-HHMM>` (made unique). Layer id `photos-<run>`. Report `photogrammetry/<run>/report/bentley-import.json`.
- Photo matching: by file name, case-insensitive, anywhere under the chosen folder; duplicates decided by the last two path segments; anything still ambiguous counts as missing. The job needs at least one matched photo.
- Photos are read in place and never written; the photos layer shows 2560 px review copies under `photos/<run>/` (exactly as `opf.import` does: a layer item's `src` must be a project path), and `sparse/photos.json` points the run at the originals.
- `Layer.capture` of the photos layer: the manifest capture of the earliest `DateTimeOriginal` date of the matched photos (found or added like `captureForDate`: `capture-<date>`, label `Survey`, date order). `takenAt` is left out: BlocksExchange times have no time zone.
- **Spec deviation (founder to confirm):** the `.zpc` cloud does **not** take `Layer.capture` from the LAS header. On the reference job every tile's header says day 285 of 2026 (12 Oct, the export day) while the photos were taken on 7 Oct: the LAS "file creation" date is the export, not the survey, and would put the cloud and the photos on different dates. The cloud is left without a capture, as any imported cloud, and the person sets it.
- `.zpc` refusals: not a ZIP; a member with an absolute path, a drive letter or `..`; an encrypted member; no `.las`/`.laz` member; tiles in different CRSs; a tile PDAL cannot read or unpack (named in the message). No partial layer in any of these cases. Members other than `.las`/`.laz` are ignored (logged).
- Tiles are unpacked to `staging/zpc-tiles/tile-NNN.<ext>` (never the member's own name) and removed in a `finally`, as are reprojected tiles in `staging/zpc-las/`.
- Reference job facts (measured 15 Oct): 4 tiles, LAS 1.2, point format 2 (XYZ, RGB, intensity, classification), scale 0.0001 with a different offset per tile (so COPC files cannot be merged chunk by chunk as `tools/pointcloud/merge-copc.mjs` does), 125,562,135 points, members stored uncompressed (ZIP method 0), 1.04 GB.
- Pipeline pack: the next free minor version at merge time (0.10.0 if `main` is still at 0.9.0), Python sources only; `APP_RANGE` unchanged (old apps drop the unknown lens keys on save, which is harmless).
- Repository rules: no em or en dashes in user-facing text; the product name only from `@aio/brand`; conventional commits (header and body lines at most 100 characters, lower-case subject), each ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; no client, site, tower or person names in any committed text or test data (the repo is public); never commit on `main`; never copy the reference files into the repo.
- Local test load: one heavy run at a time (`pnpm check`, a Playwright run, a real PDAL/untwine pytest); Playwright with `--workers=1`.

## Review Focus

1. **Bentley's distortion and principal point conventions are wrong in a way no synthetic test can catch.** The synthetic block is written with the same assumption the converter makes, and the reference export has no tie points. A person would expect a finding placed from a photo to land on the right spot of the cloud. Pinned twice: Task 4 (`test_the_tangential_terms_are_swapped_into_opencv`, which states the assumed Bentley formula in code), and Task 12, which asks the founder for a re-export of the reference AT with tie points (BlocksExchange "export tie points") and checks that the median reprojection of those tie points through our OpenCV camera is under 1 px; if it is not, try `TANGENTIAL_SWAP = False` and a half-pixel principal point shift, and record which wins.
2. **The EXIF prior inside `Pose/Metadata` read as the pose.** A careless `find(".//Rotation")` or `iter("Center")` picks the WGS 84 prior (degrees as metres) and puts every camera kilometres away. Pinned by Task 3 (`test_the_pose_is_the_adjusted_one_not_the_metadata_prior`), whose synthetic photos carry a deliberately different Metadata pose.
3. **A photos folder with the same file name in several flights, or names in another case, or the original `R:/...` drive.** A person expects each photo matched once, or listed as missing, never placed with another flight's photo. Pinned by Task 5 (`test_duplicates_are_told_apart_by_their_folder`, `test_a_name_matched_twice_is_ambiguous_and_missing`, `test_case_and_drive_do_not_matter`).
4. **A block in another projected CRS than the project** (UTM 40N block, UTM 39N project). Positions are reprojected and the camera axes must turn with the grid convergence, or every photo looks a degree off. Pinned by Task 4 (`test_a_block_in_another_utm_zone_turns_with_the_grid`).
5. **A `.zpc` import or a Bentley import that is cancelled or runs twice.** A cancel during unpacking must leave no tile files behind; a commit that runs again must not add a second photos layer or a second capture. Pinned by Task 7 (`test_a_cancel_while_unpacking_leaves_no_tiles`) and Task 6 (`test_a_commit_run_twice_adds_one_layer_and_one_capture`).

---

## Before you start (every implementer)

- Worktree: `E:\Dev\AIO Software\.claude\worktrees\bentley-import`, branch `feat/bentley-import`. Work only there; never edit the main checkout or another worktree. Never run a bare `git stash`.
- Python: the worktree has no `python/.venv`. Once per worktree: `uv sync --frozen --directory python`, then check `uv run --frozen --directory python python -c "import aio_pipelines; print(aio_pipelines.__file__)"` prints a path inside this worktree (never junction or re-point the main checkout's venv). Python tests run as `uv run --frozen --directory python pytest tests/<file>.py -q`.
- Real PDAL and untwine for the `skipif` tests: set `AIO_PDAL` and `AIO_UNTWINE` to the installed pack's `tools\pdal\Library\bin\pdal.exe` and `untwine.exe` (for example under `E:\Stratlas Data\runtime\pipeline-pack-0.8.0\`).
- Node tests: `pnpm vitest run <file>` from the worktree root; `pnpm check` before a hand-off.
- Parallel batches share this one worktree. The controller commits each finished task (never two commits at once: lint-staged uses the shared stash) with `git commit -F <message file>` written to the scratchpad.
- Reference data (`C:\Users\D\Downloads\`, an AT `.xml` and a `.zpc`) is client data: read it only in Task 12, never copy it, never quote its paths, names or ids in code, tests, logs you commit or notes.

## File structure

| File                                                                                                                                        | Responsibility                                                                                        | Task |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---- |
| `packages/schema/src/layers.ts`, `jobs.ts`, `builder.ts`                                                                                    | lens fields, `bentley.import` name, catalogue, params; `ImportItem.kind` `bentley`; `.zpc` in the doc | 1    |
| `packages/schema/src/bentley.test.ts` (new), `jobs.test.ts`                                                                                 | the contract tests                                                                                    | 1    |
| `docs/architecture/contract-changes.md`                                                                                                     | the contract row                                                                                      | 1    |
| `python/tests/bentley_synth.py` (new), `python/tests/test_bentley_synth.py` (new)                                                           | synthetic block, photos and 2-tile `.zpc`; CLI for the e2e spec                                       | 2    |
| `python/src/aio_pipelines/photo/cloud_out.py`, `python/tests/test_photo_cloud_out.py`                                                       | the COPC writer takes a folder of tiles                                                               | 3a   |
| `python/src/aio_pipelines/bentley/__init__.py`, `blocks.py` (new)                                                                           | BlocksExchange parser                                                                                 | 3    |
| `python/tests/test_bentley_blocks.py` (new)                                                                                                 | parser tests                                                                                          | 3    |
| `python/src/aio_pipelines/bentley/convert.py` (new), `python/tests/test_bentley_convert.py` (new)                                           | lens, frame and pose conversion                                                                       | 4    |
| `python/src/aio_pipelines/bentley/match.py` (new), `python/tests/test_bentley_match.py` (new)                                               | photo matching and photo ids                                                                          | 5    |
| `python/src/aio_pipelines/bentley/importer.py` (new), `python/src/aio_pipelines/captures.py` (new), `python/src/aio_pipelines/pipelines.py` | the job, capture lookup, registration                                                                 | 6    |
| `python/tests/test_bentley_import.py` (new), `python/tests/test_captures.py` (new)                                                          | job tests                                                                                             | 6    |
| `python/src/aio_pipelines/zpc.py` (new), `python/src/aio_pipelines/pointcloud.py`, `python/tests/test_pointcloud_zpc.py` (new)              | `.zpc` in `pointcloud.to_copc`                                                                        | 7    |
| `packages/project/src/builder/raw.ts`, `raw.test.ts`                                                                                        | Add data routing of `.zpc` and `.xml`, the folder picker seam                                         | 8    |
| `apps/desktop/src/main/builder.ts`, `index.ts`, `builderJobs.ts`, `builderJobs.test.ts`                                                     | the folder picker in main; `bentley.import` as a builder job                                          | 9    |
| `apps/desktop/src/renderer/builder/state.ts`, `jobs.ts`, `processing/pipelines.ts`, `shell/Palette.tsx`, `jobs-bentley.test.ts` (new)       | filters, job form, groups, palette words                                                              | 9    |
| `docs/architecture/data-conventions.md`, `python/pyproject.toml`, `python/uv.lock`                                                          | section 35 and section 4 note; pack version                                                           | 10   |
| `apps/desktop/e2e/bentley-import.spec.ts` (new)                                                                                             | the end to end spec                                                                                   | 11   |
| none in git (session note)                                                                                                                  | the reference job by hand                                                                             | 12   |

`apps/desktop/src/renderer/builder/surveys.ts` (`CLOUD_FILTERS`, the volumetric wizard) is deliberately **not** changed: `volumetric.build` reads clouds with its own PDAL path and does not know `.zpc`.

## Execution DAG

```
Batch 1 (parallel):  T1 schema contract   T2 synthetic fixtures   T3a COPC writer takes a folder
Batch 2 (parallel):  T3 blocks parser (T2)   T5 photo matching (none)   T7 .zpc in pointcloud.to_copc (T2, T3a)   T8 raw import routing (T1)
Batch 3 (parallel):  T4 lens/frame/pose (T3)   T9 desktop main + renderer (T1, T8)
Batch 4:             T6 bentley.import job (T3, T4, T5)
Batch 5 (parallel):  T10 docs + pack version (T6, T7)   T11 e2e spec (T6, T7, T9)
Batch 6, founder window:  T12 reference job by hand (T10, T11)
```

| Task | Depends on | Files it may touch (no other task in its batch touches them)                                                                                                                                                             | Packages               |
| ---- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| T1   | none       | `packages/schema/src/layers.ts`, `jobs.ts`, `builder.ts`, `bentley.test.ts`, `jobs.test.ts`; `docs/architecture/contract-changes.md`                                                                                     | `@aio/schema`, docs    |
| T2   | none       | `python/tests/bentley_synth.py`, `python/tests/test_bentley_synth.py`                                                                                                                                                    | python (tests)         |
| T3a  | none       | `python/src/aio_pipelines/photo/cloud_out.py`, `python/tests/test_photo_cloud_out.py`                                                                                                                                    | python                 |
| T3   | T2         | `python/src/aio_pipelines/bentley/__init__.py`, `bentley/blocks.py`, `python/tests/test_bentley_blocks.py`                                                                                                               | python                 |
| T5   | none       | `python/src/aio_pipelines/bentley/match.py`, `python/tests/test_bentley_match.py` (does **not** create `bentley/__init__.py`; the implicit namespace package imports until T3 adds it)                                   | python                 |
| T7   | T2, T3a    | `python/src/aio_pipelines/zpc.py`, `python/src/aio_pipelines/pointcloud.py`, `python/tests/test_pointcloud_zpc.py`                                                                                                       | python                 |
| T8   | T1         | `packages/project/src/builder/raw.ts`, `raw.test.ts`                                                                                                                                                                     | `@aio/project`         |
| T4   | T3         | `python/src/aio_pipelines/bentley/convert.py`, `python/tests/test_bentley_convert.py`                                                                                                                                    | python                 |
| T9   | T1, T8     | `apps/desktop/src/main/builder.ts`, `index.ts`, `builderJobs.ts`, `builderJobs.test.ts`; `apps/desktop/src/renderer/builder/state.ts`, `jobs.ts`, `processing/pipelines.ts`, `shell/Palette.tsx`, `jobs-bentley.test.ts` | desktop                |
| T6   | T3, T4, T5 | `python/src/aio_pipelines/bentley/importer.py`, `python/src/aio_pipelines/captures.py`, `python/src/aio_pipelines/pipelines.py`, `python/tests/test_bentley_import.py`, `python/tests/test_captures.py`                  | python                 |
| T10  | T6, T7     | `docs/architecture/data-conventions.md`, `python/pyproject.toml`, `python/uv.lock`                                                                                                                                       | docs, python (version) |
| T11  | T6, T7, T9 | `apps/desktop/e2e/bentley-import.spec.ts`                                                                                                                                                                                | desktop e2e            |
| T12  | T10, T11   | none in git                                                                                                                                                                                                              | none                   |

**Critical path:** T2 → T3 → T4 → T6 → T11 → T12. T1, T3a, T5, T7, T8, T9 and T10 run beside it.

**Tests per task:** T1 `bentley.test.ts`, `jobs.test.ts`, `layers.test.ts` (unchanged, must stay green); T2 `test_bentley_synth.py`; T3a `test_photo_cloud_out.py` (with real untwine and PDAL); T3 `test_bentley_blocks.py`; T4 `test_bentley_convert.py`; T5 `test_bentley_match.py`; T6 `test_bentley_import.py`, `test_captures.py`, `test_m10_params.py` (unchanged, must stay green), ruff; T7 `test_pointcloud_zpc.py`, `test_pointcloud.py` (unchanged, must stay green); T8 `raw.test.ts`; T9 `builderJobs.test.ts`, `jobs-bentley.test.ts`, `jobs-m10.test.ts`; T10 `pnpm format:check`, `test_app_range.py`; T11 the e2e spec the CI way plus `pnpm check`; T12 by hand.

**E2E specs:** new `apps/desktop/e2e/bentley-import.spec.ts` (Task 11). No existing spec changes.

**Contract change:** yes, one row in `docs/architecture/contract-changes.md` (Task 1): `LensModel` pinhole gains optional `cx`, `cy`, `k1`, `k2`, `k3`, `p1`, `p2`; `PipelineName` gains `bentley.import` (`BentleyImportParams`: `xml`, `photos`, `name?`); `ImportItem.kind` gains `bentley`; `PointcloudToCopcParams.src` may be a `.zpc`. Data conventions get section 35 and a section 4 note (Task 10).

---

### Task 1: The contract in `@aio/schema`

**Files:**

- Modify: `packages/schema/src/layers.ts:7-19` (`LensModel`)
- Modify: `packages/schema/src/jobs.ts:40-70` (`PipelineName`), `:~200` (`PIPELINES` after `opf.export`), `:416-426` (`PointcloudToCopcParams` doc), after `:707` (`BentleyImportParams`), `:1061` (type), `:1151` (`PARAMS`)
- Modify: `packages/schema/src/builder.ts:166-180` (`ImportItem.kind`)
- Modify: `packages/schema/src/jobs.test.ts:75-103` (the name list)
- Create: `packages/schema/src/bentley.test.ts`
- Modify: `docs/architecture/contract-changes.md` (append a row)

**Interfaces:**

- Consumes: nothing.
- Produces: `LensModel` pinhole `{ model: 'pinhole', hfovDeg, aspect, cx?, cy?, k1?, k2?, k3?, p1?, p2? }`; `PipelineName` `'bentley.import'`; `export const BentleyImportParams` and `export type BentleyImportParams = { xml: string; photos: string; name?: string }`; `pipelineParams('bentley.import') === BentleyImportParams`; `ImportItem['kind']` includes `'bentley'`.

- [ ] **Step 1: Write the failing tests**

Create `packages/schema/src/bentley.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ImportItem } from './builder';
import { BentleyImportParams, PIPELINES, PipelineName, pipelineParams } from './jobs';
import { LensModel, PhotoRef } from './layers';

describe('Bentley import contract', () => {
  it('keeps a pinhole lens valid with and without the principal point and distortion', () => {
    const plain = { model: 'pinhole', hfovDeg: 70.2, aspect: 1.3347 };
    expect(LensModel.parse(plain)).toEqual(plain);
    const full = {
      ...plain,
      cx: 2656.9,
      cy: 1965.6,
      k1: 0.0027,
      k2: -0.0088,
      k3: 0.006,
      p1: 3e-5,
      p2: -1.4e-4,
    };
    expect(LensModel.parse(full)).toEqual(full);
    const photo = {
      id: 'p1',
      src: { path: 'photos/r/p1.jpg' },
      pos: [1, 2, 3],
      q: [0, 0, 0, 1],
      lens: full,
    };
    expect(PhotoRef.parse(photo).lens).toEqual(full);
    expect(LensModel.safeParse({ ...plain, k1: 'x' }).success).toBe(false);
  });

  it('names the job, lists it and checks its parameters', () => {
    expect(PipelineName.options).toContain('bentley.import');
    expect(PIPELINES.find((p) => p.name === 'bentley.import')?.title).toBe('Bentley import');
    expect(pipelineParams('bentley.import')).toBe(BentleyImportParams);
    const ok = { xml: 'D:/jobs/at.xml', photos: 'D:/jobs/photos' };
    expect(BentleyImportParams.parse(ok)).toEqual(ok);
    expect(BentleyImportParams.parse({ ...ok, name: 'Tower block' }).name).toBe('Tower block');
    expect(BentleyImportParams.safeParse({ xml: 'D:/jobs/at.xml' }).success).toBe(false);
    expect(BentleyImportParams.safeParse({ ...ok, name: '' }).success).toBe(false);
    expect(BentleyImportParams.safeParse({ ...ok, bogus: 1 }).success).toBe(false);
  });

  it('lets the raw import report a Bentley block', () => {
    expect(ImportItem.parse({ file: 'at.xml', kind: 'bentley', status: 'queued' }).kind).toBe(
      'bentley',
    );
  });
});
```

In `packages/schema/src/jobs.test.ts`, add `'bentley.import',` to the expected name list right after `'opf.export',`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/schema/src/bentley.test.ts packages/schema/src/jobs.test.ts`
Expected: FAIL (`BentleyImportParams` is not exported; the name list differs).

- [ ] **Step 3: Write the contract**

In `packages/schema/src/layers.ts`, replace the pinhole member of `LensModel`:

```ts
  z.object({
    model: z.literal('pinhole'),
    hfovDeg: z.number().gt(0).lt(180),
    aspect: z.number().positive(),
    /**
     * Principal point and distortion of a calibrated camera (Bentley import, 15 Oct 2026), all
     * optional and read by nothing yet: `cx`, `cy` in pixels from the image's top-left corner;
     * `k1`, `k2`, `k3`, `p1`, `p2` in the OpenCV convention on normalised coordinates.
     */
    cx: z.number().optional(),
    cy: z.number().optional(),
    k1: z.number().optional(),
    k2: z.number().optional(),
    k3: z.number().optional(),
    p1: z.number().optional(),
    p2: z.number().optional(),
  }),
```

In `packages/schema/src/jobs.ts`: add `'bentley.import',` to `PipelineName` after `'opf.export',` with the comment `// Bentley iTwin Capture Modeler AT export (15 Oct 2026)`; add to `PIPELINES` after the `opf.export` entry:

```ts
  {
    name: 'bentley.import',
    title: 'Bentley import',
    description:
      'A Bentley iTwin Capture Modeler (ContextCapture) AT export with its photos: a run and a photos layer placed by the calibrated poses.',
  },
```

Change the `PointcloudToCopcParams.src` comment to `/** LAS, LAZ, E57 or PLY file, or a Bentley .zpc (a ZIP of LAS/LAZ tiles), absolute. Read only. */`. After `OpfImportParams` add:

```ts
/** `bentley.import` (python `aio_pipelines/bentley/importer.py`, 15 Oct 2026). */
export const BentleyImportParams = z
  .object({
    /** The BlocksExchange AT export (`.xml`, absolute). Read only. */
    xml: z.string().min(1).max(MAX_PATH),
    /** The folder that holds the block's photos (absolute), searched with its subfolders. Read only. */
    photos: z.string().min(1).max(MAX_PATH),
    /** Name of the photos layer; default the XML file's name. */
    name: z.string().min(1).max(120).optional(),
  })
  .strict();
```

Add `export type BentleyImportParams = z.infer<typeof BentleyImportParams>;` beside `OpfImportParams`'s type and `'bentley.import': BentleyImportParams,` to `PARAMS` after `'opf.export'`.

In `packages/schema/src/builder.ts` `ImportItem.kind`, after `'design',` add:

```ts
    // Bentley iTwin Capture Modeler (15 Oct 2026): a BlocksExchange AT export, by `bentley.import`
    'bentley',
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/schema/src`
Expected: PASS (every schema test, `layers.test.ts` included).

- [ ] **Step 5: The contract row**

Append to `docs/architecture/contract-changes.md`:

```
| 2026-10-15 | Bentley import: `LensModel` pinhole gains optional `cx`, `cy` (pixels from the top-left corner) and `k1`, `k2`, `k3`, `p1`, `p2` (OpenCV convention, normalised coordinates), read by nothing yet; `PipelineName` gains `bentley.import` (`BentleyImportParams`: `xml`, `photos`, `name?`); `ImportItem.kind` gains `bentley`; `pointcloud.to_copc` `src` may be a `.zpc` (a ZIP of LAS/LAZ tiles). All additive; data-conventions section 35 |
```

Run `pnpm format` on the file so the table pads.

- [ ] **Step 6: Commit**

```bash
git add packages/schema/src/layers.ts packages/schema/src/jobs.ts packages/schema/src/builder.ts packages/schema/src/bentley.test.ts packages/schema/src/jobs.test.ts docs/architecture/contract-changes.md
git commit -F <msg>   # feat(schema): bentley import job, lens principal point and distortion
```

---

### Task 2: Synthetic fixtures (block, photos, 2-tile ZPC)

**Files:**

- Create: `python/tests/bentley_synth.py`
- Create: `python/tests/test_bentley_synth.py`

**Interfaces:**

- Consumes: `aio_pipelines.change.las.write_las` (LAS 1.4 writer, no CRS).
- Produces (used by Tasks 3, 4, 6, 7, 11):
  - constants `EPSG = 32639`, `ORIGIN = (500000.0, 3200000.0, 0.0)`, `W, H = 640, 480`, `FOCAL_MM = 4.0`, `SENSOR_MM = 6.4` (so the focal is 400 px), `PP = (322.5, 238.0)`, `K = (0.01, -0.02, 0.005)`, `P_BENTLEY = (0.0004, -0.0003)` (Bentley's P1, P2), `TARGET = (500010.0, 3200020.0, 5.0)`;
  - `bentley_project(R, C, X) -> np.ndarray` (pixels, Bentley's own model, the reference the converter is tested against);
  - `make_project(root: Path) -> Path` (an empty project in EPSG:32639, origin `ORIGIN`);
  - `make_block(folder: Path, *, srs: str = "EPSG:32639", version: str = "3.2", orientation: str = "XRightYDown") -> dict` writing `folder/at.xml` and `folder/photos/flight-a/IMG_0001.JPG`, `.../flight-a/img_0002.jpg`, `.../flight-b/IMG_0003.JPG`, returning `{"xml": str, "photos": str, "poses": {id: (R, C)}, "names": {...}}`; four photos in the XML, `Id` 0 to 3, photo 3 without `Pose/Rotation` (unaligned); each posed photo has a `Pose/Metadata` with a different rotation and a WGS 84 centre; `ExifData/DateTimeOriginal` `2026-03-04T10:00:0N`, with photo 2 the earliest; `ImagePath` like `R:/survey/flight-a/IMG_0001.JPG`;
  - `make_zpc(path: Path, tiles: int = 2, points: int = 500, extra: dict[str, bytes] | None = None) -> dict` writing a ZIP of `Tile_<n>.las` tiles side by side east of `TARGET` (each `points` points, RGB), plus `extra` members as given; returns `{"zpc": str, "points": tiles * points, "bounds": (xmin, ymin, xmax, ymax)}`;
  - CLI `python bentley_synth.py <folder>` writes a block and a 2-tile `.zpc` there and prints one JSON line `{"xml", "photos", "zpc", "points"}`.

- [ ] **Step 1: Write the failing test**

Create `python/tests/test_bentley_synth.py`:

```python
"""bentley_synth.py: the synthetic Bentley block, its photos and a tiny .zpc (no client data)."""

import json
import subprocess
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

import numpy as np

import bentley_synth as bs


def test_the_block_names_four_photos_one_unaligned_and_writes_three_jpgs(tmp_path):
    out = bs.make_block(tmp_path)
    root = ET.parse(out["xml"]).getroot()
    assert root.tag == "BlocksExchange" and root.get("version") == "3.2"
    photos = root.findall("Block/Photogroups/Photogroup/Photo")
    assert len(photos) == 4
    assert sum(p.find("Pose/Rotation") is None for p in photos) == 1
    jpgs = sorted(p.name for p in Path(out["photos"]).rglob("*") if p.suffix.lower() == ".jpg")
    assert jpgs == ["IMG_0001.JPG", "IMG_0003.JPG", "img_0002.jpg"]


def test_every_posed_camera_sees_the_target_inside_its_image(tmp_path):
    out = bs.make_block(tmp_path)
    for R, C in out["poses"].values():
        uv = bs.bentley_project(R, C, np.array([bs.TARGET]))[0]
        assert 0 < uv[0] < bs.W and 0 < uv[1] < bs.H


def test_the_zpc_is_a_zip_of_las_tiles_with_the_points_asked_for(tmp_path):
    z = bs.make_zpc(tmp_path / "cloud.zpc", tiles=2, points=300)
    with zipfile.ZipFile(z["zpc"]) as f:
        names = sorted(f.namelist())
        assert names == ["Tile_1.las", "Tile_2.las"]
        assert all(f.read(n)[:4] == b"LASF" for n in names)
    assert z["points"] == 600


def test_the_cli_prints_the_fixture_paths(tmp_path):
    here = Path(bs.__file__).resolve()
    line = subprocess.run(
        [sys.executable, str(here), str(tmp_path / "fx")], capture_output=True, text=True, check=True
    ).stdout.strip()
    info = json.loads(line)
    assert Path(info["xml"]).is_file() and Path(info["photos"]).is_dir() and Path(info["zpc"]).is_file()
```

- [ ] **Step 2: Run it to verify it fails**

Run: `uv run --frozen --directory python pytest tests/test_bentley_synth.py -q`
Expected: FAIL (`ModuleNotFoundError: bentley_synth`).

- [ ] **Step 3: Write the generator**

Create `python/tests/bentley_synth.py`:

```python
"""Synthetic Bentley iTwin Capture Modeler data (no client data): a fictional mast in UTM 39N.

- ``make_block``: a BlocksExchange 3.2 AT export (one photogroup, four photos, one of them not
  aligned) and three small JPEGs in two flight folders, the way Bentley writes such a block:
  rotations world to camera (x right, y down, z forward), centres in the block SRS, principal
  point in pixels, Brown distortion with Bentley's tangential order, and a ``Pose/Metadata``
  GNSS prior that must never be read as the pose.
- ``make_zpc``: a ``.zpc``, a ZIP of LAS tiles side by side (stored, as Bentley writes it).

``python bentley_synth.py <folder>`` writes both into ``<folder>`` (the e2e fixture) and prints
their paths as one JSON line.
"""

from __future__ import annotations

import json
import math
import sys
import zipfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

EPSG = 32639
ORIGIN = (500000.0, 3200000.0, 0.0)
W, H = 640, 480
FOCAL_MM, SENSOR_MM = 4.0, 6.4  # 400 px across the 640 px width
FOCAL_PX = FOCAL_MM * max(W, H) / SENSOR_MM
PP = (322.5, 238.0)
K = (0.01, -0.02, 0.005)
P_BENTLEY = (0.0004, -0.0003)  # Bentley's P1, P2 as written in the XML
TARGET = (500010.0, 3200020.0, 5.0)
#: Camera centres (E, N, H) around the target, and the photo files they belong to.
CENTRES = [(500000.0, 3200000.0, 30.0), (500025.0, 3200005.0, 28.0), (500030.0, 3200035.0, 32.0)]
FILES = ["flight-a/IMG_0001.JPG", "flight-a/img_0002.jpg", "flight-b/IMG_0003.JPG"]
TIMES = ["2026-03-04T10:00:05", "2026-03-04T10:00:01", "2026-03-04T10:00:09"]


def look_at(C, X) -> np.ndarray:
    """World-to-camera rotation (rows: image right, image down, forward) of a camera at C looking at X."""
    f = np.asarray(X, float) - np.asarray(C, float)
    f /= np.linalg.norm(f)
    right = np.cross(f, [0.0, 0.0, 1.0])
    right /= np.linalg.norm(right)
    down = np.cross(f, right)
    return np.vstack([right, down, f])


def bentley_project(R, C, X) -> np.ndarray:
    """Pixels of world points through the synthetic camera, by Bentley's own model."""
    cam = (np.asarray(X, float) - np.asarray(C, float)) @ np.asarray(R, float).T
    x, y = cam[:, 0] / cam[:, 2], cam[:, 1] / cam[:, 2]
    r2 = x * x + y * y
    radial = 1 + K[0] * r2 + K[1] * r2**2 + K[2] * r2**3
    P1, P2 = P_BENTLEY
    xd = x * radial + P1 * (r2 + 2 * x * x) + 2 * P2 * x * y
    yd = y * radial + P2 * (r2 + 2 * y * y) + 2 * P1 * x * y
    return np.column_stack([FOCAL_PX * xd + PP[0], FOCAL_PX * yd + PP[1]])


def make_project(root: Path) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    manifest = {
        "schema": "aio.project/1",
        "id": root.name,
        "name": "Bentley test project",
        "crs": {"epsg": EPSG},
        "origin": list(ORIGIN),
        "captures": [],
        "layers": [],
        "severityModels": [],
        "classCatalogues": [],
    }
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2), "utf-8")
    return root


def _matrix(tag: str, R: np.ndarray) -> str:
    cells = "".join(f"<M_{i}{j}>{R[i, j]!r}</M_{i}{j}>" for i in range(3) for j in range(3))
    return f"<{tag}>{cells}<Accurate>true</Accurate></{tag}>"


def _photo(i: int, path: str, pose: tuple[np.ndarray, tuple] | None, taken: str) -> str:
    pose_xml = ""
    if pose is not None:
        R, C = pose
        prior = R @ np.array([[0.0, 1.0, 0.0], [-1.0, 0.0, 0.0], [0.0, 0.0, 1.0]])  # a decoy, 90 degrees off
        pose_xml = (
            f"<Pose>{_matrix('Rotation', R)}"
            f"<Center><x>{C[0]!r}</x><y>{C[1]!r}</y><z>{C[2]!r}</z><Accurate>true</Accurate></Center>"
            f"<Metadata><SRSId>0</SRSId>{_matrix('Rotation', prior)}"
            "<Center><x>51.0</x><y>28.9</y><z>30.0</z></Center></Metadata></Pose>"
        )
    else:
        pose_xml = "<Pose><Metadata><SRSId>0</SRSId><Center><x>51.0</x><y>28.9</y><z>30.0</z></Center></Metadata></Pose>"
    return (
        f"<Photo><Id>{i}</Id><ImagePath>{path}</ImagePath><Component>1</Component>{pose_xml}"
        f"<ExifData><DateTimeOriginal>{taken}</DateTimeOriginal></ExifData></Photo>"
    )


def make_block(
    folder: Path, *, srs: str = f"EPSG:{EPSG}", version: str = "3.2", orientation: str = "XRightYDown"
) -> dict:
    folder.mkdir(parents=True, exist_ok=True)
    photos = folder / "photos"
    poses: dict[str, tuple[np.ndarray, tuple]] = {}
    xml_photos = []
    for i, (rel, C, taken) in enumerate(zip(FILES, CENTRES, TIMES, strict=True)):
        R = look_at(C, TARGET)
        poses[str(i)] = (R, C)
        xml_photos.append(_photo(i, f"R:/survey/{rel}", (R, C), taken))
        f = photos / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        img = Image.new("RGB", (W, H), (90 + 40 * i, 120, 160))
        uv = bentley_project(R, C, np.array([TARGET]))[0]
        ImageDraw.Draw(img).ellipse([uv[0] - 6, uv[1] - 6, uv[0] + 6, uv[1] + 6], fill=(255, 0, 0))
        img.save(f, "JPEG", quality=85)
    xml_photos.append(_photo(3, "R:/survey/flight-b/IMG_0004.JPG", None, "2026-03-04T10:00:12"))
    P1, P2 = P_BENTLEY
    xml = f"""<?xml version="1.0" encoding="utf-8"?>
<BlocksExchange version="{version}">
  <SpatialReferenceSystems>
    <SRS><Id>0</Id><Name>WGS 84</Name><Definition>WGS84</Definition></SRS>
    <SRS><Id>1</Id><Name>Synthetic block SRS</Name><Definition>{srs}</Definition></SRS>
  </SpatialReferenceSystems>
  <Block>
    <Name>Synthetic mast - AT</Name>
    <SRSId>1</SRSId>
    <Photogroups>
      <Photogroup>
        <Name>Photogroup 1</Name>
        <ImageDimensions><Width>{W}</Width><Height>{H}</Height></ImageDimensions>
        <CameraModelType>Perspective</CameraModelType>
        <FocalLength>{FOCAL_MM!r}</FocalLength>
        <SensorSize>{SENSOR_MM!r}</SensorSize>
        <CameraOrientation>{orientation}</CameraOrientation>
        <PrincipalPoint><x>{PP[0]!r}</x><y>{PP[1]!r}</y></PrincipalPoint>
        <Distortion><K1>{K[0]!r}</K1><K2>{K[1]!r}</K2><K3>{K[2]!r}</K3><P1>{P1!r}</P1><P2>{P2!r}</P2></Distortion>
        <AspectRatio>1</AspectRatio>
        <Skew>0</Skew>
        {"".join(xml_photos)}
      </Photogroup>
    </Photogroups>
  </Block>
</BlocksExchange>
"""
    (folder / "at.xml").write_text(xml, "utf-8")
    return {"xml": str(folder / "at.xml"), "photos": str(photos), "poses": poses, "names": dict(enumerate(FILES))}


def make_zpc(path: Path, tiles: int = 2, points: int = 500, extra: dict[str, bytes] | None = None) -> dict:
    from aio_pipelines.change.las import write_las

    path.parent.mkdir(parents=True, exist_ok=True)
    work = path.parent / f".{path.stem}-tiles"
    work.mkdir(exist_ok=True)
    rng = np.random.default_rng(11)
    lo = np.array([TARGET[0], TARGET[1]])
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED) as z:
        for t in range(tiles):
            xy = lo + np.array([t * 10.0, 0.0]) + rng.uniform(0, 10, (points, 2))
            xyz = np.column_stack([xy, rng.uniform(0, 10, points)])
            rgb = rng.integers(0, 65535, (points, 3)).astype(np.uint16)
            tile = work / f"Tile_{t + 1}.las"
            write_las(tile, xyz, pdrf=7, rgb=rgb)
            z.write(tile, tile.name)
        for name, data in (extra or {}).items():
            z.writestr(name, data)
    for f in work.iterdir():
        f.unlink()
    work.rmdir()
    return {
        "zpc": str(path),
        "points": tiles * points,
        "bounds": (lo[0], lo[1], lo[0] + 10.0 * tiles, lo[1] + 10.0),
    }


if __name__ == "__main__":
    out = Path(sys.argv[1])
    block = make_block(out)
    z = make_zpc(out / "synthetic.zpc")
    print(json.dumps({"xml": block["xml"], "photos": block["photos"], "zpc": z["zpc"], "points": z["points"]}))
```

If `write_las` rejects `rgb` with `pdrf=7` (check its signature in `python/src/aio_pipelines/change/las.py:217`), write without `rgb` at its default `pdrf`; the tests above do not depend on colour.

- [ ] **Step 4: Run it to verify it passes**

Run: `uv run --frozen --directory python pytest tests/test_bentley_synth.py -q`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add python/tests/bentley_synth.py python/tests/test_bentley_synth.py
git commit -F <msg>   # test(pipelines): synthetic bentley block, photos and zpc
```

---

### Task 3a: The COPC writer takes a folder of tiles

**Files:**

- Modify: `python/src/aio_pipelines/photo/cloud_out.py:34-47` (`untwine_args`, `pdal_copc_pipeline`), module docstring
- Modify: `python/tests/test_photo_cloud_out.py` (append tests)

**Interfaces:**

- Consumes: nothing from other tasks.
- Produces: `write_copc(ctx, las, out, points, epsg, temp, budget, progress)` where `las` may be a **folder**: untwine gets `-i <folder>` (untwine 1.5 reads every LAS/LAZ in a folder and merges them: `--files, -i  Input files/directory`); PDAL gets one `readers.las` per `*.las`/`*.laz` in it (sorted) and a `filters.merge`. New `def las_inputs(las: Path) -> list[Path]` (the folder's LAS/LAZ files sorted, or `[las]`; a folder without any raises `JobError`).

- [ ] **Step 1: Write the failing tests**

Append to `python/tests/test_photo_cloud_out.py`:

```python
def _tiles(tmp_path, n=2, points=1000, junk=True):
    from aio_pipelines.change.las import write_las

    folder = tmp_path / "tiles"
    folder.mkdir()
    rng = np.random.default_rng(3)
    for i in range(n):
        xyz = np.column_stack([rng.uniform(0, 10, points) + 10 * i, rng.uniform(0, 10, points), rng.uniform(0, 5, points)])
        write_las(folder / f"tile-{i + 1:03d}.las", xyz + np.array([412000.0, 3245000.0, 0.0]))
    if junk:
        (folder / "readme.txt").write_text("not a tile")
    return folder


def test_a_folder_of_tiles_is_every_las_in_it_sorted(tmp_path):
    folder = _tiles(tmp_path)
    assert [p.name for p in C.las_inputs(folder)] == ["tile-001.las", "tile-002.las"]
    assert C.las_inputs(tmp_path / "one.las") == [tmp_path / "one.las"]
    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(JobError, match="no LAS or LAZ"):
        C.las_inputs(empty)


def test_pdal_merges_every_tile_of_a_folder(tmp_path):
    folder = _tiles(tmp_path)
    pipe = C.pdal_copc_pipeline(folder, tmp_path / "o.copc.laz", 32639)["pipeline"]
    assert [s["type"] for s in pipe] == ["readers.las", "readers.las", "filters.merge", "writers.copc"]
    assert pipe[0]["override_srs"] == "EPSG:32639"
    one = C.pdal_copc_pipeline(tmp_path / "c.las", tmp_path / "o.copc.laz", None)["pipeline"]
    assert [s["type"] for s in one] == ["readers.las", "writers.copc"]


@pytest.mark.skipif(not all(_real_tools()), reason="needs untwine and PDAL (AIO_UNTWINE, AIO_PDAL)")
def test_real_untwine_merges_a_folder_of_tiles(tmp_path):
    import json
    import subprocess

    from aio_pipelines.pointcloud import find_pdal, pdal_env

    folder = _tiles(tmp_path, n=2, points=5000, junk=False)  # a zpc folder holds tiles only
    ctx, _ = _ctx(tmp_path)
    out = tmp_path / "m.copc.laz"
    assert C.write_copc(ctx, folder, out, 10_000, ps.EPSG, tmp_path / ".t", 2**31) == "untwine"
    pdal = find_pdal()
    info = json.loads(
        subprocess.run([pdal, "info", "--summary", str(out)], capture_output=True, check=True, env=pdal_env(pdal)).stdout
    )["summary"]
    assert info["num_points"] == 10_000
    assert info["bounds"]["maxx"] - info["bounds"]["minx"] > 19.0  # both tiles
```

- [ ] **Step 2: Run them to verify they fail**

Run: `uv run --frozen --directory python pytest tests/test_photo_cloud_out.py -q -k "folder or tiles"`
Expected: FAIL (`las_inputs` missing; a folder gives a single `readers.las`).

- [ ] **Step 3: Implement**

In `python/src/aio_pipelines/photo/cloud_out.py`, add after `NO_COPC_TOOL`:

```python
#: What a folder of tiles may hold for the COPC writers.
TILE_SUFFIXES = (".las", ".laz")


def las_inputs(las: Path) -> list[Path]:
    """The LAS/LAZ files a COPC is built from: ``las`` itself, or, when it is a folder (the tiles
    of a Bentley ``.zpc``), every LAS or LAZ file in it, sorted. untwine reads the folder itself."""
    if not las.is_dir():
        return [las]
    files = sorted(p for p in las.iterdir() if p.is_file() and p.suffix.lower() in TILE_SUFFIXES)
    if not files:
        raise JobError(f"The folder {las.name} holds no LAS or LAZ files to build the COPC from.")
    return files
```

Replace `pdal_copc_pipeline`:

```python
def pdal_copc_pipeline(las: Path, out: Path, epsg: int | None) -> dict[str, Any]:
    srs = f"EPSG:{epsg}" if epsg else None
    readers = [
        {"type": "readers.las", "filename": str(f), **({"override_srs": srs} if srs else {})}
        for f in las_inputs(las)
    ]
    merge = [{"type": "filters.merge"}] if len(readers) > 1 else []
    writer = {"type": "writers.copc", "filename": str(out), **({"a_srs": srs} if srs else {})}
    return {"pipeline": [*readers, *merge, writer]}
```

`untwine_args` stays as it is (`-i` takes the folder). Add to the module docstring: "`las` may be a folder of tiles: untwine reads the folder, PDAL merges one reader per tile."

- [ ] **Step 4: Run to verify they pass**

Run: `uv run --frozen --directory python pytest tests/test_photo_cloud_out.py -q` (with `AIO_PDAL` and `AIO_UNTWINE` set)
Expected: all pass, the real untwine test included (not skipped).

- [ ] **Step 5: Commit**

```bash
git add python/src/aio_pipelines/photo/cloud_out.py python/tests/test_photo_cloud_out.py
git commit -F <msg>   # feat(pipelines): the copc writer builds one cloud from a folder of tiles
```

---

### Task 3: The BlocksExchange parser

**Files:**

- Create: `python/src/aio_pipelines/bentley/__init__.py` (`"""Bentley iTwin Capture Modeler (ContextCapture) imports: BlocksExchange AT exports."""`)
- Create: `python/src/aio_pipelines/bentley/blocks.py`
- Create: `python/tests/test_bentley_blocks.py`

**Interfaces:**

- Consumes: `bentley_synth.make_block` (Task 2).
- Produces:

```python
@dataclass
class Srs:
    id: str
    name: str
    definition: str

@dataclass
class Photogroup:
    index: int
    name: str
    width: int
    height: int
    focal_px: float
    cx: float
    cy: float
    k: tuple[float, float, float]          # K1, K2, K3
    p: tuple[float, float]                 # Bentley P1, P2, as written
    aspect: float
    skew: float

@dataclass
class BlockPhoto:
    id: str
    image_path: str
    group: int                              # Photogroup.index
    rotation: np.ndarray | None             # 3x3 world to camera, None when not aligned
    centre: np.ndarray | None               # block SRS
    taken: str | None                       # DateTimeOriginal as written

@dataclass
class Block:
    version: str
    name: str
    srs: Srs | None
    groups: list[Photogroup]
    photos: list[BlockPhoto]
    def aligned(self) -> list[BlockPhoto]: ...
    def unaligned(self) -> list[BlockPhoto]: ...

def is_blocks_exchange(path: Path) -> bool
def read_block(path: Path) -> Block
```

- [ ] **Step 1: Write the failing tests**

Create `python/tests/test_bentley_blocks.py`:

```python
"""bentley/blocks.py: BlocksExchange 3.x read on the synthetic block (no client data)."""

import numpy as np
import pytest

import bentley_synth as bs
from aio_pipelines.bentley.blocks import is_blocks_exchange, read_block
from aio_pipelines.runtime import JobError


def test_the_block_its_srs_and_its_photogroup_are_read(tmp_path):
    out = bs.make_block(tmp_path)
    b = read_block(tmp_path / "at.xml")
    assert b.version == "3.2" and b.name == "Synthetic mast - AT"
    assert b.srs is not None and b.srs.definition == "EPSG:32639"
    (g,) = b.groups
    assert (g.width, g.height) == (bs.W, bs.H)
    assert g.focal_px == pytest.approx(bs.FOCAL_PX)
    assert (g.cx, g.cy) == bs.PP and g.k == bs.K and g.p == bs.P_BENTLEY
    assert len(b.photos) == 4 and len(b.aligned()) == 3 and [p.id for p in b.unaligned()] == ["3"]
    assert b.photos[0].image_path == "R:/survey/flight-a/IMG_0001.JPG"
    assert b.photos[1].taken == "2026-03-04T10:00:01"
    assert out["xml"].endswith("at.xml")


def test_the_pose_is_the_adjusted_one_not_the_metadata_prior(tmp_path):
    out = bs.make_block(tmp_path)
    b = read_block(tmp_path / "at.xml")
    for p in b.aligned():
        R, C = out["poses"][p.id]
        assert np.allclose(p.rotation, R) and np.allclose(p.centre, C)


def test_focal_in_pixels_wins_over_millimetres(tmp_path):
    bs.make_block(tmp_path)
    xml = (tmp_path / "at.xml").read_text("utf-8")
    xml = xml.replace("<SensorSize>", "<FocalLengthPixels>512.5</FocalLengthPixels><SensorSize>")
    (tmp_path / "at.xml").write_text(xml, "utf-8")
    assert read_block(tmp_path / "at.xml").groups[0].focal_px == 512.5


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (("<BlocksExchange version=\"3.2\">", "<BlocksExchange version=\"2.1\">"), "version 3"),
        (("XRightYDown", "XRightYUp"), "XRightYDown"),
        (("<M_00>", "<Omega>1</Omega><M_00>"), "rotation matrices"),
        (("<SensorSize>6.4</SensorSize>", ""), "sensor size"),
        (("<AspectRatio>1</AspectRatio>", "<AspectRatio>1.1</AspectRatio>"), "aspect ratio"),
    ],
)
def test_what_this_build_cannot_place_is_refused_in_words(tmp_path, change, message):
    bs.make_block(tmp_path)
    p = tmp_path / "at.xml"
    p.write_text(p.read_text("utf-8").replace(*change), "utf-8")
    with pytest.raises(JobError, match=message):
        read_block(p)


def test_a_rotation_that_is_not_a_rotation_is_refused_with_the_photo(tmp_path):
    bs.make_block(tmp_path)
    p = tmp_path / "at.xml"
    xml = p.read_text("utf-8")
    start = xml.index("<M_00>") + len("<M_00>")
    p.write_text(xml[:start] + "3.0" + xml[xml.index("</M_00>"):], "utf-8")
    with pytest.raises(JobError, match="IMG_0001"):
        read_block(p)


def test_other_xml_is_not_a_block(tmp_path):
    other = tmp_path / "notes.xml"
    other.write_text('<?xml version="1.0"?><LandXML/>', "utf-8")
    assert not is_blocks_exchange(other)
    bs.make_block(tmp_path)
    assert is_blocks_exchange(tmp_path / "at.xml")
    with pytest.raises(JobError, match="not a BlocksExchange"):
        read_block(other)
```

- [ ] **Step 2: Run to verify they fail**

Run: `uv run --frozen --directory python pytest tests/test_bentley_blocks.py -q`
Expected: FAIL (`ModuleNotFoundError: aio_pipelines.bentley.blocks`).

- [ ] **Step 3: Implement**

Create `python/src/aio_pipelines/bentley/blocks.py`:

```python
"""BlocksExchange 3.x, the AT export of Bentley iTwin Capture Modeler (formerly ContextCapture).

What is read (data-conventions section 35): the SRS list and the block's ``SRSId``; per
photogroup the image size, the focal length (``FocalLengthPixels``, else ``FocalLength`` in mm
over ``SensorSize``, the sensor's largest side in mm), the principal point (pixels from the
top-left corner), the distortion ``K1 K2 K3 P1 P2`` as written, ``AspectRatio`` and ``Skew``;
per photo its ``ImagePath``, the adjusted pose (``Pose/Rotation`` ``M_ij``, world to camera with
x right, y down, z forward, and ``Pose/Center`` in the block SRS) and ``ExifData/DateTimeOriginal``.
``Pose/Metadata`` is the GNSS prior in another SRS and is never read. A photo without a rotation
or a centre is not aligned. Tie points and control points are not read.

Python's expat refuses entity expansion attacks and ElementTree resolves no external entities.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from ..runtime import JobError

MARKER = b"<BlocksExchange"
#: A block of tens of thousands of photos is a few hundred MB of XML.
MAX_XML_BYTES = 1024**3
ORIENTATION = "XRightYDown"
ANGLE_TAGS = ("Omega", "Phi", "Kappa", "Yaw", "Pitch", "Roll", "Heading")


@dataclass
class Srs:
    id: str
    name: str
    definition: str


@dataclass
class Photogroup:
    index: int
    name: str
    width: int
    height: int
    focal_px: float
    cx: float
    cy: float
    k: tuple[float, float, float]
    p: tuple[float, float]
    aspect: float
    skew: float


@dataclass
class BlockPhoto:
    id: str
    image_path: str
    group: int
    rotation: np.ndarray | None
    centre: np.ndarray | None
    taken: str | None


@dataclass
class Block:
    version: str
    name: str
    srs: Srs | None
    groups: list[Photogroup]
    photos: list[BlockPhoto]

    def aligned(self) -> list[BlockPhoto]:
        return [p for p in self.photos if p.rotation is not None and p.centre is not None]

    def unaligned(self) -> list[BlockPhoto]:
        return [p for p in self.photos if p.rotation is None or p.centre is None]


def is_blocks_exchange(path: Path) -> bool:
    try:
        with open(path, "rb") as f:
            return MARKER in f.read(4096)
    except OSError:
        return False


def _num(el: ET.Element, tag: str, what: str, default: float | None = None) -> float:
    v = el.findtext(tag)
    if v is None or not v.strip():
        if default is not None:
            return default
        raise JobError(f"{what} has no {tag}.")
    try:
        return float(v)
    except ValueError:
        raise JobError(f"{what}: {tag} is not a number ({v[:40]}).") from None


def _group(i: int, g: ET.Element) -> Photogroup:
    name = (g.findtext("Name") or f"Photogroup {i + 1}").strip()
    what = f'The photogroup "{name}"'
    orientation = (g.findtext("CameraOrientation") or ORIENTATION).strip()
    if orientation != ORIENTATION:
        raise JobError(f"{what} uses the camera orientation {orientation}; only {ORIENTATION} is read.")
    dims = g.find("ImageDimensions")
    if dims is None:
        raise JobError(f"{what} has no image size.")
    w, h = int(_num(dims, "Width", what)), int(_num(dims, "Height", what))
    if g.findtext("FocalLengthPixels"):
        focal = _num(g, "FocalLengthPixels", what)
    else:
        mm = _num(g, "FocalLength", what)
        if not (g.findtext("SensorSize") or "").strip():
            raise JobError(f"{what} gives its focal length in mm but no sensor size.")
        focal = mm * max(w, h) / _num(g, "SensorSize", what)
    pp = g.find("PrincipalPoint")
    cx = _num(pp, "x", what) if pp is not None else w / 2
    cy = _num(pp, "y", what) if pp is not None else h / 2
    d = g.find("Distortion")
    k = tuple(_num(d, t, what, 0.0) for t in ("K1", "K2", "K3")) if d is not None else (0.0, 0.0, 0.0)
    p = tuple(_num(d, t, what, 0.0) for t in ("P1", "P2")) if d is not None else (0.0, 0.0)
    aspect, skew = _num(g, "AspectRatio", what, 1.0), _num(g, "Skew", what, 0.0)
    if abs(aspect - 1) > 1e-6 or abs(skew) > 1e-6:
        raise JobError(f"{what} has an aspect ratio of {aspect} and a skew of {skew}; only 1 and 0 are read.")
    return Photogroup(i, name, w, h, focal, cx, cy, k, p, aspect, skew)  # type: ignore[arg-type]


def _pose(photo: ET.Element, label: str) -> tuple[np.ndarray | None, np.ndarray | None]:
    pose = photo.find("Pose")
    if pose is None:
        return None, None
    rot, cen = pose.find("Rotation"), pose.find("Center")  # direct children: never Metadata's
    R = None
    if rot is not None:
        if any(rot.find(t) is not None for t in ANGLE_TAGS):
            raise JobError(
                f"{label} gives its rotation as angles; export the block again with rotation matrices."
            )
        R = np.array([[_num(rot, f"M_{i}{j}", label) for j in range(3)] for i in range(3)])
        if not np.allclose(R @ R.T, np.eye(3), atol=1e-4) or abs(np.linalg.det(R) - 1) > 1e-4:
            raise JobError(f"{label}: its rotation matrix is not a rotation.")
    C = np.array([_num(cen, a, label) for a in "xyz"]) if cen is not None else None
    return R, C


def read_block(path: Path) -> Block:
    if path.stat().st_size > MAX_XML_BYTES:
        raise JobError(f"{path.name} is larger than 1 GB; it is not read.")
    try:
        root = ET.parse(path).getroot()
    except ET.ParseError as e:
        raise JobError(f"{path.name} is not well-formed XML: {e}") from None
    if root.tag != "BlocksExchange":
        raise JobError(f"{path.name} is not a BlocksExchange file (an AT export of Bentley iTwin Capture Modeler).")
    version = root.get("version") or ""
    if version.split(".")[0] != "3":
        raise JobError(f"{path.name} is BlocksExchange version {version or 'unknown'}; only version 3 is read.")
    srs_list = {
        (s.findtext("Id") or "").strip(): Srs(
            (s.findtext("Id") or "").strip(), (s.findtext("Name") or "").strip(), (s.findtext("Definition") or "").strip()
        )
        for s in root.findall("SpatialReferenceSystems/SRS")
    }
    blocks = root.findall("Block")
    if not blocks:
        raise JobError(f"{path.name} holds no block.")
    block = blocks[0]
    srs = srs_list.get((block.findtext("SRSId") or "").strip())
    groups: list[Photogroup] = []
    photos: list[BlockPhoto] = []
    for i, g in enumerate(block.findall("Photogroups/Photogroup")):
        group = _group(i, g)
        groups.append(group)
        for ph in g.findall("Photo"):
            image = (ph.findtext("ImagePath") or "").strip()
            pid = (ph.findtext("Id") or "").strip() or str(len(photos))
            R, C = _pose(ph, f'The photo {image.replace(chr(92), "/").rsplit("/", 1)[-1] or pid}')
            taken = (ph.findtext("ExifData/DateTimeOriginal") or "").strip() or None
            photos.append(BlockPhoto(pid, image, i, R, C, taken))
    return Block(version, (block.findtext("Name") or path.stem).strip(), srs, groups, photos)
```

- [ ] **Step 4: Run to verify they pass**

Run: `uv run --frozen --directory python pytest tests/test_bentley_blocks.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add python/src/aio_pipelines/bentley/__init__.py python/src/aio_pipelines/bentley/blocks.py python/tests/test_bentley_blocks.py
git commit -F <msg>   # feat(pipelines): read bentley blocksexchange at exports
```

---

### Task 4: Lens, frame and pose conversion

**Files:**

- Create: `python/src/aio_pipelines/bentley/convert.py`
- Create: `python/tests/test_bentley_convert.py`

**Interfaces:**

- Consumes: `Block`, `Photogroup`, `BlockPhoto` (Task 3); `opf.geometry`: `Lens`, `SceneFrame`, `FLIP`, `local_pose`, `opf_to_colmap`, `lens_to_colmap`, `project_crs`, `read_crs`; `photo.model`: `Camera`, `project_points`.
- Produces:

```python
TANGENTIAL_SWAP: bool = True
def lens_of(g: Photogroup) -> Lens                       # tangential in OpenCV order (p1, p2)
def lens_record(lens: Lens) -> dict[str, Any]            # pinhole + cx, cy, k1, k2, k3, p1, p2
def block_frame(block: Block, manifest: dict) -> SceneFrame
@dataclass
class Pose:
    pos: list[float]       # photos layer local frame
    q: list[float]         # three.js x, y, z, w
    qvec: list[float]      # COLMAP w, x, y, z, project CRS
    tvec: list[float]
    enh: np.ndarray        # project easting, northing, height
def camera_pose(photo: BlockPhoto, frame: SceneFrame, origin) -> Pose
```

- [ ] **Step 1: Write the failing tests**

Create `python/tests/test_bentley_convert.py`:

```python
"""bentley/convert.py: Bentley's lens and pose in our conventions (synthetic block, no client data)."""

import math

import numpy as np
import pytest

import bentley_synth as bs
from aio_pipelines.bentley.blocks import read_block
from aio_pipelines.bentley.convert import TANGENTIAL_SWAP, block_frame, camera_pose, lens_of, lens_record
from aio_pipelines.opf.geometry import lens_to_colmap, quat_wxyz_to_matrix
from aio_pipelines.photo.model import Camera, project_points
from aio_pipelines.runtime import JobError

MANIFEST = {"crs": {"epsg": bs.EPSG}, "origin": list(bs.ORIGIN)}


def _block(tmp_path, **kw):
    out = bs.make_block(tmp_path, **kw)
    return out, read_block(tmp_path / "at.xml")


def test_the_tangential_terms_are_swapped_into_opencv(tmp_path):
    _, b = _block(tmp_path)
    lens = lens_of(b.groups[0])
    assert TANGENTIAL_SWAP is True
    assert lens.tangential == (bs.P_BENTLEY[1], bs.P_BENTLEY[0])
    assert lens.radial == bs.K and (lens.cx, lens.cy) == bs.PP


def test_a_known_point_projects_where_bentley_puts_it(tmp_path):
    out, b = _block(tmp_path)
    frame = block_frame(b, MANIFEST)
    model, params = lens_to_colmap(lens_of(b.groups[0]))
    cam = Camera(1, model, bs.W, bs.H, np.array(params))
    pts = np.array([bs.TARGET, (bs.TARGET[0] + 3, bs.TARGET[1] - 2, 1.0), (bs.TARGET[0] - 4, bs.TARGET[1] + 1, 9.0)])
    for p in b.aligned():
        pose = camera_pose(p, frame, bs.ORIGIN)
        R = quat_wxyz_to_matrix(pose.qvec)
        C = -R.T @ np.asarray(pose.tvec)
        ours, _ = project_points(cam, R, C, pts)
        R_b, C_b = out["poses"][p.id]
        assert np.abs(ours - bs.bentley_project(R_b, C_b, pts)).max() < 1e-6


def test_the_pose_round_trips_and_the_camera_looks_at_the_target(tmp_path):
    out, b = _block(tmp_path)
    frame = block_frame(b, MANIFEST)
    for p in b.aligned():
        pose = camera_pose(p, frame, bs.ORIGIN)
        R_b, C_b = out["poses"][p.id]
        R = quat_wxyz_to_matrix(pose.qvec)
        assert np.allclose(R, R_b, atol=1e-9)
        assert np.allclose(-R.T @ np.asarray(pose.tvec), C_b, atol=1e-6)
        # local frame: x east, y up, z south; three.js cameras look along -z of q
        e, n, h = C_b
        assert pose.pos == pytest.approx([e - bs.ORIGIN[0], h - bs.ORIGIN[2], -(n - bs.ORIGIN[1])], abs=1e-4)
        x, y, z, w = pose.q
        look = quat_wxyz_to_matrix([w, x, y, z]) @ np.array([0.0, 0.0, -1.0])
        t = np.array([bs.TARGET[0] - e, bs.TARGET[2] - h, -(bs.TARGET[1] - n)])
        assert math.degrees(math.acos(look @ t / np.linalg.norm(t))) < 0.01


def test_a_block_in_another_utm_zone_turns_with_the_grid(tmp_path):
    out, b = _block(tmp_path, srs="EPSG:32640")  # the same numbers read as UTM 40N
    frame = block_frame(b, MANIFEST)  # project in UTM 39N
    p = b.aligned()[0]
    pose = camera_pose(p, frame, bs.ORIGIN)
    R_b, _ = out["poses"][p.id]
    turned = math.degrees(math.acos((np.trace(quat_wxyz_to_matrix(pose.qvec) @ R_b.T) - 1) / 2))
    assert 0.5 < turned < 6.0  # grid convergence between the zones, a few degrees
    assert abs(pose.enh[0] - 500000) > 1000  # positions reprojected, not copied


@pytest.mark.parametrize("srs", ["WGS84", "EPSG:4326", "ENU:24.2,54.6", ""])
def test_a_block_without_a_projected_epsg_srs_is_refused(tmp_path, srs):
    _, b = _block(tmp_path, srs=srs)
    with pytest.raises(JobError, match="projected"):
        block_frame(b, MANIFEST)


def test_the_layer_lens_keeps_the_principal_point_and_distortion(tmp_path):
    _, b = _block(tmp_path)
    rec = lens_record(lens_of(b.groups[0]))
    assert rec["model"] == "pinhole" and rec["aspect"] == pytest.approx(bs.W / bs.H, abs=1e-6)
    assert rec["hfovDeg"] == pytest.approx(math.degrees(2 * math.atan(bs.W / (2 * bs.FOCAL_PX))), abs=1e-5)
    assert (rec["cx"], rec["cy"]) == bs.PP
    assert (rec["k1"], rec["k2"], rec["k3"]) == bs.K
    assert (rec["p1"], rec["p2"]) == (bs.P_BENTLEY[1], bs.P_BENTLEY[0])
```

- [ ] **Step 2: Run to verify they fail**

Run: `uv run --frozen --directory python pytest tests/test_bentley_convert.py -q`
Expected: FAIL (`ModuleNotFoundError: aio_pipelines.bentley.convert`).

- [ ] **Step 3: Implement**

Create `python/src/aio_pipelines/bentley/convert.py`:

```python
"""Bentley's camera model and poses in Quadrion AI's conventions (data-conventions 1, 21, 35).

- **Rotation**: BlocksExchange ``M`` maps the block SRS to the camera, camera axes x right,
  y down, z forward: COLMAP's own convention, so ``R_colmap = M`` (``x_cam = M (X - C)``). The
  photos layer's camera frame (three.js: x right, y up, looking along -z) is ``M.T @ FLIP``.
- **Frame**: the block SRS must be a projected CRS with an EPSG code. It is read through
  ``opf.geometry.SceneFrame`` with a zero shift and a unit scale, so a block in another CRS than
  the project is reprojected horizontally and its camera axes turn with the grid, exactly as
  ``opf.import`` does; heights are used as they are.
- **Lens**: focal and principal point in pixels; Bentley's Brown model on normalised
  coordinates. Its tangential terms are in the other order from OpenCV's (``TANGENTIAL_SWAP``).
"""

from __future__ import annotations

from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any

import numpy as np

from ..opf.geometry import FLIP, Lens, SceneFrame, local_pose, opf_to_colmap, project_crs, read_crs
from ..runtime import JobError
from .blocks import Block, BlockPhoto, Photogroup

#: Bentley writes ``x_d = x(1 + K1 r² + K2 r⁴ + K3 r⁶) + P1 (r² + 2x²) + 2 P2 x y``: its P1 is
#: OpenCV's p2 and its P2 OpenCV's p1. Confirmed only against tie points (plan Task 12).
TANGENTIAL_SWAP = True


def lens_of(g: Photogroup) -> Lens:
    p1, p2 = (g.p[1], g.p[0]) if TANGENTIAL_SWAP else g.p
    return Lens(g.width, g.height, g.focal_px, g.cx, g.cy, g.k, (p1, p2))


def lens_record(lens: Lens) -> dict[str, Any]:
    """The photos layer's ``lens``: the pinhole model plus the principal point and distortion."""
    k1, k2, k3 = lens.radial
    p1, p2 = lens.tangential
    return {**lens.pinhole(), "cx": lens.cx, "cy": lens.cy, "k1": k1, "k2": k2, "k3": k3, "p1": p1, "p2": p2}


def block_frame(block: Block, manifest: dict[str, Any]) -> SceneFrame:
    definition = block.srs.definition if block.srs else ""
    info = read_crs(definition) if definition.upper().startswith("EPSG:") else None
    if info is None or info.arbitrary or info.horizontal is None or not info.horizontal.is_projected:
        raise JobError(
            f"The block's SRS ({definition or 'none'}) is not a projected CRS with an EPSG code. "
            "Export the AT again in a projected CRS, such as the project's UTM zone."
        )
    srf = SimpleNamespace(
        crs=SimpleNamespace(definition=definition),
        base_to_canonical=SimpleNamespace(shift=(0.0, 0.0, 0.0), scale=(1.0, 1.0, 1.0), swap_xy=False),
    )
    origin = [float(v) for v in (manifest.get("origin") or [0, 0, 0])]
    return SceneFrame(srf, project_crs(manifest), origin)


@dataclass
class Pose:
    pos: list[float]
    q: list[float]
    qvec: list[float]
    tvec: list[float]
    enh: np.ndarray


def camera_pose(photo: BlockPhoto, frame: SceneFrame, origin) -> Pose:
    if photo.rotation is None or photo.centre is None:
        raise JobError(f"The photo {photo.id} is not aligned.")
    enh = frame.to_project(photo.centre)[0]
    r_enu = frame.axes_at(photo.centre) @ (photo.rotation.T @ FLIP)
    pos, q = local_pose(r_enu, enh, origin)
    qvec, tvec = opf_to_colmap(r_enu, enh)
    return Pose(pos, q, qvec, tvec, enh)
```

Note: `SceneFrame` reads the projected CRS's axis order (`north_first`); UTM is easting first. If `rasterio`'s `CRS` lacks `is_projected` in the pinned version, use `info.horizontal.is_geographic is False`.

- [ ] **Step 4: Run to verify they pass**

Run: `uv run --frozen --directory python pytest tests/test_bentley_convert.py -q`
Expected: all pass. If `test_a_block_in_another_utm_zone_turns_with_the_grid` fails on the bound, print `turned` and the position: the synthetic centres read as UTM 40N land about 600 km west of the 39N origin; widen the bound only if the value is a plausible convergence (under 10 degrees) and say so in the commit body.

- [ ] **Step 5: Commit**

```bash
git add python/src/aio_pipelines/bentley/convert.py python/tests/test_bentley_convert.py
git commit -F <msg>   # feat(pipelines): bentley lens and poses in the project frame
```

---

### Task 5: Photo matching

**Files:**

- Create: `python/src/aio_pipelines/bentley/match.py`
- Create: `python/tests/test_bentley_match.py`

**Interfaces:**

- Consumes: nothing (plain files under `tmp_path`).
- Produces:

```python
@dataclass
class Matching:
    found: dict[str, Path]          # block photo id -> file
    missing: list[str]              # block photo ids not found (file names in `names`)
    ambiguous: list[str]            # block photo ids with several candidates (also counted missing)
    names: dict[str, str]           # block photo id -> file name from ImagePath
def file_name(image_path: str) -> str
def match_photos(paths: dict[str, str], root: Path, check: Callable[[], None] = lambda: None) -> Matching
def photo_id(name: str, taken: set[str]) -> str   # the layer's photo id, as opf.reader._photo_id
```

- [ ] **Step 1: Write the failing tests**

Create `python/tests/test_bentley_match.py`:

```python
"""bentley/match.py: photos found by file name under the chosen folder."""

from aio_pipelines.bentley.match import file_name, match_photos, photo_id


def _files(root, *rels):
    for r in rels:
        p = root / r
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"\xff\xd8\xff")


def test_case_and_drive_do_not_matter(tmp_path):
    _files(tmp_path, "Mapping/Orbit/cam_0001_v.jpg")
    m = match_photos({"0": "R:/RAW/Job/Mapping/Orbit/CAM_0001_V.JPG"}, tmp_path)
    assert m.found == {"0": tmp_path / "Mapping/Orbit/cam_0001_v.jpg"} and m.missing == []


def test_duplicates_are_told_apart_by_their_folder(tmp_path):
    _files(tmp_path, "flight-a/IMG_1.JPG", "flight-b/IMG_1.JPG")
    m = match_photos({"0": "R:/x/flight-a/IMG_1.JPG", "1": "R:/x/flight-b/IMG_1.JPG"}, tmp_path)
    assert m.found["0"].parent.name == "flight-a" and m.found["1"].parent.name == "flight-b"


def test_a_name_matched_twice_is_ambiguous_and_missing(tmp_path):
    _files(tmp_path, "a/IMG_1.JPG", "b/IMG_1.JPG")
    m = match_photos({"0": "R:/x/c/IMG_1.JPG"}, tmp_path)
    assert m.found == {} and m.missing == ["0"] and m.ambiguous == ["0"]


def test_missing_photos_are_listed_and_backslashes_split(tmp_path):
    _files(tmp_path, "IMG_2.JPG")
    m = match_photos({"0": "R:\\x\\IMG_1.JPG", "1": "R:\\x\\IMG_2.JPG"}, tmp_path)
    assert m.missing == ["0"] and set(m.found) == {"1"} and m.names["0"] == "IMG_1.JPG"
    assert file_name("R:\\a\\b.JPG") == "b.JPG"


def test_one_file_is_never_given_to_two_photos(tmp_path):
    _files(tmp_path, "IMG_1.JPG")
    m = match_photos({"0": "R:/a/IMG_1.JPG", "1": "R:/b/IMG_1.JPG"}, tmp_path)
    assert list(m.found) == ["0"] and m.missing == ["1"]


def test_photo_ids_are_safe_and_unique():
    taken: set[str] = set()
    assert photo_id("CAM_0001_V.JPG", taken) == "CAM_0001_V"
    assert photo_id("CAM_0001_V.jpg", taken) == "CAM_0001_V-2"
    assert photo_id("__.jpg", taken) == "photo"
```

- [ ] **Step 2: Run to verify they fail**

Run: `uv run --frozen --directory python pytest tests/test_bentley_match.py -q`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

Create `python/src/aio_pipelines/bentley/match.py`:

```python
"""Photos of a Bentley block found in the folder the person chose.

``ImagePath`` names a drive of the computer that ran the AT (``R:/...``), so photos are matched
by file name, without case, anywhere under the chosen folder. Several files of one name are told
apart by the last two path segments (the photo's folder and name); still ambiguous counts as
missing. A file is given to one photo only. Symbolic links are not followed.
"""

from __future__ import annotations

import os
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class Matching:
    found: dict[str, Path] = field(default_factory=dict)
    missing: list[str] = field(default_factory=list)
    ambiguous: list[str] = field(default_factory=list)
    names: dict[str, str] = field(default_factory=dict)


def _parts(image_path: str) -> list[str]:
    return [p for p in re.split(r"[\\/]+", image_path.strip()) if p]


def file_name(image_path: str) -> str:
    parts = _parts(image_path)
    return parts[-1] if parts else ""


def _index(root: Path, check: Callable[[], None]) -> dict[str, list[Path]]:
    out: dict[str, list[Path]] = {}
    for n, (folder, _dirs, files) in enumerate(os.walk(root, followlinks=False)):
        if n % 200 == 0:
            check()
        for f in files:
            out.setdefault(f.lower(), []).append(Path(folder) / f)
    return out


def _tail(parts: list[str]) -> str:
    return "/".join(parts[-2:]).lower()


def match_photos(paths: dict[str, str], root: Path, check: Callable[[], None] = lambda: None) -> Matching:
    index = _index(root, check)
    m = Matching()
    used: set[Path] = set()
    for pid, image_path in paths.items():
        parts = _parts(image_path)
        m.names[pid] = parts[-1] if parts else ""
        cands = [c for c in index.get(m.names[pid].lower(), []) if c not in used]
        if len(cands) > 1:
            want = _tail(parts)
            cands = [c for c in cands if _tail(list(c.relative_to(root).parts)) == want]
            if len(cands) != 1:
                m.ambiguous.append(pid)
                m.missing.append(pid)
                continue
        if not cands:
            m.missing.append(pid)
            continue
        m.found[pid] = cands[0]
        used.add(cands[0])
    return m


def photo_id(name: str, taken: set[str]) -> str:
    """A photos layer id from a file name: letters, digits, ``_`` and ``-``, unique in ``taken``."""
    stem = re.sub(r"[^A-Za-z0-9_-]+", "-", Path(name).stem).strip("-_")[:60] or "photo"
    if not stem[0].isalnum():
        stem = f"p{stem}"
    out, n = stem, 2
    while out in taken:
        out, n = f"{stem}-{n}", n + 1
    taken.add(out)
    return out
```

- [ ] **Step 4: Run to verify they pass**

Run: `uv run --frozen --directory python pytest tests/test_bentley_match.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add python/src/aio_pipelines/bentley/match.py python/tests/test_bentley_match.py
git commit -F <msg>   # feat(pipelines): match bentley photos by file name
```

---

### Task 6: The `bentley.import` job

**Files:**

- Create: `python/src/aio_pipelines/captures.py`, `python/tests/test_captures.py`
- Create: `python/src/aio_pipelines/bentley/importer.py`, `python/tests/test_bentley_import.py`
- Modify: `python/src/aio_pipelines/pipelines.py:20-21` (import), `:69-70` (register `BentleyImport()` after `OpfExport()`)

**Interfaces:**

- Consumes: Tasks 3, 4, 5; `opf.importer`: `write_run_sparse(folder, model, manifest, plan)`, `read_manifest(project)`, `uniq(base, taken)`, `SPARSE_FILES`, `REVIEW_EDGE`; `opf.colmap`: `Model`, `Camera`, `Image`; `opf.geometry.lens_to_colmap`; `aik.cameras.review_copy(src, dest, long_edge) -> (w, h)`; runtime helpers.
- Produces: `captures.capture_for_date(manifest: dict, date: str) -> str` (mutates `manifest["captures"]`); `class BentleyImport` with `name = "bentley.import"`, steps `read`, `photos`, `commit`; the commit returns `{"run", "photosLayer", "photos", "missing", "unaligned", "capture", "runFile"}`.

- [ ] **Step 1: Write the failing capture test**

Create `python/tests/test_captures.py`:

```python
"""captures.py: a survey date found or added as the app's captureForDate does."""

import pytest

from aio_pipelines.captures import capture_for_date


def test_an_existing_date_is_found_and_a_new_one_added_in_date_order():
    m = {"captures": [{"id": "capture-2026-03-09", "label": "Survey", "date": "2026-03-09"}]}
    assert capture_for_date(m, "2026-03-09") == "capture-2026-03-09"
    assert capture_for_date(m, "2026-03-04") == "capture-2026-03-04"
    assert [c["date"] for c in m["captures"]] == ["2026-03-04", "2026-03-09"]
    assert m["captures"][0] == {"id": "capture-2026-03-04", "label": "Survey", "date": "2026-03-04"}


def test_a_taken_id_gets_a_suffix_and_a_bad_date_is_refused():
    m = {"captures": [{"id": "capture-2026-03-04", "label": "Old", "date": "2026-01-01"}]}
    assert capture_for_date(m, "2026-03-04") == "capture-2026-03-04-2"
    with pytest.raises(ValueError):
        capture_for_date({}, "4 March")
```

- [ ] **Step 2: Implement `captures.py`**

```python
"""Survey dates (manifest ``captures``) from a pipeline, as ``captureForDate`` in
``packages/project/src/builder/create.ts`` makes them: the first capture with that date, or a new
``capture-<date>`` (``-2``, ``-3`` when taken) labelled ``Survey``, kept in date order."""

from __future__ import annotations

import re
from typing import Any


def capture_for_date(manifest: dict[str, Any], date: str) -> str:
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        raise ValueError(f'"{date}" is not a date (YYYY-MM-DD).')
    caps = manifest.setdefault("captures", [])
    for c in caps:
        if isinstance(c, dict) and c.get("date") == date:
            return str(c["id"])
    taken = {str(c.get("id")) for c in caps if isinstance(c, dict)}
    base = f"capture-{date}"
    cid, n = base, 2
    while cid in taken:
        cid, n = f"{base}-{n}", n + 1
    caps.append({"id": cid, "label": "Survey", "date": date})
    caps.sort(key=lambda c: str(c.get("date", "")) if isinstance(c, dict) else "")
    return cid
```

Run: `uv run --frozen --directory python pytest tests/test_captures.py -q` → 2 passed.

- [ ] **Step 3: Write the failing job tests**

Create `python/tests/test_bentley_import.py`:

```python
"""bentley.import on the synthetic block (no client data)."""

import json
import shutil

import pytest

import bentley_synth as bs
from aio_pipelines.bentley.importer import BentleyImport
from aio_pipelines.pipelines import all_pipelines
from aio_pipelines.runtime import JobError
from conftest import run_job


def _setup(tmp_path):
    root = bs.make_project(tmp_path / "proj")
    out = bs.make_block(tmp_path / "bentley")
    return root, out


def _manifest(root):
    return json.loads((root / "manifest.json").read_text("utf-8"))


def test_it_is_registered_and_checks_its_parameters(tmp_path):
    assert isinstance(all_pipelines()["bentley.import"], BentleyImport)
    p = BentleyImport()
    xml, photos = str(tmp_path / "at.xml"), str(tmp_path / "photos")
    assert p.validate({"xml": xml, "photos": photos}) == {"xml": xml, "photos": photos}
    assert p.validate({"xml": xml, "photos": photos, "name": " Mast "})["name"] == "Mast"
    with pytest.raises(JobError, match="does not take: bogus"):
        p.validate({"xml": xml, "photos": photos, "bogus": 1})
    with pytest.raises(JobError, match=r"\.xml"):
        p.validate({"xml": str(tmp_path / "at.opf"), "photos": photos})
    with pytest.raises(JobError):
        p.validate({"xml": xml})


def test_the_block_comes_in_as_a_run_and_a_photos_layer_placed_by_pose(tmp_path):
    root, out = _setup(tmp_path)
    result, _ = run_job(BentleyImport(), root, {"xml": out["xml"], "photos": out["photos"]})
    assert result["status"] == "done", result
    m = _manifest(root)
    (layer,) = [x for x in m["layers"] if x["kind"] == "photos"]
    assert layer["name"] == "at.xml photos"
    assert len(layer["items"]) == 3
    assert m["captures"] == [{"id": "capture-2026-03-04", "label": "Survey", "date": "2026-03-04"}]
    assert layer["capture"] == "capture-2026-03-04"
    for item in layer["items"]:
        assert len(item["pos"]) == 3 and len(item["q"]) == 4 and "takenAt" not in item
        assert item["lens"]["model"] == "pinhole" and item["lens"]["cx"] == bs.PP[0]
        assert (root / item["src"]["path"]).is_file()
    run_id = layer["id"].removeprefix("photos-")
    assert run_id.startswith("bentley-")
    run_dir = root / "photogrammetry" / run_id
    run = json.loads((run_dir / "run.json").read_text("utf-8"))
    assert run["status"] == "aligned" and run["capture"] == "capture-2026-03-04"
    assert run["photos"]["count"] == 4 and run["photos"]["registered"] == 3
    assert run["settings"]["bentley"]["xml"] == "at.xml"
    assert run["outputs"]["layers"] == [layer["id"]]
    assert {r["reason"] for r in run["photos"]["rejected"]} == {"not aligned in the block"}
    for f in ("cameras.txt", "images.txt", "points3D.txt", "frame.json", "photos.json"):
        assert (run_dir / "sparse" / f).is_file()
    cams = (run_dir / "sparse" / "cameras.txt").read_text("utf-8")
    assert "FULL_OPENCV 640 480" in cams
    report = json.loads((run_dir / "report" / "bentley-import.json").read_text("utf-8"))
    assert report["imported"] == {"photos": 3, "missing": 0, "unaligned": 1, "layer": layer["id"]}


def test_missing_photos_are_left_out_and_listed(tmp_path):
    root, out = _setup(tmp_path)
    shutil.rmtree(tmp_path / "bentley" / "photos" / "flight-b")
    result, rec = run_job(BentleyImport(), root, {"xml": out["xml"], "photos": out["photos"]})
    assert result["status"] == "done"
    (layer,) = [x for x in _manifest(root)["layers"] if x["kind"] == "photos"]
    assert len(layer["items"]) == 2
    assert any("IMG_0003.JPG" in line for line in rec.log_lines())


def test_no_photo_found_fails_in_words(tmp_path):
    root, out = _setup(tmp_path)
    empty = tmp_path / "empty"
    empty.mkdir()
    result, _ = run_job(BentleyImport(), root, {"xml": out["xml"], "photos": str(empty)})
    assert result["status"] == "failed" and "None of the 3" in result["error"]
    assert not [x for x in _manifest(root)["layers"] if x["kind"] == "photos"]


def test_a_commit_run_twice_adds_one_layer_and_one_capture(tmp_path):
    from aio_pipelines.bentley import importer

    root, out = _setup(tmp_path)
    calls = {"n": 0}
    real = importer._commit

    def twice(ctx, plan, params):
        calls["n"] += 1
        real(ctx, plan, params)
        return real(ctx, plan, params)

    importer._commit = twice
    try:
        result, _ = run_job(BentleyImport(), root, {"xml": out["xml"], "photos": out["photos"]})
    finally:
        importer._commit = real
    assert result["status"] == "done" and calls["n"] == 1
    m = _manifest(root)
    assert len([x for x in m["layers"] if x["kind"] == "photos"]) == 1 and len(m["captures"]) == 1
```

`rec.log_lines()`: if `conftest.Recorder` has no such helper, read the log lines the way `test_opf.py` does (search it for `rec.of("log")`) and adapt the one assertion.

- [ ] **Step 4: Run to verify they fail**

Run: `uv run --frozen --directory python pytest tests/test_bentley_import.py -q`
Expected: FAIL (module missing).

- [ ] **Step 5: Implement the job**

Create `python/src/aio_pipelines/bentley/importer.py`:

```python
"""bentley.import: a BlocksExchange AT export and its photos into the open project.

Parameters as ``BentleyImportParams`` in ``@aio/schema``: ``xml`` (the AT export, read only),
``photos`` (the folder holding its photos, searched with its subfolders, read only) and ``name``
(the photos layer's name; default the XML file's name plus "photos").

What comes in (data-conventions section 35, the same shapes as ``opf.import``, section 21):

- a **processing run** ``photogrammetry/<run>/``: ``run.json`` (``aio.photo-run/1``, status
  ``aligned``, ``settings.bentley``), ``sparse/`` (COLMAP text in the grid frame, cameras as
  ``OPENCV``/``FULL_OPENCV`` with Bentley's intrinsics, no tie points), ``frame.json``,
  ``photos.json`` (the originals, read in place) and ``report/bentley-import.json``;
- a **photos layer** of 2560 px review copies (``photos/<run>/``) placed by the calibrated poses
  (``pos``, ``q``, ``lens`` with the principal point and distortion), its ``capture`` the
  earliest ``DateTimeOriginal`` date of the matched photos.

Photos not found, ambiguous or not aligned are left out and listed. The manifest is written
last, with ``manifest.json.bak``.
"""

from __future__ import annotations

import json
import shutil
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .. import __version__
from ..params import known_keys, text
from ..runtime import JobError, Step, StepContext, atomic_write_json, commit_files, now_iso, replace_over, safe_project_path

#: Photos named one by one in the job log, at most.
LOG_NAMES = 200


def plan_import(block, frame, manifest: dict[str, Any], matching, name: str, root: Path):
    """The import as data (``plan.json``) and the sparse model, from a parsed block."""
    import numpy as np

    from ..opf import colmap
    from ..opf.geometry import lens_to_colmap
    from .convert import camera_pose, lens_of, lens_record
    from .match import photo_id

    origin = [float(v) for v in (manifest.get("origin") or [0, 0, 0])]
    lenses = {g.index: lens_of(g) for g in block.groups}
    model = colmap.Model()
    for g in block.groups:
        cmodel, params = lens_to_colmap(lenses[g.index])
        model.cameras[g.index + 1] = colmap.Camera(g.index + 1, cmodel, g.width, g.height, params)
    taken: set[str] = set()
    photos: list[dict[str, Any]] = []
    dates: list[str] = []
    for p in block.aligned():
        f = matching.found.get(p.id)
        if f is None:
            continue
        pose = camera_pose(p, frame, origin)
        g = block.groups[p.group]
        key = f.relative_to(root).as_posix()  # the photo key: model image name, photos.json key
        rec = {
            "id": photo_id(f.name, taken),
            "name": key,
            "fileName": f.name,
            "file": str(f),
            "size": [g.width, g.height],
            "pos": pose.pos,
            "q": pose.q,
            "lens": lens_record(lenses[p.group]),
            "group": p.group,
        }
        photos.append(rec)
        iid = len(model.images) + 1
        model.images[iid] = colmap.Image(iid, pose.qvec, pose.tvec, p.group + 1, key)
        if p.taken and len(p.taken) >= 10:
            dates.append(p.taken[:10])
    model.xyz = np.zeros((0, 3))
    rejected = [{"name": matching.names.get(i, i), "reason": "not found in the photos folder"} for i in matching.missing if i not in matching.ambiguous]
    rejected += [{"name": matching.names.get(i, i), "reason": "several photos of this name in the photos folder"} for i in matching.ambiguous]
    rejected += [{"name": Path(p.image_path.replace("\\", "/")).name or p.id, "reason": "not aligned in the block"} for p in block.unaligned()]
    groups = [
        {
            "id": f"photogroup-{g.index + 1}",
            "model": g.name[:120],
            "widthPx": g.width,
            "heightPx": g.height,
            "photos": sum(1 for p in photos if p["group"] == g.index),
            "calibration": lens_to_colmap(lenses[g.index])[0],
        }
        for g in block.groups
    ]
    plan = {
        "name": name,
        "version": block.version,
        "photos": photos,
        "rejected": rejected,
        "groups": groups,
        "date": min(dates) if dates else None,
        "warnings": frame.notes,
        "summary": {
            "photos": len(block.photos),
            "aligned": len(block.aligned()),
            "matched": len(photos),
            "missing": len(matching.missing),
            "unaligned": len(block.unaligned()),
        },
    }
    return plan, model


class BentleyImport:
    name = "bentley.import"
    title = "Bentley import"
    description = (
        "A Bentley iTwin Capture Modeler (ContextCapture) AT export with its photos: "
        "a run and a photos layer placed by the calibrated poses."
    )
    keys = frozenset({"xml", "photos", "name"})

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        known_keys(params, set(self.keys), self.name)
        xml = text(params, "xml", required=True)
        photos = text(params, "photos", required=True)
        assert xml is not None and photos is not None
        if Path(xml).suffix.lower() != ".xml":
            raise JobError(f'"{Path(xml).name}" is not an AT export. Choose the .xml file Bentley exported.')
        out: dict[str, Any] = {"xml": xml, "photos": photos}
        name = text(params, "name")
        if name is not None:
            name = name.strip()
            if not 1 <= len(name) <= 120:
                raise JobError("name must be 1 to 120 characters.")
            out["name"] = name
        return out

    def inputs(self, params: dict[str, Any]) -> list[str]:
        return [params["xml"], params["photos"]]

    def plan(self, params: dict[str, Any]) -> list[Step]:
        def load_plan(ctx: StepContext) -> dict[str, Any]:
            return json.loads(ctx.stage("plan.json").read_text("utf-8"))

        def read(ctx: StepContext) -> dict[str, Any]:
            from ..opf.importer import read_manifest, uniq, write_run_sparse
            from .blocks import read_block
            from .convert import block_frame
            from .match import match_photos

            xml = ctx.input(params["xml"])
            root = ctx.input(params["photos"]).resolve()
            if not root.is_dir():
                raise JobError(f'The photos folder "{params["photos"]}" is not a folder.')
            block = read_block(xml)
            manifest = read_manifest(ctx.project)
            frame = block_frame(block, manifest)
            aligned = block.aligned()
            if not aligned:
                raise JobError(f"{xml.name} has no aligned photos: run the aerotriangulation, then export again.")
            ctx.progress(0.2, "Finding the photos")
            matching = match_photos({p.id: p.image_path for p in aligned}, root, ctx.check)
            if not matching.found:
                raise JobError(
                    f"None of the {len(aligned)} aligned photos of {xml.name} were found in {root}. "
                    "Choose the folder that holds them (subfolders are searched)."
                )
            name = params.get("name") or f"{xml.name} photos"
            plan, model = plan_import(block, frame, manifest, matching, name, root)
            runs = ctx.project / "photogrammetry"
            taken = {p.name for p in runs.iterdir()} if runs.is_dir() else set()
            run = uniq(f"bentley-{datetime.now(UTC).strftime('%Y%m%d-%H%M')}", taken)
            plan["root"] = str(root)
            write_run_sparse(ctx.stage("run/sparse/.keep").parent, model, manifest, plan)
            atomic_write_json(ctx.stage("plan.json"), plan, indent=None)
            s = plan["summary"]
            ctx.log(
                f"{xml.name}: {s['photos']} photos, {s['aligned']} aligned, {s['matched']} found, "
                f"{s['missing']} not found, {s['unaligned']} not aligned."
            )
            for r in plan["rejected"][:LOG_NAMES]:
                ctx.log(f"Left out: {r['name']} ({r['reason']}).", "warn")
            if len(plan["rejected"]) > LOG_NAMES:
                ctx.log(f"And {len(plan['rejected']) - LOG_NAMES} more photos left out.", "warn")
            for w in plan["warnings"]:
                ctx.log(w, "warn")
            return {"run": run, **s}

        def photos(ctx: StepContext) -> dict[str, Any]:
            from ..aik.cameras import review_copy
            from ..opf.importer import REVIEW_EDGE

            plan = load_plan(ctx)
            failed = []
            todo = plan["photos"]
            for i, p in enumerate(todo):
                ctx.check()
                dest = ctx.stage(f"photos/{p['id']}.jpg")
                if not dest.exists():
                    tmp = dest.with_name(f".{dest.stem}.tmp.jpg")
                    try:
                        review_copy(Path(p["file"]), tmp, REVIEW_EDGE)
                        replace_over(tmp, dest)
                    except Exception as e:  # one unreadable photo is left out, never the import
                        tmp.unlink(missing_ok=True)
                        failed.append({"name": p["name"], "reason": f"could not be read: {e}"[:300]})  # name: the key
                        continue
                ctx.progress((i + 1) / max(1, len(todo)), f"Review copies {i + 1} of {len(todo)}")
            atomic_write_json(ctx.stage("photos-failed.json"), failed)
            if failed:
                ctx.log(f"{len(failed)} photos could not be read and are left out.", "warn")
            return {"copies": len(todo) - len(failed), "failed": len(failed)}

        def commit(ctx: StepContext) -> dict[str, Any]:
            return _commit(ctx, load_plan(ctx), params)

        return [
            Step("read", "Read the block and find the photos", read, weight=2),
            Step("photos", "Make review copies of the photos", photos, weight=6),
            Step("commit", "Add the run and the photos layer to the project", commit, weight=0.5),
        ]


def _commit(ctx: StepContext, plan: dict[str, Any], params: dict[str, Any]) -> dict[str, Any]:
    from ..captures import capture_for_date
    from ..opf.importer import SPARSE_FILES, read_manifest, uniq

    run = ctx.outputs("read")["run"]
    run_dir = f"photogrammetry/{run}"
    failed = json.loads(ctx.stage("photos-failed.json").read_text("utf-8"))
    failed_names = {f["name"] for f in failed}
    mpath = safe_project_path(ctx.project, "manifest.json")
    manifest = read_manifest(ctx.project)
    layers = manifest.setdefault("layers", [])
    # a commit that runs again replaces its own layer (named after the run), never adds a second
    layers[:] = [x for x in layers if not (isinstance(x, dict) and str(x.get("id", "")).startswith(f"photos-{run}"))]
    taken = {str(x.get("id")) for x in layers if isinstance(x, dict)}
    capture = capture_for_date(manifest, plan["date"]) if plan.get("date") else None

    moves = [(f"run/sparse/{n}", f"{run_dir}/sparse/{n}") for n in SPARSE_FILES]
    items = []
    for p in plan["photos"]:
        if p["name"] in failed_names:
            continue
        rel = f"photos/{run}/{p['id']}.jpg"
        moves.append((f"photos/{p['id']}.jpg", rel))
        items.append({"id": p["id"], "src": {"path": rel}, "pos": p["pos"], "q": p["q"], "lens": p["lens"]})
    layer_id = uniq(f"photos-{run}", taken)
    layer = {
        "kind": "photos",
        "id": layer_id,
        "name": plan["name"],
        "visible": True,
        **({"capture": capture} if capture else {}),
        "items": items,
    }
    rejected = plan["rejected"] + failed
    run_json = {
        "schema": "aio.photo-run/1",
        "id": run,
        "createdAt": now_iso(),
        "updatedAt": now_iso(),
        "status": "aligned",
        "preset": "standard",
        "photos": {
            "source": {"folders": [plan["root"]]},
            "count": plan["summary"]["photos"],
            "registered": len(items),
            "rejected": rejected[:100_000],
        },
        "cameras": [{k: v for k, v in g.items()} for g in plan["groups"]],
        "crs": manifest.get("crs"),
        **({"capture": capture} if capture else {}),
        "settings": {"bentley": {"xml": Path(params["xml"]).name, "photos": plan["root"], "version": plan["version"]}},
        "stages": [
            {"name": "inspect", "state": "done", "message": "Read from the Bentley block"},
            {"name": "sfm", "state": "done", "message": f"Calibration imported from Bentley (BlocksExchange {plan['version']})"},
            {"name": "commit", "state": "done"},
        ],
        "outputs": {"layers": [layer_id], "tilesets": [], "files": [f"{run_dir}/sparse/{n}" for n in SPARSE_FILES]},
        "versions": {"pack": __version__, "blocksExchange": plan["version"]},
        "warnings": [w[:500] for w in plan["warnings"]][:1000],
    }
    report = {
        "run": run,
        "src": Path(params["xml"]).name,
        "createdAt": now_iso(),
        "imported": {
            "photos": len(items),
            "missing": plan["summary"]["missing"],
            "unaligned": plan["summary"]["unaligned"],
            "layer": layer_id,
        },
        "skipped": rejected[:100_000],
        "warnings": plan["warnings"],
    }
    atomic_write_json(ctx.stage("run/report/bentley-import.json"), report)
    moves.append(("run/report/bentley-import.json", f"{run_dir}/report/bentley-import.json"))
    commit_files(ctx, moves, announce=False)
    atomic_write_json(ctx.stage("run/run.json"), run_json)
    commit_files(ctx, [("run/run.json", f"{run_dir}/run.json")])
    layers.append(layer)
    shutil.copyfile(mpath, mpath.with_name("manifest.json.bak"))
    atomic_write_json(mpath, manifest, indent=2)
    ctx.artifact("manifest.json")
    ctx.log(f"Run {run}: {len(items)} photos placed in layer {layer_id}.")
    return {
        "run": run,
        "photosLayer": layer_id,
        "photos": len(items),
        "missing": plan["summary"]["missing"],
        "unaligned": plan["summary"]["unaligned"],
        "capture": capture,
        "runFile": f"{run_dir}/run.json",
    }
```

The photo key (`rec["name"]`, the COLMAP image name and the `photos.json` key that `write_run_sparse` writes from `p["name"]`) is the photo's path below the chosen folder, as a folder run keys its photos (section 21). Two details to check against the real helpers while implementing:

- `write_run_sparse` makes `imageRoot` the deepest folder common to the found photos and each `name` relative to it; check with the synthetic block that `photos.json` resolves all three originals, and add that assertion to `test_the_block_comes_in_as_a_run_and_a_photos_layer_placed_by_pose`: `doc = json.loads((run_dir / "sparse" / "photos.json").read_text("utf-8"))`, then every `Path(doc["imageRoot"], v["name"])` is a file.
- `commit_files` with a staged file that is already committed (a commit run twice): check how `opf.importer._commit` survives it (`test_opf.py` has a re-run case); if a second `commit_files` of the same moves fails because the staged file is gone, make the second call tolerate a missing staged source whose destination exists, inside `_commit` (not in the runtime).

In `python/src/aio_pipelines/pipelines.py` add `from .bentley.importer import BentleyImport` and `BentleyImport(),` after `OpfExport(),`.

- [ ] **Step 6: Run to verify they pass**

Run: `uv run --frozen --directory python pytest tests/test_bentley_import.py tests/test_captures.py tests/test_m10_params.py tests/test_opf.py -q`, then `uv run --frozen --directory python ruff check src tests` and `ruff format --check src tests`.
Expected: all pass, ruff clean.

- [ ] **Step 7: Commit**

```bash
git add python/src/aio_pipelines/captures.py python/src/aio_pipelines/bentley/importer.py python/src/aio_pipelines/pipelines.py python/tests/test_captures.py python/tests/test_bentley_import.py
git commit -F <msg>   # feat(pipelines): bentley.import job, a run and a posed photos layer
```

---

### Task 7: `.zpc` in `pointcloud.to_copc`

**Files:**

- Create: `python/src/aio_pipelines/zpc.py`
- Modify: `python/src/aio_pipelines/pointcloud.py:1-16` (docstring), `:41` (`CLOUD_EXTENSIONS`), `:511-535` (`validate`), the `convert` step (a `.zpc` branch first), new `convert_zpc` function
- Create: `python/tests/test_pointcloud_zpc.py`

**Interfaces:**

- Consumes: `bentley_synth.make_zpc` (Task 2); `cloud_out.write_copc` with a folder (Task 3a); `read_summary`, `source_epsg`, `prepare_las`, `las_record_length`, `disk_needed`, `check_space`, `BuildWatch`, `_BuildProgress` (this file).
- Produces: `zpc.Tile(member, name, size)`, `zpc.list_tiles(path) -> list[Tile]`, `zpc.extract_tiles(ctx, src, tiles, dest, band) -> list[Path]`; `pointcloud.convert_zpc(ctx, pdal, src, epsg) -> {"points", "bytes", "tiles"}`; `pointcloud.to_copc` accepts `src` ending `.zpc`.

- [ ] **Step 1: Write the failing tests**

Create `python/tests/test_pointcloud_zpc.py`:

```python
"""pointcloud.to_copc on a Bentley .zpc (a ZIP of LAS/LAZ tiles), synthetic."""

import json
import subprocess
import threading
import zipfile

import pytest

import bentley_synth as bs
from aio_pipelines import zpc
from aio_pipelines.pointcloud import PointcloudToCopc, find_pdal, pdal_env
from aio_pipelines.runtime import JobError
from conftest import run_job

PDAL = find_pdal()


def project(tmp_path):
    return bs.make_project(tmp_path / "proj")


def test_validate_takes_a_zpc_and_names_the_cloud_after_it(tmp_path):
    p = PointcloudToCopc().validate({"src": str(tmp_path / "Mast cloud.zpc")})
    assert p["out"] == "clouds/mast-cloud.copc.laz"


def test_only_las_and_laz_members_are_tiles(tmp_path):
    z = bs.make_zpc(tmp_path / "c.zpc", extra={"metadata.xml": b"<x/>", "Tile_3.LAZ": b"LASF"})
    names = [t.name for t in zpc.list_tiles(tmp_path / "c.zpc")]
    assert names == ["Tile_1.las", "Tile_2.las", "Tile_3.LAZ"] and z["points"] == 1000


@pytest.mark.parametrize("bad", ["../evil.las", "/abs/evil.las", "C:/evil.las", "a/../../evil.laz"])
def test_an_unsafe_member_name_refuses_the_whole_file(tmp_path, bad):
    bs.make_zpc(tmp_path / "c.zpc", extra={bad: b"LASF"})
    with pytest.raises(JobError, match="unsafe name"):
        zpc.list_tiles(tmp_path / "c.zpc")


def test_not_a_zip_and_no_tiles_are_refused_in_words(tmp_path):
    (tmp_path / "x.zpc").write_bytes(b"not a zip")
    with pytest.raises(JobError, match="not a ZIP"):
        zpc.list_tiles(tmp_path / "x.zpc")
    with zipfile.ZipFile(tmp_path / "y.zpc", "w") as f:
        f.writestr("readme.txt", "x")
    with pytest.raises(JobError, match="no LAS or LAZ tiles"):
        zpc.list_tiles(tmp_path / "y.zpc")


def test_a_cancel_while_unpacking_leaves_no_tiles(tmp_path, monkeypatch):
    from aio_pipelines import pointcloud as pc

    bs.make_zpc(tmp_path / "c.zpc", tiles=2, points=20_000)
    monkeypatch.setattr(pc, "find_pdal", lambda: "pdal")
    cancel = threading.Event()
    real = zpc.extract_tiles

    def cancelling(ctx, *a, **k):
        cancel.set()
        return real(ctx, *a, **k)

    monkeypatch.setattr(zpc, "extract_tiles", cancelling)
    root = project(tmp_path)
    result, _ = run_job(PointcloudToCopc(), root, {"src": str(tmp_path / "c.zpc"), "epsg": bs.EPSG}, cancel=cancel)
    assert result["status"] == "cancelled"
    staging = next((root / "jobs").glob("*/staging"))
    assert not list(staging.rglob("tile-*"))


def test_a_corrupt_tile_fails_with_its_name_and_adds_no_layer(tmp_path, monkeypatch):
    from aio_pipelines import pointcloud as pc

    bs.make_zpc(tmp_path / "c.zpc", tiles=2)
    monkeypatch.setattr(pc, "find_pdal", lambda: "pdal")

    def summary(ctx, pdal, path):
        if path.name == "tile-002.las":
            raise JobError("PDAL could not finish reading the cloud: bad header")
        return {"num_points": 500, "srs": {}}

    monkeypatch.setattr(pc, "read_summary", summary)
    root = project(tmp_path)
    result, _ = run_job(PointcloudToCopc(), root, {"src": str(tmp_path / "c.zpc"), "epsg": bs.EPSG})
    assert result["status"] == "failed" and "Tile_2.las" in result["error"]
    assert json.loads((root / "manifest.json").read_text())["layers"] == []


def test_tiles_in_different_crss_are_refused(tmp_path, monkeypatch):
    from aio_pipelines import pointcloud as pc

    bs.make_zpc(tmp_path / "c.zpc", tiles=2)
    monkeypatch.setattr(pc, "find_pdal", lambda: "pdal")
    srs = {"tile-001.las": {"json": {"id": {"authority": "EPSG", "code": 32639}}},
           "tile-002.las": {"json": {"id": {"authority": "EPSG", "code": 32640}}}}  # fmt: skip
    monkeypatch.setattr(pc, "read_summary", lambda ctx, pdal, p: {"num_points": 500, "srs": srs[p.name]})
    root = project(tmp_path)
    result, _ = run_job(PointcloudToCopc(), root, {"src": str(tmp_path / "c.zpc"), "epsg": bs.EPSG})
    assert result["status"] == "failed" and "different CRSs" in result["error"]


@pytest.mark.skipif(PDAL is None, reason="PDAL not found (set AIO_PDAL)")
def test_a_two_tile_zpc_becomes_one_cloud_with_every_point(tmp_path):
    z = bs.make_zpc(tmp_path / "Mast cloud.zpc", tiles=2, points=4000)
    root = project(tmp_path)
    result, _ = run_job(PointcloudToCopc(), root, {"src": z["zpc"], "epsg": bs.EPSG})
    assert result["status"] == "done", result
    out = root / "clouds" / "mast-cloud.copc.laz"
    info = json.loads(
        subprocess.run([PDAL, "info", "--summary", str(out)], capture_output=True, check=True, env=pdal_env(PDAL)).stdout
    )["summary"]
    assert info["num_points"] == z["points"]
    xmin, ymin, xmax, ymax = z["bounds"]
    assert info["bounds"]["minx"] >= xmin - 0.01 and info["bounds"]["maxx"] <= xmax + 0.01
    assert info["bounds"]["maxx"] - info["bounds"]["minx"] > 15  # both tiles
    (layer,) = json.loads((root / "manifest.json").read_text())["layers"]
    assert layer["name"] == "Mast cloud.zpc" and layer["pointCount"] == z["points"] and "capture" not in layer
    assert not list((root / "jobs").rglob("tile-*"))
```

- [ ] **Step 2: Run to verify they fail**

Run: `uv run --frozen --directory python pytest tests/test_pointcloud_zpc.py -q`
Expected: FAIL (`aio_pipelines.zpc` missing; `.zpc` refused by `validate`).

- [ ] **Step 3: Implement `zpc.py`**

```python
"""A Bentley ``.zpc`` point cloud export: a ZIP of LAS or LAZ tiles (iTwin Capture Modeler).

Only ``.las`` and ``.laz`` members are tiles; other members are ignored. A member with an
absolute path, a drive letter or ``..`` refuses the whole file (nothing is unpacked), as does an
encrypted member. Tiles are unpacked under names this module makes (``tile-NNN.<ext>``), never
the member's own, into the job's staging folder.
"""

from __future__ import annotations

import re
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from .runtime import JobError, StepContext

TILE_SUFFIXES = {".las", ".laz"}
CHUNK = 8 * 1024 * 1024


@dataclass
class Tile:
    member: str
    name: str
    size: int


def _unsafe(name: str) -> bool:
    n = name.replace("\\", "/")
    return n.startswith("/") or bool(re.match(r"^[A-Za-z]:", n)) or ".." in n.split("/")


def list_tiles(path: Path) -> list[Tile]:
    if not zipfile.is_zipfile(path):
        raise JobError(f"{path.name} is not a ZIP file, so not a Bentley .zpc export.")
    tiles: list[Tile] = []
    with zipfile.ZipFile(path) as z:
        for info in z.infolist():
            if info.is_dir():
                continue
            if _unsafe(info.filename):
                raise JobError(f"{path.name} holds a file with an unsafe name ({info.filename[:120]}); it is not read.")
            if PurePosixPath(info.filename.replace("\\", "/")).suffix.lower() not in TILE_SUFFIXES:
                continue
            if info.flag_bits & 0x1:
                raise JobError(f"{path.name} is encrypted; export it again without a password.")
            tiles.append(Tile(info.filename, PurePosixPath(info.filename.replace("\\", "/")).name, info.file_size))
    if not tiles:
        raise JobError(f"{path.name} holds no LAS or LAZ tiles.")
    return tiles


def extract_tiles(ctx: StepContext, src: Path, tiles: list[Tile], dest: Path, band: tuple[float, float]) -> list[Path]:
    dest.mkdir(parents=True, exist_ok=True)
    lo, hi = band
    total = max(1, sum(t.size for t in tiles))
    done = 0
    out: list[Path] = []
    with zipfile.ZipFile(src) as z:
        for i, t in enumerate(tiles):
            dst = dest / f"tile-{i + 1:03d}{PurePosixPath(t.name).suffix.lower()}"
            try:
                with z.open(t.member) as fin, open(dst, "wb") as fout:
                    while chunk := fin.read(CHUNK):
                        ctx.check()
                        fout.write(chunk)
                        done += len(chunk)
                        ctx.progress(lo + (hi - lo) * done / total, f"Unpacking tile {i + 1} of {len(tiles)}")
            except (zipfile.BadZipFile, EOFError, OSError) as e:
                raise JobError(f"Tile {t.name} of {src.name} could not be unpacked: {e}") from None
            out.append(dst)
    return out
```

- [ ] **Step 4: Wire it into `pointcloud.py`**

- `CLOUD_EXTENSIONS = {".las", ".laz", ".e57", ".ply", ".zpc"}`; in `validate` the message becomes `"src must be a LAS, LAZ, E57, PLY or ZPC file."`; the docstring gains a paragraph: "A Bentley `.zpc` (a ZIP of LAS/LAZ tiles) is unpacked into the staging folder, each tile reprojected when needed, and the folder of tiles becomes one COPC (`convert_zpc`)."
- Add, after `disk_needed`, the constant `ZPC_UNPACK_END = 0.10` and:

```python
def convert_zpc(ctx: StepContext, pdal: str, src: Path, epsg: int | None) -> dict[str, Any]:
    """A ``.zpc``'s tiles as one COPC in ``staging/cloud.copc.laz``: unpacked, read, reprojected
    tile by tile when they declare another CRS, then built from the folder of tiles. The unpacked
    and reprojected tiles go whatever happens."""
    from . import zpc
    from .photo import cloud_out, native

    tiles = zpc.list_tiles(src)
    check_space(ctx.staging, sum(t.size for t in tiles))
    raw, las_dir = ctx.stage("zpc-tiles"), ctx.stage("zpc-las")
    for d in (raw, las_dir):
        shutil.rmtree(d, ignore_errors=True)
    staged = ctx.stage("cloud.copc.laz")
    try:
        files = zpc.extract_tiles(ctx, src, tiles, raw, (0.0, ZPC_UNPACK_END))
        counts: list[int] = []
        crss: set[int | None] = set()
        for t, f in zip(tiles, files, strict=True):
            try:
                s = read_summary(ctx, pdal, f)
            except JobError as e:
                raise JobError(f"Tile {t.name} of {src.name} could not be read: {e}") from None
            srs = s.get("srs") or {}
            crss.add(source_epsg(srs) if (srs.get("wkt") or srs.get("json")) else None)
            counts.append(int(s.get("num_points") or 0))
            ctx.log(f"{t.name}: {counts[-1]:,} points")
        if len(crss) > 1:
            raise JobError(f"The tiles of {src.name} are in different CRSs; export them in one CRS.")
        count, tile_epsg = sum(counts), next(iter(crss))
        reproject = epsg if epsg and tile_epsg and tile_epsg != epsg else None
        if epsg and tile_epsg is None:
            ctx.log(f"The tiles declare no CRS; they are taken as EPSG:{epsg} already.", "warn")
        ctx.log(f"{src.name}: {len(tiles)} tiles, {count:,} points")
        record = max((las_record_length(f) or DEFAULT_RECORD) for f in files)
        check_space(ctx.staging, disk_needed(count, record if reproject else None))
        folder, start = raw, ZPC_UNPACK_END
        if reproject:
            las_dir.mkdir(parents=True, exist_ok=True)
            step = (PREPARE_END - ZPC_UNPACK_END) / len(files)
            for i, (f, n) in enumerate(zip(files, counts, strict=True)):
                band = (ZPC_UNPACK_END + i * step, ZPC_UNPACK_END + (i + 1) * step)
                prepare_las(ctx, pdal, f, las_dir / f"tile-{i + 1:03d}.las", reproject, n, band)
                f.unlink()  # one copy of each tile on the drive at a time
            folder, start = las_dir, PREPARE_END
        ctx.check()
        work = ctx.stage("copc-work")
        (work / "tool.out").unlink(missing_ok=True)
        with BuildWatch(ctx, (start, BUILD_END), ctx.staging, work / "tool.out"):
            writer = cloud_out.write_copc(
                _BuildProgress(ctx),  # type: ignore[arg-type]
                folder,
                staged,
                count,
                epsg,
                work,
                native.memory_budget(),
                progress=(start, BUILD_END),
            )
    except JobError as e:
        if "memory budget" in str(e) and "untwine" in str(e):
            raise JobError(TOO_BIG_WITHOUT_UNTWINE) from None
        raise
    finally:
        for d in (raw, las_dir):
            shutil.rmtree(d, ignore_errors=True)
    ctx.log(f"Built the viewable cloud with {writer}.")
    return {"points": count, "bytes": staged.stat().st_size, "tiles": len(tiles)}
```

- In the `convert` step, right after `src = ctx.input(params["src"])`, add:

```python
            if src.suffix.lower() == ".zpc":
                return convert_zpc(ctx, pdal, src, params.get("epsg"))
```

The `register` step needs no change (it names the layer after `params["src"]` and sets no capture).

- [ ] **Step 5: Run to verify they pass**

Run: `uv run --frozen --directory python pytest tests/test_pointcloud_zpc.py tests/test_pointcloud.py -q` (with `AIO_PDAL` and `AIO_UNTWINE`), then ruff check and format check.
Expected: all pass; the real two-tile test runs (not skipped).

- [ ] **Step 6: Commit**

```bash
git add python/src/aio_pipelines/zpc.py python/src/aio_pipelines/pointcloud.py python/tests/test_pointcloud_zpc.py
git commit -F <msg>   # feat(pipelines): a bentley zpc becomes one copc cloud
```

---

### Task 8: Add data routing in the raw import

**Files:**

- Modify: `packages/project/src/builder/raw.ts:123-160` (`ImportDeps.pickFolder`), `:174` (`CLOUD` gains `.zpc`), `:826-833` (the XML branches)
- Modify: `packages/project/src/builder/raw.test.ts` (after the LandXML test, ~`:287`)

**Interfaces:**

- Consumes: `ImportItem.kind` `bentley` (Task 1).
- Produces: `ImportDeps.pickFolder?: (title: string) => Promise<string | null>`; exported constants `BENTLEY_NO_FOLDER`, `UNSUPPORTED_XML`; the job method `'bentley.import'` with params `{ xml, photos }` (main maps it in Task 9); `.zpc` goes to `'pointcloud.toCopc'` like any cloud.

- [ ] **Step 1: Write the failing tests**

In `packages/project/src/builder/raw.test.ts`, replace the expectation of the LandXML test's third row only if it changes (it stays `['unknown', 'skipped']`, now with `UNSUPPORTED_XML`), and add after it:

```ts
it('hands a Bentley block to bentley.import with the photos folder the person picks', async () => {
  const root = await project();
  const at = join(dir, 'at.xml');
  await writeFile(
    at,
    '<?xml version="1.0" encoding="utf-8"?>\n<BlocksExchange version="3.2"></BlocksExchange>\n',
  );
  const started: { method: string; params: Record<string, unknown> }[] = [];
  const titles: string[] = [];
  const jobs: PipelineJobs = {
    available: () => Promise.resolve(true),
    start: (method, params) => {
      started.push({ method, params });
      return Promise.resolve({ jobId: 'job-b' });
    },
  };
  const pickFolder = (title: string) => {
    titles.push(title);
    return Promise.resolve('D:/jobs/photos');
  };
  const r = await importRawFiles(root, [at], { ...deps({ jobs }), pickFolder });
  expect(r.items).toEqual([
    expect.objectContaining({ kind: 'bentley', status: 'queued', jobId: 'job-b' }),
  ]);
  expect(started).toEqual([
    {
      method: 'bentley.import',
      params: expect.objectContaining({ xml: at, photos: 'D:/jobs/photos' }),
    },
  ]);
  expect(titles).toEqual(['Choose the photos folder of at.xml']);
});

it('skips a Bentley block when no folder is chosen, and other XML in words', async () => {
  const root = await project();
  const at = join(dir, 'at.xml');
  const other = join(dir, 'notes.xml');
  await writeFile(at, '<BlocksExchange version="3.2"/>');
  await writeFile(other, '<?xml version="1.0"?>\n<notes/>\n');
  const started: string[] = [];
  const jobs: PipelineJobs = {
    available: () => Promise.resolve(true),
    start: (method) => {
      started.push(method);
      return Promise.resolve({ jobId: 'j' });
    },
  };
  const r = await importRawFiles(root, [at, other], {
    ...deps({ jobs }),
    pickFolder: () => Promise.resolve(null),
  });
  expect(r.items).toEqual([
    expect.objectContaining({ kind: 'bentley', status: 'skipped', message: BENTLEY_NO_FOLDER }),
    expect.objectContaining({ kind: 'unknown', status: 'skipped', message: UNSUPPORTED_XML }),
  ]);
  expect(started).toEqual([]);
});

it('converts a .zpc like any point cloud', async () => {
  const root = await project();
  const zpcFile = join(dir, 'Mast cloud.zpc');
  await writeFile(zpcFile, 'PK\u0003\u0004');
  const started: { method: string; params: Record<string, unknown> }[] = [];
  const jobs: PipelineJobs = {
    available: () => Promise.resolve(true),
    start: (method, params) => {
      started.push({ method, params });
      return Promise.resolve({ jobId: 'j' });
    },
  };
  const r = await importRawFiles(root, [zpcFile], deps({ jobs }));
  expect(r.items[0]).toMatchObject({ kind: 'pointcloud', status: 'queued' });
  expect(started[0]).toMatchObject({
    method: 'pointcloud.toCopc',
    params: { src: zpcFile, out: 'clouds/mast-cloud.copc.laz' },
  });
  expect(isImportableExtension('.zpc')).toBe(true);
});
```

Import `BENTLEY_NO_FOLDER`, `UNSUPPORTED_XML` and `isImportableExtension` from `./raw` at the top if not already imported. Check `slug` for `'Mast cloud'` gives `mast-cloud`; if it gives another form, assert that form.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run packages/project/src/builder/raw.test.ts`
Expected: FAIL (the constants are not exported; the block is skipped as unknown).

- [ ] **Step 3: Implement**

In `raw.ts`:

- `const CLOUD = new Set(['.las', '.laz', '.e57', '.ply', '.zpc']);` with the comment `/** Point clouds; `.zpc` is a Bentley export, a ZIP of LAS/LAZ tiles (15 Oct 2026). */`.
- In `ImportDeps`, after `signal?`:

```ts
  /**
   * Ask the person for a folder (main shows the system dialog). A Bentley BlocksExchange AT
   * export needs the folder of its photos; without this, or when the person cancels, the block is
   * skipped with `BENTLEY_NO_FOLDER`.
   */
  pickFolder?: (title: string) => Promise<string | null>;
```

- Beside the other messages:

```ts
export const BENTLEY_NO_FOLDER =
  'No photos folder was chosen, so the Bentley block was not imported. Add the .xml again and choose the folder that holds its photos.';
export const UNSUPPORTED_XML =
  'Not a supported XML file: LandXML designs and Bentley BlocksExchange AT exports are read.';
```

- Replace the design branch (`} else if (DESIGN.has(ext) || (ext === '.xml' && ...)) {`) with:

```ts
      } else if (DESIGN.has(ext)) {
        await job(file, 'design', 'design.import', {});
      } else if (ext === '.xml') {
        const head = new TextDecoder().decode(await readHead(file, 4096));
        if (head.includes('<LandXML')) await job(file, 'design', 'design.import', {});
        else if (head.includes('<BlocksExchange')) {
          const photos = deps.pickFolder
            ? await deps.pickFolder(`Choose the photos folder of ${name}`)
            : null;
          if (photos) await job(file, 'bentley', 'bentley.import', { xml: file, photos });
          else items.push({ file: name, kind: 'bentley', status: 'skipped', message: BENTLEY_NO_FOLDER });
        } else items.push({ file: name, kind: 'unknown', status: 'skipped', message: UNSUPPORTED_XML });
```

Check `name` is the variable the loop uses for the file's display name (it is, in the surrounding `items.push({ file: name, ... })` calls); use the same. Export the two constants from `packages/project/src/builder/index.ts` only if `raw.test.ts` cannot import them from `./raw` directly (it can).

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm vitest run packages/project/src/builder/raw.test.ts` and `pnpm --filter @aio/project typecheck` (or `pnpm typecheck` from the root).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/project/src/builder/raw.ts packages/project/src/builder/raw.test.ts
git commit -F <msg>   # feat(project): add data routes zpc clouds and bentley blocks
```

---

### Task 9: The desktop app: folder picker, builder job, forms and filters

**Files:**

- Modify: `apps/desktop/src/main/builder.ts:280-290` (`BuilderImportDeps.pickFolder`), `:349-362` (pass it to `importRawFiles`)
- Modify: `apps/desktop/src/main/index.ts:1409-1425` (provide `pickFolder`)
- Modify: `apps/desktop/src/main/builderJobs.ts:5-21`, `builderJobs.test.ts`
- Modify: `apps/desktop/src/renderer/builder/state.ts:151-175` (`IMPORT_FILTERS`)
- Modify: `apps/desktop/src/renderer/jobs.ts:~86` (`MANIFEST_WRITERS`), `:~424` (the `pointcloud.to_copc` help), after the `opf.import` form `:~690` (the `bentley.import` form)
- Modify: `apps/desktop/src/renderer/processing/pipelines.ts:73`, `:172`
- Modify: `apps/desktop/src/renderer/shell/Palette.tsx:481` (keywords)
- Create: `apps/desktop/src/renderer/jobs-bentley.test.ts`

**Interfaces:**

- Consumes: `ImportDeps.pickFolder` (Task 8), `BentleyImportParams` (Task 1).
- Produces: `BUILDER_PIPELINES['bentley.import'] = 'bentley.import'`, `PARAM_KEYS['bentley.import'] = ['xml', 'photos', 'name']`; `FORMS['bentley.import']` (fields `xml` file, `photos` folder, `name` text); `bentley.import` reloads the manifest when done.

- [ ] **Step 1: Write the failing tests**

Append to `apps/desktop/src/main/builderJobs.test.ts` (inside the `describe`):

```ts
it('starts bentley.import with the block and its photos folder only', async () => {
  const { r, started } = runner();
  await builderPipelineJobs(r).start('bentley.import', {
    projectRoot: 'E:/data/projects/site',
    src: 'D:/jobs/at.xml',
    epsg: 32640,
    origin: [1, 2, 3],
    xml: 'D:/jobs/at.xml',
    photos: 'D:/jobs/photos',
  });
  expect(started).toEqual([
    {
      pipeline: 'bentley.import',
      project: 'E:/data/projects/site',
      params: { xml: 'D:/jobs/at.xml', photos: 'D:/jobs/photos' },
    },
  ]);
});
```

Create `apps/desktop/src/renderer/jobs-bentley.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { IMPORT_FILTERS } from './builder/state';
import { buildParams, FORMS, reloads } from './jobs';

describe('Bentley import in the app', () => {
  it('has a job form: the AT export and its photos folder', () => {
    expect(
      buildParams('bentley.import', { xml: 'D:/jobs/at.xml', photos: 'D:/jobs/photos' }),
    ).toEqual({
      ok: true,
      params: { xml: 'D:/jobs/at.xml', photos: 'D:/jobs/photos' },
    });
    expect(buildParams('bentley.import', { xml: 'D:/jobs/at.xml' }).ok).toBe(false);
    const xml = FORMS['bentley.import'].find((f) => f.key === 'xml');
    expect(xml?.filters?.[0]?.extensions).toEqual(['xml']);
    expect(FORMS['bentley.import'].find((f) => f.key === 'photos')?.kind).toBe('folder');
    expect(reloads('bentley.import')).toBe(true);
  });

  it('offers .zpc and .xml in Add data', () => {
    const raw = IMPORT_FILTERS[0]?.extensions ?? [];
    expect(raw).toEqual(expect.arrayContaining(['zpc', 'xml']));
  });
});
```

Check the names `buildParams`, `FORMS` and `reloads` against `jobs-m10.test.ts:1-30` (it uses `reloads`); if `IMPORT_FILTERS` cannot be imported in a unit test because `state.ts` pulls in the bridge, read the `extensions` list from a small exported constant `RAW_EXTENSIONS` that `IMPORT_FILTERS` uses, and test that instead.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run apps/desktop/src/main/builderJobs.test.ts apps/desktop/src/renderer/jobs-bentley.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement main**

`builderJobs.ts`:

```ts
  // 15 Oct 2026: a Bentley BlocksExchange AT export dropped on the builder, with its photos folder
  'bentley.import': 'bentley.import',
```

in `BUILDER_PIPELINES`, and `'bentley.import': ['xml', 'photos', 'name'],` in `PARAM_KEYS`.

`builder.ts`: in `BuilderImportDeps` add

```ts
  /** The system folder dialog, for a Bentley block's photos folder (index.ts). */
  pickFolder?: (title: string) => Promise<string | null>;
```

and in the `importRawFiles(root, files, { ... })` call add `...(d.pickFolder ? { pickFolder: d.pickFolder } : {}),`.

`index.ts`, in the `builderImport(req, { ... })` deps, add:

```ts
        // a Bentley AT export asks for its photos folder (main's dialog, as dialog:openFolder)
        pickFolder: async (title) => {
          const win = targetWindow();
          const options = { title, properties: ['openDirectory' as const] };
          const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
          return r.canceled ? null : (r.filePaths[0] ?? null);
        },
```

- [ ] **Step 4: Implement the renderer**

- `state.ts` `IMPORT_FILTERS` Raw data extensions: add `'zpc',` after `'e57',` and `'xml',` after `'opf',` (comment: `// a Bentley .zpc cloud; .xml: LandXML designs and Bentley AT exports`).
- `jobs.ts` `MANIFEST_WRITERS`: add `// Bentley: a run and a photos layer` and `'bentley.import',` after `'opf.import',`. The `pointcloud.to_copc` form's `src` help becomes `'LAS, LAZ, E57, PLY or a Bentley .zpc. Read only.'`. After the `opf.import` form add:

```ts
  'bentley.import': [
    {
      key: 'xml',
      label: 'AT export',
      kind: 'file',
      required: true,
      help: 'The BlocksExchange .xml that Bentley iTwin Capture Modeler (ContextCapture) exported. Read only.',
      filters: [{ name: 'BlocksExchange AT export', extensions: ['xml'] }],
    },
    {
      key: 'photos',
      label: 'Photos folder',
      kind: 'folder',
      required: true,
      help: 'The folder that holds the block\u2019s photos; its subfolders are searched. Read only.',
    },
    { key: 'name', label: 'Layer name', kind: 'text', placeholder: 'The XML file name' },
  ],
```

(Use a plain apostrophe if the file's other help texts do; no dashes.)

- `processing/pipelines.ts`: `'bentley.import': 'import',` after `'opf.export': 'import',` and `'bentley.import': 'files',` after `'opf.export': 'files',`.
- `Palette.tsx` `builder:import` keywords: add `'zpc', 'bentley', 'contextcapture', 'xml'`.

- [ ] **Step 5: Run to verify they pass**

Run: `pnpm vitest run apps/desktop/src/main/builderJobs.test.ts apps/desktop/src/renderer/jobs-bentley.test.ts apps/desktop/src/renderer/jobs-m10.test.ts apps/desktop/src/renderer/jobs-opf.test.ts`, then `pnpm check`.
Expected: PASS; `pnpm check` green (a `Record<PipelineName, ...>` that must list every pipeline, if any, now needs `bentley.import`: the typecheck names it).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/builder.ts apps/desktop/src/main/index.ts apps/desktop/src/main/builderJobs.ts apps/desktop/src/main/builderJobs.test.ts apps/desktop/src/renderer/builder/state.ts apps/desktop/src/renderer/jobs.ts apps/desktop/src/renderer/processing/pipelines.ts apps/desktop/src/renderer/shell/Palette.tsx apps/desktop/src/renderer/jobs-bentley.test.ts
git commit -F <msg>   # feat(desktop): bentley blocks and zpc clouds through add data
```

---

### Task 10: Data conventions and the pack version

**Files:**

- Modify: `docs/architecture/data-conventions.md` (section 4 note; new section 35 at the end)
- Modify: `python/pyproject.toml:3`, `python/uv.lock` (by `uv lock`)

**Interfaces:** none (documentation and version).

- [ ] **Step 1: Section 4**

Append to section 4 (Point clouds): "A Bentley `.zpc` (a ZIP of LAS/LAZ tiles) is one cloud: `pointcloud.to_copc` unpacks its tiles into the job's staging folder, reprojects each when it declares another CRS, and builds one COPC from the folder of tiles (untwine reads the folder; PDAL merges one reader per tile). The layer is named after the `.zpc` and gets no `capture` from the LAS headers, whose date is the export day (section 35)."

- [ ] **Step 2: Section 35**

Add at the end:

```markdown
## 35. Bentley imports (iTwin Capture Modeler, formerly ContextCapture)

Two separate imports through Add data (founder, 15 Oct 2026): a `.zpc` point cloud export (section 4) and a BlocksExchange AT export (`.xml`) with the folder of its photos (`bentley.import`, `@aio/schema` `BentleyImportParams`). An XML is a block when its first 4 KB hold `<BlocksExchange`; the app then asks for the photos folder.

- **What is read:** BlocksExchange major version 3; the block's SRS (an `EPSG:` code of a projected CRS; a geographic, local or unknown SRS is refused); per photogroup the image size, the focal length (`FocalLengthPixels`, else `FocalLength` mm times the largest image side over `SensorSize` mm), the principal point (pixels from the top-left corner), `K1 K2 K3 P1 P2`, `AspectRatio` 1 and `Skew` 0, `CameraOrientation` `XRightYDown`; per photo `ImagePath`, `Pose/Rotation` (`M_00`..`M_22`) and `Pose/Center`, and `ExifData/DateTimeOriginal`. `Pose/Metadata` (the GNSS prior) is never read. Tie points and control points are not read.
- **Conventions:** the rotation maps the block SRS to the camera with x right, y down, z forward, which is COLMAP's (`R_colmap = M`, `x_cam = M (X - C)`). Bentley's Brown model has its tangential terms in the other order from OpenCV's: OpenCV `p1` is Bentley `P2` and OpenCV `p2` is Bentley `P1`. A block in another projected CRS than the project is reprojected horizontally and its camera axes turn with the grid; heights are used as they are.
- **Photos** are matched by file name, without case, anywhere under the chosen folder (`ImagePath` names the AT computer's drive); several files of one name are told apart by their folder; ambiguous, missing and unaligned photos are left out and listed in the job log and the report.
- **Output** (as `opf.import`, section 21): `photogrammetry/bentley-<YYYYMMDD-HHMM>/` with `run.json` (`status` `aligned`, `settings.bentley` `{ xml, photos, version }`, `capture`), `sparse/` (cameras as `OPENCV` or `FULL_OPENCV`, no tie points), `frame.json`, `photos.json` (the originals, read in place) and `report/bentley-import.json`; a photos layer `photos-<run>` of 2560 px review copies under `photos/<run>/`, each item with `pos`, `q` and `lens` (`pinhole` plus `cx`, `cy`, `k1`, `k2`, `k3`, `p1`, `p2`, OpenCV convention, read by nothing yet), and `capture` set to the survey date of the earliest `DateTimeOriginal` (found or added as the app's `captureForDate` does). `takenAt` is left out: BlocksExchange times carry no time zone.
- **Pairing with the cloud:** nothing links the two layers; they line up because both come from one AT and are placed in the project frame. The cloud's survey date is set by the person.
```

- [ ] **Step 3: The pack version**

Set `version` in `python/pyproject.toml` to the next free minor after `main`'s (0.10.0 if `main` is still at 0.9.0), run `uv lock --directory python`, and check `uv run --frozen --directory python pytest tests/test_app_range.py -q` passes. If `tools/release/budgets.mjs` or an accelerator lock names the pack range (as in commit `8a9ce388`), follow that commit and widen it.

- [ ] **Step 4: Check and commit**

Run: `pnpm format:check` and `node tools/agent/check-public-text.mjs docs/architecture/data-conventions.md`.

```bash
git add docs/architecture/data-conventions.md python/pyproject.toml python/uv.lock
git commit -F <msg>   # docs(conventions): bentley imports; chore(pipelines): pack version for bentley.import
```

(two commits if the version bump touches more than these files.)

---

### Task 11: The end to end spec

**Files:**

- Create: `apps/desktop/e2e/bentley-import.spec.ts`

**Interfaces:**

- Consumes: `python/tests/bentley_synth.py` CLI (Task 2), the app as built by Tasks 7, 8, 9; `./fixtures`: `expect`, `hasPdal`, `hasPipelinePython`, `launchApp`, `PIPELINE_ENV`, `test`, `VENV_PYTHON`.
- Produces: nothing for other tasks.

- [ ] **Step 1: Write the spec**

```ts
import { ProjectManifest } from '@aio/schema';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import {
  expect,
  hasPdal,
  hasPipelinePython,
  launchApp,
  PIPELINE_ENV,
  test,
  VENV_PYTHON,
} from './fixtures';

/**
 * Bentley import through Add data against the development pipeline runtime: a synthetic
 * BlocksExchange block with three photos and a two-tile .zpc (python/tests/bentley_synth.py; no
 * client data) come into the tiny project. The cloud becomes one COPC layer, the photos one
 * layer of three posed cameras, and a photo opens from Media.
 */
const SYNTH = join(import.meta.dirname, '..', '..', '..', 'python', 'tests', 'bentley_synth.py');

/** Answer the next open dialogs in order (Add data's files, then main's photos folder). */
async function answerDialogs(app: ElectronApplication, answers: string[][]): Promise<void> {
  await app.evaluate(({ dialog }, queue) => {
    const left = [...queue];
    dialog.showOpenDialog = () => {
      const next = left.shift();
      return Promise.resolve(
        next ? { canceled: false, filePaths: next } : { canceled: true, filePaths: [] },
      );
    };
  }, answers);
}

const manifestOf = async (dir: string) =>
  ProjectManifest.parse(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')));

async function frustums(win: Page, layerId: string): Promise<number | undefined> {
  return win.evaluate((id) => {
    const w = window as unknown as {
      __stratlas: {
        stage(): {
          scene: { getObjectByName(n: string): { children: { count?: number }[] } | undefined };
        } | null;
      };
    };
    return w.__stratlas.stage()?.scene.getObjectByName(`photos:${id}`)?.children[2]?.count;
  }, layerId);
}

test.describe('Bentley import', () => {
  test.skip(!hasPipelinePython(), `no Python with aio_pipelines at ${VENV_PYTHON}`);
  test.skip(!hasPdal(), 'the .zpc cloud needs PDAL (AIO_PDAL)');

  test('a .zpc becomes one cloud and an AT export a layer of posed photos that open', async ({
    dataRoot,
    network,
  }) => {
    test.setTimeout(240_000);
    const fx = JSON.parse(
      execFileSync(VENV_PYTHON, [SYNTH, join(dataRoot.base, 'bentley')], {
        encoding: 'utf8',
      }).trim(),
    ) as { xml: string; photos: string; zpc: string; points: number };
    const app = await launchApp(dataRoot, PIPELINE_ENV);
    await network.attach(app);
    try {
      const win = await app.firstWindow();
      await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).click();
      await expect(win.locator('[data-scene-view] canvas')).toBeVisible();

      await answerDialogs(app, [[fx.zpc, fx.xml], [fx.photos]]);
      await win.keyboard.press('Control+K');
      await win.keyboard.type('Import raw data');
      await win.keyboard.press('Enter');

      // both jobs finish and the open project reloads its manifest with both layers
      await expect
        .poll(
          async () =>
            (await manifestOf(dataRoot.projectDir)).layers
              .map((l) => l.kind)
              .sort()
              .join(','),
          {
            timeout: 180_000,
          },
        )
        .toContain('photos');
      await expect
        .poll(
          async () =>
            (await manifestOf(dataRoot.projectDir)).layers.some(
              (l) => l.kind === 'pointcloud' && l.name === 'synthetic.zpc',
            ),
          {
            timeout: 180_000,
          },
        )
        .toBe(true);
      const m = await manifestOf(dataRoot.projectDir);
      const cloud = m.layers.find((l) => l.kind === 'pointcloud' && l.name === 'synthetic.zpc');
      expect(cloud).toMatchObject({ format: 'copc', pointCount: fx.points });
      const photos = m.layers.find((l) => l.kind === 'photos');
      if (photos?.kind !== 'photos') throw new Error('no photos layer');
      expect(photos.items).toHaveLength(3);
      for (const item of photos.items) {
        expect(item.pos).toHaveLength(3);
        expect(item.lens).toMatchObject({ model: 'pinhole', cx: 322.5 });
      }
      expect(photos.capture).toBe(m.captures.find((c) => c.date === '2026-03-04')?.id);

      // three cameras drawn in 3D
      await expect.poll(() => frustums(win, photos.id), { timeout: 60_000 }).toBe(3);

      // a photo opens from Media
      await win.locator('.nav-item', { hasText: 'Media' }).first().click();
      const first = photos.items[0]?.id ?? '';
      const tile = win.locator(`.media [data-photo="${first}"]`);
      await tile.scrollIntoViewIfNeeded();
      await tile.click();
      const viewer = win.getByTestId('photo-viewer').first();
      await expect(viewer).toBeVisible();
      await expect
        .poll(
          () =>
            viewer
              .locator('img')
              .first()
              .evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0),
          {
            timeout: 30_000,
          },
        )
        .toBe(true);
      expect(await network.outbound()).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
```

Before running, check three app details and adapt the spec to them (each is one line): the palette shortcut and the command title (`builder.spec.ts:399` types `'Import raw data'`: copy how it opens the palette); the Media panel's photo card selector (an existing photo orientation spec uses `.media [data-photo="<id>"]`: `grep -n 'media \[data-photo' apps/desktop/e2e/*.ts`) and how a click opens the viewer (`issue-card.spec.ts:211-219`, `photo-viewer`); and whether the photos scene object is named `photos:<layer id>` with the frustum count at `children[2].count` (`grep -n 'children\[2\]?.count' apps/desktop/e2e/*.ts`). The window is CI-sized; open Media from the nav as that orientation spec does.

- [ ] **Step 2: Build the demos and run it the CI way**

From `apps/desktop`, once: `pnpm demo:build --quick` (and `pnpm demo:change --quick` from the root). Then, in PowerShell:

```powershell
$env:QUADRION_WINDOW_SIZE = '1100x720'; $env:QUADRION_E2E_SCALE = '1'; $env:QUADRION_E2E_SWGL = 'warp'
$env:QUADRION_E2E_PYTHON = '<worktree>\python\.venv\Scripts\python.exe'
npx playwright test e2e/bentley-import.spec.ts --workers=1 --repeat-each=3
```

Expected: 3 passed; the log prints `[e2e] window 1100 x 720 px at display scale 1`.

- [ ] **Step 3: `pnpm check` and commit**

```bash
git add apps/desktop/e2e/bentley-import.spec.ts
git commit -F <msg>   # test(desktop): bentley block and zpc through add data end to end
```

---

### Task 12: The reference job by hand (founder window, not in CI)

**Files:** none in git. The outcome goes into the session note (public: say "the reference job", never its names or ids).

- [ ] **Step 1: Ask the founder for a window** (the cloud build uses every core for minutes) **and for a re-export of the reference AT with tie points** (BlocksExchange export option "tie points"), and for the photo folder to be on this PC.
- [ ] **Step 2: Cloud.** In a test project in EPSG:32640 (a copy, never a real project), Add data the reference `.zpc`. Record: total job time, the unpack and build times from the job log, the point count (expect 125,562,135), the writer (`untwine`), peak memory (Task Manager), free disk before and after, and that `staging/zpc-tiles` is gone.
- [ ] **Step 3: Photos.** Add data the reference AT `.xml`, choose the photo folder. Record matched 560 of 560 (or the missing list), the job time, and look at the 3D view: the cameras ring the tower around the cloud, looking at it.
- [ ] **Step 4: Convention check with tie points.** With the re-export, run a scratch script (in the scratchpad, not the repo) that reads the block with `aio_pipelines.bentley.blocks.read_block`, the tie points' 3D positions and their photo measurements (`TiePoints/TiePoint/Position`, `Measurement/PhotoId`, `x`, `y`), projects each through `photo.model.project_points` with the camera from `convert.lens_of` and `camera_pose`, and reports the median and 95th percentile pixel error for `TANGENTIAL_SWAP` True and False, and with the principal point shifted by half a pixel. Expect a median under 1 px for the right combination. If the winner is not the current code, change `TANGENTIAL_SWAP` (and the docstring and section 35) in a follow-up commit with the numbers in its body.
- [ ] **Step 5: Findings-on-model check.** Open a photo of the tower and confirm the photos and the cloud are on one survey date only after the person sets the cloud's date (the spec deviation above); note what the founder decides about the cloud's date.

---

## Self-review notes

- Spec coverage: `.zpc` filter, extension, signature, safe names, temp extraction, per tile reprojection, merge, one layer named after the file, per tile progress, corrupt tile (Tasks 7, 8, 9); BlocksExchange parser, unaligned count, SRS refusal, rotation convention and round trip (Tasks 3, 4); matching rules and counts (Task 5); run, sparse, frame, photos, layer, capture, referenced photos (Task 6); Add data sniff and folder prompt, "not a supported XML file" (Tasks 8, 9); lens fields, job name in schema, renderer, main, contract row, conventions section (Tasks 1, 9, 10); tests: Python, TS, e2e, manual (all). The `.zpc` capture from the LAS header is deliberately not done (Global Constraints, spec deviation).
- The merge port of `tools/pointcloud/merge-copc.mjs` is not done: it copies COPC chunks byte for byte and needs inputs that are cells of one octree with one scale and offset; Bentley tiles have a different offset each. untwine (in the pack since 0.6.1) merges a folder of tiles out of core, which is what the port was for.
