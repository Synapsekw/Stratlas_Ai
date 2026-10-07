"""packs.terrain: a DEM to Terrarium-encoded tiles in PMTiles, with its vertical datum.

Parameters as ``TerrainPackParams`` in ``@aio/schema`` ``jobs.ts``. Writes ``<id>.pmtiles`` and
``<id>.json`` (``aio.raster-pack/1``, ``encoding: terrarium``, ``verticalDatum``) into ``dest``,
the data folder's ``packs/terrain``. One archive serves MapLibre (``raster-dem``), the site view
(3DTilesRendererJS ``TerrariumMeshPlugin``) and the Globe.

Terrarium: ``height = R * 256 + G + B / 256 - 32768`` metres, so heights round to 1/256 m. Tiles
are lossless (WebP lossless or PNG): a lossy codec would turn colour noise into metres. Heights
stay in the source's vertical datum (EGM2008 for Copernicus GLO-30), named in the metadata; the
Globe adds the geoid separation. Pixels no source covers take the nearest known height in the
tile, so a pack's edge does not fall to sea level.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

import numpy as np

from ..runtime import JobError, Step, StepContext
from .pmtiles_writer import tile_bytes_of
from .raster import (
    PackFiles,
    build_pyramid,
    common_params,
    expand_sources,
    grid_2x2,
    intersects,
    pack_meta,
    pmtiles_metadata,
    scan_sources,
    tile_bounds_lonlat,
    tile_transform,
    warp_one,
    zoom_range,
)

DATUMS = ("egm2008", "egm96", "ellipsoid")
FORMATS = ("webp", "png")
TILE_SIZE = 256
#: Terrarium covers -32768 to 32767.996 m.
LOWEST, HIGHEST = -32768.0, 32767.99609375


def terrarium_encode(heights: np.ndarray) -> np.ndarray:
    """Heights (h, w) in metres to Terrarium RGB uint8 (h, w, 3), rounded to 1/256 m."""
    h = np.clip(np.nan_to_num(heights, nan=0.0), LOWEST, HIGHEST)
    n = np.rint((h.astype(np.float64) + 32768.0) * 256.0).astype(np.int64)
    n = np.clip(n, 0, (1 << 24) - 1)
    rgb = np.stack([(n >> 16) & 255, (n >> 8) & 255, n & 255], axis=-1)
    return rgb.astype(np.uint8)


def terrarium_decode(rgb: np.ndarray) -> np.ndarray:
    r = rgb[..., 0].astype(np.float64)
    g = rgb[..., 1].astype(np.float64)
    b = rgb[..., 2].astype(np.float64)
    return r * 256.0 + g + b / 256.0 - 32768.0


def fill_gaps(heights: np.ndarray) -> np.ndarray:
    """NaN pixels take the nearest known height (all-NaN stays NaN)."""
    holes = ~np.isfinite(heights)
    if not holes.any() or holes.all():
        return heights
    from scipy.ndimage import distance_transform_edt

    _, (iy, ix) = distance_transform_edt(holes, return_distances=True, return_indices=True)
    return heights[iy, ix]


def downsample_heights(big: np.ndarray) -> np.ndarray:
    """Halve a height tile: the mean of each 2 x 2 block, ignoring unknown pixels."""
    h, w = big.shape
    blocks = big.reshape(h // 2, 2, w // 2, 2)
    known = np.isfinite(blocks)
    total = np.where(known, blocks, 0.0).sum(axis=(1, 3))
    count = known.sum(axis=(1, 3))
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(count > 0, total / count, np.nan).astype(np.float32)


class TerrainPack:
    name = "packs.terrain"
    title = "Terrain pack"
    description = "A DEM to an offline terrain pack (Terrarium tiles) with its vertical datum."

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        out = common_params(params, self.name, {"verticalDatum", "format"})
        datum = params.get("verticalDatum")
        if datum is None:
            raise JobError(f"{self.name} needs: verticalDatum.")
        if datum not in DATUMS:
            raise JobError(f"verticalDatum must be one of: {', '.join(sorted(DATUMS))}.")
        fmt = params.get("format", "webp")
        if fmt not in FORMATS:
            raise JobError(f"format must be one of: {', '.join(sorted(FORMATS))}.")
        return out

    def inputs(self, params: dict[str, Any]) -> list[str]:
        return list(params["src"])

    def plan(self, params: dict[str, Any]) -> list[Step]:
        fmt: str = params.get("format", "webp")
        files = PackFiles(Path(params["dest"]), params["id"])

        def scan(ctx: StepContext) -> dict[str, Any]:
            sources = scan_sources(expand_sources(params["src"]))
            bounds, lo, hi = zoom_range(params, sources, TILE_SIZE)
            ctx.log(f"{len(sources)} DEM file(s); zoom {lo} to {hi}")
            return {
                "sources": [str(s.path) for s in sources],
                "wgs": [list(s.bounds) for s in sources],
                "bounds": list(bounds),
                "minZoom": lo,
                "maxZoom": hi,
            }

        def tiles(ctx: StepContext) -> dict[str, Any]:
            import rasterio
            from PIL import Image

            plan = ctx.outputs("scan")
            bounds = tuple(plan["bounds"])
            lo, hi = int(plan["minZoom"]), int(plan["maxZoom"])
            opened = [rasterio.open(p) for p in plan["sources"]]
            try:
                wgs = [tuple(b) for b in plan["wgs"]]

                def leaf(z: int, x: int, y: int) -> np.ndarray | None:
                    tf = tile_transform(z, x, y, TILE_SIZE)
                    lonlat = tile_bounds_lonlat(z, x, y)
                    out: np.ndarray | None = None
                    for ds, box in zip(opened, wgs, strict=True):
                        if not intersects(lonlat, box):
                            continue
                        vals, valid = warp_one(ds, [1], tf, TILE_SIZE, resampling="bilinear", alpha=False)
                        if not valid.any():
                            continue
                        if out is None:
                            out = np.where(valid, vals[0], np.nan).astype(np.float32)
                        else:
                            empty = ~np.isfinite(out)
                            out[empty & valid] = vals[0][empty & valid]
                    return out

                def merge(kids: list[np.ndarray | None]) -> np.ndarray | None:
                    big = grid_2x2(kids, (TILE_SIZE, TILE_SIZE), np.nan)
                    return None if big is None else downsample_heights(big)

                writer = files.writer(fmt)
                try:

                    def store(z: int, x: int, y: int, arr: np.ndarray) -> None:
                        if not np.isfinite(arr).any():
                            return
                        img = Image.fromarray(terrarium_encode(fill_gaps(arr)), "RGB")
                        writer.add(z, x, y, tile_bytes_of(img, fmt, lossless=True))

                    t0 = time.monotonic()
                    build_pyramid(ctx, bounds, lo, hi, leaf, merge, store)
                    meta = pack_meta(
                        params,
                        kind="terrain",
                        bounds=bounds,
                        lo=lo,
                        hi=hi,
                        tile_size=TILE_SIZE,
                        fmt=fmt,
                        # The contract has no customer flag for terrain yet (proposed to G0).
                        customer=False,
                        extra={"encoding": "terrarium", "verticalDatum": params["verticalDatum"]},
                    )
                    counts = writer.finish(
                        bounds=bounds, metadata=pmtiles_metadata(meta), min_zoom=lo, max_zoom=hi
                    )
                except BaseException:
                    writer.abort()
                    raise
                ctx.log(
                    f"{counts['tiles']} tiles ({counts['contents']} distinct) in {time.monotonic() - t0:.1f} s"
                )
                return {"meta": meta, **counts}
            finally:
                for ds in opened:
                    ds.close()

        def commit(ctx: StepContext) -> dict[str, Any]:
            meta = ctx.outputs("tiles")["meta"]
            files.commit(meta)
            return {
                "pack": {"id": meta["id"], "kind": "terrain", "path": str(files.final)},
                "tiles": ctx.outputs("tiles").get("tiles", 0),
            }

        return [
            Step("scan", "Read the DEM", scan, 0.05),
            Step("tiles", "Make the terrain tiles", tiles, 0.9),
            Step("commit", "Install the pack", commit, 0.05),
        ]
