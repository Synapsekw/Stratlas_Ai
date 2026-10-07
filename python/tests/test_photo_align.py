"""photo.align end to end on a known scene, through the engine adapter (no COLMAP needed).

The engine here (``photo_g2_synth.SyntheticEngine``) returns the true reconstruction in an
arbitrary frame with noise; everything else is the real pipeline: EXIF and XMP, inspection,
pairs, georeferencing, bundle adjustment, reports, run files, resume and cancel.
"""

import json
import os
import sys
import threading
import time

import numpy as np
import pytest

from aio_pipelines.photo import crs as C
from aio_pipelines.photo.align import (
    PhotoAlign,
    choose_pairs,
    feature_threads,
    read_sparse,
    three_quaternion,
)
from aio_pipelines.photo.colmap_io import ColmapEngine, EngineJob, licence_problem
from aio_pipelines.photo.exif import read_photo
from aio_pipelines.photo.model import qvec_to_rotmat
from aio_pipelines.runtime import INPUTS_CHANGED, Cancelled, JobError
from conftest import run_job
from photo_g2_synth import SyntheticEngine, make_scene, synthetic_jpeg, write_gcp_files, write_scene_photos


@pytest.fixture
def scene():
    return make_scene(rows=4, cols=6, points=3000)


def _run(monkeypatch, project, params, engine, job_id="j1", cancel=None):
    monkeypatch.setattr(PhotoAlign, "engine_factory", staticmethod(lambda: engine))
    return run_job(PhotoAlign(), project, params, job_id=job_id, cancel=cancel)


def _truth_grid(scene, frame):
    grid = C.GridFrame(C.crs_of(frame["crs"]), tuple(frame["origin"]))
    return grid.from_geodetic(*scene.enu.to_geodetic(scene.centres))


def _params(folder, **kw):
    return {"photos": {"folders": [str(folder)]}, "preset": "standard", "run": "r1", **kw}


def test_align_a_folder_end_to_end(monkeypatch, project, scene, tmp_path):
    folder = tmp_path / "flight"
    write_scene_photos(scene, folder, rtk=True)
    engine = SyntheticEngine(scene)
    result, rec = _run(monkeypatch, project, _params(folder), engine)
    assert result["status"] == "done"
    assert engine.calls == ["features", "match", "map:global"]
    base = project / "photogrammetry" / "r1"
    run = json.loads((base / "run.json").read_text("utf-8"))
    assert run["schema"] == "aio.photo-run/1" and run["status"] == "aligned" and run["id"] == "r1"
    assert (
        run["photos"]["count"] == 24 and run["photos"]["registered"] == 24 and run["photos"]["rejected"] == []
    )
    assert run["crs"] == {"epsg": 32639}
    assert run["heights"]["source"] == "ellipsoidal"  # RTK fixed photos
    assert [s["name"] for s in run["stages"]] == [
        "inspect",
        "features",
        "match",
        "sfm",
        "georef",
        "report",
        "commit",
    ]
    assert all(s["state"] == "done" for s in run["stages"])
    assert run["cameras"][0]["model"] == "SYN-20" and run["cameras"][0]["photos"] == 24
    assert "frames" not in run
    assert set(run["outputs"]["files"]) >= {
        "photogrammetry/r1/report/align.json",
        "photogrammetry/r1/sparse/",
    }
    # cameras land on truth: RTK priors (2 cm) and bundle adjustment
    model, frame = read_sparse(base / "sparse")
    truth = _truth_grid(scene, frame)
    by = model.image_by_name()
    err = np.array([np.linalg.norm(by[n].centre - truth[i]) for i, n in enumerate(scene.names)])
    assert np.median(err) < 0.05 and err.max() < 0.12  # GNSS noise is 2 cm (h) and 3 cm (v)
    acc = json.loads((base / "report" / "accuracy.json").read_text("utf-8"))
    assert acc["checkpointsInAdjustment"] is False and acc["points"] == []
    assert acc["images"] == {"total": 24, "registered": 24} and acc["meanReprojPx"] < 0.6
    assert acc["cameraResiduals"]["rmseHorizontalM"] < 0.05
    assert any("No ground control" in w["message"] for w in acc["warnings"])
    align = json.loads((base / "report" / "align.json").read_text("utf-8"))
    assert align["registered"] == sorted(scene.names) and align["matching"] == "exhaustive"
    cams = json.loads((base / "cameras-sfm.json").read_text("utf-8"))
    assert len(cams["cameras"]) == 24 and cams["origin"] == frame["origin"]
    photos = json.loads((base / "sparse" / "photos.json").read_text("utf-8"))
    assert (
        set(photos["photos"]) == set(scene.names)
        and photos["photos"]["IMG_0001.JPG"]["gnss"]["sigmaH"] < 0.05
    )
    # progress was reported per stage
    steps = {p.get("step") for p in rec.of("progress")}
    assert {"inspect", "features", "match", "sfm", "georef", "report", "commit"} <= steps


