"""Equirectangular (360 walk frame) geometry: pixels to directions, perspective faces, boxes back.

Conventions follow the renderer (``apps/desktop/src/renderer/walks/detOverlay.ts`` and
``@aio/engine`` ``panoMath.ts``): the picture centre is yaw 0, yaw grows to the right (clockwise
seen from above), pitch up. A direction in the **camera frame** uses three.js camera axes (x right,
y up, the camera looks along -z), so yaw 0, pitch 0 is ``[0, 0, -1]`` and yaw 90 is ``[1, 0, 0]``.
A walk pose ``q`` (``walks/<id>/pose.json``, x y z w) turns it into the project local frame
(metres, y up, x east, z south).

A frame box is ``[x0, y0, x1, y1]`` in source pixels of a ``w`` x ``h`` frame; x1 past ``w``
wraps across the seam (data-conventions section 11).

Perspective faces cut a frame into pinhole views a photo detector can read (the vision study's
"perspective crops"): ``FACE_YAWS`` around the horizon, ``FACE_FOV`` wide so neighbouring faces
overlap. A box found on a face maps back to the frame by sampling its edges (``face_box_to_frame``).
"""

from __future__ import annotations

import math
from collections.abc import Sequence

import numpy as np

RAD = math.pi / 180.0
#: Face centres around the horizon, degrees of yaw; four faces of ``FACE_FOV`` overlap by 10 degrees.
FACE_YAWS = (0.0, 90.0, 180.0, 270.0)
FACE_FOV = 100.0
FACE_SIZE = 1024


def pixel_to_look(x: float, y: float, w: float, h: float) -> tuple[float, float]:
    """Yaw and pitch (degrees) of a frame pixel."""
    return (x / w - 0.5) * 360.0, (0.5 - y / h) * 180.0


def look_to_pixel(yaw: float, pitch: float, w: float, h: float) -> tuple[float, float]:
    """Frame pixel of a yaw and pitch (degrees); x in [0, w)."""
    x = ((yaw / 360.0 + 0.5) % 1.0) * w
    return x, (0.5 - pitch / 180.0) * h


def look_to_dir(yaw: float, pitch: float) -> np.ndarray:
    """Unit direction (camera frame, three.js axes) of a yaw and pitch in degrees."""
    a, e = yaw * RAD, pitch * RAD
    return np.array([math.sin(a) * math.cos(e), math.sin(e), -math.cos(a) * math.cos(e)])


def dir_to_look(d: Sequence[float]) -> tuple[float, float]:
    """Yaw (-180..180) and pitch of a camera-frame direction, degrees."""
    x, y, z = (float(v) for v in d)
    n = math.sqrt(x * x + y * y + z * z) or 1.0
    return math.degrees(math.atan2(x, -z)), math.degrees(math.asin(max(-1.0, min(1.0, y / n))))


def box_centre(box: Sequence[float], w: float, h: float) -> tuple[float, float]:
    """The centre of a frame box (a wrapping box's centre may sit past ``w``; folded back)."""
    x0, y0, x1, y1 = box
    return ((x0 + x1) / 2.0) % w, (y0 + y1) / 2.0


def box_dir(box: Sequence[float], w: float, h: float, where: str = "centre") -> np.ndarray:
    """Camera-frame direction of a box's centre, or of its bottom centre (``where="bottom"``)."""
    cx, cy = box_centre(box, w, h)
    if where == "bottom":
        cy = float(box[3])
    return look_to_dir(*pixel_to_look(cx, cy, w, h))


def box_size_deg(box: Sequence[float], w: float, h: float) -> float:
    """The larger angular side of a frame box, degrees (its width shrunk by the cosine of pitch)."""
    x0, y0, x1, y1 = box
    _, pitch = pixel_to_look(*box_centre(box, w, h), w, h)
    width = (x1 - x0) / w * 360.0 * max(0.05, math.cos(pitch * RAD))
    return max(width, (y1 - y0) / h * 180.0)


# --------------------------------------------------------------------------- perspective faces


def face_basis(yaw: float, pitch: float = 0.0) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Forward, right and up unit vectors (camera frame) of a face looking along yaw, pitch."""
    f = look_to_dir(yaw, pitch)
    a = yaw * RAD
    r = np.array([math.cos(a), 0.0, math.sin(a)])
    u = np.cross(r, f)
    return f, r, u


def face_rays(yaw: float, fov: float, size: int, pitch: float = 0.0) -> np.ndarray:
    """``size`` x ``size`` x 3 unit directions (camera frame) of a square pinhole face's pixels."""
    f, r, u = face_basis(yaw, pitch)
    t = math.tan(fov * RAD / 2.0)
    s = (np.arange(size, dtype=np.float64) + 0.5) / size * 2.0 - 1.0
    gx, gy = np.meshgrid(s * t, -s * t)
    d = f[None, None, :] + gx[..., None] * r[None, None, :] + gy[..., None] * u[None, None, :]
    return d / np.linalg.norm(d, axis=2, keepdims=True)


