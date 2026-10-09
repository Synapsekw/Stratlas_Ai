"""Every M11 pipeline named by the contract (G0) checks its parameters the way the zod schema does.

The smallest parameters below are the ones ``packages/schema/src/m11.test.ts`` parses with zod, so
the names and the required ones agree on both sides of the JSON-RPC boundary. Until a stream builds
its pipeline, the stub fails its one step with a clear job error and leaves the project untouched.
"""

import json
import os
from pathlib import Path

import pytest

from aio_pipelines.pipelines import all_pipelines
from aio_pipelines.runtime import JobError
from aio_pipelines.stub import NOT_IMPLEMENTED
from conftest import run_job


# Absolute on the machine running the tests (a "D:/..." path is not absolute on macOS).
def _abs(rel: str) -> str:
    return str(Path(os.path.abspath(os.sep)) / rel)


M11 = {
    "survey.prepare": {
        "surfaces": [{"id": "dsm-1", "name": "DSM", "source": {"kind": "dsm", "layer": "dsm"}}]
    },
    "survey.compare": {"site": {"from": {"kind": "previous"}, "to": {"kind": "current"}}},
    "survey.overlay": {"surface": "dsm-1", "kind": "contours"},
    "survey.section": {
        "line": [[0, 0], [10, 0]],
        "surfaces": [{"kind": "current"}],
        "format": "csv",
        "out": _abs("out/section.csv"),
    },
    "survey.export": {
        "what": "surface",
        "format": "geotiff",
        "crs": "site",
        "surface": "dsm-1",
        "out": _abs("out/dsm.tif"),
    },
    "survey.qa": {"capture": "c1", "surface": "dsm-1", "level": "moderate"},
    "survey.cleanup": {"surface": "dsm-1", "edits": ["e1"]},
    "design.import": {"src": _abs("in/design.xml")},
    "geo.calibration": {"src": _abs("in/job.jxl"), "crs": {"epsg": 32639}},
    "hydro.flood": {"surface": "dsm-1", "levelM": 10, "mode": "all-below"},
    "hydro.flow": {"surface": "dsm-1", "mode": "catchment"},
    "hydro.rainfall": {
        "surface": "dsm-1",
        "hyetograph": _abs("in/rain.csv"),
        "manningN": 0.03,
        "infiltrationMmPerH": 0,
        "cellM": 1,
    },
    "haul.analyse": {
        "surface": "dsm-1",
        "centreline": [[0, 0], [100, 0]],
        "intervalM": 10,
        "limits": {},
    },
}

#: Pipelines a stream has built (no longer stubs): checked for their names and titles here, and
#: by their own tests for what they do.
#: Pipelines a stream has built: their own tests replace the stub's run test.
BUILT = {
    "design.import",
    "geo.calibration",
    "haul.analyse",
    "hydro.flood",
    "hydro.flow",
    "hydro.rainfall",
    "survey.cleanup",
    "survey.compare",
    "survey.overlay",
    "survey.prepare",
    "survey.qa",
    "survey.section",
}
STUBS = sorted(set(M11) - BUILT)

TITLES = {
    "survey.prepare": "Prepare surfaces",
    "survey.compare": "Compare surfaces",
    "survey.overlay": "Terrain overlay",
    "survey.section": "Cross-section",
    "survey.export": "Survey export",
    "survey.qa": "Survey QA",
    "survey.cleanup": "Terrain cleanup",
    "design.import": "Import design",
    "geo.calibration": "Site calibration",
    "hydro.flood": "Flood to level",
    "hydro.flow": "Runoff and catchments",
    "hydro.rainfall": "Direct rainfall",
    "haul.analyse": "Haul-road compliance",
}


def test_every_m11_pipeline_is_listed_with_the_contract_title():
    pipes = all_pipelines()
    assert set(M11) <= set(pipes)
    for name, title in TITLES.items():
        assert pipes[name].title == title
        assert pipes[name].description


@pytest.mark.parametrize("name", sorted(M11))
def test_the_smallest_parameters_validate(name):
    assert all_pipelines()[name].validate(M11[name]) == M11[name]


@pytest.mark.parametrize("name", STUBS)
def test_a_stub_fails_with_not_implemented_and_leaves_the_project_untouched(tmp_path, name, monkeypatch):
    monkeypatch.delenv("PROJ_NETWORK", raising=False)
    pipeline = all_pipelines()[name]
    steps = pipeline.plan(pipeline.validate(M11[name]))
    assert [s.name for s in steps] == ["not-built"]
    message = NOT_IMPLEMENTED.format(title=TITLES[name], name=name)
    with pytest.raises(JobError) as err:
        run_job(pipeline, tmp_path, M11[name])
    assert str(err.value) == message
    job = json.loads((tmp_path / "jobs" / "j1" / "job.json").read_text("utf-8"))
    assert job["status"] == "failed"
    assert job["error"] == message
    assert sorted(p.name for p in tmp_path.iterdir()) == ["jobs"]
    # No stub turns PROJ network access on (or sets it at all): the pack stays offline.
    assert "PROJ_NETWORK" not in os.environ


