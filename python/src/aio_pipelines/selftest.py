"""system.selftest: checks the pack's libraries load, then ticks for a while (cancel and resume demo)."""

from __future__ import annotations

import importlib
import time
from typing import Any

from .params import known_keys, number
from .runtime import Step, StepContext, atomic_write_json, commit_files

LIBRARIES = [
    "numpy",
    "scipy",
    "PIL",
    "yaml",
    "skimage",
    "rasterio",
    "trimesh",
    "rtree",
    "shapely",
    "shapefile",
]


class SelfTest:
    name = "system.selftest"
    title = "Check the pipeline pack"
    description = "Loads every library the pipelines need and writes a short report to the job folder."

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        known_keys(params, {"seconds"}, self.name)
        return {"seconds": number(params, "seconds", 0, 0, 600)}

    def plan(self, params: dict[str, Any]) -> list[Step]:
        def libraries(ctx: StepContext) -> dict[str, Any]:
            found: dict[str, str] = {}
            for i, name in enumerate(LIBRARIES):
                ctx.check()
                mod = importlib.import_module(name)
                found[name] = str(getattr(mod, "__version__", "?"))
                ctx.progress((i + 1) / len(LIBRARIES), f"{name} {found[name]}")
            ctx.log("Libraries: " + ", ".join(f"{k} {v}" for k, v in found.items()))
            return {"libraries": found}

        def wait(ctx: StepContext) -> dict[str, Any]:
            total = float(params["seconds"])
            t0 = time.monotonic()
            while (elapsed := time.monotonic() - t0) < total:
                ctx.check()
                ctx.progress(elapsed / total, f"{int(total - elapsed)} s left")
                time.sleep(0.05)
            return {"seconds": total}

        def report(ctx: StepContext) -> dict[str, Any]:
            atomic_write_json(
                ctx.stage("selftest.json"), {"libraries": ctx.outputs("libraries").get("libraries")}
            )
            commit_files(ctx, [("selftest.json", f"jobs/{ctx.job.job_id}/selftest.json")])
            return {}

        return [
            Step("libraries", "Load libraries", libraries),
            Step("wait", "Wait", wait, weight=max(0.1, float(params["seconds"]))),
            Step("report", "Write the report", report, weight=0.1),
        ]
