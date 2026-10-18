"""Bounded source-only crown pipes, horizontal deck envelopes and supported associations.

No inventory, pipe count or drawing dimensions are inputs. Construction details remain inferred;
ambiguous surfaces and attachment relationships are omitted instead of completing an assembly.
"""

from __future__ import annotations

import hashlib
import json

import numpy as np
from scipy import ndimage
from scipy.optimize import least_squares
from scipy.spatial import ConvexHull, QhullError, cKDTree
from shapely.geometry import Polygon
from skimage.measure import find_contours

from ..modelfit.ransac import pipe as fit_pipe
from ..telecom.faces import voxel_down
from .discovery import _prepare
from .members import _components
from .observations import Observation

MAX_PIPE_CANDIDATES = 96
MAX_PIPES = 64
MAX_PLANES = 16


def _axes(o):
    az, tilt = np.radians([o.get("azimuthDeg", 0), o.get("tiltDeg", 0)])
    front = np.array([np.sin(az) * np.cos(tilt), -np.sin(tilt), -np.cos(az) * np.cos(tilt)])
    right = np.array([np.cos(az), 0, np.sin(az)])
    return np.vstack([right, np.cross(right, front), front])


def _identity(kind, centre, base, sources):
    key = [
        sorted((s["kind"], s["ref"]) for s in sources),
        np.round((centre - base) / 0.05).astype(int).tolist(),
    ]
    return f"obs-cloud-{kind}-" + hashlib.sha256(json.dumps(key).encode()).hexdigest()[:16]


def _features(points, base, check):
    """Local PCA in bounded batches; reject sheets as pipe seeds and tubes as deck seeds."""
    pts = voxel_down(points - base, 0.03) + base
    vertical = np.zeros(len(pts), dtype=bool)
    horizontal = vertical.copy()
    if len(pts) < 32:
        return pts, vertical, horizontal
    tree = cKDTree(pts)
    for start in range(0, len(pts), 4096):
        check()
        # A neighbourhood must span several pipe diameters to distinguish a tube from its
        # locally planar skin. Keep the smaller neighbourhood for deck surface normals.
        _, near = tree.query(pts[start : start + 4096], k=min(96, len(pts)), workers=1)
        q = pts[near]
        q -= q.mean(axis=1, keepdims=True)
        vals, vecs = np.linalg.eigh(np.einsum("nki,nkj->nij", q, q) / q.shape[1])
        vertical[start : start + len(q)] = (
            (vals[:, 2] - vals[:, 1]) / np.maximum(vals[:, 2], 1e-12) > 0.72
        ) & (abs(vecs[:, 1, 2]) > 0.94)
        q = pts[near[:, :32]]
        q -= q.mean(axis=1, keepdims=True)
        vals, vecs = np.linalg.eigh(np.einsum("nki,nkj->nij", q, q) / 32)
        horizontal[start : start + len(q)] = (vals[:, 0] / np.maximum(vals.sum(axis=1), 1e-12) < 0.025) & (
            abs(vecs[:, 1, 0]) > 0.98
        )
    return pts, vertical, horizontal


def _runs(active, gap=1):
    if not len(active):
        return []
    return np.split(active, np.flatnonzero(np.diff(active) > gap + 1) + 1)


