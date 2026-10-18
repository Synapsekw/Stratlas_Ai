"""Register drawing geometry against the scan, then fit each device independently.

The scan is never rescaled or rotated. The drawing is a search prior, and every unsupported
dimension keeps its drawing/observed basis instead of acquiring a fabricated fit residual.
"""

from __future__ import annotations

import math
from collections.abc import Callable

import numpy as np
from scipy.optimize import least_squares
from scipy.spatial import cKDTree

from .drawings import DrawingDevice, DrawingInventory
from .observations import Observation


def directions(azimuth_deg):
    a = math.radians(azimuth_deg)
    return np.array([math.cos(a), 0, math.sin(a)]), np.array([math.sin(a), 0, -math.cos(a)])


def placed_device(d: DrawingDevice, transform):
    """Similarity in plan only: [scale, clockwise radians, x, z, drawing-zero local y]."""
    scale, angle, x, z, y = transform
    e, n = d.centre_en
    c, s = math.cos(angle), math.sin(angle)
    centre = [x + scale * (e * c + n * s), y + d.bottom + d.size[1] / 2, z + scale * (e * s - n * c)]
    return (
        centre,
        [d.size[0] * scale, d.size[1], d.size[2] * scale],
        (d.azimuth_deg + math.degrees(angle)) % 360,
    )


def _samples(devices):
    points = []
    for d in devices:
        centre, size, az = placed_device(d, [1, 0, 0, 0, 0])
        right, front = directions(az)
        xx, yy = np.meshgrid(np.linspace(-0.49, 0.49, 5) * size[0], np.linspace(-0.5, 0.5, 9) * size[1])
        points.append(
            centre + xx.ravel()[:, None] * right + yy.ravel()[:, None] * [0, 1, 0] + size[2] / 2 * front
        )
    return np.concatenate(points)


def _mapped(points, v):
    scale, angle, x, z, y = v
    c, s = math.cos(angle), math.sin(angle)
    out = points.copy()
    out[:, 0] = scale * (points[:, 0] * c - points[:, 2] * s) + x
    out[:, 2] = scale * (points[:, 0] * s + points[:, 2] * c) + z
    out[:, 1] += y
    return out


def register_drawing(
    xyz: np.ndarray, drawing: DrawingInventory, axis_point, check: Callable[[], None] | None = None
) -> list[float] | None:
    """Bounded multi-start surface registration; reject absent or rotationally ambiguous support."""
    if len(drawing.devices) < 3 or len(xyz) < 100:
        return None
    samples = _samples(drawing.devices)
    base = np.asarray(axis_point)
    span = max(2.5, float(np.ptp(samples[:, 1])) * 0.4)
    sel = (xyz[:, 1] > samples[:, 1].min() + base[1] - span - 1) & (
        xyz[:, 1] < samples[:, 1].max() + base[1] + span + 1
    )
    nearby = xyz[sel]
    if len(nearby) < 100:
        return None
    _, indices = np.unique(np.floor(nearby / 0.025).astype(np.int32), axis=0, return_index=True)
    nearby = nearby[indices]
    tree = cKDTree(nearby)

    def residual(v):
        return np.minimum(tree.query(_mapped(samples, v), workers=1)[0], 0.5)

    candidates = []
    for angle in np.arange(0, 2 * math.pi, math.pi / 12):
        if check:
            check()
        scales = []
        for scale in (0.95, 1.0, 1.05):
            best = None
            for y in np.arange(base[1] - span, base[1] + span + 0.01, 0.15):
                v = [scale, angle, base[0], base[2], y]
                score = float(np.mean(residual(v) ** 2))
                if best is None or score < best[0]:
                    best = (score, v)
            scales.append(best)
        candidates.append(scales)
    # Rear surfaces can make one coarse scale look best while trapping its refinement.
    # Keep all three scale starts for each of the four strongest headings (at most 12 fits).
    starts = [
        start
        for group in sorted(candidates, key=lambda group: min(p[0] for p in group))[:4]
        for start in group
    ]
    refined = []
    for _, v in starts:
        if check:
            check()
        low = [0.85, v[1] - math.pi / 10, base[0] - 0.8, base[2] - 0.8, base[1] - span - 0.2]
        high = [1.15, v[1] + math.pi / 10, base[0] + 0.8, base[2] + 0.8, base[1] + span + 0.2]
        fit = least_squares(
            residual, v, bounds=(low, high), loss="soft_l1", f_scale=0.035, max_nfev=90, diff_step=1e-4
        )
        distances = residual(fit.x)
        refined.append((float(np.mean(np.minimum(distances, 0.2) ** 2)), fit.x, distances))
    refined.sort(key=lambda p: p[0])
    score, best, distances = refined[0]
    if np.percentile(distances, 70) > 0.12:
        return None
    for other, v, _ in refined[1:]:
        da = abs((v[1] - best[1] + math.pi) % (2 * math.pi) - math.pi)
        if da > math.radians(12) and other < score * 1.08:
            return None
    best[1] %= 2 * math.pi
    return best.tolist()


