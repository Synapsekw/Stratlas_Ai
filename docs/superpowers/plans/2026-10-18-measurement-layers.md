# Measurement Layers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Saved measurements become layers in the Datasets sidebar: a Measurements group with folders, an eye per row (personal, remembered), a right-click menu in the tree and on the shape in 3D or on the map, and the "Saved in this project" list leaves the Measure workbench.

**Architecture:** The UI package learns a `measurements` tree group (rows carry a measurement id, folder rows carry children) and a `measurements` menu target; the desktop app builds the rows from `measureStore` (`survey/measureRows.ts`), registers the six menu actions (`shell/actions/measureActions.tsx`) and wires them in `Sidebar.tsx`. Visibility stays `measureStore.hiddenMeasurements`, loaded from and written to `localStorage` per project (`survey/measureVisibility.ts`). Picking in the views is a screen-space hit test on the drawn shapes (`survey/measureHits.ts`, pure) mounted from `MeasureLayer` (`survey/measurePick.ts`, `survey/MeasureMenu.tsx`), so `measureScene.ts` and `Stage.tsx` are not touched.

**Tech Stack:** TypeScript strict, React 19, zustand, three.js, MapLibre, Vitest (jsdom), Playwright with Electron.

**Spec:** `docs/superpowers/specs/2026-10-18-measurement-layers-design.md`

## Global Constraints

- Worktree only (`E:\Dev\AIO Software\.claude\worktrees\measurement-layers`, branch `feat/measurement-layers`); never the main checkout. `pnpm check` green; e2e run the way CI runs it.
- No contract change: no schema or IPC change. Nothing in `@aio/schema` or `bridge.call` channels changes.
- Visibility lives in the renderer's `localStorage`, keyed by project id, through a guarded `storage()` accessor (the `lineup/lineUpStart.ts` pattern). Ids that no longer exist are dropped on load. Storage unavailable: visibility works for the session only.
- Hiding never touches `measurements.json`, never marks the file unsaved, never adds a History/journal entry, never hides anything for anyone else.
- Rename, Colour, Move to folder and Delete are ordinary measurement edits: they mark the file unsaved and save with Save measurements (or autosave).
- Read-only projects and packages: visibility works and is remembered; Rename, Colour, Move to folder and Delete are disabled via `Action.disabled`.
- Group position: after "Maps and rasters", before "Photos" (this plan puts it directly after `maps`, before `drawings`).
- Menu order (founder): Rename (inline, F2), Colour (preset swatches), Hide/Show, Fly to, Move to folder, Delete.
- Multi-select: Hide/Show, Colour, Move to folder, Delete act on all marked measurements; Rename and Fly to act on the clicked one only.
- Labels allow 200 characters (`label` max 200, min 1); the measurement `RenameField` caps at 200. `folder` max 200, a single string, no nesting.
- The tree sorts by label within a folder; folders A to Z via `groupByFolder`; no manual reorder.
- Default colour `#ffd166` is one of the presets; picking one sets `style.color`, and `fill` too when it equalled the old colour.
- 3D/map menu and left-click pick are off while a measure tool is active or a measurement is being vertex-edited. Pins, photo markers and drone hits keep priority over measurements; measurements beat layer/ground picking. Only the main 3D view and the main map.
- Drawing and editing do not unhide; a newly added measurement is visible; drawing tools do not snap to hidden measurements.
- Survey-scoped measurements hidden by their date show a dimmed row and keep their own eye state; in the date tree the Measurements group appears once at site level.
- Public text: no client or site names (`node tools/agent/check-public-text.mjs`). No em or en dashes in user-facing text. Strings go in `packages/ui/src/i18n/en.ts`.
- E2e specs that click or Ctrl+click tree rows click the row's `.tn` name element, never the middle of the row (it can land on the eye, and the list now sits about 44 px lower since PR #181).
- Coordination: do not create `apps/desktop/src/renderer/workspace/flyToBox.ts` (coming from `feat/antenna-review`); do not modify `measureScene.ts` or `Stage.tsx`; the `MeasureBench.tsx` edit stays away from the `AntennaSection` line.

## Review Focus

1. **Hundreds of measurements.** A project with 500 measurements opens the tree without hundreds of DOM rows: each folder and the loose rows show at most `ROW_LIMIT + 1` (9) rows until "more", and the focused row always shows. Pinned in Task 4 (`caps 500 measurement rows per folder until More`) and Task 3 (`builds 500 rows sorted, one folder pass`).
2. **A hidden measurement is deleted.** Hide m1, delete m1, Revert: m1 comes back still hidden. Save without m1 and reopen: m1's id is pruned from storage. Pinned in Task 2 (`a deleted hidden id survives Revert and is pruned on the next load`).
3. **`localStorage` throws** (blocked site data, private window). Hiding still works for the session, nothing throws, and a second `loadMeasurements` of the same project in the session keeps the ids. Pinned in Task 2 (`blocked storage keeps hidden ids for the session`).
4. **Right-click or click on a shape while a tool draws or vertices are edited.** No menu, the event is not claimed, the drawing gets the click. Pinned in Task 8 (`no menu and no claim while a tool draws or vertices are edited`).
5. **A survey-scoped measurement whose date is hidden.** Its row is dimmed with its eye still open, it is not drawn, and a click where it would be drawn does not pick it. Pinned in Task 3 (`dims a survey measurement whose date is hidden, eye untouched`) and Task 8 (`a measurement off screen by its date is not hit`).

---

## File map

| File                                                                        | Task | Responsibility                                                                                       |
| --------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------- |
| `packages/ui/src/tree/model.ts`                                             | 1    | `measurements` group kind, `TreeItem.measure` / `.folder`, mark helpers, `measurementsGroup`         |
| `packages/ui/src/actions/{types,registry}.ts`                               | 1    | `{ kind: 'measurements' }` target, `targetCount`                                                     |
| `packages/ui/src/tree/RenameField.tsx`                                      | 1    | `maxLength` prop (default 80)                                                                        |
| `packages/ui/src/i18n/en.ts`                                                | 1    | every new string of this plan                                                                        |
| `apps/desktop/src/renderer/survey/measureVisibility.ts` (new)               | 2    | per-project hidden ids in `localStorage`, session fallback                                           |
| `apps/desktop/src/renderer/survey/measureStore.ts`                          | 2, 6 | persisted hiding, colour, rename, reveal and new-folder requests (2); `listOpen` retired (6)         |
| `apps/desktop/src/renderer/survey/measureRows.ts` (new)                     | 3    | tree rows from the store: value, meta, folders, dimming                                              |
| `packages/ui/src/tree/DatasetTree.tsx`, `DateTree.tsx`                      | 4    | measurement rows, folder rows, eyes, rename, new folder row, reveal; `after` groups in the date tree |
| `apps/desktop/src/renderer/styles.css`                                      | 4    | `.tsw` swatch, `.titem.dim`                                                                          |
| `apps/desktop/src/renderer/shell/actions/measureActions.tsx` (new)          | 5    | the six actions, presets, `flyToMeasurement`                                                         |
| `apps/desktop/src/renderer/shell/renameRequest.ts`                          | 5    | `measureId`, `askMeasure`                                                                            |
| `apps/desktop/src/renderer/survey/SavedFooter.tsx` (new)                    | 6    | Autosave, status line + Save, Revert, load error, read-only notice, `BulkTotals`                     |
| `apps/desktop/src/renderer/workspace/workbench/benches/MeasureBench.tsx`    | 6    | `Saved` section out, `SavedFooter` in (shared file with `feat/antenna-review`)                       |
| `apps/desktop/src/renderer/survey/MeasurementList.tsx` (+ test)             | 6    | deleted                                                                                              |
| `apps/desktop/src/renderer/shell/Sidebar.tsx`, `menuTargets.ts`             | 7    | wiring: rows, menus, marks, selection, rename, new folder, reveal                                    |
| `apps/desktop/src/renderer/survey/measureHits.ts` (new)                     | 8    | pure screen-space hit test                                                                           |
| `apps/desktop/src/renderer/survey/measurePick.ts` (new)                     | 8    | 3D and map listeners: left-click select, right-click menu, priority, blocking                        |
| `apps/desktop/src/renderer/survey/MeasureMenu.tsx` (new)                    | 8    | the views' context menu                                                                              |
| `apps/desktop/src/renderer/survey/MeasureToolbar.tsx`                       | 8    | `MeasureLayer` mounts the pick and the menu                                                          |
| `apps/desktop/e2e/island.ts`, specs, `e2e/measurement-layers.spec.ts` (new) | 9    | helpers and migration off the old list; the new spec                                                 |

Unit tests run from the repo root: `pnpm vitest run <path>` (root `vitest.config.ts` has the `packages/*` and `apps/*` projects).

---

### Task 1: UI model, menu target, rename cap and strings

**Files:**

- Modify: `packages/ui/src/tree/model.ts`, `packages/ui/src/actions/types.ts`, `packages/ui/src/actions/registry.ts`, `packages/ui/src/tree/RenameField.tsx`, `packages/ui/src/i18n/en.ts`
- Test: `packages/ui/src/tree/model.test.ts`, `packages/ui/src/actions/registry.test.ts`, `packages/ui/src/tree/RenameField.test.tsx`

**Interfaces:**

