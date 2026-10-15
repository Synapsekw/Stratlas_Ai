"""``pointcloud.clean`` (spec docs/plans/2026-10-15-pointcloud-cleanup-design.md, section 4).

- ``mode: noise``: the layer's COPC to a staged LAS, PDAL ``filters.outlier`` (statistical) and
  optionally ``filters.elm`` set class 7 on noise (other classes untouched), then a COPC working
  copy ``edits/pointcloud/<layer>.noise-<job>.copc.laz`` and its record ``.json`` beside it
  (``NoiseRun``). The app writes the record into the layer's recipe.
- ``mode: save``: the recipe applied over every point (of the noise copy when the recipe has one),
  streamed in chunks over a staged LAS, written as a new COPC ``clouds/<id>.copc.laz`` and added to
  the manifest as a derived layer ``<name> (cleaned)``; the original layer is hidden.

The original file is never written. A cancelled job leaves only its staging folder.
"""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from typing import Any

import numpy as np

from ..params import known_keys, number, text
from ..pointcloud import (
    COPC_BYTES_PER_POINT,
    DEFAULT_RECORD,
    PDAL_MISSING,
    UNTWINE_TEMP_BYTES_PER_POINT,
    _run,
    check_space,
    find_pdal,
    las_record_length,
    read_summary,
)
from ..runtime import JobError, Step, StepContext, atomic_write_json, commit_files, safe_project_path
from .evaluate import evaluate, kept_for_save
from .lasstream import class_histogram, filter_las
from .recipe import NOISE_CLASS, validate_recipe

NOISE_DIR = "edits/pointcloud"
# the spec's noise defaults; a missing setting takes these, a missing elm is off
OUTLIER_DEFAULTS = {"meanK": 8, "multiplier": 2.0}
ELM_DEFAULTS = {"cell": 10.0, "threshold": 1.0}
# the layer ids main accepts for cleanup files (SAFE_ID in apps/desktop/src/main/pointcloudCleanup.ts)
SAFE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._ -]{0,127}")


def _layer_id(params: dict[str, Any]) -> str:
    lid = params.get("layerId")
    if not isinstance(lid, str) or not SAFE_ID.fullmatch(lid) or ".." in lid:
        raise JobError("layerId must be a layer id.")
    return lid


def _src(params: dict[str, Any]) -> str:
    src = text(params, "src", required=True)
    assert src is not None
    safe_project_path(Path("."), src)  # refuses absolute paths and ".." with a sentence
    if not src.lower().endswith(".copc.laz"):
        raise JobError("src must be the layer's COPC file.")
    return src.replace("\\", "/")


def _outlier(raw: Any) -> dict[str, Any]:
    if raw is None:
        return dict(OUTLIER_DEFAULTS)
    if not isinstance(raw, dict):
        raise JobError("outlier needs meanK and multiplier.")
    known_keys(raw, {"meanK", "multiplier"}, "outlier")
    d = OUTLIER_DEFAULTS
    return {
        "meanK": number(raw, "meanK", d["meanK"], 2, 64, integer=True),
        "multiplier": number(raw, "multiplier", d["multiplier"], 0.1, 10),
    }


