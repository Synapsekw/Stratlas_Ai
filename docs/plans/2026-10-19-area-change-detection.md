# Area-scoped change detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Right-click a polygon measurement, choose **Compare with previous survey**, and get imagery change (and, opt-in, volume change) computed and shown only inside that polygon, as its own entry in the Changes tab.

**Architecture:** No new pipeline. `change.raster` and `change.surface` gain an optional `scope: { id, name }` that suffixes the change set id, the output folder and the layer ids, and names the layers; `change.surface` also gains `mask` (it clips the DoD, so regions, heat map and site totals stay inside). The change set file carries `scope`, the Changes store filters sets by area, and the panel gets an area picker (Whole map plus one entry per area). The desktop app registers one action on the shared registry, opens a small confirm box, starts the jobs through the existing producer path and hands off to the Changes tab.

**Tech Stack:** TypeScript (zod 4, React, zustand, vitest), Python 3 (numpy, shapely, rasterio, pytest), Playwright with Electron.

**Spec:** `docs/plans/2026-10-19-area-change-detection-design.md`

## Global Constraints

- Worktree `E:\Dev\AIO Software\.claude\worktrees\area-change-detection`, branch `feat/area-change-detection`. Never edit the main checkout, never `git add -A`, never `git stash`. Stage by path.
- Conventional commits; every message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- No client, site, tester or person names anywhere (code, tests, fixtures, docs, commit messages). Synthetic names only (`Pad A`, `Area A`, `West bay`).
- "Previous" means the survey just before the current one in timeline order (`stepCapture(index, current, -1)`). No date picker.
- Volumes are opt-in: checkbox "Include volumes (cut and fill)", off by default, last choice remembered per computer.
- The action applies to exactly one polygon. Lines, points, several selected items: not offered.
- A polygon with fewer than 3 distinct points, zero area or a self-intersection disables the action with a reason. Never a whole-map run: a job with `scope` and no `mask` is refused by both the schema and Python.
- Scoped results never overwrite the whole-map set of the same pair: set id `<from>-<to>-<producer>-area-<scope id>` (hashed suffix when longer than 120 characters).
- Partial outcome (founder, plan review): when volumes were asked for and the area's `change.surface` run was refused or failed (no elevation, misaligned, error), the area entry shows a lasting note saying why, next to the imagery result (`ChangeSet.volumesMissing`, Tasks 1, 5, 7).
- Rerunning on the same polygon replaces that area's set and keeps its reviews (`merge_reviews`, as today).
- No masks for `change.cloud`, `change.mesh`, `change.frames`. No ignore polygons in the UI. No thresholds UI.
- Python tests in a worktree: there is no `python/.venv` here. Run from `python/` with the main venv and this worktree's source first on the path, and check the import path once:
  `$env:PYTHONPATH = "$PWD\src"; & "E:\Dev\AIO Software\python\.venv\Scripts\python.exe" -c "import aio_pipelines; print(aio_pipelines.__file__)"` must print a path under `.claude\worktrees\area-change-detection`. Never run `uv sync` or junction the venv. Run `ruff format` on changed Python files yourself.
- TS unit tests from the worktree root: `pnpm exec vitest run <path>`.
- E2E only with `--workers=1`, the CI way (CONTRIBUTING.md "End to end the way CI runs it"), off-screen.

## Review Focus

1. **A site-scoped polygon while dates are off** (`timeline.focus` null): a person expects the latest survey compared with the one before, not "No earlier survey" and not the oldest pair. Test in Task 6 (`previousPair` with focus null).
2. **A polygon whose label is longer than 120 characters or holds characters a file name cannot:** the scope `name` is cut to 120, the id is the measurement id (already file-safe). Test in Task 6 (`areaScope` truncates).
3. **A long capture id plus a long measurement id** pushes the set id past 120 characters; truncation must not make two areas share one set. Test in Task 2 (hashed suffix, two long scope ids give two ids).
4. **Compare dates showing another pair when the hand-off happens:** the panel's `defaultPair` effect must not throw the area entry away silently. Test in Task 5 (setting `area` for a pair, then `setPair` to another pair resets `area` to null; same pair keeps it).
5. **Stale or refused scoped run, then Run again / Line up dates:** the rerun must replay the scoped params, never fall back to a whole-map run. Test in Task 8 (`rerunScoped` uses `set.run.params`; misaligned with `params` replays them).

---

## File Structure

| File                                                                                                                                                                                             | Responsibility                                                                                      | Task |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | ---- |
| `packages/schema/src/change.ts`                                                                                                                                                                  | `ChangeScope`; `ChangeSet.scope`; `ChangeSetSummary.scope`                                          | 1    |
| `packages/schema/src/jobs.ts`                                                                                                                                                                    | `scope` on `ChangeRasterParams`, `mask` + `scope` on `ChangeSurfaceParams`, scope-needs-mask refine | 1    |
| `docs/architecture/contract-changes.md`                                                                                                                                                          | the contract row                                                                                    | 1    |
| `packages/ui/src/i18n/en.ts`                                                                                                                                                                     | every new message key of this plan                                                                  | 0    |
| `python/src/aio_pipelines/change/changeset.py`                                                                                                                                                   | `change_set_id(..., scope_id)`, `change_set(..., scope=)`, `check_scope`                            | 2    |
| `python/src/aio_pipelines/change/raster.py`                                                                                                                                                      | `scope` key, ids, folder, layer names                                                               | 3    |
| `python/src/aio_pipelines/change/surface.py`                                                                                                                                                     | `mask` + `scope` keys, DoD clipped to the mask                                                      | 4    |
| `packages/change/src/register.ts`, `store.ts`, `ChangePanel.tsx`                                                                                                                                 | summary scope, `area` filter, area picker, rerun with set, misaligned params                        | 5    |
| `apps/desktop/src/renderer/change/area/areaModel.ts` (new)                                                                                                                                       | polygon to lon/lat ring, validity, previous pair, scope                                             | 6    |
| `apps/desktop/src/renderer/change/producers/raster.ts`, `register.ts`, `change/area/run.ts` (new)                                                                                                | scoped params, job start, hand-off                                                                  | 7    |
| `apps/desktop/src/renderer/change/rerun.ts`, `ChangesTab.tsx`, `useChangeOverlays.ts`                                                                                                            | scoped reruns, overlays follow the area                                                             | 8    |
| `apps/desktop/src/renderer/change/area/AreaCompareDialog.tsx`, `areaCompareStore.ts` (new), `shell/actions/areaActions.tsx` (new), `shell/actions/index.ts`, `App.tsx`, `survey/MeasureMenu.tsx` | confirm box, registered action, mounting                                                            | 9    |
| `apps/desktop/e2e/change-area.spec.ts` (new)                                                                                                                                                     | the founder's flow on the change demo                                                               | 10   |

