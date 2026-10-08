"""pointcloud.to_copc: LAS, LAZ or E57 to a COPC file in the project CRS, with PDAL.

PDAL runs as its command-line tool (``pdal``), found in this order: the ``AIO_PDAL`` environment
variable, ``tools/pdal`` inside the pipeline pack, then the PATH. The pack's PDAL is conda-forge's
``libpdal-core`` build (``tools/pipeline-pack/pdal.mjs``): ``Library/bin/pdal.exe`` on Windows,
``bin/pdal`` on macOS, with its PROJ and GDAL data in ``share/`` beside ``bin/``; ``pdal_env``
points PDAL at that data wherever the pack was installed, and keeps PROJ off the network. The cloud is reprojected to
the project CRS when the source declares its own; a source without a CRS is taken as already in
the project CRS. The layer is added to the project manifest last (data-conventions section 4:
``format: "copc"``, project CRS).
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from .params import known_keys, number, numbers, text
from .runtime import JobError, Step, StepContext, atomic_write_json, commit_files, safe_project_path

PDAL_MISSING = (
    "PDAL is not available: the pipeline pack has no tools/pdal and none is on the PATH. "
    "Install the full pipeline pack, or set AIO_PDAL to pdal.exe."
)
CLOUD_EXTENSIONS = {".las", ".laz", ".e57", ".ply"}


def find_pdal() -> str | None:
    env = os.environ.get("AIO_PDAL")
    if env and Path(env).is_file():
        return env
    exe = "pdal.exe" if os.name == "nt" else "pdal"
    pack = Path(sys.prefix).parent / "tools" / "pdal"
    for cand in (pack / "Library" / "bin" / exe, pack / "bin" / exe):
        if cand.is_file():
            return str(cand)
    return shutil.which("pdal")


def pdal_env(exe: str) -> dict[str, str]:
    """The environment PDAL runs in: this process's, plus the PROJ and GDAL data of a conda-style
    PDAL (``<exe>/../../share/proj``, as the pack's is; conda's activation scripts are never run)
    and, on Windows, its folder first on the PATH. A PDAL without such data keeps the environment."""
    env = dict(os.environ)
    share = Path(exe).resolve().parent.parent / "share"
    if (share / "proj" / "proj.db").is_file():
        env["PROJ_DATA"] = str(share / "proj")
        env["PROJ_LIB"] = str(share / "proj")
        env.setdefault("PROJ_NETWORK", "OFF")
    if (share / "gdal").is_dir():
        env["GDAL_DATA"] = str(share / "gdal")
    if os.name == "nt":
        env["PATH"] = str(Path(exe).resolve().parent) + os.pathsep + env.get("PATH", "")
    return env


def _run(ctx: StepContext, args: list[str], what: str) -> str:
    """Run PDAL, cancellable; return its stdout or raise with its message.

    Output goes to files in the job folder (a full pipe would block PDAL) and stdin is closed.
    """
    out_path = ctx.job.dir / "pdal.out"
    err_path = ctx.job.dir / "pdal.err"
    with open(out_path, "wb") as out_f, open(err_path, "wb") as err_f:
        proc = subprocess.Popen(
            args,
            stdin=subprocess.DEVNULL,
            stdout=out_f,
            stderr=err_f,
            env=pdal_env(args[0]),
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        t0 = time.monotonic()
        while proc.poll() is None:
            if ctx.cancel_event.is_set():
                proc.kill()
                proc.wait()
                ctx.check()
            ctx.progress(min(0.95, (time.monotonic() - t0) / 60), what)
            time.sleep(0.1)
    out = out_path.read_text("utf-8", errors="replace")
    err = err_path.read_text("utf-8", errors="replace")
    if proc.returncode != 0:
        msg = (err or out or "").strip().splitlines()
        raise JobError(f"PDAL could not {what.lower()}: {msg[-1] if msg else f'exit {proc.returncode}'}")
    return out


def _layer_id(out_rel: str, taken: set[str]) -> str:
    stem = Path(out_rel).name.split(".")[0]
    base = "cloud-" + (re.sub(r"[^a-z0-9]+", "-", stem.lower()).strip("-") or "points")
    lid, n = base, 2
    while lid in taken:
        lid, n = f"{base}-{n}", n + 1
    return lid


class PointcloudToCopc:
    name = "pointcloud.to_copc"
    title = "Point cloud to COPC"
    description = "Converts LAS, LAZ or E57 to a COPC file in the project CRS and adds it as a layer."

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        known_keys(params, {"src", "out", "epsg", "origin"}, self.name)
        src = text(params, "src", required=True)
        assert src is not None
        if Path(src).suffix.lower() not in CLOUD_EXTENSIONS:
            raise JobError("src must be a LAS, LAZ, E57 or PLY file.")
        stem = re.sub(r"[^a-z0-9]+", "-", Path(src).name.split(".")[0].lower()).strip("-") or "cloud"
        out = {
            "src": src,
            "out": text(params, "out", f"clouds/{stem}.copc.laz"),
            "epsg": number(params, "epsg", None, 1024, 999999, integer=True),
            "origin": numbers(params, "origin", 3),
        }
        assert out["out"] is not None
        if not str(out["out"]).lower().endswith(".copc.laz"):
            raise JobError("out must end with .copc.laz.")
        return {k: v for k, v in out.items() if v is not None}

    def inputs(self, params: dict[str, Any]) -> list[str]:
        return [params["src"]]

    def plan(self, params: dict[str, Any]) -> list[Step]:
        def convert(ctx: StepContext) -> dict[str, Any]:
            pdal = find_pdal()
            if not pdal:
                raise JobError(PDAL_MISSING)
            src = ctx.input(params["src"])
            info = json.loads(_run(ctx, [pdal, "info", "--summary", str(src)], "Read the cloud"))
            summary = info.get("summary", {})
            srs = (summary.get("srs") or {}).get("wkt") or ""
            count = int(summary.get("num_points") or 0)
            ctx.log(f"{src.name}: {count:,} points" + ("" if srs else ", no CRS in the file"))
            stages: list[Any] = [str(src)]
            epsg = params.get("epsg")
            if epsg and srs:
                stages.append({"type": "filters.reprojection", "out_srs": f"EPSG:{epsg}"})
            elif epsg:
                ctx.log(f"The file declares no CRS; it is taken as EPSG:{epsg} already.", "warn")
            staged = ctx.stage("cloud.copc.laz")
            stages.append(
                {
                    "type": "writers.copc",
                    "filename": str(staged),
                    **({"a_srs": f"EPSG:{epsg}"} if epsg else {}),
                }
            )
            pipe = ctx.stage("pipeline.json")
            atomic_write_json(pipe, {"pipeline": stages})
            ctx.check()
            _run(ctx, [pdal, "pipeline", str(pipe)], "Write the COPC file")
            if not staged.is_file():
                raise JobError("PDAL finished without writing the COPC file.")
            return {"points": count, "bytes": staged.stat().st_size}

        def register(ctx: StepContext) -> dict[str, Any]:
            out_rel = str(params["out"]).replace("\\", "/")
            commit_files(ctx, [("cloud.copc.laz", out_rel)])
            mpath = safe_project_path(ctx.project, "manifest.json")
            manifest = json.loads(mpath.read_text("utf-8"))
            layers = manifest.setdefault("layers", [])
            existing = next(
                (
                    layer
                    for layer in layers
                    if layer.get("kind") == "pointcloud" and (layer.get("src") or {}).get("path") == out_rel
                ),
                None,
            )
            points = int(ctx.outputs("convert").get("points") or 0)
            if existing is None:
                lid = _layer_id(out_rel, {str(layer.get("id")) for layer in layers})
                layers.append(
                    {
                        "kind": "pointcloud",
                        "id": lid,
                        "name": Path(params["src"]).name,
                        "visible": True,
                        "src": {"path": out_rel},
                        "format": "copc",
                        **({"pointCount": points} if points else {}),
                    }
                )
                # keep the previous manifest beside it, as the app's own saves do
                shutil.copyfile(mpath, mpath.with_name("manifest.json.bak"))
                atomic_write_json(mpath, manifest, indent=2)
                ctx.log(f"Added layer {lid} ({out_rel}).")
            else:
                lid = str(existing.get("id"))
            return {"layer": lid, "path": out_rel}

        return [
            Step("convert", "Convert with PDAL", convert, weight=10),
            Step("register", "Add the layer to the project", register, weight=0.5),
        ]
