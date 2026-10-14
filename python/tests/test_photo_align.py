"""photo.align on the fake ODM (python/tests/fake_odm): photo reading, the ODM project, the run files."""

import json
import os
import sys
import threading
import time
from pathlib import Path

import numpy as np
import pytest

from aio_pipelines.photo import align as A
from aio_pipelines.photo.model import qvec_to_rotmat
from aio_pipelines.photo.odm import runner as R
from aio_pipelines.runtime import INPUTS_CHANGED, Cancelled, JobError
from conftest import run_job
from photo_g2_synth import make_scene, synthetic_jpeg, write_scene_photos

FAKE = Path(__file__).parent / "fake_odm"


@pytest.fixture
def odm(monkeypatch, tmp_path):
    monkeypatch.setenv("FAKE_ODM_PYTHON", sys.executable)
    monkeypatch.setenv(R.ODM_ENV, str(FAKE))
    monkeypatch.setenv("FAKE_ODM_UDP_PORT", "0")
    monkeypatch.setattr(R, "nvcuda_present", lambda env=None: False)  # the same on a GPU workstation
    log = tmp_path / "odm-args.jsonl"
    monkeypatch.setenv("FAKE_ODM_ARGS_LOG", str(log))
    return log


def _params(folder: Path, **kw) -> dict:
    return {"photos": {"folders": [str(folder)]}, "preset": "standard", "run": "r1", **kw}


def _linked(project: Path) -> set[str]:
    """File names of the photos inspection kept (they are the ones linked into the ODM project)."""
    names = json.loads((project / "photogrammetry" / "r1" / "odm" / "names.json").read_text())
    return {Path(k).name for k in names.values()}


def _no_gps(photo_set) -> set[str]:
    # a no-gps shot keeps a geotag with only its relative altitude, gimbal and flight
    return {p["name"] for p in photo_set.truth["photos"] if p["kind"] == "no-gps"}


def test_align_a_folder_end_to_end(odm, project, photo_mini):
    result, rec = run_job(A.PhotoAlign(), project, _params(photo_mini.photos))
    assert result["status"] == "done"
    base = project / "photogrammetry" / "r1"
    run = json.loads((base / "run.json").read_text())
    assert run["status"] == "aligned"
    assert [s["name"] for s in run["stages"]] == list(A.STAGES)
    assert all(s["state"] == "done" for s in run["stages"])
    assert run["engine"]["name"] == "odm" and run["engine"]["version"] == "3.6.2"
    assert run["versions"]["odm"] == "3.6.2"
    assert (base / "sparse" / "frame.json").is_file() and (base / "cameras-sfm.json").is_file()
    align = json.loads((base / "report" / "align.json").read_text())
    assert align["mapper"] == "opensfm"
    assert align["images"]["registered"] == len(_linked(project) - _no_gps(photo_mini))
    names = json.loads((base / "odm" / "names.json").read_text())
    assert sorted(names.values()) == sorted(
        run_key for run_key in json.loads((base / "sparse" / "photos.json").read_text())["photos"]
    )
    args = json.loads(odm.read_text().splitlines()[-1])
    assert args[args.index("--end-with") + 1] == "opensfm" and "--rerun-from" not in args
    assert "--no-gpu" in args  # no CUDA driver on the test machine


def test_source_photos_are_linked_never_written(odm, project, photo_mini):
    before = {p: p.read_bytes() for p in photo_mini.photos.iterdir()}
    run_job(A.PhotoAlign(), project, _params(photo_mini.photos))
    assert {p: p.read_bytes() for p in photo_mini.photos.iterdir()} == before


def test_rtk_mode_writes_geo_txt_with_the_rtk_accuracy(odm, project, photo_mini):
    run_job(A.PhotoAlign(), project, _params(photo_mini.photos, gnss="rtk"))
    geo = (project / "photogrammetry" / "r1" / "odm" / "geo.txt").read_text().splitlines()
    assert geo[0] == "EPSG:4326" and len(geo) == 1 + len(_linked(project) - _no_gps(photo_mini))
    args = json.loads(odm.read_text().splitlines()[-1])
    assert args[args.index("--geo") + 1].endswith("geo.txt")


def test_photos_odm_could_not_place_are_named(odm, project, photo_mini, monkeypatch):
    monkeypatch.setenv("FAKE_ODM_DROP", "00001.jpg")
    run_job(A.PhotoAlign(), project, _params(photo_mini.photos))
    align = json.loads((project / "photogrammetry" / "r1" / "report" / "align.json").read_text())
    assert any(r["reason"] == "Not enough matches with other photos." for r in align["rejected"])


def test_the_gpu_used_is_recorded(odm, project, photo_mini, monkeypatch):
    monkeypatch.setattr(R, "nvcuda_present", lambda env=None: True)
    run_job(A.PhotoAlign(), project, _params(photo_mini.photos))
    run = json.loads((project / "photogrammetry" / "r1" / "run.json").read_text())
    assert run["engine"]["gpu"] == {"features": True}


