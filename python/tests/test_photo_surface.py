"""photo.products (G3): DSM and DTM gridding, ground filtering, COGs and the measurable heights."""

from __future__ import annotations

import json

import numpy as np
import pytest
import rasterio

import products_synth as ps
from aio_pipelines.change.sources import grid_source
from aio_pipelines.photo import surface as S
from aio_pipelines.photo.fuse import PointTiles


def test_cell_statistics():
    xyz = np.array([[0.5, 9.5, 1.0], [0.6, 9.4, 3.0], [0.7, 9.3, 2.0], [1.5, 9.5, 7.0]])
    for stat, want in (("median", 2.0), ("min", 1.0), ("max", 3.0)):
        z = S.cell_stat(xyz, 0.0, 10.0, 1.0, 3, 2, stat)
        assert z[0, 0] == want and z[0, 1] == 7.0 and np.isnan(z[1]).all()


def test_holes_fill_only_near_data():
    a = np.full((20, 20), np.nan)
    a[:, :5] = 1.0
    out = S.fill_near(a, 3)
    assert np.isfinite(out[:, :8]).all() and np.isnan(out[:, 9:]).all()


def test_harmonic_fill_restores_a_plane():
    yy, xx = np.mgrid[0:60, 0:80].astype(float)
    plane = 0.2 * xx - 0.1 * yy + 5
    a = plane.copy()
    a[20:40, 30:55] = np.nan
    out = S.harmonic_fill(a)
    assert np.allclose(out, plane, atol=1e-6)
    assert np.isfinite(S.push_pull(a)).all()


def test_the_ground_filter_removes_a_building_and_a_pile():
    cell = 1.0
    yy, xx = np.mgrid[0:80, 0:100].astype(float)
    ground = 0.03 * xx + 0.4 * np.sin(yy / 9.0)
    dsm = ground.copy()
    dsm[20:30, 60:72] += 6.0  # a building
    d = np.hypot(xx - 30, yy - 50)
    dsm += np.clip(4 * (1 - d / 7), 0, None)  # a stockpile
    dtm = S.dtm_from(dsm, dsm, cell)
    assert abs(float(np.mean(dtm[22:28, 62:70] - ground[22:28, 62:70]))) < 0.2
    assert float(np.mean(dtm[d < 4] - ground[d < 4])) < 0.6
    assert float(np.mean(np.abs(dtm - ground)[(d > 12) & (dsm == ground)])) < 0.05


def _tiles(tmp_path):
    xs, ys = np.meshgrid(np.arange(0, 30, 0.1), np.arange(0, 20, 0.1))
    z = 10 + 0.1 * xs
    xyz = np.column_stack([xs.ravel() + 500000, ys.ravel() + 3000000, z.ravel()])
    store = PointTiles(tmp_path / "cloud", 8.0)
    store.add(
        "a", xyz, np.zeros((len(xyz), 3), np.uint8), np.tile([0, 0, 1], (len(xyz), 1)).astype(np.float32)
    )
    store.merge(0.1)
    return store


def test_a_dsm_is_written_by_windows_and_copied_to_a_cog(tmp_path):
    store = _tiles(tmp_path)
    spec = S.GridSpec.around((500000, 3000000), (500030, 3000020), 0.25)
    raw = tmp_path / "dsm-raw.tif"
    info = S.grid_points(
        store, spec, raw, 32639, 1.0, lambda: None, lambda f, m=None: None, tmp_path / "zmin.tif"
    )
    assert info["coverage"] > 0.95
    cog = tmp_path / "dsm.tif"
    S.to_cog(raw, cog)
    with rasterio.open(cog) as ds:
        assert ds.crs.to_epsg() == 32639 and ds.nodata == S.NODATA
        assert ds.tags(ns="IMAGE_STRUCTURE").get("LAYOUT") == "COG"
        z = ds.read(1, masked=True)
        assert abs(float(z[40, 60]) - (10 + 0.1 * (60.5 * 0.25))) < 0.06


def test_small_windows_give_the_same_surface(tmp_path, monkeypatch):
    store = _tiles(tmp_path)
    spec = S.GridSpec.around((500000, 3000000), (500030, 3000020), 0.25)
    S.grid_points(store, spec, tmp_path / "a.tif", None, 1.0, lambda: None, lambda f, m=None: None)
    monkeypatch.setattr(S, "BLOCK", 17)
    S.grid_points(store, spec, tmp_path / "b.tif", None, 1.0, lambda: None, lambda f, m=None: None)
    a, b = S.read_grid(tmp_path / "a.tif"), S.read_grid(tmp_path / "b.tif")
    ok = np.isfinite(a)
    assert np.array_equal(ok, np.isfinite(b)) and np.allclose(a[ok], b[ok])


