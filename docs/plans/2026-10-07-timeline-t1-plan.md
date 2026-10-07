# Timeline T1: Date Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Survey dates become the main axis of a project: date folders in the sidebar, one focused date with a date bar and calendar, free mixing of layers across dates, and date tags in every viewer.

**Architecture:** Pure date logic (focus swap, extras, remembered hides, tags) lives in `packages/workspace/src/timeline.ts` and `dateTags.ts`, unit-tested without React. A renderer store (`apps/desktop/src/renderer/workspace/timeline.ts`) holds the focused date per project, applies visibility changes to the workspace through one new action (`applyVisibility`), and persists per project in localStorage like `stagePrefs`. "Extras" are derived, not tracked: any visible layer of a date other than the focused one is an extra, so every existing `setLayerVisible` caller (sidebar, palette, tools) stays correct without changes. UI pieces (`DateTree`, `Calendar`) live in `packages/ui`; the renderer wires them into the Sidebar, a new date bar row and the viewers.

**Tech Stack:** TypeScript, React 19, zustand (vanilla stores), vitest (+ jsdom per file), Playwright e2e on Electron, plain global CSS (`packages/ui/src/mission.css`, `apps/desktop/src/renderer/styles.css`).

**Spec:** `docs/plans/2026-10-07-timeline-design.md` (T1 section). Read it first.

## Global Constraints

- No manifest schema change. A layer's date is whatever `captureIndex()` resolves (`index.of[layerId]`); absent = "Every date".
- Free mixing: any layer of any date may be visible at the same time.
- Jumping dates hides the previous focused date's layers, shows the next date's layers except those the user hid there last time, and never touches visible layers of other dates (extras) or Every date layers.
- Date-first tree only when the project has at least one capture and the sidebar is not collapsed to the rail; otherwise today's type-first tree.
- Date colour: `var(--date-N)` with N = (chronological index mod 8) + 1. Colour is never the only cue; tags always carry the short date text.
- Copy rules: sentence case, no "please", no "successfully", no exclamation marks. All strings through `packages/ui/src/i18n/en.ts` (`useT()`).
- Shortcuts: previous/next survey are `Alt+Left` / `Alt+Right` in the `global` scope.
- e2e runs off-screen (any run with `STRATLAS_USER_DATA` is off-screen; never set `STRATLAS_WINDOW=visible`).
- Commit after every task with a conventional message ending in `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push tags or create releases.

## Review Focus

1. Project opened for the first time (no saved pref) with all layers `visible: true` across 7 dates: only the latest date's layers plus Every date layers may be visible; otherwise every date's model piles up. Pinned by `openChange` tests (Task 1) and the e2e open check (Task 10).
2. A saved focus or remembered/extras ids that no longer exist (date or layer removed from the manifest): must fall back to the latest date and ignore unknown ids without throwing. Pinned by `initialFocus`/`snapshotPref` tests (Task 1).
3. Manifest replaced while the project is open (layer added, date assigned in the existing "Belongs to" picker): focus must survive and visibility must not reset. Pinned by the `attach` same-project test (Task 3).
4. Keyboard date stepping while typing in a text field (issue comment, search): `Alt+Left/Right` must not jump dates when focus is in an input/textarea/contenteditable. Pinned by the `isTypingTarget` test (Task 8).
5. The video clip that is playing belongs to the old date: after a jump it switches to the matching clip of the new date, but a clip the user opened from a third date (an extra) stays. Pinned by `focusSurvey` active-clip tests (Task 3).

---

## File map

| File                                                                                                                                                           | Responsibility                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `packages/workspace/src/timeline.ts` (new)                                                                                                                     | Pure focus/visibility rules, stepping, pane follow, layer date         |
| `packages/workspace/src/dateTags.ts` (new)                                                                                                                     | Date colour tags and short/long labels                                 |
| `packages/workspace/src/index.ts`                                                                                                                              | `applyVisibility` action; re-exports                                   |
| `packages/ui/src/tokens.css`                                                                                                                                   | `--date-1..8` colours                                                  |
| `apps/desktop/src/renderer/workspace/timeline.ts` (new)                                                                                                        | Renderer timeline store, persistence, `useTimeline`, `useTimelineSync` |
| `packages/ui/src/tree/dateModel.ts` (new)                                                                                                                      | `buildDateTree`: folders of kind groups                                |
| `packages/ui/src/tree/DateTree.tsx` (new)                                                                                                                      | Date folder rows around nested `DatasetTree`s                          |
| `packages/ui/src/tree/DatasetTree.tsx`                                                                                                                         | `nested` prop (role="group" root)                                      |
| `packages/ui/src/dates/calendar.ts` (new)                                                                                                                      | Month grid model                                                       |
| `packages/ui/src/dates/Calendar.tsx` (new)                                                                                                                     | Calendar popover body                                                  |
| `apps/desktop/src/renderer/shell/Sidebar.tsx`                                                                                                                  | Choose DateTree vs DatasetTree                                         |
| `apps/desktop/src/renderer/workspace/DateBar.tsx` (new)                                                                                                        | Date bar, calendar popover                                             |
| `apps/desktop/src/renderer/workspace/WorkspaceScreen.tsx`, `styles.css`                                                                                        | Date bar grid row, sync hook                                           |
| `packages/ui/src/shortcuts.ts`, `apps/desktop/src/renderer/App.tsx`, `shell/Palette.tsx`                                                                       | Shortcuts and palette commands                                         |
| `apps/desktop/src/renderer/workspace/DatesOnScreen.tsx` (new), `SplitPanes.tsx`, `FloatingVideo.tsx`, `Stage.tsx`, `packages/engine/src/adapters/panoramas.ts` | Viewer date tags, panes following focus                                |
| `apps/desktop/e2e/fixtures.ts`, `apps/desktop/e2e/timeline.spec.ts` (new)                                                                                      | Three-date fixture, e2e                                                |
| `docs/guide/28-survey-dates.md` (new), `docs/guide/04-compare-dates.md`, `docs/TESTING.md`, `docs/guide/12-settings.md` (generated)                            | Docs                                                                   |

Commands used throughout (from the repo root):

- One unit test file: `pnpm vitest run <path>`
- Typecheck: `pnpm typecheck`
- Lint: `pnpm lint`
- e2e (builds first): `pnpm -F @aio/desktop exec electron-vite build` then `pnpm -F @aio/desktop exec playwright test timeline --workers=1 --grep-invert @realdata`

---

### Task 1: Timeline rules in `packages/workspace`

**Files:**

- Create: `packages/workspace/src/timeline.ts`
- Create: `packages/workspace/src/timeline.test.ts`
- Modify: `packages/workspace/src/index.ts` (WorkspaceActions ~:56-79, store body ~:97-196, re-exports ~:213-226)

**Interfaces:**

- Consumes: `captureIndex`, `counterpart`, `type CaptureIndex` from `./captures`; `Layer`, `ProjectManifest` from `@aio/schema`.
- Produces:
  - `interface DatePref { focus?: string; remembered?: Record<string, string[]>; extras?: string[] }`
  - `interface VisibilityChange { show: string[]; hide: string[] }`
  - `initialFocus(index: CaptureIndex, saved: string | undefined): string | null`
  - `openChange(index: CaptureIndex, hidden: Readonly<Record<string, true>>, focus: string | null, pref: DatePref): VisibilityChange`
  - `swapChange(index: CaptureIndex, hidden: Readonly<Record<string, true>>, prev: string | null, next: string, remembered: Readonly<Record<string, string[]>>): { change: VisibilityChange; remembered: Record<string, string[]> }`
  - `extrasOf(index: CaptureIndex, hidden: Readonly<Record<string, true>>, focus: string | null): string[]`
  - `visibleIn(index: CaptureIndex, hidden: Readonly<Record<string, true>>, capture: string): number`
  - `snapshotPref(index: CaptureIndex, hidden: Readonly<Record<string, true>>, focus: string | null, remembered: Readonly<Record<string, string[]>>): DatePref`
  - `stepCapture(index: CaptureIndex, focus: string | null, step: -1 | 1): string | null`
  - `followLayer(index: CaptureIndex, layers: readonly Pick<Layer, 'id' | 'kind'>[], layerId: string, next: string): string | undefined`
  - `layerDate(manifest: Pick<ProjectManifest, 'captures' | 'layers'>, layerId: string): string | undefined`
  - Workspace action `applyVisibility(show: readonly string[], hide: readonly string[]): void`

- [ ] **Step 1: Write the failing tests**

`packages/workspace/src/timeline.test.ts`:

```ts
import type { Layer, ProjectManifest } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { captureIndex } from './captures';
import { createWorkspace } from './index';
import {
  extrasOf,
  followLayer,
  initialFocus,
  layerDate,
  openChange,
  snapshotPref,
  stepCapture,
  swapChange,
  visibleIn,
} from './timeline';

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const mesh = (id: string, capture?: string): Layer =>
  ({
    kind: 'mesh',
    id,
    name: id,
    visible: true,
    capture,
    src: { path: `models/${id}.glb` },
    transform: I,
  }) as Layer;
const ortho = (id: string, capture?: string): Layer =>
  ({
    kind: 'raster',
    id,
    name: id,
    visible: true,
    capture,
    role: 'ortho',
    format: 'kit-pyramid',
    src: { path: `rasters/${id}/tiles.json` },
  }) as Layer;

const manifest: ProjectManifest = {
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32640 },
  origin: [0, 0, 0],
  captures: [
    { id: 'sep', label: 'Survey 4 Sep', date: '2024-09-04' },
    { id: 'oct', label: 'Survey 2 Oct', date: '2024-10-02' },
    { id: 'nov', label: 'Survey 6 Nov', date: '2024-11-06' },
  ],
  layers: [
    mesh('model-sep', 'sep'),
    ortho('ortho-sep', 'sep'),
    mesh('model-oct', 'oct'),
    ortho('ortho-oct', 'oct'),
    mesh('model-nov', 'nov'),
    ortho('ortho-nov', 'nov'),
    ortho('design'),
  ],
} as ProjectManifest;
const index = captureIndex(manifest);
const none: Record<string, true> = {};

describe('initialFocus', () => {
  it('keeps a saved focus that still exists', () => {
    expect(initialFocus(index, 'oct')).toBe('oct');
  });
  it('falls back to the latest date for unknown or missing saved focus', () => {
    expect(initialFocus(index, 'gone')).toBe('nov');
    expect(initialFocus(index, undefined)).toBe('nov');
  });
  it('is null without captures', () => {
    expect(initialFocus(captureIndex({ captures: [], layers: [] }), undefined)).toBeNull();
  });
});

describe('openChange', () => {
  it('first open: focused date and Every date on, other dates off', () => {
    const c = openChange(index, none, 'nov', {});
    expect(c.show.sort()).toEqual(['model-nov', 'ortho-nov']);
    expect(c.hide.sort()).toEqual(['model-oct', 'model-sep', 'ortho-oct', 'ortho-sep']);
  });
  it('first open honours layers already hidden in the focused date', () => {
    const c = openChange(index, { 'ortho-nov': true }, 'nov', {});
    expect(c.hide).toContain('ortho-nov');
  });
  it('saved pref: remembered hides and extras', () => {
    const c = openChange(index, none, 'nov', {
      remembered: { nov: ['ortho-nov'] },
      extras: ['ortho-sep', 'gone'],
    });
    expect(c.show.sort()).toEqual(['model-nov', 'ortho-sep']);
    expect(c.hide).toContain('ortho-nov');
    expect(c.hide).not.toContain('design');
  });
});

describe('swapChange', () => {
  it('hides the old date, shows the new one, keeps extras', () => {
    const hidden = { 'model-sep': true, 'model-oct': true, 'ortho-oct': true } as const;
    // focus nov, extra ortho-sep visible
    const { change, remembered } = swapChange(index, hidden, 'nov', 'oct', {});
    expect(change.hide.sort()).toEqual(['model-nov', 'ortho-nov']);
    expect(change.show.sort()).toEqual(['model-oct', 'ortho-oct']);
    expect(change.hide).not.toContain('ortho-sep');
    expect(remembered.nov).toEqual([]);
  });
  it('remembers hides of the date being left and restores them on return', () => {
    const hidden = {
      'ortho-nov': true,
      'model-oct': true,
      'ortho-oct': true,
      'model-sep': true,
      'ortho-sep': true,
    } as const;
    const out = swapChange(index, hidden, 'nov', 'oct', {});
    expect(out.remembered.nov).toEqual(['ortho-nov']);
    const back = swapChange(
      index,
      { 'ortho-nov': true, 'model-nov': true },
      'oct',
      'nov',
      out.remembered,
    );
    expect(back.change.show).toEqual(['model-nov']);
  });
  it('an extra of the new date stays visible (promoted into focus)', () => {
    const hidden = { 'model-oct': true } as const; // ortho-oct visible as an extra
    const { change } = swapChange(index, hidden, 'nov', 'oct', { oct: ['ortho-oct'] });
    expect(change.hide).not.toContain('ortho-oct');
  });
  it('same date is a no-op', () => {
    expect(swapChange(index, none, 'nov', 'nov', {}).change).toEqual({ show: [], hide: [] });
  });
  it('never touches Every date layers', () => {
    const { change } = swapChange(index, none, 'nov', 'oct', {});
    expect([...change.show, ...change.hide]).not.toContain('design');
  });
});

describe('extrasOf, visibleIn, snapshotPref', () => {
  const hidden = { 'model-sep': true, 'model-oct': true, 'ortho-oct': true } as const;
  it('extras are visible layers of non-focused dates', () => {
    expect(extrasOf(index, hidden, 'nov')).toEqual(['ortho-sep']);
  });
  it('counts visible layers per date', () => {
    expect(visibleIn(index, hidden, 'sep')).toBe(1);
    expect(visibleIn(index, hidden, 'oct')).toBe(0);
  });
  it('snapshot records the focused date hides and drops unknown dates', () => {
    const p = snapshotPref(index, { ...hidden, 'ortho-nov': true }, 'nov', {
      gone: ['x'],
      oct: ['ortho-oct'],
    });
    expect(p).toEqual({
      focus: 'nov',
      remembered: { oct: ['ortho-oct'], nov: ['ortho-nov'] },
      extras: ['ortho-sep'],
    });
  });
});

