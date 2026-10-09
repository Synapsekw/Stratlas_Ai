"""12da (12d Model ASCII) writer: tins, 3D strings, point strings and alignment geometry.

Written in the terms G6's reader (``design/twelve_da.py``) takes, so a tin written here reads back
identical: ``// comments`` (the export's statement), ``model "name"`` before the strings of a
model, ``tin { name "..." points { x y z ... } triangles { a b c ... } }`` with 1-based vertex
numbers, ``string 3d { name "..." closed true data { x y z ... } }``, and points as a 3D string
with ``breakline point``. Coordinates are x = easting, y = northing in the file's unit (12da does
not state it; the comments do). Numbers are written with ``repr`` so they read back the same.

**Alignments** are written as a 2D string of their geometry (every element end, and points at most
``ALIGNMENT_STEP`` apart along it): the reader takes no alignment records, and 12d's own
alignment terms are verified with the founder's interop matrix. The station equations and the
start station are stated in the string's comments.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import IO

import numpy as np

from ..design.alignment import element_point
from ..design.model import AlignmentSource, Linework, Points, Surface
from ..runtime import AtomicPath

#: Spacing of the points of an alignment written as a string, in the file's unit.
ALIGNMENT_STEP = 0.5


def r(v: float) -> str:
    f = float(v)
    return repr(f + 0.0) if f == 0 else repr(f)


def q(text: str) -> str:
    return '"' + text.replace("\\", "/").replace('"', '\\"') + '"'


def c(text: str) -> str:
    """Comment text: no quotes (the reader keeps a ``//`` after an odd number of quotes)."""
    return text.replace('"', "'").replace("\n", " ")


def _rows(f: IO[str], arr: np.ndarray, indent: str) -> None:
    for row in np.asarray(arr, dtype=np.float64).reshape(-1, 3):
        f.write(f"{indent}{r(row[0])} {r(row[1])} {r(row[2])}\n")


def alignment_polyline(al: AlignmentSource, step: float = ALIGNMENT_STEP) -> np.ndarray:
    """(k, 2) E, N along an alignment: each element's start, points at most ``step`` apart, the end."""
    pts: list[tuple[float, float]] = []
    for el in al.elements:
        length = float(el["length"])
        m = 1 if el["type"] == "line" else max(1, math.ceil(length / step))
        for k in range(m):
            e, n, _ = element_point(el, length * k / m)
            pts.append((e, n))
    last = al.elements[-1]
    pts.append((float(last["end"][0]), float(last["end"][1])))
    return np.asarray(pts, dtype=np.float64)


def write_12da(
    path: Path,
    *,
    notes: list[str],
    tins: list[Surface] | None = None,
    linework: list[Linework] | None = None,
    points: list[Points] | None = None,
    alignments: list[AlignmentSource] | None = None,
) -> None:
    with AtomicPath(path) as tmp, open(tmp, "w", encoding="utf-8", newline="\n") as f:
        for n in notes:
            f.write(f"// {n}\n")
        f.write("\n")
        for s in tins or []:
            v = np.asarray(s.vertices, dtype=np.float64).reshape(-1, 3)
            t = np.asarray(s.triangles, dtype=np.int64).reshape(-1, 3)
            f.write(f"tin {{\n  name {q(s.name)}\n  points {{\n")
            _rows(f, v, "    ")
            f.write("  }\n  triangles {\n")
            for a, b, d in t:
                f.write(f"    {a + 1} {b + 1} {d + 1}\n")
            f.write("  }\n}\n")
            for i, (_, chain) in enumerate(s.chains):
                f.write(f"model {q(s.name + ' breaklines')}\n")
                f.write(f"string 3d {{\n  name {q(f'{s.name} chain {i + 1}')}\n  data {{\n")
                _rows(f, chain, "    ")
                f.write("  }\n}\n")
        for lw in linework or []:
            f.write(f"model {q(lw.name)}\n")
            for i, line in enumerate(lw.lines):
                name = line.name or f"{lw.name} {i + 1}"
                f.write(f"string 3d {{\n  name {q(name)}\n")
                if line.closed:
                    f.write("  closed true\n")
                f.write("  data {\n")
                _rows(f, line.coords, "    ")
                f.write("  }\n}\n")
        for pts in points or []:
            f.write(f"model {q(pts.name)}\n")
            arr = np.asarray([[p.e, p.n, p.z] for p in pts.points], dtype=np.float64)
            f.write(f"string 3d {{\n  name {q(pts.name)}\n  breakline point\n  data {{\n")
            _rows(f, arr, "    ")
            f.write("  }\n}\n")
        for al in alignments or []:
            f.write(f"model {q(al.name)}\n")
            f.write(f"// alignment {c(al.name)}: start station {r(al.start_station)}\n")
            for eq in al.equations:
                f.write(f"// station equation: back {r(eq['back'])}, ahead {r(eq['ahead'])}\n")
            pl = alignment_polyline(al)
            f.write(f"string 2d {{\n  name {q(al.name)}\n  z 0\n  data_2d {{\n")
            for e, n in pl:
                f.write(f"    {r(e)} {r(n)}\n")
            f.write("  }\n}\n")
