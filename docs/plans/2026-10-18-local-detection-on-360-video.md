# Local detection on 360 video (walk layers)

Date: 2026-10-18. Branch `feat/ppe-360-detection`.

## Goal

An imported ONNX detector runs on frames of a `walk` layer (360 video), on the whole equirectangular frame as it is. The results land as draft model detections in the normal review and are drawn in the 360 viewer. Separately, the import licence gate warns instead of refusing (founder decision, 2026-10-18, internal use).

## Decisions

- **The frame is the walk's playback copy** (`layer.src`, `walks/<id>/playback.mp4`), decoded in main with ffmpeg at time `t`. The model sees the whole equirectangular frame, letterboxed exactly like the photo path (RGB, /255, grey 114 pad). No cube faces.
- **Boxes are stored in source pixels** of the playback copy (`space: 'source'`, `width`/`height` from `walk.json`) with `frame: {layer, t}`. That is the frame form the review already reads.
- **Seam.** After NMS, two boxes of the same class, one touching x = 0 and the other touching x = W, whose vertical ranges overlap (IoU over y ≥ 0.5), are merged into one. The merged box keeps x0 from the right-hand part and has x0 + w > W, meaning it wraps across the seam. Only walk frames do this.
- **Tiles (optional, off by default).** When tiles are on for a walk frame, the tile grid wraps horizontally across the seam, and boxes are mapped back with modulo W before the merge.
- **Viewer.** The viewer draws detections whose `t` is the nearest sample within 1 s of the playback time. Boxes are projected from equirect pixels to yaw/pitch, then to the screen, as an SVG overlay with sampled edges. They are drawn only while the playback copy is showing. While the levelled copy is showing, a note says to turn Level horizon off to see the boxes.
- **Licence.** `licenceProblem` refuses only an empty licence. Copyleft, non-commercial and unknown licences import with a warning. The warning has a kind (`copyleft | non-commercial | unknown`) carried on the model listing, and the renderer words it from `en.ts`. A missing licence is still refused: the card schema requires one, and a model with no stated terms cannot even be warned about.
- Video (`kind: 'video'`) layers stay out of local detection in this PR. The same decode path would serve them later.

## Contract (T0, lands first)

- `packages/schema/src/ipc.ts`: the detector model listing and the import result gain `licenceWarning?: 'copyleft' | 'non-commercial' | 'unknown'`. `inference:run` already accepts `{layer, t}` items (`InferenceItem`).
- Detection frame boxes may wrap: for a frame box on a walk layer, x0 + w may exceed `width` (schema refine relaxed, with a test). There is a row in `docs/architecture/contract-changes.md`.
- `packages/ui/src/i18n/en.ts`: every new string is added up front (licence warning chip and import note, walk scope, interval, current frame, frames progress, viewer note).

## Tasks

| Id  | Task                                                                                                                                                                                                                                                 | Packages / files                                                                                                                                                 | Tests                                                                                                                            |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| T0  | Contract and strings above                                                                                                                                                                                                                           | schema `ipc.ts`, `detections.ts`; ui `en.ts`; contract-changes row                                                                                               | schema unit                                                                                                                      |
| T1  | Licence gate: warn instead of refuse; kind on listing and import result; chip on the Settings model row; note at import                                                                                                                              | main `inference/licence.ts`, `models.ts`; renderer Settings detection models                                                                                     | `licence.test.ts` (AGPL-3.0 and CC-BY-NC-4.0 warn, MIT clean, empty refused); `models.test.ts`; renderer row test                |
| T2  | Main: walk frame items. ffmpeg decode to RGBA; walk lookup; wrap tiles; seam merge; write frame detections; resume per `t`; progress                                                                                                                 | main `inference/run.ts`, new `frames.ts`, new `seam.ts`, `detect.ts`, `electron.ts`; fixtures (synthetic equirect video with markers, one split across the seam) | `seam.test.ts`, `frames.test.ts`, `index.test.ts` (walk run writes frame drafts; one merged seam box; video items still refused) |
| T3  | Renderer Detect dialog: a "360 video frames" scope in Local model. Walk picker, one frame every N s (1, 2, 5, 10 or custom), or the current frame; run; progress in frames                                                                           | renderer `detections/LocalDetect.tsx`, `AiDetectDialog.tsx` (pass layers and durations)                                                                          | `LocalDetect` unit (items built from walk and interval, current frame)                                                           |
| T4  | Review and viewer: the review shows walk frames (video URL for walks, label "<name> <t> s"); `hasDetectable` counts walks; viewer overlay (pure projection plus SVG layer in `Walk360Pane`)                                                          | renderer `detections/Editor.tsx`, `screens/Detections.tsx`, `detections/convert.ts`; new `walks/detOverlay.ts`; `walks/Walk360Pane.tsx`                          | `detOverlay.test.ts` (centre, seam wrap, behind camera culled); `convert.test.ts`                                                |
| T5  | e2e `detect-walk.spec.ts`: import the marker detector, add the synthetic walk, detect every 2 s, check the drafts in the review, open the viewer, check the overlay boxes. Guide `19-local-detection.md`; session note; proof on the founder's video | e2e, docs                                                                                                                                                        | the spec, run the CI way                                                                                                         |

## Execution DAG

- Batch 1: T0.
- Batch 2 (parallel, no shared files): T1, T2, T4.
- Batch 3: T3 (needs T2 working for a manual check only; its files are separate, so it can join batch 2 if there is capacity).
- Batch 4: T5, after T1 to T4.
- Critical path: T0 → T2 → T5.

## Proof

The founder's model and video stay out of git. `best.pt` was exported to ONNX at the checkpoint's imgsz 640 (YOLO11s, 4 classes, output `[1, 8, 8400]`, layout `yolo-v8`). The reference detections from Ultralytics on five sample frames are kept in scratch, to compare against the app's output on the same frames.
