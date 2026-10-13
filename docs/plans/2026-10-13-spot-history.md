# Spot history S1, one place across survey dates: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From any placed photo, 360, video frame or walk frame, a viewer shows the best image of the same spot on every survey date (gaps visible), steps through them with the arrow keys without touching the main view, and compares two dates side by side or with a swipe.

**Architecture:** A pure spot search (`workspace/spot/`: rules, geometry, one matcher per kind, the search, the spot of an origin, the entries read from the project) answers "what did this spot look like on each date" from stored positions and directions only. One modal dialog, `SpotViewer`, mounted once in `App.tsx` and driven by its own vanilla store, shows the current match, the shared `SpotStrip` and the compare view; it never writes the workspace, the timeline or the shell. Every surface where an image opens gets one "Other dates" button (`SpotHistoryButton`), and the Media photo panel also shows the strip inline.

**Tech stack:** TypeScript strict, React, zustand (vanilla), three.js through the existing panorama view, `@aio/video` (pairing geometry, `FrameImage`, `FramesCompare`, flight loading), vitest (jsdom for components), Playwright with Electron.

**Spec:** `docs/plans/2026-10-13-spot-history-design.md`, Part S1 only. Read "Part S1" and "Founder decisions" first; Part S2 (spot on the map) is not in this plan.

## Global constraints

- Work only in `.claude/worktrees/spot-history`, branch `feat/spot-history`.
- No contract change: no `@aio/schema` change, no IPC, no manifest or file format change, nothing written to disk. The search reads only what is loaded (spec "The search").
- Founder decision 2: **stepping dates in the viewer does not change the main view's date.** The viewer never calls `workspace.select`, `workspace.setTime`, `setHidden`, `timeline.focusSurvey` / `step`, `shell.go` or `shell.setStageMode`, and nothing it does changes the date bar, the focused date or the visible layers, while it is open or after it closes.
- Every kind of capture takes part (founder decision 1): ground photos, drone photos, 360 panoramas, walk frames and videos. Walk frames are the costliest kind and sit in their own late task (Task 12).
- Tolerances live only in `spotRules.ts` (`SPOT_RULES`): ground photo 15 m and 45 degrees, panorama 25 m (`PAIR_MAX_M`), walk frame 15 m, aerial above 10 m over the target, video sampled every 1 s. No other file writes a tolerance as a number.
- Distances are horizontal (x and z); angles wrap at 360 degrees; bearings are compass bearings (0 north, 90 east; the local frame is x east, y up, z south, so north is -z).
- Flat ground everywhere in S1, no surface (spec open point 3): an aerial view's ground is the project origin's height (`y = 0`, as `@aio/video` pairing already assumes); a ground-level view's ground is 1.6 m below its camera (a walk's: the fit's ground height).
- User-facing text: plain words, sentence case, no emoji, no em or en dashes, every string in `packages/ui/src/i18n/en.ts` (Task 6 adds them all). No client, site, tester or person names anywhere (commit subjects included).
- Renderer code never imports `electron` or `node:*`; no `any`, no non-null assertions (tests included: use `?.` and explicit checks).
- Heavy commands (`pnpm check`, demos, Playwright, commits) go through the shared one-at-a-time runner; Playwright with `--workers=1`, windows off-screen (the fixtures do it). Scratch files live outside the worktree.

## Review focus

1. **Photos without a usable pose:** a photo with `pos` but no `q` (some importers), or all photos at `[0, 0, 0]`. Expected: it matches on distance alone (no angle), ties keep list order, nothing crashes. Pinned in Task 2 (`a photo with a position but no direction matches on distance`) and Task 3 (`ties keep entry order`).
2. **A level hand-held photo taken more than 10 m above the project origin** (a roof, a hill, a site whose origin is low). Expected: it is a ground-level spot (its centre line never meets the origin's ground), so nearby ground photos and 360s match by camera; it is not treated as a drone photo looking at nothing. Pinned in Task 4 (`a level photo 12 m above the origin is ground-level`).
3. **The clicked item sits in an undated layer.** Expected: the strip still shows every survey date with its matches, the header says the item has no date, and no slot claims it. Pinned in Task 3 (`an undated origin gets no slot of its own`) and Task 4 (undated entries are still found).
4. **A video whose flight log is missing or broken, or still loading.** Expected: missing or broken counts as skipped on its date (tooltip), loading leaves it out until it arrives and the strip updates; other dates and kinds still show. Pinned in Task 5 (`videoSamples` null and undefined cases) and Task 3 (skipped counts).
5. **The project closes, or the shown item's layer disappears, while the viewer is open** (another session edits, a date is removed). Expected: the viewer closes with the project; a vanished current match falls back to the start date instead of a blank view. Pinned in Task 7 (`resolveAt` falls back) and Task 10 (`closes when the project closes`).
6. **Zooming in Compare, then switching to Swipe or changing a date** (founder, 13 Oct: linked zoom for photos). Expected: both sides keep one zoom and pan, so the swipe divider stays over the same ground; the view never pans past a picture's edge, and leaving Compare starts the next one at fit. Pinned in Task 10 (`spotZoom.test.ts` clamp cases, the viewer test's swipe and date-change cases).

---

## Open points of the spec, resolved

**1. Viewer surfaces and one shared strip.** Today an image opens in five places, none of them general:

| Surface                             | Component today                                                              | Opens from                                            | S1                                  |
| ----------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------- |
| Media photo panel                   | `screens/Media.tsx` with `PhotoViewer` (`@aio/annotate`)                     | a photo card in Media, and every photo picked in 3D   | button + inline strip               |
| Split photo pane                    | `SetPhotoPane` in `workspace/SplitPanes.tsx`                                 | a photo picked while a split side shows photos        | button                              |
| Selection card (Scene, right panel) | `workspace/SelectionCard.tsx`                                                | any selected photo or panorama (panoramas open in 3D) | button                              |
| Frames pane                         | `workspace/FramesPane.tsx` (`FrameImage`, `FramesCompare` from `@aio/video`) | a photo or the playing clip at the clock              | button (photo, or video frame)      |
| Walk player                         | `walks/Walk360Pane.tsx` (`createPanoVideoView`)                              | a walk in the split                                   | button (Task 12)                    |
| Issue lightbox                      | `issueCard/Lightbox.tsx`                                                     | an issue's evidence photos                            | not in S1: its arrows step evidence |

The Scene "photo cards" (`packages/engine/src/adapters/photos.ts`) only select; `Stage.tsx` then sends a selected photo to Media, so the Media panel is where a clicked photo opens. Panoramas open in the engine's immersive view, which has no React host: the Selection card is their entry.

Decision: **one modal viewer, `SpotViewer`** (pattern of `Lightbox.tsx`: scrim, focus trap, Esc), mounted once in `App.tsx`, and one entry, `openSpotHistory(open)`, behind a small `SpotHistoryButton` in each surface above. `SpotStrip` is one component used in two places: inside the viewer, and inline at the bottom of the Media photo panel (glance at the dates, click a slot to open the viewer there). The viewer is look-only: photos and video frames through `FrameImage`, 360s through the T3 panorama surface, so annotation stays where it is. A dialog suits founder decision 2: it holds its own current item instead of moving the workspace selection, which drives the 3D highlight, Media and the split.

**2. The synthetic change demo has what the end to end spec needs; no fixture additions.** `tools/demo/build-change-demo.mjs` writes two dates (`d1`, `d2`) with the same six photos per date (`photoCams`: `d2` jittered by at most 0.5 m in position, with a lens), so every photo has its counterpart within 1 m and a few degrees. `p04` (9 m high) and `p05` (7 m) are ground-level by the 10 m rule; `p01`, `p02`, `p03`, `p06` (14 to 30 m) are drone photos. Each date also has a drone video with a flight log (an orbit at 26 m), so the video kind takes part. The demo has no panoramas (`panoramas/` is removed); the 360 path runs on the existing synthetic `e2e-pano-dates` project (`e2e/panoFixtures.ts`, three dates, panoramas at x = 0, 10, 20 and 2, 11, 60), which needs no demo. Walks have no synthetic placed fixture: walk frames are covered by unit tests only (Task 12) and flagged.

**3. Flat ground, no surface in S1.** Surfaces (mesh or DEM) are left for later. Aerial views meet flat ground at `y = 0` (`SPOT_RULES.groundY`), the same plane `@aio/video` pairing uses (`DEFAULTS.groundY`); ground-level views meet flat ground 1.6 m below the camera (`handHeightM`), and a view whose centre line does not meet that ground within 30 m aims 15 m ahead along its bearing. Walks use the fit's own ground height.

## Spec deviations (founder decisions, 13 Oct 2026)

The founder approved the plan on 13 Oct 2026 with these three deviations from the spec, the second one changed as below. They are decisions now, not open questions.

1. **Compare opens inside the viewer, not in the stage's split.** The spec says Compare opens "the T3 split view". The split cannot show it without breaking decision 2 or the spec's own rules: its photo pane shows the workspace selection (`SetPhotoPane`), the Frames pane picks its other date with its own stricter matcher (30 degrees and footprint overlap, `createViewFollower`) and reads a clip at the project clock, its left side follows the date bar, and no pane shows a walk frame or mixes kinds (the best match of a date can be a 360 when the clicked image is a photo). So **Compare...** turns the viewer's body into two panes (the shown match on the left, the best match of the date before on the right, a date chip above each), with **Side by side** and **Swipe** through `FramesCompare` of `@aio/video` (the same component and handle as the Frames pane), and 360s linked in look through one `createLookLink` store. It stays two clicks away and leaves the main view alone.
2. **Linked zoom and pan in Compare for every kind** (founder, 13 Oct 2026: photos too, side by side and Swipe). 360s and walk frames share one look (`createLookLink`); photos and video frames share one zoom and pan (`createZoomLink`, `spotZoom.ts`): the wheel zooms about the pointer, a drag pans, a double click or `0` fits, on either side, and the other side follows. In Swipe both layers carry the same transform, so the divider stays over the same ground. Task 10 owns it.
3. **Empty slot wording follows the clicked kind** (founder, 13 Oct 2026). "Nothing within 15 m" for photos and walk frames, "Nothing within 25 m" for 360s (their tolerance), "Not seen" for aerial spots.

---

## File map

All new code sits in `apps/desktop/src/renderer/workspace/spot/` unless named otherwise.

| File                                                                                                       | Task | Change                                                           |
| ---------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------- |
| `spotRules.ts`                                                                                             | 1    | new: every tolerance                                             |
| `spotTypes.ts`                                                                                             | 1    | new: spot, item, entry, match, history types                     |
| `spotGeom.ts` (+test)                                                                                      | 1    | new, pure: bearings, angles, ground hits, image points           |
| `__fixtures__/spotPoses.ts`                                                                                | 1    | new: `lookQuat`, a lens, entry builders for tests                |
| `spotMatchers.ts` (+test)                                                                                  | 2    | new, pure: one matcher per kind                                  |
| `spotSearch.ts` (+test)                                                                                    | 3    | new, pure: per-date grouping, ranking, skipped, the clicked item |
| `spotOrigin.ts` (+test)                                                                                    | 4    | new, pure: the spot of a clicked item                            |
| `spotEntries.ts` (+test)                                                                                   | 5    | new, pure: entries from layers, video sampling                   |
| `useSpotEntries.ts`                                                                                        | 5    | new hook: loads flight logs, caches samples                      |
| `packages/ui/src/i18n/en.ts`, `packages/ui/src/shortcuts.ts` (+test)                                       | 6    | words and the `spot` key scope                                   |
| `spotViewerStore.ts` (+test)                                                                               | 7    | new: viewer store and stepping helpers                           |
| `SpotStrip.tsx` (+test), `SpotThumb.tsx`, `spot.css`                                                       | 8    | new: the strip                                                   |
| `workspace/panoSurface.tsx`                                                                                | 9    | new: `PanoSurface` and `useCoverage` moved out of `PanoPane.tsx` |
| `workspace/PanoPane.tsx`                                                                                   | 9    | imports them                                                     |
| `SpotMatchView.tsx` (+test)                                                                                | 9    | new: one match, any kind                                         |
| `spotZoom.ts` (+test), `SpotZoom.tsx`, `SpotViewer.tsx`, `SpotCompare.tsx`, `SpotViewer.test.tsx`          | 10   | new: the dialog, compare, linked photo zoom                      |
| `apps/desktop/src/renderer/App.tsx`                                                                        | 10   | mounts `SpotViewer`                                              |
| `SpotHistoryEntry.tsx` (+test)                                                                             | 11   | new: button and inline strip                                     |
| `screens/Media.tsx`, `workspace/SplitPanes.tsx`, `workspace/SelectionCard.tsx`, `workspace/FramesPane.tsx` | 11   | one button each; Media also the inline strip                     |
| `spotWalk.ts` (+test)                                                                                      | 12   | new: walk tracks from placed fits                                |
| `useSpotEntries.ts`, `SpotMatchView.tsx`, `walks/Walk360Pane.tsx`                                          | 12   | walk entries, walk frame view, button                            |
| `apps/desktop/e2e/spot-history.spec.ts`                                                                    | 13   | new                                                              |
| `docs/guide/04-compare-dates.md`, `docs/TESTING.md`                                                        | 14   | guide section and founder steps                                  |

## Execution DAG

```
T1 rules, types, geometry ─┬─> T2 matchers ─────────┐
                           ├─> T4 spot of an origin ┼─> T3 search ─────────┐
                           ├─> T5 entries + hook ───┼──────────────────────┤
                           ├─> T7 viewer store ─────┼─> T8 strip ──────────┼─> T10 viewer + compare ─> T11 entry points ─> T12 walk frames ─> T13 e2e
T6 words + keys ───────────┴─> T9 match view ───────┘ (T8 also needs T6)   │                                          └─> T14 docs
                                                                           └ (T9 feeds T10)
```

| Batch | Tasks (dispatch together, one message) | Needs                          | Packages touched                                                                        |
| ----- | -------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------- |
| A     | T1, T6                                 | nothing                        | desktop renderer (`workspace/spot/`, new files); `@aio/ui`                              |
| B     | T2, T4, T5, T7, T9                     | T2, T4, T5, T7: T1; T9: T1, T6 | desktop renderer (separate new files; T9 also `PanoPane.tsx`)                           |
| C     | T3, T8                                 | T3: T2, T4; T8: T6, T7         | desktop renderer (separate new files)                                                   |
| D     | T10                                    | T3, T5, T7, T8, T9             | desktop renderer (`spot/`, `App.tsx`)                                                   |
| E     | T11                                    | T10                            | desktop renderer (`Media.tsx`, `SplitPanes.tsx`, `SelectionCard.tsx`, `FramesPane.tsx`) |
| F     | T12, T14                               | T12: T11; T14: T11             | desktop renderer (`spot/`, `walks/Walk360Pane.tsx`); `docs`                             |
| G     | T13                                    | T12                            | `apps/desktop/e2e`                                                                      |

No two tasks of a batch share a file. Linked photo zoom (founder, 13 Oct) adds two files to Task 10 and no dependency: the batches and the critical path are unchanged. **Critical path:** T1, T2, T3, T10, T11, T12, T13. Fourteen tasks; sizes: S = T1, T4, T6, T7, T14; M = T2, T3, T5, T8, T9, T11; L = T10, T12, T13.

T13 can be written during batch F; its run (Step 3) waits for T12's commit so the e2e run covers the final code. Subagents of a batch write and unit-test in parallel (`pnpm --filter @aio/desktop exec vitest run <file>` is light) and each commits through the runner; `pnpm check` runs once per batch, after its last commit.

## Tests and e2e at a glance

| Task | Unit and component tests                                     | e2e                        | Contract |
| ---- | ------------------------------------------------------------ | -------------------------- | -------- |
| 1    | `spotGeom.test.ts`                                           |                            | none     |
| 2    | `spotMatchers.test.ts`                                       |                            | none     |
| 3    | `spotSearch.test.ts`                                         |                            | none     |
| 4    | `spotOrigin.test.ts`                                         |                            | none     |
| 5    | `spotEntries.test.ts`                                        |                            | none     |
| 6    | `packages/ui/src/spotKeys.test.ts`, existing catalogue tests |                            | none     |
| 7    | `spotViewerStore.test.ts`                                    |                            | none     |
| 8    | `SpotStrip.test.tsx`                                         |                            | none     |
| 9    | `SpotMatchView.test.tsx`, existing `PanoPane.test.tsx` green |                            | none     |
| 10   | `spotZoom.test.ts`, `SpotViewer.test.tsx`                    |                            | none     |
| 11   | `SpotHistoryEntry.test.tsx`                                  |                            | none     |
| 12   | `spotWalk.test.ts`, new cases in `SpotMatchView.test.tsx`    |                            | none     |
| 13   |                                                              | new `spot-history.spec.ts` | none     |
| 14   | `pnpm format:check`, `check-public-text.mjs`                 |                            | none     |

Unit test command for any file below: `pnpm --filter @aio/desktop exec vitest run src/renderer/workspace/spot/<file>`.

---

## Tasks

### Task 1: Rules, types and geometry

**Files:**

- Create: `apps/desktop/src/renderer/workspace/spot/spotRules.ts`
- Create: `apps/desktop/src/renderer/workspace/spot/spotTypes.ts`
- Create: `apps/desktop/src/renderer/workspace/spot/spotGeom.ts`
- Create: `apps/desktop/src/renderer/workspace/spot/__fixtures__/spotPoses.ts`
- Test: `apps/desktop/src/renderer/workspace/spot/spotGeom.test.ts`

**Interfaces:**

- Consumes: `Quat`, `Vec3`, `LensModel` from `@aio/schema`; `rayToImage`, `ViewPose` from `@aio/video`; `PAIR_MAX_M`, `groundDistance` from `../panoPair`.
- Produces (used by every later task):

```ts
// spotRules.ts: one `as const` object, the values in Step 1
export const SPOT_RULES = {
  groundPhotoM,
  groundAngleDeg,
  panoM,
  walkM,
  aerialAboveM,
  videoStepS,
  walkStepS,
  angleWeightMPerDeg,
  aerialTie,
  aerialRangeM,
  groundY,
  handHeightM,
  targetRangeM,
  aheadM,
  minHorizontal,
} as const;
export function slotRadiusM(kind: SpotItem['kind']): number;
// spotTypes.ts
export type SpotKind = 'photo' | 'drone' | 'pano' | 'walk' | 'video';
export type SpotItem =
  | { kind: 'photo'; layer: string; photo: string }
  | { kind: 'pano'; layer: string; pano: string }
  | { kind: 'walk'; layer: string; t: number }
  | { kind: 'video'; layer: string; t: number };
export interface SpotOpen {
  item: SpotItem;
  pose?: { pos: Vec3; q: Quat };
  lookDeg?: number;
}
export interface Spot {
  camera?: Vec3;
  bearingDeg?: number;
  target: Vec3;
  aerial: boolean;
}
export interface TrackSample {
  t: number;
  pos: Vec3;
  groundY: number;
  bearingDeg: number;
}
export interface FrameSample {
  t: number;
  pose: ViewPose;
}
export type SpotEntry = PhotoEntry | PanoEntry | WalkEntry | VideoEntry; // below
export interface SpotMatch {
  capture: string;
  kind: SpotKind;
  item: SpotItem;
  distanceM: number;
  angleDeg: number | null;
  lookDeg?: number;
  score: number;
  aerial: boolean;
}
export interface SpotDate {
  capture: string;
  matches: SpotMatch[];
  skipped: number;
}
export interface SpotHistory {
  spot: Spot;
  dates: SpotDate[];
}
// spotGeom.ts
export const wrapDeg: (a: number) => number;
export function angleDiffDeg(a: number, b: number): number;
export { groundDistance };
export function distance3(a: Vec3, b: Vec3): number;
export function bearingOf(d: Vec3): number | undefined;
export function bearingTo(from: Vec3, to: Vec3): number | undefined;
export function levelDir(bearingDeg: number): Vec3;
export function quatMul(a: Quat, b: Quat): Quat;
export function rotate(q: Quat, v: Vec3): Vec3;
export function imagePointOf(pose: ViewPose, p: Vec3): [number, number] | null;
export function inFrame(uv: readonly [number, number]): boolean;
export function centreOffset(uv: readonly [number, number]): number;
export function groundHit(pos: Vec3, dir: Vec3, groundY: number, rangeM: number): Vec3 | null;
export function groundAhead(
  pos: Vec3,
  bearingDeg: number | undefined,
  groundY: number,
  aheadM: number,
): Vec3;
```

- [ ] **Step 1: Write the rules, the types and the test fixture** (no logic to test in these three).

`spotRules.ts`:

