"""drawing.import: the DXF reader, placement by control points, parts, plan and vector layers."""

from __future__ import annotations

import json
import math
import os

import pytest

from aio_pipelines.drawing.dxf import read_dxf
from aio_pipelines.drawing.pipeline import DrawingImport
from aio_pipelines.runtime import INPUTS_CHANGED, JobError
from conftest import run_job
from modelling_synth import (
    EPSG,
    ORIGIN,
    Dxf,
    check_procmodel,
    footprint_is_ccw_from_above,
    plot_plan,
    read_manifest,
    write_manifest,
)

# --------------------------------------------------------------------------------------------
# the DXF reader


def by_handle(doc, h):
    return next(e for e in doc.entities if e.handle == h and not e.parent)


def test_reads_units_entities_and_counts_the_skipped_kinds(tmp_path):
    d, h = plot_plan()
    doc = read_dxf(d.write(tmp_path / "plot.dxf"))
    assert doc.units == "m"
    kinds = doc.counts()
    assert kinds["CIRCLE"] == 3 + 2  # tanks, vessel and one circle per pump insert
    assert kinds["LWPOLYLINE"] == 3
    assert kinds["TEXT"] >= 8 and kinds["MTEXT"] == 1
    assert kinds["ARC"] == 1 and kinds["POINT"] == 1 and kinds["POLYLINE"] == 1
    assert doc.skipped == {"HATCH": 2, "DIMENSION": 1}
    t = by_handle(doc, h["t101"])
    assert t.layer == "TANKS" and t.color == 1
    assert t.center == pytest.approx((20, 30)) and t.radius == pytest.approx(6)
    bld = by_handle(doc, h["bld"])
    assert bld.closed and len(bld.points) == 6
    pipe = by_handle(doc, h["pipe"])
    assert not pipe.closed and len(pipe.points) == 3
    mt = next(e for e in doc.entities if e.type == "MTEXT")
    assert mt.text == "EL +10.000\nTOP"


def test_expands_blocks_with_insertion_point_scale_and_rotation(tmp_path):
    d, h = plot_plan()
    doc = read_dxf(d.write(tmp_path / "plot.dxf"))
    pumps = [e for e in doc.entities if e.parent]
    assert len(pumps) == 4
    c1 = next(e for e in pumps if e.type == "CIRCLE" and e.parent == h["ins1"])
    c2 = next(e for e in pumps if e.type == "CIRCLE" and e.parent == h["ins2"])
    assert c1.center == pytest.approx((70, 10)) and c1.radius == pytest.approx(0.5)
    assert c2.center == pytest.approx((80, 10)) and c2.radius == pytest.approx(1.0)
    l2 = next(e for e in pumps if e.type == "LINE" and e.parent == h["ins2"])
    # the block line runs 1 unit along +x from the base point; scaled 2 and turned 90 degrees
    assert l2.points[0] == pytest.approx((80, 10))
    assert l2.points[1] == pytest.approx((80, 12))
    assert c2.id.startswith(f"{h['ins2']}-")


def test_nested_blocks_and_a_cycle(tmp_path):
    d = Dxf()
    d.block("INNER")
    d.circle("A", (1, 0), 0.5, block="INNER")
    d.block("OUTER")
    d.insert("A", "INNER", (10, 0), block="OUTER")
    d.insert("A", "OUTER", (100, 0), rot=90)
    doc = read_dxf(d.write(tmp_path / "nested.dxf"))
    (c,) = [e for e in doc.entities if e.type == "CIRCLE"]
    assert c.center == pytest.approx((100, 11))
    d2 = Dxf()
    d2.block("LOOP")
    d2.insert("A", "LOOP", (0, 0), block="LOOP")
    d2.insert("A", "LOOP", (0, 0))
    with pytest.raises(JobError, match='block "LOOP"'):
        read_dxf(d2.write(tmp_path / "loop.dxf"))


def test_unitless_and_odd_units(tmp_path):
    d, _ = plot_plan(insunits=0)
    assert read_dxf(d.write(tmp_path / "a.dxf")).units is None
    d, _ = plot_plan(insunits=None)
    assert read_dxf(d.write(tmp_path / "b.dxf")).units is None
    d, _ = plot_plan(scale=1000, insunits=4)
    assert read_dxf(d.write(tmp_path / "c.dxf")).units == "mm"
    d, _ = plot_plan(insunits=3)
    with pytest.raises(JobError, match=r'"d.dxf".*code 3'):
        read_dxf(d.write(tmp_path / "d.dxf"))


