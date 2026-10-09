"""survey.export: surfaces, orthos, clouds, contours, measurements and sections to survey formats.

M11 G7 (PRD SRV-9, DSN-5; data-conventions section 25). Parameters as ``SurveyExportParams`` in
``packages/schema/src/jobs.ts``: ``what``, ``format``, ``crs`` (``site``, ``wgs84`` or ``{ epsg }``),
``units?`` (``m``, ``ft``, ``us-ft``), ``decimate?`` (the share of faces or points kept, 1 is full),
one source, and ``out``: the absolute file main's save dialog chose (or a folder: one file per
measurement or section). Nothing is written into the project.

**Sources** (one of ``surface``, ``layer``, ``overlay``, ``measurements``):

- ``surface``: a prepared surface (``survey/surfaces/<id>/``); one prepared from a design is
  exported from its design TIN (exact, with its breaklines) by the TIN formats;
- ``layer``: a design layer ``<design>/<layer>`` (a surface, alignment, points or linework layer),
  a whole design ``<design>`` (every layer not archived), or a project layer (a DSM raster for
  ``surface``, an ortho for ``ortho``, a point cloud for ``cloud``);
- ``overlay``: a contours overlay (its surface and intervals) or a comparison overlay (the
  difference ``to - from``, for ``surface`` as GeoTIFF or ``contours``);
- ``measurements``: survey measurement ids (all of them when absent); for ``section`` the line
  measurements to cut, sampled on ``surface`` (default the current survey).

**What and format** (anything else is refused with the reason):

=============  ===============================================================================
what           formats
=============  ===============================================================================
surface        geotiff (DSM, DTM, difference), dxf (3DFACE), landxml, 12da, csv (points),
               geojson, kml, shp (the terrain boundary; a design's alignments and points too)
ortho          geotiff (RGB with alpha)
cloud          laz (LAS 1.4; ``.las`` destination without PDAL)
contours       dxf, shp, geojson, kml
measurements   dxf, kml, csv, landxml, 12da, geojson, shp (with ``surface``: polygons as TINs
               of that surface clipped to them, for dxf, landxml and 12da)
section        csv, dxf
=============  ===============================================================================

Every export goes through ``aio_pipelines.export.frame`` (G1's one PROJ pipeline) and states its
CRS, vertical datum, geoid, calibration and units in the file (or a sidecar note for GeoTIFF, LAZ,
CSV and SHP) and in the outputs' ``suffix`` (``_site-grid_usft`` and so on), which the app puts in
the default file name.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from ..design.model import (
    CHAIN_BREAKLINE,
    CHAIN_OUTER,
    CHAIN_VOID,
    AlignmentSource,
    Line,
    Linework,
    Point,
    Points,
    Surface,
)
from ..export.frame import EMBEDDED, LINEAR, Frame, build_frame, export_name
from ..params import known_keys
from ..runtime import JobError, Step, StepContext

NAMED_CRS = frozenset({"site", "wgs84"})
WHATS = ("surface", "ortho", "cloud", "contours", "measurements", "section")
FORMATS = ("geotiff", "laz", "dxf", "landxml", "12da", "csv", "kml", "shp", "geojson")
MATRIX: dict[str, frozenset[str]] = {
    "surface": frozenset({"geotiff", "dxf", "landxml", "12da", "csv", "geojson", "kml", "shp"}),
    "ortho": frozenset({"geotiff"}),
    "cloud": frozenset({"laz"}),
    "contours": frozenset({"dxf", "shp", "geojson", "kml"}),
    "measurements": frozenset({"dxf", "kml", "csv", "landxml", "12da", "geojson", "shp"}),
    "section": frozenset({"csv", "dxf"}),
}
EXT = {
    "geotiff": "tif",
    "laz": "laz",
    "dxf": "dxf",
    "landxml": "xml",
    "12da": "12da",
    "csv": "csv",
    "kml": "kml",
    "shp": "shp",
    "geojson": "geojson",
}
UNITS = frozenset({"mm", "cm", "m", "km", "ft", "us-ft", "in", "yd", "mi", "us-mi"})
#: Formats that get a sidecar note (their own metadata cannot carry the whole statement).
SIDECAR = frozenset({"csv", "shp"})
TIN_FORMATS = frozenset({"dxf", "landxml", "12da"})
BOUNDARY_FORMATS = frozenset({"geojson", "kml", "shp"})
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")


# ------------------------------------------------------------------------------------- sources


@dataclass
class Grid:
    """A height (or difference) grid in the project CRS: ``read(i0, j0, w, h)`` like ``GridSurface``."""

    name: str
    surface: Any  # GridSurface
    box: tuple[float, float, float, float]
    difference: bool = False


@dataclass
class DesignParts:
    """Design content in the project CRS (metres)."""

    name: str
    surfaces: list[Surface] = field(default_factory=list)
    alignments: list[AlignmentSource] = field(default_factory=list)
    points: list[Points] = field(default_factory=list)
    linework: list[Linework] = field(default_factory=list)

    def empty(self) -> bool:
        return not (self.surfaces or self.alignments or self.points or self.linework)


def _read_json(path: Path, what: str) -> Any:
    try:
        return json.loads(path.read_text("utf-8"))
    except (OSError, ValueError) as e:
        raise JobError(f"The {what} could not be read: {e}") from e


def _designs(project: Path) -> list[dict[str, Any]]:
    p = project / "survey" / "designs.json"
    if not p.is_file():
        return []
    d = _read_json(p, "designs list")
    return [x for x in (d.get("designs") or []) if isinstance(x, dict)] if isinstance(d, dict) else []


def design_layer(project: Path, entry: dict[str, Any], layer: dict[str, Any], parts: DesignParts) -> None:
    """Add one design layer (offset applied to surfaces) to ``parts``."""
    from ..design.tin_io import read_tin

    folder = project / "survey" / "designs" / str(entry["id"])
    path = folder / str(layer.get("file"))
    name = str(layer.get("name") or layer.get("id"))
    kind = layer.get("kind")
    if not path.is_file():
        raise JobError(f'The file of the design layer "{name}" ({path.name}) is missing.')
    if kind == "surface":
        off = float(layer.get("verticalOffsetM") or 0.0)
        tin = read_tin(path, off)
        if off:
            name = f"{name} (offset {round(off * 1000) / 1000:g} m)"
        chains = [(int(k), tin.vertices[idx]) for k, idx in tin.chains]
        parts.surfaces.append(Surface(name, tin.vertices, tin.triangles.astype(np.uint32), chains))
    elif kind == "alignment":
        a = _read_json(path, f'alignment "{name}"')
        parts.alignments.append(
            AlignmentSource(
                name,
                float(a.get("startStation") or 0.0),
                [dict(e) for e in a.get("elements") or []],
                [dict(q) for q in a.get("equations") or []],
            )
        )
    elif kind == "points":
        doc = _read_json(path, f'points "{name}"')
        pts = Points(name)
        for f in doc.get("features") or []:
            c = (f.get("geometry") or {}).get("coordinates") or []
            props = f.get("properties") or {}
            if len(c) >= 2:
                pts.points.append(
                    Point(
                        str(props.get("id") or len(pts.points) + 1),
                        float(c[0]),
                        float(c[1]),
                        float(c[2]) if len(c) > 2 else 0.0,
                        props.get("code"),
                    )
                )
        parts.points.append(pts)
    elif kind == "linework":
        doc = _read_json(path, f'linework "{name}"')
        lw = Linework(name)
        for f in doc.get("features") or []:
            c = np.asarray((f.get("geometry") or {}).get("coordinates") or [], dtype=np.float64)
            props = f.get("properties") or {}
            if c.ndim != 2 or len(c) < 2:
                continue
            if c.shape[1] == 2:
                c = np.column_stack([c, np.zeros(len(c))])
            closed = bool(props.get("closed"))
            if closed and len(c) > 2 and np.array_equal(c[0], c[-1]):
                c = c[:-1]
            lw.lines.append(Line(c[:, :3], closed, props.get("name"), str(props.get("role") or "line")))
        parts.linework.append(lw)


def read_design_parts(project: Path, ref: str) -> DesignParts:
    """``<design>`` (every layer not archived) or ``<design>/<layer>``."""
    did, _, lid = ref.partition("/")
    entry = next((d for d in _designs(project) if d.get("id") == did), None)
    if entry is None:
        raise JobError(f'The site has no design "{did}".')
    parts = DesignParts(str(entry.get("name") or did))
    layers = [x for x in entry.get("layers") or [] if isinstance(x, dict)]
    if lid:
        layer = next((x for x in layers if x.get("id") == lid), None)
        if layer is None:
            raise JobError(f'The design "{entry.get("name") or did}" has no layer "{lid}".')
        parts.name = f"{parts.name}, {layer.get('name') or lid}"
        design_layer(project, entry, layer, parts)
    else:
        for layer in layers:
            if not layer.get("archived"):
                design_layer(project, entry, layer, parts)
    if parts.empty():
        raise JobError(f'The design "{entry.get("name") or did}" has nothing to export.')
    return parts


def _manifest(project: Path) -> dict[str, Any]:
    from ..change.imagery import read_manifest

    return read_manifest(project)


def _manifest_layer(manifest: dict[str, Any], lid: str) -> dict[str, Any] | None:
    return next((x for x in manifest.get("layers") or [] if isinstance(x, dict) and x.get("id") == lid), None)


def _overlay(project: Path, oid: str) -> dict[str, Any]:
    from .overlay import read_overlays

    entry = next((o for o in read_overlays(project).get("overlays") or [] if o.get("id") == oid), None)
    if entry is None:
        raise JobError(f'The site has no overlay "{oid}".')
    return entry


def grid_of_prepared(ps: Any, sid: str) -> Grid:
    r = ps.grid(sid)
    g = r.grid
    box = r.extent or g.bounds
    return Grid(r.name, g, box)


def grid_of_overlay(project: Path, ps: Any, entry: dict[str, Any]) -> Grid:
    from .grid import ArraySurface
    from .overlay import difference_grid

    src = entry.get("source") or {}
    if isinstance(src.get("comparison"), dict):
        c = src["comparison"]
        og = difference_grid(ps, c["from"], c["to"])
        ny, nx = og.z.shape
        s = ArraySurface(og.origin_e, og.origin_n, og.cell, og.z)
        box = (og.origin_e, og.origin_n, og.origin_e + nx * og.cell, og.origin_n + ny * og.cell)
        return Grid(str(entry.get("name") or entry.get("id")), s, box, difference=True)
    if isinstance(src.get("surface"), str):
        return grid_of_prepared(ps, src["surface"])
    raise JobError(f'The overlay "{entry.get("id")}" has no surface to export.')


def grid_of_raster(ctx: StepContext, manifest: dict[str, Any], layer: dict[str, Any]) -> Grid:
    from .grid import ArraySurface
    from .prepare import read_raster

    if layer.get("kind") != "raster" or layer.get("role") != "dsm":
        raise JobError(f'The layer "{layer.get("name") or layer.get("id")}" is not a DSM or DTM raster.')
    h = read_raster(ctx, manifest, {"kind": "dsm", "layer": layer["id"]}, None)
    ny, nx = h.h.shape
    s = ArraySurface(h.oe, h.on, h.cell, h.h)
    return Grid(
        str(layer.get("name") or layer["id"]), s, (h.oe, h.on, h.oe + nx * h.cell, h.on + ny * h.cell)
    )


# -------------------------------------------------------------------------------------- frames


def _surface_out(frame: Frame, s: Surface) -> Surface:
    v = frame.forward_xyz(s.vertices)
    chains = [(k, frame.forward_xyz(c)) for k, c in s.chains]
    return Surface(s.name, v, np.asarray(s.triangles, dtype=np.uint32), chains)


def _alignment_out(frame: Frame, al: AlignmentSource) -> AlignmentSource:
    """An alignment in the output frame.

    When the frame only changes the unit (the site grid is the project CRS) every element is
    scaled exactly, so an alignment goes out and back identical. Otherwise its points go through
    PROJ and lines and arcs are recomputed from them (as the importer places them); a spiral's
    length and radii take the ratio of its placed chord to its own, and its direction the placed
    bearing of its start tangent.
    """
    from ..design.alignment import bearing

    k = frame.k_h

    def place(pts: list[list[float]]) -> list[list[float]]:
        a = np.asarray([[p[0], p[1], 0.0] for p in pts], dtype=np.float64)
        out = frame.forward_xyz(a)
        return [[float(x), float(y)] for x, y, _ in out]

    every = [el[key] for el in al.elements for key in ("start", "end", "center") if key in el]
    placed = np.asarray(place(every)) if every else np.zeros((0, 2))
    exact = bool(len(every)) and float(np.abs(placed - np.asarray(every, dtype=np.float64) / k).max()) < 1e-9
    els = []
    for el in al.elements:
        e = dict(el)
        if exact:
            for key in ("start", "end", "center"):
                if key in el:
                    e[key] = [el[key][0] / k, el[key][1] / k]
            for key in ("length", "radius", "radiusStart", "radiusEnd"):
                if el.get(key) is not None:
                    e[key] = el[key] / k
            els.append(e)
            continue
        keys = [key for key in ("start", "end", "center") if key in el]
        for key, p in zip(keys, place([el[key] for key in keys]), strict=True):
            e[key] = p
        if e["type"] == "line":
            e["length"] = math.hypot(e["end"][0] - e["start"][0], e["end"][1] - e["start"][1])
        elif e["type"] == "arc":
            radius = math.hypot(e["start"][0] - e["center"][0], e["start"][1] - e["center"][1])
            p0 = math.atan2(e["start"][1] - e["center"][1], e["start"][0] - e["center"][0])
            p1 = math.atan2(e["end"][1] - e["center"][1], e["end"][0] - e["center"][0])
            turn = ((p1 - p0) if e["rot"] == "ccw" else (p0 - p1)) % (2 * math.pi)
            e["radius"], e["length"] = radius, radius * turn
        else:
            chord0 = math.hypot(el["end"][0] - el["start"][0], el["end"][1] - el["start"][1])
            chord1 = math.hypot(e["end"][0] - e["start"][0], e["end"][1] - e["start"][1])
            scale = chord1 / chord0 if chord0 > 0 else 1 / k
            t = 10.0
            ahead = [
                el["start"][0] + t * math.sin(el["dirStart"]),
                el["start"][1] + t * math.cos(el["dirStart"]),
            ]
            q = place([el["start"], ahead])
            e["dirStart"] = bearing((q[0][0], q[0][1]), (q[1][0], q[1][1]))
            e["length"] = el["length"] * scale
            for key in ("radiusStart", "radiusEnd"):
                if el.get(key) is not None:
                    e[key] = el[key] * scale
        els.append(e)
    return AlignmentSource(
        al.name,
        al.start_station / k,
        els,
        [{"back": q["back"] / k, "ahead": q["ahead"] / k} for q in al.equations],
    )


def _points_out(frame: Frame, pts: Points) -> Points:
    if not pts.points:
        return Points(pts.name)
    xyz = frame.forward_xyz(np.asarray([[p.e, p.n, p.z] for p in pts.points], dtype=np.float64))
    return Points(
        pts.name,
        [
            Point(p.id, float(r[0]), float(r[1]), float(r[2]), p.code)
            for p, r in zip(pts.points, xyz, strict=True)
        ],
    )


def _linework_out(frame: Frame, lw: Linework) -> Linework:
    return Linework(
        lw.name,
        [Line(frame.forward_xyz(x.coords), x.closed, x.name, x.role) for x in lw.lines],
    )


def parts_out(frame: Frame, parts: DesignParts) -> DesignParts:
    return DesignParts(
        parts.name,
        [_surface_out(frame, s) for s in parts.surfaces],
        [_alignment_out(frame, a) for a in parts.alignments],
        [_points_out(frame, p) for p in parts.points],
        [_linework_out(frame, w) for w in parts.linework],
    )


# ---------------------------------------------------------------------------- grid as triangles


def grid_surface(grid: Grid, decimate: float | None, ctx: StepContext) -> Surface:
    from ..export.tin import boundary_rings, grid_tin, read_posts, step_for, tin_limit

    g = grid.surface
    step = step_for(decimate)
    e0, n0, e1, n1 = grid.box
    w = max(1, math.ceil((e1 - e0) / g.cell))
    h = max(1, math.ceil((n1 - n0) / g.cell))
    need = tin_limit(w, h)
    if need > step:
        share = 1 / need**2
        raise JobError(
            f'"{grid.name}" has {w * h:,} posts, more than a surface file holds in full; export it '
            f"with a level of detail of at most {share:.3g} (one post in {need} each way)."
        )
    z, pe, pn, spacing = read_posts(g, grid.box, step, ctx.check)
    verts, tris = grid_tin(z, pe, pn, spacing)
    if len(tris) == 0:
        raise JobError(f'"{grid.name}" has no data to triangulate in the export area.')
    chains = [
        (CHAIN_OUTER if outer else CHAIN_VOID, verts[ring]) for outer, ring in boundary_rings(verts, tris)
    ]
    return Surface(grid.name, verts, tris, chains)


# ------------------------------------------------------------------------------------- outputs


@dataclass
class Out:
    """Where the files go: one file, or a folder for one file per item."""

    path: Path
    folder: bool

    def file(self, base: str, frame: Frame, fmt: str, kmz: bool = False) -> Path:
        if not self.folder:
            return self.path
        ext = "kmz" if kmz else EXT[fmt]
        return self.path / export_name(base, frame.suffix, ext)


def _notes_dict(frame: Frame) -> dict[str, str]:
    m = frame.meta
    return {
        "CRS": str(m["crs"]),
        "Horizontal units": str(m["horizontalUnits"]),
        "Vertical datum": str(m["verticalDatum"]),
        "Geoid": str(m["geoid"] or "none"),
        "Site calibration": str(m["calibration"] or "none"),
        "Height units": str(m["units"]),
        "Written": f"{m['writtenAt']} by Quadrion AI survey.export",
    }


def write_parts(
    path: Path, fmt: str, frame: Frame, parts: DesignParts, ctx: StepContext | None = None
) -> dict[str, Any]:
    """Design-like content (already in the output frame) to a TIN or CAD format, or points CSV."""
    from ..export.dxf import DxfWriter
    from ..export.landxml import write_landxml
    from ..export.twelve_da import alignment_polyline, write_12da
    from ..export.vector import PointRow, write_points_csv

    notes = frame.notes()
    counts = {
        "surfaces": len(parts.surfaces),
        "triangles": int(sum(len(s.triangles) for s in parts.surfaces)),
        "alignments": len(parts.alignments),
        "points": int(sum(len(p.points) for p in parts.points)),
        "lines": int(sum(len(w.lines) for w in parts.linework)),
    }
    if fmt == "landxml":
        if parts.linework and ctx is not None:
            ctx.log("Linework is not written to LandXML; export it as DXF or 12da.", "warn")
        write_landxml(
            path,
            units=frame.units,
            notes=notes,
            crs_name=str(frame.meta["crs"]),
            epsg=frame.epsg,
            vertical=str(frame.meta["verticalDatum"]),
            surfaces=parts.surfaces,
            alignments=parts.alignments,
            points=parts.points,
            project=parts.name,
        )
    elif fmt == "12da":
        write_12da(
            path,
            notes=notes,
            tins=parts.surfaces,
            linework=parts.linework,
            points=parts.points,
            alignments=parts.alignments,
        )
    elif fmt == "dxf":
        w = DxfWriter(frame.units, _notes_dict(frame))
        for k, s in enumerate(parts.surfaces):
            ctx.check() if ctx else None
            v = np.asarray(s.vertices, dtype=np.float64)
            t = np.asarray(s.triangles, dtype=np.int64)
            w.layer(s.name, (k % 6) + 1)
            for a in range(0, len(t), 200_000):
                w.faces(s.name, v[t[a : a + 200_000]])
            for kind, c in s.chains:
                lay = f"{s.name} breaklines" if kind == CHAIN_BREAKLINE else f"{s.name} boundary"
                w.polyline3d(lay, c, closed=kind != CHAIN_BREAKLINE)
        for al in parts.alignments:
            pl = alignment_polyline(al)
            w.polyline3d(al.name, np.column_stack([pl, np.zeros(len(pl))]))
        for lw in parts.linework:
            for line in lw.lines:
                w.polyline3d(lw.name, line.coords, closed=line.closed)
        for pts in parts.points:
            for p in pts.points:
                w.point(pts.name, p.e, p.n, p.z)
        w.save(path)
        counts["faces"] = w.face_count
    elif fmt == "csv":
        rows: list[PointRow] = []
        for pts in parts.points:
            rows += [PointRow(p.id, p.e, p.n, p.z, p.code) for p in pts.points]
        for s in parts.surfaces:
            rows += [
                PointRow(str(len(rows) + 1), float(x), float(y), float(z), None)
                for x, y, z in np.asarray(s.vertices, dtype=np.float64)
            ]
        if not rows:
            raise JobError("There are no points to write to the CSV file.")
        write_points_csv(path, rows, _csv_order(ctx, frame))
        counts["rows"] = len(rows)
    else:
        raise JobError(f"{fmt} is not a format for surfaces and designs.")
    return counts


def _csv_order(ctx: StepContext | None, frame: Frame) -> str:
    if frame.geographic:
        return "geo"
    order = "NEZ"
    if ctx is not None:
        p = ctx.project / "survey" / "settings.json"
        if p.is_file():
            s = _read_json(p, "survey settings")
            if isinstance(s, dict) and s.get("order") == "ENZ":
                order = "ENZ"
    return order


def write_features(path: Path, fmt: str, frame: Frame, feats: list[Any], name: str) -> dict[str, Any]:
    from ..export.vector import write_geojson, write_kml, write_shp

    if not feats:
        raise JobError("There is nothing to export.")
    if fmt == "geojson":
        write_geojson(
            path, feats, epsg=frame.epsg, wgs84=frame.geographic and frame.epsg == 4326, meta=frame.meta
        )
        return {"features": len(feats)}
    if fmt == "kml":
        write_kml(path, name, feats, frame.notes())
        return {"features": len(feats)}
    if fmt == "shp":
        files = write_shp(path, feats, wkt=frame.wkt)
        return {"features": len(feats), "files": [str(f) for f in files]}
    raise JobError(f"{fmt} is not a format for outlines.")


def boundary_features(frame: Frame, surfaces: list[Surface], name: str) -> list[Any]:
    """Each surface's outer boundaries (with their holes) as polygons in the output frame."""
    from ..export.tin import boundary_rings
    from ..export.vector import Feature

    feats = []
    for s in surfaces:
        rings = boundary_rings(s.vertices, s.triangles)
        outers = [(r, s.vertices[r]) for o, r in rings if o]
        holes = [s.vertices[r] for o, r in rings if not o]
        for k, (_, ring) in enumerate(outers):
            mine = [h for h in holes if _inside(h[0, :2], ring[:, :2])] if len(outers) > 1 else holes
            feats.append(
                Feature(
                    "polygon",
                    frame.forward_xyz(ring),
                    {"name": s.name if len(outers) == 1 else f"{s.name} {k + 1}", "surface": s.name},
                    [frame.forward_xyz(h) for h in mine],
                )
            )
    return feats


