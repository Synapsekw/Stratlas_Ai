# Photo processing at scale: a bounded dense cloud. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `photo.products` finishes a 1,000-photo Standard run on a 64 GB workstation: a budgeted, cleaner dense cloud, ground classified from the DTM, the COPC built out of core by untwine, real progress throughout and every external tool under the memory budget.

**Architecture:** Fusion keeps a point only when two neighbouring photos agree within `min(1 % of depth, 3 GSD)` and stores it as 18-byte chunks. A two-pass, per-tile merge (voxel count filter and column collapse, then a statistical outlier filter over the tile and a one-voxel margin) runs in worker processes at a spacing chosen up front from the preset's point budget, with a re-merge safety net. The DTM is built from the gridded surface before the cloud; the cloud step classifies each tile by its height above the DTM while writing LAS, then untwine (pipeline pack 0.6.1) writes the COPC, with PDAL's `writers.copc` as a memory-checked fallback. Work folders are keyed in three levels (depth, fusion, merge), so the depth maps survive and an old job cannot reuse the old 913 M point tiles.

**Tech Stack:** Python 3.13 (numpy, scipy `cKDTree` and `ndimage`, rasterio, shapely), `aio_pipelines` job runtime, conda-forge `libpdal-core` 2.10.2 and `untwine` 1.5.1 through micromamba (`tools/pipeline-pack/pdal.mjs`), Vitest for the pack tools, Playwright with Electron for the e2e spec.

**Spec:** `docs/plans/2026-10-13-photo-scale-design.md` (approved by the founder, 13 Oct 2026). Read it before any task.

## Global Constraints

- Point budget per preset: Fast stays sparse (budget 0), Standard `150_000_000`, High `400_000_000`.
- Spacing: `voxel = max(gsd/scale, sqrt(area / (0.9 · budget)))`; `area` from a 2 m occupancy grid of the sparse points (cells with at least 2 points, dilated by 2 cells, clipped to the region).
- Fusion v2: `min_agree = 2`; agreement means `|dz| ≤ min(0.01·z, 3·gsd/scale)`. CPU (`fuse.py`, `pool.fuse_photo`) and card (`card.fuse_arrays`) apply the same rule.
- Chunk format 2: x and y float32 offsets from the tile corner, z float32, normals int8 ×127, colour uint8; 18 bytes a point; round trip under 0.1 mm.
- Merge v2, per tile: drop voxels seen fewer than 2 times; collapse each xy column (split where the z gap exceeds `2·voxel`, one mean point per `2·voxel` sub-bin of each cluster); outlier filter: mean distance to the 16 nearest neighbours above the tile mean plus 2.5 σ is dropped, KD-tree over the tile plus a one-voxel margin.
- Safety net: above `1.2 × budget`, merge again at `voxel · sqrt(points / budget)` from the chunks before they are deleted. Tile size `1024 · dsmRes` (at least 16 m). Chunks are deleted after a complete merge.
- Step order: prepare, dense, fuse, dsm, dtm, cloud, ortho, mesh, texture, commit, tiles. `cloud` implies the dsm and dtm steps; the DTM layer is published only when `dtm` was asked for.
- DTM: always smrf-grid on the zmin raster. `pdal_dtm_pipeline` and the PDAL DTM branch are removed.
- Ground class: 2 where `-0.5 m ≤ z − dtm ≤ 0.2 m`, 1 elsewhere and where the DTM has no data.
- untwine 1.5.1: `untwine -i <las> -o <x>.copc.laz --temp_dir <dir> --progress_debug [--a_srs EPSG:n]`; progress from `/\((\d+)% done\)/` on stdout or stderr; temp folder in the job's staging area; the disk check reserves 2× the COPC size for it.
- PDAL fallback: `writers.copc` under `native.run_tool`'s memory limit, refused up front, naming untwine, when `points × bytes-per-point` exceeds the budget. Every external tool in `photo.products` runs through `native.run_tool` with a memory limit.
- Progress: merge tiles done out of the total; `dtm_grid` windows done; cloud 0 to 0.3 writing LAS (per tile), 0.3 to 0.95 untwine (its own percentages); the PDAL fallback an expected-time ramp from a measured rate.
- Keys: `dkey` byte for byte as today (`_hash({"scale", "dense", "region", "v": 1})`); `ckey = hash(dkey, FuseSettings v2, chunk format 2, tile size)` → `<dkey>/c-<ckey>/chunks`; `mkey = hash(ckey, voxel, budget, merge v2)` → `<dkey>/c-<ckey>/m-<mkey>/`. `prepare` returns `layout: 2`, `depthWork`, `chunks`, `work`, `voxel`, `budget`, `areaM2`.
- Report: schema stays `aio.photo-products/1` (additive); `cloud` keeps `points` and `spacingM` and adds `budget`, `groundPoints`, `writer`; `engines.ground` is `smrf-grid`.
- Pack: 0.6.0 → 0.6.1; `PDAL_SPEC = 'libpdal-core==2.10.2 untwine'`; untwine is GPL-3.0-or-later (8 Oct licence decision); GPU add-on 0.1.0 (`packRange >=0.5.0 <0.7.0`) unchanged.
- Repository rules: no em or en dashes in user-facing text; conventional commits (header and body lines at most 100 characters, lower-case subject), each ending with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; no client, site or person names (the repo is public); never commit on `main`.
- Local test load: one heavy run at a time (a photo pytest file, `pnpm check`, a Playwright run); Playwright with `--workers=1`.

## Review Focus

1. **A job started before this version, resumed.** Its `prepare` outputs have no `layout`; every later step must refuse in words ("started by an older version; start the processing again") and reuse nothing, while a fresh start removes the old files and finds the depth maps. Pinned by Task 7 (`test_a_job_started_before_layout_2_is_refused_when_resumed`, `test_a_new_start_clears_an_older_versions_files_and_reuses_the_depth_maps`).
2. **The Fast preset and any one-point-per-voxel input.** The count filter (seen at least twice) would empty a sparse cloud; Fast must keep every sparse point. Pinned by Task 5 (`test_the_sparse_rule_keeps_every_point`) and the existing Fast tests of `test_photo_products.py`, run in Task 7.
3. **Tile seams under the outlier filter.** Points next to a tile edge must not be thinned because their neighbours sit in another tile. Pinned by Task 5 (`test_the_outlier_filter_drops_a_floating_point_and_keeps_the_seams`).
4. **A processing region with the merge in worker processes.** The clip has to cross the process boundary (picklable) and give the same tiles as in-process. Pinned by Task 6 (`test_a_region_clips_the_tiles_in_the_workers_too`).
5. **A large cloud on a computer without untwine** (an older pack, the development PDAL). PDAL must be refused before it starts, with a message that names untwine, never left to swap; and cloud points at the edge of the DTM (no data there) must get class 1, not 2. Pinned by Task 4 (`test_the_pdal_fallback_refuses_a_cloud_too_big_for_the_memory`, `test_points_where_the_dtm_has_no_height_are_not_ground`).

---

## Before you start (every implementer)

- Worktree: `E:\Dev\AIO Software\.claude\worktrees\photo-scale`, branch `fix/photo-scale`. Work only there; never edit the main checkout.
- Python environment: this branch changes `python/`, so the main checkout's venv (which runs main's `aio_pipelines`) must not be used. Once per worktree: `uv sync --frozen --directory python` (creates `python/.venv` in the worktree). Python tests then run as `uv run --frozen --directory python pytest tests/<file>.py -k <name> -q`.
- Node tests: `pnpm vitest run <file>` from the worktree root.
- Parallel batches share this one worktree. The controller commits each finished task with `git commit -F <message file>` (never two commits at once: the lint-staged hook uses the shared stash), and only one heavy test run (a whole photo test file, `pnpm check`, a Playwright run) runs at a time.
- Write commit messages to a scratch file and commit with `-F`; never pass an empty string as an argument in PowerShell.

## File structure

| File                                                                                                                      | Responsibility                                                                                                                              | Task       |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `tools/pipeline-pack/pdal.mjs`, `pdal-lock.json`, `pdal.test.mjs`, `build.mjs`                                            | untwine in the pack: spec, lock, kept files, a functional check                                                                             | 1          |
| `tools/release/native-libs.json`, `tools/release/notices.mjs`, `docs/release/THIRD-PARTY-NOTICES.md`                      | untwine's licence in the notices                                                                                                            | 1          |
| `python/pyproject.toml`, `python/uv.lock`, `.github/workflows/ci.yml`                                                     | pack version 0.6.1; CI exports `AIO_UNTWINE`                                                                                                | 1          |
| `python/src/aio_pipelines/photo/fuse.py`                                                                                  | fusion v2 rule, chunk format 2 (Task 2); merge v2 per tile, the two passes, index, chunk deletion (Task 5); LAS writer removed (Task 8)     | 2, 5, 8    |
| `python/src/aio_pipelines/photo/card.py`                                                                                  | the same agreement rule on the card                                                                                                         | 2          |
| `python/src/aio_pipelines/photo/pool.py`                                                                                  | `abs_tol` into fusion workers (Task 2); merge workers and their count (Task 6)                                                              | 2, 6       |
| `python/src/aio_pipelines/photo/budget.py` (new)                                                                          | budgets, site area, spacing, re-merge spacing, disk estimate                                                                                | 3          |
| `python/src/aio_pipelines/photo/cloud_out.py` (new)                                                                       | classified LAS from the fused tiles, untwine or PDAL to COPC, progress parsing                                                              | 4          |
| `python/src/aio_pipelines/photo/native.py`                                                                                | `untwine` in `TOOLS`; `run_tool(on_output=...)` progress hook                                                                               | 4          |
| `python/src/aio_pipelines/photo/merge.py` (new)                                                                           | `merge_cloud`: parallel passes, pool fallback, safety net; `RegionClip`                                                                     | 6          |
| `python/src/aio_pipelines/photo/products.py`                                                                              | wiring (Tasks 2, 5); layout 2, keys, legacy cleanup, old-job refusal, fuse step (Task 7); step order, dtm, cloud, mesh cap, report (Task 8) | 2, 5, 7, 8 |
| `python/src/aio_pipelines/photo/surface.py`                                                                               | PDAL DTM path removed, `dtm_grid` progress                                                                                                  | 8          |
| `python/src/aio_pipelines/photo/mesh.py`, `texture.py`                                                                    | `meshlab_points`, `mesh_sample`; memory limits on PoissonRecon, SurfaceTrimmer, texrecon                                                    | 8          |
| `docs/architecture/data-conventions.md`, `docs/architecture/contract-changes.md`, `packages/schema/src/photogrammetry.ts` | the conventions, the contract row, the stage order                                                                                          | 9          |
| `apps/desktop/e2e/fixtures.ts`, `apps/desktop/e2e/photo-change.spec.ts`                                                   | `AIO_UNTWINE` for pipeline specs; the report checks                                                                                         | 9          |

## Execution DAG

```
Batch 1 (parallel, no shared files):  T1 pack/untwine   T2 fusion v2 + chunks   T3 budget.py   T4 cloud_out + run_tool hook
Batch 2:                              T5 merge v2 per tile            (needs T2: fuse.py, products.py)
Batch 3:                              T6 parallel budgeted merge      (needs T3, T5: pool.py, merge.py)
Batch 4:                              T7 layout 2 in products         (needs T3, T4, T6)
Batch 5:                              T8 steps, dtm, cloud, mesh, report  (needs T4, T7)
Batch 6:                              T9 docs, schema comment, contract row, e2e  (needs T1, T8)
After the merge checks, in a founder window:  T10 real-data proof  (needs T9)
```

| Task | Depends on | Files it may touch (no other task in its batch touches them)                                                                                                                                                                                  | Packages                                                  |
| ---- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| T1   | none       | `tools/pipeline-pack/pdal.mjs`, `pdal-lock.json`, `pdal.test.mjs`, `build.mjs`; `tools/release/native-libs.json`, `notices.mjs`; `docs/release/THIRD-PARTY-NOTICES.md`; `python/pyproject.toml`, `python/uv.lock`; `.github/workflows/ci.yml` | pack tooling, release tooling, python (version)           |
| T2   | none       | `photo/fuse.py`, `photo/card.py`, `photo/pool.py`, `photo/products.py`; `tests/test_photo_dense.py`, `tests/test_photo_card.py`                                                                                                               | python                                                    |
| T3   | none       | `photo/budget.py` (new); `tests/test_photo_budget.py` (new)                                                                                                                                                                                   | python                                                    |
| T4   | none       | `photo/cloud_out.py` (new), `photo/native.py`; `tests/test_photo_cloud_out.py` (new)                                                                                                                                                          | python                                                    |
| T5   | T2         | `photo/fuse.py`, `photo/products.py`; `tests/test_photo_dense.py`, `tests/test_photo_surface.py`                                                                                                                                              | python                                                    |
| T6   | T3, T5     | `photo/merge.py` (new), `photo/pool.py`; `tests/test_photo_merge.py` (new)                                                                                                                                                                    | python                                                    |
| T7   | T3, T4, T6 | `photo/products.py`; `tests/test_photo_products.py`, `tests/test_photo_pool.py`                                                                                                                                                               | python                                                    |
| T8   | T4, T7     | `photo/products.py`, `photo/surface.py`, `photo/mesh.py`, `photo/texture.py`, `photo/fuse.py`; `tests/test_photo_products.py`, `tests/test_photo_surface.py`, `tests/test_photo_mesh.py`, `tests/test_photo_dense.py`                         | python                                                    |
| T9   | T1, T8     | `docs/architecture/data-conventions.md`, `docs/architecture/contract-changes.md`, `packages/schema/src/photogrammetry.ts`, `apps/desktop/e2e/fixtures.ts`, `apps/desktop/e2e/photo-change.spec.ts`                                            | docs, `@aio/schema` (comment and order only), desktop e2e |
| T10  | T9         | none in git (a session note records the outcome)                                                                                                                                                                                              | none                                                      |

**Critical path:** T2 → T5 → T6 → T7 → T8 → T9 → T10. T1, T3 and T4 run beside T2 and are off the critical path.

**Tests per task:** each task's steps list them; in short: T1 `pdal.test.mjs`, `notices.test.mjs`, `notices.mjs --check`, a real `pdal.mjs --out` install with the untwine check; T2 `test_photo_dense.py`, `test_photo_card.py`, `test_photo_pool.py -k fuse`; T3 `test_photo_budget.py`; T4 `test_photo_cloud_out.py`; T5 `test_photo_dense.py`, `test_photo_surface.py`, `test_photo_products.py`; T6 `test_photo_merge.py`; T7 `test_photo_products.py`, `test_photo_pool.py`; T8 `test_photo_products.py`, `test_photo_surface.py`, `test_photo_mesh.py`, `test_photo_dense.py`, then every `test_photo_*.py` file and ruff; T9 `pnpm check` and the e2e below.

**E2E specs:** `apps/desktop/e2e/photo-change.spec.ts` changes (Task 9); `fixtures.ts` gains `UNTWINE`, `hasUntwine` and `AIO_UNTWINE` in `PIPELINE_ENV`. No spec is added. `photo-products.spec.ts` asks for no cloud and is unchanged. The photo e2e fake (`e2e/photo-fake/aio_photo_fake.py`) lists stage names, not their order, and is left as it is.

**Contract change:** yes. A row in `docs/architecture/contract-changes.md` (Task 9): pipeline pack layout `tools/pdal/` gains `untwine` and `AIO_UNTWINE`; `aio.photo-products/1` gains the optional `cloud.budget`, `cloud.groundPoints`, `cloud.writer` and `engines.ground` is `smrf-grid` only; `photo.products` runs `dtm` before `cloud`; `PhotoStageName` lists the stages in the new order (same values).

---

### Task 1: Pipeline pack 0.6.1 with untwine

**Files:**

- Modify: `tools/pipeline-pack/pdal.mjs:1-14` (header comment), `:38` (`PDAL_SPEC`), `:107-114` (`keepWindows`), `:333-352` (`installPdal`, `pdalExe`), after `:377` (new `untwineExe`, `tinyLas`, `checkUntwine`), `:429-447` (CLI)
- Modify: `tools/pipeline-pack/pdal-lock.json` (regenerated, never by hand)
- Modify: `tools/pipeline-pack/pdal.test.mjs:1-75`
- Modify: `tools/pipeline-pack/build.mjs:44` (import), `:465-469` (check)
- Modify: `tools/release/native-libs.json:947-955` (the `pdal (conda-forge)` entry)
- Modify: `tools/release/notices.mjs:320` (GPL paragraph), `:336` (PDAL section text)
- Modify: `docs/release/THIRD-PARTY-NOTICES.md` (regenerated)
- Modify: `python/pyproject.toml:3`, `python/uv.lock:27` (by `uv lock`)
- Modify: `.github/workflows/ci.yml:360`

**Interfaces:**

- Consumes: nothing from other tasks.
- Produces: `export function untwineExe(dest: string, platform?: string): string`; `export function tinyLas(): Buffer`; `export function checkUntwine(exe: string): string | null` (a problem, or null); the CLI `node tools/pipeline-pack/pdal.mjs --out <folder>` prints `AIO_PDAL=<path>` and `AIO_UNTWINE=<path>` lines (Tasks 4, 9 and 10 use them); a pack whose `tools/pdal/Library/bin/untwine.exe` (Windows) or `tools/pdal/bin/untwine` (macOS) exists, which `native.find_tool("untwine")` finds (Task 4).

- [ ] **Step 1: Write the failing tests**

Replace the first `describe` block's version line and add the new cases in `tools/pipeline-pack/pdal.test.mjs`:

```js
import { describe, expect, it } from 'vitest';
import {
  explicitSpec,
  keepWindows,
  lockedPackages,
  MICROMAMBA,
  otoolLibs,
  PDAL_SPEC,
  PLATFORMS,
  tinyLas,
  untwineExe,
} from './pdal.mjs';

describe('the PDAL lock', () => {
  it('has every pack platform, each with PDAL, untwine, GDAL and PROJ pinned by SHA-256', () => {
    const pdalVersion = /libpdal-core==(\S+)/.exec(PDAL_SPEC)?.[1];
    expect(pdalVersion).toBe('2.10.2');
    for (const platform of Object.keys(PLATFORMS)) {
      const pkgs = lockedPackages(platform);
      const names = pkgs.map((p) => p.name);
      expect(names).toEqual(
        expect.arrayContaining(['libpdal-core', 'untwine', 'libgdal-core', 'proj']),
      );
      expect(pkgs.find((p) => p.name === 'libpdal-core').version).toBe(pdalVersion);
      expect(pkgs.find((p) => p.name === 'untwine').version).toMatch(/^1\.5\./);
      expect(names).not.toContain('pdal'); // the full PDAL package with its plugins stays out
      for (const p of pkgs) {
        expect(p.url).toMatch(/^https:\/\/conda\.anaconda\.org\/conda-forge\//);
        expect(p.url).toMatch(new RegExp(`/(${PLATFORMS[platform].subdir}|noarch)/`));
        expect(p.sha256).toMatch(/^[a-f0-9]{64}$/);
      }
      expect(MICROMAMBA.assets[platform].sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });
```

(the rest of that `describe` is unchanged). In the second `describe`, add to the first `it`:

```js
expect(keepWindows('Library/bin/untwine.exe')).toBe('Library/bin/untwine.exe');
```

and append a new `describe`:

```js
describe('the untwine check', () => {
  it('finds untwine beside pdal', () => {
    expect(untwineExe('/p', 'win32-x64').replaceAll('\\', '/')).toBe('/p/Library/bin/untwine.exe');
    expect(untwineExe('/p', 'darwin-arm64').replaceAll('\\', '/')).toBe('/p/bin/untwine');
  });

  it('writes a three point LAS 1.4 file in point format 7', () => {
    const b = tinyLas();
    expect(b.subarray(0, 4).toString('latin1')).toBe('LASF');
    expect([b[24], b[25]]).toEqual([1, 4]);
    expect(b[104]).toBe(7);
    expect(b.readUInt16LE(105)).toBe(36);
    expect(b.readUInt16LE(94)).toBe(375);
    expect(b.readUInt32LE(96)).toBe(375);
    expect(b.readBigUInt64LE(247)).toBe(3n);
    expect(b.length).toBe(375 + 3 * 36);
    expect(b.readDoubleLE(179)).toBe(1); // max x, metres
    expect(b[375 + 16]).toBe(2); // the first point's class
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run tools/pipeline-pack/pdal.test.mjs`
Expected: FAIL: `tinyLas` and `untwineExe` are not exported, the lock has no `untwine`, the version regex sees `2.10.2` but `untwine` is missing from `names`.

- [ ] **Step 3: Implement**

In `tools/pipeline-pack/pdal.mjs`:

1. Header comment (lines 1-4): "PDAL and untwine for the pipeline pack: conda-forge's prebuilt `libpdal-core` (the `pdal` command-line tool with GDAL, PROJ and GEOS, no plugins) and `untwine` (the out-of-core COPC builder, GPL-3.0-or-later), installed by micromamba from an explicit lock and pruned to what the tools run: the programs, their shared libraries and the PROJ and GDAL data."
2. Line 38: `export const PDAL_SPEC = 'libpdal-core==2.10.2 untwine';`
3. `keepWindows` (lines 107-114):

```js
export function keepWindows(rel) {
  const r = rel.toLowerCase();
  if (r === 'library/bin/pdal.exe') return 'Library/bin/pdal.exe';
  if (r === 'library/bin/untwine.exe') return 'Library/bin/untwine.exe';
  if (/^library\/share\/(proj|gdal)\//.test(r)) return rel;
  const dll = /^(library\/bin\/)?([^/]+\.dll)$/.exec(r);
  if (dll && !SKIP_DLL.test(dll[2])) return `Library/bin/${basename(rel)}`;
  return null;
}
```

4. `installPdal` (line 338): `prune: { windows: () => keepWindows, mac: { programs: ['pdal', 'untwine'], share: ['proj', 'gdal'] } },` and its log line `PDAL and untwine: ${packages} conda-forge packages, ${files} files kept`.
5. After `checkPdal` (line 377) add:

