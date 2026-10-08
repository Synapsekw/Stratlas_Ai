"""LandXML 1.2 designs: ``Surfaces`` (TIN with breaklines and boundaries), ``CgPoints`` and horizontal
``Alignments`` (lines, arcs, clothoid spirals, station equations).

Read with the standard library's expat, streaming, with no tree of the whole file:

- a document type declaration (``<!DOCTYPE``), and with it every entity declaration and external
  entity, is refused at its line: no entity is ever expanded and nothing outside the file is read;
- every count is capped while reading (``model.py``), so a hostile file cannot make an unbounded
  allocation; the file size is capped before reading.

LandXML lists coordinates **northing first** (``N E Z``); everything returned is (E, N, Z) in the
file's units. Point ids of a surface's ``Pnts`` may be any text; faces (``F``) name them, and
invisible faces (``i="1"``) are left out.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any
from xml.parsers import expat

import numpy as np

from ..runtime import JobError
from .alignment import bearing
from .model import (
    CHAIN_BREAKLINE,
    CHAIN_OTHER_BOUNDARY,
    CHAIN_OUTER,
    CHAIN_VOID,
    MAX_ALIGNMENT_ELEMENTS,
    MAX_EQUATIONS,
    MAX_LAYERS,
    MAX_POINTS,
    MAX_TRIANGLES,
    MAX_VERTICES,
    AlignmentSource,
    Design,
    Line,
    Linework,
    Point,
    Points,
    Surface,
    refuse,
)

#: LandXML ``linearUnit`` to ``DesignSourceUnits``
LINEAR_UNITS = {
    "meter": "m",
    "metre": "m",
    "millimeter": "mm",
    "millimetre": "mm",
    "centimeter": "cm",
    "centimetre": "cm",
    "foot": "ft",
    "ussurveyfoot": "us-ft",
    "inch": "in",
}
BOUNDARY_KIND = {"outer": CHAIN_OUTER, "void": CHAIN_VOID}
#: the text of one element is capped (a whole surface's points are many elements, not one)
MAX_TEXT_CHARS = 64 * 1024 * 1024
CHUNK = 1 << 20

#: elements whose text is read
_TEXT = {"P", "F", "Start", "End", "Center", "PI", "PntList3D", "PntList2D", "CgPoint"}


def _local(name: str) -> str:
    return name.rsplit(":", 1)[-1]


class _Reader:
    def __init__(self, path: Path, parser: Any):
        self.path = path
        self.p = parser
        self.design = Design("landxml")
        self.stack: list[str] = []
        self.text: list[str] | None = None
        self.text_len = 0
        self.attrs_stack: list[dict[str, str]] = []
        self.angular = "radians"
        self.direction = "radians"
        # surface in progress
        self.surface: dict[str, Any] | None = None
        # alignment in progress
        self.alignment: dict[str, Any] | None = None
        self.element: dict[str, Any] | None = None
        self.cg: Points | None = None
        self.total_points = 0
        self.layer_count = 0

    # -- errors

    def where(self) -> str:
        return f"line {self.p.CurrentLineNumber}"

    def fail(self, why: str) -> JobError:
        return refuse(self.path, self.where(), why)

    # -- numbers

    def floats(self, text: str, what: str) -> list[float]:
        try:
            vals = [float(x) for x in text.split()]
        except ValueError:
            bad = next(x for x in text.split() if not _is_float(x))
            raise self.fail(f'{what}: "{bad[:40]}" is not a number.') from None
        if not all(math.isfinite(v) for v in vals):
            raise self.fail(f"{what}: a coordinate is not a finite number.")
        return vals

    def ne(self, text: str, what: str) -> tuple[float, float]:
        v = self.floats(text, what)
        if len(v) < 2:
            raise self.fail(f"{what} needs a northing and an easting.")
        return v[1], v[0]

    # -- handlers

    def start(self, name: str, attrs: dict[str, str]) -> None:
        tag = _local(name)
        if not self.stack and tag != "LandXML":
            raise self.fail(f"the file is XML but not LandXML (its root element is {tag}).")
        self.stack.append(tag)
        self.attrs_stack.append(attrs)
        if tag in _TEXT:
            self.text, self.text_len = [], 0
        if tag in ("Metric", "Imperial") and self.parent() == "Units":
            unit = (attrs.get("linearUnit") or "").replace(" ", "").lower()
            if unit not in LINEAR_UNITS:
                raise self.fail(
                    f'the linear unit "{attrs.get("linearUnit")}" is not one this import reads '
                    "(meter, millimeter, centimeter, foot, USSurveyFoot, inch)."
                )
            self.design.units = LINEAR_UNITS[unit]
            self.angular = (attrs.get("angularUnit") or "radians").lower()
            self.direction = (attrs.get("directionUnit") or self.angular).lower()
        elif tag == "CoordinateSystem":
            code = attrs.get("epsgCode")
            if code and code.strip().isdigit():
                self.design.crs = {"epsg": int(code)}
        elif tag == "Surface":
            self.surface = {
                "name": attrs.get("name") or f"Surface {len(self.design.surfaces) + 1}",
                "ids": {},
                "pts": [],
                "faces": [],
                "chains": [],
            }
            self._layer()
        elif tag in ("Breakline", "Boundary") and self.surface is not None:
            self.surface["chain_attrs"] = attrs
        elif tag == "CgPoints":
            self.cg = Points(attrs.get("name") or "Points")
            self._layer()
        elif tag == "Alignment":
            self.alignment = {
                "name": attrs.get("name") or f"Alignment {len(self.design.alignments) + 1}",
                "staStart": self.attr_float(attrs, "staStart", 0.0),
                "elements": [],
                "equations": [],
            }
            self._layer()
        elif (
            self.alignment is not None and tag in ("Line", "Curve", "Spiral") and self.parent() == "CoordGeom"
        ):
            if len(self.alignment["elements"]) >= MAX_ALIGNMENT_ELEMENTS:
                raise self.fail(f"the alignment has more than {MAX_ALIGNMENT_ELEMENTS:,} elements.")
            self.element = {"tag": tag, "attrs": attrs}
        elif tag == "StaEquation" and self.alignment is not None:
            if len(self.alignment["equations"]) >= MAX_EQUATIONS:
                raise self.fail(f"the alignment has more than {MAX_EQUATIONS} station equations.")
            back = self.attr_float(attrs, "staBack", None)
            ahead = self.attr_float(attrs, "staAhead", None)
            internal = self.attr_float(attrs, "staInternal", math.nan)
            self.alignment["equations"].append({"back": back, "ahead": ahead, "internal": internal})

    def attr_float(self, attrs: dict[str, str], key: str, default: float | None) -> float:
        raw = attrs.get(key)
        if raw is None:
            if default is None:
                raise self.fail(f"{self.stack[-1]} has no {key}.")
            return default
        if raw.strip().upper() in ("INF", "INFINITY"):
            return math.inf
        try:
            v = float(raw)
        except ValueError:
            raise self.fail(f'{self.stack[-1]} {key}: "{raw[:40]}" is not a number.') from None
        return v

    def _layer(self) -> None:
        self.layer_count += 1
        if self.layer_count > MAX_LAYERS:
            raise self.fail(f"the file has more than {MAX_LAYERS} surfaces, point groups and alignments.")

    def parent(self) -> str | None:
        return self.stack[-2] if len(self.stack) > 1 else None

    def chars(self, data: str) -> None:
        if self.text is not None:
            self.text_len += len(data)
            if self.text_len > MAX_TEXT_CHARS:
                raise self.fail(f"the {self.stack[-1]} element is larger than 64 MB of text.")
            self.text.append(data)

    def end(self, name: str) -> None:
        tag = _local(name)
        attrs = self.attrs_stack.pop()
        text = "".join(self.text) if (tag in _TEXT and self.text is not None) else ""
        if tag in _TEXT:
            self.text = None
        self.stack.pop()
        parent = self.stack[-1] if self.stack else None
        s = self.surface
        if s is not None and tag == "P" and parent == "Pnts":
            if len(s["pts"]) >= MAX_VERTICES:
                raise self.fail(f'the surface "{s["name"]}" has more than {MAX_VERTICES:,} points.')
            v = self.floats(text, f'surface "{s["name"]} point')
            if len(v) < 3:
                raise self.fail(f'surface "{s["name"]}" point {attrs.get("id", "")}: needs N E Z.')
            pid = attrs.get("id") or str(len(s["pts"]) + 1)
            s["ids"][pid] = len(s["pts"])
            s["pts"].append((v[1], v[0], v[2]))
        elif s is not None and tag == "F" and parent == "Faces":
            if attrs.get("i") == "1":
                return
            if len(s["faces"]) >= MAX_TRIANGLES:
                raise self.fail(
                    f'the surface "{s["name"]}" has more than {MAX_TRIANGLES:,} triangles, the limit for '
                    "one surface layer. Thin the surface or split it and import again."
                )
            ids = text.split()
            if len(ids) != 3:
                raise self.fail(f'surface "{s["name"]}": a face names {len(ids)} points, not 3.')
            try:
                s["faces"].append(tuple(s["ids"][x] for x in ids))
            except KeyError as e:
                raise self.fail(
                    f'surface "{s["name"]}": a face names point {e.args[0]}, which is not in Pnts.'
                ) from None
        elif s is not None and tag in ("PntList3D", "PntList2D") and parent in ("Breakline", "Boundary"):
            v = self.floats(text, f'surface "{s["name"]}" {parent}')
            dim = 3 if tag == "PntList3D" else 2
            if len(v) % dim:
                raise self.fail(f'surface "{s["name"]}" {parent}: the point list is not in groups of {dim}.')
            arr = np.asarray(v, dtype=np.float64).reshape(-1, dim)
            enz = np.zeros((len(arr), 3))
            enz[:, 0], enz[:, 1] = arr[:, 1], arr[:, 0]
            if dim == 3:
                enz[:, 2] = arr[:, 2]
            else:
                enz[:, 2] = np.nan  # a 2D boundary takes its heights from the surface when written
            ca = s.get("chain_attrs") or {}
            if parent == "Breakline":
                kind = CHAIN_BREAKLINE
            else:
                kind = BOUNDARY_KIND.get((ca.get("bndType") or "").lower(), CHAIN_OTHER_BOUNDARY)
            s["chains"].append((kind, enz))
        elif tag == "Surface" and s is not None:
            self._finish_surface(s)
            self.surface = None
        elif tag == "CgPoint" and self.cg is not None:
            self.total_points += 1
            if self.total_points > MAX_POINTS:
                raise self.fail(f"the file has more than {MAX_POINTS:,} points.")
            v = self.floats(text, "CgPoint")
            if len(v) < 2:
                raise self.fail("a CgPoint needs a northing and an easting.")
            pid = attrs.get("name") or attrs.get("oID") or str(len(self.cg.points) + 1)
            self.cg.points.append(Point(pid, v[1], v[0], v[2] if len(v) > 2 else 0.0, attrs.get("code")))
        elif tag == "CgPoints" and self.cg is not None:
            if self.cg.points:
                self.design.points.append(self.cg)
                self.design.source_layers.append(self.cg.name)
            self.cg = None
        elif (
            self.element is not None
            and tag in ("Start", "End", "Center", "PI")
            and parent == self.element["tag"]
        ):
            self.element[tag] = self.ne(text, f"{self.element['tag']} {tag}")
        elif self.element is not None and tag == self.element["tag"]:
            assert self.alignment is not None
            self.alignment["elements"].append(self._element(self.element))
            self.element = None
        elif tag == "Alignment" and self.alignment is not None:
            self._finish_alignment(self.alignment)
            self.alignment = None

    # -- assembling

    def _finish_surface(self, s: dict[str, Any]) -> None:
        name = s["name"]
        self.design.source_layers.append(name)
        if not s["faces"] and not s["chains"]:
            return
        v = np.asarray(s["pts"], dtype=np.float64).reshape(-1, 3)
        t = np.asarray(s["faces"], dtype=np.uint32).reshape(-1, 3)
        self.design.surfaces.append(Surface(name, v, t, s["chains"]))
        lines = [
            Line(c, closed=k != CHAIN_BREAKLINE, role="breakline" if k == CHAIN_BREAKLINE else "boundary")
            for k, c in s["chains"]
            if not np.isnan(c[:, 2]).any()
        ]
        if lines:
            self.design.linework.append(Linework(f"{name} breaklines", lines))

    def _angle(self, raw: float, unit: str) -> float:
        if "grad" in unit:
            return raw * math.pi / 200
        if "degree" in unit:
            return math.radians(raw)
        return raw

    def _element(self, el: dict[str, Any]) -> dict[str, Any]:
        tag, a = el["tag"], el["attrs"]
        for k in ("Start", "End"):
            if k not in el:
                raise self.fail(f"the alignment's {tag} has no {k}.")
        start, end = el["Start"], el["End"]
        if tag == "Line":
            length = math.hypot(end[0] - start[0], end[1] - start[1])
            if length <= 0:
                raise self.fail("the alignment has a line of zero length.")
            return {"type": "line", "start": start, "end": end, "length": length}
        rot = (a.get("rot") or "").lower()
        if rot not in ("cw", "ccw"):
            raise self.fail(f'the alignment\'s {tag} has rot "{a.get("rot")}", not cw or ccw.')
        if tag == "Curve":
            if "Center" not in el:
                raise self.fail("the alignment's Curve has no Center.")
            c = el["Center"]
            r = math.hypot(start[0] - c[0], start[1] - c[1])
            if r <= 0:
                raise self.fail("the alignment has a curve of zero radius.")
            phi0 = math.atan2(start[1] - c[1], start[0] - c[0])
            phi1 = math.atan2(end[1] - c[1], end[0] - c[0])
            turn = ((phi1 - phi0) if rot == "ccw" else (phi0 - phi1)) % (2 * math.pi)
            length = r * turn
            if length <= 0:
                raise self.fail("the alignment has a curve of zero length.")
            return {
                "type": "arc",
                "start": start,
                "end": end,
                "center": c,
                "radius": r,
                "rot": rot,
                "length": length,
            }
        spi = (a.get("spiType") or "clothoid").lower()
        if spi != "clothoid":
            raise self.fail(f"the alignment has a {spi} spiral; only clothoid spirals are read.")
        length = self.attr_float(a, "length", None)
        r1 = self.attr_float(a, "radiusStart", None)
        r2 = self.attr_float(a, "radiusEnd", None)
        if length <= 0 or r1 <= 0 or r2 <= 0:
            raise self.fail("the alignment has a spiral with a length or radius that is not positive.")
        if "PI" in el:
            dir_start = bearing(start, el["PI"])
        elif self.alignment and self.alignment["elements"]:
            from .alignment import element_point

            prev = self.alignment["elements"][-1]
            dir_start = element_point(prev, prev["length"])[2]
        elif "dirStart" in a:
            # LandXML directions: counter-clockwise from north in the direction unit
            dir_start = (-self._angle(self.attr_float(a, "dirStart", 0.0), self.direction)) % (2 * math.pi)
        else:
            raise self.fail("the alignment's first element is a spiral with no PI or dirStart.")
        return {
            "type": "spiral",
            "spiral": "clothoid",
            "start": start,
            "end": end,
            "radiusStart": None if math.isinf(r1) else r1,
            "radiusEnd": None if math.isinf(r2) else r2,
            "rot": rot,
            "length": length,
            "dirStart": dir_start,
        }

    def _finish_alignment(self, al: dict[str, Any]) -> None:
        self.design.source_layers.append(al["name"])
        if not al["elements"]:
            return
        eqs = al["equations"]
        if all(not math.isnan(e["internal"]) for e in eqs):
            eqs.sort(key=lambda e: e["internal"])
        self.design.alignments.append(
            AlignmentSource(
                al["name"],
                al["staStart"],
                al["elements"],
                [{"back": e["back"], "ahead": e["ahead"]} for e in eqs],
            )
        )


def _is_float(x: str) -> bool:
    try:
        float(x)
    except ValueError:
        return False
    return True


def read_landxml(path: Path) -> Design:
    parser = expat.ParserCreate()
    r = _Reader(path, parser)

    def no_doctype(*_a: Any) -> None:
        raise r.fail(
            "the file declares a document type (DTD). Design files with a DTD, entities or external "
            "references are refused; export the LandXML again without a DOCTYPE."
        )

    def no_entity(*_a: Any) -> None:
        raise r.fail("the file declares an entity. Entities are refused; export the LandXML again.")

    def no_external(*_a: Any) -> int:
        raise r.fail("the file refers to an external entity, which this import never reads.")

    parser.StartDoctypeDeclHandler = no_doctype
    parser.EntityDeclHandler = no_entity
    parser.UnparsedEntityDeclHandler = no_entity
    parser.ExternalEntityRefHandler = no_external
    parser.SetParamEntityParsing(expat.XML_PARAM_ENTITY_PARSING_NEVER)
    parser.StartElementHandler = r.start
    parser.EndElementHandler = r.end
    parser.CharacterDataHandler = r.chars
    parser.buffer_text = True
    try:
        with open(path, "rb") as f:
            while True:
                chunk = f.read(CHUNK)
                parser.Parse(chunk, not chunk)
                if not chunk:
                    break
    except expat.ExpatError as e:
        raise refuse(
            path, f"line {e.lineno}", f"the XML is not well formed ({expat.errors.messages[e.code]})."
        ) from None
    d = r.design
    if d.empty():
        raise refuse(path, None, "the file has no surfaces with faces, points or alignments to import.")
    return d
