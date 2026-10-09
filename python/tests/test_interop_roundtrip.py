"""Interop round trips (M11 G7, plan "Review focus: interop fidelity"): what survey.export writes,
G6's importers read back as it was.

- LandXML and 12da surfaces out and back **identical** (the same floats, triangles and breaklines);
  LandXML alignments and CgPoints identical (lines, arcs and spirals to 1e-9 m, the equations exact);
- DXF 3DFACE surfaces out and back within 1e-6 m (in fact to the bit);
- GeoTIFF read back by rasterio with its CRS; LAS with its CRS (and LAZ through PDAL when present);
- a US survey feet CRS end to end: SI inside, feet only at the edges.
"""

from __future__ import annotations

import json
import math
import struct
import sys
from pathlib import Path

import numpy as np
import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from aio_pipelines.design import alignment as alg  # noqa: E402
from aio_pipelines.design.dxf import read_dxf  # noqa: E402
from aio_pipelines.design.importer import DesignImport  # noqa: E402
from aio_pipelines.design.landxml import read_landxml  # noqa: E402
from aio_pipelines.design.model import AlignmentSource, Line, Linework, Point, Points, Surface  # noqa: E402
from aio_pipelines.design.tin_io import read_tin  # noqa: E402
from aio_pipelines.design.twelve_da import read_12da  # noqa: E402
from aio_pipelines.export.landxml import write_landxml  # noqa: E402
from aio_pipelines.export.twelve_da import alignment_polyline, write_12da  # noqa: E402
from aio_pipelines.pointcloud import find_pdal  # noqa: E402
from aio_pipelines.runtime import JobError  # noqa: E402
from aio_pipelines.survey.export import SurveyExport  # noqa: E402
from conftest import run_job  # noqa: E402
from export_fixtures import (  # noqa: E402
    CELL,
    CRS,
    GE,
    GN,
    NX,
    NY,
    SHARED,
    full_project,
    pad_triangles,
    pad_vertices,
    plane,
    project,
)

US_FT = 1200 / 3937


def proj(src: dict, dst: dict, x, y) -> tuple[np.ndarray, np.ndarray]:
    """PROJ's own answer, in each CRS's own unit."""
    from pyproj import Transformer

    a, b = Transformer.from_crs(src["epsg"], dst["epsg"], always_xy=True).transform(x, y)
    return np.asarray(a), np.asarray(b)


def pad_surface() -> Surface:
    v = pad_vertices()
    return Surface("Pad top", v, pad_triangles(), [(0, v[[3, 4, 5]]), (1, v[[0, 2, 8, 6]])])


def shared_alignment() -> AlignmentSource:
    a = SHARED["alignment"]
    return AlignmentSource(
        a["name"], a["startStation"], [dict(e) for e in a["elements"]], list(a["equations"])
    )


def same_alignment(a: AlignmentSource, b: AlignmentSource, tol: float = 1e-9) -> None:
    assert a.name == b.name and a.start_station == b.start_station and a.equations == b.equations
    assert [e["type"] for e in a.elements] == [e["type"] for e in b.elements]
    for x, y in zip(a.elements, b.elements, strict=True):
        for key in ("start", "end", "center"):
            if key in x:
                assert np.allclose(x[key], y[key], atol=tol, rtol=0), key
        for key in ("length", "radius", "radiusStart", "radiusEnd", "dirStart"):
            if x.get(key) is not None:
                assert abs(x[key] - y[key]) < tol, (key, x[key], y[key])
            elif key in x:
                assert y.get(key) is None
        assert x.get("rot") == y.get("rot")


# ----------------------------------------------------------------------------------- LandXML


