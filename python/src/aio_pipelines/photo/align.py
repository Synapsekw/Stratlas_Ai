"""photo.align: drone photos to calibrated cameras and a georeferenced sparse model.

Stages (``PhotoStageName``; each a resumable job step):

    inspect   EXIF and DJI XMP of every photo (GPS, altitudes, gimbal, RTK flag and accuracy,
              camera); reject what cannot be used, warn about what may hurt; camera groups;
              the run's CRS, height rule and frames; ``run.json`` (status ``aligning``)
    features  SIFT on CPU through the engine, image size from the preset (resumes per photo)
    match     pairs from GPS neighbours (footprint from altitude and field of view; oblique
              views paired by where they look), sequential neighbours, exhaustive for small sets;
              geometric verification (resumes per pair)
    sfm       global mapper by default; incremental when the global one registers under 95 %
    georef    every model to the GNSS positions (robust similarity in a local ENU frame), then
              bundle adjustment with GNSS priors weighted by RTK accuracy; disconnected models
              join through GNSS; models without enough GNSS are reported by name
    report    report/align.json, report/accuracy.json (GNSS only, checkpoints measured when a
              gcp.json is there), mark predictions, cameras-sfm.json
    commit    everything into ``photogrammetry/<run>/``; ``run.json`` last

The engine is an adapter (``colmap_io.SfmEngine``); ``PhotoAlign.engine_factory`` picks it.
Photos are read in place and never written. Nothing leaves the project except reading photos.
"""

from __future__ import annotations

import json
import math
import os
import platform
import re
import shutil
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np

from .. import __version__
from ..params import known_keys
from ..runtime import (
    Cancelled,
    JobError,
    Step,
    StepContext,
    atomic_write_json,
    commit_files,
    commit_tree,
    now_iso,
    safe_project_path,
)
from . import accuracy as A
from . import bundle as B
from . import crs as C
from . import gcp as G
from .colmap_io import (
    EngineGroup,
    EngineImage,
    EngineJob,
    SfmEngine,
    load_engine,
    memory_limit,
    memory_status,
)
from .exif import PhotoMeta, apply_ppk, inspect_photos, list_folder_photos, read_photo, read_ppk
from .model import SparseModel, rotmat_to_qvec

RUN_SCHEMA = "aio.photo-run/1"
RUN_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
PRESETS = {
    # share of the longest image side used for features, and SIFT features per photo
    "fast": (0.25, 4096),
    "standard": (0.5, 8192),
    "high": (1.0, 12288),
}
MIN_REGISTERED_GLOBAL = 0.95
MAX_EXHAUSTIVE = 400
STAGES = ("inspect", "features", "match", "sfm", "georef", "report", "commit")


# ------------------------------------------------------------------------------- run files


def run_dir(run: str) -> str:
    return f"photogrammetry/{run}"


def read_manifest(project: Path) -> dict[str, Any]:
    p = project / "manifest.json"
    if not p.is_file():
        return {}
    try:
        return json.loads(p.read_text("utf-8"))
    except (OSError, ValueError) as e:
        raise JobError(f"The project manifest cannot be read: {e}") from e


def hardware_probe(project: Path) -> dict[str, Any]:
    """What this computer is (``HardwareProbe``), as far as the pack can tell without the app."""
    mem = memory_status()[0]
    machine = platform.machine().lower()
    arch = {"amd64": "x64", "x86_64": "x64", "arm64": "arm64", "aarch64": "arm64"}.get(
        machine, machine or "unknown"
    )
    plat = sys.platform
    supported = (plat, arch) in (("win32", "x64"), ("darwin", "arm64"))
    return {
        "platform": plat,
        "arch": arch,
        "cpu": {"model": (platform.processor() or "unknown")[:200], "cores": os.cpu_count() or 1},
        "memoryBytes": mem,
        "freeDiskBytes": int(shutil.disk_usage(project).free),
        "gpus": [],
        "cuda": False,
        "processing": "available" if supported else "unsupported-platform",
    }


class RunState:
    """The run record kept in staging while the job runs and written to ``run.json``."""

    def __init__(self, ctx: StepContext):
        self.ctx = ctx
        self.path = ctx.stage("run-state.json")

    def load(self) -> dict[str, Any]:
        if self.path.exists():
            return json.loads(self.path.read_text("utf-8"))
        return {}

    def save(self, data: dict[str, Any]) -> None:
        atomic_write_json(self.path, data)

    def write_project(self, data: dict[str, Any]) -> None:
        """The project's ``run.json`` now (status and stages are visible while the job runs)."""
        run = data.get("id")
        if not run:
            return
        public = {k: v for k, v in data.items() if k != "frames"}
        atomic_write_json(safe_project_path(self.ctx.project, f"{run_dir(run)}/run.json"), public)


def staged(name: str, fn):
    """A step that records its stage (times, memory) and marks the run failed or cancelled."""

    def run(ctx: StepContext) -> dict[str, Any]:
        st = RunState(ctx)
        data = st.load()
        stages = {s["name"]: s for s in data.get("stages", [])}
        rec = stages.get(name) or {"name": name, "state": "pending"}
        rec.update({"state": "running", "startedAt": now_iso()})
        t0 = time.monotonic()
        if data:
            data["stages"] = [rec if s["name"] == name else s for s in data.get("stages", [])]
            data["updatedAt"] = now_iso()
            st.save(data)
            st.write_project(data)
        try:
            out = fn(ctx) or {}
        except (Cancelled, JobError, Exception) as e:
            data = st.load()
            if data:
                state = "cancelled" if isinstance(e, Cancelled) else "failed"
                for s in data.get("stages", []):
                    if s["name"] == name:
                        s.update({"state": state, "finishedAt": now_iso()})
                        if not isinstance(e, Cancelled):
                            s["message"] = str(e)[:2000]
                data["status"] = "cancelled" if isinstance(e, Cancelled) else "failed"
                data["updatedAt"] = now_iso()
                st.save(data)
                st.write_project(data)
            raise
        data = st.load()
        for s in data.get("stages", []):
            if s["name"] == name:
                s.update(
                    {"state": "done", "finishedAt": now_iso(), "seconds": round(time.monotonic() - t0, 2)}
                )
                mem = out.pop("_memoryPeakBytes", None)
                if mem:
                    s["memoryPeakBytes"] = int(mem)
        if data:
            data["updatedAt"] = now_iso()
            st.save(data)
            if name != "commit":
                st.write_project(data)
        return out

    return run


# ------------------------------------------------------------------------------- photos


