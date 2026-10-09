"""Haul-road centrelines: chainage, position, direction and curvature along a drawn polyline, a design
alignment (``aio.alignment/1``) or a design linework layer (data-conventions sections 28 and 30).

- **Chainage** runs from 0 at the first point. A design alignment also carries its own stationing
  (start station and equations, ``design/alignment.py``); a polyline's station is its chainage.
- **Direction** is a bearing, radians clockwise from grid north. **Curvature** is the rate of change
  of the bearing along the chainage (1/m): positive turns right (clockwise seen from above),
  negative turns left. An alignment's curvature is exact (lines 0, arcs 1/R, clothoids linear); a
  polyline's is the bearing change over ``CURVE_WINDOW_M`` (a drawn line has a kink at each vertex,
  which says nothing about the road's radius on its own).
- **Offsets** across the road are positive to the **left** inside this package; results name the
  side ("left", "right") so no sign convention leaks out.
"""

from __future__ import annotations

import bisect
import hashlib
import itertools
import json
import math
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import numpy as np

from ..design import alignment as al_math
from ..runtime import JobError

#: A polyline's direction at a chainage: the chord over this many metres either side.
DIRECTION_HALF_M = 5.0
#: A polyline's curvature: the change of direction over this many metres.
CURVE_WINDOW_M = 20.0
#: Vertices closer than this are one point.
MIN_SEGMENT_M = 1e-6


class Centreline:
    """A horizontal centreline: ``length`` metres of chainage."""

    length: float
    #: ``drawn``, ``alignment`` or ``linework``.
    source: str
    name: str

    def point(self, s: float) -> tuple[float, float]:  # pragma: no cover - interface
        raise NotImplementedError

    def bearing(self, s: float) -> float:  # pragma: no cover - interface
        raise NotImplementedError

    def curvature(self, s: float) -> float:  # pragma: no cover - interface
        raise NotImplementedError

    def station(self, s: float) -> tuple[float, int]:
        """(station, station region) of a chainage; a polyline's station is its chainage."""
        return s, 0

    def label(self, s: float) -> str:
        return al_math.format_station(self.station(s)[0])

    def points(self, s: Sequence[float]) -> tuple[np.ndarray, np.ndarray]:
        pts = [self.point(float(x)) for x in s]
        return np.array([p[0] for p in pts]), np.array([p[1] for p in pts])

    def left_normal(self, s: float) -> tuple[float, float]:
        b = self.bearing(s)
        return -math.cos(b), math.sin(b)

    def dense(self, s0: float, s1: float, step: float = 1.0) -> list[tuple[float, float]]:
        """Points every ``step`` metres from ``s0`` to ``s1`` (both included)."""
        n = max(1, math.ceil((s1 - s0) / step))
        return [self.point(s0 + (s1 - s0) * k / n) for k in range(n + 1)]


class PolylineCentreline(Centreline):
    def __init__(self, pts: Sequence[Sequence[float]], source: str, name: str):
        clean: list[tuple[float, float]] = []
        for p in pts:
            q = (float(p[0]), float(p[1]))
            if not all(math.isfinite(v) for v in q):
                raise JobError("The centreline has a point that is not a number.")
            if not clean or math.dist(clean[-1], q) > MIN_SEGMENT_M:
                clean.append(q)
        if len(clean) < 2:
            raise JobError("The centreline needs at least two distinct points.")
        self.pts = clean
        self.cum = [0.0]
        for a, b in itertools.pairwise(clean):
            self.cum.append(self.cum[-1] + math.dist(a, b))
        self.length = self.cum[-1]
        self.source = source
        self.name = name

    def point(self, s: float) -> tuple[float, float]:
        s = min(max(s, 0.0), self.length)
        i = min(max(bisect.bisect_right(self.cum, s) - 1, 0), len(self.pts) - 2)
        a, b = self.pts[i], self.pts[i + 1]
        seg = self.cum[i + 1] - self.cum[i]
        f = (s - self.cum[i]) / seg if seg > 0 else 0.0
        return a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f

    def bearing(self, s: float) -> float:
        h = min(DIRECTION_HALF_M, self.length / 2)
        lo, hi = max(0.0, s - h), min(self.length, s + h)
        if hi - lo < 1e-9:
            lo, hi = 0.0, self.length
        a, b = self.point(lo), self.point(hi)
        return al_math.bearing(a, b)

    def curvature(self, s: float) -> float:
        w = min(CURVE_WINDOW_M, self.length)
        lo = min(max(s - w / 2, 0.0), self.length - w)
        hi = lo + w
        if w <= 2 * DIRECTION_HALF_M:
            return 0.0
        d = self.bearing(hi) - self.bearing(lo)
        d = (d + math.pi) % (2 * math.pi) - math.pi
        return d / w


