"""ODM's stages, its progress percent per stage, and the flags of each job (pure; ADR 0012).

The stage table and the progress percents are ODM 3.6.2's (``stages/odm_app.py``), measured by
``tools/odm/probe.mjs``. ``split`` and ``merge`` (split-merge of very large sets) are not used.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

STAGES: tuple[str, ...] = (
    "dataset", "opensfm", "openmvs", "odm_filterpoints", "odm_meshing", "mvs_texturing",
    "odm_georeferencing", "odm_dem", "odm_orthophoto", "odm_report", "odm_postprocess",
)  # fmt: skip
#: ODM's progress (percent) when each stage has finished (C6).
STAGE_END: dict[str, float] = {
    "dataset": 5.0, "opensfm": 25.0, "openmvs": 50.0, "odm_filterpoints": 52.0, "odm_meshing": 60.0,
    "mvs_texturing": 70.0, "odm_georeferencing": 80.0, "odm_dem": 90.0, "odm_orthophoto": 98.0,
    "odm_report": 99.0, "odm_postprocess": 100.0,
}  # fmt: skip
PRESET_FLAGS: dict[str, tuple[str, ...]] = {
    "fast": ("--fast-orthophoto", "--skip-3dmodel", "--pc-quality", "low", "--feature-quality", "medium"),
    "standard": ("--pc-quality", "medium", "--feature-quality", "high"),
    "high": ("--pc-quality", "high", "--feature-quality", "ultra"),
}
MESH_PRODUCTS = frozenset({"mesh", "tiles"})
#: How photo.georef reruns alignment with ground control (C12): "rerun-from" or "invalidate".
GEOREF_STRATEGY = "invalidate"
#: Where Fast's dense step starts after an alignment run (C13).
FAST_FIRST_STAGE = "odm_filterpoints"
#: The resolution alignment asks of ODM when the photos' own is unknown: full-size undistorted photos.
UNDISTORT_FALLBACK_CM = 1.0
GB = 1024**3


def stage_index(stage: str) -> int:
    try:
        return STAGES.index(stage)
    except ValueError:
        raise ValueError(f"{stage} is not an ODM stage this build runs") from None


def stage_start(stage: str) -> float:
    i = stage_index(stage)
    return 0.0 if i == 0 else STAGE_END[STAGES[i - 1]]


def stage_window(first: str, last: str) -> tuple[float, float]:
    return stage_start(first), STAGE_END[last]


#: Each stage's share of a step: ODM's percent span, except reading the photos, which takes
#: seconds but holds 5 % of ODM's bar (a fifth of the align step).
STAGE_WEIGHT: dict[str, float] = {
    s: 0.5 if s == "dataset" else STAGE_END[s] - stage_start(s) for s in STAGES
}  # fmt: skip


def stage_span(first: str, last: str, stage: str) -> tuple[float, float]:
    """Where ``stage`` starts and ends in the step ``first``..``last`` (0..1) by ``STAGE_WEIGHT``. A
    stage before the window sits at its start, one after it at its end."""
    lo, hi, i = stage_index(first), stage_index(last), stage_index(stage)
    window = STAGES[lo : hi + 1]
    total = sum(STAGE_WEIGHT[s] for s in window)
    before = sum(STAGE_WEIGHT[s] for s in STAGES[lo : max(lo, min(i, hi + 1))])
    inside = STAGE_WEIGHT[stage] if stage in window else 0.0
    return before / total, (before + inside) / total


def stage_after(stage: str) -> str | None:
    i = stage_index(stage)
    return STAGES[i + 1] if i + 1 < len(STAGES) else None


def odm_threads(logical_cpus: int, ram_bytes: int, cap_bytes: int | None) -> int:
    """``clamp(min(CPUs - 2, floor(RAM GB / 3)), 2, 32)``; a memory limit set by hand lowers it
    (``cap_bytes``: ``runner.odm_memory_cap()``, never the automatic photo memory cap)."""
    n = min(logical_cpus - 2, math.floor(ram_bytes / GB / 3))
    if cap_bytes:
        n = min(n, math.floor(cap_bytes / GB / 3))
    return max(2, min(32, n))


def gpu_wanted(setting: str, nvcuda_present: bool) -> bool:
    return setting != "off" and nvcuda_present


def gpu_flags(use_gpu: bool) -> list[str]:
    return ["--feature-type", "sift"] if use_gpu else ["--no-gpu"]


def _common(preset: str, use_gpu: bool, threads: int) -> list[str]:
    return [*PRESET_FLAGS[preset], *gpu_flags(use_gpu), "--max-concurrency", str(threads)]


def _num(v: float) -> str:
    return f"{v:g}"


def align_flags(
    preset: str, use_gpu: bool, threads: int, geo: Path | None, ortho_res_cm: float | None
) -> list[str]:
    """ODM's opensfm stage sizes ``opensfm/undistorted`` for ``--orthophoto-resolution`` (photos
    finer than a third of it are halved), and products never run that stage again: alignment asks
    for the photos' own resolution (``UNDISTORT_FALLBACK_CM`` when it is unknown), as products do."""
    res = round(ortho_res_cm, 2) if ortho_res_cm else UNDISTORT_FALLBACK_CM
    return [
        *_common(preset, use_gpu, threads),
        "--orthophoto-resolution", _num(res),
        *(["--geo", str(geo)] if geo else []),
    ]  # fmt: skip


