import struct
from pathlib import Path

import numpy as np
import pytest
import rasterio
from PIL import Image
from rasterio.transform import from_origin

from aio_pipelines.photo import glb
from aio_pipelines.photo.odm import outputs as O
from aio_pipelines.runtime import JobError

UTM39 = 32639


def _tif(path: Path, data: np.ndarray, epsg: int, x0: float, y1: float, res: float, nodata=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    bands = 1 if data.ndim == 2 else data.shape[0]
    with rasterio.open(path, "w", driver="GTiff", width=data.shape[-1], height=data.shape[-2], count=bands,
                       dtype=data.dtype, crs=f"EPSG:{epsg}", transform=from_origin(x0, y1, res, res), nodata=nodata) as ds:  # fmt: skip
        ds.write(data if data.ndim == 3 else data[None])


def test_a_dem_in_the_same_crs_keeps_its_grid_and_nodata_becomes_nan(tmp_path):
    z = np.full((10, 20), 50.0, np.float32)
    z[0, 0] = -9999.0
    _tif(tmp_path / "dsm.tif", z, UTM39, 412000.0, 3245010.0, 0.5, nodata=-9999.0)
    spec = O.dem_to_project(tmp_path / "dsm.tif", tmp_path / "out.tif", UTM39)
    assert (spec.x0, spec.y1, spec.res, spec.width, spec.height) == (412000.0, 3245010.0, 0.5, 20, 10)
    with rasterio.open(tmp_path / "out.tif") as ds:
        a = ds.read(1)
    assert np.isnan(a[0, 0]) and a[5, 5] == 50.0
    assert O.ground_height(tmp_path / "out.tif") == 50.0


def test_a_dem_in_another_crs_is_warped(tmp_path):
    _tif(
        tmp_path / "dsm.tif",
        np.full((20, 20), 7.0, np.float32),
        UTM39,
        412000.0,
        3245020.0,
        1.0,
        nodata=-9999.0,
    )
    spec = O.dem_to_project(tmp_path / "dsm.tif", tmp_path / "out.tif", 32640)  # UTM 40N
    with rasterio.open(tmp_path / "out.tif") as ds:
        assert ds.crs.to_epsg() == 32640
        assert np.nanmax(ds.read(1)) == pytest.approx(7.0)
    assert spec.width > 0 and spec.height > 0


def test_ortho_same_crs_is_used_as_is(tmp_path):
    rgba = np.zeros((4, 8, 8), np.uint8)
    _tif(tmp_path / "o.tif", rgba, UTM39, 412000.0, 3245010.0, 0.1)
    assert O.ortho_to_project(tmp_path / "o.tif", tmp_path / "x.tif", UTM39) == tmp_path / "o.tif"
    out = O.ortho_to_project(tmp_path / "o.tif", tmp_path / "x.tif", 32640)
    with rasterio.open(out) as ds:
        assert ds.crs.to_epsg() == 32640 and ds.count == 4


def test_missing_output_is_named(tmp_path):
    with pytest.raises(JobError, match=r"ODM did not write odm_orthophoto\.tif"):
        O.output_path(tmp_path, O.ORTHO)
    (tmp_path / "odm_georeferencing").mkdir()
    (tmp_path / "odm_georeferencing" / "odm_georeferenced_model.las").write_bytes(b"x")
    assert O.output_path(tmp_path, O.CLOUDS).name == "odm_georeferenced_model.las"


def test_coords(tmp_path):
    (tmp_path / "odm_georeferencing").mkdir()
    (tmp_path / "odm_georeferencing" / "coords.txt").write_text("WGS84 UTM 39N\n412000 3245000\n")
    assert O.read_coords(tmp_path) == (32639, (412000.0, 3245000.0))
    (tmp_path / "odm_georeferencing" / "coords.txt").write_text("WGS84 UTM 33S\n1 2\n")
    assert O.read_coords(tmp_path)[0] == 32733


def test_las_point_count(tmp_path):
    head = bytearray(227)
    head[0:4] = b"LASF"
    head[24:26] = bytes([1, 2])
    struct.pack_into("<I", head, 107, 1234)
    (tmp_path / "a.las").write_bytes(bytes(head))
    assert O.las_point_count(tmp_path / "a.las") == 1234


def _textured_obj(odm: Path, folder: str = "odm_texturing"):
    d = odm / folder
    d.mkdir(parents=True)
    Image.new("RGB", (8, 8), (200, 10, 10)).save(d / "tex.png")
    (d / "odm_textured_model_geo.mtl").write_text("newmtl material0000\nmap_Kd tex.png\n")
    (d / "odm_textured_model_geo.obj").write_text(
        "mtllib odm_textured_model_geo.mtl\n"
        "v 10 20 25\nv 11 20 25\nv 10 21 26\n"
        "vt 0 0\nvt 1 0\nvt 0 1\n"
        "usemtl material0000\nf 1/1 2/2 3/3\n"
    )
    (odm / "odm_georeferencing").mkdir(parents=True, exist_ok=True)
    (odm / "odm_georeferencing" / "coords.txt").write_text("WGS84 UTM 39N\n412000 3245000\n")


def test_obj_reader(tmp_path):
    _textured_obj(tmp_path)
    parts = O.read_obj(tmp_path / "odm_texturing" / "odm_textured_model_geo.obj")
    assert len(parts) == 1 and parts[0].positions.shape == (3, 3) and parts[0].texture.name == "tex.png"
    assert parts[0].uvs.tolist() == [[0, 0], [1, 0], [0, 1]]


def test_mesh_to_glb_is_in_the_scene_frame(tmp_path):
    _textured_obj(tmp_path)
    data, info = O.mesh_to_glb(tmp_path, UTM39, np.array([412000.0, 3245000.0, 20.0]))
    assert info == {"triangles": 1, "textures": 1, "source": "3d"}
    doc = glb.glb_info(data)
    acc = doc["accessors"][doc["meshes"][0]["primitives"][0]["attributes"]["POSITION"]]
    # vertex (10, 20, 25) in UTM minus offset: east 10, north 20, height 25 - 20 = 5 -> scene (10, 5, -20)
    assert acc["min"] == pytest.approx([10.0, 5.0, -21.0]) and acc["max"] == pytest.approx([11.0, 6.0, -20.0])


def test_glb_stands_alone():
    src = Path(glb.__file__).read_text(encoding="utf-8")
    assert "from .mesh" not in src and "from .texture" not in src and "from . import mesh" not in src


def test_the_25d_model_is_used_when_there_is_no_3d_one(tmp_path):
    _textured_obj(tmp_path, "odm_texturing_25d")
    assert O.mesh_to_glb(tmp_path, UTM39, np.array([412000.0, 3245000.0, 20.0]))[1]["source"] == "2.5d"


def _coords(odm: Path, line1: str = "WGS84 UTM 39N"):
    (odm / "odm_georeferencing").mkdir(parents=True, exist_ok=True)
    (odm / "odm_georeferencing" / "coords.txt").write_text(f"{line1}\n412000 3245000\n")


def _las_header(path: Path, count: int):
    head = bytearray(227)
    head[0:4] = b"LASF"
    head[24:26] = bytes([1, 2])
    struct.pack_into("<I", head, 107, count)
    path.write_bytes(bytes(head))


def test_a_copc_in_the_project_crs_is_copied(tmp_path):
    _coords(tmp_path)
    _las_header(tmp_path / "odm_georeferencing" / "odm_georeferenced_model.copc.laz", 77)
    dst = tmp_path / "out" / "cloud.copc.laz"
    info = O.cloud_to_copc(None, tmp_path, dst, UTM39, tmp_path / "tmp", 1)
    assert info == {"points": 77, "writer": "odm", "source": "odm_georeferenced_model.copc.laz"}
    assert dst.is_file()


def test_a_cloud_in_another_crs_goes_through_pdal(tmp_path, monkeypatch):
    import json

    from aio_pipelines import pointcloud
    from aio_pipelines.photo import cloud_out, native

    _coords(tmp_path)
    _las_header(tmp_path / "odm_georeferencing" / "odm_georeferenced_model.laz", 5)
    calls = []

    def fake_run_tool(ctx, args, what, work, **kw):
        calls.append(list(args))
        stages = json.loads(Path(args[2]).read_text())
        _las_header(Path(stages[-1]["filename"]), 5)
        return ""

    def fake_copc(ctx, las, out, points, epsg, temp, budget, **kw):
        calls.append(("copc", las.name, points, epsg))
        return "fake"

    monkeypatch.setattr(pointcloud, "find_pdal", lambda: "pdal.exe")
    monkeypatch.setattr(pointcloud, "pdal_env", lambda exe: {})
    monkeypatch.setattr(native, "run_tool", fake_run_tool)
    monkeypatch.setattr(cloud_out, "write_copc", fake_copc)
    info = O.cloud_to_copc(None, tmp_path, tmp_path / "c.copc.laz", 32640, tmp_path / "tmp", 1)
    assert info == {"points": 5, "writer": "fake", "source": "odm_georeferenced_model.laz"}
    assert calls[0][:2] == ["pdal.exe", "pipeline"] and calls[1] == ("copc", "cloud.las", 5, 32640)
    stages = json.loads(Path(calls[0][2]).read_text())
    assert [s["type"] for s in stages] == ["readers.las", "filters.reprojection", "writers.las"]
    assert stages[1]["in_srs"] == "EPSG:32639" and stages[1]["out_srs"] == "EPSG:32640"


def test_no_pdal_is_a_plain_error(tmp_path, monkeypatch):
    from aio_pipelines import pointcloud

    _coords(tmp_path)
    _las_header(tmp_path / "odm_georeferencing" / "odm_georeferenced_model.las", 5)
    monkeypatch.setattr(pointcloud, "find_pdal", lambda: None)
    with pytest.raises(JobError):
        O.cloud_to_copc(None, tmp_path, tmp_path / "c.copc.laz", UTM39, tmp_path / "tmp", 1)


def test_a_texture_name_with_spaces_and_options(tmp_path):
    _textured_obj(tmp_path)
    d = tmp_path / "odm_texturing"
    Image.new("RGB", (4, 4)).save(d / "my tex.png")
    (d / "odm_textured_model_geo.mtl").write_text("newmtl material0000\nmap_Kd -s 1 1 1 my tex.png\n")
    parts = O.read_obj(d / "odm_textured_model_geo.obj")
    assert parts[0].texture.name == "my tex.png"


def test_a_missing_texture_is_grey_with_a_warning(tmp_path):
    _textured_obj(tmp_path)
    (tmp_path / "odm_texturing" / "tex.png").unlink()
    _, info = O.mesh_to_glb(tmp_path, UTM39, np.array([412000.0, 3245000.0, 20.0]))
    assert info["textures"] == 0 and "tex.png is missing" in info["warnings"][0]
