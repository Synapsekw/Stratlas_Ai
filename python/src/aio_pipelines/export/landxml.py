"""LandXML 1.2 writer: ``Surfaces`` (TIN with breaklines and boundaries), ``CgPoints`` and horizontal
``Alignments`` (lines, arcs, clothoid spirals with their PI, station equations).

The input is G6's model (``aio_pipelines.design.model``) in output coordinates: (E, N, Z) as the
export frame placed them, in the file's linear unit. LandXML lists **northing first** (``N E Z``),
as G6's reader expects. Numbers are written with ``repr`` (the shortest text that reads back to
the same float), so a surface written here and read by ``design/landxml.py`` is identical.
Directions and angles are radians (the file's ``Units`` say so).

The file is streamed to disk element by element: a surface of two million triangles never holds
more than one line of text in memory.
"""

from __future__ import annotations

import math
from collections.abc import Iterable
from datetime import UTC, datetime
from pathlib import Path
from typing import IO, Any
from xml.sax.saxutils import quoteattr

import numpy as np

from ..design.alignment import spiral_bearing
from ..design.model import CHAIN_BREAKLINE, CHAIN_OUTER, CHAIN_VOID, AlignmentSource, Points, Surface
from ..runtime import AtomicPath
from .frame import PRODUCT

NS = "http://www.landxml.org/schema/LandXML-1.2"
#: output unit to LandXML (``Metric`` or ``Imperial``, ``linearUnit``)
UNITS = {
    "m": (
        '<Metric linearUnit="meter" areaUnit="squareMeter" volumeUnit="cubicMeter" '
        'temperatureUnit="celsius" pressureUnit="milliBars" angularUnit="radians" '
        'directionUnit="radians"/>'
    ),
    "ft": (
        '<Imperial linearUnit="foot" areaUnit="squareFoot" volumeUnit="cubicYard" '
        'temperatureUnit="fahrenheit" pressureUnit="inHG" angularUnit="radians" '
        'directionUnit="radians"/>'
    ),
    "us-ft": (
        '<Imperial linearUnit="USSurveyFoot" areaUnit="squareFoot" volumeUnit="cubicYard" '
        'temperatureUnit="fahrenheit" pressureUnit="inHG" angularUnit="radians" '
        'directionUnit="radians"/>'
    ),
}


def r(v: float) -> str:
    """A float as the shortest text that reads back the same (``-0.0`` as ``0.0``)."""
    f = float(v)
    return repr(f + 0.0) if f == 0 else repr(f)


def _nez(p: Iterable[float]) -> str:
    e, n, z = (float(v) for v in p)
    return f"{r(n)} {r(e)} {r(z)}"


def _ne(p: Iterable[float]) -> str:
    e, n = (float(v) for v in list(p)[:2])
    return f"{r(n)} {r(e)}"


def spiral_pi(el: dict[str, Any]) -> tuple[float, float]:
    """The point of intersection of a spiral's start and end tangents (E, N)."""
    b0 = el["dirStart"]
    b1 = spiral_bearing(el, el["length"])
    (e0, n0), (e1, n1) = el["start"], el["end"]
    d0 = (math.sin(b0), math.cos(b0))
    d1 = (math.sin(b1), math.cos(b1))
    det = d0[0] * (-d1[1]) - d0[1] * (-d1[0])
    if abs(det) < 1e-15:
        # tangents parallel (a spiral of no turn): the PI is where the start tangent meets the middle
        half = el["length"] / 2
        return e0 + d0[0] * half, n0 + d0[1] * half
    t = ((e1 - e0) * (-d1[1]) - (n1 - n0) * (-d1[0])) / det
    return e0 + d0[0] * t, n0 + d0[1] * t


def equations_internal(al: AlignmentSource) -> list[float]:
    """The internal station (start station plus the distance along) of each station equation."""
    out = []
    run, station = 0.0, al.start_station
    for q in al.equations:
        run += q["back"] - station
        out.append(al.start_station + run)
        station = q["ahead"]
    return out


class _Out:
    def __init__(self, f: IO[str]):
        self.f = f

    def w(self, text: str) -> None:
        self.f.write(text)


def _surface(o: _Out, s: Surface) -> None:
    o.w(f"    <Surface name={quoteattr(s.name)}>\n")
    if s.chains:
        brk = [(k, c) for k, c in s.chains if k == CHAIN_BREAKLINE]
        bnd = [(k, c) for k, c in s.chains if k != CHAIN_BREAKLINE]
        o.w("      <SourceData>\n")
        if brk:
            o.w("        <Breaklines>\n")
            for i, (_, c) in enumerate(brk):
                pts = " ".join(_nez(p) for p in np.asarray(c, dtype=np.float64).reshape(-1, 3))
                o.w(
                    f'          <Breakline brkType="standard" name="breakline {i + 1}">'
                    f"<PntList3D>{pts}</PntList3D></Breakline>\n"
                )
            o.w("        </Breaklines>\n")
        if bnd:
            o.w("        <Boundaries>\n")
            for i, (k, c) in enumerate(bnd):
                kind = "outer" if k == CHAIN_OUTER else ("void" if k == CHAIN_VOID else "data")
                pts = " ".join(_nez(p) for p in np.asarray(c, dtype=np.float64).reshape(-1, 3))
                o.w(
                    f'          <Boundary bndType="{kind}" edgeTrim="true" name="boundary {i + 1}">'
                    f"<PntList3D>{pts}</PntList3D></Boundary>\n"
                )
            o.w("        </Boundaries>\n")
        o.w("      </SourceData>\n")
    v = np.asarray(s.vertices, dtype=np.float64).reshape(-1, 3)
    t = np.asarray(s.triangles, dtype=np.int64).reshape(-1, 3)
    if len(v):
        lo, hi = v.min(axis=0), v.max(axis=0)
        o.w(
            f'      <Definition surfType="TIN" elevMax={quoteattr(r(hi[2]))} elevMin={quoteattr(r(lo[2]))}>\n'
        )
    else:
        o.w('      <Definition surfType="TIN">\n')
    o.w("        <Pnts>\n")
    for i in range(len(v)):
        o.w(f'          <P id="{i + 1}">{_nez(v[i])}</P>\n')
    o.w("        </Pnts>\n        <Faces>\n")
    for a, b, c in t:
        o.w(f"          <F>{a + 1} {b + 1} {c + 1}</F>\n")
    o.w("        </Faces>\n      </Definition>\n    </Surface>\n")


