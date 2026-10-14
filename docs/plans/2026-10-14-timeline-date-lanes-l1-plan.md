# Timeline date lanes, phase L1: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single absolute-UTC clip timeline of video projects with one lane per survey date on a shared site time-of-day axis, with the date control moved into the timeline header, a one-line date row when the timeline is hidden, and no autoplay on clip click.

**Architecture:** A pure lane model (`packages/ui/src/timeline/lanes.ts`) runs over the existing `buildTimelineModel` output and the capture index. A presentational `LaneTimeline` in `@aio/ui` draws it, reusing the ruler, transport, zoom and pan pieces extracted from `Timeline.tsx`. The desktop binds it to `useWorkspace` and `useTimeline` (`WorkspaceLanes.tsx`), adds `DateRow.tsx`, and shares a `DatePicker` (popover shell from `@aio/ui` plus the existing `Calendar`) between the lane header, the date row and the `DateBar`. The site clock offset comes from the project longitude in the renderer via `@aio/geo` (no IPC).

**Tech Stack:** TypeScript strict, React 19, zustand, Vitest (jsdom for components), Playwright with Electron, proj4 through `@aio/geo`.

**Spec:** `docs/plans/2026-10-14-timeline-date-lanes-design.md` (phase "L1 lanes" only; L2 Sync dates and L3 walks are out of scope).

## Global Constraints

- Only phase L1: lane model, `LaneTimeline`, folds, ghost lines, the DateBar merge and `DateRow`, site time, no autoplay, sub-rows. No **Sync dates** button, not even disabled. No walks in lanes.
- Lanes show for a project that has at least one `kind: 'video'` layer and at least one capture, and is not a road project. Road projects keep the chainage ruler and the DateBar; projects without video keep the DateBar and the collapsed `TimelineBar`; a video project without captures keeps today's `Timeline` and `DateBar` (which hides itself without dates).
- Visible lanes: the focused date and up to two dates on each side (`LANE_RADIUS = 2`); the rest fold into `+N earlier` / `+N later` rows that expand on click.
- Axis: site time of day, ms after local midnight, fitted to the earliest start and latest end across the visible lanes plus 2% padding. A flight crossing midnight stays in its start date's lane and the axis widens past 24:00.
- Site offset: `round(lon / 15)` hours, the builder's rule (`@aio/geo` `defaultUtcOffsetMin`). Header says `site time ≈ UTC+3`; with no readable position it falls back to UTC and says `UTC`.
- Clip click selects and seeks to the click point; it never calls `play()`. Space or the Play button plays. This applies to the old `Timeline` binding too.
- State is unchanged: focus is `useTimeline.focus` (a capture id), time and play stay in `useWorkspace`. Alt+Left / Alt+Right keep stepping dates (`App.tsx`, untouched).
- No contract change: nothing in `@aio/schema` or IPC changes. No row in `docs/architecture/contract-changes.md`.
- Repo rules (`CONTRIBUTING.md`): strict TS, no `any`, no non-null assertions; renderer never imports `electron` or `node:*`; no em or en dashes in user-facing text; conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; no client, site or person names in code, tests, fixtures or docs.
- Stable test ids kept so existing specs hold: the focused date button is always `date-bar-open` (with `.dtag` and the `datebar.open` aria-label), the arrows are `date-bar-prev` / `date-bar-next`, the lane timeline root keeps `aria-label="Timeline"`, the playhead keeps `playhead`, the timecode keeps `timecode`, keyframe diamonds keep `timeline-direction-key`, clip bars keep the `seg-c` class and `title` = clip name. The `date-bar` container id belongs to the DateBar only.

## Review Focus

1. **A clip filed under a date other than its recording day** (moved by hand with "Move to date"): it must sit in its capture's lane at its own time of day, not days off the axis. Pinned in Task 2 ("files a clip of another day under its own capture at its own time of day").
2. **A video project with no captures, or with captures but the focus still null**: no crash and a sensible timeline (old `Timeline` without captures; latest date focused for an unknown focus). Pinned in Task 2 ("focuses the latest date when the focus is unknown") and Task 6 (`usesLanes` tests).
3. **The playhead while playing across midnight**: at 00:10 the next UTC-day the playhead stays at 24:10 on the lane, not jumping back to 00:10. Pinned in Task 2 (midnight test, `laneTodOf`).
4. **A project whose CRS is WKT or unknown**: the clock label says `UTC` and the axis uses offset 0, and a site near Greenwich says `UTC+0`, not `UTC`. Pinned in Task 1 (null vs 0) and Task 6 (`siteOffset` with a WKT CRS).
5. **Keyboard activation of a clip bar** (Enter, no pointer): selects the clip, moves the clock to the clip start only when the playhead is outside it, never plays. Pinned in Task 6 (`pickClip` keyboard test) and Task 5 (`onClip` without time on `detail === 0`).

---

## File Structure

| File                                                                                                          | Responsibility                                                                                                  | Task |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---- |
| `packages/geo/src/clock.ts` (modify)                                                                          | `siteUtcOffsetMin` (null when the position cannot be read); `defaultUtcOffsetMin` delegates to it               | 1    |
| `packages/geo/src/clock.test.ts` (modify)                                                                     | tests for null vs 0                                                                                             | 1    |
| `packages/ui/src/timeline/lanes.ts` (create)                                                                  | pure lane model: lanes, sub-rows, folds, time of day, ghost, lane-scoped clip lookups; `offsetLabel` (Task 5)   | 2, 5 |
| `packages/ui/src/timeline/lanes.test.ts` (create)                                                             | unit tests for the model                                                                                        | 2, 5 |
| `packages/ui/src/Popover.tsx` (create)                                                                        | popover shell: outside pointerdown closes, focus trap, Escape, focus returns to the opener                      | 3    |
| `packages/ui/src/Popover.test.tsx` (create)                                                                   | shell tests                                                                                                     | 3    |
| `packages/ui/src/index.ts` (modify)                                                                           | exports `Popover` (Task 3), lanes and `LaneTimeline` (Task 5)                                                   | 3, 5 |
| `apps/desktop/src/renderer/workspace/DatePicker.tsx` (create)                                                 | `DatePicker` (date button plus calendar popover) and `DateSteps` (prev, picker, next)                           | 3    |
| `apps/desktop/src/renderer/workspace/DateBar.tsx` (modify)                                                    | uses `DateSteps`; keeps `isTypingTarget`                                                                        | 3    |
| `apps/desktop/src/renderer/styles.css` (modify)                                                               | `.dpick`, `.dbar-pop.up` (Task 3); `.date-row` (Task 6)                                                         | 3, 6 |
| `packages/ui/src/timeline/parts.tsx` (create)                                                                 | shared timeline pieces: `useTimeAxis`, `Ruler`, `Transport`, `ZoomControls`, `HideButton`, `tickLabel`, `RATES` | 4    |
| `packages/ui/src/timeline/Timeline.tsx` (modify)                                                              | uses `parts.tsx`; behaviour unchanged                                                                           | 4    |
| `packages/ui/src/timeline/Timeline.test.tsx` (create)                                                         | characterisation tests that pin today's behaviour before the extraction                                         | 4    |
| `packages/ui/src/timeline/LaneTimeline.tsx` (create)                                                          | presentational lane timeline                                                                                    | 5    |
| `packages/ui/src/timeline/LaneTimeline.test.tsx` (create)                                                     | component tests                                                                                                 | 5    |
| `packages/ui/src/i18n/en.ts` (modify)                                                                         | `timeline.utc`, `timeline.siteTime`, `timeline.lanes.*`                                                         | 5    |
| `packages/ui/src/mission.css` (modify)                                                                        | lane styles (`.lt-*`)                                                                                           | 5    |
| `apps/desktop/src/renderer/workspace/lanes.ts` (create)                                                       | `usesLanes`, `siteOffset`                                                                                       | 6    |
| `apps/desktop/src/renderer/workspace/lanes.test.ts` (create)                                                  | tests                                                                                                           | 6    |
| `apps/desktop/src/renderer/workspace/pickClip.ts` (create)                                                    | `selectClip` (moved from `Sidebar.tsx`) and `pickClip` (select and seek, never play)                            | 6    |
| `apps/desktop/src/renderer/workspace/pickClip.test.ts` (create)                                               | tests                                                                                                           | 6    |
| `apps/desktop/src/renderer/shell/Sidebar.tsx` (modify)                                                        | re-exports `selectClip` from `pickClip.ts`                                                                      | 6    |
| `apps/desktop/src/renderer/workspace/WorkspaceLanes.tsx` (create)                                             | binds `LaneTimeline` to the stores                                                                              | 6    |
| `apps/desktop/src/renderer/workspace/DateRow.tsx` (create)                                                    | one-line date row when the lane timeline is hidden                                                              | 6    |
| `apps/desktop/src/renderer/workspace/DateRow.test.tsx` (create)                                               | tests                                                                                                           | 6    |
| `apps/desktop/src/renderer/workspace/WorkspaceScreen.tsx` (modify)                                            | picks lanes / date row / old timeline; DateBar only without lanes; old clip click without `play()`              | 6    |
| `apps/desktop/e2e/tinyVideo.ts` (create)                                                                      | `tinyMp4()` moved out of `video-first.spec.ts`                                                                  | 7    |
| `apps/desktop/e2e/timeline-lanes.spec.ts` (create)                                                            | new end to end spec                                                                                             | 7    |
| `apps/desktop/e2e/video-first.spec.ts`, `shell.spec.ts`, `package.spec.ts`, the `playFlight101` spec (modify) | see "End to end specs"                                                                                          | 7    |

## Decisions taken while planning

- **How longitude reaches the renderer:** no IPC. The manifest already carries `crs` and `origin`, and `@aio/geo` (proj4, bundled CRS definitions, no network) is already imported by renderer code (`builder/DroneMenu.tsx`, `change/draw.ts`). The renderer calls a new `siteUtcOffsetMin(origin, epsg)` next to the builder's `defaultUtcOffsetMin`, which now delegates to it, so both use one rule. **No contract change.**
- **Where the components live:** like `Timeline`, the lane timeline is presentational in `@aio/ui` (`packages/ui/src/timeline/LaneTimeline.tsx`) and bound in the desktop (`WorkspaceLanes.tsx`). The spec named `LaneTimeline.tsx` under the desktop; the split keeps `@aio/ui` free of the desktop stores and makes it unit-testable, matching how `Timeline` and `WorkspaceTimeline` are split today.
- **Date control in the header:** the header shows the focused date in full as one button (colour tag, date) that opens the calendar above it; that button is the "calendar button". It reuses the `date-bar-open` test id so specs that read or click it (`change-frames.spec.ts`, `spot-history.spec.ts`) keep working on video projects.
- **Flight group bars** (`.seg-c.grp`, clips collapsed below 28 px) are not drawn in lanes: a time-of-day axis over a few hours keeps clips wider, and the CSS minimum width (3 px) plus zoom covers the rest. The old `Timeline` keeps them.
- **Which lane a clip, photo or issue goes to:** clip and photo by `index.of[layerId]`; otherwise the capture on the item's site day, else the nearest capture by date (so nothing vanishes). An issue goes to the lane of the clip it was seen in, else by its site day the same way.
- **Clip continuation at clip end** (`continueAcrossClips` in `App.tsx`) already continues only within one flight, so it never jumps to another date. No change.
- **No-autoplay applies to the old timeline too** (video projects without captures): one rule for clip bars everywhere.

## Execution DAG

```
Batch 1 (parallel):  T1 geo offset   T2 lane model   T3 popover + DatePicker   T4 timeline parts
                         |               |                 |                        |
Batch 2:                 |               +-------> T5 LaneTimeline <----------------+
                         |                                 |
Batch 3:                 +---------------> T6 desktop wiring <---- T3
                                                   |
Batch 4:                                    T7 end to end specs
                                                   |
Batch 5:                                    T8 verification and finish
```

| Task                      | Depends on                           | Packages                                                                                              | Shared files with                                 |
| ------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| T1 site offset            | none                                 | `@aio/geo`                                                                                            | none                                              |
| T2 lane model             | none                                 | `@aio/ui` (`lanes.ts`, `lanes.test.ts`)                                                               | T5 (later batch)                                  |
| T3 popover and DatePicker | none                                 | `@aio/ui` (`Popover.tsx`, `index.ts`), `@aio/desktop` (`DatePicker.tsx`, `DateBar.tsx`, `styles.css`) | T5 (`index.ts`), T6 (`styles.css`), later batches |
| T4 timeline parts         | none                                 | `@aio/ui` (`parts.tsx`, `Timeline.tsx`, `Timeline.test.tsx`)                                          | none                                              |
| T5 LaneTimeline           | T2, T4 (and T3 for `index.ts` order) | `@aio/ui`                                                                                             | none in its batch                                 |
| T6 desktop wiring         | T1, T3, T5                           | `@aio/desktop`                                                                                        | none in its batch                                 |
| T7 end to end             | T6                                   | `@aio/desktop` e2e                                                                                    | none                                              |
| T8 verification           | T7                                   | all                                                                                                   | none                                              |

- **Batch 1** (T1, T2, T3, T4) touch disjoint files; dispatch all four in one message. They share one worktree: each agent runs only its own package's tests while building, stages only its own files (`git add <paths>`, never `git add -A`), and commits one at a time.
- **Critical path:** T4 → T5 → T6 → T7 → T8 (T2 runs beside T4 and is shorter).
- **Contract change:** none in any task.

## End to end specs

Run every spec below the CI way (see T7 and T8). Findings from reading the specs:

| Spec                                                                                                    | Test                                                                                                                                                                  | Project                                                            | Effect of L1                                                                                     | Action                                     |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| `timeline-lanes.spec.ts` (new)                                                                          | all six tests                                                                                                                                                         | synthetic, six dates, video on three                               | new                                                                                              | add                                        |
| `shell.spec.ts`                                                                                         | "open a project, drive the shell and keep the sidebar state"                                                                                                          | `sampleManifest` (two captures, two videos, zone 39 origin: UTC+3) | the timecode now shows site time: `09:00:00` becomes `12:00:00`                                  | edit lines 80, 83, 86                      |
| `video-first.spec.ts`                                                                                   | "a video-only project is placed on the map and framed in 3D at once"                                                                                                  | one capture, one video                                             | lane timeline replaces the old one; no timeline selectors used                                   | import `tinyMp4` from `tinyVideo.ts`; run  |
| `camera-direction.spec.ts`                                                                              | "right-click the drone, align the camera to the map with two keyframes"                                                                                               | one capture, one video                                             | keyframe diamonds move to the focused lane; test id kept                                         | run, no edit expected                      |
| `change-frames.spec.ts`                                                                                 | "a photo opens the same view of the other date, and blends"                                                                                                           | change demo (two dates, video)                                     | `date-bar-open` now in the lane header; Alt+Left unchanged                                       | run, no edit expected                      |
| `spot-history.spec.ts`                                                                                  | "a photo shows its spot on both dates, steps with the keys and compares"                                                                                              | change demo                                                        | reads `date-bar-open` aria-label, kept                                                           | run, no edit expected                      |
| `stage-display.spec.ts`                                                                                 | non-real-data tests ("no video: the timeline folds into a thin bar..." and the rest)                                                                                  | no video                                                           | unchanged                                                                                        | run                                        |
| `stage-display.spec.ts`                                                                                 | "@realdata (real project) > with clips the timeline shows as before"                                                                                                  | real data                                                          | lane root keeps `aria-label="Timeline"` inside `.tl-wrap`, `timeline-bar` absent                 | no edit; run on the founder's machine only |
| real-data spec defining `playFlight101` (`grep -l "function playFlight101" apps/desktop/e2e/*.spec.ts`) | the two `@realdata` tests that call `playFlight101` ("opens with a drawn 3D scene, plays a clip and lists its saved issues" and "... photos and flights reach Media") | real data                                                          | Enter on a clip bar no longer plays                                                              | `playFlight101` clicks Play after Enter    |
| `package.spec.ts`                                                                                       | the `@realdata` "as a customer package > exports, opens read-only from the ZIP, streams and seeks video, never writes or calls out" test                              | real data                                                          | clip click no longer plays                                                                       | click Play after the bar click             |
| `video-proxy.spec.ts`                                                                                   | the `@realdata` "joined flight clips > a click on a whole-flight bar plays from the clicked point" test                                                               | real data                                                          | asserts only the seek point (`nowMs`), which still holds on a lane clip and on the old group bar | no edit; run on the founder's machine only |
| `timeline.spec.ts`                                                                                      | "survey date timeline" tests                                                                                                                                          | three dates, no video                                              | DateBar stays                                                                                    | run (regression)                           |

