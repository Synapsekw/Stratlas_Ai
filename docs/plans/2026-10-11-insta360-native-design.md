# Insta360 native files: import, stitch and a look-around player

Status: proposal, built on `feat/insta360-native`, not reviewed by the founder yet. It is the front
slice of part W1 of `2026-10-07-walks-360-design.md` ("Ingest and play"), shaped so the rest of W1
can adopt it.

## Problem

The app cannot take the files a 360 camera writes. An Insta360 `.insv` or `.lrv` dropped on the
window is skipped ("Not a file type the builder imports."), and a stitched equirectangular MP4 is
skipped too, because a video needs a DJI SRT file with the same name to be imported. The Walks 360
design was approved on 7 Oct but nothing of it exists in the code.

## What this slice delivers

1. `.insv` and `.lrv` are recognised by the import (file dialog, drag and drop, the raw importer).
2. The two fisheye pictures are stitched into one equirectangular H.264 playback copy by ffmpeg.
3. The result is stored in a side folder of the project, `walks/<id>/`, with a `walk.json`.
4. A **360 video** pane in the split view plays it: drag to look, wheel to zoom, play, scrub.
5. An already stitched equirectangular MP4 is accepted through **Add 360 video**.

Not in this slice (the later half of W1, and W2 onward): chapter joining, stills, motion data,
the `equirect` lens, placing the walk on the site, the path, pins, overlays, compare.

## Facts checked before building

On the two reference clips (an X4, read with ffprobe on this workstation):

| File    | Tracks                                                         | Trailer                                  |
| ------- | -------------------------------------------------------------- | ---------------------------------------- |
| `.insv` | two HEVC video tracks, 2880 x 2880 each, 59.94 fps; AAC stereo | ends with the 32 character Insta360 mark |
| `.lrv`  | one H.264 video track, 1664 x 832, 29.97 fps; AAC stereo       | ends with the same mark                  |

The `.lrv` is the two fisheye pictures side by side in one frame, not a stitched picture. The names
pair up as `VID_<date>_<time>_00_<n>.insv` and `LRV_<date>_<time>_01_<n>.lrv`.

Compatibility rules that bind this slice: `lens.model` is a strict union, so a `video` layer with
a new lens model makes every installer already handed out refuse the whole project; a new layer
kind is hidden by 0.10 and later and refused by older builds. Both are held for the founder. So
this slice adds **no lens model, no layer kind and no value to an existing enum**.

## Decisions taken (smaller and safer where there was a choice)

1. **A walk is a side folder, not a layer (for now).** `walks/<id>/walk.json` (`aio.walk/1`),
   `walks/<id>/playback.mp4`, `walks/<id>/poster.jpg`. The manifest is not touched by a walk
   import. Older builds never look in `walks/`, so they open the project as before and simply do
   not show the walk. The list of walks is the folder itself (every `walks/*/walk.json` that
   reads); there is no separate index file to keep in step, so two imports cannot overwrite
   each other's entry. The id is taken by moving the finished folder into place: the move fails
   when the folder exists and the next free id is tried.
2. **Layouts are recognised from the file, never guessed.**
   - `.insv` with exactly two video tracks of the same square size: two lens streams (verified on
     the X4; the X3 and X5 write the same layout according to the Walks design, but no sample has
     been read here, so the import says "two lens streams" and does not name a camera).
   - `.lrv`, or a file named `LRV_...`, with one video track twice as wide as high: both fisheye
     pictures in one frame.
   - Anything else in an `.insv` (one track, as the two-file clips of the X2 and older cameras
     write; three or more; unequal sizes) is skipped with a message that says what was found.
   - The Insta360 mark at the end of the file is recorded in `walk.json` but not required, so a
     clip that went through a copy tool that dropped the trailer still imports.
