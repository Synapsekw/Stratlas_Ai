"""pointcloud.clean, save mode: the recipe over every point, streamed, written as a new COPC layer;
the original layer is hidden, its file untouched."""

import hashlib
import json

import numpy as np
import pytest

from aio_pipelines.change.las import read_las
from aio_pipelines.pointcloud import find_pdal
from aio_pipelines.pointcloud_cleanup.evaluate import evaluate, kept_for_save
from aio_pipelines.pointcloud_cleanup.pipeline import PointcloudClean
from aio_pipelines.runtime import JobError
from conftest import run_job
from pccleanup_synth import E0, N0, cloud_project, copc_to_las, planted_cloud

pytestmark = pytest.mark.skipif(find_pdal() is None, reason="PDAL not found (set AIO_PDAL)")
SRC = "clouds/cloud-a.copc.laz"

#: world to clip: ndc x = (E - E0 - 20) / 20, ndc y = (N - N0 - 20) / 20, w = 1
VP = [0.05, 0, 0, 0, 0, 0.05, 0, 0, 0, 0, 0, 0, -(E0 + 20) * 0.05, -(N0 + 20) * 0.05, 0, 1]


def recipe(**over):
    return {
        "schema": "aio.pccleanup/1",
        "layerId": "cloud-a",
        "hiddenClasses": [],
        "regions": [],
        **over,
    }


def save(root, r, job_id="j-save", name="Scan"):
    return run_job(
        PointcloudClean(),
        root,
        {"mode": "save", "layerId": "cloud-a", "src": SRC, "recipe": r, "name": name},
        job_id=job_id,
    )


def test_writes_the_cleaned_copy_as_a_new_layer_and_hides_the_original(tmp_path):
    xyz, cls, _ = planted_cloud()
    root = cloud_project(tmp_path, xyz, cls)
    before = hashlib.sha256((root / SRC).read_bytes()).hexdigest()
    r = recipe(
        # keep inside a 30 m box around the middle, heights from -25 to 35 m: the high outliers go
        clipBox={"center": [E0 + 20, N0 + 20, 5], "size": [30, 30, 60], "yaw": 0, "keep": "inside"},
        regions=[
            # delete the left quarter, set the right quarter to class 3
            {"id": "d", "shape": "box", "viewProj": VP, "polygon": [[-1, -1], [-0.5, -1], [-0.5, 1], [-1, 1]],
             "action": {"kind": "delete"}},
            {"id": "c", "shape": "lasso", "viewProj": VP, "polygon": [[0.5, -1], [1, -1], [1, 1], [0.5, 1]],
             "action": {"kind": "class", "value": 3}},
        ],
        hiddenClasses=[1],
    )  # fmt: skip
    result, _ = save(root, r)
    out = result["outputs"]["register"]
    state, new_cls = evaluate(r, xyz, cls)
    keep = kept_for_save(state)
    assert out["points"] == int(keep.sum()) > 0
    las = read_las(copc_to_las(root / out["path"], tmp_path / "cleaned.las"))
    assert las.count == int(keep.sum())
    assert (
        np.bincount(las.field("Classification"), minlength=256).tolist()
        == np.bincount(new_cls[keep], minlength=256).tolist()
    )
    manifest = json.loads((root / "manifest.json").read_text("utf-8"))
    original, copy = manifest["layers"]
    assert original["visible"] is False
    assert copy == {
        "kind": "pointcloud",
        "id": "cloud-a-cleaned",
        "name": "Scan (cleaned)",
        "visible": True,
        "capture": "d1",
        "src": {"path": "clouds/cloud-a-cleaned.copc.laz"},
        "format": "copc",
        "pointCount": int(keep.sum()),
        "derived": {"kind": "cleanup", "source": ["cloud-a"], "runId": "j-save"},
    }
    assert (root / "manifest.json.bak").is_file()
    assert hashlib.sha256((root / SRC).read_bytes()).hexdigest() == before
    # a second save gets its own id
    result2, _ = save(root, r, job_id="j-save-2")
    assert result2["outputs"]["register"]["layer"] == "cloud-a-cleaned-2"


def test_with_a_noise_copy_it_reads_the_copy(tmp_path):
    xyz, cls, outlier = planted_cloud()
    root = cloud_project(tmp_path, xyz, cls)
    noise, _ = run_job(
        PointcloudClean(),
        root,
        {"mode": "noise", "layerId": "cloud-a", "src": SRC, "outlier": {"meanK": 8, "multiplier": 2.0}},
        job_id="j-noise",
    )
    record = noise["outputs"]["commit"]
    result, _ = save(root, recipe(hiddenClasses=[7], noise=record))
    assert result["outputs"]["register"]["points"] == record["total"] - record["marked"]


def test_refuses_when_the_cleanup_removes_every_point_and_adds_nothing(tmp_path):
    xyz, cls, _ = planted_cloud(ground_step=2.0, high=4, low=2)
    root = cloud_project(tmp_path, xyz, cls)
    manifest = (root / "manifest.json").read_text("utf-8")
    with pytest.raises(JobError, match="removes every point"):
        save(root, recipe(hiddenClasses=[1, 2, 6]))
    assert (root / "manifest.json").read_text("utf-8") == manifest
    assert sorted(p.name for p in (root / "clouds").iterdir()) == ["cloud-a.copc.laz"]


def test_refuses_a_recipe_of_another_layer(tmp_path):
    with pytest.raises(JobError, match="another layer"):
        PointcloudClean().validate(
            {"mode": "save", "layerId": "cloud-a", "src": SRC, "recipe": recipe(layerId="b"), "name": "x"}
        )
