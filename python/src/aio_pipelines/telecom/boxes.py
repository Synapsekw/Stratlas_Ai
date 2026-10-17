"""Oriented boxes from planar faces, dish detection and the kind of each unit.

A unit's front face is paired with the parallel faces behind it (its back); the box takes its axes
from the front (across, up, outward) and its depth from the front-to-back offset, or, with no back
seen, from the crown points behind the front's side edges (inferred). Units outside the plausible
sizes are dropped, duplicates merged, and faces that are the side of a bigger unit's box folded
into it. Dishes come two ways: a round flat front (a radome) among the units, or a round, thin,
curved cluster of crown points that no face explains (a bare reflector), found after the thin
tubes it is bolted to (pipe, clamps) are cut away.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components
from scipy.spatial import ConvexHull, QhullError, cKDTree

from ..modelfit.ransac import ransac_circle
from .faces import (
    CORE_CELL_M,
    MIN_FACE_POINTS_SPARSE,
    RANSAC_THR_M,
    VOXEL_M,
    Face,
    Sparse,
    _core,
    coverage,
    point_spacing,
    span,
    voxel_down,
)

MIN_W, MAX_W = 0.12, 3.0
MIN_H, MAX_H = 0.25, 3.5
MIN_D, MAX_D = 0.04, 0.8
PAIR_DOT = 0.97
PAIR_ALONG_M = 0.35
PAIR_LATERAL_M = 0.2
PAIR_Z_OVERLAP_M = 0.1
PAIR_WIDTH_SHARE = 0.6  # a box's front and back are about as wide: a pole behind a radio is neither
DUP_M = 0.15

FRONT_MIN_HEIGHT_SHARE = 0.6
FRONT_MARGIN_M = 0.05  # a unit's height counts its faces' points this far past the front's
SIDE_MARGIN_M = 0.05  # a face whose centre lies this close to a bigger unit's box is its side
EDGE_STRIP_M = 0.03  # inferred depth: crown points this close inside the front's side edges
DEPTH_BIN_M = 0.01
DEPTH_GAP_M = 0.05  # an empty stretch this deep behind a front ends its side faces
MIN_FRONT_COVERAGE = 0.7  # occupied share of a front's rectangle (a unit's front is solid)
MIN_LONE_COVERAGE = 0.85  # the same for a front with no back face: one face is all the evidence
DISH_CIRCLE_M = 0.01
DISH_RMS_SHARE = 0.02
DISH_ROUNDNESS = 0.15
DISH_D_RANGE = (0.2, 1.8)
DISH_LINK_M = 0.04  # leftover crown points closer than this belong to one cluster
DISH_MIN_POINTS = 200  # at the reference spacing; a sparser crown scales it (`_dish_scale`)
DISH_MIN_POINTS_SPARSE = 80
DISH_MAX_THICKNESS = 0.35  # thickness over diameter of a reflector cluster
DISH_REGROW_STEPS = 2  # links of DISH_LINK_M that give a reflector back its rim and contact points
TUBE_CELL_M = 0.03
TUBE_K = 48  # about 0.25 m of a 3 cm pipe, a 0.12 m radius patch of a sheet
TUBE_LINEARITY = 0.75
DISH_HULL_SHARE = 0.8  # outline points that must sit on the circle
DISH_SHELL_M = 0.02  # points this close to the fitted reflector profile belong to it
PANEL_MIN_H = 1.2
ANTENNA_MIN_W = 0.2  # a narrower upright face is a pole, a bracket or a cable bundle, not an antenna
ANTENNA_MIN_D = 0.08  # two parallel faces closer than this are a plate or a bracket, not an antenna
MEMBER_SLENDERNESS = 4.0  # a unit narrower than ANTENNA_MIN_W and this many times taller is slender
SLENDER_MAX_H = 1.5  # a slender unit taller than this is longer than any equipment that narrow
SHAFT_TOUCH_M = 0.15  # a slender unit whose box comes this close to the shaft is fixed to it
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


def _solid_part(f: Face, solid: Face) -> Face | None:
    """`f` cut to the solid part in front of or behind the parallel face `solid`: its points across
    `solid` (plus `FRONT_MARGIN_M` each side), then its full rows and columns (`faces._core`), so a
    face grown on past its unit's edges (up a pipe, into the frame beside it) keeps only the unit's
    rectangle. None when too few points are left."""
    a = (f.points - f.centre) @ f.side
    s0, s1 = span((solid.points - f.centre) @ f.side, 0.5)
    pts = f.points[(a >= s0 - FRONT_MARGIN_M) & (a <= s1 + FRONT_MARGIN_M)]
    if len(pts) < MIN_FACE_POINTS_SPARSE:
        return None
    pts = pts[_core(pts, f.centre, f.side, f.up, CORE_CELL_M)]
    if len(pts) < MIN_FACE_POINTS_SPARSE:
        return None
    rel = pts - f.centre
    a, b = rel @ f.side, rel @ f.up
    a0, a1 = span(a, 1.0)
    b0, b1 = span(b, 0.5)
    w, h = a1 - a0, b1 - b0
    if w <= 0 or h <= 0:
        return None
    centre = f.centre + f.side * (a0 + a1) / 2 + f.up * (b0 + b1) / 2
    cov = coverage(a, b, w, h, a0, b0)
    return Face(pts, centre, f.normal, f.up, f.side, float(h), float(w), f.rms, len(pts), cov)


def _pairs(f: Face, g: Face) -> bool:
    """Whether `g` is the front or back of the unit `f` belongs to: parallel, about as wide, close
    along the normal and across, and overlapping in height."""
    if abs(f.normal @ g.normal) <= PAIR_DOT:
        return False
    delta = g.centre - f.centre
    fi, gi = _interval(f, f.up), _interval(g, f.up)
    overlap = min(fi[1], gi[1]) - max(fi[0], gi[0])
    return (
        min(f.width, g.width) >= PAIR_WIDTH_SHARE * max(f.width, g.width)
        and abs(delta @ f.normal) < PAIR_ALONG_M
        and abs(delta @ f.side) < PAIR_LATERAL_M
        and overlap > PAIR_Z_OVERLAP_M
    )


def _pair(f: Face, g: Face) -> tuple[Face, Face] | None:
    """`f` and `g` as the two faces of one unit, or None. A patchy face (under `MIN_LONE_COVERAGE`)
    paired with a solid one at least `ANTENNA_MIN_W` wide is first cut to its solid part across it
    (`_solid_part`): the region growing can run a unit's face on up a pipe or into the frame beside
    it, which stretches the box and leaves it patchy, or too wide to pair with its own back. The
    cut is taken only when all its patchiness was outside (the cut part is solid)."""
    if abs(f.normal @ g.normal) <= PAIR_DOT:
        return None
    for patchy, solid in ((f, g), (g, f)):
        if patchy.coverage < MIN_LONE_COVERAGE <= solid.coverage and solid.width >= ANTENNA_MIN_W:
            cut = _solid_part(patchy, solid)
            if cut is not None and cut.coverage >= MIN_LONE_COVERAGE and cut.height >= MIN_H:
                pair = (cut, g) if patchy is f else (f, cut)
                if _pairs(*pair):
                    return pair
    return (f, g) if _pairs(f, g) else None


def _inferred_depth(front: Face, w: float, h: float, crown: np.ndarray, tree: cKDTree | None = None) -> float:
    """Depth behind a front with no back face: how far its side faces reach back, read from the
    crown points just inside its two side edges (else all points in its footprint). The points
    are binned by depth from the front plane and the depth ends at the first empty stretch of
    `DEPTH_GAP_M`: a pipe, a bracket or another unit behind the box, separated from it by air, no
    longer counts. `MAX_D` when nothing ends before it (the front is not a box's: see
    `pair_faces`); `MIN_D` with almost no points behind."""
    reach = max(w, h) / 2 + MAX_D
    if tree is not None:
        rel = crown[tree.query_ball_point(front.centre, reach)] - front.centre
    else:
        rel = crown - front.centre
        rel = rel[np.einsum("ij,ij->i", rel, rel) < reach**2]
    a, b, c = rel @ front.side, rel @ front.up, rel @ front.normal
    behind = (np.abs(b) < 0.45 * h) & (c < -RANSAC_THR_M) & (c > -MAX_D - DEPTH_GAP_M)
    edge = behind & (np.abs(a) > w / 2 - EDGE_STRIP_M) & (np.abs(a) < w / 2 + VOXEL_M)
    pick = edge if edge.sum() >= 20 else behind & (np.abs(a) < w / 2)
    if pick.sum() < 5:
        return MIN_D
    t = -c[pick]
    bins = int(np.ceil((MAX_D + DEPTH_GAP_M) / DEPTH_BIN_M)) + 1
    occupied = np.bincount(np.floor(t / DEPTH_BIN_M).astype(int), minlength=bins) > 0
    run = max(1, round(DEPTH_GAP_M / DEPTH_BIN_M))
    last = -1
    for i, v in enumerate(occupied):
        if v:
            last = i
        elif i - last >= run:
            break
    else:
        return MAX_D
    if last < 0:
        return MIN_D
    t = t[t < (last + 1) * DEPTH_BIN_M]
    return float(min(MAX_D, np.percentile(t, 99) / 0.99))


def _group_unit(
    group: list[Face], axis_point: np.ndarray, crown: np.ndarray, tree: cKDTree | None = None
) -> Unit:
    tallest = max(f.height for f in group)
    n0 = group[0].normal
    fronts = [f for f in group if f.height >= FRONT_MIN_HEIGHT_SHARE * tallest]
    front = max(fronts, key=lambda f: float((f.centre - axis_point) @ n0))
    across, up, out = front.side, front.up, front.normal
    w = front.width
    # the unit's height from all its faces, cut to the front's up interval (plus a margin) so a
    # back face that took in a touching pipe cannot stretch it
    fb = (front.points - front.centre) @ up
    lo, hi = span(fb, 0.5)
    b = np.concatenate([(f.points - front.centre) @ up for f in group])
    b0, b1 = span(b[(b >= lo - FRONT_MARGIN_M) & (b <= hi + FRONT_MARGIN_M)], 0.5)
    h = b1 - b0
    if len(group) > 1:
        offs = [float((f.centre - front.centre) @ out) for f in group]
        d = max(offs) - min(offs)
        measured = True
    else:
        d = _inferred_depth(front, w, h, crown, tree)
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


def _round_outline(ab: np.ndarray, rng: np.random.Generator) -> dict | None:
    """Circle on the convex outline of in-plane points when the outline is round enough for a dish:
    most outline points on the circle (a stub of the pipe or clamp behind a dish may poke out),
    a small residual, and the points inside it about as wide as tall."""
    try:
        hull = ab[ConvexHull(ab).vertices]
    except QhullError:
        return None
    fit = ransac_circle(hull, DISH_CIRCLE_M, rng)
    if fit is None:
        return None
    cx, cz, r, inl = fit
    if inl.mean() < DISH_HULL_SHARE:
        return None
    rms = float(np.sqrt(np.mean((np.hypot(hull[inl, 0] - cx, hull[inl, 1] - cz) - r) ** 2)))
    if rms >= DISH_RMS_SHARE * r or not DISH_D_RANGE[0] <= 2 * r <= DISH_D_RANGE[1]:
        return None
    disc = ab[np.hypot(ab[:, 0] - cx, ab[:, 1] - cz) <= r + 2 * DISH_CIRCLE_M]
    a0, a1 = span(disc[:, 0], 1.0)
    b0, b1 = span(disc[:, 1], 1.0)
    w, h = a1 - a0, b1 - b0
    if max(w, h) <= 0 or abs(w - h) / max(w, h) >= DISH_ROUNDNESS:
        return None
    return {"cx": cx, "cz": cz, "r": r, "rms": rms}


def _flat_dish(u: Unit, rng: np.random.Generator) -> dict | None:
    f = u.front
    rel = f.points - f.centre
    c = _round_outline(np.column_stack([rel @ f.side, rel @ f.up]), rng)
    if c is None:
        return None
    return {"diameter": 2 * c["r"], "axis": f.normal.copy(), "rms": c["rms"]}


def _dish_scale(sp: Sparse) -> tuple[float, int]:
    """(link distance, least points) of a reflector cluster for the crown's spacing: at the
    reference spacing `DISH_LINK_M` and `DISH_MIN_POINTS`; sparser, the link widens and the count
    shrinks as the face search's do (`faces.Sparse`), the count to no less than
    `DISH_MIN_POINTS_SPARSE`."""
    widen = sp.grow_m / Sparse().grow_m
    least = max(DISH_MIN_POINTS_SPARSE, round(DISH_MIN_POINTS / widen**2))
    return DISH_LINK_M * widen, min(DISH_MIN_POINTS, least)


def _reflector_dishes(
    crown: np.ndarray, units: list[Unit], axis_point: np.ndarray, rng: np.random.Generator
) -> list[Unit]:
    """Bare (curved) reflectors: round, thin clusters of crown points outside every unit box."""
    pts = voxel_down(crown)
    link, least = _dish_scale(Sparse.of(point_spacing(pts)))
    if len(pts) < least:
        return []
    keep = np.ones(len(pts), dtype=bool)
    near_tree = cKDTree(pts)
    for u in units:
        idx = np.asarray(
            near_tree.query_ball_point(u.centre, float(np.linalg.norm(u.extents / 2 + SIDE_MARGIN_M))),
            dtype=int,
        )
        if len(idx) == 0:
            continue
        local = (pts[idx] - u.centre) @ u.axes.T
        keep[idx[np.all(np.abs(local) <= u.extents / 2 + SIDE_MARGIN_M, axis=1)]] = False
    pts = pts[keep]
    if len(pts) < least:
        return []
    # a reflector is bolted to its pipe and the pipe to the frame: cut the thin tubes away first,
    # so the reflector stands alone, then give it back the points next to it (its rim)
    sheet = pts[~_tubular(pts)]
    if len(sheet) < least:
        return []
    pairs = cKDTree(sheet).query_pairs(link, output_type="ndarray")
    graph = coo_matrix((np.ones(len(pairs)), (pairs[:, 0], pairs[:, 1])), shape=(len(sheet), len(sheet)))
    _, lab = connected_components(graph, directed=False)
    counts = np.bincount(lab)
    tree = cKDTree(pts)
    out: list[Unit] = []
    for c in np.where(counts >= least)[0]:
        x = sheet[lab == c]
        if float(np.linalg.norm(np.ptp(x, axis=0))) > 2 * DISH_D_RANGE[1]:
            continue  # the regrowth only adds points: a cluster this big already is no dish
        for _ in range(DISH_REGROW_STEPS):
            x = pts[np.unique(np.concatenate(tree.query_ball_point(x, link)))]
        size = float(np.linalg.norm(np.ptp(x, axis=0)))
        if DISH_D_RANGE[0] <= size <= 2 * DISH_D_RANGE[1]:
            u = _reflector(x, axis_point, rng, least)
            if u is not None:
                out.append(u)
    return out


def _tubular(pts: np.ndarray) -> np.ndarray:
    """Mask of points on thin tubes (pipes, clamps, brackets, cables): on a 3 cm grid, cells whose
    `TUBE_K` nearest cells spread along one line (linearity above `TUBE_LINEARITY`)."""
    keys = np.floor(pts / TUBE_CELL_M).astype(np.int64)
    _, first, inverse = np.unique(keys, axis=0, return_index=True, return_inverse=True)
    cells = pts[first]
    k = min(TUBE_K, len(cells))
    if k < 4:
        return np.zeros(len(pts), dtype=bool)
    _, nb = cKDTree(cells).query(cells, k=k)
    q = cells[nb] - cells[nb].mean(axis=1, keepdims=True)
    w = np.linalg.eigvalsh(np.einsum("nki,nkj->nij", q, q) / k)
    linear = (w[:, 2] - w[:, 1]) / np.maximum(w[:, 2], 1e-18) > TUBE_LINEARITY
    return linear[inverse.ravel()]


def _dish_outline(x: np.ndarray, m: np.ndarray, axis: np.ndarray, rng: np.random.Generator):
    """In-plane frame (side, up) across `axis`, the points in it and their round outline."""
    up = _UP - axis[1] * axis
    if np.linalg.norm(up) < 1e-6:
        return None
    up /= np.linalg.norm(up)
    side = np.cross(up, axis)
    rel = x - m
    ab = np.column_stack([rel @ side, rel @ up])
    circle = _round_outline(ab, rng)
    if circle is None:
        return None
    a0, a1 = span(ab[:, 0], 1.0)
    b0, b1 = span(ab[:, 1], 1.0)
    return side, up, ab, (a0, a1, b0, b1), circle


def _on_profile(rho: np.ndarray, t: np.ndarray, least: int = DISH_MIN_POINTS) -> np.ndarray | None:
    """Mask of the points on a reflector's profile t = k0 + k1 rho^2 (rho from its centre, t along
    its axis), fitted robustly: the pipe and clamps behind a dish lie off it."""
    shell = np.ones(len(t), dtype=bool)
    for _ in range(3):
        k = np.polyfit(rho[shell] ** 2, t[shell], 1)
        shell = np.abs(t - np.polyval(k, rho**2)) < DISH_SHELL_M
        if shell.sum() < least:
            return None
    return shell


def _reflector(
    x: np.ndarray, axis_point: np.ndarray, rng: np.random.Generator, least: int = DISH_MIN_POINTS
) -> Unit | None:
    """A dish from one thin, round cluster. The axis starts from PCA; each pass then finds the rim
    circle in the plane across the axis, keeps the points inside it on the reflector profile
    t = k0 + k1 rho^2 (the pipe, clamps and stubs behind or beside it fall away), and corrects
    the axis tilt from t = k0 + k1 rho^2 + p a + q b with the centre held at the circle's. Every
    pass judges all the points inside the disc again, so an early wrong frame drops nothing of
    the reflector for good."""
    m = x.mean(axis=0)
    _, s, vt = np.linalg.svd(x - m, full_matrices=False)
    if s[1] < 2 * s[2]:
        return None
    axis = vt[2]
    horiz = (m - axis_point) * np.array([1.0, 0.0, 1.0])
    for final in (False, False, False, True):
        if axis @ horiz < 0:  # a dish faces away from the tower
            axis = -axis
        got = _dish_outline(x, m, axis, rng)
        if got is None:
            return None
        side, up, ab, _, circle = got
        da, db = ab[:, 0] - circle["cx"], ab[:, 1] - circle["cz"]
        rho = np.hypot(da, db)
        inside = rho <= circle["r"] + 2 * DISH_CIRCLE_M
        if not inside.all():  # outside the disc: pipe or clamp stubs, never the reflector
            x, ab, da, db, rho = x[inside], ab[inside], da[inside], db[inside], rho[inside]
        t = (x - m) @ axis
        sel = _on_profile(rho, t, least)
        if sel is None:
            return None
        if final:
            break
        coef = np.linalg.lstsq(
            np.column_stack([np.ones(sel.sum()), rho[sel] ** 2, da[sel], db[sel]]), t[sel], rcond=None
        )[0]
        axis = axis - coef[2] * side - coef[3] * up
        axis /= np.linalg.norm(axis)
    x, ab, t = x[sel], ab[sel], t[sel]
    diameter = 2 * circle["r"]
    a0, a1 = span(ab[:, 0], 1.0)
    b0, b1 = span(ab[:, 1], 1.0)
    t0, t1 = span(t, 0.5)
    depth = t1 - t0
    if depth > DISH_MAX_THICKNESS * diameter:
        return None
    centre = m + side * circle["cx"] + up * circle["cz"] + axis * (t0 + t1) / 2
    cov = coverage(ab[:, 0], ab[:, 1], a1 - a0, b1 - b0, a0, b0)
    plane_rms = float(np.sqrt(np.mean((t - t.mean()) ** 2)))
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


# why a candidate box is not listed (the keys of `pair_faces`'s `drops`)
DROP_SIZE = "size"  # outside the plausible sizes
DROP_STRUCTURE = "structure"  # a slender pole, frame member or cable run (`_is_structure`)
DROP_COVERAGE = "coverage"  # a patchy front
DROP_SIDE_FACE = "side face"  # a front narrower than the box is deep
DROP_NO_BACK = "no back"  # an inferred depth that never ended before the cap
DROP_SPANS = "spans"  # a box around another unit's front
# a face of a listed unit (its side or back, the same unit found twice): whatever its reason, it
# left nothing out, so the run warning does not count it
DROP_PART = "part of a listed unit"


# how the run warning names each reason (one, many): only reasons that could hide real equipment;
# the others (outside the size range, structure, no back found, parts of listed units) are logged
_DROP_WORDS: dict[str, tuple[str, str]] = {
    DROP_SIDE_FACE: ("side face", "side faces"),
    DROP_COVERAGE: ("with low coverage", "with low coverage"),
    DROP_SPANS: ("overlapping other units", "overlapping other units"),
}


def drop_warning(drops: dict[str, int]) -> str | None:
    """The run warning for the candidate boxes left out, most common reason first, e.g. "12
    candidate boxes were not listed: 7 side faces, 3 with low coverage, 2 overlapping other
    units."; None when none was (only side faces, low coverage and overlapping boxes count; the rest is logged)."""
    named: dict[str, list] = {}
    for reason, n in drops.items():
        words = _DROP_WORDS.get(reason)
        if words is None or n <= 0:
            continue
        entry = named.setdefault(words[1], [0, words])
        entry[0] += n
    total = sum(n for n, _ in named.values())
    if total == 0:
        return None
    parts = sorted(named.values(), key=lambda e: -e[0])
    listed = ", ".join(f"{n} {words[0] if n == 1 else words[1]}" for n, words in parts)
    head = "1 candidate box was not listed" if total == 1 else f"{total} candidate boxes were not listed"
    return f"{head}: {listed}."