```ts
import { PAIR_MAX_M } from '../panoPair';
import type { SpotItem } from './spotTypes';

/**
 * Spot history tolerances (spec "The search", starting values). The only place a tolerance is
 * written; tune them here. Distances in metres (horizontal), angles in degrees.
 */
export const SPOT_RULES = {
  /** A ground photo is the same spot when its camera is this close... */
  groundPhotoM: 15,
  /** ...and it faces within this angle (walk frames from a map click too). */
  groundAngleDeg: 45,
  /** A 360 panorama: camera this close, facing does not matter (as the T3 pairing). */
  panoM: PAIR_MAX_M,
  /** A walk frame: the nearest frame of a placed walk this close. */
  walkM: 15,
  /** A camera more than this far above the target is aerial (drone photos, video). */
  aerialAboveM: 10,
  /** Videos are sampled this often, seconds. */
  videoStepS: 1,
  /** Placed walks are sampled this often, seconds. */
  walkStepS: 1,
  /** Ranking of ground-level matches: metres that one degree of facing weighs. */
  angleWeightMPerDeg: 0.2,
  /** Aerial matches whose target lies this close to equally central count as a tie. */
  aerialTie: 0.01,
  /** An aerial camera sees a target up to this far, metres (as `groundFootprint`). */
  aerialRangeM: 300,
  /** Height of the ground under aerial views: the project origin's, as `@aio/video` pairing. */
  groundY: 0,
  /** A hand-held camera (photo, 360) stands this high above its ground. */
  handHeightM: 1.6,
  /** A ground-level centre line that meets its ground within this range aims there... */
  targetRangeM: 30,
  /** ...else it aims this far ahead along its bearing. */
  aheadM: 15,
  /** A view direction with less than this horizontal share has no bearing (straight down). */
  minHorizontal: 0.1,
} as const;

/** The radius an empty slot names for a spot opened from this kind ("Nothing within 15 m"). */
export function slotRadiusM(kind: SpotItem['kind']): number {
  return kind === 'pano'
    ? SPOT_RULES.panoM
    : kind === 'walk'
      ? SPOT_RULES.walkM
      : SPOT_RULES.groundPhotoM;
}
```

`spotTypes.ts`:

```ts
import type { Quat, Vec3 } from '@aio/schema';
import type { ViewPose } from '@aio/video';

/**
 * Spot history (spec Part S1): a spot is a camera, a facing and a target on the ground; the search
 * returns, per survey date, the images of the same spot. Pure data; no file is written.
 */

/** What a match shows: a ground photo, a drone photo, a 360, a walk frame or a video frame. */
export type SpotKind = 'photo' | 'drone' | 'pano' | 'walk' | 'video';

/** One image the viewer can show: a photo or panorama by id, a walk or clip at `t` seconds. */
export type SpotItem =
  | { kind: 'photo'; layer: string; photo: string }
  | { kind: 'pano'; layer: string; pano: string }
  | { kind: 'walk'; layer: string; t: number }
  | { kind: 'video'; layer: string; t: number };

/** How the viewer is opened: the clicked item, its exact camera when the caller knows it, its look. */
export interface SpotOpen {
  item: SpotItem;
  /** A video frame's calibrated camera at `t` (the Frames pane has it). */
  pose?: { pos: Vec3; q: Quat };
  /** A 360 or walk frame's current compass bearing of the look. */
  lookDeg?: number;
}

export interface Spot {
  camera?: Vec3;
  /** Compass bearing of the view (0 north, 90 east); absent when it looks straight down. */
  bearingDeg?: number;
  /** Where the view's centre line meets the ground. */
  target: Vec3;
  /** The camera is more than `aerialAboveM` above the target. */
  aerial: boolean;
}

/** A placed walk at one moment: camera position, its ground, the picture centre's bearing. */
export interface TrackSample {
  t: number;
  pos: Vec3;
  groundY: number;
  bearingDeg: number;
}

/** A clip at one moment (video seconds) with its calibrated camera. */
export interface FrameSample {
  t: number;
  pose: ViewPose;
}

/** What the search reads. `capture` undefined: an undated layer (found as an origin, never a slot). */
export interface PhotoEntry {
  kind: 'photo';
  layer: string;
  capture: string | undefined;
  id: string;
  /** Absent: no position (no GPS), it cannot match. */
  pos?: Vec3;
  /** Position and direction with the hand correction; null without a direction. */
  pose: ViewPose | null;
  /** The photo has its own lens (drone matching needs one). */
  hasLens: boolean;
}
export interface PanoEntry {
  kind: 'pano';
  layer: string;
  capture: string | undefined;
  id: string;
  pos: Vec3;
  headingDeg: number;
}
export interface WalkEntry {
  kind: 'walk';
  layer: string;
  capture: string | undefined;
  /** Null: not placed, it cannot match. */
  samples: readonly TrackSample[] | null;
}
export interface VideoEntry {
  kind: 'video';
  layer: string;
  capture: string | undefined;
  /** Null: the flight log cannot be read, it cannot match. */
  samples: readonly FrameSample[] | null;
}
export type SpotEntry = PhotoEntry | PanoEntry | WalkEntry | VideoEntry;

export interface SpotMatch {
  capture: string;
  kind: SpotKind;
  item: SpotItem;
  /** Horizontal distance from the spot's camera (or its target when it is aerial), metres. */
  distanceM: number;
  /** Angle between the facings, degrees; null when either has none. */
  angleDeg: number | null;
  /** Compass bearing a 360 or walk frame opens turned to (towards the target). */
  lookDeg?: number;
  /** Lower ranks first within its class (ground-level or aerial). */
  score: number;
  aerial: boolean;
}

export interface SpotDate {
  capture: string;
  /** Best first; the first fills the slot, the others sit behind "+n". */
  matches: SpotMatch[];
  /** Items of this date that cannot match (no position, not placed, unreadable flight). */
  skipped: number;
}

/** Every survey date, oldest first, with its matches. */
export interface SpotHistory {
  spot: Spot;
  dates: SpotDate[];
}
```

`__fixtures__/spotPoses.ts`:

```ts
import type { LensModel, Quat, Vec3 } from '@aio/schema';
import { quatMul } from '../spotGeom';
import type { FrameSample, PanoEntry, PhotoEntry, TrackSample } from '../spotTypes';

/** A camera looking along compass `bearingDeg`, tilted up by `pitchDeg` (-90: straight down). */
export function lookQuat(bearingDeg: number, pitchDeg = 0): Quat {
  const y = (-bearingDeg * Math.PI) / 360;
  const p = (pitchDeg * Math.PI) / 360;
  return quatMul([0, Math.sin(y), 0, Math.cos(y)], [Math.sin(p), 0, 0, Math.cos(p)]);
}
export const LENS: LensModel = { model: 'pinhole', hfovDeg: 60, aspect: 1.5 };

export function photoAt(
  id: string,
  pos: Vec3 | undefined,
  bearingDeg: number | null,
  o: { pitchDeg?: number; capture?: string | undefined; layer?: string; lens?: boolean } = {},
): PhotoEntry {
  const pose =
    pos && bearingDeg !== null
      ? { pos, q: lookQuat(bearingDeg, o.pitchDeg ?? 0), lens: LENS }
      : null;
  return {
    kind: 'photo',
    layer: o.layer ?? 'photos-d2',
    // an explicit `capture: undefined` is an undated layer
    capture: 'capture' in o ? o.capture : 'd2',
    id,
    ...(pos ? { pos } : {}),
    pose,
    hasLens: o.lens ?? true,
  };
}
export function panoAt(id: string, pos: Vec3, capture = 'd2', headingDeg = 0): PanoEntry {
  return { kind: 'pano', layer: `pano-${capture}`, capture, id, pos, headingDeg };
}
export const track = (pts: [number, number, number][], bearingDeg = 0): TrackSample[] =>
  pts.map(([t, x, z]) => ({ t, pos: [x, 1.7, z], groundY: 0, bearingDeg }));
/** A drone looking straight down at 40 m, flying east along z = -15: x = -50 + 10 t. */
export const overflight = (n = 11): FrameSample[] =>
  Array.from({ length: n }, (_, t) => ({
    t,
    pose: { pos: [-50 + 10 * t, 40, -15] as Vec3, q: lookQuat(0, -90), lens: LENS },
  }));
```

- [ ] **Step 2: Write the failing geometry tests** (`spotGeom.test.ts`)

```ts
import { viewDirection } from '@aio/video';
import { describe, expect, it } from 'vitest';
import { LENS, lookQuat } from './__fixtures__/spotPoses';
import {
  angleDiffDeg,
  bearingOf,
  bearingTo,
  centreOffset,
  groundAhead,
  groundHit,
  imagePointOf,
  inFrame,
  wrapDeg,
} from './spotGeom';

const close = (a: readonly number[], b: readonly number[]) =>
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i] ?? NaN, 4));

describe('bearings and angles', () => {
  it('reads compass bearings in the local frame (north is -z, east is +x)', () => {
    expect(bearingOf([0, 0, -1])).toBeCloseTo(0);
    expect(bearingOf([1, 0, 0])).toBeCloseTo(90);
    expect(bearingOf([0, 0, 1])).toBeCloseTo(180);
    expect(bearingOf([-1, 0, 0])).toBeCloseTo(270);
  });
  it('has no bearing straight down or between equal points', () => {
    expect(bearingOf([0, -1, 0])).toBeUndefined();
    expect(bearingOf([0.05, -1, 0])).toBeUndefined();
    expect(bearingTo([3, 0, 3], [3, 9, 3])).toBeUndefined();
  });
  it('wraps angles at 360', () => {
    expect(angleDiffDeg(350, 10)).toBeCloseTo(20);
    expect(angleDiffDeg(10, 350)).toBeCloseTo(20);
    expect(angleDiffDeg(0, 180)).toBeCloseTo(180);
    expect(angleDiffDeg(-30, 690)).toBeCloseTo(0);
    expect(wrapDeg(-90)).toBe(270);
  });
  it('builds test cameras that look where they say', () => {
    close(viewDirection(lookQuat(90)), [1, 0, 0]);
    close(viewDirection(lookQuat(0, -90)), [0, -1, 0]);
  });
});

describe('ground', () => {
  it('meets flat ground along a view that looks down', () => {
    const d = viewDirection(lookQuat(0, -45));
    close(groundHit([0, 10, 0], d, 0, 30) ?? [], [0, 0, -10]);
  });
  it('misses ground beyond the range or above the horizon', () => {
    expect(groundHit([0, 1.6, 0], viewDirection(lookQuat(0, -1)), 0, 30)).toBeNull();
    expect(groundHit([0, 1.6, 0], viewDirection(lookQuat(0, 10)), 0, 30)).toBeNull();
  });
  it('aims ahead along the bearing, or straight below without one', () => {
    close(groundAhead([0, 1.6, 0], 90, 0, 15), [15, 0, 0]);
    close(groundAhead([4, 9, 4], undefined, 2, 15), [4, 2, 4]);
  });
});

describe('image points', () => {
  const down = { pos: [0, 50, 0] as [number, number, number], q: lookQuat(0, -90), lens: LENS };
  it('puts the point below a downward camera at the image centre', () => {
    const uv = imagePointOf(down, [0, 0, 0]);
    close(uv ?? [], [0.5, 0.5]);
    expect(uv && centreOffset(uv)).toBeCloseTo(0);
  });
  it('puts a far point outside the frame and a point behind a pinhole nowhere', () => {
    const far = imagePointOf(down, [100, 0, 0]);
    expect(far && inFrame(far)).toBe(false);
    expect(imagePointOf({ ...down, q: lookQuat(0, 90) }, [0, 0, 0])).toBeNull();
  });
});
```

- [ ] **Step 3: Run, expect FAIL** (`spotGeom` not found).
- [ ] **Step 4: Implement `spotGeom.ts`**

```ts
import type { Quat, Vec3 } from '@aio/schema';
import { rayToImage, type ViewPose } from '@aio/video';
import { groundDistance } from '../panoPair';
import { SPOT_RULES } from './spotRules';

/** Geometry of the spot search: compass bearings, wrapped angles, flat ground, image points. */
export { groundDistance };

const R2D = 180 / Math.PI;

export const wrapDeg = (a: number): number => ((a % 360) + 360) % 360;

/** The angle between two bearings, 0 to 180 degrees. */
export function angleDiffDeg(a: number, b: number): number {
  const d = Math.abs(wrapDeg(a) - wrapDeg(b));
  return d > 180 ? 360 - d : d;
}

export const distance3 = (a: Vec3, b: Vec3): number =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** The compass bearing of a direction, or undefined when it points (almost) straight up or down. */
export function bearingOf(d: Vec3): number | undefined {
  const n = Math.hypot(d[0], d[1], d[2]);
  const h = Math.hypot(d[0], d[2]);
  if (!(n > 0) || h / n < SPOT_RULES.minHorizontal) return undefined;
  return wrapDeg(Math.atan2(d[0], -d[2]) * R2D);
}

export function bearingTo(from: Vec3, to: Vec3): number | undefined {
  return bearingOf([to[0] - from[0], 0, to[2] - from[2]]);
}

/** The level unit direction of a compass bearing. */
export function levelDir(bearingDeg: number): Vec3 {
  const a = bearingDeg / R2D;
  return [Math.sin(a), 0, -Math.cos(a)];
}

/** Hamilton product of `[x, y, z, w]` quaternions. */
export function quatMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** `v` turned by the unit quaternion `q`. */
export function rotate(q: Quat, v: Vec3): Vec3 {
  const p = quatMul(quatMul(q, [v[0], v[1], v[2], 0]), [-q[0], -q[1], -q[2], q[3]]);
  return [p[0], p[1], p[2]];
}

/** Where world point `p` falls in the camera's image (normalised; 0 to 1 is inside), or null. */
export function imagePointOf(pose: ViewPose, p: Vec3): [number, number] | null {
  const d: Vec3 = [p[0] - pose.pos[0], p[1] - pose.pos[1], p[2] - pose.pos[2]];
  return rayToImage(pose.lens, rotate([-pose.q[0], -pose.q[1], -pose.q[2], pose.q[3]], d));
}

export const inFrame = (uv: readonly [number, number]): boolean =>
  uv[0] >= 0 && uv[0] <= 1 && uv[1] >= 0 && uv[1] <= 1;

export const centreOffset = (uv: readonly [number, number]): number =>
  Math.hypot(uv[0] - 0.5, uv[1] - 0.5);

/** Where a centre line meets flat ground `groundY` within `rangeM` horizontally, else null. */
export function groundHit(pos: Vec3, dir: Vec3, groundY: number, rangeM: number): Vec3 | null {
  const h = pos[1] - groundY;
  if (!(h > 0) || !(dir[1] < -1e-9)) return null;
  const t = h / -dir[1];
  if (Math.hypot(dir[0], dir[2]) * t > rangeM) return null;
  return [pos[0] + dir[0] * t, groundY, pos[2] + dir[2] * t];
}

/** The ground point `aheadM` along a bearing, or straight below without one. */
export function groundAhead(
  pos: Vec3,
  bearingDeg: number | undefined,
  groundY: number,
  aheadM: number,
): Vec3 {
  if (bearingDeg === undefined) return [pos[0], groundY, pos[2]];
  const d = levelDir(bearingDeg);
  return [pos[0] + d[0] * aheadM, groundY, pos[2] + d[2] * aheadM];
}
```

- [ ] **Step 5: Run, expect PASS**; `pnpm --filter @aio/desktop exec tsc --noEmit`.
- [ ] **Step 6: Commit** `feat(stage): spot history rules, types and geometry` (through the runner).

### Task 2: One matcher per kind

**Files:**

- Create: `apps/desktop/src/renderer/workspace/spot/spotMatchers.ts`
- Test: `apps/desktop/src/renderer/workspace/spot/spotMatchers.test.ts`

**Interfaces:**

- Consumes: Task 1 (`SPOT_RULES`, geometry, types, fixture); `viewDirection` from `@aio/video`.
- Produces (used by Task 3):

```ts
export type Found = Omit<SpotMatch, 'capture'>;
export function groundRef(spot: Spot): { at: Vec3; withCamera: boolean };
export function matchPhoto(spot: Spot, e: PhotoEntry): Found | null;
export function matchPano(spot: Spot, e: PanoEntry): Found | null;
export function matchWalk(spot: Spot, e: WalkEntry): Found | null;
export function matchVideo(spot: Spot, e: VideoEntry): Found | null;
export function matchEntry(spot: Spot, e: SpotEntry): Found | null;
```

