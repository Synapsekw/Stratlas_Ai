"""Shared work of the imagery and terrain packs: sources, Web Mercator tiles, the pack files.

Sources are GeoTIFF or COG files (or folders of them) in any CRS GDAL knows. Tiles are made depth
first from each top tile: a tile at the deepest zoom is warped from the sources with GDAL (through
rasterio), a tile above it is its four children merged and halved. So memory holds a few tiles per
zoom, every zoom agrees with the one below, and a source is read once per deepest tile.
"""

from __future__ import annotations

import math
import re
import shutil
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from ..params import known_keys, number, text
from ..runtime import JobError, StepContext, atomic_write_json, now_iso
from .pmtiles_writer import PMTilesWriter

#: Web Mercator half extent, metres, and its latitude limit.
MERC = 20037508.342789244
MAX_LAT = 85.0511287798066
RASTER_EXTENSIONS = {".tif", ".tiff", ".gtiff", ".vrt"}
PACK_ID = r"^[a-z0-9-]+$"
MAX_SOURCES = 10_000


@dataclass(frozen=True)
class Source:
    path: Path
    bounds: tuple[float, float, float, float]  # WGS84 west, south, east, north
    #: Ground size of one pixel in metres (at the source's centre).
    pixel_m: float
    count: int
    dtype: str


def common_params(params: dict[str, Any], pipeline: str, extra: set[str]) -> dict[str, Any]:
    keys = {"src", "dest", "id", "label", "licence", "attribution", "provenance", "minZoom", "maxZoom"}
    known_keys(params, keys | extra, pipeline)
    src = params.get("src")
    if not isinstance(src, list) or not src or not all(isinstance(s, str) and s for s in src):
        raise JobError("src must be a list of GeoTIFF files or folders.")
    if len(src) > MAX_SOURCES:
        raise JobError(f"At most {MAX_SOURCES} sources.")
    dest = text(params, "dest", required=True)
    assert dest is not None
    if not Path(dest).is_absolute():
        raise JobError("dest must be an absolute folder (the data folder's packs folder).")
    pid = text(params, "id", required=True)
    if pid is None or not re.match(PACK_ID, pid) or len(pid) > 48:
        raise JobError("id must be lower-case letters, digits and dashes.")
    for k in ("label", "licence", "attribution"):
        text(params, k, required=True)
    text(params, "provenance")
    lo = number(params, "minZoom", None, lo=0, hi=22, integer=True)
    hi = number(params, "maxZoom", None, lo=0, hi=22, integer=True)
    if lo is not None and hi is not None and lo > hi:
        raise JobError("minZoom must not be above maxZoom.")
    return dict(params)


def expand_sources(paths: list[str]) -> list[Path]:
    out: list[Path] = []
    for raw in paths:
        p = Path(raw)
        if p.is_dir():
            found = sorted(f for f in p.rglob("*") if f.is_file() and f.suffix.lower() in RASTER_EXTENSIONS)
            if not found:
                raise JobError(f"The folder {p} has no GeoTIFF files.")
            out.extend(found)
        elif p.is_file():
            out.append(p)
        else:
            raise JobError(f'The source "{raw}" does not exist.')
    if len(out) > MAX_SOURCES:
        raise JobError(f"At most {MAX_SOURCES} source files.")
    return out


def scan_sources(paths: list[Path]) -> list[Source]:
    import rasterio
    from rasterio.warp import transform, transform_bounds

    out: list[Source] = []
    for p in paths:
        try:
            ds = rasterio.open(p)
        except Exception as e:
            raise JobError(f"{p.name} is not a raster GDAL can read: {e}") from e
        with ds:
            if ds.crs is None:
                raise JobError(f"{p.name} has no coordinate system; georeference it first.")
            w, s, e, n = transform_bounds(ds.crs, "EPSG:4326", *ds.bounds, densify_pts=21)
            # Pixel size on the ground: one pixel step at the centre, in WGS84, then metres.
            cx = (ds.bounds.left + ds.bounds.right) / 2
            cy = (ds.bounds.bottom + ds.bounds.top) / 2
            rx, ry = ds.res
            lons, lats = transform(ds.crs, "EPSG:4326", [cx, cx + rx, cx], [cy, cy, cy + ry])
            lat0 = math.radians(lats[0])
            dx = math.hypot((lons[1] - lons[0]) * math.cos(lat0), lats[1] - lats[0])
            dy = math.hypot((lons[2] - lons[0]) * math.cos(lat0), lats[2] - lats[0])
            pixel_m = max(1e-6, min(dx, dy) * 111_319.49)
            out.append(
                Source(
                    path=p,
                    bounds=(max(w, -180.0), max(s, -MAX_LAT), min(e, 180.0), min(n, MAX_LAT)),
                    pixel_m=pixel_m,
                    count=ds.count,
                    dtype=str(ds.dtypes[0]),
                )
            )
    return out


