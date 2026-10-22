# Antenna Manual Flagging and Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person outlines a missed antenna on the 3D point cloud and the app measures it into the inventory with the existing telecom code; they can also redraw the outline of a wrong unit or type its azimuth, downtilt, centre elevation and size, and a re-run of detection never drops or overwrites any of it.

**Architecture:** The renderer draws a click-by-click screen polygon (new engine tool), collects the loaded cloud points inside it, keeps the cluster nearest the camera and shows it. On confirm it starts a new short pipeline job, `telecom.flag`, with the polygon, the view-projection matrix, the kept cluster's bounds and its centre. The job reads the full-density points in those bounds, keeps the ones inside the polygon, and runs `faces.planar_faces` → `boxes.pair_faces` (falling back to a one-face box) → `measure.measure_unit` on just them, picks photos and a crop like detection, and writes the unit into `telecom/antennas.json`. Typed values are `AntennaValue`s with basis `user`, written by the renderer store, which also rebuilds the box from them. `merge.py` treats flagged units and units with typed values as person-owned. Typing over a measured value keeps that measured value in the unit's `measured` map, so a per-value **Reset to measured** on the card can bring it back (founder answer 2).

**Tech Stack:** TypeScript strict, React 19, zustand, zod 4, three.js, Vitest (jsdom), Playwright with Electron; Python 3.13, numpy, scipy, pytest.

**Spec:** `docs/superpowers/specs/2026-10-22-antenna-manual-flagging-design.md` (founder-approved 22 Oct; its "Decisions after review" win over its earlier text).

## Global Constraints

- Worktree only: `E:\Dev\AIO Software\.claude\worktrees\antenna-flagging`, branch `feat/antenna-flagging`. Never the main checkout. Parallel task agents share this one worktree, stage only their own paths and commit with `git commit -F <msg> -- <paths>`.
- Conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; never `--no-verify`; never a bare `git stash`.
- Public repo: no client, site, tester or person names in code, fixtures, strings or commits (`node tools/agent/check-public-text.mjs <files>`).
- AI only labels the kind. No number is ever set by AI. The measuring job never touches the network.
- No measuring on the Electron main thread: the measuring is the `telecom.flag` Python job. Progress shows in the jobs chip and live line only; no new progress UI.
- The cloud's Z has the layer's `heightOffsetM` applied (`change.sources.height_offset_m`), exactly as `telecom.antennas` does.
- Units are stored in the inventory's survey date frame (`run.captureId`), without its line-up shift; the 3D view draws them shifted.
- Every value keeps its basis: typed values are `{ value, basis: 'user', quality: { basis: 'user' } }`; a not-measured unit has no `widthM`, `heightM`, `depthM`, `azimuthGridDeg`, `downtiltDeg`, `plumbDeg`, `elevationDeg` or `diameterM` unless the person typed one.
- Founder answers (22 Oct, in the spec): flagging needs a prior detection run, and without an inventory the Flag antenna tool is disabled with "Run antenna detection first"; each typed value has a **Reset to measured** control, hidden when there is no measured value to go back to.
- `aio.antennas/1` stays version 1 (additive optional fields, as the 17 Oct `groundZ` and `captureId` additions). Pack bump to `0.23.0` (next free minor; if `main` has taken 0.23.0 by merge time, take the next one and update every place Task 4 lists).
- New file paths in main go through `@aio/project/fs` (`fileInside`/`requireInside`). No new environment variable reaches Python (the `jobBaseEnv` allowlist in `apps/desktop/src/main/jobs/runner.ts` stays as it is). Job params carry no file paths.
- All new user-facing strings live in `packages/ui/src/i18n/en.ts` and are added by Task 9 only. No em or en dashes in user-facing text.
- Python in this worktree: the main checkout's venv read-only with the worktree sources first. From `python/`: `PYTHONPATH="src;tests" PYTHONDONTWRITEBYTECODE=1 "E:/Dev/AIO Software/python/.venv/Scripts/python.exe" -m pytest <tests> -q`. Check once that `python -c "import aio_pipelines; print(aio_pipelines.__file__)"` under that `PYTHONPATH` names the worktree. Run `ruff format` and `ruff check` on changed Python yourself.
- `/wrapup` (session note, north star) is done by the main session on this branch, not by a task here.

## Review Focus

1. **A person-owned unit next to a detected one on re-run.** A flagged unit, or a draft or accepted detected unit with one typed value, matched by a new detection of a different kind: it keeps its box, kind and user values, the duplicate is absorbed, no second unit appears. Unmatched it stays without `notFoundInLatest` (flagged) and is never dropped even as a draft or rejected. Tests in Task 2 (`test_flagged_absorbs_a_new_unit_of_another_kind`, `test_typed_draft_is_kept_unmatched`, `test_rejected_flagged_is_kept_unmatched`).
2. **An outline drawn across the tower.** The polygon also covers the shaft and the far-side units. Only the nearest cluster may be kept, in the renderer preview and in the Python selection (the job reads only inside the kept bounds). Tests in Task 7 (`nearestCluster drops the far side behind a depth gap`) and Task 3 (`test_select_keeps_only_points_inside_bounds_and_polygon`).
3. **An inventory on another survey date than the flagged cloud.** The flagged unit lands in the file's `run.captureId` frame, not the flagged layer's. Test in Task 4 (`test_flag_on_a_lined_up_date_is_stored_in_the_inventory_frame`).
4. **The person reviewing while the job runs.** They accept another unit or type a value during `telecom.flag`; the commit step re-reads the file and keeps those edits. Test in Task 4 (`test_commit_keeps_edits_made_during_the_job`).
5. **A not-measured unit everywhere a size is read.** Card, 3D labels, facing arrow, CSV and RF autoplan must not throw on missing `widthM`/`heightM`/`depthM`, and must not print a made-up number. Tests in Task 9 (`antennaCsv leaves the size cells of a not-measured unit empty`, `antennaMeasure has no dimension lines for a not-measured unit`, `card shows Not measured`).

---

## File Structure

