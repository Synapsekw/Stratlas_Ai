---
type: session
date: 2026-10-27-2137
branch: feat/antenna-box-handles
status: complete
related:
  - superpowers/specs/2026-10-27-antenna-box-handles-design.md
  - superpowers/plans/2026-10-27-antenna-box-handles.md
---

# Drag handles resize a detected antenna box

## What changed

- This PR puts six face arrows on the antenna box selected in 3D (founder pick A of three, from an in-app spike). Dragging one moves only that face, the opposite face stays put, and a chip such as "H Height 2.65 m" follows the cursor; Escape cancels.
- On release the existing `telecom.flag` job measures the unit again from the points inside the box (a box crop fits its selection input as is), and the unit becomes flagged so re-runs keep it. If the re-measure comes back more than 2 cm smaller on the dragged axis, the dragged size is kept as entered by you; too few points keeps the dragged box with its old angles.
- No handles on dishes, in read-only packages or while a detection, flag or redraw runs. The W/H/D labels move off the face centres and hide during a drag. No contract or pack change.
- Guide page 45 covers the handles and now describes the Project tab's Antennas group and Delete on every unit; one line in `KNOWN-LIMITS.md` (a resize cannot be undone).
- Checks: `pnpm check` green; e2e the CI way: new `antenna-box-handles` 3/3 with repeat-each 3, `telecom-antennas` and `project-list-antennas` 9/9, `telecom-antenna-flag` 1/1, `project-list-groups` 6/6. An independent review's 12 findings are fixed.

## Why

Detection sometimes draws a box that covers only part of a panel; the founder wanted to pull its faces out by hand rather than redraw or type sizes.

## How to test

1. Open a telecom project with antennas, go to 3D and click a panel antenna's box: six small arrows appear, hover makes one bigger.
2. Drag the top arrow up: only the top face moves and a "H Height" chip follows the cursor. Press Escape: the box snaps back.
3. Drag again and let go: a Resize toast shows while it measures; the row in the Project tab's Antennas group shows the new height and the unit is flagged.
4. Drag a face past the antenna's points and let go: the size is kept as entered by you; Reset to measured brings the measured one back.
5. Drag a box into empty space: the toast says too few points and the box stays as drawn.
6. Run Detect antennas again: the resized unit keeps its size. A dish has no arrows; the arrows go during a detection.

## Open threads

- Calls to confirm with the founder: the 2 cm rule for keeping the dragged size, no undo for a resize, drags under 5 mm start nothing.
- On a narrow panel the idle width label touches the top arrow; in a narrow 3D view the drag chip can run into the basemap control.

## Next session entry point

The merge coordinator lands this branch on local `main`; the founder tries the steps above with `pnpm dev`.
