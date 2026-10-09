"""survey.export (M11 G7, SRV-9, DSN-5): the what by format matrix, frames, units, the statement
every export carries, measurements, contours, boundaries, orthos, differences and sections.

Analytic truths only: a plane (exact under bilinear sampling), a cone, G6's pad, G1's synthetic
geoid and calibration (``geodesy_synth.py``).
"""

from __future__ import annotations

import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from aio_pipelines.design.csv_points import read_csv_points  # noqa: E402
from aio_pipelines.design.dxf import read_dxf  # noqa: E402
from aio_pipelines.design.importer import DesignImport  # noqa: E402
from aio_pipelines.design.landxml import read_landxml  # noqa: E402
from aio_pipelines.design.tin_io import encode_tin, read_tin  # noqa: E402
from aio_pipelines.export.frame import build_frame, name_suffix  # noqa: E402
from aio_pipelines.geodesy.site import site_pipeline  # noqa: E402
from aio_pipelines.runtime import JobError  # noqa: E402
from aio_pipelines.survey.export import SurveyExport  # noqa: E402
from conftest import run_job  # noqa: E402
from export_fixtures import (  # noqa: E402
    CELL,
    GE,
    GN,
    NX,
    NY,
    cone,
    full_project,
    plane,
    project,
    write_json,
)

ROOT = HERE.parents[1]
NAMES = json.loads(
    (
        ROOT / "apps" / "desktop" / "src" / "renderer" / "survey" / "__fixtures__" / "export-names.json"
    ).read_text("utf-8")
)


def run(root: Path, out: Path, job: str = "j1", **params) -> dict:
    res, _ = run_job(SurveyExport(), root, {"crs": "site", **params, "out": str(out)}, job_id=job)
    return res["outputs"]["export"]


def files_outside_jobs(root: Path) -> set[str]:
    return {
        str(p.relative_to(root))
        for p in root.rglob("*")
        if p.is_file() and p.relative_to(root).parts[0] != "jobs"
    }


# ------------------------------------------------------------------------------------ the rules


@pytest.mark.parametrize("case", NAMES["cases"], ids=lambda c: c["suffix"])
def test_the_file_name_suffix_is_the_shared_rule(case):
    assert (
        name_suffix(case["crs"], case["calibrated"], case["vertical"], case["geoid"], case["units"])
        == case["suffix"]
    )


@pytest.mark.parametrize(
    ("params", "message"),
    [
        ({"what": "ortho", "format": "dxf", "layer": "o"}, "ortho exports as geotiff"),
        ({"what": "cloud", "format": "geotiff", "layer": "c"}, "cloud exports as laz"),
        ({"what": "surface", "format": "laz", "surface": "plane"}, "surface exports as"),
        ({"what": "surface", "format": "kml", "surface": "plane"}, "WGS 84"),
        ({"what": "surface", "format": "dxf", "surface": "plane", "units": "mm"}, "metres"),
        (
            {"what": "surface", "format": "dxf", "surface": "plane", "layer": "x"},
            "one of surface, layer or overlay",
        ),
        ({"what": "surface", "format": "dxf"}, "one of surface, layer or overlay"),
        ({"what": "ortho", "format": "geotiff"}, "needs the layer"),
        ({"what": "contours", "format": "dxf", "layer": "x"}, "surface or a contours overlay"),
        ({"what": "measurements", "format": "csv", "overlay": "x"}, "takes measurements"),
        ({"what": "surface", "format": "dxf", "surface": "plane", "decimate": 0}, "decimate"),
        ({"what": "surface", "format": "dxf", "surface": "plane", "crs": "local"}, "crs must be"),
        ({"what": "surface", "format": "dxf", "surface": "plane", "crs": {"epsg": True}}, "crs must be"),
        ({"what": "surface", "format": "dxf", "surface": "plane", "out": "relative/x.dxf"}, "absolute"),
    ],
)
def test_what_does_not_fit_is_refused_with_the_reason(params, message):
    p = {"crs": "site", "out": str(Path.cwd().anchor + "x.out"), **params}
    with pytest.raises(JobError, match=message):
        SurveyExport().validate(p)


def test_cad_formats_need_a_grid_and_files_with_a_crs_hold_its_unit(tmp_path):
    root = full_project(tmp_path)
    with pytest.raises(JobError, match="need grid coordinates"):
        build_frame(root, "wgs84", "landxml")
    with pytest.raises(JobError, match="UTM zone 39N is in metres"):
        build_frame(root, "site", "geotiff", "us-ft")
    f = build_frame(root, "site", "dxf", "us-ft")
    assert f.suffix == "_site-grid_usft" and f.horizontal == "us-ft" and f.units == "us-ft"
    g = build_frame(root, "wgs84", "geotiff")
    assert g.geographic and g.horizontal is None and g.suffix == "_wgs84_m"


