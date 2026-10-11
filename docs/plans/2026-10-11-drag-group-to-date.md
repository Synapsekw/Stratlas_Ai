# Move a whole group to another survey date: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inside a survey date folder of the Datasets list, a group header (Video, Photos, Panoramas, Models, Point clouds, Maps and rasters) can be dragged onto another date folder, or moved with **Move to date**, and every dataset of the group is filed there in one save, with a one-step Undo.

**Architecture:** List and menu work only. `DatasetTree` gains two optional props for group headers that reuse the drag state `DateTree` already keeps for rows, so the drop targets, the highlight, the edge scroll and the spare **Every date** folder work unchanged. The shell's move function reports what it wrote so the note under the list can offer Undo. No change to `@aio/schema`, to IPC or to project files.

**Tech stack:** React 18, TypeScript (strict, `exactOptionalPropertyTypes`), vitest with jsdom, Playwright on Electron.

**Spec:** `docs/plans/2026-10-11-drag-group-to-date-design.md`

## Global constraints

- Work only in the worktree `E:\Dev\AIO Software\.claude\worktrees\drag-group-to-date` on `feat/drag-group-to-date`. Never edit the main checkout.
- Touch only the files your task lists. Stage by path (`git add <file> ...`), never `git add -A` or `git add .`. Never `git stash`. Never `--no-verify`.
- Conventional commits in the repo's sentence style, ending with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- User-facing text (strings, docs, commit subjects): no emoji, no em or en dashes, no client, site, tester or person names.
- Dragging a single dataset row, and a flight row with its clips, must behave exactly as before.
- It is a move, not a copy: one `builder:updateLayers` call with `{ capture }` for the whole group.
- No change under `packages/schema`. No new dependency.
- Electron windows opened by tests stay off screen (the e2e fixtures do this; do not launch the app any other way).

## Review focus

1. A group that mixes datable datasets with an offline basemap or an original review: the datable ones move, the other stays, and the header stays with it. Pinned in Task 1 (model test and `DateTree` test).
2. A group longer than the eight rows shown before "N more": every dataset moves, the hidden ones too. Pinned in Task 1.
3. A Video group made of flight rows: the clips of every flight move. Pinned in Task 1 (model test).
4. Undo when the moved datasets had different earlier states (one had a date of its own, one had none and was filed by its name): each gets back exactly what it had. Pinned in Task 2.
5. Undo after one of the moved datasets was removed from the project: the rest go back, nothing is refused because of the missing one. Pinned in Task 2.

## Execution DAG

```
T1 (ui: group drag + menu) ──┬──> T3 (shell: note with Undo) ──> T5 (e2e)
T2 (shell: undo model) ──────┘
T4 (docs) ── independent
```

| Batch | Tasks (dispatched in one message) | Why they can run together                                   |
| ----- | --------------------------------- | ----------------------------------------------------------- |
| 1     | T1, T2, T4                        | No shared files, no dependency between them                 |
| 2     | T3                                | Needs T1's strings file free and T2's functions             |
| 3     | T5                                | Needs the drag (T1) and the Undo note (T3) in the built app |

**Critical path:** T1, T3, T5.

**Packages touched:** T1 `@aio/ui` and the one consumer line in the desktop shell (`DateMenus.tsx`); T2 desktop shell; T3 desktop shell plus one string block and one CSS rule in `@aio/ui`; T4 docs; T5 desktop e2e.

**Contract changes:** none. `@aio/schema` is not touched, so no row in `docs/architecture/contract-changes.md`. `@aio/ui`'s `DateItemMenuRequest` gains `name` and its `item` becomes optional; its only consumer changes in the same task.

**End to end specs:** `apps/desktop/e2e/timeline.spec.ts` gains two tests (T5). No fixture changes.

---

### Task 1: Group headers drag and open Move to date (`@aio/ui`)

**Files:**

- Modify: `packages/ui/src/tree/model.ts` (after `datableLayerIds`)
- Modify: `packages/ui/src/tree/model.test.ts`
- Modify: `packages/ui/src/tree/DatasetTree.tsx`
- Modify: `packages/ui/src/tree/DateTree.tsx`
- Modify: `packages/ui/src/tree/DateTree.test.tsx`
- Modify: `packages/ui/src/i18n/en.ts` (beside `tree.dates.move.label`)
- Modify: `packages/ui/src/mission.css` (the rule at "dragging a dataset row onto a date folder")
- Modify: `apps/desktop/src/renderer/shell/DateMenus.tsx` (`LayerDateMenu`, two reads of `menu.item.name`)
- Modify: `apps/desktop/src/renderer/shell/DateMenus.test.tsx`

**Interfaces:**

- Consumes: nothing from other tasks.
- Produces:
  - `groupDatableLayerIds(group: TreeGroup): string[]`, exported from `model.ts` (and so from `@aio/ui`, which re-exports the tree model; check `packages/ui/src/index.ts` and add the export there if `datableLayerIds` is listed by name).
  - `DatasetTreeProps.dragGroupIds?: ((group: TreeGroup) => string[]) | undefined`
  - `DatasetTreeProps.onGroupMenu?: ((group: TreeGroup, layerIds: string[], at: MenuPoint) => void) | undefined`
  - `DateItemMenuRequest` is `{ name: string; item?: TreeItem | undefined; layerIds: string[]; from: string } & MenuPoint`
  - `data-testid="tree-group-<kind>"` on every group header row (`.tgroup-row`).
  - Strings `tree.dates.move.group_one` and `tree.dates.move.group_other`.

