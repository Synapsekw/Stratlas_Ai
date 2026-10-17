"""Oriented boxes from planar faces, dish detection and the kind of each unit.

A unit's front face is paired with the parallel faces behind it (its back); the box takes its axes
from the front (across, up, outward) and its depth from the front-to-back offset, or, with no back
seen, from the crown points behind the front's side edges (inferred). Units outside the plausible
sizes are dropped, duplicates merged, and faces that are the side of a bigger unit's box folded
into it. Dishes come two ways: a round flat front (a radome) among the units, or a round, thin,
curved cluster of crown points that no face explains (a bare reflector).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components
from scipy.spatial import ConvexHull, QhullError, cKDTree

from ..modelfit.ransac import ransac_circle
from .faces import RANSAC_THR_M, VOXEL_M, Face, coverage, span, voxel_down

MIN_W, MAX_W = 0.12, 3.0
MIN_H, MAX_H = 0.25, 3.5
MIN_D, MAX_D = 0.04, 0.8
PAIR_DOT = 0.97
PAIR_ALONG_M = 0.35
PAIR_LATERAL_M = 0.2
PAIR_Z_OVERLAP_M = 0.1
DUP_M = 0.15

FRONT_MIN_HEIGHT_SHARE = 0.6
SIDE_MARGIN_M = 0.05  # a face whose centre lies this close to a bigger unit's box is its side
EDGE_STRIP_M = 0.03  # inferred depth: crown points this close inside the front's side edges
DISH_CIRCLE_M = 0.01
DISH_RMS_SHARE = 0.02
DISH_ROUNDNESS = 0.15
DISH_D_RANGE = (0.2, 1.8)
DISH_LINK_M = 0.04  # leftover crown points closer than this belong to one cluster
DISH_MIN_POINTS = 200
DISH_MAX_THICKNESS = 0.35  # thickness over diameter of a reflector cluster
DISH_RIM_SHARE = 0.8  # the rim: points beyond this share of the radius
PANEL_MIN_H = 1.2
SHORT_MIN_H = 0.6
FACING_MIN = 0.5
_UP = np.array([0.0, 1.0, 0.0])


@dataclass
class Unit:
    kind: str
    front: Face
    faces: list[Face]
    centre: np.ndarray
    axes: np.ndarray  # rows across, up, outward
    extents: np.ndarray  # width, height, depth
    depth_measured: bool
    support: int
    dish: dict | None  # {"diameter", "axis", "rms"}


def _interval(f: Face, axis: np.ndarray) -> tuple[float, float]:
    return span(f.points @ axis, 0.5)


def _inferred_depth(front: Face, w: float, h: float, crown: np.ndarray) -> float:
    """Depth behind a front with no back face: the 99th percentile reach of the crown points just
    inside its two side edges (its side faces), else of all points in its footprint; capped."""
    rel = crown - front.centre
    near = np.einsum("ij,ij->i", rel, rel) < (max(w, h) / 2 + MAX_D) ** 2
    rel = rel[near]
    a, b, c = rel @ front.side, rel @ front.up, rel @ front.normal
    behind = (np.abs(b) < 0.45 * h) & (c < -RANSAC_THR_M) & (c > -MAX_D)
    edge = behind & (np.abs(a) > w / 2 - EDGE_STRIP_M) & (np.abs(a) < w / 2 + VOXEL_M)
    pick = edge if edge.sum() >= 20 else behind & (np.abs(a) < w / 2)
    if pick.sum() < 5:
        return MIN_D
    return float(min(MAX_D, np.percentile(-c[pick], 99) / 0.99))


def _group_unit(group: list[Face], axis_point: np.ndarray, crown: np.ndarray) -> Unit:
    tallest = max(f.height for f in group)
    n0 = group[0].normal
    fronts = [f for f in group if f.height >= FRONT_MIN_HEIGHT_SHARE * tallest]
    front = max(fronts, key=lambda f: float((f.centre - axis_point) @ n0))
    across, up, out = front.side, front.up, front.normal
    w = front.width
    allpts = np.vstack([f.points for f in group])
    b0, b1 = span((allpts - front.centre) @ up, 0.5)
    h = b1 - b0
    if len(group) > 1:
        offs = [float((f.centre - front.centre) @ out) for f in group]
        d = max(offs) - min(offs)
        measured = True
    else:
        d = _inferred_depth(front, w, h, crown)
        measured = False
    centre = front.centre - out * d / 2 + up * (b0 + b1) / 2
    return Unit(
        kind="",
        front=front,
        faces=list(group),
        centre=centre,
        axes=np.vstack([across, up, out]),
        extents=np.array([w, h, d]),
        depth_measured=measured,
        support=int(sum(f.support for f in group)),
        dish=None,
    )


def _inside(p: np.ndarray, u: Unit, margin: float) -> bool:
    local = u.axes @ (p - u.centre)
    return bool(np.all(np.abs(local) <= u.extents / 2 + margin))


def _round_outline(ab: np.ndarray, w: float, h: float, rng: np.random.Generator) -> dict | None:
    """Circle on the convex outline of in-plane points when the outline is round enough for a dish."""
    if max(w, h) <= 0 or abs(w - h) / max(w, h) >= DISH_ROUNDNESS:
        return None
    try:
        hull = ab[ConvexHull(ab).vertices]
    except QhullError:
        return None
    fit = ransac_circle(hull, DISH_CIRCLE_M, rng)
    if fit is None:
        return None
    cx, cz, r, _ = fit
    rms = float(np.sqrt(np.mean((np.hypot(hull[:, 0] - cx, hull[:, 1] - cz) - r) ** 2)))
    if rms >= DISH_RMS_SHARE * r or not DISH_D_RANGE[0] <= 2 * r <= DISH_D_RANGE[1]:
        return None
    return {"cx": cx, "cz": cz, "r": r, "rms": rms}


def _flat_dish(u: Unit, rng: np.random.Generator) -> dict | None:
    f = u.front
    rel = f.points - f.centre
    c = _round_outline(np.column_stack([rel @ f.side, rel @ f.up]), f.width, f.height, rng)
    if c is None:
        return None
    return {"diameter": 2 * c["r"], "axis": f.normal.copy(), "rms": c["rms"]}


def _reflector_dishes(
    crown: np.ndarray, units: list[Unit], axis_point: np.ndarray, rng: np.random.Generator
) -> list[Unit]:
    """Bare (curved) reflectors: round, thin clusters of crown points outside every unit box."""
    pts = voxel_down(crown)
    if len(pts) < DISH_MIN_POINTS:
        return []
    keep = np.ones(len(pts), dtype=bool)
    for u in units:
        local = (pts - u.centre) @ u.axes.T
        keep &= ~np.all(np.abs(local) <= u.extents / 2 + SIDE_MARGIN_M, axis=1)
    pts = pts[keep]
    pairs = cKDTree(pts).query_pairs(DISH_LINK_M, output_type="ndarray")
    graph = coo_matrix((np.ones(len(pairs)), (pairs[:, 0], pairs[:, 1])), shape=(len(pts), len(pts)))
    _, lab = connected_components(graph, directed=False)
    counts = np.bincount(lab)
    out: list[Unit] = []
    for c in np.where(counts >= DISH_MIN_POINTS)[0]:
        x = pts[lab == c]
        size = float(np.linalg.norm(np.ptp(x, axis=0)))
        if DISH_D_RANGE[0] <= size <= 2 * DISH_D_RANGE[1]:
            u = _reflector(x, axis_point, rng)
            if u is not None:
                out.append(u)
    return out


def _dish_outline(x: np.ndarray, m: np.ndarray, axis: np.ndarray, rng: np.random.Generator):
    """In-plane frame (side, up) across `axis`, the points in it and their round outline."""
    up = _UP - axis[1] * axis
    if np.linalg.norm(up) < 1e-6:
        return None
    up /= np.linalg.norm(up)
    side = np.cross(up, axis)
    rel = x - m
    ab = np.column_stack([rel @ side, rel @ up])
    a0, a1 = span(ab[:, 0], 1.0)
    b0, b1 = span(ab[:, 1], 1.0)
    circle = _round_outline(ab, a1 - a0, b1 - b0, rng)
    if circle is None:
        return None
    return side, up, ab, (a0, a1, b0, b1), circle


def _reflector(x: np.ndarray, axis_point: np.ndarray, rng: np.random.Generator) -> Unit | None:
    """A dish from one thin, round cluster: the axis first from PCA, then refined as the normal of
    the plane through its rim (a dish of revolution has a flat, round rim; a paraboloid's own fit
    cannot tell a tilt from a shift)."""
    m = x.mean(axis=0)
    _, s, vt = np.linalg.svd(x - m, full_matrices=False)
    if s[1] < 2 * s[2]:
        return None
    axis = vt[2]
    for refine in (True, False):
        horiz = (m - axis_point) * np.array([1.0, 0.0, 1.0])
        if axis @ horiz < 0:  # a dish faces away from the tower
            axis = -axis
        got = _dish_outline(x, m, axis, rng)
        if got is None:
            return None
        side, up, ab, (a0, a1, b0, b1), circle = got
        if not refine:
            break
        rho = np.hypot(ab[:, 0] - circle["cx"], ab[:, 1] - circle["cz"])
        rim = x[rho > DISH_RIM_SHARE * circle["r"]]
        if len(rim) < 30:
            break
        rim_m = rim.mean(axis=0)
        axis = np.linalg.svd(rim - rim_m, full_matrices=False)[2][2]
    diameter = 2 * circle["r"]
    rel = x - m
    t0, t1 = span(rel @ axis, 0.5)
    depth = t1 - t0
    if depth > DISH_MAX_THICKNESS * diameter:
        return None
    centre = m + side * circle["cx"] + up * circle["cz"] + axis * (t0 + t1) / 2
    cov = coverage(ab[:, 0], ab[:, 1], a1 - a0, b1 - b0, a0, b0)
    plane_rms = float(np.sqrt(np.mean((rel @ axis - (rel @ axis).mean()) ** 2)))
    face = Face(x, centre, axis, up, side, b1 - b0, a1 - a0, plane_rms, len(x), cov)
    return Unit(
        kind="dish",
        front=face,
        faces=[face],
        centre=centre,
        axes=np.vstack([side, up, axis]),
        extents=np.array([diameter, diameter, depth]),
        depth_measured=True,
        support=len(x),
        dish={"diameter": diameter, "axis": axis, "rms": circle["rms"]},
    )


def pair_faces(faces: list[Face], axis_point: np.ndarray, crown_xyz: np.ndarray) -> list[Unit]:
    """Units (oriented boxes with a kind) from the crown's planar faces and its points."""
    axis_point = np.asarray(axis_point, dtype=float)
    crown = np.asarray(crown_xyz, dtype=float)
    rng = np.random.default_rng(0)
    big = sorted(
        (f for f in faces if f.height >= MIN_H and MIN_W <= f.width <= MAX_W),
        key=lambda f: -f.support,
    )
    used: set[int] = set()
    units: list[Unit] = []
    for i, f in enumerate(big):
        if i in used:
            continue
        used.add(i)
        group = [f]
        fi = _interval(f, f.up)
        for j, g in enumerate(big):
            if j in used or abs(f.normal @ g.normal) <= PAIR_DOT:
                continue
            delta = g.centre - f.centre
            gi = _interval(g, f.up)
            overlap = min(fi[1], gi[1]) - max(fi[0], gi[0])
            if (
                abs(delta @ f.normal) < PAIR_ALONG_M
                and abs(delta @ f.side) < PAIR_LATERAL_M
                and overlap > PAIR_Z_OVERLAP_M
            ):
                group.append(g)
                used.add(j)
        units.append(_group_unit(group, axis_point, crown))
    lo, hi = np.array([MIN_W, MIN_H, MIN_D]), np.array([MAX_W, MAX_H, MAX_D])
    units = [u for u in units if np.all(u.extents >= lo) and np.all(u.extents <= hi)]
    units.sort(key=lambda u: -u.support)
    kept: list[Unit] = []
    for u in units:
        dup = any(
            np.linalg.norm(u.centre - k.centre) < DUP_M and abs(u.axes[2] @ k.axes[2]) > PAIR_DOT
            for k in kept
        )
        side = any(_inside(u.front.centre, k, SIDE_MARGIN_M) for k in kept)
        if not dup and not side:
            kept.append(u)
    for u in kept:
        u.dish = _flat_dish(u, rng)
    kept += _reflector_dishes(crown, kept, axis_point, rng)
    for u in kept:
        radial = u.centre - axis_point
        radial[1] = 0.0
        ln = np.linalg.norm(radial)
        u.kind = classify(u, radial / ln if ln > 0 else radial)
    return kept


def classify(unit: Unit, radial: np.ndarray) -> str:
    """The kind of a unit: "dish" when round, "other" when it faces sideways or inward (its outward
    axis within 60 degrees of the radial direction is required), else by height: "panel" from
    1.2 m, "short" from 0.6 m, "other" below."""
    if unit.dish is not None:
        return "dish"
    out_h = unit.axes[2] * np.array([1.0, 0.0, 1.0])
    r_h = np.asarray(radial, dtype=float) * np.array([1.0, 0.0, 1.0])
    ln = np.linalg.norm(out_h) * np.linalg.norm(r_h)
    if ln == 0 or (out_h @ r_h) / ln < FACING_MIN:
        return "other"
    h = float(unit.extents[1])
    if h >= PANEL_MIN_H:
        return "panel"
    if h >= SHORT_MIN_H:
        return "short"
    return "other"
