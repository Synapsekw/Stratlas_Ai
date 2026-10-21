"""photo.align: drone photos to calibrated cameras and a georeferenced sparse model.

Stages (``PhotoStageName``; each a resumable job step):

    inspect   EXIF and DJI XMP of every photo (GPS, altitudes, gimbal, RTK flag and accuracy,
              camera); reject what cannot be used, warn about what may hurt; camera groups;
              the run's CRS, height rule and frames; ``run.json`` (status ``aligning``); the ODM
              project ``photogrammetry/<run>/odm/`` (hard links to the photos, and ``geo.txt``
              when our positions or heights differ from what ODM would read itself)
    sfm       ODM (ADR 0012) from its first stage to the end of OpenSfM
    georef    ODM's reconstruction into our model, in the run's local ENU frame
    report    report/align.json, report/accuracy.json (GNSS only, checkpoints measured when a
              gcp.json is there), mark predictions, cameras-sfm.json
    commit    everything into ``photogrammetry/<run>/``; ``run.json`` last

Photos are read in place and never written: ODM sees hard links (or copies) of them.

Run files (data-conventions section 21), every JSON file with its ``schema``:

- ``sparse/`` COLMAP text model in the **grid frame**: the run's projected CRS minus
  ``frame.json`` ``origin`` (x east, y north, z up, metres). Image names are photo keys, the
  percent sign and white space percent-encoded: ``%25``, ``%20`` (``encode_name``).
- ``sparse/frame.json`` (``aio.photo-frame/1``): ``crs``, ``origin``, the local ENU frame,
  ``heights``, ``georeferenced``.
- ``sparse/photos.json`` (``aio.photo-list/1``): ``imageRoot`` and per photo key its ``name``
  below it (the path COLMAP read), size and GNSS prior.
- ``cameras-sfm.json`` (``aio.photo-cameras/1``): refined poses in the project's local frame.
- ``report/align.json`` (``aio.photo-align/1``) and ``report/accuracy.json``.

Photo keys are the photos layer's photo ids, or the path below the chosen folder (the folder's
own name first when there are several); names may hold spaces and any letters.

Threads, GPU and memory for ODM: ``odm.runner.machine`` (ADR 0012).
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
from dataclasses import replace
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
from .corrections import corrected_pos, placed_by_hand, read_offsets
from .exif import PhotoMeta, apply_ppk, inspect_photos, list_folder_photos, read_photo, read_ppk
from .model import SparseModel, rotmat_to_qvec
from .odm import flags as OF
from .odm import project as OP
from .odm import runner as OR
from .odm.reconstruction import convert_model, read_reconstruction
from .proctree import memory_status

RUN_SCHEMA = "aio.photo-run/1"
ALIGN_SCHEMA = "aio.photo-align/1"
CAMERAS_SCHEMA = "aio.photo-cameras/1"
FRAME_SCHEMA = "aio.photo-frame/1"
LIST_SCHEMA = "aio.photo-list/1"
RUN_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
STAGES = ("inspect", "sfm", "georef", "report", "commit")
#: A job whose inspect step ran in an earlier version laid out no ODM project (no ``names.json``).
OLD_JOB = (
    "This job was started by an earlier version of the processing engine. Remove it from the "
    "Processing list and use Create maps from photos again (a new run)."
)
#: one-sigma accuracy (metres) written to geo.txt when GNSS is ignored: ODM barely weighs it
IGNORED_GNSS_SIGMA_M = (50.0, 50.0)


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
    supported = (plat, arch) == ("win32", "x64")  # ODM ships for Windows x64 only
    return {
        "platform": plat,
        "arch": arch,
        "cpu": {"model": (platform.processor() or "unknown")[:200], "cores": os.cpu_count() or 1},
        "memoryBytes": mem,
        "freeDiskBytes": int(shutil.disk_usage(project).free),
        "gpus": [],
        "cuda": OR.nvcuda_present(),
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
    """``(key, path)`` of the run's photos, and per-key extras from a photos layer: its records with
    ``pos`` corrected by orientation.json (``corrections``) and ``placed_by_hand`` set when the place
    is a hand placement (moved or pinned)."""
    src = params["photos"]
    if "folders" in src:
        folders = [Path(f) if Path(f).is_absolute() else ctx.project / f for f in src["folders"]]
        return list_folder_photos(folders), {}
    manifest = read_manifest(ctx.project)
    layer = next((ly for ly in manifest.get("layers", []) if ly.get("id") == src["layer"]), None)
    if layer is None or layer.get("kind") != "photos":
        raise JobError(f'The project has no photos layer "{src["layer"]}".')
    offsets = read_offsets(ctx.project, lambda msg: ctx.log(msg, "warn"))
    out, extra = [], {}
    for item in layer.get("items") or []:
        ref = item.get("src") or {}
        rel = ref.get("path") or (f"assets/sha256/{ref['hash']}" if ref.get("hash") else None)
        if not rel:
            continue
        path = safe_project_path(ctx.project, rel)
        key = str(item.get("id") or rel)
        out.append((key, path))
        off = offsets.get((str(src["layer"]), str(item.get("id"))))
        pos = corrected_pos(item, off)
        extra[key] = {**item, **({"pos": pos} if pos else {}), "placed_by_hand": placed_by_hand(item, off)}
    if not out:
        raise JobError("The photos layer has no photos.")
    return out, extra


def layer_meta(meta: PhotoMeta, item: dict[str, Any], manifest: dict[str, Any]) -> None:
    """Position from the layer's (corrected) pose for a review copy without EXIF GPS or a photo
    placed by hand (Edit position, a pin); field of view from the layer's lens."""
    by_layer = not meta.has_gps or item.get("placed_by_hand")
    if by_layer and item.get("pos") and manifest.get("crs") and manifest.get("origin"):
        o = manifest["origin"]
        x, y, z = item["pos"]
        lon, lat = C.crs_to_geodetic(C.crs_of(manifest["crs"]), [o[0] + x], [o[1] - z])
        meta.lon, meta.lat = float(lon[0]), float(lat[0])
        # the pose height is the project height (datum offset or take-off rule already applied):
        # kept apart from the photo's own altitudes so heights_rule does not convert it again
        meta.layer_h = float(o[2] + y)
        meta.from_layer = True  # ODM cannot read it from the photo: geo.txt must carry it
    lens = item.get("lens") or {}
    if not meta.focal35 and lens.get("hfovDeg"):
        meta.focal35 = 18.0 / math.tan(math.radians(float(lens["hfovDeg"])) / 2)


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
            "from_layer",
            "layer_h",
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


