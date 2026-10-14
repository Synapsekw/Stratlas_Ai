"""photo.products on the fake ODM: ODM's calls per step, the imported layers, the run record."""

import json
import sys
from pathlib import Path

import numpy as np
import pytest

import products_synth as ps
from aio_pipelines.photo import products as P
from aio_pipelines.photo.odm import flags as OF
from aio_pipelines.photo.odm import outputs as OU
from aio_pipelines.photo.odm import runner as R
from aio_pipelines.pointcloud import find_pdal
from aio_pipelines.runtime import JobError
from conftest import run_job

FAKE = Path(__file__).parent / "fake_odm"
NO_PDAL = pytest.mark.skipif(find_pdal() is None, reason="PDAL is not on this machine")
REAL_GROUND_FOUND = getattr(P, "ground_found", None)


@pytest.fixture
def site(tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_ODM_PYTHON", sys.executable)
    monkeypatch.setenv(R.ODM_ENV, str(FAKE))
    monkeypatch.setenv("FAKE_ODM_UDP_PORT", "0")
    monkeypatch.setenv("FAKE_ODM_ARGS_LOG", str(tmp_path / "args.jsonl"))
    # the fake ODM's cloud has no ground class; real ODM classifies ground under --dtm
    monkeypatch.setattr(P, "ground_found", lambda ctx, laz: True)
    root = tmp_path / "p"
    ps.write_project(root, ps.make_scene(step=0.1))
    return root, tmp_path / "args.jsonl"


def _calls(log: Path) -> list[list[str]]:
    return [json.loads(x) for x in log.read_text().splitlines()]


def _arg(call: list[str], flag: str) -> str:
    return call[call.index(flag) + 1]


def test_steps_follow_the_products():
    names = lambda prods: [s.name for s in P.PhotoProducts().plan({"run": "r", "products": prods})]  # noqa: E731
    assert names(["ortho"]) == ["prepare", "dense", "cloud", "dsm", "ortho", "commit"]
    assert names(["mesh", "tiles"]) == [
        "prepare",
        "dense",
        "mesh",
        "texture",
        "cloud",
        "dsm",
        "ortho",
        "commit",
        "tiles",
    ]


def test_dense_is_refused_now():
    with pytest.raises(JobError, match="dense"):
        P.PhotoProducts().validate({"run": "r", "products": ["ortho"], "dense": "cpu"})


def test_ortho_dsm_dtm_and_mesh_become_layers(site):
    root, log = site
    result, _ = run_job(
        P.PhotoProducts(),
        root,
        {"run": ps.RUN, "products": ["ortho", "dsm", "dtm", "mesh"], "preset": "standard"},
    )
    assert result["status"] == "done"
    manifest = json.loads((root / "manifest.json").read_text())
    ids = {x["id"] for x in manifest["layers"]}
    assert {f"{ps.RUN}-ortho", f"{ps.RUN}-dsm", f"{ps.RUN}-dtm", f"{ps.RUN}-mesh"} <= ids
    for rel in (f"rasters/{ps.RUN}-ortho/tiles.json", f"rasters/{ps.RUN}-dsm/tiles.json", f"sources/{ps.RUN}-dsm.json",
                f"models/{ps.RUN}-mesh.glb", f"photogrammetry/{ps.RUN}/dsm.tif", f"photogrammetry/{ps.RUN}/ortho.tif",
                f"photogrammetry/{ps.RUN}/report/odm-report.pdf"):  # fmt: skip
        assert (root / rel).is_file(), rel
    run = json.loads((root / "photogrammetry" / ps.RUN / "run.json").read_text())
    assert run["status"] == "done" and run["engine"]["name"] == "odm" and run["versions"]["odm"] == "3.6.2"
    report = json.loads((root / "photogrammetry" / ps.RUN / "report" / "products.json").read_text())
    assert report["engines"] == {"odm": "3.6.2"}
    odm = root / "photogrammetry" / ps.RUN / "odm"
    assert not (odm / "openmvs").exists() and (odm / "opensfm").is_dir()  # intermediates gone, alignment kept
    calls = _calls(log)
    dense = next(c for c in calls if _arg(c, "--end-with") == "odm_filterpoints")
    assert _arg(dense, "--rerun-from") == "openmvs" and "--skip-3dmodel" not in dense
    assert [_arg(c, "--end-with") for c in calls] == [
        "odm_filterpoints",
        "odm_meshing",
        "mvs_texturing",
        "odm_georeferencing",
        "odm_dem",
        "odm_postprocess",
    ]


def test_every_odm_call_has_the_threads_gpu_and_no_disk_optimising(site):
    root, log = site
    run_job(P.PhotoProducts(), root, {"run": ps.RUN, "products": ["ortho", "dtm"], "preset": "standard"})
    threads = str(R.machine().threads)
    for call in _calls(log):
        assert _arg(call, "--max-concurrency") == threads
        assert ("--no-gpu" in call) != ("--feature-type" in call and _arg(call, "--feature-type") == "sift")
        assert "--optimize-disk-space" not in call
        assert "--dtm" in call and "--dsm" in call
    # a fresh ODM log folder per step
    logs = root / "photogrammetry" / ps.RUN / "odm-logs"
    assert sorted(p.name for p in logs.iterdir()) == ["j1-cloud", "j1-dense", "j1-dsm", "j1-ortho"]


def test_no_dtm_flag_when_no_terrain_is_wanted(site):
    root, log = site
    run_job(P.PhotoProducts(), root, {"run": ps.RUN, "products": ["ortho"], "preset": "standard"})
    assert all("--dtm" not in c for c in _calls(log))


def test_the_dsm_has_the_scenes_heights(site):
    root, _ = site
    run_job(P.PhotoProducts(), root, {"run": ps.RUN, "products": ["dsm"], "preset": "standard"})
    import rasterio

    with rasterio.open(root / "photogrammetry" / ps.RUN / "dsm.tif") as ds:
        z = ds.read(1)
        rows, cols = np.mgrid[ds.height // 4 : 3 * ds.height // 4 : 7, ds.width // 4 : 3 * ds.width // 4 : 7]
        xs, ys = rasterio.transform.xy(ds.transform, rows.ravel(), cols.ravel())
    got = z[rows.ravel(), cols.ravel()]
    want = ps.dsm(np.array(xs) - ps.ORIGIN[0], np.array(ys) - ps.ORIGIN[1]) + ps.ORIGIN[2]
    assert float(np.nanmedian(np.abs(got - want))) < 0.2


def test_fast_and_resolution_flags(site):
    root, log = site
    run_job(P.PhotoProducts(), root, {"run": ps.RUN, "products": ["ortho"], "preset": "fast", "gsdCm": 3.0})
    dense = _calls(log)[0]
    assert _arg(dense, "--rerun-from") == OF.FAST_FIRST_STAGE and "--fast-orthophoto" in dense
    assert _arg(dense, "--orthophoto-resolution") == "3" and _arg(dense, "--dem-resolution") == "6"
    assert "--skip-3dmodel" in dense


def test_fast_leaves_the_3d_model_out(site):
    root, _ = site
    names = [
        s.name
        for s in P.PhotoProducts().plan({"run": ps.RUN, "products": ["ortho", "mesh"], "preset": "fast"})
    ]
    assert "mesh" not in names and "texture" not in names
    result, rec = run_job(
        P.PhotoProducts(), root, {"run": ps.RUN, "products": ["ortho", "mesh"], "preset": "fast"}
    )
    assert result["status"] == "done"
    assert not (root / "models" / f"{ps.RUN}-mesh.glb").exists()
    assert any("makes no 3D model" in m.get("message", "") for m in rec.of("log"))


def test_fast_from_the_run_drops_the_mesh_at_prepare(site):
    root, _ = site
    path = root / "photogrammetry" / ps.RUN / "run.json"
    doc = json.loads(path.read_text())
    path.write_text(json.dumps({**doc, "preset": "fast"}))
    result, rec = run_job(P.PhotoProducts(), root, {"run": ps.RUN, "products": ["ortho", "mesh", "tiles"]})
    assert result["status"] == "done"
    ids = {x["id"] for x in json.loads((root / "manifest.json").read_text())["layers"]}
    assert f"{ps.RUN}-ortho" in ids and f"{ps.RUN}-mesh" not in ids
    assert any("makes no 3D model" in m.get("message", "") for m in rec.of("log"))
    run = json.loads(path.read_text())
    assert run["outputs"]["tilesets"] == []


@NO_PDAL
def test_the_point_cloud_becomes_copc(site):
    root, _ = site
    run_job(P.PhotoProducts(), root, {"run": ps.RUN, "products": ["cloud"], "preset": "standard"})
    layer = next(
        x for x in json.loads((root / "manifest.json").read_text())["layers"] if x["id"] == f"{ps.RUN}-cloud"
    )
    assert layer["format"] == "copc" and layer["pointCount"] > 1000
    assert (root / "clouds" / f"{ps.RUN}.copc.laz").is_file()


def test_no_ground_points_leave_the_dtm_out_with_a_warning(site, monkeypatch):
    root, log = site
    monkeypatch.setattr(P, "ground_found", lambda ctx, laz: False)
    result, rec = run_job(
        P.PhotoProducts(), root, {"run": ps.RUN, "products": ["dsm", "dtm"], "preset": "standard"}
    )
    assert result["status"] == "done"
    ids = {x["id"] for x in json.loads((root / "manifest.json").read_text())["layers"]}
    assert f"{ps.RUN}-dsm" in ids and f"{ps.RUN}-dtm" not in ids
    assert not (root / "photogrammetry" / ps.RUN / "dtm.tif").exists()
    dsm_call = next(c for c in _calls(log) if _arg(c, "--end-with") == "odm_dem")
    assert "--dtm" not in dsm_call
    assert any("no ground points" in m["message"] and m["level"] == "warn" for m in rec.of("log"))
    report = json.loads((root / "photogrammetry" / ps.RUN / "report" / "products.json").read_text())
    assert any("no ground points" in w for w in report["warnings"])


@NO_PDAL
def test_pdal_finds_no_ground_class_in_the_fake_cloud(site, monkeypatch):
    root, _ = site
    monkeypatch.setattr(P, "ground_found", REAL_GROUND_FOUND)  # the real check: the fake classifies nothing
    result, _ = run_job(P.PhotoProducts(), root, {"run": ps.RUN, "products": ["dtm"], "preset": "standard"})
    assert result["status"] == "done"
    ids = {x["id"] for x in json.loads((root / "manifest.json").read_text())["layers"]}
    assert f"{ps.RUN}-dtm" not in ids


def test_a_run_without_an_odm_project_is_refused_plainly(site):
    root, _ = site
    import shutil

    shutil.rmtree(root / "photogrammetry" / ps.RUN / "odm")
    with pytest.raises(JobError, match="use Create maps again"):
        run_job(P.PhotoProducts(), root, {"run": ps.RUN, "products": ["ortho"]})


def test_a_gpu_fallback_is_a_warning_in_the_report(site, monkeypatch):
    root, _ = site
    monkeypatch.setattr(R, "nvcuda_present", lambda env=None: True)
    monkeypatch.setenv("FAKE_ODM_GPU", "dense-fallback")
    result, _ = run_job(P.PhotoProducts(), root, {"run": ps.RUN, "products": ["ortho"], "preset": "standard"})
    assert result["status"] == "done"
    report = json.loads((root / "photogrammetry" / ps.RUN / "report" / "products.json").read_text())
    assert report["gpu"]["dense"] is False and any("CPU" in w for w in report["warnings"])
    # GPU fallbacks are a list under their own key: a PhotoStage's "fallbacks" is a number
    assert result["outputs"]["dense"]["gpuFallbacks"] and "fallbacks" not in result["outputs"]["dense"]
    run = json.loads((root / "photogrammetry" / ps.RUN / "run.json").read_text())
    assert run["engine"]["gpu"]["dense"] is False
    assert all(
        set(s) <= {"name", "state", "startedAt", "finishedAt", "seconds", "memoryPeakBytes"}
        for s in run["stages"]
        if s["name"] != "sfm"
    )


def test_mesh_warnings_go_to_the_job_log(site, monkeypatch):
    root, _ = site
    real = OU.mesh_to_glb

    def with_warning(*a, **kw):
        data, info = real(*a, **kw)
        return data, {**info, "warnings": ["ODM's texture x.png is missing; that part of the model is grey."]}

    monkeypatch.setattr(OU, "mesh_to_glb", with_warning)
    _, rec = run_job(P.PhotoProducts(), root, {"run": ps.RUN, "products": ["mesh"], "preset": "standard"})
    assert any("x.png is missing" in m["message"] and m["level"] == "warn" for m in rec.of("log"))


def test_a_layer_this_run_did_not_make_is_not_replaced(site):
    root, _ = site
    m = json.loads((root / "manifest.json").read_text())
    m["layers"].append({"kind": "raster", "id": f"{ps.RUN}-ortho", "name": "Mine", "src": {"path": "x"}})
    (root / "manifest.json").write_text(json.dumps(m))
    with pytest.raises(JobError, match="rename it first"):
        run_job(P.PhotoProducts(), root, {"run": ps.RUN, "products": ["ortho"]})


def test_mesh_tiles(site):
    root, _ = site
    run_job(P.PhotoProducts(), root, {"run": ps.RUN, "products": ["mesh", "tiles"], "preset": "standard"})
    run = json.loads((root / "photogrammetry" / ps.RUN / "run.json").read_text())
    assert f"{ps.RUN}-mesh" in run["outputs"]["tilesets"]
