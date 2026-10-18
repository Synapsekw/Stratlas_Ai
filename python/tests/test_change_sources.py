"""The measured sources of viewing layers (``change/sources.py``): aio.grid/1 heights and LAS clouds.

Tiny procedural grids and clouds only.
"""

from __future__ import annotations

import json

import numpy as np
import pytest
from PIL import Image

from aio_pipelines.change.sources import cloud_source, grid_source, height_offset_m
from aio_pipelines.runtime import JobError
from synth import write_las

DSM = {"kind": "raster", "id": "dsm-a", "name": "DSM A", "role": "dsm", "format": "kit-pyramid"}
CLOUD = {"kind": "pointcloud", "id": "cloud-a", "name": "Cloud A", "format": "png-packed"}
MANIFEST = {"crs": {"epsg": 32631}}


def grid(project, **over):
    src = project / "sources"
    src.mkdir(parents=True, exist_ok=True)
    values = np.array([[0, 1000, 2000], [3000, 4000, 65535]], dtype=np.uint16)
    Image.fromarray(values).save(src / "dsm-a.png")
    g = {
        "schema": "aio.grid/1",
        "kind": "dsm",
        "layer": "dsm-a",
        "epsg": 32631,
        "x0": 301000.0,
        "y1": 2575000.0,
        "res": 0.5,
        "width": 3,
        "height": 2,
        "file": "dsm-a.png",
        "scale": 0.001,
        "offset": 380.0,
        "nodata": 0,
        **over,
    }
    (src / "dsm-a.json").write_text(json.dumps(g), "utf-8")
    return g


def test_a_height_grid_reads_as_metres_with_nodata_as_nan(tmp_path):
    grid(tmp_path)
    g = grid_source(tmp_path, DSM, MANIFEST)
    assert (g.width, g.height, g.res) == (3, 2, 0.5)
    assert g.bounds == (301000.0, 2574999.0, 301001.5, 2575000.0)
    assert g.files == [str(tmp_path / "sources" / "dsm-a.json"), str(tmp_path / "sources" / "dsm-a.png")]
    h = g.heights()
    assert np.isnan(h[0, 0])
    assert h[0, 1:] == pytest.approx([381.0, 382.0])
    assert h[1] == pytest.approx([383.0, 384.0, 380.0 + 65.535])
    t = g.transform()
    assert (t.c, t.f, t.a, t.e) == (301000.0, 2575000.0, 0.5, -0.5)


def test_without_a_grid_the_dsm_says_what_to_import(tmp_path):
    with pytest.raises(
        JobError, match=r'The DSM "DSM A" has no height grid \(sources/dsm-a\.json\); import a GeoTIFF'
    ):
        grid_source(tmp_path, DSM, MANIFEST)


@pytest.mark.parametrize(
    ("over", "message"),
    [
        ({"schema": "aio.other/1"}, "not an aio.grid/1"),
        ({"kind": "ortho"}, "not DSM heights"),
        ({"res": "fine"}, "no number for res"),
        ({"width": 0}, "cannot be right"),
        ({"scale": 0}, "cannot be right"),
        ({"file": "../elsewhere.png"}, "must be a file name"),
        ({"file": "C:/data/dsm-a.png"}, "must be a file name"),
        ({"file": "missing.png"}, "is missing"),
        ({"epsg": 32639}, "EPSG:32639; the project is in EPSG:32631"),
        ({"nodata": "none"}, "nodata"),
    ],
)
def test_a_bad_grid_is_refused_with_a_sentence(tmp_path, over, message):
    grid(tmp_path, **over)
    with pytest.raises(JobError, match=message):
        grid_source(tmp_path, DSM, MANIFEST)


def test_an_image_of_another_size_is_refused(tmp_path):
    grid(tmp_path, width=4)
    with pytest.raises(JobError, match="is 3 x 2 pixels"):
        grid_source(tmp_path, DSM, MANIFEST).heights()


def test_a_layer_id_is_never_a_path(tmp_path):
    grid(tmp_path)
    (tmp_path / "sources" / "x").mkdir()
    with pytest.raises(JobError, match="has no height grid"):
        grid_source(tmp_path, {**DSM, "id": "../sources/dsm-a"}, MANIFEST)
    with pytest.raises(JobError, match="no measured points"):
        cloud_source(tmp_path, {**CLOUD, "id": "x/../cloud-a"})


def test_a_cloud_source_is_the_las_named_by_the_layer(tmp_path):
    with pytest.raises(JobError, match=r'"Cloud A" has no measured points \(sources/cloud-a\.las\)'):
        cloud_source(tmp_path, CLOUD)
    (tmp_path / "sources").mkdir()
    las = write_las(tmp_path / "sources" / "cloud-a.las", np.zeros((3, 3)) + 100, 32631, point_format=2)
    assert cloud_source(tmp_path, CLOUD) == las
    with pytest.raises(JobError, match="convert it"):
        cloud_source(tmp_path, {**CLOUD, "id": "other"}, "convert it")


def test_height_offset_reads_the_layer():
    assert height_offset_m({"heightOffsetM": -30.81}) == -30.81
    assert height_offset_m({"heightOffsetM": 12}) == 12.0