- [ ] **Step 1: Write the failing model test.** Append to `packages/ui/src/tree/model.test.ts` (add `groupDatableLayerIds` and `type TreeGroup` to the import from `./model`):

```ts
describe('groupDatableLayerIds', () => {
  it('takes every datable layer, flight clips included, and leaves what is never dated', () => {
    const g: TreeGroup = {
      kind: 'maps',
      label: 'Maps and rasters',
      icon: 'map',
      count: 4,
      items: [
        { id: 'ortho', layerId: 'ortho', layerKind: 'raster', name: 'Ortho' },
        { id: 'base', layerId: 'base', layerKind: 'basemap', name: 'Offline map' },
        {
          id: 'flight:1',
          name: 'Flight 1',
          flightId: '1',
          children: [
            { id: 'c1', layerId: 'c1', layerKind: 'video', name: 'Clip 1' },
            { id: 'c2', layerId: 'c2', layerKind: 'video', name: 'Clip 2' },
          ],
        },
        { id: 'issues', name: 'Issues' },
      ],
    };
    expect(groupDatableLayerIds(g)).toEqual(['ortho', 'c1', 'c2']);
  });

  it('is empty for a group with nothing that can be dated', () => {
    const g: TreeGroup = {
      kind: 'models',
      label: 'Models',
      icon: 'scene',
      count: 1,
      items: [{ id: 'old', layerId: 'old', layerKind: 'legacy', name: 'Original review' }],
    };
    expect(groupDatableLayerIds(g)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and see it fail.** From the worktree root: `pnpm exec vitest run packages/ui/src/tree/model.test.ts --retry=0`. Expected: FAIL, `groupDatableLayerIds` is not exported.

- [ ] **Step 3: Add the helper** in `model.ts`, right after `datableLayerIds`:

```ts
/** The layers of a group that can be filed under a survey date, flight clips included. */
export function groupDatableLayerIds(group: TreeGroup): string[] {
  return group.items.flatMap(datableLayerIds);
}
```

Run the model test again. Expected: PASS.

- [ ] **Step 4: Write the failing `DateTree` tests.** In `packages/ui/src/tree/DateTree.test.tsx`, change the existing test "a right-click on a dataset asks for its menu with the layers and its folder" so its expectation also holds the name:

```ts
expect(onItemMenu).toHaveBeenCalledWith(
  expect.objectContaining({ name: 'm-nov', layerIds: ['m-nov'], from: 'nov', x: 12, y: 34 }),
);
```

Then append this block (it uses the file's own `folders`, `tags`, `group`, `cap`, `fire`, `rightClick`, `render` and `renderWith` helpers):

```tsx
describe('DateTree: a whole group onto a date folder', () => {
  /** The header of a group inside a folder. */
  const head = (folder: string, kind = 'models') =>
    host.querySelector(`[data-testid="date-folder-${folder}"] [data-testid="tree-group-${kind}"]`);
  const many = Array.from({ length: 12 }, (_, i) => `v${String(i)}`);
  const maps: TreeGroup = {
    kind: 'maps',
    label: 'Maps and rasters',
    icon: 'map',
    count: 2,
    items: [
      { id: 'ortho', layerId: 'ortho', layerKind: 'raster', name: 'Ortho' },
      { id: 'base', layerId: 'base', layerKind: 'basemap', name: 'Offline map' },
    ],
  };
  const basemapOnly: TreeGroup = { ...maps, count: 1, items: maps.items.slice(1) };
  const withNov = (groups: TreeGroup[], layerIds: string[]): DateFolder[] =>
    folders.map((f) => (f.id === 'nov' ? { ...f, groups, layerIds } : f));

  it('a group header drags every dataset of its group, the rows behind "more" too', () => {
    const onMove = vi.fn();
    renderWith({ folders: withNov([group(many)], many), onMove });
    expect(head('nov')?.getAttribute('draggable')).toBe('true');
    fire(head('nov'), 'dragstart');
    expect(q('date-folder-oct')?.className).toContain('drop-can');
    fire(q('date-folder-oct'), 'dragover');
    fire(q('date-folder-oct'), 'drop');
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove).toHaveBeenCalledWith(many, 'oct');
  });

  it('a group dropped on Every date takes the date off its datasets', () => {
    const onMove = vi.fn();
    render('nov', {}, vi.fn(), { onMove });
    fire(head('nov'), 'dragstart');
    fire(q('date-folder-every'), 'drop');
    expect(onMove).toHaveBeenCalledWith(['m-nov'], null);
  });

  it('a group dropped on the folder it is in does nothing', () => {
    const onMove = vi.fn();
    render('nov', {}, vi.fn(), { onMove });
    fire(head('nov'), 'dragstart');
    expect(q('date-folder-nov')?.className).not.toContain('drop-can');
    fire(q('date-folder-nov'), 'drop');
    expect(onMove).not.toHaveBeenCalled();
  });

  it('the highlight goes when the drag of a group ends without a drop', () => {
    render('nov', {}, vi.fn(), { onMove: vi.fn() });
    fire(head('nov'), 'dragstart');
    fire(head('nov'), 'dragend');
    expect(q('date-folder-oct')?.className).not.toContain('drop-can');
  });

  it('a mixed group moves what can be dated and leaves the basemap', () => {
    const onMove = vi.fn();
    renderWith({ folders: withNov([maps], ['ortho', 'base']), onMove });
    fire(head('nov', 'maps'), 'dragstart');
    fire(q('date-folder-oct'), 'drop');
    expect(onMove).toHaveBeenCalledWith(['ortho'], 'oct');
  });

  it('a group with nothing that can be dated stays put and has no menu', () => {
    const onItemMenu = vi.fn();
    renderWith({ folders: withNov([basemapOnly], ['base']), onMove: vi.fn(), onItemMenu });
    expect(head('nov', 'maps')?.getAttribute('draggable')).toBeNull();
    rightClick(head('nov', 'maps'), 12, 34);
    expect(onItemMenu).not.toHaveBeenCalled();
  });

  it('group headers do not drag in a read-only project', () => {
    render('nov', {});
    expect(head('nov')?.getAttribute('draggable')).toBeNull();
  });

  it('a right-click on a group header asks for the move menu of the whole group', () => {
    const onItemMenu = vi.fn();
    renderWith({ folders: withNov([group(many)], many), onMove: vi.fn(), onItemMenu });
    rightClick(head('nov'), 12, 34);
    expect(onItemMenu).toHaveBeenCalledTimes(1);
    const asked = onItemMenu.mock.calls[0]?.[0] as DateItemMenuRequest;
    expect(asked).toMatchObject({
      name: 'Models · 12 datasets',
      layerIds: many,
      from: 'nov',
      x: 12,
      y: 34,
    });
    expect(asked.item).toBeUndefined();
  });

  it('names a group of one in the singular', () => {
    const onItemMenu = vi.fn();
    render('nov', {}, vi.fn(), { onMove: vi.fn(), onItemMenu });
    rightClick(head('nov'), 1, 1);
    expect(onItemMenu).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Models · 1 dataset' }),
    );
  });
});
```

Add `type DateItemMenuRequest` to the import from `./DateTree`. If `renderWith` in this file does not open the `nov` folder for these fixtures, pass `focus: 'nov'` explicitly (it already defaults to it).

- [ ] **Step 5: Run them and see them fail.** `pnpm exec vitest run packages/ui/src/tree/DateTree.test.tsx --retry=0`. Expected: the new block fails (no `tree-group-models` element, no `name`), the older tests pass except the one changed in Step 4.

- [ ] **Step 6: Strings.** In `packages/ui/src/i18n/en.ts`, after `'tree.dates.move.label'`:

```ts
  'tree.dates.move.group_one': '{group} · 1 dataset',
  'tree.dates.move.group_other': '{group} · {count} datasets',