`@realdata` tests skip on CI and without the real data root; they are edited so they hold where the data exists.

---

### Task 1: Site clock offset that knows "no position"

**Files:**

- Modify: `packages/geo/src/clock.ts`
- Test: `packages/geo/src/clock.test.ts`

**Interfaces:**

- Consumes: `toWgs84(p: Vec3, epsg: number): Vec3` from `packages/geo/src/index.ts`.
- Produces: `siteUtcOffsetMin(origin: readonly [number, number, number], epsg: number | undefined): number | null` (whole hours in minutes, `0` near Greenwich, `null` when the position cannot be read). `defaultUtcOffsetMin` keeps its signature and returns `siteUtcOffsetMin(...) ?? 0`.

Packages: `@aio/geo`. Contract change: none.

- [ ] **Step 1: Write the failing test**

Append to `packages/geo/src/clock.test.ts` (and add `siteUtcOffsetMin` to the import from `./clock`):

```ts
describe('siteUtcOffsetMin', () => {
  it('rounds the longitude to whole hours', () => {
    expect(siteUtcOffsetMin(fromWgs84([48.1352, 29.0276, 0], 32639), 32639)).toBe(180);
    expect(siteUtcOffsetMin(fromWgs84([-73.98, 40.75, 0], 32618), 32618)).toBe(-300);
  });
  it('is 0, not null, for a site near Greenwich', () => {
    expect(siteUtcOffsetMin(fromWgs84([2.35, 48.85, 0], 32631), 32631)).toBe(0);
    expect(siteUtcOffsetMin(fromWgs84([-2.1, 51.5, 0], 32630), 32630)).toBe(0);
  });
  it('is null when the position cannot be read', () => {
    expect(siteUtcOffsetMin([0, 0, 0], 999999)).toBeNull();
    expect(siteUtcOffsetMin([0, 0, 0], undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aio/geo exec vitest run src/clock.test.ts`
Expected: FAIL, `siteUtcOffsetMin` is not exported.

- [ ] **Step 3: Write minimal implementation**

Replace the body of `packages/geo/src/clock.ts`:

```ts
import { toWgs84 } from './index';

/**
 * The clock offset of a site from its longitude: whole hours, in minutes. Null when the position
 * cannot be read (no EPSG code, or one outside the bundled registry).
 */
export function siteUtcOffsetMin(
  origin: readonly [number, number, number],
  epsg: number | undefined,
): number | null {
  if (epsg === undefined) return null;
  try {
    const [lon] = toWgs84([origin[0], origin[1], origin[2]], epsg);
    if (!Number.isFinite(lon)) return null;
    const hours = Math.round(lon / 15);
    // never -0: a site just west of Greenwich is UTC+0 like one just east of it
    return hours === 0 ? 0 : hours * 60;
  } catch {
    return null;
  }
}

/** The clock offset of a project from its longitude: whole hours, in minutes; 0 when unknown. */
export function defaultUtcOffsetMin(
  origin: readonly [number, number, number],
  epsg: number,
): number {
  return siteUtcOffsetMin(origin, epsg) ?? 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @aio/geo exec vitest run src/clock.test.ts`
Expected: PASS (old `defaultUtcOffsetMin` tests too).

- [ ] **Step 5: Commit**

```bash
git add packages/geo/src/clock.ts packages/geo/src/clock.test.ts
git commit -m "feat(geo): site clock offset that tells no position from UTC+0"
```

---

### Task 2: Pure lane model

**Files:**

- Create: `packages/ui/src/timeline/lanes.ts`
- Test: `packages/ui/src/timeline/lanes.test.ts`

**Interfaces:**

- Consumes: `ClipBar`, `IssueMark`, `PhotoMark`, `TimelineModel` from `packages/ui/src/timeline/model.ts`.
- Produces (exact names, used by Tasks 5 and 6):

```ts
export const DAY_MS = 86_400_000;
export const LANE_RADIUS = 2;
export interface LaneCapture {
  id: string;
  label: string;
  date: string;
}
export interface LaneIndex {
  captures: readonly LaneCapture[];
  of: Readonly<Record<string, string>>;
}
export interface LaneClip extends ClipBar {
  startTod: number;
  endTod: number;
  row: number;
  keysTod?: number[];
}
export interface LaneIssue extends IssueMark {
  tod: number;
}
export interface LanePhoto extends PhotoMark {
  tod: number;
}
export interface Lane {
  captureId: string;
  date: string;
  label: string;
  clips: LaneClip[];
  rows: number;
  issues: LaneIssue[];
  photos: LanePhoto[];
}
export interface LaneFolds {
  earlier: number;
  later: number;
}
export interface LaneExpand {
  earlier: boolean;
  later: boolean;
}
export interface LaneModel {
  lanes: Lane[];
  visible: Lane[];
  focus: string | null;
  folds: LaneFolds;
  range: [number, number];
  offsetMin: number;
}
export function todOf(utcMs: number, offsetMin: number): number;
export function siteDayOf(utcMs: number, offsetMin: number): string;
export function siteMidnightUtc(date: string, offsetMin: number): number;
export function laneTodOf(lane: Pick<Lane, 'clips'>, utcMs: number, offsetMin: number): number;
export function ghostAt(
  lane: Pick<Lane, 'clips'>,
  tod: number,
): { clip: LaneClip; mediaMs: number; utcMs: number } | undefined;
export function utcAt(lane: Pick<Lane, 'clips' | 'date'>, tod: number, offsetMin: number): number;
export function laneClipAt(lane: Pick<Lane, 'clips'>, tod: number): LaneClip | undefined;
export function laneNeighbour(
  lane: Pick<Lane, 'clips'>,
  activeId: string | null,
  dir: 1 | -1,
): LaneClip | undefined;
export function laneWindow(
  count: number,
  focusIdx: number,
  expand: LaneExpand,
): { from: number; to: number; folds: LaneFolds };
export function buildLaneModel(
  model: TimelineModel,
  index: LaneIndex,
  focus: string | null,
  offsetMin: number,
  expand?: LaneExpand,
): LaneModel;
```

