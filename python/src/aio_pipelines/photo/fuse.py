"""Fusion: depth maps to one dense cloud with colours and normals, in bounded memory.

Each photo's depth map is turned into world points; a point is kept when at least ``min_agree``
other photos see the same surface there (their depth maps agree within ``tolerance`` of the
depth: geometric consistency, as COLMAP's fusion does). Kept points carry the photo's colour and a
normal from the depth map's neighbours, turned towards the camera.

Points go to square ground tiles on disk (``PointTiles``) as they come, one chunk per photo and
tile; ``merge`` then averages each tile's points per voxel (the point spacing asked for), so a
surface seen by ten photos is one clean layer, not ten noisy ones. Only one tile is ever in
memory, whatever the size of the site.
"""

from __future__ import annotations

import json
import math
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .scene import Camera, View


@dataclass(frozen=True)
class FuseSettings:
    tolerance: float = 0.01
    min_agree: int = 1
    neighbours: int = 6


def world_points(view: View, cam: Camera, depth: np.ndarray, rays: np.ndarray | None = None) -> np.ndarray:
    """(h, w, 3) world points of a depth map (NaN where empty)."""
    r = cam.pixel_rays() if rays is None else rays
    pc = r.astype(np.float64) * depth[..., None].astype(np.float64)
    return (pc - view.t) @ view.r


def normals_of(points: np.ndarray, centre: np.ndarray) -> np.ndarray:
    """Unit normals (h, w, 3) from central differences of a point map, facing ``centre``."""
    dx = np.zeros_like(points)
    dy = np.zeros_like(points)
    dx[:, 1:-1] = points[:, 2:] - points[:, :-2]
    dy[1:-1, :] = points[2:, :] - points[:-2, :]
    n = np.cross(dx, dy)
    ln = np.linalg.norm(n, axis=-1, keepdims=True)
    with np.errstate(invalid="ignore", divide="ignore"):
        n = n / ln
    flip = np.sum(n * (centre - points), axis=-1) < 0
    n[flip] *= -1
    return n


def consistent(
    view: View,
    cam: Camera,
    depth: np.ndarray,
    others: list[tuple[View, Camera, np.ndarray]],
    settings: FuseSettings,
) -> tuple[np.ndarray, np.ndarray]:
    """World points (h, w, 3) of a depth map and how many other photos agree with each pixel."""
    pts = world_points(view, cam, depth)
    ok = np.isfinite(depth)
    agree = np.zeros(depth.shape, np.int32)
    flat = pts[ok]
    for ov, oc, od in others:
        x, y, z = ov.project(flat, oc)
        inside = (z > 0) & (x >= 0) & (y >= 0) & (x < oc.width) & (y < oc.height)
        xi = np.clip(np.floor(x).astype(np.int64), 0, oc.width - 1)
        yi = np.clip(np.floor(y).astype(np.int64), 0, oc.height - 1)
        dz = od[yi, xi]
        with np.errstate(invalid="ignore"):
            good = inside & np.isfinite(dz) & (np.abs(dz - z) <= settings.tolerance * z)
        a = agree[ok]
        a += good.astype(np.int32)
        agree[ok] = a
    return pts, agree


