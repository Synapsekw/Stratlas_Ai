# Video camera direction keyframes, and aligning photos

Status: approved by the founder 2026-10-07 ("go ahead"); UX revised the same day: the tools are
driven from the map and the 3D view directly (right-click, in-place align), not from a side panel.
Phase 1 and photo alignment are built on the branch of this plan. Flight log import (DJI GO 4 /
DJI Fly .txt) is deferred.

## Problem

Consumer DJI drones (Mavic 2, Mini, Air) write GPS and height to the SRT but no gimbal or aircraft
heading. `srtToFlight` estimates heading from the track and a fixed -30 degree pitch, so the camera
points the wrong way whenever the pilot flies sideways, orbits or pans. Calibrate video only applies
one constant offset per clip against a model, which cannot fix a direction that is wrong by a
different amount at each moment, and a video-only project has no model to match.

Photos usually carry gimbal angles, but the compass or gimbal of a flight can be off by a constant
amount, so a photo's footprint lands beside what it shows.

## Phase 1: direction keyframes (manual), "Align camera to map"

### Getting there

- **Right-click the drone**: its marker, heading arrow or view footprint on the 2D map; the drone,
  frustum or frame in 3D. A menu offers:
  - **Align camera to map** (primary): align mode at the playhead.
  - **Set direction keyframe here** (while aligning, or when the clip has keyframes).
  - **Look through drone camera** / Leave drone camera.
  - **Play from here** / Pause.
  - **Show / Hide view footprint** (map footprint and 3D frustum).
  - **Clear direction keyframes** (asks once more; Undo in the notice).
  - **Copy position** (lat, lon, height).
- **Right-click a flight path**: the playhead jumps to the nearest point of the path (the clip of
  that flight that covers it becomes active) and the same menu opens.
- Secondary routes: the clip card ("Align camera to map" beside the estimated-direction note) and
  Ctrl+K.

### Align mode (in place)

1. The current video frame lies on the map as its ground footprint (projected through the lens
   onto the ground plane, semi-transparent), and as an image plane at the end of the frustum in 3D.
2. Turn the camera where it is:
   - On the map: drag the footprint (or the round handle on its arm) to turn the heading around
     the drone; drag the square handle on the far edge, or scroll over the footprint, to tilt (the
     footprint slides nearer or farther); Shift-drag to roll.
   - In 3D: the same drags on the frame plane; the wheel over it tilts.
3. A small bar next to the drone holds the frame opacity, **Set keyframe**, previous / next
   keyframe, **Set first and last** (no keyframes yet), Delete keyframe, the fill of the current
   segment, Undo, Cancel and Done. Numeric heading, pitch and roll are under "Exact values".
4. Keyframes are clip time (video ms), yaw, pitch, roll in the project grid frame. Minimum one; any
   number. On a keyframe, turning edits it; between keyframes a turn shows until the playhead
   moves on, and Set keyframe keeps it.
5. Fill per segment (on the keyframe that starts it):
   - Smooth turn (default): shortest-arc slerp from keyframe to keyframe.
   - Follow flight path: keep the keyframe's heading offset from the smoothed track heading, the
     offset easing to the next keyframe's; pitch and roll eased.
   - Look at a point: pick the point on the map or in 3D; the camera aims at it from the drone's
     position (roll 0), blending in and out over half a second at the keyframes.
     Before the first and after the last keyframe that keyframe's fill holds.
6. The timeline shows keyframe diamonds on the clip bar: a click jumps there, a drag moves the
   keyframe in time (in align mode, saved with Done).
7. Keys: Esc cancels (or stops a pick), Enter sets a keyframe, Ctrl+Z undoes.
8. Done saves to the clip; the notice offers Undo (then Redo). Path heading arrow, footprint,
   frustum, drone-eye view, HUD heading and every other reader follow at once, and the unsaved
   keyframes already show everywhere while aligning.

### Storage and the pose rule

Keyframes live in the project's own `orientation.json` (`aio.orientation/1`, a schema proposal for
review at merge), never in the flight file and never in the manifest; saves go through
`orientation:write`, which the journal records before the write. Every reader evaluates the camera
with `clipPoseAt` (`@aio/geo`): position from the flight (normalised) plus the position offset;
orientation from keyframes when the clip has any, else gimbal, else the estimate, turned by the
calibration bias. With keyframes the direction is absolute: Calibrate video's orientation does not
apply to that clip (its time offset, lens and position offset still do). Details:
`docs/architecture/data-conventions.md` sections 3 and 21.

## Photos: "Align photo to map"

- Photos show as pins on the 2D map (clustered) as well as frustums and markers in 3D.
- **Right-click a photo** (pin, frustum or marker; a cluster or merged marker lists its photos
  first): **Align photo to map** (primary), **Open photo** (photo pane of the split view), **Look
  through photo camera**, Show / Hide footprint, **Reset alignment** (with Undo), Copy position.
- Align mode is the same as for a video frame (drape on the map, image plane in 3D, the same
  drags, Shift to roll), with a bar without keyframes and fills; "Exact values" also nudges the
  position (east, north, up). Esc cancels, Enter is Done, Ctrl+Z undoes.
- A photo has one pose, so the alignment is one correction (heading, pitch, roll degrees in the
  grid frame and an optional position offset) against the imported GPS and EXIF/XMP gimbal pose,
  kept in `orientation.json` by photo set and photo id. The image, its EXIF and the photo record
  stay as they are. Saved through `orientation:write` (journalled), with Undo.
- DJI compass and gimbal errors are usually one bias for a flight: after saving, the notice offers
  **Apply the same correction to the N other photos from this flight** (one photo set, no gap over
  20 minutes between consecutive photos; the only grouping the photo data has).

## Phase 2: video-measured fill (assisted)

Between keyframes, measure the camera's frame-to-frame rotation from the video (feature tracking +
homography / essential matrix on ~5 fps proxies, OpenCV Apache-2.0, CPU, pipeline pack job). Anchor
the integrated rotation at both keyframes and distribute drift, so real pans and pauses land at the
right time. New fill mode "Measured from video", default once the job has run (a fill an older build
does not know turns smoothly there).

## Phase 3 (M10)

Photogrammetry over sampled video frames and photos (GPS prior) gives exact per-frame poses and the
mesh; it replaces keyframes and photo corrections where it succeeds.

## Order

1. Merge the video-first placement and telemetry smoothing branch (shares the flight normaliser and
   rig pose code). Done.
2. Phase 1 and photo alignment. Built; founder test pending.
3. Phase 2.