def test_landxml_surface_alignment_and_points_identical(tmp_path):
    s = pad_surface()
    pts = Points(
        "Control", [Point("CP1", 520005.0, 2750005.0, 99.5, "CTRL"), Point("CP2", 1.0 / 3, 2.0 / 7, 0.1)]
    )
    al = shared_alignment()
    p = tmp_path / "pad.xml"
    write_landxml(
        p,
        units="m",
        notes=["Coordinate system: test"],
        crs_name="WGS 84 / UTM zone 39N",
        epsg=32639,
        surfaces=[s],
        alignments=[al],
        points=[pts],
    )
    d = read_landxml(p)
    assert d.units == "m" and d.crs == CRS
    (got,) = d.surfaces
    assert got.name == "Pad top"
    assert np.array_equal(got.vertices, s.vertices) and np.array_equal(got.triangles, s.triangles)
    assert [k for k, _ in got.chains] == [0, 1]
    for (_, a), (_, b) in zip(got.chains, s.chains, strict=True):
        assert np.array_equal(a, b)
    (gp,) = d.points
    assert [(x.id, x.e, x.n, x.z, x.code) for x in gp.points] == [
        (x.id, x.e, x.n, x.z, x.code) for x in pts.points
    ]
    (ga,) = d.alignments
    same_alignment(al, ga)
    # stationing of the read alignment matches the shared truth (start station and equation)
    body = {"startStation": ga.start_station, "elements": ga.elements, "equations": ga.equations}
    for t in SHARED["truth"]:
        so = alg.station_offset(body, t["e"], t["n"])
        assert (
            so is not None and abs(so.station - t["station"]) < 1e-6 and abs(so.offset - t["offset"]) < 1e-6
        )


def test_landxml_through_both_pipelines_identical(tmp_path):
    root = full_project(tmp_path)
    out = tmp_path / "out" / "pad_site-grid_m.xml"
    out.parent.mkdir()
    run_job(
        SurveyExport(),
        root,
        {"what": "surface", "format": "landxml", "crs": "site", "layer": "pad", "out": str(out)},
    )
    text = out.read_text("utf-8")
    assert 'epsgCode="32639"' in text and "Coordinate system: Site grid: WGS 84 / UTM zone 39N" in text
    back = project(tmp_path, "back")
    run_job(DesignImport(), back, {"src": str(out), "id": "pad"})
    entry = json.loads((back / "survey" / "designs.json").read_text("utf-8"))["designs"][0]
    kinds = {x["kind"]: x for x in entry["layers"]}
    tin = read_tin(back / "survey" / "designs" / "pad" / kinds["surface"]["file"])
    orig = read_tin(root / "survey" / "designs" / "pad" / "top.tin")
    assert np.array_equal(tin.vertices, orig.vertices) and np.array_equal(tin.triangles, orig.triangles)
    assert [(k, list(i)) for k, i in tin.chains] == [(k, list(i)) for k, i in orig.chains]
    a = json.loads((back / "survey" / "designs" / "pad" / kinds["alignment"]["file"]).read_text("utf-8"))
    got = AlignmentSource(a["name"], a["startStation"], a["elements"], a["equations"])
    same_alignment(shared_alignment(), got)
    pts = json.loads((back / "survey" / "designs" / "pad" / kinds["points"]["file"]).read_text("utf-8"))
    assert [f["geometry"]["coordinates"] for f in pts["features"]] == [
        [520005.0, 2750005.0, 99.5],
        [520035.0, 2750035.0, 101.25],
    ]
    assert [f["properties"] for f in pts["features"]] == [{"id": "CP1", "code": "CTRL"}, {"id": "CP2"}]


# --------------------------------------------------------------------------------------- 12da


def test_12da_tin_strings_and_points_identical(tmp_path):
    s = pad_surface()
    lw = Linework(
        "Kerbs", [Line(np.asarray([[1.5, 2.25, 3.125], [4.0, 5.0, 6.0], [7.0, 8.5, 9.0]]), True, "kerb 1")]
    )
    pts = Points("Control", [Point("1", 520005.0, 2750005.0, 99.5)])
    al = shared_alignment()
    p = tmp_path / "pad.12da"
    write_12da(p, notes=['Units: metres "quoted"'], tins=[s], linework=[lw], points=[pts], alignments=[al])
    d = read_12da(p)
    tins = [x for x in d.surfaces if x.name == "Pad top"]
    assert len(tins) == 1
    assert np.array_equal(tins[0].vertices, s.vertices) and np.array_equal(tins[0].triangles, s.triangles)
    by = {x.name: x for x in d.linework}
    (line,) = by["Kerbs"].lines
    assert line.closed and line.name == "kerb 1" and np.array_equal(line.coords, lw.lines[0].coords)
    chains = by["Pad top breaklines"].lines
    assert [c.coords.tolist() for c in chains] == [c.tolist() for _, c in s.chains]
    (cp,) = [x for x in d.points if x.name == "Control"]
    assert (cp.points[0].e, cp.points[0].n, cp.points[0].z) == (520005.0, 2750005.0, 99.5)
    # the alignment as a string: every vertex on the alignment, its ends at the alignment's ends
    (al_line,) = by["CL1"].lines
    body = {"startStation": al.start_station, "elements": al.elements, "equations": al.equations}
    for e, n, _ in al_line.coords:
        so = alg.station_offset(body, float(e), float(n))
        assert so is not None and abs(so.offset) < 1e-9
    assert np.allclose(al_line.coords[-1, :2], al.elements[-1]["end"], atol=0)
    assert len(alignment_polyline(al)) == len(al_line.coords)


