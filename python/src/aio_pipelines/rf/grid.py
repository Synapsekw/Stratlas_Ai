"""The study grid and the antenna frame (spec D12, D15, D17).

Grid: row-major, row 0 at the top. Pixel (col, row) has its centre at
``(originEast + (col + 0.5) res, originNorth - (row + 0.5) res)`` in the project CRS, the top-left
convention of ``RfRunGrid`` and of ``packages/rf/src/preview.ts``. The grid is snapped to whole
multiples of the resolution, with the site in its centre pixel and ``ceil(radius / res)`` pixels on
each side, so two runs of one site share pixels (and their path-loss grids can be reused).

Antenna frame (``geometry.ts``): a grid offset turns clockwise by the convergence into the true
frame, then by the true azimuth about the vertical, then by the mechanical downtilt about the
antenna's horizontal axis. Mechanical tilt is that rotation, never added to the electrical tilt.
On a grid offset the convergence turns both the direction and the azimuth and cancels; it is
still required, because an RF map facing the wrong way is worse than none (D2).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from ..runtime import JobError

NO_CRS = "No grid convergence: the project needs a CRS before coverage can face the right way."


@dataclass(frozen=True)
class Grid:
    origin_e: float
    origin_n: float
    width: int
    height: int
    res: float

    def column_east(self) -> np.ndarray:
        return self.origin_e + (np.arange(self.width) + 0.5) * self.res

    def row_north(self, r0: int = 0, r1: int | None = None) -> np.ndarray:
        r1 = self.height if r1 is None else r1
        return self.origin_n - (np.arange(r0, r1) + 0.5) * self.res


def build_grid(centre_e: float, centre_n: float, radius_m: float, res_m: float) -> Grid:
    k = math.ceil(radius_m / res_m - 1e-9)
    ce = math.floor(centre_e / res_m)
    cn = math.floor(centre_n / res_m)
    return Grid(
        origin_e=float((ce - k) * res_m),
        origin_n=float((cn + 1 + k) * res_m),
        width=2 * k + 1,
        height=2 * k + 1,
        res=float(res_m),
    )


def true_azimuth_deg(azimuth_grid_deg: float, convergence_deg: float | None) -> float:
    if convergence_deg is None or not math.isfinite(convergence_deg):
        raise JobError(NO_CRS)
    return (azimuth_grid_deg + convergence_deg) % 360.0


def antenna_angles(
    east: np.ndarray,
    north: np.ndarray,
    up: np.ndarray,
    azimuth_grid_deg: float,
    convergence_deg: float | None,
    mechanical_downtilt_deg: float,
) -> tuple[np.ndarray, np.ndarray]:
    """Grid offsets (antenna to point) as (azimuth off boresight, (-180, 180], positive right;
    down-elevation below the boresight plane, positive down), degrees."""
    true_az = true_azimuth_deg(azimuth_grid_deg, convergence_deg)
    c = math.cos(math.radians(convergence_deg))  # type: ignore[arg-type]
    s = math.sin(math.radians(convergence_deg))  # type: ignore[arg-type]
    e = east * c + north * s
    n = north * c - east * s
    sa, ca = math.sin(math.radians(true_az)), math.cos(math.radians(true_az))
    f = e * sa + n * ca
    r = e * ca - n * sa
    st = math.sin(math.radians(mechanical_downtilt_deg))
    ct = math.cos(math.radians(mechanical_downtilt_deg))
    fwd = f * ct - up * st
    u = f * st + up * ct
    az = np.degrees(np.arctan2(r, fwd))
    az = np.where(az <= -180.0, az + 360.0, az)
    down = -np.degrees(np.arctan2(u, np.hypot(fwd, r)))
    return az, down + 0.0
