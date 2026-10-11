"""photo.align end to end on a known scene, through the engine adapter (no COLMAP needed).

The engine here (``photo_g2_synth.SyntheticEngine``) returns the true reconstruction in an
arbitrary frame with noise; everything else is the real pipeline: EXIF and XMP, inspection,
pairs, georeferencing, bundle adjustment, reports, run files, resume and cancel.
"""

import json
import os
import subprocess
import sys
import threading
import time

import numpy as np
import pytest

from aio_pipelines.photo import colmap_io
from aio_pipelines.photo import crs as C
from aio_pipelines.photo.align import (
    FEATURE_BASE_GB,
    FEATURE_BUDGET_GB,
    FEATURE_GB_PER_THREAD_AT_2736,
    MAX_FEATURE_THREADS,
    PhotoAlign,
    choose_pairs,
    feature_threads,
    first_octave,
    read_sparse,
    three_quaternion,
)
from aio_pipelines.photo.colmap_io import (
    START_TOLERANCE_S,
    ColmapEngine,
    EngineJob,
    MemoryExceeded,
    descendants,
    end_process,
    kill,
    kill_list,
    memory_limit,
    memory_status,
    process_memory,
    process_started,
    process_tree,
    tree_memory,
)
from aio_pipelines.photo.exif import read_photo
from aio_pipelines.photo.model import project_points, qvec_to_rotmat
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


@pytest.mark.parametrize(("marked", "limit_px"), [((), 80), (("GCP1", "GCP3"), 15)])
def test_predictions_are_on_the_targets_when_the_altitudes_are_off(
    monkeypatch, project, tmp_path, marked, limit_px
):
    # no RTK: the logged altitudes are 21.7 m below the survey, so the GNSS-only model is too
    scene = make_scene(rows=6, cols=6, points=4000, gnss_sigma=(2.5, 4.0), seed=4)
    folder = tmp_path / "flight"
    write_scene_photos(scene, folder, rtk=False, alt_offset=-21.7)
    path = write_gcp_files(scene, project, "r1")
    gcp = json.loads(path.read_text("utf-8"))
    for p in gcp["points"]:  # imported while the photos align: no marks, or two points marked
        if p["id"] not in marked:
            p["marks"] = []
    path.write_text(json.dumps(gcp), "utf-8")
    _run(monkeypatch, project, _params(folder), SyntheticEngine(scene))
    gcp = json.loads(path.read_text("utf-8"))
    w, h = scene.camera.width, scene.camera.height
    worst = 0.0
    for g in scene.gcps:
        predicted = {q["photo"]: q for q in next(p for p in gcp["points"] if p["id"] == g.id)["predicted"]}
        for i, name in enumerate(scene.names):
            uv, z = project_points(scene.camera, scene.rotations[i], scene.centres[i], g.enu[None])
            x, y = uv[0]
            if not (z[0] > 0 and 60 <= x < w - 60 and 60 <= y < h - 60):
                continue
            # every photo that sees the target is offered, with its ring over the target
            assert name in predicted, (g.id, name)
            off = float(np.hypot(predicted[name]["px"][0] - x, predicted[name]["px"][1] - y))
            assert off < predicted[name]["radiusPx"], (g.id, name, off)
            worst = max(worst, off)
    # without marks what is left is the flight's GNSS error (the block sits metres beside the
    # survey and tilted), not the 21.7 m in height; two marked points take that out as well
    assert worst < limit_px, worst


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


def test_feature_extraction_stays_within_a_few_gigabytes(monkeypatch):
    monkeypatch.setattr(os, "cpu_count", lambda: 24)
    info = {"groups": [{"width": 5472, "height": 3648}], "maxImageSize": 2736}

    def peak_gb(threads, size):  # the measured model (20 MP flight, COLMAP 4.2 CPU SIFT)
        octave = 4 if first_octave(size) < 0 else 1
        return FEATURE_BASE_GB + threads * FEATURE_GB_PER_THREAD_AT_2736 * (size / 2736) ** 2 * octave

    for size in (1368, 2736, 5472):
        for total in (8, 16, 64):
            limit = memory_limit(total * 10**9, total * 10**9)
            t = feature_threads({**info, "maxImageSize": size}, limit)
            assert 1 <= t <= MAX_FEATURE_THREADS
            assert peak_gb(t, size) <= max(FEATURE_BUDGET_GB, peak_gb(1, size)) + 1e-9
            assert peak_gb(t, size) <= 0.5 * limit / 1e9 or t == 1
    # a busy machine with 3 GB free gets fewer threads than an idle one
    assert feature_threads(info, memory_limit(64 * 10**9, 3 * 10**9)) < feature_threads(info, 0)
    # SIFT upsampling (first octave -1) only for small images: it quadruples the memory
    assert first_octave(2736) == 0 and first_octave(1024) == -1


