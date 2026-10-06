"""Primitive fits for one cluster of points (local frame, metres): a vertical cylinder (tank,
vessel), a box (building, skid, container), an extrusion (an outline that is not a rectangle) and
a straight pipe. Each returns the part's shape, its RMS residual and inlier share, or None.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import numpy as np


@dataclass
class Candidate:
    kind: str
    shape: dict[str, Any]
    residual: float
    share: float
    inliers: int

    def score(self, dist: float) -> float:
        return self.share - 0.2 * self.residual / max(dist, 1e-6)


def fit_circle(xz: np.ndarray) -> tuple[float, float, float]:
    """Algebraic (Kasa) circle fit: centre and radius."""
    x, z = xz[:, 0], xz[:, 1]
    a = np.column_stack([x, z, np.ones(len(x))])
    b = x * x + z * z
    sol, *_ = np.linalg.lstsq(a, b, rcond=None)
    cx, cz = sol[0] / 2, sol[1] / 2
    r = math.sqrt(max(sol[2] + cx * cx + cz * cz, 0.0))
    return float(cx), float(cz), r


def ransac_circle(
    xz: np.ndarray, dist: float, rng: np.random.Generator, iters: int = 300
) -> tuple[float, float, float, np.ndarray] | None:
    """A circle through most points, robust to roofs, noise and a half-seen side."""
    if len(xz) < 10:
        return None
    best: np.ndarray | None = None
    for _ in range(iters):
        s = xz[rng.choice(len(xz), 3, replace=False)]
        try:
            cx, cz, r = fit_circle(s)
        except np.linalg.LinAlgError:
            continue
        if not (0.15 < r < 60):
            continue
        d = np.abs(np.hypot(xz[:, 0] - cx, xz[:, 1] - cz) - r)
        inl = d < dist
        if best is None or inl.sum() > best.sum():
            best = inl
    if best is None or best.sum() < 10:
        return None
    for _ in range(3):
        cx, cz, r = fit_circle(xz[best])
        d = np.abs(np.hypot(xz[:, 0] - cx, xz[:, 1] - cz) - r)
        best = d < dist
        if best.sum() < 10:
            return None
    cx, cz, r = fit_circle(xz[best])
    return cx, cz, r, best


def cylinder(pts: np.ndarray, base_y: float, dist: float, rng: np.random.Generator) -> Candidate | None:
    top = float(np.percentile(pts[:, 1], 99))
    height = top - base_y
    if height <= 0.3:
        return None
    walls = pts[pts[:, 1] < base_y + 0.9 * height]
    fit = ransac_circle(walls[:, [0, 2]], dist, rng)
    if fit is None:
        return None
    cx, cz, r, _ = fit
    rad = np.hypot(pts[:, 0] - cx, pts[:, 2] - cz)
    on_wall = np.abs(rad - r) < 2 * dist
    rim = pts[(rad > 0.8 * r) & (rad < r + 2 * dist)]
    rim_top = float(np.percentile(rim[:, 1], 98)) if len(rim) else top
    centre = pts[rad < 0.3 * r]
    roof, roof_h = "flat", 0.0
    if len(centre) >= 5:
        rise = float(np.percentile(centre[:, 1], 90)) - rim_top
        if rise > max(0.1 * r, 3 * dist):
            roof, roof_h = "cone", rise
    wall_h = rim_top - base_y
    if wall_h <= 0.3:
        return None
    on_roof = (rad < r + 2 * dist) & (pts[:, 1] > rim_top - 2 * dist)
    inl = on_wall | on_roof
    res = np.abs(rad[on_wall] - r)
    residual = float(np.sqrt(np.mean(res**2))) if len(res) else 1e9
    shape: dict[str, Any] = {
        "base": [round(cx, 4), round(base_y, 4), round(cz, 4)],
        "radius": round(r, 4),
        "height": round(wall_h, 4),
        "roof": roof,
    }
    if roof != "flat":
        shape["roofHeight"] = round(roof_h, 4)
    return Candidate("cylinder", shape, residual, float(inl.mean()), int(inl.sum()))


def min_area_rect(xz: np.ndarray) -> tuple[float, float, float, float, float]:
    """Centre x, centre z, length, width and the angle (radians, of the length axis in (x, z))."""
    from scipy.spatial import ConvexHull

    hull = xz[ConvexHull(xz).vertices]
    best = None
    for i in range(len(hull)):
        e = hull[(i + 1) % len(hull)] - hull[i]
        a = math.atan2(e[1], e[0])
        c, s = math.cos(a), math.sin(a)
        u = hull[:, 0] * c + hull[:, 1] * s
        v = -hull[:, 0] * s + hull[:, 1] * c
        area = (u.max() - u.min()) * (v.max() - v.min())
        if best is None or area < best[0]:
            best = (area, a, u.min(), u.max(), v.min(), v.max())
    assert best is not None
    _, a, u0, u1, v0, v1 = best
    c, s = math.cos(a), math.sin(a)
    uc, vc = (u0 + u1) / 2, (v0 + v1) / 2
    cx, cz = uc * c - vc * s, uc * s + vc * c
    length, width = u1 - u0, v1 - v0
    if width > length:
        length, width, a = width, length, a + math.pi / 2
    return cx, cz, length, width, a


def box(pts: np.ndarray, base_y: float, dist: float) -> Candidate | None:
    if len(pts) < 10:
        return None
    top = float(np.percentile(pts[:, 1], 99))
    height = top - base_y
    if height <= 0.2:
        return None
    try:
        cx, cz, length, width, a = min_area_rect(pts[:, [0, 2]])
    except Exception:
        return None
    if width < 0.2:
        return None
    c, s = math.cos(a), math.sin(a)
    # extents from robust percentiles: the hull's extreme points sit on the noise, not the walls
    uu = pts[:, 0] * c + pts[:, 2] * s
    vv = -pts[:, 0] * s + pts[:, 2] * c
    u0, u1 = np.percentile(uu, [0.5, 99.5])
    v0, v1 = np.percentile(vv, [0.5, 99.5])
    length, width = float(u1 - u0), float(v1 - v0)
    uc, vc = (u0 + u1) / 2, (v0 + v1) / 2
    cx, cz = float(uc * c - vc * s), float(uc * s + vc * c)
    dx, dz = pts[:, 0] - cx, pts[:, 2] - cz
    u = np.abs(dx * c + dz * s)
    v = np.abs(-dx * s + dz * c)
    d_side = np.minimum(np.abs(u - length / 2), np.abs(v - width / 2))
    d_top = np.where((u <= length / 2 + dist) & (v <= width / 2 + dist), np.abs(pts[:, 1] - top), np.inf)
    d = np.minimum(d_side, d_top)
    inl = d < 2 * dist
    residual = float(np.sqrt(np.mean(d[inl] ** 2))) if inl.any() else 1e9
    # yaw: counter-clockwise seen from above, from east toward north (-z)
    yaw = math.degrees(math.atan2(-s, c))
    yaw = (yaw + 180) % 360 - 180
    shape = {
        "base": [round(cx, 4), round(base_y, 4), round(cz, 4)],
        "size": [round(length, 4), round(height, 4), round(width, 4)],
        "yawDeg": round(yaw, 3),
    }
    return Candidate("box", shape, residual, float(inl.mean()), int(inl.sum()))


def extrusion(pts: np.ndarray, base_y: float, dist: float) -> Candidate | None:
    import shapely

    if len(pts) < 10:
        return None
    top = float(np.percentile(pts[:, 1], 99))
    height = top - base_y
    if height <= 0.2:
        return None
    hull = shapely.MultiPoint(pts[:, [0, 2]]).convex_hull.simplify(max(2 * dist, 0.1))
    if not isinstance(hull, shapely.Polygon) or hull.area < 0.5:
        return None
    # counter-clockwise seen from above (x east, north up) is clockwise in (x, z)
    from shapely.geometry.polygon import orient

    ring = list(orient(hull, sign=-1.0).exterior.coords)[:-1]
    d_side = shapely.distance(hull.exterior, shapely.points(pts[:, [0, 2]]))
    inside = shapely.contains_xy(hull, pts[:, 0], pts[:, 2])
    d_top = np.where(inside, np.abs(pts[:, 1] - top), np.inf)
    d = np.minimum(d_side, d_top)
    inl = d < 2 * dist
    residual = float(np.sqrt(np.mean(d[inl] ** 2))) if inl.any() else 1e9
    shape = {
        "footprint": [[round(x, 4), round(z, 4)] for x, z in ring],
        "baseY": round(base_y, 4),
        "height": round(height, 4),
    }
    return Candidate("extrusion", shape, residual, float(inl.mean()), int(inl.sum()))


def pipe(pts: np.ndarray, dist: float) -> Candidate | None:
    """A straight run: a long, thin cluster with a round cross-section."""
    if len(pts) < 20:
        return None
    c = pts.mean(axis=0)
    _, _sv, vt = np.linalg.svd(pts - c, full_matrices=False)
    axis = vt[0]
    t = (pts - c) @ axis
    length = float(t.max() - t.min())
    perp = (pts - c) - np.outer(t, axis)
    spread = float(np.percentile(np.linalg.norm(perp, axis=1), 95))
    if length < 4 * spread or spread > 1.0 or length < 1.0:
        return None
    # cross-section circle fit in the plane normal to the axis
    e1 = np.cross(axis, [0.0, 1.0, 0.0] if abs(axis[1]) < 0.9 else [1.0, 0.0, 0.0])
    e1 /= np.linalg.norm(e1)
    e2 = np.cross(axis, e1)
    xy = np.column_stack([perp @ e1, perp @ e2])
    try:
        ox, oy, r = fit_circle(xy)
    except np.linalg.LinAlgError:
        return None
    if not (0.01 < r < 1.0):
        return None
    d = np.abs(np.hypot(xy[:, 0] - ox, xy[:, 1] - oy) - r)
    inl = d < 2 * dist
    residual = float(np.sqrt(np.mean(d[inl] ** 2))) if inl.any() else 1e9
    centre = c + ox * e1 + oy * e2
    a = centre + axis * t.min()
    b = centre + axis * t.max()
    shape = {
        "points": [[round(float(v), 4) for v in a], [round(float(v), 4) for v in b]],
        "diameter": round(2 * r, 4),
    }
    return Candidate("pipe", shape, residual, float(inl.mean()), int(inl.sum()))
