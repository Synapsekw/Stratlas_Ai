"""``pointcloud.clean`` (spec docs/plans/2026-10-15-pointcloud-cleanup-design.md, section 4).

- ``mode: noise``: the layer's COPC to a staged LAS, PDAL ``filters.outlier`` (statistical) and
  optionally ``filters.elm`` set class 7 on noise (other classes untouched), then a COPC working
  copy ``edits/pointcloud/<layer>.noise-<job>.copc.laz`` and its record ``.json`` beside it
  (``NoiseRun``). The app writes the record into the layer's recipe.
- ``mode: save`` (Task 12): the recipe applied over every point, streamed, to a new layer.

The original file is never written. A cancelled job leaves only its staging folder.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ..params import known_keys, number, text
from ..pointcloud import (
    COPC_BYTES_PER_POINT,
    DEFAULT_RECORD,
    PDAL_MISSING,
    UNTWINE_TEMP_BYTES_PER_POINT,
    _run,
    check_space,
    find_pdal,
    read_summary,
)
from ..runtime import JobError, Step, StepContext, atomic_write_json, commit_files, safe_project_path
from .lasstream import class_histogram
from .recipe import NOISE_CLASS, validate_recipe

NOISE_DIR = "edits/pointcloud"


def _layer_id(params: dict[str, Any]) -> str:
    lid = text(params, "layerId", required=True)
    assert lid is not None
    if len(lid) > 128 or any(c in lid for c in '/\\:*?"<>|') or ".." in lid:
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
    if not isinstance(raw, dict):
        raise JobError("outlier needs meanK and multiplier.")
    known_keys(raw, {"meanK", "multiplier"}, "outlier")
    return {
        "meanK": number(raw, "meanK", None, 2, 64, integer=True),
        "multiplier": number(raw, "multiplier", None, 0.1, 10),
    }


def _elm(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise JobError("elm needs cell and threshold.")
    known_keys(raw, {"cell", "threshold"}, "elm")
    return {"cell": number(raw, "cell", None, 0.5, 100), "threshold": number(raw, "threshold", None, 0.1, 50)}


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


def _stage_las(ctx: StepContext, pdal: str, src: Path, out: Path, band: tuple[float, float]) -> int:
    """The COPC as a staged LAS; refuses up front when the staging drive is too small. Answers the count."""
    count = int(read_summary(ctx, pdal, src).get("num_points") or 0)
    check_space(
        ctx.staging, count * (2 * DEFAULT_RECORD + UNTWINE_TEMP_BYTES_PER_POINT + COPC_BYTES_PER_POINT)
    )
    pipe = ctx.stage("work/to-las.json")
    atomic_write_json(pipe, {"pipeline": [{"type": "readers.copc", "filename": str(src)}, _las_writer(out)]})
    _run(ctx, [pdal, "pipeline", str(pipe)], "Reading the cloud", band)
    return count


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
        raise JobError("Saving a cleaned copy comes with the next step of this plan.")  # replaced in Task 12
