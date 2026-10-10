# GPU acceleration for photo processing

> 10 Oct 2026. Status: accepted by the founder on 10 Oct 2026 with every recommendation as written (see "Decisions needed from the founder"); written as a proposal. Nothing was installed, downloaded, built or changed to write it; the pack, the pipelines and the app are as they were. It supersedes the "deferred to M10.1" part of decision 5 in `docs/architecture/adr/0008-photogrammetry-engine.md` once the founder has decided the points under "Decisions needed". Every fact below carries one of three labels: **measured** (read from this workstation, the installed pack or the repository), **documented** (read from a named source on 10 Oct 2026) or **my estimate**.

## Summary for the founder

**What is proposed.** An optional **GPU add-on** for NVIDIA cards on Windows, delivered as a file and installed in Settings, Processing tools, beside the pipeline pack. It speeds up the two stages that can be sped up from prebuilt parts and without changing the method: matching photo pairs during alignment, and making depth maps. Every other stage stays on the CPU. A computer without the add-on, without an NVIDIA card, or with the GPU switched off works exactly as today.

**What it buys.** Matching is the one stage with a real measurement behind it: 54 of the 103 minutes of a Standard alignment of 1,003 photos on your workstation. I expect it to fall to 5 to 14 minutes. Depth maps have never been timed on a real flight, so I do not promise a number for a whole run. My estimate is 2 to 5 times faster overall for High and 1.5 to 3 times for Standard, and the first step of this plan is a two to three day spike that replaces the estimate with measurements. The "About 20 to 39 h" in the wizard is itself a planning figure scaled to your photo count, not a measurement.

**What it costs.** The spike, then six work packages that parallel sessions can take. A separate download of about 180 MB (about 0.5 GB installed, my estimate), outside the 1,150 MB pack budget. NVIDIA's runtime licence to accept. A GPU path that CI cannot run, so it is tested on your workstation with recorded results.

**Three things worth knowing before you decide.**

1. There is no official GPU build of COLMAP's Python package for Windows (the `pycolmap-cuda12` wheels are Linux only). A prebuilt GPU COLMAP for Windows does exist on conda-forge, the channel PDAL already comes from. It would add GPU bundle adjustment and COLMAP's own dense matcher, but it is about 1.5 GB of downloads, changes the method, and contains GPU SIFT code whose licence allows "educational, research and non-profit purposes" only. I recommend not starting there; the spike measures it so you can decide with numbers.
2. Part of the slowness has nothing to do with the GPU. Depth maps are made one photo at a time in a single Python process, and most of that time is our own array code around the matcher, not the matcher. Running that on several cores helps every computer, Macs included, and I recommend doing it first.
3. By NVIDIA's documentation your RTX 5070 Ti is supported by the runtime I propose, and its driver (591.86) is new enough; running it is the spike's first check. No registry or system setting has to change.

## Where things stand today

- **No GPU code runs anywhere in photo processing (measured).** The installed pack 0.5.0 reports `pycolmap 4.2.1`, `has_cuda False`; its OpenCV 5.0.0 reports zero CUDA devices and has no CUDA module in its build information. The pipelines switch the GPU off by hand at every point COLMAP offers it: `python/src/aio_pipelines/photo/colmap_io.py:633` and `:657` (features), `:672` and `:692` (matching), `:768` and `:769` (global positioning and bundle adjustment).
- **The app's CUDA probe checks nothing (measured).** `PhotoSystem.cuda` is optional (`apps/desktop/src/main/photogrammetry.ts:82`), `readProbe` answers `false` when it is absent (`:155`), and the real system object never defines it (`nodePhotoSystem`, `:178` to `:202`; built in `apps/desktop/src/main/index.ts:1273`). So `HardwareProbe.cuda` is always `false`. `vramBytes` is in the contract (`packages/schema/src/photogrammetry.ts:146`) and is never filled: `gpusFromInfo` (`photogrammetry.ts:134` to `:148`) sets a name and a vendor only.
- **The Python side refuses the GPU by name (measured).** `photo.products` accepts `dense: cuda` in the contract (`packages/schema/src/jobs.ts:671`) and answers "The GPU accelerator is not in this pipeline pack" (`python/src/aio_pipelines/photo/products.py:75` and `:249` to `:252`). The worker already reports `cuda` in its versions (`colmap_io.py:592`).
- **The branch points exist (measured).** The COLMAP worker runs in its own process and can use another interpreter (`AIO_COLMAP_PYTHON`, `colmap_io.py:57` and `:330`). The dense matcher sits behind an interface (`Matcher`, `make_matcher`, `python/src/aio_pipelines/photo/dense.py:193` and `:443`). Depth maps are saved one file per photo and a resume skips finished ones (`products.py:424` to `:427`), so a stage can change engine half way without losing work.
- **Your workstation (measured, 10 Oct 2026):** NVIDIA GeForce RTX 5070 Ti, 16,303 MiB, compute capability 12.0, driver 591.86, which reports CUDA 13.1. 6.9 GB of the card's memory was already in use by desktop programs when I looked, so any budget has to come from free memory, not total.

## Findings

### 1. Where the time goes

**The wizard's figure is not a measurement.** `estimateRun` scales reference times from the M10 plan (`REF`, `photogrammetry.ts:273` to `:282`: High 600 to 1,200 minutes for 500 photos of 20 MP on 8 cores), which that plan calls "planning estimates to be replaced by G3's measurements" (`docs/plans/2026-10-07-m10-globe-and-photogrammetry.md:239`). They were never replaced. Worked backwards, "About 20 to 39 h" is what the formula gives for about 1,000 photos of 20 MP on 12 cores with every product ticked (my reconstruction: 600 x 2.22 x 0.72 x 1.22 = 1,180 minutes). With `cuda` true the same formula would print 4 to 8 h from `REF.minutes.highCuda`, a five times gain nobody has measured.

**Alignment (`photo.align`): measured.** One real flight of 1,003 photos of 20 MP, Standard preset, on this workstation, CPU only, other test suites running at the time (`docs/plans/2026-10-07-m10-g2-engine-comparison.md:76` to `:91`):

| Stage                | Library doing the work today                                   | CPU-bound              | Time (measured) | Share |
| -------------------- | -------------------------------------------------------------- | ---------------------- | --------------- | ----- |
| Reading the photos   | Our Python (EXIF, XMP)                                         | Yes, and disk          | 67 s            | 1%    |
| Feature extraction   | COLMAP SIFT through pycolmap, at most 8 threads                | Yes                    | 4.2 min         | 4%    |
| Matching             | COLMAP SIFT matcher and geometric verification, 24 threads     | Yes                    | 54 min          | 52%   |
| Sparse model         | COLMAP global mapper; Ceres with CHOLMOD for bundle adjustment | Yes; 13.2 GB of memory | 43 min          | 42%   |
| Georeference, report | Our Python (`bundle.py`, numpy and SciPy)                      | Yes                    | 31 s            | 1%    |
| **Whole alignment**  |                                                                |                        | **1 h 43 min**  |       |

The same shape shows on a 110-photo subset after the fixes (features 27 s, matching 333 s, sparse model 86 s). For **High** there is no measurement. My estimate for the same flight is 3 to 4.2 hours: features about 32 minutes (16 photos took 30.2 s at full size on 8 threads, same document, line 72), matching 1.4 to 2 hours (12,288 features per photo instead of 8,192, `python/src/aio_pipelines/photo/align.py:96` to `:101`), sparse model 1 to 1.6 hours.

**Products (`photo.products`): not measured on a real flight.** No run folder with products exists in the data folder (I looked, read only). The only timings are the G3 spike on small synthetic photos (`2026-10-07-m10-globe-and-photogrammetry.md:252` to `:263`: OpenCV `StereoSGBM` 0.06 s per pair at 1280 x 960) and the progress weights the code plans with (`products.py:294` to `:311`), which are an assumption, not a result:

| Stage                 | Library doing the work today                                                                  | CPU-bound                             | Share by the code's own weights |
| --------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------- |
| Depth maps (`dense`)  | Our rectification and back-projection in numpy and SciPy around OpenCV `StereoSGBM` (3-way)   | Yes; one photo at a time, one process | 29%                             |
| Fusion (`fuse`)       | Our numpy                                                                                     | Yes; one process                      | 9%                              |
| Point cloud (`cloud`) | PDAL (`filters.smrf`, `writers.copc`)                                                         | Yes                                   | 6%                              |
| DSM and DTM           | Our numpy and rasterio; PDAL for the ground filter                                            | Yes                                   | 9%                              |
| Orthomosaic           | Our numpy and rasterio                                                                        | Yes; one process                      | 18%                             |
| Mesh                  | MeshLab's screened Poisson (`pymeshlab`) in a child process, OpenMP                           | Yes; several cores                    | 12%                             |
| Texture               | Our numpy (per-face best view), or the ortho draped on a 2.5D mesh; no `texrecon` in the pack | Yes                                   | 9%                              |
| 3D Tiles              | `tiles.mesh`                                                                                  | Yes                                   | 6%                              |

Fast has no depth maps at all (`SCALE`, `products.py:71`), so a GPU has nothing to do there.

**What the code says about depth maps (my estimate from reading it, not timed).** For each photo and each of its two partners, `depth_map` builds two full-size coordinate maps in float64, warps both photos with `scipy.ndimage.map_coordinates`, runs the matcher, turns every matched pixel into a 3D point and projects it back through a z-buffer (`dense.py:150` to `:168`, `:452` to `:461`, `:485` to `:529`). Only the matcher uses more than one core. At High (20 MP, up to 320 disparities) I estimate 40 to 80 s per photo for depth maps and 10 to 20 s for fusion, of which the matcher itself is perhaps a fifth. For 1,003 photos that is 14 to 27 hours, which is at least consistent with the wizard's figure. Two consequences:

- Moving only the matcher to a GPU would gain little. The whole per-photo chain has to move, or the loop has to run in several processes.
- Running the loop in 8 processes should gain 4 to 6 times on any computer with the memory for it, with no GPU and no new dependency.

### 2. What can run on a GPU without building native code

Prebuilt for Windows x64 today, yes or no:

