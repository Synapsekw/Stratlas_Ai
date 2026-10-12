# Walks 360: the walk layer, placing a walk and its path

Date: 12 Oct 2026. Branch: `feat/walk-layer-and-placing`. Status: spec written by a scoping agent
from the founder's decisions of 12 Oct; the choices the founder did not make are listed under
"Decisions taken (founder to confirm)".

Parent design: `2026-10-07-walks-360-design.md` (part W2, "Path and placing", without the
`walk.process` pipeline and without PDF import, which round 85 already built as drawings). The
front of W1 is `2026-10-11-insta360-native-design.md`.

## What the founder decided (12 Oct 2026)

1. A walk becomes a **new layer kind `walk`**, not a `video` layer with an `equirect` lens (shipped
   builds refuse an unknown lens model; the design's own fallback applies).
2. Existing side-folder walks (`walks/<id>/walk.json`, `aio.walk/1`) **migrate to layers on open**.
3. An **upgrade note** is needed: builds 0.9 and older refuse a project that holds a layer kind they
   do not know (0.10 and later keep it as an opaque layer, M10 G0).
4. Placing works on **drawings only** (some projects have nothing else) or on the **map / model**.
5. A separate branch, `feat/walk-process-pipeline`, builds `walk.process`: it writes
   `raw-path.json`, stills, `sparse.ply` and an orientation file into `walks/<id>/`. This branch
   owns the layer, `WalkCalibration` / `WalkPin`, the pose file, the pure TypeScript fit, the
   **Place walk** UI and the path on the map and the drawing. It builds against a synthetic
   `raw-path.json` fixture so it does not wait for the pipeline.

## Who uses it, and what success looks like

A site engineer or the reviewer back in the office has walked the site with a 360 camera and
imported the clip (W1, already built). The walk sits in the project as a video with no place. They
want to say "I started here, I ended there" on the plan they have (often a PDF sheet, sometimes a
drone map), see the whole walk drawn on that plan, nudge it where it drifts, and close the job in
under two minutes. Success: two clicks after the walk opens, the path is on the sheet; a third pin
fixes a drift; the walk reopens placed, on the same sheet, after a restart and on a team mate's
machine.

## Scope

In:

- The `walk` layer kind, its schema and the migration of side-folder walks.
- The schemas of the files `walk.process` writes that this branch reads: `raw-path.json`
  (`aio.walkpath/1`) and `orientation.json` (`aio.walkorient/1`). **This branch owns them**, so the
  pipeline branch writes to a contract that exists (see "Merge order").
- `WalkCalibration`, `WalkPin`, the pose file `walks/<id>/pose.json` (`aio.flight/1`).
- The fit, in pure TypeScript: 2-pin similarity, piecewise blend for 3 or more pins, broken paths,
  pins-only by step count, the quality badge.
- **Place walk**: the Needs placing badge, a survey date when the walk has none, the **Place on**
  picker, start and end pins, **Pin here**, dragging pins, **Align view**, the yaw offset.
- The path line, the still dots, the pins and the current position dot on the drawing pane and on
  the map.
- The smaller points: walks sync through hubs, a walk can be left out of a package, `capturedAt`
  becomes the survey date, **Remove walk**.

Out (later parts or other branches):

- `walk.process` itself (the pipeline branch).
- The 3D view: no path or camera marker in 3D, and the 3D view is not a **Place on** surface in this
  branch (W3, with the 3D path; see decisions).
- The project clock: the walk is not on the project timeline yet; placing uses the 360 pane's own
  time (W3).
- Click-to-seek on the path, chevrons, world-locked viewing, sharp stills on pause (W3).
- ICP refinement and **Align overlay** (W4); compare across dates (W5).
- Ground height from a mesh, terrain or DSM (W3/W4): this branch uses the height a pin carries.

## Data model

### The layer

```ts
// packages/schema/src/layers.ts, new member of the Layer union
{
  kind: 'walk',
  ...base,                       // id, name, visible, capture?, derived?
  record: AssetRef,              // walks/<id>/walk.json (aio.walk/1): source and stitch, unchanged
  src: AssetRef,                 // walks/<id>/playback.mp4
  poster?: AssetRef,             // walks/<id>/poster.jpg
  durationS: number,             // from walk.json, so the list needs no extra read
  path?: {                       // set once walk.process has written its files
    raw: AssetRef,               // walks/<id>/raw-path.json (aio.walkpath/1)
    orientation?: AssetRef,      // walks/<id>/orientation.json (aio.walkorient/1 header)
    orientationData?: AssetRef,  // walks/<id>/orientation.bin (the header's data file)
    points?: AssetRef,           // walks/<id>/sparse.ply (W4 reads it)
  },
  place?: WalkCalibration,       // absent: never placed
  flight?: FlightRef,            // walks/<id>/pose.json, written when the walk is placed
}
```

- The layer id is `walk-<walk id>` (the walk id is the folder name, already lower-case letters,
  digits and dashes).
- `walk.json` stays the record of the source and the stitch. The layer repeats only what the app
  needs without reading it (`durationS`, the paths).
- `path` is filled by the app when it finds `raw-path.json` in the walk's folder (at open and after
  a `walk.process` job finishes; the job record names the layer). The pipeline branch does not
  write the manifest.