def test_heights_are_measurable_by_the_change_pipelines(tmp_path):
    spec = S.GridSpec(412000.0, 3245020.0, 0.5, 40, 30)
    z = np.add.outer(np.arange(30) * 0.01, np.arange(40) * 0.02) + 25.0
    z[3, 4] = np.nan
    raw = tmp_path / "dsm.tif"
    with S.write_tif(raw, spec, 32639, 1, "float32", S.NODATA) as ds:
        ds.write(np.where(np.isfinite(z), z, S.NODATA).astype(np.float32), 1)
    project = tmp_path / "project"
    S.write_height_grid(raw, project / "sources", "r1-dsm", spec, 32639)
    g = grid_source(project, {"id": "r1-dsm", "name": "DSM r1"}, {"crs": {"epsg": 32639}})
    h = g.heights()
    assert np.isnan(h[3, 4]) and np.nanmax(np.abs(h - z)) <= g.scale
    assert (g.x0, g.y1, g.res) == (412000.0, 3245020.0, 0.5)
    doc = json.loads((project / "sources" / "r1-dsm.json").read_text("utf-8"))
    assert doc["schema"] == "aio.grid/1" and doc["kind"] == "dsm"


def test_the_shaded_relief_is_rgba_with_empty_cells_clear(tmp_path):
    spec = S.GridSpec(0.0, 10.0, 0.5, 20, 20)
    raw = tmp_path / "z.tif"
    z = np.full((20, 20), 5.0, np.float32)
    z[:, 10:] = 8.0
    z[0, 0] = S.NODATA
    with S.write_tif(raw, spec, None, 1, "float32", S.NODATA) as ds:
        ds.write(z, 1)
    out = tmp_path / "shaded.tif"
    legend = S.shaded_tif(raw, out, spec, None, lambda: None)
    assert legend["legend"]["unit"] == "m"
    with rasterio.open(out) as ds:
        rgba = ds.read()
    assert rgba.shape == (4, 20, 20) and rgba[3, 0, 0] == 0 and rgba[3, 5, 5] == 255
    assert tuple(rgba[:3, 5, 2]) != tuple(rgba[:3, 5, 15])


def test_the_pdal_ground_pipeline_classifies_then_grids(tmp_path):
    spec = S.GridSpec(100.0, 50.0, 0.5, 40, 20)
    p = S.pdal_dtm_pipeline(tmp_path / "c.las", tmp_path / "g.tif", spec, 32639)["pipeline"]
    types = [s["type"] for s in p]
    assert types == ["readers.las", "filters.assign", "filters.smrf", "filters.range", "writers.gdal"]
    assert p[3]["limits"] == "Classification[2:2]" and p[4]["resolution"] == 0.5
    assert p[0]["override_srs"] == "EPSG:32639"


@pytest.fixture(scope="module")
def processed():
    return ps.processed()


def test_the_processed_dsm_and_dtm_meet_the_targets(processed):
    root, _, _ = processed
    rd = root / "photogrammetry" / ps.RUN
    o = np.array(ps.ORIGIN)
    for name in ("dsm", "dtm"):
        with rasterio.open(rd / f"{name}.tif") as ds:
            z = ds.read(1, masked=True).filled(np.nan).astype(float)
            t = ds.transform
        rows, cols = np.mgrid[0 : z.shape[0], 0 : z.shape[1]]
        x = t.c + (cols + 0.5) * t.a - o[0]
        y = t.f + (rows + 0.5) * t.e - o[1]
        inner = (np.abs(x) < 24) & (np.abs(y) < 18)
        x0, x1, y0, y1, _ = ps.BOX
        b = 2 * t.a  # building edges buffered by two cells
        edge = (x > x0 - b) & (x < x1 + b) & (y > y0 - b) & (y < y1 + b)
        edge &= ~((x > x0 + b) & (x < x1 - b) & (y > y0 + b) & (y < y1 - b))
        ok = inner & ~edge
        assert np.isfinite(z[ok]).mean() > 0.98
        if name == "dsm":
            err = (z - (ps.dsm(x, y) + o[2]))[ok & np.isfinite(z)]
            assert np.sqrt(np.mean(err**2)) < 3 * ps.GSD
            # the stockpile's volume from the new DSM, over the true ground
            cx, cy, r, _ = ps.PILE
            m = np.hypot(x - cx, y - cy) < r + 1
            vol = np.nansum(np.clip(z[m] - (ps.ground(x[m], y[m]) + o[2]), 0, None)) * t.a * t.a
            assert abs(vol / ps.pile_volume() - 1) < 0.02
        else:
            g = ps.ground(x, y) + o[2]
            assert abs(float(np.nanmean((z - g)[ps.in_box(x, y) & ok]))) < 0.2  # the building is gone
            cx, cy, r, h = ps.PILE
            centre = (np.hypot(x - cx, y - cy) < r / 2) & ok
            assert float(np.nanmean((z - g)[centre])) < 0.25 * h  # most of the pile is gone
