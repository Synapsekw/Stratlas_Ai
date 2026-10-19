# Line up dates with a turn and a scale: implementation plan (stage 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A line-up stores and applies a shift plus a small turn and scale (a 2D similarity), and the
Compare dates bar shows whether the two dates on screen line up.

**Architecture:**

- The maths lives once per language:
  - TS in `packages/schema/src/dateShift.ts`;
  - Python in a new `python/src/aio_pipelines/similarity.py`.
  - A shared JSON fixture holds the two sides to the same answers.
- The turn is stored in a new optional capture field `lineUpTurn`, beside the strict `lineUp`, so
  older builds still open the project.
- `change.lineup` fits the similarity to the tile shifts it already measures. It writes the fit to a
  new `lineup-fit.json`, so the old `lineup.json` stays readable by 0.21.

**Tech Stack:**

- TypeScript: zod, React, zustand, vitest, Playwright.
- Python 3: numpy, scipy, scikit-image, rasterio, pytest.

**Spec:** `docs/superpowers/specs/2026-10-18-line-up-similarity-design.md` (stage 1 only).

## Global Constraints

- **Similarity convention.** About pivot P in the project CRS:
  `E' = Pe + a(E-Pe) - b(N-Pn) + eastM`, `N' = Pn + b(E-Pe) + a(N-Pn) + northM`, where
  `a = scale*cos(rot)`, `b = scale*sin(rot)` and `rot` is counter-clockwise (east towards north).
  Heights are never changed.
- **The same correction in the local frame** (`x = E - origin[0]`, `z = origin[1] - N`; pivot
  `px = Pe - origin[0]`, `pz = origin[1] - Pn`):
  - `x' = px + a(x-px) + b(z-pz) + eastM`
  - `z' = pz - b(x-px) + a(z-pz) - northM`
- **Bounds.**
  - |rotationDeg| ≤ 1.
  - scale is within [0.99, 1.01].
  - The largest move over the overlap is ≤ 500 m.
- **Storage.** `lineUp` (strict) is unchanged.
  - `lineUpTurn: { rotationDeg, scale, pivotE, pivotN }` is optional and present only when the turn
    isn't identity: |rotationDeg| > 1e-6 or |scale-1| > 1e-7.
  - It is a plain `z.object` (not strict), so later fields stay additive.
- **Compatibility.** No new key is added inside any existing strict object (`CaptureLineUp`,
  `DateShiftSchema`, `LineUpMeasure` as Python writes it, `ChangeSet.lineUp`). The turn always goes
  in a sibling field or file.
- **Literals keep working.** A `DateShift` literal `{ eastM, northM }` must keep compiling and mean
  exactly what it means today. The turn is optional with identity defaults.
- **Public repo.** No customer, site, operator or country names in committed text, and no path to
  the founder's data. Grep by hand before each commit.
- **UI.** Strings go in `packages/ui/src/i18n/en.ts`. Line up uses `Button` from `@aio/ui`. The
  compare chip fits at 1100x720.
- **e2e.** Ctrl+click a tree row on its `.tn` name, not its middle.
- **Landing.** One PR, with CI green on current `origin/main`. Then send d-ba the PR number, branch
  and full head SHA. Never push main.

## Review Focus

1. **A project saved by 0.21 after a turned line-up** (`lineUpTurn` stripped). The app must treat
   the date as shift-only, never crash, and the compare chip must re-measure. Covered in Task 2
   (`captureLineUpShift` without turn) and Task 9 (compat test).
2. **Lining up again on a date that already has a turn.** The composition must not drift: lining up
   an already-aligned pair adds nothing. Covered in Task 7 (`planLineUp` composes; round-trip test).
3. **Recentring the project origin after a turned line-up.** The pivot is in the CRS, so nothing may
   move. Covered in Task 2 (local helpers take the pivot from origin; test with two origins).
4. **A construction site where a quarter of the tiles changed for real.** The robust fit must still
   return `ok` with the right turn. Covered in Task 5 (`test_fit_ignores_changed_patch`).
5. **Switching the compare dates while a measurement runs.** The old job is cancelled, and the chip
   never shows the old pair's answer. Covered in Task 8 (`switching cancels and ignores the stale
