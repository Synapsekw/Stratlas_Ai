"""Tests for the 2D similarity used by date line-ups."""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pytest

from aio_pipelines.similarity import Similarity

FIXTURE = Path(__file__).resolve().parents[2] / "packages/schema/src/__fixtures__/date-shift/similarity.json"


def _fixture() -> dict:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def _sim(d: dict) -> Similarity:
    return Similarity(d["eastM"], d["northM"], d["rotationDeg"], d["scale"], d["pivotE"], d["pivotN"])


PTS = [(500010.0, 2700020.0), (500300.0, 2699800.0), (499700.0, 2700400.0)]
TURNED = Similarity(1.5, -0.7, 0.1, 1.0035, 500000.0, 2700000.0)


def test_shift_only_matches_capture_shift():
    s = Similarity(2, -1)
    e, n = s.apply_en(np.array([10.0, 20.0]), np.array([5.0, 6.0]))
    assert np.allclose(e, [12.0, 22.0]) and np.allclose(n, [4.0, 5.0])
    assert s.apply_en(3.0, 4.0) == (5.0, 3.0)
    assert not s.has_turn()


def test_inverse_round_trips():
    for case in _fixture()["cases"]:
        s = _sim(case["s"])
        for e, n in case["en"]:
            e2, n2 = s.inverse().apply_en(*s.apply_en(e, n))
            assert abs(e2 - e) < 1e-9 and abs(n2 - n) < 1e-9


def test_then_composes():
    a = TURNED
    b = Similarity(-0.4, 0.9, -0.3, 0.998, 500200.0, 2700100.0)
    ab = a.then(b)
    assert (ab.pivot_e, ab.pivot_n) == (b.pivot_e, b.pivot_n)
    for p in PTS:
        want = b.apply_en(*a.apply_en(*p))
        got = ab.apply_en(*p)
        assert math.hypot(got[0] - want[0], got[1] - want[1]) < 1e-9


def test_local_matches_en_through_origin():
    for origin in ([500000.0, 2700000.0, 10.0], [499000.0, 2701500.0, 0.0]):
        for e, n in PTS:
            x, z = e - origin[0], origin[1] - n
            lx, lz = TURNED.apply_local(x, z, origin)
            e2, n2 = TURNED.apply_en(e, n)
            assert abs(lx - (e2 - origin[0])) < 1e-9
            assert abs(lz - (origin[1] - n2)) < 1e-9


def test_mat4_matches_apply_local():
    origin = [500000.0, 2700000.0, 10.0]
    m = TURNED.mat4_local(origin)
    assert len(m) == 16 and m[5] == 1.0 and m[15] == 1.0
    for e, n in PTS:
        x, z = e - origin[0], origin[1] - n
        mx = m[0] * x + m[4] * 0 + m[8] * z + m[12]
        mz = m[2] * x + m[10] * z + m[14]
        lx, lz = TURNED.apply_local(x, z, origin)
        assert abs(mx - lx) < 1e-9 and abs(mz - lz) < 1e-9
    # shift only matches captures.shift_transform's translation slots
    sm = Similarity(2, -1).mat4_local(origin)
    assert sm[12] == pytest.approx(2.0) and sm[14] == pytest.approx(1.0)


def test_crs_affine_matches_apply_en():
    aff = TURNED.crs_affine()
    for e, n in PTS:
        ae, an = aff @ (e, n)
        te, tn = TURNED.apply_en(e, n)
        assert abs(ae - te) < 1e-9 and abs(an - tn) < 1e-9


def test_max_move_at_corners():
    box = (499900.0, 2699900.0, 500100.0, 2700100.0)
    corners = [(box[0], box[1]), (box[0], box[3]), (box[2], box[1]), (box[2], box[3])]
    want = max(math.hypot(TURNED.apply_en(e, n)[0] - e, TURNED.apply_en(e, n)[1] - n) for e, n in corners)
    assert TURNED.max_move(box) == pytest.approx(want)
    assert Similarity(3, 4).max_move(box) == pytest.approx(5.0)


def test_identity_and_turn_dicts():
    assert Similarity(0.0004, -0.0003).is_identity()
    assert not Similarity(0.001, 0).is_identity()
    assert not Similarity(0, 0, 0.001).is_identity()
    assert not Similarity(0, 0, 0, 1.001).is_identity()
    assert Similarity(1, 2).to_turn() is None
    assert TURNED.to_turn() == {
        "rotationDeg": 0.1,
        "scale": 1.0035,
        "pivotE": 500000.0,
        "pivotN": 2700000.0,
    }
    back = Similarity.from_line_up({"eastM": 1.5, "northM": -0.7}, TURNED.to_turn())
    assert back == TURNED
    assert Similarity.from_line_up(None, None).is_identity()


def test_fixture():
    fx = _fixture()
    assert len(fx["cases"]) >= 4
    for case in fx["cases"]:
        s = _sim(case["s"])
        for (e, n), (eo, no) in zip(case["en"], case["enOut"], strict=True):
            ge, gn = s.apply_en(e, n)
            assert abs(ge - eo) < 1e-9 and abs(gn - no) < 1e-9
        for (x, y, z), (xo, yo, zo) in zip(case["local"], case["localOut"], strict=True):
            gx, gz = s.apply_local(x, z, fx["origin"])
            assert abs(gx - xo) < 1e-9 and y == yo and abs(gz - zo) < 1e-9
        m = s.mat4_local(fx["origin"])
        assert all(abs(a - b) < 1e-9 for a, b in zip(m, case["mat4"], strict=True))