def estimate_gsd_cm(metas: list[PhotoMeta]) -> float | None:
    """The photos' ground resolution before alignment, cm per pixel: the median over the photos
    with a height above take-off and a 35 mm equivalent focal length (the 35 mm frame's diagonal is
    43.27 mm, so a pixel spans 43.27 / (f35 x image diagonal in pixels) radians). None without them."""
    values = [
        m.rel_alt * 100.0 * 43.27 / (m.focal35 * math.hypot(m.width, m.height))
        for m in metas
        if m.rel_alt and m.rel_alt > 0 and m.focal35 and m.focal35 > 0 and m.width and m.height
    ]
    return float(np.median(values)) if values else None


def reported_gsd_cm(run_folder: Path) -> float | None:
    """The photos' GSD that ``photo.align`` measured (``report/align.json``), if any."""
    try:
        v = json.loads((run_folder / "report" / "align.json").read_text("utf-8-sig")).get("gsdCm")
    except (OSError, ValueError, AttributeError):
        return None
    ok = isinstance(v, int | float) and not isinstance(v, bool) and 0.1 <= v <= 1000
    return float(v) if ok else None


# ------------------------------------------------------------------------------- heights and frames


def heights_rule(
    metas: list[PhotoMeta], manifest: dict[str, Any], gnss: str
) -> tuple[np.ndarray, dict[str, Any], list[str]]:
    """Each photo's height in the run's height system, the ``PhotoHeights`` record and warnings.

    A photo the photos layer placed (a review copy without GPS) takes its pose's height as it is:
    that is a project height already, in the project's height system. The photos with their own
    altitudes follow :func:`own_heights`.
    """
    placed = np.array([m.layer_h is not None for m in metas], dtype=bool)
    if not placed.any():
        return own_heights(metas, manifest, gnss)
    H = np.array([np.nan if m.layer_h is None else float(m.layer_h) for m in metas], dtype=np.float64)
    own = [m for m, p in zip(metas, placed, strict=True) if not p]
    if not own:
        rec = {"source": "orthometric", "geoid": "none", "note": "Heights of the project's photos layer."}
        return H, rec, []
    H_own, rec, warnings = own_heights(own, manifest, gnss)
    H[~placed] = H_own
    return H, rec, warnings


