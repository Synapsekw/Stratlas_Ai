"""survey.overlay: contours, slope, elevation ramp or shaded relief of a surface or a difference.

M11 G5 (SRV-8, data-conventions section 29). Parameters as ``SurveyOverlayParams`` in
``packages/schema/src/jobs.ts``: ``id?``, a prepared ``surface`` or a ``comparison``
(``{ from, to }`` surfaces: the overlay is of ``to - from``), not both, ``kind`` and ``options?``:

- ``contours``: ``minorM`` (default 0.5) and ``majorM`` (2.5, a whole multiple of the minor);
  ``contours.geojson`` (``LineString`` features with Z, ``levelM``, ``major``, ``closed``; a
  top-level ``crs`` and a ``labels`` index, see ``contours.py``).
- ``slope``: ``style`` (``percent``, ``degrees`` or ``ratio``: how the legend reads) and ``stops``
  (values in percent; default 0, 57.74, 100 and 173.21, that is 0, 30, 45 and 60 degrees).
- ``elevation``: ``stops`` (heights, default five across the data), ``stepped`` (each band one
  colour), ``range`` (``[low, high]``: cells outside are not drawn).
- ``relief``: ``azimuth`` (sun bearing, default 315), ``altitude`` (45) and ``intensity`` (0 to 1,
  default 1): the shade drawn as darkness over whatever is below.

Rasters are ``kit-pyramid`` tiles (``aio.tiles/1`` with a ``legend``, written by the change
pipelines' ``write_pyramid``) in ``survey/overlays/<id>/`` (``tiles.json``). Every overlay is listed
in ``survey/overlays.json`` (``aio.survey-overlays/1``, written atomically with a ``.bak``), never
in the manifest.

**The grid.** A surface overlay reads the prepared tiles at the finest pyramid level that keeps
the grid under ``MAX_CELLS``. A comparison is computed on the grid of its finer grid side over the
overlap of both sides (TINs rasterised at the cell centres, the other grid sampled bilinearly, the
comparison engine's ``sample_cells`` and ``rasterize``).
"""

from __future__ import annotations

import hashlib
import itertools
import json
import math
import re
import shutil
from pathlib import Path
from typing import Any

import numpy as np

from ..params import known_keys
from ..runtime import JobError, Step, StepContext, atomic_write_bytes, atomic_write_json, commit_tree, now_iso
from ..stub import exactly_one
from .compare import ProjectSurfaces, Resolved, canonical
from .contours import check_intervals, contour_lines, label_index
from .grid import TILE, GridSurface, TileSurface, Window, sample_cells
from .tin import rasterize

KINDS = frozenset({"contours", "slope", "elevation", "relief"})
SURFACE_KINDS = frozenset({"survey", "current", "previous", "design"})
OVERLAYS_FILE = "survey/overlays.json"
OVERLAYS_DIR = "survey/overlays"
SCHEMA = "aio.survey-overlays/1"
MAX_OVERLAYS = 500
#: The largest overlay grid (cells); finer surfaces are read from a coarser pyramid level.
MAX_CELLS = 2500 * 2500
#: The step when both sides of a comparison are TINs: the overlap's width over this.
TIN_GRID_CELLS = 1000

SLOPE_STOPS = [
    {"value": 0.0, "color": "#1a9850"},
    {"value": 57.74, "color": "#fee08b"},
    {"value": 100.0, "color": "#f46d43"},
    {"value": 173.21, "color": "#a50026"},
]
ELEVATION_COLOURS = ["#2c7bb6", "#abd9e9", "#ffffbf", "#fdae61", "#d7191c"]
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")


# ------------------------------------------------------------------------------------- options


def _num(v: Any, name: str, lo: float | None = None, hi: float | None = None) -> float:
    if not isinstance(v, int | float) or isinstance(v, bool) or not math.isfinite(v):
        raise JobError(f"{name} must be a number.")
    if (lo is not None and v < lo) or (hi is not None and v > hi):
        raise JobError(f"{name} must be between {lo:g} and {hi:g}.")
    return float(v)


