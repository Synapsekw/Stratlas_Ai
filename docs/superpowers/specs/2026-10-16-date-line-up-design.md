# Line up dates: design

Status: draft for the founder's approval, 16 Oct 2026.

## Intent

The founder wants a quick, one-button way to see what changed on a site between two orthophotos. Quadrion already has imagery change (`change.raster`, M8 C2), but on a real project it refused to run: "The two dates are 10.2 px (2.01 m) apart; the largest shift allowed is 2 px." Two flights without RTK or ground control are routinely metres apart, so the existing check blocks change detection on ordinary projects, and the message points to "Align the layers first", a tool that does not exist (`docs/KNOWN-LIMITS.md`).

A fix inside the comparison only would get the heat map right but leave every other view 2 m off: swipe and blend, pins on both dates, the 3D scene, measurements. The founder chose the bigger fix: **line up a whole survey date with another, once, and have every view and every job use the corrected position.**

## What it does (founder's decisions)

1. **Line up dates.** Quadrion measures how far one survey date sits from another and saves a correction on the date that moves. From then on, every view and every processing job places that date's content with the correction applied.
2. **The user picks which date stays put.** The line-up step offers both dates; neither is assumed to be the true one.
3. **Everything on the moved date moves together**: its orthos, DSMs, point clouds, models, photos, panoramas, video, walks and vector layers, and everything people drew or placed on that date (pins, issues and their sightings, measurements, outlines, findings, detections).
4. **Two ways in, both opening the same line-up step** (mockup accepted, "both ways"):
   - **When a new survey arrives.** After a date gets an ortho (or DSM) and another date already has one, Quadrion measures the gap in the background. If the dates are too far apart, a notice says so ("Survey 16 Oct doesn't line up with 3 Oct. Its ortho sits 2.01 m away...") with **Line up dates** and **Not now**.
   - **In the Changes panel.** Where imagery or surface change refuses today, the panel says "These dates are 2.01 m apart" with **Line up dates**. After lining up, the change run carries on by itself.
5. **The line-up step shows**: which date to keep in place (choice of the two), the measured shift (east and north, and the total), how confident the measurement is, what will move with the date (layer and item counts), and a swipe preview with Before and After. **Line up** saves; a notice confirms ("16 Oct lined up with 3 Oct (2.01 m)") with **Undo**. The correction is also visible on the date afterwards and can be removed there.
6. **Automatic only for now.** When the measurement cannot be trusted, the step says so in plain words and does not line up. Manual point picking (click the same spot on both dates) is **deferred**: record it as a known limit and a later item.
7. **Original files are never changed.** The correction lives in the project, like a point cloud's `heightOffsetM`.

## Goals, non-goals, anti-goals

- **Goal:** on the founder's project, Line up dates followed by Run imagery change produces a heat map of real change, and swipe/blend, pins and the 3D view of the two dates line up.
- **Non-goals (first version):** rotation, scale and height corrections (sideways shift only); manual point picking; lining up layers within one date against each other; changing where the project's origin or CRS sits.
- **Anti-goals:**
  - A correction applied in some views but not others. A date that is lined up in the map but not in 3D, or in the viewer but not in the change job, is worse than no feature. Every consumer of a position must apply it.
  - A silent large correction. The shift is always shown, before saving and after.
  - Rewriting the user's files or the stored coordinates of their pins and measurements. Undo must stay trivial.
  - Lining up on a bad measurement (water, snow, a site that changed almost entirely, a rotated ortho). Refusing with a clear reason is the right outcome.

## Constraints from the codebase

Found in recon (16 Oct 2026); file references are starting points for the builder.

- **No central placement.** Positions are applied per layer kind in roughly 20 places: engine adapters (`packages/engine/src/adapters/*`, `overlay/Overlay.ts`), point clouds (`packages/pointcloud/src/adapter.ts`), tiles, video, volumetric, the 2D map (`packages/maps/src/*`), the globe (`packages/globe/src/view/*`), annotation overlays (`packages/annotate/src/tools/overlay.ts`, `crossview/camera.ts`), extents and the far-content check (`packages/project/src/builder/extents.ts`), renderer helpers (`shell/layerBounds.ts`, `workspace/spot/*`, `FramesPane.tsx`) and compare/change (`workspace/compare*.ts`, `packages/change/src/*`).
- **Placement differs per kind**: meshes have a 4x4 `transform`; point clouds a `heightOffsetM`; rasters take their georeference from the file (plain images have `corners`); video has `positionOffsetM`; photos have poses plus hand corrections in `orientation.json`; vectors are lon/lat GeoJSON.
- **Drawn items use three coordinate systems**: local frame (mesh and point cloud sightings, pins, `selections/*.sel`), project CRS (`survey/measurements.json`), lon/lat (map sightings). Pixel-space items (image and frame sightings, detections) follow their photo and need nothing.
- **Date membership** is explicit (`Layer.capture`) or inferred (name/date token, volumes list); layers with no date are common to every date. Resolve through `captureIndex` (`packages/workspace/src/captures.ts`), never by reading the field alone.
- **Pipelines** read the manifest. Clouds already honour `heightOffsetM` (and their fingerprints include it); meshes honour `transform`; rasters and surfaces (`change/sources.py` `grid_source`) read the georeference from the file and ignore manifest fields, so they need the shift added.
- **Undo** is per feature, a notice with Undo/Redo (`renderer/builder/alignToStore.ts`, `dropStore.ts`, `shell/dateUndo.ts`). There is no global undo.
- **Precedent to follow:** the cloud-ground work (`docs/plans/2026-10-16-cloud-ground.md`): one manifest field, applied at read time everywhere, Python-aware, with an undo notice.
- A contract change needs a row in `docs/architecture/contract-changes.md` and a section in `docs/architecture/data-conventions.md`.