class AlignmentCentreline(Centreline):
    """A design alignment (``aio.alignment/1``), with its stationing."""

    def __init__(self, doc: dict[str, Any], name: str):
        els = doc.get("elements")
        if not isinstance(els, list) or not els:
            raise JobError(f'The alignment "{name}" has no elements.')
        self.doc = doc
        self.name = name
        self.source = "alignment"
        self.length = al_math.total_length(doc)
        if self.length <= 0:
            raise JobError(f'The alignment "{name}" has no length.')
        try:
            al_math.regions(doc)
        except ValueError as e:
            raise JobError(f'The alignment "{name}": {e}.') from e
        self.starts = [0.0]
        for el in els[:-1]:
            self.starts.append(self.starts[-1] + al_math.element_length(el))

    def _at(self, s: float) -> tuple[dict[str, Any], float]:
        s = min(max(s, 0.0), self.length)
        i = min(max(bisect.bisect_right(self.starts, s) - 1, 0), len(self.starts) - 1)
        return self.doc["elements"][i], s - self.starts[i]

    def point(self, s: float) -> tuple[float, float]:
        e, n, _ = al_math.point_at(self.doc, min(max(s, 0.0), self.length))
        return e, n

    def bearing(self, s: float) -> float:
        return al_math.point_at(self.doc, min(max(s, 0.0), self.length))[2]

    def curvature(self, s: float) -> float:
        el, t = self._at(s)
        kind = el["type"]
        if kind == "line":
            return 0.0
        sigma = 1.0 if el["rot"] == "cw" else -1.0
        if kind == "arc":
            return sigma / float(el["radius"])
        k1 = 0.0 if el.get("radiusStart") is None else 1.0 / float(el["radiusStart"])
        k2 = 0.0 if el.get("radiusEnd") is None else 1.0 / float(el["radiusEnd"])
        return sigma * (k1 + (k2 - k1) * t / float(el["length"]))

    def station(self, s: float) -> tuple[float, int]:
        return al_math.station_at(self.doc, min(max(s, 0.0), self.length))


# ----------------------------------------------------------------------------------- resolving


def _read_json(path: Path, what: str) -> Any:
    try:
        return json.loads(path.read_text("utf-8"))
    except (OSError, ValueError) as e:
        raise JobError(f"{what} could not be read: {e}") from e


def _longest_line(doc: Any, name: str) -> list[list[float]]:
    """The longest LineString (or MultiLineString part) of a GeoJSON linework layer."""
    best: list[list[float]] = []
    best_len = -1.0
    feats = doc.get("features") if isinstance(doc, dict) else None
    for f in feats or []:
        g = (f or {}).get("geometry") or {}
        parts = (
            [g.get("coordinates")]
            if g.get("type") == "LineString"
            else (g.get("coordinates") or [])
            if g.get("type") == "MultiLineString"
            else []
        )
        for line in parts:
            if not isinstance(line, list) or len(line) < 2:
                continue
            length = sum(math.dist(a[:2], b[:2]) for a, b in itertools.pairwise(line))
            if length > best_len:
                best, best_len = line, length
    if not best:
        raise JobError(f'The linework layer "{name}" has no line to follow.')
    return best


def resolve_centreline(project: Path, spec: Any) -> tuple[Centreline, dict[str, Any]]:
    """The centreline of ``HaulAnalyseParams.centreline`` and a record of what it was made from."""
    if isinstance(spec, list):
        c = PolylineCentreline(spec, "drawn", "Drawn centreline")
        return c, {"source": "drawn", "name": c.name, "lengthM": c.length, "points": len(c.pts)}
    did, lid = str(spec["design"]), str(spec["layer"])
    designs = _read_json(project / "survey" / "designs.json", "The designs list")
    entry = next((d for d in designs.get("designs") or [] if d.get("id") == did), None)
    layer = next((x for x in (entry or {}).get("layers") or [] if x.get("id") == lid), None)
    if entry is None or layer is None:
        raise JobError(f'The design layer "{did}, {lid}" is not in the designs list.')
    name = f"{entry.get('name') or did}, {layer.get('name') or lid}"
    path = project / "survey" / "designs" / did / str(layer.get("file"))
    kind = layer.get("kind")
    if kind == "alignment":
        doc = _read_json(path, f'The alignment "{name}"')
        c: Centreline = AlignmentCentreline(doc, name)
    elif kind == "linework":
        line = _longest_line(_read_json(path, f'The linework "{name}"'), name)
        c = PolylineCentreline(line, "linework", name)
    else:
        raise JobError(f'"{name}" is a {kind} layer; pick an alignment or a linework (polyline) layer.')
    sha = "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()
    return c, {
        "source": c.source,
        "name": name,
        "lengthM": c.length,
        "design": did,
        "layer": lid,
        "sha256": sha,
    }
