"""The axis of a standing structure: PCA of the upper points, refined on the centres of its slices.

Local frame: x east, y up, z south. `dir` points up (positive y); `tilt_deg` is its angle from
vertical; `point` is where the axis meets the lowest point of the cloud (the base height).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .sections import fit_ring


@dataclass
class Axis:
    point: tuple[float, float, float]
    dir: tuple[float, float, float]
    tilt_deg: float

    def basis(self) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Orthonormal (e_u, e_w, e_h) with e_h the axis direction."""
        e_h = np.asarray(self.dir, dtype=np.float64)
        ref = np.array([1.0, 0.0, 0.0]) if abs(e_h[0]) < 0.9 else np.array([0.0, 0.0, 1.0])
        e_u = ref - e_h * float(ref @ e_h)
        e_u /= np.linalg.norm(e_u)
        return e_u, np.cross(e_h, e_u), e_h

    def to_frame(self, xyz: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """(u, w, h) of each point: lateral offsets and the height along the axis from `point`."""
        e_u, e_w, e_h = self.basis()
        d = xyz - np.asarray(self.point)
        return d @ e_u, d @ e_w, d @ e_h

    def from_frame(self, u: float, w: float, h: float) -> np.ndarray:
        e_u, e_w, e_h = self.basis()
        return np.asarray(self.point) + u * e_u + w * e_w + h * e_h


def _unit_up(v: np.ndarray) -> np.ndarray:
    v = v / np.linalg.norm(v)
    return -v if v[1] < 0 else v


def _tilt(d: np.ndarray) -> float:
    return math.degrees(math.acos(float(np.clip(d[1], -1.0, 1.0))))


def estimate_axis(xyz: np.ndarray, seed: int = 0, slices: int = 24) -> Axis:
    """PCA on the points above 20 percent of the height, then a straight line through the circle
    centres of `slices` sections (a robust fit, one pass of outlier rejection)."""
    if len(xyz) < 10:
        return Axis((0.0, 0.0, 0.0), (0.0, 1.0, 0.0), 0.0)
    y0, y1 = float(xyz[:, 1].min()), float(xyz[:, 1].max())
    upper = xyz[xyz[:, 1] > y0 + 0.2 * (y1 - y0)]
    if len(upper) < 10:
        upper = xyz
    centroid = upper.mean(axis=0)
    _, _, vt = np.linalg.svd(upper - centroid, full_matrices=False)
    d = _unit_up(vt[0])
    foot = centroid + d * ((y0 - centroid[1]) / d[1] if abs(d[1]) > 1e-9 else 0.0)
    coarse = Axis(tuple(float(v) for v in foot), tuple(float(v) for v in d), _tilt(d))

    rng = np.random.default_rng(seed)
    u, w, h = coarse.to_frame(xyz)
    top = float(h.max())
    order = np.argsort(h)
    hs = h[order]
    half = max(top / slices / 2, 0.3)
    cs = []
    for y in np.linspace(0.05 * top, 0.95 * top, slices):
        lo, hi = np.searchsorted(hs, [y - half, y + half])
        sel = order[lo:hi]
        fit = fit_ring(np.column_stack([u[sel], w[sel]]), rng)
        if fit is not None:
            cs.append((y, *fit))
    if len(cs) < 4:
        return coarse
    a = np.array(cs)
    middle = (a[:, 0] > 0.2 * top) & (a[:, 0] < 0.7 * top) & (a[:, 6] >= 0.6)
    if middle.sum() >= 6:
        radii = a[middle, 3]
        # A coherent bare shaft gives a less biased centreline than a crowded crown.
        # Keep the original all-height method for open lattice or discontinuous members.
        if np.ptp(radii) < 0.6 * np.median(radii):
            a = a[middle]
    keep = np.ones(len(a), dtype=bool)
    coef_u = coef_w = np.zeros(2)
    for _ in range(2):
        design = np.column_stack([a[keep, 0], np.ones(keep.sum())])
        coef_u = np.linalg.lstsq(design, a[keep, 1], rcond=None)[0]
        coef_w = np.linalg.lstsq(design, a[keep, 2], rcond=None)[0]
        res = np.hypot(
            a[:, 1] - (coef_u[0] * a[:, 0] + coef_u[1]), a[:, 2] - (coef_w[0] * a[:, 0] + coef_w[1])
        )
        tol = max(3 * float(np.median(res[keep])), 0.02 * float(np.median(a[:, 3])))
        keep = res <= tol
        if keep.sum() < 4:
            return coarse
    e_u, e_w, e_h = coarse.basis()
    new_dir = _unit_up(e_h + coef_u[0] * e_u + coef_w[0] * e_w)
    # the axis point at the base height: the fitted line at h = 0 (lowest point), carried to y0
    p0 = coarse.from_frame(float(coef_u[1]), float(coef_w[1]), 0.0)
    base = p0 + new_dir * ((y0 - p0[1]) / new_dir[1])
    return Axis(tuple(float(v) for v in base), tuple(float(v) for v in new_dir), _tilt(new_dir))
