"""Synthetic fixtures for the modelling pipelines (drawing.import and model.fit_cloud).

Everything here is generated: an ASCII DXF writer with a small plot plan, a project manifest and
a scanned plant area (sloped, bumpy ground with tanks, a box, an L-shaped pipe and a noise blob)
written as a kit-packed point cloud. No client data.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

# --------------------------------------------------------------------------------------------
# project manifest


ORIGIN = [500000.0, 2800000.0, 10.0]  # UTM 39N eastings / northings, metres
EPSG = 32639


def write_manifest(project: Path, layers: list[dict[str, Any]] | None = None, epsg: int | None = EPSG):
    m = {
        "schema": "aio.project/1",
        "id": "synthetic-plant",
        "name": "Synthetic plant",
        "crs": {"epsg": epsg} if epsg else {"wkt": 'LOCAL_CS["plant grid"]'},
        "origin": ORIGIN,
        "captures": [],
        "layers": list(layers or []),
        "severityModels": [],
        "classCatalogues": [],
    }
    (project / "manifest.json").write_text(json.dumps(m, indent=2), "utf-8")
    return m


def read_manifest(project: Path) -> dict[str, Any]:
    return json.loads((project / "manifest.json").read_text("utf-8"))


# --------------------------------------------------------------------------------------------
# DXF writer (ASCII, group code / value pairs)


class Dxf:
    """Collects entities and blocks and writes a minimal ASCII DXF."""

    def __init__(self, insunits: int | None = 6):
        self.insunits = insunits
        self.entities: list[list[tuple[int, Any]]] = []
        self.blocks: dict[str, tuple[tuple[float, float], list[list[tuple[int, Any]]]]] = {}
        self._handle = 0x100

    def handle(self) -> str:
        self._handle += 1
        return f"{self._handle:X}"

    def _add(self, rec: list[tuple[int, Any]], block: str | None) -> str:
        h = self.handle()
        rec.insert(1, (5, h))
        if block is None:
            self.entities.append(rec)
        else:
            self.blocks[block][1].append(rec)
        return h

    def block(self, name: str, base=(0.0, 0.0)) -> str:
        self.blocks[name] = (base, [])
        return name

    def line(self, layer, p1, p2, block=None, color=None):
        rec = [(0, "LINE"), (8, layer)]
        if color is not None:
            rec.append((62, color))
        rec += [(10, p1[0]), (20, p1[1]), (30, 0.0), (11, p2[0]), (21, p2[1]), (31, 0.0)]
        return self._add(rec, block)

    def lwpolyline(self, layer, pts, closed=False, block=None):
        rec = [(0, "LWPOLYLINE"), (8, layer), (90, len(pts)), (70, 1 if closed else 0)]
        for x, y in pts:
            rec += [(10, x), (20, y)]
        return self._add(rec, block)

    def polyline(self, layer, pts, closed=False, block=None):
        """Old-style POLYLINE with VERTEX records and a SEQEND (2D or 3D points)."""
        rec = [(0, "POLYLINE"), (8, layer), (66, 1), (10, 0.0), (20, 0.0), (30, 0.0)]
        rec.append((70, (1 if closed else 0) | (8 if any(len(p) == 3 for p in pts) else 0)))
        h = self._add(rec, block)
        for p in pts:
            v = [(0, "VERTEX"), (8, layer), (10, p[0]), (20, p[1]), (30, p[2] if len(p) == 3 else 0.0)]
            self._add(v, block)
        self._add([(0, "SEQEND"), (8, layer)], block)
        return h

    def circle(self, layer, c, r, block=None, color=None):
        rec = [(0, "CIRCLE"), (8, layer)]
        if color is not None:
            rec.append((62, color))
        rec += [(10, c[0]), (20, c[1]), (30, 0.0), (40, r)]
        return self._add(rec, block)

    def arc(self, layer, c, r, a0, a1, block=None):
        rec = [(0, "ARC"), (8, layer), (10, c[0]), (20, c[1]), (30, 0.0), (40, r), (50, a0), (51, a1)]
        return self._add(rec, block)

    def text(self, layer, p, s, height=0.5, block=None):
        rec = [(0, "TEXT"), (8, layer), (10, p[0]), (20, p[1]), (30, 0.0), (40, height), (1, s)]
        return self._add(rec, block)

    def mtext(self, layer, p, s, height=0.5, block=None):
        rec = [(0, "MTEXT"), (8, layer), (10, p[0]), (20, p[1]), (30, 0.0), (40, height), (1, s)]
        return self._add(rec, block)

    def point(self, layer, p, block=None):
        return self._add([(0, "POINT"), (8, layer), (10, p[0]), (20, p[1]), (30, 0.0)], block)

    def insert(self, layer, name, p, sx=1.0, sy=1.0, rot=0.0, block=None):
        rec = [(0, "INSERT"), (8, layer), (2, name), (10, p[0]), (20, p[1]), (30, 0.0)]
        rec += [(41, sx), (42, sy), (50, rot)]
        return self._add(rec, block)

    def raw(self, rec: list[tuple[int, Any]], block=None):
        return self._add(rec, block)

    def text_out(self) -> str:
        out: list[tuple[int, Any]] = []
        out += [(0, "SECTION"), (2, "HEADER"), (9, "$ACADVER"), (1, "AC1015")]
        if self.insunits is not None:
            out += [(9, "$INSUNITS"), (70, self.insunits)]
        out += [(0, "ENDSEC")]
        out += [(0, "SECTION"), (2, "TABLES"), (0, "ENDSEC")]
        out += [(0, "SECTION"), (2, "BLOCKS")]
        for name, (base, recs) in self.blocks.items():
            out += [(0, "BLOCK"), (5, self.handle()), (8, "0"), (2, name), (70, 0)]
            out += [(10, base[0]), (20, base[1]), (30, 0.0), (3, name)]
            for r in recs:
                out += r
            out += [(0, "ENDBLK"), (5, self.handle()), (8, "0")]
        out += [(0, "ENDSEC"), (0, "SECTION"), (2, "ENTITIES")]
        for r in self.entities:
            out += r
        out += [(0, "ENDSEC"), (0, "EOF")]
        lines = []
        for code, value in out:
            lines.append(f"{code:>3}")
            lines.append(f"{value:.6f}" if isinstance(value, float) else str(value))
        return "\n".join(lines) + "\n"

    def write(self, path: Path) -> Path:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(self.text_out(), "utf-8")
        return path


def plot_plan(scale: float = 1.0, insunits: int | None = 6, unknown: bool = True) -> tuple[Dxf, dict]:
    """The plot plan used by the drawing tests, in metres times ``scale`` (1000 for millimetres).

    Returns the writer and the handles of the interesting entities.
    """
    s = scale
    d = Dxf(insunits)
    h: dict[str, Any] = {}
    # two tanks with tags and height hints
    h["t101"] = d.circle("TANKS", (20 * s, 30 * s), 6 * s, color=1)
    d.text("TEXT", (19 * s, 31 * s), "T-101", 0.8 * s)
    d.text("TEXT", (19 * s, 28 * s), "height=12.5", 0.5 * s)
    h["t102"] = d.circle("TANKS", (40 * s, 30 * s), 4 * s)
    d.text("TEXT", (39 * s, 31 * s), "T-102", 0.8 * s)
    d.mtext("TEXT", (45 * s, 30 * s), "{\\fArial|b0;EL +10.000}\\PTOP", 0.5 * s)
    # a small vessel without a hint
    h["v201"] = d.circle("EQUIP", (60 * s, 30 * s), 1 * s)
    d.text("TEXT", (61.5 * s, 30 * s), "V201", 0.4 * s)
    # a building and a skid (rectangle on a SKID layer)
    bld = [(0, 0), (30, 0), (30, 10), (10, 10), (10, 15), (0, 15)]
    h["bld"] = d.lwpolyline("BUILDINGS", [(x * s, y * s) for x, y in bld], closed=True)
    d.text("TEXT", (5 * s, 5 * s), "H=6", 0.5 * s)
    # a 6 x 3 m skid turned by 30 degrees about (50, 5)
    ang = math.radians(30)
    ux, uy = math.cos(ang), math.sin(ang)
    vx, vy = -uy, ux
    corners = []
    for a, b in ((-3, -1.5), (3, -1.5), (3, 1.5), (-3, 1.5)):
        corners.append(((50 + a * ux + b * vx) * s, (5 + a * uy + b * vy) * s))
    h["skid"] = d.lwpolyline("SKID-01", corners, closed=True)
    d.text("TEXT", (50 * s, 5 * s), "HT 2.5", 0.3 * s)
    # an L-shaped pipe with a DN300 label
    h["pipe"] = d.lwpolyline("PIPE", [(0, 40 * s), (10 * s, 40 * s), (10 * s, 50 * s)])
    d.text("TEXT", (5 * s, 40.5 * s), "DN300", 0.3 * s)
    d.text("TEXT", (10.5 * s, 45 * s), "EL. 3.2", 0.3 * s)
    # a pump block (base point at its centre) inserted twice, turned and scaled
    d.block("PUMP", (1 * s, 1 * s))
    d.circle("PUMPS", (1 * s, 1 * s), 0.5 * s, block="PUMP")
    d.line("PUMPS", (1 * s, 1 * s), (2 * s, 1 * s), block="PUMP")
    h["ins1"] = d.insert("PUMPS", "PUMP", (70 * s, 10 * s))
    h["ins2"] = d.insert("PUMPS", "PUMP", (80 * s, 10 * s), 2.0, 2.0, 90.0)
    # other entity kinds
    d.arc("MISC", (70 * s, 40 * s), 2 * s, 0, 90)
    d.point("MISC", (75 * s, 40 * s))
    d.polyline("MISC", [(0, 60 * s, 0), (5 * s, 60 * s, 1 * s)])
    if unknown:
        d.raw([(0, "HATCH"), (8, "MISC"), (10, 0.0), (20, 0.0)])
        d.raw([(0, "HATCH"), (8, "MISC"), (10, 0.0), (20, 0.0)])
        d.raw([(0, "DIMENSION"), (8, "MISC"), (10, 0.0), (20, 0.0)])
    return d, h


# --------------------------------------------------------------------------------------------
# procmodel shape check (a mirror of @aio/schema procmodel.ts; objects are strict)

_BASE = {"id", "name", "tag", "class", "status", "confidence", "origin", "kind"}
_KIND = {
    "extrusion": {"footprint", "baseY", "height"},
    "cylinder": {"base", "radius", "height", "roof", "roofHeight"},
    "box": {"base", "size", "yawDeg"},
    "pipe": {"points", "diameter"},
    "sphere": {"center", "radius"},
}
_ORIGIN = {
    "fit": {"by", "residualM", "inliers", "inlierShare", "runId"},
    "drawing": {"by", "file", "layer", "entity"},
    "agent": {"by", "runId", "model"},
    "manual": {"by", "author"},
}


def _num(v) -> bool:
    return isinstance(v, int | float) and not isinstance(v, bool) and math.isfinite(v)


def _vec(v, n) -> bool:
    return isinstance(v, list) and len(v) == n and all(_num(x) for x in v)


def check_procmodel(doc: dict[str, Any]) -> None:
    """Assert ``doc`` satisfies ``aio.procmodel/1`` (strict objects, types, unique part ids)."""
    import re

    assert set(doc) <= {"schema", "id", "name", "createdAt", "updatedAt", "capture", "sources", "parts"}, (
        doc.keys()
    )
    assert doc["schema"] == "aio.procmodel/1"
    assert re.match(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$", doc["id"])
    assert isinstance(doc["name"], str) and 1 <= len(doc["name"]) <= 200
    iso = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$")
    assert iso.match(doc["createdAt"]) and iso.match(doc["updatedAt"])
    for s in doc.get("sources", []):
        assert set(s) == {"kind", "ref"} and s["kind"] in ("drawing", "pointcloud", "plan") and s["ref"]
    ids = set()
    for p in doc["parts"]:
        kind = p["kind"]
        assert set(p) <= _BASE | _KIND[kind], (kind, set(p) - _BASE - _KIND[kind])
        assert isinstance(p["id"], str) and 1 <= len(p["id"]) <= 128
        assert p["id"] not in ids, p["id"]
        ids.add(p["id"])
        assert p["status"] in ("draft", "accepted", "rejected")
        if "confidence" in p:
            assert _num(p["confidence"]) and 0 <= p["confidence"] <= 1
        for k, n in (("name", 200), ("tag", 80), ("class", 40)):
            if k in p:
                assert isinstance(p[k], str) and len(p[k]) <= n
        o = p["origin"]
        assert set(o) <= _ORIGIN[o["by"]], o
        if o["by"] == "fit":
            assert _num(o["residualM"]) and o["residualM"] >= 0
            assert isinstance(o["inliers"], int) and o["inliers"] >= 0
            if "inlierShare" in o:
                assert 0 <= o["inlierShare"] <= 1
        if kind == "extrusion":
            assert len(p["footprint"]) >= 3 and all(_vec(v, 2) for v in p["footprint"])
            assert _num(p["baseY"]) and p["height"] > 0
        elif kind == "cylinder":
            assert _vec(p["base"], 3) and p["radius"] > 0 and p["height"] > 0
            assert p.get("roof", "flat") in ("flat", "cone", "dome")
            assert p.get("roofHeight", 0) >= 0
        elif kind == "box":
            assert _vec(p["base"], 3) and _vec(p["size"], 3) and all(v > 0 for v in p["size"])
            if "yawDeg" in p:
                assert -180 <= p["yawDeg"] <= 180
        elif kind == "pipe":
            assert len(p["points"]) >= 2 and all(_vec(v, 3) for v in p["points"])
            assert p["diameter"] > 0
        elif kind == "sphere":
            assert _vec(p["center"], 3) and p["radius"] > 0


def footprint_is_ccw_from_above(fp: list[list[float]]) -> bool:
    """Counter-clockwise seen from above: positive area in the (x, -z) plane (x east, -z north)."""
    a = 0.0
    for (x1, z1), (x2, z2) in zip(fp, fp[1:] + fp[:1], strict=True):
        a += x1 * (-z2) - x2 * (-z1)
    return a > 0
