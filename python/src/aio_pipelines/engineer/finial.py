"""Observed narrow terminal rods above a crowded crown; no assumed tower height or site position."""

import numpy as np
from scipy.spatial import cKDTree

from .observations import Observation


def fit_auxiliary_rods(xyz, observations, sources, check=None):
    """Trace narrow rods protruding above the measured device envelope, excluding known pipes.

    Only the continuously supported segment is retained; no hidden extension is invented.
    """
    from .members import _components

    devices = [o for o in observations if o["kind"] in ("panel", "rru")]
    pipes = [o for o in observations if o["kind"] == "mounting-pipe"]
    if not devices or not pipes:
        return []
    ceiling = max(o["centre"][1] + o["size"][1] / 2 for o in devices) + 0.03
    points = xyz[xyz[:, 1] > ceiling]
    if len(points) < 20:
        return []
    clusters = _components(points[:, [0, 2]], 0.08, 12)
    if len(clusters) > 64:
        return []  # Ambiguous crowded crown; do not invent an unbounded rod inventory.
    crown = xyz[xyz[:, 1] > ceiling - 3]
    tree = cKDTree(crown[:, [0, 2]])
    results = []
    for indices in clusters:
        if check:
            check()
        seed = points[indices]
        if np.ptp(seed[:, 1]) < 0.18 or np.max(np.ptp(seed[:, [0, 2]], axis=0)) > 0.13:
            continue
        centre = np.median(seed[:, [0, 2]], axis=0)
        seed_point = np.median(seed, axis=0)
        known = False
        for o in pipes:
            c = np.array(o["centre"])
            half_height = np.array([0, o["size"][1] / 2, 0])
            path = np.array(o.get("path", [c - half_height, c + half_height]))
            starts, directions = path[:-1], np.diff(path, axis=0)
            lengths2 = np.einsum("ij,ij->i", directions, directions)
            t = np.clip(
                np.einsum("ij,ij->i", seed_point - starts, directions) / np.maximum(lengths2, 1e-12), 0, 1
            )
            distances = np.linalg.norm(seed_point - starts - t[:, None] * directions, axis=1)
            if len(distances) and distances.min() < max(o["size"][0] / 2 + 0.08, 0.15):
                known = True
                break
        if known:
            continue
        top = float(seed[:, 1].max())
        nearby = crown[tree.query_ball_point(centre, 0.15)]
        nearby = nearby[nearby[:, 1] > top - 3]
        path, used, gaps = [], [], 0
        for y in np.arange(top - 0.04, top - 3, -0.1):
            q = nearby[
                (abs(nearby[:, 1] - y) < 0.06) & (np.linalg.norm(nearby[:, [0, 2]] - centre, axis=1) < 0.085)
            ]
            if len(q) < 3:
                gaps += 1
                if gaps > 1:
                    break
                continue
            c = np.median(q, axis=0)
            if np.percentile(np.linalg.norm(q[:, [0, 2]] - c[[0, 2]], axis=1), 80) > 0.065:
                break
            gaps = 0
            path.append(c)
            used.append(q)
            centre = c[[0, 2]]
        if len(path) < 5:
            continue
        path, support = np.array(path[::-1]), np.concatenate(used)
        coef = np.polyfit(path[:, 1], path[:, [0, 2]], 1)
        if np.linalg.norm(coef[0]) > 0.15:
            continue
        radial = np.linalg.norm(support[:, [0, 2]] - (support[:, 1, None] * coef[0] + coef[1]), axis=1)
        diameter = float(2 * np.median(radial))
        if not 0.015 < diameter < 0.12 or np.std(radial) > 0.03:
            continue
        lo, hi = np.percentile(support[:, 1], [2, 98])
        if hi - lo < 0.35:
            continue
        route = np.array([[*(y * coef[0] + coef[1]), y] for y in (lo, hi)])[:, [0, 2, 1]]
        quality = {"basis": "measured", "support": len(support), "residualM": float(np.std(radial))}
        o = Observation(
            f"obs-cloud-aux-rod-{len(results) + 1:02d}",
            "mounting-pipe",
            tuple(route.mean(axis=0)),
            (diameter, float(hi - lo), diameter),
            0,
            0,
            {
                k: quality if k in ("centre", "width", "height", "depth") else {"basis": "inferred"}
                for k in ("centre", "width", "height", "depth", "azimuthDeg", "tiltDeg")
            },
            sources,
            name=f"Auxiliary crown rod {len(results) + 1}",
            notes=[
                "Continuous narrow surface above the device envelope; electrical function and hidden extension are not identified."
            ],
        ).to_dict()
        o["path"] = route.tolist()
        results.append(o)
    return results


def fit_finial(xyz, sources):
    if len(xyz) < 100:
        return []
    top = float(xyz[:, 1].max())
    span = float(np.ptp(xyz[:, 1]))
    if span < 8:
        return []
    highest = xyz[xyz[:, 1] > top - 0.35]
    if len(highest) < 12:
        return []
    centre = np.median(highest[:, [0, 2]], axis=0)
    nearby = xyz[
        (xyz[:, 1] > top - min(3, span * 0.09)) & (np.linalg.norm(xyz[:, [0, 2]] - centre, axis=1) < 0.5)
    ]
    path, used = [], []
    tracked = centre
    gaps = 0
    for y in np.arange(top - 0.05, top - min(3, span * 0.09), -0.1):
        points = nearby[
            (abs(nearby[:, 1] - y) <= 0.065) & (np.linalg.norm(nearby[:, [0, 2]] - tracked, axis=1) < 0.12)
        ]
        if len(points) < 2:
            gaps += 1
            if path and gaps > 2:
                break
            continue
        gaps = 0
        c = np.median(points, axis=0)
        radial = np.linalg.norm(points[:, [0, 2]] - c[[0, 2]], axis=1)
        if np.percentile(radial, 75) > 0.075:
            break
        path.append(c)
        used.append(points)
        tracked = c[[0, 2]]
    if len(path) < 6:
        return []
    path = np.array(path[::-1])
    points = np.concatenate(used)
    path[-1, 1] = np.percentile(used[0][:, 1], 98)
    path[0, 1] = np.percentile(used[-1][:, 1], 2)
    coef = np.polyfit(path[:, 1], path[:, [0, 2]], 1)
    radial = np.linalg.norm(points[:, [0, 2]] - (points[:, 1, None] * coef[0] + coef[1]), axis=1)
    diameter = float(np.clip(2 * np.median(radial), 0.012, 0.12))
    q = {"basis": "measured", "support": len(points), "residualM": float(np.std(radial)), "coverage": 1}
    inferred = {"basis": "inferred", "note": "Narrow terminal rod; electrical function is not identified."}
    result = Observation(
        "obs-cloud-terminal-rod",
        "mounting-pipe",
        tuple(path.mean(axis=0)),
        (diameter, float(np.ptp(path[:, 1])), diameter),
        0,
        0,
        {
            k: q if k in ("centre", "width", "height", "depth") else inferred
            for k in ("centre", "width", "height", "depth", "azimuthDeg", "tiltDeg")
        },
        sources,
        name="Terminal rod",
    ).to_dict()
    result["path"] = path.tolist()
    return [result]
