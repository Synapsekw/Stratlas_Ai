"""survey.section: a multi-surface cross-section as DXF (2D or 3D) or CSV (M11 G5, SRV-7).

Parameters as ``SurveySectionParams`` in ``packages/schema/src/jobs.ts``: ``line`` (two or more
[E, N] points in the project CRS), ``surfaces`` (1 to 20 ``survey``, ``current``, ``previous`` or
``design`` references), ``format``, ``capture?`` (the survey the section is viewed on, for
``current`` and ``previous``) and ``out`` (an absolute file chosen by main). The step is the
section's default: half the finest grid cell.

**Sampling** is the TypeScript ``packages/survey/src/section`` arithmetic: stations are the start
of each of ``max(1, ceil(L / step - 1e-9))`` equal parts of every segment, then the last vertex;
prepared surfaces are sampled bilinearly between their posts (``grid.bilinear``), design TINs
barycentrically (the lowest-numbered triangle holding the point, barycentric weights down to
-1e-12, the layer's vertical offset added), so both agree on the shared fixture
(``packages/survey/src/section/__fixtures__/section-parity.json``) to 1e-9.

**DXF** (ezdxf, ASCII R2010, metres): one layer per surface (``NN <label>``), a polyline per run
of stations with data, the chainage at round intervals on the layer ``Section chainage`` and each
surface's elevation there as text on its own layer. The profile (chainage across, elevation up)
is drawn in a plane for the 2D formats: ``dxf-2d-xy`` at (chainage, elevation, 0), ``dxf-2d-xz``
at (chainage, 0, elevation) and ``dxf-2d-yz`` at (0, chainage, elevation); the 3D formats draw
it where it is: ``dxf-3d-zup`` at (E, N, elevation) and ``dxf-3d-yup`` at (E, elevation, -N).

**CSV**: ``chainage_m``, ``e``, ``n`` and one elevation column per surface (empty where the
surface has no data), full float precision.
"""

from __future__ import annotations

import csv
import io
import itertools
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from ..params import known_keys
from ..runtime import AtomicPath, JobError, Step, StepContext
from .compare import ProjectSurfaces, Resolved
from .grid import bilinear
from .tin import Tin

FORMATS = frozenset({"dxf-2d-xy", "dxf-2d-xz", "dxf-2d-yz", "dxf-3d-zup", "dxf-3d-yup", "csv"})
SURFACE_KINDS = frozenset({"survey", "current", "previous", "design"})
#: The step when only TINs are sampled, metres.
TIN_STEP_M = 0.5
#: Stations per section at most (the step widens beyond).
MAX_STATIONS = 100_000
#: Barycentric weights down to this count as inside (``TinSampler``).
TIN_EPS = 1e-12


# ------------------------------------------------------------------------------------- stations


def line_length(line: list[tuple[float, float]]) -> float:
    return sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in itertools.pairwise(line))


def default_step(cells: list[float | None]) -> float:
    grid = [c for c in cells if c is not None]
    return min(grid) / 2 if grid else TIN_STEP_M


def stations(
    line: list[tuple[float, float]], step: float
) -> tuple[float, np.ndarray, np.ndarray, np.ndarray]:
    """(step used, chainage, E, N): every vertex, at most ``step`` apart."""
    length = line_length(line)
    st = max(step, length / (MAX_STATIONS - 1))
    ch: list[float] = []
    es: list[float] = []
    ns: list[float] = []
    run = 0.0
    for a, b in itertools.pairwise(line):
        seg = math.hypot(b[0] - a[0], b[1] - a[1])
        if seg == 0:
            continue
        m = max(1, math.ceil(seg / st - 1e-9))
        for s in range(m):
            ch.append(run + (seg * s) / m)
            es.append(a[0] + ((b[0] - a[0]) * s) / m)
            ns.append(a[1] + ((b[1] - a[1]) * s) / m)
        run += seg
    ch.append(run)
    es.append(line[-1][0])
    ns.append(line[-1][1])
    return st, np.array(ch), np.array(es), np.array(ns)


