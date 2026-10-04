"""A point cloud as a survey date: a DSM (and, when the points carry colour, an ortho) GeoTIFF.

Not part of the Volumetric Survey Kit, which starts from Pix4D rasters. Uncompressed LAS
(1.0 to 1.4, point formats 0 to 10) is read here with numpy; LAZ, E57 and PLY are first
written to LAS by PDAL (``pdal translate``, the same PDAL ``pointcloud.to_copc`` uses), which
also reprojects to the project CRS when the file declares its own.

The DSM is the mean height of the points in each cell, the same estimator the kit's resample
uses on a DSM (a block mean); the colour raster is the mean colour. Cells without points stay
no data, except single empty cells inside the cloud, which take the mean of their neighbours
(sparse spots in a dense cloud, not real holes).
"""

from __future__ import annotations

import struct
from collections.abc import Callable
from pathlib import Path

import numpy as np

from ..runtime import JobError

# offset of the 16-bit R, G, B fields per point format
RGB_OFFSET = {2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30}
CHUNK = 2_000_000


class LasHeader:
    def __init__(self, path: Path):
        with open(path, "rb") as f:
            h = f.read(375)
        if len(h) < 227 or h[:4] != b"LASF":
            raise JobError(f"{path.name} is not a LAS file.")
        self.version = (h[24], h[25])
        self.offset = struct.unpack_from("<I", h, 96)[0]
        fmt = h[104]
        if fmt & 0x80 or fmt & 0x40:
            raise JobError(f"{path.name} is compressed (LAZ); it needs PDAL.")
        self.format = fmt & 0x3F
        self.record = struct.unpack_from("<H", h, 105)[0]
        count = struct.unpack_from("<I", h, 107)[0]
        if self.version >= (1, 4) and len(h) >= 255:
            count = count or struct.unpack_from("<Q", h, 247)[0]
        self.count = int(count)
        self.scale = struct.unpack_from("<3d", h, 131)
        self.offs = struct.unpack_from("<3d", h, 155)
        mx, nx, my, ny, mz, nz = struct.unpack_from("<6d", h, 179)
        self.bounds = (nx, ny, mx, my)
        self.zrange = (nz, mz)
        if self.format > 10:
            raise JobError(f"{path.name}: LAS point format {self.format} is not supported.")

    @property
    def has_rgb(self) -> bool:
        return self.format in RGB_OFFSET


def read_las_chunks(path: Path, check: Callable[[], None] = lambda: None):
    """Yield (x, y, z, rgb or None) arrays in chunks of up to CHUNK points."""
    h = LasHeader(path)
    raw = np.memmap(path, dtype=np.uint8, mode="r", offset=h.offset, shape=(h.count, h.record))
    for s in range(0, h.count, CHUNK):
        check()
        blk = np.ascontiguousarray(raw[s : s + CHUNK])
        xyz = blk[:, :12].view("<i4").astype(np.float64)
        x = xyz[:, 0] * h.scale[0] + h.offs[0]
        y = xyz[:, 1] * h.scale[1] + h.offs[1]
        z = xyz[:, 2] * h.scale[2] + h.offs[2]
        rgb = None
        if h.has_rgb:
            o = RGB_OFFSET[h.format]
            rgb = np.ascontiguousarray(blk[:, o : o + 6]).view("<u2").astype(np.float64)
        yield x, y, z, rgb
    del raw


def to_las(src: Path, dest: Path, epsg: int | None, run_pdal) -> Path:
    """LAZ, E57 or PLY to an uncompressed LAS through PDAL (reprojected to ``epsg``)."""
    stages: list = [str(src)]
    if epsg:
        stages.append({"type": "filters.reprojection", "out_srs": f"EPSG:{epsg}"})
    stages.append({"type": "writers.las", "filename": str(dest), "minor_version": 4, "dataformat_id": 7})
    run_pdal(stages)
    if not dest.is_file():
        raise JobError(f"PDAL did not write {dest.name}.")
    return dest


def rasterise(
    las: Path,
    grid: dict,
    dsm_out: Path,
    rgb_out: Path | None,
    epsg: int | None,
    check: Callable[[], None] = lambda: None,
    progress: Callable[[float], None] = lambda f: None,
) -> dict:
    """Mean height (and colour) per ``grid.dsm_res`` cell over the job grid, as GeoTIFFs."""
    import rasterio
    from rasterio.transform import from_origin
    from scipy import ndimage as ndi

    res = grid["dsm_res"]
    X0, Y1 = grid["x0"], grid["y1"]
    W = round((grid["x1"] - grid["x0"]) / res)
    H = round((grid["y1"] - grid["y0"]) / res)
    h = LasHeader(las)
    n = W * H
    s = np.zeros(n)
    c = np.zeros(n, np.int64)
    col = np.zeros((3, n)) if (rgb_out is not None and h.has_rgb) else None
    seen = 0
    cmax = 0.0
    for x, y, z, rgb in read_las_chunks(las, check):
        ci = np.floor((x - X0) / res).astype(np.int64)
        ri = np.floor((Y1 - y) / res).astype(np.int64)
        ok = (ci >= 0) & (ci < W) & (ri >= 0) & (ri < H)
        idx = ri[ok] * W + ci[ok]
        s += np.bincount(idx, weights=z[ok], minlength=n)
        c += np.bincount(idx, minlength=n)
        if col is not None and rgb is not None:
            for k in range(3):
                col[k] += np.bincount(idx, weights=rgb[ok, k], minlength=n)
            cmax = max(cmax, float(rgb[ok].max()) if ok.any() else 0.0)
        seen += len(x)
        progress(min(0.95, seen / max(1, h.count)))
    if not c.any():
        raise JobError(f"No point of {las.name} falls inside the survey grid.")
    with np.errstate(invalid="ignore", divide="ignore"):
        dsm = (s / c).reshape(H, W)
    empty = (c == 0).reshape(H, W)
    # single empty cells inside the cloud take the mean of their (at least 5 of 8) neighbours
    nb = ndi.convolve((~empty).astype(np.int32), np.ones((3, 3), np.int32), mode="constant") - (~empty)
    filled = np.where(empty, 0, dsm)
    sums = ndi.convolve(filled, np.ones((3, 3)), mode="constant")
    lone = empty & (nb >= 5)
    dsm[lone] = sums[lone] / nb[lone]
    nodata = -10000.0
    profile = {
        "driver": "GTiff",
        "height": H,
        "width": W,
        "transform": from_origin(X0, Y1, res, res),
        "tiled": True,
        "compress": "deflate",
    }
    if epsg:
        profile["crs"] = f"EPSG:{epsg}"
    dsm_out.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(dsm_out, "w", count=1, dtype="float32", nodata=nodata, **profile) as d:
        d.write(np.where(np.isnan(dsm), nodata, dsm).astype(np.float32), 1)
    has_colour = False
    if col is not None and rgb_out is not None:
        scale = 257.0 if cmax > 255 else 1.0
        img = np.zeros((4, H, W), np.uint8)
        with np.errstate(invalid="ignore", divide="ignore"):
            for k in range(3):
                img[k] = np.nan_to_num(np.round(col[k] / c / scale), nan=0).clip(0, 255).reshape(H, W)
        img[3] = np.where(empty, 0, 255)
        with rasterio.open(rgb_out, "w", count=4, dtype="uint8", **profile) as d:
            d.write(img)
        has_colour = True
    progress(1.0)
    return {"points": h.count, "cells": int((~np.isnan(dsm)).sum()), "colour": has_colour}