| File                                                                                         | Responsibility                                                                                                                        |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/schema/src/antennas.ts`                                                            | `AntennaOrigin`, `origin`, `centreHeightM`, optional sizes for flagged units, rule skip, `TelecomFlagParams`, `TELECOM_FLAG_MIN_PACK` |
| `packages/schema/src/jobs.ts`                                                                | `telecom.flag` in `PipelineName`, the descriptor list and `PARAMS`                                                                    |
| `packages/schema/src/__fixtures__/antennas-contract.json`                                    | New `flagged` and `notMeasured` example units shared by TS and Python tests                                                           |
| `python/src/aio_pipelines/telecom/merge.py`                                                  | Person-owned units in matching and keeping; `next_name`                                                                               |
| `python/src/aio_pipelines/telecom/flag.py` (new)                                             | Pure: select points in polygon and bounds, measure a selection, the not-measured unit                                                 |
| `python/src/aio_pipelines/telecom/boxes.py`                                                  | `_group_unit` exposed as `unit_from_faces` (the old name stays an alias)                                                              |
| `python/src/aio_pipelines/telecom/flag_pipeline.py` (new)                                    | The `telecom.flag` job: select, measure, photos, commit                                                                               |
| `python/src/aio_pipelines/pipelines.py`, `python/pyproject.toml`, `python/uv.lock`           | Register the job; pack 0.23.0                                                                                                         |
| `apps/desktop/src/main/telecomPack.ts`, `apps/desktop/src/main/index.ts`                     | Pack refusal for `telecom.flag`, and for `telecom.antennas` on an inventory with person-owned units                                   |
| `packages/engine/src/tools/pcpolygon.ts` (new), `packages/engine/src/index.ts`               | Click-by-click polygon tool with SVG outline                                                                                          |
| `packages/pointcloud/src/cleanup/count.ts`, `packages/pointcloud/src/index.ts`               | `collectDrawn`: the loaded, drawn points passing a test, as local xyz                                                                 |
| `apps/desktop/src/renderer/telecom/antennaFlag.ts` (new)                                     | Pure: nearest cluster, kept bounds and anchor, flag job params                                                                        |
| `apps/desktop/src/renderer/telecom/antennaTyped.ts` (new)                                    | Pure: typed value parse and ranges, box rebuilt from values, person-owned and not-measured tests                                      |
| `apps/desktop/src/renderer/telecom/antennaStore.ts`                                          | Flag state, flag job start and watch, typed values, kind, delete, AI offer for one unit                                               |
| `apps/desktop/src/renderer/telecom/antennaScene.ts`, `antennaMeasure.ts`, `antennaCsv.ts`    | Optional sizes, placeholder box and label for not measured, origin column                                                             |
| `apps/desktop/src/renderer/telecom/flagScene.ts` (new)                                       | Highlight of the kept points                                                                                                          |
| `apps/desktop/src/renderer/telecom/AntennaFlagTool.tsx` (new)                                | Drawing, preview and confirm bar                                                                                                      |
| `apps/desktop/src/renderer/telecom/AntennaInventory.tsx`, `AntennaSection.tsx`               | Flag antenna button; tool mount; flagged chip on rows                                                                                 |
| `apps/desktop/src/renderer/telecom/AntennaTypedValues.tsx` (new), `AntennaCard.tsx`          | Typed value inputs, kind picker, Redraw outline, Delete, Not measured                                                                 |
| `packages/ui/src/i18n/en.ts`                                                                 | Every new string (Task 9 only)                                                                                                        |
| `apps/desktop/e2e/telecomFixtures.ts`, `apps/desktop/e2e/telecom-antenna-flag.spec.ts` (new) | Tower truth, a starting inventory, the end to end flag                                                                                |
| `docs/guide/45-antenna-inventory.md`, `docs/architecture/contract-changes.md`                | User guide section; contract row                                                                                                      |

## How the existing measuring runs on a point subset

Verified in the code (22 Oct):

- `faces.planar_faces(xyz, axis_point, axis_dir, shaft_r)` (`faces.py:330`) takes any local-frame point array. It drops points within `shaft_r(h) + 0.05 m` of the axis and needs `MIN_FACE_POINTS_SPARSE` (60) upright flat points. On a selection we pass the inventory's axis (`run.axis`, project ENZ, through `measure.from_project` and the local direction `(E, Z, -N)`) and `shaft_r = lambda h: np.zeros_like(h)`: the person chose the points, so only points within 5 cm of the axis line go.
- `boxes.pair_faces(faces, axis_point, crown_xyz, shaft_r, drops)` (`boxes.py:532`) pairs front and back faces, drops implausible boxes and adds reflector dishes from `crown_xyz`; we pass the selection as `crown_xyz`. On a selection we take its unit with the most support. When it returns none but faces exist, we build one box from the face with most support with `unit_from_faces([face], axis_point, xyz)` (today `_group_unit`, `boxes.py:193`, which infers the depth) and set `kind = classify(unit, radial)`, `dish = None`. The person said it is equipment, so the drop reasons do not apply.
- `measure.measure_unit(unit, origin, convergence)` (`measure.py:97`) turns the unit into the JSON fields with bases and qualities, unchanged.
- Measuring is translation-invariant, so the job moves the points into the inventory's date frame before measuring and the box comes out in that frame.

The job does not re-run `crown.locate_crown`: the inventory's run already has the axis, so flagging needs an inventory (`telecom/antennas.json`) to exist. The Flag antenna button is disabled with "Run antenna detection first" without one (founder answer 1).

## Contract change

Owned by Task 1. Row for `docs/architecture/contract-changes.md`:

| Date       | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Why                                                                         | Streams affected                                   | Approved by                                               |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------- |
| 2026-10-22 | `AntennaUnit` gains optional `origin` (`'detected' \| 'flagged'`, absent = detected) and optional `centreHeightM` (`AntennaValue`, the box centre elevation a person typed) and optional `measured` (strict map of `azimuthGridDeg`, `downtiltDeg`, `centreHeightM`, `widthM`, `heightM`, `depthM` to the non-`user` `AntennaValue` a typed value replaced, for Reset to measured). `widthM`, `heightM` and `depthM` become optional in the object; the refinement still requires them unless `origin` is `flagged`, and skips the per-kind value rule for flagged units. New pipeline `telecom.flag` with `TelecomFlagParams` (`unit`, optional `redraw`, `cloud.layer`, `selection` of NDC `polygon`, local `viewProj`, local `bounds` and `anchor`), min pack `TELECOM_FLAG_MIN_PACK` 0.23.0; `telecom.antennas` on an inventory with person-owned units also needs 0.23.0. `aio.antennas/1` stays version 1; older readers do not read the new fields (strict objects), so forward compatibility is not claimed. | Manual antenna flagging and correction spec, section 3 and decisions 1 to 6 | @aio/schema, python pack, desktop (main, renderer) | Founder go-ahead on the manual flagging spec, 22 Oct 2026 |

Pack bump: yes, minor, `0.22.0` → `0.23.0` (new job plus a merge rule change), the way `82c00e93c` moved thermal to 0.22.0: `python/pyproject.toml`, `python/uv.lock`, the constant and the tests that pin it. `APP_RANGE` stays `>=0.22.0 <2.0.0` (an older app never sends `telecom.flag`). No new IPC channel: the renderer uses `jobs:start`, `telecom:readAntennas` and `telecom:writeAntennas`.

## Execution DAG

| Task | Title                                   | Depends on   | Packages                                 |
| ---- | --------------------------------------- | ------------ | ---------------------------------------- |
| 1    | Schema contract                         | none         | `@aio/schema`, docs                      |
| 2    | Merge keeps person-owned units          | none         | python pack                              |
| 3    | Measure a point selection               | none         | python pack                              |
| 4    | The `telecom.flag` job and pack 0.23.0  | 1, 2, 3      | python pack, `@aio/schema` (version pin) |
| 5    | Pack refusals in main                   | 1            | `@aio/desktop` (main)                    |
| 6    | Polygon tool and drawn-point collection | none         | `@aio/engine`, `@aio/pointcloud`         |
| 7    | Pure renderer helpers                   | 1            | `@aio/desktop` (renderer)                |
| 8    | Store actions                           | 1, 7         | `@aio/desktop` (renderer)                |
| 9    | Not-measured display, CSV and strings   | 1, 7         | `@aio/desktop` (renderer), `@aio/ui`     |
| 10   | Flag tool, button and highlight         | 6, 8, 9      | `@aio/desktop` (renderer)                |
| 11   | Card editing                            | 8, 9         | `@aio/desktop` (renderer)                |
| 12   | End to end                              | 4, 5, 10, 11 | `@aio/desktop` (e2e)                     |
| 13   | Guide, full checks the CI way           | 12           | docs, all                                |

Parallel batches (no shared files inside a batch; dispatch each batch in one message):

- **Batch A:** Tasks 1, 2, 3, 6.
- **Batch B:** Tasks 4, 5, 7.
- **Batch C:** Tasks 8, 9.
- **Batch D:** Tasks 10, 11.
- **Batch E:** Task 12.
- **Batch F:** Task 13.

**Critical path:** 1 → 7 → 8 → 10 → 12 → 13. Task 4 (the job) is the longest Python task and runs beside 7, 8 and 9; it must land before 12.

Shared-file notes: `antennas-contract.json` is written by Task 1 and only read by 2, 3, 4. `boxes.py` only by Task 3, `merge.py` only by Task 2. `antennaStore.ts` only by Task 8. `antennaScene.ts`, `antennaMeasure.ts`, `antennaCsv.ts`, `en.ts` only by Task 9. `AntennaCard.tsx` by Task 9 (Values for not measured) then Task 11 (different batches). `AntennaInventory.tsx`, `AntennaSection.tsx` only by Task 10.

---

### Task 1: Schema contract

**Files:**

- Modify: `packages/schema/src/antennas.ts`
- Modify: `packages/schema/src/jobs.ts:100-101, 367-371, 1324`
- Modify: `packages/schema/src/__fixtures__/antennas-contract.json`
- Modify: `docs/architecture/contract-changes.md` (append the row in "Contract change" above)
- Test: `packages/schema/src/antennas.test.ts`

**Interfaces:**

- Produces:
  - `AntennaOrigin = z.enum(['detected', 'flagged'])`; `AntennaUnit.origin?: AntennaOrigin`; `AntennaUnit.centreHeightM?: AntennaValue`; `widthM`, `heightM`, `depthM` optional in the type.
  - `AntennaMeasured` (strict object, keys `azimuthGridDeg`, `downtiltDeg`, `centreHeightM`, `widthM`, `heightM`, `depthM`, each optional, each an `AntennaValue` whose basis is not `user`); `AntennaUnit.measured?: AntennaMeasured` (the measured value a typed one replaced; read by Reset to measured).
  - `TELECOM_FLAG_MIN_PACK = '0.23.0'`, `TELECOM_FLAG_FEATURE = 'Antenna flagging'`.
  - `TelecomFlagParams` (strict): `{ unit: AntennaUnit['id'] regex, redraw?: true, cloud: { layer: string 1..128 }, selection: { polygon: [x, y][] 3..MAX_LASSO_VERTICES (each in -100..100), viewProj: number[16], bounds: { min: Vec3, max: Vec3 }, anchor: Vec3 } }`. `viewProj` is stage local (lined up, as drawn) to clip, column-major; `bounds` and `anchor` are stage local.
  - `PipelineName` gains `'telecom.flag'` (descriptor title `Measure a flagged antenna`, description `Measures one antenna, dish or other unit from the cloud points inside an outline a person drew, and adds it to the antenna inventory.`).
  - Contract fixture keys `flagged` (a measured flagged panel with a typed `azimuthGridDeg` of basis `user` and a `centreHeightM`) and `notMeasured` (flagged, kind `other`, `support` 12, placeholder box extents `[0.2, 0.2, 0.2]`, no sizes).

- [ ] **Step 1: Write the failing tests** in `antennas.test.ts`:

```ts
it('parses the flagged and not-measured contract units', () => {
  expect(AntennaUnit.parse(contract.flagged).origin).toBe('flagged');
  const nm = AntennaUnit.parse(contract.notMeasured);
  expect(nm.widthM).toBeUndefined();
  expect(nm.box.extents).toEqual([0.2, 0.2, 0.2]);
});
it('still needs the sizes and values of a detected unit', () => {
  const { widthM: _w, ...noWidth } = panel;
  expect(AntennaUnit.safeParse(noWidth).success).toBe(false);
  const { downtiltDeg: _d, ...noTilt } = panel;
  expect(AntennaUnit.safeParse(noTilt).success).toBe(false);
  expect(AntennaUnit.safeParse({ ...noTilt, origin: 'detected' }).success).toBe(false);
});
it('lets a flagged unit go without values and with any kind', () => {
  const { downtiltDeg: _d, widthM: _w, ...bare } = panel;
  expect(AntennaUnit.safeParse({ ...bare, origin: 'flagged' }).success).toBe(true);
});
it('refuses a user value whose quality basis is not user', () => {
  const bad = {
    ...contract.flagged,
    centreHeightM: { value: 31, basis: 'user', quality: { basis: 'measured' } },
  };
  expect(AntennaUnit.safeParse(bad).success).toBe(false);
});
it('keeps the replaced measured values and refuses a user value among them', () => {
  const m = { value: 12, basis: 'measured', quality: { basis: 'measured' } };
  expect(
    AntennaUnit.safeParse({ ...contract.flagged, measured: { azimuthGridDeg: m } }).success,
  ).toBe(true);
  const u = { value: 12, basis: 'user', quality: { basis: 'user' } };
  expect(
    AntennaUnit.safeParse({ ...contract.flagged, measured: { azimuthGridDeg: u } }).success,
  ).toBe(false);
  expect(AntennaUnit.safeParse({ ...contract.flagged, measured: { plumbDeg: m } }).success).toBe(
    false,
  );
});
it('validates telecom.flag params', () => {
  const ok = {
    unit: 'ant-f-abc',
    cloud: { layer: 'tower-cloud' },
    selection: {
      polygon: [
        [0, 0],
        [0.1, 0],
        [0.1, 0.1],
      ],
      viewProj: Array(16).fill(0),
      bounds: { min: [0, 0, 0], max: [1, 1, 1] },
      anchor: [0.5, 0.5, 0.5],
    },
  };
  expect(TelecomFlagParams.safeParse(ok).success).toBe(true);
  expect(TelecomFlagParams.safeParse({ ...ok, unit: 'x' }).success).toBe(false);
  expect(
    TelecomFlagParams.safeParse({ ...ok, selection: { ...ok.selection, polygon: [[0, 0]] } })
      .success,
  ).toBe(false);
  expect(pipelineParams('telecom.flag')).toBe(TelecomFlagParams);
  expect(PipelineName.options).toContain('telecom.flag');
  expect(TELECOM_FLAG_MIN_PACK).toBe('0.23.0');
});
```

- [ ] **Step 2: Run** `pnpm --filter @aio/schema exec vitest run src/antennas.test.ts`. Expected: FAIL (`contract.flagged` undefined, `TelecomFlagParams` not exported).
- [ ] **Step 3: Implement.** In the `superRefine`: first, unless `u.origin === 'flagged'`, add an issue for each of `widthM`, `heightM`, `depthM` that is undefined (`A ${u.kind} needs ${k}.`); then return early when `u.kindBasis !== 'geometry' || u.origin === 'flagged'`, else the existing per-kind rule. Add the fixture units, `jobs.ts` entries (comment `// Antenna flagging (pipeline pack TELECOM_FLAG_MIN_PACK)`), and the contract row.
- [ ] **Step 4: Run** `pnpm --filter @aio/schema exec vitest run` and `pnpm typecheck`. Expected: schema PASS. Typecheck errors in `apps/desktop` on `unit.widthM.value` are expected and fixed by Task 9; record the list in the commit body.
- [ ] **Step 5: Commit** `feat(schema): flagged antennas, typed centre elevation and the telecom.flag job` with the files above.

