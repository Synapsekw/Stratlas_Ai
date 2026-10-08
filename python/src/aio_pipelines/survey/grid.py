"""Grids of the survey engine (data-conventions section 26): height tiles, sampling, coverage weights.

The Python reference core and the TypeScript executor (``packages/survey/src/engine``) implement the
same arithmetic; the shared fixtures in ``packages/schema/src/__fixtures__/survey`` hold them to
1e-6 relative. Every discrete decision (which cells, which posts, which triangle) uses the same
formula in the same order on both sides, so the two never disagree on an edge case.

**Height tiles** (``aio.height-tiles/1``, ``survey/surfaces/<id>/``): ``tiles.json`` (``HeightTiles``)
and ``<level>/<col>_<row>.bin``, a zlib stream (RFC 1950, what ``DecompressionStream('deflate')``
reads) of:

- bytes 0 to 3, ``AHT1``; bytes 4 to 7, uint32 flags (0);
- bytes 8 to 15, the tile's float64 base height;
- 65,536 float32 heights relative to the base, row-major, row 0 the southernmost, column 0 the
  westernmost (cells without data hold 0);
- an 8,192-byte nodata mask: bit ``k & 7`` (least significant first) of byte ``k >> 3`` is set when
  cell ``k`` has data.

All little-endian. Tile ``(col, row)`` of level ``L`` covers the cells ``col * 256 ..`` and
``row * 256 ..`` of a grid of cell ``cellM * 2**L`` whose lower-left corner is (``originE``,
``originN``); level ``L + 1`` is the mean of the valid 2 by 2 cells below it. An absent tile is all
nodata.

**A grid surface** is heights at cell centres ("posts"). It is sampled bilinearly between posts;
a post is needed only when its weight is above zero, and a needed post without data makes the
sample nodata (never zero). Positions within 1e-9 of a post (in cells) snap to it, so a comparison
grid aligned with a surface reads its posts exactly.

**Coverage weights**: the exact area of the polygon inside each cell over the cell area, from
clipping (shapely) for the cells an edge passes through; every other cell is wholly inside or
outside, which its centre decides.
"""

from __future__ import annotations

import json
import math
import struct
import zlib
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from ..runtime import JobError

TILE = 256
TILE_CELLS = TILE * TILE
TILE_MAGIC = b"AHT1"
TILE_HEADER = 16
TILE_MASK_BYTES = TILE_CELLS // 8
TILE_BYTES = TILE_HEADER + 4 * TILE_CELLS + TILE_MASK_BYTES
TILES_SCHEMA = "aio.height-tiles/1"
#: Positions this close to a post (in cells) are on it.
SNAP = 1e-9
#: Points sampled per window read (the samples are the same however they are grouped).
CHUNK = 256

Check = Callable[[], None]


def _no_check() -> None:
    return None


# ---------------------------------------------------------------------------------- tile codec


def encode_tile(heights: np.ndarray) -> bytes:
    """A 256 by 256 tile (float64, NaN where there is no data, row 0 south) as a ``.bin`` file."""
    h = np.asarray(heights, dtype=np.float64)
    if h.shape != (TILE, TILE):
        raise ValueError(f"A tile is {TILE} by {TILE} cells, not {h.shape}.")
    ok = np.isfinite(h)
    if ok.any():
        lo, hi = float(h[ok].min()), float(h[ok].max())
        base = (lo + hi) / 2.0
    else:
        base = 0.0
    rel = np.where(ok, h - base, 0.0).astype("<f4")
    mask = np.packbits(ok.reshape(-1), bitorder="little")
    raw = TILE_MAGIC + struct.pack("<I", 0) + struct.pack("<d", base) + rel.tobytes() + mask.tobytes()
    return zlib.compress(raw, 6)


def decode_tile(data: bytes) -> np.ndarray:
    """Heights of a ``.bin`` tile: float64 ``base + float32``, NaN where there is no data."""
    try:
        raw = zlib.decompress(data)
    except zlib.error as e:
        raise JobError(f"A height tile is damaged: {e}") from e
    if len(raw) != TILE_BYTES or raw[:4] != TILE_MAGIC:
        raise JobError("A height tile is not an aio.height-tiles/1 tile.")
    (base,) = struct.unpack_from("<d", raw, 8)
    rel = np.frombuffer(raw, dtype="<f4", count=TILE_CELLS, offset=TILE_HEADER)
    mask = np.unpackbits(
        np.frombuffer(raw, dtype=np.uint8, offset=TILE_HEADER + 4 * TILE_CELLS), bitorder="little"
    ).astype(bool)
    h = base + rel.astype(np.float64)
    h[~mask] = np.nan
    return h.reshape(TILE, TILE)


# ------------------------------------------------------------------------------------- surfaces


