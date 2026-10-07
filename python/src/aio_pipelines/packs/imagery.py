"""packs.imagery: GeoTIFF or COG imagery to a raster PMTiles pack (WebP, Web Mercator).

Parameters as ``ImageryPackParams`` in ``@aio/schema`` ``jobs.ts``. Writes ``<id>.pmtiles`` and
``<id>.json`` (``aio.raster-pack/1``, data-conventions section 23) into ``dest``, the data folder's
``packs/imagery`` chosen by the app. The sources are read in place, never changed.

- 8-bit RGB or RGBA (and grey) are used as they are; other types (16-bit satellite products,
  floats) are stretched from their 2nd to 98th percentile per band, read from an overview.
- A four-band image that is not RGBA (RGB and near infrared) uses its first three bands.
- Pixels no source covers are transparent; tiles nothing covers are not stored.
- The licence and attribution the person gave (or the build tool's, for our own packs) go into
  the metadata and the archive, and ``customerLicence`` marks imported customer imagery
  (decision 12: never redistributed, left out of packages unless ticked).
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

import numpy as np

from ..params import number
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

FORMATS = ("webp", "png", "jpeg")


def band_plan(ds: Any) -> tuple[list[int], list[tuple[float, float]] | None]:
    """The colour bands to read and, for non-8-bit data, the stretch per band."""
    from rasterio.enums import ColorInterp

    interp = list(ds.colorinterp)
    colour = [i + 1 for i, c in enumerate(interp) if c != ColorInterp.alpha]
    bands = colour[:3] if len(colour) >= 3 else colour[:1]
    if not bands:
        raise JobError(f"{Path(ds.name).name} has no colour bands.")
    if ds.dtypes[0] == "uint8":
        return bands, None
    # A small overview read is enough for the percentiles.
    scale = max(1, max(ds.width, ds.height) // 1024)
    sample = ds.read(
        bands,
        out_shape=(len(bands), max(1, ds.height // scale), max(1, ds.width // scale)),
        masked=True,
    )
    stretch = []
    for b in range(len(bands)):
        vals = sample[b].compressed() if np.ma.isMaskedArray(sample) else sample[b].ravel()
        vals = vals[np.isfinite(vals)]
        if not vals.size:
            stretch.append((0.0, 1.0))
            continue
        lo, hi = np.percentile(vals, [2, 98])
        stretch.append((float(lo), float(hi) if hi > lo else float(lo) + 1.0))
    return bands, stretch


def to_rgba(values: np.ndarray, valid: np.ndarray, stretch: list[tuple[float, float]] | None) -> np.ndarray:
    """Tile values (1 or 3 bands) to RGBA float32 in 0..255, alpha 0 where nothing is known."""
    v = values.astype(np.float32)
    if stretch is not None:
        for b, (lo, hi) in enumerate(stretch):
            v[b] = (v[b] - lo) / (hi - lo) * 255.0
        v = np.clip(v, 0, 255)
    if v.shape[0] == 1:
        v = np.repeat(v, 3, axis=0)
    a = np.where(valid, 255.0, 0.0).astype(np.float32)[None]
    return np.concatenate([v, a], axis=0)


def downsample_rgba(big: np.ndarray) -> np.ndarray:
    """Halve an RGBA tile, averaging colour weighted by alpha (no dark fringes at edges)."""
    c, h, w = big.shape
    blocks = big.reshape(c, h // 2, 2, w // 2, 2)
    a = blocks[3]
    asum = a.sum(axis=(1, 3))
    rgb = (blocks[:3] * a[None]).sum(axis=(2, 4))
    with np.errstate(invalid="ignore", divide="ignore"):
        rgb = np.where(asum[None] > 0, rgb / asum[None], 0)
    alpha = asum / 4
    return np.concatenate([rgb, alpha[None]], axis=0).astype(np.float32)


def encode_rgba(tile: np.ndarray, fmt: str, quality: int) -> bytes | None:
    from PIL import Image

    a = tile[3]
    if not (a > 0).any():
        return None
    arr = np.clip(np.rint(tile), 0, 255).astype(np.uint8)
    if fmt == "jpeg" or (a >= 255).all():
        img = Image.fromarray(np.moveaxis(arr[:3], 0, -1), "RGB")
    else:
        img = Image.fromarray(np.moveaxis(arr, 0, -1), "RGBA")
    return tile_bytes_of(img, fmt, quality=quality)


class ImageryPack:
    name = "packs.imagery"
    title = "Imagery pack"
    description = "GeoTIFF or COG imagery to an offline raster pack with its licence and attribution."

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        out = common_params(params, self.name, {"customerLicence", "format", "quality", "tileSize"})
        if not isinstance(params.get("customerLicence"), bool):
            raise JobError(f"{self.name} needs: customerLicence.")
        fmt = params.get("format", "webp")
        if fmt not in FORMATS:
            raise JobError(f"format must be one of: {', '.join(sorted(FORMATS))}.")
        number(params, "quality", None, lo=1, hi=100, integer=True)
        if params.get("tileSize", 256) not in (256, 512):
            raise JobError("tileSize must be 256 or 512.")
        return out

    def inputs(self, params: dict[str, Any]) -> list[str]:
        return list(params["src"])

    def plan(self, params: dict[str, Any]) -> list[Step]:
        fmt: str = params.get("format", "webp")
        quality = int(params.get("quality", 82))
        size = int(params.get("tileSize", 256))
        files = PackFiles(Path(params["dest"]), params["id"])

        def scan(ctx: StepContext) -> dict[str, Any]:
            sources = scan_sources(expand_sources(params["src"]))
            bounds, lo, hi = zoom_range(params, sources, size)
            ctx.log(f"{len(sources)} source(s); zoom {lo} to {hi}")
            return {
                "sources": [str(s.path) for s in sources],
                "wgs": [list(s.bounds) for s in sources],
                "bounds": list(bounds),
                "minZoom": lo,
                "maxZoom": hi,
            }

        def tiles(ctx: StepContext) -> dict[str, Any]:
            import rasterio

            plan = ctx.outputs("scan")
            bounds = tuple(plan["bounds"])
            lo, hi = int(plan["minZoom"]), int(plan["maxZoom"])
            opened = [rasterio.open(p) for p in plan["sources"]]
            try:
                layouts = [band_plan(ds) for ds in opened]
                wgs = [tuple(b) for b in plan["wgs"]]

                def leaf(z: int, x: int, y: int) -> np.ndarray | None:
                    tf = tile_transform(z, x, y, size)
                    lonlat = tile_bounds_lonlat(z, x, y)
                    out: np.ndarray | None = None
                    for ds, (bands, stretch), box in zip(opened, layouts, wgs, strict=True):
                        if not intersects(lonlat, box):
                            continue
                        vals, valid = warp_one(ds, bands, tf, size, resampling="bilinear", alpha=True)
                        if not valid.any():
                            continue
                        rgba = to_rgba(vals, valid, stretch)
                        if out is None:
                            out = rgba
                        else:
                            empty = out[3] == 0
                            out[:, empty] = rgba[:, empty]
                    return out

                def merge(kids: list[np.ndarray | None]) -> np.ndarray | None:
                    big = grid_2x2(kids, (4, size, size), 0.0)
                    return None if big is None else downsample_rgba(big)

                writer = files.writer(fmt)
                try:

                    def store(z: int, x: int, y: int, arr: np.ndarray) -> None:
                        data = encode_rgba(arr, fmt, quality)
                        if data:
                            writer.add(z, x, y, data)

                    t0 = time.monotonic()
                    build_pyramid(ctx, bounds, lo, hi, leaf, merge, store)
                    meta = pack_meta(
                        params,
                        kind="imagery",
                        bounds=bounds,
                        lo=lo,
                        hi=hi,
                        tile_size=size,
                        fmt=fmt,
                        customer=bool(params["customerLicence"]),
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
                "pack": {"id": meta["id"], "kind": "imagery", "path": str(files.final)},
                "tiles": ctx.outputs("tiles").get("tiles", 0),
            }

        return [
            Step("scan", "Read the sources", scan, 0.05),
            Step("tiles", "Make the tiles", tiles, 0.9),
            Step("commit", "Install the pack", commit, 0.05),
        ]
