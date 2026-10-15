"""pointcloud.clean, noise mode: PDAL's statistical outlier filter (and optionally filters.elm) marks
noise as class 7 in a working copy; every other class stays; the original file is untouched."""

import hashlib
import json

import numpy as np
import pytest

from aio_pipelines.pipelines import all_pipelines
from aio_pipelines.pointcloud import find_pdal
from aio_pipelines.pointcloud_cleanup.lasstream import class_histogram
from aio_pipelines.pointcloud_cleanup.pipeline import PointcloudClean
from aio_pipelines.runtime import JobError
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