```

- [ ] **Step 7: `DatasetTree` props and header wiring.** In `DatasetTree.tsx`, add to `DatasetTreeProps` after `onItemMenu`:

```ts
  /**
   * Group headers that can be dragged (onto a survey date folder): the layers a header carries,
   * none for a header that stays put. A drag is reported through `onDragItem`, like a row's.
   */
  dragGroupIds?: ((group: TreeGroup) => string[]) | undefined;
  /** Right-click, or the menu key, on a group header that carries layers. */
  onGroupMenu?: ((group: TreeGroup, layerIds: string[], at: MenuPoint) => void) | undefined;
```

Inside `groups.map((g) => {`, after `hiddenRows`:

```ts
// a header carries its whole group, the rows behind "more" too; never in rail mode
const carried = collapsed ? [] : (props.dragGroupIds?.(g) ?? []);
const groupMenu = carried.length > 0 ? props.onGroupMenu : undefined;
const groupDrag = carried.length > 0 && props.onDragItem !== undefined;
```

Replace `<div className="tgroup-row">` with:

```tsx
            <div
              className="tgroup-row"
              data-testid={`tree-group-${g.kind}`}
              {...(groupDrag
                ? {
                    draggable: true,
                    onDragStart: (e: DragEvent<HTMLElement>) => {
                      e.stopPropagation();
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', g.label);
                      props.onDragItem?.(carried);
                    },
                    onDragEnd: () => {
                      props.onDragItem?.(null);
                    },
                  }
                : {})}
              {...(groupMenu
                ? {
                    onContextMenu: (e: MouseEvent<HTMLElement>) => {
                      e.preventDefault();
                      e.stopPropagation();
                      groupMenu(g, carried, menuPoint(e));
                    },
                  }
                : {})}
            >
```

- [ ] **Step 8: `DateTree` wiring.** In `DateTree.tsx`:

Import `groupDatableLayerIds` beside `datableLayerIds`. Replace the `DateItemMenuRequest` interface with:

```ts
/** A move menu was asked for: a row's, or a whole group's from its header. */
export interface DateItemMenuRequest extends MenuPoint {
  /** The heading of the menu: the row's name, or the group with how many datasets it moves. */
  name: string;
  /** The row, when the menu is a row's; not set for a group header. */
  item?: TreeItem | undefined;
  /** The layers the move files under a date. */
  layerIds: string[];
  /** The folder the row or group sits in (`EVERY_DATE` or a capture id). */
  from: string;
}
```

Add `'dragGroupIds' | 'onGroupMenu'` to the `Omit<DatasetTreeProps, ...>` list of `DateTreeProps`. In the nested `<DatasetTree>`, add `name: item.name` to the row request and pass the two new props:

```tsx
                dragGroupIds={onMove || onItemMenu ? groupDatableLayerIds : undefined}
                onItemMenu={
                  onItemMenu
                    ? (item, at) => {
                        const layerIds = datableLayerIds(item);
                        if (layerIds.length > 0)
                          onItemMenu({ name: item.name, item, layerIds, from: f.id, ...at });
                      }
                    : undefined
                }
                onGroupMenu={
                  onItemMenu
                    ? (g, layerIds, at) => {
                        onItemMenu({
                          name: t('tree.dates.move.group', { group: g.label, count: layerIds.length }),
                          layerIds,
                          from: f.id,
                          ...at,
                        });
                      }
                    : undefined
                }
```

Update the comment on `onMove` in `DateTreeProps` to say rows and group headers drag, and the one on `onItemMenu` to say "a dataset row or a group header".

- [ ] **Step 9: CSS.** In `packages/ui/src/mission.css`, widen the existing rule:

```css
/* dragging a dataset row or a group header onto a date folder: folders that take the drop, and the one under it */
.dtree .titem[draggable='true'],
.dtree .tgroup-row[draggable='true'] {
  -webkit-user-drag: element;
}
```

No other visual change: no new cursor, colour or shape.

- [ ] **Step 10: The menu reads the name.** In `apps/desktop/src/renderer/shell/DateMenus.tsx`, in `LayerDateMenu`, replace both `menu.item.name` with `menu.name`, and change its doc comment's first line to "Right-click (or the menu key) on a dataset or a group header: file it under another survey date, or under none." In `DateMenus.test.tsx`, add `name: 'Quad',` to the `menu` object of the `open` helper, and add this test to the `LayerDateMenu` block:

```tsx
it('heads the menu of a group with the group and how many datasets it moves', () => {
  const onMove = vi.fn();
  root = createRoot(host);
  act(() =>
    root?.render(
      <LayerDateMenu
        menu={{ name: 'Video · 12 datasets', layerIds: ['a', 'b'], from: 'nov', x: 5, y: 5 }}
        captures={captures}
        tags={tags}
        every={EVERY_DATE}
        onClose={vi.fn()}
        onMove={onMove}
      />,
    ),
  );
  const menu = document.body.querySelector('[data-testid="move-menu"]');
  expect(menu?.textContent).toContain('Move to date · Video · 12 datasets');
  expect(menu?.getAttribute('aria-label')).toBe('Move Video · 12 datasets to a survey date');
  act(() => {
    document.body.querySelector<HTMLButtonElement>('[data-testid="move-to-oct"]')?.click();
  });
  expect(onMove).toHaveBeenCalledWith(['a', 'b'], 'oct');
});
```

- [ ] **Step 11: Run everything this task touched.**

```bash
pnpm exec vitest run packages/ui/src/tree packages/ui/src/i18n apps/desktop/src/renderer/shell/DateMenus.test.tsx --retry=0
pnpm typecheck
pnpm lint
pnpm format:check
```

Expected: all green. `pnpm format` fixes formatting if `format:check` complains.

- [ ] **Step 12: Commit.**

```bash
git add packages/ui/src/tree/model.ts packages/ui/src/tree/model.test.ts packages/ui/src/tree/DatasetTree.tsx packages/ui/src/tree/DateTree.tsx packages/ui/src/tree/DateTree.test.tsx packages/ui/src/i18n/en.ts packages/ui/src/mission.css apps/desktop/src/renderer/shell/DateMenus.tsx apps/desktop/src/renderer/shell/DateMenus.test.tsx
git commit -m "feat(ui): a group header drags its whole group onto a date folder, and has Move to date"
```

---

### Task 2: What a date move wrote, and how to put it back (desktop shell)

**Files:**

- Create: `apps/desktop/src/renderer/shell/dateUndo.ts`
- Create: `apps/desktop/src/renderer/shell/dateUndo.test.ts`
- Modify: `apps/desktop/src/renderer/shell/dateFolders.ts`

**Interfaces:**

- Consumes: `setLayersCapture(layerIds: readonly string[], capture: string | null): Promise<string | null>` from `../change/SurveyDate` (already imported in `dateFolders.ts`).
- Produces (all exported from `dateFolders.ts`; the pure parts live in `dateUndo.ts` so they test without the app's stores):
  - `interface MovedLayer { id: string; capture: string | null }`
  - `DateMoveResult` gains `moved: MovedLayer[]` (empty on an error or when nothing was written).
  - `undoDateMove(moved: readonly MovedLayer[]): Promise<string | null>` (null when every layer is back, else the error).

- [ ] **Step 1: Write the failing tests.** Create `apps/desktop/src/renderer/shell/dateUndo.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { priorCaptures, undoBatches } from './dateUndo';

const manifest = {
  layers: [
    { id: 'a', capture: 'nov' },
    { id: 'b', capture: 'nov' },
    { id: 'named' }, // filed by the date in its name: no capture of its own
    { id: 'other', capture: 'oct' },
  ],
};

describe('priorCaptures', () => {
  it('remembers the capture each layer has of its own, null for none', () => {
    expect(priorCaptures(manifest, ['a', 'named', 'b'])).toEqual([
      { id: 'a', capture: 'nov' },
      { id: 'named', capture: null },
      { id: 'b', capture: 'nov' },
    ]);
  });

  it('skips a layer the project does not hold', () => {
    expect(priorCaptures(manifest, ['gone', 'a'])).toEqual([{ id: 'a', capture: 'nov' }]);
  });
});

describe('undoBatches', () => {
  const known = new Set(['a', 'b', 'named']);

  it('is one write per earlier value, so each layer gets back exactly what it had', () => {
    const moved = [
      { id: 'a', capture: 'nov' },
      { id: 'named', capture: null },
      { id: 'b', capture: 'nov' },
    ];
    expect(undoBatches(moved, known)).toEqual([
      { capture: 'nov', layerIds: ['a', 'b'] },
      { capture: null, layerIds: ['named'] },
    ]);
  });

  it('leaves out a layer that was removed since the move', () => {
    const moved = [
      { id: 'a', capture: 'nov' },
      { id: 'removed', capture: 'nov' },
    ];
    expect(undoBatches(moved, known)).toEqual([{ capture: 'nov', layerIds: ['a'] }]);
  });

  it('is nothing when every moved layer is gone', () => {
    expect(undoBatches([{ id: 'removed', capture: 'nov' }], known)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and see it fail.** `pnpm exec vitest run apps/desktop/src/renderer/shell/dateUndo.test.ts --retry=0`. Expected: FAIL, the module does not exist.

- [ ] **Step 3: Write `dateUndo.ts`.**

```ts
/**
 * What a date move changed, so it can be put back: the `capture` each layer had of its own before
 * the move. Pure, so the Datasets list can offer Undo without a second source of truth.
 */

/** A layer a date move wrote, with the `capture` it had of its own before (null: none). */
export interface MovedLayer {
  id: string;
  capture: string | null;
}

/** The own `capture` of each of these layers as the manifest has it now; unknown ids are skipped. */
export function priorCaptures(
  manifest: { layers: readonly { id: string; capture?: string | undefined }[] },
  layerIds: readonly string[],
): MovedLayer[] {
  const own = new Map(manifest.layers.map((l) => [l.id, l.capture ?? null]));
  return layerIds.flatMap((id) => {
    const capture = own.get(id);
    return capture === undefined ? [] : [{ id, capture }];
  });
}

/**
 * The writes that put moved layers back: one per earlier value, in the order first met. A layer
 * the project no longer holds (`known`) is left out, so one removed dataset does not block the rest.
 */
export function undoBatches(
  moved: readonly MovedLayer[],
  known: ReadonlySet<string>,
): { capture: string | null; layerIds: string[] }[] {
  const by = new Map<string | null, string[]>();
  for (const m of moved) {
    if (!known.has(m.id)) continue;
    const ids = by.get(m.capture);
    if (ids) ids.push(m.id);
    else by.set(m.capture, [m.id]);
  }
  return [...by].map(([capture, layerIds]) => ({ capture, layerIds }));
}
```

Run the test. Expected: PASS.

- [ ] **Step 4: Report `moved` from the move, and add the undo.** In `dateFolders.ts`:

Add the import and re-export:

```ts
import { priorCaptures, undoBatches, type MovedLayer } from './dateUndo';

export type { MovedLayer } from './dateUndo';
```

Add to `DateMoveResult`:

```ts
  /** The layers the move wrote, with the `capture` each had before; empty when nothing was saved. */
  moved: MovedLayer[];
```

Replace the body of `moveLayersToDate` from the first `return` on:

```ts
  if (!project) return { error: 'No project is open.', stays: {}, moved: [] };
  const plan = planDateMove(
    project.manifest,
    volumeHints(volumetric.getState()),
    layerIds,
    capture,
  );
  if (plan.write.length === 0) return { error: null, stays: plan.stays, moved: [] };
  const moved = priorCaptures(project.manifest, plan.write);
  const error = await setLayersCapture(plan.write, capture);
  return { error, stays: plan.stays, moved: error ? [] : moved };
}

/**
 * Put the layers of a date move back under the `capture` each had before it. Null when they are
 * back, else why not; a write that is refused stops there and the list shows the manifest as it is.
 */
export async function undoDateMove(moved: readonly MovedLayer[]): Promise<string | null> {
  const project = workspace.getState().project;
  if (!project) return 'No project is open.';
  const known = new Set(project.manifest.layers.map((l) => l.id));
  for (const batch of undoBatches(moved, known)) {
    const error = await setLayersCapture(batch.layerIds, batch.capture);
    if (error) return error;
  }
  return null;
}
```

- [ ] **Step 5: Verify.**

```bash
pnpm exec vitest run apps/desktop/src/renderer/shell --retry=0
pnpm typecheck
pnpm lint
pnpm format:check
```

Expected: green. `Sidebar.tsx` still compiles: it reads `error` and `stays` and ignores `moved`.

- [ ] **Step 6: Commit.**

```bash
git add apps/desktop/src/renderer/shell/dateUndo.ts apps/desktop/src/renderer/shell/dateUndo.test.ts apps/desktop/src/renderer/shell/dateFolders.ts
git commit -m "feat(desktop): a date move reports what it wrote, and can be put back"
```

---

### Task 3: The note under the list says what moved and offers Undo (desktop shell)

Runs after Tasks 1 and 2.

**Files:**

- Modify: `apps/desktop/src/renderer/shell/Sidebar.tsx` (the `note` state near line 270, `onMove` near line 287, the note markup near line 384)
- Modify: `packages/ui/src/i18n/en.ts` (after `tree.dates.move.stays_other`)
- Modify: `packages/ui/src/mission.css` (after the `.dtree-note > button` rules near line 1200)

**Interfaces:**

- Consumes: `moveLayersToDate` returning `{ error, stays, moved }`, `undoDateMove(moved)`, `type MovedLayer` from `./dateFolders` (Task 2).
- Produces: `data-testid="date-undo"` on the Undo button inside `data-testid="date-note"`; the note text `"{count} datasets moved to {date}."`.

Before any CSS decision, load the `impeccable` skill (project rule for UI work) and keep to the tokens `.dtree-note` already uses.

- [ ] **Step 1: Strings.** In `en.ts`:

```ts
  'tree.dates.move.done': '{count} datasets moved to {date}.',
  'tree.dates.move.doneNone': '{count} datasets no longer belong to a date.',
  'tree.dates.move.undo': 'Undo',
```

(The count is always two or more, so there is no singular form.)

- [ ] **Step 2: The note carries an Undo.** In `Sidebar.tsx`, import `undoDateMove` and `type MovedLayer` from `./dateFolders`, and change the state to:

```ts
const [note, setNote] = useState<{ text: string; danger: boolean; undo?: MovedLayer[] } | null>(
  null,
);
```

Replace `onMove` with:

```ts
const onMove = (layerIds: string[], capture: string | null) => {
  void moveLayersToDate(layerIds, capture).then(({ error, stays, moved }) => {
    if (error) {
      failed(error);
      return;
    }
    const manifest = workspace.getState().project?.manifest;
    // one dataset is put back by dragging it back; a group or a flight needs Undo
    const undo = moved.length > 1 ? { undo: moved } : {};
    const kept = Object.entries(stays);
    const [first] = kept;
    if (first) {
      const name = manifest?.layers.find((l) => l.id === first[0])?.name ?? first[0];
      const date = manifest?.captures.find((c) => c.id === first[1])?.date;
      setNote({
        text: t('tree.dates.move.stays', {
          count: kept.length,
          name,
          date: date ? formatDate(date) : first[1],
        }),
        danger: false,
        ...undo,
      });
      return;
    }
    if (moved.length > 1) {
      const date = capture ? manifest?.captures.find((c) => c.id === capture)?.date : undefined;
      setNote({
        text: date
          ? t('tree.dates.move.done', { count: moved.length, date: formatDate(date) })
          : t('tree.dates.move.doneNone', { count: moved.length }),
        danger: false,
        undo: moved,
      });
      return;
    }
    setNote(null);
  });
};
```

In the note markup, between `<span>{note.text}</span>` and the dismiss button:

```tsx
{
  note.undo && (
    <button
      type="button"
      className="dtree-undo"
      data-testid="date-undo"
      onClick={() => {
        if (note.undo) void undoDateMove(note.undo).then(failed);
      }}
    >
      {t('tree.dates.move.undo')}
    </button>
  );
}
```

`failed(null)` clears the note, so a successful Undo removes it; a refused one shows the red note.

- [ ] **Step 3: Style.** Read the `.dtree-note` rules in `mission.css`. `.dtree-note > button` styles the square dismiss icon; give Undo its own rule after them so it reads as a text button, using only tokens already in that block (same font size as the note, the accent colour for the label, the same focus ring as the dismiss button, no fixed width, `white-space: nowrap`, `flex: none`). Make sure `.dtree-note > button` sizing (fixed width or height) is overridden for `.dtree-undo`.

- [ ] **Step 4: Verify.** There is no unit harness for `Sidebar` (it needs the app's stores); this task is proven by the end to end tests of Task 5.

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm exec vitest run packages/ui/src/i18n apps/desktop/src/renderer/shell --retry=0
```

Expected: green.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src/renderer/shell/Sidebar.tsx packages/ui/src/i18n/en.ts packages/ui/src/mission.css
git commit -m "feat(desktop): the Datasets list says how many datasets a move filed, with Undo"
```

---

### Task 4: Guide and testing document

**Files:**

- Modify: `docs/guide/28-survey-dates.md` (section "Moving a dataset to another date")
- Modify: `docs/TESTING.md` (the survey date folder checklist, after the line that starts "A project with a single survey date still shows", near line 523)

**Interfaces:** none.

- [ ] **Step 1: Guide.** In `docs/guide/28-survey-dates.md`, after the paragraph that ends "A flight row carries all of its clips with it.", add:

```markdown
To move everything of one kind at once, drag the group's heading instead: **Video**, **Photos**, **Panoramas**, **Models**, **Point clouds** or **Maps and rasters** inside a date folder. Every dataset of the group goes to the folder you drop it on, the ones behind "more" too. An offline basemap or an original review in the group stays where it is.
```

Change the paragraph that starts "Without dragging:" to:

```markdown
Without dragging: right-click a dataset or a group heading (or focus it and press the menu key or **Shift+F10**), then pick a date or **Every date (no date)** under **Move to date**. The **Belongs to date...** box in the Selection panel does the same for one dataset.
```

After it, add:

```markdown
After a move of more than one dataset, a note under the list says how many were moved and offers **Undo**, which puts them back under the date they had. Undo covers the last move only, until you dismiss the note, make another move or close the project.
```

- [ ] **Step 2: Testing document.** In `docs/TESTING.md`, after the "single survey date" line of that checklist, add:

```markdown
- [ ] Drag a group heading (for example **Video**) from one date folder onto another: every dataset of the group is now in that folder, and the note under the list says how many moved.
- [ ] Click **Undo** in the note: the datasets are back in the folder they came from.
- [ ] Right-click a group heading, pick a date under **Move to date**: the whole group moves, the same as the drag.
- [ ] A single dataset still drags on its own, as before.
```

- [ ] **Step 3: Check and commit.**

```bash
pnpm format:check
node tools/agent/check-public-text.mjs docs/guide/28-survey-dates.md docs/TESTING.md
git add docs/guide/28-survey-dates.md docs/TESTING.md
git commit -m "docs: moving a whole group to another survey date, and Undo"
```

Expected: both checks pass (`pnpm format` fixes formatting if needed).

---

### Task 5: End to end, the way CI runs it

Runs after Task 3.

**Files:**

- Modify: `apps/desktop/e2e/timeline.spec.ts` (inside `test.describe('survey date folders', ...)`, after the test "Every date takes the date off, unless the name carries one")

**Interfaces:**

- Consumes: `tree-group-<kind>` (Task 1), `date-note` and `date-undo` (Task 3), `move-menu` and `move-to-<id>` (existing), and the spec's own helpers `openThreeDates`, `savedManifest`, `dataHashes`, `dragOnto`, `expand`.
- The three-date fixture (not changed): each of `sep`, `oct`, `nov` holds a model `quad-<id>` (Models) and an outline `site-<id>` (Maps and rasters); the undated outline `design` sits in Every date. The project opens on `nov`.

- [ ] **Step 1: Write the tests.**

```ts
test('a group header dragged onto another date moves the whole group, and Undo puts it back', async ({
  dataRoot,
  threeDateProject,
  win,
}) => {
  const id = threeDateProject.id;
  await openThreeDates(win, id);
  const files = await dataHashes(dataRoot, id);
  const nov = win.getByTestId('date-folder-nov');
  const oct = win.getByTestId('date-folder-oct');
  const captureOf = async () =>
    Object.fromEntries(
      (await savedManifest(dataRoot, id)).layers.map((l) => [l.id, l.capture ?? null]),
    );

  // two outlines under November: its own and the undated one
  await dragOnto(
    win.getByTestId('date-folder-every').getByTestId('tree-row-design'),
    win.getByTestId('date-name-nov'),
  );
  await expect(nov.getByTestId('tree-row-design')).toBeVisible();
  await expect(win.getByTestId('date-note')).toHaveCount(0);
  const before = await captureOf();
  expect(before).toMatchObject({ 'site-nov': 'nov', design: 'nov' });

  // the Maps and rasters heading of November onto October: both outlines go, the model stays
  await dragOnto(nov.getByTestId('tree-group-maps'), win.getByTestId('date-name-oct'));
  await expect(nov.getByTestId('tree-row-site-nov')).toHaveCount(0);
  await expect(nov.getByTestId('tree-row-design')).toHaveCount(0);
  await expect(nov.getByTestId('tree-row-quad-nov')).toBeVisible();
  await expand(win, 'oct');
  await expect(oct.getByTestId('tree-row-site-nov')).toBeVisible();
  await expect(oct.getByTestId('tree-row-design')).toBeVisible();
  await expect(oct.getByTestId('tree-row-site-oct')).toBeVisible();
  await expect(win.getByTestId('date-note')).toContainText('2 datasets moved to');
  expect(await captureOf()).toEqual({ ...before, 'site-nov': 'oct', design: 'oct' });
  expect(await dataHashes(dataRoot, id)).toEqual(files);

  // Undo: both are back under November, and the note is gone
  await win.getByTestId('date-undo').click();
  await expect(win.getByTestId('date-note')).toHaveCount(0);
  await expect(nov.getByTestId('tree-row-site-nov')).toBeVisible();
  await expect(nov.getByTestId('tree-row-design')).toBeVisible();
  await expect(oct.getByTestId('tree-row-site-nov')).toHaveCount(0);
  expect(await captureOf()).toEqual(before);
  expect(await dataHashes(dataRoot, id)).toEqual(files);

  // a single dataset still drags on its own, with no note
  await dragOnto(nov.getByTestId('tree-row-quad-nov'), win.getByTestId('date-name-oct'));
  await expect(oct.getByTestId('tree-row-quad-nov')).toBeVisible();
  await expect(win.getByTestId('date-note')).toHaveCount(0);
});

test('Move to date on a group header moves the whole group', async ({
  dataRoot,
  threeDateProject,
  win,
}) => {
  const id = threeDateProject.id;
  await openThreeDates(win, id);
  const nov = win.getByTestId('date-folder-nov');
  await dragOnto(
    win.getByTestId('date-folder-every').getByTestId('tree-row-design'),
    win.getByTestId('date-name-nov'),
  );
  await expect(nov.getByTestId('tree-row-design')).toBeVisible();

  await nov.getByTestId('tree-group-maps').click({ button: 'right' });
  const menu = win.getByTestId('move-menu');
  await expect(menu).toContainText('Maps and rasters · 2 datasets');
  await expect(menu.getByTestId('move-to-nov')).toBeDisabled();
  await menu.getByTestId('move-to-sep').click();

  await expect(nov.getByTestId('tree-row-site-nov')).toHaveCount(0);
  await expand(win, 'sep');
  const sep = win.getByTestId('date-folder-sep');
  await expect(sep.getByTestId('tree-row-site-nov')).toBeVisible();
  await expect(sep.getByTestId('tree-row-design')).toBeVisible();
  const saved = await savedManifest(dataRoot, id);
  const at = Object.fromEntries(saved.layers.map((l) => [l.id, l.capture ?? null]));
  expect(at).toMatchObject({ 'site-nov': 'sep', design: 'sep', 'quad-nov': 'nov' });
});
```

If a helper's name or signature in the spec differs from what is used here, use the spec's (read lines 1 to 120 of the file first). If the right-click toggles the group closed, right-click the header's count or label through `nov.getByTestId('tree-group-maps').getByText('Maps and rasters')` instead; a context click must not collapse the group.

- [ ] **Step 2: Build what the specs need.** From the worktree root:

```bash
pnpm demo:build --quick
```

Then build the desktop app the way the e2e fixtures expect (read the `e2e` and `build` scripts in `apps/desktop/package.json` and the "End to end" part of `CONTRIBUTING.md`; run the build step it names before Playwright if the specs do not build on their own).

- [ ] **Step 3: Run the spec the way CI does.** From `apps/desktop`, in Git Bash:

```bash
QUADRION_WINDOW_SIZE=1100x700 QUADRION_E2E_SWGL=1 npx playwright test e2e/timeline.spec.ts --workers=1
```

Expected: every test of the file passes, the two new ones included. Then once more with `--repeat-each=3 -g "group header"` to catch a timing problem.

- [ ] **Step 4: If the header starts no drag in Chromium.** A drag that begins on the `<button>` inside the draggable row may not start. Find the cause first (superpowers:systematic-debugging; check with `startDrag` and the `dragging` class on the tree). The fix, if that is the cause: in `DatasetTree.tsx` put `draggable`, `onDragStart` and `onDragEnd` on the `.tgroup-btn` button instead of the row (keep `onContextMenu` and the test id on the row), widen the CSS rule to `.dtree .tgroup-btn[draggable='true']`, and in `DateTree.test.tsx` fire `dragstart` and `dragend` on the header's button and read `draggable` from it. Rerun Task 1's unit tests and this spec.

- [ ] **Step 5: Run the other spec that uses the same list.**

```bash
QUADRION_WINDOW_SIZE=1100x700 QUADRION_E2E_SWGL=1 npx playwright test e2e/date-annotations.spec.ts --workers=1
```

Expected: PASS (the test id added to group headers must not have changed anything it finds).

- [ ] **Step 6: Commit.**

```bash
git add apps/desktop/e2e/timeline.spec.ts
git commit -m "test(desktop): a group header moves its whole group to another date, by drag and by menu, with Undo"
```

(Also stage `packages/ui/src/tree/DatasetTree.tsx`, `packages/ui/src/tree/DateTree.test.tsx` and `packages/ui/src/mission.css` if Step 4 changed them, in a separate `fix(ui):` commit made before this one.)

---

## After the last task

1. `pnpm check` green in the worktree.
2. `node tools/agent/finish-task.mjs` and hand the branch to the Orchestrator.

## How to test (for the founder)

1. Open a project with at least two survey dates, with several videos, photo sets or panoramas under one of them.
2. In the Datasets list, open that date's folder. Press on the **Video** heading and drag it onto another date folder. The folders that can take it get a dashed outline; the one under the pointer lights up.
3. Drop. Every video of that date is now in the other folder, and a note under the list says how many datasets moved.
4. Click **Undo** in the note. The videos are back where they were.
5. Right-click the **Photos** heading, pick a date under **Move to date**. All photo sets move.
6. Drag one single dataset onto another date. It moves alone, as before.
