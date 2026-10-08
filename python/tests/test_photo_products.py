"""photo.products (G3) as a job: parameters, layers, run.json, the report, resume, cancel, disk,
memory, the PDAL path (with a fake PDAL) and the hand-over to tiles.mesh (G7)."""

from __future__ import annotations

import json
import re
import threading
from collections import namedtuple
from pathlib import Path

import numpy as np
import pytest
import rasterio

import products_synth as ps
from aio_pipelines.photo import native
from aio_pipelines.photo.mesh import meshlab_available
from aio_pipelines.photo.products import PhotoProducts
from aio_pipelines.pipelines import all_pipelines
from aio_pipelines.runtime import Cancelled, Job, JobError
from conftest import Recorder, run_job

STAGE_NAMES = {"inspect", "features", "match", "sfm", "georef", "adjust", "report", "dense", "fuse", "cloud", "dsm",
               "dtm", "ortho", "mesh", "texture", "tiles", "commit"}  # fmt: skip
RUN = ps.RUN


def _params(**kw):
    return {"run": RUN, "products": ["dsm"], **kw}


def test_the_pipeline_is_registered():
    p = all_pipelines()["photo.products"]
    assert isinstance(p, PhotoProducts) and p.title


@pytest.mark.parametrize(
    "params, message",
    [
        ({"run": RUN}, "products must be"),
        ({"run": RUN, "products": []}, "products must be"),
        ({"run": RUN, "products": ["ortho", "photo"]}, "products must be"),
        ({"run": "../x", "products": ["dsm"]}, "run must be"),
        (_params(preset="ultra"), "preset must be"),
        (_params(dense="cuda"), "GPU accelerator"),
        (_params(gsdCm=0), "gsdCm"),
        (_params(meshTriangles=5), "meshTriangles"),
        (_params(region=[[1, 2], [3, 4]]), "region"),
        (_params(colour="red"), "does not take"),
    ],
)
def test_parameters_are_checked(params, message):
    with pytest.raises(JobError, match=message):
        PhotoProducts().validate(params)


def test_products_keep_their_canonical_order():
    out = PhotoProducts().validate(_params(products=["mesh", "dsm", "ortho"], dense="cpu", gsdCm=3))
    assert out["products"] == ["dsm", "ortho", "mesh"] and out["gsdCm"] == 3.0


def test_a_run_that_is_not_there_is_named(tmp_path):
    (tmp_path / "manifest.json").write_text("{}", "utf-8")
    with pytest.raises(JobError, match='no run "20261007-0915"'):
        run_job(PhotoProducts(), tmp_path, _params())


# ---------------------------------------------------------------------------------- the full job


@pytest.fixture(scope="module")
def processed():
    return ps.processed()


