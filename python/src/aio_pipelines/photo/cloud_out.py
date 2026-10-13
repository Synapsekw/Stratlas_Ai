"""The dense cloud as a classified COPC (``photo.products`` step ``cloud``).

1. ``write_las``: the fused tiles, one at a time, into one LAS 1.4 file (point format 7, colour),
   each point classified by its height above the DTM (``dtm-raw.tif``, sampled bilinearly):
   ground (2) from 0.5 m below to 0.2 m above it; 1 above or below that, and where the DTM has no
   height.
2. ``write_copc``: untwine (pipeline pack 0.6.1 and later) turns the LAS into a COPC out of core,
   keeping the classes, its progress read from ``--progress_debug``; its temporary files go where
   the caller says (the job's staging area). Without untwine, PDAL's ``writers.copc`` does it in
   memory, refused up front, naming untwine, when the cloud would not fit the memory budget.
   Both run through ``native.run_tool`` with the memory budget as their limit.
"""

from __future__ import annotations

import math
import re
import shutil
import struct
from collections.abc import Callable
from pathlib import Path
from typing import Any

import numpy as np

from ..runtime import JobError, StepContext, atomic_write_json, replace_over
from . import native
from .fuse import PointTiles

GROUND_BELOW_M = 0.5
GROUND_ABOVE_M = 0.2
LAS_SCALE = 0.001
#: Memory PDAL holds per point to write a COPC (point table and octree): the founder's 913 M
#: point run reached 123 GB with SMRF in the same pipeline, 135 bytes a point.
PDAL_COPC_BYTES_PER_POINT = 140
#: PDAL's writers.copc rate, points a second (measured 207,000 on 2 M points: Task 4 of the photo
#: scale plan).
PDAL_COPC_POINTS_PER_S = 200_000
UNTWINE_PROGRESS = re.compile(r"\((\d+)% done\)")
NO_COPC_TOOL = (
    "The point cloud needs untwine or PDAL, and this pipeline pack has neither. Install the full "
    "pipeline pack, or leave the point cloud out."
)
_REC = np.dtype(
    [("xyz", "<i4", 3), ("i", "<u2"), ("ret", "u1"), ("flags", "u1"), ("cls", "u1"), ("user", "u1"),
     ("angle", "<i2"), ("src", "<u2"), ("t", "<f8"), ("rgb", "<u2", 3)]
)  # fmt: skip
assert _REC.itemsize == 36


def classify(z: np.ndarray, ground: np.ndarray) -> np.ndarray:
    """LAS classes: 2 (ground) within ``GROUND_BELOW_M`` below and ``GROUND_ABOVE_M`` above the
    ground height, else 1 (also where the ground is NaN)."""
    d = z - ground
    with np.errstate(invalid="ignore"):
        g = (d >= -GROUND_BELOW_M) & (d <= GROUND_ABOVE_M)
    return np.where(g, 2, 1).astype(np.uint8)


class DtmSampler:
    """Heights of a north-up DTM GeoTIFF at points, bilinearly from its cell centres (the edge
    cells' heights out to the raster's edge). NaN outside the raster and wherever one of the four
    cells around a point has no data."""

    def __init__(self, path: Path):
        import rasterio

        self.ds = rasterio.open(path)
        t = self.ds.transform
        self.x0, self.y1, self.res = t.c, t.f, t.a

    def __call__(self, x: np.ndarray, y: np.ndarray) -> np.ndarray:
        from rasterio.windows import Window
        from scipy import ndimage

        if not len(x):
            return np.zeros(0)
        cf = (np.asarray(x) - self.x0) / self.res - 0.5
        rf = (self.y1 - np.asarray(y)) / self.res - 0.5
        w, h = self.ds.width, self.ds.height
        outside = (cf < -0.5) | (rf < -0.5) | (cf > w - 0.5) | (rf > h - 0.5)
        c0, r0 = max(0, math.floor(float(cf.min()))), max(0, math.floor(float(rf.min())))
        c1, r1 = min(w - 1, math.ceil(float(cf.max()))), min(h - 1, math.ceil(float(rf.max())))
        if c1 < c0 or r1 < r0:
            return np.full(len(cf), np.nan)
        a = self.ds.read(1, window=Window(c0, r0, c1 - c0 + 1, r1 - r0 + 1), masked=True)
        g = np.where(np.ma.getmaskarray(a), np.nan, a.astype(np.float64))
        out = ndimage.map_coordinates(g, [rf - r0, cf - c0], order=1, mode="nearest", prefilter=False)
        out[outside] = np.nan
        return out

    def close(self) -> None:
        self.ds.close()