def photo_list(ctx: StepContext, params: dict[str, Any]) -> tuple[list[tuple[str, Path]], dict[str, Any]]:
    """``(key, path)`` of the run's photos, and per-key extras from a photos layer (its poses)."""
    src = params["photos"]
    if "folders" in src:
        folders = [Path(f) if Path(f).is_absolute() else ctx.project / f for f in src["folders"]]
        return list_folder_photos(folders), {}
    manifest = read_manifest(ctx.project)
    layer = next((ly for ly in manifest.get("layers", []) if ly.get("id") == src["layer"]), None)
    if layer is None or layer.get("kind") != "photos":
        raise JobError(f'The project has no photos layer "{src["layer"]}".')
    out, extra = [], {}
    for item in layer.get("items") or []:
        ref = item.get("src") or {}
        rel = ref.get("path") or (f"assets/sha256/{ref['hash']}" if ref.get("hash") else None)
        if not rel:
            continue
        path = safe_project_path(ctx.project, rel)
        key = str(item.get("id") or rel)
        out.append((key, path))
        extra[key] = item
    if not out:
        raise JobError("The photos layer has no photos.")
    return out, extra


def layer_meta(meta: PhotoMeta, item: dict[str, Any], manifest: dict[str, Any]) -> None:
    """A review copy without EXIF: position from the layer's pose, field of view from its lens."""
    if not meta.has_gps and item.get("pos") and manifest.get("crs") and manifest.get("origin"):
        o = manifest["origin"]
        x, y, z = item["pos"]
        lon, lat = C.crs_to_geodetic(C.crs_of(manifest["crs"]), [o[0] + x], [o[1] - z])
        meta.lon, meta.lat, meta.abs_alt = float(lon[0]), float(lat[0]), float(o[2] + y)
    lens = item.get("lens") or {}
    if not meta.focal35 and lens.get("hfovDeg"):
        meta.focal35 = 18.0 / math.tan(math.radians(float(lens["hfovDeg"])) / 2)


#: Measured on a 20 MP flight (COLMAP 4.2 CPU SIFT, first octave 0): about 0.5 GB plus 0.3 GB per
#: extraction thread at 2736 px, growing with the square of the image size (1.4 GB per thread at
#: full size). SIFT's first octave -1 (doubling the image first) quadruples it: 1.4 GB per thread
#: at 2736 px, which is how 24 threads once took 33 GB.
FEATURE_BASE_GB = 0.5
FEATURE_GB_PER_THREAD_AT_2736 = 0.3
#: Extraction is limited by decoding and disk beyond this many threads (16 threads were no faster
#: than 4 on the measured flight).
MAX_FEATURE_THREADS = 8
#: Feature extraction stays within this, whatever the machine (a 16 GB laptop runs other things).
FEATURE_BUDGET_GB = 4.0


def first_octave(max_image_size: int) -> int:
    """SIFT's first octave: -1 (upsample) only for small images, where fine detail needs it."""
    return -1 if max_image_size < 1600 else 0


def feature_threads(info: dict[str, Any], memory_limit_bytes: int) -> int:
    """Feature threads whose memory fits in ``FEATURE_BUDGET_GB`` and half the stage limit."""
    cores = os.cpu_count() or 4
    size = int(info.get("maxImageSize") or 2736)
    per = FEATURE_GB_PER_THREAD_AT_2736 * (size / 2736) ** 2 * (4 if first_octave(size) < 0 else 1)
    budget = FEATURE_BUDGET_GB
    if memory_limit_bytes > 0:
        budget = min(budget, 0.5 * memory_limit_bytes / 1e9)
    fit = int((budget - FEATURE_BASE_GB) / max(per, 0.02))
    return max(1, min(cores, MAX_FEATURE_THREADS, fit))


def initial_params(meta: PhotoMeta) -> list[float]:
    """OPENCV start calibration: focal from the 35 mm equivalent, else 1.2 x the long side."""
    w, h = meta.width, meta.height
    f = float(meta.focal35) / 36.0 * max(w, h) if meta.focal35 else 1.2 * max(w, h)
    return [f, f, w / 2, h / 2, 0.0, 0.0, 0.0, 0.0]


def meta_record(m: PhotoMeta) -> dict[str, Any]:
    rec = {
        k: getattr(m, k)
        for k in (
            "key",
            "width",
            "height",
            "make",
            "model",
            "focal_mm",
            "focal35",
            "time",
            "lon",
            "lat",
            "gps_alt",
            "abs_alt",
            "rel_alt",
            "yaw",
            "pitch",
            "roll",
            "rtk_flag",
            "rtk_std",
            "blur",
            "ppk",
        )
    }
    rec["path"] = str(m.path)
    return rec


def meta_from(rec: dict[str, Any]) -> PhotoMeta:
    m = PhotoMeta(key=rec["key"], path=Path(rec["path"]))
    for k, v in rec.items():
        if k not in ("key", "path"):
            setattr(m, k, tuple(v) if k == "rtk_std" and v else v)
    return m


# ------------------------------------------------------------------------------- heights and frames