### WalkCalibration and WalkPin

```ts
type WalkPin = {
  t: number; // seconds into the playback copy
  surface: string; // a plan raster layer id (a drawing), or '@model'
  at: [number, number]; // drawing: image pixels [x, y] (y down); '@model': model [x, z]
  y?: number; // ground height in the model frame, when the pick knew it
};

type WalkCalibration = {
  pins: WalkPin[]; // sorted by t; at most 64
  yawOffsetDeg: number; // manual heading correction on top of the fit, -180..180
  heightM: number; // camera height above the ground, default 1.7
  quality: 'good' | 'check' | 'poor' | 'unplaced';
  placedOn?: string; // the surface the Place on picker last showed (UI only)
};
```

Changes from the parent design, and why:

- `raw`, `source` and `segments` are not in the calibration: they come from `raw-path.json`,
  which the pipeline owns. The calibration holds only what a person decided.
- A pin's surface is either a drawing (a plan raster) or `'@model'`, the model frame itself. A pin
  dropped on the map or on an ortho is stored in the model frame: orthos do not move once
  imported, and the map is the model frame through the project's coordinate system. A pin on a
  drawing is stored in the drawing's pixels, so **placing the drawing again moves the walk with
  it** (parent design, decision 5).
- `refine` (ICP) waits for W4; it is a new optional field then.

### `raw-path.json` (`aio.walkpath/1`), written by `walk.process`

```ts
type WalkRawPath = {
  schema: 'aio.walkpath/1';
  walk: string; // walk id
  source: 'sfm' | 'pins-only'; // pins-only: fewer than 60 % of stills registered
  up?: Vec3; // the raw frame's up direction (from gravity, or camera down axes)
  stills: {
    n: number; // still index, file walks/<id>/stills/<n>.jpg when kept
    t: number; // seconds into the playback copy
    pos?: Vec3; // raw frame; absent when not registered
    q?: Quat; // raw frame camera orientation (three.js camera axes)
    segment?: number; // SfM model piece; absent when not registered
    steps: number; // cumulative step count at t (for pins-only)
  }[];
  walking?: { startT: number; endT: number }; // first and last walking moment
  kept?: number[]; // still indices saved as full-resolution stills
};
```

### `orientation.json` (`aio.walkorient/1`), written by `walk.process`

The pipeline's orientation runs at up to 1 kHz, too much for JSON. So it is a small JSON header
plus a binary data file (settled with the pipeline branch, 12 Oct):

```ts
type WalkOrientation = {
  schema: 'aio.walkorient/1';
  rateHz: number; // nominal sample rate, 1 to 2000
  count: number; // records in the data file
  convention: 'xyzw-camera-threejs'; // quaternion order and axes: three.js camera (+X right, +Y up, looks down -Z)
  frame: 'raw'; // the same frame as raw-path.json's stills
  startOffsetS: number; // playback time of t = 0 in the data file, seconds
  data: string; // file name of the data file in the same folder, e.g. "orientation.bin"
  layout: 'f32le-t-xyzw'; // see below
};
```

