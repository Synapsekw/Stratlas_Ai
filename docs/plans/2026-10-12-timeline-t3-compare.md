# Timeline T3, compare across dates: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Side-by-side panoramas of two survey dates with linked look, paired by position; "Compare with..." on a date folder or a layer in the tree; the split's pane picker grouped by date.

**Architecture:** A new per-date split pane kind `pano` joins `PER_CAPTURE`, so the existing date rules of the split (left follows the date bar, right keeps its own date) apply to it. Pure modules carry the logic (`panoPair`, `lookLink`, `compareWith`, `splitModel`), the pane is a thin React shell over a three.js view that reuses the engine's panorama shader. One entry point, `compareWith(request)`, serves both tree menus and later T4.

**Tech stack:** TypeScript strict, React, three.js, zustand (vanilla), vitest, Playwright with Electron.

**Spec:** `docs/plans/2026-10-12-timeline-t3-compare-design.md` (read its "Decisions taken" first).

## Global constraints

- Work only in `.claude/worktrees/timeline-t3-compare`, branch `feat/timeline-t3-compare`.
- No `@aio/schema` change, no IPC change, no manifest or file format change. The saved split (`stagePrefs.ts`, localStorage) gains `pano` as a kind and a `pano?: string` field: renderer state, no contract row.
- A split without a `pano` side, a project without panoramas, and a project with fewer than two dates behave exactly as before, except that the pane picker is one select grouped by date when the project has two dates (spec decision 8).
- User-facing text: plain words, sentence case, no emoji, no em or en dashes, every string in `packages/ui/src/i18n/en.ts`. No client, site, tester or person names anywhere (commit subjects included).
- A parallel branch, `feat/timeline-t2-add-survey-date`, changes the import, the Datasets header, `Sidebar.tsx` and the Ctrl+K palette. This plan does not touch the palette or the Datasets header; it changes two lines of `Sidebar.tsx` (Task 8) and appends keys to `en.ts` (Task 4). Rebase onto `main` before each batch; on a conflict in those two files keep both sides.
- Renderer code never imports `electron` or `node:*`.
- Heavy commands (`pnpm check`, demos, Playwright, commits) go through the shared one-at-a-time runner (`heavy.mjs`); Playwright with `--workers=1`, windows off-screen (the fixtures do it).
- Scratch files (subagent briefs, notes) live outside the worktree (`.superpowers/` inside it fails `pnpm format:check`).

## Review focus

1. **Panoramas with no position spread** (every `pos` at the origin, as some importers write when GPS is missing): every candidate is at 0 m. Expected: pairing still picks one (the first in list order) and says "0 m", it does not crash or flicker between ties. Pinned in Task 1 (`ties pick the first in list order`).
2. **A saved split from an older build or a hand-edited one** (`left: 'pano'` with no captures, `pano: 42`, an unknown kind): expected the parser drops the bad parts and the split falls back to its default. Pinned in Task 4 (`parseSplitPref` cases).
3. **Yaw across north** (dragging from 359 to 1 degree, offsets that push past 360): expected no jump of 358 degrees in the other pane. Pinned in Task 2 (`wraps through north`).
4. **"Compare with..." on a group header holding layers of several kinds** (a mixed group after a date move): expected the kind of the first layer that has one, not nothing and not a crash. Pinned in Task 5 (`mixed group takes its first comparable layer`).
5. **The date shown on the right is deleted or loses its panoramas while the split is open** (T2 can re-file layers): expected the "No panoramas on <date>" message with the picker still usable, not a blank pane. Pinned in Task 6 (`PanoPane` empty-date test) and Task 4 (`resolveSplit` keeps a capture that has no panoramas; the pane handles it).

---

## File map

| File                                                         | Task | Change                                                               |
| ------------------------------------------------------------ | ---- | -------------------------------------------------------------------- |
| `apps/desktop/src/renderer/workspace/panoPair.ts` (+test)    | 1    | new, pure                                                            |
| `apps/desktop/src/renderer/workspace/lookLink.ts` (+test)    | 2    | new, pure + vanilla store                                            |
| `packages/engine/src/adapters/panoSphere.ts` (+test)         | 3    | new, material extracted from `panoramas.ts`                          |
| `packages/engine/src/adapters/panoramas.ts`                  | 3    | uses `panoSphereMaterial`                                            |
| `packages/engine/src/index.ts`                               | 3    | exports                                                              |
| `apps/desktop/src/renderer/workspace/splitModel.ts` (+test)  | 4    | `pano` kind, `SplitPref.pano`, `paneValue`, `paneGroups`, `chooseAt` |
| `packages/ui/src/i18n/en.ts`                                 | 4    | every new key of this plan                                           |
| `apps/desktop/src/renderer/workspace/compareWith.ts` (+test) | 5    | new                                                                  |
| `apps/desktop/src/renderer/workspace/panoView.ts`            | 6    | new, three.js view                                                   |
| `apps/desktop/src/renderer/workspace/PanoPane.tsx` (+test)   | 6    | new                                                                  |
| `apps/desktop/src/renderer/workspace/SplitPanes.tsx`         | 7    | grouped `PaneChooser`, `pano` built-in pane                          |
| `apps/desktop/src/renderer/workspace/PaneChooser.test.tsx`   | 7    | new                                                                  |
| `apps/desktop/src/renderer/shell/DateMenus.tsx` (+test)      | 8    | "Compare with..." in both menus                                      |
| `apps/desktop/src/renderer/shell/Sidebar.tsx`                | 8    | layer menu also on read-only projects (two lines)                    |
| `apps/desktop/e2e/panoFixtures.ts`                           | 9    | new, synthetic `e2e-pano-dates` project                              |
| `apps/desktop/e2e/pano-compare.spec.ts`                      | 9    | new                                                                  |
| `apps/desktop/e2e/compare.spec.ts`, `change-raster.spec.ts`  | 9    | pick panes through the grouped select                                |
| `docs/guide/04-compare-dates.md`, `docs/TESTING.md`          | 10   | panoramas, "Compare with...", founder steps                          |

## Execution DAG

```
T1 panoPair ───────────────┐
T2 lookLink ───────────────┼─> T6 panoView + PanoPane ─> T7 SplitPanes ─┬─> T9 e2e
T3 engine panoSphere ──────┤                                            │
T4 splitModel + words ─────┼─> T5 compareWith ─────────> T8 DateMenus ──┴─> T10 docs
                           └──────────────────────────────────────────────(T4 feeds T6, T7)
```

