"""photo.align then photo.products on G8's synthetic photos, end to end (M10 integration).

Two variants on the mini set (nine rendered nadir photos and five bad ones at 960 x 720, RTK
geotags, ``photo_synth.py``):

- **precomputed engine** (always): the real ``photo.align`` (EXIF and XMP, inspection, pairs,
  GNSS georeferencing and bundle adjustment, run files) with an engine that hands back G8's
  precomputed COLMAP model in an arbitrary frame instead of running COLMAP; then the real
  ``photo.products``.
- **COLMAP** (``AIO_COLMAP_PYTHON`` set): the same chain with the real engine, the photos in
  folders whose names have spaces. Skipped otherwise.

Both check the products against G8's truth: the layers in the manifest, the files of the run and
the DSM against the true surface.
"""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

import numpy as np
import pytest

from aio_pipelines.photo import crs as C
from aio_pipelines.photo.align import PhotoAlign, decode_name
from aio_pipelines.photo.model import SparseModel
from aio_pipelines.photo.products import PhotoProducts
from conftest import run_job
from photo_synth import SITE

RUN = "chain"
PRODUCTS = ["dsm", "ortho", "mesh"]


@pytest.fixture(scope="module")
def mini_rtk(photo_set_factory):
    return photo_set_factory("mini", "rtk")


class PrecomputedEngine:
    """The engine adapter (``colmap_io.SfmEngine``) over G8's precomputed alignment: features and
    matching do nothing, mapping returns G8's COLMAP model seen through an arbitrary similarity
    (SfM has no datum), its images named as the job names them."""

    name = "precomputed"

    def __init__(self, sparse: Path):
        self.sparse = sparse
        self.calls: list[str] = []

    def versions(self) -> dict[str, str]:
        return {"engine": "precomputed (G8 alignment)"}

    def features(self, job, progress) -> dict:
        self.calls.append("features")
        progress(1.0, None)
        return {"images": len(job.images)}

    def match(self, job, pairs, progress) -> dict:
        self.calls.append("match")
        progress(1.0, None)
        return {"pairs": len(pairs), "matched": len(pairs), "verified": len(pairs)}

    def map(self, job, mapper, progress) -> dict:
        self.calls.append(f"map:{mapper}")
        model = SparseModel.read_text(self.sparse)
        by_file = {Path(im.name).name: im.name for im in job.images}
        for iid in list(model.images):
            im = model.images[iid]
            if decode_name(im.name) not in by_file:
                del model.images[iid]
            else:
                im.name = by_file[decode_name(im.name)]
        rng = np.random.default_rng(4)
        q, _ = np.linalg.qr(rng.normal(size=(3, 3)))
        if np.linalg.det(q) < 0:
            q[:, 0] *= -1
        model.transform(0.31, q, rng.normal(0, 20, 3))
        out = job.work / "sfm" / "model.npz"
        out.parent.mkdir(parents=True, exist_ok=True)
        model.save_npz(out)
        progress(1.0, None)
        return {"models": [{"path": str(out), "images": len(model.images)}], "mapper": mapper}


def _project(root: Path) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    manifest = {
        "schema": "aio.project/1",
        "id": "photo-chain",
        "name": "Photo chain",
        "type": "volumetric",
        "crs": {"epsg": SITE.epsg},
        "origin": list(SITE.origin),
        "captures": [{"id": "c1", "date": "2026-03-14", "label": "14 Mar 2026"}],
        "layers": [],
        "severityModels": [],
        "classCatalogues": [],
    }
    (root / "manifest.json").write_text(json.dumps(manifest, indent=1), "utf-8")
    return root


def _chain(monkeypatch, project: Path, photos: Path, engine=None, preset: str = "standard"):
    # heights stay ellipsoidal like G8's truth, whether or not a geoid grid is installed here
    monkeypatch.setattr(C, "geoid_grid", lambda name: None)
    if engine is not None:
        monkeypatch.setattr(PhotoAlign, "engine_factory", staticmethod(lambda: engine))
    params = {"photos": {"folders": [str(photos)]}, "preset": preset, "run": RUN}
    aligned, _ = run_job(PhotoAlign(), project, params, job_id="align")
    assert aligned["status"] == "done"
    made, _ = run_job(
        PhotoProducts(),
        project,
        {"run": RUN, "products": PRODUCTS, "preset": "standard", "capture": "c1"},
        job_id="products",
    )
    assert made["status"] == "done"
    return made


