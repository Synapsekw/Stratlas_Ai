---
type: session
date: 2026-10-24-2130
branch: fix/walk-zoom-match
status: complete
related: [2026-10-24-1555-walk-compare-view-cone.md, ../plans/2026-10-24-walk-compare-design.md]
---

# Walk compare: one zoom in both panes, and a compare that ends

## What changed

- Compared walks show the same zoom: both compare bars are one row of the same height (narrow panes shorten labels to icons), Link look matches the horizontal field of view for each pane's own size, and both panes share one zoom range so they stop together. A "Zoom 71°" readout shows while the pointer is over a 360 pane.
- A compare ends when no 360 pane shows either compared walk (stage to 3D or Map, or a pane changed away from 360), and switching a compared walk off with its eye wins; before, the walks stayed forced on with no way to hide them.
- `walk-compare.spec.ts` checks equal boxes and zoom all the way out, with a moved divider, and that the walks hide after the compare ends.

## Why

Founder testing on local main: one pane looked less zoomed out (the lead pane had a second header row, so its picture was shorter with the same vertical angle), and the two walk lines could not be turned off after a compare.

## How to test

1. Compare two walks (right-click a walk, Compare with walk). Zoom all the way out in one pane: both pictures are the same size and the "Zoom" readouts match when you hover each pane.
2. Drag the split divider and zoom again: the readouts still match.
3. Switch the stage to 3D: the compare ends; turn both walks off with their eyes: their lines disappear.

## Open threads

- Founder reports, not reproduced on the synthetic project: walk lines turning black while orbiting in 3D (likely the model hiding the thin colour core while the halo shows; a console check was sent to the founder), and the app looking blurred after closing a compare with X until a restart (likely a graphics tier step-down after a lost WebGL context; awaiting `__stratlas.memory()` output).

## Next session entry point

The founder's results for the two open reports decide the next fixes.