---

### Task 2: Merge keeps person-owned units

**Files:**

- Modify: `python/src/aio_pipelines/telecom/merge.py`
- Test: `python/tests/test_telecom_merge.py`

**Interfaces:**

- Produces (Task 4 uses):
  - `person_owned(u: dict) -> bool`: `u.get("origin") == "flagged"`, or any of `GEOMETRY_VALUES` (`azimuthGridDeg`, `downtiltDeg`, `plumbDeg`, `elevationDeg`, `diameterM`, `widthM`, `heightM`, `depthM`, `centreHeightM`) has `basis == "user"`.
  - `next_name(units: list[dict]) -> str`: `A<n+1>` after the highest `A<n>` in use (the rule `merge_with_sources` already applies; it calls this now).
  - `GEOMETRY` gains `"centreHeightM"`.

Rules (module docstring updated to say them):

- `_pairs`: a person-owned old unit matches whatever kind the new one has (as `_relabelled` does).
- Matched person-owned old unit, any status: kept unchanged except `photos`/`crop` through `_take_photos`, and `notFoundInLatest` removed. The matched new unit is absorbed.
- Unmatched person-owned old unit, any status: kept. A flagged one never gets `notFoundInLatest`; a detected accepted one with typed values gets it as today; a detected draft or rejected one with typed values is kept unflagged (today it would be dropped).
- Everything else unchanged.