def _elm(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise JobError("elm needs cell and threshold.")
    known_keys(raw, {"cell", "threshold"}, "elm")
    d = ELM_DEFAULTS
    return {
        "cell": number(raw, "cell", d["cell"], 0.5, 100),
        "threshold": number(raw, "threshold", d["threshold"], 0.1, 50),
    }


def _manifest(project: Path) -> tuple[Path, dict[str, Any]]:
    path = safe_project_path(project, "manifest.json")
    return path, json.loads(path.read_text("utf-8"))


def _cloud_layer(project: Path, layer_id: str, src: str) -> dict[str, Any]:
    _, manifest = _manifest(project)
    layer = next((x for x in manifest.get("layers") or [] if x.get("id") == layer_id), None)
    if layer is None:
        raise JobError(f'The layer "{layer_id}" is not in the project any more.')
    if layer.get("kind") != "pointcloud" or layer.get("format") != "copc":
        raise JobError(
            f'"{layer.get("name") or layer_id}" is not a COPC point cloud, so it cannot be cleaned up.'
        )
    if (layer.get("src") or {}).get("path") != src:
        raise JobError("The layer's file changed since the job started. Start it again.")
    return layer


def _pdal() -> str:
    pdal = find_pdal()
    if not pdal:
        raise JobError(PDAL_MISSING)
    return pdal


def _las_writer(path: Path) -> dict[str, Any]:
    # forward the header (point format, scale, offset, CRS) and keep every extra dimension
    return {
        "type": "writers.las",
        "filename": str(path),
        "minor_version": 4,
        "forward": "all",
        "extra_dims": "all",
    }


def _check_memory(count: int) -> None:
    """PDAL's outlier filters hold the whole cloud: refuse up front, as write_copc's PDAL fallback does."""
    from ..photo import cloud_out, native

    budget = native.memory_budget()
    if count * cloud_out.PDAL_COPC_BYTES_PER_POINT > budget:
        raise JobError(
            f"The point cloud has {count:,} points, more than PDAL can search for noise within the "
            f"memory budget ({budget / 1e9:.1f} GB). Raise the memory limit in Settings or crop the cloud first."
        )


def _check_cleanup_space(ctx: StepContext, count: int, record: int) -> None:
    """Two LAS copies of ``record`` bytes a point, untwine's temp and the COPC: refuse up front when the
    staging drive is too small."""
    needed = count * (2 * record + UNTWINE_TEMP_BYTES_PER_POINT + COPC_BYTES_PER_POINT)
    check_space(ctx.staging, needed, what="Cleaning up")


def _stage_las(ctx: StepContext, pdal: str, src: Path, out: Path, band: tuple[float, float]) -> int:
    """The COPC as a staged LAS; refuses up front when the cloud is too big for the memory budget or the
    staging drive is too small. Answers the count."""
    count = int(read_summary(ctx, pdal, src).get("num_points") or 0)
    _check_memory(count)
    # the writer forwards the source's format and extra dimensions: the source's record length
    _check_cleanup_space(ctx, count, las_record_length(src) or DEFAULT_RECORD)
    pipe = ctx.stage("work/to-las.json")
    atomic_write_json(pipe, {"pipeline": [{"type": "readers.copc", "filename": str(src)}, _las_writer(out)]})
    _run(ctx, [pdal, "pipeline", str(pipe)], "Reading the cloud", band)
    return count


#: bytes of each LAS point format's fixed fields (anything beyond is extra bytes)
FORMAT_RECORD = {0: 20, 1: 28, 2: 26, 3: 34, 4: 57, 5: 63, 6: 30, 7: 36, 8: 38, 9: 59, 10: 67}


def _point_format(src: Path) -> int | None:
    try:
        with open(src, "rb") as f:
            head = f.read(105)
    except OSError:
        return None
    if len(head) < 105:
        return None
    return head[104] & 0x3F  # the top bits flag compression (LAZ, COPC)


def filter_format(src: Path) -> int:
    """The LAS 1.4 point format the streaming filter reads that keeps what ``src`` holds: 8 for a
    source with near infrared, 7 for colour without it, else 6 (unreadable: 7, as before)."""
    pdrf = _point_format(src)
    if pdrf is None:
        return 7
    if pdrf in (8, 10):
        return 8
    return 7 if pdrf in (2, 3, 5, 7) else 6


def staged_record_length(src: Path, extra_dims: bool) -> int:
    """Bytes a point of the LAS ``stage_plain_las`` writes from ``src``: the staged format's fields,
    plus the source's extra bytes when they are kept."""
    record = FORMAT_RECORD[filter_format(src)]
    pdrf, length = _point_format(src), las_record_length(src)
    if extra_dims and pdrf in FORMAT_RECORD and length:
        record += max(0, length - FORMAT_RECORD[pdrf])
    return record


def stage_plain_las(
    ctx: StepContext,
    pdal: str,
    src: Path,
    out: Path,
    what: str,
    band: tuple[float, float] = (0.0, 0.0),
    extra_dims: bool = False,
) -> None:
    """``src`` (any cloud PDAL reads) as an uncompressed LAS 1.4 of the point format
    ``filter_format`` picks, the input ``filter_las`` needs. Streams in PDAL, so it holds no cloud."""
    writer: dict[str, Any] = {
        "type": "writers.las",
        "filename": str(out),
        "minor_version": 4,
        "dataformat_id": filter_format(src),
        "forward": "all",
    }
    if extra_dims:
        writer["extra_dims"] = "all"
    pipe = ctx.stage(f"work/{out.stem}.json")
    atomic_write_json(pipe, {"pipeline": [str(src), writer]})
    _run(ctx, [pdal, "pipeline", str(pipe)], what, band)


def _save_rule(recipe: dict[str, Any]):
    def rule(xyz: np.ndarray, cls: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        state, new_cls = evaluate(recipe, xyz, cls)
        return kept_for_save(state), new_cls

    return rule


def cleaned_las(ctx: StepContext, cleanup: dict[str, Any], layer_src: Path, pdal: str) -> Any:
    """The cloud with the cleanup recipe applied, read whole (``survey.export``).

    PDAL stages the cloud (the noise run's working copy when the recipe has one) as LAS 1.4 in the
    format ``filter_format`` picks, whatever format the source file has, since the streaming filter
    reads those formats only; the filter keeps what a saved copy would keep and writes set-class
    selections with their class."""
    from ..change.las import read_las

    noise = cleanup.get("noise")
    # the noise run's working copy carries the noise marks the recipe hides
    src = ctx.input(noise["path"]) if noise else layer_src
    plain = ctx.stage("work/cloud-clean-src.las")
    stage_plain_las(ctx, pdal, src, plain, "Read the point cloud")
    kept = ctx.stage("work/cloud-cleaned.las")
    res = filter_las(plain, kept, _save_rule(cleanup), check=ctx.check)
    if not res["points_out"]:
        raise JobError("The cleanup removes every point of this cloud, so there is nothing to export.")
    ctx.log(f"Cleanup: {res['points_out']:,} of {res['points_in']:,} points kept.")
    return read_las(kept)


def _write_copc(ctx: StepContext, las: Path, out: Path, count: int, band: tuple[float, float]) -> str:
    from ..photo import cloud_out, native

    work = ctx.stage("copc-work")
    writer = cloud_out.write_copc(ctx, las, out, count, None, work, native.memory_budget(), progress=band)
    las.unlink(missing_ok=True)  # as big as the cloud: never keep it
    return writer


class PointcloudClean:
    name = "pointcloud.clean"
    title = "Clean up a point cloud"
    description = (
        "Marks noise with PDAL outlier filters, or writes a cleaned copy of a COPC cloud as a new layer."
    )

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        mode = params.get("mode")
        if mode == "noise":
            known_keys(params, {"mode", "layerId", "src", "outlier", "elm"}, self.name)
            out: dict[str, Any] = {
                "mode": "noise",
                "layerId": _layer_id(params),
                "src": _src(params),
                "outlier": _outlier(params.get("outlier")),
            }
            if params.get("elm") is not None:
                out["elm"] = _elm(params["elm"])
            return out
        if mode == "save":
            known_keys(params, {"mode", "layerId", "src", "recipe", "name"}, self.name)
            lid = _layer_id(params)
            name = (text(params, "name", required=True) or "").strip()
            if len(name) > 120:
                raise JobError("The name of the cleaned copy is at most 120 characters.")
            return {
                "mode": "save",
                "layerId": lid,
                "src": _src(params),
                "recipe": validate_recipe(params.get("recipe"), lid),
                "name": name,
            }
        raise JobError("mode must be noise or save.")

    def inputs(self, params: dict[str, Any]) -> list[str]:
        noise = (params.get("recipe") or {}).get("noise")
        return [params["src"], *([noise["path"]] if noise else [])]

    def plan(self, params: dict[str, Any]) -> list[Step]:
        return self._noise(params) if params["mode"] == "noise" else self._save(params)

    def _noise(self, params: dict[str, Any]) -> list[Step]:
        lid = params["layerId"]

        def stage(ctx: StepContext) -> dict[str, Any]:
            _cloud_layer(ctx.project, lid, params["src"])
            pdal = _pdal()
            src_las = ctx.stage("source.las")
            count = _stage_las(ctx, pdal, ctx.input(params["src"]), src_las, (0.02, 0.25))
            before = class_histogram(src_las)
            ctx.log(f"{count:,} points, {int(before[NOISE_CLASS]):,} already marked as noise.")
            return {"points": count, "before7": int(before[NOISE_CLASS])}

        def mark(ctx: StepContext) -> dict[str, Any]:
            pdal = _pdal()
            src_las, marked = ctx.stage("source.las"), ctx.stage("marked.las")
            o = params["outlier"]
            stages: list[Any] = [
                {"type": "readers.las", "filename": str(src_las)},
                {
                    "type": "filters.outlier",
                    "method": "statistical",
                    "mean_k": o["meanK"],
                    "multiplier": o["multiplier"],
                },
            ]
            if "elm" in params:
                e = params["elm"]
                stages.append({"type": "filters.elm", "cell": e["cell"], "threshold": e["threshold"]})
            stages.append(_las_writer(marked))
            pipe = ctx.stage("work/mark.json")
            atomic_write_json(pipe, {"pipeline": stages})
            _run(ctx, [pdal, "pipeline", str(pipe)], "Finding noise", (0.25, 0.6))
            after = class_histogram(marked)
            src_las.unlink(missing_ok=True)
            n = max(0, int(after[NOISE_CLASS]) - int(ctx.outputs("stage").get("before7") or 0))
            ctx.log(f"Marked {n:,} points as noise.")
            return {"marked": n, "total": int(after.sum())}

        def write(ctx: StepContext) -> dict[str, Any]:
            total = int(ctx.outputs("mark").get("total") or 0)
            writer = _write_copc(
                ctx, ctx.stage("marked.las"), ctx.stage("noise.copc.laz"), total, (0.6, 0.95)
            )
            return {"writer": writer}

        def commit(ctx: StepContext) -> dict[str, Any]:
            run_id = ctx.job.job_id
            rel = f"{NOISE_DIR}/{lid}.noise-{run_id}.copc.laz"
            m = ctx.outputs("mark")
            record = {
                "path": rel,
                "params": {
                    "outlier": params["outlier"],
                    **({"elm": params["elm"]} if "elm" in params else {}),
                },
                "marked": int(m["marked"]),
                "total": int(m["total"]),
                "runId": run_id,
            }
            atomic_write_json(ctx.stage("noise.json"), record)
            commit_files(
                ctx, [("noise.copc.laz", rel), ("noise.json", f"{NOISE_DIR}/{lid}.noise-{run_id}.json")]
            )
            return record

        return [
            Step("stage", "Read the cloud", stage, weight=3),
            Step("mark", "Find noise", mark, weight=4),
            Step("write", "Build the working copy", write, weight=4),
            Step("commit", "Save the result", commit, weight=0.2),
        ]

    def _save(self, params: dict[str, Any]) -> list[Step]:
        lid, recipe = params["layerId"], params["recipe"]
        noise = recipe.get("noise")

        def stage(ctx: StepContext) -> dict[str, Any]:
            _cloud_layer(ctx.project, lid, params["src"])
            pdal = _pdal()
            src = ctx.input(noise["path"] if noise else params["src"])
            count = int(read_summary(ctx, pdal, src).get("num_points") or 0)
            # PDAL and the filter both stream (2M-point chunks): only the disk can run short here;
            # write_copc checks the memory budget itself
            _check_cleanup_space(ctx, count, staged_record_length(src, extra_dims=True))
            stage_plain_las(
                ctx, pdal, src, ctx.stage("source.las"), "Reading the cloud", (0.02, 0.25), extra_dims=True
            )
            return {"points": count}

        def apply(ctx: StepContext) -> dict[str, Any]:
            src_las, out = ctx.stage("source.las"), ctx.stage("cleaned.las")
            counts = filter_las(
                src_las,
                out,
                _save_rule(recipe),
                check=ctx.check,
                progress=lambda f: ctx.progress(0.25 + 0.3 * f, "Applying the cleanup"),
            )
            src_las.unlink(missing_ok=True)
            if counts["points_out"] == 0:
                out.unlink(missing_ok=True)
                raise JobError(
                    "The cleanup removes every point of this cloud, so there is nothing left to save. "
                    "Undo a step or show a class again, then save."
                )
            ctx.log(f"Kept {counts['points_out']:,} of {counts['points_in']:,} points.")
            return counts

        def write(ctx: StepContext) -> dict[str, Any]:
            n = int(ctx.outputs("apply")["points_out"])
            las, copc = ctx.stage("cleaned.las"), ctx.stage("cloud.copc.laz")
            return {"writer": _write_copc(ctx, las, copc, n, (0.55, 0.95))}

        def target(ctx: StepContext, layers: list[dict[str, Any]]) -> tuple[str, str]:
            """The new layer's id and file: free as an id, as any layer's file and on disk. Kept in
            the staging folder, so a job resumed after its file moved in reuses it."""
            chosen = ctx.stage("target.json")
            if chosen.is_file():
                t = json.loads(chosen.read_text("utf-8"))
                return str(t["id"]), str(t["path"])
            ids = {str(x.get("id")) for x in layers}
            paths = {str((x.get("src") or {}).get("path") or "").replace("\\", "/").lower() for x in layers}
            new_id, n = f"{lid}-cleaned", 2
            while True:
                rel = f"clouds/{new_id}.copc.laz"
                if new_id not in ids and rel.lower() not in paths and not ctx.out(rel).exists():
                    break
                new_id, n = f"{lid}-cleaned-{n}", n + 1
            atomic_write_json(chosen, {"id": new_id, "path": rel})
            return new_id, rel

        def register(ctx: StepContext) -> dict[str, Any]:
            _, manifest = _manifest(ctx.project)
            layers = manifest.get("layers") or []
            points = int(ctx.outputs("apply")["points_out"])
            run_id = ctx.job.job_id
            existing = next((x for x in layers if (x.get("derived") or {}).get("runId") == run_id), None)
            if existing is not None:  # a resumed job that already registered
                return {"layer": existing["id"], "path": existing["src"]["path"], "points": points}
            if not any(x.get("id") == lid for x in layers):
                raise JobError(f'The layer "{lid}" is not in the project any more.')
            new_id, rel = target(ctx, layers)
            commit_files(ctx, [("cloud.copc.laz", rel)])
            # the files first, then the manifest read, changed and written at once (as
            # PointcloudToCopc.register), so the window for a concurrent manifest write is minimal
            mpath, manifest = _manifest(ctx.project)
            layers = manifest.setdefault("layers", [])
            source = next((x for x in layers if x.get("id") == lid), None)
            if source is None:
                raise JobError(f'The layer "{lid}" is not in the project any more.')
            layers.append(
                {
                    "kind": "pointcloud",
                    "id": new_id,
                    "name": f"{params['name']} (cleaned)",
                    "visible": True,
                    **({"capture": source["capture"]} if source.get("capture") else {}),
                    "src": {"path": rel},
                    "format": "copc",
                    "pointCount": points,
                    "derived": {"kind": "cleanup", "source": [lid], "runId": run_id},
                }
            )
            source["visible"] = False  # the original stays, hidden; its file is untouched
            # the manifest last, with the one before kept beside it (as PointcloudToCopc.register)
            shutil.copyfile(mpath, mpath.with_name("manifest.json.bak"))
            atomic_write_json(mpath, manifest, indent=2)
            ctx.log(f"Added layer {new_id} ({rel}).")
            return {"layer": new_id, "path": rel, "points": points}

        return [
            Step("stage", "Read the cloud", stage, weight=3),
            Step("apply", "Apply the cleanup", apply, weight=3),
            Step("write", "Build the cleaned copy", write, weight=4),
            Step("register", "Add the layer to the project", register, weight=0.5),
        ]
