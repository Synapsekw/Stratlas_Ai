"""road.build: PCI maths, inputs, sample units and the whole pipeline on synthetic data."""

import json
import math

import numpy as np
import pytest
from shapely.geometry import box

from aio_pipelines.road import pci as P
from aio_pipelines.road.catalogue import class_of, stage_of
from aio_pipelines.road.pipeline import RoadBuild, defect_code
from aio_pipelines.road.sources import Centreline, dxf_lines, read_centreline, read_defects
from aio_pipelines.road.units import (
    MaskFootprint,
    PolygonFootprint,
    chainage_units,
    density_grids,
    grid_units,
    sections,
    unit_edges,
)
from aio_pipelines.runtime import JobError
from conftest import run_job

EPSG = 32639
E0, N0 = 500000.0, 3200000.0  # project origin (UTM 39N)


def crs():
    from rasterio.crs import CRS

    return CRS.from_epsg(EPSG)


def lonlat(es, ns):
    from rasterio.warp import transform

    lon, lat = transform(crs(), "EPSG:4326", list(es), list(ns))
    return [[a, b] for a, b in zip(lon, lat, strict=True)]


# ---------------------------------------------------------------- PCI


def test_deduct_interpolates_on_a_log_axis():
    assert P.deduct("alligator_cracking", "low", 1.0) == pytest.approx(10.7)
    assert P.deduct("alligator_cracking", "low", math.sqrt(2)) == pytest.approx((10.7 + 16.9) / 2)
    # below the first point: a straight line to zero; above the last: the last value
    assert P.deduct("alligator_cracking", "low", 0.05) == pytest.approx(3.7 * 0.5)
    assert P.deduct("alligator_cracking", "high", 250) == pytest.approx(91.1)
    assert P.deduct("potholes", "medium", 0) == 0.0


def test_pci_iterates_the_corrected_deduct_value():
    assert P.pci([]) == (100.0, 0.0)
    assert P.pci([30.0]) == (70.0, 30.0)
    # q=3: CDV(70)=44.8; q=2: [40, 20, 2] -> CDV(62)=45.04; q=1: 44 -> max 45.04
    assert P.pci([40.0, 20.0, 10.0]) == (55.0, 45.0)
    # deducts of 2 or less add up straight
    assert P.pci([1.5, 1.0]) == (97.5, 2.5)


def test_unit_pci_reports_medium_deducts_largest_first():
    res, det = P.unit_pci({"alligator_cracking": 225 * P.FT2 * 0.01, "bleeding": 225 * P.FT2 * 0.1}, 225.0)
    assert res[0] > res[1] > res[2]
    # 1 % alligator cracking deducts 21.3, 10 % bleeding 13.2 (Medium)
    assert [d[0] for d in det] == ["alligator_cracking", "bleeding"]
    assert det[1][1] == pytest.approx(10.0)
    assert det[0][2] == pytest.approx(21.3)


def test_classes_and_stages_read_the_delivered_names():
    assert class_of("Alligator Cracker").id == "alligator-cracking"
    assert class_of("Longitudinal Cracking\r\n").distress == "longitudinal_transverse_cracking"
    assert class_of("potholes").kind == "count"
    odd = class_of("Manhole cover")
    assert odd.id == "manhole-cover" and odd.distress is None
    assert [stage_of(s) for s in ("Few", "Intermediate", "extensive", 2, "x", None)] == [
        1,
        2,
        3,
        2,
        None,
        None,
    ]
    assert defect_code(7) == "D0007" and defect_code(12345) == "E2345"


# ---------------------------------------------------------------- inputs


