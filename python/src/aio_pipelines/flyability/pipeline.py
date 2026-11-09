"""flyability.import: a Flyability Inspector export into the open project, one space per inspection.

Steps (data-conventions section 40):

- ``read``: the export (``export.read_export``) and which space each selected inspection lands in:
  the ``spaces`` parameter, else an existing space whose ``source.inspectionId`` is the
  inspection, else ``fly-<first 8 of the inspection id>``.
- ``clouds``: each selected flight's ``*_livemap.las`` and the inspection's merged cloud to COPC
  under ``clouds/flyability/<spaceId>/``, a flight's own ``transform`` applied by PDAL on the way
  (no reprojection: the space has a local frame). A cloud whose COPC is there from the same source
  (its size and matrix, kept in ``imports/flyability/<spaceId>/clouds.json``) is not built again.
- ``paths``: each selected flight's livetraj as a pose file (``aio.flight/1``),
  ``imports/flyability/<spaceId>/poses/<flight 8>.flight.json``, in the scene frame.
- ``photos``: each snapshot's still and annotated image copied to
  ``imports/flyability/<spaceId>/photos/``, placed at the transformed ``camera_pose``.
- ``locate``: every snapshot's camera ray cast into the merged cloud (or the union of the
  space's flight clouds) to pin its finding.
- ``findings``: one issue per point of interest (``findings.build_issue``).
- ``register``: the files committed, then one manifest write (spaces, layers, the severity model
  and class catalogue when absent) and the issues merged into ``issues.json`` keeping every edit;
  both keep their previous file as ``.bak``.

Video, flight logs (``.bag``, ``.mcap``, ``.stn``), thermal files, operator e-mails and the launch
location are never read or copied.
"""

from __future__ import annotations

import copy
import json
import math
import re
import shutil
from pathlib import Path
from typing import Any

from .. import pointcloud as pc
from ..params import known_keys, text
from ..runtime import (
    JobError,
    Step,
    StepContext,
    atomic_write_json,
    commit_files,
    manifest_lock,
    now_iso,
    safe_project_path,
)
from .ids import ID_MAX, cap_id

NAME = "flyability.import"
LENS = {"model": "ftheta", "hfovDeg": 114, "aspect": 1.7778}
LOCAL_CRS = {"local": "flyability"}
ISSUES_SCHEMA = "aio.issues/1"
CLOUD_RECORD = "aio.flyability-clouds/1"
PHOTO_SUFFIXES = {".jpg", ".jpeg", ".png"}
LINE_COLORS = ["#3e8fd0", "#f5a524", "#46a758", "#d6409f", "#8e4ec6", "#12a594", "#e5484d", "#978365"]
# CONFINED_SPACE_TEMPLATE's catalogue (packages/project/src/builder/templates.ts)
CATALOGUE_NAME = "Confined-space findings"
ASSET_TYPE = "confined-space"
DEFAULT_CLASS = {"id": "finding", "label": "Finding", "color": "#95a0ab"}
MAIN_SPACE = "main"


def _id(v: Any, what: str) -> str:
    if not isinstance(v, str) or not v.strip() or len(v) > ID_MAX:
        raise JobError(f"{what} must be a text of 1 to {ID_MAX} characters.")
    return v


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:60] or "flight"


_NO_NAME = {"", "undefined", "null", "none", "unnamed"}


def _flight_stem(name: str | None, n: int) -> str:
    """The cloud file stem of flight number `n`: its name, or ``flight-<n>`` when it has none
    (the drone software names such a flight "Undefined")."""
    slug = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")
    return f"flight-{n}" if slug in _NO_NAME else _slug(slug)


def _imports(sid: str) -> str:
    return f"imports/flyability/{sid}"


def _cloud_rel(taken: dict[Any, Any], sid: str, stem: str, lid: str, fallback: str) -> str:
    """``clouds/flyability/<sid>/<stem>.copc.laz``, or ``<stem>-<fallback>`` when another layer
    holds that name; the name is then held by ``lid``."""
    rel = f"clouds/flyability/{sid}/{stem}.copc.laz"
    if taken.get(rel, lid) != lid:
        rel = f"clouds/flyability/{sid}/{stem}-{fallback}.copc.laz"
    taken[rel] = lid
    return rel


def _cloud_key(c: dict[str, Any]) -> dict[str, Any]:
    """What a built cloud came from: the source's size and change time (ns) and the matrix."""
    return {"bytes": c["bytes"], "mtimeNs": c["mtimeNs"], "matrix": c["matrix"]}


