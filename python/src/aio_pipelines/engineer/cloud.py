"""Bounded reading of a point cloud around one asset, and ground removal.

Nothing here holds a whole scan: LAS files are streamed in chunks, each chunk is cropped to the
region and sampled with a seeded, uniform reservoir, so memory follows the region and the cap, not
the file. COPC (and other compressed) files go through PDAL with the region as a reader `bounds`,
so only that part is decompressed, and the result is streamed the same way.

Local frame: x east, y up, z south from the project origin `[E, N, H]`:
`local = (E - ox, H - oz, oy - N)`.
"""

from __future__ import annotations

import struct
from pathlib import Path
from typing import Any

import numpy as np

from ..modelfit.segment import ground_surface, read_kit_packed, read_png_packed
from ..runtime import JobError
from ..volumetric.cloud import LasHeader, read_las_chunks

Region = dict[str, Any]  # {"centre": [x, z], "radiusM": r} or {"min": [x, y, z], "max": [x, y, z]}
PDAL_FORMATS = ("copc", "laz")
LAS_FORMATS = ("las",)
READABLE = (*PDAL_FORMATS, *LAS_FORMATS, "kit-packed", "png-packed")


def _inside(xyz: np.ndarray, region: Region | None) -> np.ndarray:
    if region is None:
        return np.ones(len(xyz), dtype=bool)
    if "radiusM" in region:
        cx, cz = region["centre"]
        return np.hypot(xyz[:, 0] - cx, xyz[:, 2] - cz) <= float(region["radiusM"])
    lo = np.asarray(region["min"], dtype=np.float64)
    hi = np.asarray(region["max"], dtype=np.float64)
    return np.all((xyz >= lo) & (xyz <= hi), axis=1)


def _world_bounds(region: Region, origin: tuple[float, float, float]) -> str:
    """A PDAL `bounds` string (x east, y north, z up) that contains the region."""
    ox, oy, oz = origin
    if "radiusM" in region:
        cx, cz = region["centre"]
        r = float(region["radiusM"])
        return f"([{ox + cx - r},{ox + cx + r}],[{oy - cz - r},{oy - cz + r}])"
    (x0, y0, z0), (x1, y1, z1) = region["min"], region["max"]
    return f"([{ox + x0},{ox + x1}],[{oy - z1},{oy - z0}],[{oz + y0},{oz + y1}])"


def las_crs(path: Path) -> dict[str, Any] | None:
    """The CRS a LAS header declares: `{"epsg": n}` from the GeoTIFF keys, else `{"wkt": ...}`."""
    with open(path, "rb") as f:
        head = f.read(375)
        header_size = struct.unpack_from("<H", head, 94)[0]
        n_vlr = struct.unpack_from("<I", head, 100)[0]
        f.seek(header_size)
        wkt = None
        for _ in range(n_vlr):
            rec = f.read(54)
            if len(rec) < 54:
                break
            user = rec[2:18].split(b"\0")[0]
            rid, length = struct.unpack_from("<HH", rec, 18)
            body = f.read(length)
            if user != b"LASF_Projection":
                continue
            if rid == 34735 and len(body) >= 8:
                nkeys = struct.unpack_from("<H", body, 6)[0]
                for k in range(nkeys):
                    if 8 + 8 * k + 8 > len(body):
                        break
                    key, loc, _count, value = struct.unpack_from("<4H", body, 8 + 8 * k)
                    if key in (3072, 2048) and loc == 0 and value not in (0, 32767):
                        return {"epsg": int(value)}
            elif rid in (2111, 2112):
                text = body.split(b"\0")[0].decode("utf-8", "replace").strip()
                wkt = text or wkt
    return {"wkt": wkt} if wkt and len(wkt) <= 20000 else None


