---
type: session
date: 2026-10-31-1046
branch: fix/founder-test-round-1
status: complete
related: [plans/2026-10-30-ui-revision.md]
---

# Founder test round 1 on the UI revision batch

## What changed

- The stage notch opens on a click, its chevron, Enter or Space, or T only; resting the pointer on it opens nothing, and it stays open when the pointer leaves (a press outside, Esc or Close closes it). The spike's island takes T too.
- The left sidebar has a calm Processing section again (a heading and Create maps from photos as a plain row, not a filled button), also at the top of the spike's Layers column. The drawer, library card and scene offer stay.
- Spike: both side panels fold. Ctrl+Alt+B and a new title bar toggle fold the right panel (the shell's own state); Ctrl+B and Ctrl+L fold Layers. In the spike Ctrl+B and the palette never touch today's hidden sidebar.
- Spike: a clicked pile in Selection gets the panel's padding (it sat flush under the drag handle). The pile panel's and Volumes header's three figures fold to two rows only in a panel under 320 px; the 360 px default keeps them in a row. The inventory caption wraps inside the panel.
- Guide 03, 28 and 46 follow. e2e: island, processing-drawer, ui-polish-shell and layout-spike specs extended; all in this PR.

## Why

The founder tested the batch on local `main` and decided all four fixes; the review asked for the T key, the 320 px threshold and the hidden sidebar guard.

## How to test

1. Open a project with two dates. Rest the pointer on the notch: nothing opens. Click it: the tools open; move away: they stay; click the 3D view: they close. Tab to it and press Enter: they open.
2. Look at the left sidebar under the screens: PROCESSING, then Create maps from photos as a quiet row. Click it: the wizard opens. Fold the sidebar (Ctrl+B): the photo glyph stays with a tip.
3. Press Ctrl+Alt+L. Press Ctrl+B: Layers opens with Processing on top; Ctrl+B again closes it. Press Ctrl+Alt+B or the title bar's right toggle: the right panel folds and the stage widens; again brings it back. Press T: the spike's island opens; T closes it.
4. In the spike, open the quarry demo, open Layers and click Stockpile SP1: Selection shows the pile with a margin on the left, Volume on its own row, Tonnes and the change under it, no "...". Project > Volumes: the same, and the caption wraps.
5. Leave the spike (Ctrl+Alt+L) at a wide window: the sidebar is as before, and the Volumes tab shows the three figures in one row.

## Open threads

- The guide's other notch wording was checked; the inventory table still scrolls sideways in a 300 px panel.

## Next session entry point

The Wave 2 build (W7 onward) from `plans/2026-10-30-ui-revision.md`.