describe('stepCapture', () => {
  it('steps in date order and stops at the ends', () => {
    expect(stepCapture(index, 'oct', -1)).toBe('sep');
    expect(stepCapture(index, 'oct', 1)).toBe('nov');
    expect(stepCapture(index, 'nov', 1)).toBeNull();
    expect(stepCapture(index, 'sep', -1)).toBeNull();
  });
  it('without focus starts from the latest date', () => {
    expect(stepCapture(index, null, -1)).toBe('nov');
  });
});

describe('followLayer', () => {
  it('maps to the counterpart on the next date', () => {
    expect(followLayer(index, manifest.layers, 'ortho-nov', 'oct')).toBe('ortho-oct');
  });
  it('keeps undated layers', () => {
    expect(followLayer(index, manifest.layers, 'design', 'oct')).toBe('design');
  });
  it('falls back to the first layer of the same kind', () => {
    const m = { ...manifest, layers: [...manifest.layers, mesh('extra-scan-nov', 'nov')] };
    const ix = captureIndex(m);
    expect(followLayer(ix, m.layers, 'extra-scan-nov', 'sep')).toBe('model-sep');
  });
  it('is undefined when the next date has no layer of that kind', () => {
    const m = { ...manifest, layers: manifest.layers.filter((l) => l.id !== 'model-sep') };
    expect(followLayer(captureIndex(m), m.layers, 'model-nov', 'sep')).toBeUndefined();
  });
});

describe('layerDate', () => {
  it('returns the ISO date of the layer survey', () => {
    expect(layerDate(manifest, 'ortho-oct')).toBe('2024-10-02');
    expect(layerDate(manifest, 'design')).toBeUndefined();
  });
});

describe('applyVisibility', () => {
  it('shows and hides in one update', () => {
    const ws = createWorkspace();
    ws.getState().openProject({ id: 'p', root: '/p', manifest });
    let updates = 0;
    ws.subscribe(() => (updates += 1));
    ws.getState().applyVisibility(['model-nov'], ['ortho-nov', 'design']);
    expect(updates).toBe(1);
    expect(ws.getState().hidden).toEqual({ 'ortho-nov': true, design: true });
  });
  it('does nothing for an empty change', () => {
    const ws = createWorkspace();
    let updates = 0;
    ws.subscribe(() => (updates += 1));
    ws.getState().applyVisibility([], []);
    expect(updates).toBe(0);
  });
});
```

Note: if `captureIndex` slots `ortho-*` and `model-*` differently from what `counterpart` expects, check `slot` rules in `captures.ts` (§13 of `docs/architecture/data-conventions.md`) and adjust only the fixture names, not the assertions' intent.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/workspace/src/timeline.test.ts`
Expected: FAIL, cannot resolve `./timeline` / `applyVisibility` is not a function.

- [ ] **Step 3: Implement `timeline.ts`**

```ts
import type { Layer, ProjectManifest } from '@aio/schema';
import { captureIndex, counterpart, type CaptureIndex } from './captures';

/** Saved per project: the focused survey date and how each date was left. */
export interface DatePref {
  focus?: string;
  /** Per survey date, the layers hidden when that date was last focused. */
  remembered?: Record<string, string[]>;
  /** Visible layers of dates other than the focused one. */
  extras?: string[];
}

export interface VisibilityChange {
  show: string[];
  hide: string[];
}

type Hidden = Readonly<Record<string, true>>;

function known(index: CaptureIndex, id: string | null | undefined): id is string {
  return !!id && index.captures.some((c) => c.id === id);
}

export function initialFocus(index: CaptureIndex, saved: string | undefined): string | null {
  if (known(index, saved)) return saved;
  return index.captures.at(-1)?.id ?? null;
}

/**
 * Visibility when a project opens: the focused date minus its remembered hides, plus saved
 * extras. Every date layers (absent from `index.of`) are left alone. Without a remembered entry
 * the focused date keeps whatever is already hidden (the manifest's `visible: false`).
 */
export function openChange(
  index: CaptureIndex,
  hidden: Hidden,
  focus: string | null,
  pref: DatePref,
): VisibilityChange {
  const saved = focus ? pref.remembered?.[focus] : undefined;
  const off = new Set(
    saved ?? (focus ? (index.layers[focus] ?? []).filter((id) => hidden[id]) : []),
  );
  const extras = new Set(pref.extras ?? []);
  const change: VisibilityChange = { show: [], hide: [] };
  for (const [layer, capture] of Object.entries(index.of)) {
    const on = capture === focus ? !off.has(layer) : extras.has(layer);
    (on ? change.show : change.hide).push(layer);
  }
  return change;
}

/** Jump from `prev` to `next`: swap the focused date's layers, keep extras. */
export function swapChange(
  index: CaptureIndex,
  hidden: Hidden,
  prev: string | null,
  next: string,
  remembered: Readonly<Record<string, string[]>>,
): { change: VisibilityChange; remembered: Record<string, string[]> } {
  const out: Record<string, string[]> = { ...remembered };
  const change: VisibilityChange = { show: [], hide: [] };
  if (prev === next) return { change, remembered: out };
  if (prev) {
    const left = index.layers[prev] ?? [];
    out[prev] = left.filter((id) => hidden[id]);
    for (const id of left) if (!hidden[id]) change.hide.push(id);
  }
  const keepOff = new Set(out[next] ?? []);
  for (const id of index.layers[next] ?? []) {
    if (hidden[id] && !keepOff.has(id)) change.show.push(id);
  }
  return { change, remembered: out };
}

export function extrasOf(index: CaptureIndex, hidden: Hidden, focus: string | null): string[] {
  return Object.entries(index.of)
    .filter(([id, capture]) => capture !== focus && !hidden[id])
    .map(([id]) => id);
}

export function visibleIn(index: CaptureIndex, hidden: Hidden, capture: string): number {
  return (index.layers[capture] ?? []).filter((id) => !hidden[id]).length;
}

/** What to save for a project now: unknown dates dropped, focused date's hides recorded. */
export function snapshotPref(
  index: CaptureIndex,
  hidden: Hidden,
  focus: string | null,
  remembered: Readonly<Record<string, string[]>>,
): DatePref {
  const kept: Record<string, string[]> = {};
  for (const [capture, ids] of Object.entries(remembered)) {
    if (known(index, capture)) kept[capture] = ids;
  }
  if (focus) kept[focus] = (index.layers[focus] ?? []).filter((id) => hidden[id]);
  return { ...(focus ? { focus } : {}), remembered: kept, extras: extrasOf(index, hidden, focus) };
}

/** The previous or next survey in date order; null past either end. No focus starts at the latest. */
export function stepCapture(
  index: CaptureIndex,
  focus: string | null,
  step: -1 | 1,
): string | null {
  const ids = index.captures.map((c) => c.id);
  if (ids.length === 0) return null;
  const at = focus ? ids.indexOf(focus) : -1;
  if (at < 0) return ids.at(-1) ?? null;
  return ids[at + step] ?? null;
}

/** The layer a pane should show on `next`: counterpart, else first of the same kind. */
export function followLayer(
  index: CaptureIndex,
  layers: readonly Pick<Layer, 'id' | 'kind'>[],
  layerId: string,
  next: string,
): string | undefined {
  if (!(layerId in index.of)) return layerId;
  const twin = counterpart(index, layerId, next);
  if (twin) return twin;
  const kindOf = (id: string) => layers.find((l) => l.id === id)?.kind;
  const kind = kindOf(layerId);
  return (index.layers[next] ?? []).find((id) => kindOf(id) === kind);
}

/** ISO date of the survey a layer belongs to, if any. */
export function layerDate(
  manifest: Pick<ProjectManifest, 'captures' | 'layers'>,
  layerId: string,
): string | undefined {
  const index = captureIndex(manifest);
  const capture = index.of[layerId];
  return index.captures.find((c) => c.id === capture)?.date;
}
```

- [ ] **Step 4: Add `applyVisibility` to the workspace store**

In `packages/workspace/src/index.ts`, add to `WorkspaceActions` after `setLayersVisible` (~:72):

```ts
  /** Show and hide layers in one update (date jumps). No-op when both lists are empty. */
  applyVisibility(show: readonly string[], hide: readonly string[]): void;
```

and in the store body next to `setLayersVisible` (~:162-173):

```ts
    applyVisibility: (show, hide) => {
      if (show.length === 0 && hide.length === 0) return;
      const hidden = { ...get().hidden };
      for (const id of show) delete hidden[id];
      for (const id of hide) hidden[id] = true;
      set({ hidden });
    },
```

Add re-exports next to the `./captures` block (~:213-226):

```ts
export {
  extrasOf,
  followLayer,
  initialFocus,
  layerDate,
  openChange,
  snapshotPref,
  stepCapture,
  swapChange,
  visibleIn,
} from './timeline';
export type { DatePref, VisibilityChange } from './timeline';
```

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm vitest run packages/workspace/src/timeline.test.ts packages/workspace/src/captures.test.ts packages/workspace/src/index.test.ts`
Expected: all PASS.
Run: `pnpm typecheck`
Expected: no errors (any other `Workspace` mock object in the repo that lists every action must gain `applyVisibility`; fix each one tsc reports).

- [ ] **Step 6: Commit**

```bash
git add packages/workspace/src/timeline.ts packages/workspace/src/timeline.test.ts packages/workspace/src/index.ts
git commit -m "feat(workspace): survey date focus and visibility rules"
```

---

### Task 2: Date colour tags

**Files:**

- Create: `packages/workspace/src/dateTags.ts`
- Create: `packages/workspace/src/dateTags.test.ts`
- Modify: `packages/workspace/src/index.ts` (re-export)
- Modify: `packages/ui/src/tokens.css` (first theme block, next to `--acc` at ~:22)

**Interfaces:**

- Produces:
  - `const DATE_COLOURS = 8`
  - `interface DateTag { id: string; date: string; order: number; colour: string; short: string; long: string }`
  - `dateTags(captures: readonly Pick<Capture, 'id' | 'date'>[]): Record<string, DateTag>`
  - CSS custom properties `--date-1` … `--date-8`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { dateTags } from './dateTags';

describe('dateTags', () => {
  const tags = dateTags([
    { id: 'nov', date: '2024-11-06' },
    { id: 'sep', date: '2024-09-04' },
    { id: 'oct', date: '2024-10-02' },
  ]);
  it('orders by date regardless of input order', () => {
    expect([tags.sep?.order, tags.oct?.order, tags.nov?.order]).toEqual([0, 1, 2]);
  });
  it('assigns palette colours by order', () => {
    expect(tags.sep?.colour).toBe('var(--date-1)');
    expect(tags.nov?.colour).toBe('var(--date-3)');
  });
  it('short labels drop the year inside one calendar year', () => {
    expect(tags.nov?.short).toBe('6 Nov');
    expect(tags.nov?.long).toBe('6 Nov 2024');
  });
  it('short labels keep a two-digit year across years', () => {
    const t = dateTags([
      { id: 'a', date: '2024-12-30' },
      { id: 'b', date: '2025-01-06' },
    ]);
    expect(t.a?.short).toBe('30 Dec 24');
    expect(t.b?.short).toBe('6 Jan 25');
  });
  it('wraps colours after eight dates', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      id: `d${i}`,
      date: `2024-01-${String(i + 1).padStart(2, '0')}`,
    }));
    expect(dateTags(many).d8?.colour).toBe('var(--date-1)');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/workspace/src/dateTags.test.ts`
Expected: FAIL, cannot resolve `./dateTags`.

- [ ] **Step 3: Implement**

```ts
import type { Capture } from '@aio/schema';

export const DATE_COLOURS = 8;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** How one survey date is shown everywhere: colour swatch plus text. */
export interface DateTag {
  id: string;
  date: string;
  /** Position in date order, oldest first. */
  order: number;
  colour: string;
  short: string;
  long: string;
}

function parts(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return { y: y ?? 0, m: m ?? 1, d: d ?? 1 };
}

export function dateTags(
  captures: readonly Pick<Capture, 'id' | 'date'>[],
): Record<string, DateTag> {
  const sorted = [...captures].sort(
    (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id),
  );
  const years = new Set(sorted.map((c) => parts(c.date).y));
  const out: Record<string, DateTag> = {};
  sorted.forEach((c, order) => {
    const { y, m, d } = parts(c.date);
    const month = MONTHS[m - 1] ?? '';
    out[c.id] = {
      id: c.id,
      date: c.date,
      order,
      colour: `var(--date-${(order % DATE_COLOURS) + 1})`,
      short: years.size > 1 ? `${d} ${month} ${String(y).slice(-2)}` : `${d} ${month}`,
      long: `${d} ${month} ${y}`,
    };
  });
  return out;
}
```

Re-export from `index.ts`:

```ts
export { DATE_COLOURS, dateTags } from './dateTags';
export type { DateTag } from './dateTags';
```

Add to the first theme block in `packages/ui/src/tokens.css` (the block that defines `--acc` at ~:22). One set serves every theme: mid lightness, used only as small swatches and 3px bars with text beside them.

```css
--date-1: oklch(0.68 0.14 250);
--date-2: oklch(0.72 0.14 160);
--date-3: oklch(0.74 0.15 75);
--date-4: oklch(0.66 0.17 25);
--date-5: oklch(0.66 0.15 300);
--date-6: oklch(0.72 0.12 200);
--date-7: oklch(0.7 0.15 120);
--date-8: oklch(0.68 0.15 350);
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/workspace/src/dateTags.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/workspace/src/dateTags.ts packages/workspace/src/dateTags.test.ts packages/workspace/src/index.ts packages/ui/src/tokens.css
git commit -m "feat(workspace): survey date colour tags"
```

---

### Task 3: Renderer timeline store and persistence

**Files:**

