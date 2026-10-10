"""DSM and DTM: the dense cloud gridded at the chosen cell size, written window by window.

- **DSM**: per cell the median height of the fused points (robust to stray points and to the odd
  wall point in a roof cell), holes up to ``fill_m`` across filled from their nearest neighbours,
  larger gaps left empty (nodata). Written as a tiled GeoTIFF one window at a time, then copied to
  a Cloud Optimised GeoTIFF with overviews (GDAL's COG driver).
- **DTM**: the ground under buildings, piles and vehicles. With PDAL (``filters.smrf`` on the
  dense cloud, ground points gridded by ``writers.gdal``), else the same Simple Morphological
  Filter (Pingel, Clarke and McBride 2013) on the minimum-height grid: progressively larger
  openings mark cells that rise faster than the slope allows as objects; the ground left is
  interpolated under them (push-pull). The DTM is then the DSM wherever the DSM is ground.
- **Viewing**: a hypsometric colour ramp under a hillshade (RGBA GeoTIFF) for the ``kit-pyramid``
  layer, and the measured heights as an ``aio.grid/1`` 16-bit PNG in ``sources/<layer id>``, which
  ``change.surface`` and the volume tools read (``change/sources.py``).
"""

from __future__ import annotations

import json
import math
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from ..runtime import JobError, replace_over
from .fuse import PointTiles

NODATA = -9999.0
BLOCK = 1024


@dataclass(frozen=True)
class GridSpec:
    """A north-up grid in the project CRS: ``x0`` left easting, ``y1`` top northing."""

    x0: float
    y1: float
    res: float
    width: int
    height: int

    @classmethod
    def around(
        cls, lo: tuple[float, float], hi: tuple[float, float], res: float, pad: float = 0.0
    ) -> GridSpec:
        x0 = math.floor((lo[0] - pad) / res) * res
        y1 = math.ceil((hi[1] + pad) / res) * res
        w = max(1, math.ceil((hi[0] + pad - x0) / res))
        h = max(1, math.ceil((y1 - (lo[1] - pad)) / res))
        return cls(x0, y1, res, w, h)

    @property
    def bounds(self) -> tuple[float, float, float, float]:
        return self.x0, self.y1 - self.height * self.res, self.x0 + self.width * self.res, self.y1

    def transform(self):
        from rasterio.transform import from_origin

        return from_origin(self.x0, self.y1, self.res, self.res)

    def windows(self, block: int = BLOCK):
        for r in range(0, self.height, block):
            for c in range(0, self.width, block):
                yield c, r, min(block, self.width - c), min(block, self.height - r)

    def centres(self, c0: int, r0: int, w: int, h: int) -> tuple[np.ndarray, np.ndarray]:
        xs = self.x0 + (np.arange(c0, c0 + w) + 0.5) * self.res
        ys = self.y1 - (np.arange(r0, r0 + h) + 0.5) * self.res
        return np.meshgrid(xs, ys)


def cell_stat(
    xyz: np.ndarray, x0: float, y1: float, res: float, w: int, h: int, stat: str = "median"
) -> np.ndarray:
    """Per-cell statistic of point heights over a (h, w) grid; NaN where no point falls."""
    out = np.full(h * w, np.nan)
    if not len(xyz):
        return out.reshape(h, w)
    ci = np.floor((xyz[:, 0] - x0) / res).astype(np.int64)
    ri = np.floor((y1 - xyz[:, 1]) / res).astype(np.int64)
    ok = (ci >= 0) & (ci < w) & (ri >= 0) & (ri < h)
    key, z = ri[ok] * w + ci[ok], xyz[ok, 2]
    if stat == "max":
        acc = np.full(h * w, -np.inf)
        np.maximum.at(acc, key, z)
        out = np.where(np.isfinite(acc), acc, np.nan)
    elif stat == "min":
        acc = np.full(h * w, np.inf)
        np.minimum.at(acc, key, z)
        out = np.where(np.isfinite(acc), acc, np.nan)
    else:
        order = np.lexsort((z, key))
        key, z = key[order], z[order]
        starts = np.r_[0, np.nonzero(np.diff(key))[0] + 1]
        ends = np.r_[starts[1:], len(key)]
        mid = (starts + ends - 1) / 2
        lo, hi = np.floor(mid).astype(np.int64), np.ceil(mid).astype(np.int64)
        out[key[starts]] = (z[lo] + z[hi]) / 2
    return out.reshape(h, w)


