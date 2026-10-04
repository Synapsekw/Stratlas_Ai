"""Road builder inputs: the centreline and the defect polygons, read into the project CRS.

Centreline: GeoJSON (a LineString, as drawn in the app or exported from GIS), KML, DXF (ASCII,
LWPOLYLINE, POLYLINE or chained LINEs) or the kit's ``centreline_utm.json`` (``{xy, ch}``). A
GeoJSON LineString with a ``chainageKm`` property (one value per vertex, as the app writes
``road/centreline.geojson``) and the kit file keep their chainage; otherwise chainage is the
distance along the line from its first vertex.

Defects: GeoJSON, an ESRI Shapefile (the delivered MPW format, ``DefectName`` and ``Stages``),
or the road review's ``data/defects.js`` (``window.RR_DATA``). Detections from the review
streams (``aio.detections/1``) come in through ``from_detections`` once that contract lands.
"""

from __future__ import annotations

import json
import math
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from ..runtime import JobError
from .catalogue import DistressClass, class_of, stage_of

WGS84 = "EPSG:4326"


# ----------------------------------------------------------------------------- CRS


def project_crs(manifest: dict[str, Any]):
    from rasterio.crs import CRS

    crs = manifest.get("crs") or {}
    if isinstance(crs.get("epsg"), int):
        return CRS.from_epsg(crs["epsg"])
    if isinstance(crs.get("wkt"), str):
        return CRS.from_wkt(crs["wkt"])
    raise JobError("The project has no CRS; the road builder needs one (EPSG code).")


def to_crs(src, dst, xs: list[float], ys: list[float]) -> tuple[list[float], list[float]]:
    """Transform coordinates (x, y order; lon, lat for geographic CRS)."""
    from rasterio.crs import CRS
    from rasterio.warp import transform

    s = src if not isinstance(src, str) else CRS.from_string(src)
    if s == dst or not xs:
        return list(xs), list(ys)
    ox, oy = transform(s, dst, list(xs), list(ys))
    return list(ox), list(oy)


def _crs_of_geojson(doc: dict[str, Any]):
    """A legacy GeoJSON ``crs`` member (``urn:ogc:def:crs:EPSG::32638``, ``EPSG:32638``) or None."""
    from rasterio.crs import CRS

    name = ((doc.get("crs") or {}).get("properties") or {}).get("name")
    if not isinstance(name, str):
        return None
    m = re.search(r"EPSG:+(\d+)", name, re.I)
    if m:
        return CRS.from_epsg(int(m.group(1)))
    if "CRS84" in name.upper():
        return CRS.from_string(WGS84)
    return None


def _looks_projected(coords: list[tuple[float, float]]) -> bool:
    return any(abs(x) > 180 or abs(y) > 90 for x, y in coords)


# ----------------------------------------------------------------------------- centreline


@dataclass
class Centreline:
    """Vertices in the project CRS (E, N) and the chainage of each, in km."""

    xy: np.ndarray
    ch: np.ndarray
    #: The chainage came with the file (kit or app GeoJSON) rather than measured here.
    given: bool = False
    warnings: list[str] = field(default_factory=list)

    @property
    def length_km(self) -> float:
        return float(self.ch[-1]) if len(self.ch) else 0.0

    def km_at_s(self, s: float) -> float:
        """Chainage at a distance ``s`` (m) along the line."""
        d = self.distances()
        return float(np.interp(s, d, self.ch))

    def distances(self) -> np.ndarray:
        seg = np.hypot(np.diff(self.xy[:, 0]), np.diff(self.xy[:, 1]))
        return np.concatenate([[0.0], np.cumsum(seg)])

    def project(self, e: float, n: float) -> tuple[float, float]:
        """Chainage (km) of the nearest point on the line and the offset from it (m)."""
        a = self.xy[:-1]
        b = self.xy[1:]
        ab = b - a
        l2 = (ab**2).sum(axis=1)
        p = np.array([e, n])
        t = np.where(l2 > 0, ((p - a) * ab).sum(axis=1) / np.where(l2 > 0, l2, 1), 0.0).clip(0, 1)
        q = a + ab * t[:, None]
        d = np.hypot(q[:, 0] - e, q[:, 1] - n)
        k = int(np.argmin(d))
        km = self.ch[k] + (self.ch[k + 1] - self.ch[k]) * t[k]
        return float(km), float(d[k])

    def nearest_vertex_km(self, e: float, n: float) -> float:
        """Chainage of the nearest vertex (the delivered builder's rule for sample units)."""
        k = int(np.argmin((self.xy[:, 0] - e) ** 2 + (self.xy[:, 1] - n) ** 2))
        return float(self.ch[k])