class GridSurface:
    """Heights at cell centres: ``read`` a window of cells (float64, NaN where there is no data).

    Cell ``(i, j)`` covers E in ``[originE + i * cell, originE + (i + 1) * cell]`` and N likewise;
    ``j`` grows north. ``nx``, ``ny`` bound the cells that can hold data.
    """

    kind = "grid"
    origin_e: float
    origin_n: float
    cell: float
    nx: int
    ny: int

    def read(self, i0: int, j0: int, w: int, h: int) -> np.ndarray:  # pragma: no cover - interface
        raise NotImplementedError

    @property
    def bounds(self) -> tuple[float, float, float, float]:
        return (
            self.origin_e,
            self.origin_n,
            self.origin_e + self.nx * self.cell,
            self.origin_n + self.ny * self.cell,
        )


class ArraySurface(GridSurface):
    """A grid surface held in memory (fixtures, the kit's grids)."""

    def __init__(self, origin_e: float, origin_n: float, cell: float, heights: np.ndarray):
        self.origin_e = float(origin_e)
        self.origin_n = float(origin_n)
        self.cell = float(cell)
        self.heights = np.asarray(heights, dtype=np.float64)
        self.ny, self.nx = self.heights.shape

    def read(self, i0: int, j0: int, w: int, h: int) -> np.ndarray:
        out = np.full((h, w), np.nan)
        a0, a1 = max(i0, 0), min(i0 + w, self.nx)
        b0, b1 = max(j0, 0), min(j0 + h, self.ny)
        if a0 < a1 and b0 < b1:
            out[b0 - j0 : b1 - j0, a0 - i0 : a1 - i0] = self.heights[b0:b1, a0:a1]
        return out


class TileSurface(GridSurface):
    """A prepared surface (``survey/surfaces/<id>/``) read tile by tile, with a small cache."""

    def __init__(self, folder: Path, meta: dict[str, Any] | None = None, cache_tiles: int = 256):
        self.folder = Path(folder)
        if meta is None:
            meta = read_tiles_json(self.folder)
        self.meta = meta
        self.origin_e = float(meta["originE"])
        self.origin_n = float(meta["originN"])
        self.cell = float(meta["cellM"])
        self.cols = int(meta["cols"])
        self.rows = int(meta["rows"])
        self.nx, self.ny = self.cols * TILE, self.rows * TILE
        self.present = set(meta.get("tiles") or [])
        self._cache: OrderedDict[tuple[int, int, int], np.ndarray | None] = OrderedDict()
        self._cache_tiles = cache_tiles

    def tile(self, col: int, row: int, level: int = 0) -> np.ndarray | None:
        key = (level, col, row)
        if key in self._cache:
            self._cache.move_to_end(key)
            return self._cache[key]
        t: np.ndarray | None = None
        if level > 0 or f"{col}_{row}" in self.present:
            p = self.folder / str(level) / f"{col}_{row}.bin"
            if p.is_file():
                t = decode_tile(p.read_bytes())
        self._cache[key] = t
        if len(self._cache) > self._cache_tiles:
            self._cache.popitem(last=False)
        return t

    def read(self, i0: int, j0: int, w: int, h: int) -> np.ndarray:
        out = np.full((h, w), np.nan)
        c0, c1 = max(i0, 0) // TILE, (min(i0 + w, self.nx) - 1) // TILE
        r0, r1 = max(j0, 0) // TILE, (min(j0 + h, self.ny) - 1) // TILE
        for r in range(r0, r1 + 1):
            for c in range(c0, c1 + 1):
                t = self.tile(c, r)
                if t is None:
                    continue
                a0, a1 = max(i0, c * TILE), min(i0 + w, (c + 1) * TILE)
                b0, b1 = max(j0, r * TILE), min(j0 + h, (r + 1) * TILE)
                if a0 >= a1 or b0 >= b1:
                    continue
                out[b0 - j0 : b1 - j0, a0 - i0 : a1 - i0] = t[
                    b0 - r * TILE : b1 - r * TILE, a0 - c * TILE : a1 - c * TILE
                ]
        return out


def read_tiles_json(folder: Path) -> dict[str, Any]:
    p = Path(folder) / "tiles.json"
    try:
        meta = json.loads(p.read_text("utf-8"))
    except (OSError, ValueError) as e:
        raise JobError(f"The prepared surface {p.parent.name} could not be read: {e}") from e
    if not isinstance(meta, dict) or meta.get("schema") != TILES_SCHEMA:
        raise JobError(f"{p} is not an {TILES_SCHEMA} file.")
    if meta.get("tileSize") != TILE:
        raise JobError(f"{p} has tiles of {meta.get('tileSize')} cells; this build reads {TILE}.")
    return meta


# ------------------------------------------------------------------------------------- sampling


def _snap(u: np.ndarray) -> np.ndarray:
    r = np.round(u)
    return np.where(np.abs(u - r) <= SNAP, r, u)


