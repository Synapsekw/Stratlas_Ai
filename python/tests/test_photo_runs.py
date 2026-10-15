"""The files of a photogrammetry run as the app reads them (M10 integration): schema ids and keys,
``usedInAdjustment``, photo names with spaces and other letters below the common folder, and the
one memory cap of the photo jobs. Synthetic photos only (``photo_g2_synth``), on the fake ODM
(``tests/fake_odm``)."""

from __future__ import annotations

import json
import math
import re
import shutil
import sys
from pathlib import Path

import pytest

from aio_pipelines.photo import crs as C
from aio_pipelines.photo import native
from aio_pipelines.photo.align import PhotoAlign, decode_name, encode_name, read_sparse
from aio_pipelines.photo.georef import PhotoGeoref
from aio_pipelines.photo.odm import runner as R
from aio_pipelines.photo.proctree import memory_limit, memory_status
from aio_pipelines.photo.products import PhotoProducts
from aio_pipelines.photo.scene import load_run
from conftest import run_job
from photo_g2_synth import (
    SITE_LAT,
    SITE_LON,
    make_scene,
    write_gcp_files,
    write_scene_photos,
)

RUN = "r1"
RUN_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")


def _vec3(v) -> bool:
    return isinstance(v, list) and len(v) == 3 and all(isinstance(x, int | float) for x in v)


def _crs(v) -> bool:
    return isinstance(v, dict) and (isinstance(v.get("epsg"), int) or isinstance(v.get("wkt"), str))


def check_cameras_file(doc: dict) -> None:
    """``PhotoCamerasFile`` of ``packages/schema/src/photogrammetry.ts``, key by key."""
    assert doc["schema"] == "aio.photo-cameras/1"
    assert RUN_ID.match(doc["run"]) and _crs(doc["crs"]) and _vec3(doc["origin"])
    assert isinstance(doc.get("frame", ""), str) and len(doc.get("frame", "")) <= 200
    assert isinstance(doc["calibration"], list) and 0 < len(doc["calibration"]) <= 100
    for c in doc["calibration"]:
        assert 1 <= len(c["id"]) <= 64 and 1 <= len(c["model"]) <= 40
        assert (
            isinstance(c["width"], int)
            and c["width"] > 0
            and isinstance(c["height"], int)
            and c["height"] > 0
        )
        assert len(c["params"]) <= 32 and all(isinstance(p, float) for p in c["params"])
    ids = {c["id"] for c in doc["calibration"]}
    assert isinstance(doc["cameras"], list) and 0 < len(doc["cameras"]) <= 100_000
    for cam in doc["cameras"]:
        assert 1 <= len(cam["photo"]) <= 1024 and _vec3(cam["pos"])
        assert isinstance(cam["q"], list) and len(cam["q"]) == 4
        assert abs(math.sqrt(sum(v * v for v in cam["q"])) - 1) < 1e-5
        lens = cam["lens"]
        assert 1 <= len(lens["model"]) <= 40 and 0 < lens["hfovDeg"] <= 360 and lens["aspect"] > 0
        assert cam["camera"] in ids


def _manifest(project: Path) -> None:
    e, n = C.geodetic_to_crs(C.crs_of(32639), [SITE_LON], [SITE_LAT])
    manifest = {
        "schema": "aio.project/1",
        "id": "runs",
        "name": "Runs",
        "type": "volumetric",
        "crs": {"epsg": 32639},
        "origin": [round(float(e[0])), round(float(n[0])), 0.0],
        "captures": [],
        "layers": [],
        "severityModels": [],
        "classCatalogues": [],
    }
    (project / "manifest.json").write_text(json.dumps(manifest), "utf-8")


FAKE = Path(__file__).parent / "fake_odm"


def _align(monkeypatch, project, folder, **kw):
    """``photo.align`` of ``folder`` on the fake ODM."""
    monkeypatch.setenv("FAKE_ODM_PYTHON", sys.executable)
    monkeypatch.setenv(R.ODM_ENV, str(FAKE))
    monkeypatch.setenv("FAKE_ODM_UDP_PORT", "0")
    monkeypatch.setattr(R, "nvcuda_present", lambda env=None: False)
    params = {"photos": {"folders": [str(folder)]}, "preset": "standard", "run": RUN, **kw}
    return run_job(PhotoAlign(), project, params, job_id="align")


# ------------------------------------------------------------------------- schema ids and keys


