"""change.frames: changes in pose-matched frame and photo pairs, as draft detections.

C0 stub (M8 stream C4 builds it, optional in M8): parameters as ``ChangeFramesParams`` in
``@aio/schema``.
"""

from __future__ import annotations

from ..stub import NotBuiltYet


class ChangeFrames(NotBuiltYet):
    name = "change.frames"
    title = "Change in matched frames"
    description = "Frame and photo pairs of two dates aligned by features; changes become draft detections."
    keys = frozenset({"pairs", "from", "to", "maxPoseM", "maxAngleDeg", "minAreaPx", "out"})