```js
/** The untwine program inside an installPdal folder (beside pdal). */
export function untwineExe(dest, platform = `${process.platform}-${process.arch}`) {
  return platform.startsWith('win32')
    ? join(dest, 'Library', 'bin', 'untwine.exe')
    : join(dest, 'bin', 'untwine');
}

/** A LAS 1.4 file of three points (point format 7, millimetre scale, class 2) for the check. */
export function tinyLas() {
  const header = 375;
  const rec = 36;
  const points = [
    [0, 0, 0],
    [1000, 0, 0],
    [0, 1000, 500],
  ];
  const b = Buffer.alloc(header + points.length * rec);
  b.write('LASF', 0, 'latin1');
  b.writeUInt16LE(0x10, 6); // global encoding: WKT
  b[24] = 1;
  b[25] = 4;
  b.write('Quadrion AI', 26, 'latin1');
  b.write('pack check', 58, 'latin1');
  b.writeUInt16LE(1, 90);
  b.writeUInt16LE(2026, 92);
  b.writeUInt16LE(header, 94);
  b.writeUInt32LE(header, 96);
  b.writeUInt32LE(0, 100);
  b[104] = 7;
  b.writeUInt16LE(rec, 105);
  for (let i = 0; i < 3; i++) b.writeDoubleLE(0.001, 131 + 8 * i);
  [1, 0, 1, 0, 0.5, 0].forEach((v, i) => b.writeDoubleLE(v, 179 + 8 * i));
  b.writeBigUInt64LE(BigInt(points.length), 247);
  b.writeBigUInt64LE(BigInt(points.length), 255);
  points.forEach(([x, y, z], i) => {
    const o = header + i * rec;
    b.writeInt32LE(x, o);
    b.writeInt32LE(y, o + 4);
    b.writeInt32LE(z, o + 8);
    b[o + 14] = 0x11; // return 1 of 1
    b[o + 16] = 2; // ground
  });
  return b;
}

/**
 * Whether an installed untwine works: it turns tinyLas() into a COPC file. Answers the problem in
 * words, or null.
 */
export function checkUntwine(exe) {
  if (!existsSync(exe)) return `untwine is missing at ${exe}`;
  const dir = mkdtempSync(join(tmpdir(), 'quntwine-'));
  try {
    const las = join(dir, 'check.las');
    const out = join(dir, 'check.copc.laz');
    writeFileSync(las, tinyLas());
    const r = spawnSync(exe, ['-i', las, '-o', out, '--temp_dir', join(dir, 'tmp')], {
      encoding: 'utf8',
      env: pdalEnv(exe),
      timeout: 120_000,
    });
    if (r.error) return `untwine could not start: ${r.error.message}`;
    if (r.status !== 0) {
      const last = `${r.stderr}\n${r.stdout}`.trim().split('\n').pop();
      return `untwine failed (exit ${r.status}): ${last}`;
    }
    if (!existsSync(out) || readFileSync(out).subarray(0, 4).toString('latin1') !== 'LASF')
      return 'untwine wrote no COPC file';
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
```

6. The CLI branch (lines 436-441):

```js
    else if (values.out) {
      const platform = `${process.platform}-${process.arch}`;
      const dest = resolve(values.out);
      const exe = await installPdal({ platform, cache, dest });
      const { version, missing } = checkPdal(exe);
      if (missing.length > 0) throw new Error(`PDAL lacks ${missing.join(', ')}`);
      const untwine = untwineExe(dest, platform);
      const problem = checkUntwine(untwine);
      if (problem) throw new Error(problem);
      say(`${version}\nAIO_PDAL=${exe}\nAIO_UNTWINE=${untwine}`);
    } else throw new Error('pass --out <folder> or --lock');
```

and the usage comment at line 9-10: `PDAL and untwine for this machine into <folder> (development: AIO_PDAL and AIO_UNTWINE, printed at the end)`.

In `tools/pipeline-pack/build.mjs`, line 44: `import { checkPdal, checkUntwine, installPdal, untwineExe } from './pdal.mjs';`, and lines 465-469:

```js
if (pdal) {
  const { version: pdalVersion, missing } = checkPdal(pdal);
  if (missing.length > 0) fail(`PDAL lacks ${missing.join(', ')}`);
  say(`  ${pdalVersion}`);
  const untwineProblem = checkUntwine(untwineExe(join(tmp, 'tools', 'pdal'), platform));
  if (untwineProblem) fail(untwineProblem);
  say('  untwine: turns a LAS into a COPC');
}
```

Re-solve the lock (online; micromamba cached in `%TEMP%\quadrion-conda`):

