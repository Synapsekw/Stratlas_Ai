# Engineer asset region Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A telecom monopole that stands in a fenced compound is modelled at its true height, with no false lights and no stray cabinets. To get there, the person can draw a turnable 3D region box. The section fit survives a compound at the foot, the measured height is checked against the cloud and the AI, lights need confirmation, and "asset only" means asset only in every family.

**Architecture:** The region becomes a turnable box that matches the point cloud clip box (`ClipBoxLocal`), and the setup edits it with the existing `ClipBoxTool`. The contract `EvidenceRegion` gains that box, and the old circle and `{min, max}` shapes stay readable. The Python `model.evidence` job crops with the box. It fits sections as runs, not one run that rejects everything after a jump. It checks the height against the cloud top and writes equipment clusters into `evidence.json`. In `@aio/modelling`, the assembler orders the heights as person, then measured, then a plausible AI height. It drops low unconfirmed lights, removes cabinets centrally in "asset only", and places cabinets from the equipment clusters.

**Tech Stack:** TypeScript (zod 4, three.js through `@aio/engine`, React), Vitest, Playwright with Electron, Python 3 (numpy), pytest.

**Spec:** the founder-approved brief (16 Oct 2026, items A to F), quoted in "Scope" below. Background: `docs/plans/2026-10-15-engineering-model-design.md`, `docs/guide/44-engineering-models.md`.

## Scope (founder-approved, one branch)

The run that motivated this branch was a ~31 m monopole in a fenced compound in a telecom monopole test project. It had a cloud only, no region, the family left to the evidence and the scope "asset only". Every part of the model came out at the ground. Isolation kept the pole and the compound together. The first 5 sections fitted the fence and the canopies (r about 3.8 m), so every slice above them was a "radius-jump" (`sections.py:127`). The height was therefore 2.74 m. The assembler took that over the AI's 31.3 m (`assemble.ts:165`). Canopy roofs became 7 measured warning lights. Cabinets went on an even 60 degree layout in "asset only".

- **A.** The region of interest is an editable 3D box: drag the faces, turn it with a ring, set the top and bottom heights. It reuses the clip box editor and can start from "Fit to selection". The contract carries a turned box with a height range, and the old circle and box params stay readable. Python honours the turned box and the height range.
- **B.** Sections: a run of N steady slices at a new radius starts a new run, and the tallest run is the shaft.
- **C.** Height sanity: compare the measured height with the cloud top. On a big gap, warn and use the larger plausible value or the AI's height. A person's known dimension always wins.
- **D.** Lights only when the AI confirms them, or when they sit above 50% of the height.
- **E.** "Asset only" leaves out cabinets, compound and equipment for every family.
- **F.** In "asset and equipment", cabinets take their positions and sizes from the dropped clusters in the evidence.

## Global Constraints

- TypeScript strict; no `any`, no non-null assertions (`CONTRIBUTING.md`).
- No em or en dashes in user-facing text; UI strings go through `packages/ui/src/i18n/en.ts` (`t('eng.setup.*')`).
- Public repo: no client, site or person names in code, tests, fixtures, docs or commit messages; say "a telecom monopole test project".
- `@aio/schema` contracts are frozen: every change in Task 1 gets a row in `docs/architecture/contract-changes.md` (`| Date | Change | Why | Streams affected | Approved by |`, approved "Founder (16 Oct 2026, scope approval)").
- `aio.evidence/1` stays version 1: every evidence change is additive and optional.
- Local frame everywhere: x east, y up, z south (north = -z) from the project origin; the box `yaw` is radians about up, east toward north, as `ClipBoxLocal` (`packages/engine/src/tools/clipbox.ts:26`).
- Python in a worktree: run tests with the main checkout's venv and the worktree source first on the path, from `<worktree>\python`: `$env:PYTHONPATH='src'; & 'E:\Dev\AIO Software\python\.venv\Scripts\python.exe' -m pytest <tests> -q`. Never junction the venv. After any `uv` command, check that `python -c "import aio_pipelines; print(aio_pipelines.__file__)"` points where you expect.
- e2e: `--workers=1`, off-screen fixtures, the CI way (`QUADRION_WINDOW_SIZE=1100x720`, `QUADRION_E2E_SCALE=1`, `QUADRION_E2E_SWGL=warp`, `pnpm demo:build --quick` first), and `QUADRION_E2E_PYTHON` pointed at the main checkout's venv.
- Heavy runs (pytest of `test_model_evidence.py`, Playwright) one at a time on this PC.

## Decisions taken in this plan (founder: please confirm)

1. **The region is a box only.** The setup no longer offers the circle. The box editor replaces the circle and the "Box" toggle. Saved runs that hold a circle or `{min, max}` still parse, still run in Python and reopen as a box.
2. **Wire shape.** A box with `yaw` 0 is still sent as `{ min, max }`, which every pack since 0.11.0 reads. Only a turned box uses the new `{ center, size, yaw }`.
3. **Pack 0.14.0.** `MODEL_EVIDENCE_MIN_PACK` becomes `'0.14.0'`, and `python/pyproject.toml` is bumped to 0.14.0 on this branch, because B, C and F live only in the new pack. An installer and pack build is still the founder's call.
4. **The shaft is the tallest run.** On a stepped chimney (a wide lower part and a taller narrow upper part) only the taller part is fitted, and the run warns. This is accepted for now (see Risks).
5. **The cloud top wins in Python when the sections stop short.** The rule is a gap above max(3 m, 25% of the cloud top). The assembler then still compares that height with the AI's metric height. A person's reference height always wins and stays metric.
6. **Lights below half the height need the AI's confirmation.** The proposal's `warningLight` must have `observed: true` and `count > 0`. Lights the person places are never dropped.
7. **"Asset only" removes `cabinet` assemblies centrally** in `assemble()`, for every family. Cabinets the person accepted earlier stay, flagged, like any removed role. No other kind counts as surroundings today: there is no fence or building kind.
8. **Cabinets come from the evidence only as many as the AI or the person counts.** Clusters alone never invent cabinets, because a vehicle or a pallet would become one. A clustered cabinet is axis-aligned (yaw 0) and sits on the asset base height.

## Review Focus

1. **A turned box around a pole leaves the fence out.** A box of 3 x 3 m turned 30 degrees, with the bottom just above the ground, must still find the base: with no ground in the box the base is the lowest point and the run says so. Test: `test_a_turned_box_with_the_bottom_above_the_ground_counts_from_the_lowest_point` (Task 4).
2. **An old run reopened.** A setup saved with `{ centre, radiusM }` must open the dialog as a box, not crash, and a rerun must send a valid region. Test: `reopens an old circle region as a box` (Task 11).
3. **A chimney with flues over the crown and a seed outlier at the plinth.** It must keep today's taper (`test_partial_noisy_stack_taper` unchanged) and the committed partial-stack fixture must not drift beyond the regenerated `heightCheck`. Test: `test_a_chimney_keeps_one_run_with_flues_above` (Task 3).
4. **A box dragged to its minimum, or turned past +-180 degrees.** The face stays at 0.1 m and the yaw wraps. Both still parse (`size >= 0.1`, `|yaw| <= pi`). Test: `a box at the minimum size and a wrapped yaw round-trips` (Task 1).
5. **Switching to "asset only" on a rerun after cabinets were accepted.** The accepted cabinets stay, flagged, and new ones are not generated. Test: `asset only on a rerun keeps accepted cabinets flagged and adds none` (Task 7).

## File Structure

