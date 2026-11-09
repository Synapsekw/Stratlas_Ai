"""Frame maths, camera model and point-cloud ray cast for Flyability imports.

Quaternions are x, y, z, w. The Flyability body frame is x forward, y left, z up and the
camera looks along its own +x (negative pitch looks down).
"""

from __future__ import annotations

import math
from typing import Literal

import numpy as np
from scipy.spatial import cKDTree
from scipy.spatial.transform import Rotation

LEVER_ARM = (0.2986, 0.0077, -0.0202)

# Scene frame (data-conventions section 1): (x, y, z) -> (x, z, -y).
_S = np.array([[1.0, 0, 0], [0, 0, 1.0], [0, -1.0, 0]])
# Columns are three.js X, Y, Z camera axes in the Flyability camera frame.
_C = np.array([[0.0, 0, -1.0], [-1.0, 0, 0], [0, 1.0, 0]])

_GRID_ABOVE = 5_000_000
_STEP_M = 0.02
_START_M = 0.1
_FINE_STEP_M = 0.005

# The drone's wall_distance reading is taken from a point behind the camera: on two real
# chambers (196 snapshots with both readings) the median of (cast distance from the camera
# minus wall_distance) was -0.14 m. A cast distance is compared with wall_distance only
# after adding this.
WALL_DISTANCE_BEHIND_CAMERA_M = 0.14


def apply(m: np.ndarray | None, pts: np.ndarray) -> np.ndarray:
    """Apply a row-major 4 x 4 to N x 3 points; None returns pts unchanged."""
    if m is None:
        return pts
    m = np.asarray(m, dtype=float).reshape(4, 4)
    return np.asarray(pts, dtype=float) @ m[:3, :3].T + m[:3, 3]


def apply_pose(m: np.ndarray | None, pos: np.ndarray, q: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Move a pose by `m`: position transformed, orientation turned by m[:3,:3]."""
    if m is None:
        return np.asarray(pos, dtype=float), np.asarray(q, dtype=float)
    m = np.asarray(m, dtype=float).reshape(4, 4)
    new_pos = apply(m, np.asarray(pos, dtype=float).reshape(1, 3))[0]
    new_q = Rotation.from_matrix(m[:3, :3] @ Rotation.from_quat(q).as_matrix()).as_quat()
    return new_pos, new_q


def to_scene(p: np.ndarray) -> np.ndarray:
    """Flyability z-up (x, y, z) to scene y-up (x, z, -y); a point or N x 3."""
    return np.asarray(p, dtype=float) @ _S.T


def view_axis(q: np.ndarray) -> np.ndarray:
    """The camera +x axis in the space frame."""
    return Rotation.from_quat(q).apply([1.0, 0.0, 0.0])


def three_camera_q(q_fly_cam: np.ndarray) -> list[float]:
    """Scene-frame three.js camera quaternion (looks along -Z, +Y up)."""
    r = _S @ Rotation.from_quat(q_fly_cam).as_matrix() @ _C
    return [float(v) for v in Rotation.from_matrix(r).as_quat()]


def camera_from_body(
    pos: np.ndarray,
    q: np.ndarray,
    pitch_deg: float,
    lever: tuple[float, float, float] = LEVER_ARM,
) -> tuple[np.ndarray, np.ndarray]:
    """Camera pose from the body pose: lever arm in the body frame, R_body * Ry(-pitch)."""
    r_body = Rotation.from_quat(q)
    cam_pos = np.asarray(pos, dtype=float) + r_body.apply(lever)
    cam_q = (r_body * Rotation.from_euler("y", -pitch_deg, degrees=True)).as_quat()
    return cam_pos, cam_q


def _grid_subsample(points: np.ndarray, cell: float = 0.01) -> np.ndarray:
    """Keep one point per grid cell (the first), with cell indices packed into one int64."""
    keys = np.floor(points / cell).astype(np.int64)
    keys -= keys.min(axis=0)
    ny, nz = int(keys[:, 1].max()) + 1, int(keys[:, 2].max()) + 1
    flat = (keys[:, 0] * ny + keys[:, 1]) * nz + keys[:, 2]
    _, idx = np.unique(flat, return_index=True)
    return points[np.sort(idx)]


def cast(
    points: np.ndarray,
    origins: np.ndarray,
    dirs: np.ndarray,
    max_m: float = 30.0,
) -> np.ndarray:
    """First-hit distance per ray through a point cloud, nan for no hit.

    Marches each ray from 0.1 m in 0.02 m steps; a step hits when a point lies within
    0.03 + 0.005 * t of it. The ball reaches up to its radius ahead of the surface, so the
    distance is refined to the mean along-ray position of the points found (clamped to
    t +/- radius). A zero-length direction gives nan. Clouds over 5 M points are first
    thinned to a 1 cm grid.
    """
    points = np.asarray(points, dtype=float)
    origins = np.asarray(origins, dtype=float).reshape(-1, 3)
    dirs = np.asarray(dirs, dtype=float).reshape(-1, 3)
    out = np.full(len(origins), math.nan)
    if len(points) == 0 or len(origins) == 0:
        return out
    if len(points) > _GRID_ABOVE:
        points = _grid_subsample(points)
    tree = cKDTree(points)
    ts = np.arange(_START_M, max_m + 1e-9, _STEP_M)
    radii = 0.03 + 0.005 * ts
    for i, (o, d) in enumerate(zip(origins, dirs, strict=True)):
        n = np.linalg.norm(d)
        if n == 0:
            continue
        samples = o + ts[:, None] * (d / n)
        counts = tree.query_ball_point(samples, radii, return_length=True)
        hit = np.flatnonzero(np.asarray(counts) > 0)
        if hit.size:
            j = hit[0]
            if j == 0:
                # A hit at the first step only bounds the distance from above: march the
                # first stretch again in fine steps from the origin.
                fine = np.arange(_FINE_STEP_M, ts[0] + 1e-9, _FINE_STEP_M)
                fine_r = 0.03 + 0.005 * fine
                fs = o + fine[:, None] * (d / n)
                fh = np.flatnonzero(np.asarray(tree.query_ball_point(fs, fine_r, return_length=True)) > 0)
                if fh.size:
                    k = fh[0]
                    near = points[tree.query_ball_point(fs[k], fine_r[k])]
                    along = (near - o) @ (d / n)
                    out[i] = float(max(np.clip(along.mean(), fine[k] - fine_r[k], fine[k] + fine_r[k]), 0.0))
                    continue
            # The ball reaches up to the radius ahead of the surface, so refine: the mean
            # along-ray position of the points found is the surface distance.
            near = points[tree.query_ball_point(samples[j], radii[j])]
            along = (near - o) @ (d / n)
            out[i] = float(np.clip(along.mean(), ts[j] - radii[j], ts[j] + radii[j]))
    return out


def location_check(
    hit_m: float, wall_m: float | None
) -> Literal["agrees", "disagrees", "no-hit", "unchecked"]:
    """Compare a cast distance (from the camera) with the drone wall-distance reading."""
    if math.isnan(hit_m):
        return "no-hit"
    if wall_m is None:
        return "unchecked"
    return (
        "disagrees"
        if abs(hit_m + WALL_DISTANCE_BEHIND_CAMERA_M - wall_m) > max(0.3, 0.25 * wall_m)
        else "agrees"
    )