def _stops(v: Any, name: str) -> list[dict[str, Any]]:
    if (
        not isinstance(v, list)
        or not 2 <= len(v) <= 16
        or not all(isinstance(s, dict) and _HEX.match(str(s.get("color", ""))) for s in v)
    ):
        raise JobError(f"{name} must be 2 to 16 stops of {{ value, color: '#rrggbb' }}.")
    out = [{"value": _num(s.get("value"), f"{name} value"), "color": str(s["color"])} for s in v]
    if any(b["value"] <= a["value"] for a, b in itertools.pairwise(out)):
        raise JobError(f"{name} must be in ascending order of value.")
    return out


def resolve_options(kind: str, opts: dict[str, Any] | None) -> dict[str, Any]:
    """The options with their defaults, checked (elevation stops default from the data later)."""
    o = dict(opts or {})
    if kind == "contours":
        known_keys(o, {"minorM", "majorM", "color", "majorColor", "width"}, "contour options")
        minor = _num(o.get("minorM", 0.5), "minorM")
        major = _num(o.get("majorM", 2.5), "majorM")
        check_intervals(minor, major)
        return {**o, "minorM": minor, "majorM": major}
    if kind == "slope":
        known_keys(o, {"style", "stops"}, "slope options")
        style = o.get("style", "percent")
        if style not in ("percent", "degrees", "ratio"):
            raise JobError("style must be one of: degrees, percent, ratio.")
        return {"style": style, "stops": _stops(o.get("stops", SLOPE_STOPS), "stops")}
    if kind == "elevation":
        known_keys(o, {"stops", "stepped", "range"}, "elevation options")
        out: dict[str, Any] = {"stepped": bool(o.get("stepped", False))}
        if o.get("stops") is not None:
            out["stops"] = _stops(o["stops"], "stops")
        rng = o.get("range")
        if rng is not None:
            if not isinstance(rng, list) or len(rng) != 2:
                raise JobError("range must be [low, high].")
            lo, hi = _num(rng[0], "range low"), _num(rng[1], "range high")
            if hi <= lo:
                raise JobError("range must be [low, high] with low below high.")
            out["range"] = [lo, hi]
        return out
    known_keys(o, {"azimuth", "altitude", "intensity"}, "relief options")
    return {
        "azimuth": _num(o.get("azimuth", 315), "azimuth", 0, 360),
        "altitude": _num(o.get("altitude", 45), "altitude", 0, 90),
        "intensity": _num(o.get("intensity", 1), "intensity", 0, 1),
    }


# ------------------------------------------------------------------------------- reading grids


class LevelSurface(TileSurface):
    """A prepared surface read at a pyramid level (cells of ``cellM * 2**level``)."""

    def __init__(self, folder: Path, meta: dict[str, Any], level: int):
        super().__init__(folder, meta)
        self.level = level
        f = 2**level
        self.cell = self.cell * f
        self.nx = math.ceil(self.cols * TILE / f)
        self.ny = math.ceil(self.rows * TILE / f)

    def read(self, i0: int, j0: int, w: int, h: int) -> np.ndarray:
        if self.level == 0:
            return super().read(i0, j0, w, h)
        out = np.full((h, w), np.nan)
        if w <= 0 or h <= 0:
            return out
        c0, c1 = max(i0, 0) // TILE, (max(i0 + w, 1) - 1) // TILE
        r0, r1 = max(j0, 0) // TILE, (max(j0 + h, 1) - 1) // TILE
        for r in range(r0, r1 + 1):
            for c in range(c0, c1 + 1):
                t = self.tile(c, r, self.level)
                if t is None:
                    continue
                a0, a1 = max(i0, c * TILE), min(i0 + w, (c + 1) * TILE)
                b0, b1 = max(j0, r * TILE), min(j0 + h, (r + 1) * TILE)
                if a0 >= a1 or b0 >= b1:
                    continue
                out[b0 - j0 : b1 - j0, a0 - i0 : a1 - i0] = t[
                    b0 - r * TILE : b1 - r * TILE, a0 - c * TILE : a1 - c * TILE
                ]
        return out


def _extent(r: Resolved) -> tuple[float, float, float, float]:
    if r.kind == "grid":
        assert r.grid is not None
        return r.extent or r.grid.bounds
    v = r.vertices
    assert v is not None
    return (float(v[:, 0].min()), float(v[:, 1].min()), float(v[:, 0].max()), float(v[:, 1].max()))


def _level_for(cell: float, box: tuple[float, float, float, float], levels: int) -> int:
    w, h = box[2] - box[0], box[3] - box[1]
    for lv in range(levels):
        c = cell * 2**lv
        if math.ceil(w / c) * math.ceil(h / c) <= MAX_CELLS:
            return lv
    return max(0, levels - 1)