def test_resume_after_a_cancel_in_odm_runs_odm_again_plainly(odm, project, photo_mini, monkeypatch, tmp_path):
    pids = tmp_path / "pids"
    monkeypatch.setenv("FAKE_ODM_HANG", "opensfm")
    monkeypatch.setenv("FAKE_ODM_PIDS", str(pids))
    cancel = threading.Event()

    def stop():
        for _ in range(600):
            if pids.exists():
                cancel.set()
                return
            time.sleep(0.1)

    threading.Thread(target=stop, daemon=True).start()
    with pytest.raises(Cancelled):
        run_job(A.PhotoAlign(), project, _params(photo_mini.photos), cancel=cancel)
    monkeypatch.delenv("FAKE_ODM_HANG")
    result, _ = run_job(A.PhotoAlign(), project, _params(photo_mini.photos))
    assert result["status"] == "done"
    assert "--rerun-from" not in json.loads(odm.read_text().splitlines()[-1])


def test_no_odm_is_a_plain_message_before_any_work(project, photo_mini, monkeypatch):
    monkeypatch.delenv(R.ODM_ENV, raising=False)
    with pytest.raises(JobError, match="Install it in Settings, Processing tools"):
        run_job(A.PhotoAlign(), project, _params(photo_mini.photos))
    assert not (project / "photogrammetry" / "r1" / "odm").exists()


def test_parameters_are_checked():
    p = A.PhotoAlign()
    with pytest.raises(JobError, match="photos, preset"):
        p.validate({})
    with pytest.raises(JobError, match="preset must be one of"):
        p.validate({"photos": {"folders": ["x"]}, "preset": "ultra"})
    # matching, mapper and maxImageSize are still accepted (older saved settings) and ignored
    assert (
        p.validate({"photos": {"folders": ["x"]}, "preset": "fast", "mapper": "global"})["mapper"] == "global"
    )


# ------------------------------------------------------------------------------- kept from the old engine


def test_bad_photos_are_rejected_with_reasons_and_unaligned_ones_named(odm, monkeypatch, project, tmp_path):
    scene = make_scene(rows=4, cols=6, points=3000)
    folder = tmp_path / "flight"
    paths = write_scene_photos(scene, folder, rtk=True)
    (folder / "zz_broken.JPG").write_bytes(paths[0].read_bytes()[:700])
    (folder / "zz_copy.JPG").write_bytes(paths[1].read_bytes())
    synthetic_jpeg(folder / "zz_nogps.JPG", lat=None, lon=None, size=(800, 600))
    monkeypatch.setenv("FAKE_ODM_DROP", "00006.jpg")  # IMG_0007.JPG, the seventh photo linked
    run_job(A.PhotoAlign(), project, _params(folder))
    run = json.loads((project / "photogrammetry/r1/run.json").read_text("utf-8"))
    reasons = {r["name"]: r["reason"] for r in run["photos"]["rejected"]}
    assert set(reasons) == {"zz_broken.JPG", "zz_copy.JPG", "IMG_0007.JPG", "zz_nogps.JPG"}
    assert "cannot be" in reasons["zz_broken.JPG"] and "IMG_0002.JPG" in reasons["zz_copy.JPG"]
    assert "matches" in reasons["IMG_0007.JPG"]
    assert run["photos"]["count"] == 27 and run["photos"]["registered"] == 23
    assert any("no GPS" in w for w in run["warnings"])


def test_changed_photos_refuse_the_resume(odm, monkeypatch, project, tmp_path):
    scene = make_scene(rows=4, cols=6, points=3000)
    folder = tmp_path / "flight"
    paths = write_scene_photos(scene, folder, rtk=True)
    pids = tmp_path / "pids"
    monkeypatch.setenv("FAKE_ODM_HANG", "opensfm")
    monkeypatch.setenv("FAKE_ODM_PIDS", str(pids))
    cancel = threading.Event()

    def stop():
        for _ in range(600):
            if pids.exists():
                cancel.set()
                return
            time.sleep(0.1)

    threading.Thread(target=stop, daemon=True).start()
    with pytest.raises(Cancelled):
        run_job(A.PhotoAlign(), project, _params(folder), cancel=cancel)
    monkeypatch.delenv("FAKE_ODM_HANG")
    st = paths[3].stat()
    os.utime(paths[3], ns=(st.st_atime_ns, st.st_mtime_ns + 5_000_000_000))
    with pytest.raises(JobError, match=INPUTS_CHANGED):
        run_job(A.PhotoAlign(), project, _params(folder))


def test_too_few_usable_photos_fail_clearly(odm, project, tmp_path):
    folder = tmp_path / "f"
    synthetic_jpeg(folder / "a.jpg")
    (folder / "b.jpg").write_bytes(b"nope")
    with pytest.raises(JobError, match="at least 3"):
        run_job(A.PhotoAlign(), project, _params(folder))
    assert not (project / "photogrammetry").exists()


def test_a_missing_photos_layer_is_named(odm, project):
    with pytest.raises(JobError, match='no photos layer "photos"'):
        run_job(A.PhotoAlign(), project, {"photos": {"layer": "photos"}, "preset": "fast"})


def test_three_quaternion_of_a_nadir_camera_looks_down():
    R_ = np.array([[1.0, 0, 0], [0, -1.0, 0], [0, 0, -1.0]])  # image up = north, looking down
    x, y, z, w = A.three_quaternion(R_)
    M = qvec_to_rotmat(np.array([w, x, y, z]))
    # three.js: the camera's -Z (view) maps to world -Y (down), its +Y (image up) to north (-Z)
    assert np.allclose(M @ [0, 0, -1], [0, -1, 0], atol=1e-9)
    assert np.allclose(M @ [0, 1, 0], [0, 0, -1], atol=1e-9)
