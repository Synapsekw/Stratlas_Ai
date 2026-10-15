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
from dataclasses import dataclass
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
    # the reference too: an invalidation (photo.georef) removes reference_lla.json and the fake writes it again
    truth = {**recs[0], "bias": [float(v) for v in bias_enu], "reference": reference}
    moved = shifted(recs[0], bias_enu)
    sfm = odm / "opensfm"
    (sfm / "stats").mkdir(parents=True, exist_ok=True)
    # ODM's OpenSfM setup leaves the list of images; while it exists the setup is not run again
    (sfm / "image_list.txt").write_text("".join(f"{images / link}\n" for link in links.values()), "utf-8")
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
        (fake / f"{stage}.done.json").write_text("{}")
    return odm


# ------------------------------------------------------------------------------ ground control


@dataclass
class TruthModel:
    """The unbiased model of a synthetic ODM folder, in the ENU frame of its ``reference_lla.json``."""

    model: SparseModel
    enu: C.EnuFrame


def truth_model(odm_dir: Path) -> TruthModel:
    """``.fake/truth.json`` read back with the conventions of ODM's reconstruction reader (Task 6)."""
    from aio_pipelines.photo.model import Image, rodrigues
    from aio_pipelines.photo.odm.reconstruction import opensfm_camera

    odm_dir = Path(odm_dir)
    truth = json.loads((odm_dir / ".fake" / "truth.json").read_text("utf-8"))
    ref = json.loads((odm_dir / "opensfm" / "reference_lla.json").read_text("utf-8"))
    names = json.loads((odm_dir / "names.json").read_text("utf-8"))
    model = SparseModel()
    cam_ids: dict[str, int] = {}
    for link in sorted(truth["shots"]):
        shot = truth["shots"][link]
        if shot["camera"] not in cam_ids:
            cid = cam_ids[shot["camera"]] = len(cam_ids) + 1
            model.cameras[cid] = opensfm_camera(cid, truth["cameras"][shot["camera"]])
        iid = len(model.images) + 1
        r = rodrigues(np.array(shot["rotation"], dtype=np.float64))[0]
        model.images[iid] = Image(iid, names[link], cam_ids[shot["camera"]], r, shot["translation"])
    pts = list(truth["points"].values())
    model.set_points(range(1, len(pts) + 1), [p["coordinates"] for p in pts], [p["color"] for p in pts])
    enu = C.EnuFrame(float(ref["longitude"]), float(ref["latitude"]), float(ref["altitude"]))
    return TruthModel(model, enu)


def gcp_doc(
    model_enu: SparseModel,
    enu: C.EnuFrame,
    epsg: int,
    points: dict[str, tuple[float, float, float]],
    roles: dict[str, str],
) -> dict:
    """An ``aio.gcp/1`` document: each point (``epsg`` coordinates, heights as they are) marked by
    a person, confirmed, at its true projection in every image that sees it inside the frame."""
    from aio_pipelines.photo.model import project_points

    out = []
    for pid, (x, y, z) in points.items():
        lon, lat = C.crs_to_geodetic(C.crs_of(epsg), [x], [y])
        X = enu.from_geodetic(lon, lat, [z])
        marks = []
        for im in sorted(model_enu.images.values(), key=lambda i: i.name):
            cam = model_enu.cameras[im.camera_id]
            uv, depth = project_points(cam, im.R, im.centre, X)
            u, v = float(uv[0, 0]), float(uv[0, 1])
            if depth[0] > 0 and 0 <= u < cam.width and 0 <= v < cam.height:
                mark = {"photo": im.name, "px": [u, v], "by": "person", "at": "2026-10-07T09:00:00Z"}
                marks.append({**mark, "state": "confirmed"})
        out.append(
            {
                "id": pid,
                "role": roles[pid],
                "xyz": [float(x), float(y), float(z)],
                "accuracy": {"horizontalM": 0.01, "verticalM": 0.02},
                "marks": marks,
            }
        )
    return {"schema": "aio.gcp/1", "crs": {"epsg": int(epsg)}, "points": out}