3. **An `.lrv` next to its `.insv` in the same import is the proxy, not a second clip.** It is
   reported as skipped with that reason. An `.lrv` imported without its `.insv` becomes a walk at
   its own low resolution, with a note (and the note names the full clip when it lies beside it).
   Using the `.lrv` for a quick preview while the full stitch runs is not built.
4. **Stitch.** Each lens stream is brought to at most 30 fps, the two are stacked side by side,
   and `v360=input=dfisheye:output=e:ih_fov=195:iv_fov=195` writes the equirectangular frame. The
   output is `min(3840, 2 x lens width)` wide and half as high (3840 x 1920 for the X4, 1664 x 832
   for an `.lrv`), H.264 high profile, yuv420p, a keyframe every half second, at most 16 Mbit/s,
   audio kept as AAC stereo, `faststart`. The encoder choice (NVENC, Quick Sync, libx264) and the
   retry on the CPU are the ones the drone review copy already uses. The field of view is fixed
   at 195 degrees; reading the real per-lens calibration from the trailer is an open decision
   below.
5. **ffmpeg stays an external program.** Before any file is written the import asks ffmpeg for its
   filter list. No ffmpeg, or an ffmpeg without `v360`, gives one clear message with what to
   install, and nothing is written into the project.
6. **The original is not copied**, exactly like a drone clip that gets a review copy: `walk.json`
   keeps the file name, size and layout of the source, not its folder.
7. **Stitched MP4 through an explicit action.** **Add 360 video** (command palette) takes `.insv`,
   `.lrv`, `.mp4` and `.mov`. An MP4 is accepted when its frame is 2:1 or it carries spherical
   metadata that says equirectangular; anything else is refused with the reason. It is copied as
   it is when Chromium plays it comfortably (H.264, at most 3840 wide), otherwise a playback copy
   is made (ffmpeg needed, the `v360` filter not). The ordinary import still sends an MP4 down the
   drone path, so nothing changes for drone footage.
8. **Progress and cancel.** The stitch reports through the existing import panel
   (`builder:progress`, which gains an optional `part`): the file line reads "name.insv, playback
   copy 42 %" and the bar moves with it. **Cancel** in the import panel
   (`builder:cancelImport`) stops the import as a whole: ffmpeg is stopped, the staging folder of
   the walk in hand is removed, files whose turn had not come are listed as skipped and what was
   already imported stays. Quitting the app cancels the same way, so no ffmpeg is left running.
   There is no cancel per file, and a drone review copy in hand is finished first. The panel's
   Cancel shows only while main is importing; the page question of a PDF keeps its own. After a
   cancelled import its staged drawings are closed without being asked about or drawn. A failed stitch leaves no `walks/<id>/` folder behind:
   the walk is built in a staging folder of its own and moved into place last. In a drop of
   several files the manifest is saved before the first stitch starts, so photos and models do
   not wait for it. A finished stitch is never thrown away because of the move: a refusal by
   Windows while another program holds a file open is retried for about half a minute, and if it
   stays refused the folder is kept and the next import of the file adds it without stitching
   again. What an interrupted import leaves (quitting during a stitch) is removed at the next
   walk import and never goes into a package.
9. **Player.** A small three.js view of its own (`@aio/video`): the video is a texture on an
   inside-out sphere, the camera sits in the middle. Look and zoom use the panorama viewer's
   `dragLook`, `zoomLook` and `PANO_FOV` (`panoMath.ts`). It is not on the project clock: a walk
   has no place in time yet, so the pane has its own play, scrub and time readout, and the keys of
   the video window (K or Space, J, L, comma, period, arrows).
10. **Where it shows.** A **360 video** entry in the split view chooser (through `EXTRA_PANES`)
    when the project has a walk, and a short **360 video** list under the dataset tree; clicking a
    walk opens the split with the pane on the right.
11. **IPC.** `builder:import` gains the optional `as360`; one new read channel `walks:list`. No
    new event (`builder:progress` gains the optional `part`). Import items for walks use the
    existing kind `video`.

## Storage