Run: `node tools/pipeline-pack/pdal.mjs --lock`
Expected: three lines `win-64: N packages`, `osx-arm64: ...`, `osx-64: ...` and `Wrote .../pdal-lock.json`; `git diff --stat tools/pipeline-pack/pdal-lock.json` shows `untwine 1.5.1` added on all three and `sqlite` 3.53.4 → 3.54.0. If the solver pulls the full `pdal` package, stop and report (the spec's facts say it does not).

- [ ] **Step 4: Run the tests and see them pass**

Run: `pnpm vitest run tools/pipeline-pack/pdal.test.mjs tools/pipeline-pack/build.test.mjs`
Expected: PASS.

- [ ] **Step 5: Install it for real and run the check**

Run: `node tools/pipeline-pack/pdal.mjs --out "C:\Users\D\AppData\Local\Temp\quadrion-pdal-0.6.1"`
Expected: the last three lines are `pdal 2.10.2 ...`, `AIO_PDAL=...\Library\bin\pdal.exe`, `AIO_UNTWINE=...\Library\bin\untwine.exe`; exit 0. Keep this folder: Tasks 4, 9 and 10 point `AIO_PDAL` and `AIO_UNTWINE` at it.

- [ ] **Step 6: Licence notices**

In `tools/release/native-libs.json`, the `pdal (conda-forge)` entry (lines 947-955) becomes:

```json
    {
      "name": "pdal (conda-forge)",
      "version": "2.10.2 (libpdal-core, conda-forge) with untwine 1.5.1",
      "spdx": "BSD-3-Clause AND MIT AND Apache-2.0 AND LGPL-2.1-only AND GPL-2.0-or-later AND GPL-3.0-or-later AND MPL-1.1 AND Zlib AND curl AND blessing AND HPND AND 0BSD AND BSD-2-Clause AND ISC AND bzip2-1.0.6 AND IJG AND libpng-2.0 AND (Apache-2.0 WITH LLVM-exception)",
      "source": "https://github.com/conda-forge/pdal-feedstock",
      "files": ["tools/pdal/**"],
      "linkage": "shared",
      "includes": [{ "name": "untwine (the COPC builder, github.com/hobuinc/untwine)", "spdx": "GPL-3.0-or-later" }],
      "note": "conda-forge's prebuilt PDAL with GDAL, PROJ, GEOS and their libraries, and conda-forge's untwine (tools/pipeline-pack/pdal.mjs); every package with its licence is in tools/pipeline-pack/pdal-lock.json and the pack's tools/pdal/conda-packages.json, their licence files in tools/pdal/licenses"
    },
```

In `tools/release/notices.mjs`, the GPL paragraph (line 320) names the tool after ffmpeg: "..., the ffmpeg tool (\`tools/ffmpeg\`, a GPL build with x264 and x265), the untwine tool (\`tools/pdal\`, GPL-3.0-or-later) and, on macOS, ...". The PDAL section (line 336) becomes "The \`pdal\` and \`untwine\` tools of the pack (\`tools/pdal\`), installed from conda-forge's \`libpdal-core\` and \`untwine\` with the packages they need; ...".

Run: `node tools/release/notices.mjs` then `node tools/release/notices.mjs --check` then `pnpm vitest run tools/release/notices.test.mjs`
Expected: the notices file is rewritten with an `untwine` row; `--check` exits 0; the tests PASS.

- [ ] **Step 7: Pack version and CI**

`python/pyproject.toml` line 3: `version = "0.6.1"`. Then (no pytest running at the time) run `uv lock --directory python`; expected: `python/uv.lock` changes only the `aio-pipelines` version line (`git diff python/uv.lock` shows one changed line). `.github/workflows/ci.yml` line 360: `grep -E '^(AIO_PDAL|AIO_UNTWINE)=' "$RUNNER_TEMP/pdal.log" >> "$GITHUB_ENV"`.

The pack's unpacked budget is checked by CI's `pack` job (`build.mjs`, which now also runs `checkUntwine`); untwine adds under 1 MB to an archive budget of 500 MB (0.6.0: 448.7 MB). The archive itself is built only when the founder asks (Task 10 notes it).

Run: `pnpm format:check` and `pnpm lint`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add tools/pipeline-pack/pdal.mjs tools/pipeline-pack/pdal-lock.json tools/pipeline-pack/pdal.test.mjs tools/pipeline-pack/build.mjs tools/release/native-libs.json tools/release/notices.mjs docs/release/THIRD-PARTY-NOTICES.md python/pyproject.toml python/uv.lock .github/workflows/ci.yml
git commit -F msg.txt
```

`msg.txt`:

```
feat(pack): untwine in the pipeline pack, version 0.6.1

conda-forge's untwine 1.5.1 beside libpdal-core 2.10.2 in tools/pdal: the lock, the kept
files, a check that turns a three point LAS into a COPC, its GPL-3.0-or-later notice, and
AIO_UNTWINE from pdal.mjs --out (CI exports it with AIO_PDAL).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

### Task 2: Fusion v2 and chunk format 2

**Files:**

- Modify: `python/src/aio_pipelines/photo/fuse.py:28-32` (`FuseSettings`), `:57-80` (`consistent`, line 76), `:83-115` (`PointTiles.__init__`, `add`, `chunk_tiles`), `:117-145` (`merge` reads chunks), new functions after `:32`
- Modify: `python/src/aio_pipelines/photo/card.py:277`
- Modify: `python/src/aio_pipelines/photo/pool.py:13-21` (import `math`), `:275-292` (`fuse_state`), `:334-352` (`init_fuse`)
- Modify: `python/src/aio_pipelines/photo/products.py:603-628` (inside `_fuse`)
- Test: `python/tests/test_photo_dense.py:16-23` (imports), after `:262` (new tests)
- Test: `python/tests/test_photo_card.py:121-139`

**Interfaces:**

- Consumes: nothing from other tasks.
- Produces (Tasks 5 to 8 rely on these exact names):
  - `FuseSettings(tolerance: float = 0.01, min_agree: int = 2, neighbours: int = 6, abs_tol: float = math.inf)`, frozen; `FuseSettings.for_run(gsd: float, scale: float) -> FuseSettings` (`abs_tol = 3 * gsd / scale`, default settings when `scale` is 0).
  - `agree_limit(z: np.ndarray, settings: FuseSettings) -> np.ndarray` = `np.minimum(settings.tolerance * z, settings.abs_tol)`.
  - `CHUNK_FORMAT = 2`; `pack_chunk(xyz, rgb, normal, corner: tuple[float, float]) -> dict[str, np.ndarray]` (keys `format`, `base`, `xy`, `z`, `normal`, `rgb`); `unpack_chunk(f: Mapping[str, np.ndarray]) -> tuple[np.ndarray, np.ndarray, np.ndarray]` (xyz float64, rgb uint8, normal float32).
  - `PointTiles(root: Path, tile: float, chunks: Path | None = None)` with attribute `chunks_dir` (default `root / "chunks"`).
  - `pool.fuse_state(model, scale, depth_dir, store_root, tile_m, abs_tol=math.inf)`; `pool.init_fuse(project, run_id, scale, depth_dir, store_root, tile_m, abs_tol, threads, addon=None)`.

- [ ] **Step 1: Write the failing tests**

`python/tests/test_photo_dense.py`, imports (lines 16-23):

```python
from aio_pipelines.photo.fuse import (
    CHUNK_FORMAT,
    FuseSettings,
    PointTiles,
    agree_limit,
    consistent,
    normals_of,
    pack_chunk,
    unpack_chunk,
    voxel_mean,
    world_points,
)
```

After `test_fusion_keeps_points_other_photos_confirm` (line 262) add:

```python
def test_fusion_v2_asks_two_photos_to_agree_within_three_gsd():
    v2 = FuseSettings.for_run(0.02, 0.5)  # the founder's run: GSD 2 cm, matching at half size
    assert v2.min_agree == 2 and v2.abs_tol == pytest.approx(0.12)
    # 1 % of the depth up to 12 cm: 10 cm at 10 m, 12 cm from 12 m on
    np.testing.assert_allclose(agree_limit(np.array([10.0, 34.0, 100.0]), v2), [0.1, 0.12, 0.12])
    assert FuseSettings.for_run(0.02, 0.0).abs_tol == math.inf  # Fast: no dense matching
    assert FuseSettings().min_agree == 2


def test_one_neighbour_alone_confirms_nothing():
    from aio_pipelines.photo import card as K

    s = ps.scene()
    a, b, c = s.views[5], s.views[6], s.views[4]
    cam = a.camera
    da = D.zbuffer(cam, a, s.points)
    near = [(v, cam, D.zbuffer(cam, v, s.points)) for v in (b, c)]
    b_np = K.numpy_backend()
    _, _, keep_one = K.fuse_arrays(b_np, a, cam, da, near[:1], FuseSettings(), K.Rays(b_np))
    _, _, keep_two = K.fuse_arrays(b_np, a, cam, da, near, FuseSettings(), K.Rays(b_np))
    assert not keep_one.any() and keep_two.sum() > 1000


def test_a_chunk_round_trips_within_a_tenth_of_a_millimetre():
    rng = np.random.default_rng(4)
    n = 10_000
    # a 41 m tile far from the origin, at 1,800 m elevation: the worst case for float32
    xyz = np.column_stack(
        [rng.uniform(4100.0, 4141.0, n), rng.uniform(-8200.0, -8159.0, n), rng.uniform(1800.0, 1900.0, n)]
    )
    nrm = rng.normal(size=(n, 3))
    nrm /= np.linalg.norm(nrm, axis=1, keepdims=True)
    rgb = rng.integers(0, 256, (n, 3)).astype(np.uint8)
    packed = pack_chunk(xyz, rgb, nrm, (4100.0, -8200.0))
    assert int(packed["format"]) == CHUNK_FORMAT == 2
    assert sum(packed[k].nbytes for k in ("xy", "z", "normal", "rgb")) == 18 * n
    back, back_rgb, back_n = unpack_chunk(packed)
    assert np.abs(back - xyz).max() < 1e-4
    assert np.array_equal(back_rgb, rgb) and back_n.dtype == np.float32
    assert np.abs(back_n - nrm).max() <= 0.5 / 127 + 1e-6


def test_fusion_writes_chunk_format_2(tmp_path):
    store = PointTiles(tmp_path / "m", 4.0, chunks=tmp_path / "c" / "chunks")
    xyz = np.array([[0.5, 0.5, 1.0], [5.0, 0.5, 2.0], [5.5, 0.7, 2.5]])
    store.add("v1", xyz, np.zeros((3, 3), np.uint8), np.tile(np.float32([0, 0, 1]), (3, 1)))
    assert store.chunk_tiles() == ["0_0", "1_0"]
    with np.load(tmp_path / "c" / "chunks" / "1_0" / "v1.npz") as f:
        assert f["xy"].dtype == np.float32 and f["normal"].dtype == np.int8
        got, _, nrm = unpack_chunk(f)
    np.testing.assert_allclose(got, xyz[1:], atol=1e-6)
    np.testing.assert_allclose(nrm, [[0, 0, 1], [0, 0, 1]])
    assert not (tmp_path / "m" / "chunks").exists()
```

`python/tests/test_photo_card.py`, replace `test_fusing_a_photo_keeps_the_points_of_the_reference` (lines 121-139) with a version over both rules (the card case still skips without `AIO_TEST_ADDON`):

```python
@pytest.mark.parametrize("rule", ["default", "three-gsd"])
def test_fusing_a_photo_keeps_the_points_of_the_reference(backend, rule):
    s = ps.scene()
    a, others = s.views[5], [s.views[4], s.views[6]]
    cam = a.camera
    da = D.zbuffer(cam, a, s.points)
    near = [(v, cam, D.zbuffer(cam, v, s.points)) for v in others]
    settings = FuseSettings() if rule == "default" else FuseSettings.for_run(ps.GSD / 2, 1.0)
    pts, agree = consistent(a, cam, da, near, settings)
    nrm = normals_of(pts, a.centre)
    good = np.isfinite(da) & (agree >= settings.min_agree)
    ok = np.isfinite(nrm[good]).all(1)
    want_keep = np.zeros(da.shape, bool)
    want_keep[good] = ok
    xyz, normals, keep = K.fuse_arrays(backend, a, cam, da, near, settings, K.Rays(backend))
    assert keep.shape == da.shape and (keep == want_keep).mean() > 0.9999
    assert xyz.shape == (int(keep.sum()), 3) and normals.shape == xyz.shape and normals.dtype == np.float32
    same = keep & want_keep
    np.testing.assert_allclose(xyz[same[keep]], pts[same], atol=1e-6)
    np.testing.assert_allclose(normals[same[keep]], nrm[same].astype(np.float32), atol=1e-4)
```

- [ ] **Step 2: Run them and see them fail**

Run: `uv run --frozen --directory python pytest tests/test_photo_dense.py tests/test_photo_card.py -q`
Expected: FAIL at import: `cannot import name 'CHUNK_FORMAT' from 'aio_pipelines.photo.fuse'` (and `FuseSettings.for_run` missing).

- [ ] **Step 3: Implement**

`fuse.py`: add `from collections.abc import Callable, Iterator, Mapping` and `from ..runtime import JobError, replace_over`; replace `FuseSettings` (lines 28-32) with:

```python
@dataclass(frozen=True)
class FuseSettings:
    """When photos agree (fusion v2, 13 Oct 2026): a pixel is kept when at least ``min_agree`` of
    its ``neighbours`` see the same surface there, within ``tolerance`` of the depth and at most
    ``abs_tol`` metres (3 x the matching GSD on a run; infinite when not set)."""

    tolerance: float = 0.01
    min_agree: int = 2
    neighbours: int = 6
    abs_tol: float = math.inf

    @classmethod
    def for_run(cls, gsd: float, scale: float) -> FuseSettings:
        """The settings of a run matched at ``scale`` (a fraction of the photo) with photo GSD ``gsd``."""
        return cls(abs_tol=3.0 * gsd / scale) if scale else cls()


def agree_limit(z: np.ndarray, settings: FuseSettings) -> np.ndarray:
    """How far apart two depths may be and still agree, at depth ``z``."""
    return np.minimum(settings.tolerance * z, settings.abs_tol)


CHUNK_FORMAT = 2


def pack_chunk(
    xyz: np.ndarray, rgb: np.ndarray, normal: np.ndarray, corner: tuple[float, float]
) -> dict[str, np.ndarray]:
    """One tile's points as chunk format 2, 18 bytes a point: x and y as float32 offsets from the
    tile's corner, z as float32 above the chunk's whole-metre base (so float32 keeps 0.1 mm at any
    elevation), normals as int8 x 127, colours as uint8."""
    z0 = math.floor(float(xyz[:, 2].min())) if len(xyz) else 0.0
    base = np.array([corner[0], corner[1], z0], np.float64)
    n = np.nan_to_num(np.asarray(normal, np.float64))
    return {
        "format": np.array(CHUNK_FORMAT, np.int16),
        "base": base,
        "xy": (xyz[:, :2] - base[:2]).astype(np.float32),
        "z": (xyz[:, 2] - base[2]).astype(np.float32),
        "normal": np.clip(np.round(n * 127.0), -127, 127).astype(np.int8),
        "rgb": np.asarray(rgb, np.uint8),
    }


def unpack_chunk(f: Mapping[str, np.ndarray]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """A chunk back as world xyz (float64), colours (uint8) and normals (float32)."""
    if int(f["format"]) != CHUNK_FORMAT:
        raise JobError("A fusion chunk of an older format was found; start the processing again.")
    base = np.asarray(f["base"], np.float64)
    z = f["z"]
    xyz = np.empty((len(z), 3))
    xyz[:, :2] = f["xy"].astype(np.float64) + base[:2]
    xyz[:, 2] = z.astype(np.float64) + base[2]
    return xyz, np.asarray(f["rgb"], np.uint8), f["normal"].astype(np.float32) / 127.0
```

`consistent`, line 76: `good = inside & np.isfinite(dz) & (np.abs(dz - z) <= agree_limit(z, settings))`.

`PointTiles` (lines 83-115):

```python
class PointTiles:
    """Points in square ground tiles. Fusion writes chunks (chunk format 2) to
    ``chunks/<tile>/<name>.npz`` under ``chunks`` (``root/chunks`` unless given); ``merge`` writes
    ``fused/<tile>.npz`` under ``root``. Coordinates are model (grid frame) metres."""

    def __init__(self, root: Path, tile: float, chunks: Path | None = None):
        self.root = root
        self.tile = float(tile)
        self.chunks_dir = chunks if chunks is not None else root / "chunks"

    def key(self, x: float, y: float) -> tuple[int, int]:
        return math.floor(x / self.tile), math.floor(y / self.tile)

    def add(self, name: str, xyz: np.ndarray, rgb: np.ndarray, normal: np.ndarray) -> int:
        if not len(xyz):
            return 0
        tx = np.floor(xyz[:, 0] / self.tile).astype(np.int64)
        ty = np.floor(xyz[:, 1] / self.tile).astype(np.int64)
        order = np.lexsort((ty, tx))
        tx, ty = tx[order], ty[order]
        xyz, rgb, normal = xyz[order], rgb[order], normal[order]
        cut = np.nonzero((np.diff(tx) != 0) | (np.diff(ty) != 0))[0] + 1
        for a, b in zip(np.r_[0, cut], np.r_[cut, len(tx)], strict=True):
            d = self.chunks_dir / f"{tx[a]}_{ty[a]}"
            d.mkdir(parents=True, exist_ok=True)
            tmp = d / f".{name}.tmp.npz"
            corner = (float(tx[a]) * self.tile, float(ty[a]) * self.tile)
            np.savez(tmp, **pack_chunk(xyz[a:b], rgb[a:b], normal[a:b], corner))
            replace_over(tmp, d / f"{name}.npz")
        return len(xyz)

    def chunk_tiles(self) -> list[str]:
        base = self.chunks_dir
        if not base.is_dir():
            return []
        return sorted(p.name for p in base.iterdir() if p.is_dir() and not p.name.startswith("."))
```

In `merge` (lines 133-138) read the chunks with `unpack_chunk`:

```python
                parts = []
                for p in sorted((self.chunks_dir / name).glob("*.npz")):
                    if p.name.startswith("."):
                        continue
                    with np.load(p) as f:
                        parts.append(unpack_chunk(f))
                xyz = np.concatenate([a for a, _, _ in parts])
                rgb = np.concatenate([c for _, c, _ in parts])
                nrm = np.concatenate([n for _, _, n in parts])
```

`card.py` line 277:

```python
            limit = xp.minimum(settings.tolerance * zz, settings.abs_tol)
            got += (inside & xp.isfinite(dz) & (xp.abs(dz - zz) <= limit)).astype(xp.int32)
```

`pool.py`: `import math` at the top; `fuse_state` and `init_fuse`:

```python
def fuse_state(
    model, scale: float, depth_dir, store_root, tile_m: float, abs_tol: float = math.inf
) -> dict[str, Any]:
    """What fusing one photo needs: the same in the job's process and in a worker. ``store_root``
    is the folder that holds ``chunks/``; ``abs_tol`` the run's agreement limit in metres."""
    from .dense import select_pairs
    from .fuse import FuseSettings, PointTiles

    settings = FuseSettings(abs_tol=abs_tol)
    store = PointTiles(store_root, tile_m)
    marks = store.chunks_dir / ".done"
    marks.mkdir(parents=True, exist_ok=True)
    return {
        "model": model,
        "scale": scale,
        "settings": settings,
        "near": select_pairs(model, settings.neighbours),
        "cams": {v.id: v.camera.scaled(scale) for v in model.views},
        "depth": depth_dir,
        "store": store,
        "marks": marks,
    }
```

```python
def init_fuse(
    project: str,
    run_id: str,
    scale: float,
    depth_dir: str,
    store_root: str,
    tile_m: float,
    abs_tol: float,
    threads: int,
    addon: str | None = None,
) -> None:
    from pathlib import Path

    from .scene import load_run

    cap_threads(threads)
    _W.clear()
    model = load_run(Path(project), run_id).model
    _W.update(fuse_state(model, scale, Path(depth_dir), Path(store_root), tile_m, abs_tol))
    attach_card(_W, addon)
```

`products.py` `_fuse` (lines 603-628): add `from .fuse import FuseSettings` next to `from . import pool`, then

```python
        abs_tol = FuseSettings.for_run(s["gsd"], s["scale"]).abs_tol
        state = pool.fuse_state(run.model, s["scale"], depth_dir, store.root, s["tileM"], abs_tol)
```

and in the `args` lambda insert `abs_tol,` between `s["tileM"],` and `pool.worker_threads(n),`.

- [ ] **Step 4: Run the tests and see them pass**

Run: `uv run --frozen --directory python pytest tests/test_photo_dense.py tests/test_photo_card.py -q`
Expected: PASS (the `card` cases SKIP without `AIO_TEST_ADDON`).

Run: `uv run --frozen --directory python pytest tests/test_photo_pool.py -k fuse -q`
Expected: PASS: two workers still fuse the cloud of one, through chunk format 2.

- [ ] **Step 5: Commit**

```bash
git add python/src/aio_pipelines/photo/fuse.py python/src/aio_pipelines/photo/card.py python/src/aio_pipelines/photo/pool.py python/src/aio_pipelines/photo/products.py python/tests/test_photo_dense.py python/tests/test_photo_card.py
git commit -F msg.txt
```

```
feat(photo): fusion v2 agreement and chunk format 2

Two neighbouring photos must agree, within 1 % of the depth and at most 3 GSD, on the CPU
and on the card. Chunks are 18 bytes a point: float32 offsets from the tile corner and a
whole-metre base, int8 normals, uint8 colours.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

### Task 3: Point budget, site area and disk estimate

**Files:**

- Create: `python/src/aio_pipelines/photo/budget.py`
- Test: `python/tests/test_photo_budget.py`

**Interfaces:**

- Consumes: nothing.
- Produces (Tasks 6 and 7):
  - `BUDGET: dict[str, int] = {"fast": 0, "standard": 150_000_000, "high": 400_000_000}`; `REMERGE_OVER = 1.2`.
  - `site_area(xy: np.ndarray, region=None, cell: float = 2.0) -> float` (square metres; `region` a shapely polygon in the same coordinates as `xy`).
  - `budget_voxel(gsd: float, scale: float, area: float, budget: int) -> float`.
  - `needs_remerge(points: int, budget: int) -> bool`; `remerge_voxel(voxel: float, points: int, budget: int) -> float`.
  - `disk_need(*, photos: int, pixels: int, scale: float, area: float, gsd: float, ortho_res: float, dsm_res: float, voxel: float, budget: int, sparse_points: int, cloud: bool) -> int`.

- [ ] **Step 1: Write the failing tests**

`python/tests/test_photo_budget.py`:

```python
"""photo/budget.py: the point budget per preset, the site's area and the disk a run needs."""

from __future__ import annotations

import math

import numpy as np
import pytest
from shapely.geometry import box

from aio_pipelines.photo import budget as B


def _block(x0: float, x1: float, y0: float, y1: float, cell: float = 2.0) -> np.ndarray:
    """Two points in every 2 m cell of a rectangle."""
    gx, gy = np.meshgrid(np.arange(x0 + 0.5, x1, cell), np.arange(y0 + 0.5, y1, cell))
    pts = np.column_stack([gx.ravel(), gy.ravel()])
    return np.concatenate([pts, pts + 0.3])


def test_the_budgets_of_the_presets():
    assert B.BUDGET == {"fast": 0, "standard": 150_000_000, "high": 400_000_000}


def test_the_site_is_the_occupied_cells_dilated_by_two():
    xy = _block(0, 100, 0, 50)  # 50 x 25 cells of 2 m
    lone = np.column_stack([500.0 + 10 * np.arange(30), np.full(30, 500.0)])  # one point a cell
    area = B.site_area(np.concatenate([xy, lone]))
    assert area == pytest.approx((50 + 4) * (25 + 4) * 4.0)


def test_the_site_is_clipped_to_the_region():
    xy = _block(0, 100, 0, 50)
    assert B.site_area(xy, box(0, 0, 50, 50)) == pytest.approx(25 * 25 * 4.0)
    assert B.site_area(np.zeros((0, 2))) == 0.0


@pytest.mark.parametrize(
    "gsd, scale, area, budget, want",
    [
        (0.02, 0.5, 100_000.0, 150_000_000, 0.04),  # a small site: the matching GSD
        (0.02, 0.5, 1_000_000.0, 150_000_000, math.sqrt(1e6 / (0.9 * 150e6))),  # widened
        (0.02, 1.0, 1_000_000.0, 400_000_000, 0.02),
        (0.02, 0.0, 1_000_000.0, 0, 0.02),  # Fast: the sparse points at the photo GSD
    ],
)
def test_the_spacing_widens_only_over_the_budget(gsd, scale, area, budget, want):
    assert B.budget_voxel(gsd, scale, area, budget) == pytest.approx(want)


def test_a_merge_over_the_budget_is_done_again_wider():
    assert not B.needs_remerge(180_000_000, 150_000_000)
    assert B.needs_remerge(180_000_001, 150_000_000)
    assert not B.needs_remerge(10**12, 0)  # no budget, no re-merge
    assert B.remerge_voxel(0.04, 600_000_000, 150_000_000) == pytest.approx(0.08)


def test_the_disk_estimate_reserves_twice_the_copc_for_untwine():
    kw = dict(photos=1000, pixels=20_000_000, scale=0.5, area=1e6, gsd=0.02, ortho_res=0.02,
              dsm_res=0.04, voxel=0.1, budget=150_000_000, sparse_points=500_000)  # fmt: skip
    without = B.disk_need(**kw, cloud=False)
    with_cloud = B.disk_need(**kw, cloud=True)
    merged = 1e6 / 0.1**2  # 100 M points
    assert with_cloud - without == pytest.approx(merged * (36 + 15 * 3) * 1.3, rel=1e-6)
    fast = B.disk_need(**{**kw, "scale": 0.0, "voxel": 0.02, "budget": 0}, cloud=False)
    assert 0 < fast < without
```

- [ ] **Step 2: Run them and see them fail**

Run: `uv run --frozen --directory python pytest tests/test_photo_budget.py -q`
Expected: FAIL: `ImportError: cannot import name 'budget' from 'aio_pipelines.photo'`.

- [ ] **Step 3: Implement**

`python/src/aio_pipelines/photo/budget.py`:

```python
"""The dense cloud's point budget (founder decision of 13 Oct 2026) and the disk a run needs.

Each preset has a budget of points: Fast stays sparse, Standard about 150 M, High about 400 M.
The spacing starts at the matching GSD (``gsd / scale``) and widens only when the site would hold
more points than that: ``voxel = max(gsd / scale, sqrt(area / (0.9 * budget)))``. The area is
where the sparse points are: 2 m cells with at least two points, dilated by two cells, clipped to
the processing region. A merge that still ends above 1.2 x the budget is merged again at
``voxel * sqrt(points / budget)``.
"""

from __future__ import annotations

import math

import numpy as np

BUDGET = {"fast": 0, "standard": 150_000_000, "high": 400_000_000}
AREA_CELL_M = 2.0
AREA_MIN_POINTS = 2
AREA_DILATE = 2
BUDGET_FILL = 0.9
REMERGE_OVER = 1.2
#: Bytes on disk per point: a fusion chunk (format 2), a fused tile (xyz float64, colour, float32
#: normal, int32 count), a LAS record (format 7) and a COPC point (LAZ, measured about 15).
CHUNK_BYTES = 18
FUSED_BYTES = 43
LAS_BYTES = 36
COPC_BYTES = 15
#: untwine's temporary files, as a multiple of the COPC it writes.
UNTWINE_TEMP = 2.0
#: Raw fused points per point at the matching spacing: about how many photos see a spot.
RAW_PER_POINT = 4


def site_area(xy: np.ndarray, region=None, cell: float = AREA_CELL_M) -> float:
    """Square metres the sparse points ``xy`` (n, 2) cover; ``region`` a shapely polygon in the
    same coordinates."""
    from scipy import ndimage

    if not len(xy):
        return 0.0
    lo = np.floor(xy.min(0) / cell) - AREA_DILATE
    idx = (np.floor(xy / cell) - lo).astype(np.int64)
    w, h = (idx.max(0) + 1 + AREA_DILATE).tolist()
    counts = np.zeros((h, w), np.int64)
    np.add.at(counts, (idx[:, 1], idx[:, 0]), 1)
    occ = ndimage.binary_dilation(
        counts >= AREA_MIN_POINTS, structure=np.ones((3, 3), bool), iterations=AREA_DILATE
    )
    if region is not None:
        import shapely

        cx = (lo[0] + np.arange(w) + 0.5) * cell
        cy = (lo[1] + np.arange(h) + 0.5) * cell
        gx, gy = np.meshgrid(cx, cy)
        occ &= shapely.contains_xy(region, gx, gy)
    return float(occ.sum()) * cell * cell


def budget_voxel(gsd: float, scale: float, area: float, budget: int) -> float:
    """The cloud's spacing: the matching GSD, wider when the site would pass the budget."""
    base = gsd / scale if scale else gsd
    if budget <= 0 or area <= 0:
        return base
    return max(base, math.sqrt(area / (BUDGET_FILL * budget)))


def needs_remerge(points: int, budget: int) -> bool:
    return budget > 0 and points > REMERGE_OVER * budget


def remerge_voxel(voxel: float, points: int, budget: int) -> float:
    return voxel * math.sqrt(points / budget)


def disk_need(
    *,
    photos: int,
    pixels: int,
    scale: float,
    area: float,
    gsd: float,
    ortho_res: float,
    dsm_res: float,
    voxel: float,
    budget: int,
    sparse_points: int,
    cloud: bool,
) -> int:
    """Bytes a run needs free: depth maps (and their points), fusion chunks, fused tiles, the
    rasters and, for a cloud, the LAS, the COPC and untwine's temporary files; with 30 % and
    64 MB to spare."""
    depth = photos * pixels * scale**2 * 4 * 3 if scale else 0.0
    raw = area / (gsd / max(scale, 0.25)) ** 2 * RAW_PER_POINT if scale else float(sparse_points)
    merged = area / voxel**2
    if budget:
        merged = min(merged, REMERGE_OVER * budget)
    if not scale:
        merged = min(merged, float(sparse_points))
    need = (
        depth
        + raw * CHUNK_BYTES
        + merged * FUSED_BYTES
        + area / ortho_res**2 * 4 * 3
        + area / dsm_res**2 * 4 * 6
    )
    if cloud:
        need += merged * (LAS_BYTES + COPC_BYTES * (1 + UNTWINE_TEMP))
    return int(need * 1.3 + 64 * 1024**2)
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `uv run --frozen --directory python pytest tests/test_photo_budget.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add python/src/aio_pipelines/photo/budget.py python/tests/test_photo_budget.py
git commit -F msg.txt
```

```
feat(photo): point budget, site area and disk estimate

Budgets per preset, the area the sparse points cover on a 2 m grid, the spacing that keeps a
site within its budget, the re-merge spacing, and a disk estimate with untwine's reserve.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

### Task 4: The classified COPC: cloud_out.py and the run_tool progress hook

**Files:**

- Create: `python/src/aio_pipelines/photo/cloud_out.py`
- Modify: `python/src/aio_pipelines/photo/native.py:10-15` (docstring table), `:30-39` (imports), `:41-46` (`TOOLS`), `:86-136` (`run_tool`)
- Test: `python/tests/test_photo_cloud_out.py`

**Interfaces:**

- Consumes: `PointTiles(root, tile).fused()` and `.info()` as they are today (keys `xyz`, `rgb`; `bounds`); `pointcloud.find_pdal()`, `pointcloud.pdal_env(exe)`; `native.find_tool`, `native.run_tool`.
- Produces (Task 8):
  - `native.TOOLS["untwine"] == ("AIO_UNTWINE", "pdal")`.
  - `native.run_tool(ctx, args, what, work, expected_s=60.0, progress=(0.0, 0.95), memory_limit=0, env=None, on_output: Callable[[str], float | None] | None = None) -> str`.
  - `cloud_out.GROUND_BELOW_M = 0.5`, `GROUND_ABOVE_M = 0.2`, `NO_COPC_TOOL: str` (contains "needs untwine or PDAL").
  - `classify(z: np.ndarray, ground: np.ndarray) -> np.ndarray` (uint8, 1 or 2); `DtmSampler(path: Path)` callable `(x, y) -> np.ndarray`, `.close()`.
  - `write_las(path: Path, store: PointTiles, shift: np.ndarray, dtm: Path | None, check=..., progress=...) -> dict[str, int]` (`points`, `ground`).
  - `untwine_args(exe: str, las: Path, out: Path, temp: Path, epsg: int | None) -> list[str]`; `pdal_copc_pipeline(las: Path, out: Path, epsg: int | None) -> dict`; `untwine_progress(line: str) -> float | None`.
  - `write_copc(ctx: StepContext, las: Path, out: Path, points: int, epsg: int | None, temp: Path, budget: int, progress: tuple[float, float] = (0.3, 0.95)) -> str` (`"untwine"` or `"pdal"`).

- [ ] **Step 1: Write the failing tests**

`python/tests/test_photo_cloud_out.py`:

```python
"""photo/cloud_out.py: the fused tiles as a classified LAS, then a COPC through untwine or PDAL;
and native.run_tool's progress hook."""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from pathlib import Path

import numpy as np
import pytest

import products_synth as ps
from aio_pipelines.photo import cloud_out as C
from aio_pipelines.photo import native
from aio_pipelines.photo import surface as S
from aio_pipelines.photo.fuse import PointTiles
from aio_pipelines.runtime import Job, JobError, Step, StepContext
from conftest import Recorder


def _ctx(tmp_path):
    rec = Recorder()
    job = Job("t1", None, tmp_path, {}, rec, threading.Event())  # type: ignore[arg-type]
    job.steps, job.weights = [Step("cloud", "Cloud", lambda c: None)], [1.0]
    return StepContext(job, 0, job.steps[0]), rec


def _fused(root: Path, tiles: dict[str, np.ndarray], tile: float = 10.0) -> PointTiles:
    """A store with these fused tiles (as ``merge`` leaves them), without fusing anything."""
    out = root / "fused"
    out.mkdir(parents=True)
    lo, hi, n = np.full(3, np.inf), np.full(3, -np.inf), 0
    for name, xyz in tiles.items():
        k = len(xyz)
        np.savez(out / f"{name}.npz", xyz=xyz, rgb=np.full((k, 3), 90, np.uint8),
                 normal=np.tile(np.float32([0, 0, 1]), (k, 1)), count=np.ones(k, np.int32))  # fmt: skip
        lo, hi, n = np.minimum(lo, xyz.min(0)), np.maximum(hi, xyz.max(0)), n + k
    (out / "index.json").write_text(json.dumps({"points": n, "bounds": [lo.tolist(), hi.tolist()]}), "utf-8")
    return PointTiles(root, tile)


def _flat_dtm(path: Path, z: float = 10.0, hole: tuple[int, int] | None = None) -> Path:
    """A 20 m x 20 m DTM at 0.5 m in the project CRS (x 412000.., y 3245000..)."""
    spec = S.GridSpec(412000.0, 3245020.0, 0.5, 40, 40)
    a = np.full((40, 40), z, np.float32)
    if hole:
        a[hole] = S.NODATA
    with S.write_tif(path, spec, ps.EPSG, 1, "float32", S.NODATA) as ds:
        ds.write(a, 1)
    return path


SHIFT = np.array([412000.0, 3245000.0, 0.0])


def test_points_are_ground_from_half_a_metre_below_to_twenty_cm_above_the_dtm():
    z = np.array([9.49, 9.5, 10.0, 10.2, 10.21, 10.0])
    g = np.array([10.0, 10.0, 10.0, 10.0, 10.0, np.nan])
    assert C.classify(z, g).tolist() == [1, 2, 2, 2, 1, 1]


def test_the_dtm_is_sampled_bilinearly(tmp_path):
    spec = S.GridSpec(0.0, 10.0, 1.0, 10, 10)
    gx, gy = spec.centres(0, 0, 10, 10)
    with S.write_tif(tmp_path / "p.tif", spec, None, 1, "float32", S.NODATA) as ds:
        ds.write((gx + 2 * gy).astype(np.float32), 1)
    sample = C.DtmSampler(tmp_path / "p.tif")
    try:
        x, y = np.array([2.0, 5.25, 7.9]), np.array([3.0, 4.75, 1.6])
        np.testing.assert_allclose(sample(x, y), x + 2 * y, atol=1e-5)
    finally:
        sample.close()


def test_points_where_the_dtm_has_no_height_are_not_ground(tmp_path):
    dtm = _flat_dtm(tmp_path / "dtm.tif", hole=(10, 10))  # the cell of x 5..5.5, y 14.5..15
    sample = C.DtmSampler(dtm)
    try:
        g = sample(np.array([412005.2, 412015.0, 412050.0]), np.array([3245014.7, 3245005.0, 3245005.0]))
    finally:
        sample.close()
    assert np.isnan(g[0]) and g[1] == pytest.approx(10.0) and np.isnan(g[2])  # in the hole, inside, outside
    assert C.classify(np.array([10.0, 10.0, 10.0]), g).tolist() == [1, 2, 1]


def test_the_las_is_written_tile_by_tile_with_the_classes(tmp_path):
    from aio_pipelines.change.las import read_las

    rng = np.random.default_rng(3)
    ground = np.column_stack([rng.uniform(0, 20, 3000), rng.uniform(0, 20, 3000), rng.normal(10, 0.02, 3000)])
    roof = np.column_stack([rng.uniform(4, 8, 400), rng.uniform(4, 8, 400), np.full(400, 15.0)])
    pts = np.concatenate([ground, roof])
    tiles = {f"{i}_{j}": pts[(np.floor(pts[:, 0] / 10) == i) & (np.floor(pts[:, 1] / 10) == j)]
             for i in range(2) for j in range(2)}  # fmt: skip
    store = _fused(tmp_path / "m", tiles)
    seen = []
    got = C.write_las(tmp_path / "c.las", store, SHIFT, _flat_dtm(tmp_path / "dtm.tif"),
                      progress=lambda f, m=None: seen.append(m))  # fmt: skip
    las = read_las(tmp_path / "c.las")
    assert got == {"points": 3400, "ground": 3000} and las.count == 3400 and las.pdrf == 7
    cls = las.field("Classification")
    assert (cls[las.xyz[:, 2] > 14] == 1).all() and (cls[las.xyz[:, 2] < 11] == 2).all()
    want = np.concatenate([p["xyz"] for _, p in store.fused()]) + SHIFT
    assert np.abs(las.xyz - want).max() <= 0.0005 + 1e-9  # millimetres, in the tiles' order
    assert las.field("Red").max() > 255  # 16-bit colour
    assert seen[-1] == "Writing the cloud: tile 4 of 4"


def test_the_copc_command_lines():
    args = C.untwine_args("untwine", Path("a.las"), Path("b.copc.laz"), Path("t"), 32639)
    assert args == ["untwine", "-i", "a.las", "-o", "b.copc.laz", "--temp_dir", "t", "--progress_debug",
                    "--a_srs", "EPSG:32639"]  # fmt: skip
    assert "--a_srs" not in C.untwine_args("untwine", Path("a"), Path("b"), Path("t"), None)
    p = C.pdal_copc_pipeline(Path("a.las"), Path("b.copc.laz"), 32639)["pipeline"]
    assert [s["type"] for s in p] == ["readers.las", "writers.copc"]
    assert p[0]["override_srs"] == p[1]["a_srs"] == "EPSG:32639"


def test_untwine_progress_lines_are_read():
    assert C.untwine_progress("Untwine progress (45% done): Bulk processing") == pytest.approx(0.45)
    assert C.untwine_progress("Untwine progress (100% done): Done") == 1.0
    assert C.untwine_progress("Reading files") is None


FAKE_PROGRESS = r"""
import time
for p in (10, 50, 90):
    print(f"Untwine progress ({p}% done): Processing", flush=True)
    time.sleep(0.6)
"""


def test_a_tools_own_progress_lines_drive_the_bar(tmp_path):
    exe = ps.fake_tool(tmp_path, "untwine", FAKE_PROGRESS)
    ctx, rec = _ctx(tmp_path)
    native.run_tool(ctx, [str(exe)], "Building the COPC", tmp_path / "w", expected_s=3600,
                    progress=(0.3, 0.95), on_output=C.untwine_progress)  # fmt: skip
    got = [p["stepFraction"] for p in rec.of("progress") if p.get("message") == "Building the COPC"]
    assert any(abs(f - (0.3 + 0.65 * 0.5)) < 0.01 for f in got)
    assert max(got) == pytest.approx(0.3 + 0.65 * 0.9, abs=0.01)


def test_untwine_is_found_by_its_variable_and_in_the_pack(tmp_path, monkeypatch):
    monkeypatch.delenv("AIO_UNTWINE", raising=False)
    sub = ("Library", "bin") if os.name == "nt" else ("bin",)
    exe = tmp_path / "tools" / "pdal" / Path(*sub) / ("untwine.exe" if os.name == "nt" else "untwine")
    exe.parent.mkdir(parents=True)
    exe.write_bytes(b"")
    monkeypatch.setattr(native.sys, "prefix", str(tmp_path / "python"))
    assert native.find_tool("untwine") == str(exe)
    monkeypatch.setenv("AIO_UNTWINE", str(tmp_path / "missing.exe"))
    assert native.find_tool("untwine") is None


FAKE_UNTWINE = r"""
import os, shutil, sys
args = sys.argv[1:]
open(os.environ["FAKE_UNTWINE_ARGS"], "w").write(" ".join(args))
print("Untwine progress (50% done): Bulk", flush=True)
shutil.copyfile(args[args.index("-i") + 1], args[args.index("-o") + 1])
"""

FAKE_PDAL = r"""
import json, shutil, sys
args = sys.argv[1:]
assert args[0] == "pipeline", args
stages = json.load(open(args[1]))["pipeline"]
assert [s["type"] for s in stages] == ["readers.las", "writers.copc"], stages
shutil.copyfile(stages[0]["filename"], stages[-1]["filename"])
"""


def _las(tmp_path) -> Path:
    las = tmp_path / "c.las"
    las.write_bytes(b"LASF" + b"\0" * 400)
    return las


def test_untwine_writes_the_copc_when_it_is_there(tmp_path, monkeypatch):
    monkeypatch.setenv("AIO_UNTWINE", str(ps.fake_tool(tmp_path / "tools", "untwine", FAKE_UNTWINE)))
    monkeypatch.setenv("FAKE_UNTWINE_ARGS", str(tmp_path / "untwine.args"))
    ctx, _ = _ctx(tmp_path)
    out = tmp_path / "out.copc.laz"
    writer = C.write_copc(ctx, _las(tmp_path), out, 1000, 32639, tmp_path / ".tmp", 2**30)
    assert writer == "untwine" and out.read_bytes()[:4] == b"LASF"
    args = (tmp_path / "untwine.args").read_text().split()
    assert args[args.index("--temp_dir") + 1] == str(tmp_path / ".tmp" / "untwine")
    assert "--progress_debug" in args and args[-2:] == ["--a_srs", "EPSG:32639"]


def test_without_untwine_pdal_writes_the_copc(tmp_path, monkeypatch):
    monkeypatch.setenv("AIO_UNTWINE", str(tmp_path / "no-untwine.exe"))
    monkeypatch.setenv("AIO_PDAL", str(ps.fake_tool(tmp_path / "tools", "pdal", FAKE_PDAL)))
    ctx, _ = _ctx(tmp_path)
    out = tmp_path / "out.copc.laz"
    assert C.write_copc(ctx, _las(tmp_path), out, 1000, 32639, tmp_path / ".tmp", 2**30) == "pdal"
    assert out.is_file()


def test_the_pdal_fallback_refuses_a_cloud_too_big_for_the_memory(tmp_path, monkeypatch):
    monkeypatch.setenv("AIO_UNTWINE", str(tmp_path / "no-untwine.exe"))
    monkeypatch.setenv("AIO_PDAL", str(ps.fake_tool(tmp_path / "tools", "pdal", FAKE_PDAL)))
    ctx, _ = _ctx(tmp_path)
    with pytest.raises(JobError, match=r"10,000,000 points.*untwine"):
        C.write_copc(ctx, _las(tmp_path), tmp_path / "o.copc.laz", 10_000_000, None, tmp_path / ".t", 100 * 2**20)
    assert not (tmp_path / "o.copc.laz").exists()


def test_without_untwine_or_pdal_the_cloud_is_refused(tmp_path, monkeypatch):
    monkeypatch.setenv("AIO_UNTWINE", str(tmp_path / "no-untwine.exe"))
    monkeypatch.setenv("AIO_PDAL", str(tmp_path / "no-pdal.exe"))
    monkeypatch.setattr("aio_pipelines.pointcloud.shutil.which", lambda name: None)
    monkeypatch.setattr("aio_pipelines.pointcloud.sys.prefix", str(tmp_path / "venv"))
    ctx, _ = _ctx(tmp_path)
    with pytest.raises(JobError, match="needs untwine or PDAL"):
        C.write_copc(ctx, _las(tmp_path), tmp_path / "o.copc.laz", 10, None, tmp_path / ".t", 2**30)


def _real_tools():
    from aio_pipelines.pointcloud import find_pdal

    return native.find_tool("untwine"), find_pdal()


@pytest.mark.skipif(not all(_real_tools()), reason="needs untwine and PDAL (AIO_UNTWINE, AIO_PDAL)")
def test_real_untwine_keeps_the_classes(tmp_path):
    from aio_pipelines.change.las import read_las
    from aio_pipelines.pointcloud import find_pdal, pdal_env

    rng = np.random.default_rng(5)
    pts = np.column_stack([rng.uniform(0, 20, 20_000), rng.uniform(0, 20, 20_000), rng.normal(10, 0.02, 20_000)])
    pts[:5000, 2] = 14.0
    store = _fused(tmp_path / "m", {"0_0": pts})
    counts = C.write_las(tmp_path / "c.las", store, SHIFT, _flat_dtm(tmp_path / "dtm.tif"))
    ctx, _ = _ctx(tmp_path)
    out = tmp_path / "c.copc.laz"
    assert C.write_copc(ctx, tmp_path / "c.las", out, counts["points"], ps.EPSG, tmp_path / ".t", 2**31) == "untwine"
    pdal = find_pdal()
    native.run_tool(ctx, [pdal, "translate", str(out), str(tmp_path / "back.las")], "Read the COPC back",
                    tmp_path / "w", env=pdal_env(pdal))  # fmt: skip
    back = read_las(tmp_path / "back.las")
    cls = back.field("Classification")
    assert back.count == 20_000 and int((cls == 2).sum()) == counts["ground"] == 15_000


@pytest.mark.skipif(_real_tools()[1] is None, reason="needs PDAL (AIO_PDAL)")
def test_real_pdal_writes_the_copc_and_its_rate_is_printed(tmp_path, monkeypatch):
    monkeypatch.setenv("AIO_UNTWINE", str(tmp_path / "no-untwine.exe"))
    rng = np.random.default_rng(6)
    n = 2_000_000
    pts = np.column_stack([rng.uniform(0, 20, n), rng.uniform(0, 20, n), rng.normal(10, 0.05, n)])
    store = _fused(tmp_path / "m", {"0_0": pts})
    counts = C.write_las(tmp_path / "c.las", store, SHIFT, None)
    ctx, _ = _ctx(tmp_path)
    t0 = time.monotonic()
    assert C.write_copc(ctx, tmp_path / "c.las", tmp_path / "c.copc.laz", counts["points"], ps.EPSG,
                        tmp_path / ".t", 2**33) == "pdal"  # fmt: skip
    rate = n / (time.monotonic() - t0)
    print(f"\nPDAL writers.copc: {rate:,.0f} points a second", file=sys.stderr)
```

- [ ] **Step 2: Run them and see them fail**

Run: `uv run --frozen --directory python pytest tests/test_photo_cloud_out.py -q`
Expected: FAIL: `ImportError: cannot import name 'cloud_out' from 'aio_pipelines.photo'`.

- [ ] **Step 3: Implement `native.py`**

Docstring table (lines 10-15), add a row:

```
| ``untwine``   | ``AIO_UNTWINE``       | ``tools/pdal/`` (shipped)  | GPL-3.0-or-later (conda-forge build)     |
```

and after the `run_tool` paragraph: "`on_output` reads the tool's own progress: each new line it prints (stdout or stderr) goes to the hook, and a fraction the hook returns moves the bar instead of the time ramp."

Imports: add `import re` and `from collections.abc import Callable, Sequence`. `TOOLS` gains `"untwine": ("AIO_UNTWINE", "pdal"),`. Before `run_tool` add:

```python
class _Tail:
    """The new complete lines of a file a running tool writes (``\\n`` or ``\\r`` ends a line)."""

    def __init__(self, path: Path):
        self.path, self.pos, self.rest = path, 0, b""

    def lines(self) -> list[str]:
        try:
            with open(self.path, "rb") as f:
                f.seek(self.pos)
                data = f.read()
        except OSError:
            return []
        self.pos += len(data)
        parts = re.split(rb"[\r\n]", self.rest + data)
        self.rest = parts.pop()
        return [p.decode("utf-8", errors="replace") for p in parts if p.strip()]
```

`run_tool` becomes:

```python
def run_tool(
    ctx: StepContext,
    args: Sequence[str],
    what: str,
    work: Path,
    expected_s: float = 60.0,
    progress: tuple[float, float] = (0.0, 0.95),
    memory_limit: int = 0,
    env: dict[str, str] | None = None,
    on_output: Callable[[str], float | None] | None = None,
) -> str:
    """Run a native tool; return its stdout, or raise with the last line it printed. With
    ``memory_limit`` (bytes) the tool and its children are stopped above it
    (``ToolMemoryExceeded``), so a tool never pushes the computer into swapping. With
    ``on_output`` the tool's own progress lines move the bar (see the module docstring)."""
    work.mkdir(parents=True, exist_ok=True)
    out_path, err_path = work / "tool.out", work / "tool.err"
    kw: dict = {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)}
    if os.name != "nt":
        kw = {"start_new_session": True}
    if env is not None:
        kw["env"] = env
    with open(out_path, "wb") as out_f, open(err_path, "wb") as err_f:
        try:
            proc = subprocess.Popen(list(args), stdin=subprocess.DEVNULL, stdout=out_f, stderr=err_f, **kw)
        except OSError as e:
            raise JobError(f"{what}: the tool {Path(args[0]).name} could not start ({e}).") from e
        t0 = time.monotonic()
        lo, hi = progress
        last_mem = last_read = 0.0
        tails = [_Tail(out_path), _Tail(err_path)] if on_output is not None else []
        told: float | None = None
        while proc.poll() is None:
            if ctx.cancel_event.is_set():
                _kill_tree(proc)
                raise Cancelled()
            if memory_limit and time.monotonic() - last_mem >= 0.5:
                from .colmap_io import tree_memory

                last_mem = time.monotonic()
                used = tree_memory(proc.pid)
                if used > memory_limit:
                    _kill_tree(proc)
                    raise ToolMemoryExceeded(
                        f"{what} stopped: it needed more than {memory_limit / 1e9:.1f} GB of memory."
                    )
            if tails and on_output is not None and time.monotonic() - last_read >= 0.2:
                last_read = time.monotonic()
                for tail in tails:
                    for line in tail.lines():
                        f = on_output(line)
                        if f is not None:
                            told = max(told or 0.0, min(1.0, f))
            if told is not None:
                frac = told
            else:
                frac = min(1.0, (time.monotonic() - t0) / max(1.0, expected_s)) * 0.95
            ctx.progress(lo + (hi - lo) * frac, what)
            time.sleep(0.1)
    out = out_path.read_text("utf-8", errors="replace")
    if proc.returncode != 0:
        err = err_path.read_text("utf-8", errors="replace")
        lines = (err or out or "").strip().splitlines()
        raise JobError(f"{what} failed: {lines[-1] if lines else f'exit {proc.returncode}'}")
    return out
