"""photo.align on the fake ODM (python/tests/fake_odm): photo reading, the ODM project, the run files."""

import json
import os
import re
import sys
import threading
import time
from pathlib import Path

import numpy as np
import pytest

import odm_synth
from aio_pipelines.photo import align as A
from aio_pipelines.photo.model import Camera, Image, SparseModel, project_points, qvec_to_rotmat
from aio_pipelines.photo.odm import runner as R
from aio_pipelines.runtime import INPUTS_CHANGED, Cancelled, JobError
from conftest import offset_latlon, run_job
from photo_g2_synth import (
    SITE_LAT,
    SITE_LON,
    make_scene,
    synthetic_jpeg,
    write_gcp_files,
    write_scene_photos,
)

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
    # the undistorted photos are sized for the photos' own resolution, as products will ask (I3)
    metas = [A.read_photo(p.name, p) for p in sorted(Path(photo_mini.photos).iterdir()) if p.is_file()]
    gsd = A.estimate_gsd_cm(metas)
    assert gsd is not None and 0.1 < gsd < 20
    assert float(args[args.index("--orthophoto-resolution") + 1]) == pytest.approx(gsd, rel=0.1)


def test_the_ground_resolution_is_estimated_from_height_and_lens():
    from aio_pipelines.photo.exif import PhotoMeta

    m = PhotoMeta("a", Path("a.jpg"), width=4000, height=3000, focal35=24.0, rel_alt=100.0)
    # 100 m x 43.27 mm / (24 mm x 5000 px diagonal) = 3.61 cm
    assert A.estimate_gsd_cm([m, m]) == pytest.approx(3.6058, abs=1e-3)
    assert A.estimate_gsd_cm([PhotoMeta("b", Path("b.jpg"), width=4000, height=3000, focal35=24.0)]) is None
    assert A.estimate_gsd_cm([PhotoMeta("c", Path("c.jpg"), width=4000, height=3000, rel_alt=50.0)]) is None


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


def test_an_alignment_begun_by_the_earlier_engine_is_refused_and_a_fresh_run_works(
    odm, project, photo_mini, monkeypatch, tmp_path
):
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
    # what the earlier engine's inspect step left: no ODM project
    (project / "photogrammetry" / "r1" / "odm" / "names.json").unlink()
    with pytest.raises(JobError) as e:
        run_job(A.PhotoAlign(), project, _params(photo_mini.photos))
    assert str(e.value) == A.OLD_JOB
    assert "Remove it from the Processing list and use Create maps from photos again" in A.OLD_JOB
    # Create maps from photos again: the wizard gives the new alignment a new run id
    result, _ = run_job(A.PhotoAlign(), project, _params(photo_mini.photos, run="r2"), job_id="j2")
    assert result["status"] == "done"
    run = json.loads((project / "photogrammetry" / "r2" / "run.json").read_text())
    assert run["status"] == "aligned" and run["engine"]["name"] == "odm"


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


def _text(base: Path) -> str:
    return "\n".join(
        (base / rel).read_text() for rel in ("run.json", "report/align.json", "report/accuracy.json")
    )


def test_ignored_gnss_is_said_plainly_and_no_nan_is_written(odm, project, photo_mini):
    result, _ = run_job(A.PhotoAlign(), project, _params(photo_mini.photos, gnss="ignore"))
    assert result["status"] == "done"
    base = project / "photogrammetry" / "r1"
    rows = (base / "odm" / "geo.txt").read_text().splitlines()[1:]
    assert rows and all(r.endswith(" 50.000 50.000") for r in rows)  # a loose guide only
    assert not re.search(r"\bnan\b", _text(base), re.IGNORECASE)
    align = json.loads((base / "report" / "align.json").read_text())
    assert any(w.startswith("GNSS was ignored") for w in align["warnings"])


def _scene_model(scene) -> SparseModel:
    m = SparseModel()
    m.cameras[1] = scene.camera
    for i, (name, r, c) in enumerate(zip(scene.names, scene.rotations, scene.centres, strict=True)):
        m.images[i + 1] = Image(i + 1, name, 1, r, -r @ c)
    m.set_points(range(1, len(scene.points) + 1), scene.points, np.full((len(scene.points), 3), 128))
    return m


