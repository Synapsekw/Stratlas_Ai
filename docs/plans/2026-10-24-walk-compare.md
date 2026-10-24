# 360 walks: view cone, draped track and walk compare (plan)

Design: `2026-10-24-walk-compare-design.md`. Starts from the spike commit on `feat/walk-compare` (`walkView.ts`, `walkCompare.ts`, `walkCompare.css`, changes in `Walk360Pane.tsx`, `walkScene.ts`, `WalkSceneMount.tsx`, `walkMapOverlay.ts`, `placeWalk.ts`, `splitModel.ts`, `SplitPanes.tsx`, `CompareLineUp.tsx`, `walkMounts.tsx`, `kindActions.tsx`, `en.ts`). Every task removes the `SPIKE` markers in its files and brings them to production quality with tests. Paths below are under `apps/desktop/src/renderer/` unless they start with `packages/`.

No contract change. No pipeline pack change.

## Tasks

**T1 Drape (fix).** Files: `walks/walkScene.ts` (drape and line only), `walks/WalkSceneMount.tsx`, `packages/geo/src/walk/pose.ts`, `packages/geo/src/walk/fit.ts` (only if a ground-sampler hook is needed), `workspace/spot/spotWalk.ts`, a new `walks/walkGround.ts` sampler.

- One ground sampler: DSM ray down, then visible ortho / mesh / cloud, then the pin height.
- A per-frame sampling budget, resampled on layer load and date change.
- The pose and spot-history heights use the same sampler.
- Tests: `walkGround.test.ts` (order of sources, fallback, budget); update `walkScene.test.ts`, `WalkSceneMount.test.ts`, `pose` and `spotWalk` tests.

**T2 Compare.** Files: `walks/walkCompare.ts`, `walks/walkCompare.css`, `walks/Walk360Pane.tsx` (compare parts), `workspace/splitModel.ts`, `workspace/SplitPanes.tsx`, `lineup/CompareLineUp.tsx`, `walks/walkMounts.tsx`, `shell/actions/kindActions.tsx`, the compare strings in `packages/ui/src/i18n/en.ts`.

- Remove the dimmed far state. Distance chip: neutral under 5 m, amber past it.
- Detour bands on each scrubber; seeking into a band plays that walk alone until the routes rejoin or the lead plays.
- Smooth follower: rate matching plus a resync on drift, no visible stutter.
- Pairing prefers the pass going the same direction.
- The pane under the pointer steers the linked look.
- Compare state is remembered per project for the session.
- Starting a compare shows both walks without writing visibility into the project.
- Tests: `walkCompare.test.ts` (nearest place, same-direction preference, detour bands, by time, swap, link-look bearing maths), `splitModel.test.ts` (two walk panes allowed, not a date compare), a `kindActions` test for "Compare with walk".

**T3 Beam marker.** Files: `walks/walkView.ts`, `walks/walkMapOverlay.ts`, `walks/placeWalk.ts`, `walks/walkScene.ts` (3D marker only), `walks/walkOverlay.ts` and `walks/WalkSheetOverlay.tsx`.

- Keep only Beam; delete Compass, Rays, the Ctrl+Alt+M shortcut and `stratlas.walkMarkerStyle`.
- Constant on-screen size on the map with a smooth fade (an HTML or SVG marker rotated by the look bearing minus the map bearing, or a rendered sprite).
- Add the cone on drawing sheets, which ends the single-walk playback flicker there: sheets read `walkView`.
- 3D marker on the draped ground (it uses T1's sampler).
- Tests: `walkView.test.ts` (publish, throttle, per-layer), `walkMapOverlay.test.ts` (cone bearing and width), sheet overlay test, `walkScene.test.ts` (marker pose).

**T4 E2E.** New `apps/desktop/e2e/walk-compare.spec.ts` on `walkFixture.ts`, extended to two dates and two walks plus an ortho below 0. It covers:

- start compare from the menu;
- the follower seeks by place and the chip shows;
- a detour band exists and seeking into it plays one walk;
- dragging the 360 turns the cone (read from a `data-look-deg` on the marker);
- the 3D track height equals the ortho height (read through the existing e2e bridge).

Run it CI-style (1100 x 720, scale 1, WARP, `--workers=1`), together with the walk specs it may touch: `walk-360`, `walk-place-map`, `walk-place-3d`, `walk-place`, `spot-history`, `compare`, `split-resize`.

**T5 Docs.**

- `docs/KNOWN-LIMITS.md`: drop "no compare of two walks yet" and add what is left.
- In the walks design (`2026-10-07-walks-360-design.md`), mark W3 and W5 progress.
- Update `docs/TESTING.md` if it lists walk specs.
- `/wrapup` note with the How to test.

**T6 Review.** An independent review of the whole diff, at high effort, with fixes.

## Execution DAG

```
T1 drape ──┐
           ├─> T3 beam marker ─┐
T2 compare ┘ (walkScene.ts     ├─> T4 e2e ─> T5 docs + wrapup ─> T6 review ─> pnpm check, finish-task, hand-over
                is shared)     │
```

- **Batch 1 (parallel):** T1 and T2. They touch no common files; `en.ts` belongs to T2 only.
- **Batch 2:** T3, which needs T1's sampler and edits `walkScene.ts` after T1. It touches `Walk360Pane.tsx` only to read `walkView` (and only if needed, after T2).
- **Batch 3:** T4.
- **Batch 4:** T5, then T6.
- **Critical path:** T1 → T3 → T4 → T6.

While T1 and T2 share the tree, each commits only its own paths (`git commit -- <paths>`). Heavy runs (full `pnpm test`, e2e) happen one at a time; per-file vitest runs are fine.