| Batch | Tasks (dispatch together, one message) | Needs              | Packages touched                                                                 |
| ----- | -------------------------------------- | ------------------ | -------------------------------------------------------------------------------- |
| A     | T1, T2, T3, T4                         | nothing            | desktop renderer (separate new files), `@aio/engine`, `@aio/ui` (en.ts only, T4) |
| B     | T5, T6                                 | A                  | desktop renderer (separate new files)                                            |
| C     | T7, T8                                 | T7: T4, T6; T8: T5 | desktop renderer (`SplitPanes.tsx`; `DateMenus.tsx`, `Sidebar.tsx`)              |
| D     | T9, T10                                | C                  | `apps/desktop/e2e`; `docs`                                                       |

No two tasks of a batch share a file. **Critical path:** T4, T6, T7, T9. Ten tasks; sizes: S = T1, T2, T3, T10; M = T4, T5, T8; L = T6, T7, T9.

The heavy runner is shared with other sessions: subagents in a batch write and unit-test in parallel (`pnpm --filter <pkg> exec vitest run <file>` is light), and each commits through the runner. `pnpm check` runs once per batch, after its last commit.

## Tests and e2e at a glance

| Task | Unit tests                                                     | e2e                                                                            |
| ---- | -------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 1    | `panoPair.test.ts`                                             |                                                                                |
| 2    | `lookLink.test.ts`                                             |                                                                                |
| 3    | `panoSphere.test.ts`, existing `panoramas.test.ts` stays green |                                                                                |
| 4    | `splitModel.test.ts` (new cases)                               |                                                                                |
| 5    | `compareWith.test.ts`                                          |                                                                                |
| 6    | `PanoPane.test.tsx` (view mocked)                              |                                                                                |
| 7    | `PaneChooser.test.tsx`                                         |                                                                                |
| 8    | `DateMenus.test.tsx` (new cases)                               |                                                                                |
| 9    |                                                                | new `pano-compare.spec.ts`; changed `compare.spec.ts`, `change-raster.spec.ts` |
| 10   | `pnpm format:check`, `check-public-text.mjs`                   |                                                                                |

---

## Tasks

### Task 1: Pairing panoramas by position

**Files:**

- Create: `apps/desktop/src/renderer/workspace/panoPair.ts`
- Test: `apps/desktop/src/renderer/workspace/panoPair.test.ts`

**Interfaces:**

- Consumes: `Layer`, `PanoRef`, `Vec3` from `@aio/schema`; `CaptureIndex` from `@aio/workspace`.
- Produces (used by Tasks 5, 6):

```ts
export interface PanoAt {
  layer: string;
  pano: PanoRef;
}
export const PAIR_MAX_M = 25;
export const panoKey: (a: PanoAt) => string; // `${layer}/${pano.id}`
export function panosOf(
  layers: readonly Layer[],
  index: CaptureIndex | null,
  capture: string | undefined,
): PanoAt[];
export function findPano(list: readonly PanoAt[], key: string | undefined): PanoAt | undefined;
export function groundDistance(a: Vec3, b: Vec3): number;
export interface PanoPair {
  at: PanoAt;
  distanceM: number;
  within: boolean;
}
export function pairPano(
  from: PanoRef,
  candidates: readonly PanoAt[],
  maxM?: number,
): PanoPair | null;
export function stepPano(
  list: readonly PanoAt[],
  key: string | undefined,
  dir: 1 | -1,
): PanoAt | undefined;
export function followPano(prev: PanoRef | undefined, next: readonly PanoAt[]): PanoAt | undefined;
```

- [ ] **Step 1: Write the failing tests**

```ts
import type { Layer } from '@aio/schema';
import type { CaptureIndex } from '@aio/workspace';
import { describe, expect, it } from 'vitest';
import {
  findPano,
  followPano,
  groundDistance,
  pairPano,
  panoKey,
  panosOf,
  stepPano,
} from './panoPair';

const pano = (id: string, x: number, z: number, y = 0) => ({
  id,
  src: { path: `p/${id}.jpg` },
  pos: [x, y, z] as [number, number, number],
  headingDeg: 0,
});
const layer = (id: string, items: ReturnType<typeof pano>[]) =>
  ({ kind: 'panoramas', id, name: id, items }) as unknown as Layer;
const layers = [
  layer('p-oct', [pano('a', 0, 0), pano('b', 10, 0), pano('c', 20, 0)]),
  layer('p-nov', [pano('d', 2, 0), pano('e', 11, 1), pano('f', 60, 0)]),
  layer('p-any', [pano('g', 100, 100)]),
];
const index = {
  captures: [{ id: 'oct' }, { id: 'nov' }],
  layers: { oct: ['p-oct'], nov: ['p-nov'] },
  of: { 'p-oct': 'oct', 'p-nov': 'nov' },
  epochs: {},
  slot: {},
} as unknown as CaptureIndex;

describe('panosOf', () => {
  it("lists the date's panoramas and the undated ones, in manifest order", () => {
    expect(panosOf(layers, index, 'nov').map(panoKey)).toEqual([
      'p-nov/d',
      'p-nov/e',
      'p-nov/f',
      'p-any/g',
    ]);
  });
  it('lists every panorama without a date or an index', () => {
    expect(panosOf(layers, null, undefined)).toHaveLength(7);
  });
});

describe('pairPano', () => {
  const nov = panosOf(layers, index, 'nov');
  it('picks the nearest on the ground, ignoring height', () => {
    const p = pairPano(pano('b', 10, 0, 30), nov);
    expect(p && panoKey(p.at)).toBe('p-nov/e');
    expect(p?.distanceM).toBeCloseTo(Math.hypot(1, 1));
    expect(p?.within).toBe(true);
  });
  it('marks a pair beyond the limit as not within', () => {
    const p = pairPano(pano('x', 40, 40), panosOf(layers, index, 'nov').slice(0, 3));
    expect(p?.within).toBe(false);
  });
  it('ties pick the first in list order', () => {
    const flat = [
      { layer: 'L', pano: pano('m', 0, 0) },
      { layer: 'L', pano: pano('n', 0, 0) },
    ];
    expect(pairPano(pano('a', 0, 0), flat)?.at.pano.id).toBe('m');
  });
  it('is null with no candidates', () => {
    expect(pairPano(pano('a', 0, 0), [])).toBeNull();
  });
});

describe('stepPano and findPano', () => {
  const oct = panosOf(layers, index, 'oct');
  it('wraps both ways', () => {
    expect(stepPano(oct, 'p-oct/a', -1) && panoKey(stepPano(oct, 'p-oct/a', -1)!)).toBe('p-any/g');
    expect(panoKey(stepPano(oct, 'p-any/g', 1)!)).toBe('p-oct/a');
  });
  it('starts at the first for an unknown key', () => {
    expect(panoKey(stepPano(oct, 'nope', 1)!)).toBe('p-oct/a');
    expect(findPano(oct, 'nope')).toBeUndefined();
  });
});

describe('followPano', () => {
  it('keeps the spot on a date change, whatever the distance', () => {
    expect(followPano(pano('c', 20, 0), panosOf(layers, index, 'nov'))?.pano.id).toBe('e');
  });
  it('takes the first without a previous panorama', () => {
    expect(followPano(undefined, panosOf(layers, index, 'nov'))?.pano.id).toBe('d');
  });
  it('measures metres in x and z', () => {
    expect(groundDistance([0, 5, 0], [3, -9, 4])).toBe(5);
  });
});
```