class OverlayGrid:
    """Heights (or a difference) on a grid: ``z`` rows going north, the grid's lower-left corner."""

    def __init__(self, z: np.ndarray, origin_e: float, origin_n: float, cell: float):
        self.z = z
        self.origin_e = origin_e
        self.origin_n = origin_n
        self.cell = cell


def _side(
    r: Resolved, ps: ProjectSurfaces, le: float, ln: float, win: Window, ref: dict[str, Any]
) -> np.ndarray:
    if r.kind == "tin":
        return rasterize(r.tin(le, ln), win)
    g = r.grid
    assert g is not None
    surf: GridSurface = g
    if isinstance(g, TileSurface):
        # the pyramid level whose cell is at most the grid's
        levels = int(g.meta.get("levels") or 1)
        lv = 0
        while lv + 1 < levels and g.cell * 2 ** (lv + 1) <= win.cell + 1e-9:
            lv += 1
        if lv:
            surf = LevelSurface(g.folder, g.meta, lv)
    return sample_cells(
        surf, le - surf.origin_e, ln - surf.origin_n, win.cell, win.i0, win.j0, win.nx, win.ny
    )


def surface_grid(ps: ProjectSurfaces, sid: str) -> OverlayGrid:
    r = ps.grid(sid)
    g = r.grid
    assert isinstance(g, TileSurface)
    box = _extent(r)
    lv = _level_for(g.cell, box, int(g.meta.get("levels") or 1))
    s: TileSurface = LevelSurface(g.folder, g.meta, lv) if lv else g
    i0 = math.floor((box[0] - s.origin_e) / s.cell + 1e-9)
    j0 = math.floor((box[1] - s.origin_n) / s.cell + 1e-9)
    i1 = math.ceil((box[2] - s.origin_e) / s.cell - 1e-9)
    j1 = math.ceil((box[3] - s.origin_n) / s.cell - 1e-9)
    z = s.read(i0, j0, max(1, i1 - i0), max(1, j1 - j0))
    return OverlayGrid(z, s.origin_e + i0 * s.cell, s.origin_n + j0 * s.cell, s.cell)


def difference_grid(ps: ProjectSurfaces, frm: dict[str, Any], to: dict[str, Any]) -> OverlayGrid:
    rf, rt = ps.resolve(frm), ps.resolve(to)
    bf, bt = _extent(rf), _extent(rt)
    box = (max(bf[0], bt[0]), max(bf[1], bt[1]), min(bf[2], bt[2]), min(bf[3], bt[3]))
    if box[0] >= box[2] or box[1] >= box[3]:
        raise JobError("The two surfaces do not overlap.")
    grids = [r for r in (rt, rf) if r.kind == "grid" and r.grid is not None]
    if grids:
        base = min(grids, key=lambda r: r.grid.cell if r.grid else math.inf)
        g = base.grid
        assert g is not None
        levels = int(g.meta.get("levels") or 1) if isinstance(g, TileSurface) else 1
        cell = g.cell * 2 ** _level_for(g.cell, box, max(levels, 20))
        le, ln = g.origin_e, g.origin_n
    else:
        cell = max(0.1, max(box[2] - box[0], box[3] - box[1]) / TIN_GRID_CELLS)
        le, ln = box[0], box[1]
    i0 = math.floor((box[0] - le) / cell + 1e-9)
    j0 = math.floor((box[1] - ln) / cell + 1e-9)
    nx = max(1, math.ceil((box[2] - le) / cell - 1e-9) - i0)
    ny = max(1, math.ceil((box[3] - ln) / cell - 1e-9) - j0)
    win = Window(cell, i0, j0, nx, ny)
    zt = _side(rt, ps, le, ln, win, to)
    zf = _side(rf, ps, le, ln, win, frm)
    with np.errstate(invalid="ignore"):
        dz = zt - zf
    return OverlayGrid(dz, le + i0 * cell, ln + j0 * cell, cell)


# ---------------------------------------------------------------------------------- the rasters


def slope_ratio(z: np.ndarray, cell: float) -> np.ndarray:
    """Rise over run of the steepest direction at each cell (central differences; NaN at gaps)."""
    if min(z.shape) < 2:
        return np.full(z.shape, np.nan)
    dn, de = np.gradient(z, cell)
    return np.hypot(de, dn)