`CaptureIndex` from `@aio/workspace` satisfies `LaneIndex` structurally. Not exported from `index.ts` yet (Task 5 does it, to keep `index.ts` out of batch 1's shared files).

Packages: `@aio/ui`. Contract change: none.

- [ ] **Step 1: Write the failing tests**

Create `packages/ui/src/timeline/lanes.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  DAY_MS,
  buildLaneModel,
  ghostAt,
  laneNeighbour,
  laneTodOf,
  siteMidnightUtc,
  todOf,
  utcAt,
  type LaneIndex,
} from './lanes';
import type { ClipBar, IssueMark, TimelineModel } from './model';

const H = 3_600_000;
const MIN = 60_000;
const OFF = 180; // UTC+3
const DATES = ['2026-09-05', '2026-09-12', '2026-09-19', '2026-09-26', '2026-10-03', '2026-10-10'];
const NONE = { earlier: false, later: false };

/** UTC ms of a site clock time on a date. */
const at = (date: string, h: number, m = 0) => siteMidnightUtc(date, OFF) + (h * 60 + m) * MIN;
const clip = (layerId: string, startMs: number, lenMs: number): ClipBar => ({
  layerId,
  name: layerId,
  startMs,
  endMs: startMs + lenMs,
  estimated: false,
  group: layerId,
});
const tm = (p: Partial<TimelineModel>): TimelineModel => ({
  clips: [],
  groups: [],
  issues: [],
  photos: [],
  captures: [],
  range: null,
  ...p,
});
const index = (dates: readonly string[], of: Record<string, string> = {}): LaneIndex => ({
  captures: dates.map((d, i) => ({ id: `d${String(i + 1)}`, label: `Survey ${d}`, date: d })),
  of,
});
const issue = (issueId: string, tMs: number): IssueMark => ({
  issueId,
  code: issueId,
  tMs,
  color: undefined,
  severity: 1,
});
const ids = (xs: readonly { captureId: string }[]) => xs.map((x) => x.captureId);

describe('time of day', () => {
  it('reads site time with positive, negative and zero offsets', () => {
    const t = Date.UTC(2026, 8, 12, 22, 0);
    expect(todOf(t, 180)).toBe(1 * H);
    expect(todOf(t, -300)).toBe(17 * H);
    expect(todOf(t, 0)).toBe(22 * H);
  });
  it('finds the UTC time of a site midnight', () => {
    expect(siteMidnightUtc('2026-09-12', 180)).toBe(Date.UTC(2026, 8, 11, 21, 0));
    expect(todOf(siteMidnightUtc('2026-09-12', -300) + 5 * H, -300)).toBe(5 * H);
  });
});

describe('buildLaneModel', () => {
  it('puts each clip in its capture lane, oldest date first', () => {
    const m = buildLaneModel(
      tm({
        clips: [clip('a', at(DATES[0] ?? '', 9), 10 * MIN), clip('b', at(DATES[2] ?? '', 10), MIN)],
      }),
      index(DATES.slice(0, 3), { a: 'd1', b: 'd3' }),
      'd3',
      OFF,
    );
    expect(ids(m.lanes)).toEqual(['d1', 'd2', 'd3']);
    expect(m.lanes.map((l) => l.clips.map((c) => c.layerId))).toEqual([['a'], [], ['b']]);
    expect(m.lanes[0]?.clips[0]?.startTod).toBe(9 * H);
  });

  it('files a clip without a capture under its site day, not its UTC day', () => {
    // 01:00 on 12 Sep at the site is 22:00 on 11 Sep in UTC
    const m = buildLaneModel(
      tm({ clips: [clip('x', at('2026-09-12', 1), MIN)] }),
      index(['2026-09-11', '2026-09-12']),
      null,
      OFF,
    );
    expect(m.lanes[1]?.clips.map((c) => c.layerId)).toEqual(['x']);
  });

  it('files a clip of another day under its own capture at its own time of day', () => {
    const m = buildLaneModel(
      tm({ clips: [clip('x', at('2026-09-12', 9), MIN)] }),
      index(['2026-09-05'], { x: 'd1' }),
      'd1',
      OFF,
    );
    const c = m.lanes[0]?.clips[0];
    expect(c?.startTod).toBe(9 * H);
    expect(m.range[1]).toBeLessThan(DAY_MS);
  });

  it('stacks overlapping clips into sub-rows', () => {
    const d = DATES[0] ?? '';
    const m = buildLaneModel(
      tm({
        clips: [
          clip('a', at(d, 9, 0), 10 * MIN),
          clip('b', at(d, 9, 5), 10 * MIN),
          clip('c', at(d, 9, 12), 8 * MIN),
        ],
      }),
      index([d], { a: 'd1', b: 'd1', c: 'd1' }),
      'd1',
      OFF,
    );
    const lane = m.lanes[0];
    expect(lane?.clips.map((c) => [c.layerId, c.row])).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 0],
    ]);
    expect(lane?.rows).toBe(2);
  });

  it('keeps a flight that crosses midnight in the lane it started in', () => {
    const d = DATES[0] ?? '';
    const start = at(d, 23, 30);
    const m = buildLaneModel(
      tm({ clips: [clip('n', start, H)] }),
      index(DATES.slice(0, 2), { n: 'd1' }),
      'd1',
      OFF,
    );
    const lane = m.lanes[0];
    expect(lane?.clips[0]?.startTod).toBe(23.5 * H);
    expect(lane?.clips[0]?.endTod).toBe(24.5 * H);
    expect(m.range[1]).toBeGreaterThan(DAY_MS);
    // the playhead 40 minutes in is at 24:10 on this lane, not 00:10
    expect(laneTodOf(lane ?? { clips: [] }, start + 40 * MIN, OFF)).toBe(24 * H + 10 * MIN);
  });

  it('gives a date with no video a lane with its photos and issues', () => {
    const d2 = DATES[1] ?? '';
    const m = buildLaneModel(
      tm({
        clips: [clip('a', at(DATES[0] ?? '', 9), MIN)],
        photos: [{ layerId: 'ph', photoId: 'p1', tMs: at(d2, 8) }],
        issues: [issue('i1', at(d2, 8, 5))],
      }),
      index(DATES.slice(0, 2), { a: 'd1', ph: 'd2' }),
      'd2',
      OFF,
    );
    const lane = m.lanes[1];
    expect(lane?.clips).toEqual([]);
    expect(lane?.rows).toBe(0);
    expect(lane?.photos.map((p) => p.tod)).toEqual([8 * H]);
    expect(lane?.issues.map((i) => i.tod)).toEqual([8 * H + 5 * MIN]);
  });

  it("puts an issue seen in a clip on that clip's lane", () => {
    const d1 = DATES[0] ?? '';
    // the clip is filed under d2 although it was recorded on d1's day
    const m = buildLaneModel(
      tm({ clips: [clip('a', at(d1, 9), 10 * MIN)], issues: [issue('i1', at(d1, 9, 2))] }),
      index(DATES.slice(0, 2), { a: 'd2' }),
      'd2',
      OFF,
    );
    expect(m.lanes[1]?.issues.map((i) => i.issueId)).toEqual(['i1']);
    expect(m.lanes[0]?.issues).toEqual([]);
  });

  it('focuses the latest date when the focus is unknown', () => {
    expect(buildLaneModel(tm({}), index(DATES), 'nope', OFF).focus).toBe('d6');
    expect(buildLaneModel(tm({}), index(DATES), null, OFF).focus).toBe('d6');
    expect(buildLaneModel(tm({}), index([]), null, OFF).focus).toBeNull();
  });

  it('folds the dates beyond two on each side of the focus', () => {
    const six = index(DATES);
    const v = (focus: string, expand = NONE) => {
      const m = buildLaneModel(tm({}), six, focus, OFF, expand);
      return [ids(m.visible), m.folds];
    };
    expect(v('d4')).toEqual([['d2', 'd3', 'd4', 'd5', 'd6'], { earlier: 1, later: 0 }]);
    expect(v('d1')).toEqual([['d1', 'd2', 'd3'], { earlier: 0, later: 3 }]);
    expect(v('d6')).toEqual([['d4', 'd5', 'd6'], { earlier: 3, later: 0 }]);
    expect(v('d6', { earlier: true, later: false })).toEqual([
      ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'],
      { earlier: 0, later: 0 },
    ]);
    const three = buildLaneModel(tm({}), index(DATES.slice(0, 3)), 'd2', OFF);
    expect(three.folds).toEqual({ earlier: 0, later: 0 });
  });

  it('fits the range to the visible lanes with 2% padding', () => {
    const m = buildLaneModel(
      tm({
        clips: [
          clip('early', at(DATES[0] ?? '', 6), MIN), // folded away when d6 is focused
          clip('a', at(DATES[4] ?? '', 9), H),
          clip('b', at(DATES[5] ?? '', 9, 30), 1.5 * H),
        ],
      }),
      index(DATES, { early: 'd1', a: 'd5', b: 'd6' }),
      'd6',
      OFF,
    );
    const pad = 2 * H * 0.02;
    expect(m.range[0]).toBeCloseTo(9 * H - pad);
    expect(m.range[1]).toBeCloseTo(11 * H + pad);
  });

  it('spans the whole day when no visible lane carries time', () => {
    expect(buildLaneModel(tm({}), index(DATES.slice(0, 2)), 'd1', OFF).range).toEqual([0, DAY_MS]);
  });
});

describe('ghostAt and utcAt', () => {
  const d = DATES[0] ?? '';
  const m = buildLaneModel(
    tm({ clips: [clip('c', at(d, 9), 10 * MIN)] }),
    index([d], { c: 'd1' }),
    'd1',
    OFF,
  );
  const lane = m.lanes[0] ?? { clips: [], date: d };
  it('finds the clip and its media time inside a clip', () => {
    const g = ghostAt(lane, 9 * H + 2 * MIN);
    expect(g?.clip.layerId).toBe('c');
    expect(g?.mediaMs).toBe(2 * MIN);
    expect(g?.utcMs).toBe(at(d, 9, 2));
  });
  it('finds nothing in a gap or past the end', () => {
    expect(ghostAt(lane, 8 * H)).toBeUndefined();
    expect(ghostAt(lane, 9 * H + 11 * MIN)).toBeUndefined();
  });
  it('maps a time of day back to UTC on the lane date', () => {
    expect(utcAt(lane, 9 * H + 2 * MIN, OFF)).toBe(at(d, 9, 2));
    expect(utcAt(lane, 8 * H, OFF)).toBe(at(d, 8));
  });
});

describe('laneNeighbour', () => {
  const [d1, d2] = [DATES[0] ?? '', DATES[1] ?? ''];
  const m = buildLaneModel(
    tm({
      clips: [
        clip('a1', at(d1, 9), MIN),
        clip('a2', at(d1, 9, 30), MIN),
        clip('b1', at(d2, 9), MIN),
      ],
    }),
    index([d1, d2], { a1: 'd1', a2: 'd1', b1: 'd2' }),
    'd1',
    OFF,
  );
  const lane = m.lanes[0] ?? { clips: [] };
  it('steps within the lane and stops at its ends', () => {
    expect(laneNeighbour(lane, 'a1', 1)?.layerId).toBe('a2');
    expect(laneNeighbour(lane, 'a2', 1)).toBeUndefined();
    expect(laneNeighbour(lane, 'a1', -1)).toBeUndefined();
  });
  it('starts at the first or last clip when the active clip is elsewhere', () => {
    expect(laneNeighbour(lane, null, 1)?.layerId).toBe('a1');
    expect(laneNeighbour(lane, 'b1', -1)?.layerId).toBe('a2');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @aio/ui exec vitest run src/timeline/lanes.test.ts`
Expected: FAIL, cannot resolve `./lanes`.

- [ ] **Step 3: Write the implementation**

Create `packages/ui/src/timeline/lanes.ts`:

```ts
import type { ClipBar, IssueMark, PhotoMark, TimelineModel } from './model';

/** One day in ms. */
export const DAY_MS = 86_400_000;
/** Dates shown on each side of the focused one before the rest fold away. */
export const LANE_RADIUS = 2;

export interface LaneCapture {
  id: string;
  label: string;
  /** YYYY-MM-DD */
  date: string;
}

/** The parts of the capture index the lanes read (`CaptureIndex` fits). */
export interface LaneIndex {
  /** Oldest first. */
  captures: readonly LaneCapture[];
  /** Capture id by dated layer id. */
  of: Readonly<Record<string, string>>;
}

/** A clip on its lane: times of day are site time, ms after the lane's local midnight. */
export interface LaneClip extends ClipBar {
  startTod: number;
  /** May pass 24:00 for a flight that crosses midnight. */
  endTod: number;
  /** Sub-row inside the lane, 0 first. */
  row: number;
  keysTod?: number[];
}

export interface LaneIssue extends IssueMark {
  tod: number;
}

export interface LanePhoto extends PhotoMark {
  tod: number;
}

export interface Lane {
  captureId: string;
  date: string;
  label: string;
  /** By start time of day. */
  clips: LaneClip[];
  /** Sub-rows the clips need (0 for a date without video). */
  rows: number;
  issues: LaneIssue[];
  photos: LanePhoto[];
}

export interface LaneFolds {
  earlier: number;
  later: number;
}

export interface LaneExpand {
  earlier: boolean;
  later: boolean;
}

export interface LaneModel {
  /** Every date, oldest first. */
  lanes: Lane[];
  /** The focused date and its neighbours, plus any expanded fold. */
  visible: Lane[];
  /** The focused capture id (the latest date when the given focus is unknown). */
  focus: string | null;
  folds: LaneFolds;
  /** Time of day span to draw. */
  range: [number, number];
  offsetMin: number;
}

const mod = (a: number, n: number): number => ((a % n) + n) % n;

/** Site time of day of a UTC time, ms after local midnight. */
export function todOf(utcMs: number, offsetMin: number): number {
  return mod(utcMs + offsetMin * 60_000, DAY_MS);
}

/** Site day (YYYY-MM-DD) of a UTC time. */
export function siteDayOf(utcMs: number, offsetMin: number): string {
  return new Date(utcMs + offsetMin * 60_000).toISOString().slice(0, 10);
}

/** UTC time of the local midnight that starts `date` at the site. */
export function siteMidnightUtc(date: string, offsetMin: number): number {
  return Date.parse(`${date}T00:00:00Z`) - offsetMin * 60_000;
}

function nearestCapture(captures: readonly LaneCapture[], day: string): string | undefined {
  const target = Date.parse(`${day}T00:00:00Z`);
  let best: LaneCapture | undefined;
  let gap = Infinity;
  for (const c of captures) {
    const d = Math.abs(Date.parse(`${c.date}T00:00:00Z`) - target);
    if (d < gap) {
      best = c;
      gap = d;
    }
  }
  return best?.id;
}

/** The layer's own capture, else the capture on the item's site day, else the nearest one. */
function laneIdFor(
  index: LaneIndex,
  layerId: string | undefined,
  utcMs: number,
  offsetMin: number,
): string | undefined {
  const own = layerId === undefined ? undefined : index.of[layerId];
  if (own !== undefined && index.captures.some((c) => c.id === own)) return own;
  return nearestCapture(index.captures, siteDayOf(utcMs, offsetMin));
}

/** Gives each clip (sorted by start) the first sub-row free at its start; returns the row count. */
function packRows(clips: LaneClip[]): number {
  const ends: number[] = [];
  for (const c of clips) {
    let row = ends.findIndex((e) => e <= c.startTod);
    if (row < 0) {
      row = ends.length;
      ends.push(c.endTod);
    } else ends[row] = c.endTod;
    c.row = row;
  }
  return ends.length;
}

/**
 * Time of day of a UTC time on a lane: inside one of its clips it runs on from the clip start (so
 * past 24:00 for a flight that crossed midnight), else the plain site time of day.
 */
export function laneTodOf(lane: Pick<Lane, 'clips'>, utcMs: number, offsetMin: number): number {
  const c = lane.clips.find((x) => utcMs >= x.startMs && utcMs <= x.endMs);
  return c ? c.startTod + (utcMs - c.startMs) : todOf(utcMs, offsetMin);
}

/** The lane's clip at a time of day, with the media time and UTC time there, or nothing. */
export function ghostAt(
  lane: Pick<Lane, 'clips'>,
  tod: number,
): { clip: LaneClip; mediaMs: number; utcMs: number } | undefined {
  const clip = lane.clips.find((c) => tod >= c.startTod && tod <= c.endTod);
  if (!clip) return undefined;
  const mediaMs = tod - clip.startTod;
  return { clip, mediaMs, utcMs: clip.startMs + mediaMs };
}

/** UTC time of a time of day on a lane: through its clip there, else from the lane's midnight. */
export function utcAt(lane: Pick<Lane, 'clips' | 'date'>, tod: number, offsetMin: number): number {
  return ghostAt(lane, tod)?.utcMs ?? siteMidnightUtc(lane.date, offsetMin) + tod;
}

/** The lane's clip at a time of day. */
export function laneClipAt(lane: Pick<Lane, 'clips'>, tod: number): LaneClip | undefined {
  return ghostAt(lane, tod)?.clip;
}

/** The clip after (1) or before (-1) the active one in this lane; first or last when it is elsewhere. */
export function laneNeighbour(
  lane: Pick<Lane, 'clips'>,
  activeId: string | null,
  dir: 1 | -1,
): LaneClip | undefined {
  const i = lane.clips.findIndex((c) => c.layerId === activeId);
  if (i < 0) return dir === 1 ? lane.clips[0] : lane.clips[lane.clips.length - 1];
  return lane.clips[i + dir];
}

/** Which lanes show: the focus and LANE_RADIUS on each side, or everything on an expanded side. */
export function laneWindow(
  count: number,
  focusIdx: number,
  expand: LaneExpand,
): { from: number; to: number; folds: LaneFolds } {
  if (count === 0) return { from: 0, to: -1, folds: { earlier: 0, later: 0 } };
  const f = Math.min(Math.max(focusIdx, 0), count - 1);
  const from = expand.earlier ? 0 : Math.max(0, f - LANE_RADIUS);
  const to = expand.later ? count - 1 : Math.min(count - 1, f + LANE_RADIUS);
  return { from, to, folds: { earlier: from, later: count - 1 - to } };
}

function fitRange(lanes: readonly Lane[]): [number, number] {
  const times = lanes.flatMap((l) => l.clips.flatMap((c) => [c.startTod, c.endTod]));
  if (times.length === 0)
    times.push(
      ...lanes.flatMap((l) => [...l.photos.map((p) => p.tod), ...l.issues.map((i) => i.tod)]),
    );
  if (times.length === 0) return [0, DAY_MS];
  let a = Math.min(...times);
  let b = Math.max(...times);
  if (b - a < 60_000) {
    const mid = (a + b) / 2;
    a = mid - 30_000;
    b = mid + 30_000;
  }
  const pad = (b - a) * 0.02;
  return [a - pad, b + pad];
}

/**
 * One lane per survey date on a shared site time-of-day axis, from the timeline model (UTC) and the
 * capture index. `offsetMin` is the site clock offset; `expand` opens the folded dates.
 */
export function buildLaneModel(
  model: TimelineModel,
  index: LaneIndex,
  focus: string | null,
  offsetMin: number,
  expand: LaneExpand = { earlier: false, later: false },
): LaneModel {
  const lanes: Lane[] = index.captures.map((c) => ({
    captureId: c.id,
    date: c.date,
    label: c.label,
    clips: [],
    rows: 0,
    issues: [],
    photos: [],
  }));
  const byId = new Map(lanes.map((l) => [l.captureId, l]));
  const laneOf = (id: string | undefined) => (id === undefined ? undefined : byId.get(id));
  const clipLane = new Map<string, Lane>();

  for (const c of model.clips) {
    const lane = laneOf(laneIdFor(index, c.layerId, c.startMs, offsetMin));
    if (!lane) continue;
    const startTod = todOf(c.startMs, offsetMin);
    lane.clips.push({
      ...c,
      startTod,
      endTod: startTod + (c.endMs - c.startMs),
      row: 0,
      ...(c.keys ? { keysTod: c.keys.map((k) => startTod + (k - c.startMs)) } : {}),
    });
    clipLane.set(c.layerId, lane);
  }
  for (const lane of lanes) {
    lane.clips.sort((a, b) => a.startTod - b.startTod || a.layerId.localeCompare(b.layerId));
    lane.rows = packRows(lane.clips);
  }
  for (const p of model.photos) {
    const lane = laneOf(laneIdFor(index, p.layerId, p.tMs, offsetMin));
    if (lane) lane.photos.push({ ...p, tod: laneTodOf(lane, p.tMs, offsetMin) });
  }
  for (const m of model.issues) {
    const seenIn = model.clips.find((c) => m.tMs >= c.startMs && m.tMs <= c.endMs);
    const lane =
      (seenIn && clipLane.get(seenIn.layerId)) ??
      laneOf(laneIdFor(index, undefined, m.tMs, offsetMin));
    if (lane) lane.issues.push({ ...m, tod: laneTodOf(lane, m.tMs, offsetMin) });
  }

  const known = focus !== null && byId.has(focus);
  const focusIdx = known ? lanes.findIndex((l) => l.captureId === focus) : lanes.length - 1;
  const { from, to, folds } = laneWindow(lanes.length, focusIdx, expand);
  const visible = lanes.slice(from, to + 1);
  return {
    lanes,
    visible,
    focus: lanes[focusIdx]?.captureId ?? null,
    folds,
    range: fitRange(visible),
    offsetMin,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @aio/ui exec vitest run src/timeline/lanes.test.ts`
Expected: PASS. Then `pnpm --filter @aio/ui exec tsc --noEmit -p .` (or the repo's `pnpm typecheck`) shows no errors in `lanes.ts`.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/timeline/lanes.ts packages/ui/src/timeline/lanes.test.ts
git commit -m "feat(ui): date lane model for the timeline"
```

---

### Task 3: Popover shell in `@aio/ui`, shared DatePicker in the desktop

**Files:**

- Create: `packages/ui/src/Popover.tsx`, `packages/ui/src/Popover.test.tsx`
- Modify: `packages/ui/src/index.ts` (export)
- Create: `apps/desktop/src/renderer/workspace/DatePicker.tsx`
- Modify: `apps/desktop/src/renderer/workspace/DateBar.tsx`, `apps/desktop/src/renderer/styles.css`
- Test: existing `apps/desktop/src/renderer/workspace/DateBar.test.tsx` stays green unchanged

**Interfaces:**

- Consumes: `useFocusTrap(ref, active, { onEscape, returnTo })` from `packages/ui/src/focus.ts`; `Calendar`, `CalendarDay`, `formatDate`, `useT` from `@aio/ui`; `dateTags` from `@aio/workspace`; `timeline`, `useTimeline` from `./timeline`.
- Produces:
  - `@aio/ui`: `Popover(props: PopoverProps)`, `interface PopoverProps { open: boolean; onClose: () => void; opener: RefObject<HTMLElement | null>; className?: string; children: ReactNode }`.
  - desktop `DatePicker({ up }: { up?: boolean })`: the focused date button (`data-testid="date-bar-open"`) plus its calendar popover; `up` opens it above.
  - desktop `DateSteps({ up }: { up?: boolean })`: previous (`date-bar-prev`), `DatePicker`, next (`date-bar-next`); arrows only with more than one date.

Packages: `@aio/ui`, `@aio/desktop`. Contract change: none.

- [ ] **Step 1: Write the failing Popover test**

Create `packages/ui/src/Popover.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Popover } from './Popover';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | null = null;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

function Harness({ open, onClose }: { open: boolean; onClose: () => void }) {
  const opener = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={opener} type="button" data-testid="opener">
        open
      </button>
      <button type="button" data-testid="outside">
        elsewhere
      </button>
      <Popover open={open} onClose={onClose} opener={opener} className="pop">
        <button type="button" data-testid="inside">
          in
        </button>
      </Popover>
    </>
  );
}
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const render = (open: boolean, onClose: () => void) => {
  root = createRoot(host);
  act(() => root?.render(<Harness open={open} onClose={onClose} />));
};
const press = (el: Element | null) => {
  act(() => {
    el?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
  });
};

