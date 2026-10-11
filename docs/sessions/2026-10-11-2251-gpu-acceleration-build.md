---
type: session
date: 2026-10-11-2251
branch: docs/wrapup-gpu-acceleration-build
status: complete
related:
  - docs/plans/2026-10-10-gpu-acceleration.md
  - docs/plans/2026-10-11-photo-dense-pool.md
  - docs/plans/2026-10-11-gpu-addon-in-settings.md
---

# GPU acceleration for maps from photos: the spike and five packages

## What changed

- **The spike** (step 0 of the GPU plan) ran on the synthetic 63-photo set; its results are the "Spike results" section of the plan. It changed the design: the card runs our array code around today's CPU matcher, not a ported matcher; matching on the card needs cuBLAS; COLMAP's conda GPU build is out.
- **CPU, for every computer** (`feat/photo-dense-pool`, round 60): fusion keeps the pixel directions per camera, and depth maps and fusion run several photos at once in worker processes sized by cores and memory. Depth maps 504 s to 98.7 s, fusion 1,023 s to 183.8 s, files identical.
- **The GPU add-on** (`feat/gpu-addon`, round 64): its manifest (`aio.pipeline-addon/1`), the build from pinned wheels (1,123 MB installed, 729 MB as a file), its own budget and notices, the loader and self-test, a CI job. The founder chose one add-on that carries cuBLAS, as a separate file beside the installer and the pack.
- **Depth maps and fusion on the card** (`feat/photo-on-card`, round 67) with fall back to the CPU per photo and per stage: depth maps 39.4 s, fusion 148.5 s on the same set.
- **The app finds the add-on** (`feat/gpu-app-probe`, round 68): a folder placed in `runtime/` is passed to photo jobs and reported in the hardware probe; no screen changes.
- **Pair matching on the card** (`feat/photo-gpu-match`) is handed to the Orchestrator; the plan for the add-on's card in Settings (`docs/plans/2026-10-11-gpu-addon-in-settings.md`) is on `main`.

## Why

The wizard estimated 20 to 39 hours for a High run on a workstation whose graphics card sat unused. The spike showed that most of that time was our own array code and one repeated calculation, so the first gains needed no card at all, and that the installer must not grow: the add-on stays an optional third file.

## How to test

1. Install 0.11.3 or later with its processing tools. Open a project with an aligned run of real drone photos (12 MP or more) and start **Create maps from photos** at Standard. In the run's log, "Depth maps of N photos at a time." and "Fusing N photos at a time." appear, and both steps finish several times faster. **Pause** stops within about a second and a resume continues.
2. For the graphics card (NVIDIA, Windows, processing tools 0.5.4 or later): unpack `pipeline-addon-cuda-0.1.0-win-x64.tar.gz` into the data folder's `runtime` folder, so that `runtime/pipeline-addon-cuda-0.1.0/manifest.json` exists. Start the same kind of run: the log says "Depth maps on" followed by the card's name. Nothing in Settings or the wizard mentions the add-on yet.

## Open threads

- Four decisions for the founder in `docs/plans/2026-10-11-gpu-addon-in-settings.md` (where the card sits, the wizard's wording once installed, the estimate, other platforms); the Orchestrator settled the fifth for the team build (the wizard reads as today without an add-on).
- Not measured: a real flight, how far two CPU runs differ, the High stages after fusion. Fusion's final merge, the point cloud and the orthomosaic are now the longest stages.
- The card path has not been run inside the packaged app, and a cancel in the middle of a card match has no test of its own.
- The scratch folder of the spike (about 120 GB, outside the repository) waits for the founder's word to delete.
- For the add-on and card packages no separate task plan was written; their "as built" notes are in the GPU plan.

## Next session entry point

Build the plan `docs/plans/2026-10-11-gpu-addon-in-settings.md` once the founder has answered its decisions, starting with its T1 (contracts) and T2 (installing an add-on archive with the pack's checks); then the recorded bench and the guide pages.