| File                                                                                                                                                                                                | Task                         | Change                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------- |
| `packages/schema/src/engineer.ts`                                                                                                                                                                   | 1                            | `RegionBox`, `EvidenceRegion` third member, `regionBoxOf`, `regionOfBox`, `regionPlanRadius` |
| `packages/schema/src/modelEvidence.ts`                                                                                                                                                              | 1                            | `heightCheck`, `isolation.equipment`, `MODEL_EVIDENCE_MIN_PACK = '0.14.0'`                   |
| `packages/schema/src/engineer.test.ts`, `modelEvidence.test.ts`                                                                                                                                     | 1 (5 adds the fixture parse) | tests                                                                                        |
| `docs/architecture/contract-changes.md`                                                                                                                                                             | 1                            | one row                                                                                      |
| `python/tests/synth_assets.py`                                                                                                                                                                      | 2                            | `COMPOUND_MONOPOLE`, `compound_monopole_cloud`                                               |
| `python/src/aio_pipelines/engineer/sections.py`                                                                                                                                                     | 3                            | runs in `fit_sections`                                                                       |
| `python/tests/test_engineer_sections.py` (new)                                                                                                                                                      | 3                            | tests                                                                                        |
| `python/src/aio_pipelines/engineer/cloud.py`                                                                                                                                                        | 4                            | turned box in `_inside`, `_world_bounds`, `region_centre`; `equipment_clusters`              |
| `python/tests/test_engineer_cloud.py`                                                                                                                                                               | 4                            | tests                                                                                        |
| `python/src/aio_pipelines/engineer/pipeline.py`                                                                                                                                                     | 5                            | validate, `_checked_height`, evidence fields, warnings                                       |
| `python/tests/test_model_evidence.py`, `python/pyproject.toml`, `python/uv.lock`                                                                                                                    | 5                            | regression tests, pack 0.14.0                                                                |
| `packages/schema/src/__fixtures__/engineering/evidence.compound-monopole.json` (new)                                                                                                                | 5                            | fixture written by the pack                                                                  |
| `packages/modelling/src/engineer/assemble/shared.ts`                                                                                                                                                | 6                            | light rule in `lights()`                                                                     |
| `packages/modelling/src/engineer/assemble/shared.test.ts` (new)                                                                                                                                     | 6                            | tests                                                                                        |
| `packages/modelling/src/engineer/assemble/assemble.ts`                                                                                                                                              | 7                            | `resolveScale`, the "asset only" filter                                                      |
| `packages/modelling/src/engineer/assemble/scale.test.ts` (new)                                                                                                                                      | 7                            | tests                                                                                        |
| `packages/modelling/src/engineer/assemble/equipment.ts` (new)                                                                                                                                       | 8                            | `equipmentPlacements`                                                                        |
| `packages/modelling/src/engineer/assemble/telecom.ts`, `chimney.ts`                                                                                                                                 | 8                            | cabinets from `equipmentPlacements`; chimney duct reach by `regionPlanRadius`                |
| `packages/modelling/src/engineer/assemble/equipment.test.ts` (new), `telecom.test.ts`, `chimney.test.ts`                                                                                            | 8                            | tests                                                                                        |
| `packages/modelling/src/engineer/acceptance.test.ts`, `fixtures.ts`                                                                                                                                 | 9                            | scenario I                                                                                   |
| `apps/desktop/src/renderer/engineer/regionBox.ts` (new) + `.test.ts`                                                                                                                                | 10                           | editor mount, fit, box around a point, debug hook                                            |
| `apps/desktop/src/renderer/engineer/SetupDialog.tsx`, `EngineerLayer.tsx`, `SetupDialog.test.tsx`, `EngineerLayer.test.tsx`, `apps/desktop/src/renderer/bootstrap.ts`, `packages/ui/src/i18n/en.ts` | 11                           | the box UI                                                                                   |
| `apps/desktop/e2e/engineering-region-box.spec.ts` (new), `engineering-flow.spec.ts`                                                                                                                 | 12                           | e2e                                                                                          |
| `apps/desktop/e2e/engineering-compound.spec.ts` (new), `engineering-fixture.py`, `packages/ai/src/scripted.ts`                                                                                      | 13                           | e2e regression                                                                               |
| `docs/guide/44-engineering-models.md`                                                                                                                                                               | 14                           | guide                                                                                        |

Packages touched: `@aio/schema`, `@aio/modelling`, `@aio/ui` (strings), `@aio/ai` (scripted test reply only), `@aio/desktop` (renderer and e2e), the pipeline pack (`aio_pipelines`), and docs. `@aio/engine` is reused as is: `ClipBoxTool`, `boxAxes`, `layerBox` and `BoxHandle`, with no change.

## Execution DAG

```
Batch 1:  T1 schema ──┬──> T7 scale+scope ─────────────┐
                      ├──> T8 cabinets ────────────────┤
                      ├──> T10 regionBox ──> T11 setup UI ──> T12 e2e box
                      └──────────────┐                 │
          T2 synth ──┬──> T3 sections ──┐              ├──> T9 acceptance I
                     └──> T4 region+clusters ──> T5 pipeline+fixture ──> T13 e2e compound
          T6 light rule ───────────────────────────────┘
          T14 guide (any time after T11's strings are fixed; scheduled in batch 4)
```

- **Batch 1:** T1 (`packages/schema`, contract row), T2 (`python/tests/synth_assets.py`), T6 (`assemble/shared.ts` and its new test). No shared files.
- **Batch 2:** T3 (`sections.py`, new test file), T4 (`cloud.py`, `test_engineer_cloud.py`), T7 (`assemble.ts`, new `scale.test.ts`), T8 (new `equipment.ts`, `telecom.ts`, `chimney.ts` and their tests), T10 (new `regionBox.ts`). No shared files. T3 and T4 need T2. T7, T8 and T10 need T1.
- **Batch 3:** T5 (`pipeline.py`, `test_model_evidence.py`, pyproject, the new fixture, `modelEvidence.test.ts`) needs T1, T3 and T4. T11 (setup UI files) needs T10.
- **Batch 4:** T9 (`acceptance.test.ts`, `fixtures.ts`), T12 (new spec, `engineering-flow.spec.ts`), T13 (new spec, `engineering-fixture.py`, `scripted.ts`), T14 (guide). No shared files.
- **Critical path:** T2 -> T3 -> T5 -> T13 (Python sections to the e2e regression). T1 -> T10 -> T11 -> T12 is the same length; the slowest single task is T3.
- **Contract change:** T1 only (one row). T5 regenerates `evidence.partial-stack.json` (new `heightCheck`, `isolation.equipment`) with `AIO_UPDATE_FIXTURES=1`.

| Task         | Model, effort   | Why                                               |
| ------------ | --------------- | ------------------------------------------------- |
| T1           | sonnet, default | schema plus helpers, well specified               |
| T2           | sonnet, low     | synthetic geometry                                |
| T3           | opus, high      | the run algorithm and chimney regressions         |
| T4           | sonnet, default | geometry plus clustering                          |
| T5           | sonnet, default | integration, fixtures                             |
| T6, T7, T8   | sonnet, default | rules with exact tests                            |
| T9           | sonnet, low     | assertions on a fixture                           |
| T10          | sonnet, default | wraps `ClipBoxTool`                               |
| T11          | opus, default   | UI; load `impeccable` and `frontend-design` first |
| T12, T13     | sonnet, default | e2e the CI way                                    |
| T14          | haiku, low      | guide text                                        |
| Final review | opus, high      | whole branch                                      |

---

### Task 1: Region box and evidence contract (`@aio/schema`)

**Files:**

- Modify: `packages/schema/src/engineer.ts:27-35` (`EvidenceRegion`), add helpers below it; export from `packages/schema/src/index.ts` if it does not re-export `engineer.ts` wholesale.
- Modify: `packages/schema/src/modelEvidence.ts:12` (`MODEL_EVIDENCE_MIN_PACK`), `:162` area (`heightCheck` beside `height`), `:215-231` (`isolation.equipment`).
- Test: `packages/schema/src/engineer.test.ts`, `packages/schema/src/modelEvidence.test.ts` (`:199` expects `'0.11.0'` today).
- Modify: `docs/architecture/contract-changes.md` (one row at the end).