def own_heights(
    metas: list[PhotoMeta], manifest: dict[str, Any], gnss: str
) -> tuple[np.ndarray, dict[str, Any], list[str]]:
    """The heights of photos from their own altitudes, the ``PhotoHeights`` record and warnings.

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


def needs_geo(metas: list[PhotoMeta], H: np.ndarray, params: dict[str, Any]) -> bool:
    """Whether ODM must be told the positions (``geo.txt``): PPK positions, a GNSS mode other than
    ``auto``, positions from the photos layer (review copies carry no GPS of their own), or heights
    that are not the photos' own altitudes (RTK ellipsoidal heights converted, the project's
    vertical datum, relative heights filled in)."""
    if params.get("ppk") or params.get("gnss", "auto") != "auto":
        return True
    if any(m.from_layer and m.has_gps for m in metas):
        return True
    for i, m in enumerate(metas):
        if not m.has_gps or np.isnan(H[i]):
            continue
        if m.altitude is None or abs(float(H[i]) - float(m.altitude)) > 0.001:
            return True
    return False


def geo_rows(
    metas: list[PhotoMeta], H: np.ndarray, links_by_key: dict[str, str], gnss: str
) -> list[OP.GeoRow]:
    """One ``geo.txt`` row per photo with a GPS position and a height, by its link name in the ODM
    project; the accuracy is the GNSS prior's (very loose when GNSS is ignored)."""
    rows: list[OP.GeoRow] = []
    for i, m in enumerate(metas):
        if not m.has_gps or np.isnan(H[i]) or m.key not in links_by_key:
            continue
        sig = IGNORED_GNSS_SIGMA_M if gnss == "ignore" else m.gnss_sigma(gnss)
        if sig is None:
            continue
        link, h_acc, v_acc = links_by_key[m.key], float(sig[0]), float(sig[1])
        rows.append(
            OP.GeoRow(link, float(m.lon), float(m.lat), float(H[i]), m.yaw, m.pitch, m.roll, h_acc, v_acc)
        )
    return rows


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
        im.name = encode_name(im.name)
    m.write_text(folder)
    atomic_write_json(folder / "frame.json", frame_record(grid, enu, heights, georeferenced))


def engine_alias(name: str) -> str:
    """A photo name as a list split at white space can hold it: the percent sign and every white
    space or control character percent-encoded (UTF-8), so a space is ``%20`` and a percent sign
    ``%25``. Unique, and ``urllib.parse.unquote`` reverses it."""
    from urllib.parse import quote

    return "".join(quote(ch, safe="") if ch == "%" or ch.isspace() or ord(ch) < 32 else ch for ch in name)


def encode_name(name: str) -> str:
    """A photo key as an image name of the COLMAP text model, whose lines split at white space:
    the percent sign and white space percent-encoded (``%25``, ``%20``, ``%C2%A0``...;
    ``decode_name`` reverses it)."""
    return engine_alias(name)


def decode_name(name: str) -> str:
    from urllib.parse import unquote

    return unquote(name)


def frame_record(
    grid: C.GridFrame, enu: C.EnuFrame, heights: dict[str, Any], georeferenced: bool = True
) -> dict[str, Any]:
    """``sparse/frame.json`` (``aio.photo-frame/1``): the frame of the sparse model's coordinates."""
    return {
        "schema": FRAME_SCHEMA,
        "frame": "grid",
        "axes": "x east, y north, z up (project CRS grid), metres from origin",
        "crs": C.crs_record(grid.crs),
        "origin": [float(v) for v in grid.origin],
        "enu": enu.record(),
        "heights": heights,
        "georeferenced": georeferenced,
        "names": "photo keys; percent and white space percent-encoded (%25, %20)",
    }


