"""OpenSfM's reconstruction (ODM's alignment) into our ``SparseModel`` (ADR 0012).

Reads ``opensfm/reconstruction.topocentric.json`` (else ``reconstruction.json``) in the
east-north-up frame of ``opensfm/reference_lla.json``, and ODM's statistics. No observations:
``tracks.csv`` is a binary file in ODM 3.6.2 (C10).
OpenSfM's pose convention is ours (world to camera, camera looks along +z, x right, y down); its
image coordinates are normalised by ``s = max(width, height)`` about the image centre, so a pixel
``u`` (top-left corner at 0) is ``x * s + width / 2``. Cameras: ``perspective`` becomes ``RADIAL``,
``brown`` becomes ``FULL_OPENCV`` (k4 to k6 zero), ``radial`` and ``simple_radial`` become ``OPENCV``.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from ...runtime import JobError
from .. import crs as C
from ..model import Camera, Image, SparseModel, project_points, rodrigues

_FIRST_NAMED_POINT = 10_000_000


@dataclass
class OdmModel:
    model: SparseModel
    reference: C.EnuFrame
    unregistered: list[str]
    groups: int
    stats: dict | None
    reproj_px: float | None
    track_length: float | None
    gsd_cm: float | None


def _px(cam: dict) -> tuple[float, float, float]:
    w, h = float(cam["width"]), float(cam["height"])
    return w, h, max(w, h)


def opensfm_camera(cid: int, cam: dict) -> Camera:
    kind = cam.get("projection_type")
    w, h, s = _px(cam)
    if kind == "perspective":
        f = cam["focal"] * s
        return Camera(
            cid, "RADIAL", int(w), int(h), [f, w / 2, h / 2, cam.get("k1", 0.0), cam.get("k2", 0.0)]
        )
    if kind in ("brown", "radial", "simple_radial"):
        if kind == "brown":
            fx, fy = cam["focal_x"] * s, cam["focal_y"] * s
        else:
            fx = fy = cam["focal"] * s
        cx, cy = w / 2 + cam.get("c_x", 0.0) * s, h / 2 + cam.get("c_y", 0.0) * s
        k1, k2 = cam.get("k1", 0.0), cam.get("k2", 0.0)
        if kind == "brown":
            p = [fx, fy, cx, cy, k1, k2, cam["p1"], cam["p2"], cam.get("k3", 0.0), 0.0, 0.0, 0.0]
            return Camera(cid, "FULL_OPENCV", int(w), int(h), p)
        return Camera(
            cid, "OPENCV", int(w), int(h), [fx, fy, cx, cy, k1, k2 if kind == "radial" else 0.0, 0.0, 0.0]
        )
    raise JobError(f"ODM used the {kind} camera model, which this build does not read.")


def convert_model(m: SparseModel, conv: Callable[[np.ndarray], np.ndarray]) -> None:
    """Move every camera (centre and rotation) and point by ``conv``, in place."""
    ids = sorted(m.images)
    if ids:
        cs = np.array([m.images[i].centre for i in ids])
        rs = np.array([m.images[i].R for i in ids])
        c2, r2 = C.transform_rotations(conv, cs, rs)
        for k, i in enumerate(ids):
            m.images[i].set_pose(r2[k], c2[k])
    if len(m.xyz):
        m.xyz = conv(m.xyz)


def visible_gsd_cm(model: SparseModel) -> float | None:
    """Median over images of (median depth of the points they see / focal length), in cm."""
    if not len(model.xyz):
        return None
    per_image: list[float] = []
    for im in model.images.values():
        cam = model.cameras[im.camera_id]
        uv, depth = project_points(cam, im.R, im.centre, model.xyz)
        inside = (
            (depth > 0) & (uv[:, 0] >= 0) & (uv[:, 0] < cam.width) & (uv[:, 1] >= 0) & (uv[:, 1] < cam.height)
        )
        if inside.any():
            per_image.append(float(np.median(depth[inside])) / cam.focal)
    if not per_image:
        return None
    return float(np.median(per_image)) * 100.0


def _load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def read_reconstruction(odm_dir: Path, names: dict[str, str], run_enu: C.EnuFrame) -> OdmModel:
    sfm = Path(odm_dir) / "opensfm"
    rec_path = next(
        (p for p in (sfm / "reconstruction.topocentric.json", sfm / "reconstruction.json") if p.is_file()),
        None,
    )
    ref_path = sfm / "reference_lla.json"
    if rec_path is None or not ref_path.is_file():
        raise JobError("ODM wrote no alignment (opensfm/reconstruction.json); look at the job log.")
    recs = _load(rec_path)
    ref = _load(ref_path)
    odm_ref = C.EnuFrame(float(ref["longitude"]), float(ref["latitude"]), float(ref["altitude"]))

    model = SparseModel()
    cam_ids: dict[str, int] = {}
    point_numbers: dict[str, int] = {}
    ids: list[int] = []
    xyz: list[list[float]] = []
    rgb: list[list[int]] = []
    groups = 0
    for rec in recs:
        shots = rec.get("shots") or {}
        if shots:
            groups += 1
        cams = rec.get("cameras") or {}
        for key, shot in shots.items():
            if key not in names:
                continue
            cam_key = shot["camera"]
            if cam_key not in cam_ids:
                cam_ids[cam_key] = len(cam_ids) + 1
                model.cameras[cam_ids[cam_key]] = opensfm_camera(cam_ids[cam_key], cams[cam_key])
            R = rodrigues(np.array(shot["rotation"], dtype=np.float64))[0]
            iid = len(model.images) + 1
            model.images[iid] = Image(iid, names[key], cam_ids[cam_key], R, shot["translation"])
        for track_id, pt in (rec.get("points") or {}).items():
            if track_id.isdigit():
                pid = int(track_id)
            else:
                pid = point_numbers.setdefault(track_id, _FIRST_NAMED_POINT + len(point_numbers))
            ids.append(pid)
            xyz.append(pt["coordinates"])
            rgb.append(pt.get("color", [0, 0, 0]))
    if not model.images:
        raise JobError("ODM placed no photos: they may not overlap enough, or have no usable features.")
    model.set_points(ids, xyz, rgb)

    if (run_enu.lon0, run_enu.lat0, run_enu.h0) != (odm_ref.lon0, odm_ref.lat0, odm_ref.h0):
        convert_model(model, lambda p: run_enu.from_geodetic(*odm_ref.to_geodetic(p)))

    placed = {im.name for im in model.images.values()}
    stats = None
    for p in (sfm / "stats" / "stats.json", Path(odm_dir) / "odm_report" / "stats.json"):
        if p.is_file():
            stats = _load(p)
            break
    rs = (stats or {}).get("reconstruction_statistics") or {}
    return OdmModel(
        model=model,
        reference=run_enu,
        unregistered=sorted(k for k in names.values() if k not in placed),
        groups=groups,
        stats=stats,
        reproj_px=rs.get("reprojection_error_pixels"),
        track_length=rs.get("average_track_length"),
        gsd_cm=visible_gsd_cm(model),
    )
