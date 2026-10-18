"""Bounded source fits for roof surfaces and repeated shaft climbing steps.

Fits operate in the input frame. Construction details (sheet corrugations, bolts and safety
wire) are deliberately not claimed as measured by these geometric observations.
"""

from __future__ import annotations

import numpy as np
from scipy.optimize import least_squares
from scipy.signal import find_peaks
from scipy.spatial import cKDTree

from .observations import Observation


def fit_cap_beacon(xyz, rgb, cap, radius, sources):
    if rgb is None or len(xyz) != len(rgb):
        return []
    cap = np.asarray(cap)
    colours = np.asarray(rgb, dtype=float)
    mask = (xyz[:, 1] > cap[1] - 0.05) & (xyz[:, 1] < cap[1] + 0.4)
    mask &= np.linalg.norm(xyz[:, [0, 2]] - cap[[0, 2]], axis=1) < radius + 0.1
    mask &= (
        (colours[:, 0] > 80) & (colours[:, 0] > 1.25 * colours[:, 1]) & (colours[:, 0] > 1.25 * colours[:, 2])
    )
    points = xyz[mask]
    if len(points) < 20:
        return []
    centre = np.median(points, axis=0)
    points = points[np.linalg.norm(points - centre, axis=1) < 0.15]
    if len(points) < 20:
        return []
    lo, hi = np.percentile(points, [2, 98], axis=0)
    size = hi - lo
    if size.min() < 0.025 or size.max() > 0.3:
        return []
    quality = {
        "basis": "measured",
        "support": len(points),
        "residualM": float(np.median(np.linalg.norm(points - centre, axis=1))),
    }
    q = {k: quality for k in ("centre", "width", "height", "depth")}
    q.update(azimuthDeg={"basis": "inferred"}, tiltDeg={"basis": "inferred"})
    return [
        Observation(
            "obs-cloud-cap-beacon",
            "light",
            tuple((lo + hi) / 2),
            tuple(size),
            0,
            0,
            q,
            sources,
            name="Red cap fixture",
            notes=["Red surface cluster measured at shaft cap; beacon housing shape and function inferred."],
        ).to_dict()
    ]


def fit_roof_panels(xyz, outline):
    corners = np.asarray(outline, dtype=float)
    if len(corners) != 4:
        return None
    origin = corners[0, [0, 2]]
    u = corners[1, [0, 2]] - origin
    v = corners[3, [0, 2]] - origin
    size = np.array([np.linalg.norm(u), np.linalg.norm(v)])
    if size.min() < 0.3:
        return None
    basis = np.array([u / size[0], v / size[1]])
    uv = (xyz[:, [0, 2]] - origin) @ basis.T
    near = ((uv >= 0) & (uv <= size)).all(axis=1)
    near &= abs(xyz[:, 1] - np.mean(corners[:, 1])) < 0.8
    uv, heights = uv[near], xyz[near, 1]
    if len(heights) < 100:
        return None
    # Upper quantiles per occupied cell prevent under-roof equipment dominating the fit.
    _, inverse = np.unique(np.floor(uv / 0.09).astype(int), axis=0, return_inverse=True)
    order = np.argsort(inverse)
    groups = np.split(order, np.flatnonzero(np.diff(inverse[order])) + 1)
    cells = [(uv[g].mean(axis=0), np.percentile(heights[g], 92)) for g in groups if len(g) >= 3]
    if len(cells) < 35:
        return None
    xy = np.array([c[0] for c in cells])
    if np.any(np.ptp(xy, axis=0) < size * 0.7) or len(cells) * 0.09**2 < np.prod(size) * 0.35:
        return None
    y = np.array([c[1] for c in cells])
    plane = np.column_stack([np.ones(len(xy)), xy])

    def solve(a):
        coef = least_squares(
            lambda c: a @ c - y, np.linalg.lstsq(a, y, rcond=None)[0], loss="soft_l1", f_scale=0.02
        ).x
        return coef, float(np.median(abs(a @ coef - y)))

    coef, error = solve(plane)
    best = None
    for k in range(2):
        for fraction in np.linspace(0.3, 0.7, 21):
            ridge = size[k] * fraction
            a = np.column_stack([plane, abs(xy[:, k] - ridge)])
            c, residual = solve(a)
            # A ridge needs two opposing slopes and evidence on both faces.
            if c[3] >= -0.04 or abs(c[k + 1]) >= -c[3] or -c[3] > 0.8:
                continue
            if best is None or residual < best[0]:
                best = residual, k, ridge, c
    gable = best is not None and best[0] < error * 0.65 and error - best[0] > 0.008
    if gable:
        error, k, ridge, coef = best
        j = 1 - k
        rectangles = []
        for a, b in [(0, ridge), (ridge, size[k])]:
            # First edge follows the ridge; corrugations run down the slope.
            q = np.zeros((4, 2))
            q[:, j] = [0, size[j], size[j], 0]
            q[:, k] = [a, a, b, b]
            rectangles.append(q)
    else:
        rectangles = [np.array([[0, 0], [size[0], 0], size, [0, size[1]]])]
    if error > 0.08:
        return None

    def surface(q):
        a = np.column_stack([np.ones(len(q)), q])
        if gable:
            a = np.column_stack([a, abs(q[:, k] - ridge)])
        plan = q @ basis + origin
        return np.column_stack([plan[:, 0], a @ coef, plan[:, 1]]).tolist()

    outer = np.array([[0, 0], [size[0], 0], size, [0, size[1]]])
    return {
        "panels": [surface(q) for q in rectangles],
        "outline": surface(outer),
        "residualM": error,
        "support": len(cells),
    }