def _slender(u: Unit) -> bool:
    w, h = float(u.extents[0]), float(u.extents[1])
    return w < ANTENNA_MIN_W and h > MEMBER_SLENDERNESS * w


def _is_structure(u: Unit, axis_point: np.ndarray | None, shaft_r: Callable | None) -> bool:
    """Whether a slender unit (under `ANTENNA_MIN_W` wide and over `MEMBER_SLENDERNESS` times
    taller) is clearly part of the structure rather than equipment: taller than `SLENDER_MAX_H`
    (a pole, a frame member or a cable run, longer than any equipment that narrow), or with a box
    corner within `SHAFT_TOUCH_M` of the shaft surface (a bracket or a cable run on the shaft).
    Other slender units are kept and listed as "other" equipment (`classify`), never deleted."""
    if not _slender(u):
        return False
    if float(u.extents[1]) > SLENDER_MAX_H:
        return True
    if axis_point is None or shaft_r is None:
        return False
    signs = np.array([[i, j, k] for i in (-1, 1) for j in (-1, 1) for k in (-1, 1)], dtype=float)
    corners = u.centre + (signs * u.extents / 2) @ u.axes
    rel = corners - np.asarray(axis_point, dtype=float)
    r = np.hypot(rel[:, 0], rel[:, 2])
    return bool(np.any(r <= np.asarray(shaft_r(rel[:, 1]), dtype=float) + SHAFT_TOUCH_M))