def _pipe_observation(seed, points, tree, base, sources):
    fitted = fit_pipe(seed, 0.008)
    if fitted is None or fitted.share < 0.7 or fitted.residual > 0.012:
        return None
    a, b = np.array(fitted.shape["points"])
    if b[1] < a[1]:
        a, b = b, a
    if b[1] - a[1] < 0.7:
        return None
    radius = fitted.shape["diameter"] / 2
    if not 0.015 < radius < 0.15:
        return None
    mid = (a[1] + b[1]) / 2
    slope = (b - a)[[0, 2]] / (b[1] - a[1])
    if np.linalg.norm(slope) >= 0.2:
        return None
    centre = (a + b)[[0, 2]] / 2
    # Query once around the bounded candidate, then refine its cylinder rather than its PCA mean.
    idx = tree.query_ball_point((a + b) / 2, np.linalg.norm(b - a) / 2 + 0.2)
    near = points[idx]
    line = centre + (near[:, 1, None] - mid) * slope
    near = near[
        (near[:, 1] >= a[1] - 0.2)
        & (near[:, 1] <= b[1] + 0.2)
        & (np.linalg.norm(near[:, [0, 2]] - line, axis=1) < radius + 0.04)
    ]
    if len(near) < 80:
        return None

    def radial(v):
        rel = near - np.array([v[2], mid, v[3]])
        direction = np.array([v[0], 1, v[1]])
        direction /= np.linalg.norm(direction)
        return np.linalg.norm(rel - np.outer(rel @ direction, direction), axis=1)

    initial = [*slope, *centre, radius]
    fitted = least_squares(
        lambda v: radial(v) - v[4],
        initial,
        bounds=(
            [-0.2, -0.2, *(centre - 0.08), max(0.015, radius * 0.6)],
            [0.2, 0.2, *(centre + 0.08), min(0.15, radius * 1.5)],
        ),
        loss="soft_l1",
        f_scale=0.004,
        max_nfev=60,
    )
    v = fitted.x
    if np.linalg.norm(v[:2]) >= 0.2:
        return None
    error = abs(radial(v) - v[4])
    hits = near[error < 0.012]
    if len(hits) < 80 or np.mean(error < 0.012) < 0.7:
        return None
    angle = np.arctan2(
        hits[:, 2] - (v[3] + (hits[:, 1] - mid) * v[1]), hits[:, 0] - (v[2] + (hits[:, 1] - mid) * v[0])
    )
    angle_bins = np.floor((angle + np.pi) * 12 / (2 * np.pi)).astype(int) % 12
    if len(np.unique(angle_bins)) < 6:
        return None
    bins = np.floor((hits[:, 1] - base[1]) / 0.15).astype(int)
    keys, counts = np.unique(bins, return_counts=True)
    active = keys[counts >= 5]
    runs = _runs(active)
    if not runs:
        return None
    run = max(runs, key=len)
    if len(run) < 5:
        return None
    use = (bins >= run[0]) & (bins <= run[-1])
    hits, bins, angle_bins = hits[use], bins[use], angle_bins[use]
    covered_slices = [len(np.unique(angle_bins[bins == k])) / 12 for k in run]
    if sum(c >= 0.4 for c in covered_slices) < max(3, 0.6 * len(run)) or np.mean(covered_slices) < 0.5:
        return None
    lo, hi = np.percentile(hits[:, 1], [1, 99])
    if hi - lo < 0.7:
        return None
    path = [[v[2] + (y - mid) * v[0], y, v[3] + (y - mid) * v[1]] for y in (lo, hi)]
    c = np.mean(path, axis=0)
    q = {
        "basis": "measured",
        "support": len(hits),
        "residualM": float(np.sqrt(np.mean(error[error < 0.012] ** 2))),
        "coverage": float(np.mean(covered_slices)),
    }
    item = Observation(
        _identity("support-pipe", c, base, sources),
        "mounting-pipe",
        tuple(c),
        (float(2 * v[4]), float(hi - lo), float(2 * v[4])),
        0,
        0,
        {
            k: q if k in ("centre", "width", "height", "depth") else {"basis": "inferred"}
            for k in ("centre", "width", "height", "depth", "azimuthDeg", "tiltDeg")
        },
        sources,
        name="Source-fitted crown pipe",
        notes=[
            "Only the continuously supported pipe segment is represented; structural role and hidden extensions are unresolved."
        ],
    ).to_dict()
    item["path"] = [[float(x) for x in p] for p in path]
    return item


def pipe_overlaps(a, b):
    """Same observed centreline and overlapping height; never deduplicate by nearby centre alone."""
    pa, pb = np.array(a.get("path", [])), np.array(b.get("path", []))
    if len(pa) < 2 or len(pb) < 2:
        return False
    lo, hi = max(pa[:, 1].min(), pb[:, 1].min()), min(pa[:, 1].max(), pb[:, 1].max())
    if hi - lo < 0.5 * min(np.ptp(pa[:, 1]), np.ptp(pb[:, 1])):
        return False
    ys = np.linspace(lo, hi, 5)

    def centres(p):
        p = p[np.argsort(p[:, 1])]
        return np.column_stack([np.interp(ys, p[:, 1], p[:, k]) for k in (0, 2)])

    return bool(np.max(np.linalg.norm(centres(pa) - centres(pb), axis=1)) < 0.06)


