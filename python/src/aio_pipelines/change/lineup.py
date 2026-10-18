"""change.lineup: how far one survey date sits from another, and the correction it still needs.

Parameters as ``ChangeLineUpParams`` in ``@aio/schema`` (``jobs.ts``): ``keep`` (the date that
stays), ``move`` (the date that moves) and optionally the layers to measure, by default each
date's ortho, else its DSM. Steps:

1. read    both dates where they are lined up now (their stored shifts applied, as change.raster
           and change.surface read them) onto a common grid over the area both cover, as
           ``change.raster`` builds it: an ortho's brightness, or a DSM's slope;
2. measure the correction coarse to fine (``register.measure_line_up``): a shift, a small turn
           and a scale fitted to the tiles, and its verdict. Written to ``jobs/<id>/lineup.json``
           as a ``LineUpMeasure`` (``packages/schema/src/change.ts``), as before, and the turn
           beside it in ``jobs/<id>/lineup-fit.json`` as a ``LineUpFit``.

The correction is a ``Similarity`` in the project CRS about the centroid of the tiles used (the
pivot). ``eastM`` and ``northM`` are how far it moves the pivot, the correction ``move`` still
needs there, so the app adds them to its current line-up. Only ``ok`` can be saved: ``aligned``
(no point of the overlap moves beyond the change check's tolerance), ``texture`` (too few textured
tiles), ``disagree`` (the tiles do not fit one similarity), ``range`` (a turn or scale beyond the
bounds; ``lineup.json`` says ``disagree``, which older apps know) and ``overlap`` (the dates hardly
share ground) are answers too, not failures. The job never writes the manifest.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any

import numpy as np

from ..captures import layer_captures
from ..params import known_keys, text
from ..runtime import JobError, Step, StepContext, atomic_write_json, commit_files
from ..similarity import Similarity
from .imagery import (
    Grid,
    Ortho,
    capture_label,
    cell_for,
    check_captures,
    find_layer,
    intersect,
    load_arrays,
    read_manifest,
    save_arrays,
    union,
)
from .raster import DEFAULT_MAX_SHIFT_PX, LUMA, ortho_fingerprint
from .register import (
    MAX_MOVE_M,
    MAX_ROTATION_DEG,
    MAX_SCALE_DEV,
    MAX_SPREAD_PX,
    MIN_OVERLAP,
    MIN_TILES,
    measure_line_up,
    slope,
)
from .surface import Surface, surface_fingerprint

PRODUCER = "change.lineup"
RESULT = "lineup.json"
FIT = "lineup-fit.json"
INPUTS_CHANGED = "The layers changed since this job started. Start the job again."


def _kind(layer: dict[str, Any]) -> str | None:
    if layer.get("kind") != "raster":
        return None
    derived = layer.get("derived")
    if isinstance(derived, dict) and derived.get("kind") == "change":
        return None
    role = layer.get("role")
    return "ortho" if role == "ortho" else "dsm" if role == "dsm" else None


def _of_date(manifest: dict[str, Any], cid: str, kind: str) -> dict[str, Any] | None:
    """The date's first layer of ``kind`` (``ortho`` or ``dsm``)."""
    of = layer_captures(manifest)
    for layer in manifest.get("layers") or []:
        if isinstance(layer, dict) and of.get(str(layer.get("id"))) == cid and _kind(layer) == kind:
            return layer
    return None


def pick_layers(
    manifest: dict[str, Any], params: dict[str, Any]
) -> tuple[str, dict[str, Any], dict[str, Any]]:
    """The source (``ortho`` or ``dsm``) and the keep and move layers: the given ones, else each
    date's ortho when both have one, else each date's DSM. Both are of one kind."""
    given = {k: find_layer(manifest, params[k]) for k in ("layerKeep", "layerMove") if params.get(k)}
    for layer in given.values():
        if _kind(layer) is None:
            raise JobError(f'The layer "{layer.get("name") or layer.get("id")}" is not an ortho or a DSM.')
    kinds = sorted({k for x in given.values() if (k := _kind(x))})
    if len(kinds) > 1:
        raise JobError("Line up an ortho with an ortho, or a DSM with a DSM.")
    for kind in kinds or ["ortho", "dsm"]:
        keep = given.get("layerKeep") or _of_date(manifest, params["keep"], kind)
        move = given.get("layerMove") or _of_date(manifest, params["move"], kind)
        if keep is not None and move is not None:
            return kind, keep, move
    for key in ("keep", "move"):
        if not (_of_date(manifest, params[key], "ortho") or _of_date(manifest, params[key], "dsm")):
            raise JobError(f"{capture_label(manifest, params[key])} has no ortho or DSM to line up with.")
    raise JobError("The two dates have no ortho or DSM of the same kind to line up.")