class _Reservoir:
    """A seeded uniform sample of at most `cap` points from a stream, memory bounded by 2 x cap."""

    def __init__(self, cap: int, seed: int):
        self.cap = max(1, int(cap))
        self.rng = np.random.default_rng(seed)
        self.pts: list[np.ndarray] = []
        self.keys: list[np.ndarray] = []
        self.size = 0
        self.threshold = 1.0

    def add(self, xyz: np.ndarray) -> None:
        if len(xyz) == 0:
            return
        u = self.rng.random(len(xyz))
        keep = u < self.threshold
        self.pts.append(xyz[keep])
        self.keys.append(u[keep])
        self.size += int(keep.sum())
        while self.size > 2 * self.cap:
            self.threshold *= 0.5
            pts, keys = np.concatenate(self.pts), np.concatenate(self.keys)
            m = keys < self.threshold
            self.pts, self.keys, self.size = [pts[m]], [keys[m]], int(m.sum())

    def result(self) -> np.ndarray:
        if not self.pts:
            return np.zeros((0, 3))
        pts, keys = np.concatenate(self.pts), np.concatenate(self.keys)
        if len(pts) > self.cap:
            pts = pts[np.argsort(keys, kind="stable")[: self.cap]]
        return pts


def _stream_las(
    las: Path, region: Region | None, origin: tuple[float, float, float], res: _Reservoir, check
) -> int:
    """Crop every chunk of a plain LAS to the region into `res`; return how many points were inside."""
    ox, oy, oz = origin
    inside = 0
    for x, y, z, _rgb in read_las_chunks(las, check):
        local = np.column_stack([x - ox, z - oz, oy - y])
        local = local[_inside(local, region)]
        inside += len(local)
        res.add(local)
    return inside


def read_region(
    layer_path: Path,
    fmt: str,
    region: Region | None,
    max_points: int,
    ctx: Any,
    origin: tuple[float, float, float] = (0.0, 0.0, 0.0),
    seed: int = 0,
) -> tuple[np.ndarray, dict[str, Any]]:
    """The points of a cloud inside `region` (local frame, or all when None), at most `max_points`.

    `origin` is the project origin `[E, N, H]`. Returns the local xyz and
    `{"read": points inside the region, "kept": points returned, "crs": {...} | None,
    "bounds": {"min", "max"} of the kept points | None}`. `read` counts what the region holds, not
    what the sample keeps. COPC and LAZ need PDAL (the region is its reader's `bounds`).
    """
    if fmt not in READABLE:
        raise JobError(f"A {fmt} cloud has an unsupported format; use COPC, LAS, kit-packed or png-packed.")
    check = getattr(ctx, "check", lambda: None)
    origin = (float(origin[0]), float(origin[1]), float(origin[2]))
    res = _Reservoir(max_points, seed)
    crs: dict[str, Any] | None = None
    if fmt == "las":
        LasHeader(layer_path)  # a clear error for a file that is not an uncompressed LAS
        crs = las_crs(layer_path)
        read = _stream_las(layer_path, region, origin, res, check)
    elif fmt in PDAL_FORMATS:
        from ..pointcloud import PDAL_MISSING, _run, find_pdal

        pdal = find_pdal()
        if not pdal:
            raise JobError(PDAL_MISSING)
        out = ctx.job.dir / "region.las"
        args = [pdal, "translate", str(layer_path), str(out)]
        if region is not None and fmt == "copc":
            args.append(f"--readers.copc.bounds={_world_bounds(region, origin)}")
        _run(ctx, args, "Read the asset region")
        try:
            crs = las_crs(out)
            read = _stream_las(out, region, origin, res, check)
        finally:
            out.unlink(missing_ok=True)
    else:
        pts = (
            read_kit_packed(layer_path)
            if fmt == "kit-packed"
            else read_png_packed(ctx.project, layer_path, check)
        )
        pts = pts[_inside(pts, region)]
        read = len(pts)
        res.add(pts)
    xyz = res.result()
    bounds = (
        {"min": [float(v) for v in xyz.min(axis=0)], "max": [float(v) for v in xyz.max(axis=0)]}
        if len(xyz)
        else None
    )
    return xyz, {"read": int(read), "kept": len(xyz), "crs": crs, "bounds": bounds}


def remove_ground(xyz: np.ndarray, dist: float) -> tuple[np.ndarray, int]:
    """The points at least `dist` above the ground surface (`modelfit.segment.ground_surface`),
    and how many were removed."""
    if len(xyz) == 0:
        return xyz, 0
    surface = ground_surface(xyz)
    keep = xyz[:, 1] >= surface(xyz[:, [0, 2]]) + dist
    return xyz[keep], int(len(xyz) - keep.sum())