def fill_near(a: np.ndarray, radius_cells: float) -> np.ndarray:
    """Fill NaN cells within ``radius_cells`` of data with the nearest value."""
    from scipy import ndimage

    hole = ~np.isfinite(a)
    if not hole.any() or hole.all():
        return a
    dist, (iy, ix) = ndimage.distance_transform_edt(hole, return_indices=True)
    out = a[iy, ix]
    out[dist > radius_cells] = np.nan
    return out


def push_pull(a: np.ndarray) -> np.ndarray:
    """Fill every NaN with a smooth interpolation of the values around it (pyramid push-pull)."""
    ok = np.isfinite(a)
    if ok.all() or not ok.any():
        return a
    levels = [(np.where(ok, a, 0.0), ok.astype(np.float64))]
    while min(levels[-1][0].shape) > 1:
        v, w = levels[-1]
        h2, w2 = math.ceil(v.shape[0] / 2), math.ceil(v.shape[1] / 2)
        pv = np.zeros((h2 * 2, w2 * 2))
        pw = np.zeros((h2 * 2, w2 * 2))
        pv[: v.shape[0], : v.shape[1]] = v * w
        pw[: v.shape[0], : v.shape[1]] = w
        sv = pv.reshape(h2, 2, w2, 2).sum((1, 3))
        sw = pw.reshape(h2, 2, w2, 2).sum((1, 3))
        with np.errstate(invalid="ignore", divide="ignore"):
            mv = np.where(sw > 0, sv / sw, 0.0)
        levels.append((mv, np.minimum(sw, 1.0)))
    v = levels[-1][0]
    for lv, lw in reversed(levels[:-1]):
        up = np.repeat(np.repeat(v, 2, 0), 2, 1)[: lv.shape[0], : lv.shape[1]]
        v = lw * lv + (1 - lw) * up
    return v


def harmonic_fill(a: np.ndarray, max_unknowns: int = 2_000_000) -> np.ndarray:
    """Fill NaN cells with the smoothest surface through the known ones (Laplace's equation, a
    membrane over each hole); push-pull when there are too many unknowns for a direct solve."""
    from scipy.sparse import coo_matrix
    from scipy.sparse.linalg import spsolve

    hole = ~np.isfinite(a)
    n = int(hole.sum())
    if n == 0 or n == a.size:
        return a
    if n > max_unknowns:
        return push_pull(a)
    h, w = a.shape
    idx = np.full(a.shape, -1, np.int64)
    idx[hole] = np.arange(n)
    rows, cols, vals = [], [], []
    rhs = np.zeros(n)
    deg = np.zeros(n)
    hy, hx = np.nonzero(hole)
    me = idx[hy, hx]
    for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
        ny, nx = hy + dy, hx + dx
        inside = (ny >= 0) & (ny < h) & (nx >= 0) & (nx < w)
        deg[me[inside]] += 1
        ny, nx, mi = ny[inside], nx[inside], me[inside]
        unknown = hole[ny, nx]
        rows.append(mi[unknown])
        cols.append(idx[ny[unknown], nx[unknown]])
        vals.append(-np.ones(int(unknown.sum())))
        np.add.at(rhs, mi[~unknown], a[ny[~unknown], nx[~unknown]])
    rows.append(np.arange(n))
    cols.append(np.arange(n))
    vals.append(deg)
    m = coo_matrix((np.concatenate(vals), (np.concatenate(rows), np.concatenate(cols))), shape=(n, n)).tocsr()
    # a hole region touching no known cell has no boundary: anchor it with the push-pull guess
    guess = push_pull(a)[hole]
    lonely = rhs == 0
    m = m + coo_matrix((lonely * 1e-6, (np.arange(n), np.arange(n))), shape=(n, n)).tocsr()
    rhs = rhs + lonely * 1e-6 * guess
    out = a.copy()
    out[hole] = spsolve(m, rhs)
    return out


