---
type: session
date: 2026-10-19-0223
branch: feat/line-up-similarity
status: complete
related:
  [
    superpowers/specs/2026-10-18-line-up-similarity-design.md,
    superpowers/plans/2026-10-18-line-up-similarity.md,
  ]
---

# Line up dates with a turn and a scale

## What changed

- **What a line-up stores.** A line-up is now a shift plus a small turn and scale about a pivot in the project CRS. It is saved as `lineUpTurn` next to the unchanged `lineUp`, so older builds still open the project, apply the shift alone, and drop the turn when they save.
- **Measuring.** `change.lineup` fits the turn and scale robustly to the tile shifts and writes `lineup-fit.json` next to the unchanged `lineup.json`.
  - A plain shift fits no turn.
  - One measurement refuses beyond 1 degree or 1 % (`range`).
- **Where the turn applies.** Every view and job that went through the shared shift helpers now turns as well: map, 3D, measurements, volumes, pins, RF, extents and exports. The Python change, survey, 3D Tiles, inspection and engineer readers turn too.
  - The point-cloud viewer and directions do not turn yet; that is stage 2 (`docs/KNOWN-LIMITS.md`).
  - Point-cloud change refuses a turned pair.
- **The dialog** shows "turned ..., scaled ...", the move at the centre and at the edges. Undo restores the turn together with the shift.
- **The Compare view row** (Side by side, Swipe, Blend) has a line-up chip: "X m off" with Line up, "Lined up", or "Can't line up". It always measures the pair as it stands.
- **Fixes found on real data:**
  - The line-up preview, the background pairing and the partner pick now read kit-pyramid corners from `tiles.json`.
  - Dates that share a label show their date.
  - A saved line-up clears its stale offer.

## Why

Two GPS-only surveys of one site were refused with "parts of them point to different shifts". The tile shifts fit a 0.1 degree turn and a 0.2 to 0.35 % scale to within a third of a pixel, so a sideways move alone could never line them up. The founder chose the full similarity over a looser tolerance.

## How to test

1. Open a project with two survey dates flown without ground control, then Compare dates on two maps. The chip next to Swipe shows "Checking line-up..." and then "X m off".
2. Press Line up on the chip. The earlier date is kept. The dialog shows the shift, "turned ..., scaled ..." and a Before/After preview.
3. Press Line up. The chip re-measures to "Lined up", and in Swipe the edges at a corner of the site run straight across the divider.
4. Show changes, then Run imagery change for the pair. It runs, with no "dates are X m apart" bar.

## Open threads

- Stage 2: point clouds turn in the viewer, 3D Tiles and point-cloud change; directions (photo orientations, panorama headings, video path, antenna and RF azimuths) turn.
- The note for a vector pair skipped in a project without a coordinate system is not shown in the app.
- Rulings and deferred minors are in the plan's review ledger (not committed). The main ones are listed in this PR's description.

## Next session entry point

Hand-off of this PR in the batch train. Then stage 2, starting with point clouds in the viewer.
