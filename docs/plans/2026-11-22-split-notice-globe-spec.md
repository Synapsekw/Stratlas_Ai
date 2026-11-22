# The Split notice over the bottom strip, and the Globe's first wait: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to build this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** close the two open threads of `docs/sessions/2026-11-12-1130-lineup-toast-overlap.md`: a notice shown in a Split no longer covers the bottom strip, and the Globe specs no longer go red on a slow first open.

**Architecture:** one CSS rule (the bottom strip keeps the notice's room free at its end while the window's toast host shows a notice) and one wait budget in four end to end specs. No product logic, no contract, no new component.

**Tech stack:** CSS (anchor positioning and `:has`, both already used in `stageSlots.css`), Playwright with Electron.

**Spec:** this file (sections "Findings" and "Design"); the brief was the two open threads of the session note above. Feature freeze: fixes only.

## Global constraints

- Windows only. Packages touched: `apps/desktop` only (renderer CSS and `e2e/`). No `@aio/schema` change, so no row in `docs/architecture/contract-changes.md`. No pipeline pack bump.
- Public repository: no client, site, tester or person names in code, docs, commits or screenshots. No emoji, no em or en dashes.
- No retry, no skip, no `test.fixme`: `playwright.config.ts` keeps `retries: 0`.
- e2e runs: one Playwright run at a time, `--workers=1`, windows off screen (the fixtures do that). In a worktree set `QUADRION_E2E_PYTHON` to the main checkout's pipeline Python.
- Work in `.claude/worktrees/split-notice-globe-spec` on `fix/split-notice-globe-spec`; while a batch is open, rebase onto the local `main`. Hand over to the merge coordinator; no push, no pull request.

## Findings

Neither thread was fixed since 12 Nov. `git log --since=2026-11-12 -- apps/desktop/e2e apps/desktop/src/renderer` holds one commit near either (`f1628b233`, the 12 Nov fix itself); `globe.spec.ts`, `stageSlots.css` and `packages/ui/src/parts/toast.css` are unchanged since, and no later session note mentions either.

### 1. A notice in a Split lies over the bottom strip

Cause, by reading the code:

- In a Split the stage's own toast host is not mounted (`apps/desktop/src/renderer/workspace/Stage.tsx:434`, `toastHere = !o.splitting && !o.video.includes('bl')`), so toasts show in the window's host (`exports/Toasts.tsx:160`, `<ToastHost placement="window" />`). The same holds in a single view while the floating video rests in the bottom left corner.
- The window's host is `position: fixed; bottom: var(--sp-6)` (`packages/ui/src/parts/toast.css:3-15`): 16 px above the window's bottom edge.
- The 12 Nov fix (`workspace/stageSlots.css:48-54`) moved its inline position to the stage's column. Its block position is still the window's bottom edge.
- The bottom strip is the second row of the same column (`styles.css:1613-1622`, grid areas `'stage right' 'tl right'`; `WorkspaceScreen.tsx:155`, `.ws-strip`), 120 px tall under 1280 px (`video/videoDock.css:1-10`).

