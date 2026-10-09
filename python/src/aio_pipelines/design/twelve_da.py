"""12da (12d Model ASCII) designs: tins, strings and points.

12da is a text format of nested blocks: ``keyword [type] { ... }``, ``name value`` pairs, quoted
text and ``//`` comments. This reader takes:

- ``model "name"``: the strings and tins after it belong to that model (a source layer);
- ``string <type> { ... }`` with ``2d``, ``3d``, ``4d``, ``super`` and ``interface`` types: the
  vertices are the rows of its ``data``, ``data_3d`` or ``data_2d`` block (x y z, or x y with the
  string's ``z`` value); ``breakline point`` makes the string's vertices points rather than a line;
  ``closed true`` (or ``closed 1``) closes it. A model's strings are one linework layer and its
  points one points layer.
- ``tin { name ... points { x y z ... } triangles { a b c ... } }`` (also ``trimesh``): vertex rows
  and triangle rows of 1-based vertex numbers (extra columns, such as neighbours, are ignored).

Coordinates are x = easting, y = northing, metres unless the person states the units. Anything
else is skipped and counted. A record that cannot be read is refused at its line. (The public
description of 12da is thin; the terms are verified against 12d Model with G1.)
"""

from __future__ import annotations

import io
import math
import re
from collections import Counter
from pathlib import Path

import numpy as np

from .model import (
    MAX_LAYERS,
    MAX_LINE_VERTICES,
    MAX_POINTS,
    MAX_TRIANGLES,
    MAX_VERTICES,
    Design,
    Line,
    Linework,
    Point,
    Points,
    Surface,
    refuse,
)

_TOKEN = re.compile(r'"(?:[^"\\]|\\.)*"|\{|\}|[^\s{}"]+')
STRING_TYPES = {"2d", "3d", "4d", "super", "interface"}
MAX_DEPTH = 32


class _Tokens:
    """A lazy token stream with one token of lookahead (constant memory beyond the text)."""

    def __init__(self, path: Path, text: str):
        self.path = path
        self.last_line = text.count("\n") + 1
        self._it = self._scan(text)
        self._cur: tuple[str, int] | None = next(self._it, None)

    @staticmethod
    def _scan(text: str):
        for no, line in enumerate(io.StringIO(text), start=1):
            cut = line.find("//")
            if cut >= 0 and line[:cut].count('"') % 2 == 0:
                line = line[:cut]
            for m in _TOKEN.finditer(line):
                yield m.group(0), no

    def peek(self) -> str | None:
        return self._cur[0] if self._cur is not None else None

    def line(self) -> int:
        return self._cur[1] if self._cur is not None else self.last_line

    def next(self) -> str:
        if self._cur is None:
            raise refuse(self.path, f"line {self.last_line}", "the file ends inside a block; a } is missing.")
        tok = self._cur[0]
        self._cur = next(self._it, None)
        return tok

    def expect_open(self, what: str) -> None:
        line = self.line()
        if self.next() != "{":
            raise refuse(self.path, f"line {line}", f"{what} needs a {{ here.")


def _unquote(tok: str) -> str:
    return tok[1:-1].replace('\\"', '"') if tok.startswith('"') else tok


def _rows(tk: _Tokens, what: str, cap: int) -> list[tuple[int, list[str]]]:
    """The rows of a ``{ ... }`` data block, as (line, tokens), without nested blocks."""
    tk.expect_open(what)
    rows: dict[int, list[str]] = {}
    count = 0
    while True:
        line = tk.line()
        tok = tk.next()
        if tok == "}":
            break
        if tok == "{":
            raise refuse(tk.path, f"line {line}", f"{what} has a nested block where data rows belong.")
        if line not in rows:
            count += 1
            if count > cap:
                raise refuse(tk.path, f"line {line}", f"{what} has more than {cap:,} rows.")
        rows.setdefault(line, []).append(tok)
    return sorted(rows.items())


def _numbers(path: Path, line: int, toks: list[str], n: int, what: str) -> list[float]:
    if len(toks) < n:
        raise refuse(path, f"line {line}", f"{what} needs {n} numbers on the row, found {len(toks)}.")
    out = []
    for t in toks[:n]:
        try:
            v = float(t)
        except ValueError:
            raise refuse(path, f"line {line}", f'{what}: "{t[:40]}" is not a number.') from None
        if not math.isfinite(v):
            raise refuse(path, f"line {line}", f"{what}: a value is not a finite number.")
        out.append(v)
    return out


def _skip_block(tk: _Tokens, depth: int = 0) -> None:
    tk.expect_open("a block")
    level = 1
    while level:
        tok = tk.next()
        if tok == "{":
            level += 1
            if level > MAX_DEPTH:
                raise refuse(tk.path, f"line {tk.line()}", f"blocks are nested more than {MAX_DEPTH} deep.")
        elif tok == "}":
            level -= 1


