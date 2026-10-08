"""opf.import and opf.export (M10 stream G5) on synthetic OPF projects and the OPF spec examples.

No client data: ``opf_synth.py`` makes a fictional site in UTM 39N; the specification examples
(CC-BY-4.0, Pix4D) are in ``fixtures/opf-spec-examples`` with their attribution.
"""

from __future__ import annotations

import importlib.util
import json
import math
import struct
from pathlib import Path

import numpy as np
import pytest

import opf_synth
from aio_pipelines.opf import colmap
from aio_pipelines.opf.exporter import OpfExport
from aio_pipelines.opf.geometry import (
    SceneFrame,
    colmap_to_opf,
    lens_from_colmap,
    lens_to_colmap,
    matrix_to_quat_wxyz,
    north_first,
    opf_to_colmap,
    opk_angles,
    opk_matrix,
    quat_wxyz_to_matrix,
    read_crs,
)
from aio_pipelines.opf.importer import OpfImport
from aio_pipelines.pointcloud import find_pdal
from aio_pipelines.runtime import JobError
from conftest import run_job

SPEC = Path(__file__).parent / "fixtures" / "opf-spec-examples" / "project.opf"
RUN = "20261007-0900"
needs_pdal = pytest.mark.skipif(find_pdal() is None, reason="PDAL not found (set AIO_PDAL)")


def _no_pdal(monkeypatch):
    import aio_pipelines.pointcloud as pc

    monkeypatch.setattr(pc, "find_pdal", lambda: None)


def _import(project: Path, params: dict, job_id: str = "j1"):
    res, rec = run_job(OpfImport(), project, params, job_id=job_id)
    return res["outputs"]["commit"], rec


def _manifest(project: Path) -> dict:
    return json.loads((project / "manifest.json").read_text("utf-8"))


# ---------------------------------------------------------------- licence and dependencies


def test_pyopf_core_without_the_gpl_extra():
    """pyopf's ``tools`` extra pulls plyfile (GPL-3.0): never installed (plan, licence policy)."""
    assert importlib.util.find_spec("pyopf") is not None
    for gpl_or_extra in ("plyfile", "tqdm", "laspy"):
        assert importlib.util.find_spec(gpl_or_extra) is None, gpl_or_extra


# ---------------------------------------------------------------- geometry


def test_omega_phi_kappa_and_quaternions_round_trip():
    rng = np.random.default_rng(3)
    for _ in range(50):
        angles = [rng.uniform(-170, 170), rng.uniform(-80, 80), rng.uniform(-170, 170)]
        r = opk_matrix(angles)
        assert np.allclose(opk_matrix(opk_angles(r)), r, atol=1e-12)
        assert np.allclose(quat_wxyz_to_matrix(matrix_to_quat_wxyz(r)), r, atol=1e-12)
        centre = rng.uniform(-1e6, 1e6, 3)
        q, t = opf_to_colmap(r, centre)
        r2, c2 = colmap_to_opf(q, t)
        assert np.allclose(r2, r, atol=1e-12)
        assert np.allclose(c2, centre, atol=1e-6)


def test_a_nadir_camera_looks_down_with_image_top_north():
    """OPF identity orientation: image right = east, top = north, back = up, so the view is down."""
    r = opk_matrix([0, 0, 0])
    q, _ = opf_to_colmap(r, [0, 0, 0])
    r_cw = quat_wxyz_to_matrix(q)
    # COLMAP camera z (front) in world = third row of r_cw
    assert np.allclose(r_cw[2], [0, 0, -1])
    assert np.allclose(r_cw[1], [0, -1, 0])  # image down = south


