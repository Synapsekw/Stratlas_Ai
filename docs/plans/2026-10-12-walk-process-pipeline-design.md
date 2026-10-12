# Walks 360: the `walk.process` pipeline (W1 rest, W2 path)

Status: spec written 12 Oct 2026 by a scoping session, decisions taken with the recommended options
and **pending founder confirmation** (see "Decisions taken"). Builds on
`2026-10-07-walks-360-design.md` ("Processing: walk.process", "Data model", "Open items") and the
front slice in `2026-10-11-insta360-native-design.md`. Branch `feat/walk-process-pipeline`.

## Problem

A walk can be imported and played (front slice, 0.11), but nothing knows where the camera was or
how it was turned. Raw `.insv` playback copies are stitched with a fixed 195 degree lens guess (faint
seams at the quarter lines) and wobble with every step of the selfie stick. Placing (W2, sibling
branch `feat/walk-layer-and-placing`), the world-locked viewer (W3) and compare (W5) all need what
this pipeline writes: the camera orientation, a path shape, stills and sparse points.

## Intended outcome

One job, `walk.process`, run on an imported walk, that writes into `walks/<id>/`:

1. a **levelled playback copy** (`stabilized.mp4`) stitched with the camera's own lens calibration,
   horizon held level, yaw following the walker;
2. the **orientation** of the camera per video frame (`orientation.bin`) and the decimated motion
   data (`imu.bin`);
3. the **raw path** (`raw-path.json`): position and orientation per still in the SfM frame, the
   segments, the up direction, the standing stretches; or a pins-only record when SfM fails;
4. **sparse points** (`sparse.ply`) for the later ICP refinement;
5. **map stills** (`stills/<n>.jpg`) about 1 m apart;
6. a run record (`process.json`) naming all of the above, the times per stage and the versions.

Success: the synthetic walk in CI is recovered within tolerance (path shape, orientation, levelled
horizon); the founder's reference walk processes locally with every still registered; a 15 minute
walk processes in 30 minutes or less on a laptop CPU (measured in a founder-given window, not in CI).

## Boundary with `feat/walk-layer-and-placing` (founder decision 1)

| This branch (`feat/walk-process-pipeline`)                                                                        | Sibling (`feat/walk-layer-and-placing`)                                                           |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Writes files into `walks/<id>/` only; never writes the manifest or `walk.json`                                    | Owns the `walk` layer kind, `WalkCalibration`, `WalkPin`, the migration of `walk.json` to a layer |
| New schema file `packages/schema/src/walkProcess.ts`: `aio.walk-process/1`, `aio.walk-path/1`, the binary layouts | Owns `packages/schema/src/walks.ts` and the layer union in the manifest schema                    |
| `PipelineName` `walk.process` and `WalkProcessParams` in `jobs.ts`                                                | Reads `raw-path.json`, `stills/`, `orientation.bin`; writes `pose.json` from the fit              |
| `walks:list` response gains the optional `processed` map (per walk id, a `WalkProcessSummary`)                    | Its layer carries `walk.raw = walks/<id>/raw-path.json` and the `source` from it                  |
| The 360 pane prefers `stabilized.mp4` when present; **Process walk** action; auto-start after import              | Placing UI, pins, fit, quality badge                                                              |

The job takes the **walk id** (the folder name), not a layer id, so it does not depend on the layer
kind landing first. When the sibling's layer exists it carries the same id. `raw-path.json` is the
single hand-over file; its schema is frozen by this branch in task T1 and the sibling imports it from
`@aio/schema`. A merge-order note: either branch can land first; if the sibling lands first it
reads `raw-path.json` when present and shows "Not processed" otherwise.

## Decisions taken (founder to confirm)

Asked and answered in brainstorming with the recommended option:

1. **Trailer reader: our own Python record walker, not `telemetry-parser`.** Verified 12 Oct 2026:
   PyPI's JSON for `telemetry-parser` lists 0.3.0 (latest) with wheels for cp37 to cp312 and PyPy
   only, no cp313 and no abi3 wheel; `uv pip compile --python-version 3.13 --python-platform
x86_64-pc-windows-msvc --only-binary :all:` refuses it ("we only found wheels ... cp37m, cp38,
   cp39, cp310, cp311, cp312"). The pack's Python is CPython 3.13 (`requires-python = ">=3.13,<3.14"`
   in `python/pyproject.toml`), and source builds of natives are out (founder, 8 Oct). The record
   layout follows telemetry-parser's Insta360 module (MIT OR Apache-2.0), credited in the notices;
   only numpy, no new dependency. A tiny protobuf field walker reads the metadata record.
