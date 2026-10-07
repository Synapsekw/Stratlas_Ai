# M10 Globe and photogrammetry

> 7 Oct 2026. Started after M9 merged (0.9.0); the founder took every decision as recommended on 7 Oct 2026 (see "Decisions"), and G0 wrote the contracts the same day (see "What G0 did differently"). Test steps go into stage M10 of `docs/TESTING.md`. Version 0.10.0 at the start of M10 (one minor per milestone; see decision 11 for how this meets the 1.0 release line). Pipeline pack 0.4.0, `appRange` `>=0.10.0 <2.0.0`.

**Goal:** Stratlas turns a folder of drone photos into the layers it already shows: an orthomosaic, a surface model (DSM and DTM), a COPC point cloud and a textured mesh, with an accuracy report against ground control points. It does this offline, on an ordinary workstation, inside the pipeline pack, from permissively licensed parts only. It reads and writes OPF, so Pix4D projects come in and our processing can go out. A new **Globe** view, built on CesiumJS, puts every site, survey, model, cloud and issue on the Earth, over offline satellite imagery and terrain packs; the site view gains 3D Tiles and terrain through the same open standards, so every existing tool keeps working. Nothing in M10 needs a network connection, an account or a Cesium ion token.

## What the founder asked, and what it means

The request of 7 Oct 2026 (near verbatim): integrate Cesium ([CesiumGS/cesium](https://github.com/cesiumgs/cesium)) "to import the satellite maps and work with a globe"; integrate photogrammetry "for processing the images into maps", either OPF ([Pix4D/opf-spec](https://github.com/Pix4D/opf-spec)) or ODM ([opendronemap/ODM](https://github.com/opendronemap/ODM)), "pick what's best for us"; and "everything we put here has an Apache license as well".

Four findings shape the plan:

1. **Cesium is a renderer, not a data source.** CesiumJS is Apache-2.0, but the satellite imagery and terrain it usually shows (Cesium ion, Bing, Google Photorealistic 3D Tiles) are online services whose terms forbid offline caching and redistribution. Offline satellite maps need data with its own licence, packed by us or supplied by the customer. See "Imagery and terrain: sources and licences".
2. **OPF and ODM are not alternatives.** OPF is a CC-BY-4.0 project and interchange format (cameras, calibration, control points, outputs); it processes nothing. ODM processes, but it is AGPL-3.0 and cannot ship in Stratlas. The answer is our own processing pipeline from permissive parts, with OPF for interchange. See "Photogrammetry: options and recommendation".
3. **"Apache only" taken literally would remove what already ships.** GDAL is MIT-style, PDAL is BSD, and the pipeline pack's Shapely and rasterio wheels already carry GEOS (LGPL-2.1) as a dynamically linked library. Decision 1 proposes the reading "permissive only".
4. **The licence traps are in the native dependencies, not the headline projects.** Each is avoidable; each is listed below with the fix:
   - COLMAP is BSD-3, but it requires CHOLMOD's GPL Supernodal module, its default build adds an AGPL line-segment detector and CGAL, and its GPU build adds a non-commercial GPU SIFT. The official pycolmap Windows wheel ships `cholmod.dll` and `spqr.dll` (GPL-2.0+).
   - Ceres' own documentation says a Ceres build with SuiteSparse is GPL licensed.
   - The PyPI `opencv-python-headless` macOS arm64 wheel bundles GPL FFmpeg codecs (x264, x265 and others); OpenSfM depends on the full `opencv-python`, and on fpdf2 (LGPL-3.0).
   - pyopf is Apache-2.0, but its `tools` extra pulls in GPL-3.0 plyfile.
   - 3d-tiles-tools is Apache-2.0, but depends on sharp, whose libvips binaries are LGPL-3.0.
   - ODM's orthophoto, DEM and tiling helpers (odm_orthophoto, dem2mesh, Obj2Tiles and others) are GPL-3.0 or AGPL-3.0 too, so even the "permissive subset" of ODM needs our own orthophoto and DEM code.

**PRD change:** `docs/PRD.md` lists "Photogrammetry or LiDAR processing from raw images or scans (Pix4D, Metashape, DJI Terra stay upstream)" as a non-goal. M10 moves photogrammetry from images into scope (LiDAR processing stays out). G0 edits the non-goal and adds the requirement lines PHO-1 to PHO-8 and GLB-1 to GLB-5 (globe).

## Global constraints (principles)

- **Offline first, zero network.**
  - Processing, the Globe, imagery and terrain make no requests. CesiumJS runs with no ion token (`Ion.defaultAccessToken` unset), no default imagery, no default terrain, no geocoder and no base-layer picker; its static assets ship inside the app and load from `'self'`.
  - Imagery and terrain come only from packs in the data folder, read through `aio://` or the renderer's PMTiles reader.
  - Downloading a pack is an explicit online action, as `packs:download` is today, refused when the workstation is offline-only (`Settings.offlineOnly`).
  - The zero-network e2e guard stays green with the Globe open, with processing running and with the ODM adapter configured (loopback only, through `AIO_NETWORK_GUARD_ALLOW` in its test).
- **Licences (decision 1).**
  - Shipped code is permissive: Apache-2.0, MIT, BSD-2/3-Clause, ISC, Zlib, BSL-1.0, PSF and similar, plus public-domain or CC-BY data with attribution.
  - Never GPL, AGPL or SSPL anywhere we ship (app, pipeline pack, packs, server image). Never LGPL linked statically. LGPL only as an unmodified, separately replaceable shared library that is already in the pack today (GEOS) or that the founder approves. MPL-2.0 only with founder approval (the app's allow-list already admits it; M10 records each MPL item by name).
  - No non-commercial or research-only code or model weights (SiftGPU, SuperPoint weights, the EOX cloudless 2018 to 2025 imagery).
  - The licence gate covers npm, the Python wheels **and the native libraries inside wheels and the pack's tools folder** (G1). Every data pack carries its licence and attribution in its metadata, and the attribution shows in the Globe, the map and every export that contains the data.
- **A person decides.**
  - Processing writes new derived layers next to what is there; it never replaces a delivered ortho, model or cloud.
  - Refined camera poses from alignment are offered, not applied: **Use refined poses** writes the photos layer's `cameras.json` with a `.bak`, after a preview of how far each camera moves.
  - GCP marks predicted or detected by the software are drafts until a person confirms them. The accuracy report shows every residual; nothing hides a bad control point.
- **Never modify delivered data in place.**
  - Source photos are read-only. EXIF and XMP are read, never written. Photos are referenced where they are or copied into the project, as the import does today; processing never moves them.
  - Work files live in `<project>/photogrammetry/<run>/` and job staging; outputs are committed atomically (the runtime's staging and `os.replace`).
  - Packages stay read-only; player mode never starts processing.
- **Contracts are additive, and older builds keep opening projects.** A hard finding from the code:
  - `ProjectManifest.layers` is `z.array(Layer)` and `Layer` is a discriminated union on `kind`. A new layer kind, a new raster `format` or a new `LayerDerived.kind` value makes an 0.9 build refuse the **whole** manifest (rule 2 of `docs/release/UPGRADE-POLICY.md`).
  - So M10 adds **no** layer kind, no raster format and no `LayerDerived.kind`. Photogrammetry outputs use existing kinds: `mesh` (GLB), `pointcloud` (`copc`), `raster` `ortho` and `dsm` (`kit-pyramid`). Their provenance lives in the new `photogrammetry/<run>/run.json`, which lists the layers it made.
  - 3D Tiles for the site view and the Globe live in a new file, `<project>/tilesets.json` (`aio.tilesets/1`), which older builds ignore.
  - Imagery and terrain packs live in new folders (`packs/imagery/`, `packs/terrain/`) that older builds never scan, so an 0.9 build never mistakes a raster pack for a street map.
  - G0 also makes the 0.10 manifest reader tolerant of layer kinds it does not know (kept on save, shown as "needs a newer Stratlas"), so the next additive layer kind in 1.x does not repeat this constraint.
  - Every change gets a row in `docs/architecture/contract-changes.md` before it merges.
- **No client data, ever.**
  - Tests, fixtures, the demo and screenshots use only the synthetic photogrammetry set (G8) and synthetic packs.
  - A real flight is used only on the founder's machine through `@realdata` tests on a temporary copy (`apps/desktop/e2e/realData.ts`), never written to, never committed, never uploaded as a CI artifact, never in a screenshot in the guide.
  - `check-no-client-data` is extended to EXIF and XMP in synthetic images (no real camera serials, no real coordinates outside the fictional site), OPF files, tilesets and pack metadata.
- **Heavy work off the UI thread.**
  - Processing runs in the pipeline pack as jobs (`<project>/jobs/<jobId>/`): resumable per stage, cancellable, inputs hashed, progress per stage. Native tools run as child processes the job can kill (the whole process tree on Windows).
  - The Globe is a lazily loaded renderer chunk; CesiumJS workers run in web workers. Tiling, imagery and terrain pack builds run in the pack.
- **Disk and memory are budgets, not surprises.** Before each heavy stage the job checks free disk against its estimate and refuses with the number ("needs 38 GB free on E:, has 21 GB"). Dense matching and fusion work in tiles or image clusters within the memory cap set in Settings.
- **Tests.**
  - Windows stay off-screen (`STRATLAS_USER_DATA`); e2e runs with `--workers=1` locally.
  - CI has no GPU. Every CPU path is tested in CI; the GPU (CUDA) path, if decision 5 adds it, is tested on the founder's machine and a self-hosted runner only.
  - The zero-network guard stays on. Real-data tests carry `@realdata` and only ever run on a copy.
  - `pnpm check`, `pnpm test:e2e`, `uv run pytest` and the new `pack-native` job must be green before each merge.

## Review focus

- **Licence hygiene of native builds.** Reviewers read the vcpkg SBOM diff of every pack build: no SuiteSparse SPQR, CHOLMOD Supernodal, MatrixOps or Modify; no LSD; no SiftGPU; no CGAL; no libraw, libheif or FFmpeg in OpenImageIO or OpenCV; no curl or OpenSSL inside COLMAP (`DOWNLOAD_ENABLED=OFF`).
- **Georeferencing correctness.**
  - CRS and axis order (EPSG:4326 latitude first in PROJ), UTM zone choice, and the project's local frame (Y up, X east, Z south).
  - Vertical datums: DJI `AbsoluteAltitude` is nominally above mean sea level and often tens of metres off; RTK aircraft report ellipsoidal heights; Copernicus DEM is EGM2008; Cesium wants heights above the WGS84 ellipsoid. Every conversion goes through PROJ with a named geoid grid and is tested with a known point.
  - Accuracy is honest: checkpoints are never used in the adjustment, and the report says so.
- **Scale on ordinary hardware.** 1,000 photos of 20 MP on a 32 GB workstation, and 300 photos on a 16 GB laptop, finish with bounded memory and a correct disk estimate. Resume after a crash or a quit restarts at the stage boundary, not from the start.
- **Cancel and kill.** Cancelling a job stops native children (COLMAP, PDAL, `texrecon`) within 5 s on Windows and macOS, and leaves no orphan process.
- **Two renderers, one truth.**
  - The Globe and the site view place a surveyed point within 2 cm of each other (project CRS to ECEF through PROJ, never through a UTM-as-metres shortcut, which is off by about 4 cm per 100 m from the grid scale factor).
  - Nothing is edited in the Globe: picking, annotation, measuring and editing stay in the site view, so there is one implementation of each.
- **Zero network with Cesium.** No request to `cesium.com`, `ion`, `virtualearth.net` or any font, sprite or credit image host, in any code path, including errors.
- **Pack and installer size.** The pack and installer stay within the budgets of decision 6, enforced in CI.
- **Hostile inputs.** A photo folder with corrupt JPEGs, mixed cameras, no GPS, panoramas, duplicates, or 10,000 files; an OPF with absolute paths, `..` or huge declared sizes; a GeoTIFF with an unknown CRS or a 100 GB declared size: exact errors, never a crash of main.

## Licence policy and inventory

### The policy (decision 1)

Recommended reading of "Apache only": **permissive only.**

| Class                                                                                         | Rule                                                                                                                                        | Examples in M10                                                                                                                              |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Apache-2.0, MIT, MIT-0, BSD-2/3-Clause, ISC, 0BSD, Zlib, BSL-1.0, PSF-2.0, Unlicense, CC0-1.0 | Allowed                                                                                                                                     | CesiumJS, 3DTilesRendererJS, COLMAP, OpenCV, Ceres, PROJ, GDAL, PDAL, pyopf (core)                                                           |
| Public domain or CC-BY-4.0 data                                                               | Allowed with attribution shown in the app and exports                                                                                       | Natural Earth, NASA Blue Marble, Landsat, Copernicus DEM, ESA WorldCover                                                                     |
| LGPL                                                                                          | Never statically linked. As an unmodified shared library only when already shipping (GEOS in Shapely and rasterio) or approved by name      | GEOS (already in the pack); nothing new in M10                                                                                               |
| MPL-2.0                                                                                       | Only with founder approval, by name (file-level copyleft: our changes to those files would be published)                                    | Eigen headers (needed by every candidate pipeline; unmodified); DOMPurify in CesiumJS is dual MPL-2.0 or Apache-2.0, and we elect Apache-2.0 |
| GPL, AGPL, SSPL, non-commercial, research-only, "no derivatives"                              | Never in anything we ship. A user may install such software themselves and point Stratlas at it (decision 2), which we never ship or modify | ODM, NodeODM, WebODM, OpenMVS, CGAL, pymeshlab, SiftGPU, EOX cloudless 2018 to 2025                                                          |

Strictly Apache-only would remove GDAL (MIT-style), PDAL (BSD), numpy, SciPy, Pillow and most of the pipeline pack, and would forbid every public-domain imagery source. The founder's intent (no copyleft, nothing that forces us to publish our code or limits commercial use) is met by "permissive only".

### The licence gate (extended in G1)

Today `tools/release/license-check.mjs` checks npm (allow-list for production dependencies, no GPL or AGPL anywhere) and `python/tests/test_licences.py` checks Python distribution metadata (no GPL or AGPL; LGPL tolerated). Neither sees native libraries bundled inside wheels (`rasterio.libs/` holds about 35 DLLs including GDAL, GEOS, PROJ, libcurl, OpenSSL, HDF5 and libpq) or native tools in the pack. M10 extends the gate:

1. **npm:** the allow-list gains `Zlib` (pako inside CesiumJS is `MIT AND Zlib`) and `BSL-1.0` if a Boost-licensed package appears; `@cesium/engine`, `@cesium/core` and `3d-tiles-renderer` dependency trees scanned; DOMPurify's dual licence recorded as the Apache-2.0 election. `MPL-2.0` stays allowed but each MPL package is listed in a new `tools/release/licence-exceptions.json` with the founder's approval date, and the check fails on an unlisted one.
2. **Python:** `test_licences.py` gains the same allow-list as npm (not only "no GPL"), reads `License-Expression` first, and fails on any distribution whose licence it cannot classify unless it is in the exceptions file. Extras are never installed in the pack (pyopf's `tools` extra pulls GPL-3.0 plyfile).
3. **Native (new):** `tools/release/native-licences.mjs`
   - reads the SPDX SBOM vcpkg writes for every port it builds (`share/<port>/vcpkg.spdx.json`) for the pack's own native builds (COLMAP, OpenCV, PDAL, `texrecon`);
   - lists every DLL, dylib and executable in the pack (the wheels' `*.libs` and `.dylibs` folders and `tools/`) and maps each to a row in `tools/release/native-libs.json` (name, version, SPDX, source URL), failing on any file without a row;
   - fails on GPL, AGPL, LGPL-static (any LGPL object inside a static archive or a non-replaceable binary) and non-commercial;
   - runs in the CI job `pack-native` and in `pipeline-pack` builds.
4. **Data:** `tools/release/data-licences.mjs` checks that every imagery and terrain pack built by our tools carries `licence`, `attribution` and `source` in its metadata, and refuses CC-BY-NC, CC-BY-SA (share-alike on derived works) and unknown licences for packs we distribute.
5. **Inventory:** `tools/release/notices.mjs` (`docs/release/THIRD-PARTY-NOTICES.md`) gains a "Pipeline pack native libraries" section from `native-libs.json` and a "Map and imagery data" section from the pack metadata, so procurement sees one list. The app's Settings, About lists the same.

### Inventory of what M10 proposes

Verified on 7 Oct 2026 through the GitHub licence API, PyPI and npm metadata, vcpkg port manifests and source files. Rows marked "verify in G1" are checked again when the build is first made.

**Photogrammetry (pipeline pack):**

| Component                                                                              | Licence                                                                                         | Use                                                                                        | Notes and traps                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [COLMAP](https://github.com/colmap/colmap) 4.2.1 (29 Sep 2026), with pycolmap bindings | BSD-3-Clause ([vcpkg.json](https://github.com/colmap/colmap/blob/main/vcpkg.json))              | Features, matching, incremental and global SfM, bundle adjustment, fusion, Poisson meshing | **Traps, all avoidable by our own build:** (1) `find_package(CHOLMOD REQUIRED)` and `CholmodSupernodalLLT` in `src/colmap/optim/sparse_cholesky.h` need CHOLMOD's Supernodal module (GPL-2.0+); a small patch uses the Eigen `SimplicialLDLT` fallback already in that class (upstream PR proposed). (2) Ceres' vcpkg `suitesparse` feature pulls `suitesparse-cholmod[matrixops]` and `suitesparse-spqr`, both GPL-2.0+ ([ceres port](https://github.com/microsoft/vcpkg/blob/master/ports/ceres/vcpkg.json), [cholmod port](https://github.com/microsoft/vcpkg/blob/master/ports/suitesparse-cholmod/vcpkg.json)). (3) `LSD_ENABLED` defaults ON and `src/thirdparty/LSD/lsd.c` is AGPL-3.0+. (4) GPU builds compile `src/thirdparty/SiftGPU`, whose licence allows "educational, research and non-profit purposes" only. (5) `CGAL_ENABLED` defaults ON (CGAL meshing packages are GPL-3.0+). (6) `DOWNLOAD_ENABLED` defaults ON (curl, OpenSSL, model downloads). |
| pycolmap wheels on PyPI (4.2.1, cp313, win_amd64 and macosx_14_0_arm64)                | BSD-3-Clause metadata                                                                           | Not used as is                                                                             | CPU-only. Built with LSD, CGAL, GUI, CUDA and ONNX off ([build script](https://github.com/colmap/colmap/blob/main/python/ci/install-colmap-windows.ps1)), but from the vcpkg manifest with `ceres[suitesparse]`: the Windows wheel ships `cholmod.dll` and `spqr.dll` (GPL-2.0+), plus libcurl, OpenSSL and libgfortran; the macOS wheel is one static 54 MB `_core.so` built the same way. **Never ship the PyPI wheels.** We build our own wheel from the same sources with the overlay below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| [Ceres Solver](https://github.com/ceres-solver/ceres-solver) 2.2                       | BSD-3-Clause (Abseil, now required, is Apache-2.0)                                              | Bundle adjustment                                                                          | Its [installation docs](https://github.com/ceres-solver/ceres-solver/blob/master/docs/source/installation.rst) warn that a build with SuiteSparse is GPL licensed. Built `ceres[eigensparse,schur]` with METIS, without `suitesparse` and without `lapack` (prebuilt LAPACK brings libgfortran). On macOS the Accelerate sparse solver is used. The docs say Eigen's simplicial sparse Cholesky is "considerably worse" in speed than SuiteSparse or Accelerate: G2 measures it on 1,000 images.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Eigen 3.4 or 5.0                                                                       | MPL-2.0 ([COPYING.README](https://gitlab.com/libeigen/eigen/-/blob/master/COPYING.README))      | Linear algebra (headers)                                                                   | The formerly LGPL sparse files are now MPL-2.0, so all of Eigen is MPL-2.0 and every candidate pipeline needs it. Header-only and unmodified, so MPL creates no obligation beyond notices; listed in `licence-exceptions.json` for founder approval (decision 1).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| METIS 5 (with GKlib)                                                                   | Apache-2.0                                                                                      | Graph ordering                                                                             |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| SuiteSparse AMD, CAMD, COLAMD, CCOLAMD, config                                         | BSD-3-Clause                                                                                    | Orderings (if Ceres or COLMAP asks for them)                                               | The BSD modules only. CHOLMOD (any module), SPQR, CSparse and CXSparse are excluded; the native gate fails on them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| OpenImageIO 3.1                                                                        | Apache-2.0                                                                                      | COLMAP image IO (replaced FreeImage)                                                       | Default features only: libjpeg-turbo (BSD and IJG), libpng (libpng), libtiff, OpenEXR (BSD-3), OpenColorIO (BSD-3), fmt and robin-map (MIT), zlib. Never the `libraw` (LGPL or CDDL), `libheif` (LGPL), `ffmpeg` or `opencv` features.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Boost (algorithm, graph, heap, program-options, property-tree, unordered)              | BSL-1.0                                                                                         | COLMAP                                                                                     | Add `BSL-1.0` to the allow-lists.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| gflags, glog, SQLite                                                                   | BSD-3-Clause, BSD-3-Clause, public domain                                                       | COLMAP                                                                                     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| PoseLib, faiss (fetched by COLMAP's CMake)                                             | BSD-3-Clause, MIT                                                                               | Minimal solvers, retrieval                                                                 | Pinned by hash in COLMAP's CMake; the vendored sources go into the source archive we keep for each pack (G1). Verify in G1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| VLFeat (vendored SIFT in COLMAP)                                                       | BSD-2-Clause                                                                                    | CPU SIFT                                                                                   | SIFT's patent expired in March 2020.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| PoissonRecon (vendored in COLMAP)                                                      | MIT ([licence](https://github.com/colmap/colmap/blob/main/src/thirdparty/PoissonRecon/LICENSE)) | Screened Poisson meshing                                                                   | Same author and licence as [mkazhdan/PoissonRecon](https://github.com/mkazhdan/PoissonRecon).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| OpenCV 5.0 (own build)                                                                 | Apache-2.0 (since 4.5.0)                                                                        | Stereo matching (SGBM), rectification, target detection                                    | Built without FFmpeg, GStreamer, Qt, GTK and non-free modules. **No PyPI wheel is clean** ([opencv-python licensing](https://github.com/opencv/opencv-python#licensing)): the Windows headless wheel adds an LGPL FFmpeg plugin DLL, and the macOS arm64 headless wheel (5.0.0.93) bundles Homebrew FFmpeg with libx264, libx265, librubberband, libvidstab and libpostproc (GPL-2.0+) and gnutls (LGPL).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| [mvs-texturing](https://github.com/nmoehrle/mvs-texturing) (`texrecon`)                | BSD-3-Clause                                                                                    | Mesh texturing                                                                             | No gco (the research-only graph-cut library): view selection uses mapMAP ([mapmap_cpu](https://github.com/dthuerck/mapmap_cpu), BSD-3, with `dset` under a zlib-style licence). Other dependencies: rayint (BSD-3), the MVE fork (BSD-3), TBB (Apache-2.0), Eigen (MPL-2.0), libpng, libjpeg, libtiff. Upstream says Windows is "not checked"; ODM's BSD-3 forks build on win-64 and osx-arm64 and are our build reference.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| [MVE](https://github.com/simonfuhrmann/mve) (`dmrecon`, `scene2pset`, `fssrecon`)      | BSD-3-Clause                                                                                    | CPU dense depth maps (candidate), FSSR meshing (candidate)                                 | Maintenance only (last commit May 2026). Pure CPU with OpenMP; good quality but slow. Skip UMVE (Qt). ODM's fork builds on win-64.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| [OpenSfM](https://github.com/mapillary/OpenSfM) (alternative SfM, spike only)          | BSD-2-Clause                                                                                    | Compared against COLMAP in G2's spike                                                      | Active commits (5 Oct 2026) but no tagged release since 2020 and not on PyPI; no upstream Windows CI. Its dependencies include fpdf2 (LGPL-3.0, PDF report) and the full `opencv-python` wheel, and `third_party/openmvs/Interface.h` has no licence header (from AGPL OpenMVS): all three would be removed in our build.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| PDAL 2.10 CLI                                                                          | BSD-3-Clause                                                                                    | COPC writing, ground classification (`filters.smrf`), gridding                             | **Today the pack does not bundle PDAL**: `pointcloud.py` looks for `<pack>/tools/pdal` and then the PATH. M10 bundles a vcpkg build. Its GEOS dependency (LGPL-2.1, shared) is the same library the pack already ships in Shapely; decision 1 confirms it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| GDAL (inside the rasterio wheel), PROJ, pyproj                                         | MIT-style, MIT, MIT                                                                             | Rasters, COG, reprojection, geoid grids                                                    | pyproj 3.8.0 has cp313 wheels for both platforms. PROJ geoid grids: `us_nga_egm96_15.tif` and `us_nga_egm08_25.tif` (NGA, public domain) from PROJ-data, bundled as needed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| [pyopf](https://github.com/Pix4D/pyopf) 1.4.1                                          | Apache-2.0                                                                                      | OPF read and write                                                                         | Core dependencies: numpy, Pillow, pygltflib (MIT), python-dateutil (Apache-2.0 or BSD), simplejson (MIT or AFL-2.1). **Trap:** the `tools` extra pins `plyfile==0.9` (GPL-3.0+) and an old pyproj; never install extras.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| OPF specification                                                                      | CC-BY-4.0                                                                                       | Format we read and write                                                                   | Attribution to Pix4D in the guide and notices.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| laspy 2.7, fast-simplification 0.2, xatlas 0.0.11, piexif                              | BSD-2-Clause, MIT, MIT, MIT                                                                     | LAS IO, mesh decimation, UV atlas, EXIF for synthetic fixtures (dev)                       | All have cp313 wheels for Windows x64 and macOS arm64 (fast-simplification, xatlas). **Not** pymeshlab (GPL-3.0) and **not** Open3D (MIT, but its third-party list includes libzmq under LGPL-3.0 with a static-link exception, and the wheel requires dash, flask and ipywidgets).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

**Globe and 3D Tiles (desktop app, npm):**

| Component                                                                                                         | Licence    | Use                                                     | Notes and traps                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [CesiumJS](https://github.com/CesiumGS/cesium) 1.146.0 (1 Oct 2026): `@cesium/engine` 26.4 and `@cesium/core` 0.1 | Apache-2.0 | Globe view                                              | Use `@cesium/engine` and `@cesium/core` (new in 1.146: maths, geometry and time classes move there; importing them from the engine is deprecated and removed in 1.150), never `@cesium/widgets`: its Knockout runs `eval` and would need `'unsafe-eval'`. Runtime dependencies ([ThirdParty.json](https://github.com/CesiumGS/cesium/blob/main/ThirdParty.json)) are Apache-2.0, MIT, ISC or BSD-3, except pako (`MIT AND Zlib`), dompurify (`MPL-2.0 OR Apache-2.0`, elect Apache) and tslib (0BSD). No copyleft. Bundled `Assets/`: Natural Earth II (public domain), the sky box (NASA Tycho star maps), Cesium-made data (IAU2006_XYS, approximate terrain heights); Bing and Google credit logos (trademarks) and the moon, water-normal and lens-flare textures (provenance not stated) are left out of our copy (`skyBox` ours or off). |
| [3DTilesRendererJS](https://github.com/NASA-AMMOS/3DTilesRendererJS) `3d-tiles-renderer` 0.5.3 (18 Sep 2026)      | Apache-2.0 | 3D Tiles, terrain and imagery in the three.js site view | Peer `three >=0.167` (we are on r186; it tests against 0.185). Dependencies: pbf (BSD-3), pmtiles (BSD-3, already ours), @mapbox/vector-tile (BSD-3), @mapbox/point-geometry (ISC). Plugins we use: `ImplicitTilingPlugin`, `TerrariumMeshPlugin`, `QuantizedMeshPlugin`, `ImageOverlayPlugin` (with a PMTiles overlay). **Trap:** its examples load the Draco and KTX2 decoders from the gstatic CDN; we point them at our bundled decoders.                                                                                                                                                                                                                                                                                                                                                                                                  |
| [3d-tiles-tools](https://github.com/CesiumGS/3d-tiles-tools) 0.5.4                                                | Apache-2.0 | **CI only**, as a validator and test oracle             | Depends on `sharp` (libvips, LGPL-3.0 binaries), `better-sqlite3`, `gltfpack` and the full `cesium` package. Never shipped; a dev dependency of `tools/` only, where the gate tolerates LGPL dev tooling as it does today.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| [cesium-native](https://github.com/CesiumGS/cesium-native)                                                        | Apache-2.0 | Not used in M10                                         | C++; relevant only if tiling moves to C++ later.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| py3dtiles 12.1                                                                                                    | Apache-2.0 | Not used                                                | Pulls numba, llvmlite, pyzmq (bundles libzmq, MPL-2.0) and pins `numpy<2.4`. Our own COPC-to-tiles writer is smaller (G7).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

**Excluded, and why:**

| Component                                                                                                                   | Licence                                                                                 | Why excluded                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ODM, NodeODM, WebODM, OpenMVS (and the 2026 forks ODX and NodeODX)                                                          | AGPL-3.0                                                                                | Copyleft over the whole program. Optional "your own ODM" adapter only (decision 2).                                                                    |
| AliceVision, Meshroom, OpenMVG                                                                                              | MPL-2.0                                                                                 | Allowed only with approval; AliceVision's dense step needs CUDA and adds little over COLMAP.                                                           |
| CGAL (meshing and most packages)                                                                                            | GPL-3.0+ (kernel LGPL)                                                                  | COLMAP's Delaunay mesher and OpenMVS use it; we use Poisson instead.                                                                                   |
| SuiteSparse CHOLMOD (any module), SPQR, CSparse, CXSparse                                                                   | LGPL-2.1+ and GPL-2.0+                                                                  | Ceres and COLMAP built without them.                                                                                                                   |
| LSD in COLMAP                                                                                                               | AGPL-3.0+                                                                               | `LSD_ENABLED=OFF`.                                                                                                                                     |
| SiftGPU in COLMAP                                                                                                           | Non-commercial (UNC)                                                                    | Never compiled: `OPENGL_ENABLED=OFF` and `CUDA_ENABLED=OFF` in the standard build; a CUDA build (decision 5) needs a patch that keeps SiftGPU out.     |
| SuperPoint weights (and LightGlue trained on them)                                                                          | Non-commercial weights                                                                  | No learned features in M10 (`ONNX_ENABLED=OFF`); SIFT only.                                                                                            |
| pymeshlab, plyfile                                                                                                          | GPL-3.0                                                                                 | trimesh, laspy and our own PLY reader instead.                                                                                                         |
| untwine                                                                                                                     | GPL-3.0                                                                                 | Already excluded (tech evaluation); PDAL `writers.copc`.                                                                                               |
| sharp / libvips (through 3d-tiles-tools)                                                                                    | LGPL-3.0                                                                                | Dev tooling only.                                                                                                                                      |
| ODM's helper tools: odm_orthophoto, FastRasterFilter, Obj2Tiles, RenderDEM, OpenPointClass; dem2mesh, dem2points, FPCFilter | AGPL-3.0; GPL-3.0                                                                       | Orthophoto, DEM and tiling are our own code on GDAL and PDAL.                                                                                          |
| PyPI `opencv-python` and `opencv-python-headless` wheels                                                                    | Apache-2.0 code, but bundled FFmpeg (LGPL plugin on Windows; GPL codecs on macOS arm64) | Own OpenCV build without FFmpeg.                                                                                                                       |
| fpdf2 (an OpenSfM dependency)                                                                                               | LGPL-3.0                                                                                | Our reports use the existing report machinery.                                                                                                         |
| gotiler (formerly gocesiumtiler), Entwine; PotreeConverter's vendored LASzip                                                | AGPL-3.0 (v3) or MPL-2.0 (v2); LGPL-2.1; LGPL-2.1                                       | Our own COPC-to-3D-Tiles writer (G7); PDAL `writers.copc` for COPC.                                                                                    |
| DUSt3R, MASt3R, VGGT; SuperPoint and SuperGlue weights                                                                      | CC-BY-NC-SA-4.0 or custom; non-commercial                                               | No learned reconstruction or features in M10. Permissive learned features exist for later (LightGlue Apache-2.0 with ALIKED BSD-3 or DISK Apache-2.0). |

## Photogrammetry: options and recommendation

### What each candidate is

| Criterion                         | ODM (bundled)                                                                                                              | ODM via "your own ODM" adapter (decision 2)                                                                                                                                        | OPF only                        | Own pipeline on OpenSfM (BSD-2)                                                                   | **Own pipeline on COLMAP (BSD-3), recommended**                                                                                          |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Licence fit                       | Fails (AGPL-3.0)                                                                                                           | Fits if we never ship, embed or modify ODM                                                                                                                                         | Fits (CC-BY spec, Apache pyopf) | Fits; same Ceres and SuiteSparse care                                                             | Fits with our own build (traps listed above)                                                                                             |
| Processes photos                  | Yes                                                                                                                        | Yes, on the user's install                                                                                                                                                         | No (format only)                | Yes                                                                                               | Yes                                                                                                                                      |
| Maintenance (Oct 2026)            | Active, new maintainers after the April 2026 split ([forum](https://community.opendronemap.org/t/ecosystem-changes/26064)) | Same; two API families (NodeODM and NodeODX)                                                                                                                                       | Pix4D maintains the spec        | Steady commits (5 Oct 2026) but no tagged release since 2020; ODM keeps a fork                    | Very active: 4.0 to 4.2.1 in 2026, global mapper (GLOMAP) merged                                                                         |
| Windows x64 and macOS arm64 build | n/a                                                                                                                        | User's problem (Docker Desktop is paid for organisations over 250 people or USD 10 M revenue, and for government ([terms](https://docs.docker.com/subscription/desktop-license/))) | n/a                             | Hard: not on PyPI, no upstream Windows CI; ODM's fork builds on both through conda-forge and pixi | vcpkg manifest and official wheel build scripts for both targets; we re-run them with an overlay                                         |
| CPU-only                          | Yes                                                                                                                        | Yes                                                                                                                                                                                | n/a                             | Yes, including CPU dense depth maps (640 px by default: coarse, fine for a preview DSM)           | SfM, fusion and Poisson yes; PatchMatch dense needs CUDA (or HIP on Linux since 4.2), so the CPU dense step is chosen separately (below) |
| Drone and GNSS awareness          | Excellent                                                                                                                  | Excellent                                                                                                                                                                          | Describes it                    | Good (GPS priors, GCP file)                                                                       | Pose priors and GPS-aware matching; GCP handling is ours (a few hundred lines on top of pycolmap's bundle adjustment)                    |
| Fits our jobs system              | n/a                                                                                                                        | As one opaque stage with coarse progress                                                                                                                                           | n/a                             | Python API and CLI                                                                                | Python API (pycolmap) inside our job steps: progress, cancel and resume per stage                                                        |

### Recommendation

**Build our own pipeline in the pipeline pack on COLMAP (via our own pycolmap build), with GDAL, PDAL and our own code for the drone-specific parts; read and write OPF with pyopf; offer "use your own ODM" only as an optional, unbundled adapter (decision 2, recommended: later, not in M10).**

Why COLMAP over OpenSfM: it is the most active permissive SfM project (monthly releases), its global mapper (GLOMAP, merged in 4.0 and claimed one to two orders of magnitude faster than incremental SfM) suits large drone grids, it has a supported Python API and official build scripts for exactly our two targets, and its fusion and Poisson meshing run on CPU. The price is a small patch (CHOLMOD) and a disciplined build. OpenSfM needs no patch and has drone-specific GPS and GCP handling built in, but it has no release since 2020, no upstream Windows build, and three dependencies to strip (fpdf2, `opencv-python`, the OpenMVS header); its CPU dense step is coarse. Both are reasonable: G2's first week is a spike that runs both on the synthetic set and one founder flight, and if OpenSfM wins clearly on drone data the stage interfaces below do not change.

Whichever SfM engine wins, ODM shows what a permissive drone pipeline looks like: its forks of OpenSfM, MVE, mvs-texturing and PoissonRecon are BSD or MIT, while its orthophoto, DEM and tiling tools and OpenMVS are GPL or AGPL. We reuse the permissive parts' ideas and build references, and write the orthophoto and DEM steps ourselves on GDAL and PDAL.

### The pipeline

```
photos (folder or photos layer)  [+ GCP file, + RTK flags]
  |
  | photo.align (G2)
  |   inspect   EXIF and DJI XMP: GPS, altitudes, gimbal, RTK flag and accuracy, camera model; reject or warn
  |   features  SIFT on CPU (VLFeat), image size by quality preset
  |   match     GPS-neighbour pairs (radius from altitude and footprint), plus sequential and retrieval for gaps
  |   sfm       global mapper (default) or incremental; self-calibration (OPENCV or full radial-tangential)
  |   georef    GNSS priors in bundle adjustment (RTK weighted by reported accuracy), into the project CRS
  |   report    registered images, reprojection error, camera residuals to GNSS, overlap map
  v
person marks GCPs (G4), predicted positions shown, targets detected as drafts
  |
  | photo.georef (G2): bundle adjustment with control points; checkpoints held out; accuracy report
  v
  | photo.products (G3)
  |   dense     depth maps: CPU (MVE dmrecon or SGM, chosen by G3's spike) or CUDA PatchMatch (decision 5)
  |   fuse      COLMAP stereo fusion (CPU) -> cloud with normals and colours
  |   cloud     PDAL: COPC in the project CRS, ground classified (filters.smrf)
  |   dsm, dtm  PDAL gridding at the chosen GSD -> COG, plus a coloured hillshade kit-pyramid layer
  |   ortho     per-pixel orthorectification on the DSM, nadir-first selection, seam feathering,
  |             gain compensation -> COG and kit-pyramid ortho layer
  |   mesh      Screened Poisson (CPU) or 2.5D mesh from the DSM; trimmed by density; textured
  |             (texrecon or our own); decimated GLB for the site view
  |   tiles     full-resolution mesh and cloud as 3D Tiles (G7) for the site view and the Globe
  |   commit    layers, tilesets.json, run.json, quality report
  v
existing viewers: 3D (mesh, COPC), map and ortho (kit-pyramid), surfaces (DSM), Globe (3D Tiles)
```

**Quality presets** (one menu, explained in plain words in the wizard):

| Preset   | For                                                         | Images             | Dense                                                    | Typical time, 500 photos of 20 MP (8-core CPU, 32 GB)     |
| -------- | ----------------------------------------------------------- | ------------------ | -------------------------------------------------------- | --------------------------------------------------------- |
| Fast     | A quick orthomosaic and DSM on a laptop, flat sites         | Quarter resolution | None: 2.5D surface from the sparse points ("fast ortho") | About 30 to 60 min                                        |
| Standard | Ortho, DSM, cloud and mesh for most surveys and inspections | Half resolution    | CPU depth maps at half resolution                        | About 3 to 6 h                                            |
| High     | Close-range inspection, fine detail                         | Full resolution    | CUDA PatchMatch when available (decision 5), else CPU    | About 2 to 4 h with an RTX-class GPU; 10 h or more on CPU |

The times are planning estimates to be replaced by G3's measurements on the synthetic set and the founder flight. The wizard shows a per-machine estimate and the disk needed before it starts.

### CPU dense matching

COLMAP's PatchMatch stereo is CUDA-only, and CI and most of our customers' laptops have no NVIDIA GPU. Options for the CPU path, decided by a G3 spike in week 1 on the synthetic set (known surfaces) and the founder flight:

1. **MVE `dmrecon`** (BSD-3): pure CPU multi-view stereo with OpenMP, the established permissive option (ODM used MVE before OpenMVS). Good quality, slow (hours for a few hundred images at half or quarter scale). Its depth maps are converted for COLMAP's fusion, or fused with MVE's `scene2pset`.
2. **Semi-global matching on rectified neighbour pairs:** OpenCV `StereoSGBM` (Apache-2.0) on pairs chosen by baseline and view angle, depth maps in COLMAP's format, then COLMAP's CPU fusion with geometric consistency. Likely faster than `dmrecon` on nadir grids, weaker on oblique close-range data; our own code to maintain.
3. **OpenSfM's CPU depth maps** (BSD-2): 640 px by default, seconds per image, coarse; a candidate for a preview.
4. **2.5D only ("Fast")**: no dense step; the DSM is interpolated from sparse points and the ortho is draped on it, as ODM's fast-orthophoto does. Good for flat sites, weak for buildings and tanks.

Starting assumption: `dmrecon` for Standard and High on CPU, SGM if the spike shows it matches `dmrecon` on nadir data at a fraction of the time, and option 4 for Fast. Other permissive dense methods found (ACMM, ACMMP, ACMH, MIT; PatchmatchNet, MIT) are CUDA or PyTorch GPU methods.

**G3 spike result (7 Oct 2026): SGM, option 2.** Measured on G3's own synthetic nadir scene (known poses, known surface; G8's set was not ready), depth maps against the true depth, two partners per photo, the same rectification and back-projection for both matchers:

| Matcher                                | Photos     | Matching time per pair | Within 3 x GSD of truth | Filled | Median error     |
| -------------------------------------- | ---------- | ---------------------- | ----------------------- | ------ | ---------------- |
| Our census SGM, numpy (8 paths)        | 480 x 360  | about 1 s              | 99.6%                   | 91%    | 5 cm (GSD 9)     |
| OpenCV `StereoSGBM` 3-way (spike venv) | 480 x 360  | under 0.1 s            | 98.2%                   | 88%    | 5 cm             |
| Our census SGM, numpy                  | 1280 x 960 | 17 s (1.9 GB peak)     | 99.4%                   | 93%    | 1.8 cm (GSD 3.4) |
| OpenCV `StereoSGBM` 3-way              | 1280 x 960 | 0.06 s                 | 99.1%                   | 87%    | 1.5 cm           |

- `dmrecon` was not measured: there is no MVE build yet (G1), and G3 could not fetch and build MVE in its worktree. It was not needed to decide: SGM already meets the dense-cloud target with a wide margin on nadir data, needs no native build beyond the OpenCV G1 builds anyway, and is our own code to maintain; MVE is in maintenance only. `dense.py` keeps the matcher behind an interface, so `dmrecon` can be added if the founder's oblique flight shows SGM is weak there (the plan's risk).
- **Production needs the pack's own OpenCV build (G1):** at Standard (20 MP photos matched at 5 MP) OpenCV takes about a second per pair, so 500 photos match in roughly 15 to 30 minutes on 8 cores; the numpy matcher is two orders of magnitude slower and is the fallback for CI and small runs (the report and `run.json` warn when it ran).
- End to end on the same scene (High, 16 photos, CPU, numpy matcher, about a minute): dense cloud 99% within 3 x GSD, DSM RMSE 3 cm (target under 27 cm), stockpile volume +1.2% (target 2%), ortho targets within 7 cm (target 18 cm), mesh 95th percentile 6 cm (target 36 cm). Meshing: PoissonRecon (MIT) and FSSR were not compared (no binaries yet); nadir runs without PoissonRecon use the 2.5D mesh, others a built-in FFT Poisson on a coarse grid.

### Meshing and texturing

- **Screened Poisson** through COLMAP's vendored PoissonRecon (MIT), on the fused cloud with normals; trimmed by point density; then `fast-simplification` (MIT) to a site-view GLB within the engine's budget (2 M triangles by default) with Meshopt compression as today's GLBs.
- **2.5D mesh from the DSM** for nadir surveys (fast, robust, no overhangs).
- **Texturing:** `texrecon` from mvs-texturing (BSD-3; its dependency tree was checked clean on 7 Oct 2026, with mapMAP instead of the research-only gco; G1 re-checks the built binary). If it cannot be built or fails on a platform, our own texturing: per-face best view by angle and distance, seam levelling by per-image gain, an atlas from xatlas (MIT), written with Pillow. MVE's FSSR (BSD-3) is the alternative mesher G3's spike compares with Poisson.
- The full-resolution textured mesh becomes a 3D Tiles tileset (G7), so large photogrammetry meshes stream in the site view instead of loading whole.

### Orthomosaic and surfaces

- **DSM** from the COPC by PDAL `writers.gdal` (max or IDW per cell, holes filled within a radius), at the chosen GSD, as a COG. **DTM** from `filters.smrf` ground points.
- **Ortho:** each output tile projects into candidate photos through the refined cameras and lens model; per pixel the most nadir, closest, sharpest photo wins; seams are feathered; per-photo gain and white balance are equalised. Written as a COG (rasterio, windowed, bounded memory) and as a `kit-pyramid` layer for the viewers.
- Volumes, change detection (`change.raster`, `change.surface`) and the volumetric pipeline already read DSMs and orthos, so processed surveys feed M8 directly.

### Ground control points, checkpoints and accuracy

- **GCP files in:** CSV or TXT (`id, x, y, z` or `id, lat, lon, h`), with an EPSG code (the person picks it from a searchable list; PROJ resolves it). Pix4D and ODM `gcp_list.txt` formats are read. Each point is **control** or **check**; checkpoints never enter the adjustment.
- **Marking (G4):** after `photo.align`, the app predicts each GCP's position in every photo that sees it. The person confirms or moves marks in at least three photos per point (loupe, keyboard). A detector proposes marks on square checker and cross targets near the prediction (OpenCV corner refinement) as drafts.
- **Adjustment (G2):** bundle adjustment with GCP observations as fixed 3D points (weighted by their stated accuracy) and GNSS priors weighted by RTK accuracy; outliers named.
- **Accuracy report** (`aio.photo-accuracy/1`, in the app, as a PDF export and as a house-report section): per control and check point dx, dy, dz and reprojection error; RMSE horizontal and vertical per role; mean reprojection error; registered images; camera position residuals to GNSS; GSD; overlap map (images per point); warnings ("GCP 4 is 0.4 m off; check its coordinates or marks").
- **Geotags:** EXIF GPS, DJI XMP `AbsoluteAltitude`, `RelativeAltitude`, gimbal angles, `RtkFlag`, `RtkStdLon/Lat/Hgt` (as written by DJI RTK aircraft), reusing `aik/cameras.py`'s reader. RTK fixed (`RtkFlag` 50) gets centimetre priors, float or none gets metre priors; PPK-corrected positions come in as a CSV (`image, lat, lon, h, σh, σv`) replacing the EXIF ones.
- **CRS:** the project CRS (manifest `crs`) by default; a UTM zone from the photos for new projects. Heights follow the manifest `verticalDatum`; ellipsoidal to orthometric conversions use PROJ with EGM96 or EGM2008 grids, named in `run.json`.

### OPF

- **Import** (`opf.import`, pyopf): an OPF project (Pix4Dmatic, Pix4Dmapper exports, or any OPF writer) becomes a photos layer with calibrated cameras (`cameras.json` with the OPF intrinsics and poses), control points, and its outputs as layers when present: point clouds (OPF glTF point clouds to COPC through PDAL), orthos and DSMs (GeoTIFF to COG and kit-pyramid), meshes (OBJ or glTF to GLB). Refuses absolute paths, `..` and files outside the OPF folder.
- **Export** (`opf.export`): a processed run as OPF 1.x: input cameras, calibrated cameras, GCPs and marks, CRS, the sparse cloud, and references to our outputs, so a customer can open our processing in Pix4D or another OPF reader.
- **ODM through OPF:** ODM has no OPF export ([config.py](https://github.com/OpenDroneMap/ODM/blob/master/opendm/config.py) has no such option). If decision 2 adds the adapter, it reads ODM's own outputs (OpenSfM `reconstruction.json`, COG, COPC or EPT, glTF) directly.

### The optional "use your own ODM" adapter (decision 2)

- **What it is:** the M8 "your own Ollama" pattern. The person installs ODM natively, or NodeODM or NodeODX in Docker, themselves. Stratlas calls it over HTTP on loopback (NodeODM's REST API, through PyODM, BSD-3-Clause) or as a command line, then imports the outputs as layers.
- **AGPL position:** AGPL-3.0 section 13 binds whoever **modifies** the program and offers it over a network. Calling an unmodified ODM at arm's length (HTTP, command line, files) creates no obligation for Synapse ([GPL FAQ on pipes, sockets and command-line arguments](https://www.gnu.org/licenses/gpl-faq.html#MereAggregation)). We must never ship ODM, its Docker image or a patched copy, never link it, and never embed its code. The guide says plainly that ODM is AGPL software the customer installs under its own licence.
- **Costs:** two API families since the 2026 split, Docker Desktop fees for larger organisations and governments, support questions about software we do not control, and a second set of outputs to validate.
- **Recommendation:** not in M10. Our own pipeline covers the need; revisit after founder testing if a customer already runs ODM.

### Hardware

| Item      | Minimum (Fast and Standard presets, up to about 300 photos)                                     | Recommended (Standard and High, up to about 2,000 photos)                          |
| --------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| CPU       | 8 cores, x64 with AVX2, or Apple M1                                                             | 16 cores or more, or Apple M2 Pro and later                                        |
| Memory    | 16 GB                                                                                           | 64 GB                                                                              |
| GPU       | Not required                                                                                    | NVIDIA RTX with 8 GB VRAM for the CUDA dense path (decision 5); not used otherwise |
| Free disk | 100 GB on an SSD per 500 photos (intermediates are about 10 to 20 times the photos at Standard) | 1 TB NVMe                                                                          |
| OS        | Windows 10 22H2 or 11 x64; macOS 14 on Apple silicon                                            | Same                                                                               |

- **Laptop limits:** on 16 GB, Standard caps image size at half resolution and dense matching at clusters of about 40 images; the job checks memory before each stage (the pack's RAM admission, as PotreeConverter imports do) and lowers resolution with a notice instead of swapping. Thermal throttling makes estimates optimistic: the estimate shows a range.
- **macOS on Intel:** today the release workflow also builds a `darwin-x64` pack. Recommended: photogrammetry is not offered on Intel Macs (the pack for them keeps the other pipelines); decision 8.
- **Processing runs as pipeline jobs:** `photo.align`, `photo.georef` and `photo.products` are ordinary jobs in the Jobs panel, resumable per step (`steps/NN-<step>.json` manifests), cancellable, with progress per stage and per image, and refusing a resume when the photos changed (the runtime's input fingerprint).

### Quality targets (asserted in CI on the synthetic set, G8)

| Measure                                        | Target                                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Images registered                              | At least 98% (the deliberately bad images are rejected with a reason)                                        |
| Mean reprojection error                        | Under 1.0 px                                                                                                 |
| Camera positions after GCP adjustment          | RMSE under 2 x GSD against truth; rotations under 0.1 degrees                                                |
| Checkpoints, 5 GCPs and 4 checkpoints          | RMSE horizontal under 1.5 x GSD, vertical under 2.5 x GSD (marks with 0.5 px noise)                          |
| GNSS only, standard (2 to 3 m noise)           | Relative scale within 1%; absolute error reported, not hidden                                                |
| GNSS only, RTK (2 cm noise)                    | Checkpoint RMSE under 3 x GSD with no GCPs                                                                   |
| Dense cloud                                    | 95% of points within 3 x GSD of the true surface; completeness over 90% of textured area                     |
| DSM                                            | RMSE under 3 x GSD against the true height grid, building edges buffered by 2 cells                          |
| Ortho                                          | Checkpoints in the ortho within 2 x GSD horizontally                                                         |
| Mesh                                           | 95th percentile distance to the true surface under 4 x GSD                                                   |
| Volume of the synthetic stockpile from the DSM | Within 2% of truth                                                                                           |
| CI runtime                                     | The quick synthetic set (about 60 images at 1600 x 1200) end to end in under 15 min on a CI runner, CPU only |

The founder's real flight is the second gate: checkpoint RMSE and a volume against the delivered Pix4D or DJI Terra results of the same flight, where they exist.

## Cesium: options and recommendation

The app already has a three.js r186 site view with annotation, measuring, picking, video projection, change colouring and the agent's camera tools, and MapLibre for 2D. The 2026 tech evaluation chose three.js as the single renderer because CesiumJS would mean "two engines, heavy, globe-first" and rewriting our projection shaders (`docs/architecture/tech-evaluation.md` section 2).

| Criterion                                                      | (a) CesiumJS as a new Globe view                                                                                                                                                                                                                                                  | (b) Cesium's open standards in our three.js engine (3DTilesRendererJS)                                                                                                | **(c) Both, with a clear split (recommended)**                                     |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Meets "integrate Cesium" by name                               | Yes                                                                                                                                                                                                                                                                               | Partly: Cesium's standards (3D Tiles, quantized-mesh) and NASA's Apache library, not CesiumJS                                                                         | Yes                                                                                |
| World and region overview                                      | Excellent: globe, atmosphere, lighting, terrain, imagery layers, smooth fly-to                                                                                                                                                                                                    | Possible (`GlobeControls`, ellipsoid tiles, imagery, Terrarium and quantized-mesh plugins, an atmosphere from takram's three-geospatial, MIT), less mature as a globe | CesiumJS                                                                           |
| Existing tools (annotate, measure, pick, video, change, agent) | None; each would be rebuilt on Cesium's scene graph                                                                                                                                                                                                                               | All keep working                                                                                                                                                      | All keep working in the site view; the Globe has navigation and links only         |
| Large photogrammetry meshes and clouds                         | 3D Tiles native                                                                                                                                                                                                                                                                   | 3D Tiles through 3DTilesRendererJS                                                                                                                                    | Both, from one tileset per output                                                  |
| Duplicated code                                                | High if tools are added                                                                                                                                                                                                                                                           | None                                                                                                                                                                  | Low: shared data layer (packs, tilesets, CRS); one-way hand-off from Globe to site |
| Bundle and memory                                              | About 13 to 15 MB on disk (measured from the 1.146.0 package: minified `Cesium.js` 6.1 MB, 1.8 MB gzipped; Workers 1 to 2.5 MB; Assets 4.4 MB; ThirdParty 1.1 MB; wasm 0.9 MB), and a second scene graph and WebGL context; tileset cache defaults to 512 MiB and must be lowered | About 0.5 MB                                                                                                                                                          | Both, with CesiumJS lazily loaded so startup is unchanged                          |
| Combining the two in one canvas                                | No maintained CesiumJS and three.js integration exists; Cesium's own approach overlays two canvases with no shared depth ([blog](https://cesium.com/blog/2017/10/23/integrating-cesium-with-threejs/)), and shared-context attempts report broken occlusion                       | n/a                                                                                                                                                                   | Not attempted: the Globe and the site view are separate views                      |
| Risk                                                           | Two engines to keep current; CSP and offline configuration                                                                                                                                                                                                                        | Pre-1.0 library API churn (0.5.x)                                                                                                                                     | Both, contained by the split                                                       |

**Recommendation: (c).** The Globe (CesiumJS) is the place to see the world: every project in the library on the Earth, satellite imagery and terrain from offline packs, each site's ortho, mesh and cloud as 3D Tiles, survey footprints and issues as pins, and a fly-in. **Open site here** hands over to the site view at the same camera. Nothing is edited or measured in the Globe; a geodesic distance and area read-out is the only measuring tool, computed by Cesium's ellipsoid functions and labelled "on the ellipsoid". The site view (three.js) gains 3D Tiles (large photogrammetry meshes, and 3D Tiles from other software) and terrain and imagery around the site through 3DTilesRendererJS, so every tool works on them.

Honest trade-off for decision 3: (b) alone would deliver most of the value (offline imagery and terrain, 3D Tiles, big meshes) at a fraction of the cost and with one engine, but it is not "Cesium" as the founder named it, and its globe is less polished. (a) alone gives a beautiful globe whose content cannot be annotated or measured, which would push us to duplicate tools in a second engine. (c) gives the founder the Cesium globe and keeps a single place for every tool.

**CesiumJS in Electron, offline:**

Following Cesium's own [offline guide](https://github.com/CesiumGS/cesium/blob/main/Documentation/OfflineGuide/README.md), checked against the source:

- `@cesium/engine` and `@cesium/core` only, with a bare `CesiumWidget` (no `Viewer`, no `@cesium/widgets`, so no Knockout and no `'unsafe-eval'`); our own React chrome.
- **Pass `baseLayer` explicitly.** The default base layer is `ImageryLayer.fromWorldImagery()` (ion and Bing: `api.cesium.com`, `*.virtualearth.net`), created at construction time. We pass Natural Earth II from the bundled assets, or `false`.
- `Ion.defaultAccessToken` is never used (the source embeds a default token; nothing of ours may reach `Ion.defaultServer`). The default terrain (`EllipsoidTerrainProvider`) makes no calls; ours replaces it. No `Geocoder` (its default is the ion geocoder), `BaseLayerPicker`, `IonImageryProvider`, `createWorldTerrainAsync`, `createOsmBuildingsAsync`, `Cesium3DTileset.fromIonAssetId`, `ITwinData` or Google providers in the bundle: a lint rule bans the imports, and the zero-network e2e test proves it at runtime (no telemetry was found in the source, but only the runtime test counts).
- `CESIUM_BASE_URL` points at the app's own copy of `Workers/`, `Assets/` and `ThirdParty/`, served from the same origin as the renderer. CesiumJS workers are ES module workers loaded by URL; same-origin needs only `worker-src 'self'` (already in the CSP), and a cross-origin base URL would make Cesium create a `blob:` shim (also allowed today). Module workers and XHR over our custom scheme in Electron 44 are the first thing the G6 spike proves.
- CSP: the app's CSP already has `'wasm-unsafe-eval'` (Draco, Basis and splat decoders) and `img-src ... data: blob:`. Any need for `'unsafe-eval'` is a blocker the spike must rule out on day one; we never weaken the CSP for it.
- The credit display shows our pack attributions; the bundled Cesium credit logo is local and its link opens only through our external-link handler.
- Imagery from packs: CesiumJS has no PMTiles support, so a small `PmtilesImageryProvider` (renderer, the existing `pmtiles` library) reads raster PMTiles.
- Terrain from packs: CesiumJS reads quantized-mesh and heightmap-1.0 through `layer.json`, and has no Terrarium support ([issue 13035](https://github.com/CesiumGS/cesium/issues/13035)). We decode Terrarium tiles in a `CustomHeightmapTerrainProvider`; if its tiling or performance falls short, G7 writes quantized-mesh tiles (own encoder, or quantized-mesh-encoder, MIT) into the same PMTiles container.
- GPU: WebGL 2 (CesiumJS's default since 1.102; billboards and labels need it since 1.140; there is no WebGPU renderer). The Globe is offered on the Medium and High graphics tiers; on Low it opens with terrain off and a higher screen-space error.
- Memory: the Globe tears down its context when the person leaves it, so the site view and the Globe never hold both GPU budgets at once (except in a split, which M10 does not offer for the Globe).

## Imagery and terrain: sources and licences

Cesium shows what we give it. Every pack we build or offer must pass the data licence gate (G1). Research of 7 Oct 2026 (not legal advice; counsel confirms the Copernicus and ODbL wording before packs ship):

| Source                                                                                                                                                                                       | Licence                                                                                    | In a pack we distribute?                                                                                                                                                                                           | Attribution                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Natural Earth](https://www.naturalearthdata.com/about/terms-of-use/) (raster and vector)                                                                                                    | Public domain                                                                              | Yes                                                                                                                                                                                                                | Not required; we credit anyway                                                                                                                                                          |
| NASA Blue Marble NG and Black Marble ([NASA media guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/))                                                                     | Not copyrighted in the United States                                                       | Yes                                                                                                                                                                                                                | "NASA Earth Observatory"; never imply NASA endorsement                                                                                                                                  |
| [Landsat](https://www.usgs.gov/faqs/are-there-any-restrictions-use-or-redistribution-landsat-data) (USGS)                                                                                    | Public domain                                                                              | Yes                                                                                                                                                                                                                | Requested: "Landsat imagery courtesy of the U.S. Geological Survey"                                                                                                                     |
| [EOX Sentinel-2 cloudless 2016](https://cloudless.eox.at/license-non-commercial)                                                                                                             | CC-BY-4.0                                                                                  | Yes                                                                                                                                                                                                                | "EOxCloudless 2016 by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2016)"                                                                                           |
| [EOX Sentinel-2 cloudless 2018 to 2025](https://cloudless.eox.at/documentation/license)                                                                                                      | CC-BY-NC-SA-4.0                                                                            | **No.** Paid software is commercial use; EOX sells a commercial licence by quote                                                                                                                                   | n/a                                                                                                                                                                                     |
| [Copernicus Sentinel-2 Global Mosaics](https://stac.dataspace.copernicus.eu/v1/collections/sentinel-2-global-mosaics) (quarterly, 10 m, 2020 on)                                             | Sentinel data legal notice: free, full and open, commercial use and redistribution allowed | Yes                                                                                                                                                                                                                | "Contains modified Copernicus Sentinel data [year]"                                                                                                                                     |
| [ESA WorldCover S2 RGBNIR composites 2020 and 2021](https://esa-worldcover.org/en/data-access)                                                                                               | CC-BY-4.0                                                                                  | Yes                                                                                                                                                                                                                | "© ESA WorldCover project [year] / Contains modified Copernicus Sentinel data ([year]) processed by ESA WorldCover consortium"                                                          |
| [Copernicus DEM GLO-30 and GLO-90](https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM) (release 2023_1 or later) | Copernicus WorldDEM-30 licence: free, worldwide, redistribution and adaptation allowed     | Yes, passing its obligations to customers and its no-liability sentence into our EULA                                                                                                                              | "produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved" |
| [NASADEM and SRTM](https://www.earthdata.nasa.gov/learn/use-data/data-use-policy)                                                                                                            | Open (CC0 policy for NASA-led missions)                                                    | Yes                                                                                                                                                                                                                | Citation urged                                                                                                                                                                          |
| [GEBCO](https://www.gebco.net/data-products/gridded-bathymetry/terms-of-use) bathymetry                                                                                                      | Public domain, acknowledgement required                                                    | Yes (only if a coastal customer needs it)                                                                                                                                                                          | "GEBCO Compilation Group (year) GEBCO year Grid"; not for navigation                                                                                                                    |
| [OpenStreetMap](https://osmfoundation.org/wiki/Licence/Licence_and_Legal_FAQ) (today's street packs)                                                                                         | ODbL-1.0                                                                                   | Yes, as today; vector tiles are a database under ODbL, rendered images are Produced Works                                                                                                                          | "© OpenStreetMap contributors"                                                                                                                                                          |
| Cesium ion, Cesium World Terrain, Bing via ion ([ion terms](https://cesium.com/legal/terms-of-service/), [Bing terms](https://cesium.com/legal/terms-for-bing/))                             | Commercial SaaS                                                                            | **No.** The ion terms forbid storing output in "an offline, disconnected, or local computer environment"; Bing forbids storing or archiving content. Cesium ion Self-Hosted and offline datasets are sold by quote | n/a                                                                                                                                                                                     |
| Google Photorealistic 3D Tiles ([policies](https://developers.google.com/maps/documentation/tile/policies))                                                                                  | Commercial SaaS                                                                            | **No** (no pre-fetching, caching or offline use)                                                                                                                                                                   | n/a                                                                                                                                                                                     |
| Esri World Imagery, Mapbox Satellite, MapTiler satellite                                                                                                                                     | Commercial                                                                                 | **No** for bundling; MapTiler sells on-premises licences for single applications by quote                                                                                                                          | n/a                                                                                                                                                                                     |
| Commercial high resolution: Vantor (formerly Maxar Intelligence, renamed 1 Oct 2025), Airbus Pléiades and Pléiades Neo, Planet                                                               | Per-km² end-user licences, internal use; redistribution needs an upgrade                   | **No**: bought by the customer under its own licence and loaded into Stratlas                                                                                                                                      | Per the provider's EULA (entered by the person on import)                                                                                                                               |

Indicative prices (2025 to 2026, reseller figures, unverified list prices): archive 30 cm about USD 20 to 45 per km², 50 cm about USD 10 to 20, new 30 cm tasking USD 60 or more, with minimum orders of about 25 km² (platforms such as UP42 and SkyWatch accept smaller areas with a minimum bill).

**What we ship and offer (decision 4):**

1. **In the installer:** CesiumJS's bundled Natural Earth II low-zoom imagery (public domain) so the Globe works on first start, and a small world terrain at about 1 km (from GLO-90 or NASADEM) if it fits the installer budget.
2. **World imagery pack** (download or USB, about 0.5 to 2 GB): Sentinel-2 Global Mosaic or ESA WorldCover 2021 composite to zoom 9 to 10 (about 150 m to 75 m per pixel), colour-graded by us; Blue Marble below zoom 6.
3. **Region packs** (GCC, Kuwait): 10 m Sentinel-2 mosaic to zoom 13 to 14 (about 10 m per pixel), plus Copernicus GLO-30 terrain. Sizes are estimated by G7's tooling before we commit to offering them (the GCC at zoom 13 is roughly 300,000 tiles).
4. **Customer imagery:** **Import imagery** takes the customer's GeoTIFF or COG (a Vantor, Airbus or Planet purchase, a client's own aerial survey, or our own orthomosaics) and builds a local imagery pack. The person states the licence and attribution on import; the pack is marked "customer licence, not for redistribution" and is never included in a `.aio` package unless the person ticks it.
5. **Project orthos on the Globe** use the project's own `kit-pyramid` tiles directly (no pack).

**Pack formats** (shared by MapLibre, the site view and the Globe):

- **Imagery packs:** raster PMTiles (WebP, 256 or 512 px, Web Mercator), in `packs/imagery/<id>.pmtiles` with `<id>.json` metadata (`RasterPackMeta`, `aio.raster-pack/1`: `kind`, `licence`, `attribution`, `provenance`, `customerLicence`; data-conventions section 23).
- **Terrain packs:** Terrarium-encoded lossless WebP or PNG tiles in PMTiles (`packs/terrain/`), heights in metres with the vertical datum named in metadata (EGM2008 for Copernicus). The precedent is [Mapterhorn](https://mapterhorn.com/data-access/), which ships Terrarium WebP tiles in PMTiles. One archive serves all three renderers: MapLibre reads it as `raster-dem` (`encoding: 'terrarium'`) for hillshade and 3D terrain; 3DTilesRendererJS has a `TerrariumMeshPlugin` for the site view; the Globe decodes it in a custom heightmap provider and adds the geoid separation to give ellipsoidal heights. G7's spike confirms the Cesium path on Web Mercator tiles; the fallback is quantized-mesh tiles in the same PMTiles container.
- **Tilesets:** standard 3D Tiles 1.1 (glTF content, implicit or explicit tiling) in `<project>/tiles/<id>/`, listed in `<project>/tilesets.json`.

## Founder decisions needed before M10 starts

Each has a recommendation; "decision N" in this plan refers to this list. Decisions 1 to 3 block G0; the others have defaults that G0 carries as fields or settings.

1. **Licence policy.** Recommended: "permissive only" as defined in "Licence policy and inventory": Apache-2.0, MIT, BSD, ISC and similar, public-domain and CC-BY data with attribution; never GPL, AGPL, SSPL, non-commercial or LGPL-static; LGPL only as the shared GEOS library that already ships; MPL-2.0 only by name with approval: Eigen headers (unavoidable: every candidate pipeline needs them), and certifi, which the pack already ships; DOMPurify inside CesiumJS is taken under its Apache-2.0 option. Add Zlib (pako in CesiumJS, mapMAP's `dset`) and BSL-1.0 (Boost) to the allow-lists. The alternative, Apache-only, would remove GDAL, PDAL, Eigen and most of the existing pack, which makes photogrammetry impossible.
2. **"Use your own ODM" adapter.** Recommended: not in M10; revisit after founder testing. If wanted: optional, never bundled, loopback or command line only, guide states that ODM is AGPL software the customer installs and that Docker Desktop is paid for larger organisations and governments.
3. **Cesium architecture.** Recommended: (c), CesiumJS Globe for overview and navigation only, plus 3D Tiles and terrain in the three.js site view through 3DTilesRendererJS; no editing or measuring tools in the Globe beyond a geodesic read-out.
4. **Imagery and terrain sources.** Recommended: ship Natural Earth II in the app; offer a world pack and GCC and Kuwait region packs built from Copernicus Sentinel-2 Global Mosaics or ESA WorldCover 2021 composites, with Copernicus GLO-30 terrain; no EOX cloudless 2018 to 2025 without an EOX commercial licence; no ion, Bing, Google, Esri or Mapbox. Commercial high resolution (Vantor, Airbus, Planet) is bought by the customer and imported, never resold by us, unless the founder wants a reseller agreement (a business decision outside M10). Confirm that the Copernicus DEM no-liability sentence goes into our EULA.
5. **GPU requirement.** Recommended: no GPU required. The CPU path is the product. A CUDA build of COLMAP for the High preset is an optional "GPU accelerator" download for Windows with NVIDIA, built only after a patch keeps SiftGPU out and the founder accepts the NVIDIA CUDA runtime's redistribution terms (proprietary, freely redistributable, not open source). Defer the CUDA build to M10.1 unless G3 shows the CPU High preset is unusable.
6. **Pack and installer size.** Recommended: pipeline pack 0.4.0 at most 1.1 GB unpacked and 450 MB compressed per platform (0.2.0 is about 520 MB unpacked); installer growth for CesiumJS and 3DTilesRendererJS at most 15 MB over the 0.9.0 installer (the M9 budget allowed 5 MB, so this is a new budget); imagery and terrain packs are separate downloads. If the pack exceeds its budget, split a "photogrammetry" component pack rather than grow the base.
7. **Plans (M11).** Recommended: photo processing in the **Builder** plan (it is "building projects from raw data"), unlimited photos, no per-job credits; the Globe in every plan including the free player (it is viewing); region imagery packs included in paid plans; a separate "Processing" add-on only if support costs require it later. Pix4Dmatic Standard costs about USD 3,990 a year and DJI Terra Standard about USD 1,790 a year (`docs/business/2026-10-05-competitors-and-pricing.md`), so processing inside Builder is a strong argument for the plan.
8. **Platforms.** Recommended: photogrammetry on Windows x64 and macOS arm64 only; Intel Macs keep the other pipelines; Windows on Arm not supported in M10.
9. **Real-data founder test.** Recommended: one nadir mapping flight with GCPs and checkpoints (for example the Al-Zour P1 mapping set, if it has control) and one oblique inspection flight, both used only on the founder's machine; the founder names which flights before G2's spike.
10. **PRD change.** Recommended: photogrammetry from images moves into scope (PHO-1 to PHO-8); LiDAR processing from raw scans stays a non-goal.
11. **Version line.** M10 develops on `main` as 0.10.0, as the one-minor-per-milestone rule says. 1.0.0 is still waiting for the founder blockers in `docs/release/CHECKLIST-1.0.md`. Recommended: cut `release/1.0` from the M9 line so 1.0 ships without M10, and ship M10 as 1.1.0 at its exit; the contracts do not depend on the number. If 1.0 has not shipped by M10's exit, the founder chooses between 1.0 with M10 or 1.0 then 1.1.
12. **Customer imagery in packages.** Recommended: imported customer imagery never travels in a `.aio` package by default; the builder can tick it per pack, with a reminder of the provider's licence.

## Decisions (7 Oct 2026, founder: go with the recommendations)

On 7 Oct 2026 the founder said "go with the recommendations". Every decision above is taken as recommended; G0 carries them as written here.

1. **Licence policy:** "permissive only" as defined in "Licence policy and inventory": Apache-2.0, MIT, BSD, ISC and similar, public-domain and CC-BY data with attribution; never GPL, AGPL, SSPL, non-commercial or LGPL-static; LGPL only as the shared GEOS library that already ships; MPL-2.0 only by name with approval: Eigen headers (unavoidable: every candidate pipeline needs them), and certifi, which the pack already ships; DOMPurify inside CesiumJS is taken under its Apache-2.0 option. Add Zlib (pako in CesiumJS, mapMAP's `dset`) and BSL-1.0 (Boost) to the allow-lists.
2. **"Use your own ODM" adapter:** not in M10; revisit after founder testing. No `odm:*` channel, no `Settings.odm`, no `main/odm.ts`.
3. **Cesium architecture:** (c), CesiumJS Globe for overview and navigation only, plus 3D Tiles and terrain in the three.js site view through 3DTilesRendererJS; no editing or measuring tools in the Globe beyond a geodesic read-out (ADR 0007).
4. **Imagery and terrain sources:** ship Natural Earth II in the app; offer a world pack and GCC and Kuwait region packs built from Copernicus Sentinel-2 Global Mosaics or ESA WorldCover 2021 composites, with Copernicus GLO-30 terrain; no EOX cloudless 2018 to 2025 without an EOX commercial licence; no ion, Bing, Google, Esri or Mapbox. Commercial high resolution (Vantor, Airbus, Planet) is bought by the customer and imported, never resold by us. The Copernicus DEM no-liability sentence goes into our EULA.
5. **GPU requirement:** no GPU required. The CPU path is the product. A CUDA build of COLMAP for the High preset is an optional "GPU accelerator" download for Windows with NVIDIA, built only after a patch keeps SiftGPU out and the founder accepts the NVIDIA CUDA runtime's redistribution terms. The CUDA build is deferred to M10.1 unless G3 shows the CPU High preset is unusable.
6. **Pack and installer size:** pipeline pack 0.4.0 at most 1.1 GB unpacked and 450 MB compressed per platform; installer growth for CesiumJS and 3DTilesRendererJS at most 15 MB over the 0.9.0 installer; imagery and terrain packs are separate downloads. If the pack exceeds its budget, split a "photogrammetry" component pack rather than grow the base.
7. **Plans (M11):** photo processing in the **Builder** plan, unlimited photos, no per-job credits; the Globe in every plan including the free player; region imagery packs included in paid plans; a separate "Processing" add-on only if support costs require it later.
8. **Platforms:** photogrammetry on Windows x64 and macOS arm64 only; Intel Macs keep the other pipelines; Windows on Arm not supported in M10.
9. **Real-data founder test:** one nadir mapping flight with GCPs and checkpoints and one oblique inspection flight, both used only on the founder's machine; the founder names which flights later, before G2's spike.
10. **PRD change:** photogrammetry from images moves into scope (PHO-1 to PHO-8); LiDAR processing from raw scans stays a non-goal. Done in G0 (`docs/PRD.md`, non-goals and section 9.1).
11. **Version line:** M10 develops on `main` as 0.10.0. Cut `release/1.0` from the M9 line so 1.0 ships without M10, and ship M10 as 1.1.0 at its exit; the contracts do not depend on the number. If 1.0 has not shipped by M10's exit, the founder chooses between 1.0 with M10 or 1.0 then 1.1.
12. **Customer imagery in packages:** imported customer imagery never travels in a `.aio` package by default; the builder can tick it per pack, with a reminder of the provider's licence (`RasterPackMeta.customerLicence`, the package option lands with the integration follow-up X1).

## Step 0: G0 contracts (serial, about 3 hours, integration lead)

Before the fan-out, one agent writes every contract below in `packages/schema`:

- new files `photogrammetry.ts`, `globe.ts`, `tilesets.ts`;
- additions to `jobs.ts` (pipeline names and params), `ipc.ts` (channels), `manifest.ts` (tolerant layer parsing) and `versions.ts` (registry rows for the new file families).

Alongside the contracts, G0 adds:

- every new channel to `apps/desktop/src/preload/index.ts`;
- a stub module per stream that answers `not-implemented` (the `notYet` pattern): `main/photogrammetry.ts`, `main/globe.ts`, `main/tilesets.ts`, `main/packs/raster.ts` (no `main/odm.ts`: decision 2), each registered by one line in `main/index.ts`;
- every new pipeline in `python/src/aio_pipelines/pipelines.py`, each importing its class from its own module, each a stub step raising `JobError("not implemented")` (`photo/align.py`, `photo/georef.py`, `photo/products.py`, `opf/importer.py`, `opf/exporter.py`, `tiles/mesh.py`, `tiles/cloud.py`, `packs/imagery.py`, `packs/terrain.py`);
- empty packages with their public API and one passing test: `packages/globe` (Globe view, Cesium setup, site list, pack providers) and `packages/tiles` (3DTilesRendererJS adapter for the engine, tileset helpers);
- a bundle check that the built renderer contains no reference to `cesium.com` (ion endpoints included), `virtualearth.net`, `googleapis.com`, `arcgisonline.com` or `mapbox.com`, and a lint rule against Cesium's online providers (the copy of `@cesium/engine` `Build/` to `renderer/cesium/` moves to G6, which adds the dependency);
- data-conventions sections 21 (photogrammetry runs, GCPs and accuracy), 22 (tilesets) and 23 (imagery and terrain packs), and the rows in `contract-changes.md`;
- `docs/architecture/SPEC.md` section 2 rows for `packages/globe` and `packages/tiles`, and section 7 (pipeline pack native tools);
- the PRD edit (decision 10);
- version 0.10.0 in `apps/desktop/package.json`; `aio-pipelines` 0.4.0 in `python/pyproject.toml` with `APP_RANGE = ">=0.10.0 <2.0.0"`.

Tag `contracts-m10` when green.

### What G0 did differently (7 Oct 2026)

G0 kept to the additive rule more strictly than the first draft of this plan, and found two contract problems on the way:

- **No field inside an existing record.** `Settings.globe?` became its own userData file, `globe.json` (`GlobeSettings`, `aio.globe-settings/1`, IPC `globe:getSettings` and `globe:setSettings`), so settings saved by 0.10 stay exactly what 0.9 reads. `MapPackInfo` is unchanged: imagery and terrain packs have their own schemas in `globe.ts` (`RasterPackMeta` on disk, `aio.raster-pack/1`; `RasterPackInfo` in the lists).
- **A name clash fixed:** the plan's pack metadata `source` (where the data came from) collides with `MapPackInfo.source` (how the pack arrived: download, import, build tool, package). The data source is `provenance`; `source` keeps the street-pack meaning.
- **Deferred to the stream that needs it, as an ask to the integration lead** (each changes an existing enum): `ReportSectionId` `processing` and `EXPORT_FORMATS` `photo-report-pdf` (G4; `ReportContentsSettings` is strict over the section ids, the M9 risk), `ImportItem.kind` `opf` (G5).
- **No Cesium dependency in G0** (the founder's instruction for G0: the streams add CesiumJS, 3DTilesRendererJS, COLMAP and pyopf). The copy of Cesium's `Build/` into `renderer/cesium/` moves to G6 (it owns `electron.vite.config.ts`). G0 added the rest of that bullet: `tools/release/check-bundle.mjs` now refuses `cesium.com`, `virtualearth.net`, `googleapis.com`, `arcgisonline.com` and `mapbox.com` anywhere in the built renderer, and `eslint.config.js` bans Cesium's online providers and `@cesium/widgets` in the renderer, `packages/globe` and `packages/tiles`.
- **Raster pack channels** got their own stub module, `main/packs/raster.ts` (G7), registered by one line like the others.
- **Pack pipelines** take `dest` (the data folder's `packs/imagery` or `packs/terrain`, chosen by main), since a pack is not a project file.
- **Python stubs** came back as `python/src/aio_pipelines/stub.py` (`NotBuiltYet`), which now also checks the required names and the fixed choices of the zod params; the last stream to replace its stub deletes it.
- **Pinned in tests:** `packages/schema/src/m10.test.ts` (the 0.9 layer kinds, raster formats, derived kinds, `Settings` and `MapPackInfo` key sets; the new files; the tolerant manifest reader) and `tools/compat/m10-additive.test.mjs` with the 0.9.0 schema extracted into `tools/compat/schema-0.9` (a project written by 0.9 round-trips unchanged; every existing file 0.10 writes parses with 0.9). The corpus now treats 0.10 as the current build. The one known exception: the job index (userData `jobs.json`) lists jobs of the new pipelines, which 0.9 skips one by one.
- **Licence policy** (decision 1) is in `tools/release/licence-exceptions.json`, read by `license-check.mjs` (Zlib and BSL-1.0 added; MPL-2.0 and LGPL only by name) and `python/tests/test_licences.py`. G1 owns all three afterwards.
- **ADRs:** 0007 (Globe and 3D Tiles) and 0008 (photogrammetry engine and licence policy), accepted with the decisions.

### Ownership after G0

| Stream | Stub files G0 creates that the stream then owns                                                                                                                                                                                         | One-line touches in shared files                                                                                                                                                            |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1     | `tools/pipeline-pack/native/**`, `tools/release/native-licences.mjs`, `native-libs.json`, `data-licences.mjs`, `licence-exceptions.json` (created by G0)                                                                                | `tools/pipeline-pack/build.mjs` (native tools step), `license-check.mjs`, `notices.mjs`, `python/tests/test_licences.py`, CI jobs                                                           |
| G2     | `python/src/aio_pipelines/photo/align.py`, `georef.py`, `exif.py` (new), `gcp.py` (new), `accuracy.py` (new)                                                                                                                            | none                                                                                                                                                                                        |
| G3     | `python/src/aio_pipelines/photo/products.py`, `dense.py`, `ortho.py`, `surface.py`, `mesh.py`, `texture.py` (new)                                                                                                                       | the `photo.*` entries of `FORMS` in `apps/desktop/src/renderer/jobs.ts`                                                                                                                     |
| G4     | `apps/desktop/src/main/photogrammetry.ts` and test, `apps/desktop/src/renderer/photogrammetry/**` (new)                                                                                                                                 | the `registerPhotogrammetryIpc` line; one mount line in `builder/ImportPanel.tsx` and in `screens/Jobs.tsx`                                                                                 |
| G5     | `python/src/aio_pipelines/opf/**` (`importer.py`, `exporter.py`, `ply.py` new)                                                                                                                                                          | the `opf.*` entries of `FORMS`                                                                                                                                                              |
| G6     | `packages/globe/**`, `apps/desktop/src/main/globe.ts` and test (sites, packs, settings), `apps/desktop/src/renderer/globe/**` (new), the Cesium assets copy in `apps/desktop/electron.vite.config.ts`                                   | the `registerGlobeIpc` line; the `globe` entry in the shell's view switch; CSP only if the spike proves a need (reviewed)                                                                   |
| G7     | `packages/tiles/**`, `python/src/aio_pipelines/tiles/**`, `python/src/aio_pipelines/packs/**`, `apps/desktop/src/main/tilesets.ts` and test, `apps/desktop/src/main/packs/raster.ts` and test, `packages/maps/src/rasterPacks.ts` (new) | the `registerTilesetsIpc` and `registerRasterPacksIpc` lines; one registration line in `packages/engine/src/adapters/register.ts`; `tools/maps/build-packs.mjs` (imagery and terrain modes) |
| G8     | `python/tests/photo_synth.py` (new), `tools/demo/photo-demo.mjs` (new), `apps/desktop/e2e/fixtures.ts` (`photoProject`, `globeLibrary` fixtures only)                                                                                   | `tools/demo/check-no-client-data.mjs` (EXIF, XMP, OPF, tilesets, pack metadata)                                                                                                             |

Shared files stay with the integration lead after G0; a stream that needs a change there asks for it: `packages/schema/**`, `apps/desktop/src/preload/index.ts`, `apps/desktop/src/main/diagnostics/redact.ts` (allow-list for new settings), `apps/desktop/src/main/index.ts` (CSP), `python/src/aio_pipelines/stub.py` and `pipelines.py`, `python/pyproject.toml` and `uv.lock` (pack 0.4.0: the integration lead re-locks after G1, G5 and G7 add dependencies), `tools/compat/**`, `eslint.config.js` (the Cesium bans) and `tools/release/check-bundle.mjs` (the online host rule).

## Streams

| Stream                                                 | Scope                                                                                                                                                                                                      | PRD                 |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| G1 Pack 0.4.0: native builds and licence gate          | Own builds of COLMAP and pycolmap, OpenCV, PDAL and `texrecon` for Windows x64 and macOS arm64; native and data licence gates; inventory; signing; size budget; CI `pack-native`                           | Licences, release   |
| G2 Alignment and georeferencing                        | `photo.align` (EXIF and XMP, RTK, matching, SfM), `photo.georef` (GCPs and checkpoints), accuracy report, refined poses for photos layers                                                                  | PHO-1 to PHO-4      |
| G3 Dense cloud, surfaces, ortho and mesh               | `photo.products`: CPU dense matching, fusion, COPC, DSM and DTM, orthomosaic, Poisson and 2.5D meshes, texturing; layers and `run.json`                                                                    | PHO-5 to PHO-7      |
| G4 Process photos in the Builder                       | Wizard (photos, CRS, preset, estimate, hardware check), GCP import and marking with predictions and target detection, accuracy report view and PDF, Jobs integration, **Use refined poses**                | PHO-1, PHO-3, PHO-8 |
| G5 OPF interchange (and the ODM adapter if decision 2) | `opf.import` and `opf.export` with pyopf; OPF in the import list; optional loopback NodeODM or CLI adapter                                                                                                 | PHO-8               |
| G6 Globe view                                          | CesiumJS view, offline configuration, library sites on the Earth, imagery and terrain from packs, project tilesets and orthos, issues as pins, fly-in and **Open site here**, attributions, Low-tier rules | GLB-1 to GLB-4      |
| G7 Imagery, terrain and 3D Tiles                       | Imagery and terrain pack builders and import; pack manager; MapLibre raster and terrain; mesh and COPC to 3D Tiles; 3DTilesRendererJS in the site view (tilesets, terrain, imagery around the site)        | GLB-2, GLB-5, MAP-3 |
| G8 Synthetic data and the M10 harness                  | Rendered photogrammetry set with known poses, GCPs and surfaces; OPF fixtures; synthetic packs and tilesets; photo demo project; client-data check                                                         | Global constraint   |

### G1 Pack 0.4.0: native builds and licence gate

**Owns:**

- `tools/pipeline-pack/native/**` (new): `vcpkg-overlay/` (ports and triplets), `colmap/` (pinned tag, patches, wheel build script), `opencv/` (wheel build with options), `pdal/`, `texrecon/`, `build-native.mjs` (orchestrates, writes `native-manifest.json`)
- `tools/pipeline-pack/build.mjs`: a native tools step (copies `tools/` and the built wheels into the pack before the manifest)
- `tools/release/native-licences.mjs`, `native-libs.json`, `data-licences.mjs`, `licence-exceptions.json` (new); `license-check.mjs`, `notices.mjs` (extended)
- `python/tests/test_licences.py` (allow-list, extras check)
- `.github/workflows/ci.yml` job `pack-native`; `release.yml` pack jobs; `nightly.yml` full pack build
- `tools/release/budgets.mjs` (`pack` and `installer` budgets of decision 6)

**Scope:**

- **One recipe per native component, pinned.** vcpkg at a pinned baseline with an overlay that fixes features:
  - `ceres[eigensparse,schur]` (no `suitesparse`, no `lapack`), `metis`, `eigen3` with `EIGEN_MPL2_ONLY`;
  - `openimageio` with default features only; `boost-*`, `gflags`, `glog`, `sqlite3`;
  - COLMAP 4.2.x from its source tag with `-DCUDA_ENABLED=OFF -DHIP_ENABLED=OFF -DGUI_ENABLED=OFF -DOPENGL_ENABLED=OFF -DCGAL_ENABLED=OFF -DLSD_ENABLED=OFF -DDOWNLOAD_ENABLED=OFF -DONNX_ENABLED=OFF -DMVS_ENABLED=ON`, plus our patch making CHOLMOD optional (Eigen `SimplicialLDLT`); the patch goes upstream as a `CHOLMOD_ENABLED` option;
  - pycolmap built from the same tree as a cp313 wheel (`win_amd64`, `macosx_14_0_arm64`), installed into the pack instead of the PyPI wheel;
  - OpenCV as a custom `opencv-python-headless` wheel with `-DWITH_FFMPEG=OFF -DWITH_GSTREAMER=OFF -DBUILD_opencv_videoio=OFF -DOPENCV_ENABLE_NONFREE=OFF`;
  - PDAL CLI (with GDAL and PROJ shared, GEOS shared) into `<pack>/tools/pdal/`, which `pointcloud.py` already looks for;
  - `texrecon` (mvs-texturing with mapMAP, rayint, TBB) into `<pack>/tools/texrecon/`, and MVE's `dmrecon`, `scene2pset` and `fssrecon` into `<pack>/tools/mve/`, both from ODM's BSD-3 forks as the Windows build reference, with Eigen headers unmodified;
  - an OpenSfM build for G2's spike only (Ceres without SuiteSparse, our OpenCV, fpdf2 and the OpenMVS exporter removed), shipped only if the spike picks it.
- **Native licence gate:** vcpkg SBOMs plus a file scan of the pack (see "The licence gate"). A forbidden port, an unknown DLL or an LGPL static archive fails the build with the file name.
- **Source archive:** for every pack, a `pack-sources-<version>.tar.zst` with the exact sources, patches and vcpkg baseline, kept with the release (good practice for MPL and LGPL items and for audits).
- **Signing:** every new DLL, dylib and executable is signed (Windows) and signed and notarised (macOS) file by file, as the pack is today; `smoke-packaged.mjs` gains a photogrammetry probe (`python -m aio_pipelines --selftest photo`: align 8 synthetic images and check the result).
- **Budgets:** `budgets.mjs` gains `pack.unpackedBytes` and `pack.compressedBytes` (decision 6) and the installer delta for CesiumJS; CI fails above them.
- **CI jobs:**
  - `pack-native` (Windows x64 and macOS arm64): builds the native components with the vcpkg binary cache in GitHub Actions cache (cold builds are 60 to 120 min; warm about 10 min), runs the native licence gate, uploads the wheels and tools as an artifact. Runs on changes under `tools/pipeline-pack/native/` and nightly.
  - `pipelines` (existing) installs the `pack-native` artifact wheels into the venv on both OSes, so pytest runs against our own pycolmap and OpenCV.
  - `release.yml` builds the pack for `win32-x64` and `darwin-arm64` with photogrammetry, and for `darwin-x64` without it (decision 8).

**Tests:**

- **node:test / Vitest:** `native-licences.mjs` on fixture SBOMs (a planted `suitesparse-spqr`, an LGPL static library, an unknown DLL each fail; a clean set passes); `data-licences.mjs` refuses CC-BY-NC and a pack without attribution; notices render the new sections; budgets.
- **pytest:** `test_licences.py` with the allow-list; pycolmap reports no CUDA and no CHOLMOD (`pycolmap.build_info` or an import probe); `import cv2` has no FFmpeg backend (`cv2.getBuildInformation()` parsed).
- **CI:** the pack smoke test on both OSes; the pack is within budget.

**Risks:**

- COLMAP without CHOLMOD Supernodal is slower in the global mapper's sparse solves and large bundle adjustments. G2 measures; mitigations are Accelerate sparse on macOS, smaller submodels, and upstreaming a faster permissive path.
- vcpkg cold builds are long and can break on runner image updates: pin runner images, cache aggressively, and keep the last good artifact.
- macOS notarisation of hundreds of new binaries: the existing file-by-file pipeline handles it; budget extra release time.
- Our own pycolmap and OpenCV wheels drift from upstream: pin, and rebuild on each upstream minor in a scheduled job.

**Founder test steps (stage M10, pack):**

- [ ] Install pipeline pack 0.4.0 on the Windows workstation and on the Mac. **Settings, Pipelines** shows 0.4.0 and "Photo processing: available (CPU)".
- [ ] **Settings, About, Licences** lists the native libraries with their licences; no GPL, AGPL or "non-commercial" appears.
- [ ] Install the 0.10.0 app with pack 0.3.0: the app asks for pack 0.4.0 for photo processing and runs every other pipeline as before.

### G2 Alignment and georeferencing

**Owns:**

- `python/src/aio_pipelines/photo/align.py` (`PhotoAlign`), `georef.py` (`PhotoGeoref`), `exif.py` (EXIF, DJI XMP, RTK fields; shares the reader with `aik/cameras.py`), `gcp.py` (GCP files, marks, prediction), `accuracy.py` (residuals, RMSE, report JSON), `crs.py` (PROJ pipelines and geoid grids), `colmap_io.py` (thin wrapper over pycolmap)
- `python/tests/test_photo_align.py`, `test_photo_georef.py`, `test_photo_exif.py`, `test_gcp.py`

**Scope:**

- **Inspect.** Read every photo's EXIF and XMP: camera make and model, focal length and sensor, image size, GPS, `AbsoluteAltitude`, `RelativeAltitude`, gimbal angles, `RtkFlag` and RTK standard deviations, capture time. Group by camera (one calibration per camera body and lens). Reject corrupt files, panoramas and images without size; warn on missing GPS, mixed cameras, motion blur (Laplacian variance) and duplicates (hash). PPK CSV replaces EXIF positions.
- **Features and matching.** SIFT through pycolmap on CPU, with the image size from the preset. Pairs from GPS neighbours (radius from altitude and field of view), plus sequential neighbours along flight lines, plus vocabulary-tree or retrieval pairs for photos without GPS. Geometric verification. Progress per image.
- **SfM.** Global mapper by default (fast on large nadir grids), incremental as the fallback when the global result registers fewer than 95% of images. Self-calibration of focal, principal point and radial-tangential distortion per camera group. Submodels are merged; disconnected groups are reported by name ("12 photos of flight 3 could not be joined").
- **Georeferencing.** Similarity transform from the SfM frame to the project CRS from GNSS positions (robust, RANSAC), then bundle adjustment with GNSS position priors weighted by RTK accuracy. Heights follow the manifest `verticalDatum`; PROJ converts ellipsoidal to orthometric with a named geoid grid.
- **`photo.georef`.** Bundle adjustment with GCP observations (marks from `gcp.json`) as 3D points with priors from their stated accuracy; checkpoints only measured. The accuracy report (`aio.photo-accuracy/1`) and an outlier list.
- **Predicting marks.** For each GCP and photo, the projected pixel position through the current cameras, with a search radius from the camera uncertainty; written into `gcp.json` as `predicted` (for G4).
- **Refined poses.** A `cameras-sfm.json` beside the photos layer's `cameras.json` (same `aio` camera format), so **Use refined poses** (G4) can swap them with a `.bak`; review copies and photo-to-model projection then use calibrated cameras.
- **Outputs:** `photogrammetry/<run>/sparse/` (COLMAP model), `run.json` (stages, settings, versions, warnings), `report/align.json`.

**Contracts used:** `PipelineName` `photo.align` (`PhotoAlignParams`: `photos` (`{ layer }` or `{ folders[] }`), `run?`, `preset` (`fast` | `standard` | `high`), `matching?` (`auto` | `gps` | `sequential` | `exhaustive`), `mapper?` (`auto` | `global` | `incremental`), `gnss?` (`auto` | `rtk` | `standard` | `ignore`), `ppk?` (CSV path), `crs?`, `maxImageSize?`) and `photo.georef` (`PhotoGeorefParams`: `run`, `gcp?` path, `useGnss?`); `PhotoRun` (`aio.photo-run/1`), `GcpFile` (`aio.gcp/1`), `AccuracyReport` (`aio.photo-accuracy/1`).

**Tests:**

- **pytest** (G8's `photo_synth.py`, quick set):
  - EXIF and XMP: DJI-style tags parsed, RTK flags mapped, a photo with no GPS warned, a corrupt JPEG rejected with its name.
  - Alignment: at least 98% registered, reprojection under 1 px, cameras within the targets after a similarity to truth.
  - GNSS-only: RTK set within 3 x GSD at checkpoints; standard GNSS set reports its absolute error honestly.
  - GCP: 5 control and 4 check points meet the checkpoint targets; a planted GCP with a 1 m coordinate error is named as the outlier; checkpoints never change the adjustment (residuals identical with and without them as control-excluded).
  - CRS: a known UTM 39N point round-trips through WGS84 and ECEF within 1 mm; ellipsoidal to EGM2008 with the grid matches a reference value.
  - Resume after a kill in the middle of matching restarts at matching; changed photos refuse the resume.
  - Cancel stops within 5 s.
- **Vitest:** none (Python stream); G4 tests the UI.

**Risks:**

- Repetitive textures (solar farms, tank roofs, water) break matching: GPS-guided pairs, rejecting pairs inconsistent with GPS, and an honest per-photo report.
- Oblique and nadir mixes and close-range inspection orbits: the incremental mapper is the fallback; G2 includes an orbit in the synthetic set.
- Altitude datum confusion (the Al-Zour lesson: 20 to 44 m height errors before calibration): every run states which altitude it used and how it was converted, and the report flags GNSS heights that disagree with GCPs by more than 1 m.

**Founder test steps (stage M10, alignment):**

- [ ] **Builder, Process photos** on the photo demo: alignment finishes; the report shows all but the two bad photos registered, with the reason for each rejected one.
- [ ] Run it on your real nadir flight (decision 9) with GNSS only: the cameras sit on the flight lines in 3D, and the report gives a reprojection error under 1 px.
- [ ] Cancel during matching, then **Resume**: it continues from matching.

### G3 Dense cloud, surfaces, ortho and mesh

**Owns:**

- `python/src/aio_pipelines/photo/products.py` (`PhotoProducts`), `dense.py` (CPU depth maps through `dmrecon` or our SGM; CUDA PatchMatch call if built), `fuse.py`, `surface.py` (DSM, DTM through PDAL), `ortho.py`, `mesh.py` (Poisson, 2.5D, trim, decimate), `texture.py` (`texrecon` call and our own texturing)
- `python/tests/test_photo_dense.py`, `test_photo_ortho.py`, `test_photo_surface.py`, `test_photo_mesh.py`
- the `photo.*` entries of `FORMS` in `apps/desktop/src/renderer/jobs.ts`

**Scope:**

- **Week 1 spike:** CPU dense options (MVE `dmrecon`, SGM plus COLMAP fusion, OpenSfM CPU depth maps) and meshing (Poisson against MVE FSSR) on the synthetic set and the founder flight; pick by accuracy, completeness, time and memory. Record the result in this plan.
- **Dense:** depth maps per image (or per rectified pair) at the preset resolution, in clusters within the memory cap; COLMAP stereo fusion on CPU with geometric consistency; colours and normals.
- **Cloud:** PDAL to COPC in the project CRS with `filters.smrf` ground classification; a `pointcloud` layer (`copc`).
- **DSM and DTM:** gridded at the chosen GSD (default 2 x ortho GSD), holes filled within a radius, COG on disk (`photogrammetry/<run>/dsm.tif`, `dtm.tif`) and a coloured hillshade `kit-pyramid` raster layer with `role: 'dsm'`.
- **Ortho:** orthorectification on the DSM per output window, view selection, seam feathering, gain and white balance, COG (`ortho.tif`) and a `kit-pyramid` raster layer with `role: 'ortho'`, at the ortho GSD (default the median GSD of the photos).
- **Mesh:** Screened Poisson (depth from the preset) trimmed by density, or a 2.5D mesh from the DSM; texturing; a decimated GLB `mesh` layer (2 M triangles by default, Meshopt-compressed, with an identity `transform` in the project frame); the full mesh handed to G7's `tiles.mesh`.
- **Region and capture:** an optional polygon limits products; a survey date (`capture`) is set on every new layer, so M8 change detection works between processed surveys.
- **Commit:** layers, `run.json` with the layer ids, `report/products.json` (GSD, coverage, point density, timings, memory peak).

**Contracts used:** `PipelineName` `photo.products` (`PhotoProductsParams`: `run`, `products` (`cloud` | `dsm` | `dtm` | `ortho` | `mesh` | `tiles`)[], `preset?`, `dense?` (`auto` | `cpu` | `cuda`), `gsdCm?`, `region?` (`LonLatRing`), `capture?`, `meshTriangles?`); existing layer kinds only.

**Tests:**

- **pytest** (synthetic quick set, known surfaces):
  - Dense cloud: 95% within 3 x GSD; completeness over 90%.
  - DSM: RMSE under 3 x GSD; DTM removes the synthetic buildings and piles; the stockpile volume from the DSM is within 2% (through the existing volumetric code).
  - Ortho: GCP targets in the ortho within 2 x GSD; no seam through a target (the view selection keeps a target in one photo); the COG validates (rasterio, overviews present).
  - Mesh: 95th percentile distance under 4 x GSD; GLB validates; triangle budget held.
  - Memory: a run under a 2 GB cap on the quick set finishes (clusters) instead of failing.
  - Disk check refuses with the needed and available numbers.
  - Resume after a kill in dense restarts at the first unfinished cluster.
- **Playwright** (`photo-products.spec.ts`, the photo demo with a precomputed alignment from G8): run products; the ortho, DSM, cloud and mesh layers appear; the ortho shows on the map; clicking a GCP target in 3D lands within 2 x GSD of its truth (inspection hook).

**Risks:**

- CPU dense quality and time: the spike may show SGM is weak on oblique close-range data. Mitigations: the High preset uses CUDA when available (decision 5), and the Standard preset for inspection orbits uses the incremental mapper's denser sparse cloud plus Poisson.
- Ortho artefacts on buildings and tanks (leaning facades, double edges): true-ortho needs a good DSM; document as a known limit for Fast.
- Large jobs: windowed IO everywhere (rasterio windows, PDAL streaming), never a whole raster in memory.

**Founder test steps:**

- [ ] On the aligned photo demo, **Create products**, Standard: the ortho, DSM, point cloud and textured mesh appear as new layers. The original layers are untouched.
- [ ] **Map**: the ortho lies on the street map with the roads aligned. **Measure** a GCP-to-GCP distance on the ortho: within 5 cm of the demo's notes.
- [ ] **Volumes** on the demo pile, from the new DSM: within 2% of the demo's notes.
- [ ] Your real flight (decision 9), Standard: note the time and the peak memory shown in the job; compare the ortho against your Pix4D or DJI Terra ortho in a swipe.

### G4 Process photos in the Builder

**Owns:**

- `apps/desktop/src/main/photogrammetry.ts` and test (runs, GCP read and write, hardware probe, estimate, refined-pose swap)
- `apps/desktop/src/renderer/photogrammetry/**` (new): `ProcessWizard.tsx`, `GcpTable.tsx`, `GcpMarker.tsx` (photo with loupe, prediction ring, draft marks), `AccuracyReport.tsx`, `RefinedPoses.tsx`, `estimate.ts`, `hardware.ts`
- one mount line in `builder/ImportPanel.tsx` (**Process photos**) and in `screens/Jobs.tsx` (open the run from a job)
- the accuracy report PDF (export format `photo-report-pdf`, kind `report-pdf`) and the house-report section `processing`
- `apps/desktop/e2e/photo-process.spec.ts`, `gcp-marking.spec.ts`

**Scope:**

- **Wizard:** pick photos (a folder, or an existing photos layer); CRS (project CRS, or a UTM zone suggested from the photos for a new project); preset with plain words; products; survey date; a per-machine estimate (time range, disk, memory) from the photo count, image size, preset and the hardware probe; a GPU line ("NVIDIA RTX 4070, 12 GB: used for High" or "No supported GPU: CPU only").
- **Hardware probe** (`photo:probe`): CPU model and cores, memory, free disk on the data drive, GPU from Electron's `app.getGPUInfo`, CUDA availability from the pack's self-test; cached per session; shown in Settings, Pipelines and in the diagnostics bundle.
- **GCPs:** import a CSV or TXT with column mapping and EPSG choice; a table with role (control or check), accuracy and the number of marks; the marker view shows photos that see the selected point, sorted by predicted distance to the image centre, with the prediction ring and draft detections; keyboard (next photo, confirm, skip, zoom); at least three marks per point; **Adjust** starts `photo.georef`.
- **Accuracy report** view and PDF: tables of residuals, RMSE by role, camera residuals, an overlap map, warnings; the house-report section `processing` with the same summary.
- **Use refined poses:** a preview listing how far each camera moves (median and maximum), then the swap with `.bak`.
- **Runs list:** per project, the runs with their status, preset, products and accuracy; **Open run**, **Re-run products**, **Delete run's work files** (only `photogrammetry/<run>/work/`, never outputs; asks first, moves to the recycle bin through Electron's `shell.trashItem`).

**Contracts used:** IPC `photo:probe`, `photo:estimate` (`{ photos, preset, products }` to `{ minutes: [lo, hi], diskBytes, memoryBytes }`), `photo:runs`, `photo:readRun`, `photo:readGcp`, `photo:writeGcp` (atomic, `.bak`, refused for packages), `photo:applyPoses`, `photo:cleanWork`; `ReportSectionId` gains `processing` (listed in `HOUSE_SECTIONS`); `EXPORT_FORMATS` gains `photo-report-pdf` mapped to the existing kind `report-pdf`.

**Tests:**

- **Vitest:** estimate maths; GCP CSV parsing (column mapping, separators, EPSG, latitude-longitude order); mark state machine (draft, confirmed, skipped); report table rendering; atomic write with `.bak`; refusal for packages.
- **Playwright** (`photo-process.spec.ts`, photo demo, `STRATLAS_E2E_PYTHON`): the wizard estimates; start alignment; the job shows per-stage progress; cancel and resume; the run opens with the report.
- **Playwright** (`gcp-marking.spec.ts`): import the demo GCP CSV; the marker view shows the prediction ring on the demo target within 10 px; confirm three marks per point with the keyboard; **Adjust**; the report lists the checkpoints with RMSE under the target; zero-network guard passes.
- **axe** on the wizard, GCP table, marker view and report.

**Risks:**

- GCP marking is the slowest human step in every photogrammetry product; prediction plus target detection should bring it to seconds per mark. The founder test measures it.
- Coordinate order and CRS mistakes in customer GCP files: the import previews points on the map before accepting.

**Founder test steps:**

- [ ] Demo, **Builder, Process photos**: the wizard shows the estimate and "CPU only" (or your GPU). Start with Standard.
- [ ] **Import GCPs** from the demo CSV: the points show on the map in the right place. Mark the first point: the ring is on the target in each photo; confirm with the keyboard. Mark all five control points and leave the four checkpoints unmarked as control.
- [ ] **Adjust**: the report shows checkpoint RMSE in centimetres, and the planted bad point (GCP 6) is flagged.
- [ ] **Use refined poses**: the preview shows the movement; after applying, open a photo and its findings land closer on the model.
- [ ] **Export, Processing report (PDF)** opens with the tables and the overlap map.

### G5 OPF interchange (and the optional ODM adapter)

**Owns:**

- `python/src/aio_pipelines/opf/importer.py` (`OpfImport`), `exporter.py` (`OpfExport`), `ply.py` (own PLY reader, no plyfile)
- `python/tests/test_opf.py`
- the OPF entry in the builder import list (`ImportItem.kind` gains `opf` for the builder's list only, as M8 did with `drawing`)
- if decision 2 says yes: `apps/desktop/src/main/odm.ts` (discovery on loopback, PyODM-compatible REST calls from TypeScript, or a CLI path), `python/src/aio_pipelines/odm/import_outputs.py`, `apps/desktop/e2e/fake-nodeodm.ts`
- `apps/desktop/e2e/opf.spec.ts`

**Scope:**

- **Import:** validate the OPF project (pyopf), refuse paths outside its folder; cameras (input and calibrated), sensors and calibration into a photos layer's `cameras.json`; GCPs and marks into `gcp.json`; CRS from the OPF scene reference frame through PROJ; outputs into layers (glTF point clouds to COPC, GeoTIFF to COG and `kit-pyramid`, meshes to GLB). A report of what came in and what was skipped.
- **Export:** a run to OPF 1.x (project, input and calibrated cameras, sensors, GCPs, CRS, sparse cloud as OPF glTF points), validated by pyopf on read-back.
- **Adapter (decision 2 only):** **Settings, Processing, Use your own ODM** with a guide page; discovery of NodeODM or NodeODX on loopback; a task with our photos; progress polling; outputs imported by `odm.import_outputs`; a notice that ODM is AGPL software the person installed. Never a Docker command or an install from Stratlas.

**Contracts used:** `PipelineName` `opf.import` (`OpfImportParams`: `src` (the `.opf` project file), `products?`, `photosRoot?`), `opf.export` (`OpfExportParams`: `run`, `out`); if decision 2: IPC `odm:probe`, `odm:start`, `odm:cancel`, `Settings.odm?` (`{ enabled, baseUrl, kind: 'nodeodm' | 'nodeodx' | 'cli', exe? }`).

**Tests:**

- **pytest:** export the synthetic run to OPF, import it into a new project: cameras within 1e-6 of the source, GCPs identical, CRS identical; a hand-written OPF fixture from the spec's examples (CC-BY, attributed) imports; hostile OPF (absolute path, `..`, missing file, huge declared count) refused with the reason; no `plyfile` installed (`importlib.util.find_spec`).
- **Playwright** (`opf.spec.ts`): Builder, Import, the demo OPF: a photos layer with calibrated cameras and a point cloud appear.
- If decision 2: a fake NodeODM on loopback (`AIO_NETWORK_GUARD_ALLOW`) runs a task; outputs import; the network log shows only loopback.

**Risks:**

- OPF versions and optional parts vary by writer: import what is valid, report the rest.
- Pix4D's OPF outputs may reference proprietary files (`.p4d`): skipped with a note.

**Founder test steps:**

- [ ] Export the processed demo run as OPF; import it into a new project: the photos open with calibrated poses and the cloud shows.
- [ ] If you have Pix4D: open our OPF there; export a Pix4D project as OPF and import it into Stratlas.

### G6 Globe view

**Owns:**

- `packages/globe/**` (new): `GlobeView.tsx` (React wrapper around a `CesiumWidget`), `setup.ts` (offline configuration, `CESIUM_BASE_URL`, no ion), `imagery.ts` (`PmtilesImageryProvider`, `KitPyramidImageryProvider` for project orthos), `terrain.ts` (heightmap provider from terrain packs, geoid offset), `sites.ts` (library projects to positions and footprints), `pins.ts` (issues as billboards, clustered), `tilesets.ts` (project tilesets with ENU-to-ECEF root transforms), `credits.ts`, `camera.ts` (fly-to, hand-off to the site view)
- `apps/desktop/src/main/globe.ts` and test (`globe:sites`: manifests of library projects to lon, lat, footprint, capture dates and issue counts; computed in the data utility process)
- `apps/desktop/src/renderer/globe/**` (new) and the `globe` entry in the shell's view switch
- `apps/desktop/electron.vite.config.ts` (Cesium assets copy), and the CSP line only if the spike proves a need (integration lead reviews)
- `apps/desktop/e2e/globe.spec.ts`

**Scope:**

- **Day-one spike:** CesiumJS in our Electron with our CSP, no ion, assets from `'self'`, a PMTiles imagery layer and a terrain heightmap; zero requests; memory and bundle size measured. The rest of G6 waits for it.
- **Globe view** (a top-level view beside Projects, and from a project: **Show on globe**):
  - Every library project as a pin at its origin, with its footprint, name, last capture and open issues; clusters at low zoom.
  - Imagery from installed imagery packs (the best covering pack per tile, as `orderPacks` does for street maps) over Natural Earth II; terrain from terrain packs; a **Terrain** and an **Imagery** menu with the attribution of each.
  - In a project: its orthos as imagery layers (`kit-pyramid` read directly), its tilesets (mesh and points) from `tilesets.json`, survey footprints per capture with a date filter, and issues as pins coloured by severity.
  - Click a pin: a card (code, class, severity, photo thumbnail); **Open site here** opens the site view at the same camera position and heading (converted to the project frame); **Open issue** opens it in the site view.
  - Geodesic distance and area read-out (labelled), no other tools.
- **Offline rules:** see "CesiumJS in Electron, offline". A lint rule bans ion, Bing, Google and geocoder imports in `packages/globe`.
- **Performance:** lazy chunk; the CesiumWidget is destroyed when the view closes; frame budget on the Medium tier; Low tier: terrain off, higher screen-space error, no atmosphere.
- **Agent:** `show_on_globe` (navigate) and `list_sites` (read) tools.

**Contracts used:** IPC `globe:sites` (`{}` to `{ ok, sites: GlobeSite[] }`: `{ projectId, name, lonLat, footprint?, captures, issues: { open, bySeverity }, tilesets }`), `globe:packs` (imagery and terrain `RasterPackInfo`); `GlobeSettings` in userData `globe.json` (`aio.globe-settings/1`: `imagery?`, `terrain?`, `terrainExaggeration?`, `showIssues?`, `aroundSite?`) through `globe:getSettings` and `globe:setSettings` (G0 moved it out of `Settings`); `tilesets.json` (G7).

**Tests:**

- **Vitest:** site positions from manifests (EPSG codes and WKT through `@aio/geo`); ENU-to-ECEF root transform against a PROJ reference within 1 mm; camera hand-off round trip (globe to site to globe within 1 cm and 0.01 degrees); imagery provider tile addressing; credit text from pack metadata; the lint rule.
- **Playwright** (`globe.spec.ts`, `globeLibrary` fixture with two synthetic projects and synthetic imagery and terrain packs; WebGL through SwiftShader in CI):
  - Open the Globe: both sites show; `__aioNetworkLog` is empty (zero-network guard).
  - Fly to site A: the ortho and mesh tileset render (pixel sample through the inspection hook).
  - Click an issue pin, **Open issue**: the site view opens with that issue selected.
  - Credits list the synthetic pack's attribution.
  - Close the Globe: GPU memory returns to within 10% of before (the M7 memory watch).
- **Bundle check:** `tools/release/check-bundle.mjs` gains the rule that no Cesium ion, Bing or Google host string is in the built renderer.

**Risks:**

- CSP: if any CesiumJS path needs `'unsafe-eval'`, we patch or avoid that module; we never weaken the app CSP for it.
- Two WebGL contexts at once exhaust GPU memory on laptops: the Globe owns the GPU while open; the site view releases its context when the Globe opens from it.
- Precision: pins and tiles placed through ENU frames at the site origin, never large float32 coordinates.
- CesiumJS release cadence (monthly): pin a version, update once per milestone with the zero-network test as the gate.

**Founder test steps (stage M10, Globe):**

- [ ] Turn Wi-Fi off. **Globe**: the Earth appears with imagery; your projects show as pins in Kuwait and the GCC.
- [ ] Install the GCC imagery and terrain packs (from a USB folder): the imagery sharpens over the GCC and the terrain shows relief; the credit line names the sources.
- [ ] Fly into the demo site: the processed ortho, mesh and point cloud appear; the issues show as coloured pins.
- [ ] Click an issue pin, **Open issue**: the site view opens on it with every tool working. **Back to globe** returns to the same view.

### G7 Imagery, terrain and 3D Tiles

**Owns:**

- `python/src/aio_pipelines/packs/imagery.py` (`ImageryPack`: GeoTIFF, COG or a folder of them to raster PMTiles, WebP, Web Mercator, with overviews), `packs/terrain.py` (`TerrainPack`: DEM to Terrarium tiles in PMTiles, geoid metadata), `packs/pmtiles_writer.py` (own writer, or the `pmtiles` Python package if its licence and wheel pass G1)
- `python/src/aio_pipelines/tiles/mesh.py` (`TilesMesh`: GLB or OBJ to 3D Tiles 1.1, octree split, per-level decimation with fast-simplification, texture downscaling with Pillow, Meshopt or Draco compression), `tiles/cloud.py` (`TilesCloud`: COPC to 3D Tiles points, one glTF points tile per COPC node, `tileset.json` mirroring the COPC hierarchy), `tiles/transform.py` (project CRS to ECEF per vertex in float64, RTC centres)
- `packages/tiles/**` (new): the 3DTilesRendererJS adapter registered with the engine (`registerTilesetAdapter`), terrain and imagery plugins around the site, picking through the engine's raycaster, budgets per graphics tier
- `packages/maps/src/rasterPacks.ts` (MapLibre raster and `raster-dem` sources from imagery and terrain packs; hillshade)
- `apps/desktop/src/main/tilesets.ts` and test (`tilesets:list`, `tilesets:write` with `.bak`), `apps/desktop/src/main/packs/**` additions for imagery and terrain packs (list, import, remove, download from a configured URL list)
- `tools/maps/build-packs.mjs` (`--imagery` and `--terrain` modes for our own world and region packs, run once online on a development machine, as street packs are built today)
- `apps/desktop/e2e/tilesets.spec.ts`, `imagery-packs.spec.ts`

**Scope:**

- **Imagery packs:** build from sources (our tooling, decision 4) or **Import imagery** in the app (customer GeoTIFF or COG, with licence and attribution fields). Reprojection to Web Mercator with GDAL, WebP at a chosen quality, overviews, metadata (`kind: 'imagery'`, `licence`, `attribution`, `source`, `customerLicence?`). Packs show in **Settings, Map packs** with their coverage on the map (the existing `PackCoverage`).
- **Terrain packs:** DEM to Terrarium tiles, vertical datum in metadata, EGM2008 to ellipsoid offsets applied by the Globe; a small world terrain for the installer if within budget (decision 6).
- **MapLibre:** imagery packs as raster sources under the street map (a **Satellite** basemap style); terrain packs as `raster-dem` with hillshade.
- **3D Tiles from project data:**
  - `tiles.mesh` for processed meshes (G3) and for any existing GLB on request; tiles placed by per-vertex reprojection, so the Globe and the site view agree.
  - `tiles.cloud` for COPC layers (globe display only; the site view keeps its own COPC renderer).
  - Validated in CI with 3d-tiles-validator and 3d-tiles-tools (dev only).
- **3D Tiles in the site view:** `tilesets.json` entries render through 3DTilesRendererJS inside the engine with the project's local frame, its Draco and KTX2 loaders pointed at our bundled decoders (its examples use a CDN); picking, issues on tiles (sightings store the hit point and the tileset id), measuring and the cutaway work; budgets per tier.
- **Import 3D Tiles** (from other software, for example Bentley, Pix4D or DJI Terra exports): a folder with `tileset.json` becomes a tileset entry, with georeference from its root transform; the person confirms its placement on the map.
- **Terrain and imagery around the site:** optional in the site view (Settings), from the packs, under the project's own ground, so a site sits in its landscape.

**Contracts used:** `aio.tilesets/1` (`TilesetsFile`: `entries[]` of `{ id, name, kind: 'mesh' | 'points' | 'terrain' | 'imported', src, from?: layerId, run?, capture?, visible, transform? }`); `RasterPackMeta` (`aio.raster-pack/1`, `packs/{imagery,terrain}/<id>.json`: `kind` `imagery` or `terrain`, `licence`, `attribution`, `provenance?`, `encoding?` (`terrarium`), `verticalDatum?`, `customerLicence`) and `RasterPackInfo` (G0 left `MapPackInfo` unchanged); IPC `tilesets:list`, `tilesets:write`, `imageryPacks:list`, `imageryPacks:import`, `imageryPacks:remove`, `terrainPacks:list`, `terrainPacks:import`, `terrainPacks:remove`; `PipelineName` `tiles.mesh`, `tiles.cloud`, `packs.imagery`, `packs.terrain` with params.

**Tests:**

- **pytest:** a synthetic GeoTIFF in UTM becomes a PMTiles pack whose tile at a known lon and lat has the expected colour; the terrain pack decodes back to the source heights within 1/256 m; `tiles.mesh` output validates (3d-tiles-validator in CI), its geometric error decreases per level, and a known vertex lands within 1 mm of its ECEF truth; `tiles.cloud` keeps the point count and hierarchy; resume and cancel.
- **Vitest:** the engine adapter (load, unload, budgets, picking through a fake tileset); MapLibre style with imagery and terrain sources; pack metadata validation; `tilesets:write` atomic with `.bak`.
- **Playwright** (`tilesets.spec.ts`): the demo's mesh tileset loads in the site view; an issue placed on it persists and reopens; the cutaway clips it; the zero-network guard passes. (`imagery-packs.spec.ts`): import a synthetic GeoTIFF; the Satellite basemap shows it on the map and in the Globe with its attribution.

**Risks:**

- 3DTilesRendererJS is pre-1.0 (0.5.x): pin, wrap behind `packages/tiles`, and keep our own tests on its behaviour.
- Pack sizes for regions at 10 m: G7 measures before decision 4 is acted on; packs are optional downloads.
- Terrain datum mistakes put sites metres under the ground on the Globe: a test with a known benchmark height in the synthetic pack.

**Founder test steps:**

- [ ] **Settings, Map packs, Import imagery**: pick the demo GeoTIFF (or a satellite image you bought): the pack appears with its licence; **Map, Satellite** shows it under the streets.
- [ ] Demo site view: the processed mesh streams in as you approach (no long load); mark an issue on it and measure across it.
- [ ] **Import 3D Tiles** from another program's export (if you have one): it lands in place after you confirm.
- [ ] Turn on **Terrain around the site**: the land around the demo site shows relief and imagery.

### G8 Synthetic data and the M10 harness

**Owns:**

- `python/tests/photo_synth.py` (new): the photogrammetry generator
- `tools/demo/photo-demo.mjs` (new): the photo demo project (calls the generator, writes a precomputed alignment for UI tests)
- `apps/desktop/e2e/fixtures.ts`: `photoProject` and `globeLibrary` fixtures only
- `tools/demo/check-no-client-data.mjs` (EXIF and XMP, OPF, tilesets, pack metadata)
- CI job `demo` (build and check, with the photo demo `--quick`)

**Scope:** see "Synthetic test data" below.

**Tests:**

- **pytest:** the generator is deterministic (same seed, same image hashes on the same platform; truth identical everywhere); cameras in `truth.json` reproject GCP targets onto the rendered target centres within 0.25 px; EXIF and XMP read back through G2's reader.
- **node:test:** the client-data check finds a planted real-looking camera serial, a coordinate outside the fictional site and a personal name in XMP.
- **CI:** the photo demo `--quick` builds under its budget (decision 6 of M8 style: about 60 MB or less bundled, or not bundled and generated on demand; see below).

**Risks:**

- Rendering cost in CI: a vectorised CPU renderer at 1600 x 1200 with 2 x supersampling is minutes, not hours, for 60 images; images are cached by seed and generator hash.
- Synthetic scenes are easier than real ones: the founder flight (decision 9) is the second gate.

**Founder test steps:**

- [ ] The library lists "Photo processing demo"; nothing in it names a client, a real site or a real camera.

## Contract changes (rows for `contract-changes.md`, written by G0 unless noted)

| Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Why                                                                          | Streams        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | -------------- |
| New `photogrammetry.ts`: `PhotoRun` (`aio.photo-run/1`, `<project>/photogrammetry/<run>/run.json`: `id`, `createdAt`, `photos`, `cameras` groups, `crs`, `verticalDatum`, `preset`, `stages[]` with status and timings, `outputs` (layer ids, tileset ids, files), `accuracy?` summary, `versions` (pack, COLMAP), `hardware`), `GcpFile` (`aio.gcp/1`: points with `role` `control` or `check`, `crs`, `xyz`, `accuracy`, marks per photo with `px`, `by`, `at`, `state` `draft` / `confirmed`, `predicted?`), `AccuracyReport` (`aio.photo-accuracy/1`), `HardwareProbe`, `PhotoEstimate`; data-conventions section 21 | Processing provenance outside the manifest, so older builds open the project | G2 to G5       |
| `PipelineName` gains `photo.align`, `photo.georef`, `photo.products`, `opf.import`, `opf.export`, `tiles.mesh`, `tiles.cloud`, `packs.imagery`, `packs.terrain` with their params; `PIPELINES` lists them; pipeline pack 0.4.0, `appRange` `>=0.10.0 <2.0.0`                                                                                                                                                                                                                                                                                                                                                             | Heavy work in the pack                                                       | G2, G3, G5, G7 |
| New `tilesets.ts`: `TilesetsFile` (`aio.tilesets/1`, `<project>/tilesets.json`), `TilesetEntry`; data-conventions section 22                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 3D Tiles without a new layer kind                                            | G7, G6         |
| New `globe.ts`: `GlobeSite`, `GlobeSettings` (`aio.globe-settings/1`, userData `globe.json`, not a `Settings` field), `RasterPackMeta` (`aio.raster-pack/1`) and `RasterPackInfo` (`MapPackInfo` unchanged; the data source is `provenance`); imagery and terrain packs in `packs/imagery/` and `packs/terrain/`; data-conventions section 23 (as built by G0)                                                                                                                                                                                                                                                           | Globe and raster packs without confusing older builds                        | G6, G7         |
| `ProjectManifest` reading (0.10 and later): layers of an unknown `kind` are kept as opaque entries on save and shown as "needs a newer Stratlas", instead of refusing the manifest                                                                                                                                                                                                                                                                                                                                                                                                                                       | Forward compatibility for the next additive layer kind in 1.x                | G0             |
| IPC: `photo:probe`, `photo:estimate`, `photo:runs`, `photo:readRun`, `photo:readGcp`, `photo:writeGcp`, `photo:applyPoses`, `photo:cleanWork`, `globe:sites`, `globe:packs`, `tilesets:list`, `tilesets:write`, `imageryPacks:*`, `terrainPacks:*`; `odm:*` only with decision 2                                                                                                                                                                                                                                                                                                                                         | Channels exist before their streams land (`not-implemented` stubs)           | all            |
| G4, not G0 (an existing enum): `ReportSectionId` gains `processing` (in `HOUSE_SECTIONS`); `EXPORT_FORMATS` gains `photo-report-pdf` mapped to the existing kind `report-pdf` (no new `ExportKind`)                                                                                                                                                                                                                                                                                                                                                                                                                      | Accuracy report in the house report and as a PDF                             | G4             |
| G5, not G0 (an existing enum): `ImportItem.kind` gains `opf` (builder import list only)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | OPF import                                                                   | G5             |
| `versions.ts` registry rows for `aio.photo-run`, `aio.gcp`, `aio.photo-accuracy`, `aio.tilesets`, `aio.raster-pack`, `aio.globe-settings`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 1.x upgrade policy                                                           | G0             |

The M9 risk applies again: `ReportContentsSettings` is strict over `ReportSectionId`, so settings saved by 0.10 with `processing` toggled are refused by an 0.9 build on the same machine (downgrade only; project data is unaffected). The upgrade notes say so.

## Synthetic test data

No client data: no client file, name, place, camera serial or path. Everything is seeded and procedural, at the existing fictional desert location (UTM zone 39N).

1. **The photogrammetry scene** (`photo_synth.py`): a textured 2.5D terrain (gentle slopes, a stockpile of known volume, a pit, a road), boxes (buildings, containers), two vertical cylinders (tanks) and a pipe rack. Textures are seeded multi-scale noise with random patterns, so features match like real ground; one water-like low-texture area and one repetitive-texture area (solar-panel rows) test the failure handling.
2. **GCP targets:** nine black-and-white square checker targets painted into the ground texture at surveyed positions (five control, four check), plus a planted GCP 6 whose stated coordinate is 1 m off.
3. **Cameras and flights:**
   - **Nadir grid:** 80% forward and 70% side overlap at 60 m with a 20 MP-class pinhole camera (rendered at 1600 x 1200 for `--quick` and full size for the nightly run), radial-tangential distortion with known coefficients.
   - **Oblique ring** around the tank for inspection-style meshes.
   - **Bad images:** one motion-blurred, one duplicate, one from another place (outlier), one corrupt JPEG, one without GPS.
4. **Metadata:** EXIF and DJI-style XMP written with piexif (dev dependency, MIT): `Make` "Stratlas Synthetic", `Model` "SYN-20", no serial, GPS with seeded noise per variant (standard 2.5 m, RTK 2 cm with `RtkFlag` 50 and standard deviations), `AbsoluteAltitude` with a seeded datum offset, `RelativeAltitude`, gimbal angles. A PPK CSV variant.
5. **Renderer:** a vectorised CPU z-buffer rasteriser in numpy with 2 x supersampling, no GPU and no OpenGL, so CI on Windows and macOS renders the same scene; outputs JPEG at a fixed quality.
6. **`truth.json`:** camera intrinsics and poses, target world positions and their pixel positions per image, the true height grid (DSM and DTM), the true mesh as GLB, the stockpile volume, and the expected registration list (which photos must be rejected and why).
7. **OPF fixtures:** the synthetic run exported by pyopf, plus a small hand-written OPF from the specification's examples (CC-BY-4.0, attributed in the fixture's README).
8. **Packs and tilesets:** a synthetic imagery GeoTIFF and its PMTiles pack (procedural colours, licence "CC0 test fixture"), a synthetic DEM and its terrain pack with a benchmark height, and the demo's mesh and cloud tilesets.
9. **The photo demo project** (bundled or generated on first use, decided by size): photos (quick set), GCP CSV, a precomputed alignment, so UI tests and the founder can mark GCPs without waiting for alignment.
10. **The client-data check** runs on all of it in CI.

## Merge order

1. **G0 contracts** (serial). Decisions 1 to 3 taken. Tag `contracts-m10`.
2. **G8 synthetic data:** every pytest and e2e test needs it; the generator lands first, the demo project second.
3. **G1 native builds and licence gate:** pycolmap and OpenCV wheels are needed by G2 and G3's tests in CI. The licence gate lands with the first native artifact.
4. **G6 Globe spike** (day one, in parallel with G1): it gates the CSP question and decision 3's cost. G6 itself merges after G7's pack formats.
5. **G2 alignment and georeferencing.**
6. **G7 imagery, terrain and 3D Tiles:** pack formats and `tilesets.json` before G6 and G3's tiles step.
7. **G3 products:** needs G2's sparse model and G7's `tiles.mesh`.
8. **G4 Builder UI:** needs G2 and G3 pipelines; can develop against stubs and the precomputed demo alignment from G8.
9. **G6 Globe view:** needs G7's providers and tilesets and G3's outputs for its best demo.
10. **G5 OPF** (and the ODM adapter if decision 2): last, it reads and writes what G2 and G3 produce, and touches `pyproject.toml` after the others.

The integration lead merges when green, re-locks `uv.lock`, builds pipeline pack 0.4.0 and the 0.10.0 installers, and runs the smoke checks below.

## Integration follow-ups (after all streams)

- **House report:** the `processing` section (accuracy summary, GCP table, overlap map); orthos from processing in the site overview figures.
- **Packages (X1):** carry `photogrammetry/<run>/run.json`, `gcp.json`, reports and `tilesets.json` with `tiles/`; never `photogrammetry/<run>/work/`; customer imagery packs only when ticked (decision 12). Player mode shows the Globe for the package's site and never starts processing.
- **Journal (M9):** `photogrammetry/` writers and `tilesets.json` writes go through the journal service; jobs record `via.pipeline` as today.
- **Change detection (M8):** two processed surveys of the same site run `change.raster`, `change.surface` and `change.cloud` directly; the Globe shows change heat maps as imagery layers.
- **Agent:** `process_photos` (write, approval; starts `photo.align` with a preset), `accuracy_summary` (read), `show_on_globe` (navigate) in the compact profile.
- **Performance (D7):** a 500 M point cloud and a 20 M triangle mesh tileset hold the Medium budget in the site view; the Globe holds 30 fps on the Medium tier with three sites and two region packs.
- **Accessibility (D6):** axe on the wizard, GCP marker, report and Globe chrome; keyboard GCP marking.
- **Diagnostics (D5):** pack version, native build ids, hardware probe, last run timings and memory peak; never photo paths or coordinates.
- **macOS:** notarised native tools; Accelerate sparse in Ceres; the Globe on Apple silicon GPUs.
- **User guide (D8):** chapters on processing photos, GCPs and accuracy, the Globe, imagery and terrain packs (with each source's licence), OPF; screenshots from e2e on synthetic data only.
- **Docs:**
  - `ROADMAP.md`: the M10 row and status.
  - `PRD.md`: the non-goal change and PHO and GLB lines.
  - `SPEC.md`: `packages/globe`, `packages/tiles`, section 7 (pack native tools).
  - Data-conventions sections 21 to 23.
  - `KNOWN-LIMITS.md`: CPU dense is slower than GPU products; Fast preset weak on buildings; no LiDAR processing; no true-ortho on tall structures in Fast; the Globe has no editing tools; imagery packs are 10 m, not sub-metre, unless the customer imports their own.
  - `THIRD-PARTY-NOTICES.md` with the native and data sections; `SECURITY-AND-DATA.md` (the Globe makes no requests; pack downloads are explicit).
- **TESTING.md:** stage M10 from the founder steps above.
- **Smoke tests on the founder machine:** the founder's nadir flight with GCPs end to end (Standard), the oblique flight (mesh), OPF round trip, the Globe offline with the GCC packs, and the zero-network suite. Client data stays on the founder's machine and never enters the repo, CI or fixtures.

## Exit

- On the founder's machine, with Wi-Fi off:
  - the photo demo processes end to end on CPU with checkpoint RMSE within the targets, and the founder's real flight processes with an accuracy report the founder accepts against the delivered product;
  - the outputs open in the existing viewers (ortho on the map, DSM in volumes and change, COPC and mesh in 3D) and in the Globe;
  - an OPF export opens in another OPF reader, and an OPF import opens in Stratlas;
  - the Globe shows every library project over offline imagery and terrain, with attributions, and hands over to the site view.
- The licence gate covers npm, Python and native libraries and data packs, and reports nothing forbidden; `THIRD-PARTY-NOTICES.md` lists every native library and data source.
- CI is green on Windows and macOS (Vitest, Playwright `--workers=1` off-screen, pytest, `pack-native`), including the zero-network suite with the Globe open.
- Pipeline pack 0.4.0 and the 0.10.0 installers (or 1.1.0, decision 11) are built within the size budgets of decision 6. Stage M10 of `docs/TESTING.md` is written, with every PHO and GLB line checked by a test or a screenshot.

### Critical files for implementation

- `E:\Dev\AIO Software\packages\schema\src\layers.ts` and `manifest.ts`: why M10 adds no layer kind (the discriminated union refuses unknown kinds in 0.9), and where tolerant parsing goes.
- `E:\Dev\AIO Software\packages\schema\src\jobs.ts` and `E:\Dev\AIO Software\python\src\aio_pipelines\runtime.py`: pipeline names, params, steps, resume and staging that the photogrammetry stages use.
- `E:\Dev\AIO Software\python\src\aio_pipelines\aik\cameras.py`: the EXIF and DJI XMP reader G2 extends.
- `E:\Dev\AIO Software\python\src\aio_pipelines\pointcloud.py`: PDAL discovery (`<pack>/tools/pdal`), which G1 finally fills.
- `E:\Dev\AIO Software\tools\pipeline-pack\build.mjs`, `E:\Dev\AIO Software\tools\release\license-check.mjs`, `notices.mjs` and `E:\Dev\AIO Software\python\tests\test_licences.py`: the pack build and the licence gate G1 extends.
- `E:\Dev\AIO Software\apps\desktop\src\main\index.ts` (CSP) and `E:\Dev\AIO Software\packages\maps\src\packs.ts`, `E:\Dev\AIO Software\tools\maps\build-packs.mjs`: CesiumJS under the CSP, and the pack system extended to imagery and terrain.
- `E:\Dev\AIO Software\packages\engine\src\adapters\register.ts` and `raster.ts`: where the 3D Tiles adapter registers and why `cog` and `pmtiles` rasters still have no renderer (outputs use `kit-pyramid`).
