# Line up dates with a turn and a scale: design

Status: approach approved by the founder, 18 Oct 2026. It extends `2026-10-16-date-line-up-design.md`,
and that document's calls still hold unless this one changes them.

## Intent

Line up dates shipped as a sideways shift only. On the founder's first real construction project,
both pairs of survey dates were refused with "parts of them point to different shifts, so one may
be turned or scaled against the other". The refusal was right.

The two surveys were flown without ground control. Re-measuring the saved grids tile by tile showed
what separates them:

| pair | measured shift | spread around the median | spread after a turn + scale fit | turn        | scale        |
| ---- | -------------- | ------------------------ | ------------------------------- | ----------- | ------------ |
| A    | 2.2 m          | 2.06 px                  | 0.24 px                         | about 0.11° | about -0.18% |
| B    | 4.4 m          | 2.37 px                  | 0.60 px                         | about 0.03° | about +0.35% |

The cells are about 0.19 m. The tile shifts form a smooth field, not noise: a sideways move plus a
small turn and a small scale explains them to within a quarter to half a pixel. The scale and turn
add up to 1-2 m at the edges of a site about 540 m across. A shift-only line-up would leave those
edges off, so imagery change would show false change along them.

**The founder's decision:** line up dates with a shift, a turn and a scale (a 2D similarity). The
comparison view must also show whether the two dates are lined up, and offer Line up there.

## Goals, non-goals, anti-goals

- **Goals:**
  - On the founder's project, both pairs line up. Imagery change then runs clean on them.
  - Swipe and blend in Compare dates show the dates matching across the whole site.
  - The compare bar always says whether the two dates on screen are lined up, and offers Line up
    when they aren't.
- **Non-goals:**
  - Height corrections, tilt, or warping (non-rigid alignment).
  - Manual point picking.
  - Lining up layers within one date against each other.
- **Anti-goals:**
  - A correction applied in some views but not others (unchanged from the first design).
  - A large turn or scale applied silently: the turn and scale are always shown, before saving and
    after.
  - A project that an older build of Quadrion can no longer open.
  - Lining up on a bad fit. Refusing with a clear reason is still the right answer.

## Stages (founder approved the split)

