"""M11 G1: the site's PROJ pipeline, its tables, geoid refusals and the EPSG catalogue rows."""

from __future__ import annotations

import json
import math
import os
from pathlib import Path

import numpy as np
import pytest

from aio_pipelines.geodesy import site
from aio_pipelines.geodesy.site import (
    calibration_pipeline,
    geoid_file,
    proj_network_enabled,
    site_pipeline,
    undulation,
    write_site_tables,
)
from aio_pipelines.runtime import JobError
from geodesy_synth import FIXTURES, GEOID_ID, fixture_sites, known_calibration, synthetic_geoid


@pytest.fixture(scope="module")
def geoid_dir(tmp_path_factory) -> Path:
    d = tmp_path_factory.mktemp("geoid")
    synthetic_geoid(d)
    return d


def test_proj_network_is_off():
    site.network_off()
    assert os.environ["PROJ_NETWORK"] == "OFF"
    assert proj_network_enabled() is False


def test_a_missing_geoid_pack_is_refused_by_name(tmp_path):
    with pytest.raises(JobError, match="needs the AUSGeoid2020 geoid pack"):
        site_pipeline({"epsg": 32639}, {"verticalDatum": {"kind": "geoid", "geoid": "AUSGeoid2020"}})
    with pytest.raises(JobError, match="needs the AUSGeoid2020 geoid pack"):
        geoid_file("AUSGeoid2020", [tmp_path])


def test_a_missing_horizontal_grid_is_refused_not_approximated():
    # OSTN15 is not installed offline: never fall back to the 2 m Helmert
    with pytest.raises(JobError, match=r"uk_os_OSTN15_NTv2_OSGBtoETRS\.tif"):
        site_pipeline({"epsg": 32630}, {"crs": {"epsg": 27700}, "verticalDatum": {"kind": "project"}})


def test_geoid_undulation_comes_from_the_grid_through_proj(geoid_dir):
    grid = geoid_file(GEOID_ID, [geoid_dir])
    # a grid node: N = -25 + 2 sin(7 lon) + 1.5 cos(5 lat), stored as float32
    lon, lat = 51.5, 25.3
    expected = -25.0 + 2.0 * math.sin(math.radians(lon) * 7.0) + 1.5 * math.cos(math.radians(lat) * 5.0)
    n = undulation(grid, [lon], [lat])[0]
    assert n == pytest.approx(np.float32(expected), abs=1e-6)
    # ellipsoidal to orthometric on the site pipeline: H = h - N
    pipe = site_pipeline(
        {"epsg": 4326},
        {"verticalDatum": {"kind": "geoid", "geoid": GEOID_ID}},
        geoid_dirs_extra=[geoid_dir],
    )
    _, _, h = pipe.to_site([lon], [lat], [100.0])
    assert h[0] == pytest.approx(100.0 - n, abs=1e-6)
    # outside the grid: no height, never the ellipsoid
    assert np.isnan(undulation(grid, [10.0], [10.0])[0])


def test_heights_stored_on_one_geoid_are_shown_on_another(geoid_dir):
    pipe = site_pipeline(
        {"epsg": 4326},
        {"verticalDatum": {"kind": "ellipsoidal"}},
        stored_geoid=GEOID_ID,
        geoid_dirs_extra=[geoid_dir],
    )
    n = undulation(geoid_file(GEOID_ID, [geoid_dir]), [50.0], [25.0])[0]
    _, _, h = pipe.to_site([50.0], [25.0], [10.0])
    assert h[0] == pytest.approx(10.0 + n, abs=1e-6)


def test_the_calibration_pipeline_is_the_controller_model():
    cal = known_calibration({"epsg": 32639})
    from pyproj import Transformer

    t = Transformer.from_pipeline(calibration_pipeline(cal))
    h, v = cal["horizontal"], cal["vertical"]
    rng = np.random.default_rng(1)
    for _ in range(50):
        e, n, z = 10000 + rng.uniform(-500, 500), 20000 + rng.uniform(-500, 500), rng.uniform(0, 50)
        de, dn = e - h["originE"], n - h["originN"]
        c, s = math.cos(h["rotationRad"]), math.sin(h["rotationRad"])
        le = h["originE"] + h["shiftE"] + h["scale"] * (c * de - s * dn)
        ln = h["originN"] + h["shiftN"] + h["scale"] * (s * de + c * dn)
        lz = z + v["shiftM"] + v["slopeN"] * (ln - v["originN"]) + v["slopeE"] * (le - v["originE"])
        x, y, zz = t.transform(e, n, z)
        assert x == pytest.approx(le, abs=1e-9)
        assert y == pytest.approx(ln, abs=1e-9)
        assert zz == pytest.approx(lz, abs=1e-9)