def read_12da(path: Path) -> Design:
    raw = path.read_bytes()
    if raw.startswith(b"\xef\xbb\xbf"):
        raw = raw[3:]
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("cp1252", errors="replace")
    tk = _Tokens(path, text)
    design = Design("12da")
    model = "12da"
    lines: dict[str, list[Line]] = {}
    points: dict[str, list[Point]] = {}
    skipped: Counter[str] = Counter()
    totals = {"points": 0, "vertices": 0}
    order: list[str] = []

    def note(name: str) -> None:
        if name not in order:
            if len(order) >= MAX_LAYERS:
                raise refuse(
                    path, f"line {tk.line()}", f"the file has more than {MAX_LAYERS} models and tins."
                )
            order.append(name)

    while tk.peek() is not None:
        line = tk.line()
        tok = tk.next()
        low = tok.lower()
        if low == "model":
            model = _unquote(tk.next())
            note(model)
        elif low == "string":
            stype = tk.next().lower()
            if stype not in STRING_TYPES:
                skipped[f"string {stype}"] += 1
                _skip_block(tk)
                continue
            _read_string(tk, path, line, stype, model, lines, points, totals, note)
        elif low in ("tin", "trimesh"):
            surf = _read_tin(tk, path, line, low)
            if surf is not None:
                note(surf.name)
                design.surfaces.append(surf)
        elif tok == "{":
            raise refuse(path, f"line {line}", "a block with no keyword before it.")
        elif tok == "}":
            raise refuse(path, f"line {line}", "a } with no block open.")
        elif tk.peek() == "{":
            skipped[low] += 1
            _skip_block(tk)
        else:
            # a top-level "name value" setting (12d writes a few); skip its value
            if tk.peek() is not None and tk.peek() not in ("{", "}"):
                tk.next()
    for name in order:
        design.source_layers.append(name)
        if lines.get(name):
            design.linework.append(Linework(name, lines[name]))
        if points.get(name):
            design.points.append(Points(name, points[name]))
    design.skipped = dict(sorted(skipped.items()))
    if design.empty():
        raise refuse(path, None, "the file has no tins, strings or points to import.")
    return design


def _read_string(tk, path, line, stype, model, lines, points, totals, note) -> None:
    tk.expect_open(f"the {stype} string at line {line}")
    name = None
    z_const = 0.0
    is_points = False
    closed = False
    coords: list[list[float]] = []
    while True:
        at = tk.line()
        tok = tk.next()
        low = tok.lower()
        if tok == "}":
            break
        if low in ("data", "data_3d", "data_2d"):
            dim = 2 if (low == "data_2d" or stype == "2d") else 3
            for row_line, toks in _rows(tk, f'the string at line {line} ("{low}")', MAX_LINE_VERTICES):
                v = _numbers(path, row_line, toks, dim, f"string at line {line}")
                coords.append(v if dim == 3 else [v[0], v[1], math.nan])
                totals["vertices"] += 1
                if totals["vertices"] > MAX_LINE_VERTICES:
                    raise refuse(
                        path,
                        f"line {row_line}",
                        f"the file has more than {MAX_LINE_VERTICES:,} string vertices.",
                    )
        elif tok == "{":
            raise refuse(path, f"line {at}", f"the string at line {line} has a block with no keyword.")
        elif tk.peek() == "{":
            _skip_block(tk)
        else:
            value = tk.next() if tk.peek() not in (None, "}") else ""
            if value == "{":
                raise refuse(path, f"line {at}", "a setting with no value.")
            if low == "name":
                name = _unquote(value)
            elif low == "z":
                z_const = _numbers(path, at, [value], 1, f"string at line {line} z")[0]
            elif low == "breakline" and value.lower() == "point":
                is_points = True
            elif low == "closed":
                closed = value.lower() in ("true", "1", "yes")
    if not coords:
        return
    arr = np.asarray(coords, dtype=np.float64)
    arr[np.isnan(arr[:, 2]), 2] = z_const
    note(model)
    if is_points:
        out = points.setdefault(model, [])
        for k, (x, y, z) in enumerate(arr):
            totals["points"] += 1
            if totals["points"] > MAX_POINTS:
                raise refuse(path, f"line {line}", f"the file has more than {MAX_POINTS:,} points.")
            out.append(Point(f"{name or 'pt'}-{k + 1}" if name else str(len(out) + 1), x, y, z, name))
    elif len(arr) >= 2:
        lines.setdefault(model, []).append(Line(arr, closed=closed, name=name, role="line"))


def _read_tin(tk: _Tokens, path: Path, line: int, kind: str) -> Surface | None:
    tk.expect_open(f"the {kind} at line {line}")
    name = f"{kind} {line}"
    verts: list[list[float]] = []
    tris: list[list[int]] = []
    tri_line: list[int] = []
    while True:
        at = tk.line()
        tok = tk.next()
        low = tok.lower()
        if tok == "}":
            break
        if low in ("points", "vertices"):
            for row_line, toks in _rows(tk, f"the {kind} at line {line} (points)", MAX_VERTICES):
                verts.append(_numbers(path, row_line, toks, 3, f"{kind} point"))
        elif low in ("triangles", "faces"):
            for row_line, toks in _rows(tk, f"the {kind} at line {line} (triangles)", MAX_TRIANGLES):
                v = _numbers(path, row_line, toks, 3, f"{kind} triangle")
                if any(x != int(x) for x in v):
                    raise refuse(
                        path, f"line {row_line}", f"{kind} triangle: vertex numbers are whole numbers."
                    )
                tris.append([int(x) for x in v])
                tri_line.append(row_line)
            if len(tris) > MAX_TRIANGLES:
                raise refuse(
                    path,
                    f"line {line}",
                    f'the tin "{name}" has more than {MAX_TRIANGLES:,} triangles, the limit for one surface layer.',
                )
        elif tok == "{":
            raise refuse(path, f"line {at}", f"the {kind} at line {line} has a block with no keyword.")
        elif tk.peek() == "{":
            _skip_block(tk)
        else:
            value = tk.next() if tk.peek() not in (None, "}") else ""
            if low == "name":
                name = _unquote(value)
    if not tris:
        return None
    t = np.asarray(tris, dtype=np.int64) - 1
    bad = np.flatnonzero((t < 0).any(axis=1) | (t >= len(verts)).any(axis=1))
    if len(bad):
        raise refuse(
            path,
            f"line {tri_line[int(bad[0])]}",
            f'the tin "{name}" has a triangle naming vertex {tris[int(bad[0])]}, but it has {len(verts)} points.',
        )
    return Surface(name, np.asarray(verts, dtype=np.float64), t.astype(np.uint32))