class PointTiles:
    """Points in square ground tiles under ``root``: ``chunks/<tile>/<name>.npz``, then
    ``fused/<tile>.npz`` after ``merge``. Coordinates are world (project CRS) float64."""

    def __init__(self, root: Path, tile: float):
        self.root = root
        self.tile = float(tile)

    def key(self, x: float, y: float) -> tuple[int, int]:
        return math.floor(x / self.tile), math.floor(y / self.tile)

    def add(self, name: str, xyz: np.ndarray, rgb: np.ndarray, normal: np.ndarray) -> int:
        if not len(xyz):
            return 0
        tx = np.floor(xyz[:, 0] / self.tile).astype(np.int64)
        ty = np.floor(xyz[:, 1] / self.tile).astype(np.int64)
        order = np.lexsort((ty, tx))
        tx, ty = tx[order], ty[order]
        xyz, rgb, normal = xyz[order], rgb[order], normal[order]
        cut = np.nonzero((np.diff(tx) != 0) | (np.diff(ty) != 0))[0] + 1
        for a, b in zip(np.r_[0, cut], np.r_[cut, len(tx)], strict=True):
            d = self.root / "chunks" / f"{tx[a]}_{ty[a]}"
            d.mkdir(parents=True, exist_ok=True)
            tmp = d / f".{name}.tmp.npz"
            np.savez(tmp, xyz=xyz[a:b], rgb=rgb[a:b], normal=normal[a:b].astype(np.float32))
            tmp.replace(d / f"{name}.npz")
        return len(xyz)

    def chunk_tiles(self) -> list[str]:
        base = self.root / "chunks"
        if not base.is_dir():
            return []
        return sorted(p.name for p in base.iterdir() if p.is_dir() and not p.name.startswith("."))

    def merge(
        self,
        voxel: float,
        keep: Callable[[np.ndarray], np.ndarray] | None = None,
        check: Callable[[], None] = lambda: None,
        progress: Callable[[float], None] = lambda f: None,
    ) -> dict:
        """Average each tile's points per voxel into ``fused/``; return counts and bounds."""
        out = self.root / "fused"
        out.mkdir(parents=True, exist_ok=True)
        names = self.chunk_tiles()
        total, lo, hi = 0, np.full(3, np.inf), np.full(3, -np.inf)
        for i, name in enumerate(names):
            check()
            dst = out / f"{name}.npz"
            if not dst.exists():
                parts = [np.load(p) for p in sorted((self.root / "chunks" / name).glob("*.npz"))]
                xyz = np.concatenate([p["xyz"] for p in parts])
                rgb = np.concatenate([p["rgb"] for p in parts])
                nrm = np.concatenate([p["normal"] for p in parts])
                for p in parts:
                    p.close()
                if keep is not None and len(xyz):
                    m = keep(xyz)
                    xyz, rgb, nrm = xyz[m], rgb[m], nrm[m]
                xyz, rgb, nrm, cnt = voxel_mean(xyz, rgb, nrm, voxel)
                tmp = out / f".{name}.tmp.npz"
                np.savez(tmp, xyz=xyz, rgb=rgb, normal=nrm, count=cnt)
                tmp.replace(dst)
            with np.load(dst) as z:
                xyz = z["xyz"]
                if len(xyz):
                    total += len(xyz)
                    lo = np.minimum(lo, xyz.min(0))
                    hi = np.maximum(hi, xyz.max(0))
            progress((i + 1) / max(1, len(names)))
        info = {
            "points": int(total),
            "tiles": len(names),
            "voxel": voxel,
            "bounds": [lo.tolist(), hi.tolist()] if total else None,
        }
        (out / "index.json").write_text(json.dumps(info), "utf-8")
        return info

    def fused(self) -> Iterator[tuple[str, dict[str, np.ndarray]]]:
        base = self.root / "fused"
        for p in sorted(base.glob("*.npz")) if base.is_dir() else []:
            if p.name.startswith("."):
                continue
            with np.load(p) as z:
                yield p.stem, {k: z[k] for k in z.files}

    def fused_in(self, x0: float, y0: float, x1: float, y1: float) -> dict[str, np.ndarray]:
        """Fused points inside a ground box (tiles that touch it are read, then clipped)."""
        kx0, ky0 = self.key(x0, y0)
        kx1, ky1 = self.key(x1, y1)
        parts: list[dict[str, np.ndarray]] = []
        for kx in range(kx0, kx1 + 1):
            for ky in range(ky0, ky1 + 1):
                p = self.root / "fused" / f"{kx}_{ky}.npz"
                if p.is_file():
                    with np.load(p) as z:
                        xyz = z["xyz"]
                        m = (xyz[:, 0] >= x0) & (xyz[:, 0] < x1) & (xyz[:, 1] >= y0) & (xyz[:, 1] < y1)
                        parts.append({k: z[k][m] for k in z.files})
        if not parts:
            return {
                "xyz": np.zeros((0, 3)),
                "rgb": np.zeros((0, 3), np.uint8),
                "normal": np.zeros((0, 3), np.float32),
                "count": np.zeros(0, np.int32),
            }
        return {k: np.concatenate([p[k] for p in parts]) for k in parts[0]}

    def info(self) -> dict:
        p = self.root / "fused" / "index.json"
        return json.loads(p.read_text("utf-8")) if p.is_file() else {"points": 0, "bounds": None}