def _measured(xy: np.ndarray, warnings: list[str]) -> Centreline:
    keep = [0]
    for i in range(1, len(xy)):
        if math.hypot(*(xy[i] - xy[keep[-1]])) > 1e-6:
            keep.append(i)
    xy = xy[keep]
    if len(xy) < 2:
        raise JobError("The centreline needs at least two distinct points.")
    seg = np.hypot(np.diff(xy[:, 0]), np.diff(xy[:, 1]))
    ch = np.concatenate([[0.0], np.cumsum(seg)]) / 1000.0
    return Centreline(xy=xy, ch=ch, given=False, warnings=warnings)


def _longest(lines: list[list[tuple[float, float]]], what: str, warnings: list[str]):
    lines = [ln for ln in lines if len(ln) >= 2]
    if not lines:
        raise JobError(f"No line found in the {what}.")

    def length(ln):
        return sum(math.hypot(ln[i + 1][0] - ln[i][0], ln[i + 1][1] - ln[i][1]) for i in range(len(ln) - 1))

    if len(lines) > 1:
        warnings.append(f"The {what} has {len(lines)} lines; the longest is the centreline.")
    return max(lines, key=length)


def _geojson_lines(doc: Any) -> list[tuple[list[tuple[float, float]], dict[str, Any]]]:
    out: list[tuple[list[tuple[float, float]], dict[str, Any]]] = []

    def geom(g: Any, props: dict[str, Any]):
        if not isinstance(g, dict):
            return
        t = g.get("type")
        if t == "LineString":
            out.append(([(float(c[0]), float(c[1])) for c in g.get("coordinates") or []], props))
        elif t == "MultiLineString":
            for part in g.get("coordinates") or []:
                out.append(([(float(c[0]), float(c[1])) for c in part], props))
        elif t == "GeometryCollection":
            for sub in g.get("geometries") or []:
                geom(sub, props)

    if isinstance(doc, dict):
        if doc.get("type") == "FeatureCollection":
            for f in doc.get("features") or []:
                if isinstance(f, dict):
                    geom(f.get("geometry"), f.get("properties") or {})
        elif doc.get("type") == "Feature":
            geom(doc.get("geometry"), doc.get("properties") or {})
        else:
            geom(doc, {})
    return out


def _kml_lines(text: str) -> list[list[tuple[float, float]]]:
    try:
        root = ET.fromstring(text)
    except ET.ParseError as e:
        raise JobError(f"The KML file could not be read: {e}") from e
    lines = []
    for el in root.iter():
        if el.tag.split("}")[-1] != "LineString":
            continue
        for c in el.iter():
            if c.tag.split("}")[-1] == "coordinates" and c.text:
                pts = []
                for tok in c.text.split():
                    parts = tok.split(",")
                    if len(parts) >= 2:
                        pts.append((float(parts[0]), float(parts[1])))
                lines.append(pts)
    return lines


