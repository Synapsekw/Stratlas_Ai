# ODM as the photogrammetry engine: design

- Date: 14 Oct 2026. Branch `feat/odm-engine`. Status: design approved in chat by the founder; this file is the written spec.
- Supersedes: ADR 0008 decision 2 (our own pipeline on COLMAP) and decision 4 (no ODM adapter). A new ADR 0009 records the switch.

## Why

The first real 1,000-photo run (995 photos, 15.27 ha, pack 0.7.0) ran 7.5 hours and was still inside our own orthomosaic code: one core of 24, 120+ candidate photos per 1024 px window, an LRU cache smaller than one window's working set (no hits), about 830 windows; at the measured rate it needed one to three more days. Alignment worked (COLMAP), but dense matching, fusion, DSM, DTM, ortho, mesh and texture were our own code. ODM was rejected on 7 Oct only because of its AGPL licence under a permissive-only policy; the founder lifted that on 8 Oct. Founder, 14 Oct: stop rebuilding what proper open-source engines already do; time to a finished product matters most.

## What the founder decided (14 Oct)

1. **ODM does everything** from the photos: alignment, dense cloud, DSM, DTM, orthophoto, point cloud, textured mesh.
2. **Our own engine is deleted in this branch**, not kept as a fallback.
3. **ODM is downloaded from ODM's GitHub release, a pinned version** checked against a recorded SHA-256.
4. **GPU auto, with a switch**: use the NVIDIA GPU when present and working, otherwise CPU only; a Settings switch forces CPU only; all sensible CPU threads by default.
5. A **Settings "Processing engine" card** explains ODM and installs it in one click.

## ODM facts this design rests on (desk research, 14 Oct)

- Release **3.6.2** (12 Aug 2026), `ODM_Setup_3.6.2.exe`, 244,864,104 bytes, SHA-256 `c9dbfabf0d066529a7b6c753fd45bf3366a0314266160cd677373bab4caff294` (GitHub API `digest`). Inno Setup, `PrivilegesRequired=lowest` (per user, no admin), default folder `C:\ODM`, self-contained (pixi Python env `gpu-prod` plus SuperBuild binaries), `run.bat` entry point. It silently uninstalls a previous ODM install and may run `vc_redist /quiet`.
- Native Windows runs every stage: dataset, opensfm, openmvs, odm_filterpoints, odm_meshing, mvs_texturing, odm_georeferencing, odm_dem, odm_orthophoto, odm_report, odm_postprocess.
- GPU (NVIDIA, CUDA 12.8 bundled): OpenSfM feature extraction through PopSift only with `--feature-type sift` (the default `dspsift` is CPU); OpenMVS densification with CUDA, falling back to CPU on failure. `--no-gpu` or `ODM_NO_GPU` turns it off. Detection checks `%SYSTEMROOT%\system32\nvcuda.dll`. Log lines say which path ran ("Using GPU for extracting SIFT features", "GPU SIFT extraction failed... fallback to CPU", "OpenMVS failed with GPU... Falling back to CPU").
- CPU: `--max-concurrency` (default 4) sets OpenSfM processes and OpenMVS threads; 2 to 4 GB of RAM per thread on large jobs. RAM guide: 500 images 32 GB, 1,500 images 64 GB.
- Progress: stdout `Running <stage> stage` / `Finished <stage> stage`; UDP datagrams `PGUP/<pid>/<project>/<percent>` to 127.0.0.1:6367 (what NodeODM listens to); `log.json` at the end with stage times, `success` and `error`. Exit codes: 0 ok; 137 or 3221226505 out of memory; 132 unsupported CPU; 3 missing program; 1, 134, 139, 3221225477 bad input.
- Resume: `--rerun-from <stage>`; a plain rerun reuses finished outputs. `--end-with <stage>` stops early.
- Outputs (project folder): `odm_orthophoto/odm_orthophoto.tif`, `odm_dem/dsm.tif`, `odm_dem/dtm.tif`, `odm_georeferencing/odm_georeferenced_model.copc.laz` (with `--pc-copc`), `odm_texturing/odm_textured_model_geo.obj` (and `.glb`), `odm_report/report.pdf`, `odm_report/stats.json`, `odm_report/shots.geojson`, `cameras.json`, `opensfm/reconstruction.json`. CRS: UTM from the reconstruction.
- Not yet verified on this machine (the build checks each first): silent install flags (`/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CURRENTUSER /DIR=`), whether the vc_redist step prompts for admin, GPU paths on an RTX 5070 Ti (Blackwell; CUDA 12.8 is the first toolkit supporting it, but the bundled kernels may not include sm_120), the exact COPC and GLB output names.

## Architecture

ODM runs as a separate, unmodified program started by our Python pipelines through `run.bat` with `ODM_NONINTERACTIVE=1`. The app never links ODM. The job names, the wizard, the Processing drawer, the run panel and the commit into the project stay; only what runs inside the jobs changes.

### One ODM project per run