@pytest.mark.parametrize("name", sorted(M11))
def test_a_stub_refuses_unknown_parameters(name):
    with pytest.raises(JobError, match="does not take: bogus"):
        all_pipelines()[name].validate({**M11[name], "bogus": 1})


@pytest.mark.parametrize("name", sorted(M11))
def test_a_stub_refuses_each_missing_required_name(name):
    pipeline = all_pipelines()[name]
    for key in sorted(pipeline.required):
        params = {k: v for k, v in M11[name].items() if k != key}
        with pytest.raises(JobError, match=f"needs: {key}"):
            pipeline.validate(params)


def test_a_stub_checks_fixed_choices():
    pipes = all_pipelines()
    with pytest.raises(JobError, match="kind must be one of"):
        pipes["survey.overlay"].validate({**M11["survey.overlay"], "kind": "hillshade"})
    with pytest.raises(JobError, match="format must be one of"):
        pipes["survey.section"].validate({**M11["survey.section"], "format": "pdf"})
    with pytest.raises(JobError, match="units must be one of"):
        pipes["survey.export"].validate({**M11["survey.export"], "units": "furlong"})
    with pytest.raises(JobError, match="crs must be site, wgs84 or an EPSG code"):
        pipes["survey.export"].validate({**M11["survey.export"], "crs": "local"})
    assert pipes["survey.export"].validate({**M11["survey.export"], "crs": {"epsg": 32639}})
    with pytest.raises(JobError, match="level must be one of"):
        pipes["survey.qa"].validate({**M11["survey.qa"], "level": "extreme"})
    with pytest.raises(JobError, match="format must be one of"):
        pipes["design.import"].validate({**M11["design.import"], "format": "dwg"})
    with pytest.raises(JobError, match="format must be one of"):
        pipes["geo.calibration"].validate({**M11["geo.calibration"], "format": "csv"})
    with pytest.raises(JobError, match="mode must be one of"):
        pipes["hydro.flood"].validate({**M11["hydro.flood"], "mode": "spill"})
    with pytest.raises(JobError, match="method must be one of"):
        pipes["hydro.flow"].validate({**M11["hydro.flow"], "method": "mfd"})
    with pytest.raises(JobError, match="cellM must be one of"):
        pipes["hydro.rainfall"].validate({**M11["hydro.rainfall"], "cellM": 5})
    assert pipes["hydro.rainfall"].validate({**M11["hydro.rainfall"], "cellM": 0.5})


def test_a_stub_enforces_exactly_one_of_two_alternatives():
    pipes = all_pipelines()
    site = M11["survey.compare"]["site"]
    real = {"id": "i1", "from": {"kind": "smart"}, "to": {"kind": "current"}, "useDeadband": False}
    item = {"measurement": "m1", "ring": [[0, 0], [1, 0], [1, 1]], "item": real}
    assert pipes["survey.compare"].validate({"items": [item]})
    for bad in ({}, {"items": [item], "site": site}):
        with pytest.raises(JobError, match="Give items or site, not both"):
            pipes["survey.compare"].validate(bad)

    comparison = {"from": {"kind": "previous"}, "to": {"kind": "current"}}
    assert pipes["survey.overlay"].validate({"comparison": comparison, "kind": "slope"})
    for bad in ({"kind": "slope"}, {"surface": "dsm-1", "comparison": comparison, "kind": "slope"}):
        with pytest.raises(JobError, match="Give a surface or a comparison, not both"):
            pipes["survey.overlay"].validate(bad)

    dtm = {"layer": "cloud-1", "preset": "equipment"}
    assert pipes["survey.cleanup"].validate({"dtmFilter": dtm})
    for bad in ({}, {"surface": "dsm-1"}, {"edits": ["e1"]}, {**M11["survey.cleanup"], "dtmFilter": dtm}):
        with pytest.raises(JobError, match="Give a surface with edits, or a DTM filter"):
            pipes["survey.cleanup"].validate(bad)

    pair = {"local": [0, 0, 0], "grid": [0, 0, 0]}
    crs = {"epsg": 32639}
    assert pipes["geo.calibration"].validate({"pairs": [pair], "crs": crs})
    for bad in ({"crs": crs}, {**M11["geo.calibration"], "pairs": [pair]}):
        with pytest.raises(JobError, match="Give a file or point pairs, not both"):
            pipes["geo.calibration"].validate(bad)