```
walks/<id>/walk.json      aio.walk/1
walks/<id>/playback.mp4   equirectangular H.264, what the pane plays
walks/<id>/poster.jpg     one frame, at most 960 px wide (absent when ffmpeg could not make it)
```

`walk.json`:

```json
{
  "schema": "aio.walk/1",
  "id": "vid-20260101-120000-00-001",
  "name": "VID_20260101_120000_00_001",
  "createdAt": "2026-10-11T09:30:00.000Z",
  "source": {
    "file": "VID_20260101_120000_00_001.insv",
    "bytes": 1645660464,
    "layout": "insv-dual-stream",
    "trailer": true,
    "capturedAt": "2026-01-01T12:00:00",
    "streams": [{ "width": 2880, "height": 2880, "codec": "hvc1", "fps": 59.94 }]
  },
  "video": {
    "src": "walks/vid-20260101-120000-00-001/playback.mp4",
    "width": 3840,
    "height": 1920,
    "durationS": 81.9,
    "fps": 29.97,
    "audio": true
  },
  "poster": "walks/vid-20260101-120000-00-001/poster.jpg",
  "stitch": {
    "tool": "ffmpeg",
    "filter": "v360=input=dfisheye:output=e:ih_fov=195:iv_fov=195:w=3840:h=1920",
    "fovDeg": 195,
    "encoder": "libx264"
  }
}
```

`layout` is `insv-dual-stream`, `dual-fisheye` (one frame, as an `.lrv`) or `equirect` (no stitch,
no `stitch` block). `capturedAt` is the camera's local time from the file name, when the name has
one.

Packaging: a package carries every project file no layer owns, so `walks/` travels in a package
as it is (pinned by a test). Sync: `walks/` is not a journaled folder and not a manifest asset,
so a walk does **not** reach team mates through a hub or the Team Server yet; follow-up below.

## How the rest of W1 adopts it

- The walk becomes a layer by adding one manifest entry that points at files that already exist
  (`walks/<id>/playback.mp4`, the poster). A one-time step on open reads each `walk.json` and
  writes the layer; `walk.json` stays as the record of the source and the stitch. Nothing is
  re-encoded.
- Pose, stills, IMU and the raw path land beside it in the same folder, as the Walks design lists
  them (`walks/<id>/pose.json`, `stills/`, `imu.bin`, `raw-path.json`).
- Moving the stitch into `walk.process` (Python) later needs no storage change: the argument
  builder is the record of the filter, and `walk.json` keeps the filter it was made with.

## Open decisions for the founder (not built)

1. **Bundle ffmpeg or require it on the PATH.** Today every video feature (review copies,
   posters) already needs ffmpeg on the PATH and falls back quietly without it; 360 import cannot
   fall back. Options: (a) keep requiring it, with the clear message built here; (b) ship an
   ffmpeg build inside the installer (the full Windows build on this workstation is 242 MB for
   `ffmpeg.exe` alone, and it is under the GPL version 3 because it carries libx264; a smaller
   LGPL build has no libx264, so it would need a hardware encoder or OpenH264, and a size and
   licence check of its own); (c) put a GPL build in the pipeline pack, which is already under the
   GPL version 3 and already installed from Settings, and have the app prefer the pack's ffmpeg.
   **Recommendation: (c).** It adds nothing to the installer, it reuses a licence decision already
   taken (8 Oct), and it makes the review copies of drone clips work for testers who never
   installed ffmpeg. Until then (a) stands.
2. **Walks as a layer.** The Walks design makes a walk a `video` layer with an `equirect` lens,
   and falls back to a new layer kind `walk` if shipped builds refuse an unknown lens. They do
   refuse it (the lens model is a strict union), so the design's own fallback applies.
   **Recommendation:** a new layer kind `walk`, added in the release where placing (W2) lands, so
   testers meet the layer and its first real use together; builds from 0.10 on hide a kind they do
   not know, older ones refuse the project, which the upgrade note has to say. The side folder
   migrates as described above.