**Interfaces:**

- Produces:
  - `RegionBox = z.object({ center: Vec3, size: z.tuple([BoxSize, BoxSize, BoxSize]), yaw: z.number().min(-Math.PI - 1e-9).max(Math.PI + 1e-9) }).strict()`. `BoxSize` is 0.1..4000. It has the same field names and meaning as `ClipBoxLocal`: `size` is [east, north, up] along the box's own axes, and `center[1]` is the middle of the height range.
  - `EvidenceRegion = z.union([circle, { min, max }, RegionBox])`.
  - `type RegionBox`.
  - `regionBoxOf(r: EvidenceRegion, heights?: [number, number]): RegionBox`. A circle becomes the square of side 2r round its centre, from `heights` (default `[0, 150]`). `{min, max}` maps exactly, with yaw 0. A `RegionBox` is returned as is.
  - `regionOfBox(b: RegionBox): EvidenceRegion`. When `|yaw| < 1e-6` it returns `{ min, max }`, with `min = [cx - sx/2, cy - sz/2, cz - sy/2]` and `max = [cx + sx/2, cy + sz/2, cz + sy/2]`. Otherwise it returns `b`.
  - `regionPlanCentre(r): [number, number]` returns (x, z).
  - `regionPlanRadius(r): number`: the circle's radius, or half the plan diagonal of a box.
  - `EvidencePack.heightCheck?: { sectionsM: number | null; cloudTopM: number; basis: 'sections' | 'cloud-top' }`.
  - `EvidencePack.isolation.equipment?: { points: int; min: Vec3; max: Vec3 }[]` (max 16).
  - `MODEL_EVIDENCE_MIN_PACK = '0.14.0'`.

- [ ] **Step 1: Write the failing tests** in `engineer.test.ts`, `describe('region box')`:
  - `parses a turned box with a height range, and still the old circle and min/max`: `EvidenceRegion.parse({ center: [0, 17, 0], size: [3, 3, 36], yaw: 0.5 })` succeeds, and so do `{ centre: [1, 2], radiusM: 30 }` and `{ min: [0, 0, 0], max: [1, 1, 1] }`. `{ center: [0, 0, 0], size: [0, 1, 1], yaw: 0 }` fails, and so does `yaw: 4`.
  - `a box at the minimum size and a wrapped yaw round-trips`: `size: [0.1, 0.1, 0.1], yaw: Math.PI` parses, and `regionOfBox` returns it unchanged.
  - `regionOfBox sends a box that is not turned as min/max`: `regionOfBox({ center: [10, 5, -20], size: [4, 6, 10], yaw: 0 })` equals `{ min: [8, 0, -23], max: [12, 10, -17] }`, and `regionBoxOf` of that returns the box again.
  - `regionBoxOf reads an old circle as the square round it`: `{ centre: [2, -30], radiusM: 10 }` gives `{ center: [2, 75, -30], size: [20, 20, 150], yaw: 0 }`.
  - `regionPlanRadius`: 30 for a 30 m circle, and `Math.hypot(2, 3)` for size [4, 6, *].

  In `modelEvidence.test.ts`:
  - `takes the optional height check and equipment clusters`: a copy of the partial-stack fixture with `heightCheck: { sectionsM: 2.7, cloudTopM: 31.2, basis: 'cloud-top' }` and `isolation.equipment: [{ points: 120, min: [1, 0.2, 1], max: [2.2, 1.8, 1.8] }]` parses. `basis: 'other'` fails.
  - Change the `:199` expectation to `'0.14.0'`.

- [ ] **Step 2: Run them and see them fail.** `pnpm --filter @aio/schema exec vitest run src/engineer.test.ts src/modelEvidence.test.ts`. Expected: FAIL, because `regionOfBox` is not exported and the union rejects the box.
- [ ] **Step 3: Implement** the schema members and helpers above, in `engineer.ts` and `modelEvidence.ts`. The helpers are pure and have no three.js. Write the contract row: "`EvidenceRegion` gains a turned box `{ center, size, yaw }` (local frame, the clip box's fields); `EvidencePack` gains optional `heightCheck` and `isolation.equipment`; `MODEL_EVIDENCE_MIN_PACK` 0.14.0. Old circle and `{min, max}` regions stay valid; a box with yaw 0 is still sent as `{min, max}`." Under Why, put "Region of interest as an editable 3D box; height sanity check; cabinets from the scan". Under Streams, put "`@aio/schema`, pipeline pack, `@aio/modelling`, desktop renderer".
- [ ] **Step 4: Run them and see them pass** (same command), then `pnpm --filter @aio/schema exec tsc --noEmit`.
- [ ] **Step 5: Commit** with the message `feat(schema): a turned region box, height check and equipment in the evidence`.

### Task 2: Synthetic compound monopole scenes

**Files:** Modify `python/tests/synth_assets.py` (beside `monopole_cloud`, line 277).

**Interfaces:**