def test_the_layers_join_the_manifest(processed):
    root, res, _ = processed
    manifest = json.loads((root / "manifest.json").read_text("utf-8"))
    by_id = {x["id"]: x for x in manifest["layers"]}
    assert set(by_id) == {f"{RUN}-ortho", f"{RUN}-dsm", f"{RUN}-dtm", f"{RUN}-mesh"}
    o = by_id[f"{RUN}-ortho"]
    assert (o["kind"], o["role"], o["format"]) == ("raster", "ortho", "kit-pyramid")
    assert o["src"] == {"path": f"rasters/{RUN}-ortho/tiles.json"} and o["capture"] == "c1"
    assert by_id[f"{RUN}-dtm"]["role"] == "dsm" and by_id[f"{RUN}-dsm"]["role"] == "dsm"
    m = by_id[f"{RUN}-mesh"]
    assert m["kind"] == "mesh" and m["transform"] == [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    for lay in manifest["layers"]:
        assert (root / lay["src"]["path"]).is_file()
        assert "derived" not in lay  # no new LayerDerived kind (0.9 compatibility)
    assert (root / "manifest.json.bak").is_file()
    # the photos are read, never written: only the run folder and new files changed
    assert sorted(p.name for p in (root / "photos-in").iterdir()) == [v.name for v in ps.scene().views]


def test_run_json_lists_what_the_run_made(processed):
    root, _, _ = processed
    doc = json.loads((root / "photogrammetry" / RUN / "run.json").read_text("utf-8"))
    assert doc["schema"] == "aio.photo-run/1" and doc["status"] == "done"
    assert set(doc["outputs"]["layers"]) == {f"{RUN}-ortho", f"{RUN}-dsm", f"{RUN}-dtm", f"{RUN}-mesh"}
    for f in doc["outputs"]["files"]:
        assert not re.match(r"^([A-Za-z]:|/)", f) and ".." not in f.split("/")
        assert (root / f).is_file(), f
    names = [s["name"] for s in doc["stages"]]
    assert set(names) <= STAGE_NAMES
    assert names[0] == "sfm"  # alignment's own stages are kept
    for s in ("dense", "fuse", "dsm", "dtm", "ortho", "mesh", "texture", "commit", "tiles"):
        assert s in names
    assert all(
        s["state"] in ("pending", "running", "done", "skipped", "failed", "cancelled") for s in doc["stages"]
    )
    dense = next(s for s in doc["stages"] if s["name"] == "dense")
    assert dense["seconds"] > 0 and dense["memoryPeakBytes"] > 0
    assert doc["capture"] == "c1" and doc["versions"]["pack"]
    assert all(isinstance(v, str) and len(v) <= 80 for v in doc["versions"].values())


def test_the_products_report(processed):
    root, _, _ = processed
    r = json.loads((root / "photogrammetry" / RUN / "report" / "products.json").read_text("utf-8"))
    assert r["run"] == RUN and r["preset"] == "high"
    assert r["gsdCm"]["photos"] == pytest.approx(ps.GSD * 100, rel=0.05)
    assert r["gsdCm"]["dsm"] == pytest.approx(2 * r["gsdCm"]["ortho"])
    assert r["engines"]["dense"] in ("sgm-numpy", "sgm-opencv") and r["engines"]["ground"] == "smrf-grid"
    assert r["cloud"]["points"] > 100_000 and r["coverage"]["ortho"] > 0.5
    assert r["memoryPeakBytes"] > 0 and r["disk"]["neededBytes"] > 0


TILESET_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")  # TilesetId (tilesets.ts)


def test_the_full_mesh_becomes_3d_tiles_listed_in_tilesets_json(processed):
    from aio_pipelines.tiles.tileset import check_tileset

    root, res, _ = processed
    assert res["status"] == "done"
    tiles = res["outputs"]["tiles"]
    assert tiles["ok"] is True and tiles["tileset"] == f"{RUN}-mesh"
    doc = json.loads((root / "photogrammetry" / RUN / "run.json").read_text("utf-8"))
    assert doc["outputs"]["tilesets"] == [f"{RUN}-mesh"]
    assert next(s for s in doc["stages"] if s["name"] == "tiles")["state"] == "done"
    assert not any("3D Tiles were not made" in w for w in doc.get("warnings") or [])
    ts = json.loads((root / "tilesets.json").read_text("utf-8"))
    assert ts["schema"] == "aio.tilesets/1" and len(ts["entries"]) == 1
    entry = ts["entries"][0]
    # TilesetEntry (packages/schema/src/tilesets.ts): what the app reads
    assert entry == {
        "id": f"{RUN}-mesh",
        "name": f"Mesh {RUN}",
        "kind": "mesh",
        "src": f"tiles/{RUN}-mesh/tileset.json",
        "run": RUN,
        "visible": True,
    }
    assert TILESET_ID.match(entry["id"]) and 1 <= len(entry["name"]) <= 200
    assert not re.match(r"^([A-Za-z]:|/)", entry["src"]) and ".." not in entry["src"].split("/")
    assert (root / entry["src"]).is_file()
    assert check_tileset((root / entry["src"]).parent) == []
    assert (root / "photogrammetry" / RUN / "mesh" / "full.glb").is_file()


def test_tiles_that_fail_are_a_warning_not_a_failure(monkeypatch):
    import aio_pipelines.tiles.mesh as tiles_mesh
    from aio_pipelines.runtime import Step

    class BrokenTilesMesh:
        name, title, description = "tiles.mesh", "Mesh to 3D Tiles", "fails"

        def validate(self, params):
            return params

        def plan(self, params):
            def fail(ctx):
                raise JobError("the tiler is not in this pack")

            return [Step("tile", "Tile", fail)]

    monkeypatch.setattr(tiles_mesh, "TilesMesh", BrokenTilesMesh)
    root = ps.project("tiles-fail")
    res, _ = run_job(PhotoProducts(), root, _params(preset="fast", products=["mesh", "tiles"]))
    assert res["status"] == "done" and res["outputs"]["tiles"]["ok"] is False
    doc = json.loads((root / "photogrammetry" / RUN / "run.json").read_text("utf-8"))
    assert any("3D Tiles were not made: the tiler is not in this pack" in w for w in doc["warnings"])
    assert next(s for s in doc["stages"] if s["name"] == "tiles")["state"] == "failed"
    assert doc["outputs"]["tilesets"] == []
    assert (root / "photogrammetry" / RUN / "mesh" / "full.glb").is_file()
    assert (root / "models" / f"{RUN}-mesh.glb").is_file()  # the products stay
    assert not (root / "tilesets.json").exists()


def test_the_products_report_carries_its_schema(processed):
    root, _, _ = processed
    r = json.loads((root / "photogrammetry" / RUN / "report" / "products.json").read_text("utf-8"))
    assert r["schema"] == "aio.photo-products/1"


def test_the_dense_cloud_meets_the_targets(processed):
    root, _, _ = processed
    from aio_pipelines.photo.fuse import PointTiles

    work = next((root / "photogrammetry" / RUN / "work" / "products").iterdir())
    store = PointTiles(work / "cloud", 1.0)
    # the cloud tiles are in the run's grid frame: the project CRS minus the run's origin (here
    # the manifest origin), so local coordinates already
    xyz = np.concatenate([p["xyz"] for _, p in store.fused()])
    x, y, h = xyz.T
    inner = (np.abs(x) < 22) & (np.abs(y) < 16) & ~ps.in_box(x + 0.3, y) & ~ps.in_box(x - 0.3, y)
    err = np.abs(h - ps.dsm(x, y))[inner]
    assert np.mean(err < 3 * ps.GSD) > 0.95
    # completeness: cells of 2 x GSD in the inner area that hold a point
    cell = 2 * ps.GSD
    cx, cy = np.floor((x[inner] + 22) / cell).astype(int), np.floor((y[inner] + 16) / cell).astype(int)
    filled = len(set(zip(cx.tolist(), cy.tolist(), strict=True)))
    assert filled / (int(44 / cell) * int(32 / cell)) > 0.9


# ------------------------------------------------------------------------- resume, cancel, limits


def test_resume_after_a_cancel_in_dense_continues_at_the_next_photo(monkeypatch):
    root = ps.project("resume")
    cancel = threading.Event()
    seen: list = []

    def emit(m, p):
        seen.append((m, p))
        if m == "progress" and str(p.get("message", "")).startswith("Depth map 4 of"):
            cancel.set()

    params = {"run": RUN, "products": ["dsm"], "preset": "standard"}
    with pytest.raises(Cancelled):
        Job("r1", PhotoProducts(), root, params, emit, cancel).run()
    job = json.loads((root / "jobs" / "r1" / "job.json").read_text("utf-8"))
    assert job["status"] == "cancelled"
    assert not (root / "rasters").exists()  # nothing committed
    res = Job("r1", PhotoProducts(), root, params, Recorder(), threading.Event()).run()
    assert res["status"] == "done" and res["outputs"]["dense"]["resumed"] >= 4


def test_changed_alignment_refuses_the_resume():
    root = ps.project("refuse")
    cancel = threading.Event()

    def emit(m, p):
        if m == "progress" and p.get("step") == "dense":
            cancel.set()

    params = {"run": RUN, "products": ["dsm"], "preset": "standard"}
    with pytest.raises(Cancelled):
        Job("x1", PhotoProducts(), root, params, emit, cancel).run()
    imgs = root / "photogrammetry" / RUN / "sparse" / "images.txt"
    imgs.write_text(imgs.read_text("utf-8") + "\n", "utf-8")
    with pytest.raises(JobError, match="changed since this job started"):
        Job("x1", PhotoProducts(), root, params, Recorder(), threading.Event()).run()


def test_too_little_disk_is_refused_with_both_numbers(monkeypatch):
    root = ps.project("disk")
    usage = namedtuple("usage", "total used free")
    monkeypatch.setattr(native.shutil, "disk_usage", lambda p: usage(10**9, 10**9, 5 * 1024**2))
    with pytest.raises(JobError, match=r"needs .* free on .*, which has 5 MB"):
        run_job(PhotoProducts(), root, _params(preset="fast"))


def test_a_small_memory_cap_still_finishes(monkeypatch):
    monkeypatch.setenv("AIO_PHOTO_MEMORY_MB", "64")
    root = ps.project("memory")
    res, _ = run_job(PhotoProducts(), root, _params(preset="standard", products=["dsm", "ortho"]))
    assert res["status"] == "done"
    r = json.loads((root / "photogrammetry" / RUN / "report" / "products.json").read_text("utf-8"))
    assert r["memoryBudgetBytes"] == 64 * 1024**2


# -------------------------------------------------------------------------------- fast preset


def test_fast_works_from_the_sparse_points_and_the_frame_origin_is_applied():
    a = ps.project("fast-a")
    b = ps.project("fast-b", frame_origin=(412000.0, 3245000.0, 0.0))
    for root in (a, b):
        res, _ = run_job(PhotoProducts(), root, _params(preset="fast", products=["dsm", "ortho", "mesh"]))
        assert res["outputs"]["dense"]["engine"] == "sparse"
    za = rasterio.open(a / "photogrammetry" / RUN / "dsm.tif").read(1, masked=True)
    zb = rasterio.open(b / "photogrammetry" / RUN / "dsm.tif").read(1, masked=True)
    assert za.shape == zb.shape and np.allclose(za.filled(0), zb.filled(0), atol=1e-3)
    o = np.array(ps.ORIGIN)
    with rasterio.open(a / "photogrammetry" / RUN / "dsm.tif") as ds:
        z = ds.read(1, masked=True).filled(np.nan)
        t = ds.transform
    rows, cols = np.mgrid[0 : z.shape[0], 0 : z.shape[1]]
    x, y = t.c + (cols + 0.5) * t.a - o[0], t.f + (rows + 0.5) * t.e - o[1]
    flat = (
        (np.abs(x) < 20)
        & (np.abs(y) < 15)
        & ~ps.in_box(x, y)
        & (np.hypot(x - ps.PILE[0], y - ps.PILE[1]) > 9)
    )
    flat &= ~ps.in_box(x + 2, y + 2) & ~ps.in_box(x - 2, y - 2)
    assert np.nanmedian(np.abs(z - (ps.dsm(x, y) + o[2]))[flat]) < 0.3
    report = json.loads((a / "photogrammetry" / RUN / "report" / "products.json").read_text("utf-8"))
    assert report["engines"]["mesh"] == "grid-25d" and report["cloud"]["source"] == "sparse"


def test_a_region_limits_the_products():
    from rasterio.warp import transform

    root = ps.project("region")
    o = np.array(ps.ORIGIN)
    xs = [o[0] - 20, o[0], o[0], o[0] - 20]
    ys = [o[1] - 10, o[1] - 10, o[1] + 10, o[1] + 10]
    lon, lat = transform(f"EPSG:{ps.EPSG}", "EPSG:4326", xs, ys)
    ring = [[a, b] for a, b in zip(lon, lat, strict=True)]
    run_job(PhotoProducts(), root, _params(preset="fast", region=ring))
    with rasterio.open(root / "photogrammetry" / RUN / "dsm.tif") as ds:
        b = ds.bounds
    assert b.left >= o[0] - 21 and b.right <= o[0] + 1 and b.bottom >= o[1] - 11 and b.top <= o[1] + 11
    doc = json.loads((root / "photogrammetry" / RUN / "run.json").read_text("utf-8"))
    assert doc["region"] == ring


def test_a_missing_photo_is_named_before_any_work():
    root = ps.project("missing")
    (root / "photos-in" / "IMG_0007.jpg").unlink()
    with pytest.raises(JobError, match=r"IMG_0007\.jpg cannot be found where the run says"):
        run_job(PhotoProducts(), root, _params(preset="fast"))
    assert not (root / "photogrammetry" / RUN / "work").exists()


def test_tiles_alone_make_the_full_mesh_but_no_mesh_layer():
    root = ps.project("tiles-only")
    res, _ = run_job(PhotoProducts(), root, _params(preset="fast", products=["tiles"]))
    assert (root / "photogrammetry" / RUN / "mesh" / "full.glb").is_file()
    assert not (root / "models").exists()
    assert json.loads((root / "manifest.json").read_text("utf-8"))["layers"] == []
    assert res["outputs"]["texture"]["engine"] == "views"  # no ortho to drape


def test_a_layer_of_the_same_id_the_run_did_not_make_is_refused():
    root = ps.project("foreign")
    m = json.loads((root / "manifest.json").read_text("utf-8"))
    m["layers"].append({"kind": "raster", "id": f"{RUN}-dsm", "name": "Delivered DSM", "visible": True,
                        "src": {"path": "rasters/delivered.png"}, "role": "dsm", "format": "image"})  # fmt: skip
    (root / "manifest.json").write_text(json.dumps(m), "utf-8")
    with pytest.raises(JobError, match="this run did not make; rename it first"):
        run_job(PhotoProducts(), root, _params(preset="fast"))
    after = json.loads((root / "manifest.json").read_text("utf-8"))
    assert after["layers"][0]["name"] == "Delivered DSM"


def test_running_again_replaces_the_runs_own_layers():
    root = ps.project("again")
    run_job(PhotoProducts(), root, _params(preset="fast"), job_id="a1")
    m = json.loads((root / "manifest.json").read_text("utf-8"))
    m["layers"][0]["visible"] = False
    (root / "manifest.json").write_text(json.dumps(m), "utf-8")
    run_job(PhotoProducts(), root, _params(preset="fast", gsdCm=15), job_id="a2")
    after = json.loads((root / "manifest.json").read_text("utf-8"))
    assert [x["id"] for x in after["layers"]] == [f"{RUN}-dsm"] and after["layers"][0]["visible"] is False
    idx = json.loads((root / "rasters" / f"{RUN}-dsm" / "tiles.json").read_text("utf-8"))
    assert idx["metresPerPx"][-1] == pytest.approx(0.30, abs=0.001)


# ------------------------------------------------------------------------------- meshing engines

FAKE_POISSON = r"""
import sys, numpy as np
sys.path.insert(0, {src!r})
from pathlib import Path
from scipy.spatial import Delaunay
from aio_pipelines.photo.mesh import Mesh
from aio_pipelines.photo.texture import write_ply_mesh
args = sys.argv[1:]
data = Path(args[args.index("--in") + 1]).read_bytes()
head, body = data.split(b"end_header\n", 1)
n = int([l for l in head.decode().splitlines() if l.startswith("element vertex")][0].split()[2])
rec = np.frombuffer(body, dtype=[("p", "<f4", 3), ("n", "<f4", 3), ("c", "u1", 3)], count=n)
p = rec["p"].astype(float)[:: max(1, n // 20000)]
write_ply_mesh(Path(args[args.index("--out") + 1]), Mesh(p, Delaunay(p[:, :2]).simplices))
"""


def test_with_poissonrecon_the_dense_cloud_is_meshed_and_textured_from_the_photos(tmp_path, monkeypatch):
    import aio_pipelines

    src = str(Path(aio_pipelines.__file__).parents[1])
    monkeypatch.setenv(
        "AIO_POISSONRECON",
        str(ps.fake_tool(tmp_path, "PoissonRecon", FAKE_POISSON.replace("{src!r}", repr(src)))),
    )
    monkeypatch.setenv("AIO_SURFACETRIMMER", str(tmp_path / "none.exe"))
    root = ps.project("poisson")
    res, _ = run_job(
        PhotoProducts(), root, _params(preset="standard", products=["mesh"], meshTriangles=10_000)
    )
    assert res["outputs"]["mesh"]["engine"] == "poissonrecon"
    assert res["outputs"]["texture"]["engine"] == "views" and res["outputs"]["texture"]["triangles"] <= 10_000
    work = next((root / "photogrammetry" / RUN / "work" / "products").iterdir())
    head = (work / "poisson" / "dense.ply").read_bytes()[:400].decode("ascii", errors="replace")
    assert f"element vertex {res['outputs']['fuse']['points']}" in head


def test_oblique_runs_without_screened_poisson_use_the_built_in_solver(monkeypatch):
    import aio_pipelines.photo.mesh as mesh_mod

    monkeypatch.setattr(mesh_mod, "nadir_share", lambda views, limit_deg=20.0: 0.0)
    monkeypatch.setenv("AIO_POISSONRECON", "")
    monkeypatch.setenv("AIO_PYMESHLAB", "0")
    monkeypatch.setattr(native, "find_tool", lambda name: None)
    monkeypatch.setenv("AIO_PHOTO_MEMORY_MB", "512")
    root = ps.project("fft")
    res, _ = run_job(
        PhotoProducts(), root, _params(preset="standard", products=["mesh"], meshTriangles=20_000)
    )
    assert res["outputs"]["mesh"]["engine"] == "poisson-fft" and res["outputs"]["mesh"]["triangles"] > 1000
    doc = json.loads((root / "photogrammetry" / RUN / "run.json").read_text("utf-8"))
    assert any("built-in Poisson solver" in w for w in doc["warnings"])


def test_a_failed_screened_poisson_falls_back_to_the_built_in_solver(monkeypatch):
    import aio_pipelines.photo.mesh as mesh_mod

    monkeypatch.setattr(mesh_mod, "nadir_share", lambda views, limit_deg=20.0: 0.0)
    monkeypatch.setattr(mesh_mod, "poisson_engine", lambda: "meshlab")

    def crash(*a, **k):
        raise JobError("Poisson meshing failed: Failed to close loop")

    monkeypatch.setattr(mesh_mod, "poisson_mesh", crash)
    monkeypatch.setenv("AIO_PHOTO_MEMORY_MB", "512")
    root = ps.project("fallback")
    res, _ = run_job(
        PhotoProducts(), root, _params(preset="standard", products=["mesh"], meshTriangles=20_000)
    )
    assert res["outputs"]["mesh"]["engine"] == "poisson-fft" and res["outputs"]["mesh"]["triangles"] > 1000


@pytest.mark.skipif(not meshlab_available(), reason="pymeshlab is not installed")
def test_oblique_runs_mesh_with_meshlab(monkeypatch):
    import aio_pipelines.photo.mesh as mesh_mod

    monkeypatch.setattr(mesh_mod, "nadir_share", lambda views, limit_deg=20.0: 0.0)
    monkeypatch.delenv("AIO_POISSONRECON", raising=False)
    root = ps.project("meshlab")
    res, _ = run_job(
        PhotoProducts(), root, _params(preset="standard", products=["mesh"], meshTriangles=20_000)
    )
    assert res["outputs"]["mesh"]["engine"] == "meshlab-poisson"
    assert res["outputs"]["mesh"]["triangles"] > 1000


# ------------------------------------------------------------------------------- tiles (G7) hand-over


def test_the_full_mesh_goes_to_tiles_mesh(monkeypatch):
    import aio_pipelines.tiles.mesh as tiles_mesh
    from aio_pipelines.runtime import Step

    calls: list = []

    class FakeTilesMesh:
        name, title, description = "tiles.mesh", "Mesh to 3D Tiles", "fake"

        def validate(self, params):
            calls.append(params)
            return params

        def plan(self, params):
            def write(ctx):
                ctx.progress(0.5, "Tiling")
                assert ctx.input(params["src"]).is_file()
                return {"tileset": params["id"]}

            return [Step("tile", "Tile", write)]

    monkeypatch.setattr(tiles_mesh, "TilesMesh", FakeTilesMesh)
    root = ps.project("tiles")
    res, rec = run_job(PhotoProducts(), root, _params(preset="fast", products=["mesh", "tiles"]))
    assert res["outputs"]["tiles"] == {
        "ok": True,
        "tileset": f"{RUN}-mesh",
        **{"_stage": res["outputs"]["tiles"]["_stage"]},
    }
    assert calls[0] == {
        "src": f"photogrammetry/{RUN}/mesh/full.glb",
        "run": RUN,
        "id": f"{RUN}-mesh",
        "name": f"Mesh {RUN}",
    }
    doc = json.loads((root / "photogrammetry" / RUN / "run.json").read_text("utf-8"))
    assert doc["outputs"]["tilesets"] == [f"{RUN}-mesh"]
    # the nested job's progress reaches this job's tiles step
    assert any(
        p.get("step") == "tiles" and p.get("message") == "Tiling" for m, p in rec.messages if m == "progress"
    )


# ------------------------------------------------------------------------------ PDAL (fake)

FAKE_PDAL = r"""
import json, shutil, sys
sys.path.insert(0, {src!r})
args = sys.argv[1:]
assert args[0] == "pipeline", args
stages = json.load(open(args[1]))["pipeline"]
types = [s["type"] for s in stages]
open(args[1] + ".seen", "w").write(" ".join(types))
src = stages[0]["filename"]
out = stages[-1]
if out["type"] == "writers.copc":
    assert "filters.smrf" in types
    shutil.copyfile(src, out["filename"])
elif out["type"] == "writers.gdal":
    import numpy as np, rasterio
    from rasterio.transform import from_origin
    from aio_pipelines.change.las import read_las
    las = read_las(__import__("pathlib").Path(src))
    xyz = las.xyz
    res = float(out["resolution"])
    x0, y1 = xyz[:, 0].min(), xyz[:, 1].max()
    w = int((xyz[:, 0].max() - x0) / res) + 1
    h = int((y1 - xyz[:, 1].min()) / res) + 1
    z = np.full(h * w, np.inf)
    ci = ((xyz[:, 0] - x0) / res).astype(int)
    ri = ((y1 - xyz[:, 1]) / res).astype(int)
    np.minimum.at(z, ri * w + ci, xyz[:, 2])
    z = np.where(np.isinf(z), -9999, z).reshape(h, w).astype("float32")
    with rasterio.open(out["filename"], "w", driver="GTiff", width=w, height=h, count=1, dtype="float32",
                       transform=from_origin(x0, y1, res, res), nodata=-9999, crs="EPSG:32639") as ds:
        ds.write(z, 1)
"""


def test_the_cloud_and_dtm_go_through_pdal(tmp_path, monkeypatch):
    import aio_pipelines

    src = str(Path(aio_pipelines.__file__).parents[1])
    exe = ps.fake_tool(tmp_path / "tools", "pdal", FAKE_PDAL.replace("{src!r}", repr(src)))
    monkeypatch.setenv("AIO_PDAL", str(exe))
    root = ps.project("pdal")
    res, _ = run_job(PhotoProducts(), root, _params(preset="fast", products=["cloud", "dsm", "dtm"]))
    manifest = json.loads((root / "manifest.json").read_text("utf-8"))
    cloud = next(x for x in manifest["layers"] if x["kind"] == "pointcloud")
    assert cloud == {
        "kind": "pointcloud",
        "id": f"{RUN}-cloud",
        "name": f"Point cloud {RUN}",
        "visible": True,
        "src": {"path": f"clouds/{RUN}.copc.laz"},
        "format": "copc",
        "pointCount": res["outputs"]["cloud"]["points"],
    }
    assert (root / "clouds" / f"{RUN}.copc.laz").is_file()
    assert res["outputs"]["dtm"]["engine"] == "pdal-smrf"
    work = next((root / "photogrammetry" / RUN / "work" / "products").iterdir())
    seen = (work / "dtm-pipeline.json.seen").read_text()
    assert seen == "readers.las filters.assign filters.smrf filters.range writers.gdal"
    with rasterio.open(root / "photogrammetry" / RUN / "dtm.tif") as ds:
        assert (
            ds.crs.to_epsg() == ps.EPSG and np.isfinite(ds.read(1, masked=True).filled(np.nan)).mean() > 0.5
        )


def test_a_cloud_without_pdal_is_refused_before_any_work(monkeypatch, tmp_path):
    monkeypatch.setenv("AIO_PDAL", str(tmp_path / "missing.exe"))
    monkeypatch.setattr("aio_pipelines.pointcloud.shutil.which", lambda name: None)
    monkeypatch.setattr("aio_pipelines.pointcloud.sys.prefix", str(tmp_path / "venv"))
    root = ps.project("nopdal")
    with pytest.raises(JobError, match="needs PDAL"):
        run_job(PhotoProducts(), root, _params(products=["cloud"]))
    assert not (root / "photogrammetry" / RUN / "work").exists()
