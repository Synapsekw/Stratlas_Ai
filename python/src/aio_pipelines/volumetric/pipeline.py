"""volumetric.process: DSM GeoTIFFs -> piles, bases and volumes (piles.json), resumable per survey date."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from ..params import known_keys, text
from ..runtime import JobError, Step, StepContext, atomic_write_json, commit_files

EPOCH_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,15}$")


def _check_config(cfg: Any) -> dict[str, Any]:
    if not isinstance(cfg, dict):
        raise JobError("The volumetric job must be an object with grid and epochs.")
    g = cfg.get("grid")
    if not isinstance(g, dict) or not all(
        isinstance(g.get(k), int | float) for k in ("x0", "y0", "x1", "y1", "dsm_res")
    ):
        raise JobError("grid needs x0, y0, x1, y1 and dsm_res (metres, in the DSM's CRS).")
    if g["x1"] <= g["x0"] or g["y1"] <= g["y0"] or g["dsm_res"] <= 0:
        raise JobError("grid bounds must run from x0, y0 (bottom left) to x1, y1 (top right).")
    cells = (g["x1"] - g["x0"]) / g["dsm_res"] * (g["y1"] - g["y0"]) / g["dsm_res"]
    if cells > 400e6:
        raise JobError("The grid is larger than 400 million cells; use a coarser dsm_res or a smaller area.")
    eps = cfg.get("epochs")
    if not isinstance(eps, list) or not 1 <= len(eps) <= 2:
        raise JobError("epochs must list one or two survey dates.")
    for e in eps:
        if not isinstance(e, dict) or not isinstance(e.get("id"), str) or not EPOCH_ID.match(e["id"]):
            raise JobError("Each epoch needs a short lower-case id such as e1.")
        if not isinstance(e.get("dsm"), str):
            raise JobError(f"Epoch {e['id']} needs a dsm path.")
    if len({e["id"] for e in eps}) != len(eps):
        raise JobError("Epoch ids must differ.")
    return cfg


class VolumetricProcess:
    name = "volumetric.process"
    title = "Stockpile volumes"
    description = (
        "Detects piles on DSM GeoTIFFs, fits four bases and computes volumes and change between dates."
    )

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        known_keys(params, {"job", "config", "out"}, self.name)
        out: dict[str, Any] = {"out": text(params, "out", "piles.json")}
        if "config" in params:
            out["config"] = _check_config(params["config"])
        else:
            out["job"] = text(params, "job", "job.json")
        return out

    def inputs(self, params: dict[str, Any]) -> list[str]:
        if "config" in params:
            return [e["dsm"] for e in params["config"]["epochs"]]
        return [params["job"]]

    def _config(self, ctx: StepContext) -> tuple[dict[str, Any], Path]:
        if "config" in ctx.params:
            return ctx.params["config"], ctx.project
        p = ctx.input(ctx.params["job"])
        try:
            cfg = json.loads(p.read_text("utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            raise JobError(f"Could not read the volumetric job {p.name}: {e}") from e
        return _check_config(cfg), p.parent

    def plan(self, params: dict[str, Any]) -> list[Step]:
        epochs = params["config"]["epochs"] if "config" in params else None
        # With a job file the epochs are only known once it is read; plan for two dates and skip a missing one.
        ids = [e["id"] for e in epochs] if epochs else ["epoch-1", "epoch-2"]

        def resample(i: int):
            def run(ctx: StepContext) -> dict[str, Any]:
                from .grid import resample_dsm

                cfg, base = self._config(ctx)
                if i >= len(cfg["epochs"]):
                    return {"skipped": True}
                e = cfg["epochs"][i]
                src = Path(e["dsm"])
                src = src if src.is_absolute() else base / src
                if not src.exists():
                    raise JobError(f"The DSM for {e.get('label', e['id'])} was not found: {src}")
                ctx.log(f"Resampling {src.name} to {cfg['grid']['dsm_res']} m cells")
                H, W = resample_dsm(
                    src, cfg["grid"], ctx.stage(f"work/dsm_{e['id']}.npy"), ctx.check, ctx.progress
                )
                return {"epoch": e["id"], "rows": H, "cols": W}

            return run

        def process(ctx: StepContext) -> dict[str, Any]:
            import numpy as np

            from .process import process as run_process

            cfg, _ = self._config(ctx)
            Z10 = {
                e["id"]: np.load(ctx.stage(f"work/dsm_{e['id']}.npy"), mmap_mode="r") for e in cfg["epochs"]
            }
            Z10 = {k: np.asarray(v, dtype=np.float32) for k, v in Z10.items()}
            res = run_process(cfg, Z10, log=ctx.log, check=ctx.check, progress=ctx.progress)
            atomic_write_json(ctx.stage("piles.json"), res)
            return {"piles": len(res["piles"])}

        def commit(ctx: StepContext) -> dict[str, Any]:
            commit_files(ctx, [("piles.json", params["out"])])
            return {}

        steps = [
            Step(f"resample-{i + 1}", f"Resample survey {eid}", resample(i), weight=3)
            for i, eid in enumerate(ids)
        ]
        return [
            *steps,
            Step("process", "Detect piles and compute volumes", process, weight=6),
            Step("commit", "Write to the project", commit, weight=0.1),
        ]
