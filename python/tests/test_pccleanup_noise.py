"""pointcloud.clean, noise mode: PDAL's statistical outlier filter (and optionally filters.elm) marks
noise as class 7 in a working copy; every other class stays; the original file is untouched."""

import hashlib
import json

import numpy as np
import pytest

from aio_pipelines.pipelines import all_pipelines
from aio_pipelines.pointcloud import find_pdal
from aio_pipelines.pointcloud_cleanup import pipeline as pcc_pipeline
from aio_pipelines.pointcloud_cleanup.lasstream import class_histogram
from aio_pipelines.pointcloud_cleanup.pipeline import PointcloudClean
from aio_pipelines.runtime import Cancelled, JobError
from conftest import run_job
from pccleanup_synth import cloud_project, copc_to_las, planted_cloud

needs_pdal = pytest.mark.skipif(find_pdal() is None, reason="PDAL not found (set AIO_PDAL)")
SRC = "clouds/cloud-a.copc.laz"
NOISE = {"mode": "noise", "layerId": "cloud-a", "src": SRC, "outlier": {"meanK": 8, "multiplier": 2.0}}


def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def test_is_registered():
    assert isinstance(all_pipelines()["pointcloud.clean"], PointcloudClean)


@pytest.mark.parametrize(
    "params, message",
    [
        ({**NOISE, "mode": "paint"}, "noise or save"),
        ({**NOISE, "extra": 1}, "does not take: extra"),
        ({**NOISE, "outlier": {"meanK": 1, "multiplier": 2}}, "meanK"),
        ({**NOISE, "outlier": {"meanK": 8, "multiplier": 20}}, "multiplier"),
        ({**NOISE, "src": "../x.copc.laz"}, "inside the project"),
        ({**NOISE, "elm": {"cell": 0, "threshold": 1}}, "cell"),
    ],
)
def test_validate_refuses(params, message):
    with pytest.raises(JobError, match=message):
        PointcloudClean().validate(params)


@needs_pdal
def test_marks_the_planted_outliers_and_keeps_every_other_class(tmp_path):
    xyz, cls, outlier = planted_cloud()
    root = cloud_project(tmp_path, xyz, cls)
    before = sha(root / SRC)
    result, _ = run_job(PointcloudClean(), root, NOISE, job_id="j-noise")
    record = result["outputs"]["commit"]
    assert record["path"] == "edits/pointcloud/cloud-a.noise-j-noise.copc.laz"
    assert record["runId"] == "j-noise" and record["total"] == len(xyz)
    assert json.loads((root / "edits/pointcloud/cloud-a.noise-j-noise.json").read_text("utf-8")) == record
    assert sha(root / SRC) == before  # the original is never changed
    las = copc_to_las(root / record["path"], tmp_path / "copy.las")
    hist = class_histogram(las)
    # every planted outlier (isolated, 25 m up or 6 m under) is marked; some ground edge points may be
    assert record["marked"] == int(hist[7])
    assert int(outlier.sum()) <= record["marked"] <= int(outlier.sum()) + 0.02 * len(xyz)
    from aio_pipelines.change.las import read_las

    out = read_las(las)
    z, c = out.xyz[:, 2], out.field("Classification")
    assert np.all(c[(z > 20) | (z < -3)] == 7)
    # other classes only lose points to class 7
    orig = np.bincount(cls, minlength=256)
    for k in (1, 2, 6):
        assert hist[k] <= orig[k]
    assert hist.sum() == len(xyz)


@needs_pdal
def test_low_points_with_elm(tmp_path):
    xyz, cls, _ = planted_cloud(high=0, low=20)
    root = cloud_project(tmp_path, xyz, cls)
    params = {**NOISE, "elm": {"cell": 10, "threshold": 1.0}}
    result, _ = run_job(PointcloudClean(), root, params, job_id="j-elm")
    record = result["outputs"]["commit"]
    assert record["params"] == {
        "outlier": {"meanK": 8, "multiplier": 2.0},
        "elm": {"cell": 10.0, "threshold": 1.0},
    }
    from aio_pipelines.change.las import read_las

    out = read_las(copc_to_las(root / record["path"], tmp_path / "copy.las"))
    assert np.all(out.field("Classification")[out.xyz[:, 2] < -3] == 7)


@needs_pdal
def test_a_cloud_whose_noise_is_already_class_7_gives_marked_0_and_keeps_every_other_class(tmp_path):
    xyz, cls, outlier = planted_cloud()
    cls = cls.copy()
    cls[outlier] = 7  # an earlier run marked them
    root = cloud_project(tmp_path, xyz, cls)
    # a large multiplier: only the planted (already class 7) points are outliers
    params = {**NOISE, "outlier": {"meanK": 8, "multiplier": 8.0}}
    result, _ = run_job(PointcloudClean(), root, params, job_id="j-again")
    record = result["outputs"]["commit"]
    assert record["marked"] == 0
    hist = class_histogram(copc_to_las(root / record["path"], tmp_path / "copy.las"))
    assert hist.tolist() == np.bincount(cls, minlength=256).tolist()


