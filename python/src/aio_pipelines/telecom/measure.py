"""Antenna measurements in the app's conventions, and the local to project frame.

Local frame: x east, y up, z south (north is -z). Project frame: E = ox + x, N = oy - z, Z = oz + y,
so local azimuths are grid azimuths. Conventions (spec, "Measurement conventions"):
- azimuth: clockwise from grid north of the outward normal's horizontal part;
- downtilt: angle of the normal below horizontal, positive = beam points down;
- plumb: sideways lean of the long axis in the face plane, positive = top leans right seen from
  the front (the viewer looks along -normal; for a north-facing unit, right is west);
- a dish has azimuth, elevation (positive up) and diameter, no downtilt or plumb.
True azimuth = grid azimuth + convergence (`grid_convergence_deg`).
"""

from __future__ import annotations

import math
from functools import cache
from typing import Any

import numpy as np

from .boxes import Unit

_UP = np.array([0.0, 1.0, 0.0])


def azimuth_deg(n: np.ndarray) -> float:
    """Compass azimuth of a direction's horizontal part, degrees in [0, 360)."""
    return float(math.degrees(math.atan2(float(n[0]), -float(n[2]))) % 360.0)


def downtilt_deg(n: np.ndarray) -> float:
    """Angle of a direction below horizontal, degrees (positive = points down)."""
    n = np.asarray(n, dtype=float) / np.linalg.norm(n)
    return float(-math.degrees(math.asin(max(-1.0, min(1.0, float(n[1]))))))


def plumb_deg(long_axis: np.ndarray, n: np.ndarray) -> float:
    """Sideways lean of `long_axis` from the in-plane vertical, degrees, positive = top leans to
    the right of a viewer looking at the face (along -n). The sign of `long_axis` is ignored."""
    n = np.asarray(n, dtype=float) / np.linalg.norm(n)
    up = _UP - (_UP @ n) * n
    up /= np.linalg.norm(up)
    right = np.cross(up, n)
    a = np.asarray(long_axis, dtype=float)
    if a @ up < 0:
        a = -a
    return float(math.degrees(math.atan2(float(a @ right), float(a @ up))))


@cache
def _to_grid(epsg: int):
    from pyproj import Transformer

    return Transformer.from_crs(4326, epsg, always_xy=True)


def grid_convergence_deg(lon: float, lat: float, epsg: int) -> float:
    """Grid convergence: the angle from true north to grid north, positive when grid north lies
    east of true north. Mirrors `gridConvergenceDeg` in packages/geo/src/crs.ts (same finite
    difference: the grid azimuth of true north is -convergence), so true = grid + convergence."""
    d = 1e-4
    t = _to_grid(int(epsg))
    ax, ay = t.transform(lon, lat - d)
    bx, by = t.transform(lon, lat + d)
    return float(-math.degrees(math.atan2(bx - ax, by - ay)))


def to_project(xyz_local: np.ndarray, origin: tuple[float, float, float]) -> np.ndarray:
    """Local points (x east, y up, z south) to project E, N, Z: E = ox + x, N = oy - z, Z = oz + y."""
    p = np.asarray(xyz_local, dtype=float)
    ox, oy, oz = origin
    return np.stack([ox + p[..., 0], oy - p[..., 2], oz + p[..., 1]], axis=-1)


def from_project(enz: np.ndarray, origin: tuple[float, float, float]) -> np.ndarray:
    """The inverse of `to_project`."""
    p = np.asarray(enz, dtype=float)
    ox, oy, oz = origin
    return np.stack([p[..., 0] - ox, p[..., 2] - oz, oy - p[..., 1]], axis=-1)


def to_project_dir(v_local: np.ndarray) -> np.ndarray:
    """Local directions to project E, N, U (E = x, N = -z, U = y); no origin."""
    v = np.asarray(v_local, dtype=float)
    return np.stack([v[..., 0], -v[..., 2], v[..., 1]], axis=-1) + 0.0


def _angle(v: float) -> float:
    a = round(v, 1)
    return 0.0 if a >= 360.0 else a + 0.0


def _value(value: float, quality: dict[str, Any], digits: int) -> dict[str, Any]:
    return {"value": round(float(value), digits) + 0.0, "basis": quality["basis"], "quality": quality}


def measure_unit(unit: Unit, origin, convergence: float | None) -> dict[str, Any]:
    """The geometry and measurement fields of an `AntennaUnit` (JSON-ready): kind, box in project
    coordinates, support, and each number as {value, basis, quality}. Azimuths are grid azimuths;
    `convergence` (the project's grid convergence, None without a CRS) does not change them, the
    caller stores it beside the unit so true = grid + convergence."""
    del convergence  # grid azimuths are stored; the caller writes convergenceDeg
    front = unit.front
    w, h, d = (float(v) for v in unit.extents)
    out: dict[str, Any] = {
        "kind": unit.kind,
        "box": {
            "centre": [round(float(v), 3) + 0.0 for v in to_project(unit.centre, origin)],
            "axes": [[round(float(c), 6) + 0.0 for c in row] for row in to_project_dir(unit.axes)],
            "extents": [round(w, 3) + 0.0, round(h, 3) + 0.0, round(d, 3) + 0.0],
        },
        "support": int(unit.support),
    }
    q = {
        "basis": "measured",
        "residualM": round(float(front.rms), 4),
        "support": int(front.support),
        "coverage": round(min(1.0, max(0.0, float(front.coverage))), 3),
    }
    if unit.depth_measured:  # front and back planes: the worse residual, both supports
        qd = {
            **q,
            "residualM": round(max(float(f.rms) for f in unit.faces), 4),
            "support": int(sum(f.support for f in unit.faces)),
        }
    else:  # no back face seen: an inferred value carries no residual or support
        qd = {"basis": "inferred"}
    if unit.kind == "dish" and unit.dish is not None:
        axis = np.asarray(unit.dish["axis"], dtype=float)
        qdish = {**q, "residualM": round(float(unit.dish["rms"]), 4)}
        out["azimuthGridDeg"] = _value(_angle(azimuth_deg(axis)), qdish, 1)
        out["elevationDeg"] = _value(-downtilt_deg(axis), qdish, 1)
        out["diameterM"] = _value(unit.dish["diameter"], qdish, 3)
        q = qdish
    elif unit.kind in ("panel", "short"):
        n = unit.axes[2]
        out["azimuthGridDeg"] = _value(_angle(azimuth_deg(n)), q, 1)
        out["downtiltDeg"] = _value(downtilt_deg(n), q, 1)
        out["plumbDeg"] = _value(plumb_deg(unit.axes[1], n), q, 1)
    out["widthM"] = _value(w, q, 3)
    out["heightM"] = _value(h, q, 3)
    out["depthM"] = _value(d, qd, 3)
    return out