def test_centreline_from_geojson_kml_dxf_and_kit(tmp_path):
    es = [E0 - 50, E0, E0 + 50]
    ns = [N0, N0, N0 + 50]
    ll = lonlat(es, ns)
    gj = tmp_path / "cl.geojson"
    gj.write_text(
        json.dumps(
            {"type": "Feature", "geometry": {"type": "LineString", "coordinates": ll}, "properties": {}}
        )
    )
    cl = read_centreline(gj, crs())
    assert np.allclose(cl.xy[:, 0], es, atol=1e-3) and not cl.given
    assert cl.length_km == pytest.approx((50 + 50 * math.sqrt(2)) / 1000, abs=1e-5)

    kml = tmp_path / "cl.kml"
    coords = " ".join(f"{a},{b},0" for a, b in ll)
    kml.write_text(
        f'<kml xmlns="http://www.opengis.net/kml/2.2"><Placemark><LineString><coordinates>{coords}</coordinates></LineString></Placemark></kml>'
    )
    assert read_centreline(kml, crs()).length_km == pytest.approx(cl.length_km, abs=1e-6)

    dxf = tmp_path / "cl.dxf"
    body = "\n".join(f"10\n{e}\n20\n{n}" for e, n in zip(es, ns, strict=True))
    dxf.write_text(f"0\nSECTION\n2\nENTITIES\n0\nLWPOLYLINE\n90\n3\n70\n0\n{body}\n0\nENDSEC\n0\nEOF\n")
    d = read_centreline(dxf, crs())
    assert np.allclose(d.xy, np.column_stack([es, ns])) and any("DXF" in w for w in d.warnings)

    kit = tmp_path / "centreline_utm.json"
    kit.write_text(json.dumps({"xy": [[e, n] for e, n in zip(es, ns, strict=True)], "ch": [0.5, 0.55, 0.6]}))
    k = read_centreline(kit, crs())
    assert k.given and k.nearest_vertex_km(E0 + 1, N0) == 0.55


def test_dxf_joins_line_runs():
    text = (
        "0\nSECTION\n2\nENTITIES\n"
        + "".join(f"0\nLINE\n10\n{a}\n20\n0\n11\n{b}\n21\n0\n" for a, b in ((0, 10), (10, 20), (50, 60)))
        + "0\nENDSEC\n0\nEOF\n"
    )
    lines = dxf_lines(text)
    assert [len(ln) for ln in lines] == [3, 2]


def test_defects_from_geojson_and_shapefile(tmp_path):
    import shapefile

    ring = [[E0, N0], [E0 + 2, N0], [E0 + 2, N0 + 1], [E0, N0 + 1], [E0, N0]]
    gj = tmp_path / "d.geojson"
    gj.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "geometry": {"type": "Polygon", "coordinates": [lonlat(*zip(*ring, strict=True))]},
                        "properties": {"DefectName": "Block Cracking", "Stages": "Intermediate"},
                    },
                    {
                        "type": "Feature",
                        "geometry": {"type": "Point", "coordinates": lonlat([E0 + 5], [N0])[0]},
                        "properties": {"type": "Potholes"},
                    },
                ],
            }
        )
    )
    ds, warn = read_defects(gj, crs())
    assert [d.cls.id for d in ds] == ["block-cracking", "potholes"]
    assert ds[0].stage == 2 and ds[1].stage is None
    assert ds[0].area == pytest.approx(2.0, rel=1e-4) and ds[0].extent == pytest.approx(2.0, rel=1e-4)

    shp = tmp_path / "defects.shp"
    with shapefile.Writer(str(shp.with_suffix("")), shapeType=shapefile.POLYGON) as w:
        w.field("DefectName", "C", 50)
        w.field("Stages", "C", 20)
        w.poly([ring])
        w.record("Alligator Cracker", "Extensive")
    ds, warn = read_defects(shp, crs())
    assert ds[0].cls.id == "alligator-cracking" and ds[0].stage == 3
    assert any(".prj" in w for w in warn)


def test_detections_wait_for_their_contract(tmp_path):
    f = tmp_path / "det.json"
    f.write_text(json.dumps({"schema": "aio.detections/1", "detections": []}))
    with pytest.raises(JobError, match=r"aio\.detections/1"):
        read_defects(f, crs())


# ---------------------------------------------------------------- units


def straight(length=100.0):
    xy = np.array([[E0, N0], [E0 + length, N0]])
    return Centreline(xy=xy, ch=np.array([0.0, length / 1000]))