describe('Popover', () => {
  it('renders nothing while closed', () => {
    render(false, vi.fn());
    expect(host.querySelector('.pop')).toBeNull();
  });
  it('renders its children in a box with the class', () => {
    render(true, vi.fn());
    expect(host.querySelector('.pop [data-testid="inside"]')).not.toBeNull();
  });
  it('closes on a press outside, not on the opener or inside', () => {
    const onClose = vi.fn();
    render(true, onClose);
    press(q('inside'));
    press(q('opener'));
    expect(onClose).not.toHaveBeenCalled();
    press(q('outside'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(true, onClose);
    act(() => {
      q('inside')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @aio/ui exec vitest run src/Popover.test.tsx`
Expected: FAIL, cannot resolve `./Popover`.

- [ ] **Step 3: Implement the shell**

Create `packages/ui/src/Popover.tsx`:

```tsx
import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import { useFocusTrap } from './focus';

export interface PopoverProps {
  open: boolean;
  onClose: () => void;
  /** The button that opens it: a press on it is not "outside", and focus returns to it. */
  opener: RefObject<HTMLElement | null>;
  className?: string;
  children: ReactNode;
}

/**
 * A popover box: a press outside it (and outside its opener) or Escape closes it, Tab stays
 * inside, and focus goes back to the opener. Place it with `className`.
 */
export function Popover({ open, onClose, opener, className, children }: PopoverProps) {
  const pop = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useLayoutEffect(() => {
    close.current = onClose;
  });
  useFocusTrap(pop, open, {
    onEscape: () => {
      close.current();
    },
    returnTo: () => opener.current,
  });
  useEffect(() => {
    if (!open) return;
    const onDown = (e: Event) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !opener.current?.contains(t)) close.current();
    };
    window.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('pointerdown', onDown);
    };
  }, [open, opener]);
  if (!open) return null;
  return (
    <div ref={pop} className={className}>
      {children}
    </div>
  );
}
```

Add to `packages/ui/src/index.ts`, after the `Calendar` export line:

```ts
export { Popover, type PopoverProps } from './Popover';
```

- [ ] **Step 4: Run the Popover test**

Run: `pnpm --filter @aio/ui exec vitest run src/Popover.test.tsx`
Expected: PASS.

- [ ] **Step 5: Move the DateBar onto DatePicker**

Create `apps/desktop/src/renderer/workspace/DatePicker.tsx`:

```tsx
import { Calendar, Icon, Popover, formatDate, useT, type CalendarDay } from '@aio/ui';
import { dateTags } from '@aio/workspace';
import { useMemo, useRef, useState } from 'react';
import { timeline, useTimeline } from './timeline';

/**
 * The focused survey date as a button that opens the calendar. `up` opens the calendar above the
 * button (the timeline and the date row sit at the bottom of the window).
 */
export function DatePicker({ up = false }: { up?: boolean }) {
  const t = useT();
  const index = useTimeline((s) => s.index);
  const focus = useTimeline((s) => s.focus);
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
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
  const current = index?.captures.find((c) => c.id === focus);
  if (!index || !focus || !current) return null;

  return (
    <span className="dpick">
      <button
        ref={opener}
        type="button"
        className="dbar-date"
        data-testid="date-bar-open"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('datebar.open', { date: formatDate(current.date) })}
        onClick={() => {
          setOpen((o) => !o);
        }}
      >
        <span className="dtag" style={{ background: tags[focus]?.colour }} aria-hidden="true" />
        {formatDate(current.date)}
      </button>
      <Popover
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        opener={opener}
        className={up ? 'dbar-pop up' : 'dbar-pop'}
      >
        <Calendar
          days={days}
          focusId={focus}
          onPick={(id) => {
            timeline.getState().focusSurvey(id);
            setOpen(false);
          }}
          onClose={() => {
            setOpen(false);
          }}
        />
      </Popover>
    </span>
  );
}

/** Previous date, the date picker, next date (arrows only with more than one date). */
export function DateSteps({ up = false }: { up?: boolean }) {
  const t = useT();
  const total = useTimeline((s) => s.index?.captures.length ?? 0);
  return (
    <>
      {total > 1 && (
        <button
          type="button"
          className="btn icon sm ghost"
          data-testid="date-bar-prev"
          aria-label={t('datebar.prev')}
          onClick={() => {
            timeline.getState().step(-1);
          }}
        >
          <Icon name="back" size={14} />
        </button>
      )}
      <DatePicker up={up} />
      {total > 1 && (
        <button
          type="button"
          className="btn icon sm ghost"
          data-testid="date-bar-next"
          aria-label={t('datebar.next')}
          onClick={() => {
            timeline.getState().step(1);
          }}
        >
          <Icon name="fwd" size={14} />
        </button>
      )}
    </>
  );
}
```

Replace `DateBar` in `apps/desktop/src/renderer/workspace/DateBar.tsx` (keep `isTypingTarget` as it is; the imports become `import { useT } from '@aio/ui';`, `import { DateSteps } from './DatePicker';`, `import { useTimeline } from './timeline';`):

```tsx
/** The survey date in focus, with arrows to step and a calendar to pick. Hidden without dates. */
export function DateBar() {
  const t = useT();
  const index = useTimeline((s) => s.index);
  const focus = useTimeline((s) => s.focus);
  if (!index || index.captures.length === 0 || !focus) return null;
  const at = index.captures.findIndex((c) => c.id === focus);
  return (
    <div className="dbar" role="toolbar" aria-label={t('datebar.label')} data-testid="date-bar">
      <DateSteps />
      <span className="dbar-count" data-testid="date-bar-count">
        {t('datebar.count', { n: at + 1, total: index.captures.length })}
      </span>
    </div>
  );
}
```

In `apps/desktop/src/renderer/styles.css`, after the `.dbar-pop { ... }` rule:

```css
.dpick {
  position: relative;
  display: inline-flex;
}
.dbar-pop {
  inset-inline-start: 0;
}
.dbar-pop.up {
  top: auto;
  bottom: calc(100% + 4px);
}
```

- [ ] **Step 6: Run the DateBar tests unchanged**

Run: `pnpm --filter @aio/desktop exec vitest run src/renderer/workspace/DateBar.test.tsx`
Expected: PASS (shows date and position, previous arrow, calendar pick, labelled dialog, Escape returns focus).

- [ ] **Step 7: Commit**

```bash
git add packages/ui/src/Popover.tsx packages/ui/src/Popover.test.tsx packages/ui/src/index.ts apps/desktop/src/renderer/workspace/DatePicker.tsx apps/desktop/src/renderer/workspace/DateBar.tsx apps/desktop/src/renderer/styles.css
git commit -m "refactor(desktop): popover shell in @aio/ui and a shared date picker"
```

---

### Task 4: Extract the shared timeline pieces from `Timeline.tsx`

**Files:**

- Create: `packages/ui/src/timeline/parts.tsx`
- Modify: `packages/ui/src/timeline/Timeline.tsx`
- Test: `packages/ui/src/timeline/Timeline.test.tsx` (characterisation, written first against today's code)

**Interfaces:**

- Consumes: `generateTicks`, `pickTickStep`, `Tick`, `TickStep` from `./ticks`; `formatClock`, `t`, `Icon`, `platformKeys`.
- Produces (used by Task 5):

```ts
export const RATES: readonly [0.25, 0.5, 1, 2, 4, 8];
export function tickLabel(t: number, major: number): string;
export interface TimeAxis {
  view: [number, number] | null;
  width: number;
  span: number;
  step: TickStep;
  ticks: Tick[];
  x(t: number): number;
  pct(t: number): string;
  timeAt(clientX: number): number;
  zoom(factor: number, anchor: number): void;
  fit(): void;
}
export function useTimeAxis(
  tracksRef: RefObject<HTMLDivElement | null>,
  range: [number, number] | null,
  followMs: number,
  playing: boolean,
): TimeAxis;
export function Ruler(props: { axis: TimeAxis }): JSX.Element;
export interface TransportProps {
  canStep: boolean;
  canPlay: boolean;
  playing: boolean;
  clockMs: number | null;
  rate: number;
  activeName?: string;
  onStep(dir: 1 | -1): void;
  onTogglePlay(): void;
  onRate(rate: number): void;
}
export function Transport(props: TransportProps): JSX.Element;
export function ZoomControls(props: { axis: TimeAxis; anchor: number }): JSX.Element;
export function HideButton(props: { onHide: () => void; hideKeys?: string }): JSX.Element;
```

`Timeline.tsx` keeps exporting `Timeline`, `RATES` and `TimelineProps` (re-export `RATES` from `./parts`), so `packages/ui/src/index.ts` does not change.

Packages: `@aio/ui`. Contract change: none.

- [ ] **Step 1: Write characterisation tests against today's Timeline**

Create `packages/ui/src/timeline/Timeline.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TimelineModel } from './model';
import { tickLabel } from './parts';
import { Timeline, type TimelineProps } from './Timeline';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => {
  // jsdom has no ResizeObserver; the timeline only needs it to exist
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
});
let host: HTMLDivElement;
let root: Root | null = null;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

const T0 = Date.UTC(2026, 0, 5, 7, 0, 0);
const model: TimelineModel = {
  clips: [
    { layerId: 'a', name: 'Clip A', startMs: T0, endMs: T0 + 60_000, estimated: false, group: 'a' },
    {
      layerId: 'b',
      name: 'Clip B',
      startMs: T0 + 120_000,
      endMs: T0 + 180_000,
      estimated: true,
      group: 'b',
    },
  ],
  groups: [
    { id: 'a', name: 'Clip A', startMs: T0, endMs: T0 + 60_000, clips: ['a'] },
    { id: 'b', name: 'Clip B', startMs: T0 + 120_000, endMs: T0 + 180_000, clips: ['b'] },
  ],
  issues: [],
  photos: [],
  captures: [],
  range: [T0 - 3_600, T0 + 183_600],
};
const props = (over: Partial<TimelineProps> = {}): TimelineProps => ({
  model,
  nowMs: T0,
  playing: false,
  rate: 1,
  activeClip: 'a',
  onSeek: vi.fn(),
  onTogglePlay: vi.fn(),
  onRate: vi.fn(),
  onClip: vi.fn(),
  onStep: vi.fn(),
  ...over,
});
const render = (p: TimelineProps) => {
  root = createRoot(host);
  act(() => root?.render(<Timeline {...p} />));
};
const button = (name: string) =>
  host.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);

describe('Timeline', () => {
  it('draws a bar per clip, the active one pressed and the estimated one dashed', () => {
    render(props());
    const bars = [...host.querySelectorAll<HTMLButtonElement>('.seg-c')];
    expect(bars.map((b) => b.title)).toEqual(['Clip A', 'Clip B (length not known yet)']);
    expect(bars[0]?.getAttribute('aria-pressed')).toBe('true');
    expect(bars[1]?.classList.contains('est')).toBe(true);
  });
  it('shows the clock, the rate and the active clip', () => {
    render(props());
    expect(host.querySelector('[data-testid="timecode"]')?.textContent).toBe('07:00:00.00');
    expect(button('Playback rate 1x')?.textContent).toBe('1.0×');
    expect(host.querySelector('.tl-h .tag')?.textContent).toBe('Clip A');
  });
  it('steps clips, plays and cycles the rate through its callbacks', () => {
    const p = props();
    render(p);
    act(() => button('Next clip')?.click());
    act(() => button('Previous clip')?.click());
    act(() => button('Play')?.click());
    act(() => button('Playback rate 1x')?.click());
    expect(p.onStep).toHaveBeenNthCalledWith(1, 1);
    expect(p.onStep).toHaveBeenNthCalledWith(2, -1);
    expect(p.onTogglePlay).toHaveBeenCalledTimes(1);
    expect(p.onRate).toHaveBeenCalledWith(2);
  });
  it('a keyboard click on a clip chooses it without a time', () => {
    const p = props();
    render(p);
    act(() => {
      host
        .querySelectorAll('.seg-c')[1]
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    });
    expect(p.onClip).toHaveBeenCalledWith('b');
  });
  it('draws a playhead and a ruler, and offers hide only with onHide', () => {
    render(props());
    expect(host.querySelector('[data-testid="playhead"]')).not.toBeNull();
    expect(host.querySelectorAll('.tl-ruler .tkl').length).toBeGreaterThan(0);
    expect(host.querySelector('.tl-hide')).toBeNull();
  });
  it('says so when nothing carries time', () => {
    render(props({ model: { ...model, clips: [], groups: [], range: null } }));
    expect(host.querySelector('.tl-empty')).not.toBeNull();
    expect(host.querySelector('[data-testid="timecode"]')?.textContent).toBe('--:--:--');
  });
});

describe('tickLabel', () => {
  it('labels days, minutes, seconds and tenths', () => {
    expect(tickLabel(Date.UTC(2026, 0, 5), 86_400_000)).toBe('5/1');
    expect(tickLabel(T0, 60_000)).toBe('07:00');
    expect(tickLabel(T0 + 5_000, 1_000)).toBe('07:00:05');
    expect(tickLabel(T0 + 500, 100)).toBe('07:00:00.5');
  });
});
```

- [ ] **Step 2: Run them; only `tickLabel` fails**

Run: `pnpm --filter @aio/ui exec vitest run src/timeline/Timeline.test.tsx`
Expected: FAIL to resolve `./parts`. Temporarily comment out the `tickLabel` import and its `describe` and run again: the six Timeline tests PASS against today's code (they characterise it). Restore the lines.

- [ ] **Step 3: Create `parts.tsx` (code moved from `Timeline.tsx`, behaviour unchanged)**

```tsx
import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type RefObject } from 'react';
import { formatClock } from '../format';
import { t } from '../i18n';
import { Icon } from '../icons/Icon';
import { platformKeys } from '../shortcut';
import { generateTicks, pickTickStep, type Tick, type TickStep } from './ticks';

export const RATES = [0.25, 0.5, 1, 2, 4, 8] as const;

const MIN_SPAN = 2_000;