- Create: `apps/desktop/src/renderer/workspace/timeline.ts`
- Create: `apps/desktop/src/renderer/workspace/timeline.test.ts`
- Modify: `apps/desktop/src/renderer/workspace/stagePrefs.ts:48` (export `browserStorage`)
- Modify: `apps/desktop/src/renderer/workspace/WorkspaceScreen.tsx` (call `useTimelineSync()` at the top of the screen component)

**Interfaces:**

- Consumes: Task 1 functions and `applyVisibility`; `useCaptureIndex()` from `./compare`; `captureSelection` from `@aio/workspace`.
- Produces:
  - `interface TimelineState { projectId: string | null; index: CaptureIndex | null; focus: string | null; byProject: Record<string, DatePref>; attach(projectId: string | null, index: CaptureIndex | null): void; focusSurvey(capture: string): void; step(dir: -1 | 1): void }`
  - `createTimelineStore(ws?: StoreApi<Workspace>, storage?: Storage | null): StoreApi<TimelineState>`
  - `const timeline: StoreApi<TimelineState>`
  - `useTimeline<T>(selector: (s: TimelineState) => T): T`
  - `useTimelineSync(): void`
  - `const TIMELINE_KEY = 'stratlas.timeline'`

- [ ] **Step 1: Export `browserStorage`**

In `stagePrefs.ts:48` change `function browserStorage()` to `export function browserStorage()`.

- [ ] **Step 2: Write the failing tests**

`apps/desktop/src/renderer/workspace/timeline.test.ts` (reuse the same three-date manifest shape as Task 1; add one video layer per date):

```ts
import type { Layer, ProjectManifest } from '@aio/schema';
import { captureIndex, createWorkspace } from '@aio/workspace';
import { describe, expect, it } from 'vitest';
import { TIMELINE_KEY, createTimelineStore } from './timeline';

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const mesh = (id: string, capture?: string): Layer =>
  ({
    kind: 'mesh',
    id,
    name: id,
    visible: true,
    capture,
    src: { path: `models/${id}.glb` },
    transform: I,
  }) as Layer;
const video = (id: string, capture: string): Layer =>
  ({
    kind: 'video',
    id,
    name: id,
    visible: true,
    capture,
    src: { path: `video/${id}.mp4` },
  }) as unknown as Layer;

const manifest = {
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32640 },
  origin: [0, 0, 0],
  captures: [
    { id: 'sep', label: 'Sep', date: '2024-09-04' },
    { id: 'oct', label: 'Oct', date: '2024-10-02' },
    { id: 'nov', label: 'Nov', date: '2024-11-06' },
  ],
  layers: [
    mesh('model-sep', 'sep'),
    mesh('model-oct', 'oct'),
    mesh('model-nov', 'nov'),
    video('clip-sep', 'sep'),
    video('clip-oct', 'oct'),
    video('clip-nov', 'nov'),
    mesh('site'),
  ],
} as unknown as ProjectManifest;

class MemoryStorage {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
  clear() {
    this.data.clear();
  }
  key() {
    return null;
  }
  get length() {
    return this.data.size;
  }
}

function setup(saved?: unknown) {
  const ws = createWorkspace();
  const storage = new MemoryStorage();
  if (saved) storage.setItem(TIMELINE_KEY, JSON.stringify(saved));
  ws.getState().openProject({ id: 'p', root: '/p', manifest });
  const tl = createTimelineStore(ws, storage as unknown as Storage);
  const index = captureIndex(manifest);
  return { ws, tl, storage, index };
}

describe('timeline store', () => {
  it('attach focuses the latest date and hides other dates', () => {
    const { ws, tl, index } = setup();
    tl.getState().attach('p', index);
    expect(tl.getState().focus).toBe('nov');
    expect(Object.keys(ws.getState().hidden).sort()).toEqual([
      'clip-oct',
      'clip-sep',
      'model-oct',
      'model-sep',
    ]);
  });

  it('attach restores a saved focus and extras', () => {
    const { ws, tl, index } = setup({ p: { focus: 'oct', remembered: {}, extras: ['model-sep'] } });
    tl.getState().attach('p', index);
    expect(tl.getState().focus).toBe('oct');
    expect(ws.getState().hidden['model-sep']).toBeUndefined();
    expect(ws.getState().hidden['model-nov']).toBe(true);
  });

  it('attach for the same project with a new index keeps focus and visibility', () => {
    const { ws, tl, index } = setup();
    tl.getState().attach('p', index);
    tl.getState().focusSurvey('oct');
    ws.getState().setLayerVisible('model-sep', true);
    const before = ws.getState().hidden;
    tl.getState().attach('p', captureIndex({ ...manifest }));
    expect(tl.getState().focus).toBe('oct');
    expect(ws.getState().hidden).toEqual(before);
  });

  it('focusSurvey swaps dates and keeps a hand-picked extra', () => {
    const { ws, tl, index } = setup();
    tl.getState().attach('p', index);
    ws.getState().setLayerVisible('model-sep', true); // extra
    tl.getState().focusSurvey('oct');
    const h = ws.getState().hidden;
    expect(h['model-nov']).toBe(true);
    expect(h['model-oct']).toBeUndefined();
    expect(h['model-sep']).toBeUndefined();
  });

  it('focusSurvey moves the active clip of the old date to the new date', () => {
    const { ws, tl, index } = setup();
    tl.getState().attach('p', index);
    ws.getState().setActiveClip('clip-nov');
    tl.getState().focusSurvey('oct');
    expect(ws.getState().activeClip).toBe('clip-oct');
  });

  it('focusSurvey leaves an active clip from a third date alone', () => {
    const { ws, tl, index } = setup();
    tl.getState().attach('p', index);
    ws.getState().setActiveClip('clip-sep');
    tl.getState().focusSurvey('oct');
    expect(ws.getState().activeClip).toBe('clip-sep');
  });

  it('step walks dates and stops at the ends', () => {
    const { tl, index } = setup();
    tl.getState().attach('p', index);
    tl.getState().step(1);
    expect(tl.getState().focus).toBe('nov');
    tl.getState().step(-1);
    tl.getState().step(-1);
    tl.getState().step(-1);
    expect(tl.getState().focus).toBe('sep');
  });

  it('persists focus, remembered and extras per project', () => {
    const { ws, tl, storage, index } = setup();
    tl.getState().attach('p', index);
    ws.getState().setLayerVisible('model-sep', true);
    tl.getState().focusSurvey('oct');
    const saved = JSON.parse(storage.getItem(TIMELINE_KEY) ?? '{}');
    expect(saved.p.focus).toBe('oct');
    expect(saved.p.extras).toContain('model-sep');
  });

  it('ignores unknown dates and projects without dates', () => {
    const { tl, index } = setup();
    tl.getState().attach('p', index);
    tl.getState().focusSurvey('gone');
    expect(tl.getState().focus).toBe('nov');
    tl.getState().attach('q', captureIndex({ captures: [], layers: [] }));
    expect(tl.getState().focus).toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm vitest run apps/desktop/src/renderer/workspace/timeline.test.ts`
Expected: FAIL, cannot resolve `./timeline`.

- [ ] **Step 4: Implement `timeline.ts`**

```ts
import { useEffect } from 'react';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  captureSelection,
  followLayer,
  initialFocus,
  openChange,
  snapshotPref,
  stepCapture,
  swapChange,
  useWorkspace,
  workspace as appWorkspace,
  type CaptureIndex,
  type DatePref,
  type Workspace,
} from '@aio/workspace';
import { useCaptureIndex } from './compare';
import { browserStorage } from './stagePrefs';

export const TIMELINE_KEY = 'stratlas.timeline';

export interface TimelineState {
  projectId: string | null;
  index: CaptureIndex | null;
  focus: string | null;
  byProject: Record<string, DatePref>;
  /** Called whenever the open project or its capture index changes. */
  attach(projectId: string | null, index: CaptureIndex | null): void;
  focusSurvey(capture: string): void;
  step(dir: -1 | 1): void;
}

function load(storage: Storage | null): Record<string, DatePref> {
  try {
    const raw = storage?.getItem(TIMELINE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, DatePref>) : {};
  } catch {
    return {};
  }
}

export function createTimelineStore(
  ws: StoreApi<Workspace> = appWorkspace,
  storage: Storage | null = browserStorage(),
): StoreApi<TimelineState> {
  const store = createStore<TimelineState>()((set, get) => {
    const save = () => {
      const { projectId, index, focus, byProject } = get();
      if (!projectId || !index || index.captures.length === 0) return;
      const pref = snapshotPref(
        index,
        ws.getState().hidden,
        focus,
        byProject[projectId]?.remembered ?? {},
      );
      const next = { ...byProject, [projectId]: pref };
      set({ byProject: next });
      try {
        storage?.setItem(TIMELINE_KEY, JSON.stringify(next));
      } catch {
        // Storage full or blocked: the timeline still works for this session.
      }
    };

    return {
      projectId: null,
      index: null,
      focus: null,
      byProject: load(storage),

      attach: (projectId, index) => {
        const s = get();
        if (s.projectId === projectId && s.index === index) return;
        if (!projectId || !index || index.captures.length === 0) {
          set({ projectId, index, focus: null });
          return;
        }
        if (s.projectId === projectId && s.index) {
          // Same project, manifest changed: keep focus if it still exists, never reset visibility.
          const focus =
            s.focus && index.captures.some((c) => c.id === s.focus)
              ? s.focus
              : initialFocus(index, undefined);
          set({ index, focus });
          return;
        }
        const pref = s.byProject[projectId] ?? {};
        const focus = initialFocus(index, pref.focus);
        const change = openChange(index, ws.getState().hidden, focus, pref);
        ws.getState().applyVisibility(change.show, change.hide);
        set({ projectId, index, focus });
      },

      focusSurvey: (capture) => {
        const { index, focus: prev, projectId, byProject } = get();
        if (!index || !projectId || capture === prev) return;
        if (!index.captures.some((c) => c.id === capture)) return;
        const w = ws.getState();
        const { change, remembered } = swapChange(
          index,
          w.hidden,
          prev,
          capture,
          byProject[projectId]?.remembered ?? {},
        );
        w.applyVisibility(change.show, change.hide);

        const clip = w.activeClip;
        if (clip && prev && index.of[clip] === prev) {
          const layers = w.project?.manifest.layers ?? [];
          w.setActiveClip(followLayer(index, layers, clip, capture) ?? null);
        }
        const sel = w.selection;
        if (sel?.layer && prev && index.of[sel.layer] === prev) {
          w.select(sel.kind === 'asset' ? captureSelection(index, capture, sel) : null);
        }

        set({
          focus: capture,
          byProject: { ...byProject, [projectId]: { ...byProject[projectId], remembered } },
        });
        save();
      },

      step: (dir) => {
        const { index, focus } = get();
        if (!index) return;
        const next = stepCapture(index, focus, dir);
        if (next) get().focusSurvey(next);
      },
    };
  });

  // Visibility changes from anywhere (sidebar, palette, tools) update the saved pref.
  ws.subscribe((s, p) => {
    if (s.hidden !== p.hidden) {
      const { projectId, index, focus, byProject } = store.getState();
      if (!projectId || !index || index.captures.length === 0) return;
      const pref = snapshotPref(index, s.hidden, focus, byProject[projectId]?.remembered ?? {});
      const next = { ...byProject, [projectId]: pref };
      store.setState({ byProject: next });
      try {
        storage?.setItem(TIMELINE_KEY, JSON.stringify(next));
      } catch {
        // see save()
      }
    }
  });

  return store;
}

export const timeline = createTimelineStore();

export function useTimeline<T>(selector: (s: TimelineState) => T): T {
  return useStore(timeline, selector);
}

/** Keeps the timeline attached to the open project. Mount once in the workspace screen. */
export function useTimelineSync(): void {
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  const index = useCaptureIndex();
  useEffect(() => {
    timeline.getState().attach(projectId, index);
  }, [projectId, index]);
}
```

Then factor the duplicated persist block: move the body of the `ws.subscribe` callback into a module-level `persist(store, ws, storage, hidden)` helper used by both `save()` and the subscription, so the write logic exists once. Keep behaviour identical; the tests in Step 2 cover it.

In `WorkspaceScreen.tsx`, import `useTimelineSync` from `./timeline` and call it as the first hook in the screen component.

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm vitest run apps/desktop/src/renderer/workspace/timeline.test.ts`
Expected: PASS.
Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/workspace/timeline.ts apps/desktop/src/renderer/workspace/timeline.test.ts apps/desktop/src/renderer/workspace/stagePrefs.ts apps/desktop/src/renderer/workspace/WorkspaceScreen.tsx
git commit -m "feat(desktop): timeline store with focused survey date per project"
```

---

### Task 4: Date-first tree model

**Files:**

- Create: `packages/ui/src/tree/dateModel.ts`
- Create: `packages/ui/src/tree/dateModel.test.ts`
- Modify: `packages/ui/src/index.ts:23` (export)

**Interfaces:**

- Consumes: `buildDatasetTree(manifest, issues, durations)`, `treeLayerIds(groups)`, `TreeGroup` from `./model`; fixtures `mockManifest`, `mockIssue` from `../__fixtures__/project`.
- Produces:
  - `const EVERY_DATE = 'every'`
  - `interface DateFolder { id: string; capture: Capture | null; label: string; sub?: string; groups: TreeGroup[]; layerIds: string[] }`
  - `buildDateTree(manifest: ProjectManifest, issues: readonly Issue[], durations: Readonly<Record<string, number>>, dates: { captures: readonly Capture[]; of: Readonly<Record<string, string>> }, labels: { every: string; dateLabel: (c: Capture) => string }): DateFolder[]`

- [ ] **Step 1: Write the failing test**

