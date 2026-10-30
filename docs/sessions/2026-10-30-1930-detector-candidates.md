---
type: session
date: 2026-10-30-1930
branch: fix/detector-candidates
status: complete
related: [../plans/2026-10-30-detector-candidates.md, ../plans/2026-10-30-intelligence-review.md]
---

# Detector candidates: a cap, a fairer merge, tiles sized from GSD

## What changed

- This PR caps `detect.vlm` at 30 candidates per tile reply and per photo, the custom-analytics value. The detect prompt now says "Report at most 30 areas, the clearest first." The photo cap is applied before the yes/no checks, which cost one model call per candidate, so one bad reply can no longer cost minutes per photo. Candidates are taken round robin across the tiles in the model's own order, starting at a different tile for each photo.
- A capped photo result adds a job warning, is staged with `capped`, and is counted in the detect and commit step outputs (`capped`). The detections file does not change.
- The merge rule no longer keeps the largest box. Overlap copies are dropped by IoU before scoring, and so is a piece cut off at an inner tile edge that lies mostly inside a larger box, so it cannot outscore the box that sees the whole object. After scoring, non-maximum suppression keeps the higher-scored box, or the smaller one on a tie, when two boxes overlap (IoU 0.5) or one is mostly inside the other (0.6 of the smaller). A precise small box inside a loose large one now survives when it scores higher. The candidates come out highest score first.
- Detectors may carry `objectSizeM`. For a near-nadir photo with a known GSD, the job picks the smallest tile count (1 to 4) that shows the object at 64 sent pixels or more, never enlarging tiles past the photo's own pixels. The detector bench now uses the same tile choice. Near-nadir means a 35 mm focal length, a relative altitude and a gimbal pitch of -60° or steeper; the metadata is read only when a detector of the run has a size. Any other photo, or a detector without the size, keeps its own `tiles.n`. The shipped corrosion detector has no size: corrosion has no typical size, and no bench backs one yet.
- `VlmDetector.objectSizeM?` is added to `@aio/schema`, with a contract row. Pipeline pack 0.28.0, and `DETECT_MIN_PACK` is now 0.28.0, because pack 0.27.0 refuses the new key.

## Why

Vision audit items 3.1, 3.7 and 3.8 (intelligence review, 30 Oct). Qwen3.5 returns 3 to 10 times more boxes on the old prompt, and each box costs a yes/no call. The old merge dropped the precise defect box inside a loose one. A fixed 2 x 2 grid ignores how big the object is in the photo.

## How to test

1. Install pipeline pack 0.28.0 (Settings > Processing tools > Choose file). Detectors on an older pack show the update message.
2. In Inspect, run the corrosion detector on a few photos. Drafts appear as before. In the job log, a photo with more than 30 candidates shows "more than 30 candidates; kept 30 (the first answers of each tile)".
3. Where a small rust spot sits inside a larger rust patch, the higher-scored of the two boxes stays as a draft. On a tie, the smaller one stays.
4. Optional: add `"objectSizeM": 0.5` to a project detector's `detector.json` and run it on nadir mapping photos. The job sends more tiles for a small size and one tile for a large size. Oblique photos keep the detector's tiles.

## Open threads

- No real-model run was made in this PR: all tests use a fake server. The cap, the merge and the tile choice need a `tools/detectors` bench run on the shipped model.
- No UI sets `objectSizeM` yet (decided): it is set by hand in `detector.json` until the editor field comes with the Models and detection page (UI revision Wave 2).
- GSD uses height above take-off, not height above the ground under the photo. Photos over sloped ground or tall structures get an approximate GSD.

## Next session entry point

Bench corrosion on Qwen3.5 with the cap and the new merge (roadmap item 3.2), and try `objectSizeM` on a small-object detector.
