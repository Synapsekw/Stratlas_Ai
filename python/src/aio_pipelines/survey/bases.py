"""Bases of the survey engine (data-conventions section 26): flat levels, planes and TINs.

A base is sampled on the surface side of its item (the other side): along the polygon's edges
densified at the step (the comparison cell, or ``TIN_STEP_M`` on the TIN to TIN path), or over the
covered cells. Samples without data are left out; a base needs one valid sample (levels) or three
(planes and TINs), else the item is refused with the reason. The kit's bases are four of these:
``tin`` is ``smart``, ``plane`` is ``fit-plane``, ``avg`` is ``perimeter-mean``, ``low`` is
``reference`` ``perimeter-min``.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import numpy as np

from .tin import Planar, Tin, delaunay

#: Perimeter sample step on the exact path (no grid), unless the item gives ``cellM``.
TIN_STEP_M = 0.1


class Refused(Exception):
    """An item that cannot be computed; the message is the result's reason."""


def f3(x: float) -> str:
    """Metres with three decimals, rounded half away from zero (the same in both executors)."""
    n = math.floor(abs(x) * 1000 + 0.5)
    sign = "-" if x < 0 and n > 0 else ""
    return f"{sign}{n // 1000}.{n % 1000:03d}"


def fit_plane(
    xs: np.ndarray, ys: np.ndarray, zs: np.ndarray, ox: float, oy: float
) -> tuple[float, float, float]:
    """Least-squares plane ``z = p0 + p1 (x - ox) + p2 (y - oy)``: normal equations, Gauss-Jordan.

    The stockpile kit's arithmetic (``editGeometry``) step by step, so its numbers stay identical.
    """
    a = [[0.0, 0.0, 0.0], [0.0, 0.0, 0.0], [0.0, 0.0, 0.0]]
    r = [0.0, 0.0, 0.0]
    for k in range(len(xs)):
        v = (1.0, float(xs[k]) - ox, float(ys[k]) - oy)
        z = float(zs[k])
        for i in range(3):
            r[i] = r[i] + v[i] * z
            for j in range(3):
                a[i][j] = a[i][j] + v[i] * v[j]
    m = [[*a[i], r[i]] for i in range(3)]
    for i in range(3):
        pv = i
        for k in range(i + 1, 3):
            if abs(m[k][i]) > abs(m[pv][i]):
                pv = k
        m[i], m[pv] = m[pv], m[i]
        if abs(m[i][i]) < 1e-9:
            continue
        for k in range(3):
            if k == i:
                continue
            f = m[k][i] / m[i][i]
            for q in range(i, 4):
                m[k][q] = m[k][q] - f * m[i][q]
    pc = [0.0 if abs(m[i][i]) < 1e-9 else m[i][3] / m[i][i] for i in range(3)]
    return pc[0], pc[1], pc[2]


def plane_fn(p: tuple[float, float, float], ox: float, oy: float) -> Callable[[Any, Any], Any]:
    p0, p1, p2 = p
    return lambda x, y: p0 + p1 * (x - ox) + p2 * (y - oy)


def level_fn(z: float) -> Callable[[Any, Any], Any]:
    return lambda x, y: z + 0.0 * x


@dataclass
class Samples:
    xs: np.ndarray
    ys: np.ndarray
    zs: np.ndarray


def seq_sum(values: np.ndarray) -> float:
    s = 0.0
    for v in values.tolist():
        s += v
    return s


def build_base(
    spec: dict[str, Any],
    ring: list[tuple[float, float]],
    perimeter: Callable[[], Samples],
    interior: Callable[[], tuple[float, float] | None],
    at_points: Callable[[np.ndarray, np.ndarray], np.ndarray],
    to_local: Callable[[float, float], tuple[float, float]],
) -> tuple[Planar | Tin, str]:
    """A base as a side of the comparison and its label (``Refused`` when it cannot be built)."""
    kind = spec["kind"]
    if kind == "reference":
        mode = spec["mode"]
        if mode == "level":
            z = float(spec["levelM"])
            return Planar(level_fn(z)), f"Level {f3(z)} m"
        if mode in ("perimeter-max", "perimeter-min"):
            s = perimeter()
            if len(s.zs) == 0:
                raise Refused("The polygon's edge has no survey under it.")
            z = float(s.zs.max() if mode == "perimeter-max" else s.zs.min())
            word = "Highest" if mode == "perimeter-max" else "Lowest"
            return Planar(level_fn(z)), f"{word} point on the perimeter ({f3(z)} m)"
        ext = interior()
        if ext is None:
            raise Refused("The polygon has no survey under it.")
        z = ext[1] if mode == "interior-max" else ext[0]
        word = "Highest" if mode == "interior-max" else "Lowest"
        return Planar(level_fn(z)), f"{word} point inside ({f3(z)} m)"
    if kind == "perimeter-mean":
        s = perimeter()
        if len(s.zs) == 0:
            raise Refused("The polygon's edge has no survey under it.")
        z = seq_sum(s.zs) / len(s.zs)
        return Planar(level_fn(z)), f"Mean perimeter level ({f3(z)} m)"
    if kind == "fit-plane":
        s = perimeter()
        if len(s.zs) < 3:
            raise Refused("The polygon's edge has too little survey under it for a plane.")
        ox = min(p[0] for p in ring)
        oy = min(p[1] for p in ring)
        p = fit_plane(s.xs, s.ys, s.zs, ox, oy)
        return Planar(plane_fn(p, ox, oy)), "Best-fit plane through the perimeter"
    if kind == "smart":
        s = perimeter()
        if len(s.zs) < 3:
            raise Refused("The polygon's edge has too little survey under it for a smart base.")
        tris = delaunay(s.xs, s.ys)
        if len(tris) == 0:
            raise Refused("The polygon's edge samples lie on a line.")
        return Tin(s.xs, s.ys, s.zs, tris), "Smart base (triangulated perimeter)"
    if kind == "custom":
        verts = spec["vertices"]
        xs = np.zeros(len(verts))
        ys = np.zeros(len(verts))
        zs = np.zeros(len(verts))
        need = []
        for k, v in enumerate(verts):
            xs[k], ys[k] = to_local(float(v["e"]), float(v["n"]))
            if v.get("z") is not None:
                zs[k] = float(v["z"])
            else:
                need.append(k)
        if need:
            idx = np.array(need)
            under = at_points(xs[idx], ys[idx])
            for m, k in enumerate(need):
                if not np.isfinite(under[m]):
                    raise Refused(f"Custom base vertex {k + 1} has no survey under it.")
                zs[k] = float(under[m]) + float(verts[k]["offsetM"])
        tris = delaunay(xs, ys)
        if len(tris) == 0:
            raise Refused("The custom base vertices lie on a line.")
        return Tin(xs, ys, zs, tris), f"Custom base ({len(verts)} vertices)"
    raise Refused(f'"{kind}" is not a base.')
