"""survey.compare: the survey engine's Python reference core and its pipeline (data-conventions 26).

**The core** (``compare_item``) computes one comparison item over one polygon:

- ``dz = To - From``; fill where ``dz > 0``, cut where ``dz < 0``; net = fill - cut, total = fill +
  cut, never negative parts.
- **Grid path** (either side a prepared grid): cells of the finer grid surface (or the item's
  ``cellM``) aligned to its tiles, in bands of 256 rows; each cell weighted by the exact share of it
  inside the polygon (``grid.coverage``); both sides sampled at the cell centres (bilinear on a grid,
  barycentric on a TIN, exactly on a level or plane); cells where a side has no data are uncovered.
- **Exact path** (both sides triangulated or planar: designs, levels, planes, TIN bases): the
  polygon is cut into triangles and integrated piece by piece (``tin.exact_compare``); ``cellM`` is
  0 in the result. With the deadband used, the parts where ``|dz| < deadbandM`` count as unchanged
  and the rest keeps its whole ``dz``, as cells do on the grid path.
- **Deadband** only when ``useDeadband``; **uncovered** share above 2% is ``partial``, above 20%
  ``refused`` (no volumes).
- **Fingerprint**: SHA-256 of the canonical JSON of every input (engine version, polygon, both
  sides with their surface fingerprints, captures and design offsets, the deadband, the cell and the
  site's vertical datum and calibration); the TypeScript executor computes the same string.

**The pipeline** (``SurveyCompare``, ``SurveyCompareParams``): ``items`` computes stored items for
many measurements at once into one results file (``out``, default ``survey/compare/<job>.json``);
``site`` compares two surfaces over their overlap (or a ring) and writes the difference grid
(``aio.grid/1``), its heat map pyramid, contours of the difference and the totals into ``out``
(default ``survey/compare/<job>/``). Nothing in the manifest changes: the outputs are drafts.
"""

from __future__ import annotations

import hashlib
import json
import math
import shutil
import warnings
from collections.abc import Callable
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path
from typing import Any

import numpy as np

from ..captures import capture_similarity
from ..params import known_keys
from ..runtime import JobError, Step, StepContext, atomic_write_json, now_iso
from ..similarity import Similarity
from ..stub import exactly_one
from .bases import TIN_STEP_M, Refused, Samples, build_base, f3
from .grid import (
    TILE,
    GridSurface,
    TileSurface,
    Window,
    bilinear,
    coverage,
    crosses_itself,
    densify,
    near_rings,
    normal_ring,
    prepared_line_up,
    read_tiles_json,
    ring_area,
    rings_within,
    sample_cells,
    signed_area,
)
from .tin import (
    HullExtension,
    Planar,
    Tin,
    ear_clip,
    exact_compare,
    rasterize,
    read_tin,
    sample_points,
    tin_extremes,
)

#: Version of the core's arithmetic; equal to ``SURVEY_ENGINE_VERSION`` in ``@aio/survey``.
ENGINE_VERSION = 1
SURFACE_KINDS = ("survey", "current", "previous", "design")
PARTIAL_SHARE = 0.02
REFUSE_SHARE = 0.20
BAND = 256
#: A perimeter sample this close (metres) to another pile's edge is on the edge the two piles
#: share (``neighbours``): the saddle between two heaps, not the ground under either.
NEIGHBOUR_M = 0.5
BASE_BOTH_SIDES = "At least one side must be a surface: a base is sampled on the other side."

Check = Callable[[], None]


ZERO = (0.0, 0.0)
#: No line-up.
NONE = Similarity(0.0, 0.0)
#: A date's line-up: a shift ``(east, north)``, or a ``Similarity`` with a turn and scale.
LineUp = tuple[float, float] | Similarity


def _line_up(v: LineUp | None) -> Similarity:
    if v is None:
        return NONE
    return v if isinstance(v, Similarity) else Similarity(float(v[0]), float(v[1]))


def _no_check() -> None:
    return None


def is_surface(ref: dict[str, Any]) -> bool:
    return ref.get("kind") in SURFACE_KINDS


# ------------------------------------------------------------------------------------ resolving


@dataclass
class Resolved:
    """A surface side: a prepared grid, or a TIN (vertices E, N, Z absolute, offset not added)."""

    kind: str
    name: str
    fingerprint: str
    capture: str | None = None
    grid: GridSurface | None = None
    vertices: np.ndarray | None = None
    triangles: np.ndarray | None = None
    offset: float = 0.0
    #: Where the surface has data (min E, min N, max E, max N), when known.
    extent: tuple[float, float, float, float] | None = None
    #: The line-up the surface was prepared with (``dateShiftM`` and ``dateTurn`` in its
    #: tiles.json), none for none.
    shift: LineUp = NONE
    #: The line-up its survey date has now (manifest): differs from ``shift`` until prepared again.
    current: LineUp = NONE
    _tins: dict[tuple[float, float], Tin] = field(default_factory=dict)

    def tin(self, le: float, ln: float) -> Tin:
        key = (le, ln)
        if key not in self._tins:
            v = self.vertices if self.vertices is not None else np.zeros((0, 3))
            t = self.triangles if self.triangles is not None else np.zeros((0, 3), np.int64)
            self._tins = {key: Tin(v[:, 0] - le, v[:, 1] - ln, v[:, 2] + self.offset, t)}
        return self._tins[key]


Resolve = Callable[[dict[str, Any]], Resolved]


# ---------------------------------------------------------------------------------- fingerprint


def _num(x: float | int) -> str:
    if isinstance(x, bool):
        raise TypeError("not a number")
    xf = float(x)
    if not math.isfinite(xf):
        raise ValueError("A fingerprint holds finite numbers only.")
    if xf == math.floor(xf) and abs(xf) < 2.0**53:
        return str(int(xf))
    sign, digits, exp = Decimal(repr(xf)).as_tuple()
    ds = "".join(str(d) for d in digits).rstrip("0") or "0"
    e = len(digits) - 1 + int(exp)
    mant = ds[0] + ("." + ds[1:] if len(ds) > 1 else "")
    return f"{'-' if sign else ''}{mant}e{'+' if e >= 0 else '-'}{abs(e)}"