def test_a_file_destination_is_written_and_nothing_is_left_in_the_project(tmp_path):
    root = full_project(tmp_path)
    before = files_outside_jobs(root)
    out_dir = tmp_path / "out"
    out_dir.mkdir()
    for k, (fmt, ext) in enumerate((("landxml", "xml"), ("dxf", "dxf"), ("12da", "12da"), ("csv", "csv"))):
        res = run(root, out_dir / f"pad.{ext}", f"j{k}", what="surface", format=fmt, layer="pad")
        assert res["suffix"] == "_site-grid_m" and res["files"] == [str(out_dir / f"pad.{ext}")]
    assert files_outside_jobs(root) == before
    with pytest.raises(JobError, match="Choose a file"):
        run(root, out_dir, "j9", what="surface", format="dxf", layer="pad")


# --------------------------------------------------------------------- every export states its frame


STATEMENT = ("WGS 84 / UTM zone 39N", "Project heights", "metres")


@pytest.mark.parametrize(
    ("fmt", "ext", "where"),
    [
        ("landxml", "xml", "file"),
        ("dxf", "dxf", "file"),
        ("12da", "12da", "file"),
        ("csv", "csv", "note"),
        ("geojson", "geojson", "file"),
        ("shp", "shp", "note"),
        ("geotiff", "tif", "note"),
    ],
)
def test_every_export_states_crs_datum_geoid_calibration_and_units(tmp_path, fmt, ext, where):
    root = full_project(tmp_path)
    out = tmp_path / f"plane_site-grid_m.{ext}"
    res = run(root, out, what="surface", format=fmt, surface="plane", decimate=0.25)
    assert res["crs"]["crs"] == "Site grid: WGS 84 / UTM zone 39N (EPSG:32639)"
    assert res["crs"]["verticalDatum"] == "Project heights, as stored" and res["crs"]["units"] == "metres"
    text = (out if where == "file" else out.with_suffix(".txt")).read_bytes().decode("utf-8", "replace")
    for word in STATEMENT:
        assert word in text, (fmt, word)
    if fmt == "dxf":
        prop = "\n  9\n$CUSTOMPROPERTY\n  1\nnone"
        assert f"Quadrion Geoid{prop}" in text and f"Quadrion Site calibration{prop}" in text
    elif where == "file" and fmt != "geojson":
        assert "Geoid: none" in text and "Site calibration: none" in text


def test_kml_is_wgs84_with_the_statement(tmp_path):
    root = full_project(tmp_path)
    out = tmp_path / "m_wgs84_m.kmz"
    res = run(root, out, crs="wgs84", what="measurements", format="kml")
    import zipfile

    doc = ET.fromstring(zipfile.ZipFile(out).read("doc.kml"))
    ns = {"k": "http://www.opengis.net/kml/2.2"}
    assert "Coordinate system: WGS 84" in doc.find("k:Document/k:description", ns).text
    coords = [c.text.split() for c in doc.iter("{http://www.opengis.net/kml/2.2}coordinates")]
    lon, lat, _ = map(float, coords[0][0].split(","))
    assert 51 < lon < 52 and 24 < lat < 25 and res["suffix"] == "_wgs84_m"


# ----------------------------------------------------------------- geoid, calibration, feet frames