3. **Motion data from the `.insv` trailer.** The trailer holds the camera model, the per-lens
   calibration and about 1 kHz gyro and accelerometer samples. Reading the model and calibration
   would let the stitch use the true field of view and lens centres (better seams) and name the
   camera in the app; the motion data is needed for world-locked viewing and the path in W2 and
   W3. **Recommendation:** a small reader of our own in TypeScript for the model and calibration
   records first (no dependency, testable with a few kilobytes of fixture), and the motion samples
   in the Python pipeline when `walk.process` is built, where `telemetry-parser` or the same
   record walk can run.

## Follow-ups noted, not built

- A quick preview from the `.lrv` while the stitch runs. Cancel per file.
- Showing the photos and models of a mixed import while its 360 video is still being stitched:
  they are saved before the stitch, but the app receives the manifest only when the import
  returns. A re-read of the manifest at the first stitch progress would do it; left for a change
  with its own review.
- Chapter joining (`_001`, `_002` with the same time stamp): each chapter imports as its own walk.
- Removing or renaming a walk from the app (delete the `walks/<id>/` folder by hand for now).
- Sync of `walks/` through hubs and the Team Server; a walk list for an open package is built,
  but a package made before this build has no walks.
- A survey date for a walk: `capturedAt` is stored, nothing reads it yet.
- Seam quality: fixed 195 degree lenses, no blending; faint seams at the quarter lines.
- A top-bottom or side-by-side stereo 360 MP4 with a 2:1 frame is accepted as a mono video and
  shows both eyes; only the projection is read from the metadata, not the stereo mode.
- The player does not handle a lost graphics context: after the graphics card resets, the pane
  stays blank until another walk is chosen or the pane is closed and opened again.
- A walk cannot be left out of a package: every finished walk goes into every package, however
  large (the package dialog lists layers only).
- While an import runs, a second import (also "Add 360 video", also after switching project) does
  nothing and says nothing: the files picked are dropped silently by the import store's busy
  guard. A message, or a queue, is owed.
- `VideoAnnotator` (`packages/annotate`) listens for K, I and O on the window without looking at
  `defaultPrevented`. The 360 player stops its own keys from reaching it; the annotator itself
  was left as it is (another package, with its own tests).
- Staging folders are owned per process: two copies of the app importing into one project folder
  at once could clear each other's staging folder.

## Contract

- New file schema `aio.walk/1` (`WalkFile`, `walks.ts`), registered in `versions.ts`.
- `builder:import` request gains the optional `as360` (boolean); event `builder:progress` gains
  the optional `part` (0 to 1 inside one long file).
- New IPC channel `walks:list` (`{ projectId }` to `{ walks: WalkFile[] }`), read only.
- New IPC channel `builder:cancelImport` (`{ projectId }` to `{ ok }`): cancels the running import
  of a project as a whole.
- New project folder `walks/<id>/` (data-conventions section 32).

One row in `docs/architecture/contract-changes.md`, approval "pending founder review".

## Testing

- Unit: the name and layout recogniser, the equirectangular check, the MP4 track reader (a
  two-track file built in the test), the ffmpeg argument builder, the progress parser, the walk
  importer with fake tools (staging, no folder left after a failure, ffmpeg missing leaves the
  project untouched), the raw importer branches, the schema and registry row, the package plan,
  the sphere orientation, the pane model.
- End to end (`walk-360.spec.ts`): ffmpeg makes a tiny two-stream clip and a tiny 2:1 MP4 inside
  the test; the clip is imported through the file dialog, the pane opens from the list, plays,
  scrubs, looks around and zooms; the MP4 goes through **Add 360 video**. Skipped when ffmpeg or
  its `v360` filter is missing. No assertion on rendered pixels.
- Real footage: the first 5 seconds of one reference clip, stitched once with the built
  arguments, to confirm the filter outside synthetic input. Result recorded in the plan.
