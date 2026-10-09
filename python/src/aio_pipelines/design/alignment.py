"""Horizontal alignments (``aio.alignment/1``): point at a distance or station, station and offset of
a point, station equations and station labels.

Elements are dicts as ``AlignmentElement`` of ``@aio/schema`` ``designs.ts``, in metres in the
project CRS; bearings are radians clockwise from grid north. ``packages/survey/src/designs/
alignment.ts`` is the same arithmetic for the renderer and runs the same fixtures.

- **Lines and arcs** are exact.
- **Clothoids**: the curvature runs linearly from ``1/radiusStart`` to ``1/radiusEnd`` (0 for an
  infinite radius) over ``length``; the bearing is the integral of the curvature and the position
  the integral of (sin, cos) of the bearing, by 10-point Gauss-Legendre over pieces of at most
  5 m (well below 1e-9 m for road spirals). The inverse (station of a point) solves
  ``(P - C(s)) . T(s) = 0`` by bisection to 1e-10 m.
- **Offsets** are positive to the right of the direction of travel.
- **Stationing** starts at ``startStation``; an equation ``{back, ahead}`` means that where the
  incoming chainage reaches ``back``, stations continue from ``ahead``. The stretches between
  equations are *regions* 0, 1, ...; a station is unambiguous only with its region.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

# 10-point Gauss-Legendre nodes and weights on [-1, 1]
_GL_X = (
    -0.9739065285171717,
    -0.8650633666889845,
    -0.6794095682990244,
    -0.4333953941292472,
    -0.1488743389816312,
    0.1488743389816312,
    0.4333953941292472,
    0.6794095682990244,
    0.8650633666889845,
    0.9739065285171717,
)
_GL_W = (
    0.0666713443086881,
    0.1494513491505806,
    0.2190863625159820,
    0.2692667193099963,
    0.2955242247147529,
    0.2955242247147529,
    0.2692667193099963,
    0.2190863625159820,
    0.1494513491505806,
    0.0666713443086881,
)
PIECE_M = 5.0
EPS_S = 1e-9
#: a foot this far past an end still counts (coordinates in files are rounded to 1e-6 m)
END_TOL = 1e-5


def bearing(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Bearing from a to b, radians clockwise from grid north, in [0, 2 pi)."""
    t = math.atan2(b[0] - a[0], b[1] - a[1])
    return t % (2 * math.pi)


def _curv(r: float | None) -> float:
    return 0.0 if r is None else 1.0 / r


def _sigma(rot: str) -> float:
    # a clockwise turn (seen from above) turns right: the bearing grows
    return 1.0 if rot == "cw" else -1.0


def spiral_bearing(el: dict[str, Any], s: float) -> float:
    k1, k2, length = _curv(el["radiusStart"]), _curv(el["radiusEnd"]), el["length"]
    return el["dirStart"] + _sigma(el["rot"]) * (k1 * s + (k2 - k1) * s * s / (2 * length))


def spiral_point(el: dict[str, Any], s: float) -> tuple[float, float]:
    """Position at distance s along a clothoid element (numerical integral)."""
    e0, n0 = el["start"]
    if s <= 0:
        return e0, n0
    pieces = max(1, math.ceil(s / PIECE_M))
    h = s / pieces
    de = dn = 0.0
    for k in range(pieces):
        a = k * h
        for x, w in zip(_GL_X, _GL_W, strict=True):
            t = a + (x + 1) * h / 2
            th = spiral_bearing(el, t)
            de += w * math.sin(th)
            dn += w * math.cos(th)
    return e0 + de * h / 2, n0 + dn * h / 2


