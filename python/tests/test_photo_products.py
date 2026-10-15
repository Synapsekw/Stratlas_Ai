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


@pytest.fixture
def site(tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_ODM_PYTHON", sys.executable)
    monkeypatch.setenv(R.ODM_ENV, str(FAKE))
    monkeypatch.setenv("FAKE_ODM_UDP_PORT", "0")
    monkeypatch.setenv("FAKE_ODM_ARGS_LOG", str(tmp_path / "args.jsonl"))
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
    # ODM's heavy outputs gone after commit, the alignment kept
    assert not (odm / "odm_dem").exists() and not (odm / "odm_orthophoto").exists()
    assert (odm / "opensfm" / "reconstruction.json").is_file()
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


@pytest.mark.parametrize(
    ("products", "dtm", "classify"),
    [
        (["dtm"], True, False),
        (["cloud"], False, True),
        (["cloud", "dtm"], True, False),
        (["ortho", "dsm"], False, False),
    ],
)
def test_terrain_flags_follow_the_products(products, dtm, classify):
    base = OF.products_flags("standard", set(products), False, 4, 5.0, 10.0, None, None)
    args = P.terrain_args(base, products)
    assert ("--dtm" in args) is dtm and ("--pc-classify" in args) is classify
    assert "--dsm" in args


def test_no_dtm_flag_when_no_terrain_is_wanted(site):
    root, log = site
    run_job(P.PhotoProducts(), root, {"run": ps.RUN, "products": ["ortho"], "preset": "standard"})
    assert all("--dtm" not in c and "--pc-classify" not in c for c in _calls(log))


def test_a_failed_ground_classification_does_not_fail_a_job_without_a_dtm(site, monkeypatch):
    root, _ = site
    monkeypatch.setenv("FAKE_ODM_SAY", "odm_georeferencing:Error creating classified file")
    result, _ = run_job(P.PhotoProducts(), root, {"run": ps.RUN, "products": ["ortho"], "preset": "standard"})
    assert result["status"] == "done"


@NO_PDAL
def test_a_cloud_without_a_dtm_is_classified_but_makes_no_dtm(site):
    root, log = site
    result, rec = run_job(
        P.PhotoProducts(), root, {"run": ps.RUN, "products": ["cloud"], "preset": "standard"}
    )
    assert result["status"] == "done"
    calls = _calls(log)
    assert all("--dtm" not in c and "--pc-classify" in c for c in calls)
    assert not any("no ground points" in m["message"] for m in rec.of("log"))


def _step_fractions(rec, step: str) -> list[float]:
    return [
        m["stepFraction"]
        for m in rec.of("progress")
        if m.get("step") == step and m.get("state") not in ("start", "done", "skipped")
    ]


def test_a_step_with_nothing_to_import_ends_at_its_end(site):
    root, _ = site
    _, rec = run_job(P.PhotoProducts(), root, {"run": ps.RUN, "products": ["ortho"], "preset": "standard"})
    assert max(_step_fractions(rec, "dense")) == 1.0


def test_an_unreadable_pdal_answer_keeps_the_dtm(site, monkeypatch, tmp_path):
    from aio_pipelines import pointcloud

    root, _ = site
    pdal = ps.fake_tool(tmp_path / "tools", "pdal", "import time\ntime.sleep(0.3)\nprint('not json')\n")
    monkeypatch.setattr(pointcloud, "find_pdal", lambda: str(pdal))
    result, rec = run_job(P.PhotoProducts(), root, {"run": ps.RUN, "products": ["dtm"], "preset": "standard"})
    assert result["status"] == "done"
    assert any("could not be read" in m["message"] for m in rec.of("log"))
    ids = {x["id"] for x in json.loads((root / "manifest.json").read_text())["layers"]}
    assert f"{ps.RUN}-dtm" in ids
    cloud = _step_fractions(rec, "cloud")
    assert cloud == sorted(cloud)  # the ground check does not move the bar back


def test_a_cancelled_products_job_resumes_where_it_stopped(site, monkeypatch):
    import threading

    from aio_pipelines.runtime import Cancelled

    root, log = site
    cancel = threading.Event()
    real = P.IMPORTS["dsm"]
    first = [True]

    def stop_once(self, ctx, s, odm_dir):
        if first[0]:
            first[0] = False
            cancel.set()
            ctx.check()
        return real(self, ctx, s, odm_dir)

    monkeypatch.setitem(P.IMPORTS, "dsm", stop_once)
    params = {"run": ps.RUN, "products": ["dsm", "dtm"], "preset": "standard"}
    with pytest.raises(Cancelled):
        run_job(P.PhotoProducts(), root, params, cancel=cancel)
    before = len(_calls(log))
    result, _ = run_job(P.PhotoProducts(), root, params, cancel=threading.Event())
    assert result["status"] == "done"
    again = _calls(log)[before:]
    assert [_arg(c, "--end-with") for c in again] == ["odm_dem", "odm_postprocess"]  # earlier steps kept
    assert _arg(again[0], "--rerun-from") == "odm_dem" and "--dtm" in again[0]
    dsm_log = root / "photogrammetry" / ps.RUN / "odm-logs" / "j1-dsm" / "odm.log"
    assert dsm_log.read_text().count("Running odm_dem stage") == 2  # the same log folder, both attempts
    ids = {x["id"] for x in json.loads((root / "manifest.json").read_text())["layers"]}
    assert {f"{ps.RUN}-dsm", f"{ps.RUN}-dtm"} <= ids


def test_a_products_job_begun_by_the_earlier_engine_is_refused_plainly(site, monkeypatch):
    import threading

    from aio_pipelines.runtime import Cancelled

    root, _ = site
    cancel = threading.Event()
    real = P.IMPORTS["dsm"]

    def stop(self, ctx, s, odm_dir):
        cancel.set()
        ctx.check()
        return real(self, ctx, s, odm_dir)

    monkeypatch.setitem(P.IMPORTS, "dsm", stop)
    monkeypatch.setattr(P, "LAYOUT", 2)  # the earlier engine's prepare step
    params = {"run": ps.RUN, "products": ["dsm"], "preset": "standard"}
    with pytest.raises(Cancelled):
        run_job(P.PhotoProducts(), root, params, cancel=cancel)
    monkeypatch.setattr(P, "LAYOUT", 3)
    monkeypatch.setitem(P.IMPORTS, "dsm", real)
    with pytest.raises(JobError) as e:
        run_job(P.PhotoProducts(), root, params, cancel=threading.Event())
    assert str(e.value) == P.OLD_LAYOUT
    assert "Remove it from the Processing list and use Create maps again" in P.OLD_LAYOUT
    # Create maps again starts a new job: it works on the same run
    result, _ = run_job(P.PhotoProducts(), root, params, job_id="j2")
    assert result["status"] == "done"


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


#: UTM zone 39 moved 1 km east: a site grid with no EPSG code
SITE_GRID = "+proj=tmerc +lat_0=0 +lon_0=51 +k=0.9996 +x_0=501000 +y_0=0 +datum=WGS84 +units=m +no_defs"


def _site_grid(root: Path) -> str:
    """The project and the run in ``SITE_GRID`` (as WKT), the origin moved with it."""
    from rasterio.crs import CRS

    wkt = CRS.from_proj4(SITE_GRID).to_wkt()
    assert CRS.from_wkt(wkt).to_epsg() is None
    for rel in ("manifest.json", f"photogrammetry/{ps.RUN}/run.json"):
        doc = json.loads((root / rel).read_text())
        doc["crs"] = {"wkt": wkt}
        if rel == "manifest.json":
            doc["origin"] = [ps.ORIGIN[0] + 1000.0, ps.ORIGIN[1], ps.ORIGIN[2]]
        (root / rel).write_text(json.dumps(doc))
    return wkt


def test_a_project_crs_without_an_epsg_code_gets_its_products(site):
    import rasterio
    from rasterio.crs import CRS

    root, _ = site
    wkt = _site_grid(root)
    result, _ = run_job(
        P.PhotoProducts(), root, {"run": ps.RUN, "products": ["ortho", "dsm", "mesh"], "preset": "standard"}
    )
    assert result["status"] == "done"
    for name in ("dsm.tif", "ortho.tif"):
        with rasterio.open(root / "photogrammetry" / ps.RUN / name) as ds:
            assert ds.crs == CRS.from_wkt(wkt), name
    with rasterio.open(root / "photogrammetry" / ps.RUN / "dsm.tif") as ds:
        z = ds.read(1)
        rows, cols = np.mgrid[ds.height // 4 : 3 * ds.height // 4 : 7, ds.width // 4 : 3 * ds.width // 4 : 7]
        xs, ys = rasterio.transform.xy(ds.transform, rows.ravel(), cols.ravel())
    got = z[rows.ravel(), cols.ravel()]
    want = ps.dsm(np.array(xs) - (ps.ORIGIN[0] + 1000.0), np.array(ys) - ps.ORIGIN[1]) + ps.ORIGIN[2]
    assert (
        float(np.nanmedian(np.abs(got - want))) < 0.2
    )  # reprojected into the site grid, not just relabelled
    assert (root / "models" / f"{ps.RUN}-mesh.glb").is_file()


@NO_PDAL
def test_the_point_cloud_goes_into_a_crs_without_an_epsg_code(site):
    root, _ = site
    _site_grid(root)
    result, _ = run_job(P.PhotoProducts(), root, {"run": ps.RUN, "products": ["cloud"], "preset": "standard"})
    assert result["status"] == "done"
    assert (root / "clouds" / f"{ps.RUN}.copc.laz").is_file()


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
    monkeypatch.setenv("FAKE_ODM_NO_GROUND", "1")  # the real check on a cloud with no class 2
    result, _ = run_job(P.PhotoProducts(), root, {"run": ps.RUN, "products": ["dtm"], "preset": "standard"})
    assert result["status"] == "done"
    ids = {x["id"] for x in json.loads((root / "manifest.json").read_text())["layers"]}
    assert f"{ps.RUN}-dtm" not in ids


def test_a_second_products_job_on_the_same_run_works(site):
    root, log = site
    first, _ = run_job(P.PhotoProducts(), root, {"run": ps.RUN, "products": ["ortho"], "preset": "standard"})
    assert first["status"] == "done"
    # the first job's cleanup must leave what ODM's openmvs and mvs_texturing read (the fake fails without it)
    again, _ = run_job(
        P.PhotoProducts(),
        root,
        {"run": ps.RUN, "products": ["dsm", "mesh"], "preset": "standard"},
        job_id="j2",
    )
    assert again["status"] == "done"
    assert _arg(_calls(log)[-6], "--rerun-from") == "openmvs"
    logs = root / "photogrammetry" / ps.RUN / "odm-logs"
    assert "Undistorting" in (logs / "j1-dense" / "odm.log").read_text()  # the synthetic folder had none
    assert "Undistorting" not in (logs / "j2-dense" / "odm.log").read_text()  # kept by the cleanup
    assert not (root / "photogrammetry" / ps.RUN / "odm" / "opensfm" / "undistorted" / "openmvs").exists()
    ids = {x["id"] for x in json.loads((root / "manifest.json").read_text())["layers"]}
    assert {f"{ps.RUN}-ortho", f"{ps.RUN}-dsm", f"{ps.RUN}-mesh"} <= ids


def test_a_run_without_an_odm_project_is_refused_plainly(site):
    root, _ = site
    import shutil

    shutil.rmtree(root / "photogrammetry" / ps.RUN / "odm")
    with pytest.raises(JobError) as e:
        run_job(P.PhotoProducts(), root, {"run": ps.RUN, "products": ["ortho"]})
    assert str(e.value) == P.OLD_RUN and "Use Create maps again on its photos" in P.OLD_RUN


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
