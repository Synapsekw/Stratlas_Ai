"""`telecom.flag`: measure an antenna a person outlined in the 3D view into the inventory.

Steps (each resumable):

1. select: the cloud points inside the outline's bounds (drawn frame: the layer's height offset
   and its date's line-up applied), kept when they project inside the polygon, then moved into
   the inventory's frame (the date of `run.captureId`); saved as `selection.npz`.
2. measure: the selection measured against the inventory run's tower axis
   (`flag.measure_selection`), else a "not measured" placeholder at the anchor.
3. photos: the best photos of the one unit and the crop of the best one.
4. commit: reads `telecom/antennas.json` again (the person may have reviewed meanwhile), adds the
   flagged unit or replaces the redrawn one, and writes the crop first and the file last. A new
   detection run since the select step (its id differs) is refused: the points are in the old
   run's frame.

Flagging needs an inventory: the axis comes from its run. The job never uses the network.
"""

from __future__ import annotations

import contextlib
from pathlib import Path
from typing import Any

import numpy as np

from ..runtime import JobError, Step, StepContext, atomic_write_json, commit_files, now_iso
from .pipeline import (
    ANTENNAS_FILE,
    CROPS_DIR,
    LAYER_ID_MAX,
    UNIT_ID,
    _convergence,
    _manifest,
    _origin,
    _read_previous,
    _save_npz,
)

FLAG_MAX_POLYGON_VERTICES = 256  # packages/schema/src/antennas.ts
NDC_LIMIT = 100.0
READ_POINTS = 400_000
NO_INVENTORY = "Run antenna detection first: flagging needs the tower found by a detection run."
UNIT_GONE = "The antenna to redraw is no longer in the inventory."
UNIT_TAKEN = "An antenna with this id is already in the inventory."
RUN_CHANGED = "The antenna inventory changed while measuring. Flag the unit again."
TEMP_ID = "flag"
#: Measured keys a typed value can replace (the schema's `AntennaMeasured`).
MEASURED_KEYS = ("azimuthGridDeg", "downtiltDeg", "centreHeightM", "widthM", "heightM", "depthM")


def _finite(v: Any) -> bool:
    return isinstance(v, int | float) and not isinstance(v, bool) and bool(np.isfinite(v))


def _vec3(v: Any, what: str) -> list[float]:
    if not isinstance(v, list) or len(v) != 3 or not all(_finite(x) for x in v):
        raise JobError(f"{what} must be a list of 3 numbers.")
    return [float(x) for x in v]


def _selection(sel: Any) -> dict[str, Any]:
    keys = {"polygon", "viewProj", "bounds", "anchor"}
    if not isinstance(sel, dict) or set(sel) != keys:
        raise JobError("selection must be {polygon, viewProj, bounds, anchor}.")
    poly = sel["polygon"]
    if (
        not isinstance(poly, list)
        or not 3 <= len(poly) <= FLAG_MAX_POLYGON_VERTICES
        or not all(
            isinstance(p, list)
            and len(p) == 2
            and all(_finite(x) and -NDC_LIMIT <= x <= NDC_LIMIT for x in p)
            for p in poly
        )
    ):
        raise JobError(
            f"selection.polygon must be 3 to {FLAG_MAX_POLYGON_VERTICES} points [x, y], each between "
            f"-{NDC_LIMIT:g} and {NDC_LIMIT:g}."
        )
    vp = sel["viewProj"]
    if not isinstance(vp, list) or len(vp) != 16 or not all(_finite(x) for x in vp):
        raise JobError("selection.viewProj must be a list of 16 numbers.")
    bounds = sel["bounds"]
    if not isinstance(bounds, dict) or set(bounds) != {"min", "max"}:
        raise JobError("selection.bounds must be {min, max}.")
    lo, hi = _vec3(bounds["min"], "selection.bounds.min"), _vec3(bounds["max"], "selection.bounds.max")
    return {
        "polygon": [[float(x), float(y)] for x, y in poly],
        "viewProj": [float(x) for x in vp],
        "bounds": {"min": lo, "max": hi},
        "anchor": _vec3(sel["anchor"], "selection.anchor"),
    }


def _measured_map(old: dict, m: dict) -> dict[str, Any]:
    """For each key the old unit holds as a person's value, the new measurement of it (the box
    centre Z for `centreHeightM`), so Reset to measured shows the redraw's value."""
    out: dict[str, Any] = {}
    for k in MEASURED_KEYS:
        mine = old.get(k)
        if not (isinstance(mine, dict) and mine.get("basis") == "user"):
            continue
        if k == "centreHeightM":
            if "widthM" in m:  # a measured box: its centre height is measured too
                q = {"basis": "measured", "support": int(m.get("support", 0))}
                out[k] = {"value": float(m["box"]["centre"][2]), "basis": "measured", "quality": q}
        elif isinstance(m.get(k), dict) and m[k].get("basis") != "user":
            out[k] = m[k]
    return out