def _plane_layers(points, base, check):
    """Separate nearby surfaces before fitting; averaging deck and hardware misses both."""
    remaining = points
    rng = np.random.default_rng(0)
    layers = []
    for _ in range(4):
        check()
        if len(remaining) < 100:
            break
        sample = remaining[np.linspace(0, len(remaining) - 1, min(2000, len(remaining))).astype(int)]
        design = np.column_stack([np.ones(len(sample)), sample[:, [0, 2]] - base[[0, 2]]])
        triples = rng.integers(0, len(sample), (192, 3))
        matrices = design[triples]
        valid = abs(np.linalg.det(matrices)) > 0.05
        if not valid.any():
            break
        planes = np.linalg.solve(matrices[valid], sample[triples[valid], 1, None])[:, :, 0]
        planes = planes[np.linalg.norm(planes[:, 1:], axis=1) < 0.1]
        if not len(planes):
            break
        score = np.sum(abs(design @ planes.T - sample[:, 1, None]) < 0.015, axis=0)
        plane = planes[np.argmax(score)]
        full = np.column_stack([np.ones(len(remaining)), remaining[:, [0, 2]] - base[[0, 2]]])
        on = abs(full @ plane - remaining[:, 1]) < 0.02
        if on.sum() < 100:
            break
        plane = np.linalg.lstsq(full[on], remaining[on, 1], rcond=None)[0]
        distance = abs(full @ plane - remaining[:, 1])
        layers.append(remaining[distance < 0.02])
        remaining = remaining[distance >= 0.035]
    return layers


