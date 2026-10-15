"""photo/surface.py: height grids written by windows, COGs, the shaded relief and the measurable
heights."""

from __future__ import annotations

import json

import numpy as np
import rasterio
from rasterio.windows import Window

from aio_pipelines.change.sources import grid_source
from aio_pipelines.photo import surface as S


def test_a_grid_is_written_by_windows_and_copied_to_a_cog(tmp_path):
    spec = S.GridSpec.around((500000, 3000000), (500030, 3000020), 0.25)
    raw = tmp_path / "dsm-raw.tif"
    with S.write_tif(raw, spec, 32639, 1, "float32", S.NODATA) as ds:
        for c0, r0, w, h in spec.windows(17):  # windows that do not divide the grid
            xs, _ = spec.centres(c0, r0, w, h)
            ds.write((10 + 0.1 * (xs - 500000)).astype(np.float32), 1, window=Window(c0, r0, w, h))
    cog = tmp_path / "dsm.tif"
    S.to_cog(raw, cog)
    with rasterio.open(cog) as ds:
        assert ds.crs.to_epsg() == 32639 and ds.nodata == S.NODATA
        assert ds.tags(ns="IMAGE_STRUCTURE").get("LAYOUT") == "COG"
        z = ds.read(1, masked=True)
        assert abs(float(z[40, 60]) - (10 + 0.1 * (60.5 * 0.25))) < 0.06


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
