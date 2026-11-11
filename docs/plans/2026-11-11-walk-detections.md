# V4: 360 detections placed and tracked, change region labels (11 Nov 2026)

Roadmap: `plans/2026-10-30-intelligence-review.md`, Wave 3 row V4. Study: `design/intelligence-review-2026-10/vision.md` items 3.9 and 3.16. Built autonomously (founder go, 11 Nov); every call below was made by the build session.

## Goal

1. Detections on 360 walk frames become one draft per object, placed in the project from the walk pose, and the photo detectors (`detect.vlm`) can read walk frames through perspective faces.
2. A change region can be labelled (what changed) by sending its before and after crops through the existing Compare route (`ai:ask`, kind `change`).

## Decisions (made by the session)

- **Two detector paths on walks.** The local ONNX model keeps reading the whole equirect frame (it was trained on equirect frames, 18 Oct). The VLM detectors (`detect.vlm`) read four perspective faces per frame (yaw 0, 90, 180, 270, 100 degree field of view, 1024 px, 10 degrees of overlap); face boxes map back to frame boxes by sampling their edges, and boxes of overlapping faces merge (IoU 0.4, the higher score wins). Up and down faces are left out: the walker's feet and the sky.
- **Tracking in the walk's frame, not in pixels.** A box centre becomes a direction turned by the walk pose (`walks/<id>/pose.json`); without a pose (walk not placed) the camera frame is used. Drafts of one class in neighbouring sampled frames join a track when their directions are within max(6 degrees, 0.6 x box size) (grown with the square root of the frames skipped), their sizes within a factor of 2, and at most 2 sampled frames are missing. Greedy, best match first.
- **One draft per track.** The lead is the best-scored member (then the largest box); the others become `track.sightings` (cap 200). Confidence stays the lead's own score: frames of one walk are not independent views, so the multi-view noisy-or would overstate them. A one-frame track is kept unchanged (no `track`).
- **Placing.** In order: the project's meshes, else its point clouds (`multiview.scene` surfaces, the median hit of the members' centre rays); else crossing rays (least squares point of all member rays, needs 0.5 m of baseline, 2 degrees of ray spread, every ray in front, a residual under max(0.5 m, 10 % of the range), range under 100 m); else the ground under the walk (box bottom ray against the walk's ground, pose height minus `heightM`), when the ray looks down. `bearingDeg` (compass, from north) and `rangeM` are from the lead frame's walk position. A walk without a pose gets a track but no point.
- **Re-runs.** The job expands an earlier track's sightings back into drafts and tracks again, so a resumed or extended walk run gives one draft per object. Reviewed detections (accepted, rejected) are never changed or merged.
- **Pass safety.** The job commits only when the pass on disk is still the one it read (sha256); otherwise it tracks again from the new file.
- **Change labels.** One choice field `kind` (material added, material removed, earthworks, vehicle, equipment, structure, vegetation, water, no real change, other) plus `what`, on the Compare route with the whole image; the label is stored on the region as `aiLabel` with model and time; `aiPolicy: forbid` routes to the local model as for any ask. Code in its own module `packages/ai/src/changeLabels.ts`; the renderer glue in its own file; `packages/change` gets a one-line slot for the action only.

## Contract changes

- `Detection.track?` (`DetectionTrack`, strict): `frames`, `firstT`, `lastT`, `score?`, `point?`, `placedOn?` (`mesh`, `cloud`, `rays`, `ground`), `bearingDeg?`, `rangeM?`, `sightings?` (up to 200 `{ t, bbox, confidence?, id? }`, same space and size as the draft), `sightingsOmitted?`.
- New job `walk.track` (`WalkTrackParams`: `pass`, `layer?`), `WALK_TRACK_MIN_PACK` 0.35.0.
- `DetectVlmParams.frames?` (`{ layer, t }[]`, up to 2000), `DETECT_FRAMES_MIN_PACK` 0.35.0.
- `RegionChange.aiLabel?` (`{ kind, what?, model?, at }`).

## Tasks

| Task | What                                                                                                                                                                  | Tests                                                                                                    | Packages                                |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| P1   | `inspection/equirect.py`: pixel and direction maths, faces, face box to frame box, face merge                                                                         | `test_walk_equirect.py`                                                                                  | python                                  |
| P2   | `inspection/walktrack.py`: pose reader, tracker, placement; `inspection/walkjob.py`: job `walk.track`                                                                 | `test_walk_track.py` (tracker, placing on rays, ground, mesh; job rerun, reviewed untouched, hash guard) | python                                  |
| P3   | `detect.vlm` `frames`: decode frames (ffmpeg), faces, run, map back, merge, track at commit                                                                           | `test_detect_pipeline.py` frame cases with the fake VLM                                                  | python                                  |
| T1   | Schema `DetectionTrack`, `WalkTrackParams`, `DetectVlmParams.frames`, min-pack constants, job registry                                                                | schema tests                                                                                             | `@aio/schema`                           |
| T2   | Annotate carries `track`; Inspect chip "Seen in N frames"; 360 overlay draws a track at each sighting's frame                                                         | annotate, FindingsPanel, detOverlay tests                                                                | annotate, desktop renderer              |
| T3   | Main gate for `walk.track` and `detect.vlm` frames, Settings pack line; renderer starts `walk.track` after a local walk run; detectors run on walk frames from Ask AI | jobsStart, runPlan, runs tests                                                                           | desktop main and renderer               |
| L1   | `packages/ai/src/changeLabels.ts`: request builder and answer reader                                                                                                  | `changeLabels.test.ts`                                                                                   | `@aio/ai`                               |
| L2   | `RegionChange.aiLabel`; renderer glue (crops from both dates, `ai:ask`, save); "Label with AI" on a region row; label shown                                           | schema, glue and panel tests                                                                             | schema, desktop renderer, change (slot) |
| E1   | e2e: `detect-walk.spec.ts` extended (one draft per tracked object, "Seen in N frames"); change label spec with the scripted provider                                  | the specs, CI way                                                                                        | desktop e2e                             |
| F1   | Pack 0.35.0 notes, contract rows, session note                                                                                                                        | `pnpm check`, finish-task                                                                                | docs, python                            |

## Execution DAG

- Batch 1 (parallel, no shared files): P1+P2+P3 (one Python agent, P1 done first), T1+T2+T3 (one TypeScript agent), L1+L2 (one change-label agent).
- Batch 2: E1 (needs all of batch 1), then F1.
- Critical path: P2 -> T3 -> E1 -> F1.

## e2e specs

- Changed: `detect-walk.spec.ts`. Added: a change-label case (in `custom-analytics.spec.ts` or its own spec). Also run: `walk-360.spec.ts`, `detectors-local.spec.ts`, `detections.spec.ts`.