- Consumes: nothing new.
- Produces (all exported from `@aio/ui` through the existing `export * from './tree/model'` and `./actions`):
  - `TreeGroupKind` gains `'measurements'`; `GROUPS` gains `{ kind: 'measurements', label: 'Measurements', icon: 'measure' }` directly after `maps`.
  - `TreeItem.measure?: { id: string; color: string; dimmed: boolean; dimmedWhy?: string }` (a measurement row; its `id` is `measureMark(measure.id)`).
  - `TreeItem.folder?: string` (a measurement folder row; its rows are `children`; its `id` is `measure-folder:<name>`).
  - `MEASURE_MARK = 'measure:'`, `measureMark(id: string): string`, `measureIdOf(mark: string): string | null`.
  - `itemMeasureIds(it: TreeItem): string[]`, `groupMeasureIds(g: TreeGroup): string[]`.
  - `measurementsGroup(items: readonly TreeItem[]): TreeGroup | null` (null when empty; `count` = measurement rows including folder children).
  - `TreeOptions.measurements?: readonly TreeItem[] | undefined`; `buildDatasetTree` puts them in the `measurements` group.
  - `MenuTarget` gains `{ kind: 'measurements'; ids: string[]; clicked: string }`; `targetCount` returns `ids.length` for it.
  - `RenameField` prop `maxLength?: number` (default 80).
  - i18n keys (exact copy, no dashes):
    - `tree.measure.folderName`: `Name of the new folder`
    - `tree.measure.dimmed`: `Hidden with {date}`
    - `tree.measure.invalid`: `Invalid picks`
    - `tree.measure.folderCount`: `{count}`
    - `actions.header.measurements_one`: `{count} measurement`, `actions.header.measurements_other`: `{count} measurements`
    - `actions.measure.rename`: `Rename`, `actions.measure.colour`: `Colour`, `actions.measure.show`: `Show`, `actions.measure.hide`: `Hide`, `actions.measure.flyTo`: `Fly to`, `actions.measure.moveToFolder`: `Move to folder`, `actions.measure.noFolder`: `No folder`, `actions.measure.newFolder`: `New folder…`, `actions.measure.inFolder`: `Already in this folder`, `actions.measure.delete`: `Delete`, `actions.measure.deleteCount_one`: `Delete {count} measurement`, `actions.measure.deleteCount_other`: `Delete {count} measurements`, `actions.measure.notFound`: `This measurement is no longer in the project.`
    - Colour names: `actions.measure.colour.yellow` `Yellow`, `.red` `Red`, `.green` `Green`, `.blue` `Blue`, `.purple` `Purple`, `.orange` `Orange`, `.white` `White`, `.grey` `Grey`
    - Saved footer (moved from hard-coded English in `MeasurementList.tsx`): `measureBench.saved.autosave` `Autosave`, `measureBench.saved.autosaveTip` `Off by default: save when you are ready`, `measureBench.saved.unsaved` `Unsaved changes`, `measureBench.saved.unwritten` `New results not saved yet`, `measureBench.saved.all` `All saved`, `measureBench.saved.revert` `Revert`, `measureBench.saved.save` `Save`, `measureBench.saved.readOnly` `Read-only package: measurements are shown only.`, `measureBench.saved.label` `Saving measurements`

- [ ] **Step 1: Write the failing tests**

```ts
// model.test.ts
it('puts the Measurements group right after Maps and rasters', () => {
  const rows: TreeItem[] = [
    { id: 'measure:a', name: 'A', measure: { id: 'a', color: '#ffd166', dimmed: false } },
    {
      id: 'measure-folder:Fence',
      name: 'Fence',
      folder: 'Fence',
      children: [
        { id: 'measure:b', name: 'B', measure: { id: 'b', color: '#ffd166', dimmed: false } },
      ],
    },
  ];
  const groups = buildDatasetTree(
    manifestWithMeshAndRasterAndPhotos,
    [],
    {},
    { measurements: rows },
  );
  expect(groups.map((g) => g.kind)).toEqual(['models', 'maps', 'measurements', 'photos']);
  const m = groups.find((g) => g.kind === 'measurements');
  expect(m?.count).toBe(2);
  expect(m && groupMeasureIds(m)).toEqual(['a', 'b']);
  expect(m && groupLayerIds(m)).toEqual([]);
  expect(treeLayerIds(groups)).not.toContain('a');
});
it('namespaces measurement marks', () => {
  expect(measureMark('m1')).toBe('measure:m1');
  expect(measureIdOf('measure:m1')).toBe('m1');
  expect(measureIdOf('layer-1')).toBeNull();
});
it('has no Measurements group without measurements', () => {
  expect(measurementsGroup([])).toBeNull();
});
// registry.test.ts
it('counts a measurements target by its ids', () => {
  expect(targetCount({ kind: 'measurements', ids: ['a', 'b'], clicked: 'a' })).toBe(2);
});
// RenameField.test.tsx
it('takes a longer cap for measurement labels', () => {
  // render <RenameField maxLength={200} .../>; expect(input.maxLength).toBe(200)
  // render without the prop; expect(input.maxLength).toBe(80)
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run packages/ui/src/tree/model.test.ts packages/ui/src/actions/registry.test.ts packages/ui/src/tree/RenameField.test.tsx`
Expected: FAIL (`measureMark` not exported, `'measurements'` not a group kind).

- [ ] **Step 3: Implement** the Produces list above in the named files. `buildDatasetTree` fills the `measurements` group from `opts.measurements` via `measurementsGroup`; the existing `filter((g) => g.items.length > 0)` drops it when empty. Add the i18n keys to `en.ts` next to `actions.layer.*` / `tree.*` / `measureBench.*`.

- [ ] **Step 4: Run them to see them pass** (same command), then `pnpm vitest run packages/ui/src/i18n` (catalogue has no problems, no dashes).

- [ ] **Step 5: Commit** `feat(ui): measurements tree group, menu target and strings`

---

### Task 2: Remembered visibility and store edits

**Files:**

- Create: `apps/desktop/src/renderer/survey/measureVisibility.ts`
- Modify: `apps/desktop/src/renderer/survey/measureStore.ts`
- Test: `apps/desktop/src/renderer/survey/measureVisibility.test.ts` (new), `apps/desktop/src/renderer/survey/measureStore.test.ts`

**Interfaces:**

- Consumes: nothing from other tasks.
- Produces:
  - `measureVisibility.ts`: `HIDDEN_KEY = 'quadrion.measure.hidden'` (storage key `${HIDDEN_KEY}:${projectId}`, value a JSON array of ids); `interface MeasureVisibilityMemory { load(projectId: string): string[]; save(projectId: string, ids: readonly string[]): void }`; `createMeasureVisibilityMemory(storage: Storage | null): MeasureVisibilityMemory` (session `Map` fallback, every storage call in try/catch, malformed JSON reads as `[]`); `measureStorage(): Storage | null` (guarded `window.localStorage`, as `lineUpStart.ts` `storage()`).
  - `measureStore.ts`:
    - `setMeasureVisibilityMemory(m: MeasureVisibilityMemory): void` (tests inject; default `createMeasureVisibilityMemory(measureStorage())`).
    - `loadMeasurements` on success sets `hiddenMeasurements` to `memory.load(projectId)` filtered to ids in the loaded file, and writes the pruned list back when it shrank.
    - `setMeasurementsHidden(ids: readonly string[], hidden: boolean): void` (one `set`, persists, clears `editing` when the focused one is hidden); `setMeasurementHidden(id, hidden)` delegates to it.
    - `setMeasurementColour(ids: readonly string[], color: string): void` (one `changed()`; `style.color = color`; `style.fill = color` only when `fill === old color`; a measurement without `style` gets `{ color }`; no-op when `readOnly`).
    - `renameMeasurement(id: string, label: string): boolean` (trims; false and no change for empty, over 200, unchanged or `readOnly`; else `patchMeasurement(id, { label })`).
    - `measureFolders(file: MeasurementsFile): string[]` (distinct trimmed non-empty folders, collator A to Z).
    - State `reveal: { id: string | null; seq: number; openSidebar: boolean } | null` and `revealMeasurement(id: string | null, opts?: { openSidebar?: boolean }): void` (default `openSidebar: true`, `seq` increments).
    - State `newFolder: { ids: string[]; seq: number } | null`, `askNewFolder(ids: readonly string[]): void` (also `revealMeasurement(ids[0] ?? null)`), `endNewFolder(): void`.
    - `startTool`, `addMeasurement`, `startEditing` no longer write `measurementsVisible: true`. `measurementsVisible` and `setMeasurementsVisible` stay (no UI calls them any more; `measureScene.test.ts` still does).
  - `listOpen` is untouched here (Task 6 retires it).

- [ ] **Step 1: Write the failing tests**

