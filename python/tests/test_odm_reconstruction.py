import json
import math
from pathlib import Path

import numpy as np
import pytest

from aio_pipelines.photo import crs as C
from aio_pipelines.photo.model import project_points
from aio_pipelines.photo.odm.reconstruction import opensfm_camera, read_reconstruction
from aio_pipelines.runtime import JobError

W, H = 4000, 3000
S = 4000.0


def _write(odm: Path, rec: list, ref=(55.0, 25.0, 10.0), stats: dict | None = None):
    (odm / "opensfm").mkdir(parents=True)
    (odm / "opensfm" / "reconstruction.topocentric.json").write_text(json.dumps(rec))
    (odm / "opensfm" / "reference_lla.json").write_text(
        json.dumps({"longitude": ref[0], "latitude": ref[1], "altitude": ref[2]})
    )
    if stats:
        (odm / "opensfm" / "stats").mkdir()
        (odm / "opensfm" / "stats" / "stats.json").write_text(json.dumps(stats))


BROWN = {"projection_type": "brown", "width": W, "height": H, "focal_x": 0.8, "focal_y": 0.81, "c_x": 0.01,
         "c_y": -0.02, "k1": -0.1, "k2": 0.02, "p1": 0.001, "p2": -0.002, "k3": 0.003}  # fmt: skip


def _brown_pixel(Xc):
    x, y = Xc[0] / Xc[2], Xc[1] / Xc[2]
    r2 = x * x + y * y
    rad = 1 + BROWN["k1"] * r2 + BROWN["k2"] * r2**2 + BROWN["k3"] * r2**3
    xd = x * rad + 2 * BROWN["p1"] * x * y + BROWN["p2"] * (r2 + 2 * x * x)
    yd = y * rad + 2 * BROWN["p2"] * x * y + BROWN["p1"] * (r2 + 2 * y * y)
    xn = BROWN["focal_x"] * xd + BROWN["c_x"]
    yn = BROWN["focal_y"] * yd + BROWN["c_y"]
    return xn * S + W / 2, yn * S + H / 2


def test_a_brown_camera_projects_like_opensfm():
    cam = opensfm_camera(1, BROWN)
    Xc = np.array([0.3, -0.2, 10.0])
    u, v = project_points(cam, np.eye(3), np.zeros(3), Xc[None])[0][0]
    assert (u, v) == pytest.approx(_brown_pixel(Xc), abs=1e-6)


def test_a_perspective_camera():
    cam = opensfm_camera(
        2, {"projection_type": "perspective", "width": W, "height": H, "focal": 0.85, "k1": -0.05, "k2": 0.01}
    )
    x, y = 0.03, -0.02
    r2 = x * x + y * y
    d = 1 - 0.05 * r2 + 0.01 * r2**2
    u, v = project_points(cam, np.eye(3), np.zeros(3), np.array([[x, y, 1.0]]))[0][0]
    assert (u, v) == pytest.approx((0.85 * x * d * S + W / 2, 0.85 * y * d * S + H / 2), abs=1e-6)


def test_an_unknown_camera_model_is_named():
    with pytest.raises(JobError, match="fisheye"):
        opensfm_camera(
            3, {"projection_type": "fisheye", "width": W, "height": H, "focal": 1, "k1": 0, "k2": 0}
        )


def test_shots_and_points_land_in_the_runs_frame(tmp_path):
    rot = [0.0, 0.0, math.pi / 2]  # axis-angle: 90 degrees about z
    X = [5.0, 3.0, -40.0]
    rec = [{"cameras": {"v2 cam": BROWN},
            "shots": {"00000.jpg": {"camera": "v2 cam", "rotation": rot, "translation": [1.0, 2.0, 50.0]}},
            "points": {"7": {"coordinates": X, "color": [10, 20, 30]}}},
           {"cameras": {"v2 cam": BROWN},
            "shots": {"00002.jpg": {"camera": "v2 cam", "rotation": [0, 0, 0], "translation": [0, 0, 0]}},
            "points": {}}]  # fmt: skip
    stats = {"reconstruction_statistics": {"reprojection_error_pixels": 1.2, "average_track_length": 2.8}}
    odm = tmp_path / "odm"
    _write(odm, rec, stats=stats)
    names = {"00000.jpg": "a", "00001.jpg": "b", "00002.jpg": "c"}
    same = C.EnuFrame(55.0, 25.0, 10.0)
    got = read_reconstruction(odm, names, same)
    m = got.model
    assert sorted(im.name for im in m.images.values()) == ["a", "c"]
    assert got.unregistered == ["b"] and got.groups == 2
    a = m.image_by_name()["a"]
    rot_z = np.array([[0.0, -1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]])
    assert np.allclose(a.R, rot_z, atol=1e-9)
    assert a.t == pytest.approx([1.0, 2.0, 50.0], abs=1e-6)
    assert m.xyz[0] == pytest.approx(X, abs=1e-6) and list(m.rgb[0]) == [10, 20, 30]
    assert len(a.xys) == 0  # no observations: tracks.csv is binary
    assert (got.reproj_px, got.track_length) == (1.2, 2.8)
    moved = read_reconstruction(odm, names, C.EnuFrame(55.0, 25.0, 0.0))  # our frame 10 m lower
    assert moved.model.xyz[0] == pytest.approx([5.0, 3.0, -30.0], abs=1e-3)


def test_reconstruction_json_is_read_when_there_is_no_topocentric_file(tmp_path):
    odm = tmp_path / "odm"
    _write(odm, [{"cameras": {"c": BROWN}, "shots": {}, "points": {}}])
    (odm / "opensfm" / "reconstruction.topocentric.json").rename(odm / "opensfm" / "reconstruction.json")
    with pytest.raises(JobError, match="ODM placed no photos"):
        read_reconstruction(odm, {}, C.EnuFrame(55.0, 25.0, 10.0))


def test_gsd_from_the_points_a_camera_sees(tmp_path):
    # a nadir camera 100 m above a grid of ground points; f = 0.8 * 4000 px, so GSD = 100 / 3200 m
    pts = {
        str(i): {"coordinates": [x, y, 0.0], "color": [0, 0, 0]}
        for i, (x, y) in enumerate((x, y) for x in range(-20, 21, 5) for y in range(-20, 21, 5))
    }
    cam = {
        **BROWN,
        "c_x": 0.0,
        "c_y": 0.0,
        "k1": 0.0,
        "k2": 0.0,
        "p1": 0.0,
        "p2": 0.0,
        "k3": 0.0,
        "focal_y": 0.8,
    }
    rec = [{"cameras": {"c": cam}, "points": pts,
            "shots": {"00000.jpg": {"camera": "c", "rotation": [math.pi, 0.0, 0.0], "translation": [0.0, 0.0, 100.0]}}}]  # fmt: skip
    odm = tmp_path / "odm"
    _write(odm, rec)
    got = read_reconstruction(odm, {"00000.jpg": "a"}, C.EnuFrame(55.0, 25.0, 10.0))
    assert got.gsd_cm == pytest.approx(100 / 3200 * 100, rel=1e-3)
    assert got.reproj_px is None and got.stats is None
