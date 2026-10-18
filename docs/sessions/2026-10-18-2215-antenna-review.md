---
type: session
date: 2026-10-18-2215
branch: feat/antenna-review
status: complete
related:
  [
    superpowers/specs/2026-10-18-antenna-review-design.md,
    superpowers/plans/2026-10-18-antenna-review.md,
  ]
---

# Antenna review: lean list and floating card

## What changed

- The Antenna inventory is a lean list. It has filter tabs (To review, Accepted, Rejected, All), Hide all and Show all, and an eye and a "show only this group" button per group. The row menu and the details block at the bottom are gone.
- A floating card beside the selected box shows the photo crop, azimuth, downtilt, plumb, size, altitude and points, with how each value was measured. Accept and Reject (A, R) move to the next unit in the filter. The arrows step through the list in panel order, and Esc closes the card.
- One-by-one walk: the selected antenna is always drawn, so after Hide all you see one unit at a time, and the camera frames each one. The selected box is drawn on top of the cloud and the GLB, with name, width, height, depth, azimuth and tilt labels. The card stays clear of these labels.
- Every other unit shows a small numbered pin, and clicking a pin selects that unit. A Labels control (Off, Selected, All) sits at the top-left of the 3D view.
- `openAntennaReview()` in `antennaStore` lets the RF workbench open the review on the first draft. The shared `workspace/flyToBox.ts` frames a local box.

## Why

Reviewing a real tower meant switching groups off one row at a time, opening a menu to accept, and scrolling to the bottom for azimuth and the photo. The founder approved option C (list plus floating card) from mockups on real data.

## How to test

1. Open a project with a detected tower, then the Measure bench, Antenna inventory. Nothing is selected and the filter is To review.
2. Press Hide all, then click the first row: only that antenna is drawn, the camera frames it and the card shows beside it.
3. Press A: it is accepted, the card moves to the next draft and the To review count drops. Press the right arrow to step to the next one.
4. Hide the point cloud and show the mesh model: the box and labels stay readable on the GLB.
5. Show all, then click a numbered pin: the card switches to that antenna. Set Labels to Off: the pins go away.

## Open threads

- The side-on dish's dimension labels can overlap, and its angle label can run off the stage. This needs an overlap pass for dimension labels.
- While an antenna is selected, the card takes the stage's A key (annotate).
- Deferred minors and every ruling are in the plan's review ledger (not committed). The main ones are listed in this PR's description.

## Next session entry point

Hand-off of this PR in the batch train, then the dimension-label overlap pass if the founder wants it.