- [ ] **Step 1: Write the failing tests** (`spotMatchers.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { overflight, panoAt, photoAt, track } from './__fixtures__/spotPoses';
import { matchPano, matchPhoto, matchVideo, matchWalk } from './spotMatchers';
import type { Spot } from './spotTypes';

/** Standing at the origin, looking north at a point 15 m away. */
const ground: Spot = { camera: [0, 1.6, 0], bearingDeg: 0, target: [0, 0, -15], aerial: false };
/** The same target, from a map click (S2) or seen from the air. */
const targetOnly: Spot = { target: [0, 0, -15], aerial: false };
const fromAir: Spot = { camera: [0, 40, -15], target: [0, 0, -15], aerial: true };

describe('ground photos', () => {
  it('match within 15 m and 45 degrees, scored by distance plus weighed angle', () => {
    const m = matchPhoto(ground, photoAt('a', [10, 1.6, 0], 30));
    expect(m?.kind).toBe('photo');
    expect(m?.distanceM).toBeCloseTo(10);
    expect(m?.angleDeg).toBeCloseTo(30);
    expect(m?.score).toBeCloseTo(16);
  });
  it('do not match beyond the distance or the angle', () => {
    expect(matchPhoto(ground, photoAt('a', [16, 1.6, 0], 0))).toBeNull();
    expect(matchPhoto(ground, photoAt('a', [5, 1.6, 0], 50))).toBeNull();
  });
  it('compare facings across north', () => {
    const spot = { ...ground, bearingDeg: 10 };
    expect(matchPhoto(spot, photoAt('a', [5, 1.6, 0], 340))?.angleDeg).toBeCloseTo(30);
  });
  it('a photo with a position but no direction matches on distance', () => {
    const m = matchPhoto(ground, photoAt('a', [5, 1.6, 0], null));
    expect(m?.angleDeg).toBeNull();
    expect(m?.score).toBeCloseTo(5);
  });
  it('a photo without a position never matches', () => {
    expect(matchPhoto(ground, photoAt('a', undefined, 0))).toBeNull();
  });
  it('match a target-only spot when they stand near it and face it', () => {
    expect(matchPhoto(targetOnly, photoAt('a', [0, 1.6, -5], 0))?.distanceM).toBeCloseTo(10);
    expect(matchPhoto(targetOnly, photoAt('a', [0, 1.6, -5], 180))).toBeNull();
  });
  it('match an aerial spot on its target, not on the drone camera', () => {
    expect(matchPhoto(fromAir, photoAt('a', [0, 1.6, -5], 0))?.distanceM).toBeCloseTo(10);
  });
});

describe('drone photos', () => {
  it('match when the target is in the frame, best at the centre', () => {
    const m = matchPhoto(ground, photoAt('d', [0, 40, -15], 0, { pitchDeg: -90 }));
    expect(m?.kind).toBe('drone');
    expect(m?.aerial).toBe(true);
    expect(m?.score).toBeCloseTo(0);
  });
  it('do not match when the target is outside the frame', () => {
    expect(matchPhoto(ground, photoAt('d', [100, 40, 0], 0, { pitchDeg: -90 }))).toBeNull();
  });
  it('are left out of aerial matching without a lens of their own', () => {
    expect(
      matchPhoto(ground, photoAt('d', [0, 40, -15], 0, { pitchDeg: -90, lens: false })),
    ).toBeNull();
  });
});

describe('panoramas', () => {
  it('match within 25 m whatever their heading, turned towards the target', () => {
    const m = matchPano(ground, panoAt('p', [20, 1.6, 0], 'd2', 123));
    expect(m?.distanceM).toBeCloseTo(20);
    expect(m?.angleDeg).toBeNull();
    expect(m?.lookDeg).toBeCloseTo(306.87, 1);
  });
  it('do not match beyond 25 m', () => {
    expect(matchPano(ground, panoAt('p', [30, 1.6, 0]))).toBeNull();
  });
});

describe('walk frames', () => {
  const walk = (samples: ReturnType<typeof track> | null) =>
    ({ kind: 'walk', layer: 'walk-a', capture: 'd2', samples }) as const;
  it('match at the nearest frame within 15 m', () => {
    const m = matchWalk(
      ground,
      walk(
        track([
          [0, 40, 0],
          [5, 8, 0],
          [6, 3, 0],
          [9, 20, 0],
        ]),
      ),
    );
    expect(m?.item).toEqual({ kind: 'walk', layer: 'walk-a', t: 6 });
    expect(m?.distanceM).toBeCloseTo(3);
  });
  it('do not match beyond 15 m or when not placed', () => {
    expect(matchWalk(ground, walk(track([[0, 40, 0]])))).toBeNull();
    expect(matchWalk(ground, walk(null))).toBeNull();
  });
  it('face the target of a target-only spot', () => {
    expect(matchWalk(targetOnly, walk(track([[0, 0, -5]], 180)))).toBeNull();
    expect(matchWalk(targetOnly, walk(track([[0, 0, -5]], 0)))?.angleDeg).toBeCloseTo(0);
  });
});

describe('videos', () => {
  const clip = (samples: ReturnType<typeof overflight> | null) =>
    ({ kind: 'video', layer: 'clip', capture: 'd2', samples }) as const;
  it('open at the moment the target is nearest the frame centre, mid-flight', () => {
    const m = matchVideo(ground, clip(overflight()));
    expect(m?.item).toEqual({ kind: 'video', layer: 'clip', t: 5 });
    expect(m?.aerial).toBe(true);
    expect(m?.score).toBeCloseTo(0);
  });
  it('take the closer camera on a tie', () => {
    const two = overflight().filter((f) => f.t === 4 || f.t === 6);
    const spot: Spot = { ...ground, camera: [3, 1.6, -15] };
    expect(matchVideo(spot, clip(two))?.item).toEqual({ kind: 'video', layer: 'clip', t: 6 });
  });
  it('do not match when the target is never in the frame, or the log is unreadable', () => {
    expect(matchVideo({ ...ground, target: [0, 0, 200] }, clip(overflight()))).toBeNull();
    expect(matchVideo(ground, clip(null))).toBeNull();
  });
});
```

(In the tie case `t = 4` sits at x = -10 and `t = 6` at x = +10: equal offsets from the centre; the spot's camera at x = 3 is nearer `t = 6`.)

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement `spotMatchers.ts`**

```ts
import type { Vec3 } from '@aio/schema';
import { viewDirection, type ViewPose } from '@aio/video';
import {
  angleDiffDeg,
  bearingOf,
  bearingTo,
  centreOffset,
  distance3,
  groundDistance,
  imagePointOf,
  inFrame,
} from './spotGeom';
import { SPOT_RULES } from './spotRules';
import type {
  FrameSample,
  PanoEntry,
  PhotoEntry,
  Spot,
  SpotEntry,
  SpotMatch,
  VideoEntry,
  WalkEntry,
} from './spotTypes';

/** One matcher per kind (spec table "Rules"). Pure; the search groups and ranks. */
export type Found = Omit<SpotMatch, 'capture'>;

/**
 * Ground-level kinds measure from the spot's camera when it stands on the ground; from its target
 * when the spot is aerial or has no camera (then they must also face the target).
 */
export function groundRef(spot: Spot): { at: Vec3; withCamera: boolean } {
  return spot.camera && !spot.aerial
    ? { at: spot.camera, withCamera: true }
    : { at: spot.target, withCamera: false };
}

const groundScore = (d: number, angle: number | null) =>
  d + SPOT_RULES.angleWeightMPerDeg * (angle ?? 0);

const facing = (a: number | undefined, b: number | undefined): number | null =>
  a === undefined || b === undefined ? null : angleDiffDeg(a, b);

/** How central the target sits in an aerial camera's frame, or null when it does not see it. */
function aerialSees(pose: ViewPose, spot: Spot): number | null {
  if (distance3(pose.pos, spot.target) > SPOT_RULES.aerialRangeM) return null;
  const uv = imagePointOf(pose, spot.target);
  return uv && inFrame(uv) ? centreOffset(uv) : null;
}

export function matchPhoto(spot: Spot, e: PhotoEntry): Found | null {
  if (!e.pos) return null;
  const item = { kind: 'photo', layer: e.layer, photo: e.id } as const;
  const bearing = e.pose ? bearingOf(viewDirection(e.pose.q)) : undefined;
  if (e.pos[1] - spot.target[1] > SPOT_RULES.aerialAboveM) {
    if (!e.pose || !e.hasLens) return null;
    const offset = aerialSees(e.pose, spot);
    if (offset === null) return null;
    return {
      kind: 'drone',
      item,
      aerial: true,
      distanceM: groundDistance(e.pos, spot.camera ?? spot.target),
      angleDeg: facing(bearing, spot.bearingDeg),
      score: offset,
    };
  }
  const ref = groundRef(spot);
  const d = groundDistance(e.pos, ref.at);
  if (d > SPOT_RULES.groundPhotoM) return null;
  const angle = facing(bearing, ref.withCamera ? spot.bearingDeg : bearingTo(e.pos, spot.target));
  if (angle !== null && angle > SPOT_RULES.groundAngleDeg) return null;
  return {
    kind: 'photo',
    item,
    aerial: false,
    distanceM: d,
    angleDeg: angle,
    score: groundScore(d, angle),
  };
}

export function matchPano(spot: Spot, e: PanoEntry): Found | null {
  const d = groundDistance(e.pos, groundRef(spot).at);
  if (d > SPOT_RULES.panoM) return null;
  return {
    kind: 'pano',
    item: { kind: 'pano', layer: e.layer, pano: e.id },
    aerial: false,
    distanceM: d,
    angleDeg: null,
    lookDeg: bearingTo(e.pos, spot.target) ?? spot.bearingDeg ?? e.headingDeg,
    score: d,
  };
}

export function matchWalk(spot: Spot, e: WalkEntry): Found | null {
  if (!e.samples) return null;
  const ref = groundRef(spot);
  let best: Found | null = null;
  for (const s of e.samples) {
    const d = groundDistance(s.pos, ref.at);
    if (d > SPOT_RULES.walkM) continue;
    const angle = ref.withCamera ? null : facing(s.bearingDeg, bearingTo(s.pos, spot.target));
    if (angle !== null && angle > SPOT_RULES.groundAngleDeg) continue;
    const score = groundScore(d, angle);
    if (best && score >= best.score) continue;
    best = {
      kind: 'walk',
      item: { kind: 'walk', layer: e.layer, t: s.t },
      aerial: false,
      distanceM: d,
      angleDeg: angle,
      lookDeg: bearingTo(s.pos, spot.target) ?? spot.bearingDeg ?? s.bearingDeg,
      score,
    };
  }
  return best;
}

export function matchVideo(spot: Spot, e: VideoEntry): Found | null {
  if (!e.samples) return null;
  let best: { f: FrameSample; offset: number; d: number } | null = null;
  for (const f of e.samples) {
    const offset = aerialSees(f.pose, spot);
    if (offset === null) continue;
    const d = groundDistance(f.pose.pos, spot.camera ?? spot.target);
    const better =
      !best ||
      offset < best.offset - SPOT_RULES.aerialTie ||
      (Math.abs(offset - best.offset) <= SPOT_RULES.aerialTie && d < best.d);
    if (better) best = { f, offset, d };
  }
  if (!best) return null;
  return {
    kind: 'video',
    item: { kind: 'video', layer: e.layer, t: best.f.t },
    aerial: true,
    distanceM: best.d,
    angleDeg: facing(bearingOf(viewDirection(best.f.pose.q)), spot.bearingDeg),
    score: best.offset,
  };
}

export function matchEntry(spot: Spot, e: SpotEntry): Found | null {
  switch (e.kind) {
    case 'photo':
      return matchPhoto(spot, e);
    case 'pano':
      return matchPano(spot, e);
    case 'walk':
      return matchWalk(spot, e);
    case 'video':
      return matchVideo(spot, e);
  }
}
```

- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(stage): spot history matchers for photos, 360s, walks and videos`.

### Task 3: The search: dates, ranking, skipped items, the clicked item

**Files:**

- Create: `apps/desktop/src/renderer/workspace/spot/spotSearch.ts`
- Test: `apps/desktop/src/renderer/workspace/spot/spotSearch.test.ts`

**Interfaces:**

- Consumes: Task 2 (`matchEntry`), Task 4 (`spotOf`), Task 1 types; `CaptureIndex` from `@aio/workspace`.
- Produces (used by Tasks 10, 11):

```ts
export interface SearchInput {
  spot: Spot;
  entries: readonly SpotEntry[];
  /** Survey dates, oldest first. */
  captures: readonly string[];
  origin?: { item: SpotItem; capture: string | undefined };
}
export function searchSpot(input: SearchInput): SpotHistory;
export function sameItem(a: SpotItem, b: SpotItem): boolean;
export type HistoryResult = { history: SpotHistory } | { error: 'noPosition' };
export function historyFor(
  open: SpotOpen,
  entries: readonly SpotEntry[],
  index: Pick<CaptureIndex, 'captures'>,
): HistoryResult;
```

- [ ] **Step 1: Write the failing tests** (`spotSearch.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { overflight, panoAt, photoAt } from './__fixtures__/spotPoses';
import { historyFor, sameItem, searchSpot } from './spotSearch';
import type { Spot, SpotEntry } from './spotTypes';

const spot: Spot = { camera: [0, 1.6, 0], bearingDeg: 0, target: [0, 0, -15], aerial: false };
const captures = ['d1', 'd2', 'd3'];
const d1 = (id: string, x: number) =>
  photoAt(id, [x, 1.6, 0], 0, { capture: 'd1', layer: 'photos-d1' });

describe('searchSpot', () => {
  const entries: SpotEntry[] = [
    d1('self', 0),
    d1('near', 2),
    photoAt('far-angle', [10, 1.6, 0], 30),
    photoAt('straight', [12, 1.6, 0], 0),
    photoAt('drone', [0, 40, -15], 0, { pitchDeg: -90 }),
    photoAt('nogps', undefined, 0, { capture: 'd3', layer: 'photos-d3' }),
    { kind: 'video', layer: 'clip-d3', capture: 'd3', samples: null },
    photoAt('undated', [1, 1.6, 0], 0, { capture: undefined, layer: 'photos-any' }),
  ];
  const h = searchSpot({
    spot,
    entries,
    captures,
    origin: { item: { kind: 'photo', layer: 'photos-d1', photo: 'self' }, capture: 'd1' },
  });

  it('lists every survey date, oldest first, gaps included', () => {
    expect(h.dates.map((d) => d.capture)).toEqual(captures);
    expect(h.dates[2]?.matches).toEqual([]);
  });
  it('counts what cannot match on its date', () => {
    expect(h.dates[2]?.skipped).toBe(2);
    expect(h.dates[1]?.skipped).toBe(0);
  });
  it('ranks within a date: the spot class first, then the score', () => {
    expect(h.dates[1]?.matches.map((m) => (m.item.kind === 'photo' ? m.item.photo : ''))).toEqual([
      'straight',
      'far-angle',
      'drone',
    ]);
  });
  it('makes the clicked item the match of its own date, once', () => {
    const own = h.dates[0]?.matches ?? [];
    expect(own[0]?.item).toEqual({ kind: 'photo', layer: 'photos-d1', photo: 'self' });
    expect(own[0]?.distanceM).toBe(0);
    expect(own.filter((m) => m.item.kind === 'photo' && m.item.photo === 'self')).toHaveLength(1);
    expect(own[1]?.item).toEqual({ kind: 'photo', layer: 'photos-d1', photo: 'near' });
  });
  it('leaves undated layers out of every slot', () => {
    for (const d of h.dates)
      expect(d.matches.some((m) => m.item.kind === 'photo' && m.item.photo === 'undated')).toBe(
        false,
      );
  });
  it('ties keep entry order', () => {
    const tie = searchSpot({
      spot,
      captures: ['d2'],
      entries: [photoAt('m', [0, 1.6, 0], null), photoAt('n', [0, 1.6, 0], null)],
    });
    expect(tie.dates[0]?.matches.map((m) => (m.item.kind === 'photo' ? m.item.photo : ''))).toEqual(
      ['m', 'n'],
    );
  });
  it('an undated origin gets no slot of its own', () => {
    const u = searchSpot({
      spot,
      entries,
      captures,
      origin: {
        item: { kind: 'photo', layer: 'photos-any', photo: 'undated' },
        capture: undefined,
      },
    });
    const ids = (c: number) =>
      u.dates[c]?.matches.map((m) => (m.item.kind === 'photo' ? m.item.photo : ''));
    expect(ids(0)).toEqual(['self', 'near']);
    expect(ids(1)).toEqual(['straight', 'far-angle', 'drone']);
  });
  it('replaces a clip of the clicked video by the clicked moment', () => {
    const v = searchSpot({
      spot,
      captures: ['d2'],
      entries: [{ kind: 'video', layer: 'clip', capture: 'd2', samples: overflight() }],
      origin: { item: { kind: 'video', layer: 'clip', t: 3.2 }, capture: 'd2' },
    });
    expect(v.dates[0]?.matches.map((m) => m.item)).toEqual([
      { kind: 'video', layer: 'clip', t: 3.2 },
    ]);
  });
});

describe('historyFor', () => {
  const index = { captures: [{ id: 'd1' }, { id: 'd2' }] } as unknown as Parameters<
    typeof historyFor
  >[2];
  it('says when the clicked item has no position', () => {
    const e = [photoAt('x', undefined, 0, { capture: 'd1', layer: 'photos-d1' })];
    expect(
      historyFor({ item: { kind: 'photo', layer: 'photos-d1', photo: 'x' } }, e, index),
    ).toEqual({ error: 'noPosition' });
  });
  it('searches from a panorama', () => {
    const e = [panoAt('a', [0, 1.6, 0], 'd1'), panoAt('b', [3, 1.6, 0], 'd2')];
    const r = historyFor({ item: { kind: 'pano', layer: 'pano-d1', pano: 'a' } }, e, index);
    expect('history' in r && r.history.dates[1]?.matches[0]?.item).toEqual({
      kind: 'pano',
      layer: 'pano-d2',
      pano: 'b',
    });
  });
  it('compares items by identity', () => {
    expect(sameItem({ kind: 'walk', layer: 'w', t: 1 }, { kind: 'walk', layer: 'w', t: 9 })).toBe(
      true,
    );
    expect(
      sameItem({ kind: 'pano', layer: 'p', pano: 'a' }, { kind: 'pano', layer: 'p', pano: 'b' }),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement `spotSearch.ts`**

```ts
import type { CaptureIndex } from '@aio/workspace';
import { matchEntry } from './spotMatchers';
import { spotOf } from './spotOrigin';
import type {
  Spot,
  SpotDate,
  SpotEntry,
  SpotHistory,
  SpotItem,
  SpotKind,
  SpotMatch,
  SpotOpen,
} from './spotTypes';

/**
 * The spot search (spec Part S1): every survey date, oldest first, with its matches ranked
 * (the spot's class first, ground-level or aerial, then the score) and the items that cannot
 * match counted. One linear pass; nothing is indexed or stored.
 */
export interface SearchInput {
  spot: Spot;
  entries: readonly SpotEntry[];
  captures: readonly string[];
  origin?: { item: SpotItem; capture: string | undefined };
}

const unplaced = (e: SpotEntry): boolean =>
  (e.kind === 'photo' && !e.pos) || ((e.kind === 'walk' || e.kind === 'video') && !e.samples);

/** The same photo or panorama; for walks and clips, the same layer (one match per layer). */
export function sameItem(a: SpotItem, b: SpotItem): boolean {
  if (a.layer !== b.layer) return false;
  if (a.kind === 'photo') return b.kind === 'photo' && a.photo === b.photo;
  if (a.kind === 'pano') return b.kind === 'pano' && a.pano === b.pano;
  return a.kind === b.kind;
}

function selfMatch(item: SpotItem, capture: string, spot: Spot): SpotMatch {
  const kind: SpotKind = item.kind === 'photo' ? (spot.aerial ? 'drone' : 'photo') : item.kind;
  return {
    capture,
    kind,
    item,
    aerial: spot.aerial,
    distanceM: 0,
    angleDeg: 0,
    ...(spot.bearingDeg !== undefined ? { lookDeg: spot.bearingDeg } : {}),
    score: -Infinity,
  };
}

export function searchSpot(input: SearchInput): SpotHistory {
  const { spot } = input;
  const dates = input.captures.map((capture): SpotDate => ({ capture, matches: [], skipped: 0 }));
  const byCapture = new Map(dates.map((d) => [d.capture, d]));
  for (const e of input.entries) {
    const date = e.capture === undefined ? undefined : byCapture.get(e.capture);
    if (!date) continue;
    if (unplaced(e)) {
      date.skipped++;
      continue;
    }
    const m = matchEntry(spot, e);
    if (m) date.matches.push({ ...m, capture: date.capture });
  }
  const cls = (m: SpotMatch) => (m.aerial === spot.aerial ? 0 : 1);
  for (const d of dates) d.matches.sort((a, b) => cls(a) - cls(b) || a.score - b.score);
  const o = input.origin;
  const own = o?.capture === undefined ? undefined : byCapture.get(o.capture);
  if (o && own)
    own.matches = [
      selfMatch(o.item, own.capture, spot),
      ...own.matches.filter((m) => !sameItem(m.item, o.item)),
    ];
  return { spot, dates };
}

export type HistoryResult = { history: SpotHistory } | { error: 'noPosition' };

/** The history of a clicked item, or why there is none. */
export function historyFor(
  open: SpotOpen,
  entries: readonly SpotEntry[],
  index: Pick<CaptureIndex, 'captures'>,
): HistoryResult {
  const spot = spotOf(open, entries);
  if (!spot) return { error: 'noPosition' };
  const capture = entries.find((e) => e.layer === open.item.layer)?.capture;
  return {
    history: searchSpot({
      spot,
      entries,
      captures: index.captures.map((c) => c.id),
      origin: { item: open.item, capture },
    }),
  };
}
```

- [ ] **Step 4: Run, expect PASS.** Add a timing guard: 10,000 photo entries spread over 20 dates search in under 100 ms (`performance.now()` around `searchSpot`, a loose bound of 250 ms so a busy runner does not flake; the spec's budget is 100 ms on a workstation).
- [ ] **Step 5: Commit** `feat(stage): spot history search across survey dates`.

### Task 4: The spot of a clicked item

**Files:**

- Create: `apps/desktop/src/renderer/workspace/spot/spotOrigin.ts`
- Test: `apps/desktop/src/renderer/workspace/spot/spotOrigin.test.ts`

**Interfaces:**

- Consumes: Task 1; `viewDirection` from `@aio/video`.
- Produces (used by Tasks 3, 12):

```ts
export function spotFromPose(pose: { pos: Vec3; q: Quat }): Spot;
export function spotFromLevel(
  pos: Vec3,
  bearingDeg: number | undefined,
  groundY: number,
  dir?: Vec3,
): Spot;
export function spotFromTrack(s: TrackSample, lookDeg?: number): Spot;
export function nearestSample<T extends { t: number }>(
  samples: readonly T[] | null | undefined,
  t: number,
): T | undefined;
export function spotOf(open: SpotOpen, entries: readonly SpotEntry[]): Spot | null;
```

- [ ] **Step 1: Write the failing tests** (`spotOrigin.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { lookQuat, overflight, panoAt, photoAt, track } from './__fixtures__/spotPoses';
import { nearestSample, spotFromPose, spotOf } from './spotOrigin';

const close = (a: readonly number[] | undefined, b: readonly number[]) =>
  b.forEach((v, i) => expect(a?.[i]).toBeCloseTo(v, 2));

describe('spotFromPose', () => {
  it('a hand-held photo looking a little down aims where it meets its ground', () => {
    const s = spotFromPose({ pos: [0, 1.6, 0], q: lookQuat(0, -5) });
    close(s.target, [0, 0, -18.29]);
    expect(s.aerial).toBe(false);
    expect(s.bearingDeg).toBeCloseTo(0);
  });
  it('a level photo aims 15 m ahead', () => {
    close(spotFromPose({ pos: [0, 1.6, 0], q: lookQuat(90) }).target, [15, 0, 0]);
  });
  it('a drone photo looking down aims at the origin ground below, without a bearing', () => {
    const s = spotFromPose({ pos: [0, 40, 0], q: lookQuat(0, -90) });
    close(s.target, [0, 0, 0]);
    expect(s.aerial).toBe(true);
    expect(s.bearingDeg).toBeUndefined();
  });
  it('an oblique drone photo aims where its centre line meets the ground', () => {
    const pitch = (-Math.atan2(30, 40) * 180) / Math.PI;
    close(spotFromPose({ pos: [0, 30, 40], q: lookQuat(0, pitch) }).target, [0, 0, 0]);
  });
  it('a level photo 12 m above the origin is ground-level', () => {
    const s = spotFromPose({ pos: [0, 12, 0], q: lookQuat(0) });
    expect(s.aerial).toBe(false);
    close(s.target, [0, 10.4, -15]);
  });
});

describe('spotOf', () => {
  const entries = [
    photoAt('a', [0, 1.6, 0], 0, { capture: 'd1', layer: 'photos-d1' }),
    photoAt('nogps', undefined, 0, { capture: 'd1', layer: 'photos-d1' }),
    photoAt('dirless', [5, 1.6, 5], null, { capture: 'd1', layer: 'photos-d1' }),
    panoAt('p', [5, 1.6, 5], 'd1', 90),
    { kind: 'video', layer: 'clip', capture: 'd1', samples: overflight() } as const,
    {
      kind: 'walk',
      layer: 'walk',
      capture: 'd1',
      samples: track(
        [
          [0, 0, 0],
          [4, 10, 0],
        ],
        90,
      ),
    } as const,
  ];
  it('finds a photo and its camera', () => {
    expect(
      spotOf({ item: { kind: 'photo', layer: 'photos-d1', photo: 'a' } }, entries)?.camera,
    ).toEqual([0, 1.6, 0]);
  });
  it('has no spot for a photo without a position or an unknown item', () => {
    expect(
      spotOf({ item: { kind: 'photo', layer: 'photos-d1', photo: 'nogps' } }, entries),
    ).toBeNull();
    expect(
      spotOf({ item: { kind: 'photo', layer: 'photos-d1', photo: 'zz' } }, entries),
    ).toBeNull();
  });
  it('a photo without a direction aims below itself', () => {
    close(
      spotOf({ item: { kind: 'photo', layer: 'photos-d1', photo: 'dirless' } }, entries)?.target,
      [5, 0, 5],
    );
  });
  it('a panorama looks along its heading, or along the current look', () => {
    close(
      spotOf({ item: { kind: 'pano', layer: 'pano-d1', pano: 'p' } }, entries)?.target,
      [20, 0, 5],
    );
    close(
      spotOf({ item: { kind: 'pano', layer: 'pano-d1', pano: 'p' }, lookDeg: 180 }, entries)
        ?.target,
      [5, 0, 20],
    );
  });
  it('a video frame takes the given camera, else the nearest sample', () => {
    const given = spotOf(
      {
        item: { kind: 'video', layer: 'clip', t: 2.4 },
        pose: { pos: [7, 40, 7], q: lookQuat(0, -90) },
      },
      entries,
    );
    close(given?.target, [7, 0, 7]);
    close(
      spotOf({ item: { kind: 'video', layer: 'clip', t: 2.4 } }, entries)?.camera,
      [-30, 40, -15],
    );
  });
  it('a walk frame stands at its nearest sample and looks along its bearing', () => {
    const s = spotOf({ item: { kind: 'walk', layer: 'walk', t: 3.1 } }, entries);
    close(s?.camera, [10, 1.7, 0]);
    expect(s?.bearingDeg).toBeCloseTo(90);
  });
  it('picks the nearest sample in time', () => {
    expect(nearestSample([{ t: 0 }, { t: 1 }, { t: 2 }], 1.4)?.t).toBe(1);
    expect(nearestSample(null, 1)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement `spotOrigin.ts`**

```ts
import type { Quat, Vec3 } from '@aio/schema';
import { viewDirection } from '@aio/video';
import { bearingOf, groundAhead, groundHit } from './spotGeom';
import { SPOT_RULES } from './spotRules';
import type { Spot, SpotEntry, SpotOpen, TrackSample } from './spotTypes';

/**
 * The spot of a clicked item (spec "A spot"): its camera, its facing, and where its centre line
 * meets flat ground. High cameras whose centre line meets the origin's ground are aerial; every
 * other view is ground-level, on ground 1.6 m below its camera (a walk: the fit's ground).
 */
export function spotFromLevel(
  pos: Vec3,
  bearingDeg: number | undefined,
  groundY: number,
  dir?: Vec3,
): Spot {
  const target =
    (dir && groundHit(pos, dir, groundY, SPOT_RULES.targetRangeM)) ??
    groundAhead(pos, bearingDeg, groundY, SPOT_RULES.aheadM);
  return {
    camera: pos,
    ...(bearingDeg !== undefined ? { bearingDeg } : {}),
    target,
    aerial: false,
  };
}

export function spotFromPose(pose: { pos: Vec3; q: Quat }): Spot {
  const dir = viewDirection(pose.q);
  const bearingDeg = bearingOf(dir);
  const high = pose.pos[1] - SPOT_RULES.groundY > SPOT_RULES.aerialAboveM;
  const hit = high ? groundHit(pose.pos, dir, SPOT_RULES.groundY, SPOT_RULES.aerialRangeM) : null;
  if (hit)
    return {
      camera: pose.pos,
      ...(bearingDeg !== undefined ? { bearingDeg } : {}),
      target: hit,
      aerial: pose.pos[1] - hit[1] > SPOT_RULES.aerialAboveM,
    };
  return spotFromLevel(pose.pos, bearingDeg, pose.pos[1] - SPOT_RULES.handHeightM, dir);
}

export function spotFromTrack(s: TrackSample, lookDeg?: number): Spot {
  return spotFromLevel(s.pos, lookDeg ?? s.bearingDeg, s.groundY);
}

export function nearestSample<T extends { t: number }>(
  samples: readonly T[] | null | undefined,
  t: number,
): T | undefined {
  let best: T | undefined;
  for (const s of samples ?? []) if (!best || Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
  return best;
}

export function spotOf(open: SpotOpen, entries: readonly SpotEntry[]): Spot | null {
  const { item } = open;
  if (open.pose) return spotFromPose(open.pose);
  for (const e of entries) {
    if (e.layer !== item.layer) continue;
    if (item.kind === 'photo' && e.kind === 'photo' && e.id === item.photo) {
      if (!e.pos) return null;
      return e.pose
        ? spotFromPose(e.pose)
        : spotFromLevel(e.pos, undefined, e.pos[1] - SPOT_RULES.handHeightM);
    }
    if (item.kind === 'pano' && e.kind === 'pano' && e.id === item.pano)
      return spotFromLevel(e.pos, open.lookDeg ?? e.headingDeg, e.pos[1] - SPOT_RULES.handHeightM);
    if (item.kind === 'video' && e.kind === 'video') {
      const f = nearestSample(e.samples, item.t);
      return f ? spotFromPose(f.pose) : null;
    }
    if (item.kind === 'walk' && e.kind === 'walk') {
      const s = nearestSample(e.samples, item.t);
      return s ? spotFromTrack(s, open.lookDeg) : null;
    }
  }
  return null;
}
```

- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(stage): the spot of a clicked photo, 360, walk or video frame`.

### Task 5: Entries from the project, video sampling

**Files:**

- Create: `apps/desktop/src/renderer/workspace/spot/spotEntries.ts`
- Create: `apps/desktop/src/renderer/workspace/spot/useSpotEntries.ts`
- Test: `apps/desktop/src/renderer/workspace/spot/spotEntries.test.ts`

**Interfaces:**

- Consumes: Task 1 types and rules; `layerCapture` from `../framesModel`; `photoPose`, `calibratedVideoPose`, `videoTimeS`, `loadFlight`, `Flight`, `VideoLayer` from `@aio/video`; `photoCorrection`, `clipKeys` from `@aio/geo`; `PhotoCorrection` from `@aio/schema`; `useCaptureIndex` from `../compare`; `assetUrl`, `useWorkspace` from `@aio/workspace`.
- Produces (used by Tasks 10, 11, 12):

```ts
// spotEntries.ts
export interface EntryInputs {
  layers: readonly Layer[];
  index: CaptureIndex;
  correction?: (layer: string, photo: string) => PhotoCorrection | null;
  /** undefined: still reading (left out); null: unreadable (skipped). Absent: clips left out. */
  videoSamples?: (layer: VideoLayer) => readonly FrameSample[] | null | undefined;
  /** The same for walks (Task 12). Absent: walks left out. */
  walkSamples?: (layer: WalkLayer) => readonly TrackSample[] | null | undefined;
}
export function spotEntries(input: EntryInputs): SpotEntry[];
export type DirectionKeys = Parameters<typeof calibratedVideoPose>[3];
export function sampleVideo(
  layer: VideoLayer,
  flight: Flight,
  keys: DirectionKeys,
  stepS?: number,
): FrameSample[];
// useSpotEntries.ts
export function useSpotEntries(active: boolean): { entries: SpotEntry[]; reading: boolean };
```

- [ ] **Step 1: Write the failing tests** (`spotEntries.test.ts`)

```ts
import type { Layer, ProjectManifest } from '@aio/schema';
import type { Flight } from '@aio/video';
import { captureIndex } from '@aio/workspace';
import { describe, expect, it } from 'vitest';
import { LENS, lookQuat } from './__fixtures__/spotPoses';
import { sampleVideo, spotEntries } from './spotEntries';

const photos = (id: string, capture: string | undefined, items: unknown[]) =>
  ({ kind: 'photos', id, name: id, visible: true, capture, items }) as unknown as Layer;
const clip = {
  kind: 'video',
  id: 'clip-d2',
  name: 'clip',
  visible: true,
  capture: 'd2',
  src: { path: 'v.mp4' },
  flight: { src: { path: 'f.json' }, startUtcMs: 1000 },
  lens: LENS,
  offsetMs: 0,
} as unknown as Extract<Layer, { kind: 'video' }>;
const manifest = {
  captures: [
    { id: 'd1', label: 'd1', date: '2025-01-01' },
    { id: 'd2', label: 'd2', date: '2025-02-01' },
  ],
  layers: [
    photos('photos-d1', 'd1', [
      { id: 'a', src: { path: 'a.jpg' }, pos: [1, 2, 3], q: lookQuat(0), lens: LENS },
      { id: 'b', src: { path: 'b.jpg' } },
      { id: 'c', src: { path: 'c.jpg' }, pos: [4, 5, 6] },
    ]),
    photos('photos-any', undefined, [{ id: 'u', src: { path: 'u.jpg' }, pos: [0, 0, 0] }]),
    {
      kind: 'panoramas',
      id: 'pano-d2',
      name: 'p',
      visible: true,
      capture: 'd2',
      items: [{ id: 'p', src: { path: 'p.jpg' }, pos: [9, 0, 9], headingDeg: 30 }],
    },
    clip,
  ],
} as unknown as ProjectManifest;
const index = captureIndex(manifest);

describe('spotEntries', () => {
  const e = spotEntries({ layers: manifest.layers, index, videoSamples: () => null });
  it('reads photos with their date, pose, position and lens', () => {
    const a = e.find((x) => x.kind === 'photo' && x.id === 'a');
    expect(a).toMatchObject({ capture: 'd1', pos: [1, 2, 3], hasLens: true });
    expect(a?.kind === 'photo' && a.pose?.pos).toEqual([1, 2, 3]);
    const c = e.find((x) => x.kind === 'photo' && x.id === 'c');
    expect(c?.kind === 'photo' && c.pose).toBeNull();
    expect(c).toMatchObject({ pos: [4, 5, 6], hasLens: false });
    expect(e.find((x) => x.kind === 'photo' && x.id === 'b')).not.toHaveProperty('pos');
  });
  it('keeps undated layers, without a date', () => {
    expect(e.find((x) => x.kind === 'photo' && x.id === 'u')?.capture).toBeUndefined();
  });
  it('reads panoramas', () => {
    expect(e.find((x) => x.kind === 'pano')).toMatchObject({
      capture: 'd2',
      pos: [9, 0, 9],
      headingDeg: 30,
    });
  });
  it('marks a clip whose flight is unreadable, leaves out one still reading, and skips clips without a reader', () => {
    expect(e.find((x) => x.kind === 'video')).toMatchObject({ samples: null });
    expect(
      spotEntries({ layers: manifest.layers, index, videoSamples: () => undefined }).some(
        (x) => x.kind === 'video',
      ),
    ).toBe(false);
    expect(spotEntries({ layers: manifest.layers, index }).some((x) => x.kind === 'video')).toBe(
      false,
    );
  });
});

describe('sampleVideo', () => {
  const flight: Flight = {
    schema: 'aio.flight/1',
    startUtcMs: 1000,
    lens: LENS,
    samples: Array.from({ length: 11 }, (_, i) => ({
      t: i * 1000,
      pos: [i, 30, 0] as [number, number, number],
      q: lookQuat(0, -90),
    })),
  };
  it('samples every second of the logged flight, in video seconds', () => {
    const s = sampleVideo(clip, flight, null);
    expect(s.map((f) => f.t)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(s[3]?.pose.pos[0]).toBeCloseTo(3);
  });
  it('starts at video second 0 when the log starts earlier', () => {
    const late = { ...clip, offsetMs: 4000 } as typeof clip;
    expect(sampleVideo(late, flight, null)[0]?.t).toBe(0);
    expect(sampleVideo(late, flight, null).at(-1)?.t).toBe(6);
  });
});
```

(`offsetMs` 4000 means the clip starts 4 s into the log: video second `v` is log second `v + 4`, so the log covers video seconds -4 to 6.)

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement `spotEntries.ts`**

```ts
import type { Layer, PhotoCorrection, WalkLayer } from '@aio/schema';
import {
  calibratedVideoPose,
  photoPose,
  videoTimeS,
  type Flight,
  type VideoLayer,
} from '@aio/video';
import type { CaptureIndex } from '@aio/workspace';
import { layerCapture } from '../framesModel';
import { SPOT_RULES } from './spotRules';
import type { FrameSample, SpotEntry, TrackSample } from './spotTypes';

/** What the spot search reads from the open project (spec "Scale": one linear pass). */
export interface EntryInputs {
  layers: readonly Layer[];
  index: CaptureIndex;
  correction?: (layer: string, photo: string) => PhotoCorrection | null;
  videoSamples?: (layer: VideoLayer) => readonly FrameSample[] | null | undefined;
  walkSamples?: (layer: WalkLayer) => readonly TrackSample[] | null | undefined;
}

export function spotEntries(input: EntryInputs): SpotEntry[] {
  const out: SpotEntry[] = [];
  for (const l of input.layers) {
    const capture = layerCapture(l, input.index);
    if (l.kind === 'photos') {
      for (const p of l.items) {
        const pose = photoPose(p, input.correction?.(l.id, p.id) ?? null);
        const pos = pose?.pos ?? p.pos;
        out.push({
          kind: 'photo',
          layer: l.id,
          capture,
          id: p.id,
          ...(pos ? { pos } : {}),
          pose,
          hasLens: p.lens !== undefined,
        });
      }
    } else if (l.kind === 'panoramas') {
      for (const p of l.items)
        out.push({
          kind: 'pano',
          layer: l.id,
          capture,
          id: p.id,
          pos: p.pos,
          headingDeg: p.headingDeg,
        });
    } else if (l.kind === 'video' && input.videoSamples) {
      const samples = input.videoSamples(l);
      if (samples !== undefined) out.push({ kind: 'video', layer: l.id, capture, samples });
    } else if (l.kind === 'walk' && input.walkSamples) {
      const samples = input.walkSamples(l);
      if (samples !== undefined) out.push({ kind: 'walk', layer: l.id, capture, samples });
    }
  }
  return out;
}

export type DirectionKeys = Parameters<typeof calibratedVideoPose>[3];

/** The clip's calibrated camera every `stepS` video seconds over its flight log. */
export function sampleVideo(
  layer: VideoLayer,
  flight: Flight,
  keys: DirectionKeys,
  stepS: number = SPOT_RULES.videoStepS,
): FrameSample[] {
  const first = flight.samples[0];
  const last = flight.samples.at(-1);
  if (!first || !last) return [];
  const from = Math.max(0, videoTimeS(layer, flight, first.t));
  const to = videoTimeS(layer, flight, last.t);
  const out: FrameSample[] = [];
  for (let i = Math.ceil(from / stepS - 1e-9); i * stepS <= to + 1e-9; i++) {
    const t = i * stepS;
    out.push({ t, pose: calibratedVideoPose(layer, flight, t, keys) });
  }
  return out;
}
```

`WalkLayer` is exported by `@aio/schema` (`layers.ts`); if `PhotoCorrection` is not, import it the way `packages/video/src/pairing.ts` does.

- [ ] **Step 4: Implement `useSpotEntries.ts`** (no unit test of its own: Task 10's viewer test mocks it, Task 13 runs it for real)

```ts
import { clipKeys, photoCorrection } from '@aio/geo';
import { loadFlight, type Flight, type VideoLayer } from '@aio/video';
import { assetUrl, useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, useState } from 'react';
import { useCaptureIndex } from '../compare';
import { sampleVideo, spotEntries, type DirectionKeys } from './spotEntries';
import type { FrameSample, SpotEntry } from './spotTypes';

/** Samples of each clip, once per clip and calibration per session (spec "Scale"). */
const sampled = new Map<string, readonly FrameSample[]>();
function cachedSamples(
  projectId: string,
  layer: VideoLayer,
  flight: Flight,
  keys: DirectionKeys,
): readonly FrameSample[] {
  const key = `${projectId}|${layer.id}|${JSON.stringify([layer.flight, layer.offsetMs, layer.orientation ?? null, layer.positionOffsetM ?? null, keys ?? null])}`;
  let s = sampled.get(key);
  if (!s) {
    s = sampleVideo(layer, flight, keys);
    sampled.set(key, s);
  }
  return s;
}

/**
 * The spot search's entries for the open project. Flight logs are read only while `active` (the
 * viewer or an inline strip is open) and shared with the Frames pane through `loadFlight`'s cache.
 */
export function useSpotEntries(active: boolean): { entries: SpotEntry[]; reading: boolean } {
  const project = useWorkspace((s) => s.project);
  const orientation = useWorkspace((s) => s.orientation);
  const index = useCaptureIndex();
  const layers = useMemo(() => project?.manifest.layers ?? [], [project]);
  const clips = useMemo(() => layers.filter((l): l is VideoLayer => l.kind === 'video'), [layers]);
  const key = `${project?.id ?? ''}|${clips.map((l) => `${l.id}=${JSON.stringify(l.flight.src)}`).join('|')}`;
  const [flights, setFlights] = useState<{
    key: string;
    map: ReadonlyMap<string, Flight | null>;
  } | null>(null);
  useEffect(() => {
    if (!active || !project) return;
    let live = true;
    void Promise.allSettled(clips.map((l) => loadFlight(assetUrl(project.id, l.flight.src)))).then(
      (rs) => {
        if (!live) return;
        const map = new Map<string, Flight | null>();
        clips.forEach((l, i) => {
          const r = rs[i];
          map.set(l.id, r?.status === 'fulfilled' ? r.value : null);
        });
        setFlights({ key, map });
      },
    );
    return () => {
      live = false;
    };
  }, [active, project, clips, key]);
  const map = flights?.key === key ? flights.map : null;
  const entries = useMemo(() => {
    if (!project || !index) return [];
    return spotEntries({
      layers,
      index,
      correction: (l, p) => photoCorrection(orientation, l, p),
      videoSamples: (l) => {
        if (!map) return undefined;
        const f = map.get(l.id);
        return f ? cachedSamples(project.id, l, f, clipKeys(orientation, l.id)) : null;
      },
    });
  }, [project, index, layers, orientation, map]);
  return { entries, reading: active && clips.length > 0 && !map };
}
```

(`assetUrl` throws on an invalid path: wrap the `loadFlight` call in `Promise.resolve().then(() => loadFlight(...))` so a bad path becomes a rejected promise, counted as unreadable.)

- [ ] **Step 5: Run, expect PASS**; `pnpm --filter @aio/desktop exec tsc --noEmit`.
- [ ] **Step 6: Commit** `feat(stage): spot history entries from photos, 360s and clips`.

### Task 6: Words and keys

**Files:**

- Modify: `packages/ui/src/i18n/en.ts` (append one block before the closing `} as const`)
- Modify: `packages/ui/src/shortcuts.ts` (the `spot` scope and six shortcuts)
- Test: `packages/ui/src/spotKeys.test.ts`

**Interfaces:**

- Produces (used by Tasks 8 to 12): the message keys below, the scope `'spot'`, the shortcut ids `spot.close`, `spot.prevDate`, `spot.nextDate`, `spot.prevMatch`, `spot.nextMatch`, `spot.compare`.

- [ ] **Step 1: Write the failing test** (`packages/ui/src/spotKeys.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { t } from './i18n';
import { matchShortcut, SHORTCUT_SCOPES } from './shortcuts';

const key = (k: string) => ({
  key: k,
  code: '',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
});

describe('spot history keys', () => {
  it('steps dates with left and right, images with up and down', () => {
    expect(matchShortcut('spot', key('ArrowLeft'))).toBe('spot.prevDate');
    expect(matchShortcut('spot', key('ArrowRight'))).toBe('spot.nextDate');
    expect(matchShortcut('spot', key('ArrowUp'))).toBe('spot.prevMatch');
    expect(matchShortcut('spot', key('ArrowDown'))).toBe('spot.nextMatch');
    expect(matchShortcut('spot', key('c'))).toBe('spot.compare');
    expect(matchShortcut('spot', key('Escape'))).toBe('spot.close');
  });
  it('has a heading in the keyboard map and its words', () => {
    expect(SHORTCUT_SCOPES.some((s) => s.scope === 'spot')).toBe(true);
    expect(t('spot.slot.none', { m: 15 })).toBe('Nothing within 15 m');
    expect(t('spot.slot.skipped', { count: 2 })).toBe('2 items without a position were left out');
  });
});
```

(Match the `KeyLike` shape `matchShortcut` takes; read `comboMatches` in `shortcuts.ts` for the exact fields.)

- [ ] **Step 2: Run, expect FAIL:** `pnpm --filter @aio/ui exec vitest run src/spotKeys.test.ts`.
- [ ] **Step 3: Add the scope and shortcuts** in `shortcuts.ts`: `| 'spot'` in `ShortcutScope`; `{ scope: 'spot', label: 'keys.scope.spot' }` after `lightbox` in `SHORTCUT_SCOPES`; after the `lightbox.*` rows:

```ts
  { id: 'spot.close', scope: 'spot', keys: ['Esc'], label: 'keys.dialog.close' },
  { id: 'spot.prevDate', scope: 'spot', keys: ['Left'], label: 'keys.spot.prevDate' },
  { id: 'spot.nextDate', scope: 'spot', keys: ['Right'], label: 'keys.spot.nextDate' },
  { id: 'spot.prevMatch', scope: 'spot', keys: ['Up'], label: 'keys.spot.prevMatch' },
  { id: 'spot.nextMatch', scope: 'spot', keys: ['Down'], label: 'keys.spot.nextMatch' },
  { id: 'spot.compare', scope: 'spot', keys: ['C'], label: 'keys.spot.compare' },
```

`spot` is focus-bound (the dialog), like `lightbox`: do not add it to the scopes that run together.

- [ ] **Step 4: Add the words** to `en.ts`:

```ts
  // Spot history (timeline): one place across survey dates
  'keys.scope.spot': 'Other dates of a spot',
  'keys.spot.prevDate': 'Previous date with an image',
  'keys.spot.nextDate': 'Next date with an image',
  'keys.spot.prevMatch': 'Previous image of the date',
  'keys.spot.nextMatch': 'Next image of the date',
  'keys.spot.compare': 'Compare two dates',
  'spot.open': 'Other dates',
  'spot.openTip': 'This spot on the other survey dates',
  'spot.dialog': 'Other dates of {name}',
  'spot.strip': 'Survey dates of this spot',
  'spot.kind.photo': 'Photo',
  'spot.kind.drone': 'Drone',
  'spot.kind.pano': '360',
  'spot.kind.walk': 'Walk',
  'spot.kind.video': 'Video',
  'spot.slot.none': 'Nothing within {m} m',
  'spot.slot.notSeen': 'Not seen',
  'spot.slot.more': '+{count}',
  'spot.slot.skipped_one': '{count} item without a position was left out',
  'spot.slot.skipped_other': '{count} items without a position were left out',
  'spot.slot.label': '{date}, {kind}',
  'spot.slot.emptyLabel': '{date}, {reason}',
  'spot.noPosition': "This photo has no position, so other dates can't be matched.",
  'spot.noPositionWalk': "This walk is not placed, so other dates can't be matched.",
  'spot.noDate': 'No survey date',
  'spot.self': 'The image you opened',
  'spot.away': '{m} m away',
  'spot.awayTurned': '{m} m away, turned {deg}°',
  'spot.atTime': 'at {time} s',
  'spot.reading': 'Reading flight logs',
  'spot.missing': 'This image could not be loaded',
  'spot.compare': 'Compare...',
  'spot.compareTip': 'Two dates of this spot side by side or swiped (C)',
  'spot.compare.modes': 'How to compare',
  'spot.compare.side': 'Side by side',
  'spot.compare.swipe': 'Swipe',
  'spot.compare.left': 'Left date',
  'spot.compare.right': 'Right date',
  'spot.compare.handle': 'Swipe between the two dates',
  'spot.compare.empty': 'No image of this spot on that date',
  'spot.compare.back': 'One image',
  'spot.close': 'Close',
  'spot.keys': '← → dates · ↑ ↓ other images of the date · C compare · Esc close',
```

- [ ] **Step 5: Run** the new test and `pnpm --filter @aio/ui exec vitest run` (the catalogue, plural and shortcut-conflict tests), PASS.
- [ ] **Step 6: Commit** `feat(ui): words and keys for spot history`.

### Task 7: The viewer store and stepping

**Files:**

- Create: `apps/desktop/src/renderer/workspace/spot/spotViewerStore.ts`
- Test: `apps/desktop/src/renderer/workspace/spot/spotViewerStore.test.ts`

**Interfaces:**

- Consumes: Task 1 types.
- Produces (used by Tasks 8, 10, 11):

```ts
export interface SpotAt {
  capture: string;
  i: number;
}
export type SpotCompareMode = 'side' | 'swipe';
export interface SpotCompareState {
  mode: SpotCompareMode;
  left: SpotAt;
  right: SpotAt | null;
  amount: number;
}
export interface SpotViewerState {
  open: SpotOpen | null;
  at: SpotAt | null;
  compare: SpotCompareState | null;
  show(open: SpotOpen, at?: SpotAt): void;
  close(): void;
  goTo(at: SpotAt): void;
  setCompare(c: SpotCompareState | null): void;
}
export function createSpotViewer(): StoreApi<SpotViewerState>;
export const spotViewer: StoreApi<SpotViewerState>;
export function openSpotHistory(open: SpotOpen, at?: SpotAt): void;
export function matchAt(h: SpotHistory, at: SpotAt | null): SpotMatch | undefined;
export function startAt(h: SpotHistory, capture: string | undefined): SpotAt | null;
export function resolveAt(
  h: SpotHistory,
  at: SpotAt | null,
  capture: string | undefined,
): SpotAt | null;
export function stepDate(h: SpotHistory, at: SpotAt | null, dir: 1 | -1): SpotAt | null;
export function cycleMatch(h: SpotHistory, at: SpotAt | null, dir: 1 | -1): SpotAt | null;
export function defaultOther(h: SpotHistory, capture: string): SpotAt | null;
```

- [ ] **Step 1: Write the failing tests** (`spotViewerStore.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import {
  createSpotViewer,
  cycleMatch,
  defaultOther,
  matchAt,
  resolveAt,
  startAt,
  stepDate,
} from './spotViewerStore';
import type { SpotHistory, SpotMatch } from './spotTypes';

const m = (capture: string, photo: string): SpotMatch => ({
  capture,
  kind: 'photo',
  item: { kind: 'photo', layer: `photos-${capture}`, photo },
  distanceM: 1,
  angleDeg: 0,
  score: 1,
  aerial: false,
});
const h: SpotHistory = {
  spot: { target: [0, 0, 0], aerial: false },
  dates: [
    { capture: 'd1', matches: [m('d1', 'a')], skipped: 0 },
    { capture: 'd2', matches: [], skipped: 3 },
    { capture: 'd3', matches: [m('d3', 'b'), m('d3', 'c'), m('d3', 'd')], skipped: 0 },
    { capture: 'd4', matches: [], skipped: 0 },
  ],
};

describe('stepping', () => {
  it('steps to the next or previous date with a match, skipping gaps', () => {
    expect(stepDate(h, { capture: 'd1', i: 0 }, 1)).toEqual({ capture: 'd3', i: 0 });
    expect(stepDate(h, { capture: 'd3', i: 2 }, -1)).toEqual({ capture: 'd1', i: 0 });
  });
  it('stays at the ends', () => {
    expect(stepDate(h, { capture: 'd3', i: 1 }, 1)).toEqual({ capture: 'd3', i: 1 });
    expect(stepDate(h, { capture: 'd1', i: 0 }, -1)).toEqual({ capture: 'd1', i: 0 });
  });
  it('cycles the images of a date both ways', () => {
    expect(cycleMatch(h, { capture: 'd3', i: 2 }, 1)).toEqual({ capture: 'd3', i: 0 });
    expect(cycleMatch(h, { capture: 'd3', i: 0 }, -1)).toEqual({ capture: 'd3', i: 2 });
    expect(cycleMatch(h, { capture: 'd1', i: 0 }, 1)).toEqual({ capture: 'd1', i: 0 });
  });
  it('starts at the clicked date, else the newest date with a match', () => {
    expect(startAt(h, 'd1')).toEqual({ capture: 'd1', i: 0 });
    expect(startAt(h, 'd2')).toEqual({ capture: 'd3', i: 0 });
    expect(startAt(h, undefined)).toEqual({ capture: 'd3', i: 0 });
  });
  it('falls back to the start when the shown match is gone', () => {
    expect(resolveAt(h, { capture: 'd3', i: 7 }, 'd1')).toEqual({ capture: 'd1', i: 0 });
    expect(resolveAt(h, { capture: 'gone', i: 0 }, 'd1')).toEqual({ capture: 'd1', i: 0 });
    expect(resolveAt(h, { capture: 'd3', i: 1 }, 'd1')).toEqual({ capture: 'd3', i: 1 });
  });
  it('compares with the date before by default, else the date after', () => {
    expect(defaultOther(h, 'd3')).toEqual({ capture: 'd1', i: 0 });
    expect(defaultOther(h, 'd1')).toEqual({ capture: 'd3', i: 0 });
    expect(matchAt(h, { capture: 'd3', i: 1 })?.item).toEqual({
      kind: 'photo',
      layer: 'photos-d3',
      photo: 'c',
    });
  });
});

describe('store', () => {
  it('opens, moves, compares and closes without other state', () => {
    const s = createSpotViewer();
    s.getState().show({ item: { kind: 'photo', layer: 'photos-d1', photo: 'a' } });
    expect(s.getState().at).toBeNull();
    s.getState().goTo({ capture: 'd3', i: 1 });
    s.getState().setCompare({
      mode: 'swipe',
      left: { capture: 'd3', i: 1 },
      right: null,
      amount: 0.5,
    });
    s.getState().show({ item: { kind: 'pano', layer: 'p', pano: 'x' } }, { capture: 'd1', i: 0 });
    expect(s.getState().at).toEqual({ capture: 'd1', i: 0 });
    expect(s.getState().compare).toBeNull();
    s.getState().close();
    expect(s.getState()).toMatchObject({ open: null, at: null, compare: null });
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement `spotViewerStore.ts`**

```ts
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { SpotHistory, SpotMatch, SpotOpen } from './spotTypes';

/**
 * The spot viewer's own state (founder decision 2): what it shows, never the workspace's
 * selection, date or layers. Pure stepping helpers below; the dialog is SpotViewer.tsx.
 */
export interface SpotAt {
  capture: string;
  i: number;
}
export type SpotCompareMode = 'side' | 'swipe';
export interface SpotCompareState {
  mode: SpotCompareMode;
  left: SpotAt;
  right: SpotAt | null;
  /** Swipe position, 0 to 1. */
  amount: number;
}
export interface SpotViewerState {
  open: SpotOpen | null;
  /** Null: the start date (the clicked one). */
  at: SpotAt | null;
  compare: SpotCompareState | null;
  show(open: SpotOpen, at?: SpotAt): void;
  close(): void;
  goTo(at: SpotAt): void;
  setCompare(c: SpotCompareState | null): void;
}

export function createSpotViewer(): StoreApi<SpotViewerState> {
  return createStore<SpotViewerState>()((set) => ({
    open: null,
    at: null,
    compare: null,
    show: (open, at) => {
      set({ open, at: at ?? null, compare: null });
    },
    close: () => {
      set({ open: null, at: null, compare: null });
    },
    goTo: (at) => {
      set({ at });
    },
    setCompare: (compare) => {
      set({ compare });
    },
  }));
}
export const spotViewer = createSpotViewer();
export function openSpotHistory(open: SpotOpen, at?: SpotAt): void {
  spotViewer.getState().show(open, at);
}

const dateOf = (h: SpotHistory, capture: string) => h.dates.find((d) => d.capture === capture);

export function matchAt(h: SpotHistory, at: SpotAt | null): SpotMatch | undefined {
  return at ? dateOf(h, at.capture)?.matches[at.i] : undefined;
}

export function startAt(h: SpotHistory, capture: string | undefined): SpotAt | null {
  if (capture !== undefined && (dateOf(h, capture)?.matches.length ?? 0) > 0)
    return { capture, i: 0 };
  for (let k = h.dates.length - 1; k >= 0; k--) {
    const d = h.dates[k];
    if (d && d.matches.length > 0) return { capture: d.capture, i: 0 };
  }
  return null;
}

export function resolveAt(
  h: SpotHistory,
  at: SpotAt | null,
  capture: string | undefined,
): SpotAt | null {
  return matchAt(h, at) ? at : startAt(h, capture);
}

export function stepDate(h: SpotHistory, at: SpotAt | null, dir: 1 | -1): SpotAt | null {
  const from = at
    ? h.dates.findIndex((d) => d.capture === at.capture)
    : dir > 0
      ? -1
      : h.dates.length;
  for (let k = from + dir; k >= 0 && k < h.dates.length; k += dir) {
    const d = h.dates[k];
    if (d && d.matches.length > 0) return { capture: d.capture, i: 0 };
  }
  return at;
}

export function cycleMatch(h: SpotHistory, at: SpotAt | null, dir: 1 | -1): SpotAt | null {
  if (!at) return null;
  const n = dateOf(h, at.capture)?.matches.length ?? 0;
  return n === 0 ? at : { capture: at.capture, i: (((at.i + dir) % n) + n) % n };
}

export function defaultOther(h: SpotHistory, capture: string): SpotAt | null {
  const here = { capture, i: 0 };
  const before = stepDate(h, here, -1);
  if (before && before.capture !== capture) return before;
  const after = stepDate(h, here, 1);
  return after && after.capture !== capture ? after : null;
}
```

- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(stage): spot viewer state and stepping across dates`.

### Task 8: The date strip

**Files:**

- Create: `apps/desktop/src/renderer/workspace/spot/SpotStrip.tsx`
- Create: `apps/desktop/src/renderer/workspace/spot/SpotThumb.tsx`
- Create: `apps/desktop/src/renderer/workspace/spot/spot.css`
- Test: `apps/desktop/src/renderer/workspace/spot/SpotStrip.test.tsx`

**Interfaces:**

- Consumes: Task 7 (`stepDate`, `cycleMatch`, `SpotAt`), Task 6 (words, `matchShortcut('spot', e)`), Task 1 (`slotRadiusM`, types); `DateTag` from `@aio/workspace`; `MediaThumb` from `../../thumbs/Thumb`.
- Produces (used by Tasks 10, 11):

```ts
// SpotStrip.tsx
export function stripKey(
  e: {
    key: string;
    code: string;
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
  },
  h: SpotHistory,
  at: SpotAt | null,
): SpotAt | null; // null: not a strip key
export function emptyText(spot: Spot, origin: SpotItem['kind']): string;
export function SpotStrip(p: {
  history: SpotHistory;
  at: SpotAt | null;
  tags: Readonly<Record<string, DateTag>>;
  origin: SpotItem['kind'];
  thumb: (m: SpotMatch) => ReactNode;
  onPick: (at: SpotAt) => void;
  compact?: boolean;
}): JSX.Element;
// SpotThumb.tsx
export function itemAsset(layers: readonly Layer[], item: SpotItem): AssetRef | undefined;
export function SpotThumb(p: {
  projectId: string;
  layers: readonly Layer[];
  match: SpotMatch;
}): JSX.Element;
```

- [ ] **Step 1: Write the failing tests** (`SpotStrip.test.tsx`, jsdom, the render helper of `PanoPane.test.tsx`)

```tsx
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpotStrip } from './SpotStrip';
import type { SpotHistory, SpotMatch } from './spotTypes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const m = (capture: string, photo: string, kind: SpotMatch['kind'] = 'photo'): SpotMatch => ({
  capture,
  kind,
  item: { kind: 'photo', layer: `photos-${capture}`, photo },
  distanceM: 1,
  angleDeg: 0,
  score: 1,
  aerial: kind === 'drone',
});
const history: SpotHistory = {
  spot: { camera: [0, 1.6, 0], bearingDeg: 0, target: [0, 0, -15], aerial: false },
  dates: [
    { capture: 'd1', matches: [m('d1', 'a')], skipped: 0 },
    { capture: 'd2', matches: [], skipped: 2 },
    { capture: 'd3', matches: [m('d3', 'b'), m('d3', 'c', 'drone')], skipped: 0 },
  ],
};
const tags = {
  d1: { id: 'd1', date: '2025-01-01', order: 0, colour: 'red', short: '1 Jan', long: '1 Jan 2025' },
  d2: {
    id: 'd2',
    date: '2025-02-01',
    order: 1,
    colour: 'green',
    short: '1 Feb',
    long: '1 Feb 2025',
  },
  d3: {
    id: 'd3',
    date: '2025-03-01',
    order: 2,
    colour: 'blue',
    short: '1 Mar',
    long: '1 Mar 2025',
  },
} as unknown as Parameters<typeof SpotStrip>[0]['tags'];

let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});
const render = (p: Partial<Parameters<typeof SpotStrip>[0]> = {}) => {
  const onPick = vi.fn();
  act(() => {
    root = createRoot(host);
    root.render(
      <SpotStrip
        history={history}
        at={{ capture: 'd1', i: 0 }}
        tags={tags}
        origin="photo"
        thumb={() => <i />}
        onPick={onPick}
        {...p}
      />,
    );
  });
  return onPick;
};
const slot = (c: string) => host.querySelector(`[data-testid="spot-slot-${c}"]`);
const key = (k: string) =>
  act(() => {
    host
      .querySelector('[data-testid="spot-strip"]')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  });

describe('SpotStrip', () => {
  it('shows one slot per date, oldest first, with the date colour and kind', () => {
    render();
    expect(
      [...host.querySelectorAll('[data-testid^="spot-slot-"]')].map((e) =>
        e.getAttribute('data-capture'),
      ),
    ).toEqual(['d1', 'd2', 'd3']);
    expect(slot('d1')?.getAttribute('aria-selected')).toBe('true');
    expect(slot('d1')?.textContent).toContain('Photo');
  });
  it('shows an empty, hatched slot with the reason and the skipped count', () => {
    render();
    expect(slot('d2')?.getAttribute('data-empty')).toBe('true');
    expect(slot('d2')?.textContent).toContain('Nothing within 15 m');
    expect(slot('d2')?.getAttribute('title')).toContain('2 items without a position were left out');
  });
  it('says "not seen" for an aerial spot and names 25 m for a 360', () => {
    render({ history: { ...history, spot: { ...history.spot, aerial: true } } });
    expect(slot('d2')?.textContent).toContain('Not seen');
    act(() => root?.unmount());
    render({ origin: 'pano' });
    expect(slot('d2')?.textContent).toContain('Nothing within 25 m');
  });
  it('shows "+n" for more images of a date', () => {
    render();
    expect(slot('d3')?.textContent).toContain('+1');
    expect(slot('d1')?.textContent).not.toContain('+');
  });
  it('steps with the arrow keys, skipping empty dates', () => {
    const onPick = render();
    key('ArrowRight');
    expect(onPick).toHaveBeenLastCalledWith({ capture: 'd3', i: 0 });
  });
  it('cycles images of a date with up and down', () => {
    const onPick = render({ at: { capture: 'd3', i: 0 } });
    key('ArrowDown');
    expect(onPick).toHaveBeenLastCalledWith({ capture: 'd3', i: 1 });
  });
  it('jumps to a clicked slot; an empty slot does nothing', () => {
    const onPick = render();
    act(() => {
      (slot('d3') as HTMLElement | null)?.click();
    });
    expect(onPick).toHaveBeenLastCalledWith({ capture: 'd3', i: 0 });
    onPick.mockClear();
    act(() => {
      (slot('d2') as HTMLElement | null)?.click();
    });
    expect(onPick).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement `SpotStrip.tsx`**

```tsx
import { matchShortcut, t, useT } from '@aio/ui';
import type { DateTag } from '@aio/workspace';
import type { KeyboardEvent, ReactNode } from 'react';
import { slotRadiusM } from './spotRules';
import type { Spot, SpotHistory, SpotItem, SpotMatch } from './spotTypes';
import { cycleMatch, stepDate, type SpotAt } from './spotViewerStore';
import './spot.css';

/** The arrow keys of the strip (and of the viewer): a new place, or null for other keys. */
export function stripKey(
  e: Parameters<typeof matchShortcut>[1],
  h: SpotHistory,
  at: SpotAt | null,
): SpotAt | null {
  switch (matchShortcut('spot', e)) {
    case 'spot.prevDate':
      return stepDate(h, at, -1);
    case 'spot.nextDate':
      return stepDate(h, at, 1);
    case 'spot.prevMatch':
      return cycleMatch(h, at, -1);
    case 'spot.nextMatch':
      return cycleMatch(h, at, 1);
    default:
      return null;
  }
}

export function emptyText(spot: Spot, origin: SpotItem['kind']): string {
  return spot.aerial ? t('spot.slot.notSeen') : t('spot.slot.none', { m: slotRadiusM(origin) });
}

/**
 * One slot per survey date, oldest on the left: its colour, the best match's thumbnail and kind,
 * "+n" for more; an empty date is a hatched slot that says why. A listbox: arrows step dates
 * (skipping gaps) and images of a date; a click jumps. It shows; the caller decides what a pick does.
 */
export function SpotStrip(p: {
  history: SpotHistory;
  at: SpotAt | null;
  tags: Readonly<Record<string, DateTag>>;
  origin: SpotItem['kind'];
  thumb: (m: SpotMatch) => ReactNode;
  onPick: (at: SpotAt) => void;
  compact?: boolean;
}) {
  const tr = useT();
  const empty = emptyText(p.history.spot, p.origin);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const next = stripKey(e, p.history, p.at);
    if (!next) return;
    e.preventDefault();
    e.stopPropagation();
    p.onPick(next);
  };
  return (
    <div
      className={`spot-strip${p.compact ? ' compact' : ''}`}
      role="listbox"
      aria-orientation="horizontal"
      aria-label={tr('spot.strip')}
      tabIndex={0}
      data-testid="spot-strip"
      onKeyDown={onKey}
    >
      {p.history.dates.map((d) => {
        const tag = p.tags[d.capture];
        const best = d.matches[0];
        const on = p.at?.capture === d.capture;
        const shown = on && p.at ? (d.matches[p.at.i] ?? best) : best;
        const skipped = d.skipped > 0 ? tr('spot.slot.skipped', { count: d.skipped }) : '';
        const date = tag?.long ?? d.capture;
        return (
          <div
            key={d.capture}
            role="option"
            aria-selected={on}
            aria-disabled={!best}
            aria-label={
              shown
                ? tr('spot.slot.label', { date, kind: tr(`spot.kind.${shown.kind}`) })
                : tr('spot.slot.emptyLabel', { date, reason: empty })
            }
            title={[date, skipped].filter(Boolean).join('\n')}
            className={`spot-slot${on ? ' on' : ''}${best ? '' : ' empty'}`}
            style={{ ['--date' as string]: tag?.colour }}
            data-testid={`spot-slot-${d.capture}`}
            data-capture={d.capture}
            data-empty={best ? 'false' : 'true'}
            data-count={d.matches.length}
            onClick={() => {
              if (best) p.onPick({ capture: d.capture, i: on && p.at ? p.at.i : 0 });
            }}
          >
            <span className="spot-slot-date">{tag?.short ?? d.capture}</span>
            {shown ? (
              <>
                <span className="spot-slot-thumb">{p.thumb(shown)}</span>
                <span className="spot-slot-kind">{tr(`spot.kind.${shown.kind}`)}</span>
                {d.matches.length > 1 && (
                  <span className="spot-slot-more">
                    {tr('spot.slot.more', { count: d.matches.length - 1 })}
                  </span>
                )}
              </>
            ) : (
              <span className="spot-slot-none">{empty}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
```

(`tr(\`spot.kind.${kind}\`)`must type-check as a`MessageKey`; if the template literal does not, use a `const KIND_KEY: Record<SpotKind, MessageKey>` map.)

- [ ] **Step 4: Implement `SpotThumb.tsx`**

```tsx
import type { AssetRef, Layer } from '@aio/schema';
import type { IconName } from '@aio/ui';
import { MediaThumb } from '../../thumbs/Thumb';
import type { SpotItem, SpotKind, SpotMatch } from './spotTypes';

const ICON: Record<SpotKind, IconName> = {
  photo: 'photo',
  drone: 'drone',
  pano: 'pano',
  walk: 'pano',
  video: 'video',
};

/** The picture a slot shows: the photo or panorama itself, a clip's or walk's poster. */
export function itemAsset(layers: readonly Layer[], item: SpotItem): AssetRef | undefined {
  const l = layers.find((x) => x.id === item.layer);
  if (item.kind === 'photo' && l?.kind === 'photos')
    return l.items.find((p) => p.id === item.photo)?.src;
  if (item.kind === 'pano' && l?.kind === 'panoramas')
    return l.items.find((p) => p.id === item.pano)?.src;
  if (
    (item.kind === 'video' && l?.kind === 'video') ||
    (item.kind === 'walk' && l?.kind === 'walk')
  )
    return l.poster;
  return undefined;
}

export function SpotThumb(p: { projectId: string; layers: readonly Layer[]; match: SpotMatch }) {
  return (
    <MediaThumb
      projectId={p.projectId}
      asset={itemAsset(p.layers, p.match.item)}
      icon={ICON[p.match.kind]}
    />
  );
}
```

(`MediaThumb` shows its icon when the asset is missing or fails: the spec's "plain placeholder". Check `IconName` is exported from `@aio/ui`; `MediaThumb` already takes one.)

- [ ] **Step 5: Write `spot.css`** with theme tokens only: `.spot-strip` a horizontal flex row with `overflow-x: auto`, gap 6px, padding 6px, `background: var(--bg-1)`; `.spot-slot` 104px wide (72px in `.compact`), a 3px top border in `var(--date)`, `border-radius: 6px`, `cursor: pointer`; `.spot-slot.on` an outline in `var(--acc)`; `.spot-slot.empty` `cursor: default` and `background: repeating-linear-gradient(135deg, var(--bg-2) 0 6px, var(--bg-1) 6px 12px)`; `.spot-slot-thumb` 16:10 with the thumb filling it; `.spot-slot-kind`, `.spot-slot-more` small caps in `var(--fg-2)`; `.spot-strip:focus-visible` the focus ring of `tokens.css`. Read `packages/ui/src/tokens.css` for the token names that exist before writing (`--bg-1`, `--acc` and the `--date-*` colours are used by T3 panes).
- [ ] **Step 6: Run, expect PASS.**
- [ ] **Step 7: Commit** `feat(stage): the spot history date strip`.

### Task 9: One match on screen, any kind

**Files:**

- Create: `apps/desktop/src/renderer/workspace/panoSurface.tsx` (moved from `PanoPane.tsx`)
- Modify: `apps/desktop/src/renderer/workspace/PanoPane.tsx` (imports `PanoSurface`, `useCoverage`)
- Create: `apps/desktop/src/renderer/workspace/spot/SpotMatchView.tsx`
- Test: `apps/desktop/src/renderer/workspace/spot/SpotMatchView.test.tsx`

**Interfaces:**

- Consumes: Task 1 types, Task 6 words; `FrameImage` from `@aio/video`; `createLookLink`, `LookLinkState` from `../lookLink`; `PANO_FOV`, `PanoLook` from `@aio/engine`.
- Produces (used by Tasks 10, 12):

```ts
// panoSurface.tsx (moved, plus one prop)
export function useCoverage(projectId: string | undefined): ReadonlyMap<string, PanoCoverage>;
export function PanoSurface(p: {
  url: string;
  headingDeg: number;
  cov: PanoCoverage | null;
  look: PanoLook;
  label: string;
  onLook: (look: PanoLook) => void;
  onStep?: (dir: 1 | -1) => void;
  /** Arrow keys turn the view (default true); off where the arrows step something else. */
  arrowKeys?: boolean;
}): JSX.Element;
// SpotMatchView.tsx
export function SpotMatchView(p: {
  projectId: string;
  layers: readonly Layer[];
  match: SpotMatch;
  look?: StoreApi<LookLinkState>;
  playable?: boolean;
}): JSX.Element;
```

- [ ] **Step 1: Move** `loadCoverage`, `useCoverage`, `PanoSurface`, `SurfaceStatus` and their constants (`EMPTY_COVERAGE`, `TURN_DEG`) from `PanoPane.tsx` into `panoSurface.tsx`, exported, unchanged except the `arrowKeys` prop: in `onKey`, the four arrow branches run only when `p.arrowKeys !== false`. `PanoPane.tsx` imports them. Run `pnpm --filter @aio/desktop exec vitest run src/renderer/workspace/PanoPane.test.tsx`: PASS with no test change (its `vi.mock('./panoView')` still applies: `panoSurface.tsx` imports `./panoView`).
- [ ] **Step 2: Write the failing tests** (`SpotMatchView.test.tsx`, jsdom; mock `../panoView` with the fake view of `PanoPane.test.tsx`; mock `@aio/video`'s `FrameImage` as `({ src, kind, t }) => <i data-src={src} data-kind={kind} data-t={t} />` with `vi.mock('@aio/video', async (orig) => ({ ...(await orig()), FrameImage: ... }))`; a manifest with a `photos` layer `photos-d1` (`a`), a `panoramas` layer `pano-d1` (`p`, heading 30) and a `video` layer `clip-d1` opened in `workspace`):
  - a photo match renders `FrameImage` with kind `photo` and the photo's asset url, `data-kind="photo"` on the root (`data-testid="spot-view"`);
  - a drone match renders the same way with `data-kind="drone"`;
  - a video match, `playable` false: `FrameImage` kind `video` at `t`; `playable` true: a `<video controls>` whose `currentTime` is set to `t` on `loadedmetadata` and which is paused;
  - a pano match with `lookDeg` 200 creates one pano view whose first look has `yawDeg` 200 and whose image heading is 30;
  - two pano matches sharing one `createLookLink` store: a look set on the store reaches both fake views;
  - an arrow key on the pano view does not turn it (`arrowKeys` off) and is not stopped (a parent `keydown` listener sees it);
  - an unknown item (layer gone) shows "This image could not be loaded".
- [ ] **Step 3: Run, expect FAIL.**
- [ ] **Step 4: Implement `SpotMatchView.tsx`**

```tsx
import { PANO_FOV, type PanoLook } from '@aio/engine';
import type { Layer } from '@aio/schema';
import { useT } from '@aio/ui';
import { FrameImage } from '@aio/video';
import { assetUrl } from '@aio/workspace';
import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';
import { createLookLink, type LookLinkState } from '../lookLink';
import { PanoSurface, useCoverage } from '../panoSurface';
import type { SpotMatch } from './spotTypes';

/** A clip paused at `t` with its controls: it can be played from the matched moment. */
function SpotVideo(p: { src: string; t: number; label: string }) {
  const v = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = v.current;
    if (!el) return;
    const seek = () => {
      el.currentTime = p.t;
      el.pause();
    };
    if (el.readyState >= 1) seek();
    else el.addEventListener('loadedmetadata', seek, { once: true });
    return () => {
      el.removeEventListener('loadedmetadata', seek);
    };
  }, [p.src, p.t]);
  return (
    <video
      ref={v}
      className="spot-video"
      src={p.src}
      controls
      preload="auto"
      aria-label={p.label}
    />
  );
}

function SpotPano(p: {
  url: string;
  headingDeg: number;
  projectId: string;
  id: string;
  lookDeg: number;
  look?: StoreApi<LookLinkState>;
  label: string;
}) {
  const coverage = useCoverage(p.projectId);
  const [own] = useState(() =>
    createLookLink({ yawDeg: p.lookDeg, pitchDeg: 0, fovDeg: PANO_FOV.start }),
  );
  const store = p.look ?? own;
  const look: PanoLook = useStore(store, (s) => s.look);
  return (
    <PanoSurface
      url={p.url}
      headingDeg={p.headingDeg}
      cov={coverage.get(p.id) ?? null}
      look={look}
      label={p.label}
      arrowKeys={false}
      onLook={(l) => {
        store.getState().set(l);
      }}
    />
  );
}

/**
 * One image of a spot, whatever its kind: a photo or a video frame fitted to the box, a clip
 * paused at its moment (playable in the viewer), a 360 turned towards the spot. Look only.
 */
export function SpotMatchView(p: {
  projectId: string;
  layers: readonly Layer[];
  match: SpotMatch;
  look?: StoreApi<LookLinkState>;
  playable?: boolean;
}) {
  const t = useT();
  const { match } = p;
  const layer = p.layers.find((l) => l.id === match.item.layer);
  const missing = <p className="pane-empty">{t('spot.missing')}</p>;
  let body = missing;
  const item = match.item;
  if (item.kind === 'photo' && layer?.kind === 'photos') {
    const photo = layer.items.find((x) => x.id === item.photo);
    if (photo)
      body = (
        <FrameImage
          kind="photo"
          src={assetUrl(p.projectId, photo.src)}
          missing={t('spot.missing')}
          alt={photo.id}
        />
      );
  } else if (item.kind === 'video' && layer?.kind === 'video') {
    const src = assetUrl(p.projectId, layer.src);
    body = p.playable ? (
      <SpotVideo src={src} t={item.t} label={layer.name} />
    ) : (
      <FrameImage kind="video" src={src} t={item.t} missing={t('spot.missing')} />
    );
  } else if (item.kind === 'pano' && layer?.kind === 'panoramas') {
    const pano = layer.items.find((x) => x.id === item.pano);
    if (pano)
      body = (
        <SpotPano
          key={`${layer.id}/${pano.id}`}
          url={assetUrl(p.projectId, pano.src)}
          headingDeg={pano.headingDeg}
          projectId={p.projectId}
          id={pano.id}
          lookDeg={match.lookDeg ?? pano.headingDeg}
          {...(p.look ? { look: p.look } : {})}
          label={pano.id}
        />
      );
  }
  // walk frames: Task 12
  return (
    <div
      className="spot-view"
      data-testid="spot-view"
      data-kind={match.kind}
      data-capture={match.capture}
    >
      {body}
    </div>
  );
}
```

(`assetUrl` throws on a bad path: wrap the three calls in a small `safeUrl` that returns null, and show `missing` then.)

- [ ] **Step 5: Run** the new test and `src/renderer/workspace/PanoPane.test.tsx`, PASS; `tsc --noEmit`.
- [ ] **Step 6: Commit** `feat(stage): show one spot match of any kind; share the panorama surface`.

### Task 10: The viewer and Compare

**Files:**

- Create: `apps/desktop/src/renderer/workspace/spot/SpotViewer.tsx`
- Create: `apps/desktop/src/renderer/workspace/spot/SpotCompare.tsx`
- Create: `apps/desktop/src/renderer/workspace/spot/spotZoom.ts` (pure: linked zoom and pan)
- Create: `apps/desktop/src/renderer/workspace/spot/SpotZoom.tsx` (the zoomable box)
- Modify: `apps/desktop/src/renderer/App.tsx` (mount `<SpotViewer />` next to `<Lightbox />`)
- Test: `apps/desktop/src/renderer/workspace/spot/spotZoom.test.ts`
- Test: `apps/desktop/src/renderer/workspace/spot/SpotViewer.test.tsx`

**Interfaces:**

- Consumes: Task 3 (`historyFor`), Task 5 (`useSpotEntries`), Task 7 (store and helpers), Task 8 (`SpotStrip`, `stripKey`, `SpotThumb`), Task 9 (`SpotMatchView`), Task 6 (words, `matchShortcut`); `FramesCompare` from `@aio/video`; `useFocusTrap`, `Icon`, `useT`, `matchShortcut` from `@aio/ui`; `dateTags`, `useWorkspace` from `@aio/workspace`; `useCaptureIndex` from `../compare`; `createLookLink` from `../lookLink`.
- Produces (`spotZoom.ts`, `SpotZoom.tsx`):

```ts
export interface ZoomView {
  s: number;
  x: number;
  y: number;
}
export const ZOOM: { readonly min: 1; readonly max: 8; readonly step: 1.25 };
export const FIT: ZoomView;
export function clampView(v: ZoomView): ZoomView;
export function zoomAt(v: ZoomView, factor: number, px: number, py: number): ZoomView;
export function panBy(v: ZoomView, dx: number, dy: number): ZoomView;
export function viewCss(v: ZoomView): string;
export interface ZoomLinkState {
  view: ZoomView;
  set(v: ZoomView): void;
}
export function createZoomLink(): StoreApi<ZoomLinkState>;
export function SpotZoom(p: {
  link: StoreApi<ZoomLinkState>;
  side: 'left' | 'right';
  children: ReactNode;
}): JSX.Element;
```

- Produces (viewer): `SpotViewer()` (no props; reads `spotViewer`), `SpotCompare(p: { history: SpotHistory; state: SpotCompareState; projectId: string; layers: readonly Layer[]; tags: Readonly<Record<string, DateTag>>; onChange(next: SpotCompareState): void })`. Test ids: `spot-viewer` (dialog), `spot-head` (with `data-capture`, `data-kind`, `data-item`, `data-distance`), `spot-compare` (button), `spot-compare-view` (`data-mode`), `spot-mode-side`, `spot-mode-swipe`, `spot-compare-date-left`, `spot-compare-date-right` (selects), `spot-close`, `spot-no-position`.

- [ ] **Step 1: Write the failing tests** (`SpotViewer.test.tsx`, jsdom). Mock `./useSpotEntries` to return fixed entries built with the fixture (`photos-d1` photo `a` at `[0, 1.6, 0]` facing north, `photos-d2` photos `b` at `[1, 1.6, 0]` and `c` at `[3, 1.6, 0]`, `photos-d2` `nogps` without a position); mock `./SpotMatchView` as `({ match }) => <i data-testid="spot-view" data-capture={match.capture} />`; mock `@aio/video`'s `FramesCompare` as a component that renders `a`, `b` and a `[role="slider"]` with `aria-valuenow`. Open a manifest with captures `d1`, `d2`, `d3` in `workspace` and `timeline` (as `PanoPane.test.tsx`), select a layer, hide one, set the stage mode, then snapshot `{ selection, hidden, focus: timeline.getState().focus, stage: shell.getState().stageMode }`.
  - `openSpotHistory({ item: { kind: 'photo', layer: 'photos-d1', photo: 'a' } })` shows the dialog, `spot-head` `data-capture="d1"` `data-item="a"`, three slots, `d3` empty;
  - ArrowRight shows `d2` photo `b` with `data-distance` 1; ArrowRight again stays on `d2`; ArrowDown shows `c`; ArrowLeft back to `d1`;
  - clicking slot `d2` shows `b`;
  - `C` opens compare (`spot-compare-view` `data-mode="side"`, left `d1`, right the default other date `d2`); clicking `spot-mode-swipe` sets `data-mode="swipe"`; the right date select lists only dates with a match; Escape leaves compare, a second Escape closes the dialog;
  - after all of the above **the snapshot is unchanged** (selection, hidden layers, focused date, stage mode) and `workspace.getState().select` was never called (spy);
  - a photo without a position shows `spot-no-position` with "This photo has no position, so other dates can't be matched." and no strip;
  - a project with one survey date shows the current image and no strip;
  - closing the project (`workspace.getState().closeProject()`) closes the dialog;
  - a key with the swipe slider focused does not step dates (the dialog skips `defaultPrevented` events);
  - Tab stays inside the dialog (first and last focusable wrap);
  - **linked zoom for photos** (founder, 13 Oct): in compare (side by side), a wheel up over `spot-zoom-left` (`dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX, clientY, bubbles: true, cancelable: true }))`) sets `data-scale="1.25"` on both `spot-zoom-left` and `spot-zoom-right`; a pointer drag on the right (down, move by 20 % of its width, up; stub `getBoundingClientRect` to a 400 x 300 box in jsdom) changes `data-x` on both to the same value; a double click on either sets both back to `1.00`; the same after clicking `spot-mode-swipe` (both layers keep one transform: their `.spot-zoom-pic` `style.transform` strings are equal); changing the right date keeps the zoom; leaving compare and opening it again starts at `1.00`; ArrowRight with `spot-zoom-left` focused still steps the left date (the box leaves the arrows to the viewer);
  - a 360 pair is not wrapped in `spot-zoom-*` (it keeps its linked look).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Write the failing zoom tests** (`spotZoom.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { clampView, createZoomLink, FIT, panBy, viewCss, zoomAt } from './spotZoom';

describe('linked zoom and pan', () => {
  it('zooms about the box centre', () => {
    expect(zoomAt(FIT, 2, 0, 0)).toEqual({ s: 2, x: 0, y: 0 });
  });
  it('keeps the point under the pointer still', () => {
    const v = zoomAt(FIT, 2, 0.25, 0);
    expect(v).toEqual({ s: 2, x: -0.25, y: 0 });
    // the picture point that was at 0.25 (content 0.25) is still at 0.25
    expect(v.x + v.s * 0.25).toBeCloseTo(0.25);
  });
  it('stops at fit and at eight times', () => {
    expect(zoomAt({ s: 2, x: -0.25, y: 0 }, 0.25, 0, 0)).toEqual(FIT);
    expect(zoomAt(FIT, 100, 0, 0).s).toBe(8);
  });
  it('pans only while zoomed, never past the picture edge', () => {
    expect(panBy(FIT, 0.3, 0)).toEqual(FIT);
    expect(panBy({ s: 2, x: 0, y: 0 }, 1, -1)).toEqual({ s: 2, x: 0.5, y: -0.5 });
    expect(clampView({ s: 3, x: 2, y: -0.2 })).toEqual({ s: 3, x: 1, y: -0.2 });
  });
  it('writes one CSS transform for both sides', () => {
    expect(viewCss({ s: 2, x: -0.25, y: 0 })).toBe('translate(-25%, 0%) scale(2)');
  });
  it('shares one view between two subscribers', () => {
    const link = createZoomLink();
    const seen: number[] = [];
    link.subscribe((st) => seen.push(st.view.s));
    link.getState().set(zoomAt(FIT, 1.25, 0, 0));
    expect(link.getState().view.s).toBe(1.25);
    expect(seen).toEqual([1.25]);
  });
});
```

- [ ] **Step 4: Run, expect FAIL.**
- [ ] **Step 5: Implement `spotZoom.ts`**

```ts
import { createStore, type StoreApi } from 'zustand/vanilla';

/**
 * Linked zoom and pan of two photos or video frames in Compare (founder, 13 Oct 2026): one view
 * for both sides. `s` is the scale (1: the picture fits its box), `x` and `y` shift the picture
 * centre in box widths and heights; the picture always covers its box.
 */
export interface ZoomView {
  s: number;
  x: number;
  y: number;
}
export const ZOOM = { min: 1, max: 8, step: 1.25 } as const;
export const FIT: ZoomView = { s: 1, x: 0, y: 0 };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function clampView(v: ZoomView): ZoomView {
  const s = clamp(v.s, ZOOM.min, ZOOM.max);
  const m = (s - 1) / 2;
  // `|| 0` turns -0 into 0, so a view back at fit equals FIT
  return { s, x: clamp(v.x, -m, m) || 0, y: clamp(v.y, -m, m) || 0 };
}

/** Zoom by `factor` about the box point (`px`, `py`), in box fractions from its centre. */
export function zoomAt(v: ZoomView, factor: number, px: number, py: number): ZoomView {
  const s = clamp(v.s * factor, ZOOM.min, ZOOM.max);
  const k = s / v.s;
  return clampView({ s, x: px - (px - v.x) * k, y: py - (py - v.y) * k });
}

/** Pan by (`dx`, `dy`) box fractions. */
export function panBy(v: ZoomView, dx: number, dy: number): ZoomView {
  return clampView({ s: v.s, x: v.x + dx, y: v.y + dy });
}

/** The transform of the picture layer (transform origin at its centre). */
export function viewCss(v: ZoomView): string {
  return `translate(${String(v.x * 100)}%, ${String(v.y * 100)}%) scale(${String(v.s)})`;
}

export interface ZoomLinkState {
  view: ZoomView;
  set(v: ZoomView): void;
}
export function createZoomLink(): StoreApi<ZoomLinkState> {
  return createStore<ZoomLinkState>()((set) => ({
    view: FIT,
    set: (v) => {
      set({ view: clampView(v) });
    },
  }));
}
```

- [ ] **Step 6: Implement `SpotZoom.tsx`**

```tsx
import { useEffect, useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';
import { FIT, panBy, viewCss, ZOOM, zoomAt, type ZoomLinkState, type ZoomView } from './spotZoom';

/**
 * A box whose picture zooms and pans with the linked view: wheel about the pointer, drag to pan,
 * double click, `0` or `F` to fit, `+` and `-` about the centre. The arrow keys, `C` and Esc are
 * left to the viewer. Both sides of Compare use one link, so they move together.
 */
export function SpotZoom(p: {
  link: StoreApi<ZoomLinkState>;
  side: 'left' | 'right';
  children: ReactNode;
}) {
  const view = useStore(p.link, (st) => st.view);
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const set = (v: ZoomView) => {
    p.link.getState().set(v);
  };

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    // the wheel zooms and must not scroll the dialog behind it
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const px = r.width > 0 ? (e.clientX - r.left) / r.width - 0.5 : 0;
      const py = r.height > 0 ? (e.clientY - r.top) / r.height - 0.5 : 0;
      const factor = e.deltaY < 0 ? ZOOM.step : 1 / ZOOM.step;
      p.link.getState().set(zoomAt(p.link.getState().view, factor, px, py));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
    };
  }, [p.link]);

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if (typeof e.currentTarget.setPointerCapture === 'function')
      e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY };
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const from = drag.current;
    const r = box.current?.getBoundingClientRect();
    if (!from || !r || r.width === 0 || r.height === 0) return;
    set(
      panBy(
        p.link.getState().view,
        (e.clientX - from.x) / r.width,
        (e.clientY - from.y) / r.height,
      ),
    );
    drag.current = { x: e.clientX, y: e.clientY };
  };
  const onUp = () => {
    drag.current = null;
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const v = p.link.getState().view;
    if (e.key === '+' || e.key === '=') set(zoomAt(v, ZOOM.step, 0, 0));
    else if (e.key === '-') set(zoomAt(v, 1 / ZOOM.step, 0, 0));
    else if (e.key === '0' || e.key === 'f' || e.key === 'F') set(FIT);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div
      ref={box}
      className={`spot-zoom${view.s > 1 ? ' zoomed' : ''}`}
      tabIndex={0}
      data-testid={`spot-zoom-${p.side}`}
      data-scale={view.s.toFixed(2)}
      data-x={view.x.toFixed(3)}
      data-y={view.y.toFixed(3)}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onDoubleClick={() => {
        set(FIT);
      }}
      onKeyDown={onKey}
    >
      <div className="spot-zoom-pic" style={{ transform: viewCss(view) }}>
        {p.children}
      </div>
    </div>
  );
}
```

Add to `spot.css`: `.spot-zoom { position: absolute; inset: 0; overflow: hidden; touch-action: none; }`, `.spot-zoom.zoomed { cursor: grab; }`, `.spot-zoom-pic { position: absolute; inset: 0; transform-origin: 50% 50%; will-change: transform; }`. In Swipe, `FramesCompare` clips the top layer; each layer holds its own `SpotZoom` on the same link, so a drag on either visible part moves both and the swipe handle (its own element) still works.

- [ ] **Step 7: Implement `SpotCompare.tsx`** (photos and video frames inside `SpotZoom` on one shared `createZoomLink`; 360s and walk frames keep the shared look)

```tsx
import { PANO_FOV } from '@aio/engine';
import type { Layer } from '@aio/schema';
import { useT } from '@aio/ui';
import { FramesCompare } from '@aio/video';
import type { DateTag } from '@aio/workspace';
import { useState } from 'react';
import { createLookLink } from '../lookLink';
import { SpotMatchView } from './SpotMatchView';
import type { SpotHistory, SpotMatch } from './spotTypes';
import { matchAt, type SpotCompareState } from './spotViewerStore';
import { SpotZoom } from './SpotZoom';
import { createZoomLink } from './spotZoom';

/** Width over height of a match's picture (stacked modes keep it so the swipe lines up). */
function aspectOf(layers: readonly Layer[], m: SpotMatch | undefined): number {
  const l = m ? layers.find((x) => x.id === m.item.layer) : undefined;
  if (m?.item.kind === 'photo' && l?.kind === 'photos') {
    const id = m.item.photo;
    return l.items.find((p) => p.id === id)?.lens?.aspect ?? 1.5;
  }
  if (l?.kind === 'video') return l.lens.aspect;
  return 16 / 9;
}

/**
 * Two dates of one spot (spec "Compare (B)", inside the viewer: see the plan's deviation 1): the
 * shown match on the left, another date's best on the right, side by side or swiped with
 * `FramesCompare`. 360s and walk frames share one look; photos and video frames share one zoom
 * and pan (founder, 13 Oct 2026), so in Swipe both layers stay over the same ground.
 */
export function SpotCompare(p: {
  history: SpotHistory;
  state: SpotCompareState;
  projectId: string;
  layers: readonly Layer[];
  tags: Readonly<Record<string, DateTag>>;
  onChange: (next: SpotCompareState) => void;
}) {
  const t = useT();
  const { history: h, state } = p;
  const left = matchAt(h, state.left);
  const right = matchAt(h, state.right);
  const [look] = useState(() =>
    createLookLink({ yawDeg: left?.lookDeg ?? 0, pitchDeg: 0, fovDeg: PANO_FOV.start }),
  );
  const dated = h.dates.filter((d) => d.matches.length > 0);
  const [zoom] = useState(createZoomLink);
  const view = (m: SpotMatch, side: 'left' | 'right') => {
    const shown = (
      <SpotMatchView
        projectId={p.projectId}
        layers={p.layers}
        match={m}
        look={look}
        playable={false}
      />
    );
    return m.kind === 'pano' || m.kind === 'walk' ? (
      shown
    ) : (
      <SpotZoom link={zoom} side={side}>
        {shown}
      </SpotZoom>
    );
  };
  const chip = (side: 'left' | 'right') => (
    <select
      className="spot-chip"
      aria-label={t(side === 'left' ? 'spot.compare.left' : 'spot.compare.right')}
      data-testid={`spot-compare-date-${side}`}
      value={(side === 'left' ? state.left : state.right)?.capture ?? ''}
      onChange={(e) => {
        const at = { capture: e.target.value, i: 0 };
        p.onChange(side === 'left' ? { ...state, left: at } : { ...state, right: at });
      }}
    >
      {dated.map((d) => (
        <option key={d.capture} value={d.capture}>
          {p.tags[d.capture]?.long ?? d.capture}
        </option>
      ))}
    </select>
  );
  return (
    <div className="spot-compare" data-testid="spot-compare-view" data-mode={state.mode}>
      <div className="spot-compare-bar">
        {chip('left')}
        <div role="group" aria-label={t('spot.compare.modes')} className="spot-modes">
          {(['side', 'swipe'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className="btn sm ghost"
              aria-pressed={state.mode === mode}
              data-testid={`spot-mode-${mode}`}
              onClick={() => {
                p.onChange({ ...state, mode });
              }}
            >
              {t(mode === 'side' ? 'spot.compare.side' : 'spot.compare.swipe')}
            </button>
          ))}
        </div>
        {chip('right')}
      </div>
      {left && (
        <FramesCompare
          className="spot-compare-frames"
          a={view(left, 'left')}
          b={right ? view(right, 'right') : null}
          mode={state.mode}
          amount={state.amount}
          onAmount={(amount) => {
            p.onChange({ ...state, amount });
          }}
          aspect={aspectOf(p.layers, left)}
          labels={{
            a: p.tags[left.capture]?.long ?? left.capture,
            b: right ? (p.tags[right.capture]?.long ?? right.capture) : '',
            handle: t('spot.compare.handle'),
            empty: t('spot.compare.empty'),
          }}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 8: Implement `SpotViewer.tsx`.** Structure (pattern of `Lightbox.tsx`):

```tsx
export function SpotViewer() {
  const t = useT();
  const state = useStore(spotViewer);
  const project = useWorkspace((s) => s.project);
  const index = useCaptureIndex();
  const open = state.open;
  const { entries, reading } = useSpotEntries(open !== null);
  const dialog = useRef<HTMLDivElement>(null);
  const opened = useRef<string | null>(null);
  // the viewer belongs to the project it was opened in
  useEffect(() => {
    if (!open) { opened.current = null; return; }
    if (opened.current === null) opened.current = project?.id ?? null;
    else if (opened.current !== (project?.id ?? null)) spotViewer.getState().close();
  }, [open, project]);
  useFocusTrap(dialog, open !== null && project !== null, { cycle: false, initial: () => dialog.current });
  const result = useMemo(() => (open && index ? historyFor(open, entries, index) : null), [open, entries, index]);
  const tags = useMemo(() => (index ? dateTags(index.captures) : {}), [index]);
  if (!open || !project || !index || !result) return null;
  const layers = project.manifest.layers;
  const originCapture = entries.find((e) => e.layer === open.item.layer)?.capture;
  ...
}
```

- `result.error === 'noPosition'`: the dialog with the header (item name) and one line `spot-no-position` (`spot.noPositionWalk` for a walk, else `spot.noPosition`), no strip, Esc and the close button work.
- Else `history = result.history`, `at = resolveAt(history, state.at, originCapture)`, `current = matchAt(history, at)`. Header (`spot-head`, `data-capture`, `data-kind`, `data-item` = the photo or panorama id or `layer@t`, `data-distance` = `current.distanceM.toFixed(2)`): the item's name (photo or panorama id; a clip's or walk's layer name with `spot.atTime`), the date tag (`.dtag` swatch in `tags[capture].colour` and `long`, or `spot.noDate`), the kind label, and `spot.self` for the clicked item (`sameItem(current.item, open.item)` on its own date) else `spot.away` / `spot.awayTurned` (metres with one decimal under 10, as `PanoPane`'s `metres`). Buttons: **Compare...** (`spot-compare`, disabled when `history.dates` has fewer than two dates with a match), close (`spot-close`, `Icon name="x"`). `reading` shows `spot.reading` in the header (`role="status"`).
- Body: `state.compare` ? `<SpotCompare ... onChange={(c) => spotViewer.getState().setCompare(c)} />` : `<SpotMatchView key={keyOf(current)} match={current} playable />`.
- Footer: when `index.captures.length >= 2`, `<SpotStrip history at tags origin={open.item.kind} thumb={(m) => <SpotThumb projectId={project.id} layers={layers} match={m} />} onPick={(a) => spotViewer.getState().goTo(a)} />`, and the key hint `spot.keys` in `.faint.small`.
- `onKeyDown` on the dialog: `e.stopPropagation()` (stage and app shortcuts stay out, as the lightbox); return when `e.defaultPrevented` or a modifier is held; `spot.close`: compare on ? `setCompare(null)` : `close()`; `spot.compare`: toggle compare, starting `{ mode: 'side', left: at, right: defaultOther(history, at.capture), amount: 0.5 }`; strip keys through `stripKey` (in compare they move the left side: `setCompare({ ...compare, left: next })`); Tab wraps inside the dialog exactly as `Lightbox.tsx` does.
- Root: `.spot-scrim` (pointer down on the scrim closes) around `.spot-dialog` with `role="dialog"`, `aria-modal="true"`, `aria-label={t('spot.dialog', { name })}`, `data-testid="spot-viewer"`, `tabIndex={-1}`. It calls nothing on `workspace`, `timeline` or `shell`.
- Add to `spot.css`: `.spot-scrim` and `.spot-dialog` mirroring the lightbox's `.lb-scrim` / `.lb` sizes (find them in `issueCard`'s CSS), the dialog a column of header, a `flex: 1` body, the strip; `.spot-compare` a column with its bar; `.spot-view` filling its box.
- [ ] **Step 9: Mount** in `App.tsx`: `import { SpotViewer } from './workspace/spot/SpotViewer';` and `<SpotViewer />` on the line after `<Lightbox />`.
- [ ] **Step 10: Run** `spotZoom.test.ts`, the new viewer test and `pnpm --filter @aio/desktop exec vitest run src/renderer/workspace`, PASS; `tsc --noEmit`.
- [ ] **Step 11: Commit** `feat(stage): spot history viewer with dates, compare and linked zoom`.

### Task 11: One click from every image

**Files:**

- Create: `apps/desktop/src/renderer/workspace/spot/SpotHistoryEntry.tsx`
- Test: `apps/desktop/src/renderer/workspace/spot/SpotHistoryEntry.test.tsx`
- Modify: `apps/desktop/src/renderer/screens/Media.tsx` (photo panel header button; inline strip under the viewer)
- Modify: `apps/desktop/src/renderer/workspace/SplitPanes.tsx` (`SetPhotoPane` bar, after `SameViewButton`)
- Modify: `apps/desktop/src/renderer/workspace/SelectionCard.tsx` (panel `acts`, for a photo or panorama)
- Modify: `apps/desktop/src/renderer/workspace/FramesPane.tsx` (its bar, for date A's photo or video frame)

**Interfaces:**

- Consumes: Task 7 (`openSpotHistory`, `startAt`), Task 3 (`historyFor`), Task 5 (`useSpotEntries`), Task 8 (`SpotStrip`, `SpotThumb`).
- Produces: `SpotHistoryButton(p: { open: SpotOpen; label?: boolean })` (test id `spot-history-open`; renders nothing with fewer than two survey dates) and `InlineSpotStrip(p: { open: SpotOpen })` (test id `spot-inline`).

- [ ] **Step 1: Write the failing tests** (`SpotHistoryEntry.test.tsx`, jsdom, entries mocked as in Task 10):
  - the button calls `openSpotHistory` with its `open` and nothing else (spy on `spotViewer.getState().show`; `workspace.getState().selection` unchanged);
  - with one survey date neither the button nor the inline strip renders;
  - the inline strip shows the dates, compact, current on the clicked photo's date; a click on a filled slot opens the viewer at that date (`show` called with `open` and `{ capture, i: 0 }`);
  - a photo without a position shows the one line "This photo has no position, so other dates can't be matched." in place of the inline strip.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement `SpotHistoryEntry.tsx`**

```tsx
import { Icon, useT } from '@aio/ui';
import { dateTags, useWorkspace } from '@aio/workspace';
import { useMemo } from 'react';
import { useCaptureIndex } from '../compare';
import { historyFor } from './spotSearch';
import { SpotStrip } from './SpotStrip';
import { SpotThumb } from './SpotThumb';
import type { SpotOpen } from './spotTypes';
import { openSpotHistory, startAt } from './spotViewerStore';
import { useSpotEntries } from './useSpotEntries';

/** "Other dates": opens the spot viewer on this image; nothing with fewer than two survey dates. */
export function SpotHistoryButton(p: { open: SpotOpen; label?: boolean }) {
  const t = useT();
  const dates = useCaptureIndex()?.captures.length ?? 0;
  if (dates < 2) return null;
  return (
    <button
      type="button"
      className={`btn sm ghost${p.label ? '' : ' icon'}`}
      title={t('spot.openTip')}
      aria-label={t('spot.open')}
      data-testid="spot-history-open"
      onClick={() => {
        openSpotHistory(p.open);
      }}
    >
      <Icon name="history" size={14} />
      {p.label && t('spot.open')}
    </button>
  );
}

/** The strip under the Media photo viewer: the dates at a glance, a slot opens the viewer there. */
export function InlineSpotStrip(p: { open: SpotOpen }) {
  const t = useT();
  const project = useWorkspace((s) => s.project);
  const index = useCaptureIndex();
  const { entries } = useSpotEntries(true);
  const result = useMemo(
    () => (index ? historyFor(p.open, entries, index) : null),
    [p.open, entries, index],
  );
  const tags = useMemo(() => (index ? dateTags(index.captures) : {}), [index]);
  if (!project || !index || index.captures.length < 2 || !result) return null;
  if ('error' in result)
    return (
      <p className="spot-nopos faint small" data-testid="spot-no-position">
        {t(p.open.item.kind === 'walk' ? 'spot.noPositionWalk' : 'spot.noPosition')}
      </p>
    );
  const capture = entries.find((e) => e.layer === p.open.item.layer)?.capture;
  return (
    <div data-testid="spot-inline">
      <SpotStrip
        compact
        history={result.history}
        at={startAt(result.history, capture)}
        tags={tags}
        origin={p.open.item.kind}
        thumb={(m) => (
          <SpotThumb projectId={project.id} layers={project.manifest.layers} match={m} />
        )}
        onPick={(at) => {
          openSpotHistory(p.open, at);
        }}
      />
    </div>
  );
}
```

The callers must pass a stable `open` (`useMemo` on the ids), or `historyFor` runs every render.

- [ ] **Step 4: Wire the hosts** (one small change each):
  - `Media.tsx`, photo panel: `const spotOpen = useMemo(() => (photo ? { item: { kind: 'photo' as const, layer: photo.layerId, photo: photo.photoId } } : null), [photo?.layerId, photo?.photoId]);` (above the early return). In `.acts` before the close button: `{spotOpen && <SpotHistoryButton open={spotOpen} />}`; after `<PhotoViewer ... />`: `{spotOpen && <InlineSpotStrip open={spotOpen} />}`.
  - `SplitPanes.tsx`, `SetPhotoPane`: after `<SameViewButton ... />`: `<SpotHistoryButton open={{ item: { kind: 'photo', layer: set.id, photo: photo.id } }} />` (the button does not search, so a fresh object is fine).
  - `SelectionCard.tsx`, in the `acts` row: a photo selection (`sel.kind === 'photo'`, its layer resolved as `describe` does) gives `{ item: { kind: 'photo', layer, photo: sel.id } }`; a panorama selection gives `{ item: { kind: 'pano', layer, pano: sel.id } }`. Render `<SpotHistoryButton open={...} />` before "Fly to".
  - `FramesPane.tsx`, in its bar next to the date A text: a photo source gives `{ item: { kind: 'photo', layer: aLayer.id, photo: source.photo } }`; a video source with `poseA` and `aTime` gives `{ item: { kind: 'video', layer: aLayer.id, t: aTime }, pose: { pos: poseA.pos, q: poseA.q } }`.
- [ ] **Step 5: Run** the new test and `pnpm --filter @aio/desktop exec vitest run src/renderer`, PASS (existing Media, SelectionCard, SplitPanes and FramesPane tests stay green); `tsc --noEmit`.
- [ ] **Step 6: Commit** `feat(stage): other dates of a spot from Media, the split, the selection and the Frames pane`.

### Task 12: Walk frames (late task: the costliest kind)

**Flag:** walk frames cost more than the spec assumed. A placed walk has no stored per-frame poses for the renderer: positions come from the live fit of its pins (`usePlacedWalkFits` in `walks/placeWalk.ts`, which reads the walk's raw path and orientation files and fits them, `fitWalk` in `@aio/geo`), the picture centre's heading from `viewHeading(fit, orientation, yawOffsetDeg, t)`, and showing a frame needs the 360 video seeked on a sphere (`createPanoVideoView`). Everything else in S1 works without this task; it can ship in the same branch or move to a follow-up if it runs long. No synthetic placed walk exists for e2e: unit tests only.

**Files:**

- Create: `apps/desktop/src/renderer/workspace/spot/spotWalk.ts`
- Test: `apps/desktop/src/renderer/workspace/spot/spotWalk.test.ts`
- Modify: `apps/desktop/src/renderer/workspace/spot/useSpotEntries.ts` (walk samples)
- Modify: `apps/desktop/src/renderer/workspace/spot/spotTypes.ts`, `spotMatchers.ts`, `spotSearch.ts` (one optional field, `SpotMatch.centreDeg`, set for walk matches)
- Modify: `apps/desktop/src/renderer/workspace/spot/SpotMatchView.tsx` (walk frame view), `SpotMatchView.test.tsx` (walk cases)
- Modify: `apps/desktop/src/renderer/walks/Walk360Pane.tsx` (the button in `walk-bar`)

**Interfaces:**

- Consumes: Tasks 1, 5, 9, 11; `WalkFit` from `@aio/geo`; `viewHeading`, `usePlacedWalkFits`, `placedWalks` from `../../walks/placeWalk`; `WALK_HEIGHT_M` from `@aio/schema`; `createPanoVideoView` from `@aio/video`.
- Produces:

```ts
export const bearingFromHeadingRad: (rad: number) => number; // three.js Ry angle to compass bearing
export function walkTrack(
  fit: WalkFit,
  durationS: number,
  heightM: number,
  headingAt: (t: number) => number | null,
  stepS?: number,
): TrackSample[];
```

- [ ] **Step 1: Write the failing tests** (`spotWalk.test.ts`): a fake `WalkFit` whose `at(t)` returns `{ xz: [t, 0], groundY: 2, headingRad: -Math.PI / 2, dashed: false }` for `t` in 0 to 10 and null after; `walkTrack(fit, 10, 1.7, () => -Math.PI / 2)` gives 11 samples at `t` 0 to 10, `pos` `[t, 3.7, 0]`, `groundY` 2, `bearingDeg` 90; a `headingAt` returning null falls back to the fit's `headingRad`; seconds where `at` is null are left out; `bearingFromHeadingRad(0)` is 0 (north), `(-Math.PI / 2)` is 90 (east), `(Math.PI / 2)` is 270.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement `spotWalk.ts`**

```ts
import type { WalkFit } from '@aio/geo';
import { wrapDeg } from './spotGeom';
import { SPOT_RULES } from './spotRules';
import type { TrackSample } from './spotTypes';

/** A three.js `Ry` heading (0 looks down -z, -pi/2 east) as a compass bearing. */
export const bearingFromHeadingRad = (rad: number): number => wrapDeg((-rad * 180) / Math.PI);

/** A placed walk every `stepS` seconds: camera over its fitted ground, picture centre's bearing. */
export function walkTrack(
  fit: WalkFit,
  durationS: number,
  heightM: number,
  headingAt: (t: number) => number | null,
  stepS: number = SPOT_RULES.walkStepS,
): TrackSample[] {
  const out: TrackSample[] = [];
  for (let i = 0; i * stepS <= durationS + 1e-9; i++) {
    const t = i * stepS;
    const s = fit.at(t);
    if (!s) continue;
    out.push({
      t,
      pos: [s.xz[0], s.groundY + heightM, s.xz[1]],
      groundY: s.groundY,
      bearingDeg: bearingFromHeadingRad(headingAt(t) ?? s.headingRad),
    });
  }
  return out;
}
```

- [ ] **Step 4: Walk entries in `useSpotEntries.ts`:** call `usePlacedWalkFits()` (it already reads inputs once and shares them); pass `walkSamples` to `spotEntries`: a walk layer that is not in `placedWalks(manifest)` gives `null` (not placed: skipped); a placed one whose fit is not in `fits` yet gives `undefined` (still reading); else `walkTrack(fit.fit, layer.durationS, layer.place?.heightM ?? WALK_HEIGHT_M, (t) => viewHeading(fit.fit, inputsOf(layer.id)?.orientation ?? null, layer.place?.yawOffsetDeg ?? 0, t))`, cached per `inputsKey(projectId, layer)` in a module `Map`. `reading` also covers walks still reading.
- [ ] **Step 5: The walk frame in `SpotMatchView.tsx`:** a `SpotWalkFrame` that makes a hidden `<video>` of the walk's playback copy (`playbackSrc` / `playbackRef` from `walks/walkModel.ts`, as `Walk360Pane` does), seeks it to `item.t`, pauses, and draws it with `createPanoVideoView(host, video, look)`; the look's yaw is in picture terms, so it is `lookDeg - centreBearing(t)` where `centreBearing` is the sample's `bearingDeg` of the match (pass `TrackSample.bearingDeg` through `SpotMatch` as an optional `centreDeg` field added in this task to `spotTypes.ts`, set by `matchWalk` and by `selfMatch` for walks). In compare, the shared look store holds compass bearings: the walk frame reads `yaw = look.yawDeg - centreDeg` and writes `yaw + centreDeg`, the same offset rule as `lookLink`'s `toShared` / `fromShared`. Drag and wheel turn it as `PanoSurface` does; arrows are left to the viewer. Tests: a walk match creates one pano video view (mock `@aio/video`'s `createPanoVideoView`) whose first look yaw is `lookDeg - centreDeg`, and whose video is seeked to `t`.
- [ ] **Step 6: The button in `Walk360Pane.tsx`:** in `walk-bar`, `<SpotHistoryButton open={{ item: { kind: 'walk', layer: walk.id, t: time }, lookDeg }} />` where `lookDeg` is the compass bearing of the current look (`heading` from `useWalkViewHeading` turned into a bearing with `bearingFromHeadingRad`, plus `look.current.yawDeg`), or no `lookDeg` while the walk is not placed (the viewer then shows "This walk is not placed...").
- [ ] **Step 7: Run** `spotWalk.test.ts`, `SpotMatchView.test.tsx`, `src/renderer/walks`, PASS; `tsc --noEmit`.
- [ ] **Step 8: Commit** `feat(walks): walk frames in spot history`.

### Task 13: End to end, the way CI runs it

**Files:**

- Create: `apps/desktop/e2e/spot-history.spec.ts`

- [ ] **Step 1: Write the spec.** Two parts, off-screen, zero network (the fixtures check it):

```ts
/**
 * Spot history (timeline S1) in the real app: from a photo of the change demo (C8, two survey
 * dates, the same six photos a little moved on the second date, a drone clip each) and from a
 * panorama of `e2e-pano-dates` (panoFixtures.ts), the viewer shows the spot on every date, steps
 * with the arrow keys, compares side by side and swiped, and leaves the main view alone.
 */
import type { Page } from '@playwright/test';
import { expect, openProject, test as base } from './fixtures';
import { createPanoDateProject, PANO_DATE_PROJECT_NAME } from './panoFixtures';

interface Hook {
  __stratlas: {
    workspace: {
      getState(): {
        selection: unknown;
        hidden: Record<string, true>;
        select(s: { kind: string; id: string; layer: string }): void;
      };
    };
  };
}

async function goTo(win: Page, name: 'Scene' | 'Media') {
  await win.locator('.sb-nav .nav-item', { hasText: name }).first().click();
}
const select = (win: Page, s: { kind: string; id: string; layer: string }) =>
  win.evaluate((s) => {
    (window as unknown as Hook).__stratlas.workspace.getState().select(s);
  }, s);
/** The hidden layers and the selection (any screen). */
const wsView = (win: Page) =>
  win.evaluate(() => {
    const s = (window as unknown as Hook).__stratlas.workspace.getState();
    return JSON.stringify({ hidden: s.hidden, selection: s.selection });
  });
/** What the main view shows: the date bar's date (on Scene, where the bar is) and the above. */
async function mainView(win: Page) {
  await goTo(win, 'Scene');
  return [await win.getByTestId('date-bar-open').getAttribute('aria-label'), await wsView(win)];
}
const head = (win: Page) => win.getByTestId('spot-head');

test('a photo shows its spot on both dates, steps with the keys and compares', async ({
  demoProject,
}) => {
  test.setTimeout(120_000);
  const { win } = demoProject;
  // a photo picked on Scene opens in Media (Stage.tsx); read the main view with it selected
  await select(win, { kind: 'photo', id: 'p05', layer: 'photos-d1' });
  const before = await mainView(win);
  await goTo(win, 'Media');
  const inline = win.getByTestId('spot-inline');
  await expect(inline.getByTestId('spot-slot-d1')).toHaveAttribute('data-empty', 'false');
  await expect(inline.getByTestId('spot-slot-d2')).toHaveAttribute('data-empty', 'false');
  const ws = await wsView(win);

  await win.getByTestId('spot-history-open').first().click();
  const dialog = win.getByTestId('spot-viewer');
  await expect(dialog).toBeVisible();
  await expect(head(win)).toHaveAttribute('data-capture', 'd1');
  await expect(head(win)).toHaveAttribute('data-item', 'p05');

  await win.keyboard.press('ArrowRight');
  await expect(head(win)).toHaveAttribute('data-capture', 'd2');
  await expect(head(win)).toHaveAttribute('data-item', 'p05');
  expect(Number(await head(win).getAttribute('data-distance'))).toBeLessThan(1.5);
  await win.keyboard.press('ArrowRight');
  await expect(head(win)).toHaveAttribute('data-capture', 'd2');
  await win.keyboard.press('ArrowLeft');
  await expect(head(win)).toHaveAttribute('data-capture', 'd1');
  expect(await wsView(win)).toEqual(ws);

  await win.getByTestId('spot-compare').click();
  const cmp = win.getByTestId('spot-compare-view');
  await expect(cmp).toHaveAttribute('data-mode', 'side');
  await expect(win.getByTestId('spot-compare-date-left')).toHaveValue('d1');
  await expect(win.getByTestId('spot-compare-date-right')).toHaveValue('d2');
  await win.getByTestId('spot-mode-swipe').click();
  await expect(cmp).toHaveAttribute('data-mode', 'swipe');
  const handle = win.getByTestId('frames-swipe');
  const was = Number(await handle.getAttribute('aria-valuenow'));
  await handle.focus();
  await win.keyboard.press('ArrowRight');
  await expect
    .poll(async () => Number(await handle.getAttribute('aria-valuenow')))
    .toBeGreaterThan(was);
  await expect(head(win)).toHaveAttribute('data-capture', 'd1');

  await win.keyboard.press('Escape');
  await expect(cmp).toHaveCount(0);
  await win.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(await mainView(win)).toEqual(before);
});

test('a drone photo finds the drone photo of the other date', async ({ demoProject }) => {
  const { win } = demoProject;
  await select(win, { kind: 'photo', id: 'p01', layer: 'photos-d1' });
  await goTo(win, 'Media');
  await win.getByTestId('spot-history-open').first().click();
  await win.keyboard.press('ArrowRight');
  await expect(head(win)).toHaveAttribute('data-capture', 'd2');
  await expect(head(win)).toHaveAttribute('data-kind', 'drone');
  await expect(head(win)).toHaveAttribute('data-item', 'p01');
});

const panoTest = base.extend<{ panoProject: { id: string } }>({
  panoProject: async ({ dataRoot }, use) => {
    await use(await createPanoDateProject(dataRoot));
  },
});

async function openPanoDates(win: Page, id: string) {
  await win.locator('.nav-item', { hasText: 'Projects' }).first().click();
  await win.getByTestId('project-card').filter({ hasText: PANO_DATE_PROJECT_NAME }).first().click();
  await expect.poll(async () => (await openProject(win)).id, { timeout: 30_000 }).toBe(id);
}

panoTest(
  'a 360 finds the nearest 360 of each date and shows the gaps',
  async ({ panoProject, win }) => {
    await openPanoDates(win, panoProject.id);
    await select(win, { kind: 'pano', id: 'p2', layer: 'pano-oct' });
    if (!(await win.getByTestId('spot-history-open').first().isVisible()))
      await win.getByRole('tab', { name: 'Selection' }).click();
    await win.getByTestId('spot-history-open').first().click();
    await expect(head(win)).toHaveAttribute('data-capture', 'oct');
    await expect(head(win)).toHaveAttribute('data-kind', 'pano');
    await win.keyboard.press('ArrowRight');
    await expect(head(win)).toHaveAttribute('data-capture', 'nov');
    await expect(head(win)).toHaveAttribute('data-item', 'p2');
    await win.keyboard.press('Escape');

    // p3 of 6 Nov stands at x = 60: no 360 of September or October within 25 m
    await select(win, { kind: 'pano', id: 'p3', layer: 'pano-nov' });
    await win.getByTestId('spot-history-open').first().click();
    await expect(win.getByTestId('spot-viewer').getByTestId('spot-slot-sep')).toHaveAttribute(
      'data-empty',
      'true',
    );
    await expect(win.getByTestId('spot-viewer').getByTestId('spot-slot-oct')).toContainText(
      'Nothing within 25 m',
    );
    await win.keyboard.press('ArrowLeft');
    await expect(head(win)).toHaveAttribute('data-capture', 'nov');
  },
);
```

(`panoTest` lists `panoProject` before `win` as `pano-compare.spec.ts` does. If the demo's photo layer ids differ, read them from `truth.layers.d1.photos` / `truth.layers.d2.photos` in `demoProject.truth` instead of the literal `photos-d1`. Check the Media nav item text and the `date-bar-open` label in `timeline.spec.ts` before running.)

- [ ] **Step 2: Build what CI builds** (from `apps/desktop`, through the runner): `pnpm demo:build --quick` and `pnpm demo:change --quick`. Worktrees have no `python/.venv`: point `QUADRION_E2E_PYTHON` at the main checkout's venv when a demo needs it.
- [ ] **Step 3: Run the way CI does** (after Task 12 is committed):

```bash
QUADRION_WINDOW_SIZE=1100x720 QUADRION_E2E_SCALE=1 QUADRION_E2E_SWGL=warp npx playwright test e2e/spot-history.spec.ts e2e/pano-compare.spec.ts e2e/change-frames.spec.ts --workers=1
```

then `e2e/spot-history.spec.ts --repeat-each=3`. The log must print `[e2e] window 1100 x 720 px at display scale 1`. `pano-compare.spec.ts` and `change-frames.spec.ts` run because Task 9 moved the panorama surface and Task 11 touched the Frames pane bar.

- [ ] **Step 4: Commit** `test(e2e): spot history from a photo and a 360`.

### Task 14: Guide and testing document

**Files:**

- Modify: `docs/guide/04-compare-dates.md`, `docs/TESTING.md`

- [ ] **Step 1:** `04-compare-dates.md`: a section "Other dates of one spot": where the **Other dates** button is (Media photo panel, with the strip under the photo; the split's photo pane; the Selection card for a photo or 360; the Frames pane; the walk player), what a slot shows (date colour, kind, "+n", a hatched slot with "Nothing within 15 m" or "Not seen", the tooltip for items without a position), the keys (left and right for dates with an image, up and down for other images of a date, C to compare, Esc), **Compare...** with Side by side and Swipe, and that the date bar and the layers do not change. Matching rules in one short table (the spec's), in plain words.
- [ ] **Step 2:** `TESTING.md`: a stage "Spot history (S1)" with the steps of "How to test" below (no project names; "a project with photos on two survey dates", "a project with 360s on two dates").
- [ ] **Step 3:** `pnpm format:check`; `node tools/agent/check-public-text.mjs docs/guide/04-compare-dates.md docs/TESTING.md`.
- [ ] **Step 4: Commit** `docs(guide): other dates of one spot`.

## Contract changes

None. Verified: the search reads loaded layers (`@aio/schema` types unchanged), the viewer state is in memory (`spotViewerStore.ts`, nothing persisted, no localStorage key), no IPC channel, no manifest or file format change, no `@aio/engine` or `@aio/video` API change (Task 9 moves a component inside the desktop app). `@aio/ui` gains words and a shortcut scope, which are not contracts. No row in `docs/architecture/contract-changes.md`.

## Self-review

- **Spec coverage:** the search with every kind and the table's tolerances (Tasks 1 to 5, 12); ground versus aerial by height (Task 2 `matchPhoto`, Task 4); target-only spots for S2 (Task 2 tests); footprint without a lens left out (Task 2); ranking and "+n" (Tasks 3, 8); skipped counts (Tasks 3, 5, 8); the clicked item is its date's match (Task 3); scale and video caching (Task 3 timing guard, Task 5 cache); the strip with colours, thumbnails, kinds, gaps, tooltips (Task 8); header with name, date, kind, distance and angle (Task 10); arrows and clicks (Tasks 8, 10); 360s and walk frames turned to the view, videos paused at the moment and playable (Tasks 9, 12); main view untouched (Task 10 test, Task 13); no-position line and one-date rule (Tasks 10, 11); Compare with Side by side and Swipe, linked 360 look and linked photo zoom and pan (Task 10, founder decisions 1 and 2); error handling: unreadable flights skipped (Task 5), missing thumbnails (Task 8 `MediaThumb` icon), failed images (Task 9); one e2e spec on the change demo plus the 360 part (Task 13); guide (Task 14).
- **Placeholders:** none; the two "check before running" notes in Task 13 name exactly what to read.
- **Types:** `SpotOpen`, `SpotItem`, `SpotMatch`, `SpotAt`, `SpotCompareState`, `historyFor`, `stripKey`, `openSpotHistory` are spelled the same in every task. Task 12 adds the optional `SpotMatch.centreDeg` (it runs after every other task has landed, so no batch shares those files).
- **Review focus:** each of the five lines names its pinning test and owning task.

## After the last task

- `pnpm check` green (runner), the e2e of Task 13 step 3, an independent review of the whole branch.
- `node tools/agent/finish-task.mjs` for the hand-off; mention deviation 1 (compare in the viewer) and that S2 (spot on the map) builds on `searchSpot` with a target-only spot and on `openSpotHistory`.

## How to test (for the founder)

On a project with photos on at least two survey dates (the change demo works):

1. Open **Media** and click a photo. Under the photo a strip shows one slot per survey date, oldest on the left, each in its date colour with a thumbnail and its kind. A date with nothing near is a hatched slot that says "Nothing within 15 m".
2. Click **Other dates** (the clock-arrow button in the photo panel header). The viewer opens on the photo you clicked; the header shows its name, date and kind.
3. Press **→**. The viewer shows the same spot on the next date with an image, skipping empty dates, and the header says how far it was taken from your photo. Press **↓** on a date with "+1" or more to see the other images of that date. Press **←** to go back.
4. Press **C** (or **Compare...**). The two dates sit side by side; the date chips above change either side. Turn the mouse wheel over either photo: both zoom in on the same place; drag to pan both, double-click to fit. Click **Swipe** and drag the handle (or focus it and use the arrow keys): the zoom stays and both dates stay lined up under the divider.
5. Press **Esc** twice to close. The date bar, the layers you had on and the selected photo are exactly as before.
6. Click a drone photo and open **Other dates**: the other date's slot shows the drone photo that sees the same ground ("Drone"); a date whose flights never saw it says "Not seen".
7. On a project with 360s on two dates, select a 360 in 3D, open the **Selection** tab and click **Other dates**: the nearest 360 of each date opens turned towards the same spot; where none is within 25 m the slot says so.
8. In the split, put the **Frames** pane on a side, play a clip and pause it; **Other dates** in the pane opens the spot the frame looks at, and a matched clip of the other date opens paused at the moment it saw it (press play to run it).
9. With a placed walk, open **Other dates** from the walk player: the walk frames of other dates near you open turned the same way.
