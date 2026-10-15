"""bentley.import: a BlocksExchange AT export and its photos into the open project.

Parameters as ``BentleyImportParams`` in ``@aio/schema``: ``xml`` (the AT export, read only),
``photos`` (the folder holding its photos, searched with its subfolders, read only) and ``name``
(the photos layer's name; default the XML file's name plus "photos").

What comes in (data-conventions section 35, the same shapes as ``opf.import``, section 21):

- a **processing run** ``photogrammetry/<run>/``: ``run.json`` (``aio.photo-run/1``, status
  ``aligned``, ``settings.bentley``), ``sparse/`` (COLMAP text in the grid frame, cameras as
  ``OPENCV``/``FULL_OPENCV`` with Bentley's intrinsics, no tie points), ``frame.json``,
  ``photos.json`` (the originals, read in place) and ``report/bentley-import.json``;
- a **photos layer** of 2560 px review copies (``photos/<run>/``) placed by the calibrated poses
  (``pos``, ``q``, ``lens`` with the principal point and distortion), its ``capture`` the
  earliest valid ``DateTimeOriginal`` day of the photos in the layer (none when no photo has one).

Photos not found, ambiguous or not aligned are left out and listed. The manifest is written
last, with ``manifest.json.bak``.
"""

from __future__ import annotations

import json
import re
import shutil
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

from .. import __version__
from ..params import known_keys, text
from ..runtime import (
    JobError,
    Step,
    StepContext,
    atomic_write_json,
    commit_files,
    now_iso,
    replace_over,
    safe_project_path,
)

#: Photos named one by one in the job log, at most.
LOG_NAMES = 200


def photo_day(taken: str | None) -> str | None:
    """The day (YYYY-MM-DD) of a block photo's ``DateTimeOriginal``, or None when it is not a valid
    ISO date (an EXIF-style ``2026:03:04 10:00:00`` or a day that does not exist)."""
    day = (taken or "").strip()[:10]
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
        return None
    try:
        date.fromisoformat(day)
    except ValueError:
        return None
    return day


def plan_import(block, frame, manifest: dict[str, Any], matching, name: str, root: Path):
    """The import as data (``plan.json``) and the sparse model, from a parsed block."""
    import numpy as np

    from ..opf import colmap
    from ..opf.geometry import lens_to_colmap
    from .convert import camera_pose, lens_of, lens_record
    from .match import photo_id

    origin = [float(v) for v in (manifest.get("origin") or [0, 0, 0])]
    lenses = {g.index: lens_of(g) for g in block.groups}
    model = colmap.Model()
    for g in block.groups:
        cmodel, params = lens_to_colmap(lenses[g.index])
        model.cameras[g.index + 1] = colmap.Camera(g.index + 1, cmodel, g.width, g.height, params)
    taken: set[str] = set()
    photos: list[dict[str, Any]] = []
    bad_dates = 0
    for p in block.aligned():
        f = matching.found.get(p.id)
        if f is None:
            continue
        pose = camera_pose(p, frame, origin)
        g = block.groups[p.group]
        key = f.relative_to(root).as_posix()  # the photo key: model image name, photos.json key
        rec = {
            "id": photo_id(f.name, taken),
            "name": key,
            "fileName": f.name,
            "file": str(f),
            "size": [g.width, g.height],
            "pos": pose.pos,
            "q": pose.q,
            "lens": lens_record(lenses[p.group]),
            "group": p.group,
        }
        day = photo_day(p.taken)
        if day:
            rec["day"] = day
        elif p.taken:
            bad_dates += 1
        photos.append(rec)
        iid = len(model.images) + 1
        model.images[iid] = colmap.Image(iid, pose.qvec, pose.tvec, p.group + 1, key)
    model.xyz = np.zeros((0, 3))
    ambiguous = set(matching.ambiguous)
    rejected = [
        {"name": matching.names.get(i, i), "reason": "not found in the photos folder"}
        for i in matching.missing
        if i not in ambiguous
    ]
    rejected += [
        {"name": matching.names.get(i, i), "reason": "several photos of this name in the photos folder"}
        for i in matching.ambiguous
    ]
    rejected += [
        {"name": Path(p.image_path.replace("\\", "/")).name or p.id, "reason": "not aligned in the block"}
        for p in block.unaligned()
    ]
    groups = [
        {
            "id": f"photogroup-{g.index + 1}",
            "model": g.name[:120],
            "widthPx": g.width,
            "heightPx": g.height,
            "photos": sum(1 for p in photos if p["group"] == g.index),
            "calibration": lens_to_colmap(lenses[g.index])[0],
        }
        for g in block.groups
    ]
    plan = {
        "name": name,
        "version": block.version,
        "photos": photos,
        "rejected": rejected,
        "groups": groups,
        "badDates": bad_dates,
        "warnings": frame.notes,
        "summary": {
            "photos": len(block.photos),
            "aligned": len(block.aligned()),
            "matched": len(photos),
            "missing": len(matching.missing),
            "unaligned": len(block.unaligned()),
        },
    }
    return plan, model