def test_bad_photos_are_rejected_with_reasons_and_unaligned_ones_named(monkeypatch, project, scene, tmp_path):
    folder = tmp_path / "flight"
    paths = write_scene_photos(scene, folder, rtk=True)
    (folder / "zz_broken.JPG").write_bytes(paths[0].read_bytes()[:700])
    (folder / "zz_copy.JPG").write_bytes(paths[1].read_bytes())
    synthetic_jpeg(folder / "zz_nogps.JPG", lat=None, lon=None, size=(800, 600))
    engine = SyntheticEngine(scene, unregistered={"IMG_0007.JPG"})
    _run(monkeypatch, project, _params(folder), engine)
    run = json.loads((project / "photogrammetry/r1/run.json").read_text("utf-8"))
    reasons = {r["name"]: r["reason"] for r in run["photos"]["rejected"]}
    assert set(reasons) == {"zz_broken.JPG", "zz_copy.JPG", "IMG_0007.JPG", "zz_nogps.JPG"}
    assert "cannot be" in reasons["zz_broken.JPG"] and "IMG_0002.JPG" in reasons["zz_copy.JPG"]
    assert "matches" in reasons["IMG_0007.JPG"]
    assert run["photos"]["count"] == 27 and run["photos"]["registered"] == 23
    assert any("no GPS" in w for w in run["warnings"])


def test_gnss_only_standard_accuracy_is_reported_not_hidden(monkeypatch, project, tmp_path):
    scene = make_scene(rows=4, cols=6, points=3000, gnss_sigma=(2.5, 4.0), seed=9)
    folder = tmp_path / "flight"
    write_scene_photos(scene, folder, rtk=False)
    write_gcp_files(scene, project, "r1")
    _run(monkeypatch, project, _params(folder), SyntheticEngine(scene))
    acc = json.loads((project / "photogrammetry/r1/report/accuracy.json").read_text("utf-8"))
    # checkpoints are measured through GNSS-only cameras: metres off, and said so
    assert acc["rmse"]["check"]["n"] == 4 and "control" not in acc["rmse"]
    # a small block (95 x 28 m) under 2.5 m GNSS noise tilts by degrees: metres at the ground
    assert 0.1 < acc["rmse"]["check"]["horizontalM"] < 10
    assert all(p.get("usedInAdjustment") is False for p in acc["points"] if p["role"] == "control")
    assert any("No ground control was used" in w["message"] for w in acc["warnings"])
    assert acc["checkpointsInAdjustment"] is False
    # relative scale is right even when the absolute position is not (within 1 %)
    model, frame = read_sparse(project / "photogrammetry/r1/sparse")
    truth = _truth_grid(scene, frame)
    by = model.image_by_name()
    est = np.array([by[n].centre for n in scene.names])
    d_est = np.linalg.norm(est[0] - est[-1])
    d_true = np.linalg.norm(truth[0] - truth[-1])
    assert abs(d_est / d_true - 1) < 0.01
    # predictions are written for G4 into gcp.json, marks untouched
    gcp = json.loads((project / "photogrammetry/r1/gcp.json").read_text("utf-8"))
    p = next(p for p in gcp["points"] if p["id"] == "CHK1")
    assert p["predicted"] and all(m["state"] == "confirmed" for m in p["marks"])
    assert all(q["radiusPx"] > 8 for q in p["predicted"])


def test_rtk_gnss_only_checkpoints_are_within_three_gsd(monkeypatch, project, scene, tmp_path):
    folder = tmp_path / "flight"
    write_scene_photos(scene, folder, rtk=True)
    write_gcp_files(scene, project, "r1")
    _run(monkeypatch, project, _params(folder), SyntheticEngine(scene))
    acc = json.loads((project / "photogrammetry/r1/report/accuracy.json").read_text("utf-8"))
    gsd = acc["gsdCm"] / 100
    assert acc["rmse"]["check"]["horizontalM"] < 3 * gsd
    # heights: the engine's 1 % focal error cannot be corrected from a nadir block at one height
    assert any("Nadir photos from one flying height" in w["message"] for w in acc["warnings"])