def _platforms(points, flat, base, direction, shaft_r, sources, check):
    if len(flat) < 150:
        return []
    keys, counts = np.unique(np.floor((flat[:, 1] - base[1]) / 0.03).astype(int), return_counts=True)
    runs = _runs(keys[counts >= 60])
    candidates = sorted(runs, key=lambda r: -sum(counts[np.isin(keys, r)]))[:MAX_PLANES]
    layers = []
    for run in candidates:
        check()
        flat_on = flat[
            (flat[:, 1] >= base[1] + run[0] * 0.03 - 0.03)
            & (flat[:, 1] <= base[1] + (run[-1] + 1) * 0.03 + 0.03)
        ]
        layers.extend(_plane_layers(flat_on, base, check))
    result = []
    for flat_on in sorted(layers, key=lambda p: -float(np.median(p[:, 1]))):
        check()
        if len(flat_on) < 100:
            continue
        design = np.column_stack([np.ones(len(flat_on)), flat_on[:, [0, 2]] - base[[0, 2]]])
        plane = least_squares(
            lambda v, design=design, heights=flat_on[:, 1]: design @ v - heights,
            np.linalg.lstsq(design, flat_on[:, 1], rcond=None)[0],
            loss="soft_l1",
            f_scale=0.008,
            max_nfev=40,
        ).x
        errors = abs(design @ plane - flat_on[:, 1])
        if np.linalg.norm(plane[1:]) > 0.1 or np.mean(errors < 0.02) < 0.65:
            continue
        flat_on = flat_on[errors < 0.02]
        y = float(plane[0])
        heights = plane[0] + (points[:, [0, 2]] - base[[0, 2]]) @ plane[1:]
        on = points[abs(points[:, 1] - heights) < 0.02]
        if len(on) < 200:
            continue
        on = on[cKDTree(flat_on[:, [0, 2]]).query(on[:, [0, 2]], workers=1)[0] < 0.1]
        connected = _components(on[:, [0, 2]], 0.12, 100)
        if not connected:
            continue
        on = on[max(connected, key=len)]
        xz = on[:, [0, 2]]
        lo, hi = np.percentile(xz, [0.5, 99.5], axis=0)
        xz = xz[np.all((xz >= lo) & (xz <= hi), axis=1)]
        try:
            hull = ConvexHull(xz)
        except QhullError:
            continue
        centre = base + (y - base[1]) / direction[1] * direction
        centre[1] = plane[0] + (centre[[0, 2]] - base[[0, 2]]) @ plane[1:]
        if (
            hull.volume < 0.5
            or max(np.ptp(xz, axis=0)) > 8
            or np.any(hull.equations[:, :2] @ centre[[0, 2]] + hull.equations[:, 2] > -0.1)
        ):
            continue
        # A convex envelope is only retained when the sampled horizontal surface fills it;
        # disconnected crossbars or a partial sector must not acquire a fabricated deck.
        cell = 0.08
        gx, gz = np.meshgrid(
            np.arange(lo[0], hi[0], cell) + cell / 2, np.arange(lo[1], hi[1], cell) + cell / 2
        )
        grid = np.column_stack([gx.ravel(), gz.ravel()])
        inside = np.all(grid @ hull.equations[:, :2].T + hull.equations[:, 2] <= 0, axis=1)
        outside_shaft = (
            np.linalg.norm(grid - centre[[0, 2]], axis=1)
            > float(shaft_r((y - base[1]) / direction[1])) + 0.08
        )
        grid = grid[inside & outside_shaft]
        if len(grid) < 40:
            continue
        distances = cKDTree(xz).query(grid, workers=1)[0]
        coverage = float(np.mean(distances < cell))
        if coverage < 0.8:
            continue
        # Trace occupied surface cells, including outer notches. A convex hull would bridge
        # unsupported recesses and let stray pipe/cap returns enlarge the perimeter.
        step = 0.04
        origin = lo - 0.12
        xx, zz = np.meshgrid(
            np.arange(origin[0], hi[0] + 0.12, step), np.arange(origin[1], hi[1] + 0.12, step)
        )
        samples = np.column_stack([xx.ravel(), zz.ravel()])
        mask = (cKDTree(xz).query(samples, workers=1)[0] < 0.04).reshape(xx.shape)
        mask = ndimage.binary_fill_holes(ndimage.binary_closing(mask))
        labels, _ = ndimage.label(mask)
        occupied = np.bincount(labels.ravel())
        if len(occupied) < 2:
            continue
        # A genuine access slot can connect the shaft opening to the perimeter, so
        # the shaft centre need not be occupied. Keep the connected observed surface;
        # the surrounding-footprint and boundary-support checks still apply.
        mask = labels == (1 + np.argmax(occupied[1:]))
        contours = find_contours(mask.astype(float), 0.5)
        if not contours:
            continue
        contour = max(contours, key=len)[:, ::-1] * step + origin
        polygon = Polygon(contour).simplify(0.04, preserve_topology=True)
        # Noisy grating edges can exceed the transport vertex cap by one or two points.
        # Simplify within the existing 80 mm boundary-support tolerance before rejecting.
        for tolerance in (0.05, 0.06, 0.08):
            if len(polygon.exterior.coords) <= 65:
                break
            polygon = Polygon(contour).simplify(tolerance, preserve_topology=True)
        if not polygon.is_valid or polygon.area < 0.5:
            continue
        outline = np.asarray(polygon.exterior.coords)[:-1]
        if len(outline) > 64:
            continue
        edges = np.concatenate(
            [
                np.linspace(a, b, max(2, int(np.linalg.norm(b - a) / cell)))
                for a, b in zip(outline, np.roll(outline, -1, axis=0), strict=True)
            ]
        )
        edge_distances = cKDTree(xz).query(edges, workers=1)[0]
        if np.mean(edge_distances < 0.08) < 0.95:
            continue
        plane_errors = on[:, 1] - (plane[0] + (on[:, [0, 2]] - base[[0, 2]]) @ plane[1:])
        q = {
            "basis": "measured",
            "support": len(on),
            "residualM": float(np.sqrt(np.mean(plane_errors**2))),
            "coverage": coverage,
        }
        perimeter_q = {
            **q,
            "residualM": float(np.sqrt(np.mean(edge_distances**2))),
            "note": "Source surface boundary fitted on a 40 mm grid; smaller edge detail is unresolved.",
        }
        inferred = {
            "basis": "inferred",
            "note": "Grating thickness, construction and small openings are not resolved.",
        }
        item = Observation(
            _identity("platform", centre, base, sources),
            "platform",
            tuple(centre),
            (float(np.ptp(outline[:, 0])), 0.04, float(np.ptp(outline[:, 1]))),
            0,
            0,
            {
                k: q if k == "centre" else perimeter_q if k in ("width", "depth") else inferred
                for k in ("centre", "width", "height", "depth", "azimuthDeg", "tiltDeg")
            },
            sources,
            name="Source-fitted crown platform",
            notes=[
                "Near-horizontal sampled plane and outer envelope; thickness and unresolved openings remain inferred."
            ],
        ).to_dict()
        item["path"] = [
            [float(x), float(plane[0] + (np.array([x, z]) - base[[0, 2]]) @ plane[1:]), float(z)]
            for x, z in outline
        ]
        # Close co-footprint faces can be the top and underside of one deck. Keep the
        # upper observed surface, not two selectable physical platforms or their average.
        same_deck = next(
            (
                old
                for old in result
                if abs(old["centre"][1] - centre[1]) < 0.18
                and polygon.intersection(Polygon([(p[0], p[2]) for p in old["path"]])).area
                > 0.8 * polygon.area
            ),
            None,
        )
        if same_deck:
            same_deck["notes"].append(
                "Nearby co-footprint horizontal faces may be one deck's underside; layer construction remains unresolved."
            )
            continue
        if any(old["id"] == item["id"] or abs(old["centre"][1] - centre[1]) < 0.035 for old in result):
            continue
        result.append(item)
    return result


