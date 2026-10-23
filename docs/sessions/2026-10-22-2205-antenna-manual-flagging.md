---
type: session
date: 2026-10-22-2205
branch: feat/antenna-flagging
status: complete
related:
  - superpowers/specs/2026-10-22-antenna-manual-flagging-design.md
  - superpowers/plans/2026-10-22-antenna-manual-flagging.md
---

# Antenna manual flagging and typed values

## What changed

- This PR builds the 22 Oct spec: a Flag antenna tool outlines a unit the detection missed on the cloud, and the new `telecom.flag` job measures it from the points inside into the inventory as an accepted unit marked "Flagged by you" (pipeline pack 0.24.0).
- The antenna card takes typed values (azimuth in the north the card shows, downtilt, centre elevation, sizes) with Reset to measured, a kind picker, Redraw outline and Delete for flagged units. Re-runs of Detect antennas keep flagged units and typed values.
- Not-measured and flagged units read correctly everywhere sizes are read (bench, CSV with the basis of every size and the centre elevation, RF).
- Detection and flagging cannot run at the same time; the flag commit refuses if a new detection run replaced the inventory meanwhile. An unreadable inventory blocks a re-detect on a pack older than 0.24.0.
- Contract row of 22 Oct in `architecture/contract-changes.md`; known limits and guide page 45 updated.

## Why

Detection misses small radios and units hidden behind mounts; until now a person could not add them or correct a measured value, so the inventory and RF coverage were incomplete.

## How to test

1. Open a project with a tower cloud, go to Telecom and run Detect antennas.
2. Turn the view to a unit the detection missed and click Flag antenna.
3. Click around the unit and press Enter: the points near the camera inside the outline light up orange.
4. Click Measure: the unit appears accepted with "Flagged by you".
5. On its card open Your values, type an azimuth and press Enter: the box turns.
6. Click Reset to measured: the measured value comes back.
7. Run Detect antennas again: the flagged unit is still there once, with your value.

## Open threads

- A missed radio on a dense cloud (about 1500 points per m2) can come out Not measured; lowering the face minimum for person outlines is a follow-up.
- Delete on a flagged unit has no confirmation or undo (founder decision). Its photo crop stays in `telecom/crops/`, as no project-file delete channel exists.
- Pack is 0.24.0: local VLM detectors merge 2 (#219) took 0.23.0 first, so this branch moved to the next minor at merge.
- Flagging, like detection, applies only the line-up shift, not a line-up turn, and the job does not repeat the nearest-surface cut (`KNOWN-LIMITS.md`).
- `check-public-text` flags a site name already on `main` in `en.ts` and `jobs.ts`; not touched here.

## Next session entry point

Merge this PR under the merge lock, then the engineering model typed corrections branch; the founder tries the steps above in the 0.25.0 build.