answer`).

---

### Task 1: Python similarity core and the shared fixture

**Files:**

- Create: `python/src/aio_pipelines/similarity.py`
- Create: `packages/schema/src/__fixtures__/date-shift/similarity.json`
- Test: `python/tests/test_similarity.py`

**Interfaces:**

- **Produces** `@dataclass(frozen=True) class Similarity` with fields `east_m: float`,
  `north_m: float`, `rotation_deg: float = 0.0`, `scale: float = 1.0`, `pivot_e: float = 0.0` and
  `pivot_n: float = 0.0`. Methods:
  - `is_identity() -> bool`: shift ≤ 0.0005 m and the turn is identity per Global Constraints.
  - `has_turn() -> bool`
  - `apply_en(e: np.ndarray | float, n: np.ndarray | float) -> tuple[...]`
  - `apply_local(x, z, origin: Sequence[float]) -> tuple[...]`
  - `inverse() -> Similarity`: about pivot `P + t` with `-rot`, `1/scale` and `t' = -t`.
  - `then(other: Similarity) -> Similarity`: `other ∘ self`, kept about `other`'s pivot, with
    `t = other(self(P)) - P`.
  - `crs_affine() -> rasterio.Affine`: maps stored CRS to placed CRS.
  - `mat4_local(origin) -> list[float]`: column-major 4x4 to premultiply a local transform; y row
    and column are identity.
  - `max_move(box_en: tuple[float, float, float, float]) -> float`: the largest |X' - X| over the
    box's 4 corners.
  - `to_turn() -> dict | None`: the `lineUpTurn` dict, or None for identity.
  - `from_line_up(line_up: dict | None, turn: dict | None) -> Similarity`, a staticmethod.
- **Fixture** `similarity.json`:
  `{ "origin": [E0,N0,H0], "cases": [{ "name", "s": {eastM,northM,rotationDeg,scale,pivotE,pivotN}, "en": [[E,N],...], "enOut": [[...]], "local": [[x,y,z],...], "localOut": [[...]], "mat4": [16 numbers] }] }`.
  Include these cases:
  - identity;
  - shift only;
  - 0.1° + 0.35% about a mid-site pivot;
  - -0.8° + 0.99 about a far pivot.

  Generate the values with this module, then hand-check the shift-only case.