def fit_device(xyz, ident, kind, centre, size, azimuth_deg, sources, parent=None, name=None):
    centre = np.asarray(centre, dtype=float)
    w, h, depth = size
    right, front = directions(azimuth_deg)
    up = np.array([0.0, 1.0, 0.0])
    delta = xyz - centre
    xx, yy, dd = delta @ right, delta[:, 1], delta @ front
    use = (
        (abs(xx) < w / 2 + 0.12)
        & (abs(yy) < h / 2 + 0.16)
        & (dd > depth / 2 - 0.16)
        & (dd < depth / 2 + 0.18)
    )
    subset = xyz[use]
    if len(subset) < 40:
        return None
    xx, yy, dd = xx[use], yy[use], dd[use]
    counts, edges = np.histogram(dd, bins=np.arange(depth / 2 - 0.16, depth / 2 + 0.187, 0.006))
    peak = int(np.argmax(np.convolve(counts, np.ones(5), mode="same")))
    level = (edges[peak] + edges[peak + 1]) / 2
    inliers = abs(dd - level) < 0.025
    plane = np.array([0.0, 0.0, level])
    for _ in range(3):
        if inliers.sum() < 40:
            return None
        plane = least_squares(
            lambda v, selected=inliers: xx[selected] * v[0] + yy[selected] * v[1] + v[2] - dd[selected],
            plane,
            loss="soft_l1",
            f_scale=0.006,
            max_nfev=60,
        ).x
        inliers = abs(xx * plane[0] + yy * plane[1] + plane[2] - dd) < 0.018
    if inliers.sum() < 40:
        return None
    normal = front - plane[0] * right - plane[1] * up
    normal /= np.linalg.norm(normal)
    r = np.cross(normal, up)
    r /= np.linalg.norm(r)
    u = np.cross(r, normal)
    face = subset[inliers] - centre
    sx, sy, sd = face @ r, face @ u, face @ normal
    lo_x, hi_x = np.percentile(sx, [1, 99])
    lo_y, hi_y = np.percentile(sy, [1, 99])
    face_offset = float(np.median(sd))
    residual = float(np.sqrt(np.mean((sd - face_offset) ** 2)))
    # Face-bin occupancy discloses uneven/partial coverage, rather than calling every plane complete.
    bins = np.clip(
        np.column_stack([(sx - lo_x) / (hi_x - lo_x), (sy - lo_y) / (hi_y - lo_y)]) * 10, 0, 9
    ).astype(int)
    coverage = len(np.unique(bins, axis=0)) / 100
    measured = {
        "basis": "measured",
        "support": int(inliers.sum()),
        "residualM": residual,
        "coverage": coverage,
    }
    prior = {"basis": "observed", "note": "Drawing depth; rear face not independently measured."}
    width_quality = height_quality = measured
    if not 0.75 * w < hi_x - lo_x < 1.3 * w:
        lo_x, hi_x = -w / 2, w / 2
        width_quality = {
            "basis": "observed",
            "note": "Drawing width; visible face extent is incomplete or contaminated.",
        }
    if not 0.72 * h < hi_y - lo_y < 1.25 * h:
        lo_y, hi_y = -h / 2, h / 2
        height_quality = {
            "basis": "observed",
            "note": "Drawing height; visible face extent is incomplete or contaminated.",
        }
    fitted = centre + r * (lo_x + hi_x) / 2 + u * (lo_y + hi_y) / 2 + normal * (face_offset - depth / 2)
    quality = {
        "centre": {"basis": "observed", "note": "Front face fitted; centre uses drawing depth."},
        "width": width_quality,
        "height": height_quality,
        "depth": prior,
        "azimuthDeg": measured,
        "tiltDeg": measured,
    }
    az = math.degrees(math.atan2(normal[0], -normal[2])) % 360
    tilt = -math.degrees(math.asin(float(normal[1])))
    return Observation(
        ident,
        kind,
        tuple(fitted),
        (float(hi_x - lo_x), float(hi_y - lo_y), float(depth)),
        az,
        tilt,
        quality,
        sources,
        name=name,
        parent=parent,
    )