export function tickLabel(t: number, major: number): string {
  const d = new Date(t);
  if (major >= 86_400_000) return `${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
  const clock = formatClock(t);
  if (major >= 60_000) return clock.slice(0, 5);
  if (major >= 1_000) return clock;
  return `${clock}.${String(d.getUTCMilliseconds()).padStart(3, '0').slice(0, 1)}`;
}

export interface TimeAxis {
  /** Visible span, null while nothing carries time. */
  view: [number, number] | null;
  /** Width of the tracks in px. */
  width: number;
  span: number;
  step: TickStep;
  ticks: Tick[];
  /** Position of a time in percent of the tracks. */
  x(t: number): number;
  pct(t: number): string;
  /** Time under a pointer x. */
  timeAt(clientX: number): number;
  zoom(factor: number, anchor: number): void;
  /** Back to the whole range. */
  fit(): void;
}

/**
 * The visible span of a time axis drawn in `tracksRef`: fits `range` until the user zooms or pans
 * (Ctrl + wheel zooms at the cursor, wheel pans), and keeps `followMs` in view while `playing`.
 */
export function useTimeAxis(
  tracksRef: RefObject<HTMLDivElement | null>,
  range: [number, number] | null,
  followMs: number,
  playing: boolean,
): TimeAxis {
  const [width, setWidth] = useState(800);
  const hasTime = range !== null;
  const rangeKey = range ? `${range[0]}:${range[1]}` : 'none';
  const [manual, setManual] = useState<{ key: string; view: [number, number] } | null>(null);
  // A new project or new clip durations reset the view to fit.
  const view = manual?.key === rangeKey ? manual.view : range;
  const setView = useCallback(
    (v: [number, number] | null) => {
      setManual(v ? { key: rangeKey, view: v } : null);
    },
    [rangeKey],
  );
  // Keep the playhead in view while playing (state adjusted during render, no effect needed).
  if (playing && view && (followMs > view[1] || followMs < view[0])) {
    const s = view[1] - view[0];
    setManual({ key: rangeKey, view: [followMs - s * 0.1, followMs + s * 0.9] });
  }

  useLayoutEffect(() => {
    const el = tracksRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(1, entry.contentRect.width));
    });
    ro.observe(el);
    setWidth(Math.max(1, el.clientWidth));
    return () => {
      ro.disconnect();
    };
  }, [hasTime, tracksRef]);

  const [v0, v1] = view ?? [0, 1];
  const span = Math.max(v1 - v0, 1);
  const x = useCallback((t: number) => ((t - v0) / span) * 100, [v0, span]);
  const pct = useCallback((t: number) => `${x(t).toFixed(3)}%`, [x]);
  const step = useMemo(() => pickTickStep(span, width), [span, width]);
  const ticks = useMemo(() => generateTicks(v0, v1, step), [v0, v1, step]);

  const timeAt = useCallback(
    (clientX: number) => {
      const el = tracksRef.current;
      if (!el) return v0;
      const r = el.getBoundingClientRect();
      return v0 + ((clientX - r.left) / Math.max(r.width, 1)) * span;
    },
    [v0, span, tracksRef],
  );

  const zoom = useCallback(
    (factor: number, anchor: number) => {
      if (!view) return;
      const [a, b] = view;
      const next = Math.max(MIN_SPAN, (b - a) * factor);
      const f = (anchor - a) / (b - a);
      setView([anchor - next * f, anchor + next * (1 - f)]);
    },
    [view, setView],
  );

  // Ctrl + wheel zooms at the cursor, wheel pans. Registered natively to allow preventDefault.
  useEffect(() => {
    const el = tracksRef.current;
    if (!el || !view) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        zoom(e.deltaY > 0 ? 1.25 : 0.8, timeAt(e.clientX));
      } else {
        const d = ((e.deltaX || e.deltaY) / Math.max(width, 1)) * span;
        setView([v0 + d, v1 + d]);
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
    };
  }, [view, setView, zoom, timeAt, width, span, v0, v1, tracksRef]);

  return {
    view,
    width,
    span,
    step,
    ticks,
    x,
    pct,
    timeAt,
    zoom,
    fit: () => {
      setView(range);
    },
  };
}

export function Ruler({ axis }: { axis: TimeAxis }) {
  return (
    <div className="tl-ruler" aria-hidden="true">
      {axis.ticks.map((tk) => (
        <span key={tk.t}>
          <i className={`tk ${tk.major ? 'maj' : 'min'}`} style={{ left: axis.pct(tk.t) }} />
          {tk.major && (
            <span className="tkl" style={{ left: axis.pct(tk.t) }}>
              {tickLabel(tk.t, axis.step.major)}
            </span>
          )}
        </span>
      ))}
    </div>
  );
}

export interface TransportProps {
  canStep: boolean;
  canPlay: boolean;
  playing: boolean;
  /** The time the timecode shows (null: nothing carries time). */
  clockMs: number | null;
  rate: number;
  activeName?: string;
  onStep(dir: 1 | -1): void;
  onTogglePlay(): void;
  onRate(rate: number): void;
}

/** Previous / play / next, the timecode, the rate and the active clip tag. */
export function Transport(p: TransportProps) {
  const frames =
    p.clockMs === null
      ? ''
      : String(Math.floor(((((p.clockMs % 1000) + 1000) % 1000) / 1000) * 30)).padStart(2, '0');
  const nextRate = () => {
    const i = RATES.findIndex((r) => r === p.rate);
    p.onRate(RATES[(i + 1) % RATES.length] ?? 1);
  };
  return (
    <>
      <div className="transport">
        <button
          className="tool tip-up"
          type="button"
          onClick={() => {
            p.onStep(-1);
          }}
          disabled={!p.canStep}
          aria-label="Previous clip"
        >
          <Icon name="back" />
          <span className="tip">Previous clip</span>
        </button>
        <button
          className="tool play"
          type="button"
          onClick={p.onTogglePlay}
          disabled={!p.canPlay}
          aria-label={p.playing ? 'Pause' : 'Play'}
          aria-keyshortcuts="Space"
        >
          <Icon name={p.playing ? 'pause' : 'play'} />
        </button>
        <button
          className="tool tip-up"
          type="button"
          onClick={() => {
            p.onStep(1);
          }}
          disabled={!p.canStep}
          aria-label="Next clip"
        >
          <Icon name="fwd" />
          <span className="tip">Next clip</span>
        </button>
      </div>
      <div className="tc" data-testid="timecode">
        {p.clockMs !== null ? (
          <>
            {formatClock(p.clockMs)}
            <small>.{frames}</small>
          </>
        ) : (
          '--:--:--'
        )}
      </div>
      <button
        className="rate"
        type="button"
        onClick={nextRate}
        title="Playback rate"
        aria-label={`Playback rate ${p.rate}x`}
      >
        {p.rate.toFixed(p.rate < 1 ? 2 : 1)}×
      </button>
      {p.activeName && (
        <span className="tag">
          <Icon name="video" size={12} />
          {p.activeName}
        </span>
      )}
    </>
  );
}

/** Zoom out, fit, zoom in; the buttons zoom around `anchor` (the playhead). */
export function ZoomControls({ axis, anchor }: { axis: TimeAxis; anchor: number }) {
  return (
    <div className="seg icons" role="group" aria-label="Timeline zoom">
      <button
        type="button"
        aria-label="Zoom out"
        title={`Zoom out (${platformKeys('Ctrl')} + wheel)`}
        onClick={() => {
          axis.zoom(1.6, anchor);
        }}
      >
        <Icon name="minus" size={14} />
      </button>
      <button type="button" aria-label="Fit" title="Fit everything" onClick={axis.fit}>
        <Icon name="maximize" size={14} />
      </button>
      <button
        type="button"
        aria-label="Zoom in"
        title={`Zoom in (${platformKeys('Ctrl')} + wheel)`}
        onClick={() => {
          axis.zoom(0.625, anchor);
        }}
      >
        <Icon name="plus" size={14} />
      </button>
    </div>
  );
}

/** Collapse the timeline; `hideKeys` names its shortcut. */
export function HideButton({ onHide, hideKeys }: { onHide: () => void; hideKeys?: string }) {
  return (
    <button
      className="tool tip-up tl-hide"
      type="button"
      onClick={onHide}
      aria-label={t('timeline.hide')}
      aria-keyshortcuts={hideKeys}
    >
      <Icon name="chevdown" />
      <span className="tip tip-end">
        {t('timeline.hide')}
        {hideKeys && <span className="kbd">{hideKeys}</span>}
      </span>
    </button>
  );
}
```

- [ ] **Step 4: Rewrite `Timeline.tsx` on top of the parts**

In `packages/ui/src/timeline/Timeline.tsx`:

1. Imports become:

```tsx
import { useRef, type ReactNode } from 'react';
import { formatCount } from '../format';
import { Icon } from '../icons/Icon';
import type { TimelineModel } from './model';
import { HideButton, Ruler, Transport, ZoomControls, useTimeAxis } from './parts';

export { RATES } from './parts';
```

2. Delete the local `RATES`, `MIN_SPAN` and `tickLabel` definitions (keep `GROUP_BELOW_PX`).

3. Replace everything in the component body from `const kfDrag` down to (and including) the `active` constant with:

```tsx
const kfDrag = useRef<{ x: number; moved: boolean } | null>(null);
const tracksRef = useRef<HTMLDivElement>(null);
const hasTime = model.range !== null;
const axis = useTimeAxis(tracksRef, model.range, nowMs, playing);
const { x, pct, timeAt, width } = axis;

const scrubbing = useRef(false);
const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
  if (e.button !== 0) return;
  const target = e.target as HTMLElement;
  if (target.closest('[data-hit]')) return;
  scrubbing.current = true;
  e.currentTarget.setPointerCapture(e.pointerId);
  onSeek(timeAt(e.clientX));
};
const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
  if (scrubbing.current) onSeek(timeAt(e.clientX));
};
const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
  scrubbing.current = false;
  if (e.currentTarget.hasPointerCapture(e.pointerId))
    e.currentTarget.releasePointerCapture(e.pointerId);
};
const active = model.clips.find((c) => c.layerId === activeClip);
```

(keep `type PointerEvent as ReactPointerEvent` in the `react` import).

4. Replace the whole `<div className="tl-h">...</div>` with:

```tsx
<div className="tl-h">
  <Transport
    canStep={model.clips.length > 0}
    canPlay={hasTime}
    playing={playing}
    clockMs={hasTime ? nowMs : null}
    rate={rate}
    activeName={active?.name}
    onStep={onStep}
    onTogglePlay={onTogglePlay}
    onRate={onRate}
  />
  <span className="sp" />
  {props.context && <span className="ctx">{props.context}</span>}
  <ZoomControls axis={axis} anchor={nowMs} />
  {props.onHide && <HideButton onHide={props.onHide} hideKeys={props.hideKeys} />}
</div>
```

5. Replace the `<div className="tl-ruler" ...>...</div>` block with `<Ruler axis={axis} />`. The clip, group, keyframe, issue, photo, capture and playhead markup stays as it is (it uses `x`, `pct`, `timeAt`, `width` from the destructuring above). Remove `onRate`, `t`, `formatClock`, `platformKeys` usages that are now unused.

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @aio/ui exec vitest run src/timeline`
Expected: PASS (`Timeline.test.tsx`, `model.test.ts`, `ticks.test.ts`, `lanes.test.ts` if Task 2 landed). Then `pnpm --filter @aio/ui exec eslint src/timeline` clean.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/timeline/parts.tsx packages/ui/src/timeline/Timeline.tsx packages/ui/src/timeline/Timeline.test.tsx
git commit -m "refactor(ui): share the timeline axis, ruler and transport pieces"
```

---

### Task 5: `LaneTimeline` component

**Files:**

- Create: `packages/ui/src/timeline/LaneTimeline.tsx`, `packages/ui/src/timeline/LaneTimeline.test.tsx`
- Modify: `packages/ui/src/timeline/lanes.ts` (add `offsetLabel`), `packages/ui/src/timeline/lanes.test.ts`, `packages/ui/src/index.ts`, `packages/ui/src/i18n/en.ts`, `packages/ui/src/mission.css`

**Interfaces:**

- Consumes: everything Task 2 produces; `useTimeAxis`, `Ruler`, `Transport`, `ZoomControls`, `HideButton` from Task 4; `formatDate`, `t`, `Icon`.
- Produces:

```ts
export function offsetLabel(offsetMin: number | null): string; // 'UTC' or 'site time ≈ UTC+3'
export interface LaneTimelineProps {
  model: LaneModel;
  nowMs: number;
  playing: boolean;
  rate: number;
  activeClip: string | null;
  selectedIssue?: string | null;
  colours?: Readonly<Record<string, string>>;
  dateSlot?: ReactNode;
  clockLabel: string;
  onFocusLane(captureId: string): void;
  onExpand(side: 'earlier' | 'later'): void;
  onSeek(utcMs: number): void;
  onClip(layerId: string, atUtcMs?: number): void;
  onIssue?(issueId: string): void;
  onKeyframe?(layerId: string, index: number): void;
  onKeyframeMove?(layerId: string, index: number, utcMs: number, phase: 'move' | 'end'): void;
  onStep(dir: 1 | -1): void;
  onTogglePlay(): void;
  onRate(rate: number): void;
  onHide?(): void;
  hideKeys?: string;
}
export function LaneTimeline(props: LaneTimelineProps): JSX.Element;
```

Test ids it renders: root `lane-timeline` (with `aria-label="Timeline"`), `lane-label-<id>`, `lane-<id>`, `lane-clip`, `lane-fold-earlier`, `lane-fold-later`, `lane-clock`, `playhead`, `ghost-line`, `timecode`, `timeline-tracks`, `timeline-direction-key`.

Packages: `@aio/ui`. Contract change: none.

- [ ] **Step 1: Write the failing tests**

Append to `packages/ui/src/timeline/lanes.test.ts` (add `offsetLabel` to the import):

```ts
describe('offsetLabel', () => {
  it('names the site clock, or UTC without a position', () => {
    expect(offsetLabel(180)).toBe('site time ≈ UTC+3');
    expect(offsetLabel(-300)).toBe('site time ≈ UTC-5');
    expect(offsetLabel(0)).toBe('site time ≈ UTC+0');
    expect(offsetLabel(null)).toBe('UTC');
  });
});
```

Create `packages/ui/src/timeline/LaneTimeline.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LaneTimeline, type LaneTimelineProps } from './LaneTimeline';
import { buildLaneModel, siteMidnightUtc, type LaneIndex } from './lanes';
import type { ClipBar, TimelineModel } from './model';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
});
let host: HTMLDivElement;
let root: Root | null = null;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

const OFF = 180;
const DATES = ['2026-09-05', '2026-09-12', '2026-09-19', '2026-09-26', '2026-10-03', '2026-10-10'];
const at = (d: string, h: number, m = 0) => siteMidnightUtc(d, OFF) + (h * 60 + m) * 60_000;
const clip = (layerId: string, startMs: number): ClipBar => ({
  layerId,
  name: `Clip ${layerId}`,
  startMs,
  endMs: startMs + 600_000,
  estimated: false,
  group: layerId,
});
const d5 = DATES[4] ?? '';
const d6 = DATES[5] ?? '';
const tm: TimelineModel = {
  clips: [clip('e1', at(d5, 9)), clip('f1', at(d6, 9, 5)), clip('f2', at(d6, 9, 30))],
  groups: [],
  issues: [{ issueId: 'i1', code: 'I-1', tMs: at(d6, 9, 6), color: undefined, severity: 1 }],
  photos: [],
  captures: [],
  range: null,
};
const index: LaneIndex = {
  captures: DATES.map((d, i) => ({ id: `d${String(i + 1)}`, label: d, date: d })),
  of: { e1: 'd5', f1: 'd6', f2: 'd6' },
};
const model = buildLaneModel(tm, index, 'd6', OFF);
const props = (over: Partial<LaneTimelineProps> = {}): LaneTimelineProps => ({
  model,
  nowMs: at(d6, 9, 6),
  playing: false,
  rate: 1,
  activeClip: 'f1',
  clockLabel: 'site time ≈ UTC+3',
  onFocusLane: vi.fn(),
  onExpand: vi.fn(),
  onSeek: vi.fn(),
  onClip: vi.fn(),
  onStep: vi.fn(),
  onTogglePlay: vi.fn(),
  onRate: vi.fn(),
  ...over,
});
const render = (p: LaneTimelineProps) => {
  root = createRoot(host);
  act(() => root?.render(<LaneTimeline {...p} />));
};
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const qa = (sel: string) => [...host.querySelectorAll<HTMLElement>(sel)];
const click = (el: Element | null | undefined, detail = 1) => {
  act(() => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true, detail }));
  });
};

describe('LaneTimeline', () => {
  it('draws the visible dates as labelled lanes, the focused one pressed', () => {
    render(props());
    expect(qa('[data-testid^="lane-label-"]').map((e) => e.dataset.testid)).toEqual([
      'lane-label-d4',
      'lane-label-d5',
      'lane-label-d6',
    ]);
    expect(q('lane-label-d6')?.getAttribute('aria-pressed')).toBe('true');
    expect(q('lane-label-d5')?.getAttribute('aria-pressed')).toBe('false');
    expect(q('lane-timeline')?.getAttribute('aria-label')).toBe('Timeline');
    expect(q('lane-clock')?.textContent).toBe('site time ≈ UTC+3');
  });
  it('focuses a date from its label', () => {
    const p = props();
    render(p);
    click(q('lane-label-d5'));
    expect(p.onFocusLane).toHaveBeenCalledWith('d5');
  });
  it('folds the earlier dates behind a row that expands them', () => {
    const p = props();
    render(p);
    expect(q('lane-fold-earlier')?.textContent).toContain('+3 earlier');
    expect(q('lane-fold-later')).toBeNull();
    click(q('lane-fold-earlier'));
    expect(p.onExpand).toHaveBeenCalledWith('earlier');
  });
  it('a clip click in the focused lane chooses it at the clicked time, no focus change', () => {
    const p = props();
    render(p);
    click(q('lane-d6')?.querySelectorAll('[data-testid="lane-clip"]')[1]);
    // jsdom lays nothing out: the click lands at the axis start, clamped into the clip
    expect(p.onClip).toHaveBeenCalledWith('f2', at(d6, 9, 30));
    expect(p.onFocusLane).not.toHaveBeenCalled();
  });
  it('a keyboard click chooses the clip without a time', () => {
    const p = props();
    render(p);
    click(q('lane-d6')?.querySelector('[data-testid="lane-clip"]'), 0);
    expect(p.onClip).toHaveBeenCalledWith('f1');
  });
  it('a clip click in another lane focuses that date first', () => {
    const p = props();
    render(p);
    click(q('lane-d5')?.querySelector('[data-testid="lane-clip"]'));
    expect(p.onFocusLane).toHaveBeenCalledWith('d5');
    expect(p.onClip).toHaveBeenCalledWith('e1', expect.any(Number));
  });
  it('puts the playhead on the focused lane and ghost lines on the others', () => {
    render(props());
    expect(q('lane-d6')?.querySelector('[data-testid="playhead"]')).not.toBeNull();
    expect(qa('[data-testid="playhead"]')).toHaveLength(1);
    expect(qa('[data-testid="ghost-line"]')).toHaveLength(2);
  });
  it('draws issues only on the focused lane, and an issue click seeks and selects', () => {
    const p = props({ onIssue: vi.fn() });
    render(p);
    const marks = qa('.dia');
    expect(marks).toHaveLength(1);
    click(marks[0]);
    expect(p.onSeek).toHaveBeenCalledWith(at(d6, 9, 6));
    expect(p.onIssue).toHaveBeenCalledWith('i1');
  });
  it('shows the site clock in the timecode and the hide button only with onHide', () => {
    render(props({ onHide: vi.fn(), hideKeys: 'T' }));
    expect(q('timecode')?.textContent).toBe('09:06:00.00');
    expect(host.querySelector('.tl-hide')).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @aio/ui exec vitest run src/timeline/LaneTimeline.test.tsx src/timeline/lanes.test.ts`
Expected: FAIL, `./LaneTimeline` not found and `offsetLabel` not exported.

- [ ] **Step 3: Add the strings and `offsetLabel`**

In `packages/ui/src/i18n/en.ts`, after `'timeline.clips_other': '{count} clips',`:

```ts
  'timeline.utc': 'UTC',
  'timeline.siteTime': 'site time ≈ UTC{offset}',
  'timeline.lanes.earlier': '+{count} earlier',
  'timeline.lanes.later': '+{count} later',
  'timeline.lanes.focus': 'Show {date}',
```

In `packages/ui/src/timeline/lanes.ts`, add `import { t } from '../i18n';` at the top and:

```ts
/** The clock the lanes run on: "site time ≈ UTC+3", or "UTC" when the site position is unknown. */
export function offsetLabel(offsetMin: number | null): string {
  if (offsetMin === null) return t('timeline.utc');
  const h = offsetMin / 60;
  return t('timeline.siteTime', { offset: `${h < 0 ? '-' : '+'}${String(Math.abs(h))}` });
}
```

- [ ] **Step 4: Write `LaneTimeline.tsx`**

```tsx
import {
  useRef,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { formatDate } from '../format';
import { t } from '../i18n';
import { Icon } from '../icons/Icon';
import { laneTodOf, utcAt, type Lane, type LaneClip, type LaneModel } from './lanes';
import { HideButton, Ruler, Transport, ZoomControls, useTimeAxis } from './parts';

export interface LaneTimelineProps {
  model: LaneModel;
  nowMs: number;
  playing: boolean;
  rate: number;
  activeClip: string | null;
  selectedIssue?: string | null;
  /** Date tag colour by capture id. */
  colours?: Readonly<Record<string, string>>;
  /** The focused date control (date in full, opens the calendar), placed in the header. */
  dateSlot?: ReactNode;
  /** "site time ≈ UTC+3" or "UTC". */
  clockLabel: string;
  onFocusLane(captureId: string): void;
  onExpand(side: 'earlier' | 'later'): void;
  /** Seek to a project time (UTC ms). */
  onSeek(utcMs: number): void;
  /** A clip was chosen; `atUtcMs` is the clicked time when a pointer clicked its bar. */
  onClip(layerId: string, atUtcMs?: number): void;
  onIssue?(issueId: string): void;
  onKeyframe?(layerId: string, index: number): void;
  onKeyframeMove?(layerId: string, index: number, utcMs: number, phase: 'move' | 'end'): void;
  onStep(dir: 1 | -1): void;
  onTogglePlay(): void;
  onRate(rate: number): void;
  onHide?(): void;
  hideKeys?: string;
}

const vars = (v: Record<string, number>) => v as CSSProperties;
/** UTC time of a time of day inside a clip. */
const utcIn = (c: LaneClip, tod: number) => c.startMs + (tod - c.startTod);

/**
 * One lane per survey date on a shared site time-of-day axis: the focused date full height with
 * names, issues, photos and keyframes and the real playhead; the other visible dates dimmed with
 * their clips and a ghost line at the same time of day. Purely presentational.
 */
export function LaneTimeline(props: LaneTimelineProps) {
  const { model, nowMs, playing, rate, activeClip, selectedIssue } = props;
  const tracksRef = useRef<HTMLDivElement>(null);
  const focused = model.visible.find((l) => l.captureId === model.focus);
  const headTod = focused ? laneTodOf(focused, nowMs, model.offsetMin) : null;
  const axis = useTimeAxis(tracksRef, model.range, headTod ?? 0, playing && headTod !== null);
  const { x, pct, timeAt, width } = axis;
  const active = model.lanes.flatMap((l) => l.clips).find((c) => c.layerId === activeClip);
  const hasClips = model.lanes.some((l) => l.clips.length > 0);

  const scrub = useRef<Lane | null>(null);
  const kfDrag = useRef<{ x: number; moved: boolean } | null>(null);
  const laneAt = (el: HTMLElement): Lane | undefined => {
    const id = el.closest<HTMLElement>('[data-lane]')?.dataset.lane;
    return model.visible.find((l) => l.captureId === id);
  };
  const seekIn = (lane: Lane, clientX: number) => {
    props.onSeek(utcAt(lane, timeAt(clientX), model.offsetMin));
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('[data-hit]')) return;
    const lane = laneAt(target) ?? focused;
    if (!lane) return;
    // dragging in another lane focuses that date first
    if (lane.captureId !== model.focus) props.onFocusLane(lane.captureId);
    scrub.current = lane;
    e.currentTarget.setPointerCapture(e.pointerId);
    seekIn(lane, e.clientX);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (scrub.current) seekIn(scrub.current, e.clientX);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    scrub.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const onClipClick = (lane: Lane, c: LaneClip, e: ReactMouseEvent) => {
    if (lane.captureId !== model.focus) props.onFocusLane(lane.captureId);
    // keyboard activation has no pointer position: the binding picks the time
    if (e.detail === 0) {
      props.onClip(c.layerId);
      return;
    }
    const at = utcIn(c, timeAt(e.clientX));
    props.onClip(c.layerId, Math.min(Math.max(at, c.startMs), c.endMs - 250));
  };

  const fold = (side: 'earlier' | 'later', count: number) =>
    count > 0 && (
      <button
        type="button"
        className="lt-fold"
        data-testid={`lane-fold-${side}`}
        aria-expanded={false}
        onClick={() => {
          props.onExpand(side);
        }}
      >
        {t(side === 'earlier' ? 'timeline.lanes.earlier' : 'timeline.lanes.later', { count })}
        <Icon name="chevdown" size={12} />
      </button>
    );
  const foldTrack = (count: number) => count > 0 && <div className="lt-fold-trk" />;

  const track = (lane: Lane) => {
    const on = lane.captureId === model.focus;
    return (
      <div
        key={lane.captureId}
        className={`trk lt-lane${on ? ' on' : ''}`}
        data-lane={lane.captureId}
        data-testid={`lane-${lane.captureId}`}
        style={vars({ '--rows': Math.max(1, lane.rows) })}
      >
        {lane.clips.map((c) => {
          const left = x(c.startTod);
          const w = x(c.endTod) - left;
          if (left + w < -1 || left > 101) return null;
          const sel = c.layerId === activeClip;
          return (
            <span key={c.layerId}>
              <button
                type="button"
                data-hit
                data-testid="lane-clip"
                className={`seg-c${sel ? ' on' : ''}${c.estimated ? ' est' : ''}`}
                style={{
                  left: `${left}%`,
                  width: `calc(${w}% - 1px)`,
                  ...vars({ '--row': c.row }),
                }}
                title={`${c.name}${c.estimated ? ' (length not known yet)' : ''}`}
                aria-pressed={sel}
                onClick={(e) => {
                  onClipClick(lane, c, e);
                }}
              >
                {on && (w / 100) * width > 96 ? c.name : ''}
              </button>
              {on &&
                c.keysTod?.map((k, i) => (
                  <button
                    key={`${String(i)}-${String(k)}`}
                    type="button"
                    data-hit
                    className="kf"
                    style={{ left: `${x(k)}%`, ...vars({ '--row': c.row }) }}
                    title={`Camera direction keyframe ${String(i + 1)} of ${c.name}`}
                    aria-label={`Camera direction keyframe ${String(i + 1)} of ${c.name}`}
                    data-testid="timeline-direction-key"
                    onPointerDown={(e) => {
                      if (e.button !== 0) return;
                      e.stopPropagation();
                      e.currentTarget.setPointerCapture(e.pointerId);
                      kfDrag.current = { x: e.clientX, moved: false };
                    }}
                    onPointerMove={(e) => {
                      const d = kfDrag.current;
                      if (!d || !props.onKeyframeMove) return;
                      if (!d.moved && Math.abs(e.clientX - d.x) < 3) return;
                      d.moved = true;
                      props.onKeyframeMove(c.layerId, i, utcIn(c, timeAt(e.clientX)), 'move');
                    }}
                    onPointerUp={(e) => {
                      const d = kfDrag.current;
                      kfDrag.current = null;
                      if (!d) return;
                      if (d.moved)
                        props.onKeyframeMove?.(c.layerId, i, utcIn(c, timeAt(e.clientX)), 'end');
                      else props.onKeyframe?.(c.layerId, i);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        props.onKeyframe?.(c.layerId, i);
                      }
                    }}
                  />
                ))}
            </span>
          );
        })}
        {on &&
          lane.photos.map((p) => (
            <i key={`${p.layerId}/${p.photoId}`} className="tick" style={{ left: pct(p.tod) }} />
          ))}
        {on &&
          lane.issues.map((m) => (
            <button
              key={m.issueId}
              type="button"
              data-hit
              className={`dia${m.issueId === selectedIssue ? ' sel' : ''}`}
              style={{ left: pct(m.tod), ...(m.color ? { background: m.color } : {}) }}
              title={`${m.code}, severity ${String(m.severity)}`}
              aria-label={`Issue ${m.code}`}
              onClick={() => {
                props.onSeek(m.tMs);
                props.onIssue?.(m.issueId);
              }}
            />
          ))}
        {headTod !== null &&
          (on ? (
            <div className="playhead" style={{ left: pct(headTod) }} data-testid="playhead" />
          ) : (
            <div className="lt-ghost" style={{ left: pct(headTod) }} data-testid="ghost-line" />
          ))}
      </div>
    );
  };

  return (
    // Time runs left to right in every UI direction.
    <div className="tl lt" aria-label="Timeline" dir="ltr" data-testid="lane-timeline">
      <div className="tl-h">
        <Transport
          canStep={(focused?.clips.length ?? 0) > 0}
          canPlay={hasClips}
          playing={playing}
          clockMs={nowMs + model.offsetMin * 60_000}
          rate={rate}
          activeName={active?.name}
          onStep={props.onStep}
          onTogglePlay={props.onTogglePlay}
          onRate={props.onRate}
        />
        {props.dateSlot}
        <span className="sp" />
        <span className="ctx" data-testid="lane-clock">
          {props.clockLabel}
        </span>
        <ZoomControls axis={axis} anchor={headTod ?? (model.range[0] + model.range[1]) / 2} />
        {props.onHide && <HideButton onHide={props.onHide} hideKeys={props.hideKeys} />}
      </div>
      <div className="tl-body lt-body">
        <div className="tl-labels">
          <div className="tl-ruler-l" />
          {fold('earlier', model.folds.earlier)}
          {model.visible.map((l) => {
            const on = l.captureId === model.focus;
            return (
              <button
                key={l.captureId}
                type="button"
                className={`lt-label${on ? ' on' : ''}`}
                data-testid={`lane-label-${l.captureId}`}
                aria-pressed={on}
                aria-label={t('timeline.lanes.focus', { date: formatDate(l.date) })}
                title={l.label}
                style={vars({ '--rows': Math.max(1, l.rows) })}
                onClick={() => {
                  props.onFocusLane(l.captureId);
                }}
              >
                <span
                  className="dtag"
                  style={{ background: props.colours?.[l.captureId] }}
                  aria-hidden="true"
                />
                {formatDate(l.date)}
                {on && <span className="tm">{l.clips.length}</span>}
              </button>
            );
          })}
          {fold('later', model.folds.later)}
        </div>
        <div
          className="tl-tracks lt-tracks"
          ref={tracksRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          data-testid="timeline-tracks"
        >
          <Ruler axis={axis} />
          {foldTrack(model.folds.earlier)}
          {model.visible.map(track)}
          {foldTrack(model.folds.later)}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Export and style**

In `packages/ui/src/index.ts`, after the `Timeline` export:

```ts
export * from './timeline/lanes';
export { LaneTimeline, type LaneTimelineProps } from './timeline/LaneTimeline';
```

Append to `packages/ui/src/mission.css`, after the `.tl-empty` rule:

```css
/* date lanes: one lane per survey date on a site time-of-day axis */
.lt {
  --lt-row: 8px;
  --lt-row-on: 20px;
}
.lt-body {
  max-height: 40vh;
  overflow-y: auto;
}
.lt-label,
.lt-lane {
  height: calc(var(--rows, 1) * var(--lt-row) + 6px);
}
.lt-label.on,
.lt-lane.on {
  height: calc(var(--rows, 1) * var(--lt-row-on) + 16px);
}
.lt-label {
  all: unset;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding-inline: 12px 10px;
  font-size: var(--t-12);
  color: var(--fg-3);
  border-bottom: 1px solid var(--line-soft);
  cursor: pointer;
  white-space: nowrap;
}
.lt-label.on {
  color: var(--fg-0);
  font-weight: 600;
}
.lt-label:hover {
  color: var(--fg-1);
}
.lt-label:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: -2px;
}
.lt-label .tm {
  margin-inline-start: auto;
  font: 400 10.5px/1 var(--f-mono);
  color: var(--fg-3);
}
.lt-fold {
  all: unset;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  height: 18px;
  padding-inline: 12px;
  font-size: 11px;
  color: var(--fg-3);
  border-bottom: 1px solid var(--line-soft);
  cursor: pointer;
}
.lt-fold:hover {
  color: var(--fg-1);
}
.lt-fold-trk {
  height: 18px;
  border-bottom: 1px solid var(--line-soft);
}
.trk.lt-lane {
  opacity: 0.55;
}
.trk.lt-lane.on {
  opacity: 1;
}
.trk.lt-lane .seg-c {
  top: calc(3px + var(--row, 0) * var(--lt-row));
  height: calc(var(--lt-row) - 2px);
  padding: 0;
}
.trk.lt-lane.on .seg-c {
  top: calc(3px + var(--row, 0) * var(--lt-row-on));
  height: calc(var(--lt-row-on) - 4px);
  padding: 0 4px;
}
.trk.lt-lane.on .kf {
  top: calc(3px + var(--row, 0) * var(--lt-row-on) + 4px);
}
.trk.lt-lane .dia,
.trk.lt-lane .tick {
  top: auto;
  bottom: 2px;
}
.lt-ghost {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 0;
  border-inline-start: 1px dashed var(--acc-a40);
  pointer-events: none;
}
```

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @aio/ui exec vitest run src/timeline src/i18n`
Expected: PASS (`LaneTimeline.test.tsx`, `lanes.test.ts` with `offsetLabel`, `i18n.test.ts` catalogue checks).

