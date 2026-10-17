"""Upright planar faces of the equipment on a tower crown.

Local frame (x east, y up, z south). The crown points are thinned on a voxel grid, the shaft and
its brackets are dropped by radius, every point gets a k-NN PCA normal, and the upright, flat
points are grown into planar regions. Rough regions are split with RANSAC, coplanar pieces that
touch are joined (a sparse cloud breaks faces apart), and each plane then floods back the inliers
the curvature filter dropped along its edges, so the extents reach the box edges.
Normals point outward, away from the tower axis.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components
from scipy.spatial import cKDTree

VOXEL_M = 0.015
NORMAL_K = 16
MAX_CURVATURE = 0.02
UPRIGHT_MAX_NY = 0.5
GROW_RADIUS_M = 0.035
GROW_DOT = 0.985
GROW_OFFSET_M = 0.008
MIN_FACE_POINTS = 150
SPLIT_RMS_M = 0.010
RANSAC_THR_M = 0.008
KEEP_RMS_M = 0.012

SHAFT_MARGIN_M = 0.05  # points closer than shaft_r(h) + this to the axis are shaft or brackets
MIN_FACE_WIDTH_M = 0.08
EDGE_REACH_M = 0.05  # least reach past the grown region for a plane to take back its edge inliers
COVERAGE_CELL_M = 0.05
# grown regions smaller than this are noise; pieces join coplanar neighbours before the size test
MIN_PIECE_POINTS = 30
EDGE_STRIP_M = 0.04  # width of the edge strips that set a face's in-plane rotation
EDGE_PASSES = 6
MAX_FLOOD_STEPS = 40  # in-plane flood fill steps of `reach` each (2 m and more)
CORE_CELL_M = 0.03  # grid cell of the full-rectangle cut (at least half the flood reach)
CORE_SHARE = 0.5
SLIT_MIN_POINTS = 20  # points in a face's median core band for a sparse band to be a real slit
SLIT_SHARE = 0.4  # a band with fewer points than this share of the median band is a slit
MAX_PIECES = 4  # faces one flood fill may split into
OCCLUDER_M = 0.5  # points this far in front of a face can shade it
SAME_FACE_M = 0.05  # two faces of one plane with centres this close are one face
UP_SEARCH_DEG = 20.0  # a face's up axis is searched this far either side of the in-plane vertical
_UP = np.array([0.0, 1.0, 0.0])


@dataclass
class Face:
    points: np.ndarray
    centre: np.ndarray  # middle of the face extents, on the plane
    normal: np.ndarray  # outward, local frame
    up: np.ndarray  # the in-plane axis nearest vertical (the long axis of a tall face)
    side: np.ndarray  # up x normal: the viewer's right seen from the front
    height: float
    width: float
    rms: float
    support: int
    coverage: float


def voxel_down(xyz: np.ndarray, size: float = VOXEL_M) -> np.ndarray:
    """One point (the first) per occupied voxel, in input order."""
    if len(xyz) == 0:
        return xyz.reshape(0, 3)
    keys = np.floor(xyz / size).astype(np.int64)
    _, idx = np.unique(keys, axis=0, return_index=True)
    return xyz[np.sort(idx)]


def normals(xyz: np.ndarray, k: int = NORMAL_K) -> tuple[np.ndarray, np.ndarray]:
    """k-NN PCA normals (unit, unoriented) and curvature (smallest eigenvalue over the sum)."""
    k = min(k, len(xyz))
    _, nb = cKDTree(xyz).query(xyz, k=k)
    q = xyz[nb] - xyz[nb].mean(axis=1, keepdims=True)
    cov = np.einsum("nki,nkj->nij", q, q) / k
    w, v = np.linalg.eigh(cov)
    curv = w[:, 0] / np.maximum(w.sum(axis=1), 1e-18)
    return v[:, :, 0], curv


def _plane(xyz: np.ndarray) -> tuple[np.ndarray, np.ndarray, float]:
    """Least-squares plane: (centroid, unit normal, RMS residual)."""
    m = xyz.mean(axis=0)
    _, _, vt = np.linalg.svd(xyz - m, full_matrices=False)
    n = vt[2]
    return m, n, float(np.sqrt(np.mean(((xyz - m) @ n) ** 2)))


def ransac_planes(
    xyz: np.ndarray,
    rng: np.random.Generator,
    thr: float = RANSAC_THR_M,
    min_points: int = MIN_FACE_POINTS,
    iters: int = 300,
    max_ny: float = UPRIGHT_MAX_NY,
) -> list[np.ndarray]:
    """Split points into planes, best first: index arrays into `xyz`. Only planes whose normal has
    |n_y| < `max_ny` (upright faces) are candidates."""
    left = np.arange(len(xyz))
    out: list[np.ndarray] = []
    while len(left) >= min_points:
        pts = xyz[left]
        best: np.ndarray | None = None
        for _ in range(iters):
            s = pts[rng.choice(len(pts), 3, replace=False)]
            n = np.cross(s[1] - s[0], s[2] - s[0])
            ln = np.linalg.norm(n)
            if ln < 1e-9:
                continue
            n /= ln
            if abs(n[1]) >= max_ny:
                continue
            inl = np.abs((pts - s[0]) @ n) < thr
            if best is None or inl.sum() > best.sum():
                best = inl
        if best is None or best.sum() < min_points:
            break
        m, n, _ = _plane(pts[best])  # refine on the inliers
        best = np.abs((pts - m) @ n) < thr
        if best.sum() < min_points or abs(n[1]) >= max_ny:
            break
        out.append(left[best])
        left = left[~best]
    return out


def _horizontal(v: np.ndarray, axis_dir: np.ndarray) -> np.ndarray:
    return v - np.outer(v @ axis_dir, axis_dir) if v.ndim == 2 else v - (v @ axis_dir) * axis_dir


def _box_area(ab: np.ndarray, t: float) -> float:
    c, s = np.cos(t), np.sin(t)
    a0, a1 = np.percentile(ab[:, 0] * c - ab[:, 1] * s, [1.0, 99.0])
    b0, b1 = np.percentile(ab[:, 0] * s + ab[:, 1] * c, [1.0, 99.0])
    return float((a1 - a0) * (b1 - b0))


def _edge_turn(ab: np.ndarray, t: float) -> float | None:
    """Correction to the rotation `t` from straight-line fits to the face's four edge strips
    (corners left out), each weighted by its points and squared length; None without edges."""
    c, s = np.cos(t), np.sin(t)
    a = ab[:, 0] * c - ab[:, 1] * s
    b = ab[:, 0] * s + ab[:, 1] * c
    a0, a1 = np.percentile(a, [1.0, 99.0])
    b0, b1 = np.percentile(b, [1.0, 99.0])
    turns, weights = [], []
    for along, across, lo, hi, sign in ((b, a, a0, a1, 1.0), (a, b, b0, b1, -1.0)):
        length = float(np.ptp(along)) if len(along) else 0.0
        mid = (along > along.min() + EDGE_STRIP_M) & (along < along.max() - EDGE_STRIP_M)
        for strip in (mid & (across < lo + EDGE_STRIP_M), mid & (across > hi - EDGE_STRIP_M)):
            if strip.sum() < 20:
                continue
            slope = np.polyfit(along[strip], across[strip], 1)[0]
            # a vertical edge tilted toward +a turns the up axis by +atan; a horizontal edge
            # tilted toward +b turns it the other way
            turns.append(sign * float(np.arctan(slope)))
            weights.append(strip.sum() * length**2)
    if not turns:
        return None
    return float(np.average(turns, weights=weights))


def _in_plane_axes(pts: np.ndarray, centre: np.ndarray, n: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(up, side) of a face: the edge direction of its outline nearest the in-plane vertical, and
    up x normal (the viewer's right). A coarse search within `UP_SEARCH_DEG` of vertical finds the
    rotation with the smallest robust bounding rectangle; line fits to the edge strips then refine
    it (each pass halves the bias of the strip cut). A principal-axis fit wobbles by a degree or
    more on a 0.4 m face; the edges hold it to a few tenths."""
    u0 = _UP - (_UP @ n) * n
    u0 /= np.linalg.norm(u0)
    s0 = np.cross(u0, n)
    rel = pts - centre
    ab = np.column_stack([rel @ s0, rel @ u0])
    lim = np.radians(UP_SEARCH_DEG)
    ts = np.radians(np.arange(-UP_SEARCH_DEG, UP_SEARCH_DEG + 0.5, 1.0))
    best = float(ts[int(np.argmin([_box_area(ab, t) for t in ts]))])
    for _ in range(EDGE_PASSES):
        turn = _edge_turn(ab, best)
        if turn is None:
            break
        best = float(np.clip(best + turn, -lim, lim))
    # the rotated up coordinate is a sin t + b cos t: that axis is (sin t, cos t) in (side, up)
    up = np.sin(best) * s0 + np.cos(best) * u0
    up /= np.linalg.norm(up)
    return up, np.cross(up, n)


