"""change.lineup: how far one survey date sits from another, and the correction it still needs.

Parameters as ``ChangeLineUpParams`` in ``@aio/schema`` (``jobs.ts``): ``keep`` (the date that
stays), ``move`` (the date that moves) and optionally the layers to measure, by default each
date's ortho, else its DSM. Steps:

1. read    both dates where they are lined up now (their stored shifts applied, as change.raster
           and change.surface read them) onto a common grid over the area both cover, as
           ``change.raster`` builds it: an ortho's brightness, or a DSM's slope;
2. measure the shift coarse to fine (``register.measure_line_up``) and its verdict, written to
           ``jobs/<id>/lineup.json`` as a ``LineUpMeasure`` (``packages/schema/src/change.ts``).

``eastM`` and ``northM`` are the correction ``move`` still needs, so the app adds them to its
current shift. Only ``ok`` can be saved: ``aligned`` (within the change check's tolerance),
``texture`` (too few textured tiles), ``disagree`` (the tiles do not agree, as for a rotated copy)
and ``overlap`` (the dates hardly share ground) are answers too, not failures. The job never
writes the manifest.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np

from ..captures import layer_captures
from ..params import known_keys, text
from ..runtime import JobError, Step, StepContext, atomic_write_json, commit_files
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
from .register import MAX_SPREAD_PX, MIN_OVERLAP, MIN_TILES, measure_line_up, slope
from .surface import Surface, surface_fingerprint

PRODUCER = "change.lineup"
RESULT = "lineup.json"
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
            if r.get("verdict") == "overlap":
                out = result(kind, keep, move, verdict="overlap")
            else:
                grid = Grid.of(r["grid"])
                arr = load_arrays(ctx.stage("work/grid.npz"))
                s = measure_line_up(arr["a"], arr["b"], arr["valid"], grid.cell, log=kind == "ortho")
                # s moves the grid of `move` onto `keep`: columns east, rows south
                east = round(s["dx"] * grid.cell, 3) + 0.0
                north = round(-s["dy"] * grid.cell, 3) + 0.0
                if s["tiles"] < MIN_TILES:
                    verdict = "texture"
                elif s["spread"] > MAX_SPREAD_PX:
                    verdict = "disagree"
                elif s["px"] <= DEFAULT_MAX_SHIFT_PX + 1e-9:
                    verdict = "aligned"
                else:
                    verdict = "ok"
                out = result(
                    kind,
                    keep,
                    move,
                    eastM=east,
                    northM=north,
                    totalM=round(float(np.hypot(east, north)), 3),
                    cellM=grid.cell,
                    spreadPx=s["spread"],
                    tiles=s["tiles"],
                    verdict=verdict,
                )
                ctx.log(
                    f"{verdict}: {out['totalM']:.2f} m ({s['px']:.1f} px) on {s['tiles']} tiles, "
                    f"spread {s['spread']:.2f} px (coarse level 1/{s['coarse']})."
                )
            atomic_write_json(ctx.stage(RESULT), out)
            commit_files(ctx, [(RESULT, f"jobs/{ctx.job.job_id}/{RESULT}")])
            return {"verdict": out["verdict"]}

        return [
            Step("read", "Read both dates", read, 3.0),
            Step("measure", "Measure the gap", measure, 1.0),
        ]