`orientation.bin` (`layout: 'f32le-t-xyzw'`): `count` records of 20 bytes, each five
little-endian float32 values `[t, qx, qy, qz, qw]`, no header. `t` is seconds after
`startOffsetS` (playback time = `startOffsetS + t`), strictly increasing; quaternions are unit
length (readers normalise and drop a record that is not finite). A file whose length is not
`count * 20` is refused as a whole.

The rows are used as a relative rotation, anchored at the stills: at a moment between stills, the
turn the rows make since the nearest still of the same segment is applied to that still's `q`. So
`q` in the two files does not have to agree at the stills; only the turn between two moments is
read from the rows. (Correction of 12 Oct, after the build: the spec first asked that both agree
at the stills.)

Absent orientation file (or a refused one): the pose takes the stills' orientation, slerped.

### The pose file

`walks/<id>/pose.json` is a normal `aio.flight/1` file, written by main from the raw path, the
orientation, the calibration and the current placement of every drawing a pin is on:

- `lens: { model: 'pinhole', hfovDeg: 90, aspect: 2 }` (a placeholder every 1.x reader accepts;
  the walk layer, not the lens, says the video is equirectangular).
- Samples at 30 per second with an orientation file (decimated from it) or 10 per second
  without one, positions through the fit,
  `q = Ry(fitYaw + yawOffset) * qRaw` in the model frame, `y = ground + heightM`.
- `startUtcMs` from `capturedAt` read as UTC (the camera's local time has no zone; W3 puts the walk
  on the project clock and may correct this).
- Rewritten when the walk's calibration is saved, when a drawing a pin is on is placed again, and
  when `raw-path.json` changes. Never written while a person drags a pin: the live fit runs in the
  renderer.

### Files in the project

```
walks/<id>/walk.json            aio.walk/1 (W1, unchanged)
walks/<id>/playback.mp4         W1
walks/<id>/poster.jpg           W1
walks/<id>/raw-path.json        aio.walkpath/1, walk.process
walks/<id>/orientation.json     aio.walkorient/1 header, walk.process
walks/<id>/orientation.bin      its float32 records, walk.process
walks/<id>/process.json         the pipeline's own run record (its schema, not this branch's)
walks/<id>/sparse.ply           walk.process (W4 reads it)
walks/<id>/stills/<n>.jpg       walk.process
walks/<id>/pose.json            aio.flight/1, this branch, written on save
```

## The fit (`@aio/geo`, `walk/`)

All of it is pure functions over plain arrays, run live in the renderer and again in main when the
pose file is written. Both call the same code, so what the person sees is what is saved.

1. **Horizontal raw path.** Rotate the raw positions so `up` is +Y (or the mean of the stills'
   camera down axes when `up` is absent) and keep `[x, z]`.
2. **Pin targets.** Each pin becomes a model `[x, z]`: `'@model'` pins as they are, drawing pins
   through the drawing's corners (`x = a*px + b*py + tl.x`, `z = c*px + d*py + tl.z`, the same
   affine `placementFor` writes). A pin on a drawing that no longer exists is **inactive**.
3. **Raw position at a pin.** The raw path interpolated at the pin's `t` (linear between the two
   registered stills around it).
4. **Two active pins:** one 2D similarity (scale, rotation, translation) that maps the raw position
   at each pin onto its target exactly. Pins less than 5 m apart on the target, or at the same
   raw position, are refused with "Put the end pin at least 5 m from the start" (market practice).
5. **Three or more:** one similarity per stretch between consecutive pins, each exact at both of
   its pins. Before the first and after the last pin the nearest stretch's transform holds. At each
   inner pin the two neighbouring transforms are blended over a window of 2 s either side
   (smoothstep weight) so the path stays continuous and has no kink. Each pin records its
   **residual**: how far the fit without that pin put the path from it ("was 3.2 m off").
6. **A broken path** (stills in several `segment`s): each segment is fitted with the pins inside it.
   A segment with two or more pins gets its own fit; one pin: the neighbouring fit's rotation and
   scale, translated to that pin; none: positions interpolated by time between the last point
   before and the first point after it, drawn dashed, and the badge says "Path broken 3:12 to
   3:20: add a pin after the gap".
7. **Pins-only** (`source: 'pins-only'`, or no `raw-path.json` yet): positions between pins
   interpolated by the stills' cumulative `steps` (by time when steps are all zero); before the
   first and after the last pin the walk stays at that pin. Heading comes from the direction of
   travel; the yaw offset still applies.