```ts
import type { Capture, ProjectManifest } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { mockIssue, mockManifest } from '../__fixtures__/project';
import { EVERY_DATE, buildDateTree } from './dateModel';

const base = mockManifest();
const [first, second] = base.layers;
const captures: Capture[] = [
  { id: 'a', label: 'Survey A', date: '2024-09-04' },
  { id: 'b', label: '2024-10-02', date: '2024-10-02' },
  { id: 'c', label: 'Survey C', date: '2024-11-06' },
];
const manifest: ProjectManifest = { ...base, captures };
const of = { [first!.id]: 'a', [second!.id]: 'c' };
const labels = { every: 'Every date', dateLabel: (c: Capture) => c.date };

describe('buildDateTree', () => {
  const folders = buildDateTree(manifest, [mockIssue()], {}, { captures, of }, labels);

  it('puts Every date first, then dates newest first', () => {
    expect(folders.map((f) => f.id)).toEqual([EVERY_DATE, 'c', 'b', 'a']);
  });
  it('places each dated layer in its date folder only', () => {
    expect(folders.find((f) => f.id === 'a')?.layerIds).toEqual([first!.id]);
    expect(folders.find((f) => f.id === EVERY_DATE)?.layerIds).not.toContain(first!.id);
  });
  it('keeps an empty date folder with no groups', () => {
    const b = folders.find((f) => f.id === 'b');
    expect(b?.groups).toEqual([]);
    expect(b?.layerIds).toEqual([]);
  });
  it('shows the capture label as sub text when it differs from the date', () => {
    expect(folders.find((f) => f.id === 'a')?.sub).toBe('Survey A');
    expect(folders.find((f) => f.id === 'b')?.sub).toBeUndefined();
  });
  it('keeps annotations in Every date', () => {
    const every = folders.find((f) => f.id === EVERY_DATE);
    expect(every?.groups.some((g) => g.kind === 'annotations')).toBe(true);
    expect(folders.find((f) => f.id === 'a')?.groups.some((g) => g.kind === 'annotations')).toBe(
      false,
    );
  });
  it('drops Every date when it would be empty', () => {
    const only = { ...manifest, layers: [first!] };
    const f = buildDateTree(only, [], {}, { captures, of: { [first!.id]: 'a' } }, labels);
    expect(f[0]?.id).toBe('c');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/ui/src/tree/dateModel.test.ts`
Expected: FAIL, cannot resolve `./dateModel`.

- [ ] **Step 3: Implement**

```ts
import type { Capture, Issue, ProjectManifest } from '@aio/schema';
import { buildDatasetTree, treeLayerIds, type TreeGroup } from './model';

export const EVERY_DATE = 'every';

/** One sidebar folder: a survey date (or Every date) holding the usual kind groups. */
export interface DateFolder {
  id: string;
  capture: Capture | null;
  label: string;
  sub?: string;
  groups: TreeGroup[];
  layerIds: string[];
}

export function buildDateTree(
  manifest: ProjectManifest,
  issues: readonly Issue[],
  durations: Readonly<Record<string, number>>,
  dates: { captures: readonly Capture[]; of: Readonly<Record<string, string>> },
  labels: { every: string; dateLabel: (c: Capture) => string },
): DateFolder[] {
  const folders: DateFolder[] = [];
  const common = manifest.layers.filter((l) => !(l.id in dates.of));
  const everyGroups = buildDatasetTree({ ...manifest, layers: common }, issues, durations);
  if (everyGroups.length > 0) {
    folders.push({
      id: EVERY_DATE,
      capture: null,
      label: labels.every,
      groups: everyGroups,
      layerIds: treeLayerIds(everyGroups),
    });
  }
  const newestFirst = [...dates.captures].sort(
    (a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id),
  );
  for (const c of newestFirst) {
    const layers = manifest.layers.filter((l) => dates.of[l.id] === c.id);
    const groups =
      layers.length > 0 ? buildDatasetTree({ ...manifest, layers }, [], durations) : [];
    const label = labels.dateLabel(c);
    folders.push({
      id: c.id,
      capture: c,
      label,
      ...(c.label !== label && c.label !== c.date ? { sub: c.label } : {}),
      groups,
      layerIds: treeLayerIds(groups),
    });
  }
  return folders;
}
```

Note: `treeLayerIds` collects ids from rows that have a `layerId` (flight rows contribute their children). If the `layerIds` test fails because of that, read `treeLayerIds` at `model.ts:160` and use `layers.map((l) => l.id)` for dated folders instead; the folder eye must cover exactly the layers in the folder.

Export from `packages/ui/src/index.ts` next to `export * from './tree/model'`:

```ts
export * from './tree/dateModel';
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/ui/src/tree/dateModel.test.ts packages/ui/src/tree/model.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/tree/dateModel.ts packages/ui/src/tree/dateModel.test.ts packages/ui/src/index.ts
git commit -m "feat(ui): date-first dataset tree model"
```

---

### Task 5: `DateTree` component

**Files:**

- Create: `packages/ui/src/tree/DateTree.tsx`
- Create: `packages/ui/src/tree/DateTree.test.tsx`
- Modify: `packages/ui/src/tree/DatasetTree.tsx` (props ~:14-40; root element ~:212)
- Modify: `packages/ui/src/index.ts:24` (export)
- Modify: `packages/ui/src/i18n/en.ts` (new keys)
- Modify: `packages/ui/src/mission.css` (after the tree rules ending ~:1007)

**Interfaces:**

- Consumes: `DateFolder`, `EVERY_DATE` (Task 4); `DateTag` (Task 2); `DatasetTree`, `VisibilityEye`, `DatasetTreeProps`.
- Produces:
  - `DatasetTreeProps.nested?: boolean | undefined`
  - `interface DateTreeProps extends Omit<DatasetTreeProps, 'groups' | 'collapsed' | 'nested'> { folders: readonly DateFolder[]; tags: Readonly<Record<string, DateTag>>; focus: string | null; onFocus: (capture: string) => void }`
  - `DateTree(props: DateTreeProps): JSX.Element`
  - test ids: `date-folder-<id>`, `date-name-<id>`, `date-on-<id>`

- [ ] **Step 1: Add i18n keys** to `packages/ui/src/i18n/en.ts` (keep alphabetical placement next to other `tree.` keys):

```ts
  'tree.dates.label': 'Datasets by survey date',
  'tree.dates.every': 'Every date',
  'tree.dates.expand': 'Expand {date}',
  'tree.dates.collapse': 'Collapse {date}',
  'tree.dates.focus': 'View {date}',
  'tree.dates.empty': 'No data for this date yet',
  'tree.dates.on_one': '{count} on',
  'tree.dates.on_other': '{count} on',
  'tree.eye.hideDate': 'Hide everything from {date}',
  'tree.eye.showDate': 'Show everything from {date}',
  'tree.eye.showDateMixed': 'Show everything from {date}',
```

Check how `_one`/`_other` keys are called elsewhere (`'timeline.clips_one'` at en.ts:121): use the same call form (`t('tree.dates.on', { count })`).

- [ ] **Step 2: Add the `nested` prop to `DatasetTree`**

In `DatasetTreeProps` add:

```ts
  /** Rendered inside a date folder: the root is a group, not a second tree. */
  nested?: boolean | undefined;
```

and change the root (~:212) from `<div className="tree" role="tree" aria-label="Datasets">` to:

```tsx
    <div
      className={props.nested ? 'tree tree-nested' : 'tree'}
      role={props.nested ? 'group' : 'tree'}
      aria-label={props.nested ? undefined : 'Datasets'}
    >
```

- [ ] **Step 3: Write the failing test**

`packages/ui/src/tree/DateTree.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DateTag } from '@aio/workspace';
import { DateTree } from './DateTree';
import type { DateFolder } from './dateModel';
import type { TreeGroup } from './model';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const group = (ids: string[]): TreeGroup => ({
  kind: 'models',
  label: 'Models',
  icon: 'scene',
  count: ids.length,
  items: ids.map((id) => ({ id, layerId: id, layerKind: 'mesh', name: id })),
});
const cap = (id: string, date: string) => ({ id, label: id, date });
const folders: DateFolder[] = [
  {
    id: 'every',
    capture: null,
    label: 'Every date',
    groups: [group(['site'])],
    layerIds: ['site'],
  },
  {
    id: 'nov',
    capture: cap('nov', '2024-11-06'),
    label: '6 Nov 2024',
    groups: [group(['m-nov'])],
    layerIds: ['m-nov'],
  },
  {
    id: 'oct',
    capture: cap('oct', '2024-10-02'),
    label: '2 Oct 2024',
    groups: [group(['m-oct'])],
    layerIds: ['m-oct'],
  },
  { id: 'sep', capture: cap('sep', '2024-09-04'), label: '4 Sep 2024', groups: [], layerIds: [] },
];
const tags: Record<string, DateTag> = {
  sep: {
    id: 'sep',
    date: '2024-09-04',
    order: 0,
    colour: 'var(--date-1)',
    short: '4 Sep',
    long: '4 Sep 2024',
  },
  oct: {
    id: 'oct',
    date: '2024-10-02',
    order: 1,
    colour: 'var(--date-2)',
    short: '2 Oct',
    long: '2 Oct 2024',
  },
  nov: {
    id: 'nov',
    date: '2024-11-06',
    order: 2,
    colour: 'var(--date-3)',
    short: '6 Nov',
    long: '6 Nov 2024',
  },
};

let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => host.remove());

function render(focus: string, hidden: Record<string, true>, onFocus = vi.fn()) {
  const root = createRoot(host);
  const props = {
    folders,
    tags,
    focus,
    onFocus,
    hidden,
    selectedId: null,
    activeClip: null,
    onToggleVisible: vi.fn(),
    onSetVisible: vi.fn(),
    onSelect: vi.fn(),
  };
  act(() => root.render(<DateTree {...props} />));
  return { root, props, onFocus };
}
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`);

describe('DateTree', () => {
  it('expands only the focused date and marks it current', () => {
    render('nov', { 'm-oct': true });
    expect(q('date-folder-nov')?.getAttribute('aria-expanded')).toBe('true');
    expect(q('date-folder-oct')?.getAttribute('aria-expanded')).toBe('false');
    expect(q('date-name-nov')?.getAttribute('aria-current')).toBe('date');
  });

  it('clicking a date name focuses it', () => {
    const { onFocus } = render('nov', {});
    act(() => (q('date-name-oct') as HTMLButtonElement).click());
    expect(onFocus).toHaveBeenCalledWith('oct');
  });

  it('collapses other dates when focus changes', () => {
    const { root, props } = render('nov', {});
    act(() => root.render(<DateTree {...props} focus="oct" />));
    expect(q('date-folder-oct')?.getAttribute('aria-expanded')).toBe('true');
    expect(q('date-folder-nov')?.getAttribute('aria-expanded')).toBe('false');
  });

  it('shows the count of visible layers on a collapsed non-focused date', () => {
    render('nov', {}); // m-oct visible = extra
    expect(q('date-on-oct')?.textContent).toBe('1 on');
    expect(q('date-on-nov')).toBeNull();
  });

  it('greys an empty date', () => {
    render('nov', {});
    expect(q('date-folder-sep')?.className).toContain('empty');
  });
});
```

- [ ] **Step 4: Run to verify failure**

Run: `pnpm vitest run packages/ui/src/tree/DateTree.test.tsx`
Expected: FAIL, cannot resolve `./DateTree`.

- [ ] **Step 5: Implement `DateTree.tsx`**

```tsx
import { useEffect, useState, type CSSProperties } from 'react';
import type { DateTag } from '@aio/workspace';
import { useT } from '../i18n';
import { Icon } from '../icons/Icon';
import { DatasetTree, VisibilityEye, type DatasetTreeProps } from './DatasetTree';
import { EVERY_DATE, type DateFolder } from './dateModel';

export interface DateTreeProps extends Omit<DatasetTreeProps, 'groups' | 'collapsed' | 'nested'> {
  folders: readonly DateFolder[];
  tags: Readonly<Record<string, DateTag>>;
  focus: string | null;
  onFocus: (capture: string) => void;
}