def test_resume_after_a_cancel_in_matching_restarts_at_matching(monkeypatch, project, scene, tmp_path):
    folder = tmp_path / "flight"
    write_scene_photos(scene, folder, rtk=True)
    engine = SyntheticEngine(scene)
    cancel = threading.Event()
    engine.cancel_in_match = cancel
    with pytest.raises(Cancelled):
        _run(monkeypatch, project, _params(folder), engine, cancel=cancel)
    run = json.loads((project / "photogrammetry/r1/run.json").read_text("utf-8"))
    assert run["status"] == "cancelled"
    assert {s["name"]: s["state"] for s in run["stages"]}["match"] == "cancelled"
    engine.calls.clear()
    result, _ = _run(monkeypatch, project, _params(folder), engine)
    assert result["status"] == "done" and engine.calls == ["match", "map:global"]


def test_changed_photos_refuse_the_resume(monkeypatch, project, scene, tmp_path):
    folder = tmp_path / "flight"
    paths = write_scene_photos(scene, folder, rtk=True)
    engine = SyntheticEngine(scene)
    cancel = threading.Event()
    engine.cancel_in_match = cancel
    with pytest.raises(Cancelled):
        _run(monkeypatch, project, _params(folder), engine, cancel=cancel)
    st = paths[3].stat()
    os.utime(paths[3], ns=(st.st_atime_ns, st.st_mtime_ns + 5_000_000_000))
    with pytest.raises(JobError, match=INPUTS_CHANGED):
        _run(monkeypatch, project, _params(folder), engine)


def test_parameters_are_checked():
    p = PhotoAlign()
    with pytest.raises(JobError, match="needs: preset"):
        p.validate({"photos": {"layer": "x"}})
    with pytest.raises(JobError, match="mapper must be one of"):
        p.validate({"photos": {"layer": "x"}, "preset": "fast", "mapper": "magic"})
    with pytest.raises(JobError, match="photos must be"):
        p.validate({"photos": {"layer": "x", "folders": ["a"]}, "preset": "fast"})
    with pytest.raises(JobError, match="maxImageSize"):
        p.validate({"photos": {"layer": "x"}, "preset": "fast", "maxImageSize": 100})
    with pytest.raises(JobError, match="does not take: bogus"):
        p.validate({"photos": {"layer": "x"}, "preset": "fast", "bogus": 1})
    with pytest.raises(JobError, match="run must be"):
        p.validate({"photos": {"layer": "x"}, "preset": "fast", "run": "../evil"})


def test_too_few_usable_photos_fail_clearly(monkeypatch, project, tmp_path):
    folder = tmp_path / "f"
    synthetic_jpeg(folder / "a.jpg")
    (folder / "b.jpg").write_bytes(b"nope")
    with pytest.raises(JobError, match="at least 3"):
        _run(monkeypatch, project, _params(folder), SyntheticEngine(make_scene(rows=2, cols=2)))
    assert not (project / "photogrammetry").exists()


def test_a_missing_photos_layer_is_named(monkeypatch, project):
    with pytest.raises(JobError, match='no photos layer "photos"'):
        _run(
            monkeypatch,
            project,
            {"photos": {"layer": "photos"}, "preset": "fast"},
            SyntheticEngine(make_scene()),
        )


def test_gps_pairs_follow_the_footprint(tmp_path):
    metas = []
    for i in range(30):  # a straight line of nadir photos 10 m apart at 60 m
        lat = 25.0 + (i * 10) / 111_320
        t = f"2026:01:02 10:00:{i:02d}"
        metas.append(
            read_photo(
                f"n{i}", synthetic_jpeg(tmp_path / f"n{i}.jpg", lat=lat, lon=51.0, alt=60, rel=60, time=t)
            )
        )
    H = np.array([60.0] * 30)
    names = {m.key: m.key for m in metas}
    pairs, how = choose_pairs(metas, H, "gps", names)
    assert how == "gps"
    pair_set = {tuple(sorted(p)) for p in pairs}
    assert ("n0", "n1") in pair_set and ("n0", "n5") in pair_set  # within the footprint
    assert ("n0", "n29") not in pair_set  # 290 m apart: no common ground
    # the footprint of a 24 mm lens at 60 m is about 90 m across: neighbours up to ~2 footprints
    assert max(abs(int(a[1:]) - int(b[1:])) for a, b in pair_set) <= 20


