---
type: session
date: 2026-10-14-0738
branch: docs/wrapup-drone-panoramas
status: complete
related: [../plans/2026-10-13-drone-panoramas-design.md, ../plans/2026-10-13-drone-panoramas-p1.md]
---

# Drone panoramas P1: raw DJI sphere frames grouped, stitched and placed, installer 0.13.0 and pack 0.7.0

## What changed

- **Add drone panoramas** (button next to Add data, Ctrl+K "pano"): a dumped folder of raw DJI frames is split into spheres by hover position and time (5 m, 3 m, 30 s gaps, 270 deg yaw, 2 pitch rows; wide 150 to 270 deg), stitched files and odd image sizes kept out. One `panoramas` layer per import, one marker per sphere at once, frames copied to `panoramas/<layer>/<pano>/frames/`, never map items. Add data offers sphere frames to the panorama import ("Skip these frames" leaves them out).
- New `pano.stitch` pipeline (`python/src/aio_pipelines/pano/`): gimbal-seeded, SIFT plus rotation-only bundle adjustment, metadata fallback, GAIN, DP seams, multi-band blend, feathered sky fill; level and north-up 8K equirect (16K on capable GPUs), about 25 s per sphere, one stitch at a time. Run record `aio.pano-stitch/1`.
- Tree rows with status, Open, Fly to, Stitch; after import the view flies to the spheres; pano markers widen the camera reach. Removing a pano layer stops its stitches and moves the whole folder to the trash. Pipeline pack 0.7.0, GPU add-on lock 0.1.1 (`<0.8.0`), app 0.13.0.
- PR #117 and #118; built subagent-driven (15 tasks, review per task, final whole-branch review with 1 critical and 3 important fixes). CI caught three more (spec pack label, OpenCV loaded in the MeshLab process, add-on test ranges). Installer 0.13.0 (206.6 MB) and pack 0.7.0 (449.2 MB archived, 1,248 MB unpacked) built from `fcefb682` into `apps/desktop/dist`.

## Why

Founder asked for simple, workable 360 pano processing from raw drone frames with full lifecycle; P0 probe on two reference sites matched the vendor stitch within 0.3 deg heading. Raw frames must never appear on the map; panos must be placed properly and visible.

## How to test

1. Install 0.13.0, then pack 0.7.0 in Settings, Processing tools; open a project with a coordinate system.
2. Add drone panoramas, pick a folder of raw sphere frames: the preview lists each sphere with its frame count, wide panoramas labelled, stray and stitched files as not frames. Import.
3. The tree opens on the new layer and the view flies to it: one marker per sphere, no frame markers. Rows stitch one at a time (about 25 s each).
4. On a Stitched row click Open: level, north up. Fly to frames it from above.
5. Drop the same folder into Add data: the card offers the spheres; Skip these frames imports only other files. A GLB or LAS alone imports with no card.
6. Remove the pano layer: the confirm lists it; frames and images go to the project trash.

## Open threads

- Founder: keep or drop "Import as photos anyway" on a failed panorama check; build GPU add-on 0.1.1 (0.1.0 is refused next to pack 0.7.0).
- Follow-ups: waiting stitches lost on quit need a Stitch click; restitch from a row is Standard quality; frames-only e2e uses a fixed 5 s wait; dropping the project's own `panoramas/` gives no feedback. P2 viewer (Set north, hops, date strip), P3 lifecycle (rename, restitch quality, single-sphere removal), P4 Augment panel (layers over the 360 with a blend slider).

## Next session entry point

P2 plan from the design's section 3, or P4 (Augment panel) if the founder prefers.