def _las_header(n: int, lo: np.ndarray, mins: np.ndarray, maxs: np.ndarray) -> bytes:
    from datetime import UTC, datetime

    now = datetime.now(UTC)
    h = bytearray(375)
    h[0:4] = b"LASF"
    struct.pack_into("<H", h, 6, 0x10)
    h[24], h[25] = 1, 4
    h[26:37] = b"Quadrion AI"
    h[58:72] = b"photo.products"
    struct.pack_into("<HHHII", h, 90, now.timetuple().tm_yday, now.year, 375, 375, 0)
    h[104] = 7
    struct.pack_into("<H", h, 105, 36)
    struct.pack_into("<3d", h, 131, LAS_SCALE, LAS_SCALE, LAS_SCALE)
    struct.pack_into("<3d", h, 155, *lo)
    struct.pack_into("<6d", h, 179, maxs[0], mins[0], maxs[1], mins[1], maxs[2], mins[2])
    struct.pack_into("<Q", h, 247, n)
    struct.pack_into("<Q", h, 255, n)  # all first returns
    return bytes(h)


def write_las(
    path: Path,
    store: PointTiles,
    shift: np.ndarray,
    dtm: Path | None,
    check: Callable[[], None] = lambda: None,
    progress: Callable[[float, str | None], None] = lambda f, m=None: None,
) -> dict[str, int]:
    """The fused cloud as one LAS 1.4 file (point format 7: colour and class), one tile in memory
    at a time; ``shift`` takes model to project CRS coordinates, ``dtm`` (project CRS) gives the
    classes (all 1 without it). Answers ``points`` and ``ground``."""
    info = store.info()
    if not info.get("bounds"):
        raise JobError("The cloud is empty.")
    lo = np.floor(np.asarray(info["bounds"][0]) + shift)
    base = store.root / "fused"
    total = len([p for p in base.glob("*.npz") if not p.name.startswith(".")])
    sampler = DtmSampler(dtm) if dtm is not None else None
    n = ground = 0
    mins, maxs = np.full(3, np.inf), np.full(3, -np.inf)
    tmp = path.with_name(f".{path.name}.tmp")
    try:
        with open(tmp, "wb") as f:
            f.write(b"\0" * 375)
            for i, (_, part) in enumerate(store.fused()):
                check()
                xyz = part["xyz"] + shift
                if len(xyz):
                    r = np.zeros(len(xyz), _REC)
                    r["xyz"] = np.round((xyz - lo) / LAS_SCALE).astype("<i4")
                    r["ret"] = 0x11
                    if sampler is not None:
                        cls = classify(xyz[:, 2], sampler(xyz[:, 0], xyz[:, 1]))
                    else:
                        cls = np.ones(len(xyz), np.uint8)
                    r["cls"] = cls
                    r["rgb"] = part["rgb"].astype("<u2") * 257
                    f.write(r.tobytes())
                    real = r["xyz"] * LAS_SCALE + lo
                    mins, maxs = np.minimum(mins, real.min(0)), np.maximum(maxs, real.max(0))
                    n += len(xyz)
                    ground += int((cls == 2).sum())
                progress((i + 1) / max(1, total), f"Writing the cloud: tile {i + 1} of {total}")
            if not n:
                raise JobError("The cloud is empty.")
            f.seek(0)
            f.write(_las_header(n, lo, mins, maxs))
        replace_over(tmp, path)
    finally:
        if sampler is not None:
            sampler.close()
        tmp.unlink(missing_ok=True)  # a cancel or failure leaves no partial LAS
    return {"points": n, "ground": ground}