def read_frame(folder: Path) -> dict[str, Any]:
    try:
        frame = json.loads((folder / "frame.json").read_text("utf-8"))
    except (OSError, ValueError) as e:
        raise JobError(f"The run's sparse model has no frame record: {e}") from e
    o = frame.get("origin") if isinstance(frame, dict) else None
    if not (isinstance(o, list) and len(o) == 3 and all(isinstance(v, int | float) for v in o)):
        raise JobError("The run's sparse/frame.json has no origin (three numbers).")
    if frame.get("frame", "grid") != "grid":
        raise JobError(
            f'The run\'s sparse model is in a frame this build does not read ("{frame["frame"]}").'
        )
    return frame


def read_sparse(folder: Path) -> tuple[SparseModel, dict[str, Any]]:
    """The run's sparse model (grid frame, image names decoded to photo keys) and ``frame.json``."""
    frame = read_frame(folder)
    m = SparseModel.read_text(folder)
    for im in m.images.values():
        im.name = decode_name(im.name)
    return m, frame


def read_photo_list(folder: Path) -> dict[str, Any]:
    """``sparse/photos.json`` (``aio.photo-list/1``), or an empty list when there is none."""
    p = folder / "photos.json"
    if not p.is_file():
        return {"imageRoot": None, "photos": {}}
    try:
        doc = json.loads(p.read_text("utf-8"))
    except (OSError, ValueError) as e:
        raise JobError(f"The run's photo list sparse/photos.json cannot be read: {e}") from e
    if not isinstance(doc, dict) or not isinstance(doc.get("photos"), dict):
        raise JobError("The run's photo list sparse/photos.json has no photos.")
    return doc


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


def group_cameras(model: SparseModel, group_of: dict[str, int]) -> None:
    """Number ODM's cameras by our camera groups (``cam<id>`` in run.json, align.json and
    cameras-sfm.json name the same lens), in place. Left as ODM numbered them when its cameras
    and our groups are not one to one."""
    ours: dict[int, set[int]] = {}
    for im in model.images.values():
        ours.setdefault(im.camera_id, set()).add(group_of.get(im.name, 0))
    new = {cid: next(iter(g)) for cid, g in ours.items() if len(g) == 1}
    if len(new) != len(model.cameras) or 0 in new.values() or len(set(new.values())) != len(new):
        return
    model.cameras = {new[cid]: replace(cam, id=new[cid]) for cid, cam in model.cameras.items()}
    for im in model.images.values():
        im.camera_id = new[im.camera_id]