def test_geoid_heights_and_a_calibrated_grid_go_through_g1s_pipeline(tmp_path, monkeypatch):
    from geodesy_synth import GEOID_ID, fixture_sites, synthetic_geoid

    geoids = tmp_path / "geoids"
    synthetic_geoid(geoids)
    monkeypatch.setenv("QUADRION_GEOID_DIRS", str(geoids))
    site = fixture_sites(geoids)["calibrated-local"]
    cal = {**site["calibration"], "appliedAt": "2026-10-09T00:00:00Z", "rmsH": 0.004, "rmsV": 0.006}
    root = project(tmp_path, crs=site["data_crs"], settings=site["settings"], calibration=cal)
    e0, n0 = site["extent"][:2]
    v = np.asarray([[e0, n0, 10.0], [e0 + 40, n0, 11.0], [e0 + 40, n0 + 40, 12.5], [e0, n0 + 40, 11.5]])
    t = np.asarray([[0, 1, 2], [0, 2, 3]], dtype=np.uint32)
    folder = root / "survey" / "designs" / "d"
    folder.mkdir(parents=True)
    (folder / "s.tin").write_bytes(encode_tin(v, t, site["data_crs"]))
    write_json(
        root / "survey" / "designs.json",
        {
            "schema": "aio.designs/1",
            "designs": [
                {
                    "id": "d",
                    "name": "D",
                    "layers": [
                        {"id": "s", "name": "S", "kind": "surface", "file": "s.tin", "verticalOffsetM": 0}
                    ],
                }
            ],
        },
    )
    out = tmp_path / "s_site-grid-cal_cal_m.xml"
    res = run(root, out, what="surface", format="landxml", layer="d")
    assert res["suffix"] == "_site-grid-cal_cal_m"
    assert res["crs"]["calibration"] == "Synthetic site calibration, residuals H 4 mm, V 6 mm"
    assert res["crs"]["geoid"] == GEOID_ID and res["crs"]["epsg"] is None
    d = read_landxml(out)
    assert d.crs is None  # a calibrated grid has no EPSG code
    pipe = site_pipeline(site["data_crs"], site["settings"], cal)
    x, y, z = pipe.to_site(v[:, 0], v[:, 1], v[:, 2])
    got = d.surfaces[0].vertices
    assert np.allclose(got[:, 0], x, atol=1e-9, rtol=0) and np.allclose(got[:, 1], y, atol=1e-9, rtol=0)
    assert np.allclose(got[:, 2], z, atol=1e-9, rtol=0)
    text = out.read_text("utf-8")
    assert "Orthometric" not in text and f"on the {GEOID_ID} geoid" in text
    # back through the calibration: in place, heights on the calibration's geoid (the plane removed)
    back = project(tmp_path, "back", crs=site["data_crs"], settings=site["settings"], calibration=cal)
    run_job(DesignImport(), back, {"src": str(out), "id": "d", "useCalibration": True})
    tin = read_tin(next((back / "survey" / "designs" / "d").glob("*.tin")))
    assert np.allclose(tin.vertices[:, :2], v[:, :2], atol=1e-6, rtol=0)
    geoid_only = site_pipeline(
        site["data_crs"],
        {**site["settings"], "verticalDatum": {"kind": "geoid", "geoid": GEOID_ID}, "calibration": None},
        None,
    )
    _, _, h = geoid_only.to_site(v[:, 0], v[:, 1], v[:, 2])
    assert np.allclose(tin.vertices[:, 2], h, atol=1e-6, rtol=0)
    # in WGS 84 the calibration's heights become ellipsoidal heights, and the file says so
    g = run(root, tmp_path / "s.geojson", "j2", crs="wgs84", what="surface", format="geojson", layer="d")
    assert g["suffix"] == "_wgs84_ellh_m" and g["crs"]["verticalDatum"].startswith("Ellipsoidal heights")
    gj = json.loads((tmp_path / "s.geojson").read_text("utf-8"))
    assert "crs" not in gj and gj["metadata"]["calibration"] is None
    ring = gj["features"][0]["geometry"]["coordinates"][0]
    assert sorted(round(p[2], 9) for p in ring[:-1]) == sorted(v[:, 2].tolist())


# ------------------------------------------------------------------------------ measurements


def test_measurements_as_points_outlines_and_files_per_measurement(tmp_path):
    root = full_project(tmp_path)
    ms = json.loads((root / "survey" / "measurements.json").read_text("utf-8"))["measurements"]
    # CSV: every vertex, PNEZD, read back by the design importer's CSV reader
    run(root, tmp_path / "m.csv", what="measurements", format="csv")
    d = read_csv_points(tmp_path / "m.csv")
    pts = d.points[0].points
    want = [(p[0], p[1], p[2]) for m in ms for p in m["points"]]
    assert [(p.e, p.n, p.z) for p in pts] == want
    assert [p.id for p in pts][:2] == ["Pile A-1", "Pile A-2"] and pts[0].code == "volume"
    assert (tmp_path / "m.txt").read_text("utf-8").startswith("Coordinate system:")
    # GeoJSON: a polygon, a line and a point with their labels
    run(root, tmp_path / "m.geojson", "j2", what="measurements", format="geojson")
    gj = json.loads((tmp_path / "m.geojson").read_text("utf-8"))
    assert [f["geometry"]["type"] for f in gj["features"]] == ["Polygon", "LineString", "Point"]
    assert gj["crs"]["properties"]["name"] == "urn:ogc:def:crs:EPSG::32639"
    assert gj["features"][0]["properties"]["folder"] == "Stockpiles"
    # a folder: one file per measurement, the suffix in each name
    folder = tmp_path / "each"
    folder.mkdir()
    res = run(root, folder, "j3", what="measurements", format="dxf", measurements=["m-poly", "m-pt"])
    assert sorted(Path(f).name for f in res["files"]) == ["Pile-A_site-grid_m.dxf", "Spot-1_site-grid_m.dxf"]
    dd = read_dxf(folder / "Pile-A_site-grid_m.dxf")
    (line,) = dd.linework[0].lines
    assert line.closed and np.array_equal(line.coords, np.asarray(ms[0]["points"]))