## My calls (founder to check)

1. **Where the correction is stored:** one optional field on the capture in `manifest.captures[]`, a horizontal shift in metres in the project frame (east, north). Absent means none. One field per date, not per layer, so "everything on the date moves" holds by construction.
2. **Applied at read time, never written into coordinates.** A shared helper (e.g. `captureShift(manifest, layer)` / `captureShiftFor(captureId)`) is called from every consumer listed above and from the Python readers. Drawn items follow the shift of their date: through their sighting's layer where they have one, through an explicit capture link otherwise.
3. **The shift is absolute, not relative.** If the date kept in place is itself already shifted, the moved date's stored shift includes that, so a third date lined up with either one lands in the same place.
4. **What is measured:** the orthos of the two dates; when a date has no ortho, the slopes of their DSMs (`register.py` already supports both). The measurement reuses `register.py` (phase correlation over textured tiles, median shift, spread as confidence), extended coarse to fine so shifts of tens of metres can be measured on a lower pyramid level and refined at full resolution.
5. **Confidence:** "Confident" needs enough textured tiles and tiles that agree with each other (small spread). Too few tiles, or tiles that disagree (the sign of rotation or scale), means "can't line these up" with the reason. Thresholds are the builder's, tested on the synthetic change demo with a known shift and with a rotated copy.
6. **When the notice appears:** when the measured gap is above the change check's tolerance (2 px at the comparison resolution), so a date that would block change detection always gets the notice. Measured once per new ortho/DSM against the date it most overlaps; "Not now" is remembered for that pair.
7. **Change detection after lining up:** the `maxShiftPx` check in `change.raster` and surface change stays as a safety net on the residual; after a good line-up the residual is well under 2 px. The "Align the layers first" message is replaced by the Line up dates action.
8. **Common layers** (no date) never move. Base maps, terrain and the street map never move.
9. **Undo** restores the previous shift of the moved date (none, or an earlier one), like `dateUndo.ts`.
10. **On top of each layer's own placement.** The date shift is added after a layer's own placement (mesh `transform`, cloud `heightOffsetM`, video `positionOffsetM`, photo corrections, a raster's file georeference); it replaces none of them. It is stored as metres east and north. The local frame is the project CRS moved to `origin` (data-conventions section 1: `E = origin[0] + x`, `N = origin[1] - z`), so the same shift is `x += east`, `z -= north` in the local frame and a CRS offset for project-CRS items; lon/lat items (map sightings, vector layers) are converted through the project CRS, shifted and converted back at read time.
11. **No cascade.** Each date's shift is independent and absolute. If the kept date is later moved, dates lined up with it earlier do not follow; the background check measures them again and raises the notice if they no longer line up. No dependency chain is stored.
12. **Earlier results.** Everything drawn or placed on the date follows the shift (founder's decision 3), including detections placed on a model. Change results computed before the line-up involving that date are marked out of date in the Changes panel, with a rerun offered; they are not recomputed silently. Reviews are kept on rerun as today.
13. **Exports and packages** follow the `heightOffsetM` precedent: files are never rewritten, the shift is carried in the sidecar or manifest, and an older build that does not know the field is handled through `versions.ts`.
14. **Definition of done:** every consumer listed under "Constraints" applies the shift; none is optional (anti-goal 1). The plan carries one test per consumer and an e2e that lines up two dates of the synthetic change demo with a known 2 m shift and checks swipe, a pin on both dates, the 3D view and a clean imagery-change result.
15. **Same project, one CRS.** All layers of a project are already in its CRS, so no CRS question arises. Measuring needs enough overlap for the confidence rule (call 5); too little overlap refuses with "These dates hardly overlap".
16. **Measuring cost.** The background measurement reads a low pyramid level first and refines on a bounded number of tiles at full resolution, so a very large ortho takes seconds, not a full read. It runs as a pipeline job like the change jobs.

## Left to the builder

- The exact field name and schema shape, the bridge channel for "measure line-up", and whether measuring runs as a pipeline job or in main.
- Which consumers can share one wrapper (for example a per-capture frame origin like `cloudFrameOrigin`) versus a per-kind change.
- How survey measurements and volume outlines that carry no date are tied to one (their `scope` / `captureId` may already be enough).
- Cache and fingerprint invalidation, so tiles, extents and derived results computed before a line-up are recomputed or marked stale.
- Exports and packages (`layer:export` sidecars, `package.ts`, `versions.ts` for older builds).
- User guide: a new section in `docs/guide/15-imagery-and-surface-change.md` (or its own page), and the `KNOWN-LIMITS.md` entry updated to "manual point picking is not available yet".

## Later

- Manual point picking when automatic line-up can't be trusted.
- Rotation and scale (similarity): done, see `2026-10-18-line-up-similarity-design.md`. Height corrections are still later.
- The broader "one button for change": fewer steps from opening a project to seeing the heat map (today: Compare dates, Show changes, pick dates, Run imagery change).