def test_12da_through_both_pipelines_identical(tmp_path):
    root = full_project(tmp_path)
    out = tmp_path / "pad.12da"
    run_job(
        SurveyExport(),
        root,
        {"what": "surface", "format": "12da", "crs": "site", "layer": "pad/top", "out": str(out)},
    )
    back = project(tmp_path, "back")
    run_job(DesignImport(), back, {"src": str(out), "id": "pad", "units": "m", "crs": CRS})
    entry = json.loads((back / "survey" / "designs.json").read_text("utf-8"))["designs"][0]
    surf = next(x for x in entry["layers"] if x["kind"] == "surface")
    tin = read_tin(back / "survey" / "designs" / "pad" / surf["file"])
    v = pad_vertices()
    assert np.array_equal(tin.vertices, v) and np.array_equal(tin.triangles, pad_triangles())


# ---------------------------------------------------------------------------------------- DXF


def _face_set(vertices: np.ndarray, triangles: np.ndarray) -> set:
    return {tuple(sorted(tuple(vertices[i]) for i in t)) for t in np.asarray(triangles, dtype=np.int64)}


def test_dxf_design_surface_round_trip_within_1e_6(tmp_path):
    root = full_project(tmp_path)
    out = tmp_path / "pad.dxf"
    run_job(
        SurveyExport(),
        root,
        {"what": "surface", "format": "dxf", "crs": "site", "layer": "pad", "out": str(out)},
    )
    d = read_dxf(out)
    assert d.units == "m"
    (s,) = [x for x in d.surfaces if x.name == "Pad top"]
    v = pad_vertices()
    got = np.asarray(sorted(map(tuple, s.vertices)))
    assert np.abs(got - np.asarray(sorted(map(tuple, v)))).max() <= 1e-6
    assert _face_set(s.vertices, s.triangles) == _face_set(v, pad_triangles())
    layers = {x.name for x in d.linework}
    assert {"Pad top breaklines", "Pad top boundary", "CL1"} <= layers
    import ezdxf

    doc = ezdxf.readfile(out)
    props = dict(doc.header.custom_vars)
    assert props["Quadrion CRS"].startswith("Site grid: WGS 84 / UTM zone 39N")
    assert props["Quadrion Height units"] == "metres"


