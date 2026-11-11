---
type: session
date: 2026-11-12-0041
branch: feat/walk-detections
status: complete
related: [../plans/2026-11-11-walk-detections.md, ../plans/2026-10-30-intelligence-review.md]
---

# 360 walk detections tracked and placed, change region labels

## What changed

- This PR builds Wave 3 row V4 of the intelligence review (vision study items 3.9 and 3.16).
- **One draft per object on a walk.** A new job `walk.track` (`python/src/aio_pipelines/inspection/walkjob.py`, `walktrack.py`) turns each walk frame box into a direction through the walk pose (`walks/<id>/pose.json`). Drafts of one class in neighbouring sampled frames join a track when they point within max(6°, 0.6 x box size) of each other, are within a factor of 2 in size, and have at most 2 missing frames. The best-scored member leads; the others become `track.sightings`.
  - The track is placed on the project's meshes, else its point clouds (the `multiview` surfaces), else where the members' rays cross, else on the walk's ground.
  - It carries `bearingDeg` and `rangeM` from the lead frame.
  - Reviewed detections are never changed. A re-run expands earlier tracks and tracks again, and the job writes nothing when tracking changes nothing.
  - The app starts `walk.track` quietly after every local model run over walk frames.
- **Photo detectors on walks.** `detect.vlm` takes `frames` (one walk per run, never mixed with photos). It cuts each frame into four 100° perspective faces (`inspection/equirect.py`), runs the detectors on the faces and maps the boxes back to the frame (a box across the seam wraps). Boxes of overlapping faces merge, and the frame drafts are tracked when the run commits. Ask AI now sends walk frames to the local detectors when the local model cannot answer, and never to the cloud.
- **Review.**
  - The review queue and Inspect show "Seen in N frames", and "N m away, bearing N°" once the object is placed (`inspect/TrackChip.tsx`).
  - The 360 view draws a tracked draft at each of its frames.
  - The annotate model carries `track` through a review the way it carries `vote`.
- **Change labels.** "Label with AI" on a picked change region row (`renderer/change/RegionLabel.tsx`, `labelChange.ts`, and `packages/ai/src/changeLabels.ts`) crops the same window from both dates' orthos, outlines the region and sends the pair through the `ai:ask` Compare route with one choice field: material added, material removed, earthworks, vehicle, equipment, structure, vegetation, water, no real change or other.
  - The answer is stored on the region as `aiLabel`, and the row shows "AI: <kind>".
  - A project that keeps its images local uses the local model.
  - A change recompute keeps each region's label (`changeset.merge_reviews`).
  - `packages/change` only gained an `itemTools` slot and the chip.
- Contract rows for `Detection.track`, `walk.track`, `DetectVlmParams.frames` and `RegionChange.aiLabel`. Pipeline pack 0.35.0 (this PR's last commit).
- Decisions made by the session:
  - Confidence stays the lead's own score: frames of one walk are not independent views.
  - Up and down faces are left out (the walker and the sky).
  - The local ONNX model keeps reading whole equirect frames.
  - A one-frame track is left unchanged.
  - Label with AI is one click per region. On the cloud route it shows the same confirm box as Ask AI (both crops, provider and cost, "Don't ask again for this project"), and the button's tip names who answers: the cloud provider or this computer's model. A local-only project never sends the crops out.

## Why

The vision study found that 360 frame detections were never placed and gave a box per frame, so one person in a walk was ten drafts to review. It also found that change regions said how much changed but not what.

## How to test

1. Install pipeline pack 0.35.0 (Settings > Processing tools > Choose file). The list shows "Detectors on 360 walks" and "Walk detections tracked and placed". (Unit tests `walkTrackPack.test.ts`, `detectPack.test.ts`, `jobsStart.test.ts`.)
2. Open a project with a placed 360 walk. In Inspect > Ask AI, choose Frames, the walk and one frame every 1 s, then Run with the local model. The run ends with "AI checked N frames and found M". An object that stays in view for several frames is one suggestion. (`detect-walk.spec.ts`, second test: a marker over 4 frames becomes one draft.)
3. Review it. The queue shows "1 waiting", "Seen in 4 frames" and "N m away, bearing N°". (Same spec.)
4. Open the walk in the 360 pane and scrub through the frames where the object was seen. Its box is drawn at each of them and is gone after the last. (Same spec.)
5. With a detector in the library and a walk, run Ask AI on the walk's frames with a detector check. The detectors read each frame as four views, and repeated finds come back as one tracked suggestion. (Python run: the `detect.vlm` frame cases in `python/tests/test_detect_pipeline.py`, real ffmpeg with the fake model server. No e2e yet.)
6. Open the change demo with an imagery change between two dates (Compare dates finds them, `change-area.spec.ts`; the label spec writes the region set itself), and open the Changes tab. Pick a region row and click **Label with AI**. With cloud AI the confirm box shows both crops and the provider; click Send. The row shows "AI: Material added" (the scripted model's answer; a real model names what it sees), and the label is still there after a reload. (`change-label.spec.ts`.)

## Evidence

- `pnpm check` was green before the pack commit (lint, prettier, tsc -b, 17714 tests). The full pytest suite passed: 2926 passed, 59 skipped.
- E2e the CI way (1100 x 720, scale 1, WARP, `--workers=1`, change demo built):
  - `detect-walk` 2/2, `walk-360` 4/4, `detectors-local` 3/3, `detections` 1/1, `detect-local` 2/2;
  - `change-label` 1/1, `change-area` 2/2, `custom-analytics` 6/6.

## Open threads

- The 6° joining limit needs about 2 frames a second for a small object a few metres from someone walking at 1 m/s. At one frame every 1 s such an object can split into two tracks. The limit could grow with the distance walked between frames.
- The walk pose is used as written. A walk on a survey date with a line-up shift is not shifted again; check this on a lined-up project.
- A tracked draft is not yet an issue on the map or the model: Accept makes an issue as before, and the `inspection.run` placement still skips frame detections. Using `track.point` there is the next step.
- A re-run's expanded sightings take the lead's note and fields.
- An older build reads a tracked walk pass but drops `track` when it saves it: the folded sightings are lost and the lead draft stays on its own frame. Review a tracked walk in this build or later.
- The sha guard leaves a short gap between the re-read and the rename of a pass. A lock shared with the app's `detections:write` was not built: the pipeline's manifest lock is an operating-system byte-range lock (msvcrt, fcntl) that Node cannot take without a native addon or a new lock scheme on both sides. The app keeps a walk run "running" until its tracking ends, so Review does not open on the untracked drafts, and re-tracking never drafts an object that already has an accepted or rejected detection.
- No e2e for detectors on walk frames (the Analytics pack model is not in CI).
- Label with AI labels one region at a time, with no "Label all".
- Bench the tracker on a real walk (the 360 test video from 18 Oct) before tuning.

## Next session entry point

Place accepted tracked walk drafts as issues through `track.point` in `inspection.run`, then bench the tracker on a real walk.
