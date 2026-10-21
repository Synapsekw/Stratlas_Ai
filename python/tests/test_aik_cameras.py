import io
import json
import math
import struct
import threading

import pytest
from PIL import Image

from aio_pipelines.aik import cameras as C
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


def test_camera_height_paths():
    # Al-Zour flight 1 numbers: 113.7 m above take-off, absolute = relative + 41.9
    both = {"AbsoluteAltitude": 155.6, "RelativeAltitude": 113.7}
    # absolute altitude above the given ground altitude (the origin is the datum)
    assert C.camera_height(both, 41.9) == pytest.approx((113.7, "absolute"))
    assert C.camera_height(both, 30.0)[0] == pytest.approx(125.6)
    # relative altitude plus the take-off height above the ground
    assert C.camera_height(both, 0.0, "relative", 2.5) == pytest.approx((116.2, "relative"))
    # XMP missing: the EXIF GPS altitude counts as absolute
    assert C.camera_height({"altitude": 50.0}, 30.0, "relative") == (20.0, "absolute")
    assert C.camera_height({"RelativeAltitude": 12.0}, 30.0, "absolute", 1.0) == (13.0, "relative")
    assert C.camera_height({}, 30.0, "absolute", 1.5) == (1.5, "none")


def test_ground_for_an_estimated_origin_is_the_take_off_point():
    metas = [
        {"AbsoluteAltitude": 155.6, "RelativeAltitude": 113.7},
        {"AbsoluteAltitude": 60.0, "RelativeAltitude": 18.0},
        {"altitude": 70.0},
    ]
    assert C.takeoff_altitude(metas) == pytest.approx(41.95)
    assert C.ground_altitude(metas) == pytest.approx(
        (41.95, "take-off point (absolute minus relative altitude)")
    )
    # without relative altitude only the lowest photo is known (a camera, not the ground)
    assert C.ground_altitude([{"altitude": 70.0}, {"altitude": 65.0}]) == (65.0, "lowest photo altitude")
    assert C.takeoff_altitude([{"altitude": 70.0}]) is None


def test_cameras_job_uses_relative_altitude_without_an_origin(tmp_path, project):
    # four photos 12 m above a take-off point the aircraft logged at absolute altitude 40 m
    for i in range(4):
        lat, lon = offset_latlon(LAT0, LON0, 30 * math.cos(i), 30 * math.sin(i))
        drone_jpeg(tmp_path / "raw" / f"DJI_{i:04d}.JPG", lat, lon, 52 + i, yaw=0, pitch=-5, rel=12 + i)
    result, rec = run_job(AikCameras(), project, {"photos": str(tmp_path / "raw"), "longEdge": 400})
    poses = result["outputs"]["poses"]
    assert poses["origin"][2] == pytest.approx(40, abs=0.01)
    assert poses["heights"] == {"prefer": "relative", "takeoffHeight": 0.0, "sources": {"relative": 4}}
    cams = json.loads((project / "cameras.json").read_text())
    assert [c["position"][1] for c in cams["photos"]] == pytest.approx([12, 13, 14, 15], abs=0.01)
    assert {c["altitude_source"] for c in cams["photos"]} == {"relative"}
    assert any("take-off point" in m["message"] for m in rec.of("log"))


def test_cameras_job_uses_absolute_altitude_with_an_origin(tmp_path, project):
    photos = make_photos(tmp_path / "raw", n=3)
    result, _ = run_job(
        AikCameras(),
        project,
        {"photos": str(photos), "origin": [LAT0, LON0, GROUND], "altitude": "absolute", "longEdge": 400},
    )
    assert result["outputs"]["poses"]["heights"]["sources"] == {"absolute": 3}
    # a typed take-off height applies to relative altitude only
    with pytest.raises(JobError, match="altitude must be"):
        AikCameras().validate({"photos": "x", "altitude": "ellipsoid"})


def test_params_are_checked():
    with pytest.raises(JobError, match="photos is required"):
        AikCameras().validate({})
    with pytest.raises(JobError, match="does not take"):
        AikCameras().validate({"photos": "x", "bogus": 1})
    with pytest.raises(JobError, match="list of 3 numbers"):
        AikCameras().validate({"photos": "x", "origin": [1, 2]})