class BentleyImport:
    name = "bentley.import"
    title = "Bentley import"
    description = (
        "A Bentley iTwin Capture Modeler (ContextCapture) AT export with its photos: "
        "a run and a photos layer placed by the calibrated poses."
    )
    keys = frozenset({"xml", "photos", "name"})

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        known_keys(params, set(self.keys), self.name)
        xml = text(params, "xml", required=True)
        photos = text(params, "photos", required=True)
        assert xml is not None and photos is not None
        if Path(xml).suffix.lower() != ".xml":
            raise JobError(f'"{Path(xml).name}" is not an AT export. Choose the .xml file Bentley exported.')
        out: dict[str, Any] = {"xml": xml, "photos": photos}
        name = text(params, "name")
        if name is not None:
            name = name.strip()
            if not 1 <= len(name) <= 120:
                raise JobError("name must be 1 to 120 characters.")
            out["name"] = name
        return out

    def inputs(self, params: dict[str, Any]) -> list[str]:
        return [params["xml"], params["photos"]]

    def plan(self, params: dict[str, Any]) -> list[Step]:
        def load_plan(ctx: StepContext) -> dict[str, Any]:
            return json.loads(ctx.stage("plan.json").read_text("utf-8"))

        def read(ctx: StepContext) -> dict[str, Any]:
            from ..opf.importer import read_manifest, uniq, write_run_sparse
            from .blocks import read_block
            from .convert import block_frame
            from .match import match_photos

            xml = ctx.input(params["xml"])
            root = ctx.input(params["photos"]).resolve()
            if not root.is_dir():
                raise JobError(f'The photos folder "{params["photos"]}" is not a folder.')
            block = read_block(xml)
            manifest = read_manifest(ctx.project)
            frame = block_frame(block, manifest)
            aligned = block.aligned()
            if not aligned:
                raise JobError(
                    f"{xml.name} has no aligned photos: run the aerotriangulation, then export again."
                )
            ctx.progress(0.2, "Finding the photos")
            matching = match_photos({p.id: p.image_path for p in aligned}, root, ctx.check)
            if not matching.found:
                raise JobError(
                    f"None of the {len(aligned)} aligned photos of {xml.name} were found in {root}. "
                    "Choose the folder that holds them (subfolders are searched)."
                )
            name = params.get("name") or f"{xml.name} photos"
            plan, model = plan_import(block, frame, manifest, matching, name, root)
            runs = ctx.project / "photogrammetry"
            taken = {p.name for p in runs.iterdir()} if runs.is_dir() else set()
            run = uniq(f"bentley-{datetime.now(UTC).strftime('%Y%m%d-%H%M')}", taken)
            plan["root"] = str(root)
            write_run_sparse(ctx.stage("run/sparse/.keep").parent, model, manifest, plan)
            atomic_write_json(ctx.stage("plan.json"), plan, indent=None)
            s = plan["summary"]
            ctx.log(
                f"{xml.name}: {s['photos']} photos, {s['aligned']} aligned, {s['matched']} found, "
                f"{s['missing']} not found, {s['unaligned']} not aligned."
            )
            for r in plan["rejected"][:LOG_NAMES]:
                ctx.log(f"Left out: {r['name']} ({r['reason']}).", "warn")
            if len(plan["rejected"]) > LOG_NAMES:
                ctx.log(f"And {len(plan['rejected']) - LOG_NAMES} more photos left out.", "warn")
            if plan["badDates"]:
                ctx.log(
                    f"{plan['badDates']} photos have a date that could not be read; "
                    "the survey date comes from the others.",
                    "warn",
                )
            for w in plan["warnings"]:
                ctx.log(w, "warn")
            return {"run": run, **s}

        def photos(ctx: StepContext) -> dict[str, Any]:
            from ..aik.cameras import review_copy
            from ..opf.importer import REVIEW_EDGE

            plan = load_plan(ctx)
            failed = []
            todo = plan["photos"]
            for i, p in enumerate(todo):
                ctx.check()
                dest = ctx.stage(f"photos/{p['id']}.jpg")
                if not dest.exists():
                    tmp = dest.with_name(f".{dest.stem}.tmp.jpg")
                    try:
                        review_copy(Path(p["file"]), tmp, REVIEW_EDGE)
                        replace_over(tmp, dest)
                    except Exception as e:  # one unreadable photo is left out, never the import
                        tmp.unlink(missing_ok=True)
                        # name: the photo key, as plan["photos"] and the run's rejected list use it
                        failed.append({"name": p["name"], "reason": f"could not be read: {e}"[:300]})
                        continue
                ctx.progress((i + 1) / max(1, len(todo)), f"Review copies {i + 1} of {len(todo)}")
            atomic_write_json(ctx.stage("photos-failed.json"), failed)
            if failed:
                ctx.log(f"{len(failed)} photos could not be read and are left out.", "warn")
            return {"copies": len(todo) - len(failed), "failed": len(failed)}

        def commit(ctx: StepContext) -> dict[str, Any]:
            return _commit(ctx, load_plan(ctx), params)

        return [
            Step("read", "Read the block and find the photos", read, weight=2),
            Step("photos", "Make review copies of the photos", photos, weight=6),
            Step("commit", "Add the run and the photos layer to the project", commit, weight=0.5),
        ]


