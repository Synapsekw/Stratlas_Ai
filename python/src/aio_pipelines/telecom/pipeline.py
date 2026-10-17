"""`telecom.antennas`: find, box and measure the antennas on a tower crown from a point cloud.

Steps (each resumable; state between steps is plain arrays in the job's staging folder):

1. crown: the cloud, the tower axis and the equipment band (`crown.locate_crown`), saved as
   `crown.npz` (band points, axis point and direction, shaft radius coefficients).
2. faces: upright planar faces of the band (`faces.planar_faces`), saved as `faces.npz`.
3. boxes: oriented boxes, kinds and measurements (`boxes.pair_faces`, `measure.measure_unit`) with
   the grid convergence at the tower; the unit dicts are the step's outputs.
4. photos: the best photos of each unit; the re-run merge gives the final unit ids, then the crop
   of each unit's best photo is staged as `crops/<photo-time id>.jpg`.
5. commit: reads `telecom/antennas.json` again (the person may have reviewed during the run),
   merges, writes the file to staging and moves the crops in first and the inventory last.

Coordinates in the file are project E, N, Z with the layer's `heightOffsetM` applied. A manifest
without a `crs` has no CRS: convergence is null and azimuths are project north (the LAS header's
EPSG is not used).
"""

from __future__ import annotations

import contextlib
import json
import re
from pathlib import Path
from typing import Any

import numpy as np

from ..params import known_keys, number, numbers, text
from ..runtime import AtomicPath, JobError, Step, StepContext, atomic_write_json, commit_files, now_iso

ANTENNAS_SCHEMA = "aio.antennas/1"
ANTENNAS_FILE = "telecom/antennas.json"
CROPS_DIR = "telecom/crops"
RUN_ID = re.compile(r"^run-[a-z0-9-]{1,60}$")
UNIT_ID = re.compile(r"^ant-[a-z0-9-]{1,60}$")
LAYER_ID_MAX = 128
WARNING_MAX = 300
KINDS = ("panel", "short", "dish", "other")
_FACE_VECTORS = ("centre", "normal", "up", "side")
_FACE_SCALARS = ("height", "width", "rms", "support", "coverage")


def _manifest(project: Path) -> dict[str, Any]:
    from ..inspection.frame import read_manifest

    return read_manifest(project)


def _origin(manifest: dict) -> tuple[float, float, float]:
    o = manifest.get("origin") or [0.0, 0.0, 0.0]
    return float(o[0]), float(o[1]), float(o[2])


def _epsg(manifest: dict) -> tuple[int | None, bool]:
    """(EPSG code, has a CRS). An absent `crs` is no CRS; a WKT CRS gives its EPSG when pyproj
    knows one."""
    crs = manifest.get("crs")
    if not isinstance(crs, dict):
        return None, False
    if isinstance(crs.get("epsg"), int) and not isinstance(crs.get("epsg"), bool):
        return int(crs["epsg"]), True
    wkt = crs.get("wkt")
    if isinstance(wkt, str) and wkt.strip():
        try:
            from pyproj import CRS

            code = CRS.from_wkt(wkt).to_epsg()
        except Exception:
            code = None
        return (int(code) if code else None), True
    return None, False


def _convergence(manifest: dict, axis_point: np.ndarray) -> float | None:
    """Grid convergence at the tower (degrees), None without a CRS or when it cannot be found."""
    from pyproj import Transformer

    from .measure import grid_convergence_deg, to_project

    epsg, _ = _epsg(manifest)
    if epsg is None:
        return None
    e, n, _ = to_project(np.asarray(axis_point, dtype=float), _origin(manifest))
    try:
        lon, lat = Transformer.from_crs(epsg, 4326, always_xy=True).transform(float(e), float(n))
        c = grid_convergence_deg(lon, lat, epsg)
    except Exception:
        return None
    return round(c, 4) + 0.0 if np.isfinite(c) else None


def _save_npz(path: Path, **arrays: np.ndarray) -> None:
    with AtomicPath(path) as tmp, open(tmp, "wb") as f:
        np.savez(f, **arrays)


def _load_crown(ctx: StepContext):
    from .crown import ShaftRadius

    with np.load(ctx.stage("crown.npz")) as z:
        xyz = np.asarray(z["xyz"], dtype=np.float64)
        point = np.asarray(z["point"], dtype=np.float64)
        direction = np.asarray(z["dir"], dtype=np.float64)
        shaft = ShaftRadius.from_coef(z["shaft"])
    return xyz, point, direction, shaft


