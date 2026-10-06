"""Candidate model parts from a placed drawing: tanks, buildings, skids and pipes with hints.

Geometry is taken to the local frame first (metres, x east, z south), so the "within 3 m" rules
hold whatever the drawing units or the control point scale. Every part is a draft
(``aio.procmodel/1``, data-conventions section 15) with ``origin.by = 'drawing'``.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import shapely
from shapely.geometry import LineString, Point, Polygon

from .dxf import Entity
from .place import Placement

NEAR_M = 3.0
MIN_RADIUS_M = 0.3
MIN_AREA_M2 = 1.0
RIGHT_ANGLE_TOL_DEG = 2.0

TAG_RX = re.compile(r"^[A-Z]{1,4}-?\d{1,5}[A-Z]?$")
DN_RX = re.compile(r"\bDN\s*(\d+(?:\.\d+)?)", re.I)
NB_RX = re.compile(r"\b(\d+(?:\.\d+)?)\s*NB\b", re.I)
DM_RX = re.compile(r"(?<![A-Za-z])D\s*=\s*(\d+(?:\.\d+)?)", re.I)
HEIGHT_RX = re.compile(
    r"(?<![A-Za-z])(?:height\s*[=:]?\s*|H\s*=\s*|HT(?:\s*[=:]\s*|\s+))([+-]?\d+(?:\.\d+)?)", re.I
)
EL_RX = re.compile(r"(?<![A-Za-z])EL\.?\s*[=:]?\s*([+-]?\s?\d+(?:\.\d+)?)", re.I)
ROOF_RX = re.compile(r"\b(cone|conical|dome|domed)\b", re.I)

TANK_LAYER = re.compile(r"tank|tk", re.I)
BOX_LAYER = re.compile(r"skid|rack|container|box", re.I)
PIPE_LAYER = re.compile(r"pipe|line", re.I)


@dataclass
class TextNote:
    xz: tuple[float, float]
    text: str
    tag: str | None = None
    height: float | None = None  # height= / H= / HT
    el: float | None = None  # EL: top elevation
    diameter: float | None = None  # metres
    roof: str | None = None


@dataclass
class Shape:
    entity: Entity
    geom: Polygon
    kind: str  # cylinder | extrusion | box
    notes: list[tuple[float, TextNote]] = field(default_factory=list)


def classify_text(xz: tuple[float, float], text: str) -> TextNote:
    note = TextNote(xz, text)
    for line in text.split("\n"):
        s = line.strip()
        m = DN_RX.search(s) or NB_RX.search(s)
        if m:
            note.diameter = float(m.group(1)) / 1000.0
            continue
        m = DM_RX.search(s)
        if m:
            note.diameter = float(m.group(1))
            continue
        if TAG_RX.match(s) and not s.upper().startswith("EL"):
            note.tag = note.tag or s
            continue
        m = HEIGHT_RX.search(s)
        if m:
            note.height = float(m.group(1))
        m = EL_RX.search(s)
        if m:
            note.el = float(m.group(1).replace(" ", ""))
        m = ROOF_RX.search(s)
        if m:
            note.roof = "cone" if m.group(1).lower().startswith("con") else "dome"
    return note


def _is_rectangle(pts: np.ndarray) -> bool:
    if len(pts) != 4:
        return False
    for i in range(4):
        a = pts[i - 1] - pts[i]
        b = pts[(i + 1) % 4] - pts[i]
        na, nb = np.linalg.norm(a), np.linalg.norm(b)
        if na < 1e-9 or nb < 1e-9:
            return False
        ang = math.degrees(math.acos(max(-1.0, min(1.0, float(a @ b / (na * nb))))))
        if abs(ang - 90.0) > RIGHT_ANGLE_TOL_DEG:
            return False
    return True


def _ring(e: Entity, place: Placement) -> np.ndarray:
    pts = place.apply(np.array(e.points))
    if len(pts) > 1 and np.allclose(pts[0], pts[-1]):
        pts = pts[:-1]
    keep = [0]
    for i in range(1, len(pts)):
        if np.linalg.norm(pts[i] - pts[keep[-1]]) > 1e-6:
            keep.append(i)
    return pts[keep]


def ccw_from_above(ring: np.ndarray) -> np.ndarray:
    """``[x, z]`` ring counter-clockwise seen from above: positive area in the (x, -z) plane."""
    x, nz = ring[:, 0], -ring[:, 1]
    area = 0.5 * float(np.sum(x * np.roll(nz, -1) - np.roll(x, -1) * nz))
    return ring if area > 0 else ring[::-1]


def yaw_of(direction_xz: np.ndarray) -> float:
    """Counter-clockwise turn seen from above from +x (east) toward north, degrees in [-180, 180]."""
    dx, dz = float(direction_xz[0]), float(direction_xz[1])
    yaw = math.degrees(math.atan2(-dz, dx))
    return max(-180.0, min(180.0, yaw))


def _r(v: float, n: int = 3) -> float:
    out = round(float(v), n)
    return 0.0 if out == 0 else out


def build_parts(
    entities: list[Entity],
    place: Placement,
    file_rel: str,
    log=lambda m, level="info": None,
) -> tuple[list[dict[str, Any]], int]:
    """Draft parts and the number of height hints found in the text."""
    k = place.metres_per_unit
    base_y = place.base_y
    notes: list[TextNote] = []
    shapes: list[Shape] = []
    pipes: list[tuple[Entity, LineString]] = []
    for e in entities:
        if e.type in ("TEXT", "MTEXT") and e.text:
            xz = place.apply(np.array(e.points[:1]))[0]
            notes.append(classify_text((float(xz[0]), float(xz[1])), e.text))
        elif e.type == "CIRCLE" and e.center is not None and e.radius is not None:
            r = e.radius * k
            if r < MIN_RADIUS_M:
                continue
            c = place.apply(np.array([e.center]))[0]
            shapes.append(Shape(e, Point(c).buffer(r, quad_segs=32), "cylinder"))
        elif e.type in ("LWPOLYLINE", "POLYLINE") and e.closed:
            ring = _ring(e, place)
            if len(ring) < 3:
                continue
            poly = Polygon(ring)
            if not poly.is_valid:
                poly = shapely.make_valid(poly)
                if poly.geom_type != "Polygon":
                    continue
            if poly.area < MIN_AREA_M2:
                continue
            kind = "box" if BOX_LAYER.search(e.layer) and _is_rectangle(ring) else "extrusion"
            shapes.append(Shape(e, poly, kind))
        elif e.type in ("LINE", "LWPOLYLINE", "POLYLINE") and not e.closed and PIPE_LAYER.search(e.layer):
            pts = place.apply(np.array(e.points))
            if len(pts) >= 2 and LineString(pts).length > 0:
                pipes.append((e, LineString(pts)))
    hints = sum(1 for n in notes if n.height is not None or n.el is not None)
    # text near or inside a shape belongs to it: the containing shape (the smallest one), else the
    # nearest within NEAR_M
    for n in notes:
        if n.tag is None and n.height is None and n.el is None and n.roof is None:
            continue
        p = Point(n.xz)
        inside = [s for s in shapes if s.geom.contains(p)]
        if inside:
            s = min(inside, key=lambda s: s.geom.area)
            s.notes.append((0.0, n))
            continue
        near = [(s.geom.distance(p), s) for s in shapes]
        near = [(d, s) for d, s in near if d <= NEAR_M]
        if near:
            d, s = min(near, key=lambda t: t[0])
            s.notes.append((d, n))

    parts: list[dict[str, Any]] = []
    counters: dict[str, int] = {}
    used: set[str] = set()

    def new_id(e: Entity) -> str:
        pid = f"dxf-{e.id}"
        base, i = pid, 2
        while pid in used:
            pid, i = f"{base}-{i}", i + 1
        used.add(pid)
        return pid

    def name_for(cls: str) -> str:
        counters[cls] = counters.get(cls, 0) + 1
        return f"{cls.capitalize()} {counters[cls]}"

    def origin(e: Entity) -> dict[str, Any]:
        return {"by": "drawing", "file": file_rel, "layer": e.layer, "entity": e.handle}

    def height_of(s: Shape) -> tuple[float | None, str | None, str | None]:
        h = tag = roof = None
        for _, n in sorted(s.notes, key=lambda t: t[0]):
            if h is None and n.height is not None and n.height > 0:
                h = n.height
            elif h is None and n.el is not None:
                if n.el - base_y > 0:
                    h = n.el - base_y
                else:
                    log(
                        f'The elevation "{n.text}" near {s.entity.type} {s.entity.handle} is not above '
                        f"the base height {base_y:g} m; it is ignored.",
                        "warn",
                    )
            if tag is None and n.tag:
                tag = n.tag
            if roof is None and n.roof:
                roof = n.roof
        return h, tag, roof

    for s in shapes:
        e = s.entity
        h, tag, roof = height_of(s)
        part: dict[str, Any] = {"kind": s.kind, "id": new_id(e)}
        if s.kind == "cylinder":
            assert e.center is not None and e.radius is not None
            r = e.radius * k
            c = place.apply(np.array([e.center]))[0]
            cls = "tank" if TANK_LAYER.search(e.layer) or r >= 2 else "vessel"
            height = h if h is not None else min(20.0, max(2.0, 2 * r))
            part.update(
                {
                    "name": name_for(cls),
                    "class": cls,
                    "base": [_r(c[0]), _r(base_y), _r(c[1])],
                    "radius": _r(r),
                    "height": _r(height),
                    "roof": roof or "flat",
                }
            )
            if roof:
                part["roofHeight"] = _r(0.2 * r)
        elif s.kind == "box":
            ring = _ring(e, place)
            e0, e1 = ring[1] - ring[0], ring[2] - ring[1]
            along, across = (e0, e1) if np.linalg.norm(e0) >= np.linalg.norm(e1) else (e1, e0)
            if yaw_of(along) > 90 or yaw_of(along) <= -90:
                along = -along
            c = ring.mean(0)
            cls = next(
                (w for w in ("skid", "rack", "container") if re.search(w, e.layer, re.I)),
                "skid",
            )
            height = h if h is not None else 3.0
            part.update(
                {
                    "name": name_for(cls),
                    "class": cls,
                    "base": [_r(c[0]), _r(base_y), _r(c[1])],
                    "size": [_r(np.linalg.norm(along)), _r(height), _r(np.linalg.norm(across))],
                    "yawDeg": _r(yaw_of(along), 2),
                }
            )
        else:
            coords = np.array(s.geom.exterior.coords)[:-1]
            fp = ccw_from_above(coords)
            height = h if h is not None else 4.0
            part.update(
                {
                    "name": name_for("building"),
                    "class": "building",
                    "footprint": [[_r(x), _r(z)] for x, z in fp],
                    "baseY": _r(base_y),
                    "height": _r(height),
                }
            )
        if tag:
            part["tag"] = tag
        part["status"] = "draft"
        part["confidence"] = 0.8 if h is not None else 0.4
        part["origin"] = origin(e)
        parts.append(part)

    for e, line in pipes:
        el = dia = None
        best_el = best_d = NEAR_M + 1
        for n in notes:
            d = line.distance(Point(n.xz))
            if d > NEAR_M:
                continue
            if n.el is not None and d < best_el:
                el, best_el = n.el, d
            if n.diameter is not None and n.diameter > 0 and d < best_d:
                dia, best_d = n.diameter, d
        y = base_y + el if el is not None else base_y + 1.0
        pts = np.array(line.coords)
        part = {
            "kind": "pipe",
            "id": new_id(e),
            "name": name_for("pipe"),
            "class": "pipe",
            "points": [[_r(x), _r(y), _r(z)] for x, z in pts],
            "diameter": _r(dia if dia is not None else 0.3, 4),
            "status": "draft",
            "confidence": 0.7 if dia is not None else 0.4,
            "origin": origin(e),
        }
        parts.append(part)
    return parts, hints
