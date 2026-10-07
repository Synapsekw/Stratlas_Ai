"""photo/crs.py: PROJ conversions, ENU and grid frames, geoid grids (synthetic points only)."""

import math

import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin

from aio_pipelines.photo import crs as C
from aio_pipelines.runtime import JobError

# A point of the fictional desert site (UTM zone 39N), as the other synthetic fixtures use.
LON, LAT = 51.4321, 25.1234


def ecef_closed_form(lon, lat, h):
    a, f = C.WGS84_A, C.WGS84_F
    e2 = f * (2 - f)
    lo, la = math.radians(lon), math.radians(lat)
    n = a / math.sqrt(1 - e2 * math.sin(la) ** 2)
    return np.array(
        [
            (n + h) * math.cos(la) * math.cos(lo),
            (n + h) * math.cos(la) * math.sin(lo),
            (n * (1 - e2) + h) * math.sin(la),
        ]
    )


def test_utm_zone_of_the_site_and_the_exceptions():
    assert C.utm_epsg(LON, LAT) == 32639
    assert C.utm_epsg(-74.0, 40.7) == 32618
    assert C.utm_epsg(151.2, -33.9) == 32756
    assert C.utm_epsg(5.5, 60.0) == 32632  # Norway
    assert C.utm_epsg(15.0, 78.0) == 32633  # Svalbard


def test_ecef_through_proj_matches_the_closed_form_to_a_millimetre():
    got = C.geodetic_to_ecef([LON], [LAT], [37.5])[0]
    assert np.abs(got - ecef_closed_form(LON, LAT, 37.5)).max() < 1e-3


def test_a_utm_39n_point_round_trips_through_wgs84_and_ecef_within_a_millimetre():
    e0, n0, h0 = 545_123.456, 2_778_901.234, 12.345
    lon, lat = C.crs_to_geodetic(32639, [e0], [n0])
    ecef = C.geodetic_to_ecef(lon, lat, [h0])
    lon2, lat2, h2 = C.ecef_to_geodetic(ecef)
    e2, n2 = C.geodetic_to_crs(32639, lon2, lat2)
    assert abs(e2[0] - e0) < 1e-3 and abs(n2[0] - n0) < 1e-3 and abs(h2[0] - h0) < 1e-3


def test_enu_frame_is_metric_and_round_trips():
    f = C.EnuFrame(LON, LAT, 10.0)
    assert np.allclose(f.from_geodetic([LON], [LAT], [10.0]), 0, atol=1e-6)
    # 100 m north along the meridian is 100 m in ENU, not 100 m times a grid scale factor
    pts = np.array([[0.0, 100.0, 0.0], [250.0, -40.0, 30.0]])
    back = f.from_geodetic(*f.to_geodetic(pts))
    assert np.abs(back - pts).max() < 1e-6
    rot = f.rotation
    assert np.allclose(rot @ rot.T, np.eye(3))


def test_grid_and_enu_differ_by_the_grid_scale_factor_and_convergence():
    enu = C.EnuFrame(LON, LAT, 0.0)
    e, n = C.geodetic_to_crs(32639, [LON], [LAT])
    grid = C.GridFrame(C.crs_of(32639), (float(e[0]), float(n[0]), 0.0))
    g = C.enu_to_grid(enu, grid, np.array([[0.0, 0.0, 0.0], [1000.0, 0.0, 0.0]]))
    d = np.linalg.norm(g[1] - g[0])
    # UTM scale near the central meridian is about 0.9996: a kilometre is about 0.4 m short
    assert 0.9995 < d / 1000.0 < 1.0002 and abs(d - 1000) > 0.01
    back = C.grid_to_enu(enu, grid, g)
    assert np.abs(back - [[0, 0, 0], [1000, 0, 0]]).max() < 1e-4


def test_rotations_carry_through_the_grid_conversion():
    enu = C.EnuFrame(LON, LAT, 0.0)
    e, n = C.geodetic_to_crs(32639, [LON], [LAT])
    grid = C.GridFrame(C.crs_of(32639), (float(e[0]), float(n[0]), 0.0))
    # a nadir camera (looking down, image up = north) 60 m up
    r = np.array([[[1.0, 0, 0], [0, -1.0, 0], [0, 0, -1.0]]])
    c = np.array([[100.0, 50.0, 60.0]])
    c2, r2 = C.transform_rotations(lambda p: C.enu_to_grid(enu, grid, p), c, r)
    assert np.allclose(r2[0] @ r2[0].T, np.eye(3), atol=1e-9)
    # still looking down; turned by the meridian convergence only (well under a degree here)
    assert r2[0][2] @ np.array([0, 0, -1.0]) > 0.9999
    angle = math.degrees(math.acos(np.clip(np.trace(r[0].T @ r2[0]) / 2 - 0.5, -1, 1)))
    assert 0.0 < angle < 1.0
    c3, r3 = C.transform_rotations(lambda p: C.grid_to_enu(enu, grid, p), c2, r2)
    assert np.abs(c3 - c).max() < 1e-4 and np.abs(r3 - r).max() < 1e-7


def _constant_grid(path, value):
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=361,
        height=181,
        count=1,
        dtype="float32",
        crs="EPSG:4326",
        transform=from_origin(-180.5, 90.5, 1, 1),
    ) as d:
        d.write(np.full((181, 361), value, np.float32), 1)
    return path


def test_ellipsoidal_to_orthometric_uses_the_named_grid(tmp_path):
    grid = _constant_grid(tmp_path / "test_geoid.tif", -25.0)
    got = C.ellipsoidal_to_orthometric([LON], [LAT], [10.0], grid)
    assert got[0] == pytest.approx(35.0, abs=1e-6)  # H = h - N
    assert C.orthometric_to_ellipsoidal([LON], [LAT], got, grid)[0] == pytest.approx(10.0, abs=1e-6)


def test_a_missing_geoid_grid_is_refused_never_passed_through(monkeypatch, tmp_path):
    monkeypatch.setenv(C.GEOID_DIR_ENV, str(tmp_path))
    monkeypatch.delenv("PROJ_DATA", raising=False)
    monkeypatch.delenv("PROJ_LIB", raising=False)
    if C.geoid_grid("egm2008") is not None:
        pytest.skip("an EGM2008 grid is installed on this machine")
    with pytest.raises(JobError, match="not installed"):
        C.ellipsoidal_to_orthometric([LON], [LAT], [10.0], "egm2008")


def test_egm2008_reference_value_when_the_grid_is_installed():
    if C.geoid_grid("egm2008") is None:
        pytest.skip("the EGM2008 grid ships with the pipeline pack (G1); not installed here")
    # EGM2008 undulation at 0 N 0 E is about +17.2 m (published reference)
    h = C.ellipsoidal_to_orthometric([0.0], [0.0], [0.0], "egm2008")[0]
    assert -17.4 < h < -17.0


def test_crs_records_and_errors():
    assert C.crs_record(C.crs_of({"epsg": 32639})) == {"epsg": 32639}
    with pytest.raises(JobError):
        C.crs_of({"nothing": 1})
    with pytest.raises(JobError):
        C.crs_of("EPSG:999999")
    assert C.haversine_m([LON], [LAT], [LON], [LAT + 0.001])[0] == pytest.approx(111.3, abs=0.5)