def test_gcp_marks_are_predicted_on_odms_poses(odm, project, tmp_path):
    scene = make_scene(rows=4, cols=6, points=3000)
    folder = tmp_path / "flight"
    write_scene_photos(scene, folder, rtk=True)
    path = write_gcp_files(scene, project, "r1", noise_px=0.0)
    # ODM's reconstruction is the truth (in the scene's own ENU frame, not the run's)
    links = {name: f"{i:05d}.jpg" for i, name in enumerate(sorted(scene.names))}
    recs, reference = odm_synth.opensfm_from_model(_scene_model(scene), scene.enu, links)
    fake = project / "photogrammetry" / "r1" / "odm" / ".fake"
    fake.mkdir(parents=True)
    (fake / "truth.json").write_text(json.dumps({**recs[0], "bias": [0, 0, 0], "reference": reference}))
    run_job(A.PhotoAlign(), project, _params(folder))
    gcp = json.loads(path.read_text())
    cam, seen = scene.camera, 0
    for g in scene.gcps:
        predicted = {q["photo"]: q for q in next(p for p in gcp["points"] if p["id"] == g.id)["predicted"]}
        for i, name in enumerate(scene.names):
            uv, z = project_points(cam, scene.rotations[i], scene.centres[i], g.enu[None])
            x, y = uv[0]
            if not (z[0] > 0 and 60 <= x < cam.width - 60 and 60 <= y < cam.height - 60):
                continue
            assert name in predicted, (g.id, name)
            off = float(np.hypot(predicted[name]["px"][0] - x, predicted[name]["px"][1] - y))
            assert off < 2.0, (g.id, name, off)
            seen += 1
    assert seen > 10


def test_camera_ids_follow_our_camera_groups():
    def cam(cid, w):
        return Camera(cid, "RADIAL", w, 100, [100.0, w / 2, 50.0, 0.0, 0.0])

    m = SparseModel()
    m.cameras = {1: cam(1, 300), 2: cam(2, 200)}  # ODM met the 300 px camera first
    eye = np.eye(3)
    m.images = {1: Image(1, "b.jpg", 1, eye, [0, 0, 0]), 2: Image(2, "a.jpg", 2, eye, [1, 0, 0])}
    A.group_cameras(m, {"a.jpg": 1, "b.jpg": 2})  # our group 1 is the 200 px camera
    assert m.cameras[1].width == 200 and m.cameras[2].width == 300
    assert {im.name: im.camera_id for im in m.images.values()} == {"a.jpg": 1, "b.jpg": 2}
    assert all(c.id == cid for cid, c in m.cameras.items())


def test_the_same_file_name_in_two_folders_stays_two_photos(odm, project, tmp_path):
    folders = [tmp_path / "flight" / "100MEDIA", tmp_path / "flight" / "101MEDIA"]
    for f, folder in enumerate(folders):
        for k in range(3):
            lat, lon = offset_latlon(SITE_LAT, SITE_LON, 20.0 * k, 20.0 * f)
            synthetic_jpeg(folder / f"DJI_000{k + 1}.JPG", lat=lat, lon=lon, time=f"2026:01:02 10:0{f}:0{k}")
    params = {"photos": {"folders": [str(f) for f in folders]}, "preset": "standard", "run": "r1"}
    result, _ = run_job(A.PhotoAlign(), project, params)
    assert result["status"] == "done"
    base = project / "photogrammetry" / "r1"
    keys = set(json.loads((base / "odm" / "names.json").read_text()).values())
    assert {"100MEDIA/DJI_0001.JPG", "101MEDIA/DJI_0001.JPG"} <= keys and len(keys) == 6
    assert set(json.loads((base / "sparse" / "photos.json").read_text())["photos"]) == keys
    assert json.loads((base / "report" / "align.json").read_text())["images"]["registered"] == 6