def bilinear(surface: GridSurface, xs: np.ndarray, ys: np.ndarray, de: float, dn: float) -> np.ndarray:
    """Heights at local points (``x + de``, ``y + dn`` are metres from the surface origin)."""
    xs = np.asarray(xs, dtype=np.float64)
    ys = np.asarray(ys, dtype=np.float64)
    out = np.full(xs.shape, np.nan)
    if xs.size == 0:
        return out
    if xs.size > CHUNK:
        # points along a ring: consecutive runs are close together, so read small windows
        for k in range(0, xs.size, CHUNK):
            out[k : k + CHUNK] = bilinear(surface, xs[k : k + CHUNK], ys[k : k + CHUNK], de, dn)
        return out
    sc = surface.cell
    u = _snap((xs + de) / sc - 0.5)
    v = _snap((ys + dn) / sc - 0.5)
    iu = np.floor(u)
    iv = np.floor(v)
    fu = u - iu
    fv = v - iv
    iu = iu.astype(np.int64)
    iv = iv.astype(np.int64)
    a0, a1 = int(iu.min()), int(iu.max()) + 2
    b0, b1 = int(iv.min()), int(iv.max()) + 2
    win = surface.read(a0, b0, a1 - a0, b1 - b0)
    ci = iu - a0
    rj = iv - b0
    p00 = win[rj, ci]
    p10 = win[rj, ci + 1]
    p01 = win[rj + 1, ci]
    p11 = win[rj + 1, ci + 1]
    with np.errstate(invalid="ignore"):
        row0 = np.where(fu == 0, p00, p00 * (1 - fu) + p10 * fu)
        row1 = np.where(fu == 0, p01, p01 * (1 - fu) + p11 * fu)
        out = np.where(fv == 0, row0, row0 * (1 - fv) + row1 * fv)
    return out


def sample_cells(
    surface: GridSurface, de: float, dn: float, cell: float, i0: int, j0: int, nx: int, ny: int
) -> np.ndarray:
    """Heights at the centres of comparison cells ``i0 ..``, ``j0 ..`` (local x = (i + 0.5) cell)."""
    sc = surface.cell
    ou = de / sc
    ov = dn / sc
    if sc == cell and abs(ou - round(ou)) <= SNAP and abs(ov - round(ov)) <= SNAP:
        # aligned: the centres are posts
        return surface.read(i0 + round(ou), j0 + round(ov), nx, ny)
    xs = (np.arange(i0, i0 + nx) + 0.5) * cell
    ys = (np.arange(j0, j0 + ny) + 0.5) * cell
    out = np.empty((ny, nx))
    for r in range(ny):
        out[r] = bilinear(surface, xs, np.full(nx, ys[r]), de, dn)
    return out


# --------------------------------------------------------------------------------------- rings


def normal_ring(ring: list[list[float]] | list[tuple[float, float]]) -> list[tuple[float, float]]:
    """A ring without repeated consecutive points or a closing repeat (E, N as given)."""
    out: list[tuple[float, float]] = []
    for p in ring:
        q = (float(p[0]), float(p[1]))
        if not out or out[-1] != q:
            out.append(q)
    while len(out) > 1 and out[-1] == out[0]:
        out.pop()
    return out


def signed_area(ring: list[tuple[float, float]]) -> float:
    s = 0.0
    n = len(ring)
    for k in range(n):
        ax, ay = ring[k]
        bx, by = ring[(k + 1) % n]
        s += ax * by - bx * ay
    return s / 2.0


def ring_area(ring: list[tuple[float, float]]) -> float:
    """Horizontal area of a ring (in coordinates near zero, so local ones)."""
    return abs(signed_area(ring))


def _segments_cross(a, b, c, d) -> bool:
    def orient(p, q, r) -> float:
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])

    d1 = orient(c, d, a)
    d2 = orient(c, d, b)
    d3 = orient(a, b, c)
    d4 = orient(a, b, d)
    return ((d1 > 0 and d2 < 0) or (d1 < 0 and d2 > 0)) and ((d3 > 0 and d4 < 0) or (d3 < 0 and d4 > 0))


#: Rings with more points are not checked for crossings (both executors).
CROSSING_CHECK_MAX = 5000


def crosses_itself(ring: list[tuple[float, float]]) -> bool:
    """True when two edges that do not share a point cross (properly)."""
    n = len(ring)
    if n < 4 or n > CROSSING_CHECK_MAX:
        return False
    for i in range(n):
        a, b = ring[i], ring[(i + 1) % n]
        ax0, ax1 = min(a[0], b[0]), max(a[0], b[0])
        ay0, ay1 = min(a[1], b[1]), max(a[1], b[1])
        for j in range(i + 2, n):
            if i == 0 and j == n - 1:
                continue
            c, d = ring[j], ring[(j + 1) % n]
            if (
                max(c[0], d[0]) < ax0
                or min(c[0], d[0]) > ax1
                or max(c[1], d[1]) < ay0
                or min(c[1], d[1]) > ay1
            ):
                continue
            if _segments_cross(a, b, c, d):
                return True
    return False


