"""Drawing-free monopole equipment, adapted from the shared telecom face/box detector.

The detector modules are reused unchanged from df309328. This adapter owns the bounded cloud
region, deterministic sampling/identities and engineering provenance. It neither reads an old
inventory nor guesses a missing device count. Coordinates stay x-east/y-up/z-south metres.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable

import numpy as np

from ..telecom.boxes import Unit, pair_faces
from ..telecom.faces import VOXEL_M, planar_faces, voxel_down
from .axis import Axis
from .observations import Observation

MAX_POINTS = 300_000
MAX_FACES = 512
MAX_UNITS = 192
MAX_RADIUS_M = 8.0
MAX_BAND_M = 18.0
TOP_MARGIN_M = 4.0
PARTIAL = (
    "Cloud equipment discovery is partial: hidden or sparse devices may be missed. "
    "Check separate parts and uncertain box types against the source photos."
)


def _prepare(xyz, axis, profile, check):
    """Crop before normals/graphs; one deterministic point per voxel, then widen if over cap."""
    base = np.asarray(axis.point, dtype=float)
    direction = np.asarray(axis.dir, dtype=float)
    samples = np.asarray(profile, dtype=float)
    if (
        base.shape != (3,)
        or direction.shape != (3,)
        or not np.isfinite(base).all()
        or not np.isfinite(direction).all()
        or np.linalg.norm(direction) < 0.5
        or samples.ndim != 2
        or samples.shape[1] != 2
        or len(samples) < 2
        or not np.isfinite(samples).all()
    ):
        return None
    direction = direction / np.linalg.norm(direction)
    if direction[1] < 0.9:
        return None
    samples = samples[np.argsort(samples[:, 0], kind="stable")]
    heights, radii = samples.T
    if heights[-1] <= 0 or np.any(radii <= 0) or np.any(np.diff(heights) <= 0):
        return None

    def shaft_r(h):
        return np.interp(h, heights, radii)

    lower = max(0.5 * heights[-1], heights[-1] - MAX_BAND_M)
    upper = heights[-1] + TOP_MARGIN_M
    parts = []
    for start in range(0, len(xyz), 65_536):
        check()
        p = np.asarray(xyz[start : start + 65_536], dtype=float)
        p = p[np.isfinite(p).all(axis=1)]
        rel = p - base
        h = rel @ direction
        radius = np.linalg.norm(rel - np.outer(h, direction), axis=1)
        keep = (h >= lower) & (h <= upper) & (radius <= MAX_RADIUS_M) & (radius > shaft_r(h) + 0.05)
        parts.append(p[keep])
    pts = np.concatenate(parts) if parts else np.empty((0, 3))
    # Sorting before the shared first-point voxel sampler removes dependence on scan order,
    # including duplicated returns. Use an axis-relative origin so a translation preserves it.
    rel = pts - base
    order = np.lexsort((rel[:, 2], rel[:, 1], rel[:, 0]))
    rel = rel[order]
    cell = VOXEL_M
    sampled = voxel_down(rel, cell)
    while len(sampled) > MAX_POINTS:
        check()
        cell *= max(1.15, (len(sampled) / MAX_POINTS) ** 0.5)
        sampled = voxel_down(rel, cell)
    return sampled + base, base, direction, shaft_r, cell


def _observation(unit: Unit, base, sources):
    front = unit.front
    measured = {
        "basis": "measured",
        "residualM": float(front.rms),
        "support": int(front.support),
        "coverage": float(np.clip(front.coverage, 0, 1)),
    }
    if unit.depth_measured:
        depth = {
            **measured,
            "residualM": max(float(f.rms) for f in unit.faces),
            "support": sum(int(f.support) for f in unit.faces),
        }
        centre = depth
    else:
        depth = {
            "basis": "inferred",
            "note": "No independent back face; thickness inferred from side returns.",
        }
        centre = {"basis": "inferred", "note": "Fitted front position; centre depends on inferred thickness."}
    kind = "panel" if unit.kind == "panel" else "equipment-box"
    normal = unit.axes[2]
    azimuth = float(np.degrees(np.arctan2(normal[0], -normal[2]))) % 360
    tilt = float(-np.degrees(np.arcsin(np.clip(normal[1], -1, 1))))
    up = np.array([0.0, 1.0, 0.0]) - normal[1] * normal
    up /= np.linalg.norm(up)
    roll = float(np.degrees(np.arctan2(unit.axes[1] @ np.cross(up, normal), unit.axes[1] @ up)))
    notes = ["Source-fitted box; equipment type needs photo review."] if kind == "equipment-box" else []
    if abs(roll) > 0.5:
        notes.append(
            f"Sideways lean of {roll:.1f} degrees is not represented by this model's azimuth/tilt pose."
        )
    # A source face's coarse location identifies it, not iteration order or an AI label. This is
    # stable for identical/reordered samples; changed scans need explicit spatial re-identification.
    key = [
        sorted((s["kind"], s["ref"]) for s in sources),
        np.round((front.centre - base) / 0.05).astype(int).tolist(),
    ]
    ident = (
        "obs-cloud-device-" + hashlib.sha256(json.dumps(key, separators=(",", ":")).encode()).hexdigest()[:16]
    )
    return Observation(
        ident,
        kind,
        tuple(unit.centre),
        tuple(unit.extents),
        azimuth,
        tilt,
        {
            "centre": centre,
            "width": measured,
            "height": measured,
            "depth": depth,
            "azimuthDeg": measured,
            "tiltDeg": measured,
        },
        list(sources),
        notes=notes or None,
    ).to_dict()


def discover_components(
    xyz: np.ndarray, axis: Axis, profile, sources, check: Callable[[], None] | None = None
):
    """(observations, warnings) from a monopole cloud and its axial height/radius samples."""
    check = check or (lambda: None)
    check()
    prepared = _prepare(xyz, axis, profile, check)
    if prepared is None:
        return [], ["Cloud equipment discovery needs a supported upright axis and shaft profile.", PARTIAL]
    pts, base, direction, shaft_r, cell = prepared
    if len(pts) < 60:
        return [], ["Too few crown points for independent equipment fitting.", PARTIAL]
    warnings = [PARTIAL]
    if cell > VOXEL_M:
        warnings.append("Equipment points were thinned to the discovery limit; small parts may be missed.")
    check()
    faces = planar_faces(pts, base, direction, shaft_r)
    check()
    if len(faces) > MAX_FACES:
        faces = sorted(faces, key=lambda f: (-f.support, *f.centre))[:MAX_FACES]
        warnings.append("Too many face candidates; only the strongest bounded set was fitted.")
    drops = {}
    units = pair_faces(faces, base, pts, shaft_r, drops) if faces else []
    check()
    if drops:
        warnings.append(
            "Cloud candidates excluded: "
            + ", ".join(f"{n} {reason}" for reason, n in sorted(drops.items()))
            + "."
        )
    if any(u.kind == "dish" for u in units):
        warnings.append(
            "Dish candidates were found but are not represented by the equipment observation format."
        )
    found = []
    for unit in sorted(units, key=lambda u: (-u.support, *u.centre)):
        check()
        if unit.kind == "dish":
            continue
        o = _observation(unit, base, sources)
        if any(o["id"] == old["id"] for old in found):
            warnings.append(
                "Overlapping source-face identity was retained only once; review the equipment region."
            )
            continue
        found.append(o)
        if len(found) >= MAX_UNITS:
            warnings.append("Equipment observation limit reached; additional candidates need review.")
            break
    if not found:
        warnings.append("No independently supported equipment boxes were found in the crown region.")
    if any(any("Sideways lean" in note for note in o.get("notes", [])) for o in found):
        warnings.append(
            "Some source equipment has sideways lean that the model's azimuth/tilt pose cannot represent."
        )
    return sorted(found, key=lambda o: o["id"]), warnings
