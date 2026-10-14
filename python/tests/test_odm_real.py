"""The real ODM on real photos: set AIO_ODM (an installed ODM folder) and AIO_ODM_REAL_PHOTOS (a
folder of about 30 drone photos). Skipped otherwise. Runs align and products (Fast) for real."""

import json
import os
from pathlib import Path

import pytest

from aio_pipelines.photo.align import PhotoAlign
from aio_pipelines.photo.products import PhotoProducts
from conftest import run_job

PHOTOS = os.environ.get("AIO_ODM_REAL_PHOTOS")
pytestmark = pytest.mark.skipif(not (PHOTOS and os.environ.get("AIO_ODM")), reason="real ODM run is opt-in")


def test_real_odm_aligns_and_makes_an_orthophoto(project: Path):
    result, _ = run_job(
        PhotoAlign(), project, {"photos": {"folders": [PHOTOS]}, "preset": "fast", "run": "real"}
    )
    assert result["status"] == "done"
    result, _ = run_job(
        PhotoProducts(), project, {"run": "real", "products": ["ortho", "dsm"], "preset": "fast"}, job_id="j2"
    )
    assert result["status"] == "done"
    run = json.loads((project / "photogrammetry" / "real" / "run.json").read_text())
    print("engine:", run["engine"])
    assert (project / "photogrammetry" / "real" / "ortho.tif").is_file()
