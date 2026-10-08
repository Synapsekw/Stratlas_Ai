# ADR 0008: Photogrammetry engine and licence policy

- Status: **Accepted, 7 Oct 2026 (founder: go with the recommendations)**. M10 decisions 1, 2, 5 and 8. **Amended 8 Oct 2026** (founder, directly): prebuilt binaries, GPL accepted in the pipeline pack; decision 1 and the own-build parts of decisions 2 and 6 are superseded for the pack (see "Amendment" below).
- Deciders: founder; integration lead (M10)
- Plan: `docs/plans/2026-10-07-m10-globe-and-photogrammetry.md`, "Licence policy and inventory" and "Photogrammetry: options and recommendation"
- Contracts: `@aio/schema` `photogrammetry.ts`, `jobs.ts` (`photo.*`, `opf.*`); code: `python/src/aio_pipelines/photo/` (G2, G3), `opf/` (G5), `tools/pipeline-pack/pdal.mjs` and `python/pyproject.toml` (since 8 Oct 2026; `tools/pipeline-pack/native/` before), `tools/release/licence-exceptions.json`

## Context

The founder asked for photogrammetry "for processing the images into maps", through OPF or ODM, "pick what's best for us", and that "everything we put here has an Apache license as well". OPF (Pix4D, CC-BY-4.0 specification, Apache-2.0 pyopf) is an interchange format that processes nothing. ODM processes, but it is AGPL-3.0, and so are its orthophoto, DEM and tiling helpers. Read literally, "Apache only" would remove GDAL, PDAL, numpy, SciPy, Pillow and most of the pipeline pack already shipping, and every public-domain imagery source. The licence traps sit in the native dependencies: COLMAP's CHOLMOD Supernodal and Ceres' SuiteSparse (GPL), COLMAP's LSD (AGPL), CGAL (GPL), SiftGPU (non-commercial), FFmpeg in the PyPI OpenCV wheels, GPL plyfile in pyopf's `tools` extra.

## Decision

1. **Licence policy: permissive only.** Apache-2.0, MIT, MIT-0, BSD-2/3-Clause, ISC, 0BSD, Zlib, BSL-1.0, PSF and similar, plus public-domain and CC-BY data with attribution. Never GPL, AGPL, SSPL, non-commercial or research-only code or weights, never LGPL linked statically. LGPL only as an unmodified, replaceable shared library already shipping (GEOS); MPL-2.0 only by name (Eigen headers, certifi). DOMPurify inside CesiumJS is taken under Apache-2.0. The names live in `tools/release/licence-exceptions.json`; the npm and Python gates read it, and G1 extends the gate to every native library in the pack and every data pack.
2. **Our own pipeline in the pipeline pack, on COLMAP** (BSD-3-Clause) through our own pycolmap build, with GDAL, PDAL and our own code for the drone-specific parts: EXIF and DJI XMP with RTK, GPS-guided matching, the global mapper with incremental fallback, GNSS priors, GCP adjustment with honest checkpoints, CPU dense matching (MVE `dmrecon` or SGM, chosen by G3's spike), fusion, COPC, DSM and DTM, orthomosaic, Poisson and 2.5D meshes, texturing with `texrecon` (mapMAP, not gco). Built with CUDA, GUI, OpenGL, CGAL, LSD, ONNX and downloads off and CHOLMOD made optional; Ceres without SuiteSparse; OpenCV without FFmpeg. G2's first week compares OpenSfM (BSD-2) on the synthetic set and a founder flight; the stage interfaces do not change if it wins.
3. **OPF for interchange** (`opf.import`, `opf.export`) with pyopf's core only, never its extras.
4. **No ODM adapter in M10.** "Use your own ODM" (the customer installs AGPL software and we call it at arm's length) is revisited after founder testing.
5. **No GPU required.** The CPU path is the product; a CUDA build of COLMAP for the High preset is an optional accelerator, deferred to M10.1.
6. **Platforms:** photogrammetry on Windows x64 and macOS arm64 only; Intel Macs keep the other pipelines.
7. **Additive contracts.** Outputs are existing layer kinds (`mesh`, `pointcloud` `copc`, `raster` `kit-pyramid`); provenance lives in `photogrammetry/<run>/run.json` (`aio.photo-run/1`), ground control in `gcp.json` (`aio.gcp/1`), accuracy in `report/accuracy.json` (`aio.photo-accuracy/1`). Source photos are never written; refined poses are offered, never applied without a person.

## Consequences

- A disciplined native build (vcpkg overlay, pinned versions, SBOM review, a source archive per pack) is part of every pack release; cold builds take one to two hours in CI.
- COLMAP without CHOLMOD Supernodal is slower on large adjustments; G2 measures on 1,000 images, with Accelerate sparse on macOS and smaller submodels as mitigations.
- CPU dense matching is slower than GPU products; the Fast preset (2.5D) covers laptops and flat sites.
- The pipeline pack grows to at most 1.1 GB unpacked and 450 MB compressed per platform (decision 6), or splits a photogrammetry component pack.

## Amendment (8 Oct 2026): prebuilt binaries, GPL accepted in the pipeline pack

The founder decided: "licences don't matter; make it faster and easier to operate". GPL is accepted in the pipeline pack. This supersedes, for the pack, decision 1 (permissive only), the "our own pycolmap build", "CHOLMOD made optional" and "OpenCV without FFmpeg" parts of decision 2, and the disciplined native build of the consequences.

- **Engines from prebuilt packages.** COLMAP's PyPI wheel (`pycolmap` 4.2.1, with CHOLMOD and SPQR), `opencv-python-headless` 5.0.0.93 and `pymeshlab` 2025.7.post1 come from `uv.lock` for Windows x64 and Apple silicon (decision 6's platforms are unchanged); PDAL is conda-forge's `libpdal-core` 2.10.2, installed by micromamba from a SHA-256 pinned lock into `<pack>/tools/pdal` on every pack platform. Nothing is compiled; the vcpkg recipe and `pack-native.yml` are removed.
- **Mesher.** MeshLab's screened Poisson replaces the PoissonRecon build as the primary engine, in a child process with a retry; PoissonRecon (when a local build is named) and the built-in FFT solver remain the fallbacks. Open3D was rejected for size (about 360 MB with the web packages it needs to import).
- **Licence checks are reports.** The npm, Python, native, data and Team Server checks list what they find and never fail CI, a dist or a release. `licence-exceptions.json` accepts the copyleft families for the pack (`copyleft`); the app and the Team Server stay permissive by convention.
- **Attribution still ships.** `THIRD-PARTY-NOTICES.md` lists pycolmap, OpenCV, pymeshlab and every conda-forge package of PDAL with its real licence, GPL parts included; the pack carries PDAL's licence files in `tools/pdal/licenses`.

Consequences:

- The pipeline pack is a combined work with GPL libraries in one process (CHOLMOD and SPQR in pycolmap, MeshLab, OpenCV's macOS FFmpeg with x264 and x265), so a distributed pack is under the GNU GPL version 3: recipients may ask for its corresponding source, our pipeline code included. The app and the Team Server only start the pack as a separate program.
- The pack builds in about a minute with warm caches (was one to two hours per platform cold); CI runs the real engines on every push.
- CHOLMOD is back in COLMAP's bundle adjustment, which is faster on large problems than the Eigen-only build.
- Windows pack 0.4.0: about 994 MB unpacked and 343 MB as `.tar.gz`, within decision 6's 1.1 GB and 450 MB.