```

- [ ] **Step 4: Implement `cloud_out.py`**

```python
"""The dense cloud as a classified COPC (``photo.products`` step ``cloud``).

1. ``write_las``: the fused tiles, one at a time, into one LAS 1.4 file (point format 7, colour),
   each point classified by its height above the DTM (``dtm-raw.tif``, sampled bilinearly):
   ground (2) from 0.5 m below to 0.2 m above it; 1 above or below that, and where the DTM has no
   height.
2. ``write_copc``: untwine (pipeline pack 0.6.1 and later) turns the LAS into a COPC out of core,
   keeping the classes, its progress read from ``--progress_debug``; its temporary files go where
   the caller says (the job's staging area). Without untwine, PDAL's ``writers.copc`` does it in
   memory, refused up front, naming untwine, when the cloud would not fit the memory budget.
   Both run through ``native.run_tool`` with the memory budget as their limit.
"""

from __future__ import annotations

import math
import re
import struct
from collections.abc import Callable
from pathlib import Path
from typing import Any

import numpy as np

from ..runtime import JobError, StepContext, atomic_write_json, replace_over
from . import native
from .fuse import PointTiles

GROUND_BELOW_M = 0.5
GROUND_ABOVE_M = 0.2
LAS_SCALE = 0.001
#: Memory PDAL holds per point to write a COPC (point table and octree): the founder's 913 M
#: point run reached 123 GB with SMRF in the same pipeline, 135 bytes a point.
PDAL_COPC_BYTES_PER_POINT = 140
#: PDAL's writers.copc rate, points a second (measured: Task 4 of the photo scale plan).
PDAL_COPC_POINTS_PER_S = 1_000_000
UNTWINE_PROGRESS = re.compile(r"\((\d+)% done\)")
NO_COPC_TOOL = (
    "The point cloud needs untwine or PDAL, and this pipeline pack has neither. Install the full "
    "pipeline pack, or leave the point cloud out."
)
_REC = np.dtype(
    [("xyz", "<i4", 3), ("i", "<u2"), ("ret", "u1"), ("flags", "u1"), ("cls", "u1"), ("user", "u1"),
     ("angle", "<i2"), ("src", "<u2"), ("t", "<f8"), ("rgb", "<u2", 3)]
)  # fmt: skip
assert _REC.itemsize == 36


def classify(z: np.ndarray, ground: np.ndarray) -> np.ndarray:
    """LAS classes: 2 (ground) within ``GROUND_BELOW_M`` below and ``GROUND_ABOVE_M`` above the
    ground height, else 1 (also where the ground is NaN)."""
    d = z - ground
    with np.errstate(invalid="ignore"):
        g = (d >= -GROUND_BELOW_M) & (d <= GROUND_ABOVE_M)
    return np.where(g, 2, 1).astype(np.uint8)


class DtmSampler:
    """Heights of a north-up DTM GeoTIFF at points, bilinearly from its cell centres (the edge
    cells' heights out to the raster's edge). NaN outside the raster and wherever one of the four
    cells around a point has no data."""

    def __init__(self, path: Path):
        import rasterio

        self.ds = rasterio.open(path)
        t = self.ds.transform
        self.x0, self.y1, self.res = t.c, t.f, t.a

    def __call__(self, x: np.ndarray, y: np.ndarray) -> np.ndarray:
        from rasterio.windows import Window
        from scipy import ndimage

        if not len(x):
            return np.zeros(0)
        cf = (np.asarray(x) - self.x0) / self.res - 0.5
        rf = (self.y1 - np.asarray(y)) / self.res - 0.5
        w, h = self.ds.width, self.ds.height
        outside = (cf < -0.5) | (rf < -0.5) | (cf > w - 0.5) | (rf > h - 0.5)
        c0, r0 = max(0, math.floor(float(cf.min()))), max(0, math.floor(float(rf.min())))
        c1, r1 = min(w - 1, math.ceil(float(cf.max()))), min(h - 1, math.ceil(float(rf.max())))
        if c1 < c0 or r1 < r0:
            return np.full(len(cf), np.nan)
        a = self.ds.read(1, window=Window(c0, r0, c1 - c0 + 1, r1 - r0 + 1), masked=True)
        g = np.where(np.ma.getmaskarray(a), np.nan, a.astype(np.float64))
        out = ndimage.map_coordinates(g, [rf - r0, cf - c0], order=1, mode="nearest", prefilter=False)
        out[outside] = np.nan
        return out

    def close(self) -> None:
        self.ds.close()


def _las_header(n: int, lo: np.ndarray, mins: np.ndarray, maxs: np.ndarray) -> bytes:
    from datetime import UTC, datetime

    now = datetime.now(UTC)
    h = bytearray(375)
    h[0:4] = b"LASF"
    struct.pack_into("<H", h, 6, 0x10)
    h[24], h[25] = 1, 4
    h[26:37] = b"Quadrion AI"
    h[58:72] = b"photo.products"
    struct.pack_into("<HHHII", h, 90, now.timetuple().tm_yday, now.year, 375, 375, 0)
    h[104] = 7
    struct.pack_into("<H", h, 105, 36)
    struct.pack_into("<3d", h, 131, LAS_SCALE, LAS_SCALE, LAS_SCALE)
    struct.pack_into("<3d", h, 155, *lo)
    struct.pack_into("<6d", h, 179, maxs[0], mins[0], maxs[1], mins[1], maxs[2], mins[2])
    struct.pack_into("<Q", h, 247, n)
    struct.pack_into("<Q", h, 255, n)  # all first returns
    return bytes(h)


def write_las(
    path: Path,
    store: PointTiles,
    shift: np.ndarray,
    dtm: Path | None,
    check: Callable[[], None] = lambda: None,
    progress: Callable[[float, str | None], None] = lambda f, m=None: None,
) -> dict[str, int]:
    """The fused cloud as one LAS 1.4 file (point format 7: colour and class), one tile in memory
    at a time; ``shift`` takes model to project CRS coordinates, ``dtm`` (project CRS) gives the
    classes (all 1 without it). Answers ``points`` and ``ground``."""
    info = store.info()
    if not info.get("bounds"):
        raise JobError("The cloud is empty.")
    lo = np.floor(np.asarray(info["bounds"][0]) + shift)
    base = store.root / "fused"
    total = len([p for p in base.glob("*.npz") if not p.name.startswith(".")])
    sampler = DtmSampler(dtm) if dtm is not None else None
    n = ground = 0
    mins, maxs = np.full(3, np.inf), np.full(3, -np.inf)
    tmp = path.with_name(f".{path.name}.tmp")
    try:
        with open(tmp, "wb") as f:
            f.write(b"\0" * 375)
            for i, (_, part) in enumerate(store.fused()):
                check()
                xyz = part["xyz"] + shift
                if len(xyz):
                    r = np.zeros(len(xyz), _REC)
                    r["xyz"] = np.round((xyz - lo) / LAS_SCALE).astype("<i4")
                    r["ret"] = 0x11
                    if sampler is not None:
                        cls = classify(xyz[:, 2], sampler(xyz[:, 0], xyz[:, 1]))
                    else:
                        cls = np.ones(len(xyz), np.uint8)
                    r["cls"] = cls
                    r["rgb"] = part["rgb"].astype("<u2") * 257
                    f.write(r.tobytes())
                    real = r["xyz"] * LAS_SCALE + lo
                    mins, maxs = np.minimum(mins, real.min(0)), np.maximum(maxs, real.max(0))
                    n += len(xyz)
                    ground += int((cls == 2).sum())
                progress((i + 1) / max(1, total), f"Writing the cloud: tile {i + 1} of {total}")
            f.seek(0)
            f.write(_las_header(n, lo, mins, maxs))
    finally:
        if sampler is not None:
            sampler.close()
    replace_over(tmp, path)
    return {"points": n, "ground": ground}


def untwine_args(exe: str, las: Path, out: Path, temp: Path, epsg: int | None) -> list[str]:
    args = [exe, "-i", str(las), "-o", str(out), "--temp_dir", str(temp), "--progress_debug"]
    return args + (["--a_srs", f"EPSG:{epsg}"] if epsg else [])


def pdal_copc_pipeline(las: Path, out: Path, epsg: int | None) -> dict[str, Any]:
    srs = f"EPSG:{epsg}" if epsg else None
    return {
        "pipeline": [
            {"type": "readers.las", "filename": str(las), **({"override_srs": srs} if srs else {})},
            {"type": "writers.copc", "filename": str(out), **({"a_srs": srs} if srs else {})},
        ]
    }


def untwine_progress(line: str) -> float | None:
    """The fraction an ``Untwine progress (N% done)`` line says, else None."""
    m = UNTWINE_PROGRESS.search(line)
    return min(100, int(m.group(1))) / 100 if m else None


def write_copc(
    ctx: StepContext,
    las: Path,
    out: Path,
    points: int,
    epsg: int | None,
    temp: Path,
    budget: int,
    progress: tuple[float, float] = (0.3, 0.95),
) -> str:
    """``las`` (``points`` points) as the COPC ``out``, with untwine, else PDAL. Answers which."""
    from ..pointcloud import find_pdal, pdal_env

    temp.mkdir(parents=True, exist_ok=True)
    exe = native.find_tool("untwine")
    if exe:
        (temp / "untwine").mkdir(exist_ok=True)
        native.run_tool(
            ctx,
            untwine_args(exe, las, out, temp / "untwine", epsg),
            "Building the COPC (untwine)",
            temp,
            expected_s=max(60.0, points / 2e6),
            progress=progress,
            memory_limit=budget,
            env=pdal_env(exe),
            on_output=untwine_progress,
        )
        writer = "untwine"
    else:
        pdal = find_pdal()
        if pdal is None:
            raise JobError(NO_COPC_TOOL)
        if points * PDAL_COPC_BYTES_PER_POINT > budget:
            raise JobError(
                f"The point cloud has {points:,} points, more than PDAL can turn into a COPC within "
                f"the memory budget ({budget / 1e9:.1f} GB). Install pipeline pack 0.6.1 or later, "
                "which brings untwine, or leave the point cloud out."
            )
        pj = temp / "copc-pipeline.json"
        atomic_write_json(pj, pdal_copc_pipeline(las, out, epsg))
        native.run_tool(
            ctx,
            [pdal, "pipeline", str(pj)],
            "Building the COPC (PDAL)",
            temp,
            expected_s=max(30.0, points / PDAL_COPC_POINTS_PER_S),
            progress=progress,
            memory_limit=budget,
            env=pdal_env(pdal),
        )
        writer = "pdal"
    if not out.is_file():
        raise JobError(f"{writer} finished without writing the COPC file.")
    return writer
```

- [ ] **Step 5: Run the tests and see them pass**

Run: `uv run --frozen --directory python pytest tests/test_photo_cloud_out.py -q`
Expected: PASS; the two real-tool tests SKIP without `AIO_UNTWINE` / `AIO_PDAL`.

- [ ] **Step 6: Run the real tools and measure PDAL's rate**

With Task 1's install (Step 5 there), PowerShell:

```powershell
$env:AIO_PDAL = "C:\Users\D\AppData\Local\Temp\quadrion-pdal-0.6.1\Library\bin\pdal.exe"
$env:AIO_UNTWINE = "C:\Users\D\AppData\Local\Temp\quadrion-pdal-0.6.1\Library\bin\untwine.exe"
uv run --frozen --directory python pytest tests/test_photo_cloud_out.py -k real -q -s
```

Expected: both real tests PASS (if Task 1 is not finished yet, use `E:/Dev/tools/pdal/Library/bin/pdal.exe` for the PDAL test and run the untwine test once Task 1 lands). The PDAL test prints `PDAL writers.copc: N points a second`. Set `PDAL_COPC_POINTS_PER_S` in `cloud_out.py` to N rounded down to two significant figures (for example 1,340,000 becomes `1_300_000`) and keep the comment naming this plan. If the real untwine test fails because untwine does not accept `--a_srs` for a LAS without a CRS, stop and report the error line (the spec's checked CLI includes it).

- [ ] **Step 7: Commit**

```bash
git add python/src/aio_pipelines/photo/cloud_out.py python/src/aio_pipelines/photo/native.py python/tests/test_photo_cloud_out.py
git commit -F msg.txt
```

```
feat(photo): classified COPC through untwine with a PDAL fallback

The fused tiles become a LAS with ground classes from the DTM, then untwine builds the COPC
out of core with its own progress; PDAL's writers.copc is the fallback, refused up front
when the cloud would not fit the memory budget. run_tool reads a tool's progress lines.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

### Task 5: Merge v2 per tile

**Files:**

- Modify: `python/src/aio_pipelines/photo/fuse.py`: imports (`:14-25`); `PointTiles.merge` (`:117-160`) replaced; new methods `begin_merge`, `merging_voxel`, `finish_merge`, `counts`, `drop_chunks` after `info` (`:192-194`); new module functions after `voxel_mean` (`:250-275`)
- Modify: `python/src/aio_pipelines/photo/products.py:601` and `:634` (the two `store.merge` calls)
- Test: `python/tests/test_photo_dense.py:265-279` (`test_voxel_means_and_tiles`), `:281-299` (LAS test merge call), new tests at the end
- Test: `python/tests/test_photo_surface.py:55-64` (`_tiles`)

**Interfaces:**

- Consumes (Task 2): `unpack_chunk`, `PointTiles.chunks_dir`, `PointTiles.chunk_tiles()`.
- Produces (Tasks 6 to 8):
  - `MergeRule(min_count: int = 2, outliers: bool = True, k: int = 16, sigma: float = 2.5, version: int = 2)`, frozen; `DENSE_RULE = MergeRule()`; `SPARSE_RULE = MergeRule(min_count=1, outliers=False)`.
  - `collapse_columns(xyz, rgb, nrm, cnt, voxel) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]`.
  - `outlier_mask(pts: np.ndarray, margin: np.ndarray, k: int = 16, sigma: float = 2.5) -> np.ndarray` (True = keep).
  - `merge_tile(store: PointTiles, name: str, voxel: float, rule: MergeRule, keep=None) -> dict` and `filter_tile(store: PointTiles, name: str, voxel: float, rule: MergeRule) -> dict`, each answering `{"n": int, "lo": list[float] | None, "hi": list[float] | None}`.
  - `PointTiles.merge(voxel, keep=None, check=..., progress=..., rule: MergeRule = DENSE_RULE, run_tiles=None) -> dict`; `run_tiles(kind: str, names: list[str], voxel: float, rule: MergeRule, keep, done: Callable[[str, dict], None]) -> None` with `kind` `"merge"` or `"filter"`. `progress(fraction, message)` with messages `Merging tile i of n` and `Cleaning tile i of n`.
  - `fused/index.json`: `points`, `tiles`, `counts` (`{tile: n}`), `voxel`, `bounds`, `rule`; `complete: True` after `finish_merge()`.
  - `PointTiles.begin_merge(voxel) -> None`, `merging_voxel() -> float | None`, `finish_merge() -> dict`, `counts() -> list[int]`, `drop_chunks() -> int` (bytes freed).

