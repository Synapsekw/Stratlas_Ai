# Drone panoramas: stitching DJI sphere frames into 360 panoramas

Date: 13 Oct 2026. Branch: `feat/drone-panoramas`. Status: approved by the founder on 13 Oct
2026 (open questions answered below); next is the implementation plan.

## What the founder asked for (13 Oct 2026)

"Add 360 pano processing in our app, something simple, effective and workable. Needs to be full
feature with deletion etc." The answers that shaped this design:

1. **Source: drone sphere panoramas.** A DJI sphere is a set of 22 to 27 raw frames that we stitch
   into one equirectangular image. 360 camera stills are not in scope.
2. **Scope: all of it.** View, compare across survey dates and augment the 360 view with project
   data, built in phases.
3. **Import: pick a folder.** The founder dumps a whole folder holding several panoramas; the app
   must work out which frames belong to which panorama and place each one on the map. **Raw frames
   never appear on the map as individual images.**
4. **Delete: everything for a sphere goes to the project trash** (stitched image, source frames,
   run record), with dependents shown first, restorable until emptied.
5. **Stitching: approach 1** below (metadata seed, OpenCV refinement, metadata-only fallback).
6. **Augment panel** (added mid-design): inside the 360 view, pick which layers to overlay (point
   clouds, 3D models, annotations and more) and a slider from the clean 360 image to the augmented
   view.

## Who uses it, and what success looks like

A surveyor flies a site and, as part of the flight, shoots a few sphere panoramas from about 60 to
75 m up. Back in the office they drop the whole card folder into the app. Success: the preview says
"5 panoramas found", each lands as one marker in the right place, they stitch in the background in
a few minutes each, and a click opens a level, north-up 360 view. A month later the next flight's
panoramas line up with these through the Timeline, and the reviewer can slide BIM, the point cloud
and open issues over the view. Removing a bad sphere is two clicks and can be undone.

## The real data (profiled 13 Oct, metadata only)

- **Reference site A** (camera L1D-20c, 5472 x 3648, 28 mm equivalent): two survey dates, each a
  single loose folder of about 130 frames holding 5 spheres of 26 or 27 frames. Rows at gimbal
  pitch 0, -35 and -70 plus one nadir frame (-90). Shutter about every 6 s; spheres 100 to 200 m
  apart at 61 to 74 m above ground. File numbers wrap (frame 0975 is followed by 0001), so frames
  must be ordered by EXIF time.
- **Reference site B** (camera L2D-20c, 5280 x 3956, 24 mm): 11 sphere folders (`100_xxxx`, 22 to 26
  frames) with a different pattern: rows at +20, about -17 and -55 plus nadir, shot in bursts of 3
  or 4 frames per yaw. A `Pano` folder holds the vendor's own stitched results for some of the same
  spheres (14400 x 7200, `GPano` equirectangular), which serve as our quality yardstick.
- Every raw frame carries DJI XMP: gimbal yaw, pitch and roll, flight yaw, pitch and roll, GPS,
  absolute and relative altitude. No RTK on either set.
- Ready-made equirect JPGs (2:1, no metadata) also exist and are imported as they are.

Two capture patterns mean the stitcher must be driven by each frame's metadata, never by a fixed
template.

## What already exists (reuse, do not rebuild)

- The `panoramas` layer kind and `PanoRef` (`packages/schema/src/layers.ts`), drawn on the Globe as
  markers with a stem (`packages/engine/src/adapters/panoramas.ts`), opened in an immersive sphere
  view (`panoSphere.ts`, `apps/desktop/src/renderer/workspace/panoView.ts`, `PanoPane.tsx`).
- T3 pairing across survey dates (`apps/desktop/src/renderer/workspace/panoPair.ts`: nearest pano
  of the other date within 25 m, linked look direction).
- Pano annotations (`Sighting` with `on: 'pano'`, yaw and pitch polygons) and 3D-positioned
  annotations on meshes and point clouds (`packages/schema/src/annotation.ts`).
- The DJI XMP reader `readPhotoMeta` (`packages/project/src/builder/exif.ts`).
- The pipeline job pattern of `walk.process` (job declared in `packages/schema/src/jobs.ts`, run
  record next to the outputs, Python class registered in `python/src/aio_pipelines/pipelines.py`,
  the app files results into the manifest).
