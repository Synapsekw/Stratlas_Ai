"""Vector writers: CSV points (PNEZD, PENZD, WGS 84), GeoJSON, KML and KMZ, and ESRI shapefiles.

A ``Feature`` holds its geometry already in the output frame: ``point`` (one row), ``line`` or
``polygon`` (an open ring; the writers close it as each format wants), rows of (x, y, z) where x is
easting or longitude and y northing or latitude.

- **CSV** (points): ``PNEZD`` without a header (what controllers and G6's reader take by default),
  ``PENZD`` with a header naming the columns, or WGS 84 ``Point,Latitude,Longitude,Height,Code``.
  Numbers are written with ``repr``; the statement goes in the export's sidecar note, so the file
  stays a plain point list.
- **GeoJSON**: a ``FeatureCollection`` with Z; outside WGS 84 it names its CRS in a ``crs`` member
  (GeoJSON 2008, which QGIS and GDAL read) and every export's statement in ``metadata``.
- **KML** (WGS 84 longitude, latitude and metres): one ``Placemark`` per feature, clamped to the
  ground for viewing, with the heights kept in the coordinates; **KMZ** is the same document zipped.
- **SHP** (pyshp): one shapefile per geometry type (``PointZ``, ``PolyLineZ``, ``PolygonZ``) with a
  ``.prj`` (ESRI WKT), a ``.cpg`` (UTF-8) and the attributes as text and number fields.
"""

from __future__ import annotations

import csv
import io
import json
import os
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape

import numpy as np

from ..runtime import AtomicPath, JobError, replace_over


def r(v: float) -> str:
    f = float(v)
    return repr(f + 0.0) if f == 0 else repr(f)


@dataclass
class Feature:
    kind: str  # point, line or polygon
    coords: np.ndarray  # (k, 3) x y z in the output frame
    props: dict[str, Any] = field(default_factory=dict)
    #: polygon holes, each an open ring like ``coords``
    holes: list[np.ndarray] = field(default_factory=list)

    @property
    def rows(self) -> np.ndarray:
        return np.asarray(self.coords, dtype=np.float64).reshape(-1, 3)


# --------------------------------------------------------------------------------------------- CSV


@dataclass
class PointRow:
    id: str
    x: float
    y: float
    z: float
    code: str | None = None


def write_points_csv(path: Path, rows: list[PointRow], order: str) -> None:
    """``order``: ``NEZ`` (PNEZD, no header), ``ENZ`` (PENZD with a header) or ``geo`` (WGS 84)."""
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    if order == "ENZ":
        w.writerow(["Point", "Easting", "Northing", "Elevation", "Code"])
    elif order == "geo":
        w.writerow(["Point", "Latitude", "Longitude", "Height", "Code"])
    for p in rows:
        if order == "ENZ":
            w.writerow([p.id, r(p.x), r(p.y), r(p.z), p.code or ""])
        else:  # NEZ and geo: northing or latitude first
            w.writerow([p.id, r(p.y), r(p.x), r(p.z), p.code or ""])
    with AtomicPath(path) as tmp:
        tmp.write_bytes(buf.getvalue().encode("utf-8"))


# ----------------------------------------------------------------------------------------- GeoJSON


def _ring(rows: np.ndarray) -> list[list[float]]:
    pts = [[float(a), float(b), float(c)] for a, b, c in rows]
    if pts and pts[0] != pts[-1]:
        pts.append(list(pts[0]))
    return pts


def geojson_geometry(f: Feature) -> dict[str, Any]:
    rows = f.rows
    if f.kind == "point":
        return {"type": "Point", "coordinates": [float(v) for v in rows[0]]}
    if f.kind == "line":
        return {"type": "LineString", "coordinates": [[float(a), float(b), float(c)] for a, b, c in rows]}
    rings = [_ring(rows)] + [_ring(np.asarray(h, dtype=np.float64).reshape(-1, 3)) for h in f.holes]
    return {"type": "Polygon", "coordinates": rings}


def write_geojson(
    path: Path, features: list[Feature], *, epsg: int | None, wgs84: bool, meta: dict[str, Any]
) -> None:
    doc: dict[str, Any] = {"type": "FeatureCollection"}
    if not wgs84 and epsg:
        doc["crs"] = {"type": "name", "properties": {"name": f"urn:ogc:def:crs:EPSG::{epsg}"}}
    doc["metadata"] = meta
    doc["features"] = [
        {"type": "Feature", "properties": f.props, "geometry": geojson_geometry(f)} for f in features
    ]
    with AtomicPath(path) as tmp:
        tmp.write_bytes(json.dumps(doc, separators=(",", ":")).encode("utf-8"))


# --------------------------------------------------------------------------------------------- KML


def _kml_coords(rows: np.ndarray, close: bool) -> str:
    pts = [f"{r(a)},{r(b)},{r(c)}" for a, b, c in rows]
    if close and pts and pts[0] != pts[-1]:
        pts.append(pts[0])
    return " ".join(pts)