def span(values: np.ndarray, pct: float) -> tuple[float, float]:
    """The robust extent of uniformly spread `values`: the [pct, 100 - pct] percentile interval,
    widened by the share it trims so a uniform sample gives its full length."""
    lo, hi = np.percentile(values, [pct, 100.0 - pct])
    pad = (hi - lo) * pct / (100.0 - 2.0 * pct)
    return float(lo - pad), float(hi + pad)


def coverage(a: np.ndarray, b: np.ndarray, w: float, h: float, a0: float, b0: float) -> float:
    """Occupied share of a `COVERAGE_CELL_M` grid over the w x h rectangle starting at (a0, b0)."""
    nu = max(1, round(w / COVERAGE_CELL_M))
    nv = max(1, round(h / COVERAGE_CELL_M))
    iu = np.clip(((a - a0) / w * nu).astype(int), 0, nu - 1)
    iv = np.clip(((b - b0) / h * nv).astype(int), 0, nv - 1)
    inside = (a >= a0) & (a <= a0 + w) & (b >= b0) & (b <= b0 + h)
    return float(len(np.unique(iu[inside] * nv + iv[inside])) / (nu * nv))


def make_face(pts: np.ndarray, axis_point: np.ndarray, axis_dir: np.ndarray) -> Face:
    """A face from the points of one plane, its normal turned away from the axis."""
    m, n, rms = _plane(pts)
    if _horizontal(n, axis_dir) @ _horizontal(m - axis_point, axis_dir) < 0:
        n = -n
    up, side = _in_plane_axes(pts, m, n)
    rel = pts - m
    a, b = rel @ side, rel @ up
    a0, a1 = span(a, 1.0)
    b0, b1 = span(b, 0.5)
    w, h = a1 - a0, b1 - b0
    centre = m + side * (a0 + a1) / 2 + up * (b0 + b1) / 2
    cov = coverage(a, b, w, h, a0, b0) if w > 0 and h > 0 else 0.0
    return Face(pts, centre, n, up, side, float(h), float(w), rms, len(pts), cov)