def fit_pipes(xyz, drawing, transform, source_ref, check=None):
    """Independent cylinder slices refine the plan registration and retain each pipe's lean."""
    v = np.asarray(transform)
    bottom = drawing.levels.get("bottom of mount pipes", min(d.bottom for d in drawing.devices)) + v[4]
    top = drawing.levels.get("top of mount pipes", max(d.bottom + d.size[1] for d in drawing.devices)) + v[4]
    mid = (bottom + top) / 2
    results = []
    for pipe in drawing.pipes:
        if check:
            check()
        e, n = pipe.centre_en
        guess = _mapped(np.array([[e, 0, -n]]), v)[0, [0, 2]]
        rows = []
        for y in np.linspace(bottom + 0.25, top - 0.15, 10):
            sl = xyz[(abs(xyz[:, 1] - y) < 0.06), :][:, [0, 2]]
            sl = sl[np.linalg.norm(sl - guess, axis=1) < 0.2]
            if len(sl) < 25:
                continue
            rad = pipe.radius * v[0]
            fit = least_squares(
                lambda c, points=sl: np.linalg.norm(points - c[:2], axis=1) - c[2],
                [*guess, rad],
                bounds=([*(guess - 0.14), rad * 0.65], [*(guess + 0.14), rad * 1.3]),
                loss="soft_l1",
                f_scale=0.006,
                max_nfev=60,
            )
            error = abs(np.linalg.norm(sl - fit.x[:2], axis=1) - fit.x[2])
            on = sl[error < 0.012]
            if len(on) < 25:
                continue
            angles = np.arctan2(on[:, 1] - fit.x[1], on[:, 0] - fit.x[0])
            cov = len(np.unique(np.floor((angles + math.pi) * 24 / (2 * math.pi)).astype(int) % 24)) / 24
            if cov < 0.5:
                continue
            rows.append((y, *fit.x, len(on), float(np.sqrt(np.mean(error[error < 0.012] ** 2))), cov))
        if len(rows) < 3:
            continue
        rows = np.array(rows)
        line = np.polyfit(rows[:, 0], rows[:, 1:3], 1)
        radii = rows[:, 3]
        results.append((pipe, line, float(np.median(radii)), rows))
    if len(results) >= 4:
        src = np.array([[p.centre_en[0], 0, -p.centre_en[1]] for p, _, _, _ in results])
        target = np.array([line[0] * mid + line[1] for _, line, _, _ in results])

        def residual(q):
            return (_mapped(src, [*q, v[4]])[:, [0, 2]] - target).ravel()

        fit = least_squares(
            residual,
            v[:4],
            loss="soft_l1",
            f_scale=0.012,
            bounds=([0.85, v[1] - 0.15, v[2] - 0.2, v[3] - 0.2], [1.15, v[1] + 0.15, v[2] + 0.2, v[3] + 0.2]),
        )
        if float(np.sqrt(np.mean(residual(fit.x) ** 2))) < 0.05:
            v[:4] = fit.x
    observations = []
    for pipe, line, radius, rows in results:
        around = xyz[(xyz[:, 1] > bottom - 0.5) & (xyz[:, 1] < top + 0.5)]
        centres = around[:, 1, None] * line[0] + line[1]
        delta = abs(np.linalg.norm(around[:, [0, 2]] - centres, axis=1) - radius)
        hits = around[delta < 0.014]
        if len(hits) < 80:
            continue
        counts, edges = np.histogram(hits[:, 1], bins=np.arange(bottom - 0.5, top + 0.551, 0.05))
        active = np.flatnonzero(counts >= max(5, float(np.median(counts[counts > 0])) * 0.25))
        if len(active) < 5:
            continue
        lo, hi = float(edges[active[0]]), float(edges[active[-1] + 1])
        path = [[*(line[0] * y + line[1]), y] for y in (lo, hi)]
        path = [[x, y, z] for x, z, y in path]
        centre = np.mean(path, axis=0)
        q = {
            "basis": "measured",
            "support": len(hits),
            "residualM": float(np.mean(rows[:, 5])),
            "coverage": float(np.mean(rows[:, 6])),
        }
        quality = {key: q for key in ("centre", "width", "height", "depth", "azimuthDeg", "tiltDeg")}
        o = Observation(
            f"obs-{source_ref}-{pipe.label.lower()}",
            "mounting-pipe",
            tuple(centre),
            (2 * radius, hi - lo, 2 * radius),
            0,
            0,
            quality,
            [{"kind": "drawing", "ref": f"{source_ref}:{pipe.handle}"}],
            name=pipe.label,
        )
        d = o.to_dict()
        d["path"] = path
        observations.append(d)
    return v.tolist(), observations