def render_face(frame: np.ndarray, yaw: float, fov: float = FACE_FOV, size: int = FACE_SIZE) -> np.ndarray:
    """A square pinhole face of an equirectangular ``frame`` (H x W x C), bilinear, wrapping the seam."""
    h, w = frame.shape[:2]
    d = face_rays(yaw, fov, size)
    yaws = np.degrees(np.arctan2(d[..., 0], -d[..., 2]))
    pitches = np.degrees(np.arcsin(np.clip(d[..., 1], -1.0, 1.0)))
    fx = (yaws / 360.0 + 0.5) * w - 0.5
    fy = (0.5 - pitches / 180.0) * h - 0.5
    x0 = np.floor(fx).astype(np.int64)
    y0 = np.floor(fy).astype(np.int64)
    ax = (fx - x0)[..., None]
    ay = (fy - y0)[..., None]
    xa, xb = x0 % w, (x0 + 1) % w
    ya, yb = np.clip(y0, 0, h - 1), np.clip(y0 + 1, 0, h - 1)
    img = frame.astype(np.float32)
    top = img[ya, xa] * (1 - ax) + img[ya, xb] * ax
    bot = img[yb, xa] * (1 - ax) + img[yb, xb] * ax
    out = top * (1 - ay) + bot * ay
    return np.clip(out + 0.5, 0, 255).astype(frame.dtype)


def face_pixel_dir(x: float, y: float, yaw: float, fov: float, size: int) -> np.ndarray:
    """Camera-frame direction of a pixel of a face."""
    f, r, u = face_basis(yaw)
    t = math.tan(fov * RAD / 2.0)
    sx = (x / size * 2.0 - 1.0) * t
    sy = -(y / size * 2.0 - 1.0) * t
    d = f + sx * r + sy * u
    return d / np.linalg.norm(d)


def face_box_to_frame(
    box: Sequence[float], yaw: float, fov: float, size: int, w: int, h: int, samples: int = 8
) -> list[float]:
    """A face box (face pixels) as a frame box: the yaw and pitch range of its sampled edges.

    Yaws are unwrapped around the box centre, so a box across the seam comes back with x1 past
    ``w`` (it wraps); x0 always lies in [0, w)."""
    x0, y0, x1, y1 = (float(v) for v in box)
    pts: list[tuple[float, float]] = []
    for k in range(samples + 1):
        a = k / samples
        pts += [(x0 + (x1 - x0) * a, y0), (x0 + (x1 - x0) * a, y1)]
        pts += [(x0, y0 + (y1 - y0) * a), (x1, y0 + (y1 - y0) * a)]
    cyaw, _ = dir_to_look(face_pixel_dir((x0 + x1) / 2, (y0 + y1) / 2, yaw, fov, size))
    yaws, pitches = [], []
    for px, py in pts:
        yw, pt = dir_to_look(face_pixel_dir(px, py, yaw, fov, size))
        yaws.append(cyaw + ((yw - cyaw + 180.0) % 360.0) - 180.0)
        pitches.append(pt)
    ymin, ymax = min(yaws), max(yaws)
    fx0 = (ymin / 360.0 + 0.5) * w
    fx1 = (ymax / 360.0 + 0.5) * w
    shift = math.floor(fx0 / w) * w
    fx0, fx1 = fx0 - shift, fx1 - shift
    fy0 = (0.5 - max(pitches) / 180.0) * h
    fy1 = (0.5 - min(pitches) / 180.0) * h
    return [round(fx0, 1), round(max(0.0, fy0), 1), round(fx1, 1), round(min(float(h), fy1), 1)]


def face_box_inside(box: Sequence[float], size: int, margin: float = 0.02) -> bool:
    """True when a face box does not touch the face's edge (it is not cut by the face)."""
    m = margin * size
    return box[0] > m and box[1] > m and box[2] < size - m and box[3] < size - m


def frame_iou(a: Sequence[float], b: Sequence[float], w: float) -> float:
    """IoU of two frame boxes on the wrapping frame (b is tried shifted by -w, 0 and +w)."""
    best = 0.0
    area_a = max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1])
    area_b = max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
    for s in (-w, 0.0, w):
        ix = max(0.0, min(a[2], b[2] + s) - max(a[0], b[0] + s))
        iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
        inter = ix * iy
        union = area_a + area_b - inter
        if union > 0:
            best = max(best, inter / union)
    return best


def merge_face_boxes(dets: list[dict], w: float, iou: float = 0.4) -> list[dict]:
    """Drafts of one frame from overlapping faces as one: the higher score (then the box a face did
    not cut) wins where two boxes of one class overlap by ``iou`` or more."""

    def rank(d: dict) -> tuple[float, int]:
        return (float(d.get("confidence") or 0.0), 1 if d.get("_inside") else 0)

    out: list[dict] = []
    for d in sorted(dets, key=rank, reverse=True):
        if any(o["class"] == d["class"] and frame_iou(o["bbox"], d["bbox"], w) >= iou for o in out):
            continue
        out.append(d)
    return out
