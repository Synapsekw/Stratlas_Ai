---
type: session
date: 2026-10-15-1022
branch: fix/import-placement-fixes, fix/scene-centre
status: complete
related: [../plans/2026-10-14-import-placement-fixes.md, ../architecture/contract-changes.md]
---

# Import placement fixes and Centre on project

## What changed

- **#131** (`fix/import-placement-fixes`, main `12337330`), from a real chimney stack survey project processed in Pix4D: MTL texture names with spaces are kept; Pix4D and map-grid OBJ models stand Z-up and are placed from their offset file; Align > Georeference model gets a Y up / Z up switch; point clouds count as solid content for Home.
- Far data (over 10 km from the project origin) gets a notice with Re-centre project here or Keep (IPC `builder:layerExtents`, `builder:recentre`). Re-centre is journaled as one non-undoable step and fully reopens the project; finished jobs and point cloud jobs are allowed, procedural models block it.
- Survey data beats handheld camera GPS: "Ignore their GPS" (LayerPatch `photoPositions: 'clear'`, `photoGps.handheld`). `pointcloud.to_copc` now runs untwine (all cores, low memory, no reprojection when the CRS matches, free disk check); packs without untwine refuse clouds over the memory budget ("Install pipeline pack 0.6.1 or later"). The status says "Building the viewable cloud: N min, still working". The original 243M point LAZ took 65 min on the old PDAL path. Contract rows are pending founder review.
- **#133** (`fix/scene-centre`): a Centre on project button after Whole site (shortcut G, also in the palette) frames models and clouds, else photos within 10 km of the origin, else the origin, and sets the orbit target. The street map extent uses the same near bounds (photos 91 km away had pulled its rings off site). Removing layers (one or several) that leave the camera far from everything re-frames the view. `FAR_M` is shared from `@aio/engine` config; the 2D map's Centre on project eases to the origin only.

## Why

A real survey imported lying on its side, kilometres off site, with a cloud build that took over an hour; far phone GPS also dragged the view and the street map away from the site.

## How to test

Needs the next installer (none built by this block).

1. New project, Add data, a Pix4D OBJ from its `3d_mesh` folder: textured, upright, roughly in place.
2. Align > Georeference model: Up axis shows Z up; flip to Y up and back.
3. Import a LAS or LAZ: the status shows elapsed minutes and "still working"; Home frames the cloud.
4. In a project whose centre is far away, a new import shows the far notice; Re-centre project here moves everything, clouds included.
5. Add handheld camera photos with far phone GPS to a project with drone data: "Ignore their GPS" is offered.
6. In the 3D view press the crosshair Centre on project button or G: the view frames the survey and zooming closes on it; the street map draws around the site.
7. Delete a far photos layer while looking at it: the view returns to the project.

## Open threads

- Real-data proof of untwine speed (re-import the 243M LAZ with the next pack); untwine stdout is block-buffered so % arrives late (the ODM session is adding a liveness fallback in `photo/native.py`).
- Failed or cancelled job folders block re-centre with no way to clear them; a full reopen resets environment settings; `.trash` entries keep old-origin positions; glTF node transforms are ignored in extents.
- Drone detection knows only DJI and Hasselblad makes (advisory hint); the palette's "Check where layers lie" never applies the photo rule; no unit test for `photoGps.handheld`; `boxOf` uses `Math.min(...arr)`, which overflows near 100k photos.
- COMPD_CS with GEOGCS falls back to the vertical code (warns); the vertical datum is not compared; the photo memory setting now also caps cloud imports; the 2D map's Centre on project uses the origin, not the site bounds.
- Intermittent e2e: `perf.spec.ts:381` (Low tier, lost context, Dismiss click timeout, CI main-process stall), `platform.spec.ts:204` (Windows signature check did not answer in 30 s), `compare.spec.ts:477` (project card "E2E two dates" not shown within 30 s); the last two failed once on #133 CI and passed on one rerun.

## Next session entry point

Right-click menus across the left sidebar (empty space for project actions such as Add data, a dataset or item for delete, move, rename; multi-select) plus "Align to" (shift a selection as a block onto a target layer's site, keeping its layout): its own branch with a short plan.