8. **Heading.** The fit's rotation applied to the raw orientation, plus `yawOffsetDeg`. The
   orientation rows are a relative rotation anchored at the nearest still of the same segment
   (see `orientation.json` above).
9. **Quality:** `unplaced` with fewer than two active pins; `poor` when any residual is above 2 m;
   `check` when any residual is above 0.5 m, a segment has no pin, a pin is inactive, or the walk is
   pins-only; else `good`. A walk placed with exactly two pins has no residuals and is `good`
   unless one of the other rules applies.
10. **Not to scale:** when every pin is on one drawing whose `placement.json` is still provisional,
    the walk shows correctly on the sheet and distances read "not to scale".

## Placing a walk: the flow

The 360 pane is on one side of the split, the surface on the other. A **Place walk** strip sits
over the surface pane, the way **Place on the site** sits over a drawing today.

0. **A date first.** A walk with no survey date asks for one in the strip: the date of
   `capturedAt` when the project has it, else a list of the project's dates, plus **Add survey
   date <date of capturedAt>** when that date is not one of them (`builder:ensureCapture`, which
   already exists). The answer is saved as the layer's `capture` (`LayerPatch { capture }`) before
   the surface is chosen.
1. **Place on.** A picker lists the drawings of the walk's date, then drawings with no date, then
   **Map** (only when the project has a coordinate system). Choosing a surface opens it in the
   surface pane. The last choice is remembered on the walk (`placedOn`).
2. **Start.** The video jumps to `walking.startT` (or 0). The strip reads "Where did the walk
   start? Click the spot." One click drops pin 1.
3. **End.** The video jumps to `walking.endT` (or the end). One click drops pin 2. The whole path
   appears with its still dots.
4. **Correct (optional).** Scrub the 360. **Pin here** arms a click on the surface for the current
   time. Pins can be dragged; the path follows live. A pin's menu removes it. Each extra pin shows
   its residual.
5. **Heading.** **Align view**: click a landmark in the 360, then the same landmark on the surface;
   the yaw offset is set so the 360's direction to it matches. A yaw field (degrees, arrow keys
   step 1, Shift 10) sets it by hand. Once placed, a small north tick shows at the top edge of the
   360 view.
6. **Save** writes the calibration (and the pose file). **Cancel** leaves the walk as it was.
   Closing the strip with unsaved pins asks inline ("Keep these pins?"), never in a modal.

A walk without `raw-path.json` (not processed yet, or processed by an older pipeline) can still be
placed pins-only: the strip says "Path not computed: the walk is placed between your pins" and the
badge stays `check`.

### What the surface shows

- **Path line** in the colour of the walk's survey date (`--date-N`), 2 px, round joins; a dashed
  stretch where a segment has no pin; at 60 % opacity outside Place walk.
- **Still dots** at every kept still, 3 px, same colour, drawn under the line ends.
- **Pins**: numbered markers in the order of time, the one under the pointer raised; an inactive
  pin is drawn hollow with "the drawing it was on is gone". Pins show only for the walk being
  placed: they are placing tools, and outside Place walk the path and the stills are enough.
- **Current position**: a dot with a short heading tick at the 360 pane's current time, only
  while Place walk is open (the project clock drives it in W3).
- On the drawing pane, everything is drawn in image pixels at a constant screen size (as the place
  marks are today). On the map it is a GeoJSON overlay through `setOverlays`.
- A walk shows on a surface when it is visible and placed (or being placed there). Walks show on
  every drawing, not only the one they were placed on, because the path is in the model frame.

### Visual direction

The app's existing tokens, components and the drawing PlaceStrip layout; nothing new in colour or
type. Scene: a reviewer at a desk in a site office, daylight, two monitors, focused for two
minutes. The memorable thing is the path itself appearing at the second click, drawn in the date's
colour over the sheet; the strip around it stays quiet: one line of instruction, the step's single
primary button, and the yaw field. Steps are a real sequence, so the strip numbers them (Start,
End, Correct), and only the current one is primary. No modal anywhere in the flow; the date step and
the unsaved-pins question are inline in the strip.

## The walk in the Datasets list