def test_refuses_binary_and_malformed_files(tmp_path):
    p = tmp_path / "bin.dxf"
    p.write_bytes(b"AutoCAD Binary DXF\r\n\x1a\x00junk")
    with pytest.raises(JobError, match="binary DXF"):
        read_dxf(p)
    d, _ = plot_plan()
    lines = d.text_out().split("\n")
    lines[40] = "abc"
    p = tmp_path / "bad.dxf"
    p.write_text("\n".join(lines), "utf-8")
    with pytest.raises(JobError, match="line 41"):
        read_dxf(p)


def test_refuses_an_undefined_block_naming_the_insert(tmp_path):
    d = Dxf()
    h = d.insert("PLANT", "GHOST", (0, 0))
    with pytest.raises(JobError) as e:
        read_dxf(d.write(tmp_path / "ghost.dxf"))
    msg = str(e.value)
    assert "GHOST" in msg and h in msg and "PLANT" in msg


def test_refuses_huge_and_invalid_coordinates(tmp_path):
    d = Dxf()
    h = d.line("ROADS", (0, 0), (2e9, 0))
    with pytest.raises(JobError) as e:
        read_dxf(d.write(tmp_path / "huge.dxf"))
    assert "LINE" in str(e.value) and h in str(e.value) and "ROADS" in str(e.value)
    d = Dxf()
    d.raw([(0, "CIRCLE"), (8, "X"), (10, "nan"), (20, 0.0), (40, 1.0)])
    with pytest.raises(JobError, match="CIRCLE"):
        read_dxf(d.write(tmp_path / "nan.dxf"))


def test_arcs_become_polylines_and_text_codes_are_stripped(tmp_path):
    d = Dxf()
    d.arc("A", (0, 0), 2, 0, 90)
    d.mtext("A", (0, 0), "\\A1;{\\H0.7x;\\C1;Pump} \\Lroom\\l\\P2")
    doc = read_dxf(d.write(tmp_path / "arc.dxf"))
    arc = next(e for e in doc.entities if e.type == "ARC")
    assert arc.points[0] == pytest.approx((2, 0))
    assert arc.points[-1] == pytest.approx((0, 2), abs=1e-9)
    assert all(math.hypot(x, y) == pytest.approx(2) for x, y in arc.points)
    mt = next(e for e in doc.entities if e.type == "MTEXT")
    assert mt.text == "Pump room\n2"


# --------------------------------------------------------------------------------------------
# the pipeline


def last(result):
    return result["outputs"]["commit"]


def parts_of(project, out):
    doc = json.loads((project / out["parts"]).read_text("utf-8"))
    check_procmodel(doc)
    return doc, {p["id"]: p for p in doc["parts"]}


def lonlat(e, n):
    from rasterio.warp import transform

    lon, lat = transform(f"EPSG:{EPSG}", "EPSG:4326", [e], [n])
    return [lon[0], lat[0]]


def test_imports_a_metre_drawing_far_from_the_project_at_the_origin(project, tmp_path):
    write_manifest(project)
    d, h = plot_plan()
    src = d.write(tmp_path / "Plot Plan.dxf")
    res, rec = run_job(DrawingImport(), project, {"src": str(src)})
    out = last(res)
    assert out["drawing"] == "drawings/Plot-Plan.dxf"
    assert (project / out["drawing"]).read_bytes() == src.read_bytes()
    assert out["units"] == "m" and out["partCount"] >= 6 and out["hints"] >= 4
    assert any("Skipped 1 DIMENSION, 2 HATCH" in m["message"] for m in rec.of("log"))
    doc, parts = parts_of(project, out)
    assert doc["id"] == "Plot-Plan" and doc["name"] == "Plot Plan.dxf"
    assert doc["sources"] == [{"kind": "drawing", "ref": "drawings/Plot-Plan.dxf"}]
    t1 = parts[f"dxf-{h['t101']}"]
    assert t1["tag"] == "T-101" and t1["height"] == pytest.approx(12.5) and t1["class"] == "tank"
    assert t1["origin"] == {
        "by": "drawing",
        "file": "drawings/Plot-Plan.dxf",
        "layer": "TANKS",
        "entity": h["t101"],
    }
    t2 = parts[f"dxf-{h['t102']}"]
    assert t2["tag"] == "T-102" and t2["height"] == pytest.approx(10.0) and t2["radius"] == pytest.approx(4)
    v = parts[f"dxf-{h['v201']}"]
    assert v["class"] == "vessel" and v["tag"] == "V201" and v["height"] == pytest.approx(2)
    assert v["confidence"] < 0.5
    b = parts[f"dxf-{h['bld']}"]
    assert b["kind"] == "extrusion" and b["height"] == pytest.approx(6)
    assert footprint_is_ccw_from_above(b["footprint"])
    s = parts[f"dxf-{h['skid']}"]
    assert s["kind"] == "box" and s["size"] == pytest.approx([6, 2.5, 3], abs=1e-3)
    assert s["yawDeg"] == pytest.approx(30, abs=0.01)
    p = parts[f"dxf-{h['pipe']}"]
    assert p["kind"] == "pipe" and p["diameter"] == pytest.approx(0.3) and p["confidence"] > 0.5
    assert len(p["points"]) == 3 and all(pt[1] == pytest.approx(3.2) for pt in p["points"])
    pumps = [x for x in parts.values() if x["id"].startswith(f"dxf-{h['ins2']}-")]
    assert len(pumps) == 1 and pumps[0]["radius"] == pytest.approx(1.0)
    placement = json.loads((project / out["placement"]).read_text("utf-8"))
    assert placement["schema"] == "aio.drawingplacement/1" and placement["provisional"] is True
    assert placement["unitM"] == 1.0 and placement["control"] == [] and placement["rmsM"] is None
    assert any("placed at the project origin" in m["message"] for m in rec.of("log"))
    # bounding-box centre at local (0, 0), north up
    a, b_, c, dd, tx, tz = placement["matrix"]
    assert (a, b_, c, dd) == (1.0, 0.0, 0.0, -1.0)


