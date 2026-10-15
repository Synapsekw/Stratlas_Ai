"""A LAS cloud as the project's COPC (``photo.products`` step ``cloud``, through
``odm/outputs.cloud_to_copc``).

``write_copc``: untwine (pipeline pack 0.6.1 and later) turns the LAS into a COPC out of core,
keeping the classes, its progress read from ``--progress_debug``; its temporary files go where the
caller says (the job's staging area). Without untwine, PDAL's ``writers.copc`` does it in memory,
refused up front, naming untwine, when the cloud would not fit the memory budget. Both run through
``native.run_tool`` with the memory budget as their limit. ``las`` may be a folder of tiles:
untwine reads the folder, PDAL merges one reader per tile.
"""

from __future__ import annotations

import re
import shutil
from pathlib import Path
from typing import Any

from ..runtime import JobError, StepContext, atomic_write_json, replace_over
from . import native

#: Memory PDAL holds per point to write a COPC (point table and octree): the founder's 913 M
#: point run reached 123 GB with SMRF in the same pipeline, 135 bytes a point.
PDAL_COPC_BYTES_PER_POINT = 140
#: PDAL's writers.copc rate, points a second (measured 207,000 on 2 M points: Task 4 of the photo
#: scale plan).
PDAL_COPC_POINTS_PER_S = 200_000
UNTWINE_PROGRESS = re.compile(r"\((\d+)% done\)")
NO_COPC_TOOL = (
    "The point cloud needs untwine or PDAL, and this pipeline pack has neither. Install the full "
    "pipeline pack, or leave the point cloud out."
)

#: What a folder of tiles may hold for the COPC writers.
TILE_SUFFIXES = (".las", ".laz")


def las_inputs(las: Path) -> list[Path]:
    """The LAS/LAZ files a COPC is built from: ``las`` itself, or, when it is a folder (the tiles
    of a Bentley ``.zpc``), every LAS or LAZ file in it, sorted. untwine reads the folder itself."""
    if not las.is_dir():
        return [las]
    files = sorted(p for p in las.iterdir() if p.is_file() and p.suffix.lower() in TILE_SUFFIXES)
    if not files:
        raise JobError(f"The folder {las.name} holds no LAS or LAZ files to build the COPC from.")
    return files


def untwine_args(exe: str, las: Path, out: Path, temp: Path, epsg: int | None) -> list[str]:
    args = [exe, "-i", str(las), "-o", str(out), "--temp_dir", str(temp), "--progress_debug"]
    return args + (["--a_srs", f"EPSG:{epsg}"] if epsg else [])


def pdal_copc_pipeline(las: Path, out: Path, epsg: int | None) -> dict[str, Any]:
    srs = f"EPSG:{epsg}" if epsg else None
    readers = [
        {"type": "readers.las", "filename": str(f), **({"override_srs": srs} if srs else {})}
        for f in las_inputs(las)
    ]
    merge = [{"type": "filters.merge"}] if len(readers) > 1 else []
    writer = {"type": "writers.copc", "filename": str(out), **({"a_srs": srs} if srs else {})}
    return {"pipeline": [*readers, *merge, writer]}


def untwine_progress(line: str) -> float | None:
    """The fraction an ``Untwine progress (N% done)`` line says, else None."""
    m = UNTWINE_PROGRESS.search(line)
    return min(100, int(m.group(1))) / 100 if m else None


def write_copc(
    ctx: StepContext,
    las: Path,
    out: Path,
    points: int,
    epsg: int | None,
    temp: Path,
    budget: int,
    progress: tuple[float, float] = (0.3, 0.95),
) -> str:
    """``las`` (``points`` points) as the COPC ``out``, with untwine, else PDAL. Answers which.
    The tool writes a temporary name beside ``out``, moved over it only on success; untwine's
    temporary folder (about 92 bytes a point, which it does not remove) and PDAL's pipeline file
    go whether the run succeeds, fails or is cancelled."""
    temp.mkdir(parents=True, exist_ok=True)
    ut, pj = temp / "untwine", temp / "copc-pipeline.json"
    part = out.with_name(f".tmp.{out.name}")  # keeps the .copc.laz ending untwine reads
    try:
        writer = _run_copc(ctx, las, part, points, epsg, temp, budget, progress, ut, pj)
        if not part.is_file():
            raise JobError(f"{writer} finished without writing the COPC file.")
        replace_over(part, out)
    finally:
        shutil.rmtree(ut, ignore_errors=True)
        pj.unlink(missing_ok=True)
        part.unlink(missing_ok=True)
    return writer


def _run_copc(
    ctx: StepContext,
    las: Path,
    out: Path,
    points: int,
    epsg: int | None,
    temp: Path,
    budget: int,
    progress: tuple[float, float],
    ut: Path,
    pj: Path,
) -> str:
    from ..pointcloud import find_pdal, pdal_env

    exe = native.find_tool("untwine")
    if exe:
        shutil.rmtree(ut, ignore_errors=True)  # a cancelled run's files
        ut.mkdir(parents=True, exist_ok=True)
        native.run_tool(
            ctx,
            untwine_args(exe, las, out, ut, epsg),
            "Building the COPC (untwine)",
            temp,
            expected_s=max(60.0, points / 2e6),
            progress=progress,
            memory_limit=budget,
            env=pdal_env(exe),
            on_output=untwine_progress,
        )
        return "untwine"
    pdal = find_pdal()
    if pdal is None:
        raise JobError(NO_COPC_TOOL)
    if points * PDAL_COPC_BYTES_PER_POINT > budget:
        raise JobError(
            f"The point cloud has {points:,} points, more than PDAL can turn into a COPC within "
            f"the memory budget ({budget / 1e9:.1f} GB). Install pipeline pack 0.6.1 or later, "
            "which brings untwine, or leave the point cloud out."
        )
    atomic_write_json(pj, pdal_copc_pipeline(las, out, epsg))
    native.run_tool(
        ctx,
        [pdal, "pipeline", str(pj)],
        "Building the COPC (PDAL)",
        temp,
        expected_s=max(30.0, points / PDAL_COPC_POINTS_PER_S),
        progress=progress,
        memory_limit=budget,
        env=pdal_env(pdal),
    )
    return "pdal"
