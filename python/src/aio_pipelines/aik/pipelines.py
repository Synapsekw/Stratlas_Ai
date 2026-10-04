"""aik.cameras, aik.project and aik.records as resumable jobs."""

from __future__ import annotations

import json
import os
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from pathlib import Path
from typing import Any

from ..params import known_keys, number, numbers, text
from ..runtime import (
    AtomicPath,
    JobError,
    Step,
    StepContext,
    atomic_write_bytes,
    atomic_write_json,
    commit_files,
    commit_tree,
    safe_project_path,
)

# ---------------------------------------------------------------- aik.cameras


class AikCameras:
    name = "aik.cameras"
    title = "Cameras from photos"
    description = "Camera poses from EXIF GPS and DJI gimbal angles, and 2560 px review copies."

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        known_keys(
            params,
            {"photos", "origin", "assetHeight", "sensorWidthMm", "longEdge", "out", "photosOut"},
            self.name,
        )
        out = {
            "photos": text(params, "photos", required=True),
            "origin": numbers(params, "origin", 3),
            "assetHeight": number(params, "assetHeight", None, 0.1, 2000),
            "sensorWidthMm": number(params, "sensorWidthMm", None, 1, 100),
            "longEdge": number(params, "longEdge", 2560, 256, 16384, integer=True),
            "out": text(params, "out", "cameras.json"),
            "photosOut": text(params, "photosOut", "photos"),
        }
        if out["origin"] is not None:
            lat, lon, _ = out["origin"]
            if not (-90 <= lat <= 90 and -180 <= lon <= 180):
                raise JobError("origin must be latitude, longitude, ground altitude.")
        return {k: v for k, v in out.items() if v is not None}

    def inputs(self, params: dict[str, Any]) -> list[str]:
        return [params["photos"]]

    def plan(self, params: dict[str, Any]) -> list[Step]:
        from . import cameras as C

        def scan(ctx: StepContext) -> dict[str, Any]:
            folder = ctx.input(params["photos"])
            if not folder.is_dir():
                raise JobError(f'"{params["photos"]}" is not a folder.')
            files = C.list_photos(folder)
            if not files:
                raise JobError(f"There are no JPEG, TIFF or PNG photos in {folder}.")
            ctx.log(f"Reading metadata of {len(files)} photos in {folder}")
            metas = []
            for i, f in enumerate(files):
                ctx.check()
                try:
                    meta = C.read_meta(f)
                except OSError as e:
                    ctx.log(f"{f.name}: unreadable ({e}), skipped", "warn")
                    meta = None
                metas.append({"index": i, "path": str(f), "meta": meta})
                ctx.progress((i + 1) / len(files), f.name)
            atomic_write_json(ctx.stage("meta.json"), {"root": str(folder), "photos": metas})
            return {"photos": len(files)}

        def poses(ctx: StepContext) -> dict[str, Any]:
            doc = json.loads(ctx.stage("meta.json").read_text("utf-8"))
            root = Path(doc["root"])
            items = doc["photos"]
            located = [it for it in items if it["meta"] and "latitude" in it["meta"]]
            missing = [Path(it["path"]).name for it in items if not (it["meta"] and "latitude" in it["meta"])]
            if missing:
                ctx.log(
                    f"{len(missing)} of {len(items)} photos have no GPS position and are skipped: "
                    + ", ".join(missing[:8])
                    + (" ..." if len(missing) > 8 else ""),
                    "warn",
                )
            if not located:
                raise JobError(
                    f"None of the {len(items)} photos has a GPS position in its EXIF. "
                    "Use the original camera files, not exported review copies."
                )
            origin = params.get("origin")
            estimated = origin is None
            if estimated:
                origin = list(C.estimate_origin([it["meta"] for it in located]))
                ctx.log(
                    "No origin given: using the mean photo position and the lowest photo altitude "
                    f"({origin[0]:.6f}, {origin[1]:.6f}, {origin[2]:.1f} m). Set the asset base for real work.",
                    "warn",
                )
            folders = sorted({Path(it["path"]).parent.relative_to(root).as_posix() for it in items})
            out_dir = os.path.dirname(params["out"].replace("\\", "/"))
            photos = []
            for n, it in enumerate(located):
                ctx.check()
                pid = f"p{it['index'] + 1:03d}"
                src = Path(it["path"])
                file_rel = Path(
                    os.path.relpath(f"{params['photosOut']}/{pid}.jpg", out_dir or ".")
                ).as_posix()
                seq = src.parent.relative_to(root).as_posix() if len(folders) > 1 else "1"
                ps = C.pose(it["meta"], origin, params.get("sensorWidthMm"), params.get("assetHeight"))
                photos.append(C.camera_record(pid, src, root, it["meta"], ps, file_rel, seq))
                ctx.progress((n + 1) / len(located))
            cams = {
                "photos": photos,
                "alignment": {
                    "origin": origin,
                    "origin_estimated": estimated,
                    "model_axes": "X north, Y up above ground datum, Z east",
                    "accuracy": "GPS and gimbal metadata; not survey registration",
                },
            }
            atomic_write_json(ctx.stage("cameras.json"), cams)
            sources = {p["id"]: str(root / p["source_name"]) for p in photos}
            atomic_write_json(ctx.stage("sources.json"), sources)
            ctx.log(f"{len(photos)} camera poses computed")
            return {
                "photos": len(photos),
                "skipped": len(missing),
                "origin": origin,
                "originEstimated": estimated,
            }

        def review(ctx: StepContext) -> dict[str, Any]:
            sources: dict[str, str] = json.loads(ctx.stage("sources.json").read_text("utf-8"))
            todo = [(pid, Path(src), ctx.stage(f"review/{pid}.jpg")) for pid, src in sources.items()]
            done = sum(1 for _, _, d in todo if d.exists())
            if done:
                ctx.log(f"{done} review copies already written, continuing")
            pending = [(pid, s, d) for pid, s, d in todo if not d.exists()]
            long_edge = int(params["longEdge"])

            def one(src: Path, dest: Path) -> None:
                with AtomicPath(dest) as tmp:
                    C.review_copy(src, tmp, long_edge)

            workers = max(1, min(4, (os.cpu_count() or 2) - 1))
            with ThreadPoolExecutor(max_workers=workers) as pool:
                queue = list(pending)
                running: dict[Any, str] = {}
                while queue or running:
                    while queue and len(running) < workers and not ctx.cancel_event.is_set():
                        pid, s, d = queue.pop(0)
                        running[pool.submit(one, s, d)] = pid
                    if not running:
                        break
                    finished, _ = wait(list(running), return_when=FIRST_COMPLETED)
                    for fut in finished:
                        pid = running.pop(fut)
                        fut.result()
                        done += 1
                        ctx.progress(done / len(todo), f"{pid}.jpg")
                    if ctx.cancel_event.is_set():
                        queue.clear()
            ctx.check()
            return {"written": len(pending), "total": len(todo)}

        def commit(ctx: StepContext) -> dict[str, Any]:
            n = commit_tree(ctx, "review", params["photosOut"])
            commit_files(ctx, [("cameras.json", params["out"])])  # the index goes last
            return {"photos": n}

        return [
            Step("scan", "Read photo metadata", scan, weight=1),
            Step("poses", "Compute camera poses", poses, weight=0.3),
            Step("review", "Write review copies", review, weight=6),
            Step("commit", "Write to the project", commit, weight=0.2),
        ]