2. **Our own stitcher in Python (OpenCV `remap`), not ffmpeg `v360`, for the levelled copy.**
   `v360` takes one field of view for both lenses and no lens centres, and changing its rotation
   per frame rebuilds its maps every frame. Our map is the calibrated fisheye model composed with
   the frame's levelling rotation, computed at quarter size and upsampled (maps are smooth), then one
   `cv2.remap` per frame with a feathered seam. ffmpeg decodes (both lens streams side by side, raw
   frames on a pipe) and encodes (H.264, the playback copy's settings). One decode pass serves the
   levelled copy and the stills.
3. **Levelling removes pitch and roll only; yaw follows the walker.** A fully locked yaw makes a
   walk feel like a turntable; the world-locked view of W3 rotates the sphere in the player
   instead. The run records the yaw it kept so W3 can undo it.
4. **Orientation from a complementary filter** (gyro integration, accelerometer gravity correction
   with a small gain, gain reduced while the acceleration magnitude is far from 1 g). Gyro bias from
   the first standing stretch. Output at the video frame rate.
5. **`walk.json` keeps the import's playback copy; the levelled copy is a second file**,
   `stabilized.mp4`. The pane plays it when present, with a **Level horizon** toggle (on by default)
   to fall back to `playback.mp4`. Nothing the import wrote is replaced, so a failed job never
   breaks a walk that plays.
6. **The job takes the original file as `src`; without it, it works from `playback.mp4`.** An
   `.insv` gives the calibration and motion data; a stitched MP4 or a missing original gives no IMU:
   no levelled copy is written (nothing to level by), SfM still runs on stills from
   `playback.mp4`, up from the mean camera down axis. `src` accepts chapter files of one clip
   (`_001`, `_002` with the same stem, in order) so the contract is ready; grouping chapters into one
   walk at import stays a follow-up.
7. **Auto-start after import, cancellable.** When an import adds a walk, the renderer starts
   `walk.process` with the source path it already has (it passed it to `builder:import`), shown in
   the jobs panel like any job. A walk imported earlier gets **Process walk** in the 360 video list;
   for an `.insv` walk the person locates the original in a file dialog (filtered to its name), or
   chooses **Without the original** to process from the playback copy.
8. **Stills.** Decoded at 2 per second; stills inside a standing stretch are dropped except its
   first and last. Standing comes from the accelerometer (moving variance of the magnitude under a
   threshold for 1.5 s or more); without IMU from frame difference on 256 px greys. SfM stills are
   half size (1920 x 960 for the X4), kept in the job's stage folder only. Map stills are full
   size (at most 3840 x 1920, JPEG quality 88), picked about 1 m apart by step count (stride
   0.7 m, `strideM` param), never more than one per second of walking.
9. **SfM.** pycolmap 4.2.1 (already a dependency), one shared `EQUIRECTANGULAR` camera with no
   refinement, SIFT on the SfM stills with the bottom quarter masked (`maskBottom`, default 0.25),
   sequential matching (overlap 10, no loop detection in this version), incremental mapper. Walks
   longer than 300 stills run in chunks of 300 with 40 stills of overlap, each chunk its own
   reconstruction, joined by a 7-parameter similarity (Umeyama) on the camera centres of the shared
   stills; a chunk that does not join, or a reconstruction that splits, becomes a new segment. Up
   direction from gravity (IMU orientation versus SfM rotation per registered still, averaged) or,
   without IMU, the mean camera down axis.
10. **Pins-only fallback.** Under 60 % of stills registered, or SfM raising: `source: 'pins-only'`,
    every still keeps `t`, cumulative step count and orientation from the gyro; no positions. The job
    finishes green with a warning, never red, so the walk can still be placed by pins.
11. **ffmpeg ships in the pipeline pack** (founder decision 3) at `tools/ffmpeg/`, conda-forge's
    prebuilt `ffmpeg` (GPL build with libx264, v360 and the HEVC decoder), installed by the same
    micromamba lock machinery as PDAL (`tools/pipeline-pack/pdal.mjs` generalised), SHA-256
    pinned, licences in the notices and `native-libs.json`. Fallback if conda-forge's build lacks
    libx264 on Windows: BtbN's pinned `win64-gpl-shared` release zip with its SHA-256. Python finds
    it in this order: `QUADRION_FFMPEG`, `<pack>/tools/ffmpeg`, the PATH (`find_tool`). The app's
    import and review copies prefer the pack's ffmpeg the same way (`findFfmpeg` beside
    `findPdal`), so testers without ffmpeg get stitching too.
