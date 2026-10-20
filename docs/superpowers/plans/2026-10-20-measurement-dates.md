# Measurement Dates and Folder Drag Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every measurement records the layer it was measured on, sits under that layer's survey date in the Datasets tree, drags between its date's folders, and moves to another date by being measured again on that date's matching data.

**Architecture:** Two optional fields on `SurveyMeasurement` (`source.layer`, per-vertex `pickedOn`) carry the source; pure helpers decide the date at creation (`survey/measureSource.ts`), plan a date move (`survey/measureMove.ts`) and plan the legacy backfill (`survey/measureBackfill.ts`); a runner (`survey/measureMoveRun.ts`) feeds them the prepared surfaces (`survey/dateSurfaces.ts`) and the 3D stage, applies the result through one undoable store call and posts one sidebar note. The tree builds one Measurements group per date (`measureRows.ts`, `dateModel.ts`) and `DatasetTree`/`DateTree` gain measurement drag sources and drop targets. A layer re-dated by any path is followed by a manifest subscriber, so the layer's own Undo carries its measurements back.

**Tech Stack:** TypeScript strict, React 19, zustand, zod 4, three.js, MapLibre, Vitest (jsdom), Playwright with Electron.

**Spec:** `docs/superpowers/specs/2026-10-20-measurement-dates-design.md`

## Global Constraints

- Worktree only (`E:\Dev\AIO Software\.claude\worktrees\measure-dates`, branch `feat/measure-dates`); never the main checkout. `pnpm check` green; every added or changed e2e spec run the CI way.
- Contract change (owned by Task 1): `SurveyMeasurement` gains optional `source: { layer: Id }` and optional `pickedOn: ('model' | 'ground')[]`; `aio.measurements/1` stays; `{ kind: 'site' }` scope is legacy only. Row in `docs/architecture/contract-changes.md`; the integration lead signs off before merge.
- `pickedOn`, when present, has exactly `points.length` entries. The app never writes a file that breaks this (vertex edits, flips, copies and moves realign it), because the schema refuses such a file.
- Measurements autosave off by default: every move, re-file, follow and backfill is an ordinary edit that waits for **Save measurements** (`changed()`, `measureStore.ts`:389). Only engine results use `setComputedResults` (:438).
- Read-only (a package: `measureStore.readOnly`; a look-only reviewer: `isAnnotateReadOnly()` from `@aio/annotate`): no drag starts, no move, no follow write, no backfill. Sidebar gate stays `canMeasureEdit` (`Sidebar.tsx`:779).
- No measurement is created undated in a project with survey dates. In a project with no captures the scope stays `{ kind: 'site' }` (plain Measurements group, as today) but `source` and `pickedOn` are still written.
- A date move is all or nothing for the dragged set; refusals change nothing and say why in the sidebar note slot (`DateNotes.tsx`), never a dialog.
- A folder is never made automatically. A folder is keyed by (date, name).
- Exact copy (no em or en dashes in any user-facing text): the telecom refusal is "Antenna measurements stay on the date they were picked on."; the legacy group is "Needs a date"; the unprepared offer button is "Prepare surfaces". All new tree and note strings go in `packages/ui/src/i18n/en.ts` (Task 3 owns that file); panel strings stay inline English as in `MeasurementPanel.tsx`.
- Renderer talks to main only through `window.aio` (`bridge.call`). No new IPC channel.
- Public text: no client or site names (`node tools/agent/check-public-text.mjs <files>`). Conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; never `--no-verify`.
- `/wrapup` (session note, north star) is done by the main session on this branch, not by a task here.

## Review Focus

1. **A vertex edit on a measurement with `pickedOn`** (insert a midpoint, delete a vertex, drag one, Flip on an azimuth): `pickedOn` keeps `points.length` entries, kept vertices keep their kind, so Save is never refused. Test in Task 4.
2. **A measurement whose date was deleted** (its `scope.capture` no longer in `manifest.captures`): it shows under "Needs a date", never vanishes from the tree. Test in Task 3.
3. **Undo after a backfill**: the filed measurements go back to "Needs a date" and the backfill does not run again in the same session for that project. Test in Task 8.
4. **A date move started from the map view** (no 3D stage mounted) with `model` vertices: refused with the "could not be loaded" note, nothing moved; a move with only `ground` vertices goes through. Test in Task 7.
5. **The new-folder row and a reveal in a dated tree**: the inline new-folder row shows only in the Measurements group of the marked measurements' date, and revealing a measurement opens its date folder. Test in Task 5.

---

## File Structure

| File                                                           | Responsibility                                                                                            |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `packages/schema/src/survey.ts`                                | `MeasurementSource`, `PickedOn`; fields on `SurveyMeasurement`; length check in `MeasurementsFile`        |
| `apps/desktop/src/renderer/survey/measureSource.ts` (new)      | Pure: vertex picks, base layer, map pick rule, creation dating, `pickedOn` realignment                    |
| `apps/desktop/src/renderer/survey/dateSurfaces.ts` (new)       | Per-date sampler over prepared surfaces; ground heights at drawn points                                   |
| `apps/desktop/src/renderer/survey/dateReadout.ts` (new)        | Async readout rows on a sampler (moved out of `reportPage/house/surveyData.ts`)                           |
| `apps/desktop/src/renderer/survey/measureMove.ts` (new)        | Pure: plan a date move (refusals, counterpart, re-pick, folder, surface refs)                             |
| `apps/desktop/src/renderer/survey/measureMoveRun.ts` (new)     | Runner: move, copy, stage re-picker, layer-date follow subscriber, refusal text                           |
| `apps/desktop/src/renderer/survey/measureBackfill.ts` (new)    | Pure plan plus the once-per-project runner for legacy `site` measurements                                 |
| `apps/desktop/src/renderer/survey/measureRows.ts`              | Rows per date, "Needs a date" rows, telecom flag, folder ids with the date, folders per date              |
| `packages/ui/src/tree/model.ts`, `dateModel.ts`                | `measure.telecom`, group label, a Measurements group inside each date folder                              |
| `packages/ui/src/tree/DatasetTree.tsx`, `DateTree.tsx`         | Measurement drag sources and drop targets, refused telecom drop, scoped new-folder row, reveal opens date |
| `apps/desktop/src/renderer/shell/Sidebar.tsx`, `DateNotes.tsx` | Wiring: groups per date, drags, measurement notes with Undo and Prepare surfaces                          |
| `apps/desktop/src/renderer/shell/actions/measureActions.tsx`   | Move to folder: the date's folders only, disabled across dates                                            |
| `apps/desktop/src/renderer/survey/MeasurementPanel.tsx`        | Scope section shows date and source; copy re-measures; readouts on the measurement's date                 |