export function DateTree(props: DateTreeProps) {
  const { folders, tags, focus, onFocus, hidden, ...rest } = props;
  const t = useT();
  const [open, setOpen] = useState<Record<string, boolean>>(() => ({
    [EVERY_DATE]: true,
    ...(focus ? { [focus]: true } : {}),
  }));

  useEffect(() => {
    if (focus) setOpen((o) => ({ [EVERY_DATE]: o[EVERY_DATE] ?? true, [focus]: true }));
  }, [focus]);

  return (
    <div className="tree dtree" role="tree" aria-label={t('tree.dates.label')}>
      {folders.map((f) => {
        const expanded = open[f.id] === true;
        const focused = f.id === focus;
        const empty = f.capture !== null && f.layerIds.length === 0;
        const tag = f.capture ? tags[f.capture.id] : undefined;
        const on = f.capture && !focused ? f.layerIds.filter((id) => !hidden[id]).length : 0;
        const toggle = () => setOpen((o) => ({ ...o, [f.id]: !expanded }));
        return (
          <div
            key={f.id}
            role="treeitem"
            aria-expanded={expanded}
            aria-selected={focused}
            className={`dfolder${focused ? ' focused' : ''}${empty ? ' empty' : ''}`}
            data-testid={`date-folder-${f.id}`}
            style={tag ? ({ '--dtag': tag.colour } as CSSProperties) : undefined}
          >
            <div className="dfolder-row">
              <button
                type="button"
                className="dchev"
                aria-label={t(expanded ? 'tree.dates.collapse' : 'tree.dates.expand', {
                  date: f.label,
                })}
                onClick={toggle}
              >
                <Icon name="chev-r" size={12} className="chev" />
              </button>
              <button
                type="button"
                className="dname"
                data-testid={`date-name-${f.id}`}
                aria-current={focused ? 'date' : undefined}
                title={f.capture ? t('tree.dates.focus', { date: f.label }) : undefined}
                onClick={() => (f.capture ? onFocus(f.capture.id) : toggle())}
              >
                <span className={tag ? 'dtag' : 'dtag every'} aria-hidden="true" />
                <span className="dlbl">{f.label}</span>
                {f.sub && <span className="dsub">{f.sub}</span>}
              </button>
              {on > 0 && (
                <span className="don" data-testid={`date-on-${f.id}`}>
                  {t('tree.dates.on', { count: on })}
                </span>
              )}
              {f.layerIds.length > 0 && props.onSetVisible && (
                <VisibilityEye
                  layerIds={f.layerIds}
                  hidden={hidden}
                  onSet={props.onSetVisible}
                  labels={{
                    all: t('tree.eye.hideDate', { date: f.label }),
                    none: t('tree.eye.showDate', { date: f.label }),
                    mixed: t('tree.eye.showDateMixed', { date: f.label }),
                  }}
                />
              )}
            </div>
            {expanded && empty && <p className="dempty">{t('tree.dates.empty')}</p>}
            {expanded && f.groups.length > 0 && (
              <DatasetTree {...rest} hidden={hidden} groups={f.groups} collapsed={false} nested />
            )}
          </div>
        );
      })}
    </div>
  );
}
```

If `useT()`'s `t` is typed against `CatalogueKey`, the ternary key needs no cast because both keys exist; if tsc complains about the plural key `'tree.dates.on'`, call it the way `timeline.clips` is called (search `t('timeline.clips'`).

Export from `packages/ui/src/index.ts` (next to `DatasetTree` at :24):

```ts
export { DateTree, type DateTreeProps } from './tree/DateTree';
```

- [ ] **Step 6: Styles** in `packages/ui/src/mission.css` after the tree rules:

```css
.dfolder-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px 2px 2px;
  border-radius: var(--r-4);
}
.dfolder.focused > .dfolder-row {
  background: color-mix(in oklch, var(--dtag, var(--acc)) 18%, transparent);
  box-shadow: inset 3px 0 0 var(--dtag, var(--acc));
}
.dfolder .dchev {
  all: unset;
  display: grid;
  place-items: center;
  width: 18px;
  height: 22px;
  cursor: pointer;
  color: var(--fg-2);
}
.dfolder[aria-expanded='true'] > .dfolder-row .chev {
  transform: rotate(90deg);
}
.dfolder .dname {
  all: unset;
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: var(--t-12);
  color: var(--fg-0);
}
.dfolder .dname:focus-visible,
.dfolder .dchev:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 1px;
}
.dfolder.focused .dlbl {
  font-weight: 600;
}
.dfolder .dlbl {
  white-space: nowrap;
}
.dfolder .dsub {
  color: var(--fg-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dtag {
  width: 10px;
  height: 10px;
  border-radius: 3px;
  flex: none;
  background: var(--dtag);
}
.dtag.every {
  background: transparent;
  border: 1px solid var(--fg-3);
}
.dfolder.empty .dname {
  color: var(--fg-3);
}
.don {
  font-size: 11px;
  color: var(--fg-2);
  padding: 0 6px;
  border-radius: 8px;
  background: var(--bg-3);
  white-space: nowrap;
}
.dempty {
  margin: 2px 0 6px 28px;
  font-size: var(--t-12);
  color: var(--fg-3);
}
.tree-nested {
  padding-left: 14px;
}
```

- [ ] **Step 7: Run tests**

Run: `pnpm vitest run packages/ui/src/tree/DateTree.test.tsx packages/ui/src/tree/DatasetTree.test.tsx packages/ui/src/tree/eyes.test.tsx packages/ui/src/i18n/i18n.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/ui/src/tree/DateTree.tsx packages/ui/src/tree/DateTree.test.tsx packages/ui/src/tree/DatasetTree.tsx packages/ui/src/index.ts packages/ui/src/i18n/en.ts packages/ui/src/mission.css
git commit -m "feat(ui): date folders tree with focus, extras count and folder eye"
```

---

### Task 6: Sidebar uses the date tree

**Files:**

- Modify: `apps/desktop/src/renderer/shell/Sidebar.tsx` (Datasets section ~:221-315)

**Interfaces:**

- Consumes: `buildDateTree`, `DateTree`, `formatDate` from `@aio/ui`; `dateTags` from `@aio/workspace`; `useTimeline`, `timeline` from `../workspace/timeline`; `useCaptureIndex` from `../workspace/compare`.

- [ ] **Step 1: Wire it**

Inside the Datasets component, after the existing `groups` memo (~:231-234):

```tsx
const index = useCaptureIndex();
const focus = useTimeline((s) => s.focus);
const datesOn = !collapsed && index !== null && index.captures.length > 0;
const tags = useMemo(() => (index ? dateTags(index.captures) : {}), [index]);
const folders = useMemo(
  () =>
    project && index && datesOn
      ? buildDateTree(project.manifest, issues, durations, index, {
          every: t('tree.dates.every'),
          dateLabel: (c) => formatDate(c.date),
        })
      : [],
  [project, index, datesOn, issues, durations, t],
);
```

(`collapsed` is whatever the component already passes to `DatasetTree`'s `collapsed` prop; `t` is the component's existing `useT()` result, add `const t = useT();` if absent.)

Replace the single `<DatasetTree ... />` render with:

```tsx
{
  datesOn ? (
    <DateTree
      folders={folders}
      tags={tags}
      focus={focus}
      onFocus={(id) => timeline.getState().focusSurvey(id)}
      hidden={hidden}
      selectedId={selectedId}
      activeClip={activeClip}
      onToggleVisible={(id, visible) => workspace.getState().setLayerVisible(id, visible)}
      onSetVisible={setVisible}
      onSelect={onSelect}
      flightPath={flightPath}
      onLayerSettings={onLayerSettings}
    />
  ) : (
    <DatasetTree /* existing props unchanged */ />
  );
}
```

Hoist any inline props of the existing `DatasetTree` (`flightPath`, `onLayerSettings`, `onSelect`) into local consts first so both branches share them. The header master eye (`treeLayerIds(groups)`) stays as is: it covers all layers.

- [ ] **Step 2: Typecheck and run the sidebar-related unit tests**

Run: `pnpm typecheck && pnpm vitest run apps/desktop/src/renderer/shell`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/shell/Sidebar.tsx
git commit -m "feat(desktop): sidebar groups datasets by survey date"
```

---

### Task 7: Calendar model and component

**Files:**

- Create: `packages/ui/src/dates/calendar.ts`
- Create: `packages/ui/src/dates/calendar.test.ts`
- Create: `packages/ui/src/dates/Calendar.tsx`
- Create: `packages/ui/src/dates/Calendar.test.tsx`
- Modify: `packages/ui/src/index.ts`, `packages/ui/src/i18n/en.ts`, `packages/ui/src/mission.css`

**Interfaces:**

- Produces:
  - `monthGrid(month: string): (string | null)[][]` — `month` is `'YYYY-MM'`; rows of 7 ISO dates (Monday first), `null` outside the month
  - `surveyMonths(dates: readonly string[]): string[]` — sorted unique `'YYYY-MM'`
  - `stepMonth(months: readonly string[], current: string, dir: -1 | 1): string`
  - `interface CalendarDay { id: string; date: string; colour: string; label: string; count: number }`
  - `Calendar(props: { days: readonly CalendarDay[]; focusId: string | null; onPick: (id: string) => void; onClose: () => void }): JSX.Element`
  - test ids: `calendar`, `cal-month`, `cal-day-<YYYY-MM-DD>`, `cal-prev`, `cal-next`

- [ ] **Step 1: Write the failing model test**

```ts
import { describe, expect, it } from 'vitest';
import { monthGrid, stepMonth, surveyMonths } from './calendar';

describe('calendar model', () => {
  it('builds a Monday-first grid', () => {
    const g = monthGrid('2024-11'); // 1 Nov 2024 is a Friday
    expect(g[0]).toEqual([null, null, null, null, '2024-11-01', '2024-11-02', '2024-11-03']);
    expect(g.flat().filter(Boolean)).toHaveLength(30);
    expect(g.every((row) => row.length === 7)).toBe(true);
  });
  it('lists survey months once, sorted', () => {
    expect(surveyMonths(['2024-11-06', '2024-09-04', '2024-11-25'])).toEqual([
      '2024-09',
      '2024-11',
    ]);
  });
  it('steps only between survey months and clamps at the ends', () => {
    const m = ['2024-09', '2024-11', '2025-02'];
    expect(stepMonth(m, '2024-11', 1)).toBe('2025-02');
    expect(stepMonth(m, '2024-11', -1)).toBe('2024-09');
    expect(stepMonth(m, '2025-02', 1)).toBe('2025-02');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/ui/src/dates/calendar.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `calendar.ts`**

```ts
const pad = (n: number) => String(n).padStart(2, '0');

export function monthGrid(month: string): (string | null)[][] {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7; // Monday = 0
  const cells: (string | null)[] = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= days; d += 1) cells.push(`${y}-${pad(m)}-${pad(d)}`);
  while (cells.length % 7 !== 0) cells.push(null);
  const rows: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
  return rows;
}

export function surveyMonths(dates: readonly string[]): string[] {
  return [...new Set(dates.map((d) => d.slice(0, 7)))].sort();
}

export function stepMonth(months: readonly string[], current: string, dir: -1 | 1): string {
  const at = months.indexOf(current);
  if (at < 0) return months.at(dir < 0 ? 0 : -1) ?? current;
  return months[Math.min(months.length - 1, Math.max(0, at + dir))] ?? current;
}
```

- [ ] **Step 4: Run model test**: `pnpm vitest run packages/ui/src/dates/calendar.test.ts` → PASS.

- [ ] **Step 5: i18n keys** in `en.ts`:

```ts
  'calendar.label': 'Survey calendar',
  'calendar.prev': 'Previous month with a survey',
  'calendar.next': 'Next month with a survey',
  'calendar.day': '{date}, survey, {count} layers',
  'calendar.pick': 'Surveys on {date}',
  'calendar.weekdays': 'Mo Tu We Th Fr Sa Su',
```

- [ ] **Step 6: Write the failing component test** (`Calendar.test.tsx`, jsdom, same act/createRoot harness as Task 5):

```tsx
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Calendar, type CalendarDay } from './Calendar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const days: CalendarDay[] = [
  { id: 'sep', date: '2024-09-04', colour: 'var(--date-1)', label: '4 Sep 2024', count: 6 },
  { id: 'nov', date: '2024-11-06', colour: 'var(--date-2)', label: '6 Nov 2024', count: 9 },
  { id: 'nov-b', date: '2024-11-06', colour: 'var(--date-3)', label: '6 Nov 2024', count: 2 },
];
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => host.remove());
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

function render(focusId: string | null, onPick = vi.fn(), onClose = vi.fn()) {
  const root = createRoot(host);
  act(() =>
    root.render(<Calendar days={days} focusId={focusId} onPick={onPick} onClose={onClose} />),
  );
  return { onPick, onClose };
}

describe('Calendar', () => {
  it('opens on the focused month and skips months without surveys', () => {
    render('sep');
    expect(q('cal-month')?.textContent).toContain('2024');
    expect(q('cal-day-2024-09-04')).not.toBeNull();
    act(() => q('cal-next')?.click());
    expect(q('cal-day-2024-11-06')).not.toBeNull(); // October skipped
  });
  it('picks a single-survey day', () => {
    const { onPick } = render('sep');
    act(() => q('cal-day-2024-09-04')?.click());
    expect(onPick).toHaveBeenCalledWith('sep');
  });
  it('lists surveys when a day has more than one', () => {
    const { onPick } = render('nov');
    act(() => q('cal-day-2024-11-06')?.click());
    const options = host.querySelectorAll('[data-testid^="cal-choice-"]');
    expect(options).toHaveLength(2);
    act(() => (options[1] as HTMLElement).click());
    expect(onPick).toHaveBeenCalledWith('nov-b');
  });
  it('Escape closes', () => {
    const { onClose } = render('nov');
    act(() =>
      q('calendar')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    expect(onClose).toHaveBeenCalled();
  });
  it('arrow keys move between days and Enter picks a survey day', () => {
    const { onPick } = render('sep');
    q('cal-day-2024-09-04')?.focus();
    act(() =>
      q('calendar')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
    );
    expect(onPick).toHaveBeenCalledWith('sep');
  });
});
```

- [ ] **Step 7: Run to verify failure**: `pnpm vitest run packages/ui/src/dates/Calendar.test.tsx` → FAIL.

- [ ] **Step 8: Implement `Calendar.tsx`**

```tsx
import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useT } from '../i18n';
import { Icon } from '../icons/Icon';
import { monthGrid, stepMonth, surveyMonths } from './calendar';