def test_colmap_and_opf_lenses():
    lens, notes = lens_from_colmap("OPENCV", 640, 480, [500, 500, 320, 240, -0.1, 0.01, 0.001, -0.002])
    assert notes == []
    assert lens.radial == (-0.1, 0.01, 0.0) and lens.tangential == (0.001, -0.002)
    assert lens_to_colmap(lens) == ("OPENCV", [500, 500, 320, 240, -0.1, 0.01, 0.001, -0.002])
    lens.radial = (-0.1, 0.01, 0.003)
    model, params = lens_to_colmap(lens)
    assert model == "FULL_OPENCV" and params[8] == 0.003
    _, notes = lens_from_colmap("PINHOLE", 640, 480, [500, 502, 320, 240])
    assert "differ" in notes[0]
    with pytest.raises(JobError, match="no OPF perspective equivalent"):
        lens_from_colmap("OPENCV_FISHEYE", 640, 480, [1] * 8)
    assert lens.pinhole()["hfovDeg"] == pytest.approx(math.degrees(2 * math.atan(640 / 1000)), abs=1e-5)


def test_crs_definitions():
    assert read_crs("EPSG:32639").horizontal.to_epsg() == 32639
    c = read_crs("EPSG:4326+5773")
    assert c.horizontal.to_epsg() == 4326 and c.vertical == "EPSG:5773"
    assert read_crs("EPSG:4265+EPSG:5214").vertical == "EPSG:5214"
    assert read_crs('ENGINEERINGCRS["Construction site",EDATUM["x"]]').arbitrary
    assert read_crs("not a crs").arbitrary
    assert north_first(read_crs("EPSG:4326").horizontal)
    assert not north_first(read_crs("EPSG:32639").horizontal)


def test_a_frame_in_another_crs_reprojects_and_turns_the_camera_axes():
    from types import SimpleNamespace

    from rasterio.crs import CRS
    from rasterio.warp import transform

    project = CRS.from_epsg(32639)
    # an OPF processed in UTM 38N (the neighbouring zone): grid north differs by the convergence
    e38, n38 = transform(project, CRS.from_epsg(32638), [500100.0], [3200200.0])
    srf = SimpleNamespace(
        crs=SimpleNamespace(definition="EPSG:32638"),
        base_to_canonical=SimpleNamespace(shift=[-e38[0], -n38[0], 0], scale=[1, 1, 1], swap_xy=False),
    )
    f = SceneFrame(srf, project, [500000, 3200000, 0])
    assert not f.same and not f.arbitrary
    enh = f.to_project([[0.0, 0.0, 12.5]])[0]
    assert enh == pytest.approx([500100.0, 3200200.0, 12.5], abs=1e-3)
    axes = f.axes_at([0.0, 0.0, 12.5])
    assert np.allclose(axes @ axes.T, np.eye(3), atol=1e-9)
    assert np.allclose(axes[:, 2], [0, 0, 1], atol=1e-6)  # up stays up
    turn = math.degrees(math.atan2(axes[1, 0], axes[0, 0]))
    assert 2.0 < abs(turn) < 4.0  # about 3 degrees of grid convergence between the zones
    # a north-first base CRS with swap_xy (lat, lon processed as an isometric frame) still lands right
    lon, lat = transform(project, CRS.from_epsg(4326), [500100.0], [3200200.0])
    geo = SimpleNamespace(
        crs=SimpleNamespace(definition="EPSG:4326"),
        base_to_canonical=SimpleNamespace(shift=[-lon[0], -lat[0], 0], scale=[1, 1, 1], swap_xy=True),
    )
    g = SceneFrame(geo, project, [500000, 3200000, 0])
    assert g.to_project([[0.0, 0.0, 3.0]])[0] == pytest.approx([500100.0, 3200200.0, 3.0], abs=1e-3)