def test_a_polygon_with_a_surface_exports_the_terrain_inside_it(tmp_path):
    root = full_project(tmp_path)
    out = tmp_path / "pile.xml"
    run(root, out, what="measurements", format="landxml", measurements=["m-poly"], surface="plane")
    d = read_landxml(out)
    (s,) = d.surfaces
    assert s.name == "Pile A surface" and len(s.triangles) > 100
    # prepared tiles hold float32 heights over a float64 base (0.06 mm at a 1,000 m range)
    assert np.allclose(s.vertices[:, 2], plane(s.vertices[:, 0], s.vertices[:, 1]), atol=2e-5, rtol=0)
    inside = (s.vertices[:, 0] >= GE + 20) & (s.vertices[:, 0] <= GE + 40) & (s.vertices[:, 1] >= GN + 15)
    assert inside.all()
    assert [k for k, _ in s.chains] == [1]  # the polygon is the outer boundary
    assert [p.id for p in d.points[0].points] == ["Pile A-1", "Pile A-2", "Pile A-3", "Pile A-4"]


# ------------------------------------------------------------------------------- contours etc.


def test_contours_from_a_surface_as_dxf_and_shp(tmp_path):
    import ezdxf
    import shapefile

    root = full_project(tmp_path)
    res = run(root, tmp_path / "c.dxf", what="contours", format="dxf", surface="plane")
    assert res["minor"] == 0.5 and res["major"] == 2.5 and res["contours"] >= 2
    doc = ezdxf.readfile(tmp_path / "c.dxf")
    levels = sorted({round(e.dxf.elevation, 9) for e in doc.modelspace().query("LWPOLYLINE")})
    assert levels == [100.0, 100.5, 101.0]
    for e in doc.modelspace().query("LWPOLYLINE"):
        for x, y, *_ in e.get_points():
            assert abs(float(plane(np.array(x), np.array(y))) - e.dxf.elevation) < 1e-6
    run(root, tmp_path / "c.shp", "j2", what="contours", format="shp", surface="plane")
    with shapefile.Reader(str(tmp_path / "c.shp")) as r:
        assert r.shapeType == shapefile.POLYLINEZ and len(r) == res["contours"]
        assert sorted({round(rec["level"], 9) for rec in r.records()}) == [100.0, 100.5, 101.0]
    assert "UTM_Zone_39N" in (tmp_path / "c.prj").read_text("utf-8")


def test_terrain_boundary_and_design_outlines(tmp_path):
    import shapely

    root = full_project(tmp_path)
    run(root, tmp_path / "b.geojson", what="surface", format="geojson", surface="cone")
    gj = json.loads((tmp_path / "b.geojson").read_text("utf-8"))
    (f,) = gj["features"]
    poly = shapely.Polygon(np.asarray(f["geometry"]["coordinates"][0])[:, :2])
    # the posts with data: an L-shape (the cone survey has a hole in one corner)
    xs = GE + (np.arange(NX) + 0.5) * CELL
    ys = GN + (np.arange(NY) + 0.5) * CELL
    X, Y = np.meshgrid(xs, ys)
    ok = ~((X > GE + 50) & (Y > GN + 40))
    assert poly.area == pytest.approx(
        (ok[:-1, :-1] & ok[1:, 1:] & ok[:-1, 1:] & ok[1:, :-1]).sum() * CELL**2, rel=1e-3
    )
    run(root, tmp_path / "d.shp", "j2", what="surface", format="shp", layer="pad")
    assert sorted(p.name for p in tmp_path.glob("d_*.shp")) == [
        "d_lines.shp",
        "d_points.shp",
        "d_polygons.shp",
    ]