def dxf_lines(text: str) -> list[list[tuple[float, float]]]:
    """Polylines of an ASCII DXF: LWPOLYLINE, POLYLINE with VERTEX, and LINE runs joined end to end."""
    raw = text.splitlines()
    if len(raw) < 2:
        raise JobError("The DXF file is empty.")
    pairs: list[tuple[int, str]] = []
    for i in range(0, len(raw) - 1, 2):
        try:
            pairs.append((int(raw[i].strip()), raw[i + 1].strip()))
        except ValueError as e:
            raise JobError("Only ASCII DXF files can be read (this looks binary).") from e
    lines: list[list[tuple[float, float]]] = []
    segs: list[tuple[tuple[float, float], tuple[float, float]]] = []
    in_entities = False
    i = 0
    while i < len(pairs):
        code, val = pairs[i]
        if code == 2 and val == "ENTITIES":
            in_entities = True
        elif code == 0 and val == "ENDSEC":
            in_entities = False
        if not in_entities or code != 0:
            i += 1
            continue
        if val == "LWPOLYLINE":
            pts: list[tuple[float, float]] = []
            x: float | None = None
            closed = False
            i += 1
            while i < len(pairs) and pairs[i][0] != 0:
                c, v = pairs[i]
                if c == 70:
                    closed = bool(int(v) & 1)
                elif c == 10:
                    x = float(v)
                elif c == 20 and x is not None:
                    pts.append((x, float(v)))
                    x = None
                i += 1
            if closed and pts:
                pts.append(pts[0])
            lines.append(pts)
            continue
        if val == "POLYLINE":
            pts = []
            i += 1
            while i < len(pairs) and not (pairs[i][0] == 0 and pairs[i][1] == "SEQEND"):
                if pairs[i] == (0, "VERTEX"):
                    vx = vy = None
                    i += 1
                    while i < len(pairs) and pairs[i][0] != 0:
                        c, v = pairs[i]
                        if c == 10:
                            vx = float(v)
                        elif c == 20:
                            vy = float(v)
                        i += 1
                    if vx is not None and vy is not None:
                        pts.append((vx, vy))
                    continue
                i += 1
            lines.append(pts)
            continue
        if val == "LINE":
            p: dict[int, float] = {}
            i += 1
            while i < len(pairs) and pairs[i][0] != 0:
                c, v = pairs[i]
                if c in (10, 20, 11, 21):
                    p[c] = float(v)
                i += 1
            if len(p) == 4:
                segs.append(((p[10], p[20]), (p[11], p[21])))
            continue
        i += 1
    # LINE runs: consecutive segments that share an end point
    run: list[tuple[float, float]] = []
    for a, b in segs:
        if run and math.hypot(run[-1][0] - a[0], run[-1][1] - a[1]) < 1e-6:
            run.append(b)
        else:
            if len(run) >= 2:
                lines.append(run)
            run = [a, b]
    if len(run) >= 2:
        lines.append(run)
    return lines


def read_centreline(path: Path, dst_crs, src_epsg: int | None = None) -> Centreline:
    """The centreline in the project CRS, with its chainage."""
    from rasterio.crs import CRS

    warnings: list[str] = []
    suffix = path.suffix.lower()
    override = CRS.from_epsg(src_epsg) if src_epsg else None
    try:
        text = path.read_text("utf-8-sig")
    except UnicodeDecodeError:
        text = path.read_text("latin-1")
    except OSError as e:
        raise JobError(f"The centreline file could not be read: {e}") from e

    if suffix == ".dxf":
        line = _longest(dxf_lines(text), "DXF file", warnings)
        src = override or dst_crs
        if not override:
            warnings.append("A DXF carries no CRS; its coordinates are taken as the project CRS.")
        xs, ys = to_crs(src, dst_crs, [p[0] for p in line], [p[1] for p in line])
        return _measured(np.column_stack([xs, ys]), warnings)
    if suffix == ".kml":
        line = _longest(_kml_lines(text), "KML file", warnings)
        xs, ys = to_crs(override or WGS84, dst_crs, [p[0] for p in line], [p[1] for p in line])
        return _measured(np.column_stack([xs, ys]), warnings)

    try:
        doc = json.loads(text)
    except json.JSONDecodeError as e:
        raise JobError(f"The centreline file is not GeoJSON, KML or DXF: {e}") from e
    if isinstance(doc, dict) and isinstance(doc.get("xy"), list) and isinstance(doc.get("ch"), list):
        # the kit's centreline_utm.json: project CRS metres with chainage per vertex
        xy = np.array(doc["xy"], dtype=float)
        ch = np.array(doc["ch"], dtype=float)
        if xy.ndim != 2 or xy.shape[1] < 2 or len(ch) != len(xy) or len(xy) < 2:
            raise JobError("The kit centreline needs xy and ch of the same length (two or more points).")
        if override:
            xs, ys = to_crs(override, dst_crs, list(xy[:, 0]), list(xy[:, 1]))
            xy = np.column_stack([xs, ys])
        return Centreline(xy=xy[:, :2], ch=ch, given=True, warnings=warnings)

    found = _geojson_lines(doc)
    if not found:
        raise JobError("No LineString in the centreline GeoJSON.")
    lines = [f[0] for f in found]
    line = _longest(lines, "GeoJSON", warnings)
    props = next(p for ln, p in found if ln is line)
    src = override or _crs_of_geojson(doc)
    if src is None:
        if _looks_projected(line):
            src = dst_crs
            warnings.append("The GeoJSON has projected coordinates and no CRS; the project CRS is assumed.")
        else:
            src = CRS.from_string(WGS84)
    xs, ys = to_crs(src, dst_crs, [p[0] for p in line], [p[1] for p in line])
    xy = np.column_stack([xs, ys])
    ch = props.get("chainageKm")
    if isinstance(ch, list) and len(ch) == len(xy) and all(isinstance(v, int | float) for v in ch):
        return Centreline(xy=xy, ch=np.array(ch, dtype=float), given=True, warnings=warnings)
    return _measured(xy, warnings)