## Execution DAG

```
Batch 1 (parallel): T0 i18n | T1 schema + contract | T2 py changeset
Batch 2 (parallel): T3 py raster (T2) | T4 py surface (T2) | T5 @aio/change (T0,T1) | T6 area model (T0,T1)
Batch 3 (parallel): T7 producers + run (T1,T5,T6) | T8 reruns + tab (T5)
Batch 4:            T9 confirm box + action (T0,T6,T7)
Batch 5:            T10 e2e change-area.spec.ts (all)
```

| Task                           | Depends on | Packages / files touched (no overlap inside a batch)                                                                                                                                |
| ------------------------------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T0 i18n keys                   | none       | `@aio/ui` (`en.ts` only)                                                                                                                                                            |
| T1 schema + contract row       | none       | `@aio/schema` (`change.ts`, `jobs.ts`, tests), `docs/architecture/contract-changes.md`                                                                                              |
| T2 Python change set ids       | none       | `python` (`changeset.py`, `test_changeset.py`)                                                                                                                                      |
| T3 Python raster scope         | T2         | `python` (`raster.py`, `test_change_raster.py`)                                                                                                                                     |
| T4 Python surface mask + scope | T2         | `python` (`surface.py`, `test_change_surface.py`)                                                                                                                                   |
| T5 Changes store and panel     | T0, T1     | `@aio/change`                                                                                                                                                                       |
| T6 area model                  | T0, T1     | `@aio/desktop` (`change/area/areaModel.ts` + test)                                                                                                                                  |
| T7 scoped producers + run      | T1, T5, T6 | `@aio/desktop` (`producers/raster.ts`, `producers/register.ts`, `change/area/run.ts` + tests)                                                                                       |
| T8 scoped reruns + tab         | T5         | `@aio/desktop` (`change/rerun.ts`, `ChangesTab.tsx`, `useChangeOverlays.ts` + tests)                                                                                                |
| T9 confirm box + action        | T0, T6, T7 | `@aio/desktop` (`change/area/AreaCompareDialog.tsx`, `areaCompareStore.ts`, `shell/actions/areaActions.tsx`, `shell/actions/index.ts`, `App.tsx`, `survey/MeasureMenu.tsx` + tests) |
| T10 e2e                        | all        | `@aio/desktop` (`e2e/change-area.spec.ts`)                                                                                                                                          |

- Batch 1: T0, T1, T2 (dispatch in one message).
- Batch 2: T3, T4, T5, T6.
- Batch 3: T7, T8.
- Batch 4: T9.
- Batch 5: T10, then `pnpm check`, the Python change suite, and the e2e the CI way.
- **Critical path:** T1 → T5 → T7 → T9 → T10. (T2 → T3/T4 runs beside it and must be done before T10.)
- **Contract change:** yes, Task 1 (row text below).
- **E2E specs:** new `apps/desktop/e2e/change-area.spec.ts`. `measurement-layers.spec.ts` stays unchanged because the action id is `change.areaCompare` (its order check only reads `ctx-item-measure.*`).

---

### Task 0: Message keys

**Files:**

- Modify: `packages/ui/src/i18n/en.ts` (beside the `change.*` keys, ~line 2520, and the `actions.*` keys)
- Test: `packages/ui/src/i18n/i18n.test.ts` (existing; must stay green)

**Interfaces:**

- Produces these `MessageKey`s (exact English):

| Key                              | Text                                          |
| -------------------------------- | --------------------------------------------- |
| `actions.area.compare`           | `Compare with previous survey`                |
| `actions.area.reason.notPolygon` | `Only a polygon can be compared.`             |
| `actions.area.reason.tooFew`     | `The polygon needs at least three points.`    |
| `actions.area.reason.zeroArea`   | `The polygon has no area.`                    |
| `actions.area.reason.crossing`   | `The polygon crosses itself.`                 |
| `actions.area.reason.noMap`      | `The project has no map position.`            |
| `actions.area.reason.noEarlier`  | `No earlier survey`                           |
| `actions.area.reason.noImagery`  | `Imagery change needs an ortho on each date.` |
| `change.area.title`              | `Compare with previous survey`                |
| `change.area.dates`              | `{from} to {to}`                              |
| `change.area.volumes`            | `Include volumes (cut and fill)`              |
| `change.area.run`                | `Compare`                                     |
| `change.area.cancel`             | `Cancel`                                      |
| `change.area.started`            | `Comparing {name}: {from} to {to}`            |
| `change.area.volumesFailed`      | `Volumes were not started: {why}`             |
| `change.area.picker`             | `Area`                                        |
| `change.area.wholeMap`           | `Whole map`                                   |
| `change.area.volumesMissing`     | `No volumes for this area: {why}`             |