def _save_faces(path: Path, faces: list) -> None:
    counts = np.array([len(f.points) for f in faces], dtype=np.int64)
    pts = np.concatenate([f.points for f in faces]) if faces else np.zeros((0, 3))
    arrays: dict[str, np.ndarray] = {"points": np.asarray(pts, dtype=np.float64), "counts": counts}
    for k in _FACE_VECTORS:
        arrays[k] = np.array([getattr(f, k) for f in faces], dtype=np.float64).reshape(-1, 3)
    for k in _FACE_SCALARS:
        arrays[k] = np.array([getattr(f, k) for f in faces], dtype=np.float64)
    _save_npz(path, **arrays)


def _load_faces(path: Path) -> list:
    from .faces import Face

    with np.load(path) as z:
        a = {k: z[k] for k in z.files}
    faces = []
    start = 0
    for i, n in enumerate(a["counts"]):
        n = int(n)
        faces.append(
            Face(
                points=a["points"][start : start + n],
                centre=a["centre"][i],
                normal=a["normal"][i],
                up=a["up"][i],
                side=a["side"][i],
                height=float(a["height"][i]),
                width=float(a["width"][i]),
                rms=float(a["rms"][i]),
                support=int(a["support"][i]),
                coverage=float(a["coverage"][i]),
            )
        )
        start += n
    return faces


def _read_previous(project: Path) -> dict | None:
    p = project / ANTENNAS_FILE
    if not p.is_file():
        return None
    try:
        doc = json.loads(p.read_text("utf-8"))
    except (OSError, ValueError) as e:
        raise JobError(
            f"The antenna inventory {ANTENNAS_FILE} cannot be read ({type(e).__name__}); "
            "fix or move it and run again."
        ) from e
    if not isinstance(doc, dict) or doc.get("schema") != ANTENNAS_SCHEMA:
        raise JobError(f"{ANTENNAS_FILE} is not an antenna inventory ({ANTENNAS_SCHEMA}).")
    return doc