def element_point(el: dict[str, Any], s: float) -> tuple[float, float, float]:
    """(E, N, bearing) at distance s along one element (s from 0 to the element's length)."""
    kind = el["type"]
    if kind == "line":
        (e0, n0), (e1, n1) = el["start"], el["end"]
        length = math.hypot(e1 - e0, n1 - n0)
        b = bearing((e0, n0), (e1, n1))
        f = s / length if length > 0 else 0.0
        return e0 + (e1 - e0) * f, n0 + (n1 - n0) * f, b
    if kind == "arc":
        ce, cn = el["center"]
        e0, n0 = el["start"]
        r = el["radius"]
        phi0 = math.atan2(n0 - cn, e0 - ce)  # maths angle, counter-clockwise from east
        if el["rot"] == "ccw":
            phi = phi0 + s / r
            te, tn = -math.sin(phi), math.cos(phi)
        else:
            phi = phi0 - s / r
            te, tn = math.sin(phi), -math.cos(phi)
        return ce + r * math.cos(phi), cn + r * math.sin(phi), math.atan2(te, tn) % (2 * math.pi)
    e, n = spiral_point(el, s)
    return e, n, spiral_bearing(el, s) % (2 * math.pi)


def element_length(el: dict[str, Any]) -> float:
    return float(el["length"])


def total_length(al: dict[str, Any]) -> float:
    return sum(element_length(el) for el in al["elements"])


def point_at(al: dict[str, Any], distance: float) -> tuple[float, float, float]:
    """(E, N, bearing) at a distance from the alignment's start (clamped to its ends)."""
    els = al["elements"]
    rest = max(0.0, distance)
    for el in els:
        length = element_length(el)
        if rest <= length:
            return element_point(el, rest)
        rest -= length
    last = els[-1]
    return element_point(last, element_length(last))


# ---------------------------------------------------------------------------------------------
# stations


@dataclass(frozen=True)
class Region:
    """A stretch between station equations: distances [start, end) carry stations from ``station``."""

    index: int
    start: float
    end: float
    station: float


def regions(al: dict[str, Any]) -> list[Region]:
    """The station regions; raises ``ValueError`` when an equation lies outside the alignment."""
    length = total_length(al)
    out: list[Region] = []
    s0, st0 = 0.0, float(al["startStation"])
    for i, eq in enumerate(al.get("equations") or []):
        at = s0 + (float(eq["back"]) - st0)
        if at < s0 - EPS_S or at > length + EPS_S:
            raise ValueError(
                f"station equation {i + 1} (back {format_station(eq['back'])}) lies outside the alignment"
            )
        out.append(Region(i, s0, at, st0))
        s0, st0 = at, float(eq["ahead"])
    out.append(Region(len(out), s0, length, st0))
    return out


def station_at(al: dict[str, Any], distance: float) -> tuple[float, int]:
    """(station, region) at a distance along the alignment."""
    regs = regions(al)
    for r in regs:
        if distance < r.end or r is regs[-1]:
            return r.station + (distance - r.start), r.index
    raise AssertionError("unreachable")


def distance_at(al: dict[str, Any], station: float, region: int | None = None) -> float | None:
    """The distance along the alignment of a station (in a region, or the first that holds it)."""
    for r in regions(al):
        if region is not None and r.index != region:
            continue
        d = r.start + (station - r.station)
        if r.start - EPS_S <= d <= r.end + EPS_S:
            return min(max(d, r.start), r.end)
    return None


def point_at_station(
    al: dict[str, Any], station: float, region: int | None = None
) -> tuple[float, float, float] | None:
    d = distance_at(al, station, region)
    return None if d is None else point_at(al, d)


def _foot_on_line(el: dict[str, Any], p: tuple[float, float]) -> float:
    (e0, n0), (e1, n1) = el["start"], el["end"]
    de, dn = e1 - e0, n1 - n0
    ll = de * de + dn * dn
    return ((p[0] - e0) * de + (p[1] - n0) * dn) / math.sqrt(ll) if ll > 0 else 0.0


def _foot_on_arc(el: dict[str, Any], p: tuple[float, float]) -> float:
    ce, cn = el["center"]
    e0, n0 = el["start"]
    phi0 = math.atan2(n0 - cn, e0 - ce)
    phi = math.atan2(p[1] - cn, p[0] - ce)
    turn = (phi - phi0) if el["rot"] == "ccw" else (phi0 - phi)
    turn %= 2 * math.pi
    s = turn * el["radius"]
    length = el["length"]
    if s > length:
        # past the end: the nearer of "just past the end" and "just before the start"
        before = (2 * math.pi * el["radius"]) - s
        s = -before if before < s - length else s
    return s