def _commit(ctx: StepContext, plan: dict[str, Any], params: dict[str, Any]) -> dict[str, Any]:
    from ..captures import capture_for_date
    from ..opf.importer import SPARSE_FILES, read_manifest

    run = ctx.outputs("read")["run"]
    run_dir = f"photogrammetry/{run}"
    layer_id = f"photos-{run}"
    failed = json.loads(ctx.stage("photos-failed.json").read_text("utf-8"))
    failed_names = {f["name"] for f in failed}

    moves = [(f"run/sparse/{n}", f"{run_dir}/sparse/{n}") for n in SPARSE_FILES]
    items = []
    days = []  # the survey date: the earliest day of the photos actually in the layer
    for p in plan["photos"]:
        if p["name"] in failed_names:
            continue
        if p.get("day"):
            days.append(p["day"])
        rel = f"photos/{run}/{p['id']}.jpg"
        moves.append((f"photos/{p['id']}.jpg", rel))
        items.append({"id": p["id"], "src": {"path": rel}, "pos": p["pos"], "q": p["q"], "lens": p["lens"]})
    if not items:  # nothing written yet: no empty layer, no aligned run
        raise JobError(
            f"None of the {len(plan['photos'])} photos found could be read, so nothing was imported. "
            "Check that the photos folder holds the original JPEG files."
        )

    mpath = safe_project_path(ctx.project, "manifest.json")
    manifest = read_manifest(ctx.project)
    layers = manifest.setdefault("layers", [])
    # a commit that runs again replaces its own layer (the run's own id), never adds a second
    layers[:] = [x for x in layers if not (isinstance(x, dict) and x.get("id") == layer_id)]
    capture = capture_for_date(manifest, min(days)) if days else None
    layer = {
        "kind": "photos",
        "id": layer_id,
        "name": plan["name"],
        "visible": True,
        **({"capture": capture} if capture else {}),
        "items": items,
    }
    rejected = plan["rejected"] + failed
    run_json = {
        "schema": "aio.photo-run/1",
        "id": run,
        "createdAt": now_iso(),
        "updatedAt": now_iso(),
        "status": "aligned",
        "preset": "standard",
        "photos": {
            "source": {"folders": [plan["root"]]},
            "count": plan["summary"]["photos"],
            "registered": len(items),
            "rejected": rejected[:100_000],
        },
        "cameras": [dict(g) for g in plan["groups"]],
        "crs": manifest.get("crs"),
        **({"capture": capture} if capture else {}),
        "settings": {
            "bentley": {"xml": Path(params["xml"]).name, "photos": plan["root"], "version": plan["version"]}
        },
        "stages": [
            {"name": "inspect", "state": "done", "message": "Read from the Bentley block"},
            {
                "name": "sfm",
                "state": "done",
                "message": f"Calibration imported from Bentley (BlocksExchange {plan['version']})",
            },
            {"name": "commit", "state": "done"},
        ],
        "outputs": {
            "layers": [layer_id],
            "tilesets": [],
            "files": [f"{run_dir}/sparse/{n}" for n in SPARSE_FILES],
        },
        "versions": {"pack": __version__, "blocksExchange": plan["version"]},
        "warnings": [w[:500] for w in plan["warnings"]][:1000],
    }
    report = {
        "run": run,
        "src": Path(params["xml"]).name,
        "createdAt": now_iso(),
        "imported": {
            "photos": len(items),
            "missing": plan["summary"]["missing"],
            "unaligned": plan["summary"]["unaligned"],
            "layer": layer_id,
        },
        "skipped": rejected[:100_000],
        "warnings": plan["warnings"],
    }
    atomic_write_json(ctx.stage("run/report/bentley-import.json"), report)
    moves.append(("run/report/bentley-import.json", f"{run_dir}/report/bentley-import.json"))
    commit_files(ctx, moves, announce=False)
    # the run file, then the manifest, go last
    atomic_write_json(ctx.stage("run/run.json"), run_json)
    commit_files(ctx, [("run/run.json", f"{run_dir}/run.json")])
    layers.append(layer)
    shutil.copyfile(mpath, mpath.with_name("manifest.json.bak"))
    atomic_write_json(mpath, manifest, indent=2)
    ctx.artifact("manifest.json")
    ctx.log(f"Run {run}: {len(items)} photos placed in layer {layer_id}.")
    return {
        "run": run,
        "photosLayer": layer_id,
        "photos": len(items),
        "missing": plan["summary"]["missing"],
        "unaligned": plan["summary"]["unaligned"],
        "capture": capture,
        "runFile": f"{run_dir}/run.json",
    }