# ----------------------------------------------------------------------------- defects


@dataclass
class Defect:
    """One defect polygon in the project CRS."""

    fid: int
    type_name: str
    cls: DistressClass
    stage: int | None
    geom: Any  # shapely Polygon or MultiPolygon
    #: Longest side of the minimum rotated rectangle (the delivered builder's extent L), m.
    extent: float = 0.0

    @property
    def area(self) -> float:
        return float(self.geom.area)


TYPE_KEYS = (
    "DefectName",
    "defect_type",
    "defectType",
    "type",
    "class",
    "classId",
    "distress",
    "label",
    "name",
)
STAGE_KEYS = ("Stages", "Stage", "stage", "stages", "severity", "Severity")


def _first(props: dict[str, Any], keys: tuple[str, ...]) -> Any:
    for k in keys:
        if k in props and props[k] not in (None, ""):
            return props[k]
    return None


def _defect(fid: int, geom: Any, props: dict[str, Any], warnings: list[str]) -> Defect | None:
    from shapely.geometry import MultiPolygon, Polygon

    if geom is None or geom.is_empty:
        return None
    if geom.geom_type in ("LineString", "MultiLineString"):
        geom = geom.buffer(0.05, cap_style="flat")  # a crack drawn as a line: 10 cm wide
    elif geom.geom_type in ("Point", "MultiPoint"):
        geom = geom.buffer(0.15)  # a pothole marked as a point
    if not geom.is_valid:
        geom = geom.buffer(0)
    if not isinstance(geom, Polygon | MultiPolygon) or geom.area <= 0:
        return None
    raw_type = _first(props, TYPE_KEYS)
    type_name = str(raw_type).strip() if raw_type is not None else "Other"
    raw_stage = _first(props, STAGE_KEYS)
    stage = stage_of(raw_stage)
    if raw_stage is not None and stage is None:
        warnings.append(f'Defect {fid}: stage "{raw_stage}" is not Few, Intermediate or Extensive.')
    mrr = geom.minimum_rotated_rectangle
    xs, ys = mrr.exterior.coords.xy
    sides = [math.hypot(xs[k + 1] - xs[k], ys[k + 1] - ys[k]) for k in range(2)]
    return Defect(fid, type_name, class_of(type_name), stage, geom, max(sides))


def _transform_geom(geom: Any, src, dst) -> Any:
    from shapely.ops import transform as shp_transform

    if src == dst:
        return geom

    def f(x, y, z=None):
        ox, oy = to_crs(src, dst, list(np.atleast_1d(x)), list(np.atleast_1d(y)))
        return (np.array(ox), np.array(oy))

    return shp_transform(f, geom)


def _shapefile(path: Path, dst_crs, override, warnings: list[str]) -> list[Defect]:
    import shapefile
    from rasterio.crs import CRS
    from shapely.geometry import shape

    try:
        r = shapefile.Reader(str(path.with_suffix("")))
    except Exception as e:
        raise JobError(f"The shapefile could not be read: {e}") from e
    prj = path.with_suffix(".prj")
    src = override
    if src is None and prj.exists():
        try:
            src = CRS.from_wkt(prj.read_text("utf-8", errors="replace"))
        except Exception:
            warnings.append(f"{prj.name} could not be read; the project CRS is assumed.")
    if src is None:
        if not prj.exists():
            warnings.append("The shapefile has no .prj; the project CRS is assumed.")
        src = dst_crs
    names = [f[0] for f in r.fields[1:]]
    out = []
    try:
        for fid, (rec, shp) in enumerate(zip(r.records(), r.shapes(), strict=True)):
            if shp.shapeType == 0:
                continue
            props = dict(zip(names, list(rec), strict=False))
            g = _transform_geom(shape(shp.__geo_interface__), src, dst_crs)
            d = _defect(fid, g, props, warnings)
            if d:
                out.append(d)
    finally:
        r.close()
    return out