def _convert_model(m: SparseModel, conv) -> None:
    convert_model(m, conv)


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
    #: accepted from older saved settings and ignored: ODM chooses matching and mapping itself
    IGNORED = ("matching", "mapper", "maxImageSize")

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
        weights = {"inspect": 0.5, "sfm": 10, "georef": 0.5, "report": 0.5, "commit": 0.2}
        fns = {
            "inspect": self._inspect,
            "sfm": self._sfm,
            "georef": self._georef,
            "report": self._report,
            "commit": self._commit,
        }
        titles = {
            "inspect": "Read the photos",
            "sfm": "Align the photos (ODM)",
            "georef": "Place the model",
            "report": "Report",
            "commit": "Save the run",
        }
        return [Step(s, titles[s], staged(s, fns[s]), weights[s]) for s in STAGES]

    def _state(self, ctx: StepContext) -> dict[str, Any]:
        """The run's state for the steps after inspect; a job begun by an earlier version is refused
        (the real folder: ``run_odm_dir`` may make a junction)."""
        state = RunState(ctx).load()
        if not (OP.odm_project_dir(ctx.project, state["id"]) / "names.json").is_file():
            raise JobError(OLD_JOB)
        return state

    def _metas(self, ctx: StepContext) -> list[PhotoMeta]:
        data = json.loads(ctx.stage("work/photos.json").read_text("utf-8"))
        return [meta_from(r) for r in data["photos"]]

    # ---- inspect
    def _inspect(self, ctx: StepContext) -> dict[str, Any]:
        OR.find_odm()  # a missing ODM fails before any work
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
        # camera groups and photo names
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
        # names: the path below the common folder (sparse/photos.json); ODM sees link names
        names = {m.key: p.relative_to(root).as_posix() for m, p in zip(ok, paths, strict=True)}
        run = params.get("run") or datetime.now(UTC).strftime("%Y%m%d-%H%M")
        if (ctx.project / run_dir(run) / "run.json").exists() and not params.get("run"):
            run = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
        odm_dir = OP.run_odm_dir(ctx.project, run)
        links, copies = OP.link_images(odm_dir, [(m.key, m.path) for m in ok])
        if copies:
            ctx.log(
                f"{copies} photos were copied into the ODM project (a link was not possible, e.g. another drive)."
            )
        geo = odm_dir / "geo.txt"
        before = geo.read_bytes() if geo.is_file() else None
        rows = (
            geo_rows(ok, H, {key: link for link, key in links.items()}, gnss)
            if needs_geo(ok, H, params)
            else []
        )
        if not rows and geo.exists():  # from an earlier attempt of this run: ODM reads the photos now
            geo.unlink()
        OP.write_geo(odm_dir, rows)
        after = geo.read_bytes() if geo.is_file() else None
        if after != before and ((odm_dir / "images.json").exists() or OP.has_alignment(odm_dir)):
            # ODM would reuse its photo database and alignment and never read the new positions
            OP.invalidate(odm_dir, ["images.json", *OP.GEOREF_INVALIDATE])
            ctx.log("The photo positions changed: ODM reads the photos and aligns them again.")
        ignored = [k for k in self.IGNORED if k in params]
        if ignored:
            ctx.log(f"ODM chooses matching and mapping itself; {', '.join(ignored)} are ignored.")
        atomic_write_json(
            ctx.stage("work/photos.json"),
            {
                "photos": [meta_record(m) for m in ok],
                "heights": [None if np.isnan(h) else float(h) for h in H],
                "names": names,
                "groupOf": group_of,
                "groups": [{k: g[k] for k in ("id", "model", "width", "height")} for g in groups.values()],
                "imageRoot": str(root),
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

    # ---- sfm
    def _sfm(self, ctx: StepContext) -> dict[str, Any]:
        state = self._state(ctx)
        run = state["id"]
        odm = OR.find_odm()
        mc = OR.machine()
        odm_dir = OP.run_odm_dir(ctx.project, run)
        geo = odm_dir / "geo.txt"
        gsd = estimate_gsd_cm(self._metas(ctx))
        flags = OF.align_flags(state["preset"], mc.use_gpu, mc.threads, geo if geo.is_file() else None, gsd)
        ctx.log(
            f"ODM {odm.version}: {mc.threads} threads, graphics card {'on' if mc.use_gpu else 'off'}"
            + (f", photos about {gsd:.1f} cm per pixel." if gsd else ".")
        )
        res = OR.run_odm(
            ctx, odm, odm_dir, flags, "dataset", "opensfm",
            ctx.project / run_dir(run) / "odm-logs" / f"{ctx.job.job_id}-sfm",
            rerun=False, use_gpu=mc.use_gpu,
        )  # fmt: skip
        data = RunState(ctx).load()
        data["engine"] = OR.engine_record(odm, res.gpu)
        data.setdefault("versions", {})["odm"] = odm.version
        RunState(ctx).save(data)
        return {"threads": mc.threads, "gpu": data["engine"]["gpu"]}

    # ---- georef
    def _georef(self, ctx: StepContext) -> dict[str, Any]:
        metas = self._metas(ctx)
        state = self._state(ctx)
        fr = state["frames"]
        enu = C.EnuFrame(fr["enu"]["lon"], fr["enu"]["lat"], fr["enu"]["h"])
        odm_dir = OP.run_odm_dir(ctx.project, state["id"])
        rec = read_reconstruction(odm_dir, OP.read_names(odm_dir), enu)
        info = json.loads(ctx.stage("work/photos.json").read_text("utf-8"))
        group_cameras(rec.model, info["groupOf"])
        warnings: list[str] = []
        if rec.groups > 1:
            warnings.append(
                f"ODM aligned the photos in {rec.groups} separate groups; they are placed by GNSS only."
            )
        w = nadir_only_warning(rec.model)
        if w:
            warnings.append(w)
        georeferenced = any(m.has_gps for m in metas)
        if not georeferenced:
            warnings.append(
                "The photos have no GPS positions: the model is not georeferenced until ground control adjusts it."
            )
        rec.model.save_npz(ctx.stage("work/aligned-enu.npz"))
        atomic_write_json(
            ctx.stage("work/georef.json"),
            {
                "leftOut": [],
                "warnings": warnings,
                "georeferenced": georeferenced,
                "stats": {"reprojPx": rec.reproj_px, "trackLength": rec.track_length, "gsdCm": rec.gsd_cm},
            },
        )
        for msg in warnings:
            ctx.log(msg, "warn")
        return {
            "registered": len(rec.model.images),
            "points": len(rec.model.point_ids),
            "georeferenced": georeferenced,
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
                rejected.append({"name": m.key, "reason": "Not enough matches with other photos."})
        grid_model = enu_to_grid_model(model, enu, grid) if geo["georeferenced"] else model
        # ODM's model carries no observations: its own statistics stand in for ours
        mean_err = float(geo["stats"]["reprojPx"] or 0.0)
        gsd = geo["stats"]["gsdCm"]
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
        gnss = ctx.params.get("gnss", "auto")
        sigmas = [s[0] for s in (m.gnss_sigma(gnss) for m in metas) if s]
        if geo["georeferenced"] and gnss == "ignore":
            warnings.append(
                A.Warning_(
                    "other",
                    f"GNSS was ignored: ODM had the photo positions only as a rough guide "
                    f"({IGNORED_GNSS_SIGMA_M[0]:g} m), so the model's position and heights are approximate until ground control adjusts it.",
                )
            )
        elif geo["georeferenced"] and not points and sigmas:
            warnings.append(
                A.Warning_(
                    "gnss-height" if (state.get("heights") or {}).get("geoid") == "none" else "other",
                    f"No ground control: absolute accuracy is the GNSS accuracy (about {float(np.median(sigmas)):.2f} m "
                    "horizontally), and heights follow the drone's altitude datum.",
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
            "schema": ALIGN_SCHEMA,
            "run": state["id"],
            "createdAt": now_iso(),
            "engine": state.get("engine"),
            "mapper": "opensfm",
            "matching": "odm",
            "images": {"total": int(state["photos"]["count"]), "registered": len(model.images)},
            "registered": sorted(registered),
            "rejected": rejected,
            "meanReprojPx": round(mean_err, 4),
            "points": len(model.point_ids),
            "meanTrackLength": round(geo["stats"]["trackLength"] or 0, 2),
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
        "schema": CAMERAS_SCHEMA,
        "run": state["id"],
        "crs": C.crs_record(state["crs"]),
        "origin": [float(v) for v in state["frames"]["origin"]],
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
    return {"schema": LIST_SCHEMA, "imageRoot": info["imageRoot"], "photos": out}


def measure_points(model: SparseModel, gcp: dict[str, Any], enu: C.EnuFrame, grid: C.GridFrame, cam_res):
    """Triangulate every point from its confirmed marks through ``model`` (ENU); residuals in the
    grid frame; predictions for every point, where the model has it (``gcp.model_positions``: the
    model has not seen ground control, so its heights are the drone's, not the survey's)."""
    geo = G.points_to_geodetic(gcp)
    by_name = {im.name: im.id for im in model.images.values()}
    points: list[A.PointResidual] = []
    surveyed_enu: dict[str, np.ndarray] = {}
    measured_enu: dict[str, np.ndarray] = {}
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
        measured_enu[p["id"]] = X
        d = grid.from_geodetic(*enu.to_geodetic(X[None]))[0] - grid.from_geodetic([lon], [lat], [h])[0]
        points.append(A.PointResidual(p["id"], p["role"], d, err, len(marks), used=False))
    unmeasured = [p for p in points if np.isnan(p.d).any()]
    points = [p for p in points if not np.isnan(p.d).any()]
    sigma = 0.5
    if cam_res:
        sigma = max(
            0.05, float(cam_res.get("rmseHorizontalM", 0.5)), float(cam_res.get("rmseVerticalM", 0.5)) / 2
        )
    preds = G.predict_marks(model, G.model_positions(model, surveyed_enu, measured_enu), sigma)
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
