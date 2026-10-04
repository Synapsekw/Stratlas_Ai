import json
import math
import threading

import pytest
from PIL import Image

from aio_pipelines.aik.cameras import pose, read_meta
from aio_pipelines.aik.pipelines import AikCameras
from aio_pipelines.runtime import Cancelled, JobError
from conftest import drone_jpeg, offset_latlon, run_job

LAT0, LON0, GROUND = 29.0278, 48.1357, 31.7


def test_read_meta_finds_gps_focal_and_gimbal(tmp_path):
    lat, lon = offset_latlon(LAT0, LON0, 30, 0)
    p = drone_jpeg(tmp_path / "a.jpg", lat, lon, GROUND + 12, yaw=180, pitch=-10, roll=0)
    m = read_meta(p)
    assert m["latitude"] == pytest.approx(lat, abs=1e-7)
    assert m["longitude"] == pytest.approx(lon, abs=1e-7)
    assert m["altitude"] == pytest.approx(GROUND + 12, abs=0.01)
    assert m["focal35"] == 24
    assert m["GimbalYawDegree"] == 180 and m["GimbalPitchDegree"] == -10
    assert m["width"] == 4000 and m["time"] == "2026:01:02 10:00:00"


def test_pose_from_gimbal_looks_at_the_asset_axis():
    lat, lon = offset_latlon(LAT0, LON0, 30, 0)  # 30 m north of the asset
    meta = {"latitude": lat, "longitude": lon, "AbsoluteAltitude": GROUND + 12, "width": 4000, "height": 3000,
            "focal35": 24, "GimbalYawDegree": 180, "GimbalPitchDegree": 0}  # fmt: skip
    ps = pose(meta, (LAT0, LON0, GROUND))
    assert ps["position"] == pytest.approx([30, 12, 0], abs=0.01)
    assert ps["target"] == pytest.approx([0, 12, 0], abs=0.01)  # looking south, nearest the axis
    assert ps["hfov"] == pytest.approx(2 * math.degrees(math.atan(36 / 48)), abs=1e-3)
    assert ps["vfov"] < ps["hfov"]


def test_pose_without_angles_aims_at_the_axis_clamped_to_the_asset():
    lat, lon = offset_latlon(LAT0, LON0, 0, -40)  # 40 m west, above the asset top
    meta = {"latitude": lat, "longitude": lon, "altitude": GROUND + 60, "width": 4000, "height": 3000}
    ps = pose(meta, (LAT0, LON0, GROUND), asset_height=50)
    assert ps["target"][0] == pytest.approx(0, abs=1e-3) and ps["target"][2] == pytest.approx(0, abs=1e-3)
    assert ps["target"][1] < 60  # aims down towards the top of the asset
    assert ps["hfov"] == 70.0


def make_photos(folder, n=5, with_gps=True):
    for i in range(n):
        ang = 2 * math.pi * i / n
        north, east = 30 * math.cos(ang), 30 * math.sin(ang)
        lat, lon = offset_latlon(LAT0, LON0, north, east)
        yaw = (math.degrees(math.atan2(-east, -north)) + 360) % 360
        p = drone_jpeg(folder / f"DJI_{i:04d}.JPG", lat, lon, GROUND + 5 + i, yaw=yaw, pitch=-5)
        if not with_gps:
            with Image.open(p) as im:
                im.convert("RGB").save(p, "JPEG")  # re-save without EXIF or XMP
    return folder


def test_cameras_job_writes_cameras_json_and_review_copies(tmp_path, project):
    photos = make_photos(tmp_path / "raw")
    result, rec = run_job(
        AikCameras(), project, {"photos": str(photos), "origin": [LAT0, LON0, GROUND], "longEdge": 1000}
    )
    assert result["status"] == "done"
    cams = json.loads((project / "cameras.json").read_text())
    assert [c["id"] for c in cams["photos"]] == ["p001", "p002", "p003", "p004", "p005"]
    c = cams["photos"][0]
    assert c["file"] == "photos/p001.jpg" and c["name"] == "DJI_0000.JPG"
    assert c["orientation_source"] == "gimbal XMP"
    assert c["position"] == pytest.approx([30, 5, 0], abs=0.05)
    with Image.open(project / "photos" / "p001.jpg") as im:
        assert im.size == (1000, 750)
    assert cams["alignment"]["origin"] == [LAT0, LON0, GROUND]
    assert {a["path"] for a in rec.of("artifact")} == {"photos", "cameras.json"}
    # nothing is left half-written in the project; staging is inside the job folder only
    assert not list((project / "photos").glob(".*"))


def test_cameras_job_estimates_the_origin_and_warns(tmp_path, project):
    photos = make_photos(tmp_path / "raw", n=4)
    result, rec = run_job(AikCameras(), project, {"photos": str(photos), "longEdge": 500})
    assert result["outputs"]["poses"]["originEstimated"] is True
    assert any("No origin given" in m["message"] for m in rec.of("log"))


def test_photos_without_gps_fail_with_a_clear_message(tmp_path, project):
    photos = make_photos(tmp_path / "raw", n=2, with_gps=False)
    with pytest.raises(JobError, match="has a GPS position"):
        run_job(AikCameras(), project, {"photos": str(photos)})
    assert not (project / "cameras.json").exists()


def test_cancel_during_review_copies_then_resume(tmp_path, project):
    photos = make_photos(tmp_path / "raw", n=6)
    ev = threading.Event()
    params = {"photos": str(photos), "origin": [LAT0, LON0, GROUND], "longEdge": 800}

    def emit(method, msg):
        if method == "progress" and msg.get("step") == "review" and msg["state"] == "running":
            ev.set()

    from aio_pipelines.runtime import Job

    with pytest.raises(Cancelled):
        Job("jc", AikCameras(), project, params, emit, ev).run()
    assert not (project / "cameras.json").exists()
    staged = list((project / "jobs" / "jc" / "staging" / "review").glob("*.jpg"))
    assert 1 <= len(staged) < 6

    result, rec = run_job(AikCameras(), project, params, job_id="jc")
    assert result["status"] == "done"
    assert len(list((project / "photos").glob("*.jpg"))) == 6
    assert any("already written" in m["message"] for m in rec.of("log"))


def test_params_are_checked():
    with pytest.raises(JobError, match="photos is required"):
        AikCameras().validate({})
    with pytest.raises(JobError, match="does not take"):
        AikCameras().validate({"photos": "x", "bogus": 1})
    with pytest.raises(JobError, match="list of 3 numbers"):
        AikCameras().validate({"photos": "x", "origin": [1, 2]})