def test_the_memory_limit_is_at_most_three_quarters_and_respects_free_memory():
    gb = 10**9
    assert memory_limit(64 * gb, 60 * gb) == 48 * gb
    assert memory_limit(64 * gb, 10 * gb) == 9 * gb
    assert memory_limit(0, 0) == 0
    total, avail = memory_status()
    assert total > 0 and 0 < avail <= total


def test_the_memory_guard_stops_a_stage_before_it_takes_the_computer(tmp_path):
    eng = ColmapEngine(python=sys.executable)
    limit = 400 * 2**20
    job = EngineJob(work=tmp_path / "w", image_root=tmp_path, images=[], groups=[], memory_limit_bytes=limit)
    t0 = time.monotonic()
    with pytest.raises(MemoryExceeded, match=r"needed more than 0.4 GB"):
        eng._run(
            job, "probe-alloc", {"steps": 30, "stepBytes": 50 * 2**20}, lambda f, m=None: None, "features"
        )
    assert time.monotonic() - t0 < 30
    assert limit < job.memory_peak["features"] < limit + 300 * 2**20


# Windows never updates a parent PID. When a parent ends and its PID is given to a new process,
# the old children still name that PID, so the new process seems to have children it never
# started. The fabricated trees below are (PID, parent PID) with the time each process started.


def _started(times):
    return lambda pid: times.get(pid)


def test_a_reused_pid_does_not_adopt_the_children_of_the_process_that_had_it():
    # 400 is the engine, with its own child and grandchild. 80 was started long ago by a process
    # that has ended; the engine was given that PID. 84 is 80's child, younger than the engine.
    links = [(4, 0), (80, 400), (84, 80), (300, 4), (400, 300), (404, 400), (408, 404)]
    times = {4: 1.0, 80: 50.0, 84: 2000.0, 300: 900.0, 400: 1000.0, 404: 1000.2, 408: 1003.0}
    assert descendants(400, links, _started(times)) == [400, 404, 408]


def test_a_reused_pid_below_the_root_adopts_nobody_either():
    # the engine's child 404 has the PID of an ended process whose child 90 lives on
    links = [(400, 300), (404, 400), (408, 404), (90, 404), (94, 90)]
    times = {400: 1000.0, 404: 1000.2, 408: 1003.0, 90: 500.0, 94: 1100.0}
    assert descendants(400, links, _started(times)) == [400, 404, 408]


def test_a_loop_of_parent_pids_ends():
    # 400's own parent PID, 500, now belongs to its child; 600 names itself, as the idle process does
    links = [(400, 500), (500, 400), (504, 500), (600, 600)]
    times = {400: 1000.0, 500: 1001.0, 504: 1002.0, 600: 1.0}
    assert descendants(400, links, _started(times)) == [400, 500, 504]
    assert descendants(600, links, _started(times)) == [600]
    # without start times too (other systems re-parent, so every link there is a live one)
    assert descendants(400, links) == [400, 500, 504]
    assert descendants(1, [(1, 3), (2, 1), (3, 2), (2, 1)]) == [1, 2, 3]


def test_a_child_may_start_on_the_same_clock_tick_as_its_parent():
    links = [(404, 400), (408, 400), (412, 400)]
    times = {
        400: 1000.0,
        404: 1000.0,
        408: 1000.0 - START_TOLERANCE_S / 2,
        412: 1000.0 - START_TOLERANCE_S * 2,
    }
    assert descendants(400, links, _started(times)) == [400, 404, 408]


def test_a_process_that_ends_during_the_walk_is_left_out_and_the_rest_is_counted():
    links = [(404, 400), (408, 404), (412, 400), (416, 412)]
    times = {400: 1000.0, 404: None, 408: 1002.0, 412: 1001.0, 416: 1003.0}  # 404 is gone
    assert descendants(400, links, _started(times)) == [400, 412, 416]
    assert descendants(400, links, _started({})) == [400]  # the root itself is gone


def test_the_processes_to_end_leave_out_an_older_process_that_names_the_pid():
    # 400 has a child and a grandchild; 80 is older and names 400 (a reused PID), 84 is below 80
    links = [(80, 400), (84, 80), (400, 300), (404, 400), (408, 404)]
    times = {80: 50.0, 84: 2000.0, 400: 1000.0, 404: 1000.2, 408: 1003.0}
    assert kill_list(400, links, _started(times)) == [(404, 1000.2), (408, 1003.0)]
    assert kill_list(400, links, _started({**times, 400: None})) == []  # the root cannot be read


def test_a_process_started_while_its_parent_was_being_ended_is_found_by_the_next_walk():
    # 400 and 404 were ended. 412 names 404 and started before 404 ended: its child, with 420
    # below it. 416 names 404 too but started after that: a child of the process that has PID
    # 404 now (started by 77), and that process is not listed either.
    ended = {400: (1000.0, 1009.0), 404: (1000.2, 1010.0)}
    links = [(404, 77), (412, 404), (416, 404), (420, 412)]
    times = {404: 1015.0, 412: 1005.0, 416: 1020.0, 420: 1006.0}
    assert kill_list(400, links, _started(times), ended) == [(412, 1005.0), (420, 1006.0)]


