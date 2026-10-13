# Photo processing at scale: a bounded dense cloud — design

Date: 13 Oct 2026. Branch `fix/photo-scale`. Status: design approved in chat by the founder, written spec awaiting review.

## Why

A real run of 1,003 drone photos (995 registered, Standard preset, GSD 2.0 cm) on a 64 GB, 24-thread workstation with an RTX 5070 Ti never finished `photo.products`:

- Fusion wrote 913 M points (`cloud.las`, 32.9 GB) at a 4 cm voxel. The fusion check lets almost everything through: one agreeing neighbour within 1 % of depth, about ±0.8 m at flying height (`photo/fuse.py:30-32`, `:76`). The merge is a 3D voxel mean that leaves several noise layers per ground cell (`fuse.py:250-275`), and nothing caps the point count.
- The cloud step loads the whole cloud into PDAL (`readers.las → filters.smrf → writers.copc`; `filters.smrf` and `writers.copc` are not streamable in PDAL 2.10.2). It reached 123 GB of private memory, swapped and failed with `bad allocation`. The DTM step runs a second whole-cloud SMRF (`photo/surface.py:440-466`).
- PDAL runs without a memory limit and with a 60 s time ramp for progress (`photo/pointcloud.py:64-93`), so the bar sat at 40 % for hours.
- The merge runs in one process on one core and re-reads 130 GB of float64 chunks (`fuse.py:94-152`).
- No GPU was used, because the add-on was not installed. That is fixed outside this branch: add-on 0.1.0 was hand-installed into `runtime/` and its self-test answers `ready`.

## Founder decisions (13 Oct 2026)

1. **Point budget per quality preset.** Fast stays sparse, Standard about 150 M points, High about 400 M. The spacing starts at `gsd/scale` and widens only when the site would exceed the budget.
2. **Ground class from height above the DTM.** Build the DTM first from the gridded surface, then classify points while writing the cloud, tile by tile. No whole-cloud SMRF anywhere in `photo.products`.
3. **Add untwine to the pipeline pack** as the out-of-core COPC builder. This means a new pack, 0.6.1, so GPU add-on 0.1.0 (packRange `>=0.5.0 <0.7.0`) still fits, plus a licence notice.
4. **Delete the fusion chunks** after a complete merge.
5. **The founder's project re-fuses** with the stricter rules. Alignment and depth maps are kept.

## Design

### 1. Cleaner fusion (per photo)