| Stage                          | GPU route                                                                                   | Prebuilt for Windows x64                                                                                                                                                                                                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any COLMAP stage, from PyPI    | A CUDA `pycolmap` wheel                                                                     | **No.** `pycolmap` 4.2.1 on PyPI is built with CUDA, ONNX and the GUI off on Windows and macOS. `pycolmap-cuda12` 4.2.1 exists (29 Sep 2026, 72.9 MB) for Linux x86_64 only; its page says the CUDA wheels are for Linux only for now. It needs the CUDA 12 runtime and cuRAND from NVIDIA's wheels, not bundled. (Documented.) |
| Any COLMAP stage, conda-forge  | `colmap` 4.2.1 `cuda_129` (CUDA 12.9, 174.2 MB) or `cuda_134`                               | **Yes**, uploaded 30 Sep 2026. Built with CUDA and ONNX on, every CUDA architecture, Qt, FAISS with CUDA, and a GPU build of Ceres. `pycolmap` on conda-forge has CUDA builds for Windows too, but only up to 4.2.0. (Documented from the package metadata; not run.)                                                           |
| Any COLMAP stage, official zip | `colmap-x64-windows-cuda.zip` 4.2.1 (414.7 MB)                                              | **Yes**, a command-line program built against CUDA 13.2 for Turing to Blackwell cards; of NVIDIA's libraries it ships only the CUDA runtime and cuRAND. (Documented.)                                                                                                                                                           |
| Feature extraction             | COLMAP's SiftGPU                                                                            | Yes, inside both GPU builds above. Its licence allows "educational, research and non-profit purposes" only. It is 4% of a Standard alignment. (Documented.)                                                                                                                                                                     |
| Matching                       | COLMAP's SiftGPU matcher                                                                    | Yes, inside both GPU builds above; same licence.                                                                                                                                                                                                                                                                                |
| Matching                       | Our own matcher on GPU arrays (CuPy)                                                        | **Yes.** `cupy-cuda12x` 14.2.0 (20 Aug 2026) has a Python 3.13 Windows wheel of 98.8 MB, MIT; `cupy-cuda13x` 36.0 MB. pycolmap 4.2.1 can read descriptors, write matches and verify them (`Database.read_descriptors`, `write_matches`, `verify_matches`: measured in the installed pack).                                      |
| Bundle adjustment              | Ceres with CUDA and cuDSS (`ceres.use_gpu`)                                                 | **Only through conda-forge.** Its Windows `ceres-solver` GPU builds depend on `libcudss`, cuBLAS, cuSOLVER and cuSPARSE, and its GPU `colmap` requires them. The PyPI wheel and the official zip build Ceres without CUDA (COLMAP's `vcpkg.json`). (Documented; not run.)                                                       |
| Bundle adjustment              | Caspar, COLMAP 4.1's GPU solver (its notes claim ten to a hundred times over Ceres on CUDA) | **Only by building from source.** `CASPAR_ENABLED` is off by default and no prebuilt build turns it on. (Documented.)                                                                                                                                                                                                           |
| Depth maps                     | COLMAP PatchMatch stereo (CUDA only)                                                        | Yes, inside both GPU builds above. It is a different method from ours, so products change. Its speed at full size is unknown here.                                                                                                                                                                                              |
| Depth maps                     | Our own chain (rectify, semi-global matching, back-project) on GPU arrays                   | **Yes**, with CuPy as above. `dense.py` already holds a pure numpy matcher (`NumpySgm`, `:364` to `:396`) written as array operations.                                                                                                                                                                                          |
| Depth maps                     | OpenCV's CUDA stereo matchers                                                               | **Only by building from source.** The PyPI wheels are CPU only by their own description. (Documented, and measured in the pack.)                                                                                                                                                                                                |
| Fusion, DSM, ortho             | Our own numpy code on GPU arrays                                                            | Yes, the same way, later.                                                                                                                                                                                                                                                                                                       |
| Point cloud, DTM               | PDAL                                                                                        | No GPU path.                                                                                                                                                                                                                                                                                                                    |
| Mesh, texture                  | Poisson, our texturing                                                                      | None found as a prebuilt package. I did not search beyond the packages named here.                                                                                                                                                                                                                                              |

The stages where the honest answer is "only by building from source" are Caspar bundle adjustment, OpenCV CUDA and (next section) AMD's HIP build. That conflicts with the standing rule of 8 Oct 2026 and is decision 1, not an assumption.

### 3. RTX 50-series and other NVIDIA cards

- **RTX 50 (Blackwell, compute capability 12.0).** CUDA Toolkit 12.8 is the first with Blackwell support (documented, NVIDIA). CuPy compiles its kernels on the user's machine with NVIDIA's runtime compiler, so that compiler must be 12.8 or later: I propose the 12.9 wheels (`nvidia-cuda-nvrtc-cu12` 12.9.86, `nvidia-cuda-runtime-cu12` 12.9.79). CuPy 14 lists CUDA 12.0 to 12.9 and 13.0 to 13.2 as supported and needs nothing but the graphics driver when the runtime comes from wheels (documented).
- **Drivers.** A CUDA 12 runtime needs driver 525 or later and a CUDA 13 runtime 580 or later (documented, NVIDIA's minor version compatibility table). Cards of the 50-series need the 570 branch or later in any case (CUDA 12.8 pairs with 570.65 on Windows). Your 591.86 is the branch of CUDA 13.1, so both lines run. conda-forge's `cuda_134` builds need a driver that reports CUDA 13.4 (branch 615), which yours does not; its `cuda_129` builds are the ones that install today.
- **Known problems.** COLMAP's PatchMatch gave empty depth maps on Blackwell cards until 4.0.0 (pull request 4161, merged 5 Mar 2026; listed again in the 4.1.0 notes), so nothing older than 4.1 may be used; 4.2.1 is fine. COLMAP's FAQ warns that long dense kernels on the card that drives the display trip Windows' driver watchdog, and suggests a registry change; we never ask a customer for that, so our own kernels must stay short (work in bands). PyTorch wheels built before CUDA 12.8 lack Blackwell kernels (from memory, not checked today; we do not propose PyTorch).
- **20, 30 and 40-series.** Supported by both the CUDA 12.9 and 13 runtimes. **GTX 10-series** (Pascal) only by CUDA 12: CUDA 13.0 dropped the Maxwell, Pascal and Volta generations (documented).
- **Memory on the card (my estimate, to be measured).** Our matcher needs about 0.3 GB at 8,192 features per photo and 0.6 GB at 12,288, a few times that with working copies. Depth maps work in row bands sized to the free memory, as the numpy matcher already does for main memory: about 5 MB per image row at Standard and 21 MB at High. So 4 GB free is the floor (narrow bands, slower), 8 GB the recommendation, in line with the M10 hardware table; below the floor the GPU is not used. COLMAP's PatchMatch at full size is likely to need far more and is tuned by `max_image_size` and `cache_size` (32 GB of main memory by default: measured in the pack's options).

### 4. Other GPUs and platforms

- **AMD and Intel on Windows.** CuPy's AMD wheels (`cupy-rocm-7-0`) are Linux only and marked experimental. COLMAP 4.2's AMD PatchMatch is a build option (`HIP_ENABLED`), not in any prebuilt package. `colmap-cl`, an OpenCL port, was last touched in January 2022 and has no licence that GitHub detects. The pack's OpenCV has OpenCL switched on (measured: "OpenCL: YES"), but its semi-global matcher has no OpenCL path that I know of (not checked today). So there is no prebuilt path today.
- **Apple silicon.** No CUDA. The macOS `pycolmap` wheel is CPU only; COLMAP 4.2's CoreML support is for learned features through ONNX, which the wheel is built without. No prebuilt path today.
- **A route that would cover all of them later.** Our own array code could run on a second backend: PyTorch with Metal on Macs, or compute shaders through `wgpu` (BSD-2-Clause, a 3.5 MB Windows wheel, Direct3D 12, Vulkan and Metal). Both are prebuilt, both mean more of our own code, and neither is worth planning before the spike shows how much the GPU gains over several CPU processes.
- **Recommendation: NVIDIA on Windows x64 first**, with the array code written so a second backend can be added, and CPU parallelism for everyone else. Decide on Macs, AMD and Intel after the first measured release.

### 5. Packaging and delivery

**Sizes (documented wheel and package sizes; installed sizes are my estimate until the spike measures them):**

| Parts                                                                                                                                                                                   | Download     | Installed (estimate) |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | -------------------- |
| Lean add-on, CUDA 12.9: CuPy 98.8 MB, runtime compiler 76.4 MB, CUDA runtime 3.6 MB                                                                                                     | about 180 MB | 0.4 to 0.6 GB        |
| Lean add-on, CUDA 13: CuPy 36.0 MB, runtime compiler 47.0 MB, CUDA runtime 2.8 MB                                                                                                       | about 86 MB  | 0.2 to 0.3 GB        |
| The same plus cuBLAS (needed only if the matcher uses floating-point matrix products): 553.2 MB                                                                                         | about 730 MB | 1.2 to 1.5 GB        |
| COLMAP GPU environment from conda-forge: `colmap` 174, cuBLAS 461, cuSPARSE 206, cuSOLVER 198, ONNX Runtime 157, FAISS 96, cuDSS 89, Qt 59, runtime compiler 58, cuRAND 49 MB, and more | over 1.5 GB  | 3 to 4.5 GB          |
| Official COLMAP CUDA zip                                                                                                                                                                | 414.7 MB     | not known            |

The main pack is at about 1,106 MB of its 1,150 MB (`tools/release/budgets.mjs:35` to `:40`), so it has 44 MB to spare.

| Option                                       | For                                                                                                                                                 | Against                                                                                                                                                                                          |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| (a) Separate optional add-on beside the pack | The main pack and its budget do not move; only NVIDIA owners carry it; the NVIDIA licence stays in one optional file; it can be released on its own | One more thing to build, version, sign and install; it must match the pack's Python and numpy                                                                                                    |
| (b) A second full "GPU pack"                 | One folder to install                                                                                                                               | 1.3 to 1.7 GB; doubles the build, signing and test matrix; a GPU user replaces the whole pack for every pack release; two packs that can drift apart                                             |
| (c) Fold it into the main pack               | Nothing extra to install                                                                                                                            | The budget rises by 0.4 to 0.6 GB for everyone; dead weight on every computer without an NVIDIA card; the Mac packs cannot have it; NVIDIA's proprietary DLLs join a pack that is GPL as a whole |

**Recommendation: (a)**, with its own budget, set from the spike (proposal: 600 MB installed, 250 MB as an archive).

**How it would work.**

- **Shape.** A folder `<data folder>/runtime/pipeline-addon-cuda-<version>/` with its own `manifest.json` (`aio.pipeline-addon/1`: kind, version, the pack versions it fits, Python version, platform, CUDA runtime version, minimum driver, and every file's size and SHA-256, as the pack has). The pack's folder pattern (`apps/desktop/src/main/jobs/pack.ts:14`) does not match it, so an old app ignores it. It is built by a new `tools/pipeline-pack/accelerator.mjs` from a pinned, hashed lock of wheels: nothing is compiled, and no GPU is needed to build it.
- **Install.** Through the "install or update from file" flow of `feat/pipeline-pack-install`, as a second kind of file: the same checks (archive, manifest, hashes, version range), then a self-test. Until that branch lands, by copying the folder, as the pack is installed today.
- **Detect and validate.** The app looks for the newest add-on that fits the installed pack, then asks the pack's Python to run a self-test with a time limit: load CuPy from the add-on, name the card, driver, compute capability and free memory, compile one kernel, run it and compare with numpy. The answer (ready, or why not, in words) is cached with the probe. This is what `system.cuda()` was reserved for.
- **Isolation.** GPU work runs in a worker process of its own, as COLMAP does today. A driver fault cannot take the job down, the card's memory is released when the stage ends, and NVIDIA's DLLs never share a process with the pack's GPL libraries.
- **Falling back to the CPU, cleanly:**
  - _Add-on missing, DLL missing, import error:_ the self-test fails, `cuda` is false, the wizard says why, the run uses the CPU.
  - _Driver too old or card not supported:_ the self-test reports the driver it found and the one it needs; CPU.
  - _Out of card memory mid-run:_ the worker frees its pool, halves the band and retries once; if that fails, that photo is done on the CPU and the run goes on. The run records how many photos fell back.
  - _A GPU stage failing (driver reset, device lost, worker crash):_ the stage restarts on the CPU from the last finished photo or pair. Finished depth maps and matches are kept, so no work is lost. The run carries a warning in plain words.
- **NVIDIA's terms (documented, CUDA EULA version 13.4, updated 26 Jan 2026).** The CUDA runtime, the runtime compiler, cuBLAS, cuSOLVER, cuSPARSE, cuRAND and cuFFT are on the list of files that may be redistributed, provided the application adds substantial functionality of its own, the files are used only by our application, a notice is included and our terms protect NVIDIA no less. cuDSS and cuDNN are not in that document and have their own licences; they matter only for the conda-forge route. The PyPI wheels are tagged "NVIDIA Proprietary". The third-party notices must gain an add-on section, generated from the add-on's lock.

### 6. Correctness

GPU and CPU runs will not be bit-identical, and neither are two CPU runs: COLMAP is seeded but runs on many threads. So "the same result" needs three parts.

1. **The same targets against truth.** A GPU run must pass the quality targets the CPU run already has to pass on the synthetic set (`2026-10-07-m10-globe-and-photogrammetry.md:314` onwards and the G3 tests): 98% of photos registered, reprojection error under 1 px, checkpoints within 1.5 x GSD horizontally and 2.5 x GSD vertically, 95% of the dense cloud within 3 x GSD with over 90% completeness, DSM error under 3 x GSD, the stockpile volume within 2%, ortho targets within 2 x GSD, the mesh within 4 x GSD at the 95th percentile.
2. **A bounded difference from the CPU run on the same photos** (proposed tolerances; the spike first measures how far two CPU runs differ and widens these if the noise is larger):
   - Alignment: the same photos registered on the synthetic set, within 1% on a real flight; mean reprojection error within 0.05 px; checkpoint RMSE within 0.25 x GSD; camera centres within 1 x GSD after a similarity fit.
   - Surface: over cells both runs filled, a median height difference under 0.5 x GSD and a 95th percentile under 2 x GSD; filled area within 2 percentage points; the stockpile volume within 0.5%.
   - Ortho: control targets within 1 x GSD of the CPU run's.
3. **Stage-level equivalence where it can be exact.** The GPU depth-map chain is the numpy chain with another array library, in integer arithmetic for the matching itself, so on the same rectified pair its disparities should equal the numpy matcher's on at least 99.9% of pixels. The GPU matcher compares the same descriptors with the same thresholds as COLMAP (`max_ratio` 0.8, `max_distance` 0.7, cross check: measured in the pack). COLMAP's CPU matcher searches an index by default instead of comparing every descriptor (`cpu_brute_force_matcher` false, measured), and that search may be approximate (my understanding, not checked), so an exact GPU matcher should find the same pairs with the same or slightly more matches. The spike counts them pair by pair.

One honest difference to record: today's production CPU matcher is OpenCV's, and the GPU chain follows our numpy matcher. The G3 spike found the two within a point of each other against truth (99.4% and 99.1% within 3 x GSD), so parts 1 and 2 are the test, not pixel equality with OpenCV. Each run records which engine made each stage, and how many photos fell back, in `run.json` and the products report.

**Testing without a GPU in CI.**

- **The same code on numpy in CI.** The array code is written once against an array module. CI runs it with numpy on every push; the CuPy cases are the same tests, skipped where no card is found. So a logic error is caught without a GPU, and only "CuPy behaves like numpy here" is left to the workstation.
- **Fallbacks in CI with a fake backend** that raises out-of-memory, a missing DLL and a device loss at chosen points; the tests assert the run finishes on the CPU, keeps finished photos and records the warning.
- **A bench script run by hand on your workstation** before each add-on release (and after each pack release): the synthetic full set through Standard and High, CPU then GPU, checked against parts 1 to 3, with the times and metrics written to `docs/release/gpu-bench/<date>-<card>.json` and committed. Synthetic data only, so nothing private enters the repository.
- **No self-hosted runner while the repository is public.** GitHub's own guidance is that self-hosted runners should almost never serve a public repository, because a pull request from anyone could run code on your workstation.

### 7. App changes

- **Probe.** `nodePhotoSystem` gains `cuda()`: find the add-on, run the self-test through the pack, cache the answer. The card's memory comes from the self-test. `HardwareProbe` gains an optional `accelerator` (state, version, reason in words, driver); `cuda` keeps its meaning (ready and not switched off). In passing: the probe reports 12 cores for this 16-core CPU because it halves the 24 threads (`photogrammetry.ts:189` to `:192`); that does not matter here.
- **Estimate.** `REF.minutes.highCuda` and the "High only" rule (`photogrammetry.ts:308`) go. The estimate takes measured gains per stage from the bench results, for Standard and High, and the M10 reference times are replaced by the spike's CPU measurements. The note "High runs on the CPU here: expect a long run" (`:342`) stays for computers without the add-on.
- **Wizard wording.** `gpuLine` and `processingLine` (`apps/desktop/src/renderer/photogrammetry/hardware.ts:8` and `:31` to `:40`) are being reworded to a neutral "not available yet" on `feat/simple-jobs-photo-maps`; this work builds on that. Once the add-on exists the lines are, for example: "NVIDIA GeForce RTX 5070 Ti, 16 GB: used for matching and depth maps", "NVIDIA GeForce RTX 5070 Ti: the GPU add-on is not installed. CPU only.", "The GPU add-on needs graphics driver 570 or later (found 551). CPU only.", "GPU use is switched off in Settings. CPU only." Never a promise of a time.
- **A switch.** Settings, Processing tools: **Use the graphics card for photo processing** (on by default when the add-on passes its self-test). It is stored in its own file in the user profile (`processing.json`, `aio.processing-settings/1`), not in `settings.json`, which keeps its 0.9 keys (the rule of `docs/plans/2026-10-08-launch-screen.md`, decision 3). `QUADRION_PHOTO_GPU=0` overrides it for tests. The choice reaches the jobs as environment variables beside `AIO_PHOTO_MEMORY_MB` (`photoJobEnv`, `photogrammetry.ts:228`), so `photo.align` needs no new parameter; `photo.products` already has `dense`.
- **Processing tools.** The pack's row gains a second row: GPU add-on, its version or "not installed", the card and driver found, **Install from file**, **Remove**, **Test**.
- **Progress and logs.** The stage's first log line names the device ("Depth maps on NVIDIA GeForce RTX 5070 Ti, 9.2 GB free, GPU add-on 0.1.0"). A fallback is a warning in the log and in the run. The Jobs panel and stage names do not change. The diagnostics bundle carries the add-on state with the probe.
- **Hardware tiers.** The M10 table's recommendation stands and becomes real: NVIDIA RTX with 8 GB for Standard and High, 4 GB as the floor, no GPU needed. (The Low, Medium and High graphics tiers of the viewer are a different thing and do not change.)

### 8. Expected gain

On your workstation, for the measured flight shape (about 1,000 photos of 20 MP):

| Stage                                        | Today                                          | With the recommended scope                                      | Basis                                                                                                                                                |
| -------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Features                                     | 4.2 min (measured)                             | Unchanged                                                       | Not worth a GPU: 4% of alignment                                                                                                                     |
| Matching, Standard                           | 54 min (measured)                              | 5 to 14 min (my estimate)                                       | 22,648 pairs; a few milliseconds per pair on the card plus verification on the CPU; assumes descriptor comparison, not verification, dominates today |
| Sparse model                                 | 43 min (measured)                              | Unchanged                                                       | GPU bundle adjustment needs the conda-forge route (decision 5); my estimate there is 1.3 to 2.5 times, low confidence                                |
| **Alignment, Standard**                      | **103 min (measured)**                         | **54 to 63 min: 1.6 to 1.9 times**                              |                                                                                                                                                      |
| Alignment, High                              | 3 to 4.2 h (my estimate)                       | 1.7 to 2.6 h (my estimate)                                      | Same reasoning, more features per photo                                                                                                              |
| Depth maps and fusion                        | Not measured; 14 to 27 h at High (my estimate) | 5 to 15 times on these two stages (my estimate, low confidence) | The whole per-photo chain on the card; reading and writing files stay on the CPU                                                                     |
| Depth maps, CPU processes only               | The same                                       | 4 to 6 times with 8 processes (my estimate)                     | No GPU; memory allows it on 64 GB                                                                                                                    |
| Cloud, DSM, DTM, ortho, mesh, texture, tiles | Not measured                                   | Unchanged                                                       |                                                                                                                                                      |

**Overall.** If depth maps and fusion are the share `s` of a run and gain `k` times, the run gains `1 / ((1 - s) + s / k)`. With `s` between 0.5 and 0.8 and `k` of 8, that is 1.8 to 3.3 times; with the matching gain on top, my estimate is **2 to 5 times for High and 1.5 to 3 times for Standard**. Confidence: medium for matching, low for everything else, because `s` has never been measured. I do not put a number of hours on your next High run.

**What the first spike measures:** `s` (seconds per stage at Standard and High on the CPU); how two CPU runs differ; the matcher's pairs per second on the card and its agreement with COLMAP's; seconds per photo for the depth-map chain on the card and on 8 CPU processes; peak memory on the card; the add-on's real size; and, separately, what GPU bundle adjustment and PatchMatch from conda-forge would add.

## Options and recommendation

| Option                                        | What it is                                                                                                                                                  | Verdict                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Lean add-on with our own array code**    | CuPy and NVIDIA's runtime wheels; GPU matching and GPU depth maps written once for numpy and CuPy; a CPU process pool for depth maps from the same refactor | **Recommended.** Prebuilt wheels only, about 180 MB, MIT plus NVIDIA's runtime, the same method as the CPU path, testable in CI on numpy. It leaves the sparse model on the CPU.                                                                                                                         |
| B. COLMAP's GPU build from conda-forge        | A second environment installed by micromamba from a pinned lock, as PDAL is; GPU features, matching, bundle adjustment and PatchMatch                       | Not first. Over 1.5 GB of downloads; SiftGPU's non-commercial licence is in the binary even if we never call it; NVIDIA's cuDSS in one process with GPL CHOLMOD; products change method; `pycolmap` there is 4.2.0, which has the mapper fault 4.2.1 fixed. Measured in the spike for bundle adjustment. |
| C. The official COLMAP CUDA zip               | COLMAP's command-line program beside the pack                                                                                                               | No. Built for CUDA 13.2 (GTX 16 and RTX 20 onwards only), no GPU bundle adjustment, the same SiftGPU question, a GUI program with Qt, and it adds nothing B does not.                                                                                                                                    |
| D. Build COLMAP or OpenCV with CUDA ourselves | Caspar bundle adjustment, OpenCV's CUDA matchers                                                                                                            | No, unless you lift the rule of 8 Oct 2026 (decision 1).                                                                                                                                                                                                                                                 |
| E. Do nothing on the GPU                      | Only the CPU process pool                                                                                                                                   | The fallback if the spike shows the card gains under two times over the pool.                                                                                                                                                                                                                            |

**Honest scope of the recommendation:** NVIDIA cards with 4 GB or more (8 GB recommended) on Windows x64, from the GTX 10-series to the RTX 50-series with the CUDA 12.9 runtime; presets Standard and High; stages matching (alignment) and depth maps, then fusion; everything else on the CPU. Macs, AMD and Intel cards get the CPU process pool only.

## Decisions needed from the founder

> **Decided, 10 Oct 2026.** The founder accepted every recommendation below as written ("go with the GPU plan recommendations"). In short: the prebuilt-only rule stays (1); NVIDIA on Windows x64 first (2); a separate add-on with its own budget (3); tested on numpy in CI plus a recorded bench on the founder's workstation (4); the lean add-on first, with COLMAP's GPU build decided later on the spike's numbers and a licence read (5); NVIDIA's runtime licence accepted for the add-on only (6); the CUDA 12.9 runtime (7); the CPU process pool for depth maps is part of this item and is the first work package (8); the spike may time a copy of one real flight (9); the GPU is on by default with a switch (10). The M10 Build stream takes the spike and the CPU process pool, since the photo pipelines and the pack build are its stream. The spike starts once the branches in flight on 10 Oct have landed: its timings need a quiet machine.

1. **May any native component be built from source if a stage has no prebuilt GPU path?** This would unlock Caspar bundle adjustment and OpenCV's CUDA matchers, and brings back a native build stage in CI. Options: keep the rule; allow one named component. **Recommended: keep the rule.** By default: kept; the sparse model stays on the CPU.
2. **NVIDIA on Windows x64 first?** Options: yes; wait for a route that covers every card. **Recommended: yes.** By default: yes, with the CPU process pool for everyone else.
3. **Separate add-on or a bigger main pack?** Options (a), (b), (c) of finding 5. **Recommended: (a), a separate add-on with its own budget (600 MB installed, 250 MB archived, to be confirmed by the spike).** By default: (a); the 1,150 MB budget does not move.
4. **How is the GPU path tested?** Options: the same code on numpy in CI plus a bench run by hand on your workstation with recorded results; a self-hosted runner. **Recommended: the first; no self-hosted runner while the repository is public.** By default: the first, and an add-on is released only with a bench result of the same week in the repository.
5. **Lean add-on first, or COLMAP's GPU build?** Option B gives GPU bundle adjustment and PatchMatch at the cost of size, SiftGPU's licence term (a restriction on use, a different kind of term from GPL) and NVIDIA's cuDSS beside GPL code. **Recommended: lean first; the spike measures B; decide B on those numbers, with a licence read first.** By default: A only; B is not built.
6. **Accept NVIDIA's runtime licence for an optional add-on?** Needed for every GPU option. **Recommended: yes, in the add-on only, with notices generated.** By default: nothing GPU ships until this is a yes.
7. **CUDA 12.9 or CUDA 13 runtime?** 12.9 covers GTX 10-series onwards and older drivers, about 180 MB; 13 covers RTX 20-series onwards with driver 580 or later, about 86 MB. **Recommended: 12.9 for the first release.** By default: 12.9.
8. **Is the CPU process pool for depth maps part of this item?** It is not GPU work, but it shares the refactor, sets the true baseline and helps every computer. **Recommended: yes, as the first work package.** By default: the spike measures it and it waits for your answer.
9. **May the spike time one real flight?** On a copy in the scratch folder, never in the data folder, reported by shape only. **Recommended: yes, the 1,003-photo flight already used for the G2 comparison.** By default: synthetic photos only, which gives rates per photo but not the shares of a large flight.
10. **GPU on by default once the add-on passes its self-test?** **Recommended: yes, with the switch in Settings.** By default: yes.

## Staged plan

### Step 0: feasibility spike

One session, two to three days, in its own worktree (branch `spike/gpu-acceleration`) for reading the code and for the one commit that adds the results to this file. Everything it installs and writes goes to a scratch folder outside the repository and the data folder: `E:\Scratch\gpu-spike`. It needs about 40 GB free there. It never writes to `E:\Stratlas Data` (the pack's PDAL is only read) and never changes the pack, the pipelines or the app. Starts only after the founder's go.

**Photo set:** the synthetic full set, 63 photos at 5280 x 3960 (20.9 MP: a nadir grid and an oblique ring, with truth for poses, control points, DSM and the stockpile volume), from `python/tests/photo_synth.py --full`. With decision 9, also a copy of one real flight.

**S0. Prepare (PowerShell, from the spike worktree).**

```powershell
$S = 'E:\Scratch\gpu-spike'
New-Item -ItemType Directory -Force $S, "$S\out" | Out-Null
nvidia-smi --query-gpu=name,driver_version,memory.total,memory.used,compute_cap --format=csv > "$S\out\gpu.csv"
cd python
$env:UV_PROJECT_ENVIRONMENT = "$S\venv"      # the environment lives in the scratch folder
uv sync --frozen                             # the locked pycolmap 4.2.1, OpenCV 5.0.0.93, pymeshlab
$py = "$S\venv\Scripts\python.exe"
& $py tests/photo_synth.py --out "$S\set-full" --full --variant rtk --workers 8 --cache "$S\render-cache"
$env:AIO_PDAL = 'E:\Stratlas Data\runtime\pipeline-pack-0.5.0\tools\pdal\Library\bin\pdal.exe'   # read only
```

**S1. CPU baseline: where the time goes.** Save the two scripts of "Spike scripts" below as `$S\bench_cpu.py` and `$S\profile_dense.py`, then:

```powershell
& $py "$S\bench_cpu.py" "$S\set-full\photos" "$S\out" standard
& $py "$S\bench_cpu.py" "$S\set-full\photos" "$S\out" high
& $py "$S\bench_cpu.py" "$S\set-full\photos" "$S\out" high 2      # a second High run: the CPU noise floor
& $py "$S\profile_dense.py" "$S\out\project-high-1" > "$S\out\dense-profile.txt"
```

Record: seconds and peak memory per stage (`cpu-<preset>-<n>.json`), the 25 most expensive functions of a depth map, the accuracy reports (`photogrammetry\spike\report\accuracy.json`, `products.json`), and the differences between the two High runs for every metric of "Correctness", part 2. With decision 9: the same two commands on the copied flight, Standard only, plus High for alignment alone.

**S2. Lean GPU arm.**

```powershell
uv pip install --python $py cupy-cuda12x==14.2.0 nvidia-cuda-runtime-cu12==12.9.79 nvidia-cuda-nvrtc-cu12==12.9.86
& $py -c "import cupy as cp; cp.show_config(); a = cp.arange(1 << 24, dtype=cp.int32); print(int((a * a % 7).sum()), cp.cuda.Device(0).mem_info)"
(Get-ChildItem "$S\venv\Lib\site-packages\cupy*", "$S\venv\Lib\site-packages\nvidia*", "$S\venv\Lib\site-packages\cuda*" -Recurse -File | Measure-Object Length -Sum).Sum / 1MB
```

Then two throwaway prototypes in the scratch folder, each a copy of existing code with the array library swapped:

- `match_gpu.py`: for every pair in a copy of `project-standard-1\photogrammetry\spike\work\database.db`, read both descriptor sets (`Database.read_descriptors`), find mutual nearest neighbours with COLMAP's ratio and distance thresholds on the card, first with integer products (no cuBLAS), then with floating-point products after `uv pip install nvidia-cublas-cu12==12.9.2.10`. Write the matches into a second copy with `write_matches`, run `pycolmap.verify_matches`, then the mapper. Record pairs per second for both variants, the time of verification alone, the overlap with COLMAP's own matches pair by pair, verified pairs, registered photos, reprojection error and checkpoint errors.
- `dense_gpu.py`: `dense.py` with `cupy` and `cupyx.scipy.ndimage` in place of numpy and SciPy, bands sized from the card's free memory. Run ten photos of the High project through `depth_map` on numpy (`NumpySgm`), on OpenCV and on the card. Record seconds per photo for each, the share of pixels where card and numpy agree, accuracy and completeness against the truth, and peak card memory (`nvidia-smi --query-gpu=memory.used --format=csv -l 1` in a second window).
- `dense_pool.py`: the same ten photos through today's `depth_map` in 4 and in 8 processes. Record seconds per photo and peak memory per process.

Also record which NVIDIA DLLs the process loaded after each prototype, so the add-on carries only those.

**S3. COLMAP GPU arm (for decision 5; measured, not adopted).**

```powershell
cd ..                                        # the worktree root
$mm = node -e "import('./tools/pipeline-pack/pdal.mjs').then(m => m.ensureMicromamba('E:/Scratch/gpu-spike/cache', 'win32-x64', () => {})).then(p => console.log(p))"
$env:MAMBA_ROOT_PREFIX = "$S\conda"
& $mm create -y -p "$S\colmap-cuda" -c conda-forge --dry-run "colmap=4.2.1=cuda_129*" > "$S\out\colmap-cuda-solve.txt"
& $mm create -y -p "$S\colmap-cuda" -c conda-forge "colmap=4.2.1=cuda_129*"
& $mm list -p "$S\colmap-cuda" --json > "$S\out\colmap-cuda-packages.json"
```

Record the solved list with sizes and licences and the installed size. Then, on copies of the High project's database and sparse model, with option names taken from `colmap <command> --help` (not verified here): bundle adjustment with Ceres on the CPU and with `use_gpu` on the card; `patch_match_stereo` on ten photos at full size and at half size. Record seconds, card memory, any driver reset, and the DSM against truth for the PatchMatch photos. SiftGPU is timed only if decision 5 asks for it.

**S4. Report.** A "Spike results" section added to this file: the measured tables for findings 1, 5 and 8, new reference times for `REF`, the tolerances of "Correctness" confirmed or changed, and go or no-go per stage. Then delete `E:\Scratch\gpu-spike`.

**Pass or fail.**

| Check                         | Pass                                                                                                                                                                                                                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The runtime starts            | CuPy imports and runs a kernel on the RTX 5070 Ti with driver 591.86, from wheels alone, with no CUDA Toolkit installed on the system                                                                                                                                      |
| Size                          | The lean add-on's files are 600 MB or less installed, without cuBLAS                                                                                                                                                                                                       |
| Matching                      | At least 10 times the CPU matcher's pairs per second; every pair COLMAP verified is still verified; the same photos registered; the alignment tolerances of part 2 hold                                                                                                    |
| Depth maps                    | At least 5 times faster per photo than today's single process at High, and at least 2 times faster than 8 CPU processes; at least 99.9% of pixels equal to the numpy matcher on the same pair; 95% within 3 x GSD of truth and completeness within 2 points of the CPU run |
| Card memory                   | Peak under 8 GB at High with bands; no driver reset in the whole spike                                                                                                                                                                                                     |
| Go for the add-on             | Matching passes, or depth maps pass. If depth maps gain under 2 times over the pool, the add-on carries matching only and the pool is the dense answer (option E for dense).                                                                                               |
| Information only (decision 5) | GPU bundle adjustment at least 2 times faster on the mapper's stage would justify looking further at option B                                                                                                                                                              |

### Work packages

Each is one session in its own worktree, handed to the orchestrator as usual. WP1 and WP2 can start together; WP3 and WP4 after both; WP5 after WP2; WP6 last.

| Package                                            | Scope                                                                                                                                                                                                                                                                   | Owns                                                                                                                                                                                                  | Depends on                                                                              |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| WP1 Array seam and CPU pool                        | `dense.py` and `fuse.py` written against an array module; depth maps and fusion in a pool of processes sized by cores and the memory cap; results unchanged on one process. Decision 8.                                                                                 | `python/src/aio_pipelines/photo/dense.py`, `fuse.py`, `products.py` (`_dense`, `_fuse`), new `photo/xp.py`, their tests                                                                               | Spike                                                                                   |
| WP2 Add-on format, build and loader                | `aio.pipeline-addon/1`; `tools/pipeline-pack/accelerator.mjs` from a hashed lock; its budget; notices; a CI job that builds and archives it on Windows; the Python loader and self-test (`python -m aio_pipelines.accel --selftest`); G0-style contract rows            | `tools/pipeline-pack/accelerator.mjs` and test, the add-on lock, `tools/release/budgets.mjs` and `notices.mjs`, new `python/src/aio_pipelines/accel.py`, `packages/schema` (rows)                     | Spike; decisions 3, 6, 7                                                                |
| WP3 GPU depth maps and fusion                      | A CuPy backend for WP1's seam in a worker process; bands from free card memory; out-of-memory and failure fallbacks; `dense: cuda` accepted when the add-on is ready, `auto` uses it; engine and fallbacks in the run                                                   | `photo/dense.py` (GPU matcher), new `photo/gpu_worker.py`, `products.py` (`validate`, `_dense`, `_fuse`, report)                                                                                      | WP1, WP2                                                                                |
| WP4 GPU pair matching                              | The matcher of the spike as a worker operation beside `_op_match`: descriptors from the database, matches written back, `verify_matches`, progress and cancel as today, fallback to COLMAP's matcher per chunk                                                          | `photo/colmap_io.py` (`_op_match`, engine), new `photo/gpu_match.py`, `test_photo_engine.py`                                                                                                          | WP2                                                                                     |
| WP5 App: probe, estimate, wording, switch, install | `cuda()` and card memory in the probe; the add-on in `findPack`'s neighbourhood; measured factors in `estimateRun`; wizard lines; `processing.json` and its two channels; the environment for jobs; the Processing tools row with install, remove and test; diagnostics | `apps/desktop/src/main/photogrammetry.ts`, `main/jobs/pack.ts`, `renderer/photogrammetry/hardware.ts`, `ProcessWizard.tsx`, the Settings panel of the pack install flow, their tests and one e2e spec | WP2; `feat/pipeline-pack-install` and `feat/simple-jobs-photo-maps` merged (same files) |
| WP6 Bench, docs and release                        | `python/bench/photo_gpu_bench.py` (the spike's scripts made permanent, synthetic only); first recorded result; guide, testing stage, known limits, ADR amendment, release notes                                                                                         | `python/bench/**`, `docs/release/gpu-bench/**`, the docs listed below                                                                                                                                 | WP3, WP4, WP5                                                                           |
| WP7 (only if decision 5 says so)                   | COLMAP's GPU build from conda-forge as a second add-on for bundle adjustment: `tools/pipeline-pack/colmap-cuda.mjs` on the model of `pdal.mjs`, a pinned lock, the worker pointed at it                                                                                 | New files only, plus `colmap_io.py` (`_op_map`)                                                                                                                                                       | WP2; a licence read of SiftGPU and cuDSS                                                |

### Contract changes

`@aio/schema` is frozen; every row below is additive and needs its line in `docs/architecture/contract-changes.md` before it merges. WP2 writes them in one go so the other packages build against them.

| Change                                                                                                                                                                                                                                                                                      | Why                                                       | Old readers                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------ |
| New `PipelineAddonManifest` (`aio.pipeline-addon/1`: `kind` `gpu-cuda`, `version`, `packRange`, `python`, `platform`, `runtime` with the CUDA version and minimum driver, `files`), registered in `versions.ts`; data-conventions gains the `runtime/pipeline-addon-cuda-<version>/` folder | The add-on on disk                                        | Ignore the folder: it does not match the pack's name pattern |
| `HardwareProbe` gains the optional `accelerator` (`state`: ready, not-installed, failed, driver-too-old, unsupported-gpu or off; `version?`, `driver?`, `reason?`); `gpus[].vramBytes` is now filled                                                                                        | The wizard and Settings say why the GPU is or is not used | `HardwareProbe` is a loose object; `cuda` keeps its meaning  |
| `PhotoStage` gains the optional `device` (cpu or gpu), `engine` and `fallbacks`; `PhotoRun.versions` gains the keys `accelerator`, `cupy` and `cuda`                                                                                                                                        | Provenance of every stage                                 | Both are loose or free-keyed already                         |
| `photo.products` `dense: cuda` is honoured when the add-on is ready (same enum, new behaviour); `auto` may choose the GPU                                                                                                                                                                   | The parameter was reserved for this                       | An old pack still refuses `cuda` with its message            |
| `RuntimeInfo` gains the optional `addons` (kind, version, state, problem in words)                                                                                                                                                                                                          | Jobs and Settings show the add-on beside the pack         | Optional                                                     |
| IPC: `processing:get` and `processing:set` (`{ gpu?: auto or off }`, the `processing.json` file); the install-from-file channel of `feat/pipeline-pack-install` accepts an add-on archive and gains remove and test for it                                                                  | The switch and the Processing tools row                   | New channels; `settings.json` is untouched                   |

`PhotoAlignParams` does not change: the GPU choice reaches `photo.align` through the job's environment.

### Tests

- **pytest, every push, no GPU:** the array code on numpy against the existing dense, fusion and chain tests; one process and the pool give the same depth maps; band planning for 4, 8 and 16 GB of card memory; the fake backend's out-of-memory, missing-DLL and device-loss cases end on the CPU with finished photos kept and a warning; the matcher's thresholds against a tiny hand-made descriptor set; `dense: cuda` without an add-on still refuses in words; the self-test's failure answers.
- **pytest, with a card (skipped elsewhere):** the same cases on CuPy; card and numpy agree on at least 99.9% of pixels; the matcher against COLMAP's matches on the mini set.
- **node:test and Vitest:** the add-on build on fixture wheels (manifest, hashes, budget, notices); `findPack` with an add-on that fits, one that does not, and a broken one; the probe with a fake self-test for each state; `estimateRun` with and without the add-on for Standard and High; every wizard line; `processing.json` read, written and overridden by `QUADRION_PHOTO_GPU`.
- **Playwright:** Settings, Processing tools with a fake add-on (install from file, the row, the switch, remove); the wizard's lines for each probe state. Windows stay off-screen as for every agent run.
- **By hand on the founder's workstation, recorded:** the bench of WP6 before each add-on release, and the founder's own steps in a new stage of `docs/TESTING.md`.

### Docs and guide pages

- `docs/architecture/adr/0008-photogrammetry-engine.md`: a second amendment replacing decision 5's deferral with what was decided here.
- `docs/architecture/contract-changes.md` and `docs/architecture/data-conventions.md` (the add-on folder and manifest; `run.json`'s new keys).
- `docs/guide/28-processing-photos.md` (line 32 says the CPU is slower than GPU products), `docs/guide/12-settings.md` (Processing tools, the switch), `docs/guide/13-troubleshooting.md` (driver too old, add-on does not fit the pack, fell back to the CPU), `docs/guide/01-install.md` (the optional add-on).
- `docs/KNOWN-LIMITS.md:169` ("Processing runs on the CPU only").
- `docs/release/README.md` (the add-on's build, budget and CI job), `docs/release/THIRD-PARTY-NOTICES.md` (generated; CuPy and NVIDIA's runtime), `docs/release/CHECKLIST.md` (the bench result).
- `docs/TESTING.md`: a GPU stage with founder steps. `docs/plans/2026-10-07-m10-globe-and-photogrammetry.md`: the preset and hardware tables point here.

### Risks

| Risk                                                                                        | Mitigation                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The card gains little over the CPU pool                                                     | The spike measures both; the add-on is cut to matching, or dropped (option E), before any work package starts                                                                                  |
| The add-on drifts from the pack (Python or numpy changes)                                   | `packRange` in its manifest, refused with words when it does not fit; the add-on is rebuilt and benched with every pack release; CuPy's metadata allows numpy below 2.6 and the pack has 2.5.3 |
| Windows' driver watchdog resets the card during long kernels                                | Bands keep each kernel short; a reset is a handled failure that falls back to the CPU; no registry advice, ever                                                                                |
| The card's memory is shared with the desktop and the 3D view                                | Budgets from free memory at the start of each stage; out-of-memory handling; the estimate does not assume the whole card                                                                       |
| A GPU run differs from a CPU run more than the tolerances                                   | Tolerances are set from the measured CPU noise; the engine is recorded per stage; the switch turns the GPU off for a survey that must match an earlier one                                     |
| No GPU in CI lets a regression through                                                      | The same code on numpy in CI; the bench is a release gate with its result in the repository                                                                                                    |
| NVIDIA changes its wheels or terms                                                          | The lock pins versions and hashes; the add-on is optional and can be withdrawn without touching the pack                                                                                       |
| CuPy compiles kernels on first use (a pause of seconds) and caches them in the user profile | The self-test warms the cache; the cache folder is pointed into the app's data, not the read-only add-on                                                                                       |
| Runtime-compiled kernels read as "native code we build"                                     | The first release uses array operations only; a hand-written kernel would come back to the founder as its own question                                                                         |
| Two sessions edit the wizard and Settings at once                                           | WP5 starts only after `feat/pipeline-pack-install` and `feat/simple-jobs-photo-maps` have landed                                                                                               |

## Out of scope

- AMD and Intel GPUs, Apple silicon GPUs, Linux, Windows on Arm, and more than one GPU.
- GPU feature extraction, GPU bundle adjustment (unless decision 5 adds WP7), GPU meshing, texturing, orthomosaic, DSM and point cloud work.
- Learned features and matchers (ALIKED, LightGlue, LoMa) and any other change of method.
- Any source-built native component and any native build stage in CI (decision 1).
- A download host, automatic download of the add-on, public releases and tags.
- The Team Server, the AI features and the viewer's graphics tiers.
- Changing the Fast preset, the quality presets' meaning, or the 1,150 MB pack budget.

## Spike scripts

Written from reading `python/tests/conftest.py` (`run_job`) and `python/tests/test_photo_chain.py` (`_project`, `_chain`); **not run**. `bench_cpu.py`:

```python
"""CPU baseline per stage. Usage: bench_cpu.py <photos> <out> <preset> [n]; run from <worktree>/python."""
import json, sys, threading, time
from pathlib import Path

sys.path.insert(0, "tests")
from photo_synth import SITE
from aio_pipelines.photo import crs as C
from aio_pipelines.photo.align import PhotoAlign
from aio_pipelines.photo.products import PhotoProducts
from aio_pipelines.runtime import Job

photos, out, preset = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
n = sys.argv[4] if len(sys.argv) > 4 else "1"
C.geoid_grid = lambda name: None  # heights stay ellipsoidal, like the truth
project = out / f"project-{preset}-{n}"
project.mkdir(parents=True)
manifest = {"schema": "aio.project/1", "id": "gpu-spike", "name": "GPU spike", "type": "volumetric",
            "crs": {"epsg": SITE.epsg}, "origin": list(SITE.origin), "layers": [],
            "captures": [{"id": "c1", "date": "2026-03-14", "label": "14 Mar 2026"}],
            "severityModels": [], "classCatalogues": []}
(project / "manifest.json").write_text(json.dumps(manifest, indent=1), "utf-8")


def run(pipeline, params, job_id):
    return Job(job_id, pipeline, project, params, lambda method, p: None, threading.Event()).run()


t0 = time.monotonic()
a = run(PhotoAlign(), {"photos": {"folders": [str(photos)]}, "preset": preset, "run": "spike"}, "align")
p = run(PhotoProducts(), {"run": "spike", "preset": preset, "capture": "c1",
                          "products": ["cloud", "dsm", "dtm", "ortho", "mesh"]}, "products")
doc = json.loads((project / "photogrammetry/spike/run.json").read_text("utf-8"))
rows = [{k: s.get(k) for k in ("name", "state", "seconds", "memoryPeakBytes")} for s in doc["stages"]]
result = {"preset": preset, "status": [a["status"], p["status"]], "versions": doc.get("versions"),
          "wallSeconds": round(time.monotonic() - t0, 1), "stages": rows}
(out / f"cpu-{preset}-{n}.json").write_text(json.dumps(result, indent=1), "utf-8")
print(json.dumps(rows, indent=1))
```

`profile_dense.py`:

```python
"""Where one depth map spends its time. Usage: profile_dense.py <project>; run from <worktree>/python."""
import cProfile, pstats, sys
from pathlib import Path

from aio_pipelines.photo import native
from aio_pipelines.photo.dense import DenseSettings, depth_map, make_matcher, select_pairs
from aio_pipelines.photo.products import _Images
from aio_pipelines.photo.scene import load_run

run = load_run(Path(sys.argv[1]), "spike")
settings = DenseSettings(scale=1.0)
matcher = make_matcher(settings, native.memory_budget(), "auto")
pairs = select_pairs(run.model, settings.neighbours)
images = _Images(settings.scale)
prof = cProfile.Profile()
prof.enable()
for v in run.model.views[10:13]:
    partners = [run.model.view(j) for j in pairs.get(v.id, [])]
    depth_map(v, partners, images, run.model, matcher, settings, lambda: None)
prof.disable()
print("matcher:", matcher.name)
pstats.Stats(prof).sort_stats("cumulative").print_stats(25)
```

## Sources

All read on 10 Oct 2026.

- PyPI: [pycolmap](https://pypi.org/project/pycolmap/), [pycolmap-cuda12](https://pypi.org/project/pycolmap-cuda12/), [cupy-cuda12x](https://pypi.org/project/cupy-cuda12x/), [cupy-cuda13x](https://pypi.org/project/cupy-cuda13x/), [cupy-rocm-7-0](https://pypi.org/project/cupy-rocm-7-0/), [nvidia-cuda-runtime-cu12](https://pypi.org/project/nvidia-cuda-runtime-cu12/), [nvidia-cuda-nvrtc-cu12](https://pypi.org/project/nvidia-cuda-nvrtc-cu12/), [nvidia-cublas-cu12](https://pypi.org/project/nvidia-cublas-cu12/), [opencv-python-headless](https://pypi.org/project/opencv-python-headless/), [wgpu](https://pypi.org/project/wgpu/) (versions, files and sizes through the JSON API).
- COLMAP: [releases 4.0.0 to 4.2.1](https://github.com/colmap/colmap/releases), the [Windows build workflow](https://github.com/colmap/colmap/blob/4.2.1/.github/workflows/build-windows.yml), the [Windows wheel build script](https://github.com/colmap/colmap/blob/4.2.1/python/ci/install-colmap-windows.ps1), [vcpkg.json](https://github.com/colmap/colmap/blob/4.2.1/vcpkg.json), [CMakeLists.txt](https://github.com/colmap/colmap/blob/4.2.1/CMakeLists.txt), the [SiftGPU licence](https://github.com/colmap/colmap/blob/4.2.1/src/thirdparty/SiftGPU/LICENSE), [pull request 4161](https://github.com/colmap/colmap/pull/4161), the [FAQ](https://colmap.github.io/faq.html), [colmap-cl](https://github.com/openphotogrammetry/colmap-cl).
- conda-forge: [colmap files](https://anaconda.org/conda-forge/colmap/files), [pycolmap files](https://anaconda.org/conda-forge/pycolmap/files), [ceres-solver files](https://anaconda.org/conda-forge/ceres-solver/files), the [colmap recipe](https://github.com/conda-forge/colmap-feedstock/blob/main/recipe/recipe.yaml) and its [Windows build script](https://github.com/conda-forge/colmap-feedstock/blob/main/recipe/build.bat); package sizes and dependencies through the anaconda.org API.
- NVIDIA: [CUDA Toolkit release notes](https://docs.nvidia.com/cuda/cuda-toolkit-release-notes/index.html) (driver tables, architectures removed in 13.0), [CUDA 12.8 and Blackwell](https://developer.nvidia.com/blog/cuda-toolkit-12-8-delivers-nvidia-blackwell-support/), the [CUDA EULA](https://docs.nvidia.com/cuda/eula/index.html).
- CuPy: [installation](https://docs.cupy.dev/en/stable/install.html).
- GitHub: [secure use of Actions, self-hosted runners](https://docs.github.com/en/actions/reference/security/secure-use).

## What could not be verified

- **Nothing GPU was run.** Every speed on the card, every installed size and every memory figure for the card is an estimate until the spike.
- **Products have no real-flight timing.** The shares in finding 1 are the code's planning weights and my reading of the code.
- **The split of matching time** between comparing descriptors and geometric verification is not recorded; the matching estimate assumes the first dominates.
- **conda-forge's GPU COLMAP was read from metadata only:** that GPU bundle adjustment works on Windows, what the environment weighs installed, and whether it runs on this card are for the spike. The official zip's contents were not listed.
- **NVIDIA's pages were read through a summarising fetch.** The driver numbers (525, 580, 570.65) and the EULA's conditions should be read in the original before decision 6; the Windows minimum for CUDA 12 may be 528 rather than 525.
- **Not checked today:** whether OpenCV's semi-global matcher has an OpenCL path, the PyTorch and Blackwell history, PyTorch's Metal wheels, and whether CuPy needs cuBLAS loaded at import (the spike's DLL list answers it).
- **The spike scripts and the `colmap` command-line option names** were written from reading code and help text I could not run.
- **The pack install flow** (`feat/pipeline-pack-install`) and the wizard rewording (`feat/simple-jobs-photo-maps`) had no commits beyond `main` when I looked, so WP5 is planned against their descriptions, not their code.
