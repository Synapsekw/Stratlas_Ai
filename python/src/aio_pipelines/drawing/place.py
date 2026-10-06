"""Placing a drawing in the project: a 2D similarity from drawing units to the local frame.

The placement is one affine matrix ``[a, b, c, d, tx, tz]`` from a drawing point ``(dx, dy)`` in
drawing units to the local frame (data-conventions section 1, x east, z south):
``x = a*dx + b*dy + tx`` and ``z = c*dx + d*dy + tz`` (y is the base height of the drawing).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import numpy as np

from ..runtime import JobError

#: a drawing whose centre would land further than this from the project origin is placed at it
FAR_M = 5000.0
FAR_MESSAGE = (
    "The drawing is not in the project coordinates; it is placed at the project origin until you "
    "place it by points."
)


@dataclass
class Placement:
    matrix: tuple[float, float, float, float, float, float]
    base_y: float
    scale: float  # similarity scale of the fit (1 when placed without control points)
    rotation_deg: float
    rms_m: float | None
    provisional: bool
    far: bool = False

    def apply(self, pts: np.ndarray) -> np.ndarray:
        """Drawing units (n, 2) to local ``[x, z]`` (n, 2)."""
        a, b, c, d, tx, tz = self.matrix
        p = np.asarray(pts, dtype=np.float64).reshape(-1, 2)
        return np.column_stack([a * p[:, 0] + b * p[:, 1] + tx, c * p[:, 0] + d * p[:, 1] + tz])

    @property
    def metres_per_unit(self) -> float:
        a, b, c, d, _, _ = self.matrix
        return math.sqrt(abs(a * d - b * c))


def umeyama_2d(src: np.ndarray, dst: np.ndarray) -> tuple[float, float, np.ndarray]:
    """Least-squares similarity ``dst ~ s R src + t`` (no reflection): scale, angle, translation."""
    mu_s, mu_d = src.mean(0), dst.mean(0)
    xs, xd = src - mu_s, dst - mu_d
    var = (xs**2).sum() / len(src)
    cov = xd.T @ xs / len(src)
    u, sv, vt = np.linalg.svd(cov)
    sign = np.diag([1.0, 1.0 if np.linalg.det(u) * np.linalg.det(vt) >= 0 else -1.0])
    r = u @ sign @ vt
    s = float(np.trace(np.diag(sv) @ sign) / var)
    t = mu_d - s * r @ mu_s
    return s, math.atan2(r[1, 0], r[0, 0]), t


def control_targets(
    control: list[dict[str, Any]], origin: list[float], epsg: int | None
) -> tuple[np.ndarray, np.ndarray, list[float]]:
    """Drawing points and their project CRS (E, N), plus the local heights of local points."""
    src = np.array([c["drawing"] for c in control], dtype=np.float64)
    dst = np.zeros_like(src)
    heights: list[float] = []
    lonlat = [i for i, c in enumerate(control) if "lonLat" in c]
    if lonlat:
        if not epsg:
            raise JobError(
                "Control points on the map (lonLat) need the project CRS as an EPSG code, and this "
                "project has none. Place the drawing by points in the model (local) instead."
            )
        from rasterio.warp import transform

        lon = [control[i]["lonLat"][0] for i in lonlat]
        lat = [control[i]["lonLat"][1] for i in lonlat]
        e, n = transform("EPSG:4326", f"EPSG:{epsg}", lon, lat)
        for k, i in enumerate(lonlat):
            dst[i] = (e[k], n[k])
    for i, c in enumerate(control):
        if "local" in c:
            x, y, z = c["local"]
            dst[i] = (origin[0] + x, origin[1] - z)
            heights.append(float(y))
    return src, dst, heights


def place(
    control: list[dict[str, Any]] | None,
    unit_m: float,
    origin: list[float],
    epsg: int | None,
    bounds: tuple[float, float, float, float],
    log=lambda m, level="info": None,
) -> Placement:
    o0, o1 = float(origin[0]), float(origin[1])
    if control:
        src, dst, heights = control_targets(control, origin, epsg)
        distinct = {(round(x, 9), round(y, 9)) for x, y in src}
        if len(distinct) < 2:
            raise JobError(
                "Place the drawing by at least 2 control points at different drawing positions; "
                f"{len(control)} given, {len(distinct)} different."
            )
        m = src * unit_m
        s, theta, t = umeyama_2d(m, dst)
        cs, sn = math.cos(theta), math.sin(theta)
        fitted = (s * np.column_stack([cs * m[:, 0] - sn * m[:, 1], sn * m[:, 0] + cs * m[:, 1]])) + t
        rms = float(np.sqrt(((fitted - dst) ** 2).sum(1).mean()))
        base_y = float(np.mean(heights)) if heights else 0.0
        su = s * unit_m
        matrix = (su * cs, -su * sn, -su * sn, -su * cs, float(t[0]) - o0, o1 - float(t[1]))
        log(f"Placed by {len(control)} control points: scale {s:.4f}, RMS {rms:.3f} m.")
        if abs(s - 1) > 0.02:
            log(
                f"The control points scale the drawing by {s:.3f}; check the drawing units and the "
                "control points.",
                "warn",
            )
        return Placement(matrix, base_y, s, math.degrees(theta), rms, False)
    # drawing metres are taken as project eastings and northings
    u = unit_m
    matrix = (u, 0.0, 0.0, -u, -o0, o1)
    x0, y0, x1, y1 = bounds
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    lx, lz = u * cx - o0, o1 - u * cy
    if abs(lx) > FAR_M or abs(lz) > FAR_M:
        log(FAR_MESSAGE, "warn")
        return Placement((u, 0.0, 0.0, -u, -u * cx, u * cy), 0.0, 1.0, 0.0, None, True, far=True)
    return Placement(matrix, 0.0, 1.0, 0.0, None, True)


def local_to_lonlat(xz: np.ndarray, origin: list[float], epsg: int) -> np.ndarray:
    """Local ``[x, z]`` (n, 2) to lon/lat (n, 2) through the project CRS."""
    from rasterio.warp import transform

    p = np.asarray(xz, dtype=np.float64).reshape(-1, 2)
    if not len(p):
        return p
    e = (origin[0] + p[:, 0]).tolist()
    n = (origin[1] - p[:, 1]).tolist()
    lon, lat = transform(f"EPSG:{epsg}", "EPSG:4326", e, n)
    return np.column_stack([lon, lat])