```ts
// measureVisibility.test.ts
it('remembers hidden ids per project', () => {
  const s = memoryStorage(); // a Map-backed Storage stub in the test
  const m = createMeasureVisibilityMemory(s);
  m.save('p1', ['a', 'b']);
  expect(createMeasureVisibilityMemory(s).load('p1')).toEqual(['a', 'b']);
  expect(createMeasureVisibilityMemory(s).load('p2')).toEqual([]);
  expect(s.getItem('quadrion.measure.hidden:p1')).toBe('["a","b"]');
});
it('blocked storage keeps hidden ids for the session', () => {
  const throwing = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  } as unknown as Storage;
  const m = createMeasureVisibilityMemory(throwing);
  expect(() => {
    m.save('p1', ['a']);
  }).not.toThrow();
  expect(m.load('p1')).toEqual(['a']);
  expect(createMeasureVisibilityMemory(null).load('p1')).toEqual([]);
});
it('reads malformed storage as nothing hidden', () => {
  const s = memoryStorage();
  s.setItem('quadrion.measure.hidden:p1', '{oops');
  expect(createMeasureVisibilityMemory(s).load('p1')).toEqual([]);
});

// measureStore.test.ts (bridge mocked as the file already does; memory injected)
it('hiding is personal view state: not unsaved, no write, remembered on reload', async () => {
  // file with m1, m2 loaded for 'p1'
  setMeasurementsHidden(['m1'], true);
  expect(isDirty(measureStore.getState())).toBe(false);
  expect(io.writes).toBe(0);
  measureStore.setState({ projectId: null });
  await loadMeasurements('p1');
  expect(measureStore.getState().hiddenMeasurements).toEqual(['m1']);
});
it('a deleted hidden id survives Revert and is pruned on the next load', async () => {
  setMeasurementsHidden(['m1'], true);
  deleteMeasurements(['m1']);
  revertMeasurements();
  expect(measureStore.getState().hiddenMeasurements).toEqual(['m1']);
  // the file on disk now lacks m1
  measureStore.setState({ projectId: null });
  await loadMeasurements('p1');
  expect(measureStore.getState().hiddenMeasurements).toEqual([]);
  expect(memory.load('p1')).toEqual([]);
});
it('a read-only package still hides and remembers', async () => {
  // readOnly: true from the bridge
  setMeasurementsHidden(['m1'], true);
  expect(memory.load('p1')).toEqual(['m1']);
});
it('drawing and editing do not unhide; a new measurement is visible', () => {
  setMeasurementsHidden(['m1'], true);
  startTool('distance');
  click([0, 0, 0]);
  click([3, 4, 0]);
  drawEvent({ type: 'key', key: 'Enter' }, env);
  const s = measureStore.getState();
  expect(s.hiddenMeasurements).toEqual(['m1']);
  expect(s.hiddenMeasurements).not.toContain(s.focus);
  select(['m2'], 'm2');
  startEditing();
  expect(measureStore.getState().hiddenMeasurements).toEqual(['m1']);
});
it('a preset colour sets the colour, and the fill only when it matched', () => {
  // m1 style { color: '#ffd166', fill: '#ffd166' }, m2 style { color: '#ffd166', fill: '#000000' }
  setMeasurementColour(['m1', 'm2'], '#ef476f');
  expect(style('m1')).toMatchObject({ color: '#ef476f', fill: '#ef476f' });
  expect(style('m2')).toMatchObject({ color: '#ef476f', fill: '#000000' });
  expect(isDirty(measureStore.getState())).toBe(true);
});
it('renames up to 200 characters, never to empty', () => {
  expect(renameMeasurement('m1', '  Fence line  ')).toBe(true);
  expect(label('m1')).toBe('Fence line');
  expect(renameMeasurement('m1', '   ')).toBe(false);
  expect(renameMeasurement('m1', 'x'.repeat(201))).toBe(false);
  expect(renameMeasurement('m1', 'x'.repeat(200))).toBe(true);
});
it('asks the tree to reveal a measurement and to open a new folder', () => {
  revealMeasurement('m1');
  expect(measureStore.getState().reveal).toEqual({ id: 'm1', seq: 1, openSidebar: true });
  askNewFolder(['m1', 'm2']);
  expect(measureStore.getState().newFolder).toEqual({ ids: ['m1', 'm2'], seq: 1 });
  endNewFolder();
  expect(measureStore.getState().newFolder).toBeNull();
});
```

Also replace the existing `measurementsVisible` "tool start / add / edit bring everything back" assertions (`measureStore.test.ts` ~:170-187) with the "do not unhide" test above.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run apps/desktop/src/renderer/survey/measureVisibility.test.ts apps/desktop/src/renderer/survey/measureStore.test.ts`
Expected: FAIL (module and exports missing).

- [ ] **Step 3: Implement** the Produces list. `reveal` and `newFolder` are in `initial()` (null), so a project switch drops them; the `seq` counters are module-level so they keep rising.

- [ ] **Step 4: Run them to see them pass** (same command), plus `pnpm vitest run apps/desktop/src/renderer/survey` (scene and lineup tests still pass).

- [ ] **Step 5: Commit** `feat(survey): remember hidden measurements per project`

---

### Task 3: Tree rows from the store

**Files:**

- Create: `apps/desktop/src/renderer/survey/measureRows.ts`
- Test: `apps/desktop/src/renderer/survey/measureRows.test.ts`

**Interfaces:**

- Consumes: Task 1 `TreeItem.measure`, `TreeItem.folder`, `measureMark`; `@aio/survey` `groupByFolder`, `sortMeasurements`, `measurementReadout`, `formatRow`, `effectiveUnits`, `isTelecomTool`; `knownTemplates` (measureStore); `MEASURE_COLOR` (measureScene, import only); `scopeOnScreen` (`@aio/workspace`); `DatesOnScreen` (measureDates); `formatDate`, `t` (`@aio/ui`).
- Produces:
  - `measureRowValue(m: SurveyMeasurement, s: Pick<MeasureState, 'settings' | 'templates'>): string` — the list's value today: telecom `measurementReadout(m)[0]`, `null` value gives `t('tree.measure.invalid')`; others `measurementReadout(m, {}, tpl?.items).find((r) => r.value !== null)`; formatted with `formatRow(row, effectiveUnits(settings.units, m.units), settings.precision)`; `''` when no row.
  - `buildMeasureItems(s: Pick<MeasureState, 'file' | 'settings' | 'templates'>, manifest: Pick<ProjectManifest, 'captures' | 'layers'> | null, ws: DatesOnScreen): TreeItem[]` — folder rows first (`groupByFolder` order, A to Z), each `{ id: 'measure-folder:<name>', name, folder: name, meta: String(n), children }`, then the loose rows; rows within each sorted with `sortMeasurements(list, 'name')`. A row is `{ id: measureMark(m.id), name: m.label, meta, measure: { id: m.id, color: m.style?.color ?? MEASURE_COLOR, dimmed, dimmedWhy } }`; `meta` is the value, and for a survey-scoped one `${value} · ${formatDate(capture.date)}` (the date alone when the value is empty); `dimmed` is `m.scope.kind === 'survey' && !scopeOnScreen(m.scope, ws.dates, ws.hidden)`, `dimmedWhy` `t('tree.measure.dimmed', { date })`.

- [ ] **Step 1: Write the failing tests**

```ts
it('formats the primary value as the list did', () => {
  expect(measureRowValue(distance25m, st)).toBe('25.00 m'); // site metres, precision 2
  expect(measureRowValue(invalidAzimuth, st)).toBe('Invalid picks');
});
it('folders A to Z first, then loose rows, each sorted by label', () => {
  const items = buildMeasureItems(
    stateWith([m('b', 'Line 10'), m('a', 'Line 2'), m('c', 'Pad', 'Zone'), m('d', 'Kerb', 'Area')]),
    manifest,
    ws,
  );
  expect(items.map((i) => i.name)).toEqual(['Area', 'Zone', 'Line 2', 'Line 10']);
  expect(items[0]?.children?.map((c) => c.id)).toEqual(['measure:d']);
  expect(items[0]?.meta).toBe('1');
});
it('dims a survey measurement whose date is hidden, eye untouched', () => {
  const items = buildMeasureItems(stateWith([surveyScoped('s1', 'oct')]), twoDateManifest, {
    dates: index,
    hidden: { octMesh: true },
  });
  expect(items[0]?.measure).toMatchObject({ id: 's1', dimmed: true });
  expect(items[0]?.meta).toContain('2 Oct 2024'); // whatever formatDate gives for '2024-10-02'
  // hidden ids are not read here: the eye is the tree's
});
it('builds 500 rows sorted, one folder pass', () => {
  const items = buildMeasureItems(
    stateWith(range(500).map((i) => m(`m${i}`, `Line ${i}`, i % 2 ? 'Odd' : ''))),
    manifest,
    ws,
  );
  expect(items[0]?.children).toHaveLength(250);
  expect(items.length).toBe(1 + 250);
  expect(items[1]?.name).toBe('Line 0');
  expect(items[2]?.name).toBe('Line 2');
});
```

- [ ] **Step 2: Run it to see it fail** — `pnpm vitest run apps/desktop/src/renderer/survey/measureRows.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** the two functions in `measureRows.ts`.
- [ ] **Step 4: Run it to see it pass** (same command).
- [ ] **Step 5: Commit** `feat(survey): measurement rows for the dataset tree`

---

### Task 4: The tree draws measurements

**Files:**

- Modify: `packages/ui/src/tree/DatasetTree.tsx`, `packages/ui/src/tree/DateTree.tsx`, `packages/ui/src/index.ts` (export `MeasureTreeProps`), `apps/desktop/src/renderer/styles.css`
- Test: `packages/ui/src/tree/measureTree.test.tsx` (new), `packages/ui/src/tree/DateTree.test.tsx`

**Interfaces:**

- Consumes: Task 1 model, `RenameField maxLength`, i18n keys.
- Produces: `DatasetTreeProps.measures?: MeasureTreeProps | undefined` and `DateTreeProps.after?: readonly TreeGroup[] | undefined` (groups drawn once below the date folders, in the same `role="tree"`, through a nested `DatasetTree` with the same `...rest` props), where

```ts
export interface MeasureTreeProps {
  /** Ids hidden by their own eye (measureStore.hiddenMeasurements as a record). */
  hidden: Readonly<Record<string, true>>;
  /** measureStore.focus, drawn selected. */
  selectedId: string | null;
  onSetVisible: (ids: string[], visible: boolean) => void;
  onSelect: (id: string) => void;
  onMenu: (id: string, at: MenuPoint) => void;
  /** The measurement whose name is a field now; F2 starts it (undefined: read-only). */
  renaming: string | null;
  onRenameStart?: ((id: string) => void) | undefined;
  onRename: (id: string, label: string) => void;
  onRenameEnd: () => void;
  /** A new folder row in rename mode at the top of the group; onNewFolder(null) on cancel. */
  newFolder: { ids: readonly string[]; seq: number } | null;
  onNewFolder: (name: string | null) => void;
  /** Open the group (and the folder holding `id`), show the row past "more", scroll it into view. */
  reveal: { id: string | null; seq: number } | null;
}
```

DOM contract (Task 7 and Task 9 rely on it):

