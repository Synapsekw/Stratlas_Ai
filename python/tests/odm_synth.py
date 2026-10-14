"""An already aligned ODM project written from known truth, for tests (never shipped).

``write_odm_folder`` leaves ``<run>/odm/`` as ODM does after ``--end-with opensfm``: the images,
``names.json`` (link name to photo key), OpenSfM's reconstruction in the topocentric frame of
``reference_lla.json``, its statistics and ODM's ``coords.txt``. The fake ODM
(``tests/fake_odm/fake_odm.py``) takes it from there.

``opensfm_from_model`` is written from OpenSfM's documented conventions, independently of the
reader in ``photo/odm/reconstruction.py``: a shot is world to camera, ``x_cam = R(rotation) @ X + t``
with ``R`` from the axis-angle vector; the camera looks along +z, image x right, y down; lengths
are normalised by ``s = max(width, height)`` and a pixel ``u`` (top-left corner of the image at 0)
is ``x = (u - width / 2) / s``.
"""

from __future__ import annotations

import json
import math
import shutil
from pathlib import Path

import numpy as np
from scipy.spatial.transform import Rotation

from aio_pipelines.photo import crs as C
from aio_pipelines.photo.model import CAMERA_MODELS, SparseModel


def _brown(model: str, params: np.ndarray, width: int, height: int) -> dict:
    p = dict(zip(CAMERA_MODELS[model], (float(v) for v in params), strict=True))
    s = float(max(width, height))
    fx = p.get("fx", p.get("f"))
    fy = p.get("fy", p.get("f"))
    k1 = p.get("k1", p.get("k", 0.0))
    return {
        "projection_type": "brown",
        "width": int(width),
        "height": int(height),
        "focal_x": fx / s,
        "focal_y": fy / s,
        "c_x": (p["cx"] - width / 2) / s,
        "c_y": (p["cy"] - height / 2) / s,
        "k1": k1,
        "k2": p.get("k2", 0.0),
        "p1": p.get("p1", 0.0),
        "p2": p.get("p2", 0.0),
        "k3": 0.0,
    }


def opensfm_from_model(
    model_enu: SparseModel, enu: C.EnuFrame, links: dict[str, str]
) -> tuple[list[dict], dict]:
    """(reconstruction list, reference_lla) for a model in the ENU frame ``enu``.

    ``links`` maps a photo key (the image name in the model) to the file name ODM sees."""
    cameras = {
        f"cam{cid}": _brown(c.model, c.params, c.width, c.height) for cid, c in model_enu.cameras.items()
    }
    shots = {}
    for im in model_enu.images.values():
        shots[links[im.name]] = {
            "camera": f"cam{im.camera_id}",
            "rotation": [float(v) for v in Rotation.from_matrix(im.R).as_rotvec()],
            "translation": [float(v) for v in im.t],
            "gps_position": [float(v) for v in im.centre],
        }
    points = {
        str(int(pid)): {"coordinates": [float(v) for v in xyz], "color": [int(v) for v in rgb]}
        for pid, xyz, rgb in zip(model_enu.point_ids, model_enu.xyz, model_enu.rgb, strict=True)
    }
    reference = {"latitude": enu.lat0, "longitude": enu.lon0, "altitude": enu.h0}
    return [{"cameras": cameras, "shots": shots, "points": points}], reference


def shifted(rec: dict, bias: tuple[float, float, float]) -> dict:
    """The reconstruction with every camera centre and point moved by ``bias`` (rotations kept)."""
    b = np.asarray(bias, dtype=np.float64)
    shots = {}
    for name, shot in rec["shots"].items():
        r = Rotation.from_rotvec(shot["rotation"]).as_matrix()
        shots[name] = {
            **shot,
            "translation": [float(v) for v in np.asarray(shot["translation"]) - r @ b],
            "gps_position": [float(v) for v in np.asarray(shot["gps_position"]) + b],
        }
    points = {
        k: {**v, "coordinates": [float(x) for x in np.asarray(v["coordinates"]) + b]}
        for k, v in rec["points"].items()
    }
    return {"cameras": rec["cameras"], "shots": shots, "points": points}


def coords_text(points_enu: np.ndarray, enu: C.EnuFrame) -> str:
    """ODM's ``coords.txt`` (two lines): ``WGS84 UTM <zone><N|S>``, then the x y offset."""
    epsg = C.utm_epsg(enu.lon0, enu.lat0)
    lon, lat, _ = enu.to_geodetic(points_enu)
    e, n = C.geodetic_to_crs(epsg, lon, lat)
    zone = f"{epsg % 100}{'N' if epsg < 32700 else 'S'}"
    return f"WGS84 UTM {zone}\n{math.floor(float(np.min(e)))} {math.floor(float(np.min(n)))}\n"


def write_odm_folder(
    run_dir: Path,
    model_enu: SparseModel,
    enu: C.EnuFrame,
    photos: dict[str, Path],
    bias_enu: tuple[float, float, float] = (0.0, 0.0, 0.0),
) -> Path:
    """Write ``run_dir/odm/`` as ODM leaves it after ``--end-with opensfm``."""
    odm = run_dir / "odm"
    images = odm / "images"
    images.mkdir(parents=True, exist_ok=True)
    links = {key: f"{i:05d}{photos[key].suffix.lower()}" for i, key in enumerate(sorted(photos))}
    for key, link in links.items():
        shutil.copyfile(photos[key], images / link)
    (odm / "names.json").write_text(json.dumps({link: key for key, link in links.items()}, indent=1), "utf-8")
    recs, reference = opensfm_from_model(model_enu, enu, links)
    truth = {**recs[0], "bias": [float(v) for v in bias_enu]}
    moved = shifted(recs[0], bias_enu)
    sfm = odm / "opensfm"
    (sfm / "stats").mkdir(parents=True, exist_ok=True)
    for name in ("reconstruction.topocentric.json", "reconstruction.json"):
        (sfm / name).write_text(json.dumps([moved]), "utf-8")
    (sfm / "reference_lla.json").write_text(json.dumps(reference), "utf-8")
    stats = {"reconstruction_statistics": {"reprojection_error_pixels": 0.5, "average_track_length": 3.0}}
    (sfm / "stats" / "stats.json").write_text(json.dumps(stats), "utf-8")
    points = np.array([v["coordinates"] for v in moved["points"].values()]).reshape(-1, 3)
    geo = odm / "odm_georeferencing"
    geo.mkdir(parents=True, exist_ok=True)
    (geo / "coords.txt").write_text(coords_text(points, enu), "utf-8")
    fake = odm / ".fake"
    fake.mkdir(exist_ok=True)
    (fake / "truth.json").write_text(json.dumps(truth), "utf-8")
    for stage in ("dataset", "opensfm"):
        (fake / f"{stage}.done").write_text("")
    return odm