def heights_rule(
    metas: list[PhotoMeta], manifest: dict[str, Any], gnss: str
) -> tuple[np.ndarray, dict[str, Any], list[str]]:
    """Each photo's height in the run's height system, the ``PhotoHeights`` record and warnings.

    1. RTK photos (fixed solutions) log ellipsoidal heights: converted to orthometric with the
       EGM2008 grid when it is installed, else kept ellipsoidal (and said so).
    2. Otherwise, with the project's ``verticalDatum``: ``H = absolute + absAltOffsetM``.
    3. Otherwise the absolute altitude as logged: nominally above mean sea level, often tens of
       metres off (warned), or relative altitude when there is no absolute one.
    """
    warnings: list[str] = []
    datum = manifest.get("verticalDatum") if isinstance(manifest.get("verticalDatum"), dict) else None
    rtk = [m for m in metas if m.has_gps and m.gnss_kind() == "fixed"]
    absolute = np.array([m.altitude if m.altitude is not None else np.nan for m in metas], dtype=np.float64)
    relative = np.array([m.rel_alt if m.rel_alt is not None else np.nan for m in metas], dtype=np.float64)
    if gnss != "ignore" and len(rtk) >= max(3, len(metas) // 2) and not datum:
        H = absolute.copy()
        grid = C.geoid_grid("egm2008")
        if grid is not None:
            ok = ~np.isnan(H)
            idx = np.nonzero(ok)[0]
            H[idx] = C.ellipsoidal_to_orthometric(
                [metas[i].lon for i in idx], [metas[i].lat for i in idx], H[idx], grid
            )
            rec = {
                "source": "ellipsoidal",
                "geoid": "egm2008",
                "note": "RTK ellipsoidal heights converted to EGM2008.",
            }
        else:
            rec = {
                "source": "ellipsoidal",
                "geoid": "none",
                "note": "RTK ellipsoidal heights, not converted (no geoid grid).",
            }
            warnings.append(
                "Heights are ellipsoidal (RTK) and the geoid grid is not installed: they are not mean sea level."
            )
        return H, rec, warnings
    if not np.isnan(absolute).all():
        H = absolute.copy()
        if datum:
            off = float(datum.get("absAltOffsetM", 0.0))
            H = H + off
            rec = {
                "source": "orthometric",
                "geoid": "none",
                "absAltOffsetM": off,
                "note": (datum.get("note") or "")[:300],
            }
        else:
            rec = {
                "source": "orthometric",
                "geoid": "none",
                "note": "Absolute altitude as logged (nominally above mean sea level).",
            }
            if not rtk:
                warnings.append(
                    "Heights are the drones' absolute altitudes as logged: often tens of metres off. "
                    "Use ground control or set the project's vertical datum for true heights."
                )
        missing = np.isnan(H) & ~np.isnan(relative)
        if missing.any():
            take = np.nanmedian(absolute - relative)
            H[missing] = (
                relative[missing] + (take if not np.isnan(take) else 0.0) + (rec.get("absAltOffsetM") or 0.0)
            )
        return H, rec, warnings
    if not np.isnan(relative).all():
        return (
            relative.copy(),
            {"source": "relative", "geoid": "none", "note": "Height above the take-off point."},
            ["The photos log only their height above the take-off point; heights are relative to it."],
        )
    return (
        np.full(len(metas), np.nan),
        {"source": "relative", "geoid": "none", "note": "No altitude in the photos."},
        ["The photos log no altitude."],
    )


def choose_crs(params: dict[str, Any], manifest: dict[str, Any], metas: list[PhotoMeta]):
    if params.get("crs"):
        return C.crs_of(params["crs"])
    if manifest.get("crs"):
        return C.crs_of(manifest["crs"])
    located = [m for m in metas if m.has_gps]
    if not located:
        raise JobError("The photos have no GPS positions; choose a coordinate system for the run.")
    lon = float(np.median([m.lon for m in located]))
    lat = float(np.median([m.lat for m in located]))
    return C.crs_of(C.utm_epsg(lon, lat))


# ------------------------------------------------------------------------------- pairs


def footprint_radius(m: PhotoMeta, agl: float) -> float:
    """Half the diagonal of the photo's ground footprint, metres."""
    f35 = m.focal35 or 24.0
    half_diag = math.hypot(36.0, 24.0) / 2
    return max(5.0, agl * half_diag / f35)


def choose_pairs(
    metas: list[PhotoMeta], H: np.ndarray, mode: str, names: dict[str, str]
) -> tuple[list[tuple[str, str]], str]:
    """Image pairs to match (engine names) and how they were chosen."""
    n = len(metas)
    pairs: set[tuple[int, int]] = set()

    def add(i: int, j: int) -> None:
        if i != j:
            pairs.add((min(i, j), max(i, j)))

    order = sorted(range(n), key=lambda i: (metas[i].time or "", metas[i].key))
    has_gps = np.array([m.has_gps and not np.isnan(H[i]) for i, m in enumerate(metas)])
    if mode == "auto":
        mode = "exhaustive" if n <= 40 else ("gps" if has_gps.mean() >= 0.5 else "sequential")
    if mode == "exhaustive":
        if n > MAX_EXHAUSTIVE:
            raise JobError(
                f"Exhaustive matching is limited to {MAX_EXHAUSTIVE} photos; use GPS or sequential matching."
            )
        for i in range(n):
            for j in range(i + 1, n):
                add(i, j)
        how = "exhaustive"
    else:
        if mode == "sequential" or has_gps.sum() < 2:  # GPS mode pairs by footprint only
            for k, i in enumerate(order):
                for j in order[k + 1 : k + 11]:
                    add(i, j)
        how = "sequential"
        if mode == "gps" and has_gps.sum() >= 2:
            idx = np.nonzero(has_gps)[0]
            lon0 = float(np.median([metas[i].lon for i in idx]))
            lat0 = float(np.median([metas[i].lat for i in idx]))
            frame = C.EnuFrame(lon0, lat0, 0.0)
            xyz = frame.from_geodetic([metas[i].lon for i in idx], [metas[i].lat for i in idx], H[idx])
            rel = np.array([metas[i].rel_alt if metas[i].rel_alt is not None else np.nan for i in idx])
            ground = (
                float(np.nanmedian(xyz[:, 2] - rel))
                if not np.isnan(rel).all()
                else float(xyz[:, 2].min() - 50)
            )
            agl = np.maximum(xyz[:, 2] - ground, 5.0)
            # where each photo looks: oblique views are paired by their ground target
            target = xyz[:, :2].copy()
            look = np.zeros((len(idx), 2))
            reach = agl.copy()  # distance along the view to the ground
            # views lower than 50 degrees below the horizon see facades and sides: two of them
            # facing each other share little; steeper views (a -65 degree mapping flight whose
            # lines alternate direction) still share most of their ground
            shallow = np.array([metas[i].pitch is not None and -50 < metas[i].pitch < -5 for i in idx])
            for k, i in enumerate(idx):
                m = metas[i]
                if m.pitch is not None and m.yaw is not None and -80 < m.pitch < -5:
                    d = agl[k] / math.tan(math.radians(-m.pitch))
                    look[k] = [math.sin(math.radians(m.yaw)), math.cos(math.radians(m.yaw))]
                    target[k] += look[k] * d
                    reach[k] = agl[k] / math.sin(math.radians(-m.pitch))
            radius = np.array([footprint_radius(metas[i], reach[k]) for k, i in enumerate(idx)])
            from scipy.spatial import cKDTree

            tree = cKDTree(target)
            for k in range(len(idx)):
                cand = tree.query_ball_point(target[k], r=2.0 * radius[k])
                cand = sorted(cand, key=lambda c: float(np.linalg.norm(target[c] - target[k])))[:40]
                for c in cand:
                    if c == k:
                        continue
                    if shallow[k] and shallow[c] and float(look[k] @ look[c]) < -0.2:
                        continue  # low views facing each other across the site: little in common
                    add(int(idx[k]), int(idx[c]))
            how = "gps"
            # photos without GPS: their sequence neighbours on a wider window
            for k, i in enumerate(order):
                if not has_gps[i]:
                    for j in order[max(0, k - 10) : k + 11]:
                        add(i, j)
    out = sorted(pairs)
    return [(names[metas[i].key], names[metas[j].key]) for i, j in out], how


# ------------------------------------------------------------------------------- models


def combine_models(models: list[SparseModel]) -> SparseModel:
    """Models already in one frame as one model (point ids renumbered, first model's cameras)."""
    out = SparseModel()
    ids, xyz, rgb, err = [], [], [], []
    next_id = 1
    for m in models:
        for cid, cam in m.cameras.items():
            out.cameras.setdefault(cid, cam)
        order = np.argsort(m.point_ids, kind="stable")
        sorted_ids = m.point_ids[order]
        new_ids = np.arange(next_id, next_id + len(m.point_ids), dtype=np.int64)
        ids.append(new_ids)
        next_id += len(m.point_ids)
        xyz.append(m.xyz)
        rgb.append(m.rgb)
        err.append(m.error)
        for iid, im in m.images.items():
            old = im.point3D_ids
            if len(sorted_ids) == 0:
                im.point3D_ids = np.full(len(old), -1, np.int64)
            else:
                pos = np.clip(np.searchsorted(sorted_ids, old), 0, len(sorted_ids) - 1)
                hit = (old >= 0) & (sorted_ids[pos] == old)
                im.point3D_ids = np.where(hit, new_ids[order[pos]], -1).astype(np.int64)
            out.images[iid] = im
    if ids:
        out.set_points(np.concatenate(ids), np.concatenate(xyz), np.concatenate(rgb), np.concatenate(err))
    return out


def three_quaternion(R_grid: np.ndarray) -> list[float]:
    """A COLMAP world(grid)-to-camera rotation as the three.js camera quaternion in the local frame
    (data-conventions 1 and 3: Y up, X east, Z south; the camera looks along its -Z, +Y up)."""
    to_local = np.array([[1.0, 0, 0], [0, 0, 1.0], [0, -1.0, 0]])  # (e, n, u) -> (x, y, z)
    right, down, fwd = R_grid[0], R_grid[1], R_grid[2]
    M = np.column_stack([to_local @ right, to_local @ (-down), to_local @ (-fwd)])
    w, x, y, z = rotmat_to_qvec(M)
    return [round(float(v), 7) for v in (x, y, z, w)]


def write_sparse(
    folder: Path,
    model: SparseModel,
    grid: C.GridFrame,
    enu: C.EnuFrame,
    heights: dict[str, Any],
    georeferenced: bool = True,
) -> None:
    """``sparse/``: the model in the grid frame as COLMAP text, plus ``frame.json``."""
    m = model.copy()
    for im in m.images.values():
        im.name = im.name.replace("%", "%25").replace(" ", "%20")
    m.write_text(folder)
    atomic_write_json(
        folder / "frame.json",
        {
            "schema": "aio.photo-frame/1",
            "frame": "grid",
            "axes": "x east, y north, z up (project CRS grid), metres from origin",
            "crs": C.crs_record(grid.crs),
            "origin": list(grid.origin),
            "enu": enu.record(),
            "heights": heights,
            "georeferenced": georeferenced,
            "names": "photo keys; space written as %20 and percent as %25",
        },
    )


def read_sparse(folder: Path) -> tuple[SparseModel, dict[str, Any]]:
    try:
        frame = json.loads((folder / "frame.json").read_text("utf-8"))
    except (OSError, ValueError) as e:
        raise JobError(f"The run's sparse model has no frame record: {e}") from e
    m = SparseModel.read_text(folder)
    for im in m.images.values():
        im.name = im.name.replace("%20", " ").replace("%25", "%")
    return m, frame


def enu_to_grid_model(model: SparseModel, enu: C.EnuFrame, grid: C.GridFrame) -> SparseModel:
    m = model.copy()
    conv = lambda p: C.enu_to_grid(enu, grid, p)  # noqa: E731
    _convert_model(m, conv)
    return m


def grid_to_enu_model(model: SparseModel, enu: C.EnuFrame, grid: C.GridFrame) -> SparseModel:
    m = model.copy()
    conv = lambda p: C.grid_to_enu(enu, grid, p)  # noqa: E731
    _convert_model(m, conv)
    return m


def _convert_model(m: SparseModel, conv) -> None:
    ids = sorted(m.images)
    if ids:
        cs = np.array([m.images[i].centre for i in ids])
        rs = np.array([m.images[i].R for i in ids])
        c2, r2 = C.transform_rotations(conv, cs, rs)
        for k, i in enumerate(ids):
            m.images[i].set_pose(r2[k], c2[k])
    if len(m.xyz):
        m.xyz = conv(m.xyz)


def nadir_only_warning(model: SparseModel) -> str | None:
    """A block flown at one height looking straight down cannot separate focal length from height."""
    if len(model.images) < 3:
        return None
    cs = np.array([im.centre for im in model.images.values()])
    tilt = [
        math.degrees(math.acos(min(1.0, abs(float(im.R[2] @ [0, 0, -1.0]))))) for im in model.images.values()
    ]
    zr = float(np.ptp(cs[:, 2]))
    span = float(np.ptp(cs[:, :2], axis=0).max()) or 1.0
    if max(tilt) < 10 and zr < 0.02 * span:
        return (
            "Nadir photos from one flying height: heights depend on the camera calibration. "
            "Add ground control, or fly an oblique or second-height pass, for reliable heights."
        )
    return None


# ------------------------------------------------------------------------------- the pipeline


class PhotoAlign:
    name = "photo.align"
    title = "Align photos"
    description = "Drone photos to calibrated cameras and a sparse model, georeferenced by GNSS."
    keys = frozenset({"photos", "run", "preset", "matching", "mapper", "gnss", "ppk", "crs", "maxImageSize"})
    choices = {  # noqa: RUF012 - read only
        "preset": frozenset({"fast", "standard", "high"}),
        "matching": frozenset({"auto", "gps", "sequential", "exhaustive"}),
        "mapper": frozenset({"auto", "global", "incremental"}),
        "gnss": frozenset({"auto", "rtk", "standard", "ignore"}),
    }
    #: The alignment engine; tests replace it with an engine over a known scene.
    engine_factory = staticmethod(load_engine)

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        known_keys(params, set(self.keys), self.name)
        if params.get("preset") is None or params.get("photos") is None:
            raise JobError(
                f"{self.name} needs: "
                + ", ".join(k for k in ("photos", "preset") if params.get(k) is None)
                + "."
            )
        for key, allowed in self.choices.items():
            if key in params and params[key] not in allowed:
                raise JobError(f"{key} must be one of: {', '.join(sorted(allowed))}.")
        src = params["photos"]
        if not isinstance(src, dict) or set(src) not in ({"layer"}, {"folders"}):
            raise JobError("photos must be { layer } or { folders }.")
        if "folders" in src and (
            not isinstance(src["folders"], list)
            or not src["folders"]
            or not all(isinstance(f, str) and f for f in src["folders"])
        ):
            raise JobError("photos.folders must be a list of folders.")
        if "layer" in src and not (isinstance(src["layer"], str) and src["layer"]):
            raise JobError("photos.layer must be a layer id.")
        if "run" in params and not (isinstance(params["run"], str) and RUN_ID.match(params["run"])):
            raise JobError("run must be letters, digits, dot, dash or _.")
        mis = params.get("maxImageSize")
        if mis is not None and (isinstance(mis, bool) or not isinstance(mis, int) or not 320 <= mis <= 20000):
            raise JobError("maxImageSize must be a whole number between 320 and 20000.")
        if params.get("crs") is not None:
            C.crs_of(params["crs"])
        if params.get("ppk") is not None and not (isinstance(params["ppk"], str) and params["ppk"]):
            raise JobError("ppk must be the path of a CSV file.")
        return dict(params)

    def inputs(self, params: dict[str, Any]) -> list[str]:
        src = params["photos"]
        out = list(src.get("folders") or [])
        if params.get("ppk"):
            out.append(params["ppk"])
        return out

    def plan(self, params: dict[str, Any]) -> list[Step]:
        weights = {
            "inspect": 0.5,
            "features": 3,
            "match": 4,
            "sfm": 3,
            "georef": 1,
            "report": 0.5,
            "commit": 0.2,
        }
        fns = {
            "inspect": self._inspect,
            "features": self._features,
            "match": self._match,
            "sfm": self._sfm,
            "georef": self._georef,
            "report": self._report,
            "commit": self._commit,
        }
        titles = {
            "inspect": "Read the photos",
            "features": "Find features",
            "match": "Match photos",
            "sfm": "Structure from motion",
            "georef": "Georeference",
            "report": "Report",
            "commit": "Save the run",
        }
        return [Step(s, titles[s], staged(s, fns[s]), weights[s]) for s in STAGES]

    # ---- helpers shared by the steps
    def _engine(self, ctx: StepContext) -> SfmEngine:
        return self.engine_factory()

    def _state(self, ctx: StepContext) -> dict[str, Any]:
        return RunState(ctx).load()

    def _metas(self, ctx: StepContext) -> list[PhotoMeta]:
        data = json.loads(ctx.stage("work/photos.json").read_text("utf-8"))
        return [meta_from(r) for r in data["photos"]]

    def _engine_job(self, ctx: StepContext, metas: list[PhotoMeta]) -> EngineJob:
        info = json.loads(ctx.stage("work/photos.json").read_text("utf-8"))
        limit = memory_limit(*memory_status())
        return EngineJob(
            work=ctx.stage("work/engine/.keep").parent,
            image_root=Path(info["imageRoot"]),
            images=[EngineImage(m.key, info["names"][m.key], info["groupOf"][m.key]) for m in metas],
            groups=[EngineGroup(**g) for g in info["groups"]],
            max_image_size=int(info["maxImageSize"]),
            max_features=int(info["maxFeatures"]),
            threads=feature_threads(info, limit),
            first_octave=first_octave(int(info["maxImageSize"])),
            memory_limit_bytes=limit,
            seed=0,
            check=ctx.check,
            log=lambda msg: ctx.log(msg),
        )

    # ---- inspect
    def _inspect(self, ctx: StepContext) -> dict[str, Any]:
        params = ctx.params
        manifest = read_manifest(ctx.project)
        listed, extra = photo_list(ctx, params)
        if not listed:
            raise JobError("No photos were found (JPEG, TIFF or PNG).")
        metas: list[PhotoMeta] = []
        for k, (key, path) in enumerate(listed):
            ctx.check()
            m = read_photo(key, path)
            if key in extra:
                layer_meta(m, extra[key], manifest)
            metas.append(m)
            ctx.progress((k + 1) / len(listed), f"{k + 1} of {len(listed)} photos")
        if params.get("ppk"):
            n = apply_ppk(metas, read_ppk(ctx.input(params["ppk"])))
            ctx.log(f"PPK positions for {n} photos.")
        insp = inspect_photos(metas)
        ok = insp.photos
        if len(ok) < 3:
            raise JobError(f"Only {len(ok)} photos can be used; alignment needs at least 3.")
        gnss = params.get("gnss", "auto")
        H, heights, h_warn = heights_rule(ok, manifest, gnss)
        crs = choose_crs(params, manifest, ok)
        located = [i for i, m in enumerate(ok) if m.has_gps and not np.isnan(H[i])]
        if located:
            lon0 = float(np.median([ok[i].lon for i in located]))
            lat0 = float(np.median([ok[i].lat for i in located]))
            rel = [ok[i].rel_alt for i in located if ok[i].rel_alt is not None]
            h0 = float(np.median([H[i] for i in located]) - (np.median(rel) if rel else 0.0))
        else:
            lon0, lat0, h0 = 0.0, 0.0, 0.0
        if manifest.get("origin") and manifest.get("crs"):
            origin = tuple(float(v) for v in manifest["origin"])
        elif located:
            e, n = C.geodetic_to_crs(crs, [lon0], [lat0])
            origin = (round(float(e[0])), round(float(n[0])), round(h0))
        else:
            origin = (0.0, 0.0, 0.0)
        # camera groups and engine names
        groups: dict[tuple, dict[str, Any]] = {}
        group_of: dict[str, int] = {}
        for m in ok:
            key = m.camera_key()
            if key not in groups:
                gid = len(groups) + 1
                groups[key] = {
                    "id": gid,
                    "model": "OPENCV",
                    "width": m.width,
                    "height": m.height,
                    "params": initial_params(m),
                    "photos": 0,
                    "make": m.make,
                    "camModel": m.model,
                    "focalMm": m.focal_mm,
                }
            groups[key]["photos"] += 1
            group_of[m.key] = groups[key]["id"]
        paths = [m.path.resolve() for m in ok]
        try:
            root = Path(os.path.commonpath([str(p.parent) for p in paths]))
        except ValueError:
            raise JobError("The photos of one run must be on one drive.") from None
        names = {m.key: p.relative_to(root).as_posix() for m, p in zip(ok, paths, strict=True)}
        spaced = [n for n in names.values() if " " in n]
        if spaced:
            raise JobError(
                f'Photo names with spaces cannot be aligned yet ("{spaced[0]}"); rename the files or folders.'
            )
        longest = max(max(m.width, m.height) for m in ok)
        share, feats = PRESETS[params["preset"]]
        max_size = int(params.get("maxImageSize") or max(640, round(longest * share)))
        run = params.get("run") or datetime.now(UTC).strftime("%Y%m%d-%H%M")
        if (ctx.project / run_dir(run) / "run.json").exists() and not params.get("run"):
            run = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
        atomic_write_json(
            ctx.stage("work/photos.json"),
            {
                "photos": [meta_record(m) for m in ok],
                "heights": [None if np.isnan(h) else float(h) for h in H],
                "names": names,
                "groupOf": group_of,
                "groups": [
                    {k: g[k] for k in ("id", "model", "width", "height", "params")} for g in groups.values()
                ],
                "imageRoot": str(root),
                "maxImageSize": max_size,
                "maxFeatures": feats,
            },
        )
        state = {
            "schema": RUN_SCHEMA,
            "id": run,
            "createdAt": now_iso(),
            "status": "aligning",
            "preset": params["preset"],
            "photos": {"source": params["photos"], "count": len(metas), "rejected": insp.rejected},
            "cameras": [
                {
                    "id": f"cam{g['id']}",
                    **({"make": g["make"][:120]} if g["make"] else {}),
                    **({"model": g["camModel"][:120]} if g["camModel"] else {}),
                    "widthPx": g["width"],
                    "heightPx": g["height"],
                    **({"focalMm": float(g["focalMm"])} if g["focalMm"] else {}),
                    "calibration": "OPENCV",
                    "photos": g["photos"],
                }
                for g in groups.values()
            ],
            "crs": C.crs_record(crs),
            "heights": heights,
            "settings": dict(params),
            "stages": [{"name": s, "state": "done" if s == "inspect" else "pending"} for s in STAGES],
            "outputs": {"layers": [], "tilesets": [], "files": []},
            "versions": {"pack": __version__},
            "hardware": hardware_probe(ctx.project),
            "warnings": (insp.warnings + h_warn)[:1000],
            "frames": {"enu": {"lon": lon0, "lat": lat0, "h": h0}, "origin": list(origin)},
        }
        state["stages"][0]["state"] = "running"
        RunState(ctx).save(state)
        RunState(ctx).write_project(state)
        for w in insp.warnings + h_warn:
            ctx.log(w, "warn")
        return {"run": run, "photos": len(ok), "rejected": len(insp.rejected), "groups": len(groups)}

    # ---- features
    def _features(self, ctx: StepContext) -> dict[str, Any]:
        metas = self._metas(ctx)
        job = self._engine_job(ctx, metas)
        need = len(metas) * job.max_features * 160 * 2
        free = shutil.disk_usage(job.work).free
        if free < need:
            raise JobError(
                f"Finding features needs {need / 1e9:.1f} GB free on {job.work.anchor or job.work}, has {free / 1e9:.1f} GB."
            )
        eng = self._engine(ctx)
        res = eng.features(job, lambda f, msg=None: ctx.progress(f, msg))
        st = RunState(ctx)
        data = st.load()
        data.setdefault("versions", {}).update({k: str(v)[:80] for k, v in eng.versions().items()})
        st.save(data)
        return {**res, "_memoryPeakBytes": job.memory_peak.get("features", 0)}

    # ---- match
    def _match(self, ctx: StepContext) -> dict[str, Any]:
        metas = self._metas(ctx)
        info = json.loads(ctx.stage("work/photos.json").read_text("utf-8"))
        H = np.array([np.nan if h is None else h for h in info["heights"]], dtype=np.float64)
        pairs, how = choose_pairs(metas, H, ctx.params.get("matching", "auto"), info["names"])
        ctx.log(f"{len(pairs)} photo pairs chosen by {how}.")
        job = self._engine_job(ctx, metas)
        res = self._engine(ctx).match(job, pairs, lambda f, msg=None: ctx.progress(f, msg))
        return {**res, "how": how, "_memoryPeakBytes": job.memory_peak.get("match", 0)}

    # ---- sfm
    def _sfm(self, ctx: StepContext) -> dict[str, Any]:
        metas = self._metas(ctx)
        job = self._engine_job(ctx, metas)
        eng = self._engine(ctx)
        mapper = ctx.params.get("mapper", "auto")
        first = "incremental" if mapper == "incremental" else "global"
        res = eng.map(job, first, lambda f, msg=None: ctx.progress(0.9 * f if mapper == "auto" else f, msg))
        best = max((m.get("images", 0) for m in res.get("models", [])), default=0)
        used = first
        if mapper == "auto" and best < MIN_REGISTERED_GLOBAL * len(metas):
            ctx.log(f"The global mapper placed {best} of {len(metas)} photos; trying the incremental mapper.")
            res2 = eng.map(job, "incremental", lambda f, msg=None: ctx.progress(0.9 + 0.1 * f, msg))
            best2 = max((m.get("images", 0) for m in res2.get("models", [])), default=0)
            if best2 > best:
                res, used = res2, "incremental"
        mem = max(job.memory_peak.values(), default=0)
        models = [m["path"] if isinstance(m, dict) else m for m in res.get("models", [])]
        if not models:
            raise JobError("Structure from motion found no model: the photos do not overlap enough.")
        return {"models": models, "mapper": used, "_memoryPeakBytes": mem}

    # ---- georef
    def _georef(self, ctx: StepContext) -> dict[str, Any]:
        metas = self._metas(ctx)
        info = json.loads(ctx.stage("work/photos.json").read_text("utf-8"))
        state = self._state(ctx)
        H = np.array([np.nan if h is None else h for h in info["heights"]], dtype=np.float64)
        by_name = {info["names"][m.key]: (i, m) for i, m in enumerate(metas)}
        fr = state["frames"]
        enu = C.EnuFrame(fr["enu"]["lon"], fr["enu"]["lat"], fr["enu"]["h"])
        gnss_mode = ctx.params.get("gnss", "auto")
        located = np.array([m.has_gps and not np.isnan(H[i]) for i, m in enumerate(metas)])
        gnss_enu = np.full((len(metas), 3), np.nan)
        if located.any():
            idx = np.nonzero(located)[0]
            gnss_enu[idx] = enu.from_geodetic(
                [metas[i].lon for i in idx], [metas[i].lat for i in idx], H[idx]
            )
        sig = np.array([m.gnss_sigma(gnss_mode) or (np.nan, np.nan) for m in metas], dtype=np.float64)
        placed: list[SparseModel] = []
        warnings: list[str] = []
        left_out: list[str] = []
        models = ctx.outputs("sfm")["models"]
        for k, path in enumerate(models):
            ctx.check()
            m = SparseModel.load(Path(path))
            for im in m.images.values():  # engine names to photo keys
                if im.name in by_name:
                    im.name = by_name[im.name][1].key
            keys = {m_.key: i for i, m_ in enumerate(metas)}
            ims = [
                im
                for im in m.images.values()
                if im.name in keys and located[keys[im.name]] and gnss_mode != "ignore"
            ]
            if len(ims) < 3:
                if k == 0 and gnss_mode == "ignore":
                    placed.append(m)  # not georeferenced: the SfM frame, for photo.georef with GCPs
                    warnings.append(
                        "GNSS positions were ignored: the model is not georeferenced until ground control adjusts it."
                    )
                    continue
                left_out += [im.name for im in m.images.values()]
                warnings.append(
                    f"{len(m.images)} photos ({_names(m)}) could not be joined to the others or placed by GNSS."
                )
                continue
            src = np.array([im.centre for im in ims])
            dst = gnss_enu[[keys[im.name] for im in ims]]
            s_h = sig[[keys[im.name] for im in ims], 0]
            thr = max(1.0, 4.0 * float(np.nanmedian(s_h)))
            sim, inl = B.similarity_ransac(src, dst, threshold=thr, sigma=np.nan_to_num(s_h, nan=3.0), seed=k)
            if (~inl).any():
                bad = [ims[j].name for j in np.nonzero(~inl)[0]]
                warnings.append(
                    f"{len(bad)} photos have a GPS position that disagrees with the model ({', '.join(bad[:5])})."
                )
            m.transform(*sim)
            placed.append(m)
            if k > 0:
                warnings.append(
                    f"{len(m.images)} photos ({_names(m)}) form a separate group, joined to the rest by GNSS only."
                )
        if not placed:
            raise JobError("No group of photos could be placed: too few photos with GPS positions aligned.")
        model = combine_models(placed)
        georeferenced = gnss_mode != "ignore"
        stats: dict[str, Any] = {}
        if georeferenced:
            keys = {m_.key: i for i, m_ in enumerate(metas)}
            priors = {}
            for iid, im in model.images.items():
                i = keys.get(im.name)
                if i is not None and located[i] and not np.isnan(sig[i, 0]):
                    priors[iid] = B.CameraPrior(gnss_enu[i], float(sig[i, 0]), float(sig[i, 1]))
            pts = B.select_points(model, per_image=300)
            res = B.bundle_adjust(
                model,
                pts,
                priors=priors,
                check=ctx.check,
                progress=lambda f: ctx.progress(0.9 * f, "Adjusting"),
            )
            B.refine_all_points(model)
            stats = {
                "iterations": res.iterations,
                "tiePoints": len(pts),
                "seconds": round(res.seconds, 1),
            }
        w = nadir_only_warning(model)
        if w:
            warnings.append(w)
        model.save_npz(ctx.stage("work/aligned-enu.npz"))
        atomic_write_json(
            ctx.stage("work/georef.json"),
            {"leftOut": left_out, "warnings": warnings, "georeferenced": georeferenced},
        )
        for msg in warnings:
            ctx.log(msg, "warn")
        return {
            "registered": len(model.images),
            "points": len(model.point_ids),
            "georeferenced": georeferenced,
            **stats,
        }

    # ---- report
    def _report(self, ctx: StepContext) -> dict[str, Any]:
        metas = self._metas(ctx)
        info = json.loads(ctx.stage("work/photos.json").read_text("utf-8"))
        state = self._state(ctx)
        geo = json.loads(ctx.stage("work/georef.json").read_text("utf-8"))
        model = SparseModel.load(ctx.stage("work/aligned-enu.npz"))
        fr = state["frames"]
        enu = C.EnuFrame(fr["enu"]["lon"], fr["enu"]["lat"], fr["enu"]["h"])
        grid = C.GridFrame(C.crs_of(state["crs"]), tuple(fr["origin"]))
        H = np.array([np.nan if h is None else h for h in info["heights"]], dtype=np.float64)
        keys = {m.key: i for i, m in enumerate(metas)}
        registered = {im.name for im in model.images.values()}
        rejected = list(state["photos"].get("rejected") or [])
        for m in metas:
            if m.key not in registered:
                reason = (
                    "Could not be joined to the other photos."
                    if m.key in geo["leftOut"]
                    else "Not enough matches with other photos."
                )
                rejected.append({"name": m.key, "reason": reason})
        grid_model = enu_to_grid_model(model, enu, grid) if geo["georeferenced"] else model
        mean_err = model.mean_reprojection_error()
        gsd = A.gsd_cm(model)
        # camera residuals to GNSS (grid frame)
        cam_res = None
        if geo["georeferenced"]:
            ids = [
                iid
                for iid, im in grid_model.images.items()
                if metas[keys[im.name]].has_gps and not np.isnan(H[keys[im.name]])
            ]
            if ids:
                adj = np.array([grid_model.images[i].centre for i in ids])
                gm = [metas[keys[grid_model.images[i].name]] for i in ids]
                gn = grid.from_geodetic(
                    [m.lon for m in gm], [m.lat for m in gm], [H[keys[m.key]] for m in gm]
                )
                cam_res = A.camera_residuals(adj, gn)
        warnings = [A.Warning_("other", w) for w in state.get("warnings", [])] + [
            A.Warning_("disconnected" if "group" in w or "joined" in w else "other", w)
            for w in geo["warnings"]
        ]
        if len(rejected) > len(state["photos"].get("rejected") or []):
            n = len(rejected) - len(state["photos"].get("rejected") or [])
            warnings.append(
                A.Warning_("unregistered", f"{n} photos could not be aligned; see the alignment report.")
            )
        # ground control measured through the GNSS-only cameras (none of it in the adjustment)
        points: list[A.PointResidual] = []
        gcp_path = ctx.project / run_dir(state["id"]) / "gcp.json"
        predictions: dict[str, list[dict[str, Any]]] = {}
        if gcp_path.is_file() and geo["georeferenced"]:
            gcp = G.read_gcp_file(gcp_path)
            points, predictions, unmeasured = measure_points(model, gcp, enu, grid, cam_res)
            warnings += A.point_warnings(points, (gsd or 0) / 100) + A.unmeasured_warnings(unmeasured)
            warnings.append(A.Warning_("other", "No ground control was used in this adjustment (GNSS only)."))
        if geo["georeferenced"] and not points:
            sh = np.nanmedian(
                [(m.gnss_sigma(ctx.params.get("gnss", "auto")) or (np.nan, np.nan))[0] for m in metas]
            )
            warnings.append(
                A.Warning_(
                    "gnss-height" if (state.get("heights") or {}).get("geoid") == "none" else "other",
                    f"No ground control: absolute accuracy is the GNSS accuracy (about {sh:.2f} m horizontally), "
                    "and heights follow the drone's altitude datum.",
                )
            )
        rep = A.report(
            A.ReportInput(
                run=state["id"],
                created_at=now_iso(),
                crs=state["crs"],
                heights=state.get("heights"),
                images_total=int(state["photos"]["count"]),
                images_registered=len(model.images),
                mean_reproj_px=mean_err,
                gsd_cm=gsd,
                points=points,
                cameras=cam_res,
                warnings=warnings,
            )
        )
        align = {
            "schema": "aio.photo-align/1",
            "run": state["id"],
            "createdAt": now_iso(),
            "engine": state.get("versions", {}),
            "mapper": ctx.outputs("sfm").get("mapper"),
            "matching": ctx.outputs("match").get("how"),
            "pairs": {k: ctx.outputs("match").get(k) for k in ("pairs", "matched", "verified")},
            "images": {"total": int(state["photos"]["count"]), "registered": len(model.images)},
            "registered": sorted(registered),
            "rejected": rejected,
            "meanReprojPx": round(mean_err, 4),
            "points": len(model.point_ids),
            "meanTrackLength": round(float(model.track_lengths().mean()), 2) if len(model.point_ids) else 0,
            "gsdCm": gsd,
            "cameraResiduals": cam_res,
            "calibration": [
                {"id": f"cam{c.id}", "model": c.model, "params": [round(float(v), 8) for v in c.params]}
                for c in grid_model.cameras.values()
            ],
            "georeferenced": geo["georeferenced"],
            "warnings": [w.message for w in warnings],
        }
        atomic_write_json(ctx.stage("out/report/align.json"), align)
        atomic_write_json(ctx.stage("out/report/accuracy.json"), rep)
        if predictions:
            atomic_write_json(ctx.stage("work/predictions.json"), predictions)
        write_sparse(
            ctx.stage("out/sparse/.keep").parent,
            grid_model,
            grid,
            enu,
            state.get("heights") or {},
            geo["georeferenced"],
        )
        atomic_write_json(ctx.stage("out/cameras-sfm.json"), cameras_sfm(grid_model, state, info))
        atomic_write_json(
            ctx.stage("out/sparse/photos.json"), photos_record(metas, info, H, ctx.params.get("gnss", "auto"))
        )
        data = RunState(ctx).load()
        data["photos"]["registered"] = len(model.images)
        data["photos"]["rejected"] = rejected
        data["accuracy"] = A.summary(rep)
        data["cameras"] = [
            {**g, "calibration": grid_model.cameras[int(g["id"][3:])].model}
            if int(g["id"][3:]) in grid_model.cameras
            else g
            for g in data["cameras"]
        ]
        RunState(ctx).save(data)
        return {
            "registered": len(model.images),
            "rejected": len(rejected),
            "meanReprojPx": round(mean_err, 3),
        }

    # ---- commit
    def _commit(self, ctx: StepContext) -> dict[str, Any]:
        st = RunState(ctx)
        data = st.load()
        run = data["id"]
        base = run_dir(run)
        files = []
        commit_tree(ctx, "out/sparse", f"{base}/sparse")
        files.append(f"{base}/sparse/")
        moves = [
            ("out/report/align.json", f"{base}/report/align.json"),
            ("out/report/accuracy.json", f"{base}/report/accuracy.json"),
            ("out/cameras-sfm.json", f"{base}/cameras-sfm.json"),
        ]
        commit_files(ctx, moves)
        files += [p for _, p in moves]
        db = ctx.stage("work/engine/database.db")
        if db.exists():
            commit_files(ctx, [("work/engine/database.db", f"{base}/work/database.db")], announce=False)
        commit_files(ctx, [("work/aligned-enu.npz", f"{base}/work/aligned-enu.npz")], announce=False)
        pred = ctx.stage("work/predictions.json")
        if pred.exists():
            merge_predictions(ctx.project / base / "gcp.json", json.loads(pred.read_text("utf-8")))
        data["status"] = "aligned"
        data["outputs"]["files"] = sorted(set(data["outputs"].get("files", []) + files))
        data["updatedAt"] = now_iso()
        for s in data["stages"]:
            if s["name"] == "commit":
                s.update({"state": "done", "finishedAt": now_iso()})
        data.pop("frames", None)
        atomic_write_json(ctx.out(f"{base}/run.json"), _clean_run(data))
        ctx.artifact(f"{base}/run.json")
        return {"run": run}


def _clean_run(data: dict[str, Any]) -> dict[str, Any]:
    """``run.json`` without the job's private keys."""
    return {k: v for k, v in data.items() if not k.startswith("_")}


def _names(m: SparseModel, n: int = 3) -> str:
    names = sorted(im.name for im in m.images.values())
    return ", ".join(names[:n]) + (" and others" if len(names) > n else "")


def cameras_sfm(grid_model: SparseModel, state: dict[str, Any], info: dict[str, Any]) -> dict[str, Any]:
    """``cameras-sfm.json``: refined poses for **Use refined poses** (G4), local frame."""
    items = []
    for im in sorted(grid_model.images.values(), key=lambda i: i.name):
        cam = grid_model.cameras[im.camera_id]
        c = im.centre
        hfov = 2 * math.degrees(math.atan(cam.width / (2 * cam.canonical()[0])))
        items.append(
            {
                "photo": im.name,
                "pos": [round(float(c[0]), 4), round(float(c[2]), 4), round(float(-c[1]), 4)],
                "q": three_quaternion(im.R),
                "lens": {
                    "model": "pinhole",
                    "hfovDeg": round(hfov, 4),
                    "aspect": round(cam.width / cam.height, 6),
                },
                "camera": f"cam{cam.id}",
            }
        )
    return {
        "schema": "aio.photo-cameras/1",
        "run": state["id"],
        "crs": state["crs"],
        "origin": state["frames"]["origin"],
        "frame": "local (data-conventions section 1: x east, y up, z south)",
        "calibration": [
            {
                "id": f"cam{c.id}",
                "model": c.model,
                "width": c.width,
                "height": c.height,
                "params": [float(v) for v in c.params],
            }
            for c in grid_model.cameras.values()
        ],
        "cameras": items,
    }


def photos_record(metas: list[PhotoMeta], info: dict[str, Any], H: np.ndarray, gnss: str) -> dict[str, Any]:
    """``sparse/photos.json``: where each photo is (image root and name) and its GNSS prior, so
    ``photo.georef`` and ``photo.products`` work without the job's staging."""
    out: dict[str, Any] = {}
    for i, m in enumerate(metas):
        sig = m.gnss_sigma(gnss)
        rec: dict[str, Any] = {"name": info["names"][m.key], "width": m.width, "height": m.height}
        if m.has_gps and not np.isnan(H[i]) and sig:
            rec["gnss"] = {"lon": m.lon, "lat": m.lat, "h": float(H[i]), "sigmaH": sig[0], "sigmaV": sig[1]}
        out[m.key] = rec
    return {"schema": "aio.photo-list/1", "imageRoot": info["imageRoot"], "photos": out}


def measure_points(model: SparseModel, gcp: dict[str, Any], enu: C.EnuFrame, grid: C.GridFrame, cam_res):
    """Triangulate every point from its confirmed marks through ``model`` (ENU); residuals in the
    grid frame; predictions for every point."""
    geo = G.points_to_geodetic(gcp)
    by_name = {im.name: im.id for im in model.images.values()}
    points: list[A.PointResidual] = []
    surveyed_enu: dict[str, np.ndarray] = {}
    for p in gcp.get("points") or []:
        lon, lat, h = geo[p["id"]]
        surveyed_enu[p["id"]] = enu.from_geodetic([lon], [lat], [h])[0]
        if p.get("disabled"):
            continue
        marks = [(by_name[ph], xy) for ph, xy in G.usable_marks(p) if ph in by_name]
        if len(marks) < 2:
            points.append(
                A.PointResidual(p["id"], p["role"], np.array([np.nan] * 3), 0.0, len(marks), used=False)
            )
            continue
        X, err = B.triangulate(model, marks)
        d = grid.from_geodetic(*enu.to_geodetic(X[None]))[0] - grid.from_geodetic([lon], [lat], [h])[0]
        points.append(A.PointResidual(p["id"], p["role"], d, err, len(marks), used=False))
    unmeasured = [p for p in points if np.isnan(p.d).any()]
    points = [p for p in points if not np.isnan(p.d).any()]
    sigma = 0.5
    if cam_res:
        sigma = max(
            0.05, float(cam_res.get("rmseHorizontalM", 0.5)), float(cam_res.get("rmseVerticalM", 0.5)) / 2
        )
    preds = G.predict_marks(model, surveyed_enu, sigma)
    return points, preds, unmeasured


def merge_predictions(path: Path, predictions: dict[str, list[dict[str, Any]]]) -> None:
    """Put fresh predictions into the run's ``gcp.json`` (only ``predicted``; marks untouched)."""
    if not path.is_file():
        return
    data = json.loads(path.read_text("utf-8"))
    for p in data.get("points") or []:
        if p.get("id") in predictions:
            p["predicted"] = predictions[p["id"]][:10_000]
    atomic_write_json(path, data)
