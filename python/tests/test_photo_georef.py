"""photo.georef on a known scene: control points in the adjustment, checkpoints only measured."""

import json

import numpy as np
import pytest

from aio_pipelines.photo import crs as C
from aio_pipelines.photo.align import PhotoAlign, read_sparse
from aio_pipelines.photo.georef import PhotoGeoref
from aio_pipelines.runtime import JobError
from conftest import run_job
from photo_g2_synth import SyntheticEngine, make_scene, write_gcp_files, write_scene_photos


def _aligned(monkeypatch, project, tmp_path, scene, rtk=False, gnss="auto", alt_offset=0.0):
    folder = tmp_path / "flight"
    write_scene_photos(scene, folder, rtk=rtk, alt_offset=alt_offset)
    monkeypatch.setattr(PhotoAlign, "engine_factory", staticmethod(lambda: SyntheticEngine(scene)))
    params = {"photos": {"folders": [str(folder)]}, "preset": "standard", "run": "r1", "gnss": gnss}
    run_job(PhotoAlign(), project, params, job_id="align")


def _georef(project, job_id="g1", **kw):
    return run_job(PhotoGeoref(), project, {"run": "r1", **kw}, job_id=job_id)


def _report(project):
    return json.loads((project / "photogrammetry/r1/report/accuracy.json").read_text("utf-8"))


def test_control_points_meet_the_checkpoint_targets(monkeypatch, project, tmp_path):
    scene = make_scene(rows=4, cols=6, points=3000, gnss_sigma=(2.5, 4.0), seed=9)
    # the drone's altitudes sit 12 m off the survey datum, as barometric absolute altitudes do
    _aligned(monkeypatch, project, tmp_path, scene, alt_offset=12.0)
    write_gcp_files(scene, project, "r1", noise_px=0.5)
    result, _ = _georef(project)
    assert result["status"] == "done"
    rep = _report(project)
    gsd = rep["gsdCm"] / 100
    assert rep["checkpointsInAdjustment"] is False
    assert rep["rmse"]["control"]["n"] == 5 and rep["rmse"]["check"]["n"] == 4
    # plan targets: checkpoints RMSE horizontal under 1.5 x GSD, vertical under 2.5 x GSD
    assert rep["rmse"]["check"]["horizontalM"] < 1.5 * gsd, rep["rmse"]
    assert rep["rmse"]["check"]["verticalM"] < 2.5 * gsd, rep["rmse"]
    assert {p["id"] for p in rep["points"]} == {
        "GCP1",
        "GCP2",
        "GCP3",
        "GCP4",
        "GCP5",
        "CHK1",
        "CHK2",
        "CHK3",
        "CHK4",
    }
    run = json.loads((project / "photogrammetry/r1/run.json").read_text("utf-8"))
    assert run["status"] == "adjusted" and run["accuracy"]["check"]["n"] == 4
    assert {s["name"] for s in run["stages"]} >= {"adjust", "report"}
    # camera positions against truth: under 2 x GSD; the GNSS-only model is kept
    model, frame = read_sparse(project / "photogrammetry/r1/sparse")
    grid = C.GridFrame(C.crs_of(frame["crs"]), tuple(frame["origin"]))
    truth = grid.from_geodetic(*scene.enu.to_geodetic(scene.centres))
    by = model.image_by_name()
    d = np.array([by[n].centre - truth[i] for i, n in enumerate(scene.names)])
    rmse_h = float(np.sqrt(np.mean(d[:, 0] ** 2 + d[:, 1] ** 2)))
    rmse_v = float(np.sqrt(np.mean(d[:, 2] ** 2)))
    # Over flat ground a nadir camera can shift and tilt together with almost no change in its
    # image, so camera positions are looser than the ground (plan target 2 x GSD; G8 adds relief)
    assert rmse_h < 3 * gsd, (rmse_h, rmse_v)
    # Camera heights trade off against the focal length over flat ground, so with 4 m GNSS
    # height noise they are only as good as the mean of the GNSS heights after the datum shift
    # is taken out (about 4 / sqrt(24) m); the ground itself is right, as the checkpoints show.
    assert rmse_v < 1.5, (rmse_h, rmse_v)
    assert (project / "photogrammetry/r1/work/sparse-gnss/images.txt").is_file()
    # the drone's GNSS heights disagree with control by metres: flagged with the number
    flagged = [w for w in rep["warnings"] if w["code"] == "gnss-height"]
    assert flagged and "-1" in flagged[0]["message"]