def _check_severity_model(v: Any) -> dict[str, Any]:
    ok = (
        isinstance(v, dict)
        and isinstance(v.get("id"), str)
        and 0 < len(v["id"]) <= ID_MAX
        and isinstance(v.get("name"), str)
        and bool(v["name"])
        and isinstance(v.get("levels"), list)
        and len(v["levels"]) > 0
        and all(
            isinstance(lv, dict)
            and isinstance(lv.get("value"), int)
            and not isinstance(lv.get("value"), bool)
            and isinstance(lv.get("label"), str)
            and isinstance(lv.get("color"), str)
            for lv in v["levels"]
        )
    )
    if not ok:
        raise JobError("severityModel must be a severity model with an id, a name and its levels.")
    return v


def _check_inspections(v: Any) -> list[dict[str, Any]]:
    if not isinstance(v, list) or not v:
        raise JobError("inspections must list at least one inspection.")
    out: list[dict[str, Any]] = []
    for item in v:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"]:
            raise JobError("Each of inspections needs an id.")
        if any(e["id"] == item["id"] for e in out):
            raise JobError(f"Inspection {item['id']} is listed twice.")
        entry: dict[str, Any] = {"id": item["id"]}
        flights = item.get("flights")
        if flights is not None:
            if not isinstance(flights, list) or not all(isinstance(f, str) for f in flights):
                raise JobError("An inspection's flights must be a list of flight ids.")
            entry["flights"] = list(flights)
        out.append(entry)
    return out


def _check_spaces(v: Any) -> dict[str, str] | None:
    if v is None:
        return None
    if not isinstance(v, dict):
        raise JobError("spaces must map inspection ids to space ids.")
    out: dict[str, str] = {}
    for k, sid in v.items():
        out[str(k)] = _id(sid, "A space id")
        if sid == MAIN_SPACE:
            raise JobError(f'The space id "{MAIN_SPACE}" is the project\'s own space; pick another one.')
    return out


def _export(params: dict[str, Any]):
    from .export import read_export

    return read_export(Path(params["src"]))


def _inspection(export, iid: str):
    for insp in export.inspections:
        if insp.id == iid:
            return insp
    raise JobError(f"The export has no inspection {iid}.")


def _read_manifest(project: Path) -> dict[str, Any]:
    return json.loads(safe_project_path(project, "manifest.json").read_text("utf-8"))


def _matrix(m) -> list[float] | None:
    return None if m is None else [float(v) for v in m.reshape(-1)]


def _las_count(ctx: StepContext, pdal: str | None, src: Path) -> int:
    from ..volumetric.cloud import LasHeader

    try:
        return LasHeader(src).count
    except JobError:
        if not pdal:
            raise
        return int(pc.read_summary(ctx, pdal, src).get("num_points") or 0)


def _points(ctx: StepContext, src: Path, matrix=None):
    """The finite points of an Inspector cloud (an uncompressed LAS), moved by ``matrix``; a large
    cloud is thinned to a 1 cm grid chunk by chunk, as the ray cast would thin it anyway."""
    import numpy as np

    from ..volumetric.cloud import LasHeader, read_las_chunks
    from .frames import _GRID_ABOVE, _grid_subsample, apply

    big = LasHeader(src).count > _GRID_ABOVE
    parts = []
    for x, y, z, _ in read_las_chunks(src, ctx.check):
        xyz = np.column_stack([x, y, z])
        xyz = xyz[np.isfinite(xyz).all(axis=1)]
        if len(xyz) and big:
            xyz = _grid_subsample(xyz)
        parts.append(apply(matrix, xyz))
    return np.concatenate(parts) if parts else np.zeros((0, 3))