def union_bounds(sources: list[Source]) -> tuple[float, float, float, float]:
    return (
        min(s.bounds[0] for s in sources),
        min(s.bounds[1] for s in sources),
        max(s.bounds[2] for s in sources),
        max(s.bounds[3] for s in sources),
    )


def native_zoom(sources: list[Source], tile_size: int) -> int:
    """The zoom whose pixel is nearest the finest source's (in powers of two), at most 22."""
    finest = min(sources, key=lambda s: s.pixel_m)
    lat = math.radians((finest.bounds[1] + finest.bounds[3]) / 2)
    world_px_m = 2 * MERC * math.cos(lat) / tile_size
    return max(0, min(22, round(math.log2(world_px_m / finest.pixel_m))))


def lonlat_to_tile(lon: float, lat: float, z: int) -> tuple[int, int]:
    n = 1 << z
    lat = max(-MAX_LAT, min(MAX_LAT, lat))
    x = int((lon + 180) / 360 * n)
    y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
    return max(0, min(n - 1, x)), max(0, min(n - 1, y))


def tile_bounds_merc(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    size = 2 * MERC / (1 << z)
    left = -MERC + x * size
    top = MERC - y * size
    return left, top - size, left + size, top


def tile_bounds_lonlat(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    n = 1 << z

    def lat(ty: float) -> float:
        return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * ty / n))))

    return x / n * 360 - 180, lat(y + 1), (x + 1) / n * 360 - 180, lat(y)


def intersects(a: tuple[float, ...], b: tuple[float, ...]) -> bool:
    return a[0] < b[2] and a[2] > b[0] and a[1] < b[3] and a[3] > b[1]


def top_tiles(bounds: tuple[float, float, float, float], z: int) -> list[tuple[int, int]]:
    x0, y0 = lonlat_to_tile(bounds[0], bounds[3], z)
    x1, y1 = lonlat_to_tile(bounds[2], bounds[1], z)
    return [(x, y) for y in range(y0, y1 + 1) for x in range(x0, x1 + 1)]


def count_tiles(bounds: tuple[float, float, float, float], lo: int, hi: int) -> int:
    total = 0
    for z in range(lo, hi + 1):
        x0, y0 = lonlat_to_tile(bounds[0], bounds[3], z)
        x1, y1 = lonlat_to_tile(bounds[2], bounds[1], z)
        total += (x1 - x0 + 1) * (y1 - y0 + 1)
    return total


#: Render one deepest tile: (z, x, y) to an array, or None when no source covers it.
Leaf = Callable[[int, int, int], "np.ndarray | None"]
#: Merge four children (top-left, top-right, bottom-left, bottom-right; None for empty) to a parent.
Merge = Callable[[list["np.ndarray | None"]], "np.ndarray | None"]
#: Encode and store one tile.
Store = Callable[[int, int, int, np.ndarray], None]


def build_pyramid(
    ctx: StepContext,
    bounds: tuple[float, float, float, float],
    lo: int,
    hi: int,
    leaf: Leaf,
    merge: Merge,
    store: Store,
) -> int:
    """Make every tile from ``lo`` to ``hi`` over ``bounds``, depth first. Returns tiles stored."""
    total = max(1, count_tiles(bounds, lo, hi))
    done = 0
    stored = 0

    def walk(z: int, x: int, y: int) -> np.ndarray | None:
        nonlocal done, stored
        ctx.check()
        if not intersects(tile_bounds_lonlat(z, x, y), bounds):
            return None
        if z == hi:
            arr = leaf(z, x, y)
        else:
            kids = [walk(z + 1, 2 * x + dx, 2 * y + dy) for dy in (0, 1) for dx in (0, 1)]
            arr = merge(kids)
        done += 1
        if arr is not None and z >= lo:
            store(z, x, y, arr)
            stored += 1
        if done % 16 == 0:
            ctx.progress(done / total, f"{done} of about {total} tiles")
        return arr

    for x, y in top_tiles(bounds, lo):
        walk(lo, x, y)
    ctx.progress(1.0, f"{stored} tiles")
    return stored


def tile_transform(z: int, x: int, y: int, size: int) -> Any:
    from rasterio.transform import from_bounds

    left, bottom, right, top = tile_bounds_merc(z, x, y)
    return from_bounds(left, bottom, right, top, size, size)