## Execution DAG

| Task | Depends on  | Packages                  |
| ---- | ----------- | ------------------------- |
| 1    | none        | `@aio/schema`, docs       |
| 2    | none        | `@aio/desktop`            |
| 3    | none        | `@aio/ui`, `@aio/desktop` |
| 4    | 1           | `@aio/desktop`            |
| 5    | 3           | `@aio/ui`                 |
| 6    | 3           | `@aio/desktop`            |
| 7    | 2, 4        | `@aio/desktop`            |
| 8    | 7           | `@aio/desktop`            |
| 9    | 5, 7        | `@aio/desktop`            |
| 10   | 2, 7        | `@aio/desktop`            |
| 11   | 6, 8, 9, 10 | `@aio/desktop` (e2e)      |
| 12   | 11          | all                       |

Parallel batches (no shared files inside a batch; dispatch each batch in one message):

- **Batch A:** Tasks 1, 2, 3.
- **Batch B:** Tasks 4, 5, 6.
- **Batch C:** Task 7.
- **Batch D:** Tasks 8, 9, 10.
- **Batch E:** Task 11.
- **Batch F:** Task 12.

**Critical path:** 1 → 4 → 7 → 9 → 11 → 12. Task 7 (move planner, runner and store API) is the longest single task; start it the moment 2 and 4 land.

Shared-file notes: `measureStore.ts` is touched by Task 4 then Task 7 (different batches); `workspace/workbench/measureFollow.ts` by Task 7 then Task 8; `en.ts` only by Task 3.

---

### Task 1: Contract: `source` and `pickedOn` on `SurveyMeasurement`

**Files:**

- Modify: `packages/schema/src/survey.ts:406-450` (new schemas beside `MeasurementScope`; fields in `SurveyMeasurement`; check in the `MeasurementsFile` `superRefine` at :460)
- Modify: `packages/schema/src/survey.ts:678-682` (exported types)
- Modify: `docs/architecture/contract-changes.md` (append a row, date `2026-10-20`)
- Modify: `docs/architecture/data-conventions.md:729` (section 27: the two fields; `site` scope legacy only; "promote and demote switch it" goes)
- Test: `packages/schema/src/m11.test.ts` (in `describe('survey files')`, :232)

**Interfaces:**

- Produces: `MeasurementSource = z.object({ layer: Id }).strict()`, `PickedOn = z.enum(['model', 'ground'])`, `SurveyMeasurement.source?: MeasurementSource`, `SurveyMeasurement.pickedOn?: PickedOn[]` (max 100 000, as `points`), types `MeasurementSource`, `PickedOn`, all exported from `@aio/schema`.

- [ ] **Step 1: Write the failing tests** in `m11.test.ts`:

```ts
it('measurements take an optional source layer and per-vertex pick kinds', () => {
  const m = {
    ...measurement(),
    source: { layer: 'dsm-d1' },
    pickedOn: ['ground', 'model', 'ground'],
  };
  expect(MeasurementsFile.parse(fileOf([m])).measurements[0]).toMatchObject({
    source: { layer: 'dsm-d1' },
    pickedOn: ['ground', 'model', 'ground'],
  });
});
it('a file from before the fields still parses', () => {
  expect(MeasurementsFile.safeParse(fileOf([measurement()])).success).toBe(true);
});
it('refuses pickedOn that does not match the points', () => {
  const r = MeasurementsFile.safeParse(
    fileOf([{ ...measurement(), pickedOn: ['ground', 'ground', 'ground', 'model'] }]),
  );
  expect(r.success).toBe(false);
  expect(r.error?.issues[0]?.path).toEqual(['measurements', 0, 'pickedOn']);
});
it('refuses a pick kind that is not model or ground', () => {
  expect(
    MeasurementsFile.safeParse(
      fileOf([{ ...measurement(), pickedOn: ['air', 'ground', 'ground'] }]),
    ).success,
  ).toBe(false);
});
```

`measurement()` is a three-point polygon helper local to the test (reuse the one the `survey files` block has, or add it); `fileOf(ms)` wraps it as `aio.measurements/1`.

- [ ] **Step 2: Run to verify they fail:** `pnpm --filter @aio/schema exec vitest run src/m11.test.ts` → FAIL (unknown keys pass through the loose object, the length test passes when it should not).
- [ ] **Step 3: Implement** the schemas and the length check (`message: 'pickedOn must have one entry per point'`, `path: ['measurements', i, 'pickedOn']`) inside the existing `superRefine`, so `SurveyMeasurement` stays a plain object.
- [ ] **Step 4: Run to verify they pass:** same command → PASS. Then `pnpm --filter @aio/schema exec vitest run` → PASS.
- [ ] **Step 5: Docs.** Contract row text: "Measurement source, additive: `SurveyMeasurement` gains optional `source` (`{ layer }`, the layer it was measured or last re-measured on) and optional `pickedOn` (`'model' | 'ground'` per vertex, same length as `points`; a file breaking that is refused). `aio.measurements/1` stays. `scope` `{ kind: 'site' }` is legacy only: the app creates `{ kind: 'survey', capture }` with `capture` the source layer's date, and keeps `site` only in a project with no survey dates. Older readers ignore the fields." Section 27 line 729 rewritten to match.
- [ ] **Step 6: Commit:** `feat(schema): measurement source layer and per-vertex pick kinds`

---

### Task 2: Samplers on a date's prepared surfaces, and readouts on them

**Files:**

- Create: `apps/desktop/src/renderer/survey/dateSurfaces.ts`
- Create: `apps/desktop/src/renderer/survey/dateReadout.ts`
- Modify: `apps/desktop/src/renderer/reportPage/house/surveyData.ts:339-382` (the local `readout` goes; import `readoutOn`)
- Test: `apps/desktop/src/renderer/survey/dateSurfaces.test.ts`, `apps/desktop/src/renderer/survey/dateReadout.test.ts`

**Interfaces:**