class TelecomAntennas:
    name = "telecom.antennas"
    title = "Detect antennas"
    description = "Find, box and measure the antennas on a tower crown from a point cloud."
    keys = frozenset({"run", "cloud", "towerHint", "floorFraction"})

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        known_keys(params, set(self.keys), self.name)
        run = text(params, "run", required=True)
        if not RUN_ID.match(run or ""):
            raise JobError("run must look like run-<letters, digits and dashes>.")
        out: dict[str, Any] = {"run": run}
        cloud = params.get("cloud")
        if cloud is not None:
            layer = cloud.get("layer") if isinstance(cloud, dict) else None
            if (
                not isinstance(cloud, dict)
                or set(cloud) != {"layer"}
                or not isinstance(layer, str)
                or not layer.strip()
                or len(layer) > LAYER_ID_MAX
            ):
                raise JobError("cloud must be {layer: <point cloud layer id>}.")
            out["cloud"] = {"layer": layer}
        hint = numbers(params, "towerHint", 2)
        if hint is not None:
            if not all(np.isfinite(hint)):
                raise JobError("towerHint must be a list of 2 numbers.")
            out["towerHint"] = hint
        fraction = number(params, "floorFraction", None, lo=0.3, hi=0.95)
        if fraction is not None:
            out["floorFraction"] = fraction
        return out

    def inputs(self, params: dict[str, Any], project: Path) -> list[str]:
        return ["manifest.json", "clouds", "engineering"]

    def plan(self, params: dict[str, Any]) -> list[Step]:
        run_id = str(params["run"])

        def crown_step(ctx: StepContext) -> dict[str, Any]:
            from .crown import locate_crown
            from .measure import to_project

            ctx.progress(0.0, "Locating the tower crown")
            manifest = _manifest(ctx.project)
            crown = locate_crown(ctx, ctx.project, manifest, params)
            ctx.check()
            point = np.asarray(crown.axis.point, dtype=np.float64)
            _save_npz(
                ctx.stage("crown.npz"),
                xyz=np.asarray(crown.xyz, dtype=np.float32),
                point=point,
                dir=np.asarray(crown.axis.dir, dtype=np.float64),
                shaft=np.asarray(crown.shaft_r.coef, dtype=np.float64),
            )
            oz = _origin(manifest)[2]
            # the axis point is the tower's base, carried to the lowest point of the tower crop: the
            # ground at the tower (engineer.axis.estimate_axis, evidence `base`)
            ground_z = float(to_project(point, _origin(manifest))[2])
            ctx.log(f"Tower axis from {crown.source}; {len(crown.xyz):,} points in the antenna band.")
            return {
                "source": crown.source,
                "layer": crown.layer_id,
                "heightM": round(float(crown.height), 3),
                "floorZ": round(oz + crown.floor_y, 3),
                "topZ": round(oz + crown.top_y, 3),
                "radiusM": round(float(crown.radius_m), 3),
                "groundZ": round(ground_z, 3),
                "warnings": [str(w)[:WARNING_MAX] for w in crown.warnings],
                "points": len(crown.xyz),
            }

        def faces_step(ctx: StepContext) -> dict[str, Any]:
            from .faces import planar_faces

            ctx.progress(0.0, "Finding planar faces")
            xyz, point, direction, shaft = _load_crown(ctx)
            faces = planar_faces(xyz, point, direction, shaft)
            ctx.check()
            _save_faces(ctx.stage("faces.npz"), faces)
            ctx.log(f"{len(faces)} planar faces on the crown.")
            return {"faces": len(faces)}

        def boxes_step(ctx: StepContext) -> dict[str, Any]:
            from .boxes import pair_faces
            from .measure import measure_unit

            ctx.progress(0.0, "Fitting antenna boxes")
            manifest = _manifest(ctx.project)
            xyz, point, _, _ = _load_crown(ctx)
            faces = _load_faces(ctx.stage("faces.npz"))
            units = pair_faces(faces, point, xyz) if faces else []
            ctx.check()
            convergence = _convergence(manifest, point)
            origin = _origin(manifest)
            out = []
            for u in units:
                m = measure_unit(u, origin, convergence)
                m["convergenceDeg"] = convergence
                out.append(m)
            ctx.log(f"{len(out)} units boxed and measured.")
            return {"units": out, "convergenceDeg": convergence}

        def new_units(ctx: StepContext) -> list[dict[str, Any]]:
            out = ctx.outputs("photos")
            return _run_units(
                ctx.outputs("boxes").get("units") or [], out.get("photos") or [], run_id, out["createdAt"]
            )

        def photos_step(ctx: StepContext) -> dict[str, Any]:
            from .merge import merge_with_sources
            from .photos import best_photos, write_crop

            ctx.progress(0.0, "Picking the best photos")
            manifest = _manifest(ctx.project)
            measured = ctx.outputs("boxes").get("units") or []
            temp = [{**m, "id": f"new-{k}"} for k, m in enumerate(measured)]
            best = best_photos(temp, manifest, ctx.project, ctx.check)
            photos = [best.get(f"new-{k}", []) for k in range(len(measured))]
            created = now_iso()
            units = _run_units(measured, photos, run_id, created)
            # final ids first (the merge), so each crop is named by the id it will have
            merged = merge_with_sources(_read_previous(ctx.project), units, run_id)
            crops: dict[str, str] = {}
            n = max(1, len(merged))
            for j, (u, src) in enumerate(merged):
                ctx.check()
                if src is None or not photos[src] or not UNIT_ID.match(u["id"]):
                    continue
                staged = f"crops/{u['id']}.jpg"
                if write_crop(ctx.project, u, photos[src][0], manifest, ctx.stage(staged)) is not None:
                    crops[str(src)] = u["id"]
                ctx.progress((j + 1) / n)
            seen = sum(1 for p in photos if p)
            ctx.log(f"{seen} of {len(measured)} units are seen in a posed photo; {len(crops)} crops.")
            return {"photos": photos, "crops": crops, "createdAt": created}

        def commit_step(ctx: StepContext) -> dict[str, Any]:
            from .measure import to_project, to_project_dir
            from .merge import merge_with_sources

            ctx.progress(0.0, "Saving the inventory")
            manifest = _manifest(ctx.project)
            crown = ctx.outputs("crown")
            _, point, direction, _ = _load_crown(ctx)
            units = new_units(ctx)
            staged_crops: dict[str, str] = ctx.outputs("photos").get("crops") or {}
            previous = _read_previous(ctx.project)
            merged = merge_with_sources(previous, units, run_id)
            moves: list[tuple[str, str]] = []
            final: list[dict[str, Any]] = []
            for u, src in merged:
                u = dict(u)
                photo_id = staged_crops.get(str(src)) if src is not None else None
                rel = f"{CROPS_DIR}/{u['id']}.jpg"
                # the id may differ from the photo step's when the person reviewed meanwhile; a
                # crop already moved by an interrupted commit is at its final place
                if photo_id is not None and (
                    ctx.stage(f"crops/{photo_id}.jpg").exists() or ctx.out(rel).exists()
                ):
                    moves.append((f"crops/{photo_id}.jpg", rel))
                    u["crop"] = rel
                elif src is not None and units[src].get("photos"):
                    u.pop("crop", None)  # its photos changed and no crop could be cut
                final.append(u)

            epsg, has_crs = _epsg(manifest)
            convergence = ctx.outputs("boxes").get("convergenceDeg")
            warnings = list(crown.get("warnings") or [])
            if has_crs and epsg is None:
                warnings.append(
                    "The project CRS has no EPSG code, so true north is not known; azimuths are grid."
                )
            missing = sum(1 for u in final if u.get("notFoundInLatest"))
            if missing:
                warnings.append(
                    f"{missing} accepted units were not found in this run; they are kept and flagged."
                )
            if not units:
                warnings.append("No antenna or other equipment was found on the crown.")
            counts = {k: 0 for k in KINDS}
            for u in units:
                counts[u["kind"]] = counts.get(u["kind"], 0) + 1
            origin = _origin(manifest)
            axis_dir = to_project_dir(direction)
            run: dict[str, Any] = {
                "id": run_id,
                "at": now_iso(),
                "params": params,
                "cloudLayer": str(crown["layer"])[:LAYER_ID_MAX],
                "axis": {
                    "point": [round(float(v), 3) + 0.0 for v in to_project(point, origin)],
                    "dir": [round(float(v), 6) + 0.0 for v in axis_dir],
                    "source": crown["source"],
                },
                "crown": {"floorZ": crown["floorZ"], "topZ": crown["topZ"], "radiusM": crown["radiusM"]},
                "groundZ": crown["groundZ"],
                "north": "grid" if has_crs else "project",
                "warnings": [w[:WARNING_MAX] for w in warnings],
                "counts": counts,
            }
            doc = {"schema": ANTENNAS_SCHEMA, "run": run, "units": final}
            atomic_write_json(ctx.stage("antennas.json"), doc)
            # crops first, the inventory last: it never names a crop that is not there yet
            commit_files(ctx, moves, announce=False)
            commit_files(ctx, [("antennas.json", ANTENNAS_FILE)])
            _drop_stale_crops(ctx.project, previous, final)
            ctx.log(
                f"{len(final)} units in the inventory ({len(units)} found in this run, convergence "
                f"{'none' if convergence is None else f'{convergence:.3f} deg'})."
            )
            return {"units": len(final), "found": len(units), "crops": len(moves), "file": ANTENNAS_FILE}

        return [
            Step("crown", "Locating the tower crown", crown_step, weight=2.0),
            Step("faces", "Finding planar faces", faces_step, weight=3.0),
            Step("boxes", "Fitting antenna boxes", boxes_step, weight=1.0),
            Step("photos", "Picking the best photos", photos_step, weight=1.0),
            Step("commit", "Saving the inventory", commit_step, weight=0.2),
        ]


def _run_units(measured: list[dict], photos: list[list[dict]], run_id: str, created: str) -> list[dict]:
    """This run's units with every field but id, name and status."""
    return [
        {
            **m,
            "kindBasis": "geometry",
            "photos": photos[k] if k < len(photos) else [],
            "user": {},
            "runId": run_id,
            "createdAt": created,
        }
        for k, m in enumerate(measured)
    ]


def _drop_stale_crops(project: Path, previous: dict | None, final: list[dict]) -> None:
    """Remove the crops of units the merge dropped, and of units that no longer name one. Crops of
    kept units (accepted but not found, rejected) stay."""
    keep = {u["id"] for u in final if u.get("crop")}
    ids = {u.get("id") for u in ((previous or {}).get("units") or []) if isinstance(u, dict)}
    ids |= {u["id"] for u in final}
    for uid in ids:
        if not isinstance(uid, str) or not UNIT_ID.match(uid) or uid in keep:
            continue
        p = project / CROPS_DIR / f"{uid}.jpg"
        with contextlib.suppress(OSError):
            p.unlink(missing_ok=True)