- OpenCV 5 and pycolmap are already in the pipeline pack; nothing new to ship.
- On `feat/delete-and-start-over` (not yet merged): the removal plan, project trash, Empty and
  restore (`packages/schema/src/removal.ts`, `packages/project/src/builder/removePlan.ts`).

## Approach: metadata seed, OpenCV refinement, metadata fallback

Chosen over shipping Hugin's command-line tools (Windows builds only as installers, 60 to 80 MB on
an archive at 449 of 500 MB, four external processes, ignores the gimbal data) and over
metadata-only placement (1 to 2 degrees of error shows as ghosted edges on structures at this
resolution).

The gimbal angles put each frame within about 1 to 2 degrees of the truth. They decide which frames
overlap, so features are matched only between neighbours; a rotation-only bundle adjustment then
pulls the sphere tight. The seed makes the stitch robust on low-texture views (sky, water, flat
yards) where pure feature stitchers fail, and the refined rotations give true north and level for
the overlays. When refinement does not converge, the seed rotations are used as they are: a sphere
always produces a panorama, and its run record says so.

## 1. Data model and storage

**No new layer kind.** One import creates one ordinary `panoramas` layer bound to a survey date
through the layer's existing `capture` (suggested from EXIF, changeable). Each sphere is one
`PanoRef` in `items`, so markers, the sphere view, T3 pairing and pano annotations work unchanged.

**The stitch bakes orientation into the image.** The output equirect is level and north-aligned
(centre column = true north). `headingDeg` stays 0 for stitched panos and remains the manual "set
north" correction for drift and for ready-made panos. Overlays need only the pano's position.

**`PanoRef` gains optional fields** (additive; older items still parse):

- `name?`: display name, default "Pano 1, 2 ..." in capture order.
- `capturedAt?`: ISO time of the first frame.
- `stitch?`: `{ run: Id, status: 'queued' | 'running' | 'done' | 'failed', error?: string }`.
- `cov?`: the part of the sphere the image shows, `{ top: number, bottom: number, left?: number,
right?: number }` in degrees (top and bottom from the horizon; left and right the yaw range,
  clockwise from north, for a wide panorama). The renderer reads it today from
  `panoramas/panoramas.json`; that file is still read for older layers (P0 amendment: yaw range).

**Files per sphere**, `panoramas/<layerId>/<panoId>/`:

- `frames/`: the source frames, copied as they are (needed to stitch again; removed with the pano).
- `pano.jpg`: the equirect, **8192 x 4096** by default (about 8 to 12 MB; safe on every GPU tier),
  or **16384 x 8192** at the High setting where the GPU supports the texture size.
- `thumb.jpg`.
- `stitch.json`: the run record `aio.pano-stitch/1`: frames used and dropped, `aligned: 'features'
| 'metadata'`, residual error, coverage, quality, timings, pack version.

The pipeline writes only `stitch.json` and the images; the app files them into the manifest, as for
walks.

## 2. Import, grouping and stitching

### Entry points

"Add drone panoramas..." in the Datasets add menu and the command palette (search words: pano, 360,
sphere, panorama). A folder picker; subfolders are searched.

### Grouping frames into spheres

The scan runs in the app (TypeScript, seconds) and uses how a sphere is flown, not file names or
folders: the drone hovers in one spot while the gimbal sweeps every direction.

1. Read EXIF and XMP of every JPG with `readPhotoMeta`; order by EXIF capture time.
2. **Cluster by place and time.** Consecutive frames join a cluster while the drone stays within
   about 5 m horizontally and 3 m vertically and no gap exceeds 30 s (P0: was 60 s). Moving away, or returning to
   the same spot later in the flight, starts a new cluster. Folder boundaries are a hint only.
