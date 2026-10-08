"""survey.cleanup: cleanups, crops and DTM filters as a new derived surface (data-conventions 29).

Parameters as ``SurveyCleanupParams`` in ``@aio/schema`` (``jobs.ts``): a prepared ``surface`` with
``edits`` (ids in ``survey/cleanups.json``, ``aio.terrain-edits/1``, applied in the order given; a
disabled edit is skipped), or a ``dtmFilter`` ``{ layer, preset }`` on a point cloud layer; ``out``
names the derived surface (default ``<capture>-clean`` for edits, ``<capture>-dtm`` for a DTM, the
surface or layer id when it has no capture).

- **Edits** become a ``derived`` surface prepared by ``survey.prepare``'s own steps (source
  ``{ kind: 'derived', of, edits }``), which call ``apply_edits`` below:

  - ``crop``: cells less than half inside the ring become no data;
  - ``cleanup``: the cells at least half inside the ring are replaced by an interpolation from the
    ring's edge, sampled on the surface every cell: ``tin`` (the Delaunay triangulation of the edge
    samples, linear inside) or ``thin-plate`` (a thin-plate spline through the edge samples with a
    linear part, ``scipy.interpolate.RBFInterpolator``; a plane or a gentle curve is carried across
    the hole rather than flattened).

- **DTM filter presets** (``DTM_PRESETS``): PDAL ``filters.smrf`` or ``filters.csf`` parameter sets
  that keep the ground points (class 2) of a cloud, gridded as the mean height per cell with the
  holes left by removed objects filled linearly from the ground around them (inside the hull of the
  ground points). The preset and its parameters are recorded in ``tiles.json`` (``filter``).

The derived surface carries no ``capture``: comparisons use it only when a person picks it (its
``source.of`` names the surface it was made from). The delivered DSM, cloud and ortho, the original
prepared surface and the edits file are never changed, and nothing is deleted.
"""

from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Callable
from typing import Any

import numpy as np

from ..params import known_keys
from ..runtime import JobError, Step, StepContext, atomic_write_json, now_iso
from .grid import (
    ArraySurface,
    Window,
    bilinear,
    coverage,
    crosses_itself,
    densify,
    normal_ring,
    read_tiles_json,
)

SAFE_ID = __import__("re").compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
SURFACES_DIR = "survey/surfaces"
#: Most edge samples a thin-plate spline is solved for (evenly thinned beyond).
TPS_MAX_EDGE = 1500
#: Cells evaluated per thin-plate batch.
TPS_BATCH = 50_000
PRESETS = ("equipment", "equipment-vegetation", "structures", "everything")

#: PDAL ground filters per preset: small objects (parked plant), plant and vegetation, plus
#: buildings and other large structures (a wide window), and everything above the bare ground
#: (cloth simulation). Ground keeps class 2.
DTM_PRESETS: dict[str, dict[str, Any]] = {
    "equipment": {
        "type": "filters.smrf",
        "slope": 0.15,
        "window": 8.0,
        "threshold": 0.5,
        "scalar": 1.25,
        "cell": 1.0,
    },
    "equipment-vegetation": {
        "type": "filters.smrf",
        "slope": 0.15,
        "window": 12.0,
        "threshold": 0.3,
        "scalar": 1.2,
        "cell": 1.0,
    },
    "structures": {
        "type": "filters.smrf",
        "slope": 0.2,
        "window": 30.0,
        "threshold": 0.45,
        "scalar": 1.2,
        "cell": 1.0,
    },
    "everything": {
        "type": "filters.csf",
        "resolution": 1.0,
        "rigidness": 3,
        "threshold": 0.3,
        "hdiff": 0.3,
        "step": 0.65,
        "iterations": 500,
        "smooth": True,
    },
}

Check = Callable[[], None]


def _no_check() -> None:
    return None


# ------------------------------------------------------------------------------------- the edits