def write_las_tiles(path: Path, store: PointTiles, shift: np.ndarray, scale: float = 0.001) -> int:
    """The fused cloud as one LAS 1.4 file (point format 7: colour, classification 1), written
    tile by tile (only one tile in memory); ``shift`` takes model to project CRS coordinates."""
    import struct
    from datetime import UTC, datetime

    info = store.info()
    if not info.get("bounds"):
        raise ValueError("The cloud is empty.")
    lo = np.floor(np.asarray(info["bounds"][0]) + shift)
    rec = np.dtype(
        [("xyz", "<i4", 3), ("i", "<u2"), ("ret", "u1"), ("flags", "u1"), ("cls", "u1"), ("user", "u1"),
         ("angle", "<i2"), ("src", "<u2"), ("t", "<f8"), ("rgb", "<u2", 3)]
    )  # fmt: skip
    assert rec.itemsize == 36
    n = 0
    mins, maxs = np.full(3, np.inf), np.full(3, -np.inf)
    tmp = path.with_name(f".{path.name}.tmp")
    with open(tmp, "wb") as f:
        f.write(b"\0" * 375)
        for _, part in store.fused():
            xyz = part["xyz"] + shift
            if not len(xyz):
                continue
            r = np.zeros(len(xyz), rec)
            r["xyz"] = np.round((xyz - lo) / scale).astype("<i4")
            r["ret"], r["cls"] = 0x11, 1
            r["rgb"] = part["rgb"].astype("<u2") * 257
            f.write(r.tobytes())
            real = r["xyz"] * scale + lo
            mins, maxs = np.minimum(mins, real.min(0)), np.maximum(maxs, real.max(0))
            n += len(xyz)
        now = datetime.now(UTC)
        h = bytearray(375)
        h[0:4] = b"LASF"
        struct.pack_into("<H", h, 6, 0x10)
        h[24], h[25] = 1, 4
        h[26:34] = b"Stratlas"
        h[58:72] = b"photo.products"
        struct.pack_into("<HHHII", h, 90, now.timetuple().tm_yday, now.year, 375, 375, 0)
        h[104] = 7
        struct.pack_into("<H", h, 105, 36)
        struct.pack_into("<3d", h, 131, scale, scale, scale)
        struct.pack_into("<3d", h, 155, *lo)
        struct.pack_into("<6d", h, 179, maxs[0], mins[0], maxs[1], mins[1], maxs[2], mins[2])
        struct.pack_into("<Q", h, 247, n)
        struct.pack_into("<Q", h, 255, n)  # all first returns
        f.seek(0)
        f.write(bytes(h))
    tmp.replace(path)
    return n


def voxel_mean(
    xyz: np.ndarray, rgb: np.ndarray, nrm: np.ndarray, voxel: float
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Average points per voxel; returns positions, colours, unit normals and point counts."""
    if not len(xyz):
        return xyz, rgb, nrm, np.zeros(0, np.int32)
    base = np.floor(xyz.min(0) / voxel)
    q = np.floor(xyz / voxel) - base
    q = q.astype(np.int64)
    span = q.max(0) + 1
    key = (q[:, 0] * span[1] + q[:, 1]) * span[2] + q[:, 2]
    _, inv, cnt = np.unique(key, return_inverse=True, return_counts=True)
    n = len(cnt)

    def mean(a: np.ndarray) -> np.ndarray:
        return (
            np.stack([np.bincount(inv, weights=a[:, k], minlength=n) for k in range(a.shape[1])], 1)
            / cnt[:, None]
        )

    p = mean(xyz)
    c = np.clip(np.round(mean(rgb.astype(np.float64))), 0, 255).astype(np.uint8)
    nn = mean(np.nan_to_num(nrm.astype(np.float64)))
    ln = np.linalg.norm(nn, axis=1, keepdims=True)
    nn = np.where(ln > 1e-9, nn / np.maximum(ln, 1e-12), [0.0, 0.0, 1.0]).astype(np.float32)
    return p, c, nn, cnt.astype(np.int32)