def smrf_ground(
    zmin: np.ndarray,
    cell: float,
    slope: float = 0.15,
    window_m: float = 18.0,
    check: Callable[[], None] = lambda: None,
) -> np.ndarray:
    """Progressive morphological filter: True where a cell of the minimum surface is ground.

    As SMRF, openings grow one cell at a time up to ``window_m``; a cell is an object when it
    stands above the opening by more than the slope allows over that radius. Unlike SMRF's
    step-to-step difference, the height is measured from the original surface (as in Zhang's
    PMF), so smooth piles steeper than ``slope`` are found whole, not only their tops.
    """
    from scipy import ndimage

    have = np.isfinite(zmin)
    z = push_pull(zmin)
    is_object = np.zeros(z.shape, bool)
    last = z
    for r in range(1, max(1, math.ceil(window_m / cell / 2)) + 1):
        check()
        last = ndimage.grey_opening(last, size=(2 * r + 1, 2 * r + 1))
        is_object |= (z - last) > slope * r * cell
    # an object's foot rises less than the threshold of the widest window: take a margin of
    # about a metre around every object so the ground under it is interpolated from real ground
    is_object = ndimage.binary_dilation(is_object, iterations=max(1, round(1.5 / cell)))
    return have & ~is_object


def dtm_from(
    dsm: np.ndarray,
    zmin: np.ndarray,
    cell: float,
    threshold: float = 0.5,
    scalar: float = 1.25,
    slope: float = 0.15,
    window_m: float = 18.0,
    check: Callable[[], None] = lambda: None,
) -> np.ndarray:
    """A DTM on the grid of ``dsm``: SMRF ground cells kept, the rest interpolated beneath."""
    ground0 = smrf_ground(zmin, cell, slope, window_m, check)
    provisional = harmonic_fill(np.where(ground0, zmin, np.nan))
    gy, gx = np.gradient(provisional, cell)
    grade = np.hypot(gx, gy)
    with np.errstate(invalid="ignore"):
        ground = np.isfinite(dsm) & (dsm - provisional < threshold + scalar * grade)
    return harmonic_fill(np.where(ground, dsm, np.nan))


# --------------------------------------------------------------------------------- files


def write_tif(path: Path, spec: GridSpec, epsg: int | None, bands: int, dtype: str, nodata=None):
    import rasterio

    profile = {
        "driver": "GTiff",
        "width": spec.width,
        "height": spec.height,
        "count": bands,
        "dtype": dtype,
        "transform": spec.transform(),
        "tiled": True,
        "blockxsize": 256,
        "blockysize": 256,
        "compress": "deflate",
        "BIGTIFF": "IF_SAFER",
    }
    if epsg:
        profile["crs"] = f"EPSG:{epsg}"
    if nodata is not None:
        profile["nodata"] = nodata
    path.parent.mkdir(parents=True, exist_ok=True)
    return rasterio.open(path, "w", **profile)


def to_cog(src: Path, dst: Path, resampling: str = "average") -> None:
    """Copy a GeoTIFF to a Cloud Optimised GeoTIFF (tiled, DEFLATE, internal overviews)."""
    from rasterio.shutil import copy as rio_copy

    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(f".{dst.stem}.tmp.tif")
    rio_copy(
        str(src),
        str(tmp),
        driver="COG",
        COMPRESS="DEFLATE",
        BLOCKSIZE=512,
        OVERVIEW_RESAMPLING=resampling.upper(),
        BIGTIFF="IF_SAFER",
    )
    replace_over(tmp, dst)