# ---------------------------------------------------------------- kit job helpers


def _kit_job_params(params: dict[str, Any], pipeline: str, extra: set[str]) -> dict[str, Any]:
    known_keys(params, {"job", "config", *extra}, pipeline)
    if "config" in params and not isinstance(params["config"], dict):
        raise JobError("config must be an object shaped like job.yaml.")
    out: dict[str, Any] = {}
    if "config" in params:
        out["config"] = params["config"]
    else:
        out["job"] = text(params, "job", "job.yaml")
    return out


def _load_kit_job(ctx: StepContext, params: dict[str, Any]):
    from .config import KitJob

    if "config" in params:
        return KitJob(params["config"], ctx.project)
    return KitJob.load(ctx.input(params["job"]))


def _default_out(ctx: StepContext, job, name: str) -> str:
    target = Path(job.p(name))
    try:
        rel = target.resolve().relative_to(ctx.project.resolve())
    except ValueError as e:
        raise JobError(f"{name} would be written outside the project; set out to a project path.") from e
    return rel.as_posix()


# ---------------------------------------------------------------- aik.project


class AikProject:
    name = "aik.project"
    title = "Place findings on the model"
    description = "Back-projects finding boxes and masks onto the GLB as pins or textured patches."

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        out = _kit_job_params(params, self.name, {"grid", "out", "placement"})
        out["grid"] = number(params, "grid", 48, 4, 256, integer=True)
        if params.get("placement") is not None:
            if params["placement"] not in ("point", "patch", "none"):
                raise JobError("placement must be point, patch or none.")
            out["placement"] = params["placement"]
        if params.get("out") is not None:
            out["out"] = text(params, "out")
        return out

    def inputs(self, params: dict[str, Any]) -> list[str]:
        return [params["job"]] if "job" in params else []

    def plan(self, params: dict[str, Any]) -> list[Step]:
        def project(ctx: StepContext) -> dict[str, Any]:
            from . import project as P

            job = _load_kit_job(ctx, params)
            if "placement" in params:
                job.profile["placement"] = params["placement"]
            out = params.get("out") or _default_out(ctx, job, job.inputs.get("surface", "surface.json"))
            safe_project_path(ctx.project, out)
            surface = P.run(
                job,
                grid=int(params["grid"]),
                log=ctx.log,
                check=ctx.check,
                progress=lambda f, m=None: ctx.progress(f, m),
            )
            atomic_write_bytes(ctx.stage("surface.json"), json.dumps(surface).encode("utf-8"))
            return {
                "out": out,
                "patches": len(surface["patches"]),
                "points": len(surface["points"]),
                "unmapped": len(surface["unmapped"]),
            }

        def commit(ctx: StepContext) -> dict[str, Any]:
            commit_files(ctx, [("surface.json", ctx.outputs("project")["out"])])
            return {}

        return [
            Step("project", "Back-project findings", project, weight=5),
            Step("commit", "Write to the project", commit, weight=0.1),
        ]