def test_colmap_binary_and_text_models_read_the_same(tmp_path):
    proj = opf_synth.make_project(tmp_path / "p")
    opf_synth.make_run(proj, tmp_path / "photos")
    text = colmap.read_model(proj / "photogrammetry" / RUN / "sparse")
    b = tmp_path / "bin"
    b.mkdir()
    with open(b / "cameras.bin", "wb") as f:
        f.write(struct.pack("<Q", len(text.cameras)))
        for c in text.cameras.values():
            f.write(struct.pack("<iiQQ", c.id, 4, c.width, c.height))
            f.write(struct.pack(f"<{len(c.params)}d", *c.params))
    with open(b / "images.bin", "wb") as f:
        f.write(struct.pack("<Q", len(text.images)))
        for im in text.images.values():
            f.write(struct.pack("<idddddddi", im.id, *im.qvec, *im.tvec, im.camera_id))
            f.write(im.name.encode() + b"\0")
            f.write(struct.pack("<Q", 1) + struct.pack("<ddq", 1.0, 2.0, -1))
    with open(b / "points3D.bin", "wb") as f:
        f.write(struct.pack("<Q", len(text.xyz)))
        for i in range(len(text.xyz)):
            f.write(struct.pack("<QdddBBBdQ", i + 1, *text.xyz[i], *text.rgb[i], 0.5, 1))
            f.write(struct.pack("<ii", 1, 0))
    binary = colmap.read_model(b)
    assert binary.cameras == text.cameras
    assert binary.images == text.images
    assert np.array_equal(binary.xyz, text.xyz) and np.array_equal(binary.rgb, text.rgb)
    # a damaged count is refused, not allocated
    (b / "points3D.bin").write_bytes(struct.pack("<Q", 10**9))
    with pytest.raises(JobError, match="declares"):
        colmap.read_model(b)


# ---------------------------------------------------------------- export, then import


def _sparse(project: Path, run: str) -> colmap.Model:
    """The run's model in the project CRS (``frame.json``'s origin added back), names decoded."""
    from rasterio.crs import CRS

    from aio_pipelines.opf.exporter import read_run_model

    model, shift, _ = read_run_model(project / "photogrammetry" / run / "sparse", CRS.from_epsg(32639))
    for im in model.images.values():  # x = R (X - shift) + t
        im.tvec = list(np.asarray(im.tvec) - quat_wxyz_to_matrix(im.qvec) @ shift)
    model.xyz = model.xyz + shift
    return model


def test_a_run_is_written_in_the_grid_frame_of_frame_json(tmp_path):
    proj = opf_synth.make_project(tmp_path / "p")
    opf_synth.make_run(proj, tmp_path / "photos")
    sparse = proj / "photogrammetry" / RUN / "sparse"
    frame = json.loads((sparse / "frame.json").read_text("utf-8"))
    assert frame["schema"] == "aio.photo-frame/1" and frame["origin"] == list(opf_synth.ORIGIN)
    raw = colmap.read_model(sparse)
    assert np.abs(raw.xyz).max() < 1000  # small numbers: the grid frame, not UTM
    assert np.allclose(_sparse(proj, RUN).xyz, raw.xyz + np.array(opf_synth.ORIGIN))


