---
type: session
date: 2026-11-12-1130
branch: fix/lineup-toast-overlap
status: complete
related: [2026-11-12-0938-intelligence-wave-3.md]
---

# Window toasts keep off the panel on the right

## What changed

- The window's toast host (the one toasts use while the stage's own host is not mounted, as in a Split) now stands at the bottom right of the stage's column instead of the window's corner: its end inset is the right panel's width, through the stage's anchor (`apps/desktop/src/renderer/workspace/stageSlots.css`), and it is never wider than the stage. With no stage on screen (home, settings) it stays in the window corner.
- `e2e/line-up-dates.spec.ts` ("at the window size CI uses › turned dates line up from Compare") now checks, while the line-up's Undo notice shows in a Split, that the notice lies clear of the panel and that every section head on the Project tab takes a click.

## Why

CI went red on that spec: the click on the Changes section head was taken by the "Line up dates" notice. Reproduced the CI way (1100 x 720, scale 1, WARP): the notice's card stood at x 724 to 1084, y 596 to 704, over the right panel (x 800 to 1100), and the Project tab's heads stood at Search this project 560, Changes 592, Jobs 624. The notice has Undo, so it stays until it is acted on or closed. The new "Search this project" section (Wave 3) moved Changes 32 px down under the card; Jobs and the agent row at the panel's foot were already under it before. A person at that size could not open Changes or Jobs while an undo notice stood in a Split, so the fix is in the product, not the spec.

## How to test

1. Open a project with two survey dates, at a small window (about 1100 x 720). Switch the stage to two panes and line the dates up (the dates chip, Line up dates, Line up). The "Line up dates" notice with Undo shows at the bottom of the stage, left of the panel on the right, not over it. (`line-up-dates.spec.ts`, "turned dates line up from Compare".)
2. With the notice still showing, open the Project tab: every section head down to Changes and Jobs opens on a click. (same spec)

## Open threads

- In a Split the notice now lies over the right end of the bottom strip (the transport and the timeline) instead of the panel; the stage's panes stay clear, as `change-frames.spec.ts` requires.
- Unrelated red on the same CI run: `globe-in-the-smallest-window` (shard 1), not looked at here.

## Next session entry point

Hand this branch to the merge coordinator.
