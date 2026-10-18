"""Drawing associations must survive layout changes; no fixed sheet-coordinate windows."""

import ezdxf
import numpy as np
import pytest
from ezdxf.math import Matrix44

from aio_pipelines.engineer.drawings import read_drawing


def make_drawing(path, angle=0, offset=(0, 0)):
    d = ezdxf.new()
    d.units = 6
    m = d.modelspace()
    m.add_circle((0, 0), 0.4, dxfattribs={"layer": "TOWER"})
    for i, (x, z, w, depth, h) in enumerate([(1, 0, 0.5, 0.18, 2.6), (-1, 0.4, 0.32, 0.24, 0.6)]):
        name = ["A01", "R01"][i]
        layer = ["ANT-ALPHA", "RRU"][i]
        m.add_lwpolyline(
            [
                (x - w / 2, z + depth / 2),
                (x + w / 2, z + depth / 2),
                (x + w / 2, z - depth / 2),
                (x - w / 2, z - depth / 2),
            ],
            close=True,
            dxfattribs={"layer": layer},
        )
        m.add_mtext(name, dxfattribs={"insert": (x, z), "char_height": 0.08, "layer": "ANNO"})
        m.add_circle((x * 0.8, z), 0.05, dxfattribs={"layer": "PIPE"})
        m.add_mtext(f"P{i + 1:02}", dxfattribs={"insert": (x * 0.8, z), "char_height": 0.08, "layer": "PIPE"})
        row = [name, ["PANEL", "RRU"][i], "ALPHA", "0", "25", str(25 + h), f"{w}x{depth}x{h}", f"P{i + 1:02}"]
        for j, t in enumerate(row):
            m.add_mtext(
                t, dxfattribs={"insert": (10 + j * 2, 4 - i * 0.4), "char_height": 0.1, "layer": "TABLE"}
            )
    for j, t in enumerate(["ID", "TYPE", "SECT", "AZ", "BOTTOM", "TOP", "W x D x H (m)", "PIPE"]):
        m.add_mtext(t, dxfattribs={"insert": (10 + j * 2, 4.4), "char_height": 0.1, "layer": "TABLE"})
    transform = Matrix44.chain(Matrix44.z_rotate(angle), Matrix44.translate(*offset, 0))
    for e in m:
        e.transform(transform)
    d.saveas(path)


@pytest.mark.parametrize("angle,offset", [(0, (0, 0)), (0.63, (850, -240)), (-1.2, (-400, 900))])
def test_schedule_and_footprints_are_associated_independently_of_sheet_position(tmp_path, angle, offset):
    path = tmp_path / "site.dxf"
    make_drawing(path, angle, offset)
    d = read_drawing(path)
    assert not d.warnings
    assert len(d.devices) == 2
    a, r = sorted(d.devices, key=lambda x: x.label)
    assert a.kind == "panel" and r.kind == "rru"
    np.testing.assert_allclose(a.centre_en, [1, 0], atol=1e-8)
    np.testing.assert_allclose(r.centre_en, [-1, 0.4], atol=1e-8)
    assert a.size == pytest.approx((0.5, 2.6, 0.18))
    assert r.size == pytest.approx((0.32, 0.6, 0.24))
    assert a.azimuth_deg == pytest.approx(0, abs=1e-6)
    assert a.bottom == 25 and a.parent == "P01"
    assert len(d.pipes) == 2


def test_unmatched_schedule_row_is_reported_not_fabricated(tmp_path):
    path = tmp_path / "site.dxf"
    make_drawing(path)
    doc = ezdxf.readfile(path)
    for e in list(doc.modelspace().query('LWPOLYLINE[layer=="RRU"]')):
        doc.modelspace().delete_entity(e)
    doc.saveas(path)
    d = read_drawing(path)
    assert len(d.devices) == 1
    assert any("R01" in w for w in d.warnings)