def test_export_a_run_and_import_it_into_a_new_project(tmp_path, monkeypatch):
    _no_pdal(monkeypatch)
    src = opf_synth.make_project(tmp_path / "source")
    truth = opf_synth.make_run(src, tmp_path / "photos")
    out = tmp_path / "export"
    res, _ = run_job(OpfExport(), src, {"run": RUN, "out": str(out)})
    assert res["outputs"]["build"]["cameras"] == 6
    assert res["outputs"]["build"]["controlPoints"] == 3
    assert sorted(res["outputs"]["build"]["outputs"]) == ["dsm.tif", "ortho.tif"]
    assert (out / "project.opf").is_file() and (out / "outputs" / "ortho.tif").is_file()
    doc = json.loads((out / "project.opf").read_text("utf-8"))
    assert doc["generator"]["name"] == "Quadrion AI"
    srf = json.loads((out / "scene_reference_frame.json").read_text("utf-8"))
    assert srf["crs"]["definition"] == "EPSG:32639"
    # photos are referenced where the run read them
    cams = json.loads((out / "camera_list.json").read_text("utf-8"))["cameras"]
    assert all(c["uri"].startswith("file:") for c in cams)

    dest = opf_synth.make_project(tmp_path / "dest")
    commit, _ = _import(dest, {"src": str(out / "project.opf"), "photosRoot": str(tmp_path / "photos")})
    a, b = _sparse(src, RUN), _sparse(dest, commit["run"])
    # cameras within 1e-6 of the source: intrinsics, centres and rotations
    (ca,), (cb,) = a.cameras.values(), b.cameras.values()
    assert (cb.width, cb.height) == (ca.width, ca.height)
    assert np.allclose(cb.params, ca.params, atol=1e-6)
    assert sorted(i.name for i in b.images.values()) == sorted(c["name"] for c in truth["cameras"])
    by_name = {i.name: i for i in a.images.values()}
    for im in b.images.values():
        ra, za = colmap_to_opf(by_name[im.name].qvec, by_name[im.name].tvec)
        rb, zb = colmap_to_opf(im.qvec, im.tvec)
        assert np.allclose(rb, ra, atol=1e-6)
        assert np.allclose(zb, za, atol=1e-6)
    # tie points (float32 around the origin in OPF)
    assert np.allclose(b.xyz, a.xyz, atol=1e-4)
    assert np.array_equal(b.rgb, a.rgb)
    # GCPs identical: ids, roles, coordinates, accuracy and the confirmed marks
    ga = json.loads((src / "photogrammetry" / RUN / "gcp.json").read_text("utf-8"))
    gb = json.loads((dest / "photogrammetry" / commit["run"] / "gcp.json").read_text("utf-8"))
    assert gb["crs"] == ga["crs"] == {"epsg": 32639}
    for pa, pb in zip(ga["points"], gb["points"], strict=True):
        assert (pb["id"], pb["role"], pb["accuracy"]) == (pa["id"], pa["role"], pa["accuracy"])
        assert pb["xyz"] == pa["xyz"]
        confirmed = [(m["photo"], m["px"]) for m in pa["marks"] if m["state"] == "confirmed"]
        assert [(m["photo"], m["px"]) for m in pb["marks"]] == confirmed
        assert all(m["by"] == "import" and m["state"] == "confirmed" for m in pb["marks"])
    # CRS identical, and the run reads its photos from the original folder
    run = json.loads((dest / "photogrammetry" / commit["run"] / "run.json").read_text("utf-8"))
    assert run["crs"] == {"epsg": 32639}
    assert run["photos"]["source"] == {"folders": [str((tmp_path / "photos").resolve())]}
    assert run["status"] == "aligned" and run["photos"]["registered"] == 6
    kinds = sorted((layer["kind"], layer.get("role")) for layer in _manifest(dest)["layers"])
    assert kinds == [("photos", None), ("raster", "dsm"), ("raster", "ortho")]


def test_a_legacy_run_in_the_project_crs_exports_the_same_cameras(tmp_path):
    """A model folder without frame.json (an older import) is in the project CRS itself."""
    cams = {}
    for name, legacy in (("grid", False), ("legacy", True)):
        src = opf_synth.make_project(tmp_path / name)
        opf_synth.make_run(src, tmp_path / f"photos-{name}", legacy=legacy)
        out = tmp_path / f"export-{name}"
        run_job(OpfExport(), src, {"run": RUN, "out": str(out)})
        doc = json.loads((out / "calibration" / "calibrated_cameras.json").read_text("utf-8"))
        cams[name] = sorted((c["id"], tuple(c["position"])) for c in doc["cameras"])
    assert len(cams["grid"]) == 6
    for (ia, pa), (ib, pb) in zip(cams["grid"], cams["legacy"], strict=True):
        assert ia == ib and np.allclose(pa, pb, atol=1e-6)