def test_oblique_views_pair_by_where_they_look(tmp_path):
    # photos 150 m apart, 75 m up, looking 45 degrees down: two at the same ground point from
    # either side (facing each other: no pair), and two looking the same way at nearby ground
    d = 75 / 111_320
    shots = [("a", -d, 0, 0), ("b", d, 180, 1), ("c", d, 0, 2), ("e", 3 * d, 0, 3)]
    metas = []
    for name, dlat, yaw, k in shots:
        p = synthetic_jpeg(
            tmp_path / f"{name}.jpg",
            lat=25.0 + dlat,
            lon=51.0,
            alt=75,
            rel=75,
            yaw=yaw,
            pitch=-45,
            time=f"2026:01:02 10:{10 * k:02d}:00",
        )
        metas.append(read_photo(p.name, p))
    pairs, _ = choose_pairs(metas, np.array([75.0] * 4), "gps", {m.key: m.key for m in metas})
    s = {tuple(sorted(p)) for p in pairs}
    assert ("a.jpg", "b.jpg") not in s  # same target, facing each other across the site
    assert ("c.jpg", "e.jpg") in s  # 150 m apart, looking the same way at ground 150 m apart


def test_feature_threads_fit_the_memory_of_a_laptop(monkeypatch):
    monkeypatch.setattr(os, "cpu_count", lambda: 24)
    info = {"groups": [{"width": 5472, "height": 3648}], "maxImageSize": 2736}
    laptop = feature_threads(info, 16 * 10**9)
    assert 3 <= laptop <= 8
    assert feature_threads(info, 64 * 10**9) == 24
    assert feature_threads({**info, "maxImageSize": 1368}, 16 * 10**9) > laptop
    assert feature_threads(info, 0) == 24


def test_three_quaternion_of_a_nadir_camera_looks_down():
    R = np.array([[1.0, 0, 0], [0, -1.0, 0], [0, 0, -1.0]])  # image up = north, looking down
    x, y, z, w = three_quaternion(R)
    M = qvec_to_rotmat(np.array([w, x, y, z]))
    # three.js: the camera's -Z (view) maps to world -Y (down), its +Y (image up) to north (-Z)
    assert np.allclose(M @ [0, 0, -1], [0, -1, 0], atol=1e-9)
    assert np.allclose(M @ [0, 1, 0], [0, 0, -1], atol=1e-9)


# ------------------------------------------------------------------------------- the engine worker


def test_cancel_stops_the_engine_worker_within_five_seconds(tmp_path):
    eng = ColmapEngine(python=sys.executable)
    cancel = threading.Event()

    def check():
        if cancel.is_set():
            raise Cancelled()

    job = EngineJob(work=tmp_path / "w", image_root=tmp_path, images=[], groups=[], check=check)
    pressed: list[float] = []

    def progress(f, m=None):  # the worker is running and talking: press Cancel now
        if not pressed:
            pressed.append(time.monotonic())
            cancel.set()

    t0 = time.monotonic()
    with pytest.raises(Cancelled):
        eng._run(job, "probe-sleep", {"seconds": 120}, progress, "probe")
    assert pressed, "the worker never reported progress"
    assert time.monotonic() - pressed[0] < 5.0
    assert time.monotonic() - t0 < 60.0


def test_the_engine_refuses_a_missing_pycolmap():
    try:
        import pycolmap  # noqa: F401
    except ImportError:
        with pytest.raises(JobError, match="COLMAP build"):
            ColmapEngine(python=sys.executable).versions()
        return
    pytest.skip("pycolmap is importable in this environment")


def test_licence_problem_names_bundled_gpl_libraries(tmp_path):
    pkg = tmp_path / "site" / "pycolmap"
    libs = tmp_path / "site" / "pycolmap.libs"
    pkg.mkdir(parents=True)
    libs.mkdir()
    (pkg / "__init__.py").write_text("")
    (libs / "cholmod-abc.dll").write_bytes(b"")
    (libs / "ceres-abc.dll").write_bytes(b"")
    mod = type("M", (), {"__file__": str(pkg / "__init__.py")})
    msg = licence_problem(mod)
    assert msg and "cholmod" in msg and "ceres" not in msg
    (libs / "cholmod-abc.dll").unlink()
    assert licence_problem(mod) is None