def test_the_run_files_carry_their_schema_ids_and_keys(monkeypatch, project, tmp_path):
    scene = make_scene(rows=4, cols=6, points=3000, gnss_sigma=(2.5, 4.0), seed=9)
    write_scene_photos(scene, tmp_path / "flight", rtk=False)
    write_gcp_files(scene, project, RUN)
    _align(monkeypatch, project, tmp_path / "flight")
    base = project / "photogrammetry" / RUN

    def read(rel: str) -> dict:
        return json.loads((base / rel).read_text("utf-8"))

    align = read("report/align.json")
    assert align["schema"] == "aio.photo-align/1" and align["run"] == RUN
    assert align["images"]["registered"] == len(scene.names)
    frame = read("sparse/frame.json")
    assert frame["schema"] == "aio.photo-frame/1" and frame["frame"] == "grid"
    assert _crs(frame["crs"]) and _vec3(frame["origin"]) and set(frame["enu"]) == {"lon", "lat", "h"}
    photos = read("sparse/photos.json")
    assert photos["schema"] == "aio.photo-list/1" and set(photos["photos"]) == set(scene.names)
    for rec in photos["photos"].values():
        assert (Path(photos["imageRoot"]) / rec["name"]).is_file()
    cams = read("cameras-sfm.json")
    check_cameras_file(cams)
    assert (
        cams["run"] == RUN and cams["origin"] == frame["origin"] and len(cams["cameras"]) == len(scene.names)
    )
    # a GNSS-only alignment measures the points but uses none of them
    acc = read("report/accuracy.json")
    assert acc["schema"] == "aio.photo-accuracy/1"
    assert acc["points"] and all(p["usedInAdjustment"] is False for p in acc["points"])

    result, _ = run_job(PhotoGeoref(), project, {"run": RUN}, job_id="georef")
    assert result["status"] == "done"
    check_cameras_file(read("cameras-sfm.json"))
    assert read("sparse/frame.json")["schema"] == "aio.photo-frame/1"
    assert read("sparse/photos.json")["schema"] == "aio.photo-list/1"
    acc = read("report/accuracy.json")
    used = {p["id"]: p["usedInAdjustment"] for p in acc["points"]}
    # control points that constrained the adjustment: true; every checkpoint: false (a control point
    # far off the others: test_photo_georef)
    assert used == {
        "GCP1": True,
        "GCP2": True,
        "GCP3": True,
        "GCP4": True,
        "GCP5": True,
        "CHK1": False,
        "CHK2": False,
        "CHK3": False,
        "CHK4": False,
    }
    assert acc["rmse"]["control"]["n"] == 5 and acc["checkpointsInAdjustment"] is False


def test_a_disabled_point_is_not_used_and_not_listed(monkeypatch, project, tmp_path):
    scene = make_scene(rows=4, cols=6, points=2000, gnss_sigma=(2.5, 4.0), seed=9)
    write_scene_photos(scene, tmp_path / "flight", rtk=False)
    path = write_gcp_files(scene, project, RUN)
    _align(monkeypatch, project, tmp_path / "flight")
    data = json.loads(path.read_text("utf-8"))
    next(p for p in data["points"] if p["id"] == "GCP5")["disabled"] = True
    path.write_text(json.dumps(data), "utf-8")
    run_job(PhotoGeoref(), project, {"run": RUN}, job_id="georef")
    acc = json.loads((project / "photogrammetry" / RUN / "report/accuracy.json").read_text("utf-8"))
    used = {p["id"]: p["usedInAdjustment"] for p in acc["points"]}
    assert "GCP5" not in used and used["GCP1"] is True and acc["rmse"]["control"]["n"] == 4


# ------------------------------------------------------------------- spaces and other letters


SPACED = ("Mapping Photos/DCIM/100 MEDIA", "Mapping Photos/DCIM/101 Média ñ")


def _spaced_flight(scene, root: Path) -> dict[str, str]:
    """The scene's photos split over two camera folders with spaces and accents below the common
    folder (as a drone card copied to a laptop), file names with spaces and %; returns the photo
    key (path below ``root``) of each scene name."""
    flat = root / ".flat"
    write_scene_photos(scene, flat, rtk=True)
    keys = {}
    for i, name in enumerate(scene.names):
        stem = Path(name).stem
        new = f"{SPACED[i % 2]}/{stem} 50% ü.JPG" if i % 3 == 0 else f"{SPACED[i % 2]}/{name}"
        dest = root / new
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(flat / name), dest)
        keys[name] = new
    flat.rmdir()
    return keys