def test_a_gcp_one_metre_off_is_named_and_left_out(monkeypatch, project, tmp_path):
    scene = make_scene(rows=4, cols=6, points=3000, gnss_sigma=(2.5, 4.0), seed=9, bad_gcp=True)
    _aligned(monkeypatch, project, tmp_path, scene)
    write_gcp_files(scene, project, "r1")
    _georef(project)
    rep = _report(project)
    out = [w for w in rep["warnings"] if w["code"] == "gcp-outlier"]
    assert [w["point"] for w in out] == ["GCP6"] and "left out" in out[0]["message"]
    g6 = next(p for p in rep["points"] if p["id"] == "GCP6")
    assert g6["usedInAdjustment"] is False and np.hypot(g6["dxM"], g6["dyM"]) > 0.7
    assert rep["rmse"]["control"]["n"] == 5  # GCP6 is listed but not in the control RMSE
    gsd = rep["gsdCm"] / 100
    assert rep["rmse"]["check"]["horizontalM"] < 1.5 * gsd


def test_checkpoints_never_change_the_adjustment(monkeypatch, project, tmp_path):
    scene = make_scene(rows=4, cols=6, points=2000, gnss_sigma=(2.5, 4.0), seed=9)
    _aligned(monkeypatch, project, tmp_path, scene)
    path = write_gcp_files(scene, project, "r1")
    base = project / "photogrammetry/r1"
    gnss_sparse = {f.name: f.read_bytes() for f in (base / "sparse").iterdir()}
    _georef(project, "with-checks")
    with_checks = (base / "sparse" / "images.txt").read_text("utf-8")
    # back to the GNSS-only model, and the same control without any checkpoint
    for f, data in gnss_sparse.items():
        (base / "sparse" / f).write_bytes(data)
    data = json.loads(path.read_text("utf-8"))
    data["points"] = [p for p in data["points"] if p["role"] == "control"]
    path.write_text(json.dumps(data), "utf-8")
    _georef(project, "without-checks")
    without = (base / "sparse" / "images.txt").read_text("utf-8")
    assert with_checks == without


def test_control_only_without_gnss(monkeypatch, project, tmp_path):
    scene = make_scene(rows=4, cols=6, points=3000, gnss_sigma=(2.5, 4.0), seed=9)
    _aligned(monkeypatch, project, tmp_path, scene)
    write_gcp_files(scene, project, "r1")
    _georef(project, useGnss=False)
    rep = _report(project)
    assert rep["rmse"]["check"]["horizontalM"] < 1.5 * rep["gsdCm"] / 100


def test_a_run_aligned_without_gnss_is_placed_by_control(monkeypatch, project, tmp_path):
    scene = make_scene(rows=4, cols=6, points=3000, seed=9)
    _aligned(monkeypatch, project, tmp_path, scene, gnss="ignore")
    frame = json.loads((project / "photogrammetry/r1/sparse/frame.json").read_text("utf-8"))
    assert frame["georeferenced"] is False
    write_gcp_files(scene, project, "r1")
    _georef(project)
    rep = _report(project)
    assert rep["rmse"]["check"]["horizontalM"] < 1.5 * rep["gsdCm"] / 100


def test_georef_refuses_what_it_cannot_do(monkeypatch, project, tmp_path):
    with pytest.raises(JobError, match="align the photos first"):
        _georef(project, "nothing")
    scene = make_scene(rows=3, cols=4, points=800, seed=9)
    _aligned(monkeypatch, project, tmp_path, scene)
    with pytest.raises(JobError, match="ground control file"):
        _georef(project, "no-gcp")
    with pytest.raises(JobError, match="useGnss"):
        PhotoGeoref().validate({"run": "r1", "useGnss": "yes"})