- [ ] **Step 7: Commit**

```bash
git add packages/ui/src/timeline/LaneTimeline.tsx packages/ui/src/timeline/LaneTimeline.test.tsx packages/ui/src/timeline/lanes.ts packages/ui/src/timeline/lanes.test.ts packages/ui/src/index.ts packages/ui/src/i18n/en.ts packages/ui/src/mission.css
git commit -m "feat(ui): lane timeline with folds, sub-rows and ghost lines"
```

---

### Task 6: Desktop wiring: lanes in the workspace, the date row, no autoplay

**Files:**

- Create: `apps/desktop/src/renderer/workspace/lanes.ts`, `lanes.test.ts`
- Create: `apps/desktop/src/renderer/workspace/pickClip.ts`, `pickClip.test.ts`
- Modify: `apps/desktop/src/renderer/shell/Sidebar.tsx` (move `selectClip` out, re-export it)
- Create: `apps/desktop/src/renderer/workspace/WorkspaceLanes.tsx`
- Create: `apps/desktop/src/renderer/workspace/DateRow.tsx`, `DateRow.test.tsx`
- Modify: `apps/desktop/src/renderer/workspace/WorkspaceScreen.tsx`, `apps/desktop/src/renderer/styles.css`

**Interfaces:**

- Consumes: `siteUtcOffsetMin` (Task 1); `buildLaneModel`, `laneNeighbour`, `offsetLabel`, `LaneTimeline`, `Popover` and friends from `@aio/ui` (Tasks 3, 5); `DatePicker`, `DateSteps` (Task 3); `timeline`, `useTimeline` (`./timeline`); `toggleTimeline`, `useTimelineShown` (`./timelinePref`); `dateTags`, `useWorkspace`, `workspace`, `clipStartMs` from `@aio/workspace`.
- Produces:
  - `usesLanes(manifest: Pick<ProjectManifest, 'layers'>, index: { captures: readonly unknown[] } | null): boolean`
  - `siteOffset(manifest: Pick<ProjectManifest, 'crs' | 'origin'>): number | null`
  - `selectClip(layerId: string): void` (moved, same behaviour)
  - `pickClip(layerId: string, atMs: number | undefined, clip: { startMs: number; endMs: number } | undefined): void`
  - `WorkspaceLanes(): JSX.Element | null`, `DateRow(): JSX.Element`