- Row: `role="treeitem"`, `data-testid="measure-row"`, `data-id=<id>`, `data-mark="measure:<id>"` (only when `onMark` is set), classes `titem` + `sel` / `marked` / `hidden` (own eye off) / `dim` (dimmed, with `title=dimmedWhy`); children in order: `<span class="tsw" style="--sw: <color>">`, `.tn` label (or `RenameField testId="measure-rename" maxLength={200}` with label `t('tree.renameLayer', { name })`), `.tm` meta, eye button `data-testid="measure-row-eye"` with `aria-pressed` and `t('tree.row.show'|'tree.row.hide', { name })`.
- Folder row: `data-testid="measure-folder"`, `data-folder=<name>`, chevron toggles open (default open), `folder` icon, `.tn` name, `.tm` count, a `VisibilityEye` over `itemMeasureIds(folder)` with labels `tree.eye.hideGroup/showGroup/showGroupMixed` and `{ group: name }`.
- Group header of `measurements`: a `VisibilityEye` over `groupMeasureIds(g)` against `measures.hidden` (instead of the layer eye, which is empty there).
- New folder row: `RenameField testId="measure-folder-new" maxLength={200}` labelled `t('tree.measure.folderName')`, `initial=''`; Enter with text calls `onNewFolder(name)`, Escape or empty `onNewFolder(null)`.
- Clicks: plain click `onSelect(id)`; Ctrl/Shift click and Ctrl+Space / Shift+Arrow go through the existing `onMark` with the namespaced mark (same code path as layer rows, keyed on `data-mark`); right-click and Shift+F10 / Menu key `onMenu(id, at)`; F2 `onRenameStart(id)`.
- Row limit: loose rows and each folder's rows show `ROW_LIMIT` (8) and a "more" row when over `ROW_LIMIT + 1`; the selected, renaming and revealed rows always show.
- Reveal: adjusted during render on a new `seq` (as `unplaceRequest`): open the group and the folder, show all rows of that folder; a layout effect scrolls the row with `scrollIntoView({ block: 'nearest' })` once it is drawn (works after the rail unfolds).
- CSS (`styles.css`, tokens only, no raw colours): `.tsw { inline-size: 10px; block-size: 10px; border-radius: var(--r-2); background: var(--sw); flex: none; }` and `.titem.dim .tn, .titem.dim .tm { opacity: 0.55; }` (use the token for radius the tree already uses).

- [ ] **Step 1: Write the failing tests** (`measureTree.test.tsx`, jsdom, render `DatasetTree` with one `measurements` group)

```tsx
it('draws a row with swatch, label, value and eye; the eye hides it', () => {
  // items: loose row a 'Line A' meta '42.18 m' colour '#ef476f'
  const row = q('[data-testid="measure-row"][data-id="a"]');
  expect(row.querySelector('.tsw')?.getAttribute('style')).toContain('--sw: #ef476f');
  expect(row.querySelector('.tn')?.textContent).toBe('Line A');
  expect(row.querySelector('.tm')?.textContent).toBe('42.18 m');
  click(row.querySelector('[data-testid="measure-row-eye"]'));
  expect(onSetVisible).toHaveBeenCalledWith(['a'], false);
  expect(onSelect).not.toHaveBeenCalled();
});
it('the group and folder eyes show a mixed state and show all from it', () => {
  // hidden { b: true }, folder Fence holds b and c
  expect(groupEye().dataset.visibility).toBe('mixed');
  expect(folderEye('Fence').dataset.visibility).toBe('mixed');
  click(folderEye('Fence'));
  expect(onSetVisible).toHaveBeenCalledWith(['b', 'c'], true);
});
it('marks with namespaced ids, opens the menu, renames with a 200 cap', () => {
  ctrlClick(row('a').querySelector('.tn'));
  expect(onMark).toHaveBeenCalledWith(
    'measure:a',
    { ctrl: true, shift: false },
    expect.arrayContaining(['measure:a']),
  );
  contextMenu(row('a'), 30, 40);
  expect(onMenu).toHaveBeenCalledWith('a', { x: 30, y: 40 });
  keyDown(row('a'), 'F2');
  expect(onRenameStart).toHaveBeenCalledWith('a');
  // rerender with renaming 'a'
  expect((q('[data-testid="measure-rename"]') as HTMLInputElement).maxLength).toBe(200);
});
it('a dimmed row keeps its own eye open', () => {
  // row s1 measure.dimmed true, hidden {}
  expect(row('s1').classList.contains('dim')).toBe(true);
  expect(row('s1').classList.contains('hidden')).toBe(false);
  expect(
    row('s1').querySelector('[data-testid="measure-row-eye"]')?.getAttribute('aria-pressed'),
  ).toBe('true');
});
it('caps 500 measurement rows per folder until More', () => {
  // one folder of 250, 250 loose
  expect(qa('[data-testid="measure-row"]').length).toBe(16); // 8 + 8
  // reveal { id: 'm499', seq: 1 } shows that row even behind "more"
});
it('reveal opens a closed group and folder and scrolls the row into view', () => {
  // defaultOpen excludes measurements; folder closed by click first
  // rerender with reveal { id: 'b', seq: 1 }
  expect(row('b')).not.toBeNull();
  expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
});
it('a new folder row asks for a name and hands it over', () => {
  // newFolder { ids: ['a'], seq: 1 }
  type(q('[data-testid="measure-folder-new"]'), 'Kerbs');
  press('Enter');
  expect(onNewFolder).toHaveBeenCalledWith('Kerbs');
});
// DateTree.test.tsx
it('draws the after groups once, below the folders', () => {
  // two folders + after=[measurements group with 2 rows]
  expect(qa('[data-testid="measure-row"]').length).toBe(2);
  expect(lastChildOfTree().textContent).toContain('Measurements');
});
```

- [ ] **Step 2: Run them to see them fail** — `pnpm vitest run packages/ui/src/tree` → new tests FAIL.
- [ ] **Step 3: Implement** in `DatasetTree.tsx`: a `measureRow(it)` and `measureFolderRow(it)` used when `g.kind === 'measurements'` (before the flight / layer routing), the header eye switch, and the reveal and new-folder state; `DateTree.tsx` `after`. Leave layer rows' code paths as they are.
- [ ] **Step 4: Run them to see them pass** — `pnpm vitest run packages/ui/src/tree` (existing `eyes`, `menuKeys`, `walkRows`, `DatasetTree` tests still pass).
- [ ] **Step 5: Commit** `feat(ui): measurement rows, folders and eyes in the dataset tree`

---

### Task 5: The measurement menu actions

**Files:**

- Create: `apps/desktop/src/renderer/shell/actions/measureActions.tsx`
- Modify: `apps/desktop/src/renderer/shell/actions/index.ts`, `apps/desktop/src/renderer/shell/renameRequest.ts`
- Test: `apps/desktop/src/renderer/shell/actions/measureActions.test.ts` (new), `apps/desktop/src/renderer/shell/actions/parity.test.ts`

**Interfaces:**

- Consumes: Task 1 target and keys; Task 2 `setMeasurementsHidden`, `setMeasurementColour`, `setFolder`, `deleteMeasurements`, `measureFolders`, `askNewFolder`, `revealMeasurement`, `measureStore`; `focusPoint`, `frameOf` (measureScene, read only); `editBlocked` (reasons.ts); `getActiveScene` (`@aio/engine`).
- Produces:
  - `renameRequest`: `measureId: string | null`, `askMeasure(id: string): void` (sets `measureId`, clears `layerId`); `ask` clears `measureId`; `done` clears both.
  - `MEASURE_COLOURS: readonly { id: string; hex: string; label: MessageKey }[]` = yellow `#ffd166`, red `#ef476f`, green `#06d6a0`, blue `#118ab2`, purple `#9b5de5`, orange `#f78c40`, white `#ffffff`, grey `#94a3b8` (not the draft `#4cc9f0` or snap `#ff5ccd` colours).
  - `measureEditBlocked(ctx: ActionCtx): string | false` = `editBlocked(ctx) || (measureStore.getState().readOnly ? t('actions.reason.package') : false)`.
  - `flyToMeasurement(id: string): boolean` — the `MeasurementList` `ItemMenu` path: `shell.go('scene')` when elsewhere, `focusPoint(m, frameOf(manifest))`, `workspace.getState().flyTo({ kind: 'point', p, distance })`, `getActiveScene()?.requestRender()`; false when the measurement or manifest is missing. (Follow-up once `feat/antenna-review` lands: switch to `flyToLocalBox(points, pad?)` from `workspace/flyToBox.ts`.)
  - `registerMeasureActions(): () => void`, registered by `registerSidebarActions()`. Actions, all `targets: ['measurements']`, registration order = menu order:

| id                     | label                                                                     | section  | multi | present / sub ids                                                                                                                                                                                                                                                                                   | disabled             | run                                                                                        |
| ---------------------- | ------------------------------------------------------------------------- | -------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------ |
| `measure.rename`       | `actions.measure.rename`, shortcut `tree.rename`                          | `edit`   | true  |                                                                                                                                                                                                                                                                                                     | `measureEditBlocked` | `renameRequest.askMeasure(clicked)`; `revealMeasurement(clicked)`                          |
| `measure.colour`       | `actions.measure.colour`                                                  | `edit`   | true  | `picks`; one `SubItem` per preset: `id: hex`, `swatch: hex`, `testId: measure-colour-<id>`, `checked` when every target has it                                                                                                                                                                      | `measureEditBlocked` | `setMeasurementColour(ids, sub)`                                                           |
| `measure.visibility`   | `actions.measure.hide` when any target shows, else `actions.measure.show` | `edit`   | true  |                                                                                                                                                                                                                                                                                                     | never                | `setMeasurementsHidden(ids, anyShown)` (shown = not in `hiddenMeasurements`)               |
| `measure.flyTo`        | `actions.measure.flyTo`                                                   | `edit`   | true  |                                                                                                                                                                                                                                                                                                     | never                | `flyToMeasurement(clicked)` or `ctx.host.note(t('actions.measure.notFound'), true)`        |
| `measure.moveToFolder` | `actions.measure.moveToFolder`                                            | `edit`   | true  | `submenu`; `to:<folder>` per `measureFolders` (icon `folder`, disabled `actions.measure.inFolder` when all are in it), `none` (`actions.measure.noFolder`), `new` (`actions.measure.newFolder`, icon `plus`); test ids `measure-folder-to-<folder>`, `measure-folder-to-none`, `measure-folder-new` | `measureEditBlocked` | `to:` → `setFolder(ids, name)`; `none` → `setFolder(ids, '')`; `new` → `askNewFolder(ids)` |
| `measure.delete`       | `actions.measure.delete`, or `actions.measure.deleteCount` when 2+        | `danger` | true  |                                                                                                                                                                                                                                                                                                     | `measureEditBlocked` | `deleteMeasurements(ids)` (immediate, as the old list; Revert undoes until saved)          |