# ---------------------------------------------------------------- aik.records


class AikRecords:
    name = "aik.records"
    title = "Findings register and stats"
    description = (
        "Builds the canonical findings with heights, zones and sides, the summary stats and the CSV."
    )

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        out = _kit_job_params(params, self.name, {"out", "csv"})
        for k in ("out", "csv"):
            if params.get(k) is not None:
                out[k] = text(params, k)
        return out

    def inputs(self, params: dict[str, Any]) -> list[str]:
        return [params["job"]] if "job" in params else []

    def plan(self, params: dict[str, Any]) -> list[Step]:
        def build(ctx: StepContext) -> dict[str, Any]:
            from . import records as R

            job = _load_kit_job(ctx, params)
            ctx.progress(0.1, "Reading cameras, assessment and masks")
            rec = R.build(job)
            ctx.check()
            out = params.get("out") or _default_out(ctx, job, "records.json")
            csv = params.get("csv") or _default_out(ctx, job, "findings.csv")
            safe_project_path(ctx.project, out)
            safe_project_path(ctx.project, csv)
            atomic_write_json(ctx.stage("records.json"), R.summary(rec))
            atomic_write_bytes(ctx.stage("findings.csv"), R.csv_text(rec).encode("utf-8"))
            s = rec["stats"]
            ctx.log(
                f"{s['photos']} photos, {s['findings']} findings ({s['mapped']} on the model), "
                f"{s['photos_with_findings']} photos with findings"
            )
            return {"out": out, "csv": csv, "stats": json.loads(json.dumps(s, default=str))}

        def commit(ctx: StepContext) -> dict[str, Any]:
            o = ctx.outputs("build")
            commit_files(ctx, [("findings.csv", o["csv"]), ("records.json", o["out"])])
            return {}

        return [
            Step("build", "Build records and stats", build, weight=3),
            Step("commit", "Write to the project", commit, weight=0.1),
        ]