- Walk layers move into the **Datasets** tree, in a **360 walks** group (`groupOf` gains
  `walk: 'walks'`), inside their date folder like every other layer. The separate **360 video**
  list under the tree (`WalkList.tsx`) goes away; its **Add 360 video** button moves to the group
  header.
- A row shows the walk's name, its length, and one badge: **Needs placing** (`unplaced`),
  **Check placing** (`check` or `poor`), **Path not computed** (no `path` yet, placed or not).
- Row actions: **Open** (the split with the 360 pane, as today), **Place walk**, **Remove walk**.

## Migration on open

When main opens a project folder:

1. Read every `walks/*/walk.json` that parses (the W1 `listWalks`).
2. For each walk with no layer whose `record` is that walk's `walk.json`, append a `walk` layer:
   id `walk-<id>` (the next free id when taken), name from `walk.json`, `capture` the project's date
   whose `date` equals the date part of `capturedAt` (none when no date matches or two do), `path`
   when `raw-path.json` and its siblings exist.
3. Save the manifest once if anything was added (through `keepUnknownLayers`, as every save).

A package opened read-only gets the same layers in memory only. A walk import (W1's
`importWalk`) writes the layer at once from now on, so migration is only for walks imported before
this build. The project log records "2 walks became layers".

**The upgrade note** (release notes and `docs/release/UPGRADE-POLICY.md`): "From 0.12, 360 walks
are layers. A project that holds a walk opens in 0.10 and later, which keep the walk as it is but do
not show it; 0.9 and older refuse to open it. Update every machine that opens such a project."

## The smaller points

- **Sync through hubs.** `layerFiles` (`@aio/sync`) gains `walk`: `record`, `src`, `poster`,
  `path.raw`, `path.orientation`, `path.orientationData`, `path.points`, `flight.src`. Fetch policy as `video` (on
  demand). Stills are not synced yet (nothing reads their pictures before W3; their positions are
  in `raw-path.json`).
- **Leaving a walk out of a package.** A walk layer owns its whole folder `walks/<id>/` in the
  package plan, so excluding the layer leaves the folder out. The package dialog gains a **360
  walks** group. A side-folder walk with no layer (only possible in a package made by 0.11) still
  travels as before.
- **`capturedAt` to survey date.** At migration and import, as in step 2 above; Place walk asks
  when that did not settle it.