So the card (360 x 108 px for the line-up's Undo notice, measured on 12 Nov at y 596 to 704 in a 720 px window) stands on the last 376 px of the strip and takes its clicks. A notice with a button stays until it is acted on or closed, so at 1100 px, where the strip is 800 px wide, nearly half of the timeline cannot be reached meanwhile. The top 4 px of the card also lie over the foot of the pane.

### 2. `globe-in-the-smallest-window` red on CI shard 1

The failing run is `43163065010` (12 Nov, batch pull request), job `e2e (windows-latest, 1/6)`. Evidence read from its log, its `error-context.md` and its trace:

- The failure is not about the smallest window. It is the first wait of `openGlobe` (`apps/desktop/e2e/globe.spec.ts:593`): `expect(getByTestId('globe-canvas').locator('canvas')).toBeVisible()` with Playwright's default 5 s, "element(s) not found". The test never reached a layout check.
- The page snapshot at the failure shows the sidebar and the title bar and an empty `main`: no "Find a site" field, no page header, no loader. The Globe screen is a lazy chunk behind `<Suspense fallback={null}>` (`src/renderer/App.tsx:124`, `270-272`; the chunk is 4.6 MB in the build log), and `GlobeScreen` renders a header and a loader as soon as it runs (`globe/GlobeScreen.tsx:386-394`). An empty `main` means the chunk had not been loaded and run yet.
- The trace: the click on Globe took 0.95 s, and the 5 s wait came back after 7.46 s of wall time (241790 to 249252 ms). The renderer was held the whole time; Playwright could not even poll on schedule.
- The same line failed in another Globe test on another run: `42612863142` (9 Nov), `globe.spec.ts:1527`, a test at CI's default size. Three CI runs since 12 Nov passed the test with no change to it (`43171009017`, `43451683048`, `44988078697`).
- The spec knows the first frames of the Globe hold the renderer for many seconds on the runner (the comment at `globe.spec.ts:594-595` cites 15.8 s; `SETTLE_MS` is 60 s for that reason, lines 80-92), and every wait after the first one has that budget. The first wait alone was left at 5 s. `perf-m10.spec.ts:402` and `perf-m10-bench.spec.ts:259` give the same wait 60 s and 120 s.

Cause: the first wait of a Globe open covers loading and running the 4.6 MB chunk, the screen's data and the build of the Cesium widget on a two core runner with the WARP software renderer, and it has a 5 s budget where every later wait has 60 s. On a busy runner that step sometimes takes longer, in whichever Globe test it happens to hit. The fault is in the test's budget, not in the product: the Globe did open (the next test opened it 4 s later), and nothing is wrong at 1100 x 700.

What the evidence does not show: why that open was slow on that run (the trace has no CPU profile). The fix does not depend on it.

Three more specs have the same 5 s wait after the same click: `online-map-sources.spec.ts:177`, `packages-globe.spec.ts:206`, `photo-change.spec.ts:470`.

## Design

### 1. The strip keeps the notice's room free

Every place the notice could stand in a Split covers something: the panel on the right (ruled out on 12 Nov), a pane (ruled out by design, `change-frames.spec.ts:236`: the Frames stack must stay reachable) or the strip (today). So the strip gives way instead: while the window's host shows a notice and a Scene strip is on screen, the strip keeps an end inset as wide as the notice, and the notice sits inside the strip's height. The timeline, the dates strip or the ruler lay themselves out in the room that is left, as they already do when both side panels are open (`videoDock.css:84-93`, the strip under 600 px).

Options considered:

| Option                                           | What it costs                                                                                                 | Verdict                    |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | -------------------------- |
| A. The strip keeps the room free (this plan)     | The timeline is narrower while a notice shows, and steps back when it goes                                    | Chosen: nothing is covered |
| B. Lift the notice onto the foot of the end pane | Covers the pane's bottom right (legends, readout), against the rule that no toast stands over a pane in Split | Rejected                   |
| C. Leave it                                      | Half the timeline is out of reach at 1100 px while an Undo notice stands                                      | Rejected                   |
| D. A row of its own between the views and strip  | New layout and markup, the panes lose height; too much for a freeze                                           | Rejected                   |

The rule, in `apps/desktop/src/renderer/workspace/stageSlots.css` after the 12 Nov block (the padding is on `.ws-strip`, the size container, so its container queries see the narrower strip):

```css
/* ... and never over the bottom strip: while it shows a notice, the strip keeps the notice's
   room free at its end, and the notice stands inside the strip's height. */
.app:has(.q-toasts[data-placement='window'] .q-toast) .ws-strip {
  padding-inline-end: calc(min(360px, 100% - 2 * var(--sp-6)) + 2 * var(--sp-6));
}
.app:has(.ws-strip) .q-toasts[data-placement='window'] {
  bottom: var(--sp-2);
}
```

With no Scene strip on screen (home, Globe, settings) neither rule applies and the host stays where it is.

### 2. The first wait of a Globe open gets the Globe's budget

`openGlobe` passes `{ timeout: SETTLE_MS }` to its first wait, and the three other specs pass `{ timeout: 60_000 }` to theirs, with one comment line saying why. No retry and no skip: the wait still fails when the canvas never comes.

## Review focus

- A notice taller than the strip (a running export with its bar and Cancel): it would reach over the foot of the pane by the difference. Task 1 step 5 measures it.
- A strip with the docked video tile at 1100 px: the tile must give way to its Pop out button (the existing rule under 600 px), not overflow.
- A passing notice (no button, gone in seconds) makes the strip step twice. Accepted for now, see the open questions.
- Right-to-left: the inset is logical (`padding-inline-end`), and the host's inline position already is.
- The single view with the floating video in the bottom left corner also uses the window's host: the same rule applies there.

## Execution DAG

```
Task 1 (notice clear of the strip) ──┐
                                     ├──> Task 3 (checks, wrap-up, hand-over)
Task 2 (the Globe's first wait) ─────┘
```

- **Batch 1, in parallel, one message:** Task 1 and Task 2. No shared files: Task 1 owns `workspace/stageSlots.css`, `e2e/change-frames.spec.ts` and `e2e/line-up-dates.spec.ts`; Task 2 owns `e2e/globe.spec.ts`, `e2e/online-map-sources.spec.ts`, `e2e/packages-globe.spec.ts` and `e2e/photo-change.spec.ts`. Their Playwright runs and commits share one worktree, so they take turns through one lock (one heavy run at a time).
- **Batch 2:** Task 3, after both.
- **Critical path:** Task 1 (its e2e runs are the long ones), then Task 3.
- **Contract change:** none. **Packages:** `apps/desktop` in every task.

### Task 1: a notice in a Split stays clear of the bottom strip

**Files:**

- Modify: `apps/desktop/src/renderer/workspace/stageSlots.css` (after line 54)
- Test: `apps/desktop/e2e/change-frames.spec.ts` (the block at lines 236-262), `apps/desktop/e2e/line-up-dates.spec.ts` (the block at lines 1049-1066)

**e2e specs changed:** `change-frames.spec.ts`, `line-up-dates.spec.ts`. None added.

- [ ] **Step 1: write the failing checks.** In `change-frames.spec.ts`, after `expect(underToast).toBe('clear')`, add a check with the graphics notice still showing:

```ts
// nor over the bottom strip: the strip keeps the notice's room free, and no pane is under it
const strip = await win.evaluate(() => {
  const card = document.querySelector('[data-testid="graphics-notice"]')?.getBoundingClientRect();
  const band = document.querySelector('[data-testid="bottom-strip"]')?.getBoundingClientRect();
  const inner = document.querySelector('.ws-strip-in')?.getBoundingClientRect();
  if (!card || !band || !inner) return ['missing'];
  const out: string[] = [];
  if (inner.right > card.left) out.push('the notice lies over what the strip shows');
  if (card.top < band.top) out.push('the notice reaches over the pane');
  if (card.bottom > band.bottom) out.push('the notice leaves the window');
  return out;
});
expect(strip).toEqual([]);
```

In `line-up-dates.spec.ts`, add the same three conditions for `[data-testid="lineup-notice"]` to the `heads` evaluation (push the same strings to `out`), so the 108 px Undo notice is measured too.

- [ ] **Step 2: run them the way CI does and see them fail.** From `apps/desktop`, after `pnpm demo:build --quick`, with `QUADRION_WINDOW_SIZE=1100x720`, `QUADRION_E2E_SCALE=1`, `QUADRION_E2E_SWGL=warp`:

`npx playwright test e2e/change-frames.spec.ts e2e/line-up-dates.spec.ts --workers=1`

Expected: the log prints `[e2e] window 1100 x 720 px at display scale 1`; both changed tests fail with "the notice lies over what the strip shows" (the line-up one also with "the notice reaches over the pane").

- [ ] **Step 3: add the two CSS rules** of "Design, 1" to `stageSlots.css`, with their comment.

- [ ] **Step 4: run the same command again.** Expected: both specs pass. Look at `notice-off-panel.png` of the line-up spec: the notice at the strip's end, the timeline beside it, nothing cut.

- [ ] **Step 5: the neighbours.** Run, the same way: `e2e/toasts.spec.ts e2e/stage-overlays.spec.ts e2e/dates-strip.spec.ts e2e/video-dock.spec.ts e2e/small-window.spec.ts e2e/timeline.spec.ts`. Expected: all pass. Then measure the tallest notice once (a running export in a Split, by a short `win.evaluate` in a scratch run, not committed): if its card is taller than the strip less 4 px, report the two heights in the hand-over as an open point; do not grow the fix.

- [ ] **Step 6: commit.** `fix(desktop): a notice in a Split keeps off the bottom strip`

### Task 2: the first wait of a Globe open has the Globe's time budget

**Files:**

- Modify: `apps/desktop/e2e/globe.spec.ts:593`, `apps/desktop/e2e/online-map-sources.spec.ts:177`, `apps/desktop/e2e/packages-globe.spec.ts:206`, `apps/desktop/e2e/photo-change.spec.ts:470`

**e2e specs changed:** those four. None added.

**The failing test first:** there is none to write. The failure is a time budget on a slow runner, not a behaviour; the evidence is the CI trace in "Findings, 2". Do not add a test that slows the app down to prove it.

- [ ] **Step 1: `globe.spec.ts`.** In `openGlobe`, the first wait becomes `toBeVisible({ timeout: SETTLE_MS })`, under this comment:

```ts
// The first open loads and runs the Globe's chunk and builds its widget, which holds the
// renderer: on a busy runner the canvas came after more than the default 5 s (CI runs
// 42612863142 and 43163065010), in whichever test it hit.
```

- [ ] **Step 2: the three other specs.** Their wait for `getByTestId('globe-canvas').locator('canvas')` becomes `toBeVisible({ timeout: 60_000 })` with a one line comment that points at `openGlobe` in `globe.spec.ts`.

- [ ] **Step 3: run them the way CI does.** Same environment as Task 1 step 2:

`npx playwright test e2e/globe.spec.ts --workers=1 --repeat-each=3`, then `npx playwright test e2e/online-map-sources.spec.ts e2e/packages-globe.spec.ts e2e/photo-change.spec.ts --workers=1`

Expected: all pass, with the window line in the log (the smallest-window test sizes itself to 1100 x 700). Ask the founder for a window before the repeat run if the workstation is in use: WARP on the Globe is heavy.

- [ ] **Step 4: commit.** `test(e2e): the first wait of a Globe open has the Globe's time budget`

### Task 3: checks, wrap-up, hand-over

- [ ] `pnpm check` green in the worktree.
- [ ] `/wrapup`: a note in `docs/sessions/` (it says "this PR"), section 3 of `docs/NORTH-STAR.md`; `node tools/agent/check-public-text.mjs` on the note and this plan.
- [ ] `node tools/agent/finish-task.mjs` (rebases onto the local `main` while a batch is open).
- [ ] SendMessage the merge coordinator: branch, head SHA, the two commits, the check and e2e results, the "How to test" steps below. No push, no pull request.

## How to test (draft, for the founder)

1. Open a project with two survey dates in a small window (about 1100 x 720) and switch the stage to two panes. Line the dates up (the dates chip, Line up dates, Line up). The "Line up dates" notice with Undo shows at the bottom, left of the panel on the right, at the end of the bottom strip: the strip's content ends before the notice, and nothing of it is under the notice. (`line-up-dates.spec.ts`, "turned dates line up from Compare".)
2. With the notice showing, click a date at the end of the strip and press Play: both work. Close the notice: the strip takes its full width back. (`change-frames.spec.ts`, "job progress never covers the Frames pane".)
3. The Globe change is in the tests only: nothing to see in the app.

## Open questions for the founder

1. **Where a notice stands in a Split.** Every place covers something. This plan lets the strip give way, so the timeline is narrower while a notice shows. The other choices are the notice over the foot of the end pane, or leaving it over the strip. Recommended: the strip gives way (nothing is out of reach, one CSS rule).
2. **Passing notices.** A notice without a button also makes the strip step aside for its few seconds. Recommended: accept it now; if the step bothers in use, a follow-up limits it to notices that stay.
3. **An empty screen while the Globe's chunk loads.** On a slow machine the Globe screen is blank until its code has loaded (no loader before that). Recommended: leave it during the freeze; it showed only on the CI runner.