Packages: `@aio/desktop`. Contract change: none (no IPC; `@aio/geo` is already a renderer dependency).

- [ ] **Step 1: Write the failing tests**

`apps/desktop/src/renderer/workspace/lanes.test.ts`:

```ts
import { fromWgs84 } from '@aio/geo';
import type { ProjectManifest } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { threeDates } from './__fixtures__/threeDates';
import { siteOffset, usesLanes } from './lanes';

describe('usesLanes', () => {
  const index = { captures: threeDates.captures };
  it('is true for a project with video and dates', () => {
    expect(usesLanes(threeDates, index)).toBe(true);
  });
  it('is false without video, without dates or without an index', () => {
    const noVideo = { layers: threeDates.layers.filter((l) => l.kind !== 'video') };
    expect(usesLanes(noVideo, index)).toBe(false);
    expect(usesLanes(threeDates, { captures: [] })).toBe(false);
    expect(usesLanes(threeDates, null)).toBe(false);
  });
});

describe('siteOffset', () => {
  it('reads the site clock from the origin and the EPSG code', () => {
    const origin = fromWgs84([48.1, 29.0, 0], 32639);
    expect(siteOffset({ crs: { epsg: 32639 }, origin })).toBe(180);
  });
  it('is null for a WKT CRS', () => {
    const m = { crs: { wkt: 'LOCAL_CS["site"]' }, origin: [0, 0, 0] } as Pick<
      ProjectManifest,
      'crs' | 'origin'
    >;
    expect(siteOffset(m)).toBeNull();
  });
});
```

`apps/desktop/src/renderer/workspace/pickClip.test.ts`:

```ts
import { workspace } from '@aio/workspace';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { threeDates } from './__fixtures__/threeDates';
import { pickClip } from './pickClip';

beforeEach(() => {
  workspace.getState().openProject({ id: 'p3', root: '/p3', manifest: threeDates });
});
afterEach(() => {
  workspace.getState().closeProject();
});
const clip = { startMs: 0, endMs: 60_000 };

describe('pickClip', () => {
  it('selects the clip and seeks to the clicked time without playing', () => {
    pickClip('clip-oct', 12_345, clip);
    const s = workspace.getState();
    expect(s.activeClip).toBe('clip-oct');
    expect(s.selection).toMatchObject({ kind: 'clip', id: 'clip-oct' });
    expect(s.nowMs).toBe(12_345);
    expect(s.playing).toBe(false);
  });
  it('from the keyboard moves the clock to the clip start only when it is outside', () => {
    workspace.getState().setTime(100_000);
    pickClip('clip-oct', undefined, clip);
    expect(workspace.getState().nowMs).toBe(0);
    workspace.getState().setTime(30_000);
    pickClip('clip-oct', undefined, clip);
    expect(workspace.getState().nowMs).toBe(30_000);
    expect(workspace.getState().playing).toBe(false);
  });
});
```

`apps/desktop/src/renderer/workspace/DateRow.test.tsx`:

```tsx
// @vitest-environment jsdom
import { captureIndex, workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { threeDates } from './__fixtures__/threeDates';
import { DateRow } from './DateRow';
import { timeline } from './timeline';
import { timelinePref } from './timelinePref';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  localStorage.clear();
  timeline.setState({ byProject: {} });
  timelinePref.setState({ byProject: {} });
  host = document.createElement('div');
  document.body.append(host);
  workspace.getState().openProject({ id: 'p3', root: '/p3', manifest: threeDates });
  timeline.getState().attach('p3', captureIndex(threeDates));
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  timeline.getState().attach(null, null);
  workspace.getState().closeProject();
});
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const render = () => {
  root = createRoot(host);
  act(() => root?.render(<DateRow />));
};

describe('DateRow', () => {
  it('shows the focused date between the arrows', () => {
    render();
    expect(q('date-row')).not.toBeNull();
    expect(q('date-bar-open')?.textContent).toContain('6 Nov 2024');
    act(() => q('date-bar-prev')?.click());
    expect(timeline.getState().focus).toBe('oct');
  });
  it('opens the calendar above itself', () => {
    render();
    act(() => q('date-bar-open')?.click());
    expect(host.querySelector('.dbar-pop.up [data-testid="calendar"]')).not.toBeNull();
  });
  it('brings the timeline back', () => {
    render();
    act(() =>
      host.querySelector<HTMLButtonElement>('button[aria-label="Show the timeline"]')?.click(),
    );
    // the project has video, so the timeline was shown by default: the button flips the choice
    expect(timelinePref.getState().byProject.p3).toBe(false);
  });
});
```

(The last test checks the toggle reached the pref store; which way it flips follows `toggleTimeline`, already covered by `timelinePref.test.ts`.)

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @aio/desktop exec vitest run src/renderer/workspace/lanes.test.ts src/renderer/workspace/pickClip.test.ts src/renderer/workspace/DateRow.test.tsx`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement the helpers**

`apps/desktop/src/renderer/workspace/lanes.ts`:

```ts
import { siteUtcOffsetMin } from '@aio/geo';
import type { ProjectManifest } from '@aio/schema';

/**
 * Whether the bottom timeline shows date lanes: a project with video and at least one survey
 * date. Road projects are decided by the caller (they keep the chainage ruler).
 */
export function usesLanes(
  manifest: Pick<ProjectManifest, 'layers'>,
  index: { captures: readonly unknown[] } | null,
): boolean {
  return (
    index !== null && index.captures.length > 0 && manifest.layers.some((l) => l.kind === 'video')
  );
}

/** The site clock offset from the project longitude (builder rule), null when unknown. */
export function siteOffset(manifest: Pick<ProjectManifest, 'crs' | 'origin'>): number | null {
  return siteUtcOffsetMin(manifest.origin, 'epsg' in manifest.crs ? manifest.crs.epsg : undefined);
}
```

`apps/desktop/src/renderer/workspace/pickClip.ts` (move `selectClip` here verbatim from `Sidebar.tsx`, with its imports):

```ts
import { clipStartMs, workspace } from '@aio/workspace';

/** Select a video clip and make it the active one; the clock moves to its start if before it. */
export function selectClip(layerId: string) {
  const ws = workspace.getState();
  const layer = ws.project?.manifest.layers.find((l) => l.id === layerId);
  ws.select({ kind: 'clip', id: layerId, layer: layerId });
  ws.setActiveClip(layerId);
  if (layer?.kind === 'video') {
    const start = clipStartMs(layer);
    if (ws.nowMs < start) ws.setTime(start);
  }
}

/**
 * A clip bar was clicked: select the clip and seek, never play (Space or Play plays). From a
 * pointer the clock goes to the clicked time; from the keyboard it stays when it is inside the
 * clip, else it goes to the clip start.
 */
export function pickClip(
  layerId: string,
  atMs: number | undefined,
  clip: { startMs: number; endMs: number } | undefined,
): void {
  selectClip(layerId);
  const ws = workspace.getState();
  if (atMs !== undefined) ws.setTime(atMs);
  else if (clip && (ws.nowMs < clip.startMs || ws.nowMs >= clip.endMs - 250))
    ws.setTime(clip.startMs);
}
```

Check where `clipStartMs` is imported from in `Sidebar.tsx` today and use the same module. In `apps/desktop/src/renderer/shell/Sidebar.tsx`, delete the `selectClip` function and add:

```ts
import { selectClip } from '../workspace/pickClip';
export { selectClip };
```

(drop `clipStartMs` from Sidebar's imports if nothing else there uses it).

- [ ] **Step 4: Write `WorkspaceLanes.tsx` and `DateRow.tsx`**

`apps/desktop/src/renderer/workspace/WorkspaceLanes.tsx`:

```tsx
import {
  buildLaneModel,
  buildTimelineModel,
  LaneTimeline,
  laneNeighbour,
  offsetLabel,
} from '@aio/ui';
import { dateTags, useWorkspace, workspace } from '@aio/workspace';
import { useMemo, useState } from 'react';
import { jumpToKeyframe, moveKeyframe, timelineKeys } from '../builder/alignSession';
import { useMedia } from '../media';
import { DatePicker } from './DatePicker';
import { siteOffset } from './lanes';
import { pickClip, selectClip } from './pickClip';
import { timeline, useTimeline } from './timeline';
import { toggleTimeline } from './timelinePref';

/** The bottom timeline of a video project with survey dates: one lane per date. */
export function WorkspaceLanes() {
  const project = useWorkspace((s) => s.project);
  const issues = useWorkspace((s) => s.issues);
  const nowMs = useWorkspace((s) => s.nowMs);
  const playing = useWorkspace((s) => s.playing);
  const rate = useWorkspace((s) => s.rate);
  const activeClip = useWorkspace((s) => s.activeClip);
  const selection = useWorkspace((s) => s.selection);
  const directionDraft = useWorkspace((s) => s.directionDraft);
  const orientation = useWorkspace((s) => s.orientation);
  const index = useTimeline((s) => s.index);
  const focus = useTimeline((s) => s.focus);
  const { durations } = useMedia(project);
  const projectId = project?.id ?? '';
  // folded dates open per project and close again when another project opens
  const [opened, setOpened] = useState({ project: '', earlier: false, later: false });
  const earlier = opened.project === projectId && opened.earlier;
  const later = opened.project === projectId && opened.later;
  const offset = useMemo(() => (project ? siteOffset(project.manifest) : null), [project]);
  const base = useMemo(
    () =>
      project
        ? buildTimelineModel(
            project.manifest,
            issues,
            durations,
            timelineKeys(orientation, directionDraft),
          )
        : null,
    [project, issues, durations, orientation, directionDraft],
  );
  const model = useMemo(
    () =>
      base && index ? buildLaneModel(base, index, focus, offset ?? 0, { earlier, later }) : null,
    [base, index, focus, offset, earlier, later],
  );
  const colours = useMemo(() => {
    const tags = index ? dateTags(index.captures) : {};
    return Object.fromEntries(Object.entries(tags).map(([id, tag]) => [id, tag.colour]));
  }, [index]);
  if (!model) return null;
  const focusedLane = model.lanes.find((l) => l.captureId === model.focus);

  return (
    <LaneTimeline
      model={model}
      nowMs={nowMs}
      playing={playing}
      rate={rate}
      activeClip={activeClip}
      selectedIssue={selection?.kind === 'issue' ? selection.id : null}
      colours={colours}
      dateSlot={<DatePicker up />}
      clockLabel={offsetLabel(offset)}
      hideKeys="T"
      onHide={() => {
        toggleTimeline(workspace.getState().project);
      }}
      onFocusLane={(id) => {
        timeline.getState().focusSurvey(id);
      }}
      onExpand={(side) => {
        setOpened({ project: projectId, earlier, later, [side]: true });
      }}
      onSeek={(t) => {
        workspace.getState().setTime(t);
      }}
      onClip={(id, atMs) => {
        const clip = model.lanes.flatMap((l) => l.clips).find((c) => c.layerId === id);
        pickClip(id, atMs, clip);
      }}
      onIssue={(id) => {
        workspace.getState().select({ kind: 'issue', id });
      }}
      onKeyframe={(layerId, i) => {
        jumpToKeyframe(layerId, i);
      }}
      onKeyframeMove={(layerId, i, tMs, phase) => {
        moveKeyframe(layerId, i, tMs, phase);
      }}
      onStep={(dir) => {
        if (!focusedLane) return;
        const c = laneNeighbour(focusedLane, workspace.getState().activeClip, dir);
        if (!c) return;
        selectClip(c.layerId);
        workspace.getState().setTime(c.startMs);
      }}
      onTogglePlay={() => {
        const ws = workspace.getState();
        if (ws.playing) ws.pause();
        else ws.play();
      }}
      onRate={(r) => {
        workspace.getState().setRate(r);
      }}
    />
  );
}
```

`apps/desktop/src/renderer/workspace/DateRow.tsx`:

```tsx
import { ariaKeys, Icon, useT } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { DateSteps } from './DatePicker';
import { toggleTimeline } from './timelinePref';

/** The lane timeline folded away: one line with the date, its arrows and calendar, and Show. */
export function DateRow() {
  const t = useT();
  return (
    <div className="date-row" role="toolbar" aria-label={t('datebar.label')} data-testid="date-row">
      <DateSteps up />
      <span className="sp" />
      <button
        type="button"
        className="tl-bar-btn"
        aria-label={t('timeline.show')}
        aria-keyshortcuts={ariaKeys('scene.timeline')}
        title={`${t('timeline.show')} (T)`}
        onClick={() => {
          toggleTimeline(workspace.getState().project);
        }}
      >
        <Icon name="clock" size={14} />
        {t('timeline.title')}
        <Icon name="chevup" size={14} />
      </button>
    </div>
  );
}
```

Append to `apps/desktop/src/renderer/styles.css`, after the `.tl-bar` rules:

```css
/* the lane timeline folded away: the date stays reachable */
.date-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 8px;
  background: var(--bg-1);
  border-top: 1px solid var(--line-soft);
}
.date-row .sp {
  flex: 1;
}
```

- [ ] **Step 5: Wire `WorkspaceScreen.tsx`**

1. Imports: add `import { DateRow } from './DateRow';`, `import { usesLanes } from './lanes';`, `import { pickClip } from './pickClip';`, `import { useTimeline } from './timeline';`, `import { WorkspaceLanes } from './WorkspaceLanes';`. Change `import { selectClip } from '../shell/Sidebar';` to `import { selectClip } from './pickClip';`.

2. In `WorkspaceTimeline`, replace the `onClip` handler (drops `play()`):

```tsx
      onClip={(id, atMs) => {
        // A clip bar selects its clip and seeks; Space or Play plays.
        pickClip(id, atMs, model.clips.find((c) => c.layerId === id));
      }}
