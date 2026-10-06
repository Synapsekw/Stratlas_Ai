"""M8 pipelines named by the contract (C0) answer with a clear job error until they are built."""

import json

import pytest

from aio_pipelines.pipelines import all_pipelines
from aio_pipelines.runtime import JobError
from conftest import run_job

M8 = {
    "change.raster": {"from": "c1", "to": "c2", "layerFrom": "o1", "layerTo": "o2", "method": "gradient"},
    "change.surface": {"from": {"layer": "d1", "kind": "dsm"}, "to": {"layer": "d2", "kind": "dsm"}},
    "change.cloud": {"layerFrom": "a", "layerTo": "b"},
    "change.mesh": {"layerFrom": "a", "layerTo": "b"},
    "change.frames": {"from": "c1", "to": "c2"},
}
# built in M8 stream C5 (tests in test_drawing.py and test_modelfit.py), still part of the contract
BUILT = ["drawing.import", "model.fit_cloud"]


def test_every_m8_pipeline_is_listed():
    names = set(all_pipelines())
    assert set(M8) | set(BUILT) <= names
    for name in [*M8, *BUILT]:
        p = all_pipelines()[name]
        assert p.title and p.description


@pytest.mark.parametrize("name", sorted(M8))
def test_a_stub_fails_with_not_implemented_and_leaves_the_project_untouched(tmp_path, name):
    pipeline = all_pipelines()[name]
    with pytest.raises(JobError, match="not implemented"):
        run_job(pipeline, tmp_path, M8[name])
    job = json.loads((tmp_path / "jobs" / "j1" / "job.json").read_text("utf-8"))
    assert job["status"] == "failed"
    assert "not implemented" in job["error"]
    assert sorted(p.name for p in tmp_path.iterdir()) == ["jobs"]


@pytest.mark.parametrize("name", sorted(M8))
def test_a_stub_refuses_unknown_parameters(name):
    with pytest.raises(JobError, match="does not take: bogus"):
        all_pipelines()[name].validate({**M8[name], "bogus": 1})
