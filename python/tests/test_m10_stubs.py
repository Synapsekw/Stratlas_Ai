"""M10 pipelines named by the contract (G0) answer with a clear job error until they are built.

The smallest parameters below are the ones ``packages/schema/src/m10.test.ts`` parses with zod, so
the names and the required ones agree on both sides of the JSON-RPC boundary.
"""

import json

import pytest

from aio_pipelines.pipelines import all_pipelines
from aio_pipelines.runtime import JobError
from aio_pipelines.stub import NotBuiltYet
from conftest import run_job

M10 = {
    "photo.align": {"photos": {"layer": "photos"}, "preset": "standard"},
    "photo.georef": {"run": "20261007-0900"},
    "photo.products": {"run": "20261007-0900", "products": ["ortho", "dsm"]},
    "opf.import": {"src": "D:/in/project.opf"},
    "opf.export": {"run": "20261007-0900", "out": "D:/out/opf"},
    "tiles.mesh": {"layer": "mesh-1"},
    "tiles.cloud": {"layer": "cloud-1"},
    "packs.imagery": {
        "src": ["D:/in/ortho.tif"],
        "dest": "D:/data/packs/imagery",
        "id": "site-imagery",
        "label": "Site imagery",
        "licence": "customer",
        "attribution": "Customer imagery",
        "customerLicence": True,
    },
    "packs.terrain": {
        "src": ["D:/in/dem.tif"],
        "dest": "D:/data/packs/terrain",
        "id": "site-dem",
        "label": "Site terrain",
        "licence": "CC0-1.0",
        "attribution": "CC0 test fixture",
        "verticalDatum": "egm2008",
    },
}


def test_every_m10_pipeline_is_listed():
    names = set(all_pipelines())
    assert set(M10) <= names
    for name in M10:
        p = all_pipelines()[name]
        assert p.title and p.description


#: The M10 pipelines still stubbed (each stream's real pipeline has its own tests).
STUBS = sorted(n for n in M10 if isinstance(all_pipelines()[n], NotBuiltYet))


@pytest.mark.parametrize("name", STUBS)
def test_a_stub_fails_with_not_implemented_and_leaves_the_project_untouched(tmp_path, name):
    pipeline = all_pipelines()[name]
    with pytest.raises(JobError, match="not implemented"):
        run_job(pipeline, tmp_path, M10[name])
    job = json.loads((tmp_path / "jobs" / "j1" / "job.json").read_text("utf-8"))
    assert job["status"] == "failed"
    assert "not implemented" in job["error"]
    assert sorted(p.name for p in tmp_path.iterdir()) == ["jobs"]


@pytest.mark.parametrize("name", sorted(M10))
def test_a_stub_refuses_unknown_parameters(name):
    with pytest.raises(JobError, match="does not take: bogus"):
        all_pipelines()[name].validate({**M10[name], "bogus": 1})


def test_a_stub_checks_required_names_and_fixed_choices():
    pipes = all_pipelines()
    with pytest.raises(JobError, match="needs: preset"):
        pipes["photo.align"].validate({"photos": {"layer": "p"}})
    with pytest.raises(JobError, match="preset must be one of"):
        pipes["photo.align"].validate({"photos": {"layer": "p"}, "preset": "ultra"})
    with pytest.raises(JobError, match="products must be one of"):
        pipes["photo.products"].validate({"run": "r", "products": ["ortho", "hologram"]})
    with pytest.raises(JobError, match="products must be one of"):
        pipes["photo.products"].validate({"run": "r", "products": []})
    with pytest.raises(JobError, match="verticalDatum must be one of"):
        pipes["packs.terrain"].validate({**M10["packs.terrain"], "verticalDatum": "msl"})
    with pytest.raises(JobError, match="not both"):
        pipes["tiles.mesh"].validate({"layer": "a", "src": "models/a.glb"})
    with pytest.raises(JobError, match="not both"):
        pipes["tiles.mesh"].validate({})