export interface CalendarDay {
  id: string;
  date: string;
  colour: string;
  label: string;
  count: number;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export function Calendar(props: {
  days: readonly CalendarDay[];
  focusId: string | null;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const { days, focusId, onPick, onClose } = props;
  const t = useT();
  const root = useRef<HTMLDivElement>(null);
  const byDate = useMemo(() => {
    const m = new Map<string, CalendarDay[]>();
    for (const d of days) m.set(d.date, [...(m.get(d.date) ?? []), d]);
    return m;
  }, [days]);
  const months = useMemo(() => surveyMonths(days.map((d) => d.date)), [days]);
  const focusDate = days.find((d) => d.id === focusId)?.date ?? days.at(-1)?.date ?? '';
  const [month, setMonth] = useState(focusDate.slice(0, 7) || (months.at(-1) ?? ''));
  const [choice, setChoice] = useState<string | null>(null);
  const [y, m] = month.split('-').map(Number) as [number, number];

  const pickDate = (date: string) => {
    const on = byDate.get(date) ?? [];
    if (on.length === 1 && on[0]) onPick(on[0].id);
    else if (on.length > 1) setChoice(date);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = document.activeElement as HTMLElement | null;
    const date = el?.dataset.date;
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault();
      setMonth(stepMonth(months, month, e.key === 'PageUp' ? -1 : 1));
      return;
    }
    if (!date) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pickDate(date);
      return;
    }
    const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (delta === undefined) return;
    e.preventDefault();
    const next = new Date(`${date}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + delta);
    const iso = next.toISOString().slice(0, 10);
    if (iso.slice(0, 7) !== month) setMonth(iso.slice(0, 7));
    requestAnimationFrame(() =>
      root.current?.querySelector<HTMLElement>(`[data-date="${iso}"]`)?.focus(),
    );
  };

  return (
    <div
      ref={root}
      className="cal"
      role="dialog"
      aria-label={t('calendar.label')}
      data-testid="calendar"
      onKeyDown={onKeyDown}
    >
      <div className="cal-head">
        <button
          type="button"
          className="btn icon sm ghost"
          data-testid="cal-prev"
          aria-label={t('calendar.prev')}
          onClick={() => setMonth(stepMonth(months, month, -1))}
        >
          <Icon name="back" size={14} />
        </button>
        <span className="cal-month" data-testid="cal-month" aria-live="polite">
          {MONTHS[m - 1]} {y}
        </span>
        <button
          type="button"
          className="btn icon sm ghost"
          data-testid="cal-next"
          aria-label={t('calendar.next')}
          onClick={() => setMonth(stepMonth(months, month, 1))}
        >
          <Icon name="fwd" size={14} />
        </button>
      </div>
      <div className="cal-grid" role="grid">
        <div className="cal-row cal-wd" role="row" aria-hidden="true">
          {t('calendar.weekdays')
            .split(' ')
            .map((w) => (
              <span key={w}>{w}</span>
            ))}
        </div>
        {monthGrid(month).map((row, r) => (
          <div className="cal-row" role="row" key={r}>
            {row.map((date, c) => {
              if (!date) return <span key={c} className="cal-cell" role="gridcell" />;
              const on = byDate.get(date) ?? [];
              const first = on[0];
              const day = Number(date.slice(8));
              if (!first)
                return (
                  <span key={c} className="cal-cell" role="gridcell">
                    {day}
                  </span>
                );
              const current = on.some((d) => d.id === focusId);
              return (
                <span key={c} role="gridcell" className="cal-cell">
                  <button
                    type="button"
                    className={`cal-day${current ? ' current' : ''}`}
                    data-testid={`cal-day-${date}`}
                    data-date={date}
                    style={{ background: first.colour }}
                    aria-label={t('calendar.day', {
                      date: first.label,
                      count: on.reduce((n, d) => n + d.count, 0),
                    })}
                    aria-current={current ? 'date' : undefined}
                    onClick={() => pickDate(date)}
                  >
                    {day}
                    {on.length > 1 && <span className="cal-multi">{on.length}</span>}
                  </button>
                </span>
              );
            })}
          </div>
        ))}
      </div>
      {choice && (
        <div
          className="cal-choices"
          role="listbox"
          aria-label={t('calendar.pick', { date: choice })}
        >
          {(byDate.get(choice) ?? []).map((d) => (
            <button
              key={d.id}
              type="button"
              role="option"
              aria-selected={d.id === focusId}
              data-testid={`cal-choice-${d.id}`}
              onClick={() => onPick(d.id)}
            >
              <span className="dtag" style={{ background: d.colour }} aria-hidden="true" />{' '}
              {d.label} · {d.count}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

Note: the Enter test focuses a button inside the dialog and dispatches on the container; `document.activeElement` is the focused day button, so `dataset.date` is set. In jsdom `requestAnimationFrame` exists; if not, guard with `typeof requestAnimationFrame === 'function'`.

Styles in `mission.css`:

```css
.cal {
  width: 260px;
  padding: 10px;
  background: var(--bg-2);
  border: 1px solid var(--line);
  border-radius: 10px;
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.25);
}
.cal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.cal-month {
  font-weight: 600;
  font-size: var(--t-12);
}
.cal-row {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
}
.cal-wd span {
  font-size: 11px;
  color: var(--fg-3);
  text-align: center;
  padding: 2px 0;
}
.cal-cell {
  height: 30px;
  display: grid;
  place-items: center;
  font-size: var(--t-12);
  color: var(--fg-3);
}
.cal-day {
  all: unset;
  position: relative;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  color: oklch(0.2 0 0);
  font-weight: 600;
  cursor: pointer;
}
.cal-day.current {
  box-shadow:
    0 0 0 2px var(--bg-2),
    0 0 0 4px var(--fg-0);
}
.cal-day:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
}
.cal-multi {
  position: absolute;
  top: -4px;
  right: -6px;
  font-size: 10px;
  min-width: 14px;
  height: 14px;
  border-radius: 7px;
  background: var(--fg-0);
  color: var(--bg-0);
  display: grid;
  place-items: center;
}
.cal-choices {
  display: grid;
  gap: 2px;
  margin-top: 8px;
  border-top: 1px solid var(--line);
  padding-top: 6px;
}
.cal-choices button {
  all: unset;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  border-radius: var(--r-4);
  cursor: pointer;
  font-size: var(--t-12);
}
.cal-choices button:hover,
.cal-choices button:focus-visible {
  background: var(--bg-3);
}
```

Exports in `packages/ui/src/index.ts`:

```ts
export * from './dates/calendar';
export { Calendar, type CalendarDay } from './dates/Calendar';
```

- [ ] **Step 9: Run tests**: `pnpm vitest run packages/ui/src/dates` → PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/ui/src/dates packages/ui/src/index.ts packages/ui/src/i18n/en.ts packages/ui/src/mission.css
git commit -m "feat(ui): survey calendar"
```

---

### Task 8: Date bar, shortcuts and palette commands

**Files:**

- Create: `apps/desktop/src/renderer/workspace/DateBar.tsx`
- Create: `apps/desktop/src/renderer/workspace/DateBar.test.tsx`
- Modify: `apps/desktop/src/renderer/workspace/WorkspaceScreen.tsx:248-290` (insert before `<Stage/>`)
- Modify: `apps/desktop/src/renderer/styles.css:901-906` (`.ws` grid) and add `.dbar` rules
- Modify: `packages/ui/src/shortcuts.ts` (`SHORTCUTS` global block ~:83-92)
- Modify: `packages/ui/src/i18n/en.ts`
- Modify: `apps/desktop/src/renderer/App.tsx:63-92` (`onKeyDown`)
- Modify: `apps/desktop/src/renderer/shell/Palette.tsx` (commands `useMemo` ~:67+)
- Regenerate: `docs/guide/12-settings.md`

**Interfaces:**

- Consumes: `timeline`, `useTimeline` (Task 3); `dateTags` (Task 2); `Calendar`, `CalendarDay`, `useFocusTrap` from `@aio/ui`; `visibleIn` is not needed; layer count per date = `index.layers[id]?.length ?? 0`.
- Produces:
  - `DateBar(): JSX.Element | null`, test ids `date-bar`, `date-bar-prev`, `date-bar-next`, `date-bar-open`, `date-bar-count`
  - shortcut ids `global.prevSurvey` (`Alt+Left`), `global.nextSurvey` (`Alt+Right`)
  - `isTypingTarget(target: EventTarget | null): boolean` exported from `DateBar.tsx`

- [ ] **Step 1: i18n keys**

```ts
  'datebar.label': 'Survey date',
  'datebar.prev': 'Previous survey',
  'datebar.next': 'Next survey',
  'datebar.open': 'Choose survey date, {date}',
  'datebar.count': '{n} of {total} surveys',
  'keys.global.prevSurvey': 'Go to the previous survey date',
  'keys.global.nextSurvey': 'Go to the next survey date',
  'palette.prevSurvey': 'Go to previous survey',
  'palette.nextSurvey': 'Go to next survey',
  'palette.chooseSurvey': 'Go to survey date…',
```

- [ ] **Step 2: Shortcuts**

Add to `SHORTCUTS` in the global block:

```ts
  { id: 'global.prevSurvey', scope: 'global', keys: ['Alt+Left'], label: 'keys.global.prevSurvey' },
  { id: 'global.nextSurvey', scope: 'global', keys: ['Alt+Right'], label: 'keys.global.nextSurvey' },
```

Run: `pnpm vitest run packages/ui/src/shortcuts.test.ts`
Expected: PASS (the existing `shortcutConflicts` test proves no collision). If `Alt+Left` does not parse, check `parseCombo` (:513-526) accepts `Alt` with named arrows (Ctrl+Alt+B proves the modifier works).

- [ ] **Step 3: Write the failing DateBar test**

`DateBar.test.tsx` (jsdom). It renders `DateBar` against the real `timeline` and `workspace` singletons after attaching a three-date manifest (reuse the Task 3 manifest; put it in `apps/desktop/src/renderer/workspace/__fixtures__/threeDates.ts` and import it from both tests, moving the Task 3 inline copy there):

```tsx
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { captureIndex, workspace } from '@aio/workspace';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { threeDates } from './__fixtures__/threeDates';
import { DateBar, isTypingTarget } from './DateBar';
import { timeline } from './timeline';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  workspace.getState().openProject({ id: 'p3', root: '/p3', manifest: threeDates });
  timeline.getState().attach('p3', captureIndex(threeDates));
});
afterEach(() => {
  host.remove();
  timeline.getState().attach(null, null);
  workspace.getState().closeProject();
});
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('DateBar', () => {
  it('shows the focused date and position', () => {
    act(() => createRoot(host).render(<DateBar />));
    expect(q('date-bar-open')?.textContent).toContain('6 Nov 2024');
    expect(q('date-bar-count')?.textContent).toBe('3 of 3 surveys');
  });
  it('previous arrow steps back', () => {
    act(() => createRoot(host).render(<DateBar />));
    act(() => q('date-bar-prev')?.click());
    expect(timeline.getState().focus).toBe('oct');
  });
  it('opens the calendar and picks a date', () => {
    act(() => createRoot(host).render(<DateBar />));
    act(() => q('date-bar-open')?.click());
    act(() => q('cal-prev')?.click()); // Nov -> Oct
    act(() => q('cal-prev')?.click()); // Oct -> Sep
    act(() => q('cal-day-2024-09-04')?.click());
    expect(timeline.getState().focus).toBe('sep');
    expect(q('calendar')).toBeNull();
  });
});

describe('isTypingTarget', () => {
  it('is true for inputs, textareas and contenteditable', () => {
    const input = document.createElement('input');
    const area = document.createElement('textarea');
    const div = document.createElement('div');
    div.contentEditable = 'true';
    expect([isTypingTarget(input), isTypingTarget(area), isTypingTarget(div)]).toEqual([
      true,
      true,
      true,
    ]);
    expect(isTypingTarget(document.createElement('button'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
```

`__fixtures__/threeDates.ts` exports `threeDates: ProjectManifest` with captures sep/oct/nov (dates `2024-09-04`, `2024-10-02`, `2024-11-06`) and the layers listed in Task 3's test.

- [ ] **Step 4: Run to verify failure**: `pnpm vitest run apps/desktop/src/renderer/workspace/DateBar.test.tsx` → FAIL.

- [ ] **Step 5: Implement `DateBar.tsx`**

```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import { Calendar, Icon, formatDate, useFocusTrap, useT, type CalendarDay } from '@aio/ui';
import { dateTags } from '@aio/workspace';
import { timeline, useTimeline } from './timeline';

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.getAttribute('contenteditable') === 'true') return true;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

export function DateBar() {
  const t = useT();
  const index = useTimeline((s) => s.index);
  const focus = useTimeline((s) => s.focus);
  const [open, setOpen] = useState(false);
  const pop = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  useFocusTrap(pop, open, { onEscape: () => setOpen(false), returnTo: opener });

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!pop.current?.contains(e.target as Node) && !opener.current?.contains(e.target as Node))
        setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);

  const tags = useMemo(() => (index ? dateTags(index.captures) : {}), [index]);
  const days: CalendarDay[] = useMemo(
    () =>
      (index?.captures ?? []).map((c) => ({
        id: c.id,
        date: c.date,
        colour: tags[c.id]?.colour ?? 'var(--acc)',
        label: formatDate(c.date),
        count: index?.layers[c.id]?.length ?? 0,
      })),
    [index, tags],
  );

  if (!index || index.captures.length === 0 || !focus) return null;
  const at = index.captures.findIndex((c) => c.id === focus);
  const current = index.captures[at];
  const total = index.captures.length;
  const tag = tags[focus];

  return (
    <div className="dbar" role="toolbar" aria-label={t('datebar.label')} data-testid="date-bar">
      {total > 1 && (
        <button
          type="button"
          className="btn icon sm ghost"
          data-testid="date-bar-prev"
          aria-label={t('datebar.prev')}
          onClick={() => timeline.getState().step(-1)}
        >
          <Icon name="back" size={14} />
        </button>
      )}
      <button
        ref={opener}
        type="button"
        className="dbar-date"
        data-testid="date-bar-open"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('datebar.open', { date: current ? formatDate(current.date) : '' })}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="dtag" style={{ background: tag?.colour }} aria-hidden="true" />
        {current ? formatDate(current.date) : ''}
      </button>
      {total > 1 && (
        <button
          type="button"
          className="btn icon sm ghost"
          data-testid="date-bar-next"
          aria-label={t('datebar.next')}
          onClick={() => timeline.getState().step(1)}
        >
          <Icon name="fwd" size={14} />
        </button>
      )}
      <span className="dbar-count" data-testid="date-bar-count">
        {t('datebar.count', { n: at + 1, total })}
      </span>
      {open && (
        <div ref={pop} className="dbar-pop">
          <Calendar
            days={days}
            focusId={focus}
            onPick={(id) => {
              timeline.getState().focusSurvey(id);
              setOpen(false);
            }}
            onClose={() => setOpen(false)}
          />
        </div>
      )}
    </div>
  );
}
```

If `Icon`, `useT`, `useFocusTrap` or `formatDate` are not exported from `@aio/ui`'s index, import them from the paths other renderer files use (search `import { useFocusTrap`). Keep the `back`/`fwd` icon names (they exist in `icons/paths.tsx`).

- [ ] **Step 6: Layout.** In `WorkspaceScreen.tsx` insert `<DateBar />` directly before `<Stage/>` (~:254). In `styles.css` change the `.ws` grid (:901-906) to add a row and area:

```css
grid-template-rows: auto minmax(0, 1fr) auto;
grid-template-areas: 'dbar right' 'stage right' 'tl right';
```

(keep the existing columns line unchanged), and add:

```css
.dbar {
  grid-area: dbar;
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--line);
  background: var(--bg-1);
  min-height: 34px;
}
.dbar:empty {
  display: none;
}
.dbar-date {
  all: unset;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 3px 10px;
  border-radius: var(--r-4);
  font-weight: 600;
  cursor: pointer;
}
.dbar-date:hover,
.dbar-date[aria-expanded='true'] {
  background: var(--bg-3);
}
.dbar-date:focus-visible {
  outline: 2px solid var(--acc);
}
.dbar-count {
  color: var(--fg-3);
  font-size: var(--t-12);
  margin-inline-start: 4px;
}
.dbar-pop {
  position: absolute;
  top: calc(100% + 4px);
  left: 8px;
  z-index: 40;
}
```

When `DateBar` returns null, the `auto` row collapses to 0 height, so projects without dates look as before.

- [ ] **Step 7: Shortcut handling** in `App.tsx` `onKeyDown`, add before the `global.playPause` branch:

```ts
  } else if ((id === 'global.prevSurvey' || id === 'global.nextSurvey') && s.screen === 'scene' && !isTypingTarget(e.target)) {
    e.preventDefault();
    timeline.getState().step(id === 'global.prevSurvey' ? -1 : 1);
```

with imports `import { isTypingTarget } from './workspace/DateBar';` and `import { timeline } from './workspace/timeline';`. (`s.screen === 'scene'` is the workspace screen, as the play/pause branch shows.)

- [ ] **Step 8: Palette commands.** In `Palette.tsx` inside the commands `useMemo`, next to the other `action(...)` calls, add (only when the open project has dates; read `timeline.getState().index` there):

```ts
const tl = timeline.getState();
if (tl.index && tl.index.captures.length > 1) {
  action(
    'survey-prev',
    t('palette.prevSurvey'),
    'history',
    () => tl.step(-1),
    shortcutHint('global.prevSurvey'),
  );
  action(
    'survey-next',
    t('palette.nextSurvey'),
    'history',
    () => tl.step(1),
    shortcutHint('global.nextSurvey'),
  );
}
for (const c of tl.index?.captures ?? []) {
  action(`survey-${c.id}`, `${t('palette.chooseSurvey')} ${formatDate(c.date)}`, 'history', () =>
    tl.focusSurvey(c.id),
  );
}
```

Match the existing `action` signature (`action(id, title, icon, run, hint?)`, :82). If the palette titles are plain strings rather than `t()` keys, follow the file's convention. Add `useTimeline((s) => s.index)` to the `useMemo` dependencies so commands refresh when a project opens.

- [ ] **Step 9: Regenerate the shortcut guide**

Run: `STRATLAS_UPDATE_GUIDE_SHORTCUTS=1 pnpm vitest run apps/desktop/src/renderer/help/shortcuts.test.ts`
(PowerShell: `$env:STRATLAS_UPDATE_GUIDE_SHORTCUTS='1'; pnpm vitest run apps/desktop/src/renderer/help/shortcuts.test.ts`)
Expected: PASS and `docs/guide/12-settings.md` gains the two survey shortcuts.

- [ ] **Step 10: Run tests and typecheck**

Run: `pnpm vitest run apps/desktop/src/renderer/workspace/DateBar.test.tsx apps/desktop/src/renderer/workspace/timeline.test.ts packages/ui/src/shortcuts.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add apps/desktop/src/renderer/workspace/DateBar.tsx apps/desktop/src/renderer/workspace/DateBar.test.tsx apps/desktop/src/renderer/workspace/__fixtures__ apps/desktop/src/renderer/workspace/timeline.test.ts apps/desktop/src/renderer/workspace/WorkspaceScreen.tsx apps/desktop/src/renderer/styles.css packages/ui/src/shortcuts.ts packages/ui/src/i18n/en.ts apps/desktop/src/renderer/App.tsx apps/desktop/src/renderer/shell/Palette.tsx docs/guide/12-settings.md
git commit -m "feat(desktop): survey date bar with calendar, shortcuts and palette commands"
```

---

### Task 9: Dates in the viewers

**Files:**

- Create: `apps/desktop/src/renderer/workspace/DatesOnScreen.tsx`
- Create: `apps/desktop/src/renderer/workspace/datesOnScreen.test.ts`
- Modify: `apps/desktop/src/renderer/workspace/Stage.tsx` (render chip inside `.stage`, ~:754-862; split follows focus near :536-556)
- Modify: `apps/desktop/src/renderer/workspace/SplitPanes.tsx` (`SetPhotoPane` :299-354; `PaneChooser` date select :156-173)
- Modify: `apps/desktop/src/renderer/workspace/FloatingVideo.tsx` (`.vh` title bar :154-202)
- Modify: `packages/engine/src/adapters/panoramas.ts:454`
- Modify: `apps/desktop/src/renderer/styles.css`, `packages/ui/src/i18n/en.ts`

**Interfaces:**

- Consumes: `dateTags`, `layerDate`, `chooseCapture` (`splitModel.ts:87`), `useSplit()` (`SplitPanes.tsx:87`), `useTimeline`.
- Produces:
  - `datesOnScreen(index: CaptureIndex, hidden: Readonly<Record<string, true>>, layers: readonly Pick<Layer, 'id' | 'name' | 'kind'>[], kinds: readonly Layer['kind'][]): { capture: string; layers: string[] }[]` (sorted oldest first)
  - `DatesOnScreen(props: { kinds: readonly Layer['kind'][] }): JSX.Element | null`, test id `dates-on-screen`
  - `DateBadge(props: { layerId: string }): JSX.Element | null`, test id `date-badge`
  - `pickPhotoSet(sets: readonly PhotoLayer[], hidden: Readonly<Record<string, true>>, index: CaptureIndex | null, focus: string | null): PhotoLayer | undefined`

- [ ] **Step 1: Write the failing tests** (`datesOnScreen.test.ts`, node environment):

```ts
import { captureIndex } from '@aio/workspace';
import { describe, expect, it } from 'vitest';
import { threeDates } from './__fixtures__/threeDates';
import { datesOnScreen, pickPhotoSet } from './DatesOnScreen';

const index = captureIndex(threeDates);

describe('datesOnScreen', () => {
  it('lists each date with visible layers of the given kinds, oldest first', () => {
    const hidden = {
      'model-oct': true,
      'clip-sep': true,
      'clip-oct': true,
      'clip-nov': true,
    } as const;
    const out = datesOnScreen(index, hidden, threeDates.layers, ['mesh']);
    expect(out).toEqual([
      { capture: 'sep', layers: ['model-sep'] },
      { capture: 'nov', layers: ['model-nov'] },
    ]);
  });
  it('ignores Every date layers and other kinds', () => {
    expect(datesOnScreen(index, {}, threeDates.layers, ['raster'])).toEqual([]);
  });
});

describe('pickPhotoSet', () => {
  const set = (id: string, capture: string) =>
    ({ kind: 'photos', id, name: id, visible: true, capture, items: [{ id: `${id}-1` }] }) as never;
  const sets = [set('ph-sep', 'sep'), set('ph-nov', 'nov')];
  const m = { ...threeDates, layers: [...threeDates.layers, ...sets] };
  const ix = captureIndex(m);
  it('prefers the focused date', () => {
    expect(pickPhotoSet(sets, {}, ix, 'sep')?.id).toBe('ph-sep');
  });
  it('falls back to any visible set, then any set', () => {
    expect(pickPhotoSet(sets, { 'ph-sep': true }, ix, 'oct')?.id).toBe('ph-nov');
    expect(pickPhotoSet(sets, { 'ph-sep': true, 'ph-nov': true }, ix, 'oct')?.id).toBe('ph-sep');
  });
});
```

- [ ] **Step 2: Run to verify failure**: `pnpm vitest run apps/desktop/src/renderer/workspace/datesOnScreen.test.ts` → FAIL.

- [ ] **Step 3: Implement `DatesOnScreen.tsx`**

```tsx
import { useMemo } from 'react';
import type { Layer, PhotoLayer } from '@aio/schema';
import { useT } from '@aio/ui';
import { dateTags, useWorkspace, type CaptureIndex } from '@aio/workspace';
import { useTimeline } from './timeline';

type Hidden = Readonly<Record<string, true>>;

export function datesOnScreen(
  index: CaptureIndex,
  hidden: Hidden,
  layers: readonly Pick<Layer, 'id' | 'name' | 'kind'>[],
  kinds: readonly Layer['kind'][],
): { capture: string; layers: string[] }[] {
  const out: { capture: string; layers: string[] }[] = [];
  for (const c of index.captures) {
    const ids = (index.layers[c.id] ?? []).filter(
      (id) => !hidden[id] && kinds.includes(layers.find((l) => l.id === id)?.kind as Layer['kind']),
    );
    if (ids.length > 0) out.push({ capture: c.id, layers: ids });
  }
  return out;
}

export function pickPhotoSet(
  sets: readonly PhotoLayer[],
  hidden: Hidden,
  index: CaptureIndex | null,
  focus: string | null,
): PhotoLayer | undefined {
  const usable = sets.filter((s) => s.items.length > 0);
  return (
    usable.find((s) => !hidden[s.id] && index?.of[s.id] === focus) ??
    usable.find((s) => !hidden[s.id]) ??
    usable[0]
  );
}

/** Corner chip listing the survey dates currently on screen in a 3D view or map. */
export function DatesOnScreen(props: { kinds: readonly Layer['kind'][] }) {
  const t = useT();
  const index = useTimeline((s) => s.index);
  const hidden = useWorkspace((s) => s.hidden);
  const layers = useWorkspace((s) => s.project?.manifest.layers);
  const tags = useMemo(() => (index ? dateTags(index.captures) : {}), [index]);
  if (!index || !layers) return null;
  const on = datesOnScreen(index, hidden, layers, props.kinds);
  if (on.length < 2) return null;
  return (
    <div className="dates-on" data-testid="dates-on-screen" aria-label={t('stage.datesOn')}>
      {on.map((d) => (
        <span
          key={d.capture}
          className="dates-on-item"
          title={d.layers.map((id) => layers.find((l) => l.id === id)?.name ?? id).join(', ')}
        >
          <span
            className="dtag"
            style={{ background: tags[d.capture]?.colour }}
            aria-hidden="true"
          />
          {tags[d.capture]?.short}
        </span>
      ))}
    </div>
  );
}

/** Date tag for one layer (pane headers); nothing for Every date layers. */
export function DateBadge(props: { layerId: string }) {
  const index = useTimeline((s) => s.index);
  const tags = useMemo(() => (index ? dateTags(index.captures) : {}), [index]);
  const capture = index?.of[props.layerId];
  const tag = capture ? tags[capture] : undefined;
  if (!tag) return null;
  return (
    <span className="date-badge" data-testid="date-badge" title={tag.long}>
      <span className="dtag" style={{ background: tag.colour }} aria-hidden="true" />
      {tag.short}
    </span>
  );
}
```

i18n: `'stage.datesOn': 'Survey dates on screen'`.

Styles in `styles.css`:

```css
.dates-on {
  position: absolute;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 5;
  display: flex;
  gap: 10px;
  padding: 3px 10px;
  border-radius: 12px;
  background: color-mix(in oklch, var(--bg-1) 85%, transparent);
  border: 1px solid var(--line);
  font-size: var(--t-12);
  pointer-events: auto;
}
.dates-on-item,
.date-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}
.date-badge {
  font-size: var(--t-12);
  color: var(--fg-1);
}
```

- [ ] **Step 4: Run tests**: `pnpm vitest run apps/desktop/src/renderer/workspace/datesOnScreen.test.ts` → PASS.

- [ ] **Step 5: Wire into the viewers**

1. `Stage.tsx`: inside `<div className="stage">`, after `<div className="stage-panes">…</div>`, render `<DatesOnScreen kinds={['mesh', 'pointcloud', 'raster', 'vector', 'panoramas']} />`. With the compare split open the chip is redundant; render it only when `!splitting`.
2. `Stage.tsx`: the left split side follows the date bar. Next to the existing scope effect (:536-556), add:

```tsx
const focus = useTimeline((s) => s.focus);
useEffect(() => {
  if (!splitting || !focus) return;
  if (paneCapture(split, 'left') === focus) return;
  split.set(chooseCapture(split.sides, 'left', focus, split.dates));
}, [focus, splitting]); // eslint-disable-line react-hooks/exhaustive-deps -- follow focus changes only
```

Use whatever local names Stage already has for the split model and the "is split open" flag (read :505-560). Only run when the left pane kind is in `PER_CAPTURE`; `chooseCapture` already handles kinds without dates by leaving them alone, confirm in `splitModel.ts:87-110` and guard with `PER_CAPTURE.includes(split.sides.left)` if it does not. 3. `SplitPanes.tsx` `SetPhotoPane` (:299-310): replace `const set = picked ?? sets.find((s) => s.items.length > 0);` with:

```tsx
const hidden = useWorkspace((s) => s.hidden);
const index = useTimeline((s) => s.index);
const focus = useTimeline((s) => s.focus);
const set = picked ?? pickPhotoSet(sets, hidden, index, focus);
```

and render `<DateBadge layerId={set.id} />` as the first child inside `<div className="pane-bar">` (:322). 4. `SplitPanes.tsx` `PaneChooser` date `<select>` (:156-173): prefix each `<option>` text with nothing (native options cannot hold swatches), and render `<DateBadge layerId=…/>`-equivalent swatch before the select: `<span className="dtag" style={{ background: tags[current]?.colour }} aria-hidden="true" />` where `tags = dateTags(index.captures)` and `current` is the side's capture. 5. `FloatingVideo.tsx`: in the `.vh` title bar, right after `<b>{layer.name}</b>`, render `<DateBadge layerId={layer.id} />`. 6. `packages/engine/src/adapters/panoramas.ts:454`: change `hud?.set(p.id, coverageLabel(cov));` so the sub line carries the survey date:

```ts
const date = layer
  ? layerDate(store.getState().project?.manifest ?? { captures: [], layers: [] }, layer.id)
  : undefined;
hud?.set(p.id, date ? `${coverageLabel(cov)} · ${date}` : coverageLabel(cov));
```

with `import { layerDate } from '@aio/workspace';`. Use the variable that holds the current panorama layer in that scope (read `show(i)` at :443 to find it). The HUD shows the ISO date (`2024-11-06`): unambiguous and the engine has no date formatter; fine for T1.

- [ ] **Step 6: Typecheck and run the workspace renderer tests**

Run: `pnpm typecheck && pnpm vitest run apps/desktop/src/renderer/workspace packages/engine/src/adapters`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/workspace packages/engine/src/adapters/panoramas.ts apps/desktop/src/renderer/styles.css packages/ui/src/i18n/en.ts
git commit -m "feat(desktop): survey dates shown in every viewer, panes follow the focused date"
```

---

### Task 10: e2e on a three-date project

**Files:**

- Modify: `apps/desktop/e2e/fixtures.ts` (new `createThreeDateProject` beside `createTwoDateProject` :354; new fixture beside `twoDateProject` :637)
- Create: `apps/desktop/e2e/timeline.spec.ts`

**Interfaces:**

- Consumes: `tinyGlb()`, `IDENTITY`, `SCHEMA_VERSION`, `ProjectManifestInput`, `openProject(win)` from `fixtures.ts`.
- Produces: `createThreeDateProject(dataRoot: DataRoot): Promise<{ id: string }>`, fixture `threeDateProject`, project id `e2e-three-dates`.

Scope note: the fixture uses meshes and vectors only (no media files). Video/photo/panorama pane following is covered by the unit tests in Tasks 3 and 9; the e2e covers what only the real app proves: tree, date bar, calendar, keyboard, visibility in the store, persistence across reopen.

- [ ] **Step 1: Fixture**

```ts
export const THREE_DATE_PROJECT_ID = 'e2e-three-dates';

/** Three surveys (Sep, Oct, Nov 2024), a model and a site outline per date, one undated layer. */
export async function createThreeDateProject(dataRoot: DataRoot): Promise<{ id: string }> {
  const id = THREE_DATE_PROJECT_ID;
  const dir = join(dataRoot.root, 'projects', id);
  await mkdir(join(dir, 'models'), { recursive: true });
  await mkdir(join(dir, 'vectors'), { recursive: true });
  await writeFile(join(dir, 'models', 'quad.glb'), tinyGlb());
  const outline = JSON.stringify({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 'B',
        properties: { id: 'B', name: 'Boundary' },
        geometry: {
          type: 'LineString',
          coordinates: [
            [51.0, 28.92],
            [51.0005, 28.92],
          ],
        },
      },
    ],
  });
  const dates = [
    { id: 'sep', date: '2024-09-04' },
    { id: 'oct', date: '2024-10-02' },
    { id: 'nov', date: '2024-11-06' },
  ];
  for (const d of dates) await writeFile(join(dir, 'vectors', `site-${d.id}.geojson`), outline);
  await writeFile(join(dir, 'vectors', 'design.geojson'), outline);
  const input: ProjectManifestInput = {
    schema: SCHEMA_VERSION,
    id,
    name: 'E2E three dates',
    customer: 'E2E',
    site: 'Synthetic site, 3 dates',
    crs: { epsg: 32639 },
    origin: [500000, 3200000, 0],
    captures: dates.map((d) => ({ id: d.id, label: `Survey ${d.date}`, date: d.date })),
    layers: [
      ...dates.flatMap((d) => [
        {
          kind: 'mesh' as const,
          id: `quad-${d.id}`,
          name: `Quad ${d.date}`,
          capture: d.id,
          src: { path: 'models/quad.glb' },
          transform: IDENTITY,
        },
        {
          kind: 'vector' as const,
          id: `site-${d.id}`,
          name: `Site ${d.date}`,
          capture: d.id,
          src: { path: `vectors/site-${d.id}.geojson` },
        },
      ]),
      {
        kind: 'vector' as const,
        id: 'design',
        name: 'Design outline',
        src: { path: 'vectors/design.geojson' },
      },
    ],
  };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(input, null, 2));
  return { id };
}
```

Copy the exact `vector` layer fields from `createTwoDateProject` (format, etc.) if the schema requires more than `src`; tsc on `ProjectManifestInput` will say. Add `threeDateProject: { id: string }` to `Fixtures` and a fixture mirroring `twoDateProject` (:637) that calls `createThreeDateProject(dataRoot)`.

- [ ] **Step 2: Write the spec**

```ts
import { expect, openProject, test } from './fixtures';
import type { Page } from '@playwright/test';