- [ ] **Step 1: Write the failing tests**

In `python/tests/test_photo_dense.py`, add to the `fuse` import: `DENSE_RULE, SPARSE_RULE, MergeRule, collapse_columns, outlier_mask`. Change line 275 to `info = store.merge(0.1, rule=SPARSE_RULE)` and line 290 to `info = store.merge(0.001, rule=SPARSE_RULE)`. Append:

```python
def _up(n: int) -> np.ndarray:
    return np.tile(np.float32([0, 0, 1]), (n, 1))


def test_a_roof_over_the_ground_keeps_two_points():
    xyz = np.array([[0.05, 0.05, 0.00], [0.05, 0.05, 0.12], [0.05, 0.05, 5.00], [0.05, 0.05, 5.15]])
    p, _, _, k = collapse_columns(xyz, np.zeros((4, 3), np.uint8), _up(4), np.array([3, 2, 4, 1], np.int32), 0.1)
    assert len(p) == 2 and k.tolist() == [5, 5]
    assert p[0, 2] == pytest.approx(0.048) and p[1, 2] == pytest.approx(5.03)


def test_a_noisy_flat_surface_is_one_point_per_column():
    rng = np.random.default_rng(7)
    xyz = np.column_stack([rng.uniform(0, 1.0, (5000, 2)), rng.uniform(0, 0.15, 5000)])
    p, _, n, k = collapse_columns(xyz, np.zeros((5000, 3), np.uint8), _up(5000), np.ones(5000, np.int32), 0.1)
    assert len(p) == 100 and k.sum() == 5000 and np.allclose(n, [0, 0, 1])


def test_a_wall_keeps_its_height():
    z = np.arange(31) * 0.1 + 0.01
    xyz = np.column_stack([np.full(31, 0.05), np.full(31, 0.05), z])
    p, _, _, _ = collapse_columns(xyz, np.zeros((31, 3), np.uint8), _up(31), np.ones(31, np.int32), 0.1)
    assert len(p) == 16 and p[:, 2].min() < 0.1 and p[:, 2].max() > 2.9


def test_voxels_seen_once_are_dropped(tmp_path):
    store = PointTiles(tmp_path / "m", 4.0)
    xyz = np.array([[0.01, 0.01, 0.0], [0.02, 0.03, 0.01], [0.03, 0.02, 0.02], [2.0, 2.0, 1.0]])
    store.add("a", xyz, np.zeros((4, 3), np.uint8), _up(4))
    info = store.merge(0.1, rule=MergeRule(outliers=False))
    assert info["points"] == 1 and info["counts"] == {"0_0": 1} and info["rule"]["version"] == 2


def test_the_sparse_rule_keeps_every_point(tmp_path):
    rng = np.random.default_rng(8)
    xyz = np.column_stack([rng.uniform(0, 30, 400), rng.uniform(0, 30, 400), rng.uniform(0, 3, 400)])
    store = PointTiles(tmp_path / "m", 8.0)
    store.add("sparse", xyz, np.zeros((400, 3), np.uint8), _up(400))
    assert store.merge(0.01, rule=SPARSE_RULE)["points"] == 400


def _sheet(x1: float, y1: float, step: float = 0.1, seed: int = 1) -> np.ndarray:
    """A jittered flat sheet, one point per ``step`` cell."""
    rng = np.random.default_rng(seed)
    gx, gy = np.meshgrid(np.arange(step / 2, x1, step), np.arange(step / 2, y1, step))
    xyz = np.column_stack([gx.ravel(), gy.ravel(), np.zeros(gx.size)])
    xyz[:, :2] += rng.uniform(-0.02, 0.02, (len(xyz), 2))
    xyz[:, 2] += rng.uniform(-0.01, 0.01, len(xyz))
    return xyz


def test_the_outlier_filter_drops_a_floating_point_and_keeps_the_seams(tmp_path):
    sheet = _sheet(10.0, 10.0)
    pts = np.concatenate([sheet, [[5.0, 5.0, 4.0], [5.05, 5.0, 4.0]]])
    store = PointTiles(tmp_path / "m", 5.0)  # four tiles meeting at x = 5 and y = 5
    store.add("a", pts, np.zeros((len(pts), 3), np.uint8), _up(len(pts)))
    store.merge(0.1, rule=MergeRule(min_count=1))
    out = np.concatenate([p["xyz"] for _, p in store.fused()])
    assert not (out[:, 2] > 1).any()  # the floating pair is gone

    def inner(a):
        return (a[:, :2].min(1) > 0.3) & (a[:, :2].max(1) < 9.7)

    def seam(a):
        return inner(a) & ((np.abs(a[:, 0] - 5.0) < 0.1) | (np.abs(a[:, 1] - 5.0) < 0.1))

    assert seam(out).sum() >= 0.98 * seam(sheet).sum()
    assert inner(out).sum() >= 0.98 * inner(sheet).sum()


def test_outlier_mask_keeps_all_of_a_tiny_tile():
    assert outlier_mask(np.zeros((5, 3)), np.zeros((0, 3))).all()


def test_a_merge_at_another_spacing_starts_over_and_one_at_the_same_carries_on(tmp_path):
    store = PointTiles(tmp_path / "m", 4.0)
    xyz = _sheet(3.0, 3.0)
    store.add("a", xyz, np.zeros((len(xyz), 3), np.uint8), _up(len(xyz)))
    store.merge(0.1, rule=SPARSE_RULE)
    f = store.root / "fused" / "0_0.npz"
    t0 = f.stat().st_mtime_ns
    store.merge(0.1, rule=SPARSE_RULE)
    assert f.stat().st_mtime_ns == t0 and store.merging_voxel() == 0.1
    assert not (store.root / "collapsed").exists()
    info = store.merge(0.2, rule=SPARSE_RULE)
    assert info["voxel"] == 0.2 and f.stat().st_mtime_ns != t0 and store.merging_voxel() == 0.2


def test_the_chunks_go_after_a_finished_merge(tmp_path):
    store = PointTiles(tmp_path / "m", 4.0, chunks=tmp_path / "c" / "chunks")
    xyz = _sheet(6.0, 3.0)
    store.add("a", xyz, np.zeros((len(xyz), 3), np.uint8), _up(len(xyz)))
    store.merge(0.1, rule=SPARSE_RULE)
    assert "complete" not in store.info()
    assert store.finish_merge()["complete"] is True and store.counts() == [1200, 600]  # x < 4, x >= 4
    assert store.drop_chunks() > 0 and not (tmp_path / "c" / "chunks").exists()
    assert store.info()["points"] == len(xyz) == sum(store.counts())
```

`python/tests/test_photo_surface.py` `_tiles` (line 63): `store.merge(0.1, rule=SPARSE_RULE)`, with `from aio_pipelines.photo.fuse import SPARSE_RULE, PointTiles` at line 14.

- [ ] **Step 2: Run them and see them fail**

Run: `uv run --frozen --directory python pytest tests/test_photo_dense.py tests/test_photo_surface.py -q`
Expected: FAIL at import: `cannot import name 'DENSE_RULE'`.

- [ ] **Step 3: Implement**

`fuse.py` imports: add `import shutil`, `from dataclasses import asdict, dataclass` and `from ..runtime import JobError, atomic_write_json, replace_over`. After `voxel_mean` add:

```python
# ------------------------------------------------------------------------------------- merge v2


@dataclass(frozen=True)
class MergeRule:
    """How a tile's fused points become the cloud (merge v2, 13 Oct 2026): voxels seen fewer than
    ``min_count`` times go; each xy column keeps one point per ``2 x voxel`` of height in each of
    its clusters; then, with ``outliers``, points whose mean distance to their ``k`` nearest
    neighbours is more than ``sigma`` standard deviations above the tile's mean go."""

    min_count: int = 2
    outliers: bool = True
    k: int = 16
    sigma: float = 2.5
    version: int = 2


DENSE_RULE = MergeRule()
#: The Fast preset's sparse points: one point a voxel, already few and clean.
SPARSE_RULE = MergeRule(min_count=1, outliers=False)


def collapse_columns(
    xyz: np.ndarray, rgb: np.ndarray, nrm: np.ndarray, cnt: np.ndarray, voxel: float
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """One point per ``2 x voxel`` of height in each xy column of voxels: a column's points,
    sorted by height, split into clusters where they are more than ``2 x voxel`` apart (a roof
    over the ground); each cluster is averaged per ``2 x voxel`` from its lowest point, so a wall
    keeps its height and stacked noise layers merge. Weighted by the points each input holds."""
    if not len(xyz):
        return xyz, rgb, nrm, cnt
    step = 2.0 * voxel
    q = np.floor(xyz[:, :2] / voxel).astype(np.int64)
    q -= q.min(0)
    col = q[:, 0] * (int(q[:, 1].max()) + 1) + q[:, 1]
    order = np.lexsort((xyz[:, 2], col))
    xyz, rgb, nrm, cnt, col = xyz[order], rgb[order], nrm[order], cnt[order], col[order]
    z = xyz[:, 2]
    new_cluster = np.r_[True, (col[1:] != col[:-1]) | (np.diff(z) > step)]
    cluster = np.cumsum(new_cluster) - 1
    sub = np.floor((z - z[new_cluster][cluster]) / step).astype(np.int64)
    new_bin = new_cluster | np.r_[True, sub[1:] != sub[:-1]]
    b = np.cumsum(new_bin) - 1
    nb = int(b[-1]) + 1
    w = cnt.astype(np.float64)
    tot = np.bincount(b, weights=w, minlength=nb)

    def mean(a: np.ndarray) -> np.ndarray:
        cols = [np.bincount(b, weights=a[:, k] * w, minlength=nb) for k in range(a.shape[1])]
        return np.stack(cols, 1) / tot[:, None]

    p = mean(xyz)
    c = np.clip(np.round(mean(rgb.astype(np.float64))), 0, 255).astype(np.uint8)
    nn = mean(np.nan_to_num(nrm.astype(np.float64)))
    ln = np.linalg.norm(nn, axis=1, keepdims=True)
    nn = np.where(ln > 1e-9, nn / np.maximum(ln, 1e-12), [0.0, 0.0, 1.0]).astype(np.float32)
    return p, c, nn, tot.astype(np.int32)


def outlier_mask(pts: np.ndarray, margin: np.ndarray, k: int = 16, sigma: float = 2.5) -> np.ndarray:
    """True for the points of ``pts`` to keep: those whose mean distance to their ``k`` nearest
    neighbours (among ``pts`` and ``margin``) is at most the mean over ``pts`` plus ``sigma``
    standard deviations. With ``k`` points or fewer everything is kept."""
    from scipy.spatial import cKDTree

    allp = np.concatenate([pts, margin]) if len(margin) else pts
    if len(allp) <= k:
        return np.ones(len(pts), bool)
    d, _ = cKDTree(allp).query(pts, k=k + 1)
    m = d[:, 1:].mean(1)
    return m <= m.mean() + sigma * m.std()


def _tile_result(xyz: np.ndarray) -> dict:
    if not len(xyz):
        return {"n": 0, "lo": None, "hi": None}
    return {"n": len(xyz), "lo": xyz.min(0).tolist(), "hi": xyz.max(0).tolist()}


def _save_tile(dst: Path, **arrays: np.ndarray) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(f".{dst.stem}.tmp.npz")
    np.savez(tmp, **arrays)
    replace_over(tmp, dst)


def _xyz_of(path: Path) -> np.ndarray:
    with np.load(path) as z:
        return z["xyz"]


def merge_tile(
    store: PointTiles,
    name: str,
    voxel: float,
    rule: MergeRule,
    keep: Callable[[np.ndarray], np.ndarray] | None = None,
) -> dict:
    """First pass for one tile: its chunks, clipped by ``keep``, averaged per voxel, the voxels
    seen fewer than ``rule.min_count`` times dropped, the columns collapsed; into
    ``collapsed/<tile>.npz``. A tile whose first or second pass is on disk is not done again."""
    dst = store.root / "collapsed" / f"{name}.npz"
    for done in (dst, store.root / "fused" / f"{name}.npz"):
        if done.exists():
            return _tile_result(_xyz_of(done))
    parts = []
    for p in sorted((store.chunks_dir / name).glob("*.npz")):
        if p.name.startswith("."):
            continue
        with np.load(p) as f:
            parts.append(unpack_chunk(f))
    if parts:
        xyz = np.concatenate([a for a, _, _ in parts])
        rgb = np.concatenate([c for _, c, _ in parts])
        nrm = np.concatenate([n for _, _, n in parts])
    else:
        xyz, rgb, nrm = np.zeros((0, 3)), np.zeros((0, 3), np.uint8), np.zeros((0, 3), np.float32)
    if keep is not None and len(xyz):
        m = keep(xyz)
        xyz, rgb, nrm = xyz[m], rgb[m], nrm[m]
    p, c, n, cnt = voxel_mean(xyz, rgb, nrm, voxel)
    ok = cnt >= rule.min_count
    p, c, n, cnt = collapse_columns(p[ok], c[ok], n[ok], cnt[ok], voxel)
    _save_tile(dst, xyz=p, rgb=c, normal=n, count=cnt)
    return _tile_result(p)


def _margin(store: PointTiles, name: str, voxel: float) -> np.ndarray:
    """The first-pass points of the eight neighbouring tiles within one voxel of this tile."""
    tx, ty = (int(v) for v in name.split("_"))
    x0, y0 = tx * store.tile - voxel, ty * store.tile - voxel
    x1, y1 = (tx + 1) * store.tile + voxel, (ty + 1) * store.tile + voxel
    out = []
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            p = store.root / "collapsed" / f"{tx + dx}_{ty + dy}.npz"
            if (dx or dy) and p.is_file():
                q = _xyz_of(p)
                m = (q[:, 0] >= x0) & (q[:, 0] < x1) & (q[:, 1] >= y0) & (q[:, 1] < y1)
                out.append(q[m])
    return np.concatenate(out) if out else np.zeros((0, 3))


def filter_tile(store: PointTiles, name: str, voxel: float, rule: MergeRule) -> dict:
    """Second pass for one tile: the outlier filter over the tile and a one-voxel margin of its
    neighbours' first-pass points; into ``fused/<tile>.npz``."""
    dst = store.root / "fused" / f"{name}.npz"
    if dst.exists():
        return _tile_result(_xyz_of(dst))
    with np.load(store.root / "collapsed" / f"{name}.npz") as z:
        d = {k: z[k] for k in z.files}
    if rule.outliers and len(d["xyz"]):
        keep = outlier_mask(d["xyz"], _margin(store, name, voxel), rule.k, rule.sigma)
        d = {k: v[keep] for k, v in d.items()}
    _save_tile(dst, **d)
    return _tile_result(d["xyz"])
```

Replace `PointTiles.merge` (lines 117-160) with:

```python
    def merge(
        self,
        voxel: float,
        keep: Callable[[np.ndarray], np.ndarray] | None = None,
        check: Callable[[], None] = lambda: None,
        progress: Callable[[float, str | None], None] = lambda f, m=None: None,
        rule: MergeRule = DENSE_RULE,
        run_tiles: Callable[..., None] | None = None,
    ) -> dict:
        """Merge every tile in two passes, ``merge_tile`` then ``filter_tile`` (the filter reads
        its neighbours' first passes), and write ``fused/index.json``. ``run_tiles(kind, names,
        voxel, rule, keep, done)`` runs one pass (``kind`` ``merge`` or ``filter``) elsewhere,
        such as in worker processes, calling ``done(name, result)`` for each tile; by default the
        tiles run here. A merge at another spacing than the one in progress starts over."""
        self.begin_merge(voxel)
        names = self.chunk_tiles()
        total = max(1, len(names))
        results: dict[str, dict] = {}
        for kind, offset, word in (("merge", 0, "Merging"), ("filter", total, "Cleaning")):
            count = [0]

            def done(name: str, res: dict, offset: int = offset, word: str = word, count=count) -> None:
                count[0] += 1
                results[name] = res
                progress((offset + count[0]) / (2 * total), f"{word} tile {count[0]} of {total}")

            if run_tiles is not None:
                run_tiles(kind, names, voxel, rule, keep, done)
                continue
            for name in names:
                check()
                if kind == "merge":
                    done(name, merge_tile(self, name, voxel, rule, keep))
                else:
                    done(name, filter_tile(self, name, voxel, rule))
        lo, hi = np.full(3, np.inf), np.full(3, -np.inf)
        counts: dict[str, int] = {}
        for name in names:
            r = results[name]
            counts[name] = int(r["n"])
            if r["n"]:
                lo, hi = np.minimum(lo, r["lo"]), np.maximum(hi, r["hi"])
        points = sum(counts.values())
        info = {
            "points": int(points),
            "tiles": len(names),
            "counts": counts,
            "voxel": voxel,
            "bounds": [lo.tolist(), hi.tolist()] if points else None,
            "rule": asdict(rule),
        }
        (self.root / "fused").mkdir(parents=True, exist_ok=True)
        atomic_write_json(self.root / "fused" / "index.json", info)
        shutil.rmtree(self.root / "collapsed", ignore_errors=True)
        return info

    def begin_merge(self, voxel: float) -> None:
        """Start, or carry on, a merge at ``voxel``: what a merge at another spacing left goes."""
        mark = self.root / "merge.json"
        if mark.is_file() and json.loads(mark.read_text("utf-8")).get("voxel") == voxel:
            return
        for d in ("collapsed", "fused"):
            shutil.rmtree(self.root / d, ignore_errors=True)
        self.root.mkdir(parents=True, exist_ok=True)
        atomic_write_json(mark, {"voxel": voxel})

    def merging_voxel(self) -> float | None:
        """The spacing of the merge in progress or done, or None."""
        mark = self.root / "merge.json"
        return json.loads(mark.read_text("utf-8")).get("voxel") if mark.is_file() else None

    def finish_merge(self) -> dict:
        """Mark the merge complete (after any re-merge): nothing will change the tiles now."""
        info = {**self.info(), "complete": True}
        atomic_write_json(self.root / "fused" / "index.json", info)
        return info

    def counts(self) -> list[int]:
        """Points per fused tile, as ``fused/index.json`` lists them."""
        return [int(n) for n in (self.info().get("counts") or {}).values()]

    def drop_chunks(self) -> int:
        """Delete the fusion chunks (after a complete merge, founder decision of 13 Oct 2026).
        Answers the bytes freed."""
        base = self.chunks_dir
        if not base.is_dir():
            return 0
        freed = sum(p.stat().st_size for p in base.rglob("*") if p.is_file())
        shutil.rmtree(base, ignore_errors=True)
        return freed
```

`products.py`: line 601 becomes `info = store.merge(s["gsd"], keep, ctx.check, rule=SPARSE_RULE)` (import `SPARSE_RULE` from `.fuse` at the top of `_fuse`), line 634 becomes
`info = store.merge(voxel, keep, ctx.check, lambda f, m=None: ctx.progress(0.7 + 0.3 * f, m))`.

- [ ] **Step 4: Run the tests and see them pass**

Run: `uv run --frozen --directory python pytest tests/test_photo_dense.py tests/test_photo_surface.py -q`
Expected: PASS.

Run: `uv run --frozen --directory python pytest tests/test_photo_products.py -q`
Expected: PASS: the processed project still meets its targets (`test_the_dense_cloud_meets_the_targets`, `test_the_processed_dsm_and_dtm_meet_the_targets` in the surface file) and the Fast tests keep their sparse points. If `test_the_dense_cloud_meets_the_targets` fails on completeness (the share of 2 x GSD cells holding a point), report the share it measured instead of loosening the test.

- [ ] **Step 5: Commit**

```bash
git add python/src/aio_pipelines/photo/fuse.py python/src/aio_pipelines/photo/products.py python/tests/test_photo_dense.py python/tests/test_photo_surface.py
git commit -F msg.txt
```

```
feat(photo): merge v2 with column collapse and outlier filter

A tile drops voxels seen once, keeps one point per two voxels of height in each column
cluster, then loses statistical outliers over the tile and a one-voxel margin. The index
lists points per tile; a finished merge can drop its chunks.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

### Task 6: The budgeted, parallel merge

**Files:**

- Create: `python/src/aio_pipelines/photo/merge.py`
- Modify: `python/src/aio_pipelines/photo/pool.py`: new constant after `:31`, new functions after `plan_workers` (`:65`) and at the end of the file
- Test: `python/tests/test_photo_merge.py`

**Interfaces:**

- Consumes (Task 3): `needs_remerge`, `remerge_voxel`. (Task 5): `PointTiles.merge(..., run_tiles=...)`, `merging_voxel`, `finish_merge`, `merge_tile`, `filter_tile`, `MergeRule`, `DENSE_RULE`. `pool.run_pool`, `pool.PoolBroken`, `pool.forced_workers`, `pool.worker_threads`, `pool.cap_threads`, `pool._W`.
- Produces (Task 7):
  - `pool.MERGE_BYTES_PER_CHUNK_BYTE = 10`; `pool.plan_merge_workers(tiles: int, largest: int, budget: int, cores: int | None = None) -> int`; `pool.init_merge(root: str, chunks: str, tile_m: float, voxel: float, rule: MergeRule, keep, threads: int) -> None`; `pool.merge_task(name: str) -> dict`; `pool.filter_task(name: str) -> dict`.
  - `merge.RegionClip(wkt: str, dx: float, dy: float)`, frozen, callable `(xyz) -> np.ndarray` (bool).
  - `merge.merge_cloud(store: PointTiles, voxel: float, *, rule: MergeRule = DENSE_RULE, keep=None, budget: int = 0, memory: int, check=..., progress=..., log=...) -> dict`: the complete index (`points`, `voxel`, `bounds`, `counts`, `complete: True`, ...) plus `workers` and `remerged`.

- [ ] **Step 1: Write the failing tests**

`python/tests/test_photo_merge.py`:

```python
"""photo/merge.py and the merge workers of photo/pool.py: the budgeted, parallel merge."""

from __future__ import annotations

import pickle

import numpy as np
import pytest
from shapely.geometry import box

from aio_pipelines.photo import pool as P
from aio_pipelines.photo.fuse import PointTiles
from aio_pipelines.photo.merge import RegionClip, merge_cloud

GB = 1024**3
MB = 1024**2


def _store(root, chunks, seed: int = 3) -> PointTiles:
    """40,000 points over four 8 m tiles, as two photos' chunks per tile."""
    rng = np.random.default_rng(seed)
    n = 40_000
    xyz = np.column_stack([rng.uniform(0, 16, n), rng.uniform(0, 16, n), rng.normal(0, 0.01, n)])
    rgb = rng.integers(0, 256, (n, 3)).astype(np.uint8)
    store = PointTiles(root, 8.0, chunks=chunks)
    for k in range(2):
        store.add(f"v{k}", xyz[k::2], rgb[k::2], np.tile(np.float32([0, 0, 1]), (len(xyz[k::2]), 1)))
    return store