def _redrawn(old: dict, m: dict, photos: list[dict]) -> dict[str, Any]:
    """The old unit with the redraw's geometry: values a person typed stay, review stays."""
    from .merge import GEOMETRY

    def typed(k: str) -> bool:
        v = old.get(k)
        return isinstance(v, dict) and v.get("basis") == "user"

    u = {k: v for k, v in old.items() if k not in GEOMETRY or typed(k)}
    for k in GEOMETRY:
        if k in m and not typed(k):
            u[k] = m[k]
    u["origin"] = "flagged"
    u["photos"] = photos
    u.pop("notFoundInLatest", None)
    u.pop("measured", None)
    measured = _measured_map(old, m)
    if measured:
        u["measured"] = measured
    return u


class TelecomFlag:
    name = "telecom.flag"
    title = "Flag antenna"
    description = "Measure an antenna outlined in the 3D view and add it to the antenna inventory."
    keys = frozenset({"unit", "redraw", "cloud", "selection"})

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        from ..params import known_keys

        known_keys(params, set(self.keys), self.name)
        unit = params.get("unit")
        if not isinstance(unit, str) or not UNIT_ID.match(unit):
            raise JobError("unit must look like ant-<letters, digits and dashes>.")
        out: dict[str, Any] = {"unit": unit}
        if "redraw" in params:
            if params["redraw"] is not True:
                raise JobError("redraw must be true when given.")
            out["redraw"] = True
        cloud = params.get("cloud")
        layer = cloud.get("layer") if isinstance(cloud, dict) else None
        if (
            not isinstance(cloud, dict)
            or set(cloud) != {"layer"}
            or not isinstance(layer, str)
            or not layer
            or len(layer) > LAYER_ID_MAX
        ):
            raise JobError("cloud must be {layer: <point cloud layer id>}.")
        out["cloud"] = {"layer": layer}
        out["selection"] = _selection(params.get("selection"))
        return out

    def inputs(self, params: dict[str, Any], project: Path) -> list[str]:
        return ["manifest.json", "clouds", "telecom"]

    def plan(self, params: dict[str, Any]) -> list[Step]:
        unit_id = str(params.get("unit", ""))
        redraw = bool(params.get("redraw"))

        def select_step(ctx: StepContext) -> dict[str, Any]:
            from ..captures import capture_shift, date_shift, local_delta
            from ..change.sources import height_offset_m
            from ..engineer.cloud import read_region
            from ..inspection.frame import asset_path
            from .flag import select_points

            ctx.progress(0.0, "Reading the outlined points")
            previous = _read_previous(ctx.project)
            run = (previous or {}).get("run")
            if not isinstance(run, dict) or not isinstance(run.get("axis"), dict):
                raise JobError(NO_INVENTORY)
            ids = {u.get("id") for u in previous.get("units") or [] if isinstance(u, dict)}
            if redraw and unit_id not in ids:
                raise JobError(UNIT_GONE)
            if not redraw and unit_id in ids:
                raise JobError(UNIT_TAKEN)
            manifest = _manifest(ctx.project)
            layer_id = params["cloud"]["layer"]
            layer = next(
                (
                    x
                    for x in manifest.get("layers") or []
                    if isinstance(x, dict) and x.get("id") == layer_id and x.get("kind") == "pointcloud"
                ),
                None,
            )
            if layer is None:
                raise JobError(f'The point cloud layer "{layer_id}" is not in the project.')
            path = asset_path(ctx.project, layer.get("src"))
            if path is None or not path.exists():
                raise JobError(f'The point cloud "{layer.get("name", layer_id)}" has no file to read.')
            sel = params["selection"]
            xyz, info = read_region(
                path,
                str(layer.get("format") or "las"),
                {"min": sel["bounds"]["min"], "max": sel["bounds"]["max"]},
                READ_POINTS,
                ctx,
                _origin(manifest),
                seed=0,
                offset_m=height_offset_m(layer),
                shift=date_shift(manifest, layer_id),
                order_free=True,
            )
            ctx.check()
            kept = xyz[select_points(xyz, sel["polygon"], sel["viewProj"])] if len(xyz) else xyz
            capture = run.get("captureId")
            dx, dz = local_delta(capture_shift(manifest, capture)) if isinstance(capture, str) else (0.0, 0.0)
            move = np.array([dx, 0.0, dz])
            points = np.asarray(kept, dtype=np.float64).reshape(-1, 3) - move
            anchor = np.asarray(sel["anchor"], dtype=np.float64) - move
            _save_npz(ctx.stage("selection.npz"), points=points, anchor=anchor)
            ctx.log(f"{len(points):,} of {int(info['read']):,} points in the bounds are inside the outline.")
            # the run the points were moved into the frame of: a new run before the commit refuses
            return {"points": len(points), "runId": str(run.get("id", ""))}

        def measure_step(ctx: StepContext) -> dict[str, Any]:
            from .flag import measure_selection, not_measured
            from .measure import from_project

            ctx.progress(0.0, "Measuring the flagged unit")
            manifest = _manifest(ctx.project)
            previous = _read_previous(ctx.project)
            run = (previous or {}).get("run")
            if not isinstance(run, dict) or not isinstance(run.get("axis"), dict):
                raise JobError(NO_INVENTORY)
            run_id = ctx.outputs("select").get("runId")
            if run_id is not None and str(run.get("id", "")) != run_id:
                raise JobError(RUN_CHANGED)
            origin = _origin(manifest)
            point = from_project(np.asarray(run["axis"]["point"], dtype=float), origin)
            e, n, z = (float(v) for v in run["axis"]["dir"])
            direction = np.array([e, z, -n])
            with np.load(ctx.stage("selection.npz")) as f:
                xyz = np.asarray(f["points"], dtype=np.float64)
                anchor = np.asarray(f["anchor"], dtype=np.float64)
            convergence = _convergence(manifest, point)
            m = measure_selection(xyz, point, direction, origin, convergence)
            if m is None:
                m = not_measured(anchor, origin, len(xyz), convergence)
                ctx.log(f"{len(xyz):,} points: too few or no flat face, so the unit is not measured.", "warn")
            else:
                ctx.log(f"{len(xyz):,} points measured as one unit.")
            return {"unit": m, "measured": "widthM" in m, "runId": run_id or str(run.get("id", ""))}

        def photos_step(ctx: StepContext) -> dict[str, Any]:
            from .photos import best_photos, posed_photos, write_crop

            ctx.progress(0.0, "Picking the best photos")
            manifest = _manifest(ctx.project)
            m = ctx.outputs("measure")["unit"]
            posed = posed_photos(manifest, ctx.project)
            photos = best_photos([{**m, "id": TEMP_ID}], manifest, ctx.project, ctx.check, posed).get(
                TEMP_ID, []
            )
            crop = False
            if photos:
                staged = ctx.stage(f"crops/{unit_id}.jpg")
                crop = write_crop(ctx.project, m, photos[0], manifest, staged, posed) is not None
            ctx.log(f"Seen in {len(photos)} posed photos" + ("; crop cut." if crop else "."))
            return {"photos": photos, "crop": crop, "createdAt": now_iso()}

        def commit_step(ctx: StepContext) -> dict[str, Any]:
            from .merge import next_name

            ctx.progress(0.0, "Saving the inventory")
            doc = _read_previous(ctx.project)
            if doc is None:
                raise JobError(NO_INVENTORY)
            measured = ctx.outputs("measure")
            # a detection run (another date, another frame) committed since select: refuse
            run_id = measured.get("runId")
            if run_id and str((doc.get("run") or {}).get("id", "")) != run_id:
                raise JobError(RUN_CHANGED)
            m = dict(measured["unit"])
            shot = ctx.outputs("photos")
            photos = shot.get("photos") or []
            units = [u for u in doc.get("units") or [] if isinstance(u, dict)]
            at = next((k for k, u in enumerate(units) if u.get("id") == unit_id), None)
            if redraw:
                if at is None:
                    raise JobError(UNIT_GONE)
                unit = _redrawn(units[at], m, photos)
            else:
                others = [u for k, u in enumerate(units) if k != at]
                # a commit interrupted after the file was written finds its own unit: replace it
                name = units[at].get("name") if at is not None else next_name(others)
                unit = {
                    **m,
                    "id": unit_id,
                    "name": name,
                    "status": "accepted",
                    "origin": "flagged",
                    "kindBasis": "geometry",
                    "kind": "other",
                    "photos": photos,
                    "user": {},
                    "runId": run_id or str((doc.get("run") or {}).get("id", "")),
                    "createdAt": shot.get("createdAt") or now_iso(),
                }
            rel = f"{CROPS_DIR}/{unit_id}.jpg"
            moves: list[tuple[str, str]] = []
            if shot.get("crop") and (ctx.stage(f"crops/{unit_id}.jpg").exists() or ctx.out(rel).exists()):
                moves.append((f"crops/{unit_id}.jpg", rel))
                unit["crop"] = rel
            else:
                unit.pop("crop", None)
            if at is None:
                units.append(unit)
            else:
                units[at] = unit
            atomic_write_json(ctx.stage("antennas.json"), {**doc, "units": units})
            # the crop first, the inventory last: it never names a crop that is not there yet
            commit_files(ctx, moves, announce=False)
            commit_files(ctx, [("antennas.json", ANTENNAS_FILE)])
            if not moves:
                with contextlib.suppress(OSError):
                    (ctx.project / rel).unlink(missing_ok=True)
            ctx.log(
                f"{unit['name']} {'redrawn' if redraw else 'flagged'}"
                + ("" if measured.get("measured") else " (not measured)")
                + "."
            )
            return {"unitId": unit_id, "measured": bool(measured.get("measured")), "file": ANTENNAS_FILE}

        return [
            Step("select", "Reading the outlined points", select_step, weight=1.0),
            Step("measure", "Measuring the flagged unit", measure_step, weight=1.0),
            Step("photos", "Picking the best photos", photos_step, weight=0.5),
            Step("commit", "Saving the inventory", commit_step, weight=0.2),
        ]