def _inside(p: np.ndarray, ring: np.ndarray) -> bool:
    x, y = float(p[0]), float(p[1])
    inside = False
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def design_features(frame: Frame, parts: DesignParts) -> list[Any]:
    """A design's surfaces (boundaries), alignments, lines and points as features (output frame)."""
    from ..export.twelve_da import alignment_polyline
    from ..export.vector import Feature

    feats = boundary_features(frame, parts.surfaces, parts.name)
    for al in parts.alignments:
        pl = alignment_polyline(al)
        xyz = frame.forward_xyz(np.column_stack([pl, np.zeros(len(pl))]))
        feats.append(Feature("line", xyz, {"name": al.name, "kind": "alignment"}))
    for lw in parts.linework:
        for line in lw.lines:
            feats.append(
                Feature(
                    "polygon" if line.closed else "line",
                    frame.forward_xyz(line.coords),
                    {"name": line.name or lw.name, "layer": lw.name},
                )
            )
    for pts in parts.points:
        if not pts.points:
            continue
        xyz = frame.forward_xyz(np.asarray([[p.e, p.n, p.z] for p in pts.points]))
        for p, row in zip(pts.points, xyz, strict=True):
            feats.append(Feature("point", row[None, :], {"name": p.id, "code": p.code, "layer": pts.name}))
    return feats