def defect(fid, name, geom, stage=None):
    from aio_pipelines.road.sources import _defect

    return _defect(fid, geom, {"type": name, "stage": stage}, [])


def write_mask(path, mask, x0, y1, res=0.1):
    import rasterio
    from rasterio.transform import from_origin

    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        height=mask.shape[0],
        width=mask.shape[1],
        count=1,
        dtype="uint8",
        crs=f"EPSG:{EPSG}",
        transform=from_origin(x0, y1, res, res),
        nodata=0,
    ) as d:
        d.write(mask.astype(np.uint8), 1)
    return path


def test_grid_units_merge_edge_cells_like_the_delivered_builder(tmp_path):
    # pavement 45 m x 20 m from the grid origin: rows 0 (15 m, full) and 1 (5 m, a sliver row)
    mask = np.zeros((300, 600), np.uint8)
    mask[:200, :450] = 1
    fp = MaskFootprint(str(write_mask(tmp_path / "pav.tif", mask, E0, N0 + 30)), crs())
    cl = Centreline(xy=np.array([[E0, N0 + 25], [E0 + 60, N0 + 25]]), ch=np.array([0.0, 0.06]))
    d = defect(0, "Alligator Cracker", box(E0 + 1, N0 + 26, E0 + 3, N0 + 28), "Few")
    res = grid_units(fp, [d], cl, 15.0)
    units = {u["id"]: u for u in res["units"]}
    assert set(units) == {"u0-0", "u0-1", "u0-2"}
    # each 15 m cell takes the 5 m sliver below it: 225 + 75 m2
    assert all(u["pavementM2"] == pytest.approx(300.0) for u in units.values())
    assert units["u0-0"]["cells"] == [[0, 0], [1, 0]]
    q = 4 * P.FT2
    expect = [P.pci([P.deduct("alligator_cracking", s, 100 * q / (300 * P.FT2))])[0] for s in P.SEVERITIES]
    assert units["u0-0"]["pci"] == expect
    assert units["u0-1"]["pci"] == [100.0, 100.0, 100.0]
    assert res["coveragePct"] == 100.0
    dens = density_grids(fp, [d])
    cell = next(c for c in dens["10"] if c[3])
    assert cell[:2] == [0, 0] and cell[4] == pytest.approx(4.0)
    fp.close()


def test_chainage_units_follow_the_line():
    assert unit_edges(100, 30) == [0, 30, 60, 100]  # a 10 m remainder joins the last unit
    assert unit_edges(110, 30) == [0, 30, 60, 90, 110]
    assert unit_edges(20, 30) == [0, 20]
    cl = straight(100)
    from shapely.geometry import LineString

    fp = PolygonFootprint(LineString(cl.xy).buffer(3.65, cap_style="flat"))
    d = defect(0, "Potholes", box(E0 + 40, N0 - 1, E0 + 41, N0), "Intermediate")
    res = chainage_units(fp, [d], cl, 30.0, 7.3)
    us = res["units"]
    assert [u["id"] for u in us] == ["s0000", "s0001", "s0002"]
    assert [u["pavementM2"] for u in us] == pytest.approx([219.0, 219.0, 292.0])
    assert us[1]["fromKm"] == 0.03 and us[1]["toKm"] == 0.06 and us[1]["km"] == 0.045
    assert us[1]["deducts"][0][0] == "potholes" and us[1]["pci"][1] < 100
    assert us[0]["pci"] == [100.0, 100.0, 100.0]
    secs = sections(us, cl.length_km)
    assert len(secs) == 1 and secs[0][1] == pytest.approx(730.0)


# ---------------------------------------------------------------- pipeline


