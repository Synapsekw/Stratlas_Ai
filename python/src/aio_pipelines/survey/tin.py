"""Triangulated surfaces of the survey engine (data-conventions sections 26 and 28).

- ``delaunay``: the Delaunay triangulation both executors compute the same way (a sweep-hull with
  the hull walks decided by the exact sign of the orientation and the flips by the same
  floating-point in-circle test, in the same order as ``packages/survey/src/engine/delaunay.ts``),
  so a ``smart`` or ``custom`` base is the same TIN in Python and TypeScript even where points are
  cocircular (a densified rectangle has many).
- ``Tin``: vertices in the local frame of a comparison with heights (a design's vertical offset
  added), sampled barycentrically; the lowest-numbered triangle holding a point gives its height.
- ``read_tin``: an ``aio.tin/1`` file (G6 writes them).
- ``exact_compare``: TIN to TIN cut and fill, exactly: the polygon is cut into triangles, each one
  clipped by the triangles of both sides, and the difference (linear on each piece) integrated
  over its parts above and below zero (or the deadband).
"""

from __future__ import annotations

import json
import math
import struct
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from ..runtime import JobError
from .grid import Window

EPSILON = 2.0**-52
#: Barycentric tolerance: a point this close outside a triangle (in its own coordinates) is in it.
BARY_EPS = 1e-9
#: Margin of the row spans of a triangle, in cells.
SPAN_EPS = 1e-6

Check = Callable[[], None]


def _no_check() -> None:
    return None


# --------------------------------------------------------------------------------------- delaunay