12. **Steps are resumable job steps**: `read`, `frames` (one decode pass: levelled copy, SfM stills,
    map still candidates), `sfm`, `finish`. A cancelled or crashed job resumes from the last finished
    step (the runtime's step manifests).
13. **Pack version 0.6.0** (new pipeline, new tool); `APP_RANGE` unchanged; the app greys
    **Process walk** with "Needs pipeline pack 0.6.0" when the installed pack does not list
    `walk.process`.
14. **Benchmark only in a founder-given window.** `python/scripts/walk_bench.py <file>` (and
    `pnpm bench:walk`) prints the time per stage and writes it to a JSON beside the job; a pytest
    marked `bench` runs it when `QUADRION_WALK_BENCH` names a file, skipped otherwise and in CI. The
    agent never starts it on its own.
15. **Test data.** CI uses only synthetic walks rendered by the tests; the founder's reference walk
    stays local (`QUADRION_WALK_REFERENCE`, skipped when unset), and no real footage, file name or
    site name enters git.

## Inputs

| Input                                  | Calibration                 | Motion data    | Levelled copy       | Stills from              |
| -------------------------------------- | --------------------------- | -------------- | ------------------- | ------------------------ |
| `.insv` with the trailer (X4 verified) | from the trailer            | yes            | yes                 | the source, calibrated   |
| `.insv` without the trailer            | 195 degree default          | no             | no                  | the source, default lens |
| `.lrv` imported alone                  | from its trailer if present | yes if present | yes, low resolution | the source               |
| equirect MP4, or no `src` given        | none needed                 | no             | no                  | `playback.mp4`           |

X3 and X5 are not claimed until a sample of each is read (open item of the Walks design, unchanged).

## The trailer

An Insta360 file ends with the 32 character mark. Walking back from the end: a fixed footer
(trailer length, version, mark), then records, each a payload followed by a small header with its
id and length. The reader (`walk/trailer.py`) walks the records and keeps:

- **metadata** (protobuf): camera model, serial, firmware, the lens calibration string (`offset`,
  per lens: centre x, centre y, radius, and three rotation angles; later formats add more
  fields), the capture time;
- **gyro and accelerometer** samples (timestamp in ms, three accelerations in g, three rates in
  rad/s; two encodings exist by firmware, both handled);
- **frame timestamps**, to tie samples to video frames (fallback: the sample clock started at the
  first frame).

Exact ids, byte layouts and units are confirmed in task T2 against the reference X4 file (locally)
and pinned by a fixture extracted from it (the trailer only, a few hundred motion samples, the
serial and anything identifying replaced). Every unknown record is skipped; a damaged trailer gives
"no motion data" with a warning, never a crash.

**Lens model.** Equidistant fisheye per lens (`r = f * theta`), with the centre and radius from
`offset` and `f` from the radius and the lens field of view; the per-lens rotation from the three
angles. If T2 finds the X4 needs a polynomial term, it is added there and recorded in the plan.
Without a calibration the default is centred, 195 degrees, no rotation (what the import does today).

## Files written

```
walks/<id>/process.json      aio.walk-process/1   the run record (always, last)
walks/<id>/raw-path.json     aio.walk-path/1      per still: t, pos, q, segment; or pins-only
walks/<id>/orientation.bin   float32 LE, 5 columns: t, qw, qx, qy, qz; one row per video frame
walks/<id>/imu.bin           float32 LE, 7 columns: t, ax, ay, az, gx, gy, gz; 200 Hz
walks/<id>/sparse.ply        binary PLY, x y z red green blue, SfM frame
walks/<id>/stills/<n>.jpg    map stills, n zero-padded to 5 digits
walks/<id>/stabilized.mp4    levelled playback copy (the playback copy's encoding settings)
```

Frames: camera frame x right, y down, z forward at the picture centre (yaw 0); `orientation.bin`
rotates camera to a gravity-aligned frame (z up), yaw relative to the first frame. Times are
seconds of the playback copy. Binary layouts are named in `process.json` (`columns`, `rateHz`)
so a reader never guesses.

`aio.walk-process/1`: `schema`, `walk`, `createdAt`, `engine` (version, pycolmap version, ffmpeg
version), `input` (`file` name only, `layout`, `calibration` `trailer` or `default` with the lens
values used, `imu` true or false, `camera` model when read), `outputs` (paths, each optional),
`stabilize` (`levelled` true or false, `keptYaw` true), `stills` (`sfm` count, `map` count),
`path` (`source` `sfm` or `pins-only`, `registeredFraction`, `segments` count), `timings` (seconds
per stage), `warnings[]`.

`aio.walk-path/1`: `schema`, `walk`, `source` (`sfm` or `pins-only`), `up` ([x, y, z] in the SfM
frame, absent for pins-only), `scale: 'arbitrary'`, `segments[]` (`id`, `fromT`, `toT`),
`standing[]` (`fromT`, `toT`), `stills[]` (`n`, `t`, `steps`, `registered`, optional `pos`
[x, y, z], `q` [w, x, y, z] camera to SfM frame, `segment`, optional `map` (the `stills/` file
when this still is also a map still)).

Both are additive new file families: `versions.ts` rows, `home: project`; older builds never read
`walks/` (data-conventions section 32 gains them).

## App side (small)

- `walks:list` response: optional `processed: Record<walkId, WalkProcessSummary>` (from each
  `process.json` that reads: `createdAt`, `stabilized` path if any, `path.source`, `warnings`
  count). `WalkFile` is untouched.
- 360 pane: plays `stabilized.mp4` when the walk has one, **Level horizon** toggle beside play.
- 360 video list: per walk a status (`Not processed`, `Processing 42 %`, `Processed`,
  `Processed, path from pins only`), **Process walk** (with the locate-original dialog), and the
  job's progress from the jobs store.
- Auto-start after an import that added a walk (decision 7).
- Main: `findFfmpeg` (pack, env, PATH) used by the walk import and the review copies.

## Failures

| Case                                    | Behaviour                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------- |
| No ffmpeg anywhere                      | job refused at validate with the install text (the pack has one, so rare) |
| `src` missing, moved or of another size | refused: "The original <name> was not found or has changed"               |
| Trailer damaged or absent               | warning, default lens, no IMU, no levelled copy                           |
| SfM under 60 % or raising               | `pins-only`, warning, job green                                           |
| Chunk does not join                     | new segment, warning names the time range                                 |
| Disk too small (stills + copy estimate) | refused before the decode pass (`check_disk`)                             |
| Cancel                                  | ffmpeg processes killed (`run_tool` tree kill), staged files dropped      |

## Testing

- **Synthetic walk (CI).** A test helper renders a procedural textured scene (a room-sized box with
  noise texture and a few boxes inside) into two equidistant fisheye streams along a known path with
  a known orientation (yaw turns plus a pitch and roll wobble of a few degrees at step frequency),
  encodes them as a two-stream MP4 with ffmpeg, and appends a synthetic trailer (metadata with a
  known `offset`, motion samples from the known orientation plus noise and a gyro bias). 12 s at
  15 fps, 640 px lenses, so it runs in under a minute. Asserts: trailer read back exactly;
  orientation within 1 degree of truth; levelled copy horizon within 1.5 degrees (measured on the
  rendered scene's horizontal edges at known yaws); SfM registers at least 90 % with path shape
  error under 2 % of length after a similarity alignment; pins-only when the texture is blanked;
  outputs validate against the schemas (a JSON round trip through the TypeScript schemas in a
  vitest that reads a golden output).
- **Unit (Python):** record walker (fixture, damaged trailers), protobuf walker, offset parser,
  complementary filter (synthetic rates), standing detection, still picking, fisheye map (known
  directions), chunk join (Umeyama on synthetic centres), up from gravity, binary writers.
- **Unit (TS):** `WalkProcessParams`, the two file schemas and `versions.ts` rows, `walks:list`
  `processed`, `findFfmpeg`, the pane's source choice, the list status model, auto-start rule.
- **Pack:** `ffmpeg.mjs` lock and check (`-filters` has `v360`, `-encoders` has `libx264`,
  `-decoders` has `hevc`), `build.test.mjs` sees `tools/ffmpeg`, native licence entries.
- **e2e:** `walk-360.spec.ts` extended: after importing the synthetic two-stream clip, the job
  starts, finishes, the list says **Processed**, and the pane plays `stabilized.mp4` with the
  toggle. Uses a tiny synthetic clip so it runs in CI; skipped when the pipeline pack is not
  available to e2e (as the other job specs do).
- **Local only:** the reference walk (`QUADRION_WALK_REFERENCE`): every still registered,
  orientation sane, seams visibly better (founder looks at it).
- **Benchmark:** founder window only (decision 14).

## Out of scope

Placing, pins, fit, `pose.json` (sibling); world-locked viewing (W3); overlays and ICP (W4);
compare (W5); chapter grouping at import; loop closure; X3 and X5 claims; GPU decode or feature
extraction (benchmark knob only); stella_vslam.
