# @aio/video

Video playback synced to the project clock, flight poses, lens models, the video window with its
telemetry HUD, and the 3D video rig (flight paths, drone marker, frustum, projector, camera modes).

See `docs/architecture/SPEC.md` section 2 for ownership and dependencies. Public API: `src/index.ts`.

## Pieces

| Module                     | What                                                                                                                                                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `flight.ts`                | `parseFlight(json)` for `aio.flight/1` (data-conventions section 3), with errors that name the field or sample                                                                                                                                                                 |
| `pose.ts`                  | `interpolatePose` (lerp + slerp, clamped)                                                                                                                                                                                                                                      |
| `lens.ts`                  | pinhole and f-theta (equidistant, optional `k` polynomial): `imageToRay`, `rayToImage`, `pixelToRay`, `rayToPixel`, `lensAngles`                                                                                                                                               |
| `clock.ts`                 | video time <-> project clock, `syncDecision` (pure sync rules)                                                                                                                                                                                                                 |
| `telemetry.ts`             | altitude, speed from pose deltas, heading and pitch from the camera quaternion, timecode                                                                                                                                                                                       |
| `player.ts`                | `ClipPlayer`: one shared `<video>` per layer (`acquirePlayer` / `releasePlayer`), rVFC clock master, `captureFrame(layerId)`                                                                                                                                                   |
| `projector.ts`             | `Projector`: patches receiver materials with `onBeforeCompile` (reversible), distance-map occlusion, opacity, vignette, range fade                                                                                                                                             |
| `rig.ts`                   | `registerVideoAdapters()`, `setCameraMode(handle, 'free' \| 'follow' \| 'drone')`, `setProjection(handle, {...})`, `videoRig(handle).setFlightPaths({ mode: 'all' \| 'active' \| 'off', hiddenClips })` (paths only; the drone, frustum and projection follow the clip layers) |
| `kit.ts`                   | fixture adapter (MANIFEST pose files to `aio.flight/1`), tests and harnesses only; the production importer is S10's                                                                                                                                                            |
| `srt.ts`                   | DJI SRT telemetry: `parseDjiSrt` (Mavic 3, Enterprise with gimbal angles, Phantom 4 forms), `srtToFlight` (one sample per frame at its subtitle time, rel or abs altitude, gimbal or track heading, grid convergence), `srtTimingCheck` against the video frame times          |
| `mp4.ts`                   | `readMp4VideoInfo`: size, codec and every frame presentation time from the `moov` box (stts, ctts, edit list), no decoding                                                                                                                                                     |
| `calibrate.ts`             | `fitLens`: field of view from point pairs (frame pixel, model point, pose), with a small camera turn as a nuisance parameter; `projectPair`                                                                                                                                    |
| `orientation.ts`           | Camera orientation bias of a clip (`CameraOrientation`): a small yaw, pitch and roll turn after the logged orientation                                                                                                                                                         |
| `autoalign.ts`             | Automatic orientation refine: lines a video frame up with a render of the model by edges                                                                                                                                                                                       |
| `pairing.ts`               | Same view on the other date: the frame or photo of another survey date whose calibrated camera saw the same place the same way                                                                                                                                                 |
| `FramesCompare.tsx`        | Two frames of two dates side by side, or stacked with a swipe or a blend                                                                                                                                                                                                       |
| `trace.ts`, `traceMath.ts` | The drone telemetry trace of a clip as a line in the 3D view, and its maths without three.js                                                                                                                                                                                   |
| `panoVideo.ts`             | A 360 video drawn on an inside-out sphere, with a look state                                                                                                                                                                                                                   |
| `ground.ts`                | `groundPoint`: where a posed camera's image ray meets the ground (`@aio/video/ground`, pure)                                                                                                                                                                                   |
| `drone-glb.ts`             | The drone marker model                                                                                                                                                                                                                                                         |

`@aio/video/telemetry` exports the SRT, MP4 and lens-fit code without three.js or React, for the main process; `@aio/video/ground` exports the pure ground placement.
`setCalibrationLens(handle, lens)` tries a lens on the active clip (drone-eye camera, frustum, projector) until `null`.

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
  Drone-eye puts the target where the view axis meets the ground (at most four flight heights
  away), because the stage takes near / far, the shadow frustum and the ortho tile LOD from the
  camera-to-target distance.
- `projectionReceivers()` should return mesh layers and ground tiles; the projector picks up new
  receivers every frame and uses camera layer 30 (`PROJECTOR_DEPTH_LAYER`) for its depth pass.