class _Date:
    """One date's layer read for measuring: brightness of an ortho, heights of a DSM."""

    def __init__(self, project: Path, manifest: dict[str, Any], kind: str, layer: dict[str, Any]):
        self.kind = kind
        if kind == "ortho":
            self.ortho = Ortho(project, manifest, layer)
            self.box = self.ortho.box
            self.gsd = self.ortho.gsd
        else:
            self.surface = Surface(project, manifest, {"layer": layer["id"], "kind": "dsm"})
            self.box = self.surface.box
            self.gsd = float(self.surface.res)

    def read(self, grid: Grid, ctx: StepContext, progress=lambda f: None) -> tuple[np.ndarray, np.ndarray]:
        """Values on ``grid`` (brightness, or local heights) and where they are valid."""
        if self.kind == "ortho":
            rgb, valid = self.ortho.sample(grid, ctx.check, progress)
            return rgb @ LUMA, valid
        h = self.surface.heights(grid, ctx)
        return h, np.isfinite(h)


def fingerprint(project: Path, kind: str, pair: tuple[_Date, _Date]) -> dict[str, Any]:
    if kind == "ortho":
        return ortho_fingerprint(project, [d.ortho for d in pair])
    return surface_fingerprint(project, [d.surface for d in pair])


def similarity(fit: dict[str, Any], grid: Grid, origin: list[float]) -> Similarity:
    """The fit of ``measure_line_up`` (grid pixels, rows south) as the correction in the CRS.

    The pivot is the fit's centroid: a cell centre, to local through ``grid``, then to the CRS
    through the manifest ``origin``. Rows run south, so the pixel turn ``b`` flips sign.
    """
    a, b = float(fit["a"]), float(fit["b"])
    x = grid.x0 + (float(fit["cx"]) + 0.5) * grid.cell
    z = grid.z0 + (float(fit["cy"]) + 0.5) * grid.cell
    return Similarity(
        float(fit["tx"]) * grid.cell,
        -float(fit["ty"]) * grid.cell,
        math.degrees(math.atan2(-b, a)) + 0.0,
        math.hypot(a, b),
        float(origin[0]) + x,
        float(origin[1]) - z,
    )


def box_en(grid: Grid, origin: list[float]) -> tuple[float, float, float, float]:
    """The grid's (minE, minN, maxE, maxN) in the CRS."""
    x0, z0, x1, z1 = grid.box
    return (origin[0] + x0, origin[1] - z1, origin[0] + x1, origin[1] - z0)


def verdict_of(inliers: int, residual: float, sim: Similarity, max_move: float, tolerance_m: float) -> str:
    """``texture``, ``disagree``, ``range``, ``aligned`` or ``ok``, in that order."""
    if inliers < MIN_TILES:
        return "texture"
    if residual > MAX_SPREAD_PX:
        return "disagree"
    if (
        abs(sim.rotation_deg) > MAX_ROTATION_DEG
        or abs(sim.scale - 1.0) > MAX_SCALE_DEV
        or max_move > MAX_MOVE_M
    ):
        return "range"
    if max_move <= tolerance_m + 1e-9:
        return "aligned"
    return "ok"