def hillshade(z: np.ndarray, cell: float, azimuth: float, altitude: float) -> np.ndarray:
    """Lambert shade (0 to 1) of the surface under a sun at ``azimuth`` (clockwise from north) and
    ``altitude`` degrees; ``z`` rows going north."""
    if min(z.shape) < 2:
        return np.full(z.shape, np.nan)
    dn, de = np.gradient(z, cell)
    norm = np.sqrt(de * de + dn * dn + 1)
    a, h = math.radians(azimuth), math.radians(altitude)
    s = (math.sin(a) * math.cos(h), math.cos(a) * math.cos(h), math.sin(h))
    return np.clip((-de * s[0] - dn * s[1] + s[2]) / norm, 0, 1)


def _rgb(color: str) -> list[int]:
    return [int(color[i : i + 2], 16) for i in (1, 3, 5)]


def ramp(
    values: np.ndarray, stops: list[dict[str, Any]], stepped: bool = False, alpha: float = 0.85
) -> np.ndarray:
    """RGBA of ``values`` through colour stops (linear, or stepped: each band its lower stop)."""
    vs = np.array([s["value"] for s in stops], float)
    cols = np.array([_rgb(s["color"]) for s in stops], float)
    out = np.zeros((*values.shape, 4), np.uint8)
    ok = np.isfinite(values)
    v = np.where(ok, values, vs[0])
    if stepped:
        k = np.clip(np.searchsorted(vs, v, side="right") - 1, 0, len(vs) - 1)
        for c in range(3):
            out[..., c] = cols[k, c].astype(np.uint8)
    else:
        for c in range(3):
            out[..., c] = np.round(np.interp(v, vs, cols[:, c])).astype(np.uint8)
    out[..., 3] = round(alpha * 255)
    out[~ok] = 0
    return out