def test_an_imported_opf_run_goes_through_photo_products(tmp_path, monkeypatch):
    from aio_pipelines.photo.products import PhotoProducts

    _no_pdal(monkeypatch)
    opf = opf_synth.write_opf(tmp_path / "opf", with_outputs=False)
    proj = opf_synth.make_project(tmp_path / "proj")
    commit, _ = _import(proj, {"src": str(opf)})
    run = commit["run"]
    sparse = proj / "photogrammetry" / run / "sparse"
    assert json.loads((sparse / "frame.json").read_text("utf-8"))["schema"] == "aio.photo-frame/1"
    listing = json.loads((sparse / "photos.json").read_text("utf-8"))
    assert listing["schema"] == "aio.photo-list/1" and len(listing["photos"]) == 6
    for rec in listing["photos"].values():
        assert (Path(listing["imageRoot"]) / rec["name"]).is_file()
    res, _ = run_job(PhotoProducts(), proj, {"run": run, "products": ["dsm"], "preset": "fast"}, job_id="p1")
    assert res["status"] == "done"
    layers = {layer["id"] for layer in _manifest(proj)["layers"]}
    assert f"{run}-dsm" in layers
    import rasterio

    with rasterio.open(proj / "photogrammetry" / run / "dsm.tif") as ds:
        b = ds.bounds  # in the project CRS, over the site (tie points 0..80 E, 0..60 N of the origin)
        assert ds.crs.to_epsg() == 32639
        assert 500000 - 5 < b.left < b.right < 500000 + 85 and 3200000 - 5 < b.bottom < b.top < 3200000 + 65


def _link_dir(link: Path, target: Path) -> None:
    """A directory link: a junction on Windows (no privilege needed), else a symlink."""
    import os

    if os.name == "nt":
        import _winapi

        _winapi.CreateJunction(str(target), str(link))
    else:
        link.symlink_to(target, target_is_directory=True)


def test_a_project_reached_through_a_link_exports(tmp_path):
    """macOS temp folders (/var -> /private/var) and Windows short names (RUNNER~1) are such paths:
    pyopf hands back the tie point buffers by their resolved path."""
    real = tmp_path / "real"
    real.mkdir()
    linked = tmp_path / "linked"
    _link_dir(linked, real)
    src = opf_synth.make_project(linked / "source")
    opf_synth.make_run(src, linked / "photos")
    out = linked / "export"
    res, _ = run_job(OpfExport(), src, {"run": RUN, "out": str(out)})
    assert res["outputs"]["build"]["tiePoints"] > 0
    cal = next(
        i for i in json.loads((out / "project.opf").read_text("utf-8"))["items"] if i["type"] == "calibration"
    )
    uris = [r["uri"] for r in cal["resources"]]
    assert "calibration/tracks.gltf" in uris
    assert all(not Path(u).is_absolute() and (out / u).is_file() for u in uris)


def test_re_export_overwrites_an_earlier_export_but_not_other_folders(tmp_path):
    src = opf_synth.make_project(tmp_path / "source")
    opf_synth.make_run(src, tmp_path / "photos")
    out = tmp_path / "export"
    run_job(OpfExport(), src, {"run": RUN, "out": str(out)})
    run_job(OpfExport(), src, {"run": RUN, "out": str(out)}, job_id="j2")
    other = tmp_path / "other"
    other.mkdir()
    (other / "notes.txt").write_text("mine", "utf-8")
    with pytest.raises(JobError, match="not empty"):
        run_job(OpfExport(), src, {"run": RUN, "out": str(other)}, job_id="j3")
    assert (other / "notes.txt").read_text("utf-8") == "mine"
    with pytest.raises(JobError, match="absolute folder"):
        OpfExport().validate({"run": RUN, "out": "relative/folder"})
    with pytest.raises(JobError, match=r"is not a processing run|could not be read"):
        run_job(OpfExport(), src, {"run": "nope", "out": str(tmp_path / "x")}, job_id="j4")


# ---------------------------------------------------------------- import


