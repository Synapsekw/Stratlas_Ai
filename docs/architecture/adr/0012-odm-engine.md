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

## Notes from the build

- **Stub rename, measured**: on an RTX 5070 Ti, OpenMVS dense matching at medium quality took 204.8 s on the CPU (ODM's placeholder `nvcuda.dll` loaded) and 32.7 s on the GPU (placeholder parked), 24 photos. The rename is made in our own ODM install only, never deletes the file, and is checked before every ODM run and once after install. ODM's log never shows OpenMVS's CUDA line, so "dense on the GPU" is reported when the stub is parked, the driver exists, the openmvs stage ran and no `OpenMVS failed with GPU` line appeared.
- **Ground classification**: `--dtm` is passed only when a DTM is asked for; a point cloud without a DTM gets `--pc-classify`. Products runs add `--dsm`, `--cog`, `--pc-copc` and `--build-overviews`, never `--optimize-disk-space` (it deletes OpenSfM's features, matches and tracks, which a later georeference reuses). The cleanup after commit keeps `opensfm/undistorted`, so products can run again on the same run.
- **Ground control**: a georeference after ground control invalidates `opensfm/image_list.txt` along with the other OpenSfM files, otherwise ODM never applies the points; `useGnss` true passes `--force-gps`.
- **Threads and memory**: 21 on a 24-thread, 64 GB computer. Only a memory cap set by hand (`QUADRION_PHOTO_MEMORY_MB`, passed to ODM as `AIO_ODM_MEMORY_CAP_MB`) lowers it. The stall watchdog stops a run only when, for 60 minutes (`AIO_ODM_STALL_MIN`), ODM printed nothing, sent no progress and its process tree used less than 1 % of one core: OpenMVS densifies a large set silently for hours. In a DTM run, `renderdem` running silently for 30 minutes (`AIO_ODM_DEM_MIN`) fails the DTM with a plain message (with no ground points it spins on one core for ever). ODM runs with `PYTHONUNBUFFERED=1` so its log arrives live.
- **Paths**: besides spaces and non-ASCII letters, the characters `cmd.exe` treats specially (`& ^ % ! ( ) < > | "`) are unsafe because ODM's command line passes through it. 8.3 short names such as `RUNNER~1` are fine.