- Produces `COMPOUND_MONOPOLE = {"height": 31.0, "r": 0.6, "fenceR": 3.8, "fenceY": (0.4, 2.3), "canopyY": 2.3, "cabinets": [(45.0, 2.3), (165.0, 2.3), (285.0, 2.3)]}`. Each cabinet is (bearing in degrees, plan distance), size 1.2 x 1.6 x 0.8 (x, y, z).
- Produces `compound_monopole_cloud(seed=1, noise=0.01, attached=True, points=40_000) -> tuple[np.ndarray, dict]`. The scene is:
  - a round pole of r 0.6 from 0 to 31 m (`_ring`), about 45% of the points;
  - a fence ring of r 3.8 from 0.4 to 2.3 m, dense enough to win the RANSAC fit at those heights (about 30% of the points);
  - three canopy roofs 0.1 m thick at 2.3 m (`_box`). With `attached=True` one roof runs from the pole surface out to the fence, so isolation cannot part them (the founder's case). With `attached=False` the roofs sit over the cabinets, at least 1 m from the pole;
  - the cabinets (`_box`), with their top at 1.6 m;
  - the ground, through `_finish(..., ground=True)`.

  The truth dict is `_truth(31.0, [{"y": 0, "r": 0.6}, {"y": 31, "r": 0.6}], cabinets=[{"centre": [x, 0.8, z], "size": [1.2, 1.6, 0.8]}, ...])`. Use `toward(deg, r, y)` for the positions.

- [ ] **Step 1:** Write `test_compound_monopole_scene_has_the_pole_fence_and_cabinets` at the end of `python/tests/test_engineer_members.py`. It asserts that points within r 0.7 of the axis reach y > 30.5, that points with a plan radius in 3.7..3.9 exist only below y 2.4, and that `len(truth["cabinets"]) == 3`.
- [ ] **Step 2:** Run it. Expected: FAIL, because the import does not exist.
- [ ] **Step 3:** Implement the function.
- [ ] **Step 4:** Run `-m pytest tests/test_engineer_members.py -q -k compound`. Expected: PASS.
- [ ] **Step 5:** Commit with `test(pipelines): a monopole in a fenced compound, as a synthetic scene`.

### Task 3: Sections as runs (B)

**Files:** Modify `python/src/aio_pipelines/engineer/sections.py:80-150`. Create `python/tests/test_engineer_sections.py`.

**Interfaces:**

- Consumes `compound_monopole_cloud`, `COMPOUND_MONOPOLE` (Task 2), and `stack_cloud`, `monopole_cloud`.
- Produces: `fit_sections(xyz, axis, step, max_slices=256, seed=0, report=None) -> list[SliceFit]`, with the same signature. It now returns the slices of the shaft run only. `report` gains `"runs": [{"y0": float, "y1": float, "r": float, "slices": int, "shaft": bool}, ...]`, bottom to top. Slices of the other runs count under `rejected["radius-jump"]`. Add the constant `STEADY_SLICES = 3`.

The algorithm (bottom to top, over the fitted slices; slices that do not fit still count as `no-fit`):

```
current run C (empty), pending P (empty)
for each fitted slice s:
    if C is empty: C = [s]; continue
    ref = median(r of the last 5 in C)
    if hypot(centre offset from the axis) > 0.5 * ref: rejected off-axis; continue
    if |s.r - ref| <= RADIUS_JUMP * ref: C.append(s); rejected radius-jump += len(P); P = []; continue
    P.append(s)
    while P is not steady (any |p.r - median(P.r)| > RADIUS_JUMP * median(P.r)): drop P[0], radius-jump += 1
    if len(P) >= STEADY_SLICES: close C as a run; C = P; P = []
at the end: close C; radius-jump += len(P)
shaft = the run of at least STEADY_SLICES slices with the largest span (last y - first y),
        ties within one step to the larger total support; with no such run, the longest run
```

`_drop_seed_outliers` goes: a one-slice seed run is simply not the shaft. Do not change `fit_ring`, `fit_taper` or `RADIUS_JUMP`.

- [ ] **Step 1: Write the failing tests** in `test_engineer_sections.py`, using `estimate_axis` and `fit_sections` the way `test_engineer_cloud.py:33` does:
  - `test_a_pole_through_a_fenced_compound_is_one_run_above_it`: on `compound_monopole_cloud(attached=True)` after `remove_ground`, the kept slices all have `abs(r - 0.6) < 0.06`. The first kept slice has y ≥ 2.0 and the last ≥ 29.5. `report["runs"]` holds a run with `r > 3` and `shaft False`, and exactly one `shaft True`. `report["rejected"]["radius-jump"] >= 1`.
  - `test_a_chimney_keeps_one_run_with_flues_above`: `stack_cloud(seed=7, partial=True, noise=0.03)` gives the same taper as today. Its knots stay within 0.05 m of `radius_at(STACK["profile"], y)`, as in `test_partial_noisy_stack_taper`, and one run has `shaft True`.
  - `test_a_seed_outlier_at_the_foot_does_not_start_the_shaft`: add 300 points of a plinth ring of r = 1.6 x the base radius at y 0..0.3 to `monopole_cloud()`. The first kept slice is above 0.3 and every r is within 10% of the profile.
  - `test_three_steady_slices_start_a_new_run_two_do_not`: a synthetic cylinder of r 2 from 0 to 6 m, then r 0.5 from 6 to 7 m (two slices at step 0.5), then nothing. There is one run, r about 2, and the two narrow slices count as radius-jump. Make the narrow part 6 to 9 m and there are two runs, with the shaft at r 2.
- [ ] **Step 2:** Run `-m pytest tests/test_engineer_sections.py -q`. Expected: the compound and three-slice tests FAIL; the chimney one passes already.
- [ ] **Step 3:** Implement as above.
- [ ] **Step 4:** Run `tests/test_engineer_sections.py tests/test_engineer_cloud.py tests/test_engineer_members.py -q`. Expected: all PASS, including `test_partial_noisy_stack_taper` and `test_slices_report_height_above_base_and_centre`.
- [ ] **Step 5:** Commit with `fix(pipelines): a radius jump starts a new section run; the tallest run is the shaft`.

### Task 4: Turned region box and equipment clusters (A, F, Python)

**Files:** Modify `python/src/aio_pipelines/engineer/cloud.py:28-55` (`Region`, `_inside`, `_world_bounds`), `:282-290` (`region_centre`), `:295-385` (`isolate_asset`), and add `equipment_clusters`. Test: `python/tests/test_engineer_cloud.py`.

**Interfaces:**

- Consumes the `RegionBox` field names from Task 1 (`center`, `size` [east, north, up], `yaw`), and Task 2's scenes.
- Produces:
  - `_inside(xyz, region)` accepts the turned box. With `e = x - cx` and `n = cz - z` (north), the box axes are `east' = e*cos(yaw) + n*sin(yaw)` and `north' = -e*sin(yaw) + n*cos(yaw)` (this matches `boxAxes` in `packages/engine/src/tools/clipbox.ts:56`). A point is inside when `|east'| <= sx/2`, `|north'| <= sy/2` and `|y - cy| <= sz/2`.
  - `_world_bounds` takes the E and N hull of the four plan corners (E = ox + x, N = oy - z), and H `[oz + cy - sz/2 - offset_m, oz + cy + sz/2 - offset_m]`.
  - `region_centre` returns `(cx, cz)`.
  - `equipment_clusters(rest: np.ndarray, voxel: float = 0.25, eps: float = 0.4) -> list[dict]` returns `{"points", "min", "max"}`. It keeps clusters whose plan extents are each 0.3..4.0 m, whose height span is 0.4..3.5 m and that have at least 50 points. It returns the largest first, at most 16. It reuses `_components`.
  - `isolate_asset` adds `info["equipment"]`, computed from the dropped points (`[]` when nothing was dropped).

- [ ] **Step 1: Write the failing tests:**
  - `test_a_turned_box_keeps_what_its_axes_hold`: with region `{center: [0, 10, 0], size: [10, 2, 20], yaw: math.pi / 4}`, the point `(3, 10, -3)` is inside. With `yaw: 0` it is outside. `(0, 21, 0)` is outside both.
  - `test_world_bounds_of_a_turned_box_holds_its_corners`: parse the bounds string for yaw π/6 and check that all four corners, mapped to E and N with origin (500000, 3200000, 10), lie inside, and that the H range is `[10 + cy - sz/2 - off, ...]` with `offset_m=0.5`.
  - `test_read_region_las_crops_to_a_turned_box` mirrors `test_read_region_las_crop_and_cap` with a turned box of `compound_monopole_cloud(attached=False)` around the pole (3 x 3 m, yaw 0.5, y from 0.2 to 35). No kept point has a plan radius over 2.2.
  - `test_equipment_clusters_find_the_cabinets_and_not_the_fence`: `isolate_asset` on `remove_ground` of `compound_monopole_cloud(attached=False)`, centred on (0, 0). `info["equipment"]` holds 3 clusters, each with a plan centre within 0.3 m of a truth cabinet, and none wider than 4 m. The fence ring is not among them.
  - `test_a_turned_box_with_the_bottom_above_the_ground_counts_from_the_lowest_point`: crop with the bottom at y 1.0 (no ground in the box), then `split_ground`, `isolate_asset` and `find_base`. `base.basis == "lowest-point"` and `base.note` is set.
- [ ] **Step 2:** Run `-m pytest tests/test_engineer_cloud.py -q`. Expected: the new tests FAIL.
- [ ] **Step 3:** Implement. Keep the circle and `{min, max}` branches as they are, and update the `Region` type comment.
- [ ] **Step 4:** Run the same command. Expected: all PASS, the old crop tests included.
- [ ] **Step 5:** Commit with `feat(pipelines): crop to a turned region box; equipment clusters among the dropped parts`.

### Task 5: Pipeline: region params, height check, evidence fields, regression pack (A, C, F)

**Files:** Modify `python/src/aio_pipelines/engineer/pipeline.py:182-195` (add `_checked_height` beside `_shaft_height`), `:245-257` (validate), `:425-465` (members step), and `:684-740` (`_assemble`). Test: `python/tests/test_model_evidence.py`. Create `packages/schema/src/__fixtures__/engineering/evidence.compound-monopole.json`, and add its parse test to `packages/schema/src/modelEvidence.test.ts`. Bump `python/pyproject.toml` and `python/uv.lock` to 0.14.0.

**Interfaces:**

- Consumes Tasks 1, 3 and 4.
- Produces:
  - `validate` accepts `set(region) == {"center", "size", "yaw"}`, with `center` and `size` lists of 3 finite numbers, each size > 0, and a finite `yaw` with `|yaw| <= pi + 1e-9`. It raises `JobError("region must be { centre, radiusM }, { min, max } or { center, size, yaw } in the local frame.")`.
  - `HEIGHT_GAP_M = 3.0`, `HEIGHT_GAP_SHARE = 0.25`.
  - `_checked_height(sections_m: float | None, cloud_top_m: float) -> tuple[float, dict, str | None]`. When `sections_m` is None, or `cloud_top_m - sections_m > max(HEIGHT_GAP_M, HEIGHT_GAP_SHARE * cloud_top_m)`, it returns `(cloud_top_m, {"sectionsM": sections_m, "cloudTopM": cloud_top_m, "basis": "cloud-top"}, warning)`. The warning is: "The sections end at {s:.1f} m but the cloud reaches {t:.1f} m above the base: the height is the cloud top. Check it, or give a reference height." (when `sections_m` is None, "The sections end at" becomes "No section was fitted"). Otherwise it returns `(sections_m, {..., "basis": "sections"}, None)`. Here `cloud_top_m` is `h.max()` of the asset points along the axis.
  - The members step returns `"height"` and `"heightCheck"`, and a `"warning"` when there is one.
  - The evidence gains `doc["heightCheck"]`, `doc["isolation"]["equipment"] = iso["equipment"][:16]`, and a warning when the shaft run starts above max(2 m, 10% of the height): "The shaft sections start at {y:.1f} m: other structures surround it lower down."
  - The sections step logs the runs ("Shaft run 2.3 to 31.0 m (r 0.60 m); 1 other run left out.").

- [ ] **Step 1: Write the failing tests** in `test_model_evidence.py`, using `make_project`, `run_job`, `params` and `read_pack` as `stack_run` does:
  - `test_height_check_takes_the_cloud_top_when_the_sections_stop_short`: a unit test. `_checked_height(2.74, 31.3)` returns height 31.3, basis `cloud-top` and a warning. `_checked_height(30.0, 31.75)` returns basis `sections`. `_checked_height(None, 12.0)` returns `cloud-top`.
  - `test_a_monopole_in_a_touching_compound_measures_the_pole` is the regression. It uses `compound_monopole_cloud(attached=True)`, no region and no photos. Assert:
    - `abs(pack["height"] - 31.0) < 0.5`;
    - every taper r is within 0.06 of 0.6;
    - `pack["taper"]["profile"][0]["y"] - pack["base"][1] >= 2.0`;
    - `pack["rejectedSlices"]["radiusJump"] >= 1`;
    - `pack["heightCheck"]["basis"] == "sections"`;
    - a warning starts "The shaft sections start at".

    With `AIO_UPDATE_FIXTURES=1`, write the pack to `evidence.compound-monopole.json` through `_compare_with_fixture(pack, fixture=...)`.

  - `test_a_turned_box_region_leaves_the_compound_out`: `compound_monopole_cloud(attached=False)` with region `{center: [0, 17.5, 0], size: [3, 3, 36], yaw: 0.5}`. `pack["crop"]` equals the region, `abs(height - 31) < 0.5`, `pack["isolation"]["droppedPoints"] < 200`, and no warning says "No region".
  - `test_equipment_clusters_reach_the_pack`: the same scene with region `{min: [-6, -1, -6], max: [6, 35, 6]}`. `pack["isolation"]["equipment"]` has 3 entries, each centre within 0.3 m of a truth cabinet.
  - Extend `test_validate_refuses_bad_params` (line 408): the turned box is accepted, and `size: [0, 1, 1]`, `yaw: "a"` and a missing `yaw` are refused.
  - In `modelEvidence.test.ts`: `parses the pack the pipeline wrote for the monopole in a compound` (`EvidencePack.parse` of the new fixture).
- [ ] **Step 2:** Run `-m pytest tests/test_model_evidence.py -q -k "height_check or compound or turned_box or equipment or validate"`. Expected: FAIL.
- [ ] **Step 3:** Implement as above. Bump the pack version.
- [ ] **Step 4:** Regenerate both fixtures: `$env:AIO_UPDATE_FIXTURES='1'` and run `-k "partial_noisy or touching_compound"`, then clear the variable. Run all of `tests/test_model_evidence.py tests/test_engineer_*.py -q`, then `pnpm --filter @aio/schema exec vitest run src/modelEvidence.test.ts`. Expected: all PASS. Review the partial-stack fixture diff: only `heightCheck`, `isolation.equipment` and the run log may change.
- [ ] **Step 5:** Commit with `fix(pipelines): check the measured height against the cloud top; turned region boxes; equipment in the pack`.

### Task 6: Lights need confirmation below half the height (D)

**Files:** Modify `packages/modelling/src/engineer/assemble/shared.ts:373-410` (`lights`). Create `packages/modelling/src/engineer/assemble/shared.test.ts`.

**Interfaces:**

- Produces `export const LIGHT_MIN_SHARE = 0.5`. In `lights()` the measured levels (from `light-candidate` clusters) with `h < LIGHT_MIN_SHARE * H` are kept only when `confirmed`, which is `ctx.proposals('warningLight').some((c) => c.observed && c.count > 0)`. When some are dropped, `ctx.note(...)` says: "Left out {n} light candidate level(s) below half the height ({list} m): the AI did not confirm a light." The person's levels (`userLevels('light')`) are untouched.

- [ ] **Step 1: Write the failing tests.** Use `assembleStack`, `base` and `noUser` from `testAssemble.ts`, a monopole family input, and evidence with a `light-candidate` group:
  - `canopy roofs low on the pole are not lights when the AI saw none`: 7 candidates at 2.3 m on a 31 m pole, and a proposal `warningLight` with count 0 and `observed: false`. The result has no `warningLight` assembly, and `unresolved` holds "below half the height".
  - `a light the AI confirms stays, even low`: the same candidates, with the proposal at count 2 and `observed: true`. There is a warningLight at about 2.3 m.
  - `a candidate high on the asset stays without confirmation`: candidates at 29 m are kept.
  - `the person's light levels always stay`: `user.levels.light = [2.3]`, with no confirmation, gives a light at 2.3 m.
- [ ] **Step 2:** Run `pnpm --filter @aio/modelling exec vitest run src/engineer/assemble/shared.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run that file plus `telecom.test.ts chimney.test.ts flare.test.ts`. Expected: PASS. The chimney lights in the existing tests are above half the height or confirmed; if one is not, fix the fixture's `observed`, not the rule.
- [ ] **Step 5:** Commit with `fix(modelling): a low light candidate needs the AI's confirmation`.

### Task 7: Height precedence and "asset only" for every family (C, E)

**Files:** Modify `packages/modelling/src/engineer/assemble/assemble.ts:155-205` (`resolveScale`) and `:468-490` (`assemble`). Create `packages/modelling/src/engineer/assemble/scale.test.ts`.

**Interfaces:**

- Consumes `EvidencePack.heightCheck` (Task 1).
- Produces `resolveScale`, with this order:
  1. **The person's reference height wins** (`setup.reference.what === 'height'`). It returns `{ height: ref.valueM, scale: { status: 'reference', reference: ref }, metric: evidence !== null }`. When a measured height exists and differs by more than 5%, it notes "The reference height ({r} m) is used; the measured height was {m} m."
  2. **Otherwise the measured height `m`.** Let `ai` be the metric height of the first proposal component of kind `shaft`, `monopole` or `lattice` with `units === 'm'`, and `top = ev.heightCheck?.cloudTopM`.
     - When `heightCheck.basis === 'cloud-top'`, it notes the Python warning in short.
     - When `ai` exists and `|ai - m| > max(3, 0.25 * max(ai, m))`: if `ai > m` and (`top` is undefined or `ai <= top + max(1, 0.05 * top)`), the height is `ai`. The note says "The measured height ({m} m) is far below the AI's ({ai} m): {ai} m is used. Give a reference height to be sure." Otherwise it notes that the measured height is used.
     - It returns `{ height, scale: { status: 'measured' }, metric: true }`.
  3. Steps 3 and later are unchanged (diameter reference, AI provisional, assumed).
- Produces `const SURROUNDING_ROLES = ['cabinet']`. In `assemble()`, when `input.scope === 'asset'`, these roles join `removed` (the set passed to `withoutRemoved` and `mergeModels({ removedRoles })`), so cabinets the person accepted earlier stay, flagged, through the existing path. When generated cabinets were left out, it notes: "The asset only: {n} cabinet(s) the AI saw are left out."
- The chimney duct reach (`chimney.ts:622-634`) is Task 8's. Do not edit `chimney.ts` here.

- [ ] **Step 1: Write the failing tests** in `scale.test.ts`:
  - `the person's known height wins over the measurement and stays metric`: evidence with height 2.74, and a reference height of 31. The model's scale is `reference`, the pole profile's last y is 31, and the profile's quality is still `measured`.
  - `an evidence height far below the AI's metric height takes the AI's, noted`: this is the founder's run. Evidence height 2.74, no `heightCheck`, an AI monopole height of 31.3 m. The height is 31.3 and a note says "far below".
  - `an AI height above the cloud top is not plausible`: evidence height 20, `heightCheck.cloudTopM` 21, AI 40. The height is 20.
  - `a small difference keeps the measurement`: evidence 30, AI 31.3. The height is 30.
  - `asset only leaves out cabinets in every family`: run the telecom-monopole, telecom-lattice, chimney and flare families with a proposal holding `cabinet` count 2, in scope `asset`. No assembly has kind `cabinet` and a note says "The asset only". In `asset-and-surroundings` the cabinets are there.
  - `asset only on a rerun keeps accepted cabinets flagged and adds none`: the previous model has an accepted cabinet, and the scope is now `asset`. That cabinet is kept and flagged, and no other cabinet appears.
- [ ] **Step 2:** Run `pnpm --filter @aio/modelling exec vitest run src/engineer/assemble/scale.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm --filter @aio/modelling exec vitest run src/engineer`. Expected: PASS. If an existing test asserted "the measured one is used" over a reference, update it to the new rule: this is the intended change.
- [ ] **Step 5:** Commit with `fix(modelling): a known height wins, an implausibly short measurement gives way, asset only leaves out cabinets`.

### Task 8: Cabinets from the scan (F)

**Files:**

- Create `packages/modelling/src/engineer/assemble/equipment.ts` and `equipment.test.ts`.
- Modify `packages/modelling/src/engineer/assemble/telecom.ts:733-756` (the cabinet block of `towerExtras`) and `chimney.ts:786-810` (its cabinet block) and `:622-634` (the duct reach through `regionPlanRadius`).
- Tests: `telecom.test.ts`, `chimney.test.ts`.

**Interfaces:**

- Consumes `EvidencePack.isolation.equipment` and `regionPlanRadius` (Task 1).
- Produces:
  - `export interface EquipmentPlacement { base: Vec3; size: [number, number, number]; yawDeg: number; points: number }`.
  - `export const MAX_EQUIPMENT_REACH_M = 40`.
  - `export function equipmentPlacements(ctx: FamilyCtx, n: number): EquipmentPlacement[]`. It returns up to `n` placements, only when `ctx.metric`, from the clusters within `MAX_EQUIPMENT_REACH_M` of `ctx.base` in plan, nearest first. The base is `[centreX, ctx.base[1], centreZ]`. The size is `[clamp(dx, 0.3, 4), clamp(dy, 0.4, 3.5), clamp(dz, 0.3, 4)]`, in the axis order of the cabinet params, `size: [x, height, z]` at `yawDeg` 0. Confirm that order in the cabinet builder before you map it. The yaw is 0.
  - Each cabinet block takes `equipmentPlacements(ctx, n)` first, with quality `base` and `size` from `{ basis: 'measured', ...measuredBy(p.points) }` and `yawDeg` inferred. The remaining `n - placed` cabinets keep today's even layout and inferred quality. The count `n` is unchanged (person, else AI), so clusters alone never make a cabinet.

- [ ] **Step 1: Write the failing tests:**
  - In `equipment.test.ts`, `places cabinets on the clusters nearest the base, sized by them`: three clusters, one of them 50 m away. With `n = 2` you get the two near ones, nearest first, each size clamped. Non-metric evidence gives `[]`.
  - In `telecom.test.ts`, under `describe('telecom monopole family')`, `cabinets sit on the scanned equipment, not on an even ring`: a monopole with evidence clusters at bearings 45, 165 and 285 degrees and 2.3 m, a proposal cabinet count of 3, and the scope `asset-and-surroundings`. Each cabinet's base is within 0.05 m of a cluster centre (x, z), and its `quality.base.basis` is `'measured'`.
  - `more cabinets than clusters fill the rest by the old layout, inferred`: count 4 against 3 clusters gives 3 measured and 1 inferred.
  - In `chimney.test.ts`, the same cluster-placement case for the chimney's cabinets, and `the duct reach follows a box region`: scope `asset-and-surroundings` with a 60 x 60 m box region, and the duct path starts at about `regionPlanRadius`.
- [ ] **Step 2:** Run `pnpm --filter @aio/modelling exec vitest run src/engineer/assemble/equipment.test.ts src/engineer/assemble/telecom.test.ts src/engineer/assemble/chimney.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command, then `pnpm --filter @aio/modelling exec vitest run src/engineer`. Expected: PASS.
- [ ] **Step 5:** Commit with `feat(modelling): cabinets take their place and size from the scanned equipment`.

### Task 9: Acceptance scenario I: the monopole in a compound, end to end in `@aio/modelling`

**Files:** Modify `packages/modelling/src/engineer/acceptance.test.ts` (beside the `partial` fixture at line 26) and, if a proposal helper is needed, `packages/modelling/src/engineer/fixtures.ts`.

**Interfaces:**

- Consumes `evidence.compound-monopole.json` (Task 5), and Tasks 6 to 8.
- Produces `compoundMonopoleProposal(): EngineerProposal` in `fixtures.ts`. The family is `telecom-monopole`, with a `monopole` component in `units: 'm'` (`height` 31.3, `rBase` 0.6, `rTop` 0.6), `warningLight` with count 0 and `observed: false`, and `cabinet` with count 3 and `observed: true`.

- [ ] **Step 1: Write the failing tests** in `describe('I: a telecom monopole in a fenced compound, the asset only')`:
  - `the pole is about 31 m tall, measured`: the profile's last y is within 1 m of 31, and the scale is `measured`.
  - `no warning light comes from the canopy roofs`: there is no `warningLight` assembly.
  - `no cabinet in asset only`: there is no `cabinet` assembly.
  - `the model passes the validator`, the same way as test G.
- [ ] **Step 2:** Run `pnpm --filter @aio/modelling exec vitest run src/engineer/acceptance.test.ts`. Expected: these FAIL only if an earlier task is missing. If they all pass straight away, check the fixture holds the low light candidates (the regression must exercise them). If it does not, add them in `fixtures.ts` as an evidence override, and say so in the test.
- [ ] **Step 3:** Fix what fails, in the task that owns the code.
- [ ] **Step 4:** Run `pnpm --filter @aio/modelling exec vitest run`. Expected: PASS.
- [ ] **Step 5:** Commit with `test(modelling): a telecom monopole in a compound comes out at its height, with no lights or cabinets`.

### Task 10: Region box editor glue (A, renderer)

**Files:** Create `apps/desktop/src/renderer/engineer/regionBox.ts` and `regionBox.test.ts`.

**Interfaces:**

- Consumes `ClipBoxTool`, `ClipBoxLocal`, `BoxHandle` and `layerBox` from `@aio/engine` (`packages/engine/src/index.ts:71-96`), the stage type the cleanup glue uses (`EngineStage`, as in `pointcloud/cleanupScene.ts:121`), and `RegionBox` from `@aio/schema`.
- Produces:
  - `mountRegionBoxEditor(stage: EngineStage, box: RegionBox, onChange: (box: RegionBox, done: boolean) => void): { setBox(b: RegionBox): void; detach(): void }`. It is `new ClipBoxTool(stage, { box, onChange })`, plus `attach()`. While it is mounted it registers itself in `regionDebug`.
  - `regionDebug = { handleScreen(h: BoxHandle): [number, number] | null; box(): RegionBox | null }`.
  - `boxAround(p: Vec3, heights?: [number, number]): RegionBox` gives a 40 x 40 m box centred on the pick, from `heights` (default `[p[1] - 10, p[1] + 150]`), with yaw 0.
  - `boxOfBounds(b: Box3): RegionBox` gives size `[dx, dz, dy]` × 1.01, rounded to the millimetre, at least 0.1, with yaw 0.
  - `fitRegionBox(stage: EngineStage, layerIds: readonly string[]): RegionBox | null`. It fits the selected node first (`stage.selected` and `Box3.setFromObject`, as in `Stage.ts:1396-1410`), else the union of `layerBox(scene, id)` over `layerIds`, else `null`.
  - `cloudHeights(stage, layerIds): [number, number] | null` gives the y range of those layers' boxes, plus or minus 1 m, for `boxAround`.

- [ ] **Step 1: Write the failing tests:**
  - `boxOfBounds maps a three box to east, north and up sizes`: `Box3([0, 0, -10], [4, 30, -4])` gives center `[2, 15, -7]`, size `[4.04, 6.06, 30.3]`, yaw 0.
  - `boxAround centres a 40 m box on the pick`.
  - `fitRegionBox prefers the selection, else the chosen layers, else null`: use a mocked stage with `selected`, `scene`, and the `layerBox` mocks of `CleanupPanel.test.tsx:310`.
  - `the editor reports drags and registers its handles for e2e`: mock `ClipBoxTool`. `onChange` passes through, `regionDebug.handleScreen` delegates while mounted and returns `null` after `detach`.
  - `the clip box axes match the region convention`: `boxAxes(Math.PI / 4)` (engine) applied to the Task 4 vector, the point (3, 10, -3) against the box `{center: [0, 10, 0], size: [10, 2, 20]}`, gives inside. This pins the renderer and Python to the same yaw sense.
- [ ] **Step 2:** Run `pnpm --filter @aio/desktop exec vitest run src/renderer/engineer/regionBox.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit with `feat(desktop): the region box editor, reusing the clip box tool`.

### Task 11: Setup dialog: the region as a box (A, UI)

Load the `impeccable` and `frontend-design` skills first. Keep the dialog's current look: the box block replaces the circle block in the same `fieldset`.

**Files:**

- Modify `apps/desktop/src/renderer/engineer/SetupDialog.tsx`. Remove `Region`, `BoxSize`, `regionOf` (`:15-40`), `shape` and `box` (`:108-114`), and the circle UI (`:323-395`).
- Modify `apps/desktop/src/renderer/engineer/EngineerLayer.tsx`: the `Picking` union (`:20`), `ScenePick` (`:41-80`), and the props wired at `:379-383`.
- Modify `apps/desktop/src/renderer/bootstrap.ts:131-151`: add `__stratlas.engineer = { regionHandle: (h) => regionDebug.handleScreen(h), regionBox: () => regionDebug.box() }`.
- Modify `packages/ui/src/i18n/en.ts` (the `eng.setup.region*` keys at `:3646` and after).
- Tests: `SetupDialog.test.tsx`, `EngineerLayer.test.tsx`.

**Interfaces:**

- Consumes Task 10 and `regionBoxOf` / `regionOfBox` (Task 1).
- Produces these `SetupDialog` props:
  - `onPickRegion(): Promise<RegionBox | null>`: the layer builds `boxAround(hit, cloudHeights(...))`;
  - `onEditRegion(box: RegionBox): Promise<RegionBox | null>`, which resolves on Done and gives `null` on Cancel or Escape;
  - `onFitRegion(): RegionBox | null`.
- Produces this state: `region: RegionBox | null`, initialised from `regionBoxOf(previous.setup.region)` when a run's setup is reopened. `setup()` writes `region: regionOfBox(region)`.
- Produces these test ids:
  - `eng-region-pick`, `eng-region-edit` (Edit in 3D), `eng-region-fit` (Fit to selection, disabled when `onFitRegion()` would return null), `eng-region-clear`;
  - the readout `eng-region` ("Box 12.0 × 8.5 m, 0.0 to 35.0 m high, turned 30°");
  - the number fields `eng-box-width`, `eng-box-depth`, `eng-box-bottom`, `eng-box-top` and `eng-box-turn` (degrees);
  - on the stage while editing, the bar `eng-box-bar` with `eng-box-done` and `eng-box-cancel`. Escape cancels and Enter is Done, as `ScenePick` handles Escape.
- Produces `Picking` with `| { kind: 'box'; box: RegionBox; done: (b: RegionBox | null) => void }`. A `SceneBoxEdit` component mounts `mountRegionBoxEditor` while `picking.kind === 'box'` and detaches on Done or Cancel. The dialog stays hidden meanwhile (`hidden={picking}`).
- Strings (no dashes): `eng.setup.regionPick` "Pick on the scene", `eng.setup.regionEdit` "Edit in 3D", `eng.setup.regionFit` "Fit to selection", `eng.setup.regionTurn` "Turn", `eng.setup.regionBoxAt` "Box {w} × {d} m, {b} to {t} m high, turned {y}°", `eng.box.bar` "Drag a face to resize it in 10 cm steps, or the ring to turn the box.", `eng.box.done` "Done", `eng.box.cancel` "Cancel". Delete the keys the circle used, if nothing else uses them.

- [ ] **Step 1: Write the failing tests** in `SetupDialog.test.tsx`, replacing `sets a region by its centre and radius, and clears it` (`:107`) and `offers a box around the picked centre instead of a circle` (`:117`):
  - `a pick gives a box round the point, and clearing removes it`.
  - `the box fields set width, depth, bottom, top and turn`: with a mocked pick box, set turn 30, and `setup().region` is `{ center, size, yaw: π/6 }`. With turn 0 it is `{ min, max }`.
  - `Edit in 3D hands the box over and takes back the edited one; cancel keeps the old one`.
  - `Fit to selection is offered only when there is something to fit`.
  - `reopens an old circle region as a box`: a previous setup with `{ centre: [2, -30], radiusM: 10 }` shows a 20 × 20 m box.
  - Keep `starts with a schema-valid setup: sources, region, scope, detail, reference, anchor` (`:166`) green.

  In `EngineerLayer.test.tsx`: `while the box is edited the dialog hides, the bar shows, Escape cancels and Done returns the box`. Mock `mountRegionBoxEditor`.

- [ ] **Step 2:** Run `pnpm --filter @aio/desktop exec vitest run src/renderer/engineer`. Expected: the new tests FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command, then `pnpm --filter @aio/ui exec vitest run` (the i18n tests) and `pnpm --filter @aio/desktop exec tsc --noEmit`. Expected: PASS.
- [ ] **Step 5:** Commit with `feat(desktop): the engineering region is a box you drag and turn in 3D`.

### Task 12: e2e: the region box editor and the flow

**Files:** Create `apps/desktop/e2e/engineering-region-box.spec.ts`. Modify `apps/desktop/e2e/engineering-flow.spec.ts` (case B, about line 306).

**Interfaces:** Consumes the Task 11 test ids and `window.__stratlas.engineer.regionHandle / regionBox`. Copy `setView` and the mouse drag pattern from `apps/desktop/e2e/cleanupHelpers.ts:73` and `pointcloud-clipbox.spec.ts`, and the project setup and `ENV` from `engineering-flow.spec.ts:29`.

- [ ] **Step 1: Write `engineering-region-box.spec.ts`.**
  - `@engineering region box: pick, drag a face, turn, done`:
    1. Open the setup and pick on the scene.
    2. Click `eng-region-edit`. `eng-setup` is hidden and `eng-box-bar` is visible.
    3. Set a top-down view (`setView(win, [0, 90, 0], [0, 0, -0.01])`) and read `regionHandle('east')` and `regionHandle('west')`.
    4. Drag east 8 steps. `regionBox().size[0]` grows and is a multiple of 0.1 (`Math.abs(v * 10 - Math.round(v * 10)) < 1e-6`).
    5. Drag `regionHandle('ring')` a quarter turn. `regionBox().yaw` is not 0.
    6. Click `eng-box-done`. The dialog shows again and `eng-region` contains "turned".
  - `@engineering region box: Escape cancels and keeps the old box`.
  - `@engineering region box: fit to selection`: select the scan layer in the sidebar, click `eng-region-fit`, and `eng-region` shows a box.
  - `@engineering region box: the bar does not cover the view`. In a 1100 × 700 window (`test.use({ appEnv: { QUADRION_WINDOW_SIZE: '1100x700' } })` in a `describe`), `document.elementFromPoint` at the canvas centre is the canvas.

  Change case B of `engineering-flow.spec.ts`. It picks, sets `eng-box-turn` to 30, and starts. `run.json` `setup.region` matches `{ yaw: closeTo(π/6), size: [40, 40, ...] }`, and `evidence.json` `crop` equals it. Drop the `region:{radiusM:30}` expectation.

- [ ] **Step 2:** Run both specs the CI way, from `apps/desktop`: `pnpm demo:build --quick` (and `pnpm demo:change --quick`), then `$env:QUADRION_WINDOW_SIZE='1100x720'; $env:QUADRION_E2E_SCALE='1'; $env:QUADRION_E2E_SWGL='warp'; $env:QUADRION_E2E_PYTHON='E:\Dev\AIO Software\python\.venv\Scripts\python.exe'; npx playwright test e2e/engineering-region-box.spec.ts e2e/engineering-flow.spec.ts --workers=1`. Expected: PASS, and the log prints `[e2e] window 1100 x 720 px at display scale 1`. Use `--repeat-each=3` once on the box spec.
- [ ] **Step 3:** Commit with `test(desktop): e2e for the engineering region box editor`.

### Task 13: e2e: a monopole in a compound through the whole flow

**Files:** Create `apps/desktop/e2e/engineering-compound.spec.ts`. Modify `apps/desktop/e2e/engineering-fixture.py`: add a `--scene compound-monopole` option that writes `compound_monopole_cloud(attached=True)` as `clouds/scan.las`, with no photo. Modify `packages/ai/src/scripted.ts`: add a scripted engineer reply `compound-monopole` beside `monopole` (`:260`), equal to `compoundMonopoleProposal` from Task 9, picked by `#engineer compound-monopole` the way the existing replies are picked (`:237-240`).

**Interfaces:** Consumes Tasks 5, 7, 8 and 11, and the flow spec's helpers.

- [ ] **Step 1: Write the spec.** `@engineering a monopole in a fenced compound: about 31 m, no lights, no cabinets in asset only`. It runs the setup with the scan, no region, "Decide from the evidence", "The asset only" and the scripted reply. After the run:
  - the review's pole height reads 30 to 32 m;
  - the component list has no "Warning light" and no "Cabinet";
  - the run's warnings include "The shaft sections start at".

  Then rerun with `eng-scope-asset-and-surroundings`: cabinets appear.

- [ ] **Step 2:** Run it the CI way (the Task 12 command, with this spec). Expected: PASS. The job needs PDAL, as the flow spec does; skip in the same way when PDAL is missing.
- [ ] **Step 3:** Commit with `test(desktop): e2e regression for a monopole in a fenced compound`.

### Task 14: Guide

**Files:** Modify `docs/guide/44-engineering-models.md`: step 3 at `:11`, step 5 at `:13`, and `## Known limitations` at `:76`.

- [ ] **Step 1:** Rewrite step 3. Cover **Pick on the scene** (a box round the point), **Edit in 3D** (drag a face in 10 cm steps, drag the ring to turn, **Done** or Escape), **Fit to selection**, and the Width, Depth, Bottom, Top and Turn fields. Point to the "Clip box" section of `docs/guide/03-scene.md` for the handles.
- [ ] **Step 2:** Rewrite step 5:
  - **The asset only** leaves out cabinets and the compound for every family;
  - **The asset and the equipment around it** places as many cabinets as the AI or the person counts, on what the scan shows.

  Add a short "How the height is found" paragraph: a reference height always wins; the sections, checked against the cloud top; the AI's height when the measurement is implausibly short. Add a line on lights: below half the height only when the AI confirms them.

- [ ] **Step 3:** Under Known limitations, add the stepped shaft (only the taller part is fitted) and the cabinets from the scan (square to north, on the base height).
- [ ] **Step 4:** Run `pnpm format:check` and `node tools/agent/check-public-text.mjs docs/guide/44-engineering-models.md`. Expected: clean.
- [ ] **Step 5:** Commit with `docs(guide): the engineering region box, the height check and asset only`.

## Finish

- `pnpm check` green; the Python suite the CI way (all of `python/tests`); every e2e spec above the CI way.
- `node tools/agent/finish-task.mjs` and the merge steps in `CLAUDE.md` (merge lock, draft PR, `watch-ci.mjs`, ff-only).
- How to test (for the founder), with pack 0.14.0 installed:
  1. Open the telecom monopole test project and select the scan.
  2. Choose **Create engineering model**. In **Region of interest**, click **Pick on the scene** and click the pole.
  3. Click **Edit in 3D**. Drag a side face toward the pole (the size changes in 10 cm steps), drag the ring to turn the box square to the fence, then click **Done**. The readout shows the box and the turn.
  4. Leave **Decide from the evidence** and **The asset only**, then run. The pole should be about 31 m, with no warning lights at the canopy height and no cabinets.
  5. Run again with **The asset and the equipment around it**. The cabinets should stand where the scan shows them, not on an even ring.
  6. Clear the region and run again. The height should still be about 31 m. The run should warn that the shaft sections start above the compound.

## Risks

- **Stepped shafts.** A taller narrow upper part wins over a wide base (decision 4). A chimney with a windshield could lose its lower part. The run warns, and the guide lists it.
- **Clustering needs a gap.** Equipment clusters need about 0.4 m of air between a cabinet and the fence or a canopy. Packed compounds merge into one cluster, which the size filter drops, and those cabinets fall back to the even layout, inferred.
- **The axis.** It is still estimated from all the kept points. A compound that pulls the axis can trip the off-axis test. A region box fixes that, and no region relies on the upper points dominating the PCA.
- **Pack gating.** With `MODEL_EVIDENCE_MIN_PACK` at 0.14.0, measuring needs the new pack. Until the founder builds it, installed apps will ask to update their processing tools.
- **The family hint.** It may still say "chimney" for a pole in a compound. Measuring only the pole slices should fix it, but no test pins it.
