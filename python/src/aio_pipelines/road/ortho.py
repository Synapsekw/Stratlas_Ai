"""Orthomosaic GeoTIFFs to a kit pyramid (``aio.tiles/1``, data-conventions section 5), and the
per-defect close-ups.

The pyramid is aligned to the project CRS (sources in another CRS are warped on the fly through a
GDAL WarpedVRT): a rectangle over the ortho extent, 1024 px WebP tiles, the finest level at the
ortho's own pixel size (or a coarser one asked for), each coarser level half the resolution
(``cols``, ``rows`` halve) down to at most 2 x 2 tiles. Finest tiles are read straight from the
source (GDAL uses the GeoTIFF overviews when a level is coarser than the source), coarser ones are
averaged from their four children on premultiplied colour, as the delivered tiler built its
pyramid. Several GeoTIFFs (ortho blocks) are drawn in order, later ones on top. Empty slots get a
tiny transparent tile on the coarse levels and around the corridor on the fine ones, so the 3D
view never asks for a tile that is not there (as the Ring Road importer does).

Close-ups port ``closeups.py``: a native-resolution crop around each defect, long side at most
1200 px (the overview level that keeps it under that), WebP.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from ..runtime import JobError

TILE = 1024
QUALITY = 80
CLOSEUP_MAX = 1200
BLANK_COMPLETE_UP_TO = 1024
BLANK_RINGS = 2
ALGO = "road-ortho/1"


@dataclass
class Source:
    path: str
    ds: Any  # rasterio dataset or WarpedVRT in the project CRS
    raw: Any  # the opened file
    bands: list[int]
    alpha: bool

    def close(self) -> None:
        if self.ds is not self.raw:
            self.ds.close()
        self.raw.close()


def open_sources(paths: list[str], dst_crs) -> list[Source]:
    import rasterio
    from rasterio.enums import ColorInterp, Resampling
    from rasterio.vrt import WarpedVRT

    out: list[Source] = []
    for p in paths:
        try:
            raw = rasterio.open(p)
        except Exception as e:
            raise JobError(f"The orthomosaic {Path(p).name} could not be opened: {e}") from e
        if raw.count < 3 and raw.count != 1:
            raise JobError(f"{Path(p).name} has {raw.count} bands; an orthomosaic needs RGB or RGBA.")
        if raw.dtypes[0] != "uint8":
            raise JobError(f"{Path(p).name} is {raw.dtypes[0]}; an orthomosaic must be 8-bit RGB.")
        ds = raw
        if raw.crs is None:
            raise JobError(f"{Path(p).name} has no CRS.")
        if raw.crs != dst_crs:
            ds = WarpedVRT(raw, crs=dst_crs, resampling=Resampling.bilinear)
        alpha = raw.count >= 4 and raw.colorinterp[3] == ColorInterp.alpha
        bands = [1, 2, 3] if raw.count >= 3 else [1, 1, 1]
        out.append(Source(p, ds, raw, bands, alpha))
    return out


@dataclass
class Plan:
    left: float
    top: float
    res: float  # finest metres per pixel
    cols: int  # finest level
    rows: int
    levels: int

    def level_res(self, z: int) -> float:
        return self.res * 2 ** (self.levels - 1 - z)

    def level_size(self, z: int) -> tuple[int, int]:
        f = 2 ** (self.levels - 1 - z)
        return self.cols // f, self.rows // f

    @property
    def width(self) -> float:
        return self.cols * TILE * self.res

    @property
    def height(self) -> float:
        return self.rows * TILE * self.res

    def tile_bounds(self, z: int, x: int, y: int) -> tuple[float, float, float, float]:
        s = TILE * self.level_res(z)
        x0 = self.left + x * s
        y1 = self.top - y * s
        return x0, y1 - s, x0 + s, y1


def plan_pyramid(sources: list[Source], finest_m: float | None) -> Plan:
    xs0, ys0, xs1, ys1, res = [], [], [], [], []
    for s in sources:
        b = s.ds.bounds
        xs0.append(b.left)
        ys0.append(b.bottom)
        xs1.append(b.right)
        ys1.append(b.top)
        res.append(min(abs(s.ds.res[0]), abs(s.ds.res[1])))
    native = min(res)
    r = max(native, finest_m or 0.0)
    # whole millimetres keep the tile grid readable; never finer than the source
    r = math.ceil(r * 1000 - 1e-6) / 1000 if r >= 0.001 else r
    left, top = min(xs0), max(ys1)
    w, h = max(xs1) - left, top - min(ys0)
    span = max(w, h) / (TILE * r)
    a = max(0, math.ceil(math.log2(max(span, 1))) - 1)
    m = max(1, math.ceil(w / (2**a * TILE * r)))
    n = max(1, math.ceil(h / (2**a * TILE * r)))
    return Plan(left=round(left, 3), top=round(top, 3), res=r, cols=m * 2**a, rows=n * 2**a, levels=a + 1)


def stamp(paths: list[str], plan: Plan) -> str:
    items = []
    for p in paths:
        st = os.stat(p)
        items.append([os.path.basename(p), st.st_size, int(st.st_mtime)])
    blob = json.dumps([ALGO, TILE, QUALITY, plan.__dict__, items], sort_keys=True)
    return hashlib.sha256(blob.encode()).hexdigest()[:32]


def clip_window(win: Any, width: int, height: int) -> Any:
    """The part of a window inside a raster of ``width`` x ``height``, or None."""
    from rasterio.errors import WindowError
    from rasterio.windows import Window

    try:
        out = win.intersection(Window(0, 0, width, height))
    except WindowError:
        return None
    return out if out.width > 0 and out.height > 0 else None


def _read_rgba(
    src: Source, bounds: tuple[float, float, float, float], size: tuple[int, int]
) -> np.ndarray | None:
    """RGBA of a ground box at ``size`` pixels; the part outside the source stays transparent.

    The read is clipped to the source (a WarpedVRT allows no boundless reads): the output pixels
    the source covers are read through one (fractional) window, resampled by GDAL, which takes the
    GeoTIFF overviews when the output is coarser than the source.
    """
    from rasterio.enums import Resampling
    from rasterio.windows import from_bounds

    x0, y0, x1, y1 = bounds
    w, h = size
    b = src.ds.bounds
    ix0, ix1 = max(x0, b.left), min(x1, b.right)
    iy0, iy1 = max(y0, b.bottom), min(y1, b.top)
    if ix0 >= ix1 or iy0 >= iy1:
        return None
    px = (x1 - x0) / w
    py = (y1 - y0) / h
    c0 = max(0, math.floor((ix0 - x0) / px + 1e-6))
    c1 = min(w, math.ceil((ix1 - x0) / px - 1e-6))
    r0 = max(0, math.floor((y1 - iy1) / py + 1e-6))
    r1 = min(h, math.ceil((y1 - iy0) / py - 1e-6))
    if c1 <= c0 or r1 <= r0:
        return None
    gx0, gx1 = x0 + c0 * px, x0 + c1 * px
    gy1, gy0 = y1 - r0 * py, y1 - r1 * py
    win = clip_window(from_bounds(gx0, gy0, gx1, gy1, src.ds.transform), src.ds.width, src.ds.height)
    if win is None:
        return None
    kw = dict(window=win, out_shape=(r1 - r0, c1 - c0), resampling=Resampling.bilinear)
    rgb = np.stack([src.ds.read(i, **kw) for i in src.bands], axis=-1)
    a = src.ds.read(4, **kw) if src.alpha else src.ds.read_masks(1, **kw)
    if not a.any():
        return None
    out = np.zeros((h, w, 4), np.uint8)
    out[r0:r1, c0:c1, :3] = rgb
    out[r0:r1, c0:c1, 3] = a
    return out


def render(sources: list[Source], bounds, size: tuple[int, int]):
    """RGBA image of a ground box from all sources (later ones on top), or None when empty."""
    from PIL import Image

    acc = None
    for s in sources:
        arr = _read_rgba(s, bounds, size)
        if arr is None:
            continue
        im = Image.fromarray(arr, "RGBA")
        acc = im if acc is None else Image.alpha_composite(acc, im)
    return acc


def save_webp(im, path: Path, quality: int = QUALITY) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    a = np.asarray(im.getchannel("A")) if im.mode == "RGBA" else None
    if a is not None and a.min() == 255:
        im = im.convert("RGB")
    im.save(tmp, "WEBP", quality=quality, method=4)
    os.replace(tmp, path)


def data_tiles(sources: list[Source], plan: Plan, check: Callable[[], None]) -> set[tuple[int, int]]:
    """Finest-level tiles that hold ortho pixels, from a coarse read of the masks."""
    z = plan.levels - 1
    want: set[tuple[int, int]] = set()
    # one mask pixel per 1/8 of a tile (8 x 8 samples per tile), capped for huge grids
    k = 8 if plan.cols * plan.rows <= 40000 else 2
    w, h = plan.cols * k, plan.rows * k
    bounds = (plan.left, plan.top - plan.height, plan.left + plan.width, plan.top)
    for s in sources:
        check()
        arr = _read_rgba(s, bounds, (w, h))
        if arr is None:
            continue
        rr, cc = np.nonzero(arr[..., 3] > 0)
        # a mask pixel touches up to two tiles each way at its edges: dilate by one sample
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                ty = np.clip((rr + dy) // k, 0, plan.rows - 1)
                tx = np.clip((cc + dx) // k, 0, plan.cols - 1)
                want.update(zip(tx.tolist(), ty.tolist(), strict=True))
    del z
    return want


def blank_slots(cols: int, rows: int, have: set[tuple[int, int]]) -> list[tuple[int, int]]:
    """Empty slots that get a blank tile (``blankSlots`` of the Ring Road importer)."""
    want: set[tuple[int, int]] = set()
    if cols * rows <= BLANK_COMPLETE_UP_TO:
        want = {(x, y) for y in range(rows) for x in range(cols)}
    else:
        for hx, hy in have:
            for y in range(max(0, hy - BLANK_RINGS), min(rows - 1, hy + BLANK_RINGS) + 1):
                for x in range(max(0, hx - BLANK_RINGS), min(cols - 1, hx + BLANK_RINGS) + 1):
                    want.add((x, y))
    return sorted(want - have, key=lambda t: (t[1], t[0]))


def build_pyramid(
    sources: list[Source],
    plan: Plan,
    out_dir: Path,
    check: Callable[[], None],
    progress: Callable[[float, str | None], None],
    log: Callable[[str], None],
) -> dict[str, Any]:
    """Write ``out_dir/{z}/{x}_{y}.webp``; tiles already there (a resumed job) are kept."""
    from PIL import Image

    zf = plan.levels - 1
    todo = sorted(data_tiles(sources, plan, check), key=lambda t: (t[1], t[0]))
    log(
        f"Ortho pyramid: {plan.levels} levels, finest {plan.res * 100:.2f} cm, {len(todo)} tiles with data at the finest level"
    )
    total = max(1, len(todo)) * 1.34
    done = 0
    have: dict[int, set[tuple[int, int]]] = {zf: set()}
    for x, y in todo:
        check()
        f = out_dir / str(zf) / f"{x}_{y}.webp"
        if f.exists():
            have[zf].add((x, y))
        else:
            im = render(sources, plan.tile_bounds(zf, x, y), (TILE, TILE))
            if im is not None:
                save_webp(im, f)
                have[zf].add((x, y))
        done += 1
        progress(done / total, f"Ortho tiles {done} of {len(todo)}")
    for z in range(zf - 1, -1, -1):
        parents = sorted({(x // 2, y // 2) for x, y in have[z + 1]}, key=lambda t: (t[1], t[0]))
        have[z] = set()
        for x, y in parents:
            check()
            f = out_dir / str(z) / f"{x}_{y}.webp"
            if not f.exists():
                im = Image.new("RGBa", (2 * TILE, 2 * TILE))
                for dy in (0, 1):
                    for dx in (0, 1):
                        c = out_dir / str(z + 1) / f"{2 * x + dx}_{2 * y + dy}.webp"
                        if (2 * x + dx, 2 * y + dy) in have[z + 1]:
                            with Image.open(c) as ci:
                                im.paste(ci.convert("RGBA").convert("RGBa"), (dx * TILE, dy * TILE))
                save_webp(im.resize((TILE, TILE), Image.Resampling.BOX).convert("RGBA"), f)
            have[z].add((x, y))
            done += 1
            progress(min(0.99, done / total), f"Ortho pyramid level {z}")
    blanks = 0
    blank = Image.new("RGBA", (8, 8), (0, 0, 0, 0))
    for z in range(plan.levels):
        cols, rows = plan.level_size(z)
        for x, y in blank_slots(cols, rows, have[z]):
            f = out_dir / str(z) / f"{x}_{y}.webp"
            if not f.exists():
                save_webp(blank, f)
            blanks += 1
    return {"tiles": sum(len(v) for v in have.values()), "blank": blanks}


def tiles_json(plan: Plan, origin: list[float], epsg: int | None, source: str, stamp_: str) -> dict[str, Any]:
    ox, oy = origin[0], origin[1]
    x0 = round(plan.left - ox, 6)
    z0 = round(-(plan.top - oy), 6)
    corners = {
        "tl": [x0, 0, z0],
        "tr": [round(x0 + plan.width, 6), 0, z0],
        "bl": [x0, 0, round(z0 + plan.height, 6)],
    }
    levels = []
    for z in range(plan.levels):
        cols, rows = plan.level_size(z)
        levels.append(
            {
                "z": z,
                "tileSize": TILE,
                "cols": cols,
                "rows": rows,
                "pattern": f"rasters/ortho/{z}/{{x}}_{{y}}.webp",
            }
        )
    return {
        "schema": "aio.tiles/1",
        "levels": levels,
        "corners": corners,
        **({"crs": {"epsg": epsg}} if epsg else {}),
        "topLeft": [plan.left, plan.top],
        "metresPerPx": [round(plan.level_res(z), 6) for z in range(plan.levels)],
        "source": source,
        "stamp": stamp_,
    }


def closeup_box(geom: Any) -> tuple[float, float, float, float]:
    """Ground box of a defect's close-up: its bounds with a margin of a fifth of the longer side
    (at least 0.5 m)."""
    x0, y0, x1, y1 = geom.bounds
    pad = max(0.5, 0.2 * max(x1 - x0, y1 - y0))
    return x0 - pad, y0 - pad, x1 + pad, y1 + pad


def closeup(sources: list[Source], box: tuple[float, float, float, float], native: float):
    """A close-up of a ground box: long side at most 1200 px at the source resolution."""
    from PIL import Image

    x0, y0, x1, y1 = box
    side = max(x1 - x0, y1 - y0)
    px = min(CLOSEUP_MAX, side / native)
    w = max(1, round((x1 - x0) / side * px))
    h = max(1, round((y1 - y0) / side * px))
    im = render(sources, box, (w, h))
    if im is None:
        return None
    bg = Image.new("RGBA", im.size, (20, 29, 45, 255))
    bg.alpha_composite(im)
    return bg.convert("RGB")


def image_polygon(geom: Any, box, size: tuple[int, int]) -> list[list[float]]:
    """The defect outline (largest ring) in close-up pixels."""
    x0, y0, x1, y1 = box
    w, h = size
    polys = list(geom.geoms) if geom.geom_type == "MultiPolygon" else [geom]
    ring = max(polys, key=lambda p: p.area).exterior.coords[:-1]
    return [[round((x - x0) / (x1 - x0) * w, 2), round((y1 - y) / (y1 - y0) * h, 2)] for x, y in ring]
