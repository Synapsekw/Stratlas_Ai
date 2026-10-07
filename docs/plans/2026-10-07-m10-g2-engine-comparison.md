# M10 G2: alignment engine comparison (COLMAP and OpenSfM)

> 7 Oct 2026, stream G2. The first-week spike of the M10 plan ("Photogrammetry: options and recommendation"): COLMAP against OpenSfM on synthetic photos and one founder flight. Recommendation at the end. No client data in this file: the founder flight is described by its shape only, never by place, coordinates or file names.

## What ran, on which engine

| Run                                         | Engine actually used                                                                                                                                                                                                        | Where                   |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| CI tests (`test_photo_*.py`, `test_gcp.py`) | None: an engine adapter over a known scene (`SyntheticEngine` in `python/tests/photo_g2_synth.py`); the rest of the pipeline is real                                                                                        | Every machine           |
| Rendered synthetic set                      | **COLMAP 4.2.1 from the PyPI pycolmap wheel**, in a throwaway virtual environment outside the repository, through the real `photo.align` and `photo.georef` pipelines (`AIO_COLMAP_PYTHON`, `AIO_DEV_ALLOW_GPL_PYCOLMAP=1`) | Development workstation |
| Founder flight                              | Same PyPI wheel, same throwaway environment, photos read in place (read only; the input fingerprint was checked before and after)                                                                                           | Development workstation |
| OpenSfM                                     | **Not run** (see "OpenSfM")                                                                                                                                                                                                 | none                    |

The PyPI wheel is a development stand-in only. Its Windows build ships `cholmod.dll` and `spqr.dll` (GPL-2.0+), plus `libcurl`, `libcrypto` (OpenSSL), `libgfortran`, `liblapack` and `openblas` in `pycolmap.libs/`, as the plan says. It was never added to `pyproject.toml` or `uv.lock`, and the pipeline refuses it unless the development switch is set (`colmap_io.licence_problem`). Stream G1's own build (no CHOLMOD, no SPQR, Eigen sparse solvers) replaces it; numbers from it will differ in speed, not in accuracy, and should be re-measured with G1's wheel.

Workstation: Intel Core i7-13700K (24 threads), 64 GB RAM, NVMe SSD, Windows 11. CPU only (`has_cuda` false; the GPU was not used). Other agents' test suites were running on the same machine during the runs, so wall times are upper bounds.

## Synthetic set (rendered)

35 photos, 5 x 7 nadir grid, 80 % forward and 70 % side overlap, 1600 x 1200 pixels, 60 m above a textured height field (slopes, a 6 m stockpile, a pit), OPENCV distortion, standard GNSS (2.5 m horizontal, 4 m vertical noise). 5 control points and 4 checkpoints, marks with 0.5 px noise. Preset `high` (full resolution), exhaustive matching (595 pairs).

|                                                      | COLMAP global mapper   | COLMAP incremental mapper |
| ---------------------------------------------------- | ---------------------- | ------------------------- |
| Registered                                           | 35 of 35               | 35 of 35                  |
| Mean reprojection error                              | 0.114 px               | 0.112 px                  |
| Sparse points                                        | 2,518                  | 2,541                     |
| Features / match / SfM / georeference (s)            | 11.0 / 5.2 / 6.5 / 4.4 | 11.2 / 4.4 / 5.7 / 3.5    |
| Whole `photo.align` (s)                              | 27.7                   | 25.2                      |
| Peak memory, feature worker (before the memory fix)  | 2.2 GB                 | 2.2 GB                    |
| Camera centres after a similarity to truth (RMSE)    | 0.109 m                | 0.111 m                   |
| Focal length after GNSS-only alignment               | +1.4 %                 | +1.3 %                    |
| `photo.georef` (s)                                   | 2.3                    | 2.5                       |
| Checkpoints, horizontal / vertical RMSE (GSD 4.0 cm) | **0.9 cm / 3.2 cm**    | 0.9 cm / 3.2 cm           |

Both meet the plan's synthetic targets: registered 100 % (target 98 %), reprojection under 1 px, checkpoints under 1.5 x GSD horizontally (6 cm) and 2.5 x GSD vertically (10 cm). At 35 photos the two mappers are the same; the global mapper's advantage is on large blocks (below).

What the synthetic set showed about the method rather than the engine:

- **A nadir block flown at one height cannot separate focal length from flying height.** Both mappers end 1.3 to 1.4 % long in focal length with GNSS alone; the ground is then about 1.4 % of the flying height off vertically (0.8 m at 60 m). Ground control fixes it (checkpoints above). `photo.align` warns about nadir-only blocks without control, and the founder's oblique flight is the better case.
- **Camera positions are looser than the ground.** Over flat ground a nadir camera can shift and tilt together with almost no change in its image, so cameras land within 2 to 3 GSD while checkpoints are within a fraction of a GSD. The plan's "camera positions under 2 x GSD, rotations under 0.1 degrees" target needs relief or oblique photos in G8's set.
- **A systematic GNSS height offset leaks into camera heights through the focal length.** `photo.georef` estimates the offset from the control points and takes it out before the adjustment, and reports it (`gnss-height`).

## Founder flight

One flight, 1,003 photos in two camera folders whose file names repeat (keyed by folder and name), DJI Mavic 2 Pro (Hasselblad L1D-20c, 5472 x 3648), about 74 m above the take-off point, gimbal pitch -65 degrees (oblique), photos about 15 m apart, block about 470 x 360 m. Standard GNSS only: no RTK and no ground control, so absolute accuracy can only be metre-level and is reported as such.

All runs through `photo.align` (preset `standard`: features at 2736 px, 8,192 SIFT features per photo, pairs from GPS footprints), CPU only. The input fingerprint of the photo folders was identical before and after every run.

**The 110-photo first camera folder (subset), global against incremental, before the fixes below:**

|                                                                | COLMAP global                     | COLMAP incremental        |
| -------------------------------------------------------------- | --------------------------------- | ------------------------- |
| Registered                                                     | 110 of 110                        | 110 of 110                |
| Mean reprojection error                                        | 0.87 px                           | 0.83 px                   |
| Sparse points                                                  | 107,700                           | 109,264                   |
| Features / match / SfM (s)                                     | 70 / 156 / 96                     | 79 / 162 / 183            |
| Peak memory: features / match / SfM                            | **33.7 GB** / 0.5 GB / 1.6 GB     | 33.7 GB / 0.5 GB / 0.6 GB |
| Camera centres against GPS (median; RMSE horizontal, vertical) | 1.52 m; 1.48 m, 1.07 m            | 1.52 m; 1.49 m, 1.04 m    |
| Models                                                         | 2 (46 photos joined by GNSS only) | 2 (same split)            |

Both mappers split the subset at the same place, so the cause was upstream: GPS pairing skipped neighbouring lines whose views face opposite ways, which is right for low oblique views and wrong for this -65 degree mapping flight. Pairing now skips facing pairs only below 50 degrees; the subset then aligns as one model (2,282 pairs, 110 of 110, 1.0 px).

**Memory.** The 33.7 GB feature peak came from SIFT's default first octave of -1, which doubles every image before extraction (about 1.4 GB per thread at 2736 px), times one thread per core. Measured on 16 photos of the flight:

| Threads, first octave, image size | Peak    | Time   |
| --------------------------------- | ------- | ------ |
| 4, -1, 2736 px                    | 5.8 GB  | 26.7 s |
| 4, 0, 2736 px                     | 1.7 GB  | 9.1 s  |
| 8, 0, 2736 px                     | 3.1 GB  | 12.0 s |
| 16, 0, 2736 px                    | 5.2 GB  | 13.9 s |
| 4, 0, 1368 px                     | 0.6 GB  | 9.1 s  |
| 8, 0, 5472 px                     | 11.7 GB | 30.2 s |

Same keypoint count with first octave 0 (the 8,192 cap is reached either way), three times faster, a quarter of the memory; more than 8 threads does not help. The pipeline now uses first octave 0 from 1600 px, at most 8 feature threads within a 4 GB budget, and a guard that stops any engine stage above min(75 % of RAM, 90 % of free RAM) with a plain message. The subset then peaks at **3.1 GB** (features 27 s, match 333 s, SfM 86 s, 476 s in all; the pipeline process itself 1.5 GB).

**The whole flight (1,003 photos), global mapper, after the fixes:**