def georef_flags(
    preset: str, use_gpu: bool, threads: int, gcp: Path, geo: Path | None, ortho_res_cm: float | None
) -> list[str]:
    return [*align_flags(preset, use_gpu, threads, geo, ortho_res_cm), "--gcp", str(gcp)]


def products_flags(
    preset: str,
    products: set[str],
    use_gpu: bool,
    threads: int,
    ortho_res_cm: float,
    dem_res_cm: float,
    mesh_size: int | None,
    boundary: Path | None,
) -> list[str]:
    out = [
        *_common(preset, use_gpu, threads),
        "--dsm", "--dtm", "--cog", "--pc-copc", "--build-overviews",
        "--orthophoto-resolution", _num(ortho_res_cm), "--dem-resolution", _num(dem_res_cm),
    ]  # fmt: skip
    if not products & MESH_PRODUCTS and "--skip-3dmodel" not in out:
        out.append("--skip-3dmodel")
    if mesh_size:
        out += ["--mesh-size", str(mesh_size)]
    if boundary:
        out += ["--boundary", str(boundary)]
    return out


@dataclass(frozen=True)
class OdmStep:
    name: str
    title: str
    first: str
    last: str
    weight: float


def dense_first(preset: str) -> str:
    return FAST_FIRST_STAGE if preset == "fast" else "openmvs"


def product_steps(products: set[str]) -> list[OdmStep]:
    """The ODM calls of photo.products, one per job step, covering openmvs to the end. ``dense``
    starts at ``dense_first(preset)`` at run time (Fast skips openmvs)."""
    steps = [OdmStep("dense", "Dense point cloud", "openmvs", "odm_filterpoints", 10.0)]
    if products & MESH_PRODUCTS:
        steps += [
            OdmStep("mesh", "3D mesh", "odm_meshing", "odm_meshing", 3.0),
            OdmStep("texture", "Texture the mesh", "mvs_texturing", "mvs_texturing", 3.0),
            OdmStep("cloud", "Georeference the point cloud", "odm_georeferencing", "odm_georeferencing", 1.0),
        ]
    else:
        steps.append(OdmStep("cloud", "Surface and point cloud", "odm_meshing", "odm_georeferencing", 4.0))
    steps += [
        OdmStep("dsm", "Elevation models (DSM and DTM)", "odm_dem", "odm_dem", 2.0),
        OdmStep("ortho", "Orthophoto and report", "odm_orthophoto", "odm_postprocess", 3.0),
    ]
    return steps
