"""Measuring an antenna a person flagged: the cloud points they drew a polygon around, measured
the way detection measures a unit (`faces.planar_faces`, `boxes.pair_faces`, `measure.measure_unit`).

The points are in the local frame (x east, y up, z south; `measure.to_project`). The person chose
the points, so nothing is dropped as the shaft (only points within 5 cm of the axis line go) and a
box `pair_faces` would leave out as implausible is still measured from its best face.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from ..pointcloud_cleanup.evaluate import in_polygon
from .boxes import classify, pair_faces, unit_from_faces
from .faces import planar_faces
from .measure import measure_unit, to_project

FLAG_MIN_POINTS = 60  # below it no measuring is tried (a face needs as many: MIN_FACE_POINTS_SPARSE)
PLACEHOLDER_M = 0.2  # the cube a flag that could not be measured is drawn as


def select_points(xyz: np.ndarray, polygon: list[list[float]], view_proj: list[float]) -> np.ndarray:
    """Which points (bool mask) project inside `polygon` (NDC x, y) through `view_proj` (a
    column-major 4 x 4 view-projection, as `pointcloud_cleanup.evaluate` reads it). Points behind
    the camera are never selected."""
    xyz = np.asarray(xyz, dtype=np.float64).reshape(-1, 3)
    sel = np.zeros(len(xyz), dtype=bool)
    if not len(xyz):
        return sel
    m = np.asarray(view_proj, dtype=np.float64).reshape(4, 4).T  # column-major
    clip = np.concatenate([xyz, np.ones((len(xyz), 1))], axis=1) @ m.T
    w = clip[:, 3]
    front = w > 0
    if front.any():
        x = clip[front, 0] / w[front]
        y = clip[front, 1] / w[front]
        sel[front] = in_polygon(np.asarray(polygon, dtype=np.float64), x, y)
    return sel


def _no_shaft(h: np.ndarray) -> np.ndarray:
    return np.zeros_like(np.asarray(h, dtype=float))


def measure_selection(
    xyz: np.ndarray,
    axis_point: np.ndarray,
    axis_dir: np.ndarray,
    origin: tuple[float, float, float],
    convergence: float | None,
) -> dict[str, Any] | None:
    """The `measure_unit` fields of the unit in a selection of local-frame points, with `support`
    the selection's point count and `convergenceDeg`. The unit with most support when faces pair
    into boxes, else one box from the best supported face (its depth inferred). None with fewer
    than `FLAG_MIN_POINTS` points or no upright planar face."""
    xyz = np.asarray(xyz, dtype=np.float64).reshape(-1, 3)
    if len(xyz) < FLAG_MIN_POINTS:
        return None
    axis_point = np.asarray(axis_point, dtype=float)
    axis_dir = np.asarray(axis_dir, dtype=float)
    axis_dir = axis_dir / np.linalg.norm(axis_dir)
    faces = planar_faces(xyz, axis_point, axis_dir, _no_shaft)
    if not faces:
        return None
    units = pair_faces(faces, axis_point, xyz, _no_shaft, {})
    if units:
        unit = max(units, key=lambda u: u.support)
    else:
        unit = unit_from_faces([max(faces, key=lambda f: f.support)], axis_point, xyz)
        radial = unit.centre - axis_point
        radial = radial - (radial @ axis_dir) * axis_dir
        ln = np.linalg.norm(radial)
        unit.kind = classify(unit, radial / ln if ln > 0 else radial)
        unit.dish = None
    out = measure_unit(unit, origin, convergence)
    out["support"] = len(xyz)
    out["convergenceDeg"] = convergence
    return out


def not_measured(
    anchor_local: np.ndarray,
    origin: tuple[float, float, float],
    support: int,
    convergence: float | None,
) -> dict[str, Any]:
    """A flag that could not be measured: an "other" unit drawn as a `PLACEHOLDER_M` cube at the
    anchor (project E, N, Z), with no value fields."""
    centre = to_project(np.asarray(anchor_local, dtype=float), origin)
    return {
        "kind": "other",
        "box": {
            "centre": [round(float(v), 3) + 0.0 for v in centre],
            "axes": [[1, 0, 0], [0, 0, 1], [0, 1, 0]],
            "extents": [PLACEHOLDER_M] * 3,
        },
        "support": int(support),
        "convergenceDeg": convergence,
    }