- [ ] **Step 1: Write the failing tests** (`measureActions.test.ts`, jsdom; `measureStore` seeded with m1 `#ffd166` in no folder, m2 in `Fence`)

```ts
const ids = (target: MenuTarget, c = ctx()) => actionsFor(target, c).map((i) => i.id);
it('offers the founder order on one measurement', () => {
  expect(ids({ kind: 'measurements', ids: ['m1'], clicked: 'm1' })).toEqual([
    'measure.rename',
    'measure.colour',
    'measure.visibility',
    'measure.flyTo',
    'measure.moveToFolder',
    'measure.delete',
  ]);
});
it('several marked: every item still shows; Rename and Fly to act on the clicked one', () => {
  const items = actionsFor({ kind: 'measurements', ids: ['m1', 'm2'], clicked: 'm2' }, ctx());
  items.find((i) => i.id === 'measure.rename')?.run();
  expect(renameRequest.getState().measureId).toBe('m2');
  expect(items.find((i) => i.id === 'measure.delete')?.label).toBe('Delete 2 measurements');
  items.find((i) => i.id === 'measure.visibility')?.run();
  expect(measureStore.getState().hiddenMeasurements).toEqual(['m1', 'm2']);
});
it('colours from eight presets, the default yellow among them', () => {
  const colour = actionsFor(one('m1'), ctx()).find((i) => i.id === 'measure.colour');
  expect(colour?.sub.map((s) => s.swatch)).toEqual([
    '#ffd166',
    '#ef476f',
    '#06d6a0',
    '#118ab2',
    '#9b5de5',
    '#f78c40',
    '#ffffff',
    '#94a3b8',
  ]);
  expect(colour?.sub[0]?.checked).toBe(true);
  colour?.run('#06d6a0');
  expect(styleOf('m1').color).toBe('#06d6a0');
});
it('moves to a folder, out of one, or into a new one', () => {
  const move = () => actionsFor(one('m1'), ctx()).find((i) => i.id === 'measure.moveToFolder');
  expect(move()?.sub.map((s) => s.id)).toEqual(['to:Fence', 'none', 'new']);
  move()?.run('to:Fence');
  expect(folderOf('m1')).toBe('Fence');
  move()?.run('none');
  expect(folderOf('m1')).toBeUndefined();
  move()?.run('new');
  expect(measureStore.getState().newFolder?.ids).toEqual(['m1']);
});
it('a read-only package greys the edits and keeps Hide and Fly to', () => {
  measureStore.setState({ readOnly: true });
  const items = actionsFor(one('m1'), ctx({ pkg: true, canEdit: false }));
  const why = (id: string) => items.find((i) => i.id === id)?.disabled;
  for (const id of ['measure.rename', 'measure.colour', 'measure.moveToFolder', 'measure.delete'])
    expect(why(id), id).toBe(t('actions.reason.package'));
  expect(why('measure.visibility')).toBe(false);
  expect(why('measure.flyTo')).toBe(false);
});
it('Fly to frames the measurement through the workspace', () => {
  const fly = vi.spyOn(workspace.getState(), 'flyTo');
  expect(flyToMeasurement('m1')).toBe(true);
  expect(fly).toHaveBeenCalledWith(expect.objectContaining({ kind: 'point' }));
  expect(flyToMeasurement('gone')).toBe(false);
});
// parity.test.ts: a layers target offers no measure.* item
it('a dataset row offers no measurement items', () => {
  expect(
    offered({ kind: 'layers', layerIds: ['v'] }).some((id) => id.startsWith('ctx-item-measure.')),
  ).toBe(false);
});
```

- [ ] **Step 2: Run them to see them fail** — `pnpm vitest run apps/desktop/src/renderer/shell/actions` → FAIL.
- [ ] **Step 3: Implement** `measureActions.tsx`, `renameRequest.ts`, and add `registerMeasureActions()` to `registerSidebarActions()`.
- [ ] **Step 4: Run them to see them pass** (same command).
- [ ] **Step 5: Commit** `feat(shell): right-click actions for measurements`

---

### Task 6: Retire "Saved in this project"

**Files:**

- Create: `apps/desktop/src/renderer/survey/SavedFooter.tsx`
- Modify: `apps/desktop/src/renderer/workspace/workbench/benches/MeasureBench.tsx` (remove `Saved` ~:830-853 and its imports; add the footer; do not touch the `AntennaSection` line), `apps/desktop/src/renderer/survey/measureStore.ts`, `apps/desktop/src/renderer/survey/TelecomTools.tsx:126`, `apps/desktop/src/renderer/workspace/workbench/measureFollow.ts:76`, `apps/desktop/src/renderer/survey/measure.css` (drop `.sv-list`, `.sv-bulk`, `.sv-items`, `.sv-item*` rules; keep `.sv-foot`, `.sv-check`, `.sv-grow` if the footer uses them), unused i18n keys (`wb.saved`, `wb.showAll`, `measureBench.showOne`, `measureBench.hideOne`, `measureBench.moreFor`, `measureBench.flyTo`, `measureBench.delete`, `survey.list.*`: delete each only after `grep` shows no other user)
- Delete: `apps/desktop/src/renderer/survey/MeasurementList.tsx`, `apps/desktop/src/renderer/survey/MeasurementList.test.tsx`
- Test: `apps/desktop/src/renderer/workspace/workbench/benches/MeasureBench.test.tsx`, `apps/desktop/src/renderer/survey/measureStore.test.ts`, `apps/desktop/src/renderer/workspace/workbench/measureFollow.test.ts`, `apps/desktop/src/renderer/survey/TelecomTools.test.tsx`

**Interfaces:**

- Consumes: Task 1 keys; Task 2 `revealMeasurement`.
- Produces:
  - `SavedFooter(): JSX.Element | null` — `data-testid="survey-saved"`, `role="group"`, `aria-label={t('measureBench.saved.label')}`; load error `status === 'error'` as `p.notice.danger[role=alert][data-testid="survey-saved-error"]`; read-only: `data-testid="survey-list-readonly"` with `measureBench.saved.readOnly`; otherwise Autosave checkbox (`data-testid="survey-autosave"`), the status line (`message ?? unsaved/unwritten/all`), Revert when dirty, Save `data-testid="survey-list-save"` disabled when `(!dirty && !unwritten) || saving`; then `<BulkTotals />`. Returns null while no project is loaded (`status === 'idle'`).
  - `MeasureBench` renders `{!searching && <SavedFooter />}` right after the live/pending/selected block (under the Selected panel), in both live and idle modes.
  - `measureStore`: `listOpen` and `setListOpen` removed; `startTool` drops `listOpen: false`; `drawEvent` replaces both `set({ listOpen: true })` with `revealMeasurement(m.id, { openSidebar: false })`.
  - `TelecomTools` "Measurements" button: `revealMeasurement(focus ?? null)` (opens the sidebar, the group and the row).
  - `measureFollow`: the `s.listOpen` line goes (the test store type drops `listOpen`).

- [ ] **Step 1: Write / update the failing tests**

```ts
// MeasureBench.test.tsx (rename the test at :147)
it('M in a normal project starts Distance and Enter puts it in the tree, unsaved', () => {
  // ... as today, then:
  expect(q('wb-section-measurements')).toBeNull();
  expect(q('survey-saved')?.textContent).toContain('Unsaved changes');
  expect(measureStore.getState().reveal).toMatchObject({
    id: measureStore.getState().focus,
    openSidebar: false,
  });
});
it('the Saved footer keeps Autosave, Revert, Save, the read-only notice and the load error', () => {
  // dirty: Revert and an enabled survey-list-save; readOnly: survey-list-readonly and no save; status 'error': survey-saved-error
});
// the search tests at :328-370: 'the saved list steps aside' now asserts q('survey-saved') is null while searching and back after clearing
// measureStore.test.ts: the 'a normal Distance ...' test asserts reveal instead of listOpen
expect(s.reveal).toEqual({ id: s.focus, seq: expect.any(Number), openSidebar: false });
// TelecomTools.test.tsx
it('Measurements reveals the picked measurement in the tree', () => {
  // focus 'az1'; click the 'Measurements' button
  expect(measureStore.getState().reveal).toMatchObject({ id: 'az1', openSidebar: true });
});
```

- [ ] **Step 2: Run them to see them fail** — `pnpm vitest run apps/desktop/src/renderer/workspace/workbench apps/desktop/src/renderer/survey` → FAIL.
- [ ] **Step 3: Implement** the Produces list; delete `MeasurementList.tsx` and its test (`grep -r "MeasurementList" apps/desktop/src` must be empty).
- [ ] **Step 4: Run them to see them pass** (same command) and `pnpm typecheck` (no `listOpen` left: `grep -rn "listOpen" apps/desktop/src` empty).
- [ ] **Step 5: Commit** `refactor(measure): saved list leaves the bench for the tree`

---

### Task 7: Sidebar wiring

**Files:**

- Modify: `apps/desktop/src/renderer/shell/Sidebar.tsx`, `apps/desktop/src/renderer/shell/menuTargets.ts`
- Test: `apps/desktop/src/renderer/shell/Sidebar.measures.test.tsx` (new, set up as `Sidebar.test.tsx`), `apps/desktop/src/renderer/shell/menuTargets.test.ts`