(The non-null assertions are test-only; if the lint rule rejects them in tests, use `?.` and compare to `undefined`-safe values.)

- [ ] **Step 2: Run, expect FAIL:** `pnpm --filter @aio/desktop exec vitest run src/renderer/workspace/panoPair.test.ts` (module not found).
- [ ] **Step 3: Implement**

```ts
import type { Layer, PanoRef, Vec3 } from '@aio/schema';
import type { CaptureIndex } from '@aio/workspace';

/**
 * Panoramas of two survey dates side by side (timeline T3): the panoramas of a date, the one of
 * another date nearest on the ground, stepping on the leading side. Pure; the pane is PanoPane.tsx.
 */
export interface PanoAt {
  layer: string;
  pano: PanoRef;
}
/** Farthest two panoramas may stand apart and still count as the same spot, metres. */
export const PAIR_MAX_M = 25;
export const panoKey = (a: PanoAt): string => `${a.layer}/${a.pano.id}`;

export function panosOf(
  layers: readonly Layer[],
  index: CaptureIndex | null,
  capture: string | undefined,
): PanoAt[] {
  const out: PanoAt[] = [];
  for (const l of layers) {
    if (l.kind !== 'panoramas') continue;
    const of = index?.of[l.id];
    if (capture !== undefined && of !== undefined && of !== capture) continue;
    for (const pano of l.items) out.push({ layer: l.id, pano });
  }
  return out;
}

export function findPano(list: readonly PanoAt[], key: string | undefined): PanoAt | undefined {
  return key === undefined ? undefined : list.find((a) => panoKey(a) === key);
}

export function groundDistance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[2] - b[2]);
}

export interface PanoPair {
  at: PanoAt;
  distanceM: number;
  within: boolean;
}

export function pairPano(
  from: PanoRef,
  candidates: readonly PanoAt[],
  maxM = PAIR_MAX_M,
): PanoPair | null {
  let best: PanoPair | null = null;
  for (const at of candidates) {
    const d = groundDistance(from.pos, at.pano.pos);
    if (!best || d < best.distanceM) best = { at, distanceM: d, within: d <= maxM };
  }
  return best;
}

export function stepPano(
  list: readonly PanoAt[],
  key: string | undefined,
  dir: 1 | -1,
): PanoAt | undefined {
  const n = list.length;
  if (n === 0) return undefined;
  const i = list.findIndex((a) => panoKey(a) === key);
  if (i < 0) return list[0];
  return list[(((i + dir) % n) + n) % n];
}

export function followPano(prev: PanoRef | undefined, next: readonly PanoAt[]): PanoAt | undefined {
  if (!prev) return next[0];
  return pairPano(prev, next, Infinity)?.at;
}
```

- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(stage): pair panoramas of two dates by position` (through the runner).

### Task 2: Linked look, reusable by walks

**Files:**

- Create: `apps/desktop/src/renderer/workspace/lookLink.ts`
- Test: `apps/desktop/src/renderer/workspace/lookLink.test.ts`

**Interfaces:**

- Consumes: `PanoLook`, `PANO_FOV` from `@aio/engine`.
- Produces (used by Task 6; later by walks W5):

```ts
export function toShared(local: PanoLook, offsetDeg: number): PanoLook; // yaw + offset, wrapped
export function fromShared(shared: PanoLook, offsetDeg: number): PanoLook; // yaw - offset, wrapped
export interface LookLinkState {
  look: PanoLook;
  set(look: PanoLook): void;
}
export function createLookLink(initial: PanoLook): StoreApi<LookLinkState>;
export const panoLookLink: StoreApi<LookLinkState>; // the split's two Panoramas panes
```

- [ ] **Step 1: Failing tests**

```ts
import { PANO_FOV } from '@aio/engine';
import { describe, expect, it } from 'vitest';
import { createLookLink, fromShared, toShared } from './lookLink';

const look = (yawDeg: number, pitchDeg = 0, fovDeg = 70) => ({ yawDeg, pitchDeg, fovDeg });