def _raw_exif_jpeg(path, alt_type, alt_num, alt_den=1000, xmp_in_exif=None):
    """A JPEG whose Exif block is built by hand (big-endian TIFF): GPS lat/lon and a GPSAltitude of
    TIFF type ``alt_type`` (5 RATIONAL, 10 SRATIONAL) holding ``alt_num / alt_den`` as stored, ref 0.
    ``xmp_in_exif`` is an XMP packet placed inside the Exif APP1 payload after the TIFF data."""

    def rat(n, d, signed=False):
        return struct.pack(">ii" if signed else ">II", n, d)

    entries = [  # (tag, type, count, value bytes)
        (1, 2, 2, b"N\x00"),
        (2, 5, 3, rat(29, 1) + rat(1, 1) + rat(40, 1)),
        (3, 2, 2, b"E\x00"),
        (4, 5, 3, rat(48, 1) + rat(8, 1) + rat(8, 1)),
        (5, 1, 1, b"\x00"),
        (6, alt_type, 1, rat(alt_num, alt_den, signed=alt_type == 10)),
    ]
    # layout: header (8 bytes), IFD0 with one entry, the GPS IFD, then out-of-line values
    ifd0_at = 8
    gps_at = ifd0_at + 2 + 12 + 4
    data_at = gps_at + 2 + 12 * len(entries) + 4
    ifd0 = struct.pack(">H", 1) + struct.pack(">HHII", 0x8825, 4, 1, gps_at) + struct.pack(">I", 0)
    gps = struct.pack(">H", len(entries))
    extra = b""
    for tag, typ, count, val in entries:
        if len(val) <= 4:
            gps += struct.pack(">HHI", tag, typ, count) + val.ljust(4, b"\x00")
        else:
            gps += struct.pack(">HHII", tag, typ, count, data_at + len(extra))
            extra += val
    gps += struct.pack(">I", 0)
    tiff = b"MM\x00\x2a" + struct.pack(">I", ifd0_at) + ifd0 + gps + extra
    payload = b"Exif\x00\x00" + tiff + (xmp_in_exif or b"")
    seg = b"\xff\xe1" + struct.pack(">H", len(payload) + 2) + payload
    buf = io.BytesIO()
    Image.new("RGB", (64, 48), (90, 110, 130)).save(buf, "JPEG")
    data = buf.getvalue()
    path.write_bytes(data[:2] + seg + data[2:])
    return path


def test_wrapped_unsigned_gps_altitude_reads_as_signed(tmp_path):
    # -4.502 m written as an unsigned RATIONAL: numerator 0xffffee6a, denominator 1000
    m = read_meta(_raw_exif_jpeg(tmp_path / "t.jpg", 5, 0xFFFFEE6A))
    assert m["altitude"] == pytest.approx(-4.502)
    assert m["latitude"] == pytest.approx(29 + 1 / 60 + 40 / 3600)


def test_signed_negative_gps_altitude_is_unchanged(tmp_path):
    assert read_meta(_raw_exif_jpeg(tmp_path / "s.jpg", 10, -31501))["altitude"] == pytest.approx(-31.501)
    assert read_meta(_raw_exif_jpeg(tmp_path / "p.jpg", 5, 12345))["altitude"] == pytest.approx(12.345)


def test_gps_altitude_over_20_km_is_left_out(tmp_path):
    m = read_meta(_raw_exif_jpeg(tmp_path / "h.jpg", 5, 25_000_000))  # 25 km
    assert "altitude" not in m
    assert "latitude" in m and "longitude" in m


def test_xmp_packet_inside_the_exif_block_is_read(tmp_path):
    # guard: the XT2 writes its XMP inside the Exif APP1; the head scan already finds it
    xmp = (
        b'<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description>'
        b"<drone-dji:AbsoluteAltitude>-31.501320</drone-dji:AbsoluteAltitude>"
        b"<drone-dji:RelativeAltitude>+14.700000</drone-dji:RelativeAltitude>"
        b"<drone-dji:GimbalYawDegree>-120.5</drone-dji:GimbalYawDegree>"
        b"</rdf:Description></rdf:RDF></x:xmpmeta>"
    )
    m = read_meta(_raw_exif_jpeg(tmp_path / "x.jpg", 10, -31501, xmp_in_exif=xmp))
    assert m["AbsoluteAltitude"] == pytest.approx(-31.50132)
    assert m["RelativeAltitude"] == pytest.approx(14.7)
    assert m["GimbalYawDegree"] == pytest.approx(-120.5)