- [ ] **Step 1:** Add the keys. Run `pnpm exec vitest run packages/ui/src/i18n` — PASS.
- [ ] **Step 2:** Commit `feat(ui): messages for area-scoped change detection` (`git add packages/ui/src/i18n/en.ts`).

---

### Task 1: Schema: change scope, surface mask, contract row

**Files:**

- Modify: `packages/schema/src/change.ts` (new `ChangeScope` beside `ChangeSetId`; `ChangeSet` ~269; `ChangeSetSummary` ~325; type exports ~396)
- Modify: `packages/schema/src/jobs.ts:559-602` (`ChangeRasterParams`, `ChangeSurfaceParams`)
- Modify: `docs/architecture/contract-changes.md` (append one row)
- Test: `packages/schema/src/change.test.ts`, `packages/schema/src/m8.test.ts`

**Interfaces:**

- Produces: `export const ChangeScope = z.object({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/), name: z.string().min(1).max(120) }).strict()`; `export type ChangeScope = z.infer<typeof ChangeScope>`.
- `ChangeSet.scope: ChangeScope.optional()`, `ChangeSetSummary.scope: ChangeScope.optional()`.
- `ChangeSet.volumesMissing: z.object({ reason: z.string().min(1).max(300), at: IsoTime }).strict().optional()` — written by the app (Task 7) on the scoped imagery set when volumes were asked for and the `change.surface` run of that area was refused or failed. A later pipeline run of the set rewrites the file without it.
- `ChangeRasterParams.scope: ChangeScope.optional()`; `ChangeSurfaceParams.mask: LonLatRing.optional()`, `.scope: ChangeScope.optional()`.
- Both params: `.refine((p) => !p.scope || p.mask !== undefined, { message: 'A scoped run needs its mask.', path: ['mask'] })`. Keep `.strict()` before the refine; check `z.input<typeof ChangeRasterParams>` still resolves in `apps/desktop/src/renderer/change/producers/raster.ts` (`pnpm typecheck`).

- [ ] **Step 1: Failing tests.**
  - `change.test.ts` `it('a change set keeps its area scope')`: `ChangeSet.parse({...minimalSet, scope: { id: 'pad-a', name: 'Pad A' }}).scope` equals the input; `ChangeScope.safeParse({ id: 'pad a', name: 'x' }).success === false`; name of 121 chars refused; `volumesMissing: { reason: 'Misaligned by 3 m', at }` round-trips and an empty `reason` is refused.
  - `m8.test.ts` `it('change.raster and change.surface take an area scope with its mask')`: `pipelineParams('change.surface').safeParse({ from: {layer:'d1',kind:'dsm'}, to: {layer:'d2',kind:'dsm'}, mask: RING, scope: { id: 'pad-a', name: 'Pad A' } }).success === true`; same for `change.raster`; without `mask` both fail with message `A scoped run needs its mask.`
- [ ] **Step 2:** `pnpm exec vitest run packages/schema/src/change.test.ts packages/schema/src/m8.test.ts` — FAIL.
- [ ] **Step 3:** Implement the schema as above.
- [ ] **Step 4:** Same command — PASS; `pnpm typecheck` — PASS.
- [ ] **Step 5:** Append to `docs/architecture/contract-changes.md` (same table, one line):

  `| 2026-10-19 | Area-scoped change detection (\`packages/schema/src/change.ts\`, \`jobs.ts\`), additive: new \`ChangeScope\` (\`{ id, name }\`, the polygon measurement's id and its label cut to 120). \`ChangeRasterParams\` gains optional \`scope\`; \`ChangeSurfaceParams\` gains optional \`mask\` (lon/lat ring: the DoD, its regions, heat map and site totals are clipped to it) and \`scope\`; both refuse \`scope\` without \`mask\`. A scoped run writes its own set \`<from>-<to>-<producer>-area-<scope id>\` (a 12-character hash of the scope id when the id would pass 120 characters), its folder \`change/<set id>\` and layers \`<set id>-heat\` and \`<set id>-regions\` named after the area, so it never replaces the whole-map set of the pair. \`ChangeSet\` and \`ChangeSetSummary\` (\`change:list\`) gain optional \`scope\`; \`ChangeSet\` also gains optional \`volumesMissing\` (\`{ reason, at }\`), which the app writes on a scoped imagery set when the volumes asked for with it were refused or failed, so the Changes tab can say why they are missing; the next pipeline run of that set drops it. Older builds read a scoped set as a plain set of the pair (the key is stripped) and show its items with the whole-map ones; params without \`scope\` and \`mask\` behave exactly as before. |`

- [ ] **Step 6:** Commit `feat(schema): change scope and surface mask for area-scoped change` (stage the three files and two tests by path).

---

### Task 2: Python: scoped change set ids

**Files:**

- Modify: `python/src/aio_pipelines/change/changeset.py:46-54` (`change_set_id`), `:97-` (`change_set`), `validate_change_set`
- Test: `python/tests/test_changeset.py`

**Interfaces:**

