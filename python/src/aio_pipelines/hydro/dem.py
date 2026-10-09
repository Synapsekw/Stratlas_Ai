"""Flow routing on a height grid, written from the published algorithms (M11 decision 3).

- **Priority-Flood+epsilon** (Barnes, Lehman and Mulla 2014, "Priority-Flood: An optimal
  depression-filling and watershed-labeling algorithm for digital elevation models", Algorithm 3):
  cells are flooded inward from the edges (and from cells next to nodata) in order of height; a
  cell reached from a lower or equal one is raised to just above it (``nextafter``), so every
  cell drains, strictly downhill, to the edge. The flood also records which cell reached each cell
  first and the order cells were taken.
- **Breaching** on the same flood: walking the flood order backwards, every cell is lowered (one
  ``nextafter`` step at a time) below the cells it was reached from, which carves each depression's
  spill path down to just below the depression's bottom instead of raising the depression (a
  "complete breach" along the flood's path). Terrain outside depressions and their spill paths is
  unchanged.
- **D8** (O'Callaghan and Mark 1984): to the neighbour of steepest drop (drop over distance).
- **D-infinity** (Tarboton 1997, "A new method for the determination of flow directions and upslope
  areas in grid digital elevation models"): the steepest of eight triangular facets, split between
  the facet's two neighbours by angle.
- **Flow accumulation** over the resulting graph (topological waves), watersheds by following the
  D8 receivers to the first labelled cell (pointer jumping), runoff paths and stream lines.

Off-grid neighbours (outside the window or nodata) take the height of the local plane through the
cell (central differences), so water can leave the grid where the slope carries it out; a cell
that drains off the grid is an outlet. All in float64 numpy; the flood itself is a Python loop over
compact arrays (about a microsecond per neighbour), so a run is bounded by ``MAX_CELLS`` in
``flow.py``. Code written from the papers, not from any GPL implementation (pysheds, RichDEM,
GRASS are never used).
"""

from __future__ import annotations

import heapq
import math
from array import array
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass

import numpy as np

Check = Callable[[], None]

# neighbour k: (di, dj) with j growing north; 0 east, then counter-clockwise
DI = np.array([1, 1, 0, -1, -1, -1, 0, 1])
DJ = np.array([0, 1, 1, 1, 0, -1, -1, -1])
DIST = np.array([1.0, math.sqrt(2), 1.0, math.sqrt(2), 1.0, math.sqrt(2), 1.0, math.sqrt(2)])


def _no_check() -> None:
    return None


@dataclass
class Flood:
    """The Priority-Flood result on an (ny, nx) grid (flat indices ``j * nx + i``)."""

    #: Filled heights with epsilon steps (NaN where the input had no data).
    filled: np.ndarray
    #: The cell each cell was reached from (-1: a seed at the edge or next to nodata, or nodata).
    parent: np.ndarray
    #: Flat indices in the order the flood took them.
    order: np.ndarray


def priority_flood(z: np.ndarray, check: Check = _no_check) -> Flood:
    """Priority-Flood+epsilon (Barnes, Lehman and Mulla 2014, Algorithm 3) over ``z`` (NaN no data)."""
    ny, nx = z.shape
    W = nx + 2
    pad = np.full((ny + 2, W), np.nan)
    pad[1:-1, 1:-1] = z
    valid = np.isfinite(pad)
    size = pad.size
    F = array("d", np.where(valid, pad, 0.0).reshape(-1).tolist())
    closed = bytearray((~valid).reshape(-1).astype(np.uint8).tobytes())
    parent = array("q", [-1]) * size
    order = array("q")
    offs = [int(dj * W + di) for di, dj in zip(DI, DJ, strict=True)]
    # seeds: valid cells with an off-grid (invalid) neighbour
    near_out = np.zeros_like(valid)
    for di, dj in zip(DI, DJ, strict=True):
        near_out[1:-1, 1:-1] |= ~valid[1 + dj : ny + 1 + dj, 1 + di : nx + 1 + di]
    seeds = np.flatnonzero((near_out & valid).reshape(-1))
    open_q: list[tuple[float, int]] = [(F[s], int(s)) for s in seeds]
    heapq.heapify(open_q)
    for s in seeds:
        closed[s] = 1
    pit: deque[int] = deque()
    inf = math.inf
    nextafter = math.nextafter
    pop, push = heapq.heappop, heapq.heappush
    count = 0
    while open_q or pit:
        c = pit.popleft() if pit else pop(open_q)[1]
        order.append(c)
        count += 1
        if count & 0xFFFF == 0:
            check()
        fc = F[c]
        up = nextafter(fc, inf)
        for o in offs:
            n = c + o
            if closed[n]:
                continue
            closed[n] = 1
            parent[n] = c
            if F[n] <= fc:
                F[n] = up
                pit.append(n)
            else:
                push(open_q, (F[n], n))
    # back to the unpadded grid
    filled = np.frombuffer(F, dtype=np.float64).reshape(ny + 2, W)[1:-1, 1:-1].copy()
    filled[~np.isfinite(z)] = np.nan
    par = np.frombuffer(parent, dtype=np.int64)
    ordr = np.frombuffer(order, dtype=np.int64)

    def unpad(k: np.ndarray) -> np.ndarray:
        jj, ii = np.divmod(k, W)
        return (jj - 1) * nx + (ii - 1)

    par_u = np.full(ny * nx, -1, np.int64)
    pi = par.reshape(ny + 2, W)[1:-1, 1:-1].reshape(-1)
    ok = pi >= 0
    par_u[ok] = unpad(pi[ok])
    return Flood(filled, par_u, unpad(ordr))


