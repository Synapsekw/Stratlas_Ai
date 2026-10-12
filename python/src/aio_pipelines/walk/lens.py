"""Equirectangular maps from a dual fisheye frame, with an optional per-frame rotation (walk.process).

Conventions (shared with the synthetic walk in the tests):

- **Camera frame**: x right, y down, z forward. The equirect's centre column at the middle row looks
  along +z; its top row is up (-y); right of centre is +x.
- **Lens 0** looks along camera +z and is the **left** half of the side-by-side frame (the first
  video stream of a dual-stream clip); **lens 1** looks along -z and is the **right** half. In each
  lens image, image x right is camera +x for lens 0 and camera -x for lens 1; image y down is camera
  +y for both.
- **Equidistant fisheye**: ``r = f * theta`` with ``f = radius / (fov / 2)`` (radians), measured
  from the lens centre ``(cx, cy)`` in continuous pixel coordinates (pixel ``i`` spans ``[i, i+1)``);
  the maps handed to ``cv2.remap`` are in its pixel-centre coordinates (half a pixel less).
- **Per-lens rotation**: the Insta360 calibration's ``yaw``, ``pitch`` and ``roll`` (degrees) are
  small corrections on top of the nominal lens axes. It writes a roll near a quarter turn on both
  lenses (the sensor sits sideways in the body) while the recorded streams are already upright, so
  only the remainder past the nearest quarter turn is applied (``effective_roll``). The lens is
  turned by ``Ry(-yaw) Rx(pitch) Rz(-roll)`` (y down, x right, z its optical axis): the signs that
  fit an X4 clip's seam best (12 Oct 2026: median ray mismatch 0.15 degree, against 0.46 with
  the angles left out). Zero angles leave the nominal axes.
- **Rotation of a frame**: ``rotation`` is the ``(3, 3)`` matrix ``L`` of ``motion.level_rotation``
  (camera-frame directions to the levelled frame); a levelled picture samples the source at
  ``L.T @ d`` for each of its own directions ``d``.
- **Seam**: the blend weight of lens 0 is 1 more than 2 degrees in front of the camera's 90 degree
  meridian (the plane z = 0 of the source), 0 more than 2 degrees behind it, linear in between.

Maps are smooth away from the seam, so a per-frame map is computed at ``1 / map_scale`` of the
output size on a grid padded by one sample and upsampled with ``cv2.resize`` (bilinear), which keeps
it within a fraction of a pixel of the full-size map.
"""

from __future__ import annotations

import functools
import math

import cv2
import numpy as np

from .calib import Lens

FEATHER_DEG = 4.0
_LENS1_BASE = np.diag([-1.0, 1.0, -1.0])  # camera frame to lens 1's nominal frame (half turn about y)


def _rx(deg: float) -> np.ndarray:
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    return np.array([[1.0, 0.0, 0.0], [0.0, c, -s], [0.0, s, c]])


def _ry(deg: float) -> np.ndarray:
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]])


def _rz(deg: float) -> np.ndarray:
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]])


def effective_roll(roll_deg: float) -> float:
    """The roll correction left after the nearest quarter turn (the sensor's mounting)."""
    return roll_deg - 90.0 * round(roll_deg / 90.0)


def lens_matrix(lens: Lens, index: int) -> np.ndarray:
    """``M`` with ``d_lens = M @ d_camera`` for lens ``index`` (0 forward, 1 backward)."""
    corr = _ry(-lens.yaw_deg) @ _rx(lens.pitch_deg) @ _rz(-effective_roll(lens.roll_deg))
    base = np.eye(3) if index == 0 else _LENS1_BASE
    return corr.T @ base


