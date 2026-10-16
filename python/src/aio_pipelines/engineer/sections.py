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
#: Split radius regimes before choosing the shaft by sustained vertical support.
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
    xyz: np.ndarray,
    axis: Axis,
    step: float,
    max_slices: int = 256,
    seed: int = 0,
    report: dict | None = None,
) -> list[SliceFit]:
    """One circle per slice every `step` metres along the axis, bottom to top.

    The slice is `step` thick (at least 0.3 m). A step that would give more than `max_slices`
    slices is widened. Fit all heights before selecting a coherent shaft: dense low clutter
    must not set the radius against which the rest of the tower is rejected. With `report`
    (a dict) the counts of skipped slices are written to it:
    `{"slices": kept, "rejected": {"no-fit": n, "radius-jump": n, "off-axis": n}}`.
    """
    rejected = {"no-fit": 0, "radius-jump": 0, "off-axis": 0}
    if len(xyz) < MIN_SLICE_POINTS or step <= 0:
        return []
    rng = np.random.default_rng(seed)
    u, w, h = axis.to_frame(xyz)
    top = float(h.max())
    step = max(step, top / max_slices if top > 0 else step)
    half = max(step, 0.3) / 2
    order = np.argsort(h)
    hs = h[order]
    candidates: list[SliceFit] = []
    failed: dict[float, str] = {}
    n = int(top // step) + 1
    for i in range(n):
        y = i * step
        lo, hi = np.searchsorted(hs, [y - half, y + half])
        sel = order[lo:hi]
        fit = fit_ring(np.column_stack([u[sel], w[sel]]), rng)
        if fit is None:
            rejected["no-fit"] += 1
            failed[y] = "no-fit"
            continue
        cu, cw, r, rms, support, cov = fit
        if math.hypot(cu, cw) > max(0.5 * r, 0.35):
            rejected["off-axis"] += 1
            failed[y] = "off-axis"
            continue
        candidates.append(_slice(axis, y, cu, cw, r, rms, support, cov))
    out = _coherent_sections(candidates, step)
    recovered = _recover_sections(xyz, axis, out, u, w, h, step, half, rng)
    if recovered:
        by_height = {s.y: s for s in candidates}
        for s in recovered:
            by_height[s.y] = s
            why = failed.pop(s.y, None)
            if why:
                rejected[why] -= 1
        candidates = sorted(by_height.values(), key=lambda s: s.y)
        out = _coherent_sections(candidates, step)
    rejected["radius-jump"] = len(candidates) - len(out)
    if report is not None:
        report["slices"] = len(out)
        report["rejected"] = rejected
    return out


def _recover_sections(
    xyz: np.ndarray,
    axis: Axis,
    shaft: list[SliceFit],
    u: np.ndarray,
    w: np.ndarray,
    h: np.ndarray,
    step: float,
    half: float,
    rng: np.random.Generator,
) -> list[SliceFit]:
    """Look for observed wall points hidden by more numerous attached equipment.

    A long, already measured shaft supplies a centre line and radius prediction;
    the prediction only selects points for another circle fit. Missing geometry
    is never filled in. Short low fits cannot seed this recovery.
    """
    top = float(h.max())
    if abs(axis.dir[1]) < 1e-6 or len(shaft) < 5 or shaft[-1].y - shaft[0].y < 0.5 * top:
        return []
    ys = np.array([s.y for s in shaft])
    radii = np.array([s.r for s in shaft])
    e_u, e_w, e_h = axis.basis()
    # Compare centres in the axis frame so a leaning shaft is still concentric.
    basis_xz = np.column_stack([e_u[[0, 2]], e_w[[0, 2]]])
    centres = np.array([s.centre for s in shaft])
    lateral = np.linalg.solve(
        basis_xz, (centres - np.asarray(axis.point)[[0, 2]] - ys[:, None] * e_h[[0, 2]]).T
    ).T
    line = np.polyfit(ys, lateral, 1)
    residual = np.linalg.norm(lateral - (ys[:, None] * line[0] + line[1]), axis=1)
    good = residual <= max(3 * float(np.median(residual)), 0.1 * float(np.median(radii)), 0.01)
    if good.sum() >= 5:
        line = np.polyfit(ys[good], lateral[good], 1)
    order = np.argsort(h)
    hs = h[order]
    existing = {s.y for s in shaft}
    out = []
    for i in range(int(top // step) + 1):
        y = i * step
        if y in existing:
            continue
        edge = slice(0, min(5, len(shaft))) if y < ys[0] else slice(-min(5, len(shaft)), None)
        expected = float(np.interp(y, ys, radii))
        if y < ys[0] or y > ys[-1]:
            slope, intercept = np.polyfit(ys[edge], radii[edge], 1)
            expected = float(slope * y + intercept)
        if expected <= 0 or expected < 0.5 * radii.min() or expected > 2 * radii.max():
            continue
        cu, cw = y * line[0] + line[1]
        lo, hi = np.searchsorted(hs, [y - half, y + half])
        sel = order[lo:hi]
        d = np.hypot(u[sel] - cu, w[sel] - cw)
        sel = sel[(d >= 0.65 * expected) & (d <= 1.35 * expected)]
        if len(sel) < MIN_SLICE_POINTS:
            continue
        fit = fit_ring(np.column_stack([u[sel], w[sel]]), rng)
        if fit is None:
            continue
        fu, fw, r, rms, support, coverage = fit
        if (
            support < 25
            or coverage < 0.25
            or rms > max(0.01, 0.05 * r)
            or abs(r - expected) > RADIUS_JUMP * expected
            or math.hypot(fu - cu, fw - cw) > max(0.1, 0.25 * r)
        ):
            continue
        out.append(_slice(axis, y, fu, fw, r, rms, support, coverage))
    return out


def _coherent_sections(slices: list[SliceFit], step: float) -> list[SliceFit]:
    """Choose sustained vertical geometry, not point count or the smallest radius.

    Short radius excursions (brackets, platforms, flues) split into other runs.
    Persistent concentric steps may join the dominant run when their radii are
    comparable and the runs meet. A disconnected height interval cannot bridge
    an unobserved section or promote a separate tall object.
    """
    runs: list[list[SliceFit]] = []
    for s in slices:
        previous = runs[-1] if runs else []
        ref = float(np.median([p.r for p in previous[-5:]])) if previous else s.r
        moved = previous and math.dist(s.centre, previous[-1].centre) > max(0.15, 0.5 * ref) + 0.1 * (
            s.y - previous[-1].y
        )
        if not previous or s.y - previous[-1].y > 3 * step or abs(s.r - ref) > RADIUS_JUMP * ref or moved:
            runs.append([s])
        else:
            previous.append(s)
    if not runs:
        return []

    # Count supported slice thickness as well as span: a sparse accidental ring
    # at each end must not outweigh a well observed shaft.
    def score(run: list[SliceFit]) -> float:
        return min(run[-1].y - run[0].y + step, len(run) * step * 1.5)

    winner = max(range(len(runs)), key=lambda i: (score(runs[i]), len(runs[i]), -i))
    selected = {winner}
    for direction in (-1, 1):
        anchor = winner
        i = winner + direction
        while 0 <= i < len(runs):
            near, other = runs[anchor], runs[i]
            low, high = (other, near) if direction == -1 else (near, other)
            a, b = low[-1], high[0]
            ratio = max(a.r, b.r) / min(a.r, b.r)
            centred = math.dist(a.centre, b.centre) <= max(0.15, 0.25 * min(a.r, b.r))
            sustained = len(other) >= 3 and score(other) >= 2 * step
            gap = b.y - a.y
            if gap > max(3 * step, 2.0):
                break
            if ratio > 2.5 or not centred or not sustained:
                # A short bracket/platform regime may interrupt an otherwise
                # matching shaft; skip it and look for supported continuation.
                i += direction
                continue
            selected.add(i)
            anchor = i
            i += direction
    return [s for i, run in enumerate(runs) if i in selected for s in run]


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