- Produces: `change_set_id(from_capture: str, to_capture: str, producer: str, scope_id: str | None = None) -> str` — unscoped output unchanged; scoped `f"{base}-area-{scope_id}"`; when that passes 120 characters, `f"{base[:120 - 18]}-area-{sha1(scope_id)[:12]}"` (always ≤ 120, file-name safe).
- `check_scope(p: dict) -> dict | None`: returns `p["scope"]` after checking `id` matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$` and `name` is a str of 1 to 120 chars, else `JobError("scope must be { id, name } of the area polygon.")`; when `scope` is present and `mask` absent: `JobError("A scoped run needs its mask (the area polygon).")`.
- `change_set(..., scope: Mapping[str, str] | None = None)` writes `"scope": {"id", "name"}` when given; `validate_change_set` accepts an optional `scope` of that shape and an optional `volumesMissing` (`{ reason: str, at: str }`, written by the app) so reading a previous set for its reviews never fails on it; `change_set` never writes `volumesMissing` (a new run drops it). Test `test_a_set_with_volumes_missing_still_validates`.

- [ ] **Step 1: Failing tests** in `test_changeset.py`:
  - `test_a_scoped_id_never_equals_the_whole_map_id`: `change_set_id("c1","c2","change.raster","pad-a") == "c1-c2-raster-area-pad-a"` and `!= change_set_id("c1","c2","change.raster")`.
  - `test_long_scoped_ids_stay_short_and_distinct`: with `from = "c" * 60`, two scope ids `"a"*70+"1"` and `"a"*70+"2"` give two ids, each `len <= 120` and matching `SET_ID`.
  - `test_a_change_set_carries_its_scope`: `change_set(..., scope={"id": "pad-a", "name": "Pad A"})["scope"] == {...}` and passes `validate_change_set`.
  - `test_check_scope_refuses_a_scope_without_a_mask`: `pytest.raises(JobError, match="needs its mask")`.
- [ ] **Step 2:** Run (Global Constraints python command) `-m pytest tests/test_changeset.py -q` — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command — PASS. `ruff format` and `ruff check` the two files.
- [ ] **Step 5:** Commit `feat(pipelines): scoped change set ids`.

---

### Task 3: Python: `change.raster` with a scope

**Files:**

- Modify: `python/src/aio_pipelines/change/raster.py` (`keys` ~331, `validate` ~347, `plan` ~367-614)
- Test: `python/tests/test_change_raster.py`

**Interfaces:**

- Consumes: `change_set_id(..., scope_id)`, `check_scope`, `change_set(..., scope=)` (Task 2).
- Produces: params key `scope`; set id and default `out` from `change_set_id(from, to, PRODUCER, scope["id"] if scope else None)`; layer names `f"{name}: imagery change heat map, {when}"` and `f"{name}: imagery change areas, {when}"` when scoped (unscoped names unchanged); the change set carries `scope`.

- [ ] **Step 1: Failing test** `test_a_scoped_run_keeps_its_own_set_beside_the_whole_map_one` (reuse the `ring(r0, c0, size)` helper of `test_an_ignore_polygon_hides...`; lift it to module level as `ortho_ring`):
  - whole-map run (`job_id="j1"`) then `raster_params(mask=ortho_ring(150, 200, 300), scope={"id": "pad-a", "name": "Pad A"})` (`job_id="j2"`).
  - `change/c1-c2-raster.json` still exists with its 1 item; `change/c1-c2-raster-area-pad-a.json` exists, `["scope"] == {"id": "pad-a", "name": "Pad A"}`, 1 item.
  - manifest has `c1-c2-raster-heat`, `c1-c2-raster-regions`, `c1-c2-raster-area-pad-a-heat`, `c1-c2-raster-area-pad-a-regions`; the scoped names start with `Pad A: imagery change`.
  - `test_a_scope_without_a_mask_is_refused`: add `({"scope": {"id": "pad-a", "name": "Pad A"}}, "needs its mask")` to the bad-parameters parametrize (~312).
- [ ] **Step 2:** `-m pytest tests/test_change_raster.py -q -k "scope or bad_parameters"` — FAIL.
- [ ] **Step 3:** Implement (`"scope"` in `keys`; `check_scope(p)` in `validate`; scoped id in `plan`; scope into `change_set` and the layer names in `commit`).
- [ ] **Step 4:** `-m pytest tests/test_change_raster.py tests/test_m8_pipelines.py -q` — PASS. Format.
- [ ] **Step 5:** Commit `feat(pipelines): change.raster runs for one area`.

---

### Task 4: Python: `change.surface` with a mask and a scope

**Files:**

- Modify: `python/src/aio_pipelines/change/surface.py` (`keys` ~403, `validate` ~405, `ids` ~459, `compare` ~534-662, `commit` ~664)
- Test: `python/tests/test_change_surface.py`

**Interfaces:**

- Consumes: Task 2; `ring_mask` from `.imagery` (already used by raster).
- Produces: params keys `mask`, `scope`; `ids(m)` returns the scoped set id; in `compare`, right after `dod = hb - ha`: `if "mask" in params: dod[~ring_mask(m, [params["mask"]], grid)] = np.nan` so regions, heat map (transparent outside) and the `site*` totals see only the area. `areas` volumes are unchanged. Layer names `f"{name}: surface change heat map, {when}"` / `f"{name}: cut and fill areas, {when}"` when scoped. `mask` validated like raster's (`_ring`: move it to `imagery.py` beside `ring_mask` and import it in both).

- [ ] **Step 1: Failing tests** (lift the `ring(cx, cz, r)` helper of `test_areas_report_their_own_volumes` to module level as `local_ring`):
  - `test_a_mask_keeps_only_the_regions_inside`: params `surface_params(mask=local_ring(-10, -8, 15), scope={"id": "pile", "name": "Pile"})`; read `change/c1-c2-surface-area-pile.json`: exactly one `region:` item, verdict `fill`, `fillM3 ≈ 1000 (rel 0.02)`; no `cut` region; `stats["siteCutM3"] < 5`; `scope == {"id": "pile", "name": "Pile"}`; every region `at` within the ring's x/z bounds; `change/c1-c2-surface.json` does not exist.
  - `test_a_scoped_surface_run_leaves_the_whole_map_set`: whole-map run, then the scoped run; `c1-c2-surface.json` still has its fill and cut; manifest holds both `c1-c2-surface-heat` and `c1-c2-surface-area-pile-heat`.
  - Bad parameters parametrize (~244): `({"scope": {"id": "p", "name": "P"}}, "needs its mask")` and `({"mask": [[1, 2]]}, "mask must be a polygon")`.
- [ ] **Step 2:** `-m pytest tests/test_change_surface.py -q -k "mask or scoped or bad_parameters"` — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `-m pytest tests/test_change_surface.py tests/test_change_raster.py tests/test_changeset.py tests/test_m8_pipelines.py -q` — PASS. Format.
- [ ] **Step 5:** Commit `feat(pipelines): change.surface clips to an area mask`.

---

### Task 5: Changes store and panel: one entry per area

**Files:**

- Modify: `packages/change/src/register.ts:90-101` (`summarize` copies `scope`)
- Modify: `packages/change/src/store.ts` (`ChangeState.area`, `setArea`, `Misaligned.params`, `setsOfPair`, new `areasOfPair`)
- Modify: `packages/change/src/ChangePanel.tsx` (area picker, `onRerun` signature)
- Modify: `packages/change/src/index.ts` / `core.ts` exports as needed
- Test: `packages/change/src/store.test.ts`, `packages/change/src/register.test.ts`, `packages/change/src/ChangePanel.test.tsx`

**Interfaces:**

- Consumes: `ChangeScope` (Task 1); keys `change.area.picker`, `change.area.wholeMap` (Task 0).
- Produces:
  - `ChangeState.area: string | null` (scope id; null = whole map), `ChangeActions.setArea(id: string | null): void`. `setPair` to a different pair resets `area` to null and `selected` to null; `setPair` to the same pair keeps `area`.
  - `Misaligned.params?: Record<string, unknown>` (the refused scoped job's params, for a replay).
  - `setsOfPair(sets, pair, area: string | null = null): ChangeSet[]` — only sets whose `scope?.id ?? null === area`.
  - `areasOfPair(sets, pair): ChangeScope[]` — distinct scopes of the pair's sets, by name then id.
  - `ChangePanelProps.onRerun?: (producer: string, set?: ChangeSet) => Promise<string | null>`; the stale bar passes its set.
  - Panel: `<select data-testid="change-area" aria-label={t('change.area.picker')}>` shown only when `areasOfPair` is non-empty; options `''` = Whole map, then each scope (`value = id`, text = `name`). Rows, counts, stale bars use `setsOfPair(s.sets, s.pair, s.area)`.
  - `volumesNote(sets: ChangeSet[]): string | null` (store.ts, exported): among an area's sets, the `volumesMissing.reason` of its `change.raster` set when the area has no `change.surface` set; else null. The panel shows it while an area is chosen, as a lasting muted line above the rows: `<p className="chg-note" role="note" data-testid="change-area-volumes-missing">{t('change.area.volumesMissing', { why })}</p>`, next to the imagery result. Tests: `store.test.ts` `it('an area whose volumes were refused says why')` (raster set with `volumesMissing`, no surface set → the reason; with a surface set → null; whole map → null); `ChangePanel.test.tsx` `it('shows why volumes are missing for an area')`.

- [ ] **Step 1: Failing tests.**
  - `register.test.ts` `it('a summary carries the area scope')`.
  - `store.test.ts` `it('the whole map and each area are separate entries')`: sets `c1-c2-raster` (no scope), `c1-c2-raster-area-a` (scope a), `c1-c2-surface-area-a` (scope a): `setsOfPair(sets, pair).map(id) == ['c1-c2-raster']`; `setsOfPair(sets, pair, 'a')` has both area sets (imagery and volumes in one entry); `areasOfPair` returns `[{ id: 'a', name: ... }]`.
  - `store.test.ts` `it('another pair resets the area, the same pair keeps it')` (Review Focus 4).
  - `ChangePanel.test.tsx` `it('shows the area picker and only the chosen area\'s rows')`: with one whole-map item and one area item, rows count 1; choose the area in `change-area`; rows count 1 with the area item's label. `it('offers no area picker without areas')`. Existing `offers Run again on a stale set` asserts `onRerun` called with `(producer, set)`.
- [ ] **Step 2:** `pnpm exec vitest run packages/change/src` — FAIL.
- [ ] **Step 3:** Implement. Keep the picker in the panel's existing filter row styling (`chg-*` classes, a plain `<select>` like `change-filter-kind`).
- [ ] **Step 4:** Same command — PASS; `pnpm typecheck` — PASS (callers of `setsOfPair` in `apps/desktop` still compile with the default).
- [ ] **Step 5:** Commit `feat(change): one register entry per area`.

---

### Task 6: Area model (pure)

**Files:**

- Create: `apps/desktop/src/renderer/change/area/areaModel.ts`
- Test: `apps/desktop/src/renderer/change/area/areaModel.test.ts`

**Interfaces:**

- Consumes: `toWgs84(p: Vec3, epsg: number): Vec3` from `@aio/geo`; `stepCapture(index, focus, -1)` and `CaptureIndex` from `@aio/workspace`; `SurveyMeasurement`, `ChangeScope`, `LonLatRing` from `@aio/schema`; `t` from `@aio/ui` and Task 0 keys.
- Produces:
  - `polygonRing(m: SurveyMeasurement, epsg: number | null): { ring: LonLatRing } | { reason: string }` — reasons in this order: not `family === 'polygon'` → `notPolygon`; `epsg === null` → `noMap`; fewer than 3 distinct (E, N) points (a repeated closing point does not count) → `tooFew`; shoelace area on (E, N) below `1e-6` m² → `zeroArea`; any two non-adjacent edges intersect (closed ring, O(n²)) → `crossing`. The ring is the distinct points through `toWgs84`, as `[lon, lat]`, not closed.
  - `previousPair(index: CaptureIndex, m: SurveyMeasurement, focus: string | null): { from: string; to: string } | { reason: string }` — current = `m.scope.capture` for a survey scope, else `focus` when it is a capture of `index`, else the latest capture; `from = stepCapture(index, current, -1)`; none → `noEarlier`.
  - `areaScope(m: SurveyMeasurement): ChangeScope` — `{ id: m.id, name: m.label.trim().slice(0, 120) }`.

- [ ] **Step 1: Failing tests** (`EPSG 32639`, points around `[500000, 3200000]`):
  - `polygonRing`: a 10 m square gives 4 `[lon, lat]` pairs that `LonLatRing.parse` accepts and round-trip through `fromWgs84` within 1 mm; a line measurement → `Only a polygon can be compared.`; two points plus a repeated first point → `tooFew`; three collinear points → `zeroArea`; a bow-tie `[[0,0],[10,10],[10,0],[0,10]]` → `crossing`; `epsg null` → `noMap`.
  - `previousPair`: captures `a < b < c`; survey scope `c` → `{ from: 'b', to: 'c' }`; site scope with focus `b` → `{ from: 'a', to: 'b' }`; site scope with focus null → `{ from: 'b', to: 'c' }` (Review Focus 1); survey scope `a` → `No earlier survey`; one capture only → `No earlier survey`.
  - `areaScope`: a 200-char label gives a 120-char name (Review Focus 2).
- [ ] **Step 2:** `pnpm exec vitest run apps/desktop/src/renderer/change/area/areaModel.test.ts` — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command — PASS.
- [ ] **Step 5:** Commit `feat(desktop): area model for scoped change detection`.

---

### Task 7: Scoped producers and the area run

**Files:**

- Modify: `apps/desktop/src/renderer/change/producers/raster.ts` (export `runJob` as `startChangeRun`; in it, a misaligned answer of a run whose params hold `scope` keeps those params: `setMisaligned({ ...m, params })`)
- Modify: `apps/desktop/src/renderer/change/producers/register.ts` (export `pairContext`; export the `ProducerDeps` instance it builds as `appProducerDeps()`)
- Create: `apps/desktop/src/renderer/change/area/run.ts`
- Test: `apps/desktop/src/renderer/change/producers/raster.test.ts`, `apps/desktop/src/renderer/change/area/run.test.ts`

**Interfaces:**

- Consumes: `rasterParams`, `surfaceParams`, `orthoPair`, `surfacePair`, `ProducerDeps` (existing, raster.ts); Task 5 `changeStore.setPair/setArea`, `Misaligned.params`; Task 6 ring and scope; `openChangesTab()` (`useChangeOverlays.ts`).
- Produces:
  - `areaRasterParams(ctx: ChangePairContext, area: { scope: ChangeScope; ring: LonLatRing }, thresholds?): RasterParams` = `rasterParams(...)` + `{ mask: ring, scope }`, or the `orthoPair` reason string.
  - `areaSurfaceParams(ctx, area, thresholds?): SurfaceParams | string` = `surfaceParams(...)` + `{ mask: ring, scope, areas: [{ id: scope.id, name: scope.name, ring }] }`, or the `surfacePair` reason.
  - `runAreaCompare(deps: ProducerDeps, ctx: ChangePairContext, area: { scope: ChangeScope; ring: LonLatRing }, opts: { volumes: boolean }): Promise<{ ok: true; notes: string[] } | { ok: false; error: string }>` — starts `change.raster` (an error there is the result, nothing else starts); with `volumes`, starts `change.surface` and turns its error into `t('change.area.volumesFailed', { why })` in `notes`. On ok: `changeStore.getState().setPair({ from, to })`, then `setArea(scope.id)`, then `openChangesTab()`.
  - Recording the partial outcome (in `run.ts`, not awaited by the caller): `recordVolumesOutcome(deps, rasterJobId, surface: { jobId } | { error }, scope, pair): Promise<void>` — waits for both jobs with `deps.finished`; when the surface start errored, or its job ended `failed` (misaligned: `Misaligned by {shiftM} m` built from `failure.data`; otherwise the job's `failure.message` / error text), and the raster job ended `done`: reload the sets (`changeStore.getState().load(projectId)`), take the pair's `change.raster` set with `scope.id`, and `changeStore.getState().save({ ...set, volumesMissing: { reason, at: new Date().toISOString() } })`. Does nothing when the raster job did not end `done`, when the project changed meanwhile (`deps.projectId`), or when the surface job ended `done`. Tests in `run.test.ts`: `it('records why volumes are missing on the area\'s imagery set')` (surface `failed` → `save` called with `volumesMissing.reason`), `it('records a refused volume start')`, `it('records nothing when volumes ran or were not asked for')`, `it('records nothing when imagery failed')`.

- [ ] **Step 1: Failing tests.**
  - `raster.test.ts`: `ChangeRasterParams.parse(areaRasterParams(ctx, AREA))` and `ChangeSurfaceParams.parse(areaSurfaceParams(ctx, AREA))` succeed and carry `mask`, `scope`; without an ortho pair the reason string comes back.
  - `raster.test.ts` `it('a refused scoped run keeps its params for the replay')`: a `finished` that answers a misaligned failure; `setMisaligned` receives `params.scope`.
  - `run.test.ts`: volumes off → one `start('change.raster', ...)`; volumes on → raster then surface, both with the same `scope.id`; surface start error → `ok: true` with one note; the volumes outcome is recorded (below) for a surface start error, a misaligned refusal and a failed job, and not when the surface job ends `done` or volumes were not asked for; raster error → `ok: false`, surface never started, store pair untouched; on ok the store has the pair and `area === scope.id` and `changesTab` seq bumped.
- [ ] **Step 2:** `pnpm exec vitest run apps/desktop/src/renderer/change` — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command — PASS.
- [ ] **Step 5:** Commit `feat(desktop): start imagery and volume change for one area`.

---

### Task 8: Scoped reruns, Changes tab, overlays

**Files:**

- Modify: `apps/desktop/src/renderer/change/rerun.ts` (new `rerunScoped`)
- Modify: `apps/desktop/src/renderer/change/ChangesTab.tsx` (`onRerun(producer, set)`, `onLineUp` replay)
- Modify: `apps/desktop/src/renderer/change/useChangeOverlays.ts:89` (`setsOfPair(sets, pair, area)`)
- Test: `apps/desktop/src/renderer/change/rerun.test.ts`

**Interfaces:**

- Consumes: Task 5 (`area`, `Misaligned.params`, `onRerun` signature), `startChangeJob` (register.ts, existing export).
- Produces: `rerunScoped(producer: string, params: Record<string, unknown>, start = startChangeJob): Promise<string | null>` — re-starts pipeline `producer` (`change.raster` / `change.surface`; a bare `raster` / `surface` is prefixed) with the stored params unchanged (the polygon as it was: the result stays a snapshot of the area); returns the error sentence or null. `ChangesTab`: a stale set with `scope` and `run.params` reruns through `rerunScoped(set.producer, set.run.params)`; a misaligned with `params` replays them after the line-up; everything else goes through `rerunProducer` as today.

- [ ] **Step 1: Failing tests** in `rerun.test.ts`: `rerunScoped('change.surface', P)` calls `start` with `{ pipeline: 'change.surface', params: P }` (Review Focus 5); `rerunScoped('raster', P)` uses `change.raster`; a start error comes back as the sentence.
- [ ] **Step 2:** `pnpm exec vitest run apps/desktop/src/renderer/change/rerun.test.ts` — FAIL.
- [ ] **Step 3:** Implement `rerunScoped` and wire `ChangesTab` and the overlays.
- [ ] **Step 4:** `pnpm exec vitest run apps/desktop/src/renderer/change` — PASS; `pnpm typecheck` — PASS.
- [ ] **Step 5:** Commit `feat(desktop): scoped change reruns and overlays follow the area`.

---

### Task 9: Confirm box and the right-click action

**Files:**

- Create: `apps/desktop/src/renderer/change/area/areaCompareStore.ts`
- Create: `apps/desktop/src/renderer/change/area/AreaCompareDialog.tsx`
- Create: `apps/desktop/src/renderer/shell/actions/areaActions.tsx`
- Modify: `apps/desktop/src/renderer/shell/actions/index.ts` (call `registerAreaActions()` after `registerMeasureActions()`)
- Modify: `apps/desktop/src/renderer/App.tsx:587` (mount `<AreaCompareHost />` beside `<RemoveHost />`)
- Modify: `apps/desktop/src/renderer/survey/MeasureMenu.tsx` (pass `focus: timeline.getState().focus` to `makeActionCtx`, as `Sidebar.tsx:448` does)
- Test: `apps/desktop/src/renderer/shell/actions/areaActions.test.ts`, `apps/desktop/src/renderer/change/area/AreaCompareDialog.test.tsx`

**Interfaces:**

- Consumes: Task 6 (`polygonRing`, `previousPair`, `areaScope`), Task 7 (`runAreaCompare`, `pairContext`, `appProducerDeps`, `orthoPair`, `surfacePair`), `measureStore` (measurements), `timeline` (`apps/desktop/src/renderer/workspace/timeline.ts`: `getState().index`, `.focus`), `frameOf(manifest).epsg` (`survey/measureScene.ts`), `formatDate` (`@aio/ui`).
- Produces:
  - `areaCompare` zustand store: `{ request: { measurementId: string; from: string; to: string } | null; ask(req): void; close(): void }`.
  - Volumes preference: `localStorage['stratlas.areaCompare.volumes']` (`'1'`/`'0'`), read and written in try/catch; default off.
  - Action `defineAction<'measurements'>({ id: 'change.areaCompare', label: 'actions.area.compare', icon: 'compare' (or the icon Compare with uses), section: 'compare', targets: ['measurements'], appliesTo, disabled, run })` — no `multi`, so it is not offered for several marked items. `appliesTo`: the clicked measurement is `family === 'polygon'`. `disabled` (first reason wins): `ctx.pkg` or no project root → `t('actions.reason.package')`; `polygonRing(...).reason`; `previousPair(timeline index, m, ctx.focus).reason`; `orthoPair(pairContext(...))` string → `actions.area.reason.noImagery`. `run`: `areaCompare.getState().ask({ measurementId, from, to })`.
  - `AreaCompareDialog`: the survey dialog look (`sv-scrim` / `sv-dialog` / `sv-head` / `sv-foot`, `useFocusTrap(ref, true, { onEscape: close })`, as `survey/UnitsDialog.tsx`), small: header icon + `change.area.title`, sub line = polygon label, one line `change.area.dates` with `formatDate` of each capture, one checkbox `change.area.volumes` (`data-testid="area-compare-volumes"`) disabled with the `surfacePair` reason as its `title` and a `small faint` line under it, footer Cancel (`area-compare-cancel`) and primary Compare (`area-compare-run`, busy while starting). Root `data-testid="area-compare-dialog"`. On Compare: `runAreaCompare(...)`; an error stays in the box (`notice danger small`), ok closes it and notes become toasts (`toastHost`).

- [ ] **Step 1: Failing tests.**
  - `areaActions.test.ts` (pattern of `measureActions.test.ts` / `parity.test.ts`, jsdom, mocked `timeline` and `measureStore`): offered for one polygon; not offered for a line, a point, or `ids.length > 1`; disabled `No earlier survey` with one capture; disabled `The polygon crosses itself.` for a bow-tie; disabled in a package; enabled for a valid square with two dated orthos; `run` sets `areaCompare.request` with the previous pair.
  - `AreaCompareDialog.test.tsx`: shows the two dates and the polygon label; checkbox off by default and remembers `true` after a run (localStorage); disabled with the reason when `surfacePair` says no DSM; Compare calls `runAreaCompare` with `{ volumes }`; Escape closes.
- [ ] **Step 2:** `pnpm exec vitest run apps/desktop/src/renderer/shell/actions/areaActions.test.ts apps/desktop/src/renderer/change/area` — FAIL.
- [ ] **Step 3:** Implement. Load `impeccable` before the dialog markup; keep it the size of `UnitsDialog` or smaller.
- [ ] **Step 4:** Same command plus `apps/desktop/src/renderer/shell/actions` — PASS; `pnpm typecheck && pnpm lint` — PASS.
- [ ] **Step 5:** Commit `feat(desktop): compare a polygon with the previous survey`.

---

### Task 10: End to end on the change demo

**Files:**

- Create: `apps/desktop/e2e/change-area.spec.ts`

**Interfaces:**

- Consumes: `demoProject`, `hasPipelinePython`, `PIPELINE_ENV`, `openChangeDemo` (`e2e/fixtures.ts`); `box`, `inside`, `Item`, `RasterTruth` (`e2e/changeRaster.ts`); `measureRow`, `measureTree`, `openBench` (`e2e/island.ts`).

- [ ] **Step 1: Write the spec** `test('compare one area with the previous survey', ...)`, `test.use({ appEnv: PIPELINE_ENV })`, skipped without pipeline Python, `test.setTimeout(420_000)`:
  1. From `truth.changes.raster` take the first region `R` and one other region `S` that lies outside `box(R.outline, 3)`. Polygon = the 4 corners of `box(R.outline, 3)` in local (x, z) mapped to project E, N with `manifest.origin` read from `<root>/manifest.json`: `E = ox + x`, `N = oy - z`. Write `<root>/survey/measurements.json` (`aio.measurements/1`, one polygon `id: 'area-a'`, `label: 'Area A'`, `scope: { kind: 'survey', capture: truth.captures.to }`), then reopen the project (Projects, then `openChangeDemo(win)`) so the measure store reads it. If the store does not re-read on reopen, draw the square with the Area tool instead, the way `measure-tools.spec.ts` does.
  2. `measureTree(win)`; right-click `measureRow(win, 'Area A').locator('.tn')`; `ctx-item-change.areaCompare` is enabled; click it.
  3. `area-compare-dialog` is visible, shows both dates' labels and `Area A`; `area-compare-volumes` is unchecked; click `area-compare-run`.
  4. Poll the manifest (as `change-raster.spec.ts` `layerIds`) for `${from}-${to}-raster-area-area-a-heat` and `-regions` (240 s).
  5. `change/${from}-${to}-raster-area-area-a.json`: `scope` is `{ id: 'area-a', name: 'Area A' }`; at least one item `inside(item.at, box(R.outline, 3))`; **every** item's `at` lies inside the polygon box; no item near `S`. `change/${from}-${to}-raster.json` does not exist (no whole-map run started).
  6. The Changes tab is shown (`change-panel` visible), `change-area` has value `area-a`, the rows are the scoped items only.
  7. Screenshot `change-area.png` to the test output; check it by eye.
- [ ] **Step 2:** From `apps/desktop`: `pnpm demo:change --quick`, then (PowerShell) `$env:QUADRION_WINDOW_SIZE = '1100x720'; $env:QUADRION_E2E_SCALE = '1'; $env:QUADRION_E2E_SWGL = 'warp'; $env:QUADRION_E2E_PYTHON = 'E:\Dev\AIO Software\python\.venv\Scripts\python.exe'; npx playwright test e2e/change-area.spec.ts --workers=1`. The log prints `[e2e] window 1100 x 720 px at display scale 1`. Expected: PASS. Also run `e2e/change-raster.spec.ts` and `e2e/measurement-layers.spec.ts` the same way (unchanged, must stay green).
- [ ] **Step 3:** Commit `test(e2e): area-scoped change on the change demo`.

---

## Finish

- `pnpm check` green; the Python change suite (`test_changeset.py test_change_raster.py test_change_surface.py test_m8_pipelines.py`) green.
- `node tools/agent/check-public-text.mjs` on the plan, the session note and the new spec.
- `/wrapup` on this branch, then `node tools/agent/finish-task.mjs`, then the merge steps in `CLAUDE.md`.
- "How to test" for the founder (closing message and session note):
  1. Open the change demo, open the later survey, draw a polygon with the Area tool around one changed spot.
  2. Right-click the polygon (on the map, in 3D, or its row under Measurements) and choose **Compare with previous survey**.
  3. The box shows the two dates and the polygon name; leave "Include volumes" off; click Compare.
  4. When the job ends, the Changes tab opens on that pair with the area chosen in the Area picker; only changes inside the polygon are listed and drawn.
  5. Run it again with "Include volumes" ticked: the same area entry now has cut and fill items too; the box remembers the tick next time.
  6. Pick **Whole map** in the Area picker: the whole-map result (if any) is unchanged.
