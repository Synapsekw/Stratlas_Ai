"""The haul-road measurements of one station and the checks against the site's limits (HRD-1).

**A section** is a profile across the road at a station: heights of the prepared surface
(``survey/grid.py``, bilinear between posts) every ``step`` metres along the normal to the
centreline, ``SEARCH_HALF_M`` either side. Each side is read outward from the centreline:

1. **Running surface**: a least-squares line through the profile from ``inner`` (clear of the
   crown, which bilinear sampling rounds within a cell) outward, refitted as it grows. Where the
   profile leaves that line by more than ``EDGE_TOL_M`` (for at least ``PERSIST_M``) the surface
   ends: a berm or bank rises there, or the ground drops away.
2. **Edge**: where the face beyond meets the running surface line. The face is a least-squares
   line through its samples between 20 % and 80 % of its height (as the berm check tool does), so
   the edge sits where the slope breaks, not where the departure became visible.
3. **Berm**: a face that rises and comes back down within ``FACE_MAX_M`` is a berm. Its crest is
   where its inner and outer faces meet, but never higher than the highest sample plus what
   bilinear sampling can hide at a ridge (a quarter of a cell times the change of slope); a top
   flat over two cells or more is read as it is (the highest sample), since a sampled ridge is
   never flat over more than about a cell. Height is crest above the road edge;
   width is from the edge to where the outer face comes back down to the edge height. A face that
   keeps rising is a **bank** (a cut face: its height is what rises within ``FACE_MAX_M``); a face
   that drops is a **drop** (no berm, height 0).
4. **Cross fall** per side is the running surface line refitted from ``inner`` to the edge, as the
   fall away from the centreline in percent (positive falls, negative rises). Both sides falling
   is a crown, both rising a trough, one of each a one-way (superelevated) section.

**Stations** are every ``interval`` metres of chainage from 0 and the end of the road; the two end
sections are taken ``max(1 m, two cells)`` inside the road so they read the road rather than what
lies beyond its ends (the chainage they were taken at is the one reported).

**Grade** is the least-squares slope of the centreline profile over the ``GRADE_WINDOW_M`` metres
ahead of the station (behind it at the end of the road), in percent, positive uphill along the
chainage. A short window keeps a grade change at a station from averaging into its neighbour.

**Curves** are where the centreline's curvature is at least ``CURVE_MIN_K`` (a radius of 500 m or
less). There the crown gives way to superelevation: the cross fall range is not checked, and the
**superelevation** (the one-way part of the section, positive when the inside of the curve is
lower) fails only when it is adverse (the outside lower by more than ``ADVERSE_PCT``).

All values are SI (metres, percent for slopes); offsets are measured square to the centreline.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import numpy as np

from ..survey.grid import GridSurface, bilinear
from .centreline import Centreline

#: Version of this arithmetic (written into every run).
HAUL_ENGINE_VERSION = 1
SEARCH_HALF_M = 40.0
FACE_MAX_M = 8.0
EDGE_TOL_M = 0.15
PERSIST_M = 0.3
INITIAL_FIT_M = 4.0
REFIT_EVERY_M = 1.0
GRADE_WINDOW_M = 5.0
CURVE_MIN_K = 1 / 500
ADVERSE_PCT = 0.5
FLAT_PCT = 0.3
#: Samples this close to a berm's highest one belong to its top.
PLATEAU_TOL_M = 0.02
#: The share of the largest truck's wheel height a berm must reach (a common rule: half).
DEFAULT_WHEEL_SHARE = 0.5

CHECKS = ("width", "grade", "crossFall", "superelevation", "bermLeft", "bermRight")
LIMIT_KEYS = ("minWidthM", "maxGradePct", "crossFallMinPct", "crossFallMaxPct", "minBermHeightM")

Check = Callable[[], None]


def _no_check() -> None:
    return None


def min_berm_height(wheel_height_m: float, share: float = DEFAULT_WHEEL_SHARE) -> float:
    """The minimum berm height for a truck whose wheel is ``wheel_height_m`` tall: ``share`` of it."""
    if not (wheel_height_m > 0 and 0 < share <= 2):
        raise ValueError("The wheel height must be positive and the share between 0 and 2.")
    return wheel_height_m * share


def _fit(x: np.ndarray, y: np.ndarray) -> tuple[float, float] | None:
    """Least-squares line y = a + b x."""
    if x.size < 2:
        return None
    mx = float(x.mean())
    dx = x - mx
    sxx = float((dx * dx).sum())
    if sxx <= 0:
        return None
    b = float((dx * (y - y.mean())).sum()) / sxx
    return float(y.mean()) - b * mx, b


@dataclass
class Berm:
    #: ``berm``, ``bank`` (a face that keeps rising) or ``drop`` (the ground falls away).
    kind: str
    heightM: float
    widthM: float | None = None
    crestOffsetM: float | None = None

    def record(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "heightM": _r(self.heightM),
            "widthM": _r(self.widthM),
            "crestOffsetM": _r(self.crestOffsetM),
        }


@dataclass
class Side:
    """One side of a section, read outward from the centreline (``d`` is the distance from it)."""

    #: ``edge`` (found), ``none`` (no edge within the search) or ``no-data`` (the surface ends).
    state: str
    edgeM: float | None = None
    edgeZ: float | None = None
    #: dz per metre away from the centreline along the running surface.
    slope: float | None = None
    centreZ: float | None = None
    berm: Berm | None = None


def _r(v: float | None, nd: int = 4) -> float | None:
    return None if v is None or not math.isfinite(v) else round(float(v), nd)


def read_side(d: np.ndarray, z: np.ndarray, cell: float) -> Side:
    """Edge, running surface and berm of one side (``d`` ascending from 0, ``z`` NaN for no data)."""
    step = float(d[1] - d[0]) if d.size > 1 else cell
    inner = max(1.0, 1.5 * cell)
    margin = max(0.5, 1.5 * cell)
    ok = np.isfinite(z)
    i0 = int(np.searchsorted(d, inner - 1e-9))
    i1 = int(np.searchsorted(d, inner + INITIAL_FIT_M + 1e-9))
    first = slice(i0, i1)
    if ok[first].sum() < 3 or not ok[:i1].all():
        return Side("no-data")
    line = _fit(d[first], z[first])
    if line is None:
        return Side("no-data")
    a, b = line
    persist = max(1, math.ceil(PERSIST_M / step))
    last_fit = float(d[i1 - 1])
    keep = np.zeros(d.size, dtype=bool)
    keep[first] = True
    depart: int | None = None
    end_data: int | None = None
    for i in range(i1, d.size):
        if not ok[i]:
            end_data = i
            break
        r = z[i] - (a + b * d[i])
        if abs(r) > EDGE_TOL_M:
            run = z[i : i + persist] - (a + b * d[i : i + persist])
            if (
                np.all(np.isfinite(run))
                and np.all(np.sign(run) == np.sign(r))
                and np.all(np.abs(run) > EDGE_TOL_M)
            ):
                depart = i
                break
            continue
        if abs(r) < EDGE_TOL_M / 3:
            keep[i] = True
        if d[i] - last_fit >= REFIT_EVERY_M:
            refit = _fit(d[keep], z[keep])
            if refit is not None:
                a, b = refit
            last_fit = float(d[i])
    if depart is None:
        if end_data is None:
            return Side("none", slope=b, centreZ=a)
        e = float(d[end_data - 1])
        return Side("no-data", edgeM=e, edgeZ=a + b * e, slope=b, centreZ=a)

    res = z - (a + b * d)
    sigma = 1.0 if res[depart] > 0 else -1.0
    # the extreme of the departure: a crest (it comes back down) or the end of the search
    ext = depart
    peaked = False
    stop = float(d[depart]) + FACE_MAX_M
    for i in range(depart, d.size):
        if not ok[i] or d[i] > stop:
            break
        v = sigma * res[i]
        top = sigma * res[ext]
        if v > top:
            ext = i
        elif v < top - max(0.05, 0.3 * top):
            peaked = True
            break
    height = sigma * float(res[ext])
    # the inner face: samples between 20 % and 80 % of the height, back from the extreme
    band: list[int] = []
    for i in range(ext, -1, -1):
        v = sigma * res[i]
        if not ok[i] or v < 0.2 * height:
            break
        if v <= 0.8 * height:
            band.append(i)
    face = _fit(d[band], z[band]) if len(band) >= 2 else None
    edge = float(d[max(depart - 1, 0)])
    if face is not None and abs(face[1] - b) > 1e-9:
        cross = (face[0] - a) / (b - face[1])
        if float(d[max(depart - 1, 0)]) - FACE_MAX_M <= cross <= float(d[ext]):
            edge = cross
    # the running surface up to the edge
    run = keep & (d <= edge - margin)
    refit = _fit(d[run], z[run]) if run.sum() >= 3 else None
    if refit is not None:
        a, b = refit
    edge_z = a + b * edge
    if sigma < 0:
        berm = Berm("drop", 0.0)
    elif not peaked:
        berm = Berm("bank", float(z[ext]) - edge_z, None, None)
    else:
        berm = _berm(d, z, ok, ext, edge, edge_z, face, cell)
    return Side("edge", edge, edge_z, b, a, berm)


def _berm(
    d: np.ndarray,
    z: np.ndarray,
    ok: np.ndarray,
    ext: int,
    edge: float,
    edge_z: float,
    face: tuple[float, float] | None,
    cell: float,
) -> Berm:
    top = float(z[ext])
    hc = top - edge_z
    band: list[int] = []
    for i in range(ext, d.size):
        if not ok[i]:
            break
        v = float(z[i]) - edge_z
        if v < 0.2 * hc:
            break
        if v <= 0.8 * hc:
            band.append(i)
    outer = _fit(d[band], z[band]) if len(band) >= 2 else None
    crest_z, crest_d = top, float(d[ext])
    width = None
    # a top flat over two cells or more is read as it is: sampling hides nothing there
    lo = hi = ext
    while lo > 0 and ok[lo - 1] and z[lo - 1] >= top - PLATEAU_TOL_M:
        lo -= 1
    while hi < d.size - 1 and ok[hi + 1] and z[hi + 1] >= top - PLATEAU_TOL_M:
        hi += 1
    flat = float(d[hi] - d[lo]) >= 2 * cell
    if flat:
        crest_d = float(d[lo] + d[hi]) / 2
    if face is not None and outer is not None and face[1] > 0 > outer[1]:
        da = (outer[0] - face[0]) / (face[1] - outer[1])
        za = face[0] + face[1] * da
        # a ridge: where the faces meet, never above what sampling can hide there
        hide = 0.25 * abs(face[1] - outer[1]) * cell
        if not flat and edge <= da <= float(d[band[-1]]) + cell:
            crest_z = min(max(za, top), top + hide)
            crest_d = da
        toe = (edge_z - outer[0]) / outer[1]
        if toe > crest_d:
            width = toe - edge
    return Berm("berm", crest_z - edge_z, width, crest_d)


def sample_section(
    surface: GridSurface, cl: Centreline, s: float, step: float, half: float = SEARCH_HALF_M
) -> tuple[np.ndarray, np.ndarray]:
    """Offsets (left positive) and heights across the road at chainage ``s``."""
    k = round(half / step)
    o = step * np.arange(-k, k + 1, dtype=np.float64)
    e0, n0 = cl.point(s)
    nl = cl.left_normal(s)
    xs = (e0 - surface.origin_e) + o * nl[0]
    ys = (n0 - surface.origin_n) + o * nl[1]
    return o, bilinear(surface, xs, ys, 0.0, 0.0)


def grade_at(surface: GridSurface, cl: Centreline, s: float, cell: float) -> float | None:
    """Grade in percent over the ``GRADE_WINDOW_M`` ahead of ``s`` (behind it at the end)."""
    w = min(GRADE_WINDOW_M, cl.length)
    s0, s1 = (s, s + w) if s + w <= cl.length + 1e-9 else (max(0.0, s - w), s)
    step = max(0.05, min(0.5, cell / 2))
    n = max(2, round((s1 - s0) / step))
    ss = np.linspace(s0, s1, n + 1)
    e, nn = cl.points(ss)
    z = bilinear(surface, e - surface.origin_e, nn - surface.origin_n, 0.0, 0.0)
    ok = np.isfinite(z)
    if ok.sum() < 3:
        return None
    line = _fit(ss[ok], z[ok])
    return None if line is None else 100.0 * line[1]


def measure_station(surface: GridSurface, cl: Centreline, s: float) -> dict[str, Any]:
    """Every measurement of the section at chainage ``s`` (no checks)."""
    cell = float(surface.cell)
    step = max(0.05, min(0.25, cell / 2))
    o, z = sample_section(surface, cl, s, step)
    mid = int(np.argmin(np.abs(o)))
    left = read_side(o[mid:], z[mid:], cell)
    right = read_side(-o[: mid + 1][::-1], z[: mid + 1][::-1], cell)
    e, n = cl.point(s)
    k = cl.curvature(s)
    station, region = cl.station(s)
    zc = float(z[mid]) if math.isfinite(z[mid]) else None
    fall_l = None if left.slope is None else -100.0 * left.slope
    fall_r = None if right.slope is None else -100.0 * right.slope
    curve = abs(k) >= CURVE_MIN_K
    shape = None
    superelevation = None
    if fall_l is not None and fall_r is not None:
        if fall_l > FLAT_PCT and fall_r > FLAT_PCT:
            shape = "crown"
        elif fall_l < -FLAT_PCT and fall_r < -FLAT_PCT:
            shape = "trough"
        elif abs(fall_l) <= FLAT_PCT and abs(fall_r) <= FLAT_PCT:
            shape = "flat"
        else:
            shape = "one-way"
        if curve:
            # z = zc + a |o| + b o (o left positive): b is the one-way part; inside lower is positive
            b = ((-fall_l) - (-fall_r)) / 2.0
            superelevation = b * (1.0 if k > 0 else -1.0)
    width = (
        left.edgeM + right.edgeM
        if left.state == "edge"
        and right.state == "edge"
        and left.edgeM is not None
        and right.edgeM is not None
        else None
    )
    return {
        "chainageM": _r(s),
        "station": _r(station),
        "stationLabel": cl.label(s),
        "region": region,
        "e": _r(e),
        "n": _r(n),
        "z": _r(zc),
        "curvature": _r(k, 6),
        "radiusM": _r(1.0 / abs(k), 2) if curve else None,
        "turn": ("right" if k > 0 else "left") if curve else None,
        "widthM": _r(width),
        "edgeLeftM": _r(left.edgeM) if left.state == "edge" else None,
        "edgeRightM": _r(right.edgeM) if right.state == "edge" else None,
        "gradePct": _r(grade_at(surface, cl, s, cell)),
        "crossFallLeftPct": _r(fall_l),
        "crossFallRightPct": _r(fall_r),
        "shape": shape,
        "superelevationPct": _r(superelevation),
        "bermLeft": left.berm.record() if left.berm else None,
        "bermRight": right.berm.record() if right.berm else None,
        "sides": {"left": left.state, "right": right.state},
    }


# ----------------------------------------------------------------------------------- checks


def check_station(st: dict[str, Any], limits: dict[str, Any]) -> dict[str, str]:
    """``pass``, ``fail``, ``n/a`` (no limit, or not checked here) or ``no-data`` per check."""
    out: dict[str, str] = {}

    def judge(limit_set: bool, value: Any, ok: Callable[[Any], bool]) -> str:
        if not limit_set:
            return "n/a"
        if value is None:
            return "no-data"
        return "pass" if ok(value) else "fail"

    w_min = limits.get("minWidthM")
    out["width"] = judge(w_min is not None, st["widthM"], lambda v: v >= w_min)
    g_max = limits.get("maxGradePct")
    out["grade"] = judge(g_max is not None, st["gradePct"], lambda v: abs(v) <= g_max)
    lo, hi = limits.get("crossFallMinPct"), limits.get("crossFallMaxPct")
    if (lo is None and hi is None) or st["turn"] is not None:
        out["crossFall"] = "n/a"
    elif st["crossFallLeftPct"] is None or st["crossFallRightPct"] is None:
        out["crossFall"] = "no-data"
    else:
        falls = [abs(st["crossFallLeftPct"]), abs(st["crossFallRightPct"])]
        good = st["shape"] != "trough" and all(
            (lo is None or f >= lo) and (hi is None or f <= hi) for f in falls
        )
        out["crossFall"] = "pass" if good else "fail"
    if st["turn"] is None:
        out["superelevation"] = "n/a"
    elif st["superelevationPct"] is None:
        out["superelevation"] = "no-data"
    else:
        out["superelevation"] = "pass" if st["superelevationPct"] >= -ADVERSE_PCT else "fail"
    b_min = limits.get("minBermHeightM")
    for key, side in (("bermLeft", "left"), ("bermRight", "right")):
        berm = st[key]
        if b_min is None:
            out[key] = "n/a"
        elif berm is None or st["sides"][side] != "edge":
            out[key] = "no-data"
        else:
            out[key] = "pass" if berm["heightM"] >= b_min else "fail"
    return out


def status_of(checks: dict[str, str]) -> str:
    vals = checks.values()
    return "fail" if "fail" in vals else "no-data" if "no-data" in vals else "pass"


def chainages(length: float, interval: float) -> list[float]:
    """Every ``interval`` metres from 0, and the end of the road."""
    n = math.floor(length / interval + 1e-9)
    out = [k * interval for k in range(n + 1)]
    if length - out[-1] > 1e-6:
        out.append(length)
    return out


def analyse_road(
    surface: GridSurface,
    cl: Centreline,
    interval: float,
    limits: dict[str, Any],
    check: Check = _no_check,
    progress: Callable[[float, str], None] | None = None,
) -> list[dict[str, Any]]:
    """The sections of a road every ``interval`` metres, each measured and checked."""
    out = []
    ss = chainages(cl.length, interval)
    # the end sections are taken a little inside the road, so they read the road, not what lies
    # beyond its ends
    inset = min(max(1.0, 2.0 * float(surface.cell)), cl.length / 4)
    for k, s in enumerate(ss):
        check()
        st = measure_station(surface, cl, min(max(s, inset), cl.length - inset))
        st["checks"] = check_station(st, limits)
        st["status"] = status_of(st["checks"])
        out.append(st)
        if progress:
            progress((k + 1) / len(ss), f"Station {k + 1} of {len(ss)}")
    return out


def stretches(stations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Runs of consecutive failing stations, per check."""
    out = []
    for name in CHECKS:
        run: list[dict[str, Any]] = []
        for st in [*stations, None]:
            if st is not None and st["checks"].get(name) == "fail":
                run.append(st)
                continue
            if run:
                out.append(
                    {
                        "check": name,
                        "fromChainageM": run[0]["chainageM"],
                        "toChainageM": run[-1]["chainageM"],
                        "fromStation": run[0]["stationLabel"],
                        "toStation": run[-1]["stationLabel"],
                        "stations": len(run),
                    }
                )
                run = []
    return out


def summary(stations: list[dict[str, Any]]) -> dict[str, Any]:
    by_check = {
        name: {
            s: sum(1 for st in stations if st["checks"][name] == s)
            for s in ("pass", "fail", "n/a", "no-data")
        }
        for name in CHECKS
    }
    return {
        "stations": len(stations),
        "pass": sum(1 for st in stations if st["status"] == "pass"),
        "fail": sum(1 for st in stations if st["status"] == "fail"),
        "noData": sum(1 for st in stations if st["status"] == "no-data"),
        "checks": by_check,
    }