def breach(z: np.ndarray, flood: Flood, check: Check = _no_check) -> np.ndarray:
    """Heights with each depression's spill path carved below its bottom (see the module doc)."""
    B = array("d", np.nan_to_num(z, nan=0.0).reshape(-1).tolist())
    parent = flood.parent.tolist()
    nextafter = math.nextafter
    ninf = -math.inf
    for k, c in enumerate(reversed(flood.order.tolist())):
        if k & 0xFFFF == 0:
            check()
        p = parent[c]
        if p >= 0 and B[p] >= B[c]:
            B[p] = nextafter(B[c], ninf)
    out = np.frombuffer(B, dtype=np.float64).reshape(z.shape).copy()
    out[~np.isfinite(z)] = np.nan
    return out


# ------------------------------------------------------------------------------------- directions


def _neighbours(h: np.ndarray) -> np.ndarray:
    """(8, ny, nx) neighbour heights. An off-grid neighbour (outside the window or nodata) takes the
    height of the local plane through the cell: the gradient from central differences, one-sided
    where a side is missing, zero where both are."""
    ny, nx = h.shape
    pad = np.full((ny + 2, nx + 2), np.nan)
    pad[1:-1, 1:-1] = h
    nb = np.empty((8, ny, nx))
    for k in range(8):
        nb[k] = pad[1 + DJ[k] : ny + 1 + DJ[k], 1 + DI[k] : nx + 1 + DI[k]]

    def slope(plus: np.ndarray, minus: np.ndarray) -> np.ndarray:
        both = np.isfinite(plus) & np.isfinite(minus)
        g = np.where(both, (plus - minus) / 2, 0.0)
        g = np.where(~both & np.isfinite(plus), plus - h, g)
        g = np.where(~both & np.isfinite(minus), h - minus, g)
        return g

    gx = slope(nb[0], nb[4])
    gy = slope(nb[2], nb[6])
    for k in range(8):
        miss = ~np.isfinite(nb[k])
        if miss.any():
            nb[k] = np.where(miss, h + gx * DI[k] + gy * DJ[k], nb[k])
    return nb


def _offgrid(h: np.ndarray) -> np.ndarray:
    """(8, ny, nx): True where neighbour k is outside the grid or has no data."""
    ny, nx = h.shape
    pad = np.zeros((ny + 2, nx + 2), bool)
    pad[1:-1, 1:-1] = np.isfinite(h)
    return np.stack([~pad[1 + DJ[k] : ny + 1 + DJ[k], 1 + DI[k] : nx + 1 + DI[k]] for k in range(8)])


@dataclass
class Routing:
    """Where each cell sends its water (flat indices; -1 is off the grid)."""

    shape: tuple[int, int]
    #: Up to two receivers per cell and the share each takes (D8: one receiver, share 1).
    r1: np.ndarray
    r2: np.ndarray
    p1: np.ndarray
    p2: np.ndarray
    #: D8 direction (0 to 7) of every valid cell, -1 for nodata; used for paths and watersheds.
    d8: np.ndarray
    #: The D8 receiver (-1 off the grid or nodata).
    d8r: np.ndarray
    valid: np.ndarray