3. **Accept a cluster as a sphere** only with at least 8 frames, gimbal yaw covering at least 270
   degrees and at least 2 distinct pitch rows (a row is at least 2 frames within 8 degrees of
   pitch, so the single nadir frame is not a row). A sphere with fewer frames than its siblings is
   flagged "incomplete" but can still be stitched. **Wide panoramas** (P0 amendment, pending the
   founder's confirmation): a cluster with at least 8 frames and 2 rows whose yaw covers 150 to 270
   degrees is a partial panorama, stitched onto an equirect canvas cropped to what it covers and
   shown with that coverage. The preview labels it "wide panorama".
4. **Everything else is "not panorama frames"**: mapping photos (moving drone, fixed pitch), single
   shots, frames without gimbal data. They are listed with the reason and **not imported**, with a
   pointer to "Add photos".
5. **Ready-made panos** (2:1 aspect or `GPano:ProjectionType=equirectangular`) are imported as they
   are, without stitching; position from EXIF GPS when present, otherwise placed by hand.
6. **Position** of each sphere: the median GPS and altitude of its frames. That is its one marker.

The thresholds are tuned in P0 against both reference sites. The bar: every sphere found exactly,
no frame in the wrong sphere.

### Preview dialog

One row per sphere: thumbnail, frame count, time, height above ground, and a small map of where the
spheres sit; a checkbox per row. Fields: survey date (suggested), layer name (e.g. "Panoramas 10
Sep"), quality (Standard 8K, High 16K). Summary: "5 panoramas found (26 + 26 + 26 + 26 + 27 frames)
· 4 files are not panorama frames · about 2.6 GB copied".

### Raw frames never reach the map

- Frames live only in the sphere's `frames/` folder: not a photos layer, not `PanoRef` items, not
  in the manifest.
- **One sphere = one marker** from the moment of import (badged "stitching" until done).
- **"Add photos" runs the same detector.** When a photo import holds sphere frames it offers "130
  of these frames are 5 drone panoramas. Import them as panoramas?" and leaves them out of the photo
  layer by default.

### Confirm

1. Copy the frames into each sphere's `frames/`, with progress.
2. Write the layer to the manifest at once, every item `stitch.status: 'queued'`; markers appear.
3. Queue **one `pano.stitch` job per sphere** on the existing runner (one heavy run at a time), so a
   bad sphere fails alone and can be stitched again alone.

### The `pano.stitch` pipeline (Python, OpenCV)

Weighted steps so progress is honest:

| Step    | Work                                                                                                                                                                                                                                            |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| read    | Load frames and XMP gimbal angles; focal length in pixels from EXIF; working copies about 1600 px wide.                                                                                                                                         |
| seed    | Start rotation of each frame from gimbal yaw, pitch and roll.                                                                                                                                                                                   |
| match   | SIFT features only between frames whose seed directions overlap; RANSAC on a rotation-only model.                                                                                                                                               |
| adjust  | Rotation-only bundle adjustment, re-anchored to the metadata (north and level from the gimbal, fine alignment from features). Residual above about 2 px or a frame drifting over 5 degrees from its seed: use the seeds, `aligned: 'metadata'`. |
| compose | Warp into the equirect canvas; exposure compensation; seams found on a small copy; multi-band blend.                                                                                                                                            |
| fill    | Gradient fill above the top row from the top row's sky colour; record coverage.                                                                                                                                                                 |
| write   | `pano.jpg` (JPEG quality 90), `thumb.jpg`, `stitch.json`.                                                                                                                                                                                       |

Measured in P0: about 25 s per sphere at 8K on 24 cores (see "P0 findings" below). Parameters
`PanoStitchParams`:
`layer`, `pano`, `quality: 'standard' | 'high'`.

### Failures

- A failed job sets `stitch.status: 'failed'` with the reason; the row offers Stitch again and
  Remove.
- Cancelling leaves the item `queued` with a Stitch action.
- A pipeline pack older than the one shipping `pano.stitch` gets the "update the pipeline pack" gate
  walks use.
- Restitching keeps the old `pano.jpg` until the new one succeeds; a failed restitch shows "last
  stitch failed" over the old image.

## 3. Viewer, Timeline and the Augment panel

### Viewer

The existing sphere view, plus:

- **Header**: layer name, survey date, height above ground, and a quiet "aligned from metadata
  only" badge after a fallback.
- **Set north**: rotate and save `headingDeg`.
- **Hop to neighbours**: other panos appear inside the view where they stand on the ground,
  labelled with distance; a click jumps there keeping the look direction.

### Timeline

- Every pano layer has a survey date, so T3 split-view pairing works with no new code.
- **Date strip** in the single view: other survey dates with a pano within 25 m ("4 Sep · **10
  Sep**"); a click swaps the image in place keeping the look direction.

### Augment panel (founder, 13 Oct)

A panel in the 360 view to augment the clean image with project data, picked layer by layer.

- **Layer picker** with a checkbox per available layer, grouped:
  - **3D models**: BIM (IFC), GLB and meshes.
  - **Point clouds**.
  - **Annotations and issues** with 3D positions (pins with labels that open the issue); pano-drawn
    annotations keep working as today.
  - **Vector layers** (site boundary, areas, lines), draped on the ground.
  - **Design linework and alignments** from `survey/designs.json`, at their own heights.
  - **Layer labels**: a name tag over each visible dataset's footprint.
  - **Neighbour panos** (the hop markers).
- **Presets**: Clean (nothing), My selection (the checked layers), All.
- **Blend slider** from Clean to Augmented: the opacity of everything overlaid. At Clean the image
  is untouched; at Augmented the overlays are fully drawn.
- **Rendering**: point clouds and 3D models are drawn by the existing engine adapters from a camera
  placed at the pano's position, orientation and field of view, depth-correct among themselves, and
  composited over the sphere at the slider's opacity. Lines, pins and labels are projected from
  world points to directions from the pano position (yaw from east and north, pitch from height and
  horizontal distance). Vector ground heights come from the project surface or terrain where one
  exists, otherwise from the pano's ground level (altitude minus height above ground).
- **Persistence**: the selection, preset and slider position are kept per project view and come back
  on reopen.

### Accuracy

Without RTK the pano position is good to about 1 to 3 m, which moves an overlay by roughly 1 to 2
degrees from 74 m up: fine for labels, boundaries and models, not survey grade. Set north is the
manual correction; RTK drones are tighter for free.

## 4. Lifecycle and deletion

In the Datasets tree a panoramas layer row expands to one row per sphere (thumbnail, name, status).

| Row    | Actions                                                                                                                                                               |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Layer  | Rename · Change survey date · Show/hide · Stitch all again (pick quality) · **Remove panoramas...**                                                                   |
| Sphere | Open · Fly to · Rename · Set north · Stitch again (pick quality) · Stitch details (frames used/dropped, aligned by, residual, time) · Export image... · **Remove...** |

Status: queued and running show a progress line (the walk pattern); failed shows the reason with
Stitch again and Remove.

**Deletion** uses the removal plan and project trash of `feat/delete-and-start-over`:

- Whole layer: the existing `{layer}` target.
- One sphere: a new target `{ pano: { layer, id } }`. Removing the last sphere removes the empty
  layer too.
- A survey date: the existing `{capture}` target sweeps in its pano layers.
- The confirm lists consequences before anything moves: "1 panorama, 26 source frames, 214 MB · 2
  issues lose a sighting drawn in this pano". Issues stay; only their sightings in this pano go.
  Queued or running stitches for it are cancelled first.
- Everything moves to the project trash: the sphere folder (`frames/`, `pano.jpg`, `thumb.jpg`,
  `stitch.json`) and its manifest entry. Restore puts both back and recreates the layer if it was
  removed meanwhile. Empty trash or the 7-day sweep deletes for good.

**Packages and sync**: packages carry `pano.jpg`, `thumb.jpg` and `stitch.json`. Source frames stay
behind by default (like `work/`), with an "include source frames" option for handing over a project
someone must restitch. Without frames, Stitch again is disabled with a tooltip saying why.

## 5. Testing and phasing

### Phases

Each phase ships and merges on its own.

| Phase                 | Contents                                                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0 Probe**          | Grouping on both reference sites; stitch one sphere of each at 8K, compare with the vendor result, measure time and memory. Needs a CPU window from the founder. Sets the thresholds. |
| **P1 Import, stitch** | Scan and grouping, preview, frame copy, `pano.stitch`, one marker per sphere with status, tree rows with Open and Fly to, the "Add photos" detector.                                  |
| **P2 Viewer**         | Header, Set north, hop to neighbours, date strip.                                                                                                                                     |
| **P3 Lifecycle**      | Rename, change date, stitch again, details, export, remove and trash for layers and spheres, frames opt-out in packages. Starts after `feat/delete-and-start-over` merges.            |
| **P4 Augment panel**  | Layer picker, presets, blend slider, point cloud and 3D model rendering from the pano camera, projected vectors, linework, issues and labels.                                         |

### Contract changes

Each needs a row in `docs/architecture/contract-changes.md` when built:

- `PanoRef`: optional `name`, `capturedAt`, `stitch`, `cov` (P1).
- Pipeline `pano.stitch` and `PanoStitchParams` in `packages/schema/src/jobs.ts` (P1).
- Run record `aio.pano-stitch/1` (P1).
- Pipeline pack 0.7.0 as the minimum for `pano.stitch` (P1).
- IPC channels for the scan and import (P1).
- Removal target `{ pano: { layer, id } }` (P3).
- Augment selection in the project view state (P4).

### Tests

The repository is public: **no real imagery and no site names in fixtures**. Real folders are used
only by local `@realdata` tests.

- **Python**: a procedurally generated equirect scene cut into perspective frames with known
  rotations in both capture patterns, gimbal angles perturbed by 1 to 2 degrees; the stitch must
  recover rotations within 0.2 degrees. Textureless frames must fall back to `aligned: 'metadata'`
  and still produce an image. Sky fill and coverage, cancel and resume, `stitch.json` against its
  schema.
- **TypeScript grouping**: synthetic metadata tables for both patterns, wrapped file names, mapping
  photos mixed in, a return to the same spot later in the flight, a short sphere and frames without
  gimbal data; asserts exact membership. A local `@realdata` test asserts 5 / 5 / 11 spheres on the
  reference sites.
- **Removal plan**: the `{pano}` target, its dependents, restore with a recreated layer, last sphere
  takes its layer.
- **Augment**: projection math unit tests (known world point to yaw and pitch); selection
  persistence.
- **e2e**, run the CI way (1100 x 720, scale 1, WARP): import a generated folder with 3 spheres and
  stray mapping frames, preview shows 3, the map shows 3 markers and no photo markers; the stitch
  finishes; open, switch dates, remove a sphere, check the trash, restore. A second spec drops the
  same folder into "Add photos" and checks the redirect offer. P4 adds a spec toggling a layer and
  moving the slider.

## Known limits

- Overlay accuracy without RTK is about 1 to 2 degrees.
- The sky above the top row is a gradient fill, not imagery.
- High (16K) needs a GPU that supports 16384 px textures; the option is hidden otherwise.
- Stitching runs on the CPU only.

## P0 findings (13 Oct 2026)

The probe grouped both reference sites and stitched spheres of both capture patterns with
throwaway code. What it changed in this design:

- **Grouping.** 5 m horizontal and 3 m vertical stay; the gap threshold drops from 60 s to **30 s**.
  Measured: hover spread at most 1.14 m horizontally and 1.79 m vertically; gaps inside a sphere at
  most 10 s, between spheres at least 34 s; the nearest two spheres were 5.6 m apart, shot at
  different times. Yaw at least 270 degrees, at least 2 rows, at least 8 frames: every sphere found,
  no frame misassigned.
- **Wide panoramas.** Real clusters with 21 frames (7 yaws x 3 rows) covering 193 degrees of yaw
  exist. They are imported as wide panoramas (section 2), pending the founder's confirmation.
- **North.** Gimbal yaw is absolute and north-referenced: the stitched heading agreed with the
  vendor's result within 0.3 degrees, so north from the metadata is valid.
- **Fallback.** Frames without matches (sea, sky) keep their seed rotation instead of failing the
  sphere. The whole sphere falls back to `aligned: 'metadata'` only when the median residual at
  1600 px exceeds 2 px or any frame turns more than 5 degrees from its seed. The adjustment also
  refines one focal length shared by the frames (corrections of 1.3 to 1.6 % were seen).
- **Compose.** Exposure compensation `GAIN` (not gain blocks); seams by dynamic programming on
  colour and gradient (not graph cut); frames crossing the 180 degree meridian are split at the
  wrap. The sky fill must be a heavily smoothed, low-frequency gradient, or it streaks when the
  top row ends at about +22 degrees.
- **Memory.** 8K peaks at about 3.4 GB with float32 working data. A naive 16K run reached 12.6 GB,
  so 16K keeps images as uint8 and fills the sky strip by strip.
- **Time.** About 25 s per sphere at 8K on 24 cores: read and features 4.5 s, matching 1.2 s,
  adjustment 6 s, warping 8.5 s, seams 1.3 s, blending 0.7 s, fill 2.4 s.

## Answered questions (founder, 13 Oct 2026)

1. **"3D beam"** means the 3D models the user uploads, in GLB or any other supported model format.
   The Augment panel lists every uploaded 3D model layer.
2. **P0 can run at any time**: no CPU window is needed for the probe's stitching runs.
3. **16K support**: High is offered only on GPUs that accept 16384 px textures, and is hidden
   elsewhere.