def grid_points(
    tiles: PointTiles,
    spec: GridSpec,
    out: Path,
    epsg: int | None,
    fill_m: float,
    check: Callable[[], None],
    progress: Callable[[float, str | None], None],
    zmin_out: Path | None = None,
) -> dict[str, Any]:
    """DSM (median) and optionally the minimum-height grid, window by window, as GeoTIFFs."""
    from rasterio.windows import Window

    margin = max(2, math.ceil(fill_m / spec.res))
    wins = list(spec.windows())
    cells = 0
    zmin_ds = write_tif(zmin_out, spec, epsg, 1, "float32", NODATA) if zmin_out else None
    try:
        with write_tif(out, spec, epsg, 1, "float32", NODATA) as ds:
            for i, (c0, r0, w, h) in enumerate(wins):
                check()
                bx0 = spec.x0 + (c0 - margin) * spec.res
                by1 = spec.y1 - (r0 - margin) * spec.res
                bw, bh = w + 2 * margin, h + 2 * margin
                pts = tiles.fused_in(bx0, by1 - bh * spec.res, bx0 + bw * spec.res, by1)["xyz"]
                z = cell_stat(pts, bx0, by1, spec.res, bw, bh, "median")
                z = fill_near(z, fill_m / spec.res)[margin : margin + h, margin : margin + w]
                cells += int(np.isfinite(z).sum())
                ds.write(
                    np.where(np.isfinite(z), z, NODATA).astype(np.float32), 1, window=Window(c0, r0, w, h)
                )
                if zmin_ds is not None:
                    zm = cell_stat(pts, bx0, by1, spec.res, bw, bh, "min")[
                        margin : margin + h, margin : margin + w
                    ]
                    zmin_ds.write(
                        np.where(np.isfinite(zm), zm, NODATA).astype(np.float32),
                        1,
                        window=Window(c0, r0, w, h),
                    )
                progress((i + 1) / len(wins), f"Surface window {i + 1} of {len(wins)}")
    finally:
        if zmin_ds is not None:
            zmin_ds.close()
    return {"cells": cells, "coverage": round(cells / max(1, spec.width * spec.height), 4)}


def read_grid(path: Path, out_shape: tuple[int, int] | None = None) -> np.ndarray:
    """A single-band height GeoTIFF as float64 with NaN for nodata (optionally resampled)."""
    import rasterio
    from rasterio.enums import Resampling

    with rasterio.open(path) as ds:
        kw: dict[str, Any] = {}
        if out_shape:
            kw = {"out_shape": out_shape, "resampling": Resampling.average}
        a = ds.read(1, masked=True, **kw)
    return np.where(np.ma.getmaskarray(a), np.nan, a.astype(np.float64))


def coarse_spec(spec: GridSpec, cell: float, max_cells: int) -> GridSpec:
    """A coarser grid over the same ground (cells of at least ``cell``, at most ``max_cells``)."""
    f = max(1.0, cell / spec.res)
    while (spec.width / f) * (spec.height / f) > max_cells:
        f *= 1.25
    w, h = max(1, round(spec.width / f)), max(1, round(spec.height / f))
    return GridSpec(spec.x0, spec.y1, spec.res * spec.width / w, w, h)


def dtm_grid(
    dsm_path: Path,
    zmin_path: Path,
    spec: GridSpec,
    out: Path,
    epsg: int | None,
    budget: int,
    check: Callable[[], None],
    ground_tif: Path | None = None,
) -> dict[str, Any]:
    """The DTM, found on a coarse grid (1 m cells or the DSM's, within the memory budget) and
    written at the DSM's cell size: cells within 0.5 m of the ground keep the DSM's height, the
    rest the ground interpolated beneath. The ground comes from PDAL's SMRF when ``ground_tif``
    (its ground points gridded on the coarse grid, ``pdal_dtm_pipeline``) is given, else from
    our own filter on the minimum-height grid."""
    from rasterio.windows import Window
    from scipy import ndimage

    coarse = dtm_coarse(spec, budget)
    shape = (coarse.height, coarse.width)
    cell = coarse.res
    dsm_c = read_grid(dsm_path, shape)
    if ground_tif is not None:
        engine = "pdal-smrf"
        ground_c = read_grid_on(ground_tif, coarse, epsg)
        if not np.isfinite(ground_c).any():
            raise JobError("PDAL found no ground points; the DTM cannot be made.")
        dtm_c = harmonic_fill(ground_c)
    else:
        engine = "smrf-grid"
        dtm_c = dtm_from(dsm_c, read_grid(zmin_path, shape), cell, check=check)
    ground_cells = int(np.sum(np.isfinite(dsm_c) & (np.abs(dsm_c - dtm_c) < 0.25)))

    with write_tif(out, spec, epsg, 1, "float32", NODATA) as ds:
        for c0, r0, ww, hh in spec.windows():
            check()
            dsm = read_window(dsm_path, c0, r0, ww, hh)
            # the coarse DTM bilinearly at this window's cell centres
            ry = (np.arange(r0, r0 + hh) + 0.5) * spec.res / cell - 0.5
            rx = (np.arange(c0, c0 + ww) + 0.5) * spec.res / cell - 0.5
            gy, gx = np.meshgrid(ry, rx, indexing="ij")
            base = ndimage.map_coordinates(dtm_c, [gy, gx], order=1, mode="nearest")
            with np.errstate(invalid="ignore"):
                ground = np.isfinite(dsm) & (dsm - base < 0.5)
            dtm = np.where(ground, dsm, base)
            dtm[~np.isfinite(dsm)] = np.nan
            ds.write(
                np.where(np.isfinite(dtm), dtm, NODATA).astype(np.float32), 1, window=Window(c0, r0, ww, hh)
            )
    return {"engine": engine, "cell": round(cell, 4), "groundCells": ground_cells}


