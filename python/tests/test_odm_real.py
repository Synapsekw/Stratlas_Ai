"""The real ODM on real photos: set AIO_ODM (an installed ODM folder) and AIO_ODM_REAL_PHOTOS (a
folder of about 30 drone photos). Skipped otherwise. Runs align and products (Fast) for real, then
products again on the same run (Standard, with dense matching and a DTM): Create maps a second
time must find what the first products job left."""

import json
import os
import time
from pathlib import Path

import pytest

from aio_pipelines.photo.align import PhotoAlign
from aio_pipelines.photo.products import PhotoProducts
from conftest import run_job

PHOTOS = os.environ.get("AIO_ODM_REAL_PHOTOS")
pytestmark = pytest.mark.skipif(not (PHOTOS and os.environ.get("AIO_ODM")), reason="real ODM run is opt-in")


def _say(project: Path, what: str, seconds: float) -> dict:
    run = json.loads((project / "photogrammetry" / "real" / "run.json").read_text())
    steps = {s["name"]: s.get("seconds") for s in run["stages"] if s.get("seconds") is not None}
    print(f"{what}: {seconds:.0f} s; stages {steps}; engine {run.get('engine')}")
    return run


@pytest.mark.timeout(4 * 3600)
def test_real_odm_aligns_and_makes_an_orthophoto(project: Path):
    t0 = time.monotonic()
    result, _ = run_job(
        PhotoAlign(), project, {"photos": {"folders": [PHOTOS]}, "preset": "fast", "run": "real"}
    )
    assert result["status"] == "done"
    _say(project, "align", time.monotonic() - t0)
    # the project the app would have: a manifest in the run's CRS with an origin on the site
    frame = json.loads((project / "photogrammetry" / "real" / "sparse" / "frame.json").read_text())
    manifest = {"schema": "aio.project/1", "id": "real", "name": "Real ODM", "type": "volumetric",
                "crs": frame["crs"], "origin": frame["origin"], "captures": [], "layers": [],
                "severityModels": [], "classCatalogues": []}  # fmt: skip
    (project / "manifest.json").write_text(json.dumps(manifest), "utf-8")
    t0 = time.monotonic()
    result, _ = run_job(
        PhotoProducts(), project, {"run": "real", "products": ["ortho", "dsm"], "preset": "fast"}, job_id="j2"
    )
    assert result["status"] == "done"
    _say(project, "products fast", time.monotonic() - t0)
    assert (project / "photogrammetry" / "real" / "ortho.tif").is_file()
    t0 = time.monotonic()
    result, _ = run_job(
        PhotoProducts(),
        project,
        {"run": "real", "products": ["ortho", "dsm", "dtm"], "preset": "standard"},
        job_id="j3",
    )
    assert result["status"] == "done"
    run = _say(project, "products standard again", time.monotonic() - t0)
    assert "real-dtm" in run["outputs"]["layers"]
