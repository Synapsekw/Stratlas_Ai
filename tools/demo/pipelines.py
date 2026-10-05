"""Demo project builder, Python half: synthetic rasters to GeoTIFF, then the real pipelines.

    python tools/demo/pipelines.py <spec.json>

Called by ``tools/demo/build-demo.mjs`` with the development pipeline Python (``python/.venv``,
``uv sync`` in ``python/``). The spec names raw rasters the Node half rendered from the synthetic
scene (float32 DSM, RGBA ortho, little-endian, row-major, north up) with their placement in the
project CRS. This script only wraps them as GeoTIFFs and runs ``volumetric.build`` and
``road.build`` exactly as the Jobs panel does, so the stockpile volumes, terrain meshes, ortho
pyramids, ``road.json`` and the road issues are the pipelines' own output. No client data.
"""

from __future__ import annotations

import json
import sys
import threading
import time
from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import from_origin

from aio_pipelines.road.pipeline import RoadBuild
from aio_pipelines.runtime import Job
from aio_pipelines.volumetric.build import VolumetricBuild


def write_dsm(r: dict, epsg: int, out: Path) -> None:
    a = np.fromfile(r["raw"], dtype="<f4").reshape(r["height"], r["width"])
    with rasterio.open(
        out, "w", driver="GTiff", height=a.shape[0], width=a.shape[1], count=1, dtype="float32",
        crs=f"EPSG:{epsg}", transform=from_origin(r["x0"], r["y1"], r["res"], r["res"]), nodata=-10000.0,
        tiled=True, compress="deflate",
    ) as d:
        d.write(np.where(np.isnan(a), -10000.0, a).astype(np.float32), 1)


def write_rgba(r: dict, epsg: int, out: Path) -> None:
    a = np.fromfile(r["raw"], dtype=np.uint8).reshape(r["height"], r["width"], 4)
    with rasterio.open(
        out, "w", driver="GTiff", height=a.shape[0], width=a.shape[1], count=4, dtype="uint8",
        crs=f"EPSG:{epsg}", transform=from_origin(r["x0"], r["y1"], r["res"], r["res"]),
        photometric="RGB", alpha="YES", tiled=True, compress="deflate",
    ) as d:
        d.write(np.moveaxis(a, -1, 0))


def run(job_id: str, pipeline, project: Path, params: dict) -> None:
    t0 = time.time()

    def emit(method: str, msg: dict) -> None:
        if method == "log":
            print(f"  [{time.time() - t0:5.1f} s] {msg.get('step', '')}: {msg['message']}", flush=True)

    Job(job_id, pipeline, project, params, emit, threading.Event()).run()
    state = json.loads((project / "jobs" / job_id / "job.json").read_text("utf-8"))
    if state.get("status") != "done":
        raise SystemExit(f"{pipeline.name} ended {state.get('status')}: {state.get('error', '')}")


def main() -> None:
    spec = json.loads(Path(sys.argv[1]).read_text("utf-8"))
    work = Path(spec["work"])
    epsg = spec["epsg"]
    v = spec.get("volumetric")
    if v:
        epochs = []
        for e in v["epochs"]:
            dsm = work / f"yard-{e['id']}-dsm.tif"
            ortho = work / f"yard-{e['id']}-ortho.tif"
            write_dsm(e["dsm"], epsg, dsm)
            write_rgba(e["ortho"], epsg, ortho)
            epochs.append({"id": e["id"], "date": e["date"], "dsm": str(dsm), "ortho": str(ortho)})
        print("volumetric.build", flush=True)
        run("demo-volumes", VolumetricBuild(), Path(v["project"]), {"config": {"epochs": epochs, "title": v["title"]}})
    r = spec.get("road")
    if r:
        ortho = work / "road-ortho.tif"
        write_rgba(r["ortho"], epsg, ortho)
        params = {
            "centreline": r["centreline"],
            "ortho": [str(ortho)],
            "defects": r["defects"],
            "units": "chainage",
            "lanes": r["lanes"],
            "laneWidth": r["laneWidth"],
            "name": r["name"],
        }
        print("road.build", flush=True)
        run("demo-road", RoadBuild(), Path(r["project"]), params)


if __name__ == "__main__":
    main()