def _same(a: PointTiles, b: PointTiles) -> None:
    fa, fb = list(a.fused()), list(b.fused())
    assert [n for n, _ in fa] == [n for n, _ in fb] and fa
    for (_, pa), (_, pb) in zip(fa, fb, strict=True):
        for k in pa:
            np.testing.assert_array_equal(pa[k], pb[k])


@pytest.mark.parametrize(
    "tiles, largest, budget, cores, want",
    [
        (1, 100 * MB, 48 * GB, 24, 1),
        (16, 100 * MB, 48 * GB, 24, 8),  # the ceiling
        (16, 2 * GB, 16 * GB, 24, 1),  # one tile at a time fits the memory
        (16, 100 * MB, 48 * GB, 4, 2),  # half the cores
        (3, 100 * MB, 48 * GB, 24, 3),  # never more workers than tiles
    ],
)
def test_plan_merge_workers(monkeypatch, tiles, largest, budget, cores, want):
    monkeypatch.delenv(P.WORKERS_ENV, raising=False)
    assert P.plan_merge_workers(tiles, largest, budget, cores) == want


def test_two_workers_merge_the_tiles_of_one(tmp_path, monkeypatch):
    one, two = _store(tmp_path / "one", tmp_path / "c1"), _store(tmp_path / "two", tmp_path / "c2")
    monkeypatch.setenv(P.WORKERS_ENV, "1")
    a = merge_cloud(one, 0.1, memory=GB)
    monkeypatch.setenv(P.WORKERS_ENV, "2")
    b = merge_cloud(two, 0.1, memory=GB)
    assert (a["workers"], b["workers"]) == (1, 2) and a["points"] == b["points"] > 0
    assert a["complete"] is True and b["complete"] is True
    _same(one, two)


def test_a_region_clips_the_tiles_in_the_workers_too(tmp_path, monkeypatch):
    clip = RegionClip(box(0, 0, 10, 10).wkt, 0.0, 0.0)
    assert pickle.loads(pickle.dumps(clip)) == clip
    one, two = _store(tmp_path / "one", tmp_path / "c1"), _store(tmp_path / "two", tmp_path / "c2")
    monkeypatch.setenv(P.WORKERS_ENV, "1")
    merge_cloud(one, 0.1, keep=clip, memory=GB)
    monkeypatch.setenv(P.WORKERS_ENV, "2")
    merge_cloud(two, 0.1, keep=clip, memory=GB)
    _same(one, two)
    xyz = np.concatenate([p["xyz"] for _, p in two.fused()])
    assert xyz[:, 0].max() < 10.05 and xyz[:, 1].max() < 10.05


def test_a_broken_pool_merges_the_rest_here(tmp_path, monkeypatch):
    monkeypatch.setenv(P.WORKERS_ENV, "2")

    def broken(*a, **k):
        raise P.PoolBroken("a worker stopped")

    monkeypatch.setattr(P, "run_pool", broken)
    logs: list[str] = []
    store = _store(tmp_path / "m", tmp_path / "c")
    info = merge_cloud(store, 0.1, memory=GB, log=lambda m, level="info": logs.append(m))
    assert info["points"] > 0 and info["complete"] is True
    assert any("merging the rest here" in m for m in logs)


def test_a_cloud_over_its_budget_is_merged_again_wider(tmp_path, monkeypatch):
    monkeypatch.setenv(P.WORKERS_ENV, "1")
    store = _store(tmp_path / "m", tmp_path / "c")
    info = merge_cloud(store, 0.1, budget=4000, memory=GB)
    assert info["remerged"] >= 1 and info["voxel"] > 0.1
    assert info["points"] <= 1.2 * 4000 or info["remerged"] == 2
    assert store.merging_voxel() == info["voxel"]


def test_a_merge_stopped_midway_carries_on_at_its_spacing(tmp_path, monkeypatch):
    monkeypatch.setenv(P.WORKERS_ENV, "1")
    store = _store(tmp_path / "m", tmp_path / "c")
    store.begin_merge(0.2)  # a re-merge was under way when the job stopped
    assert merge_cloud(store, 0.1, memory=GB)["voxel"] == 0.2


def test_merge_progress_counts_the_tiles(tmp_path, monkeypatch):
    monkeypatch.setenv(P.WORKERS_ENV, "2")
    seen: list = []
    merge_cloud(_store(tmp_path / "m", tmp_path / "c"), 0.1, memory=GB, progress=lambda f, m=None: seen.append(m))
    assert "Merging tile 4 of 4" in seen and seen[-1] == "Cleaning tile 4 of 4"
