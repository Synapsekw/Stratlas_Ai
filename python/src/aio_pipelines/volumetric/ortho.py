"""Orthomosaic onto the job grid as WebP tiles, and the lower levels of the tile pyramid.

Ported from the Volumetric Survey Kit with the maths unchanged:

- ``resample_ortho``: ``resample.py`` ``run_ortho``. Block mean of the source pixels whose
  centres fall in each ``grid.ortho_res`` cell (alpha above 127 counts as data), 1024 px tiles
  anchored at the grid's top-left corner, written as ``<out>/<zmax>/<col>_<row>.webp``; tiles
  without data are not written. The kit's time budget became a resumable progress file holding
  the next tile row (``ortho_<epoch>.progress``), as in the kit.
  A source coarser than the cell (an ortho at a lower resolution than the grid, or point colours)
  would leave holes between its pixel centres; it is sampled bilinearly instead (an addition).
- ``build_pyramid``: ``pyramid.py``. Each level halves the next finer one (2 x 2 tiles pasted,
  Lanczos down to one tile).
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import numpy as np

from .grid import _bin_block, source_res

TILE_QUALITY = 80  # kit: WEBP quality=80, method=4


def ortho_shape(grid: dict) -> tuple[int, int, int, int]:
    """Pixels (H, W) of the finest level and its tile rows and columns."""
    res = grid["ortho_res"]
    tile = grid.get("tile", 1024)
    W = round((grid["x1"] - grid["x0"]) / res)
    H = round((grid["y1"] - grid["y0"]) / res)
    return H, W, int(np.ceil(H / tile)), int(np.ceil(W / tile))


def _rgba(d) -> list[int]:
    """Band indexes for R, G, B, alpha: the kit reads bands 1-4 (Pix4D transparent mosaics).
    A three-band ortho gets an alpha band computed from its no-data value (or all zero RGB)."""
    return [1, 2, 3, 4] if d.count >= 4 else [1, 2, 3]


def _sample_block(d, bands, ytop, nrows, res, W, X0) -> np.ndarray:
    """RGBA rows [0, nrows) below ytop sampled bilinearly from a coarser source."""
    import rasterio
    from rasterio.transform import from_origin
    from rasterio.warp import Resampling, reproject

    crs = d.crs or "EPSG:3857"
    out = np.zeros((nrows, W, 4), np.uint8)
    rgb = np.zeros((3, nrows, W), np.float32)
    for k, b in enumerate(bands[:3]):
        reproject(
            source=rasterio.band(d, b),
            destination=rgb[k],
            src_crs=crs,
            dst_transform=from_origin(X0, ytop, res, res),
            dst_crs=crs,
            resampling=Resampling.bilinear,
        )
    if len(bands) == 4:
        a = np.zeros((nrows, W), np.float32)
        reproject(
            source=rasterio.band(d, 4),
            destination=a,
            src_crs=crs,
            dst_transform=from_origin(X0, ytop, res, res),
            dst_crs=crs,
            resampling=Resampling.nearest,
        )
        valid = a > 127
    else:
        valid = ~np.all(rgb == (d.nodata if d.nodata is not None else 0), axis=0)
    if rgb.max() > 255:
        rgb = rgb / 257.0
    out[..., :3] = np.clip(np.round(np.moveaxis(rgb, 0, -1)), 0, 255).astype(np.uint8)
    out[..., 3] = np.where(valid, 255, 0)
    out[~valid] = 0
    return out


def resample_ortho(
    src: Path,
    grid: dict,
    out_dir: Path,
    prog: Path,
    check: Callable[[], None] = lambda: None,
    progress: Callable[[float], None] = lambda f: None,
) -> dict:
    import rasterio
    from PIL import Image

    res = grid["ortho_res"]
    TILE = grid.get("tile", 1024)
    X0, Y1 = grid["x0"], grid["y1"]
    H, _, nty, ntx = ortho_shape(grid)
    zmax = grid["zmax"]
    tdir = out_dir / str(zmax)
    tdir.mkdir(parents=True, exist_ok=True)
    start = int(prog.read_text().strip() or 0) if prog.exists() else 0
    SB = 256
    with rasterio.open(src) as d:
        bands = _rgba(d)
        nod = d.nodata
        coarse = source_res(d) > res * 1.01
        for ty in range(start, nty):
            try:
                check()
            except BaseException:
                prog.write_text(str(ty))
                raise
            buf = np.zeros((TILE, ntx * TILE, 4), np.uint8)
            for sb in range(0, TILE, SB):
                rb = ty * TILE + sb
                if rb >= H:
                    break
                ytop = Y1 - rb * res
                if coarse:
                    buf[sb : sb + SB] = _sample_block(d, bands, ytop, SB, res, ntx * TILE, X0)
                    continue
                arr, ix = _bin_block(d, bands, ytop, SB, res, ntx * TILE, X0)
                if arr is None:
                    continue
                if arr.dtype != np.uint8:  # 16-bit mosaics: scale to 8 bit as the kit's viewer expects
                    arr = np.clip(arr / 257.0, 0, 255).astype(np.uint8)
                if len(bands) == 3:
                    valid = ~np.all(arr == (nod if nod is not None else 0), axis=0)
                    arr = np.concatenate([arr, np.where(valid, 255, 0).astype(np.uint8)[None]], axis=0)
                ri, ci, okr, okc = ix
                sub = arr[:, okr][:, :, okc]
                v = sub[3] > 127
                idx = (ri[okr][:, None] * (ntx * TILE) + ci[okc][None, :])[v]
                N = SB * ntx * TILE
                c = np.bincount(idx, minlength=N)
                blk = np.zeros((N, 4), np.uint8)
                with np.errstate(invalid="ignore", divide="ignore"):
                    for b in range(3):
                        s = np.bincount(idx, weights=sub[b][v].astype(np.float64), minlength=N)
                        blk[:, b] = np.nan_to_num(np.round(s / c), nan=0).astype(np.uint8)
                blk[:, 3] = np.where(c > 0, 255, 0)
                buf[sb : sb + SB] = blk.reshape(SB, ntx * TILE, 4)
            for tx in range(ntx):
                t = buf[:, tx * TILE : (tx + 1) * TILE]
                if t[:, :, 3].max() == 0:
                    continue
                dest = tdir / f"{tx}_{ty}.webp"
                tmp = dest.with_name(f".{dest.stem}.tmp.webp")
                Image.fromarray(t, "RGBA").save(tmp, "WEBP", quality=TILE_QUALITY, method=4)
                tmp.replace(dest)
            prog.write_text(str(ty + 1))
            progress((ty + 1) / nty)
    prog.write_text(str(nty))
    return {"tiles": len(list(tdir.glob("*.webp"))), "cols": ntx, "rows": nty, "zmax": zmax}


def build_pyramid(tiles: Path, grid: dict, check: Callable[[], None] = lambda: None) -> dict[int, int]:
    """Levels zmax - 1 .. 0 from the finest tiles (kit pyramid.py). Returns tiles per level."""
    from PIL import Image

    T = grid.get("tile", 1024)
    zmax = grid["zmax"]
    counts = {zmax: len(list((tiles / str(zmax)).glob("*.webp")))}
    for z in range(zmax - 1, -1, -1):
        check()
        src = tiles / str(z + 1)
        dst = tiles / str(z)
        dst.mkdir(parents=True, exist_ok=True)
        have = {tuple(map(int, f.stem.split("_"))) for f in src.glob("*.webp") if not f.name.startswith(".")}
        parents = {(x // 2, y // 2) for x, y in have}
        for px, py in parents:
            im = Image.new("RGBA", (2 * T, 2 * T))
            for dx in (0, 1):
                for dy in (0, 1):
                    if (2 * px + dx, 2 * py + dy) in have:
                        with Image.open(src / f"{2 * px + dx}_{2 * py + dy}.webp") as t:
                            im.paste(t.convert("RGBA"), (dx * T, dy * T))
            out = dst / f"{px}_{py}.webp"
            tmp = out.with_name(f".{out.stem}.tmp.webp")
            im.resize((T, T), Image.LANCZOS).save(tmp, "WEBP", quality=TILE_QUALITY, method=4)
            tmp.replace(out)
        counts[z] = len(parents)
    return counts
