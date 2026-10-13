"""Rotations and projections of ``pano.stitch``.

World frame W: x east, y north, z up (true north, from the gimbal). Camera frame C (OpenCV): x
right, y down, z forward. A frame's rotation ``R`` takes camera rays to world rays (``w = R @ c``);
its columns are the camera's right, down and forward axes in W. Pixel centres sit at integer
coordinates and the principal point at the image centre ``((w - 1) / 2, (h - 1) / 2)``.

Equirect canvas, W x H: column ``u`` looks along longitude ``(u + 0.5) / W * 360 - 180`` (0, north,
at the centre, growing east to the right), row ``v`` at latitude ``90 - (v + 0.5) / H * 180``.
"""

from __future__ import annotations

import math

import numpy as np

#: Diagonal of a 35 mm frame, millimetres (``FocalLengthIn35mmFilm`` is defined against it).
DIAG_35MM = 43.2666


def rot_from_gimbal(yaw_deg: float, pitch_deg: float, roll_deg: float) -> np.ndarray:
    """Camera-to-world rotation from DJI gimbal angles: yaw clockwise from true north, pitch up
    positive, roll clockwise looking forward."""
    y, p, r = (math.radians(a) for a in (yaw_deg, pitch_deg, roll_deg))
    fwd = np.array([math.sin(y) * math.cos(p), math.cos(y) * math.cos(p), math.sin(p)])
    right0 = np.array([math.cos(y), -math.sin(y), 0.0])
    down0 = np.cross(fwd, right0)
    right = math.cos(r) * right0 + math.sin(r) * down0
    down = -math.sin(r) * right0 + math.cos(r) * down0
    return np.stack([right, down, fwd], axis=1)


def gimbal_from_rot(rot: np.ndarray) -> tuple[float, float, float]:
    """The inverse of :func:`rot_from_gimbal` (straight down, roll takes the yaw)."""
    fwd = rot[:, 2]
    pitch = math.asin(max(-1.0, min(1.0, float(fwd[2]))))
    yaw = math.atan2(float(fwd[0]), float(fwd[1]))
    right0 = np.array([math.cos(yaw), -math.sin(yaw), 0.0])
    down0 = np.cross(fwd, right0)
    roll = math.atan2(float(rot[:, 0] @ down0), float(rot[:, 0] @ right0))
    return math.degrees(yaw), math.degrees(pitch), math.degrees(roll)


def angle_deg(ra: np.ndarray, rb: np.ndarray) -> float:
    """Angle of the rotation between two rotations, degrees."""
    c = (float(np.trace(ra.T @ rb)) - 1.0) / 2.0
    return math.degrees(math.acos(max(-1.0, min(1.0, c))))


def nearest_rotation(m: np.ndarray) -> np.ndarray:
    """The rotation closest to a 3 x 3 matrix (SVD)."""
    u, _, vt = np.linalg.svd(m)
    d = np.sign(np.linalg.det(u @ vt))
    return u @ np.diag([1.0, 1.0, d]) @ vt


def rotvecs_to_matrices(v: np.ndarray) -> np.ndarray:
    """Rodrigues for an (n, 3) array of rotation vectors, giving (n, 3, 3)."""
    v = np.asarray(v, float).reshape(-1, 3)
    theta = np.linalg.norm(v, axis=1)
    k = np.where(theta[:, None] > 1e-12, v / np.maximum(theta, 1e-12)[:, None], 0.0)
    kx = np.zeros((len(v), 3, 3))
    kx[:, 0, 1], kx[:, 0, 2] = -k[:, 2], k[:, 1]
    kx[:, 1, 0], kx[:, 1, 2] = k[:, 2], -k[:, 0]
    kx[:, 2, 0], kx[:, 2, 1] = -k[:, 1], k[:, 0]
    s, c = np.sin(theta)[:, None, None], np.cos(theta)[:, None, None]
    return np.eye(3)[None] + s * kx + (1 - c) * (kx @ kx)


def focal_px(focal35: float, width: int, height: int) -> float:
    """Focal length in pixels from the 35 mm equivalent (defined on the diagonal)."""
    return focal35 / DIAG_35MM * math.hypot(width, height)


def principal(width: int, height: int) -> tuple[float, float]:
    return (width - 1) / 2.0, (height - 1) / 2.0


def pixels_to_rays(pts: np.ndarray, f: float, width: int, height: int) -> np.ndarray:
    """Unit camera rays of (n, 2) pixel positions."""
    cx, cy = principal(width, height)
    pts = np.asarray(pts, float).reshape(-1, 2)
    rays = np.column_stack([(pts[:, 0] - cx) / f, (pts[:, 1] - cy) / f, np.ones(len(pts))])
    return rays / np.linalg.norm(rays, axis=1, keepdims=True)


def equirect_dirs(width: int, height: int, x0: int, y0: int, x1: int, y1: int) -> np.ndarray:
    """World rays (float32, (y1 - y0, x1 - x0, 3)) of a box of canvas pixels."""
    u = (np.arange(x0, x1, dtype=np.float32) + 0.5) / width * (2 * np.pi) - np.pi
    v = np.pi / 2 - (np.arange(y0, y1, dtype=np.float32) + 0.5) / height * np.pi
    lon, lat = np.meshgrid(u, v)
    cl = np.cos(lat)
    return np.stack([np.sin(lon) * cl, np.cos(lon) * cl, np.sin(lat)], axis=-1).astype(np.float32)


def dirs_to_canvas(d: np.ndarray, width: int, height: int) -> tuple[np.ndarray, np.ndarray]:
    """Canvas pixel coordinates (u, v) of world rays (..., 3)."""
    lon = np.arctan2(d[..., 0], d[..., 1])
    lat = np.arcsin(np.clip(d[..., 2], -1.0, 1.0))
    return (lon + np.pi) / (2 * np.pi) * width - 0.5, (np.pi / 2 - lat) / np.pi * height - 0.5