def canonical(v: Any) -> str:
    """JSON with sorted keys, no spaces and numbers as ``Number.prototype.toExponential`` or integers."""
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, int | float):
        return _num(v)
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, list | tuple):
        return "[" + ",".join(canonical(x) for x in v) + "]"
    if isinstance(v, dict):
        return (
            "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + canonical(v[k]) for k in sorted(v)) + "}"
        )
    raise TypeError(f"{type(v).__name__} is not JSON")


def _side_fp(ref: dict[str, Any], r: Resolved | None) -> dict[str, Any]:
    out: dict[str, Any] = {"ref": ref}
    if r is not None:
        out["surface"] = r.fingerprint
        if r.capture is not None:
            out["capture"] = r.capture
        if ref.get("kind") == "design":
            out["offsetM"] = r.offset
    return out


def perimeter_base(spec: dict[str, Any]) -> bool:
    """True for a base sampled along the polygon's edge (the ones a shared edge changes)."""
    kind = spec.get("kind")
    if kind in ("smart", "fit-plane", "perimeter-mean"):
        return True
    return kind == "reference" and spec.get("mode") in ("perimeter-min", "perimeter-max")


def _on_perimeter(item: dict[str, Any]) -> bool:
    return perimeter_base(item["from"]) or perimeter_base(item["to"])


def touching_rings(
    ring: list[tuple[float, float]], neighbours: list[Any] | None
) -> list[list[tuple[float, float]]]:
    """The outlines of ``neighbours`` within ``NEIGHBOUR_M`` of ``ring`` (both as stored), each a
    normal ring, once each, in canonical order (the caller's order does not change the print)."""
    if not neighbours or len(ring) < 3:
        return []
    found: dict[str, list[tuple[float, float]]] = {}
    for nb in neighbours:
        r = normal_ring(nb)
        if len(r) < 2 or not rings_within(ring, r, NEIGHBOUR_M):
            continue
        found.setdefault(canonical([[p[0], p[1]] for p in r]), r)
    return [found[k] for k in sorted(found)]


def fingerprint(
    ring: list[tuple[float, float]],
    item: dict[str, Any],
    rf: Resolved | None,
    rt: Resolved | None,
    site: dict[str, Any] | None,
    ring_current: LineUp = ZERO,
    neighbours: list[Any] | None = None,
) -> str:
    touching = touching_rings(ring, neighbours) if _on_perimeter(item) else []
    obj: dict[str, Any] = {
        "engine": ENGINE_VERSION,
        "ring": [[p[0], p[1]] for p in ring],
        "from": _side_fp(item["from"], rf),
        "to": _side_fp(item["to"], rt),
        "deadbandM": float(item.get("deadbandM") or 0.0),
        "useDeadband": bool(item.get("useDeadband")),
    }
    if item.get("cellM") is not None:
        obj["cellM"] = item["cellM"]
    if site is not None:
        obj["site"] = site
    # the dates' line-ups: a comparison made before a line-up is another one (absent when none);
    # a turn goes beside the shifts, so a shift alone keeps the fingerprint it had
    sides = [
        ("from", _line_up(rf.current if rf else None)),
        ("to", _line_up(rt.current if rt else None)),
        ("ring", _line_up(ring_current)),
    ]
    shifts = {k: [v.east_m, v.north_m] for k, v in sides if (v.east_m, v.north_m) != ZERO}
    if shifts:
        obj["lineUp"] = shifts
    turns = {k: t for k, v in sides if (t := v.to_turn())}
    if turns:
        obj["lineUpTurn"] = turns
    # the piles this one shares an edge with (absent when none: a pile on its own keeps its print)
    if touching:
        obj["neighbours"] = [[[p[0], p[1]] for p in r] for r in touching]
    return "sha256:" + hashlib.sha256(canonical(obj).encode("utf-8")).hexdigest()


# --------------------------------------------------------------------------------------- labels


def _base_word(spec: dict[str, Any]) -> str:
    kind = spec.get("kind")
    if kind == "reference":
        mode = spec.get("mode")
        if mode == "level":
            return f"Level {f3(float(spec.get('levelM') or 0.0))} m"
        return {
            "perimeter-max": "Highest point on the perimeter",
            "perimeter-min": "Lowest point on the perimeter",
            "interior-max": "Highest point inside",
            "interior-min": "Lowest point inside",
        }.get(str(mode), "Reference level")
    return {
        "smart": "Smart base (triangulated perimeter)",
        "fit-plane": "Best-fit plane through the perimeter",
        "perimeter-mean": "Mean perimeter level",
        "custom": f"Custom base ({len(spec.get('vertices') or [])} vertices)",
    }.get(str(kind), str(kind))


def side_label(ref: dict[str, Any], r: Resolved | None) -> str:
    kind = ref.get("kind")
    if not is_surface(ref):
        return _base_word(ref)
    if r is None:
        if kind == "survey":
            return f"Survey {ref.get('surface')}"
        if kind == "design":
            return f"Design {ref.get('design')}, {ref.get('layer')}"
        return "Current survey" if kind == "current" else "Previous survey"
    if kind == "current":
        return f"Current survey ({r.name})"
    if kind == "previous":
        return f"Previous survey ({r.name})"
    if kind == "design" and r.offset != 0:
        return f"{r.name} (offset {f3(r.offset)} m)"
    return r.name


# ----------------------------------------------------------------------------------------- sides