def _exact_orient_negative(px: float, py: float, qx: float, qy: float, rx: float, ry: float) -> bool:
    ratios = [v.as_integer_ratio() for v in (px, py, qx, qy, rx, ry)]
    den = max(d for _, d in ratios)
    a, b, c, d, e, f = (n * (den // dd) for n, dd in ratios)
    return (d - b) * (e - c) - (c - a) * (f - d) < 0


def orient(px: float, py: float, qx: float, qy: float, rx: float, ry: float) -> bool:
    """True when ``(qy - py) (rx - qx) - (qx - px) (ry - qy) < 0`` exactly (r left of p to q)."""
    left = (qy - py) * (rx - qx)
    right = (qx - px) * (ry - qy)
    det = left - right
    bound = 1e-15 * (abs(left) + abs(right))
    if det > bound:
        return False
    if -det > bound:
        return True
    if left == 0.0 and right == 0.0:
        return False
    return _exact_orient_negative(px, py, qx, qy, rx, ry)


def _in_circle(ax, ay, bx, by, cx, cy, px, py) -> bool:
    dx = ax - px
    dy = ay - py
    ex = bx - px
    ey = by - py
    fx = cx - px
    fy = cy - py
    ap = dx * dx + dy * dy
    bp = ex * ex + ey * ey
    cp = fx * fx + fy * fy
    return dx * (ey * cp - bp * fy) - dy * (ex * cp - bp * fx) + ap * (ex * fy - ey * fx) < 0


def _circumradius(ax, ay, bx, by, cx, cy) -> float:
    dx = bx - ax
    dy = by - ay
    ex = cx - ax
    ey = cy - ay
    bl = dx * dx + dy * dy
    cl = ex * ex + ey * ey
    den = dx * ey - dy * ex
    if den == 0:
        return math.inf
    d = 0.5 / den
    x = (ey * bl - dy * cl) * d
    y = (dx * cl - ex * bl) * d
    return x * x + y * y


def _circumcenter(ax, ay, bx, by, cx, cy) -> tuple[float, float]:
    dx = bx - ax
    dy = by - ay
    ex = cx - ax
    ey = cy - ay
    bl = dx * dx + dy * dy
    cl = ex * ex + ey * ey
    d = 0.5 / (dx * ey - dy * ex)
    return ax + (ey * bl - dy * cl) * d, ay + (dx * cl - ex * bl) * d


def _pseudo_angle(dx: float, dy: float) -> float:
    s = abs(dx) + abs(dy)
    if s == 0:
        return 0.0
    p = dx / s
    return (3 - p if dy > 0 else 1 + p) / 4


def _quicksort(ids: list[int], dists: list[float], left: int, right: int) -> None:
    stack = [(left, right)]
    while stack:
        left, right = stack.pop()
        if right - left <= 20:
            for i in range(left + 1, right + 1):
                temp = ids[i]
                temp_dist = dists[temp]
                j = i - 1
                while j >= left and dists[ids[j]] > temp_dist:
                    ids[j + 1] = ids[j]
                    j -= 1
                ids[j + 1] = temp
            continue
        median = (left + right) >> 1
        i = left + 1
        j = right
        ids[median], ids[i] = ids[i], ids[median]
        if dists[ids[left]] > dists[ids[right]]:
            ids[left], ids[right] = ids[right], ids[left]
        if dists[ids[i]] > dists[ids[right]]:
            ids[i], ids[right] = ids[right], ids[i]
        if dists[ids[left]] > dists[ids[i]]:
            ids[left], ids[i] = ids[i], ids[left]
        temp = ids[i]
        temp_dist = dists[temp]
        while True:
            i += 1
            while dists[ids[i]] < temp_dist:
                i += 1
            j -= 1
            while dists[ids[j]] > temp_dist:
                j -= 1
            if j < i:
                break
            ids[i], ids[j] = ids[j], ids[i]
        ids[left + 1] = ids[j]
        ids[j] = temp
        stack.append((left, j - 1))
        stack.append((i, right))


def delaunay(xs: list[float] | np.ndarray, ys: list[float] | np.ndarray) -> np.ndarray:
    """Triangles (m, 3) of the Delaunay triangulation of the points; empty when all are collinear."""
    x = [float(v) for v in xs]
    y = [float(v) for v in ys]
    n = len(x)
    if n < 3:
        return np.zeros((0, 3), np.int64)
    max_tri = max(2 * n - 5, 0)
    tris = [0] * (max_tri * 3)
    halfedges = [-1] * (max_tri * 3)
    hash_size = math.ceil(math.sqrt(n))
    hull_prev = [0] * n
    hull_next = [0] * n
    hull_tri = [0] * n
    hull_hash = [-1] * hash_size
    ids = list(range(n))
    dists = [0.0] * n

    min_x, min_y, max_x, max_y = math.inf, math.inf, -math.inf, -math.inf
    for i in range(n):
        if x[i] < min_x:
            min_x = x[i]
        if y[i] < min_y:
            min_y = y[i]
        if x[i] > max_x:
            max_x = x[i]
        if y[i] > max_y:
            max_y = y[i]
    cx = (min_x + max_x) / 2
    cy = (min_y + max_y) / 2

    def dist(ax, ay, bx, by):
        dx = ax - bx
        dy = ay - by
        return dx * dx + dy * dy

    i0 = i1 = i2 = 0
    min_dist = math.inf
    for i in range(n):
        d = dist(cx, cy, x[i], y[i])
        if d < min_dist:
            i0 = i
            min_dist = d
    i0x, i0y = x[i0], y[i0]
    min_dist = math.inf
    for i in range(n):
        if i == i0:
            continue
        d = dist(i0x, i0y, x[i], y[i])
        if d < min_dist and d > 0:
            i1 = i
            min_dist = d
    i1x, i1y = x[i1], y[i1]
    min_radius = math.inf
    for i in range(n):
        if i in (i0, i1):
            continue
        r = _circumradius(i0x, i0y, i1x, i1y, x[i], y[i])
        if r < min_radius:
            i2 = i
            min_radius = r
    i2x, i2y = x[i2], y[i2]
    if min_radius == math.inf:
        return np.zeros((0, 3), np.int64)
    if orient(i0x, i0y, i1x, i1y, i2x, i2y):
        i1, i2 = i2, i1
        i1x, i1y, i2x, i2y = i2x, i2y, i1x, i1y
    ccx, ccy = _circumcenter(i0x, i0y, i1x, i1y, i2x, i2y)
    for i in range(n):
        dists[i] = dist(x[i], y[i], ccx, ccy)
    _quicksort(ids, dists, 0, n - 1)

    def hash_key(px: float, py: float) -> int:
        return math.floor(_pseudo_angle(px - ccx, py - ccy) * hash_size) % hash_size

    hull_start = i0
    hull_size = 3
    hull_next[i0] = hull_prev[i2] = i1
    hull_next[i1] = hull_prev[i0] = i2
    hull_next[i2] = hull_prev[i1] = i0
    hull_tri[i0], hull_tri[i1], hull_tri[i2] = 0, 1, 2
    hull_hash[hash_key(i0x, i0y)] = i0
    hull_hash[hash_key(i1x, i1y)] = i1
    hull_hash[hash_key(i2x, i2y)] = i2

    tlen = 0
    edge_stack: list[int] = []

    def link(a: int, b: int) -> None:
        halfedges[a] = b
        if b != -1:
            halfedges[b] = a

    def add_triangle(a0: int, a1: int, a2: int, a: int, b: int, c: int) -> int:
        nonlocal tlen
        t = tlen
        tris[t] = a0
        tris[t + 1] = a1
        tris[t + 2] = a2
        link(t, a)
        link(t + 1, b)
        link(t + 2, c)
        tlen += 3
        return t

    def legalize(a: int) -> int:
        edge_stack.clear()
        ar = 0
        while True:
            b = halfedges[a]
            a0 = a - a % 3
            ar = a0 + (a + 2) % 3
            if b == -1:
                if not edge_stack:
                    break
                a = edge_stack.pop()
                continue
            b0 = b - b % 3
            al = a0 + (a + 1) % 3
            bl = b0 + (b + 2) % 3
            p0 = tris[ar]
            pr = tris[a]
            pl = tris[al]
            p1 = tris[bl]
            if _in_circle(x[p0], y[p0], x[pr], y[pr], x[pl], y[pl], x[p1], y[p1]):
                tris[a] = p1
                tris[b] = p0
                hbl = halfedges[bl]
                if hbl == -1:
                    e = hull_start
                    while True:
                        if hull_tri[e] == bl:
                            hull_tri[e] = a
                            break
                        e = hull_prev[e]
                        if e == hull_start:
                            break
                link(a, hbl)
                link(b, halfedges[ar])
                link(ar, bl)
                br = b0 + (b + 1) % 3
                if len(edge_stack) < 512:
                    edge_stack.append(br)
            else:
                if not edge_stack:
                    break
                a = edge_stack.pop()
        return ar

    add_triangle(i0, i1, i2, -1, -1, -1)
    xp = yp = 0.0
    for k in range(n):
        i = ids[k]
        px, py = x[i], y[i]
        if k > 0 and abs(px - xp) <= EPSILON and abs(py - yp) <= EPSILON:
            continue
        xp, yp = px, py
        if i in (i0, i1, i2):
            continue
        start = -1
        key = hash_key(px, py)
        for j in range(hash_size):
            probe = hull_hash[(key + j) % hash_size]
            if probe != -1 and probe != hull_next[probe]:
                start = probe
                break
        start = hull_prev[hull_start if start == -1 else start]
        e = start
        while True:
            q = hull_next[e]
            if orient(px, py, x[e], y[e], x[q], y[q]):
                break
            e = q
            if e == start:
                e = -1
                break
        if e == -1:
            continue
        t = add_triangle(e, i, hull_next[e], -1, -1, hull_tri[e])
        hull_tri[i] = legalize(t + 2)
        hull_tri[e] = t
        hull_size += 1
        nn = hull_next[e]
        while True:
            q = hull_next[nn]
            if not orient(px, py, x[nn], y[nn], x[q], y[q]):
                break
            t = add_triangle(nn, i, q, hull_tri[i], -1, hull_tri[nn])
            hull_tri[i] = legalize(t + 2)
            hull_next[nn] = nn
            hull_size -= 1
            nn = q
        if e == start:
            while True:
                q = hull_prev[e]
                if not orient(px, py, x[q], y[q], x[e], y[e]):
                    break
                t = add_triangle(q, i, e, -1, hull_tri[e], hull_tri[q])
                legalize(t + 2)
                hull_tri[q] = t
                hull_next[e] = e
                hull_size -= 1
                e = q
        hull_start = hull_prev[i] = e
        hull_next[e] = hull_prev[nn] = i
        hull_next[i] = nn
        hull_hash[hash_key(px, py)] = i
        hull_hash[hash_key(x[e], y[e])] = e
    return np.array(tris[:tlen], dtype=np.int64).reshape(-1, 3)


# -------------------------------------------------------------------------------------------- tin


@dataclass
class Tin:
    """A triangulated surface in a comparison's local frame (metres from its origin)."""

    x: np.ndarray
    y: np.ndarray
    z: np.ndarray
    tris: np.ndarray

    def __post_init__(self) -> None:
        self.x = np.asarray(self.x, dtype=np.float64)
        self.y = np.asarray(self.y, dtype=np.float64)
        self.z = np.asarray(self.z, dtype=np.float64)
        self.tris = np.asarray(self.tris, dtype=np.int64).reshape(-1, 3)
        t = self.tris
        if len(t):
            self.tx0 = np.minimum(np.minimum(self.x[t[:, 0]], self.x[t[:, 1]]), self.x[t[:, 2]])
            self.tx1 = np.maximum(np.maximum(self.x[t[:, 0]], self.x[t[:, 1]]), self.x[t[:, 2]])
            self.ty0 = np.minimum(np.minimum(self.y[t[:, 0]], self.y[t[:, 1]]), self.y[t[:, 2]])
            self.ty1 = np.maximum(np.maximum(self.y[t[:, 0]], self.y[t[:, 1]]), self.y[t[:, 2]])
        else:
            self.tx0 = self.tx1 = self.ty0 = self.ty1 = np.zeros(0)
        self._index: TriIndex | None = None

    @property
    def index(self) -> TriIndex:
        if self._index is None:
            self._index = TriIndex(self)
        return self._index

    def corners(self, t: int) -> tuple[float, float, float, float, float, float, float, float, float]:
        a, b, c = (int(v) for v in self.tris[t])
        x, y, z = self.x, self.y, self.z
        return (
            float(x[a]),
            float(y[a]),
            float(z[a]),
            float(x[b]),
            float(y[b]),
            float(z[b]),
            float(x[c]),
            float(y[c]),
            float(z[c]),
        )

    def z_range(self) -> tuple[float, float]:
        return float(self.z.min()), float(self.z.max())


class TriIndex:
    """Triangles by bucket, for finding the ones near a point or a box."""

    def __init__(self, tin: Tin):
        m = len(tin.tris)
        self.x0 = float(tin.tx0.min()) if m else 0.0
        self.y0 = float(tin.ty0.min()) if m else 0.0
        x1 = float(tin.tx1.max()) if m else 1.0
        y1 = float(tin.ty1.max()) if m else 1.0
        nb = max(1, min(1024, math.ceil(math.sqrt(max(m, 1) / 2))))
        self.nb = nb
        self.bw = max((x1 - self.x0) / nb, 1e-9)
        self.bh = max((y1 - self.y0) / nb, 1e-9)
        if m == 0:
            self.starts = np.zeros(nb * nb + 1, np.int64)
            self.items = np.zeros(0, np.int64)
            return
        ia = np.clip(np.floor((tin.tx0 - self.x0) / self.bw).astype(np.int64), 0, nb - 1)
        ib = np.clip(np.floor((tin.tx1 - self.x0) / self.bw).astype(np.int64), 0, nb - 1)
        ja = np.clip(np.floor((tin.ty0 - self.y0) / self.bh).astype(np.int64), 0, nb - 1)
        jb = np.clip(np.floor((tin.ty1 - self.y0) / self.bh).astype(np.int64), 0, nb - 1)
        w = ib - ia + 1
        cnt = w * (jb - ja + 1)
        tri = np.repeat(np.arange(m), cnt)
        local = np.arange(int(cnt.sum())) - np.repeat(np.cumsum(cnt) - cnt, cnt)
        wr = np.repeat(w, cnt)
        bucket = (np.repeat(ja, cnt) + local // wr) * nb + np.repeat(ia, cnt) + local % wr
        order = np.lexsort((tri, bucket))
        self.items = tri[order]
        self.starts = np.searchsorted(bucket[order], np.arange(nb * nb + 1))

    def box(self, x0: float, y0: float, x1: float, y1: float) -> np.ndarray:
        nb = self.nb
        ia = min(max(math.floor((x0 - self.x0) / self.bw), 0), nb - 1)
        ib = min(max(math.floor((x1 - self.x0) / self.bw), 0), nb - 1)
        ja = min(max(math.floor((y0 - self.y0) / self.bh), 0), nb - 1)
        jb = min(max(math.floor((y1 - self.y0) / self.bh), 0), nb - 1)
        parts = [
            self.items[self.starts[j * nb + ia] : self.starts[j * nb + ib + 1]] for j in range(ja, jb + 1)
        ]
        if not parts:
            return np.zeros(0, np.int64)
        return np.unique(np.concatenate(parts))


def bary(ax, ay, bx, by, cx, cy, px, py):
    """Barycentric weights of p in (a, b, c); the same formula as the TypeScript executor."""
    d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
    l1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / d
    l2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / d
    return l1, l2, 1 - l1 - l2


def tri_z(c9, px, py):
    ax, ay, az, bx, by, bz, cx, cy, cz = c9
    l1, l2, l3 = bary(ax, ay, bx, by, cx, cy, px, py)
    return l1 * az + l2 * bz + l3 * cz


def sample_points(tin: Tin, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
    """Heights at points; NaN outside the TIN. The lowest-numbered triangle holding a point wins."""
    out = np.full(len(xs), np.nan)
    if len(tin.tris) == 0:
        return out
    idx = tin.index
    for k in range(len(xs)):
        px, py = float(xs[k]), float(ys[k])
        for t in idx.box(px, py, px, py):
            t = int(t)
            if px < tin.tx0[t] or px > tin.tx1[t] or py < tin.ty0[t] or py > tin.ty1[t]:
                continue
            ax, ay, az, bx, by, bz, cx, cy, cz = tin.corners(t)
            d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
            if d == 0:
                continue
            l1, l2, l3 = bary(ax, ay, bx, by, cx, cy, px, py)
            if l1 >= -BARY_EPS and l2 >= -BARY_EPS and l3 >= -BARY_EPS:
                out[k] = l1 * az + l2 * bz + l3 * cz
                break
    return out


def rasterize(tin: Tin, win: Window, check: Check = _no_check) -> np.ndarray:
    """Heights at the centres of the window's cells; NaN outside. Lowest-numbered triangle wins."""
    c = win.cell
    out = np.full((win.ny, win.nx), np.nan)
    if len(tin.tris) == 0:
        return out
    wx0, wx1 = win.i0 * c, (win.i0 + win.nx) * c
    wy0, wy1 = win.j0 * c, (win.j0 + win.ny) * c
    cand = np.nonzero((tin.tx1 >= wx0) & (tin.tx0 <= wx1) & (tin.ty1 >= wy0) & (tin.ty0 <= wy1))[0]
    for n_done, t in enumerate(cand):
        if n_done % 1024 == 0:
            check()
        ax, ay, az, bx, by, bz, cx, cy, cz = tin.corners(int(t))
        d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
        if d == 0:
            continue
        r0 = max(math.ceil(min(ay, by, cy) / c - 0.5 - SPAN_EPS), win.j0)
        r1 = min(math.floor(max(ay, by, cy) / c - 0.5 + SPAN_EPS), win.j0 + win.ny - 1)
        if r0 > r1:
            continue
        rows = np.arange(r0, r1 + 1)
        yc = (rows + 0.5) * c
        xl = np.full(len(rows), np.inf)
        xr = np.full(len(rows), -np.inf)
        for px, py, qx, qy in ((ax, ay, bx, by), (bx, by, cx, cy), (cx, cy, ax, ay)):
            if py == qy:
                on = yc == py
                xl = np.where(on, np.minimum(xl, min(px, qx)), xl)
                xr = np.where(on, np.maximum(xr, max(px, qx)), xr)
                continue
            lo, hi = min(py, qy), max(py, qy)
            inr = (yc >= lo) & (yc <= hi)
            xe = px + (yc - py) * (qx - px) / (qy - py)
            xl = np.where(inr, np.minimum(xl, xe), xl)
            xr = np.where(inr, np.maximum(xr, xe), xr)
        # rows the triangle only grazes within the margin still get a span around its nearest x
        far = xl > xr
        if far.any():
            xm = min(ax, bx, cx)
            xM = max(ax, bx, cx)
            xl = np.where(far, xm, xl)
            xr = np.where(far, xM, xr)
        ia = np.maximum(np.ceil(xl / c - 0.5 - SPAN_EPS).astype(np.int64), win.i0)
        ib = np.minimum(np.floor(xr / c - 0.5 + SPAN_EPS).astype(np.int64), win.i0 + win.nx - 1)
        cnt = np.maximum(ib - ia + 1, 0)
        total = int(cnt.sum())
        if total == 0:
            continue
        ri = np.repeat(rows, cnt)
        ci = np.repeat(ia, cnt) + (np.arange(total) - np.repeat(np.cumsum(cnt) - cnt, cnt))
        px = (ci + 0.5) * c
        py = (ri + 0.5) * c
        l1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / d
        l2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / d
        l3 = 1 - l1 - l2
        ok = (l1 >= -BARY_EPS) & (l2 >= -BARY_EPS) & (l3 >= -BARY_EPS)
        rr, cc = ri[ok] - win.j0, ci[ok] - win.i0
        free = np.isnan(out[rr, cc])
        out[rr[free], cc[free]] = (l1[ok] * az + l2[ok] * bz + l3[ok] * cz)[free]
    return out


class HullExtension:
    """Heights beyond a TIN's hull: the height of the nearest point of the hull (a base TIN only).

    Cells at a polygon's edge whose centre lies just outside the base's triangles take it, so a
    partly covered cell is never counted as uncovered because of the base. Ties go to the
    hull edge met first (by triangle, then edge order), the same in both executors.
    """

    def __init__(self, tin: Tin):
        seen: dict[tuple[int, int], int] = {}
        order: list[tuple[int, int]] = []
        for t in range(len(tin.tris)):
            a, b, c = (int(v) for v in tin.tris[t])
            for p, q in ((a, b), (b, c), (c, a)):
                key = (p, q) if p < q else (q, p)
                if key in seen:
                    seen[key] += 1
                else:
                    seen[key] = 1
                    order.append((p, q))
        edges = [e for e in order if seen[(e[0], e[1]) if e[0] < e[1] else (e[1], e[0])] == 1]
        self.n = len(edges)
        ea = np.array([e[0] for e in edges], dtype=np.int64)
        eb = np.array([e[1] for e in edges], dtype=np.int64)
        self.ax, self.ay, self.az = tin.x[ea], tin.y[ea], tin.z[ea]
        self.bx, self.by, self.bz = tin.x[eb], tin.y[eb], tin.z[eb]
        if self.n == 0:
            return
        x0 = float(min(self.ax.min(), self.bx.min()))
        y0 = float(min(self.ay.min(), self.by.min()))
        x1 = float(max(self.ax.max(), self.bx.max()))
        y1 = float(max(self.ay.max(), self.by.max()))
        nb = max(1, math.ceil(math.sqrt(self.n)))
        self.bs = max((x1 - x0) / nb, (y1 - y0) / nb, 1e-9)
        self.x0, self.y0, self.nb = x0, y0, nb
        self.cells: dict[tuple[int, int], list[int]] = {}
        for k in range(self.n):
            i0 = math.floor((min(self.ax[k], self.bx[k]) - x0) / self.bs)
            i1 = math.floor((max(self.ax[k], self.bx[k]) - x0) / self.bs)
            j0 = math.floor((min(self.ay[k], self.by[k]) - y0) / self.bs)
            j1 = math.floor((max(self.ay[k], self.by[k]) - y0) / self.bs)
            for j in range(j0, j1 + 1):
                for i in range(i0, i1 + 1):
                    self.cells.setdefault((i, j), []).append(k)

    def z(self, px: float, py: float) -> float:
        if self.n == 0:
            return math.nan
        bi = math.floor((px - self.x0) / self.bs)
        bj = math.floor((py - self.y0) / self.bs)
        best = (math.inf, -1, math.nan)
        seen: set[int] = set()
        limit = max(abs(bi), abs(bj), abs(bi - self.nb), abs(bj - self.nb)) + self.nb + 1
        for r in range(limit + 1):
            for j in range(bj - r, bj + r + 1):
                for i in range(bi - r, bi + r + 1):
                    if max(abs(i - bi), abs(j - bj)) != r:
                        continue
                    for k in self.cells.get((i, j), ()):
                        if k in seen:
                            continue
                        seen.add(k)
                        ax, ay, bx, by = self.ax[k], self.ay[k], self.bx[k], self.by[k]
                        dx, dy = bx - ax, by - ay
                        l2 = dx * dx + dy * dy
                        t = 0.0 if l2 == 0 else ((px - ax) * dx + (py - ay) * dy) / l2
                        t = min(max(t, 0.0), 1.0)
                        qx, qy = ax + t * dx, ay + t * dy
                        d2 = (px - qx) * (px - qx) + (py - qy) * (py - qy)
                        if d2 < best[0] or (d2 == best[0] and k < best[1]):
                            best = (d2, k, self.az[k] + t * (self.bz[k] - self.az[k]))
            if best[1] >= 0 and math.sqrt(best[0]) < r * self.bs:
                break
        return float(best[2])


# ------------------------------------------------------------------------------------- aio.tin/1


def read_tin(path: Path, origin_e: float, origin_n: float, offset: float = 0.0) -> Tin:
    """An ``aio.tin/1`` file as a TIN in the local frame at (origin_e, origin_n), offset added."""
    try:
        data = Path(path).read_bytes()
    except OSError as e:
        raise JobError(f"The design surface {Path(path).name} could not be read: {e}") from e
    bad = f"The design surface {Path(path).name} is not an aio.tin/1 file"
    if len(data) < 4:
        raise JobError(f"{bad}.")
    (hlen,) = struct.unpack_from("<I", data, 0)
    if hlen > len(data) - 4 or hlen > 1_000_000:
        raise JobError(f"{bad}.")
    try:
        head = json.loads(data[4 : 4 + hlen].decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as e:
        raise JobError(f"{bad}: {e}") from e
    if not isinstance(head, dict) or head.get("schema") != "aio.tin/1":
        raise JobError(f"{bad}.")
    nv, nt = int(head.get("vertexCount", -1)), int(head.get("triangleCount", -1))
    va, ta = int(head.get("verticesAt", -1)), int(head.get("trianglesAt", -1))
    if nv < 0 or nt < 0 or nt > 2_000_000 or va < 0 or ta < 0:
        raise JobError(f"{bad}: its counts are wrong.")
    if va + nv * 24 > len(data) or ta + nt * 12 > len(data):
        raise JobError(f"{bad}: it is shorter than its header says.")
    v = np.frombuffer(data, dtype="<f8", count=nv * 3, offset=va).reshape(-1, 3)
    t = np.frombuffer(data, dtype="<u4", count=nt * 3, offset=ta).reshape(-1, 3).astype(np.int64)
    if nt and int(t.max()) >= nv:
        raise JobError(f"{bad}: a triangle names a vertex it does not have.")
    return Tin(v[:, 0] - origin_e, v[:, 1] - origin_n, v[:, 2] + offset, t)


def write_tin(path: Path, vertices: np.ndarray, triangles: np.ndarray, crs: dict) -> None:
    """Write an ``aio.tin/1`` file (tests and fixtures; G6 owns the design importer)."""
    v = np.asarray(vertices, dtype="<f8").reshape(-1, 3)
    t = np.asarray(triangles, dtype="<u4").reshape(-1, 3)
    head = {
        "schema": "aio.tin/1",
        "crs": crs,
        "bounds": [
            float(v[:, 0].min()),
            float(v[:, 1].min()),
            float(v[:, 2].min()),
            float(v[:, 0].max()),
            float(v[:, 1].max()),
            float(v[:, 2].max()),
        ],
        "vertexCount": len(v),
        "triangleCount": len(t),
        "verticesAt": 0,
        "trianglesAt": 0,
    }
    for _ in range(2):
        raw = json.dumps(head, separators=(",", ":")).encode("utf-8")
        start = 4 + len(raw)
        start += (-start) % 8
        head["verticesAt"] = start
        head["trianglesAt"] = start + v.nbytes
    raw = json.dumps(head, separators=(",", ":")).encode("utf-8")
    pad = b" " * (head["verticesAt"] - 4 - len(raw))
    Path(path).write_bytes(struct.pack("<I", len(raw)) + raw + pad + v.tobytes() + t.tobytes())


# --------------------------------------------------------------------------------------- polygons

Pt = tuple[float, float]


def _cross(o: Pt, a: Pt, b: Pt) -> float:
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])


def ear_clip(ring: list[Pt]) -> list[tuple[Pt, Pt, Pt]]:
    """Counter-clockwise triangles covering a simple counter-clockwise ring."""
    pts = list(ring)
    out: list[tuple[Pt, Pt, Pt]] = []
    guard = 0
    while len(pts) > 3 and guard < 10 * len(ring) + 10:
        guard += 1
        n = len(pts)
        found = False
        for k in range(n):
            a, b, c = pts[k - 1], pts[k], pts[(k + 1) % n]
            cr = _cross(a, b, c)
            if cr == 0:
                # a straight (or doubled-back) vertex adds nothing
                pts.pop(k)
                found = True
                break
            if cr < 0:
                continue
            ok = True
            for m in range(n):
                p = pts[m]
                if p in (a, b, c):
                    continue
                if _cross(a, b, p) >= 0 and _cross(b, c, p) >= 0 and _cross(c, a, p) >= 0:
                    ok = False
                    break
            if ok:
                out.append((a, b, c))
                pts.pop(k)
                found = True
                break
        if not found:
            # numerically stuck: cut the most convex corner
            k = max(range(n), key=lambda k: _cross(pts[k - 1], pts[k], pts[(k + 1) % n]))
            out.append((pts[k - 1], pts[k], pts[(k + 1) % n]))
            pts.pop(k)
    if len(pts) == 3 and _cross(pts[0], pts[1], pts[2]) > 0:
        out.append((pts[0], pts[1], pts[2]))
    return out


def _clip_half(poly: list[Pt], f: Callable[[Pt], float]) -> list[Pt]:
    """The part of a convex polygon where ``f >= 0`` (f linear)."""
    out: list[Pt] = []
    n = len(poly)
    if n == 0:
        return out
    vals = [f(p) for p in poly]
    for k in range(n):
        p, q = poly[k], poly[(k + 1) % n]
        fp, fq = vals[k], vals[(k + 1) % n]
        if fp >= 0:
            out.append(p)
        if (fp >= 0) != (fq >= 0):
            t = fp / (fp - fq)
            out.append((p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])))
    return out


def clip_tri(poly: list[Pt], a: Pt, b: Pt, c: Pt) -> list[Pt]:
    """A convex polygon clipped by a triangle (any orientation)."""
    if _cross(a, b, c) < 0:
        b, c = c, b
    out = poly
    for p, q in ((a, b), (b, c), (c, a)):
        out = _clip_half(out, lambda r, p=p, q=q: _cross(p, q, r))
        if len(out) < 3:
            return []
    return out


def poly_area(poly: list[Pt]) -> float:
    s = 0.0
    n = len(poly)
    if n < 3:
        return 0.0
    x0, y0 = poly[0]
    for k in range(1, n - 1):
        s += (poly[k][0] - x0) * (poly[k + 1][1] - y0) - (poly[k + 1][0] - x0) * (poly[k][1] - y0)
    return s / 2


def _integral(poly: list[Pt], vals: list[float]) -> tuple[float, float]:
    """Area and the integral of a linear function (values at the vertices) over a convex polygon."""
    area = 0.0
    total = 0.0
    x0, y0 = poly[0]
    for k in range(1, len(poly) - 1):
        a = ((poly[k][0] - x0) * (poly[k + 1][1] - y0) - (poly[k + 1][0] - x0) * (poly[k][1] - y0)) / 2
        area += a
        total += a * (vals[0] + vals[k] + vals[k + 1]) / 3
    return area, total


# ------------------------------------------------------------------------------------- tin to tin


class Planar:
    """A side of a comparison given as a function of (x, y) everywhere (a level or a plane)."""

    def __init__(self, fn: Callable[[float, float], float]):
        self.fn = fn


Side = Tin | Planar


def _pieces(poly: list[Pt], side: Side):
    """(part of ``poly``, its height function) for each triangle of the side under it."""
    if isinstance(side, Planar):
        yield poly, side.fn
        return
    xs = [p[0] for p in poly]
    ys = [p[1] for p in poly]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    for t in side.index.box(x0, y0, x1, y1):
        t = int(t)
        if side.tx0[t] > x1 or side.tx1[t] < x0 or side.ty0[t] > y1 or side.ty1[t] < y0:
            continue
        c9 = side.corners(t)
        ax, ay, _, bx, by, _, cx, cy, _ = c9
        if (by - cy) * (ax - cx) + (cx - bx) * (ay - cy) == 0:
            continue
        part = clip_tri(poly, (ax, ay), (bx, by), (cx, cy))
        if len(part) >= 3:
            yield part, (lambda px, py, c9=c9: tri_z(c9, px, py))


@dataclass
class ExactTotals:
    fill: float = 0.0
    cut: float = 0.0
    area_fill: float = 0.0
    area_cut: float = 0.0
    area_unchanged: float = 0.0
    covered: float = 0.0


def exact_compare(
    ptris: list[tuple[Pt, Pt, Pt]], from_side: Side, to_side: Side, deadband: float, check: Check = _no_check
) -> ExactTotals:
    """Cut and fill of ``to - from`` over the polygon's triangles, exactly (no grid)."""
    out = ExactTotals()
    for k, (a, b, c) in enumerate(ptris):
        if k % 16 == 0:
            check()
        for q, f_from in _pieces([a, b, c], from_side):
            for r, f_to in _pieces(q, to_side):
                dz = [f_to(p[0], p[1]) - f_from(p[0], p[1]) for p in r]
                area, _ = _integral(r, dz)
                if area <= 0:
                    continue
                out.covered += area
                if all(v == 0 for v in dz):
                    out.area_unchanged += area
                    continue
                fpart = _clip_lin(r, dz, 1.0, deadband)
                cpart = _clip_lin(r, dz, -1.0, deadband)
                fa = ft = ca = ct = 0.0
                if fpart:
                    fa, ft = _integral(*fpart)
                if cpart:
                    ca, ct = _integral(*cpart)
                out.fill += max(ft, 0.0)
                out.cut += max(-ct, 0.0)
                out.area_fill += max(fa, 0.0)
                out.area_cut += max(ca, 0.0)
                out.area_unchanged += max(area - fa - ca, 0.0)
    return out


def _clip_lin(poly: list[Pt], vals: list[float], sign: float, deadband: float):
    """The part of ``poly`` where ``sign * value >= deadband``, with the values carried along."""
    g = [sign * v - deadband for v in vals]
    out_p: list[Pt] = []
    out_v: list[float] = []
    n = len(poly)
    for k in range(n):
        p, q = poly[k], poly[(k + 1) % n]
        gp, gq = g[k], g[(k + 1) % n]
        if gp >= 0:
            out_p.append(p)
            out_v.append(vals[k])
        if (gp >= 0) != (gq >= 0):
            t = gp / (gp - gq)
            out_p.append((p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])))
            out_v.append(vals[k] + t * (vals[(k + 1) % n] - vals[k]))
    if len(out_p) < 3:
        return None
    return out_p, out_v


def tin_extremes(ptris: list[tuple[Pt, Pt, Pt]], side: Tin) -> tuple[float, float] | None:
    """Lowest and highest height of a TIN over the polygon's triangles (at the pieces' corners)."""
    lo, hi = math.inf, -math.inf
    for a, b, c in ptris:
        for part, fn in _pieces([a, b, c], side):
            for p in part:
                z = fn(p[0], p[1])
                lo = min(lo, z)
                hi = max(hi, z)
    return None if lo == math.inf else (lo, hi)
