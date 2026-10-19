---
type: session
date: 2026-10-18-2345
branch: feat/ppe-360-detection
status: complete
related:
  - docs/plans/2026-10-18-local-detection-on-360-video.md
---

# Local detection on 360 video frames

## What changed

- This PR runs local ONNX detectors on 360 video (walk) frames, on the whole equirect frame (the model was trained on flat equirect frames, so no cube faces): one frame every N s or the current frame, optional tiles that wrap the seam, and a seam merge into wrapping boxes (x1 past the frame width). The drafts land in the review; the 360 viewer draws the boxes, and hides them with a note while the levelled copy plays.
- Detection boxes are clearer everywhere: class colours, a halo and label chips.
- Frame decode is faster (`-threads 2`, byte-identical frames, a test checks it).
- **Founder decision, 2026-10-18 (the founder's, not the session's):** the licence gate is relaxed for internal use. Copyleft, non-commercial and unknown licences import with a warning chip and note; a missing licence is still refused. The pack segmentation model (SAM) still refuses warned licences: an open question for the founder. Contract row in `docs/architecture/contract-changes.md`.
- Proof on a real 360 test video (4096 x 2048, 191.6 s): 192 frames at 1 s on DirectML, 593 drafts; at exact times 17 of 18 boxes match the Ultralytics reference (mean IoU 0.85 to 0.97). On the founder's real project, 3 walks: 253 frames in 131 s (about 516 ms a frame), 94 drafts, and only the new pass files were written. The model and video stay out of git; test fixtures are synthetic.

## Review fixes

The PR review found two important issues and nine minor ones.

- **I1 fixed:** a walk run where every frame decode failed read as a clean "N of N frames checked, 0 found". Frames that cannot be read are now counted as skipped, with the first reason, in the progress and the result (optional `skipped` and `reason` on `inference:run` and its progress, contract row added); a run where none could be read fails and writes no pass; ffmpeg is checked once before the first frame.
- **I2 fixed:** in the review, a click picks the smallest box under the pointer, so a helmet inside a selected person box can be clicked. The selected box still paints on top.
- **M1:** the seam merge margin is max(6 decoded px, 1 % of the width), so halves that stop a few pixels short of the seam still merge.
- **M2:** a frame box that rounding moved onto the frame width is folded back.
- **M3:** the 360 overlay shows only the nearest sampled frame, and nothing when that frame found nothing.
- **M5:** cloud Detect with AI leaves 360 walk frames out; only the local model reads walks.
- **M6:** Stop kills the running ffmpeg decode.
- **M7:** ffmpeg is looked up once per run, not per frame.
- **Known limits, accepted:** M4, the overlay is hidden while Level horizon is on (the viewer says so); M8, with tiles on an 8K copy a frame peaks at several hundred MB (sequential, so bounded); M9, the frame tests skip locally without ffmpeg (CI has ffmpeg).

## Why

The founder wanted the PPE detector run over 360 walks, with the drafts reviewed like any other detection.

## How to test

1. Settings > AI providers > Detection models > Import model, with the folder holding `model.onnx` and `model.json`. The card shows an "AGPL-3.0 · internal use" chip.
2. Open a project with a 360 video.
3. Detections > Detect with AI > Local model > 360 video frames, pick the video, one frame every 1 s, Run.
4. Review the drafts: the tiles are named "<walk> <t> s".
5. Scene: open the walk in the 360 viewer and play or scrub. The boxes follow the view; Show detections toggles them.

## Open threads

- One streaming ffmpeg per walk for interval runs (an fps filter piping frames instead of a seek per frame): 5 to 7 times faster decode, measured.
- Check onnxruntime `allow_spinning=0`.
- Local detection on ordinary video clips (same decode path).
- Wrapping boxes cannot be resized in the review editor (`clampGeom`).
- The Scene "Streets" basemap picker overlaps the 360 pane in split view (cosmetic, probably older).
- The "No adapter for walk layers yet" renderer warning.
- The camera operator close to the lens comes out as large distorted boxes.
- Founder: should SAM accept warned licences too?

## Next session entry point

The streaming decode for interval runs, then detection on ordinary video clips.
