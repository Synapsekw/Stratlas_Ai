# Right Sidebar "In this project" List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Plan approved up front:** the founder approved the mock-ups on 24 Oct 2026 and asked to go ahead. There is no separate plan-approval checkpoint; build straight from this plan.

**Goal:** The right panel's first tab becomes **Project**: an "In this project" list of content groups (Antennas first, with inline editing, delete that stays deleted and right-click), then the unchanged Measure tools below a TOOLS caption.

**Architecture:** The workbench tab keeps its internal id `measure` (no pin or fold migration needed) but is labelled "Project", becomes a fixed tab and sits first among the fixed tabs. A new `workspace/workbench/project/` folder holds the list (caption, fold, group registry, category order, reveal and scroll requests); each group is a `Section` of bench `measure`. The floating `AntennaCard` is retired: its parts move into an inline `AntennaDetails` under the selected row. Deleting a detected unit writes a sidecar `telecom/antenna-deletions.json` that the Python re-run merge reads and treats like a rejection.

**Tech Stack:** Electron, React 19, TypeScript, zustand, zod (`@aio/schema`), Vitest + Testing Library, Playwright (e2e), Python 3.13 pipeline pack (`aio_pipelines`, pytest, ruff).

**Spec:** `docs/superpowers/specs/2026-10-24-right-sidebar-project-list-design.md` (screenshots in `docs/design/right-sidebar/`, the chosen layout is `chosen-c1-one-panel.png`).

## Global Constraints

