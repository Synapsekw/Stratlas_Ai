# @aio/engine

three.js scene, cameras, picking, layer adapters, projector shaders, clipping, measure.

See `docs/architecture/SPEC.md` section 2 for ownership and dependencies. Public API: `src/index.ts`.

## Seams for other streams

- `SceneHandle.raycast(ndcX, ndcY)`: meshes and rasters, plus every `addRaycastProvider` picker (point clouds), nearest first, then the ground plane y = 0. Section planes hide what they cut.
- `SceneHandle.raycastRay(origin, dir)`: a world ray (photo and frame poses) against visible content, ignoring section planes, then the ground plane.
- Mesh layer roots carry `userData.layerId` (and `userData.aioLayer`).
- `EngineStage.controls` is the OrbitControls (`target`, `enabled`), used by the video rig's follow and drone-eye modes.
- `SceneView` sets `position: relative` on its root; size it from the host (for example `width: 100%; height: 100%`), not with an absolutely positioned class.