def _drop_reason(
    u: Unit, axis_point: np.ndarray | None = None, shaft_r: Callable | None = None
) -> str | None:
    """Why a unit is not one plausible box, or None when it is: sizes in range (`DROP_SIZE`), not
    a slender part of the structure (`DROP_STRUCTURE`, `_is_structure`), a solid front
    (`DROP_COVERAGE`: `MIN_FRONT_COVERAGE`, `MIN_LONE_COVERAGE` without a back face; faces stitched
    across several units or the frame between them are mostly holes, and a bracket or clamp plate
    seldom fills its outline), a front wider than the box is deep (`DROP_SIDE_FACE`: a narrower
    one is a side face, the front of a unit is its widest upright face), and an inferred depth
    that ended before `MAX_D` (`DROP_NO_BACK`: one that did not found no back to the face, which
    is then a side face or a face of the frame)."""
    lo, hi = np.array([MIN_W, MIN_H, MIN_D]), np.array([MAX_W, MAX_H, MAX_D])
    w, _, d = (float(v) for v in u.extents)
    if not (np.all(u.extents >= lo) and np.all(u.extents <= hi)):
        return DROP_SIZE
    if _is_structure(u, axis_point, shaft_r):
        return DROP_STRUCTURE
    least = MIN_FRONT_COVERAGE if u.depth_measured else MIN_LONE_COVERAGE
    if u.front.coverage < least:
        return DROP_COVERAGE
    if w < d:
        return DROP_SIDE_FACE
    if not u.depth_measured and d >= MAX_D - DEPTH_BIN_M:
        return DROP_NO_BACK
    return None