def fit_climbing_steps(xyz, base, axis, profile, top, sources):
    base, axis = np.asarray(base), np.asarray(axis)
    if not profile or abs(axis[1]) < 0.9 or top - base[1] < 6:
        return []
    p = xyz[(xyz[:, 1] > base[1] + 0.5) & (xyz[:, 1] < top)]
    centre = base + ((p[:, 1] - base[1]) / axis[1])[:, None] * axis
    delta = p[:, [0, 2]] - centre[:, [0, 2]]
    radius = np.interp(p[:, 1], [s["y"] for s in profile], [s["r"] for s in profile])
    radial = np.linalg.norm(delta, axis=1)
    mask = (radial > radius + 0.035) & (radial < radius + 0.3)
    p, delta, radius = p[mask], delta[mask], radius[mask]
    if len(p) < 100:
        return []
    angles = np.arctan2(delta[:, 0], -delta[:, 1])
    high = p[:, 1] > base[1] + 4
    best = None
    for bearing in np.arange(0, 2 * np.pi, np.pi / 90):
        diff = np.angle(np.exp(1j * (angles - bearing)))
        selected = (abs(diff) < np.pi / 4) & high
        # Reward repetition through height, not dense ground/crown clutter.
        occupied = len(np.unique(np.floor(p[selected, 1] / 0.15)))
        if best is None or occupied > best[0]:
            best = occupied, bearing
    if best[0] < 20:
        return []
    angular = abs(np.angle(np.exp(1j * (angles - best[1])))) < np.pi / 4
    seed = float(np.angle(np.mean(np.exp(1j * angles[angular & high]))))
    # Step bars are approximately tangent to the shaft. Recover their normal by the
    # smallest radial spread, rather than the bearing of the denser visible end.
    candidates = []
    for bearing in np.arange(seed - 0.4, seed + 0.4, 0.01):
        out = np.array([np.sin(bearing), -np.cos(bearing)])
        offsets = delta[angular & high] @ out - radius[angular & high]
        a, b = np.percentile(offsets, [15, 85])
        candidates.append((b - a, bearing))
    bearing = min(candidates)[1]
    angular = abs(np.angle(np.exp(1j * (angles - bearing)))) < np.pi / 4
    out = np.array([np.sin(bearing), -np.cos(bearing)])
    side = np.array([np.cos(bearing), np.sin(bearing)])
    offset = delta @ out - radius
    across = delta @ side
    strip = angular & (offset > 0.015) & (offset < 0.23) & (abs(across) < 0.4)
    p, delta, offset, across = p[strip], delta[strip], offset[strip], across[strip]
    if len(p) < 100:
        return []
    bins = np.arange(base[1] + 0.5, top + 0.025, 0.025)
    hist, _ = np.histogram(p[:, 1], bins=bins)
    peaks, _ = find_peaks(hist, distance=8, prominence=3)
    heights = bins[peaks] + 0.0125
    diffs = np.diff(heights)
    regular = diffs[(diffs > 0.2) & (diffs < 0.45)]
    if len(regular) < 12:
        return []
    spacing = float(np.median(regular))
    good = abs(diffs - spacing) < 0.065
    if np.mean(good) < 0.6:
        return []
    keep = np.r_[good, False] | np.r_[False, good]
    heights = heights[keep]
    if not 15 <= len(heights) <= 256 or np.ptp(heights) < 5:
        return []
    normals = []
    for h in heights:
        q = delta[(abs(p[:, 1] - h) < 0.035) & (p[:, 1] > base[1] + 4)]
        if len(q) < 12:
            continue
        values, vectors = np.linalg.eigh(np.cov(q.T))
        if values[-1] < 0.002 or values[-1] < 8 * values[0]:
            continue
        normal = vectors[:, 0]
        if normal @ out < 0:
            normal = -normal
        normals.append(normal)
    if len(normals) >= 8:
        refined = np.median(normals, axis=0)
        refined /= np.linalg.norm(refined)
        # Partial returns can follow radial mounting legs instead of transverse bars.
        # Refine only within the route's angular window; otherwise retain its global fit.
        if refined @ out >= np.cos(np.pi / 4):
            out = refined
            bearing = np.arctan2(out[0], -out[1])
            side = np.array([np.cos(bearing), np.sin(bearing)])
            across = delta @ side
            offset = delta @ out - np.interp(p[:, 1], [s["y"] for s in profile], [s["r"] for s in profile])
    # Sorted neighbours avoid allocating point-count by step-count distance matrices.
    index = np.searchsorted(heights, p[:, 1])
    residuals = np.minimum(
        abs(p[:, 1] - heights[np.clip(index, 0, len(heights) - 1)]),
        abs(p[:, 1] - heights[np.clip(index - 1, 0, len(heights) - 1)]),
    )
    near_step = residuals < 0.045
    clean = near_step & (p[:, 1] > base[1] + 4) & (offset > 0.015) & (offset < 0.2)
    if np.count_nonzero(clean) < 100:
        return []
    lo, hi = np.percentile(across[clean], [5, 95])
    width = float(hi - lo)
    if not 0.18 < width < 0.7:
        return []
    stand = float(np.median(offset[clean]))
    path = []
    for h in heights:
        close = abs(p[:, 1] - h) < 0.045
        y = float(np.median(p[close, 1]))
        c = base + (y - base[1]) / axis[1] * axis
        r = np.interp(y, [s["y"] for s in profile], [s["r"] for s in profile])
        c[[0, 2]] += (r + stand) * out + (hi + lo) / 2 * side
        path.append(c.tolist())
    measured = {
        "basis": "measured",
        "support": int(near_step.sum()),
        "residualM": float(np.median(residuals[near_step])),
    }
    # A vertical repetition residual alone says nothing about the transverse bar
    # positions. Check the resulting segments against the observed 3D points too.
    side3 = np.array([side[0], 0, side[1]])
    bar_samples = np.asarray(path)[:, None, :] + np.linspace(-width / 2, width / 2, 21)[None, :, None] * side3
    distances = cKDTree(p).query(bar_samples.reshape(-1, 3), workers=1)[0]
    coverage3d = float(np.mean(distances < 0.04))
    note = "3D bar coverage is partial; transverse positions and common bar width are inferred from the repeated route."
    pose_quality = (
        {
            "basis": "measured",
            "support": int(np.count_nonzero(distances < 0.04)),
            "residualM": float(np.median(distances)),
            "coverage": coverage3d,
        }
        if coverage3d >= 0.65
        else {"basis": "inferred", "note": note}
    )
    q = {k: pose_quality for k in ("centre", "width", "azimuthDeg")}
    q["height"] = measured
    q.update(depth={"basis": "inferred"}, tiltDeg={"basis": "inferred"})
    o = Observation(
        "obs-cloud-climbing-steps",
        "climbing-steps",
        tuple(np.mean(path, axis=0)),
        (width, float(path[-1][1] - path[0][1]), 0.025),
        float(np.degrees(bearing) % 360),
        0,
        q,
        sources,
        name="Shaft climbing steps",
        notes=[
            "Repeated step centres fitted from radial protrusions. Bolt section, end stops and safety wire are inferred."
        ]
        + ([note] if coverage3d < 0.65 else []),
    ).to_dict()
    o["path"] = path
    return [o]