def _check(project: Path, truth_root: Path, registered_at_least: int, bias_m: float, spread_m: float):
    """The run's files and layers, and the DSM against the truth: ``bias_m`` bounds the median
    height difference, ``spread_m`` the 90th percentile of the differences around it."""
    import rasterio
    from rasterio.warp import Resampling, reproject

    base = project / "photogrammetry" / RUN
    run = json.loads((base / "run.json").read_text("utf-8"))
    assert run["status"] == "done" and run["photos"]["registered"] >= registered_at_least
    rejected = {Path(r["name"]).name for r in run["photos"]["rejected"]}
    assert {"SYN_0060.JPG", "SYN_0062.JPG"} <= rejected  # the copy and the broken photo
    # the layers joined the manifest, their files are there
    manifest = json.loads((project / "manifest.json").read_text("utf-8"))
    by_id = {x["id"]: x for x in manifest["layers"]}
    assert set(by_id) == {f"{RUN}-dsm", f"{RUN}-ortho", f"{RUN}-mesh"}
    assert all(x.get("capture") == "c1" for x in by_id.values())
    for lay in by_id.values():
        assert (project / lay["src"]["path"]).is_file()
    assert set(run["outputs"]["layers"]) == set(by_id)
    for rel in ("report/align.json", "report/accuracy.json", "report/products.json", "cameras-sfm.json"):
        assert json.loads((base / rel).read_text("utf-8"))["schema"].startswith("aio.photo-")
    for name in ("dsm.tif", "ortho.tif"):
        assert (base / name).is_file()
    # the DSM against G8's true surface (both in EPSG:32639, ellipsoidal heights)
    with rasterio.open(base / "dsm.tif") as ds, rasterio.open(truth_root / "truth" / "dsm.tif") as tr:
        ours = ds.read(1, masked=True).filled(np.nan).astype(np.float64)
        true = np.full(ours.shape, np.nan)
        reproject(
            tr.read(1).astype(np.float64),
            true,
            src_transform=tr.transform,
            src_crs=tr.crs,
            src_nodata=tr.nodata,
            dst_transform=ds.transform,
            dst_crs=ds.crs,
            dst_nodata=np.nan,
            resampling=Resampling.bilinear,
        )
        assert ds.crs.to_epsg() == SITE.epsg
    ok = np.isfinite(ours) & np.isfinite(true)
    assert ok.mean() > 0.3, ok.mean()
    diff = (ours - true)[ok]
    bias = float(np.median(diff))
    spread = float(np.percentile(np.abs(diff - bias), 90))
    assert abs(bias) < bias_m and spread < spread_m, (bias, spread)
    return bias, spread


def test_align_then_products_with_the_precomputed_engine(monkeypatch, tmp_path, mini_rtk):
    project = _project(tmp_path / "project")
    engine = PrecomputedEngine(mini_rtk.root / "alignment" / "sparse")
    _chain(monkeypatch, project, mini_rtk.photos, engine)
    # global first; the incremental mapper is tried too because 9 of the 12 usable photos is under 95 %
    assert engine.calls == ["features", "match", "map:global", "map:incremental"]
    gsd = mini_rtk.truth["gsdCm"] / 100  # of the mini set (960 px wide)
    _check(project, mini_rtk.root, registered_at_least=9, bias_m=3 * gsd, spread_m=5 * gsd)
    # cameras where G8 put them: RTK priors (2 cm) through G2's georeferencing
    cams = json.loads((project / "photogrammetry" / RUN / "cameras-sfm.json").read_text("utf-8"))
    truth = {p["name"]: p for p in mini_rtk.truth["photos"]}
    for c in cams["cameras"]:
        x, y, z = c["pos"]  # local frame: x east, y up, z south
        want = np.array(truth[c["photo"]]["centre"]) - np.array(SITE.origin)
        assert np.linalg.norm(np.array([x, -z, y]) - want) < 0.15, c["photo"]


@pytest.mark.skipif(
    not os.environ.get("AIO_COLMAP_PYTHON"), reason="AIO_COLMAP_PYTHON is not set (no COLMAP engine)"
)
def test_align_then_products_with_colmap_and_spaces_in_the_folders(monkeypatch, tmp_path, mini_rtk):
    from aio_pipelines.photo.colmap_io import ColmapEngine
    from aio_pipelines.runtime import JobError

    try:
        ColmapEngine().versions()
    except JobError as e:
        pytest.skip(f"the COLMAP engine does not start: {e}")
    # the photos below folders with spaces, split over two of them (the common folder is above)
    flight = tmp_path / "Mapping Photos" / "DCIM"
    names = sorted(p.name for p in mini_rtk.photos.iterdir())
    for i, name in enumerate(names):
        dest = flight / ("100 MEDIA" if i % 2 else "101 Média ñ") / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(mini_rtk.photos / name, dest)
    project = _project(tmp_path / "project")
    _chain(monkeypatch, project, flight, engine=None, preset="high")
    gsd = mini_rtk.truth["gsdCm"] / 100
    # nine nadir photos from one height, no ground control: the self-calibrated focal length moves
    # every height by the same amount (photo.align warns about it), so the bias is loose here
    _check(project, mini_rtk.root, registered_at_least=8, bias_m=2.5, spread_m=6 * gsd)