def _project_lens_frame(lens: Lens, v: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Continuous image coordinates of lens-frame directions ``v`` (..., 3)."""
    vx, vy, vz = v[..., 0], v[..., 1], v[..., 2]
    rho = np.hypot(vx, vy)
    theta = np.arctan2(rho, vz)
    f = lens.radius / math.radians(lens.fov_deg / 2.0)
    k = np.divide(f * theta, rho, out=np.full_like(rho, f), where=rho > 1e-12)
    return lens.cx + k * vx, lens.cy + k * vy


def project(lens: Lens, index: int, dirs: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Continuous pixel coordinates ``(x, y)`` in lens ``index``'s own image of camera-frame unit
    directions ``dirs`` (..., 3)."""
    v = np.asarray(dirs, dtype=np.float64) @ lens_matrix(lens, index).T
    return _project_lens_frame(lens, v)


def _dirs_at(u: np.ndarray, v: np.ndarray, width: int, height: int) -> np.ndarray:
    """Unit directions at continuous output pixel-centre coordinates ``u`` (columns) and ``v``
    (rows) of a ``width`` x ``height`` equirect; values outside the picture continue smoothly."""
    lon = ((u + 0.5) / width - 0.5) * (2.0 * math.pi)
    lat = (0.5 - (v + 0.5) / height) * math.pi
    clat = np.cos(lat)[:, None]
    out = np.empty((len(v), len(u), 3), dtype=np.float64)
    out[..., 0] = clat * np.sin(lon)[None, :]
    out[..., 1] = -np.sin(lat)[:, None]
    out[..., 2] = clat * np.cos(lon)[None, :]
    return out


def equirect_dirs(width: int, height: int) -> np.ndarray:
    """``(height, width, 3)`` unit vectors, camera frame, one per output pixel centre."""
    return _dirs_at(np.arange(width, dtype=np.float64), np.arange(height, dtype=np.float64), width, height)


@functools.lru_cache(maxsize=4)
def _grid32(out_w: int, out_h: int, s: int) -> np.ndarray:
    """:func:`_grid` as float32, cached (read-only)."""
    g = _grid(out_w, out_h, s).astype(np.float32)
    g.flags.writeable = False
    return g


def _grid(out_w: int, out_h: int, s: int) -> np.ndarray:
    """Directions of the coarse grid: every ``s``-th pixel's block centre, padded by one sample."""
    if s == 1:
        return equirect_dirs(out_w, out_h)
    sw, sh = -(-out_w // s), -(-out_h // s)
    u = s * np.arange(-1, sw + 1, dtype=np.float64) + (s - 1) / 2.0
    v = s * np.arange(-1, sh + 1, dtype=np.float64) + (s - 1) / 2.0
    return _dirs_at(u, v, out_w, out_h)


def _upsample(a: np.ndarray, out_w: int, out_h: int, s: int) -> np.ndarray:
    """The padded coarse grid ``a`` upsampled to the output size (a row-strided view, which
    ``cv2.remap`` and ``cv2.blendLinear`` take without a copy)."""
    if s == 1:
        return a
    gh, gw = a.shape[:2]
    big = cv2.resize(a, (gw * s, gh * s), interpolation=cv2.INTER_LINEAR)
    return big[s : s + out_h, s : s + out_w]


def _seam_weight(z: np.ndarray) -> np.ndarray:
    """Blend weight of lens 0 from the source direction's camera z."""
    w = 0.5 + np.arcsin(np.clip(z, -1.0, 1.0)) / math.radians(FEATHER_DEG)
    return np.clip(w, 0.0, 1.0).astype(np.float32)


def stitch_maps(
    lenses: tuple[Lens, Lens],
    lens_size: int,
    out_w: int,
    out_h: int,
    rotation: np.ndarray | None = None,
    map_scale: int = 4,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """The maps of :func:`dual_fisheye_map` in the form ``cv2.remap`` and ``cv2.blendLinear``
    take directly: two ``(out_h, out_w, 2)`` float32 ``(x, y)`` arrays (lens 0, lens 1), the weight
    of lens 0 and its complement (``(out_h, out_w)`` float32). With ``map_scale`` above 1 they are
    row-strided views of the upsampled grid (copy them to keep them contiguous)."""
    s = max(1, int(map_scale))
    d = _grid32(out_w, out_h, s)
    rot = np.eye(3) if rotation is None else np.asarray(rotation, dtype=np.float64)
    pairs = []
    for i in (0, 1):
        lens = lenses[i]
        m = (lens_matrix(lens, i) @ rot.T).astype(np.float32)  # d_lens = M L^T d
        v = d @ m.T
        x, y = _project_lens_frame(lens, v)
        xy = np.empty((*x.shape, 2), dtype=np.float32)
        xy[..., 0] = x - (0.5 - i * lens_size)
        xy[..., 1] = y - 0.5
        pairs.append(_upsample(xy, out_w, out_h, s))
    z = d @ rot[:, 2].astype(np.float32)  # camera z of the source direction L^T d
    w = _seam_weight(z)
    return pairs[0], pairs[1], _upsample(w, out_w, out_h, s), _upsample(1.0 - w, out_w, out_h, s)


def dual_fisheye_pairs(
    lenses: tuple[Lens, Lens],
    lens_size: int,
    out_w: int,
    out_h: int,
    rotation: np.ndarray | None = None,
    map_scale: int = 4,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """:func:`stitch_maps` without the weight's complement, contiguous."""
    p0, p1, w, _ = stitch_maps(lenses, lens_size, out_w, out_h, rotation, map_scale)
    return np.ascontiguousarray(p0), np.ascontiguousarray(p1), np.ascontiguousarray(w)


def dual_fisheye_map(
    lenses: tuple[Lens, Lens],
    lens_size: int,
    out_w: int,
    out_h: int,
    rotation: np.ndarray | None = None,
    map_scale: int = 4,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """``map_x``, ``map_y`` (float32, ``(2, out_h, out_w)``: lens 0's sampling then lens 1's, both
    into the side-by-side frame of two ``lens_size`` lens images) and the blend weight of lens 0
    (float32, ``(out_h, out_w)``). The stitched pixel is ``w * remap(lens 0) + (1 - w) * remap(lens 1)``."""
    p0, p1, w = dual_fisheye_pairs(lenses, lens_size, out_w, out_h, rotation, map_scale)
    map_x = np.stack([p0[..., 0], p1[..., 0]])
    map_y = np.stack([p0[..., 1], p1[..., 1]])
    return map_x, map_y, w


def equirect_rotate_pairs(out_w: int, out_h: int, rotation: np.ndarray, map_scale: int = 4) -> np.ndarray:
    """The map of :func:`equirect_rotate_map` as one ``(out_h, out_w, 2)`` float32 array."""
    s = max(1, int(map_scale))
    d = _grid(out_w, out_h, s) @ np.asarray(rotation, dtype=np.float64)
    lon = np.arctan2(d[..., 0], d[..., 2])
    lat = np.arcsin(np.clip(-d[..., 1], -1.0, 1.0))
    u = (lon / (2.0 * math.pi) + 0.5) * out_w - 0.5
    v = (0.5 - lat / math.pi) * out_h - 0.5
    if s > 1:
        # Continuous across the back seam so the upsampling never blends across it (remap wraps).
        u[:, 0] = np.unwrap(u[:, 0], period=out_w)
        u = np.unwrap(u, period=out_w, axis=1)
        mid = u[u.shape[0] // 2, u.shape[1] // 2]
        u -= out_w * math.floor((mid + 0.5) / out_w)
    xy = np.empty((*u.shape, 2), dtype=np.float32)
    xy[..., 0] = u
    xy[..., 1] = v
    return np.ascontiguousarray(_upsample(xy, out_w, out_h, s))


def equirect_rotate_map(
    out_w: int, out_h: int, rotation: np.ndarray, map_scale: int = 4
) -> tuple[np.ndarray, np.ndarray]:
    """``map_x``, ``map_y`` (float32, ``(out_h, out_w)``) that rotate an equirect of the same size
    by ``rotation`` (sampling at ``L.T @ d``). ``map_x`` may run past the picture's sides: remap
    with ``cv2.BORDER_WRAP``."""
    xy = equirect_rotate_pairs(out_w, out_h, rotation, map_scale)
    return np.ascontiguousarray(xy[..., 0]), np.ascontiguousarray(xy[..., 1])