def elevation_stops(z: np.ndarray, given: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    if given:
        return given
    ok = np.isfinite(z)
    lo, hi = (float(z[ok].min()), float(z[ok].max())) if ok.any() else (0.0, 1.0)
    if hi <= lo:
        hi = lo + 1.0
    n = len(ELEVATION_COLOURS)
    return [
        {"value": round(lo + (hi - lo) * k / (n - 1), 3), "color": c} for k, c in enumerate(ELEVATION_COLOURS)
    ]


def raster_of(
    kind: str, g: OverlayGrid, opts: dict[str, Any]
) -> tuple[np.ndarray, dict[str, Any], dict[str, Any]]:
    """(RGBA rows going north, legend, stats) of a raster overlay."""
    z = g.z
    if kind == "slope":
        pct = slope_ratio(z, g.cell) * 100
        ok = np.isfinite(pct)
        stats = {"minPercent": float(pct[ok].min()), "maxPercent": float(pct[ok].max())} if ok.any() else {}
        legend = {"kind": "slope", "unit": "%", "label": "Slope", "style": opts["style"]}
        legend["stops"] = [[s["value"], s["color"]] for s in opts["stops"]]
        return ramp(pct, opts["stops"]), legend, stats
    if kind == "elevation":
        stops = elevation_stops(z, opts.get("stops"))
        opts["stops"] = stops
        shown = z
        if opts.get("range"):
            lo, hi = opts["range"]
            with np.errstate(invalid="ignore"):
                shown = np.where((z >= lo) & (z <= hi), z, np.nan)
        ok = np.isfinite(z)
        stats = {"minM": float(z[ok].min()), "maxM": float(z[ok].max())} if ok.any() else {}
        legend = {
            "kind": "metres",
            "unit": "m",
            "label": "Elevation",
            "stepped": opts["stepped"],
            "stops": [[s["value"], s["color"]] for s in stops],
        }
        return ramp(shown, stops, opts["stepped"]), legend, stats
    shade = hillshade(z, g.cell, opts["azimuth"], opts["altitude"])
    rgba = np.zeros((*z.shape, 4), np.uint8)
    ok = np.isfinite(shade)
    rgba[..., 3] = np.where(ok, np.round(255 * opts["intensity"] * (1 - np.nan_to_num(shade))), 0).astype(
        np.uint8
    )
    legend = {
        "kind": "relief",
        "label": "Shaded relief",
        **{k: opts[k] for k in ("azimuth", "altitude", "intensity")},
    }
    return rgba, legend, {}


# ------------------------------------------------------------------------------------ registry


def read_overlays(project: Path) -> dict[str, Any]:
    p = project / OVERLAYS_FILE
    if not p.is_file():
        return {"schema": SCHEMA, "overlays": []}
    try:
        doc = json.loads(p.read_text("utf-8"))
    except (OSError, ValueError) as e:
        raise JobError(f"The overlays list could not be read: {e}") from e
    if not isinstance(doc, dict) or doc.get("schema") != SCHEMA or not isinstance(doc.get("overlays"), list):
        raise JobError(f"{OVERLAYS_FILE} is not an {SCHEMA} file.")
    return doc


def write_overlays(project: Path, doc: dict[str, Any]) -> None:
    p = project / OVERLAYS_FILE
    if p.is_file():
        atomic_write_bytes(p.with_name(p.name + ".bak"), p.read_bytes())
    atomic_write_json(p, doc)


def upsert_overlay(project: Path, entry: dict[str, Any]) -> None:
    doc = read_overlays(project)
    rest = [o for o in doc["overlays"] if not (isinstance(o, dict) and o.get("id") == entry["id"])]
    if len(rest) >= MAX_OVERLAYS:
        raise JobError(f"A project holds at most {MAX_OVERLAYS} overlays; remove some first.")
    doc["overlays"] = [*rest, entry]
    write_overlays(project, doc)


# -------------------------------------------------------------------------------------- pipeline

_WORDS = {"contours": "Contours", "slope": "Slope", "elevation": "Elevation", "relief": "Shaded relief"}


def _slug(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "-", s).strip("-._")[:60] or "x"


def _ref_word(ref: dict[str, Any]) -> str:
    k = ref.get("kind")
    if k == "survey":
        return str(ref.get("surface"))
    if k == "design":
        return f"{ref.get('design')}-{ref.get('layer')}"
    return str(k)


def default_id(params: dict[str, Any]) -> str:
    if params.get("surface") is not None:
        src = str(params["surface"])
    else:
        c = params["comparison"]
        src = f"{_ref_word(c['from'])}-to-{_ref_word(c['to'])}"
    return _slug(f"{params['kind']}-{src}")[:80]


def _check_ref(ref: Any, where: str) -> None:
    if not isinstance(ref, dict) or ref.get("kind") not in SURFACE_KINDS:
        raise JobError(f"{where} must be a survey, current, previous or design surface.")


class SurveyOverlay:
    name = "survey.overlay"
    title = "Terrain overlay"
    description = "Contours, slope, elevation ramp or shaded relief of a surface or a difference."
    keys = frozenset({"id", "surface", "comparison", "kind", "options"})
    required = frozenset({"kind"})

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        known_keys(params, set(self.keys), self.name)
        if params.get("kind") is None:
            raise JobError(f"{self.name} needs: kind.")
        if params["kind"] not in KINDS:
            raise JobError(f"kind must be one of: {', '.join(sorted(KINDS))}.")
        exactly_one(
            params.get("surface") is not None,
            params.get("comparison") is not None,
            "Give a surface or a comparison, not both.",
        )
        if params.get("surface") is not None and not _ID.match(str(params["surface"])):
            raise JobError("surface must be a prepared surface id.")
        comp = params.get("comparison")
        if comp is not None:
            if not isinstance(comp, dict):
                raise JobError("comparison must be { from, to }.")
            _check_ref(comp.get("from"), "comparison.from")
            _check_ref(comp.get("to"), "comparison.to")
        if params.get("id") is not None and not _ID.match(str(params["id"])):
            raise JobError("id must be letters, digits, dot, dash or _ (at most 80).")
        opts = params.get("options")
        if opts is not None and not isinstance(opts, dict):
            raise JobError("options must be an object.")
        resolve_options(params["kind"], opts)
        return dict(params)

    def inputs(self, params: dict[str, Any]) -> list[str]:
        return ["survey/surfaces", "survey/designs.json", "survey/designs"]

    def plan(self, params: dict[str, Any]) -> list[Step]:
        kind = params["kind"]
        oid = params.get("id") or default_id(params)
        rel = f"{OVERLAYS_DIR}/{oid}"

        def make(ctx: StepContext) -> dict[str, Any]:
            from ..change.imagery import Grid, read_manifest, write_pyramid

            opts = resolve_options(kind, params.get("options"))
            ps = ProjectSurfaces(ctx.project)
            fps: list[Any] = []
            if params.get("surface") is not None:
                sid = str(params["surface"])
                r = ps.grid(sid)
                source: dict[str, Any] = {"surface": sid}
                what = r.name
                fps.append(r.fingerprint)
                g = surface_grid(ps, sid)
            else:
                comp = params["comparison"]
                source = {"comparison": {"from": comp["from"], "to": comp["to"]}}
                rf, rt = ps.resolve(comp["from"]), ps.resolve(comp["to"])
                what = f"{rt.name} minus {rf.name}"
                fps += [rf.fingerprint, rt.fingerprint, rf.offset, rt.offset]
                g = difference_grid(ps, comp["from"], comp["to"])
            ctx.check()
            ctx.progress(0.4, _WORDS[kind])
            files: list[str] = []
            extra: dict[str, Any] = {}
            manifest = read_manifest(ctx.project)
            if kind == "contours":
                feats = contour_lines(
                    g.z, g.origin_e, g.origin_n, g.cell, opts["minorM"], opts["majorM"], ctx.check
                )
                doc = {
                    "type": "FeatureCollection",
                    "crs": manifest.get("crs"),
                    "features": feats,
                    "labels": label_index(feats),
                }
                atomic_write_json(ctx.stage("out/contours.geojson"), doc, indent=None)
                files.append("contours.geojson")
                extra = {"lines": len(feats), "levels": len({f["properties"]["levelM"] for f in feats})}
                name = f"Contours {opts['minorM']:g} m and {opts['majorM']:g} m, {what}"
            else:
                rgba_south, legend, stats = raster_of(kind, g, opts)
                o = manifest.get("origin") or [0, 0, 0]
                rows, cols = g.z.shape
                north = g.origin_n + rows * g.cell
                grid = Grid(g.origin_e - o[0], o[1] - north, g.cell, cols, rows)
                ok = np.isfinite(g.z)
                y = round(float(np.nanmax(g.z)) - o[2], 3) if ok.any() and kind != "slope" else 0.0
                tiles = write_pyramid(
                    rgba_south[::-1].copy(), grid, ctx.stage("out"), rel, y, legend, ctx.check
                )
                atomic_write_json(ctx.stage("out/tiles.json"), tiles)
                files.append("tiles.json")
                extra = {"legend": legend, "stats": stats}
                style = f" ({opts['style']})" if kind == "slope" else ""
                name = f"{_WORDS[kind]}{style}, {what}"
            fp = (
                "sha256:"
                + hashlib.sha256(
                    canonical({"kind": kind, "source": source, "options": opts, "surfaces": fps}).encode()
                ).hexdigest()
            )
            entry = {
                "id": oid,
                "name": name[:200],
                "kind": kind,
                "source": source,
                "options": opts,
                "dir": rel,
                "visible": True,
                "fingerprint": fp,
                "createdAt": now_iso(),
                "files": [f"{rel}/{f}" for f in files],
                "cellM": g.cell,
                **extra,
            }
            atomic_write_json(ctx.stage("entry.json"), entry)
            return {"id": oid, "files": files}

        def commit(ctx: StepContext) -> dict[str, Any]:
            entry = json.loads(ctx.stage("entry.json").read_text("utf-8"))
            old = ctx.out(rel)
            marker = ctx.job.dir / "steps" / ".committing"
            if old.exists() and not marker.exists():
                shutil.rmtree(old)
            marker.parent.mkdir(parents=True, exist_ok=True)
            marker.write_text("", "utf-8")
            n = commit_tree(ctx, "out", rel)
            upsert_overlay(ctx.project, entry)
            marker.unlink(missing_ok=True)
            ctx.artifact(OVERLAYS_FILE)
            return {"id": oid, "dir": rel, "files": n}

        return [
            Step("overlay", f"Make the {_WORDS[kind].lower()} overlay", make, 4.0),
            Step("commit", "Save the overlay", commit),
        ]


__all__ = [
    "OVERLAYS_FILE",
    "SLOPE_STOPS",
    "SurveyOverlay",
    "difference_grid",
    "hillshade",
    "ramp",
    "raster_of",
    "read_overlays",
    "resolve_options",
    "slope_ratio",
    "surface_grid",
    "upsert_overlay",
]
