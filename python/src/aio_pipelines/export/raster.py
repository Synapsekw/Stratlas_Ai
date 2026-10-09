"""GeoTIFF (Cloud Optimized) writer for heights, differences and orthos, in any export frame.

The output grid is laid in the export frame (``frame.py``). When the frame is the project CRS itself
(the site grid with no other display CRS and no calibration) the grid *is* the source grid, so every
cell holds the source post exactly. Otherwise each output cell centre is taken back to the project
CRS by PROJ's inverse of the same operations and sampled there (bilinear for heights, nearest for an
ortho); heights then go forward through the frame for the vertical datum, geoid and calibration.

Rows are made a strip at a time, so a large surface is written in bounded memory: first a tiled
GeoTIFF, then copied by GDAL's COG driver (deflate, overviews). The file carries:

- the CRS: the horizontal CRS, compound with the vertical CRS when the heights are on a geoid with an
  EPSG code (GeoTIFF 1.1 vertical keys), or a local CRS for a calibrated site grid;
- the band's unit (metre, foot or US survey foot), nodata, and GDAL metadata items
  ``QUADRION_CRS``, ``QUADRION_VERTICAL_DATUM``, ``QUADRION_GEOID``, ``QUADRION_CALIBRATION``,
  ``QUADRION_UNITS`` and the whole statement in ``TIFFTAG_IMAGEDESCRIPTION``;
- and a sidecar note next to it (``<name>.txt``) with the same statement.
"""

from __future__ import annotations

import math
import os
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from ..runtime import JobError
from .frame import Frame

NODATA = -9999.0
STRIP = 256
#: The largest raster written (pixels); larger is refused with the cell that fits.
MAX_PIXELS = 1_500_000_000
BAND_UNIT = {"m": "metre", "ft": "foot", "us-ft": "US survey foot"}

#: Sample at project E, N (metres): (bands, k) values and a (k,) validity mask.
Sampler = Callable[[np.ndarray, np.ndarray], tuple[np.ndarray, np.ndarray]]


@dataclass
class OutGrid:
    x0: float  # west edge, output units
    y1: float  # north edge
    cx: float
    cy: float
    width: int
    height: int
    #: the output cells are the source cells (no resampling)
    exact: bool


def plan_grid(
    frame: Frame, box: tuple[float, float, float, float], cell: float, origin: tuple[float, float]
) -> OutGrid:
    """The output grid over the project-CRS ``box`` (min E, min N, max E, max N) of ``cell`` metres.

    ``origin`` is a corner of the source grid (cells are aligned to it when the frame is exact).
    """
    e0, n0, e1, n1 = box
    k = frame.k_h
    ce, cn = (e0 + e1) / 2, (n0 + n1) / 2
    x, y, _ = frame.forward(np.array([ce, ce + cell]), np.array([cn, cn + cell]))
    exact = (
        not frame.geographic
        and not frame.calibrated
        and abs(x[1] - x[0] - cell / k) < 1e-9 * max(1.0, cell / k)
        and abs(y[1] - y[0] - cell / k) < 1e-9 * max(1.0, cell / k)
        and abs(x[0] - ce / k) < 1e-6
        and abs(y[0] - cn / k) < 1e-6
    )
    if exact:
        i0 = math.floor((e0 - origin[0]) / cell + 1e-9)
        j0 = math.floor((n0 - origin[1]) / cell + 1e-9)
        i1 = math.ceil((e1 - origin[0]) / cell - 1e-9)
        j1 = math.ceil((n1 - origin[1]) / cell - 1e-9)
        w, h = max(1, i1 - i0), max(1, j1 - j0)
        return OutGrid(
            (origin[0] + i0 * cell) / k, (origin[1] + j1 * cell) / k, cell / k, cell / k, w, h, True
        )
    # the box's edge, 64 points a side, through the frame
    t = np.linspace(0.0, 1.0, 65)
    es = np.concatenate([e0 + (e1 - e0) * t, np.full(65, e1), e1 - (e1 - e0) * t, np.full(65, e0)])
    ns = np.concatenate([np.full(65, n0), n0 + (n1 - n0) * t, np.full(65, n1), n1 - (n1 - n0) * t])
    xs, ys, _ = frame.forward(es, ns)
    cx, cy = abs(x[1] - x[0]), abs(y[1] - y[0])
    if not (cx > 0 and cy > 0):
        raise JobError("The cell size could not be carried into the chosen coordinates.")
    if not frame.geographic:
        cx = cy = cell / k
    xa, xb, ya, yb = float(xs.min()), float(xs.max()), float(ys.min()), float(ys.max())
    x0 = math.floor(xa / cx) * cx
    y1 = math.ceil(yb / cy) * cy
    w = max(1, math.ceil((xb - x0) / cx))
    h = max(1, math.ceil((y1 - ya) / cy))
    return OutGrid(x0, y1, cx, cy, w, h, False)


def _crs(frame: Frame):
    from rasterio.crs import CRS

    if frame.calibrated:
        return CRS.from_wkt(frame.wkt)
    if frame.vertical_epsg and frame.epsg:
        try:
            return CRS.from_user_input(f"EPSG:{frame.epsg}+{frame.vertical_epsg}")
        except Exception:
            pass
    if frame.epsg:
        return CRS.from_epsg(frame.epsg)
    return CRS.from_wkt(frame.wkt)


def sidecar(path: Path, lines: list[str]) -> Path:
    note = path.with_suffix(".txt") if path.suffix.lower() != ".txt" else path.with_suffix(".note.txt")
    tmp = note.with_name(f".{note.name}.{os.getpid()}.tmp")
    tmp.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    os.replace(tmp, note)
    return note


