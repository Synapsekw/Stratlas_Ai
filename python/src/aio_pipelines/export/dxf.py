"""DXF writer (ASCII R2010, ezdxf): 3DFACE surfaces, 3D polylines, contours and points by layer.

- ``$INSUNITS`` says the file's unit (6 metres, 2 feet, 21 US survey feet), so G6's reader and CAD
  programs scale it; the export's statement is in the drawing's custom properties
  (``$CUSTOMPROPERTY``, shown by AutoCAD's DWGPROPS) under "Quadrion ..." names.
- **Surfaces** are 3DFACE entities (a triangle repeats its third corner), one DXF layer per
  surface. Faces are streamed to a temporary file and spliced into the drawing ezdxf writes, so a
  surface of two million faces never becomes two million ezdxf objects. Coordinates are written
  with ``repr``, so a surface read back by ``design/dxf.py`` has the same vertices to the bit.
- **Lines** (breaklines, outlines, alignment geometry) are 3D POLYLINEs; **contours** are
  LWPOLYLINEs at their elevation (what Civil 3D and TBC build surfaces from); **points** are POINTs.
"""

from __future__ import annotations

import io
import re
import tempfile
from pathlib import Path

import numpy as np

from ..runtime import AtomicPath

INSUNITS = {"m": 6, "ft": 2, "us-ft": 21}
_BAD_LAYER = re.compile(r'[<>/\\":;?*|=,`\x00-\x1f]')
SENTINEL_LAYER = "QUADRION-FACES"


def layer_name(name: str) -> str:
    s = _BAD_LAYER.sub("-", name).strip()
    return s[:200] or "0"


def r(v: float) -> str:
    f = float(v)
    return repr(f + 0.0) if f == 0 else repr(f)


class DxfWriter:
    def __init__(self, units: str, notes: dict[str, str]):
        import ezdxf

        self.doc = ezdxf.new("R2010")
        self.doc.header["$INSUNITS"] = INSUNITS[units]
        self.doc.header["$MEASUREMENT"] = 1 if units == "m" else 0
        for k, v in notes.items():
            self.doc.header.custom_vars.append(f"Quadrion {k}"[:250], str(v)[:250])
        self.msp = self.doc.modelspace()
        self._layers: set[str] = {"0"}
        # closed by save(); faces are text on disk until then
        self._faces = tempfile.TemporaryFile("w+", encoding="ascii", newline="\n")  # noqa: SIM115
        self.face_count = 0

    def layer(self, name: str, color: int = 7) -> str:
        n = layer_name(name)
        if n not in self._layers:
            self.doc.layers.add(n, color=color)
            self._layers.add(n)
        return n

    def faces(self, layer: str, tris: np.ndarray) -> None:
        """Triangles ``(k, 3, 3)`` (corner, x y z) as 3DFACEs on ``layer``; handles are set on save."""
        name = self.layer(layer)
        t = np.asarray(tris, dtype=np.float64).reshape(-1, 3, 3)
        buf = io.StringIO()
        for a, b, c in t:
            # handle placeholder "\x00" is replaced when the file is written
            buf.write(
                f"  0\n3DFACE\n  5\n\x00\n330\n\x01\n100\nAcDbEntity\n  8\n{name}\n100\nAcDbFace\n"
                f" 10\n{r(a[0])}\n 20\n{r(a[1])}\n 30\n{r(a[2])}\n"
                f" 11\n{r(b[0])}\n 21\n{r(b[1])}\n 31\n{r(b[2])}\n"
                f" 12\n{r(c[0])}\n 22\n{r(c[1])}\n 32\n{r(c[2])}\n"
                f" 13\n{r(c[0])}\n 23\n{r(c[1])}\n 33\n{r(c[2])}\n"
            )
        self._faces.write(buf.getvalue())
        self.face_count += len(t)

    def polyline3d(self, layer: str, pts: np.ndarray, closed: bool = False) -> None:
        a = np.asarray(pts, dtype=np.float64).reshape(-1, 3)
        if len(a) < 2:
            return
        self.msp.add_polyline3d(
            [tuple(map(float, p)) for p in a], close=closed, dxfattribs={"layer": self.layer(layer)}
        )

    def lwpolyline(self, layer: str, pts: np.ndarray, elevation: float, closed: bool = False) -> None:
        a = np.asarray(pts, dtype=np.float64).reshape(-1, 2)
        if len(a) < 2:
            return
        self.msp.add_lwpolyline(
            [tuple(map(float, p)) for p in a],
            close=closed,
            dxfattribs={"layer": self.layer(layer), "elevation": float(elevation)},
        )

    def point(self, layer: str, x: float, y: float, z: float) -> None:
        self.msp.add_point((float(x), float(y), float(z)), dxfattribs={"layer": self.layer(layer)})

    def text(self, layer: str, text: str, x: float, y: float, z: float, height: float) -> None:
        t = self.msp.add_text(text, dxfattribs={"layer": self.layer(layer), "height": height})
        t.set_placement((float(x), float(y), float(z)))

    def save(self, path: Path) -> None:
        handles = self.doc.entitydb.handles
        sentinel = None
        if self.face_count:
            sentinel = self.msp.add_point((0.0, 0.0, 0.0), dxfattribs={"layer": "0"})
        first = int(str(handles), 16)
        handles.reset(f"{first + self.face_count + 1:X}")
        text = io.StringIO()
        self.doc.write(text)
        body = text.getvalue()
        with AtomicPath(path) as tmp, open(tmp, "w", encoding="utf-8", newline="\n") as out:
            if sentinel is None:
                out.write(body)
            else:
                mark = f"  0\nPOINT\n  5\n{sentinel.dxf.handle}\n"
                at = body.index(mark)
                end = body.index("\n  0\n", at + len(mark)) + 1
                out.write(body[:at])
                owner = self.msp.layout_key
                self._faces.seek(0)
                h = first
                for chunk in iter(lambda: self._faces.read(1 << 20), ""):
                    parts = chunk.split("\x00")
                    pieces = [parts[0]]
                    for p in parts[1:]:
                        pieces.append(f"{h:X}")
                        h += 1
                        pieces.append(p)
                    out.write("".join(pieces).replace("\x01", owner))
                out.write(body[end:])
        self._faces.close()
        if sentinel is not None:
            self.msp.delete_entity(sentinel)


__all__ = ["INSUNITS", "DxfWriter", "layer_name"]
