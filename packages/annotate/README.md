# @aio/annotate

Annotation suite (PRD 6.4, ANN-1 to ANN-13): issues, sightings, severity models, tools for every
dataset, cross-view back-projection, undo stack. Public API: `src/index.ts`. Ownership and
dependencies: `docs/architecture/SPEC.md` section 2.

## Layout

| Path                    | What                                                                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `src/model/ops.ts`      | Pure issue operations: create from a sighting, add, replace, remove, move and merge sightings, status workflow, validation               |
| `src/model/history.ts`  | Undo and redo (command pattern: each change stores the affected issues before and after)                                                 |
| `src/model/query.ts`    | Filter (severity, class, status, dataset, layer, text), natural code sort, counts                                                        |
| `src/model/register.ts` | Register at scale: zones from importer notes, grouping, flattened rows, the virtual row window, indexed search                           |
| `src/model/editor.ts`   | `createIssueEditor`: validates every change, writes through `workspace.upsertIssue/removeIssue`, keeps history and a session audit       |
| `src/model/persist.ts`  | Debounced `project:writeIssues` saver with save state                                                                                    |
| `src/crossview/`        | Lens maths (pinhole, f-theta), `backProject`, `worldToPixel`, and the deriver that adds a mesh pin to image and video sightings          |
| `src/video/track.ts`    | Video time, keyframes, interpolation, time ranges (`t` is in video seconds, data-conventions section 3)                                  |
| `src/image/geometry.ts` | 2D view maths, rotated boxes, hit tests, handle editing                                                                                  |
| `src/tools/`            | Mesh draw state and pins (`mesh.ts`), point-cloud regions (`cloud.ts`), map drawing (`map.ts`), scene tools (`scene.ts`)                 |
| `src/tools/overlay.ts`  | 3D issue pins at scale: one GPU point draw, screen clustering (`declutter.ts`), pooled code labels, heat map, Pins filter (`pinDisplay`) |
| `src/import.ts`         | Kit importers: HCl `findings.json`, EBSM and DAMAC `annotations.json`, kit severity models                                               |
| `src/runtime.ts`        | App-wide editor over the global workspace, pose and image-size caches, shared tool and picker state                                      |
| `src/components/`       | `IssueRegister`, `IssueDetail`, `PhotoViewer`, `VideoAnnotator`, `AnnotationToolbar`, `SightingPicker`, `useMapDraw`                     |

## Keyboard

- Register: arrows or j/k move, Enter flies to the issue, Space checks it, Ctrl+click or the box checks a row, Shift+click a range; bulk status, class and merge are one undo step each; Ctrl+Z / Ctrl+Y undo and redo.
- Photo: V select, B box, R rotated box (three clicks), P polygon (Enter or double-click closes, Backspace removes a vertex), O point, F fit, M mask overlay, wheel or pinch to zoom, Alt or middle drag to pan.
- Video: V, B, P tools, K keyframe at the playhead, I and O mark the event range, Esc stops annotating.
- Picker: class hotkey from the catalogue, then a digit for severity (u for uncertain), Enter creates, a adds to the selected issue, Esc cancels.

## Seams for other streams

- **Video (S6)**: mount `<VideoAnnotator layerId>` inside `VideoWindow` over the `<video>` (object-fit contain). Call `setFlightPoses(layerId, samples)` once the pose file is loaded (otherwise the annotator fetches it). Lens helpers live here (`pixelToCameraRay`, `cameraToPixel`) until S6 exports its own.
- **Engine (S3)**: done. Mesh roots carry `userData.layerId`; back-projection uses `SceneHandle.raycastRay(origin, dir)` when the scene has it (picking copies of merged meshes, all visible content), else `projectionReceivers()`, then the ground plane y = 0. `<AnnotationToolbar>` is mounted in the stage tools; the stage also calls `useIssueOverlay()` so pins stay in every stage mode.
- **Point clouds (S4)**: `pickCloudPoint` uses `SceneHandle.raycast` and expects `Points` hits; a `pickPoint` export with point index would allow `selection` sightings.
- **Maps (S5)**: done. `MapView` takes a `draw` seam (mode, vertices, `onClick`, `onFinish`); the app's stage feeds it from `useMapDraw(layerId)` and mounts `<SightingPicker kinds={['map']} />`.
- **Engine (S3) callouts**: the issue overlay registers the drawn pins and cluster badges with `EngineStage.addLabelObstacles`, so component callout plates never cover them.
- **Pins at scale**: `installIssueOverlay(store, display?)` clusters pins in screen space (badge colour = worst member), shows codes for the selected and hovered pin or while at most 50 items are on screen, and draws an additive severity heat map when `pinDisplay.heat` is on. `<PinControls>` (All, Severity N and above, Off, heat map) sits in the stage display tools; the app hands the same setting to `MapView` as `issues`.
- **Shell (S2)**: done. The author is the OS account (`app:getInfo` `user`) or the Settings override; `IssueRegister` and `IssueDetail` sit in the Issues screen and in the workspace right panel (Selection and Issues tabs); `VideoAnnotator` is a child of `VideoWindow`; flight poses go to `setFlightPoses` when a project opens.

## Credits

2D geometry (view transform, rotated box three-point gesture, corners) is adapted from Kestrel's
image canvas (`app/frontend/src/images/canvas/geometry.ts`, MIT).