def fit_drawing_components(xyz, drawing, axis_point, source_ref, cloud_refs, check=None):
    transform = register_drawing(xyz, drawing, axis_point, check)
    if transform is None:
        return (
            [],
            ["Drawing registration is unsupported or ambiguous; equipment requires alignment review."],
            None,
        )
    transform, pipes = fit_pipes(xyz, drawing, transform, source_ref, check)
    found = {p["name"]: p["id"] for p in pipes}
    observations = pipes[:]
    warnings = []
    for device in drawing.devices:
        if check:
            check()
        centre, size, az = placed_device(device, transform)
        sources = [*cloud_refs, {"kind": "drawing", "ref": f"{source_ref}:{device.handle}"}]
        ident = f"obs-{source_ref}-{device.label.lower()}"
        o = fit_device(
            xyz,
            ident,
            device.kind,
            centre,
            size,
            az,
            sources,
            parent=found.get(device.parent),
            name=device.label,
        )
        if o is None:
            # A documented device is retained, with the failure visible in its field provenance.
            q = {"basis": "observed", "note": "Registered drawing only; no reliable face fit."}
            o = Observation(
                ident,
                device.kind,
                tuple(centre),
                tuple(size),
                az,
                0,
                {k: q for k in ("centre", "width", "height", "depth", "azimuthDeg", "tiltDeg")},
                sources,
                name=device.label,
                parent=found.get(device.parent),
            )
            warnings.append(f"{device.label}: insufficient cloud support; drawing dimensions require review.")
        observations.append(o.to_dict())
    for p in pipes:
        p["sources"] = [*cloud_refs, *p["sources"]]
    if drawing.platforms:
        outline = max(drawing.platforms, key=len)
        points = np.array([[x, 0, -n] for x, n in outline])
        points = _mapped(points, transform)
        cx, cz = transform[2:4]
        radius = float(np.max(np.linalg.norm(points[:, [0, 2]] - [cx, cz], axis=1)))
        radial = np.linalg.norm(xyz[:, [0, 2]] - [cx, cz], axis=1)
        for label, level in drawing.levels.items():
            if "platform" not in label:
                continue
            y = level + transform[4]
            near = xyz[(abs(xyz[:, 1] - y) < 0.25) & (radial < radius) & (radial > radius * 0.4)]
            if len(near) < 60:
                warnings.append(f"{label}: insufficient cloud support for the platform level.")
                continue
            counts, edges = np.histogram(near[:, 1], bins=np.arange(y - 0.25, y + 0.261, 0.01))
            peak = int(np.argmax(np.convolve(counts, np.ones(3), mode="same")))
            plane = (edges[peak] + edges[peak + 1]) / 2
            on = near[abs(near[:, 1] - plane) < 0.02]
            plane = float(np.median(on[:, 1]))
            q = {
                "basis": "measured",
                "support": len(on),
                "residualM": float(np.std(on[:, 1])),
                "coverage": min(1, len(on) / 1000),
            }
            prior = {"basis": "observed", "note": "Registered platform outline from drawing."}
            thickness = {"basis": "inferred", "note": "Grating thickness is not resolved by this scan."}
            item = Observation(
                f"obs-{source_ref}-{label.replace(' ', '-')}",
                "platform",
                (cx, plane, cz),
                (2 * radius, 0.04, 2 * radius),
                math.degrees(transform[1]) % 360,
                0,
                {
                    "centre": q,
                    "width": prior,
                    "height": thickness,
                    "depth": prior,
                    "azimuthDeg": prior,
                    "tiltDeg": prior,
                },
                [*cloud_refs, {"kind": "drawing", "ref": source_ref}],
                name=label.title(),
            ).to_dict()
            item["path"] = [[float(p[0]), plane, float(p[2])] for p in points]
            observations.append(item)
    return observations, warnings, transform
