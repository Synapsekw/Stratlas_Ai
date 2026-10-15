"""The real ODM on real photos: set AIO_ODM (an installed ODM folder) and AIO_ODM_REAL_PHOTOS (a
folder of about 30 drone photos). Skipped otherwise. Runs align and products (Fast) for real, then
products again on the same run (Standard, with dense matching and a DTM): Create maps a second
time must find what the first products job left.

AIO_ODM_REAL_PROJECT puts the project in a fresh folder below that one instead of pytest's (a
folder with a space takes the junction route, as on a data root such as ``E:\\Stratlas Data``);
set AIO_ODM_WORK to a safe folder for the junctions then. AIO_ODM_OWNED=1 with AIO_ODM_GPU=auto
lets the runner park ODM's placeholder nvcuda.dll in that ODM folder (use a throwaway copy)."""

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


@pytest.fixture
def real_project(project: Path) -> Path:
    base = os.environ.get("AIO_ODM_REAL_PROJECT")
    if not base:
        return project
    p = Path(base) / time.strftime("run-%Y%m%d-%H%M%S")
    p.mkdir(parents=True)
    return p


def _say(project: Path, what: str, seconds: float) -> dict:
    run = json.loads((project / "photogrammetry" / "real" / "run.json").read_text())
    steps = {s["name"]: s.get("seconds") for s in run["stages"] if s.get("seconds") is not None}
    print(f"{what}: {seconds:.0f} s; stages {steps}; engine {run.get('engine')}")
    return run


def _undistorted_width(project: Path) -> tuple[int, int] | None:
    """The width of one undistorted photo of ODM's alignment and of its original photo."""
    from PIL import Image

    odm = project / "photogrammetry" / "real" / "odm"
    und = sorted((odm / "opensfm" / "undistorted" / "images").glob("*"))
    if not und:
        return None
    name = und[0].name.split(".")[0]
    original = next((p for p in (odm / "images").iterdir() if p.name.split(".")[0] == name), None)
    if original is None:
        return None
    Image.MAX_IMAGE_PIXELS = None
    with Image.open(und[0]) as a, Image.open(original) as b:
        return a.size[0], b.size[0]


@pytest.mark.timeout(4 * 3600)
def test_real_odm_aligns_and_makes_an_orthophoto(real_project: Path):
    project = real_project
    print(f"project {project}")
    t0 = time.monotonic()
    result, rec = run_job(
        PhotoAlign(), project, {"photos": {"folders": [PHOTOS]}, "preset": "fast", "run": "real"}
    )
    assert result["status"] == "done", rec.of("log")[-10:]
    _say(project, "align", time.monotonic() - t0)
    print(f"undistorted width, original width: {_undistorted_width(project)}")
    # the project the app would have: a manifest in the run's CRS with an origin on the site
    frame = json.loads((project / "photogrammetry" / "real" / "sparse" / "frame.json").read_text())
    manifest = {"schema": "aio.project/1", "id": "real", "name": "Real ODM", "type": "volumetric",
                "crs": frame["crs"], "origin": frame["origin"], "captures": [], "layers": [],
                "severityModels": [], "classCatalogues": []}  # fmt: skip
    (project / "manifest.json").write_text(json.dumps(manifest), "utf-8")
    t0 = time.monotonic()
    result, rec = run_job(
        PhotoProducts(), project, {"run": "real", "products": ["ortho", "dsm"], "preset": "fast"}, job_id="j2"
    )
    assert result["status"] == "done", rec.of("log")[-10:]
    _say(project, "products fast", time.monotonic() - t0)
    assert (project / "photogrammetry" / "real" / "ortho.tif").is_file()
    t0 = time.monotonic()
    result, rec = run_job(
        PhotoProducts(),
        project,
        {"run": "real", "products": ["ortho", "dsm", "dtm"], "preset": "standard"},
        job_id="j3",
    )
    assert result["status"] == "done", rec.of("log")[-10:]
    run = _say(project, "products standard again", time.monotonic() - t0)
    for m in rec.of("log"):  # the threads, the graphics card and the resolutions ODM was given
        if "raphics card" in m["message"] or m["message"].startswith("ODM "):
            print(f"log: {m['message']}")
    assert "real-dtm" in run["outputs"]["layers"]
