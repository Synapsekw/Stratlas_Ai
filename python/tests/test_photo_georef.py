"""photo.georef on the fake ODM: the GCP list, ODM's adjustment, our check-point measurement."""

import json
import shutil
import sys
from pathlib import Path

import numpy as np
import pytest

import odm_synth
import products_synth as ps
from aio_pipelines.photo.georef import PhotoGeoref
from aio_pipelines.photo.model import SparseModel
from aio_pipelines.photo.odm import project as OP
from aio_pipelines.photo.odm import runner as R
from aio_pipelines.runtime import JobError
from conftest import run_job

FAKE = Path(__file__).parent / "fake_odm"
BIAS = (0.3, -0.2, 1.5)
TARGETS = {"G1": "control", "G2": "control", "G3": "control", "G4": "control", "C1": "check", "C2": "check"}


@pytest.fixture
def run(tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_ODM_PYTHON", sys.executable)
    monkeypatch.setenv(R.ODM_ENV, str(FAKE))
    monkeypatch.setenv("FAKE_ODM_UDP_PORT", "0")
    monkeypatch.setenv("FAKE_ODM_ARGS_LOG", str(tmp_path / "args.jsonl"))
    root = tmp_path / "p"
    ps.write_project(root, ps.make_scene(step=0.15), odm_bias=BIAS)
    base = root / "photogrammetry" / ps.RUN
    truth = odm_synth.truth_model(base / "odm")  # the unbiased model in the run's ENU frame
    pts = dict(zip(TARGETS, ps.TARGET_POSITIONS, strict=True))  # six surveyed positions in EPSG:32639
    gcp = odm_synth.gcp_doc(truth.model, truth.enu, ps.EPSG, pts, TARGETS)
    (base / "gcp.json").write_text(json.dumps(gcp))
    return root, base


def _accuracy(base: Path) -> dict:
    return json.loads((base / "report" / "accuracy.json").read_text())


def test_check_points_are_measured_through_odms_adjusted_cameras(run):
    root, base = run
    result, _ = run_job(PhotoGeoref(), root, {"run": ps.RUN})
    assert result["status"] == "done"
    acc = _accuracy(base)
    assert acc["checkpointsInAdjustment"] is False
    assert acc["rmse"]["check"]["horizontalM"] < 0.01 and acc["rmse"]["check"]["verticalM"] < 0.02
    assert json.loads((base / "run.json").read_text())["status"] == "adjusted"
    assert (base / "work" / "sparse-gnss").is_dir()


def test_the_gcp_list_holds_control_points_only(run):
    root, base = run
    run_job(PhotoGeoref(), root, {"run": ps.RUN})
    text = (base / "odm" / "gcp_list.txt").read_text()
    assert all(f" G{i}" in text for i in range(1, 5)) and " C1" not in text and " C2" not in text


def test_check_points_never_change_the_adjustment(run, tmp_path):
    root, base = run
    run_job(PhotoGeoref(), root, {"run": ps.RUN}, job_id="with")
    with_checks = SparseModel.load(base / "work" / "adjusted-enu.npz")
    gcp = json.loads((base / "gcp.json").read_text())
    gcp["points"] = [p for p in gcp["points"] if p["role"] == "control"]
    (base / "gcp.json").write_text(json.dumps(gcp))
    run_job(PhotoGeoref(), root, {"run": ps.RUN}, job_id="without")
    without = SparseModel.load(base / "work" / "adjusted-enu.npz")  # compared by value: npz files carry times
    for iid, im in with_checks.images.items():
        assert np.array_equal(im.R, without.images[iid].R) and np.array_equal(im.t, without.images[iid].t)
    assert np.array_equal(with_checks.xyz, without.xyz)


def test_a_control_point_far_off_the_others_is_left_out_and_named(run):
    root, base = run
    gcp = json.loads((base / "gcp.json").read_text())
    gcp["points"][0]["xyz"][0] += 1.0
    (base / "gcp.json").write_text(json.dumps(gcp))
    run_job(PhotoGeoref(), root, {"run": ps.RUN})
    assert " G1" not in (base / "odm" / "gcp_list.txt").read_text()
    assert any(w["code"] == "gcp-outlier" and w.get("point") == "G1" for w in _accuracy(base)["warnings"])


def _config(base: Path) -> dict[str, str]:
    """ODM's OpenSfM settings (``opensfm/config.yaml``, one ``key: value`` per line)."""
    lines = (base / "odm" / "opensfm" / "config.yaml").read_text().splitlines()
    return dict(ln.split(": ", 1) for ln in lines if ": " in ln)


def _args(tmp_path: Path) -> list[str]:
    return json.loads((tmp_path / "args.jsonl").read_text().splitlines()[-1])


def test_with_gnss_odm_weighs_the_photo_positions_too(run, tmp_path):
    root, base = run
    run_job(PhotoGeoref(), root, {"run": ps.RUN})
    assert "--force-gps" in _args(tmp_path)  # with --gcp, ODM ignores GPS unless forced
    assert _config(base)["bundle_use_gps"] == "yes"


def test_without_gnss_only_the_control_points_count_and_aligns_geo_txt_is_kept(run, tmp_path):
    root, base = run
    geo = base / "odm" / "geo.txt"
    geo.write_text("EPSG:4326\n00000.jpg 51.0 29.0 50.000 nan nan nan 0.020 0.030\n")  # as align wrote it
    before = geo.read_bytes()
    run_job(PhotoGeoref(), root, {"run": ps.RUN, "useGnss": False})
    args = _args(tmp_path)
    assert "--force-gps" not in args and args[args.index("--geo") + 1] == str(geo)
    assert geo.read_bytes() == before
    assert _config(base)["bundle_use_gps"] == "no"


def test_odm_runs_alignment_again_with_the_gcp_file(run, tmp_path):
    root, base = run
    run_job(PhotoGeoref(), root, {"run": ps.RUN})
    args = _args(tmp_path)
    assert args[args.index("--gcp") + 1].endswith("gcp_list.txt")
    assert args[args.index("--end-with") + 1] == "opensfm"
    # ODM's setup ran again (image_list.txt was invalidated): it took the GCP file and used it
    sfm = base / "odm" / "opensfm"
    assert (sfm / "gcp_list.txt").read_text() == (base / "odm" / "gcp_list.txt").read_text()
    assert _config(base)["bundle_use_gcp"] == "yes"


def test_odms_new_reference_is_absorbed(run):
    root, base = run
    frame = json.loads((base / "sparse" / "frame.json").read_text())["enu"]
    run_job(PhotoGeoref(), root, {"run": ps.RUN})
    ref = json.loads((base / "odm" / "opensfm" / "reference_lla.json").read_text())
    assert abs(ref["altitude"] - frame["h"]) > 0.5  # ODM centred its frame elsewhere
    acc = _accuracy(base)
    assert acc["rmse"]["check"]["horizontalM"] < 0.01 and acc["rmse"]["check"]["verticalM"] < 0.02


def test_odms_gcp_errors_of_this_run_are_saved(run):
    root, base = run
    (base / "report").mkdir(exist_ok=True)
    (base / "report" / "odm-stats.json").write_text(json.dumps({"gcp_errors": {"OLD": 9.0}}))
    run_job(PhotoGeoref(), root, {"run": ps.RUN})
    saved = json.loads((base / "report" / "odm-stats.json").read_text())
    assert set(saved["gcp_errors"]["points"]) == {"G1", "G2", "G3", "G4"}


def test_without_gcp_errors_from_odm_no_older_copy_is_kept(run, monkeypatch):
    root, base = run
    (base / "report").mkdir(exist_ok=True)
    (base / "report" / "odm-stats.json").write_text(json.dumps({"gcp_errors": {"OLD": 9.0}}))
    monkeypatch.setenv("FAKE_ODM_NO_GCP_ERRORS", "1")
    _, rec = run_job(PhotoGeoref(), root, {"run": ps.RUN})
    assert not (base / "report" / "odm-stats.json").exists()
    assert any("no ground control errors" in m["message"] for m in rec.of("log"))


def _resume(base: Path, earlier: str, job: str) -> None:
    """An attempt of ``job`` that already ran ODM (its log folder holds the earlier attempt's)."""
    logs = base / "odm-logs"
    shutil.copytree(logs / f"{earlier}-adjust", logs / f"{job}-adjust")


def test_a_resumed_attempt_keeps_odms_alignment(run):
    root, base = run
    run_job(PhotoGeoref(), root, {"run": ps.RUN}, job_id="a")
    _resume(base, "a", "b")
    rec = base / "odm" / "opensfm" / "reconstruction.json"
    stamp = rec.stat().st_mtime_ns
    run_job(PhotoGeoref(), root, {"run": ps.RUN}, job_id="b")
    assert rec.stat().st_mtime_ns == stamp  # nothing invalidated: ODM had nothing to run again


def test_a_resumed_attempt_with_changed_control_aligns_again(run):
    root, base = run
    run_job(PhotoGeoref(), root, {"run": ps.RUN}, job_id="a")
    _resume(base, "a", "b")
    gcp = json.loads((base / "gcp.json").read_text())
    gcp["points"] = [p for p in gcp["points"] if p["id"] != "G4"]
    (base / "gcp.json").write_text(json.dumps(gcp))
    run_job(PhotoGeoref(), root, {"run": ps.RUN}, job_id="b")
    used = (base / "odm" / "opensfm" / "gcp_list.txt").read_text()
    assert " G1" in used and " G4" not in used


def test_disabled_points_and_draft_marks_stay_out_of_the_gcp_list(run):
    root, base = run
    gcp = json.loads((base / "gcp.json").read_text())
    by = {p["id"]: p for p in gcp["points"]}
    by["G2"]["disabled"] = True
    draft = by["G3"]["marks"][0]
    draft["state"] = "draft"
    (base / "gcp.json").write_text(json.dumps(gcp))
    run_job(PhotoGeoref(), root, {"run": ps.RUN})
    lines = (base / "odm" / "gcp_list.txt").read_text().splitlines()[1:]
    assert not [ln for ln in lines if ln.endswith(" G2")]
    g3 = [ln.split()[3:5] for ln in lines if ln.endswith(" G3")]
    assert len(g3) == len(by["G3"]["marks"]) - 1
    assert [f"{draft['px'][0] - 0.5:.2f}", f"{draft['px'][1] - 0.5:.2f}"] not in g3


def test_an_odm_failure_is_a_plain_message(run, monkeypatch):
    root, _ = run
    monkeypatch.setenv("FAKE_ODM_FAIL", "opensfm:1")
    with pytest.raises(JobError, match="ODM could not process these photos"):
        run_job(PhotoGeoref(), root, {"run": ps.RUN})


def test_same_file_names_in_two_folders_reach_odm_as_their_own_links(tmp_path):
    point = {
        "id": "G1",
        "role": "control",
        "xyz": [412000.0, 3245000.0, 20.0],
        "accuracy": {"horizontalM": 0.01, "verticalM": 0.02},
        "marks": [
            {"photo": "a/IMG_0001.JPG", "px": [10.0, 20.0], "state": "confirmed"},
            {"photo": "b/IMG_0001.JPG", "px": [30.0, 40.0], "state": "confirmed"},
        ],
    }
    points = [{**point, "id": f"G{i}"} for i in range(1, 4)]
    links = {"a/IMG_0001.JPG": "00000.jpg", "b/IMG_0001.JPG": "00001.jpg"}
    OP.write_gcp_list(tmp_path, {"crs": {"epsg": ps.EPSG}, "points": points}, links, set())
    rows = [ln.split() for ln in (tmp_path / "gcp_list.txt").read_text().splitlines()[1:]]
    assert {(r[5], r[3]) for r in rows if r[6] == "G1"} == {("00000.jpg", "9.50"), ("00001.jpg", "29.50")}


def test_too_few_control_points_fail_plainly(run):
    root, base = run
    gcp = json.loads((base / "gcp.json").read_text())
    gcp["points"] = [p for p in gcp["points"] if p["id"] in ("G1", "G2", "C1")]
    (base / "gcp.json").write_text(json.dumps(gcp))
    with pytest.raises(JobError, match="At least three usable control points"):
        run_job(PhotoGeoref(), root, {"run": ps.RUN})
