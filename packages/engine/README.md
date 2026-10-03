# @aio/engine

three.js scene, cameras, picking, layer adapters, projector shaders, clipping, measure.

See `docs/architecture/SPEC.md` section 2 for ownership and dependencies. Public API: `src/index.ts`.

## Seams for other streams

- Callouts: `EngineStage.setLabelMode('off' | 'key' | 'all')` (selection and hover always; `key` is one callout per tag `area`), `setLabelKeepOut(() => rects)` for UI drawn over the stage (dots, leaders and plates stay out of those client rects), `addLabelObstacles(() => points)` for world points plates must not cover (issue pins).
- Views: `saveView()` / `restoreView(view, animate?)`; a restored view stops the load-time framing. `sectionOrigin()` is the point section offsets are measured from.
- `photos` layers: the engine adapter draws posed photos as frustums (merged outlines, a ghost through walls, instanced image planes) and selects `{ kind: 'photo', id, layer }` on click.
- `SceneHandle.raycast(ndcX, ndcY)`: meshes and rasters, plus every `addRaycastProvider` picker (point clouds), nearest first, then the ground plane y = 0. Section planes hide what they cut.
- `SceneHandle.raycastRay(origin, dir)`: a world ray (photo and frame poses) against visible content, ignoring section planes, then the ground plane.
- Mesh layer roots carry `userData.layerId` (and `userData.aioLayer`).
- `EngineStage.controls` is the OrbitControls (`target`, `enabled`), used by the video rig's follow and drone-eye modes.
- `SceneView` sets `position: relative` on its root; size it from the host (for example `width: 100%; height: 100%`), not with an absolutely positioned class.