@needs_pdal
def test_refuses_a_layer_that_is_not_copc_or_has_moved(tmp_path):
    xyz, cls, _ = planted_cloud(ground_step=2.0, high=2, low=0)
    root = cloud_project(tmp_path, xyz, cls)
    with pytest.raises(JobError, match="file changed"):
        run_job(PointcloudClean(), root, {**NOISE, "src": "clouds/other.copc.laz"}, job_id="j-moved")
    manifest = json.loads((root / "manifest.json").read_text("utf-8"))
    manifest["layers"][0]["format"] = "png-packed"
    (root / "manifest.json").write_text(json.dumps(manifest), "utf-8")
    with pytest.raises(JobError, match="COPC"):
        run_job(PointcloudClean(), root, NOISE, job_id="j-png")
    assert not (root / "edits").exists()


def test_validate_defaults_missing_settings_explicitly():
    v = PointcloudClean().validate
    assert v({**NOISE, "outlier": None})["outlier"] == {"meanK": 8, "multiplier": 2.0}
    assert v({**NOISE, "outlier": {"meanK": 12}})["outlier"] == {"meanK": 12, "multiplier": 2.0}
    assert v({**NOISE, "elm": {}})["elm"] == {"cell": 10.0, "threshold": 1.0}
    assert "elm" not in v(NOISE)  # no elm: off


@pytest.mark.parametrize("lid", ["Scan 2.v1", "a", "A_b-c"])
def test_validate_takes_the_ids_main_takes(lid):
    assert PointcloudClean().validate({**NOISE, "layerId": lid})["layerId"] == lid


@pytest.mark.parametrize(
    "lid", [" lead", "-x", "a/b", "a\\b", "a*b", "a..b", "..", "../x", ".hidden", "x" * 129]
)
def test_validate_refuses_ids_main_refuses(lid):
    with pytest.raises(JobError, match="layer id"):
        PointcloudClean().validate({**NOISE, "layerId": lid})


def _spy_pdal(monkeypatch):
    calls = []
    real = pcc_pipeline._run

    def spy(ctx, args, what, *rest, **kw):
        calls.append(what)
        return real(ctx, args, what, *rest, **kw)

    monkeypatch.setattr(pcc_pipeline, "_run", spy)
    return calls


@needs_pdal
def test_refuses_a_cloud_too_big_for_the_memory_budget_before_pdal_runs(tmp_path, monkeypatch):
    from aio_pipelines.photo import native

    xyz, cls, _ = planted_cloud(ground_step=2.0, high=2, low=0)
    root = cloud_project(tmp_path, xyz, cls)
    monkeypatch.setattr(native, "memory_budget", lambda: 1000)
    calls = _spy_pdal(monkeypatch)
    with pytest.raises(JobError, match="memory budget"):
        run_job(PointcloudClean(), root, NOISE, job_id="j-mem")
    assert calls == []  # no PDAL pipeline started
    assert not (root / "edits").exists()


@needs_pdal
def test_refuses_when_the_staging_drive_is_too_small(tmp_path, monkeypatch):
    import shutil
    from collections import namedtuple

    xyz, cls, _ = planted_cloud(ground_step=2.0, high=2, low=0)
    root = cloud_project(tmp_path, xyz, cls)
    usage = namedtuple("usage", "total used free")
    monkeypatch.setattr(shutil, "disk_usage", lambda p: usage(10**12, 10**12 - 1000, 1000))
    calls = _spy_pdal(monkeypatch)
    with pytest.raises(JobError, match="Cleaning up this point cloud needs"):
        run_job(PointcloudClean(), root, NOISE, job_id="j-disk")
    assert calls == []
    assert not (root / "edits").exists()


@needs_pdal
def test_a_cancelled_run_leaves_no_project_files(tmp_path, monkeypatch):
    import threading

    xyz, cls, _ = planted_cloud(ground_step=2.0, high=2, low=0)
    root = cloud_project(tmp_path, xyz, cls)
    cancel = threading.Event()
    real = pcc_pipeline._run

    def cancel_after_marking(ctx, args, what, *rest, **kw):
        out = real(ctx, args, what, *rest, **kw)
        if what == "Finding noise":
            cancel.set()  # the next ctx.check raises
        return out

    monkeypatch.setattr(pcc_pipeline, "_run", cancel_after_marking)
    with pytest.raises(Cancelled):
        run_job(PointcloudClean(), root, NOISE, job_id="j-cancel", cancel=cancel)
    assert not (root / "edits").exists()