class ChangeLineUp:
    name = PRODUCER
    title = "Line up dates"
    description = (
        "How far one survey date sits from another, on their orthos (or DSM slopes), coarse to fine."
    )
    keys = frozenset({"keep", "move", "layerKeep", "layerMove"})

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        known_keys(params, set(self.keys), self.name)
        p = dict(params)
        text(p, "keep", required=True)
        text(p, "move", required=True)
        text(p, "layerKeep")
        text(p, "layerMove")
        if p["keep"] == p["move"]:
            raise JobError("Line up two different dates.")
        return p

    def plan(self, params: dict[str, Any]) -> list[Step]:
        def dates(ctx: StepContext):
            m = read_manifest(ctx.project)
            check_captures(m, params["keep"], params["move"])
            kind, keep, move = pick_layers(m, params)
            pair = (_Date(ctx.project, m, kind, keep), _Date(ctx.project, m, kind, move))
            return kind, keep, move, pair

        def result(kind: str, keep: dict[str, Any], move: dict[str, Any], **values: Any) -> dict[str, Any]:
            return {
                "keep": params["keep"],
                "move": params["move"],
                "layerKeep": str(keep["id"]),
                "layerMove": str(move["id"]),
                "source": kind,
                "eastM": 0.0,
                "northM": 0.0,
                "totalM": 0.0,
                "cellM": 0.0,
                "tolerancePx": DEFAULT_MAX_SHIFT_PX,
                "spreadPx": 0.0,
                "tiles": 0,
                **values,
            }

        def read(ctx: StepContext) -> dict[str, Any]:
            kind, _, _, (da, db) = dates(ctx)
            inputs = fingerprint(ctx.project, kind, (da, db))
            whole = union(da.box, db.box)
            box = intersect(da.box, db.box)
            # the share of the smaller footprint both dates cover, on a coarse grid over both
            coarse = Grid.over(
                whole, max(da.gsd, db.gsd, max(whole[2] - whole[0], whole[3] - whole[1]) / 256)
            )
            _, va = da.read(coarse, ctx)
            _, vb = db.read(coarse, ctx)
            both = va & vb
            overlap = float(both.sum()) / float(max(1, min(va.sum(), vb.sum())))
            if box is None or not both.any() or overlap < MIN_OVERLAP:
                ctx.log(
                    f"The dates share {overlap:.0%} of the smaller one's ground; too little to measure.",
                    "warn",
                )
                return {"verdict": "overlap", "overlap": round(overlap, 4), "inputs": inputs}
            rr, cc = np.nonzero(both)
            tight = (
                coarse.x0 + (cc.min() - 1) * coarse.cell,
                coarse.z0 + (rr.min() - 1) * coarse.cell,
                coarse.x0 + (cc.max() + 2) * coarse.cell,
                coarse.z0 + (rr.max() + 2) * coarse.cell,
            )
            box = intersect(box, tight) or box
            cell = cell_for(box, max(da.gsd, db.gsd))
            grid = Grid.over(box, cell)
            ctx.log(
                f"Measuring {grid.cols} x {grid.rows} cells of {cell * 100:.1f} cm on the "
                f"{'orthos' if kind == 'ortho' else 'DSM slopes'}; the dates share {overlap:.0%}."
            )
            a, va = da.read(grid, ctx, lambda f: ctx.progress(0.5 * f, "Date that stays"))
            ctx.progress(0.5, "Date that moves")
            b, vb = db.read(grid, ctx, lambda f: ctx.progress(0.5 + 0.5 * f, "Date that moves"))
            if kind == "dsm":
                a, b = slope(a, cell), slope(b, cell)
                va, vb = va & np.isfinite(a), vb & np.isfinite(b)
            valid = va & vb
            fill = float(np.median(a[valid])) if valid.any() else 0.0
            save_arrays(
                ctx.stage("work/grid.npz"),
                a=np.where(valid, a, fill).astype(np.float32),
                b=np.where(valid, b, fill).astype(np.float32),
                valid=valid,
            )
            return {"grid": grid.to_dict(), "overlap": round(overlap, 4), "inputs": inputs}

        def measure(ctx: StepContext) -> dict[str, Any]:
            kind, keep, move, pair = dates(ctx)
            r = ctx.outputs("read")
            want = r.get("inputs")
            if want and want.get("hash") != fingerprint(ctx.project, kind, pair)["hash"]:
                raise JobError(INPUTS_CHANGED)
            fit: dict[str, Any] = {
                "rotationDeg": 0.0,
                "scale": 1.0,
                "pivotE": 0.0,
                "pivotN": 0.0,
                "eastM": 0.0,
                "northM": 0.0,
                "maxMoveM": 0.0,
                "residualPx": 0.0,
                "inliers": 0,
                "verdict": "overlap",
            }
            if r.get("verdict") == "overlap":
                out = result(kind, keep, move, verdict="overlap")
            else:
                grid = Grid.of(r["grid"])
                origin = read_manifest(ctx.project).get("origin") or [0.0, 0.0, 0.0]
                arr = load_arrays(ctx.stage("work/grid.npz"))
                s = measure_line_up(arr["a"], arr["b"], arr["valid"], grid.cell, log=kind == "ortho")
                # the fit moves the content of `move` onto `keep`, in grid pixels (rows south)
                sim = similarity(s["fit"], grid, origin)
                most = sim.max_move(box_en(grid, origin))
                inliers, residual = int(s["fit"]["inliers"]), float(s["fit"]["residual"])
                verdict = verdict_of(inliers, residual, sim, most, DEFAULT_MAX_SHIFT_PX * grid.cell)
                east = round(sim.east_m, 3) + 0.0
                north = round(sim.north_m, 3) + 0.0
                fit = {
                    "rotationDeg": round(sim.rotation_deg, 6) + 0.0,
                    "scale": round(sim.scale, 7),
                    "pivotE": round(sim.pivot_e, 3),
                    "pivotN": round(sim.pivot_n, 3),
                    "eastM": east,
                    "northM": north,
                    "maxMoveM": round(most, 3),
                    "residualPx": residual,
                    "inliers": inliers,
                    "verdict": verdict,
                }
                out = result(
                    kind,
                    keep,
                    move,
                    eastM=east,
                    northM=north,
                    totalM=round(most, 3),
                    cellM=grid.cell,
                    spreadPx=residual,
                    tiles=inliers,
                    # an older app knows no `range`: there it reads as a disagreement
                    verdict="disagree" if verdict == "range" else verdict,
                )
                ctx.log(
                    f"{verdict}: {east:+.2f} m east, {north:+.2f} m north at the pivot, turn "
                    f"{sim.rotation_deg:+.3f} deg, scale {sim.scale:.5f}, largest move {most:.2f} m; "
                    f"{inliers} of {s['tiles']} tiles fit within {residual:.2f} px "
                    f"(coarse level 1/{s['coarse']})."
                )
            atomic_write_json(ctx.stage(RESULT), out)
            atomic_write_json(ctx.stage(FIT), fit)
            job = ctx.job.job_id
            commit_files(ctx, [(RESULT, f"jobs/{job}/{RESULT}"), (FIT, f"jobs/{job}/{FIT}")])
            return {"verdict": fit["verdict"]}

        return [
            Step("read", "Read both dates", read, 3.0),
            Step("measure", "Measure the gap", measure, 1.0),
        ]