- [ ] **Step 1: Write the failing tests:** `test_flagged_absorbs_a_new_unit_of_another_kind` (old flagged `other` at `[0,0,30]`, new `panel` 0.1 m away with more support: one unit out, kind `other`, box and `centreHeightM` unchanged, source index 0 so photos refresh); `test_typed_value_survives_a_better_supported_match` (old accepted detected panel with `downtiltDeg` basis `user` 6.0, new support higher: `downtiltDeg == {"value": 6.0, "basis": "user", ...}` and box unchanged); `test_typed_draft_is_kept_unmatched`; `test_rejected_flagged_is_kept_unmatched` (status `rejected`, no `notFoundInLatest`); `test_flagged_unmatched_is_not_flagged_missing`; `test_next_name_after_highest` (`["A2", "A9", "X"]` → `"A10"`; none → `"A1"`).
- [ ] **Step 2: Run** (Global Constraints Python command) `tests/test_telecom_merge.py -q`. Expected: the new tests FAIL, the old ones PASS.
- [ ] **Step 3: Implement** the rules and helpers in `merge.py`.
- [ ] **Step 4: Run** `tests/test_telecom_merge.py tests/test_telecom_pipeline.py -q`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(pipelines): antenna re-runs keep flagged units and typed values`.

---

### Task 3: Measure a point selection

**Files:**

- Create: `python/src/aio_pipelines/telecom/flag.py`
- Modify: `python/src/aio_pipelines/telecom/boxes.py:193` (rename `_group_unit` to `unit_from_faces`, keep `_group_unit = unit_from_faces`)
- Test: `python/tests/test_telecom_flag.py` (new)

**Interfaces:**

- Produces (Task 4 uses):
  - `FLAG_MIN_POINTS = 60` (below it, no measuring is tried), `PLACEHOLDER_M = 0.2`.
  - `select_points(xyz: np.ndarray, polygon: list[list[float]], view_proj: list[float]) -> np.ndarray` (bool mask): project homogeneous points with `m = np.asarray(view_proj).reshape(4, 4).T` (column-major, as `pointcloud_cleanup/evaluate.py:58`), keep `w > 0`, NDC = clip xy / w, then `pointcloud_cleanup.evaluate.in_polygon(np.asarray(polygon), x, y)`.
  - `measure_selection(xyz: np.ndarray, axis_point: np.ndarray, axis_dir: np.ndarray, origin: tuple[float, float, float], convergence: float | None) -> dict | None`: local-frame points in, the `measure_unit` dict out with `"support": len(xyz)` (the selection's point count) and `"convergenceDeg"`; `None` when `len(xyz) < FLAG_MIN_POINTS` or no face fits. Steps as in "How the existing measuring runs on a point subset".
  - `not_measured(anchor_local: np.ndarray, origin, support: int, convergence: float | None) -> dict`: `{"kind": "other", "box": {"centre": to_project(anchor), "axes": [[1,0,0],[0,0,1],[0,1,0]], "extents": [0.2, 0.2, 0.2]}, "support": support, "convergenceDeg": convergence}` and no value fields.

- [ ] **Step 1: Write the failing tests** with `antenna_synth.tower_cloud("monopole", seed=3, points_per_m2=4000)` and its truth:
  - `test_select_keeps_only_points_inside_bounds_and_polygon`: a view-projection looking at the truth panel at azimuth 0 from 4 m out; a polygon around its projected corners; with the points first cut to the truth box grown by 0.1 m, every selected point lies within 0.15 m of the box and none on the far side of the axis.
  - `test_measures_a_selected_panel_like_detection`: the truth box points of one panel, grown 0.05 m: kind `panel`, azimuth within 2 degrees of truth, width and height within 0.05 m, `widthM.basis == "measured"`, `support == len(selection)`.
  - `test_lone_face_still_measures`: only the front face points of the radio unit `radio-180`: a dict, not `None`, with `depthM.basis == "inferred"`.
  - `test_too_few_points_is_none`: 40 points → `None`.
  - `test_not_measured_has_no_values`: keys exactly `{"kind", "box", "support", "convergenceDeg"}`, extents `[0.2, 0.2, 0.2]`, centre is the anchor in project ENZ.
- [ ] **Step 2: Run** `tests/test_telecom_flag.py -q`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `flag.py` and the rename.
- [ ] **Step 4: Run** `tests/test_telecom_flag.py tests/test_telecom_faces.py tests/test_telecom_measure.py -q`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(pipelines): measure an antenna from a selected set of cloud points`.

---

### Task 4: The `telecom.flag` job and pack 0.23.0

**Files:**

- Create: `python/src/aio_pipelines/telecom/flag_pipeline.py`
- Modify: `python/src/aio_pipelines/pipelines.py:45, 108`, `python/pyproject.toml:3`, `python/uv.lock` (the `aio-pipelines` version line), `python/src/aio_pipelines/__init__.py` (one clause in the `APP_RANGE` comment: pack 0.23.0 adds `telecom.flag`, keeps the floor)
- Test: `python/tests/test_telecom_flag_pipeline.py` (new)

**Interfaces:**

- Consumes: Task 1 params and fixture; Task 2 `person_owned`, `next_name`, `GEOMETRY`; Task 3 `select_points`, `measure_selection`, `not_measured`, `FLAG_MIN_POINTS`; `pipeline._read_previous`, `_manifest`, `_origin`, `_convergence`, `_save_npz`; `engineer.cloud.read_region`; `captures.date_shift`, `capture_shift`, `local_delta`; `change.sources.height_offset_m`; `photos.posed_photos`, `best_photos`, `write_crop`; `runtime.commit_files`, `atomic_write_json`, `now_iso`.
- Produces: `class TelecomFlag` (`name = "telecom.flag"`, `keys = {"unit", "redraw", "cloud", "selection"}`), `validate` mirroring `TelecomFlagParams` with `JobError` messages, `inputs` → `["manifest.json", "clouds", "telecom"]`. Step outputs: `commit` returns `{"unitId", "measured": bool, "file": ANTENNAS_FILE}`.

Steps:

1. `select` ("Reading the outlined points"): previous file required, else `JobError("Run antenna detection first: flagging needs the tower found by a detection run.")`; redraw with an id not in the file → `JobError("The antenna to redraw is no longer in the inventory.")`. Read `read_region(path, fmt, {"min": bounds.min, "max": bounds.max}, 400_000, ctx, origin, offset_m=height_offset_m(layer), shift=date_shift(manifest, layer_id))` (drawn frame), keep `select_points(...)`, then move to the inventory frame: subtract `local_delta(capture_shift(manifest, run.captureId))` from x and z (zero when the run has no `captureId`). Save `selection.npz` (points, anchor in the same frame).
2. `measure` ("Measuring the flagged unit"): axis from `run.axis` (`from_project`, local dir `(E, Z, -N)`), `measure_selection`, else `not_measured(anchor, ...)`. Log the point count and which.
3. `photos` ("Picking the best photos"): `best_photos` for the one unit (temp id), `write_crop` to `crops/<unit>.jpg`.
4. `commit` ("Saving the inventory"): re-read the file; build the unit: new → `{**m, "id": unit, "name": next_name(units), "status": "accepted", "origin": "flagged", "kindBasis": "geometry", "kind": "other", "photos", "user": {}, "runId": run.id, "createdAt": now_iso()}`; redraw → the old unit without its `GEOMETRY` fields whose basis is not `user`, then the new geometry fields where the old has no user value, `origin: "flagged"`, old `id`, `name`, `status`, `kind`, `kindBasis`, `ai`, `user` kept, `notFoundInLatest` removed. `measured` is rebuilt: for each key the old unit holds as `user`, the new measurement of that key (when there is one; `centreHeightM` is the new box centre Z, basis `measured`) goes into `measured[key]`, so Reset to measured shows the redraw's value; keys without a user value get no `measured` entry; an empty map is omitted. A measured kind is kept only in the measurement values (decision 5: the stored kind stays `other` for a new flag). Crop first, file last (`commit_files`), as `telecom.antennas` does.