def test_without_control_points_drawing_metres_are_project_coordinates(project, tmp_path):
    write_manifest(project)
    d = Dxf()
    h = d.circle("TANKS", (ORIGIN[0] + 10, ORIGIN[1] + 20), 5)
    res, rec = run_job(DrawingImport(), project, {"src": str(d.write(tmp_path / "utm.dxf"))})
    _, parts = parts_of(project, last(res))
    assert parts[f"dxf-{h}"]["base"] == pytest.approx([10, 0, -20], abs=1e-6)
    placement = json.loads((project / last(res)["placement"]).read_text("utf-8"))
    assert placement["provisional"] is True
    a, b, c, dd, tx, tz = placement["matrix"]
    x, y = ORIGIN[0] + 10, ORIGIN[1] + 20
    assert a * x + b * y + tx == pytest.approx(10) and c * x + dd * y + tz == pytest.approx(-20)
    assert not any("project origin" in m["message"] for m in rec.of("log"))


def test_millimetre_file_is_scaled_and_placed_by_lonlat_control_points(project, tmp_path):
    write_manifest(project)
    d, h = plot_plan(scale=1000, insunits=4)

    # drawing metres (x, y) to local: turned 90 degrees, x = 100 - y, z = 50 - x
    def local(x, y):
        return (100.0 - y, 50.0 - x)

    def ctl(x, y):
        lx, lz = local(x, y)
        return {"drawing": [x * 1000, y * 1000], "lonLat": lonlat(ORIGIN[0] + lx, ORIGIN[1] - lz)}

    control = [ctl(0, 0), ctl(80, 0), ctl(80, 60)]
    src = d.write(tmp_path / "mm.dxf")
    res, _ = run_job(DrawingImport(), project, {"src": str(src), "control": control})
    out = last(res)
    assert out["units"] == "mm" and out["scale"] == pytest.approx(1, abs=1e-4) and out["rmsM"] < 0.01
    _, parts = parts_of(project, out)
    t1 = parts[f"dxf-{h['t101']}"]
    lx, lz = local(20, 30)
    assert t1["base"][0] == pytest.approx(lx, abs=0.01) and t1["base"][2] == pytest.approx(lz, abs=0.01)
    assert t1["radius"] == pytest.approx(6, abs=1e-3)
    placement = json.loads((project / out["placement"]).read_text("utf-8"))
    a, b, c, dd, tx, tz = placement["matrix"]
    assert placement["provisional"] is False and placement["unitM"] == 0.001
    assert a * 20000 + b * 30000 + tx == pytest.approx(lx, abs=0.01)
    assert c * 20000 + dd * 30000 + tz == pytest.approx(lz, abs=0.01)


def test_local_control_points_set_the_base_height(project, tmp_path):
    write_manifest(project)
    d, h = plot_plan()
    control = [
        {"drawing": [0, 0], "local": [5, 2, -5]},
        {"drawing": [100, 0], "local": [105, 2, -5]},
    ]
    src = d.write(tmp_path / "p.dxf")
    res, _ = run_job(DrawingImport(), project, {"src": str(src), "control": control})
    _, parts = parts_of(project, last(res))
    assert parts[f"dxf-{h['t101']}"]["base"] == pytest.approx([25, 2, -35], abs=0.01)
    # EL +10.000 is a top elevation: height = 10 - baseY
    assert parts[f"dxf-{h['t102']}"]["height"] == pytest.approx(8)