```

- [ ] **Step 2: Run them and see them fail**

Run: `uv run --frozen --directory python pytest tests/test_photo_merge.py -q`
Expected: FAIL: `ModuleNotFoundError: No module named 'aio_pipelines.photo.merge'`.

- [ ] **Step 3: Implement `pool.py`**

After `FUSE_BYTES_PER_PIXEL` (line 31):

```python
#: Memory of merging one tile per byte of its chunks: unpacked to float64, voxel keys, sorting.
MERGE_BYTES_PER_CHUNK_BYTE = 10
```

After `plan_workers`:

```python
def plan_merge_workers(tiles: int, largest: int, budget: int, cores: int | None = None) -> int:
    """How many tiles to merge at once: as many as fit 80% of the memory budget at the largest
    tile's chunk bytes, half the cores and ``MAX_WORKERS``."""
    if tiles <= 1:
        return 1
    forced = forced_workers()
    if forced is not None:
        return min(forced, tiles)
    cores = cores or os.cpu_count() or 1
    by_memory = int(0.8 * budget // max(1, largest * MERGE_BYTES_PER_CHUNK_BYTE))
    return max(1, min(MAX_WORKERS, max(1, cores // 2), by_memory, tiles))
```

At the end of the file:

```python
# ---------------------------------------------------------------------------------------- merge


def init_merge(root: str, chunks: str, tile_m: float, voxel: float, rule, keep, threads: int) -> None:
    from pathlib import Path

    from .fuse import PointTiles

    cap_threads(threads)
    _W.clear()
    _W.update(
        {"store": PointTiles(Path(root), tile_m, chunks=Path(chunks)), "voxel": voxel, "rule": rule, "keep": keep}
    )


def merge_task(name: str) -> dict[str, Any]:
    from .fuse import merge_tile

    return merge_tile(_W["store"], name, _W["voxel"], _W["rule"], _W["keep"])


def filter_task(name: str) -> dict[str, Any]:
    from .fuse import filter_tile

    return filter_tile(_W["store"], name, _W["voxel"], _W["rule"])
```

- [ ] **Step 4: Implement `merge.py`**

```python
"""The budgeted, parallel merge of the fused tiles (``photo.products`` step ``fuse``).

``merge_cloud`` runs ``PointTiles.merge``'s two passes in worker processes (``pool``) when there
are several tiles and the memory for them: as many as fit 80 % of the memory budget at the
largest tile's chunk bytes. A worker that stops makes the pass finish here. When the cloud ends
above 1.2 x its point budget it is merged again, wider, from the chunks (at most twice), and the
merge is marked complete only then.
"""

from __future__ import annotations

import functools
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import numpy as np

from . import pool
from .budget import needs_remerge, remerge_voxel
from .fuse import DENSE_RULE, MergeRule, PointTiles, filter_tile, merge_tile

MAX_REMERGES = 2


@functools.lru_cache(maxsize=8)
def _polygon(wkt: str):
    import shapely

    return shapely.from_wkt(wkt)


@dataclass(frozen=True)
class RegionClip:
    """The processing region as a test for model points that worker processes can be sent: the
    polygon's WKT in the project CRS and the model-to-project shift (``dx``, ``dy``)."""

    wkt: str
    dx: float
    dy: float

    def __call__(self, xyz: np.ndarray) -> np.ndarray:
        import shapely

        return shapely.contains_xy(_polygon(self.wkt), xyz[:, 0] + self.dx, xyz[:, 1] + self.dy)


def _chunk_bytes(store: PointTiles, name: str) -> int:
    return sum(p.stat().st_size for p in (store.chunks_dir / name).glob("*.npz"))


def _merge_once(store, voxel, rule, keep, memory, check, progress, log) -> tuple[dict, int]:
    names = store.chunk_tiles()
    largest = max((_chunk_bytes(store, n) for n in names), default=0)
    workers = pool.plan_merge_workers(len(names), largest, memory)
    if workers <= 1:
        return store.merge(voxel, keep, check, progress, rule), 1
    log(f"Merging {len(names)} tiles, {workers} at a time.")

    def run_tiles(kind: str, todo: list[str], v: float, r: MergeRule, k, done) -> None:
        finished: set[str] = set()

        def got(name: str, res: dict) -> None:
            finished.add(name)
            done(name, res)

        task = pool.merge_task if kind == "merge" else pool.filter_task
        args = (str(store.root), str(store.chunks_dir), store.tile, v, r, k, pool.worker_threads(workers))
        try:
            pool.run_pool(workers, pool.init_merge, args, task, todo, check, got)
        except pool.PoolBroken:
            log("A worker process stopped; merging the rest here.", "warn")
            for name in todo:
                if name in finished:
                    continue
                check()
                got(name, merge_tile(store, name, v, r, k) if kind == "merge" else filter_tile(store, name, v, r))

    return store.merge(voxel, keep, check, progress, rule, run_tiles), workers


def merge_cloud(
    store: PointTiles,
    voxel: float,
    *,
    rule: MergeRule = DENSE_RULE,
    keep: Callable[[np.ndarray], np.ndarray] | None = None,
    budget: int = 0,
    memory: int,
    check: Callable[[], None] = lambda: None,
    progress: Callable[[float, str | None], None] = lambda f, m=None: None,
    log: Callable[..., None] = lambda message, level="info": None,
) -> dict[str, Any]:
    """Merge the tiles at ``voxel`` (or at the spacing a stopped merge was at), in parallel when
    it fits ``memory``, again wider when the cloud ends above 1.2 x ``budget``; then mark it
    complete. Answers the index plus ``workers`` and ``remerged``."""
    v = store.merging_voxel() or voxel
    remerged = 0
    while True:
        info, workers = _merge_once(store, v, rule, keep, memory, check, progress, log)
        if remerged >= MAX_REMERGES or not needs_remerge(info["points"], budget):
            break
        v = remerge_voxel(v, info["points"], budget)
        remerged += 1
        log(
            f"The cloud has {info['points']:,} points, more than its budget of {budget:,}; "
            f"merging again at {v * 100:.1f} cm."
        )
    return {**store.finish_merge(), "workers": workers, "remerged": remerged}
```

- [ ] **Step 5: Run the tests and see them pass**

Run: `uv run --frozen --directory python pytest tests/test_photo_merge.py -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add python/src/aio_pipelines/photo/merge.py python/src/aio_pipelines/photo/pool.py python/tests/test_photo_merge.py
git commit -F msg.txt
```

```
feat(photo): budgeted parallel merge of the fused tiles

Both merge passes run in worker processes sized by the largest tile's chunks against the
memory budget, finish here when a worker stops, clip to the region in the workers too, and
merge again wider when the cloud ends above 1.2 x its budget.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

### Task 7: Work layout 2 in photo.products

**Files:**

- Modify: `python/src/aio_pipelines/photo/products.py`: module docstring `:23-28`; constants after `:84`; helpers after `_hash` (`:90-91`); `_settings`, `_work`, `_tiles_store` (`:325-336`); `_prepare` (`:339-405`); `_dense` (`:415`); `_fuse` (`:584-644`)
- Test: `python/tests/test_photo_products.py:1-26` (imports), `:199-216`, `:384-401`, new tests after `:256`
- Test: `python/tests/test_photo_pool.py:164-170` (`_fused`), `:182-190`

**Interfaces:**

- Consumes: Task 2 `FuseSettings.for_run`, `CHUNK_FORMAT`; Task 3 `BUDGET`, `site_area`, `budget_voxel`, `disk_need`; Task 4 `cloud_out.NO_COPC_TOOL`, `native.find_tool("untwine")`; Task 5 `DENSE_RULE`, `SPARSE_RULE`, `PointTiles(..., chunks=)`, `info()`, `drop_chunks()`; Task 6 `merge_cloud`, `RegionClip`.
- Produces (Task 8): `products.LAYOUT = 2`; `products.OLD_LAYOUT` (text); `depth_key(scale: float, dense: str, region) -> str`; `fuse_key(dkey: str, settings: FuseSettings, tile_m: float) -> str`; `merge_key(ckey: str, voxel: float, budget: int, rule: MergeRule) -> str`; `legacy_cleanup(folder: Path) -> int`; `PhotoProducts._settings(ctx)` raising `OLD_LAYOUT` without `layout: 2`; `_work(ctx)` (the `m-<mkey>` folder), `_depth_dir(ctx)`, `_tiles_store(ctx)` (`PointTiles(work, tileM, chunks=chunks)`); prepare outputs `layout`, `depthWork`, `chunks`, `work`, `voxel`, `budget`, `areaM2`, `tileM` (plus the existing keys); fuse outputs `points`, `voxel`, `bounds`, `source`, `budget`, `mergeWorkers`, `remerged` (plus `workers`, `device`, `fallbacks` of the per-photo stage).

- [ ] **Step 1: Write the failing tests**

`python/tests/test_photo_products.py`: imports gain `from aio_pipelines.photo.products import PhotoProducts, depth_key`. In `test_the_dense_cloud_meets_the_targets`, lines 200-204 become

```python
    root, res, _ = processed
    from aio_pipelines.photo.fuse import PointTiles

    store = PointTiles(root / res["outputs"]["prepare"]["work"], 1.0)
```

(the `work = next(...)` line goes), and in the PoissonRecon test replace line 399 with `work = root / res["outputs"]["prepare"]["work"]`. After `test_changed_alignment_refuses_the_resume` (line 256) add:

```python
STANDARD = {"run": RUN, "products": ["dsm"], "preset": "standard"}


def _after(step: str):
    cancel = threading.Event()

    def emit(m, p):
        if m == "progress" and p.get("step") == step and p.get("stepFraction") == 1.0:
            cancel.set()

    return emit, cancel


def _prepare_outputs(root, job: str) -> dict:
    return json.loads((root / "jobs" / job / "steps" / "01-prepare.json").read_text("utf-8"))["outputs"]


def test_the_depth_key_is_unchanged():
    # the depth maps of runs made before layout 2 sit under this key and are found again
    assert depth_key(0.5, "auto", None) == "7bea1144efd8"
    assert depth_key(1.0, "auto", None) == "de395fb6663c"


def test_prepare_lays_out_the_work_folders_by_key():
    root = ps.project("layout")
    emit, cancel = _after("prepare")
    with pytest.raises(Cancelled):
        Job("l1", PhotoProducts(), root, STANDARD, emit, cancel).run()
    s = _prepare_outputs(root, "l1")
    base = f"photogrammetry/{RUN}/work/products/7bea1144efd8"
    assert s["layout"] == 2 and s["depthWork"] == base
    assert re.fullmatch(re.escape(base) + r"/c-[0-9a-f]{12}/chunks", s["chunks"])
    assert re.fullmatch(re.escape(base) + r"/c-[0-9a-f]{12}/m-[0-9a-f]{12}", s["work"])
    assert s["work"].rsplit("/", 1)[0] == s["chunks"].rsplit("/", 1)[0]
    assert s["budget"] == 150_000_000 and s["voxel"] == pytest.approx(round(s["gsd"] / 0.5, 6))
    assert s["areaM2"] > 100 and s["tileM"] == pytest.approx(max(16.0, 1024 * s["dsmRes"]))


def test_a_new_start_clears_an_older_versions_files_and_reuses_the_depth_maps():
    root = ps.project("legacy")
    emit, cancel = _after("dense")
    with pytest.raises(Cancelled):
        Job("o1", PhotoProducts(), root, STANDARD, emit, cancel).run()
    key = root / "photogrammetry" / RUN / "work" / "products" / "7bea1144efd8"
    maps = len(list((key / "depth").glob("*.npy")))
    assert maps == len(ps.scene().views)
    # what a version before layout 2 left beside the depth maps
    (key / "cloud" / "chunks" / "0_0").mkdir(parents=True)
    (key / "cloud" / "chunks" / "0_0" / "v1.npz").write_bytes(b"\0" * 1000)
    for name in ("cloud.las", "copc-pipeline.json", "dsm-raw.tif", "zmin-raw.tif"):
        (key / name).write_bytes(b"\0" * 500)
    res, rec = run_job(PhotoProducts(), root, STANDARD, job_id="n1")
    assert res["status"] == "done" and res["outputs"]["dense"]["resumed"] == maps
    for gone in ("cloud", "cloud.las", "copc-pipeline.json", "dsm-raw.tif", "zmin-raw.tif"):
        assert not (key / gone).exists(), gone
    assert len(list((key / "depth").glob("*.npy"))) == maps
    assert any("older version left" in p.get("message", "") for p in rec.of("log"))
    s = res["outputs"]["prepare"]
    assert not (root / s["chunks"]).exists()  # the chunks went after the merge
    index = json.loads((root / s["work"] / "fused" / "index.json").read_text("utf-8"))
    assert index["complete"] is True and index["points"] == res["outputs"]["fuse"]["points"]


def test_a_job_started_before_layout_2_is_refused_when_resumed():
    root = ps.project("old-job")
    emit, cancel = _after("prepare")
    with pytest.raises(Cancelled):
        Job("x2", PhotoProducts(), root, STANDARD, emit, cancel).run()
    sf = root / "jobs" / "x2" / "steps" / "01-prepare.json"
    rec = json.loads(sf.read_text("utf-8"))
    for k in ("layout", "depthWork", "chunks", "voxel", "budget", "areaM2"):
        rec["outputs"].pop(k)
    sf.write_text(json.dumps(rec), "utf-8")
    with pytest.raises(JobError, match=r"started by an older version; start the processing again"):
        Job("x2", PhotoProducts(), root, STANDARD, Recorder(), threading.Event()).run()
```

Change the expected message of `test_a_cloud_without_pdal_is_refused_before_any_work` (lines 565-572): add `monkeypatch.setenv("AIO_UNTWINE", str(tmp_path / "no-untwine.exe"))` as its first line and `match="needs untwine or PDAL"`.

`python/tests/test_photo_pool.py`, `_fused` and its caller:

```python
def _fused(root, job: str):
    work = _step(root, job, "01-prepare.json")["work"]
    out = {}
    for p in sorted((root / work / "fused").glob("*.npz")):
        with np.load(p) as z:
            out[p.name] = {k: z[k] for k in z.files}
    return out
```

and in `test_two_workers_fuse_the_cloud_of_one`: `one = _fused(_fuse_only("fuse-one", monkeypatch, "1"), "f1")`, `two = _fused(root, "f1")`.

- [ ] **Step 2: Run them and see them fail**

Run: `uv run --frozen --directory python pytest tests/test_photo_products.py -k "depth_key or lays_out or older_version or before_layout or without_pdal" -q`
Expected: FAIL at import: `cannot import name 'depth_key' from 'aio_pipelines.photo.products'`.

- [ ] **Step 3: Implement**

Module docstring, lines 23-28: "Intermediates live in `photogrammetry/<run>/work/products/<dkey>/` (layout 2, 13 Oct 2026): `depth/` there, the fusion chunks in `c-<ckey>/chunks` and the merged cloud, rasters, LAS and mesh in `c-<ckey>/m-<mkey>/`; each key hashes the settings that change what is under it, so a job with other products reuses the depth maps, and new fusion or merge rules never mix with old files."

Keep `PDAL_FOR_CLOUD` (lines 81-84) for now: the old `_cloud` still names it until Task 8 removes both. After the constants add:

```python
LAYOUT = 2
OLD_LAYOUT = (
    "This processing was started by an older version; start the processing again "
    "(the depth maps are kept)."
)
#: What a depth key's folder held before layout 2; none of it is read any more.
LEGACY_NAMES = (
    "cloud", "cloud.las", "copc-pipeline.json", "dtm-pipeline.json", "ground-pdal.tif", "gains.json",
    "poisson", "mesh-full.npz",
)  # fmt: skip
LEGACY_GLOBS = ("*-raw.tif", "*.tmp.tif", "*-shaded.tif", "texrecon-*")
```

After `_hash`:

```python
def depth_key(scale: float, dense: str, region) -> str:
    """The depth maps' key: unchanged since layout 1, so earlier depth maps are found."""
    return _hash({"scale": scale, "dense": dense, "region": region, "v": 1})


def fuse_key(dkey: str, settings, tile_m: float) -> str:
    from dataclasses import asdict

    from .fuse import CHUNK_FORMAT

    return _hash({"d": dkey, "fuse": asdict(settings), "chunk": CHUNK_FORMAT, "tile": tile_m})


def merge_key(ckey: str, voxel: float, budget: int, rule) -> str:
    from dataclasses import asdict

    return _hash({"c": ckey, "voxel": voxel, "budget": budget, "merge": asdict(rule)})


def legacy_cleanup(folder: Path) -> int:
    """Delete what a version before layout 2 left in a depth key's folder (the cloud tiles, the
    LAS, the rasters, the mesh); ``depth/`` and layout 2's ``c-*`` folders stay. Answers the bytes
    freed."""
    if not folder.is_dir():
        return 0
    found = [folder / n for n in LEGACY_NAMES] + [p for g in LEGACY_GLOBS for p in folder.glob(g)]
    freed = 0
    for p in found:
        if p.is_dir():
            freed += sum(q.stat().st_size for q in p.rglob("*") if q.is_file())
            shutil.rmtree(p, ignore_errors=True)
        elif p.is_file():
            freed += p.stat().st_size
            p.unlink(missing_ok=True)
    return freed
```

`_settings`, `_work`, `_tiles_store` (lines 325-336):

```python
    def _settings(self, ctx: StepContext) -> dict[str, Any]:
        s = ctx.outputs("prepare")
        if s.get("layout") != LAYOUT:
            raise JobError(OLD_LAYOUT)
        return s

    def _work(self, ctx: StepContext) -> Path:
        return safe_project_path(ctx.project, self._settings(ctx)["work"])

    def _depth_dir(self, ctx: StepContext) -> Path:
        return safe_project_path(ctx.project, self._settings(ctx)["depthWork"]) / "depth"

    def _tiles_store(self, ctx: StepContext):
        from .fuse import PointTiles

        s = self._settings(ctx)
        return PointTiles(self._work(ctx), s["tileM"], chunks=safe_project_path(ctx.project, s["chunks"]))
```

`_prepare` (lines 339-405), from `scale = SCALE[preset]` on:

```python
        scale = SCALE[preset]
        n = len(model.views)
        cam = model.views[0].camera
        px = cam.width * cam.height
        from .budget import BUDGET, budget_voxel, disk_need, site_area
        from .fuse import DENSE_RULE, SPARSE_RULE, FuseSettings

        poly = _region_poly(p.get("region"), run.epsg)
        xy = model.points[:, :2] + np.asarray(run.offset[:2], np.float64)
        area = max(1.0, site_area(xy, poly))
        budget = BUDGET[preset] if scale else 0
        voxel = round(budget_voxel(gsd, scale, area, budget), 6)
        tile_m = max(16.0, 1024 * dsm_res)
        dkey = depth_key(scale, p.get("dense", "auto"), p.get("region"))
        ckey = fuse_key(dkey, FuseSettings.for_run(gsd, scale), tile_m)
        mkey = merge_key(ckey, voxel, budget, DENSE_RULE if scale else SPARSE_RULE)
        base = f"photogrammetry/{run.id}/work/products/{dkey}"
        freed = legacy_cleanup(safe_project_path(ctx.project, base))
        if freed:
            ctx.log(f"Removed {native._gb(freed)} of intermediate files an older version left.")
        if "cloud" in p["products"]:
            from ..pointcloud import find_pdal
            from .cloud_out import NO_COPC_TOOL

            if native.find_tool("untwine") is None and find_pdal() is None:
                raise JobError(NO_COPC_TOOL)
        need = disk_need(
            photos=n, pixels=px, scale=scale, area=area, gsd=gsd, ortho_res=ortho_res, dsm_res=dsm_res,
            voxel=voxel, budget=budget, sparse_points=len(model.points), cloud="cloud" in p["products"],
        )  # fmt: skip
        free = native.check_disk(ctx.project, need)
        nadir = nadir_share(model.views)
        ctx.log(
            f"{n} photos, GSD {gsd * 100:.1f} cm; ortho {ortho_res * 100:.1f} cm, DSM {dsm_res * 100:.1f} cm; "
            f"preset {preset}{' (no dense matching)' if not scale else f', matching at {scale:.0%} size'}."
        )
        if budget:
            ctx.log(
                f"Point budget {budget / 1e6:.0f} M over {area / 1e4:.2f} ha: cloud spacing {voxel * 100:.1f} cm."
            )
        return {
            "layout": LAYOUT,
            "preset": preset,
            "gsd": gsd,
            "orthoRes": ortho_res,
            "dsmRes": dsm_res,
            "scale": scale,
            "depthWork": base,
            "chunks": f"{base}/c-{ckey}/chunks",
            "work": f"{base}/c-{ckey}/m-{mkey}",
            "tileM": tile_m,
            "voxel": voxel,
            "budget": budget,
            "areaM2": round(area, 1),
            "photos": n,
            "nadirShare": round(nadir, 3),
            "groundZ": float(np.median(model.points[:, 2])) if len(model.points) else 0.0,
            "disk": {"neededBytes": need, "freeBytes": int(free)},
            "memoryBudgetBytes": native.memory_budget(),
        }
```

(the old disk block of lines 365-385 and the old `key`/`work` lines go.)

`_dense`, line 415: `out = self._depth_dir(ctx)`.

`_fuse` (lines 584-644) becomes:

```python
    def _fuse(self, ctx: StepContext) -> dict[str, Any]:
        from .fuse import DENSE_RULE, SPARSE_RULE
        from .merge import RegionClip, merge_cloud

        s = self._settings(ctx)
        run = self._run(ctx)
        store = self._tiles_store(ctx)
        source = "dense" if s["scale"] else "sparse"
        done = store.info()
        if done.get("complete"):  # a stopped job that had merged already
            store.drop_chunks()
            return self._fused_outputs(done, s, source, {})
        poly = _region_poly(ctx.params.get("region"), run.epsg)
        keep = RegionClip(poly.wkt, float(run.offset[0]), float(run.offset[1])) if poly is not None else None
        memory = native.memory_budget()
        ran: dict[str, Any] = {}
        if not s["scale"]:
            pts = run.model.points
            nrm = np.tile(np.array([0, 0, 1], np.float32), (len(pts), 1))
            store.add("sparse", pts, run.model.colours, nrm)
            info = merge_cloud(store, s["voxel"], rule=SPARSE_RULE, keep=keep, memory=memory, check=ctx.check, log=ctx.log)
        else:
            ran = self._fuse_photos(ctx, store)
            info = merge_cloud(
                store,
                s["voxel"],
                rule=DENSE_RULE,
                keep=keep,
                budget=s["budget"],
                memory=memory,
                check=ctx.check,
                progress=lambda f, m=None: ctx.progress(0.7 + 0.3 * f, m),
                log=ctx.log,
            )
            if not info["points"]:
                raise JobError("Dense matching found no consistent points; the photos may not overlap enough.")
        freed = store.drop_chunks()
        ctx.log(
            f"Dense cloud: {info['points']:,} points at {info['voxel'] * 100:.1f} cm spacing"
            + (f" (budget {s['budget']:,})" if s["budget"] else "")
            + f"; {native._gb(freed)} of fusion chunks removed."
        )
        return self._fused_outputs(
            info, s, source, {**ran, "mergeWorkers": info["workers"], "remerged": info["remerged"]}
        )

    @staticmethod
    def _fused_outputs(info: dict, s: dict, source: str, extra: dict) -> dict[str, Any]:
        return {
            "points": int(info["points"]),
            "voxel": info["voxel"],
            "bounds": info["bounds"],
            "source": source,
            "budget": s["budget"],
            **extra,
        }

    def _fuse_photos(self, ctx: StepContext, store) -> dict[str, Any]:
        """Fuse every photo not yet fused into chunks: on the card, in workers or here."""
        from . import pool
        from .fuse import FuseSettings

        s = self._settings(ctx)
        run = self._run(ctx)
        views = run.model.views
        depth_dir = self._depth_dir(ctx)
        abs_tol = FuseSettings.for_run(s["gsd"], s["scale"]).abs_tol
        root = store.chunks_dir.parent
        state = pool.fuse_state(run.model, s["scale"], depth_dir, root, s["tileM"], abs_tol)
        marks = state["marks"]
        todo = [v.id for v in views if not (marks / str(v.id)).exists()]
        cam = views[0].camera.scaled(s["scale"])
        return self._each_photo(
            ctx,
            todo=todo,
            photos=len(views),
            pixels=cam.width * cam.height,
            cpu_bytes=pool.FUSE_BYTES_PER_PIXEL,
            init=pool.init_fuse,
            args=lambda n: (
                str(ctx.project),
                ctx.params["run"],
                s["scale"],
                str(depth_dir),
                str(root),
                s["tileM"],
                abs_tol,
                pool.worker_threads(n),
            ),
            task=pool.fuse_task,
            here=lambda view_id: pool.fuse_photo(state, view_id),
            is_done=lambda view_id: (marks / str(view_id)).exists(),
            progress=lambda k, n: ctx.progress(0.7 * k / n, f"Fusing photo {k} of {n}"),
            words=("Fusion", "Fusing", "fusing the rest one photo at a time"),
        )
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `uv run --frozen --directory python pytest tests/test_photo_products.py -q`
Expected: PASS, except `test_the_cloud_and_dtm_go_through_pdal`, which still asserts the PDAL DTM engine and is rewritten in Task 8; if it fails here, note it and go on.

Run: `uv run --frozen --directory python pytest tests/test_photo_pool.py tests/test_photo_card_job.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add python/src/aio_pipelines/photo/products.py python/tests/test_photo_products.py python/tests/test_photo_pool.py
git commit -F msg.txt
```

```
feat(photo): work layout 2, legacy cleanup and the old-job refusal

Depth, fusion and merge keys each get their folder, so the depth maps are found again and
new rules never meet old tiles. prepare plans the budget and spacing, removes what an older
version left before the disk check, and steps refuse a job begun by an older version.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

### Task 8: DTM before the cloud, ground from the DTM, capped mesh input, the report

**Files:**

- Modify: `python/src/aio_pipelines/photo/products.py`: docstring table `:9-21`; `STAGES` `:76`; `plan` `:292-313`; `_cloud` `:646-683`; `_dtm` `:777-805`; `_mesh` `:860-890`; `_report` `:1119-1160`
- Modify: `python/src/aio_pipelines/photo/surface.py:1-15` (docstring), `:351-400` (`dtm_grid`), delete `:408-425` (`read_grid_on`) and `:437-466` (the PDAL ground section)
- Modify: `python/src/aio_pipelines/photo/mesh.py:394-405` (`poisson_tool` tool calls), `:428-432` (new `meshlab_points`, `mesh_sample`), `:587`
- Modify: `python/src/aio_pipelines/photo/texture.py:39`, `:332-338`
- Modify: `python/src/aio_pipelines/photo/fuse.py:197-247` (delete `write_las_tiles`)
- Test: `python/tests/test_photo_products.py:120-128`, `:499-572`, new tests
- Test: `python/tests/test_photo_surface.py:129-135` (delete), new test
- Test: `python/tests/test_photo_mesh.py:123-138`, `:361-375`, new test
- Test: `python/tests/test_photo_dense.py:281-299` (delete the LAS test, now in `test_photo_cloud_out.py`)

**Interfaces:**

- Consumes: Task 4 `write_las`, `write_copc`; Task 5 `PointTiles.counts()`; Task 7 `_settings`, `_work`, `_tiles_store`, prepare's `budget`.
- Produces: `STAGES = ("dense", "fuse", "dsm", "dtm", "cloud", "ortho", "mesh", "texture", "commit", "tiles")`; `surface.dtm_grid(dsm_path, zmin_path, spec, out, epsg, budget, check, progress=lambda f, m=None: None) -> dict` (engine always `smrf-grid`); `mesh.meshlab_points(memory_budget: int) -> int`; `mesh.mesh_sample(counts: Sequence[int], cap: int) -> tuple[int, int]`; cloud outputs `points`, `ground`, `writer`, `path`, `bytes`; dtm outputs `engine: "smrf-grid"`; report `cloud.budget`, `cloud.groundPoints`, `cloud.writer` (the last two only when a cloud was made).

- [ ] **Step 1: Write the failing tests**

`python/tests/test_photo_products.py`: in `test_the_products_report` add

```python
    assert r["cloud"]["budget"] == 400_000_000 and "writer" not in r["cloud"]
    assert r["cloud"]["spacingM"] == pytest.approx(r["gsdCm"]["photos"] / 100, abs=1e-3)  # High: the GSD
```

Replace the PDAL section (lines 499-563) with:

```python
# ------------------------------------------------------------------- the cloud (fake untwine, PDAL)

FAKE_UNTWINE = r"""
import os, shutil, sys
args = sys.argv[1:]
open(os.environ["FAKE_UNTWINE_ARGS"], "w").write(" ".join(args))
print("Untwine progress (50% done): Bulk", flush=True)
shutil.copyfile(args[args.index("-i") + 1], args[args.index("-o") + 1])
"""

FAKE_PDAL = r"""
import json, shutil, sys
args = sys.argv[1:]
assert args[0] == "pipeline", args
stages = json.load(open(args[1]))["pipeline"]
assert [s["type"] for s in stages] == ["readers.las", "writers.copc"], stages
shutil.copyfile(stages[0]["filename"], stages[-1]["filename"])
"""


def test_a_cloud_alone_runs_the_dsm_and_dtm_and_publishes_no_dtm(tmp_path, monkeypatch):
    from aio_pipelines.change.las import read_las

    monkeypatch.setenv("AIO_UNTWINE", str(ps.fake_tool(tmp_path / "tools", "untwine", FAKE_UNTWINE)))
    monkeypatch.setenv("FAKE_UNTWINE_ARGS", str(tmp_path / "untwine.args"))
    root = ps.project("cloud-only")
    res, rec = run_job(PhotoProducts(), root, _params(preset="fast", products=["cloud"]))
    assert list(res["outputs"]) == ["prepare", "dense", "fuse", "dsm", "dtm", "cloud", "commit"]
    manifest = json.loads((root / "manifest.json").read_text("utf-8"))
    assert [x["id"] for x in manifest["layers"]] == [f"{RUN}-cloud"]
    assert not (root / "photogrammetry" / RUN / "dtm.tif").exists()
    assert not (root / "rasters" / f"{RUN}-dtm").exists()
    args = (tmp_path / "untwine.args").read_text().split()
    assert args[args.index("--a_srs") + 1] == f"EPSG:{ps.EPSG}" and "--progress_debug" in args
    las = read_las(root / "clouds" / f"{RUN}.copc.laz")  # the fake passes the LAS through
    cls = las.field("Classification")
    assert set(np.unique(cls).tolist()) <= {1, 2} and (cls == 2).any()
    assert manifest["layers"][0]["pointCount"] == las.count
    r = json.loads((root / "photogrammetry" / RUN / "report" / "products.json").read_text("utf-8"))
    assert r["engines"]["ground"] == "smrf-grid" and r["cloud"]["writer"] == "untwine"
    assert r["cloud"]["groundPoints"] == int((cls == 2).sum()) and r["cloud"]["budget"] == 0
    messages = [p.get("message") for p in rec.of("progress") if p.get("step") == "cloud"]
    assert any(m and m.startswith("Writing the cloud: tile") for m in messages)
    assert not (root / "jobs" / "j1" / "staging" / ".copc-tmp").exists()


def test_without_untwine_the_cloud_goes_through_pdal(tmp_path, monkeypatch):
    monkeypatch.setenv("AIO_UNTWINE", str(tmp_path / "no-untwine.exe"))
    monkeypatch.setenv("AIO_PDAL", str(ps.fake_tool(tmp_path / "tools", "pdal", FAKE_PDAL)))
    root = ps.project("pdal")
    res, _ = run_job(PhotoProducts(), root, _params(preset="fast", products=["cloud", "dsm", "dtm"]))
    manifest = json.loads((root / "manifest.json").read_text("utf-8"))
    cloud = next(x for x in manifest["layers"] if x["kind"] == "pointcloud")
    assert cloud == {
        "kind": "pointcloud",
        "id": f"{RUN}-cloud",
        "name": f"Point cloud {RUN}",
        "visible": True,
        "src": {"path": f"clouds/{RUN}.copc.laz"},
        "format": "copc",
        "pointCount": res["outputs"]["cloud"]["points"],
    }
    assert res["outputs"]["cloud"]["writer"] == "pdal" and res["outputs"]["dtm"]["engine"] == "smrf-grid"
    assert {x["id"] for x in manifest["layers"]} == {f"{RUN}-cloud", f"{RUN}-dsm", f"{RUN}-dtm"}
    with rasterio.open(root / "photogrammetry" / RUN / "dtm.tif") as ds:
        assert (
            ds.crs.to_epsg() == ps.EPSG and np.isfinite(ds.read(1, masked=True).filled(np.nan)).mean() > 0.5
        )


def test_the_mesh_input_is_capped_at_what_meshlab_keeps(tmp_path, monkeypatch):
    import aio_pipelines
    import aio_pipelines.photo.mesh as mesh_mod

    src = str(Path(aio_pipelines.__file__).parents[1])
    monkeypatch.setenv(
        "AIO_POISSONRECON",
        str(ps.fake_tool(tmp_path, "PoissonRecon", FAKE_POISSON.replace("{src!r}", repr(src)))),
    )
    monkeypatch.setenv("AIO_SURFACETRIMMER", str(tmp_path / "none.exe"))
    monkeypatch.setattr(mesh_mod, "meshlab_points", lambda budget: 20_000)
    root = ps.project("mesh-cap")
    res, _ = run_job(PhotoProducts(), root, _params(preset="standard", products=["mesh"], meshTriangles=10_000))
    work = root / res["outputs"]["prepare"]["work"]
    head = (work / "poisson" / "dense.ply").read_bytes()[:400].decode("ascii", errors="replace")
    n = int(re.search(r"element vertex (\d+)", head).group(1))
    assert res["outputs"]["fuse"]["points"] > 20_000 >= n > 10_000
```

`python/tests/test_photo_surface.py`: delete `test_the_pdal_ground_pipeline_classifies_then_grids` (lines 129-135) and add:

```python
def test_the_dtm_reports_its_windows(tmp_path):
    spec = S.GridSpec(0.0, 8.0, 0.5, 2100, 16)  # three windows of 1024 columns
    z = np.full((16, 2100), 10.0, np.float32)
    for name in ("dsm.tif", "zmin.tif"):
        with S.write_tif(tmp_path / name, spec, None, 1, "float32", S.NODATA) as ds:
            ds.write(z, 1)
    seen: list = []
    info = S.dtm_grid(tmp_path / "dsm.tif", tmp_path / "zmin.tif", spec, tmp_path / "dtm.tif", None,
                      2**30, lambda: None, lambda f, m=None: seen.append((f, m)))  # fmt: skip
    assert info["engine"] == "smrf-grid"
    assert [m for _, m in seen] == [f"Terrain window {i} of 3" for i in (1, 2, 3)] and seen[-1][0] == 1.0
    assert np.isfinite(S.read_grid(tmp_path / "dtm.tif")).all()
```

`python/tests/test_photo_mesh.py`: add after `test_the_poisson_tool_is_called_and_its_mesh_read`:

```python
def test_the_poisson_tools_run_within_the_memory_budget(tmp_path, monkeypatch):
    monkeypatch.setenv("AIO_PHOTO_MEMORY_MB", "700")
    src = str(ps.Path(M.__file__).parents[2])
    monkeypatch.setenv(
        "AIO_POISSONRECON",
        str(ps.fake_tool(tmp_path / "tools", "PoissonRecon", FAKE_POISSON.replace("{src!r}", repr(src)))),
    )
    monkeypatch.setenv(
        "AIO_SURFACETRIMMER", str(ps.fake_tool(tmp_path / "tools", "SurfaceTrimmer", FAKE_TRIMMER))
    )
    calls: list = []
    real = M.native.run_tool
    monkeypatch.setattr(M.native, "run_tool", lambda *a, **k: calls.append(k) or real(*a, **k))
    rng = np.random.default_rng(2)
    pts = np.column_stack([rng.uniform(0, 10, 3000), rng.uniform(0, 10, 3000), rng.uniform(0, 0.1, 3000)])
    M.poisson_tool(_ctx(tmp_path), tmp_path / "work", pts, np.tile([0.0, 0.0, 1.0], (3000, 1)), 9)
    assert [c.get("memory_limit") for c in calls] == [700 * 1024**2] * 2


def test_the_mesh_input_sample_stays_within_the_cap():
    assert M.mesh_sample([10, 7], 100) == (1, 17)
    stride, total = M.mesh_sample([1000, 999, 5], 300)
    assert total <= 300 and total == sum(-(-c // stride) for c in (1000, 999, 5))
    assert M.meshlab_points(32 * 1024**2) == 100_000 and M.meshlab_points(4 * 10**9) == 10**7
```

In `test_texrecon_output_becomes_a_textured_glb` (lines 361-375), add at the start `monkeypatch.setenv("AIO_PHOTO_MEMORY_MB", "700")` and

```python
    calls: list = []
    real = T.run_tool
    monkeypatch.setattr(T, "run_tool", lambda *a, **k: calls.append(k) or real(*a, **k))
```

and at the end `assert calls[0]["memory_limit"] == 700 * 1024**2`.

`python/tests/test_photo_dense.py`: delete `test_the_cloud_is_written_as_las_tile_by_tile` (lines 281-299) and the now unused imports (`struct` if unused).

- [ ] **Step 2: Run them and see them fail**

Run: `uv run --frozen --directory python pytest tests/test_photo_surface.py tests/test_photo_mesh.py -k "windows or memory_budget or within_the_cap or texrecon_output" -q`
Expected: FAIL: `dtm_grid` takes `ground_tif` (the progress callable is taken for a path), `mesh_sample` missing, `memory_limit` absent.

Run: `uv run --frozen --directory python pytest tests/test_photo_products.py -k "cloud_alone or without_untwine or capped or products_report" -q`
Expected: FAIL: the plan still runs `cloud` before `dsm`, and `_cloud` still writes through PDAL's SMRF pipeline.

- [ ] **Step 3: Implement `surface.py`**

Docstring DTM bullet (lines 7-11): "- **DTM**: the ground under buildings, piles and vehicles, by a Simple Morphological Filter (Pingel, Clarke and McBride 2013) on the minimum-height grid: progressively larger openings mark cells that rise faster than the slope allows as objects; the ground left is interpolated under them (push-pull). The DTM is then the DSM wherever the DSM is ground. No whole-cloud filter runs (13 Oct 2026): the cloud's ground class comes from this DTM (`cloud_out.py`)."

`dtm_grid` (lines 351-400):

```python
def dtm_grid(
    dsm_path: Path,
    zmin_path: Path,
    spec: GridSpec,
    out: Path,
    epsg: int | None,
    budget: int,
    check: Callable[[], None],
    progress: Callable[[float, str | None], None] = lambda f, m=None: None,
) -> dict[str, Any]:
    """The DTM, found on a coarse grid (1 m cells or the DSM's, within the memory budget) by our
    filter on the minimum-height grid and written at the DSM's cell size window by window: cells
    within 0.5 m of the ground keep the DSM's height, the rest the ground interpolated beneath."""
    from rasterio.windows import Window
    from scipy import ndimage

    coarse = dtm_coarse(spec, budget)
    shape = (coarse.height, coarse.width)
    cell = coarse.res
    dsm_c = read_grid(dsm_path, shape)
    dtm_c = dtm_from(dsm_c, read_grid(zmin_path, shape), cell, check=check)
    ground_cells = int(np.sum(np.isfinite(dsm_c) & (np.abs(dsm_c - dtm_c) < 0.25)))
    wins = list(spec.windows())
    with write_tif(out, spec, epsg, 1, "float32", NODATA) as ds:
        for i, (c0, r0, ww, hh) in enumerate(wins):
            check()
            dsm = read_window(dsm_path, c0, r0, ww, hh)
            # the coarse DTM bilinearly at this window's cell centres
            ry = (np.arange(r0, r0 + hh) + 0.5) * spec.res / cell - 0.5
            rx = (np.arange(c0, c0 + ww) + 0.5) * spec.res / cell - 0.5
            gy, gx = np.meshgrid(ry, rx, indexing="ij")
            base = ndimage.map_coordinates(dtm_c, [gy, gx], order=1, mode="nearest")
            with np.errstate(invalid="ignore"):
                ground = np.isfinite(dsm) & (dsm - base < 0.5)
            dtm = np.where(ground, dsm, base)
            dtm[~np.isfinite(dsm)] = np.nan
            ds.write(
                np.where(np.isfinite(dtm), dtm, NODATA).astype(np.float32), 1, window=Window(c0, r0, ww, hh)
            )
            progress((i + 1) / len(wins), f"Terrain window {i + 1} of {len(wins)}")
    return {"engine": "smrf-grid", "cell": round(cell, 4), "groundCells": ground_cells}
```

`dtm_coarse`'s docstring: "The coarse grid the ground is found on." Delete `read_grid_on` and the whole `# PDAL ground` section with `pdal_dtm_pipeline`. Check nothing else uses them: `git grep -n "read_grid_on\|pdal_dtm_pipeline"` must print nothing.

- [ ] **Step 4: Implement `mesh.py` and `texture.py`**

`mesh.py`, after `MESHLAB_BYTES_PER_POINT` (line 428):

```python
def meshlab_points(memory_budget: int) -> int:
    """The points MeshLab's Poisson keeps within ``memory_budget``."""
    return max(100_000, memory_budget // MESHLAB_BYTES_PER_POINT)


def mesh_sample(counts: Sequence[int], cap: int) -> tuple[int, int]:
    """The stride to take every tile's points by, and the points that gives, so that at most
    ``cap`` points of tiles holding ``counts`` points go to the mesher."""
    n = sum(counts)
    stride = max(1, -(-n // max(1, cap)))
    while True:
        total = sum(-(-c // stride) for c in counts)
        if total <= cap or stride >= max(counts, default=1):
            return stride, total
        stride += 1
```

(add `from collections.abc import Sequence` to the imports). Line 587: `max_points = meshlab_points(memory_budget)`. In `poisson_tool` (lines 394-405) both `native.run_tool` calls gain `memory_limit=native.memory_budget()`:

```python
    native.run_tool(
        ctx, args, "Poisson meshing", work, expected_s=max(30.0, n / 2e5), progress=(0.0, 0.8),
        memory_limit=native.memory_budget(),
    )  # fmt: skip
    trimmer = native.find_tool("SurfaceTrimmer")
    if trimmer is not None:
        native.run_tool(
            ctx,
            [trimmer, "--in", str(raw), "--out", str(out), "--trim", "7"],
            "Trimming the mesh",
            work,
            20.0,
            (0.8, 0.95),
            memory_limit=native.memory_budget(),
        )
```

`texture.py` line 39: `from .native import find_tool, memory_budget, run_tool`; the `run_tool(...)` call at line 332 gains `memory_limit=memory_budget(),`.

- [ ] **Step 5: Implement `products.py`**

Docstring table rows (lines 14-16):

```
| dsm       | ``dsm.tif`` (COG), a shaded ``kit-pyramid`` layer and its ``aio.grid/1`` heights |
| dtm       | ``dtm.tif`` likewise (our SMRF on the grid); also for the cloud's ground class   |
| cloud     | ``clouds/<run>.copc.laz``: ground from the DTM, COPC by untwine (else PDAL)      |
```

(in that order, after `fuse`). Delete `PDAL_FOR_CLOUD` (lines 81-84; `git grep -n PDAL_FOR_CLOUD` must then print nothing). Line 76: `STAGES = ("dense", "fuse", "dsm", "dtm", "cloud", "ortho", "mesh", "texture", "commit", "tiles")`.

`plan` (lines 292-313):

```python
    def plan(self, params: dict[str, Any]) -> list[Step]:
        want = set(params["products"])
        need_mesh = bool(want & {"mesh", "tiles"})
        need_dtm = bool(want & {"dtm", "cloud"})  # the cloud's ground class comes from the DTM
        need_dsm = bool(want & {"dsm", "ortho"}) or need_dtm or need_mesh
        steps = [Step("prepare", "Check the run and plan the products", _timed(self._prepare), 0.5)]
        steps.append(Step("dense", "Dense matching (depth maps)", _timed(self._dense), 10))
        steps.append(Step("fuse", "Fuse the depth maps into a cloud", _timed(self._fuse), 3))
        if need_dsm:
            steps.append(Step("dsm", "Surface model (DSM)", _timed(self._dsm), 2))
        if need_dtm:
            steps.append(Step("dtm", "Terrain model (DTM)", _timed(self._dtm), 1))
        if "cloud" in want:
            steps.append(Step("cloud", "Point cloud to COPC", _timed(self._cloud), 2))
        if "ortho" in want:
            steps.append(Step("ortho", "Orthomosaic", _timed(self._ortho), 6))
        if need_mesh:
            steps.append(Step("mesh", "Mesh", _timed(self._mesh), 4))
            steps.append(Step("texture", "Texture the mesh", _timed(self._texture), 3))
        steps.append(Step("commit", "Add the products to the project", _timed(self._commit), 0.5))
        if "tiles" in want:
            steps.append(Step("tiles", "Mesh to 3D Tiles", _timed(self._tiles), 2))
        return steps
```

`_cloud` (lines 646-683):

```python
    def _cloud(self, ctx: StepContext) -> dict[str, Any]:
        from .cloud_out import write_copc, write_las

        self._settings(ctx)
        run = self._run(ctx)
        store = self._tiles_store(ctx)
        work = self._work(ctx)
        las, meta = work / "cloud.las", work / "cloud-las.json"
        if las.exists() and meta.exists():
            counts = json.loads(meta.read_text("utf-8"))
        else:
            counts = write_las(
                las, store, run.offset, work / "dtm-raw.tif", ctx.check,
                lambda f, m=None: ctx.progress(0.3 * f, m),
            )  # fmt: skip
            atomic_write_json(meta, counts)
        rel = f"clouds/{run.id}.copc.laz"
        staged = ctx.stage(rel)
        temp = ctx.staging / ".copc-tmp"
        writer = write_copc(ctx, las, staged, counts["points"], run.epsg, temp, native.memory_budget())
        shutil.rmtree(temp, ignore_errors=True)
        ctx.log(
            f"Point cloud: {counts['points']:,} points, {counts['ground']:,} of them ground; COPC by {writer}."
        )
        return {
            "points": int(counts["points"]),
            "ground": int(counts["ground"]),
            "writer": writer,
            "path": rel,
            "bytes": staged.stat().st_size,
        }
```

`_dtm` (lines 777-805):

```python
    def _dtm(self, ctx: StepContext) -> dict[str, Any]:
        from .surface import GridSpec, dtm_grid

        self._settings(ctx)
        run = self._run(ctx)
        spec = GridSpec(**ctx.outputs("dsm")["spec"])
        work = self._work(ctx)
        raw = work / "dtm-raw.tif"
        publish = "dtm" in ctx.params["products"]
        span = 0.4 if publish else 1.0  # _surface_layer reports from 0.4 on
        out: dict[str, Any] = {"engine": "smrf-grid"}
        if not raw.exists():
            tmp = raw.with_suffix(".tmp.tif")
            out.update(
                dtm_grid(
                    work / "dsm-raw.tif", work / "zmin-raw.tif", spec, tmp, run.epsg, native.memory_budget(),
                    ctx.check, lambda f, m=None: ctx.progress(span * f, m),
                )
            )  # fmt: skip
            replace_over(tmp, raw)
            ctx.log("DTM: ground found by smrf-grid.")
        if publish:
            out.update(self._surface_layer(ctx, raw, spec, "dtm"))
        return out
```

`_mesh`, the screened-Poisson branch (lines 860-890):

```python
        else:
            from . import mesh as mesh_mod

            store = self._tiles_store(ctx)
            count = int(store.info().get("points") or 0)
            shift = run.offset - origin
            # a sample of the cloud in memory (the FFT solver's grid holds no more detail anyway)
            stride = max(1, count // 5_000_000)
            parts = [
                (p["xyz"][::stride] + shift, p["normal"][::stride].astype(np.float64))
                for _, p in store.fused()
            ]
            pts = np.concatenate([a for a, _ in parts])
            nrm = np.concatenate([b for _, b in parts])
            del parts
            mesh = None
            if screened is not None:
                depth = 11 if s["preset"] == "standard" else 12
                src = work / "poisson" / "dense.ply"
                # at most the points MeshLab keeps, taken by stride from every tile
                step, total = mesh_mod.mesh_sample(store.counts(), mesh_mod.meshlab_points(native.memory_budget()))
                write_ply_chunks(
                    src,
                    ((p["xyz"][::step] + shift, p["normal"][::step], p["rgb"][::step]) for _, p in store.fused()),
                    total,
                )
                try:
                    mesh, engine = poisson_mesh(
                        ctx,
                        work / "poisson",
                        pts,
                        nrm,
                        depth,
                        src,
                        total,
                        native.memory_budget(),
                        ctx.outputs("fuse").get("voxel"),
                    )
```

(the `except JobError` and what follows are unchanged).

`_report`: the `cloud` entry (lines 1156-1160):

```python
        made = ctx.outputs("cloud")
        ...
            "cloud": {
                "points": int(fuse.get("points") or 0),
                "spacingM": round(float(fuse.get("voxel") or s["gsd"]), 4),
                "source": fuse.get("source"),
                "budget": int(s.get("budget") or 0),
                **(
                    {"groundPoints": int(made["ground"]), "writer": made["writer"]}
                    if made.get("writer")
                    else {}
                ),
            },
```

(`made = ctx.outputs("cloud")` goes next to `fuse = ctx.outputs("fuse")`).

`fuse.py`: delete `write_las_tiles` (lines 197-247); `git grep -n write_las_tiles` must print nothing.

- [ ] **Step 6: Run the tests and see them pass**

Run: `uv run --frozen --directory python pytest tests/test_photo_surface.py tests/test_photo_mesh.py tests/test_photo_dense.py -q`
Expected: PASS (the MeshLab cases SKIP without pymeshlab).

Run: `uv run --frozen --directory python pytest tests/test_photo_products.py -q`
Expected: PASS.

- [ ] **Step 7: Every photo test and ruff**

Run, one after the other (one heavy run at a time):

```
uv run --frozen --directory python pytest tests/test_photo_budget.py tests/test_photo_cloud_out.py tests/test_photo_merge.py tests/test_photo_pool.py tests/test_photo_card.py tests/test_photo_card_job.py tests/test_photo_runs.py -q
uv run --frozen --directory python pytest tests/test_photo_chain.py -q
uv run --frozen --directory python ruff check .
uv run --frozen --directory python ruff format --check .
```

Expected: PASS; ruff prints no findings (run `ruff format` on the changed files if the check lists them, then check again).

- [ ] **Step 8: Commit**

```bash
git add python/src/aio_pipelines/photo/products.py python/src/aio_pipelines/photo/surface.py python/src/aio_pipelines/photo/mesh.py python/src/aio_pipelines/photo/texture.py python/src/aio_pipelines/photo/fuse.py python/tests/test_photo_products.py python/tests/test_photo_surface.py python/tests/test_photo_mesh.py python/tests/test_photo_dense.py
git commit -F msg.txt
```

```
feat(photo): dtm before the cloud, ground from the dtm, capped mesh input

The DTM is always our SMRF on the grid and runs before the cloud, which classifies ground
by height above it and goes to COPC through untwine or PDAL. dense.ply holds what MeshLab
keeps, every tool runs under the memory budget, and the report gains budget, writer and
ground points.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

### Task 9: Docs, the stage order, the contract row and the e2e spec

**Files:**

- Modify: `docs/architecture/data-conventions.md:436`, after `:451` (new bullet), `:790` (pack layout), `:798` (the pack's tools)
- Modify: `docs/architecture/contract-changes.md` (a row at the end)
- Modify: `packages/schema/src/photogrammetry.ts:49-68`
- Modify: `apps/desktop/e2e/fixtures.ts:742-761`
- Modify: `apps/desktop/e2e/photo-change.spec.ts:1-14`, `:20-29`, after `:361`

**Interfaces:**

- Consumes: Task 1's `pdal.mjs --out` install (`AIO_PDAL`, `AIO_UNTWINE`); Task 8's report fields.
- Produces: `fixtures.ts` exports `UNTWINE: string`, `hasUntwine(): boolean`, and `PIPELINE_ENV.AIO_UNTWINE`.

- [ ] **Step 1: The e2e change (the test first)**

`apps/desktop/e2e/fixtures.ts`, after `PDAL` (line 756):

```ts
export const UNTWINE =
  process.env.AIO_UNTWINE ??
  (process.platform === 'win32' ? 'E:/Dev/tools/pdal/Library/bin/untwine.exe' : '/usr/bin/untwine');
export const hasPipelinePython = (): boolean => existsSync(VENV_PYTHON);
export const hasPdal = (): boolean => existsSync(PDAL);
export const hasUntwine = (): boolean => existsSync(UNTWINE);
export const PIPELINE_ENV: Record<string, string> = {
  QUADRION_PIPELINE_PYTHON: VENV_PYTHON,
  AIO_PDAL: PDAL,
  AIO_UNTWINE: UNTWINE,
};
```

and its comment (lines 742-746): "... and PDAL (AIO_PDAL, else the workstation's install) and untwine (AIO_UNTWINE; without it the cloud goes through PDAL). ...".

`apps/desktop/e2e/photo-change.spec.ts`: header (lines 7-13) gains: "The cloud runs the DSM and DTM steps first (no DTM layer, none is asked for), classifies ground from the DTM and goes to COPC through untwine when AIO_UNTWINE names it, else through PDAL." Import `hasUntwine` from `./fixtures` (lines 20-29). Add the type after `ProjectRaster`:

```ts
interface ProductsReport {
  engines: { ground?: string };
  cloud: { points: number; budget: number; writer?: string; groundPoints?: number };
}
```

After the loop of step 2 (line 361):

```ts
// 2b. the cloud's ground came from the DTM step, which published nothing, and the COPC went
// through untwine when this computer has it, else through PDAL
for (const capture of ['c1', 'c2'] as const) {
  const report = JSON.parse(
    await readFile(join(root, 'photogrammetry', runs[capture], 'report', 'products.json'), 'utf8'),
  ) as ProductsReport;
  expect(report.engines.ground, `ground engine ${capture}`).toBe('smrf-grid');
  expect(report.cloud.writer, `COPC writer ${capture}`).toBe(hasUntwine() ? 'untwine' : 'pdal');
  expect(report.cloud.groundPoints ?? 0, `ground points ${capture}`).toBeGreaterThan(0);
  expect(report.cloud.budget, `budget ${capture}`).toBe(150_000_000);
  expect(
    layers.some((l) => l.capture === capture && l.id.endsWith('-dtm')),
    `no DTM layer ${capture}`,
  ).toBe(false);
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Run the spec the way CI runs it, with untwine, then without**

First, from the worktree root: `pnpm demo:change --quick` (CLAUDE.md asks for it before any e2e run). Then from `apps/desktop`, PowerShell (one Playwright run at a time; the worktree's own `python/.venv` from "Before you start" is what `VENV_PYTHON` finds, so `QUADRION_E2E_PYTHON` is not set; never point it at the main checkout's venv, which runs main's pipelines):

```powershell
$env:QUADRION_WINDOW_SIZE = '1100x720'; $env:QUADRION_E2E_SCALE = '1'; $env:QUADRION_E2E_SWGL = 'warp'
$env:AIO_PDAL = 'C:\Users\D\AppData\Local\Temp\quadrion-pdal-0.6.1\Library\bin\pdal.exe'
$env:AIO_UNTWINE = 'C:\Users\D\AppData\Local\Temp\quadrion-pdal-0.6.1\Library\bin\untwine.exe'
npx playwright test e2e/photo-change.spec.ts --workers=1 --list
npx playwright test e2e/photo-change.spec.ts --workers=1
```

Expected: `--list` shows the one test of `photo-change.spec.ts` only; the run PASSES with the COPC writer `untwine`.

Then the fallback:

```powershell
$env:AIO_UNTWINE = 'C:\nowhere\untwine.exe'
npx playwright test e2e/photo-change.spec.ts --workers=1
```

Expected: PASS with the COPC writer `pdal`. (CI's e2e job installs no PDAL, so this spec skips there; these local runs are its evidence.)

- [ ] **Step 4: The stage order in `@aio/schema`**

`packages/schema/src/photogrammetry.ts`, lines 58-67: `'dense', 'fuse', 'dsm', 'dtm', 'cloud', 'ortho', 'mesh', 'texture', 'tiles', 'commit',` (the same values, `cloud` after `dtm`).

- [ ] **Step 5: Data conventions**

Line 436: `report/products.json   aio.photo-products/1: GSD, coverage, density, point budget, engines, timings, memory peak and budget, disk`.

After the **Workers** bullet (line 451), a new bullet:

"- **The dense cloud at scale** (13 Oct 2026): each preset has a point budget (Fast sparse, Standard 150 M, High 400 M). `prepare` takes the site's area from the sparse points (2 m cells with at least two points, dilated by two cells, clipped to the region) and the spacing `max(gsd / scale, sqrt(area / (0.9 x budget)))`. Fusion keeps a pixel when two neighbouring photos agree within `min(1 % of the depth, 3 x gsd / scale)`, in chunks of 18 bytes a point. The merge works per tile of `1024 x dsmRes` in worker processes: voxels seen once go, each column keeps one point per two voxels of height in each cluster, then a statistical outlier filter (16 neighbours, 2.5 standard deviations, over the tile and a one-voxel margin); a cloud above 1.2 x its budget is merged again wider. The chunks are deleted after the merge. Steps run prepare, dense, fuse, dsm, dtm, cloud, ortho, mesh, texture, commit, tiles; a cloud runs the dsm and dtm steps (the DTM layer only when `dtm` is asked for). The DTM is our SMRF on the minimum-height grid; the cloud's class is 2 from 0.5 m below to 0.2 m above it and 1 elsewhere or where it has no height. untwine (`AIO_UNTWINE`, else the pack's `tools/pdal`) writes the COPC out of core, its temporary files in the job's staging area; without it PDAL's `writers.copc` does, refused up front when the cloud would not fit the memory budget. The report's `cloud` has `points`, `spacingM`, `source`, `budget` and, with a cloud, `groundPoints` and `writer`; `engines.ground` is `smrf-grid`. Work folders: `work/products/<dkey>/depth/`, `<dkey>/c-<ckey>/chunks/` and `<dkey>/c-<ckey>/m-<mkey>/` (`fused/`, the raw rasters, `cloud.las`, `poisson/`, `mesh-full.npz`); `prepare` deletes what a version before 13 Oct 2026 left beside `depth/`, and a job started by such a version is refused when resumed."

Pack layout (line 790): `tools/pdal/   PDAL and untwine (conda-forge), conda-packages.json, licenses/`. The pack's tools (line 798): open with "(pack 0.6.1)" and add a sentence: "`tools/pdal/` holds conda-forge's `libpdal-core` 2.10.2 and `untwine` 1.5.1 (GPL-3.0-or-later, the out-of-core COPC builder of `photo.products`; `Library/bin/untwine.exe` on Windows, `bin/untwine` on macOS); the pack build fails when untwine cannot turn a three point LAS into a COPC."

- [ ] **Step 6: The contract row**

Append to `docs/architecture/contract-changes.md`:

```
| 2026-10-13 | Pipeline pack 0.6.1: `tools/pdal/` gains conda-forge's `untwine` 1.5.1 (GPL-3.0-or-later), found through `AIO_UNTWINE`, then the pack. `aio.photo-products/1` (additive): `cloud` gains `budget`, `groundPoints` and `writer`; `engines.ground` is always `smrf-grid` (no `pdal-smrf`). `photo.products` runs `dtm` before `cloud` and a cloud runs the dsm and dtm steps; `PhotoStageName` lists the stages in that order (same values). Work folders under `photogrammetry/<run>/work/products/` move to layout 2 (data-conventions section 21) | A 1,003 photo run never finished: a bounded cloud, ground from the DTM, an out-of-core COPC | pipelines (`photo`), pipeline pack tooling, `@aio/schema` (order only) | founder approved the design 13 Oct 2026 |
```

Run: `npx prettier --write docs/architecture/data-conventions.md docs/architecture/contract-changes.md` then `node tools/agent/check-public-text.mjs docs/architecture/data-conventions.md docs/architecture/contract-changes.md docs/plans/2026-10-13-photo-scale.md`
Expected: prettier rewrites the table widths; the public-text check prints no names.

- [ ] **Step 7: The whole check**

Run: `pnpm check`
Expected: PASS (lint, format, typecheck, unit tests).

- [ ] **Step 8: Commit**

```bash
git add docs/architecture/data-conventions.md docs/architecture/contract-changes.md packages/schema/src/photogrammetry.ts apps/desktop/e2e/fixtures.ts apps/desktop/e2e/photo-change.spec.ts
git commit -F msg.txt
```

```
docs(photo): photo scale in data conventions, contract row and e2e

The bounded cloud, the step order, the ground class, untwine and work layout 2 in the data
conventions and the contract changes; the photo change e2e checks the ground engine, the
COPC writer and that a cloud publishes no DTM.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

### Task 10: Real-data proof on the founder's project

Run only in a window the founder agrees to (hours of CPU and disk on the workstation; feedback "no heavy runs while the PC is in use"). Nothing is committed but the session note.

**Interfaces:**

- Consumes: the branch at Task 9; Task 1's install at `C:\Users\D\AppData\Local\Temp\quadrion-pdal-0.6.1`.

- [ ] **Step 1: Ask the founder for the window** and note when it starts. The founder's project is the 1,003 photo run (995 registered, Standard, GSD 2.0 cm) whose `photo.products` job failed in the cloud step.

- [ ] **Step 2: Start the app from the worktree with this branch's pipelines.** PowerShell, in the worktree root:

```powershell
$env:QUADRION_PIPELINE_PYTHON = "E:\Dev\AIO Software\.claude\worktrees\photo-scale\python\.venv\Scripts\python.exe"
$env:AIO_PDAL = 'C:\Users\D\AppData\Local\Temp\quadrion-pdal-0.6.1\Library\bin\pdal.exe'
$env:AIO_UNTWINE = 'C:\Users\D\AppData\Local\Temp\quadrion-pdal-0.6.1\Library\bin\untwine.exe'
pnpm dev
```

- [ ] **Step 3: Resume the failed job** (Jobs panel, the failed `photo.products` job, Resume).
      Expected: it stops at its first step after prepare with "This processing was started by an older version; start the processing again (the depth maps are kept)." Nothing is written.

- [ ] **Step 4: Start the processing again** with the same products and the Standard preset (Process photos, the run, Re-run products). Watch the Jobs panel and Task Manager.

Expected, from the spec and this plan:

1. `prepare` logs "Removed about 165 GB of intermediate files an older version left" (within a few GB), and "Point budget 150 M over ... ha: cloud spacing ... cm".
2. `dense`: every depth map resumed (995 or more); no matching.
3. `fuse`: "Fusing photo k of 1003", then "Merging N tiles, k at a time", "Merging tile i of N" and "Cleaning tile i of N" counting up; "Dense cloud: about 150,000,000 points" (between 120 M and 180 M; above 180 M a "merging again" line and a result at or under 180 M); "GB of fusion chunks removed".
4. `dsm`: "Surface window i of n"; `dtm`: "Terrain window i of n"; no PDAL in either.
5. `cloud`: "Writing the cloud: tile i of n" (0 to 30 %), then "Building the COPC (untwine)" moving with untwine's own percentages (30 to 95 %), never sitting still for more than a few minutes; "COPC by untwine".
6. Memory: the job's processes stay under the memory budget (`AIO_PHOTO_MEMORY_MB`, else 40 % of 64 GB, about 25.6 GB) in Task Manager the whole time; no "stopped: it needed more than" message; no swapping.
7. The report (`photogrammetry/<run>/report/products.json`): `cloud.points` about 150 M, `cloud.budget` 150000000, `cloud.writer` `untwine`, `cloud.groundPoints` above 0, `engines.ground` `smrf-grid`, `memoryPeakBytes` at most `memoryBudgetBytes`.
8. The COPC layer opens in the app and shows ground (class 2) and other points.

- [ ] **Step 5: Record the outcome** in the session note (`docs/sessions/`, written by `/wrapup`): each expected line above with the number seen, the stage times from `run.json` `stages`, the disk freed, and anything that did not match. No project, client or site names in the note.

- [ ] **Step 6: Pack archive budget** (only if the founder asks for an installer or pack build in this window): build the pack per section 4 of `apps/desktop/dist/HANDOVER-2026-10-12.md` and run `node tools/release/budgets.mjs --pack <folder> --archive <its .tar.gz>`; expected: within 1,300 MB unpacked and 500 MB as an archive.