def _alignment(o: _Out, al: AlignmentSource) -> None:
    length = sum(float(e["length"]) for e in al.elements)
    o.w(
        f"    <Alignment name={quoteattr(al.name)} length={quoteattr(r(length))} "
        f"staStart={quoteattr(r(al.start_station))}>\n      <CoordGeom>\n"
    )
    for el in al.elements:
        kind = el["type"]
        if kind == "line":
            o.w(
                f"        <Line length={quoteattr(r(el['length']))}><Start>{_ne(el['start'])}</Start>"
                f"<End>{_ne(el['end'])}</End></Line>\n"
            )
        elif kind == "arc":
            o.w(
                f'        <Curve rot="{el["rot"]}" crvType="arc" radius={quoteattr(r(el["radius"]))} '
                f"length={quoteattr(r(el['length']))}><Start>{_ne(el['start'])}</Start>"
                f"<Center>{_ne(el['center'])}</Center><End>{_ne(el['end'])}</End></Curve>\n"
            )
        else:
            r1 = "INF" if el.get("radiusStart") is None else r(el["radiusStart"])
            r2 = "INF" if el.get("radiusEnd") is None else r(el["radiusEnd"])
            pi = spiral_pi(el)
            o.w(
                f'        <Spiral length={quoteattr(r(el["length"]))} radiusStart="{r1}" radiusEnd="{r2}" '
                f'rot="{el["rot"]}" spiType="clothoid"><Start>{_ne(el["start"])}</Start>'
                f"<PI>{_ne(pi)}</PI><End>{_ne(el['end'])}</End></Spiral>\n"
            )
    o.w("      </CoordGeom>\n")
    for q, internal in zip(al.equations, equations_internal(al), strict=True):
        o.w(
            f"      <StaEquation staBack={quoteattr(r(q['back']))} staAhead={quoteattr(r(q['ahead']))} "
            f"staInternal={quoteattr(r(internal))}/>\n"
        )
    o.w("    </Alignment>\n")


def _points(o: _Out, pts: Points) -> None:
    o.w(f"  <CgPoints name={quoteattr(pts.name)}>\n")
    for p in pts.points:
        code = f" code={quoteattr(p.code)}" if p.code else ""
        o.w(f"    <CgPoint name={quoteattr(p.id)}{code}>{_nez((p.e, p.n, p.z))}</CgPoint>\n")
    o.w("  </CgPoints>\n")


def write_landxml(
    path: Path,
    *,
    units: str,
    notes: list[str],
    crs_name: str,
    epsg: int | None = None,
    vertical: str | None = None,
    surfaces: list[Surface] | None = None,
    alignments: list[AlignmentSource] | None = None,
    points: list[Points] | None = None,
    project: str = "Survey export",
) -> None:
    """Write a LandXML 1.2 file atomically. ``notes`` go in a comment and the ``Project`` desc."""
    now = datetime.now(UTC)
    with AtomicPath(path) as tmp, open(tmp, "w", encoding="utf-8", newline="\n") as f:
        o = _Out(f)
        o.w('<?xml version="1.0" encoding="UTF-8"?>\n')
        o.w("<!--\n" + "\n".join("  " + n.replace("--", "- -") for n in notes) + "\n-->\n")
        o.w(
            f'<LandXML xmlns="{NS}" version="1.2" date="{now:%Y-%m-%d}" time="{now:%H:%M:%S}" '
            'readOnly="false" language="English">\n'
        )
        o.w(f"  <Units>{UNITS[units]}</Units>\n")
        cs = f"  <CoordinateSystem name={quoteattr(crs_name)}"
        if epsg:
            cs += f' epsgCode="{epsg}"'
        if vertical:
            cs += f" verticalDatum={quoteattr(vertical)}"
        o.w(cs + "/>\n")
        o.w(f"  <Project name={quoteattr(project)} desc={quoteattr('; '.join(notes))}/>\n")
        o.w(f'  <Application name="{PRODUCT}" desc="survey.export"/>\n')
        for pts in points or []:
            _points(o, pts)
        if alignments:
            o.w('  <Alignments name="Alignments">\n')
            for al in alignments:
                _alignment(o, al)
            o.w("  </Alignments>\n")
        if surfaces:
            o.w('  <Surfaces name="Surfaces">\n')
            for s in surfaces:
                _surface(o, s)
            o.w("  </Surfaces>\n")
        o.w("</LandXML>\n")


__all__ = ["equations_internal", "spiral_pi", "write_landxml"]