def warp_one(
    ds: Any,
    bands: list[int],
    transform: Any,
    size: int,
    *,
    resampling: str,
    alpha: bool,
) -> tuple[np.ndarray, np.ndarray]:
    """Warp bands of one source into a Web Mercator tile: (values, validity).

    ``alpha``: integer imagery, validity from a GDAL destination alpha band (the source's own mask
    or nodata); otherwise float32 values with NaN where the source has no data.
    """
    import rasterio
    from rasterio.warp import Resampling, reproject

    method = getattr(Resampling, resampling)
    if alpha:
        buf = np.zeros((len(bands) + 1, size, size), dtype=ds.dtypes[bands[0] - 1])
        reproject(
            rasterio.band(ds, bands),
            buf,
            dst_transform=transform,
            dst_crs="EPSG:3857",
            resampling=method,
            dst_alpha=len(bands) + 1,
        )
        return buf[:-1], buf[-1] > 0
    buf = np.full((len(bands), size, size), np.nan, dtype=np.float32)
    reproject(
        rasterio.band(ds, bands),
        buf,
        dst_transform=transform,
        dst_crs="EPSG:3857",
        resampling=method,
        src_nodata=ds.nodata,
        dst_nodata=np.nan,
    )
    return buf, np.all(np.isfinite(buf), axis=0)


def grid_2x2(kids: list[np.ndarray | None], shape: tuple[int, ...], fill: float) -> np.ndarray | None:
    """Four child tiles (top-left, top-right, bottom-left, bottom-right) side by side."""
    if all(k is None for k in kids):
        return None
    *lead, h, w = shape
    out = np.full((*lead, 2 * h, 2 * w), fill, dtype=np.float32)
    for i, k in enumerate(kids):
        if k is None:
            continue
        r, c = divmod(i, 2)
        out[..., r * h : (r + 1) * h, c * w : (c + 1) * w] = k
    return out


class PackFiles:
    """``<dest>/<id>.pmtiles`` and ``<id>.json``: built beside, then renamed into place."""

    def __init__(self, dest: Path, pack_id: str):
        self.dest = dest
        self.id = pack_id
        self.final = dest / f"{pack_id}.pmtiles"
        self.meta = dest / f"{pack_id}.json"
        self.building = dest / f".{pack_id}.pmtiles.building"

    def writer(self, tile_type: str) -> PMTilesWriter:
        self.dest.mkdir(parents=True, exist_ok=True)
        self.building.unlink(missing_ok=True)
        return PMTilesWriter(self.building, tile_type)

    def commit(self, meta: dict[str, Any]) -> None:
        if not self.building.is_file():
            raise JobError("The pack was not built; start the job again.")
        # Metadata last: a pack is listed only once both files are complete.
        self.meta.unlink(missing_ok=True)
        shutil.move(str(self.building), str(self.final))
        atomic_write_json(self.meta, meta)


def pack_meta(
    params: dict[str, Any],
    *,
    kind: str,
    bounds: tuple[float, float, float, float],
    lo: int,
    hi: int,
    tile_size: int,
    fmt: str,
    customer: bool,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """``aio.raster-pack/1`` (``RasterPackMeta`` in ``@aio/schema`` ``globe.ts``)."""
    meta: dict[str, Any] = {
        "schema": "aio.raster-pack/1",
        "id": params["id"],
        "kind": kind,
        "label": params["label"],
        "bbox": [round(v, 7) for v in bounds],
        "minZoom": lo,
        "maxZoom": hi,
        "tileSize": tile_size,
        "format": fmt,
        "licence": params["licence"],
        "attribution": params["attribution"],
        "customerLicence": customer,
        "builtAt": now_iso(),
    }
    if params.get("provenance"):
        meta["provenance"] = params["provenance"]
    meta.update(extra or {})
    return meta


def pmtiles_metadata(meta: dict[str, Any]) -> dict[str, Any]:
    """The archive's own JSON metadata, so other PMTiles tools show the licence too."""
    out = {
        "name": meta["label"],
        "type": "baselayer",
        "format": meta["format"],
        "attribution": meta["attribution"],
        "description": f"{meta['kind']} pack ({meta['licence']})",
        "aio": {k: meta[k] for k in ("id", "kind", "licence", "customerLicence") if k in meta},
    }
    if meta.get("encoding"):
        out["encoding"] = meta["encoding"]
    return out


def zoom_range(
    params: dict[str, Any], sources: list[Source], tile_size: int
) -> tuple[tuple[float, float, float, float], int, int]:
    bounds = union_bounds(sources)
    hi = params.get("maxZoom")
    hi = native_zoom(sources, tile_size) if hi is None else int(hi)
    lo = params.get("minZoom")
    # Every zoom from 0 by default: above the site's own zoom it is one tile per zoom, and the
    # pack then shows however far out the map is.
    lo = 0 if lo is None else min(int(lo), hi)
    return bounds, lo, hi