def test_a_hand_written_opf_imports_photos_cameras_control_points_and_outputs(tmp_path, monkeypatch):
    _no_pdal(monkeypatch)
    opf = opf_synth.write_opf(tmp_path / "opf")
    proj = opf_synth.make_project(tmp_path / "proj")
    commit, rec = _import(proj, {"src": str(opf)})
    m = _manifest(proj)
    photos = next(layer for layer in m["layers"] if layer["kind"] == "photos")
    assert photos["id"] == commit["photosLayer"] and len(photos["items"]) == 6
    hfov = math.degrees(2 * math.atan(opf_synth.W / (2 * opf_synth.FOCAL)))
    for item, cam in zip(photos["items"], opf_synth.cameras(), strict=True):
        assert (proj / item["src"]["path"]).is_file()
        assert item["lens"] == {
            "model": "pinhole",
            "hfovDeg": pytest.approx(hfov, abs=1e-5),
            "aspect": pytest.approx(4 / 3),
        }
        e, n, h = cam["enh"]
        assert item["pos"] == pytest.approx([e - 500000, h, -(n - 3200000)], abs=1e-3)
        # the camera looks down (three.js camera -Z in the local frame, Y up)
        x, y, z, w = item["q"]
        r = quat_wxyz_to_matrix([w, x, y, z])
        view = r @ np.array([0, 0, -1.0])
        assert view[1] < -0.99
        assert item["takenAt"].startswith("2026-10-01T08:")
    run_dir = proj / "photogrammetry" / commit["run"]
    model = _sparse(proj, commit["run"])
    (cam,) = model.cameras.values()
    assert cam.model == "FULL_OPENCV" and cam.params[:4] == [opf_synth.FOCAL, opf_synth.FOCAL, 322.0, 239.0]
    assert len(model.images) == 6 and len(model.xyz) == 50
    gcp = json.loads((run_dir / "gcp.json").read_text("utf-8"))
    assert [p["id"] for p in gcp["points"]] == ["GCP1", "GCP2", "CHK1"]
    assert [p["role"] for p in gcp["points"]] == ["control", "control", "check"]
    assert all(len(p["marks"]) == 3 for p in gcp["points"])
    run = json.loads((run_dir / "run.json").read_text("utf-8"))
    assert run["schema"] == "aio.photo-run/1" and run["status"] == "aligned"
    assert run["cameras"][0]["calibration"] == "FULL_OPENCV" and run["cameras"][0]["photos"] == 6
    assert run["cameras"][0]["focalMm"] == pytest.approx(5.2)
    assert set(run["outputs"]["layers"]) == {layer["id"] for layer in m["layers"]}
    report = json.loads((run_dir / "report" / "opf-import.json").read_text("utf-8"))
    whats = " ".join(s["what"] for s in report["skipped"])
    assert (
        "manual tie points" in whats
        and "mesh outputs/mesh.obj" in whats
        and "point cloud Dense cloud" in whats
    )
    # the orthomosaic and the DSM as kit pyramids, the DSM heights for the change pipelines
    ortho = next(layer for layer in m["layers"] if layer.get("role") == "ortho")
    dsm = next(layer for layer in m["layers"] if layer.get("role") == "dsm")
    for layer in (ortho, dsm):
        assert layer["format"] == "kit-pyramid"
        tiles = json.loads((proj / layer["src"]["path"]).read_text("utf-8"))
        assert tiles["schema"] == "aio.tiles/1"
        assert (proj / tiles["levels"][0]["pattern"].format(x=0, y=0)).is_file()
        assert tiles["corners"]["tl"] == [0.0, 0, -64.0]
    from aio_pipelines.change.sources import grid_source

    g = grid_source(proj, dsm, m)
    h = g.heights()
    assert np.nanmax(h) == pytest.approx(4.0, abs=0.1) and np.nanmin(h) == pytest.approx(0.0, abs=0.1)
    assert (run_dir / "ortho.tif").is_file() and (run_dir / "dsm.tif").is_file()
    assert (proj / "manifest.json.bak").is_file()
    assert any("Run opf-" in msg["message"] for msg in rec.of("log"))