# -------------------------------------------------------------------------------------- sampling


def tin_heights(r: Resolved, es: np.ndarray, ns: np.ndarray) -> np.ndarray:
    """Heights of a design TIN at (E, N), the offset added; NaN outside every triangle."""
    v = r.vertices if r.vertices is not None else np.zeros((0, 3))
    t = r.triangles if r.triangles is not None else np.zeros((0, 3), np.int64)
    out = np.full(len(es), np.nan)
    if len(t) == 0:
        return out
    tin = Tin(v[:, 0], v[:, 1], v[:, 2], t)
    idx = tin.index
    for k in range(len(es)):
        e, n = float(es[k]), float(ns[k])
        for tri in idx.box(e, n, e, n):
            ti = int(tri)
            if e < tin.tx0[ti] or e > tin.tx1[ti] or n < tin.ty0[ti] or n > tin.ty1[ti]:
                continue
            ae, an, az, be, bn, bz, ce, cn, cz = tin.corners(ti)
            d = (bn - cn) * (ae - ce) + (ce - be) * (an - cn)
            if d == 0:
                continue
            l1 = ((bn - cn) * (e - ce) + (ce - be) * (n - cn)) / d
            l2 = ((cn - an) * (e - ce) + (ae - ce) * (n - cn)) / d
            l3 = 1 - l1 - l2
            if l1 >= -TIN_EPS and l2 >= -TIN_EPS and l3 >= -TIN_EPS:
                out[k] = l1 * az + l2 * bz + l3 * cz + r.offset
                break
    return out


def heights(r: Resolved, es: np.ndarray, ns: np.ndarray) -> np.ndarray:
    """A surface sampled at site points (NaN where it has no data)."""
    if r.kind == "grid":
        g = r.grid
        assert g is not None
        return bilinear(g, es, ns, -g.origin_e, -g.origin_n)
    return tin_heights(r, es, ns)


def label_of(ref: dict[str, Any], r: Resolved) -> str:
    kind = ref.get("kind")
    if kind == "current":
        return f"Current survey ({r.name})"
    if kind == "previous":
        return f"Previous survey ({r.name})"
    if kind == "design" and r.offset != 0:
        return f"{r.name} (offset {round(r.offset * 1000) / 1000:g} m)"
    return r.name


def key_of(ref: dict[str, Any]) -> str:
    kind = ref.get("kind")
    if kind == "survey":
        return f"survey:{ref['surface']}"
    if kind == "design":
        return f"design:{ref['design']}/{ref['layer']}"
    return str(kind)


@dataclass
class Profile:
    key: str
    label: str
    z: np.ndarray


@dataclass
class Section:
    step: float
    chainage: np.ndarray
    e: np.ndarray
    n: np.ndarray
    profiles: list[Profile]


def sample_section(
    line: list[tuple[float, float]],
    surfaces: list[tuple[dict[str, Any], Resolved]],
    step: float | None = None,
) -> Section:
    cells = [r.grid.cell if r.kind == "grid" and r.grid is not None else None for _, r in surfaces]
    st, ch, es, ns = stations(line, step if step is not None else default_step(cells))
    profiles = [Profile(key_of(ref), label_of(ref, r), heights(r, es, ns)) for ref, r in surfaces]
    return Section(st, ch, es, ns, profiles)


# --------------------------------------------------------------------------------------- writers


def nice_step(span: float, count: int = 6) -> float:
    if not span > 0:
        return 1.0
    raw = span / count
    p = 10 ** math.floor(math.log10(raw))
    for f in (1, 2, 5, 10):
        if raw <= f * p:
            return f * p
    return 10 * p


_BAD_LAYER = re.compile(r'[<>/\\":;?*|=,`\x00-\x1f]')


def layer_name(k: int, label: str) -> str:
    name = _BAD_LAYER.sub("-", f"{k + 1:02d} {label}").strip()
    return name[:200] or f"{k + 1:02d}"


