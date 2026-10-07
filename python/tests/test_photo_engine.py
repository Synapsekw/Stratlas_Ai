"""photo.align with the real engine (COLMAP through pycolmap), on rendered synthetic photos and,
on the founder's machine only, on a real flight.

Both skip unless an engine is installed: the pack's own pycolmap build (stream G1) in this
Python, or a development interpreter named by ``AIO_COLMAP_PYTHON``.

``test_realdata_*`` (the ``@realdata`` tests of the plan) also need ``STRATLAS_PHOTO_TEST_DIR``:
a folder of drone photos, or of camera folders (``DCIM/100MEDIA``, ``101MEDIA``). The photos
are read in place and never written; the test checks that nothing in the folder changed. The
project goes to ``STRATLAS_PHOTO_TEST_OUT`` when set (kept for inspection), else a temporary
folder. Nothing from a real flight is ever committed.
"""

import json
import os
from pathlib import Path

import numpy as np
import pytest

from aio_pipelines.photo.align import PhotoAlign, read_sparse
from aio_pipelines.photo.colmap_io import ColmapEngine
from aio_pipelines.runtime import JobError, input_fingerprint
from conftest import run_job
from photo_g2_synth import make_scene, render_nadir_set


def _engine_or_skip() -> None:
    try:
        ColmapEngine().versions()
    except JobError as e:
        pytest.skip(f"no alignment engine here: {e}")


def test_colmap_aligns_rendered_photos(project, tmp_path):
    _engine_or_skip()
    scene = make_scene(rows=3, cols=4, width=800, height=600, points=10, seed=21, gnss_sigma=(0.02, 0.03))
    photos = tmp_path / "photos"
    render_nadir_set(scene, photos, rtk=True, texture=(2048, 200.0))
    params = {"photos": {"folders": [str(photos)]}, "preset": "high", "run": "r1"}
    result, _ = run_job(PhotoAlign(), project, params)
    assert result["status"] == "done"
    align = json.loads((project / "photogrammetry/r1/report/align.json").read_text("utf-8"))
    assert align["images"]["registered"] >= 0.98 * 12 and align["meanReprojPx"] < 1.0
    model, _ = read_sparse(project / "photogrammetry/r1/sparse")
    assert len(model.images) == align["images"]["registered"]
    # memory budget: every engine stage of the synthetic set stays well inside a 16 GB laptop
    run = json.loads((project / "photogrammetry/r1/run.json").read_text("utf-8"))
    peaks = {s["name"]: s.get("memoryPeakBytes", 0) for s in run["stages"]}
    assert peaks["features"] > 0
    assert max(peaks.values()) < 2.5 * 2**30, peaks


def _photo_folders(root: Path) -> list[Path]:
    subs = sorted(p for p in root.iterdir() if p.is_dir() and any(p.glob("*.[jJ][pP][gG]")))
    return subs or [root]


@pytest.mark.skipif(
    not os.environ.get("STRATLAS_PHOTO_TEST_DIR"), reason="STRATLAS_PHOTO_TEST_DIR is not set"
)
def test_realdata_flight_aligns_with_gnss_only(tmp_path):
    _engine_or_skip()
    root = Path(os.environ["STRATLAS_PHOTO_TEST_DIR"])
    folders = _photo_folders(root)
    before = input_fingerprint(tmp_path, [str(f) for f in folders])
    out = Path(os.environ.get("STRATLAS_PHOTO_TEST_OUT") or tmp_path / "out")
    project = out / "project"
    project.mkdir(parents=True, exist_ok=True)
    params = {
        "photos": {"folders": [str(f) for f in folders]},
        "preset": os.environ.get("STRATLAS_PHOTO_TEST_PRESET", "fast"),
        "run": "realdata",
    }
    result, _ = run_job(PhotoAlign(), project, params, job_id="realdata-align")
    assert result["status"] == "done"
    align = json.loads((project / "photogrammetry/realdata/report/align.json").read_text("utf-8"))
    total = align["images"]["total"]
    assert align["images"]["registered"] >= 0.95 * total
    assert align["meanReprojPx"] < 1.0
    # without RTK or control, cameras sit within GNSS accuracy of their logged positions
    assert align["cameraResiduals"]["medianM"] < 10
    model, _ = read_sparse(project / "photogrammetry/realdata/sparse")
    assert np.isfinite(model.xyz).all()
    # the photos were only read
    assert input_fingerprint(tmp_path, [str(f) for f in folders]) == before