- [ ] **Step 1: Write the failing tests** (`make_tower_project` + `run_job`, with a starting inventory made by running `telecom.antennas` once in a module-scoped fixture):
  - `test_registered_and_validates` (bad unit id, two-vertex polygon, unknown key → `JobError`).
  - `test_flag_adds_an_accepted_flagged_unit`: selection around `radio-180` from a synthetic camera: one more unit, `origin == "flagged"`, `status == "accepted"`, `kind == "other"`, name `A<n+1>`, `support > 0`, box centre within 0.15 m of truth (project ENZ).
  - `test_too_few_points_is_not_measured`: a polygon around 0.1 m of empty sky next to the crown with an anchor: unit added, no `widthM`, extents `[0.2, 0.2, 0.2]`, centre = anchor.
  - `test_redraw_keeps_review_and_user_values`: an accepted detected unit with `user.model` and a typed `downtiltDeg`, redrawn: same id, name, status, model and typed downtilt; `origin == "flagged"`; box changed; `measured["downtiltDeg"]` is the redraw's measured downtilt (basis not `user`).
  - `test_flag_on_a_lined_up_date_is_stored_in_the_inventory_frame`: a manifest capture with a line-up (as `test_line_up_keeps_the_inventory_in_the_date_frame`): the stored centre equals the drawn centre minus the shift.
  - `test_commit_keeps_edits_made_during_the_job`: after `photos`, write the file with another unit accepted; after `commit` that unit is still accepted.
  - `test_rerun_keeps_flagged_and_typed`: flag, type `azimuthGridDeg` (basis `user`) into the file, run `telecom.antennas` again: the flagged unit is there once with the typed azimuth.
  - `test_never_uses_the_network`: run with `socket.socket` patched to raise; the job completes.
- [ ] **Step 2: Run** `tests/test_telecom_flag_pipeline.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement** the job and register it; bump the pack to 0.23.0.
- [ ] **Step 4: Run** `tests/test_telecom_flag_pipeline.py tests/test_telecom_pipeline.py tests/test_app_range.py -q` and `ruff format --check src tests && ruff check src tests`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(pipelines): telecom.flag measures an outlined antenna into the inventory` and `chore(pack): antenna flagging takes pipeline pack 0.23.0` (two commits).

---

### Task 5: Pack refusals in main

**Files:**

- Modify: `apps/desktop/src/main/telecomPack.ts`, `apps/desktop/src/main/index.ts:1639`
- Test: `apps/desktop/src/main/telecomPack.test.ts`

**Interfaces:**

- Produces: `antennaPackRefusal(pipeline: string, packVersion: string | null, inventory?: AntennasFile | null): string | null`; `hasPersonOwned(file: AntennasFile): boolean` (any unit with `origin === 'flagged'` or a value of basis `user`); `ANTENNA_FLAG_PACK_FEATURE = { label: TELECOM_FLAG_FEATURE, minVersion: TELECOM_FLAG_MIN_PACK }`.
- Rules: `telecom.flag` below 0.23.0 → `Antenna flagging needs processing tools 0.23.0 or later (these are X). Update them in Settings, Processing tools.`; `telecom.antennas` below 0.23.0 with `hasPersonOwned(inventory)` → the same sentence. `dev` and `null` pass, as today.
- In `index.ts`, for those two pipelines only, read the inventory with `fileInside(req.project, ANTENNAS_FILE)` from `@aio/project/fs`, `AntennasFile.safeParse` the JSON, and pass it (null on any failure).

- [ ] **Step 1: Write the failing tests** in `telecomPack.test.ts`: refuses `telecom.flag` on `'0.22.0'`, passes `'0.23.0'` and `'dev'`; refuses `telecom.antennas` on `'0.22.0'` with the contract `flagged` unit in the file; passes it with only detected units; `hasPersonOwned` true for a detected unit with one `user` value.
- [ ] **Step 2: Run** `pnpm --filter @aio/desktop exec vitest run src/main/telecomPack.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same and `pnpm --filter @aio/desktop exec vitest run src/main/jobsStart.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): ask for pack 0.23.0 before flagging antennas`.

---

### Task 6: Polygon tool and drawn-point collection

**Files:**

- Create: `packages/engine/src/tools/pcpolygon.ts`, `packages/engine/src/tools/pcpolygon.test.ts`
- Modify: `packages/engine/src/index.ts` (export), `packages/pointcloud/src/cleanup/count.ts`, `packages/pointcloud/src/index.ts`
- Test: `packages/pointcloud/src/cleanup/count.test.ts` (add to it, or create if absent)

**Interfaces:**

- Produces:
  - `class PolygonClickTool { constructor(stage: EngineStage, opts: { onClose(sel: PointSelection): void; onCancel(): void; onChange?(vertices: number): void }); attach(): () => void; undo(): void; close(): void }`. Each click (through `stage.claimClicks`, a click being a press and release under 4 px apart, as `pcselect.ts`) adds an NDC vertex; double-click, Enter or `close()` with at least 3 vertices calls `onClose({ shape: 'lasso', polygon, viewProj })` with `viewProj` computed as `pcselect.ts` does; Backspace and `undo()` drop the last vertex; Escape calls `onCancel`. SVG overlay `data-testid="pcpolygon-overlay"` with the `pcselect` stroke and fill, vertex dots, and a rubber band to the pointer. At most `MAX_LASSO_VERTICES` vertices (further clicks ignored).
  - `collectDrawn(handle: SceneHandle, layerId: string, inside: (x: number, y: number, z: number) => boolean, max = 200_000): Float32Array` (local xyz of the loaded, drawn points passing `inside` and the clipping planes; the same loop as `countDrawn`, stops at `max`).

- [ ] **Step 1: Write the failing tests:** three clicks then Enter → `onClose` with 3 vertices and a 16-number `viewProj`; two clicks then Enter → nothing; Backspace after three clicks then Enter → nothing; Escape → `onCancel`; detach removes the overlay and the key listener. `collectDrawn` on a fake manager with two chunks returns only the points `inside` accepts, in world-applied coordinates, and stops at `max`.
- [ ] **Step 2: Run** `pnpm --filter @aio/engine exec vitest run src/tools/pcpolygon.test.ts` and `pnpm --filter @aio/pointcloud exec vitest run src/cleanup`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat(engine): click-by-click outline tool and drawn point collection`.

---

### Task 7: Pure renderer helpers

**Files:**

- Create: `apps/desktop/src/renderer/telecom/antennaFlag.ts`, `antennaFlag.test.ts`, `antennaTyped.ts`, `antennaTyped.test.ts`

**Interfaces:**