def _captured_at(flight, time_us: int) -> str | None:
    from datetime import UTC, datetime

    if flight is None or flight.datetime_utc is None or flight.phase_start_us is None:
        return None
    seconds = flight.datetime_utc + (time_us - flight.phase_start_us) / 1e6
    return datetime.fromtimestamp(seconds, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _catalogue(manifest: dict[str, Any], cid: str, model_id: str) -> dict[str, Any]:
    """The manifest's catalogue ``cid`` (made when absent), with the untagged ``finding`` class."""
    cats = manifest.setdefault("classCatalogues", [])
    cat = next((c for c in cats if isinstance(c, dict) and c.get("id") == cid), None)
    if cat is None:
        cat = {"id": cid, "name": CATALOGUE_NAME, "assetType": ASSET_TYPE, "classes": []}
        cats.append(cat)
    classes = cat.setdefault("classes", [])
    if not any(isinstance(c, dict) and c.get("id") == DEFAULT_CLASS["id"] for c in classes):
        classes.insert(0, {**DEFAULT_CLASS, "severityModel": model_id})
    return cat


class FlyabilityImport:
    name = NAME
    title = "Flyability Inspector import"
    description = "Clouds, flight lines and findings from an Inspector export, one space per inspection."

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        known_keys(params, {"src", "inspections", "severityModel", "catalogueId", "spaces"}, self.name)
        out: dict[str, Any] = {
            "src": text(params, "src", required=True),
            "inspections": _check_inspections(params.get("inspections")),
            "severityModel": _check_severity_model(params.get("severityModel")),
            "catalogueId": _id(params.get("catalogueId"), "catalogueId"),
        }
        spaces = _check_spaces(params.get("spaces"))
        if spaces is not None:
            out["spaces"] = spaces
        return out

    def inputs(self, params: dict[str, Any]) -> list[str]:
        return [params["src"]]

    def plan(self, params: dict[str, Any]) -> list[Step]:
        model_id = params["severityModel"]["id"]

        def selection(ctx: StepContext, export) -> list[tuple[dict[str, Any], Any, list[Any]]]:
            """(space record, inspection, selected flights) per selected inspection."""
            out = []
            for sp in ctx.outputs("read")["spaces"]:
                insp = _inspection(export, sp["inspection"])
                wanted = set(sp["flights"])
                out.append((sp, insp, [f for f in insp.flights if f.id in wanted]))
            return out

        # ---------------------------------------------------------------------------------- read
        def read(ctx: StepContext) -> dict[str, Any]:
            export = _export(params)
            manifest = _read_manifest(ctx.project)
            existing = [s for s in manifest.get("spaces") or [] if isinstance(s, dict)]
            by_source = {
                (s.get("source") or {}).get("inspectionId"): s["id"]
                for s in existing
                if isinstance(s.get("source"), dict) and isinstance(s.get("id"), str)
            }
            source_of = {
                s.get("id"): (s.get("source") or {}).get("inspectionId")
                for s in existing
                if isinstance(s.get("source"), dict)
            }
            mapping = params.get("spaces") or {}
            spaces: list[dict[str, Any]] = []
            claimed: dict[str, str] = {}  # space id -> the inspection this job puts in it
            for sel in params["inspections"]:
                insp = _inspection(export, sel["id"])
                sid = mapping.get(insp.id) or by_source.get(insp.id) or f"fly-{insp.id[:8]}"
                owner = source_of.get(sid)
                if owner and owner != insp.id:
                    raise JobError(
                        f"Space {sid} holds another Flyability inspection ({owner}); one space takes one "
                        f"inspection. Import inspection {insp.id} into a space of its own."
                    )
                if claimed.setdefault(sid, insp.id) != insp.id:
                    raise JobError(
                        f"Two inspections ({claimed[sid]} and {insp.id}) would go into space {sid}; "
                        "one space takes one inspection."
                    )
                known = {f.id for f in insp.flights}
                wanted = sel.get("flights")
                flights = [f.id for f in insp.flights if wanted is None or f.id in wanted]
                for fid in wanted or []:
                    if fid not in known:
                        ctx.log(f"The export has no flight {fid} in this inspection; it is skipped.", "warn")
                spaces.append(
                    {
                        "id": sid,
                        "name": insp.name.strip() or f"Inspection {insp.id[:8]}",
                        "inspection": insp.id,
                        "flights": flights,
                    }
                )
                ctx.log(
                    f"Inspection {insp.name or insp.id}: {len(flights)} of {len(insp.flights)} flights, "
                    f"{len(insp.pois)} points of interest, into space {sid}."
                )
            if export.skipped_snapshots:
                ctx.log(f"{export.skipped_snapshots} snapshots name no known flight and are skipped.", "warn")
            return {"generation": export.generation, "skipped": export.skipped_snapshots, "spaces": spaces}

        # -------------------------------------------------------------------------------- clouds
        def clouds(ctx: StepContext) -> dict[str, Any]:
            export = _export(params)
            manifest = _read_manifest(ctx.project)
            todo: list[dict[str, Any]] = []
            # file name -> layer: a name another layer holds goes to a layer only when it is that one
            taken = {
                (layer.get("src") or {}).get("path"): layer.get("id")
                for layer in manifest.get("layers") or []
                if isinstance(layer, dict) and isinstance(layer.get("src"), dict)
            }
            for sp, insp, flights in selection(ctx, export):
                sid = sp["id"]
                order = {f.id: i + 1 for i, f in enumerate(insp.flights)}
                for f in flights:
                    if f.cloud is None:
                        ctx.log(f"{f.name or f.id} has no point cloud in the export.", "warn")
                        continue
                    lid = cap_id(f"{sid}-{f.id[:8]}-cloud")
                    n = order[f.id]
                    todo.append(
                        {
                            "space": sid,
                            "flight": f.id,
                            "src": str(f.cloud),
                            "matrix": _matrix(f.transform),
                            "layer": lid,
                            "name": f"Flight #{n} cloud",
                            "rel": _cloud_rel(taken, sid, _flight_stem(f.name, n), lid, f.id[:8]),
                        }
                    )
                if insp.merged_cloud is not None:
                    lid = cap_id(f"{sid}-merged")
                    todo.append(
                        {
                            "space": sid,
                            "flight": None,
                            "src": str(insp.merged_cloud),
                            "matrix": None,
                            "layer": lid,
                            "name": "Merged cloud",
                            "rel": _cloud_rel(taken, sid, "merged", lid, insp.id[:8]),
                        }
                    )
            if not todo:
                return {"clouds": []}
            pdal = pc.find_pdal()
            if not pdal:
                raise JobError(pc.PDAL_MISSING)
            records: dict[str, dict[str, Any]] = {}
            for i, c in enumerate(todo):
                ctx.check()
                lo, hi = i / len(todo), (i + 1) / len(todo)
                src = Path(c["src"])
                st = src.stat()
                c["bytes"], c["mtimeNs"] = st.st_size, st.st_mtime_ns
                c["points"] = _las_count(ctx, pdal, src)
                sid = c["space"]
                if sid not in records:
                    path = safe_project_path(ctx.project, f"{_imports(sid)}/clouds.json")
                    try:
                        doc = json.loads(path.read_text("utf-8")) if path.is_file() else {}
                    except ValueError:
                        doc = {}
                    records[sid] = doc.get("clouds") if isinstance(doc.get("clouds"), dict) else {}
                was = records[sid].get(c["rel"])
                if ctx.out(c["rel"]).is_file() and was == _cloud_key(c):
                    c["staged"] = None
                    ctx.log(f"{c['name']}: unchanged since the last import, kept as it is.")
                    continue
                c["staged"] = f"clouds/{sid}/{Path(c['rel']).name}"
                staged = ctx.stage(c["staged"])
                ctx.progress(lo, f"{c['name']}: {c['points']:,} points")
                needs_las = c["matrix"] is not None or src.suffix.lower() not in pc.LAS_EXTENSIONS
                record = (pc.las_record_length(src) or pc.DEFAULT_RECORD) if needs_las else None
                pc.check_space(ctx.staging, pc.disk_needed(c["points"], record))
                prepared: Path | None = None
                las, start = src, lo
                try:
                    if needs_las:
                        prepared = ctx.stage("source.las")
                        mid = lo + (hi - lo) * 0.3
                        pc.prepare_las(
                            ctx, pdal, src, prepared, None, c["points"], (lo, mid), matrix=c["matrix"]
                        )
                        las, start = prepared, mid
                    writer = pc.build_copc(ctx, las, staged, c["points"], None, start)
                finally:
                    if prepared is not None:
                        prepared.unlink(missing_ok=True)
                ctx.log(
                    f"{c['name']}: built with {writer}"
                    + (", aligned by its flight's transform." if c["matrix"] else ".")
                )
            return {"clouds": todo}

        # --------------------------------------------------------------------------------- paths
        def paths(ctx: StepContext) -> dict[str, Any]:
            import numpy as np

            from .export import read_trajectory
            from .frames import apply_pose, camera_from_body, three_camera_q, to_scene

            export = _export(params)
            out: list[dict[str, Any]] = []
            for sp, insp, flights in selection(ctx, export):
                sid = sp["id"]
                order = {f.id: i + 1 for i, f in enumerate(insp.flights)}
                for f in flights:
                    ctx.check()
                    if f.trajectory is None:
                        ctx.log(f"{f.name or f.id} has no trajectory in the export.", "warn")
                        continue
                    rows = read_trajectory(f.trajectory)
                    rows = rows[np.isfinite(rows).all(axis=1)]
                    rows = rows[np.linalg.norm(rows[:, 4:8], axis=1) > 1e-6] if len(rows) else rows
                    if not len(rows):
                        ctx.log(f"{f.name or f.id}: the trajectory has no usable sample.", "warn")
                        continue
                    rows = rows[rows[:, 0] >= 0]  # seconds since boot; nothing before it
                    if not len(rows):
                        ctx.log(f"{f.name or f.id}: the trajectory has no usable sample.", "warn")
                        continue
                    t0 = float(rows[0, 0])
                    samples = []
                    for row in rows:
                        pos, q = apply_pose(f.transform, row[1:4], row[4:8])
                        _, cam_q = camera_from_body(pos, q, 0.0)
                        samples.append(
                            {
                                "t": round((float(row[0]) - t0) * 1000, 3),
                                "pos": [round(float(v), 5) for v in to_scene(pos)],
                                "q": [round(v, 7) for v in three_camera_q(cam_q)],
                            }
                        )
                    start_ms = 0
                    if f.datetime_utc is not None:
                        shift = 0.0 if f.phase_start_us is None else t0 - f.phase_start_us / 1e6
                        start_ms = round((f.datetime_utc + shift) * 1000)
                    f8 = f.id[:8]
                    staged = f"poses/{sid}/{f8}.flight.json"
                    atomic_write_json(
                        ctx.stage(staged),
                        {"schema": "aio.flight/1", "startUtcMs": start_ms, "lens": LENS, "samples": samples},
                    )
                    n = order[f.id]
                    out.append(
                        {
                            "space": sid,
                            "flight": f.id,
                            "staged": staged,
                            "rel": f"{_imports(sid)}/poses/{f8}.flight.json",
                            "layer": cap_id(f"{sid}-{f8}-path"),
                            "name": f"Flight #{n} path",
                            "bootStartS": t0,
                            "color": LINE_COLORS[(n - 1) % len(LINE_COLORS)],
                            "samples": len(samples),
                        }
                    )
            return {"paths": out}

        # -------------------------------------------------------------------------------- photos
        def photos(ctx: StepContext) -> dict[str, Any]:
            from .frames import apply_pose, three_camera_q, to_scene

            export = _export(params)
            layers: dict[str, dict[str, Any]] = {}
            for sp, insp, _ in selection(ctx, export):
                sid = sp["id"]
                by_id = {f.id: f for f in insp.flights}
                layer = layers.setdefault(
                    sid, {"space": sid, "layer": cap_id(f"{sid}-photos"), "items": [], "files": []}
                )
                for poi in insp.pois:
                    for s in poi.snapshots:
                        ctx.check()
                        flight = by_id.get(s.flight_id)
                        pose: dict[str, Any] = {}
                        if s.pose_valid:
                            pos, q = apply_pose(
                                flight.transform if flight else None, s.camera_pos, s.camera_q
                            )
                            pose = {
                                "pos": [round(float(v), 5) for v in to_scene(pos)],
                                "q": [round(v, 7) for v in three_camera_q(q)],
                            }
                        taken = _captured_at(flight, s.time_us)
                        for image, pid in (
                            (s.photo, cap_id(s.id)),
                            (s.annotated, cap_id(f"{s.id}-annotated")),
                        ):
                            if image is None or image.suffix.lower() not in PHOTO_SUFFIXES:
                                continue
                            name = f"{pid}{image.suffix.lower()}"
                            staged = f"photos/{sid}/{name}"
                            shutil.copyfile(image, ctx.stage(staged))
                            rel = f"{_imports(sid)}/photos/{name}"
                            layer["files"].append([staged, rel])
                            layer["items"].append(
                                {
                                    "id": pid,
                                    "src": {"path": rel},
                                    **({"takenAt": taken} if taken else {}),
                                    **pose,
                                    "lens": dict(LENS),
                                }
                            )
            return {"photos": list(layers.values())}

        # -------------------------------------------------------------------------------- locate
        def locate(ctx: StepContext) -> dict[str, Any]:
            import numpy as np

            from .frames import apply_pose, cast, to_scene, view_axis

            export = _export(params)
            built = ctx.outputs("clouds")["clouds"]
            out: dict[str, Any] = {}
            invalid = 0
            for sp, insp, flights in selection(ctx, export):
                sid = sp["id"]
                by_id = {f.id: f for f in insp.flights}
                flight_layer = {c["flight"]: c["layer"] for c in built if c["space"] == sid and c["flight"]}
                merged_layer = next(
                    (
                        c["layer"]
                        for c in built
                        if c["space"] == sid and c["flight"] is None and c["src"] == str(insp.merged_cloud)
                    ),
                    None,
                )
                if insp.merged_cloud is not None:
                    pts = _points(ctx, insp.merged_cloud)
                else:
                    parts = [_points(ctx, f.cloud, f.transform) for f in flights if f.cloud is not None]
                    pts = np.concatenate(parts) if parts else np.zeros((0, 3))
                snaps = [s for poi in insp.pois for s in poi.snapshots]
                invalid += sum(1 for s in snaps if not s.pose_valid)
                placed = [s for s in snaps if s.pose_valid]
                origins, dirs = [], []
                for s in placed:
                    f = by_id.get(s.flight_id)
                    pos, q = apply_pose(f.transform if f else None, s.camera_pos, s.camera_q)
                    origins.append(pos)
                    dirs.append(view_axis(q))
                hits = cast(pts, np.array(origins).reshape(-1, 3), np.array(dirs).reshape(-1, 3))
                hit_m: dict[str, float | None] = {}
                scene: dict[str, list[float] | None] = {}
                hit_layer: dict[str, str] = {}
                for s, o, d, h in zip(placed, origins, dirs, hits, strict=True):
                    ok = math.isfinite(float(h))
                    hit_m[s.id] = float(h) if ok else None
                    scene[s.id] = [round(float(v), 5) for v in to_scene(o + h * d)] if ok else None
                    lid = merged_layer or flight_layer.get(s.flight_id)
                    if lid:
                        hit_layer[s.id] = lid
                found = sum(1 for v in hit_m.values() if v is not None)
                ctx.log(
                    f"Space {sid}: {found} of {len(placed)} snapshots meet the cloud, {len(pts):,} points cast into."
                )
                out[insp.id] = {"hit_m": hit_m, "scene_point": scene, "hit_layer": hit_layer}
            return {"spaces": out, "invalid_pose": invalid}

        # ------------------------------------------------------------------------------ findings
        def findings(ctx: StepContext) -> dict[str, Any]:
            from .findings import FindingContext, build_issue, category_classes

            export = _export(params)
            manifest = _read_manifest(ctx.project)
            existing = _read_issues(ctx.project)[1]
            codes = {
                i["id"]: i["code"]
                for i in existing
                if isinstance(i, dict) and isinstance(i.get("id"), str) and isinstance(i.get("code"), str)
            }
            sel = selection(ctx, export)
            cat = _catalogue(copy.deepcopy(manifest), params["catalogueId"], model_id)
            _, class_of = category_classes([p for _, insp, _ in sel for p in insp.pois], cat, model_id)
            located = ctx.outputs("locate")["spaces"]
            now = now_iso()
            imported: list[dict[str, Any]] = []
            skipped = int(ctx.outputs("read").get("skipped") or 0)
            for sp, insp, _ in sel:
                loc = located.get(insp.id, {})
                fctx = FindingContext(
                    hit_layer=dict(loc.get("hit_layer") or {}),
                    hit_m={k: (math.nan if v is None else v) for k, v in (loc.get("hit_m") or {}).items()},
                    scene_point=dict(loc.get("scene_point") or {}),
                    photos_layer=cap_id(f"{sp['id']}-photos"),
                    severity_model_id=model_id,
                    now=now,
                    existing_codes=codes,
                    class_of=class_of,
                    flight_datetime={
                        f.id: f.datetime_utc for f in insp.flights if f.datetime_utc is not None
                    },
                    phase_start_us={
                        f.id: f.phase_start_us for f in insp.flights if f.phase_start_us is not None
                    },
                )
                for poi in insp.pois:
                    issue = build_issue(poi, fctx)
                    if issue is None:
                        skipped += 1
                    else:
                        imported.append(issue)
            atomic_write_json(ctx.stage("issues-imported.json"), {"issues": imported})
            checks = [i["external"]["locationCheck"] for i in imported]
            return {
                "imported": len(imported),
                "skipped": skipped,
                "disagree": checks.count("disagrees"),
                "no_hit": checks.count("no-hit"),
            }

        # ------------------------------------------------------------------------------ register
        def register(ctx: StepContext) -> dict[str, Any]:
            from .findings import category_classes, merge_issues

            export = _export(params)
            spaces = ctx.outputs("read")["spaces"]
            cloud_out = ctx.outputs("clouds")["clouds"]
            path_out = ctx.outputs("paths")["paths"]
            photo_out = ctx.outputs("photos")["photos"]
            moves = [(c["staged"], c["rel"]) for c in cloud_out if c.get("staged")]
            moves += [(p["staged"], p["rel"]) for p in path_out]
            moves += [(a, b) for layer in photo_out for a, b in layer["files"]]
            with manifest_lock(ctx.project):
                commit_files(ctx, moves, announce=False)
                mpath = safe_project_path(ctx.project, "manifest.json")
                manifest = json.loads(mpath.read_text("utf-8"))
                # spaces
                listed = manifest.setdefault("spaces", [])
                have = {s.get("id") for s in listed if isinstance(s, dict)}
                for sp in spaces:
                    if sp["id"] in have:
                        continue  # an existing space keeps its name, frame and source
                    insp = _inspection(export, sp["inspection"])
                    source: dict[str, Any] = {"kind": "flyability", "inspectionId": insp.id}
                    if export.asset_name:
                        source["assetName"] = export.asset_name
                    listed.append(
                        {
                            "id": sp["id"],
                            "name": sp["name"],
                            "crs": dict(LOCAL_CRS),
                            "origin": [0, 0, 0],
                            "source": source,
                        }
                    )
                    have.add(sp["id"])
                # layers
                layers = manifest.setdefault("layers", [])
                index = {layer.get("id"): i for i, layer in enumerate(layers) if isinstance(layer, dict)}
                made: dict[str, list[str]] = {sp["id"]: [] for sp in spaces}

                def put(layer: dict[str, Any], merge_items: bool = False) -> None:
                    lid = layer["id"]
                    made.setdefault(layer["space"], []).append(lid)
                    if lid not in index:
                        index[lid] = len(layers)
                        layers.append(layer)
                        return
                    old = layers[index[lid]]
                    keep = {k: old[k] for k in ("name", "visible", "capture") if k in old}
                    if merge_items:  # photos of another inspection in the same space stay
                        ids = {it["id"] for it in layer["items"]}
                        layer["items"] += [it for it in old.get("items") or [] if it.get("id") not in ids]
                    layers[index[lid]] = {**layer, **keep}

                merged_spaces = {c["space"]: True for c in cloud_out if c["flight"] is None}
                for c in cloud_out:
                    if not c.get("staged") and c["layer"] in index:
                        made.setdefault(c["space"], []).append(c["layer"])
                        continue  # unchanged: the layer stays as it is
                    put(
                        {
                            "kind": "pointcloud",
                            "id": c["layer"],
                            "name": c["name"],
                            # six overlapping flight clouds are too much at first: with a
                            # merged cloud in the space only that one shows
                            "visible": c["flight"] is None or not merged_spaces.get(c["space"]),
                            "src": {"path": c["rel"]},
                            "format": "copc",
                            **({"pointCount": c["points"]} if c["points"] else {}),
                            "space": c["space"],
                        }
                    )
                for p in path_out:
                    put(
                        {
                            "kind": "flightline",
                            "id": p["layer"],
                            "name": p["name"],
                            "visible": True,
                            "src": {"path": p["rel"]},
                            "flight": p["flight"],
                            "bootStartS": p["bootStartS"],
                            "color": p["color"],
                            "space": p["space"],
                        }
                    )
                for ph in photo_out:
                    if ph["items"]:
                        put(
                            {
                                "kind": "photos",
                                "id": ph["layer"],
                                "name": "Finding photos",
                                "visible": True,
                                "items": ph["items"],
                                "space": ph["space"],
                            },
                            merge_items=True,
                        )
                # severity model and class catalogue
                models = manifest.setdefault("severityModels", [])
                if not any(isinstance(m, dict) and m.get("id") == model_id for m in models):
                    models.append(copy.deepcopy(params["severityModel"]))
                cat = _catalogue(manifest, params["catalogueId"], model_id)
                pois = [p for sp in spaces for p in _inspection(export, sp["inspection"]).pois]
                category_classes(pois, cat, model_id)
                # what each cloud was built from, so an unchanged one is kept next time
                for sid in {c["space"] for c in cloud_out}:
                    rpath = safe_project_path(ctx.project, f"{_imports(sid)}/clouds.json")
                    try:
                        doc = json.loads(rpath.read_text("utf-8")) if rpath.is_file() else {}
                    except ValueError:
                        doc = {}
                    recs = doc.get("clouds") if isinstance(doc.get("clouds"), dict) else {}
                    for c in cloud_out:
                        if c["space"] == sid:
                            recs[c["rel"]] = _cloud_key(c)
                    atomic_write_json(rpath, {"schema": CLOUD_RECORD, "clouds": recs}, indent=2)
                shutil.copyfile(mpath, mpath.with_name("manifest.json.bak"))
                atomic_write_json(mpath, manifest, indent=2)
                # issues: every edit and every issue the import does not make are kept
                ipath, current, doc = _read_issues(ctx.project, with_doc=True)
                imported = json.loads(ctx.stage("issues-imported.json").read_text("utf-8"))["issues"]
                _settle_codes(current, imported)
                issues, counts = merge_issues(current, imported)
                # earlier findings of this inspection the export no longer has (never other issues)
                mine = {
                    layer.get("id")
                    for layer in manifest["layers"]
                    if isinstance(layer, dict) and layer.get("space") in made
                }
                fresh = {i["id"] for i in imported}
                counts["kept_missing"] = sum(1 for i in issues if i["id"] not in fresh and _ours(i, mine))
                if ipath.exists():
                    shutil.copyfile(ipath, ipath.with_name("issues.json.bak"))
                atomic_write_json(ipath, {**doc, "schema": ISSUES_SCHEMA, "issues": issues}, indent=2)
            ctx.artifact("issues.json")
            found = ctx.outputs("findings")
            counts.update(
                {
                    "disagree": int(found.get("disagree") or 0),
                    "no_hit": int(found.get("no_hit") or 0),
                    "skipped": int(found.get("skipped") or 0),
                    "invalid_pose": int(ctx.outputs("locate").get("invalid_pose") or 0),
                }
            )
            ctx.log(
                f"Findings: {counts['added']} new, {counts['refreshed']} refreshed, "
                f"{counts['kept_edited']} edited by a person and kept, {counts['kept_missing']} earlier ones kept; "
                f"{counts['disagree']} disagree with the drone's wall distance, {counts['no_hit']} meet no cloud, "
                f"{counts['skipped']} skipped, {counts['invalid_pose']} snapshots without a valid pose."
            )
            seen: list[str] = []
            out_spaces = []
            for sp in spaces:
                if sp["id"] in seen:
                    continue
                seen.append(sp["id"])
                name = next(
                    (s.get("name") for s in manifest["spaces"] if s.get("id") == sp["id"]), sp["name"]
                )
                out_spaces.append(
                    {"id": sp["id"], "name": name, "layers": sorted(set(made.get(sp["id"], [])))}
                )
            return {"spaces": out_spaces, "findings": counts}

        return [
            Step("read", "Read the export", read, weight=0.2),
            Step("clouds", "Convert the point clouds", clouds, weight=10),
            Step("paths", "Write the flight lines", paths, weight=0.5),
            Step("photos", "Copy the finding photos", photos, weight=0.5),
            Step("locate", "Place the findings on the cloud", locate, weight=2),
            Step("findings", "Make the findings", findings, weight=0.3),
            Step("register", "Add everything to the project", register, weight=0.3),
        ]


def _settle_codes(current: list[dict[str, Any]], imported: list[dict[str, Any]]) -> None:
    """Codes against ``issues.json`` as it is now (read under the manifest lock): an issue already
    there keeps its code, and a new one whose code another issue took meanwhile gets the next free
    one. In place."""
    from .findings import _next_code

    now = {
        i["id"]: i["code"] for i in current if isinstance(i.get("id"), str) and isinstance(i.get("code"), str)
    }
    pool = {**{i["id"]: i["code"] for i in imported}, **now}
    for i in imported:
        if i["id"] in now:
            i["code"] = now[i["id"]]
            continue
        if any(code == i["code"] and iid != i["id"] for iid, code in pool.items()):
            i["code"] = _next_code(pool)
            pool[i["id"]] = i["code"]


def _ours(issue: dict[str, Any], layers: set[Any]) -> bool:
    """A Flyability finding with a sighting on one of ``layers`` (this import's space)."""
    ext = issue.get("external")
    return (
        str(issue.get("id", "")).startswith("fly-")
        and isinstance(ext, dict)
        and ext.get("source") == "flyability"
        and any(isinstance(s, dict) and s.get("layer") in layers for s in issue.get("sightings") or [])
    )


def _read_issues(project: Path, with_doc: bool = False):
    """(path, issues, document) of ``issues.json``; an unreadable file stops the job."""
    path = safe_project_path(project, "issues.json")
    doc: dict[str, Any] = {}
    if path.exists():
        try:
            raw = json.loads(path.read_text("utf-8"))
        except ValueError as e:
            raise JobError(f"issues.json cannot be read ({e}); fix or restore it, then import again.") from e
        doc = raw if isinstance(raw, dict) else {}
    issues = [i for i in doc.get("issues") or [] if isinstance(i, dict)]
    return (path, issues, doc) if with_doc else (path, issues)