- Produces (`dateSurfaces.ts`):
  - `hasPrepared(surfaces: readonly HeightTiles[], capture: string): boolean` (`surfaceOfCapture` from `@aio/survey` is not null)
  - `dateSampler(capture: string): Promise<PointSampler | null>`: `projectResolver` (from `@aio/survey`) over `compareStore` `surfaces`, `designs`, `captures` (ids in date order), `capture`, a module `TileCache`, and `fetchBytes` from `sectionEngine.ts` with base `aio://project/${encodeURIComponent(projectId)}/` (as `compareStore.ts`:255); `samplerOf(await resolve({ kind: 'current' })).sample`; null when the date has no prepared surface. Memoised per (project id, `surfaces` array identity, capture).
  - `groundAt(capture: string, drawn: readonly SitePoint[], manifest: Pick<ProjectManifest, 'captures' | 'layers' | 'origin'>): Promise<Float64Array>`: heights under drawn positions, NaN where none. Converts each drawn point to the prepared surface's frame: minus the date's current line-up (`captureShift`), plus the shift the surface was prepared with (`HeightTiles.dateShiftM`), the arithmetic `ringShifts` (`packages/survey/src/engine/resolver.ts`:44) uses.
  - `setDateSurfaceSource(fn: ((capture: string) => Promise<PointSampler | null>) | null): void` (tests).
- Produces (`dateReadout.ts`): `readoutOn(m: SurveyMeasurement, items: readonly string[] | undefined, sample: PointSampler | null, ctx?: { stepM?: number }): Promise<ReadoutRow[]>` (the body of `surveyData.ts` `readout`, plus `stepM` passed through).

- [ ] **Step 1: Write the failing tests.**
  - `dateSurfaces.test.ts`: `it('hasPrepared is false for a date whose only surface is of another date')`; `it('groundAt samples a lined-up date at drawn minus its shift plus the prepared shift')`: fake sampler records `es`/`ns`; manifest with `d2` lined up `eastM: 2`, surface prepared with `dateShiftM.eastM = 0.5`; drawn `[10, 0, 0]` → asked at `e = 8.5`; `it('groundAt is all NaN for a date without a prepared surface')`.
  - `dateReadout.test.ts`: `it('readoutOn fills terrain rows from the sampler')`: a line over a fake sampler that answers 5 everywhere gives the same terrain row value as `measurementReadout` with `{ heightAt: () => 5 }`; `it('readoutOn without a sampler is measurementReadout without a surface')`.
- [ ] **Step 2: Run:** `pnpm --filter @aio/desktop exec vitest run src/renderer/survey/dateSurfaces.test.ts src/renderer/survey/dateReadout.test.ts` → FAIL (modules missing).
- [ ] **Step 3: Implement** both modules and switch `surveyData.ts` to `readoutOn`.
- [ ] **Step 4: Run** the two tests plus `pnpm --filter @aio/desktop exec vitest run src/renderer/reportPage/house/survey.test.ts` → PASS (report numbers unchanged).
- [ ] **Step 5: Commit:** `feat(survey): samplers and readouts on a survey date's prepared surfaces`

---

### Task 3: Tree model: one Measurements group per date, "Needs a date", and all new strings

**Files:**

- Modify: `apps/desktop/src/renderer/survey/measureRows.ts:43-89`
- Modify: `packages/ui/src/tree/model.ts:33` (`TreeItem.measure.telecom?: boolean`), `:154-166` (`measurementsGroup` label)
- Modify: `packages/ui/src/tree/dateModel.ts:65-121`
- Modify: `packages/ui/src/i18n/en.ts` (every new key below)
- Test: `apps/desktop/src/renderer/survey/measureRows.test.ts`, `packages/ui/src/tree/dateModel.test.ts`

**Interfaces:**

- Produces (`measureRows.ts`):
  - `needsDate(m: SurveyMeasurement, manifest: Pick<ProjectManifest, 'captures'> | null): boolean`: `site` scope, or a `survey` scope whose capture the manifest no longer has.
  - `buildMeasureItems(s, manifest, ws, query = '', on?: string | null): TreeItem[]`: `on` undefined: every measurement (no dates, as today); a capture id: that date's; `null`: the "Needs a date" ones. Folder ids `measure-folder:<on>:<name>` for a date, `measure-folder:needs:<name>` for null, `measure-folder:<name>` when undefined. Rows set `measure.telecom` from `isTelecomTool(m.tool)` and keep `dimmed` as today.
  - `measureFoldersOf(file: MeasurementsFile, on: string | null | undefined): string[]`: the folder names in use for that date (`on` undefined: all, as `measureFolders`), A to Z.
- Produces (`@aio/ui`):
  - `measurementsGroup(items, all?, label?: string): TreeGroup | null`
  - `buildDateTree(..., opts: TreeOptions & { measurementsOf?: (capture: string) => { items: readonly TreeItem[]; ids?: readonly string[] } | undefined })`: each date folder's `buildDatasetTree` call gets that date's `measurements`/`measurementIds`; a date with only measurements still gets its groups. The Every date folder never gets measurements.
- Produces (`en.ts`, exact copy):
  - `'tree.measure.needsDate': 'Needs a date'`
  - `'tree.measure.move.telecom': 'Antenna measurements stay on the date they were picked on.'`
  - `'tree.measure.move.noMatch': '{date} has no data like {layer}, so nothing was moved.'`
  - `'tree.measure.move.unprepared': 'The surfaces of {date} are not prepared yet, so nothing was moved.'`
  - `'tree.measure.move.prepare': 'Prepare surfaces'`
  - `'tree.measure.move.notLoaded': '{layer} could not be loaded to measure on, so nothing was moved.'`
  - `'tree.measure.move.noData': '{date} has no data under every point of {name}, so nothing was moved.'`
  - `'tree.measure.move.done_one': '{count} measurement moved to {date} and measured again.'`, `'tree.measure.move.done_other': '{count} measurements moved to {date} and measured again.'`
  - `'tree.measure.backfill.done_one': '{count} older measurement was filed under its survey date.'`, `'tree.measure.backfill.done_other': '{count} older measurements were filed under their survey dates.'`
  - `'actions.measure.spansDates': 'The marked measurements are on different dates'`