def planar_faces(
    xyz: np.ndarray,
    axis_point: np.ndarray,
    axis_dir: np.ndarray,
    shaft_r: Callable[[np.ndarray], np.ndarray],
    seed: int = 0,
) -> list[Face]:
    """Upright planar faces of the crown points `xyz` (the shaft and its brackets left out)."""
    axis_point = np.asarray(axis_point, dtype=float)
    axis_dir = np.asarray(axis_dir, dtype=float) / np.linalg.norm(axis_dir)
    rng = np.random.default_rng(seed)
    pts = voxel_down(np.asarray(xyz, dtype=float))
    rel = pts - axis_point
    h = rel @ axis_dir
    r = np.linalg.norm(_horizontal(rel, axis_dir), axis=1)
    pts = pts[r >= np.asarray(shaft_r(h), dtype=float) + SHAFT_MARGIN_M]
    if len(pts) < MIN_FACE_POINTS:
        return []
    nrm, curv = normals(pts)
    flat = np.where((np.abs(nrm[:, 1]) < UPRIGHT_MAX_NY) & (curv < MAX_CURVATURE))[0]
    if len(flat) < MIN_FACE_POINTS:
        return []
    pv, nv = pts[flat], nrm[flat]
    pairs = cKDTree(pv).query_pairs(GROW_RADIUS_M, output_type="ndarray")
    i, j = pairs[:, 0], pairs[:, 1]
    ok = (np.abs(np.einsum("ij,ij->i", nv[i], nv[j])) > GROW_DOT) & (
        np.abs(np.einsum("ij,ij->i", pv[j] - pv[i], nv[i])) < GROW_OFFSET_M
    )
    graph = coo_matrix((np.ones(ok.sum()), (i[ok], j[ok])), shape=(len(pv), len(pv)))
    _, lab = connected_components(graph, directed=False)
    counts = np.bincount(lab)
    parts: list[np.ndarray] = []
    for c in np.where(counts >= MIN_PIECE_POINTS)[0]:
        region = pv[lab == c]
        _, _, rms = _plane(region)
        if rms > SPLIT_RMS_M and len(region) >= MIN_FACE_POINTS:
            parts += [region[k] for k in ransac_planes(region, rng)]
        else:
            parts.append(region)
    # the curvature filter erodes every face by about the k-NN radius: reach past that
    sample = pts[:: max(1, len(pts) // 2000)]
    knn_r = float(np.median(cKDTree(pts).query(sample, k=min(NORMAL_K, len(pts)))[0][:, -1]))
    reach = max(EDGE_REACH_M, 1.5 * knn_r)
    tree = cKDTree(pts)
    faces: list[Face] = []
    for part in _merge_coplanar(parts, reach):
        for face in _with_edges(part, pts, tree, reach, axis_point, axis_dir):
            if (
                face.rms < KEEP_RMS_M
                and face.width >= MIN_FACE_WIDTH_M
                and abs(face.normal[1]) < UPRIGHT_MAX_NY
            ):
                faces.append(face)
    return _distinct(faces)


def _distinct(faces: list[Face]) -> list[Face]:
    """One face per plane patch: pieces the growth kept apart (a cable lying across a face cuts
    it in two) flood to the same face; the best supported copy stays."""
    out: list[Face] = []
    for f in sorted(faces, key=lambda f: -f.support):
        same = any(
            abs(f.normal @ g.normal) > GROW_DOT
            and abs((f.centre - g.centre) @ g.normal) < RANSAC_THR_M
            and np.linalg.norm(f.centre - g.centre) < SAME_FACE_M
            for g in out
        )
        if not same:
            out.append(f)
    return out


def _merge_coplanar(parts: list[np.ndarray], gap: float) -> list[np.ndarray]:
    """Join planar regions that lie on one plane and come within `gap` of each other: a sparse
    cloud breaks one face into pieces where its points are too far apart to grow across."""
    planes = [_plane(p) for p in parts]
    trees = [cKDTree(p) for p in parts]
    root = list(range(len(parts)))

    def find(i: int) -> int:
        while root[i] != i:
            root[i] = root[root[i]]
            i = root[i]
        return i

    for i in range(len(parts)):
        mi, ni, _ = planes[i]
        for j in range(i + 1, len(parts)):
            mj, nj, _ = planes[j]
            if abs(ni @ nj) <= GROW_DOT or max(abs((mj - mi) @ ni), abs((mi - mj) @ nj)) >= RANSAC_THR_M:
                continue
            d, _ = trees[j].query(parts[i], k=1, distance_upper_bound=gap)
            if np.isfinite(d).any() and _plane(np.vstack([parts[i], parts[j]]))[2] < SPLIT_RMS_M:
                root[find(j)] = find(i)
    groups: dict[int, list[np.ndarray]] = {}
    for i, p in enumerate(parts):
        groups.setdefault(find(i), []).append(p)
    return [np.vstack(g) for g in groups.values() if sum(len(p) for p in g) >= MIN_FACE_POINTS]


def _with_edges(
    part: np.ndarray,
    pts: np.ndarray,
    tree: cKDTree,
    reach: float,
    axis_point: np.ndarray,
    axis_dir: np.ndarray,
) -> list[Face]:
    """The faces of one grown plane (one, or one per piece where a slit splits it), after taking back its plane inliers (within `RANSAC_THR_M`)
    connected to it at `reach`: the curvature filter drops the points along every box edge, and in
    a sparse cloud whole stretches of a face, which this flood fill in the plane recovers. The fill
    also runs into anything touching the plane (the tangent strip of a pipe a unit clamps onto, a
    cable across its front), so the result is cut to its full rectangle (`_core`). Bounding the
    fill by the grown region instead would lose the stretches a sparse cloud never grew."""
    m, n, _ = _plane(part)
    if abs(n[1]) >= UPRIGHT_MAX_NY:
        return []
    inplane = np.abs((pts - m) @ n) < RANSAC_THR_M
    taken = np.zeros(len(pts), dtype=bool)
    frontier = part
    for _ in range(MAX_FLOOD_STEPS):
        near = np.unique(np.concatenate(tree.query_ball_point(frontier, reach)))
        near = near[inplane[near] & ~taken[near]]
        if len(near) == 0:
            break
        taken[near] = True
        frontier = pts[near]
    if taken.sum() < MIN_FACE_POINTS:
        return []
    flooded = pts[taken]
    seed = np.zeros(len(pts), dtype=bool)
    seed[np.unique(tree.query(part, k=1)[1])] = True
    seed = seed[taken]
    cell = max(CORE_CELL_M, reach / 2)
    # what stands in front of the plane over the fill: the occluders whose shadows are no slits
    lo_, hi_ = flooded.min(axis=0) - OCCLUDER_M, flooded.max(axis=0) + OCCLUDER_M
    box = np.all((pts >= lo_) & (pts <= hi_), axis=1)
    out_n = n if _horizontal(n, axis_dir) @ _horizontal(m - axis_point, axis_dir) >= 0 else -n
    off = (pts[box] - m) @ out_n
    ahead = pts[box][(off > RANSAC_THR_M) & (off < OCCLUDER_M)]
    # first cut with rows level and columns upright in the plane (a leak can tilt any fitted
    # axes, and an antenna leans a few degrees at most), then again along the axes of that cut.
    # A slit splits the fill into pieces (`_core`): each piece with enough grown points of its
    # own becomes a face, so two units side by side that grew into one region both come out.
    up0 = _UP - (_UP @ n) * n
    up0 /= np.linalg.norm(up0)
    out: list[Face] = []
    left = seed.copy()
    for _ in range(MAX_PIECES):
        if left.sum() < MIN_PIECE_POINTS:
            break
        centre, side, up = m, np.cross(up0, n), up0
        face: Face | None = None
        cut = np.zeros(len(flooded), dtype=bool)
        for _ in range(2):
            cut = _core(flooded, centre, side, up, cell, left, ahead)
            if cut.sum() < MIN_FACE_POINTS:
                face = None
                break
            face = make_face(flooded[cut], axis_point, axis_dir)
            centre, side, up = face.centre, face.side, face.up
        if not (cut & left).any():
            break
        left &= ~cut
        if face is not None:
            out.append(face)
    return out


def _runs(full: np.ndarray, slit: np.ndarray) -> list[tuple[int, int]]:
    """First and last index of every run of True in `full`, bridging single-cell gaps; a `slit`
    cell (almost no points) always ends a run."""
    out: list[tuple[int, int]] = []
    start, end, gap = None, 0, 0
    flags = [*(full & ~slit).tolist(), False, False]
    cuts = [*slit.tolist(), True, True]
    for i, v in enumerate(flags):
        if v:
            if start is None:
                start = i
            gap, end = 0, i
        elif start is not None:
            gap += 1
            if gap > 1 or cuts[i]:
                out.append((start, end))
                start, gap = None, 0
    return out


def _core(
    points: np.ndarray,
    centre: np.ndarray,
    side: np.ndarray,
    up: np.ndarray,
    cell: float,
    seed: np.ndarray | None = None,
    front: np.ndarray | None = None,
) -> np.ndarray:
    """Mask of the face points inside its full rectangle: a run of rows (bands of `cell` along
    up) whose points span at least `CORE_SHARE` of the median row across (rows weighted by their
    points), then of columns as tall within those rows. A thin strip in the plane (the tangent
    strip of a pipe the face touches, a cable lying across it) spans only its own few centimetres
    and is cut off, while a sliver band at the face's edge still spans the whole face. A band with
    under `SLIT_SHARE` of the median band's points, where the face is dense enough that a band of
    it never comes out that thin by chance (`SLIT_MIN_POINTS` in the median band), ends a run: two units side by side or one above the
    other with a slit between them stay apart even when the flood fill reached across. Of the
    runs, the one holding most of the `seed` points (the grown region, default all) is kept, so
    each unit of a pair keeps its own. A thin band with something in front of it (`front`: points
    off the plane on its outer side) is the shadow of a pipe or cable across the face, not a slit.
    Rows run along `side`, columns along `up`."""
    rel = points - centre
    a, b = rel @ side, rel @ up
    fa, fb = (np.zeros(0), np.zeros(0)) if front is None else ((front - centre) @ side, (front - centre) @ up)
    weight = np.ones(len(a)) if seed is None else seed.astype(float)
    keep = np.ones(len(a), dtype=bool)
    for along, across, f_along, f_across in ((b, a, fb, fa), (a, b, fa, fb)):  # rows, then columns
        idx = np.floor((along - along[keep].min()) / cell).astype(int)
        n = max(int(idx[keep].max()) + 1, 1)
        lo, hi = np.full(n, np.inf), np.full(n, -np.inf)
        np.minimum.at(lo, idx[keep], across[keep])
        np.maximum.at(hi, idx[keep], across[keep])
        width = np.where(np.isfinite(lo), hi - lo, 0.0)
        count = np.bincount(idx[keep], minlength=n)
        order = np.argsort(width)  # the median band width, each band weighted by its points
        ref = width[order][np.searchsorted(np.cumsum(count[order]), count.sum() / 2)]
        full = width >= CORE_SHARE * ref
        occupied = count[count > 0]
        dense = float(np.median(occupied)) >= SLIT_MIN_POINTS
        thin = (count < SLIT_SHARE * float(np.median(occupied))) & dense
        if thin.any() and len(f_along):
            inside = (f_across >= across[keep].min()) & (f_across <= across[keep].max())
            fi = np.floor((f_along[inside] - along[keep].min()) / cell).astype(int)
            fi = fi[(fi >= 0) & (fi < n)]
            shade = np.bincount(fi, minlength=n)
            thin &= shade < SLIT_SHARE * float(np.median(occupied))
        runs = _runs(full, thin)
        if not runs:
            return np.zeros(len(a), dtype=bool)
        seeds = np.bincount(idx[keep], weights=weight[keep], minlength=n)
        best = max(runs, key=lambda r: (float(seeds[r[0] : r[1] + 1].sum()), r[1] - r[0]))
        keep = keep & (idx >= best[0]) & (idx <= best[1])
    return keep