def test_write_site_tables_writes_the_contract(tmp_path, geoid_dir):
    sites = fixture_sites(geoid_dir)
    s = sites["calibrated-local"]
    header = write_site_tables(
        tmp_path,
        data_crs=s["data_crs"],
        settings=s["settings"],
        extent=s["extent"],
        calibration=s["calibration"],
        geoid_dirs_extra=[geoid_dir],
    )
    out = tmp_path / "survey" / "geodesy"
    on_disk = json.loads((out / "site-transform.json").read_text(encoding="utf-8"))
    assert on_disk == header
    assert header["schema"] == "aio.site-transform/1"
    assert header["calibration"] == "cal-synth" and header["geoid"] == GEOID_ID
    g = header["grid"]
    assert (out / g["file"]).stat().st_size == g["rows"] * g["cols"] * 2 * 8
    gg = header["geoidGrid"]
    assert (out / gg["file"]).stat().st_size == gg["rows"] * gg["cols"] * 8
    assert "proj4" not in header  # a calibrated site always reads the tables
    # the lower-left cell is the extent's corner, rows run north
    vals = np.frombuffer((out / g["file"]).read_bytes(), dtype="<f8").reshape(g["rows"], g["cols"], 2)
    pipe = site_pipeline(s["data_crs"], s["settings"], s["calibration"], geoid_dirs_extra=[geoid_dir])
    x, y, _ = pipe.to_site([g["originX"] + 3], [g["originY"] + 5])
    assert vals[5, 3, 0] == pytest.approx(x[0], abs=1e-9)
    assert vals[5, 3, 1] == pytest.approx(y[0], abs=1e-9)
    # a change of input changes the fingerprint
    again = write_site_tables(
        tmp_path,
        data_crs=s["data_crs"],
        settings={**s["settings"], "verticalDatum": {"kind": "project"}},
        extent=s["extent"],
        calibration=s["calibration"],
        geoid_dirs_extra=[geoid_dir],
    )
    assert again["fingerprint"] != header["fingerprint"]
    assert "geoid" not in again


def test_a_large_site_gets_a_coarser_table(tmp_path):
    header = write_site_tables(
        tmp_path,
        data_crs={"epsg": 32639},
        settings={"verticalDatum": {"kind": "project"}},
        extent=(250000.0, 2790000.0, 253000.0, 2793000.0),
    )
    assert header["grid"]["spacingM"] == 4.0
    assert header["grid"]["rows"] * header["grid"]["cols"] <= site.MAX_CELLS
    assert "geoidGrid" not in header


def test_the_committed_parity_fixtures_are_what_proj_gives_now(geoid_dir):
    for name, s in fixture_sites(geoid_dir).items():
        points = json.loads((FIXTURES / name / "points.json").read_text(encoding="utf-8"))["points"]
        assert len(points) == 1000
        pts = np.array(points[:100])
        pipe = site_pipeline(s["data_crs"], s["settings"], s["calibration"], geoid_dirs_extra=[geoid_dir])
        x, y, z = pipe.to_site(pts[:, 0], pts[:, 1], pts[:, 2])
        assert np.max(np.hypot(x - pts[:, 3], y - pts[:, 4])) < 1e-5, name
        assert np.max(np.abs(z - pts[:, 5])) < 1e-5, name


def test_us_survey_feet_are_converted_at_the_proj_edge():
    pipe = site_pipeline({"epsg": 26916}, {"crs": {"epsg": 2240}, "verticalDatum": {"kind": "project"}})
    assert pipe.to_scale == 1200 / 3937
    from pyproj import Transformer

    ft = Transformer.from_crs(26916, 2240, always_xy=True).transform(741000.0, 3734000.0)
    x, y, _ = pipe.to_site([741000.0], [3734000.0])
    assert x[0] == pytest.approx(ft[0] * 1200 / 3937, abs=1e-9)
    assert y[0] == pytest.approx(ft[1] * 1200 / 3937, abs=1e-9)


def test_catalogue_rows_carry_the_proj4_check():
    from aio_pipelines.geodesy.catalogue import build_catalogue

    rows = {r["code"]: r for r in build_catalogue()}
    georgia = rows[2240]
    assert georgia["unit"] == "US survey foot" and georgia["kind"] == "projected"
    check = georgia["_check"]
    assert len(check["samples"]) == 25
    assert check["toMetre"] == pytest.approx(1200 / 3937)
    assert rows[3855]["kind"] == "vertical"
    assert rows[4326]["kind"] == "geographic"
    assert "_check" not in rows[4326]