@pytest.mark.parametrize(
    "layer",
    [
        {},
        {"heightOffsetM": None},
        {"heightOffsetM": "x"},
        {"heightOffsetM": float("nan")},
        {"heightOffsetM": float("inf")},
        {"heightOffsetM": True},
        {"heightOffsetM": False},
    ],
)
def test_height_offset_defaults_to_zero(layer):
    assert height_offset_m(layer) == 0.0


def test_point_format_2_reads_without_pdal(tmp_path):
    from aio_pipelines.volumetric.cloud import LasHeader, read_las_chunks

    xyz = np.array([[301000.0, 2575000.0, 390.0], [301001.25, 2575002.5, 391.5]])
    path = write_las(tmp_path / "c.las", xyz, 32631, point_format=2)
    h = LasHeader(path)
    assert (h.format, h.record, h.count, h.has_rgb) == (2, 26, 2, True)
    [(x, y, z, rgb)] = list(read_las_chunks(path))
    assert np.column_stack([x, y, z]) == pytest.approx(xyz)
    assert rgb.shape == (2, 3)


def test_grid_source_carries_the_shift(tmp_path):
    grid(tmp_path)
    plain = grid_source(tmp_path, DSM, MANIFEST)
    dated = {**DSM, "capture": "c2"}
    manifest = {
        **MANIFEST,
        "captures": [
            {"id": "c1", "label": "Survey", "date": "2026-01-10"},
            {"id": "c2", "label": "Survey", "date": "2026-03-01", "lineUp": {"eastM": 2.0, "northM": -1.0}},
        ],
        "layers": [dated],
    }
    g = grid_source(tmp_path, dated, manifest)
    assert (g.x0, g.y1) == (plain.x0 + 2.0, plain.y1 - 1.0)
    t = g.transform()
    assert (t.c, t.f) == (301002.0, 2574999.0)
    assert np.array_equal(g.heights(), plain.heights(), equal_nan=True)


def test_grid_source_follows_a_turned_line_up(tmp_path):
    from aio_pipelines.similarity import Similarity

    # 100 m x 100 m at 0.5 m, flat at 400 m with a 10 m block of 2 x 2 m near the north-east corner
    src = tmp_path / "sources"
    src.mkdir(parents=True, exist_ok=True)
    values = np.full((200, 200), 20000, np.uint16)
    values[10:14, 180:184] = 30000
    Image.fromarray(values).save(src / "dsm-a.png")
    x0, y1 = 301000.0, 2575000.0
    g = {"schema": "aio.grid/1", "kind": "dsm", "layer": "dsm-a", "epsg": 32631, "x0": x0, "y1": y1,
         "res": 0.5, "width": 200, "height": 200, "file": "dsm-a.png", "scale": 0.001, "offset": 380.0, "nodata": 0}  # fmt: skip
    (src / "dsm-a.json").write_text(json.dumps(g), "utf-8")
    turn = {"rotationDeg": 0.5, "scale": 1.0, "pivotE": x0, "pivotN": y1 - 100.0}
    dated = {**DSM, "capture": "c2"}
    manifest = {
        **MANIFEST,
        "captures": [
            {"id": "c1", "label": "Survey", "date": "2026-01-10"},
            {"id": "c2", "label": "Survey", "date": "2026-03-01", "lineUp": {"eastM": 2.0, "northM": 0.0},
             "lineUpTurn": turn},
        ],
        "layers": [dated],
    }  # fmt: skip
    sim = Similarity.from_line_up({"eastM": 2.0, "northM": 0.0}, turn)
    t = grid_source(tmp_path, dated, manifest)
    # still a north-up grid, now covering the turned footprint
    a = t.transform()
    assert (a.b, a.d) == (0.0, 0.0) and a.a == 0.5 and a.e == -0.5
    e, n = sim.apply_en(np.array([x0, x0 + 100, x0, x0 + 100]), np.array([y1, y1, y1 - 100, y1 - 100]))
    left, bottom, right, top = t.bounds
    assert left <= e.min() and right >= e.max() and bottom <= n.min() and top >= n.max()
    assert right - e.max() < 0.5 and left - e.min() > -0.5
    h = t.heights()
    assert h.shape == (t.height, t.width)
    w = np.clip(np.nan_to_num(h, nan=400.0) - 400.0, 0, None)  # the block's height above the ground
    rows, cols = np.indices(h.shape)
    got = (
        t.x0 + (np.average(cols, weights=w) + 0.5) * t.res,
        t.y1 - (np.average(rows, weights=w) + 0.5) * t.res,
    )
    want = sim.apply_en(x0 + 182 * 0.5, y1 - 12 * 0.5)
    assert got == pytest.approx(want, abs=0.15)
    assert np.hypot(want[0] - (x0 + 91 + 2), want[1] - (y1 - 6)) > 0.7  # more than the shift alone
    # flat ground stays at its height; outside the turned footprint there is none
    assert np.nanmedian(h) == pytest.approx(400.0)
    assert np.isnan(h).any()
