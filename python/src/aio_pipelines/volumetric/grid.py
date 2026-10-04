"""Resample a survey DSM onto the job's common grid. Ported from Volumetric Survey Kit ``resample.py``.

The output is a float32 ``.npy`` (NaN = no data, cell = grid.dsm_res, block mean of the source
pixels whose centres fall in the cell). It is written as a memory map, row block by row block,
with a ``.progress`` file holding the next block: a cancelled or crashed run continues from there.

The kit assumes a source finer than the grid (Pix4D DSMs at the GSD, a 0.1 m grid). A coarser
source would leave empty cells between its pixel centres, so it is sampled bilinearly instead
(``rasterio.warp.reproject``); that branch is an addition, the block mean is the kit's.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import numpy as np

BLOCK_ROWS = 128


def grid_shape(grid: dict) -> tuple[int, int]:
    res = grid["dsm_res"]
    W = round((grid["x1"] - grid["x0"]) / res)
    H = round((grid["y1"] - grid["y0"]) / res)
    return H, W


def _src_rows_for(ytop, ybot, d):
    """Source row range covering the target y band [ybot, ytop]."""
    t = d.transform
    r0 = int(np.floor((t.f - ytop) / -t.e)) - 1
    r1 = int(np.ceil((t.f - ybot) / -t.e)) + 1
    return max(0, r0), min(d.height, r1)


def _bin_block(d, bands, ytop, nrows, res, W, X0):
    """Block-mean the source pixels whose centres fall in target rows [0, nrows) below ytop."""
    from rasterio.windows import Window

    ybot = ytop - nrows * res
    r0, r1 = _src_rows_for(ytop, ybot, d)
    if r1 <= r0:
        return None, None
    t = d.transform
    arr = d.read(bands, window=Window(0, r0, d.width, r1 - r0))
    xs = t.c + (np.arange(d.width) + 0.5) * t.a
    ys = t.f + (np.arange(r0, r1) + 0.5) * t.e
    ci = np.floor((xs - X0) / res).astype(np.int64)
    ri = np.floor((ytop - ys) / res).astype(np.int64)
    okc = (ci >= 0) & (ci < W)
    okr = (ri >= 0) & (ri < nrows)
    return arr, (ri, ci, okr, okc)


def source_res(d) -> float:
    """Pixel size of a north-up raster (the larger of its two axes), in CRS units."""
    return max(abs(d.transform.a), abs(d.transform.e))


def _bilinear_block(d, ytop, nrows, res, W, X0):
    """Bilinear sample of band 1 at the centres of target rows [0, nrows) below ytop (NaN = no data)."""
    import rasterio
    from rasterio.transform import from_origin
    from rasterio.warp import Resampling, reproject

    # both sides share the job CRS; a raster without one is taken as already in it
    crs = d.crs or "EPSG:3857"
    dst = np.full((nrows, W), np.nan, np.float32)
    reproject(
        source=rasterio.band(d, 1),
        destination=dst,
        src_crs=crs,
        dst_transform=from_origin(X0, ytop, res, res),
        dst_crs=crs,
        dst_nodata=np.nan,
        src_nodata=d.nodata,
        resampling=Resampling.bilinear,
    )
    dst[dst < -9000] = np.nan
    return dst


def resample_dsm(
    src: Path,
    grid: dict,
    out: Path,
    check: Callable[[], None] = lambda: None,
    progress: Callable[[float], None] = lambda f: None,
) -> tuple[int, int]:
    import rasterio

    res = grid["dsm_res"]
    X0, Y1 = grid["x0"], grid["y1"]
    H, W = grid_shape(grid)
    prog = out.with_name(out.name + ".progress")
    if prog.exists() and prog.read_text().strip() == "done" and out.exists():
        return H, W
    if not out.exists() or not prog.exists():
        out.parent.mkdir(parents=True, exist_ok=True)
        m = np.lib.format.open_memmap(out, mode="w+", dtype=np.float32, shape=(H, W))
        m[:] = np.nan
        m.flush()
        del m
        prog.write_text("0")
    m = np.lib.format.open_memmap(out, mode="r+")
    start = int(prog.read_text().strip() or 0)
    try:
        with rasterio.open(src) as d:
            nod = d.nodata
            coarse = source_res(d) > res * 1.01
            for rb in range(start, H, BLOCK_ROWS):
                try:
                    check()
                except BaseException:
                    m.flush()
                    prog.write_text(str(rb))
                    raise
                n = min(BLOCK_ROWS, H - rb)
                ytop = Y1 - rb * res
                if coarse:
                    m[rb : rb + n] = _bilinear_block(d, ytop, n, res, W, X0)
                    arr = None
                else:
                    arr, ix = _bin_block(d, 1, ytop, n, res, W, X0)
                if arr is not None:
                    ri, ci, okr, okc = ix
                    z = arr[okr][:, okc]
                    v = (z > -9000) if nod is None else (z != nod) & (z > -9000)
                    idx = ri[okr][:, None] * W + ci[okc][None, :]
                    s = np.bincount(idx[v], weights=z[v].astype(np.float64), minlength=n * W)
                    c = np.bincount(idx[v], minlength=n * W)
                    with np.errstate(invalid="ignore", divide="ignore"):
                        blk = (s / c).reshape(n, W).astype(np.float32)
                    blk[c.reshape(n, W) == 0] = np.nan
                    m[rb : rb + n] = blk
                if (rb // BLOCK_ROWS) % 8 == 7:
                    m.flush()
                    prog.write_text(str(rb + n))
                progress(min(1.0, (rb + n) / H))
        m.flush()
    finally:
        del m
    prog.write_text("done")
    return H, W
