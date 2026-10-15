"""Cross sections along an axis: a robust circle per slice and the piecewise linear taper they give.

Heights are metres along the axis from the asset base (`axis.point`), the unit the assembler
expects. A slice's `centre` is the local (x, z) where the axis of the fitted circle crosses the
slice, `coverage` the share of the 36 ten-degree azimuth bins that hold inlier points (a scan from
one side reports about 0.5, a full ring 1.0).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import TYPE_CHECKING

import numpy as np

from ..modelfit.ransac import fit_circle, ransac_circle

if TYPE_CHECKING:
    from .axis import Axis

BINS = 36
MIN_SLICE_POINTS = 40
#: A slice whose radius differs from the shaft's running radius by more than this share is not the
#: shaft (a platform, a crown of flues, a bracket) and is left out.
RADIUS_JUMP = 0.25


@dataclass
class SliceFit:
    y: float  # height above the base along the axis, metres
    centre: tuple[float, float]  # local x, z
    r: float
    residual_m: float  # RMS distance of the inliers to the circle
    support: int  # inlier count
    coverage: float  # share of 10-degree azimuth bins with points, 0..1


@dataclass
class Taper:
    profile: list[tuple[float, float]]  # (height above base, radius), knots
    residual_m: float  # RMS of the slice radii around the profile


def fit_ring(
    uw: np.ndarray, rng: np.random.Generator
) -> tuple[float, float, float, float, int, float] | None:
    """A circle through the shaft points of one slice (2D, metres).

    Returns (cu, cw, r, rms residual, inliers, coverage) or None. The inlier distance is adapted to
    the slice: a coarse RANSAC at a tenth of the extent, then three times the robust residual spread.
    """
    if len(uw) < MIN_SLICE_POINTS:
        return None
    extent = float(max(np.ptp(uw[:, 0]), np.ptp(uw[:, 1]))) / 2
    coarse = float(np.clip(0.08 * extent, 0.01, 0.3))
    fit = ransac_circle(uw, coarse, rng, iters=200)
    if fit is None:
        return None
    cu, cw, r, inl = fit
    for _ in range(2):
        d = np.hypot(uw[:, 0] - cu, uw[:, 1] - cw) - r
        sigma = 1.4826 * float(np.median(np.abs(d[inl] - np.median(d[inl]))))
        dist = float(np.clip(3 * sigma, 0.004, coarse))
        inl = np.abs(d) < dist
        if inl.sum() < 10:
            return None
        cu, cw, r = fit_circle(uw[inl])
    d = np.hypot(uw[:, 0] - cu, uw[:, 1] - cw) - r
    inl = np.abs(d) < dist
    if inl.sum() < 10 or r <= 0:
        return None
    rms = float(np.sqrt(np.mean(d[inl] ** 2)))
    ang = np.degrees(np.arctan2(uw[inl, 0] - cu, -(uw[inl, 1] - cw))) % 360.0
    counts = np.bincount((ang // (360 / BINS)).astype(int) % BINS, minlength=BINS)
    coverage = float((counts >= 2).sum()) / BINS
    return float(cu), float(cw), float(r), rms, int(inl.sum()), coverage


def fit_sections(
    xyz: np.ndarray, axis: Axis, step: float, max_slices: int = 256, seed: int = 0
) -> list[SliceFit]:
    """One circle per slice every `step` metres along the axis, bottom to top.

    The slice is `step` thick (at least 0.3 m). A step that would give more than `max_slices`
    slices is widened. Slices that do not fit, or whose radius jumps away from the running shaft
    radius, are skipped.
    """
    if len(xyz) < MIN_SLICE_POINTS or step <= 0:
        return []
    rng = np.random.default_rng(seed)
    u, w, h = axis.to_frame(xyz)
    top = float(h.max())
    step = max(step, top / max_slices if top > 0 else step)
    half = max(step, 0.3) / 2
    order = np.argsort(h)
    hs = h[order]
    out: list[SliceFit] = []
    recent: list[float] = []
    seed_radii: list[float] = []
    ref: float | None = None
    n = int(top // step) + 1
    for i in range(n):
        y = i * step
        lo, hi = np.searchsorted(hs, [y - half, y + half])
        sel = order[lo:hi]
        fit = fit_ring(np.column_stack([u[sel], w[sel]]), rng)
        if fit is None:
            continue
        cu, cw, r, rms, support, cov = fit
        if ref is None:
            seed_radii.append(r)
            if len(seed_radii) < 5:
                out.append(_slice(axis, y, cu, cw, r, rms, support, cov))
                continue
            ref = float(np.median(seed_radii))
            recent = list(seed_radii)
        offset = math.hypot(cu, cw)
        if abs(r - ref) > RADIUS_JUMP * ref or offset > 0.5 * ref:
            continue
        recent = [*recent, r][-5:]
        ref = float(np.median(recent))
        out.append(_slice(axis, y, cu, cw, r, rms, support, cov))
    return _drop_seed_outliers(out, seed_radii) if ref is not None else out


def _drop_seed_outliers(slices: list[SliceFit], seed_radii: list[float]) -> list[SliceFit]:
    """The first few slices set the running radius before it exists; drop one that disagrees."""
    if not seed_radii:
        return slices
    ref = float(np.median(seed_radii))
    first = slices[: len(seed_radii)]
    keep = [s for s in first if abs(s.r - ref) <= RADIUS_JUMP * ref]
    return keep + slices[len(seed_radii) :]


def _slice(axis: Axis, y: float, cu: float, cw: float, r: float, rms: float, support: int, cov: float):
    p = axis.from_frame(cu, cw, y)
    return SliceFit(
        y=float(y), centre=(float(p[0]), float(p[2])), r=r, residual_m=rms, support=support, coverage=cov
    )


def _dp(pts: list[tuple[float, float]], tol: float) -> list[int]:
    """Douglas-Peucker on (y, r), the deviation measured in r at the same y."""
    keep = {0, len(pts) - 1}
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        (ya, ra), (yb, rb) = pts[a], pts[b]
        worst, at = 0.0, -1
        for i in range(a + 1, b):
            y, r = pts[i]
            line = ra + (rb - ra) * ((y - ya) / (yb - ya) if yb > ya else 0.0)
            dev = abs(r - line)
            if dev > worst:
                worst, at = dev, i
        if worst > tol and at >= 0:
            keep.add(at)
            stack += [(a, at), (at, b)]
    return sorted(keep)


def fit_taper(slices: list[SliceFit], max_knots: int = 8) -> Taper:
    """A piecewise linear radius profile: knots by Douglas-Peucker at 1 percent of the largest
    radius, the tolerance widened until at most `max_knots` remain."""
    if not slices:
        return Taper(profile=[], residual_m=0.0)
    pts = sorted((s.y, s.r) for s in slices)
    if len(pts) == 1:
        return Taper(profile=[pts[0]], residual_m=0.0)
    tol = 0.01 * max(r for _, r in pts)
    idx = _dp(pts, tol)
    while len(idx) > max_knots:
        tol *= 1.25
        idx = _dp(pts, tol)
    profile = [pts[i] for i in idx]
    ys, rs = zip(*profile, strict=True)
    fitted = np.interp([y for y, _ in pts], ys, rs)
    resid = float(np.sqrt(np.mean((np.array([r for _, r in pts]) - fitted) ** 2)))
    return Taper(profile=profile, residual_m=resid)
