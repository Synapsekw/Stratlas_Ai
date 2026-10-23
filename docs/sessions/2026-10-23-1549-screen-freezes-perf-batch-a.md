---
type: session
date: 2026-10-23-1549
branch: perf/screen-freezes
status: complete
related: [2026-10-23-0057-local-vlm-detectors-merge2.md]
---

# Screen freezes: performance batch A (playback clock, stage warm-up, kept map)

## What changed

- A read-only performance audit (renderer, 3D and map, main process, runtime profiles on the demos) ranked the freezes. The worst were: the playback clock in the shared workspace store re-running about 384 selectors and 40 listeners every frame, the bottom timeline re-rendering whole every frame, the video projector redrawing its 2048 px depth map on every rendered frame, shader programs compiled on first draw (hitches when a project opens or the Scene comes back), and a new MapLibre map and GL context on every 3D to Map switch. Hover raycasts without a BVH, job logs, photo import decoding twice and the 7 MB entry chunk are left for batches B to D.
- This PR (batch A): a separate full-rate playback clock (`packages/workspace/src/clock.ts`); the timeline playhead moves by transform through a `clock` prop on `@aio/ui` `Timeline` and `LaneTimeline`; the projector redraws its depth map only when the pose or video changes, with one 3D draw per video frame (`packages/video`).
- Shader programs are compiled ahead when a project opens, and the Stage is parked and resumed across screens instead of rebuilt (`packages/engine/src/stage`, `SceneView.tsx`, `memoryWatch.ts`).
- One MapLibre map is kept hidden per project across 3D and Map switches; the hidden pane is inert (`packages/maps`, workspace `Stage.tsx`, `styles.css`). The map drone is posed from the clock, the draw preview is sent only when it changes, and the player resumes when the browser pauses a video nobody asked to pause.

| Measure (demos, RTX 5070 Ti, 144 Hz)       | Before                                     | After                        |
| ------------------------------------------ | ------------------------------------------ | ---------------------------- |
| Open project, long tasks                   | 1661 ms (7)                                | about 150 to 210 ms (2 to 3) |
| Return to Scene                            | 134 to 204 ms long, 28 programs            | 0 to 67 ms, 5 programs       |
| Map switch after the first                 | 14 programs and a new GL context each time | 0 and 0, no long tasks       |
| Playback: main busy, draws/s, depth maps/s | 32 to 48 %, 19.1k, 144                     | about 10 %, 2.26k, 10        |
| Paused orbit with video: depth maps/s      | 144                                        | 0                            |
| 60 3D/Map switches, GPU memory             | 200 to 360 MB, climbing                    | 205 to 261 MB, flat          |

## Why

Screens froze on project open, on 3D and Map switches and during video playback. The audit showed the causes were per-frame store churn and GPU objects rebuilt on every switch, not data size.

## How to test

1. Open the tank farm demo. The Scene appears without a multi-second stall; orbiting right away is smooth.
2. Press Map in the Stage tools toolbar, then 3D, then Map again, ten times. After the first Map, each switch is instant and the map keeps its position.
3. Go to Issues, then back to the project. The 3D view returns at once, with the camera where you left it.
4. Open a drone video and press Play. The playhead moves smoothly, the drone on the map follows it, and the 3D view and timeline stay responsive while you scrub.
5. Pause and orbit: the projected video stays put and the view is smooth. Switch screens during playback and come back: playback resumes where it was.

## Open threads

- The map is not kept across main-screen switches: the first Map after leaving and returning to the Scene still costs about 130 ms.
- Workspace `Stage.tsx` still re-renders during playback; 5 programs relink on return to the Scene.
- Batch B: hover BVH, labels, annotation editor, job logs. Batch C: main-process photo import, library cache, startup chain. Batch D: lazy screens, minify, code cache.

## Next session entry point

Batch B (hover raycast with a BVH first), from the audit ranking above.