class _GridSide:
    def __init__(self, r: Resolved, le: float, ln: float):
        assert r.grid is not None
        self.s = r.grid
        self.de = le - self.s.origin_e
        self.dn = ln - self.s.origin_n

    def cells(self, win: Window, check: Check, need: np.ndarray | None = None) -> np.ndarray:
        return sample_cells(self.s, self.de, self.dn, win.cell, win.i0, win.j0, win.nx, win.ny)

    def points(self, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
        return bilinear(self.s, xs, ys, self.de, self.dn)


class _TinSide:
    def __init__(self, tin: Tin, extend: bool = False):
        self.tin = tin
        self.hull = HullExtension(tin) if extend else None

    def cells(self, win: Window, check: Check, need: np.ndarray | None = None) -> np.ndarray:
        z = rasterize(self.tin, win, check)
        if self.hull is not None and need is not None:
            c = win.cell
            for r, k in zip(*np.nonzero(need & np.isnan(z)), strict=True):
                z[r, k] = self.hull.z((win.i0 + k + 0.5) * c, (win.j0 + r + 0.5) * c)
        return z

    def points(self, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
        return sample_points(self.tin, xs, ys)


class _PlanarSide:
    def __init__(self, p: Planar):
        self.fn = p.fn

    def cells(self, win: Window, check: Check, need: np.ndarray | None = None) -> np.ndarray:
        c = win.cell
        xs = (np.arange(win.i0, win.i0 + win.nx) + 0.5) * c
        ys = (np.arange(win.j0, win.j0 + win.ny) + 0.5) * c
        gx, gy = np.meshgrid(xs, ys)
        return np.asarray(self.fn(gx, gy), dtype=np.float64)

    def points(self, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
        return np.asarray(self.fn(xs, ys), dtype=np.float64)


def _bands(win: Window):
    for b0 in range(0, win.ny, BAND):
        yield Window(win.cell, win.i0, win.j0 + b0, win.nx, min(BAND, win.ny - b0))


# ------------------------------------------------------------------------------------------ core


@dataclass
class Totals:
    fill: float = 0.0
    cut: float = 0.0
    area_fill: float = 0.0
    area_cut: float = 0.0
    area_unchanged: float = 0.0
    uncovered: float = 0.0
    #: The greatest and least ``dz`` over the covered cells or pieces (±inf when none).
    dz_max: float = -math.inf
    dz_min: float = math.inf


@dataclass
class GridOut:
    """The difference on the comparison grid (site mode): ``dz`` (NaN uncovered) and weights."""

    win: Window
    le: float
    ln: float
    bands: list[tuple[Window, np.ndarray, np.ndarray]] = field(default_factory=list)


def _result(item: dict[str, Any], lf: str, lt: str, rf, rt, fp: str, now: str | None) -> dict[str, Any]:
    out: dict[str, Any] = {
        "item": item["id"],
        "status": "ok",
        "cutM3": 0.0,
        "fillM3": 0.0,
        "netM3": 0.0,
        "totalM3": 0.0,
        "areaM2": 0.0,
        "areaCutM2": 0.0,
        "areaFillM2": 0.0,
        "areaUnchangedM2": 0.0,
        "uncoveredM2": 0.0,
        "fromLabel": lf,
        "toLabel": lt,
        "deadbandM": float(item.get("deadbandM") or 0.0),
        "usedDeadband": bool(item.get("useDeadband")),
        "cellM": 0.0,
        "engine": "py",
        "fingerprint": fp,
        "computedAt": now or now_iso(),
    }
    if rf is not None and rf.capture is not None:
        out["fromCapture"] = rf.capture
    if rt is not None and rt.capture is not None:
        out["toCapture"] = rt.capture
    return out


def _refuse(res: dict[str, Any], reason: str) -> dict[str, Any]:
    res.pop("peakM", None)
    res.update(
        status="refused",
        reason=reason[:300],
        cutM3=0.0,
        fillM3=0.0,
        netM3=0.0,
        totalM3=0.0,
        areaCutM2=0.0,
        areaFillM2=0.0,
        areaUnchangedM2=0.0,
        uncoveredM2=res["areaM2"],
    )
    return res


def compare_item(
    ring: list[list[float]] | list[tuple[float, float]],
    item: dict[str, Any],
    resolve: Resolve,
    site: dict[str, Any] | None = None,
    check: Check = _no_check,
    now: str | None = None,
    grid_out: list[GridOut] | None = None,
    ring_shift: LineUp = ZERO,
    ring_current: LineUp | None = None,
    neighbours: list[Any] | None = None,
) -> dict[str, Any]:
    """One ``ComparisonResult`` (``engine: 'py'``) of ``item`` over the polygon ``ring`` (E, N).

    ``ring`` is as stored. A survey's own measurement is stored in that survey's unshifted frame
    while its prepared surface sits where the date was lined up when it was prepared: ``ring_shift``
    (that surface's ``dateShiftM``, turned by its ``dateTurn``) is put on it before sampling;
    ``ring_current`` (the date's line-up now, default ``ring_shift``) joins the fingerprint, so a
    result reads stale after a line-up. A site-wide ring is already in the lined-up frame (no shift).

    ``neighbours``: the outlines of the other piles on the same date, stored as ``ring`` is (the
    same frame, placed with it). Where the ring's edge comes within ``NEIGHBOUR_M`` of one, the two
    piles share that edge (the saddle between them, not the ground), so the perimeter bases leave
    the samples there out, as long as three remain; the outlines that come that close join the
    fingerprint.
    """
    ring_n = normal_ring(ring)
    frm, to = item["from"], item["to"]
    rf = rt = None
    problem = None
    try:
        if is_surface(frm):
            rf = resolve(frm)
        if is_surface(to):
            rt = resolve(to)
    except JobError as e:
        problem = str(e)
    fp = fingerprint(
        ring_n, item, rf, rt, site, ring_shift if ring_current is None else ring_current, neighbours
    )
    touching = touching_rings(ring_n, neighbours) if _on_perimeter(item) else []
    placed = _line_up(ring_shift)
    if not placed.is_identity():
        ring_n = [placed.apply_en(e, n) for e, n in ring_n]
        touching = [[placed.apply_en(e, n) for e, n in r] for r in touching]
    res = _result(item, side_label(frm, rf), side_label(to, rt), rf, rt, fp, now)
    if problem:
        return _refuse(res, problem)
    if len(ring_n) < 3:
        return _refuse(res, "The polygon needs three or more points.")
    if not (is_surface(frm) or is_surface(to)):
        return _refuse(res, BASE_BOTH_SIDES)
    grids = [r for r in (rt, rf) if r is not None and r.kind == "grid" and r.grid is not None]
    if grids:
        g = min(grids, key=lambda r: r.grid.cell)  # stable: To first on a tie
        le, ln = g.grid.origin_e, g.grid.origin_n
        cell = float(item.get("cellM") or g.grid.cell)
    else:
        le, ln = ring_n[0]
        cell = 0.0
    lring = [(e - le, n - ln) for e, n in ring_n]
    if signed_area(lring) < 0:
        lring.reverse()
    area = ring_area(lring)
    res["areaM2"] = area
    if crosses_itself(lring):
        return _refuse(res, "The polygon crosses itself.")
    if area <= 0:
        return _refuse(res, "The polygon has no area.")
    deadband = float(item.get("deadbandM") or 0.0)
    use_db = bool(item.get("useDeadband"))
    surf = rt if is_surface(to) and not is_surface(frm) else rf if not is_surface(to) else None
    # the piles this one shares an edge with, placed as the ring is, in the comparison's frame
    free = [[(e - le, n - ln) for e, n in r] for r in touching]
    try:
        if grids:
            res["cellM"] = cell
            tot, labels = _grid_path(
                lring, item, rf, rt, surf, le, ln, cell, deadband, use_db, check, grid_out, free
            )
        else:
            tot, labels = _exact_path(
                lring, item, rf, rt, surf, le, ln, deadband if use_db else 0.0, check, free
            )
    except Refused as e:
        return _refuse(res, str(e))
    if labels.get("from"):
        res["fromLabel"] = labels["from"]
    if labels.get("to"):
        res["toLabel"] = labels["to"]
    share = tot.uncovered / area
    res.update(
        cutM3=tot.cut,
        fillM3=tot.fill,
        netM3=tot.fill - tot.cut,
        totalM3=tot.fill + tot.cut,
        areaCutM2=tot.area_cut,
        areaFillM2=tot.area_fill,
        areaUnchangedM2=tot.area_unchanged,
        uncoveredM2=tot.uncovered,
    )
    # peak height: the surface above its base (dz when the base is From, -dz when it is To)
    if surf is not None and math.isfinite(tot.dz_max):
        res["peakM"] = max(tot.dz_max if surf is rt else -tot.dz_min, 0.0)
    pct = math.floor(share * 100 + 0.5)
    if share > REFUSE_SHARE:
        return _refuse(res, f"{pct}% outside the survey") | {"uncoveredM2": tot.uncovered}
    if share > PARTIAL_SHARE:
        res["status"] = "partial"
        res["reason"] = f"{pct}% outside the survey"
    return res


def _make_base(
    spec: dict[str, Any],
    lring: list[tuple[float, float]],
    s_points: Callable[[np.ndarray, np.ndarray], np.ndarray],
    step: float,
    interior: Callable[[], tuple[float, float] | None],
    le: float,
    ln: float,
    free: list[list[tuple[float, float]]] | None = None,
) -> tuple[Planar | Tin, str]:
    cache: dict[str, Samples] = {}

    def perimeter() -> Samples:
        # every step along the ring, those with a height, less the ones within NEIGHBOUR_M of an
        # edge shared with another pile (``free``), as long as three remain
        if "s" not in cache:
            xs, ys = densify(lring, step)
            zs = s_points(xs, ys)
            ok = np.isfinite(zs)
            if free:
                ground = ok & ~near_rings(xs, ys, free, NEIGHBOUR_M)
                if int(ground.sum()) >= 3:
                    ok = ground
            cache["s"] = Samples(xs[ok], ys[ok], zs[ok])
        return cache["s"]

    return build_base(spec, lring, perimeter, interior, s_points, lambda e, n: (e - le, n - ln))


def _grid_path(lring, item, rf, rt, surf, le, ln, cell, deadband, use_db, check, grid_out, free=None):
    win = Window.over(lring, cell)

    def side_of(r: Resolved):
        return _GridSide(r, le, ln) if r.kind == "grid" else _TinSide(r.tin(le, ln))

    sides: dict[str, Any] = {}
    labels: dict[str, str] = {}
    if rf is not None:
        sides["from"] = side_of(rf)
    if rt is not None:
        sides["to"] = side_of(rt)
    if surf is not None:
        s = sides["to"] if surf is rt else sides["from"]

        def interior() -> tuple[float, float] | None:
            lo, hi = math.inf, -math.inf
            for sub in _bands(win):
                w = coverage(lring, sub, check)
                z = s.cells(sub, check)
                ok = (w > 0) & np.isfinite(z)
                if ok.any():
                    lo, hi = min(lo, float(z[ok].min())), max(hi, float(z[ok].max()))
            return None if lo == math.inf else (lo, hi)

        side_name = "from" if surf is rt else "to"
        base, label = _make_base(item[side_name], lring, s.points, cell, interior, le, ln, free)
        sides[side_name] = _PlanarSide(base) if isinstance(base, Planar) else _TinSide(base, extend=True)
        labels[side_name] = label
    tot = Totals()
    a2 = cell * cell
    out = GridOut(win, le, ln) if grid_out is not None else None
    for sub in _bands(win):
        check()
        w = coverage(lring, sub, check)
        m = w > 0
        zf = sides["from"].cells(sub, check, m)
        zt = sides["to"].cells(sub, check, m)
        ok = m & np.isfinite(zf) & np.isfinite(zt)
        tot.uncovered += float(w[m & ~ok].sum()) * a2
        with np.errstate(invalid="ignore"):
            dz = np.where(ok, zt - zf, np.nan)
        cnt = ok & (np.abs(np.nan_to_num(dz)) >= deadband) if use_db else ok
        fm = cnt & (dz > 0)
        cm = cnt & (dz < 0)
        tot.fill += float((w[fm] * dz[fm]).sum()) * a2
        tot.cut += float((w[cm] * -dz[cm]).sum()) * a2
        tot.area_fill += float(w[fm].sum()) * a2
        tot.area_cut += float(w[cm].sum()) * a2
        tot.area_unchanged += float(w[ok & ~fm & ~cm].sum()) * a2
        if ok.any():
            tot.dz_max = max(tot.dz_max, float(dz[ok].max()))
            tot.dz_min = min(tot.dz_min, float(dz[ok].min()))
        if out is not None:
            out.bands.append((sub, np.where(m, dz, np.nan), w))
    if out is not None and grid_out is not None:
        grid_out.append(out)
    return tot, labels


def _exact_path(lring, item, rf, rt, surf, le, ln, db, check, free=None):
    ptris = ear_clip(lring)
    sides: dict[str, Any] = {}
    labels: dict[str, str] = {}
    if rf is not None:
        sides["from"] = rf.tin(le, ln)
    if rt is not None:
        sides["to"] = rt.tin(le, ln)
    if surf is not None:
        side_name = "from" if surf is rt else "to"
        s_tin: Tin = sides["to"] if surf is rt else sides["from"]
        step = float(item.get("cellM") or TIN_STEP_M)
        base, label = _make_base(
            item[side_name],
            lring,
            lambda xs, ys: sample_points(s_tin, xs, ys),
            step,
            lambda: tin_extremes(ptris, s_tin),
            le,
            ln,
            free,
        )
        sides[side_name] = base
        labels[side_name] = label
    ex = exact_compare(ptris, sides["from"], sides["to"], db, check)
    area = ring_area(lring)
    tot = Totals(
        fill=ex.fill,
        cut=ex.cut,
        area_fill=ex.area_fill,
        area_cut=ex.area_cut,
        area_unchanged=ex.area_unchanged,
        uncovered=max(area - ex.covered, 0.0),
        dz_max=ex.dz_max,
        dz_min=ex.dz_min,
    )
    return tot, labels


# ------------------------------------------------------------------- the core for other pipelines


def weighted_volumes(
    dz: np.ndarray, weights: np.ndarray, cell: float, deadband: float = 0.0, use_deadband: bool = False
) -> Totals:
    """The grid path's sums over given cells: ``weights`` (0 to 1) of each cell of ``dz`` (NaN no data).

    ``change.surface`` uses it for its regions (a weight of 1 per cell) and its ``areas`` (the exact
    coverage weights of ``ring_weights``).
    """
    w = np.asarray(weights, dtype=np.float64)
    m = w > 0
    ok = m & np.isfinite(dz)
    a2 = cell * cell
    with np.errstate(invalid="ignore"):
        d = np.where(ok, dz, 0.0)
    cnt = ok & (np.abs(d) >= deadband) if use_deadband else ok
    fm = cnt & (d > 0)
    cm = cnt & (d < 0)
    return Totals(
        fill=float((w[fm] * d[fm]).sum()) * a2,
        cut=float((w[cm] * -d[cm]).sum()) * a2,
        area_fill=float(w[fm].sum()) * a2,
        area_cut=float(w[cm].sum()) * a2,
        area_unchanged=float(w[ok & ~fm & ~cm].sum()) * a2,
        uncovered=float(w[m & ~ok].sum()) * a2,
    )


def ring_weights(
    ring_xz: list[tuple[float, float]], x0: float, z0: float, cell: float, cols: int, rows: int
) -> np.ndarray:
    """Exact coverage weights of a ring on a grid of the local frame (x east, z south, rows south)."""
    top = z0 + rows * cell
    ring = normal_ring([(x - x0, top - z) for x, z in ring_xz])
    if len(ring) < 3:
        return np.zeros((rows, cols))
    w = coverage(ring, Window(cell, 0, 0, cols, rows))
    return w[::-1].copy()


# ------------------------------------------------------------------------------- project surfaces

SOURCE_RANK = {"derived": 0, "dsm": 1, "cloud": 2, "dtm": 3, "design": 4}


class ProjectSurfaces:
    """Resolves the sides of an item in a project: prepared surfaces, captures and designs."""

    def __init__(self, project: Path, capture: str | None = None):
        self.project = Path(project)
        self.capture = capture
        self._metas: dict[str, dict[str, Any]] | None = None
        self._grids: dict[str, TileSurface] = {}
        self._tins: dict[str, Resolved] = {}
        self._manifest: dict[str, Any] | None = None
        self._scopes: dict[str, str] | None = None

    def metas(self) -> dict[str, dict[str, Any]]:
        if self._metas is None:
            found: dict[str, dict[str, Any]] = {}
            root = self.project / "survey" / "surfaces"
            if root.is_dir():
                for d in sorted(root.iterdir()):
                    if (d / "tiles.json").is_file():
                        try:
                            found[d.name] = read_tiles_json(d)
                        except JobError:
                            continue
            self._metas = found
        return self._metas

    def manifest(self) -> dict[str, Any]:
        if self._manifest is None:
            from ..change.imagery import read_manifest

            self._manifest = read_manifest(self.project)
        return self._manifest

    def _shift_of(self, capture: str) -> Similarity:
        """A date's line-up; none in a folder with no manifest at all (surfaces alone)."""
        if not (self.project / "manifest.json").is_file():
            return NONE
        return capture_similarity(self.manifest(), capture)

    def scope_shifts(self, measurement: str) -> tuple[Similarity, Similarity]:
        """``(prepared, current)`` shifts to put on a stored measurement's ring: its survey date's
        surface as prepared, and the date's line-up now (for the fingerprint). Zero for a site-wide
        or unknown measurement (those rings are already where the dates are lined up)."""
        if self._scopes is None:
            self._scopes = {}
            p = self.project / "survey" / "measurements.json"
            if p.is_file():
                try:
                    doc = json.loads(p.read_text("utf-8"))
                except (OSError, ValueError) as e:
                    raise JobError(f"The measurements could not be read: {e}") from e
                for m in doc.get("measurements") or []:
                    scope = m.get("scope") if isinstance(m, dict) else None
                    if isinstance(scope, dict) and scope.get("kind") == "survey":
                        self._scopes[str(m.get("id"))] = str(scope.get("capture"))
        cap = self._scopes.get(measurement)
        if not cap:
            return NONE, NONE
        current = self._shift_of(cap)
        sid = self.surface_of_capture(cap)
        return (prepared_line_up(self.metas()[sid]) if sid else current), current

    def captures(self) -> list[str]:
        m = self.manifest()
        caps = [c for c in m.get("captures") or [] if isinstance(c, dict) and c.get("id")]
        order = sorted(range(len(caps)), key=lambda i: (str(caps[i].get("date") or ""), i))
        return [str(caps[i]["id"]) for i in order]

    def surface_of_capture(self, capture: str) -> str | None:
        best = None
        for sid, meta in self.metas().items():
            if meta.get("capture") != capture:
                continue
            rank = SOURCE_RANK.get(str((meta.get("source") or {}).get("kind")), 9)
            if best is None or (rank, sid) < best:
                best = (rank, sid)
        return best[1] if best else None

    def grid(self, sid: str, capture: str | None = None) -> Resolved:
        meta = self.metas().get(sid)
        if meta is None:
            raise JobError(f'The surface "{sid}" is not prepared; run Prepare surfaces first.')
        if sid not in self._grids:
            self._grids[sid] = TileSurface(self.project / "survey" / "surfaces" / sid, meta)
        cap = capture or meta.get("capture")
        return Resolved(
            kind="grid",
            name=str(meta.get("name") or sid),
            fingerprint=str(meta.get("fingerprint")),
            capture=cap,
            grid=self._grids[sid],
            extent=_extent(meta),
            shift=prepared_line_up(meta),
            current=self._shift_of(str(cap)) if cap else NONE,
        )

    def current_previous(self) -> tuple[str | None, str | None]:
        caps = [c for c in self.captures() if self.surface_of_capture(c)]
        if not caps:
            return None, None
        cur = self.capture if self.capture in caps else (caps[-1] if self.capture is None else None)
        if cur is None:
            return None, None
        k = caps.index(cur)
        return cur, (caps[k - 1] if k > 0 else None)

    def design(self, did: str, lid: str) -> Resolved:
        key = f"{did}/{lid}"
        if key in self._tins:
            return self._tins[key]
        p = self.project / "survey" / "designs.json"
        try:
            designs = json.loads(p.read_text("utf-8"))
        except (OSError, ValueError) as e:
            raise JobError(f"The designs list could not be read: {e}") from e
        entry = next((d for d in designs.get("designs") or [] if d.get("id") == did), None)
        layer = next((x for x in (entry or {}).get("layers") or [] if x.get("id") == lid), None)
        if entry is None or layer is None or layer.get("kind") != "surface":
            raise JobError(f'The design surface "{did}, {lid}" is not in the designs list.')
        path = self.project / "survey" / "designs" / did / str(layer.get("file"))
        tin = read_tin(path, 0.0, 0.0, 0.0)
        r = Resolved(
            kind="tin",
            name=f"{entry.get('name') or did}, {layer.get('name') or lid}",
            fingerprint="sha256:" + hashlib.sha256(path.read_bytes()).hexdigest(),
            vertices=np.stack([tin.x, tin.y, tin.z], axis=1),
            triangles=tin.tris,
            offset=float(layer.get("verticalOffsetM") or 0.0),
        )
        self._tins[key] = r
        return r

    def resolve(self, ref: dict[str, Any]) -> Resolved:
        kind = ref.get("kind")
        if kind == "survey":
            return self.grid(str(ref["surface"]), ref.get("capture"))
        if kind in ("current", "previous"):
            cur, prev = self.current_previous()
            cap = cur if kind == "current" else prev
            if cap is None:
                which = "current" if kind == "current" else "previous"
                raise JobError(f"There is no {which} survey with a prepared surface.")
            sid = self.surface_of_capture(cap)
            assert sid is not None
            return self.grid(sid, cap)
        if kind == "design":
            return self.design(str(ref["design"]), str(ref["layer"]))
        raise JobError(f'"{kind}" is not a surface.')

    def site(self) -> dict[str, Any]:
        p = self.project / "survey" / "settings.json"
        settings: dict[str, Any] = {}
        if p.is_file():
            try:
                settings = json.loads(p.read_text("utf-8"))
            except (OSError, ValueError) as e:
                raise JobError(f"The survey settings could not be read: {e}") from e
        out: dict[str, Any] = {"verticalDatum": settings.get("verticalDatum") or {"kind": "project"}}
        if settings.get("calibration"):
            out["calibration"] = settings["calibration"]
        return out


def _extent(meta: dict[str, Any]) -> tuple[float, float, float, float] | None:
    b = meta.get("bounds")
    if isinstance(b, list) and len(b) == 6:
        return (float(b[0]), float(b[1]), float(b[3]), float(b[4]))
    return None


# -------------------------------------------------------------------------------------- pipeline


def _check_ring(ring: Any, where: str) -> None:
    if (
        not isinstance(ring, list)
        or len(ring) < 3
        or not all(
            isinstance(p, list | tuple)
            and len(p) == 2
            and all(isinstance(v, int | float) and not isinstance(v, bool) for v in p)
            for p in ring
        )
    ):
        raise JobError(f"{where} must be a ring of three or more [E, N] points.")


def _check_ref(ref: Any, where: str) -> None:
    if not isinstance(ref, dict) or not isinstance(ref.get("kind"), str):
        raise JobError(f"{where} must be a surface or a base.")


class SurveyCompare:
    name = "survey.compare"
    title = "Compare surfaces"
    description = (
        "Cut, fill, net and total between any two surfaces or a base, "
        "for many measurements at once or the whole site."
    )
    keys = frozenset({"items", "site", "out"})
    required: frozenset[str] = frozenset()

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        known_keys(params, set(self.keys), self.name)
        exactly_one(
            params.get("items") is not None,
            params.get("site") is not None,
            "Give items or site, not both.",
        )
        items = params.get("items")
        if items is not None:
            if not isinstance(items, list) or not 1 <= len(items) <= 5000:
                raise JobError("items must be a list of 1 to 5000 items.")
            for k, it in enumerate(items):
                if not isinstance(it, dict) or not isinstance(it.get("measurement"), str):
                    raise JobError(f"items[{k}] needs a measurement id.")
                _check_ring(it.get("ring"), f"items[{k}].ring")
                nbs = it.get("neighbours")
                if nbs is not None:
                    if not isinstance(nbs, list) or len(nbs) > 5000:
                        raise JobError(f"items[{k}].neighbours must be a list of rings.")
                    for j, nb in enumerate(nbs):
                        _check_ring(nb, f"items[{k}].neighbours[{j}]")
                item = it.get("item")
                if not isinstance(item, dict) or not isinstance(item.get("id"), str):
                    raise JobError(f"items[{k}].item needs an id.")
                _check_ref(item.get("from"), f"items[{k}].item.from")
                _check_ref(item.get("to"), f"items[{k}].item.to")
                if not (is_surface(item["from"]) or is_surface(item["to"])):
                    raise JobError(BASE_BOTH_SIDES)
        site = params.get("site")
        if site is not None:
            if not isinstance(site, dict):
                raise JobError("site must be { from, to, deadbandM?, cellM?, ring? }.")
            _check_ref(site.get("from"), "site.from")
            _check_ref(site.get("to"), "site.to")
            if not (is_surface(site["from"]) or is_surface(site["to"])):
                raise JobError(BASE_BOTH_SIDES)
            if site.get("ring") is not None:
                _check_ring(site["ring"], "site.ring")
        out = params.get("out")
        if out is not None and (not isinstance(out, str) or not out.strip()):
            raise JobError("out must be a project path.")
        return dict(params)

    def inputs(self, params: dict[str, Any]) -> list[str]:
        return [
            "manifest.json",
            "survey/surfaces",
            "survey/designs.json",
            "survey/designs",
            "survey/settings.json",
            "survey/measurements.json",
        ]

    def plan(self, params: dict[str, Any]) -> list[Step]:
        if params.get("items") is not None:
            return self._items_plan(params)
        return self._site_plan(params)

    # -- items

    def _items_plan(self, params: dict[str, Any]) -> list[Step]:
        def compare(ctx: StepContext) -> dict[str, Any]:
            items = params["items"]
            by_capture: dict[str | None, ProjectSurfaces] = {}
            site = ProjectSurfaces(ctx.project).site()
            results = []
            counts = {"ok": 0, "partial": 0, "refused": 0}
            for k, it in enumerate(items):
                ctx.check()
                cap = it.get("capture")
                ps = by_capture.setdefault(cap, ProjectSurfaces(ctx.project, cap))
                prepared, current = ps.scope_shifts(it["measurement"])
                r = compare_item(
                    it["ring"],
                    it["item"],
                    ps.resolve,
                    site,
                    ctx.check,
                    ring_shift=prepared,
                    ring_current=current,
                    neighbours=it.get("neighbours"),
                )
                counts[r["status"]] = counts.get(r["status"], 0) + 1
                results.append({"measurement": it["measurement"], "result": r})
                ctx.progress((k + 1) / len(items), f"{k + 1} of {len(items)}")
            atomic_write_json(
                ctx.stage("out/results.json"),
                {
                    "schema": "aio.survey-compare/1",
                    "pipeline": self.name,
                    "jobId": ctx.job.job_id,
                    "computedAt": now_iso(),
                    "results": results,
                },
            )
            return {"items": len(results), **counts}

        def commit(ctx: StepContext) -> dict[str, Any]:
            from ..runtime import commit_files

            out = params.get("out") or f"survey/compare/{ctx.job.job_id}.json"
            commit_files(ctx, [("out/results.json", out)])
            return {"out": out, **ctx.outputs("compare")}

        return [
            Step("compare", "Compare the items", compare, 4.0),
            Step("commit", "Save the results", commit),
        ]

    # -- whole site

    def _site_plan(self, params: dict[str, Any]) -> list[Step]:
        spec = params["site"]

        def compare(ctx: StepContext) -> dict[str, Any]:
            ps = ProjectSurfaces(ctx.project)
            ring = spec.get("ring") or _overlap_ring(ps, spec)
            item = {
                "id": "site",
                "from": spec["from"],
                "to": spec["to"],
                "useDeadband": spec.get("deadbandM") is not None,
                **({"deadbandM": spec["deadbandM"]} if spec.get("deadbandM") is not None else {}),
                **({"cellM": spec["cellM"]} if spec.get("cellM") is not None else {}),
            }
            outs: list[GridOut] = []
            res = compare_item(ring, item, ps.resolve, ps.site(), ctx.check, grid_out=outs)
            ctx.progress(0.6, "Difference")
            files = _site_outputs(ctx, ps, outs[0] if outs else None, spec, res)
            atomic_write_json(ctx.stage("out/result.json"), {"ring": ring, "result": res})
            return {"status": res["status"], "files": files}

        def commit(ctx: StepContext) -> dict[str, Any]:
            from ..runtime import commit_tree

            out = params.get("out") or f"survey/compare/{ctx.job.job_id}"
            old = ctx.out(out)
            if old.exists() and not (ctx.job.dir / "steps" / ".committing").exists():
                shutil.rmtree(old)
            (ctx.job.dir / "steps").mkdir(parents=True, exist_ok=True)
            (ctx.job.dir / "steps" / ".committing").write_text("", "utf-8")
            n = commit_tree(ctx, "out", out)
            (ctx.job.dir / "steps" / ".committing").unlink(missing_ok=True)
            return {"out": out, "files": n}

        return [Step("compare", "Compare the site", compare, 4.0), Step("commit", "Save the results", commit)]


def _overlap_ring(ps: ProjectSurfaces, spec: dict[str, Any]) -> list[list[float]]:
    boxes = []
    for ref in (spec["from"], spec["to"]):
        if not is_surface(ref):
            raise JobError("A whole-site comparison against a base needs a boundary (ring).")
        r = ps.resolve(ref)
        if r.kind == "grid":
            assert r.grid is not None
            boxes.append(r.extent or r.grid.bounds)
        else:
            v = r.vertices
            assert v is not None
            boxes.append(
                (float(v[:, 0].min()), float(v[:, 1].min()), float(v[:, 0].max()), float(v[:, 1].max()))
            )
    x0 = max(b[0] for b in boxes)
    y0 = max(b[1] for b in boxes)
    x1 = min(b[2] for b in boxes)
    y1 = min(b[3] for b in boxes)
    if x0 >= x1 or y0 >= y1:
        raise JobError("The two surfaces do not overlap.")
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]


#: Largest difference grid written for viewing (cells); finer comparisons are averaged down.
MAX_VIEW_CELLS = 2500 * 2500


def _site_outputs(
    ctx: StepContext, ps: ProjectSurfaces, out: GridOut | None, spec: dict[str, Any], res: dict[str, Any]
) -> list[str]:
    """The difference grid (aio.grid/1), its heat map pyramid and contours of the difference."""
    if out is None or res["status"] == "refused":
        return []
    from ..change.imagery import Grid, colour_ramp, read_manifest, to_lonlat, write_pyramid

    win = out.win
    full = np.full((win.ny, win.nx), np.nan)
    for sub, dz, _w in out.bands:
        full[sub.j0 - win.j0 : sub.j0 - win.j0 + sub.ny] = dz
    k = max(1, math.ceil(math.sqrt(win.nx * win.ny / MAX_VIEW_CELLS)))
    if k > 1:
        ny, nx = math.ceil(win.ny / k), math.ceil(win.nx / k)
        pad = np.full((ny * k, nx * k), np.nan)
        pad[: win.ny, : win.nx] = full
        blocks = pad.reshape(ny, k, nx, k)
        with np.errstate(invalid="ignore"), warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            view = np.nanmean(blocks, axis=(1, 3))
    else:
        view = full
    cell = win.cell * k
    west = out.le + win.i0 * win.cell
    south = out.ln + win.j0 * win.cell
    north = south + view.shape[0] * cell
    north_up = view[::-1]
    files = []
    # difference grid, 16-bit PNG: dz = offset + value * scale, 0 = no data
    from PIL import Image

    finite = np.isfinite(north_up)
    peak = float(np.abs(north_up[finite]).max()) if finite.any() else 0.0
    scale = max(0.001, math.ceil(peak / 32766 * 1e6) / 1e6)
    offset = -32767 * scale
    q = np.zeros(north_up.shape, np.uint16)
    q[finite] = np.clip(np.round((north_up[finite] - offset) / scale), 1, 65535).astype(np.uint16)
    Image.fromarray(q).save(ctx.stage("out/difference.png"))
    atomic_write_json(
        ctx.stage("out/difference.json"),
        {
            "schema": "aio.grid/1",
            "kind": "difference",
            "file": "difference.png",
            "x0": west,
            "y1": north,
            "res": cell,
            "width": int(view.shape[1]),
            "height": int(view.shape[0]),
            "scale": scale,
            "offset": offset,
            "nodata": 0,
        },
    )
    files += ["difference.json", "difference.png"]
    # heat map pyramid (local frame of the project)
    m = read_manifest(ctx.project)
    o = m.get("origin") or [0, 0, 0]
    stops = _heat_stops(ctx.project)
    deadband = float(spec.get("deadbandM") or 0.0)
    shown = np.where(np.abs(np.nan_to_num(north_up)) >= deadband, north_up, np.nan) if deadband else north_up
    rgba = colour_ramp(shown, stops)
    grid = Grid(west - o[0], o[1] - north, cell, int(view.shape[1]), int(view.shape[0]))
    legend = {"kind": "metres", "unit": "m", "label": "Height change", "stops": [[v, c] for v, c, _ in stops]}
    rel = ctx.params.get("out") or f"survey/compare/{ctx.job.job_id}"
    tiles = write_pyramid(rgba, grid, ctx.stage("out/heat"), f"{rel}/heat", 0.0, legend, ctx.check)
    atomic_write_json(ctx.stage("out/heat/tiles.json"), tiles)
    files.append("heat/tiles.json")
    # contours of the difference
    feats = _contours(view, west, south, cell, m, to_lonlat)
    atomic_write_json(
        ctx.stage("out/contours.geojson"), {"type": "FeatureCollection", "features": feats}, indent=None
    )
    files.append("contours.geojson")
    return files


def _heat_stops(project: Path) -> list[tuple[float, str, float]]:
    p = project / "survey" / "settings.json"
    stops = [(-1.0, "#b2182b"), (-0.1, "#f4a582"), (0.1, "#92c5de"), (1.0, "#2166ac")]
    if p.is_file():
        try:
            s = json.loads(p.read_text("utf-8"))
            got = [(float(x["value"]), str(x["color"])) for x in s["heatmap"]["stops"]]
            if len(got) >= 2:
                stops = sorted(got)
        except (OSError, ValueError, KeyError, TypeError):
            pass
    return [(v, c, 0.85) for v, c in stops]


def nice_interval(span: float) -> float:
    if span <= 0:
        return 0.1
    raw = span / 10
    p = 10 ** math.floor(math.log10(raw))
    for f in (1, 2, 5, 10):
        if raw <= f * p:
            return f * p
    return 10 * p


def _contours(view: np.ndarray, west: float, south: float, cell: float, manifest, to_lonlat) -> list[dict]:
    from skimage import measure

    ok = np.isfinite(view)
    if ok.sum() < 4:
        return []
    lo, hi = float(view[ok].min()), float(view[ok].max())
    step = nice_interval(hi - lo)
    filled = np.where(ok, view, 0.0)
    feats = []
    origin = manifest.get("origin") or [0, 0, 0]
    k0, k1 = math.ceil(lo / step), math.floor(hi / step)
    for k in range(k0, k1 + 1):
        level = round(k * step, 6)
        for line in measure.find_contours(filled, level, mask=ok):
            es = west + (line[:, 1] + 0.5) * cell
            ns = south + (line[:, 0] + 0.5) * cell
            coords = to_lonlat(manifest, es - origin[0], origin[1] - ns)
            if coords is None:
                coords = [[round(float(e), 3), round(float(n), 3)] for e, n in zip(es, ns, strict=True)]
            if len(coords) >= 2:
                feats.append(
                    {
                        "type": "Feature",
                        "properties": {
                            "levelM": level,
                            "kind": "fill" if level > 0 else "cut" if level < 0 else "zero",
                        },
                        "geometry": {"type": "LineString", "coordinates": coords},
                    }
                )
    return feats


__all__ = [
    "ENGINE_VERSION",
    "TILE",
    "ProjectSurfaces",
    "Resolved",
    "SurveyCompare",
    "canonical",
    "compare_item",
    "fingerprint",
]
