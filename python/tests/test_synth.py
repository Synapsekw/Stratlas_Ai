"""The procedural M8 generators (synth.py) make the documented shapes, with exact truth."""

from __future__ import annotations

import numpy as np
import rasterio

from synth import (
    cloud_pair,
    dsm_pair,
    mesh_pair,
    ortho_pair,
    read_las_xyz,
    scan,
    write_geotiff,
    write_las,
)


def test_ortho_pair_changes_only_where_truth_says():
    a, b, truth = ortho_pair(seed=3)
    assert a.shape == b.shape == (256, 256, 3)
    assert a.dtype == np.uint8
    assert {c["id"] for c in truth["changes"]} == {"added", "removed"}
    # undo the global tint and the shadow: what is left differs only inside the change boxes
    k = np.asarray(truth["tint"], dtype=np.float32)
    bb = b.astype(np.float32) / k
    y0, x0, y1, x1 = truth["clean"][0]["box"]
    bb[y0:y1, x0:x1] /= truth["clean"][0]["factor"]
    diff = np.abs(bb - a.astype(np.float32)).max(axis=2) > 6
    for c in truth["changes"]:
        cy0, cx0, cy1, cx1 = c["box"]
        assert diff[cy0:cy1, cx0:cx1].mean() > 0.9, c["id"]
        diff[cy0:cy1, cx0:cx1] = False
    assert diff.mean() < 0.001
    # same seed, same pixels
    a2, b2, _ = ortho_pair(seed=3)
    assert np.array_equal(a, a2) and np.array_equal(b, b2)


def test_dsm_pair_volumes_match_truth():
    a, b, truth = dsm_pair(seed=5)
    assert a.shape == b.shape == (192, 192)
    assert a.dtype == np.float32
    cell = truth["res"] ** 2
    d = (b - a).astype(np.float64)
    fill = d[d >= 0.1].sum() * cell
    cut = -d[d <= -0.1].sum() * cell
    assert abs(fill - truth["fill_m3"]) / truth["fill_m3"] < 0.03
    assert abs(cut - truth["cut_m3"]) / truth["cut_m3"] < 0.03
    assert truth["noise_m"] == 0.02
    flat = d[:20, :20]
    assert np.abs(flat).max() <= 0.041


def test_cloud_pair_moves_adds_and_removes_one_object_each():
    a, b, truth = cloud_pair(seed=7)
    assert a.ndim == 2 and a.shape[1] == 3 and b.shape[1] == 3
    assert {o["verdict"] for o in truth["objects"]} == {"moved", "added", "removed", "unchanged"}
    moved = next(o for o in truth["objects"] if o["verdict"] == "moved")
    assert moved["offset"] == [2.0, 0.0, -1.0]

    def inside(p, box):
        lo, hi = np.asarray(box[0]), np.asarray(box[1])
        return np.all((p >= lo) & (p <= hi), axis=1).sum()

    added = next(o for o in truth["objects"] if o["verdict"] == "added")
    removed = next(o for o in truth["objects"] if o["verdict"] == "removed")
    assert inside(a, added["box"]) == 0 and inside(b, added["box"]) > 100
    assert inside(a, removed["box"]) > 100 and inside(b, removed["box"]) == 0
    assert truth["noise_m"] == 0.01


def test_mesh_pair_has_added_removed_moved_and_dented_parts():
    a, b, truth = mesh_pair(seed=1)
    assert set(a) - set(b) == {"BOX-2"}
    assert set(b) - set(a) == {"BOX-3"}
    v = {i["part"]: i for i in truth["parts"]}
    assert v["BOX-1"]["verdict"] == "moved"
    va, vb = a["BOX-1"][0], b["BOX-1"][0]
    assert np.allclose(vb.mean(axis=0) - va.mean(axis=0), v["BOX-1"]["offset"], atol=1e-6)
    assert v["TANK-1"]["verdict"] == "changed"
    dent = np.linalg.norm(a["TANK-1"][0] - b["TANK-1"][0], axis=1).max()
    assert abs(dent - v["TANK-1"]["max_m"]) < 1e-6
    for verts, faces in [*a.values(), *b.values()]:
        assert faces.max() < len(verts)


def test_scan_points_lie_on_the_primitives():
    pts, truth = scan(seed=2)
    kinds = sorted(p["kind"] for p in truth["primitives"])
    assert kinds == ["box", "cylinder", "cylinder", "pipe"]
    tank = next(p for p in truth["primitives"] if p["kind"] == "cylinder")
    cx, _, cz = tank["base"]
    r = np.hypot(pts[:, 0] - cx, pts[:, 2] - cz)
    on = (np.abs(r - tank["radius"]) < 0.05) & (pts[:, 1] > 0.2) & (pts[:, 1] < tank["height"])
    assert on.sum() > 500


def test_geotiff_and_las_writers(tmp_path):
    a, _, truth = dsm_pair(seed=5)
    path = write_geotiff(tmp_path / "dsm.tif", a, x0=300000.0, y1=2600000.0, res=truth["res"], epsg=32631)
    with rasterio.open(path) as d:
        assert d.crs.to_epsg() == 32631
        assert d.res == (truth["res"], truth["res"])
        assert np.array_equal(d.read(1), a)
    xyz = np.array([[300000.5, 2600000.25, 400.125], [300001.0, 2599999.0, 401.0]])
    las = write_las(tmp_path / "c.las", xyz, epsg=32631)
    assert np.allclose(read_las_xyz(las), xyz, atol=0.0005)
