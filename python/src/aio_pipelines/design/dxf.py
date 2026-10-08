"""DXF designs (ASCII only), read with ezdxf: surfaces, linework and points per DXF layer.

- **Surfaces**: 3DFACE (a quad is two triangles), MESH (faces fanned into triangles) and POLYLINE
  polyface and polygon meshes. The faces of one DXF layer are one surface; corners at the same
  coordinates are one vertex.
- **Linework**: 3D POLYLINE, 2D POLYLINE and LWPOLYLINE (at their elevation, bulges flattened to
  1 cm), LINE. A DXF layer's lines are one linework layer.
- **Points**: POINT.
- INSERTs are expanded (blocks within blocks up to ``MAX_DEPTH``); other entities are counted and
  skipped.

Before ezdxf loads anything the file is scanned line by line in constant memory: binary DXF and DWG
are refused, a broken group code is refused at its line, and more than ``MAX_ENTITIES`` entities are
refused before any of them is built. Units come from ``$INSUNITS``.
"""

from __future__ import annotations

import math
from collections import Counter
from pathlib import Path
from typing import Any

import numpy as np

from .model import (
    MAX_ENTITIES,
    MAX_LAYERS,
    MAX_LINE_VERTICES,
    MAX_POINTS,
    MAX_TRIANGLES,
    Design,
    Line,
    Linework,
    Point,
    Points,
    Surface,
    refuse,
)

MAX_DEPTH = 8
FLATTEN_M = 0.01
#: ``$INSUNITS`` codes to ``DesignSourceUnits``
INSUNITS = {1: "in", 2: "ft", 4: "mm", 5: "cm", 6: "m", 21: "us-ft"}


def scan(path: Path) -> int:
    """Check the file is an ASCII DXF and count its entities, line by line. Returns the count."""
    with open(path, "rb") as f:
        head = f.read(22)
        if head.startswith(b"AutoCAD Binary DXF"):
            raise refuse(
                path,
                None,
                "this is a binary DXF, which this import does not read. Save the drawing as an ASCII DXF "
                "and import again.",
            )
        if head[:4] == b"AC10":
            raise refuse(path, None, "this is a DWG drawing. Save it as an ASCII DXF and import again.")
        f.seek(0)
        line_no = 0
        entities = 0
        in_entities = False
        expect_code = True
        code = 0
        last_name = ""
        blank_at = 0
        for raw in f:
            line_no += 1
            if expect_code:
                s = raw.strip()
                if not s:
                    # blank lines are only taken at the very end of the file
                    blank_at = blank_at or line_no
                    continue
                if blank_at:
                    raise refuse(
                        path,
                        f"line {blank_at}",
                        "an empty line where a DXF group code belongs. The file is damaged; export it again.",
                    )
                try:
                    code = int(s)
                except ValueError:
                    raise refuse(
                        path,
                        f"line {line_no}",
                        f'"{s[:40].decode("latin-1")}" is not a DXF group code. The file is damaged or not a '
                        "DXF; export it from the CAD program again.",
                    ) from None
                expect_code = False
            else:
                expect_code = True
                if code == 0:
                    value = raw.strip()
                    if value == b"SECTION":
                        last_name = "SECTION"
                    elif value == b"ENDSEC":
                        in_entities = False
                    elif in_entities:
                        entities += 1
                        if entities > MAX_ENTITIES:
                            raise refuse(
                                path,
                                f"line {line_no}",
                                f"the drawing has more than {MAX_ENTITIES:,} entities, more than one design "
                                "file can hold. Split the drawing and import again.",
                            )
                elif code == 2 and last_name == "SECTION":
                    in_entities = raw.strip() == b"ENTITIES"
                    last_name = ""
        if not expect_code:
            raise refuse(
                path,
                f"line {line_no}",
                "the file ends in the middle of a group. The file is damaged; export it again.",
            )
    return entities


class _Layer:
    def __init__(self) -> None:
        self.tris: list[np.ndarray] = []
        self.tri_count = 0
        self.lines: list[Line] = []
        self.line_vertices = 0
        self.points: list[Point] = []


def _v3(p: Any) -> tuple[float, float, float]:
    return float(p[0]), float(p[1]), float(p[2]) if len(p) > 2 else 0.0