|                                                                | COLMAP global                                                            |
| -------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Registered                                                     | **995 of 1,003** (99.2 %); 8 left out with a reason in the report        |
| Mean reprojection error                                        | 1.19 px (median 0.88 px)                                                 |
| Sparse points                                                  | 750,621 (mean track 6.6 photos)                                          |
| Pairs matched                                                  | 22,648                                                                   |
| Time: inspect / features / match / SfM / georeference / report | 67 s / 4.2 min / 54 min / 43 min / 1 s / 30 s (**1 h 43 min**)           |
| Peak memory: features / match / SfM / pipeline                 | 3.2 GB / 0.9 GB / **13.2 GB** / 1.5 GB                                   |
| GSD                                                            | 2.0 cm                                                                   |
| Camera centres against GPS: median; RMSE horizontal, vertical  | 2.78 m; 2.11 m, 2.51 m (one photo's GPS 17.7 m off, named in the report) |

The fit to GPS is what standard GNSS allows (the report says so: absolute accuracy about the GNSS accuracy, heights in the drone's altitude datum, "often tens of metres off"). With metre-level GNSS the pipeline only places the engine's model (similarity) instead of re-adjusting it: an adjustment against 2.5 m priors on a 400,000-observation subset moved the median reprojection error from 0.88 px to 1.07 px on this flight and cannot improve the absolute fit. RTK or PPK priors (0.5 m or better) still go into the bundle adjustment. Two further large-flight faults were found and fixed on this run (the pipeline process ran out of memory refining 10 million observations at once, and reading a model file kept one copy of all observations per photo); `photo.georef` and the report now stay at 1.5 GB.

Where the time and memory go on a large flight: matching (54 min for 22,648 pairs on 24 threads) and the global mapper (43 min, 13.2 GB). 13.2 GB is inside the plan's budget for 1,000 photos on a 32 GB workstation (the guard allows 24 GB there) and outside a 16 GB laptop's (12 GB), whose plan budget is 300 photos. Fewer features per photo or fewer neighbours per photo for large flights, and G1's build, are the levers; both need measuring before the presets change.

## OpenSfM

OpenSfM was **not run**, for reasons that are themselves part of the comparison:

- It is not on PyPI (`uv pip install opensfm` finds no distribution) and has no release since 2020; there is no upstream Windows build or wheel.
- A Windows build needs a C++ toolchain with Ceres, OpenCV, gflags, glog, Eigen and SuiteSparse (the last must be left out for licence reasons, as for COLMAP). That build belongs to stream G1 ("an OpenSfM build for G2's spike only"); it was not available during this spike, and this workstation has no Docker or Linux environment set up for it.
- Its Python dependencies would need three removals before it could ship: fpdf2 (LGPL-3.0), the full `opencv-python` wheel (bundled FFmpeg), and the unlicensed OpenMVS interface header.

Desk comparison against what COLMAP did here:

|                                       | COLMAP 4.2 (measured)                                                             | OpenSfM (desk)                                                |
| ------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Licence                               | BSD-3; our build drops CHOLMOD/SPQR                                               | BSD-2; fpdf2 (LGPL-3.0) and opencv-python to remove           |
| Windows and macOS arm64               | vcpkg manifest and official wheel scripts for both                                | No upstream Windows CI; ODM's fork builds through conda-forge |
| Release cadence                       | 4.0 to 4.2.1 in 2026                                                              | No tagged release since 2020                                  |
| Large blocks                          | Global mapper (GLOMAP) in the box                                                 | Incremental only (with submodels)                             |
| GNSS and GCP handling                 | Ours (`photo.georef`, `bundle.py`): weighted priors, outliers, honest checkpoints | Built in                                                      |
| Python API for jobs, progress, cancel | Yes (pycolmap), run in a killable worker                                          | Yes (CLI and Python)                                          |
| CPU dense                             | Not in COLMAP without CUDA (G3 chooses)                                           | Coarse built-in depth maps                                    |

The one thing OpenSfM would have brought, drone-aware GNSS and GCP handling, is now in our own code and tested; the engine adapter (`colmap_io.SfmEngine`) would take an OpenSfM engine without changing the stages if a later flight showed a clear gap.

## Recommendation

**COLMAP, global mapper by default, incremental as the fallback, through the engine adapter; drop OpenSfM from M10.** Reasons:

1. It works end to end today through our pipeline on CPU, on rendered photos and on a real 1,003-photo oblique flight (99.2 % registered, median reprojection 0.88 px, 1 h 43 min, 13.2 GB at most), with synthetic checkpoints well inside the plan's targets.
2. Licence work is bounded and owned by G1 (one patch, one overlay), while OpenSfM needs a source build no one ships plus three dependency removals.
3. The parts where OpenSfM was stronger (GNSS weighting, control points, outliers, honest accuracy) are ours now and independent of the engine.

Follow-ups: re-measure speed with G1's CHOLMOD-free wheel (Eigen's sparse Cholesky is slower on large bundle adjustments; the plan's 1,000-image measurement); repeat the founder-flight run with ground control when a flight with control is supplied; if G1 ever builds OpenSfM, run `tests/test_photo_engine.py` against an `OpenSfmEngine` adapter on the same sets.
