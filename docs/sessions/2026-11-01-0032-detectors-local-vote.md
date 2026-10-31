---
type: session
date: 2026-11-01-0032
branch: fix/detectors-local-vote
status: complete
related: [sessions/2026-10-31-1555-multiview-thermal.md]
---

# Local detector spec follows the multi-view vote

## What changed

- `apps/desktop/e2e/detectors-local.spec.ts` failed after the multi-view vote landed: it expected the large box's confidence 0.95 in the pass file and "95%" in the review queue, and got 0.8075 and "81%".
- This PR updates the spec, not the product. A named constant (`VOTED_HIGH`) with a comment gives the voted score, and the spec now checks each large box's `vote`: `views` 1, `seenBy` 2, `singleView`, `score` 0.95, `placedOn` mesh. The spec also prints the e2e window line now, so a run shows it ran at the CI size.

## Why

- The fake model answers the same pixel box for every photo. On the change demo mesh, p01's large box and p02's large box land on two spots about 50 m apart, so the two boxes do not agree in 3D.
- The detector ran on both photos: both have staged results, so both are in the run's `looked` set and in the pass's `assessed`. Each spot lies inside both frames and is not hidden behind the mesh. So each spot has one view out of two photos that see it, and the vote marks it down to 0.95 x (0.7 + 0.3 x 1 / 2) = 0.8075. This is the designed behaviour: `seenBy` counts only photos the run looked at, and no stand-in, fake-server path or photo outside the run is counted.
- The voted score still clears the detector's 0.8 threshold, so the counts in the spec (two drafts above the bar, "1 of 2" at a 0.7 slider) are unchanged. The small boxes keep 0.6: one is seen only by its own photo, the other is not placed.

## Checks

- Only `detect.vlm` and `thermal.hotspots` run the vote, and no other e2e spec runs either. The specs that read detection confidence were run the CI way (1100 x 720, scale 1, WARP, `--workers=1`): `detectors-local` and `detections` (4 passed), and `inspect`, `inspection`, `findings-on-model`, `classes` (12 passed).

## How to test

Nothing is user-facing: this PR changes one end to end spec.