describe('lookLink', () => {
  it('passes yaw, pitch and zoom through with offset 0', () => {
    expect(fromShared(toShared(look(123, -10, 50), 0), 0)).toEqual(look(123, -10, 50));
  });
  it('applies a member offset both ways', () => {
    expect(toShared(look(10), 30).yawDeg).toBe(40);
    expect(fromShared(look(40), 30).yawDeg).toBe(10);
  });
  it('wraps through north', () => {
    expect(toShared(look(359), 2).yawDeg).toBe(1);
    expect(fromShared(look(1), 2).yawDeg).toBe(359);
  });
  it('clamps pitch and zoom on set', () => {
    const s = createLookLink(look(0));
    s.getState().set(look(0, 120, 500));
    expect(s.getState().look.pitchDeg).toBe(89);
    expect(s.getState().look.fovDeg).toBe(PANO_FOV.max);
  });
  it('notifies subscribers once per set', () => {
    const s = createLookLink(look(0));
    let n = 0;
    s.subscribe(() => {
      n++;
    });
    s.getState().set(look(5));
    expect(n).toBe(1);
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement**

```ts
import { PANO_FOV, type PanoLook } from '@aio/engine';
import { createStore, type StoreApi } from 'zustand/vanilla';

/**
 * One look shared by two look-around views (two panoramas of two dates; later two 360 walks).
 * The shared look is a compass bearing; each member turns it by its own yaw offset (0 for
 * panoramas, which carry their heading; a walk's alignment for W5). Linking is the caller's
 * choice: an unlinked view keeps its own look and never writes here.
 */
const wrap = (a: number) => ((a % 360) + 360) % 360;
const clamp = (l: PanoLook): PanoLook => ({
  yawDeg: wrap(l.yawDeg),
  pitchDeg: Math.max(-89, Math.min(89, l.pitchDeg)),
  fovDeg: Math.max(PANO_FOV.min, Math.min(PANO_FOV.max, l.fovDeg)),
});
export const toShared = (local: PanoLook, offsetDeg: number): PanoLook =>
  clamp({ ...local, yawDeg: local.yawDeg + offsetDeg });
export const fromShared = (shared: PanoLook, offsetDeg: number): PanoLook =>
  clamp({ ...shared, yawDeg: shared.yawDeg - offsetDeg });

export interface LookLinkState {
  look: PanoLook;
  set(look: PanoLook): void;
}
export function createLookLink(initial: PanoLook): StoreApi<LookLinkState> {
  return createStore<LookLinkState>()((set) => ({
    look: clamp(initial),
    set: (look) => {
      set({ look: clamp(look) });
    },
  }));
}
export const panoLookLink = createLookLink({ yawDeg: 0, pitchDeg: 0, fovDeg: PANO_FOV.start });
```

- [ ] **Step 4: Run, expect PASS.** **Step 5: Commit** `feat(stage): a shared look for two look-around views`.

### Task 3: The panorama sphere material, exported from the engine

**Files:**

- Create: `packages/engine/src/adapters/panoSphere.ts`, `packages/engine/src/adapters/panoSphere.test.ts`
- Modify: `packages/engine/src/adapters/panoramas.ts` (the `VERTEX`, `FRAGMENT` constants and the `ShaderMaterial` built from them move out), `packages/engine/src/index.ts`

**Interfaces:**

- Produces (used by Task 6):

```ts
export const PANO_SPHERE_R = 50;
export interface PanoSphereMaterial {
  material: ShaderMaterial;
  setImage(tex: Texture | null): void;
  setFrame(headingDeg: number, cov: PanoCoverage): void;
  dispose(): void;
}
export function panoSphereMaterial(backdrop: Color): PanoSphereMaterial;
```

- [ ] **Step 1: Failing test** (`panoSphere.test.ts`): `panoSphereMaterial(new Color(0x101418))` has `side === BackSide`; `setFrame(90, { hspanDeg: 210, vtopDeg: 40, vbotDeg: 49 })` sets uniforms `heading 90`, `hspan 210`, `vtop 40`, `vbot 49`; `setImage(null)` sets `hasMap 0`, `setImage(new Texture())` sets `hasMap 1`; `dispose()` calls `material.dispose` (spy).
- [ ] **Step 2: Run, expect FAIL:** `pnpm --filter @aio/engine exec vitest run src/adapters/panoSphere.test.ts`.
- [ ] **Step 3: Implement.** Move `VERTEX` and `FRAGMENT` verbatim from `panoramas.ts` into `panoSphere.ts`; build the same `ShaderMaterial` (same uniforms: `map`, `hasMap`, `heading`, `hspan`, `vtop`, `vbot`, `backdrop`; `side: BackSide`, `depthTest`/`depthWrite` as today). In `panoramas.ts` replace the inline construction with `panoSphereMaterial(...)` and the per-panorama uniform writes with `setFrame` and `setImage`; `SPHERE_R` becomes the imported `PANO_SPHERE_R`. No behaviour change. Export `panoSphereMaterial`, `PANO_SPHERE_R`, `type PanoSphereMaterial` from `index.ts`.
- [ ] **Step 4: Run** the new test and `src/adapters/panoramas.test.ts`, both PASS; `pnpm --filter @aio/engine exec tsc --noEmit`.
- [ ] **Step 5: Commit** `refactor(engine): export the panorama sphere material`.

### Task 4: Split model: the Panoramas pane, the grouped picker, the words

**Files:**

- Modify: `apps/desktop/src/renderer/workspace/splitModel.ts`, `apps/desktop/src/renderer/workspace/splitModel.test.ts`, `packages/ui/src/i18n/en.ts`

**Interfaces:**

- Produces (used by Tasks 5, 6, 7):

```ts
export type PaneKind =
  '3d' | 'map' | 'video' | 'photo' | 'raster' | 'report' | 'frames' | 'walk360' | 'pano';
export interface SplitPref {
  /* as today */ pano?: string; /* `${layerId}/${panoId}`, the left panorama */
}
export const PER_CAPTURE: readonly PaneKind[]; // ['3d', 'map', 'raster', 'pano']
export function paneOptions(layers, reports, dates?, extra?): PaneKind[]; // + 'pano' when a panoramas layer exists
export function paneValue(kind: PaneKind, capture: string | null): string; // 'video' | 'pano@nov'
export function parsePaneValue(v: string): { kind: PaneKind; capture: string | null } | null;
export interface PaneOption {
  value: string;
  kind: PaneKind;
  capture: string | null;
  disabled: boolean;
}
export interface PaneGroup {
  capture: string | null;
  options: PaneOption[];
} // capture null: "Any date"
export function paneGroups(
  pref: SplitPref,
  side: Side,
  options: readonly PaneKind[],
  dates: SplitDates | undefined,
  has: (kind: PaneKind, capture: string) => boolean,
): PaneGroup[];
export function chooseAt(
  pref: SplitPref,
  side: Side,
  kind: PaneKind,
  capture: string | null,
  dates?: SplitDates,
): SplitPref;
```

- [ ] **Step 1: Failing tests** (append to `splitModel.test.ts`):
  - `paneOptions` with a panoramas layer includes `'pano'`; without, it does not.
  - `twinAllowed('pano', { captures: ['a','b'] })` is true; with one capture false.
  - `resolveSplit({ left: 'pano', right: 'pano' }, options, dates)` gives the first date left and the last right (same rule as raster).
  - `parseSplitPref({ left: 'pano', right: 'pano', leftCapture: 'a', rightCapture: 'b', pano: 'L/p1' })` round-trips; `pano: 42` is dropped; `left: 'pano', right: 'pano'` without captures returns null; `left: 'zzz'` returns null.
  - `paneValue('pano','nov') === 'pano@nov'`, `parsePaneValue('pano@nov')` gives `{ kind: 'pano', capture: 'nov' }`, `parsePaneValue('video')` gives capture null, `parsePaneValue('nope@x')` is null.
  - `paneGroups` with dates `['sep','oct','nov']`, options `['3d','map','video','raster','pano']`, `has` true for raster only on `nov` and pano on `oct` and `nov`: groups in order `nov`, `oct`, `sep`, then the null group; `nov` lists 3D, Map, Ortho, Panoramas; `sep` lists 3D, Map; the null group lists Video. With the other side on `pano@oct` the option `pano@oct` on this side is disabled and `pano@nov` is not. With the other side on `video`, this side's `video` is disabled. Without dates (fewer than two): one null group with every option, as today.
  - `chooseAt(pref, 'right', 'pano', 'oct', dates)` sets `right: 'pano'` and `rightCapture: 'oct'`; picking the other side's exact date swaps dates (as `chooseCapture` does).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
  - Add `'pano'` to `PaneKind`, `PANE_KINDS` (after `'raster'`), `PER_CAPTURE`, and `paneOptions` (`case 'pano': return has('panoramas');`).
  - `SplitPref.pano?: string`, parsed like `raster`.
  - `paneValue`/`parsePaneValue` split on the last `@`; the kind must be in `PANE_KINDS`; a capture only for `PER_CAPTURE` kinds.
  - `paneGroups`: when `!dates || dates.captures.length < 2`, return `[{ capture: null, options: options.map(...) }]` with `disabled: k === blockedFor(pref, side, dates)`. Otherwise one group per capture, newest first (`[...dates.captures].reverse()`), holding the `PER_CAPTURE` kinds in `options` for which `kind === '3d' || kind === 'map' || has(kind, capture)`, then the null group with the other kinds. A dated option is disabled when the other side shows the same kind on the same capture, or when it is the other side's kind and `!twinAllowed(kind, dates)`; an undated one as `blockedFor`.
  - `chooseAt`: `const next = chooseSide(pref, side, kind, dates); return capture ? chooseCapture(next, side, capture, dates) : next;`.
  - Words in `en.ts` (append in one block, alphabetical within it):

```ts
  'stage.pane.pano': 'Panoramas',
  'stage.pane.anyDate': 'Any date',
  'stage.pane.pick': '{side} shows',
  'pano.compare.prev': 'Previous panorama',
  'pano.compare.next': 'Next panorama',
  'pano.compare.count': '{n} of {total}',
  'pano.compare.away': '{m} m away',
  'pano.compare.heading': 'HDG {deg}°',
  'pano.compare.noneOnDate': 'No panoramas on {date}. Pick another date above.',
  'pano.compare.noMatch': 'No panorama of {date} within {m} m',
  'pano.compare.showNearest': 'Show the nearest ({m} m)',
  'pano.compare.missing': "This panorama's image is missing",
  'pano.compare.noGraphics': 'Panoramas need graphics acceleration, which is not available.',
  'pano.compare.label': 'Panorama {id}, {date}',
  'tree.dates.menu.compare': 'Compare with...',
  'tree.dates.menu.compareTitle': 'Compare {date} with',
  'tree.dates.menu.back': 'Back',
  'tree.dates.move.compare': 'Compare with another date...',
  'tree.dates.move.fileUnder': 'File under',
  'compare.with.noPanoramas': 'No panoramas',
  'compare.with.noRaster': 'No ortho',
  'compare.with.noMedia': 'No video or photos',
  'compare.with.nothing': 'Nothing to compare on this date',
```

Check `'stage.split.left'` / `'stage.split.right'` stay (the grouped select keeps them as its accessible names); `'stage.pane.pick'` is only used if the chooser needs a combined label.

- [ ] **Step 4: Run, expect PASS**; `pnpm --filter @aio/ui exec vitest run` (the catalogue tests).
- [ ] **Step 5: Commit** `feat(stage): a Panoramas pane per date and a picker grouped by date`.

### Task 5: "Compare with": one entry point

**Files:**

- Create: `apps/desktop/src/renderer/workspace/compareWith.ts`, `apps/desktop/src/renderer/workspace/compareWith.test.ts`

**Interfaces:**

- Consumes: Task 4 (`SplitPref.pano`, `PER_CAPTURE` with `pano`, `compareSplit`, `chooseAt`); Task 1 (`panosOf`, `panoKey`); `framesState`, `splitWithFrames`, `FramesSource` from `framesModel.ts`; `StageMode` from `../store`; `GpuTier` from `../graphics`.
- Produces (used by Task 8, and by T4 later):

```ts
export interface CompareRequest {
  from: string;
  to: string;
  layers?: readonly string[];
} // a layer or a group's layers
export interface CompareContext {
  layers: readonly Layer[];
  index: CaptureIndex;
  stageMode: StageMode;
  split: SplitPref;
  tier: GpuTier;
}
export type CompareKind = PaneKind | 'frames';
export function compareKindFor(layer: Layer): CompareKind | null;
export interface ComparePlan {
  split: SplitPref;
  frames?: { source: FramesSource; other: string };
  notice?: 'lowTierMaps';
}
export function planCompare(req: CompareRequest, ctx: CompareContext): ComparePlan | null;
export interface CompareTarget {
  capture: string;
  reason: MessageKey | null;
} // reason set: disabled
export function compareTargets(
  from: string,
  layers: readonly string[] | undefined,
  ctx: CompareContext,
): CompareTarget[]; // newest first, without `from`
export function compareWith(req: CompareRequest): boolean; // reads the stores, applies the plan, opens the split
export const COMPARE_WITH_ACTIONS: ((p: {
  request: CompareRequest;
  close: () => void;
}) => ReactNode)[];
```

- [ ] **Step 1: Failing tests** (`compareWith.test.ts`, a fixture manifest with dates `sep`, `oct`, `nov`: a mesh, an ortho raster and a panoramas layer on `oct` and `nov`, a video on `nov`, photos on `oct`, a vector on every date):
  - `compareKindFor`: mesh/pointcloud/tiles to `'3d'`, raster to `'raster'`, panoramas to `'pano'`, vector to `'map'`, video and photos to `'frames'`, legacy and annotation-like kinds to null.
  - Date folder, stage `3d`: `planCompare({ from: 'nov', to: 'oct' })` gives `left: '3d', right: '3d', leftCapture: 'nov', rightCapture: 'oct'`. Stage `map` gives two maps. Stage `split` with left `raster` gives two rasters. Tier `low` from `3d` gives two maps and `notice: 'lowTierMaps'`.
  - Panoramas layer on `nov` to `oct`: two `pano` sides, captures `nov`/`oct`, `pano` set to the first panorama of the `nov` layer (or the saved one when it is in that layer).
  - Raster on `nov` to `oct`: two `raster` sides and `raster` = the layer id.
  - Video on `nov` to `oct`: `frames` = `{ source: { kind: 'video', layer }, other: 'oct' }` and the split from `splitWithFrames`.
  - Mixed group (a vector and a raster): takes its first comparable layer (vector first in the list: two maps).
  - `from === to` and an unknown date give null.
  - `compareTargets('nov', ['pano-nov'], ctx)` lists `oct` enabled and `sep` with reason `'compare.with.noPanoramas'`; a date folder (no layers) lists every other date enabled; order newest first.
  - `COMPARE_WITH_ACTIONS` is an empty array that a test can push a component into (no rendering here; Task 8 tests the row).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** `planCompare` picks the kind (layers: first with `compareKindFor` not null; none: the stage rule from `CompareButton` in `CompareControls.tsx`: map from the map, the left kind from a per-date split, else 3D; Low tier and 3D: maps with the notice). For dated kinds it builds `{ ...compareSplit(ctx.split, kind, { captures: [from, to] }), leftCapture: from, rightCapture: to }` plus `raster` or `pano`. For `frames`: video source `{ kind: 'video', layer }`, photos source the first photo with `pos` and `q` (as `pickSource` does), `split: splitWithFrames(ctx.split)`. `compareTargets` disables a date when the layers' kind needs a layer of that kind on the target date (`index.layers[to]` has none of that kind, undated layers of that kind count as present) with the matching reason; 3D and map never disable. `compareWith` reads `workspace`, `useCaptureIndex`'s index (use `captureIndex(manifest)` directly, as `FramesPane` does), `shell.getState().stageMode`, the saved split (`stagePrefs`), `useGraphics.getState().tier`; then `stagePrefs.getState().update(projectId, { split })`, `framesState` setters when `frames`, `compareNotice` when `notice`, `shell.getState().setStageMode('split')`. Returns false when the plan is null.
- [ ] **Step 4: Run, expect PASS.** **Step 5: Commit** `feat(stage): one entry point to compare a date or a layer with another date`.

### Task 6: The Panoramas pane

**Files:**

- Create: `apps/desktop/src/renderer/workspace/panoView.ts`, `apps/desktop/src/renderer/workspace/PanoPane.tsx`, `apps/desktop/src/renderer/workspace/PanoPane.test.tsx`

**Interfaces:**

- Consumes: Task 1 (`panosOf`, `findPano`, `pairPano`, `stepPano`, `followPano`, `panoKey`, `PAIR_MAX_M`), Task 2 (`panoLookLink`, `fromShared`, `toShared`), Task 3 (`panoSphereMaterial`, `PANO_SPHERE_R`), Task 4 (`SplitPref.pano`, words); `dragLook`, `zoomLook`, `startLook`, `parsePanoIndex`, `coverageFromImage`, `azElToDir` from `@aio/engine`; `DateBadge` from `DatesOnScreen.tsx`; `useCaptureIndex` from `compare.ts`. `PanoPane.tsx` does not import `SplitPanes.tsx` (Task 7 imports it, so the reverse would be a cycle): it gets its side's dates, the saved split and the link state as props.
- Produces (used by Task 7):

```ts
// panoView.ts
export interface PanoImageView {
  setImage(url: string | null, headingDeg: number, cov: PanoCoverage | null): void;
  setLook(look: PanoLook): void;
  dispose(): void;
  readonly status: 'loading' | 'ready' | 'missing';
}
export function createPanoImageView(
  host: HTMLElement,
  look: PanoLook,
  onStatus: (s: 'loading' | 'ready' | 'missing') => void,
): PanoImageView; // throws without WebGL
// PanoPane.tsx
export function PanoPane(p: {
  side: Side;
  capture: string | undefined;
  otherCapture: string | undefined;
  sides: SplitPref;
  linked: boolean;
  onPick(key: string): void;
}): JSX.Element;
```

- [ ] **Step 1: Failing tests** (`PanoPane.test.tsx`, `vi.mock('./panoView')` with a fake view that records `setImage` and `setLook` calls; a workspace store seeded with the fixture of Task 1 and a project id):
  - left side on `oct` with `sides.pano = 'p-oct/b'` shows "b", "2 of 4", and calls `setImage` with b's url and heading;
  - next and previous buttons call `onPick('p-oct/c')` and `onPick('p-oct/a')`; Page Down does the same as next;
  - right side on `nov` with the left on `p-oct/b` shows "e" and "1.4 m away" and no stepper;
  - right side whose nearest is 52 m shows "No panorama of 6 Nov within 25 m" and the button "Show the nearest (52 m)", which then shows it;
  - a side whose date has no panoramas shows "No panoramas on 4 Sep. Pick another date above.";
  - linked: a drag on the left calls `panoLookLink.set`, and the right's fake view receives the same yaw; unlinked: the right does not move;
  - `data-yaw`, `data-pano`, `data-capture`, `data-distance` attributes are set;
  - selecting `{ kind: 'pano', id: 'e', layer: 'p-nov' }` while the left shows `oct` calls `onPick('p-nov/e')` with the capture change (the parent applies it).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
  - `panoView.ts`: a `WebGLRenderer` (antialias, pixel ratio capped at 2) filling `host`, a `Scene` with one `SphereGeometry(PANO_SPHERE_R, 64, 32)` mesh using `panoSphereMaterial(new Color(...))` (backdrop from the CSS variable `--bg-1`, read once), a `PerspectiveCamera` at the origin; `setLook` points it with `azElToDir`; draws on demand with `requestAnimationFrame` (as `createPanoVideoView`); `ResizeObserver`; `TextureLoader` with `SRGBColorSpace` and `LinearFilter`, `onStatus('missing')` on error; when `cov` is null, use `coverageFromImage(img.width, img.height)`; `dispose` frees texture, geometry, material, renderer and calls `forceContextLoss`.
  - `PanoPane.tsx`: reads layers and project from `useWorkspace`, the capture index from `useCaptureIndex()`, coverage once per project from `assetUrl(projectId, { path: 'panoramas/panoramas.json' })` with `parsePanoIndex` (missing file: empty map). Left (`side === 'left'`): its list is `panosOf(layers, index, capture)`, its panorama `findPano(list, sides.pano) ?? list[0]`. Right: pairs to the left panorama (computed the same way from `otherCapture`) with `pairPano`; a local "show the nearest anyway" flag resets when the left panorama changes. When `capture` changes on the left, `onPick(panoKey(followPano(prev, list)))` keeps the spot. Selection of a `pano` (workspace `selection`) on the left: `onPick(key)`; the parent (Task 7) also moves the left date. Look: linked panes read `fromShared(useStore(panoLookLink).look, 0)`; unlinked panes keep a local `useState` look; pointer drag with `dragLook`, wheel with `zoomLook`, arrows 5 degrees, `+`/`-` zoom; a new panorama on the left resets the shared look to `startLook(heading, cov)` only when the link is fresh (first panorama of the split). The bar: `DateBadge layerId`, ghost buttons with `Icon name="back"` and `"fwd"`, mono id, count, pairing note, `HDG` label, as in `SetPhotoPane`. Root: `data-testid="pane-pano"`, `role="img"` with the label key, `tabIndex={0}`.
- [ ] **Step 4: Run, expect PASS**; `pnpm --filter @aio/desktop exec tsc --noEmit`.
- [ ] **Step 5: Commit** `feat(stage): side by side panoramas with linked look`.

### Task 7: The split: grouped picker and the Panoramas pane on a side

**Files:**

- Modify: `apps/desktop/src/renderer/workspace/SplitPanes.tsx`
- Create: `apps/desktop/src/renderer/workspace/PaneChooser.test.tsx`

**Interfaces:**

- Consumes: Task 4 (`paneGroups`, `paneValue`, `parsePaneValue`, `chooseAt`, `PER_CAPTURE` with `pano`), Task 6 (`PanoPane`), Task 1 (`panosOf` for the `has` callback).
- Produces: `PaneChooser` with one select (`data-testid="pane-select-left"` / `"pane-select-right"`, accessible names unchanged: "Left side shows", "Right side shows"); `pane-date-*` selects removed; `SplitPane` renders `pano`.

- [ ] **Step 1: Failing tests** (`PaneChooser.test.tsx`, a `SplitModel` built by hand):
  - with three dates, the select has optgroups labelled "6 Nov 2024", "2 Oct 2024", "4 Sep 2024", "Any date" in that order (labels from `captureLabel`);
  - choosing "Panoramas" under "2 Oct 2024" calls `split.set` with `right: 'pano', rightCapture: 'oct'`;
  - the other side's exact option is disabled;
  - with one date the select is the flat list of today and no optgroup is rendered;
  - the date swatch shows the side's date colour for a dated pane and is absent for an undated one;
  - the link button (`compare-link`) shows for two Panoramas panes, as for two maps.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
  - `BUILT_IN` gains `pano: { label: 'stage.pane.pano', icon: 'pano' }`; `BuiltInPane` gains `'pano'`; `ZONE.pano = 'photo'`.
  - `PaneChooser`: replace the kind select and the date select by one select. `value = paneValue(current, capture ?? null)`; options from `paneGroups(split.sides, side, split.options, split.dates, has)` where `has(kind, c)` is `kind === 'raster'` ? a raster of date `c` or undated : `kind === 'pano'` ? `panosOf(layers, split.index, c).length > 0` : true. Render `<optgroup label={c ? captureLabel(index, c) : t('stage.pane.anyDate')}>` only when there are two or more groups. `onChange`: `parsePaneValue`, then `dropEvidence()` and `split.set(chooseAt(...))`.
  - `SplitPane`: `kind === 'pano'` renders `<PanoPane side capture={paneCapture(split, side)} otherCapture={paneCapture(split, other)} sides={split.sides} linked={!split.sides.unlinked} onPick={(key) => ...} />`. `onPick` on the left sets `pano: key` and, when the key's layer is dated on another capture, `chooseCapture(..., 'left', thatCapture, dates)`; on the right (after "show the nearest") nothing is saved.
  - Update the mount-point comment above `EXTRA_PANES` (it names the old two selects).
- [ ] **Step 4: Run** the new test and `pnpm --filter @aio/desktop exec vitest run src/renderer/workspace`, PASS.
- [ ] **Step 5: Commit** `feat(stage): the split picker lists panes by survey date`.

### Task 8: "Compare with..." in the tree menus

**Files:**

- Modify: `apps/desktop/src/renderer/shell/DateMenus.tsx`, `apps/desktop/src/renderer/shell/DateMenus.test.tsx`, `apps/desktop/src/renderer/shell/Sidebar.tsx` (two lines)

**Interfaces:**

- Consumes: Task 5 (`compareTargets`, `compareWith`, `COMPARE_WITH_ACTIONS`, `CompareRequest`).
- Produces: `DateFolderMenu` item `date-menu-compare`; `LayerDateMenu` item `move-compare` and a `canEdit` prop; the inline date list rows `compare-to-<captureId>`; a back row `compare-back`.

- [ ] **Step 1: Failing tests** (`DateMenus.test.tsx`, `vi.mock('../workspace/compareWith')`):
  - the folder menu shows "Compare with..."; clicking it shows "Compare 6 Nov 2024 with" and the other dates newest first with their swatches; clicking "2 Oct 2024" calls `compareWith({ from: 'nov', to: 'oct' })` and closes;
  - a disabled target shows its reason text and does not call `compareWith`;
  - "Back" returns to the menu; Escape closes; focus stays in the menu (existing `useMenu`);
  - the layer menu with `canEdit` false shows "Compare with another date..." and no "File under" rows; with `canEdit` true both, and the existing `move-to-*` rows still work;
  - a component pushed into `COMPARE_WITH_ACTIONS` renders under each enabled target and receives `{ request: { from, to, layers }, close }`;
  - the compare item is absent with one survey date.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** A `CompareList` component inside `DateMenus.tsx` reads the project (`useWorkspace`), the index (`useCaptureIndex` from `../workspace/compare`), the stage mode (`useShell`), the saved split (`useStagePrefs`) and the tier (`useGraphics`) to build the `CompareContext` and calls `compareTargets`. Each menu keeps a `view: 'menu' | 'compare'` state; in `compare` the list replaces the items (same `.dmenu-scroll`, `.sw` swatches, `menuitem` roles, `arrowFocus`), with a back row first. In `Sidebar.tsx`: `{datesOn && canEdit && itemMenu && (` becomes `{datesOn && itemMenu && (`, `onItemMenu={canEdit ? setItemMenu : undefined}` becomes `onItemMenu={setItemMenu}` (check `DateTree` still keeps dragging off in read-only, it is gated by `onMove`), and `LayerDateMenu` receives `canEdit={canEdit}`.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(sidebar): compare a date or a layer with another date from the tree`.

### Task 9: End to end, the way CI runs it

**Files:**

- Create: `apps/desktop/e2e/panoFixtures.ts`, `apps/desktop/e2e/pano-compare.spec.ts`
- Modify: `apps/desktop/e2e/compare.spec.ts`, `apps/desktop/e2e/change-raster.spec.ts`

- [ ] **Step 1: Fixture.** `createPanoDateProject(dataRoot)` writes `projects/e2e-pano-dates/`: dates `sep`, `oct`, `nov` (2024-09-04, 2024-10-02, 2024-11-06); a panoramas layer per date with three panoramas at x = 0, 10, 20 (z = 0) on `sep` and `oct` and x = 2, 11, 60 on `nov`, `headingDeg` 0; a mesh per date (`tinyGlb()` from `fixtures.ts`); one tiny 64 x 32 equirect PNG per panorama written with `node:zlib` (a solid colour per date so screenshots tell them apart). The spec extends the base test as `timeline.spec.ts` does with `undatedProject`.
- [ ] **Step 2: Specs** in `pano-compare.spec.ts` (all off-screen, zero network):
  1. Right-click the "Panoramas" row of 6 Nov, "Compare with another date...", "2 Oct 2024": the stage is in split, `pane-pano` twice, left `data-capture="nov"`, right `data-capture="oct"`, right `data-pano` is the nearest to the left one, `data-distance` near 2.
  2. Drag on the left pane: the right pane's `data-yaw` equals the left's (poll). Press the link button: drag again, the right does not move.
  3. In the right picker pick "Panoramas" under "4 Sep 2024": right `data-capture="sep"`, re-paired.
  4. Next on the left (`pano.compare.next`) steps; the right follows. The third left panorama (x = 60 on `nov`) shows "No panorama of ... within 25 m" and "Show the nearest".
  5. Date bar previous: the left date changes and the left panorama is the one nearest the previous spot.
  6. Right-click the 2 Oct folder, "Compare with...", "6 Nov 2024", with the stage on 3D: two 3D views, captures `oct` and `nov`.
  7. Reopen the project: the split, both dates and the left panorama are kept.
  8. `test.use({ appEnv: { QUADRION_WINDOW_SIZE: '1100x700' } })` block: the pane bar and chooser do not cover the view centre (`document.elementFromPoint` at the pane centre is the canvas).
- [ ] **Step 3: Update** `compare.spec.ts` and `change-raster.spec.ts`: every `selectOption` on "Left side shows" / "Right side shows" with a kind, and every `pane-date-*` select, goes through one helper `choosePane(win, side, kind, capture?)` that selects `kind` or `kind@capture` on `pane-select-<side>`.
- [ ] **Step 4: Run the way CI does** (from `apps/desktop`, through the runner): `pnpm demo:build --quick` (and `pnpm demo:change --quick`), then `QUADRION_WINDOW_SIZE=1100x720 QUADRION_E2E_SCALE=1 QUADRION_E2E_SWGL=1 npx playwright test e2e/pano-compare.spec.ts e2e/compare.spec.ts e2e/change-raster.spec.ts e2e/timeline.spec.ts --workers=1`, then the new spec with `--repeat-each=3`. The log must show `[e2e] window 1100 x 720 px at display scale 1`. Worktrees have no `python/.venv`: point `QUADRION_E2E_PYTHON` at the main checkout's venv.
- [ ] **Step 5: Commit** `test(e2e): panoramas of two dates and Compare with from the tree`.

### Task 10: Guide and testing document

**Files:**

- Modify: `docs/guide/04-compare-dates.md`, `docs/TESTING.md`

- [ ] **Step 1:** `04-compare-dates.md`: a section "Compare from the tree" ("Compare with..." on a date folder and on a dataset; which view opens for which kind of data) and "Panoramas side by side" (pairing by position within 25 m, linked look, the link button, stepping on the left, "Show the nearest"). The picker paragraph describes the date groups.
- [ ] **Step 2:** `TESTING.md`: a stage "Timeline T3: compare across dates" with the steps of "How to test" below, on a project with panoramas on two dates (a demo or a test project the founder picks; no project names in the file).
- [ ] **Step 3:** `pnpm format:check`; `node tools/agent/check-public-text.mjs docs/guide/04-compare-dates.md docs/TESTING.md`.
- [ ] **Step 4: Commit** `docs(guide): compare dates from the tree and panoramas side by side`.

## Contract changes

None. No `@aio/schema`, IPC, manifest or file format change, so no row in `docs/architecture/contract-changes.md`. Renderer-only saved state changes: `stratlas.stagePrefs` split gains the kind `pano` and the field `pano`; an older build drops a `pano` side back to its default (its parser rejects the unknown kind) and ignores the field.

## After the last task

- `pnpm check` green (runner), e2e as Task 9 step 4, an independent review of the whole branch.
- `node tools/agent/finish-task.mjs` for the hand-off; mention the overlap with `feat/timeline-t2-add-survey-date` (`Sidebar.tsx` two lines, `en.ts` appended block) and that T4 hooks in through `compareWith` and `COMPARE_WITH_ACTIONS`.

## How to test (for the founder)

On a project with panoramas on at least two survey dates:

1. Open the project. In the sidebar, under the newest date, right-click **Panoramas** and choose **Compare with another date...**, then an older date. The stage splits into two panoramas: the newest date on the left, the older one on the right, each with its date tag.
2. Drag in either panorama. Both turn together and show the same bearing (**HDG**). Press the link button in the right pane's corner and drag again: now only one turns.
3. Press **Next panorama** in the left pane. The right pane follows to the panorama nearest the new spot and says how far apart they are. Where no older panorama is within 25 m it says so and offers **Show the nearest**.
4. Use the date bar's arrows. The left pane changes date and stays at the same spot.
5. Open the right pane's picker: the choices are grouped by date. Pick **Panoramas** under a third date; the right pane switches date and pairs again.
6. Right-click a date folder, choose **Compare with...** and another date. With the stage on 3D, two 3D views open, one per date; on the map, two maps.
7. Right-click an ortho under a date and compare it with another date: two orthos open. Do the same on a video: the Frames pane opens with the other date.
8. Close and reopen the project: the split, its dates and the left panorama are as you left them.