def _runs(z: np.ndarray) -> list[tuple[int, int]]:
    """Index ranges [a, b) of consecutive finite values, two or more long."""
    out = []
    ok = np.isfinite(z)
    k = 0
    while k < len(z):
        if not ok[k]:
            k += 1
            continue
        a = k
        while k < len(z) and ok[k]:
            k += 1
        if k - a >= 2:
            out.append((a, k))
    return out


def _place(fmt: str, c: float, e: float, n: float, z: float) -> tuple[float, float, float]:
    if fmt == "dxf-2d-xy":
        return (c, z, 0.0)
    if fmt == "dxf-2d-xz":
        return (c, 0.0, z)
    if fmt == "dxf-2d-yz":
        return (0.0, c, z)
    if fmt == "dxf-3d-zup":
        return (e, n, z)
    return (e, z, -n)


#: The plane each format's text is written in (its extrusion).
_EXTRUSION = {
    "dxf-2d-xy": (0.0, 0.0, 1.0),
    "dxf-2d-xz": (0.0, -1.0, 0.0),
    "dxf-2d-yz": (1.0, 0.0, 0.0),
    "dxf-3d-zup": (0.0, 0.0, 1.0),
    "dxf-3d-yup": (0.0, -1.0, 0.0),
}


def write_dxf(sec: Section, fmt: str, path: Path) -> dict[str, Any]:
    import ezdxf
    from ezdxf.math import OCS

    doc = ezdxf.new("R2010")
    doc.header["$INSUNITS"] = 6  # metres
    msp = doc.modelspace()
    ext = _EXTRUSION[fmt]
    ocs = OCS(ext)
    ch = sec.chainage
    zs_all = np.concatenate([p.z[np.isfinite(p.z)] for p in sec.profiles] or [np.zeros(0)])
    zmin = float(zs_all.min()) if zs_all.size else 0.0
    length = float(ch[-1]) if len(ch) else 0.0
    tick = nice_step(length, 8)
    h = max(0.05, round(tick / 20, 3))
    layers = []

    def text(s: str, at: tuple[float, float, float], layer: str) -> None:
        t = msp.add_text(s, dxfattribs={"height": h, "layer": layer, "extrusion": ext})
        t.set_placement(ocs.from_wcs(at))

    ticks = [k * tick for k in range(int(length / tick + 1e-9) + 1)] if length > 0 else [0.0]
    doc.layers.add("Section chainage", color=7)
    for c in ticks:
        e, n = _at(sec, c)
        below = zmin - 3 * h
        text(f"{c:.2f}", _place(fmt, c, e, n, below), "Section chainage")
    for k, p in enumerate(sec.profiles):
        name = layer_name(k, p.label)
        doc.layers.add(name, color=(k % 6) + 1)
        layers.append(name)
        for a, b in _runs(p.z):
            pts = [
                _place(fmt, float(ch[i]), float(sec.e[i]), float(sec.n[i]), float(p.z[i]))
                for i in range(a, b)
            ]
            msp.add_polyline3d(pts, dxfattribs={"layer": name})
        for c in ticks:
            z = _z_at(sec, p.z, c)
            if z is None:
                continue
            e, n = _at(sec, c)
            text(f"{z:.3f}", _place(fmt, c, e, n, z + h * (1 + 1.5 * k)), name)
    with AtomicPath(path) as tmp:
        doc.saveas(tmp)
    return {"layers": layers}


def _at(sec: Section, c: float) -> tuple[float, float]:
    return float(np.interp(c, sec.chainage, sec.e)), float(np.interp(c, sec.chainage, sec.n))


def _z_at(sec: Section, z: np.ndarray, c: float) -> float | None:
    ch = sec.chainage
    k = int(np.searchsorted(ch, c, side="right")) - 1
    k = min(max(k, 0), len(ch) - 2) if len(ch) >= 2 else 0
    if len(ch) < 2:
        return float(z[0]) if np.isfinite(z[0]) else None
    za, zb = z[k], z[k + 1]
    if not (np.isfinite(za) and np.isfinite(zb)):
        return None
    t = (c - ch[k]) / (ch[k + 1] - ch[k]) if ch[k + 1] > ch[k] else 0.0
    return float(za + (zb - za) * t)


