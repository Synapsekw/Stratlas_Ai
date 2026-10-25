---
type: session
date: 2026-10-25-1251
branch: fix/section-window-scroll
status: complete
related: []
---

# One section window, a pile panel that scrolls, and a Timeline tile that waits

## What changed

- The pile's Open larger opens one section window (`1587e1c91`): `openSection` turned the dock on, and closing the window brought the dock back. A new `openSectionWindow` opens the window alone (`windowAlone`), so closing it leaves nothing.
- The pile panel scrolls with the wheel anywhere over it (`18ece8c33`): the rows list overflowed by 10 px from margins nobody counted, and its `overscroll-behavior: contain` caught the wheel. The margins are padding now, and the open panel passes the wheel to the tab.
- The Timeline tile waits for a second survey date (`09638b864`): with no video and fewer than two dated surveys the View tile is greyed with the tip "Add a second survey date to see the dates timeline", the palette leaves the command out, the bottom slot shows nothing and a timeline left open closes. Video keeps the footage timeline; two dates keep the dates strip. The timeline tests use neutral names (`75b0ed659`).
- Checks: unit suites green; pile-panel 9, sections 2, linked-hover 6, project-list-groups 6, profile-chart 2, small-window 11, volumes-tab 5, volumes-general 2, volume-over-time 2, stockpile-date 2, volumetric-build 1 and stage-display 1 green the CI way; the two new e2e were red before the fixes. No contract or pack change.

## Why

Founder reports: Open larger left a second section view behind after closing, the pile panel would not scroll from its middle, and the Timeline tile opened an empty footage timeline in a photo-only project. The founder chose a greyed tile with a tip for the last.

## How to test

1. Quarry demo, click a pile, Profile, Open larger, then close the window: nothing stays open.
2. Project tab, In this project, Measurements, open a pile: the wheel over the middle of the panel scrolls it, also in a 1100 x 720 window.
3. A project with no video and one survey date: View on the island, the Timeline tile is greyed with the tip; the command palette has no timeline command.
4. A project with two survey dates: the Timeline tile shows the dates strip.

## Open threads

- The Volumes tab scroll was checked by reading the code only.

## Next session entry point

Hand `fix/section-window-scroll` (this PR) to the merge coordinator.