def _geojson(doc: dict[str, Any], dst_crs, override, warnings: list[str]) -> list[Defect]:
    from rasterio.crs import CRS
    from shapely.geometry import shape

    feats = doc.get("features") if doc.get("type") == "FeatureCollection" else [doc]
    src = override or _crs_of_geojson(doc)
    out = []
    for fid, f in enumerate(feats or []):
        if not isinstance(f, dict) or not isinstance(f.get("geometry"), dict):
            continue
        g = shape(f["geometry"])
        if src is None:
            pts = list(g.envelope.exterior.coords) if g.geom_type != "Point" else [(g.x, g.y)]
            if _looks_projected(pts):
                src = dst_crs
                warnings.append(
                    "The defect GeoJSON has projected coordinates and no CRS; the project CRS is assumed."
                )
            else:
                src = CRS.from_string(WGS84)
        d = _defect(fid, _transform_geom(g, src, dst_crs), f.get("properties") or {}, warnings)
        if d:
            out.append(d)
    return out


def _review_js(text: str, dst_crs, warnings: list[str]) -> list[Defect]:
    """``window.RR_DATA = {...}`` of the road review: rows under ``fields``, rings ``g`` in lon/lat."""
    from rasterio.crs import CRS
    from shapely.geometry import Polygon

    m = re.search(r"RR_DATA\s*=\s*(\{.*\})\s*;?\s*$", text, re.S)
    if not m:
        raise JobError("Not a road review defects file (window.RR_DATA missing).")
    data = json.loads(m.group(1))
    fields = data.get("fields") or []
    wgs = CRS.from_string(WGS84)
    out = []
    for row in data.get("rows") or []:
        o = dict(zip(fields, row, strict=False))
        ring = o.get("g") or []
        if len(ring) < 3:
            continue
        fid = int(o.get("id", len(out)))
        g = _transform_geom(Polygon(ring), wgs, dst_crs)
        d = _defect(fid, g, {"type": o.get("type"), "stage": o.get("stage")}, warnings)
        if d:
            out.append(d)
    return out


def from_detections(doc: dict[str, Any], dst_crs, warnings: list[str]) -> list[Defect]:
    """Adapter seam for ``aio.detections/1`` (detection review, streams R1 and R2).

    When that contract lands, map each accepted detection with a map footprint to a ``Defect``:
    its class to ``class_of`` (class ids of the road catalogue), its severity to ``stage_of``, its
    footprint polygon (lon/lat) through ``_transform_geom`` into the project CRS. Draft (not yet
    accepted) detections must not count.
    """
    raise JobError(
        "Detections (aio.detections/1) cannot be read by this pipeline pack yet. "
        "Export the accepted detections as GeoJSON polygons with a type property and use that file."
    )


def read_defects(path: Path, dst_crs, src_epsg: int | None = None) -> tuple[list[Defect], list[str]]:
    """Defect polygons in the project CRS, and warnings for the job log."""
    from rasterio.crs import CRS

    warnings: list[str] = []
    override = CRS.from_epsg(src_epsg) if src_epsg else None
    suffix = path.suffix.lower()
    if suffix in (".shp", ".dbf"):
        return _shapefile(path, dst_crs, override, warnings), warnings
    try:
        text = path.read_text("utf-8-sig")
    except (OSError, UnicodeDecodeError) as e:
        raise JobError(f"The defects file could not be read: {e}") from e
    if suffix == ".js" or "RR_DATA" in text[:200]:
        return _review_js(text, dst_crs, warnings), warnings
    try:
        doc = json.loads(text)
    except json.JSONDecodeError as e:
        raise JobError(f"The defects file is not GeoJSON, a shapefile or a review defects.js: {e}") from e
    if not isinstance(doc, dict):
        raise JobError("The defects file is not a GeoJSON object.")
    if str(doc.get("schema", "")).startswith("aio.detections/"):
        return from_detections(doc, dst_crs, warnings), warnings
    return _geojson(doc, dst_crs, override, warnings), warnings