- Produces (`antennaFlag.ts`):
  - `FLAG_DEPTH_GAP_M = 0.4`, `FLAG_MIN_CLUSTER = 8`, `FLAG_PAD_M = 0.1`.
  - `nearestCluster(points: Float32Array, eye: Vec3): Float32Array`: sort by distance to `eye`; the first run of at least `FLAG_MIN_CLUSTER` points with no gap over `FLAG_DEPTH_GAP_M` between neighbours in that order (shorter leading runs are noise and skipped). Empty in, empty out.
  - `flagSelection(kept: Float32Array, fallback: Vec3 | null): { bounds: { min: Vec3; max: Vec3 }; anchor: Vec3 } | null`: bounds of `kept` grown by `FLAG_PAD_M`, anchor its mean; with no kept points, `fallback` (the raycast under the polygon's centroid) with bounds ±0.3 m; `null` with neither.
  - `newFlagId(): string` → `ant-f-<base36 time>-<4 base36>` (matches `^ant-[a-z0-9-]{1,60}$`).
  - `flagParams(o: { unit: string; redraw: boolean; layer: string; sel: PointSelection; bounds; anchor }): TelecomFlagParams`.
- Produces (`antennaTyped.ts`):
  - `type TypedKey = 'azimuthGridDeg' | 'downtiltDeg' | 'centreHeightM' | 'widthM' | 'heightM' | 'depthM'`.
  - `TYPED_RANGE: Record<TypedKey, [number, number]>` = azimuth `[0, 360)` (360 reads as 0), downtilt `[-90, 90]`, centreHeight `[-1000, 10000]`, sizes `[0.01, 10]`.
  - `parseTyped(key: TypedKey, text: string): number | null` (dot decimal, trims, `null` when out of range or not a number).
  - `userValue(value: number): AntennaValue` → `{ value, basis: 'user', quality: { basis: 'user' } }`.
  - `boxWithValues(unit: AntennaUnit): AntennaBox`: outward `n = (cos t sin a, cos t cos a, -sin t)` in project ENZ from azimuth `a` (`azimuthGridDeg`, else the current outward axis's azimuth) and downtilt `t` (`downtiltDeg`, else the current tilt); up `= (sin t sin a, sin t cos a, cos t)` turned by `plumbDeg` (0 when absent) about `n`; across `= up × n` (`measure.py` convention: right seen from the front). Extents from `widthM`/`heightM`/`depthM` where present, else the current extents; centre Z from `centreHeightM` when present.
  - `withTyped(unit: AntennaUnit, key: TypedKey, value: number): AntennaUnit`: sets `userValue(value)`; when the current value exists and is not `user`, it moves into `measured[key]` (for `centreHeightM` with no value, the current `box.centre[2]` is kept as a `measured` value when the unit is measured); an existing `measured[key]` is kept when the current value is already `user`; then `box = boxWithValues(...)`.
  - `withoutTyped(unit: AntennaUnit, key: TypedKey): AntennaUnit`: only for a `user` value with `measured[key]`: restores `measured[key]` as the value, removes it from `measured` (the map dropped when empty), then `box = boxWithValues(...)`; otherwise returns the unit unchanged.
  - `canReset(unit: AntennaUnit, key: TypedKey): boolean`: the value is `user` and `measured[key]` exists.
  - `isPersonOwned(u: AntennaUnit): boolean`, `isNotMeasured(u: AntennaUnit): boolean` (`origin === 'flagged' && widthM === undefined`).

- [ ] **Step 1: Write the failing tests:**
  - `nearestCluster drops the far side behind a depth gap` (60 points 3 m away plus 60 points 4.5 m away → the 60 near ones); `skips a stray point in front`; `keeps an obliquely seen face whose depth spans 0.8 m without a gap`.
  - `flagSelection grows the bounds and falls back to the raycast`; `newFlagId matches the unit id pattern`.
  - `parseTyped` cases: `'271'` → 271, `'360'` → 0, `'-3.5'` downtilt → -3.5, `'95'` downtilt → null, `'0'` width → null, `'abc'` → null.
  - `boxWithValues reproduces a measured panel's axes` (the contract `panel` unit fed its own values: axes within 1e-3); `typed azimuth 90 turns the outward axis east`; `typed sizes set the extents`; `typed centre elevation moves the centre Z only`; `withTyped keeps the measured value it replaces`; `withTyped over a typed value keeps the first measured value`; `withoutTyped restores the measured value and its box`; `canReset is false for a not-measured unit and for a value nothing measured`.
- [ ] **Step 2: Run** `pnpm --filter @aio/desktop exec vitest run src/renderer/telecom/antennaFlag.test.ts src/renderer/telecom/antennaTyped.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): nearest-cluster selection and boxes from typed antenna values`.

---

### Task 8: Store actions

**Files:**

- Modify: `apps/desktop/src/renderer/telecom/antennaStore.ts`
- Test: `apps/desktop/src/renderer/telecom/antennaStore.test.ts`

**Interfaces:**

- Consumes: Task 7 helpers; Task 1 types.
- Produces (state): `flagging: { unit: string | null } | null` (null: tool off; `unit` set for a redraw), `flagJob: { id: string; unit: string } | null`.
- Produces (actions):
  - `beginFlag(unitId?: string): void` (refused while `running`, `readOnly`, no file, or a flag job runs), `endFlag(): void`.
  - `startFlag(o: { sel: PointSelection; bounds; anchor; layer: string }): Promise<void>`: `jobs:start` with `pipeline: 'telecom.flag'` and `flagParams` (new id from `newFlagId()` or the redraw id), sets `flagJob`, ends the tool. On `done`: reload, select the unit, and, when `getAiLabelPref(projectId)` is on, `offerAiLabels` for `[unitId]` only (the same send preview and consent as after a run). After a redraw whose unit keeps typed values, the store writes `box = boxWithValues(unit)` once (the job measured a new box; the typed values still win, decision 4). On `failed`: `message` = the job error.
  - `setTypedValue(id: string, key: TypedKey, value: number): Promise<void>`: `withTyped(unit, key, value)`, through `change`.
  - `resetTypedValue(id: string, key: TypedKey): Promise<void>`: `withoutTyped(unit, key)` through `change`; nothing written when `canReset` is false.
  - `setUnitKind(id: string, kind: AntennaKind): Promise<void>`: `kind`, `kindBasis: 'user'`, `ai` removed.
  - `deleteFlaggedUnit(id: string): Promise<void>`: removes the unit only when `origin === 'flagged'`; clears `selected` and `hidden` for it.
- `onJobs` handles `flagJob` beside the detection job; one does not end the other.

- [ ] **Step 1: Write the failing tests** (the existing bridge mock): `beginFlag is refused while detection runs`; `startFlag sends telecom.flag with the selection and ends the tool`; `a finished flag job reloads and selects the new unit`; `a finished flag job offers AI labels for that unit only when the preference is on`; `a finished redraw rebuilds the box from the typed values it kept`; `setTypedValue writes a user value and moves the box`; `resetTypedValue brings back the measured value`; `setUnitKind marks the kind as the person's`; `deleteFlaggedUnit leaves a detected unit alone`.
- [ ] **Step 2: Run** `pnpm --filter @aio/desktop exec vitest run src/renderer/telecom/antennaStore.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): antenna store flags, redraws, types values and deletes flagged units`.

---

### Task 9: Not-measured display, CSV and strings

**Files:**

- Modify: `apps/desktop/src/renderer/telecom/antennaScene.ts:154, 238`, `antennaMeasure.ts:66, 120-160`, `antennaCsv.ts:55-78`, `AntennaCard.tsx:431-495` (the `Values` part only), `packages/ui/src/i18n/en.ts`
- Modify where typecheck points after Task 1 (expected: `rf/autoplan` already reads sizes as optional; fix any other site)
- Test: `antennaScene.test.ts`, `antennaMeasure.test.ts`, `antennaCsv.test.ts`, `AntennaCard.test.tsx`

**Interfaces:**

- Consumes: `isNotMeasured`, `isPersonOwned` (Task 7).
- Behaviour: a not-measured unit draws its placeholder box dashed, its facing arrow omitted, its name label reads `A12 · Not measured`, and no dimension lines; the arrow length uses `heightM?.value ?? box.extents[1]`. The card `Values` shows `Not measured` (with the tip) for missing values, and the altitude row reads `centreHeightM` (dotted, its basis tip) when present, else `box.centre[2]` as today. CSV: a new `origin` column after `status` (`detected` or `flagged`), missing values as empty cells, and the basis of each value column as today.
- Strings (exact; keys under `telecom.antennas.`):

| Key               | English                                                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `flag.button`     | Flag antenna                                                                                                                     |
| `flag.tip`        | Draw an outline around a unit the detection missed, then measure it from the points inside.                                      |
| `flag.needsRun`   | Run antenna detection first                                                                                                      |
| `flag.drawing`    | Click around the unit to outline it. Enter or double-click closes the outline, Backspace removes the last point, Escape cancels. |
| `flag.kept`       | {count} points kept, nearest the camera.                                                                                         |
| `flag.none`       | No cloud points inside the outline. The unit is placed where the outline's middle meets the cloud.                               |
| `flag.offCloud`   | Draw the outline over the cloud.                                                                                                 |
| `flag.measure`    | Measure                                                                                                                          |
| `flag.again`      | Draw again                                                                                                                       |
| `flag.cancel`     | Cancel                                                                                                                           |
| `origin.flagged`  | Flagged by you                                                                                                                   |
| `notMeasured`     | Not measured                                                                                                                     |
| `notMeasured.tip` | Too few points to measure. Type the values you know.                                                                             |
| `card.redraw`     | Redraw outline                                                                                                                   |
| `card.delete`     | Delete                                                                                                                           |
| `card.kind`       | Kind                                                                                                                             |
| `typed.title`     | Your values                                                                                                                      |
| `typed.azimuth`   | Azimuth (°)                                                                                                                      |
| `typed.downtilt`  | Downtilt (°)                                                                                                                     |
| `typed.centre`    | Centre elevation (m)                                                                                                             |
| `typed.width`     | Width (m)                                                                                                                        |
| `typed.height`    | Height (m)                                                                                                                       |
| `typed.depth`     | Depth (m)                                                                                                                        |
| `typed.reset`     | Reset to measured                                                                                                                |
| `typed.reset.tip` | Clear your value and show the measured one again.                                                                                |
| `typed.invalid`   | Enter a number from {min} to {max}.                                                                                              |

- [ ] **Step 1: Write the failing tests:** `antennaCsv leaves the size cells of a not-measured unit empty` and `writes the origin column`; `antennaMeasure has no dimension lines for a not-measured unit` and `labels it Not measured`; `antennaScene draws a not-measured unit dashed without an arrow`; `card shows Not measured` and `card altitude shows a typed centre elevation as yours`.
- [ ] **Step 2: Run** `pnpm --filter @aio/desktop exec vitest run src/renderer/telecom`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement**, then `pnpm typecheck` until clean.
- [ ] **Step 4: Run** `pnpm --filter @aio/desktop exec vitest run src/renderer/telecom src/renderer/rf` and `pnpm --filter @aio/ui exec vitest run src/i18n`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): show not-measured and flagged antennas everywhere sizes are read`.

---

### Task 10: Flag tool, button and highlight

**Files:**

- Create: `apps/desktop/src/renderer/telecom/AntennaFlagTool.tsx`, `AntennaFlagTool.test.tsx`, `flagScene.ts`
- Modify: `apps/desktop/src/renderer/telecom/AntennaInventory.tsx:157-200`, `AntennaSection.tsx`
- Test: `AntennaInventory.test.tsx`

**Interfaces:**

- Consumes: `PolygonClickTool`, `collectDrawn` (Task 6); `nearestCluster`, `flagSelection` (Task 7); `beginFlag`, `endFlag`, `startFlag`, `flagging`, `flagJob` (Task 8); `selectionTest` from `renderer/pointcloud/cleanupScene.ts` (the same polygon test the cleanup count uses); `getActiveStage`, `useAntennaClouds` (`AntennaRunner.tsx:50`).
- Produces:
  - `drawFlagPoints(stage: EngineStage, points: Float32Array): () => void` (a `Points` object, 4 px, `#ffb020`, `depthTest: false`, named `antenna-flag-points`).
  - `AntennaFlagTool` (mounted by `AntennaSection` while `flagging` is set): arms the polygon tool on the active stage; shows `flag.drawing` (`data-testid="antenna-flag-hint"`); on close, collects the drawn points of the active cloud layer (`s.cloudLayer` or the newest visible cloud, as detection picks) inside the polygon, keeps `nearestCluster` with `stage.camera.position` as the eye, highlights them, and shows a bar (`data-testid="antenna-flag-bar"`) with `flag.kept` or `flag.none`, and buttons Measure (`antenna-flag-confirm`), Draw again (`antenna-flag-again`), Cancel (`antenna-flag-cancel`). With no kept points and no raycast hit at the polygon's centroid, Measure is disabled with `flag.offCloud`.
  - Inventory: a `Flag antenna` button (`data-testid="antenna-flag"`, tip `flag.tip`) in the header row beside Hide all, and in the "no units" empty branch; without a file it shows disabled with `flag.needsRun`; disabled while detection or a flag job runs. Rows of flagged units show the `origin.flagged` chip (`data-testid="antenna-origin"`).

- [ ] **Step 1: Write the failing tests:** `Flag antenna is disabled with a reason without an inventory`; `Flag antenna shows in an empty inventory`; `the flag tool shows the kept count and sends the selection on Measure` (stub stage and `collectDrawn`); `Cancel ends the tool and removes the highlight`; `a flagged row shows its chip`.
- [ ] **Step 2: Run** `pnpm --filter @aio/desktop exec vitest run src/renderer/telecom/AntennaFlagTool.test.tsx src/renderer/telecom/AntennaInventory.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.** Load the `impeccable` and `frontend-design` skills first; keep the existing telecom tool look (`telecom-actions`, `Button size="sm"`).
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): Flag antenna outlines a unit on the cloud and measures it`.

---

### Task 11: Card editing

**Files:**

- Create: `apps/desktop/src/renderer/telecom/AntennaTypedValues.tsx`, `AntennaTypedValues.test.tsx`
- Modify: `apps/desktop/src/renderer/telecom/AntennaCard.tsx` (head and body sections, not `Values`)
- Test: `AntennaCard.test.tsx`

**Interfaces:**

- Consumes: `setTypedValue`, `setUnitKind`, `deleteFlaggedUnit`, `beginFlag` (Task 8); `parseTyped`, `TYPED_RANGE`, `isPersonOwned` (Task 7).
- Behaviour:
  - `AntennaTypedValues` (section `typed.title`, under the values, collapsed by default, open for a not-measured unit): one input per `TypedKey` (`data-testid="antenna-typed-<key>"`), downtilt hidden for a dish, prefilled with the current value; commits on Enter or blur through `parseTyped`; an invalid entry shows `typed.invalid` and writes nothing; an empty entry writes nothing (a typed value is changed by typing another, or cleared with Reset to measured).
  - **Reset to measured** (`data-testid="antenna-typed-reset-<key>"`, label `typed.reset`, tip `typed.reset.tip`) beside each input, shown only when `canReset(unit, key)`; clicking calls `resetTypedValue`; disabled for read-only projects.
  - Kind picker (`data-testid="antenna-card-kind-pick"`, panel, short, dish, other) beside the kind line; picking calls `setUnitKind`.
  - Footer: `Redraw outline` (`antenna-card-redraw`) for every unit → `beginFlag(unit.id)`; `Delete` (`antenna-card-delete`) only for flagged units → `deleteFlaggedUnit`. Accept and Reject stay; disabled for read-only projects.

- [ ] **Step 1: Write the failing tests:** `typing an azimuth writes a user value`; `an out-of-range downtilt shows the range and writes nothing`; `a dish has no downtilt input`; `Delete shows for flagged units only`; `Redraw outline starts the tool for this unit`; `picking a kind marks it as yours`; `Reset to measured shows only for a typed value with a measured one and resets it`.
- [ ] **Step 2: Run** `pnpm --filter @aio/desktop exec vitest run src/renderer/telecom/AntennaTypedValues.test.tsx src/renderer/telecom/AntennaCard.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** (design skills loaded as in Task 10).
- [ ] **Step 4: Run** the same and `pnpm --filter @aio/desktop exec vitest run src/renderer/telecom`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): type antenna values, pick the kind, redraw or delete from the card`.

---

### Task 12: End to end

**Files:**

- Modify: `apps/desktop/e2e/telecomFixtures.ts` (`writeTelecomTower` returns the truth from `<out>.json`; new `writeAntennaInventory(dir)`)
- Create: `apps/desktop/e2e/telecom-antenna-flag.spec.ts`

**Interfaces:**

- `writeTelecomTower(dir): Promise<TowerTruth>` where `TowerTruth.units` holds the synth `_spec` records (`name`, `kind`, `centre` local, `azimuthDeg`, `widthM`, `heightM`, `depthM`). Existing callers ignore the return.
- `writeAntennaInventory(dir)`: a valid `AntennasFile` with no units and a run on `tower-cloud` with axis point `[0, 0, 0]`, dir `[0, 0, 1]`, source `auto`, crown floor 25 m, top 30 m, radius 3 m, `north: 'project'` (the tower fixture has no Earth place), so the test needs one detection run only.

Spec (`test.use({ appEnv: PIPELINE_ENV })`, skipped without the pipeline Python, `test.setTimeout(420_000)`), on the synthetic monopole (seed 3, 1500 points per m2) whose detection finds 8 units and misses the radio unit `radio-180`:

1. `writeTelecomTower` + `writeAntennaInventory`, open the project and the telecom tools (`openTiny` as in `telecom-antennas.spec.ts`), wait for the cloud.
2. Aim the view at `radio-180`: `restoreView({ position: centre + 3 m along its outward normal, target: centre })`.
3. Click `antenna-flag`; project the truth box's 8 corners to screen with the stage camera (in `win.evaluate`), take their convex hull grown by 6 px, click each vertex on the canvas, press Enter.
4. Expect `antenna-flag-bar` to show a kept count above 0 and `antenna-flag-points` in the scene; click `antenna-flag-confirm`; wait for the job (jobs chip) and one row with `antenna-origin`.
5. The file on disk has the unit with `origin: 'flagged'`, `status: 'accepted'`, and its box centre within 0.3 m of the truth centre (project ENZ = local x, -z, y).
6. Open its card, type `271` into `antenna-typed-azimuthGridDeg`, Enter; the azimuth value shows `data-basis="user"`.
7. Click `detect-antennas`; wait for 9 rows under the All filter (8 detected plus the flagged one; no duplicate next to it).
8. The flagged unit is still `origin: 'flagged'` with `azimuthGridDeg` `{ value: 271, basis: 'user' }`; reload the window and check the row and the value again. Then, the flagged unit being measured, click `antenna-typed-reset-azimuthGridDeg`: the azimuth shows a basis other than `user`, and the file's `azimuthGridDeg` is not `user` and `measured` has no `azimuthGridDeg`.
9. `expectAccessible` on the card and the inventory; with `AIO_EVIDENCE_DIR` set, screenshots of the outline, the preview and the card.

- [ ] **Step 1: Write the spec** as above.
- [ ] **Step 2: Run it the way CI does**, from `apps/desktop` in PowerShell (the worktree has no venv of its own; this branch changes `python/`, so make a scratch venv from the main venv's base interpreter with a `.pth` that puts this worktree's `python/src` first, as in the "subagents pinned to session worktree" note, and point `QUADRION_E2E_PYTHON` at its `python.exe`):

```powershell
pnpm demo:build --quick --python "<scratch venv>/Scripts/python.exe"
pnpm demo:change --quick
$env:QUADRION_WINDOW_SIZE = '1100x720'; $env:QUADRION_E2E_SCALE = '1'; $env:QUADRION_E2E_SWGL = 'warp'
$env:QUADRION_E2E_PYTHON = '<scratch venv>/Scripts/python.exe'
npx playwright test e2e/telecom-antenna-flag.spec.ts e2e/telecom-antennas.spec.ts --workers=1
```

Expected: the log prints `[e2e] window 1100 x 720 px at display scale 1`; both specs PASS. Then `--repeat-each=3` on the new spec. One Playwright run at a time.

- [ ] **Step 3: Fix** what fails (systematic-debugging), re-run.
- [ ] **Step 4: Commit** `test(e2e): flag a missed antenna, type its azimuth and keep it through a re-run`.

---

### Task 13: Guide, full checks the CI way

**Files:**

- Modify: `docs/guide/45-antenna-inventory.md` (a "Flag a missed unit" section and a "Correct a unit" section: Redraw outline, Your values, Delete; what "Not measured" means; a re-run keeps what you flagged and typed)

- [ ] **Step 1: Write the guide sections**; `node tools/agent/check-public-text.mjs docs/guide/45-antenna-inventory.md docs/superpowers/plans/2026-10-22-antenna-manual-flagging.md`. Expected: no findings.
- [ ] **Step 2: Run** `pnpm check` from the worktree root. Expected: PASS.
- [ ] **Step 3: Run** the full telecom and RF Python suites: `tests/test_telecom_*.py tests/test_antenna_synth.py tests/test_rf_*.py tests/test_app_range.py -q`. Expected: PASS.
- [ ] **Step 4: Run** `e2e/telecom-antennas.spec.ts`, `e2e/telecom-antenna-flag.spec.ts` and `e2e/rf-coverage.spec.ts` the CI way (Task 12 command). Expected: PASS.
- [ ] **Step 5: Commit** `docs(guide): flag and correct antennas`.

## How to test (for the founder)

1. Open a project with a tower point cloud, open the Measure workbench, Telecom, and run **Detect antennas**.
2. Turn the 3D view to a unit that is not in the list. In the antenna panel click **Flag antenna**.
3. Click around the unit on the cloud, one click per corner; press Enter. The points kept (only the near side) light up in orange and the bar says how many.
4. Click **Measure**. The jobs chip shows the job; the unit appears in the list as accepted, with the "Flagged by you" chip and its measured box. An outline with too few points adds a small box marked "Not measured".
5. Open its card, open **Your values**, type an azimuth and press Enter: the box turns, and the value is underlined as yours. Click **Reset to measured** next to it: the measured azimuth comes back and the box turns back (the control is hidden on a "Not measured" unit).
6. Run **Detect antennas** again: the flagged unit is still there once, with your azimuth.
7. On a detected unit with a wrong box, click **Redraw outline** and outline it again: it keeps its name, status and typed fields. **Delete** shows only on flagged units.

## Founder answers (22 Oct)

1. Flagging needs a detection run first: accepted. Without an inventory the Flag antenna tool is disabled with "Run antenna detection first" (Tasks 4, 9, 10).
2. A per-value **Reset to measured** control on the card next to each typed value: added (Tasks 1, 4, 7, 8, 9, 11, 12).