def untwine_args(exe: str, las: Path, out: Path, temp: Path, epsg: int | None) -> list[str]:
    args = [exe, "-i", str(las), "-o", str(out), "--temp_dir", str(temp), "--progress_debug"]
    return args + (["--a_srs", f"EPSG:{epsg}"] if epsg else [])


def pdal_copc_pipeline(las: Path, out: Path, epsg: int | None) -> dict[str, Any]:
    srs = f"EPSG:{epsg}" if epsg else None
    return {
        "pipeline": [
            {"type": "readers.las", "filename": str(las), **({"override_srs": srs} if srs else {})},
            {"type": "writers.copc", "filename": str(out), **({"a_srs": srs} if srs else {})},
        ]
    }


def untwine_progress(line: str) -> float | None:
    """The fraction an ``Untwine progress (N% done)`` line says, else None."""
    m = UNTWINE_PROGRESS.search(line)
    return min(100, int(m.group(1))) / 100 if m else None


def write_copc(
    ctx: StepContext,
    las: Path,
    out: Path,
    points: int,
    epsg: int | None,
    temp: Path,
    budget: int,
    progress: tuple[float, float] = (0.3, 0.95),
) -> str:
    """``las`` (``points`` points) as the COPC ``out``, with untwine, else PDAL. Answers which.
    The tool writes a temporary name beside ``out``, moved over it only on success; untwine's
    temporary folder (about 92 bytes a point, which it does not remove) and PDAL's pipeline file
    go whether the run succeeds, fails or is cancelled."""
    temp.mkdir(parents=True, exist_ok=True)
    ut, pj = temp / "untwine", temp / "copc-pipeline.json"
    part = out.with_name(f".tmp.{out.name}")  # keeps the .copc.laz ending untwine reads
    try:
        writer = _run_copc(ctx, las, part, points, epsg, temp, budget, progress, ut, pj)
        if not part.is_file():
            raise JobError(f"{writer} finished without writing the COPC file.")
        replace_over(part, out)
    finally:
        shutil.rmtree(ut, ignore_errors=True)
        pj.unlink(missing_ok=True)
        part.unlink(missing_ok=True)
    return writer


def _run_copc(
    ctx: StepContext,
    las: Path,
    out: Path,
    points: int,
    epsg: int | None,
    temp: Path,
    budget: int,
    progress: tuple[float, float],
    ut: Path,
    pj: Path,
) -> str:
    from ..pointcloud import find_pdal, pdal_env

    exe = native.find_tool("untwine")
    if exe:
        shutil.rmtree(ut, ignore_errors=True)  # a cancelled run's files
        ut.mkdir(parents=True, exist_ok=True)
        native.run_tool(
            ctx,
            untwine_args(exe, las, out, ut, epsg),
            "Building the COPC (untwine)",
            temp,
            expected_s=max(60.0, points / 2e6),
            progress=progress,
            memory_limit=budget,
            env=pdal_env(exe),
            on_output=untwine_progress,
        )
        return "untwine"
    pdal = find_pdal()
    if pdal is None:
        raise JobError(NO_COPC_TOOL)
    if points * PDAL_COPC_BYTES_PER_POINT > budget:
        raise JobError(
            f"The point cloud has {points:,} points, more than PDAL can turn into a COPC within "
            f"the memory budget ({budget / 1e9:.1f} GB). Install pipeline pack 0.6.1 or later, "
            "which brings untwine, or leave the point cloud out."
        )
    atomic_write_json(pj, pdal_copc_pipeline(las, out, epsg))
    native.run_tool(
        ctx,
        [pdal, "pipeline", str(pj)],
        "Building the COPC (PDAL)",
        temp,
        expected_s=max(30.0, points / PDAL_COPC_POINTS_PER_S),
        progress=progress,
        memory_limit=budget,
        env=pdal_env(pdal),
    )
    return "pdal"