def read_dxf(path: Path) -> Design:
    scan(path)
    import ezdxf
    from ezdxf import path as ezpath
    from ezdxf.render import MeshBuilder

    try:
        doc = ezdxf.readfile(str(path))
    except ezdxf.DXFStructureError as e:
        raise refuse(
            path, None, f"the DXF structure is damaged ({e}). Export it from the CAD program again."
        ) from None
    except (ezdxf.DXFError, UnicodeDecodeError, ValueError) as e:
        raise refuse(path, None, f"the DXF could not be read ({e}).") from None

    design = Design("dxf")
    code = int(doc.header.get("$INSUNITS", 0) or 0)
    design.units = INSUNITS.get(code)
    layers: dict[str, _Layer] = {}
    skipped: Counter[str] = Counter()
    totals = {"points": 0}

    def layer(name: str, handle: str) -> _Layer:
        lay = layers.get(name)
        if lay is None:
            if len(layers) >= MAX_LAYERS:
                raise refuse(path, f"entity {handle}", f"the drawing has more than {MAX_LAYERS} layers.")
            lay = layers[name] = _Layer()
        return lay

    def add_tris(lay: _Layer, name: str, handle: str, tris: np.ndarray) -> None:
        lay.tri_count += len(tris)
        if lay.tri_count > MAX_TRIANGLES:
            raise refuse(
                path,
                f"entity {handle}",
                f'the layer "{name}" has more than {MAX_TRIANGLES:,} triangles, the limit for one surface '
                "layer. Thin the surface or split it and import again.",
            )
        lay.tris.append(tris)

    def add_line(lay: _Layer, name: str, handle: str, coords: list[Any], closed: bool) -> None:
        arr = np.asarray([_v3(p) for p in coords], dtype=np.float64).reshape(-1, 3)
        if len(arr) < 2:
            return
        if not np.isfinite(arr).all():
            raise refuse(path, f"entity {handle}", "a vertex is not a finite number.")
        lay.line_vertices += len(arr)
        if lay.line_vertices > MAX_LINE_VERTICES:
            raise refuse(
                path,
                f"entity {handle}",
                f'the layer "{name}" has more than {MAX_LINE_VERTICES:,} line vertices.',
            )
        lay.lines.append(Line(arr, closed=closed, name=None, role="line"))

    def mesh_tris(vertices: list[Any], faces: list[Any]) -> np.ndarray:
        v = np.asarray([_v3(p) for p in vertices], dtype=np.float64).reshape(-1, 3)
        out = []
        for face in faces:
            idx = list(face)
            for i in range(1, len(idx) - 1):
                out.append((idx[0], idx[i], idx[i + 1]))
        if not out:
            return np.zeros((0, 3, 3))
        t = np.asarray(out, dtype=np.int64)
        if t.max() >= len(v) or t.min() < 0:
            raise ValueError("a face names a vertex that does not exist")
        return v[t]

    def visit(e: Any, depth: int) -> None:
        kind = e.dxftype()
        handle = e.dxf.get("handle", "?") or "?"
        name = e.dxf.get("layer", "0") or "0"
        try:
            if kind == "3DFACE":
                c = [_v3(e.dxf.get(f"vtx{i}")) for i in range(4)]
                tris = [c[0:3]] if c[3] == c[2] else [c[0:3], [c[0], c[2], c[3]]]
                add_tris(layer(name, handle), name, handle, np.asarray(tris, dtype=np.float64))
            elif kind == "MESH":
                add_tris(layer(name, handle), name, handle, mesh_tris(list(e.vertices), list(e.faces)))
            elif kind == "POLYLINE" and (e.is_poly_face_mesh or e.is_polygon_mesh):
                mb = MeshBuilder.from_polyface(e)
                add_tris(layer(name, handle), name, handle, mesh_tris(mb.vertices, mb.faces))
            elif kind == "POLYLINE" and e.is_3d_polyline:
                pts = [v.dxf.location for v in e.vertices]
                add_line(layer(name, handle), name, handle, pts, bool(e.is_closed))
            elif kind in ("POLYLINE", "LWPOLYLINE"):
                p = ezpath.make_path(e)
                pts = list(p.flattening(FLATTEN_M))
                closed = bool(e.is_closed if kind == "POLYLINE" else e.closed)
                if closed and len(pts) > 2 and pts[0].isclose(pts[-1]):
                    pts = pts[:-1]
                add_line(layer(name, handle), name, handle, pts, closed)
            elif kind == "LINE":
                add_line(layer(name, handle), name, handle, [e.dxf.start, e.dxf.end], False)
            elif kind == "POINT":
                totals["points"] += 1
                if totals["points"] > MAX_POINTS:
                    raise refuse(
                        path, f"entity {handle}", f"the drawing has more than {MAX_POINTS:,} points."
                    )
                x, y, z = _v3(e.dxf.location)
                if not all(math.isfinite(v) for v in (x, y, z)):
                    raise refuse(path, f"entity {handle}", "a point is not a finite number.")
                lay = layer(name, handle)
                lay.points.append(Point(str(len(lay.points) + 1), x, y, z))
            elif kind == "INSERT":
                if depth >= MAX_DEPTH:
                    raise refuse(path, f"entity {handle}", f"blocks are nested more than {MAX_DEPTH} deep.")
                for sub in e.virtual_entities():
                    visit(sub, depth + 1)
            else:
                skipped[kind] += 1
        except (ValueError, TypeError, ezdxf.DXFError) as err:
            raise refuse(path, f"entity {handle} ({kind})", f"could not be read ({err}).") from None

    for e in doc.modelspace():
        visit(e, 0)

    for name, lay in layers.items():
        design.source_layers.append(name)
        if lay.tris:
            corners = np.concatenate(lay.tris).reshape(-1, 3)
            v, inv = np.unique(corners, axis=0, return_inverse=True)
            t = inv.reshape(-1, 3).astype(np.uint32)
            # degenerate triangles (two corners the same) carry no surface
            keep = (t[:, 0] != t[:, 1]) & (t[:, 1] != t[:, 2]) & (t[:, 0] != t[:, 2])
            design.surfaces.append(Surface(name, v, t[keep]))
        if lay.lines:
            design.linework.append(Linework(name, lay.lines))
        if lay.points:
            design.points.append(Points(name, lay.points))
    design.skipped = dict(sorted(skipped.items()))
    if design.empty():
        what = ", ".join(f"{k} {n}" for k, n in design.skipped.items()) or "nothing"
        raise refuse(
            path,
            None,
            "the drawing has no faces, lines or points to import (it has: " + what + ").",
        )
    return design