def write_ortho(path, x0, y1, w, h, res=0.05):
    """A synthetic RGBA ortho: a grey road band with a dark patch, transparent outside a margin."""
    import rasterio
    from rasterio.transform import from_origin

    yy, xx = np.mgrid[0:h, 0:w]
    rgb = np.zeros((3, h, w), np.uint8)
    rgb[:] = (90 + (xx % 50)).astype(np.uint8)
    alpha = np.where((xx > 4) & (yy > 4), 255, 0).astype(np.uint8)
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        height=h,
        width=w,
        count=4,
        dtype="uint8",
        crs=f"EPSG:{EPSG}",
        transform=from_origin(x0, y1, res, res),
        photometric="RGB",
        alpha="YES",
        tiled=True,
    ) as d:
        d.write(rgb[0], 1)
        d.write(rgb[1], 2)
        d.write(rgb[2], 3)
        d.write(alpha, 4)
    return path


def road_project(tmp_path, project):
    manifest = {
        "schema": "aio.project/1",
        "id": "road-e2e",
        "name": "Synthetic road",
        "crs": {"epsg": EPSG},
        "origin": [E0, N0, 0],
        "captures": [],
        "layers": [],
        "severityModels": [],
        "classCatalogues": [],
        "type": "road",
    }
    (project / "manifest.json").write_text(json.dumps(manifest))
    (project / "issues.json").write_text(json.dumps({"schema": "aio.issues/1", "issues": []}))
    raw = tmp_path / "raw"
    raw.mkdir()
    ortho = write_ortho(raw / "ortho.tif", E0 - 10, N0 + 10, 2400, 400)
    cl = raw / "centreline.geojson"
    cl.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "geometry": {"type": "LineString", "coordinates": lonlat([E0, E0 + 100], [N0, N0])},
                        "properties": {},
                    }
                ],
            }
        )
    )
    feats = []
    for name, stage, x in [
        ("Alligator Cracker", "Few", 10),
        ("Potholes", "Extensive", 50),
        ("Raveling", None, 80),
    ]:
        ring = [
            [E0 + x, N0 - 1],
            [E0 + x + 2, N0 - 1],
            [E0 + x + 2, N0 + 1],
            [E0 + x, N0 + 1],
            [E0 + x, N0 - 1],
        ]
        feats.append(
            {
                "type": "Feature",
                "geometry": {"type": "Polygon", "coordinates": [lonlat(*zip(*ring, strict=True))]},
                "properties": {"DefectName": name, **({"Stages": stage} if stage else {})},
            }
        )
    defects = raw / "defects.geojson"
    defects.write_text(json.dumps({"type": "FeatureCollection", "features": feats}))
    return {"ortho": str(ortho), "centreline": str(cl), "defects": str(defects)}