def d8_directions(h: np.ndarray) -> np.ndarray:
    """Steepest-drop neighbour index per cell (-1 nodata). Every valid cell of a conditioned grid has
    a lower neighbour, on or off the grid."""
    nb = _neighbours(h)
    drop = (h[None] - nb) / DIST[:, None, None]
    drop = np.where(np.isfinite(drop), drop, -np.inf)
    k = np.argmax(drop, axis=0)
    best = np.take_along_axis(drop, k[None], axis=0)[0]
    out = np.where(np.isfinite(h), k, -1)
    # a cell with no lower neighbour anywhere (only on an exact flat at the edge): leave by the
    # nearest edge so it is an outlet, never a sink
    stuck = np.isfinite(h) & ~(best > 0)
    if stuck.any():
        off = _offgrid(h)
        first = np.argmax(off, axis=0)
        has = off.any(axis=0)
        out = np.where(stuck & has, first, out)
    return out


def receivers_of(d: np.ndarray) -> np.ndarray:
    """Flat receiver index of each cell for D8 directions ``d`` (-1 off the grid or nodata)."""
    ny, nx = d.shape
    jj, ii = np.mgrid[0:ny, 0:nx]
    k = np.clip(d, 0, 7)
    ti = ii + DI[k]
    tj = jj + DJ[k]
    inside = (d >= 0) & (ti >= 0) & (ti < nx) & (tj >= 0) & (tj < ny)
    r = np.where(inside, tj * nx + ti, -1).reshape(-1)
    return r


def routing(h: np.ndarray, method: str) -> Routing:
    """D8 or D-infinity routing over conditioned heights ``h`` (NaN no data)."""
    ny, nx = h.shape
    valid = np.isfinite(h)
    d8 = d8_directions(h)
    d8r = receivers_of(d8)
    # a receiver without data is off the grid
    flat_valid = valid.reshape(-1)
    d8r = np.where((d8r >= 0) & flat_valid[np.maximum(d8r, 0)], d8r, -1)
    if method == "d8":
        n = ny * nx
        return Routing(
            (ny, nx), d8r, np.full(n, -1), np.where(flat_valid, 1.0, 0.0), np.zeros(n), d8, d8r, valid
        )
    return _dinf(h, d8, d8r, valid)


def _dinf(h: np.ndarray, d8: np.ndarray, d8r: np.ndarray, valid: np.ndarray) -> Routing:
    """Tarboton (1997): eight facets (e0 the cell, e1 a cardinal neighbour, e2 the diagonal between
    it and the next cardinal); the steepest facet's direction, its share split by angle."""
    ny, nx = h.shape
    nb = _neighbours(h)
    off = _offgrid(h)
    best_s = np.full(h.shape, -np.inf)
    best_r = np.zeros(h.shape)
    best_k1 = np.zeros(h.shape, np.int64)
    best_k2 = np.zeros(h.shape, np.int64)
    quarter = math.pi / 4
    for f in range(8):
        # facets alternate: cardinal then diagonal, or diagonal then cardinal, around the cell
        a, b = f, (f + 1) % 8
        k1, k2 = (a, b) if a % 2 == 0 else (b, a)  # k1 cardinal, k2 diagonal
        e1, e2 = nb[k1], nb[k2]
        s1 = h - e1
        s2 = e1 - e2
        r = np.arctan2(s2, s1)
        s = np.hypot(s1, s2)
        lo = r < 0
        hi = r > quarter
        r = np.where(lo, 0.0, np.where(hi, quarter, r))
        s = np.where(lo, s1, np.where(hi, (h - e2) / math.sqrt(2), s))
        better = s > best_s
        best_s = np.where(better, s, best_s)
        best_r = np.where(better, r, best_r)
        best_k1 = np.where(better, k1, best_k1)
        best_k2 = np.where(better, k2, best_k2)
    share2 = best_r / quarter
    share1 = 1.0 - share2
    jj, ii = np.mgrid[0:ny, 0:nx]

    def target(k: np.ndarray) -> np.ndarray:
        ti, tj = ii + DI[k], jj + DJ[k]
        inside = (ti >= 0) & (ti < nx) & (tj >= 0) & (tj < ny)
        t = np.where(inside, tj * nx + ti, -1)
        offk = np.take_along_axis(off, k[None], axis=0)[0]
        return np.where(offk, -1, t).reshape(-1)

    t1, t2 = target(best_k1), target(best_k2)
    ok = valid & (best_s > 0)
    flat_ok = ok.reshape(-1)
    p1 = np.where(flat_ok, share1.reshape(-1), 0.0)
    p2 = np.where(flat_ok, share2.reshape(-1), 0.0)
    # no rising facet (an exact flat at an edge): all of it to the D8 receiver
    p1 = np.where(~flat_ok & valid.reshape(-1), 1.0, p1)
    t1 = np.where(flat_ok, t1, d8r)
    t2 = np.where(flat_ok & (p2 > 0), t2, -1)
    return Routing((ny, nx), t1, t2, p1, p2, d8, d8r, valid)


