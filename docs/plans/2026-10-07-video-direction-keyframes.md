# Video camera direction keyframes

Status: approved by the founder 2026-10-07 ("go ahead"). Flight log import (DJI GO 4 / DJI Fly
.txt) is deferred.

## Problem

Consumer DJI drones (Mavic 2, Mini, Air) write GPS and height to the SRT but no gimbal or aircraft
heading. `srtToFlight` estimates heading from the track and a fixed -30 degree pitch, so the camera
points the wrong way whenever the pilot flies sideways, orbits or pans. Calibrate video only applies
one constant offset per clip against a model, which cannot fix a direction that is wrong by a
different amount at each moment, and a video-only project has no model to match.

## Phase 1: direction keyframes (manual)

A "Set camera direction" tool per clip, reachable from the clip (media/timeline) and Ctrl+K.

1. Scrub to a moment. The current video frame is draped on the map (ground footprint of the frame
   at the current pose) and shown as an image plane at the end of the frustum in 3D.
2. Rotate: heading handle on the map, drag the frustum in 3D, pitch slider / wheel, roll if needed,
   until roads and buildings in the frame sit on the basemap or model below.
3. Set keyframe (time, yaw, pitch, roll in project grid frame). Minimum two; any number.
4. Fill mode per segment between two keyframes:
   - Smooth turn (default): shortest-arc slerp from keyframe to keyframe.
   - Follow flight path: keep the keyframe's yaw offset from the track heading; pitch and roll eased.
   - Look at a point: user clicks a target on map or model; the camera aims at it for the segment
     (orbits, point-of-interest shots).
     Before the first and after the last keyframe the nearest keyframe's mode holds.
5. Save to the clip. The flight path, drone, frustum, map footprint and drone-eye update live.

Storage: keyframes live with the layer (manifest) as an orientation track, never by rewriting the
flight file. The rig and the map evaluate pose as: position from the flight (normalised), orientation
from keyframes when present, else gimbal, else estimate. Undoable, journalled like other edits.
Calibrate video offsets still apply on top for clips with gimbal data.

## Phase 2: video-measured fill (assisted)

Between keyframes, measure the camera's frame-to-frame rotation from the video (feature tracking +
homography / essential matrix on ~5 fps proxies, OpenCV Apache-2.0, CPU, pipeline pack job). Anchor
the integrated rotation at both keyframes and distribute drift, so real pans and pauses land at the
right time. New fill mode "Measured from video", default once the job has run.

## Phase 3 (M10)

Photogrammetry over sampled video frames and photos (GPS prior) gives exact per-frame poses and the
mesh; it replaces keyframes where it succeeds.

## Order

1. Merge the video-first placement and telemetry smoothing branch (shares the flight normaliser and
   rig pose code).
2. Phase 1.
3. Phase 2.
