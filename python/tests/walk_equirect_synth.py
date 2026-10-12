"""Equirectangular stills of a textured box room, ray-cast in numpy (``walk.sfm`` tests only).

Camera frame as COLMAP's: x right, y down, z forward. A pixel (u, v) of a W x H still looks along
longitude ``(u + 0.5) / W * 2 pi - pi`` (0 at the centre column, positive to the right) and
latitude ``(v + 0.5) / H * pi - pi / 2`` (negative up), the mapping of COLMAP's
``EQUIRECTANGULAR`` camera. World frame: x east, y down, z north, so gravity is +y.

Every face of the room has its own seeded texture (value noise of several octaves plus dark
blobs), so matching never meets a repeated pattern.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image

#: Room half extents (metres) around its centre, and the centre (camera height 1.5 m above the floor).
ROOM_HALF = np.array([6.0, 1.5, 4.0])
ROOM_CENTRE = np.array([0.0, 0.0, 0.0])
TEX = 1024  # texture pixels per face side
PX_PER_M = 96.0


def equirect_rays(width: int, height: int) -> np.ndarray:
    """Unit ray per pixel in the camera frame, (H, W, 3)."""
    lon = (np.arange(width) + 0.5) / width * 2 * np.pi - np.pi
    lat = (np.arange(height) + 0.5) / height * np.pi - np.pi / 2
    lon, lat = np.meshgrid(lon, lat)
    return np.stack([np.sin(lon) * np.cos(lat), np.sin(lat), np.cos(lon) * np.cos(lat)], axis=-1)


def _texture(rng: np.random.Generator) -> np.ndarray:
    tex = np.zeros((TEX, TEX), np.float32)
    amp = 1.0
    for cells in (8, 16, 32, 64, 128):
        g = rng.random((cells + 1, cells + 1)).astype(np.float32)
        img = Image.fromarray((g * 255).astype(np.uint8)).resize((TEX, TEX), Image.BICUBIC)
        tex += amp * (np.asarray(img, np.float32) / 255.0)
        amp *= 0.7
    tex = (tex - tex.min()) / (np.ptp(tex) + 1e-6)
    yy, xx = np.mgrid[0:TEX, 0:TEX]
    for _ in range(60):  # dark blobs: corners and edges SIFT keeps at every scale
        cx, cy, r = rng.integers(0, TEX), rng.integers(0, TEX), rng.integers(8, 40)
        tex[(xx - cx) ** 2 + (yy - cy) ** 2 < r * r] *= 0.25
    rgb = np.stack([tex, tex * rng.uniform(0.7, 1.0), tex * rng.uniform(0.6, 1.0)], axis=-1)
    return (rgb * 235 + 10).astype(np.uint8)


def face_textures(seed: int = 3) -> list[np.ndarray]:
    rng = np.random.default_rng(seed)
    return [_texture(rng) for _ in range(6)]


def render(pos: np.ndarray, R_wc: np.ndarray, rays: np.ndarray, textures: list[np.ndarray]) -> np.ndarray:
    """One still from camera centre ``pos`` with rotation ``R_wc`` (camera to world)."""
    d = rays.reshape(-1, 3) @ R_wc.T
    o = pos - ROOM_CENTRE
    with np.errstate(divide="ignore", invalid="ignore"):
        bound = np.where(d > 0, ROOM_HALF, -ROOM_HALF)
        t_axis = (bound - o) / d
    t_axis[~np.isfinite(t_axis) | (t_axis <= 0)] = np.inf
    axis = np.argmin(t_axis, axis=1)
    t = t_axis[np.arange(len(d)), axis]
    hit = o + d * t[:, None]
    face = axis * 2 + (d[np.arange(len(d)), axis] > 0)
    # the two in-face coordinates of each axis, in metres from the face corner
    uv_axes = {0: (2, 1), 1: (0, 2), 2: (0, 1)}
    out = np.zeros((len(d), 3), np.uint8)
    for f in range(6):
        sel = face == f
        if not sel.any():
            continue
        a, b = uv_axes[f // 2]
        u = ((hit[sel, a] + ROOM_HALF[a]) * PX_PER_M).astype(np.int64) % TEX
        v = ((hit[sel, b] + ROOM_HALF[b]) * PX_PER_M).astype(np.int64) % TEX
        out[sel] = textures[f][v, u]
    return out.reshape(rays.shape[0], rays.shape[1], 3)


def rot_y(a: float) -> np.ndarray:
    c, s = np.cos(a), np.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def rot_x(a: float) -> np.ndarray:
    c, s = np.cos(a), np.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


def make_stills(
    out_dir: Path, n: int = 24, width: int = 1024, height: int = 512, step: float = 0.25, seed: int = 3
) -> tuple[list[Path], np.ndarray, list[np.ndarray]]:
    """``n`` stills along a line through the room (x from -n*step/2), with a small yaw and pitch
    wobble. Returns the paths, the true centres (n, 3) and the true camera-to-world rotations."""
    out_dir.mkdir(parents=True, exist_ok=True)
    rays = equirect_rays(width, height)
    textures = face_textures(seed)
    paths, centres, rots = [], [], []
    for k in range(n):
        pos = np.array([-n * step / 2 + k * step, 0.0, 0.3 * np.sin(k / 5)])
        R = rot_y(0.6 + 0.08 * np.sin(k / 3)) @ rot_x(0.04 * np.cos(k / 4))
        img = render(pos, R, rays, textures)
        p = out_dir / f"still_{k:04d}.jpg"
        Image.fromarray(img).save(p, quality=92)
        paths.append(p)
        centres.append(pos)
        rots.append(R)
    return paths, np.array(centres), rots
