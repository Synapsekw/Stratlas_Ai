"""drawing.import: the DXF reader, placement by control points, parts, plan and vector layers."""

from __future__ import annotations

import math

import pytest

from aio_pipelines.drawing.dxf import read_dxf
from aio_pipelines.runtime import JobError
from modelling_synth import Dxf, plot_plan

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