def write_geotiff(
    path: Path,
    frame: Frame,
    grid: OutGrid,
    sample: Sampler,
    *,
    bands: int,
    kind: str,
    notes: list[str],
    check: Callable[[], None] = lambda: None,
    progress: Callable[[float], None] = lambda f: None,
) -> dict[str, object]:
    """Write a COG. ``kind``: ``height`` (frame heights), ``difference`` (dz in the height unit,
    no datum) or ``rgb`` (uint8 bands plus alpha). Returns a summary for the job's outputs."""
    import rasterio
    from rasterio.shutil import copy as rio_copy
    from rasterio.transform import from_origin

    if grid.width * grid.height > MAX_PIXELS:
        f = math.sqrt(grid.width * grid.height / MAX_PIXELS)
        raise JobError(
            f"The raster would be {grid.width:,} by {grid.height:,} cells; export a decimated copy "
            f"(cells about {f:.1f} times larger)."
        )
    rgb = kind == "rgb"
    dtype = "uint8" if rgb else "float32"
    count = bands + 1 if rgb else bands
    transform = from_origin(grid.x0, grid.y1, grid.cx, grid.cy)
    crs = _crs(frame)
    path.parent.mkdir(parents=True, exist_ok=True)
    work = path.with_name(f".{path.stem}.{os.getpid()}.work.tif")
    out_tmp = path.with_name(f".{path.stem}.{os.getpid()}.tmp.tif")
    profile = {
        "driver": "GTiff",
        "width": grid.width,
        "height": grid.height,
        "count": count,
        "dtype": dtype,
        "crs": crs,
        "transform": transform,
        "tiled": True,
        "blockxsize": 256,
        "blockysize": 256,
        "compress": "deflate",
        "BIGTIFF": "IF_SAFER",
    }
    if not rgb:
        profile["nodata"] = NODATA
    valid_cells = 0
    zmin, zmax = math.inf, -math.inf
    try:
        with rasterio.open(work, "w", **profile) as ds:
            xs = grid.x0 + (np.arange(grid.width) + 0.5) * grid.cx
            for r0 in range(0, grid.height, STRIP):
                check()
                r1 = min(grid.height, r0 + STRIP)
                ys = grid.y1 - (np.arange(r0, r1) + 0.5) * grid.cy
                X, Y = np.meshgrid(xs, ys)
                if grid.exact:
                    es, ns = X.ravel() * frame.k_h, Y.ravel() * frame.k_h
                else:
                    es, ns = frame.inverse_xy(X.ravel(), Y.ravel())
                vals, ok = sample(es, ns)
                ok = ok & np.isfinite(es) & np.isfinite(ns)
                if kind == "height":
                    _, _, z = frame.forward(es, ns, np.where(ok, vals[0], 0.0))
                    vals = z[None, :]
                elif kind == "difference":
                    vals = vals / frame.k_z
                if rgb:
                    out = np.zeros((count, r1 - r0, grid.width), np.uint8)
                    out[:bands] = np.clip(np.round(vals), 0, 255).astype(np.uint8).reshape(bands, r1 - r0, -1)
                    out[bands] = np.where(ok, 255, 0).reshape(r1 - r0, -1)
                else:
                    ok = ok & np.all(np.isfinite(vals), axis=0)
                    v = np.where(ok, vals, NODATA).astype(np.float32)
                    out = v.reshape(count, r1 - r0, -1)
                    if ok.any():
                        zmin = min(zmin, float(vals[:, ok].min()))
                        zmax = max(zmax, float(vals[:, ok].max()))
                valid_cells += int(ok.sum())
                ds.write(out, window=((r0, r1), (0, grid.width)))
                progress(r1 / grid.height)
            if rgb:
                from rasterio.enums import ColorInterp

                ds.colorinterp = [ColorInterp.red, ColorInterp.green, ColorInterp.blue, ColorInterp.alpha][
                    :count
                ]
            else:
                ds.set_band_unit(1, BAND_UNIT[frame.units])
                ds.set_band_description(1, "difference" if kind == "difference" else "height")
            m = frame.meta
            ds.update_tags(
                TIFFTAG_IMAGEDESCRIPTION="; ".join(notes),
                TIFFTAG_SOFTWARE="Quadrion AI survey.export",
                QUADRION_CRS=str(m["crs"]),
                QUADRION_VERTICAL_DATUM=str(m["verticalDatum"]),
                QUADRION_GEOID=str(m["geoid"] or "none"),
                QUADRION_CALIBRATION=str(m["calibration"] or "none"),
                QUADRION_UNITS=str(m["units"]),
            )
        if valid_cells == 0:
            raise JobError("The export has no cells with data in the chosen coordinates.")
        opts = {"COMPRESS": "DEFLATE", "BIGTIFF": "IF_SAFER", "OVERVIEWS": "AUTO"}
        if not rgb:
            opts["PREDICTOR"] = "YES"
        rio_copy(work, out_tmp, driver="COG", **opts)
        os.replace(out_tmp, path)
    finally:
        for p in (work, out_tmp):
            if p.exists():
                p.unlink()
    note = sidecar(path, notes)
    return {
        "width": grid.width,
        "height": grid.height,
        "cellX": grid.cx,
        "cellY": grid.cy,
        "exactGrid": grid.exact,
        "validCells": valid_cells,
        "min": None if not math.isfinite(zmin) else zmin,
        "max": None if not math.isfinite(zmax) else zmax,
        "note": str(note),
    }