- FuseSettings v2: `min_agree = 2`, and agreement means `|dz| ≤ min(0.01·z, 3·gsd/scale)` (12 cm on the founder's run).
- The CPU path (`fuse.py`, `pool.py` `fuse_photo`) and the card path (`card.py` `fuse_arrays`) apply the same rule. A parity test covers it, skipped without the add-on.
- Chunks become format 2:
  - x and y as float32 offsets from the tile corner, z as float32;
  - normals as int8 ×127, colour as uint8;
  - about 18 B per point instead of 39, with a round-trip error under 0.1 mm.

### 2. Budgeted merge

- **Spacing up front.** In `prepare`, take the site area from the sparse points: a 2 m occupancy grid (cells with at least 2 points, dilated by 2 cells, clipped to the region). Then `voxel = max(gsd/scale, sqrt(area / (0.9 · budget)))`.
- **Merge rule, per tile:**
  1. Bin the points into voxels and drop voxels seen fewer than 2 times.
  2. Collapse each xy column: sort by z, split clusters where the gap exceeds `2·voxel`, then keep one mean point per `2·voxel` sub-bin of each cluster.
  3. Roofs over ground and walls survive. Stacked noise layers merge.
- **Safety net.** If the total exceeds `1.2 × budget`, re-merge at `voxel · sqrt(points / budget)` from the chunks before they are deleted.
- **Parallel.** Tiles merge in `photo/pool.py` worker processes, the count sized by the largest tile's chunk bytes against the memory budget. If the pool breaks, the merge falls back to in-process. Tile size halves to `1024 · dsmRes`.
- **Clean up.** After a complete merge, the chunks are deleted (decision 4).

### 3. Step order and the cloud step

- **New order:** prepare, dense, fuse, **dsm, dtm, cloud**, ortho, mesh, texture, commit, tiles.
  - Asking for `cloud` implies the dsm and dtm steps.
  - The DTM layer is published only when `dtm` was asked for, the way `_dsm` already behaves.
- **DTM.** Always smrf-grid on the zmin raster (`surface.py:351-400`). The PDAL DTM branch and `pdal_dtm_pipeline` are removed.
- **Cloud** (a new `photo/cloud_out.py`):
  - For each fused tile, sample `dtm-raw.tif` bilinearly over the tile box.
  - Set class 2 where `-0.5 m ≤ z − dtm ≤ 0.2 m`, and class 1 elsewhere or where the DTM has no data.
  - Append the tile to the LAS output.
  - Build the COPC with **untwine**, out of core, keeping the classification.
- **Fallback.** If untwine is missing (development and e2e PDAL), PDAL `writers.copc` runs under `native.run_tool`'s memory limit. It refuses up front, with a message naming untwine, when `points × bytes-per-point` exceeds the budget.
- **Memory guard.** Every external tool in `photo.products` runs through `native.run_tool` with a memory limit.

### 4. Progress

- The merge reports tiles done out of the total.
- `dtm_grid` reports windows done.
- The cloud step reports 0–0.3 for writing LAS (per tile, exact) and 0.3–0.95 for untwine (parsed from its progress output, `run_tool` progress hook). The PDAL fallback uses an expected-time ramp from a measured rate.

### 5. Work folders, versioning, resume

- `dkey` (the depth key) stays byte for byte, so existing `depth/` folders are found. A test pins its value.
- `ckey = hash(dkey, FuseSettings v2, chunk format 2, tile size)` → `<dkey>/c-<ckey>/chunks`.
- `mkey = hash(ckey, voxel, budget, merge v2)` → `<dkey>/c-<ckey>/m-<mkey>/`. This holds `fused/`, the raw rasters, `cloud.las`, `poisson/` and `mesh-full.npz`.
- `prepare` returns `layout: 2`, plus `depthWork`, `chunks`, `work`, `voxel`, `budget` and `areaM2`.
- **Legacy cleanup.** `prepare` deletes the old-layout `<dkey>/cloud/`, `cloud.las`, `copc-pipeline.json` and `*-raw.tif` before the disk check, and logs the bytes freed (about 165 GB on the founder's run).
- **Old jobs.** The dsm, dtm and cloud steps refuse to run on prepare outputs without `layout: 2`. The message reads: "started by an older version; start the processing again — the depth maps are kept". This stops a resumed old job from reusing the 913 M point fused tiles.

### 6. Consumers

- **Mesh.** `dense.ply` gets at most the count MeshLab keeps (`memory_budget // 400`), taken by stride, instead of every point.
- **Report.**
  - It keeps `cloud.points` and `spacingM`, and adds `budget`, `groundPoints` and `writer`.
  - `engines.ground` is always `smrf-grid`.
  - The schema stays `aio.photo-products/1` (additive). The text in `data-conventions.md` is updated.
- **Manifest layer.** The shape is unchanged. `pointCount` is the written count. Classes are still 1 and 2.
- **Unaffected.** change, volumetric, survey/prepare and modelfit read the COPC by path or bounds.
- **Known risks outside this branch** (left as follow-ups):
  - `survey/cleanup.py:224-231` runs a whole-cloud SMRF.
  - `tiles/cloud.py:86-107` reads the whole COPC, about 25 GB at 400 M points.

### 7. Pipeline pack 0.6.1

- `tools/pipeline-pack/pdal.mjs` and `pdal-lock.json` add conda-forge `untwine` next to `libpdal-core 2.10.2`.
- `keepWindows` keeps `untwine.exe`, and the pack check runs it.
- `native.TOOLS` gains `untwine` (`AIO_UNTWINE`, then the pack).
- The third-party notices get untwine's licence.
- The pack version becomes 0.6.1, with an archive budget check.

## Testing

- **Unit tests (pytest):**
  - fuse v2 agreement;
  - column collapse: a roof over ground gives 2 points, a noisy flat surface gives 1, a wall keeps its sub-bins;
  - the count filter;
  - the chunk round trip;
  - budget spacing from the occupancy grid;
  - the re-merge safety net;
  - parallel merge equals serial;
  - classification by height above the DTM;
  - untwine and PDAL fallback command lines and the memory refusal;
  - progress parsing;
  - work keys (`dkey` pinned; only the fuse key changes → depth maps reused);
  - legacy cleanup;
  - refusal of an old-layout resume;
  - `["cloud"]` runs dsm and dtm without publishing a DTM layer;
  - mesh input cap.
- **Pack (node test):** untwine in the lock, the kept files and the check.
- **e2e:** update `photo-change.spec.ts` (cloud, dsm and ortho with PDAL; the dtm step now runs; the COPC goes through untwine when it is available, else the fallback) and the fixtures. Run these the way CI runs them.
- **Real-data proof** (in a window the founder agrees to): rerun the founder's project. Expect about 150 M points, the COPC written, peak memory inside the budget and real progress throughout.

## Out of scope

The GPU add-on Settings card, raising the CPU worker caps, OpenCV rectification in depth maps, a parallel orthomosaic, and the whole-cloud SMRF in survey cleanup. These are follow-ups.
