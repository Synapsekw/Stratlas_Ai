# Walk placing by start and end: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Place walk shows the walk's whole shape from the first hover, places, turns and scales it between a start click and an end click on a drawing, the map or the 3D view, lets the Start and End handles be dragged with a live refit, refuses to draw a silent straight line for a walk with no computed path, and adds Edit placement and Remove placement.

**Architecture:** A placement stays a start pin and an end pin (plus optional fine-tune pins); only the interaction changes. `@aio/geo` gains pure preview maths (`walk/preview.ts`); the session (`placeStore.ts`) gains the phases `check`, `start`, `end`, `placed`, `fine-tune`, a hover preview and handle drags; each surface feeds it pointer events (the drawing through `RasterPane`, the map through a new pointer session on the `@aio/maps` controller, the 3D view through a new `walkScene.ts` after the measure tool's `attach3d`); the strip becomes a slim toolbar; the tree row gets Edit placement and Remove placement.

**Tech Stack:** TypeScript strict, React 19 + zustand, MapLibre (via `@aio/maps`), three.js (via `@aio/engine`'s `EngineStage`), Vitest, Playwright with Electron.

**Spec:** `docs/plans/2026-10-13-walk-start-end-placing-design.md` (approved 13 Oct 2026). It builds on `docs/plans/2026-10-12-walk-layer-and-placing-design.md`; the fit (`fitWalk`), the calibration and the pose file stay as they are. Read the spec, `CONTRIBUTING.md` and `CLAUDE.md` before any task.

**Worktree:** `E:\Dev\AIO Software\.claude\worktrees\walk-start-end-placing`, branch `feat/walk-start-end-placing`. Every path below is relative to it. Never edit the main checkout.

## Global Constraints

- TypeScript strict everywhere; no `any`, no non-null assertions (`!`). Renderer code never imports `electron` or `node:*`.
- No em or en dashes in user-facing text (strings, UI copy, docs); use commas, colons or "to". No emoji anywhere.
- No client, site, tester or person names anywhere (code, tests, commits, docs). Run `node tools/agent/check-public-text.mjs <files>` on every doc you add or change.
- No contract change: `@aio/schema` is not edited (see "Contract changes").
- 3D pins use `MODEL_SURFACE` (`@model`): `at = [x, z]` in the model frame, `y` the clicked height. `placedOn` is `@model` for the map and 3D, the drawing's layer id for a drawing.
- Start pin `t = raw.walking.startT`, end pin `t = raw.walking.endT`; 0 and `durationS` when the raw path has no `walking` (or there is no raw path).
- Start and end closer than 5 m (`MIN_PIN_SPAN_M`): the hint says so while hovering and the click is ignored; a drag to such a spot keeps the handle at its last allowed spot.
- Ghost scale: about 0.7 m per step (`GHOST_M_PER_STEP = 0.7`).
- Remove placement sends the existing `{ walk: null }` patch; Remove walk is unchanged.
- The Globe is out of scope; no width-stretch handle; no `.trash` restore.
- Tests: Vitest next to the code. e2e keeps Electron windows off-screen (the fixtures do it) and runs with `--workers=1`, one Playwright run at a time.
- Commits: conventional commits, stage by path (never `git add -A` or `git add .`), never a bare `git stash`, message ends with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

The inputs the spec implies but no headline test exercises, most likely to bite first. Each has its test in the owning task.

1. **The pointer leaves the surface or hits nothing** (map `mouseout`, 3D ray into the sky, outside the drawing): the ghost and preview disappear, nothing throws, the next hover brings them back. Tests: T2 step 1 (`mouseout` reports null), T5 (`hover(null)` clears), T7 (raycast null clears).
2. **A handle drag released outside the map canvas, or Escape during the drag**: map panning comes back on and the session ends the drag. Tests: T2 (window `mouseup`, Escape), T7 (window `pointerup` turns the orbit controls back on).
3. **A raw path with two reconstructions** (`raw-path.broken.json`, segment 0 and 1 in different raw frames): the preview uses the reconstruction with the most stills and stays finite; the saved fit still uses `fitWalk`. Test: T1.
4. **A raw path without `walking`, or no raw path at all ("Place between two points anyway")**: pins at 0 and `durationS`, the preview is a straight two point line, no ghost before the start. Tests: T5.
5. **Edit placement of a walk placed on `@model`, or on a drawing that is gone**: the map when the stage shows the map, else 3D; a gone drawing falls back to the first surface. Tests: T3 (`rememberedSurface`), T8 (`begin`).

## Contract changes

None. Checked against `packages/schema/src`:

- `WalkPin` (`walks.ts:119`) already takes `surface: '@model' | Id`, `at: [number, number]` and an optional `y`; 3D pins need nothing new.
- `WalkCalibration.placedOn` (`walks.ts:132`) is a free string; `@model` and drawing ids already fit.
- `LayerPatch` `{ walk: WalkCalibration | null }` (`builder.ts:229`) already clears a placement, applied in `packages/project/src/builder/create.ts:231-243` (drops `place` and `flight`).
- The walk layer (`layers.ts:216-226`) and `JobRecord` statuses (`jobs.ts:1170-1178`, including `interrupted`) are read only.
- No IPC channel is added. `PlaceSurface`, `PlaceStep` and `MapPointerSession` are renderer or package types, not `@aio/schema` contracts.

No row is added to `docs/architecture/contract-changes.md`.

## Package ownership

| Task | Packages and areas touched                                                                                                                                                                                                              |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1   | `packages/geo` (`src/walk/preview.ts`, `src/walk/index.ts`)                                                                                                                                                                             |
| T2   | `packages/maps` (`src/controller.ts`, `src/MapView.tsx`, `src/index.ts`)                                                                                                                                                                |
| T3   | `apps/desktop` renderer: `walks/placeModel.ts`, one-line type fixes in `walks/PlaceWalkStrip.tsx` and `walks/placeWalk.ts`                                                                                                              |
| T4   | `apps/desktop` renderer: `walks/walkOverlay.ts`, `walks/WalkSheetOverlay.tsx`, `walks/walkMapOverlay.ts`, `workspace/RasterPane.tsx`                                                                                                    |
| T5   | `apps/desktop` renderer: `walks/placeStore.ts`, `walks/placeModel.ts` (`PlaceStep`, `firstStep` removed)                                                                                                                                |
| T6   | `packages/ui` (`src/tree/DatasetTree.tsx`, `src/i18n/en.ts`)                                                                                                                                                                            |
| T7   | `apps/desktop` renderer: `walks/walkScene.ts` (new)                                                                                                                                                                                     |
| T8   | `apps/desktop` renderer: `walks/placeWalk.ts`, `walks/walkMapStore.ts`, `walks/walks.ts`                                                                                                                                                |
| T9   | `apps/desktop` renderer: `walks/PlaceWalkStrip.tsx`, `walks/placeWalk.css`                                                                                                                                                              |
| T10  | `apps/desktop` renderer: `workspace/Stage.tsx`, `shell/Sidebar.tsx`, `walks/WalkSceneMount.tsx` (new); docs `docs/guide/08-building-projects.md`, `docs/TESTING.md`                                                                     |
| T11  | `apps/desktop/e2e`: `walkFixture.ts`, `walk-place.spec.ts`, `walk-place-map.spec.ts` (new), `walk-place-3d.spec.ts` (new)                                                                                                               |
| T13  | `packages/project` (`src/builder/raw.ts`, `src/builder/walkSource.ts`); `apps/desktop` renderer: `builder/state.ts`, `builder/ImportPanel.tsx`, `builder/importSummary.ts` (new); `apps/desktop/e2e/walk-import-stitched.spec.ts` (new) |
| T12  | none (verification)                                                                                                                                                                                                                     |

## Execution DAG

```
T1 geo preview ─────┐
T3 placeModel ──────┼─> T5 placeStore ─┐
T2 maps session ────┼──────────────────┼─> T8 flow ─┬─> T9 toolbar ──┐
T4 overlays ────────┘                  │            ├─> T10 wiring ──┼─> T12 verify
                       T6 tree ────────┤            └─> T11 e2e ─────┘
                       T7 walkScene ───┘
T13 stitched 360 import (batch 1, no dependency) ───────────────────────> T12 verify
```

| Task | Depends on                                                       |
| ---- | ---------------------------------------------------------------- |
| T1   | none                                                             |
| T2   | none                                                             |
| T3   | none                                                             |
| T4   | none                                                             |
| T5   | T1, T3                                                           |
| T6   | none (batched with T5 for balance)                               |
| T7   | none (batched with T5 for balance)                               |
| T8   | T2, T3, T4, T5                                                   |
| T9   | T5, T8                                                           |
| T10  | T6, T7, T8                                                       |
| T11  | T8 (test ids fixed in this plan; written in batch 4, run in T12) |
| T13  | none                                                             |
| T12  | all                                                              |

**Parallel batches** (each dispatched in one message; tasks in a batch share no file):

| Batch | Tasks               | Files they own (no overlap)                                                                                                                                                                                                                                                                                                                                                                      |
| ----- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | T1, T2, T3, T4, T13 | geo `walk/preview*`; maps `controller*`, `MapView.tsx`, `index.ts`; `placeModel*` (+ one line each in `PlaceWalkStrip.tsx`, `placeWalk.ts`); `walkOverlay*`, `WalkSheetOverlay*`, `walkMapOverlay*`, `RasterPane.tsx`; T13: project `raw*`, `walkSource*`, `rawWalks.test.ts`, desktop `builder/state*`, `builder/ImportPanel.tsx`, `builder/importSummary*`, `e2e/walk-import-stitched.spec.ts` |
| 2     | T5, T6, T7          | `placeStore*`, `placeModel*`; ui `DatasetTree*`, `walkRows.test.tsx`, `en.ts`; `walkScene*`                                                                                                                                                                                                                                                                                                      |
| 3     | T8                  | `placeWalk*`, `walkMapStore*`, `walks.ts`                                                                                                                                                                                                                                                                                                                                                        |
| 4     | T9, T10, T11        | `PlaceWalkStrip*`, `placeWalk.css`; `Stage.tsx`, `Sidebar.tsx`, `WalkSceneMount*`, guide and TESTING docs; `e2e/walkFixture.ts`, three e2e specs                                                                                                                                                                                                                                                 |
| 5     | T12                 | none                                                                                                                                                                                                                                                                                                                                                                                             |

**Critical path:** T3 (or T1) -> T5 -> T8 -> T9 -> T12. T13 (founder's addition, 13 Oct) is independent of the placing work and lands in batch 1; its files overlap with no other task. T8 is the only single-task batch: it joins the store, the overlays and the map session into the flow.

**Typecheck between batches.** Vitest does not typecheck and the commit hooks run only lint-staged and commitlint. T5 changes `PlaceStep`, so `pnpm --filter @aio/desktop typecheck` fails in `placeWalk.ts` and `PlaceWalkStrip.tsx` from batch 2 until T8 and T9 land. Each task keeps its own files type-clean and runs its own tests; batch 4 closes the gap and T12 proves the whole repo green.

## e2e specs

| Spec                                            | Change    | What it proves                                                                                                                                                                                                                                                                               |
| ----------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/e2e/walk-place.spec.ts`           | rewritten | Drawing: ghost on hover, start, a too-close end ignored, end, drag the End handle, Fine-tune opens the 360, Save, the pose has the L bend, Edit placement, Remove placement. Remove walk (kept). Unprocessed walk: notice, Process walk offered, no line. Smallest window (kept, new steps). |
| `apps/desktop/e2e/walk-place-map.spec.ts`       | new       | UTM project (fixture `crs: 'utm'`, no drawing): place on the map by start and end, drag a handle, Save, pose bend.                                                                                                                                                                           |
| `apps/desktop/e2e/walk-import-stitched.spec.ts` | new (T13) | A 2:1 MP4 without an SRT added through Add data becomes a walk row; a 16:9 one is skipped with a reason naming Add 360 video; the panel says where each file went.                                                                                                                           |
| `apps/desktop/e2e/walk-place-3d.spec.ts`        | new       | Local grid, no drawing: place in the 3D view, preview object follows the pointer, drag a handle, Save, pose bend, `placedOn` `@model`.                                                                                                                                                       |

The walk fixture (`e2e/walkFixture.ts`) gains options `{ crs?: 'local' | 'utm'; drawing?: boolean; processed?: boolean }`. The bend check reads `walks/w1/pose.json`: the synthetic walk is an L (`tools/fixtures/walk-truth.mjs`: 40 m east, then 30 m north), so the corner sample lies 24 m from the start to end chord; every spec asserts more than 15 m.

## Spec ambiguities resolved here

1. **"The surface fills the stage" for a drawing.** A drawing only shows in a split pane. Placing on a drawing opens the split with the drawing on one side and the 3D view on the other (never the 360 video); the map and 3D use the stage modes `map` and `3d`. Fine-tune puts the 360 video beside the surface.
2. **The survey date as a field.** The field preselects the first choice of `dateChoices` (the walk's capture, the `capturedAt` date's, or "Add survey date ..."). Save applies it (adds the date when needed) before the placement, so a walk without a date never blocks placing. With no choice at all the walk is saved undated.
3. **Surface choice.** The toolbar keeps the **Place on** select (drawings, Map, 3D view) so the surface can be switched; the order is `placeSurfaces` with 3D last.
4. **Path state mapping.** `ready`: the layer has `path` and its raw path is usable (sfm, two registered stills); `running`: no usable path and a `walk.process` job is starting, running or cancelling; `interrupted`: the job is `interrupted` or `cancelled`; `failed`: the job failed, or a path exists but is unusable (pins-only, unreadable); `none`: otherwise. A walk that already has two saved pins skips the check (it was placed knowingly).
5. **"A path that disappears ends the session with a notice."** The draft pins are dropped and the toolbar shows the path notice (`check`), so the person sees why.
6. **Preview with several reconstructions.** The preview draws the reconstruction with the most registered stills inside `walking`; the placed draft (after the end click) is the real `fitWalk`, dashed across gaps as today.
7. **Ghost on a drawing with a provisional scale.** The ghost is 30 % of the drawing's width long instead of 0.7 m per step.
8. **Process walk from the notice.** A stitched video starts at once; a camera file asks for its original (`locateOriginal`), as the row's Process walk does. Without the pipeline pack the button is disabled with the row's "Needs a newer pipeline pack" hint.
9. **Handles.** Start is the first pin by time, End the last. On the drawing they are drawn as round handles (Start hollow, End filled, each with a title); inner fine-tune pins keep their numbers.

---

### Task 1: Preview maths (`@aio/geo`)

**Files:**

- Create: `packages/geo/src/walk/preview.ts`
- Create: `packages/geo/src/walk/preview.test.ts`
- Modify: `packages/geo/src/walk/index.ts` (export the new names)

**Interfaces:**

- Consumes: `levelStills`, `XZ` (`walk/horizontal.ts:143`, `:4`); `sim2FromPairs`, `applySim2` (`walk/similarity2.ts:16`, `:37`).
- Produces (exported from `@aio/geo`):
  - `interface WalkOutline { t: number[]; xz: XZ[]; steps: number[] }`
  - `walkOutline(raw: WalkRawPath | null): WalkOutline | null`
  - `outlineAt(o: WalkOutline, t: number): XZ`
  - `previewPath(o: WalkOutline, startT: number, endT: number, start: XZ, cursor: XZ): XZ[] | null`
  - `ghostLengthM(o: WalkOutline, metresPerStep?: number): number`
  - `ghostPath(o: WalkOutline, cursor: XZ, lengthM: number): XZ[] | null`
  - `GHOST_M_PER_STEP = 0.7`, `GHOST_FALLBACK_M = 30`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/geo/src/walk/preview.test.ts
import type { WalkRawPath } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { loadRaw, truthXZ } from '../__fixtures__/walk';
import {
  GHOST_FALLBACK_M,
  ghostLengthM,
  ghostPath,
  outlineAt,
  previewPath,
  walkOutline,
} from './preview';
import type { XZ } from './horizontal';

const dist = (a: XZ, b: XZ) => Math.hypot(a[0] - b[0], a[1] - b[1]);
/** Distance of p from the line through a and b. */
const offChord = (p: XZ, a: XZ, b: XZ) => {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  return Math.abs(dx * (p[1] - a[1]) - dz * (p[0] - a[0])) / Math.hypot(dx, dz);
};

describe('walkOutline', () => {
  it('is null without a raw path or for a pins-only one', () => {
    expect(walkOutline(null)).toBeNull();
    const raw = loadRaw('synthetic');
    expect(walkOutline({ ...raw, source: 'pins-only' })).toBeNull();
  });

  it('keeps the registered stills inside the walking part, sorted by time', () => {
    const o = walkOutline(loadRaw('synthetic'));
    expect(o).not.toBeNull();
    expect(o?.t[0]).toBeGreaterThanOrEqual(4);
    expect(o?.t.at(-1)).toBeLessThanOrEqual(62);
    expect(o?.xz.length).toBe(o?.t.length);
  });

  it('keeps one reconstruction of a broken path: the one with the most stills', () => {
    const o = walkOutline(loadRaw('broken'));
    expect(o).not.toBeNull();
    // segment 0 runs 4 s to 30 s, segment 1 38 s to 62 s: one of them only, never both
    const before = o?.t.filter((t) => t < 30).length ?? 0;
    const after = o?.t.filter((t) => t > 38).length ?? 0;
    expect(before === 0 || after === 0).toBe(true);
  });
});

describe('previewPath', () => {
  const raw = loadRaw('synthetic');
  const o = walkOutline(raw);
  if (!o) throw new Error('no outline');

  it('lays the shape between start and cursor: the corner lands on the truth', () => {
    const start = truthXZ(raw, 4);
    const end = truthXZ(raw, 62);
    const pts = previewPath(o, 4, 62, start, end);
    expect(pts).not.toBeNull();
    const i = o.t.findIndex((t) => t >= 37);
    const p = pts?.[i];
    if (!p) throw new Error('no corner point');
    expect(dist(p, truthXZ(raw, o.t[i] ?? 37))).toBeLessThan(0.05);
    // an L, not a straight line: the corner lies 24 m off the start to end chord
    expect(offChord(p, start, end)).toBeGreaterThan(20);
  });

  it('turns and scales with the cursor', () => {
    const pts = previewPath(o, 4, 62, [0, 0], [0, -100]);
    expect(pts?.[0]?.[0]).toBeCloseTo(0, 6);
    expect(pts?.[0]?.[1]).toBeCloseTo(0, 6);
    const last = pts?.at(-1);
    if (!last) throw new Error('no end');
    expect(dist(last, [0, -100])).toBeLessThan(0.5);
  });

  it('is null when the outline does not move between its anchors', () => {
    const still: WalkRawPath = {
      ...raw,
      stills: raw.stills.map((s) => ({ ...s, pos: [1, 0, 1] as [number, number, number] })),
    };
    const flat = walkOutline(still);
    expect(flat === null || previewPath(flat, 4, 62, [0, 0], [10, 0]) === null).toBe(true);
  });

  it('stays finite on a broken path', () => {
    const b = walkOutline(loadRaw('broken'));
    if (!b) throw new Error('no outline');
    const pts = previewPath(b, 4, 62, [0, 0], [40, -30]);
    expect(pts?.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))).toBe(true);
  });

  it('outlineAt clamps to the ends', () => {
    expect(outlineAt(o, -10)).toEqual(o.xz[0]);
    expect(outlineAt(o, 1e9)).toEqual(o.xz.at(-1));
  });
});

describe('ghostPath', () => {
  const o = walkOutline(loadRaw('synthetic'));
  if (!o) throw new Error('no outline');

  it('puts the first point under the cursor at about 0.7 m a step', () => {
    const length = ghostLengthM(o);
    const steps = (o.steps.at(-1) ?? 0) - (o.steps[0] ?? 0);
    expect(length).toBeCloseTo(0.7 * steps, 6);
    const pts = ghostPath(o, [5, 6], length);
    expect(pts?.[0]).toEqual([5, 6]);
    let walked = 0;
    for (let i = 1; i < (pts?.length ?? 0); i++) {
      const a = pts?.[i - 1];
      const b = pts?.[i];
      if (a && b) walked += dist(a, b);
    }
    expect(walked).toBeCloseTo(length, 3);
  });

  it('falls back to a fixed length when the path counts no steps', () => {
    expect(ghostLengthM({ ...o, steps: o.steps.map(() => 0) })).toBe(GHOST_FALLBACK_M);
  });

  it('is null for a length that is not positive', () => {
    expect(ghostPath(o, [0, 0], 0)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm --filter @aio/geo exec vitest run src/walk/preview.test.ts`
Expected: FAIL, `Cannot find module './preview'`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/geo/src/walk/preview.ts
import type { WalkRawPath } from '@aio/schema';
import { levelStills, type XZ } from './horizontal';
import { applySim2, sim2FromPairs } from './similarity2';

/*
 * The walk's shape while it is being placed (design "Walk placing by start and end"): pure
 * helpers over the levelled raw path. Before the start click a ghost of the whole shape follows
 * the cursor; between the clicks the shape is laid between the start and the cursor by the same
 * two point similarity the fit uses. The saved placement is always `fitWalk`.
 */

/** Metres per step the ghost is drawn at before the start is set. */
export const GHOST_M_PER_STEP = 0.7;
/** The ghost's length when the raw path counts no steps, metres. */
export const GHOST_FALLBACK_M = 30;

/** One reconstruction of the levelled raw path, registered stills only, sorted by time. */
export interface WalkOutline {
  t: number[];
  xz: XZ[];
  steps: number[];
}

/**
 * The shape to preview: the registered stills of the reconstruction with the most of them,
 * inside the walking part when the raw path names one (all of them when fewer than two lie
 * inside). Null without a raw path, for a pins-only one, or with fewer than two stills.
 */
export function walkOutline(raw: WalkRawPath | null): WalkOutline | null {
  if (!raw || raw.source === 'pins-only') return null;
  const stills = levelStills(raw).flatMap((s) =>
    s.xz ? [{ t: s.t, xz: s.xz, steps: s.steps, segment: s.segment ?? 0 }] : [],
  );
  const count = new Map<number, number>();
  for (const s of stills) count.set(s.segment, (count.get(s.segment) ?? 0) + 1);
  let best = 0;
  let most = 0;
  for (const [segment, n] of count)
    if (n > most) {
      best = segment;
      most = n;
    }
  const own = stills.filter((s) => s.segment === best);
  const from = raw.walking?.startT ?? -Infinity;
  const to = raw.walking?.endT ?? Infinity;
  const inside = own.filter((s) => s.t >= from && s.t <= to);
  const kept = inside.length >= 2 ? inside : own;
  if (kept.length < 2) return null;
  return { t: kept.map((s) => s.t), xz: kept.map((s) => s.xz), steps: kept.map((s) => s.steps) };
}

/** The outline at time t, interpolated, clamped to its first and last still. */
export function outlineAt(o: WalkOutline, t: number): XZ {
  const first = o.xz[0] ?? [0, 0];
  const last = o.xz.at(-1) ?? first;
  if (!(t > (o.t[0] ?? 0))) return first;
  if (t >= (o.t.at(-1) ?? 0)) return last;
  let i = 0;
  while (i + 1 < o.t.length && (o.t[i + 1] ?? Infinity) <= t) i++;
  const a = o.xz[i] ?? first;
  const b = o.xz[i + 1] ?? a;
  const ta = o.t[i] ?? 0;
  const tb = o.t[i + 1] ?? ta;
  const f = tb > ta ? (t - ta) / (tb - ta) : 0;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}

/**
 * The shape laid between `start` (where the outline is at `startT`) and `cursor` (where it is at
 * `endT`): rotated, scaled and moved, every point. Null when the outline's two anchors coincide.
 */
export function previewPath(
  o: WalkOutline,
  startT: number,
  endT: number,
  start: XZ,
  cursor: XZ,
): XZ[] | null {
  const m = sim2FromPairs(outlineAt(o, startT), outlineAt(o, endT), start, cursor);
  return m ? o.xz.map((p) => applySim2(m, p)) : null;
}

/** The ghost's length: the steps walked times `metresPerStep`, or a fixed length without steps. */
export function ghostLengthM(o: WalkOutline, metresPerStep = GHOST_M_PER_STEP): number {
  const steps = (o.steps.at(-1) ?? 0) - (o.steps[0] ?? 0);
  return steps > 0 ? steps * metresPerStep : GHOST_FALLBACK_M;
}

/**
 * The shape as the raw path heads, its first point at `cursor`, scaled so it runs `lengthM`
 * along itself. Null when the length or the outline's own length is not positive.
 */
export function ghostPath(o: WalkOutline, cursor: XZ, lengthM: number): XZ[] | null {
  let own = 0;
  for (let i = 1; i < o.xz.length; i++) {
    const a = o.xz[i - 1];
    const b = o.xz[i];
    if (a && b) own += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  if (!(own > 1e-9) || !(lengthM > 0) || !Number.isFinite(lengthM)) return null;
  const s = lengthM / own;
  const [x0, z0] = o.xz[0] ?? [0, 0];
  return o.xz.map(([x, z]) => [cursor[0] + (x - x0) * s, cursor[1] + (z - z0) * s]);
}
```

Add to `packages/geo/src/walk/index.ts`:

```ts
export {
  GHOST_FALLBACK_M,
  GHOST_M_PER_STEP,
  ghostLengthM,
  ghostPath,
  outlineAt,
  previewPath,
  walkOutline,
  type WalkOutline,
} from './preview';
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm --filter @aio/geo exec vitest run src/walk/preview.test.ts` then `pnpm --filter @aio/geo test` and `pnpm --filter @aio/geo typecheck`.
Expected: PASS. If the broken-path test shows both halves, check that `segment` defaults to 0 only for registered stills.

- [ ] **Step 5: Commit**

```bash
git add packages/geo/src/walk/preview.ts packages/geo/src/walk/preview.test.ts packages/geo/src/walk/index.ts
git commit -m "feat(geo): walk preview shape between a start and the cursor, and its ghost" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Map pointer session (`@aio/maps`)

**Files:**

- Modify: `packages/maps/src/controller.ts` (interface at `:114-137`, pick block `:485-514`, `onClick` `:1194`, `load` handlers `:1257-1290`, returned object `:1405-1451`)
- Modify: `packages/maps/src/MapView.tsx` (props `:37-43`, effect `:115-119`)
- Modify: `packages/maps/src/index.ts:66` (export the type)
- Test: `packages/maps/src/controller.test.ts`

**Interfaces:**

- Consumes: nothing from other tasks.
- Produces:

```ts
/** A live pointer session on the map (placing a walk): hover, clicks and draggable handles. */
export interface MapPointerSession {
  /** The pointer moved over the map (not dragging): its local point; null when it left the map. */
  onMove?: (local: Vec3 | null) => void;
  /** A click on the map (not on a handle being dragged): its local point. Stays armed. */
  onClick?: (local: Vec3) => void;
  /** The handles a press can grab, in local coordinates, read on every press. */
  handles?: () => readonly { id: string; local: Vec3 }[];
  onDrag?: (id: string, local: Vec3) => void;
  onDragEnd?: (id: string, local: Vec3 | null) => void;
  /** Escape. */
  onCancel?: () => void;
}
// MapController gains:
pointerSession(s: MapPointerSession): () => void;
// MapViewProps gains:
pointer?: MapPointerSession | null;
```

`pickPoint` and the `pick` prop stay as they are (still a public API); only walks stop using them (T8).

- [ ] **Step 1: Write the failing tests**

Extend `FakeMap` in `controller.test.ts`:

```ts
  readonly dragPan = { enable: vi.fn(), disable: vi.fn() };
  /** Screen px of a lon/lat: a fixed linear map, so tests can aim at handles. */
  project(ll: [number, number] | { lng: number; lat: number }) {
    const [lng, lat] = Array.isArray(ll) ? ll : [ll.lng, ll.lat];
    return { x: lng * 1e5, y: -lat * 1e5 };
  }
```

Add after the pick describe (reuse `startWithProject` by moving it and `click` to file scope):

```ts
describe('map pointer session (placing a walk: hover, click, handles)', () => {
  const ev = (
    proj: { toLonLat(v: [number, number, number]): [number, number] },
    local: [number, number, number],
  ) => {
    const [lng, lat] = proj.toLonLat(local);
    return {
      point: { x: lng * 1e5, y: -lat * 1e5 },
      lngLat: { lng, lat },
      originalEvent: { clientX: 0, clientY: 0, altKey: false },
      preventDefault: vi.fn(),
    };
  };

  it('reports hover points, null when the pointer leaves, and clicks without selecting', () => {
    const { ctl, map, proj, store } = startWithProject();
    const onMove = vi.fn();
    const onClick = vi.fn();
    ctl.pointerSession({ onMove, onClick });
    expect(map.canvas.style.cursor).toBe('crosshair');
    expect(map.doubleClickZoom.disable).toHaveBeenCalled();
    map.fire('mousemove', ev(proj, [12, 0, -34]));
    const moved = onMove.mock.calls[0]?.[0] as [number, number, number];
    expect(moved[0]).toBeCloseTo(12, 3);
    expect(moved[2]).toBeCloseTo(-34, 3);
    map.fire('mouseout');
    expect(onMove).toHaveBeenLastCalledWith(null);
    const select = vi.spyOn(store.getState(), 'select');
    map.fire('click', ev(proj, [1, 0, 2]));
    map.fire('click', ev(proj, [3, 0, 4]));
    // a session stays armed: both clicks are reported, nothing is selected
    expect(onClick).toHaveBeenCalledTimes(2);
    expect(select).not.toHaveBeenCalled();
  });

  it('a press on a handle drags it with panning off; a press elsewhere pans', () => {
    const { ctl, map, proj } = startWithProject();
    const onDrag = vi.fn();
    const onDragEnd = vi.fn();
    const onMove = vi.fn();
    ctl.pointerSession({
      onMove,
      onDrag,
      onDragEnd,
      handles: () => [{ id: 'end', local: [40, 0, -30] }],
    });
    // far from the handle: no drag
    map.fire('mousedown', ev(proj, [0, 0, 0]));
    expect(map.dragPan.disable).not.toHaveBeenCalled();
    map.fire('mouseup', ev(proj, [0, 0, 0]));
    // on the handle
    const down = ev(proj, [40, 0, -30]);
    map.fire('mousedown', down);
    expect(down.preventDefault).toHaveBeenCalled();
    expect(map.dragPan.disable).toHaveBeenCalledTimes(1);
    map.fire('mousemove', ev(proj, [41, 0, -29]));
    expect(onDrag).toHaveBeenCalledWith('end', expect.any(Array));
    expect(onMove).not.toHaveBeenCalled();
    map.fire('mouseup', ev(proj, [41, 0, -29]));
    expect(onDragEnd).toHaveBeenCalledWith('end', expect.any(Array));
    expect(map.dragPan.enable).toHaveBeenCalledTimes(1);
  });

  it('a release outside the map ends the drag, and Escape cancels and ends it', () => {
    const { ctl, map, proj } = startWithProject();
    const onDragEnd = vi.fn();
    const onCancel = vi.fn();
    ctl.pointerSession({ onDragEnd, onCancel, handles: () => [{ id: 'start', local: [0, 0, 0] }] });
    map.fire('mousedown', ev(proj, [0, 0, 0]));
    window.dispatchEvent(new MouseEvent('mouseup'));
    expect(onDragEnd).toHaveBeenCalledWith('start', null);
    expect(map.dragPan.enable).toHaveBeenCalledTimes(1);
    map.fire('mousedown', ev(proj, [0, 0, 0]));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(map.dragPan.enable).toHaveBeenCalledTimes(2);
  });

  it('the returned function and dispose stop the session', () => {
    const { ctl, map, proj } = startWithProject();
    const onClick = vi.fn();
    const stop = ctl.pointerSession({ onClick });
    stop();
    expect(map.canvas.style.cursor).toBe('');
    map.fire('click', ev(proj, [1, 0, 1]));
    expect(onClick).not.toHaveBeenCalled();
    ctl.pointerSession({ onClick });
    ctl.dispose();
    expect(onClick).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm --filter @aio/maps exec vitest run src/controller.test.ts`
Expected: FAIL, `ctl.pointerSession is not a function`.

- [ ] **Step 3: Write the implementation**

In `controller.ts`, add `MapPointerSession` (export) next to `MapController`, add `pointerSession` to the interface with a doc comment (live, does not disarm itself; cursor crosshair; double click does not zoom; Escape calls `onCancel`; a new session replaces the old one; needs a projection, events are ignored until there is one). After the pick block:

```ts
// ----- a live pointer session (placing a walk) -----
/** A press this close to a handle (screen px) grabs it. */
const HANDLE_PX = 12;
let session: MapPointerSession | null = null;
let grabbed: { id: string; last: Vec3 | null } | null = null;

function handleAt(point: { x: number; y: number }): string | null {
  if (!session?.handles || !proj) return null;
  let best: string | null = null;
  let bestD = HANDLE_PX;
  for (const h of session.handles()) {
    const p = map.project(proj.toLonLat(h.local));
    const d = Math.hypot(p.x - point.x, p.y - point.y);
    if (d <= bestD) {
      best = h.id;
      bestD = d;
    }
  }
  return best;
}
function endGrab(): void {
  const g = grabbed;
  if (!g) return;
  grabbed = null;
  window.removeEventListener('mouseup', onWindowUp);
  map.dragPan.enable();
  session?.onDragEnd?.(g.id, g.last);
}
const onWindowUp = (): void => {
  endGrab();
};
function onSessionKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || !session) return;
  const s = session;
  endGrab();
  s.onCancel?.();
}
function stopSession(): void {
  if (!session) return;
  endGrab();
  session = null;
  window.removeEventListener('keydown', onSessionKey);
  const drawing = draw?.()?.mode != null || picking !== null;
  map.getCanvas().style.cursor = drawing ? 'crosshair' : '';
  if (!drawing) map.doubleClickZoom.enable();
}
function pointerSession(s: MapPointerSession): () => void {
  stopSession();
  session = s;
  window.addEventListener('keydown', onSessionKey);
  map.getCanvas().style.cursor = 'crosshair';
  map.doubleClickZoom.disable();
  return () => {
    if (session === s) stopSession();
  };
}
function onSessionDown(e: MapLayerMouseEvent): void {
  if (!session) return;
  const id = handleAt(e.point);
  if (id === null) return;
  // the handle moves, the map does not
  e.preventDefault();
  grabbed = { id, last: null };
  map.dragPan.disable();
  window.addEventListener('mouseup', onWindowUp);
}
function onSessionMove(e: MapLayerMouseEvent): void {
  if (!session || !proj) return;
  const local = proj.toLocal(e.lngLat.lng, e.lngLat.lat);
  if (grabbed) {
    grabbed.last = local;
    session.onDrag?.(grabbed.id, local);
    return;
  }
  map.getCanvas().style.cursor = handleAt(e.point) === null ? 'crosshair' : 'grab';
  session.onMove?.(local);
}
```

Wire it in `map.on('load', ...)`, before the existing `mousemove` registration:

```ts
map.on('mousedown', onSessionDown);
map.on('mouseup', () => {
  endGrab();
});
map.on('mouseout', () => {
  if (session && !grabbed) session.onMove?.(null);
});
```

and make the existing `mousemove` handler hand over first (`if (session) { onSessionMove(e); return; }` as its first line). At the top of `onClick`, after the `picking` branch:

```ts
if (session) {
  // a session takes every click; a drag of a handle never reaches here (MapLibre sends no
  // click after a press that moved)
  if (proj) session.onClick?.(proj.toLocal(e.lngLat.lng, e.lngLat.lat));
  return;
}
```

`pickPoint` calls `stopSession()` first and `pointerSession` calls `disarmPick()` first (one owner of the pointer at a time). In `dispose`, call `stopSession()` next to `disarmPick()`. Return `pointerSession` from the controller object.

In `MapView.tsx` add the prop (doc: "A live pointer session (`MapController.pointerSession`), kept while set; keep its identity stable: a new object starts a new session.") and the effect:

```ts
useEffect(() => {
  const ctl = ctlRef.current;
  if (!pointer || !ctl) return;
  return ctl.pointerSession(pointer);
}, [pointer, started]);
```

`index.ts:66`: `export type { IssueColorBy, MapController, MapPointerSession } from './controller';`

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm --filter @aio/maps exec vitest run src/controller.test.ts`, then `pnpm --filter @aio/maps test` and `pnpm --filter @aio/maps typecheck`.
Expected: PASS, including the existing pick and dispose tests.

- [ ] **Step 5: Commit**

```bash
git add packages/maps/src/controller.ts packages/maps/src/controller.test.ts packages/maps/src/MapView.tsx packages/maps/src/index.ts
git commit -m "feat(maps): a live pointer session with hover, clicks and draggable handles" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Path readiness and the 3D surface (`placeModel.ts`)

**Files:**

- Modify: `apps/desktop/src/renderer/walks/placeModel.ts` (`PlaceSurface` `:14`, `placeSurfaces` `:37`, `surfaceKey` `:56`, `rememberedSurface` `:61`)
- Modify (type fix only): `apps/desktop/src/renderer/walks/PlaceWalkStrip.tsx:66` (`surfaceName`), `apps/desktop/src/renderer/walks/placeWalk.ts` `openSurface` (`:745-754`)
- Test: `apps/desktop/src/renderer/walks/placeModel.test.ts`

`PlaceStep` and `firstStep` stay untouched here; T5 changes them.

**Interfaces:**

- Produces:

```ts
export type PlaceSurface =
  { kind: 'drawing'; id: string; name: string; dated: boolean } | { kind: 'map' } | { kind: '3d' };
export const MAP_SURFACE: PlaceSurface; // { kind: 'map' }
export const SCENE_SURFACE: PlaceSurface; // { kind: '3d' }
export type WalkPathState = 'ready' | 'none' | 'running' | 'failed' | 'interrupted';
export function rawUsable(raw: WalkRawPath | null): boolean;
export function walkPathState(
  layer: Pick<WalkLayer, 'path'>,
  job: Pick<JobRecord, 'status'> | undefined,
  raw?: WalkRawPath | null,
): WalkPathState;
export function placeSurfaces(m, walk, hasCrs): PlaceSurface[]; // 3D always, last
export function surfaceKey(s: PlaceSurface): string; // '@model' for map and 3d
export function rememberedSurface(
  walk: WalkLayer,
  surfaces: readonly PlaceSurface[],
  modelOn?: 'map' | '3d',
): PlaceSurface | null;
export function surfaceLabel(s: PlaceSurface): string; // drawing name, 'Map', '3D view'
```

- [ ] **Step 1: Write the failing tests** (add to `placeModel.test.ts`; update the two existing `placeSurfaces` expectations to end with `{ kind: '3d' }`)

```ts
describe('the 3D view as a surface', () => {
  it('is always offered, last; the map only with a CRS', () => {
    const m = manifestWith([]); // the file's existing helper, no drawings
    expect(placeSurfaces(m, walk(), false)).toEqual([{ kind: '3d' }]);
    expect(placeSurfaces(m, walk(), true)).toEqual([{ kind: 'map' }, { kind: '3d' }]);
    expect(surfaceKey({ kind: '3d' })).toBe('@model');
    expect(surfaceLabel({ kind: '3d' })).toBe('3D view');
  });

  it('a walk placed on the model reopens where the stage shows it', () => {
    const w = walk({
      place: { pins: [], yawOffsetDeg: 0, heightM: 1.7, quality: 'good', placedOn: '@model' },
    });
    const both = [{ kind: 'map' }, { kind: '3d' }] as const;
    expect(rememberedSurface(w, both, 'map')).toEqual({ kind: 'map' });
    expect(rememberedSurface(w, both, '3d')).toEqual({ kind: '3d' });
    // no map in this project: 3D even when asked for the map
    expect(rememberedSurface(w, [{ kind: '3d' }], 'map')).toEqual({ kind: '3d' });
  });

  it('a walk placed on a drawing that is gone has no remembered surface', () => {
    const w = walk({
      place: { pins: [], yawOffsetDeg: 0, heightM: 1.7, quality: 'good', placedOn: 'sheet-gone' },
    });
    expect(rememberedSurface(w, [{ kind: '3d' }])).toBeNull();
  });
});

describe('walkPathState', () => {
  const path = { raw: { path: 'walks/a/raw-path.json' } };
  const sfm = raw; // the file's synthetic raw path (add the same loader placeStore.test.ts uses)

  it('ready with a path and a usable raw path, even while a newer job runs', () => {
    expect(walkPathState({ path }, undefined, sfm)).toBe('ready');
    expect(walkPathState({ path }, { status: 'running' }, sfm)).toBe('ready');
    // the raw path not read yet: the layer's path is enough
    expect(walkPathState({ path }, undefined)).toBe('ready');
  });

  it('a path that is pins-only or unreadable counts as failed', () => {
    expect(walkPathState({ path }, undefined, { ...sfm, source: 'pins-only' })).toBe('failed');
    expect(walkPathState({ path }, undefined, null)).toBe('failed');
  });

  it('no path: running, interrupted (or cancelled), failed or none from the job', () => {
    for (const s of ['starting', 'running', 'cancelling'] as const)
      expect(walkPathState({}, { status: s })).toBe('running');
    expect(walkPathState({}, { status: 'interrupted' })).toBe('interrupted');
    expect(walkPathState({}, { status: 'cancelled' })).toBe('interrupted');
    expect(walkPathState({}, { status: 'failed' })).toBe('failed');
    expect(walkPathState({}, { status: 'done' })).toBe('none');
    expect(walkPathState({}, undefined)).toBe('none');
  });

  it('rawUsable needs an sfm path with two registered stills', () => {
    expect(rawUsable(sfm)).toBe(true);
    expect(rawUsable(null)).toBe(false);
    expect(rawUsable({ ...sfm, stills: sfm.stills.map(({ pos: _p, ...s }) => s) })).toBe(false);
  });
});
```

(Use the file's own `walk()` and manifest helpers; add `rawUsable`, `surfaceLabel`, `walkPathState` to its imports.)

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm --filter @aio/desktop exec vitest run src/renderer/walks/placeModel.test.ts`
Expected: FAIL (`walkPathState` is not exported; `placeSurfaces` has no 3D).

- [ ] **Step 3: Write the implementation**

```ts
import type { Capture, JobRecord, ProjectManifest, WalkLayer, WalkRawPath } from '@aio/schema';

/** What a walk can be placed on: a drawing (a plan raster), the map or the 3D view (the model frame). */
export type PlaceSurface =
  { kind: 'drawing'; id: string; name: string; dated: boolean } | { kind: 'map' } | { kind: '3d' };

export const MAP_SURFACE: PlaceSurface = { kind: 'map' };
export const SCENE_SURFACE: PlaceSurface = { kind: '3d' };

// placeSurfaces: the drawings of the walk's date, the undated drawings, the map (with a CRS),
// then the 3D view, always
return [...dated, ...undated, ...(hasCrs ? [MAP_SURFACE] : []), SCENE_SURFACE];

/** The key a surface is remembered by (`placedOn`): the drawing's layer id, or `@model`. */
export function surfaceKey(s: PlaceSurface): string {
  return s.kind === 'drawing' ? s.id : MODEL_SURFACE;
}

/** How the Place on select names a surface. */
export function surfaceLabel(s: PlaceSurface): string {
  return s.kind === 'drawing' ? s.name : s.kind === 'map' ? 'Map' : '3D view';
}

/**
 * The surface the walk was last placed on, when the picker still lists it. A walk placed on the
 * model (`@model`) reopens on `modelOn` (the map when the stage shows the map), else the other.
 */
export function rememberedSurface(
  walk: WalkLayer,
  surfaces: readonly PlaceSurface[],
  modelOn: 'map' | '3d' = '3d',
): PlaceSurface | null {
  const key = walk.place?.placedOn;
  if (key === undefined) return null;
  if (key === MODEL_SURFACE)
    return (
      surfaces.find((s) => s.kind === modelOn) ??
      surfaces.find((s) => s.kind === 'map' || s.kind === '3d') ??
      null
    );
  return surfaces.find((s) => surfaceKey(s) === key) ?? null;
}

/** Where a walk's computed path stands, for the Place walk notice. */
export type WalkPathState = 'ready' | 'none' | 'running' | 'failed' | 'interrupted';

/** A raw path the shape can be read from: from a reconstruction, two registered stills or more. */
export function rawUsable(raw: WalkRawPath | null): boolean {
  return raw !== null && raw.source !== 'pins-only' && raw.stills.filter((s) => s.pos).length >= 2;
}

const RUNNING: ReadonlySet<JobRecord['status']> = new Set(['starting', 'running', 'cancelling']);

/**
 * The walk's path: ready when the layer names one and its raw path (when read) is usable; else
 * what its newest `walk.process` job says. A path that is there but unusable reads as failed.
 */
export function walkPathState(
  layer: Pick<WalkLayer, 'path'>,
  job: Pick<JobRecord, 'status'> | undefined,
  raw?: WalkRawPath | null,
): WalkPathState {
  if (layer.path && (raw === undefined || rawUsable(raw))) return 'ready';
  if (job && RUNNING.has(job.status)) return 'running';
  if (job?.status === 'interrupted' || job?.status === 'cancelled') return 'interrupted';
  if (layer.path || job?.status === 'failed') return 'failed';
  return 'none';
}
```

Type fixes so the app keeps compiling (T8 and T9 replace these lines later):

- `PlaceWalkStrip.tsx:66`: `const surfaceName = surfaceLabel;` (import `surfaceLabel`).
- `placeWalk.ts` `openSurface`: replace the `host.kind === 'map'` ternary with `host.kind === 'drawing' ? { ...sides, [other]: 'raster' as const, raster: host.id } : { ...sides, [other]: host.kind }`.
- `placeStore.ts` is not touched here (`s.kind === 'map'` still compiles; T5 extends it to 3D).

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm --filter @aio/desktop exec vitest run src/renderer/walks/placeModel.test.ts src/renderer/walks/placeWalk.test.ts src/renderer/walks/PlaceWalkStrip.test.tsx` and `pnpm --filter @aio/desktop typecheck`.
Expected: PASS. If a `PlaceWalkStrip` or `placeWalk` test listed the surfaces exactly, add `{ kind: '3d' }` at the end of its expectation.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/walks/placeModel.ts apps/desktop/src/renderer/walks/placeModel.test.ts apps/desktop/src/renderer/walks/PlaceWalkStrip.tsx apps/desktop/src/renderer/walks/placeWalk.ts
git commit -m "feat(walks): the walk's path state and the 3D view as a place surface" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(Add any test file you had to adjust in Step 4 to the `git add` list by path.)

---

### Task 4: Surface overlays: preview line, Start and End handles, raster hover

**Files:**

- Modify: `apps/desktop/src/renderer/walks/walkOverlay.ts` (`WalkDrawing` `:13`, `walkPinPoints` `:86`, `walkDrawingsForSheet` `:143`)
- Modify: `apps/desktop/src/renderer/walks/WalkSheetOverlay.tsx`
- Modify: `apps/desktop/src/renderer/walks/walkMapOverlay.ts` (pin features `:198-205`, pin style `:130-160`)
- Modify: `apps/desktop/src/renderer/workspace/RasterPane.tsx` (`RasterPick` `:36-45`, pointer handlers `:285-341`)
- Tests: `walkOverlay.test.ts`, `WalkSheetOverlay.test.tsx`, `walkMapOverlay.test.ts` (same folder)

**Interfaces:**

- Consumes: nothing new (`toSheet` `walkOverlay.ts:57`, `SheetPx`).
- Produces:

```ts
// walkOverlay.ts
export type PinRole = 'start' | 'end' | 'pin';
// walkPinPoints(fit) entries gain `role: PinRole` (first by time 'start', last 'end' when there are
// two or more, else 'pin'); WalkDrawing['pins'] entries gain `role: PinRole`.
export interface SheetPreview {
  pts: SheetPx[];
  ghost: boolean;
  tooClose: boolean;
}
export function previewOnSheet(
  xz: readonly XZ[],
  frame: SurfaceFrame,
  ghost: boolean,
  tooClose: boolean,
): SheetPreview;
// WalkSheetOverlay props gain: preview?: SheetPreview | null;
// onPinDrag / onPinDragEnd gain the role: (layerId, i, px, role: PinRole) => void
// walkMapOverlay.ts
export const walkPreviewOverlayId: (layerId: string) => string; // `walk-${id}-preview`
export function walkPreviewMapOverlay(
  layerId: string,
  xz: readonly XZ[],
  proj: { toLonLat(v: Vec3): [number, number] },
  colour: string,
  ghost: boolean,
  tooClose: boolean,
): MapOverlay | null; // null with fewer than two points; style cached per colour and look
// pin features gain `role` (string property)
// RasterPane.tsx RasterPick gains:
//   onHover?: ((px: [number, number] | null) => void) | undefined;
```

- [ ] **Step 1: Write the failing tests**

The names `fitWith`, `pinAt`, `drawingWith`, `drag`, `render`, `container` and `placingWalk` below stand for the helpers these test files already have (or small ones you add beside them: a fit from `@model` pins through `fitWalk(null, ...)`, a `WalkDrawing` with given pins, a press, move and release on an element).

`walkOverlay.test.ts`:

```ts
it('names the first pin Start and the last End; inner pins stay pins', () => {
  const fit = fitWith([pinAt(4, [0, 0]), pinAt(30, [20, 0]), pinAt(62, [40, -30])]); // file helpers
  expect(walkPinPoints(fit).map((p) => p.role)).toEqual(['start', 'pin', 'end']);
  expect(walkPinPoints(fitWith([pinAt(4, [0, 0])])).map((p) => p.role)).toEqual(['start']);
});

it('puts the preview on the sheet in picture px', () => {
  const frame = surfaceFrameFromCorners(
    { tl: [-40, 0, -20], tr: [40, 0, -20], bl: [-40, 0, 20] },
    [400, 200],
    false,
  );
  const p = previewOnSheet(
    [
      [0, 0],
      [40, -20],
    ],
    frame,
    true,
    false,
  );
  expect(p.pts[0]?.[0]).toBeCloseTo(200);
  expect(p.pts[0]?.[1]).toBeCloseTo(100);
  expect(p.pts[1]?.[1]).toBeCloseTo(0);
  expect(p.ghost).toBe(true);
});
```

`WalkSheetOverlay.test.tsx`:

```ts
it('draws Start and End as handles and passes the role on a drag', () => {
  const onPinDrag = vi.fn();
  render(
    <WalkSheetOverlay
      drawings={[drawingWith([{ at: [10, 10], n: 1, index: 0, active: true, role: 'start' }, { at: [90, 10], n: 2, index: 1, active: true, role: 'end' }])]}
      scale={1}
      toImage={() => [95, 12]}
      onPinDrag={onPinDrag}
    />,
  );
  const end = container.querySelector('[data-testid="walk-handle-end"]');
  expect(container.querySelector('[data-testid="walk-handle-start"]')).not.toBeNull();
  expect(end?.querySelector('title')?.textContent).toBe('End');
  // press, move, release (the file's pointer helpers)
  drag(end, [95, 12]);
  expect(onPinDrag).toHaveBeenCalledWith('walk-a', 1, [95, 12], 'end');
});

it('draws the preview faint and dashed as a ghost, and marks a spot too close', () => {
  render(<WalkSheetOverlay drawings={[]} scale={1} preview={{ pts: [[0, 0], [10, 0]], ghost: true, tooClose: false }} />);
  const p = container.querySelector('[data-testid="walk-preview"]');
  expect(p?.getAttribute('data-ghost')).toBe('true');
  render(<WalkSheetOverlay drawings={[]} scale={1} preview={{ pts: [[0, 0], [10, 0]], ghost: false, tooClose: true }} />);
  expect(container.querySelector('[data-testid="walk-preview"]')?.getAttribute('data-too-close')).toBe('true');
});
```

`walkMapOverlay.test.ts`:

```ts
it('the preview is its own overlay; its style stays the same object across hovers', () => {
  const a = walkPreviewMapOverlay(
    'walk-a',
    [
      [0, 0],
      [10, 0],
    ],
    proj,
    '#3366ff',
    false,
    false,
  );
  const b = walkPreviewMapOverlay(
    'walk-a',
    [
      [0, 0],
      [12, 1],
    ],
    proj,
    '#3366ff',
    false,
    false,
  );
  expect(a?.id).toBe('walk-walk-a-preview');
  expect(a?.layers).toBe(b?.layers);
  expect(a?.data).not.toBe(b?.data);
  expect(walkPreviewMapOverlay('walk-a', [[0, 0]], proj, '#3366ff', true, false)).toBeNull();
});

it('pins carry their role', () => {
  const [ov] = walkMapOverlays([placingWalk], proj, () => '#3366ff', { placingId: 'walk-a' });
  const roles = (ov?.data.features ?? [])
    .filter((f) => f.properties?.kind === 'pin')
    .map((f) => f.properties?.role);
  expect(roles[0]).toBe('start');
  expect(roles.at(-1)).toBe('end');
});
```

Add a `RasterPane` hover test only if a `RasterPane.test.tsx` exists; otherwise the hover is covered by the drawing e2e (T11). (Check with `ls apps/desktop/src/renderer/workspace/RasterPane*`.)

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm --filter @aio/desktop exec vitest run src/renderer/walks/walkOverlay.test.ts src/renderer/walks/WalkSheetOverlay.test.tsx src/renderer/walks/walkMapOverlay.test.ts`
Expected: FAIL (no `role`, no `previewOnSheet`, no `walkPreviewMapOverlay`).

- [ ] **Step 3: Write the implementation**

`walkOverlay.ts`:

```ts
export type PinRole = 'start' | 'end' | 'pin';

export function walkPinPoints(
  fit: WalkFit,
): { xz: XZ; n: number; index: number; active: boolean; role: PinRole }[] {
  const out: { xz: XZ; n: number; index: number; active: boolean; role: PinRole }[] = [];
  const last = fit.pins.length - 1;
  fit.pins.forEach((p, k) => {
    const xz = p.active ? p.target : (fit.at(p.t)?.xz ?? null);
    const role: PinRole = k === 0 ? 'start' : k === last ? 'end' : 'pin';
    if (xz) out.push({ xz, n: k + 1, index: p.index, active: p.active, role });
  });
  return out;
}

/** The shape being placed, on a drawing: in picture px. */
export interface SheetPreview {
  pts: SheetPx[];
  ghost: boolean;
  tooClose: boolean;
}

export function previewOnSheet(
  xz: readonly XZ[],
  frame: SurfaceFrame,
  ghost: boolean,
  tooClose: boolean,
): SheetPreview {
  const pts = xz.map((p) => toSheet(frame, p)).filter((p) => p.every(Number.isFinite));
  return { pts, ghost, tooClose };
}
```

and carry `role: p.role` into `WalkDrawing['pins']` in `walkDrawingsForSheet`.

`WalkSheetOverlay.tsx`:

- New prop `preview?: SheetPreview | null`. Draw it right after `{paths}`:

```tsx
{
  preview && preview.pts.length > 1 && (
    <path
      className="walk-line walk-preview"
      data-testid="walk-preview"
      data-ghost={preview.ghost ? 'true' : 'false'}
      data-too-close={preview.tooClose ? 'true' : 'false'}
      d={pathOf(preview.pts)}
      stroke="var(--acc)"
      strokeWidth={LINE_PX}
      vectorEffect="non-scaling-stroke"
      opacity={preview.ghost ? GHOST_OPACITY : undefined}
      {...(preview.ghost || preview.tooClose ? { strokeDasharray: DASH } : {})}
    />
  );
}
```

with `const GHOST_OPACITY = 0.45;`.

- Pins: `role !== 'pin'` draws a handle: same `<g>` and drag handlers, `data-testid={`walk-handle-${p.role}`}`, class `walk-pin walk-handle ${p.role}`, `<title>{p.role === 'start' ? 'Start' : 'End'}</title>`, a `<circle r={PIN_R} />` and no number. Start is hollow, End filled (CSS in `walkOverlay.css`: `.walk-handle.start circle { fill: var(--bg-0); stroke: currentColor; stroke-width: 3px; }`). `walk-pin` stays the test id of inner pins.
- `onPinDrag` / `onPinDragEnd` take a fourth argument, the role; `pinHandlers(layer, index, role)` passes it through.

`walkMapOverlay.ts`: add `role: p.role` to the pin feature properties; in the pin style set `'circle-color': ['case', ['==', ['get', 'role'], 'start'], MAP_INK.bg0, ['get', 'active'], colour, MAP_INK.bg0]` and filter the number label to `['all', ['==', ['get', 'kind'], 'pin'], ['==', ['get', 'role'], 'pin']]`. Then:

```ts
export const walkPreviewOverlayId = (layerId: string): string => `walk-${layerId}-preview`;

const previewStyles = new Map<string, OverlayLayer[]>();

/** The style of the shape being placed, one array per colour and look (data changes only). */
function previewStyle(colour: string, ghost: boolean, tooClose: boolean): OverlayLayer[] {
  const key = `${colour}|${String(ghost)}|${String(tooClose)}`;
  let out = previewStyles.get(key);
  if (!out) {
    out = [
      {
        id: 'preview',
        type: 'line',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': colour,
          'line-width': 2,
          'line-opacity': ghost ? 0.45 : 1,
          ...(ghost || tooClose ? { 'line-dasharray': [2, 2] } : {}),
        },
        above: true,
      },
    ];
    previewStyles.set(key, out);
  }
  return out;
}

/** The shape being placed on the map (ghost or live), or null with fewer than two points. */
export function walkPreviewMapOverlay(
  layerId: string,
  xz: readonly XZ[],
  proj: { toLonLat(v: Vec3): [number, number] },
  colour: string,
  ghost: boolean,
  tooClose: boolean,
): MapOverlay | null {
  if (xz.length < 2) return null;
  const data: FeatureCollection = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { kind: 'preview' },
        geometry: {
          type: 'LineString',
          coordinates: xz.map((p) => proj.toLonLat([p[0], 0, p[1]])),
        },
      },
    ],
  };
  return { id: walkPreviewOverlayId(layerId), data, layers: previewStyle(colour, ghost, tooClose) };
}
```

`RasterPane.tsx`: add to `RasterPick`

```ts
  /** The pixel under the pointer while it moves over the picture without a press; null when it leaves. */
  onHover?: ((px: [number, number] | null) => void) | undefined;
```

In `onPointerMove`, before `const d = drag.current; if (d?.id !== e.pointerId) return;`, report a hover when no press is held:

```ts
if (!drag.current && pick?.onHover && src && view) {
  const r = e.currentTarget.getBoundingClientRect();
  const x = (e.clientX - r.left - view.x) / view.scale;
  const y = (e.clientY - r.top - view.y) / view.scale;
  const inside = x >= 0 && y >= 0 && x <= src.size.width && y <= src.size.height;
  pick.onHover(inside ? [x, y] : null);
}
```

and add `onPointerLeave={() => pick?.onHover?.(null)}` on the same element.

Update the existing callers of `onPinDrag` in `PlaceWalkStrip.tsx` only if TypeScript asks (an extra parameter is assignable, so it should not).

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm --filter @aio/desktop exec vitest run src/renderer/walks/walkOverlay.test.ts src/renderer/walks/WalkSheetOverlay.test.tsx src/renderer/walks/walkMapOverlay.test.ts` and `pnpm --filter @aio/desktop typecheck`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/walks/walkOverlay.ts apps/desktop/src/renderer/walks/walkOverlay.test.ts apps/desktop/src/renderer/walks/WalkSheetOverlay.tsx apps/desktop/src/renderer/walks/WalkSheetOverlay.test.tsx apps/desktop/src/renderer/walks/walkOverlay.css apps/desktop/src/renderer/walks/walkMapOverlay.ts apps/desktop/src/renderer/walks/walkMapOverlay.test.ts apps/desktop/src/renderer/workspace/RasterPane.tsx
git commit -m "feat(walks): preview line, Start and End handles on drawings and the map, raster hover" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The placing session (`placeStore.ts`)

**Files:**

- Modify: `apps/desktop/src/renderer/walks/placeStore.ts` (rewrite of the step logic; fine-tune actions kept)
- Modify: `apps/desktop/src/renderer/walks/placeModel.ts` (`PlaceStep` `:11`; delete `firstStep` `:99-102`)
- Test: `apps/desktop/src/renderer/walks/placeStore.test.ts` (rewrite), `placeModel.test.ts` (delete the `firstStep` describe `:134-139` and its import)

**Interfaces:**

- Consumes: T1 `walkOutline`, `previewPath`, `ghostPath`, `ghostLengthM`, `WalkOutline`, `MIN_PIN_SPAN_M` (`@aio/geo`); T3 `PlaceSurface` with `3d`.
- Produces:

```ts
// placeModel.ts
export type PlaceStep = 'check' | 'start' | 'end' | 'placed' | 'fine-tune';
// placeStore.ts
export type PlaceArmed = 'pin' | 'move' | 'align-360' | 'align-surface' | null;
export type PlaceHandle = 'start' | 'end';
export interface PlacePreview {
  /** Model x/z of the shape: the ghost before the start, laid between start and cursor after it. */
  xz: XZ[];
  ghost: boolean;
  /** The cursor is closer than 5 m to the start: an end click there is ignored. */
  tooClose: boolean;
  /** Ground heights at the shape's first and last point (map and 3D), when known. */
  y: [number, number] | null;
}
export interface PlaceStartOptions {
  raw?: WalkRawPath | null;
  drawings?: DrawingLookup;
  orientation?: readonly Float64Array[] | null;
  /** The path is ready (`walkPathState` 'ready'); default: the raw path is usable. */
  ready?: boolean;
}
export interface PlaceState {
  layerId: string | null;
  step: PlaceStep;
  surface: PlaceSurface | null;
  pins: WalkPin[];
  yawOffsetDeg: number;
  armed: PlaceArmed;
  moving: number | null;
  timeS: number;
  dirty: boolean;
  error: string | null;
  align: { yawRad: number; t: number } | null;
  fit: WalkFit | null;
  preview: PlacePreview | null;
  dragging: { handle: PlaceHandle; refused: boolean } | null;
  start(walk: WalkLayer, m: ProjectManifest, opts?: PlaceStartOptions): void;
  setInputs(
    raw: WalkRawPath | null,
    orientation: readonly Float64Array[] | null,
    ready: boolean,
  ): void;
  placeAnyway(): void;
  setDate(captureId: string): void;
  chooseSurface(s: PlaceSurface): void;
  setTime(t: number): void;
  hover(at: [number, number] | null, y?: number): void;
  click(at: [number, number], y?: number): void;
  dragHandle(h: PlaceHandle, at: [number, number], y?: number): void;
  endDrag(): void;
  setFineTune(on: boolean): void;
  pinHere(): void;
  movePin(i: number, at: [number, number], y?: number): void;
  armMove(i: number): void;
  removePin(i: number): void;
  armAlign(): void;
  align360(yawRad: number): void;
  setYaw(deg: number): void;
  calibration(): WalkCalibration;
  cancel(): void;
}
export const DRAWING_NOT_READY: string; // unchanged
export const MAX_PINS_ERROR: string; // unchanged
export function wrapDeg(deg: number): number; // unchanged
```

- [ ] **Step 1: Write the failing tests** (`placeStore.test.ts`; keep the file's fixture loading, `TRUTH` and orientation rows; keep the `wrapDeg`, Align view, Heading, `armMove`, `removePin`, `DRAWING_NOT_READY` and `calibration` tests, reaching fine-tune through `placeTwo()` below instead of the old `correct` step)

```ts
const DEG = Math.PI / 180;
/** Model x/z of the synthetic walk at t, from its own raw stills through the inverse truth. */
function modelAt(t: number): [number, number] {
  const reg = raw.stills.filter((s) => s.pos);
  let i = 0;
  while (i + 1 < reg.length && (reg[i + 1]?.t ?? Infinity) <= t) i++;
  const p = reg[i]?.pos ?? [0, 0, 0];
  const a = TRUTH.rotDeg * DEG;
  const x = (p[0] - TRUTH.shift[0]) / TRUTH.scale;
  const z = (p[2] - TRUTH.shift[2]) / TRUTH.scale;
  return [Math.cos(a) * x - Math.sin(a) * z, Math.sin(a) * x + Math.cos(a) * z];
}

function session(
  opts: { raw?: WalkRawPath | null; ready?: boolean; layer?: Partial<WalkLayer> } = {},
) {
  const store = createPlaceStore({ fit: fitWalk, seek: vi.fn() });
  const w = walkLayer(opts.layer); // the file's existing helper
  store.getState().start(w, manifest, {
    raw: opts.raw === undefined ? raw : opts.raw,
    ...(opts.ready === undefined ? {} : { ready: opts.ready }),
  });
  return store;
}

/** Start and end clicked on the 3D view at the truth: the walk is placed. */
function placeTwo() {
  const s = session();
  s.getState().chooseSurface({ kind: '3d' });
  s.getState().click(modelAt(4), 0);
  s.getState().click(modelAt(62), 0);
  return s;
}

describe('start and end', () => {
  it('opens on Start for a walk with a usable path', () => {
    const s = session();
    s.getState().chooseSurface({ kind: '3d' });
    expect(s.getState().step).toBe('start');
  });

  it('opens on the path check without a usable path; Place anyway goes on to Start', () => {
    const s = session({ raw: null, ready: false });
    s.getState().chooseSurface({ kind: 'map' });
    expect(s.getState().step).toBe('check');
    s.getState().click([0, 0]);
    expect(s.getState().pins).toHaveLength(0);
    s.getState().placeAnyway();
    expect(s.getState().step).toBe('start');
  });

  it('before the start a ghost of the whole shape follows the cursor, its first point under it', () => {
    const s = session();
    s.getState().chooseSurface({ kind: '3d' });
    s.getState().hover([10, 20], 1.5);
    const p = s.getState().preview;
    expect(p?.ghost).toBe(true);
    expect(p?.xz[0]).toEqual([10, 20]);
    expect(p?.y).toEqual([1.5, 1.5]);
    s.getState().hover(null);
    expect(s.getState().preview).toBeNull();
  });

  it('the start click sets a pin at walking.startT; the shape then runs from it to the cursor', () => {
    const s = session();
    s.getState().chooseSurface({ kind: '3d' });
    s.getState().click(modelAt(4), 2);
    expect(s.getState().step).toBe('end');
    expect(s.getState().pins[0]).toMatchObject({ t: 4, surface: '@model', y: 2 });
    s.getState().hover(modelAt(62), 3);
    const p = s.getState().preview;
    expect(p?.ghost).toBe(false);
    expect(p?.tooClose).toBe(false);
    expect(p?.y).toEqual([2, 3]);
    const last = p?.xz.at(-1);
    const end = modelAt(62);
    expect(Math.hypot((last?.[0] ?? 0) - end[0], (last?.[1] ?? 0) - end[1])).toBeLessThan(0.5);
  });

  it('an end closer than 5 m is flagged while hovering and its click is ignored', () => {
    const s = session();
    s.getState().chooseSurface({ kind: '3d' });
    const a = modelAt(4);
    s.getState().click(a);
    s.getState().hover([a[0] + 3, a[1]]);
    expect(s.getState().preview?.tooClose).toBe(true);
    s.getState().click([a[0] + 3, a[1]]);
    expect(s.getState().step).toBe('end');
    expect(s.getState().pins).toHaveLength(1);
    expect(s.getState().error).toBeNull();
  });

  it('the end click places the walk: pins at 4 s and 62 s, the corner where the walk turned', () => {
    const s = placeTwo();
    expect(s.getState().step).toBe('placed');
    expect(s.getState().pins.map((p) => p.t)).toEqual([4, 62]);
    expect(s.getState().preview).toBeNull();
    const c = s.getState().fit?.at(37.5)?.xz;
    const truth = modelAt(37.5);
    expect(Math.hypot((c?.[0] ?? 0) - truth[0], (c?.[1] ?? 0) - truth[1])).toBeLessThan(0.5);
  });

  it('without walking times the pins sit at 0 and the walk length', () => {
    const { walking: _w, ...rest } = raw;
    const s = session({ raw: rest });
    s.getState().chooseSurface({ kind: '3d' });
    s.getState().click([0, 0]);
    s.getState().click([40, -30]);
    expect(s.getState().pins.map((p) => p.t)).toEqual([0, walkLayer().durationS]);
  });

  it('placed anyway without a path: no ghost, a straight two point preview', () => {
    const s = session({ raw: null, ready: false });
    s.getState().chooseSurface({ kind: '3d' });
    s.getState().placeAnyway();
    s.getState().hover([1, 1]);
    expect(s.getState().preview).toBeNull();
    s.getState().click([0, 0]);
    s.getState().hover([20, 0]);
    expect(s.getState().preview?.xz).toEqual([
      [0, 0],
      [20, 0],
    ]);
  });
});

describe('handles', () => {
  it('dragging End refits live; a spot within 5 m of Start is refused and the handle stays', () => {
    const s = placeTwo();
    const before = s.getState().pins[1]?.at;
    s.getState().dragHandle('end', [45, -30], 0);
    expect(s.getState().pins[1]?.at).toEqual([45, -30]);
    expect(s.getState().pins[1]?.t).toBe(62);
    expect(s.getState().dragging).toEqual({ handle: 'end', refused: false });
    const start = s.getState().pins[0]?.at ?? [0, 0];
    s.getState().dragHandle('end', [start[0] + 1, start[1]], 0);
    expect(s.getState().pins[1]?.at).toEqual([45, -30]);
    expect(s.getState().dragging?.refused).toBe(true);
    s.getState().endDrag();
    expect(s.getState().dragging).toBeNull();
    expect(before).not.toEqual([45, -30]);
  });

  it('handles do nothing before the walk is placed', () => {
    const s = session();
    s.getState().chooseSurface({ kind: '3d' });
    s.getState().dragHandle('start', [1, 1]);
    expect(s.getState().pins).toHaveLength(0);
  });
});

describe('fine-tune', () => {
  it('turns on and off from placed; Pin here works only while on', () => {
    const s = placeTwo();
    s.getState().pinHere();
    expect(s.getState().armed).toBeNull();
    s.getState().setFineTune(true);
    expect(s.getState().step).toBe('fine-tune');
    s.getState().setTime(30);
    s.getState().pinHere();
    expect(s.getState().armed).toBe('pin');
    s.getState().click(modelAt(30), 0);
    expect(s.getState().pins.map((p) => p.t)).toEqual([4, 30, 62]);
    s.getState().setFineTune(false);
    expect(s.getState().step).toBe('placed');
    expect(s.getState().armed).toBeNull();
  });
});

describe('the path appears or goes', () => {
  it('a path read while on the check moves on to Start', () => {
    const s = session({ raw: null, ready: false });
    s.getState().chooseSurface({ kind: '3d' });
    s.getState().setInputs(raw, null, true);
    expect(s.getState().step).toBe('start');
  });

  it('a path that goes drops the draft and shows the check', () => {
    const s = placeTwo();
    s.getState().setInputs(null, null, false);
    expect(s.getState().step).toBe('check');
    expect(s.getState().pins).toHaveLength(0);
    expect(s.getState().dirty).toBe(false);
  });

  it('a walk placed before (two saved pins) opens on placed, whatever the path', () => {
    const pins = [
      { t: 4, surface: '@model', at: [0, 0] },
      { t: 62, surface: '@model', at: [40, -30] },
    ] as WalkPin[];
    const s = session({
      raw: null,
      ready: false,
      layer: {
        place: { pins, yawOffsetDeg: 0, heightM: 1.7, quality: 'good', placedOn: '@model' },
      },
    });
    s.getState().chooseSurface({ kind: '3d' });
    expect(s.getState().step).toBe('placed');
  });
});

it('a 3D pin keeps its height and saves on @model', () => {
  const s = placeTwo();
  expect(s.getState().calibration()).toMatchObject({
    placedOn: '@model',
    pins: [{ y: 0 }, { y: 0 }],
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm --filter @aio/desktop exec vitest run src/renderer/walks/placeStore.test.ts`
Expected: FAIL (`hover`, `dragHandle`, `setFineTune`, `placeAnyway`, `setInputs` missing; steps differ).

- [ ] **Step 3: Write the implementation**

`placeModel.ts`: `export type PlaceStep = 'check' | 'start' | 'end' | 'placed' | 'fine-tune';` and delete `firstStep`.

`placeStore.ts`, the changed parts (everything not shown keeps today's code, with `'correct'` read as `'fine-tune'`):

```ts
import {
  ghostLengthM,
  ghostPath,
  MIN_PIN_SPAN_M,
  pinTarget,
  previewPath,
  walkHeadingAt,
  walkOutline,
  walkQuality,
  type fitWalk,
  type WalkFit,
  type WalkOutline,
  type WalkSurfaces,
  type XZ,
} from '@aio/geo';

/** The ghost's length on a drawing whose scale is provisional: this share of its width. */
const PROVISIONAL_GHOST = 0.3;

const idle = {
  layerId: null,
  step: 'start' as PlaceStep,
  surface: null,
  pins: [] as WalkPin[],
  yawOffsetDeg: 0,
  armed: null as PlaceArmed,
  moving: null as number | null,
  timeS: 0,
  dirty: false,
  error: null,
  align: null,
  fit: null,
  preview: null as PlacePreview | null,
  dragging: null as PlaceState['dragging'],
};

export function createPlaceStore(deps: { fit: typeof fitWalk; seek: (t: number) => void }) {
  let walk: WalkLayer | null = null;
  let raw: WalkRawPath | null = null;
  let outline: WalkOutline | null = null;
  let frames: WalkSurfaces = { drawing: () => null };
  let lookup: DrawingLookup = () => undefined;
  let orientation: readonly Float64Array[] | null = null;
  let armedT = 0;

  return createStore<PlaceState>()((set, get) => {
    // fitOf, setPins, startT, endT, jump: as today

    /** The step the pins call for: Start with none, End with one, else placed. */
    const stepForPins = (count: number): void => {
      if (count === 0) {
        set({ step: 'start', armed: null, moving: null, preview: null });
        jump(startT());
      } else if (count === 1) {
        set({ step: 'end', armed: null, moving: null, preview: null });
        jump(endT());
      } else set({ step: 'placed', armed: null, moving: null, preview: null });
    };

    const pinAt = (t: number, at: [number, number], y: number | undefined): WalkPin | null => {
      const s = get().surface;
      if (!s) return null;
      const pin: WalkPin = { t, surface: surfaceKey(s), at: [at[0], at[1]] };
      if (s.kind !== 'drawing' && y !== undefined && Number.isFinite(y)) pin.y = y;
      return pin;
    };

    /** A spot on the surface in hand, in the model frame (null: a drawing not ready). */
    const modelOf = (at: [number, number]): XZ | null => {
      const s = get().surface;
      if (!s) return null;
      return pinTarget({ t: 0, surface: surfaceKey(s), at }, frames)?.xz ?? null;
    };

    /** The ghost's length: 0.7 m a step, or a share of a provisional drawing's width. */
    const ghostLength = (o: WalkOutline): number => {
      const s = get().surface;
      if (s?.kind === 'drawing') {
        const f = frames.drawing(s.id);
        const w = lookup(s.id)?.size.width ?? 0;
        if (f?.provisional && w > 0) return PROVISIONAL_GHOST * w * Math.hypot(f.a, f.c);
      }
      return ghostLengthM(o);
    };

    const enter = (count: number): void => {
      if (get().step !== 'check') stepForPins(count);
    };

    return {
      ...idle,

      start: (w, m, opts = {}) => {
        walk = w;
        raw = opts.raw ?? null;
        outline = walkOutline(raw);
        orientation = opts.orientation ?? null;
        lookup = opts.drawings ?? (() => undefined);
        frames = surfaceFramesOf(m, lookup);
        armedT = 0;
        const pins = byT(w.place?.pins ?? []);
        const yawOffsetDeg = w.place?.yawOffsetDeg ?? 0;
        const ready = opts.ready ?? outline !== null;
        set({
          ...idle,
          layerId: w.id,
          step: !ready && pins.length < 2 ? 'check' : 'start',
          pins,
          yawOffsetDeg,
          fit: fitOf(pins, yawOffsetDeg),
        });
      },

      setInputs: (r, o, ready) => {
        if (get().layerId === null) return;
        raw = r;
        outline = walkOutline(raw);
        orientation = o;
        if (!ready) {
          // the path went (the walk is processed again): the draft goes, the notice says why
          set({
            step: 'check',
            pins: [],
            fit: fitOf([], get().yawOffsetDeg),
            dirty: false,
            preview: null,
            armed: null,
            moving: null,
            align: null,
            dragging: null,
          });
          return;
        }
        const st = get();
        set({ fit: fitOf(st.pins, st.yawOffsetDeg) });
        if (st.step === 'check') {
          set({ step: 'start' });
          if (st.surface) stepForPins(st.pins.length);
        }
      },

      placeAnyway: () => {
        const st = get();
        if (st.layerId === null || st.step !== 'check') return;
        set({ step: 'start' });
        if (st.surface) stepForPins(st.pins.length);
      },

      setDate: (captureId) => {
        if (!walk || get().layerId === null) return;
        walk = { ...walk, capture: captureId };
      },

      chooseSurface: (s) => {
        if (get().layerId === null) return;
        set({ surface: s, error: null, align: null, preview: null });
        enter(get().pins.length);
      },

      hover: (at, y) => {
        const st = get();
        if (st.layerId === null || (st.step !== 'start' && st.step !== 'end') || !at) {
          if (st.preview) set({ preview: null });
          return;
        }
        const cursor = modelOf(at);
        if (!cursor) {
          set({ preview: null });
          return;
        }
        const yy = y !== undefined && Number.isFinite(y) ? y : null;
        if (st.step === 'start') {
          const xz = outline ? ghostPath(outline, cursor, ghostLength(outline)) : null;
          set({
            preview: xz
              ? { xz, ghost: true, tooClose: false, y: yy === null ? null : [yy, yy] }
              : null,
          });
          return;
        }
        const first = st.pins[0];
        const from = first ? pinTarget(first, frames) : null;
        if (!from) {
          set({ preview: null });
          return;
        }
        const tooClose =
          Math.hypot(cursor[0] - from.xz[0], cursor[1] - from.xz[1]) < MIN_PIN_SPAN_M;
        const xz = outline
          ? previewPath(outline, startT(), endT(), from.xz, cursor)
          : [from.xz, cursor];
        const y0 = from.y;
        set({
          preview: xz
            ? { xz, ghost: false, tooClose, y: y0 !== null && yy !== null ? [y0, yy] : null }
            : null,
        });
      },

      click: (surfaceAt, y) => {
        const st = get();
        if (st.layerId === null || !st.surface) return;
        if (st.step === 'fine-tune') {
          if (st.armed === 'align-surface') finishAlign(surfaceAt, y);
          else if (st.armed === 'move') moveArmed(surfaceAt, y);
          else if (st.armed === 'pin') {
            const pin = pinAt(armedT, surfaceAt, y);
            if (pin) setPins([...st.pins, pin], { armed: null });
          }
          return;
        }
        if (st.step !== 'start' && st.step !== 'end') return;
        if (st.surface.kind === 'drawing' && !frames.drawing(st.surface.id)) {
          set({ error: DRAWING_NOT_READY });
          return;
        }
        if (st.step === 'start') {
          const pin = pinAt(startT(), surfaceAt, y);
          if (!pin) return;
          setPins([pin], { step: 'end' });
          jump(endT());
          get().hover(surfaceAt, y);
          return;
        }
        const pin = pinAt(endT(), surfaceAt, y);
        if (!pin) return;
        const next = byT([...st.pins, pin]);
        const fit = fitOf(next, st.yawOffsetDeg);
        if (fit?.error) {
          // too close to the start: ignored, the hint already says why
          get().hover(surfaceAt, y);
          return;
        }
        set({ pins: next, fit, dirty: true, error: null, step: 'placed', preview: null });
      },

      dragHandle: (h, at, y) => {
        const st = get();
        if (st.layerId === null || (st.step !== 'placed' && st.step !== 'fine-tune')) return;
        if (st.pins.length < 2) return;
        const i = h === 'start' ? 0 : st.pins.length - 1;
        const old = st.pins[i];
        const pin = old ? pinAt(old.t, at, y) : null;
        if (!pin) return;
        const next = st.pins.map((p, k) => (k === i ? pin : p));
        const fit = fitOf(next, st.yawOffsetDeg);
        if (fit?.error) {
          set({ dragging: { handle: h, refused: true } });
          return;
        }
        set({ pins: next, fit, dirty: true, error: null, dragging: { handle: h, refused: false } });
      },

      endDrag: () => {
        if (get().dragging) set({ dragging: null });
      },

      setFineTune: (on) => {
        const st = get();
        if (st.layerId === null) return;
        if (on && st.step === 'placed')
          set({ step: 'fine-tune', armed: null, moving: null, align: null });
        else if (!on && st.step === 'fine-tune')
          set({ step: 'placed', armed: null, moving: null, align: null });
      },

      // setTime, movePin, setYaw, calibration: as today
      // pinHere and armAlign: guard `st.step !== 'fine-tune'` (was 'correct')
      // armMove: guard `st.step !== 'fine-tune'`; letting go sets `armed: null`
      // removePin: as today, then `if (st.surface && pins.length < 2) stepForPins(pins.length)`
      // cancel: also resets `outline = null` and `lookup = () => undefined`
    };

    // moveArmed: as today, ending with `setPins(next, { armed: null, moving: null })` (no stepArmed)
    // finishAlign: as today
    // stepArmed: deleted
  });
}
```

Update the file's header comment: the session's phases are `check`, `start`, `end`, `placed`, `fine-tune` (design "Walk placing by start and end").

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm --filter @aio/desktop exec vitest run src/renderer/walks/placeStore.test.ts src/renderer/walks/placeModel.test.ts`
Expected: PASS. (`placeWalk.test.ts` and `PlaceWalkStrip.test.tsx` fail until T8 and T9; that is expected, see "Typecheck between batches".)

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/walks/placeStore.ts apps/desktop/src/renderer/walks/placeStore.test.ts apps/desktop/src/renderer/walks/placeModel.ts apps/desktop/src/renderer/walks/placeModel.test.ts
git commit -m "feat(walks): place by start and end with a live preview, handles and fine-tune" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Edit placement and Remove placement on the tree row (`@aio/ui`)

**Files:**

- Modify: `packages/ui/src/tree/DatasetTree.tsx` (`WalkRowActions` `:91-95`, `walkButtons` `:195-251`, `removeConfirm` `:254-297`, where `removeConfirm` is rendered)
- Modify: `packages/ui/src/i18n/en.ts` (`:1933-1941`)
- Test: `packages/ui/src/tree/walkRows.test.tsx`

**Interfaces:**

- Produces:

```ts
export interface WalkRowActions {
  onOpen: (item: TreeItem) => void;
  onPlace?: ((item: TreeItem) => void) | undefined;
  onRemove?: ((item: TreeItem) => void) | undefined;
  /** The walk has a saved placement: Place walk becomes Edit placement and Remove placement shows. */
  placed?: ((item: TreeItem) => boolean) | undefined;
  onRemovePlacement?: ((item: TreeItem) => void) | undefined;
}
```

Test ids: `walk-edit-<id>` (replaces `walk-place-<id>` on a placed walk and calls `onPlace`), `walk-unplace-<id>`, `walk-unplace-confirm`, `walk-unplace-yes`, `walk-unplace-cancel`.

Strings (no dashes):

```ts
  'walk.row.place': 'Place {name} on a drawing, the map or the 3D view',
  'walk.row.edit': 'Edit the placement of {name}',
  'walk.row.editTip': 'Edit placement',
  'walk.row.unplace': 'Remove the placement of {name}',
  'walk.row.unplaceTip': 'Remove placement',
  'walk.row.unplaceConfirm': 'Remove the placement of {name}? The walk stays in the project.',
  'walk.row.unplaceYes': 'Remove placement',
```

- [ ] **Step 1: Write the failing tests** (in `walkRows.test.tsx`, using its render helpers and `groups`)

```ts
it('a placed walk offers Edit placement and Remove placement, which asks in the row', () => {
  const onPlace = vi.fn();
  const onRemovePlacement = vi.fn();
  render({
    walkActions: {
      onOpen: vi.fn(),
      onPlace,
      onRemove: vi.fn(),
      placed: (it) => it.id === 'walk-dated',
      onRemovePlacement,
    },
  });
  expect(q('[data-testid="walk-place-walk-dated"]')).toBeNull();
  click(q('[data-testid="walk-edit-walk-dated"]'));
  expect(onPlace).toHaveBeenCalledTimes(1);
  click(q('[data-testid="walk-unplace-walk-dated"]'));
  expect(q('[data-testid="walk-unplace-confirm"]')?.textContent).toContain(
    'Remove the placement of Walk dated? The walk stays in the project.',
  );
  expect(onRemovePlacement).not.toHaveBeenCalled();
  click(q('[data-testid="walk-unplace-yes"]'));
  expect(onRemovePlacement).toHaveBeenCalledTimes(1);
  expect(q('[data-testid="walk-unplace-confirm"]')).toBeNull();
});

it('an unplaced walk keeps Place walk and has no Remove placement', () => {
  render({
    walkActions: {
      onOpen: vi.fn(),
      onPlace: vi.fn(),
      placed: () => false,
      onRemovePlacement: vi.fn(),
    },
  });
  expect(q('[data-testid="walk-place-walk-dated"]')).not.toBeNull();
  expect(q('[data-testid="walk-unplace-walk-dated"]')).toBeNull();
});

it('Cancel and Escape close the Remove placement question', () => {
  render({ walkActions: { onOpen: vi.fn(), placed: () => true, onRemovePlacement: vi.fn() } });
  click(q('[data-testid="walk-unplace-walk-dated"]'));
  click(q('[data-testid="walk-unplace-cancel"]'));
  expect(q('[data-testid="walk-unplace-confirm"]')).toBeNull();
});
```

(Adapt `render`, `q` and `click` to the helpers the file already has; the names above are placeholders for those helpers, not new code.)

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm --filter @aio/ui exec vitest run src/tree/walkRows.test.tsx`
Expected: FAIL (no `walk-edit-...`).

- [ ] **Step 3: Write the implementation**

- `button` kinds become `'open' | 'place' | 'edit' | 'unplace' | 'remove'`, icons add `'x'`.
- In `walkButtons`: `const isPlaced = acts.placed?.(it) === true;` then Place reads Edit when placed (`button(isPlaced ? 'edit' : 'place', 'pin', t(isPlaced ? 'walk.row.edit' : 'walk.row.place', { name: it.name }), t(isPlaced ? 'walk.row.editTip' : 'walk.row.placeTip'), () => { onPlace(it); })`), and when `isPlaced && acts.onRemovePlacement` add `button('unplace', 'x', t('walk.row.unplace', { name: it.name }), t('walk.row.unplaceTip'), () => { setUnplacing(it.id); })` before Remove.
- A `const [unplacing, setUnplacing] = useState<string | null>(null);` beside `removing`, and an `unplaceConfirm(it)` built like `removeConfirm` with the ids above, `t('walk.row.unplaceConfirm', { name: it.name })`, the yes button `className="btn sm"` (not `danger`: the walk stays), Cancel with `autoFocus` and Escape, focus returned to the row with `pendingFocus`. Render it where `removeConfirm(it)` is rendered.
- Opening one question closes the other (`setRemoving(null)` when unplacing starts and the reverse).

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm --filter @aio/ui exec vitest run src/tree/walkRows.test.tsx src/tree/DatasetTree.test.tsx src/i18n/i18n.test.ts` and `pnpm --filter @aio/ui typecheck`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/tree/DatasetTree.tsx packages/ui/src/tree/walkRows.test.tsx packages/ui/src/i18n/en.ts
git commit -m "feat(ui): Edit placement and Remove placement on a placed walk's row" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The walk in the 3D view (`walkScene.ts`)

**Files:**

- Create: `apps/desktop/src/renderer/walks/walkScene.ts`
- Create: `apps/desktop/src/renderer/walks/walkScene.test.ts`

Precedent: `apps/desktop/src/renderer/survey/measureScene.ts` `attach3d` (`:187`): an overlay `Group` with a raised `renderOrder`, `depthTest: false` materials, `pick` through `stage.raycast` (`:222`), drag with `stage.controls.enabled = false` (`:374-405`), clicks through `stage.claimClicks` (`:406-425`). Engine API: `EngineStage` (`packages/engine/src/types.ts:145`), `raycast(ndcX, ndcY)` (`:72`, falls back to the ground plane y = 0 in `Stage.ts:381-390`).

**Interfaces:**

- Consumes: `WalkFit` (`@aio/geo`), `EngineStage` (`@aio/engine`).
- Produces:

```ts
/** A walk's path in the model, runs split where the dashed state changes. */
export interface WalkSceneWalk {
  id: string;
  colour: string;
  runs: { pts: [number, number, number][]; dashed: boolean }[];
}
/** What the walk being placed in the 3D view shows and takes. */
export interface WalkScenePlacing {
  walk: WalkSceneWalk | null;
  preview: { pts: [number, number, number][]; ghost: boolean; tooClose: boolean } | null;
  handles: { id: 'start' | 'end'; at: [number, number, number] }[];
  /** A click on the view is wanted (start, end, or a fine-tune pin, move or align). */
  clicks: boolean;
}
export interface WalkSceneInput {
  hover(at: [number, number] | null, y?: number): void;
  click(at: [number, number], y: number): void;
  drag(handle: 'start' | 'end', at: [number, number], y: number): void;
  endDrag(): void;
}
export interface WalkSceneView {
  /** Placed walks drawn faintly (not the one being placed). */
  setPlaced(walks: readonly WalkSceneWalk[]): void;
  setPlacing(p: WalkScenePlacing | null, input: WalkSceneInput | null): void;
  dispose(): void;
}
/** Sample a fit every `stepS` seconds over the walk: model points at ground height plus `lift`. */
export function sceneRuns(
  fit: WalkFit,
  durationS: number,
  stepS?: number,
  lift?: number,
): WalkSceneWalk['runs'];
/** Spread heights from `y[0]` to `y[1]` along the shape (stills are evenly spaced in time). */
export function previewPoints(
  xz: readonly [number, number][],
  y: [number, number] | null,
  lift?: number,
): [number, number, number][];
export function attachWalkScene(stage: EngineStage): WalkSceneView;
export const WALK_SCENE_GROUP = 'aio-walks';
export const WALK_PREVIEW_NAME = 'aio-walk-preview';
```

- [ ] **Step 1: Write the failing tests**

```ts
// @vitest-environment jsdom
import { fitWalk } from '@aio/geo';
import type { EngineStage } from '@aio/engine';
import { PerspectiveCamera, Scene, Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';
import {
  attachWalkScene,
  previewPoints,
  sceneRuns,
  WALK_PREVIEW_NAME,
  WALK_SCENE_GROUP,
} from './walkScene';

/** The slice of the stage the walk layer uses; the ray hits the ground at a set point. */
function fakeStage(hit: { x: number; y: number; z: number } | null) {
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  canvas.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    width: 200,
    height: 100,
    right: 200,
    bottom: 100,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  const claims: ((e: PointerEvent) => boolean)[] = [];
  const camera = new PerspectiveCamera(60, 2, 0.1, 1000);
  camera.position.set(0, 50, 0);
  // looking straight down: up must not be parallel to the view
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const stage = {
    scene: new Scene(),
    camera,
    renderer: { domElement: canvas },
    controls: { enabled: true },
    raycast: vi.fn(() => (hit ? { point: new Vector3(hit.x, hit.y, hit.z), distance: 1 } : null)),
    claimClicks: (fn: (e: PointerEvent) => boolean) => {
      claims.push(fn);
      return () => claims.splice(claims.indexOf(fn), 1);
    },
    requestRender: vi.fn(),
  } as unknown as EngineStage;
  return { stage, canvas, claims };
}

const input = () => ({ hover: vi.fn(), click: vi.fn(), drag: vi.fn(), endDrag: vi.fn() });

describe('walk in the 3D view', () => {
  it('samples the fit at ground height', () => {
    const fit = fitWalk(
      null,
      {
        pins: [
          { t: 0, surface: '@model', at: [0, 0], y: 2 },
          { t: 10, surface: '@model', at: [10, 0], y: 4 },
        ],
        yawOffsetDeg: 0,
      },
      { drawing: () => null },
      10,
    );
    const runs = sceneRuns(fit, 10, 1, 0);
    const pts = runs.flatMap((r) => r.pts);
    expect(pts[0]).toEqual([0, 2, 0]);
    expect(pts.at(-1)?.[1]).toBeCloseTo(4);
  });

  it('spreads preview heights from start to cursor', () => {
    expect(
      previewPoints(
        [
          [0, 0],
          [1, 0],
          [2, 0],
        ],
        [0, 2],
        0,
      ).map((p) => p[1]),
    ).toEqual([0, 1, 2]);
    expect(
      previewPoints(
        [
          [0, 0],
          [1, 0],
        ],
        null,
        0,
      ).map((p) => p[1]),
    ).toEqual([0, 0]);
  });

  it('hover reports the ground point, null when the ray finds nothing', () => {
    const { stage, canvas } = fakeStage({ x: 3, y: 1, z: 4 });
    const view = attachWalkScene(stage);
    const inp = input();
    view.setPlacing({ walk: null, preview: null, handles: [], clicks: true }, inp);
    canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: 100, clientY: 50 }));
    expect(inp.hover).toHaveBeenCalledWith([3, 4], 1);
    (stage.raycast as ReturnType<typeof vi.fn>).mockReturnValue(null);
    canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: 100, clientY: 50 }));
    expect(inp.hover).toHaveBeenLastCalledWith(null);
    view.dispose();
  });

  it('claims clicks only while a click is wanted', () => {
    const { stage, claims } = fakeStage({ x: 1, y: 0, z: 2 });
    const view = attachWalkScene(stage);
    const inp = input();
    view.setPlacing({ walk: null, preview: null, handles: [], clicks: true }, inp);
    expect(claims[0]?.(new PointerEvent('pointerup', { clientX: 10, clientY: 10 }))).toBe(true);
    expect(inp.click).toHaveBeenCalledWith([1, 2], 0);
    view.setPlacing({ walk: null, preview: null, handles: [], clicks: false }, inp);
    expect(claims[0]?.(new PointerEvent('pointerup'))).toBe(false);
    view.dispose();
    expect(claims).toHaveLength(0);
  });

  it('a press on a handle drags it with the orbit controls off; a release anywhere ends it', () => {
    const { stage, canvas } = fakeStage({ x: 5, y: 0, z: 5 });
    const view = attachWalkScene(stage);
    const inp = input();
    // the handle at the origin projects to the canvas centre (the camera looks straight down)
    view.setPlacing(
      { walk: null, preview: null, handles: [{ id: 'end', at: [0, 0, 0] }], clicks: false },
      inp,
    );
    canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100, clientY: 50, button: 0 }));
    expect(stage.controls.enabled).toBe(false);
    canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: 120, clientY: 50 }));
    expect(inp.drag).toHaveBeenCalledWith('end', [5, 5], 0);
    expect(inp.hover).not.toHaveBeenCalled();
    window.dispatchEvent(new PointerEvent('pointerup'));
    expect(stage.controls.enabled).toBe(true);
    expect(inp.endDrag).toHaveBeenCalledTimes(1);
    view.dispose();
  });

  it('draws the preview above everything, and placed walks faintly', () => {
    const { stage } = fakeStage(null);
    const view = attachWalkScene(stage);
    view.setPlaced([
      {
        id: 'walk-b',
        colour: '#ff0000',
        runs: [
          {
            pts: [
              [0, 0, 0],
              [1, 0, 0],
            ],
            dashed: false,
          },
        ],
      },
    ]);
    view.setPlacing(
      {
        walk: null,
        preview: {
          pts: [
            [0, 0, 0],
            [5, 0, 0],
          ],
          ghost: true,
          tooClose: false,
        },
        handles: [],
        clicks: true,
      },
      input(),
    );
    const group = stage.scene.getObjectByName(WALK_SCENE_GROUP);
    const preview = stage.scene.getObjectByName(WALK_PREVIEW_NAME);
    expect(group?.renderOrder).toBeGreaterThanOrEqual(45);
    expect(preview?.visible).toBe(true);
    view.setPlacing(null, null);
    expect(stage.scene.getObjectByName(WALK_PREVIEW_NAME)?.visible ?? false).toBe(false);
    view.dispose();
    expect(stage.scene.getObjectByName(WALK_SCENE_GROUP)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm --filter @aio/desktop exec vitest run src/renderer/walks/walkScene.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the implementation**

```ts
import type { EngineStage } from '@aio/engine';
import type { WalkFit } from '@aio/geo';
import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  Line,
  LineBasicMaterial,
  LineDashedMaterial,
  Points,
  PointsMaterial,
  Vector2,
  Vector3,
} from 'three';

/*
 * The walk in the 3D view (design "Walk placing by start and end", unit 6): the path as a line
 * on the ground at the clicked heights, the shape that follows the pointer, and the Start and
 * End handles, drawn over the model (no depth test, raised render order). Hover through
 * `stage.raycast`, clicks through `stage.claimClicks`, a handle drag with the orbit controls off.
 * Placed walks are drawn faintly. The session behind it is wired in `WalkSceneMount.tsx`.
 */

export const WALK_SCENE_GROUP = 'aio-walks';
export const WALK_PREVIEW_NAME = 'aio-walk-preview';
/** Lines sit this far above the ground, metres, so the ground does not hide them. */
const LIFT_M = 0.1;
/** A press this close to a handle (screen px) grabs it. */
const HANDLE_PX = 10;
const FAINT = 0.6;
const GHOST = 0.45;

export function sceneRuns(
  fit: WalkFit,
  durationS: number,
  stepS = 0.25,
  lift = LIFT_M,
): WalkSceneWalk['runs'] {
  const runs: WalkSceneWalk['runs'] = [];
  let cur: WalkSceneWalk['runs'][number] | null = null;
  const end = Number.isFinite(durationS) && durationS > 0 ? durationS : 0;
  for (let t = 0; t <= end + 1e-9; t += stepS) {
    const a = fit.at(Math.min(t, end));
    if (!a) {
      cur = null;
      continue;
    }
    const p: [number, number, number] = [a.xz[0], a.groundY + lift, a.xz[1]];
    if (!cur || cur.dashed !== a.dashed) {
      // runs share their joint, so a dashed stretch meets the solid one
      const joint = cur?.pts.at(-1);
      cur = { pts: joint ? [joint] : [], dashed: a.dashed };
      runs.push(cur);
    }
    cur.pts.push(p);
  }
  return runs.filter((r) => r.pts.length > 1);
}

export function previewPoints(
  xz: readonly [number, number][],
  y: [number, number] | null,
  lift = LIFT_M,
): [number, number, number][] {
  const n = xz.length;
  return xz.map((p, i) => {
    const f = n > 1 ? i / (n - 1) : 0;
    const h = y ? y[0] + (y[1] - y[0]) * f : 0;
    return [p[0], h + lift, p[1]];
  });
}

export function attachWalkScene(stage: EngineStage): WalkSceneView {
  const group = new Group();
  group.name = WALK_SCENE_GROUP;
  group.renderOrder = 45;
  stage.scene.add(group);
  const placedGroup = new Group();
  const placingGroup = new Group();
  group.add(placedGroup, placingGroup);
  const canvas = stage.renderer.domElement;

  let placing: WalkScenePlacing | null = null;
  let input: WalkSceneInput | null = null;
  let dragging: 'start' | 'end' | null = null;

  const line = (
    pts: readonly [number, number, number][],
    colour: string,
    opacity: number,
    dashed: boolean,
  ): Line => {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(pts.flat(), 3));
    const common = { color: new Color(colour), depthTest: false, transparent: true, opacity };
    const l = new Line(
      g,
      dashed
        ? new LineDashedMaterial({ ...common, dashSize: 0.6, gapSize: 0.4 })
        : new LineBasicMaterial(common),
    );
    if (dashed) l.computeLineDistances();
    l.renderOrder = 45;
    return l;
  };
  const clear = (g: Group) => {
    for (const c of [...g.children]) {
      g.remove(c);
      if (c instanceof Line || c instanceof Points) {
        c.geometry.dispose();
        const m = c.material;
        (Array.isArray(m) ? m : [m]).forEach((x) => x.dispose());
      }
    }
  };
  const drawWalk = (g: Group, w: WalkSceneWalk, opacity: number) => {
    for (const r of w.runs) g.add(line(r.pts, w.colour, opacity, r.dashed));
  };

  const redraw = () => {
    clear(placingGroup);
    const p = placing;
    if (p?.walk) drawWalk(placingGroup, p.walk, 1);
    if (p?.preview && p.preview.pts.length > 1) {
      const l = line(
        p.preview.pts,
        p.walk?.colour ?? '#ffffff',
        p.preview.ghost ? GHOST : 1,
        p.preview.ghost || p.preview.tooClose,
      );
      l.name = WALK_PREVIEW_NAME;
      placingGroup.add(l);
    }
    if (p && p.handles.length > 0) {
      const g = new BufferGeometry();
      g.setAttribute(
        'position',
        new Float32BufferAttribute(
          p.handles.flatMap((h) => [h.at[0], h.at[1] + LIFT_M, h.at[2]]),
          3,
        ),
      );
      const pts = new Points(
        g,
        new PointsMaterial({
          color: new Color(p.walk?.colour ?? '#ffffff'),
          size: 14,
          sizeAttenuation: false,
          depthTest: false,
          transparent: true,
        }),
      );
      pts.renderOrder = 46;
      placingGroup.add(pts);
    }
    stage.requestRender();
  };

  const ground = (e: { clientX: number; clientY: number }) => {
    const r = canvas.getBoundingClientRect();
    if (!(r.width > 0) || !(r.height > 0)) return null;
    const hit = stage.raycast(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1,
    );
    return hit ? hit.point : null;
  };
  const tmp = new Vector3();
  const screenOf = (p: readonly [number, number, number]): Vector2 | null => {
    tmp.set(p[0], p[1], p[2]).project(stage.camera);
    if (tmp.z > 1) return null;
    const r = canvas.getBoundingClientRect();
    return new Vector2(r.left + ((tmp.x + 1) / 2) * r.width, r.top + ((1 - tmp.y) / 2) * r.height);
  };
  const handleAt = (e: PointerEvent): 'start' | 'end' | null => {
    let best: 'start' | 'end' | null = null;
    let bestD = HANDLE_PX;
    for (const h of placing?.handles ?? []) {
      const s = screenOf(h.at);
      const d = s ? Math.hypot(s.x - e.clientX, s.y - e.clientY) : Infinity;
      if (d <= bestD) {
        best = h.id;
        bestD = d;
      }
    }
    return best;
  };

  const onMove = (e: PointerEvent) => {
    if (!input) return;
    const p = ground(e);
    if (dragging) {
      if (p) input.drag(dragging, [p.x, p.z], p.y);
      return;
    }
    input.hover(p ? [p.x, p.z] : null, p?.y);
  };
  const onLeave = () => {
    if (!dragging) input?.hover(null);
  };
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0 || !input) return;
    const h = handleAt(e);
    if (!h) return;
    dragging = h;
    stage.controls.enabled = false;
    e.stopImmediatePropagation();
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = null;
    stage.controls.enabled = true;
    input?.endDrag();
  };
  const offClaim = stage.claimClicks((e) => {
    if (!placing?.clicks || !input) return false;
    const p = ground(e);
    if (p) input.click([p.x, p.z], p.y);
    return true;
  });
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('pointerdown', onDown, { capture: true });
  window.addEventListener('pointerup', onUp);

  return {
    setPlaced: (walks) => {
      clear(placedGroup);
      for (const w of walks) drawWalk(placedGroup, w, FAINT);
      stage.requestRender();
    },
    setPlacing: (p, i) => {
      placing = p;
      input = i;
      if (!p) onUp();
      canvas.style.cursor = p?.clicks ? 'crosshair' : '';
      redraw();
    },
    dispose: () => {
      onUp();
      offClaim();
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('pointerdown', onDown, { capture: true });
      window.removeEventListener('pointerup', onUp);
      clear(placedGroup);
      clear(placingGroup);
      stage.scene.remove(group);
      stage.requestRender();
    },
  };
}
```

(Keep the exported interfaces from "Interfaces" at the top of the file.)

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm --filter @aio/desktop exec vitest run src/renderer/walks/walkScene.test.ts`
Expected: PASS. If `PointerEvent` is missing in jsdom, add the small polyfill the survey tests use (search `class PointerEvent` under `apps/desktop/src`), or build the events with `new MouseEvent('pointermove', ...)`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/walks/walkScene.ts apps/desktop/src/renderer/walks/walkScene.test.ts
git commit -m "feat(walks): the walk, its preview and its handles in the 3D view" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The flow: path check, surfaces, map session, fine-tune, Remove placement

**Files:**

- Modify: `apps/desktop/src/renderer/walks/placeWalk.ts` (`PlaceUi` `:110-125`, `PlaceWalkDeps` `:152-168`, `PlaceWalkFlow` `:182-209`, `createPlaceWalk` `:211-388`, `wantsSurfaceClick` `:421-430`, `followMap` `:454-529`, `openSurface` `:534-555`, the app instance `:557-596`, `usePlacedWalksOnMap` `:763-777`)
- Modify: `apps/desktop/src/renderer/walks/walkMapStore.ts` (pick to pointer)
- Modify: `apps/desktop/src/renderer/walks/walks.ts` (Remove placement handler, next to `setPlaceWalkHandler` `:166-176`)
- Tests: `placeWalk.test.ts`, `walkMapStore.test.ts`, `walks.test.ts`

**Interfaces:**

- Consumes: T2 `MapPointerSession`; T3 `walkPathState`, `rememberedSurface(…, modelOn)`, `surfaceKey`, `PlaceSurface`; T4 `walkPreviewMapOverlay`; T5 the session API.
- Produces:

```ts
// placeWalk.ts
export interface PlaceUi {
  layerId: string | null;
  host: PlaceSurface | null;
  inputs: WalkInputs;
  saving: boolean;
  asking: boolean;
  note: string | null;
  seek: { t: number; n: number } | null;
  pending: string | null;
  /** The survey date field: a capture id, `add:YYYY-MM-DD`, or null (save undated). */
  date: string | null;
  /** Fine-tune shows the 360 video beside the surface. */
  fineTune: boolean;
}
export interface PlaceWalkDeps {
  project(): OpenProject | null;
  drawings: DrawingLookup;
  loadInputs(projectId: string, layer: WalkLayer): Promise<WalkInputs>;
  /** Show `host` for placing (map or 3D fill the stage; a drawing beside the 3D view), with the 360 video beside it when `fineTune`. */
  openSurface(layerId: string, host: PlaceSurface, fineTune: boolean): void;
  save(layerId: string, patch: LayerPatch): Promise<string | null>;
  ensureCapture(day: string): Promise<{ captureId: string } | { error: string }>;
  setCapture(layerId: string, captureId: string): Promise<string | null>;
  capturedAt(layer: WalkLayer): string | undefined;
  /** The walk's newest `walk.process` job. */
  job(layer: WalkLayer): Pick<JobRecord, 'status' | 'progress'> | undefined;
  /** What the stage shows of the model now: the map or the 3D view. */
  modelSurface(): 'map' | '3d';
  /** Process walk from the notice: null when started, else why not. */
  process(layer: WalkLayer): Promise<string | null>;
}
export interface PlaceWalkFlow {
  begin(layerId: string): Promise<void>;
  walk(): WalkLayer | null;
  surfaces(): PlaceSurface[];
  orthos(): string[];
  dates(): { pick: DateChoice[]; add?: string };
  setDate(value: string | null): void;
  chooseSurface(s: PlaceSurface): void;
  pathState(): WalkPathState;
  process(): Promise<void>;
  placeAnyway(): void;
  fineTune(on: boolean): void;
  save(): Promise<void>;
  /** Remove the saved placement of `layerId` (the walk being placed when absent); null when done. */
  removePlacement(layerId?: string): Promise<string | null>;
  close(): void;
  discard(): void;
  keepPlacing(): void;
  dropIfGone(): void;
  /** The walk's path files changed in the manifest: read them again into the session. */
  pathChanged(): Promise<void>;
}
export function surfaceLayout(
  saved: SplitPref | undefined,
  host: PlaceSurface,
  fineTune: boolean,
): { mode: StageMode; split?: SplitPref };
export function wantsSurfaceClick(s: Pick<PlaceState, 'step' | 'armed'>): boolean;
export function sessionHandles(
  s: Pick<PlaceState, 'step' | 'fit' | 'pins'>,
): { handle: PlaceHandle; xz: XZ; y: number | null }[];
export function usePlacingOn(kind: 'map' | '3d'): boolean;
// walkMapStore.ts
export interface WalkMapState {
  overlays: readonly MapOverlay[];
  pointer: MapPointerSession | null;
}
export function setWalkMapPointer(p: MapPointerSession | null): void;
export const useWalkMapPointer: () => MapPointerSession | null;
// (setWalkMapPick and useWalkMapPick are removed)
// walks.ts
export function setRemovePlacementHandler(
  fn: ((layerId: string) => Promise<string | null>) | null,
): void;
export function removeWalkPlacement(layerId: string): Promise<string | null>;
```

- [ ] **Step 1: Write the failing tests**

In `placeWalk.test.ts`: extend `flowFor` with `job: () => undefined`, `modelSurface: () => '3d'`, `process: vi.fn(() => Promise.resolve(null))` and update the `vi.mock('../shell')` stub if needed. Replace the date-step and `pick` based tests with:

```ts
describe('createPlaceWalk, start and end', () => {
  const withPath = (extra: Partial<WalkLayer> = {}) => walkLayer({ path: refs, ...extra });
  const loadFixture = () => Promise.resolve({ raw, orientation: null });

  it('a walk with a path opens on Start on the first surface', async () => {
    const project = { current: projectWith([plan, withPath()]) };
    const { flow, openSurface, session } = flowFor(project, { loadInputs: loadFixture });
    await flow.begin('walk-a');
    expect(openSurface).toHaveBeenCalledWith(
      'walk-a',
      expect.objectContaining({ kind: 'drawing' }),
      false,
    );
    expect(session.getState().step).toBe('start');
  });

  it('a walk with no path opens on the check, with the job state', async () => {
    const project = { current: projectWith([plan, walkLayer()]) };
    const { flow, session } = flowFor(project, {
      job: () => ({ status: 'interrupted', progress: 0.31 }),
    });
    await flow.begin('walk-a');
    expect(session.getState().step).toBe('check');
    expect(flow.pathState()).toBe('interrupted');
    flow.placeAnyway();
    expect(session.getState().step).toBe('start');
  });

  it('a walk placed on @model reopens on the map when the stage shows the map, else 3D', async () => {
    const placed = withPath({
      place: {
        pins: [
          { t: 4, surface: '@model', at: [0, 0] },
          { t: 62, surface: '@model', at: [40, -30] },
        ],
        yawOffsetDeg: 0,
        heightM: 1.7,
        quality: 'good',
        placedOn: '@model',
      },
    });
    const project = { current: projectWith([placed]) };
    const onMap = flowFor(project, { loadInputs: loadFixture, modelSurface: () => 'map' });
    await onMap.flow.begin('walk-a');
    expect(onMap.ui.getState().host).toEqual({ kind: 'map' });
    expect(onMap.session.getState().step).toBe('placed');
    const in3d = flowFor(project, { loadInputs: loadFixture, modelSurface: () => '3d' });
    await in3d.flow.begin('walk-a');
    expect(in3d.ui.getState().host).toEqual({ kind: '3d' });
  });

  it('Save applies the date field first, then saves the placement', async () => {
    const { capture: _c, ...undated } = withPath();
    const project = { current: projectWith([plan, undated]) };
    const setCapture = vi.fn(() => Promise.resolve(null));
    const { flow, session, save } = flowFor(project, { loadInputs: loadFixture, setCapture });
    await flow.begin('walk-a');
    flow.setDate('c1');
    session.getState().chooseSurface({ kind: '3d' });
    session.getState().click([0, 0], 0);
    session.getState().click([40, -30], 0);
    await flow.save();
    expect(setCapture).toHaveBeenCalledWith('walk-a', 'c1');
    expect(save).toHaveBeenCalledWith('walk-a', {
      walk: expect.objectContaining({ placedOn: '@model' }),
    });
  });

  it('Fine-tune opens the 360 beside the surface and turns the session to fine-tune', async () => {
    const project = { current: projectWith([withPath()]) };
    const { flow, openSurface, session, ui } = flowFor(project, { loadInputs: loadFixture });
    await flow.begin('walk-a');
    session.getState().click([0, 0], 0);
    session.getState().click([40, -30], 0);
    flow.fineTune(true);
    expect(session.getState().step).toBe('fine-tune');
    expect(ui.getState().fineTune).toBe(true);
    // a project with a CRS and no drawing: the map comes first
    expect(openSurface).toHaveBeenLastCalledWith('walk-a', { kind: 'map' }, true);
  });

  it('Remove placement sends walk null and closes the session', async () => {
    const project = {
      current: projectWith([
        withPath({
          place: { pins: [], yawOffsetDeg: 0, heightM: 1.7, quality: 'good', placedOn: '@model' },
        }),
      ]),
    };
    const { flow, save, ui } = flowFor(project, { loadInputs: loadFixture });
    await flow.begin('walk-a');
    expect(await flow.removePlacement()).toBeNull();
    expect(save).toHaveBeenCalledWith('walk-a', { walk: null });
    expect(ui.getState().layerId).toBeNull();
  });

  it('a path that appears while on the check moves on to Start; one that goes drops the draft', async () => {
    const project = { current: projectWith([walkLayer()]) };
    const { flow, session } = flowFor(project, {
      loadInputs: (_p, l) =>
        Promise.resolve(l.path ? { raw, orientation: null } : { raw: null, orientation: null }),
    });
    await flow.begin('walk-a');
    expect(session.getState().step).toBe('check');
    project.current = projectWith([withPath()]);
    await flow.pathChanged();
    expect(session.getState().step).toBe('start');
    project.current = projectWith([walkLayer()]);
    await flow.pathChanged();
    expect(session.getState().step).toBe('check');
  });
});

describe('surfaceLayout', () => {
  it('the map and 3D fill the stage; a drawing sits beside the 3D view, never the 360', () => {
    expect(surfaceLayout(undefined, { kind: 'map' }, false)).toEqual({ mode: 'map' });
    expect(surfaceLayout(undefined, { kind: '3d' }, false)).toEqual({ mode: '3d' });
    const d = surfaceLayout(
      { left: '3d', right: 'walk360' },
      { kind: 'drawing', id: 's', name: 'S', dated: false },
      false,
    );
    expect(d.mode).toBe('split');
    expect([d.split?.left, d.split?.right].sort()).toEqual(['3d', 'raster']);
    expect(d.split?.raster).toBe('s');
  });

  it('fine-tune puts the 360 video beside the surface', () => {
    const f = surfaceLayout(undefined, { kind: 'map' }, true);
    expect(f.mode).toBe('split');
    expect([f.split?.left, f.split?.right].sort()).toEqual(['map', 'walk360']);
  });
});

describe('the walk on the map while it is placed there', () => {
  afterEach(() => {
    setWalkMapOverlays([]);
    setWalkMapPointer(null);
  });

  it('hover shows the preview, clicks place, handles drag, and close clears', async () => {
    const project = { current: projectWith([walkLayer({ path: refs })]) };
    const { flow, session, ui } = flowFor(project, {
      loadInputs: () => Promise.resolve({ raw, orientation: null }),
    });
    const stop = followMap(session, ui, () => project.current);
    await flow.begin('walk-a');
    flow.chooseSurface({ kind: 'map' });
    const pointer = walkMap.getState().pointer;
    expect(pointer).not.toBeNull();
    pointer?.onMove?.([5, 0, 6]);
    expect(walkMap.getState().overlays.map((o) => o.id)).toContain('walk-walk-a-preview');
    pointer?.onClick?.([0, 0.5, 0]);
    pointer?.onClick?.([40, 0, -30]);
    expect(session.getState().step).toBe('placed');
    expect(walkMap.getState().overlays.map((o) => o.id)).not.toContain('walk-walk-a-preview');
    expect(pointer?.handles?.().map((h) => h.id)).toEqual(['start', 'end']);
    pointer?.onDrag?.('end', [45, 0, -30]);
    expect(session.getState().pins[1]?.at).toEqual([45, -30]);
    pointer?.onDragEnd?.('end', [45, 0, -30]);
    expect(session.getState().dragging).toBeNull();
    flow.discard();
    expect(walkMap.getState().overlays).toHaveLength(0);
    expect(walkMap.getState().pointer).toBeNull();
    stop();
  });
});
```

Keep the existing tests for unsaved changes on another walk, the second Place walk winning, discard, removal while placing, the helpers and placed walks on every surface, adjusting their step names (`'correct'` to `'placed'`) and dropping the date-step clicks.

`walkMapStore.test.ts`: replace the pick test with "the pointer session is replaced and cleared" (`setWalkMapPointer(a)`, `setWalkMapPointer(b)`, state is `b`; `setWalkMapPointer(null)` clears).

`walks.test.ts`: `removeWalkPlacement` calls the registered handler and answers its result; without a handler it answers "Place walk is not ready." (copy without dashes).

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm --filter @aio/desktop exec vitest run src/renderer/walks/placeWalk.test.ts src/renderer/walks/walkMapStore.test.ts src/renderer/walks/walks.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

`walkMapStore.ts`: the state becomes `{ overlays, pointer }`; `setWalkMapPointer(p)` sets it; `useWalkMapPointer` selects it; the `WalkMapPick` type, `setWalkMapPick` and `useWalkMapPick` go. Header comment: "and, while a walk is being placed on the map, a pointer session (hover, clicks, handles)".

`walks.ts`:

```ts
let removePlacementHandler: ((layerId: string) => Promise<string | null>) | null = null;

/** The Place walk flow registers its Remove placement here; the tree row calls it. */
export function setRemovePlacementHandler(
  fn: ((layerId: string) => Promise<string | null>) | null,
): void {
  removePlacementHandler = fn;
}

/** Remove a walk's placement (the walk stays): null when removed, else why not. */
export function removeWalkPlacement(layerId: string): Promise<string | null> {
  return removePlacementHandler
    ? removePlacementHandler(layerId)
    : Promise.resolve('Place walk is not ready.');
}
```

`placeWalk.ts`:

1. `CLOSED` gains `date: null, fineTune: false`.
2. `begin(layerId)`: as today up to the inputs, with:

```ts
const list = placeSurfaces(project.manifest, layer, hasCrs(project.manifest));
const host = rememberedSurface(layer, list, deps.modelSurface()) ?? list[0] ?? SCENE_SURFACE;
ui.setState({ ...CLOSED, layerId, host, date: defaultDate(layer) });
deps.openSurface(layerId, host, false);
const inputs = await deps.loadInputs(project.id, layer);
if (ask !== begun || ui.getState().layerId !== layerId) return;
const m = deps.project()?.manifest ?? project.manifest;
const now = m.layers.find((l): l is WalkLayer => l.kind === 'walk' && l.id === layerId);
if (!now) {
  reset();
  return;
}
pathKey = JSON.stringify(now.path ?? null);
ui.setState({ inputs });
session.getState().start(now, m, {
  raw: inputs.raw,
  drawings: deps.drawings,
  orientation: inputs.orientation,
  ready: walkPathState(now, deps.job(now), inputs.raw) === 'ready',
});
session.getState().chooseSurface(host);
```

with `defaultDate(w)` (computed after `layerId` is in `ui`, since `dates()` reads the walk through it): `w.capture` when set (the field is hidden then), else the first `dates().pick` id, else `add:<day>` when `dates().add` is set, else null. `enterHost` and the `step !== 'surface'` guard go. 3. `setDate(v)`: `ui.setState({ date: v })`. 4. `save()`: before `deps.save`, when the walk has no `capture` and `ui.date` is set: `add:` values go through `deps.ensureCapture(day)` then `deps.setCapture`, other values through `deps.setCapture`; on an error set `note` and `saving: false` and stop; on success `session.getState().setDate(id)`. A pin waiting to be moved still lets go first, as today. 5. `chooseSurface(s)`: `ui.setState({ host: s, note: null })`, `deps.openSurface(id, s, ui.getState().fineTune)`, `session.getState().chooseSurface(s)`. 6. `pathState()`: `const w = walkOf(); return w ? walkPathState(w, deps.job(w), ui.getState().inputs.raw) : 'none';` 7. `process()`: `const w = walkOf(); if (!w) return; const error = await deps.process(w); if (error) ui.setState({ note: error });` 8. `placeAnyway()`: `session.getState().placeAnyway()`. 9. `fineTune(on)`: `const host = ui.getState().host; const id = ui.getState().layerId; if (!id || !host) return; session.getState().setFineTune(on); ui.setState({ fineTune: on && session.getState().step === 'fine-tune' }); deps.openSurface(id, host, ui.getState().fineTune);` 10. `removePlacement(layerId)`: `const id = layerId ?? ui.getState().layerId; if (!id) return null; const error = await deps.save(id, { walk: null }); if (!error && ui.getState().layerId === id) reset(); return error;` 11. `pathChanged()`: when a session is open and `JSON.stringify(walkOf()?.path ?? null) !== pathKey`: update `pathKey`, `const inputs = await deps.loadInputs(projectId, w)`, `ui.setState({ inputs })`, `session.getState().setInputs(inputs.raw, inputs.orientation, walkPathState(w, deps.job(w), inputs.raw) === 'ready')`. 12. `wantsSurfaceClick(s)`: `s.step === 'start' || s.step === 'end' || (s.step === 'fine-tune' && (s.armed === 'pin' || s.armed === 'move' || s.armed === 'align-surface'))`. 13. `sessionHandles(s)`: empty unless `s.step` is `placed` or `fine-tune`; else from `s.fit.pins` (sorted by `t`) the first and the last active pin: `{ handle: 'start' | 'end', xz: pin.target, y: s.pins[pin.index]?.y ?? null }`. 14. `followMap`: replace the pick logic. While `s.surface?.kind === 'map'` and a projection exists, publish (a) the path overlay when `s.pins.length >= 2` (as today, rebuilt only when the fit changes), (b) `walkNowMapOverlay` as today, (c) `walkPreviewMapOverlay(layer.id, s.preview.xz, proj, colour, s.preview.ghost, s.preview.tooClose)` when `s.preview` is set; and hold one stable pointer session for the life of that session:

```ts
const pointer: MapPointerSession = {
  onMove: (local) => {
    session.getState().hover(local ? [local[0], local[2]] : null, local?.[1]);
  },
  onClick: (local) => {
    if (wantsSurfaceClick(session.getState()))
      session.getState().click([local[0], local[2]], local[1]);
  },
  handles: () =>
    sessionHandles(session.getState()).map((h) => ({
      id: h.handle,
      local: [h.xz[0], h.y ?? 0, h.xz[1]] as Vec3,
    })),
  onDrag: (id, local) => {
    if (id === 'start' || id === 'end')
      session.getState().dragHandle(id, [local[0], local[2]], local[1]);
  },
  onDragEnd: () => {
    session.getState().endDrag();
  },
  onCancel: () => {
    const s = session.getState();
    if (s.armed === 'move' && s.moving !== null) s.armMove(s.moving);
  },
};
```

`setWalkMapPointer(pointer)` when the map session starts, `setWalkMapPointer(null)` in `clear()` when it is ours. 15. The app's `openSurface(layerId, host, fineTune)`:

```ts
export function surfaceLayout(
  saved: SplitPref | undefined,
  host: PlaceSurface,
  fineTune: boolean,
): { mode: StageMode; split?: SplitPref } {
  const kind: PaneKind = host.kind === 'drawing' ? 'raster' : host.kind;
  const raster = host.kind === 'drawing' ? { raster: host.id } : {};
  if (fineTune) {
    const withWalk = splitWithWalk(saved, PANE_KINDS);
    const other = sideOf(withWalk, 'walk360') === 'left' ? 'right' : 'left';
    return { mode: 'split', split: { ...withWalk, [other]: kind, ...raster } };
  }
  if (host.kind !== 'drawing') return { mode: host.kind };
  // a drawing shows only in the split: beside the 3D view, never beside the 360 video
  const sides = resolveSplit(saved, PANE_KINDS);
  const side = sideOf(sides, 'raster') ?? 'left';
  const other = side === 'left' ? 'right' : 'left';
  const keep = sides[other];
  const otherKind: PaneKind = keep === 'walk360' || keep === 'raster' ? '3d' : keep;
  return {
    mode: 'split',
    split: { ...sides, [side]: 'raster', [other]: otherKind, raster: host.id },
  };
}

function openSurface(layerId: string, host: PlaceSurface, fineTune: boolean): void {
  const project = workspace.getState().project;
  if (!project) return;
  walks.getState().select(layerId);
  const sh = shell.getState();
  if (sh.screen !== 'scene') sh.go('scene');
  const saved = stagePrefs.getState().byProject[project.id]?.split;
  const { mode, split } = surfaceLayout(saved, host, fineTune);
  if (split) stagePrefs.getState().update(project.id, { split });
  if (sh.stageMode !== mode) sh.setStageMode(mode);
}
```

(`StageMode` from where `shell` types it; `resolveSplit`, `PaneKind`, `SplitPref` from `../workspace/splitModel`.) 16. The app's deps: `job: (l) => { const root = workspace.getState().project?.root; return root === undefined ? undefined : jobForWalk(jobs.getState().jobs, root, walkFolderId(l)); }`; `modelSurface`: `'map'` when `shell.getState().stageMode === 'map'`, or the split shows a map side (`resolveSplit(stagePrefs…split, PANE_KINDS)`), else `'3d'`; `process`: `const record = walks.getState().records[walkRecordKey(l)]; if (!record) return 'The walk is not listed yet.'; if (record.source.layout === 'equirect') return processWalk(l.id, { walk: walkFolderId(l) }); const r = await locateOriginal(record); if (!r) return null; if ('error' in r) return r.error; return processWalk(l.id, { walk: walkFolderId(l), src: [r.path] });`. 17. Register: `setRemovePlacementHandler((id) => placeFlow.removePlacement(id));` and on `workspace.subscribe` also `void placeFlow.pathChanged();`. 18. `usePlacingOn(kind)`: `useStore(placeUi, (s) => s.layerId !== null && s.host?.kind === kind)`. `usePlacedWalksOnMap`'s `except` reads `s.surface?.kind === 'map'` as today.

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm --filter @aio/desktop exec vitest run src/renderer/walks/placeWalk.test.ts src/renderer/walks/walkMapStore.test.ts src/renderer/walks/walks.test.ts src/renderer/walks/placeStore.test.ts`
Expected: PASS. (`PlaceWalkStrip.tsx` and `Stage.tsx` may still fail typecheck until T9 and T10.)

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/walks/placeWalk.ts apps/desktop/src/renderer/walks/placeWalk.test.ts apps/desktop/src/renderer/walks/walkMapStore.ts apps/desktop/src/renderer/walks/walkMapStore.test.ts apps/desktop/src/renderer/walks/walks.ts apps/desktop/src/renderer/walks/walks.test.ts
git commit -m "feat(walks): place flow with the path check, surfaces, map pointer, fine-tune and Remove placement" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The placing toolbar (`PlaceWalkStrip.tsx`)

Load the design skills first (`impeccable`, `frontend-design`): the toolbar is slim, one line where it can be, the current step's hint first, the primary action (Save) last.

**Files:**

- Modify: `apps/desktop/src/renderer/walks/PlaceWalkStrip.tsx` (whole component; `useWalksOnDrawing` `:511-586`; delete `usePlacingOnMap` `:589-591`)
- Modify: `apps/desktop/src/renderer/walks/placeWalk.css`
- Test: `apps/desktop/src/renderer/walks/PlaceWalkStrip.test.tsx`

**Interfaces:**

- Consumes: T5 session; T8 flow (`pathState`, `process`, `placeAnyway`, `fineTune`, `setDate`, `removePlacement`, `wantsSurfaceClick`, `sessionHandles`); T4 `previewOnSheet`, `SheetPreview`, roles; `useJobs` from `../shell` (re-render on job progress); `packOffersWalkProcess` and `useProcessingTools` (as `WalkProcessLine.tsx` uses them).
- Produces test ids (used by T11):

| Id                                                                                                   | What                                                      |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `walk-place-strip`                                                                                   | the toolbar, `data-step` = the session step               |
| `walk-place-hint`                                                                                    | the hint line (`role="status"`)                           |
| `walk-place-notice`                                                                                  | the path notice (step `check`), `data-state` = path state |
| `walk-place-process`                                                                                 | Process walk / Process again                              |
| `walk-place-anyway`                                                                                  | Place between two points anyway                           |
| `walk-place-on`                                                                                      | Place on select                                           |
| `walk-place-date-field`                                                                              | Survey date select (only when the walk has none)          |
| `walk-place-finetune`                                                                                | Fine-tune toggle (`aria-pressed`)                         |
| `walk-place-remove`                                                                                  | Remove placement (only for a saved placement)             |
| `walk-place-remove-yes`                                                                              | its inline confirm                                        |
| `walk-place-save`, `walk-place-cancel`, `walk-place-discard`, `walk-place-keep`                      | as today                                                  |
| `walk-place-pin`, `walk-place-pin-move`, `walk-place-pin-here`, `walk-place-align`, `walk-place-yaw` | fine-tune row, as today                                   |
| `walk-place-pins-only`                                                                               | the note after Place anyway                               |

Copy (constants in the file, no dashes):

```ts
const SAY = {
  start: 'Click where the walk started. Its shape follows the pointer.',
  end: 'Click where the walk ended.',
  tooClose: 'Put the end at least 5 m from the start.',
  placed: 'Drag Start or End to adjust the walk, then Save.',
  dragRefused: 'Start and End stay at least 5 m apart.',
  fineTune: 'Scrub to a moment, then Pin here and click the true spot.',
  pin: 'Click the true spot for this moment.',
  align360: 'Click a landmark in the 360 view',
  alignSurface: 'Now click the same landmark here',
  pinsOnly: 'Path not computed: the walk is placed between your two points.',
  keep: 'Keep these changes?',
  removeAsk: 'Remove this placement? The walk stays in the project.',
  noImagery:
    'No satellite imagery here. Turn on Online satellite in the map type picker, or import an imagery pack.',
  orthoOff: 'Your orthomosaic is switched off.',
} as const;

const NOTICE: Record<Exclude<WalkPathState, 'ready'>, string> = {
  none: 'This walk is not processed yet, so its path is unknown.',
  running: 'This walk is processing. Its shape appears here when it finishes.',
  failed: 'Processing this walk failed, so its path is unknown.',
  interrupted: 'Processing stopped before the path was computed.',
};
```

- [ ] **Step 1: Write the failing tests** (rewrite `PlaceWalkStrip.test.tsx` around a real flow with fake deps, as the file does today)

```ts
it('a walk with no path shows the notice with Process walk and Place anyway, and no line', async () => {
  await open(walkWithoutPath, { job: () => ({ status: 'interrupted', progress: 0.31 }) });
  const notice = q('[data-testid="walk-place-notice"]');
  expect(notice?.getAttribute('data-state')).toBe('interrupted');
  expect(notice?.textContent).toContain('Processing stopped before the path was computed.');
  expect(q('[data-testid="walk-place-process"]')?.textContent).toBe('Process again');
  click(q('[data-testid="walk-place-anyway"]'));
  expect(q('[data-testid="walk-place-strip"]')?.getAttribute('data-step')).toBe('start');
});

it('Process walk on a walk never processed', async () => {
  const process = vi.fn(() => Promise.resolve(null));
  await open(walkWithoutPath, { process });
  expect(q('[data-testid="walk-place-process"]')?.textContent).toBe('Process walk');
  click(q('[data-testid="walk-place-process"]'));
  expect(process).toHaveBeenCalledTimes(1);
});

it('the hint follows the steps and says when the end is too close', async () => {
  const { session } = await open(walkWithPath);
  expect(hint()).toBe(SAY_START);
  act(() => {
    session.getState().click([0, 0], 0);
  });
  expect(hint()).toBe('Click where the walk ended.');
  act(() => {
    session.getState().hover([2, 0], 0);
  });
  expect(hint()).toBe('Put the end at least 5 m from the start.');
  act(() => {
    session.getState().click([40, -30], 0);
  });
  expect(hint()).toBe('Drag Start or End to adjust the walk, then Save.');
});

it('the date field shows only for an undated walk and is preselected', async () => {
  await open(walkWithPath({ capture: undefined }));
  expect((q('[data-testid="walk-place-date-field"]') as HTMLSelectElement | null)?.value).toBe(
    'c1',
  );
  await open(walkWithPath({ capture: 'c1' }));
  expect(q('[data-testid="walk-place-date-field"]')).toBeNull();
});

it('Fine-tune is offered once placed and shows the pin tools', async () => {
  const { session } = await open(walkWithPath);
  expect((q('[data-testid="walk-place-finetune"]') as HTMLButtonElement | null)?.disabled).toBe(
    true,
  );
  act(() => {
    session.getState().click([0, 0], 0);
    session.getState().click([40, -30], 0);
  });
  click(q('[data-testid="walk-place-finetune"]'));
  expect(q('[data-testid="walk-place-pin-here"]')).not.toBeNull();
  expect(q('[data-testid="walk-place-finetune"]')?.getAttribute('aria-pressed')).toBe('true');
});

it('Remove placement shows only for a saved placement and asks inline', async () => {
  const save = vi.fn(() => Promise.resolve(null));
  await open(placedWalk, { save });
  click(q('[data-testid="walk-place-remove"]'));
  expect(q('[data-testid="walk-place-strip"]')?.textContent).toContain(
    'Remove this placement? The walk stays in the project.',
  );
  click(q('[data-testid="walk-place-remove-yes"]'));
  await flush();
  expect(save).toHaveBeenCalledWith('walk-a', { walk: null });
});

it('Cancel with changes asks "Keep these changes?"', async () => {
  const { session } = await open(walkWithPath);
  act(() => {
    session.getState().click([0, 0], 0);
  });
  click(q('[data-testid="walk-place-cancel"]'));
  expect(q('[data-testid="walk-place-strip"]')?.textContent).toContain('Keep these changes?');
});
```

Keep the existing tests of the satellite and orthomosaic notes and of `stripInWalkPane` / `PlaceWalkHere`, with the date step removed. `open(...)` creates the flow with `flowFor`-style fake deps (copy the deps shape from T8), begins it on the 3D surface, and renders `<PlaceWalkStrip flow session ui />`; `hint()` reads `[data-testid="walk-place-hint"]`.

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm --filter @aio/desktop exec vitest run src/renderer/walks/PlaceWalkStrip.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

Structure of `PlaceWalkStrip` (replace the date, surface and Start/End/Correct step UI):

```tsx
  // re-render on job progress so the notice and its button follow the job
  useJobs((s) => s.jobs);
  const offered = useProcessingTools((s) => packOffersWalkProcess(s.status));
  const [askRemove, setAskRemove] = useState(false);
  ...
  if (u.asking) return /* as today, with SAY.keep */;

  const hint =
    problem ??
    (st.step === 'end' && st.preview?.tooClose
      ? SAY.tooClose
      : st.dragging?.refused
        ? SAY.dragRefused
        : st.step === 'fine-tune'
          ? st.armed === 'align-360' ? SAY.align360
            : st.armed === 'align-surface' ? SAY.alignSurface
            : st.armed === 'move' && st.moving !== null ? moveSay(st.moving)
            : st.armed === 'pin' ? SAY.pin
            : SAY.fineTune
          : st.step === 'check' ? NOTICE[pathState === 'ready' ? 'none' : pathState]
          : SAY[st.step]);

  return (
    <div className="dplace wplace" role="group" aria-label={`Place ${walk.name}`} data-testid="walk-place-strip" data-step={st.step}>
      <div className="dplace-row">
        <p className={problem ? 'dplace-say bad' : 'dplace-say'} role="status" data-testid="walk-place-hint">{hint}</p>
        {/* Place on, the date field when the walk has none, Fine-tune, Remove placement, Cancel, Save */}
      </div>
      {st.step === 'check' && (
        <div className="dplace-row wplace-notice">
          {pathState !== 'running' && (
            <button type="button" className="btn primary sm" data-testid="walk-place-process"
              disabled={!offered || u.saving} aria-describedby={offered ? undefined : hintId}
              onClick={() => void flow.process()}>
              {pathState === 'none' ? 'Process walk' : 'Process again'}
            </button>
          )}
          <button type="button" className="btn ghost sm" data-testid="walk-place-anyway" onClick={() => { flow.placeAnyway(); }}>
            Place between two points anyway
          </button>
          {!offered && <span className="faint" id={hintId}>{t('walk.process.needsPack')}</span>}
        </div>
      )}
      {st.step === 'fine-tune' && /* today's pins row: chips, Pin here, Align view, Heading */}
      {askRemove && /* inline: SAY.removeAsk, "Remove placement" (walk-place-remove-yes), "Keep it" */}
      {/* the ortho and imagery notes as today; the pins-only note when the walk was placed anyway */}
    </div>
  );
```

- On the `check` step the hint line and the button row sit together inside one `<div data-testid="walk-place-notice" data-state={pathState}>`, so the notice's text is the hint (`NOTICE[pathState]`, one source of the sentence) followed by its buttons. The sketch above shows them apart for reading; build them as one wrapper.
- **Save**: `disabled={st.pins.length < 2 || u.saving || refused || st.step === 'check'}`.
- **Fine-tune**: `aria-pressed={st.step === 'fine-tune'}`, `disabled={st.step !== 'placed' && st.step !== 'fine-tune'}`, `onClick={() => { flow.fineTune(st.step !== 'fine-tune'); }}`.
- **Remove placement**: shown when `walk.place !== undefined`; `onClick={() => { setAskRemove(true); }}`; yes calls `void flow.removePlacement()`.
- **Date field**: shown when `walk.capture === undefined`; options from `flow.dates()` (`pick` by id with their label; `add` as `add:${add}` labelled `Add survey date ${formatDate(add)}`; plus `No survey date` with value `''` when there is no choice); `value={u.date ?? ''}`; `onChange={(e) => { flow.setDate(e.target.value === '' ? null : e.target.value); }}`.
- **Place on**: as today, with `surfaceLabel`.
- Esc lets go of a pin waiting to be moved (as today), and while `st.step === 'end'` Esc removes the start pin (`session.getState().removePin(0)`), back to Start.

`useWalksOnDrawing(layerId, size)`:

- `pick` while the session is on this drawing and `wantsSurfaceClick(s) || s.step === 'start' || s.step === 'end'`: `onPick: (px) => placeSession.getState().click(px)`, `onHover: (px) => placeSession.getState().hover(px)`, `marks: NO_MARKS`.
- `preview`: `frame && s.preview ? previewOnSheet(s.preview.xz, frame, s.preview.ghost, s.preview.tooClose) : null` (frame from `surfaceFramesOf` as today), passed to `WalkSheetOverlay`.
- Drags: `onPinDrag={(_id, i, px, role) => { if (role === 'pin') placeSession.getState().movePin(i, px); else placeSession.getState().dragHandle(role, px); }}` and `onPinDragEnd={(_id, i, px, role) => { if (role === 'pin') placeSession.getState().movePin(i, px); placeSession.getState().endDrag(); }}`.

`placeWalk.css`: add `.pane-3d.walk-placing` with the same rules as `.pane-map.walk-placing` (`:44-54`); a `.wplace-notice` row style; keep the strip one row tall at 1100 px wide where it fits (wrap below that).

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm --filter @aio/desktop exec vitest run src/renderer/walks/PlaceWalkStrip.test.tsx src/renderer/walks/` (the whole folder)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/walks/PlaceWalkStrip.tsx apps/desktop/src/renderer/walks/PlaceWalkStrip.test.tsx apps/desktop/src/renderer/walks/placeWalk.css
git commit -m "feat(walks): slim placing toolbar with the path notice, date field, Fine-tune and Remove placement" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: App wiring, the 3D mount, the tree row and the guide

**Files:**

- Create: `apps/desktop/src/renderer/walks/WalkSceneMount.tsx`
- Create: `apps/desktop/src/renderer/walks/WalkSceneMount.test.ts` (the pure `scenePlacing` helper)
- Modify: `apps/desktop/src/renderer/workspace/Stage.tsx` (imports `:90-92`, `ScenePane` `:135-175`, `MeasureMount` area `:369`, map pane `:651-655` and `:854-870`)
- Modify: `apps/desktop/src/renderer/shell/Sidebar.tsx` (`walkActions` `:429-452`)
- Modify: `docs/guide/08-building-projects.md` (`:72-84`), `docs/TESTING.md` (Walks W2 rows, `:50`, `:1167-1198`)

**Interfaces:**

- Consumes: T6 `placed`, `onRemovePlacement`; T7 `attachWalkScene`, `sceneRuns`, `previewPoints`, `WalkScenePlacing`; T8 `placeSession`, `placeUi`, `sessionHandles`, `wantsSurfaceClick`, `usePlacingOn`, `usePlacedWalkFits`, `useHiddenLayers`, `walkColour`, `useWalkMapPointer`, `removeWalkPlacement`; T3 `SCENE_SURFACE`, `MAP_SURFACE`.
- Produces:

```ts
// WalkSceneMount.tsx
export function scenePlacing(
  s: Pick<PlaceState, 'layerId' | 'step' | 'surface' | 'fit' | 'pins' | 'preview' | 'armed'>,
  colour: string,
  durationS: number,
): WalkScenePlacing | null; // null unless the session places on 3D
export function WalkSceneMount({ stage }: { stage: EngineStage | null }): null;
```

- [ ] **Step 1: Write the failing test**

```ts
import { fitWalk } from '@aio/geo';
import type { WalkPin } from '@aio/schema';
import { describe, expect, it, vi } from 'vitest';

// the mount's module graph reaches the shell and the builder: stub them as placeWalk.test.ts does
vi.mock('../shell', () => ({
  bridge: { call: vi.fn() },
  shell: { getState: () => ({ screen: 'scene', stageMode: '3d', go: vi.fn() }) },
  jobs: { getState: () => ({ jobs: [], start: vi.fn() }), subscribe: () => () => undefined },
}));
vi.mock('../builder/state', () => ({
  builder: { getState: () => ({ saveLayers: vi.fn() }), subscribe: () => () => undefined },
}));

const { scenePlacing } = await import('./WalkSceneMount');

describe('scenePlacing', () => {
  const pins: WalkPin[] = [
    { t: 0, surface: '@model', at: [0, 0], y: 1 },
    { t: 10, surface: '@model', at: [10, 0], y: 1 },
  ];
  const fit = fitWalk(null, { pins, yawOffsetDeg: 0 }, { drawing: () => null }, 10);
  const base = {
    layerId: 'walk-a',
    surface: { kind: '3d' } as const,
    fit,
    pins,
    preview: null,
    armed: null,
  };

  it('nothing unless the session places on the 3D view', () => {
    expect(
      scenePlacing({ ...base, surface: { kind: 'map' }, step: 'placed' }, '#fff', 10),
    ).toBeNull();
    expect(scenePlacing({ ...base, layerId: null, step: 'placed' }, '#fff', 10)).toBeNull();
  });

  it('placed: the path and two handles at the pins, no clicks wanted', () => {
    const p = scenePlacing({ ...base, step: 'placed' }, '#fff', 10);
    expect(p?.handles.map((h) => h.id)).toEqual(['start', 'end']);
    expect(p?.handles[0]?.at).toEqual([0, 1, 0]);
    expect(p?.walk?.runs.length).toBeGreaterThan(0);
    expect(p?.clicks).toBe(false);
  });

  it('start: a click is wanted and the ghost is drawn at its height', () => {
    const p = scenePlacing(
      {
        ...base,
        pins: [],
        step: 'start',
        preview: {
          xz: [
            [0, 0],
            [1, 0],
          ],
          ghost: true,
          tooClose: false,
          y: [2, 2],
        },
      },
      '#fff',
      10,
    );
    expect(p?.clicks).toBe(true);
    expect(p?.walk).toBeNull();
    expect(p?.preview?.pts[0]?.[1]).toBeCloseTo(2.1);
  });
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `pnpm --filter @aio/desktop exec vitest run src/renderer/walks/WalkSceneMount.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the implementation**

`WalkSceneMount.tsx`:

```tsx
import type { EngineStage } from '@aio/engine';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useRef } from 'react';
import type { PlaceState } from './placeStore';
import {
  placeSession,
  sessionHandles,
  useHiddenLayers,
  usePlacedWalkFits,
  walkColour,
  wantsSurfaceClick,
} from './placeWalk';
import { resolveCssColour } from './walkMapOverlay';
import {
  attachWalkScene,
  previewPoints,
  sceneRuns,
  type WalkSceneInput,
  type WalkScenePlacing,
  type WalkSceneView,
} from './walkScene';

/*
 * The walks in the 3D view: every visible placed walk faintly, and the walk being placed on the
 * 3D view with its preview and handles (`walkScene.ts`), fed from the Place walk session.
 */

export function scenePlacing(
  s: Pick<PlaceState, 'layerId' | 'step' | 'surface' | 'fit' | 'pins' | 'preview' | 'armed'>,
  colour: string,
  durationS: number,
): WalkScenePlacing | null {
  if (s.layerId === null || s.surface?.kind !== '3d') return null;
  const placed = s.pins.length >= 2 && s.fit !== null;
  return {
    walk: placed && s.fit ? { id: s.layerId, colour, runs: sceneRuns(s.fit, durationS) } : null,
    preview: s.preview
      ? {
          pts: previewPoints(s.preview.xz, s.preview.y),
          ghost: s.preview.ghost,
          tooClose: s.preview.tooClose,
        }
      : null,
    handles: sessionHandles(s).map((h) => ({ id: h.handle, at: [h.xz[0], h.y ?? 0, h.xz[1]] })),
    clicks: wantsSurfaceClick(s),
  };
}

const INPUT: WalkSceneInput = {
  hover: (at, y) => {
    placeSession.getState().hover(at, y);
  },
  click: (at, y) => {
    placeSession.getState().click(at, y);
  },
  drag: (h, at, y) => {
    placeSession.getState().dragHandle(h, at, y);
  },
  endDrag: () => {
    placeSession.getState().endDrag();
  },
};

export function WalkSceneMount({ stage }: { stage: EngineStage | null }): null {
  const view = useRef<WalkSceneView | null>(null);
  const manifest = useWorkspace((s) => s.project?.manifest);
  const hidden = useHiddenLayers();
  const { fits } = usePlacedWalkFits();

  useEffect(() => {
    if (!stage) return;
    const v = attachWalkScene(stage);
    view.current = v;
    const push = () => {
      const s = placeSession.getState();
      const m = manifest;
      const layer = m?.layers.find((l) => l.kind === 'walk' && l.id === s.layerId);
      const colour =
        m && layer?.kind === 'walk' ? resolveCssColour(walkColour(m, layer)) : '#ffffff';
      const p = scenePlacing(s, colour, layer?.kind === 'walk' ? layer.durationS : 0);
      v.setPlacing(p, p ? INPUT : null);
    };
    push();
    const off = placeSession.subscribe(push);
    return () => {
      off();
      v.dispose();
      view.current = null;
    };
  }, [stage, manifest]);

  useEffect(() => {
    const v = view.current;
    if (!v || !manifest) return;
    const placingId = placeSession.getState().layerId;
    v.setPlaced(
      fits
        .filter(
          (w) => w.layer.visible !== false && !hidden.has(w.layer.id) && w.layer.id !== placingId,
        )
        .map((w) => ({
          id: w.layer.id,
          colour: resolveCssColour(walkColour(manifest, w.layer)),
          runs: sceneRuns(w.fit, w.layer.durationS),
        })),
    );
  }, [fits, hidden, manifest, stage]);

  return null;
}
```

`Stage.tsx`:

- Imports: `useWalkMapPointer` (replaces `useWalkMapPick`), `PlaceWalkHere` from `../walks/PlaceWalkStrip`, `usePlacedWalksOnMap`, `usePlacingOn` from `../walks/placeWalk`, `MAP_SURFACE`, `SCENE_SURFACE` from `../walks/placeModel` (delete the local `MAP_SURFACE` at `:539`), `WalkSceneMount` from `../walks/WalkSceneMount`.
- `ScenePane`: add `walk-placing` to its class when `usePlacingOn('3d')`, and `<PlaceWalkHere at={SCENE_SURFACE} />` as the first child of the `FocusZone`.
- Next to `<MeasureMount stage={stage} />`: `<WalkSceneMount stage={stage} />`.
- Map pane: `const walkPointer = useWalkMapPointer();`, `const placingOnMap = usePlacingOn('map');`, `<MapView ... pointer={walkPointer} />` (no `pick`).

`Sidebar.tsx` `walkActions`:

```ts
      placed: (it: TreeItem) =>
        project.manifest.layers.some((l) => l.kind === 'walk' && l.id === it.layerId && l.place !== undefined),
      onRemovePlacement: canEdit
        ? (it: TreeItem) => {
            if (it.layerId)
              void removeWalkPlacement(it.layerId)
                .then(failed)
                .catch((e: unknown) => {
                  failed(String(e));
                });
          }
        : undefined,
```

(import `removeWalkPlacement` from `../walks/walks`).

Docs (plain language, no dashes, then `node tools/agent/check-public-text.mjs docs/guide/08-building-projects.md docs/TESTING.md`):

- Guide steps 1 to 6 rewritten: Place walk (or Edit placement on a placed walk); a walk that is not processed shows why and offers Process walk, or Place between two points anyway; the drawing (beside the 3D view), the map or the 3D view; the walk's shape follows the pointer; click the start, then the end, and the shape turns and scales between them; drag Start or End; Save; Fine-tune opens the 360 video with Pin here, Align view and Heading; Remove placement in the row or the toolbar keeps the walk; Remove walk unchanged. Remove the line about pins not draggable on the map and the "Path not computed" line (replace with the note after Place anyway).
- TESTING.md: the Walks W2 row's description and the checklist items `:1167-1198` for the new flow (Edit placement and Remove placement buttons, the notice, the ghost, the handles, the 3D view).

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm --filter @aio/desktop exec vitest run src/renderer/walks/WalkSceneMount.test.ts`, then `pnpm --filter @aio/desktop typecheck` and `pnpm --filter @aio/desktop test`.
Expected: PASS, typecheck green for the app (T9 has landed in the same batch; if T9 is not committed yet, rerun after it is).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/walks/WalkSceneMount.tsx apps/desktop/src/renderer/walks/WalkSceneMount.test.ts apps/desktop/src/renderer/workspace/Stage.tsx apps/desktop/src/renderer/shell/Sidebar.tsx docs/guide/08-building-projects.md docs/TESTING.md
git commit -m "feat(walks): place in the 3D view, map pointer on the stage, Edit and Remove placement on the row" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: End to end specs

**Files:**

- Modify: `apps/desktop/e2e/walkFixture.ts`
- Rewrite: `apps/desktop/e2e/walk-place.spec.ts`
- Create: `apps/desktop/e2e/walk-place-map.spec.ts`, `apps/desktop/e2e/walk-place-3d.spec.ts`

Written in batch 4 against the test ids of T9 and T10; T12 runs them the CI way and fixes what fails. Electron windows stay off-screen through `e2e/fixtures.ts` (do not start apps any other way).

**Interfaces:**

- Produces (in `walkFixture.ts`):

```ts
export interface WalkProjectOptions {
  /** `local` (default): a site grid, no map. `utm`: EPSG 32633 with an origin, so the map works. */
  crs?: 'local' | 'utm';
  /** The placed drawing (default true). */
  drawing?: boolean;
  /** The raw path `walk.process` writes (default true); false: a walk never processed. */
  processed?: boolean;
}
export const UTM = { epsg: 32633, origin: [500_000, 4_000_000, 0] as const };
export function createWalkProject(root: string, opts?: WalkProjectOptions): Promise<string>;
/** The saved pose's bend: the largest distance of a sample from the line through the first and last, metres. */
export function poseBendM(projectDir: string): Promise<number>;
/** The model point of the synthetic walk at its start (t 4) and end (t 62): (0, 0) and (40, -30). */
export const WALK_START: [number, number];
export const WALK_END: [number, number];
// Playwright helpers moved here from walk-place.spec.ts, shared by the three specs:
export function openWalkProject(win: Page): Promise<void>;
export function walkRow(win: Page): Promise<Locator>;
export function rowAction(
  win: Page,
  kind: 'open' | 'place' | 'edit' | 'unplace' | 'remove',
): Promise<void>;
```

- [ ] **Step 1: Extend the fixture**

- `createWalkProject(root, opts = {})`: `crs: 'utm'` writes `crs: { epsg: UTM.epsg }`, `origin: [...UTM.origin]`; `drawing: false` skips the sheet folder and the raster layer; `processed: false` skips copying `raw-path.json` and calls `walkLayerFor(walk, base, { raw: false, orientation: false, points: false })`.
- `poseBendM(dir)`:

```ts
export async function poseBendM(dir: string): Promise<number> {
  const pose = JSON.parse(await readFile(join(dir, 'walks', WALK_ID, 'pose.json'), 'utf8')) as {
    samples: { t: number; pos: [number, number, number] }[];
  };
  const s = pose.samples.filter((x) => x.t >= 4 && x.t <= 62);
  const a = s[0]?.pos;
  const b = s.at(-1)?.pos;
  if (!a || !b) return 0;
  const dx = b[0] - a[0];
  const dz = b[2] - a[2];
  const len = Math.hypot(dx, dz);
  return Math.max(...s.map((x) => Math.abs(dx * (x.pos[2] - a[2]) - dz * (x.pos[0] - a[0])) / len));
}
```

- [ ] **Step 2: Rewrite `walk-place.spec.ts` (drawing)**

Keep `openWalkProject`, `walkRow`, `rowAction` (kinds `open | place | edit | unplace | remove`), `clickSheet` (split into `sheetPoint(win, px)` that returns the page point after fitting, and `clickSheet`), `centreReachesDrawing`, `stripAboveDrawing`. Tests:

1. **"a walk is placed on a drawing by its start and end, adjusted, saved, and its placement removed"**: open; badge `Needs placing`; `rowAction('place')`; strip `data-step="start"` (timeout 30 s), `walk-place-on` value `sheet-ground-floor`, `walk-place-date-field` value `capture-1`; strip above the drawing and centre free; `win.mouse.move` over sheet px `[120, 150]` then expect `raster-view` `walk-preview` with `data-ghost="true"`; click `[100, 175]` (start), `data-step="end"`; move to `[105, 175]` (1 m away), hint `Put the end at least 5 m from the start.`, click there, still `end`; click `[300, 25]`, `data-step="placed"`, `walk-line` visible, `walk-handle-start` and `walk-handle-end` visible; drag the End handle by mouse (`down` on its bounding box centre, `move` 15 px down in 5 steps, `up`), still `placed`; `walk-place-finetune` click: `walk-view` visible and `walk-place-pin-here` visible; click it again: back to `placed`; `walk-place-save`; strip gone (30 s), badge gone, `pose.json` written, manifest `capture` `capture-1`, `place.pins` length 2, `placedOn` `sheet-ground-floor`, `await poseBendM(dir)` greater than 15; then `rowAction('edit')`: strip `data-step="placed"` with both handles; `walk-place-remove` then `walk-place-remove-yes`: strip gone, badge `Needs placing` again, manifest layer has no `place`.
2. **"a walk is removed from its row, and its folder goes to the project trash"**: unchanged.
3. **"a walk that was never processed shows why, offers Process walk and draws no line"**: `createWalkProject(dataRoot.root, { processed: false })`; `rowAction('place')`; strip `data-step="check"`; `walk-place-notice` `data-state="none"` and text `This walk is not processed yet, so its path is unknown.`; `walk-place-process` visible with text `Process walk` (enabled or disabled, the pack may be missing on CI; when disabled the strip shows `Needs a newer pipeline pack`); `walk-place-anyway` visible; move the mouse over the sheet: no `walk-preview`, no `walk-line`; click `walk-place-anyway`: `data-step="start"`.
4. **Smallest window** (`QUADRION_WINDOW_SIZE: '1100x700'`): begin; strip above drawing and centre free at `start`; start and end clicks; at `placed` the same two checks.

- [ ] **Step 3: Write `walk-place-map.spec.ts`**

```ts
/**
 * Placing a walk on the map: a project with a coordinate system and no drawing, the walk placed
 * by its start and end on the map, its End handle dragged, saved; the pose keeps the walk's L.
 * Skipped when ffmpeg with libx264 is missing (CI installs it).
 */
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from './fixtures';
import {
  createWalkProject,
  ffmpegReady,
  openWalkProject,
  poseBendM,
  rowAction,
  UTM,
  WALK_END,
  WALK_LAYER,
  WALK_START,
} from './walkFixture';

interface MapEl extends Element {
  __aioMap: {
    project(ll: [number, number]): { x: number; y: number };
    getContainer(): HTMLElement;
    jumpTo(o: { center: [number, number]; zoom: number }): void;
    loaded(): boolean;
  };
}

/** Lon/lat of a model point (x east, z south) in the fixture's UTM frame. */
async function lonLat(local: [number, number]): Promise<[number, number]> {
  const { toWgs84 } = await import('@aio/geo');
  const ll = toWgs84([UTM.origin[0] + local[0], UTM.origin[1] - local[1], 0], UTM.epsg);
  return [ll[0], ll[1]];
}

/** The page point of a model point on the main map. */
async function mapPoint(win: Page, local: [number, number]): Promise<{ x: number; y: number }> {
  const ll = await lonLat(local);
  return win.evaluate((ll) => {
    const el = [...document.querySelectorAll('*')].find((e) => '__aioMap' in e) as MapEl;
    const p = el.__aioMap.project(ll);
    const r = el.__aioMap.getContainer().getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  }, ll);
}

test.describe('placing a walk on the map', () => {
  test.skip(!ffmpegReady(), 'needs ffmpeg with libx264 on the PATH');

  test('a walk is placed on the map by its start and end, and keeps its shape', async ({
    win,
    dataRoot,
  }) => {
    test.setTimeout(180_000);
    const dir = await createWalkProject(dataRoot.root, { crs: 'utm', drawing: false });
    await win.reload();
    await openWalkProject(win);
    await rowAction(win, 'place');
    const strip = win.getByTestId('walk-place-strip');
    await expect(strip).toHaveAttribute('data-step', 'start', { timeout: 30_000 });
    await expect(strip.getByTestId('walk-place-on')).toHaveValue('@model');
    // frame the walk: the middle of the L at zoom 18 (about 0.25 m a pixel)
    const centre = await lonLat([20, -15]);
    await win.evaluate((c) => {
      const el = [...document.querySelectorAll('*')].find((e) => '__aioMap' in e) as MapEl;
      el.__aioMap.jumpTo({ center: c, zoom: 18 });
    }, centre);
    await win.waitForTimeout(500);
    // the ghost follows the pointer
    const s = await mapPoint(win, WALK_START);
    await win.mouse.move(s.x, s.y);
    // the preview overlay `walk-walk-w1-preview` mounts as layer `aio-ov-<overlay id>-preview`
    await expect
      .poll(() =>
        win.evaluate(() => {
          const el = [...document.querySelectorAll('*')].find(
            (e) => '__aioMap' in e,
          ) as unknown as {
            __aioMap: { getLayer(id: string): unknown };
          };
          return Boolean(el.__aioMap.getLayer('aio-ov-walk-walk-w1-preview-preview'));
        }),
      )
      .toBe(true);
    await win.mouse.click(s.x, s.y);
    await expect(strip).toHaveAttribute('data-step', 'end');
    const e = await mapPoint(win, WALK_END);
    await win.mouse.click(e.x, e.y);
    await expect(strip).toHaveAttribute('data-step', 'placed');
    // drag End 5 m south
    const to = await mapPoint(win, [WALK_END[0], WALK_END[1] + 5]);
    await win.mouse.move(e.x, e.y);
    await win.mouse.down();
    await win.mouse.move(to.x, to.y, { steps: 6 });
    await win.mouse.up();
    await expect(strip).toHaveAttribute('data-step', 'placed');
    await strip.getByTestId('walk-place-save').click();
    await expect(win.getByTestId('walk-place-strip')).toHaveCount(0, { timeout: 30_000 });
    await expect.poll(() => poseBendM(dir)).toBeGreaterThan(15);
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as {
      layers: { id: string; place?: { pins: { at: [number, number] }[]; placedOn?: string } }[];
    };
    const layer = manifest.layers.find((l) => l.id === WALK_LAYER);
    expect(layer?.place?.placedOn).toBe('@model');
    expect(layer?.place?.pins[1]?.at[1]).toBeGreaterThan(-28);
  });
});
```

The overlay layer id follows `mountLayers` in `controller.ts` (`aio-ov-${overlay id}-${layer id}`, `:898`). `openWalkProject`, `walkRow` and `rowAction` move from `walk-place.spec.ts` into `walkFixture.ts` (with the `Page` and `Locator` types and `expect` from `./fixtures`).

- [ ] **Step 4: Write `walk-place-3d.spec.ts`**

Same frame as the map spec, with `createWalkProject(root, { drawing: false })` (local grid: the only surface is the 3D view):

```ts
interface Probe {
  __stratlas: {
    stage(): {
      camera: {
        position: {
          clone(): {
            set(
              x: number,
              y: number,
              z: number,
            ): { project(c: unknown): { x: number; y: number; z: number } };
          };
        };
      };
      renderer: { domElement: HTMLCanvasElement };
      restoreView(
        v: { position: [number, number, number]; target: [number, number, number] },
        animate?: boolean,
      ): void;
      scene: { getObjectByName(n: string): { visible: boolean } | undefined };
    } | null;
  };
}

/** Look straight down on the middle of the L from 120 m, so the whole walk is on screen. */
async function lookDown(win: Page) {
  await win.evaluate(() => {
    (window as unknown as Probe).__stratlas
      .stage()
      ?.restoreView({ position: [20, 120, -14.9], target: [20, 0, -15] }, false);
  });
  await win.waitForTimeout(300);
}

/** The page point of a model point (x, height, z) in the 3D view. */
async function scenePoint(win: Page, p: [number, number, number]) {
  return win.evaluate((p) => {
    const st = (window as unknown as Probe).__stratlas.stage();
    if (!st) throw new Error('no stage');
    const v = st.camera.position.clone().set(p[0], p[1], p[2]).project(st.camera);
    const r = st.renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  }, p);
}
```

Steps: open, Place walk, strip `data-step="start"`, `walk-place-on` value `@model`, stage mode 3D pressed in the "Stage tools" toolbar; wait for the scene canvas; `lookDown`; move the mouse over `[0, 0, 0]`: `scene.getObjectByName('aio-walk-preview')?.visible` polls true; click start `[0, 0, 0]`, end `[40, 0, -30]`, `data-step="placed"`; drag the End handle from `[40, 0.1, -30]` to `[40, 0, -25]` (mouse down, 6 steps, up); Save; strip gone; `poseBendM(dir)` greater than 15; manifest `placedOn` `@model`; and `document.elementFromPoint` at the scene pane's centre is the canvas (the toolbar does not cover the view).

- [ ] **Step 5: Check the specs load and commit**

Run (from `apps/desktop`): `npx playwright test e2e/walk-place.spec.ts e2e/walk-place-map.spec.ts e2e/walk-place-3d.spec.ts --list` and `pnpm --filter @aio/desktop typecheck`.
Expected: the specs list; typecheck green. The full CI-way run is T12.

```bash
git add apps/desktop/e2e/walkFixture.ts apps/desktop/e2e/walk-place.spec.ts apps/desktop/e2e/walk-place-map.spec.ts apps/desktop/e2e/walk-place-3d.spec.ts
git commit -m "test(e2e): place a walk by start and end on a drawing, the map and the 3D view" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Verification

**Files:** none new; fixes go into the file of the task they belong to, committed with that task's scope (`fix(walks): ...`).

- [ ] **Step 1: Repo checks**

Run (worktree root): `pnpm check`
Expected: lint, format check, typecheck and unit tests green. Fix anything red at its source.

- [ ] **Step 2: Demos and e2e the CI way** (PowerShell, from `apps/desktop`; ask the founder for a window first if the PC is in use, and run nothing else in Playwright at the same time)

```powershell
pnpm demo:build --quick --python "E:\Dev\AIO Software\python\.venv\Scripts\python.exe"
$env:QUADRION_E2E_PYTHON = 'E:\Dev\AIO Software\python\.venv\Scripts\python.exe'
$env:QUADRION_WINDOW_SIZE = '1100x720'
$env:QUADRION_E2E_SCALE = '1'
$env:QUADRION_E2E_SWGL = 'warp'
npx playwright test e2e/walk-place.spec.ts e2e/walk-place-map.spec.ts e2e/walk-place-3d.spec.ts e2e/walk-import-stitched.spec.ts e2e/walk-360.spec.ts --workers=1
```

Expected: every test passes; the log prints `[e2e] window 1100 x 720 px at display scale 1`. Run the three new or rewritten specs once more with `--repeat-each=3` to catch timing. `walk-360.spec.ts` is included because it shares the walk fixture and the 360 pane.

- [ ] **Step 3: Public text and dashes**

Run: `node tools/agent/check-public-text.mjs docs/plans/2026-10-13-walk-start-end-placing.md docs/guide/08-building-projects.md docs/TESTING.md` and search the changed UI strings for the characters U+2013 and U+2014 (`git diff main -- apps packages | rg "[\x{2013}\x{2014}]"`).
Expected: clean.

- [ ] **Step 4: Independent review**

Dispatch one reviewer (strongest model, high effort) over `git diff main...HEAD` against the spec and this plan's Review Focus; fix what it finds, rerun Steps 1 and 2 for the touched areas.

- [ ] **Step 5: Hand-off**

Report to the founder with the "How to test" walkthrough below. Merging follows `CLAUDE.md` ("Every session merges its own branch, one at a time").

### Task 13: Stitched 360 videos on every import route, and where each file went

Founder's addition (13 Oct). A stitched Insta360 export (HEVC 5760 x 2880 with "Spherical Mapping: projection equirectangular") dropped or added through Add data or a folder import was skipped without a word: only the **Add 360 video** picker sets `as360` (`packages/project/src/builder/raw.ts:472`), so the MP4 fell to the drone clip branch (`raw.ts:532-542`) and was skipped for want of an SRT, without being read. A drop made while another import ran or was being prepared was dropped silently (`apps/desktop/src/renderer/builder/state.ts:225`, `:228`, `:232`), and the import panel only said "Imported 0 of 1 files" (`ImportPanel.tsx:265`).

**Files:**

- Modify: `packages/project/src/builder/walkSource.ts` (add `isStitched360` after `classifyWalkSource`, `:106-160`)
- Modify: `packages/project/src/builder/raw.ts` (`is360` `:472`, the skip message `:536-542`)
- Modify: `apps/desktop/src/renderer/builder/state.ts` (`BuilderState` `:24-90`, `importFiles` `:219-340`, `confirmHeights` `:392-397`, `cancelHeights`)
- Create: `apps/desktop/src/renderer/builder/importSummary.ts`, `apps/desktop/src/renderer/builder/importSummary.test.ts`
- Modify: `apps/desktop/src/renderer/builder/ImportPanel.tsx` (drop overlay `:85-89`, header `:259-266`, rows `:338-347`)
- Tests: `packages/project/src/builder/walkSource.test.ts`, `packages/project/src/builder/rawWalks.test.ts` (replace "takes an MP4 as 360 video only when asked to" `:165-179`), `apps/desktop/src/renderer/builder/state.test.ts`
- Create: `apps/desktop/e2e/walk-import-stitched.spec.ts`

No file is shared with T1 to T12 (checked against every task's file list). `walkFixture.ts` is only imported (`ffmpegReady`, `createWalkProject`, `WALK_PROJECT`, all there today), never edited here, so the spec does not wait for T11's fixture options or helpers.

**Interfaces:**

- Consumes: `classifyWalkSource`, `WalkTrack` (`walkSource.ts`); `WalkTools.tracks` (`walks.ts:51`); `ImportItem` (`@aio/schema` `builder.ts:161`, read only).
- Produces:

```ts
// walkSource.ts
/** A stitched 360 export: an MP4 or MOV whose picture is equirectangular (spherical metadata or a 2:1 frame). */
export function isStitched360(name: string, tracks: readonly WalkTrack[]): boolean;
// raw.ts
export const NO_SRT_MESSAGE: string;
// state.ts, BuilderState gains
/** Drops and picks waiting for the running import, in order. */
queued: number;
/** Why a drop is waiting ("An import is running. ..."), or null. */
importNotice: string | null;
// importSummary.ts
export function importDestination(item: ImportItem, layers: readonly Layer[]): string;
export function importHeadline(items: readonly ImportItem[]): string;
export const QUEUED_NOTE: string;
```

Copy (no dashes):

```ts
export const NO_SRT_MESSAGE =
  'No DJI SRT telemetry with the same name next to the video; a drone clip needs it to be placed. A 360 video must be a stitched equirectangular export, or use Add 360 video.';
export const QUEUED_NOTE = 'An import is running. These files are imported when it finishes.';
```

- [ ] **Step 1: Write the failing tests**

`walkSource.test.ts`:

```ts
describe('isStitched360', () => {
  const v = (
    width: number,
    height: number,
    spherical: WalkTrack['spherical'] = null,
  ): WalkTrack => ({
    handler: 'vide',
    width,
    height,
    codec: 'hvc1',
    fps: 30,
    durationMs: 2000,
    spherical,
  });

  it('an MP4 or MOV with equirectangular metadata or a 2:1 frame is a stitched 360 video', () => {
    expect(isStitched360('VID_20261013_export.mp4', [v(5760, 2880, 'equirectangular')])).toBe(true);
    expect(isStitched360('tour.MOV', [v(3840, 1920)])).toBe(true);
  });

  it('a 16:9 clip, a non equirectangular sphere, a camera file or no video is not', () => {
    expect(isStitched360('DJI_0001.mp4', [v(3840, 2160)])).toBe(false);
    expect(isStitched360('cube.mp4', [v(3840, 1920, 'other')])).toBe(false);
    expect(isStitched360('VID_1.insv', [v(2880, 2880), v(2880, 2880)])).toBe(false);
    expect(isStitched360('audio.mp4', [])).toBe(false);
  });
});
```

`rawWalks.test.ts` (replaces the test at `:165-179`; `vide` gains an optional fourth argument `spherical`):

```ts
it('a stitched 360 MP4 without an SRT is a walk on every route, not a skipped drone clip', async () => {
  const root = await project();
  const tools = walkTools({
    'tour.mp4': [vide(256, 128, 'avc1')],
    'export.mp4': [vide(5760, 2880, 'hvc1', 'equirectangular')],
  });
  const r = await importRawFiles(
    root,
    [await src('tour.mp4'), await src('export.mp4')],
    deps({ walk: tools }),
  );
  expect(r.items).toEqual([
    expect.objectContaining({ file: 'tour.mp4', kind: 'video', status: 'imported' }),
    expect.objectContaining({ file: 'export.mp4', kind: 'video', status: 'imported' }),
  ]);
  expect((await readdir(join(root, 'walks'))).sort()).toEqual(['export', 'tour']);
  expect(r.manifest.layers.filter((l) => l.kind === 'walk')).toHaveLength(2);
});

it('a 16:9 MP4 without an SRT is skipped, and the reason names Add 360 video', async () => {
  const root = await project();
  const tools = walkTools({ 'DJI_0001.mp4': [vide(3840, 2160, 'avc1')] });
  const r = await importRawFiles(root, [await src('DJI_0001.mp4')], deps({ walk: tools }));
  expect(r.items[0]).toMatchObject({ kind: 'video', status: 'skipped', message: NO_SRT_MESSAGE });
  expect(r.items[0]?.message).toContain('Add 360 video');
  expect(r.manifest.layers.some((l) => l.kind === 'walk')).toBe(false);
});

it('an MP4 that cannot be read is skipped as before', async () => {
  const root = await project();
  const r = await importRawFiles(root, [await src('broken.mp4')], deps({ walk: walkTools({}) }));
  expect(r.items[0]).toMatchObject({ status: 'skipped', message: NO_SRT_MESSAGE });
});

it('an MP4 with its SRT stays a drone clip and is never read for 360', async () => {
  const root = await project();
  const tools = walkTools({ 'DJI_0002.mp4': [vide(256, 128, 'avc1')] });
  const tracks = vi.spyOn(tools, 'tracks');
  await src('DJI_0002.SRT');
  const r = await importRawFiles(
    root,
    [await src('DJI_0002.mp4'), join(dir, 'DJI_0002.SRT')],
    deps({ walk: tools }),
  );
  expect(tracks).not.toHaveBeenCalled();
  // the drone branch: this test build has no video tools
  expect(r.items[0]).toMatchObject({
    file: 'DJI_0002.mp4',
    status: 'error',
    message: 'Video import is not available in this build.',
  });
});

it('Add 360 video still takes any MP4 as 360', async () => {
  const root = await project();
  const tools = walkTools({ 'tour.mp4': [vide(256, 128, 'avc1')] });
  const r = await importRawFiles(root, [await src('tour.mp4')], deps({ walk: tools, as360: true }));
  expect(r.items[0]).toMatchObject({ status: 'imported' });
});
```

(Import `vi` from vitest and `NO_SRT_MESSAGE` from `./raw`.)

`importSummary.test.ts`:

```ts
import type { ImportItem, Layer } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { importDestination, importHeadline } from './importSummary';

const walk = { kind: 'walk', id: 'walk-tour', name: 'tour' } as Layer;
const clip = { kind: 'video', id: 'clip-a', name: 'a' } as Layer;
const row = (over: Partial<ImportItem>): ImportItem => ({
  file: 'f.mp4',
  kind: 'video',
  status: 'imported',
  ...over,
});

describe('where each file went', () => {
  it('names the group a file was added to', () => {
    expect(importDestination(row({ layerId: 'walk-tour' }), [walk, clip])).toBe(
      'Added as a walk under 360 walks',
    );
    expect(importDestination(row({ layerId: 'clip-a' }), [walk, clip])).toBe(
      'Added to Datasets, Video',
    );
    expect(importDestination(row({ kind: 'photo', layerId: 'photos' }), [])).toBe(
      'Added to Datasets, Photos',
    );
  });

  it('says why a file was skipped or failed, and what waits for processing', () => {
    expect(importDestination(row({ status: 'skipped', message: 'No DJI SRT.' }), [])).toBe(
      'Skipped: No DJI SRT.',
    );
    expect(importDestination(row({ status: 'error', message: 'Disk full.' }), [])).toBe(
      'Failed: Disk full.',
    );
    expect(importDestination(row({ status: 'skipped' }), [])).toBe(
      'Skipped: not a file this app reads',
    );
    expect(importDestination(row({ status: 'queued' }), [])).toBe(
      'Processing; it appears when it is done',
    );
    expect(importDestination(row({ status: 'needs-pipeline' }), [])).toBe(
      'Needs the processing tools',
    );
  });

  it('the headline says when nothing came in', () => {
    expect(importHeadline([row({}), row({ status: 'skipped' })])).toBe('Imported 1 of 2 files');
    expect(importHeadline([row({ status: 'skipped' })])).toBe('Nothing imported: 1 file skipped');
    expect(importHeadline([row({ status: 'error' }), row({ status: 'skipped' })])).toBe(
      'Nothing imported: 1 file failed, 1 skipped',
    );
  });
});
```

`state.test.ts` (in "importFiles, one import at a time"):

```ts
it('queues a drop made while an import runs, says so, and imports it next', async () => {
  const running = later<unknown>();
  call.mockImplementation((channel: string) =>
    channel === 'builder:altitudePlan' ? Promise.resolve(planned(plan())) : running.reply,
  );
  const first = b().importFiles(['a.jpg']);
  await Promise.resolve();
  await vi.waitFor(() => expect(b().importing).not.toBeNull());
  await b().importFiles(['b.mp4']);
  expect(b().queued).toBe(1);
  expect(b().importNotice).toBe('An import is running. These files are imported when it finishes.');
  // the same files again are not queued twice
  await b().importFiles(['b.mp4']);
  expect(b().queued).toBe(1);
  running.give(imported);
  await first;
  expect(calls('builder:import').map((c) => (c[1] as { paths: string[] }).paths)).toEqual([
    ['a.jpg'],
    ['b.mp4'],
  ]);
  expect(b().queued).toBe(0);
  expect(b().importNotice).toBeNull();
});

it('queues a drop of other files made while the first is being prepared', async () => {
  const reading = later<unknown>();
  call.mockImplementation((channel: string) =>
    channel === 'builder:altitudePlan' ? reading.reply : Promise.resolve(imported),
  );
  const first = b().importFiles(['a.jpg']);
  await b().importFiles(['c.jpg']);
  expect(b().queued).toBe(1);
  reading.give(planned(plan()));
  await first;
  expect(calls('builder:import').map((c) => (c[1] as { paths: string[] }).paths)).toEqual([
    ['a.jpg'],
    ['c.jpg'],
  ]);
});
```

Update "runs the import confirmed in the heights prompt, not the drop prepared behind it" (`:131-163`): the drop prepared behind the prompt is no longer lost; it is queued and imported after the confirmed one. Its final expectation becomes the confirmed `a.jpg` import (with its altitude) followed by `{ projectId: 'p1', paths: ['b.jpg'] }`, and the test is renamed "runs the import confirmed in the heights prompt first, then the drop prepared behind it". The test of identical drops while preparing (`:75-98`) stays as it is (a duplicate is not queued).

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm --filter @aio/project exec vitest run src/builder/walkSource.test.ts src/builder/rawWalks.test.ts` and `pnpm --filter @aio/desktop exec vitest run src/renderer/builder/importSummary.test.ts src/renderer/builder/state.test.ts`
Expected: FAIL (`isStitched360`, `NO_SRT_MESSAGE`, `importSummary` missing; the queue tests see no second import).

- [ ] **Step 3: Write the implementation**

`walkSource.ts`:

```ts
/**
 * A stitched 360 export (Insta360 Studio, a 360 editor): an MP4 or MOV whose picture is
 * equirectangular, by its spherical metadata or a 2:1 frame. Read for every MP4 or MOV that comes
 * without a drone's SRT, so it is taken as a walk on every import route, not only Add 360 video.
 */
export function isStitched360(name: string, tracks: readonly WalkTrack[]): boolean {
  if (!STITCHED_EXT.test(name)) return false;
  const kind = classifyWalkSource({ name, tracks });
  return kind.ok && kind.layout === 'equirect';
}
```

`raw.ts`: export `NO_SRT_MESSAGE` (copy above) and use it at `:536-542`. Before the loop:

```ts
/** An MP4 or MOV given without its SRT is read for a 360 picture: a stitched export is a walk. */
const stitched360 = async (file: string): Promise<boolean> => {
  if (!deps.walk) return false;
  try {
    return isStitched360(basename(file), await deps.walk.tracks(file));
  } catch {
    // not an MP4 the track reader knows: the drone clip branch says why it is skipped
    return false;
  }
};
```

and `:472` becomes:

```ts
const is360 =
  isWalkFile(name) ||
  (VIDEO.has(ext) &&
    (deps.as360 === true ||
      (!deps.signal?.aborted &&
        (await sibling(file, '.srt', paths)) === null &&
        (await stitched360(file)))));
```

(`sibling` only looks the SRT up; the drone branch still marks it consumed.)

`state.ts`:

```ts
/** Drops and picks that came while an import ran or was being prepared, in the order they came. */
const waiting: { paths: string[]; altitude?: AltitudeChoice; opts?: ImportOptions }[] = [];
/** The files of the import being prepared or run, so the same drop is not queued again. */
let current: readonly string[] | null = null;
const samePaths = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((p, i) => p === b[i]);
```

(`ImportOptions` is the type of `importFiles`' third parameter; name it if it is inline today.)

- Move today's body of `importFiles` (after the project check) into a local `runImport(project, paths, altitude, opts)`, unchanged except: the guard at `:225` goes; at `:228` and `:232`, instead of `return`, the drop is queued (`queue(paths, altitude, opts)`).
- `queue(...)`: unless `current` or a waiting entry has the same paths, push it and `set({ queued: waiting.length, importNotice: QUEUED_NOTE })`.
- `importFiles`: after the project and empty checks, `if (get().importing || preparing) { queue(paths, altitude, opts); return; }`, then `current = [...paths]; try { await runImport(...); } finally { current = null; } await next();`.
- `next()`: returns while `get().importing`, `preparing` or `get().heightsPrompt` is set (the prompt's answer drains the queue); else shifts one entry, sets `queued` and `importNotice` (`null` when the queue is empty) and `await get().importFiles(...)` with it.
- `cancelHeights` ends with `void next()`; `confirmHeights` already calls `importFiles`, which drains.
- Initial state: `queued: 0`, `importNotice: null`.

`importSummary.ts`:

```ts
import type { ImportItem, Layer } from '@aio/schema';

/*
 * What the import panel says about each file: where it went (the group of the Datasets list it
 * was added to), or why it was skipped or failed. Founder, 13 Oct 2026: every import says where
 * each file went.
 */

export const QUEUED_NOTE = 'An import is running. These files are imported when it finishes.';

const GROUP: Record<Layer['kind'], string> = {
  mesh: 'Models',
  legacy: 'Models',
  pointcloud: 'Point clouds',
  basemap: 'Maps and rasters',
  raster: 'Maps and rasters',
  vector: 'Maps and rasters',
  video: 'Video',
  walk: '360 walks',
  photos: 'Photos',
  panoramas: 'Panoramas',
};

export function importDestination(item: ImportItem, layers: readonly Layer[]): string {
  switch (item.status) {
    case 'skipped':
      return `Skipped: ${item.message ?? 'not a file this app reads'}`;
    case 'error':
      return `Failed: ${item.message ?? 'the import stopped with an error'}`;
    case 'queued':
      return 'Processing; it appears when it is done';
    case 'needs-pipeline':
      return 'Needs the processing tools';
    case 'imported': {
      const layer = layers.find((l) => l.id === item.layerId);
      if (layer?.kind === 'walk') return 'Added as a walk under 360 walks';
      if (layer?.kind === 'raster' && layer.role === 'plan') return 'Added to Datasets, Drawings';
      if (layer) return `Added to Datasets, ${GROUP[layer.kind]}`;
      if (item.kind === 'photo') return 'Added to Datasets, Photos';
      return 'Imported';
    }
  }
}

export function importHeadline(items: readonly ImportItem[]): string {
  const n = (s: ImportItem['status']) => items.filter((i) => i.status === s).length;
  const imported = n('imported') + n('queued');
  if (imported > 0 || items.length === 0)
    return `Imported ${String(imported)} of ${String(items.length)} files`;
  const failed = n('error');
  const skipped = items.length - failed;
  const plural = (k: number) => (k === 1 ? 'file' : 'files');
  if (failed === 0) return `Nothing imported: ${String(skipped)} ${plural(skipped)} skipped`;
  return skipped === 0
    ? `Nothing imported: ${String(failed)} ${plural(failed)} failed`
    : `Nothing imported: ${String(failed)} ${plural(failed)} failed, ${String(skipped)} skipped`;
}
```

(If `photos` items carry `layerId: 'photos'` with no layer of that id, the `item.kind === 'photo'` line answers; check the photos layer id in `raw.ts` and keep the test in step with it.)

`ImportPanel.tsx`:

- The drop overlay's first line: "Photos, video with its SRT, stitched 360 MP4s and 360 camera files (.insv), GLB or OBJ models, GeoTIFF orthos and DSMs, point clouds".
- The header's last branch: `importHeadline(result?.items ?? [])` (keeps "Imported 1 of 1 files" when something came in). An import that failed as a whole keeps "Import failed" and its danger notice.
- Under the header, while `queued > 0`: `<p className="notice small" data-testid="import-queued">{importNotice}</p>`.
- Each row: `<li data-testid="import-row" ...>` with, under the file and status, `<p data-testid="import-where">{importDestination(it, layers)}</p>` and the item's own message only for imported rows (skipped and failed rows carry it in the destination line already). `layers` comes from `useWorkspace((s) => s.project?.manifest.layers ?? [])`.
- The panel stays until **Close**, as today, so a failure is never missed.

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm --filter @aio/project exec vitest run src/builder/` then `pnpm --filter @aio/desktop exec vitest run src/renderer/builder/`, and `pnpm --filter @aio/project typecheck`, `pnpm --filter @aio/desktop typecheck` (the latter may show only the T5 to T9 gap described in "Typecheck between batches", never errors in T13's files).
Expected: PASS.

- [ ] **Step 5: Write the e2e case** (`apps/desktop/e2e/walk-import-stitched.spec.ts`)

```ts
/**
 * Stitched 360 video on the normal import route: a small equirectangular MP4 (2:1, no SRT) added
 * through Add data becomes a walk row under 360 walks, and a 16:9 MP4 without an SRT is skipped
 * with a reason that names Add 360 video. The import panel says where each file went.
 * Skipped when ffmpeg with libx264 is missing (CI installs it).
 */
import type { ElectronApplication } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test } from './fixtures';
import { createWalkProject, ffmpegReady, WALK_PROJECT } from './walkFixture';

/** A `seconds` long test pattern of `size` (`WxH`), H.264, no audio. */
function makeMp4(out: string, size: string, seconds: number): void {
  const r = spawnSync(
    process.env.FFMPEG ?? 'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=s=${size}:r=10:d=${String(seconds)}`,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-an',
      '-f',
      'mp4',
      out,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
}

async function answerOpenDialog(app: ElectronApplication, paths: string[]): Promise<void> {
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: p });
  }, paths);
}

test.describe('stitched 360 video through Add data', () => {
  test.skip(!ffmpegReady(), 'needs ffmpeg with libx264 on the PATH');

  test('a 2:1 MP4 without an SRT becomes a walk; a 16:9 one is skipped with the reason', async ({
    app,
    win,
    dataRoot,
  }) => {
    test.setTimeout(180_000);
    // the walk project as it is in batch 1 (T11's options are not needed here)
    await createWalkProject(dataRoot.root);
    const stitched = join(dataRoot.root, 'Site tour 360.mp4');
    const flat = join(dataRoot.root, 'DJI_0001.mp4');
    makeMp4(stitched, '256x128', 4);
    makeMp4(flat, '320x180', 2);
    await win.reload();
    await win.getByTestId('project-card').filter({ hasText: WALK_PROJECT.name }).first().click();
    await expect(win.locator('[data-scene-view] canvas')).toBeVisible();
    await answerOpenDialog(app, [stitched, flat]);
    await win.getByTestId('add-data').click();
    const panel = win.getByTestId('import-panel');
    await expect(panel).toContainText('Imported 1 of 2 files', { timeout: 120_000 });
    const rows = panel.getByTestId('import-row');
    await expect(
      rows.filter({ hasText: 'Site tour 360.mp4' }).getByTestId('import-where'),
    ).toHaveText('Added as a walk under 360 walks');
    await expect(
      rows.filter({ hasText: 'DJI_0001.mp4' }).getByTestId('import-where'),
    ).toContainText('Add 360 video');
    await expect(win.getByTestId('tree-row-walk-site-tour-360')).toBeVisible({ timeout: 30_000 });
  });
});
```

Check the `add-data` button's route (`Sidebar.tsx`, `tree-add`) opens the file picker through `dialog.showOpenDialog` with several files (`pickAndImport`); if it opens a menu first, click its "Files" item. Check the walk id the slug gives (`walk-site-tour-360` from `Site tour 360.mp4`) against `walkLayerId` and adjust the test id. If the open walk folder lands the row inside a date folder, open it as `walkRow` in `walkFixture.ts` does.

Run it the CI way (T12 Step 2 lists it).

- [ ] **Step 6: Commit**

```bash
git add packages/project/src/builder/walkSource.ts packages/project/src/builder/walkSource.test.ts packages/project/src/builder/raw.ts packages/project/src/builder/rawWalks.test.ts apps/desktop/src/renderer/builder/state.ts apps/desktop/src/renderer/builder/state.test.ts apps/desktop/src/renderer/builder/importSummary.ts apps/desktop/src/renderer/builder/importSummary.test.ts apps/desktop/src/renderer/builder/ImportPanel.tsx apps/desktop/e2e/walk-import-stitched.spec.ts
git commit -m "feat(import): stitched 360 videos become walks on every route, drops queue, rows say where files went" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## How to test (for the founder, once built)

1. Open a project with a 360 walk that is processed and a placed drawing. In **Datasets**, under **360 walks**, point at the walk and press **Place walk** (the pin). The drawing opens beside the 3D view with a slim toolbar above it.
2. Move the pointer over the drawing: a faint copy of the walk's shape follows it. Click where the walk started. Move again: the whole shape now turns and stretches between the start and the pointer. Too near the start, the toolbar says to put the end at least 5 m away and the click does nothing.
3. Click where the walk ended. The walk is drawn with round **Start** and **End** handles. Drag either one: the shape follows. Press **Save**. The **Needs placing** badge goes.
4. Point at the row again: it now has **Edit placement** and **Remove placement**. **Edit placement** reopens the handles. **Remove placement** asks in the row; yes clears the placement, the walk stays and its badge returns.
5. **Place on** in the toolbar switches to **Map** (projects with a coordinate system) or **3D view**: the same start, end and handles work there, and the map or 3D view fills the stage.
6. **Fine-tune** opens the 360 video beside the surface with **Pin here**, **Align view** and **Heading**, as before.
7. Import a 360 video and press **Place walk** before processing it (or one whose processing was interrupted): the toolbar says why there is no path and offers **Process walk** (or **Process again**) and **Place between two points anyway**. Nothing is drawn until you choose.
8. Export a stitched 360 MP4 from the camera app and drop it on the window (or use **Add data**): it is added as a walk under **360 walks**. The import panel says for each file where it went, or why it was skipped. Drop more files while an import runs: the panel says they wait, and they come in when it finishes.