**Interfaces:**

- Consumes: Task 1 (`measurementsGroup`, `measureIdOf`, `TreeOptions.measurements`, target), Task 2 store functions and `reveal` / `newFolder`, Task 3 `buildMeasureItems`, Task 4 `MeasureTreeProps` and `DateTree.after`, Task 5 `renameRequest.measureId` and registered actions, `TreeMenu`.
- Produces:
  - `menuTargets.ts`: `measureTarget(id: string, marked: ReadonlySet<string>): Extract<MenuTarget, { kind: 'measurements' }>` (the marked measurement ids when `id` is one of 2+ marked, else `[id]`; `clicked: id`); `rowTarget` ignores `measure:` marks; `menuTitle` case `measurements`: 2+ gives `t('actions.header.measurements', { count })`, else `name`.
  - In `Datasets`:
    - `measureItems = useMemo(buildMeasureItems(measureState, manifest, { dates, hidden }))` over `file`, `settings`, `templates`, `manifest`, `dates`, `hidden`; hidden record `useMemo` from `hiddenMeasurements`.
    - Dates off: `buildDatasetTree(..., { unplaced, measurements: measureItems })`. Dates on: `DateTree after={[measurementsGroup(measureItems)].filter(Boolean)}`.
    - `measures` props: `onSetVisible: (ids, v) => setMeasurementsHidden(ids, !v)`; `onSelect: (id) => { setMarks(NO_MARKS); select([id], id); }`; `onMenu: openMeasure`; rename from `renameRequest.measureId` when `canMeasureEdit = canEdit && !measureReadOnly`, `onRename: renameMeasurement`, `onRenameEnd: renameRequest.done`; `newFolder` from the store, `onNewFolder: (name) => { if (name) setFolder(newFolder.ids, name); endNewFolder(); }`; `reveal` from the store.
    - `openMeasure(id, at)`: `setMenu({ target: measureTarget(id, marks.marked), ...at, title: menuTitle(...), label: t('actions.menu.label', { name }), testId: 'measure-menu', host: {} })`.
    - Marks: after `nextMarks`, the measurement marks go to the store: `select(ids)` when 1 or more measurement ids are marked (so `BulkTotals` totals the marked polygons).
    - The marked header's Delete and the Delete key: measurement marks (or a focused measurement row) go to `deleteMeasurements` when `!measureReadOnly`, layer marks to `askLayers` as today.
    - The keyboard menu (`isMenuKey`) on a row whose `data-mark` is a measurement mark opens `openMeasure`.
  - In `Sidebar`: an effect on `reveal.seq` that, when `openSidebar` and `isSidebarFolded`, calls `shell.getState().toggleSidebar()`.

- [ ] **Step 1: Write the failing tests**

```ts
// menuTargets.test.ts
it('a measurement menu takes the marked measurements and ignores marked layers', () => {
  const marked = new Set(['measure:a', 'measure:b', 'layer1']);
  expect(measureTarget('a', marked)).toEqual({
    kind: 'measurements',
    ids: ['a', 'b'],
    clicked: 'a',
  });
  expect(measureTarget('c', marked)).toEqual({ kind: 'measurements', ids: ['c'], clicked: 'c' });
  expect(rowTarget({ id: 'layer1', layerId: 'layer1', name: 'L' }, marked)).toEqual({
    kind: 'layers',
    layerIds: ['layer1'],
  });
});
// Sidebar.measures.test.tsx (project with a mesh layer; measureStore with a, b in 'Fence', c)
it('lists measurements after the maps, hides from the eye without marking the file unsaved', () => {
  expect(groupOrder()).toEqual(['models', 'measurements']);
  click(row('a').querySelector('[data-testid="measure-row-eye"]'));
  expect(measureStore.getState().hiddenMeasurements).toEqual(['a']);
  expect(isDirty(measureStore.getState())).toBe(false);
});
it('a plain click selects the measurement for the Selected panel', () => {
  click(row('c').querySelector('.tn'));
  expect(measureStore.getState().focus).toBe('c');
});
it('right-click on a marked row acts on every marked measurement', () => {
  ctrlClick(row('a').querySelector('.tn'));
  ctrlClick(row('c').querySelector('.tn'));
  expect(measureStore.getState().selected).toEqual(['a', 'c']);
  contextMenu(row('c'));
  expect(q('[data-testid="measure-menu"]')?.textContent).toContain('2 measurements');
});
it('mixed marks: a layer row menu acts on layers only, the header deletes both kinds', () => {
  ctrlClick(layerRowName('mesh'));
  ctrlClick(row('a').querySelector('.tn'));
  contextMenu(layerRow('mesh'));
  expect(q('[data-testid="move-menu"]')?.textContent).not.toContain('2 datasets');
  click(q('[data-testid="tree-marked-delete"]'));
  expect(measureStore.getState().file.measurements.map((m) => m.id)).not.toContain('a');
  expect(askRemove).toHaveBeenCalledWith([{ layer: 'mesh' }]);
});
it('Rename from the menu turns the row into a 200 character field', () => {
  // open menu on a, click ctx-item-measure.rename, type 'Fence post' + Enter
  expect(labelOf('a')).toBe('Fence post');
});
it('New folder asks in the tree and moves the measurements into it', () => {
  askNewFolder(['c']);
  type(q('[data-testid="measure-folder-new"]'), 'Kerbs');
  press('Enter');
  expect(folderOf('c')).toBe('Kerbs');
  expect(q('[data-testid="measure-folder"][data-folder="Kerbs"]')).not.toBeNull();
});
it('with survey dates on, the group shows once below the date folders', () => {
  // two captures in the manifest
  expect(qa('[data-testid="measure-row"]')).toHaveLength(3);
});
it('a reveal opens a folded sidebar', () => {
  // settings.sidebarCollapsed true
  revealMeasurement('b');
  expect(shell.getState().settings.sidebarCollapsed).toBe(false);
});
it('a read-only package shows the rows and eyes, and no rename field', () => {
  measureStore.setState({ readOnly: true });
  keyDown(row('a'), 'F2');
  expect(q('[data-testid="measure-rename"]')).toBeNull();
});
```

- [ ] **Step 2: Run them to see them fail** — `pnpm vitest run apps/desktop/src/renderer/shell` → FAIL.
- [ ] **Step 3: Implement** the Produces list in `Sidebar.tsx` and `menuTargets.ts`.
- [ ] **Step 4: Run them to see them pass** — `pnpm vitest run apps/desktop/src/renderer/shell` (existing `Sidebar.test.tsx` marks and Delete tests still pass).
- [ ] **Step 5: Commit** `feat(shell): measurements in the Datasets sidebar`

---

### Task 8: Pick and menu in 3D and on the map

**Files:**

- Create: `apps/desktop/src/renderer/survey/measureHits.ts`, `apps/desktop/src/renderer/survey/measurePick.ts`, `apps/desktop/src/renderer/survey/MeasureMenu.tsx`
- Modify: `apps/desktop/src/renderer/survey/MeasureToolbar.tsx` (`MeasureLayer` only)
- Test: `apps/desktop/src/renderer/survey/measureHits.test.ts`, `apps/desktop/src/renderer/survey/measurePick.test.ts`, `apps/desktop/src/renderer/survey/MeasureMenu.test.tsx`

**Interfaces:**

- Consumes: Task 1 target; Task 2 `select`, `revealMeasurement`; Task 5 actions (MeasureMenu calls `registerSidebarActions()`, which is idempotent); `shapesOf`, `frameOf`, `Frame` (measureScene, read only); `primaryScene`, `primaryMap` (`workspace/compare`); `claimEvent`, `isClaimed`, `rigHit` (`builder/droneHits`); `photosAt3d`, `CLICK_PX` (`builder/PhotoMenu`); `drawnPins`, `pinsAt` (`pins/pinModel`), `placedPanos` (`pins/PinMenu`); `markersHit` (`@aio/engine`); `toastHost` (shell/actions); `ContextMenu`, `actionsFor`, `makeActionCtx` (`@aio/ui`).
- Produces:
  - `measureHits.ts` (pure):
    - `HIT_PX = 6`
    - `interface HitShape { id: string; points: readonly SitePoint[]; closed: boolean }`
    - `distanceToSegment(p: ScreenPt, a: ScreenPt, b: ScreenPt): number`
    - `insideRing(p: ScreenPt, ring: readonly ScreenPt[]): boolean`
    - `measureAt(shapes: readonly HitShape[], toScreen: ToScreen, x: number, y: number, tol = HIT_PX): string | null`
  - `measurePick.ts`:
    - `pickBlocked(s: Pick<MeasureState, 'tool' | 'draw' | 'editing'>): boolean` (any non-null)
    - `interface MeasureMenuAt { x: number; y: number; id: string; projectId: string }`
    - `attachMeasurePick3d(stage: EngineStage, frame: Frame, onMenu: (m: MeasureMenuAt) => void): () => void`
    - `attachMeasurePickMap(ctl: MapController, frame: Frame, onMenu: (m: MeasureMenuAt) => void): () => void`
  - `MeasureMenu({ at, onClose }: { at: MeasureMenuAt | null; onClose: () => void })` — `ContextMenu` with `testId="measure-menu"`, items `actionsFor({ kind: 'measurements', ids, clicked: at.id }, ctx)` where `ids` are `measureStore.selected` when it holds `at.id` and 2+, else `[at.id]`; ctx `makeActionCtx({ manifest, hidden, pkg, canEdit: !pkg && !lookOnly, host: toastHost(label) })`; nothing when the project changed or the measurement is gone.
  - `MeasureLayer`: `const [menuAt, setMenuAt] = useState<MeasureMenuAt | null>(null)`; the 3D effect also calls `attachMeasurePick3d(stage, frame, setMenuAt)`, the map effect `attachMeasurePickMap(map, frame, setMenuAt)`; the portal adds `<MeasureMenu at={menuAt} onClose={...} />`. Split, compare and display-only panes get nothing.

