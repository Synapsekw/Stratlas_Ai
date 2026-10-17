---
type: session
date: 2026-10-17-1117
branch: fix/telecom-azimuth-picks
status: complete
related: [2026-10-16-1752-telecom-measurements.md]
---

# Telecom azimuth from edge picks

## What changed

- `antennaAzimuth` (`packages/survey/src/tools/telecom.ts`) takes the face as upright: three picks along a level top or bottom edge give the bearing as the perpendicular to their principal direction in plan (2 x 2 PCA), instead of the horizontal part of a cross product set by millimetres of height noise.
- The side still follows the winding `(b - a) x (c - a)`, so saved measurements keep their facing and Flip turns 180 degrees for every pick pattern; exactly collinear level picks use the right of b to c (flipFace reverses it).
- Picks spanning 25 cm or more of height in a well-shaped triangle keep the plane through them (classic triangles unchanged, exact on tilted faces); level picks spread widely in plan are rejected as horizontal; picks under 3 cm apart in plan ask the user to spread them along the face.
- Tests: noisy edge picks within 0.3 degrees over 50 seeds, classic triangle equal to the old method, flip, tilted face, stacked picks, large grid coordinates. Two old "rejects" cases (picks on a sloped straight line) are now valid edge picks.
- Landed as #163 (`30e5cd65`) under the merge lock lent by the UI rework session; the lock went back to it.

## Why

On a real site three picks along the top edge of a face gave bearings 1 to 3 degrees off, as only a small part of the normal was horizontal. On the six saved measurements the new bearings are closer to an independent point-cloud face fit on all six (0.4 to 0.9 degrees on four); two stay 1.6 and 2.2 degrees off because the clicks themselves lie off the face trace.

## How to test

1. Open a telecom project, Measure, Azimuth.
2. Pick three points in a line along an antenna's top edge: the arrow faces straight out of the face; the readout says grid north.
3. Clear and re-pick the same edge with slightly different clicks: the bearing stays within a few tenths of a degree.
4. Press Flip: the bearing changes by exactly 180 degrees.
5. Reopen a saved azimuth: same facing, corrected bearing.

## Open threads

- The pick hint in `TelecomTools.tsx` still says "spread across the antenna front face"; "along its top or bottom edge" waits for the UI rework.
- The publish script's CI check passed vacuously: Windows PowerShell 5.1 split a `gh --jq` filter with embedded quotes and the empty result read as green. CI was green anyway (attempt 2). Future scripts parse JSON with `ConvertFrom-Json` and refuse on a failed or empty check list.
- `panels.spec.ts:405` "a click anywhere on the 3D view goes to the view" failed once on #163 CI (shard 2/6, right-edge hits) and passed on a failed-job rerun.

## Next session entry point

Nothing in flight from this block; the UI rework session holds the merge lock for stage 1.