- [ ] **Step 1:** Write `test_similarity.py`:
  - `test_shift_only_matches_capture_shift`: `apply_en` of `Similarity(2,-1)` equals `(E+2, N-1)`.
  - `test_inverse_round_trips` (max error < 1e-9 m for all fixture cases);
  - `test_then_composes` (`a.then(b).apply_en(p) == b.apply_en(*a.apply_en(p))`);
  - `test_local_matches_en_through_origin` (two different origins give the same EN result);
  - `test_mat4_matches_apply_local`;
  - `test_crs_affine_matches_apply_en`;
  - `test_max_move_at_corners`;
  - `test_fixture` (every case's `enOut`, `localOut` and `mat4` to 1e-9).
- [ ] **Step 2:** `cd python; .venv\Scripts\python -m pytest tests/test_similarity.py -q` should
      FAIL (module missing).
- [ ] **Step 3:** Implement `similarity.py`, using the formulas in Global Constraints.
- [ ] **Step 4:** Run Step 2's command again; it should PASS.
- [ ] **Step 5:** Commit `feat(pipelines): 2D similarity for date line-ups`.

### Task 2: TS schema and helpers

**Files:**

- Modify:
  - `packages/schema/src/dateShift.ts`
  - `packages/schema/src/manifest.ts:28` (`Capture.lineUpTurn`)
  - `packages/schema/src/builder.ts:279-288` (`CapturePatch.lineUpTurn`, nullable to remove)
  - `packages/project/src/builder/create.ts:334-342` (write it; drop it when `lineUp` is removed)
- Test:
  - `packages/schema/src/dateShift.test.ts`
  - `packages/project/src/builder/manifestFile.test.ts`

**Interfaces:**

- **Produces:**
  - `export const CaptureLineUpTurn = z.object({ rotationDeg: z.number().min(-1).max(1), scale: z.number().min(0.99).max(1.01), pivotE: z.number(), pivotN: z.number() })`
  - `export interface DateTurn { rotationDeg: number; scale: number; pivotE: number; pivotN: number; pivotX: number; pivotZ: number }`
  - `DateShift` becomes `z.infer<typeof DateShiftSchema> & { turn?: DateTurn }`. The schema is
    unchanged.
- **Changes** `captureLineUpShift(c: Capture, origin: Vec3): DateShift | null`. It adds `turn`
  (with the local pivot from origin) only when `c.lineUpTurn` is present.
- **New helpers:**
  - `isZeroShift(s)`: also needs no turn.
  - `invertShift(s: DateShift): DateShift`
  - `composeShift(first: DateShift, then: DateShift): DateShift`
  - `turnOf(s): CaptureLineUpTurn | null`
- **Updated helpers:** `shiftLocal`, `unshiftLocal`, `shiftEN` (sign -1 is the true inverse),
  `shiftTransform` (premultiply), `shiftCorners`/`unshiftCorners`, `drawnTransform`,
  `storedTransform` (true inverse) and `shiftedLayer`. Video `positionOffsetM` takes the turned
  move of the offset point. All of them apply the full similarity.
- **`builder:updateCapture`** accepts `{ lineUp, lineUpTurn }`. `lineUpTurn: null` removes it.
  `lineUp: null` removes both.

- [ ] **Step 1:** Write the failing tests:
  - `fixture parity`: every case in `similarity.json` through `shiftEN`, `shiftLocal` and
    `shiftTransform`, to 1e-9.
  - `a {eastM,northM} literal behaves exactly as before` (existing tests stay untouched).
  - `stored(drawn(t)) is t for a turned shift`.
  - `unshiftLocal undoes shiftLocal`.
  - `the same capture under two origins moves a CRS point the same`.
  - `captureLineUpShift ignores a missing lineUpTurn`.
  - `CaptureLineUpTurn refuses 1.5 degrees and 1.02`.
  - `Capture keeps unknown keys out but parses lineUpTurn`.
  - In `manifestFile.test.ts`: `updateCapture writes and removes lineUpTurn with lineUp`.
- [ ] **Step 2:** `pnpm --filter @aio/schema test -- dateShift` and
      `pnpm --filter @aio/project test -- manifestFile` should FAIL.
- [ ] **Step 3:** Implement. Keep the zero-shift fast paths, so a literal without `turn` allocates
      nothing new.
- [ ] **Step 4:** Run the tests again; they should PASS. Then `pnpm -r typecheck`: the
      `captureLineUpShift` signature change breaks only `packages/workspace/src/dateShifts.ts`, which is
      fixed in Task 3. Note it and continue.
- [ ] **Step 5:** Commit `feat(schema): line-up turn and scale (lineUpTurn)`.

### Task 3: Workspace resolver, cache keys and stale checks

**Files:**

- Modify:
  - `packages/workspace/src/dateShifts.ts`
  - `packages/change/src/stale.ts:15-40`
  - `apps/desktop/src/renderer/lineup/lineUpStore.ts:132` (`shiftsOf`)
  - `apps/desktop/src/renderer/survey/compareStore.ts:214-234,478-483`
  - `packages/globe/src/view/siteOutputs.ts:23`
  - `apps/desktop/src/renderer/survey/orthoCrop.ts:48`
  - `apps/desktop/src/renderer/survey/MagicPolygon.tsx:152`
  - `packages/volumetric/src/scene/controller.ts:312`
- Test:
  - `packages/workspace/src/dateShifts.test.ts`
  - `packages/change/src/stale.test.ts`

**Interfaces:**

- **Changes** `type Source = Pick<ProjectManifest, 'captures' | 'layers' | 'origin'>`.
  `layerDateShifts`, `dateShiftOf` and `captureShift` pass `m.origin` to `captureLineUpShift`.
- **Produces** `shiftKey(s)`: `"e,n"` for no turn (unchanged), else
  `"e,n,r<rotationDeg to 1e-6>,s<scale to 1e-7>,p<pivotE>,<pivotN to mm>"`.
- `differs(a, b)` in `stale.ts` is true when the keys differ.
- Every cache key in the files above uses `shiftKey`. Replace the hand-built `e,n` strings with it.

- [ ] **Step 1:** Write the failing tests:
  - `shiftKey differs by turn alone`;
  - `a turned line-up is read with the manifest origin`;
  - `stale when only the turn changed`.
- [ ] **Step 2:** Run `pnpm --filter @aio/workspace test` and `pnpm --filter @aio/change test`; they
      should FAIL.
- [ ] **Step 3:** Implement. Then run `pnpm -r typecheck`. Fix every caller that passes a
      `{captures, layers}` object without `origin` by passing the manifest's `origin`. In tests, use the
      manifest fixture's origin and never `[0,0,0]` by default.
- [ ] **Step 4:** `pnpm -r typecheck && pnpm -r test` should be green.
- [ ] **Step 5:** Commit `feat(workspace): line-up turn in the resolver and cache keys`.

### Task 4: Hand-rolled TS offsets and boxes

**Files:**

- Modify:
  - `packages/change/src/footprint.ts:97`
  - `packages/change/src/vector.ts:106,179`
  - `packages/volumetric/src/scene/controller.ts:242`
  - `packages/project/src/builder/extents.ts:37,152`
  - `packages/project/src/builder/layerFiles.ts:92,139-140`
  - `apps/desktop/src/renderer/shell/layerBounds.ts:78-95`
- Test: the existing test file beside each one.

**Interfaces:**

- **Consumes** `shiftLocal`/`shiftEN` from Task 2.
- **Produces** `shiftedBox(box: Box, s: DateShift | null): Box` in `packages/schema/src/dateShift.ts`:
  the axis-aligned box of the 4 moved plan corners, with y kept. All three box sites use it.
- The `layer:export` sidecar gains a sibling `dateTurn` (a `CaptureLineUpTurn`) next to
  `dateShiftM`.

- [ ] **Step 1:** Write one failing test per file: `follows a 0.5 degree turn` (a corner point lands
      where `shiftEN`/`shiftLocal` puts it). Also `shiftedBox grows to hold the turned corners`, and
      `export sidecar carries dateTurn`.
- [ ] **Step 2:** Run the package tests; they should FAIL.
- [ ] **Step 3:** Replace each `+e`/`-n` with the helper.
- [ ] **Step 4:** Run the tests; they should PASS. Also run
      `pnpm -r typecheck` and `rg -n "eastM|northM" packages apps/desktop/src --glob '!*.test.*'`, and
      check that every remaining hit is a reader of stored data, the schema itself, or a stage-2 item
      (`pointcloud/`, azimuths, headings). List the stage-2 hits in the commit message.
- [ ] **Step 5:** Commit `fix: hand-rolled date offsets follow the line-up turn`.

### Task 5: The measurement fits a turn and a scale

**Files:**

- Modify:
  - `python/src/aio_pipelines/change/register.py:107-194`
  - `python/src/aio_pipelines/change/lineup.py`
- Modify:
  - `packages/schema/src/change.ts:228-244` (add `LineUpFit`, and `LineUpMeasure.fit` optional on
    the app side)
- Test:
  - `python/tests/test_change_lineup.py`
  - `packages/schema/src/change.test.ts`

**Interfaces:**

- **Produces**
  `fit_similarity(centres: np.ndarray, shifts: np.ndarray) -> dict` in `register.py`.
  - `centres` is N x 2 (row, col, in grid px) and `shifts` is N x 2 (dy, dx, in px).
  - It returns `{a, b, ty, tx, cy, cx, residual, inliers, turned}` in grid pixels about the
    centroid `(cy, cx)` of the inliers.
  - The fit is robust: least squares, then up to 3 rounds dropping tiles whose residual exceeds
    `max(3 * 1.4826 * MAD, 0.5)` px.
  - When the inlier centres span less than a third of the grid on either axis, it fits the shift
    only, with `turned=False`.
- `measure_line_up(...)` adds to its return:
  - `"fit"` (the dict above);
  - `"centres"` (the used tiles' centres).

  Fine tiles are picked spread out: split the overlap into a 6 x 6 grid, take the most textured
  valid tile in each cell, then fill up to `MAX_FINE_TILES = 48` by texture. `spread` becomes the
  fit's median residual.

- **Constants:** `MAX_ROTATION_DEG = 1.0`, `MAX_SCALE_DEV = 0.01`, and `MAX_SPREAD_PX = 1.0`
  (unchanged; now on the residual).
- **`lineup.py`:**
  - Converts the fit to a `Similarity` in the CRS. The pivot is the inlier centroid: grid cell
    centre, to local through `Grid`, then to the CRS through the manifest `origin`. Grid rows run
    south, so a turn in pixels flips sign.
  - Verdicts, in order: `texture` (< `MIN_TILES` inliers); `disagree` (residual >
    `MAX_SPREAD_PX`); `range` (beyond the bounds); `aligned` (`max_move(overlap box)` ≤
    `tolerancePx * cell`); `ok`.
  - `lineup.json` stays as today. `eastM`/`northM` are the move at the pivot and `totalM` is
    `max_move`. A `range` verdict is written there as `disagree`, so 0.21 can still read it.
  - Also commits `jobs/<id>/lineup-fit.json`:
    `LineUpFit = { rotationDeg, scale, pivotE, pivotN, eastM, northM, maxMoveM, residualPx, inliers, verdict: ok|aligned|texture|disagree|overlap|range }`.
- **TS:**
  - `export const LineUpFit = z.object({...})`, the same keys.
  - `LineUpMeasure` gains `fit: LineUpFit.optional()`. The app fills it from the sibling file;
    Python never writes it into `lineup.json`.

- [ ] **Step 1:** Write the failing tests. Use synthetic textured images from the existing helper,
      warped with `scipy.ndimage.affine_transform`:
  - `test_measures_a_turn_and_a_scale` (2 m, 0.1°, +0.3%: turn within 0.01°, scale within 0.0003,
    residual < 0.5 px, verdict ok);
  - `test_fit_ignores_changed_patch` (the same, with a quarter of the image replaced by noise);
  - `test_clustered_tiles_fit_shift_only`;
  - `test_rotated_copy_is_out_of_range` (3°: `lineup-fit.json` verdict `range`, `lineup.json`
    verdict `disagree`; this replaces `test_refuses_a_rotated_copy`);
  - `test_aligned_uses_the_largest_move`;
  - `test_lineup_json_keys_unchanged` (`MEASURE_KEYS`).
  - TS: `LineUpFit parses a range verdict`.
- [ ] **Step 2:** Run `.venv\Scripts\python -m pytest tests/test_change_lineup.py -q`; it should
      FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS. Then run the private acceptance script below. It lives in the session
      scratchpad, outside the repo. It runs `measure_line_up` on the founder's two saved `grid.npz` files
      (paths in the private notes). Both pairs should come back with residual < 1 px, verdict `ok`, a
      turn and scale close to the values in the spec's table, and a turn within the bounds. Paste its
      output in the task report, not in the repo.
- [ ] **Step 5:** Commit `feat(change): line-up measures a turn and a scale`.

### Task 6: Python readers apply the similarity

**Files:**

- Modify:
  - `python/src/aio_pipelines/captures.py`: add `capture_similarity(manifest, capture_id) -> Similarity`
    and `date_similarity(manifest, layer_id) -> Similarity`. These read `lineUp` and `lineUpTurn`
    and follow the same rules as `date_shift`. `capture_shift` and `date_shift` are unchanged.
  - `change/imagery.py:173-228,361-365`: the `Ortho` corners through `apply_local`; the COG through
    `crs_affine().__invert__()`.
  - `change/surface.py:176-177,184-192,277-287`
  - `change/sources.py:163-168`: a turned `grid_source` is resampled with
    `rasterio.warp.reproject` onto the requested grid.
  - `change/mesh.py:138-143`, `tiles/mesh.py:402-411` and `inspection/frame.py:126-143`:
    `mat4_local` premultiplied.
  - `change/frames.py:193-204`: positions.
  - `change/raster.py:624-631` and `surface.py:99-106`: fingerprints include `to_turn()`.
  - `changeset.py:107-140`: `ChangeSet.lineUpTurn {from?, to?}` as a sibling of `lineUp`.
    `packages/schema/src/change.ts` gains the optional field.
  - `survey/prepare.py:172-205,506-512,557`: a turned DSM takes the slow path. `tiles.json` gains a
    sibling `dateTurn`, and `packages/schema/src/survey.ts:368` gains the optional field.
  - `survey/compare.py:114-117,396-412,800-803`, `survey/export.py:974-993` and
    `survey/cleanup.py:311-322,442-461`.
  - `change/cloud.py`: when either date's `Similarity.has_turn()`, raise
    `JobError("Point cloud change doesn't follow a turned line-up yet. Line up these dates on point clouds after the next update.")`.
    Final wording is a builder's call; keep it plain.
- Test: in each module's existing test file, a test named `..._follows_a_turned_line_up`, using a
  0.5° turn plus a 2 m shift:
  - `test_change_raster.py`, `test_change_surface.py`, `test_change_sources.py`,
    `test_change_mesh.py`, `test_change_frames.py` and `test_changeset.py`;
  - `test_tiles.py`, `test_inspection.py`, `test_survey_prepare.py`, `test_survey_compare.py`,
    `test_survey_export.py` and `test_survey_cleanup.py`;
  - plus `test_change_cloud.py::test_refuses_a_turned_pair` and
    `test_captures_shift.py::test_similarity_reads_lineup_turn`.

Split this into two commits:

- 6a: `change/*`, `captures.py`, `changeset.py`.
- 6b: `survey/*`, `tiles`, `inspection`.

The step pattern is the same for each. Write the failing tests for the commit's files, run
`.venv\Scripts\python -m pytest tests -q -k "turned or similarity"` and see them FAIL, implement,
run the full `.venv\Scripts\python -m pytest -q` and see it PASS, then commit:

- 6a: `feat(change): change jobs follow the line-up turn`.
- 6b: `feat(survey): survey and tiles follow the line-up turn`.

Also: the `packages/survey/src/engine/parity.test.ts` TS/Python parity must stay green. Add a turned
case to its fixture.

### Task 7: The line-up step saves, composes and undoes the turn

**Files:**

- Modify:
  - `apps/desktop/src/renderer/lineup/lineUpSession.ts:60-110`: read
    `jobs/<id>/lineup-fit.json` when present, parse it with `LineUpFit`, and set `measure.fit`. A
    missing file means an older pack, so it stays shift-only.
  - `planLineUp.ts:22-71,234-247`
  - `lineUpStore.ts:28-40,70-77,116-129`
  - `LineUpDialog.tsx:18-21,47-88,281`
  - `lineUpPreview.ts:79-82`
  - `packages/ui/src/i18n/en.ts:4311-4365`
- Test: `planLineUp.test.ts`, `lineUpStore.test.ts`, `lineUpSession.test.ts`,
  `LineUpDialog.test.tsx` and `i18n.test.ts`.

**Interfaces:**

- **Consumes** `composeShift`, `invertShift`, `turnOf` (Task 2) and `LineUpFit` (Task 5).
- **Produces:**
  - `LineUpPlan` gains `lineUpTurn: CaptureLineUpTurn | null` and
    `previousTurn: CaptureLineUpTurn | null`.
  - The new correction is computed as follows:
    - `correction = fit ? similarity(fit) : shift(m)`;
    - keep `m.keep`: `next = composeShift(now, correction)`;
    - keep `m.move`: `next = composeShift(now, invertShift(correction))`.
  - `totalM` is `fit?.maxMoveM ?? hypot`. `inRange` also checks `next`'s turn bounds.
- `LineUpDeps.saveCapture(captureId, lineUp, lineUpTurn: CaptureLineUpTurn | null)`, and
  `LineUpWrite` gains `turn` and `backTurn`. Undo and Redo restore both.
- `refusalOf` handles `fit?.verdict ?? m.verdict`. Its `range` case returns
  `t('lineUp.refuse.range')`.
- `en.ts` strings:
  - `lineUp.refuse.disagree`: "These dates cannot be lined up: their parts don't fit one shift,
    turn and scale, so part of the site may have warped or changed too much."
  - `lineUp.refuse.range`: "These dates cannot be lined up: one is turned more than 1° or scaled
    more than 1% against the other."
  - `lineUp.turn`: "turned {deg}°, scaled {pct}".
  - `lineUp.cloudsNoTurn`: "Point clouds move but don't turn yet."
- The dialog shows `lineUp.turn` under the shift whenever the fit is turned, and
  `lineUp.cloudsNoTurn` when the moving date has a `pointcloud` layer. The preview draws the moved
  image with `ctx.setTransform(a, -b, b, a, tx, ty)` in canvas pixels (y down).

- [ ] **Step 1:** Write the failing tests:
  - `composes a turn onto an existing one` (applying the plan's result equals applying both in
    order, to 1e-6 m);
  - `keeping the other date saves the inverse`;
  - `lining up an aligned pair adds nothing`;
  - `undo restores lineUp and lineUpTurn together`;
  - `older pack without lineup-fit.json stays shift-only`;
  - `range refusal`;
  - `dialog shows the turn line`;
  - `dialog warns that clouds don't turn`;
  - i18n key presence.
- [ ] **Step 2:** `pnpm --filter @aio/desktop test -- lineup` should FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests; they should PASS. Then run `pnpm -r typecheck`.
- [ ] **Step 5:** Commit `feat(lineup): save, compose and undo the line-up turn`.

### Task 8: Line-up status in the Compare dates bar

**Files:**

- Create:
  - `apps/desktop/src/renderer/lineup/compareLineUp.ts` (the store)
  - `apps/desktop/src/renderer/lineup/CompareLineUp.tsx` (the chip)
- Modify:
  - `apps/desktop/src/renderer/workspace/m8Mounts.tsx`: one `COMPARE_TOOLS.push(CompareLineUp)`.
    `CompareControls.tsx` is not edited.
  - `lineup/lineup.css`
  - `en.ts`
- Test:
  - `compareLineUp.test.ts`
  - `CompareLineUp.test.tsx`
  - `apps/desktop/e2e/line-up-dates.spec.ts` (Task 10)

**Interfaces:**

- **Consumes** `LineUpDeps['measure']`, `captureShift`/`shiftKey` (Task 3), `openLineUp(from, to)`
  (`lineUpActions.ts:12`), `removeLineUp`, and `lineUpApp` (`lineUpStore.ts:443`) for Undo.
- **Produces:**
  - `createCompareLineUp(deps: { measure: LineUpDeps['measure']; workspace: StoreApi<Workspace> })`,
    which returns a store with:
    - `state: { pair: string | null; status: 'idle'|'measuring'|'lined'|'off'|'cannot'; measure: LineUpMeasure | null; reason: string | null }`;
    - `watch(left: string, right: string): void`;
    - `stop(): void`.
  - Cache: `Map<key, LineUpMeasure>`, where `key = left|right|shiftKey(left)|shiftKey(right)`.
    Results from the background watcher with the same key fill it as well (`lineUpWatch.ts`: call a
    `remember(key, m)` export).
  - One measurement at a time. `watch` with another pair abandons the one in flight, and its answer
    is dropped by key. The job is cancelled through the existing `measureWith` abort, extended to
    take an `AbortSignal`.
  - Status mapping:
    - `ok` → `off`;
    - `aligned` → `lined`;
    - `texture`, `disagree`, `overlap`, `range` and errors → `cannot`, with `refusalOf`.
- The chip `CompareLineUp({ split })` reads the two captures of the twin panes from `split`, using
  the same fields `CompareMap` uses.
  - **Labels:**
    - `compare.lineUp.lined`: "Lined up".
    - `compare.lineUp.off`: "{distance} off", followed by a `Button` "Line up" that calls
      `openLineUp(left, right)`.
    - `compare.lineUp.measuring`: "Checking line-up…".
    - `compare.lineUp.cannot`: "Can't line up".
  - **Details** (a `title` tooltip plus a click-open popover using the existing `overlay-box`
    class): the saved line-up of either date (who with, `shiftWords`, `lineUp.turn`), the fit
    residual, `lineUp.cloudsNoTurn` when it applies, and Remove line-up.
  - Max width 220 px, single line, ellipsis.

- [ ] **Step 1:** Write the failing tests:
  - `measures the pair once and caches by shifts`;
  - `a new line-up re-measures`;
  - `switching cancels and ignores the stale answer`;
  - `aligned shows Lined up`;
  - `ok shows the distance and Line up`;
  - `Line up opens the dialog with both dates`;
  - `range shows Can't line up with the reason`;
  - `renders nothing without a twin`.
- [ ] **Step 2:** `pnpm --filter @aio/desktop test -- compareLineUp CompareLineUp` should FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests; they should PASS. Then open the app (the `run` skill), start Compare
      dates at 1100x720 with long date labels, and take a screenshot to show the chip fits.
- [ ] **Step 5:** Commit `feat(compare): line-up status beside Compare dates`.

### Task 9: Compatibility and docs

**Files:**

- Create: `tools/compat/date-line-up-turn.test.mjs`, modelled on
  `tools/compat/date-line-up-additive.test.mjs`.
- Modify:
  - `docs/architecture/contract-changes.md`: add a row with the 2026-10-18 date.
  - `docs/architecture/data-conventions.md` §38 (:991-998): the formula, the pivot, the sibling
    fields and the `lineup-fit.json` file.
  - `docs/KNOWN-LIMITS.md`: stage-2 items, and "an older build that saves the project drops the
    turn; Compare shows the dates off and Line up restores it".
  - `docs/guide/15-imagery-and-surface-change.md`: the line-up section, covering the turn, the scale
    and the Compare chip.
  - `docs/superpowers/specs/2026-10-16-date-line-up-design.md` "Later": point to the new spec.

- [ ] **Step 1:** Write the compat test:
  - `0.21 schema opens a manifest with lineUpTurn, keeps lineUp, drops lineUpTurn on re-serialise`;
  - `0.21 LineUpMeasure parses the new lineup.json`.
- [ ] **Step 2:** Run `pnpm test:compat` (or the command in `tools/compat/README`); it should PASS.
      Both are deliberate behaviours.
- [ ] **Step 3:** Write the docs. Run `pnpm check-public-text`, then grep by hand for site,
      customer and country names.
- [ ] **Step 4:** Commit `docs: line-up turn and scale, compat and limits`.

### Task 10: e2e and visual evidence

**Files:**

- Modify:
  - `apps/desktop/e2e/fixtures.ts:736-791`: `createMisalignedDemo({ turnDeg?: number; scale?: number })`
    warps the later ortho and DSM corners and grid with a `Similarity` about the site centre, in
    addition to the shift.
  - `apps/desktop/e2e/line-up-dates.spec.ts`
- **Uses** the window size 1100x720 that CI uses.

- [ ] **Step 1:** Write the e2e `turned dates line up from Compare`. It runs on the demo with 2 m,
      0.3° and +0.4%:
  1. Compare dates shows "… off".
  2. Click Line up, keep the earlier date, then click Line up.
  3. The chip shows "Lined up".
  4. Show changes and run imagery change: it runs, with no misaligned bar.
  5. A pin placed at a site corner on the later date sits on the same ortho feature in both panes,
     checked with the existing pixel probe helper.
  6. Take screenshots of the chip in both states.
- [ ] **Step 2:** Run `pnpm --filter @aio/desktop e2e -- line-up-dates` and see the new test fail
      before Tasks 7-8 are in. Once they are, it should pass.
- [ ] **Step 3:** On the founder's own project (local, not committed), line up both pairs in the
      app. Take before and after swipe screenshots at a site corner, and show them to the founder.
- [ ] **Step 4:** Run the whole suite: `pnpm -r typecheck && pnpm -r test && pnpm --filter @aio/desktop e2e`
      and `cd python; .venv\Scripts\python -m pytest -q`.
- [ ] **Step 5:** Commit `test(e2e): turned dates line up from Compare`. Then run `/wrapup` on the
      branch, rebase onto `origin/main`, push, open the PR, wait for CI to go green, and send d-ba the PR
      number, branch and full head SHA.