def _is_box(u: Unit, axis_point: np.ndarray | None = None, shaft_r: Callable | None = None) -> bool:
    """Whether a unit is one plausible box (`_drop_reason` gives none)."""
    return _drop_reason(u, axis_point, shaft_r) is None


def pair_faces(
    faces: list[Face],
    axis_point: np.ndarray,
    crown_xyz: np.ndarray,
    shaft_r: Callable | None = None,
    drops: dict[str, int] | None = None,
) -> list[Unit]:
    """Units (oriented boxes with a kind) from the crown's planar faces and its points. `shaft_r`
    (radius against height above `axis_point`) lets slender units fixed to the shaft go as
    structure; `drops`, when given, counts the candidate boxes left out by reason (`DROP_*`; one
    whose front lies on a listed unit's box counts as `DROP_PART`)."""
    axis_point = np.asarray(axis_point, dtype=float)
    crown = np.asarray(crown_xyz, dtype=float)
    tree = cKDTree(crown) if len(crown) else None
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
        for j, g in enumerate(big):
            if j in used:
                continue
            pair = _pair(group[0], g)
            if pair is not None:
                group[0] = pair[0]
                group.append(pair[1])
                used.add(j)
        units.append(_group_unit(group, axis_point, crown, tree))
    dropped: list[tuple[str, Unit]] = []
    boxes: list[Unit] = []
    for u in units:
        reason = _drop_reason(u, axis_point, shaft_r)
        if reason is None:
            boxes.append(u)
        else:
            dropped.append((reason, u))
    boxes.sort(key=lambda u: -u.support)
    kept: list[Unit] = []
    for u in boxes:
        # the same unit again, a face of a better supported unit (its side), or a box around one
        # (spanning two units, the ring between them): none is a unit of its own
        if any(
            np.linalg.norm(u.centre - k.centre) < DUP_M and abs(u.axes[2] @ k.axes[2]) > PAIR_DOT
            for k in kept
        ) or any(_inside(u.front.centre, k, SIDE_MARGIN_M) for k in kept):
            dropped.append((DROP_PART, u))
        elif any(_inside(k.front.centre, u, 0.0) for k in kept):
            dropped.append((DROP_SPANS, u))
        else:
            kept.append(u)
    for u in kept:
        u.dish = _flat_dish(u, rng)
    kept += _reflector_dishes(crown, kept, axis_point, rng)
    if drops is not None:
        for reason, u in dropped:
            # a face of a listed unit (its side or back, found again) left nothing out
            if reason != DROP_SPANS and any(_inside(u.front.centre, k, SIDE_MARGIN_M) for k in kept):
                reason = DROP_PART
            drops[reason] = drops.get(reason, 0) + 1
    for u in kept:
        radial = u.centre - axis_point
        radial[1] = 0.0
        ln = np.linalg.norm(radial)
        u.kind = classify(u, radial / ln if ln > 0 else radial)
    return kept


def classify(unit: Unit, radial: np.ndarray) -> str:
    """The kind of a unit: "dish" when round, "other" when it faces sideways or inward (its outward
    axis within 60 degrees of the radial direction is required), is narrower than 0.2 m (the
    slender units 0.12 to 0.2 m wide that are not structure land here) or measures under 0.08 m
    deep (a plate, a bracket), else by height: "panel" from 1.2 m, "short" from 0.6 m, "other"
    below."""
    if unit.dish is not None:
        return "dish"
    out_h = unit.axes[2] * np.array([1.0, 0.0, 1.0])
    r_h = np.asarray(radial, dtype=float) * np.array([1.0, 0.0, 1.0])
    ln = np.linalg.norm(out_h) * np.linalg.norm(r_h)
    if ln == 0 or (out_h @ r_h) / ln < FACING_MIN:
        return "other"
    if float(unit.extents[0]) < ANTENNA_MIN_W or (
        unit.depth_measured and float(unit.extents[2]) < ANTENNA_MIN_D
    ):
        return "other"
    h = float(unit.extents[1])
    if h >= PANEL_MIN_H:
        return "panel"
    if h >= SHORT_MIN_H:
        return "short"
    return "other"