def _local_ring(edit: dict[str, Any], oe: float, on: float) -> list[tuple[float, float]]:
    ring = normal_ring([(float(p[0]) - oe, float(p[1]) - on) for p in edit.get("ring") or []])
    name = edit.get("label") or edit.get("id")
    if len(ring) < 3:
        raise JobError(f'The terrain edit "{name}" needs three or more points.')
    if crosses_itself(ring):
        raise JobError(f'The terrain edit "{name}" crosses itself.')
    return ring


def edge_samples(
    h: np.ndarray, cell: float, ring: list[tuple[float, float]]
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Heights every cell along the ring's edge (local frame), where the surface has data."""
    s = ArraySurface(0.0, 0.0, cell, h)
    xs, ys = densify(ring, cell)
    zs = bilinear(s, xs, ys, 0.0, 0.0)
    ok = np.isfinite(zs)
    return xs[ok], ys[ok], zs[ok]


def tin_fill(
    xs: np.ndarray, ys: np.ndarray, zs: np.ndarray, win: Window, check: Check = _no_check
) -> np.ndarray:
    """The Delaunay triangulation of the edge samples, rasterised on ``win`` (NaN outside it)."""
    from .tin import Tin, delaunay, rasterize

    return rasterize(Tin(xs, ys, zs, delaunay(xs, ys)), win, check)


def thin_plate_fill(
    xs: np.ndarray,
    ys: np.ndarray,
    zs: np.ndarray,
    cx: np.ndarray,
    cy: np.ndarray,
    check: Check = _no_check,
) -> np.ndarray:
    """A thin-plate spline (with its linear part) through the edge samples, at the points (cx, cy)."""
    from scipy.interpolate import RBFInterpolator

    if xs.size > TPS_MAX_EDGE:
        keep = np.unique(np.round(np.linspace(0, xs.size - 1, TPS_MAX_EDGE)).astype(np.int64))
        xs, ys, zs = xs[keep], ys[keep], zs[keep]
    # centred and scaled, so the solve is well conditioned at any site coordinates
    mx, my = float(xs.mean()), float(ys.mean())
    sc = max(float(np.ptp(xs)), float(np.ptp(ys)), 1e-9)
    z0 = float(zs.mean())
    rbf = RBFInterpolator(
        np.stack([(xs - mx) / sc, (ys - my) / sc], axis=1),
        zs - z0,
        kernel="thin_plate_spline",
        degree=1,
    )
    out = np.empty(cx.size)
    for k in range(0, cx.size, TPS_BATCH):
        check()
        part = np.stack([(cx[k : k + TPS_BATCH] - mx) / sc, (cy[k : k + TPS_BATCH] - my) / sc], axis=1)
        out[k : k + TPS_BATCH] = rbf(part) + z0
    return out


def apply_edit(
    h: np.ndarray, cell: float, edit: dict[str, Any], ring: list[tuple[float, float]], check: Check
) -> None:
    """One crop or cleanup on ``h`` (row 0 south, cell (i, j) at local ``((i + .5) cell, (j + .5) cell)``)."""
    ny, nx = h.shape
    win = Window(cell, 0, 0, nx, ny)
    inside = coverage(ring, win, check) >= 0.5
    if edit.get("kind") == "crop":
        h[~inside] = np.nan
        return
    if edit.get("kind") != "cleanup":
        raise JobError(f'"{edit.get("kind")}" is not a terrain edit (cleanup or crop).')
    if not inside.any():
        return
    xs, ys, zs = edge_samples(h, cell, ring)
    name = edit.get("label") or edit.get("id")
    if xs.size < 3:
        raise JobError(f'The edge of the terrain edit "{name}" has too little survey under it.')
    method = edit.get("method") or "tin"
    if method == "tin":
        filled = tin_fill(xs, ys, zs, win, check)
        use = inside & np.isfinite(filled)
        h[use] = filled[use]
    elif method == "thin-plate":
        jj, ii = np.nonzero(inside)
        h[jj, ii] = thin_plate_fill(xs, ys, zs, (ii + 0.5) * cell, (jj + 0.5) * cell, check)
    else:
        raise JobError(f'"{method}" is not a cleanup method (tin or thin-plate).')


def apply_edits(
    h: np.ndarray, oe: float, on: float, cell: float, edits: list[dict[str, Any]], ctx: Any = None
) -> np.ndarray:
    """``survey.prepare``'s derived surfaces: the enabled ``edits`` applied in order to a copy of
    ``h`` (row 0 south, lower-left corner (oe, on), cells of ``cell`` metres)."""
    check: Check = ctx.check if ctx is not None else _no_check
    out = np.array(h, dtype=np.float64, copy=True)
    for k, e in enumerate(edits):
        check()
        if e.get("enabled", True) is False:
            continue
        apply_edit(out, cell, e, _local_ring(e, oe, on), check)
        if ctx is not None:
            ctx.progress(0.4 * (k + 1) / len(edits), f"Edit {k + 1} of {len(edits)}")
    return out


# ------------------------------------------------------------------------------------ DTM filter


def dtm_pipeline(reader: dict[str, Any], preset: str, out_las: str) -> dict[str, Any]:
    """The PDAL pipeline of a preset: every point unclassified, the ground filter, class 2 kept."""
    if preset not in DTM_PRESETS:
        raise JobError(f"preset must be one of: {', '.join(PRESETS)}.")
    return {
        "pipeline": [
            reader,
            {"type": "filters.assign", "value": "Classification = 1"},
            dict(DTM_PRESETS[preset]),
            {"type": "filters.range", "limits": "Classification[2:2]"},
            {"type": "writers.las", "filename": out_las, "minor_version": 4},
        ]
    }


def grid_ground(e: np.ndarray, n: np.ndarray, z: np.ndarray, cell: float | None = None):
    """Ground points to a height grid: the mean per cell, holes inside the hull filled linearly."""
    from scipy.interpolate import griddata

    from .prepare import Heights, _aligned, _check_size

    if e.size < 3:
        raise JobError("The filter kept fewer than three ground points.")
    area = max(1e-6, float((e.max() - e.min()) * (n.max() - n.min())))
    c = float(cell or max(0.05, round(2 * math.sqrt(area / e.size), 3)))
    oe, on = _aligned(float(e.min()), c), _aligned(float(n.min()), c)
    nx = max(1, math.ceil((float(e.max()) - oe) / c + 1e-9))
    ny = max(1, math.ceil((float(n.max()) - on) / c + 1e-9))
    _check_size(nx, ny, c)
    ci = np.minimum(np.floor((e - oe) / c).astype(np.int64), nx - 1)
    rj = np.minimum(np.floor((n - on) / c).astype(np.int64), ny - 1)
    idx = rj * nx + ci
    tot = np.bincount(idx, weights=z, minlength=nx * ny)
    cnt = np.bincount(idx, minlength=nx * ny)
    with np.errstate(invalid="ignore", divide="ignore"):
        h = (tot / cnt).reshape(ny, nx)
    have = (cnt > 0).reshape(ny, nx)
    if (~have).any() and have.sum() >= 3:
        jj, ii = np.nonzero(have)
        mj, mi = np.nonzero(~have)
        h[mj, mi] = griddata(
            np.stack([ii + 0.5, jj + 0.5], axis=1),
            h[jj, ii],
            np.stack([mi + 0.5, mj + 0.5], axis=1),
            "linear",
        )
    return Heights(oe, on, c, h)


def _cloud_reader(ctx: StepContext, manifest: dict[str, Any], lid: str) -> dict[str, Any]:
    """A PDAL reader stage for a cloud layer: its COPC or LAS file, or its points as text."""
    from ..change.surface import Surface

    s = Surface(ctx.project, manifest, {"layer": lid, "kind": "cloud"})
    if s.layer.get("kind") != "pointcloud":
        raise JobError(f'The layer "{s.name}" is not a point cloud.')
    if s.layer.get("format") != "kit-packed":
        return {"filename": str(s.path)}
    pts = s.points(ctx)
    o = manifest.get("origin") or [0, 0, 0]
    txt = ctx.stage(f"work/{lid}.xyz")
    xyz = np.stack([pts[:, 0] + o[0], o[1] - pts[:, 2], pts[:, 1] + o[2]], axis=1)
    np.savetxt(txt, xyz, fmt="%.4f", delimiter=",", header="X,Y,Z", comments="")
    return {"type": "readers.text", "filename": str(txt)}


def run_dtm_filter(ctx: StepContext, layer: str, preset: str):
    from ..change.imagery import read_manifest
    from ..pointcloud import PDAL_MISSING, _run, find_pdal
    from ..volumetric.cloud import read_las_chunks

    pdal = find_pdal()
    if not pdal:
        raise JobError(f"The DTM filter presets run in PDAL. {PDAL_MISSING}")
    manifest = read_manifest(ctx.project)
    reader = _cloud_reader(ctx, manifest, layer)
    ground = ctx.stage("work/ground.las")
    pipe = ctx.stage("work/dtm.json")
    atomic_write_json(pipe, dtm_pipeline(reader, preset, str(ground)))
    ctx.progress(0.1, "Ground filter")
    _run(ctx, [pdal, "pipeline", str(pipe)], "filter the ground")
    parts = [np.stack([x, y, z], axis=1) for x, y, z, _ in read_las_chunks(ground, ctx.check)]
    pts = np.concatenate(parts) if parts else np.zeros((0, 3))
    ctx.progress(0.5, "Ground grid")
    return grid_ground(pts[:, 0], pts[:, 1], pts[:, 2])


# ------------------------------------------------------------------------------------- pipeline


class SurveyCleanup:
    name = "survey.cleanup"
    title = "Terrain cleanup"
    description = (
        "Cleanups, crops and DTM filters as a new derived surface; the delivered surface is never changed."
    )
    keys = frozenset({"surface", "edits", "dtmFilter", "out"})
    required: frozenset[str] = frozenset()

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        from ..stub import exactly_one

        known_keys(params, set(self.keys), self.name)
        exactly_one(
            params.get("surface") is not None and params.get("edits") is not None,
            params.get("dtmFilter") is not None,
            "Give a surface with edits, or a DTM filter.",
        )
        for k in ("surface", "out"):
            v = params.get(k)
            if v is not None and (not isinstance(v, str) or not SAFE_ID.match(v)):
                raise JobError(f"{k} must be letters, digits, dot, dash or _.")
        edits = params.get("edits")
        if edits is not None and (
            not isinstance(edits, list)
            or len(edits) > 2000
            or not all(isinstance(e, str) and SAFE_ID.match(e) for e in edits)
        ):
            raise JobError("edits must be a list of up to 2000 edit ids.")
        f = params.get("dtmFilter")
        if f is not None:
            if not isinstance(f, dict) or set(f) != {"layer", "preset"} or not isinstance(f["layer"], str):
                raise JobError("dtmFilter must be { layer, preset }.")
            if f["preset"] not in PRESETS:
                raise JobError(f"preset must be one of: {', '.join(PRESETS)}.")
        if params.get("out") is not None and params.get("out") == params.get("surface"):
            raise JobError("out must name a new surface, not the one the edits apply to.")
        return dict(params)

    def inputs(self, params: dict[str, Any]) -> list[str]:
        return ["survey/surfaces", "survey/cleanups.json"]

    def plan(self, params: dict[str, Any]) -> list[Step]:
        if params.get("dtmFilter") is not None:
            return self._dtm_plan(params)
        return self._edits_plan(params)

    def _edits_plan(self, params: dict[str, Any]) -> list[Step]:
        from .prepare import SurveyPrepare

        holder: dict[str, list[Step]] = {}

        def spec_of(ctx: StepContext) -> dict[str, Any]:
            sid = params["surface"]
            folder = ctx.project / SURFACES_DIR / sid
            if not (folder / "tiles.json").is_file():
                raise JobError(f'The surface "{sid}" is not prepared; run Prepare surfaces first.')
            meta = read_tiles_json(folder)
            out = params.get("out") or f"{meta.get('capture') or sid}-clean"
            if out == sid:
                raise JobError("The cleaned surface needs another id than the surface it is made from.")
            return {
                "id": out,
                "name": f"{meta.get('name') or sid} (cleaned)"[:200],
                "source": {"kind": "derived", "of": sid, "edits": list(params["edits"])},
            }

        def prepared(ctx: StepContext) -> list[Step]:
            if "steps" not in holder:
                spec = spec_of(ctx)
                holder["spec"] = [spec]  # type: ignore[list-item]
                holder["steps"] = SurveyPrepare().plan({"surfaces": [spec], "geodesy": False})
            return holder["steps"]

        def surface(ctx: StepContext) -> dict[str, Any]:
            out = prepared(ctx)[0].run(ctx)
            return {**out, "surface": params["surface"]}

        def commit(ctx: StepContext) -> dict[str, Any]:
            return prepared(ctx)[-1].run(ctx)

        return [
            Step("surface-1", "Clean the surface", surface, 3.0),
            Step("commit", "Save the cleaned surface", commit, 1.0),
        ]

    def _dtm_plan(self, params: dict[str, Any]) -> list[Step]:
        from .prepare import SurveyPrepare, write_tiles

        f = params["dtmFilter"]

        def spec_of(ctx: StepContext) -> dict[str, Any]:
            from ..change.imagery import find_layer, read_manifest

            layer = find_layer(read_manifest(ctx.project), f["layer"])
            out = params.get("out") or f"{layer.get('capture') or f['layer']}-dtm"
            name = f"{layer.get('name') or f['layer']} (DTM, {f['preset'].replace('-', ' and ')})"
            return {"id": out, "name": name[:200], "source": {"kind": "dtm", "layer": f["layer"]}}

        def surface(ctx: StepContext) -> dict[str, Any]:
            from ..change.imagery import read_manifest
            from .prepare import _crs_of

            g = run_dtm_filter(ctx, f["layer"], f["preset"])
            spec = spec_of(ctx)
            fields = write_tiles(ctx, g, f"surfaces/{spec['id']}")
            fp = (
                "sha256:"
                + hashlib.sha256(
                    json.dumps({"dtm": f, "preset": DTM_PRESETS[f["preset"]]}, sort_keys=True).encode()
                ).hexdigest()
            )
            meta = {
                "schema": "aio.height-tiles/1",
                "id": spec["id"],
                "name": spec["name"],
                "source": spec["source"],
                "crs": _crs_of(read_manifest(ctx.project)),
                "cellM": g.cell,
                "tileSize": 256,
                "originE": g.oe,
                "originN": g.on,
                **fields,
                "filter": {"preset": f["preset"], "pdal": DTM_PRESETS[f["preset"]]},
                "fingerprint": fp,
                "preparedAt": now_iso(),
            }
            atomic_write_json(ctx.stage(f"surfaces/{spec['id']}/tiles.json"), meta)
            return {"id": spec["id"], "skipped": False, "tiles": len(fields["tiles"]), "cellM": g.cell}

        def commit(ctx: StepContext) -> dict[str, Any]:
            spec = {"id": ctx.outputs("surface-1")["id"]}
            return SurveyPrepare()._commit({"surfaces": [spec]})(ctx)

        return [
            Step("surface-1", "Filter the ground", surface, 3.0),
            Step("commit", "Save the DTM", commit, 1.0),
        ]