async function open(win: Page, id: string) {
  await win.locator('.nav-item', { hasText: 'Projects' }).first().click();
  await win.getByTestId('project-card').filter({ hasText: 'E2E three dates' }).first().click();
  await expect.poll(async () => (await openProject(win)).id, { timeout: 30_000 }).toBe(id);
}

const hidden = (win: Page) =>
  win.evaluate(() =>
    Object.keys(
      (
        window as unknown as {
          __aio: { workspace: { getState(): { hidden: Record<string, true> } } };
        }
      ).__aio.workspace.getState().hidden,
    ).sort(),
  );

test.describe('survey date timeline', () => {
  test('opens on the latest date with other dates hidden', async ({ threeDateProject, win }) => {
    await open(win, threeDateProject.id);
    await expect(win.getByTestId('date-bar-open')).toContainText('6 Nov 2024');
    await expect(win.getByTestId('date-folder-nov')).toHaveAttribute('aria-expanded', 'true');
    await expect(win.getByTestId('date-folder-oct')).toHaveAttribute('aria-expanded', 'false');
    expect(await hidden(win)).toEqual(['quad-oct', 'quad-sep', 'site-oct', 'site-sep']);
  });

  test('calendar jump swaps dates and keeps an extra', async ({ threeDateProject, win }) => {
    await open(win, threeDateProject.id);
    // Turn on the September model by hand: expand Sep without focusing, use its eye.
    await win
      .getByTestId('date-folder-sep')
      .getByRole('button', { name: /Expand/ })
      .click();
    await win
      .getByTestId('date-folder-sep')
      .locator('.titem', { hasText: 'Quad' })
      .locator('.eye')
      .click();
    await win.getByTestId('date-bar-open').click();
    await win.getByTestId('cal-prev').click(); // November -> October (September has a survey too; October first)
    await win.getByTestId('cal-day-2024-10-02').click();
    await expect(win.getByTestId('date-bar-open')).toContainText('2 Oct 2024');
    await expect(win.getByTestId('date-folder-oct')).toHaveAttribute('aria-expanded', 'true');
    await expect(win.getByTestId('date-on-sep')).toHaveText('1 on');
    expect(await hidden(win)).toEqual(['quad-nov', 'site-nov', 'site-sep']);
  });

  test('Alt+Left and Alt+Right step dates', async ({ threeDateProject, win }) => {
    await open(win, threeDateProject.id);
    await win.locator('.stage').click({ position: { x: 20, y: 20 } });
    await win.keyboard.press('Alt+ArrowLeft');
    await expect(win.getByTestId('date-bar-open')).toContainText('2 Oct 2024');
    await win.keyboard.press('Alt+ArrowRight');
    await expect(win.getByTestId('date-bar-open')).toContainText('6 Nov 2024');
  });

  test('focus survives reopening the project', async ({ threeDateProject, win }) => {
    await open(win, threeDateProject.id);
    await win.getByTestId('date-name-sep').click();
    await expect(win.getByTestId('date-bar-open')).toContainText('4 Sep 2024');
    await win.reload();
    await open(win, threeDateProject.id);
    await expect(win.getByTestId('date-bar-open')).toContainText('4 Sep 2024');
  });
});
```

Before writing `hidden(win)`, find how existing specs read workspace state from the page (search `apps/desktop/e2e` for `getState()` or `__aio`/`__e2e`) and use that exact hook instead of the guessed `window.__aio`. If no hook exists, assert visibility through the tree instead: `.titem.hidden` rows (DatasetTree adds `hidden` to hidden rows) inside each date folder after expanding it. In the calendar step, the month arrows skip months with no survey; November → October is one `cal-prev` click because October has a survey.

- [ ] **Step 3: Build and run**

Run: `pnpm -F @aio/desktop exec electron-vite build`
Run: `pnpm -F @aio/desktop exec playwright test timeline --workers=1 --grep-invert @realdata`
Expected: 4 passed. Then run the date-related existing specs to confirm nothing regressed: `pnpm -F @aio/desktop exec playwright test compare change --workers=1 --grep-invert @realdata` → all pass. Note: the two-date fixture now opens focused on its latest date with the older date's layers hidden; if a compare/change spec asserted that both dates' layers start visible, update that assertion to the new rule (Global Constraints) and say so in the commit message.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/e2e/fixtures.ts apps/desktop/e2e/timeline.spec.ts
git commit -m "test(e2e): survey date timeline on a three-date project"
```