- [ ] **Step 1: Write the failing tests.**
  - `measureRows.test.ts`, new `describe('rows per survey date')`: `it('builds only the given date's rows and folders')`; `it('keeps the same folder name under two dates apart')`: "Piles" under `d1` and `d2` → ids `measure-folder:d1:Piles` and `measure-folder:d2:Piles`, each holding only its date's row; `it('Needs a date holds site measurements and those of a deleted date only')`: a `site` row and a row scoped to capture `gone` are under `null`, neither under `d1`; `it('flags antenna rows as telecom')`; `it('measureFoldersOf lists one date's folders')`.
  - `dateModel.test.ts`: `it('puts each date's Measurements group in its folder')`: `measurementsOf` returning one row for `oct` → the `oct` folder has a `measurements` group with count 1, `nov` has none, Every date has none; `it('a date with only measurements is not empty')`.
- [ ] **Step 2: Run:** `pnpm --filter @aio/desktop exec vitest run src/renderer/survey/measureRows.test.ts` and `pnpm --filter @aio/ui exec vitest run src/tree/dateModel.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Keep the old call shape working (no `on`) so `Sidebar.tsx` compiles unchanged until Task 9.
- [ ] **Step 4: Run** both, plus `pnpm --filter @aio/ui exec vitest run src/i18n/i18n.test.ts` (the dash and key checks) → PASS.
- [ ] **Step 5: Commit:** `feat(tree): a measurements group per survey date`

---

### Task 4: A new measurement takes its source layer and date

**Files:**

- Create: `apps/desktop/src/renderer/survey/measureSource.ts`
- Modify: `apps/desktop/src/renderer/survey/measureScene.ts:212-282` (3D pick), `:703-706` and `:818-846` (map pick)
- Modify: `apps/desktop/src/renderer/survey/measureStore.ts:186-198` (`savedEdit`), `:536-555` (`copyToSurvey` keeps `pickedOn`), `:762-768` (`flipAzimuth`), `:812-877` (`drawEvent`), `:898-913` (`editEvent`)
- Modify: `apps/desktop/src/renderer/survey/WholeSite.tsx:215-247`
- Test: `apps/desktop/src/renderer/survey/measureSource.test.ts`, `measureScene.test.ts`, `measureStore.test.ts`

**Interfaces:**

- Consumes: Task 1 types `PickedOn`, `MeasurementSource`.
- Produces (`measureSource.ts`):
  - `interface VertexPick { layer: string | null; on: PickedOn }`
  - `baseLayer(index: CaptureIndex, manifest: Pick<ProjectManifest, 'layers'>, capture: string): string | undefined`: the date's DSM raster, else its ortho raster, else its first dated layer.
  - `mapPickLayer(manifest, index: CaptureIndex, hidden: Readonly<Record<string, true>>, local: Vec3): string | null`: the topmost shown dated raster whose `corners` (shifted by the layer's date shift, as the map draws them) contain the point, DSM before ortho; topmost is the last in `manifest.layers` order (the map adds rasters in that order under `RASTERS_TOP`). A raster without `corners` covers every point.
  - `creationDating(picks: readonly VertexPick[], ctx: { index: CaptureIndex | null; manifest; focus: string | null }): { scope: MeasurementScope; source?: MeasurementSource; pickedOn: PickedOn[] }`: layer is the first pick's layer, else `baseLayer` of focus-or-newest; date is `index.of[layer]`, else focus, else the newest capture; no captures → `{ kind: 'site' }`.
  - `alignPicks(prev: readonly VertexPick[], length: number, pick: VertexPick | null): VertexPick[]`: grows with `pick` (or `{ layer: last layer, on: 'ground' }` for a typed or constructed point), shrinks by truncation.
  - `realignPickedOn(before: readonly SitePoint[], after: readonly SitePoint[], kinds: readonly PickedOn[]): PickedOn[]`: a vertex whose coordinates are in `before` keeps its kind; any other takes the previous vertex's kind, else `'ground'`.
- Produces (`measureScene.ts`): `hitPick(object: Object3D | null): VertexPick` (walks parents for `userData.aioLayer ?? userData.layerId`; `on` is `'ground'` when `isReferenceSurface`, else `'model'`); the 3D `pick` returns `{ p: SitePoint; at: VertexPick } | null`.
- Produces (`measureStore.ts`): `drawEvent(e: DrawEvent, env: DrawEnv, pick?: VertexPick): void`; module `drawPicks` reset by `startTool` and `stopTool`. Map clicks pass `{ layer: mapPickLayer(...), on: 'ground' }` using the view's own `dates.getState().hidden`; 3D clicks pass `at`.

- [ ] **Step 1: Write the failing tests.**
  - `measureSource.test.ts`: `it('creationDating takes the first vertex layer and its date')`; `it('an every-date layer takes the focused date, else the newest')`; `it('no layer under the first vertex falls back to the focused date base layer')`: base is the DSM, then the ortho when there is no DSM; `it('a project with no dates keeps site scope but records the source')`; `it('mapPickLayer prefers the shown DSM over the ortho and skips hidden rasters')`; `it('mapPickLayer takes the last raster in manifest order when two DSMs overlap')`; `it('alignPicks follows points added and removed')`; `it('realignPickedOn keeps kinds of kept vertices across an inserted midpoint and a deleted vertex')`: `[m,g,m]` with a midpoint inserted after vertex 0 → `[m,m,g,m]`; deleting vertex 1 of `[m,g,m]` → `[m,m]`.
  - `measureScene.test.ts`: `it('hitPick names the layer of a mesh hit as a model pick')`; `it('hitPick calls a raster or the ground plane a ground pick')`.
  - `measureStore.test.ts`, new `describe('a new measurement takes its source layer and date')`: `it('a drawn polygon is scoped to its first vertex layer date with one kind per vertex')`; `it('a vertex edit keeps pickedOn as long as points')` (Review Focus 1: insert midpoint, delete, drag, then `MeasurementsFile.safeParse(io.saved)` succeeds after Save); `it('Flip keeps pickedOn aligned')`; `it('copyToSurvey keeps pickedOn')`.
- [ ] **Step 2: Run:** `pnpm --filter @aio/desktop exec vitest run src/renderer/survey/measureSource.test.ts src/renderer/survey/measureScene.test.ts src/renderer/survey/measureStore.test.ts` → FAIL.
- [ ] **Step 3: Implement.** `drawEvent` reads `timeline.getState().focus` (`../workspace/timeline`) and `workspace.getState().dates` for `creationDating`; `measurementFrom` result gets `scope`, `source`, `pickedOn`, and its points go through `storedPoints(points, scope, manifest)` (drawn points are where the date is drawn). `savedEdit` and `flipAzimuth` set `pickedOn` through `realignPickedOn` when the measurement has one. Whole-site regions: date from `site.to` (a `survey` ref's surface `capture`, else focus-or-newest), `source` from that surface's `source.layer` when it is a DSM, `pickedOn` all `'ground'`.
- [ ] **Step 4: Run** the three tests, then `pnpm --filter @aio/desktop exec vitest run src/renderer/survey` → PASS (lineup tests included).
- [ ] **Step 5: Commit:** `feat(measure): new measurements record their source layer and survey date`

---

### Task 5: Measurement drag in the tree

**Files:**

- Modify: `packages/ui/src/tree/DatasetTree.tsx:123-148` (`MeasureTreeProps`), `:338-363` (reveal), `:790-1013` (rows, folders, new-folder row), `:1066-1140` (group header)
- Modify: `packages/ui/src/tree/DateTree.tsx:49-150`, `:309-380`
- Test: `packages/ui/src/tree/measureTree.test.tsx`, `packages/ui/src/tree/DateTree.test.tsx`

**Interfaces:**

- Consumes: Task 3 `TreeItem.measure.telecom`.
- Produces (`MeasureTreeProps` additions):
  - `dragMeasureIds?: ((item: TreeItem) => string[]) | undefined` (a row: its id; a folder row: every id in it; absent: nothing drags)
  - `onDropToFolder?: ((ids: string[], folder: string) => void) | undefined` (`''` is the group header: out of any folder)
  - `onDragMeasures?: ((drag: { ids: string[]; telecom: boolean } | null) => void) | undefined`
- Produces (`DateTreeProps` addition): `onMoveMeasures?: ((ids: string[], capture: string) => void) | undefined`. `DateTree` drag state becomes `{ kind: 'layers' | 'measurements'; ids: string[]; from: string; telecom: boolean } | null`; a measurement drag is offered to every date folder (with a capture) but its own, never to Every date or the spare folder; with `telecom` the folder gets ` drop-no` instead of ` drop-can`, `title` set to `t('tree.measure.move.telecom')`, and a drop still calls `onMoveMeasures` (the runner refuses with that note). Layer drags ignore measurement targets; measurement drags ignore layer handling.
- Inside `DatasetTree`: its own measurement drag (`measureDrag: string[] | null`) makes folder rows and the Measurements header drop targets (`drop-can` / `drop-over`, same classes as date folders); a drop on the folder the rows are already in calls nothing.

- [ ] **Step 1: Write the failing tests.**
  - `measureTree.test.tsx`: `it('rows and folder rows drag only with dragMeasureIds')`; `it('a row dropped on a folder files it there, on the header takes it out')`: `onDropToFolder` called with `(['a'], 'Piles')` then `(['a'], '')`; `it('a folder row carries every measurement in it')`; `it('a layer drag does not light measurement targets')`; `it('the new-folder row shows only in the group holding the asked measurement')` (Review Focus 5, two groups rendered, `newFolder.ids = ['b']`).
  - `DateTree.test.tsx`, new `describe('DateTree: dragging a measurement')`: `it('offers other date folders, not its own or Every date')`; `it('a drop on another date calls onMoveMeasures with that capture')`; `it('an antenna drag shows the date folder refused with the reason')`; `it('nothing drags without onMoveMeasures and dragMeasureIds (read-only)')`; `it('a reveal opens the date folder holding the measurement')` (Review Focus 5).
- [ ] **Step 2: Run:** `pnpm --filter @aio/ui exec vitest run src/tree/measureTree.test.tsx src/tree/DateTree.test.tsx` → FAIL.
- [ ] **Step 3: Implement.** `DateTree` passes each date folder's `DatasetTree` an `onDragMeasures` that sets its drag `from` to that folder id; the `after` tree uses `from: 'needs-date'`. On a new `measures.reveal.seq`, `DateTree` opens the folder whose groups hold the id (adjusted during render, as the focus is).
- [ ] **Step 4: Run** both files, then `pnpm --filter @aio/ui exec vitest run src/tree` → PASS.
- [ ] **Step 5: Commit:** `feat(tree): drag measurements between folders and onto survey dates`

---

### Task 6: Move to folder lists only the date's folders

**Files:**

- Modify: `apps/desktop/src/renderer/shell/actions/measureActions.tsx:142-178`
- Test: `apps/desktop/src/renderer/shell/actions/measureActions.test.ts`

**Interfaces:**

- Consumes: Task 3 `measureFoldersOf(file, on)`, `needsDate`.
- Produces: no new exports. The marked measurements' date key is the capture of a `survey` scope, `null` for "Needs a date", or `undefined` when the project has no captures; one key → `measureFoldersOf(file, key)`; several → the submenu entries are all disabled with `t('actions.measure.spansDates')` (New folder too).

- [ ] **Step 1: Write the failing tests:** `it('Move to folder lists only the folders of the marked measurements date')`: "Piles" on `d1`, "Pads" on `d2`, marked `d1` row → submenu has `to:Piles`, no `to:Pads`; `it('Move to folder is disabled across dates with the reason')`; `it('a project with no dates still lists every folder')`.
- [ ] **Step 2: Run:** `pnpm --filter @aio/desktop exec vitest run src/renderer/shell/actions/measureActions.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit:** `feat(measure): move to folder within one survey date`

---

### Task 7: Date move: planner, runner, store API and layer follow

**Files:**

- Create: `apps/desktop/src/renderer/survey/measureMove.ts`
- Create: `apps/desktop/src/renderer/survey/measureMoveRun.ts`
- Modify: `apps/desktop/src/renderer/survey/measureStore.ts` (state `undoChange`, `note`; functions below). The store never imports the runner (the runner imports the store and `compareStore`, which imports the store); the panel calls the runner directly (Task 10).
- Modify: `apps/desktop/src/renderer/workspace/workbench/measureFollow.ts:159-200` (start `followLayerDates()`)
- Test: `apps/desktop/src/renderer/survey/measureMove.test.ts`, `measureMoveRun.test.ts`, `measureStore.test.ts`

**Interfaces:**

- Consumes: Task 2 `groundAt`, `hasPrepared`; Task 4 `baseLayer`, `VertexPick`; `counterpart` (`@aio/workspace` `captures.ts`:262); `drawnPoints`/`storedPoints` (`measureDates.ts`); `computeAll` (`compareStore.ts`:440); `layerReady` (`placement/controller.ts`:107); `getActiveScene` (`@aio/engine`).
- Produces (`measureMove.ts`):

```ts
export type MoveRefusal =
  | { kind: 'telecom' }
  | { kind: 'no-match'; id: string; layer: string }
  | { kind: 'unprepared'; capture: string }
  | { kind: 'not-loaded'; layer: string }
  | { kind: 'no-data'; id: string };
export interface Repicker {
  ground(capture: string, drawn: readonly SitePoint[]): Promise<Float64Array>; // NaN: none
  model(layer: string, drawn: readonly SitePoint[]): Promise<Float64Array | null>; // null: not loaded
}
export interface MoveEnv {
  manifest: Pick<ProjectManifest, 'captures' | 'layers' | 'origin'>;
  index: CaptureIndex;
  surfaces: readonly HeightTiles[];
  repick: Repicker;
  folders: ReadonlySet<string>; // folder names in use under the target date
}
export type MovePlan =
  { ok: true; next: SurveyMeasurement[] } | { ok: false; refusal: MoveRefusal };
export function planMoveToDate(
  ms: readonly SurveyMeasurement[],
  capture: string,
  env: MoveEnv,
): Promise<MovePlan>;
```

Rules, in order: any telecom → `telecom`; each source layer (`source.layer`, else `baseLayer` of its own date) needs `counterpart(index, layer, capture)` → else `no-match`; `!hasPrepared(surfaces, capture)` → `unprepared`; re-pick at the drawn plan position by kind (`pickedOn`, else `model` when the source layer is a mesh or point cloud and `ground` otherwise): `model` via `repick.model(counterpart, ...)` (null → `not-loaded`), `ground` via `repick.ground(capture, ...)`; any NaN → `no-data`. Apply: `scope` to the target, `source` to the counterpart, new Z, points through `storedPoints` for the target, `pickedOn` kept, `folder` kept when in `folders` else removed, every result `status: 'stale'`, and an item ref `{ kind: 'survey', surface }` whose surface is of the old date rewritten to `surfaceOfCapture(surfaces, capture).id` (other dates' surfaces and designs stay). A measurement already on the target is left out of `next`. A `site` (Needs a date) measurement is filed without a re-pick: scope, `source` = `baseLayer(target)`, points re-stored to stay where drawn, no `pickedOn`.

- Produces (`measureStore.ts`):
  - `interface MeasureNote { seq: number; text: string; danger: boolean; undo?: boolean; prepare?: boolean }`; state `note: MeasureNote | null`, `undoChange: { seq: number; before: SurveyMeasurement[] } | null`
  - `replaceMeasurements(next: readonly SurveyMeasurement[], opts?: { undoable?: boolean }): number | null` (by id, one `changed()`; returns the undo seq; no-op and null when read-only)
  - `undoMeasureChange(seq: number): void` (restores `before` by id when `seq` matches, then clears it)
  - `setMeasureNote(n: Omit<MeasureNote, 'seq'> | null): void`
- Produces (`measureMoveRun.ts`):
  - `moveMeasurementsToDate(ids: readonly string[], capture: string): Promise<MoveOutcome>` where `MoveOutcome = { ok: true; moved: number; seq: number | null } | { ok: false; refusal: MoveRefusal }`: plans, applies undoable, runs `computeAll(movedIds)`, posts the note (`tree.measure.move.done`, `undo: true`; a refusal posts its text, `prepare: true` for `unprepared`).
  - `copyMeasurementToDate(id: string, capture: string): Promise<MoveOutcome>`: the same plan on a copy (new id, `createdAt`, author), added with `addMeasurement`.
  - `stageRepicker(): Repicker`: `ground` = `groundAt`; `model` = with `getActiveScene()` (null → null), make the layer ray-ready (`layerReady`, which shows it), cast `raycastRay(top, down, { layer })` per point in the stage frame, then hide it again if it was hidden; null on timeout.
  - `moveRefusalText(r: MoveRefusal, manifest): string` (the Task 3 keys, `formatDate` for dates, layer and measurement names).
  - `followLayerDates(): () => void`: on a manifest change within one project, every measurement whose `source.layer` changed date (old date A to new date B, B a capture) and whose `scope.capture` is A takes scope B with its stored points unchanged and results stale (not undoable: the layer's own Undo moves the layer back and this follows it back); then `computeAll`. Nothing while read-only or before the measurements are `ready`; a layer moved to no date leaves its measurements on their date.
- `isAnnotateReadOnly()` refuses every write path here as `readOnly` does.

- [ ] **Step 1: Write the failing tests.**
  - `measureMove.test.ts` (fake `Repicker` and a two-date index): `it('re-picks model vertices on the counterpart and ground vertices on the target ground')`: asserts `repick.model` got the counterpart id and the new Z per kind; `it('takes the counterpart by slot, then by kind, and refuses without one')`; `it('keeps the folder when the target has that name, else clears it')`; `it('refuses antenna measurements')`; `it('refuses an unprepared target before re-picking')` (`repick` never called); `it('refuses when a vertex has no data')`; `it('refuses when the model layer cannot be loaded')`; `it('marks results stale and rewrites an old-date surface ref')`; `it('stores points in the target line-up frame')` (target lined up 2 m east: stored E is drawn E minus 2); `it('files a Needs a date measurement without a re-pick')`; `it('is all or nothing: one refusal moves none')`.
  - `measureMoveRun.test.ts` (mock `../shell` bridge and `compareStore` as `measureStore.test.ts` does; inject the repicker): `it('a move applies, recomputes the moved ids and posts one note with Undo')`; `it('Undo restores scope, source, folder, points and results')`; `it('a refusal posts its text and changes nothing')`; `it('an unprepared target offers Prepare surfaces')`; `it('with no 3D stage a model vertex is refused and a ground-only move goes through')` (Review Focus 4); `it('a layer re-dated carries its measurements, heights unchanged, and they follow it back')`; `it('an antenna measurement follows its layer with values unchanged')`; `it('nothing moves or follows in a read-only project or for a look-only reviewer')`.
  - `measureStore.test.ts`: `it('replaceMeasurements is one edit that waits for Save')`; `it('undoMeasureChange ignores a stale seq')`.
- [ ] **Step 2: Run:** `pnpm --filter @aio/desktop exec vitest run src/renderer/survey/measureMove.test.ts src/renderer/survey/measureMoveRun.test.ts src/renderer/survey/measureStore.test.ts` → FAIL.
- [ ] **Step 3: Implement** in the order planner, store API, runner, follow; start `followLayerDates()` in `useMeasureFollow`'s list.
- [ ] **Step 4: Run** the three, then `pnpm --filter @aio/desktop exec vitest run src/renderer/survey src/renderer/workspace` → PASS.
- [ ] **Step 5: Commit:** `feat(measure): move measurements to another survey date and measure them again`

---

### Task 8: Backfill legacy measurements

**Files:**

- Create: `apps/desktop/src/renderer/survey/measureBackfill.ts`
- Modify: `apps/desktop/src/renderer/workspace/workbench/measureFollow.ts` (start `followBackfill()`)
- Test: `apps/desktop/src/renderer/survey/measureBackfill.test.ts`

**Interfaces:**

- Consumes: Task 2 `groundAt`, `hasPrepared`; Task 3 `needsDate`; Task 4 `baseLayer`; Task 7 `replaceMeasurements`, `undoMeasureChange`, `setMeasureNote`.
- Produces:
  - `BACKFILL_TOL_M = 0.1`, `BACKFILL_MARGIN_M = 0.25`
  - `planBackfill(ms: readonly SurveyMeasurement[], env: { manifest; index: CaptureIndex; surfaces: readonly HeightTiles[]; ground: Repicker['ground'] }): Promise<SurveyMeasurement[]>`: the filed ones, rewritten. Only `site`-scoped measurements. First, one whose `source.layer` is dated is filed to that date. Else each prepared date is sampled at the vertices; the date is a clear match when its median of |stored Z minus surface Z| is at most `BACKFILL_TOL_M` and every other prepared date's median is at least `BACKFILL_MARGIN_M` larger (or it is the only prepared date). Filed: scope to the date, points re-stored to stay where drawn, `source` = that date's prepared DSM layer (`surfaceOfCapture(...).source.layer` when `kind` is `dsm`), else `baseLayer`; `pickedOn` per vertex `'ground'` when within `BACKFILL_TOL_M`, else `'model'`. Telecom measurements count like any other.
  - `followBackfill(): () => void`: once per project and session, when the measurements are `ready`, the compare store is `ready`, the project has captures and at least one `site` measurement, and neither `measureStore.readOnly` nor `isAnnotateReadOnly()`: plan, `replaceMeasurements(filed, { undoable: true })`, `setMeasureNote({ text: t('tree.measure.backfill.done', { count }), danger: false, undo: true })`. Nothing filed: no note. A later surfaces refresh in the same session does not run it again.

- [ ] **Step 1: Write the failing tests:** `it('files a measurement whose source layer has a date without sampling')`; `it('files only a clear height match')`: two dates, stored heights 0.03 m off `d1` and 1.2 m off `d2` → `d1`; `it('leaves a measurement that matches two dates alike')`; `it('leaves a measurement off every date by more than the tolerance')`; `it('guesses ground and model per vertex')`; `it('runs once with one note and Undo; Undo puts them back and it does not run again')` (Review Focus 3); `it('does not run read-only, for a look-only reviewer, or without dates')`; `it('waits for prepared surfaces before height matching')`.
- [ ] **Step 2: Run:** `pnpm --filter @aio/desktop exec vitest run src/renderer/survey/measureBackfill.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit:** `feat(measure): file older measurements under their survey dates`

---

### Task 9: Sidebar wiring

**Files:**

- Modify: `apps/desktop/src/renderer/shell/Sidebar.tsx:226-322` (rows per date, the after group), `:475-517` (notes), `:779-812` (`measures`), `:953-1001` (`DateNotes`, `DateTree`)
- Modify: `apps/desktop/src/renderer/shell/DateNotes.tsx:6-10` and its body
- Test: `apps/desktop/src/renderer/shell/DateNotes.test.tsx`, `apps/desktop/src/renderer/shell/Sidebar.measures.test.tsx`

**Interfaces:**

- Consumes: Task 3 `buildMeasureItems(..., on)`, `measurementsGroup(..., label)`, `buildDateTree` `measurementsOf`; Task 5 props; Task 7 `moveMeasurementsToDate`, `undoMeasureChange`, `MeasureNote`; `prepareSurfaces` (`compareStore.ts`:599); `itemMeasureIds` (`@aio/ui`).
- Produces: `DateNote` gains `measureUndo?: number` (a `MeasureNote` seq) and `prepare?: boolean`; `DateNotes` gains `onMeasureUndo: (seq: number) => void` and `onPrepare: () => void` (the "Prepare surfaces" button, `data-testid="date-note-prepare"`).
- Wiring: with dates on, `buildDateTree` gets `measurementsOf(c)` from `buildMeasureItems(..., c)` (and, under a filter, that date's ids); `after` is the "Needs a date" group (`t('tree.measure.needsDate')`) from `buildMeasureItems(..., null)`, shown only when it has rows. Dates off: as today. The filter query stays one shared state across groups. `measures.dragMeasureIds = canMeasureEdit ? itemMeasureIds : undefined`, `onDropToFolder = (ids, f) => setFolder(ids, f)`, `DateTree onMoveMeasures = canMeasureEdit ? (ids, c) => void moveMeasurementsToDate(ids, c) : undefined`. A new `measureStore.note.seq` replaces the sidebar note (adjusted during render, as `notedFor` is). Prepare failure text goes to the note as danger.

- [ ] **Step 1: Write the failing tests.** `DateNotes.test.tsx`: `it('a measurement note offers Undo with its seq')`; `it('an unprepared note offers Prepare surfaces')`; `it('a layer note keeps its own Undo')`. `Sidebar.measures.test.tsx`, new `describe('Datasets: measurements under survey dates')`: `it('a dated measurement is listed in its date folder, a legacy one under Needs a date')`; `it('no Needs a date group when every measurement has a date')`; `it('measurement rows do not drag in a package or for a look-only reviewer')`; `it('a project with no dates keeps the one Measurements group')`.
- [ ] **Step 2: Run:** `pnpm --filter @aio/desktop exec vitest run src/renderer/shell/DateNotes.test.tsx src/renderer/shell/Sidebar.measures.test.tsx` → FAIL.
- [ ] **Step 3: Implement** `DateNotes` then the `Sidebar` wiring.
- [ ] **Step 4: Run** it, then `pnpm --filter @aio/desktop exec vitest run src/renderer/shell` and `pnpm typecheck` → PASS.
- [ ] **Step 5: Commit:** `feat(sidebar): measurements under their survey dates, with drag and notes`

---

### Task 10: Selected panel: date and source, copy re-measures, readouts on the date

**Files:**

- Modify: `apps/desktop/src/renderer/survey/MeasurementPanel.tsx:57-82` (readouts), `:377-444` (Scope section)
- Test: `apps/desktop/src/renderer/survey/MeasurementPanel.test.tsx`

**Interfaces:**

- Consumes: Task 2 `dateSampler`, `readoutOn`; Task 7 `copyMeasurementToDate`.
- Produces: no new exports. Readouts: an effect runs `readoutOn(shown, tpl?.items, await dateSampler(capture), { stepM })` for the measurement's date and shows those rows; until it answers, or when the date has no prepared surface or the measurement has no date, the rows are today's (`measureStore.surface`). Tree values and 3D labels already read no surface (`measureRows.ts`:33-37, `measureScene.ts`:159), so they stay as they are. Scope section: "Survey date: {date}" and "Measured on: {layer name}" (or "Needs a date: drag it onto a survey date in the Datasets list." for a legacy one); "Promote to the whole site" and "Only in" go; Copy calls `copyMeasurementToDate` (its note shows in the sidebar).

- [ ] **Step 1: Write the failing tests:** `it('shows the date and the source layer, with no Promote to the whole site')`; `it('a legacy measurement says it needs a date')`; `it('Copy re-measures through copyMeasurementToDate')` (mocked); `it('readouts sample the measurement date surface, not the stage')`: `setDateSurfaceSource` answers 7, `measureStore.surface` answers 1; a terrain row shows the value from 7.
- [ ] **Step 2: Run:** `pnpm --filter @aio/desktop exec vitest run src/renderer/survey/MeasurementPanel.test.tsx` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit:** `feat(measure): the panel shows the survey date and source and reads its date`

---

### Task 11: End to end

**Files:**

- Create: `apps/desktop/e2e/measurement-dates.spec.ts`
- Modify: `apps/desktop/e2e/measurement-layers.spec.ts` (one new test)
- Modify: `apps/desktop/e2e/island.ts:276-288` (`measureTree(win, date?: string)`: with a date, scope to `date-folder-<date>` and its Measurements group, so dated projects with several groups do not break strict mode)

**Interfaces:**

- Consumes: fixtures `earthworksProject` (`fixtures.ts`:1033, skips without the pipeline Python), `prepareSurveys` (`surveyJobs.ts`:52, prepares `d1` and `d2` only), `measureRow`, `measureSaved`, `measureControl` (`island.ts`), `stageMode`.

E2E specs added or changed:

| Spec                              | Asserts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Needs                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `measurement-layers.spec.ts` (+1) | `test('a row drags into a folder and out again, and waits for Save')`: on the tiny project (no dates) drag "Line B" onto the "Pads" folder row, it is listed there and Save is offered; drag it onto the Measurements header, it is loose again; the file on disk is unchanged until Save, then has no `folder` on `line-b`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | nothing extra                                       |
| `measurement-dates.spec.ts` (new) | Seeds `survey/measurements.json` before opening: `pile-d1` (area, scope `d1`, `source` `dsm-d1`, folder "Piles", all `ground`), `pile-d2` (scope `d2`, folder "Piles"), `ant-d1` (azimuth on `d1`). Then: (1) draw an area on `d1` with the area tool in 3D; its row is under `date-folder-d1`; (2) focus `d2`: the drawn row is dimmed and its label leaves the 3D view; (3) drag it onto `d1`'s "Piles" folder, then onto `date-folder-d2`: it is in `d2`'s "Piles" folder and the note says it was measured again; after Save the file has `scope.capture` `d2`, `source.layer` `ortho-d2` and at least one vertex Z different from before (draw it inside a cut or fill region of the demo's `truth.json`); (4) drag `pile-d2` onto `date-folder-d3` (not prepared): the note shows `date-note-prepare` and nothing moved; (5) drag `ant-d1` onto `date-folder-d2`: the note reads "Antenna measurements stay on the date they were picked on." and it is still under `d1`; (6) drag the `dsm-d1` row onto `date-folder-d3`: `pile-d1` is now under `d3`. | pipeline Python (survey demos); not the change demo |

- [ ] **Step 1: Write the `measurement-layers.spec.ts` test and the new spec.** Scroll the list yourself before each drag (`showTogether` in `timeline.spec.ts`); open stage tools through `e2e/island.ts` helpers; wait for the scene canvas before drawing.
- [ ] **Step 2: Build and run each the CI way** from `apps/desktop` (PowerShell; the worktree has no `python/.venv`, so point `QUADRION_E2E_PYTHON` at the main checkout's venv as the survey specs need):

```powershell
npx electron-vite build
$env:QUADRION_WINDOW_SIZE = '1100x720'; $env:QUADRION_E2E_SCALE = '1'; $env:QUADRION_E2E_SWGL = 'warp'
npx playwright test e2e/measurement-layers.spec.ts e2e/measurement-dates.spec.ts --workers=1
```

Expected: the log prints `[e2e] window 1100 x 720 px at display scale 1`; all tests PASS (none skipped for `measurement-dates.spec.ts` when the pipeline Python is found).

- [ ] **Step 3: Commit:** `test(e2e): measurements under survey dates and folder drag`

---

### Task 12: Checks and regression the CI way

**Files:** none new (fixes go to the task that owns the file).

- [ ] **Step 1:** `pnpm check` → lint, format, typecheck and unit tests all PASS.
- [ ] **Step 2:** Build the demos CI builds (`pnpm demo:build --quick` from `apps/desktop`, or at least `pnpm demo:change --quick`) and run, the CI way with `--workers=1`, the specs this change can reach: `measurement-layers`, `measurement-dates`, `measure-tools`, `telecom-measurements`, `date-annotations`, `timeline`, `survey-demo`, `survey-gaps`, `survey-reports`, `survey-export`, `survey-qa`, `line-up-dates`. Expected: all PASS. Watch for two things: the survey demos ship `site` measurements, so the backfill may file them once surfaces are prepared and leave the file unsaved; and specs that assume one Measurements group in a dated project need `measureTree(win, date)`.
- [ ] **Step 3:** `node tools/agent/check-public-text.mjs` on the changed docs and specs → no hits.
- [ ] **Step 4: Commit** any fix in its owning task's scope, e.g. `fix(measure): ...`.

The main session then runs `/wrapup` on this branch (session note with the "How to test" walkthrough, north star section 3) before `finish-task.mjs`.

---

## Self-review notes

- Spec coverage: data model (1), source at creation incl. map rule and every-date layers (4), Selected panel (10), sidebar groups and drag (3, 5, 9), Move to folder per date (6), date move and re-measure incl. heights, prepared surfaces first, model re-picks (7), layer moved carries measurements incl. telecom (7), readouts on their date (2, 10), backfill (8), errors as notes (3, 7, 9), projects with no dates (3, 4, 8), open points decided: explicit `survey` surface refs of the old date are rewritten (7); stockpile projects need nothing special because the move and follow read the capture index, not the timeline owner (regression in Task 12 via `timeline.spec.ts`).
- Calls this plan makes where the spec left room: a `site` measurement dragged from "Needs a date" is filed without a re-pick; a missing `pickedOn` is read from the source layer's kind; the filter query is shared by every date's group; the backfill thresholds are 0.10 m and 0.25 m; a model re-pick shows a hidden counterpart layer for the moment it takes.
