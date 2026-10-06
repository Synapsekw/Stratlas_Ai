"""The M8 pipelines named by the contract (C0) are all built and listed (each stream tests its own)."""

import pytest

from aio_pipelines.pipelines import all_pipelines
from aio_pipelines.runtime import JobError

M8 = {
    "change.raster": {"from": "c1", "to": "c2", "layerFrom": "o1", "layerTo": "o2", "method": "gradient"},
    "change.surface": {"from": {"layer": "d1", "kind": "dsm"}, "to": {"layer": "d2", "kind": "dsm"}},
    "change.cloud": {"layerFrom": "a", "layerTo": "b"},
    "change.mesh": {"layerFrom": "a", "layerTo": "b"},
    "change.frames": {"from": "c1", "to": "c2"},
    "drawing.import": {"src": "plot.dxf", "units": "m"},
    "model.fit_cloud": {"layer": "scan"},
}


def test_every_m8_pipeline_is_listed():
    names = set(all_pipelines())
    assert set(M8) <= names
    for name in M8:
        p = all_pipelines()[name]
        assert p.title and p.description


@pytest.mark.parametrize("name", sorted(M8))
def test_an_m8_pipeline_refuses_unknown_parameters(name):
    with pytest.raises(JobError, match="bogus"):
        all_pipelines()[name].validate({**M8[name], "bogus": 1})