def test_photo_names_with_spaces_and_accents_below_the_common_folder(monkeypatch, project, tmp_path):
    scene = make_scene(rows=4, cols=6, points=3000, gnss_sigma=(0.02, 0.03), seed=9)
    flight = tmp_path / "Asset Inspections" / "Site A"
    keys = _spaced_flight(scene, flight)
    _manifest(project)
    gcp = write_gcp_files(scene, project, RUN)
    data = json.loads(gcp.read_text("utf-8"))  # marks name photos by their keys
    for p in data["points"]:
        for m in p["marks"]:
            m["photo"] = keys[m["photo"]]
    gcp.write_text(json.dumps(data), "utf-8")
    result, _ = _align(monkeypatch, project, flight)
    assert result["status"] == "done"
    base = project / "photogrammetry" / RUN
    # ODM reads safe links; each one names its photo's key, spaces and accents as they are
    links = json.loads((base / "odm" / "names.json").read_text("utf-8"))
    assert sorted(links.values()) == sorted(keys.values())
    run = json.loads((base / "run.json").read_text("utf-8"))
    assert run["photos"]["registered"] == len(scene.names) and run["photos"]["rejected"] == []
    # the COLMAP text model holds no raw space; read back, the names are the keys again
    text = (base / "sparse" / "images.txt").read_text("utf-8")
    assert "Mapping%20Photos/DCIM/101%20Média%20ñ/" in text and "%2050%25%20ü.JPG" in text
    for line in text.splitlines()[2::2]:
        assert len(line.split()) == 10
    model, _ = read_sparse(base / "sparse")
    assert sorted(im.name for im in model.images.values()) == sorted(keys.values())
    photos = json.loads((base / "sparse" / "photos.json").read_text("utf-8"))
    assert set(photos["photos"]) == set(keys.values())
    for key, rec in photos["photos"].items():
        assert (Path(photos["imageRoot"]) / rec["name"]).resolve() == (flight / key).resolve()
    cams = json.loads((base / "cameras-sfm.json").read_text("utf-8"))
    assert sorted(c["photo"] for c in cams["cameras"]) == sorted(keys.values())
    # ground control by the same keys, through georef
    result, _ = run_job(PhotoGeoref(), project, {"run": RUN}, job_id="georef")
    assert result["status"] == "done"
    acc = json.loads((base / "report" / "accuracy.json").read_text("utf-8"))
    assert acc["rmse"]["control"]["n"] == 5 and acc["rmse"]["check"]["n"] == 4
    model, _ = read_sparse(base / "sparse")
    assert sorted(im.name for im in model.images.values()) == sorted(keys.values())
    # products find every photo by its key
    loaded = load_run(project, RUN)
    for v in loaded.model.views:
        assert v.path is not None and v.path.resolve() == (flight / v.name).resolve()
    res, _ = run_job(
        PhotoProducts(), project, {"run": RUN, "products": ["dsm"], "preset": "fast"}, job_id="p1"
    )
    assert res["status"] == "done" and (base / "dsm.tif").is_file()


def test_names_are_escaped_reversibly():
    names = ("a b/c d.JPG", "100%/x %20 y.jpg", "tab\there.jpg", "Média ñ/ü.JPG", "%25 %", "nb\xa0sp　.jpg")
    for name in names:
        assert len(encode_name(name).split()) == 1
        assert decode_name(encode_name(name)) == name
    # what an earlier build wrote (percent first, then space) reads the same
    assert decode_name("a%2520b%20c") == "a%20b c"


# ------------------------------------------------------------------------------- memory cap


def test_one_memory_setting_caps_the_colmap_guard_and_products(monkeypatch):
    gb = 10**9
    monkeypatch.delenv(native.MEMORY_ENV, raising=False)
    assert native.memory_cap() is None
    assert memory_limit(64 * gb, 60 * gb, cap=native.memory_cap()) == 48 * gb  # today's default
    assert native.memory_budget() >= 512 * 2**20
    monkeypatch.setenv(native.MEMORY_ENV, "3000")
    cap = 3000 * 2**20
    assert native.memory_cap() == cap and native.memory_budget() == cap
    assert memory_limit(64 * gb, 60 * gb, cap=native.memory_cap()) == cap
    assert memory_limit(*memory_status(), cap=native.memory_cap()) == cap
    monkeypatch.setenv(native.MEMORY_ENV, "not a number")
    assert native.memory_cap() is None


@pytest.mark.parametrize("value, expected", [("64", 64), ("10", 64), ("2048.5", 2048)])
def test_the_memory_cap_has_a_floor(monkeypatch, value, expected):
    monkeypatch.setenv(native.MEMORY_ENV, value)
    assert native.memory_cap() == expected * 2**20