---

### Task 11: Docs

**Files:**

- Create: `docs/guide/28-survey-dates.md`
- Modify: `docs/guide/04-compare-dates.md` (link near the top)
- Modify: `docs/TESTING.md` (new section after M9, the last section ~:397)

- [ ] **Step 1: User guide chapter** `docs/guide/28-survey-dates.md`:

```markdown
# Survey dates

Projects that are flown again and again (weekly or monthly progress flights) keep every flight in
one project. Each flight is a survey date.

## The date folders

The Datasets list on the left shows one folder per survey date, newest first. Inside each folder
are the usual groups: models, maps, video, photos and panoramas. Layers that belong to no date,
such as a design drawing, sit in **Every date** at the top.

The highlighted folder is the date you are viewing. Click a date's name to view it. Click only the
arrow beside it to open the folder without switching, for example to pick one layer from another
date.

## Moving between dates

- The bar above the views shows the date you are viewing. Use the arrows, or press **Alt+Left** and
  **Alt+Right**.
- Click the date to open the calendar. Days with a survey are coloured; months without a survey are
  skipped.
- Ctrl+K and "Go to survey date" lists every date.

When you move to another date, that date's layers come on and the previous date's layers go off.
Anything you switched on by hand from a third date stays on, so you can keep, say, the 1 November
orthomosaic on screen while you step through later surveys. A closed folder shows how many of its
layers are on ("1 on").

## Which date am I looking at?

Each date has a colour. It appears on the folder, in the date bar, on the calendar, in the header
of video, photo and raster panes, and in a small chip at the top of the 3D view or map whenever
more than one date is on screen.

To put two dates side by side, use [Compare dates](04-compare-dates.md).
```

- [ ] **Step 2:** In `04-compare-dates.md`, add after the H1's first paragraph: `To step through all survey dates of a project, see [Survey dates](28-survey-dates.md).`

- [ ] **Step 3: TESTING.md section** after the last section, following the file's pattern:

```markdown
## Stage Timeline T1: survey dates

Survey dates become folders in the sidebar, with a date bar and calendar above the views.

### Before you start

- Open **E2E three dates**, or any project with at least two survey dates (Masafi has several).

### Date folders

- [ ] **Datasets** shows **Every date** first (if the project has undated layers), then one folder per date, newest first: the newest is highlighted and open, the others closed.
- [ ] Click an older date's **name**: it opens and highlights, the others close, and the views show that date's data.
- [ ] Click only the **arrow** of a third date: it opens without switching. Switch one of its layers on: the folder shows "1 on" when closed.
- [ ] Switch dates again: the layer from the third date stays on.
- [ ] Hide one layer of the viewed date, switch away and back: it is still hidden.

### Date bar and calendar

- [ ] The bar shows the viewed date, its colour and "n of N surveys". The arrows step through dates; they are absent on a one-date project.
- [ ] **Alt+Left** / **Alt+Right** step dates; typing in a comment box does not.
- [ ] Click the date: the calendar opens on that month, survey days are coloured, month arrows skip empty months, Escape closes it and returns focus to the bar.
- [ ] Ctrl+K, type "survey": previous, next and every date are listed.

### Viewers

- [ ] With two dates' models on, a chip at the top of the 3D view lists both dates in their colours.
- [ ] The floating video and the photo pane headers show the clip's or set's date.
- [ ] Playing a clip from the viewed date, switch dates: the matching clip of the new date plays.
- [ ] Open the compare split: the left side follows the date bar, the right side keeps its own date.
- [ ] Close and reopen the project: the same date is viewed, with the same layers on.
```

- [ ] **Step 4: Run the guide bundle test** (the help screen bundles `docs/guide/*.md`):

Run: `pnpm vitest run apps/desktop/src/renderer/help`
Expected: PASS.

- [ ] **Step 5: Final checks**

Run: `pnpm check`
Expected: lint, format, typecheck and unit tests all pass. Fix anything reported.

- [ ] **Step 6: Commit**

```bash
git add docs/guide/28-survey-dates.md docs/guide/04-compare-dates.md docs/TESTING.md
git commit -m "docs: survey dates guide chapter and T1 testing steps"
```

---

## Self-review notes

- Spec coverage: tree and Every date (Tasks 4-6), focus/visibility rules incl. remembered, extras, promotion, removed dates, persistence (1, 3), colour tags (2), date bar and keyboard and palette (8), calendar incl. multi-survey day and keyboard (7), viewers: 3D/map chip, video/photo/raster headers, panorama HUD, compare split left side follows focus (9), edge cases: no captures and one capture (3, 8), testing and docs (10, 11).
- Deviations from the spec, deliberate: extras are derived (visible layers of non-focused dates) instead of stored as a separate set, so every existing visibility caller stays correct; the panorama HUD shows the ISO date because the engine has no date formatter; the e2e fixture has no media files, so pane following is proven by unit tests.
- Large projects (50+ dates): the date tree only renders expanded folders' groups (Task 5 renders `DatasetTree` only when `expanded`), which meets the spec without extra work.