def densify(ring: list[tuple[float, float]], step: float) -> tuple[np.ndarray, np.ndarray]:
    """Points every ``step`` (at most) along each edge of a closed ring, the vertices included."""
    xs: list[float] = []
    ys: list[float] = []
    n = len(ring)
    for k in range(n):
        ax, ay = ring[k]
        bx, by = ring[(k + 1) % n]
        dx, dy = bx - ax, by - ay
        length = math.sqrt(dx * dx + dy * dy)
        m = max(1, math.ceil(length / step))
        for s in range(m):
            xs.append(ax + (dx * s) / m)
            ys.append(ay + (dy * s) / m)
    return np.array(xs), np.array(ys)


# ------------------------------------------------------------------------------------- coverage


@dataclass(frozen=True)
class Window:
    """Comparison cells ``i0 .. i0 + nx``, ``j0 .. j0 + ny`` of ``cell`` metres (local frame)."""

    cell: float
    i0: int
    j0: int
    nx: int
    ny: int

    @staticmethod
    def over(ring: list[tuple[float, float]], cell: float) -> Window:
        xs = [p[0] for p in ring]
        ys = [p[1] for p in ring]
        i0 = math.floor(min(xs) / cell)
        j0 = math.floor(min(ys) / cell)
        i1 = math.ceil(max(xs) / cell)
        j1 = math.ceil(max(ys) / cell)
        return Window(cell, i0, j0, max(1, i1 - i0), max(1, j1 - j0))


def coverage(ring: list[tuple[float, float]], win: Window, check: Check = _no_check) -> np.ndarray:
    """Exact share of each window cell inside the ring (local coordinates), shape (ny, nx)."""
    import shapely
    from shapely.geometry import Polygon

    c = win.cell
    w = np.zeros((win.ny, win.nx))
    pts = np.array(ring, dtype=np.float64)
    x0e, y0e = pts[:, 0], pts[:, 1]
    x1e, y1e = np.roll(x0e, -1), np.roll(y0e, -1)
    # cells wholly inside: their centres, row by row (crossings of the row's centre line)
    for r in range(win.ny):
        if r % 256 == 0:
            check()
        y = (win.j0 + r + 0.5) * c
        sel = (y0e > y) != (y1e > y)
        if not sel.any():
            continue
        xa = x0e[sel] + (y - y0e[sel]) * (x1e[sel] - x0e[sel]) / (y1e[sel] - y0e[sel])
        xa.sort()
        for k in range(0, len(xa) - 1, 2):
            ia = math.ceil(xa[k] / c - 0.5) - win.i0
            ib = math.floor(xa[k + 1] / c - 0.5) - win.i0
            ia, ib = max(ia, 0), min(ib, win.nx - 1)
            if ia <= ib:
                w[r, ia : ib + 1] = 1.0
    # cells an edge passes through: clipped exactly
    edge_cells: set[tuple[int, int]] = set()
    eps = 1e-9
    for k in range(len(ring)):
        ax, ay = x0e[k] / c, y0e[k] / c
        bx, by = x1e[k] / c, y1e[k] / c
        ca, cb = math.floor(min(ax, bx) - eps), math.floor(max(ax, bx) + eps)
        for col in range(ca, cb + 1):
            # the part of the edge over this column
            lo, hi = max(col, min(ax, bx)), min(col + 1, max(ax, bx))
            if bx != ax:
                ya = ay + (lo - ax) * (by - ay) / (bx - ax)
                yb = ay + (hi - ax) * (by - ay) / (bx - ax)
            else:
                ya, yb = ay, by
            ra, rb = math.floor(min(ya, yb) - eps), math.floor(max(ya, yb) + eps)
            for row in range(ra, rb + 1):
                edge_cells.add((col, row))
    if edge_cells:
        cells = np.array(sorted(edge_cells), dtype=np.int64)
        ci = cells[:, 0] - win.i0
        ri = cells[:, 1] - win.j0
        keep = (ci >= 0) & (ci < win.nx) & (ri >= 0) & (ri < win.ny)
        ci, ri = ci[keep], ri[keep]
        gi, gj = ci + win.i0, ri + win.j0
        poly = Polygon(ring)
        shapely.prepare(poly)
        boxes = shapely.box(gi * c, gj * c, (gi + 1) * c, (gj + 1) * c)
        areas = shapely.area(shapely.intersection(boxes, poly))
        w[ri, ci] = np.clip(areas / (c * c), 0.0, 1.0)
    return w
