"""Repeated members of an engineered asset and a suggested family.

Everything is in the local frame (x east, y up, z south). Compass azimuths: 0 = north = -z,
90 = east = +x, clockwise. A member's `size` is a diameter (a panel's height). Item centres are
local points (y absolute); `levels` of a group are metres above the asset base along the axis.

A group's `to_dict()` is the `MemberGroup` of the evidence pack (schema fields only); the extra
fields (`levels`, per-item residual and coverage) stay on the dataclass for the pipeline to use.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

import numpy as np
from scipy import ndimage
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components
from scipy.spatial import cKDTree

from .axis import Axis
from .sections import SliceFit, Taper, fit_ring


@dataclass
class Item:
    centre: tuple[float, float, float]
    size: float
    support: int
    azimuth_deg: float | None = None
    residual_m: float | None = None
    coverage: float | None = None


@dataclass
class MemberGroup:
    kind: str
    items: list[Item] = field(default_factory=list)
    residual_m: float | None = None
    regularity: float | None = None
    levels: list[float] = field(default_factory=list)  # heights above the base, where the kind has levels
    extra: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        items = []
        for i in self.items:
            d: dict[str, Any] = {
                "centre": [float(v) for v in i.centre],
                "size": float(i.size),
                "support": int(i.support),
            }
            if i.azimuth_deg is not None:
                d["azimuthDeg"] = float(i.azimuth_deg) % 360.0
            items.append(d)
        metrics: dict[str, float] = {}
        if self.residual_m is not None:
            metrics["residualM"] = float(self.residual_m)
        if self.regularity is not None:
            metrics["regularity"] = float(min(1.0, max(0.0, self.regularity)))
        return {"kind": self.kind, "items": items, "metrics": metrics}


@dataclass
class FamilyHints:
    fill_ratio: float
    slenderness: float
    top_features: int
    suggested: str  # a suggestion with reasons, never a decision
    reasons: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "fillRatio": min(1.0, max(0.0, self.fill_ratio)),
            "slenderness": self.slenderness,
            "topFeatures": self.top_features,
            "suggested": self.suggested,
        }


# ---------------------------------------------------------------------------------------------


def _frame(xyz: np.ndarray, axis: Axis):
    u, w, h = axis.to_frame(xyz)
    return u, w, h, np.hypot(u, w)


def _compass(axis: Axis, xyz: np.ndarray, h: np.ndarray) -> np.ndarray:
    centre = np.asarray(axis.point) + np.outer(h, axis.dir)
    d = xyz - centre
    return np.degrees(np.arctan2(d[:, 0], -d[:, 2])) % 360.0


def _taper_r(taper: Taper, h: np.ndarray) -> np.ndarray:
    ys = [p[0] for p in taper.profile]
    rs = [p[1] for p in taper.profile]
    return np.interp(h, ys, rs)


def _components(pts: np.ndarray, eps: float, min_pts: int) -> list[np.ndarray]:
    """Clusters of points chained within `eps` of each other (DBSCAN with min_samples 1), those of
    at least `min_pts` points."""
    n = len(pts)
    if n < min_pts:
        return []
    pairs = cKDTree(pts).query_pairs(eps, output_type="ndarray")
    graph = coo_matrix((np.ones(len(pairs)), (pairs[:, 0], pairs[:, 1])), shape=(n, n))
    count, labels = connected_components(graph, directed=False)
    sizes = np.bincount(labels, minlength=count)
    order = np.argsort(labels, kind="stable")
    bounds = np.cumsum(sizes)[:-1]
    groups = np.split(order, bounds)
    return [g for g, s in zip(groups, sizes, strict=True) if s >= min_pts]


def _levels(heights: list[float], gap: float = 2.0) -> list[float]:
    if not heights:
        return []
    hs = sorted(heights)
    out, run = [], [hs[0]]
    for v in hs[1:]:
        if v - run[-1] > gap:
            out.append(float(np.mean(run)))
            run = []
        run.append(v)
    out.append(float(np.mean(run)))
    return out


def _regularity(values: list[float]) -> float | None:
    if len(values) < 2:
        return None
    m = float(np.mean(values))
    return 1.0 - float(np.std(values)) / m if m > 0 else None


# ---------------------------------------------------------------------------------------------


def find_flues(xyz: np.ndarray, axis: Axis, taper: Taper, seed: int = 0) -> MemberGroup:
    """Flues standing out of the crown: clusters in plan of the points inside the crown radius in
    the top 8 percent of the height, a circle per cluster. A cluster seen over less than half a
    turn (a flue lost in a scan gap) is not reported."""
    group = MemberGroup("flue")
    if len(xyz) == 0 or not taper.profile:
        return group
    u, w, h, r = _frame(xyz, axis)
    top = float(h.max())
    shaft_top, crown_r = taper.profile[-1]
    m = (h > top - 0.08 * top) & (h > shaft_top - 0.5) & (r < 0.9 * crown_r)
    idx = np.flatnonzero(m)
    rng = np.random.default_rng(seed)
    resid = []
    for c in _components(np.column_stack([u[idx], w[idx]]), 0.3, 50):
        sel = idx[c]
        if np.ptp(h[sel]) < 1.0 or float(h[sel].min()) > shaft_top + 2.5:
            continue  # too short, or not standing on the shaft top (a bracket, an antenna)
        fit = fit_ring(np.column_stack([u[sel], w[sel]]), rng)
        if fit is None:
            continue
        cu, cw, rad, rms, support, cov = fit
        if cov < 0.5 or rad < max(0.15, 0.1 * crown_r) or rad > 0.6 * crown_r or support < 0.6 * len(sel):
            continue
        hm = float(h[sel].mean())
        p = axis.from_frame(cu, cw, hm)
        c0 = axis.from_frame(0.0, 0.0, hm)
        az = math.degrees(math.atan2(p[0] - c0[0], -(p[2] - c0[2]))) % 360.0
        group.items.append(Item(tuple(float(v) for v in p), 2 * rad, support, az, rms, cov))
        resid.append(rms)
    group.items.sort(key=lambda i: i.azimuth_deg or 0.0)
    group.residual_m = float(np.mean(resid)) if resid else None
    group.regularity = _regularity([i.size for i in group.items])
    return group


def find_light_candidates(
    xyz: np.ndarray, axis: Axis, taper: Taper, colours: Any = None, noise: float = 0.0
) -> MemberGroup:
    """Small objects proud of the shaft by 0.1 to 1.0 m (more than four noise deviations), clustered
    in (height, arc length); levels group the clusters by height with a 2 m gap."""
    group = MemberGroup("light-candidate")
    if len(xyz) == 0 or not taper.profile:
        return group
    _u, _w, h, r = _frame(xyz, axis)
    base_r = _taper_r(taper, h)
    lo = max(0.1, 4 * noise)
    m = (h >= -0.1) & (h <= taper.profile[-1][0] + 0.5) & (r - base_r >= lo) & (r - base_r <= 1.0)
    idx = np.flatnonzero(m)
    if len(idx) < 15:
        return group
    az = np.radians(_compass(axis, xyz[idx], h[idx]))
    # cluster in (height, position on the shaft surface): no seam at 360 degrees
    chord = np.column_stack([h[idx], base_r[idx] * np.sin(az), base_r[idx] * np.cos(az)])
    heights = []
    for c in _components(chord, 0.35, 15):
        sel = idx[c]
        centre = xyz[sel].mean(axis=0)
        hc = float(h[sel].mean())
        size = float(max(np.ptp(h[sel]), np.ptp(chord[c][:, 1]), np.ptp(chord[c][:, 2])))
        a = float(_compass(axis, centre[None, :], np.array([hc]))[0])
        group.items.append(Item(tuple(float(v) for v in centre), size, len(sel), a, None, None))
        heights.append(hc)
    group.items.sort(key=lambda i: (round(i.centre[1]), i.azimuth_deg or 0.0))
    group.levels = [round(v, 1) for v in _levels(heights)]
    counts = [sum(1 for hh in heights if abs(hh - lv) <= 2.0) for lv in group.levels]
    group.regularity = min(counts) / max(counts) if counts else None
    return group


def _peaks_in_plan(xyz: np.ndarray, axis: Axis):
    """Positions that stay put across thin slices (normalised by each slice's outer radius): the
    legs of a lattice. Returns (peaks (k, 2) normalised, per-slice data) or ([], [])."""
    u, w, h, r = _frame(xyz, axis)
    top = float(h.max())
    order = np.argsort(h)
    hs = h[order]
    bins = 53
    hist = np.zeros((bins, bins))
    slices = []
    for y in np.linspace(0.1 * top, 0.9 * top, 17):
        lo, hi = np.searchsorted(hs, [y - 0.25, y + 0.25])
        sel = order[lo:hi]
        if len(sel) < 40:
            continue
        big = float(np.percentile(r[sel], 98))
        if big <= 0:
            continue
        nu, nw = u[sel] / big, w[sel] / big
        slices.append((y, sel, big))
        ix = np.clip(((nu + 1.05) / 0.04).astype(int), 0, bins - 1)
        iw = np.clip(((nw + 1.05) / 0.04).astype(int), 0, bins - 1)
        np.add.at(hist, (ix, iw), 1)
    if not slices:
        return np.zeros((0, 2)), []
    smooth = ndimage.uniform_filter(hist, size=3, mode="constant") * 9
    total = hist.sum()
    peak = (smooth == ndimage.maximum_filter(smooth, size=9)) & (smooth > 0.02 * total)
    pk = np.argwhere(peak)
    pk = pk[np.argsort(-smooth[tuple(pk.T)])]
    vals = smooth[tuple(pk.T)]
    # legs stand clear of the rest: a gap of at least 1.8 times after the 3rd or 4th strongest
    keep = 0
    for k in (4, 3):
        if len(vals) >= k and (len(vals) == k or vals[k - 1] > 1.8 * vals[k]):
            keep = k
            break
    pk = pk[:keep]
    pos = [(i * 0.04 - 1.05 + 0.02, j * 0.04 - 1.05 + 0.02) for i, j in pk]
    return np.array(pos).reshape(-1, 2), slices


def find_legs(xyz: np.ndarray, axis: Axis) -> MemberGroup:
    """The legs of a lattice: 3 or 4 plan positions that persist across slices (bracing wanders).
    Each leg is a line fitted through its per-slice centres, reported at the base."""
    group = MemberGroup("leg")
    if len(xyz) < 200:
        return group
    peaks, slices = _peaks_in_plan(xyz, axis)
    if not 3 <= len(peaks) <= 4:
        return group
    u, w, _h, _ = _frame(xyz, axis)
    lines = []
    for pu, pw in peaks:
        ys, us, ws, sizes, support = [], [], [], [], 0
        for y, sel, big in slices:
            d = np.hypot(u[sel] / big - pu, w[sel] / big - pw)
            near = sel[d < 0.1]
            if len(near) < 5:
                continue
            cu, cw = float(u[near].mean()), float(w[near].mean())
            ys.append(y)
            us.append(cu)
            ws.append(cw)
            dd = np.hypot(u[sel] - cu, w[sel] - cw)
            sizes.append(2 * float(np.median(dd[dd < 0.2])) if (dd < 0.2).sum() > 3 else 0.0)
            support += len(near)
        if len(ys) < 8:
            return MemberGroup("leg")
        lines.append(
            (np.polyfit(ys, us, 1), np.polyfit(ys, ws, 1), float(np.median(sizes)), support, ys, us, ws)
        )
    resid = []
    for cu, cw, size, support, ys, us_all, ws_all in lines:
        u0, w0 = cu[1], cw[1]
        p = axis.from_frame(float(u0), float(w0), 0.0)
        c0 = axis.from_frame(0.0, 0.0, 0.0)
        az = math.degrees(math.atan2(p[0] - c0[0], -(p[2] - c0[2]))) % 360.0
        group.items.append(Item(tuple(float(v) for v in p), size, support, az, None, None))
        resid.append(
            float(np.sqrt(np.mean((np.polyval(cu, ys) - us_all) ** 2 + (np.polyval(cw, ys) - ws_all) ** 2)))
        )
    group.residual_m = float(np.mean(resid))
    group.items.sort(key=lambda i: i.azimuth_deg or 0.0)
    group.regularity = _regularity(
        [math.hypot(*(np.array(i.centre) - np.asarray(axis.point))[[0, 2]]) for i in group.items]
    )
    group.extra["norm"] = [tuple(map(float, p)) for p in peaks]
    return group


def find_bays(xyz: np.ndarray, axis: Axis, legs: MemberGroup) -> dict[str, float] | None:
    """The bay height of a braced lattice and the number of bays: bracing meets the legs at the bay
    boundaries and crosses the faces between, so the mean plan distance of points from the legs is
    periodic in height; its autocorrelation peak is the bay height."""
    norm = legs.extra.get("norm")
    if not norm or len(xyz) < 500:
        return None
    u, w, h, r = _frame(xyz, axis)
    top = float(h.max())
    order = np.argsort(h)
    hs = h[order]
    step = 0.2
    ys = np.arange(0.05 * top, 0.9 * top, step)
    sig = []
    for y in ys:
        lo, hi = np.searchsorted(hs, [y - step, y + step])
        sel = order[lo:hi]
        if len(sel) < 20:
            sig.append(np.nan)
            continue
        big = float(np.percentile(r[sel], 98))
        pts = np.column_stack([u[sel], w[sel]]) / big
        d = np.min([np.hypot(pts[:, 0] - a, pts[:, 1] - b) for a, b in norm], axis=0)
        sig.append(float(np.mean(d)))
    s = np.array(sig)
    if np.isnan(s).mean() > 0.3:
        return None
    s = np.where(np.isnan(s), np.nanmean(s), s)
    s = s - np.polyval(np.polyfit(ys, s, 1), ys)
    ac = np.correlate(s, s, mode="full")[len(s) - 1 :]
    ac = ac / ac[0] if ac[0] > 0 else ac
    lo_lag, hi_lag = int(1.5 / step), int(min(top / 2, 0.5 * (ys[-1] - ys[0])) / step)
    if hi_lag <= lo_lag + 2:
        return None
    seg = ac[lo_lag:hi_lag]
    peaks = [
        i for i in range(1, len(seg) - 1) if seg[i] > seg[i - 1] and seg[i] >= seg[i + 1] and seg[i] > 0.2
    ]
    if not peaks:
        return None
    period = (peaks[0] + lo_lag) * step
    return {"height": float(period), "count": round(top / period)}


def find_antenna_candidates(xyz: np.ndarray, axis: Axis, taper: Taper | None = None) -> MemberGroup:
    """Compact objects standing out of the body in the upper half: beyond the shaft radius (`taper`)
    or, for an open lattice, beyond a straight envelope fitted to the lower half. Clusters in
    (height, plan position); `size` is the cluster's longest extent (a panel's height)."""
    group = MemberGroup("antenna-candidate")
    if len(xyz) < 100:
        return group
    u, w, h, r = _frame(xyz, axis)
    top = float(h.max())
    if taper is not None and taper.profile:
        env = _taper_r(taper, h) + 0.25
    else:
        order = np.argsort(h)
        ys = np.linspace(0.1 * top, 0.6 * top, 12)
        vals = []
        for y in ys:
            lo, hi = np.searchsorted(h[order], [y - 0.5, y + 0.5])
            sel = order[lo:hi]
            vals.append(float(np.percentile(r[sel], 98)) if len(sel) > 20 else np.nan)
        ok = ~np.isnan(vals)
        if ok.sum() < 4:
            return group
        coef = np.polyfit(ys[ok], np.array(vals)[ok], 1)
        env = np.polyval(coef, h) * 1.15 + 0.4
    m = (h > 0.5 * top) & (r > env)
    idx = np.flatnonzero(m)
    chord = np.column_stack([h[idx], u[idx], w[idx]])
    for c in _components(chord, 0.2, 40):
        sel = idx[c]
        if np.ptp(h[sel]) < 0.25:
            continue
        centre = xyz[sel].mean(axis=0)
        hc = float(h[sel].mean())
        az = float(_compass(axis, centre[None, :], np.array([hc]))[0])
        size = float(max(np.ptp(h[sel]), np.ptp(u[sel]), np.ptp(w[sel])))
        group.items.append(Item(tuple(float(v) for v in centre), size, len(sel), az, None, None))
    group.items.sort(key=lambda i: (i.azimuth_deg or 0.0, i.centre[1]))
    return group


def find_platforms(xyz: np.ndarray, axis: Axis, taper: Taper) -> MemberGroup:
    """Horizontal plates and rings standing out of the shaft: height bands where points more than
    0.4 m proud of the shaft spread round at least a third of the azimuths. `size` is the diameter."""
    group = MemberGroup("platform")
    if len(xyz) == 0 or not taper.profile:
        return group
    _u, _w, h, r = _frame(xyz, axis)
    base_r = _taper_r(taper, h)
    proud = (r - base_r > 0.4) & (h > 0) & (h <= taper.profile[-1][0] + 0.5)
    idx = np.flatnonzero(proud)
    if len(idx) < 50:
        return group
    az = _compass(axis, xyz[idx], h[idx])
    band = np.floor(h[idx] / 0.5).astype(int)
    found = []
    for b in np.unique(band):
        sel = band == b
        if sel.sum() < 100:
            continue
        counts = np.bincount((az[sel] // 10).astype(int) % 36, minlength=36)
        if (counts >= 2).sum() >= 12:
            found.append((float(h[idx][sel].mean()), int(sel.sum()), float(np.percentile(r[idx][sel], 95))))
    merged: list[list[tuple[float, int, float]]] = []
    for f in found:
        if merged and f[0] - merged[-1][-1][0] <= 1.0:
            merged[-1].append(f)
        else:
            merged.append([f])
    for run in merged:
        hc = float(np.average([f[0] for f in run], weights=[f[1] for f in run]))
        p = axis.from_frame(0.0, 0.0, hc)
        group.items.append(
            Item(tuple(float(v) for v in p), 2 * max(f[2] for f in run), sum(f[1] for f in run))
        )
        group.levels.append(round(hc, 1))
    return group


def _fill_ratio(xyz: np.ndarray, axis: Axis, seed: int = 0) -> float:
    """How solid the cross sections are: the share of a slice's points that lie on one circle,
    median over 15 slices (one platform or crown slice cannot move a median)."""
    u, w, h, _r = _frame(xyz, axis)
    top = float(h.max())
    order = np.argsort(h)
    hs = h[order]
    rng = np.random.default_rng(seed)
    shares = []
    for y in np.linspace(0.1 * top, 0.9 * top, 15):
        lo, hi = np.searchsorted(hs, [y - 0.5, y + 0.5])
        sel = order[lo:hi]
        if len(sel) < 40:
            continue
        uw = np.column_stack([u[sel], w[sel]])
        fit = fit_ring(uw, rng)
        if fit is None:
            shares.append(0.0)
            continue
        cu, cw, rad = fit[:3]
        on = np.abs(np.hypot(uw[:, 0] - cu, uw[:, 1] - cw) - rad) < 0.03 * rad
        ang = np.degrees(np.arctan2(uw[on, 0] - cu, uw[on, 1] - cw)) % 360.0
        seen = (np.bincount((ang // 10).astype(int) % 36, minlength=36) >= 2).sum() / 36
        # a scan from one side sees about 0.75 of a ring: that still counts as a whole ring
        shares.append(float(on.mean()) * min(1.0, seen / 0.7))
    return float(np.median(shares)) if shares else 0.0


def family_hints(
    xyz: np.ndarray,
    axis: Axis,
    slices: list[SliceFit],
    members: list[MemberGroup],
    seed: int = 0,
) -> FamilyHints:
    """A suggested family with reasons; the caller never has to accept it.

    fill ratio: how solid the sections are (see `_fill_ratio`); slenderness: height over the base
    footprint; suggested: lattice for a low fill with 3 or 4 legs; chimney when flues stand at the
    crown; flare for a solid slender shaft whose top ring is 0.5 to 0.95 of the shaft radius (a
    burner tip); monopole for a solid slender shaft with no flues; else chimney.
    """
    by = {g.kind: g for g in members}
    flues = by.get("flue", MemberGroup("flue")).items
    legs = by.get("leg", MemberGroup("leg")).items
    ants = by.get("antenna-candidate", MemberGroup("antenna-candidate")).items
    u, w, h, _r = _frame(xyz, axis)
    top = float(h.max()) if len(xyz) else 0.0
    base = h < max(0.05 * top, 0.5)
    foot = max(float(np.ptp(u[base])), float(np.ptp(w[base]))) if base.sum() > 3 else 0.0
    slender = top / foot if foot > 0 else 0.0
    fill = _fill_ratio(xyz, axis, seed) if len(xyz) > 200 else 0.0
    reasons = [f"fill {fill:.2f}", f"slenderness {slender:.1f}"]
    sectors = len({round(i.azimuth_deg / 30) % 12 for i in ants if i.azimuth_deg is not None})
    # a burner tip: the topmost ring against the shaft below it
    tip = False
    if len(xyz) > 200 and not flues:
        sel = np.flatnonzero(h > top - max(2.0, 0.04 * top))
        lower = np.flatnonzero((h > 0.6 * top) & (h < 0.9 * top))
        if len(sel) > 60 and len(lower) > 60:
            rng = np.random.default_rng(seed)
            a = fit_ring(np.column_stack([u[sel], w[sel]]), rng)
            b = fit_ring(np.column_stack([u[lower], w[lower]]), rng)
            tip = bool(a and b and 0.5 <= a[2] / b[2] <= 0.95 and a[4] > 0.6 * len(sel))
    if fill < 0.35 and 3 <= len(legs) <= 4:
        family = "telecom-lattice"
        reasons.append(f"{len(legs)} legs in an open frame")
        features = sectors
    elif flues:
        family = "chimney"
        reasons.append(f"{len(flues)} flues stand at the crown")
        features = len(flues)
    elif tip and fill > 0.6:
        family = "flare"
        reasons.append("a narrower tip ring on a solid slender shaft")
        features = 1
    elif fill > 0.6 and slender > 15:
        family = "telecom-monopole"
        reasons.append("a single solid slender pole with no flues")
        features = max(sectors, 1 if ants else 0)
    else:
        family = "chimney"
        reasons.append("a wide solid shaft")
        features = 0
    return FamilyHints(fill, slender, int(features), family, reasons)