def test_difference_overlay_as_geotiff(tmp_path):
    import rasterio

    root = full_project(tmp_path)
    write_json(
        root / "survey" / "overlays.json",
        {
            "schema": "aio.survey-overlays/1",
            "overlays": [
                {
                    "id": "dz",
                    "name": "Cone minus plane",
                    "kind": "elevation",
                    "source": {
                        "comparison": {
                            "from": {"kind": "survey", "surface": "plane"},
                            "to": {"kind": "survey", "surface": "cone"},
                        }
                    },
                    "options": {},
                    "dir": "survey/overlays/dz",
                    "visible": True,
                    "fingerprint": "x",
                    "createdAt": "2026-10-09T00:00:00Z",
                }
            ],
        },
    )
    out = tmp_path / "dz.tif"
    run(root, out, what="surface", format="geotiff", overlay="dz")
    with rasterio.open(out) as ds:
        z = ds.read(1, masked=True)
        t = ds.transform
        assert ds.descriptions[0] == "difference"
    rows, cols = np.nonzero(~z.mask)
    e, n = t.c + (cols + 0.5) * t.a, t.f + (rows + 0.5) * t.e
    assert np.allclose(z[rows, cols], (cone(e, n) - plane(e, n)).astype(np.float32), atol=1e-5)
    assert "To surface minus the From surface" in out.with_suffix(".txt").read_text("utf-8")


def test_ortho_as_geotiff_keeps_its_pixels(tmp_path):
    import rasterio
    from PIL import Image

    rgb = np.zeros((40, 50, 3), np.uint8)
    rgb[..., 0] = np.arange(50)[None, :] * 5
    rgb[..., 1] = np.arange(40)[:, None] * 6
    rgb[..., 2] = 77
    layer = {
        "id": "ortho",
        "name": "Ortho",
        "kind": "raster",
        "role": "ortho",
        "format": "image",
        "src": {"path": "rasters/ortho.png"},
        "corners": {"tl": [-10.0, 0.0, -20.0], "tr": [15.0, 0.0, -20.0], "bl": [-10.0, 0.0, 0.0]},
    }
    root = project(tmp_path, layers=[layer])
    (root / "rasters").mkdir()
    Image.fromarray(rgb).save(root / "rasters" / "ortho.png")
    out = tmp_path / "ortho.tif"
    res = run(root, out, what="ortho", format="geotiff", layer="ortho")
    assert res["exactGrid"]
    with rasterio.open(out) as ds:
        assert ds.count == 4 and ds.crs.to_epsg() == 32639 and ds.transform.a == 0.5
        img = ds.read()
    assert np.abs(img[:3].transpose(1, 2, 0).astype(int) - rgb.astype(int)).max() <= 1
    assert (img[3] == 255).all()


def test_sections_along_line_measurements(tmp_path):
    root = full_project(tmp_path)
    run(root, tmp_path / "s.csv", what="section", format="csv", measurements=["m-line"], surface="plane")
    rows = (tmp_path / "s.csv").read_text("utf-8").splitlines()
    assert rows[0] == "section,chainage_m,e,n,z_m Plane survey"
    body = [r.split(",") for r in rows[1:]]
    e, n, z = (np.array([float(r[k]) for r in body]) for k in (2, 3, 4))
    assert np.allclose(z, plane(e, n), atol=2e-5, rtol=0)
    assert float(body[-1][1]) == pytest.approx(np.hypot(50, 30))
    with pytest.raises(JobError, match="line measurements"):
        run(root, tmp_path / "x.csv", "j2", what="section", format="csv", measurements=["m-pt"])


def test_a_grid_above_the_triangle_limit_is_refused_with_the_level_that_fits(tmp_path, monkeypatch):
    import aio_pipelines.export.tin as tin

    monkeypatch.setattr(tin, "MAX_TRIANGLES", 2000)
    root = full_project(tmp_path)
    with pytest.raises(JobError, match=r"level of detail of at most 0\.0625 \(one post in 4 each way\)"):
        run(root, tmp_path / "p.dxf", what="surface", format="dxf", surface="plane")
    res = run(root, tmp_path / "p.dxf", "j2", what="surface", format="dxf", surface="plane", decimate=1 / 16)
    assert res["faces"] <= 2000
    # a boundary is traced on the posts that fit, without asking
    run(root, tmp_path / "b.geojson", "j3", what="surface", format="geojson", surface="plane")
    (f,) = json.loads((tmp_path / "b.geojson").read_text("utf-8"))["features"]
    assert f["geometry"]["type"] == "Polygon"