def test_road_build_end_to_end(tmp_path, project):
    from PIL import Image

    inputs = road_project(tmp_path, project)
    params = {**inputs, "unitLength": 30, "lanes": 2, "laneWidth": 3.65}
    result, rec = run_job(RoadBuild(), project, params)
    assert result["status"] == "done"
    assert [s["name"] for s in rec.of("progress")[0]["plan"]] == [
        "read",
        "ortho",
        "closeups",
        "pci",
        "commit",
    ]

    tiles = json.loads((project / "rasters/ortho/tiles.json").read_text())
    assert tiles["schema"] == "aio.tiles/1"
    finest = tiles["levels"][-1]
    assert tiles["metresPerPx"][-1] == pytest.approx(0.05)
    assert tiles["corners"]["tl"] == [-10.0, 0, -10.0]
    for lv in tiles["levels"]:
        for y in range(lv["rows"]):
            for x in range(lv["cols"]):
                assert (project / lv["pattern"].format(x=x, y=y)).exists(), (lv["z"], x, y)
    with Image.open(project / finest["pattern"].format(x=0, y=0)) as im:
        assert im.size == (1024, 1024)
        px = im.convert("RGBA").getpixel((200, 100))
        assert px[3] == 255 and abs(px[0] - (90 + 200 % 50)) <= 3

    road = json.loads((project / "road.json").read_text())
    assert road["schema"] == "aio.road/1" and road["pci"]["layout"] == "chainage"
    assert road["centreline"]["lengthKm"] == pytest.approx(0.1, abs=1e-4)
    assert road["centreline"]["points"][0] == pytest.approx([0, 0, 0], abs=1e-3)
    assert [u["id"] for u in road["pci"]["units"]] == ["s0000", "s0001", "s0002"]
    assert road["pci"]["units"][0]["pci"]["medium"] < 100
    assert set(road["density"]["sizes"]) == {"10", "20", "50"}
    units_gj = json.loads((project / "road/pci-units.geojson").read_text())
    assert len(units_gj["features"]) == 3 and "pciMedium" in units_gj["features"][0]["properties"]
    line = json.loads((project / "road/centreline.geojson").read_text())
    assert line["features"][0]["properties"]["kind"] == "centreline"
    assert [f["properties"]["label"] for f in line["features"][1:]] == ["km 0.0"]

    issues = json.loads((project / "issues.json").read_text())["issues"]
    assert [i["code"] for i in issues] == ["D0000", "D0001", "D0002"]
    assert [i["severity"] for i in issues] == [1, 3, 1]
    assert issues[1]["title"] == "Potholes at km 0.051"
    assert {s["on"] for s in issues[0]["sightings"]} == {"map", "image"}
    img = next(s for s in issues[0]["sightings"] if s["on"] == "image")
    assert img["photo"] == "f0000" and len(img["geom"]["points"]) == 4
    assert (project / "photos/closeups/f0000.webp").exists()

    m = json.loads((project / "manifest.json").read_text())
    assert [lyr["id"] for lyr in m["layers"]] == ["ortho", "closeups"]
    assert m["classCatalogues"][0]["assetType"] == "road"
    assert m["severityModels"][0]["id"] == "road-astm-d6433"
    assert (project / "manifest.json.bak").exists() and (project / "thumbnail.jpg").exists()

    # an issue edited in the app survives a rebuild; the ortho is not tiled again
    issues[2]["severity"] = 2
    issues[2]["updatedAt"] = "2026-10-05T09:00:00Z"
    (project / "issues.json").write_text(json.dumps({"schema": "aio.issues/1", "issues": issues}))
    result2, rec2 = run_job(RoadBuild(), project, params, job_id="j2")
    assert any("already has this orthomosaic" in m["message"] for m in rec2.of("log"))
    again = json.loads((project / "issues.json").read_text())["issues"]
    assert len(again) == 3 and again[2]["severity"] == 2
    assert result2["outputs"]["commit"]["issuesKept"] == 1


def test_grid_layout_with_a_pavement_raster(tmp_path, project):
    inputs = road_project(tmp_path, project)
    mask = np.zeros((300, 1200), np.uint8)
    mask[100:200, :] = 1  # a 10 m strip, N0 - 10 to N0 + 0 ... the grid starts at N0 + 20
    pav = write_mask(tmp_path / "raw/pavement.tif", mask, E0 - 10, N0 + 20)
    params = {
        "centreline": inputs["centreline"],
        "defects": inputs["defects"],
        "pavement": str(pav),
        "units": "grid",
    }
    result, rec = run_job(RoadBuild(), project, params)
    road = json.loads((project / "road.json").read_text())
    assert road["pci"]["layout"] == "grid" and road["pci"]["grid"]["cellM"] == 15
    assert road["pci"]["grid"]["origin"] == [-10.0, 0, -20.0]
    assert all(u["cells"] for u in road["pci"]["units"])
    assert road["pci"]["network"]["medium"] < 100
    m = json.loads((project / "manifest.json").read_text())
    assert not any(lyr["id"] == "ortho" for lyr in m["layers"])


def test_params_are_checked():
    rb = RoadBuild()
    with pytest.raises(JobError, match="centreline"):
        rb.validate({})
    with pytest.raises(JobError, match="units"):
        rb.validate({"centreline": "c.geojson", "units": "hex"})
    with pytest.raises(JobError, match="GeoTIFF"):
        rb.validate({"centreline": "c.geojson", "ortho": "o.png"})
    v = rb.validate({"centreline": "c.geojson", "lanes": 3, "laneWidth": 3.5})
    assert v["unitLength"] == round(225 / 10.5) and v["units"] == "chainage" and v["closeups"] is True
    assert rb.validate({"centreline": "c", "units": "grid"})["unitLength"] == 15