# ------------------------------------------------------------------------------------ accumulation


def accumulate(rt: Routing, weight: np.ndarray, check: Check = _no_check) -> np.ndarray:
    """Upslope sum of ``weight`` (cell areas, rain) through the routing graph, each cell included.

    Topological waves: cells nobody drains into first, then every cell whose donors are done.
    Shares sent off the grid leave it.
    """
    n = rt.r1.size
    acc = np.where(rt.valid.reshape(-1), weight.reshape(-1), 0.0).astype(np.float64)
    indeg = np.zeros(n, np.int64)
    for r, p in ((rt.r1, rt.p1), (rt.r2, rt.p2)):
        m = (r >= 0) & (p > 0)
        indeg += np.bincount(r[m], minlength=n)
    frontier = np.flatnonzero((indeg == 0) & rt.valid.reshape(-1))
    waves = 0
    while frontier.size:
        waves += 1
        if waves % 256 == 0:
            check()
        nxt = []
        for r, p in ((rt.r1, rt.p1), (rt.r2, rt.p2)):
            rr = r[frontier]
            pp = p[frontier]
            m = (rr >= 0) & (pp > 0)
            if not m.any():
                continue
            tgt = rr[m]
            np.add.at(acc, tgt, acc[frontier[m]] * pp[m])
            np.subtract.at(indeg, tgt, 1)
            nxt.append(tgt)
        if not nxt:
            break
        cand = np.unique(np.concatenate(nxt))
        frontier = cand[indeg[cand] == 0]
    return acc.reshape(rt.shape)


# ----------------------------------------------------------------------------- outlets and paths


def exit_point(i: int, j: int, k: int, origin_e: float, origin_n: float, cell: float) -> tuple[float, float]:
    """Where water leaving cell (i, j) in direction ``k`` crosses the cell's edge."""
    ce = origin_e + (i + 0.5) * cell
    cn = origin_n + (j + 0.5) * cell
    return ce + DI[k] * cell / 2, cn + DJ[k] * cell / 2


def trace(rt: Routing, start: int, limit: int | None = None) -> list[int]:
    """Cells from ``start`` along the D8 receivers until the water leaves the grid."""
    out = [start]
    seen = {start}
    c = start
    limit = limit or rt.r1.size
    while len(out) <= limit:
        r = int(rt.d8r[c])
        if r < 0 or r in seen:
            break
        out.append(r)
        seen.add(r)
        c = r
    return out


def label_watersheds(rt: Routing, seeds: np.ndarray, labels: np.ndarray) -> np.ndarray:
    """Each cell's label: that of the first seed cell its D8 path reaches (-1: none). Seeds hold
    ``labels``; pointer jumping keeps it vectorised (log of the longest path rounds)."""
    n = rt.d8r.size
    lab = np.full(n, -1, np.int64)
    lab[seeds] = labels
    nxt = np.where(rt.d8r >= 0, rt.d8r, np.arange(n))
    nxt[seeds] = seeds
    todo = np.flatnonzero((lab < 0) & rt.valid.reshape(-1))
    todo = todo[nxt[todo] != todo]
    while todo.size:
        t = nxt[todo]
        new_lab = lab[t]
        new_nxt = nxt[t]
        lab[todo] = new_lab
        nxt[todo] = new_nxt
        # done when labelled, or when the pointer reached a cell that leaves the grid unlabelled
        todo = todo[(new_lab < 0) & (new_nxt != t)]
    return lab.reshape(rt.shape)


def stream_lines(rt: Routing, stream: np.ndarray) -> list[list[int]]:
    """Polylines (cell lists, upstream first) of the stream cells along the D8 receivers, one per
    link: from a head or a confluence down to the next confluence or the grid's edge."""
    s = stream.reshape(-1)
    n = s.size
    r = rt.d8r
    down = np.where(s & (r >= 0), r, -1)
    down = np.where(down >= 0, np.where(s[np.maximum(down, 0)], down, -1), -1)
    ups = np.bincount(down[down >= 0], minlength=n)
    starts = np.flatnonzero(s & (ups != 1))
    lines: list[list[int]] = []
    visited = np.zeros(n, bool)
    down_l = down.tolist()
    ups_l = ups.tolist()
    for st in starts.tolist():
        line = [st]
        visited[st] = True
        c = st
        while True:
            d = down_l[c]
            if d < 0:
                break
            line.append(d)
            if ups_l[d] != 1 or visited[d]:
                break
            visited[d] = True
            c = d
        if len(line) >= 2:
            lines.append(line)
    return lines
