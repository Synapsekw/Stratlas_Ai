"""A small ASCII DXF reader for plot plans (no ezdxf): units, layers, blocks and 2D geometry.

Reads the HEADER ``$INSUNITS``, the BLOCKS (with their base points) and these ENTITIES: LINE,
LWPOLYLINE, POLYLINE with VERTEX and SEQEND, CIRCLE, ARC (kept as a polyline approximation),
TEXT, MTEXT (formatting codes stripped), POINT and INSERT (block contents expanded with the
insertion point, x and y scale and rotation, nested up to ``MAX_DEPTH``). Every entity keeps its
handle (code 5), layer (8) and colour (62). Other entity kinds are counted and skipped.

Coordinates stay in drawing units, float64. Entities in an object coordinate system with a
flipped extrusion (``230 = -1``, a mirrored 2D entity) have their x negated.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

from ..runtime import JobError

MAX_DEPTH = 16
MAX_ABS = 1e9
ARC_SEGMENT_DEG = 5.0

#: ``$INSUNITS`` codes this reader takes, to the unit names of ``DrawingImportParams``
INSUNITS = {1: "in", 2: "ft", 4: "mm", 5: "cm", 6: "m", 21: "us-ft"}
UNIT_M = {"mm": 0.001, "cm": 0.01, "m": 1.0, "in": 0.0254, "ft": 0.3048, "us-ft": 1200 / 3937}

READ = {"LINE", "LWPOLYLINE", "POLYLINE", "CIRCLE", "ARC", "TEXT", "MTEXT", "POINT", "INSERT"}


@dataclass
class Entity:
    """One drawing entity after block expansion, in drawing units."""

    type: str  # the DXF entity type (LINE, LWPOLYLINE, POLYLINE, CIRCLE, ARC, TEXT, MTEXT, POINT)
    handle: str
    layer: str
    color: int | None = None
    #: the INSERT handles it came through, outermost first, joined by "-" ("" at the top level)
    parent: str = ""
    points: list[tuple[float, float]] = field(default_factory=list)
    closed: bool = False
    center: tuple[float, float] | None = None
    radius: float | None = None
    text: str | None = None
    height: float | None = None  # text height

    @property
    def id(self) -> str:
        return f"{self.parent}-{self.handle}" if self.parent else self.handle

    def bounds(self) -> tuple[float, float, float, float]:
        if self.center is not None and self.radius is not None:
            cx, cy = self.center
            return cx - self.radius, cy - self.radius, cx + self.radius, cy + self.radius
        xs = [p[0] for p in self.points]
        ys = [p[1] for p in self.points]
        x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
        if self.text is not None and self.height:
            longest = max((len(s) for s in self.text.split("\n")), default=1)
            x1 = x0 + 0.6 * self.height * max(1, longest)
            y1 = y0 + self.height * (1 + self.text.count("\n"))
        return x0, y0, x1, y1


@dataclass
class DxfDoc:
    name: str
    units: str | None
    insunits: int
    entities: list[Entity]
    skipped: dict[str, int]
    layers: list[str]

    def counts(self) -> dict[str, int]:
        return dict(sorted(Counter(e.type for e in self.entities).items()))


# ---------------------------------------------------------------------------------------------
# group codes


@dataclass
class _Rec:
    """One record: the type (code 0) and its group codes, with the line number of the type."""

    type: str
    line: int
    codes: list[tuple[int, str, int]]

    def first(self, code: int, default: str | None = None) -> str | None:
        for c, v, _ in self.codes:
            if c == code:
                return v
        return default

    def all(self, code: int) -> list[str]:
        return [v for c, v, _ in self.codes if c == code]


def _pairs(path: Path) -> list[tuple[int, str, int]]:
    raw = path.read_bytes()
    if raw.startswith(b"AutoCAD Binary DXF"):
        raise JobError(
            f'"{path.name}" is a binary DXF, which this import does not read. '
            "Save the drawing as an ASCII DXF and import again."
        )
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("cp1252", errors="replace")
    lines = text.splitlines()
    while lines and not lines[-1].strip():
        lines.pop()
    if len(lines) % 2:
        raise JobError(
            f'"{path.name}" line {len(lines)}: the file ends in the middle of a group. '
            "The file is damaged; export it from the CAD program again."
        )
    out: list[tuple[int, str, int]] = []
    for i in range(0, len(lines), 2):
        code_s = lines[i].strip()
        try:
            code = int(code_s)
        except ValueError:
            raise JobError(
                f'"{path.name}" line {i + 1}: "{code_s[:40]}" is not a DXF group code. '
                "The file is damaged or not a DXF; export it from the CAD program again."
            ) from None
        out.append((code, lines[i + 1].strip() if code != 1 and code != 3 else lines[i + 1], i + 1))
    return out


def _records(pairs: list[tuple[int, str, int]]) -> list[tuple[str, list[_Rec]]]:
    """Sections as (name, records)."""
    sections: list[tuple[str, list[_Rec]]] = []
    recs: list[_Rec] = []
    cur: _Rec | None = None
    name: str | None = None
    for code, value, line in pairs:
        if code == 0:
            if cur is not None:
                recs.append(cur)
            cur = _Rec(value.strip(), line, [])
            continue
        if cur is None:
            continue
        cur.codes.append((code, value, line))
    if cur is not None:
        recs.append(cur)
    # split into sections
    i = 0
    while i < len(recs):
        r = recs[i]
        if r.type == "SECTION":
            name = (r.first(2) or "").strip().upper()
            # HEADER variables (code 9 and their values) sit in the SECTION record itself
            body: list[_Rec] = [_Rec("$VARS", r.line, r.codes)] if name == "HEADER" else []
            i += 1
            while i < len(recs) and recs[i].type != "ENDSEC":
                body.append(recs[i])
                i += 1
            sections.append((name, body))
        i += 1
    return sections


# ---------------------------------------------------------------------------------------------
# entities


def _float(path: Path, rec: _Rec, code: int, default: float | None = 0.0) -> float:
    for c, v, line in rec.codes:
        if c == code:
            try:
                return float(v)
            except ValueError:
                raise JobError(
                    f'"{path.name}" line {line + 1}: "{v.strip()[:40]}" is not a number. '
                    "The file is damaged; export it from the CAD program again."
                ) from None
    if default is None:
        raise JobError(f'"{path.name}" line {rec.line}: {rec.type} has no group {code}.')
    return default


def _floats(path: Path, rec: _Rec, code: int) -> list[float]:
    out = []
    for c, v, line in rec.codes:
        if c == code:
            try:
                out.append(float(v))
            except ValueError:
                raise JobError(
                    f'"{path.name}" line {line + 1}: "{v.strip()[:40]}" is not a number. '
                    "The file is damaged; export it from the CAD program again."
                ) from None
    return out


def _int(rec: _Rec, code: int, default: int = 0) -> int:
    v = rec.first(code)
    if v is None:
        return default
    try:
        return int(float(v))
    except ValueError:
        return default


_MTEXT_CODES = [
    (re.compile(r"\\p[^;\\{}]*;"), ""),  # paragraph formatting (\pxi1;)
    (re.compile(r"\\P"), "\n"),
    (re.compile(r"\\[ACFHQTWfacfhqtw][^;\\{}]*;"), ""),  # \A1; \H2.5x; \fArial|b0; ...
    (re.compile(r"\\S([^;^#/]*)[\^#/]([^;]*);"), r"\1/\2"),  # stacked fractions
    (re.compile(r"\\[LlOoKkNX]"), ""),  # underline, overline, strike toggles
    (re.compile(r"\\~"), " "),
    (re.compile(r"\\([\\{}])"), r"\1"),
]
_SPECIAL = {"%%c": "\u00d8", "%%d": "\u00b0", "%%p": "\u00b1", "%%%": "%"}


def mtext_plain(s: str) -> str:
    out = s
    for rx, rep in _MTEXT_CODES:
        out = rx.sub(rep, out)
    out = out.replace("{", "").replace("}", "")
    return plain_text(out)


def plain_text(s: str) -> str:
    out = s
    for k, v in _SPECIAL.items():
        out = out.replace(k, v).replace(k.upper(), v)
    out = re.sub(r"%%[uoUO]", "", out)
    return "\n".join(line.strip() for line in out.split("\n")).strip()


def _arc_points(cx, cy, r, a0, a1) -> list[tuple[float, float]]:
    a0 %= 360.0
    a1 %= 360.0
    sweep = (a1 - a0) % 360.0 or 360.0
    n = max(2, math.ceil(sweep / ARC_SEGMENT_DEG))
    return [
        (
            cx + r * math.cos(math.radians(a0 + sweep * i / n)),
            cy + r * math.sin(math.radians(a0 + sweep * i / n)),
        )
        for i in range(n + 1)
    ]


class _Reader:
    def __init__(self, path: Path):
        self.path = path
        self.blocks: dict[str, tuple[tuple[float, float], list[_Rec]]] = {}
        self.skipped: Counter[str] = Counter()
        self.auto = 0

    def handle(self, rec: _Rec) -> str:
        h = (rec.first(5) or "").strip()
        if not h:
            self.auto += 1
            h = f"E{self.auto}"
        return h

    def check(self, kind: str, handle: str, layer: str, values: list[float]) -> None:
        for v in values:
            if not math.isfinite(v) or abs(v) > MAX_ABS:
                raise JobError(
                    f'"{self.path.name}": {kind} {handle} on layer "{layer}" has the coordinate {v:g}, '
                    "which is not a number or larger than 1e9. Fix or delete that entity, or move the "
                    "drawing nearer its origin, and import again."
                )

    def parse(self, recs: list[_Rec]) -> list[tuple[_Rec, list[_Rec]]]:
        """Group a record list into entities; a POLYLINE takes its VERTEX records up to SEQEND."""
        out: list[tuple[_Rec, list[_Rec]]] = []
        i = 0
        while i < len(recs):
            r = recs[i]
            if r.type == "POLYLINE":
                verts = []
                i += 1
                while i < len(recs) and recs[i].type in ("VERTEX", "SEQEND"):
                    if recs[i].type == "VERTEX":
                        verts.append(recs[i])
                    i += 1
                    if recs[i - 1].type == "SEQEND":
                        break
                out.append((r, verts))
                continue
            if r.type in ("VERTEX", "SEQEND"):
                i += 1
                continue
            out.append((r, []))
            i += 1
        return out

    def entity(self, rec: _Rec, verts: list[_Rec]) -> Entity | None:
        t = rec.type
        h = self.handle(rec)
        layer = (rec.first(8) or "0").strip()
        color_s = rec.first(62)
        color = int(float(color_s)) if color_s is not None and color_s.strip().lstrip("-").isdigit() else None
        e = Entity(type=t, handle=h, layer=layer, color=color)
        f = lambda c, d=0.0: _float(self.path, rec, c, d)  # noqa: E731
        flip = f(230, 1.0) < 0  # mirrored OCS: x is negated
        sx = -1.0 if flip else 1.0
        if t == "LINE":
            e.points = [(f(10), f(20)), (f(11), f(21))]
        elif t == "LWPOLYLINE":
            xs, ys = _floats(self.path, rec, 10), _floats(self.path, rec, 20)
            e.points = [(sx * x, y) for x, y in zip(xs, ys, strict=False)]
            e.closed = bool(_int(rec, 70) & 1)
        elif t == "POLYLINE":
            flags = _int(rec, 70)
            if flags & (16 | 64):  # polygon meshes and polyface meshes are not plan geometry
                self.skipped[f"POLYLINE ({'mesh' if flags & 16 else 'polyface'})"] += 1
                return None
            ocs = 1.0 if flags & 8 else sx
            pts = []
            for v in verts:
                if _int(v, 70) & 16:  # spline frame control points
                    continue
                g = lambda c, v=v: _float(self.path, v, c, 0.0)  # noqa: E731
                pts.append((ocs * g(10), g(20)))
            e.points = pts
            e.closed = bool(flags & 1)
        elif t in ("CIRCLE", "ARC"):
            cx, cy, r = sx * f(10), f(20), f(40)
            self.check(t, h, layer, [cx, cy, r])
            if r <= 0:
                self.skipped[f"{t} (zero radius)"] += 1
                return None
            if t == "CIRCLE":
                e.center, e.radius = (cx, cy), r
                e.closed = True
            else:
                a0, a1 = f(50), f(51)
                if flip:
                    a0, a1 = 180.0 - a1, 180.0 - a0
                e.points = _arc_points(cx, cy, r, a0, a1)
        elif t in ("TEXT", "MTEXT"):
            if t == "TEXT":
                raw = rec.first(1) or ""
                e.text = plain_text(raw)
                if (_int(rec, 72) or _int(rec, 73)) and rec.first(11) is not None:
                    e.points = [(sx * f(11), f(21))]
                else:
                    e.points = [(sx * f(10), f(20))]
            else:
                raw = "".join(rec.all(3)) + (rec.first(1) or "")
                e.text = mtext_plain(raw)
                e.points = [(sx * f(10), f(20))]
            e.height = abs(f(40, 1.0)) or 1.0
            if not e.text:
                return None
        elif t == "POINT":
            e.points = [(f(10), f(20))]
        else:
            self.skipped[t] += 1
            return None
        vals = [c for p in e.points for c in p]
        self.check(t, h, layer, vals)
        if t in ("LINE", "LWPOLYLINE", "POLYLINE") and len(e.points) < 2:
            self.skipped[f"{t} (fewer than 2 points)"] += 1
            return None
        return e

    def expand(
        self, recs: list[_Rec], out: list[Entity], xf, parent: str, depth: int, stack: tuple[str, ...]
    ) -> None:
        for rec, verts in self.parse(recs):
            if rec.type == "INSERT":
                self.insert(rec, out, xf, parent, depth, stack)
                continue
            if rec.type not in READ:
                if parent == "":
                    self.skipped[rec.type] += 1
                continue
            e = self.entity(rec, verts)
            if e is None:
                continue
            if xf is not None:
                _apply(e, xf)
                self.check(e.type, e.id, e.layer, [c for p in e.points for c in p])
            e.parent = parent
            out.append(e)

    def insert(self, rec: _Rec, out: list[Entity], xf, parent: str, depth: int, stack: tuple[str, ...]):
        h = self.handle(rec)
        layer = (rec.first(8) or "0").strip()
        name = (rec.first(2) or "").strip()
        if name not in self.blocks:
            raise JobError(
                f'"{self.path.name}": INSERT {h} on layer "{layer}" uses the block "{name}", which the '
                "file does not define. Explode or bind that block in the CAD program and import again."
            )
        if name in stack:
            raise JobError(
                f'"{self.path.name}": the block "{name}" contains itself (through INSERT {h} on layer '
                f'"{layer}"). Remove the circular reference in the CAD program and import again.'
            )
        if depth >= MAX_DEPTH:
            raise JobError(
                f'"{self.path.name}": the block "{name}" (INSERT {h}) is nested more than {MAX_DEPTH} '
                "deep. Explode some of the blocks in the CAD program and import again."
            )
        f = lambda c, d=0.0: _float(self.path, rec, c, d)  # noqa: E731
        flip = f(230, 1.0) < 0
        px, py = f(10), f(20)
        sx, sy = f(41, 1.0), f(42, 1.0)
        rot = math.radians(f(50))
        self.check("INSERT", h, layer, [px, py, sx, sy])
        if flip:
            px, sx, rot = -px, -sx, -rot
        (bx, by), body = self.blocks[name]
        if _int(rec, 70, 1) > 1 or _int(rec, 71, 1) > 1:
            self.skipped["INSERT (array, first copy only)"] += 1
        c, s = math.cos(rot), math.sin(rot)
        # block point -> (p - base) * scale -> rotate -> + insertion point
        local = (
            sx * c,
            -sy * s,
            sx * s,
            sy * c,
            px - (sx * c * bx - sy * s * by),
            py - (sx * s * bx + sy * c * by),
        )
        m = local if xf is None else _compose(xf, local)
        pid = f"{parent}-{h}" if parent else h
        self.expand(body, out, m, pid, depth + 1, (*stack, name))


def _compose(outer, inner):
    a1, b1, c1, d1, e1, f1 = outer
    a2, b2, c2, d2, e2, f2 = inner
    return (
        a1 * a2 + b1 * c2,
        a1 * b2 + b1 * d2,
        c1 * a2 + d1 * c2,
        c1 * b2 + d1 * d2,
        a1 * e2 + b1 * f2 + e1,
        c1 * e2 + d1 * f2 + f1,
    )


def _apply(e: Entity, m) -> None:
    a, b, c, d, tx, ty = m
    e.points = [(a * x + b * y + tx, c * x + d * y + ty) for x, y in e.points]
    if e.center is not None and e.radius is not None:
        x, y = e.center
        e.center = (a * x + b * y + tx, c * x + d * y + ty)
        e.radius = e.radius * math.sqrt(abs(a * d - b * c))
    if e.height:
        e.height *= math.sqrt(abs(a * d - b * c))


def read_dxf(path: Path) -> DxfDoc:
    """Read an ASCII DXF into entities in drawing units; refusals name the entity and the fix."""
    pairs = _pairs(path)
    sections = _records(pairs)
    if not sections:
        raise JobError(f'"{path.name}" has no DXF sections. Export the drawing as DXF and import again.')
    insunits = 0
    r = _Reader(path)
    entity_recs: list[_Rec] = []
    for name, recs in sections:
        if name == "HEADER":
            insunits = _header_insunits(recs)
        elif name == "BLOCKS":
            i = 0
            while i < len(recs):
                if recs[i].type == "BLOCK":
                    blk = recs[i]
                    bname = (blk.first(2) or "").strip()
                    base = (_float(path, blk, 10), _float(path, blk, 20))
                    body = []
                    i += 1
                    while i < len(recs) and recs[i].type != "ENDBLK":
                        body.append(recs[i])
                        i += 1
                    r.blocks[bname] = (base, body)
                i += 1
        elif name == "ENTITIES":
            entity_recs = recs
    if insunits and insunits not in INSUNITS:
        raise JobError(
            f'"{path.name}" uses the drawing units code {insunits} ($INSUNITS), which this import does '
            "not read. Save it in mm, cm, m, in, ft or US survey ft and import again."
        )
    out: list[Entity] = []
    r.expand(entity_recs, out, None, "", 0, ())
    layers = sorted({e.layer for e in out})
    return DxfDoc(
        name=path.name,
        units=INSUNITS.get(insunits),
        insunits=insunits,
        entities=out,
        skipped=dict(sorted(r.skipped.items())),
        layers=layers,
    )


def _header_insunits(recs: list[_Rec]) -> int:
    # the HEADER is one record (no code 0 inside it): variables are code 9 followed by values
    for rec in recs:
        codes = rec.codes
        for i, (c, v, _) in enumerate(codes):
            if c == 9 and v.strip().upper() == "$INSUNITS":
                for c2, v2, _ in codes[i + 1 : i + 3]:
                    if c2 == 70:
                        try:
                            return int(v2.strip())
                        except ValueError:
                            return 0
    return 0
