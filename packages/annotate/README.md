# @aio/annotate

Annotation suite (PRD 6.4, ANN-1 to ANN-13): issues, sightings, severity models, tools for every
dataset, cross-view back-projection, undo stack. Public API: `src/index.ts`. Ownership and
dependencies: `docs/architecture/SPEC.md` section 2.

## Layout

| Path                    | What                                                                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `src/model/ops.ts`      | Pure issue operations: create from a sighting, add, replace, remove, move and merge sightings, status workflow, validation              |
| `src/model/history.ts`  | Undo and redo (command pattern: each change stores the affected issues before and after)                                                |
| `src/model/query.ts`    | Filter (severity, class, status, dataset, layer, text), natural code sort, counts                                                       |
| `src/model/editor.ts`   | `createIssueEditor`: validates every change, writes through `workspace.upsertIssue/removeIssue`, keeps history and a session audit      |
| `src/model/persist.ts`  | Debounced `project:writeIssues` saver with save state                                                                                   |
| `src/crossview/`        | Lens maths (pinhole, f-theta), `backProject`, `worldToPixel`, and the deriver that adds a mesh pin to image and video sightings         |
| `src/video/track.ts`    | Video time, keyframes, interpolation, time ranges (`t` is in video seconds, data-conventions section 3)                                 |
| `src/image/geometry.ts` | 2D view maths, rotated boxes, hit tests, handle editing                                                                                 |
| `src/tools/`            | Mesh draw state and pins (`mesh.ts`), point-cloud regions (`cloud.ts`), map drawing (`map.ts`), scene tools and 3D overlay (`scene.ts`) |
| `src/import.ts`         | Kit importers: HCl `findings.json`, EBSM and DAMAC `annotations.json`, kit severity models                                              |
| `src/runtime.ts`        | App-wide editor over the global workspace, pose and image-size caches, shared tool and picker state                                     |
| `src/components/`       | `IssueRegister`, `IssueDetail`, `PhotoViewer`, `VideoAnnotator`, `AnnotationToolbar`, `SightingPicker`, `useMapDraw`                    |

## Keyboard

- Register: arrows or j/k move, Enter flies to the issue, Ctrl+Z / Ctrl+Y undo and redo.
- Photo: V select, B box, R rotated box (three clicks), P polygon (Enter or double-click closes, Backspace removes a vertex), O point, F fit, M mask overlay, wheel or pinch to zoom, Alt or middle drag to pan.
- Video: V, B, P tools, K keyframe at the playhead, I and O mark the event range, Esc stops annotating.
- Picker: class hotkey from the catalogue, then a digit for severity (u for uncertain), Enter creates, a adds to the selected issue, Esc cancels.

## Seams for other streams

- **Video (S6)**: mount `<VideoAnnotator layerId>` inside `VideoWindow` over the `<video>` (object-fit contain). Call `setFlightPoses(layerId, samples)` once the pose file is loaded (otherwise the annotator fetches it). Lens helpers live here (`pixelToCameraRay`, `cameraToPixel`) until S6 exports its own.
- **Engine (S3)**: tag mesh roots with `userData.layerId` so sightings name their layer; `SceneHandle.raycastRay(origin, dir)` would let back-projection reuse the engine's picking (today it raycasts `projectionReceivers()` and falls back to the ground plane y = 0). Mount `<AnnotationToolbar>` in the stage tools; it installs the issue pins.
- **Point clouds (S4)**: `pickCloudPoint` uses `SceneHandle.raycast` and expects `Points` hits; a `pickPoint` export with point index would allow `selection` sightings.
- **Maps (S5)**: `useMapDraw(layerId)` plus `<SightingPicker kinds={['map']} />` in `MapView`.
- **Shell (S2)**: `setAnnotationAuthor(name)`; place `IssueRegister` and `IssueDetail` in the right panel.

## Credits

2D geometry (view transform, rotated box three-point gesture, corners) is adapted from Kestrel's
image canvas (`app/frontend/src/images/canvas/geometry.ts`, MIT).
