"""Height grids for ``photo.products``: north-up grids, GeoTIFF and COG writing, and viewing.

ODM makes the DSM and DTM (``odm/outputs.py`` imports them onto these grids).

- **Grids**: ``GridSpec`` (a north-up grid in the project CRS), ``write_tif`` window by window,
  ``read_grid`` and ``read_window``, and ``to_cog`` (a Cloud Optimised GeoTIFF with overviews,
  GDAL's COG driver).
- **Viewing**: a hypsometric colour ramp under a hillshade (RGBA GeoTIFF) for the ``kit-pyramid``
  layer, and the measured heights as an ``aio.grid/1`` 16-bit PNG in ``sources/<layer id>``, which
  ``change.surface`` and the volume tools read (``change/sources.py``).
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from ..runtime import JobError, replace_over

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


def read_window(path: Path, c0: int, r0: int, w: int, h: int, band: int = 1) -> np.ndarray:
    import rasterio
    from rasterio.windows import Window

    with rasterio.open(path) as ds:
        a = ds.read(band, window=Window(c0, r0, w, h), masked=True, boundless=True)
    return np.where(np.ma.getmaskarray(a), np.nan, a.astype(np.float64))


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
