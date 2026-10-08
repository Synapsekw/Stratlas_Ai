"""photo.align with the real engine (COLMAP through pycolmap), on rendered synthetic photos and,
on the founder's machine only, on a real flight.

Both skip unless an engine is installed: the pack's own pycolmap build (stream G1) in this
Python, or a development interpreter named by ``AIO_COLMAP_PYTHON``.

``test_realdata_*`` (the ``@realdata`` tests of the plan) also need ``QUADRION_PHOTO_TEST_DIR`` (or the legacy ``STRATLAS_PHOTO_TEST_DIR``):
a folder of drone photos, or of camera folders (``DCIM/100MEDIA``, ``101MEDIA``); several folders
separated by ``;`` (``:`` on macOS) are aligned as one run, so photos whose folders have spaces
sit below the common folder. ``QUADRION_PHOTO_TEST_LIMIT`` (or the legacy ``STRATLAS_PHOTO_TEST_LIMIT``) keeps only the first N photos of each
folder (in name order, so neighbours overlap): a quick check instead of the whole flight. The
photos are read in place and never written; the test checks that nothing in the folders changed.
The project goes to ``QUADRION_PHOTO_TEST_OUT`` (or the legacy ``STRATLAS_PHOTO_TEST_OUT``) when set (kept for inspection), else a temporary
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


def _env(name: str) -> str | None:
    """``QUADRION_<name>``, else the legacy ``STRATLAS_<name>`` (the rename of 7 Oct 2026)."""
    return os.environ.get(f"QUADRION_{name}") or os.environ.get(f"STRATLAS_{name}")


def _photo_folders(root: Path) -> list[Path]:
    subs = sorted(p for p in root.iterdir() if p.is_dir() and any(p.glob("*.[jJ][pP][gG]")))
    return subs or [root]


@pytest.mark.skipif(not _env("PHOTO_TEST_DIR"), reason="QUADRION_PHOTO_TEST_DIR is not set")
def test_realdata_flight_aligns_with_gnss_only(tmp_path, monkeypatch):
    _engine_or_skip()
    roots = [Path(p) for p in (_env("PHOTO_TEST_DIR") or "").split(os.pathsep) if p.strip()]
    folders = [f for root in roots for f in _photo_folders(root)]
    limit = int(_env("PHOTO_TEST_LIMIT") or 0)
    if limit:
        import aio_pipelines.photo.align as align_mod

        every = align_mod.list_folder_photos

        def first_of_each(fs):
            listed = every(fs)
            out = []
            for f in fs:
                mine = sorted(((k, p) for k, p in listed if p.is_relative_to(f)), key=lambda kp: kp[0])
                out += mine[:limit]
            return out

        monkeypatch.setattr(align_mod, "list_folder_photos", first_of_each)
    before = input_fingerprint(tmp_path, [str(f) for f in folders])
    out = Path(_env("PHOTO_TEST_OUT") or tmp_path / "out")
    project = out / "project"
    project.mkdir(parents=True, exist_ok=True)
    params = {
        "photos": {"folders": [str(f) for f in folders]},
        "preset": _env("PHOTO_TEST_PRESET") or "fast",
        "run": "realdata",
    }
    result, _ = run_job(PhotoAlign(), project, params, job_id="realdata-align")
    assert result["status"] == "done"
    align = json.loads((project / "photogrammetry/realdata/report/align.json").read_text("utf-8"))
    total = align["images"]["total"]
    if limit:
        assert total <= limit * len(folders)
    # a few dozen photos per folder may leave a folder of a few photos on its own: 90 % then
    assert align["images"]["registered"] >= (0.9 if limit else 0.95) * total
    assert align["meanReprojPx"] < 1.0
    # without RTK or control, cameras sit within GNSS accuracy of their logged positions
    assert align["cameraResiduals"]["medianM"] < 10
    model, _ = read_sparse(project / "photogrammetry/realdata/sparse")
    assert np.isfinite(model.xyz).all()
    # the photos were only read
    assert input_fingerprint(tmp_path, [str(f) for f in folders]) == before