- Code rules in `CONTRIBUTING.md`; every user-facing string through i18n (`packages/ui/src/i18n/en.ts`), added in Task 0 only.
- Tools stay exactly where and how they are found today: same sections, order, contents, search, favourites. No "quick tools" row, no "+" or "More tools" menu.
- No change to the left sidebar, the stage notch groups (the notch's group is still called "Measure"), or the Volumes, Changes, Coverage, Thermal, Model review panel tabs beyond the wiring named here.
- New UI must look like today's Measure bench sections (`Section`, `section.css`); no new visual style. Load the `impeccable` and `frontend-design` skills before UI tasks.
- An expanded group shows at most 8 rows and scrolls inside itself beyond that; the whole content area folds with one click on its caption, remembered per computer (the `sectionStore`, bench `measure`).
- Must look right at 1100 x 720 (CI) and on large screens; the panel keeps today's width.
- Existing per-computer state (bench folds `quadrion.sections`, pins `quadrion.workbench`) keeps working: the tab id stays `measure`.
- `telecom/antennas.json` stays `aio.antennas/1` and byte-compatible with older builds (their read is a strict zod parse: an unknown key or status would break their whole inventory).
- Never write to the main checkout; never bare `git stash`; e2e windows off-screen through the fixtures, `--workers=1`, one Playwright run at a time.
- Public text (session notes, commit messages) carries no client, site, tester or person names.

## Review Focus

1. **Delete key with two selections**: a measurement marked in the left tree and an antenna selected at once; Delete must act on what has focus (the tree handles its own Delete; the antenna key only when focus is not in the tree or a field). Test in Task 6b.
2. **A pick while Coverage or Thermal is in front**: picking a unit in 3D must not take the Coverage tab away mid-use; the list updates in the background. Test in Task 8.
3. **Deleting the unit an RF sector holds while the plan has unsaved edits**: the removal goes into the working copy (it stays dirty) and the dialog says to save the plan; nothing the person typed in Coverage is lost or saved behind their back. Test in Task 4.
4. **Measuring tool stop with the Project tab now fixed**: today the Measure tab closes after a tool that opened it stops and the front returns to Selection; as a fixed tab it stays, in front. Every spec that asserted the old return must be updated deliberately, and the focused measurement's details must show in the Measurements group (Task 10 keeps the `survey-side` test id). Test in Task 5 (unit) and Task 9/13 (e2e).
5. **A re-run on another survey date after a delete**: the deletion record is moved into the run's date frame before matching, so the deleted detection stays gone. Test in Task 2.

---

## Decisions this plan makes (spec "left to the builder")

- **Tab id**: stays `measure`; label `wb.tab.measure` becomes "Project". `measure` joins the fixed tabs, first: `FIXED = ['measure', 'selection', 'issues', 'volumes', 'changes']`. A remembered pin of `measure` is skipped by `readPins` (fixed tabs are never pinned), which is the migration.
- **Deletion record format** (the spec left it open). A sidecar file, not a key in `antennas.json`, because older builds strict-parse `antennas.json` (`AntennasFile` and `AntennaUnit` are `.strict()`, parsed by `parseAs` in `apps/desktop/src/main/survey.ts`), so any new key, status or entry breaks their inventory; and the pipeline rewrites `antennas.json` with only `schema`, `run`, `units`, so a new key would be dropped on each re-run. Older builds never read the sidecar, so they ignore it.

  ```ts
  // packages/schema/src/antennas.ts
  export const ANTENNA_DELETIONS_SCHEMA = 'aio.antenna-deletions/1';
  export const ANTENNA_DELETIONS_FILE = 'telecom/antenna-deletions.json';
  export const TELECOM_DELETE_MIN_PACK = '0.25.0';
  export const TELECOM_DELETE_FEATURE = 'Deleted antennas stay deleted';
  export const AntennaDeletion = z
    .object({
      unitId: z.string().regex(ANTENNA_ID), // the deleted unit's id
      name: z.string().min(1).max(40),
      kind: AntennaKind,
      box: AntennaBox, // in the frame of `captureId`
      captureId: z.string().min(1).max(128).optional(), // the file's run.captureId when deleted
      deletedAt: IsoTime,
    })
    .strict();
  export const AntennaDeletionsFile = z
    .object({
      schema: z.literal(ANTENNA_DELETIONS_SCHEMA),
      deletions: z.array(AntennaDeletion).max(2000),
    })
    .strict();
  ```

  Merge rule (Python): after old units are paired with the new finds, a **new** find (unpaired) whose box centre lies within `MATCH_RADIUS_M` (0.3 m) of a deletion's box centre, any kind, is dropped. Old units win over records. Records are never removed by Python (it only reads the sidecar). A flagged unit that is deleted writes no record.

- **Pack**: pipeline pack **0.25.0** (check `python/pyproject.toml` on the latest `main` before bumping; if another branch took 0.25.0, take the next and change `TELECOM_DELETE_MIN_PACK` with it, as `b1e5ef0fd` did). `APP_RANGE` keeps its floor. `jobs:start` refuses `telecom.antennas` on a pack below `TELECOM_DELETE_MIN_PACK` when the sidecar has records (or is unreadable), the same way the person-owned gate refuses below 0.24.0.
- **One delete IPC in main**: `telecom:deleteAntennas { projectId, ids }` reads the inventory, writes the sidecar first, then `antennas.json`, then removes the crops; journaled. The renderer runs it through the same write queue as other antenna changes.
- **Issues rows open the issue** (the Issue card in the Selection tab, as today) and have no inline details: an inline editor would be the "second place to edit" the spec forbids. Measurements show their existing `MeasurementPanel` inline; the Measure bench's "Selected" card is dropped for non-telecom measurements so there is one panel.
- **Sectors**: rename only (plus Fly to, Open in Coverage). Saved sectors only: `rfStore.hasFile ? sectors.sectors : []`.
- **Per-unit hide and kind solo** (today's row eye and group solo) move to the right-click menu (`antenna.hide`, `antenna.show`, `antenna.soloKind`) so no behaviour is lost; the group header keeps the eye (Hide all / Show all) and Flag antenna.
- **While a tool is live**, the live card (and the pending card) stay first, above IN THIS PROJECT, so a running tool is never pushed down. A tools search filters only the tools; the content list stays as it is.
- **Later groups** (Stockpiles, Changes, Photos) are not built; the order data names them and the list skips ids with no registered group.

## File Structure

New, `apps/desktop/src/renderer/workspace/workbench/project/`:

- `projectGroups.ts`: pure. `GroupId`, `Category`, `CATEGORY_ORDER`, `projectCategory()`, `orderGroups()`.
- `projectListStore.ts`: zustand. Reveal requests (`revealInList`) and the tools-scroll request (`requestToolsScroll`).
- `groupRegistry.ts`: `ProjectGroupDef` and the static list of registered groups.
- `ProjectList.tsx`: the IN THIS PROJECT caption with its fold, the ordered groups, the TOOLS caption.
- `useRevealRow.ts`: hold a group open for a revealed row and scroll the row into view inside the group's inner scroller (generalised from `AntennaSection`'s hold logic).
- `rowList.css`: the row grid and the 8-row inner scroller, built on `section.css` tokens.
- `antennaFollow.ts`: a 3D pick brings the Project tab forward unless a tool is in front.
- `groups/MeasurementsGroup.tsx`, `groups/IssuesGroup.tsx`, `groups/SectorsGroup.tsx`, `groups/CoveragePlanGroup.tsx`.

New, `apps/desktop/src/renderer/telecom/`:

- `AntennasGroup.tsx` (replaces `AntennaSection.tsx`), `AntennaRow.tsx`, `AntennaDetails.tsx` (photo strip, values, kind pick, folds and actions moved out of `AntennaCard.tsx`), `AntennaBulkBar.tsx`, `antennaDelete.ts` (confirmation state and the delete flow), `AntennaDeleteDialog.tsx`, `AntennaMenu.tsx`.

New elsewhere: `apps/desktop/src/renderer/shell/actions/antennaActions.tsx`; `packages/schema/src/__fixtures__/antenna-deletions-contract.json`; e2e `apps/desktop/e2e/project-list-antennas.spec.ts`, `apps/desktop/e2e/project-list-groups.spec.ts`.

Removed: `telecom/AntennaSection.tsx`, `telecom/AntennaCard.tsx` (+ test), `telecom/cardPlacement.ts` (+ test). Their unit tests move to the new files' tests; no e2e spec is deleted.

---

## Execution DAG

| Task | Title                                          | Depends on  | Packages / areas                              |
| ---- | ---------------------------------------------- | ----------- | --------------------------------------------- |
| 0    | All new strings                                | none        | `@aio/ui` (en.ts)                             |
| 1    | Deletion sidecar and delete IPC contract       | none        | `@aio/schema`, docs                           |
| 2    | Python merge honours deletions; pack 0.25.0    | 1           | python                                        |
| 3    | Main: delete IPC, journal, pack gate           | 1           | desktop main, preload                         |
| 4    | Renderer delete flow and RF sector removal     | 0, 1        | desktop renderer (telecom, rf)                |
| 5    | Project tab shell and list skeleton            | 0           | desktop renderer (workbench, island)          |
| 6a   | Antennas group: rows, inline details, bulk bar | 4, 5        | desktop renderer (telecom)                    |
| 7    | `antenna` menu target, actions, AntennaMenu    | 0, 4        | `@aio/ui` actions, renderer shell             |
| 6b   | Retire the floating card; keys; dialog mount   | 6a          | desktop renderer (telecom, rf, workspace)     |
| 8    | Right-click wiring and pick-follow             | 6b, 7       | desktop renderer (telecom, workbench)         |
| 9    | Phase A e2e                                    | 2, 3, 8     | desktop e2e                                   |
| 10   | Measurements and Issues groups                 | 5, 6a       | desktop renderer (workbench, survey)          |
| 11   | Sectors and Coverage plan groups               | 4, 5        | desktop renderer (workbench, rf)              |
| 12b  | `telecom` project purpose                      | 1           | `@aio/schema`, renderer builder/library, docs |
| 12a  | Category order wires every group               | 10, 11, 12b | desktop renderer (workbench)                  |
| 13   | Phase B e2e                                    | 9, 12a      | desktop e2e                                   |
| 14   | Final verification                             | 13          | all                                           |

**Parallel batches** (tasks in a batch share no files; dispatch each batch in one message):

1. **Batch 1:** Task 0, Task 1.
2. **Batch 2:** Task 2, Task 3, Task 4, Task 5.
3. **Batch 3:** Task 6a, Task 7, Task 12b.
4. **Batch 4:** Task 6b, Task 10, Task 11.
5. **Batch 5:** Task 8.
6. **Batch 6:** Task 9 (Phase A e2e; Phase A is a mergeable point if the session wants to land Antennas on its own), Task 12a (Task 13 reruns the Phase A specs on top of it).
7. **Batch 7:** Task 13.
8. **Batch 8:** Task 14.

Shared files and who owns them: `en.ts` only Task 0; `contract-changes.md` Task 1 then 12b (different batches); `MeasureBench.tsx` Task 5 then 10; `rfStore.ts` Task 4 then 11; `tabsModel.ts` Task 5 then 8; `AntennaRunner.tsx` Task 6b then 8; `AntennaRow.tsx` Task 6a then 8; `groupRegistry.ts` Task 5, 6a, then only 12a. Heavy runs (`pnpm check`, Playwright, pytest) go through the shared lock runner, one at a time, even inside a batch.

**Critical path:** Task 0 → Task 5 → Task 6a → Task 6b → Task 8 → Task 9 → Task 13 → Task 14 (Task 1 → Task 4 runs alongside Task 0 → Task 5 and joins at Task 6a).

---

## Phase A: Antennas

### Task 0: All new strings

**Files:**

- Modify: `packages/ui/src/i18n/en.ts` (near `wb.tab.*` at ~4712 and `telecom.antennas.*` at ~4804)
- Test: `packages/ui/src/i18n/i18n.test.ts` (existing; must stay green)

**Interfaces:**

- Produces: the `MessageKey`s below; later tasks only read them. Reuse existing `telecom.antennas.card.*` keys (`size`, `altitude`, `points`, `redraw`, `more`, `kind.*`), `telecom.antennas.accept`, `telecom.antennas.reject`, `telecom.antennas.filter.*`, `telecom.antennas.typed.*`.

- [ ] **Step 1: Change and add the keys** (follow the file's `{name}` interpolation and plural pattern)

| Key                                                                                                                                          | English                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wb.tab.measure` (change)                                                                                                                    | Project                                                                                                                                           |
| `project.caption`                                                                                                                            | In this project                                                                                                                                   |
| `project.caption.fold` / `project.caption.unfold`                                                                                            | Fold the project list / Show the project list                                                                                                     |
| `project.tools`                                                                                                                              | Tools                                                                                                                                             |
| `project.group.antennas` / `.sectors` / `.coverage` / `.measurements` / `.issues`                                                            | Antennas / Sectors / Coverage plan / Measurements / Issues                                                                                        |
| `project.antennas.noCloud`                                                                                                                   | Add a point cloud, then run Detect antennas under Tools, Telecom.                                                                                 |
| `project.antennas.none`                                                                                                                      | No antennas yet. Run Detect antennas under Tools, Telecom.                                                                                        |
| `project.antennas.col.id` / `.kind` / `.az` / `.tilt` / `.height` / `.status`                                                                | ID / Kind / Az ° / Tilt ° / H m / Status                                                                                                          |
| `project.antennas.tick`                                                                                                                      | Select {name}                                                                                                                                     |
| `project.antennas.deleteRow`                                                                                                                 | Delete {name}                                                                                                                                     |
| `project.antennas.bulk.count`                                                                                                                | {count} selected                                                                                                                                  |
| `project.antennas.bulk.clear`                                                                                                                | Clear the selection                                                                                                                               |
| `project.antennas.confirm.titleOne` / `.titleMany`                                                                                           | Delete {name}? / Delete {count} antennas?                                                                                                         |
| `project.antennas.confirm.body`                                                                                                              | They are removed from the inventory with their photo crops. A deleted detection is not added again by a later run. Reject keeps a record instead. |
| `project.antennas.confirm.sector`                                                                                                            | {name} is in sector {sector}; it will be removed from it.                                                                                         |
| `project.antennas.confirm.planUnsaved`                                                                                                       | The coverage plan has unsaved changes. Save it in Coverage to keep this removal.                                                                  |
| `project.antennas.confirm.yesOne` / `.yesMany`                                                                                               | Delete / Delete {count}                                                                                                                           |
| `project.antennas.deleteFailed`                                                                                                              | The antennas were not deleted: {reason}                                                                                                           |
| `project.sectors.none`                                                                                                                       | Plan sectors in Coverage.                                                                                                                         |
| `project.sectors.antennas`                                                                                                                   | {count} antennas                                                                                                                                  |
| `project.sectors.rename` / `.flyTo` / `.openCoverage`                                                                                        | Rename / Fly to / Open in Coverage                                                                                                                |
| `project.coverage.notPlanned` / `.lastRun` / `.open`                                                                                         | not planned / last run {date} / Open Coverage                                                                                                     |
| `project.measurements.none`                                                                                                                  | No measurements yet. Draw one with the tools below.                                                                                               |
| `project.issues.none` / `.open`                                                                                                              | No issues yet. / Open                                                                                                                             |
| `actions.antenna.editAzimuth` / `.editDowntilt` / `.accept` / `.reject` / `.redraw` / `.flyTo` / `.delete` / `.hide` / `.show` / `.soloKind` | Edit azimuth / Edit downtilt / Accept / Reject / Redraw outline / Fly to / Delete / Hide / Show / Show only this kind                             |
| `actions.header.antennas`                                                                                                                    | {count} antennas                                                                                                                                  |

- [ ] **Step 2: Run** `pnpm vitest run packages/ui/src/i18n` and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 3: Commit** `feat(ui): strings for the project list and antenna delete`

### Task 1: Deletion sidecar and delete IPC contract

**Files:**

- Modify: `packages/schema/src/antennas.ts` (after `AntennasFile`, ~line 262)
- Modify: `packages/schema/src/ipc.ts` (after `'telecom:writeAntennas'`, ~line 2448)
- Create: `packages/schema/src/__fixtures__/antenna-deletions-contract.json` (`{ "schema": "aio.antenna-deletions/1", "matchRadiusM": 0.3, "example": { ...one detected deletion with captureId } }`)
- Modify: `docs/architecture/contract-changes.md` (new row, 2026-10-24)
- Test: `packages/schema/src/antennas.test.ts`

**Interfaces:**

- Produces: `ANTENNA_DELETIONS_SCHEMA`, `ANTENNA_DELETIONS_FILE`, `TELECOM_DELETE_MIN_PACK`, `TELECOM_DELETE_FEATURE`, `AntennaDeletion`, `AntennaDeletionsFile` (exact shapes in "Decisions" above), exported from `@aio/schema`.
- Produces IPC `'telecom:deleteAntennas'`: request `{ projectId: ProjectId, ids: z.array(AntennaId).min(1).max(500) }` strict; response `{ ok: true, deleted: AntennaId[], file: AntennasFile }` or `Failure` (with `code: 'read-only'` for a package, as `writeAntennas`).

- [ ] **Step 1: Write the failing tests** in `antennas.test.ts`:
  - `it('parses the deletions contract example')`: `AntennaDeletionsFile.parse(fixture.example)` succeeds; `fixture.schema === ANTENNA_DELETIONS_SCHEMA`.
  - `it('refuses an unknown key on a deletion')`: adding `extra: 1` fails.
  - `it('keeps antennas.json strict, so the record cannot live there')`: `AntennasFile.safeParse({...example, deletions: []}).success === false` (documents why it is a sidecar).
  - `it('caps deletions at 2000')`.
  - `it('delete pack is after the flag pack')`: `compareVersions(TELECOM_DELETE_MIN_PACK, TELECOM_FLAG_MIN_PACK) > 0` (use the helper the existing pack test uses).
- [ ] **Step 2: Run** `pnpm vitest run packages/schema/src/antennas.test.ts`. Expected: FAIL (exports missing).
- [ ] **Step 3: Add the schema, constants, IPC entry and fixture.** Docstring on the IPC: sidecar first, then the inventory, then crops; refused for packages and when either file is newer.
- [ ] **Step 4: Add the contract row**: `AntennaDeletionsFile` (`aio.antenna-deletions/1`, `telecom/antenna-deletions.json`, new sidecar, additive; older builds never read it) and IPC `telecom:deleteAntennas`; why: a deleted detection must stay gone (founder, 24 Oct), and `antennas.json` is strict in older builds; streams: telecom, pipeline pack 0.25.0; approved by: founder (design 24 Oct).
- [ ] **Step 5: Run** the test file and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(schema): antenna deletions sidecar and delete IPC`

### Task 2: Python merge honours deletions; pack 0.25.0

**Files:**

- Modify: `python/src/aio_pipelines/telecom/merge.py` (`merge_with_sources`, `merge_runs`, module docstring)
- Modify: `python/src/aio_pipelines/telecom/pipeline.py` (photos step ~354, commit step ~386, new `_read_deletions`, `_deletions_in_run_frame` next to `_in_run_frame` ~473)
- Modify: `python/pyproject.toml` (`version = "0.25.0"`), `python/src/aio_pipelines/__init__.py` (comment: pack 0.25.0 reads `telecom/antenna-deletions.json`; keeps the floor), `python/uv.lock` (`uv lock`)
- Test: `python/tests/test_telecom_merge.py`, `python/tests/test_telecom_pipeline.py`

**Interfaces:**

- Consumes: the record shape and fixture from Task 1.
- Produces: `merge_with_sources(previous: dict | None, units: list[dict], run_id: str, deletions: Sequence[dict] = ()) -> list[tuple[dict, int | None]]`; `merge_runs(..., deletions=())` same; `DELETIONS_SCHEMA = "aio.antenna-deletions/1"`, `DELETIONS_FILE = "telecom/antenna-deletions.json"` in `pipeline.py`; `_read_deletions(project: Path) -> list[dict]` (missing file: `[]`; unreadable or wrong schema: `JobError` naming the file, as `_read_previous`; entries without `box.centre` skipped).

- [ ] **Step 1: Write the failing merge tests**:
  - `test_merge_drops_a_new_find_at_a_deleted_spot`: previous none, one new unit at (0,0,10), deletion box centre (0.1,0,10) → merged is empty.
  - `test_merge_deleted_spot_matches_any_kind`: deletion kind `dish`, find kind `panel` → dropped.
  - `test_merge_find_beyond_the_radius_is_new`: find 0.31 m away → kept as draft `A1`.
  - `test_merge_old_unit_wins_over_a_deletion`: an accepted old unit and a deletion both at the find → the old unit absorbs it, result has one unit with the old id.
  - `test_merge_without_deletions_is_unchanged`: same output as `merge_runs(previous, units, run)` before the change for the existing accepted/draft fixture.
  - `test_contract_deletions_schema`: fixture `schema` equals `DELETIONS_SCHEMA`, `matchRadiusM == MATCH_RADIUS_M`.
- [ ] **Step 2: Write the failing pipeline tests** (existing `monopole` fixture):
  - `test_rerun_does_not_bring_back_a_deleted_detection`: run, remove unit `u` from `antennas.json` and write the sidecar with `u`'s box; re-run; no unit centre within 0.3 m of `u`'s, unit count is one less than the first run.
  - `test_deletions_from_another_date_move_into_the_run_frame`: as `test_rerun_on_another_date_moves_the_inventory_into_its_frame`, with the record's `captureId` the first date → still dropped.
  - `test_unreadable_deletions_fail_the_job`: sidecar `{` → `JobError` mentioning `antenna-deletions.json`.
- [ ] **Step 3: Run** from the worktree's `python/` with the main checkout's venv and the worktree on the path: `$env:PYTHONPATH = "$PWD\src"; & "E:\Dev\AIO Software\python\.venv\Scripts\python.exe" -c "import aio_pipelines; print(aio_pipelines.__file__)"` must print the worktree path; then `... -m pytest tests/test_telecom_merge.py tests/test_telecom_pipeline.py -q`. Expected: the new tests FAIL.
- [ ] **Step 4: Implement.** In `merge_with_sources` filter `fresh` with `not any(_distance(units[i], d) <= MATCH_RADIUS_M for d in deletions)`; leave old-unit handling untouched. `_deletions_in_run_frame(manifest, deletions, crown)` moves each record's centre by `date_frame_delta(capture_shift(manifest, rec.captureId) or zero, capture_shift(manifest, now) or zero)`. Both the photos and the commit steps pass the framed deletions. Docstring: a new bullet for deletions.
- [ ] **Step 5: Bump the pack** to 0.25.0 (pyproject, `__init__` comment, `uv lock` with the main venv's uv; do not re-point the shared editable install).
- [ ] **Step 6: Run** the two test files, then `ruff format` and `ruff check` on the changed files. Expected: PASS.
- [ ] **Step 7: Commit** `feat(python): deleted antennas stay gone across re-runs; pack 0.25.0`

### Task 3: Main: delete IPC, journal, pack gate

**Files:**

- Modify: `apps/desktop/src/main/telecom.ts` (new `deleteAntennas`, register in `registerTelecomIpc`)
- Modify: `apps/desktop/src/main/journal.ts` (entry beside `'telecom:writeAntennas'` ~228)
- Modify: `apps/desktop/src/preload/index.ts` (allow `'telecom:deleteAntennas'` ~188)
- Modify: `apps/desktop/src/main/telecomPack.ts` (`readAntennaDeletions`, `antennaPackRefusal` gains the deletions argument), `apps/desktop/src/main/index.ts` (~1658 passes it)
- Test: `apps/desktop/src/main/telecom.test.ts`, `apps/desktop/src/main/telecomPack.test.ts`

**Interfaces:**

- Consumes: Task 1 schema and IPC types.
- Produces: `deleteAntennas(projects: SurveyProjects, projectId: string, ids: readonly string[], now?: () => string): Promise<IpcResponse<'telecom:deleteAntennas'>>`; `readAntennaDeletions(pipeline: string, project: string | undefined): Promise<boolean | 'unreadable'>` (true when the sidecar holds at least one record); `antennaPackRefusal(pipeline, packVersion, inventory?, deletions?: boolean | 'unreadable')`.

- [ ] **Step 1: Write the failing tests** in `telecom.test.ts`:
  - `it('deletes a detected unit, records it and removes its crop')`: sample file, crop file present → response `deleted: [id]`; `antennas.json` lacks it; sidecar has one record with the unit's `box`, `name`, `kind`, the run's `captureId`; crop gone; `.bak` written.
  - `it('deletes a flagged unit without a record')`: no sidecar created.
  - `it('appends to an existing sidecar and never duplicates a unit id')`.
  - `it('ignores unknown ids and writes nothing when none is known')`.
  - `it('refuses a package')` (`code: 'read-only'`), `it('refuses when the sidecar is newer or unreadable, changing nothing')`.
  - `it('writes the sidecar before the inventory')`: a failing inventory write leaves the sidecar written and the unit still in the file (the merge then still pairs the existing unit first).
- [ ] **Step 2: Write the failing gate tests** in `telecomPack.test.ts`: `it('refuses a re-detect below 0.25.0 when deletions exist')` with message naming `TELECOM_DELETE_FEATURE` and `0.25.0`; `it('allows 0.25.0 with deletions')`; `it('ignores an empty sidecar')`; `it('refuses below 0.25.0 when the sidecar is unreadable')`; `telecom.flag` unaffected.
- [ ] **Step 3: Run** `pnpm vitest run apps/desktop/src/main/telecom.test.ts apps/desktop/src/main/telecomPack.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** with `readJsonSeen` / `writeJsonSeen({ backup: true })`, `newerOnDisk` for both files, crop removal only for `SAFE_UNIT_ID` paths under `ANTENNA_CROPS_DIR` (ENOENT ignored). Journal: one `record.external` op per delete, as `writeAntennas`.
- [ ] **Step 5: Run** the tests and any IPC parity test that lists every channel (`pnpm vitest run apps/desktop/src/main apps/desktop/src/preload`). Expected: PASS.
- [ ] **Step 6: Commit** `feat(desktop): delete antennas in main with a stays-gone record`

### Task 4: Renderer delete flow and RF sector removal

**Files:**

- Modify: `apps/desktop/src/renderer/telecom/antennaStore.ts` (replace `deleteFlaggedUnit` with `deleteUnits`; add `ticked`, `flyRequest`)
- Create: `apps/desktop/src/renderer/telecom/antennaDelete.ts`, `apps/desktop/src/renderer/telecom/AntennaDeleteDialog.tsx`
- Modify: `apps/desktop/src/renderer/rf/rfStore.ts` (new `removeAntennasFromPlan`)
- Test: `telecom/antennaStore.test.ts`, `telecom/antennaDelete.test.ts` (new), `telecom/AntennaDeleteDialog.test.tsx` (new), `rf/rfStore.test.ts`

**Interfaces:**

- Consumes: IPC `telecom:deleteAntennas` (Task 1); `removeOrphan` from `@aio/rf` (via `removeOrphanEntry`).
- Produces (antennaStore): `deleteUnits(ids: readonly string[]): Promise<{ ok: true } | { ok: false; error: string }>` (queued like `change`; on success sets `file` from the response, bumps `loadSeq`, drops the ids from `selected`, `hidden`, `ticked`); state `ticked: Record<string, true>` with `toggleTicked(id: string): void`, `clearTicked(): void`; state `flyRequest: { ids: string[]; seq: number } | null` with `requestFly(ids: readonly string[]): void`.
- Produces (antennaDelete): `sectorsHolding(ids: readonly string[]): { unitId: string; unitName: string; sector: string }[]` (from `rfStore` when it holds the open project and `hasFile`); `askDeleteAntennas(ids: readonly string[]): void`; `cancelDeleteAntennas(): void`; `confirmDeleteAntennas(): Promise<void>` (calls `deleteUnits`, then `removeAntennasFromPlan`, clears the ask; a failure shows `project.antennas.deleteFailed`); store `useAntennaDelete` with `{ ask: { ids: string[]; names: string[]; sectors: ReturnType<typeof sectorsHolding>; planUnsaved: boolean } | null; busy: boolean }`.
- Produces (rfStore): `removeAntennasFromPlan(ids: readonly string[]): Promise<void>`: no file or read-only: nothing; not dirty: `removeOrphanEntry` each id then `saveRf()`; dirty: `removeOrphanEntry` each id in the working copy only (stays dirty, no save).
- Produces: `<AntennaDeleteDialog />` (no props; renders `ConfirmDialog` from `shell/ConfirmDialog.tsx`, `danger`, `testId="antenna-delete-confirm"`, copy from Task 0).

- [ ] **Step 1: Write the failing tests**:
  - antennaStore: `it('deletes detected and flagged units through one IPC call')`, `it('drops deleted ids from selected, hidden and ticked')`, `it('runs after a pending review write')` (queue order), `it('keeps the file and reports the error on a refusal')`, `it('does nothing read-only')`.
  - antennaDelete: `it('asks once, naming one unit')` (`names: ['P2']`), `it('names the sector holding a unit')`, `it('flags planUnsaved when the RF copy is dirty')`, `it('confirm deletes then removes from the plan')` (call order `telecom:deleteAntennas` then `rf:writeSectors`), `it('cancel changes nothing')`.
  - rfStore: `it('removes a deleted antenna from a saved plan and saves')`, `it('removes it from a dirty plan without saving')` (Review Focus 3), `it('a sector left empty by the removal goes, as removeOrphan does')`.
  - Dialog: renders the title `Delete P2?`, the sector line, `Delete` button; Escape cancels; the button is disabled while `busy`.
- [ ] **Step 2: Run** `pnpm vitest run apps/desktop/src/renderer/telecom apps/desktop/src/renderer/rf/rfStore.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Keep `deleteFlaggedUnit` callers compiling by switching them to `askDeleteAntennas([id])` (the card until Task 6b).
- [ ] **Step 4: Run** the tests and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(telecom): delete any antenna with one confirmation, out of its RF sector too`

### Task 5: Project tab shell and list skeleton

**Files:**

- Modify: `apps/desktop/src/renderer/workspace/workbench/tabsModel.ts` (`FIXED_ORDER`, `overflowOrderFor`)
- Modify: `apps/desktop/src/renderer/workspace/workbench/workbenchStore.ts` (`FIXED`)
- Modify: `apps/desktop/src/renderer/workspace/workbench/Section.tsx`, `section.css` (optional `actions` slot)
- Modify: `apps/desktop/src/renderer/workspace/workbench/benches/MeasureBench.tsx` (layout; drop `AntennaSection` and its search clause)
- Modify: `apps/desktop/src/renderer/workspace/island/islandBench.ts` (`openBenchFromIsland` asks for the tools scroll for `measure`)
- Create: `project/projectListStore.ts`, `project/groupRegistry.ts`, `project/ProjectList.tsx`, `project/useRevealRow.ts`, `project/rowList.css`
- Test: `tabsModel.test.ts`, `workbenchStore.test.ts`, `Section.test.tsx`, `benches/MeasureBench.test.tsx`, `island/islandModel.test.ts` or a new `island/islandBench.test.ts`, `project/ProjectList.test.tsx`, `project/projectListStore.test.ts`, `project/useRevealRow.test.tsx`, `RightSidebar.test.tsx`

**Interfaces:**

- Produces (Section): `SectionProps.actions?: ReactNode`, rendered in `.wb-section-actions` beside (not inside) the head button; `SectionProps.testId?: string` overrides `wb-section-${id}`.
- Produces (projectListStore): `revealInList(group: GroupId, id: string | null): void` and state `reveal: { group: GroupId; id: string | null; seq: number } | null`; `requestToolsScroll(): void` and state `toolsSeq: number`. `GroupId` is exported from `project/projectGroups.ts` in this task as `'antennas' | 'sectors' | 'coverage' | 'measurements' | 'issues' | 'stockpiles' | 'changes' | 'photos'` (the rest of that file comes in Task 12a).
- Produces (groupRegistry): `interface ProjectGroupDef { id: GroupId; title: MessageKey; useCount(): number; useApplies(): boolean; Body: ComponentType; Actions?: ComponentType }`; `export const PROJECT_GROUPS: readonly ProjectGroupDef[]` (empty here; Task 6a adds Antennas, Task 12a the rest); `useOrderedGroups(): ProjectGroupDef[]` (here: registered groups whose `useApplies()` is true, registry order; Task 12a replaces the order).
- Produces (ProjectList): `<ProjectList />`: caption button `data-testid="project-caption"` (`aria-expanded`, toggles section id `project-contents` of bench `measure`), each group as `<Section bench="measure" id={`project-${def.id}`} title count actions>`; then `<h3 data-testid="project-tools-caption">`.
- Produces (useRevealRow): `useRevealRow(group: GroupId, selected: string | null): { host: RefObject<HTMLDivElement>; forceOpen: true | undefined; release(e: MouseEvent): void }` with today's `AntennaSection` hold semantics (hold while the revealed id stays selected; a reveal with id null holds until the next; a header click ends the hold and folds) and the scroll target `[data-row-id="<id>"]` inside the group's `.pl-rows` scroller (scroll the inner list by its own `scrollTop`, then the bench, never `scrollIntoViewIfNeeded`).
- Order inside `MeasureBench` (not live): PendingCard, `<ProjectList />`, TOOLS caption, SavedFooter (hidden while searching, as today), Catalogue, SelectedCard. Live: LiveCard, `<ProjectList />`, TOOLS caption, SavedFooter, Strip.

- [ ] **Step 1: Write the failing tests**:
  - tabsModel: `it('keeps the Project tab first among the fixed tabs')`: `orderTabs` of fixed tabs gives `['measure','selection','issues', ...]`; `it('never drops Project before a panel')` (overflow group as Selection).
  - workbenchStore: `it('always has the Project tab')` after `reset()`; `it('ignores a remembered pin of measure')` (storage `{"pinned":["measure","rf"]}` → `rf` pinned, `measure` fixed, not duplicated); `it('keeps Project in front after the tool that made it live stops')` (Review Focus 4); `close('measure')` is a no-op.
  - Section: `it('renders actions outside the toggle button')` (clicking an action does not toggle).
  - ProjectList: `it('shows the caption and the TOOLS caption')`; `it('folds the whole list from the caption and remembers it')` (sectionStore `byBench.measure.ids['project-contents'] === false`); `it('shows a registered group with count 0')`.
  - MeasureBench: `it('puts the project list above the tools and the live card above the list')`; `it('has no Antenna inventory section among the tools')`; existing search tests stay green.
  - projectListStore / islandBench: `it('the island Measure group asks for the tools scroll')`; MeasureBench `it('scrolls the TOOLS caption to the top on a tools-scroll request')` (scroller `scrollTop` equals the caption's offset).
  - useRevealRow: port `AntennaSection`'s hold and scroll cases from `AntennaBench.test.tsx` / the section tests to the generic hook.
  - RightSidebar: the tab is labelled `Project`; `FrontBody` for `measure` still renders `BenchHead` and the bench.
- [ ] **Step 2: Run** `pnpm vitest run apps/desktop/src/renderer/workspace`. Expected: FAIL.
- [ ] **Step 3: Implement.** CSS: `.pl-rows { max-height: calc(8 * var(--pl-row-h)); overflow-y: auto; }` with `--pl-row-h` the row height chosen in `rowList.css` (match today's `Row kind="tree"` height); captions use the bench's existing caption style (`meb` faint uppercase, as "IN THIS PROJECT" in the mock).
- [ ] **Step 4: Run** the tests, `pnpm lint` and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(workspace): the Measure tab becomes Project with an In this project list above the tools`

### Task 6a: Antennas group: rows, inline details, bulk bar

**Files:**

- Create: `telecom/AntennasGroup.tsx`, `telecom/AntennaRow.tsx`, `telecom/AntennaDetails.tsx`, `telecom/AntennaBulkBar.tsx`
- Modify: `telecom/AntennaInventory.tsx` (flat rows in `filteredUnits` order with the column header; filter chips and note as today; group-by-kind headers and per-row eye go), `telecom/AntennaTypedValues.tsx` (export `TypedField` as `AntennaTypedField` with a `compact` prop for row cells), `telecom/AntennaCard.tsx` (import `PhotoStrip`, `Values`, kind pick from `AntennaDetails`), `project/groupRegistry.ts` (register `antennas`)
- Delete: `telecom/AntennaSection.tsx` (its tests move to `AntennasGroup.test.tsx`)
- Test: `telecom/AntennasGroup.test.tsx`, `telecom/AntennaRow.test.tsx`, `telecom/AntennaDetails.test.tsx`, `telecom/AntennaInventory.test.tsx`, `telecom/AntennaTypedValues.test.tsx`, `telecom/AntennaBench.test.tsx`

**Interfaces:**

- Consumes: Task 4 (`askDeleteAntennas`, `ticked`, `toggleTicked`, `clearTicked`, `decideAntenna`, `stepAntenna`), Task 5 (`Section.actions`, `ProjectGroupDef`, `useRevealRow('antennas', selected)`).
- Produces: `antennasGroup: ProjectGroupDef` (`useCount` = units not rejected, as today's `listed`; `useApplies` = today's `AntennaSection` show rule: a project, a cloud and an inventory or a run); `AntennaRow` props `{ unit: AntennaUnit; selected: boolean; ticked: boolean; readOnly: boolean; north: North; onSelect(id): void; onTick(id): void; onContextMenu?(e: MouseEvent, id: string): void }` with `data-row-id={unit.id}`, `role="treeitem"`, `aria-selected`, `data-testid="antenna-row"`; az and tilt cells are `AntennaTypedField compact` (`data-testid="antenna-row-az"`, `"antenna-row-tilt"`; tilt shows "—" for a dish); trash `data-testid="antenna-row-delete"` calls `askDeleteAntennas([id])`; `AntennaDetails` props `{ unit: AntennaUnit; readOnly: boolean; position: number; count: number }` rendered under the selected row (`data-testid="antenna-details"`), holding: prev/next (`antenna-details-prev`/`-next`, `{i} / {n}`), kind pick, photo strip, values grid (Azimuth, Downtilt, Plumb, Altitude, W x H x D, points), `AntennaTypedValues` ("Your values" fold), "Model, weight, frequencies" fold, Accept (A) / Reject (R) / Redraw outline / Delete (`antenna-details-accept`, `-reject`, `-redraw`, `-delete`); `AntennaBulkBar` (`data-testid="antenna-bulk"`) shows when any row is ticked: "{count} selected · Accept · Reject · Delete · ✕".
- Group header actions (`Actions`): eye toggling Hide all / Show all (`antenna-hide-all` / `antenna-show-all` test ids kept), Flag antenna (`antenna-flag` kept). Warnings, the AI note and `AntennaFlagTool` keep their place above the rows.

- [ ] **Step 1: Write the failing tests**:
  - Row: `it('saves a typed azimuth on Enter and blur, Esc reverts')` (calls `setTypedValue(id, 'azimuthGridDeg', grid value)` once; true-to-grid conversion as `AntennaTypedValues`); `it('shows the status chip with a dot')`; `it('trash asks to delete this unit')`; `it('ticking does not select')`.
  - Details: `it('opens under the selected row only')`; `it('Accept and Reject decide the unit')`; `it('Delete asks to delete, detected units too')`; `it('prev and next step the selection')`; photo strip and folds render as the card did (port the relevant `AntennaCard.test.tsx` cases: values, kind pick, folds).
  - Bulk: `it('accepts every ticked unit')`, `it('deletes every ticked unit with one ask')` (`ask.ids` length 2), `it('clears with the cross')`.
  - Group: `it('lists rejected units under the Rejected chip')`, `it('scrolls inside itself beyond 8 rows')` (`.pl-rows` has the max-height class), the hold and reveal cases ported from the old section tests, `it('header eye hides and shows all')`, `it('Flag antenna is in the header and disabled with its reason while detection runs')`.
- [ ] **Step 2: Run** `pnpm vitest run apps/desktop/src/renderer/telecom`. Expected: FAIL.
- [ ] **Step 3: Implement** (move code out of `AntennaCard.tsx`, do not copy it).
- [ ] **Step 4: Run** the tests, lint, typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat(telecom): Antennas group with editable rows, inline details and a bulk bar`

### Task 7: `antenna` menu target, actions, AntennaMenu

**Files:**

- Modify: `packages/ui/src/actions/types.ts` (`MenuTarget` gains `{ kind: 'antennas'; ids: string[]; clicked: string }`), `packages/ui/src/actions/registry.ts` (`targetCount` counts `ids`)
- Create: `apps/desktop/src/renderer/shell/actions/antennaActions.tsx`, `apps/desktop/src/renderer/telecom/AntennaMenu.tsx`
- Modify: `apps/desktop/src/renderer/shell/actions/index.ts` (`registerAntennaActions()`)
- Test: `packages/ui/src/actions/registry.test.ts`, `shell/actions/antennaActions.test.ts` (new), `telecom/AntennaMenu.test.tsx` (new), `shell/actions/parity.test.ts` stays green

**Interfaces:**

- Consumes: antennaStore (`decideAntenna` semantics per id via `setUnitStatus`, `beginFlag`, `requestFly`, `toggleAntennaHidden`, `setAntennaSolo`), `askDeleteAntennas` (Task 4), `projectListStore.revealInList` (Task 5).
- Produces actions (ids, section): `antenna.editAzimuth` (edit), `antenna.editDowntilt` (edit; not for a dish), `antenna.accept`, `antenna.reject` (edit, `multi`), `antenna.redraw` (edit; one unit, disabled with the store's busy reasons), `antenna.flyTo` (view, `multi`), `antenna.hide` / `antenna.show` (view, `multi`), `antenna.soloKind` (view), `antenna.delete` (danger, `multi`). Edit actions are disabled with `telecom.antennas.readOnly` for a read-only inventory. Edit azimuth/downtilt select the unit, `revealInList('antennas', id)` and set `focusField: { id; key: 'azimuthGridDeg' | 'downtiltDeg'; seq }` on antennaStore, which `AntennaRow` focuses (state added here, read in Task 8).
- Produces: `<AntennaMenu at={{ x: number; y: number; id: string; projectId: string } | null} onClose={() => void} />` (as `MeasureMenu`; acts on the ticked ids when the clicked one is ticked; `testId="antenna-menu"`; title is the unit name or `actions.header.antennas`).

- [ ] **Step 1: Write the failing tests**: `targetCount({kind:'antennas', ids:['a','b'], clicked:'a'}) === 2`; `actionsFor` on one detected unit lists the ten ids in section order; on two ticked units only the `multi` ones; `antenna.delete` run calls `askDeleteAntennas(['a','b'])`; `antenna.editAzimuth` sets `focusField` and reveals; read-only disables edit ones; `AntennaMenu` renders `antenna-menu` with the unit name.
- [ ] **Step 2: Run** `pnpm vitest run packages/ui/src/actions apps/desktop/src/renderer/shell/actions apps/desktop/src/renderer/telecom/AntennaMenu.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** tests, typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat(actions): right-click actions for antennas`

### Task 6b: Retire the floating card; keys; dialog mount

**Files:**

- Modify: `telecom/AntennaRunner.tsx` (drop the card, its rect and avoid logic; mount `<AntennaDeleteDialog />`; call `useAntennaKeys(selected !== null)`; fly on `flyRequest` with `flyToLocalBox` over the union of the units' corners)
- Modify: `telecom/useAntennaKeys.ts` (docs; `Delete` asks to delete the selected unit; Escape still clears; skips when focus is in `[role="tree"]` of the Datasets tree or a typing target)
- Modify: `rf/StageCoverageLegend.tsx` (remove the antenna-card watch), `telecom/AntennaLabelsControl.tsx` (drop the card selector note)
- Delete: `telecom/AntennaCard.tsx`, `telecom/AntennaCard.test.tsx`, `telecom/cardPlacement.ts`, `telecom/cardPlacement.test.ts`
- Test: `telecom/AntennaRunner.test.tsx`, `telecom/useAntennaKeys.test.ts` (new or existing), `rf/StageCoverageLegend.test.tsx`, `workspace/Stage.overlays.test.tsx` (the "beside a selected antenna's card" block becomes "the legend stays put when an antenna is selected")

**Interfaces:**

- Consumes: Task 4 (`AntennaDeleteDialog`, `askDeleteAntennas`, `flyRequest`), Task 6a (details hold everything the card did).

- [ ] **Step 1: Write the failing tests**: `it('draws no floating card when a unit is selected')` (no `[data-testid="antenna-card"]`); `it('Delete asks to delete the selected unit')`; `it('Delete in the Datasets tree is left to the tree')` (Review Focus 1); `it('Delete in a field is typing')`; `it('flies to every unit of a fly request')`; legend tests without the card.
- [ ] **Step 2: Run** `pnpm vitest run apps/desktop/src/renderer/telecom apps/desktop/src/renderer/rf apps/desktop/src/renderer/workspace/Stage.overlays.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement**; `rg "AntennaCard|cardPlacement|antenna-card" apps/desktop/src` returns nothing but e2e (Task 9 updates those).
- [ ] **Step 4: Run** tests, lint, typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `refactor(telecom): retire the floating antenna card; its controls live in the list`

### Task 8: Right-click wiring and pick-follow

**Files:**

- Modify: `telecom/antennaScene.ts` (`attachAntennaLayer` opts gain `onMenu(m: { x: number; y: number; id: string }): void`: a right press and release that barely moved over a box, not claimed (`isClaimed` / `claimEvent` from `builder/droneHits.ts`), as `measurePick.attachRightClick`)
- Modify: `telecom/AntennaRunner.tsx` (menu state, `<AntennaMenu>`; pick calls `followAntennaPick(id)`), `telecom/AntennaRow.tsx` (`onContextMenu` opens the same menu; reads `focusField`)
- Modify: `workspace/workbench/tabsModel.ts` (new `toolInFront(state: Pick<TabsState, 'tabs' | 'front' | 'issueEditing'>): boolean`)
- Create: `workspace/workbench/project/antennaFollow.ts`
- Test: `telecom/antennaScene.test.ts`, `telecom/AntennaRunner.test.tsx`, `tabsModel.test.ts`, `project/antennaFollow.test.ts`

**Interfaces:**

- Produces: `toolInFront(...)` true when the front tab is live, or is `rf`, `thermal` or `jobs`, or an issue is edited. `followAntennaPick(id: string, bench = workbench): void`: `revealAntenna(id)`; if the unit is hidden by the filter, `setAntennaFilter('all')`; `revealInList('antennas', id)`; unless `toolInFront`, `showBench('measure')`.

- [ ] **Step 1: Write the failing tests**: `toolInFront` cases (rf front → true; selection front → false; issue editing → true; a live measure tab → true); `followAntennaPick` with Coverage in front leaves the front and still reveals (Review Focus 2); with Selection in front shows Project, sets filter All for a rejected unit under To review; scene: a right-click over a box calls `onMenu` with the id, a drag does not, a claimed event does not; row right-click opens `antenna-menu`; Edit azimuth from the menu focuses `antenna-row-az`.
- [ ] **Step 2: Run** the four test files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** tests, lint, typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat(telecom): picking an antenna opens its row; right-click on the 3D unit or its row`

### Task 9: Phase A e2e

**Files:**

- Create: `apps/desktop/e2e/project-list-antennas.spec.ts`
- Modify (update, never delete): `telecom-antennas.spec.ts` (14 `antenna-card` uses → `antenna-details-*`, `antenna-row-*`), `telecom-antenna-flag.spec.ts`, `rf-coverage.spec.ts` (test "the coverage card and the antenna card share the stage" becomes "the coverage card stays while an antenna's details open in the list", both sizes), `rf-autoplan.spec.ts` ("Review antennas opens Measure" titles and assertions → Project tab, Antennas group, first draft's details), `bench-scroll.spec.ts` (`measure` is the Project tab; the list plus tools still scroll to the end), `workbench.spec.ts` (Show it text "Project"), `small-window.spec.ts` (~615), `island.spec.ts` (sidebar tab assertions; the island's own "Measure" group stays), `e2e/island.ts` helper if it names the sidebar tab, and `panels.spec.ts` (run it; change only if it fails because of this work)
- Shared helpers: `e2e/telecomFixtures.ts` (a helper `projectAntennas(win)` returning the group locator, expanding it)

**Interfaces:**

- Consumes: everything in Phase A. Test ids from Tasks 5 to 8.

- [ ] **Step 1: Write the new spec** (tiny project with a cloud, `telecomFixtures`):
  - `test('finds the antennas in the Project tab and edits an azimuth in its row')`: Project tab is first, IN THIS PROJECT shows Antennas with its count; type 45 in `antenna-row-az`, Enter; reload; value 45.0 kept.
  - `test('deletes a detected antenna once confirmed and a re-run does not bring it back')`: trash on P2 → `antenna-delete-confirm` names P2 → Delete; row gone, crop file gone, `telecom/antenna-deletions.json` has P2; run Detect antennas again (Python via `QUADRION_E2E_PYTHON`); no unit within 0.3 m of P2's centre.
  - `test('a unit in a sector names the sector and leaves it')` (write `rf/sectors.json` with P2 in Alpha first).
  - `test('picking a unit in 3D opens its row with details; Coverage in front is left alone')`.
  - `test('right-click on a unit in 3D and on its row gives the same actions')` (compare item labels of `antenna-menu`).
  - `test('bulk: tick two, Reject')`.
  - `test('the notch Measure group opens Project with TOOLS at the top')`.
- [ ] **Step 2: Update the listed specs.**
- [ ] **Step 3: Build demos and run the CI way**, from `apps/desktop`, PowerShell: `pnpm demo:change --quick`; `pnpm demo:build --quick --python "E:\Dev\AIO Software\python\.venv\Scripts\python.exe"`; `$env:QUADRION_WINDOW_SIZE='1100x720'; $env:QUADRION_E2E_SCALE='1'; $env:QUADRION_E2E_SWGL='warp'; $env:QUADRION_E2E_PYTHON='E:\Dev\AIO Software\python\.venv\Scripts\python.exe'`; then one spec at a time `npx playwright test e2e/<spec>.spec.ts --workers=1` for the new and every changed spec. Expected: the log prints `[e2e] window 1100 x 720 px at display scale 1`; all pass. `--repeat-each=3` on the new spec.
- [ ] **Step 4: Commit** `test(e2e): project list antennas, delete that stays gone, right-click`

## Phase B: other groups, category order, telecom purpose

### Task 10: Measurements and Issues groups

**Files:**

- Create: `project/groups/MeasurementsGroup.tsx`, `project/groups/IssuesGroup.tsx`
- Modify: `benches/MeasureBench.tsx` (`SelectedCard` keeps only its telecom branch), `workspace/workbench/measureFollow.ts` (a picked or revealed measurement also calls `revealInList('measurements', id)`)
- Test: `project/groups/MeasurementsGroup.test.tsx`, `project/groups/IssuesGroup.test.tsx`, `benches/MeasureBench.test.tsx`, `measureFollow.test.ts`

**Interfaces:**

- Consumes: Task 5 (`ProjectGroupDef`, `useRevealRow`, `rowList.css`), measureStore (`select`, `focus`, `selected`, `file`), `sortMeasurements` and `TOOL_LABELS` from `@aio/survey`, `primaryText` from `survey/card/cardModel`, `MeasureMenu` pattern for the row right-click (`actionsFor({ kind: 'measurements', ids, clicked })`).
- Produces: `measurementsGroup: ProjectGroupDef` (rows: label, tool label, primary value; sorted by name; click `select([id], id)`; the focused one shows `<MeasurementPanel />` inline in a wrapper with `data-testid="survey-side"` so `measure-tools`, `materials` and `volumes-general` specs keep their hook; count = measurements in the file; applies always). `issuesGroup: ProjectGroupDef` (rows: code and title, severity label via `severityLabel` from `@aio/annotate`, status; click selects `{ kind: 'issue', id }`, which brings Selection with the Issue card as today; row button "Open" the same; applies always).

- [ ] **Step 1: Write the failing tests**: `it('lists every measurement by name with its value')`; `it('a pick in the left tree selects the same row here')` (shared `measureStore.focus`, Review Focus 4); `it('shows the measurement panel inline under the focused row')`; `it('right-click gives the measurement actions')`; MeasureBench `it('has no Selected card for a survey measurement')` and still shows the telecom reading for a telecom one under search; Issues: `it('lists issues with severity and status')`, `it('opens the issue card in Selection')`; measureFollow `it('reveals a picked measurement in the list')`.
- [ ] **Step 2: Run** the test files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** tests, lint, typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat(workspace): Measurements and Issues groups in the project list`

### Task 11: Sectors and Coverage plan groups

**Files:**

- Create: `project/groups/SectorsGroup.tsx`, `project/groups/CoveragePlanGroup.tsx`
- Modify: `rf/rfStore.ts` (new `renameSavedSector`)
- Test: `project/groups/SectorsGroup.test.tsx`, `project/groups/CoveragePlanGroup.test.tsx`, `rf/rfStore.test.ts`

**Interfaces:**

- Consumes: `rfStore` (`hasFile`, `sectors`, `antennas`, `dirty`, `runs`, `renameSector`, `saveRf`), `sectorBearing` from `rf/rfFields.ts`, `openRfTab` / `openCoverage` from `rf/rfTab.ts`, `requestFly` (Task 4).
- Produces: `renameSavedSector(sectorId: string, name: string): Promise<void>` (rename; save only when the copy was not dirty before). `sectorsGroup: ProjectGroupDef` (rows: name, bearing `sectorBearing(ids, antennas.units)` formatted as degrees or "—", `{count} antennas`; actions Rename (inline field), Fly to (`requestFly(antennaIds)`), Open in Coverage (`openRfTab(antennaIds[0])`); count = saved sectors; zero shows `project.sectors.none`; applies when the project has an antenna inventory or an RF file). `coveragePlanGroup: ProjectGroupDef` (one row: `not planned` without a done run, else `last run {date}`; button Open Coverage; count none; applies as Sectors).

- [ ] **Step 1: Write the failing tests**: `it('lists saved sectors with bearing and antenna count')`; `it('shows 0 and Plan sectors in Coverage before a plan is saved')`; `it('rename saves a clean plan and leaves a dirty one unsaved')`; `it('Fly to asks to fly to the sector antennas')`; `it('Open in Coverage opens the Coverage tab')`; Coverage plan `it('says not planned, then the last run date')`.
- [ ] **Step 2: Run** the test files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** tests, lint, typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat(workspace): Sectors and Coverage plan groups`

### Task 12b: `telecom` project purpose

**Files:**

- Modify: `packages/schema/src/builder.ts` (`ProjectPurpose` gains `'telecom'`; `PURPOSE_TYPE.telecom = 'inspection'`)
- Modify: `apps/desktop/src/renderer/builder/model.ts` (`PROJECT_TYPES` card `{ id: 'telecom', label: 'Telecom towers', hint: 'Antennas on a tower: inventory, azimuths and RF coverage' }` after `vertical-asset`; `kindLabel`; `STARTERS.telecom`), `apps/desktop/src/renderer/library/cover.ts` (`TONE.telecom`)
- Modify: `docs/architecture/contract-changes.md` (row: `ProjectPurpose` and `PURPOSE_TYPE` gain `telecom` → `inspection`; additive, the manifest field is a plain string so older builds open such projects and show what `type` says)
- Test: `packages/schema/src/builder.test.ts`, `apps/desktop/src/renderer/builder/model.test.ts`, `library/cover.test.ts` if present, `NewProjectWizard` test if it counts cards

**Interfaces:**

- Produces: `ProjectPurpose` includes `'telecom'`; `projectPurpose({ purpose: 'telecom' }) === 'telecom'`.

- [ ] **Step 1: Write the failing tests**: `PURPOSE_TYPE.telecom === 'inspection'`; `ProjectManifest` with `purpose: 'telecom'` parses; an older-build simulation (`purpose` unknown string) still parses to `undefined` purpose (unchanged behaviour); wizard cards include Telecom towers; `projectKind({ type: 'inspection', purpose: 'telecom' }) === 'telecom'`.
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement**; fix every `Record<ProjectPurpose | ProjectKind, ...>` the compiler flags.
- [ ] **Step 4: Run** tests and typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat(schema): Telecom towers project purpose`

### Task 12a: Category order wires every group

**Files:**

- Modify: `project/projectGroups.ts` (the pure part), `project/groupRegistry.ts` (register `sectors`, `coverage`, `measurements`, `issues`; `useOrderedGroups` uses the category)
- Test: `project/projectGroups.test.ts`, `project/ProjectList.test.tsx`

**Interfaces:**

- Consumes: `projectPurpose` (`@aio/schema`, with `telecom` from 12b), `useKitVolumes`, `useHasVolumeMeasurements` (`view.ts`), antennaStore `file`, rfStore `hasFile`, every group def.
- Produces:
  - `type Category = 'telecom' | 'survey' | 'construction' | 'vertical-asset' | 'default'`.
  - `CATEGORY_ORDER: Record<Category, readonly { id: GroupId; onlyIfAny?: true }[]>` = telecom: antennas, sectors, coverage, measurements, issues; survey: stockpiles, measurements, issues; construction: changes, measurements, issues, photos; vertical-asset: issues, measurements, photos, antennas (onlyIfAny); default: measurements, issues.
  - `projectCategory(input: { purpose: ProjectPurpose | undefined; hasAntennas: boolean; hasRfPlan: boolean; hasVolumes: boolean }): Category`: purpose `telecom`, `survey`, `construction`, `vertical-asset` map to themselves; another purpose → `default`; no purpose: antennas or RF plan → `telecom`, else volumes → `survey`, else `default`.
  - `orderGroups(category: Category, groups: readonly { id: GroupId; count: number; applies: boolean }[]): GroupId[]`: the category's ids that are registered and apply (an `onlyIfAny` one only with count > 0), then every other registered group with count > 0 in registry order.

- [ ] **Step 1: Write the failing tests**: one test per category row with exact arrays (e.g. telecom with all registered → `['antennas','sectors','coverage','measurements','issues']`); `it('skips groups that are not built yet')` (survey → `['measurements','issues']`); `it('puts a group outside the list at the end once it has items')` (default with 3 antennas → `['measurements','issues','antennas']`); `it('vertical-asset shows Antennas only with antennas')`; `projectCategory` for no purpose with antennas → telecom, with a volume measurement → survey, a purpose wins over contents, an unknown purpose → default; ProjectList renders the groups in that order for a telecom manifest and for a survey one.
- [ ] **Step 2: Run** the test files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** tests, lint, typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat(workspace): the project category orders the project list`

### Task 13: Phase B e2e

**Files:**

- Create: `apps/desktop/e2e/project-list-groups.spec.ts`
- Modify (only if they fail because of this work, update not delete): `measure-tools.spec.ts`, `measure-card.spec.ts`, `materials.spec.ts`, `volumes-general.spec.ts`, `measurement-layers.spec.ts`, `survey-gaps.spec.ts`, any spec that expected the front to return to Selection after a tool stops (`rg "toolStopped|aria-selected', 'true'" e2e` around Measure flows)

- [ ] **Step 1: Write the new spec**:
  - `test('a telecom project lists Antennas, Sectors, Coverage plan, Measurements, Issues in that order')` (manifest `purpose: 'telecom'`).
  - `test('a survey project lists Measurements then Issues, and Antennas appears at the end once detected')`.
  - `test('a measurement picked in the left tree is the selected row in Measurements with its panel inline')`.
  - `test('an issue row opens its card in Selection')`.
  - `test('a saved sector shows its bearing and opens in Coverage')`.
  - `test('the new project wizard offers Telecom towers')`.
- [ ] **Step 2: Run** the new spec and the five most Measure-heavy specs above the CI way (same environment as Task 9, one at a time, `--workers=1`); fix and update the specs that fail.
- [ ] **Step 3: Commit** `test(e2e): project list groups and category order`

### Task 14: Final verification

- [ ] **Step 1:** `pnpm check` from the worktree root. Expected: lint, format, typecheck and every Vitest suite green.
- [ ] **Step 2:** Python, CI way: `$env:PYTHONPATH = "<worktree>\python\src"`; confirm the import path prints the worktree; `& "E:\Dev\AIO Software\python\.venv\Scripts\python.exe" -m pytest tests -q` from `python/`; `ruff format --check` and `ruff check` on `src/aio_pipelines/telecom`. Expected: PASS.
- [ ] **Step 3:** Every added or changed e2e spec once more the CI way (Tasks 9 and 13 list them), demos built first, one run at a time. Expected: PASS, `[e2e] window 1100 x 720 px at display scale 1` in the log.
- [ ] **Step 4:** `rg "AntennaSection|AntennaCard|cardPlacement|deleteFlaggedUnit" apps packages` returns nothing; `docs/architecture/contract-changes.md` has both rows; `node tools/agent/check-public-text.mjs` on the session note and any changed docs.
- [ ] **Step 5:** Write the founder's "How to test" (Project tab first; Antennas group; type an azimuth; delete a detected unit and re-run detection; right-click in 3D; notch Measure opens with TOOLS at the top; a telecom project's group order; the wizard's Telecom towers card; install pipeline pack 0.25.0 via Settings, Processing tools, Choose file before re-running detection).
- [ ] **Step 6: Commit** any last fixes `chore: project list verification fixes`.

---

## Self-review notes

- Spec coverage: layout C1 (Task 5), rename and fixed tab (5), 8-row inner scroll and caption fold (5, 6a), notch opens at TOOLS (5), Antennas rows, chips, header controls, inline details, bulk bar, prev/next (6a), card retired, 3D labels kept (6b keeps `antennaLabels`), delete everywhere with one confirmation, crop removal, sector removal (3, 4, 6a, 6b, 7), stays-gone record and merge (1, 2, 3), pick-follow with tool protection (8), `antenna` target and actions (7, 8), Sectors, Coverage plan, Measurements, Issues (10, 11), category order and content fallback (12a), telecom purpose (12b), e2e updated not deleted (9, 13). Stockpiles, Changes, Photos are named in data only, as the spec allows.
- Deviations to note to the founder: Issues have no inline details (they open the card, to avoid a second editor); per-unit hide and kind solo moved to the right-click menu; the Project tab stays in front after a measuring tool stops.