def test_dxf_grid_surface_streams_every_face(tmp_path):
    root = full_project(tmp_path)
    out = tmp_path / "plane.dxf"
    run_job(
        SurveyExport(),
        root,
        {"what": "surface", "format": "dxf", "crs": "site", "surface": "plane", "out": str(out)},
    )
    d = read_dxf(out)
    (s,) = [x for x in d.surfaces if x.name.startswith("Plane")]
    assert len(s.triangles) == 2 * (NX - 1) * (NY - 1)
    assert np.allclose(s.vertices[:, 2], plane(s.vertices[:, 0], s.vertices[:, 1]), atol=1e-6, rtol=0)
    # handles are unique, so CAD programs open it
    import ezdxf

    doc = ezdxf.readfile(out)
    handles = [e.dxf.handle for e in doc.modelspace()]
    assert len(handles) == len(set(handles))
    assert int(doc.header["$HANDSEED"], 16) > max(int(h, 16) for h in handles)
    # a lower level of detail keeps one post in two each way
    out2 = tmp_path / "plane-medium.dxf"
    run_job(
        SurveyExport(),
        root,
        {
            "what": "surface",
            "format": "dxf",
            "crs": "site",
            "surface": "plane",
            "decimate": 0.25,
            "out": str(out2),
        },
        job_id="j2",
    )
    (s2,) = read_dxf(out2).surfaces
    assert len(s2.triangles) == 2 * (NX // 2 - 1) * (NY // 2 - 1)


# ---------------------------------------------------------------------------------- GeoTIFF


def test_geotiff_site_grid_is_the_prepared_grid(tmp_path):
    import rasterio

    root = full_project(tmp_path)
    out = tmp_path / "plane_site-grid_m.tif"
    run_job(
        SurveyExport(),
        root,
        {"what": "surface", "format": "geotiff", "crs": "site", "surface": "plane", "out": str(out)},
    )
    with rasterio.open(out) as ds:
        assert ds.crs.to_epsg() == 32639
        assert ds.transform.a == CELL and ds.transform.c == GE and ds.transform.f == GN + NY * CELL
        z = ds.read(1)
        assert ds.width == NX and ds.height == NY
        tags = ds.tags()
        assert tags["QUADRION_CRS"].startswith("Site grid: WGS 84 / UTM zone 39N")
        assert tags["QUADRION_UNITS"] == "metres" and ds.units[0] == "metre"
        assert ds.profile.get("tiled") or ds.block_shapes[0][0] > 1
    xs = GE + (np.arange(NX) + 0.5) * CELL
    ys = GN + (np.arange(NY) + 0.5) * CELL
    X, Y = np.meshgrid(xs, ys[::-1])
    assert np.allclose(z, plane(X, Y).astype(np.float32), atol=0)
    assert (tmp_path / "plane_site-grid_m.txt").read_text("utf-8").startswith("Heights: Plane survey")


def test_geotiff_wgs84_reads_back_with_its_crs_and_heights(tmp_path):
    import rasterio
    from pyproj import Transformer

    root = full_project(tmp_path)
    out = tmp_path / "plane_wgs84_m.tif"
    run_job(
        SurveyExport(),
        root,
        {"what": "surface", "format": "geotiff", "crs": "wgs84", "surface": "plane", "out": str(out)},
    )
    with rasterio.open(out) as ds:
        assert ds.crs.to_epsg() == 4326
        z = ds.read(1, masked=True)
        t = ds.transform
        rows, cols = np.nonzero(~z.mask)
        k = np.linspace(0, len(rows) - 1, 200).astype(int)
        lon = t.c + (cols[k] + 0.5) * t.a
        lat = t.f + (rows[k] + 0.5) * t.e
    e, n = Transformer.from_crs(4326, 32639, always_xy=True).transform(lon, lat)
    # a plane is exact under bilinear sampling: the cell holds the plane where PROJ puts its centre
    assert np.allclose(z[rows[k], cols[k]], plane(np.asarray(e), np.asarray(n)), atol=2e-5, rtol=0)


# ------------------------------------------------------------------------------------ LAS/LAZ


def _las_project(tmp_path: Path) -> tuple[Path, np.ndarray]:
    from aio_pipelines.change.las import write_las

    rng = np.random.default_rng(3)
    xyz = np.column_stack(
        [GE + rng.uniform(0, 50, 1000), GN + rng.uniform(0, 40, 1000), 100 + rng.uniform(0, 5, 1000)]
    )
    xyz = np.round(xyz, 3)
    root = project(
        tmp_path,
        layers=[
            {
                "id": "cloud",
                "name": "Cloud",
                "kind": "pointcloud",
                "format": "copc",
                "src": {"path": "clouds/c.las"},
            }
        ],
    )
    (root / "clouds").mkdir()
    write_las(
        root / "clouds" / "c.las", xyz, pdrf=7, classification=np.full(1000, 2), rgb=np.full((1000, 3), 40000)
    )
    return root, xyz


def _wkt_of(path: Path) -> str:
    data = path.read_bytes()
    pos = struct.unpack_from("<H", data, 94)[0]
    for _ in range(struct.unpack_from("<I", data, 100)[0]):
        user = data[pos + 2 : pos + 18].split(b"\0")[0]
        rid, length = struct.unpack_from("<HH", data, pos + 18)
        if user == b"LASF_Projection" and rid == 2112:
            return data[pos + 54 : pos + 54 + length].rstrip(b"\0").decode("utf-8")
        pos += 54 + length
    raise AssertionError("no WKT VLR")


def test_las_keeps_the_fields_and_states_the_crs(tmp_path):
    from pyproj import CRS as PCRS

    from aio_pipelines.change.las import read_las

    root, xyz = _las_project(tmp_path)
    out = tmp_path / "cloud_site-grid_m.las"
    run_job(
        SurveyExport(),
        root,
        {"what": "cloud", "format": "laz", "crs": "site", "layer": "cloud", "out": str(out)},
    )
    las = read_las(out)
    assert las.count == 1000 and las.pdrf == 7
    assert np.allclose(las.xyz, xyz, atol=5e-4, rtol=0)
    assert (las.field("Classification") == 2).all() and (las.field("Red") == 40000).all()
    assert PCRS.from_wkt(_wkt_of(out)).to_epsg() == 32639
    out2 = tmp_path / "half.las"
    run_job(
        SurveyExport(),
        root,
        {
            "what": "cloud",
            "format": "laz",
            "crs": "wgs84",
            "layer": "cloud",
            "decimate": 0.5,
            "out": str(out2),
        },
        job_id="j2",
    )
    las2 = read_las(out2)
    assert las2.count == 500 and PCRS.from_wkt(_wkt_of(out2)).to_epsg() == 4326
    assert 51 < las2.xyz[:, 0].min() < 52 and 24 < las2.xyz[:, 1].min() < 25


@pytest.mark.skipif(find_pdal() is None, reason="PDAL is not installed (the full pipeline pack has it)")
def test_laz_through_pdal_reads_back_with_the_crs(tmp_path):
    import subprocess

    from aio_pipelines.pointcloud import pdal_env

    root, _ = _las_project(tmp_path)
    out = tmp_path / "cloud_site-grid_m.laz"
    run_job(
        SurveyExport(),
        root,
        {"what": "cloud", "format": "laz", "crs": "site", "layer": "cloud", "out": str(out)},
    )
    pdal = find_pdal()
    assert pdal
    info = json.loads(
        subprocess.run(
            [pdal, "info", "--summary", str(out)],
            capture_output=True,
            text=True,
            env=pdal_env(pdal),
            check=True,
        ).stdout
    )
    s = info["summary"]
    assert s["num_points"] == 1000
    assert "32639" in json.dumps(s.get("srs") or {})


def test_laz_without_pdal_is_refused_with_the_reason(tmp_path, monkeypatch):
    import aio_pipelines.pointcloud as pc

    monkeypatch.setattr(pc, "find_pdal", lambda: None)
    root, _ = _las_project(tmp_path)
    with pytest.raises(JobError, match="needs PDAL"):
        run_job(
            SurveyExport(),
            root,
            {
                "what": "cloud",
                "format": "laz",
                "crs": "site",
                "layer": "cloud",
                "out": str(tmp_path / "c.laz"),
            },
        )


# ------------------------------------------------------------------------------ US survey feet


CA = {"epsg": 26943}  # NAD83 / California zone 3 (metres)
CA_FT = {"epsg": 2227}  # the same zone in US survey feet
E_FT, N_FT = 6_000_000.0, 2_000_000.0


def test_design_import_scales_a_us_feet_crs_at_the_edge(tmp_path):
    """A LandXML in US survey feet on a feet CRS lands where PROJ puts it (G6's crs_transform)."""
    v = np.asarray([[E_FT, N_FT, 300.0], [E_FT + 100, N_FT, 301.0], [E_FT, N_FT + 100, 302.0]])
    p = tmp_path / "ft.xml"
    write_landxml(
        p,
        units="us-ft",
        notes=[],
        crs_name="NAD83 / California zone 3 (ftUS)",
        epsg=2227,
        surfaces=[Surface("S", v, np.asarray([[0, 1, 2]], dtype=np.uint32))],
    )
    root = project(tmp_path, crs=CA)
    run_job(DesignImport(), root, {"src": str(p), "id": "ft"})
    tin = read_tin(next((root / "survey" / "designs" / "ft").glob("*.tin")))
    # PROJ's answer (the two zones differ by the unit and 0.1 mm of false easting), heights in metres
    x, y = proj(CA_FT, CA, v[:, 0], v[:, 1])
    assert np.allclose(tin.vertices[:, 0], x, atol=1e-6, rtol=0)
    assert np.allclose(tin.vertices[:, 1], y, atol=1e-6, rtol=0)
    assert np.allclose(tin.vertices[:, 2], v[:, 2] * US_FT, atol=1e-9, rtol=0)
    # and not feet read as metres (the unit is converted once, at the edge)
    assert abs(tin.vertices[0, 0] - v[0, 0]) > 1_000_000


def test_export_in_a_us_feet_crs_writes_feet_and_reads_back(tmp_path):
    root = project(tmp_path, crs=CA)
    from aio_pipelines.design.tin_io import encode_tin
    from export_fixtures import write_json

    v = np.asarray([[E_FT, N_FT, 300.0], [E_FT + 100, N_FT, 301.0], [E_FT, N_FT + 100, 302.0]]) * US_FT
    folder = root / "survey" / "designs" / "d"
    folder.mkdir(parents=True)
    (folder / "s.tin").write_bytes(encode_tin(v, np.asarray([[0, 1, 2]], dtype=np.uint32), CA))
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
    out = tmp_path / "s_epsg2227_usft.xml"
    run_job(
        SurveyExport(),
        root,
        {
            "what": "surface",
            "format": "landxml",
            "crs": CA_FT,
            "units": "us-ft",
            "layer": "d",
            "out": str(out),
        },
    )
    d = read_landxml(out)
    assert d.units == "us-ft" and d.crs == CA_FT
    x, y = proj(CA, CA_FT, v[:, 0], v[:, 1])
    assert np.allclose(d.surfaces[0].vertices[:, 0], x, atol=1e-6, rtol=0)
    assert np.allclose(d.surfaces[0].vertices[:, 1], y, atol=1e-6, rtol=0)
    assert np.allclose(d.surfaces[0].vertices[:, 2], v[:, 2] / US_FT, atol=1e-9, rtol=0)
    back = project(tmp_path, "back", crs=CA)
    run_job(DesignImport(), back, {"src": str(out), "id": "d"})
    tin = read_tin(next((back / "survey" / "designs" / "d").glob("*.tin")))
    assert np.allclose(tin.vertices, v, atol=1e-6, rtol=0)


def test_geotiff_and_csv_in_a_us_feet_crs_are_in_feet(tmp_path):
    import rasterio

    from export_fixtures import prepared

    root = project(tmp_path, crs=CA)
    prepared(root, "plane", plane)
    # a file that carries its CRS holds that CRS's unit
    with pytest.raises(JobError, match="US survey feet"):
        run_job(
            SurveyExport(),
            root,
            {
                "what": "surface",
                "format": "geotiff",
                "crs": CA,
                "units": "us-ft",
                "surface": "plane",
                "out": str(tmp_path / "x.tif"),
            },
        )
    out = tmp_path / "plane_epsg2227_usft.tif"
    run_job(
        SurveyExport(),
        root,
        {
            "what": "surface",
            "format": "geotiff",
            "crs": CA_FT,
            "units": "us-ft",
            "surface": "plane",
            "out": str(out),
        },
        job_id="j2",
    )
    with rasterio.open(out) as ds:
        assert ds.crs.to_epsg() == 2227 and ds.units[0] == "US survey foot"
        t = ds.transform
        assert math.isclose(t.a, CELL / US_FT, rel_tol=1e-12)
        assert abs(t.c - GE / US_FT) < 2 * CELL / US_FT
        z = ds.read(1, masked=True)
    rows, cols = np.nonzero(~z.mask)
    assert len(rows) > 0.9 * NX * NY
    xs, ys = t.c + (cols + 0.5) * t.a, t.f + (rows + 0.5) * t.e
    e, n = proj(CA_FT, CA, xs, ys)
    assert np.allclose(z[rows, cols], plane(e, n) / US_FT, atol=1e-4, rtol=0)
    # a CSV in the site grid in US feet: coordinates and heights in feet of the metric grid
    run_job(
        SurveyExport(),
        root,
        {
            "what": "surface",
            "format": "csv",
            "crs": "site",
            "units": "us-ft",
            "surface": "plane",
            "decimate": 0.01,
            "out": str(tmp_path / "p.csv"),
        },
        job_id="j3",
    )
    first = (tmp_path / "p.csv").read_text("utf-8").splitlines()[0].split(",")
    n, e, zz = float(first[1]), float(first[2]), float(first[3])
    assert math.isclose(e * US_FT, GE + 0.5 * CELL, abs_tol=1e-6) and math.isclose(
        n * US_FT, GN + 0.5 * CELL, abs_tol=1e-6
    )
    assert math.isclose(zz * US_FT, float(plane(np.array(GE + 0.25), np.array(GN + 0.25))), abs_tol=1e-6)