def test_a_commit_that_runs_again_adds_its_layers_once(tmp_path, monkeypatch):
    _no_pdal(monkeypatch)
    opf = opf_synth.write_opf(tmp_path / "opf")
    proj = opf_synth.make_project(tmp_path / "proj")
    first, _ = _import(proj, {"src": str(opf)})
    # the job stopped after writing the manifest, before recording its commit step: resume it
    (proj / "jobs" / "j1" / "steps" / "05-commit.json").unlink()
    again, rec = _import(proj, {"src": str(opf)})
    assert again["layers"] == first["layers"]
    ids = [layer["id"] for layer in _manifest(proj)["layers"]]
    assert sorted(ids) == sorted(first["layers"])
    assert sum(1 for p in rec.of("progress") if p.get("state") == "skipped") == 4


@needs_pdal
def test_an_opf_point_cloud_becomes_a_copc_layer(tmp_path):
    opf = opf_synth.write_opf(tmp_path / "opf", with_outputs=False)
    proj = opf_synth.make_project(tmp_path / "proj")
    commit, _ = _import(proj, {"src": str(opf), "products": ["cloud"]})
    cloud = next(layer for layer in _manifest(proj)["layers"] if layer["kind"] == "pointcloud")
    assert cloud["format"] == "copc" and cloud["pointCount"] == 200
    assert (proj / cloud["src"]["path"]).is_file()
    assert cloud["id"] in commit["layers"]


def test_products_limit_what_comes_in(tmp_path, monkeypatch):
    _no_pdal(monkeypatch)
    opf = opf_synth.write_opf(tmp_path / "opf")
    proj = opf_synth.make_project(tmp_path / "proj")
    _import(proj, {"src": str(opf), "products": ["ortho"]})
    roles = sorted(layer.get("role") or layer["kind"] for layer in _manifest(proj)["layers"])
    assert roles == ["ortho", "photos"]


def test_absolute_photo_paths_need_the_photos_folder(tmp_path, monkeypatch):
    _no_pdal(monkeypatch)
    opf = opf_synth.write_opf(tmp_path / "opf", absolute_photos=True, with_outputs=False)
    # the photos move: their absolute paths no longer exist, and are never read anyway
    (tmp_path / "opf" / "images").rename(tmp_path / "moved")
    proj = opf_synth.make_project(tmp_path / "proj")
    with pytest.raises(JobError, match="Choose that photos folder"):
        _import(proj, {"src": str(opf)})
    commit, _ = _import(proj, {"src": str(opf), "photosRoot": str(tmp_path / "moved")}, "j2")
    assert commit["photos"] == 6


def test_the_specification_example_imports_what_it_can(tmp_path, monkeypatch):
    _no_pdal(monkeypatch)
    proj = opf_synth.make_project(tmp_path / "proj")
    commit, rec = _import(proj, {"src": str(SPEC)})
    assert commit["photos"] == 0  # the example has no images
    run_dir = proj / "photogrammetry" / commit["run"]
    report = json.loads((run_dir / "report" / "opf-import.json").read_text("utf-8"))
    assert any("arbitrary" in w for w in report["warnings"])
    reasons = {s["what"]: s["reason"] for s in report["skipped"]}
    assert "absolute path" in reasons["photo DJI_09572.jpg"]
    assert reasons["file myalgo-settings.json"].startswith("named by the OPF project but missing")
    model = _sparse(proj, commit["run"])
    assert len(model.images) == 1  # the one perspective camera; fisheye sensors stay in the OPF
    gcp = json.loads((run_dir / "gcp.json").read_text("utf-8"))
    assert [p["id"] for p in gcp["points"]] == ["gcp0"] and gcp["points"][0]["role"] == "check"


# ---------------------------------------------------------------- hostile inputs


def _rewrite(opf: Path, fn) -> None:
    doc = json.loads(opf.read_text("utf-8"))
    fn(doc)
    opf.write_text(json.dumps(doc), "utf-8")