`<project>/photogrammetry/<run>/odm/` is ODM's project folder. Its `images/` holds hard links to the source photos (copies when hard links fail, e.g. across drives); source photos are never written. The ODM folder survives between the jobs of one run so each job continues where the previous one stopped. Its intermediate folders are removed after products commit (`--optimize-disk-space` during the run).

### Jobs

- **`photo.align`** (rewritten): inspect the photos (our existing EXIF and DJI XMP reader stays for the run's photo list, capture date and footprint), lay out the ODM project, run ODM with `--end-with opensfm`, then read `opensfm/reconstruction.json` (and `cameras.json`) into our run record: camera poses for the map's camera dots, the sparse points, the alignment report. GCP mark prediction reads the same poses, so marking works as before.
- **`photo.georef`** (rewritten): write `gcp_list.txt` from `gcp.json` (control points that are not disabled, confirmed marks only; the CRS line from the file's CRS), run ODM `--rerun-from opensfm --end-with opensfm --gcp gcp_list.txt`, read the new poses, then measure **check points** ourselves from the refined poses (triangulate their confirmed marks, compare with the surveyed position) and write `report/accuracy.json` as today. ODM's own GCP errors from `stats.json` are reported alongside.
- **`photo.products`** (rewritten): run ODM from the stage after alignment (`--rerun-from openmvs`, or `odm_filterpoints` with fast ortho) to the end, with the flags of the preset and the products asked for, then import the outputs:
  - orthophoto GeoTIFF to a `raster` `kit-pyramid` layer (existing `_pyramid` helper);
  - DSM and DTM GeoTIFFs to the shaded relief, height grid and legend layers as today (existing `surface` helpers on a plain GeoTIFF input);
  - COPC to the `pointcloud` `copc` layer (ODM writes COPC; our untwine path is the fallback when only LAZ is there);
  - textured model to the `mesh` layer as GLB (ODM's GLB, or OBJ to GLB if absent), and 3D Tiles as the existing `tiles` step does;
  - `report.pdf` and `stats.json` kept in `photogrammetry/<run>/report/`.
- `run.json` gains the engine and its version (`engine: { name: "odm", version: "3.6.2", gpu: { features, dense } }`).

### Presets to ODM flags

| Preset   | Flags                                                                        |
| -------- | ---------------------------------------------------------------------------- |
| Fast     | `--fast-orthophoto --skip-3dmodel --pc-quality low --feature-quality medium` |
| Standard | `--pc-quality medium --feature-quality high`                                 |
| High     | `--pc-quality high --feature-quality ultra`                                  |

Always: `--dsm --dtm --cog --pc-copc --build-overviews --optimize-disk-space --orthophoto-resolution <GSD-based> --dem-resolution <GSD-based>`, `--skip-3dmodel` when no mesh was asked for, `--max-concurrency <threads>`. Products not asked for are not imported. Matcher and SfM: ODM defaults (`--sfm-algorithm incremental`, `--matcher-type flann`).

### GPU and CPU

- Setting `processing.odm.gpu`: `auto` (default) or `off`.
- `auto` and `nvcuda.dll` present: `--feature-type sift` (PopSift on the GPU) and OpenMVS's CUDA dense. Otherwise `--no-gpu` and ODM's default `dspsift`.
- Threads: `max-concurrency = clamp(min(logical CPUs - 2, floor(RAM GB / 3)), 2, 32)` (20 on a 24-thread, 64 GB machine). The memory budget setting we already have (`AIO_PHOTO_MEMORY_MB`) lowers it further when set.
- After each ODM run the job log says plainly: "Graphics card used for features: yes/no; for dense matching: yes/no", taken from ODM's log lines, and `run.json` records it. A GPU fallback is a warning, not a failure.

### Progress, cancel, resume, errors

- Progress: a UDP listener on 127.0.0.1:6367 for the job's lifetime turns `PGUP/<pid>/<project>/<percent>` (filtered by our project name) into the job's progress, mapped onto the job's own range (align covers ODM 0 to 25, products 25 to 100). When the port is taken, stage lines on stdout drive progress instead. Stage lines also set the step's message ("Dense matching", "Orthophoto", ...).
- One ODM run at a time across the app (the existing heavy-job gate covers photo jobs).
- Cancel: kill the ODM process tree (existing `native.run_tool` cancel path).
- Resume: our step records say which job steps are done; inside an ODM step, the rerun starts from the stage after the last `Finished <stage> stage` in ODM's log.
- Errors: exit codes map to plain messages (out of memory: "ODM ran out of memory; try the Fast preset or close other programs"; bad input; missing program: "Reinstall the processing engine in Settings"), with the last ODM log lines in the job log.

### Settings: Processing engine card

On the Settings page "Processing tools" (the existing tools page), a card above the pipeline pack card:

- Title "Processing engine"; a short plain explanation: ODM (OpenDroneMap) turns drone photos into maps, elevation models, point clouds and 3D models on this computer; it is free, open-source software under the AGPL-3.0 licence (link to the licence and to ODM's site); download size 234 MB, about N GB installed (measured in the build).
- Status: not installed / installing (downloading x of y MB, checking, installing) / installed (version, folder) / update available (pinned version newer than installed) / broken (files missing).
- Hardware line: "Graphics card: NVIDIA GeForce RTX 5070 Ti, used for processing" or "No NVIDIA graphics card found; processing uses the CPU".
- Switch "Use the graphics card" (on by default; off forces CPU only).
- Buttons: Download and install; Cancel (while downloading); Update; Remove (with an inline confirm).
- When another ODM install exists (an Inno uninstall entry for ODM, or `C:\ODM\run.bat`), the card says that installing will replace it and asks for a confirm first.

Install flow (main process): `downloadVerified` (existing; resume, size and SHA-256 check) into `<dataRoot>/runtime/downloads/`, then run the setup with `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CURRENTUSER /DIR=<dataRoot>\runtime\odm-<version>`, wait, verify `run.bat` and the bundled Python exist, run a smoke test (`run.bat --help` exits 0), write `<dataRoot>/runtime/odm.json` (version, folder, installedAt). The pinned version, URL, size and SHA-256 live in one file in the desktop main process. Remove runs the Inno uninstaller silently and deletes `odm.json`. The pipelines get the folder as `AIO_ODM` through the existing `jobEnv` hook, and the GPU setting as `AIO_ODM_GPU`.

Create maps without ODM installed: the wizard's Start button is replaced by a notice "Install the processing engine first" with a link to the card (the same gate the pipeline pack has today).

## What is deleted

- Python: COLMAP alignment and our bundle adjustment (`colmap_io`, feature, matching and mapper code in `photo/align.py`, the georef adjustment in `photo/georef.py`), `photo/dense.py`, `photo/fuse.py`, the DSM and DTM rasterising in `photo/surface.py` (keep the GeoTIFF-to-layer helpers), `photo/ortho.py`, `photo/mesh.py`, `photo/texture.py`, the GPU accelerator code for our dense matching, and their tests and synthetic fixtures that only serve them.
- Pack dependencies used only by the deleted code: `pycolmap`, `pymeshlab` (and anything else the build proves unused). OpenCV, PDAL and untwine stay while walks, panoramas and the point cloud import use them.
- The GPU add-on (`addon.ts`, `photoAddonEnv`, its lock and docs), which only served our dense matching.
- `opf.export` and `opf.import` are checked: if they read COLMAP models they are rewritten against the run record or removed; the build reports which.
- Old runs keep their committed layers; re-processing an old run starts from the photos with ODM.

## Contract changes (rows for `docs/architecture/contract-changes.md`)

- IPC: `odm:status`, `odm:install`, `odm:cancel`, `odm:remove`, `odm:setGpu`; event `odm:progress`. Schema types `OdmStatus`, `OdmInstallProgress` in `packages/schema`.
- Settings: `processing.odm.gpu` (`auto` | `off`).
- `aio.photo-run/1`: optional `engine` object (additive). The COLMAP-specific fields are no longer written (readers already treat them as optional; the build confirms).
- Removed: the GPU add-on channels and env, if any shipped.

## Testing

- Python (TDD): a **fake ODM** (`python/tests/fake_odm/`, a `run.bat` plus a Python script) that honours `--end-with`, `--rerun-from`, `--gcp` and the product flags, writes ODM's real folder layout with tiny valid outputs (GeoTIFFs, a COPC or LAZ, a GLB, `reconstruction.json`, `log.json`), prints stage lines, sends UDP progress, and can be told to fail with a given exit code or to hang (for cancel). Tests: flag building per preset and GPU setting, thread count, GCP file writing, progress mapping (UDP and stdout fallback), cancel kills the tree, resume picks the right stage, exit-code messages, output import per product, check-point measurement from poses.
- Desktop unit tests: install flow (download, verify, run setup, smoke test, `odm.json`) with a fake setup executable; status and update detection; existing-ODM detection.
- E2E: `processing-tools.spec.ts` extended for the Processing engine card (fake setup served locally; install, progress, installed state, switch, remove); `photo-process.spec.ts` and `photo-products.spec.ts` on the fake ODM; specs for deleted code removed.
- Real checks on this machine during the build: one real install of 3.6.2 with the silent flags (confirms admin prompts, installed size, output names), one small real run (about 30 photos) with the GPU on to confirm the GPU log lines on the RTX 5070 Ti.
- After merge, in a window the founder picks: the 995-photo run, timed, compared with the 7.5 h partial run.

## Risks

- ODM's setup removes another ODM install on the PC: detected and confirmed in the card first.
- vc_redist may need admin once: the card says so if the setup reports it.
- RTX 5070 Ti kernels: if ODM's bundled CUDA code does not run on Blackwell, ODM falls back to CPU by itself; the job log says so; nothing fails.
- UDP port clash with another ODM tool: stdout stage lines take over.
- A pinned version means updates are ours to test and bump.