def write_csv(sec: Section, path: Path) -> dict[str, Any]:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(["chainage_m", "e", "n", *[p.label for p in sec.profiles]])
    for k in range(len(sec.chainage)):
        row = [repr(float(sec.chainage[k])), repr(float(sec.e[k])), repr(float(sec.n[k]))]
        for p in sec.profiles:
            v = p.z[k]
            row.append(repr(float(v)) if np.isfinite(v) else "")
        w.writerow(row)
    with AtomicPath(path) as tmp:
        tmp.write_bytes(buf.getvalue().encode("utf-8"))
    return {}


# -------------------------------------------------------------------------------------- pipeline


def _check_line(line: Any) -> list[tuple[float, float]]:
    if (
        not isinstance(line, list)
        or not 2 <= len(line) <= 10_000
        or not all(
            isinstance(p, list | tuple)
            and len(p) == 2
            and all(isinstance(v, int | float) and not isinstance(v, bool) and math.isfinite(v) for v in p)
            for p in line
        )
    ):
        raise JobError("line must be 2 to 10000 [E, N] points.")
    pts = [(float(p[0]), float(p[1])) for p in line]
    if line_length(pts) <= 0:
        raise JobError("The section line has no length.")
    return pts


class SurveySection:
    name = "survey.section"
    title = "Cross-section"
    description = "A multi-surface cross-section as DXF (2D or 3D) or CSV."
    keys = frozenset({"line", "surfaces", "format", "capture", "out"})
    required = frozenset({"line", "surfaces", "format", "out"})

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        known_keys(params, set(self.keys), self.name)
        missing = sorted(k for k in self.required if params.get(k) is None)
        if missing:
            raise JobError(f"{self.name} needs: {', '.join(missing)}.")
        _check_line(params["line"])
        surfaces = params["surfaces"]
        if not isinstance(surfaces, list) or not 1 <= len(surfaces) <= 20:
            raise JobError("surfaces must be a list of 1 to 20 surfaces.")
        for k, ref in enumerate(surfaces):
            if not isinstance(ref, dict) or ref.get("kind") not in SURFACE_KINDS:
                raise JobError(f"surfaces[{k}] must be a survey, current, previous or design surface.")
        if params["format"] not in FORMATS:
            raise JobError(f"format must be one of: {', '.join(sorted(FORMATS))}.")
        out = params["out"]
        if not isinstance(out, str) or not Path(out).is_absolute():
            raise JobError("out must be an absolute file path.")
        return dict(params)

    def inputs(self, params: dict[str, Any]) -> list[str]:
        return ["survey/surfaces", "survey/designs.json", "survey/designs"]

    def plan(self, params: dict[str, Any]) -> list[Step]:
        def run(ctx: StepContext) -> dict[str, Any]:
            line = _check_line(params["line"])
            ps = ProjectSurfaces(ctx.project, params.get("capture"))
            surfaces = [(ref, ps.resolve(ref)) for ref in params["surfaces"]]
            ctx.progress(0.2, "Sampling")
            sec = sample_section(line, surfaces)
            ctx.check()
            ctx.progress(0.7, "Writing")
            out = Path(params["out"])
            fmt = params["format"]
            extra = write_csv(sec, out) if fmt == "csv" else write_dxf(sec, fmt, out)
            return {
                "out": str(out),
                "format": fmt,
                "stations": len(sec.chainage),
                "stepM": sec.step,
                "lengthM": float(sec.chainage[-1]),
                "surfaces": [p.label for p in sec.profiles],
                **extra,
            }

        return [Step("section", "Write the cross-section", run)]


__all__ = [
    "MAX_STATIONS",
    "TIN_STEP_M",
    "Section",
    "SurveySection",
    "default_step",
    "heights",
    "sample_section",
    "stations",
    "write_csv",
    "write_dxf",
]