def test_a_changed_geo_txt_makes_odm_read_the_photos_again(odm, project, photo_mini):
    run_job(A.PhotoAlign(), project, _params(photo_mini.photos, gnss="standard"))
    odm_dir = project / "photogrammetry" / "r1" / "odm"
    rec = odm_dir / "opensfm" / "reconstruction.json"
    (odm_dir / "images.json").write_text("[]")  # ODM's photo database from the first run
    before = rec.stat().st_mtime_ns
    run_job(A.PhotoAlign(), project, _params(photo_mini.photos, gnss="standard"), job_id="j2")
    assert (odm_dir / "images.json").exists() and rec.stat().st_mtime_ns == before  # nothing changed
    run_job(A.PhotoAlign(), project, _params(photo_mini.photos, gnss="rtk"), job_id="j3")
    assert not (odm_dir / "images.json").exists() and rec.stat().st_mtime_ns != before


def test_a_geo_txt_with_no_rows_is_not_left_from_an_earlier_attempt(odm, project, tmp_path):
    folder = tmp_path / "f"
    for k in range(3):
        synthetic_jpeg(folder / f"IMG_000{k}.JPG", lat=None, lon=None, time=f"2026:01:02 10:00:0{k}")
    stale = project / "photogrammetry" / "r1" / "odm" / "geo.txt"
    stale.parent.mkdir(parents=True)
    stale.write_text("EPSG:4326\n00000.jpg 51 25 100 nan nan nan 1 1\n")
    with pytest.raises(JobError):  # nothing to place the photos by; the run needs a CRS
        run_job(A.PhotoAlign(), project, _params(folder, gnss="rtk", crs={"epsg": 32639}))
    assert not stale.exists()


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


def test_review_copies_of_a_photos_layer_are_placed_by_the_layer_poses(odm, project):
    """Review copies carry no EXIF: their positions come from the layer's poses, and ODM is told
    them in geo.txt (it would otherwise see photos with no GPS and leave the model unplaced)."""
    from PIL import Image as PILImage
    from pyproj import Transformer

    origin = [245884.9, 3179597.1, 0.0]
    poses = [[0.0, 60.0, 0.0], [10.0, 60.0, -5.0], [20.0, 61.0, -10.0]]
    items = []
    for k, pos in enumerate(poses):
        pixels = np.random.default_rng(k + 7).integers(0, 255, (120, 160, 3), dtype=np.uint8)
        path = project / "photos" / f"p{k}.jpg"
        path.parent.mkdir(exist_ok=True)
        PILImage.fromarray(pixels).save(path, "JPEG", quality=90)  # no EXIF, no XMP
        items.append(
            {
                "id": f"p{k}",
                "src": {"path": f"photos/p{k}.jpg"},
                "pos": pos,
                "q": [0, 0, 0, 1],
                "lens": {"model": "pinhole", "hfovDeg": 84},
            }
        )
    manifest = {
        "schema": "aio.project/1",
        "crs": {"epsg": 32639},
        "origin": origin,
        "verticalDatum": {"absAltOffsetM": 0},
        "layers": [{"kind": "photos", "id": "photos", "name": "Flight", "visible": True, "items": items}],
    }
    (project / "manifest.json").write_text(json.dumps(manifest), "utf-8")
    result, _ = run_job(
        A.PhotoAlign(), project, {"photos": {"layer": "photos"}, "preset": "fast", "run": "r1"}
    )
    assert result["status"] == "done"
    base = project / "photogrammetry" / "r1"
    geo = (base / "odm" / "geo.txt").read_text().splitlines()
    assert geo[0] == "EPSG:4326" and len(geo) == 1 + len(poses)
    to_ll = Transformer.from_crs(32639, 4326, always_xy=True)
    names = json.loads((base / "odm" / "names.json").read_text())
    rows = {names[r.split()[0]]: [float(v) for v in r.split()[1:4]] for r in geo[1:]}
    for k, (x, y, z) in enumerate(poses):
        lon, lat = to_ll.transform(origin[0] + x, origin[1] - z)
        got = rows[f"p{k}"]
        assert got[0] == pytest.approx(lon, abs=1e-7) and got[1] == pytest.approx(lat, abs=1e-7)
        assert got[2] == pytest.approx(origin[2] + y, abs=1e-3)
    args = json.loads(odm.read_text().splitlines()[0])
    assert args[args.index("--geo") + 1].endswith("geo.txt")
    run = json.loads((base / "run.json").read_text("utf-8"))
    assert not any("no GPS" in w for w in run.get("warnings", []))
