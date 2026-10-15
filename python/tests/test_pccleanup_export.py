"""survey.export of a cloud with a cleanup recipe: the same points a cleaned copy would hold."""

import json
import subprocess

import pytest

from aio_pipelines.pointcloud import find_pdal, pdal_env
from aio_pipelines.pointcloud_cleanup.evaluate import evaluate, kept_for_save
from aio_pipelines.runtime import JobError
from aio_pipelines.survey.export import SurveyExport
from conftest import run_job
from pccleanup_synth import E0, EPSG, N0, _pdal, cloud_project, planted_cloud, write_las14

PDAL = find_pdal()
needs_pdal = pytest.mark.skipif(PDAL is None, reason="PDAL not found (set AIO_PDAL)")
VP = [0.05, 0, 0, 0, 0, 0.05, 0, 0, 0, 0, 0, 0, -(E0 + 20) * 0.05, -(N0 + 20) * 0.05, 0, 1]
BASE = {"what": "cloud", "format": "laz", "crs": {"epsg": EPSG}, "layer": "cloud-a"}


def recipe(**over):
    return {"schema": "aio.pccleanup/1", "layerId": "cloud-a", "hiddenClasses": [], "regions": [], **over}


def pdal_info(path, *flags):
    out = subprocess.run(
        [PDAL, "info", *flags, str(path)], capture_output=True, check=True, env=pdal_env(PDAL)
    )
    return json.loads(out.stdout)


def count(path):
    return pdal_info(path, "--summary")["summary"]["num_points"]


def a_recipe():
    return recipe(
        height={"min": -1},
        regions=[{"id": "d", "shape": "box", "viewProj": VP, "polygon": [[-1, -1], [-0.5, -1], [-0.5, 1], [-1, 1]],
                  "action": {"kind": "delete"}}],
        hiddenClasses=[1],
    )  # fmt: skip


def test_cleanup_only_with_a_cloud_export():
    with pytest.raises(JobError, match="cloud"):
        SurveyExport().validate({**BASE, "what": "surface", "format": "geotiff", "surface": "s", "out": "C:/x.tif",
                                 "cleanup": recipe()})  # fmt: skip
    with pytest.raises(JobError, match="another layer"):
        SurveyExport().validate({**BASE, "out": "C:/x.laz", "cleanup": recipe(layerId="b")})


@needs_pdal
def test_export_with_and_without_a_cleanup(tmp_path):
    xyz, cls, _ = planted_cloud()
    root = cloud_project(tmp_path, xyz, cls)
    plain = tmp_path / "plain.laz"
    run_job(SurveyExport(), root, {**BASE, "out": str(plain)}, job_id="j-plain")
    assert count(plain) == len(xyz)  # no recipe: the cloud as it is
    r = a_recipe()
    cleaned = tmp_path / "cleaned.laz"
    run_job(SurveyExport(), root, {**BASE, "out": str(cleaned), "cleanup": r}, job_id="j-clean")
    state, _ = evaluate(r, xyz, cls)
    assert count(cleaned) == int(kept_for_save(state).sum())


@needs_pdal
def test_a_format_3_source_is_staged_as_format_6_7_or_8(tmp_path):
    xyz, cls, _ = planted_cloud()
    root = cloud_project(tmp_path, xyz, cls)
    old = tmp_path / "old.las"  # LAS 1.2, point format 3 (with colour)
    _pdal(
        [
            {"type": "readers.las", "filename": str(write_las14(tmp_path / "src.las", xyz, cls))},
            {"type": "writers.las", "filename": str(old), "minor_version": 2, "dataformat_id": 3},
        ],
        old,
    )
    assert pdal_info(old, "--metadata")["metadata"]["dataformat_id"] == 3
    manifest = json.loads((root / "manifest.json").read_text("utf-8"))
    manifest["layers"][0]["src"] = {"path": "clouds/old.las"}
    (root / "clouds" / "old.las").write_bytes(old.read_bytes())
    (root / "manifest.json").write_text(json.dumps(manifest), "utf-8")
    r = a_recipe()
    cleaned = tmp_path / "cleaned.laz"
    run_job(SurveyExport(), root, {**BASE, "out": str(cleaned), "cleanup": r}, job_id="j-old")
    state, _ = evaluate(r, xyz, cls)
    assert count(cleaned) == int(kept_for_save(state).sum())
    assert pdal_info(cleaned, "--metadata")["metadata"]["dataformat_id"] in (6, 7, 8)


@needs_pdal
def test_refuses_an_export_that_would_remove_every_point(tmp_path):
    xyz, cls, _ = planted_cloud(ground_step=2.0, high=2, low=0)
    root = cloud_project(tmp_path, xyz, cls)
    with pytest.raises(JobError, match="removes every point"):
        run_job(
            SurveyExport(),
            root,
            {**BASE, "out": str(tmp_path / "x.laz"), "cleanup": recipe(hiddenClasses=[1, 2, 6])},
        )