**Stage 1 (this design's build).** Two parts:

1. The measurement, the saved correction, the compare-bar status, and the line-up dialog.
2. Turn and scale applied by every reader that goes through the shared helpers, plus the Python
   readers listed below. Concretely: orthos and DSMs on the map, in 3D and in compare; meshes;
   vector layers; pins, issues and sightings; measurements and volumes; RF grids; extents; exports;
   the ortho and DSM change checks; and the mesh and frames change jobs (their positions).

**Stage 2 (a later branch).** Four parts:

- Point clouds turn and scale in the viewer (COPC and png-packed), in 3D Tiles, and in the
  point-cloud change job.
- Directions are rotated: photo orientations, panorama headings, video direction keyframes, antenna
  and RF azimuths.
- Hand-rolled boxes are rebuilt from their corners.
- Every remaining hand-rolled `eastM`/`northM` use is moved onto the helpers.

**What stage 1 does with point clouds and directions.**

- A turned or scaled line-up still moves point clouds by its shift at the pivot. It doesn't turn or
  scale them.
- Directions aren't turned. At the turns seen in practice (around 0.1°) that is invisible.
- The point-cloud change job refuses a pair whose line-up has a turn or scale. Its reason is
  "Point cloud change doesn't follow a turned line-up yet" (wording for the builder to settle). It
  doesn't produce misleading results.
- The dialog and the compare-bar details say "Point clouds move but don't turn yet" when the date
  has point clouds.
- `KNOWN-LIMITS.md` records both limits.

## How it works (my calls, founder to check)

### 1. The correction

The correction is a horizontal similarity in the project CRS, about a pivot P:

```
[E']   [Pe]                           [E - Pe]   [eastM ]
[N'] = [Pn] + scale * R(rotation)  *  [N - Pn] + [northM]
```

- `rotation` is counter-clockwise seen from above (east towards north), in degrees.
- `scale` is a factor near 1.
- Heights are never scaled or changed.
- With no turn and scale 1, this is exactly today's shift. So `eastM`/`northM` keep their meaning:
  they are how far the pivot moves.

### 2. The pivot

The pivot is the centre of the ground both dates shared when measured: the centroid of the tiles
used. It is stored in the project CRS, not the local frame, so it means the same thing in Python
and TS and doesn't depend on `origin`.

Putting the pivot mid-site keeps `eastM`/`northM` close to the right answer everywhere. That
matters for older builds (call 3) and for point clouds in stage 1.

### 3. Storage that older builds survive

`CaptureLineUp` is `.strict()`, so a new key inside it would stop today's build from reading the
whole manifest. The turn therefore goes in a separate optional field on the capture, beside
`lineUp`:

```
lineUpTurn: { rotationDeg, scale, pivotE, pivotN }   // only when the turn or scale is not identity
```

- `Capture` itself isn't strict, so older builds drop the field and apply the shift alone. That is
  degraded but it opens, and it is right at the pivot.
- Exact name and bounds are the builder's call, within these limits: |rotation| ≤ 1°, scale within
  1 ± 1%.
- The same pattern applies to `ChangeSet.lineUp`, the prepared surface's `tiles.json` `dateShiftM`,
  and the `layer:export` sidecar. Each gets a sibling turn field and never a new key in a strict
  object.
- `LineUpMeasure` is parsed strictly by today's app, so a newer pack must not add keys to it. Two
  options are left to the builder, but either must keep an older app reading a newer pack's
  result:
  - add the keys in a version the app accepts;
  - write the turn to a sibling file `lineup-turn.json`.
- Contract row in `docs/architecture/contract-changes.md` and a §38 update in `data-conventions.md`.
- **Founder's ruling: older builds keep opening and editing the project.**
  - When an older build saves, it drops `lineUpTurn` and keeps the shift.
  - The newer build recovers through the compare chip, which re-measures the pair (call 8). The pair
    then shows as off, and Line up restores the turn in one click.
  - The project is not gated by schema version.
- `KNOWN-LIMITS.md` records this.
- `tools/compat` gets a test that a 0.21-era reader opens a project with a turned line-up, keeps the
  shift, and drops the turn on save. The test asserts both, so the behaviour is deliberate.

### 4. Measuring

`register.measure_line_up` keeps its coarse-to-fine shift search. Then:

1. **Fit.** Keep each fine tile's centre with its shift, and fit a similarity to the tile centres
   and shifts.
   - Use a robust fit, so tiles over real site change (spoil heaps, new slabs) don't pull it: for
     example, reject tiles beyond 3× the median absolute deviation (MAD) of the residuals, then
     refit.
   - Tiles must cover enough of the overlap to measure a turn: their spread across both axes must
     reach at least a third of the overlap. Below that, fit the shift only and report no turn.
2. **Picking fine tiles.** Pick the most textured tiles spread over the overlap (for example, the
   best tile in each cell of a coarse grid), rather than the 48 most textured overall. Clustered
   tiles can't measure a turn.
3. **Verdicts:**
   - `texture`: too few tiles.
   - `disagree`: the median residual after the fit is above `MAX_SPREAD_PX` (1 px). This is now a
     real disagreement, such as a warp or mostly-changed ground.
   - `range`: the turn or scale is beyond the bounds in call 3. New verdict, plain-words refusal.
   - `aligned`: the largest move the correction would make anywhere over the overlap is within the
     change check's tolerance. This is measured at the overlap's corners, not only at the pivot.
   - `ok`: otherwise.
4. **Result.** `LineUpMeasure` gains the turn, the scale and the pivot (subject to the compat rule
   in call 3).
   - `spreadPx` becomes the residual after the fit.
   - `totalM` becomes the largest move over the overlap.
5. **Acceptance on real data.** Both of the founder's saved pairs must come back `ok` with a
   residual under 1 px. Pair B is 0.60 px today.
   - Their `grid.npz` files are in `jobs/*-change-lineup-*/staging/work/` of the founder's local
     project. The path is in the private notes, not here.
   - This is a local, manual gate, run by a script outside the repo. The repo is public, so the
     files are never committed, and their project and site names never appear in committed text.
   - Synthetic stand-ins go in `python/tests`:
   - a 2 m shift with a 0.1° turn and a +0.3% scale;
   - a 3° turn, which must still refuse as `range`;
   - a shift with a patch of real change, which the robust fit must ignore.

### 5. Saving and composing

- Lining up a date that is already lined up composes the new correction onto the old one. Similarity
  after similarity is again a similarity; save it about the new pivot.
- "Keep the other date" saves the inverse.
- Undo and Redo restore the previous pair (`lineUp`, `lineUpTurn`) as a whole.
- The ±500 m check applies to the largest move over the overlap.

### 6. Applying it in the app

- `packages/schema/src/dateShift.ts` is the one place the maths lives.
  - `DateShift` gains optional turn fields with identity defaults. A literal `{ eastM, northM }`
    keeps compiling and means exactly what it does today; d-c5's antenna tests rely on that.
  - `shiftLocal`, `unshiftLocal`, `shiftEN`, `shiftTransform` (premultiply), `shiftCorners`,
    `drawnTransform`/`storedTransform` (true inverse) and `shiftedLayer` apply the full similarity.
  - For local-frame points, the helpers need the pivot in the local frame. The builder chooses
    between resolving it once in `captureShift(manifest, …)` from `origin`, or another way that
    keeps one source of truth.
- `packages/workspace/src/dateShifts.ts` `shiftKey`, `packages/change/src/stale.ts` `differs`, and
  every cache key listed in the recon must include the turn. Otherwise a turned line-up shows stale
  tiles.
- Hand-rolled offsets that stage 1 must still cover:
  - `packages/change/src/footprint.ts:97` and `vector.ts:106,179`.
  - `packages/volumetric/src/scene/controller.ts:242`.
  - Each goes through the helpers.
- Axis-aligned boxes (`extents.ts`, `layerFiles.ts` `shiftedBox`, `layerBounds.ts`) are rebuilt from
  their moved corners. That small change belongs in stage 1 because extents decide what is on
  screen.

### 7. Applying it in Python

- `captures.py` gains the similarity next to `capture_shift`, which keeps returning `(e, n)` for the
  callers stage 1 leaves as they are. It also gains a rasterio `Affine` and a 4x4 form.
- Covered in stage 1:
  - **`change/imagery.py` `Ortho`:** transform `tl`, `u`, `v`; COG reads use the inverse `Affine`.
  - **`change/surface.py` and `change/sources.py` `grid_source`:** a DSM read through a turned grid
    is resampled, since `GridSource` only knows `x0`, `y1` and `res`.
  - **`change/mesh.py`, `tiles/mesh.py` and `inspection/frame.py`:** the 4x4.
  - **`change/frames.py`:** positions.
  - **`survey/prepare.py`:** the turned DSM, taking the slow path when it isn't axis-aligned.
  - **`survey/compare.py`, `survey/export.py` and `survey/cleanup.py`:** points and rings.
  - **Fingerprints:** include the turn.
- `change/cloud.py` refuses a turned pair (stage 1, above).

### 8. The compare bar status (founder asked for it)

- A small chip in the Compare dates bar, pushed into `COMPARE_TOOLS` from its own module the way
  Swipe and Blend are. `CompareControls.tsx` barely changes. d-ba (the stage-island session that
  merges branches) agreed.
- It shows only when the compare has a twin date.
- **The chip always measures; it never trusts a saved line-up on its own (my call, following the
  founder's ruling in call 3).** The chip's state is the measurement of the pair as it now stands,
  with both dates' current corrections applied.
  - Saved line-ups only supply the details: who was lined up with whom, and the shift, turn and
    scale.
  - This covers every case without special rules:
    - the right date was lined up with a third date;
    - only the left date is lined up;
    - the left date moved later;
    - an older build dropped the turn.
  - Right after a line-up, the pair is measured once more. It should come back `aligned`, which
    also proves the saved correction.
- **Measuring on open (my call).** Opening Compare starts the existing `change.lineup` job for that
  exact pair. It took about 6 s on the founder's project.
  - One measurement runs at a time; switching dates cancels the one in flight.
  - Each result is cached per pair and per pair of current corrections, so reopening is instant
    until a date is lined up again.
  - Results from `lineUpWatch` / `pairsToMeasure` fill the same cache.
- **States** (wording to settle in en.ts; no client or site names):
  - **Lined up:** "Lined up". Its details show:
    - the moved date and the date it was lined up with;
    - the shift, turn and scale;
    - the fit;
    - "Point clouds move but don't turn yet" when it applies;
    - Undo, and Remove line-up.
  - **Not lined up:** "{distance} off" with a **Line up** Button from `@aio/ui`. The button opens the
    dialog with both dates filled in. The kept date defaults to the left-hand date, and the user can
    still switch.
  - **Measuring:** a quiet spinner.
  - **Can't line up:** "Can't line up". The details give the plain reason (texture, disagree,
    overlap, range).
  - **Within tolerance and never lined up:** "Lined up" with "already within {distance}".
- It must fit the compare bar at 1100x720 with long date labels: the short label goes on the chip,
  everything else in the details. A layout test checks it at that size.

### 9. The dialog

- When the turn or scale isn't identity, the measured result adds a line: "turned {deg}°,
  scaled {+0.35%}". It is always shown when non-zero, never hidden.
- The swipe preview draws the moved date with `setTransform`.
- `lineUp.refuse.disagree` loses "Lining up only moves a date sideways". New text explains that the
  dates don't fit one shift, turn and scale (wording for the builder to settle).
- A new `lineUp.refuse.range` covers too much turn or scale.

## Definition of done (stage 1)

- Python: unit tests for the fit, the verdicts and the composition, the founder's two pairs (local
  fixture), and every reader in call 7 with a turned line-up.
- TS:
  - unit tests for each helper's maths, and for each stage-1 consumer that has a test today, with a
    turned line-up;
  - inverse round-trips (`stored(drawn(x)) = x`);
  - cache keys that differ by turn alone.
- e2e: a rotated-and-scaled variant of `createMisalignedDemo`. Run the Changes panel line-up, then
  imagery change runs clean. The compare chip goes from "off" to "Lined up". Swipe lines up at a
  corner of the site, not just at its centre.
- Visual evidence for the founder: before and after swipe screenshots at the site edge on their
  project.
- Docs:
  - user guide section on line-up updated (turn and scale, the compare chip);
  - `KNOWN-LIMITS.md` (stage 2 items);
  - contract row and data-conventions.

## Left to the builder

- Field names and exact schema shapes within call 3's compatibility rule.
- The robust-fit method and the tile-spread rule's exact numbers, tested on the fixtures.
- How the local-frame pivot is resolved.
- Chip wording, its details popover component, and where Undo lives there.
- Which stage-1 readers share a wrapper.