```

3. In `WorkspaceScreen`, after `const timeline = useTimelineShown(project);` add:

```tsx
const dateIndex = useTimeline((s) => s.index);
const lanes = !road && project !== null && usesLanes(project.manifest, dateIndex);
```

4. Replace `<DateBar />` with `{!lanes && <DateBar />}` and the `tl-wrap` content with:

```tsx
<div className="tl-wrap">
  {road ? (
    <ChainageRuler />
  ) : lanes ? (
    timeline ? (
      <WorkspaceLanes />
    ) : (
      <DateRow />
    )
  ) : timeline ? (
    <WorkspaceTimeline />
  ) : (
    <TimelineBar />
  )}
</div>
```

- [ ] **Step 6: Run the desktop tests and typecheck**

Run: `pnpm --filter @aio/desktop exec vitest run src/renderer/workspace src/renderer/shell`
Expected: PASS, including `DateBar.test.tsx`, `timeline.test.ts`, `timelinePref.test.ts`.
Run: `pnpm typecheck` and `pnpm lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/workspace/lanes.ts apps/desktop/src/renderer/workspace/lanes.test.ts apps/desktop/src/renderer/workspace/pickClip.ts apps/desktop/src/renderer/workspace/pickClip.test.ts apps/desktop/src/renderer/shell/Sidebar.tsx apps/desktop/src/renderer/workspace/WorkspaceLanes.tsx apps/desktop/src/renderer/workspace/DateRow.tsx apps/desktop/src/renderer/workspace/DateRow.test.tsx apps/desktop/src/renderer/workspace/WorkspaceScreen.tsx apps/desktop/src/renderer/styles.css
git commit -m "feat(desktop): date lanes in the workspace timeline, clip click no longer plays"
```

---

### Task 7: End to end specs

**Files:**

- Create: `apps/desktop/e2e/tinyVideo.ts`, `apps/desktop/e2e/timeline-lanes.spec.ts`
- Modify: `apps/desktop/e2e/video-first.spec.ts`, `shell.spec.ts`, `package.spec.ts`, and the real-data spec that defines `playFlight101` (`grep -l "function playFlight101" apps/desktop/e2e/*.spec.ts`)

**Interfaces:**

- Consumes: the test ids from Task 5 and Task 6; `test`, `expect`, `DataRoot` from `./fixtures`.
- Produces: `tinyMp4(): Promise<Buffer>` in `e2e/tinyVideo.ts`.

Packages: `@aio/desktop` (e2e). Contract change: none.

- [ ] **Step 1: Move `tinyMp4` into a helper**

Create `apps/desktop/e2e/tinyVideo.ts` with the function moved verbatim from `video-first.spec.ts`:

```ts
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** A tiny real MP4 (two 32 x 32 frames) from the demo's own H.264 writer. */
export async function tinyMp4(): Promise<Buffer> {
  const url = pathToFileURL(join(import.meta.dirname, '../../../tools/demo/h264.mjs')).href;
  const h264 = (await import(url)) as {
    encodeH264Pcm(frames: Uint8Array[], w: number, h: number): unknown;
    muxMp4(enc: unknown, o: { fps: number }): Buffer;
  };
  const frame = () => new Uint8Array(32 * 32 * 3).fill(96);
  return h264.muxMp4(h264.encodeH264Pcm([frame(), frame()], 32, 32), { fps: 2 });
}
```

In `video-first.spec.ts`, delete the local `tinyMp4`, add `import { tinyMp4 } from './tinyVideo';`, and drop `pathToFileURL` from its imports if now unused.

- [ ] **Step 2: Write the new spec**

Create `apps/desktop/e2e/timeline-lanes.spec.ts`:

```ts
/**
 * Date lanes (timeline phase L1): one lane per survey date on a site time-of-day axis. A synthetic
 * project with six dates, two short clips on each of the last three, none on the first three.
 */
import { cameraQuatFromGimbal, fromWgs84 } from '@aio/geo';
import { ProjectManifest, SCHEMA_VERSION, type ProjectManifestInput } from '@aio/schema';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test as base, type DataRoot } from './fixtures';
import { tinyMp4 } from './tinyVideo';

const ID = 'e2e-date-lanes';
const NAME = 'E2E date lanes';
/** A synthetic place at about 48 degrees east: site time is UTC+3. */
const SITE: [number, number] = [48.1, 29.0];
const DATES = ['2026-09-05', '2026-09-12', '2026-09-19', '2026-09-26', '2026-10-03', '2026-10-10'];
const VIDEO_FROM = 3; // d4, d5, d6 have video

interface Probe {
  __stratlas: {
    workspace: { getState(): { activeClip: string | null; playing: boolean } };
  };
}

async function writeProject(data: DataRoot): Promise<void> {
  const dir = join(data.root, 'projects', ID);
  for (const sub of ['video', 'flights']) await mkdir(join(dir, sub), { recursive: true });
  const mp4 = await tinyMp4();
  const lens = { model: 'pinhole', hfovDeg: 71.59, aspect: 1.7778 } as const;
  const q = cameraQuatFromGimbal(0, -30, 0);
  const layers: ProjectManifestInput['layers'] = [];
  for (const [i, date] of DATES.entries()) {
    if (i < VIDEO_FROM) continue;
    for (const [k, second] of [
      ['a', 0],
      ['b', 30],
    ] as const) {
      const id = `v${String(i + 1)}${k}`;
      // 06:00 UTC is 09:00 at the site
      const startUtcMs = Date.parse(`${date}T06:00:00Z`) + second * 1000;
      await writeFile(
        join(dir, 'flights', `${id}.json`),
        JSON.stringify({
          schema: 'aio.flight/1',
          startUtcMs,
          lens,
          samples: [
            { t: 0, pos: [0, 40, 0], q },
            { t: 1000, pos: [5, 40, 0], q },
          ],
        }),
      );
      await writeFile(join(dir, 'video', `${id}.mp4`), mp4);
      layers.push({
        kind: 'video',
        id,
        name: `Clip ${id}`,
        capture: `d${String(i + 1)}`,
        src: { path: `video/${id}.mp4` },
        flight: { src: { path: `flights/${id}.json` }, startUtcMs },
        lens,
        offsetMs: 0,
      });
    }
  }
  const o = fromWgs84([SITE[0], SITE[1], 0], 32639);
  const input: ProjectManifestInput = {
    schema: SCHEMA_VERSION,
    id: ID,
    name: NAME,
    customer: 'E2E',
    site: 'Synthetic site',
    crs: { epsg: 32639 },
    origin: [o[0], o[1], 0],
    captures: DATES.map((date, i) => ({ id: `d${String(i + 1)}`, label: `Survey ${date}`, date })),
    layers,
    severityModels: [],
    classCatalogues: [],
  };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(ProjectManifest.parse(input)));
  await writeFile(
    join(dir, 'issues.json'),
    JSON.stringify({ schema: 'aio.issues/1', issues: [] }, null, 2),
  );
}

const test = base.extend<{ dataRoot: DataRoot }>({
  dataRoot: async ({ dataRoot }, use) => {
    await writeProject(dataRoot);
    await use(dataRoot);
  },
});
test.setTimeout(120_000);

async function openLanes(win: Page) {
  await win.getByTestId('project-card').filter({ hasText: NAME }).first().click();
  await expect(win.locator('.crumbs')).toContainText(NAME);
  await expect(win.getByTestId('lane-timeline')).toBeVisible({ timeout: 30_000 });
}
const state = (win: Page) =>
  win.evaluate(() => {
    const s = (window as unknown as Probe).__stratlas.workspace.getState();
    return { activeClip: s.activeClip, playing: s.playing };
  });

test('lanes show the focused date and its neighbours, the rest folded', async ({ win }) => {
  await openLanes(win);
  const tl = win.getByTestId('lane-timeline');
  await expect(win.getByTestId('date-bar')).toHaveCount(0);
  await expect(tl.getByTestId('date-bar-open')).toContainText('10 Oct 2026');
  await expect(tl.getByTestId('lane-label-d6')).toHaveAttribute('aria-pressed', 'true');
  for (const id of ['d4', 'd5', 'd6'])
    await expect(tl.getByTestId(`lane-label-${id}`)).toBeVisible();
  await expect(tl.getByTestId('lane-label-d3')).toHaveCount(0);
  await expect(tl.getByTestId('lane-clock')).toHaveText('site time ≈ UTC+3');
});

test('+N earlier expands the folded dates, and a date without video has a lane', async ({
  win,
}) => {
  await openLanes(win);
  const tl = win.getByTestId('lane-timeline');
  await expect(tl.getByTestId('lane-fold-earlier')).toContainText('+3 earlier');
  await tl.getByTestId('lane-fold-earlier').click();
  await expect(tl.getByTestId('lane-label-d1')).toBeVisible();
  await expect(tl.getByTestId('lane-fold-earlier')).toHaveCount(0);
  await expect(tl.getByTestId('lane-d1').getByTestId('lane-clip')).toHaveCount(0);
});

test('a lane label focuses its date and the sidebar follows', async ({ win }) => {
  await openLanes(win);
  await win.getByTestId('lane-label-d5').click();
  await expect(win.getByTestId('date-bar-open')).toContainText('3 Oct 2026');
  await expect(win.getByTestId('lane-label-d5')).toHaveAttribute('aria-pressed', 'true');
  await expect(win.getByTestId('date-folder-d5')).toHaveAttribute('aria-expanded', 'true');
});

test('a clip click selects it without playing', async ({ win }) => {
  await openLanes(win);
  const bar = win.getByTestId('lane-d6').getByTestId('lane-clip').nth(1);
  await bar.click();
  await expect.poll(async () => (await state(win)).activeClip).toBe('v6b');
  expect((await state(win)).playing).toBe(false);
  await expect(
    win.getByTestId('lane-timeline').getByRole('button', { name: 'Play', exact: true }),
  ).toBeVisible();
});

test('the other lanes show a ghost line at the playhead time', async ({ win }) => {
  await openLanes(win);
  await expect(win.getByTestId('lane-d6').getByTestId('playhead')).toHaveCount(1);
  await expect(win.getByTestId('lane-timeline').getByTestId('ghost-line')).toHaveCount(2);
});

test('T folds the timeline to the date row, and Alt+Left still steps', async ({ win }) => {
  await openLanes(win);
  await win.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
  await win.keyboard.press('t');
  await expect(win.getByTestId('date-row')).toBeVisible();
  await expect(win.getByTestId('lane-timeline')).toHaveCount(0);
  await expect(win.getByTestId('date-bar-open')).toContainText('10 Oct 2026');
  await win.keyboard.press('Alt+ArrowLeft');
  await expect(win.getByTestId('date-bar-open')).toContainText('3 Oct 2026');
  await win.keyboard.press('t');
  await expect(win.getByTestId('lane-timeline')).toBeVisible();
});
```

- [ ] **Step 3: Update the specs that rely on the old behaviour**

`apps/desktop/e2e/shell.spec.ts`, test "open a project, drive the shell and keep the sidebar state": the sample project sits at about 48 degrees east, so the timecode now shows site time (UTC+3). Replace the three timecode literals:

```ts
// Timeline: the first clip is active and the clock sits at its start (site time, UTC+3).
await expect(win.getByTestId('timecode')).toContainText('12:00:00');
// Pause once the clock has moved, however slowly this machine draws frames.
await win.getByRole('button', { name: 'Play', exact: true }).click();
await expect(win.getByTestId('timecode')).not.toContainText('12:00:00.00');
await win.getByRole('button', { name: 'Pause', exact: true }).click();
await expect(win.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
await expect(win.getByTestId('timecode')).not.toContainText('12:00:00.00');
```

The real-data spec that defines the helper `playFlight101` (used by its two `@realdata` tests that play a clip): after `await win.keyboard.press('Enter');` add

```ts
// a clip bar selects and seeks; Play plays
await win.getByRole('button', { name: 'Play', exact: true }).click();
```

and update the helper's doc comment ("a pointer click plays from the clicked point") to "a pointer click seeks to the clicked point; Play plays".

`apps/desktop/e2e/package.spec.ts`, test the `@realdata` "as a customer package > exports, opens read-only from the ZIP, streams and seeks video, never writes or calls out" test: after `await bar.click();` add

```ts
await win.getByRole('button', { name: 'Play', exact: true }).click();
```

and change the comment above to "Pick a clip on the timeline and play it, then seek it far into the clip."

No edits to `camera-direction.spec.ts`, `change-frames.spec.ts`, `spot-history.spec.ts`, `stage-display.spec.ts`, `video-proxy.spec.ts`, `timeline.spec.ts` (ids and labels kept); they are run below.

- [ ] **Step 4: Build the demos and run the specs the CI way**

From `apps/desktop` in the worktree, PowerShell (a worktree has no `python/.venv`; point the e2e at the main checkout's venv):

```powershell
pnpm demo:change --quick
pnpm demo:build --quick
$env:QUADRION_WINDOW_SIZE = '1100x720'
$env:QUADRION_E2E_SCALE = '1'
$env:QUADRION_E2E_SWGL = 'warp'
$env:QUADRION_E2E_PYTHON = 'E:\Dev\AIO Software\python\.venv\Scripts\python.exe'
npx playwright test e2e/timeline-lanes.spec.ts --workers=1 --repeat-each=3
npx playwright test e2e/shell.spec.ts e2e/video-first.spec.ts e2e/camera-direction.spec.ts e2e/stage-display.spec.ts e2e/timeline.spec.ts --workers=1 --grep-invert @realdata
npx playwright test e2e/change-frames.spec.ts e2e/spot-history.spec.ts --workers=1 --grep-invert @realdata
```

Expected: every test passes; the log prints `[e2e] window 1100 x 720 px at display scale 1`. One Playwright run at a time. Where the founder's real data is present, also run `npx playwright test <the playFlight101 spec> e2e/package.spec.ts e2e/video-proxy.spec.ts e2e/stage-display.spec.ts --workers=1 --grep @realdata`; otherwise say in the hand-off that the `@realdata` edits were not run.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/e2e/tinyVideo.ts apps/desktop/e2e/timeline-lanes.spec.ts apps/desktop/e2e/video-first.spec.ts apps/desktop/e2e/shell.spec.ts apps/desktop/e2e/package.spec.ts "$(grep -l "function playFlight101" apps/desktop/e2e/*.spec.ts)"
git commit -m "test(desktop): end to end date lanes; specs follow site time and no autoplay"
```

---

### Task 8: Verification and finish

**Files:** none new.

Packages: all. Contract change: none.

- [ ] **Step 1: Full checks**

Run: `pnpm check`
Expected: lint, format check, typecheck and every unit test green. Fix and recommit anything red (never `--no-verify`).

- [ ] **Step 2: Public text scan**

Run: `node tools/agent/check-public-text.mjs docs/plans/2026-10-14-timeline-date-lanes-l1-plan.md apps/desktop/e2e/timeline-lanes.spec.ts`
Expected: no client or site names.

- [ ] **Step 3: Prepare the branch**

Run: `node tools/agent/finish-task.mjs`
Expected: rebased on the latest `origin/main`, checks green, commit messages clean. Then follow `CLAUDE.md` "Every session merges its own branch" (coordinate, lock, draft PR, watch CI, fast-forward).

- [ ] **Step 4: How to test (for the founder)**

1. Open a project that has drone videos on two or more survey dates.
2. The bottom timeline shows one row per date (the focused date tall and bright, up to two dates on each side dimmed), the date in full in its header, and "site time ≈ UTC+3" (or the site's offset) on the right. The date bar above the 3D view is gone.
3. Click another date's label on the left: that date becomes the focused row, and the sidebar opens that date's folder.
4. Click a clip bar: it turns active and the playhead jumps to where you clicked; nothing plays until Space or the Play button.
5. While a clip plays, the other rows show a faint dashed line at the same time of day.
6. With more than five dates, click "+N earlier" at the top: the older dates appear.
7. Press T: the timeline folds to one line with the date and its arrows; Alt+Left steps to the previous date; T brings the lanes back.
8. Open a project without video (or a road project): the date bar above the 3D view and the old bottom bar look as before.