def test_plan_and_vector_layers_added_once_on_reimport(project, tmp_path):
    from PIL import Image

    write_manifest(project)
    d, _ = plot_plan()
    src = d.write(tmp_path / "plot.dxf")
    control = [{"drawing": [0, 0], "local": [0, 0, 0]}, {"drawing": [100, 0], "local": [100, 0, 0]}]
    params = {"src": str(src), "control": control, "layers": ["TANKS", "TEXT", "PIPE"]}
    res, _ = run_job(DrawingImport(), project, params)
    out = last(res)
    m = read_manifest(project)
    plan = next(x for x in m["layers"] if x["id"] == "plan-plot")
    assert plan["role"] == "plan" and plan["format"] == "image"
    assert plan["src"] == {"path": "drawings/plot/plan.png"}
    assert set(plan["corners"]) == {"tl", "tr", "bl"} and plan["corners"]["tl"][1] == pytest.approx(0.02)
    img = Image.open(project / out["plan"])
    assert img.mode == "RGBA" and max(img.size) <= 4096 and img.getpixel((0, 0))[3] == 0
    assert sorted(out["vectorLayers"]) == ["drawing-plot-pipe", "drawing-plot-tanks", "drawing-plot-text"]
    vec = next(x for x in m["layers"] if x["id"] == "drawing-plot-tanks")
    assert vec["format"] == "geojson" and vec["style"]["line"]["width"] == 1.5
    assert vec["name"] == "plot.dxf TANKS"
    fc = json.loads((project / "drawings/plot/tanks.geojson").read_text("utf-8"))
    assert {f["geometry"]["type"] for f in fc["features"]} == {"Polygon"}
    assert set(fc["features"][0]["properties"]) == {"layer", "handle", "type"}
    texts = json.loads((project / "drawings/plot/text.geojson").read_text("utf-8"))
    assert any(f["properties"].get("text") == "T-101" for f in texts["features"])
    assert (project / "manifest.json.bak").is_file()
    n = len(m["layers"])
    run_job(DrawingImport(), project, params, job_id="j2")
    assert len(read_manifest(project)["layers"]) == n


def test_no_epsg_skips_the_vector_layers(project, tmp_path):
    write_manifest(project, epsg=None)
    d, _ = plot_plan()
    res, rec = run_job(DrawingImport(), project, {"src": str(d.write(tmp_path / "p.dxf"))})
    assert last(res)["vectorLayers"] == []
    assert any("no EPSG code" in m["message"] for m in rec.of("log"))


def test_refusals(project, tmp_path):
    write_manifest(project)
    with pytest.raises(JobError, match=r"DWG is not supported\. Save the drawing as DXF and import again\."):
        DrawingImport().validate({"src": "plan.dwg"})
    d, _ = plot_plan(insunits=0)
    src = d.write(tmp_path / "plot.dxf")
    with pytest.raises(JobError, match=r'"plot\.dxf" has no drawing units\. Set the drawing units'):
        run_job(DrawingImport(), project, {"src": str(src)})
    res, _ = run_job(DrawingImport(), project, {"src": str(src), "units": "m"}, job_id="j2")
    assert last(res)["units"] == "m"
    with pytest.raises(JobError) as e:
        run_job(DrawingImport(), project, {"src": str(src), "units": "m", "layers": ["NOPE"]}, job_id="j3")
    assert "TANKS" in str(e.value) and "NOPE" in str(e.value)
    ctl = [{"drawing": [1, 1], "local": [0, 0, 0]}, {"drawing": [1, 1], "local": [5, 0, 0]}]
    with pytest.raises(JobError, match="at least 2 control points"):
        run_job(DrawingImport(), project, {"src": str(src), "units": "m", "control": ctl}, job_id="j4")


def test_resume_with_a_changed_drawing_is_refused(project, tmp_path):
    write_manifest(project)
    d, _ = plot_plan()
    src = d.write(tmp_path / "plot.dxf")
    run_job(DrawingImport(), project, {"src": str(src)})
    src.write_text(src.read_text("utf-8") + "999\nX\n", "utf-8")
    os.utime(src, ns=(1, 1))
    with pytest.raises(JobError, match=INPUTS_CHANGED):
        run_job(DrawingImport(), project, {"src": str(src)})