def _foot_on_spiral(el: dict[str, Any], p: tuple[float, float]) -> list[float]:
    length = el["length"]

    def f(s: float) -> float:
        e, n, b = element_point(el, s)
        return (p[0] - e) * math.sin(b) + (p[1] - n) * math.cos(b)

    samples = 64
    feet: list[float] = []
    prev_s, prev_f = 0.0, f(0.0)
    if abs(prev_f) < 1e-12:
        feet.append(0.0)
    for k in range(1, samples + 1):
        s = length * k / samples
        fs = f(s)
        if abs(fs) < 1e-12:
            feet.append(s)
        elif prev_f * fs < 0:
            lo, hi, flo = prev_s, s, prev_f
            for _ in range(200):
                mid = (lo + hi) / 2
                fm = f(mid)
                if (fm < 0) == (flo < 0):
                    lo, flo = mid, fm
                else:
                    hi = mid
                if hi - lo < 1e-10:
                    break
            feet.append((lo + hi) / 2)
        prev_s, prev_f = s, fs
    return feet


@dataclass(frozen=True)
class StationOffset:
    station: float
    offset: float
    distance: float
    region: int
    element: int


def station_offset(al: dict[str, Any], e: float, n: float) -> StationOffset | None:
    """Station and offset (positive right) of a point; None when its foot is off the alignment."""
    p = (e, n)
    best: tuple[float, float, int] | None = None  # (|offset|, distance, element)
    at = 0.0
    for i, el in enumerate(al["elements"]):
        length = element_length(el)
        if el["type"] == "line":
            feet = [_foot_on_line(el, p)]
        elif el["type"] == "arc":
            feet = [_foot_on_arc(el, p)]
        else:
            feet = _foot_on_spiral(el, p)
        for s in feet:
            if s < -END_TOL or s > length + END_TOL:
                continue
            s = min(max(s, 0.0), length)
            fe, fn, _ = element_point(el, s)
            d = math.hypot(e - fe, n - fn)
            if best is None or d < best[0] - 1e-12:
                best = (d, at + s, i)
        at += length
    if best is None:
        return None
    dist = best[1]
    fe, fn, b = point_at(al, dist)
    te, tn = math.sin(b), math.cos(b)
    off = tn * (e - fe) - te * (n - fn)
    station, region = station_at(al, dist)
    return StationOffset(station, off, dist, region, best[2])


def format_station(station: float, decimals: int = 3) -> str:
    """``1+234.567``: thousands, a plus and the metres (negative stations keep their sign)."""
    sign = "-" if station < 0 else ""
    v = round(abs(station), decimals)
    km = int(v // 1000)
    rest = v - km * 1000
    width = 3 + (decimals + 1 if decimals > 0 else 0)
    return f"{sign}{km}+{rest:0{width}.{decimals}f}"


def station_labels(al: dict[str, Any], interval: float | None = None) -> list[tuple[float, float, str]]:
    """(distance, station, label) at every multiple of the interval in each region, ends included."""
    step = float(interval or al.get("intervalM") or 20.0)
    out: list[tuple[float, float, str]] = []
    for r in regions(al):
        end_station = r.station + (r.end - r.start)
        k = math.ceil(r.station / step - 1e-9)
        while k * step <= end_station + 1e-9:
            st = k * step
            out.append((r.start + (st - r.station), st, format_station(st, 0 if step >= 1 else 2)))
            k += 1
    return out


def check_continuity(al: dict[str, Any], tol: float = 0.001) -> list[str]:
    """Gaps between consecutive elements larger than ``tol`` metres, as messages."""
    issues = []
    els = al["elements"]
    for i in range(1, len(els)):
        a, b = els[i - 1], els[i]
        e, n, _ = element_point(a, element_length(a))
        gap = math.hypot(b["start"][0] - e, b["start"][1] - n)
        if gap > tol:
            issues.append(f"element {i + 1} starts {gap:.3f} m from the end of element {i}")
    return issues