def _parents(devices, pipes, points, check):
    parents = {}
    for o in devices:
        check()
        right, _up, front = _axes(o)
        centre, size = np.array(o["centre"]), np.array(o["size"])
        back = centre - front * size[2] / 2
        choices = []
        for p in pipes:
            path = np.array(p["path"])
            lo, hi = path[:, 1].min(), path[:, 1].max()
            overlap = min(hi, centre[1] + size[1] / 2) - max(lo, centre[1] - size[1] / 2)
            if overlap < min(0.4, size[1] / 2):
                continue
            pc = path[0] + (centre[1] - path[0, 1]) / (path[-1, 1] - path[0, 1]) * (path[-1] - path[0])
            delta = pc - back
            if not -0.6 < delta @ front < -0.04 or abs(delta @ right) > max(0.15, size[0] * 0.45):
                continue
            vector = delta[[0, 2]]
            gap = np.linalg.norm(vector)
            q = points[abs(points[:, 1] - centre[1]) < size[1] * 0.55]
            d = q[:, [0, 2]] - back[[0, 2]]
            along = d @ vector / gap
            across = np.linalg.norm(d - np.outer(along, vector / gap), axis=1)
            bridge_start, bridge_end = 0.03, gap - p["size"][0] / 2 - 0.025
            use = (across < 0.065) & (along > bridge_start) & (along < bridge_end)
            bridge = along[use]
            # Short standoffs can have less free space than the full-gap span threshold.
            # Require most of that observable interval, retaining a 20 mm span floor and
            # the existing point-count/geometry gates; a nearby pipe alone is not evidence.
            span = min(0.06, gap * 0.3, max(0.02, 0.8 * (bridge_end - bridge_start)))
            if len(bridge) < 8 or np.ptp(bridge) < span:
                continue
            choices.append((gap, p["id"]))
        choices.sort()
        if choices and (len(choices) == 1 or choices[1][0] - choices[0][0] > 0.08):
            parents[o["id"]] = choices[0][1]
    return parents


def fit_crown_supports(xyz, axis, profile, observations, sources, check=None):
    """Return (new supports, device->pipe associations, warnings) without editing devices."""
    check = check or (lambda: None)
    check()
    prepared = _prepare(xyz, axis, profile, check)
    warnings = [
        "Crown support discovery is partial; hidden pipes, deck openings, clamps and cable construction remain unresolved."
    ]
    if prepared is None:
        return [], {}, [*warnings, "Unsupported axis/profile for crown supports."]
    points, base, direction, shaft_r, cell = prepared
    if cell > 0.015:
        warnings.append(
            "Crown support points were thinned to the discovery limit; narrow supports may be missed."
        )
    devices = [o for o in observations if o["kind"] in ("panel", "rru", "equipment-box")]
    keep = np.ones(len(points), dtype=bool)
    for o in devices:
        check()
        local = (points - o["centre"]) @ _axes(o).T
        keep &= ~np.all(abs(local) <= np.array(o["size"]) / 2 + 0.025, axis=1)
    free = points[keep]
    features, upright, flat = _features(free, base, check)
    check()
    seeds = features[upright]
    clusters = _components(seeds[:, [0, 2]], 0.065, 20)
    clusters.sort(key=lambda idx: (-len(idx), *np.median(seeds[idx], axis=0)))
    if len(clusters) > MAX_PIPE_CANDIDATES:
        warnings.append("Crown pipe candidate limit reached; additional supports require review.")
    tree = cKDTree(free)
    pipes = []
    for idx in clusters[:MAX_PIPE_CANDIDATES]:
        check()
        o = _pipe_observation(seeds[idx], free, tree, base, sources)
        if o and not any(pipe_overlaps(o, p) for p in pipes):
            pipes.append(o)
            if len(pipes) >= MAX_PIPES:
                warnings.append("Crown pipe observation limit reached.")
                break
    platforms = _platforms(free, features[flat], base, direction, shaft_r, sources, check)
    parents = _parents(devices, pipes, points, check)
    if len(parents) < len(devices):
        warnings.append(
            f"{len(devices) - len(parents)} device mount associations are unsupported or ambiguous; their clamps/cables are not completed from geometry alone."
        )
    if not platforms:
        warnings.append("No complete crown platform surface was supported; platforms may be missing.")
    return sorted([*pipes, *platforms], key=lambda o: o["id"]), parents, warnings
