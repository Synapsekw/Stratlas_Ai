# Antenna box handles: design

Date: 27 Oct 2026. Branch `feat/antenna-box-handles`. Founder pick from the in-app spike (commit
5453f550b): look A, face arrows.

## Problem

Detection sometimes draws an antenna box too small, for example over only the lower half of a
panel. Today the only fix is **Redraw outline** (draw a new polygon round the unit). A box that is
nearly right only needs one face pulled out.

## What the founder decided

1. Handles show as soon as an antenna is selected in 3D. No separate edit mode.
2. Look A: a small, screen-size-constant cone arrow at the centre of each of the six faces,
   pointing out. Hover enlarges it; the dragged arrow grows and turns accent; a chip such as
   "H Height 1.66 m" follows the cursor while dragging. Arrows on the far side are dimmed but can
   be grabbed. State is never shown by colour alone (size and the chip carry it too); colours come
   from the design tokens.
3. Dragging moves only that face; the opposite face stays where it is.
4. On release the unit is measured again from the points inside the new box (as Redraw outline
   does), which can also correct its direction and tilt.

## Calls made, to confirm

- **Faces after the re-measure.** The face you dragged stays where you let go and the opposite
  face stays put; the re-measure may correct the angles and the other two sizes. When the
  re-measure gives the dragged size back smaller than you dragged it (more than 2 cm smaller,
  sparse points), the dragged size wins: it is stored as an "Entered by you" value with the
  measured one kept, so **Reset to measured** still works, and the box is placed so the fixed face
  stays where it was along the new axis. A dimension you had typed before and then dragged is your
  value again (the dragged one).
- **Too few points.** When the box holds too few points to measure, the dragged box and the earlier
  angles and values are kept, the dragged size becomes "Entered by you" (only when the unit had a
  value for it), and a toast says so. A unit that was never measured stays "Not measured": no
  numbers are made up, only its box changes.
- **Flagged.** A unit redrawn by a drag becomes a flagged unit, as Redraw outline does, so a re-run
  of Detect antennas keeps it. Name, status, notes and typed values are kept.
- **Where handles do not show.** Dishes (they have a diameter, not width, height and depth), a
  read-only package, while detection or a flag job runs, while the Flag or Redraw outline tool is
  on. The selected unit is always drawn, so a hidden unit that is selected has them too.
- **One drag, one job.** Antennas have no Undo today (review edits are journaled, not undoable). A
  drag is one `telecom.flag` job plus, at most, one follow-up save of the settled values. Escape
  while dragging puts the box back and starts nothing; a release where the face did not move
  starts nothing.
- **Minimum size** 0.05 m on the dragged dimension, no maximum beyond the typed-value limit of
  10 m.
- **Value labels.** The W, H and D value labels used to sit on the middle of their dimension lines,
  where the face arrows now are. They move to a fifth of the way along their lines (W towards the
  left top, H towards the bottom, D towards the back), clear of every face centre, and hide while a
  face is dragged: the chip carries the value then.

## How the re-measure reuses `telecom.flag` (no contract change, no pack bump)

`telecom.flag` with `redraw: true` takes a selection `{polygon, viewProj, bounds, anchor}`: points
inside the axis-aligned `bounds` (stage local) whose `viewProj` projection falls inside the
polygon (NDC) are measured. A 3D box crop fits that input without any change:

- `viewProj` is an affine (w = 1) map from stage local to the box's own coordinates: clip x is the
  offset along one box axis over its padded half size, clip y the same for a second axis. The
  polygon is the square `[-1, 1]^2`. That cuts an exact prism along the third box axis.
- The third axis is the box axis closest to a world axis (for a panel, its height axis, a few
  degrees off vertical at most). `bounds` is the axis-aligned bounds of the padded box corners, so
  along that axis it cuts within a few centimetres of the true faces.
- The box is padded by 3 cm on every side so the points on the faces are inside.
- `anchor` is the box centre.

So the Python job, the IPC contract and the pipeline pack are unchanged. `TelecomFlagParams` is
used as it is.

## Parts

- `telecom/antennaBoxEdit.ts` (pure): the faces, `resizeBox` (one face moves, opposite fixed, min
  clamp, in the box's own rotated frame), `extentFromRay` (where the pointer ray meets the face's
  normal line), `boxCropSelection` (the flag selection for a box), `settleBoxEdit` (the unit to
  save after the re-measure, or null).
- `telecom/antennaHandles.ts`: the SVG overlay of look A over the canvas, its pointer handling and
  the chip; reads and writes the drag through the store.
- `telecom/antennaStore.ts`: `boxEdit` state (the unit before, the face, the dragged box, the phase
  `drag` or `measure`), `beginBoxDrag`, `dragBox`, `cancelBoxDrag`, `commitBoxDrag`, the settle
  step in `afterFlag`, a toast while measuring and when done.
- `telecom/AntennaRunner.tsx`: draws the dragged box (the store's file with the dragged unit put in)
  and its labels, hides the value labels while dragging, mounts the handles.
- `telecom/antennaMeasure.ts`: value labels off the face centres.
- The spike (`antennaHandleSpike.ts`, its spec, Ctrl+Alt+H, looks B and C, `window.__antennaHandles`)
  is removed.
