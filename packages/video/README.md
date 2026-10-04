# @aio/video

Video playback synced to the project clock, flight poses, lens models, the video window with its
telemetry HUD, and the 3D video rig (flight paths, drone marker, frustum, projector, camera modes).

See `docs/architecture/SPEC.md` section 2 for ownership and dependencies. Public API: `src/index.ts`.

## Pieces

| Module         | What                                                                                                                                                                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `flight.ts`    | `parseFlight(json)` for `aio.flight/1` (data-conventions section 3), with errors that name the field or sample                                                                                                                                                                 |
| `pose.ts`      | `interpolatePose` (lerp + slerp, clamped)                                                                                                                                                                                                                                      |
| `lens.ts`      | pinhole and f-theta (equidistant, optional `k` polynomial): `imageToRay`, `rayToImage`, `pixelToRay`, `rayToPixel`, `lensAngles`                                                                                                                                               |
| `clock.ts`     | video time <-> project clock, `syncDecision` (pure sync rules)                                                                                                                                                                                                                 |
| `telemetry.ts` | altitude, speed from pose deltas, heading and pitch from the camera quaternion, timecode                                                                                                                                                                                       |
| `player.ts`    | `ClipPlayer`: one shared `<video>` per layer (`acquirePlayer` / `releasePlayer`), rVFC clock master, `captureFrame(layerId)`                                                                                                                                                   |
| `projector.ts` | `Projector`: patches receiver materials with `onBeforeCompile` (reversible), distance-map occlusion, opacity, vignette, range fade                                                                                                                                             |
| `rig.ts`       | `registerVideoAdapters()`, `setCameraMode(handle, 'free' \| 'follow' \| 'drone')`, `setProjection(handle, {...})`, `videoRig(handle).setFlightPaths({ mode: 'all' \| 'active' \| 'off', hiddenClips })` (paths only; the drone, frustum and projection follow the clip layers) |
| `kit.ts`       | fixture adapter (MANIFEST pose files to `aio.flight/1`), tests and harnesses only; the production importer is S10's                                                                                                                                                            |

## Clock rules

While the workspace is `playing`, the `activeClip` video is the clock master: each presented frame
(requestVideoFrameCallback) writes `nowMs`. Other open clips follow and re-seek only past 0.25 s of
drift. When paused or scrubbing, every clip seeks to `nowMs`, clamped to the clip. Outside a clip
the player reports `no-footage`; the master reaching its end pauses the workspace.

## Seams other streams provide

- `aio://` responses need CORS (`Access-Control-Allow-Origin`) so WebGL and canvas can read frames
  (`crossOrigin = 'anonymous'` is set on every video).
- Follow-cam and drone-eye move the orbit target and disable the controls when the scene handle
  exposes `controls: { target: Vector3; enabled: boolean }` (optional; without it only the camera moves).
- `projectionReceivers()` should return mesh layers and ground tiles; the projector picks up new
  receivers every frame and uses camera layer 30 (`PROJECTOR_DEPTH_LAYER`) for its depth pass.
