"""photo.georef on the fake ODM: the GCP list, ODM's adjustment, our check-point measurement."""

import json
import sys
from pathlib import Path

import numpy as np
import pytest

import odm_synth
import products_synth as ps
from aio_pipelines.photo.georef import PhotoGeoref
from aio_pipelines.photo.model import SparseModel
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


def test_without_gnss_the_photo_positions_barely_count(run):
    root, base = run
    run_job(PhotoGeoref(), root, {"run": ps.RUN, "useGnss": False})
    rows = (base / "odm" / "geo.txt").read_text().splitlines()[1:]
    assert rows and all(r.split()[-2:] == ["100.000", "100.000"] for r in rows)


def test_odm_runs_alignment_again_with_the_gcp_file(run, tmp_path):
    root, base = run
    run_job(PhotoGeoref(), root, {"run": ps.RUN})
    args = json.loads((tmp_path / "args.jsonl").read_text().splitlines()[-1])
    assert args[args.index("--gcp") + 1].endswith("gcp_list.txt")
    assert args[args.index("--end-with") + 1] == "opensfm"


def _old_odm_stats(base: Path) -> None:
    """ODM's report statistics from an earlier products run, and our copy of them."""
    old = {"gcp_errors": [{"id": "G1", "error": [9.0, 9.0, 9.0]}]}
    (base / "odm" / "odm_report").mkdir(parents=True, exist_ok=True)
    (base / "odm" / "odm_report" / "stats.json").write_text(json.dumps(old))
    (base / "report").mkdir(exist_ok=True)
    (base / "report" / "odm-stats.json").write_text(json.dumps(old))


def test_odm_stats_from_an_earlier_products_run_are_not_kept(run):
    root, base = run
    _old_odm_stats(base)
    _, rec = run_job(PhotoGeoref(), root, {"run": ps.RUN})
    assert not (base / "report" / "odm-stats.json").exists()
    assert any("not available until" in m["message"] for m in rec.of("log"))


def test_odm_stats_written_by_this_run_are_kept(run, monkeypatch):
    root, base = run
    _old_odm_stats(base)
    real = R.run_odm

    def run_with_report(ctx, odm, project_dir, *a, **kw):  # as ODM would with its report stage
        res = real(ctx, odm, project_dir, *a, **kw)
        (project_dir / "odm_report" / "stats.json").write_text(json.dumps({"gcp_errors": []}))
        return res

    monkeypatch.setattr(R, "run_odm", run_with_report)
    run_job(PhotoGeoref(), root, {"run": ps.RUN})
    assert json.loads((base / "report" / "odm-stats.json").read_text()) == {"gcp_errors": []}


def test_too_few_control_points_fail_plainly(run):
    root, base = run
    gcp = json.loads((base / "gcp.json").read_text())
    gcp["points"] = [p for p in gcp["points"] if p["id"] in ("G1", "G2", "C1")]
    (base / "gcp.json").write_text(json.dumps(gcp))
    with pytest.raises(JobError, match="At least three usable control points"):
        run_job(PhotoGeoref(), root, {"run": ps.RUN})