def kml_text(name: str, features: list[Feature], notes: list[str]) -> str:
    out = [
        '<?xml version="1.0" encoding="UTF-8"?>\n',
        '<kml xmlns="http://www.opengis.net/kml/2.2">\n<Document>\n',
        f"  <name>{escape(name)}</name>\n",
        f"  <description>{escape(chr(10).join(notes))}</description>\n",
        '  <Style id="outline"><LineStyle><color>ff00a5ff</color><width>2</width></LineStyle>'
        "<PolyStyle><fill>0</fill></PolyStyle></Style>\n",
    ]
    for f in features:
        label = str(f.props.get("name") or f.props.get("label") or "")
        desc = "\n".join(f"{k}: {v}" for k, v in f.props.items() if v is not None)
        out.append(
            f"  <Placemark><name>{escape(label)}</name><description>{escape(desc)}</description>"
            "<styleUrl>#outline</styleUrl>"
        )
        rows = f.rows
        if f.kind == "point":
            out.append(
                "<Point><altitudeMode>clampToGround</altitudeMode>"
                f"<coordinates>{_kml_coords(rows[:1], False)}</coordinates></Point>"
            )
        elif f.kind == "line":
            out.append(
                "<LineString><tessellate>1</tessellate><altitudeMode>clampToGround</altitudeMode>"
                f"<coordinates>{_kml_coords(rows, False)}</coordinates></LineString>"
            )
        else:
            out.append(
                "<Polygon><tessellate>1</tessellate><altitudeMode>clampToGround</altitudeMode>"
                "<outerBoundaryIs><LinearRing>"
                f"<coordinates>{_kml_coords(rows, True)}</coordinates>"
                "</LinearRing></outerBoundaryIs>"
                + "".join(
                    "<innerBoundaryIs><LinearRing><coordinates>"
                    f"{_kml_coords(np.asarray(h, dtype=np.float64).reshape(-1, 3), True)}"
                    "</coordinates></LinearRing></innerBoundaryIs>"
                    for h in f.holes
                )
                + "</Polygon>"
            )
        out.append("</Placemark>\n")
    out.append("</Document>\n</kml>\n")
    return "".join(out)


def write_kml(path: Path, name: str, features: list[Feature], notes: list[str]) -> None:
    text = kml_text(name, features, notes).encode("utf-8")
    with AtomicPath(path) as tmp:
        if path.suffix.lower() == ".kmz":
            with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
                z.writestr("doc.kml", text)
        else:
            tmp.write_bytes(text)


# --------------------------------------------------------------------------------------------- SHP


def esri_wkt(wkt: str) -> str:
    """The ``.prj`` text: ESRI WKT 1 when PROJ can write it, else the WKT as given."""
    try:
        from pyproj import CRS
        from pyproj.enums import WktVersion

        return CRS.from_wkt(wkt).to_wkt(WktVersion.WKT1_ESRI) or wkt
    except Exception:
        return wkt


def _oriented(rows: np.ndarray, clockwise: bool) -> list[tuple[float, ...]]:
    x, y = rows[:, 0], rows[:, 1]
    area = 0.5 * float(np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y))
    ring = rows[::-1] if (area > 0) == clockwise else rows
    pts = [tuple(map(float, p)) for p in ring]
    if pts and pts[0] != pts[-1]:
        pts.append(pts[0])
    return pts


SHAPE_KINDS = {"point": "points", "line": "lines", "polygon": "polygons"}
EXTS = (".shp", ".shx", ".dbf", ".prj", ".cpg")


def write_shp(path: Path, features: list[Feature], *, wkt: str) -> list[Path]:
    """Shapefiles at ``path`` (one geometry type) or ``<stem>_<kind>.shp`` (mixed); returns the .shp files."""
    import shapefile

    kinds = sorted({f.kind for f in features}, key=list(SHAPE_KINDS).index)
    if not kinds:
        raise JobError("There is nothing to write to the shapefile.")
    written = []
    keys: list[str] = []
    for f in features:
        for k in f.props:
            if k not in keys:
                keys.append(k)
    fields = []
    for k in keys:
        vals = [f.props.get(k) for f in features if f.props.get(k) is not None]
        numeric = bool(vals) and all(isinstance(v, int | float) and not isinstance(v, bool) for v in vals)
        boolean = bool(vals) and all(isinstance(v, bool) for v in vals)
        name = k[:10]
        fields.append((k, name, "L" if boolean else ("N" if numeric else "C")))
    for kind in kinds:
        target = path if len(kinds) == 1 else path.with_name(f"{path.stem}_{SHAPE_KINDS[kind]}.shp")
        target.parent.mkdir(parents=True, exist_ok=True)
        tmps = {ext: target.with_name(f".{target.stem}.{os.getpid()}{ext}.tmp") for ext in EXTS}
        shape_type = {"point": shapefile.POINTZ, "line": shapefile.POLYLINEZ, "polygon": shapefile.POLYGONZ}[
            kind
        ]
        with (
            open(tmps[".shp"], "wb") as shp,
            open(tmps[".shx"], "wb") as shx,
            open(tmps[".dbf"], "wb") as dbf,
            shapefile.Writer(shp=shp, shx=shx, dbf=dbf, shapeType=shape_type, encoding="utf-8") as w,
        ):
            for _, name, t in fields:
                if t == "N":
                    w.field(name, "N", size=19, decimal=6)
                elif t == "L":
                    w.field(name, "L")
                else:
                    w.field(name, "C", size=254)
            for f in features:
                if f.kind != kind:
                    continue
                rows = f.rows
                if kind == "point":
                    w.pointz(float(rows[0, 0]), float(rows[0, 1]), float(rows[0, 2]))
                elif kind == "line":
                    w.linez([[tuple(map(float, p)) for p in rows]])
                else:
                    holes = [np.asarray(h, dtype=np.float64).reshape(-1, 3) for h in f.holes]
                    w.polyz([_oriented(rows, True)] + [_oriented(h, False) for h in holes])
                rec = []
                for key, _, t in fields:
                    v = f.props.get(key)
                    if t == "C":
                        rec.append("" if v is None else str(v)[:254])
                    else:
                        rec.append(v)
                w.record(*rec)
        tmps[".prj"].write_text(esri_wkt(wkt), encoding="utf-8")
        tmps[".cpg"].write_text("UTF-8", encoding="ascii")
        for ext, src in tmps.items():
            replace_over(src, target.with_suffix(ext))
        written.append(target)
    return written
