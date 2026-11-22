---
type: session
date: 2026-11-22-1353
branch: fix/split-notice-globe-spec
status: complete
related: [../plans/2026-11-22-split-notice-globe-spec.md, 2026-11-12-1130-lineup-toast-overlap.md]
---

# A notice in a Split keeps off the bottom strip, and the Globe specs wait for the Globe

## What changed

- **A notice in a Split no longer covers the bottom strip.** In a Split (and with the floating video in the bottom left corner) notices show in the window's toast host, which stood on the last 376 px of the strip and took its clicks. While that host shows a notice, the strip now keeps the notice's room free at its end, and the notice stands inside the strip's height (two CSS rules in `workspace/stageSlots.css`). When the notice goes, the strip takes its width back.
- **Checks.** `change-frames.spec.ts` and `line-up-dates.spec.ts` assert that the strip's content ends before the notice, that the notice does not reach over the pane and that it stays in the window. Both failed before the rule ("the notice lies over what the strip shows") and pass with it.
- **The Globe's first wait.** The first wait after a click on Globe (`openGlobe` in `globe.spec.ts`, and the same wait in `online-map-sources`, `packages-globe` and `photo-change`) had the default 5 s where every later wait has 60 s; it now has the Globe's budget. No retry, no skip.
- **Decided (founder delegated the calls):** in a Split the strip gives way to the notice; a passing notice briefly narrowing the strip is accepted; the blank Globe screen while its code loads is left alone during the freeze. Recorded in the plan.
- No contract change, no pack change. This PR does not refresh section 3 of the north star: another branch of the same batch does, so the refresh for this fix rides on that branch or on the next wrap-up.

## Why

The two open threads of the 12 Nov note: an Undo notice kept nearly half of the timeline out of reach at 1100 px, and `globe-in-the-smallest-window` went red on CI on a slow first open of the Globe, which was a test budget and not a fault of the app.

## How to test

The development app (`pnpm dev`) lists the demo projects only when `QUADRION_DEMO` names the built demo folder; without it the Projects screen holds only the projects of the data root. Either start it with the demo (PowerShell, from the repository root, after `pnpm demo:build --quick`: `$env:QUADRION_DEMO = "$PWD\apps\desktop\demo"; pnpm dev`) and use "Demo change site (2 dates)", or use any project of your own that has a dataset in its tree.

1. Make the window small (about 1100 x 720), open the project from the Projects screen and press 3, or click the Split switch in the stage tools.
2. In the Datasets tree, right-click a dataset, Export..., and pick a folder. The "Exporting datasets" notice shows at the bottom, left of the panel on the right, at the end of the bottom strip. The strip's content ends before the notice; nothing of it lies under the notice, and the notice does not reach over the pane.
3. Click Dismiss (the cross) on the notice: the strip takes its full width back.
4. The Globe change is in the tests only: nothing to see in the app.

Steps 1 to 3 were driven by a real run of that exact route at 1100 x 720 (a scratch spec, not committed): the built app started with `QUADRION_DEMO`, the demo opened by its card on the Projects screen. The same checks on the graphics notice and the line-up notice are in the two committed specs. `pnpm dev` itself was not started (its window would show on the workstation's screen); it reads the same variable through the same code (`src/main/demo.ts`, `demoRoot`).

## Open threads

- With both sidebars open at 1100 px the strip is 496 px wide and keeps about 104 px for its content while a notice shows (measured). Nothing is covered, but little of the timeline is left until the notice is closed; folding a sidebar gives it room. A strip of 392 px or less would keep none.
- With no strip on screen in a Split (no dates to show, video closed) the strip element is still there at zero height, so the notice stands 4 px from the window's edge where it stood 16 px, over the foot of the pane as before.
- The tallest notice measured, an export, was 99 px; the line-up notice is 108 px; the lowest strip is 120 px. A taller notice would reach over the pane by the difference.
- The independent review found more Globe waits at the default 5 s that this PR left alone, since none has failed: two re-opens in `globe.spec.ts` (a bare `expect.poll` after the click) and the first Globe open in `shell-layout.spec.ts`.
- The strip checks measure the strip's content box, not what a child might draw outside it.

## Next session entry point

The founder runs the three steps on local `main` once the branch has landed; if the narrow strip with both sidebars open bothers in use, the follow-up is to limit the inset to notices that stay, or to lift the notice when the strip is too narrow.
