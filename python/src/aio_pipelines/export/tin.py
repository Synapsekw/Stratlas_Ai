"""Surfaces as triangles for the TIN formats (LandXML, 12da, DXF 3DFACE).

- ``grid_tin``: a prepared grid (heights at the cell centres, its posts) as a TIN of its posts, every
  ``step``-th post kept (decimation keeps surveyed heights exactly, never an average): two
  triangles per square of four posts with data, one where three of them have data, all
  counter-clockwise seen from above.
- ``boundary_rings``: the outer boundaries and holes of a TIN, as vertex index rings (the edges used
  by one triangle only, chained).
- ``tin_limit``: the decimation step a grid needs to stay within ``MAX_TRIANGLES``.
"""

from __future__ import annotations

import math
from collections import defaultdict
from collections.abc import Callable

import numpy as np

from ..design.model import MAX_TRIANGLES
from ..runtime import JobError
from ..survey.grid import GridSurface

STRIP_ROWS = 512


def step_for(decimate: float | None) -> int:
    """Posts kept one in ``step`` each way for a share ``decimate`` of the faces (1 keeps all)."""
    if decimate is None or decimate >= 1:
        return 1
    return max(1, round(1 / math.sqrt(decimate)))


def read_posts(
    g: GridSurface,
    box: tuple[float, float, float, float],
    step: int,
    check: Callable[[], None] = lambda: None,
) -> tuple[np.ndarray, float, float, float]:
    """(heights rows north, E of column 0's post, N of row 0's post, post spacing) over ``box``."""
    e0, n0, e1, n1 = box
    i0 = max(0, math.floor((e0 - g.origin_e) / g.cell + 1e-9))
    j0 = max(0, math.floor((n0 - g.origin_n) / g.cell + 1e-9))
    i1 = min(g.nx, math.ceil((e1 - g.origin_e) / g.cell - 1e-9))
    j1 = min(g.ny, math.ceil((n1 - g.origin_n) / g.cell - 1e-9))
    w, h = max(1, i1 - i0), max(1, j1 - j0)
    cols = range(0, w, step)
    rows = list(range(0, h, step))
    out = np.full((len(rows), len(cols)), np.nan)
    for k in range(0, len(rows), STRIP_ROWS):
        check()
        part = rows[k : k + STRIP_ROWS]
        a, b = part[0], part[-1] + 1
        band = g.read(i0, j0 + a, w, b - a)
        out[k : k + len(part)] = band[np.asarray(part) - a][:, ::step]
    pe = g.origin_e + (i0 + 0.5) * g.cell
    pn = g.origin_n + (j0 + 0.5) * g.cell
    return out, pe, pn, g.cell * step


def tin_limit(width: int, height: int) -> int:
    """The smallest step that keeps a grid of ``width`` by ``height`` posts within the triangle limit."""
    step = 1
    while 2 * math.ceil(width / step) * math.ceil(height / step) > MAX_TRIANGLES:
        step += 1
    return step


def grid_tin(z: np.ndarray, pe: float, pn: float, spacing: float) -> tuple[np.ndarray, np.ndarray]:
    """Vertices (E, N, Z) and counter-clockwise triangles of the posts of ``z`` (rows north)."""
    ny, nx = z.shape
    ok = np.isfinite(z)
    idx = np.full(z.shape, -1, dtype=np.int64)
    idx[ok] = np.arange(int(ok.sum()))
    jj, ii = np.nonzero(ok)
    verts = np.stack([pe + ii * spacing, pn + jj * spacing, z[ok]], axis=1)
    if nx < 2 or ny < 2:
        return verts, np.zeros((0, 3), np.uint32)
    a = idx[:-1, :-1]  # south-west
    b = idx[:-1, 1:]  # south-east
    c = idx[1:, 1:]  # north-east
    d = idx[1:, :-1]  # north-west
    va, vb, vc, vd = a >= 0, b >= 0, c >= 0, d >= 0
    tris = []
    full = va & vb & vc & vd
    tris.append(np.stack([a[full], b[full], c[full]], axis=1))
    tris.append(np.stack([a[full], c[full], d[full]], axis=1))
    for m, t in (
        (~va & vb & vc & vd, (b, c, d)),
        (va & ~vb & vc & vd, (a, c, d)),
        (va & vb & ~vc & vd, (a, b, d)),
        (va & vb & vc & ~vd, (a, b, c)),
    ):
        tris.append(np.stack([t[0][m], t[1][m], t[2][m]], axis=1))
    tri = np.concatenate(tris).astype(np.uint32) if tris else np.zeros((0, 3), np.uint32)
    if len(tri) > MAX_TRIANGLES:
        raise JobError(
            f"The surface would have {len(tri):,} triangles, above the {MAX_TRIANGLES:,} a surface "
            "file holds; choose a lower level of detail."
        )
    return verts, tri


def ccw(vertices: np.ndarray, triangles: np.ndarray) -> np.ndarray:
    """Triangles turned counter-clockwise seen from above."""
    t = np.asarray(triangles, dtype=np.int64).reshape(-1, 3).copy()
    if len(t) == 0:
        return t
    v = np.asarray(vertices, dtype=np.float64)
    a, b, c = v[t[:, 0]], v[t[:, 1]], v[t[:, 2]]
    cross = (b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (b[:, 1] - a[:, 1]) * (c[:, 0] - a[:, 0])
    flip = cross < 0
    t[flip] = t[flip][:, [0, 2, 1]]
    return t


def boundary_rings(vertices: np.ndarray, triangles: np.ndarray) -> list[tuple[bool, list[int]]]:
    """(is outer, vertex ring) per boundary loop: outer loops run counter-clockwise, holes clockwise."""
    t = ccw(vertices, triangles)
    count: dict[tuple[int, int], int] = defaultdict(int)
    for a, b, c in t:
        for u, w in ((a, b), (b, c), (c, a)):
            count[(min(u, w), max(u, w))] += 1
    nxt: dict[int, list[int]] = defaultdict(list)
    for a, b, c in t:
        for u, w in ((a, b), (b, c), (c, a)):
            if count[(min(u, w), max(u, w))] == 1:
                nxt[int(u)].append(int(w))
    rings: list[tuple[bool, list[int]]] = []
    v = np.asarray(vertices, dtype=np.float64)
    while nxt:
        start = next(iter(nxt))
        ring = [start]
        cur = start
        while True:
            outs = nxt.get(cur)
            if not outs:
                break
            w = outs.pop()
            if not outs:
                del nxt[cur]
            if w == start:
                break
            ring.append(w)
            cur = w
        if len(ring) >= 3:
            xy = v[ring, :2]
            area = 0.5 * float(np.sum(xy[:, 0] * np.roll(xy[:, 1], -1) - np.roll(xy[:, 0], -1) * xy[:, 1]))
            rings.append((area > 0, ring))
    rings.sort(key=lambda r: (not r[0], -len(r[1])))
    return rings