# ------------------------------------------------------------------------------------- exports


def export_surface(ctx: StepContext, params: dict[str, Any], frame: Frame, out: Out) -> dict[str, Any]:
    from .compare import ProjectSurfaces

    fmt = params["format"]
    ps = ProjectSurfaces(ctx.project)
    grid: Grid | None = None
    parts: DesignParts | None = None
    if params.get("surface"):
        sid = params["surface"]
        meta = ps.metas().get(sid)
        if meta is None:
            raise JobError(f'The surface "{sid}" is not prepared; run Prepare surfaces first.')
        src = meta.get("source") or {}
        if src.get("kind") == "design" and fmt != "geotiff":
            parts = read_design_parts(ctx.project, f"{src['design']}/{src['layer']}")
            parts.surfaces = parts.surfaces[:1]
            ctx.log("A surface prepared from a design is exported from the design's triangles.")
        else:
            grid = grid_of_prepared(ps, sid)
    elif params.get("overlay"):
        grid = grid_of_overlay(ctx.project, ps, _overlay(ctx.project, params["overlay"]))
    else:
        ref = str(params["layer"])
        manifest = _manifest(ctx.project)
        layer = None if "/" in ref else _manifest_layer(manifest, ref)
        if layer is not None:
            grid = grid_of_raster(ctx, manifest, layer)
        else:
            parts = read_design_parts(ctx.project, ref)
    ctx.progress(0.1, "Read the surface")
    if fmt == "geotiff":
        if grid is None:
            raise JobError(
                "A design is exported as GeoTIFF once prepared: run Prepare surfaces on the design "
                "layer and export the prepared surface."
            )
        return _grid_geotiff(ctx, grid, frame, out.file(grid.name, frame, fmt), params)
    if grid is not None:
        if grid.difference:
            raise JobError("A difference exports as GeoTIFF or contours.")
        if fmt in TIN_FORMATS or fmt == "csv":
            s = grid_surface(grid, params.get("decimate"), ctx)
            ctx.progress(0.5, "Writing")
            path = out.file(grid.name, frame, fmt)
            body = parts_out(frame, DesignParts(grid.name, [s]))
            if fmt == "csv":
                body.surfaces[0].chains = []
            res = write_parts(path, fmt, frame, body, ctx)
            return {"files": [str(path)], **res}
        s = grid_surface(grid, params.get("decimate") or _boundary_share(grid), ctx)
        path = out.file(grid.name, frame, fmt, kmz=_kmz(out))
        res = write_features(path, fmt, frame, boundary_features(frame, [s], grid.name), grid.name)
        return {"files": res.pop("files", [str(path)]), **res}
    assert parts is not None
    if params.get("decimate") not in (None, 1, 1.0):
        ctx.log("Design triangles are exported in full; the level of detail applies to survey surfaces.")
    path = out.file(parts.name, frame, fmt, kmz=_kmz(out))
    if fmt in BOUNDARY_FORMATS:
        res = write_features(path, fmt, frame, design_features(frame, parts), parts.name)
        return {"files": res.pop("files", [str(path)]), **res}
    res = write_parts(path, fmt, frame, parts_out(frame, parts), ctx)
    return {"files": [str(path)], **res}