WINDOWS_ONLY = pytest.mark.skipif(
    os.name != "nt", reason="only Windows keeps the parent PID of an ended process"
)


def _sleeper(code="import time; time.sleep(60)", **kw):
    return subprocess.Popen(
        [sys.executable, "-c", code],
        stdin=subprocess.DEVNULL,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        **kw,
    )


def _child_with_grandchild():
    """A process of this test with a child of its own; gives the Popen and the grandchild's PID."""
    code = (
        "import subprocess, sys, time\n"
        "p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
        "print(p.pid, flush=True)\n"
        "time.sleep(60)\n"
    )
    child = _sleeper(code, stdout=subprocess.PIPE, text=True)
    return child, int(child.stdout.readline())


def _running(listed):
    """Which of these (PID, start) are still the running processes they were."""
    now = {p for p, _ in colmap_io.process_links()}
    return [p for p, t in listed if p in now and process_started(p) == t]


def _gone(listed, seconds=5.0):
    t0 = time.monotonic()
    while _running(listed) and time.monotonic() - t0 < seconds:
        time.sleep(0.1)
    return not _running(listed)


@WINDOWS_ONLY
def test_the_tree_of_a_real_process_has_its_descendants_and_no_older_process(reused_pid):
    """A reused PID with real processes: the stranger, older than the child this test starts,
    names the child's PID as its parent. The child's own child must still be counted."""
    child, grandchild = _child_with_grandchild()
    try:
        assert process_started(reused_pid.pid) < process_started(child.pid) <= process_started(grandchild)
        assert process_started(0x7FFFFFFC) is None  # no such process
        assert (reused_pid.pid, child.pid) in colmap_io.process_links()
        tree = process_tree(child.pid)
        assert tree[0] == child.pid and grandchild in tree
        assert reused_pid.pid not in tree
        assert process_memory(grandchild) > 0 and colmap_io.process_memory(reused_pid.pid) == 10**12
        assert tree_memory(child.pid) < 10**12
    finally:
        kill(child)
        child.stdout.close()


@WINDOWS_ONLY
def test_kill_ends_the_child_and_everything_below_it():
    child, grandchild = _child_with_grandchild()
    try:
        tree = [(p, process_started(p)) for p in process_tree(child.pid)]
        assert grandchild in [p for p, _ in tree] and _running(tree) == [p for p, _ in tree]
        kill(child)
        assert child.poll() is not None
        assert _gone(tree[1:])
    finally:
        kill(child)
        child.stdout.close()


@WINDOWS_ONLY
def test_kill_leaves_an_older_process_that_names_the_childs_pid_alone(reused_pid):
    """Only processes this test or its fixture started are ever in reach of the kill."""
    child, grandchild = _child_with_grandchild()
    try:
        assert (reused_pid.pid, child.pid) in colmap_io.process_links()
        others = [(p, process_started(p)) for p in process_tree(reused_pid.pid)]
        tree = [(p, process_started(p)) for p in process_tree(child.pid)]
        assert grandchild in [p for p, _ in tree] and not {p for p, _ in others} & {p for p, _ in tree}
        kill(child)
        assert child.poll() is not None and _gone(tree[1:])
        assert reused_pid.poll() is None
        assert _running(others) == [p for p, _ in others]
    finally:
        kill(child)
        child.stdout.close()


@WINDOWS_ONLY
def test_a_pid_given_to_another_process_since_the_walk_is_not_ended():
    # the real interpreter, not the environment's launcher: one process, nothing below it
    child = subprocess.Popen(
        [getattr(sys, "_base_executable", sys.executable), "-c", "import time; time.sleep(60)"],
        stdin=subprocess.DEVNULL,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    try:
        t = process_started(child.pid)
        # listed with another start: the PID was given out again, and its new owner is left alone
        assert end_process(child.pid, t - 30.0) == "gone"
        time.sleep(0.3)
        assert child.poll() is None
        assert end_process(child.pid, t) == "ended"
        assert child.wait(timeout=5) is not None
        assert end_process(0x7FFFFFFC, t) == "gone"  # no such process
    finally:
        child.kill()
        child.wait()


@WINDOWS_ONLY
def test_the_memory_guard_does_not_count_an_older_process_that_names_the_engines_pid(tmp_path, reused_pid):
    eng = ColmapEngine(python=sys.executable)
    job = EngineJob(
        work=tmp_path / "w", image_root=tmp_path, images=[], groups=[], memory_limit_bytes=400 * 2**20
    )
    res = eng._run(job, "probe-sleep", {"seconds": 2}, lambda f, m=None: None, "features")
    assert res == {"slept": True}


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
        with pytest.raises(JobError, match="needs COLMAP"):
            ColmapEngine(python=sys.executable).versions()
        return
    pytest.skip("pycolmap is importable in this environment")
