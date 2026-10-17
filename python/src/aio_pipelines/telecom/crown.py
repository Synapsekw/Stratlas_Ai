"""Crown location for antenna detection: the cloud, the tower axis and the equipment band.

The axis comes from the newest engineering evidence when there is one, from a click on the tower
(`params.towerHint`), or is found automatically as the tallest slender upright structure. The crown
is the part of the tower from the lowest equipment up to the top, read at full density in the local
frame (x east, y up, z south) with the layer's `heightOffsetM` applied.

State that later steps keep is plain data: the axis is `point` and `dir` (3 floats each) and the
shaft radius is `ShaftRadius.coef` (slope and intercept against height along the axis), which
`ShaftRadius.from_coef` turns back into the function.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
from scipy import ndimage

from ..change.sources import height_offset_m
from ..engineer.axis import Axis, estimate_axis
from ..engineer.cloud import read_region
from ..engineer.members import fit_shaft_envelope
from ..inspection.frame import asset_path
from ..runtime import JobError

TOWER_HINT_NEEDED = (
    "Could not tell which structure is the tower. Click the tower once in the 3D view and run again."
)
NO_TOWER = (
    "No upright tower was found in the point cloud. Antenna detection needs a monopole or lattice tower."
)
SPARSE_CROWN = "The point cloud is too sparse around the tower top to measure antennas."
EMPTY_BAND = "The point cloud has no points in the tower's equipment band."
NO_CLOUD = "This project has no point cloud to detect antennas in."

CROP_RADIUS_M = 30.0
HINT_RADIUS_M = 8.0
DEFAULT_FLOOR_FRACTION = 0.7
SAME_HEIGHT_RATIO = 0.85
MIN_CROWN_POINTS = 5_000
CROWN_MARGIN_M = 3.0

GRID_M = 1.0
OVERVIEW_POINTS = 400_000
FULL_POINTS = 2_000_000
MIN_TOWER_HEIGHT_M = 5.0  # a structure lower than this is not a tower
MAX_FOOTPRINT_M = 12.0  # a wider cell cluster is a building or a tree line, not a slender tower
SEPARATE_MASTS_M = 5.0
GROUND_WINDOW_CELLS = 15
SLICE_M = 0.25
BAND_POINTS = 50
BAND_CLEARANCE_M = 0.25
FLOOR_LIFT_M = 0.3
MIN_UPRIGHT = 0.5  # the upright check of `engineer.pipeline` and `model.evidence`
MIN_BAND_POINTS = 50


class ShaftRadius:
    """Shaft radius at a height along the axis: a straight line, extrapolated. `coef` is
    (slope, intercept) as plain floats so it can be stored and rebuilt."""

    def __init__(self, slope: float, intercept: float):
        self.coef = [float(slope), float(intercept)]

    @classmethod
    def from_coef(cls, coef: Any) -> ShaftRadius:
        return cls(float(coef[0]), float(coef[1]))

    def __call__(self, h: np.ndarray) -> np.ndarray:
        return self.coef[0] * np.asarray(h, dtype=np.float64) + self.coef[1]


@dataclass
class Crown:
    axis: Axis
    source: str  # "evidence" | "auto" | "hint"
    height: float  # tower height along the axis
    top_y: float
    floor_y: float
    radius_m: float  # the crown cylinder radius
    shaft_r: ShaftRadius
    xyz: np.ndarray  # crown cylinder points, local frame, heightOffsetM applied
    layer_id: str
    warnings: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------------------------
# which cloud
# ---------------------------------------------------------------------------------------------


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return None


def newest_evidence(project: Path) -> dict | None:
    """The newest engineering run that has an evidence pack: `{"axis", "height", "crop", "base",
    "cloud", "run"}` (`cloud` is the layer id of the run's first cloud, None when unknown), or None.
    Newest is by the pack file's modification time."""
    root = Path(project) / "engineering"
    if not root.is_dir():
        return None
    best: tuple[float, Path] | None = None
    for run in root.iterdir():
        pack = run / "evidence.json"
        if not (run / "run.json").is_file() or not pack.is_file():
            continue
        t = pack.stat().st_mtime
        if best is None or t > best[0]:
            best = (t, run)
    if best is None:
        return None
    run = best[1]
    doc, meta = _read_json(run / "evidence.json"), _read_json(run / "run.json")
    if not isinstance(doc, dict):
        return None
    sources = (meta.get("setup") or {}).get("sources") if isinstance(meta, dict) else None
    if not isinstance(sources, dict) and isinstance(meta, dict):
        sources = meta.get("sources")
    clouds = sources.get("clouds") if isinstance(sources, dict) else None
    first = clouds[0] if isinstance(clouds, list) and clouds and isinstance(clouds[0], dict) else {}
    layer = first.get("layer")
    return {
        "axis": doc.get("axis"),
        "height": doc.get("height"),
        "crop": doc.get("crop"),
        "base": doc.get("base"),
        "cloud": layer if isinstance(layer, str) else None,
        "run": run.name,
    }


def _cloud_layers(manifest: dict) -> list[dict]:
    return [x for x in manifest.get("layers", []) if isinstance(x, dict) and x.get("kind") == "pointcloud"]


def _usable(evidence: dict | None) -> bool:
    if not evidence:
        return False
    axis, height = evidence.get("axis"), evidence.get("height")
    try:
        d = [float(v) for v in axis["dir"]]
        _ = [float(v) for v in axis["point"]]
        return len(d) == 3 and d[1] >= MIN_UPRIGHT and float(height) > 0
    except (TypeError, KeyError, ValueError):
        return False


def pick_cloud_layer(project: Path, manifest: dict, requested: str | None) -> tuple[dict, dict | None]:
    """(layer, evidence): the requested cloud, else the cloud of the newest engineering evidence,
    else the newest visible point cloud layer (the last one). Evidence is returned only when it was
    measured in the chosen cloud. JobError(NO_CLOUD) when the project has no point cloud."""
    clouds = _cloud_layers(manifest)
    evidence = newest_evidence(project)
    if not _usable(evidence):
        evidence = None
    if requested is not None:
        layer = next((x for x in manifest.get("layers", []) if x.get("id") == requested), None)
        if layer is None:
            raise JobError(f'The project has no layer "{requested}".')
        if layer.get("kind") != "pointcloud":
            raise JobError(f'"{layer.get("name", requested)}" is not a point cloud layer.')
        same = evidence is not None and evidence["cloud"] in (None, requested)
        return layer, evidence if same else None
    if evidence is not None:
        layer = next((x for x in clouds if x.get("id") == evidence["cloud"]), None)
        if layer is not None:
            return layer, evidence
    visible = [x for x in clouds if x.get("visible", True) is not False]
    if not visible:
        raise JobError(NO_CLOUD)
    return visible[-1], None


# ---------------------------------------------------------------------------------------------
# the shaft
# ---------------------------------------------------------------------------------------------


def shaft_radius_fn(xyz: np.ndarray, axis: Axis, height: float) -> ShaftRadius:
    """The shaft radius against height along the axis: the 98th percentile radius in 1 m slices
    from 0.1 to 0.6 of `height`, fitted by a line (`members.fit_shaft_envelope`) and extrapolated.
    With too few slices the radius is the 98th percentile of the lower 60 percent, constant."""
    u, w, h = axis.to_frame(xyz)
    r = np.hypot(u, w)
    coef = fit_shaft_envelope(h, r, height)
    if coef is not None:
        return ShaftRadius(coef[0], coef[1])
    low = r[(h > 0.1 * height) & (h <= 0.6 * height)]
    return ShaftRadius(0.0, float(np.percentile(low, 98)) if len(low) else 0.5)


def _floor_h(h: np.ndarray, r: np.ndarray, shaft_r: ShaftRadius, height: float) -> float | None:
    """Height of the lowest 0.25 m slice above half the height with at least 50 points beyond the
    shaft radius plus 0.25 m, minus 0.3 m; None when there is none."""
    beyond = r > shaft_r(h) + BAND_CLEARANCE_M
    sel = beyond & (h >= 0.5 * height) & (h <= height + 1.0)
    if not sel.any():
        return None
    k = np.floor((h[sel] - 0.5 * height) / SLICE_M).astype(np.int64)
    counts = np.bincount(k)
    hit = np.flatnonzero(counts >= BAND_POINTS)
    if len(hit) == 0:
        return None
    return 0.5 * height + float(hit[0]) * SLICE_M - FLOOR_LIFT_M


# ---------------------------------------------------------------------------------------------
# the automatic seed
# ---------------------------------------------------------------------------------------------


def _find_seed(xyz: np.ndarray) -> tuple[float, float] | None:
    """Plan position (x, z) of the tallest slender structure of a coarse overview, or JobError when
    two of about the same height stand apart. None when nothing tall enough stands."""
    if len(xyz) < 10:
        return None
    cx = np.floor(xyz[:, 0] / GRID_M).astype(np.int64)
    cz = np.floor(xyz[:, 2] / GRID_M).astype(np.int64)
    x0, z0 = int(cx.min()), int(cz.min())
    ix, iz = cx - x0, cz - z0
    shape = (int(ix.max()) + 1, int(iz.max()) + 1)
    top = np.full(shape, -np.inf)
    low = np.full(shape, np.inf)
    np.maximum.at(top, (ix, iz), xyz[:, 1])
    np.minimum.at(low, (ix, iz), xyz[:, 1])
    ground = ndimage.minimum_filter(low, size=GROUND_WINDOW_CELLS, mode="nearest")
    # empty cells hold inf; the filter spreads them only where no cell in reach has points
    rel = np.where(np.isfinite(top), top - ground, -np.inf)
    tallest = float(rel.max())
    if not np.isfinite(tallest) or tallest < MIN_TOWER_HEIGHT_M:
        return None
    keep = rel >= max(0.5 * tallest, MIN_TOWER_HEIGHT_M)
    labels, count = ndimage.label(keep, structure=np.ones((3, 3), dtype=int))
    found = []  # (height, x, z) of each slender component's highest cell
    for i in range(1, count + 1):
        cells = np.argwhere(labels == i)
        extent = (cells.max(axis=0) - cells.min(axis=0) + 1) * GRID_M
        if float(extent.max()) > MAX_FOOTPRINT_M:
            continue
        j = int(np.argmax(rel[cells[:, 0], cells[:, 1]]))
        peak = cells[j]
        found.append(
            (
                float(rel[peak[0], peak[1]]),
                (int(peak[0]) + x0 + 0.5) * GRID_M,
                (int(peak[1]) + z0 + 0.5) * GRID_M,
            )
        )
    if not found:
        return None
    found.sort(reverse=True)
    if len(found) > 1:
        (h1, x1, z1), (h2, x2, z2) = found[0], found[1]
        if h1 - h2 < (1.0 - SAME_HEIGHT_RATIO) * h1 and float(np.hypot(x1 - x2, z1 - z2)) > SEPARATE_MASTS_M:
            raise JobError(TOWER_HINT_NEEDED)
    return found[0][1], found[0][2]


# ---------------------------------------------------------------------------------------------
# the crown
# ---------------------------------------------------------------------------------------------


def _read(ctx: Any, layer_path: Path, layer: dict, region: dict | None, cap: int, origin, offset: float):
    return read_region(
        layer_path, str(layer.get("format") or "las"), region, cap, ctx, origin, seed=0, offset_m=offset
    )[0]


def _axis_of(evidence: dict) -> Axis:
    a = evidence["axis"]
    d = np.asarray([float(v) for v in a["dir"]], dtype=np.float64)
    d /= np.linalg.norm(d)
    tilt = float(np.degrees(np.arccos(np.clip(d[1], -1.0, 1.0))))
    return Axis(tuple(float(v) for v in a["point"]), tuple(float(v) for v in d), tilt)


def locate_crown(ctx: Any, project: Path, manifest: dict, params: dict) -> Crown:
    """Find the tower axis and read the crown band. See the module docstring; raises JobError with
    TOWER_HINT_NEEDED, NO_TOWER, SPARSE_CROWN, EMPTY_BAND or NO_CLOUD."""
    requested = (params.get("cloud") or {}).get("layer") if isinstance(params.get("cloud"), dict) else None
    layer, evidence = pick_cloud_layer(project, manifest, requested)
    layer_path = asset_path(project, layer.get("src"))
    if layer_path is None or not layer_path.exists():
        raise JobError(f'The point cloud "{layer.get("name", layer.get("id"))}" has no file to read.')
    offset = height_offset_m(layer)
    origin = tuple(float(v) for v in (manifest.get("origin") or [0, 0, 0]))
    warnings: list[str] = []
    hint = params.get("towerHint")

    def region_pts(centre: tuple[float, float], radius: float, cap: int = FULL_POINTS) -> np.ndarray:
        return _read(
            ctx, layer_path, layer, {"centre": [centre[0], centre[1]], "radiusM": radius}, cap, origin, offset
        )

    if hint is not None:
        source = "hint"
        local = region_pts((float(hint[0]), float(hint[1])), HINT_RADIUS_M)
        if len(local) < 100:
            raise JobError(NO_TOWER)
        axis = estimate_axis(local, seed=0)
        height = float(axis.to_frame(local)[2].max())
        if axis.dir[1] < MIN_UPRIGHT:
            raise JobError(NO_TOWER)
    elif evidence is not None:
        source = "evidence"
        axis = _axis_of(evidence)
        height = float(evidence["height"])
        local = region_pts((axis.point[0], axis.point[2]), HINT_RADIUS_M)
    else:
        source = "auto"
        overview = _read(ctx, layer_path, layer, None, OVERVIEW_POINTS, origin, offset)
        seed = _find_seed(overview)
        if seed is None:
            raise JobError(NO_TOWER)
        local = region_pts(seed, CROP_RADIUS_M)
        axis = estimate_axis(local, seed=0)
        if axis.dir[1] < MIN_UPRIGHT:
            raise JobError(TOWER_HINT_NEEDED)
        height = float(axis.to_frame(local)[2].max())

    u, w, h = axis.to_frame(local)
    r = np.hypot(u, w)
    near = r <= HINT_RADIUS_M  # other structures in the crop do not enter the shaft or the band
    shaft_r = shaft_radius_fn(local[near], axis, height)
    floor_h = _floor_h(h[near], r[near], shaft_r, height)
    if floor_h is None:
        fraction = params.get("floorFraction")
        fraction = (
            float(fraction)
            if isinstance(fraction, (int, float)) and not isinstance(fraction, bool)
            else DEFAULT_FLOOR_FRACTION
        )
        floor_h = fraction * height
        warnings.append(
            f"No equipment was seen above the shaft, so the floor of the antenna band is {fraction:.0%} of the tower height."
        )
    foot = axis.from_frame(0.0, 0.0, floor_h)
    top_pt = axis.from_frame(0.0, 0.0, height)
    floor_y, top_y = float(foot[1]), float(top_pt[1])
    radius = float(shaft_r(np.array([floor_h]))[0]) + CROWN_MARGIN_M
    box = {
        "min": [float(foot[0] - radius), floor_y, float(foot[2] - radius)],
        "max": [float(foot[0] + radius), top_y + 1.0, float(foot[2] + radius)],
    }
    band = _read(ctx, layer_path, layer, box, FULL_POINTS, origin, offset)
    if len(band):
        bu, bw, _ = axis.to_frame(band)
        band = band[np.hypot(bu, bw) <= radius]
    if len(band) < MIN_BAND_POINTS:
        raise JobError(EMPTY_BAND)
    if len(band) < MIN_CROWN_POINTS:
        raise JobError(SPARSE_CROWN)
    return Crown(
        axis=axis,
        source=source,
        height=height,
        top_y=top_y,
        floor_y=floor_y,
        radius_m=radius,
        shaft_r=shaft_r,
        xyz=band,
        layer_id=str(layer.get("id")),
        warnings=warnings,
    )