- **Remove walk.** The row action asks inline ("Remove <name>? Its files stay in the project
  trash for seven days.") and then removes the layer and moves `walks/<id>/` to the project's `.trash/` folder
  (emptied at the next open after seven days), so a mistaken removal can be recovered by hand.
  Not offered in a package or a read-only project.

## Contract (major)

- **New layer kind `walk`** in `Layer`, with `WalkCalibration`, `WalkPin`. Older builds: 0.10 and
  later keep it opaque, 0.9 and older refuse the project (the upgrade note).
- **New file schemas** `aio.walkpath/1` (`raw-path.json`) and `aio.walkorient/1`
  (`orientation.json` header plus `orientation.bin` records), registered in `versions.ts`. `pose.json` uses `aio.flight/1` unchanged.
- **`LayerPatch`** gains `{ walk: WalkCalibration | null }` (null clears the placement);
  `{ capture }` and `builder:ensureCapture` are reused for the date step. A `{ corners }` patch on a
  drawing now also rewrites the pose file of every walk with a pin on that drawing.
- **Map picks**: `@aio/maps` gains a one-shot point pick on the map pane (model `[x, y, z]` of the
  clicked spot through `toLocal`), which the drawings work left unwired. Internal API, not a schema
  change.
- **New IPC** `walks:remove` (`{ projectId, layerId }` to `{ ok }`). `walks:list` stays (it reads
  `walk.json` records).
- **App version 0.12.0** (minor: a new layer kind).
- **Compatibility corpus**: a project with a walk layer, proven kept opaque by the frozen 0.10
  schema and saved back unchanged by `keepUnknownLayers`; the frozen 0.9 refusal recorded as
  expected; the 0.11 schema frozen as `tools/compat/schema-0.11` for later tests.
- data-conventions section 32 rewritten for the layer and the new files.

One row in `docs/architecture/contract-changes.md`, marked **Major**.

## Merge order

1. This branch's schema task (task 1 of the plan) lands first, or the pipeline branch cherry-picks
   it: `walk.process` writes `aio.walkpath/1` and `aio.walkorient/1` exactly as defined here.
2. The rest of this branch can land before or after the pipeline: it builds against the synthetic
   fixture, and a walk without `raw-path.json` places pins-only.

## Failures

| Case                                             | Behaviour                                                      |
| ------------------------------------------------ | -------------------------------------------------------------- |
| `raw-path.json` missing                          | Pins-only placing, badge Path not computed                     |
| `raw-path.json` unreadable or a newer schema     | Treated as missing; the project log names the file             |
| Start and end pins under 5 m apart               | End pin refused with the reason; the start pin stays           |
| Pin on a drawing that was later removed or moved | Removed: pin inactive, quality drops; moved: the walk follows  |
| Project with no coordinate system                | Map is not offered in Place on; drawings work fully            |
| Walk folder deleted by hand                      | The layer stays and its row says "Files missing"; Remove works |
| Two dates match `capturedAt`                     | No date set; Place walk asks                                   |
| Migration save fails (read-only folder)          | Layers in memory only for this session; the log says why       |
| A 0.9 build opens the project                    | Refused by that build (upgrade note)                           |

## Testing

- **Unit (`@aio/geo`)**: the similarity from two pins on the synthetic path (exact at both pins,
  scale and rotation recovered to 1e-9), the 5 m refusal, piecewise blend continuity (no jump
  above 1 cm between samples across a pin), residuals, broken paths (pinned and unpinned segments,
  the badge text), pins-only by steps and by time, drawing-pin re-registration (moving the
  drawing's corners moves the path), quality rules, pose samples (rate, heading with yaw offset).
- **Unit (`@aio/schema`)**: the layer, the patch, both file schemas, registry rows.
- **Unit (`@aio/project`)**: migration (dates matched and not, id taken, idempotent, package in
  memory), pose writer, removal to `.trash/`, package ownership and the planWalks tests updated.
- **Unit (`@aio/sync`)**: `layerFiles` for a walk.
- **Unit (renderer)**: the place session model (steps, arming, pin drag, cancel, unsaved), the
  surface list, overlay geometry in image pixels, the badge.
- **Compat**: `tools/compat/walk-kind.test.mjs`.
- **e2e**: `walk-place.spec.ts` (new): a project with a W1 walk folder, the synthetic
  `raw-path.json` and a PNG drawing is opened; the walk is in Datasets as a layer with Needs
  placing; Place walk, pick the date, Place on the drawing, start and end pins, the path with its
  dots appears, Pin here, Save; after reopening the badge is gone and `pose.json` exists. A second
  test removes the walk. `walk-360.spec.ts` changes: the walk opens from the Datasets row.

## Decisions taken (founder to confirm)

1. **This branch owns `aio.walkpath/1` and `aio.walkorient/1`**, and its schema task lands first so
   the pipeline branch writes to them. Recommended because placing is the only reader.
2. **Pin surfaces are a drawing or the model frame (`'@model'`)**, not any layer id. Map and ortho
   picks are stored in the model frame; only drawings move after import.
3. **The 3D view is not a Place on surface in this branch**; it comes with the 3D path in W3. Place
   on the map (with an ortho of the date it is the model top view) and on drawings covers both
   founder cases now.
4. **Migration is automatic and silent on open**, with a line in the project log, no question.
   Asking on every project would block every tester for a step that cannot be skipped anyway.
5. **Walk layers move into the Datasets tree** (a 360 walks group per date); the separate list goes.
6. **`capturedAt` sets the date only on an exact, single match**; otherwise Place walk asks.
7. **Ground height**: the height a pin knows (`y`), interpolated between pins, else the drawing's
   `baseY`, else 0; plus `heightM`. Mesh, terrain and DSM come later.
8. **Remove walk moves the folder to `.trash/`** for seven days rather than deleting it at once.
   No other layer kind gains removal here.
9. **Stills are not synced through hubs yet** (W3, when the viewer shows them).
10. **The pose file is written by main on save**, never during a drag; the renderer runs the same
    fit live.
11. **App version 0.12.0** for the release that carries the new layer kind.
12. **Two pins at least 5 m apart**; the blend window is 2 s either side of a pin.