def _boundary_share(grid: Grid) -> float | None:
    """A boundary of a large grid is traced on a coarser lattice (at most 4 million posts)."""
    e0, n0, e1, n1 = grid.box
    posts = (e1 - e0) * (n1 - n0) / grid.surface.cell**2
    return None if posts <= 4_000_000 else 4_000_000 / posts


def _kmz(out: Out) -> bool:
    return not out.folder and out.path.suffix.lower() == ".kmz"


def _grid_geotiff(
    ctx: StepContext, grid: Grid, frame: Frame, path: Path, params: dict[str, Any]
) -> dict[str, Any]:
    from ..export.raster import plan_grid, write_geotiff
    from .grid import bilinear

    g = grid.surface
    cell = g.cell
    step = 1
    if params.get("decimate") not in (None, 1, 1.0):
        from ..export.tin import step_for

        step = step_for(params["decimate"])
        cell = g.cell * step
    plan = plan_grid(frame, grid.box, cell, (g.origin_e, g.origin_n))

    def sample(es: np.ndarray, ns: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        z = bilinear(g, es, ns, -g.origin_e, -g.origin_n)
        return z[None, :], np.isfinite(z)

    kind = "difference" if grid.difference else "height"
    notes = frame.notes(f"{'Difference' if grid.difference else 'Heights'}: {grid.name}")
    if grid.difference:
        notes.append("Values: height of the To surface minus the From surface (no datum).")
    res = write_geotiff(
        path,
        frame,
        plan,
        sample,
        bands=1,
        kind=kind,
        notes=notes,
        check=ctx.check,
        progress=lambda f: ctx.progress(0.1 + 0.85 * f),
    )
    return {"files": [str(path)], **res}


def export_ortho(ctx: StepContext, params: dict[str, Any], frame: Frame, out: Out) -> dict[str, Any]:
    from ..change.imagery import Grid as LocalGrid
    from ..change.imagery import Ortho
    from ..export.raster import plan_grid, write_geotiff

    manifest = _manifest(ctx.project)
    layer = _manifest_layer(manifest, str(params["layer"]))
    if layer is None or layer.get("kind") != "raster" or layer.get("role") == "dsm":
        raise JobError(f'"{params["layer"]}" is not an ortho layer of the project.')
    ortho = Ortho(ctx.project, manifest, layer)
    o = manifest.get("origin") or [0, 0, 0]
    x0, z0, x1, z1 = ortho.box
    box = (o[0] + x0, o[1] - z1, o[0] + x1, o[1] - z0)
    gsd = float(ortho.gsd)
    plan = plan_grid(frame, box, gsd, (box[0], box[1]))

    def sample(es: np.ndarray, ns: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        lx, lz = es - o[0], o[1] - ns
        ok = np.isfinite(lx) & np.isfinite(lz)
        vals = np.zeros((3, len(es)))
        valid = np.zeros(len(es), bool)
        if not ok.any():
            return vals, valid
        gx0 = math.floor((float(lx[ok].min()) - x0) / gsd) * gsd + x0
        gz0 = math.floor((float(lz[ok].min()) - z0) / gsd) * gsd + z0
        cols = max(1, math.ceil((float(lx[ok].max()) - gx0) / gsd + 1e-9))
        rows = max(1, math.ceil((float(lz[ok].max()) - gz0) / gsd + 1e-9))
        lg = LocalGrid(gx0, gz0, gsd, cols, rows)
        rgb, inside = ortho.sample(lg, ctx.check)
        ci = np.clip(np.floor((lx - gx0) / gsd).astype(np.int64), 0, cols - 1)
        ri = np.clip(np.floor((lz - gz0) / gsd).astype(np.int64), 0, rows - 1)
        ci[~ok], ri[~ok] = 0, 0
        vals = (rgb[ri, ci] * 255.0).T
        valid = inside[ri, ci] & ok
        return vals, valid

    path = out.file(str(layer.get("name") or layer["id"]), frame, "geotiff")
    res = write_geotiff(
        path,
        frame,
        plan,
        sample,
        bands=3,
        kind="rgb",
        notes=frame.notes(f"Orthomosaic: {layer.get('name') or layer['id']}"),
        check=ctx.check,
        progress=lambda f: ctx.progress(0.1 + 0.85 * f),
    )
    return {"files": [str(path)], **res}


def _las_wkt(frame: Frame) -> str:
    from pyproj import CRS
    from pyproj.enums import WktVersion

    if frame.calibrated:
        return frame.wkt
    try:
        if frame.vertical_epsg and frame.epsg:
            c = CRS.from_user_input(f"EPSG:{frame.epsg}+{frame.vertical_epsg}")
        else:
            c = CRS.from_wkt(frame.wkt)
        return c.to_wkt(WktVersion.WKT1_GDAL) or frame.wkt
    except Exception:
        return frame.wkt


def export_cloud(ctx: StepContext, params: dict[str, Any], frame: Frame, out: Out) -> dict[str, Any]:
    from ..change.las import LasError, read_las
    from ..change.surface import Surface as CloudSurface
    from ..export.las import PDAL_NEEDED, compress_laz, las_from_xyz, write_las
    from ..export.raster import sidecar
    from ..pointcloud import _run, find_pdal, pdal_env

    manifest = _manifest(ctx.project)
    lid = str(params["layer"])
    layer = _manifest_layer(manifest, lid)
    if layer is None or layer.get("kind") != "pointcloud":
        raise JobError(f'"{lid}" is not a point cloud layer of the project.')
    path = out.file(str(layer.get("name") or lid), frame, "laz")
    laz = path.suffix.lower() != ".las"
    pdal = find_pdal()
    if laz and not pdal:
        raise JobError(PDAL_NEEDED)
    cs = CloudSurface(ctx.project, manifest, {"layer": lid, "kind": "cloud"})
    las = None
    if layer.get("format") != "kit-packed":
        src = cs.path
        if src.suffix.lower() == ".las":
            try:
                las = read_las(src)
            except LasError:
                las = None
        if las is None and pdal:
            plain = ctx.stage("work/cloud.las")
            if not plain.exists():
                from ..runtime import atomic_write_json

                pipe = ctx.stage("work/pdal.json")
                atomic_write_json(
                    pipe,
                    {
                        "pipeline": [
                            str(src),
                            {
                                "type": "writers.las",
                                "filename": str(plain),
                                "minor_version": 4,
                                "dataformat_id": 7,
                            },
                        ]
                    },
                )
                _run(ctx, [pdal, "pipeline", str(pipe)], "Read the point cloud")
            las = read_las(plain)
    ctx.progress(0.3, "Read the point cloud")
    if las is not None:
        xyz = las.xyz
    else:
        pts = cs.points(ctx)
        o = manifest.get("origin") or [0, 0, 0]
        xyz = np.stack([pts[:, 0] + o[0], o[1] - pts[:, 2], pts[:, 1] + o[2]], axis=1)
        las = las_from_xyz(xyz)
    dec = params.get("decimate")
    if dec is not None and dec < 1:
        stride = max(1, round(1 / dec))
        las.records = las.records[::stride]
        xyz = xyz[::stride]
    ctx.check()
    out_xyz = frame.forward_xyz(xyz)
    ctx.progress(0.6, "Writing")
    target = path if not laz else ctx.stage("work/export.las")
    res = write_las(target, las, out_xyz, wkt=_las_wkt(frame), geographic=frame.geographic)
    if laz:
        assert pdal is not None
        compress_laz(pdal, target, path, pdal_env(pdal))
    note = sidecar(path, frame.notes(f"Point cloud: {layer.get('name') or lid}"))
    return {"files": [str(path)], **res, "note": str(note)}


def _contour_intervals(
    params: dict[str, Any], frame: Frame, entry: dict[str, Any] | None
) -> tuple[float, float]:
    from .overlay import resolve_options

    opts = resolve_options("contours", (entry or {}).get("options") if entry else None)
    k = frame.k_z
    return opts["minorM"] / k, opts["majorM"] / k


def export_contours(ctx: StepContext, params: dict[str, Any], frame: Frame, out: Out) -> dict[str, Any]:
    from ..export.dxf import DxfWriter
    from ..export.vector import Feature
    from .compare import ProjectSurfaces
    from .contours import contour_lines
    from .overlay import surface_grid

    ps = ProjectSurfaces(ctx.project)
    entry = None
    if params.get("overlay"):
        entry = _overlay(ctx.project, params["overlay"])
        if entry.get("kind") not in ("contours",) and not (entry.get("source") or {}).get("comparison"):
            raise JobError(f'The overlay "{entry.get("name") or entry.get("id")}" is not contours.')
    if entry is not None and (entry.get("source") or {}).get("comparison"):
        grid = grid_of_overlay(ctx.project, ps, entry)
        g = grid.surface
        z, oe, on, cell = g.heights, g.origin_e, g.origin_n, g.cell
        name = grid.name
        difference = True
    else:
        sid = (entry.get("source") or {}).get("surface") if entry else params.get("surface")
        if not isinstance(sid, str):
            raise JobError("Contours need a prepared surface or a contours overlay.")
        og = surface_grid(ps, sid)
        z, oe, on, cell = og.z, og.origin_e, og.origin_n, og.cell
        name = str(ps.metas().get(sid, {}).get("name") or sid)
        difference = False
    minor, major = _contour_intervals(params, frame, entry)
    ctx.progress(0.3, "Contouring")
    if difference:
        zo = z / frame.k_z
    else:
        ny, nx = z.shape
        X, Y = np.meshgrid(oe + (np.arange(nx) + 0.5) * cell, on + (np.arange(ny) + 0.5) * cell)
        ok = np.isfinite(z)
        zo = np.full(z.shape, np.nan)
        if ok.any():
            _, _, zz = frame.forward(X[ok], Y[ok], z[ok])
            zo[ok] = zz
    feats_p = contour_lines(zo, oe, on, cell, minor, major, ctx.check)
    if not feats_p:
        raise JobError(f'"{name}" has no contours at {minor:g} intervals.')
    ctx.progress(0.7, "Writing")
    fmt = params["format"]
    path = out.file(f"{name} contours", frame, fmt, kmz=_kmz(out))
    lines = []
    for f in feats_p:
        c = np.asarray(f["geometry"]["coordinates"], dtype=np.float64)
        x, y, _ = frame.forward(c[:, 0], c[:, 1])
        level = float(f["properties"]["levelM"])
        lines.append(
            (
                np.column_stack([x, y, np.full(len(x), level)]),
                level,
                bool(f["properties"]["major"]),
                bool(f["properties"]["closed"]),
            )
        )
    if fmt == "dxf":
        w = DxfWriter(frame.units, _notes_dict(frame))
        w.layer("Contours minor", 8)
        w.layer("Contours major", 7)
        for xyz, level, major_, closed in lines:
            pts = xyz[:-1] if closed and len(xyz) > 2 else xyz
            w.lwpolyline("Contours major" if major_ else "Contours minor", pts[:, :2], level, closed)
        w.save(path)
        return {"files": [str(path)], "contours": len(lines), "minor": minor, "major": major}
    feats = [
        Feature("line", xyz, {"level": level, "major": major_, "units": frame.units})
        for xyz, level, major_, _ in lines
    ]
    res = write_features(path, fmt, frame, feats, f"{name} contours")
    return {"files": res.pop("files", [str(path)]), **res, "minor": minor, "major": major}


def _measurements(project: Path, ids: list[str] | None) -> list[dict[str, Any]]:
    p = project / "survey" / "measurements.json"
    if not p.is_file():
        raise JobError("The site has no saved measurements.")
    doc = _read_json(p, "measurements")
    ms = [m for m in (doc.get("measurements") or []) if isinstance(m, dict)]
    if ids:
        by = {m.get("id"): m for m in ms}
        missing = [i for i in ids if i not in by]
        if missing:
            raise JobError(f"The site has no measurement {', '.join(missing[:5])}.")
        ms = [by[i] for i in ids]
    if not ms:
        raise JobError("There are no measurements to export.")
    return ms


def _label(m: dict[str, Any]) -> str:
    return str(m.get("label") or m.get("id"))


def _clip_surface(ctx: StepContext, ps: Any, sid: str, ring: np.ndarray, name: str) -> Surface | None:
    """The prepared surface ``sid`` inside a polygon, as a TIN of its posts with the ring as boundary."""
    from ..export.tin import grid_tin, read_posts
    from .grid import bilinear

    r = ps.grid(sid)
    g = r.grid
    e0, n0 = ring[:, 0].min(), ring[:, 1].min()
    e1, n1 = ring[:, 0].max(), ring[:, 1].max()
    z, pe, pn, sp = read_posts(g, (e0, n0, e1, n1), 1, ctx.check)
    import shapely

    ny, nx = z.shape
    X, Y = np.meshgrid(pe + np.arange(nx) * sp, pn + np.arange(ny) * sp)
    poly = shapely.Polygon(ring[:, :2])
    if not poly.is_valid:
        poly = shapely.make_valid(poly)
    inside = shapely.contains_xy(poly, X, Y)
    z = np.where(inside, z, np.nan)
    verts, tris = grid_tin(z, pe, pn, sp)
    if len(tris) == 0:
        return None
    zr = bilinear(g, ring[:, 0], ring[:, 1], -g.origin_e, -g.origin_n)
    chain = np.column_stack([ring[:, 0], ring[:, 1], np.where(np.isfinite(zr), zr, ring[:, 2])])
    return Surface(name, verts, tris, [(CHAIN_OUTER, chain)])


def export_measurements(ctx: StepContext, params: dict[str, Any], frame: Frame, out: Out) -> dict[str, Any]:
    from ..export.vector import Feature
    from .compare import ProjectSurfaces

    fmt = params["format"]
    ms = _measurements(ctx.project, params.get("measurements"))
    ps = ProjectSurfaces(ctx.project) if params.get("surface") else None
    groups = [[m] for m in ms] if out.folder else [ms]
    files: list[str] = []
    total = 0
    for gi, group in enumerate(groups):
        ctx.check()
        base = _label(group[0]) if out.folder else "measurements"
        path = out.file(base, frame, fmt, kmz=_kmz(out))
        if fmt in ("dxf", "landxml", "12da", "csv"):
            parts = DesignParts(base)
            for m in group:
                pts = np.asarray(m.get("points") or [], dtype=np.float64).reshape(-1, 3)
                label = _label(m)
                if len(pts) == 0:
                    continue
                fam = m.get("family")
                as_points = fmt in ("csv", "landxml") or fam == "point" or len(pts) < 2
                if as_points:
                    names = [label] if len(pts) == 1 else [f"{label}-{k + 1}" for k in range(len(pts))]
                    parts.points.append(
                        Points(
                            label,
                            [
                                Point(n, float(p[0]), float(p[1]), float(p[2]), m.get("tool"))
                                for n, p in zip(names, pts, strict=True)
                            ],
                        )
                    )
                else:
                    parts.linework.append(Linework(label, [Line(pts, fam == "polygon", label, "outline")]))
                if fam == "polygon" and ps is not None and fmt in TIN_FORMATS and len(pts) >= 3:
                    s = _clip_surface(ctx, ps, params["surface"], pts, f"{label} surface")
                    if s is not None:
                        parts.surfaces.append(s)
            if parts.empty():
                continue
            res = write_parts(path, fmt, frame, parts_out(frame, parts), ctx)
        else:
            feats = []
            for m in group:
                pts = np.asarray(m.get("points") or [], dtype=np.float64).reshape(-1, 3)
                if len(pts) == 0:
                    continue
                fam = m.get("family")
                kind = (
                    "point"
                    if fam == "point" or len(pts) == 1
                    else ("polygon" if fam == "polygon" and len(pts) >= 3 else "line")
                )
                props = {
                    "id": m.get("id"),
                    "name": _label(m),
                    "tool": m.get("tool"),
                    "folder": m.get("folder"),
                    "description": m.get("description"),
                }
                if kind == "point" and len(pts) > 1:
                    for k, p in enumerate(pts):
                        feats.append(
                            Feature(
                                "point",
                                frame.forward_xyz(p[None, :]),
                                {**props, "name": f"{_label(m)}-{k + 1}"},
                            )
                        )
                else:
                    feats.append(Feature(kind, frame.forward_xyz(pts), props))
            if not feats:
                continue
            res = write_features(path, fmt, frame, feats, base)
        files += res.pop("files", None) or [str(path)]
        total += len(group)
        ctx.progress(0.1 + 0.85 * (gi + 1) / len(groups))
    if not files:
        raise JobError("The chosen measurements have no points to export.")
    return {"files": files, "measurements": total}


def export_section(ctx: StepContext, params: dict[str, Any], frame: Frame, out: Out) -> dict[str, Any]:
    from ..export.dxf import DxfWriter
    from .compare import ProjectSurfaces
    from .section import sample_section

    ms = _measurements(ctx.project, params.get("measurements"))
    lines = [m for m in ms if m.get("family") == "line" and len(m.get("points") or []) >= 2]
    if not lines:
        raise JobError("Sections are cut along line measurements; choose one or more.")
    ref = {"kind": "survey", "surface": params["surface"]} if params.get("surface") else {"kind": "current"}
    ps = ProjectSurfaces(ctx.project)
    resolved = ps.resolve(ref)
    groups = [[m] for m in lines] if out.folder else [lines]
    files = []
    fmt = params["format"]
    for group in groups:
        base = _label(group[0]) if out.folder else "sections"
        path = out.file(f"{base} section", frame, fmt)
        rows: list[list[str]] = []
        w = DxfWriter(frame.units, _notes_dict(frame)) if fmt == "dxf" else None
        for m in group:
            ctx.check()
            line = [(float(p[0]), float(p[1])) for p in m["points"]]
            sec = sample_section(line, [(ref, resolved)])
            z = sec.profiles[0].z
            ok = np.isfinite(z)
            x, y, zz = frame.forward(sec.e, sec.n, np.where(ok, z, 0.0))
            ch = sec.chainage / frame.k_h if frame.horizontal else sec.chainage / frame.k_z
            label = _label(m)
            if w is not None:
                a = 0
                while a < len(z):
                    while a < len(z) and not ok[a]:
                        a += 1
                    b = a
                    while b < len(z) and ok[b]:
                        b += 1
                    if b - a >= 2:
                        w.polyline3d(f"{label} {resolved.name}", np.column_stack([x[a:b], y[a:b], zz[a:b]]))
                    a = b
            else:
                for k in range(len(z)):
                    rows.append(
                        [
                            label,
                            repr(float(ch[k])),
                            repr(float(x[k])),
                            repr(float(y[k])),
                            repr(float(zz[k])) if ok[k] else "",
                        ]
                    )
        if w is not None:
            w.save(path)
        else:
            import csv
            import io

            from ..runtime import AtomicPath

            buf = io.StringIO()
            cw = csv.writer(buf, lineterminator="\n")
            ylab = "latitude" if frame.geographic else "n"
            xlab = "longitude" if frame.geographic else "e"
            cw.writerow(
                ["section", f"chainage_{frame.units}", xlab, ylab, f"z_{frame.units} {resolved.name}"]
            )
            cw.writerows(rows)
            with AtomicPath(path) as tmp:
                tmp.write_bytes(buf.getvalue().encode("utf-8"))
        files.append(str(path))
    return {"files": files, "sections": len(lines), "surface": resolved.name}


# -------------------------------------------------------------------------------------- pipeline


class SurveyExport:
    name = "survey.export"
    title = "Survey export"
    description = (
        "Surfaces, orthos, clouds, contours, measurements and sections as GeoTIFF, LAZ, DXF, "
        "LandXML, 12da, CSV, KML, SHP or GeoJSON in the site grid or WGS84."
    )
    keys = frozenset(
        {
            "what",
            "format",
            "crs",
            "units",
            "decimate",
            "surface",
            "layer",
            "overlay",
            "measurements",
            "out",
        }
    )
    required = frozenset({"what", "format", "crs", "out"})
    choices = {  # noqa: RUF012 - read only, as the stub declared
        "what": frozenset(WHATS),
        "format": frozenset(FORMATS),
        "units": UNITS,
    }

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        known_keys(params, set(self.keys), self.name)
        missing = sorted(k for k in self.required if params.get(k) is None)
        if missing:
            raise JobError(f"{self.name} needs: {', '.join(missing)}.")
        for key, allowed in self.choices.items():
            if key in params and (not isinstance(params[key], str) or params[key] not in allowed):
                raise JobError(f"{key} must be one of: {', '.join(sorted(allowed))}.")
        crs = params["crs"]
        if isinstance(crs, str):
            if crs not in NAMED_CRS:
                raise JobError("crs must be site, wgs84 or an EPSG code.")
        elif not (
            isinstance(crs, dict)
            and set(crs) == {"epsg"}
            and isinstance(crs["epsg"], int)
            and not isinstance(crs["epsg"], bool)
            and crs["epsg"] > 0
        ):
            raise JobError("crs must be site, wgs84 or an EPSG code.")
        if "units" in params and params["units"] not in LINEAR:
            raise JobError("Survey files are written in metres (m), feet (ft) or US survey feet (us-ft).")
        dec = params.get("decimate")
        if dec is not None and (
            isinstance(dec, bool) or not isinstance(dec, int | float) or not 0 < dec <= 1
        ):
            raise JobError("decimate must be above 0 and at most 1.")
        what, fmt = params["what"], params["format"]
        if fmt not in MATRIX[what]:
            raise JobError(f"{what} exports as {', '.join(sorted(MATRIX[what]))}, not {fmt}.")
        for key in ("surface", "overlay"):
            if key in params and (not isinstance(params[key], str) or not _ID.match(params[key])):
                raise JobError(f"{key} must be an id.")
        if "layer" in params and (not isinstance(params["layer"], str) or not params["layer"].strip()):
            raise JobError("layer must be a layer id.")
        ms = params.get("measurements")
        if ms is not None and (
            not isinstance(ms, list)
            or len(ms) > 20_000
            or not all(isinstance(x, str) and _ID.match(x) for x in ms)
        ):
            raise JobError("measurements must be a list of measurement ids.")
        given = [k for k in ("surface", "layer", "overlay") if params.get(k)]
        if what == "surface" and len(given) != 1:
            raise JobError("A surface export needs one of surface, layer or overlay.")
        if what in ("ortho", "cloud") and (given != ["layer"]):
            raise JobError(f"An {what} export needs the layer.")
        if what == "contours" and (len(given) != 1 or given == ["layer"]):
            raise JobError("A contours export needs a surface or a contours overlay.")
        if what in ("measurements", "section") and [k for k in given if k != "surface"]:
            raise JobError(f"A {what} export takes measurements and, optionally, a surface.")
        out = params["out"]
        if not isinstance(out, str) or not Path(out).is_absolute():
            raise JobError("out must be an absolute file or folder chosen with the save dialog.")
        if fmt == "kml" and crs != "wgs84":
            raise JobError("KML and KMZ hold WGS 84 longitude and latitude; export them in WGS 84.")
        return dict(params)

    def inputs(self, params: dict[str, Any]) -> list[str]:
        return [
            "survey/settings.json",
            "survey/calibration.json",
            "survey/surfaces",
            "survey/designs.json",
            "survey/designs",
            "survey/overlays.json",
            "survey/measurements.json",
        ]

    def plan(self, params: dict[str, Any]) -> list[Step]:
        def run(ctx: StepContext) -> dict[str, Any]:
            what, fmt = params["what"], params["format"]
            frame = build_frame(ctx.project, params["crs"], fmt, params.get("units"))
            dest = Path(params["out"])
            folder = dest.is_dir()
            if folder and what not in ("measurements", "section"):
                raise JobError("Choose a file to export to; a folder takes one file per measurement.")
            if not folder and not dest.parent.is_dir():
                raise JobError(f"The folder {dest.parent} does not exist.")
            out = Out(dest, folder)
            ctx.log(f"{frame.meta['crs']}; {frame.meta['verticalDatum']}; {frame.meta['units']}.")
            ctx.progress(0.02, "Placing the coordinates")
            if what == "surface":
                res = export_surface(ctx, params, frame, out)
            elif what == "ortho":
                res = export_ortho(ctx, params, frame, out)
            elif what == "cloud":
                res = export_cloud(ctx, params, frame, out)
            elif what == "contours":
                res = export_contours(ctx, params, frame, out)
            elif what == "measurements":
                res = export_measurements(ctx, params, frame, out)
            else:
                res = export_section(ctx, params, frame, out)
            notes = []
            if fmt in SIDECAR:
                from ..export.raster import sidecar

                for f in res.get("files") or []:
                    notes.append(str(sidecar(Path(f), frame.notes())))
            if notes:
                res["notes"] = notes
            return {
                "out": str(dest),
                "what": what,
                "format": fmt,
                "suffix": frame.suffix,
                "crs": frame.meta,
                "embedded": fmt in EMBEDDED,
                **res,
            }

        return [Step("export", self.title, run)]


__all__ = ["MATRIX", "SurveyExport", "design_layer", "grid_surface", "read_design_parts", "write_parts"]
