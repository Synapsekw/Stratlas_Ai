# ODM as the Photogrammetry Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace our own photogrammetry engine (COLMAP alignment, our dense matching, fusion, DSM, DTM, orthomosaic, mesh and texture) with ODM 3.6.2 run as a separate program, installed in one click from a Settings card, while the jobs, the wizard, the run panel and the project files keep their shape.

**Architecture:** The pipelines (`photo.align`, `photo.georef`, `photo.products`) lay out one ODM project per run (`photogrammetry/<run>/odm/`), start ODM's `run.bat` through the existing cancellable tool runner, read ODM's progress (stdout stage lines refined by its UDP datagrams), and convert what ODM writes back into the files the app already reads: OpenSfM's reconstruction into our `SparseModel` (so `sparse/`, `cameras-sfm.json`, mark prediction and the accuracy report are unchanged), and ODM's GeoTIFFs, point cloud and textured OBJ into the existing `raster` `kit-pyramid`, `pointcloud` `copc` and `mesh` layers. The desktop main process owns the pinned ODM download (`downloadVerified`), the silent Inno Setup install, `odm.json`, and hands the folder and the GPU setting to the jobs through `jobEnv`.

**Tech Stack:** Python 3.13 (numpy, rasterio, pyproj, PDAL and untwine binaries, PIL), pytest; TypeScript strict, zod 4 (`@aio/schema`), Electron main, React 19 + zustand (renderer), Vitest, Playwright + Electron.

**Spec:** `docs/plans/2026-10-14-odm-engine-design.md` (approved by the founder, 14 Oct 2026). Executors read both.

## Global Constraints

- ODM release **3.6.2**: `https://github.com/OpenDroneMap/ODM/releases/download/v3.6.2/ODM_Setup_3.6.2.exe`, **244,864,104** bytes, SHA-256 **`c9dbfabf0d066529a7b6c753fd45bf3366a0314266160cd677373bab4caff294`**. The pin lives in one file, `apps/desktop/src/main/odm/pin.ts`. Never a floating "latest".
- ODM is never linked, and its program code is never modified: it is started as `run.bat` with `ODM_NONINTERACTIVE=1`, by the pipelines only. The app and the Team Server never import it. One exception, founder 14 Oct: in the ODM folder the app installed itself (`odm.json`'s `dir`), the placeholder `SuperBuild\install\bin\nvcuda.dll` (a 19 KB stub) is renamed to `nvcuda.dll.odm-stub` when `%SYSTEMROOT%\System32\nvcuda.dll` exists and the GPU setting is `auto`, and renamed back when the setting is `off` or before the uninstaller runs; never deleted (deviation 17).
- Source photos are never written: `odm/images/` holds hard links (copies when a hard link fails).
- Presets: Fast `--fast-orthophoto --skip-3dmodel --pc-quality low --feature-quality medium`; Standard `--pc-quality medium --feature-quality high`; High `--pc-quality high --feature-quality ultra`. Products runs always add `--dsm --dtm --cog --pc-copc --build-overviews --orthophoto-resolution <cm> --dem-resolution <cm> --max-concurrency <n>` (not `--optimize-disk-space`: it deletes OpenSfM's features, matches and tracks, which a later georeference reuses; our own cleanup after commit removes the heavy folders instead), and `--skip-3dmodel` when no mesh was asked for. Matcher and SfM stay ODM's defaults.
- GPU: setting `processing.odm.gpu` = `auto` (default) or `off`. `auto` and `%SYSTEMROOT%\System32\nvcuda.dll` present: `--feature-type sift`; otherwise `--no-gpu`. A GPU fallback is a warning, never a failure.
- Threads: `max-concurrency = clamp(min(logical CPUs - 2, floor(RAM GB / 3)), 2, 32)` (21 on a 24-thread, 64 GB machine; every ODM call passes this computed `--max-concurrency`, never ODM's own default), lowered further only by a memory limit set by hand: the app passes `AIO_ODM_MEMORY_CAP_MB` only when the existing hand-set override `QUADRION_PHOTO_MEMORY_MB` is set (`floor(cap GB / 3)`, same clamp; the same value is ODM's memory kill limit, none otherwise). There is no memory field in Settings today, and this plan adds none. The automatic 75 % `AIO_PHOTO_MEMORY_MB` does not lower ODM's threads (founder, 14 Oct). Task 4's `odm_memory_cap()` reads `AIO_ODM_MEMORY_CAP_MB` (Task 2's `odm_threads` only takes the number); Task 14 sets it in `jobEnv`.
- Paths ODM sees are ASCII, without spaces and without `cmd.exe` metacharacters (C5 `false`): a space breaks ODM's unquoted SMRF ground command (zero ground points, then the DTM loops forever) and a non-ASCII letter breaks OpenSfM. Other paths are reached through a junction (project folders) or avoided (the install folder).
- A DTM is never added by `--rerun-from odm_dem` or later on a point cloud that was not made with `--dtm`; the runner starts from `odm_georeferencing` instead (Task 4).
- One photo processing job at a time on the computer (a new gate in `jobs:start`; there is no existing heavy-job gate, see "Spec deviations").
- Exit codes: 137 and 3221226505 "ODM ran out of memory; try the Fast preset or close other programs."; 132 "This computer's processor is not supported by ODM."; 3 "ODM is missing a program; reinstall the processing engine in Settings, Processing tools."; 1, 134, 139, 3221225477 "ODM could not process these photos: <last ODM line>"; the last 20 ODM lines always go to the job log.
- Our own engine is deleted in this branch (no fallback). Old runs keep their committed layers; products on a run without an ODM project are refused with a plain message.
- Photogrammetry runs on Windows x64 only from this branch (ODM ships a Windows installer; macOS is parked, founder 10 Oct).
- No em or en dashes in user-facing text. No client, site, tester or person names in anything committed. Strings in `packages/ui/src/i18n/en.ts` for the new card.
- Pipeline pack version becomes **0.8.0** (`python/pyproject.toml`); the app's `PHOTO_PACK` becomes `'0.8.0'`.

**Rules for every task (repeated in each task):** work only in `E:\Dev\AIO Software\.claude\worktrees\odm-engine` (branch `feat/odm-engine`); stage by path (never `git add -A`, never `git stash`); Python tests from `python/` with `uv run --frozen pytest <file> -q` (the worktree has no `.venv` of its own: if `uv run` cannot find one, use `"E:\Dev\AIO Software\python\.venv\Scripts\python.exe" -m pytest`, and check `python -c "import aio_pipelines; print(aio_pipelines.__file__)"` still names the main checkout afterwards, per the memory note on the shared editable install); TypeScript tests with `pnpm --filter <package> exec vitest run <file>`; Electron windows stay off-screen (the e2e fixtures' isolated `QUADRION_USER_DATA` profile); e2e from `apps/desktop` the way CI runs it: `QUADRION_WINDOW_SIZE=1100x720 QUADRION_E2E_SCALE=1 QUADRION_E2E_SWGL=warp QUADRION_E2E_PYTHON="E:\Dev\AIO Software\python\.venv\Scripts\python.exe" npx playwright test e2e/<spec>.spec.ts --workers=1`; one heavy run (pytest suite, e2e) at a time on the workstation; commit messages are conventional, lowercase subject, ending with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A data folder or project path with a space or a non-ASCII letter** (the founder's data root is `E:\Stratlas Data`; new installs default to `Documents\Quadrion AI Data`). ODM must still install and run, and the DTM must finish: a space breaks ODM's SMRF ground step and a non-ASCII letter breaks OpenSfM, so the install folder is chosen safe and ODM's project folder is reached through a junction whenever the path has either. Pinned in Task 5 (`odm_path reaches an unsafe folder through a junction`) and Task 12 (`install folder avoids spaces and non-ASCII letters in the data root`).
2. **Another ODM already installed** (an Inno uninstall entry or `C:\ODM\run.bat`). ODM's setup silently removes it, so the install refuses until the person confirms. Pinned in Task 12 (`refuses while another ODM is installed until replaceOther`) and Task 18 (`another ODM asks before installing`).
3. **Cancel in the middle of an ODM stage, then Resume.** No ODM process may survive the cancel, and the resumed products step must restart from the stage after the last finished one, not from the beginning. Pinned in Task 4 (`cancel kills the whole ODM tree` and `products resume starts after the last finished stage`).
4. **Two photos with the same file name in different folders** (DJI `100MEDIA` and `101MEDIA` both hold `IMG_0001.JPG`). Each must get its own link name in `odm/images/` and map back to its own photo key. Pinned in Task 5 (`same file names in two folders get distinct links`).
5. **Create maps on an old run** (aligned by COLMAP before this branch, or imported through OPF), which has no ODM project. The products job must refuse with a plain way forward, not a stack trace. Pinned in Task 10 (`a run without an ODM project is refused plainly`).

## Spec deviations and corrections (decided while planning; flag to the founder at plan review)

1. **New ADR number is 0012**, not 0009: `docs/architecture/adr/0009-survey-engine.md` exists (0010 and 0011 too).
2. **`pycolmap` stays in the pack.** Walks (`walk/sfm.py`) run their own COLMAP structure from motion through `photo/colmap_io.py`. This plan moves what walks need into `walk/colmap_child.py` and the process-tree code into `photo/proctree.py`, then deletes `colmap_io.py`. `pymeshlab` is dropped; `opencv-python-headless` stays (walks and panoramas import `cv2`).
3. **No heavy-job gate exists today** (the spec says one covers photo jobs). Only drone panorama stitches have a lane. This plan adds a refusal in `jobs:start`: a photo job does not start while another photo job runs (Task 14).
4. **Thread example.** The spec's "20 on a 24-thread, 64 GB machine" does not follow from its formula: `min(24 - 2, floor(64 / 3)) = 21`. And the app always sets `AIO_PHOTO_MEMORY_MB` to 75 % of RAM (48 GB there), which lowers it to `floor(48 / 3) = 16`. **Founder, 14 Oct: 21; the cap counts only when set by hand** (see Global Constraints, `AIO_ODM_MEMORY_CAP_MB`). This overrides any `AIO_PHOTO_MEMORY_MB` use for threads in Tasks 2 and 14 below.
5. **Products run ODM in several calls, one per job step** (`dense`, `mesh`, `texture`, `cloud`, `dsm`, `ortho`), each `--rerun-from <its first stage> --end-with <its last stage>`. This keeps the run panel's phases, gives a resume point per step, and imports each output right after ODM makes it. The extra ODM start-ups cost seconds on runs of hours.
6. **Align keeps our photo reading and writes `geo.txt`** when it changes what ODM would read from EXIF (PPK positions, RTK ellipsoidal heights converted to EGM2008, the project's vertical datum, `gnss` other than `auto`), so these settings keep working.
7. **ODM's own GCP errors** are written to the job log and kept as `report/odm-stats.json`; `report/accuracy.json` keeps its schema (our check-point measurement).
8. **Products on a run with no ODM project** (aligned before this branch, or imported by `opf.import`) are refused: "This run was aligned by an earlier version or imported; use Create maps again to process the photos with ODM." `opf.export` and `opf.import` stay unchanged: they read and write `sparse/` through their own `opf/colmap.py`, which the new align still writes.
9. **`odm:setGpu`** writes `settings.processing.odm.gpu` (spec's channel kept).
10. **`HardwareProbe.cuda`** now means "NVIDIA's CUDA driver (`nvcuda.dll`) is on this computer"; `HardwareProbe.accelerator` stays optional in the schema (old `run.json` files carry it) but nothing writes it. `PipelineAddonManifest` (`aio.pipeline-addon/1`) stays in the schema for the frozen compat corpus; nothing reads or writes it.
11. **Test-only overrides in main**, all gated to `QUADRION_E2E=1`: `QUADRION_ODM_PIN_FILE` (a JSON pin for a local fake setup), running a setup file ending in `.mjs` with Electron as Node, and `QUADRION_ODM_OTHER` (a folder that stands for another ODM install). `QUADRION_ODM_DIR` (and `QUADRION_ODM_VERSION`) names an ODM folder without installing, like `QUADRION_PIPELINE_PACK` for the pack.
12. **The mesh layer always comes from ODM's textured OBJ** (`odm_texturing/odm_textured_model_geo.obj`, else the 2.5D one), converted to GLB by us (C8 has no GLB path); the spec allowed ODM's own GLB first. One converter, one frame rule (C9).
13. **The fake ODM writes LAS and OBJ**, not COPC and GLB: our import's fallbacks (LAS to COPC through PDAL and untwine, OBJ to GLB) are what it exercises.
14. **Safe paths for ODM** are ASCII without spaces (C5 is back to `false`: a space in the project path gives ODM's SMRF command a truncated path, zero ground points and a DTM that never finishes; root-caused 14 Oct) and without the characters `cmd.exe` treats specially (`& ^ % ! ( ) < > | "`), because ODM's command line passes through `cmd.exe`. 8.3 short names such as `C:\Users\RUNNER~1` are safe.
15. **No `--optimize-disk-space`** (the spec asked for it during the run): it deletes `opensfm/features`, `matches` and `tracks.csv` in every products call, so a georeference after products would extract and match again. `clean_intermediates` after commit removes the heavy folders and keeps those.
16. **No observations are imported** from ODM: its `tracks.csv` is binary (C10). Reprojection error, track length and GSD come from ODM's `opensfm/stats/stats.json` and from the points each camera sees; `sparse/` keeps cameras and points without tracks.
17. **Dense matching on the GPU needs one file renamed in ODM's folder** (founder, 14 Oct). ODM 3.6.2 for Windows ships a placeholder `SuperBuild\install\bin\nvcuda.dll` (19 KB, every export a bare `ret`) beside `DensifyPointCloud.exe`; Windows loads it before the real driver, so OpenMVS silently densifies on the CPU. With it renamed to `nvcuda.dll.odm-stub`, OpenMVS loads the real driver: dense matching ran about 6x faster (204.8 s to 32.7 s at medium quality on 24 photos). ODM's program code is untouched; only that placeholder is renamed, only in our own install, only when the real driver exists and the GPU setting is `auto`; it is put back for `off` and before uninstalling; the Python runner checks before every ODM run (a repair or reinstall brings it back) and the installer once after install. ODM's log never shows OpenMVS's CUDA line (it runs it at `-v 0`), so "dense on the GPU" is reported when the stub is parked, the driver exists, the openmvs stage ran and no `OpenMVS failed with GPU` line appeared (a `CUDA device N initialized` line, if one ever shows, also counts).

## Probe-fed constants (measured by Task 0; amended 14 Oct 2026)

The values below are the plan's defaults from desk research. Task 0 measures each on this machine with the real 3.6.2 install. **Before dispatching Batch 2 the controller compares Task 0's findings with this table, edits any value that differs here and in the owning task's code block (a C6 change also goes into the copy in `python/tests/fake_odm/fake_odm.py`, Task 3), and commits the plan amendment** (`docs(plans): odm probe findings`). Implementers use the table as amended.

| #   | Constant                         | Value (measured by Task 0 on ODM 3.6.2, 14 Oct 2026)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Lives in (task)                                                    |
| --- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| C1  | `SETUP_ARGS`                     | `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CURRENTUSER` plus `/DIR=<dir>` (confirmed: per user, exit 0 in 70 s; `/LOG=<file>` also accepted)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `main/odm/pin.ts` (12)                                             |
| C2  | `SETUP_MAY_ASK_ADMIN`            | `false` (no vc_redist step in 3.6.2; non-admin, unattended install finished)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `main/odm/pin.ts` (12)                                             |
| C3  | `ODM_PIN.installedBytes`         | `1_100_000_000` (measured 1,006,316,511 bytes, 11,935 files)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `main/odm/pin.ts` (12)                                             |
| C4  | `REQUIRED_FILES`                 | `['run.bat', 'winrun.bat', 'win32env.bat', 'VERSION', 'venv\\Scripts\\python.exe']`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `main/odm/pin.ts` (12)                                             |
| C5  | `SPACES_OK` (desktop and Python) | `false` (amended 14 Oct after a root-cause run): spaces pass OpenSfM, ortho and DSM, but ODM's SMRF ground command is unquoted, so a space gives zero ground points and a DTM that never finishes. Non-ASCII letters fail in OpenSfM ("Can't write tracks manager file"). Such paths go through the junction rule; the install folder must be safe too                                                                                                                                                                                                                                                                                | `main/odm/paths.ts` (12), `photo/odm/project.py` (5)               |
| C6  | `STAGE_END`                      | dataset 5, opensfm 25, openmvs 50, odm_filterpoints 52, odm_meshing 60, mvs_texturing 70, **odm_georeferencing 80**, odm_dem 90, odm_orthophoto 98, odm_report 99, odm_postprocess 100 (floats such as `25.0`; stages also send mid-stage values; skipped stages still send theirs; `split` and `merge` send 5 and 0)                                                                                                                                                                                                                                                                                                                 | `photo/odm/flags.py` (2), copy in `tests/fake_odm/fake_odm.py` (3) |
| C7  | UDP datagram form and port       | `PGUP/<pid>/<project name>/<percent>` to 127.0.0.1:6367 (confirmed; pid is ODM's Python, not cmd's)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `photo/odm/runner.py` (4)                                          |
| C8  | Output paths                     | `odm_orthophoto/odm_orthophoto.tif`; `odm_dem/dsm.tif`; `odm_dem/dtm.tif`; `odm_georeferencing/odm_georeferenced_model.copc.laz` (and `.laz` beside it); `odm_texturing/odm_textured_model_geo.obj`, else **`odm_texturing_25d/`**`odm_textured_model_geo.obj`; `odm_georeferencing/coords.txt`; `odm_report/report.pdf`; `odm_report/stats.json`                                                                                                                                                                                                                                                                                     | `photo/odm/outputs.py` (7)                                         |
| C9  | OBJ vertex frame                 | UTM of `coords.txt` line 1, minus the offset on line 2 (x, y); z absolute (confirmed; `coords.txt` has one more line per camera after line 2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `photo/odm/outputs.py` (7)                                         |
| C10 | Reconstruction files             | `opensfm/reconstruction.topocentric.json`, else `opensfm/reconstruction.json`; frame from `opensfm/reference_lla.json`; statistics from `opensfm/stats/stats.json` (written in the opensfm stage; `reconstruction_statistics.reprojection_error_pixels`, `average_track_length`). **`tracks.csv` is binary** (`OPENSFM_TRACKS_VERSION_v102`, C++ `TracksManager`): not read. Observations are not imported (see Task 6)                                                                                                                                                                                                               | `photo/odm/reconstruction.py` (6)                                  |
| C11 | GPU log lines                    | features yes: `Using GPU for extracting SIFT features`; features fallback: `GPU SIFT extraction failed`; dense fallback: `OpenMVS failed with GPU`. **No dense "yes" line exists** (DensifyPointCloud runs with `-v 0`) and in 3.6.2 on Windows dense matching ran on the CPU (OpenMVS loads ODM's bundled stub `nvcuda.dll`). With the placeholder `SuperBuild\install\bin\nvcuda.dll` renamed (deviation 17), OpenMVS uses the GPU but still logs nothing; dense is reported "yes" when the stub is parked, the driver exists, openmvs ran and no fallback line appeared (or a `CUDA device \d+ initialized` line shows), else "no" | `photo/odm/runner.py` (4)                                          |
| C12 | `GEOREF_STRATEGY`                | `"invalidate"` (`--rerun-from opensfm` extracts features again; invalidation with the list in `GEOREF_INVALIDATE` reruns metadata and reconstruction only, 37 s against 58 s on 24 photos)                                                                                                                                                                                                                                                                                                                                                                                                                                            | `photo/odm/flags.py` (2), `photo/odm/project.py` (5)               |
| C13 | `FAST_FIRST_STAGE`               | `"odm_filterpoints"` (confirmed after a normal align)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `photo/odm/flags.py` (2)                                           |
| C14 | `UNINSTALL_MATCH`, uninstaller   | `/^ODM\b/i` (DisplayName `ODM version 3.6.2`, InstallLocation with a trailing backslash); `unins000.exe`. Uninstall timing not measured: poll for `run.bat` to go                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `main/odm/detect.ts`, `main/odm/install.ts` (12)                   |
| C15 | `geo.txt` columns                | `EPSG:4326` header; **always 9 columns** `name lon lat h yaw pitch roll hAcc vAcc`, `nan` for an unknown yaw, pitch or roll (a row with fewer than 9 columns clears the photo's EXIF RTK accuracy)                                                                                                                                                                                                                                                                                                                                                                                                                                    | `photo/odm/project.py` (5)                                         |

## File structure

Created (Python, `python/src/aio_pipelines/`):

| File                          | Responsibility                                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `photo/proctree.py`           | process tree and memory of child processes (moved from `colmap_io.py`): `end_tree`, `tree_memory`, `kill`, ... |
| `walk/colmap_child.py`        | the COLMAP child plumbing walks need (moved from `colmap_io.py` and `align.first_octave`)                      |
| `photo/glb.py`                | `glb_bytes`, `glb_info`, `jpeg_bytes`, `enu_to_local` (moved from `texture.py` and `mesh.py`)                  |
| `photo/odm/__init__.py`       | package marker                                                                                                 |
| `photo/odm/flags.py`          | ODM stages, progress table, preset flags, threads, GPU choice, product steps (pure)                            |
| `photo/odm/runner.py`         | find ODM, build the command, run it with progress, cancel, resume, exit codes, GPU use from the log            |
| `photo/odm/project.py`        | the ODM project folder: safe path, image links, `geo.txt`, `gcp_list.txt`, boundary, invalidation, cleanup     |
| `photo/odm/reconstruction.py` | OpenSfM reconstruction and statistics into our `SparseModel` in the run's ENU frame                            |
| `photo/odm/outputs.py`        | ODM outputs into the project CRS: DEMs, ortho, point cloud to COPC, textured OBJ to GLB                        |

Created (tests): `python/tests/test_proctree.py`, `test_odm_flags.py`, `test_fake_odm.py`, `test_odm_runner.py`, `test_odm_project.py`, `test_odm_reconstruction.py`, `test_odm_outputs.py`, `test_odm_real.py` (opt-in), `odm_synth.py`, `fake_odm/run.bat`, `fake_odm/run.sh`, `fake_odm/fake_odm.py`.

Created (desktop): `apps/desktop/src/main/odm/{pin,paths,detect,system,install,ipc}.ts` with tests (`system.ts` has none: it only starts programs); `packages/schema/src/odm.ts` (+ `odm.test.ts`); `apps/desktop/src/renderer/odmStore.ts` (+ test), `renderer/odm.ts`, `renderer/screens/settings/ProcessingEngine.tsx`, `processingEngine.css`, `processingEngineView.ts` (+ test); `tools/odm/probe.mjs`; `docs/architecture/adr/0012-odm-engine.md`.

Rewritten: `photo/align.py`, `photo/georef.py`, `photo/products.py` and their tests; `apps/desktop/e2e/photo-fake/aio_photo_fake.py`.

Deleted: `photo/colmap_io.py`, `dense.py`, `fuse.py`, `ortho.py`, `mesh.py`, `texture.py`, `pool.py`, `card.py`, `gpu_match.py`, `merge.py`, `budget.py`, `aio_pipelines/accel.py`; tests `test_photo_dense.py`, `test_photo_card.py`, `test_photo_card_job.py`, `test_photo_pool.py`, `test_photo_merge.py`, `test_photo_mesh.py`, `test_photo_ortho.py`, `test_photo_gpu_match.py`, `test_photo_engine.py`, `test_photo_budget.py`, `test_accel.py`, `test_photo_chain.py`; `photo_g2_synth.py` engine parts; `apps/desktop/src/main/jobs/addon.ts` and `addon.test.ts`; `tools/pipeline-pack/accelerator.mjs`, `accelerator.test.mjs`, `accelerator-lock.json`; `apps/desktop/e2e/photo-real.spec.ts`.

## Execution DAG

| Task                                  | Depends on               | Packages touched                                                                                                                                                   |
| ------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0 Real ODM probe                      | none                     | `tools/odm`                                                                                                                                                        |
| 1 Process tree and tool runner        | 0                        | pipelines (`photo/proctree.py`, `photo/native.py`, `photo/colmap_io.py`, `walk/`), python tests                                                                    |
| 2 ODM flags                           | 0                        | pipelines (`photo/odm/flags.py`)                                                                                                                                   |
| 3 Fake ODM and ODM fixtures           | 0                        | python tests (`fake_odm/`, `odm_synth.py`, `products_synth.py`, `two_surveys_synth.py`)                                                                            |
| 5 ODM project folder and GCP list     | 0                        | pipelines (`photo/odm/project.py`)                                                                                                                                 |
| 6 Reconstruction reader               | 0                        | pipelines (`photo/odm/reconstruction.py`)                                                                                                                          |
| 7 Output import and GLB               | 0                        | pipelines (`photo/odm/outputs.py`, `photo/glb.py`)                                                                                                                 |
| 11 Schema contract                    | 0                        | `@aio/schema`, `tools/compat`, preload, docs (`contract-changes.md`)                                                                                               |
| 4 ODM runner                          | 1, 2, 3                  | pipelines (`photo/odm/runner.py`)                                                                                                                                  |
| 12 ODM installer in main              | 11                       | desktop main (`main/odm/`)                                                                                                                                         |
| 15 Processing engine card             | 11                       | renderer (`odmStore`, `odm.ts`, settings card, `store.ts`, `ProcessingTools.tsx`), `@aio/ui` (`en.ts`)                                                             |
| 8 photo.align on ODM                  | 3, 4, 5, 6               | pipelines (`photo/align.py`)                                                                                                                                       |
| 9 photo.georef on ODM                 | 3, 4, 5, 6               | pipelines (`photo/georef.py`)                                                                                                                                      |
| 10 photo.products on ODM              | 2, 3, 4, 5, 7            | pipelines (`photo/products.py`)                                                                                                                                    |
| 14 Main wiring and add-on removal     | 12                       | desktop main (`index.ts`, `photogrammetry.ts`, `jobs/runner.ts`, `jobs/addon.ts` deleted)                                                                          |
| 16 Wizard, run panel and job forms    | 11, 15                   | renderer (`photogrammetry/`, `jobs.ts`)                                                                                                                            |
| 13 Delete the old engine              | 1, 8, 9, 10              | pipelines, python tests, `pyproject.toml`, `uv.lock`, `tools/pipeline-pack/build.mjs`, `tools/ci/pytest-parts.test.mjs`, `.github/workflows/ci.yml` (python parts) |
| 17 Paperwork, add-on tooling, notices | 13, 14                   | docs (ADR 0012, ADR 0008, data-conventions, release README), `tools/release`, `tools/pipeline-pack`, CI                                                            |
| 18 End to end                         | 8, 9, 10, 13, 14, 15, 16 | `apps/desktop/e2e`, `tools/ci/e2e-timings.json`, `.github/workflows/nightly.yml`, `.gitignore` (one line)                                                          |

Parallel batches (tasks in a batch share no file and have every dependency met; dispatch each batch in one message):

- **Batch 0:** Task 0 alone (real install; needs the founder's go for a window, see the task).
- **Batch 1:** Tasks 1, 2, 3, 5, 6, 7, 11.
- **Batch 2:** Tasks 4, 12, 15.
- **Batch 3:** Tasks 8, 9, 10, 14, 16.
- **Batch 4:** Task 13.
- **Batch 5:** Tasks 17, 18.

File ownership inside batches (checked): Batch 1: Task 1 owns `photo/proctree.py`, `photo/native.py`, `photo/colmap_io.py`, `walk/colmap_child.py`, `walk/sfm.py`, `tests/conftest.py`, `tests/test_proctree.py`, `tests/test_photo_align.py` (moved tests out); Task 2 `photo/odm/__init__.py`, `photo/odm/flags.py`, `tests/test_odm_flags.py`; Task 3 `tests/fake_odm/**`, `tests/odm_synth.py`, `tests/test_fake_odm.py`, `tests/products_synth.py`, `tests/two_surveys_synth.py`; Task 5 `photo/odm/project.py`, `tests/test_odm_project.py`; Task 6 `photo/odm/reconstruction.py`, `tests/test_odm_reconstruction.py`; Task 7 `photo/odm/outputs.py`, `photo/glb.py`, `tests/test_odm_outputs.py`; Task 11 `packages/schema/src/{odm,odm.test,index,ipc,jobs,photogrammetry,versions,m10.test}.ts`, `tools/compat/odm-additive.test.mjs`, `apps/desktop/src/preload/index.ts`, `docs/architecture/contract-changes.md`. Batch 2: Task 4 `photo/odm/runner.py`, `tests/test_odm_runner.py`, `tests/fake_odm/fake_odm.py` (two additions); Task 12 `apps/desktop/src/main/odm/**`; Task 15 `renderer/{odmStore,odmStore.test,odm}.ts`, `renderer/screens/settings/{ProcessingEngine.tsx,processingEngine.css,processingEngineView.ts,processingEngineView.test.ts,ProcessingTools.tsx}`, `renderer/store.ts`, `packages/ui/src/i18n/en.ts`. Batch 3: Task 8 `photo/align.py`, `tests/test_photo_align.py`, `tests/fake_odm/fake_odm.py` (one addition); Task 9 `photo/georef.py`, `tests/test_photo_georef.py`, `tests/odm_synth.py`, `tests/products_synth.py` (additions); Task 10 `photo/products.py`, `tests/test_photo_products.py`, `tests/test_odm_real.py`, `tests/test_opf.py`; Task 14 `main/index.ts`, `main/photogrammetry.ts` (+ test), `main/jobs/runner.ts` (+ test), `main/jobs/addon.ts` (deleted), `main/diagnostics/photo.ts` (+ test), `main/diagnostics/redact.ts` (+ test); Task 16 `renderer/photogrammetry/{hardware,ProcessWizard,estimate,phases,store}.ts(x)` and their tests, `renderer/jobs.ts`. Batch 4: Task 13 also owns `tests/test_proctree.py`, `tools/ci/pytest-parts.test.mjs` and the python-parts lines of `.github/workflows/ci.yml` (the `photo-chain` part). Batch 5: Task 17 `docs/**` (including the lines of `docs/KNOWN-LIMITS.md` and `docs/release/README.md` that name `photo-real.spec.ts`), `tools/release/**`, `tools/pipeline-pack/accelerator*`, `.github/workflows/{ci,release}.yml` (the add-on job and the `photo-real` comment of `ci.yml`); Task 18 `apps/desktop/e2e/**`, `tools/ci/e2e-timings.json`, `.github/workflows/nightly.yml`, `.gitignore`. In Batch 1 only Task 2 creates `photo/odm/__init__.py`: Tasks 5, 6 and 7 must not (the folder imports as a namespace package until Task 2 commits).

**Critical path:** Task 0 → Task 1 → Task 4 → Task 10 → Task 13 → Task 18 (six batches; Tasks 4 and 10 are the longest). The desktop line Task 0 → 11 → 12 → 14 → 18 runs beside it with slack.

## Contract change

All in `@aio/schema` (Task 11) unless named. Rows to append to the table in `docs/architecture/contract-changes.md`, after the last row, exact text (the header is `| Date | Change | Why | Streams affected | Approved by |`):

```markdown
| 2026-10-14 | ODM processing engine (plan `2026-10-14-odm-engine`, ADR 0012). New `odm.ts`: `OdmGpuSetting` (`auto` \| `off`), `OdmState` (`unsupported`, `not-installed`, `installing`, `installed`, `update-available`, `broken`), `OdmStatus`, `OdmInstallProgress` (phase `download`, `verify`, `install`, `check`, `done`, `failed`, `cancelled`), `OdmInstallRecord` (`aio.odm-install/1`, the file `<dataRoot>/runtime/odm.json`: `version`, `dir`, `installedAt`). IPC additive: `odm:status`, `odm:install` (`{ replaceOther? }`), `odm:cancel`, `odm:remove`, `odm:setGpu` (`{ gpu }`), event `odm:progress`. `Settings` gains optional `processing` (`{ odm?: { gpu?: OdmGpuSetting } }`). `HardwareProbe.processing` gains `no-engine`; `HardwareProbe` gains optional `engine` (`{ state, version?, gpu }`); `cuda` now means NVIDIA's CUDA driver is present. `PhotoRun` gains optional `engine` (`{ name: 'odm', version, gpu: { features?, dense? } }`) | ODM replaces our own photogrammetry engine (founder, 14 Oct) | `@aio/schema`, desktop main, preload, renderer, pipelines | pending founder review |
| 2026-10-14 | Photo jobs on ODM (plan `2026-10-14-odm-engine`). `PhotoProductsParams.dense` removed (the pipeline refuses it). `photo.align` steps are `inspect`, `sfm`, `georef`, `report`, `commit`; `photo.products` steps are `prepare`, `dense`, `mesh`, `texture`, `cloud`, `dsm`, `ortho`, `commit`, `tiles` (`fuse` and `dtm` are gone; `PhotoStageName` is unchanged). Photo jobs need pipeline pack 0.8.0 and run on Windows x64 only. `HardwareProbe.accelerator` and `aio.pipeline-addon/1` are no longer written (kept readable). `report/products.json` `engines` is `{ odm }`; `report/align.json` `mapper` is `opensfm` and `pairs` is gone | Our engine and the GPU add-on are deleted with it | `@aio/schema`, desktop main, renderer, pipelines | pending founder review |
```

## Tests per task

| Task | Unit tests                                                                                                                                                                                         |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | none (a manual probe; its output is the findings JSON)                                                                                                                                             |
| 1    | `python/tests/test_proctree.py` (new), `test_walk_sfm.py` and `test_walk_stitch.py` stay green                                                                                                     |
| 2    | `python/tests/test_odm_flags.py`                                                                                                                                                                   |
| 3    | `python/tests/test_fake_odm.py`                                                                                                                                                                    |
| 4    | `python/tests/test_odm_runner.py`                                                                                                                                                                  |
| 5    | `python/tests/test_odm_project.py`                                                                                                                                                                 |
| 6    | `python/tests/test_odm_reconstruction.py`                                                                                                                                                          |
| 7    | `python/tests/test_odm_outputs.py`                                                                                                                                                                 |
| 8    | `python/tests/test_photo_align.py` (rewritten)                                                                                                                                                     |
| 9    | `python/tests/test_photo_georef.py` (rewritten), `test_gcp.py` stays green                                                                                                                         |
| 10   | `python/tests/test_photo_products.py` (rewritten), `test_opf.py` (updated: products refuse an imported run), `test_odm_real.py` (opt-in, real ODM)                                                 |
| 11   | `packages/schema/src/odm.test.ts`, `m10.test.ts` (updated), `tools/compat/odm-additive.test.mjs`, `tools/compat/settings-0.8.test.mjs` stays green                                                 |
| 12   | `apps/desktop/src/main/odm/{pin,paths,detect,install,ipc}.test.ts`                                                                                                                                 |
| 13   | the whole `python/tests` suite (`test_photo_runs.py`, `test_proctree.py` updated); `tools/pipeline-pack/build.test.mjs`; `tools/ci/pytest-parts.test.mjs`                                          |
| 14   | `apps/desktop/src/main/photogrammetry.test.ts`, `apps/desktop/src/main/jobs/runner.test.ts`, `apps/desktop/src/main/diagnostics/photo.test.ts`, `apps/desktop/src/main/diagnostics/redact.test.ts` |
| 15   | `apps/desktop/src/renderer/odmStore.test.ts`, `renderer/screens/settings/processingEngineView.test.ts`, `packages/ui/src/i18n/i18n.test.ts`                                                        |
| 16   | `renderer/photogrammetry/{hardware,phases,estimate}.test.ts`                                                                                                                                       |
| 17   | `tools/release/notices.test.mjs`, `tools/release/budgets.test.mjs`, `node tools/release/notices.mjs --check`                                                                                       |

**End to end specs.** Changed: `processing-tools.spec.ts` (the Processing engine card: install from a local fake setup, progress, installed state, switch, remove, another ODM), `photo-process.spec.ts` (step words, the "Install the processing engine first" block, the GPU line), `photo-products.spec.ts` and `photo-change.spec.ts` (real `photo.products` on the fake ODM), `photoPack.ts` (COLMAP helpers removed, `QUADRION_ODM_DIR`), `photo-fake/aio_photo_fake.py` (step names), `photo-fixture.py` and `photo-two-surveys-fixture.py` (unchanged scripts; their projects now carry an ODM folder through `products_synth`). Removed: `photo-real.spec.ts` (COLMAP; the real-engine check is Task 0 and `test_odm_real.py`). Must stay green unchanged: `gcp-marking.spec.ts`, `agent-photo.spec.ts`, `processing-drawer.spec.ts`, `walk-360.spec.ts`. All run in Task 18 the way CI runs them, after `pnpm demo:build --quick`.

---

### Task 0: Real ODM probe (critical risk, first and alone)

Installs the pinned ODM 3.6.2 for real, once, into a scratch folder, runs it on a small public sample, and records every fact the later tasks depend on (table "Probe-fed constants"). It is harmless but visible: a setup runs, possibly a Windows permission prompt, and ODM uses the CPU and GPU for about 30 to 60 minutes.

**Before starting:** the controller asks the founder for a window (memory: no heavy jobs while the PC is in use) and confirms that no other ODM is installed. The script itself refuses to install when it finds another ODM (an uninstall entry whose DisplayName starts with "ODM", or `C:\ODM\run.bat`), because ODM's setup removes a previous install. **It never touches `C:\ODM`.**

**Files:**

- Create: `tools/odm/probe.mjs`

**Interfaces:**

- Consumes: nothing from other tasks.
- Produces: `<scratch>/findings.json` (not committed), read by the controller to amend the "Probe-fed constants" table. Shape:

```json
{
  "pin": { "version": "3.6.2", "bytes": 244864104, "sha256ok": true },
  "setup": {
    "args": ["/VERYSILENT", "..."],
    "exitCode": 0,
    "seconds": 0,
    "adminPrompt": "ask the founder",
    "logTail": []
  },
  "installed": {
    "dir": "",
    "bytes": 0,
    "topLevel": [],
    "pythonExe": [],
    "versionFile": "3.6.2",
    "uninstaller": "unins000.exe",
    "uninstallEntry": "<the raw reg query text, at most 4000 characters>"
  },
  "help": { "exitCode": 0, "seconds": 0 },
  "runs": {
    "align": {},
    "products": {},
    "rerunOpensfm": {},
    "invalidate": {},
    "fastAfterAlign": {},
    "spacesProject": {}
  },
  "udp": { "samples": [], "stageEndPercent": {} },
  "gpuLines": [],
  "outputs": [],
  "coords": "",
  "objFirstVertex": "",
  "tracksHeader": "",
  "statsKeys": [],
  "uninstall": { "exitCode": 0, "secondsUntilRunBatGone": 0, "entryRemoved": true }
}
```

- [ ] **Step 1: Write the probe script**

```js
#!/usr/bin/env node
/* eslint-disable no-console -- a manual probe that reports on the console */
// tools/odm/probe.mjs: install the pinned ODM once into a scratch folder, run it on a small public
// sample and write findings.json. Manual, run by a person on a Windows workstation with an NVIDIA
// card; never in CI. Refuses when another ODM is installed (ODM's setup would remove it).
//
//   node tools/odm/probe.mjs --scratch <empty folder without spaces> [--images 24] [--skip-install]
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile, cp } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const PIN = {
  version: '3.6.2',
  url: 'https://github.com/OpenDroneMap/ODM/releases/download/v3.6.2/ODM_Setup_3.6.2.exe',
  size: 244_864_104,
  sha256: 'c9dbfabf0d066529a7b6c753fd45bf3366a0314266160cd677373bab4caff294',
};
const SETUP_ARGS = ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CURRENTUSER'];
const SAMPLE = 'https://api.github.com/repos/OpenDroneMap/odm_data_aukerman/contents/images';
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const scratch = arg('scratch');
if (!scratch || /\s/.test(scratch))
  throw new Error('--scratch <empty folder without spaces> is required');
const nImages = Number(arg('images', '24'));
const F = { gpuLines: [], outputs: [], runs: {}, udp: { samples: [], stageEndPercent: {} } };
const save = () => writeFile(join(scratch, 'findings.json'), JSON.stringify(F, null, 2));

function otherOdm() {
  const hits = [];
  const keys = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  for (const key of keys) {
    try {
      const out = execFileSync('reg', ['query', key, '/s', '/f', 'ODM', '/d'], {
        encoding: 'utf8',
        windowsHide: true,
      });
      hits.push(out);
    } catch {
      /* reg exits 1 when nothing matches */
    }
  }
  return { reg: hits.join('\n'), cOdm: existsSync('C:\\ODM\\run.bat') };
}

async function download(dest) {
  const r = await fetch(PIN.url, { redirect: 'follow' });
  if (!r.ok || !r.body) throw new Error(`download: HTTP ${r.status}`);
  const hash = createHash('sha256');
  const body = Readable.fromWeb(r.body);
  body.on('data', (c) => hash.update(c));
  await pipeline(body, createWriteStream(dest));
  const s = await stat(dest);
  F.pin = {
    version: PIN.version,
    bytes: s.size,
    sha256ok: s.size === PIN.size && hash.digest('hex') === PIN.sha256,
  };
  if (!F.pin.sha256ok) throw new Error('the download does not match the pinned size and SHA-256');
}

function run(cmd, args, o = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(cmd, args, { windowsHide: true, ...o });
    let out = '';
    p.stdout?.on('data', (d) => {
      out += d;
      o.onLine?.(String(d));
    });
    p.stderr?.on('data', (d) => {
      out += d;
    });
    p.on('close', (code) => resolve({ code, out, seconds: (Date.now() - t0) / 1000 }));
  });
}

async function dirBytes(d) {
  let n = 0;
  for (const e of await readdir(d, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) n += (await stat(join(e.parentPath, e.name))).size;
  }
  return n;
}

function odm(dir, project, flags) {
  const udp = createSocket('udp4');
  const samples = [];
  udp.on('message', (m) => samples.push({ t: Date.now(), m: String(m) }));
  udp.bind(6367, '127.0.0.1');
  const lines = [];
  const finished = [];
  return run(
    process.env.ComSpec ?? 'cmd.exe',
    [
      '/d',
      '/s',
      '/c',
      `"${join(dir, 'run.bat')}" ${flags.join(' ')} --project-path "${join(project, '..')}" ${project.split('\\').pop()}`,
    ],
    {
      windowsVerbatimArguments: true,
      env: { ...process.env, ODM_NONINTERACTIVE: '1' },
      onLine: (s) => {
        for (const l of s.split(/\r?\n/)) {
          lines.push(l);
          const m = /Finished (\w+) stage/.exec(l);
          if (m) finished.push({ stage: m[1], t: Date.now() });
        }
      },
    },
  ).then((r) => {
    udp.close();
    F.udp.samples.push(...samples.slice(0, 400));
    for (const l of r.out.split(/\r?\n/)) {
      if (/GPU|CUDA|SIFT/i.test(l)) F.gpuLines.push(l.trim().slice(0, 300));
    }
    const stages = [...r.out.matchAll(/(Running|Finished) (\w+) stage/g)].map(
      (m) => `${m[1]} ${m[2]}`,
    );
    const ends = {};
    for (const s of samples) {
      const pct = Number(String(s.m).split('/').pop());
      if (Number.isFinite(pct)) ends[s.t] = pct;
    }
    // ODM's percent at each stage's end: the last datagram before its Finished line
    for (const f of finished) {
      const last = samples.filter((s) => s.t <= f.t).pop();
      if (last) F.udp.stageEndPercent[f.stage] = Number(String(last.m).split('/').pop());
    }
    return {
      code: r.code,
      seconds: r.seconds,
      stages,
      tail: r.out.split(/\r?\n/).slice(-40),
      // feature extraction anywhere in the output, not only in the tail
      features: (r.out.match(/detect_features|Extracting/gi) ?? []).length,
      percents: Object.values(ends),
    };
  });
}

async function listFiles(root) {
  const out = [];
  for (const e of await readdir(root, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) out.push(join(e.parentPath, e.name).slice(root.length + 1));
  }
  return out.sort();
}

async function main() {
  await mkdir(scratch, { recursive: true });
  const other = otherOdm();
  if (other.cOdm || /DisplayName\s+REG_SZ\s+ODM/i.test(other.reg)) {
    console.log('Another ODM is installed on this computer; its setup would remove it. Stopping.');
    console.log(other.reg);
    process.exit(2);
  }
  const dir = join(scratch, `odm-${PIN.version}`);
  if (process.argv.includes('--skip-install') === false) {
    const exe = join(scratch, 'ODM_Setup_3.6.2.exe');
    await download(exe);
    const args = [...SETUP_ARGS, `/DIR=${dir}`, `/LOG=${join(scratch, 'setup.log')}`];
    console.log('Installing (watch the screen for a Windows permission prompt)...');
    const r = await run(exe, args);
    const log = existsSync(join(scratch, 'setup.log'))
      ? await readFile(join(scratch, 'setup.log'), 'utf8')
      : '';
    F.setup = {
      args: SETUP_ARGS,
      exitCode: r.code,
      seconds: r.seconds,
      adminPrompt: 'ask the founder',
      logTail: log
        .split(/\r?\n/)
        .filter((l) => /vc_redist|admin|elevat|uninstall/i.test(l))
        .slice(-40),
    };
    await save();
  }
  const top = await readdir(dir);
  const files = await listFiles(dir);
  F.installed = {
    dir,
    bytes: await dirBytes(dir),
    topLevel: top,
    pythonExe: files.filter((f) => /(^|\\)python\.exe$/i.test(f)).slice(0, 10),
    versionFile: existsSync(join(dir, 'VERSION'))
      ? (await readFile(join(dir, 'VERSION'), 'utf8')).trim()
      : null,
    uninstaller: top.find((f) => /^unins\d+\.exe$/i.test(f)) ?? null,
    uninstallEntry: otherOdm().reg.slice(0, 4000),
  };
  const help = await run(
    process.env.ComSpec ?? 'cmd.exe',
    ['/d', '/c', join(dir, 'run.bat'), '--help'],
    { env: { ...process.env, ODM_NONINTERACTIVE: '1' } },
  );
  F.help = { exitCode: help.code, seconds: help.seconds };
  await save();

  // the public sample: the first N photos of odm_data_aukerman
  const proj = join(scratch, 'proj', 'aukerman');
  await mkdir(join(proj, 'images'), { recursive: true });
  const list = await (
    await fetch(SAMPLE, { headers: { 'user-agent': 'quadrion-odm-probe' } })
  ).json();
  for (const f of list.filter((x) => /\.jpe?g$/i.test(x.name)).slice(0, nImages)) {
    const r = await fetch(f.download_url);
    await pipeline(Readable.fromWeb(r.body), createWriteStream(join(proj, 'images', f.name)));
  }
  const base = ['--feature-quality', 'medium', '--feature-type', 'sift', '--max-concurrency', '8'];
  F.runs.align = await odm(dir, proj, [...base, '--end-with', 'opensfm']);
  F.tracksHeader = existsSync(join(proj, 'opensfm', 'tracks.csv'))
    ? (await readFile(join(proj, 'opensfm', 'tracks.csv'), 'utf8')).split(/\r?\n/)[0]
    : null;
  F.runs.rerunOpensfm = await odm(dir, proj, [
    ...base,
    '--rerun-from',
    'opensfm',
    '--end-with',
    'opensfm',
  ]);
  F.runs.rerunOpensfm.featuresAgain = F.runs.rerunOpensfm.features;
  for (const rel of [
    'opensfm/reconstruction.json',
    'opensfm/reconstruction.topocentric.json',
    'opensfm/config.yaml',
    'opensfm/undistorted',
    'odm_georeferencing',
  ]) {
    await rm(join(proj, rel), { recursive: true, force: true });
  }
  F.runs.invalidate = await odm(dir, proj, [...base, '--end-with', 'opensfm']);
  F.runs.fastAfterAlign = await odm(dir, proj, [
    ...base,
    '--fast-orthophoto',
    '--skip-3dmodel',
    '--pc-quality',
    'low',
    '--rerun-from',
    'odm_filterpoints',
    '--end-with',
    'odm_orthophoto',
    '--dsm',
    '--dtm',
    '--cog',
    '--orthophoto-resolution',
    '5',
    '--dem-resolution',
    '10',
  ]);
  F.runs.products = await odm(dir, proj, [
    ...base,
    '--pc-quality',
    'low',
    '--rerun-from',
    'openmvs',
    '--dsm',
    '--dtm',
    '--cog',
    '--pc-copc',
    '--build-overviews',
    '--orthophoto-resolution',
    '5',
    '--dem-resolution',
    '10',
  ]);
  F.outputs = (await listFiles(proj)).filter((f) => !f.startsWith('images'));
  F.coords = existsSync(join(proj, 'odm_georeferencing', 'coords.txt'))
    ? await readFile(join(proj, 'odm_georeferencing', 'coords.txt'), 'utf8')
    : null;
  const obj = join(proj, 'odm_texturing', 'odm_textured_model_geo.obj');
  F.objFirstVertex = existsSync(obj)
    ? (await readFile(obj, 'utf8')).split(/\r?\n/).find((l) => l.startsWith('v '))
    : null;
  const stats = join(proj, 'odm_report', 'stats.json');
  F.statsKeys = existsSync(stats) ? Object.keys(JSON.parse(await readFile(stats, 'utf8'))) : [];
  await save();

  // a project path with a space and a non-ASCII letter
  const spaced = join(scratch, 'Probe Data é', 'aukerman');
  await mkdir(join(spaced, 'images'), { recursive: true });
  for (const f of (await readdir(join(proj, 'images'))).slice(0, 10))
    await cp(join(proj, 'images', f), join(spaced, 'images', f));
  F.runs.spacesProject = await odm(dir, spaced, [...base, '--end-with', 'opensfm']);
  await save();

  // remove: the Inno uninstaller, then wait for run.bat to go
  const t0 = Date.now();
  const u = F.installed.uninstaller
    ? await run(join(dir, F.installed.uninstaller), [
        '/VERYSILENT',
        '/SUPPRESSMSGBOXES',
        '/NORESTART',
      ])
    : { code: null };
  while (existsSync(join(dir, 'run.bat')) && Date.now() - t0 < 300_000)
    await new Promise((r) => setTimeout(r, 1000));
  F.uninstall = {
    exitCode: u.code,
    secondsUntilRunBatGone: (Date.now() - t0) / 1000,
    entryRemoved: !/DisplayName\s+REG_SZ\s+ODM/i.test(otherOdm().reg),
  };
  await save();
  console.log(`Done: ${join(scratch, 'findings.json')}`);
}

await main();
```

- [ ] **Step 2: Lint it**

Run: `pnpm exec eslint tools/odm/probe.mjs` and `npx prettier --check tools/odm/probe.mjs`
Expected: no errors (fix formatting with `npx prettier --write tools/odm/probe.mjs`).

- [ ] **Step 3: Install (with the founder's go).** Run: `node tools/odm/probe.mjs --scratch C:\Users\<user>\AppData\Local\QuadrionOdmProbe` (any empty folder without spaces). Watch for a Windows permission prompt during the setup and write "yes" or "no" into `findings.json` `setup.adminPrompt` (ask the founder, who sees the screen). Fills C1, C2.

- [ ] **Step 4: Read the install.** From `findings.json` `installed`: C3 is `installed.bytes` rounded up to the next 100 MB; C4 is `['run.bat', 'VERSION', <installed.pythonExe[0]>]` (the bundled Python the spec asks to verify); C14's DisplayName and uninstaller name.

- [ ] **Step 5: Smoke test.** `help.exitCode` must be 0; if it is not, stop and report (the install check in Task 12 depends on it).

- [ ] **Step 6: Paths with a space.** `runs.spacesProject.code` 0 means ODM handles a project path with a space and a non-ASCII letter: set C5 `SPACES_OK = true` in both places. Any other code keeps `false` (the junction path of Task 5 and the safe install folder of Task 12 are then required).

- [ ] **Step 7: Progress and GPU.** From `runs.align.stages`, `udp.samples` and `gpuLines`: confirm the `PGUP/<pid>/<name>/<percent>` form (C7), the percent ODM sends at each "Finished <stage> stage" (C6), and the exact GPU lines (C11). If features or dense matching fell back to the CPU on the RTX 5070 Ti, say so in the hand-off (the spec's Blackwell risk); nothing in the plan changes.

- [ ] **Step 8: Outputs.** From `outputs`, `coords`, `objFirstVertex`, `tracksHeader`, `statsKeys`: confirm C8, C9 (the OBJ's first vertex should be small numbers near the offset on `coords.txt` line 2; if the vertices are full UTM coordinates, C9 becomes "absolute UTM, no offset") and C10.

- [ ] **Step 9: Reruns.** `runs.rerunOpensfm.featuresAgain > 0` means `--rerun-from opensfm` extracts features again; if `runs.invalidate.code` is 0 and its log shows no feature extraction, set C12 `GEOREF_STRATEGY = "invalidate"`, else keep `"rerun-from"`. `runs.fastAfterAlign.code` 0 confirms C13; otherwise set C13 to `"openmvs"` and rerun that one call to confirm. C15 (`geo.txt` columns) is not measured by the probe: the default stays (ODM documents the format), and Task 10's opt-in real run is the check.

- [ ] **Step 10: Uninstall.** Confirm C14 from `uninstall` (`secondsUntilRunBatGone` above a few seconds means the uninstaller returns early, which the poll in Task 12 covers).

- [ ] **Step 11: Commit the probe script**

```bash
git add tools/odm/probe.mjs
git commit -m "chore(tools): odm install and run probe" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 12: Hand-off.** (Done 14 Oct 2026: commit `de198190`; the findings are folded into the table above.) Report to the controller: each constant C1 to C15 with its measured value and whether it differs from the default; the admin prompt; installed size; GPU paths on the RTX 5070 Ti; total run times. Do not commit `findings.json`. The controller amends the plan.

---

### Task 1: Process tree and tool runner, ready for the deletion

Moves the process-tree and memory code out of `colmap_io.py` (which Task 13 deletes) into `photo/proctree.py`, moves the COLMAP child plumbing walks need into `walk/colmap_child.py`, and gives `run_tool` the two things the ODM runner needs: an exit-code hook and a string command line.

**Files:**

- Create: `python/src/aio_pipelines/photo/proctree.py`, `python/src/aio_pipelines/walk/colmap_child.py`, `python/tests/test_proctree.py`
- Modify: `python/src/aio_pipelines/photo/colmap_io.py` (import the moved names from the new modules instead of defining them), `python/src/aio_pipelines/photo/native.py:70-82` (`_kill_tree`), `:110-182` (`run_tool`), `:149` (`tree_memory` import), `python/src/aio_pipelines/walk/sfm.py:47-49` and every `cio.` use (lines 301-363, 435, 475, 596-612), `python/tests/conftest.py:43-75` (`reused_pid`), `python/tests/test_photo_align.py` (remove the moved tests and their imports)

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `aio_pipelines.photo.proctree`: `memory_status() -> tuple[int, int]`, `memory_limit(total: int, available: int, cap: int | None = None) -> int`, `process_memory(pid: int) -> int`, `process_started(pid: int) -> float | None`, `process_links() -> list[tuple[int, int]]`, `START_TOLERANCE_S`, `descendants(...)`, `kill_list(...)`, `end_process(pid: int, started_at: float) -> str`, `end_tree(proc: subprocess.Popen, passes: int = 3) -> None`, `process_tree(pid: int) -> list[int]`, `tree_memory(pid: int) -> int`, `class MemoryExceeded(JobError)`, `kill(proc: subprocess.Popen) -> None`, `peak_memory_bytes() -> int` (bodies moved verbatim from `colmap_io.py` lines 122-441, 689-698, 711-743).
  - `aio_pipelines.walk.colmap_child`: `PYTHON_ENV = "AIO_COLMAP_PYTHON"`, `class Out` (was `colmap_io._Out`), `utf8_paths() -> bool`, `import_pycolmap(out: Out)` (was `_import_pycolmap`), `export_model(pc, rec, path: Path) -> dict` (was `_export`), `src_root() -> Path` (was `_src_root`; still `Path(__file__).resolve().parents[2]`), `first_octave(max_image_size: int) -> int` (was `align.first_octave`, body unchanged).
  - `native.run_tool(ctx, args: Sequence[str] | str, what: str, work: Path, expected_s: float = 60.0, progress: tuple[float, float] = (0.0, 0.95), memory_limit: int = 0, env: dict[str, str] | None = None, on_output: Callable[[str], float | None] | None = None, fail: Callable[[int, list[str]], JobError] | None = None) -> str`. A `str` is passed to `subprocess.Popen` as is (on Windows: the command line, unchanged). With `fail`, a non-zero exit raises `fail(returncode, last_lines)` where `last_lines` is the last 40 non-empty lines of stderr then stdout; without it the old message stays.

- [ ] **Step 1: Write the failing tests** (`python/tests/test_proctree.py`). Move, verbatim, the tests at `test_photo_align.py` lines 354-361 and 385-558 (`test_the_memory_limit_is_at_most_three_quarters_and_respects_free_memory` through `test_a_pid_given_to_another_process_since_the_walk_is_not_ended`, with their helpers `_child_with_grandchild`, `_running`, `_gone`, `WINDOWS_ONLY`) into the new file, importing from `aio_pipelines.photo.proctree` instead of `colmap_io`, and delete them from `test_photo_align.py`. Leave `test_the_memory_guard_stops_a_stage_before_it_takes_the_computer` and `test_the_memory_guard_does_not_count_an_older_process_that_names_the_engines_pid` (they drive `ColmapEngine`) where they are. Then add:

```python
import sys
from pathlib import Path

import pytest

from aio_pipelines.photo import native, proctree
from aio_pipelines.runtime import JobError


class _Ctx:
    """The parts of StepContext run_tool uses."""

    def __init__(self):
        import threading

        self.cancel_event = threading.Event()
        self.seen: list[tuple[float, str | None]] = []

    def progress(self, f, m=None):
        self.seen.append((f, m))


def test_run_tool_hands_the_exit_code_and_last_lines_to_fail(tmp_path: Path):
    def fail(code: int, lines: list[str]) -> JobError:
        return JobError(f"code {code}: {lines[-1]}")

    script = "import sys; print('one'); print('two'); sys.exit(137)"
    with pytest.raises(JobError, match="code 137: two"):
        native.run_tool(_Ctx(), [sys.executable, "-c", script], "probe", tmp_path, fail=fail)


@pytest.mark.skipif(sys.platform != "win32", reason="a command line string is how Windows starts run.bat")
def test_run_tool_takes_a_command_line_string(tmp_path: Path):
    line = f'"{sys.executable}" -c "print(41 + 1)"'
    assert native.run_tool(_Ctx(), line, "probe", tmp_path).strip() == "42"


def test_the_old_failure_message_stays_without_fail(tmp_path: Path):
    with pytest.raises(JobError, match="probe failed: boom"):
        native.run_tool(_Ctx(), [sys.executable, "-c", "import sys; print('boom'); sys.exit(1)"], "probe", tmp_path)


def test_colmap_io_still_offers_the_moved_names():
    from aio_pipelines.photo import colmap_io

    assert colmap_io.end_tree is proctree.end_tree and colmap_io.kill is proctree.kill
```

In `conftest.py` `reused_pid`, replace `from aio_pipelines.photo import colmap_io` with `from aio_pipelines.photo import proctree` and every `colmap_io.` with `proctree.` (the monkeypatches must target `proctree`, where `end_tree` looks the names up).

- [ ] **Step 2: Run them to see them fail**

Run: `uv run --frozen pytest tests/test_proctree.py -q` (from `python/`)
Expected: FAIL with `ModuleNotFoundError: No module named 'aio_pipelines.photo.proctree'`.

- [ ] **Step 3: Move the code.** Create `photo/proctree.py` with a module docstring ("Child processes: their tree, their memory, and ending them (moved from colmap_io, 14 Oct 2026)") and the bodies listed under Interfaces, moved verbatim with their imports (`contextlib`, `ctypes`, `os`, `subprocess`, `time`, `Callable`, `JobError`). In `colmap_io.py` delete those bodies and add `from .proctree import (MemoryExceeded, START_TOLERANCE_S, descendants, end_process, end_tree, kill, kill_list, memory_limit, memory_status, peak_memory_bytes, process_links, process_memory, process_started, process_tree, tree_memory)`, and `from ..walk.colmap_child import PYTHON_ENV, Out as _Out, export_model as _export, import_pycolmap as _import_pycolmap, src_root as _src_root, utf8_paths` so `ColmapEngine` keeps working until Task 13. Create `walk/colmap_child.py` with the moved child plumbing (docstring: "What the walk's COLMAP child needs: its progress channel, the pycolmap import and the model export (moved from photo/colmap_io.py, 14 Oct 2026)"). In `walk/sfm.py` replace `from ..photo import colmap_io as cio` with `from ..photo import proctree` and `from . import colmap_child as cc`, and map: `cio.PYTHON_ENV` to `cc.PYTHON_ENV`, `cio.memory_limit`/`memory_status`/`tree_memory`/`kill`/`MemoryExceeded`/`peak_memory_bytes` to `proctree.`, `cio._src_root()` to `cc.src_root()`, `cio._export` to `cc.export_model`, `cio._Out()` to `cc.Out()`, `cio._import_pycolmap` to `cc.import_pycolmap`, and `photo.align.first_octave` (line 435) to `cc.first_octave`.

In `native.py`:

```python
def _kill_tree(proc: subprocess.Popen) -> None:
    if os.name == "nt":
        from .proctree import end_tree

        end_tree(proc)
    else:
        try:
            os.killpg(proc.pid, 9)
        except OSError:
            proc.kill()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
```

and in `run_tool`: the signature above; `proc = subprocess.Popen(args if isinstance(args, str) else list(args), ...)`; the error for a tool that cannot start names `Path(args.split('"')[1] if isinstance(args, str) and args.startswith('"') else (args if isinstance(args, str) else args[0])).name`; `from .proctree import tree_memory`; and at the end:

```python
    out = out_path.read_text("utf-8", errors="replace")
    if proc.returncode != 0:
        err = err_path.read_text("utf-8", errors="replace")
        if fail is not None:
            lines = [ln for ln in (err + "\n" + out).splitlines() if ln.strip()][-40:]
            raise fail(proc.returncode, lines)
        lines = (err or out or "").strip().splitlines()
        raise JobError(f"{what} failed: {lines[-1] if lines else f'exit {proc.returncode}'}")
    return out
```

Update the module docstring of `native.py` (line 20: `proctree.end_tree`; line 27: `proctree.memory_limit`).

- [ ] **Step 4: Run the tests**

Run: `uv run --frozen pytest tests/test_proctree.py tests/test_walk_sfm.py tests/test_walk_stitch.py tests/test_photo_align.py -q`
Expected: PASS (the photo align tests still run on the synthetic engine; walks unchanged).

- [ ] **Step 5: Lint and commit**

Run: `uv run --frozen ruff check src tests && uv run --frozen ruff format --check src tests`

```bash
git add python/src/aio_pipelines/photo/proctree.py python/src/aio_pipelines/walk/colmap_child.py python/src/aio_pipelines/photo/colmap_io.py python/src/aio_pipelines/photo/native.py python/src/aio_pipelines/walk/sfm.py python/tests/test_proctree.py python/tests/conftest.py python/tests/test_photo_align.py
git commit -m "refactor(pipelines): process tree and colmap child out of colmap_io" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: ODM flags, stages and threads (pure)

**Files:**

- Create: `python/src/aio_pipelines/photo/odm/__init__.py` (docstring only: `"""ODM (OpenDroneMap) as the photogrammetry engine: started as a separate program (ADR 0012)."""`), `python/src/aio_pipelines/photo/odm/flags.py`, `python/tests/test_odm_flags.py`

**Interfaces:**

- Consumes: nothing.
- Produces (`aio_pipelines.photo.odm.flags`):
  - `STAGES: tuple[str, ...]` (ODM's order, without `split` and `merge`), `STAGE_END: dict[str, float]` (C6), `stage_start(stage: str) -> float`, `stage_window(first: str, last: str) -> tuple[float, float]`, `stage_after(stage: str) -> str | None`, `stage_index(stage: str) -> int`.
  - `PRESET_FLAGS: dict[str, tuple[str, ...]]`, `odm_threads(logical_cpus: int, ram_bytes: int, cap_bytes: int | None) -> int`, `gpu_wanted(setting: str, nvcuda_present: bool) -> bool`, `gpu_flags(use_gpu: bool) -> list[str]`.
  - `align_flags(preset: str, use_gpu: bool, threads: int, geo: Path | None) -> list[str]`, `georef_flags(preset: str, use_gpu: bool, threads: int, gcp: Path, geo: Path | None) -> list[str]`, `products_flags(preset: str, products: set[str], use_gpu: bool, threads: int, ortho_res_cm: float, dem_res_cm: float, mesh_size: int | None, boundary: Path | None) -> list[str]`. None of these add `--rerun-from`, `--end-with` or the project arguments: `runner.run_odm` adds them.
  - `@dataclass(frozen=True) class OdmStep: name: str; title: str; first: str; last: str; weight: float`, `product_steps(products: set[str]) -> list[OdmStep]`, `dense_first(preset: str) -> str`, `MESH_PRODUCTS = frozenset({"mesh", "tiles"})`.
  - `GEOREF_STRATEGY: str` (C12), `FAST_FIRST_STAGE: str` (C13).

- [ ] **Step 1: Write the failing tests** (`python/tests/test_odm_flags.py`)

```python
from pathlib import Path

import pytest

from aio_pipelines.photo.odm import flags as F

GB = 1024**3


def test_threads_follow_the_spec_formula():
    assert F.odm_threads(24, 64 * GB, None) == 21  # min(22, 21)
    assert F.odm_threads(24, 64 * GB, 48 * GB) == 16  # the cap lowers it
    assert F.odm_threads(4, 8 * GB, None) == 2  # never below 2
    assert F.odm_threads(128, 512 * GB, None) == 32  # never above 32
    assert F.odm_threads(1, 1 * GB, None) == 2


def test_gpu_only_when_auto_and_the_cuda_driver_is_there():
    assert F.gpu_wanted("auto", True) is True
    assert F.gpu_wanted("auto", False) is False
    assert F.gpu_wanted("off", True) is False
    assert F.gpu_wanted("nonsense", True) is True  # unknown values read as the default
    assert F.gpu_flags(True) == ["--feature-type", "sift"]
    assert F.gpu_flags(False) == ["--no-gpu"]


def test_preset_flags_are_the_spec_table():
    assert F.PRESET_FLAGS["fast"] == (
        "--fast-orthophoto", "--skip-3dmodel", "--pc-quality", "low", "--feature-quality", "medium",
    )  # fmt: skip
    assert F.PRESET_FLAGS["standard"] == ("--pc-quality", "medium", "--feature-quality", "high")
    assert F.PRESET_FLAGS["high"] == ("--pc-quality", "high", "--feature-quality", "ultra")


def test_align_flags(tmp_path: Path):
    geo = tmp_path / "geo.txt"
    got = F.align_flags("standard", True, 8, geo)
    assert got == [
        "--pc-quality", "medium", "--feature-quality", "high", "--feature-type", "sift",
        "--max-concurrency", "8", "--geo", str(geo),
    ]  # fmt: skip
    assert "--geo" not in F.align_flags("fast", False, 2, None)
    assert "--no-gpu" in F.align_flags("fast", False, 2, None)


def test_georef_flags_add_the_gcp_file(tmp_path: Path):
    gcp = tmp_path / "gcp_list.txt"
    got = F.georef_flags("high", False, 4, gcp, None)
    assert got[-2:] == ["--gcp", str(gcp)]


def test_products_flags_always_and_by_product(tmp_path: Path):
    got = F.products_flags("standard", {"ortho", "dsm"}, True, 20, 2.5, 5.0, None, None)
    for flag in ("--dsm", "--dtm", "--cog", "--pc-copc", "--build-overviews"):
        assert flag in got
    assert "--optimize-disk-space" not in got  # it would delete the features a later georeference reuses
    assert got[got.index("--orthophoto-resolution") + 1] == "2.5"
    assert got[got.index("--dem-resolution") + 1] == "5"
    assert got[got.index("--max-concurrency") + 1] == "20"
    assert "--skip-3dmodel" in got  # no mesh asked for
    with_mesh = F.products_flags("standard", {"mesh"}, True, 20, 2.5, 5.0, 300_000, tmp_path / "b.json")
    assert "--skip-3dmodel" not in with_mesh
    assert with_mesh[with_mesh.index("--mesh-size") + 1] == "300000"
    assert with_mesh[with_mesh.index("--boundary") + 1] == str(tmp_path / "b.json")
    fast = F.products_flags("fast", {"ortho"}, False, 2, 5.0, 10.0, None, None)
    assert fast.count("--skip-3dmodel") == 1  # once, though the preset has it too


def test_product_steps_cover_odm_in_order_without_gaps():
    for want in ({"ortho"}, {"mesh"}, {"cloud", "dsm", "dtm", "ortho", "mesh", "tiles"}):
        steps = F.product_steps(want)
        assert steps[0].name == "dense" and steps[-1].name == "ortho"
        assert steps[-1].last == "odm_postprocess"
        for a, b in zip(steps, steps[1:]):
            assert F.stage_after(a.last) == b.first, (a, b)
    names = [s.name for s in F.product_steps({"mesh"})]
    assert names == ["dense", "mesh", "texture", "cloud", "dsm", "ortho"]
    assert [s.name for s in F.product_steps({"ortho"})] == ["dense", "cloud", "dsm", "ortho"]


def test_dense_starts_later_on_fast():
    assert F.dense_first("fast") == F.FAST_FIRST_STAGE
    assert F.dense_first("standard") == "openmvs"


def test_stage_windows_map_onto_odm_percent():
    assert F.stage_window("dataset", "opensfm") == (0.0, 25.0)
    assert F.stage_window("openmvs", "odm_filterpoints") == (25.0, 52.0)
    assert F.stage_after("odm_postprocess") is None
    with pytest.raises(ValueError):
        F.stage_index("split")
```

- [ ] **Step 2: Run to see it fail**

Run: `uv run --frozen pytest tests/test_odm_flags.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'aio_pipelines.photo.odm'`.

- [ ] **Step 3: Implement** (`photo/odm/flags.py`)

```python
"""ODM's stages, its progress percent per stage, and the flags of each job (pure; ADR 0012).

The stage table and the progress percents are ODM 3.6.2's (``stages/odm_app.py``), measured by
``tools/odm/probe.mjs``. ``split`` and ``merge`` (split-merge of very large sets) are not used.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

STAGES: tuple[str, ...] = (
    "dataset", "opensfm", "openmvs", "odm_filterpoints", "odm_meshing", "mvs_texturing",
    "odm_georeferencing", "odm_dem", "odm_orthophoto", "odm_report", "odm_postprocess",
)  # fmt: skip
#: ODM's progress (percent) when each stage has finished (C6).
STAGE_END: dict[str, float] = {
    "dataset": 5.0, "opensfm": 25.0, "openmvs": 50.0, "odm_filterpoints": 52.0, "odm_meshing": 60.0,
    "mvs_texturing": 70.0, "odm_georeferencing": 80.0, "odm_dem": 90.0, "odm_orthophoto": 98.0,
    "odm_report": 99.0, "odm_postprocess": 100.0,
}  # fmt: skip
PRESET_FLAGS: dict[str, tuple[str, ...]] = {
    "fast": ("--fast-orthophoto", "--skip-3dmodel", "--pc-quality", "low", "--feature-quality", "medium"),
    "standard": ("--pc-quality", "medium", "--feature-quality", "high"),
    "high": ("--pc-quality", "high", "--feature-quality", "ultra"),
}
MESH_PRODUCTS = frozenset({"mesh", "tiles"})
#: How photo.georef reruns alignment with ground control (C12): "rerun-from" or "invalidate".
GEOREF_STRATEGY = "invalidate"
#: Where Fast's dense step starts after an alignment run (C13).
FAST_FIRST_STAGE = "odm_filterpoints"
GB = 1024**3


def stage_index(stage: str) -> int:
    try:
        return STAGES.index(stage)
    except ValueError:
        raise ValueError(f"{stage} is not an ODM stage this build runs") from None


def stage_start(stage: str) -> float:
    i = stage_index(stage)
    return 0.0 if i == 0 else STAGE_END[STAGES[i - 1]]


def stage_window(first: str, last: str) -> tuple[float, float]:
    return stage_start(first), STAGE_END[last]


def stage_after(stage: str) -> str | None:
    i = stage_index(stage)
    return STAGES[i + 1] if i + 1 < len(STAGES) else None


def odm_threads(logical_cpus: int, ram_bytes: int, cap_bytes: int | None) -> int:
    """``clamp(min(CPUs - 2, floor(RAM GB / 3)), 2, 32)``; a memory limit set by hand lowers it
    (``cap_bytes``: ``runner.odm_memory_cap()``, never the automatic photo memory cap)."""
    n = min(logical_cpus - 2, math.floor(ram_bytes / GB / 3))
    if cap_bytes:
        n = min(n, math.floor(cap_bytes / GB / 3))
    return max(2, min(32, n))


def gpu_wanted(setting: str, nvcuda_present: bool) -> bool:
    return setting != "off" and nvcuda_present


def gpu_flags(use_gpu: bool) -> list[str]:
    return ["--feature-type", "sift"] if use_gpu else ["--no-gpu"]


def _common(preset: str, use_gpu: bool, threads: int) -> list[str]:
    return [*PRESET_FLAGS[preset], *gpu_flags(use_gpu), "--max-concurrency", str(threads)]


def align_flags(preset: str, use_gpu: bool, threads: int, geo: Path | None) -> list[str]:
    return [*_common(preset, use_gpu, threads), *(["--geo", str(geo)] if geo else [])]


def georef_flags(preset: str, use_gpu: bool, threads: int, gcp: Path, geo: Path | None) -> list[str]:
    return [*align_flags(preset, use_gpu, threads, geo), "--gcp", str(gcp)]


def _num(v: float) -> str:
    return f"{v:g}"


def products_flags(
    preset: str,
    products: set[str],
    use_gpu: bool,
    threads: int,
    ortho_res_cm: float,
    dem_res_cm: float,
    mesh_size: int | None,
    boundary: Path | None,
) -> list[str]:
    out = [
        *_common(preset, use_gpu, threads),
        "--dsm", "--dtm", "--cog", "--pc-copc", "--build-overviews",
        "--orthophoto-resolution", _num(ortho_res_cm), "--dem-resolution", _num(dem_res_cm),
    ]  # fmt: skip
    if not products & MESH_PRODUCTS and "--skip-3dmodel" not in out:
        out.append("--skip-3dmodel")
    if mesh_size:
        out += ["--mesh-size", str(mesh_size)]
    if boundary:
        out += ["--boundary", str(boundary)]
    return out


@dataclass(frozen=True)
class OdmStep:
    name: str
    title: str
    first: str
    last: str
    weight: float


def dense_first(preset: str) -> str:
    return FAST_FIRST_STAGE if preset == "fast" else "openmvs"


def product_steps(products: set[str]) -> list[OdmStep]:
    """The ODM calls of photo.products, one per job step, covering openmvs to the end. ``dense``
    starts at ``dense_first(preset)`` at run time (Fast skips openmvs)."""
    steps = [OdmStep("dense", "Dense point cloud", "openmvs", "odm_filterpoints", 10.0)]
    if products & MESH_PRODUCTS:
        steps += [
            OdmStep("mesh", "3D mesh", "odm_meshing", "odm_meshing", 3.0),
            OdmStep("texture", "Texture the mesh", "mvs_texturing", "mvs_texturing", 3.0),
            OdmStep("cloud", "Georeference the point cloud", "odm_georeferencing", "odm_georeferencing", 1.0),
        ]
    else:
        steps.append(OdmStep("cloud", "Surface and point cloud", "odm_meshing", "odm_georeferencing", 4.0))
    steps += [
        OdmStep("dsm", "Elevation models (DSM and DTM)", "odm_dem", "odm_dem", 2.0),
        OdmStep("ortho", "Orthophoto and report", "odm_orthophoto", "odm_postprocess", 3.0),
    ]
    return steps
```

- [ ] **Step 4: Run the tests**

Run: `uv run --frozen pytest tests/test_odm_flags.py -q`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

```bash
git add python/src/aio_pipelines/photo/odm/__init__.py python/src/aio_pipelines/photo/odm/flags.py python/tests/test_odm_flags.py
git commit -m "feat(pipelines): odm stages, preset flags and threads" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Fake ODM and ODM fixtures (tests only)

A stand-in for ODM that behaves like it where our code can tell: the same command line, ODM's folder layout with small but valid outputs, stage lines on stdout, UDP progress, rerun rules, GPU log lines, chosen failures and a hang. Plus `odm_synth.py`, which writes an already aligned ODM project from known truth, and the change to `products_synth.write_project` so every synthetic aligned project (Python tests and the e2e fixtures) carries one.

**Files:**

- Create: `python/tests/fake_odm/run.bat`, `python/tests/fake_odm/run.sh`, `python/tests/fake_odm/VERSION`, `python/tests/fake_odm/fake_odm.py`, `python/tests/odm_synth.py`, `python/tests/test_fake_odm.py`
- Modify: `python/tests/products_synth.py` (`write_project`, line 305: also write the ODM folder), `python/tests/two_surveys_synth.py` (only if it writes runs without `products_synth.write_project`; check and pass the same scene points)

**Interfaces:**

- Consumes: `aio_pipelines.photo.crs` (`EnuFrame`, `utm_epsg`, `geodetic_to_crs`), `aio_pipelines.photo.model` (`SparseModel`, `rotmat_to_qvec`), PIL, numpy, scipy, rasterio (all in the dev venv).
- Produces:
  - `python/tests/fake_odm/` is an ODM folder: `AIO_ODM=<that folder>` and `FAKE_ODM_PYTHON=<a Python with aio_pipelines>` make it run. `run.bat` is exactly:

    ```bat
    @echo off
    "%FAKE_ODM_PYTHON%" "%~dp0fake_odm.py" %*
    exit /b %ERRORLEVEL%
    ```

    `run.sh` is `#!/bin/sh` then `exec "$FAKE_ODM_PYTHON" "$(dirname "$0")/fake_odm.py" "$@"`. `VERSION` holds `3.6.2`.

  - Fake controls (environment): `FAKE_ODM_FAIL=<stage>:<exit code>` (exits at that stage's start after printing `[ERROR] fake failure in <stage>`), `FAKE_ODM_HANG=<stage>` (starts a child `python -c "import time; time.sleep(3600)"`, writes both PIDs to `$FAKE_ODM_PIDS` one per line, then sleeps), `FAKE_ODM_UDP_PORT` (default 6367; `0` sends nothing; a send that fails is ignored), `FAKE_ODM_STAGE_S` (seconds per stage, default 0), `FAKE_ODM_GPU` (`ok` default: the features line only, as real ODM 3.6.2 on Windows; `dense-cuda` also prints `CUDA device 0 initialized: Fake GPU` in openmvs; `features-fallback`; `dense-fallback`; comma-separated), `FAKE_ODM_ARGS_LOG` (appends `json.dumps(sys.argv[1:])` and a newline per call).
  - `odm_synth.write_odm_folder(run_dir: Path, model_enu: SparseModel, enu: C.EnuFrame, photos: dict[str, Path], bias_enu: tuple[float, float, float] = (0.0, 0.0, 0.0)) -> Path`: writes `run_dir/odm/` as ODM leaves it after `--end-with opensfm`: `images/` (copies), `names.json` (`{link: photo key}`, links `f"{i:05d}{suffix.lower()}"` over the keys sorted), `opensfm/reconstruction.topocentric.json` and `reconstruction.json` (the model shifted by `bias_enu`), `opensfm/reference_lla.json`, `opensfm/stats/stats.json` (`{"reconstruction_statistics": {"reprojection_error_pixels": 0.5, "average_track_length": 3.0}}`), `odm_georeferencing/coords.txt`, `.fake/truth.json` (the unshifted model, used by the fake when `--gcp` is given) and the markers `.fake/dataset.done`, `.fake/opensfm.done`. Returns the ODM folder.
  - `odm_synth.opensfm_from_model(model_enu: SparseModel, enu: C.EnuFrame, links: dict[str, str]) -> tuple[list[dict], dict]`: (reconstruction list, reference_lla), the inverse of Task 6's reader, written independently from OpenSfM's documented conventions (below).

OpenSfM conventions the fake and `odm_synth` write (and Task 6 reads):

- `reconstruction.json` is a list of reconstructions `{"cameras": {id: cam}, "shots": {image: shot}, "points": {track_id: {"coordinates": [x, y, z], "color": [r, g, b]}}}` in the topocentric frame of `reference_lla.json` (`{"latitude", "longitude", "altitude"}`; east, north, up).
- A shot is `{"camera": id, "rotation": [rx, ry, rz], "translation": [tx, ty, tz], "gps_position": [...]}`: world to camera, `x_cam = R(rotation) @ X + t`, `R` from the axis-angle vector (Rodrigues); the camera looks along +z, image x right, y down.
- Cameras: `perspective` (`focal`, `k1`, `k2`), `brown` (`focal_x`, `focal_y`, `c_x`, `c_y`, `k1`, `k2`, `p1`, `p2`, `k3`), `radial` (`focal_x`, `focal_y`, `c_x`, `c_y`, `k1`, `k2`), `simple_radial` (`focal_x`, `focal_y`, `c_x`, `c_y`, `k1`); all with `projection_type`, `width`, `height`. Lengths are normalised by `s = max(width, height)`; a pixel `u` (top-left corner of the image at 0) is `x = (u - width / 2) / s`.
- No `tracks.csv`: real ODM's is binary (C10) and nothing reads it.

- [ ] **Step 1: Write the failing tests** (`python/tests/test_fake_odm.py`)

```python
import json
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import pytest
import rasterio

import products_synth as ps

FAKE = Path(__file__).parent / "fake_odm"


def _run(project_dir: Path, *flags: str, env: dict | None = None) -> subprocess.CompletedProcess:
    e = {**os.environ, "FAKE_ODM_PYTHON": sys.executable, **(env or {})}
    return subprocess.run(
        [sys.executable, str(FAKE / "fake_odm.py"), *flags, "--project-path", str(project_dir.parent), project_dir.name],
        env=e, capture_output=True, text=True, timeout=300,
    )  # fmt: skip


@pytest.fixture(scope="module")
def aligned(tmp_path_factory) -> Path:
    root = tmp_path_factory.mktemp("fake-odm")
    ps.write_project(root, ps.make_scene(step=0.2))
    return root / "photogrammetry" / ps.RUN / "odm"


def test_the_synthetic_project_carries_an_aligned_odm_folder(aligned):
    assert (aligned / "opensfm" / "reconstruction.topocentric.json").is_file()
    stats = json.loads((aligned / "opensfm" / "stats" / "stats.json").read_text())
    assert stats["reconstruction_statistics"]["reprojection_error_pixels"] > 0
    names = json.loads((aligned / "names.json").read_text())
    assert sorted(names) == sorted(p.name for p in (aligned / "images").iterdir())


def test_products_write_odms_layout(aligned, tmp_path):
    log = tmp_path / "args.jsonl"
    r = _run(aligned, "--pc-quality", "low", "--dsm", "--dtm", "--rerun-from", "openmvs",
             "--orthophoto-resolution", "20", "--dem-resolution", "40", env={"FAKE_ODM_ARGS_LOG": str(log)})  # fmt: skip
    assert r.returncode == 0, r.stdout + r.stderr
    assert "Finished odm_postprocess stage" in r.stdout
    assert "Running opensfm stage" in r.stdout  # skipped work still names its stage, like ODM
    for rel in ("odm_orthophoto/odm_orthophoto.tif", "odm_dem/dsm.tif", "odm_dem/dtm.tif",
                "odm_georeferencing/odm_georeferenced_model.las", "odm_georeferencing/coords.txt",
                "odm_texturing/odm_textured_model_geo.obj", "odm_report/report.pdf", "odm_report/stats.json"):  # fmt: skip
        assert (aligned / rel).is_file(), rel
    with rasterio.open(aligned / "odm_dem" / "dsm.tif") as ds:
        assert ds.crs.to_epsg() == ps.EPSG and abs(ds.res[0] - 0.4) < 1e-9
        z = ds.read(1, masked=True)
        assert z.count() > 0 and np.isfinite(z.compressed()).all()
    assert json.loads(log.read_text().splitlines()[0])[:2] == ["--pc-quality", "low"]


def test_end_with_stops_and_rerun_from_forces(aligned):
    r = _run(aligned, "--rerun-from", "openmvs", "--end-with", "odm_filterpoints")
    assert "Finished odm_filterpoints stage" in r.stdout and "odm_meshing" not in r.stdout


def test_fail_and_hang_on_request(aligned, tmp_path):
    r = _run(aligned, "--rerun-from", "openmvs", env={"FAKE_ODM_FAIL": "odm_meshing:137"})
    assert r.returncode == 137 and "Finished odm_filterpoints stage" in r.stdout
    pids = tmp_path / "pids"
    p = subprocess.Popen(
        [sys.executable, str(FAKE / "fake_odm.py"), "--rerun-from", "openmvs", "--project-path", str(aligned.parent), aligned.name],
        env={**os.environ, "FAKE_ODM_PYTHON": sys.executable, "FAKE_ODM_HANG": "openmvs", "FAKE_ODM_PIDS": str(pids)},
        stdout=subprocess.DEVNULL,
    )  # fmt: skip
    try:
        for _ in range(100):
            if pids.exists() and len(pids.read_text().split()) == 2:
                break
            time.sleep(0.1)
        assert len(pids.read_text().split()) == 2
    finally:
        p.kill()
        for pid in map(int, pids.read_text().split()) if pids.exists() else []:
            try:
                os.kill(pid, signal.SIGTERM)  # the fake and its sleeping child (TerminateProcess on Windows)
            except OSError:
                pass


def test_gpu_lines_and_udp(aligned):
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.bind(("127.0.0.1", 0))
        s.settimeout(5)
        port = s.getsockname()[1]
        r = _run(aligned, "--feature-type", "sift", "--rerun-from", "opensfm", "--end-with", "openmvs",
                 env={"FAKE_ODM_UDP_PORT": str(port), "FAKE_ODM_GPU": "dense-cuda"})  # fmt: skip
        got = s.recvfrom(256)[0].decode()
    assert "Using GPU for extracting SIFT features" in r.stdout
    assert "CUDA device 0 initialized" in r.stdout
    assert got.startswith("PGUP/") and got.split("/")[2] == aligned.name
    r = _run(aligned, "--feature-type", "sift", "--rerun-from", "opensfm", "--end-with", "openmvs",
             env={"FAKE_ODM_GPU": "features-fallback,dense-fallback"})  # fmt: skip
    assert "GPU SIFT extraction failed" in r.stdout and "OpenMVS failed with GPU" in r.stdout


def test_gcp_gives_the_truth_and_no_gcp_the_bias(tmp_path):
    root = tmp_path / "p"
    ps.write_project(root, ps.make_scene(step=0.2), odm_bias=(0.0, 0.0, 2.0))
    odm = root / "photogrammetry" / ps.RUN / "odm"
    truth = json.loads((odm / ".fake" / "truth.json").read_text())
    rec = json.loads((odm / "opensfm" / "reconstruction.topocentric.json").read_text())[0]
    shot = next(iter(truth["shots"]))
    assert rec["shots"][shot]["translation"] != truth["shots"][shot]["translation"]
    (odm / "gcp_list.txt").write_text("EPSG:4326\n")
    _run(odm, "--gcp", str(odm / "gcp_list.txt"), "--rerun-from", "opensfm", "--end-with", "opensfm")
    rec = json.loads((odm / "opensfm" / "reconstruction.topocentric.json").read_text())[0]
    assert rec["shots"][shot]["translation"] == pytest.approx(truth["shots"][shot]["translation"])
```

- [ ] **Step 2: Run to see it fail**

Run: `uv run --frozen pytest tests/test_fake_odm.py -q`
Expected: FAIL (`ModuleNotFoundError: No module named 'odm_synth'`).

- [ ] **Step 3: Write `odm_synth.py`.** `opensfm_from_model` converts each camera of the model (`PINHOLE`, `SIMPLE_PINHOLE`, `SIMPLE_RADIAL`, `RADIAL`, and `OPENCV`, which `products_synth.make_scene` uses, with its `p1`, `p2` kept) to `brown` with `focal_x = fx / s`, `focal_y = fy / s`, `c_x = (cx - w / 2) / s`, `c_y = (cy - h / 2) / s` and its radial terms (`k1`, `k2`; zero otherwise), each image to a shot (`rotation` = axis-angle of `R` from `scipy.spatial.transform.Rotation.from_matrix(R).as_rotvec()`, `translation` = `t`), and each point to `points[str(id)]`. `write_odm_folder` applies `bias_enu` by moving every camera centre and point by it (rotations unchanged), writes the files listed under Interfaces (`.fake/truth.json` is one reconstruction dict, `{"cameras", "shots", "points"}` as below, plus a `"bias": [e, n, u]` key; not a list, not an npz), and `coords.txt` as `WGS84 UTM <zone><N|S>` then `<offset x> <offset y>` (the floor of the smallest UTM easting and northing of the points). In `products_synth.write_project`, add `odm_bias: tuple[float, float, float] = (0.0, 0.0, 0.0)` and, after `sparse/` is written, call `odm_synth.write_odm_folder(run_dir, enu_model, enu, photos_by_key, odm_bias)` where `enu_model` is the run's model in its ENU frame (`align.grid_to_enu_model`) with its points replaced by `sparse_points(scene, n=20_000)` in the same frame (dense enough for the fake DSM), and `photos_by_key` maps each photo key to its file in `photos_dir`.

- [ ] **Step 4: Write `fake_odm.py`.** Structure (all of it in this one file; it may import `aio_pipelines.photo.crs` for frames):

```python
"""A stand-in for ODM 3.6.2's run.bat in tests (never shipped): see Task 3 of the ODM plan."""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

STAGES = ("dataset", "opensfm", "openmvs", "odm_filterpoints", "odm_meshing", "mvs_texturing",
          "odm_georeferencing", "odm_dem", "odm_orthophoto", "odm_report", "odm_postprocess")  # fmt: skip
END = {"dataset": 5, "opensfm": 25, "openmvs": 50, "odm_filterpoints": 52, "odm_meshing": 60,
       "mvs_texturing": 70, "odm_georeferencing": 80, "odm_dem": 90, "odm_orthophoto": 98,
       "odm_report": 99, "odm_postprocess": 100}  # fmt: skip


def parse(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("name")
    p.add_argument("--project-path", required=True)
    p.add_argument("--end-with", default="odm_postprocess")
    p.add_argument("--rerun-from")
    p.add_argument("--gcp")
    p.add_argument("--geo")
    p.add_argument("--feature-type", default="dspsift")
    p.add_argument("--no-gpu", action="store_true")
    p.add_argument("--fast-orthophoto", action="store_true")
    p.add_argument("--skip-3dmodel", action="store_true")
    p.add_argument("--orthophoto-resolution", type=float, default=5.0)
    p.add_argument("--dem-resolution", type=float, default=5.0)
    args, _ = p.parse_known_args(argv)  # every other ODM flag is accepted and ignored
    return args


def udp(name: str, pct: float) -> None:
    port = int(os.environ.get("FAKE_ODM_UDP_PORT", "6367"))
    if not port:
        return
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        try:
            s.sendto(f"PGUP/{os.getpid()}/{name}/{pct}".encode(), ("127.0.0.1", port))
        except OSError:
            pass


def main(argv: list[str]) -> int:
    if os.environ.get("FAKE_ODM_ARGS_LOG"):
        with open(os.environ["FAKE_ODM_ARGS_LOG"], "a", encoding="utf-8") as f:
            f.write(json.dumps(argv) + "\n")
    a = parse(argv)
    project = Path(a.project_path) / a.name
    fake = project / ".fake"
    fake.mkdir(parents=True, exist_ok=True)
    fail = os.environ.get("FAKE_ODM_FAIL", "")
    hang = os.environ.get("FAKE_ODM_HANG", "")
    gpu_bad = os.environ.get("FAKE_ODM_GPU", "ok")
    for stage in STAGES[: STAGES.index(a.end_with) + 1]:
        forced = a.rerun_from is not None and STAGES.index(stage) >= STAGES.index(a.rerun_from)
        print(f"[INFO]    Running {stage} stage", flush=True)
        if fail.startswith(f"{stage}:"):
            print(f"[ERROR]   fake failure in {stage}", flush=True)
            return int(fail.split(":")[1])
        if hang == stage:
            child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(3600)"])
            Path(os.environ["FAKE_ODM_PIDS"]).write_text(f"{os.getpid()}\n{child.pid}\n")
            time.sleep(3600)
        if forced or not (fake / f"{stage}.done").exists():
            half = float(os.environ.get("FAKE_ODM_STAGE_S", "0")) / 2
            time.sleep(half)  # the Running line is read before the midpoint datagram arrives
            STAGE_FNS[stage](project, a, gpu_bad)
            udp(a.name, (END[stage] + (END[STAGES[STAGES.index(stage) - 1]] if stage != "dataset" else 0)) / 2)
            time.sleep(half)  # and the midpoint holds long enough to be seen
            (fake / f"{stage}.done").write_text("")
        udp(a.name, END[stage])
        print(f"[INFO]    Finished {stage} stage", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
```

`STAGE_FNS` maps each stage to a function writing that stage's outputs:

- `dataset`: nothing beyond the marker.
- `opensfm`: when `--feature-type sift` and not `--no-gpu`, print `Using GPU for extracting SIFT features` (or `GPU SIFT extraction failed, fallback to CPU` when `FAKE_ODM_GPU` contains `features-fallback`). With `.fake/truth.json`: write `reconstruction.topocentric.json` and `reconstruction.json` from the truth when `--gcp` is given, else from the truth moved by its `bias`; keep `reference_lla.json`; write `opensfm/stats/stats.json` as `odm_synth` does. A stage runs again, marker or not, when its main output is missing (opensfm: `opensfm/reconstruction.json`), as ODM does after an invalidation. Without a truth file: place each image of `images/` straight down (`R = [[1,0,0],[0,-1,0],[0,0,-1]]`) at its GPS position (from `--geo` when given, else EXIF GPS through PIL), reference at the mean position, a `perspective` camera with `focal` 0.85, a 10 x 10 grid of points 40 m below the mean camera height; an image with neither a `--geo` row nor EXIF GPS is left out of the reconstruction (ODM cannot place it either); write `coords.txt`.
- `openmvs`: unless `--fast-orthophoto`: write `openmvs/scene_dense.mvs` (a few bytes) and, when the GPU is on, print `CUDA device 0 initialized: Fake GPU` only with `dense-cuda` (real 3.6.2 prints nothing), or `OpenMVS failed with GPU, Falling back to CPU` with `dense-fallback`.
- `odm_filterpoints`, `odm_meshing`: marker only.
- `mvs_texturing`: an OBJ of two triangles over the points' extent at their median height, in UTM minus the `coords.txt` offset, with `odm_textured_model_geo.mtl` (`newmtl material0000`, `map_Kd odm_textured_model_geo_material0000_map_Kd.png`) and a 64 x 64 PNG; into `odm_texturing_25d/` when `--skip-3dmodel` or `--fast-orthophoto`, else `odm_texturing/`.
- `odm_georeferencing`: `odm_georeferenced_model.las` (LAS 1.2, point format 2, scale 0.001, the points in UTM with their colours; write the 227-byte header and records with `struct`).
- `odm_dem`: `odm_dem/dsm.tif` and `dtm.tif` (float32, nodata -9999, in the UTM zone of the reference, `--dem-resolution` cm per pixel) by `scipy.interpolate.griddata(..., method="linear")` over the points' UTM positions; DTM equal to the DSM.
- `odm_orthophoto`: `odm_orthophoto/odm_orthophoto.tif` (RGBA uint8, `--orthophoto-resolution` cm, colours by nearest point, alpha 255 inside the points' hull).
- `odm_report`: `report.pdf` (`%PDF-1.4` and one comment line) and `stats.json` (`{"reconstruction_statistics": {"reprojection_error_pixels": 0.8}, "gcp_errors": []}`).
- `odm_postprocess`: `log.json` (`{"success": true}`).

- [ ] **Step 5: Run the tests**

Run: `uv run --frozen pytest tests/test_fake_odm.py -q`
Expected: PASS.

- [ ] **Step 6: Lint and commit**

```bash
git add python/tests/fake_odm python/tests/odm_synth.py python/tests/test_fake_odm.py python/tests/products_synth.py python/tests/two_surveys_synth.py
git commit -m "test(pipelines): fake odm and synthetic odm projects" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: ODM runner

**Files:**

- Create: `python/src/aio_pipelines/photo/odm/runner.py`, `python/tests/test_odm_runner.py`
- Modify: `python/tests/fake_odm/fake_odm.py` (two additions, see the end of Step 3)

**Interfaces:**

- Consumes: Task 1 `native.run_tool(..., fail=...)` with a `str` command, `native.ToolMemoryExceeded`, `native.total_memory()` (not `native.memory_cap()`: see the amendment); Task 2 `flags.STAGE_END`, `stage_start`, `stage_window`, `stage_after`, `stage_index`, `odm_threads`, `gpu_wanted`; Task 3 fake ODM and `products_synth.write_project` for tests.
- Founder amendment (14 Oct, overrides any code below): ODM's thread cap and its memory kill limit come only from `odm_memory_cap() -> int | None`, which reads `AIO_ODM_MEMORY_CAP_MB` (set by the app only when the person set a memory limit by hand); never from `native.memory_cap()` / `AIO_PHOTO_MEMORY_MB`. Test: with `AIO_PHOTO_MEMORY_MB=49152` and no `AIO_ODM_MEMORY_CAP_MB`, a 24-thread 64 GB machine gets `--max-concurrency 21` and no memory limit; with `AIO_ODM_MEMORY_CAP_MB=49152` it gets 16 and a 48 GB limit.
- Produces (`aio_pipelines.photo.odm.runner`):
  - `OWNED_ENV = "AIO_ODM_OWNED"` (set to `1` by the app only for the ODM it installed), `STUB = Path("SuperBuild/install/bin/nvcuda.dll")`, `PARKED = Path("SuperBuild/install/bin/nvcuda.dll.odm-stub")`, `STUB_MAX_BYTES = 100_000`; `ensure_dense_gpu(odm: OdmInstall, use_gpu: bool, env: Mapping[str, str] | None = None) -> bool`: with `env[OWNED_ENV] == "1"`, `use_gpu` and `nvcuda_present(env)`, renames `STUB` (only if smaller than `STUB_MAX_BYTES`) to `PARKED`; otherwise (and only when owned) renames `PARKED` back to `STUB` if `STUB` is absent; never deletes; logs nothing itself; returns whether dense matching can use the GPU (`PARKED` exists, `STUB` does not, owned, `use_gpu`, driver present). `run_odm` calls it before every start and passes the result to `gpu_use`.
  - `GROUND_FAIL = re.compile(r"Cannot determine reader|Error creating classified file")`, `class OdmGroundFailed(JobError)`, `DTM_MARK = "odm_georeferencing/.aio-dtm"`; `dtm_cloud_ok(project_dir: Path) -> bool` (the mark exists and holds the current `mtime_ns` of `odm_georeferencing/odm_georeferenced_model.laz`).
  - `STALL_ENV = "AIO_ODM_STALL_MIN"`, `stall_seconds(env=None) -> float` (minutes from `AIO_ODM_STALL_MIN`, default 30, times 60), `class OdmStalled(JobError)`, `DENSE_CPU_NOTE` (message).
  - `odm_memory_cap() -> int | None` (bytes, from `AIO_ODM_MEMORY_CAP_MB`), `ODM_ENV = "AIO_ODM"`, `VERSION_ENV = "AIO_ODM_VERSION"`, `GPU_ENV = "AIO_ODM_GPU"`, `WORK_ENV = "AIO_ODM_WORK"`, `UDP_PORT = 6367`, `NO_ODM` (message).
  - `@dataclass(frozen=True) class OdmInstall: dir: Path; version: str`; `find_odm(env: Mapping[str, str] | None = None) -> OdmInstall` (raises `JobError(NO_ODM)`).
  - `@dataclass(frozen=True) class Machine: threads: int; use_gpu: bool`; `machine(env: Mapping[str, str] | None = None) -> Machine`; `nvcuda_present(env: Mapping[str, str] | None = None) -> bool` (a module-level function that `machine` looks up at call time, so tests can patch it).
  - `@dataclass class GpuUse: features: bool | None; dense: bool | None; fallbacks: list[str]` with `summary() -> str` and `merge(other: GpuUse) -> GpuUse`; `gpu_use(text: str, requested: bool, window: tuple[str, str] = ("dataset", "odm_postprocess"), dense_capable: bool = False) -> GpuUse` (a stage outside `window` was skipped by ODM, so its absence of GPU lines says nothing; `dense_capable` is `ensure_dense_gpu`'s answer).
  - `engine_record(odm: OdmInstall, gpu: GpuUse) -> dict` (`{"name": "odm", "version": ..., "gpu": {"features"?: bool, "dense"?: bool}}`).
  - `@dataclass class OdmRun: log: Path; gpu: GpuUse; started_from: str | None`.
  - `run_odm(ctx: StepContext, odm: OdmInstall, project_dir: Path, flags: Sequence[str], first: str, last: str, log_dir: Path, *, rerun: bool, use_gpu: bool, progress: tuple[float, float] = (0.0, 1.0), port: int = UDP_PORT) -> OdmRun`.
  - Helpers also used in tests: `parse_datagram(data: bytes, project_name: str) -> float | None`, `class StageProgress(first: str, last: str)` with `feed_line(line: str) -> float | None`, `feed_udp(percent: float) -> float | None`, `.fraction`, `.message`; `finished_stages(text: str) -> list[str]`; `resume_from(text: str, first: str, last: str) -> str`; `exit_error(code: int, lines: list[str]) -> JobError`; `odm_env(base: Mapping[str, str], use_gpu: bool) -> dict[str, str]`; `odm_command(odm: OdmInstall, project_dir: Path, flags: Sequence[str]) -> str | list[str]`.

- [ ] **Step 1: Write the failing tests** (`python/tests/test_odm_runner.py`)

```python
import json
import socket
import sys
import threading
import time
from pathlib import Path

import pytest

import products_synth as ps
from aio_pipelines.photo import native
from aio_pipelines.photo.odm import runner as R
from aio_pipelines.runtime import Cancelled, JobError

FAKE = Path(__file__).parent / "fake_odm"


class Ctx:
    """The StepContext parts run_odm uses."""

    def __init__(self):
        self.cancel_event = threading.Event()
        self.bar: list[tuple[float, str | None]] = []
        self.logs: list[tuple[str, str]] = []

    def progress(self, f, m=None):
        self.bar.append((f, m))

    def log(self, m, level="info"):
        self.logs.append((m, level))

    def check(self):
        if self.cancel_event.is_set():
            raise Cancelled()


@pytest.fixture
def odm(monkeypatch):
    monkeypatch.setenv("FAKE_ODM_PYTHON", sys.executable)
    monkeypatch.setenv(R.ODM_ENV, str(FAKE))
    return R.find_odm()


@pytest.fixture
def aligned(tmp_path):
    ps.write_project(tmp_path / "p", ps.make_scene(step=0.2))
    return tmp_path / "p" / "photogrammetry" / ps.RUN / "odm"


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_find_odm_needs_the_folder(monkeypatch, tmp_path):
    monkeypatch.delenv(R.ODM_ENV, raising=False)
    with pytest.raises(JobError, match="Install it in Settings, Processing tools"):
        R.find_odm()
    monkeypatch.setenv(R.ODM_ENV, str(tmp_path))
    with pytest.raises(JobError):
        R.find_odm()
    monkeypatch.setenv(R.ODM_ENV, str(FAKE))
    monkeypatch.delenv(R.VERSION_ENV, raising=False)
    assert R.find_odm().version == "3.6.2"


def test_datagrams_for_another_project_are_ignored():
    assert R.parse_datagram(b"PGUP/123/odm/42.5", "odm") == 42.5
    assert R.parse_datagram(b"PGUP/123/other/42.5", "odm") is None
    assert R.parse_datagram(b"garbage", "odm") is None
    assert R.parse_datagram(b"PGUP/1/odm/400", "odm") is None


def test_stage_progress_maps_odm_percent_onto_the_step_and_never_steps_back():
    sp = R.StageProgress("openmvs", "odm_filterpoints")  # ODM 25..52
    assert sp.feed_line("[INFO]    Running openmvs stage") == 0.0
    assert sp.message == "Dense matching"
    assert sp.feed_udp(38.5) == pytest.approx(0.5)
    assert sp.feed_udp(75.0) is None  # not openmvs's range: the split stage's or another tool's
    assert sp.feed_udp(30.0) == pytest.approx(0.5)  # never back
    assert sp.feed_line("\x1b[32m[INFO]    Finished openmvs stage\x1b[0m") == pytest.approx(25 / 27)


def test_resume_starts_after_the_last_finished_stage():
    log = "Running openmvs stage\nFinished openmvs stage\nRunning odm_filterpoints stage\n"
    assert R.resume_from(log, "openmvs", "odm_georeferencing") == "odm_filterpoints"
    assert R.resume_from("", "openmvs", "odm_georeferencing") == "openmvs"
    assert R.resume_from("Finished opensfm stage\n", "openmvs", "odm_georeferencing") == "openmvs"
    assert R.resume_from("Finished odm_georeferencing stage\n", "openmvs", "odm_georeferencing") == "odm_georeferencing"


def test_gpu_use_from_the_log():
    ok = R.gpu_use("Using GPU for extracting SIFT features\nRunning openmvs stage\nCUDA device 0 initialized: X\n", True)
    cpu = R.gpu_use("Using GPU for extracting SIFT features\nRunning openmvs stage\n", True)
    assert (cpu.features, cpu.dense) == (True, False)  # ODM 3.6.2 on Windows: no CUDA line, dense on the CPU
    assert (ok.features, ok.dense, ok.fallbacks) == (True, True, [])
    bad = R.gpu_use("GPU SIFT extraction failed\nRunning openmvs stage\nOpenMVS failed with GPU\n", True)
    assert (bad.features, bad.dense) == (False, False) and len(bad.fallbacks) == 2
    off = R.gpu_use("Running opensfm stage\n", False)
    assert off.features is False and off.dense is None
    assert ok.summary() == "Graphics card used for features: yes; for dense matching: yes."


@pytest.mark.parametrize(
    ("code", "text"),
    [(137, "ran out of memory"), (3221226505, "ran out of memory"), (132, "processor is not supported"),
     (3, "reinstall the processing engine"), (1, "could not process these photos: last line"),
     (139, "could not process"), (99, "exit code 99")],
)  # fmt: skip
def test_exit_codes_become_plain_messages(code, text):
    assert text in str(R.exit_error(code, ["first", "last line"]))


def test_the_environment_is_odms_own():
    base = {"PATH": "x", "PYTHONPATH": "y", "PYTHONHOME": "z", "VIRTUAL_ENV": "v", "NoDefaultCurrentDirectoryInExePath": "1"}
    env = R.odm_env(base, use_gpu=False)
    assert env["ODM_NONINTERACTIVE"] == "1" and env["ODM_NO_GPU"] == "1" and env["PATH"] == "x"
    # run.bat calls winrun.bat by bare name: with this variable set, cmd does not find it and run.bat still exits 0
    assert not {"PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV", "NoDefaultCurrentDirectoryInExePath"} & set(env)
    assert "ODM_NO_GPU" not in R.odm_env({}, use_gpu=True)


def test_the_gpu_setting_from_the_environment(monkeypatch):
    monkeypatch.setenv(R.GPU_ENV, "off")
    assert R.machine().use_gpu is False


def test_threads_and_memory_limit_come_only_from_the_hand_set_cap(odm, aligned, tmp_path, monkeypatch):
    GB = 1024**3
    monkeypatch.setattr(R.os, "cpu_count", lambda: 24)
    monkeypatch.setattr(native, "total_memory", lambda: 64 * GB)
    monkeypatch.setenv("AIO_PHOTO_MEMORY_MB", "49152")  # the app's automatic 75 %: ignored by ODM
    monkeypatch.delenv("AIO_ODM_MEMORY_CAP_MB", raising=False)
    assert R.odm_memory_cap() is None and R.machine().threads == 21
    seen: dict[str, int] = {}
    real = native.run_tool

    def spy(*a, **kw):
        seen["limit"] = kw["memory_limit"]
        return real(*a, **kw)

    monkeypatch.setattr(native, "run_tool", spy)
    R.run_odm(Ctx(), odm, aligned, [], "openmvs", "odm_filterpoints", tmp_path / "a", rerun=True, use_gpu=False, port=_free_port())
    assert seen["limit"] == 0
    monkeypatch.setenv("AIO_ODM_MEMORY_CAP_MB", "49152")  # set by hand
    assert R.odm_memory_cap() == 48 * GB and R.machine().threads == 16
    R.run_odm(Ctx(), odm, aligned, [], "openmvs", "odm_filterpoints", tmp_path / "b", rerun=True, use_gpu=False, port=_free_port())
    assert seen["limit"] == 48 * GB


def test_align_runs_to_opensfm_with_progress_and_the_gpu_line(odm, aligned, tmp_path, monkeypatch):
    (aligned / ".fake" / "opensfm.done").unlink()  # a fresh alignment: the fake runs opensfm again
    log = tmp_path / "args.jsonl"
    monkeypatch.setenv("FAKE_ODM_ARGS_LOG", str(log))
    ctx = Ctx()
    run = R.run_odm(ctx, odm, aligned, ["--feature-type", "sift"], "dataset", "opensfm",
                    tmp_path / "logs", rerun=False, use_gpu=True, port=_free_port())  # fmt: skip
    args = json.loads(log.read_text().splitlines()[-1])
    assert "--rerun-from" not in args and args[args.index("--end-with") + 1] == "opensfm"
    assert run.gpu.features is True
    fractions = [f for f, _ in ctx.bar]
    assert fractions == sorted(fractions) and fractions[-1] == pytest.approx(1.0)
    assert ("Graphics card used for features: yes.", "info") in ctx.logs
    assert "Finished opensfm stage" in run.log.read_text()


def test_udp_refines_progress_and_stdout_takes_over_when_the_port_is_taken(odm, aligned, tmp_path, monkeypatch):
    port = _free_port()
    monkeypatch.setenv("FAKE_ODM_UDP_PORT", str(port))
    monkeypatch.setenv("FAKE_ODM_STAGE_S", "1.0")
    ctx = Ctx()
    R.run_odm(ctx, odm, aligned, [], "openmvs", "odm_filterpoints", tmp_path / "a", rerun=True, use_gpu=False, port=port)
    assert any(0.3 < f < 0.7 for f, _ in ctx.bar)  # openmvs's midpoint datagram: (25 + 50) / 2 in 25..52
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as busy:
        busy.bind(("127.0.0.1", port))
        ctx = Ctx()
        R.run_odm(ctx, odm, aligned, [], "openmvs", "odm_filterpoints", tmp_path / "b", rerun=True, use_gpu=False, port=port)
    assert ctx.bar[-1][0] == pytest.approx(1.0)


def test_a_stalled_odm_is_stopped_with_a_plain_message(odm, aligned, tmp_path, monkeypatch):
    pids = tmp_path / "pids"
    monkeypatch.setenv("FAKE_ODM_HANG", "odm_meshing")  # prints its stage line, then nothing
    monkeypatch.setenv("FAKE_ODM_PIDS", str(pids))
    monkeypatch.setenv(R.STALL_ENV, "0.05")  # three seconds
    with pytest.raises(JobError, match="ODM stopped making progress in the meshing stage"):
        R.run_odm(Ctx(), odm, aligned, [], "openmvs", "odm_georeferencing", tmp_path / "logs",
                  rerun=True, use_gpu=False, port=_free_port())  # fmt: skip
    from aio_pipelines.photo.proctree import process_started

    time.sleep(1.0)
    for pid in map(int, pids.read_text().split()):
        assert process_started(pid) is None, f"process {pid} survived the stall"


def test_dense_on_the_cpu_is_said_plainly(odm, aligned, tmp_path):
    ctx = Ctx()
    run = R.run_odm(ctx, odm, aligned, [], "openmvs", "odm_filterpoints", tmp_path / "l", rerun=True,
                    use_gpu=True, port=_free_port())  # fmt: skip
    assert run.gpu.dense is False  # the fake ODM folder has no parked stub
    assert (R.DENSE_CPU_NOTE, "info") in ctx.logs


def _install(tmp_path: Path, stub_bytes: int = 19_968) -> R.OdmInstall:
    bin_dir = tmp_path / "odm-3.6.2" / "SuperBuild" / "install" / "bin"
    bin_dir.mkdir(parents=True)
    (bin_dir / "nvcuda.dll").write_bytes(b"\0" * stub_bytes)
    return R.OdmInstall(tmp_path / "odm-3.6.2", "3.6.2")


def test_the_stub_is_parked_when_the_driver_is_there_and_back_when_off(tmp_path, monkeypatch):
    inst = _install(tmp_path)
    stub, parked = inst.dir / R.STUB, inst.dir / R.PARKED
    monkeypatch.setattr(R, "nvcuda_present", lambda env=None: True)
    owned = {R.OWNED_ENV: "1"}
    assert R.ensure_dense_gpu(inst, True, owned) is True
    assert not stub.exists() and parked.stat().st_size == 19_968  # renamed, never deleted
    assert R.ensure_dense_gpu(inst, True, owned) is True  # idempotent
    assert R.ensure_dense_gpu(inst, False, owned) is False  # GPU off: the stub goes back
    assert stub.exists() and not parked.exists()


def test_the_stub_stays_without_a_driver_or_outside_our_install(tmp_path, monkeypatch):
    inst = _install(tmp_path)
    monkeypatch.setattr(R, "nvcuda_present", lambda env=None: False)
    assert R.ensure_dense_gpu(inst, True, {R.OWNED_ENV: "1"}) is False
    assert (inst.dir / R.STUB).exists()  # without the real driver OpenMVS would not even start
    monkeypatch.setattr(R, "nvcuda_present", lambda env=None: True)
    assert R.ensure_dense_gpu(inst, True, {}) is False  # not the ODM the app installed (QUADRION_ODM_DIR)
    assert (inst.dir / R.STUB).exists()
    big = _install(tmp_path / "big", stub_bytes=2_000_000)
    assert R.ensure_dense_gpu(big, True, {R.OWNED_ENV: "1"}) is False  # a real driver someone copied: left alone
    assert (big.dir / R.STUB).exists()


def test_dense_counts_as_gpu_when_the_stub_is_parked():
    text = "Running openmvs stage\nFinished openmvs stage\n"
    assert R.gpu_use(text, True, ("openmvs", "odm_filterpoints"), dense_capable=True).dense is True
    assert R.gpu_use(text + "OpenMVS failed with GPU\n", True, ("openmvs", "odm_filterpoints"), dense_capable=True).dense is False
    assert R.gpu_use(text, True, ("openmvs", "odm_filterpoints"), dense_capable=False).dense is False


def test_a_dtm_is_never_added_from_odm_dem_on_a_cloud_made_without_it(odm, aligned, tmp_path, monkeypatch):
    log = tmp_path / "args.jsonl"
    monkeypatch.setenv("FAKE_ODM_ARGS_LOG", str(log))
    R.run_odm(Ctx(), odm, aligned, ["--dsm", "--dtm"], "odm_dem", "odm_dem", tmp_path / "a", rerun=True,
              use_gpu=False, port=_free_port())  # fmt: skip
    first = json.loads(log.read_text().splitlines()[-1])
    assert first[first.index("--rerun-from") + 1] == "odm_georeferencing"  # no mark: reclassify first
    assert R.dtm_cloud_ok(aligned)  # that run made the cloud with --dtm and left the mark
    R.run_odm(Ctx(), odm, aligned, ["--dsm", "--dtm"], "odm_dem", "odm_dem", tmp_path / "b", rerun=True,
              use_gpu=False, port=_free_port())  # fmt: skip
    second = json.loads(log.read_text().splitlines()[-1])
    assert second[second.index("--rerun-from") + 1] == "odm_dem"


def test_a_failed_ground_classification_stops_the_dtm_at_once(odm, aligned, tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_ODM_SAY", "odm_georeferencing:[WARNING] Error creating classified file x: PDAL: Cannot determine reader for input file: E:\\x\\Probe")
    with pytest.raises(JobError, match="could not find the ground"):
        R.run_odm(Ctx(), odm, aligned, ["--dsm", "--dtm"], "odm_georeferencing", "odm_dem", tmp_path / "g",
                  rerun=True, use_gpu=False, port=_free_port())  # fmt: skip


def test_cancel_kills_the_whole_odm_tree(odm, aligned, tmp_path, monkeypatch):
    pids = tmp_path / "pids"
    monkeypatch.setenv("FAKE_ODM_HANG", "odm_meshing")
    monkeypatch.setenv("FAKE_ODM_PIDS", str(pids))
    ctx = Ctx()

    def cancel_when_hanging():
        for _ in range(600):
            if pids.exists() and len(pids.read_text().split()) == 2:
                ctx.cancel_event.set()
                return
            time.sleep(0.1)

    threading.Thread(target=cancel_when_hanging, daemon=True).start()
    with pytest.raises(Cancelled):
        R.run_odm(ctx, odm, aligned, [], "openmvs", "odm_georeferencing", tmp_path / "logs",
                  rerun=True, use_gpu=False, port=_free_port())  # fmt: skip
    from aio_pipelines.photo.proctree import process_started

    time.sleep(1.0)
    for pid in map(int, pids.read_text().split()):
        assert process_started(pid) is None, f"process {pid} survived the cancel"


def test_products_resume_starts_after_the_last_finished_stage(odm, aligned, tmp_path, monkeypatch):
    args_log = tmp_path / "args.jsonl"
    monkeypatch.setenv("FAKE_ODM_ARGS_LOG", str(args_log))
    monkeypatch.setenv("FAKE_ODM_FAIL", "odm_meshing:1")
    logs = tmp_path / "logs"
    with pytest.raises(JobError, match="could not process these photos"):
        R.run_odm(Ctx(), odm, aligned, [], "openmvs", "odm_georeferencing", logs, rerun=True, use_gpu=False, port=_free_port())
    monkeypatch.delenv("FAKE_ODM_FAIL")
    run = R.run_odm(Ctx(), odm, aligned, [], "openmvs", "odm_georeferencing", logs, rerun=True, use_gpu=False, port=_free_port())
    first, second = (json.loads(x) for x in args_log.read_text().splitlines()[-2:])
    assert first[first.index("--rerun-from") + 1] == "openmvs"
    assert second[second.index("--rerun-from") + 1] == "odm_meshing"
    assert run.started_from == "odm_meshing"


def test_a_gpu_fallback_is_a_warning_not_a_failure(odm, aligned, tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_ODM_GPU", "features-fallback")
    ctx = Ctx()
    run = R.run_odm(ctx, odm, aligned, ["--feature-type", "sift"], "opensfm", "opensfm", tmp_path / "l",
                    rerun=True, use_gpu=True, port=_free_port())  # fmt: skip
    assert run.gpu.features is False
    assert any(level == "warn" and "CPU" in m for m, level in ctx.logs)


def test_engine_record():
    rec = R.engine_record(R.OdmInstall(FAKE, "3.6.2"), R.GpuUse(True, None, []))
    assert rec == {"name": "odm", "version": "3.6.2", "gpu": {"features": True}}
```

- [ ] **Step 2: Run to see it fail**

Run: `uv run --frozen pytest tests/test_odm_runner.py -q`
Expected: FAIL (`ImportError: cannot import name 'runner'`).

- [ ] **Step 3: Implement** (`photo/odm/runner.py`). The parts with behaviour that matters:

```python
"""Run ODM (``run.bat``) as a job step: progress, cancel, resume, plain errors (ADR 0012).

Progress: ODM prints ``Running <stage> stage`` and ``Finished <stage> stage``; it also sends
``PGUP/<pid>/<project>/<percent>`` datagrams to 127.0.0.1:6367 (what NodeODM listens to). A step
covers a window of ODM's stages; stage lines move the bar to each stage's start and end, and a
datagram inside the running stage's own range refines it. When the port is taken, stage lines alone
drive the bar. Cancel ends ODM's whole process tree (``native.run_tool``). Resume: each step keeps
ODM's output in ``<log_dir>/odm.log``; with ``rerun`` the next attempt starts ``--rerun-from`` the
stage after the last one finished (without it ODM's own rerun skips what is done).
"""

from __future__ import annotations

import os
import re
import socket
import subprocess
import threading
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path

from ...runtime import JobError, StepContext
from .. import native
from .flags import STAGE_END, STAGES, gpu_wanted, odm_threads, stage_after, stage_index, stage_start, stage_window

ODM_ENV, VERSION_ENV, GPU_ENV = "AIO_ODM", "AIO_ODM_VERSION", "AIO_ODM_GPU"
WORK_ENV = "AIO_ODM_WORK"  # the same name as project.WORK_ENV (Task 5); kept here so this module stands alone
MEMORY_CAP_ENV = "AIO_ODM_MEMORY_CAP_MB"  # set by the app only for a memory limit set by hand
UDP_PORT = 6367
NO_ODM = "The processing engine (ODM) is not installed. Install it in Settings, Processing tools."
OOM = "ODM ran out of memory; try the Fast preset or close other programs."
STAGE_LINE = re.compile(r"\b(Running|Finished) (\w+) stage\b")
ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
FEATURES_YES, FEATURES_NO = "Using GPU for extracting SIFT features", "GPU SIFT extraction failed"
DENSE_YES, DENSE_NO = re.compile(r"CUDA device \d+ initialized"), "OpenMVS failed with GPU"
STAGE_WORDS = {
    "dataset": "Reading the photos", "opensfm": "Aligning the photos", "openmvs": "Dense matching",
    "odm_filterpoints": "Filtering the point cloud", "odm_meshing": "Meshing", "mvs_texturing": "Texturing",
    "odm_georeferencing": "Georeferencing", "odm_dem": "Elevation models", "odm_orthophoto": "Orthophoto",
    "odm_report": "Report", "odm_postprocess": "Finishing",
}  # fmt: skip
EXIT = {
    137: OOM, 3221226505: OOM,
    132: "This computer's processor is not supported by ODM.",
    3: "ODM is missing a program; reinstall the processing engine in Settings, Processing tools.",
}  # fmt: skip
BAD_INPUT = {1, 134, 139, 3221225477}
STALL_ENV = "AIO_ODM_STALL_MIN"
DENSE_CPU_NOTE = "ODM ran dense matching on the CPU; on Windows it does not use the graphics card for this step."


class OdmStalled(JobError):
    """ODM printed nothing and sent no progress for ``stall_seconds()``: its tree is ended."""


def stall_seconds(env: Mapping[str, str] | None = None) -> float:
    env = os.environ if env is None else env
    try:
        minutes = float(env.get(STALL_ENV, "30"))
    except ValueError:
        minutes = 30.0
    return max(0.01, minutes) * 60.0


def exit_error(code: int, lines: list[str]) -> JobError:
    if code in EXIT:
        return JobError(EXIT[code])
    last = ANSI.sub("", lines[-1]).strip() if lines else ""
    if code in BAD_INPUT:
        return JobError(f"ODM could not process these photos: {last or f'exit code {code}'}")
    return JobError(f"ODM stopped with exit code {code}{f': {last}' if last else ''}")


def finished_stages(text: str) -> list[str]:
    return [m.group(2) for m in STAGE_LINE.finditer(ANSI.sub("", text)) if m.group(1) == "Finished"]


def resume_from(text: str, first: str, last: str) -> str:
    lo, hi = stage_index(first), stage_index(last)
    done = {s for s in finished_stages(text) if s in STAGE_END and lo <= stage_index(s) <= hi}
    if not done:
        return first
    after = stage_after(max(done, key=stage_index))
    return after if after is not None and stage_index(after) <= hi else last


def parse_datagram(data: bytes, project_name: str) -> float | None:
    parts = data.decode("utf-8", errors="replace").strip().split("/")
    if len(parts) < 4 or parts[0] != "PGUP" or "/".join(parts[2:-1]) != project_name:
        return None
    try:
        pct = float(parts[-1])
    except ValueError:
        return None
    return pct if 0.0 <= pct <= 100.0 else None
```

`StageProgress` keeps `lo, hi = stage_window(first, last)`, `stage`, `fraction` (`None` until the first stage line), `message` and `last_activity` (`time.monotonic()`, set at creation and by every line and every datagram, in range or not); `_set(pct)` maps `(pct - lo) / (hi - lo)` clamped to 0..1 and keeps the maximum. `feed_line` strips ANSI codes; `Running X` sets `stage = X`, `message = STAGE_WORDS[X]` and returns `_set(stage_start(X))`; `Finished X` returns `_set(STAGE_END[X])`; stages not in `STAGE_END` are ignored. `feed_udp(pct)` returns `None` unless `stage` is set and `stage_start(stage) <= pct <= STAGE_END[stage]`, else `_set(pct)`.

`UdpProgress(port, project_name, on_percent)` is a context manager: binds a `SOCK_DGRAM` socket to `("127.0.0.1", port)` (on Windows with `SO_EXCLUSIVEADDRUSE` first, so another listener cannot share it); on `OSError` sets `available = False` and does nothing else; otherwise reads in a daemon thread with a 0.2 s timeout until `__exit__`, passing each `parse_datagram` result that is not `None` to `on_percent`.

`gpu_use(text, requested, window, dense_capable)`: `features = True` if `FEATURES_YES` in text, `False` if `FEATURES_NO` in text (fallback message "The graphics card could not extract features; ODM used the CPU."), `False` if not `requested` and `opensfm` lies inside `window`, else `None`; `dense = True` if `DENSE_YES` matches, or if `dense_capable` and `requested` and `openmvs` lies inside `window` and `Running openmvs stage` is in the text and `DENSE_NO` is not (deviation 17: ODM never logs OpenMVS's CUDA line); `False` if `DENSE_NO` in text (fallback "The graphics card could not run dense matching; ODM used the CPU."), `False` if `openmvs` lies inside `window` and `Running openmvs stage` is in the text (C11: ODM 3.6.2 on Windows prints no dense line and runs this step on the CPU), else `None`. (ODM prints `Running <stage> stage` for the stages before `--rerun-from` too, and skips their work.) `summary()` joins the known parts: `"Graphics card used for features: yes; for dense matching: yes."` (only the parts that are not `None`; `"no"` for `False`). `merge` keeps, per field, `True` over `False` over `None`, and concatenates fallbacks.

`find_odm`: folder from `env[ODM_ENV]`; it must hold `run.bat` (Windows) or `run.sh` (other systems), else `JobError(NO_ODM)`; version from `env[VERSION_ENV]`, else the `VERSION` file, else `"unknown"`. `odm_memory_cap(env=None)`: `AIO_ODM_MEMORY_CAP_MB` in MB to bytes (at least 64 MB), `None` when unset or not a number. `machine(env)`: `threads = odm_threads(os.cpu_count() or 2, native.total_memory(), odm_memory_cap(env))`, `use_gpu = gpu_wanted(env.get(GPU_ENV, "auto"), nvcuda_present(env))`, where `nvcuda_present` is `os.name == "nt"` and `Path(env.get("SYSTEMROOT", r"C:\Windows")) / "System32" / "nvcuda.dll"` exists.

`odm_env(base, use_gpu)`: a copy of `base` without keys starting with `PYTHON`, `VIRTUAL_ENV`, `CONDA_PREFIX`, `CONDA_DEFAULT_ENV`, `NoDefaultCurrentDirectoryInExePath` (with it set, `run.bat` cannot find `winrun.bat` and still exits 0), plus `ODM_NONINTERACTIVE=1`, plus `ODM_NO_GPU=1` when not `use_gpu`.

`odm_command`: on Windows `inner = subprocess.list2cmdline([str(odm.dir / "run.bat"), *flags, "--project-path", str(project_dir.parent), project_dir.name])` and the string `f'"{os.environ.get("ComSpec", "cmd.exe")}" /d /s /c "{inner}"'`; elsewhere `["sh", str(odm.dir / "run.sh"), *flags, "--project-path", str(project_dir.parent), project_dir.name]`.

`run_odm`:

```python
def run_odm(ctx, odm, project_dir, flags, first, last, log_dir, *, rerun, use_gpu, progress=(0.0, 1.0), port=UDP_PORT):
    log_dir.mkdir(parents=True, exist_ok=True)
    log, last_out = log_dir / "odm.log", log_dir / "tool.out"
    if last_out.exists():  # an attempt that was cancelled or failed: its lines count for the resume
        with open(log, "ab") as f:
            f.write(last_out.read_bytes())
        last_out.unlink()
    earlier = log.read_text("utf-8", errors="replace") if log.exists() else ""
    start = resume_from(earlier, first, last) if rerun else None
    args = [*flags, *(["--rerun-from", start] if start else []), "--end-with", last]
    if start and "--dtm" in flags and stage_index(start) >= stage_index("odm_dem") and not dtm_cloud_ok(project_dir):
        # ODM would reuse a cloud without ground points and renderdem would never finish (14 Oct root cause)
        ctx.log("The point cloud was not classified for a terrain model; ODM starts again from georeferencing.")
        start = "odm_georeferencing"
        args = [*flags, "--rerun-from", start, "--end-with", last]
    if start and start != first:
        ctx.log(f"Resuming ODM from the {STAGE_WORDS.get(start, start).lower()} stage.")
    dense_capable = ensure_dense_gpu(odm, use_gpu)
    sp = StageProgress(first, last)
    lo, hi = progress

    stall = stall_seconds()

    class _Bar:  # run_tool's view of the context: ODM's stage words, ODM's own fraction, the watchdog
        cancel_event = ctx.cancel_event

        @staticmethod
        def progress(f, m=None):
            # run_tool calls this every 0.1 s; raising here ends ODM's whole tree (its BaseException path)
            if time.monotonic() - sp.last_activity > stall:
                words = (STAGE_WORDS.get(sp.stage or "", sp.stage or "current")).lower()
                raise OdmStalled(
                    f"ODM stopped making progress in the {words} stage: nothing for {stall / 60:g} minutes. "
                    "Start the job again, or try the Fast preset."
                )
            real = sp.fraction if sp.fraction is not None else 0.2 * f
            ctx.progress(lo + (hi - lo) * real, sp.message or m)

    def fail(code: int, lines: list[str]) -> JobError:
        for line in lines[-20:]:
            ctx.log(f"ODM: {ANSI.sub('', line)}", "warn")
        return exit_error(code, lines)

    def watch(line: str) -> float | None:
        # ODM swallows a failed SMRF ground classification and its DTM would then spin for ever
        if "--dtm" in flags and GROUND_FAIL.search(line):
            raise OdmGroundFailed(
                "ODM could not find the ground points, so it cannot make the terrain model (DTM). "
                "Look at the job log; untick DTM to make the other products."
            )
        return sp.feed_line(line)

    with UdpProgress(port, project_dir.name, sp.feed_udp) as udp:
        if not udp.available:
            ctx.log(f"Port {port} is in use; ODM's progress comes from its stage lines.")
        try:
            native.run_tool(
                _Bar, odm_command(odm, project_dir, args), "ODM", log_dir, expected_s=3600.0,
                progress=(0.0, 1.0), memory_limit=odm_memory_cap() or 0,
                env=odm_env(os.environ, use_gpu), on_output=watch, fail=fail,
            )  # fmt: skip
        except native.ToolMemoryExceeded:
            raise JobError(OOM) from None
    text = last_out.read_text("utf-8", errors="replace") if last_out.exists() else ""
    with open(log, "a", encoding="utf-8") as f:
        f.write(text)
    last_out.unlink(missing_ok=True)
    gpu = gpu_use(text, use_gpu, (first, last), dense_capable)
    if "--dtm" in flags and stage_index(start or first) <= stage_index("odm_georeferencing") <= stage_index(last):
        laz = project_dir / "odm_georeferencing" / "odm_georeferenced_model.laz"
        if laz.exists():  # this cloud was classified for a DTM: a later --rerun-from odm_dem may use it
            (project_dir / DTM_MARK).write_text(str(laz.stat().st_mtime_ns))
    if gpu.summary():
        ctx.log(gpu.summary())
    for msg in gpu.fallbacks:
        ctx.log(msg, "warn")
    if use_gpu and gpu.dense is False and not gpu.fallbacks:
        ctx.log(DENSE_CPU_NOTE)  # "ODM ran dense matching on the CPU; on Windows it does not use the graphics card for this step."
    ctx.progress(hi, sp.message)
    return OdmRun(log, gpu, start)
```

(`run_tool` keeps `tool.out` and `tool.err` in `log_dir`; a `Cancelled` or `JobError` leaves `tool.out` there for the next attempt. Raising from `watch` or from `_Bar.progress` ends ODM's whole tree through `run_tool`'s `BaseException` path.)

Callers pass the stage window they run: the products `dense` step passes `first=dense_first(preset)` (`odm_filterpoints` on Fast), so `StageProgress`'s window and the resume both start where Fast's ODM call starts.

Follow-ups owned here for Task 3's fake (already built): add `FAKE_ODM_SAY=<stage>:<line>` (prints that line during that stage, for the ground-failure test) and make the `odm_georeferencing` stage write `odm_georeferencing/odm_georeferenced_model.laz` (a copy of the `.las` bytes is enough) so `DTM_MARK` has a file to point at. These two lines in `python/tests/fake_odm/fake_odm.py` are this task's edit.

- [ ] **Step 4: Run the tests**

Run: `uv run --frozen pytest tests/test_odm_runner.py -q`
Expected: PASS. On Windows the cancel test checks with `process_started` that both PIDs are gone.

- [ ] **Step 5: Lint and commit**

```bash
git add python/src/aio_pipelines/photo/odm/runner.py python/tests/test_odm_runner.py python/tests/fake_odm/fake_odm.py
git commit -m "feat(pipelines): run odm with progress, cancel and resume" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The ODM project folder and the GCP list

**Files:**

- Create: `python/src/aio_pipelines/photo/odm/project.py`, `python/tests/test_odm_project.py`

**Interfaces:**

- Consumes: `photo.gcp` (`usable_marks`), `photo.crs` (`crs_of`), `runtime.JobError`, `runtime.atomic_write_json`.
- Produces (`aio_pipelines.photo.odm.project`):
  - `ODM_DIR = "odm"`, `SPACES_OK = True` (C5), `GEOREF_INVALIDATE: tuple[str, ...]`, `INTERMEDIATES: tuple[str, ...]`.
  - `odm_project_dir(project: Path, run: str) -> Path` (`project / "photogrammetry" / run / "odm"`).
  - `WORK_ENV = "AIO_ODM_WORK"`; `run_odm_dir(project: Path, run: str, env: Mapping[str, str] | None = None) -> Path`: `odm_path(odm_project_dir(project, run), Path(env[WORK_ENV]) if env.get(WORK_ENV) else None)` with `env` defaulting to `os.environ` (the run's ODM folder as ODM reaches it; used by all three jobs).
  - `is_safe_path(p: Path) -> bool`; `odm_path(real: Path, work_root: Path | None) -> Path`: `real` when safe; otherwise a directory junction `work_root / <first 16 hex of sha1(str(real).lower())>` pointing at `real` (made once, reused); `JobError` when unsafe and `work_root` is `None`.
  - `link_images(odm_dir: Path, photos: list[tuple[str, Path]]) -> tuple[dict[str, str], int]`: `({link name: photo key}, copies)`; link names `f"{i:05d}{suffix.lower()}"` over `photos` in the order given; hard links, copies when a link fails; writes `names.json`; idempotent (an existing link of the same size is kept).
  - `read_names(odm_dir: Path) -> dict[str, str]` (link to key).
  - `@dataclass class GeoRow: link: str; lon: float; lat: float; h: float; yaw: float | None; pitch: float | None; roll: float | None; h_acc: float; v_acc: float`; `write_geo(odm_dir: Path, rows: list[GeoRow]) -> Path | None` (`None` and no file when `rows` is empty).
  - `@dataclass class GcpList: path: Path; points: list[str]; marks: int`; `write_gcp_list(odm_dir: Path, gcp: dict, links_by_key: dict[str, str], exclude: set[str]) -> GcpList`.
  - `write_boundary(odm_dir: Path, ring: list[list[float]]) -> Path`.
  - `invalidate(odm_dir: Path, rels: Sequence[str]) -> None`; `clean_intermediates(odm_dir: Path) -> int` (bytes freed).
  - `has_alignment(odm_dir: Path) -> bool` (an `opensfm/reconstruction*.json` exists).

- [ ] **Step 1: Write the failing tests** (`python/tests/test_odm_project.py`)

```python
import json
import os
from pathlib import Path

import pytest

from aio_pipelines.photo.odm import project as P
from aio_pipelines.runtime import JobError


def _photo(path: Path, data: bytes = b"\xff\xd8jpeg") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def test_same_file_names_in_two_folders_get_distinct_links(tmp_path):
    a = _photo(tmp_path / "100MEDIA" / "IMG_0001.JPG", b"a" * 10)
    b = _photo(tmp_path / "101MEDIA" / "IMG_0001.JPG", b"b" * 10)
    odm = tmp_path / "odm"
    names, copies = P.link_images(odm, [("0/100MEDIA/IMG_0001.JPG", a), ("1/101MEDIA/IMG_0001.JPG", b)])
    assert names == {"00000.jpg": "0/100MEDIA/IMG_0001.JPG", "00001.jpg": "1/101MEDIA/IMG_0001.JPG"}
    assert (odm / "images" / "00001.jpg").read_bytes() == b"b" * 10
    assert P.read_names(odm) == names
    assert copies == 0  # same drive: hard links
    assert os.stat(odm / "images" / "00000.jpg").st_nlink == 2
    assert P.link_images(odm, [("0/100MEDIA/IMG_0001.JPG", a), ("1/101MEDIA/IMG_0001.JPG", b)]) == (names, 0)


def test_a_failed_hard_link_copies(tmp_path, monkeypatch):
    a = _photo(tmp_path / "in" / "x.jpg")
    monkeypatch.setattr(os, "link", lambda *_: (_ for _ in ()).throw(OSError("cross-device")))
    names, copies = P.link_images(tmp_path / "odm", [("k", a)])
    assert copies == 1 and (tmp_path / "odm" / "images" / "00000.jpg").read_bytes() == a.read_bytes()


def test_run_odm_dir_is_the_run_folder_when_its_path_is_safe(tmp_path, monkeypatch):
    monkeypatch.setattr(P, "is_safe_path", lambda p: True)
    assert P.run_odm_dir(tmp_path, "r1", {}) == tmp_path / "photogrammetry" / "r1" / "odm"


def test_safe_paths():
    assert P.is_safe_path(Path(r"E:\Data\proj\photogrammetry\run-1\odm"))
    assert P.is_safe_path(Path(r"E:\Stratlas Data\proj"))  # spaces work (C5)
    assert not P.is_safe_path(Path(r"E:\Média\proj"))
    assert not P.is_safe_path(Path(r"E:\a&b\proj"))
    assert P.is_safe_path(Path(r"C:\Users\RUNNER~1\AppData\Local\Temp\odm"))  # an 8.3 short name


@pytest.mark.skipif(os.name != "nt", reason="directory junctions are Windows'")
def test_odm_path_reaches_an_unsafe_folder_through_a_junction(tmp_path):
    real = tmp_path / "Stratlas Data é" / "odm"
    (real / "images").mkdir(parents=True)
    work = tmp_path / "work"
    got = P.odm_path(real, work)
    assert P.is_safe_path(got)
    assert (got / "images").is_dir() and got.parent == work
    assert P.odm_path(real, work) == got  # reused
    with pytest.raises(JobError):
        P.odm_path(real, None)


def test_geo_txt(tmp_path):
    assert P.write_geo(tmp_path, []) is None
    path = P.write_geo(tmp_path, [P.GeoRow("00000.jpg", 55.1, 25.2, 101.5, 10.0, -90.0, 0.0, 0.03, 0.05)])
    lines = path.read_text().splitlines()
    assert lines[0] == "EPSG:4326"
    assert lines[1].split() == ["00000.jpg", "55.10000000", "25.20000000", "101.500", "10.000", "-90.000", "0.000", "0.030", "0.050"]
    path = P.write_geo(tmp_path, [P.GeoRow("00001.jpg", 55.1, 25.2, 101.5, None, None, None, 0.03, 0.05)])
    row = path.read_text().splitlines()[1].split()
    assert len(row) == 9 and row[4:7] == ["nan", "nan", "nan"]  # always 9 columns (C15)


GCP = {
    "schema": "aio.gcp/1",
    "crs": {"epsg": 32639},
    "points": [
        {"id": "G1", "role": "control", "xyz": [412010.0, 3245010.0, 21.0], "accuracy": {"horizontalM": 0.02, "verticalM": 0.03},
         "marks": [{"photo": "k1", "px": [100.5, 200.5], "by": "person", "at": "2026-10-14T00:00:00Z", "state": "confirmed"},
                   {"photo": "k2", "px": [110.5, 210.5], "by": "person", "at": "2026-10-14T00:00:00Z", "state": "confirmed"},
                   {"photo": "k3", "px": [1.0, 1.0], "by": "detector", "at": "2026-10-14T00:00:00Z", "state": "draft"}]},
        {"id": "G2", "role": "control", "xyz": [412020.0, 3245010.0, 21.0], "accuracy": {"horizontalM": 0.02, "verticalM": 0.03},
         "marks": [{"photo": "k1", "px": [300.5, 200.5], "by": "person", "at": "2026-10-14T00:00:00Z", "state": "confirmed"},
                   {"photo": "k2", "px": [310.5, 210.5], "by": "person", "at": "2026-10-14T00:00:00Z", "state": "confirmed"}]},
        {"id": "G3", "role": "control", "xyz": [412020.0, 3245020.0, 21.0], "accuracy": {"horizontalM": 0.02, "verticalM": 0.03},
         "marks": [{"photo": "k1", "px": [300.5, 400.5], "by": "person", "at": "2026-10-14T00:00:00Z", "state": "confirmed"},
                   {"photo": "k2", "px": [310.5, 410.5], "by": "person", "at": "2026-10-14T00:00:00Z", "state": "confirmed"}]},
        {"id": "C1", "role": "check", "xyz": [412015.0, 3245015.0, 21.0], "accuracy": {"horizontalM": 0.02, "verticalM": 0.03},
         "marks": [{"photo": "k1", "px": [5.5, 5.5], "by": "person", "at": "2026-10-14T00:00:00Z", "state": "confirmed"},
                   {"photo": "k2", "px": [6.5, 6.5], "by": "person", "at": "2026-10-14T00:00:00Z", "state": "confirmed"}]},
        {"id": "G4", "role": "control", "disabled": True, "xyz": [0, 0, 0], "accuracy": {"horizontalM": 0.02, "verticalM": 0.03},
         "marks": [{"photo": "k1", "px": [7.5, 7.5], "by": "person", "at": "2026-10-14T00:00:00Z", "state": "confirmed"},
                   {"photo": "k2", "px": [8.5, 8.5], "by": "person", "at": "2026-10-14T00:00:00Z", "state": "confirmed"}]},
    ],
}  # fmt: skip


def test_gcp_list_has_confirmed_control_marks_only(tmp_path):
    out = P.write_gcp_list(tmp_path, GCP, {"k1": "00000.jpg", "k2": "00001.jpg", "k3": "00002.jpg"}, exclude=set())
    lines = out.path.read_text().splitlines()
    assert lines[0] == "EPSG:32639"
    assert out.points == ["G1", "G2", "G3"] and out.marks == 6
    assert lines[1].split() == ["412010.0000", "3245010.0000", "21.0000", "100.00", "200.00", "00000.jpg", "G1"]
    text = out.path.read_text()
    assert "C1" not in text and "G4" not in text and "00002.jpg" not in text  # checks, disabled, drafts


def test_gcp_list_leaves_out_outliers_and_needs_three_points(tmp_path):
    links = {"k1": "00000.jpg", "k2": "00001.jpg"}
    with pytest.raises(JobError, match="At least three usable control points"):
        P.write_gcp_list(tmp_path, GCP, links, exclude={"G3"})


def test_boundary_invalidate_and_cleanup(tmp_path):
    b = P.write_boundary(tmp_path, [[55.0, 25.0], [55.1, 25.0], [55.1, 25.1]])
    doc = json.loads(b.read_text())
    assert doc["type"] == "FeatureCollection"
    ring = doc["features"][0]["geometry"]["coordinates"][0]
    assert ring[0] == ring[-1] == [55.0, 25.0]  # closed
    for rel in ("opensfm/reconstruction.json", "openmvs/scene.mvs", "odm_meshing/x.ply", "opensfm/features/a.npz"):
        (tmp_path / rel).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / rel).write_bytes(b"x" * 100)
    assert P.has_alignment(tmp_path)
    assert P.clean_intermediates(tmp_path) >= 200
    assert not (tmp_path / "openmvs").exists() and not (tmp_path / "odm_meshing").exists()
    assert (tmp_path / "opensfm" / "features" / "a.npz").exists()  # alignment kept for later products
    P.invalidate(tmp_path, ("opensfm/reconstruction.json", "missing/thing"))
    assert not P.has_alignment(tmp_path)
```

- [ ] **Step 2: Run to see it fail**

Run: `uv run --frozen pytest tests/test_odm_project.py -q`
Expected: FAIL (`ImportError`).

- [ ] **Step 3: Implement** (`photo/odm/project.py`)

```python
"""The ODM project of a run: ``photogrammetry/<run>/odm/`` (ADR 0012).

ODM sees only ASCII paths without cmd.exe metacharacters (C5: spaces are fine, a non-ASCII letter
breaks OpenSfM): a run folder below any other path is reached through a directory junction under ``AIO_ODM_WORK``. ``images/`` holds hard links to
the source photos (copies when a link fails, e.g. across drives), named ``00000.jpg``... in photo
order so names never collide; ``names.json`` maps them back to the photo keys. The folder lives
between the jobs of a run; ``clean_intermediates`` removes the heavy stage folders after products
commit and keeps the alignment.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ...runtime import JobError, atomic_write_json
from .. import crs as C
from .. import gcp as G

ODM_DIR = "odm"
WORK_ENV = "AIO_ODM_WORK"  # a safe folder for junctions, set by the app
SPACES_OK = True  # C5: spaces work; non-ASCII letters do not
#: what cmd.exe treats specially; ODM's command line passes through it
_CMD_SPECIAL = re.compile(r'[&^%!()<>|"]')
GEOREF_INVALIDATE = (
    "opensfm/reconstruction.json", "opensfm/reconstruction.topocentric.json", "opensfm/config.yaml",
    "opensfm/gcp_list.txt", "opensfm/undistorted", "opensfm/exif", "opensfm/camera_models.json",
    "opensfm/reference_lla.json", "opensfm/stats", "odm_georeferencing",
)  # fmt: skip
INTERMEDIATES = (
    "opensfm/undistorted", "openmvs", "odm_filterpoints", "odm_meshing", "odm_texturing", "odm_25dmeshing",
    "odm_texturing_25d", "odm_dem", "odm_orthophoto", "odm_georeferencing/odm_georeferenced_model.laz",
    "odm_georeferencing/odm_georeferenced_model.copc.laz", "odm_georeferencing/odm_georeferenced_model.las",
)  # fmt: skip
NEED_THREE = "At least three usable control points are needed (each marked in two or more photos)."


def odm_project_dir(project: Path, run: str) -> Path:
    return project / "photogrammetry" / run / ODM_DIR


def is_safe_path(p: Path) -> bool:
    """ASCII and nothing cmd.exe treats specially; spaces are fine when ``SPACES_OK`` (C5, measured).
    A non-ASCII letter breaks OpenSfM. 8.3 short names (``C:\\Users\\RUNNER~1``) are safe."""
    s = str(p)
    if not s.isascii() or _CMD_SPECIAL.search(s):
        return False
    return SPACES_OK or not any(ch.isspace() for ch in s)


def odm_path(real: Path, work_root: Path | None) -> Path:
    if is_safe_path(real):
        return real
    if work_root is None or not is_safe_path(work_root):
        raise JobError(
            "The project folder's path has spaces or letters ODM cannot use, and no safe working "
            "folder was given. Reinstall the processing engine in Settings, Processing tools."
        )
    link = work_root / hashlib.sha1(str(real).lower().encode("utf-8")).hexdigest()[:16]
    if link.exists():
        return link
    work_root.mkdir(parents=True, exist_ok=True)
    real.mkdir(parents=True, exist_ok=True)
    import _winapi  # Windows only: a directory junction needs no administrator rights

    _winapi.CreateJunction(str(real), str(link))
    return link
```

`link_images`: create `images/`; for index `i` and `(key, path)`: `name = f"{i:05d}{path.suffix.lower()}"`; skip when `images/name` exists with the source's size; else `os.link(path, dst)`, on `OSError` `shutil.copy2` and count a copy; then `atomic_write_json(odm_dir / "names.json", {name: key})`. `read_names` reads it (`JobError("The run's ODM project has no names.json; use Create maps again.")` when missing).

`write_geo`: header `EPSG:4326`, then per row, always 9 columns (C15), `f"{link} {lon:.8f} {lat:.8f} {h:.3f} {a(yaw)} {a(pitch)} {a(roll)} {h_acc:.3f} {v_acc:.3f}"` where `a(v)` is `f"{v:.3f}"`, or `nan` when `v` is `None` (ODM then ignores the orientation and keeps the accuracy), into `odm_dir / "geo.txt"`.

`write_gcp_list`: `crs = C.crs_of(gcp["crs"])`; header `f"EPSG:{crs.to_epsg()}"` when it has an EPSG code, else `crs.to_proj4()`; for each point with `role == "control"`, not `disabled`, not in `exclude`: its `G.usable_marks(point)` whose photo key is in `links_by_key`; a point with fewer than two is left out; each kept mark is one line `f"{x:.4f} {y:.4f} {z:.4f} {px - 0.5:.2f} {py - 0.5:.2f} {link} {pid}"` (our marks put the top-left corner of the image at 0; ODM's pixel coordinates put the first pixel's centre at 0). Fewer than three points kept: `JobError(NEED_THREE)`. Written to `odm_dir / "gcp_list.txt"`.

`write_boundary`: a GeoJSON `FeatureCollection` with one `Polygon` feature, the ring closed, into `odm_dir / "boundary.geojson"`.

`invalidate`: remove each relative path (folder or file) that exists. `clean_intermediates`: sum the sizes of what `INTERMEDIATES` names, remove it, return the sum. `has_alignment`: `opensfm/reconstruction.topocentric.json` or `opensfm/reconstruction.json` exists.

- [ ] **Step 4: Run the tests**

Run: `uv run --frozen pytest tests/test_odm_project.py -q`
Expected: PASS (the junction test is skipped off Windows).

- [ ] **Step 5: Lint and commit**

```bash
git add python/src/aio_pipelines/photo/odm/project.py python/tests/test_odm_project.py
git commit -m "feat(pipelines): odm project folder, geo.txt and gcp list" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: OpenSfM reconstruction into our sparse model

**Files:**

- Create: `python/src/aio_pipelines/photo/odm/reconstruction.py`, `python/tests/test_odm_reconstruction.py`

**Interfaces:**

- Consumes: `photo.model` (`Camera`, `Image`, `SparseModel`, `rodrigues`, `project_points`), `photo.crs` (`EnuFrame`, `transform_rotations`).
- Produces (`aio_pipelines.photo.odm.reconstruction`):
  - `@dataclass class OdmModel: model: SparseModel; reference: C.EnuFrame; unregistered: list[str]; groups: int; stats: dict | None; reproj_px: float | None; track_length: float | None; gsd_cm: float | None`.
  - `read_reconstruction(odm_dir: Path, names: dict[str, str], run_enu: C.EnuFrame) -> OdmModel`: every reconstruction's shots (image names mapped to photo keys through `names`), cameras and points (no observations: `tracks.csv` is binary, C10), converted from ODM's topocentric frame to `run_enu`; `unregistered` lists the photo keys with no shot; `groups` counts the reconstructions with shots; `stats` is `opensfm/stats/stats.json`, else `odm_report/stats.json`, else `None`; `reproj_px` and `track_length` are its `reconstruction_statistics.reprojection_error_pixels` and `average_track_length`; `gsd_cm` is `visible_gsd_cm(model)`.
  - `visible_gsd_cm(model: SparseModel) -> float | None`: per image, the points in front of the camera that project inside the image (`project_points`), their median depth over the camera's focal length; the median over the images, in cm (the observation-free stand-in for `accuracy.gsd_cm`).
  - `opensfm_camera(cid: int, cam: dict) -> Camera`.
  - `convert_model(m: SparseModel, conv: Callable[[np.ndarray], np.ndarray]) -> None`: moves every camera (centre and rotation, through `C.transform_rotations`) and point by `conv`, in place (Task 8 makes `align._convert_model` call it).

- [ ] **Step 1: Write the failing tests** (`python/tests/test_odm_reconstruction.py`). The expected pixels are computed by hand from OpenSfM's formulas, not from our code:

```python
import json
import math
from pathlib import Path

import numpy as np
import pytest

from aio_pipelines.photo import crs as C
from aio_pipelines.photo.model import project_points
from aio_pipelines.photo.odm.reconstruction import opensfm_camera, read_reconstruction
from aio_pipelines.runtime import JobError

W, H = 4000, 3000
S = 4000.0


def _write(odm: Path, rec: list, ref=(55.0, 25.0, 10.0), stats: dict | None = None):
    (odm / "opensfm").mkdir(parents=True)
    (odm / "opensfm" / "reconstruction.topocentric.json").write_text(json.dumps(rec))
    (odm / "opensfm" / "reference_lla.json").write_text(json.dumps({"longitude": ref[0], "latitude": ref[1], "altitude": ref[2]}))
    if stats:
        (odm / "opensfm" / "stats").mkdir()
        (odm / "opensfm" / "stats" / "stats.json").write_text(json.dumps(stats))


BROWN = {"projection_type": "brown", "width": W, "height": H, "focal_x": 0.8, "focal_y": 0.81, "c_x": 0.01,
         "c_y": -0.02, "k1": -0.1, "k2": 0.02, "p1": 0.001, "p2": -0.002, "k3": 0.003}  # fmt: skip


def _brown_pixel(Xc):
    x, y = Xc[0] / Xc[2], Xc[1] / Xc[2]
    r2 = x * x + y * y
    rad = 1 + BROWN["k1"] * r2 + BROWN["k2"] * r2**2 + BROWN["k3"] * r2**3
    xd = x * rad + 2 * BROWN["p1"] * x * y + BROWN["p2"] * (r2 + 2 * x * x)
    yd = y * rad + 2 * BROWN["p2"] * x * y + BROWN["p1"] * (r2 + 2 * y * y)
    xn = BROWN["focal_x"] * xd + BROWN["c_x"]
    yn = BROWN["focal_y"] * yd + BROWN["c_y"]
    return xn * S + W / 2, yn * S + H / 2


def test_a_brown_camera_projects_like_opensfm():
    cam = opensfm_camera(1, BROWN)
    Xc = np.array([0.3, -0.2, 10.0])
    u, v = project_points(cam, np.eye(3), np.zeros(3), Xc[None])[0]
    assert (u, v) == pytest.approx(_brown_pixel(Xc), abs=1e-6)


def test_a_perspective_camera():
    cam = opensfm_camera(2, {"projection_type": "perspective", "width": W, "height": H, "focal": 0.85, "k1": -0.05, "k2": 0.01})
    x, y = 0.03, -0.02
    r2 = x * x + y * y
    d = 1 - 0.05 * r2 + 0.01 * r2**2
    u, v = project_points(cam, np.eye(3), np.zeros(3), np.array([[x, y, 1.0]]))[0]
    assert (u, v) == pytest.approx((0.85 * x * d * S + W / 2, 0.85 * y * d * S + H / 2), abs=1e-6)


def test_an_unknown_camera_model_is_named():
    with pytest.raises(JobError, match="fisheye"):
        opensfm_camera(3, {"projection_type": "fisheye", "width": W, "height": H, "focal": 1, "k1": 0, "k2": 0})


def test_shots_and_points_land_in_the_runs_frame(tmp_path):
    rot = [0.0, 0.0, math.pi / 2]  # axis-angle: 90 degrees about z
    X = [5.0, 3.0, -40.0]
    rec = [{"cameras": {"v2 cam": BROWN},
            "shots": {"00000.jpg": {"camera": "v2 cam", "rotation": rot, "translation": [1.0, 2.0, 50.0]}},
            "points": {"7": {"coordinates": X, "color": [10, 20, 30]}}},
           {"cameras": {"v2 cam": BROWN},
            "shots": {"00002.jpg": {"camera": "v2 cam", "rotation": [0, 0, 0], "translation": [0, 0, 0]}},
            "points": {}}]  # fmt: skip
    stats = {"reconstruction_statistics": {"reprojection_error_pixels": 1.2, "average_track_length": 2.8}}
    odm = tmp_path / "odm"
    _write(odm, rec, stats=stats)
    names = {"00000.jpg": "a", "00001.jpg": "b", "00002.jpg": "c"}
    same = C.EnuFrame(55.0, 25.0, 10.0)
    got = read_reconstruction(odm, names, same)
    m = got.model
    assert sorted(im.name for im in m.images.values()) == ["a", "c"]
    assert got.unregistered == ["b"] and got.groups == 2
    a = m.image_by_name()["a"]
    Rz = np.array([[0.0, -1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]])
    assert a.R == pytest.approx(Rz, abs=1e-9) and a.t == pytest.approx([1.0, 2.0, 50.0], abs=1e-6)
    assert m.xyz[0] == pytest.approx(X, abs=1e-6) and list(m.rgb[0]) == [10, 20, 30]
    assert len(a.xys) == 0  # no observations: tracks.csv is binary
    assert (got.reproj_px, got.track_length) == (1.2, 2.8)
    moved = read_reconstruction(odm, names, C.EnuFrame(55.0, 25.0, 0.0))  # our frame 10 m lower
    assert moved.model.xyz[0] == pytest.approx([5.0, 3.0, -30.0], abs=1e-3)


def test_reconstruction_json_is_read_when_there_is_no_topocentric_file(tmp_path):
    odm = tmp_path / "odm"
    _write(odm, [{"cameras": {"c": BROWN}, "shots": {}, "points": {}}])
    (odm / "opensfm" / "reconstruction.topocentric.json").rename(odm / "opensfm" / "reconstruction.json")
    with pytest.raises(JobError, match="ODM placed no photos"):
        read_reconstruction(odm, {}, C.EnuFrame(55.0, 25.0, 10.0))


def test_gsd_from_the_points_a_camera_sees(tmp_path):
    # a nadir camera 100 m above a grid of ground points; f = 0.8 * 4000 px, so GSD = 100 / 3200 m
    pts = {str(i): {"coordinates": [x, y, 0.0], "color": [0, 0, 0]}
           for i, (x, y) in enumerate((x, y) for x in range(-20, 21, 5) for y in range(-20, 21, 5))}
    cam = {**BROWN, "c_x": 0.0, "c_y": 0.0, "k1": 0.0, "k2": 0.0, "p1": 0.0, "p2": 0.0, "k3": 0.0, "focal_y": 0.8}
    rec = [{"cameras": {"c": cam}, "points": pts,
            "shots": {"00000.jpg": {"camera": "c", "rotation": [math.pi, 0.0, 0.0], "translation": [0.0, 0.0, 100.0]}}}]  # fmt: skip
    odm = tmp_path / "odm"
    _write(odm, rec)
    got = read_reconstruction(odm, {"00000.jpg": "a"}, C.EnuFrame(55.0, 25.0, 10.0))
    assert got.gsd_cm == pytest.approx(100 / 3200 * 100, rel=1e-3)
    assert got.reproj_px is None and got.stats is None
```

- [ ] **Step 2: Run to see it fail**

Run: `uv run --frozen pytest tests/test_odm_reconstruction.py -q`
Expected: FAIL (`ImportError`).

- [ ] **Step 3: Implement** (`photo/odm/reconstruction.py`)

```python
"""OpenSfM's reconstruction (ODM's alignment) into our ``SparseModel`` (ADR 0012).

Reads ``opensfm/reconstruction.topocentric.json`` (else ``reconstruction.json``) in the
east-north-up frame of ``opensfm/reference_lla.json``, and ODM's statistics. No observations:
``tracks.csv`` is a binary file in ODM 3.6.2 (C10).
OpenSfM's pose convention is ours (world to camera, camera looks along +z, x right, y down); its
image coordinates are normalised by ``s = max(width, height)`` about the image centre, so a pixel
``u`` (top-left corner at 0) is ``x * s + width / 2``. Cameras: ``perspective`` becomes ``RADIAL``,
``brown`` becomes ``FULL_OPENCV`` (k4 to k6 zero), ``radial`` and ``simple_radial`` become ``OPENCV``.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from ...runtime import JobError
from .. import crs as C
from ..model import Camera, Image, SparseModel, rodrigues


def _px(cam: dict) -> tuple[float, float, float]:
    w, h = float(cam["width"]), float(cam["height"])
    return w, h, max(w, h)


def opensfm_camera(cid: int, cam: dict) -> Camera:
    kind = cam.get("projection_type")
    w, h, s = _px(cam)
    if kind == "perspective":
        f = cam["focal"] * s
        return Camera(cid, "RADIAL", int(w), int(h), [f, w / 2, h / 2, cam.get("k1", 0.0), cam.get("k2", 0.0)])
    if kind in ("brown", "radial", "simple_radial"):
        fx, fy = cam["focal_x"] * s, cam["focal_y"] * s
        cx, cy = w / 2 + cam.get("c_x", 0.0) * s, h / 2 + cam.get("c_y", 0.0) * s
        k1, k2 = cam.get("k1", 0.0), cam.get("k2", 0.0)
        if kind == "brown":
            p = [fx, fy, cx, cy, k1, k2, cam["p1"], cam["p2"], cam.get("k3", 0.0), 0.0, 0.0, 0.0]
            return Camera(cid, "FULL_OPENCV", int(w), int(h), p)
        return Camera(cid, "OPENCV", int(w), int(h), [fx, fy, cx, cy, k1, k2 if kind == "radial" else 0.0, 0.0, 0.0])
    raise JobError(f"ODM used the {kind} camera model, which this build does not read.")
```

`read_reconstruction`:

1. Load the reconstruction file (C10) and `reference_lla.json` (`odm_ref = C.EnuFrame(lon, lat, alt)`); a missing file: `JobError("ODM wrote no alignment (opensfm/reconstruction.json); look at the job log.")`.
2. Number the distinct camera keys in order of appearance from 1; build `Camera`s with `opensfm_camera`.
3. For every reconstruction in the list (a list item with no shots does not count as a group), each shot whose image is in `names`: `Image(id, names[image], camera_id, rodrigues(np.array(rotation)), translation)`; image ids from 1 in order of appearance.
4. Points of every reconstruction: ids `int(track_id)` when it is digits, else a running number from 10,000,000 kept in a map; `xyz`, `rgb` (uint8), `error` zeros: `model.set_points(...)`.
5. Images have no observations (`xys` and `point3D_ids` empty).
6. No image at all: `JobError("ODM placed no photos: they may not overlap enough, or have no usable features.")`.
7. Convert to `run_enu` when it differs from `odm_ref`: `conv = lambda p: run_enu.from_geodetic(*odm_ref.to_geodetic(p))`; through the public `convert_model(model, conv)` (centres and rotations by `C.transform_rotations(conv, centres, rotations)`, points by `conv`; this module does not import `align`).
8. `unregistered` = photo keys of `names` with no image, sorted; `stats`, `reproj_px`, `track_length` and `gsd_cm` as under Interfaces (`gsd_cm` after the conversion).

- [ ] **Step 4: Run the tests**

Run: `uv run --frozen pytest tests/test_odm_reconstruction.py -q`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

```bash
git add python/src/aio_pipelines/photo/odm/reconstruction.py python/tests/test_odm_reconstruction.py
git commit -m "feat(pipelines): read odm's opensfm reconstruction into the sparse model" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: ODM outputs into the project, and the GLB helpers

**Files:**

- Create: `python/src/aio_pipelines/photo/glb.py`, `python/src/aio_pipelines/photo/odm/outputs.py`, `python/tests/test_odm_outputs.py`

**Interfaces:**

- Consumes: `photo.surface` (`GridSpec`, `write_tif`, `read_grid`), `photo.cloud_out.write_copc`, `photo.native` (`run_tool`), `pointcloud` (`find_pdal`, `pdal_env`), `photo.crs` (`crs_of`), rasterio, pyproj, PIL.
- Produces:
  - `aio_pipelines.photo.glb` (self-contained: Task 13 deletes `texture.py` and `mesh.py`): `glb_bytes(parts: list[dict], images: list[bytes], name: str = "mesh") -> bytes`, `glb_info(data: bytes) -> dict`, `jpeg_bytes(img: np.ndarray, quality: int = JPEG_QUALITY) -> bytes`, `enu_to_local(v: np.ndarray) -> np.ndarray`, `vertex_normals(vertices, faces) -> np.ndarray`, and the constants `GENERATOR` and `JPEG_QUALITY`: copied from `texture.py` (`glb_bytes`, `glb_info`, `_jpeg` as `jpeg_bytes` with the quality as a parameter, `GENERATOR`, `JPEG_QUALITY`) and `mesh.py` (`enu_to_local`, `vertex_normals` and whatever it calls). Its only project import is `..volumetric.terrain.encode_glb` (which stays); never `.mesh` or `.texture`.
  - `aio_pipelines.photo.odm.outputs`: path constants `ORTHO`, `DSM`, `DTM`, `CLOUDS` (tuple, preferred first), `MESHES` (tuple), `COORDS`, `REPORT_PDF`, `STATS` (C8); `output_path(odm_dir: Path, rel: str | tuple[str, ...]) -> Path` (the first that exists, else `JobError(f"ODM did not write {name}; look at the job log.")`); `read_coords(odm_dir: Path) -> tuple[int, tuple[float, float]]` (UTM EPSG and offset); `dem_to_project(src: Path, dst: Path, epsg: int) -> GridSpec` (float32, NaN for no data, north-up in the project CRS at the source's resolution); `ortho_to_project(src: Path, dst: Path, epsg: int) -> Path` (`src` itself when already in `epsg`, else an RGBA GeoTIFF warped into it); `ground_height(dem: Path) -> float` (median of the valid heights on a grid of at most 1024 x 1024); `las_point_count(path: Path) -> int`; `cloud_to_copc(ctx: StepContext, odm_dir: Path, dst: Path, epsg: int, temp: Path, budget: int) -> dict` (`{"points", "writer", "source"}`); `@dataclass class ObjPart: positions: np.ndarray; uvs: np.ndarray | None; texture: Path | None`; `read_obj(path: Path) -> list[ObjPart]`; `mesh_to_glb(odm_dir: Path, epsg: int, origin: np.ndarray, max_texture_px: int = 8192) -> tuple[bytes, dict]` (`{"triangles", "textures", "source": "3d" | "2.5d"}`).

- [ ] **Step 1: Write the failing tests** (`python/tests/test_odm_outputs.py`)

```python
import struct
from pathlib import Path

import numpy as np
import pytest
import rasterio
from PIL import Image
from rasterio.transform import from_origin

from aio_pipelines.photo import glb
from aio_pipelines.photo.odm import outputs as O
from aio_pipelines.runtime import JobError

UTM39 = 32639


def _tif(path: Path, data: np.ndarray, epsg: int, x0: float, y1: float, res: float, nodata=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    bands = 1 if data.ndim == 2 else data.shape[0]
    with rasterio.open(path, "w", driver="GTiff", width=data.shape[-1], height=data.shape[-2], count=bands,
                       dtype=data.dtype, crs=f"EPSG:{epsg}", transform=from_origin(x0, y1, res, res), nodata=nodata) as ds:  # fmt: skip
        ds.write(data if data.ndim == 3 else data[None])


def test_a_dem_in_the_same_crs_keeps_its_grid_and_nodata_becomes_nan(tmp_path):
    z = np.full((10, 20), 50.0, np.float32)
    z[0, 0] = -9999.0
    _tif(tmp_path / "dsm.tif", z, UTM39, 412000.0, 3245010.0, 0.5, nodata=-9999.0)
    spec = O.dem_to_project(tmp_path / "dsm.tif", tmp_path / "out.tif", UTM39)
    assert (spec.x0, spec.y1, spec.res, spec.width, spec.height) == (412000.0, 3245010.0, 0.5, 20, 10)
    with rasterio.open(tmp_path / "out.tif") as ds:
        a = ds.read(1)
    assert np.isnan(a[0, 0]) and a[5, 5] == 50.0
    assert O.ground_height(tmp_path / "out.tif") == 50.0


def test_a_dem_in_another_crs_is_warped(tmp_path):
    _tif(tmp_path / "dsm.tif", np.full((20, 20), 7.0, np.float32), UTM39, 412000.0, 3245020.0, 1.0, nodata=-9999.0)
    spec = O.dem_to_project(tmp_path / "dsm.tif", tmp_path / "out.tif", 32640)  # UTM 40N
    with rasterio.open(tmp_path / "out.tif") as ds:
        assert ds.crs.to_epsg() == 32640
        assert np.nanmax(ds.read(1)) == pytest.approx(7.0)
    assert spec.width > 0 and spec.height > 0


def test_ortho_same_crs_is_used_as_is(tmp_path):
    rgba = np.zeros((4, 8, 8), np.uint8)
    _tif(tmp_path / "o.tif", rgba, UTM39, 412000.0, 3245010.0, 0.1)
    assert O.ortho_to_project(tmp_path / "o.tif", tmp_path / "x.tif", UTM39) == tmp_path / "o.tif"
    out = O.ortho_to_project(tmp_path / "o.tif", tmp_path / "x.tif", 32640)
    with rasterio.open(out) as ds:
        assert ds.crs.to_epsg() == 32640 and ds.count == 4


def test_missing_output_is_named(tmp_path):
    with pytest.raises(JobError, match="ODM did not write odm_orthophoto.tif"):
        O.output_path(tmp_path, O.ORTHO)
    (tmp_path / "odm_georeferencing").mkdir()
    (tmp_path / "odm_georeferencing" / "odm_georeferenced_model.las").write_bytes(b"x")
    assert O.output_path(tmp_path, O.CLOUDS).name == "odm_georeferenced_model.las"


def test_coords(tmp_path):
    (tmp_path / "odm_georeferencing").mkdir()
    (tmp_path / "odm_georeferencing" / "coords.txt").write_text("WGS84 UTM 39N\n412000 3245000\n")
    assert O.read_coords(tmp_path) == (32639, (412000.0, 3245000.0))
    (tmp_path / "odm_georeferencing" / "coords.txt").write_text("WGS84 UTM 33S\n1 2\n")
    assert O.read_coords(tmp_path)[0] == 32733


def test_las_point_count(tmp_path):
    head = bytearray(227)
    head[0:4] = b"LASF"
    head[24:26] = bytes([1, 2])
    struct.pack_into("<I", head, 107, 1234)
    (tmp_path / "a.las").write_bytes(bytes(head))
    assert O.las_point_count(tmp_path / "a.las") == 1234


def _textured_obj(odm: Path, folder: str = "odm_texturing"):
    d = odm / folder
    d.mkdir(parents=True)
    Image.new("RGB", (8, 8), (200, 10, 10)).save(d / "tex.png")
    (d / "odm_textured_model_geo.mtl").write_text("newmtl material0000\nmap_Kd tex.png\n")
    (d / "odm_textured_model_geo.obj").write_text(
        "mtllib odm_textured_model_geo.mtl\n"
        "v 10 20 25\nv 11 20 25\nv 10 21 26\n"
        "vt 0 0\nvt 1 0\nvt 0 1\n"
        "usemtl material0000\nf 1/1 2/2 3/3\n"
    )
    (odm / "odm_georeferencing").mkdir(parents=True, exist_ok=True)
    (odm / "odm_georeferencing" / "coords.txt").write_text("WGS84 UTM 39N\n412000 3245000\n")


def test_obj_reader(tmp_path):
    _textured_obj(tmp_path)
    parts = O.read_obj(tmp_path / "odm_texturing" / "odm_textured_model_geo.obj")
    assert len(parts) == 1 and parts[0].positions.shape == (3, 3) and parts[0].texture.name == "tex.png"
    assert parts[0].uvs.tolist() == [[0, 0], [1, 0], [0, 1]]


def test_mesh_to_glb_is_in_the_scene_frame(tmp_path):
    _textured_obj(tmp_path)
    data, info = O.mesh_to_glb(tmp_path, UTM39, np.array([412000.0, 3245000.0, 20.0]))
    assert info == {"triangles": 1, "textures": 1, "source": "3d"}
    doc = glb.glb_info(data)
    acc = doc["accessors"][doc["meshes"][0]["primitives"][0]["attributes"]["POSITION"]]
    # vertex (10, 20, 25) in UTM minus offset: east 10, north 20, height 25 - 20 = 5 -> scene (10, 5, -20)
    assert acc["min"] == pytest.approx([10.0, 5.0, -21.0]) and acc["max"] == pytest.approx([11.0, 6.0, -20.0])


def test_glb_stands_alone():
    src = Path(glb.__file__).read_text(encoding="utf-8")
    assert "from .mesh" not in src and "from .texture" not in src and "from . import mesh" not in src


def test_the_25d_model_is_used_when_there_is_no_3d_one(tmp_path):
    _textured_obj(tmp_path, "odm_texturing_25d")
    assert O.mesh_to_glb(tmp_path, UTM39, np.array([412000.0, 3245000.0, 20.0]))[1]["source"] == "2.5d"
```

- [ ] **Step 2: Run to see it fail**

Run: `uv run --frozen pytest tests/test_odm_outputs.py -q`
Expected: FAIL (`ImportError`).

- [ ] **Step 3: Implement.** `photo/glb.py`: the helpers and constants listed under Interfaces, copied (keep `texture.py` and `mesh.py` untouched; Task 13 deletes them), with no import of either. `photo/odm/outputs.py`:

- Constants as C8: `ORTHO = "odm_orthophoto/odm_orthophoto.tif"`, `DSM = "odm_dem/dsm.tif"`, `DTM = "odm_dem/dtm.tif"`, `CLOUDS = ("odm_georeferencing/odm_georeferenced_model.copc.laz", "odm_georeferencing/odm_georeferenced_model.laz", "odm_georeferencing/odm_georeferenced_model.las")`, `MESHES = ("odm_texturing/odm_textured_model_geo.obj", "odm_texturing_25d/odm_textured_model_geo.obj")`, `COORDS = "odm_georeferencing/coords.txt"`, `REPORT_PDF = "odm_report/report.pdf"`, `STATS = "odm_report/stats.json"`.
- `read_coords`: line 1 `WGS84 UTM <zone><N|S>` gives `32600 + zone` or `32700 + zone`; line 2 two numbers; anything else `JobError("ODM's coords.txt is not WGS84 UTM; this build cannot place its outputs.")`.
- `dem_to_project`: open `src`; when its CRS is `epsg`, the `GridSpec` is the source's own (`x0 = transform.c`, `y1 = transform.f`, `res = transform.a`, width, height) and the data is copied with nodata set to NaN; otherwise `rasterio.warp.calculate_default_transform` at the source resolution gives the grid and `rasterio.warp.reproject(..., resampling=Resampling.bilinear, src_nodata=src.nodata, dst_nodata=np.nan)` fills it. Write through `surface.write_tif(dst, spec, epsg, 1, "float32", nodata=np.nan)`.
- `ortho_to_project`: `src` when `crs.to_epsg() == epsg`; else `rasterio.vrt.WarpedVRT(src, crs=f"EPSG:{epsg}", resampling=Resampling.bilinear)` copied to `dst` as a tiled, DEFLATE GeoTIFF with all bands (RGBA kept).
- `las_point_count`: version byte at 25; for LAS 1.4 the 64-bit count at offset 247 when it is not zero, else the 32-bit legacy count at 107.
- `cloud_to_copc`: `src = output_path(odm_dir, CLOUDS)`; `utm, _ = read_coords(odm_dir)`. A `.copc.laz` with `utm == epsg`: copy to `dst`, `{"points": las_point_count(dst), "writer": "odm", "source": src.name}`. Otherwise: a PDAL pipeline JSON `[{"type": "readers.las", "filename": src}, *([{"type": "filters.reprojection", "in_srs": f"EPSG:{utm}", "out_srs": f"EPSG:{epsg}"}] if utm != epsg else []), {"type": "writers.las", "filename": temp / "cloud.las", "compression": false, "a_srs": f"EPSG:{epsg}"}]` run with `native.run_tool(ctx, [pdal, "pipeline", json_path], "Point cloud", temp, env=pdal_env(pdal))` (`pdal = pointcloud.find_pdal()`, `JobError(cloud_out.NO_COPC_TOOL)` when `None`), then `cloud_out.write_copc(ctx, temp / "cloud.las", dst, las_point_count(temp / "cloud.las"), epsg, temp, budget)`; return its writer.
- `read_obj`: parse `v`, `vt`, `usemtl`, `mtllib` and `f` lines (faces with `v`, `v/vt` or `v/vt/vn`; polygons fanned into triangles), the MTL's `newmtl`/`map_Kd`; one `ObjPart` per material in order of first use, `positions` per corner `(3 * triangles, 3)`, `uvs` per corner or `None`, `texture` the absolute `map_Kd` path or `None`.
- `mesh_to_glb`: `obj = output_path(odm_dir, MESHES)`; `utm, (ox, oy) = read_coords(odm_dir)`; per part: `e, n, h = positions.T + [ox, oy, 0]`; when `utm != epsg`, `pyproj.Transformer.from_crs(utm, epsg, always_xy=True).transform(e, n)`; `local = glb.enu_to_local(np.column_stack([e - origin[0], n - origin[1], h - origin[2]]))`; the texture opened with PIL, scaled to at most `max_texture_px` on its long side, `glb.jpeg_bytes`; UVs flipped to glTF (`v' = 1 - v`); `glb.glb_bytes(parts, images)`; `source` is `"2.5d"` when the OBJ came from `odm_texturing_25d`.

- [ ] **Step 4: Run the tests**

Run: `uv run --frozen pytest tests/test_odm_outputs.py -q`
Expected: PASS. Note: the GLB test's expected bounds use C9 (vertices relative to the offset); if Task 0 found absolute vertices, the controller amended C9 and this test's OBJ lines accordingly.

- [ ] **Step 5: Lint and commit**

```bash
git add python/src/aio_pipelines/photo/glb.py python/src/aio_pipelines/photo/odm/outputs.py python/tests/test_odm_outputs.py
git commit -m "feat(pipelines): import odm's rasters, cloud and textured mesh" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: photo.align on ODM

`photo.align` keeps reading the photos itself (the run's photo list, capture date, heights, warnings) and keeps writing the same run files; ODM does the alignment.

**Files:**

- Modify: `python/src/aio_pipelines/photo/align.py` (rewrite of the engine parts; the run-file helpers stay with their names)
- Rewrite: `python/tests/test_photo_align.py`

**Interfaces:**

- Consumes: Task 1 `proctree.memory_status`; Task 2 `flags.align_flags`; Task 4 `runner.find_odm`, `machine`, `run_odm`, `engine_record`, `WORK_ENV`, `nvcuda_present`; Task 5 `project.run_odm_dir`, `link_images`, `read_names`, `write_geo`, `GeoRow`; Task 6 `reconstruction.read_reconstruction`; Task 3 fake ODM (`FAKE_ODM_DROP` added below) and the `photo_mini` fixture of `conftest.py`.
- Produces (unchanged names other tasks import): `RUN_SCHEMA`, `ALIGN_SCHEMA`, `CAMERAS_SCHEMA`, `FRAME_SCHEMA`, `LIST_SCHEMA`, `RUN_ID`, `run_dir`, `read_manifest`, `hardware_probe`, `RunState`, `staged`, `photo_list`, `layer_meta`, `meta_record`, `meta_from`, `heights_rule`, `choose_crs`, `three_quaternion`, `write_sparse`, `encode_name`, `decode_name`, `frame_record`, `read_frame`, `read_sparse`, `read_photo_list`, `enu_to_grid_model`, `grid_to_enu_model`, `nadir_only_warning`, `cameras_sfm`, `photos_record`, `measure_points`, `merge_predictions`, `PhotoAlign`. New: `STAGES = ("inspect", "sfm", "georef", "report", "commit")`, `geo_rows(metas, H, links_by_key, gnss) -> list[GeoRow]`, `needs_geo(metas, H, params) -> bool`. `run.json` gains `engine` and `versions.odm`.

Also add to the fake (Task 3's file, owned here for this one addition): `FAKE_ODM_DROP=<link>,<link>` leaves those images out of the reconstruction it writes without a truth file.

- [ ] **Step 1: Write the failing tests** (`python/tests/test_photo_align.py`, replacing the old file; keep `test_three_quaternion_of_a_nadir_camera_looks_down`, `test_bad_photos_are_rejected_with_reasons_and_unaligned_ones_named` (adapted below), `test_changed_photos_refuse_the_resume`, `test_too_few_usable_photos_fail_clearly`, `test_a_missing_photos_layer_is_named` from the old file with their bodies, changed only to use the `odm` fixture)

```python
"""photo.align on the fake ODM (python/tests/fake_odm): photo reading, the ODM project, the run files."""

import json
import sys
import threading
import time
from pathlib import Path

import pytest

from aio_pipelines.photo import align as A
from aio_pipelines.photo.odm import runner as R
from aio_pipelines.runtime import Cancelled, JobError
from conftest import run_job

FAKE = Path(__file__).parent / "fake_odm"


@pytest.fixture
def odm(monkeypatch, tmp_path):
    monkeypatch.setenv("FAKE_ODM_PYTHON", sys.executable)
    monkeypatch.setenv(R.ODM_ENV, str(FAKE))
    monkeypatch.setenv("FAKE_ODM_UDP_PORT", "0")
    monkeypatch.setattr(R, "nvcuda_present", lambda env=None: False)  # the same on a GPU workstation
    log = tmp_path / "odm-args.jsonl"
    monkeypatch.setenv("FAKE_ODM_ARGS_LOG", str(log))
    return log


def _params(folder: Path, **kw) -> dict:
    return {"photos": {"folders": [str(folder)]}, "preset": "standard", "run": "r1", **kw}


def _linked(project: Path) -> set[str]:
    """File names of the photos inspection kept (they are the ones linked into the ODM project)."""
    names = json.loads((project / "photogrammetry" / "r1" / "odm" / "names.json").read_text())
    return {Path(k).name for k in names.values()}


def _no_gps(photo_set) -> set[str]:
    return {p["name"] for p in photo_set.truth["photos"] if "geotag" not in p}


def test_align_a_folder_end_to_end(odm, project, photo_mini):
    result, rec = run_job(A.PhotoAlign(), project, _params(photo_mini.photos))
    assert result["status"] == "done"
    base = project / "photogrammetry" / "r1"
    run = json.loads((base / "run.json").read_text())
    assert run["status"] == "aligned"
    assert [s["name"] for s in run["stages"]] == list(A.STAGES)
    assert all(s["state"] == "done" for s in run["stages"])
    assert run["engine"]["name"] == "odm" and run["engine"]["version"] == "3.6.2"
    assert run["versions"]["odm"] == "3.6.2"
    assert (base / "sparse" / "frame.json").is_file() and (base / "cameras-sfm.json").is_file()
    align = json.loads((base / "report" / "align.json").read_text())
    assert align["mapper"] == "opensfm"
    assert align["images"]["registered"] == len(_linked(project) - _no_gps(photo_mini))
    names = json.loads((base / "odm" / "names.json").read_text())
    assert sorted(names.values()) == sorted(run_key for run_key in json.loads((base / "sparse" / "photos.json").read_text())["photos"])
    args = json.loads(odm.read_text().splitlines()[-1])
    assert args[args.index("--end-with") + 1] == "opensfm" and "--rerun-from" not in args
    assert "--no-gpu" in args  # no CUDA driver on the test machine


def test_source_photos_are_linked_never_written(odm, project, photo_mini):
    before = {p: p.read_bytes() for p in photo_mini.photos.iterdir()}
    run_job(A.PhotoAlign(), project, _params(photo_mini.photos))
    assert {p: p.read_bytes() for p in photo_mini.photos.iterdir()} == before


def test_rtk_mode_writes_geo_txt_with_the_rtk_accuracy(odm, project, photo_mini):
    run_job(A.PhotoAlign(), project, _params(photo_mini.photos, gnss="rtk"))
    geo = (project / "photogrammetry" / "r1" / "odm" / "geo.txt").read_text().splitlines()
    assert geo[0] == "EPSG:4326" and len(geo) == 1 + len(_linked(project) - _no_gps(photo_mini))
    args = json.loads(odm.read_text().splitlines()[-1])
    assert args[args.index("--geo") + 1].endswith("geo.txt")


def test_photos_odm_could_not_place_are_named(odm, project, photo_mini, monkeypatch):
    monkeypatch.setenv("FAKE_ODM_DROP", "00001.jpg")
    run_job(A.PhotoAlign(), project, _params(photo_mini.photos))
    align = json.loads((project / "photogrammetry" / "r1" / "report" / "align.json").read_text())
    assert any(r["reason"] == "Not enough matches with other photos." for r in align["rejected"])


def test_the_gpu_used_is_recorded(odm, project, photo_mini, monkeypatch):
    monkeypatch.setattr(R, "nvcuda_present", lambda env=None: True)
    run_job(A.PhotoAlign(), project, _params(photo_mini.photos))
    run = json.loads((project / "photogrammetry" / "r1" / "run.json").read_text())
    assert run["engine"]["gpu"] == {"features": True}


def test_resume_after_a_cancel_in_odm_runs_odm_again_plainly(odm, project, photo_mini, monkeypatch, tmp_path):
    pids = tmp_path / "pids"
    monkeypatch.setenv("FAKE_ODM_HANG", "opensfm")
    monkeypatch.setenv("FAKE_ODM_PIDS", str(pids))
    cancel = threading.Event()

    def stop():
        for _ in range(600):
            if pids.exists():
                cancel.set()
                return
            time.sleep(0.1)

    threading.Thread(target=stop, daemon=True).start()
    with pytest.raises(Cancelled):
        run_job(A.PhotoAlign(), project, _params(photo_mini.photos), cancel=cancel)
    monkeypatch.delenv("FAKE_ODM_HANG")
    result, _ = run_job(A.PhotoAlign(), project, _params(photo_mini.photos))
    assert result["status"] == "done"
    assert "--rerun-from" not in json.loads(odm.read_text().splitlines()[-1])


def test_no_odm_is_a_plain_message_before_any_work(project, photo_mini, monkeypatch):
    monkeypatch.delenv(R.ODM_ENV, raising=False)
    with pytest.raises(JobError, match="Install it in Settings, Processing tools"):
        run_job(A.PhotoAlign(), project, _params(photo_mini.photos))
    assert not (project / "photogrammetry" / "r1" / "odm").exists()


def test_parameters_are_checked():
    p = A.PhotoAlign()
    with pytest.raises(JobError, match="photos, preset"):
        p.validate({})
    with pytest.raises(JobError, match="preset must be one of"):
        p.validate({"photos": {"folders": ["x"]}, "preset": "ultra"})
    # matching, mapper and maxImageSize are still accepted (older saved settings) and ignored
    assert p.validate({"photos": {"folders": ["x"]}, "preset": "fast", "mapper": "global"})["mapper"] == "global"
```

(`run_job(..., cancel=...)` is conftest's existing parameter. `photo_mini` is a `photo_synth.PhotoSet`: `.photos` is the photos folder and `.truth["photos"]` lists every shot with its `kind` (`nadir`, `blurred`, `duplicate`, `outlier`, `corrupt`, `no-gps`) and a `geotag` unless it is `no-gps`. Counts come from what inspection kept (`names.json`) minus the photos without GPS, which the fake cannot place.)

- [ ] **Step 2: Run to see it fail**

Run: `uv run --frozen pytest tests/test_photo_align.py -q`
Expected: FAIL (the old engine runs; `run["engine"]` is missing).

- [ ] **Step 3: Rewrite the engine parts of `align.py`.**

- Imports: drop `colmap_io` and the `B.bundle_adjust` use; keep `from . import bundle as B` for `B.triangulate` in `measure_points`; add `from .proctree import memory_status`, `from .odm import flags as OF`, `from .odm import project as OP`, `from .odm import runner as OR`, `from .odm.reconstruction import read_reconstruction`. Copy `engine_alias` from `colmap_io.py` into `align.py` (used by `encode_name`).
- `_convert_model(m, conv)`: its body becomes `reconstruction.convert_model(m, conv)` (Task 6), so the frame rule lives in one place.
- Delete: `PRESETS` (feature sizes), `MIN_REGISTERED_GLOBAL`, `GNSS_ADJUST_SIGMA_M`, `MAX_EXHAUSTIVE`, `FEATURE_*`, `MAX_FEATURE_THREADS`, `first_octave`, `feature_threads`, `initial_params`, `footprint_radius`, `choose_pairs`, `combine_models`, `engine_factory`, `_engine`, `_engine_job`, `_features`, `_match`, `_sfm` (old), `_georef` (old), `_names`.
- `STAGES = ("inspect", "sfm", "georef", "report", "commit")`; `plan()` weights `inspect 0.5, sfm 10, georef 0.5, report 0.5, commit 0.2`; titles `Read the photos`, `Align the photos (ODM)`, `Place the model`, `Report`, `Save the run`.
- `validate`: unchanged keys and checks; `matching`, `mapper`, `maxImageSize` accepted as before.
- `hardware_probe`: `memory_status` from `proctree`; `"cuda": OR.nvcuda_present()`; `"processing": "available" if (plat, arch) == ("win32", "x64") else "unsupported-platform"`.
- `needs_geo(metas, H, params)`: `True` when `params.get("ppk")`, or `params.get("gnss", "auto") != "auto"`, or any located photo whose `H[i]` differs from `m.altitude` by more than 1 mm.
- `geo_rows(metas, H, links_by_key, gnss)`: one `OP.GeoRow` per photo with GPS and a height: `(lon, lat, H[i], m.yaw, m.pitch, m.roll)` (`None` stays `None`: `write_geo` writes `nan`) and the accuracy `m.gnss_sigma(gnss)`, or `(50.0, 50.0)` when `gnss == "ignore"`.
- `_inspect`: first line `OR.find_odm()` (so a missing ODM fails before any work). Keep everything up to the run id and state; drop `groups[...]["params"]`, `maxImageSize`, `maxFeatures` from `work/photos.json` (keep `photos`, `heights`, `names`, `groupOf`, `groups` without params, `imageRoot`); camera groups keep `"calibration": "OPENCV"` until the report replaces it with ODM's model. After the run id: `odm_dir = OP.run_odm_dir(ctx.project, run)`; `links, copies = OP.link_images(odm_dir, [(m.key, m.path) for m in ok])`; when `copies`, `ctx.log(f"{copies} photos were copied into the ODM project (a link was not possible, e.g. another drive).")`; when `needs_geo(...)`, `OP.write_geo(odm_dir, geo_rows(ok, H, {v: k for k, v in links.items()} inverted to key -> link, gnss))`. When `matching`, `mapper` or `maxImageSize` were given, log once "ODM chooses matching and mapping itself; <names> are ignored."
- `_sfm`:

```python
    def _sfm(self, ctx: StepContext) -> dict[str, Any]:
        state = self._state(ctx)
        run = state["id"]
        odm = OR.find_odm()
        mc = OR.machine()
        odm_dir = OP.run_odm_dir(ctx.project, run)
        geo = odm_dir / "geo.txt"
        flags = OF.align_flags(state["preset"], mc.use_gpu, mc.threads, geo if geo.is_file() else None)
        ctx.log(f"ODM {odm.version}: {mc.threads} threads, graphics card {'on' if mc.use_gpu else 'off'}.")
        res = OR.run_odm(
            ctx, odm, odm_dir, flags, "dataset", "opensfm",
            ctx.project / run_dir(run) / "odm-logs" / f"{ctx.job.job_id}-sfm",
            rerun=False, use_gpu=mc.use_gpu,
        )  # fmt: skip
        data = RunState(ctx).load()
        data["engine"] = OR.engine_record(odm, res.gpu)
        data.setdefault("versions", {})["odm"] = odm.version
        RunState(ctx).save(data)
        return {"threads": mc.threads, "gpu": data["engine"]["gpu"]}
```

- `_georef` (new body): `state`, `enu` from `state["frames"]`; `rec = read_reconstruction(odm_dir, OP.read_names(odm_dir), enu)` with `odm_dir = OP.run_odm_dir(ctx.project, state["id"])`; warnings: `rec.groups > 1` gives `f"ODM aligned the photos in {rec.groups} separate groups; they are placed by GNSS only."`; `nadir_only_warning(rec.model)`; `georeferenced = any(m.has_gps for m in metas)`, and without it the warning "The photos have no GPS positions: the model is not georeferenced until ground control adjusts it."; `rec.model.save_npz(ctx.stage("work/aligned-enu.npz"))`; `work/georef.json` as before (`leftOut: []`) plus `"stats": {"reprojPx": rec.reproj_px, "trackLength": rec.track_length, "gsdCm": rec.gsd_cm}`; return `{"registered", "points", "georeferenced"}`.
- `_report`: unchanged except: the model has no observations, so `mean_err = geo["stats"]["reprojPx"] or 0.0`, `gsd = geo["stats"]["gsdCm"]` and `meanTrackLength = round(geo["stats"]["trackLength"] or 0, 2)` come from `work/georef.json`; and the `align` record has `"engine": state.get("engine")`, `"mapper": "opensfm"`, `"matching": "odm"`, no `"pairs"`.
- `_commit`: unchanged except the `work/engine/database.db` lines go; `run.json` keeps `engine` from the state.

- [ ] **Step 4: Run the tests**

Run: `uv run --frozen pytest tests/test_photo_align.py tests/test_gcp.py -q`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

```bash
git add python/src/aio_pipelines/photo/align.py python/tests/test_photo_align.py python/tests/fake_odm/fake_odm.py
git commit -m "feat(pipelines): photo.align runs odm" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: photo.georef on ODM, check points measured by us

**Files:**

- Modify: `python/src/aio_pipelines/photo/georef.py` (`_adjust` rewritten; `_report`, `_commit` kept)
- Rewrite: `python/tests/test_photo_georef.py`

**Interfaces:**

- Consumes: Task 2 `flags.georef_flags`, `GEOREF_STRATEGY`; Task 4 `runner.find_odm`, `machine`, `run_odm`, `engine_record`; Task 5 `project.run_odm_dir`, `write_gcp_list`, `write_geo`, `GeoRow`, `invalidate`, `GEOREF_INVALIDATE`, `read_names`; Task 6 `read_reconstruction`; Task 3 `products_synth.write_project(..., odm_bias=...)`, `odm_synth.gcp_doc` (below).
- Produces: `PhotoGeoref` with steps `adjust`, `report`, `commit` (names and outputs as today); `work/adjust.json` gains `"odm": {"gcpPoints": [...], "stats": <stats.json gcp part or null>}`.

Add to `odm_synth.py` (Task 3's file, owned here for this addition): `gcp_doc(model_enu: SparseModel, enu: C.EnuFrame, epsg: int, points: dict[str, tuple[float, float, float]], roles: dict[str, str]) -> dict`, an `aio.gcp/1` document whose marks are the true projections (`model.project_points`) of each point into every image that sees it inside the frame, `state: "confirmed"`, `by: "person"`.

- [ ] **Step 1: Write the failing tests** (`python/tests/test_photo_georef.py`)

```python
"""photo.georef on the fake ODM: the GCP list, ODM's adjustment, our check-point measurement."""

import json
import sys
from pathlib import Path

import numpy as np
import pytest

import odm_synth
import products_synth as ps
from aio_pipelines.photo.georef import PhotoGeoref
from aio_pipelines.photo.model import SparseModel
from aio_pipelines.photo.odm import runner as R
from aio_pipelines.runtime import JobError
from conftest import run_job

FAKE = Path(__file__).parent / "fake_odm"
BIAS = (0.3, -0.2, 1.5)
TARGETS = {"G1": "control", "G2": "control", "G3": "control", "G4": "control", "C1": "check", "C2": "check"}


@pytest.fixture
def run(tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_ODM_PYTHON", sys.executable)
    monkeypatch.setenv(R.ODM_ENV, str(FAKE))
    monkeypatch.setenv("FAKE_ODM_UDP_PORT", "0")
    monkeypatch.setenv("FAKE_ODM_ARGS_LOG", str(tmp_path / "args.jsonl"))
    root = tmp_path / "p"
    ps.write_project(root, ps.make_scene(step=0.15), odm_bias=BIAS)
    base = root / "photogrammetry" / ps.RUN
    truth = odm_synth.truth_model(base / "odm")  # the unbiased model in the run's ENU frame
    pts = dict(zip(TARGETS, ps.TARGET_POSITIONS))  # six surveyed positions in EPSG:32639
    gcp = odm_synth.gcp_doc(truth.model, truth.enu, ps.EPSG, pts, TARGETS)
    (base / "gcp.json").write_text(json.dumps(gcp))
    return root, base


def _accuracy(base: Path) -> dict:
    return json.loads((base / "report" / "accuracy.json").read_text())


def test_check_points_are_measured_through_odms_adjusted_cameras(run):
    root, base = run
    result, _ = run_job(PhotoGeoref(), root, {"run": ps.RUN})
    assert result["status"] == "done"
    acc = _accuracy(base)
    assert acc["checkpointsInAdjustment"] is False
    assert acc["rmse"]["check"]["horizontalM"] < 0.01 and acc["rmse"]["check"]["verticalM"] < 0.02
    assert json.loads((base / "run.json").read_text())["status"] == "adjusted"
    assert (base / "work" / "sparse-gnss").is_dir()


def test_the_gcp_list_holds_control_points_only(run):
    root, base = run
    run_job(PhotoGeoref(), root, {"run": ps.RUN})
    text = (base / "odm" / "gcp_list.txt").read_text()
    assert all(f" G{i}" in text for i in range(1, 5)) and " C1" not in text and " C2" not in text


def test_check_points_never_change_the_adjustment(run, tmp_path):
    root, base = run
    run_job(PhotoGeoref(), root, {"run": ps.RUN}, job_id="with")
    with_checks = SparseModel.load(base / "work" / "adjusted-enu.npz")
    gcp = json.loads((base / "gcp.json").read_text())
    gcp["points"] = [p for p in gcp["points"] if p["role"] == "control"]
    (base / "gcp.json").write_text(json.dumps(gcp))
    run_job(PhotoGeoref(), root, {"run": ps.RUN}, job_id="without")
    without = SparseModel.load(base / "work" / "adjusted-enu.npz")  # compared by value: npz files carry times
    for iid, im in with_checks.images.items():
        assert np.array_equal(im.R, without.images[iid].R) and np.array_equal(im.t, without.images[iid].t)
    assert np.array_equal(with_checks.xyz, without.xyz)


def test_a_control_point_far_off_the_others_is_left_out_and_named(run):
    root, base = run
    gcp = json.loads((base / "gcp.json").read_text())
    gcp["points"][0]["xyz"][0] += 1.0
    (base / "gcp.json").write_text(json.dumps(gcp))
    run_job(PhotoGeoref(), root, {"run": ps.RUN})
    assert " G1" not in (base / "odm" / "gcp_list.txt").read_text()
    assert any(w["code"] == "gcp-outlier" and w.get("point") == "G1" for w in _accuracy(base)["warnings"])


def test_without_gnss_the_photo_positions_barely_count(run):
    root, base = run
    run_job(PhotoGeoref(), root, {"run": ps.RUN, "useGnss": False})
    rows = (base / "odm" / "geo.txt").read_text().splitlines()[1:]
    assert rows and all(r.split()[-2:] == ["100.000", "100.000"] for r in rows)


def test_odm_runs_alignment_again_with_the_gcp_file(run, tmp_path):
    root, base = run
    run_job(PhotoGeoref(), root, {"run": ps.RUN})
    args = json.loads((tmp_path / "args.jsonl").read_text().splitlines()[-1])
    assert args[args.index("--gcp") + 1].endswith("gcp_list.txt")
    assert args[args.index("--end-with") + 1] == "opensfm"


def test_too_few_control_points_fail_plainly(run):
    root, base = run
    gcp = json.loads((base / "gcp.json").read_text())
    gcp["points"] = [p for p in gcp["points"] if p["id"] in ("G1", "G2", "C1")]
    (base / "gcp.json").write_text(json.dumps(gcp))
    with pytest.raises(JobError, match="At least three usable control points"):
        run_job(PhotoGeoref(), root, {"run": ps.RUN})
```

Add to `products_synth.write_project` (Task 9 owns these additions): each photo of `sparse/photos.json` gets `"gnss": {"lon", "lat", "h", "sigmaH": 0.5, "sigmaV": 1.0}` from its true camera centre (so `useGnss` has positions to weaken). Add to `odm_synth.py`: `truth_model(odm_dir) -> TruthModel(model, enu)` (reads `.fake/truth.json` back through `read_reconstruction`'s conventions; it may import Task 6's reader) and to `products_synth.py` the constant `TARGET_POSITIONS` (six positions inside the scene, on its ground: `[(ORIGIN[0] + dx, ORIGIN[1] + dy, ground(dx, dy) + ORIGIN[2])` for `(dx, dy)` in `(-30, -30), (30, -30), (30, 30), (-30, 30), (0, -10), (10, 5)`]; check the scene's extent in `make_scene` and keep the points inside it).

- [ ] **Step 2: Run to see it fail**

Run: `uv run --frozen pytest tests/test_photo_georef.py -q`
Expected: FAIL (the old bundle adjustment runs; no `gcp_list.txt`).

- [ ] **Step 3: Rewrite `_adjust`.** Keep the start (run status check, `gcp`, `grid_model, frame = read_sparse(...)`, `enu, grid = _frames(frame)`, `photos`, `surveyed`, `control`). Then:

```python
        odm_dir = OP.run_odm_dir(ctx.project, run)
        names = OP.read_names(odm_dir)
        links_by_key = {key: link for link, key in names.items()}
        model = grid_to_enu_model(grid_model, enu, grid)
        by_name = {im.name: im.id for im in model.images.values()}
        measured, short = _measure(model, control, by_name)
        sigma = {p["id"]: (p["accuracy"]["horizontalM"], p["accuracy"]["verticalM"]) for p in control if p["id"] in measured}
        outliers = G.control_outliers({i: measured[i][0] for i in sigma}, {i: surveyed[i] for i in sigma}, sigma) if len(sigma) >= 4 else []
        out_ids = {o.id for o in outliers}
        warnings = [...]  # one "gcp-outlier" warning per outlier, as today
        gcp_list = OP.write_gcp_list(odm_dir, gcp, links_by_key, out_ids)
        if params.get("useGnss", True) is False:
            OP.write_geo(odm_dir, [
                OP.GeoRow(links_by_key[k], g["gnss"]["lon"], g["gnss"]["lat"], g["gnss"]["h"], None, None, None, 100.0, 100.0)
                for k, g in photos.items() if g.get("gnss") and k in links_by_key
            ])  # fmt: skip
        geo = odm_dir / "geo.txt"
        odm, mc = OR.find_odm(), OR.machine()
        log_dir = ctx.project / run_dir(run) / "odm-logs" / f"{ctx.job.job_id}-adjust"
        strategy = OF.GEOREF_STRATEGY
        if strategy == "invalidate" and not (log_dir / "odm.log").exists() and not (log_dir / "tool.out").exists():
            OP.invalidate(odm_dir, OP.GEOREF_INVALIDATE)
        res = OR.run_odm(
            ctx, odm, odm_dir, OF.georef_flags(state["preset"], mc.use_gpu, mc.threads, odm_dir / "gcp_list.txt", geo if geo.is_file() else None),
            "opensfm", "opensfm", log_dir, rerun=strategy == "rerun-from", use_gpu=mc.use_gpu, progress=(0.0, 0.9),
        )  # fmt: skip
        rec = read_reconstruction(odm_dir, names, enu)
        rec.model.save_npz(ctx.stage("work/adjusted-enu.npz"))
        gcp_stats = (rec.stats or {}).get("gcp_errors")
        if gcp_stats:
            ctx.log(f"ODM's own ground control errors: {json.dumps(gcp_stats)[:1500]}")
        atomic_write_json(ctx.stage("work/adjust.json"), {
            "warnings": warnings, "outliers": sorted(out_ids), "used": gcp_list.points, "short": short,
            "gnss": params.get("useGnss", True) is not False, "gnssShiftEnuM": [0.0, 0.0, 0.0],
            "iterations": 0, "odm": {"gcpPoints": gcp_list.points, "stats": gcp_stats},
            "stats": {"reprojPx": rec.reproj_px, "gsdCm": rec.gsd_cm},
        })  # fmt: skip
```

Keep the run-state stage bookkeeping at the end of `_adjust` as today and store `data["engine"] = OR.engine_record(odm, res.gpu)` there. `_report` is unchanged (it measures every point, control and check, through `work/adjusted-enu.npz`, which now holds ODM's cameras) except that `mean_reproj_px` and `gsd` come from `adj["stats"]` (the model has no observations). With `GEOREF_STRATEGY = "invalidate"` (C12) the ODM call runs without `--rerun-from`; ODM finds `geo.txt` in the project folder by itself. `_commit` additionally copies `odm/odm_report/stats.json`, when present, to `report/odm-stats.json` (staged, committed with the others). Remove the `B.` uses other than `B.triangulate` (`similarity_ransac`, `similarity`, `apply_similarity`, `CameraPrior`, `ControlPoint`, `select_points`, `bundle_adjust`, `refine_all_points`) and the "not georeferenced" similarity branch (ODM georeferences by the GCPs itself). Update the module docstring: "`adjust` writes `gcp_list.txt` (confirmed marks of the control points that are not switched off or outliers) and has ODM align again with it; `report` measures every point, control and check, through ODM's adjusted cameras; checkpoints never reach ODM."

- [ ] **Step 4: Run the tests**

Run: `uv run --frozen pytest tests/test_photo_georef.py tests/test_gcp.py -q`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

```bash
git add python/src/aio_pipelines/photo/georef.py python/tests/test_photo_georef.py python/tests/odm_synth.py python/tests/products_synth.py
git commit -m "feat(pipelines): photo.georef has odm adjust with ground control" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: photo.products on ODM

**Files:**

- Modify: `python/src/aio_pipelines/photo/products.py` (rewrite; keep `pyramid_index`, `_pyramid`, the layer building and manifest code of `_commit`, `_tiles`, `_note_run`, `_timed`)
- Rewrite: `python/tests/test_photo_products.py`
- Modify: `python/tests/test_opf.py:282` (an imported run is now refused by products: `pytest.raises(JobError, match="use Create maps again")`, deviation 8)
- Create: `python/tests/test_odm_real.py` (opt-in)

**Interfaces:**

- Consumes: Task 2 `flags.product_steps`, `dense_first`, `products_flags`, `OdmStep`; Task 4 `runner.find_odm`, `machine`, `run_odm`, `engine_record`, `GpuUse`; Task 5 `project.run_odm_dir`, `has_alignment`, `write_boundary`, `clean_intermediates`; Task 7 `outputs.*`; `surface.to_cog`, `shaded_tif`, `write_height_grid`; `native.check_disk`, `memory_budget`; Task 3 `products_synth.write_project`.
- Produces: `PhotoProducts` with `validate` keys `run, products, preset, gsdCm, region, capture, meshTriangles` (no `dense`), steps `prepare`, then `product_steps(products)` names, then `commit`, then `tiles` when asked; `OLD_RUN` (message); `LAYOUT = 3`; `report/products.json` with `engines: {"odm": <version>}`, `gpu`, `gsdCm: {ortho, dsm}`; `run.json` `engine` and `versions.odm`.

- [ ] **Step 1: Write the failing tests** (`python/tests/test_photo_products.py`)

```python
"""photo.products on the fake ODM: ODM's calls per step, the imported layers, the run record."""

import json
import sys
from pathlib import Path

import numpy as np
import pytest

import products_synth as ps
from aio_pipelines.photo import products as P
from aio_pipelines.photo.odm import flags as OF
from aio_pipelines.photo.odm import runner as R
from aio_pipelines.pointcloud import find_pdal
from aio_pipelines.runtime import JobError
from conftest import run_job

FAKE = Path(__file__).parent / "fake_odm"
NO_PDAL = pytest.mark.skipif(find_pdal() is None, reason="PDAL is not on this machine")


@pytest.fixture
def site(tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_ODM_PYTHON", sys.executable)
    monkeypatch.setenv(R.ODM_ENV, str(FAKE))
    monkeypatch.setenv("FAKE_ODM_UDP_PORT", "0")
    monkeypatch.setenv("FAKE_ODM_ARGS_LOG", str(tmp_path / "args.jsonl"))
    root = tmp_path / "p"
    ps.write_project(root, ps.make_scene(step=0.1))
    return root, tmp_path / "args.jsonl"


def _calls(log: Path) -> list[list[str]]:
    return [json.loads(x) for x in log.read_text().splitlines()]


def _arg(call: list[str], flag: str) -> str:
    return call[call.index(flag) + 1]


def test_steps_follow_the_products():
    names = lambda prods: [s.name for s in P.PhotoProducts().plan({"run": "r", "products": prods})]  # noqa: E731
    assert names(["ortho"]) == ["prepare", "dense", "cloud", "dsm", "ortho", "commit"]
    assert names(["mesh", "tiles"]) == ["prepare", "dense", "mesh", "texture", "cloud", "dsm", "ortho", "commit", "tiles"]


def test_dense_is_refused_now():
    with pytest.raises(JobError, match="dense"):
        P.PhotoProducts().validate({"run": "r", "products": ["ortho"], "dense": "cpu"})


def test_ortho_dsm_dtm_and_mesh_become_layers(site):
    root, log = site
    result, _ = run_job(P.PhotoProducts(), root, {"run": ps.RUN, "products": ["ortho", "dsm", "dtm", "mesh"], "preset": "standard"})
    assert result["status"] == "done"
    manifest = json.loads((root / "manifest.json").read_text())
    ids = {x["id"] for x in manifest["layers"]}
    assert {f"{ps.RUN}-ortho", f"{ps.RUN}-dsm", f"{ps.RUN}-dtm", f"{ps.RUN}-mesh"} <= ids
    for rel in (f"rasters/{ps.RUN}-ortho/tiles.json", f"rasters/{ps.RUN}-dsm/tiles.json", f"sources/{ps.RUN}-dsm.json",
                f"models/{ps.RUN}-mesh.glb", f"photogrammetry/{ps.RUN}/dsm.tif", f"photogrammetry/{ps.RUN}/ortho.tif",
                f"photogrammetry/{ps.RUN}/report/odm-report.pdf"):  # fmt: skip
        assert (root / rel).is_file(), rel
    run = json.loads((root / "photogrammetry" / ps.RUN / "run.json").read_text())
    assert run["status"] == "done" and run["engine"]["name"] == "odm" and run["versions"]["odm"] == "3.6.2"
    report = json.loads((root / "photogrammetry" / ps.RUN / "report" / "products.json").read_text())
    assert report["engines"] == {"odm": "3.6.2"}
    odm = root / "photogrammetry" / ps.RUN / "odm"
    assert not (odm / "openmvs").exists() and (odm / "opensfm").is_dir()  # intermediates gone, alignment kept
    calls = _calls(log)
    dense = next(c for c in calls if _arg(c, "--end-with") == "odm_filterpoints")
    assert _arg(dense, "--rerun-from") == "openmvs" and "--skip-3dmodel" not in dense
    assert [_arg(c, "--end-with") for c in calls] == ["odm_filterpoints", "odm_meshing", "mvs_texturing", "odm_georeferencing", "odm_dem", "odm_postprocess"]


def test_the_dsm_has_the_scenes_heights(site):
    root, _ = site
    run_job(P.PhotoProducts(), root, {"run": ps.RUN, "products": ["dsm"], "preset": "standard"})
    import rasterio

    with rasterio.open(root / "photogrammetry" / ps.RUN / "dsm.tif") as ds:
        z = ds.read(1)
        rows, cols = np.mgrid[ds.height // 4 : 3 * ds.height // 4 : 7, ds.width // 4 : 3 * ds.width // 4 : 7]
        xs, ys = rasterio.transform.xy(ds.transform, rows.ravel(), cols.ravel())
    got = z[rows.ravel(), cols.ravel()]
    want = ps.dsm(np.array(xs) - ps.ORIGIN[0], np.array(ys) - ps.ORIGIN[1]) + ps.ORIGIN[2]
    assert float(np.nanmedian(np.abs(got - want))) < 0.2


def test_fast_and_resolution_flags(site):
    root, log = site
    run_job(P.PhotoProducts(), root, {"run": ps.RUN, "products": ["ortho"], "preset": "fast", "gsdCm": 3.0})
    dense = _calls(log)[0]
    assert _arg(dense, "--rerun-from") == OF.FAST_FIRST_STAGE and "--fast-orthophoto" in dense
    assert _arg(dense, "--orthophoto-resolution") == "3" and _arg(dense, "--dem-resolution") == "6"
    assert "--skip-3dmodel" in dense


def test_fast_leaves_the_3d_model_out(site):
    root, _ = site
    names = [s.name for s in P.PhotoProducts().plan({"run": ps.RUN, "products": ["ortho", "mesh"], "preset": "fast"})]
    assert "mesh" not in names and "texture" not in names
    result, rec = run_job(P.PhotoProducts(), root, {"run": ps.RUN, "products": ["ortho", "mesh"], "preset": "fast"})
    assert result["status"] == "done"
    assert not (root / "models" / f"{ps.RUN}-mesh.glb").exists()
    assert any("makes no 3D model" in m.get("message", "") for m in rec.of("log"))


@NO_PDAL
def test_the_point_cloud_becomes_copc(site):
    root, _ = site
    run_job(P.PhotoProducts(), root, {"run": ps.RUN, "products": ["cloud"], "preset": "standard"})
    layer = next(x for x in json.loads((root / "manifest.json").read_text())["layers"] if x["id"] == f"{ps.RUN}-cloud")
    assert layer["format"] == "copc" and layer["pointCount"] > 1000
    assert (root / "clouds" / f"{ps.RUN}.copc.laz").is_file()


def test_a_run_without_an_odm_project_is_refused_plainly(site):
    root, _ = site
    import shutil

    shutil.rmtree(root / "photogrammetry" / ps.RUN / "odm")
    with pytest.raises(JobError, match="use Create maps again"):
        run_job(P.PhotoProducts(), root, {"run": ps.RUN, "products": ["ortho"]})


def test_a_gpu_fallback_is_a_warning_in_the_report(site, monkeypatch):
    root, _ = site
    monkeypatch.setattr(R, "nvcuda_present", lambda env=None: True)
    monkeypatch.setenv("FAKE_ODM_GPU", "dense-fallback")
    result, _ = run_job(P.PhotoProducts(), root, {"run": ps.RUN, "products": ["ortho"], "preset": "standard"})
    assert result["status"] == "done"
    report = json.loads((root / "photogrammetry" / ps.RUN / "report" / "products.json").read_text())
    assert report["gpu"]["dense"] is False and any("CPU" in w for w in report["warnings"])


def test_a_layer_this_run_did_not_make_is_not_replaced(site):
    root, _ = site
    m = json.loads((root / "manifest.json").read_text())
    m["layers"].append({"kind": "raster", "id": f"{ps.RUN}-ortho", "name": "Mine", "src": {"path": "x"}})
    (root / "manifest.json").write_text(json.dumps(m))
    with pytest.raises(JobError, match="rename it first"):
        run_job(P.PhotoProducts(), root, {"run": ps.RUN, "products": ["ortho"]})


def test_mesh_tiles(site):
    root, _ = site
    run_job(P.PhotoProducts(), root, {"run": ps.RUN, "products": ["mesh", "tiles"], "preset": "standard"})
    run = json.loads((root / "photogrammetry" / ps.RUN / "run.json").read_text())
    assert f"{ps.RUN}-mesh" in run["outputs"]["tilesets"]
```

`python/tests/test_odm_real.py` (opt-in, the real engine on real photos; never in CI):

```python
"""The real ODM on real photos: set AIO_ODM (an installed ODM folder) and AIO_ODM_REAL_PHOTOS (a
folder of about 30 drone photos). Skipped otherwise. Runs align and products (Fast) for real."""

import json
import os
from pathlib import Path

import pytest

from aio_pipelines.photo.align import PhotoAlign
from aio_pipelines.photo.products import PhotoProducts
from conftest import run_job

PHOTOS = os.environ.get("AIO_ODM_REAL_PHOTOS")
pytestmark = pytest.mark.skipif(not (PHOTOS and os.environ.get("AIO_ODM")), reason="real ODM run is opt-in")


def test_real_odm_aligns_and_makes_an_orthophoto(project):
    result, _ = run_job(PhotoAlign(), project, {"photos": {"folders": [PHOTOS]}, "preset": "fast", "run": "real"})
    assert result["status"] == "done"
    result, _ = run_job(PhotoProducts(), project, {"run": "real", "products": ["ortho", "dsm"], "preset": "fast"}, job_id="j2")
    assert result["status"] == "done"
    run = json.loads((project / "photogrammetry" / "real" / "run.json").read_text())
    print("engine:", run["engine"])
    assert (project / "photogrammetry" / "real" / "ortho.tif").is_file()
```

- [ ] **Step 2: Run to see it fail**

Run: `uv run --frozen pytest tests/test_photo_products.py -q`
Expected: FAIL (the old steps run).

- [ ] **Step 3: Rewrite `products.py`.**

- Module docstring: the step table becomes `prepare` (run and ODM checks, resolutions, threads, GPU, disk, boundary), `dense` (ODM openmvs to odm_filterpoints; Fast from `FAST_FIRST_STAGE`), `mesh` and `texture` (ODM odm_meshing, mvs_texturing; the GLB layer), `cloud` (ODM to odm_georeferencing; the COPC layer), `dsm` (ODM odm_dem; the DSM and DTM layers), `ortho` (ODM to the end; the ortho layer and ODM's report), `commit`, `tiles`; intermediates in `photogrammetry/<run>/work/products/`.
- Remove: `SCALE`, `DEFAULT_TRIANGLES`, `CUDA_MISSING`, `NO_DENSE_POINTS`, `NOTHING_FUSED`, `LEGACY_*`, `depth_key`, `fuse_key`, `merge_key`, `legacy_cleanup`, `_Images`, `_region_poly`, `_run`, `_work`, `_depth_dir`, `_tiles_store`, `_dense`, `_fuse`, `_dsm`, `_dtm`, `_cloud`, `_ortho`, `_mesh`, `_texture`, `_surface_layer` and every import of `dense`, `fuse`, `mesh`, `texture`, `budget`, `pool`, `ortho`, `scene`.
- Constants: `LAYOUT = 3`; `STAGES = ("dense", "mesh", "texture", "cloud", "dsm", "ortho", "commit", "tiles")` (the stages `run.json` records; `prepare` stays out, as today, because `PhotoStageName` has no `prepare`); `OLD_RUN = "This run was aligned by an earlier version or imported; use Create maps again to process the photos with ODM."`; `DISK_FACTOR = {"fast": 3, "standard": 6, "high": 10}` (free space needed, times the bytes of `odm/images/`).
- `validate`: today's body without `dense` (`known_keys` refuses it, naming it).
- `plan`: `[Step("prepare", "Check the run and plan the products", _timed(self._prepare), 0.5), *[Step(s.name, s.title, _timed(self._odm_step(s)), s.weight) for s in OF.product_steps(set(params["products"]))], Step("commit", ...), *([Step("tiles", ...)] if "tiles" in want else [])]`.
- Fast makes no 3D model (founder ruling, 14 Oct): when the preset is `fast` and `mesh` or `tiles` was asked, `plan` (preset given in params) and `_prepare` (preset from `run.json`) drop them, with the job-log line "The Fast preset makes no 3D model; mesh and 3D Tiles are left out."; `_prepare` stores the products it will make as `s["products"]` and every import and `_commit` read that, not `ctx.params["products"]`.
- `_prepare`: read `run.json` (status in `aligned`, `adjusted`, `done`, else `JobError(f'Run "{run}" is not aligned yet.')`); `odm_dir = OP.run_odm_dir(ctx.project, run)`; `not OP.has_alignment(odm_dir)` gives `JobError(OLD_RUN)`; `odm = OR.find_odm()`; `mc = OR.machine()`; `preset = p.get("preset") or doc.get("preset") or "standard"`; `epsg = C.crs_of(doc["crs"]).to_epsg()`; `origin = manifest["origin"]` (`JobError("The project has no origin, so the products cannot be placed.")` without one); `ortho_cm = p.get("gsdCm") or align.json "gsdCm" or 5.0`; `dem_cm = 2 * ortho_cm`; boundary via `OP.write_boundary(odm_dir, p["region"])` when `region`; `need = images_bytes * DISK_FACTOR[preset]`, `native.check_disk(ctx.project, need)`; `args = OF.products_flags(preset, set(p["products"]), mc.use_gpu, mc.threads, ortho_cm, dem_cm, p.get("meshTriangles"), boundary)`; log `f"ODM {odm.version}, preset {preset}: ortho {ortho_cm:g} cm, DEM {dem_cm:g} cm, {mc.threads} threads, graphics card {'on' if mc.use_gpu else 'off'}."`; return `{"layout": LAYOUT, "preset", "odmDir": str(odm_dir), "epsg", "origin", "orthoResCm", "demResCm", "threads", "gpu": mc.use_gpu, "args": args, "disk": {...}, "memoryBudgetBytes": native.memory_budget(), "version": odm.version}`.
- `_settings(ctx)`: the prepare outputs; `layout != LAYOUT` gives `JobError(OLD_LAYOUT)` (kept message).
- `_odm_step(step)` returns the step function:

```python
    def _odm_step(self, step: OF.OdmStep):
        def run(ctx: StepContext) -> dict[str, Any]:
            s = self._settings(ctx)
            first = OF.dense_first(s["preset"]) if step.name == "dense" else step.first
            odm_dir = Path(s["odmDir"])
            res = OR.run_odm(
                ctx, OR.find_odm(), odm_dir, s["args"], first, step.last,
                ctx.project / f"photogrammetry/{ctx.params['run']}/odm-logs/{ctx.job.job_id}-{step.name}",
                rerun=True, use_gpu=s["gpu"], progress=(0.0, 0.7),
            )  # fmt: skip
            # "gpuFallbacks", never "fallbacks": a PhotoStage's "fallbacks" is a number in the schema
            out = {"gpu": {"features": res.gpu.features, "dense": res.gpu.dense}, "gpuFallbacks": res.gpu.fallbacks}
            out.update(IMPORTS.get(step.name, _nothing)(self, ctx, s, odm_dir))
            return out

        return run
```

with `IMPORTS = {"texture": _import_mesh, "cloud": _import_cloud, "dsm": _import_dems, "ortho": _import_ortho}`, each `(self, ctx, s, odm_dir) -> dict` doing its work only when its product was asked for (`"mesh"`/`"tiles"`, `"cloud"`, `"dsm"`/`"dtm"`, `"ortho"`), progress from 0.7 to 1.0:

- `_import_mesh`: `data, info = OU.mesh_to_glb(odm_dir, s["epsg"], np.array(s["origin"]))`; each of `info.get("warnings", [])` goes to the job log as a warning; stage `models/<run>-mesh.glb` when `mesh` was asked, and `photogrammetry/<run>/mesh/full.glb` when `tiles` was; return `{"triangles": info["triangles"], "meshSource": info["source"]}`.
- `_import_cloud`: first, always: the ground check. With PDAL found (`pointcloud.find_pdal()`), `pdal info --stats --enumerate Classification <odm_georeferencing/odm_georeferenced_model.laz>`; when class 2 is not among the values, `ground = 0`, a warning "ODM found no ground points in this cloud, so no terrain model (DTM) is made." and the step output `{"ground": 0}`; the `dsm` step then runs with `[a for a in s["args"] if a != "--dtm"]` and makes no DTM layer (renderdem would never finish on zero ground points). Without PDAL the check is skipped (the runner's watchdog and ground-failure guard remain). Then, when the cloud was asked: `OU.cloud_to_copc(ctx, odm_dir, ctx.stage(f"clouds/{run}.copc.laz"), s["epsg"], work / "cloud", native.memory_budget())`; return `{"points", "writer", "ground"}`.
- `_import_dems`: always `groundZ = OU.ground_height(proj)` of the DSM; for each of `dsm`, `dtm` asked: `spec = OU.dem_to_project(OU.output_path(odm_dir, OU.DSM or OU.DTM), work / f"{which}.tif", s["epsg"])`, then exactly today's `_surface_layer` body with `run.epsg` replaced by `s["epsg"]`, `run.origin` by `np.array(s["origin"])`, `run.id` by `ctx.params["run"]`, `self._work(ctx)` by `work`, `y = groundZ - origin[2]` and `raw = work / f"{which}.tif"`; return `{"groundZ", "layers": [...]}`.
- `_import_ortho`: when `ortho` was asked: `src = OU.ortho_to_project(OU.output_path(odm_dir, OU.ORTHO), work / "ortho.tif", s["epsg"])`, `to_cog(src, ctx.stage(f"photogrammetry/{run}/ortho.tif"))`, `_pyramid(ctx, src, f"rasters/{run}-ortho", origin, epsg, y, res, {"source": "ortho.tif"})` with `y = ctx.outputs("dsm")["groundZ"] - origin[2]` and `res` the ortho's pixel size; always: copy `OU.REPORT_PDF` and `OU.STATS`, when present, to staged `photogrammetry/<run>/report/odm-report.pdf` and `report/odm-stats.json`.
  `work = ctx.project / f"photogrammetry/{run}/work/products"`.
- `_commit`: today's code with `self._run(ctx)` replaced by values from `_settings` and `run.json`; `files` also gets `report/odm-report.pdf` and `report/odm-stats.json` when staged; `run.json` gets `doc["engine"] = OR.engine_record(OR.OdmInstall(Path(), s["version"]), gpu)` where `gpu` merges the steps' `gpu` (`GpuUse.merge`), `doc["versions"]["odm"] = s["version"]`, no `accelerator`/`opencv`; after `run.json` is written, `freed = OP.clean_intermediates(odm_dir)` and log `f"Removed {native._gb(freed)} of ODM's intermediate files."`.
- `_report`: `schema`, `run`, `createdAt`, `preset`, `products`, `layers`, `gsdCm: {"ortho": s["orthoResCm"], "dsm": s["demResCm"]}`, `engines: {"odm": s["version"]}`, `gpu` (merged), `cloud: {"points", "writer"}` when made, `mesh: {"triangles", "source"}` when made, `stages` (as today, from `_timed`, over `STAGES`; copy no `fallbacks` or `device` key into a stage record), `memoryPeakBytes`, `memoryBudgetBytes`, `disk`, `warnings` (every `gpuFallbacks` message of the steps, once each).
- `_tiles`, `_note_run`: unchanged except that the run id comes from `ctx.params["run"]` and the run folder from `ctx.project`.
- `inputs`: unchanged (`photogrammetry/<run>/sparse`).

- [ ] **Step 4: Run the tests**

Run: `uv run --frozen pytest tests/test_photo_products.py tests/test_opf.py tests/test_odm_real.py tests/test_tiles.py -q`
Expected: PASS (`test_odm_real.py` skipped; the cloud test skipped without PDAL).

- [ ] **Step 5: Real run (opt-in, when Task 0 left ODM installed or with the founder's go).** With `AIO_ODM` set to an installed ODM and `AIO_ODM_REAL_PHOTOS` to a folder of about 30 public sample photos (Task 0's scratch `proj/aukerman/images`): `uv run --frozen pytest tests/test_odm_real.py -q -s`. Expected: PASS, and the printed `engine.gpu` says what the RTX 5070 Ti did. Report it in the hand-off.

- [ ] **Step 6: Lint and commit**

```bash
git add python/src/aio_pipelines/photo/products.py python/tests/test_photo_products.py python/tests/test_odm_real.py python/tests/test_opf.py
git commit -m "feat(pipelines): photo.products runs odm and imports its outputs" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Delete the old engine

**Files:**

- Delete: `python/src/aio_pipelines/photo/{colmap_io,dense,fuse,ortho,mesh,texture,pool,card,gpu_match,merge,budget}.py`, `python/src/aio_pipelines/accel.py`; `python/tests/{test_photo_dense,test_photo_card,test_photo_card_job,test_photo_pool,test_photo_merge,test_photo_mesh,test_photo_ortho,test_photo_gpu_match,test_photo_engine,test_photo_budget,test_accel,test_photo_chain}.py`
- Modify: `python/src/aio_pipelines/photo/bundle.py` (keep `similarity`, `apply_similarity`, `similarity_ransac`, `triangulate` and what they call; delete `refine_points`, `CameraPrior`, `ControlPoint`, `AdjustResult`, `select_points`, `_Problem`, `_solve_reduced`, `bundle_adjust`, `refine_all_points`, `supported`, `REFINE_BLOCK`), `photo/surface.py` (delete `cell_stat`, `fill_near`, `push_pull`, `harmonic_fill`, `smrf_ground`, `dtm_from`, `grid_points`, `coarse_spec`, `dtm_grid`, `dtm_coarse` and the top-level `from .fuse import PointTiles`), `photo/cloud_out.py` (delete `classify`, `DtmSampler`, `_las_header`, `write_las` and the `.fuse` import; keep `untwine_args`, `pdal_copc_pipeline`, `untwine_progress`, `write_copc`, `_run_copc`, `NO_COPC_TOOL`), `photo/native.py` (drop `texrecon`, `PoissonRecon`, `SurfaceTrimmer` from `TOOLS` and the docstring table), `python/tests/{test_photo_bundle,test_photo_model,test_photo_surface,test_photo_cloud_out,test_photo_runs,test_proctree}.py` (in `test_proctree.py`, delete `test_colmap_io_still_offers_the_moved_names`), `.github/workflows/ci.yml` (python matrix ~319-390: drop the part `photo-chain`, its `case` line and the comment about `test_photo_chain.py`), `tools/ci/pytest-parts.test.mjs` (parts `photo` and `rest` only), `python/tests/photo_g2_synth.py`, `python/tests/products_synth.py` (imports only), `python/pyproject.toml` (version `0.8.0`; remove the `pymeshlab` line), `python/uv.lock` (`uv lock`), `tools/pipeline-pack/build.mjs` (remove `MESH_PROBE` and its use, l.91-125, 430, the pymeshlab parts of the summary l.455-506; keep `COLMAP_PROBE`, walks need it), `tools/pipeline-pack/build.test.mjs`

**Interfaces:**

- Consumes: Tasks 1, 8, 9, 10 (nothing imports the deleted modules any more).
- Produces: a pack without our engine; `aio_pipelines.__version__` `0.8.0` once installed.

- [ ] **Step 1: Find every remaining use**

Run (from the worktree): `git grep -nE "colmap_io|photo\.(dense|fuse|ortho|mesh|texture|pool|card|gpu_match|merge|budget)\b|from \.(dense|fuse|ortho|mesh|texture|pool|card|gpu_match|merge|budget) |aio_pipelines\.accel|from \.\.accel|pymeshlab|SyntheticEngine|FakeJob" -- python tools apps/desktop/e2e`
Expected: hits only in the files listed above, in `apps/desktop/e2e/photoPack.ts` (Task 18), and these known, harmless ones: `road/pipeline.py`, `road/units.py`, `volumetric/build.py` (their own packages' `.ortho`), `tests/test_licences.py`, `tools/release/{licence-exceptions.json,native-libs.json,native-licences.test.mjs,notices.mjs}` (licence text; Task 17 regenerates the notices). Any other hit: stop and report it.

- [ ] **Step 2: Rewrite the synthetic engine fixture.** In `photo_g2_synth.py` replace `SyntheticEngine` and `FakeJob` with one function `synthetic_model(scene, noise_px: float = 0.3, seed: int = 0) -> SparseModel` (the reconstruction `SyntheticEngine.map` returned: true cameras and points, observations with Gaussian pixel noise, in the scene's frame); keep `synthetic_jpeg`, `make_scene`, `write_gcp_files`, `render_nadir_set`. Change `test_photo_model.py` and `test_photo_bundle.py` to build their models with it; delete from `test_photo_bundle.py` the tests of the deleted functions (keep `similarity`, `similarity_ransac`, `triangulate`). In `test_photo_surface.py` and `test_photo_cloud_out.py` delete the tests of deleted functions and keep the rest. In `test_photo_runs.py` keep the run-file tests (`encode_name`/`decode_name`, `read_sparse`, run ids, `load_run`) and delete those that drive `ColmapEngine` or `MemoryExceeded`. (`test_opf.py` was changed by Task 10.)

- [ ] **Step 3: Delete, trim, bump.** Delete the files; trim the modules as listed; `pyproject.toml` `version = "0.8.0"` and remove `"pymeshlab==2025.7.post1; ..."`; run `uv lock` in `python/` (commit the lock); edit `build.mjs` and its test.

- [ ] **Step 4: Run the whole Python suite and the pack build test**

Run: `uv run --frozen pytest -q` (from `python/`), `node --test tools/pipeline-pack/build.test.mjs` and `pnpm exec vitest run tools/ci/pytest-parts.test.mjs`
Expected: PASS. Then `git grep` of Step 1 finds nothing outside `apps/desktop/e2e/photoPack.ts`.

- [ ] **Step 5: Lint and commit**

```bash
git add -u python tools/pipeline-pack/build.mjs tools/pipeline-pack/build.test.mjs tools/ci/pytest-parts.test.mjs .github/workflows/ci.yml
git add python/uv.lock python/pyproject.toml
git commit -m "chore(pipelines): delete our own photogrammetry engine" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(`git add -u <paths>` stages the deletions and edits under those paths only.)

---

### Task 11: Schema contract

**Files:**

- Create: `packages/schema/src/odm.ts`, `packages/schema/src/odm.test.ts`, `tools/compat/odm-additive.test.mjs`
- Modify: `packages/schema/src/index.ts` (export `./odm`), `packages/schema/src/ipc.ts` (the `odm:*` channels after the `pipelinePack:*` ones at ~2966; the `odm:progress` event after `pipelinePack:progress` at ~3213; `Settings` at 301-350 gains `processing`), `packages/schema/src/photogrammetry.ts` (`HardwareProbe.processing` at ~187 gains `no-engine`; `HardwareProbe.engine`; `cuda` comment; `accelerator` comment "no longer written"; `PhotoRun.engine` at ~219; `PhotoStageName` comment lists the new steps), `packages/schema/src/jobs.ts:681-697` (`PhotoProductsParams` without `dense`), `packages/schema/src/versions.ts` (registry row `aio.odm-install`), `packages/schema/src/m10.test.ts:549`, `apps/desktop/src/preload/index.ts:240-268`, `docs/architecture/contract-changes.md` (the two rows of "Contract change", verbatim)

**Interfaces:**

- Consumes: nothing.
- Produces (`@aio/schema`):

```ts
// packages/schema/src/odm.ts
import { z } from 'zod';
import { IsoTime } from './common';

/** `processing.odm.gpu`: `auto` uses an NVIDIA card when ODM can, `off` keeps ODM on the CPU. */
export const OdmGpuSetting = z.enum(['auto', 'off']);
export type OdmGpuSetting = z.infer<typeof OdmGpuSetting>;

/** Settings, Processing: the photogrammetry engine's options. Absent: `auto`. */
export const ProcessingSettings = z
  .object({ odm: z.object({ gpu: OdmGpuSetting.optional() }).strict().optional() })
  .strict();
export type ProcessingSettings = z.infer<typeof ProcessingSettings>;

export const OdmState = z.enum([
  'unsupported',
  'not-installed',
  'installing',
  'installed',
  'update-available',
  'broken',
]);
export type OdmState = z.infer<typeof OdmState>;

/** `<dataRoot>/runtime/odm.json` (`aio.odm-install/1`): the ODM this app installed. */
export const OdmInstallRecord = z.looseObject({
  schema: z.literal('aio.odm-install/1'),
  version: z.string().min(1).max(40),
  dir: z.string().min(1).max(2048),
  installedAt: IsoTime,
});
export type OdmInstallRecord = z.infer<typeof OdmInstallRecord>;

/** What Settings, Processing tools shows about ODM (`odm:status`). */
export const OdmStatus = z.object({
  state: OdmState,
  /** The version this build installs, and its sizes (download and on disk). */
  pinned: z.object({
    version: z.string(),
    downloadBytes: z.number().int().nonnegative(),
    installedBytes: z.number().int().nonnegative(),
  }),
  version: z.string().max(40).optional(),
  dir: z.string().max(2048).optional(),
  installedAt: IsoTime.optional(),
  /** Why ODM is broken or unsupported, in words for the person. */
  problem: z.string().max(500).optional(),
  /** Another ODM on this computer that ODM's setup would replace (an uninstall entry or C:\ODM). */
  other: z.object({ dir: z.string().max(2048), version: z.string().max(40).optional() }).nullable(),
  gpu: z.object({
    setting: OdmGpuSetting,
    /** The NVIDIA card's name when one is found, else null. */
    nvidia: z.string().max(200).nullable(),
    /** NVIDIA's CUDA driver (nvcuda.dll) is present: ODM can use the card. */
    cuda: z.boolean(),
  }),
  /** ODM comes from QUADRION_ODM_DIR (development and tests): install and remove are off. */
  dev: z.boolean(),
  /** The setup may ask once for Windows administrator rights (Microsoft's C++ runtime). */
  mayAskAdmin: z.boolean(),
  installing: z.boolean(),
});
export type OdmStatus = z.infer<typeof OdmStatus>;

export const OdmInstallProgress = z.object({
  phase: z.enum(['download', 'verify', 'install', 'check', 'done', 'failed', 'cancelled']),
  bytesDone: z.number().nonnegative(),
  bytesTotal: z.number().nonnegative(),
  error: z.string().max(1000).optional(),
});
export type OdmInstallProgress = z.infer<typeof OdmInstallProgress>;

export const OdmInstallResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), status: OdmStatus }),
  z.object({
    ok: z.literal(false),
    error: z.string(),
    code: z
      .enum([
        'other-install',
        'busy',
        'cancelled',
        'unsupported',
        'offline-only',
        'disk',
        'dev',
        'failed',
      ])
      .optional(),
  }),
]);
export type OdmInstallResult = z.infer<typeof OdmInstallResult>;
```

(Use the repo's own `IsoTime` import path; check where `photogrammetry.ts` imports it from.)

IPC entries (in `ipc.ts`, with doc comments in the style of `pipelinePack:*`):

```ts
  'odm:status': { request: Empty, response: OdmStatus },
  'odm:install': { request: z.object({ replaceOther: z.boolean().optional() }).strict(), response: OdmInstallResult },
  'odm:cancel': { request: Empty, response: z.object({ ok: z.boolean() }) },
  'odm:remove': { request: Empty, response: OdmInstallResult },
  'odm:setGpu': { request: z.object({ gpu: OdmGpuSetting }).strict(), response: OdmInstallResult },
```

event `'odm:progress': OdmInstallProgress,`. `Settings` gains `/** Settings, Processing tools: the photogrammetry engine (ODM). Absent: GPU auto. */ processing: ProcessingSettings.optional(),`. `HardwareProbe` gains `engine: z.object({ state: OdmState, version: z.string().max(40).optional(), gpu: OdmGpuSetting }).optional()` and `processing: z.enum(['available', 'unsupported-platform', 'pack-too-old', 'no-pack', 'no-engine'])`. `PhotoRun` gains `engine: z.looseObject({ name: z.literal('odm'), version: z.string().max(40), gpu: z.object({ features: z.boolean().optional(), dense: z.boolean().optional() }).optional() }).optional()`. Registry row: `{ family: 'aio.odm-install', version: 1, home: 'pack', where: 'runtime/odm.json (the ODM install record beside the pipeline packs)', since: '0.14' }`. Preload: add `'odm:status': true, 'odm:install': true, 'odm:cancel': true, 'odm:remove': true, 'odm:setGpu': true` to `CHANNELS` and `'odm:progress': true` to `EVENTS`.

- [ ] **Step 1: Write the failing tests**

`packages/schema/src/odm.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  HardwareProbe,
  ipc,
  ipcEvents,
  OdmInstallRecord,
  OdmStatus,
  PhotoProductsParams,
  PhotoRun,
  Settings,
} from './index';

const status = {
  state: 'installed',
  pinned: { version: '3.6.2', downloadBytes: 244_864_104, installedBytes: 1_100_000_000 },
  version: '3.6.2',
  dir: 'E:\\Data\\runtime\\odm-3.6.2',
  other: null,
  gpu: { setting: 'auto', nvidia: 'NVIDIA GeForce RTX 5070 Ti', cuda: true },
  dev: false,
  mayAskAdmin: true,
  installing: false,
};

describe('ODM contract', () => {
  it('declares the channels and the event', () => {
    for (const c of ['odm:status', 'odm:install', 'odm:cancel', 'odm:remove', 'odm:setGpu'])
      expect(Object.keys(ipc)).toContain(c);
    expect(Object.keys(ipcEvents)).toContain('odm:progress');
  });

  it('reads a status and the install record', () => {
    expect(OdmStatus.parse(status).gpu.cuda).toBe(true);
    expect(
      OdmInstallRecord.safeParse({
        schema: 'aio.odm-install/1',
        version: '3.6.2',
        dir: 'C:\\x',
        installedAt: '2026-10-14T10:00:00Z',
      }).success,
    ).toBe(true);
  });

  it('keeps the GPU setting in Settings, and nothing else there', () => {
    const base = Settings.parse({
      cloudAi: false,
      theme: 'dark',
      sidebarCollapsed: false,
      dataRoot: 'E:\\Data',
      routes: [],
    });
    expect(
      Settings.parse({ ...base, processing: { odm: { gpu: 'off' } } }).processing?.odm?.gpu,
    ).toBe('off');
    expect(Settings.safeParse({ ...base, processing: { odm: { gpu: 'on' } } }).success).toBe(false);
  });

  it('refuses dense in products parameters', () => {
    expect(
      PhotoProductsParams.safeParse({ run: 'r1', products: ['ortho'], dense: 'cpu' }).success,
    ).toBe(false);
  });

  it('a probe can say the engine is missing, and a run names its engine', () => {
    const probe = HardwareProbe.shape.processing.parse('no-engine');
    expect(probe).toBe('no-engine');
    const run = PhotoRun.shape.engine.parse({
      name: 'odm',
      version: '3.6.2',
      gpu: { features: true },
    });
    expect(run?.gpu?.features).toBe(true);
  });
});
```

`tools/compat/odm-additive.test.mjs`:

```js
// The ODM engine (plan 2026-10-14-odm-engine) is additive for files 0.11 reads (tools/compat/schema-0.11):
// - run.json gains an optional `engine`; 0.11's PhotoRun is loose and keeps reading the run;
// - settings.json gains an optional `processing`; 0.11 drops what it does not know.
import { describe, expect, it } from 'vitest';
import * as current from '../../packages/schema/src/index.ts';
import * as v011 from './schema-0.11/index.mjs';

const run = {
  schema: 'aio.photo-run/1',
  id: 'r1',
  createdAt: '2026-10-14T10:00:00Z',
  status: 'aligned',
  preset: 'standard',
  photos: { source: { folders: ['photos'] }, count: 3 },
  cameras: [],
  crs: { epsg: 32639 },
  stages: [{ name: 'sfm', state: 'done' }],
  outputs: { layers: [], tilesets: [], files: [] },
  versions: { pack: '0.8.0', odm: '3.6.2' },
  engine: { name: 'odm', version: '3.6.2', gpu: { features: true, dense: false } },
};

describe('the ODM engine is additive', () => {
  it('0.11 reads a run made by ODM', () => {
    expect(current.PhotoRun.safeParse(run).success).toBe(true);
    expect(v011.PhotoRun.safeParse(run).success).toBe(true);
  });

  it('0.11 reads settings with the processing block', () => {
    const s = {
      cloudAi: false,
      theme: 'dark',
      sidebarCollapsed: false,
      dataRoot: 'E:\\Data',
      routes: [],
      processing: { odm: { gpu: 'off' } },
    };
    expect(current.Settings.safeParse(s).success).toBe(true);
    expect(v011.Settings.safeParse(s).success).toBe(true);
  });

  it('registers the install record', () => {
    expect(current.SCHEMA_REGISTRY.find((e) => e.family === 'aio.odm-install')).toMatchObject({
      version: 1,
    });
  });
});
```

In `m10.test.ts:549` replace the line with `expect(Object.keys(ipc).filter((c) => c.startsWith('odm:')).sort()).toEqual(['odm:cancel', 'odm:install', 'odm:remove', 'odm:setGpu', 'odm:status']);` and change the test's comment to "ODM came with ADR 0012 (14 Oct 2026); before it there were none".

- [ ] **Step 2: Run to see them fail**

Run: `pnpm --filter @aio/schema exec vitest run src/odm.test.ts src/m10.test.ts` and `pnpm exec vitest run tools/compat/odm-additive.test.mjs`
Expected: FAIL (`odm:status` missing).

- [ ] **Step 3: Implement** the schema as above; add the preload entries; append the two contract rows.

- [ ] **Step 4: Run the tests and the type check**

Run: `pnpm --filter @aio/schema exec vitest run`, `pnpm exec vitest run tools/compat`, `pnpm --filter @aio/desktop exec tsc --noEmit -p tsconfig.json`
Expected: PASS. (The desktop type check may report `photogrammetry.ts` and `jobs.ts` places that pass `dense` or switch on `processing`; Tasks 14 and 16 own those files. If it does, list the errors in the hand-off and leave them; the Batch 3 tasks fix them.)

- [ ] **Step 5: Commit**

```bash
git add packages/schema/src/odm.ts packages/schema/src/odm.test.ts packages/schema/src/index.ts packages/schema/src/ipc.ts packages/schema/src/photogrammetry.ts packages/schema/src/jobs.ts packages/schema/src/versions.ts packages/schema/src/m10.test.ts tools/compat/odm-additive.test.mjs apps/desktop/src/preload/index.ts docs/architecture/contract-changes.md
git commit -m "feat(schema): odm engine contract" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: ODM installer in the main process

**Files:**

- Create: `apps/desktop/src/main/odm/pin.ts`, `paths.ts`, `detect.ts`, `system.ts`, `install.ts`, `ipc.ts`, and `pin.test.ts`, `paths.test.ts`, `detect.test.ts`, `install.test.ts`, `ipc.test.ts`

**Interfaces:**

- Consumes: Task 11 types (`OdmStatus`, `OdmInstallProgress`, `OdmInstallRecord`, `OdmInstallResult`, `OdmGpuSetting`, `IpcChannel`); `update/download.ts` `downloadVerified`, `FetchLike`. GPUs are typed inline as `{ name: string; vendor?: string }`.
- Produces:
  - `pin.ts`: `interface OdmPin { version: string; url: string; size: number; sha256: string; installedBytes: number; file: string }`; `ODM_PIN: OdmPin` (Global Constraints values, `installedBytes` C3, `file: 'ODM_Setup_3.6.2.exe'`); `SETUP_ARGS` (C1, without `/DIR=`); `UNINSTALL_ARGS = ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART']`; `REQUIRED_FILES` (C4); `SETUP_MAY_ASK_ADMIN` (C2); `pinFrom(env): Promise<OdmPin>` (`ODM_PIN`, or the JSON file named by `QUADRION_ODM_PIN_FILE` when `QUADRION_E2E === '1'`).
  - `paths.ts`: `SPACES_OK = false` (C5); `isSafeOdmPath(p: string): boolean`; `odmRecordPath(dataRoot: string): string` (`<dataRoot>/runtime/odm.json`); `downloadDir(dataRoot: string): string` (`<dataRoot>/runtime/downloads`); `odmInstallDir(dataRoot: string, env: Record<string, string | undefined>, version: string): string`; `odmWorkRoot(installDir: string): string` (`path.win32.join(path.win32.dirname(installDir), 'odm-work')`: Windows paths whatever the host).
  - `detect.ts`: `interface UninstallEntry { key: string; displayName: string; installLocation?: string; displayVersion?: string }`; `parseUninstallEntries(text: string): UninstallEntry[]`; `UNINSTALL_MATCH` (C14); `findOtherOdm(d: { regQuery(key: string): Promise<string>; exists(p: string): Promise<boolean>; ours: string | null; env: Record<string, string | undefined> }): Promise<{ dir: string; version?: string } | null>`; `nvcudaPresent(env, exists): Promise<boolean>`; `nvidiaName(gpus: readonly { name: string; vendor?: string }[]): string | null`.
  - `system.ts`: `interface OdmSystem { runSetup(file: string, args: string[]): Promise<number>; runSmoke(dir: string): Promise<{ code: number; out: string }>; runUninstaller(file: string, args: string[]): Promise<number>; regQuery(key: string): Promise<string>; exists(p: string): Promise<boolean>; rm(p: string): Promise<void>; freeBytes(dir: string): Promise<number>; sleep(ms: number): Promise<void> }`; `nodeOdmSystem(env): OdmSystem` (spawn with `windowsHide: true`; a setup ending in `.mjs` runs as `process.execPath` with `ELECTRON_RUN_AS_NODE=1` only when `QUADRION_E2E === '1'`; `runSmoke` is `cmd.exe /d /c "<dir>\run.bat" --help` with `ODM_NONINTERACTIVE=1`, without `NoDefaultCurrentDirectoryInExePath` in its environment, and a 120 s timeout (the first call takes about 26 s); `regQuery` is `reg query <key> /s /f ODM /d`, an exit 1 (nothing found) answering `''`).
  - `install.ts`: `interface OdmDeps { dataRoot(): string; env: Record<string, string | undefined>; platform: string; arch: string; fetch: FetchLike; system: OdmSystem; gpus(): Promise<readonly { name: string; vendor?: string }[]>; gpuSetting(): OdmGpuSetting; offlineOnly(): boolean; now(): Date }`; `readRecord(dataRoot): Promise<OdmInstallRecord | null>`; `odmStatus(d: OdmDeps, installing: boolean): Promise<OdmStatus>`; `installOdm(d: OdmDeps, o: { replaceOther: boolean; signal: AbortSignal; onProgress(p: OdmInstallProgress): void }): Promise<OdmInstallResult>`; `removeOdm(d: OdmDeps): Promise<OdmInstallResult>`; `odmJobEnv(pipeline: string, odm: { dir: string; version: string; owned: boolean } | null, gpu: OdmGpuSetting): Record<string, string>` (for `photo.align`, `photo.georef`, `photo.products`: `AIO_ODM`, `AIO_ODM_VERSION`, `AIO_ODM_GPU`, `AIO_ODM_WORK`, and `AIO_ODM_OWNED: '1'` when `owned`); `currentOdm(d: Pick<OdmDeps, 'dataRoot' | 'env' | 'system'>): Promise<{ dir: string; version: string; owned: boolean } | null>` (`QUADRION_ODM_DIR` first, `owned: false`; else the record when its files are there, `owned: true`); `parkOdmStub(dir: string, gpu: OdmGpuSetting, env, system): Promise<void>` (the desktop twin of Task 4's `ensure_dense_gpu`: renames `SuperBuild\install\bin\nvcuda.dll`, if smaller than 100,000 bytes, to `nvcuda.dll.odm-stub` when `gpu === 'auto'` and `<SYSTEMROOT>\System32\nvcuda.dll` exists; otherwise renames it back; each rename only when its source exists; never deletes). `OdmSystem` gains `rename(from: string, to: string): Promise<void>` and `fileBytes(p: string): Promise<number | null>`.
  - `ipc.ts`: `type OdmChannel = Extract<IpcChannel, `odm:${string}`>`; `registerOdmIpc(d: OdmDeps & { handle: <C extends OdmChannel>(channel: C, handler: Handler<C>) => void; emit(p: OdmInstallProgress): void; setGpu(gpu: OdmGpuSetting): Promise<void> }): void`.

- [ ] **Step 1: Write the failing tests.** `install.test.ts` (the core; the others test their pure functions the same way):

```ts
import {
  mkdtemp,
  mkdir,
  readFile,
  rename as renameFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OdmInstallProgress } from '@aio/schema';
import { installOdm, odmJobEnv, odmStatus, parkOdmStub, removeOdm, type OdmDeps } from './install';
import type { OdmSystem } from './system';

const SETUP = Buffer.from('fake setup bytes');
let dir: string;
let server: Server;
let url: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-odm-'));
  server = createServer((_, res) => res.end(SETUP));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  url = `http://127.0.0.1:${port}/ODM_Setup_test.exe`;
  await writeFile(
    join(dir, 'pin.json'),
    JSON.stringify({
      version: '3.6.2',
      url,
      size: SETUP.length,
      sha256: createHash('sha256').update(SETUP).digest('hex'),
      installedBytes: 1000,
      file: 'ODM_Setup_test.exe',
    }),
  );
});
afterEach(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

/** A system whose setup writes what ODM's would, and whose uninstaller removes it. */
function fakeSystem(over: Partial<OdmSystem> = {}): OdmSystem & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    runSetup: async (file, args) => {
      calls.push([file, ...args]);
      const target = args.find((a) => a.startsWith('/DIR='))?.slice(5) ?? '';
      await mkdir(target, { recursive: true });
      await writeFile(join(target, 'run.bat'), '@echo off');
      await writeFile(join(target, 'VERSION'), '3.6.2');
      await writeFile(join(target, 'unins000.exe'), '');
      return 0;
    },
    runSmoke: async () => ({ code: 0, out: 'usage: run [options] <dataset name>' }),
    runUninstaller: async (file) => {
      calls.push([file]);
      await rm(join(file, '..'), { recursive: true, force: true });
      return 0;
    },
    regQuery: async () => '',
    rename: async (from, to) => {
      await renameFile(from, to);
    },
    fileBytes: async (p) => (existsSync(p) ? (await stat(p)).size : null),
    exists: async (p) => existsSync(p),
    rm: (p) => rm(p, { recursive: true, force: true }),
    freeBytes: async () => 10e12,
    sleep: async () => {},
    ...over,
  };
}

function deps(system = fakeSystem(), over: Partial<OdmDeps> = {}): OdmDeps {
  return {
    dataRoot: () => join(dir, 'data'),
    env: {
      QUADRION_E2E: '1',
      QUADRION_ODM_PIN_FILE: join(dir, 'pin.json'),
      LOCALAPPDATA: join(dir, 'local'),
    },
    platform: 'win32',
    arch: 'x64',
    fetch: (u, init) => fetch(u, init),
    system,
    gpus: async () => [{ name: 'NVIDIA GeForce RTX 5070 Ti', vendor: 'NVIDIA' }],
    gpuSetting: () => 'auto',
    offlineOnly: () => false,
    now: () => new Date('2026-10-14T10:00:00Z'),
    ...over,
  };
}

const run = (d: OdmDeps, replaceOther = false) => {
  const seen: OdmInstallProgress[] = [];
  return installOdm(d, {
    replaceOther,
    signal: new AbortController().signal,
    onProgress: (p) => seen.push(p),
  }).then((r) => ({ r, seen }));
};

describe('installing ODM', () => {
  it('downloads, checks, runs the setup silently, smoke-tests and records it', async () => {
    const system = fakeSystem();
    const { r, seen } = await run(deps(system));
    expect(r.ok).toBe(true);
    const setup = system.calls[0] ?? [];
    expect(setup.slice(1, 5)).toEqual([
      '/VERYSILENT',
      '/SUPPRESSMSGBOXES',
      '/NORESTART',
      '/CURRENTUSER',
    ]);
    const record = JSON.parse(await readFile(join(dir, 'data', 'runtime', 'odm.json'), 'utf8'));
    expect(record).toMatchObject({ schema: 'aio.odm-install/1', version: '3.6.2' });
    expect(seen.map((p) => p.phase)).toEqual(
      expect.arrayContaining(['download', 'install', 'check', 'done']),
    );
    expect(existsSync(join(dir, 'data', 'runtime', 'downloads', 'ODM_Setup_test.exe'))).toBe(false);
    if (r.ok) expect(r.status.state).toBe('installed');
  });

  it('install folder avoids non-ASCII letters in the data root', async () => {
    const d = deps(fakeSystem(), { dataRoot: () => join(dir, 'Données') });
    const { r } = await run(d);
    expect(r.ok).toBe(true);
    const record = JSON.parse(await readFile(join(dir, 'Données', 'runtime', 'odm.json'), 'utf8'));
    expect(record.dir).toMatch(/^[\x20-\x7e]+$/);
    expect(record.dir.startsWith(join(dir, 'local'))).toBe(true);
  });

  it('install folder avoids spaces and non-ASCII letters in the data root', async () => {
    const d = deps(fakeSystem(), { dataRoot: () => join(dir, 'Stratlas Data') });
    const { r } = await run(d);
    expect(r.ok).toBe(true);
    const record = JSON.parse(
      await readFile(join(dir, 'Stratlas Data', 'runtime', 'odm.json'), 'utf8'),
    );
    expect(record.dir).not.toMatch(/\s/); // C5 false: ODM's SMRF command breaks on a space
    expect(record.dir.startsWith(join(dir, 'local'))).toBe(true);
  });

  it('parks the placeholder nvcuda.dll after install when the driver is there, and puts it back for off and remove', async () => {
    const system = fakeSystem({
      runSetup: async (file, args) => {
        const target = args.find((a) => a.startsWith('/DIR='))?.slice(5) ?? '';
        await mkdir(join(target, 'SuperBuild', 'install', 'bin'), { recursive: true });
        await writeFile(
          join(target, 'SuperBuild', 'install', 'bin', 'nvcuda.dll'),
          Buffer.alloc(19_968),
        );
        for (const f of ['run.bat', 'winrun.bat', 'win32env.bat', 'VERSION', 'unins000.exe'])
          await writeFile(join(target, f), '');
        await mkdir(join(target, 'venv', 'Scripts'), { recursive: true });
        await writeFile(join(target, 'venv', 'Scripts', 'python.exe'), '');
        return 0;
      },
    });
    const d = deps(system, { env: { ...deps().env, SYSTEMROOT: join(dir, 'win') } });
    await mkdir(join(dir, 'win', 'System32'), { recursive: true });
    await writeFile(join(dir, 'win', 'System32', 'nvcuda.dll'), 'driver');
    const { r } = await run(d);
    expect(r.ok).toBe(true);
    const rec = JSON.parse(await readFile(join(dir, 'data', 'runtime', 'odm.json'), 'utf8'));
    const bin = join(rec.dir, 'SuperBuild', 'install', 'bin');
    expect(existsSync(join(bin, 'nvcuda.dll'))).toBe(false);
    expect(existsSync(join(bin, 'nvcuda.dll.odm-stub'))).toBe(true);
    await parkOdmStub(rec.dir, 'off', d.env, system);
    expect(existsSync(join(bin, 'nvcuda.dll'))).toBe(true);
  });

  it('an ODM that does not print its usage is broken, whatever its exit code', async () => {
    const { r } = await run(
      deps(
        fakeSystem({ runSmoke: async () => ({ code: 0, out: "'winrun.bat' is not recognized" }) }),
      ),
    );
    expect(r).toMatchObject({ ok: false, code: 'failed' });
  });

  it('refuses while another ODM is installed until replaceOther', async () => {
    const regText = [
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{ODM}_is1',
      '    DisplayName    REG_SZ    ODM version 3.5.6',
      '    InstallLocation    REG_SZ    C:\\ODM\\',
      '    DisplayVersion    REG_SZ    3.5.6',
    ].join('\r\n');
    const system = fakeSystem({ regQuery: async (k) => (k.startsWith('HKCU') ? regText : '') });
    const first = await run(deps(system));
    expect(first.r).toMatchObject({ ok: false, code: 'other-install' });
    expect(system.calls).toHaveLength(0);
    const second = await run(deps(system), true);
    expect(second.r.ok).toBe(true);
  });

  it('a setup that fails or an engine that does not start is reported plainly', async () => {
    const bad = await run(deps(fakeSystem({ runSetup: async () => 5 })));
    expect(bad.r).toMatchObject({ ok: false, code: 'failed' });
    if (!bad.r.ok) expect(bad.r.error).toMatch(/cancelled|permission/i);
    const broken = await run(
      deps(fakeSystem({ runSmoke: async () => ({ code: 1, out: 'Traceback\nboom' }) })),
    );
    expect(broken.r).toMatchObject({ ok: false, code: 'failed' });
    if (!broken.r.ok) expect(broken.r.error).toMatch(/does not start: boom/);
  });

  it('offline-only and other platforms are refused before any download', async () => {
    expect((await run(deps(fakeSystem(), { offlineOnly: () => true }))).r).toMatchObject({
      code: 'offline-only',
    });
    expect((await run(deps(fakeSystem(), { platform: 'darwin', arch: 'arm64' }))).r).toMatchObject({
      code: 'unsupported',
    });
  });

  it('status follows the record: installed, update available, broken, not installed', async () => {
    const d = deps();
    expect((await odmStatus(d, false)).state).toBe('not-installed');
    await run(d);
    const s = await odmStatus(d, false);
    expect(s).toMatchObject({ state: 'installed', version: '3.6.2', gpu: { setting: 'auto' } });
    const recPath = join(dir, 'data', 'runtime', 'odm.json');
    const rec = JSON.parse(await readFile(recPath, 'utf8'));
    await writeFile(recPath, JSON.stringify({ ...rec, version: '3.5.6' }));
    expect((await odmStatus(d, false)).state).toBe('update-available');
    await rm(join(rec.dir, 'run.bat'));
    expect((await odmStatus(d, false)).state).toBe('broken');
  });

  it('remove runs the uninstaller, waits for it, and forgets the record', async () => {
    const d = deps();
    await run(d);
    const r = await removeOdm(d);
    expect(r.ok).toBe(true);
    expect(existsSync(join(dir, 'data', 'runtime', 'odm.json'))).toBe(false);
    expect((await odmStatus(d, false)).state).toBe('not-installed');
  });

  it('QUADRION_ODM_DIR names an ODM without installing it', async () => {
    const d = deps(fakeSystem(), {
      env: { QUADRION_ODM_DIR: join(dir, 'fake'), QUADRION_ODM_VERSION: '3.6.2' },
    });
    const s = await odmStatus(d, false);
    expect(s).toMatchObject({ state: 'installed', dev: true, dir: join(dir, 'fake') });
    expect((await removeOdm(d)).ok).toBe(false);
  });
});

describe('the job environment', () => {
  it('names ODM, its version, the GPU setting and the work folder for photo jobs only', () => {
    const env = odmJobEnv(
      'photo.products',
      { dir: 'C:\\Q\\odm-3.6.2', version: '3.6.2', owned: true },
      'off',
    );
    expect(env).toEqual({
      AIO_ODM: 'C:\\Q\\odm-3.6.2',
      AIO_ODM_VERSION: '3.6.2',
      AIO_ODM_GPU: 'off',
      AIO_ODM_WORK: join('C:\\Q', 'odm-work'),
      AIO_ODM_OWNED: '1',
    });
    const dev = odmJobEnv(
      'photo.products',
      { dir: 'C:\\Q\\odm-3.6.2', version: '3.6.2', owned: false },
      'off',
    );
    expect(dev.AIO_ODM_OWNED).toBeUndefined(); // QUADRION_ODM_DIR: never touch its files
    expect(odmJobEnv('walk.process', { dir: 'x', version: 'y', owned: true }, 'auto')).toEqual({});
    expect(odmJobEnv('photo.align', null, 'auto')).toEqual({});
  });
});
```

`paths.test.ts` pins `isSafeOdmPath('E:\\Data\\runtime\\odm-3.6.2') === true`, `isSafeOdmPath('E:\\Stratlas Data\\runtime') === false` (C5), `isSafeOdmPath('C:\\Users\\Zoë\\x') === false`, `isSafeOdmPath('C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\aio-odm-1') === true` (an 8.3 short name, as on CI), `isSafeOdmPath('E:\\a&b') === false`, and `odmInstallDir` choosing `<dataRoot>\runtime\odm-<v>`, else `<LOCALAPPDATA>\QuadrionODM\odm-<v>`, else `<SystemDrive or C:>\QuadrionODM\odm-<v>`. `detect.test.ts` pins `parseUninstallEntries` on the registry text above (and on `''`), `findOtherOdm` finding `C:\ODM\run.bat` through `exists`, ignoring an entry whose `InstallLocation` is `ours`, and `nvidiaName`. `pin.test.ts` pins `ODM_PIN` against the Global Constraints values and that `QUADRION_ODM_PIN_FILE` is ignored without `QUADRION_E2E=1`. `ipc.test.ts` registers through a fake `handle` (as `packInstall.test.ts` does), checks that a second `odm:install` while one runs answers `code: 'busy'`, that `odm:cancel` during the download aborts it (`code: 'cancelled'`, phase `cancelled` emitted) and answers `{ ok: false }` during the setup, and that `odm:setGpu` calls `setGpu` and answers the new status.

- [ ] **Step 2: Run to see them fail**

Run: `pnpm --filter @aio/desktop exec vitest run src/main/odm`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement.** The flow of `installOdm`, in order:

1. `platform !== 'win32' || arch !== 'x64'`: `{ ok: false, code: 'unsupported', error: 'ODM installs on Windows x64 only.' }`. `QUADRION_ODM_DIR` set: `code: 'dev'`. `offlineOnly()`: `code: 'offline-only', error: 'This computer is set to offline only. Switch that off in Settings, Privacy to download the processing engine.'`.
2. `other = await findOtherOdm(...)`; when `other && !replaceOther`: `{ ok: false, code: 'other-install', error: 'Another ODM is installed in <dir>. Installing replaces it.' }`.
3. `pin = await pinFrom(env)`; `target = odmInstallDir(dataRoot, env, pin.version)`; `free = await system.freeBytes(target's drive)`; below `pin.size + pin.installedBytes`: `code: 'disk'` with the sizes in GB.
4. `onProgress({ phase: 'download', bytesDone: 0, bytesTotal: pin.size })`; `downloadVerified({ url: pin.url, sha256: pin.sha256, size: pin.size, dest: join(downloadDir(dataRoot), pin.file), fetch, signal, onProgress: (n, t) => onProgress(n === t ? { phase: 'verify', bytesDone: n, bytesTotal: t } : { phase: 'download', bytesDone: n, bytesTotal: t }) })`; an abort answers `code: 'cancelled'` (the partial file stays for the next try) and emits phase `cancelled`; another error `code: 'failed'` with its message.
5. Phase `install` (cancel is refused from here on): `code = await system.runSetup(file, [...SETUP_ARGS, `/DIR=${target}`])`; non-zero: `2` or `5` give "The installation was cancelled (a Windows permission prompt may have been declined)."; others "ODM's setup stopped with exit code <n>."
6. Phase `check`: every `REQUIRED_FILES` exists under `target`, else "ODM's setup finished but <file> is missing."; `runSmoke(target)` code 0 **and** its output contains `usage: run` (run.bat exits 0 even when it fails to start ODM), else `ODM installed but does not start: <last non-empty line of out>`.
7. `parkOdmStub(target, gpuSetting(), env, system)` (deviation 17: dense matching on the GPU), then write `odm.json` (`{ schema: 'aio.odm-install/1', version, dir: target, installedAt: now().toISOString() }`, atomically: temp file then rename); when an older record named another folder that still exists, `rm` it; `rm` the downloaded setup; phase `done`; answer `{ ok: true, status: await odmStatus(d, false) }`. Any failure emits phase `failed` with `error`.

`removeOdm`: `dev` refused; no record: `{ ok: true, status }`; first `parkOdmStub(dir, 'off', ...)` (the uninstaller only knows `nvcuda.dll`); `uninstaller = join(dir, 'unins000.exe')` when it exists: `runUninstaller(uninstaller, UNINSTALL_ARGS)`, then poll `exists(join(dir, 'run.bat'))` every second for up to 300 s (Inno's uninstaller returns before it has finished, C14); then `rm(dir)` if it is still there; delete `odm.json`.

`odmStatus`: `unsupported` off Windows x64 (`problem: 'ODM installs on Windows x64 only.'`); `QUADRION_ODM_DIR`: `installed`, `dev: true`, version from `QUADRION_ODM_VERSION` or `'dev'`; `installing`: `installing`; no record: `not-installed`; a required file missing: `broken` (`problem: 'Files of the processing engine are missing. Reinstall it.'`); record version below the pin (`compareVersions` from `@aio/schema`): `update-available`; else `installed`. Always `pinned`, `other` (`findOtherOdm`, `null` for our own folder), `gpu: { setting: gpuSetting(), nvidia: nvidiaName(await gpus()), cuda: await nvcudaPresent(env, system.exists) }`, `mayAskAdmin: SETUP_MAY_ASK_ADMIN`.

`odmInstallDir(dataRoot, env, version)` (the install folder must be a safe path too, C5: Inno's setup takes `/DIR=` as given and ODM's own commands run from there): `join(dataRoot, 'runtime', `odm-${version}`)` when `isSafeOdmPath` of it; else `join(env.LOCALAPPDATA, 'QuadrionODM', `odm-${version}`)` when that is safe; else `join(env.SystemDrive ?? 'C:', '\\', 'QuadrionODM', `odm-${version}`)`. `isSafeOdmPath(p)`: a drive path (`/^[A-Za-z]:\\/`) of printable ASCII (`/^[\x21-\x7e]*$/`, plus the space when `SPACES_OK`) without `& ^ % ! ( ) < > | "` (the Python rule of Task 5); `~` is fine, so 8.3 short names such as `RUNNER~1` pass. `findOtherOdm`: for `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall`, `HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall` and `HKLM\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall`, entries whose `displayName` matches `UNINSTALL_MATCH` and whose `installLocation` (trailing backslash removed, case-insensitive) is not `ours`; else `C:\ODM\run.bat` when it exists and `C:\ODM` is not `ours`; with `QUADRION_E2E === '1'` and `QUADRION_ODM_OTHER` set, that folder (tests only).

`odm:setGpu` also calls `parkOdmStub(record dir, gpu, ...)` for an owned install, so `off` puts the stub back at once (the runner checks again before every ODM run). `registerOdmIpc`: one `AbortController` and a `phase` while installing (`odm:install` while running answers `code: 'busy'`); `odm:cancel` aborts only while `phase` is `download` or `verify` (`{ ok: true }`), else `{ ok: false }`; `odm:status` passes `installing`; `odm:setGpu` awaits `setGpu(gpu)` then answers `{ ok: true, status }`; `odm:remove` refused while installing.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @aio/desktop exec vitest run src/main/odm`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

```bash
git add apps/desktop/src/main/odm
git commit -m "feat(desktop): install the pinned odm from settings" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Main wiring, the photo gate, and the GPU add-on removed

**Files:**

- Modify: `apps/desktop/src/main/index.ts` (imports at 139 and 164-169; `broadcast` type at 425-432; `gpuKernelCache` and `AcceleratorProbe` at 683-692; `jobEnv` at 693-711; `jobs:start` at ~1189-1209; `accelerator:` at ~1612; pack features at ~1691-1730), `apps/desktop/src/main/photogrammetry.ts` (`PHOTO_PACK` at 111, `processingVerdict` 116-127, `withAccelerator` 163-184 deleted, `readProbe` ~186-210, `PhotoSystem` 80-90, `nodePhotoSystem` ~214-221, ~990-996), `apps/desktop/src/main/photogrammetry.test.ts`, `apps/desktop/src/main/jobs/runner.ts:32-34,183` (comments), `apps/desktop/src/main/jobs/runner.test.ts:180-196`, `apps/desktop/src/main/diagnostics/photo.ts:9,46` (the accelerator line goes) and `diagnostics/photo.test.ts`, `apps/desktop/src/main/diagnostics/redact.ts` (+ `redact.test.ts`: the new `Settings.processing` gets the rule `processing: { fields: { odm: { fields: { gpu: 'keep' } } } }` beside `inference` at ~226, and a test that a diagnostics bundle keeps `processing.odm.gpu`)
- Delete: `apps/desktop/src/main/jobs/addon.ts`, `apps/desktop/src/main/jobs/addon.test.ts`

**Interfaces:**

- Consumes: Task 12 `registerOdmIpc`, `odmJobEnv`, `currentOdm`, `odmStatus`, `nodeOdmSystem`; Task 11 types.
- Produces: `odmMemoryEnv(pipeline: string, env: Readonly<Record<string, string | undefined>>): Record<string, string>` (`{ AIO_ODM_MEMORY_CAP_MB }` for the three photo pipelines only when the hand-set override `QUADRION_PHOTO_MEMORY_MB` (or its legacy `STRATLAS_` name, through `envVar`) is a number; `{}` otherwise; there is no Settings field for it); `processingVerdict(platform: string, arch: string, packVersion: string | null, engine: OdmState): HardwareProbe['processing']`; `PHOTO_PACK = '0.8.0'`; `photoBusyRefusal(pipeline: string, running: readonly { pipeline: string; status: string }[]): string | null`; `PHOTO_BUSY` (message); `PhotoSystem.engine?(): Promise<{ state: OdmState; version?: string; gpu: OdmGpuSetting }>`; `PhotoSystem.cuda?()` now checks `nvcuda.dll`.

- [ ] **Step 1: Write the failing tests** (in `photogrammetry.test.ts`)

```ts
describe('processing verdict with ODM', () => {
  it('needs Windows x64, the pack 0.8.0 and the engine', () => {
    expect(processingVerdict('darwin', 'arm64', '0.8.0', 'installed')).toBe('unsupported-platform');
    expect(processingVerdict('win32', 'x64', null, 'installed')).toBe('no-pack');
    expect(processingVerdict('win32', 'x64', '0.7.0', 'installed')).toBe('pack-too-old');
    expect(processingVerdict('win32', 'x64', '0.8.0', 'not-installed')).toBe('no-engine');
    expect(processingVerdict('win32', 'x64', '0.8.0', 'broken')).toBe('no-engine');
    expect(processingVerdict('win32', 'x64', '0.8.0', 'update-available')).toBe('available');
    expect(processingVerdict('win32', 'x64', 'dev', 'installed')).toBe('available');
  });
});

describe('one photo job at a time', () => {
  it('refuses a photo job while another runs', () => {
    const running = [{ pipeline: 'photo.align', status: 'running' }];
    expect(photoBusyRefusal('photo.products', running)).toBe(PHOTO_BUSY);
    expect(
      photoBusyRefusal('photo.products', [{ pipeline: 'photo.align', status: 'done' }]),
    ).toBeNull();
    expect(photoBusyRefusal('walk.process', running)).toBeNull();
  });
});
```

Also in `photogrammetry.test.ts`: `odmMemoryEnv('photo.products', {})` is `{}`; `odmMemoryEnv('photo.products', { QUADRION_PHOTO_MEMORY_MB: '49152' })` is `{ AIO_ODM_MEMORY_CAP_MB: '49152' }`; `odmMemoryEnv('walk.process', { QUADRION_PHOTO_MEMORY_MB: '49152' })` is `{}`; and delete the accelerator cases (~526-585) with `withAccelerator`. In `diagnostics/photo.test.ts` drop the accelerator fixture fields and the case "keeps the machine facts and drops the accelerator reason" (l.13, 88-98) to match `photo.ts`.

In `runner.test.ts:180-196`, replace the `AIO_PHOTO_ADDON` case with one that passes a `jobEnv` returning `odmJobEnv('photo.align', { dir: 'C:\\Q\\odm-3.6.2', version: '3.6.2', owned: true }, 'auto')` and checks the spawned job's environment has `AIO_ODM` and `AIO_ODM_GPU`.

- [ ] **Step 2: Run to see them fail**

Run: `pnpm --filter @aio/desktop exec vitest run src/main/photogrammetry.test.ts src/main/jobs/runner.test.ts`
Expected: FAIL (`processingVerdict` takes three arguments; `photoBusyRefusal` missing).

- [ ] **Step 3: Implement.**

- `photogrammetry.ts`: `PHOTO_PACK = '0.8.0'` with the comment "pack 0.8.0 runs ODM (ADR 0012)"; `processingVerdict` as tested (only `win32`/`x64` is supported; `no-engine` unless the state is `installed` or `update-available`); `PHOTO_BUSY = 'Another photo processing job is running on this computer. Wait for it to finish, or cancel it in Processing.'` and `photoBusyRefusal` (pipelines starting with `photo.` other than `photo.estimate`-like read-only ones; a running job is status `running` or `queued`; check `JobRecord`'s status values in `@aio/schema` and use those meaning "at work"); delete `withAccelerator` and `AcceleratorState` uses; `PhotoSystem.accelerator` removed, `engine?()` added; `readProbe` adds `engine` from `system.engine?.()` and passes its `state` to `processingVerdict`; `nodePhotoSystem` gets `cuda: () => nvcudaPresent(process.env, exists)` and `engine` from its options.
- `index.ts`: remove the add-on imports, `gpuKernelCache`, `accelerator`, `accelerator: () => accelerator.state()`; widen `broadcast` to `'odm:progress'`; build `odmDeps: OdmDeps` (`dataRoot: () => settings.current().dataRoot`, `env: process.env`, `platform: process.platform`, `arch: process.arch`, `fetch: (u, init) => session.fromPartition('quadrion-odm').fetch(u, init)`, `system: nodeOdmSystem(process.env)`, `gpus: async () => gpusFromInfo(await app.getGPUInfo('basic'))`, `gpuSetting: () => settings.current().processing?.odm?.gpu ?? 'auto'`, `offlineOnly: () => settings.current().offlineOnly === true`, `now: () => new Date()`); `registerOdmIpc({ ...odmDeps, handle, emit: (p) => broadcast('odm:progress', p), setGpu: (gpu) => settings.update((s) => ({ ...s, processing: { ...s.processing, odm: { ...s.processing?.odm, gpu } } })) })` (use the settings store's own update call; check its signature in `settings.ts`); `jobEnv` becomes `{ ...photoJobEnv(...), ...odmJobEnv(job.pipeline, await currentOdm(odmDeps), odmDeps.gpuSetting()), ...odmMemoryEnv(job.pipeline, process.env), ...geoidJobEnv(...) }` (`AIO_ODM_MEMORY_CAP_MB` only when the memory limit was set by hand; `odmJobEnv` stays the four keys); in `jobs:start`, before the pack checks, `const busy = photoBusyRefusal(req.pipeline, (await jobs.list()).jobs ?? []); if (busy) return { ok: false, error: busy };` (adapt to the shape `jobs:list` answers); the photo probe's `engine: async () => { const s = await odmStatus(odmDeps, false); return { state: s.state, ...(s.version ? { version: s.version } : {}), gpu: s.gpu.setting }; }`; the pack feature for photos keeps `minVersion: PHOTO_PACK` (now 0.8.0).
- `runner.ts`: comments at 32-34 and 183 say "the photo memory cap and ODM's folder and GPU setting".
- Delete `addon.ts` and `addon.test.ts`; `diagnostics/photo.ts` drops the `accelerator` line (and its doc mention).

- [ ] **Step 4: Run the tests and the type check**

Run: `pnpm --filter @aio/desktop exec vitest run src/main` and `pnpm --filter @aio/desktop exec tsc --noEmit -p tsconfig.json`
Expected: PASS (renderer type errors from Task 16's files are Task 16's; report any here that are not).

- [ ] **Step 5: Lint and commit**

```bash
git add apps/desktop/src/main/index.ts apps/desktop/src/main/photogrammetry.ts apps/desktop/src/main/photogrammetry.test.ts apps/desktop/src/main/jobs/runner.ts apps/desktop/src/main/jobs/runner.test.ts apps/desktop/src/main/diagnostics/photo.ts apps/desktop/src/main/diagnostics/photo.test.ts apps/desktop/src/main/diagnostics/redact.ts apps/desktop/src/main/diagnostics/redact.test.ts
git rm apps/desktop/src/main/jobs/addon.ts apps/desktop/src/main/jobs/addon.test.ts
git commit -m "feat(desktop): odm in the job environment and the photo gate; gpu add-on removed" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: The Processing engine card

**Before writing UI code, load the design skills `impeccable` and `frontend-design`** (CLAUDE.md working agreement 1) and follow `docs/design/DIRECTION.md` (dark first, IBM Plex, radii 2/4/6, the existing `opt-card`, `notice`, `toast-bar`, `btn sm` classes of `ProcessingTools.tsx`).

**Files:**

- Create: `apps/desktop/src/renderer/odmStore.ts`, `odmStore.test.ts`, `apps/desktop/src/renderer/odm.ts`, `apps/desktop/src/renderer/screens/settings/ProcessingEngine.tsx`, `processingEngine.css`, `processingEngineView.ts`, `processingEngineView.test.ts`
- Modify: `apps/desktop/src/renderer/screens/settings/ProcessingTools.tsx` (render `<ProcessingEngine />` first on the page), `apps/desktop/src/renderer/store.ts:48,68` (`SettingsFocus` gains `'processing-engine'`, `FOCUS_PAGE['processing-engine'] = 'tools'`), `packages/ui/src/i18n/en.ts` (the `engine.*` keys after the `tools.*` block at ~823)

**Interfaces:**

- Consumes: Task 11 (`OdmStatus`, `OdmInstallProgress`, channels); `renderer/bridge.ts` `Bridge`; `processingTools.ts` (`processingTools` store's `resume`, `resumeAfterTools`); `shell` store `openSettings`.
- Produces:
  - `createOdmStore(b: Bridge, on: AioBridge['on'] | undefined): StoreApi<OdmUi>` with `OdmUi = { status: OdmStatus | null; progress: OdmInstallProgress | null; installing: boolean; error: string | null; askReplace: boolean; load(): Promise<void>; install(replaceOther?: boolean): Promise<void>; cancel(): Promise<void>; remove(): Promise<void>; setGpu(on: boolean): Promise<void>; keep(): void }` (`keep` closes the replace question).
  - `renderer/odm.ts`: `odm` (the instance), `useOdm(selector)`, `openProcessingEngine(): void` (like `openProcessingTools`: remembers `resume: 'create-maps'` on the processing tools store when the wizard was open, closes it, `shell.getState().openSettings('processing-engine')`).
  - `processingEngineView(status: OdmStatus | null, progress: OdmInstallProgress | null, installing: boolean): EngineView` with `EngineView = { state: 'loading' | OdmState; tone: 'ok' | 'warn' | 'plain'; title: MessageKey; detail: string | null; hardware: string; gpuOn: boolean; gpuDisabled: boolean; progress: { label: string; pct: number | null } | null; actions: ('install' | 'cancel' | 'update' | 'remove' | 'reinstall')[] }`.

Strings (`en.ts`, no em or en dashes):

```ts
  // Settings, Processing tools: the processing engine (ODM, ADR 0012)
  'engine.title': 'Processing engine',
  'engine.about':
    'ODM (OpenDroneMap) turns drone photos into maps, elevation models, point clouds and 3D models on this computer. It is free, open-source software under the AGPL-3.0 licence.',
  'engine.licence': 'Licence',
  'engine.site': 'ODM website',
  'engine.size': 'Download {download}, about {installed} installed.',
  'engine.state.notInstalled': 'Not installed',
  'engine.state.installing': 'Installing',
  'engine.state.installed': 'Installed',
  'engine.state.update': 'Update available',
  'engine.state.broken': 'Files missing',
  'engine.state.unsupported': 'Not available on this computer',
  'engine.version': 'ODM {version}, in {dir}',
  'engine.updateText': 'This version of {product} uses ODM {version}.',
  'engine.gpu.used': 'Graphics card: {name}, used for processing',
  'engine.gpu.off': 'Graphics card: {name}, switched off for processing',
  'engine.gpu.none': 'No NVIDIA graphics card found; processing uses the CPU',
  'engine.gpu.switch': 'Use the graphics card',
  'engine.install': 'Download and install',
  'engine.update': 'Update',
  'engine.reinstall': 'Reinstall',
  'engine.cancel': 'Cancel',
  'engine.remove': 'Remove',
  'engine.remove.confirm': 'Remove ODM from this computer',
  'engine.remove.keep': 'Keep',
  'engine.other': 'Another ODM is installed in {dir}. Installing replaces it.',
  'engine.other.yes': 'Install and replace it',
  'engine.admin': 'Windows may ask once for permission to install Microsoft\'s C++ runtime.',
  'engine.progress.download': 'Downloading {done} of {total}',
  'engine.progress.verify': 'Checking the download',
  'engine.progress.install': 'Installing',
  'engine.progress.check': 'Checking the installation',
  'engine.back': 'Back to Create maps from photos',
  'engine.dev': 'ODM comes from QUADRION_ODM_DIR on this computer.',
```

- [ ] **Step 1: Write the failing tests.** `processingEngineView.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { OdmStatus } from '@aio/schema';
import { processingEngineView } from './processingEngineView';

const base: OdmStatus = {
  state: 'not-installed',
  pinned: { version: '3.6.2', downloadBytes: 244_864_104, installedBytes: 1_100_000_000 },
  other: null,
  gpu: { setting: 'auto', nvidia: 'NVIDIA GeForce RTX 5070 Ti', cuda: true },
  dev: false,
  mayAskAdmin: true,
  installing: false,
};

describe('the Processing engine card', () => {
  it('offers the install with the sizes', () => {
    const v = processingEngineView(base, null, false);
    expect(v.state).toBe('not-installed');
    expect(v.actions).toEqual(['install']);
    expect(v.detail).toContain('234 MB');
  });

  it('shows the download and allows cancel only while downloading', () => {
    const d = processingEngineView(
      base,
      { phase: 'download', bytesDone: 122_432_052, bytesTotal: 244_864_104 },
      true,
    );
    expect(d.progress).toEqual({ label: 'Downloading 117 MB of 234 MB', pct: 50 });
    expect(d.actions).toEqual(['cancel']);
    const i = processingEngineView(base, { phase: 'install', bytesDone: 0, bytesTotal: 0 }, true);
    expect(i.progress?.pct).toBeNull();
    expect(i.actions).toEqual([]);
  });

  it('installed: version, folder, GPU line and remove', () => {
    const v = processingEngineView(
      { ...base, state: 'installed', version: '3.6.2', dir: 'E:\\Q\\odm-3.6.2' },
      null,
      false,
    );
    expect(v.tone).toBe('ok');
    expect(v.hardware).toBe('Graphics card: NVIDIA GeForce RTX 5070 Ti, used for processing');
    expect(v.actions).toEqual(['remove']);
    expect(v.gpuOn).toBe(true);
  });

  it('update, broken, no card, switched off, development', () => {
    expect(
      processingEngineView({ ...base, state: 'update-available', version: '3.5.6' }, null, false)
        .actions,
    ).toEqual(['update', 'remove']);
    expect(processingEngineView({ ...base, state: 'broken' }, null, false).actions).toEqual([
      'reinstall',
      'remove',
    ]);
    const none = processingEngineView(
      { ...base, gpu: { setting: 'auto', nvidia: null, cuda: false } },
      null,
      false,
    );
    expect(none.hardware).toBe('No NVIDIA graphics card found; processing uses the CPU');
    expect(none.gpuDisabled).toBe(true);
    const off = processingEngineView(
      { ...base, state: 'installed', gpu: { ...base.gpu, setting: 'off' } },
      null,
      false,
    );
    expect(off.hardware).toContain('switched off');
    expect(off.gpuOn).toBe(false);
    expect(
      processingEngineView({ ...base, state: 'installed', dev: true }, null, false).actions,
    ).toEqual([]);
  });
});
```

`odmStore.test.ts` (with a fake bridge and an `on` stub as `processingToolsStore.test.ts` does): `load` reads `odm:status`; `install()` calls `odm:install` with `{}` and, on `code: 'other-install'`, sets `askReplace` without installing, then `install(true)` sends `{ replaceOther: true }`; progress events update `progress` only while `installing`; `cancel` calls `odm:cancel`; `remove` calls `odm:remove` and stores the answered status; `setGpu(false)` sends `{ gpu: 'off' }`; an `{ ok: false, error }` answer sets `error`.

- [ ] **Step 2: Run to see them fail**

Run: `pnpm --filter @aio/desktop exec vitest run src/renderer/odmStore.test.ts src/renderer/screens/settings/processingEngineView.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement.** `processingEngineView` uses the `formatBytes` of `photogrammetry/estimate.ts` (234 MB for 244,864,104 bytes: it divides by 1024 twice; check and match), `t()` for every string, and the action rules the test pins. `ProcessingEngine.tsx`: an `opt-card` section with `data-testid="engine"`, `aria-labelledby` its `h2`; children: `engine-about` (the about text with two `<a href target="_blank" rel="noreferrer">` links to `https://github.com/OpenDroneMap/ODM/blob/master/LICENSE` and `https://opendronemap.org/odm/`, then the size line), `engine-state` (`data-state` = view state), `engine-version`, `engine-hardware`, a switch `engine-gpu` (`role="switch"`, `aria-checked`, disabled when `gpuDisabled` or not installed), `engine-admin` (when `mayAskAdmin` and not installed), the progress block `engine-progress` (the same `toast-bar` markup as `ProcessingTools.tsx`), the replace question `engine-replace` (`role="alert"`, buttons `engine-replace-yes` and `engine-replace-no`), the error `engine-error` (`role="alert"`), buttons `engine-install`, `engine-cancel`, `engine-update`, `engine-reinstall`, `engine-remove`; the inline remove confirm swaps `engine-remove` for `engine-remove-confirm` (danger) and `engine-remove-keep` exactly as `OtherPack` does; `engine-back` (calls `resumeAfterTools`) when installed and the processing tools store's `resume` is `'create-maps'`. When `settingsFocus === 'processing-engine'`, scroll the card into view, focus its first button, then `clearSettingsFocus()` (as `RasterPacks.tsx:276-282`). `odm.load()` runs in an effect keyed on the data root, like `ProcessingTools`. CSS in `processingEngine.css`, scoped under `.processing-engine`, reusing the tokens of `processingTools.css`; no new colours.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @aio/desktop exec vitest run src/renderer/odmStore.test.ts src/renderer/screens/settings/processingEngineView.test.ts` and `pnpm --filter @aio/ui exec vitest run src/i18n/i18n.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

```bash
git add apps/desktop/src/renderer/odmStore.ts apps/desktop/src/renderer/odmStore.test.ts apps/desktop/src/renderer/odm.ts apps/desktop/src/renderer/screens/settings/ProcessingEngine.tsx apps/desktop/src/renderer/screens/settings/processingEngine.css apps/desktop/src/renderer/screens/settings/processingEngineView.ts apps/desktop/src/renderer/screens/settings/processingEngineView.test.ts apps/desktop/src/renderer/screens/settings/ProcessingTools.tsx apps/desktop/src/renderer/store.ts packages/ui/src/i18n/en.ts
git commit -m "feat(desktop): processing engine card in settings" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: The wizard, the run panel and the job forms

**Files:**

- Modify: `apps/desktop/src/renderer/photogrammetry/hardware.ts` (+ its test), `ProcessWizard.tsx:487-510` (the blocked section), `estimate.ts:4-29` (preset texts), `photogrammetry/store.ts:173-191` (`STAGE_WORDS`), `phases.ts:42-61` (+ `phases.test.ts:88-89,114`), `estimate.test.ts:129` (comment), `apps/desktop/src/renderer/jobs.ts:618-674`

**Interfaces:**

- Consumes: Task 11 (`HardwareProbe.processing` `no-engine`, `HardwareProbe.engine`); Task 15 `openProcessingEngine`.
- Produces: `ProcessingVerdict.fix: 'tools' | 'engine' | null`; `gpuLine(p: HardwareProbe): string` (the preset argument goes; update its callers).

- [ ] **Step 1: Write the failing tests** (`hardware.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import type { HardwareProbe } from '@aio/schema';
import { gpuLine, processingLine } from './hardware';

const probe = (over: Partial<HardwareProbe> = {}): HardwareProbe => ({
  platform: 'win32',
  arch: 'x64',
  cpu: { model: 'CPU', cores: 24 },
  memoryBytes: 64 * 2 ** 30,
  freeDiskBytes: 2 ** 40,
  gpus: [{ name: 'NVIDIA GeForce RTX 5070 Ti', vendor: 'NVIDIA' }],
  cuda: true,
  processing: 'available',
  engine: { state: 'installed', version: '3.6.2', gpu: 'auto' },
  ...over,
});

describe('the wizard with ODM', () => {
  it('says to install the processing engine first', () => {
    const v = processingLine(probe({ processing: 'no-engine' }));
    expect(v).toMatchObject({
      ok: false,
      title: 'Install the processing engine first',
      fix: 'engine',
    });
  });

  it('names Windows only and the 0.8.0 tools', () => {
    expect(processingLine(probe({ processing: 'unsupported-platform' })).text).toContain(
      'Windows x64',
    );
    expect(processingLine(probe({ processing: 'no-pack' })).text).toContain('0.8.0');
  });

  it('says what the graphics card does', () => {
    expect(gpuLine(probe())).toBe('NVIDIA GeForce RTX 5070 Ti: used for processing');
    expect(gpuLine(probe({ engine: { state: 'installed', gpu: 'off' } }))).toBe(
      'NVIDIA GeForce RTX 5070 Ti: switched off in Settings; processing uses the CPU',
    );
    expect(gpuLine(probe({ cuda: false, gpus: [] }))).toBe(
      'No NVIDIA graphics card found; processing uses the CPU',
    );
  });
});
```

In `phases.test.ts`, the products steps become `prepare, dense, cloud, dsm, ortho, commit` (replace `step('fuse')` with `step('cloud')`) and the align steps `inspect, sfm, georef, report, commit`; the phases they map to stay `read`, `match`, `map`, `model`, `add`.

- [ ] **Step 2: Run to see them fail**

Run: `pnpm --filter @aio/desktop exec vitest run src/renderer/photogrammetry`
Expected: FAIL.

- [ ] **Step 3: Implement.**

- `hardware.ts`: `TOOLS_VERSION = '0.8.0'`; a `no-engine` case `{ ok: false, title: 'Install the processing engine first', text: 'Creating maps from photos uses ODM, the processing engine. Install it once in Settings, Processing tools (a 234 MB download).', fix: 'engine' }`; `unsupported-platform` text "Creating maps from photos runs on Windows x64. This computer can open the results."; `gpuLine` as tested.
- The new `HardwareProbe.processing` value `'no-engine'` (Task 11) is handled in `hardware.ts` `processingLine` (the case above; the `switch` must stay exhaustive, so the type check fails until it is there).
- The wizard does not offer mesh or 3D Tiles with Fast: choosing Quick unticks and disables those two checkboxes with the note "Quick makes no 3D model." (`photogrammetry/estimate.ts` `defaultProducts('fast')` already leaves them out; also filter them out of `PendingProducts` when the preset is `fast`). A test in `estimate.test.ts` pins that `defaultProducts('fast')` and the filter never contain `mesh` or `tiles`.
- `ProcessWizard.tsx`: in the blocked section, when `blocked.fix === 'engine'` the button is `<button className="btn primary" data-testid="photo-fix" onClick={openProcessingEngine}>Install the processing engine</button>`; `fix === 'tools'` unchanged; update the `gpuLine` call (no preset).
- `estimate.ts` preset texts: `fast` "Quick": "Orthophoto and elevation from the matched points; no 3D model. The fastest."; `standard` "Standard": "A dense point cloud at medium quality."; `high` "High": "A dense point cloud at high quality and the finest features. The slowest."
- `photogrammetry/store.ts` `STAGE_WORDS`: `sfm` "Align the photos (ODM)", `georef` "Place the model", `adjust` "Adjust with ground control (ODM)", `dense` "Dense point cloud", `mesh` "3D mesh", `texture` "Texture the mesh", `cloud` "Point cloud", `dsm` "Elevation models", `ortho` "Orthophoto", keep the others; drop `features`, `match`, `fuse`, `dtm`.
- `phases.ts`: `PHASE_OF_STAGE` keeps `inspect: 'read'`, `sfm`, `georef`, `report: 'match'`, `adjust: 'control'`, `prepare`, `dense`, `cloud`, `dsm`, `ortho: 'map'`, `mesh`, `texture`, `tiles: 'model'`, `commit: 'add'`; remove `features`, `match`, `fuse`, `dtm`.
- `jobs.ts` (`photo.products` form): remove the `dense` select; preset options `''` "The run's own", `fast` "Fast (no 3D model)", `standard` "Standard", `high` "High (slowest)".

- [ ] **Step 4: Run the tests and the type check**

Run: `pnpm --filter @aio/desktop exec vitest run src/renderer/photogrammetry` and `pnpm --filter @aio/desktop exec tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

```bash
git add apps/desktop/src/renderer/photogrammetry/hardware.ts apps/desktop/src/renderer/photogrammetry/hardware.test.ts apps/desktop/src/renderer/photogrammetry/ProcessWizard.tsx apps/desktop/src/renderer/photogrammetry/estimate.ts apps/desktop/src/renderer/photogrammetry/estimate.test.ts apps/desktop/src/renderer/photogrammetry/store.ts apps/desktop/src/renderer/photogrammetry/phases.ts apps/desktop/src/renderer/photogrammetry/phases.test.ts apps/desktop/src/renderer/jobs.ts
git commit -m "feat(desktop): create maps waits for the processing engine; odm step names" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 17: Paperwork, the add-on tooling and the notices

**Files:**

- Create: `docs/architecture/adr/0012-odm-engine.md`
- Modify: `docs/architecture/adr/0008-photogrammetry-engine.md` (status line), `docs/architecture/data-conventions.md` (section 21 run files: `odm/`, `odm-logs/`, `engine`; line ~453 and section 31 at ~785-805: the GPU add-on retired, and a new subsection "ODM install record" for `runtime/odm.json`), `docs/release/README.md:146-154,176` (the add-on steps go; one paragraph on ODM: downloaded by the app from ODM's GitHub release, pinned version and SHA-256 in `apps/desktop/src/main/odm/pin.ts`, never bundled), `tools/release/notices.mjs` (`addonInventory` and its section go; a fixed "Downloaded at run time" section names ODM 3.6.2, AGPL-3.0, `https://github.com/OpenDroneMap/ODM`, installed by the person from Settings, run as a separate program, not bundled), `tools/release/notices.test.mjs:134-149`, `tools/release/budgets.mjs:8,48,86-95,271` and `budgets.test.mjs` (add-on budget goes), `docs/release/THIRD-PARTY-NOTICES.md` (regenerated), `.github/workflows/ci.yml:410,423-424,469-514` (the `addon` filter and job go), `.github/workflows/release.yml:440-480` (the add-on steps go), `.github/workflows/ci.yml:293` (the comment about `photo-real.spec.ts` goes), `docs/KNOWN-LIMITS.md:230` (the real-engine e2e sentence: the real check is now `tools/odm/probe.mjs` and `python/tests/test_odm_real.py`, both opt-in)
- Delete: `tools/pipeline-pack/accelerator.mjs`, `accelerator.test.mjs`, `accelerator-lock.json`

**Interfaces:**

- Consumes: Task 13 (`uv.lock` without `pymeshlab`; the notices read it), Task 14 (no code uses the add-on).
- Produces: documentation only, and notices that pass `node tools/release/notices.mjs --check`.

ADR 0012 text (complete; keep it):

```markdown
# ADR 0012: ODM as the photogrammetry engine

- Status: **Accepted, 14 Oct 2026 (founder)**. Supersedes ADR 0008 decision 2 (our own pipeline on COLMAP) and decision 4 (no ODM adapter).
- Deciders: founder
- Plan: `docs/plans/2026-10-14-odm-engine-design.md` and `docs/plans/2026-10-14-odm-engine.md`
- Code: `python/src/aio_pipelines/photo/odm/`, `photo/align.py`, `photo/georef.py`, `photo/products.py`; `apps/desktop/src/main/odm/`; `apps/desktop/src/renderer/screens/settings/ProcessingEngine.tsx`

## Context

The first real 1,000-photo run (995 photos, 15.27 ha, pack 0.7.0) ran 7.5 hours and was still inside our own orthomosaic code: one core of 24 busy, about 830 windows of 120 or more candidate photos each, a cache smaller than one window's working set. Alignment (COLMAP) worked; dense matching, fusion, DSM, DTM, orthomosaic, mesh and texture were our own code. ODM was set aside on 7 Oct only for its AGPL licence under a permissive-only policy, which the founder lifted on 8 Oct. Founder, 14 Oct: stop rebuilding what proper open-source engines already do; time to a finished product matters most.

## Decision

1. **ODM does everything from the photos**: alignment, dense cloud, DSM, DTM, orthophoto, point cloud, textured mesh. Our pipelines lay out one ODM project per run, start ODM and import what it writes into the existing layer kinds.
2. **Our own engine is deleted**, not kept as a fallback. COLMAP stays only for walks.
3. **ODM is downloaded by the app from ODM's GitHub release, a pinned version** (3.6.2) checked against its size and SHA-256, and installed per user with its own silent setup, from Settings, Processing tools. It is never bundled in the installer or the pipeline pack.
4. **GPU auto, with a switch**: ODM uses an NVIDIA card when its driver is present and it works, else the CPU; a Settings switch keeps it on the CPU. Threads: `clamp(min(CPUs - 2, floor(RAM GB / 3)), 2, 32)`, lowered only by a memory limit set by hand (never by the automatic photo memory cap).
5. **Arm's length**: ODM runs as a separate program (`run.bat`); the app and the pipeline pack never link it and never change its program code. One exception: in the ODM folder the app installed, the placeholder `SuperBuild\install\bin\nvcuda.dll` (a 19 KB stub that makes OpenMVS densify on the CPU) is renamed to `nvcuda.dll.odm-stub` when NVIDIA's driver is present and the GPU setting is `auto`, and renamed back otherwise and before uninstalling (founder, 14 Oct; dense matching about 6x faster). One ODM run at a time on a computer.
6. **Windows x64 only** for photogrammetry from this decision (ODM ships a Windows installer; macOS is parked, 10 Oct 2026).
7. **Paths ODM sees have no spaces and no non-ASCII letters**: ODM's SMRF ground command is unquoted (a space gives zero ground points and a DTM that never finishes) and OpenSfM fails on non-ASCII letters; such project folders are reached through a junction and the install folder is chosen safe.

## Consequences

- ODM is AGPL-3.0. We distribute none of it: the person downloads it from ODM's release through the app. `THIRD-PARTY-NOTICES.md` names it under "Downloaded at run time".
- Updating ODM is ours to test and bump: the pin lives in `apps/desktop/src/main/odm/pin.ts`, and `tools/odm/probe.mjs` re-measures a new version (install flags, size, output names, GPU lines).
- ODM's setup removes another ODM install on the computer; the Settings card detects one and asks first.
- The pipeline pack shrinks (no `pymeshlab`, no GPU add-on); photo jobs need pack 0.8.0.
- Old runs keep their layers; processing an old run again starts from the photos with ODM.
```

- [ ] **Step 1: Write the failing notices test.** In `notices.test.mjs`, replace the add-on assertions (134-149) with: the rendered notices contain a section "Downloaded at run time" naming "ODM (OpenDroneMap) 3.6.2" and "AGPL-3.0", and no section mentions `pipeline-addon`.

- [ ] **Step 2: Run to see it fail**

Run: `node --test tools/release/notices.test.mjs` (or `pnpm exec vitest run tools/release/notices.test.mjs`, whichever the file uses)
Expected: FAIL.

- [ ] **Step 3: Write the docs, edit the tools and workflows, delete the accelerator files; regenerate the notices** with `node tools/release/notices.mjs` (from the worktree, with the main checkout's venv as the Python inventory source if the script needs one: read its `--help`).

- [ ] **Step 4: Run the checks**

Run: `node --test tools/release/notices.test.mjs tools/release/budgets.test.mjs`, `node tools/release/notices.mjs --check`, `pnpm format:check`, `node tools/agent/check-public-text.mjs docs/architecture/adr/0012-odm-engine.md docs/release/README.md docs/architecture/data-conventions.md`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/architecture/adr/0012-odm-engine.md docs/architecture/adr/0008-photogrammetry-engine.md docs/architecture/data-conventions.md docs/KNOWN-LIMITS.md docs/release/README.md docs/release/THIRD-PARTY-NOTICES.md tools/release/notices.mjs tools/release/notices.test.mjs tools/release/budgets.mjs tools/release/budgets.test.mjs .github/workflows/ci.yml .github/workflows/release.yml
git rm tools/pipeline-pack/accelerator.mjs tools/pipeline-pack/accelerator.test.mjs tools/pipeline-pack/accelerator-lock.json
git commit -m "docs(adr): odm as the photogrammetry engine; gpu add-on tooling removed" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 18: End to end

**Files:**

- Create: `apps/desktop/e2e/odm-fake/fake-setup.mjs`
- Modify: `apps/desktop/e2e/processing-tools.spec.ts`, `photo-process.spec.ts`, `photo-products.spec.ts`, `photo-change.spec.ts`, `photoPack.ts`, `photo-fake/aio_photo_fake.py`, `m10Fixtures.ts` (only if it imports what is removed), `tools/ci/e2e-timings.json:69` (drop `photo-real`), `.github/workflows/nightly.yml:239-247` (drop the photo-real step), `.gitignore` (add `python/tests/odm-work/`)
- Delete: `apps/desktop/e2e/photo-real.spec.ts`

**Interfaces:**

- Consumes: everything app-side (Tasks 8 to 16); the fake ODM (`python/tests/fake_odm`, Task 3).
- Produces: e2e helpers `ODM_FAKE_DIR` (absolute path of `python/tests/fake_odm`) and `odmEnv(): Record<string, string>` (`{ QUADRION_ODM_DIR: ODM_FAKE_DIR, QUADRION_ODM_VERSION: '3.6.2', FAKE_ODM_PYTHON: VENV_PYTHON, FAKE_ODM_UDP_PORT: '0', AIO_ODM_WORK: <a temp folder without spaces, made per run> }`, so no junction lands in the repository) exported from `photoPack.ts`.

`fake-setup.mjs` (run by main as Electron-as-Node in e2e only; deviation 11):

```js
// E2E stand-in for ODM's Inno setup: honours /DIR=, writes what the install check looks for, takes
// a second so the card shows "Installing", and exits 0 (or FAKE_SETUP_EXIT).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv.find((a) => a.startsWith('/DIR='))?.slice(5);
if (!dir) process.exit(1);
mkdirSync(dir, { recursive: true });
writeFileSync(
  join(dir, 'run.bat'),
  '@echo off\r\necho usage: run [options] ^<dataset name^>\r\nexit /b 0\r\n',
);
writeFileSync(join(dir, 'VERSION'), '3.6.2');
// every other REQUIRED_FILES entry (C4: winrun.bat, win32env.bat, venv\Scripts\python.exe), as empty files
for (const rel of (process.env.FAKE_SETUP_FILES ?? '').split(';').filter(Boolean)) {
  mkdirSync(join(dir, rel, '..'), { recursive: true });
  writeFileSync(join(dir, rel), '');
}
await new Promise((r) => setTimeout(r, 1000));
process.exit(Number(process.env.FAKE_SETUP_EXIT ?? 0));
```

- [ ] **Step 1: Write the failing specs.**

`processing-tools.spec.ts`, new `test.describe('Processing engine')` (no Python needed): a `node:http` server on 127.0.0.1 serves `fake-setup.mjs` as `ODM_Setup_fake.mjs`; a pin file `{ version: '3.6.2', url, size, sha256, installedBytes: 1_000_000, file: 'ODM_Setup_fake.mjs' }` in the test's temp folder; the app starts with `QUADRION_ODM_PIN_FILE` set to it and `FAKE_SETUP_FILES` set to C4's extra entries.

```ts
test('installs the engine from Settings and removes it again', async ({ win }) => {
  await openToolsPage(win); // the existing helper of this spec that opens Settings, Processing tools
  const card = win.getByTestId('engine');
  await expect(card.getByTestId('engine-state')).toHaveAttribute('data-state', 'not-installed');
  await expect(card.getByTestId('engine-about')).toContainText('AGPL-3.0');
  await card.getByTestId('engine-install').click();
  await expect(card.getByTestId('engine-progress')).toBeVisible();
  await expect(card.getByTestId('engine-state')).toHaveAttribute('data-state', 'installed', {
    timeout: 30_000,
  });
  await expect(card.getByTestId('engine-version')).toContainText('3.6.2');
  const gpu = card.getByTestId('engine-gpu');
  if (await gpu.isEnabled()) {
    await gpu.click();
    await expect(gpu).toHaveAttribute('aria-checked', 'false');
    await expect
      .poll(() =>
        win.evaluate(() => window.aio.invoke('odm:status', {}).then((s) => s.gpu.setting)),
      )
      .toBe('off');
  } else {
    await expect(gpu).toBeDisabled(); // no NVIDIA card here (CI): the switch cannot be used
  }
  await card.getByTestId('engine-remove').click();
  await card.getByTestId('engine-remove-confirm').click();
  await expect(card.getByTestId('engine-state')).toHaveAttribute('data-state', 'not-installed');
  await expectFits(win, card); // the spec's own helper
});

test('another ODM asks before installing', async ({ win }) => {
  // the app was started with QUADRION_ODM_OTHER pointing at an empty folder (tests only)
  await openToolsPage(win);
  const card = win.getByTestId('engine');
  await card.getByTestId('engine-install').click();
  await expect(card.getByTestId('engine-replace')).toContainText('Installing replaces it');
  await card.getByTestId('engine-replace-yes').click();
  await expect(card.getByTestId('engine-state')).toHaveAttribute('data-state', 'installed', {
    timeout: 30_000,
  });
});
```

(Use the spec's existing fixtures and helpers for starting the app and opening the page; the two tests each get their own data root. The `odm:status` poll checks that the switch reached the settings.)

`photo-process.spec.ts`: the "Every step" assertion becomes `Align the photos (ODM)` (was `Find features`); the `photo-gpu` regex becomes `/used for processing|switched off|No NVIDIA graphics card found/`; in the `plain.describe` blocked states add a test: with the photo pack but without `QUADRION_ODM_DIR` and no install, `photo-blocked` shows "Install the processing engine first", `photo-fix` reads "Install the processing engine", clicking it opens Settings with the `engine` card focused, and `photo-start` has count 0; the `oldPackEnv` test expects "0.8.0".

`photoPack.ts`: remove `colmapPython`, `missingRealPhotoTools`, `PHOTO_REAL`; the fake pack manifest version becomes `'0.8.0'`; `buildPhotoPack` returns `{ ...current, ...odmEnv() }`. `aio_photo_fake.py`: `FakeAlign` stages `inspect, sfm, georef, report` (plus `commit` where it had it); `FakeProducts` stages `["dense"] + ["cloud"] + wanted of (dsm, ortho, mesh)` then `commit`, keeping the same files written.

`photo-products.spec.ts` and `photo-change.spec.ts`: launch with `{ ...PIPELINE_ENV, AIO_ODM: ODM_FAKE_DIR, AIO_ODM_VERSION: '3.6.2', FAKE_ODM_PYTHON: VENV_PYTHON, FAKE_ODM_UDP_PORT: '0' }` (the job environment from main adds `AIO_ODM` from `QUADRION_ODM_DIR` too; set both so either path works); `photo-change.spec.ts:380` asserts `report.engines.odm === '3.6.2'` instead of `smrf-grid`, and its comment at 45-58 says Standard runs ODM's dense matching; keep their thresholds and check them against the fake's DSM (the fake interpolates 20,000 true surface points, see Task 3); if a threshold fails, report the measured values before changing it.

- [ ] **Step 2: Build the demos and run the changed specs the CI way, one at a time**

Run (from `apps/desktop`, PowerShell):

```powershell
pnpm demo:build --quick
$env:QUADRION_WINDOW_SIZE = '1100x720'; $env:QUADRION_E2E_SCALE = '1'; $env:QUADRION_E2E_SWGL = 'warp'; $env:QUADRION_E2E_PYTHON = 'E:\Dev\AIO Software\python\.venv\Scripts\python.exe'
npx playwright test e2e/processing-tools.spec.ts --workers=1
npx playwright test e2e/photo-process.spec.ts --workers=1
npx playwright test e2e/photo-products.spec.ts --workers=1
npx playwright test e2e/photo-change.spec.ts --workers=1
npx playwright test e2e/gcp-marking.spec.ts e2e/agent-photo.spec.ts e2e/processing-drawer.spec.ts e2e/walk-360.spec.ts --workers=1
```

Expected: first FAIL where the new expectations meet old behaviour; after Step 3 every run prints `[e2e] window 1100 x 720 px at display scale 1` and passes.

- [ ] **Step 3: Make them pass** (spec code, helpers and the e2e fake only; a product bug found here goes back to its task's owner through the controller).

- [ ] **Step 4: Delete `photo-real.spec.ts`**, drop it from `tools/ci/e2e-timings.json` and `nightly.yml`, then `git grep -n "photo-real\|colmapPython\|PHOTO_REAL" apps tools .github` and fix what remains in your files. Documentation lines (`docs/**`) and `ci.yml` belong to Task 17: list any you find in the hand-off instead of editing them.

- [ ] **Step 5: Whole check**

Run (from the worktree root): `pnpm check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/e2e/odm-fake/fake-setup.mjs apps/desktop/e2e/processing-tools.spec.ts apps/desktop/e2e/photo-process.spec.ts apps/desktop/e2e/photo-products.spec.ts apps/desktop/e2e/photo-change.spec.ts apps/desktop/e2e/photoPack.ts apps/desktop/e2e/photo-fake/aio_photo_fake.py tools/ci/e2e-timings.json .github/workflows/nightly.yml .gitignore
git rm apps/desktop/e2e/photo-real.spec.ts
git commit -m "test(e2e): processing engine card and photo specs on the fake odm" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-review (done while writing)

- **Spec coverage.** Decision 1 (ODM does everything): Tasks 8, 9, 10. Decision 2 (delete our engine): Task 13, add-on Tasks 14 and 17. Decision 3 (pinned download, SHA-256): Tasks 0, 12. Decision 4 (GPU auto, switch, threads): Tasks 2, 4, 12, 15. Decision 5 (Settings card): Task 15. One ODM project per run, hard links, intermediates removed after commit: Tasks 5, 10. `run.json` `engine`: Tasks 4, 8, 10, 11. Presets and flags: Task 2. Progress (UDP, stdout fallback, stage messages), cancel, resume, exit codes: Task 4. One ODM run at a time: Task 14. Install flow, existing ODM, remove, `odm.json`, `AIO_ODM`, `AIO_ODM_GPU`: Tasks 12, 14. Wizard gate: Task 16. `opf.*` checked: deviation 8, Task 13. Contract rows: Task 11. Testing section: fake ODM (Task 3), desktop unit tests (Task 12), e2e (Task 18), real checks (Task 0 and `test_odm_real.py` in Task 10). ADR and notices: Task 17.
- **Placeholders.** The probe-fed constants have concrete defaults and a named step that confirms each; nothing is left to be decided later without a rule.
- **Type consistency.** `run_odm(ctx, odm, project_dir, flags, first, last, log_dir, *, rerun, use_gpu, progress, port)` is called the same way in Tasks 8, 9, 10; `product_steps(products)` and `dense_first(preset)` match between Tasks 2 and 10; `run_odm_dir` (Task 5) is the one place the jobs get their ODM folder; `OdmStatus` fields are the same in Tasks 11, 12, 15; `processingVerdict` gains the engine state in Task 14 and `no-engine` is read in Task 16.
- **Review focus.** Each of the five lines has its test in the owning task (Tasks 4, 5, 10, 12, 18).

## How to test (for the founder, once merged)

1. Open Settings, Processing tools. The new **Processing engine** card is at the top: it explains ODM, its AGPL-3.0 licence, and shows "Download 234 MB, about N GB installed".
2. Click **Download and install**. The bar shows the download in MB, then "Checking the download", "Installing", "Checking the installation". No Windows permission prompt is expected. The card then says "Installed", ODM 3.6.2 and its folder, and "Graphics card: NVIDIA GeForce RTX 5070 Ti, used for processing".
3. Open a project with drone photos, **Create maps from photos**, choose Quick and start. The run panel walks through Read, Match, Map and Add; "Every step" shows "Align the photos (ODM)", "Dense point cloud", "Elevation models", "Orthophoto". The orthophoto, DSM and DTM layers appear on the map when it finishes.
4. Open the job log in Processing: it says how many threads ODM used (21 on the workstation) and "Graphics card used for features: yes; for dense matching: yes" (or "no", with a warning, if the card fell back to the CPU). In ODM's folder (Settings, Processing tools, the folder line), `SuperBuild\install\bin\nvcuda.dll.odm-stub` exists and `nvcuda.dll` does not: that is the renamed placeholder that lets dense matching use the card. Task Manager shows the GPU busy during "Dense point cloud".
5. Cancel a run in the middle of dense matching, then Resume: the log says it resumes from the stage after the last finished one.
6. Switch **Use the graphics card** off in the card, run again: the log says the card was not used, and `nvcuda.dll` is back in ODM's `SuperBuild\install\bin` folder.
7. Make a project in a folder whose name has a space (for example `E:\Stratlas Data\Test site`), create maps with a DTM: the DTM finishes (ODM works on it through a junction).
8. Remove the engine with **Remove**, then **Remove ODM from this computer**: the card says "Not installed", and **Create maps from photos** shows "Install the processing engine first" with a button that leads back to the card.
9. When a window is free: the 995-photo run, timed, against the 7.5 h partial run.

## Risks and open points for the founder

- **Admin prompt**: none seen (Task 0, unattended); nobody watched the screen during that install.
- **Paths**: a space breaks ODM's DTM (unquoted SMRF command) and a non-ASCII letter breaks OpenSfM, so such project folders go through a junction and the install lives under `%LOCALAPPDATA%\QuadrionODM` when the data folder is not safe (as `E:\Stratlas Data` is not). Worth reporting upstream: a two-character quoting fix in ODM's `run_pdaltranslate_smrf`.
- **Dense matching on the GPU** depends on renaming ODM's placeholder `nvcuda.dll` (deviation 17). A very old NVIDIA driver could make OpenMVS fail CUDA start-up; ODM then retries on the CPU ("OpenMVS failed with GPU"), not tested here. A repair of ODM brings the placeholder back; the runner renames it again before the next run.
- **A DTM can hang** when ODM finds no ground points (root cause of the 10-photo hang: a space in the path). Guards: safe paths, never `--rerun-from odm_dem` on an unclassified cloud, a ground check before the DTM, ODM's ground warning stops the step at once, and the watchdog (`AIO_ODM_STALL_MIN`, default 30 minutes) as the last resort.
- **Threads** (deviation 4): 21 on the 64 GB machine; a hand-set memory limit lowers it (founder, 14 Oct).
- **Time estimates** in the wizard still come from our old engine's measurements; recalibrate after the 995-photo run.
- **Georef after products**: features, matches and tracks stay (no `--optimize-disk-space`), so a later georeference does not extract again. Disk: `opensfm/features` and `matches` stay with the run until the person removes it.
- **macOS** loses photogrammetry with this branch (parked anyway).