`measureAt` is the one algorithm the signatures do not fix:

```ts
// 1. edges and vertices: the nearest within `tol` wins (later shapes win ties: drawn on top)
for (const sh of shapes) {
  const pts = sh.points.map(toScreen);
  // a vertex: hypot(p - cursor); a segment i..i+1 (and last..first when closed and 3+ points):
  // distanceToSegment, skipped when either end is null (behind the camera)
}
// 2. nothing near an edge: a closed shape of 3+ points whose screen ring holds the cursor
//    (even-odd ray cast, `insideRing`); the smallest screen area (shoelace) wins
// 3. else null
// distanceToSegment: project p on ab, clamp t to [0, 1], distance to that point (a == b: distance to a)
```

Listener rules (both views):

- Right-click: track `pointerdown` with `button === 2` (capture) and on `contextmenu` require the pointer to have moved at most `CLICK_PX`. Listen on `window` in the bubble phase and only for events inside the 3D pane / map container, so the pane-level drone, photo and pin menus run first; skip when `isClaimed(e)`, when `pickBlocked(measureStore.getState())`, or when no id is hit. A hit: `e.preventDefault()`, `claimEvent(e)`, `onMenu({ x, y, id, projectId })`.
- Left click, 3D: `stage.claimClicks(handler)`; return false when `pickBlocked`, `stage.tool !== 'select'`, or a point target is under the cursor (`photosAt3d`, `markersHit(pane, x, y)`, `rigHit`, a pin or placed 360 within `pinsAt`'s 14 px). A hit: `select([id], id)`, `revealMeasurement(id, { openSidebar: false })`, return true. No hit and `focus !== null`: `select([], null)`, return false (ground and layer picking go on).
- Left click, map: a `click` listener on the map container (bubble) with the same rules; the point targets are the placed 360s (`placedPanos` projected with `map.project`).
- Shapes: `shapesOf(measureStore.getState(), primaryScene.getState() /* primaryMap for the map */, manifest, frame.epsg === null ? 'project north' : 'grid north')` mapped to `HitShape`. They are what the view draws, so hidden and date-hidden measurements are never hit and the drawing tools keep their snaps as today.

- [ ] **Step 1: Write the failing tests**

```ts
// measureHits.test.ts (toScreen = identity on x, y)
it('hits a segment within 6 px and not at 7 px', () => {
  const line = {
    id: 'l',
    points: [
      [0, 0, 0],
      [100, 0, 0],
    ],
    closed: false,
  } as HitShape;
  expect(measureAt([line], id2d, 50, 6)).toBe('l');
  expect(measureAt([line], id2d, 50, 7)).toBeNull();
});
it('the nearest edge wins, the later shape on a tie', () => {
  // lines at y=0 (a) and y=4 (b); cursor y=3 → 'b'; cursor y=2 → tie → 'b'
});
it('a click inside a polygon picks it; the smaller of two nested polygons wins', () => {
  // square 0..100 (big), square 40..60 (small); cursor 50,50 → 'small'; cursor 20,20 → 'big'
});
it('points behind the camera are skipped', () => {
  // toScreen returns null for x < 0; a segment from -10 to 10 is not hit at (5, 0)
});
it('handles 500 shapes', () => {
  expect(measureAt(fiveHundredLines, id2d, 1, 1)).toBe('m0');
});

// measurePick.test.ts (fake EngineStage: claimClicks collects handlers, camera via a stub toScreen;
// shapes come from measureStore through shapesOf; pins/photos/drone helpers vi.mock'ed)
it('right-click on a shape opens the menu and claims the event', () => {
  /* onMenu called with { id: 'm1', x, y } */
});
it('no menu and no claim while a tool draws or vertices are edited', () => {
  for (const patch of [
    { tool: distanceTool, draw: initialDraw('polyline') },
    { editing: initialEdit(pts) },
  ]) {
    measureStore.setState(patch);
    const e = contextMenuAt(onShape);
    expect(onMenu).not.toHaveBeenCalled();
    expect(isClaimed(e)).toBe(false);
    expect(claim(leftClickAt(onShape))).toBe(false);
  }
});
it('a claimed right-click (a pin, a photo, the drone) is left alone', () => {
  // claimEvent(e) before dispatch → onMenu not called
});
it('a left click selects and reveals without opening the sidebar; empty ground clears', () => {
  expect(claim(leftClickAt(onShape))).toBe(true);
  expect(measureStore.getState().focus).toBe('m1');
  expect(measureStore.getState().reveal).toMatchObject({ id: 'm1', openSidebar: false });
  expect(claim(leftClickAt(empty))).toBe(false);
  expect(measureStore.getState().focus).toBeNull();
});
it('a pin under the cursor keeps the click', () => {
  // pinsAt mocked to hit → claim returns false, focus unchanged
});
it('a hidden measurement and one off screen by its date are not hit', () => {
  // m1 in hiddenMeasurements; s1 survey-scoped with its date's layers hidden → no menu on either
});
// MeasureMenu.test.tsx
it('opens the measurement items, on the selection when the shape is in it', () => {
  // select(['m1', 'm2']); render <MeasureMenu at={{ id: 'm2', ... }} />
  expect(q('[data-testid="measure-menu"]')?.textContent).toContain('Delete 2 measurements');
});
it('draws nothing for a measurement that is gone or another project', () => {
  /* null render */
});
```

- [ ] **Step 2: Run them to see them fail** — `pnpm vitest run apps/desktop/src/renderer/survey/measureHits.test.ts apps/desktop/src/renderer/survey/measurePick.test.ts apps/desktop/src/renderer/survey/MeasureMenu.test.tsx` → FAIL.
- [ ] **Step 3: Implement** the three files and the `MeasureLayer` mount. No change to `measureScene.ts`, `Stage.tsx` or `BuilderLayer.tsx`.
- [ ] **Step 4: Run them to see them pass** (same command) and `pnpm vitest run apps/desktop/src/renderer/survey apps/desktop/src/renderer/pins apps/desktop/src/renderer/builder`.
- [ ] **Step 5: Commit** `feat(survey): right-click and pick measurements in 3D and on the map`

---

### Task 9: End to end

**Files:**

- Create: `apps/desktop/e2e/measurement-layers.spec.ts`
- Modify: `apps/desktop/e2e/island.ts` (replace `measurementsList`), `measure-tools.spec.ts`, `telecom-measurements.spec.ts`, `compliance.spec.ts`, `materials.spec.ts`, `sections.spec.ts`, `survey-gaps.spec.ts`, `survey-reports.spec.ts`, `volumes-general.spec.ts`, `templates.spec.ts`, `magic-polygon.spec.ts`
- Checked, expected unchanged: `workbench.spec.ts`, `bench-scroll.spec.ts`, `sidebar-menus.spec.ts`, `sidebar-multi.spec.ts` (`grep -n "wb-section-measurements\|survey-item\|survey-list\b\|survey-hide-all\|survey-show-all\|measurementsList" apps/desktop/e2e` must be empty at the end)

**Interfaces:**

- Consumes: the DOM contract of Task 4, test ids of Tasks 5, 6, 7, 8.
- Produces (`island.ts`):
  - `measureTree(win: Page): Promise<Locator>` — the left sidebar unfolded on the Scene, the `measurements` group open (`tree-group-toggle-measurements`, `aria-expanded`), returns `win.getByTestId('tree-group-measurements').locator('..')`.
  - `measureRow(win: Page, label: string): Locator` — `win.getByTestId('measure-row').filter({ hasText: label })`.
  - `selectMeasure(win: Page, label: string): Promise<void>` and `markMeasure(win: Page, label: string): Promise<void>` — click / Ctrl+click `measureRow(...).locator('.tn')`.
  - `measureSaved(win: Page): Promise<Locator>` — opens the Measure bench, returns `survey-saved`.

Migration rules: `getByTestId('survey-item')` → `getByTestId('measure-row')` (after `measureTree(win)`); `.locator('.sv-item-main').click()` → `selectMeasure`; `getByRole('checkbox').check()` on a row → `markMeasure`; `getByTestId('survey-list')` save messages → `measureSaved(win)` / `survey-saved`; `survey-list-save` and `survey-list-readonly` keep their ids; Show all / Hide all → the group eye (`tree-group-measurements` button named `Measurements: hide all` / `Measurements: show all`), clicked, not Space-pressed; the telecom spec's search-filtered part goes (the tree has no search), its "Measurements" button now reveals the tree, and "Close the measurements list" goes.

New spec `measurement-layers.spec.ts` (synthetic tiny project, seeds `survey/measurements.json` before opening; validate the seed with `MeasurementsFile.parse` as `telecom-measurements.spec.ts` does: a polygon `Pad A` in folder `Pads` and a line `Line B`):

```ts
test('hiding in the tree is personal: not unsaved, and still hidden after reopening', async ({
  win,
  dataRoot,
}) => {
  const before = await readFile(measurementsPath);
  await measureTree(win);
  await expect(win.getByTestId('measure-folder').filter({ hasText: 'Pads' })).toBeVisible();
  await expect(win.locator('.sv-label')).toHaveCount(2);
  await measureRow(win, 'Line B').getByTestId('measure-row-eye').click();
  await expect(win.locator('.sv-label')).toHaveCount(1);
  const saved = await measureSaved(win);
  await expect(saved).toContainText('All saved');
  await expect(saved.getByTestId('survey-list-save')).toBeDisabled();
  expect(await readFile(measurementsPath)).toEqual(before);
  await win.reload(); /* open the tiny project again */
  await measureTree(win);
  await expect(measureRow(win, 'Line B').getByTestId('measure-row-eye')).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect(win.locator('.sv-label')).toHaveCount(1);
  await win.screenshot({ path: testInfo.outputPath('measurement-layers-hidden.png') });
});
test('right-click a shape in 3D opens its menu; a left click selects it; not while drawing', async ({
  win,
}) => {
  // the anchor of Pad A: its `.sv-label[data-id]` transform (translate x, y) plus the `.sv-labels` host's rect
  await win.mouse.click(x, y, { button: 'right' });
  const menu = win.getByTestId('measure-menu');
  // Colour is `present: 'picks'`: a heading over a row of `menuitemradio` swatches, not one menuitem
  const order = await menu
    .locator('[data-testid^="ctx-item-measure."], [data-testid^="measure-colour-"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')));
  expect(
    order.filter((id) => !id?.startsWith('measure-colour-') || id === 'measure-colour-yellow'),
  ).toEqual([
    'ctx-item-measure.rename',
    'measure-colour-yellow',
    'ctx-item-measure.visibility',
    'ctx-item-measure.flyTo',
    'ctx-item-measure.moveToFolder',
    'ctx-item-measure.delete',
  ]);
  await expect(menu.getByTestId('ctx-item-measure.visibility')).toHaveText('Hide');
  await win.screenshot({ path: testInfo.outputPath('measurement-layers-menu.png') });
  await win.keyboard.press('Escape');
  await win.mouse.click(x, y);
  await expect(win.getByTestId('survey-panel')).toContainText('Pad A');
  await expect(measureRow(win, 'Pad A')).toHaveClass(/sel/);
  await (await measureControl(win, 'survey-tool-distance')).click();
  await win.mouse.click(x, y, { button: 'right' });
  await expect(menu).toHaveCount(0);
});
test('Rename and Move to folder from the tree menu are edits that wait for Save', async ({
  win,
}) => {
  await measureRow(win, 'Line B').locator('.tn').click({ button: 'right' });
  await win.getByTestId('ctx-item-measure.moveToFolder').click();
  await win.getByTestId('measure-folder-to-Pads').click();
  await expect(win.getByTestId('measure-folder').filter({ hasText: 'Pads' })).toContainText('2');
  await expect(await measureSaved(win)).toContainText('Unsaved changes');
});
```

`ContextMenu` renders actions as `role="menuitem"` with `ctx-item-<id>` test ids; a `picks` action (Colour) is a heading over `menuitemradio` swatches carrying their `SubItem.testId`.

- [ ] **Step 1: Write the new spec and migrate the specs** as above.
- [ ] **Step 2: Build and run them the CI way** from `apps/desktop` (PowerShell: set the three `$env:` variables first):

```bash
pnpm demo:build --quick
pnpm demo:change --quick
QUADRION_WINDOW_SIZE=1100x720 QUADRION_E2E_SCALE=1 QUADRION_E2E_SWGL=warp npx playwright test e2e/measurement-layers.spec.ts e2e/measure-tools.spec.ts e2e/telecom-measurements.spec.ts e2e/compliance.spec.ts e2e/materials.spec.ts e2e/sections.spec.ts e2e/survey-gaps.spec.ts e2e/survey-reports.spec.ts e2e/volumes-general.spec.ts e2e/templates.spec.ts e2e/magic-polygon.spec.ts e2e/workbench.spec.ts e2e/bench-scroll.spec.ts e2e/sidebar-menus.spec.ts e2e/sidebar-multi.spec.ts --workers=1
```

Expected: the log prints `[e2e] window 1100 x 720 px at display scale 1`; all pass. Then `--repeat-each=3` on `e2e/measurement-layers.spec.ts`. Look at the two screenshots (visual evidence for the founder).

- [ ] **Step 3: Commit** `test(e2e): measurements in the sidebar tree`

---

### Task 10: Verification and hand-off

- [ ] **Step 1:** `pnpm check` green in the worktree (lint, format, typecheck, unit).
- [ ] **Step 2:** The e2e run of Task 9, Step 2 green on the rebased branch.
- [ ] **Step 3:** `node tools/agent/check-public-text.mjs` on every added doc and spec; no client or site names in screenshots.
- [ ] **Step 4:** Confirm "no contract change": `git diff origin/main --stat -- packages/schema apps/desktop/src/main apps/desktop/src/preload` is empty.
- [ ] **Step 5:** Run `/wrapup` on this branch, then `node tools/agent/finish-task.mjs`. Note in the session note: follow-up to switch Fly to to `flyToLocalBox(points, pad?)` once `feat/antenna-review` lands; drag of measurement rows onto folders deferred.
- [ ] **Step 6: How to test (for the founder)**
  1. Open a project with saved measurements and go to the Scene. In the left sidebar, under Datasets, a **Measurements** group sits after Maps and rasters. Each row shows a colour square, the name, the value (for example `42.18 m`) and an eye. Measurements with a folder sit under a folder row.
  2. Click a row's eye: the shape and its label leave the 3D view and the map. In the right sidebar's Measure tab the footer still says "All saved". Close and reopen the project: it is still hidden. Click the group's eye: everything hides, then shows again.
  3. Right-click a row: Rename, Colour, Hide, Fly to, Move to folder, Delete. Pick a colour: the shape recolours and the footer says "Unsaved changes". Click Save.
  4. Ctrl+click two rows, right-click one of them: Move to folder > New folder…, type a name and press Enter. Both rows move into the new folder.
  5. Right-click a measurement's shape in 3D (or on the map): the same menu opens. Left-click the shape: its row lights up in the tree and the Measure tab shows it in Selected.
  6. Start the Distance tool and right-click on a shape: no menu, the drawing carries on.
  7. In the Measure tab, "Saved in this project" is gone. Autosave, Revert, Save and the totals of marked polygons sit in the footer under Selected.
  8. Open a package (.aio): rows and eyes work, and hiding is remembered. Rename, Colour, Move to folder and Delete are greyed, with "This is a package: its files stay inside it." as the reason.

---

## Execution DAG

| Task | Depends on    | Packages touched                              | Unit tests                                                                                         |
| ---- | ------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1    | none          | `@aio/ui`                                     | `tree/model.test.ts`, `actions/registry.test.ts`, `tree/RenameField.test.tsx`, `i18n/i18n.test.ts` |
| 2    | none          | `@aio/desktop` (survey)                       | `survey/measureVisibility.test.ts`, `survey/measureStore.test.ts`                                  |
| 3    | 1             | `@aio/desktop` (survey)                       | `survey/measureRows.test.ts`                                                                       |
| 4    | 1             | `@aio/ui`, `@aio/desktop` (`styles.css` only) | `tree/measureTree.test.tsx`, `tree/DateTree.test.tsx`                                              |
| 5    | 1, 2          | `@aio/desktop` (shell/actions)                | `shell/actions/measureActions.test.ts`, `shell/actions/parity.test.ts`                             |
| 6    | 1, 2          | `@aio/desktop` (survey, workbench)            | `MeasureBench.test.tsx`, `measureStore.test.ts`, `measureFollow.test.ts`, `TelecomTools.test.tsx`  |
| 7    | 1, 2, 3, 4, 5 | `@aio/desktop` (shell)                        | `shell/Sidebar.measures.test.tsx`, `shell/menuTargets.test.ts`                                     |
| 8    | 1, 2, 5       | `@aio/desktop` (survey)                       | `survey/measureHits.test.ts`, `survey/measurePick.test.ts`, `survey/MeasureMenu.test.tsx`          |
| 9    | 6, 7, 8       | `@aio/desktop` (e2e)                          | e2e listed in Task 9                                                                               |
| 10   | 9             | none                                          | `pnpm check`, e2e                                                                                  |

**Parallel batches** (no shared files within a batch; dispatch each batch in one message):

- **Batch A:** Task 1, Task 2
- **Batch B:** Task 3, Task 4, Task 5, Task 6 (Task 6 edits `measureStore.ts` after Task 2 has landed; no other Batch B task touches it; `en.ts` was finished in Task 1)
- **Batch C:** Task 7, Task 8
- **Batch D:** Task 9
- **Batch E:** Task 10

**Critical path:** Task 1 → Task 4 → Task 7 → Task 9 → Task 10.

**E2e specs:** added `measurement-layers.spec.ts`; changed `measure-tools`, `telecom-measurements`, `compliance`, `materials`, `sections`, `survey-gaps`, `survey-reports`, `volumes-general`, `templates`, `magic-polygon` and the `island.ts` helpers; run unchanged as a check: `workbench`, `bench-scroll`, `sidebar-menus`, `sidebar-multi`.

**Contract change:** none. No schema, IPC or main-process change (visibility is renderer `localStorage`; every edit goes through the existing `survey:writeMeasurements`).

**Files shared with other sessions:** `MeasureBench.tsx` (`feat/antenna-review` edits the `AntennaSection` line; Task 6 removes `Saved` and adds one `SavedFooter` line elsewhere). `measureScene.ts` is only imported (`shapesOf`, `focusPoint`, `frameOf`, `MEASURE_COLOR`), never edited. `Stage.tsx` is not touched: the views' menu mounts in `MeasureLayer` (`MeasureToolbar.tsx`). `workspace/flyToBox.ts` is not created.

## Decisions this plan makes

- The group goes directly after `maps` (before `drawings`, `video`, `walks`, which also sit between Maps and Photos today).
- Rename and Fly to stay in the menu when several rows are marked and act on the clicked row (the target carries `clicked`), instead of disappearing as layer Rename does.
- The group eye works on the hidden-id list, not on `measurementsVisible`, so a measurement drawn after "hide all" is visible and nothing persists a second flag.
- Menu Delete deletes at once, as the old list did (Revert undoes until saved). The marked header's Delete and the Delete key also delete marked measurements (layers still go through the dialog).
- A click inside a closed polygon picks it (smallest wins), as well as a click near any edge or vertex (6 px).
- The left-click pick reveals the row without opening a folded sidebar; Rename, New folder… and the telecom "Measurements" button open it.
- Drag of rows onto folder rows is deferred: the tree's drag support files layers under dates and is not cheap to reuse.
- No search in the tree (it has none); sort and filters are dropped.
