# ADR 0008: Photogrammetry engine and licence policy

- Status: **Accepted, 7 Oct 2026 (founder: go with the recommendations)**. M10 decisions 1, 2, 5 and 8.
- Deciders: founder; integration lead (M10)
- Plan: `docs/plans/2026-10-07-m10-globe-and-photogrammetry.md`, "Licence policy and inventory" and "Photogrammetry: options and recommendation"
- Contracts: `@aio/schema` `photogrammetry.ts`, `jobs.ts` (`photo.*`, `opf.*`); code: `python/src/aio_pipelines/photo/` (G2, G3), `opf/` (G5), `tools/pipeline-pack/native/` (G1), `tools/release/licence-exceptions.json`

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
