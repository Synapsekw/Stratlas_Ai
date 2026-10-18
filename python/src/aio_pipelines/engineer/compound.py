"""Conservative, site-independent enclosure and roof measurements in the source frame.

Long, perpendicular vertical strips establish a compound frame. Connected upper surfaces give
roof/cabinet footprints; points, not an AI guess, establish their locations. Missing backs and
roof thickness remain inferred. Nothing is rotated in the source cloud.
"""

from __future__ import annotations

import numpy as np
from scipy.signal import find_peaks

from .hardware import fit_roof_panels
from .observations import Observation


def _frame(points, base):
    p = points[(points[:, 1] > base[1] + 0.65) & (points[:, 1] < base[1] + 1.9)]
    if len(p) < 500:
        return None
    # Bounded deterministic sample; count occupied cells along a line, not point density.
    p = p[:: max(1, len(p) // 40000), :][:, [0, 2]]
    best = None
    for theta in np.arange(0, np.pi / 2, np.pi / 360):
        r = np.array([[np.cos(theta), -np.sin(theta)], [np.sin(theta), np.cos(theta)]])
        uv = p @ r
        peaks, score = [], 0
        for k in range(2):
            cells = np.unique(np.floor(uv / 0.06).astype(int), axis=0)
            idx, counts = np.unique(cells[:, k], return_counts=True)
            hist = np.zeros(idx.max() - idx.min() + 1)
            hist[idx - idx.min()] = counts
            smooth = np.convolve(hist, np.ones(3), "same")
            candidates, _ = find_peaks(smooth, distance=30, prominence=15)
            choices = sorted(candidates, key=lambda j: smooth[j], reverse=True)[:8]
            pairs = [(a, b) for a in choices for b in choices if b > a and 3 < (b - a) * 0.06 < 20]
            if not pairs:
                break
            centre = np.array(base)[[0, 2]] @ r
            pairs = [(a, b) for a, b in pairs if (idx.min() + a) * 0.06 < centre[k] < (idx.min() + b) * 0.06]
            if not pairs:
                break
            a, b = max(pairs, key=lambda ab: min(smooth[ab[0]], smooth[ab[1]]))
            peaks.append(((idx.min() + a + 0.5) * 0.06, (idx.min() + b + 0.5) * 0.06))
            score += min(smooth[a], smooth[b])
        if len(peaks) == 2 and (best is None or score > best[0]):
            best = score, r, peaks
    if best is None:
        return None
    _, r, bounds = best
    uv = p @ r
    edges = []
    for k in range(2):
        refined = []
        for c in bounds[k]:
            strip = uv[abs(uv[:, k] - c) < 0.12]
            if len(strip) < 100 or np.ptp(strip[:, 1 - k]) < 3:
                return None
            refined.append(float(np.median(strip[:, k])))
        edges.append(refined)
    return r, np.array(edges)


def fit_compound(xyz, base, sources):
    low = xyz[(xyz[:, 1] > base[1] + 0.3) & (xyz[:, 1] < base[1] + 4.5)]
    found = _frame(low, base)
    if found is None:
        return []
    r, edges = found
    uv = low[:, [0, 2]] @ r
    near = np.minimum(abs(uv - edges[:, 0]), abs(uv - edges[:, 1]))
    fence_points = low[(near.min(axis=1) < 0.07) & (low[:, 1] < base[1] + 3)]
    top = float(np.percentile(fence_points[:, 1], 97))
    height = top - base[1]
    corners = (
        np.array(
            [
                [edges[0, 0], edges[1, 0]],
                [edges[0, 1], edges[1, 0]],
                [edges[0, 1], edges[1, 1]],
                [edges[0, 0], edges[1, 1]],
            ]
        )
        @ r.T
    )
    path = [[float(x), float(base[1]), float(z)] for x, z in [*corners, corners[0]]]
    measured = {
        "basis": "measured",
        "support": len(fence_points),
        "residualM": float(np.median(near.min(axis=1)[near.min(axis=1) < 0.07])),
    }
    inferred = {"basis": "inferred"}
    q = {k: measured for k in ("centre", "width", "height", "depth", "azimuthDeg", "tiltDeg")}
    fence = Observation(
        "obs-cloud-enclosure",
        "fence",
        tuple(np.mean(path[:-1], axis=0)),
        (float(np.ptp(corners[:, 0])), height, float(np.ptp(corners[:, 1]))),
        0,
        0,
        q,
        sources,
        name="Compound enclosure",
        notes=[
            "Straight enclosure outline fitted to vertical strips; gate and individual picket spacing need visual review."
        ],
    ).to_dict()
    fence["path"] = path
    result = [fence]
    inside = ((uv > edges[:, 0] + 0.18) & (uv < edges[:, 1] - 0.18)).all(axis=1)
    p, uv = low[inside], uv[inside]
    if len(p) < 100:
        return result
    cell = 0.07
    keys, inv = np.unique(np.floor(uv / cell).astype(int), axis=0, return_inverse=True)
    inv = inv.reshape(-1)
    top_y = np.full(len(keys), -np.inf)
    np.maximum.at(top_y, inv, p[:, 1])
    lookup = {tuple(key): i for i, key in enumerate(keys)}
    visited = set()
    groups = []
    for start in range(len(keys)):
        if start in visited:
            continue
        visited.add(start)
        stack = [start]
        group = []
        while stack:
            i = stack.pop()
            group.append(i)
            for delta in ((0, 1), (0, -1), (1, 0), (-1, 0)):
                j = lookup.get(tuple(keys[i] + delta))
                if j is not None and j not in visited and abs(top_y[j] - top_y[i]) < 0.13:
                    visited.add(j)
                    stack.append(j)
        if len(group) >= 35:
            groups.append(np.array(group))
    roofs = []
    for group in groups:
        xy = (keys[group] + 0.5) * cell
        lo, hi = np.percentile(xy, [1, 99], axis=0)
        size = hi - lo
        coverage = len(group) * cell * cell / max(np.prod(size), 0.001)
        if size.min() < 0.3 or size.max() > 10 or coverage < 0.65:
            continue
        a = np.column_stack([xy, np.ones(len(xy))])
        y = top_y[group]
        coef = np.linalg.lstsq(a, y, rcond=None)[0]
        residual = float(np.median(abs(a @ coef - y)))
        if residual > 0.15 or np.linalg.norm(coef[:2]) > 0.4:
            continue
        centre = (lo + hi) / 2
        cy = float(np.append(centre, 1) @ coef)
        canopy = np.prod(size) > 2.5 and cy - base[1] > 2
        # Exclude the mast/ladder and cropped vertical services. Ground equipment cannot be
        # taller than three metres on the evidence of a small upper patch alone.
        if not canopy and cy - base[1] > 3:
            continue
        corners = np.array([[lo[0], lo[1]], [hi[0], lo[1]], [hi[0], hi[1]], [lo[0], hi[1]]])
        c = centre @ r.T
        roofs.append(
            (centre[0], centre[1], canopy, c, cy, size, corners, coef, residual, coverage, len(group))
        )
    for i, (_, _, canopy, c, cy, size, corners, coef, residual, coverage, count) in enumerate(
        sorted(roofs, key=lambda v: v[:2])
    ):
        kind = "canopy" if canopy else "cabinet"
        h = 0.06 if canopy else cy - base[1] - 0.1
        if h <= 0.1 and not canopy:
            continue
        quality = {
            "basis": "measured",
            "support": count,
            "residualM": residual,
            "coverage": min(1.0, coverage),
        }
        q = {k: quality for k in ("centre", "width", "height", "depth", "azimuthDeg", "tiltDeg")}
        if canopy:
            q["height"] = inferred
        else:
            q["height"] = {
                "basis": "inferred",
                "note": "Top and footprint observed; bottom inferred above local ground.",
            }
        az = float(np.degrees(np.arctan2(-r[0, 1], r[1, 1])) % 360)
        o = Observation(
            f"obs-cloud-ground-{i + 1:02d}",
            kind,
            (float(c[0]), cy if canopy else cy - h / 2, float(c[1])),
            (float(size[0]), h, float(size[1])),
            az,
            0,
            q,
            sources,
            name=f"{'Shelter roof' if canopy else 'Ground cabinet'} {i + 1}",
        ).to_dict()
        if canopy:
            plan = corners @ r.T
            ys = np.column_stack([corners, np.ones(4)]) @ coef
            o["path"] = [[float(x), float(y), float(z)] for (x, z), y in zip(plan, ys, strict=True)]
            fit = fit_roof_panels(xyz, o["path"])
            if fit:
                o["surfaces"] = fit["panels"]
                o["path"] = fit["outline"]
                # Copy: quality entries may share the same dict in the initial coarse fit.
                o["quality"]["centre"] = {**quality, "residualM": fit["residualM"], "support": fit["support"]}
        result.append(o)
    return result