@pytest.mark.parametrize(
    "uri",
    [
        "C:/Windows/win.ini",
        "/etc/passwd",
        "file:///C:/Windows/win.ini",
        "../outside.json",
        "a/../../outside.json",
        "http://example.com/x.json",
    ],
)
def test_resources_outside_the_opf_folder_are_refused(tmp_path, uri):
    opf = opf_synth.write_opf(tmp_path / "opf", with_outputs=False)
    (tmp_path / "outside.json").write_text("{}", "utf-8")
    _rewrite(
        opf,
        lambda d: d["items"][0]["resources"].__setitem__(
            0, {"uri": uri, "format": "application/opf-camera-list+json"}
        ),
    )
    proj = opf_synth.make_project(tmp_path / "proj")
    with pytest.raises(JobError, match="absolute path or outside the OPF folder"):
        _import(proj, {"src": str(opf)})
    assert _manifest(proj)["layers"] == []
    assert not (proj / "photogrammetry").exists()


def test_a_point_cloud_buffer_outside_the_folder_is_refused(tmp_path):
    opf = opf_synth.write_opf(tmp_path / "opf", with_outputs=False)
    gltf = tmp_path / "opf" / "dense" / "dense.gltf"
    doc = json.loads(gltf.read_text("utf-8"))
    doc["buffers"][0]["uri"] = "../../secret.bin"
    (tmp_path / "secret.bin").write_bytes(b"\0" * 4096)
    gltf.write_text(json.dumps(doc), "utf-8")
    with pytest.raises(JobError, match="absolute path or outside the OPF folder"):
        _import(opf_synth.make_project(tmp_path / "proj"), {"src": str(opf)})


def test_a_huge_declared_point_count_is_refused(tmp_path):
    opf = opf_synth.write_opf(tmp_path / "opf", with_outputs=False)
    gltf = tmp_path / "opf" / "dense" / "dense.gltf"
    doc = json.loads(gltf.read_text("utf-8"))
    doc["accessors"][0]["count"] = 10**12
    gltf.write_text(json.dumps(doc), "utf-8")
    with pytest.raises(JobError, match="declares 1,000,000,000,000 values"):
        _import(opf_synth.make_project(tmp_path / "proj"), {"src": str(opf)})


def test_missing_and_unreadable_photos_are_left_out_with_their_reason(tmp_path, monkeypatch):
    _no_pdal(monkeypatch)
    opf = opf_synth.write_opf(tmp_path / "opf", with_outputs=False)
    imgs = tmp_path / "opf" / "images" / "flight1"
    (imgs / "IMG_0002.JPG").unlink()
    (imgs / "IMG_0003.JPG").write_bytes(b"not a jpeg")
    _rewrite(
        tmp_path / "opf" / "camera_list.json",
        lambda d: d["cameras"][3].__setitem__("uri", "https://example.com/IMG_0004.JPG"),
    )
    proj = opf_synth.make_project(tmp_path / "proj")
    commit, _ = _import(proj, {"src": str(opf)})
    assert commit["photos"] == 3
    run = json.loads((proj / "photogrammetry" / commit["run"] / "run.json").read_text("utf-8"))
    reasons = {r["name"]: r["reason"] for r in run["photos"]["rejected"]}
    assert reasons["IMG_0002.JPG"] == "missing next to the OPF project"
    assert reasons["images/flight1/IMG_0003.JPG"].startswith("could not be read")
    assert "network files are never read" in reasons["IMG_0004.JPG"]


def test_not_an_opf_project(tmp_path):
    bad = tmp_path / "x.opf"
    bad.write_text('{"format": "application/json"}', "utf-8")
    proj = opf_synth.make_project(tmp_path / "proj")
    with pytest.raises(JobError, match="is not an OPF project"):
        _import(proj, {"src": str(bad)})
    with pytest.raises(JobError, match=r"Choose the .opf file"):
        OpfImport().validate({"src": "D:/x/project.p4d"})
    with pytest.raises(JobError, match="products must be one of"):
        OpfImport().validate({"src": "D:/x/project.opf", "products": ["hologram"]})