def dtm_coarse(spec: GridSpec, budget: int) -> GridSpec:
    """The coarse grid the ground is found on (shared by both engines)."""
    return coarse_spec(spec, max(1.0, spec.res), max(10_000, budget // 64))


def read_grid_on(path: Path, spec: GridSpec, epsg: int | None) -> np.ndarray:
    """A height GeoTIFF resampled onto ``spec`` (NaN where it has no data)."""
    import rasterio
    from rasterio.warp import Resampling, reproject

    out = np.full((spec.height, spec.width), np.nan, np.float32)
    with rasterio.open(path) as src:
        crs = src.crs or (f"EPSG:{epsg}" if epsg else None)
        reproject(
            rasterio.band(src, 1),
            out,
            src_nodata=src.nodata,
            dst_transform=spec.transform(),
            dst_crs=crs,
            dst_nodata=np.nan,
            resampling=Resampling.bilinear,
        )
    return out.astype(np.float64)


def read_window(path: Path, c0: int, r0: int, w: int, h: int, band: int = 1) -> np.ndarray:
    import rasterio
    from rasterio.windows import Window

    with rasterio.open(path) as ds:
        a = ds.read(band, window=Window(c0, r0, w, h), masked=True, boundless=True)
    return np.where(np.ma.getmaskarray(a), np.nan, a.astype(np.float64))


# ------------------------------------------------------------------------------ PDAL ground


def pdal_dtm_pipeline(las: Path, out: Path, spec: GridSpec, epsg: int | None) -> dict[str, Any]:
    """The PDAL pipeline for the DTM: SMRF ground points gridded on ``spec``, the coarse grid of
    ``dtm_coarse`` (PDAL holds its raster in memory, so it stays small)."""
    x0, y0, x1, y1 = spec.bounds
    return {
        "pipeline": [
            {
                "type": "readers.las",
                "filename": str(las),
                **({"override_srs": f"EPSG:{epsg}"} if epsg else {}),
            },
            {"type": "filters.assign", "value": "Classification = 1"},
            {"type": "filters.smrf", "slope": 0.15, "window": 18.0, "threshold": 0.5, "scalar": 1.25},
            {"type": "filters.range", "limits": "Classification[2:2]"},
            {
                "type": "writers.gdal",
                "filename": str(out),
                "resolution": spec.res,
                "output_type": "idw",
                "window_size": 6,
                "nodata": NODATA,
                "data_type": "float32",
                "bounds": f"([{x0}, {x1 - spec.res / 2}], [{y0 + spec.res / 2}, {y1}])",
                "gdalopts": "TILED=YES,COMPRESS=DEFLATE",
            },
        ]
    }


# ------------------------------------------------------------------------- viewing and measuring


RAMP = [
    (0.0, (44, 123, 182)),
    (0.25, (171, 217, 233)),
    (0.5, (255, 255, 191)),
    (0.75, (253, 174, 97)),
    (1.0, (215, 25, 28)),
]


def shade(z: np.ndarray, res: float, lo: float, hi: float) -> np.ndarray:
    """RGBA uint8: hypsometric colours from ``lo`` to ``hi`` under a hillshade (sun at 315/45)."""
    zf = np.where(np.isfinite(z), z, np.nanmean(z) if np.isfinite(z).any() else 0)
    gy, gx = np.gradient(zf, res)
    az, alt = math.radians(315), math.radians(45)
    slope = np.arctan(np.hypot(gx, gy))
    aspect = np.arctan2(-gx, gy)
    hs = np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect)
    hs = np.clip(0.35 + 0.65 * hs, 0, 1)
    t = np.clip((zf - lo) / max(1e-6, hi - lo), 0, 1)
    stops = np.array([s[0] for s in RAMP])
    out = np.zeros((*z.shape, 4), np.uint8)
    for k in range(3):
        ch = np.interp(t, stops, [s[1][k] for s in RAMP]) * hs
        out[..., k] = np.clip(np.round(ch), 0, 255)
    out[..., 3] = np.where(np.isfinite(z), 255, 0)
    return out


def height_range(path: Path, side: int = 2048) -> tuple[float, float]:
    """The 1st and 99th percentile heights, from a read of at most ``side`` cells a side."""
    import rasterio

    with rasterio.open(path) as ds:
        f = max(1.0, max(ds.width, ds.height) / side)
        shape = (max(1, round(ds.height / f)), max(1, round(ds.width / f)))
    z = read_grid(path, shape if f > 1 else None)
    ok = z[np.isfinite(z)]
    if not ok.size:
        raise JobError("The surface has no heights; the photos may not overlap enough.")
    lo, hi = np.percentile(ok, [1, 99])
    return float(lo), float(max(hi, lo + 0.5))


def shaded_tif(src: Path, dst: Path, spec: GridSpec, epsg: int | None, check) -> dict[str, Any]:
    """RGBA GeoTIFF of a height GeoTIFF (colour ramp and hillshade), window by window."""
    from rasterio.enums import ColorInterp
    from rasterio.windows import Window

    lo, hi = height_range(src)
    with write_tif(dst, spec, epsg, 4, "uint8") as ds:
        ds.colorinterp = [ColorInterp.red, ColorInterp.green, ColorInterp.blue, ColorInterp.alpha]
        for c0, r0, w, h in spec.windows():
            check()
            z = read_window(src, c0 - 1, r0 - 1, w + 2, h + 2)
            rgba = shade(z, spec.res, lo, hi)[1:-1, 1:-1]
            ds.write(np.moveaxis(rgba, -1, 0), window=Window(c0, r0, w, h))
    return {"legend": {"min": round(lo, 2), "max": round(hi, 2), "unit": "m"}}


def write_height_grid(
    src: Path,
    folder: Path,
    layer_id: str,
    spec: GridSpec,
    epsg: int | None,
    kind: str = "dsm",
    max_side: int = 4096,
) -> list[Path]:
    """``sources/<id>.json`` and ``<id>.png``: the heights as an ``aio.grid/1`` 16-bit grid."""
    from PIL import Image

    f = max(1, math.ceil(max(spec.width, spec.height) / max_side))
    h, w = math.ceil(spec.height / f), math.ceil(spec.width / f)
    z = read_grid(src, (h, w) if f > 1 else None)
    ok = np.isfinite(z)
    lo = float(np.floor(np.nanmin(z) - 1)) if ok.any() else 0.0
    hi = float(np.nanmax(z)) if ok.any() else 1.0
    scale = max(0.001, math.ceil((hi - lo) / 65000 * 1000) / 1000)
    raw = np.zeros(z.shape, np.uint16)
    raw[ok] = np.clip(np.round((z[ok] - lo) / scale), 1, 65535).astype(np.uint16)
    folder.mkdir(parents=True, exist_ok=True)
    png = folder / f"{layer_id}.png"
    Image.fromarray(raw).save(png)
    doc = {
        "schema": "aio.grid/1",
        "kind": kind,
        "file": png.name,
        "x0": spec.x0,
        "y1": spec.y1,
        "res": spec.res * f,
        "width": int(w),
        "height": int(h),
        "scale": scale,
        "offset": lo,
        "nodata": 0,
        **({"epsg": epsg} if epsg else {}),
    }
    js = folder / f"{layer_id}.json"
    js.write_text(json.dumps(doc, indent=1), "utf-8")
    return [js, png]
