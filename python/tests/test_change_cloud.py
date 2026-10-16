"""change.cloud: cloud-to-cloud distance, change regions and the tiled run (synthetic clouds only).

The maths runs on numpy arrays, so most tests need no PDAL; the end-to-end job (COPC in and out)
is skipped with a reason when PDAL is not available, as in test_pointcloud.py.
"""

import json
import subprocess
import threading
from pathlib import Path

import numpy as np
import pytest

from aio_pipelines.change.changeset import validate_change_set
from aio_pipelines.change.cloud import (
    ChangeCloud,
    MemorySource,
    agreed,
    c2c_distances,
    cell_aggregates,
    compare_tiled,
    find_regions,
    plan_tiles,
    registration,
)
from aio_pipelines.change.las import read_las, write_las
from aio_pipelines.pointcloud import find_pdal
from aio_pipelines.runtime import Job, JobError
from conftest import Recorder

PDAL = find_pdal()
needs_pdal = pytest.mark.skipif(PDAL is None, reason="PDAL not found (set AIO_PDAL)")

# ---------------------------------------------------------------- synthetic scenes


def plane(rng, x0, x1, y0, y1, z=0.0, spacing=0.04, noise=0.002):
    n = int((x1 - x0) * (y1 - y0) / spacing**2)
    return np.column_stack([rng.uniform(x0, x1, n), rng.uniform(y0, y1, n), z + rng.normal(0, noise, n)])


def box(rng, cx, cy, size=2.0, height=2.0, spacing=0.04, noise=0.002):
    """The top and four sides of a box standing on z = 0 (no bottom: it sits on the ground)."""
    h = size / 2
    faces = [plane(rng, cx - h, cx + h, cy - h, cy + h, height, spacing, noise)]
    m = int(size * height / spacing**2)
    for axis, side in ((0, -1), (0, 1), (1, -1), (1, 1)):
        u = rng.uniform(-h, h, m)
        w = rng.uniform(0, height, m)
        fixed = side * h + rng.normal(0, noise, m)
        if axis == 0:
            faces.append(np.column_stack([cx + fixed, cy + u, w]))
        else:
            faces.append(np.column_stack([cx + u, cy + fixed, w]))
    return np.vstack(faces)


def cylinder(rng, cx, cy, radius=0.8, height=3.0, spacing=0.04, noise=0.002):
    m = int(2 * np.pi * radius * height / spacing**2)
    a = rng.uniform(0, 2 * np.pi, m)
    side = np.column_stack([cx + radius * np.cos(a), cy + radius * np.sin(a), rng.uniform(0, height, m)])
    k = int(np.pi * radius**2 / spacing**2)
    r = radius * np.sqrt(rng.uniform(0, 1, k))
    b = rng.uniform(0, 2 * np.pi, k)
    top = np.column_stack([cx + r * np.cos(b), cy + r * np.sin(b), np.full(k, height)])
    return np.vstack([side, top]) + rng.normal(0, noise, (m + k, 3))


def ground(rng, holes=(), extent=10.0, spacing=0.04):
    """A flat 20 x 20 m ground with the footprints of the objects (cx, cy, half size) cut out."""
    g = plane(rng, -extent, extent, -extent, extent, 0.0, spacing)
    keep = np.ones(len(g), dtype=bool)
    for cx, cy, h in holes:
        keep &= ~((np.abs(g[:, 0] - cx) < h) & (np.abs(g[:, 1] - cy) < h))
    return g[keep]


# ---------------------------------------------------------------- distances


def test_a_box_moved_30_cm_measures_30_cm_on_its_leading_face_and_nothing_elsewhere():
    rng = np.random.default_rng(7)
    before = np.vstack([ground(rng, [(0, 0, 1)]), box(rng, 0, 0)])
    after = np.vstack([ground(rng, [(0.3, 0, 1)]), box(rng, 0.3, 0)])
    d = c2c_distances(before, after, cap=3.0)
    assert d.dtype == np.float32 and d.shape == (len(after),)
    # the leading face (x = 1.3 m), away from its edges
    face = (
        (np.abs(after[:, 0] - 1.3) < 0.01)
        & (np.abs(after[:, 1]) < 0.6)
        & (after[:, 2] > 0.4)
        & (after[:, 2] < 1.6)
    )
    assert face.sum() > 100
    assert np.abs(d[face] - 0.30).max() < 0.01
    far = np.hypot(after[:, 0], after[:, 1]) > 3.0
    assert np.percentile(d[far], 99) < 0.01
    # nothing elsewhere reaches the significant 5 cm (the sampling of the two dates differs)
    assert d[far].max() < 0.05


def test_signed_distance_is_positive_above_and_negative_below_the_earlier_surface():
    rng = np.random.default_rng(3)
    before = plane(rng, 0, 10, 0, 10, 0.0)
    after = plane(rng, 0, 10, 0, 10, 0.0)
    lift = (after[:, 0] > 2) & (after[:, 0] < 4) & (after[:, 1] > 2) & (after[:, 1] < 8)
    dig = (after[:, 0] > 6) & (after[:, 0] < 8) & (after[:, 1] > 2) & (after[:, 1] < 8)
    after[lift, 2] += 0.2
    after[dig, 2] -= 0.15
    d = c2c_distances(before, after, cap=3.0, signed=True)
    core_lift = lift & (after[:, 0] > 2.5) & (after[:, 0] < 3.5)
    core_dig = dig & (after[:, 0] > 6.5) & (after[:, 0] < 7.5)
    assert np.median(d[core_lift]) == pytest.approx(0.2, abs=0.01)
    assert np.median(d[core_dig]) == pytest.approx(-0.15, abs=0.01)
    assert np.abs(d[~(lift | dig) & (after[:, 0] > 0.5) & (after[:, 0] < 1.5)]).max() < 0.02


def test_a_point_far_from_the_earlier_cloud_is_capped():
    ref = np.array([[0.0, 0, 0], [0.1, 0, 0], [0, 0.1, 0]])
    d = c2c_distances(ref, np.array([[50.0, 0, 0]]), cap=3.0)
    assert d[0] == pytest.approx(3.0)


# ---------------------------------------------------------------- regions


def _regions(before, after, min_dist=0.05, cell=0.25):
    fwd = c2c_distances(before, after, cap=3.0)
    rev = c2c_distances(after, before, cap=3.0)
    return find_regions(
        cell_aggregates(after, fwd, min_dist=min_dist, cell=cell),
        cell_aggregates(before, rev, min_dist=min_dist, cell=cell),
        cell=cell,
    )


def test_a_new_cylinder_is_one_added_region_and_a_removed_box_is_found_in_reverse():
    rng = np.random.default_rng(11)
    g = ground(rng, [(4, 4, 0.8), (-5, -5, 1.0)])
    before = np.vstack([g, box(rng, -5, -5)])
    after = np.vstack([g + rng.normal(0, 0.002, g.shape), cylinder(rng, 4, 4)])
    regions = _regions(before, after)
    added = [r for r in regions if r.verdict == "added"]
    removed = [r for r in regions if r.verdict == "removed"]
    assert len(added) == 1 and len(removed) == 1, [(r.verdict, r.centroid) for r in regions]
    assert np.hypot(*(added[0].centroid[:2] - [4, 4])) < 0.25
    assert added[0].max_d > 2.5
    assert np.hypot(*(removed[0].centroid[:2] - [-5, -5])) < 0.25
    assert removed[0].area_m2 == pytest.approx(4.0, rel=0.1)
    # ids are stable: the same clouds give the same ids
    assert [r.id for r in _regions(before, after)] == [r.id for r in regions]


def test_noise_alone_gives_no_region():
    rng = np.random.default_rng(5)
    a = plane(rng, 0, 10, 0, 10, 0.0, noise=0.005)
    b = plane(rng, 0, 10, 0, 10, 0.0, noise=0.005)
    assert _regions(a, b) == []


def _survey(seed, pile_h, sigma, density=30.0, half=30.0):
    """A 60 m square of gently sloping ground sampled at random (``density`` points a square metre,
    ``sigma`` of height noise), with a pile ``pile_h`` high and 7 m across its foot at (-12, 6)."""
    rng = np.random.default_rng(seed)
    n = int(density * (2 * half) ** 2)
    xy = rng.uniform(-half, half, (n, 2))
    r = np.hypot(xy[:, 0] + 12, xy[:, 1] - 6)
    z = 0.02 * xy[:, 0] + np.where(r < 7, pile_h * (1 - r / 7), 0.0) + rng.normal(0, sigma, n)
    return np.column_stack([xy, z])


def _inside(poly, x, y):
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        (xi, yi), (xj, yj) = poly[i], poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


WHOLE = [(-30.0, 30.001, -30.0, 30.001)]


@pytest.mark.parametrize("sigma", [0.02, 0.03, 0.035])
def test_two_noisy_surveys_give_the_pile_and_no_open_ground(sigma):
    """Two independent samples of the same ground, each with its own noise: a lone noisy point is
    not change, so the open ground stays out of the regions and the pile is one region its size."""
    a, b = _survey(1, 4.0, sigma), _survey(2, 6.0, sigma)
    res = compare_tiled(MemorySource(a), MemorySource(b), WHOLE, cap=3.0, min_dist=0.05, cell=0.25)
    regions = find_regions(res.forward, res.reverse, cell=0.25)
    pile = [r for r in regions if _inside(r.outline, -12, 6)]
    assert len(pile) == 1 and pile[0].area_m2 == pytest.approx(np.pi * 49, rel=0.2)
    for x, y in ((-25, 4), (-25, -20), (0, -20)):
        assert not any(_inside(r.outline, x, y) for r in regions), (x, y)
    # the distances and their statistics are every point's own
    fwd = c2c_distances(a, b, cap=3.0)
    assert res.changed == int((np.abs(fwd) >= 0.05).sum())


def test_the_neighbour_agreement_is_the_same_tiled():
    a, b = _survey(1, 4.0, 0.03, half=12.0), _survey(2, 6.0, 0.03, half=12.0)
    tiles = plan_tiles((-12, 12, -12, 12), points=len(b), max_points=len(b) // 6, cell=0.25)
    assert len(tiles) > 4
    whole = compare_tiled(
        MemorySource(a), MemorySource(b), [(-12, 12.001, -12, 12.001)], cap=3.0, min_dist=0.05, cell=0.25
    )
    tiled = compare_tiled(MemorySource(a), MemorySource(b), tiles, cap=3.0, min_dist=0.05, cell=0.25)
    for one, many in ((whole.forward, tiled.forward), (whole.reverse, tiled.reverse)):
        assert len(one.count) > 0
        assert np.array_equal(one.keys, many.keys) and np.array_equal(one.count, many.count)


def test_the_neighbour_agreement_in_small_blocks_is_the_same_as_in_one():
    a, b = _survey(1, 4.0, 0.03, half=10.0), _survey(2, 6.0, 0.03, half=10.0)
    inside = (np.abs(b[:, 0] + 6) < 4) & (np.abs(b[:, 1] - 4) < 4)  # a tile over half the pile
    d = c2c_distances(a, b[inside], cap=3.0)
    measured: list = []

    def measure(q):
        measured.append(len(q))
        return c2c_distances(a, q, cap=3.0)

    one = agreed(b, inside, d, measure, min_dist=0.05)
    small = agreed(b, inside, d, measure, min_dist=0.05, block=7)
    assert np.isnan(one).any() and (np.abs(one) >= 0.05).any()
    assert np.array_equal(one, small, equal_nan=True)
    assert measured[0] > 0  # the tile's edge needed points from the margin


def test_the_margin_is_measured_on_the_trees_already_built(monkeypatch):
    import scipy.spatial

    a, b = _survey(1, 4.0, 0.03, half=10.0), _survey(2, 6.0, 0.03, half=10.0)
    built = []
    tree = scipy.spatial.cKDTree

    def counting(*args, **kw):
        built.append(1)
        return tree(*args, **kw)

    monkeypatch.setattr(scipy.spatial, "cKDTree", counting)
    compare_tiled(
        MemorySource(a), MemorySource(b), [(-10.0, -2.0, 0.0, 8.0)], cap=3.0, min_dist=0.05, cell=0.25
    )
    assert len(built) == 4  # one per cloud for the distances, one per cloud for its neighbours


# ---------------------------------------------------------------- registration and tiles


def test_registration_flags_dates_that_do_not_line_up():
    rng = np.random.default_rng(2)
    a = plane(rng, 0, 10, 0, 10)
    good = registration(c2c_distances(a, plane(rng, 0, 10, 0, 10) + np.array([0, 0, 0.02]), cap=3.0), 0.05)
    assert good["ok"] is True
    assert good["shiftM"] == pytest.approx(0.02, abs=0.005)
    bad = registration(c2c_distances(a, plane(rng, 0, 10, 0, 10) + np.array([0, 0, 0.12]), cap=3.0), 0.05)
    assert bad["ok"] is False
    assert bad["toleranceM"] == 0.05
    assert "not aligned" in bad["message"]


def test_tiles_cover_the_bounds_and_keep_to_the_point_cap():
    tiles = plan_tiles((0, 100, 0, 50), points=1_000_000, max_points=100_000, cell=0.25)
    assert len(tiles) >= 10
    assert min(t[0] for t in tiles) == pytest.approx(0) and max(t[1] for t in tiles) >= 100
    assert min(t[2] for t in tiles) == pytest.approx(0) and max(t[3] for t in tiles) >= 50
    side = tiles[0][1] - tiles[0][0]
    assert side / 0.25 == pytest.approx(round(side / 0.25))
    assert plan_tiles((0, 10, 0, 10), points=1000, max_points=100_000, cell=0.25) == [(0, 10, 0, 10)]


def test_the_tiled_run_gives_the_untiled_distances():
    rng = np.random.default_rng(9)
    g = ground(rng, [(2, 2, 1)], extent=6)
    before = np.vstack([g, box(rng, 2, 2)])
    after = np.vstack([g + rng.normal(0, 0.002, g.shape), box(rng, 2.3, 2)])
    whole = c2c_distances(before, after, cap=3.0)
    lo, hi = np.minimum(before.min(0), after.min(0)), np.maximum(before.max(0), after.max(0))
    tiles = plan_tiles((lo[0], hi[0], lo[1], hi[1]), points=len(after), max_points=len(after) // 6, cell=0.25)
    assert len(tiles) > 4
    got = {}

    def keep(i, idx, xyz, d, las):
        for p, v in zip(map(tuple, xyz), d, strict=True):
            got[p] = v

    res = compare_tiled(
        MemorySource(before), MemorySource(after), tiles, cap=3.0, min_dist=0.05, cell=0.25, on_tile=keep
    )
    assert len(got) == len(after)
    tiled = np.array([got[tuple(p)] for p in after])
    assert np.allclose(tiled, whole, atol=1e-6)
    assert res.points == len(after)
    assert res.changed == int((whole >= 0.05).sum())


# ---------------------------------------------------------------- the pipeline


def test_validate_fills_the_founder_defaults_and_refuses_bad_values():
    p = ChangeCloud()
    v = p.validate({"layerFrom": "a", "layerTo": "b"})
    assert v["minDistM"] == 0.05 and v["maxDistM"] == 0.3 and v["signed"] is False
    with pytest.raises(JobError, match="does not take"):
        p.validate({"layerFrom": "a", "layerTo": "b", "colour": 1})
    with pytest.raises(JobError, match="larger"):
        p.validate({"layerFrom": "a", "layerTo": "b", "minDistM": 0.5, "maxDistM": 0.3})
    with pytest.raises(JobError, match="two different"):
        p.validate({"layerFrom": "a", "layerTo": "a"})


def _project(tmp_path, layers, captures=("c1", "c2")):
    root = tmp_path / "proj"
    root.mkdir()
    manifest = {
        "schema": "aio.project/1",
        "id": "p",
        "name": "Synthetic",
        "crs": {"epsg": 32639},
        "origin": [500000, 3200000, 0],
        "captures": [{"id": c, "date": f"2026-0{i + 1}-01"} for i, c in enumerate(captures)],
        "layers": layers,
    }
    (root / "manifest.json").write_text(json.dumps(manifest))
    return root


def _run(project, params, job_id="j1"):
    rec = Recorder()
    return Job(job_id, ChangeCloud(), project, params, rec, threading.Event()).run(), rec


def test_a_layer_that_is_not_a_copc_cloud_is_refused(tmp_path):
    root = _project(
        tmp_path,
        [
            {"kind": "pointcloud", "id": "a", "name": "A", "src": {"path": "a.bin"}, "format": "kit-packed"},
            {"kind": "pointcloud", "id": "b", "name": "B", "src": {"path": "b.copc.laz"}, "format": "copc"},
        ],
    )
    with pytest.raises(JobError, match="COPC"):
        _run(root, {"layerFrom": "a", "layerTo": "b", "captures": {"from": "c1", "to": "c2"}})


def test_without_dates_the_job_says_what_is_missing(tmp_path):
    root = _project(
        tmp_path,
        [
            {"kind": "pointcloud", "id": "a", "name": "A", "src": {"path": "a.copc.laz"}, "format": "copc"},
            {"kind": "pointcloud", "id": "b", "name": "B", "src": {"path": "b.copc.laz"}, "format": "copc"},
        ],
    )
    with pytest.raises(JobError, match="survey date"):
        _run(root, {"layerFrom": "a", "layerTo": "b"})


def _copc(tmp_path, root, name, xyz):
    las = tmp_path / f"{name}.las"
    write_las(las, xyz + np.array([500000, 3200000, 0]), pdrf=6, classification=np.full(len(xyz), 2))
    out = root / "clouds" / f"{name}.copc.laz"
    out.parent.mkdir(parents=True, exist_ok=True)
    pipe = tmp_path / f"{name}.json"
    pipe.write_text(
        json.dumps(
            {
                "pipeline": [
                    {"type": "readers.las", "filename": str(las)},
                    {"type": "writers.copc", "filename": str(out), "a_srs": "EPSG:32639"},
                ]
            }
        )
    )
    subprocess.run([PDAL, "pipeline", str(pipe)], check=True, capture_output=True)
    return f"clouds/{name}.copc.laz"


@needs_pdal
def test_the_job_writes_a_copc_with_a_distance_field_a_layer_and_a_change_set(tmp_path):
    rng = np.random.default_rng(21)
    g = ground(rng, [(3, 3, 0.8)], extent=6, spacing=0.06)
    before = g
    after = np.vstack([g + rng.normal(0, 0.002, g.shape), cylinder(rng, 3, 3, spacing=0.06)])
    root = _project(tmp_path, [])
    layers = [
        {
            "kind": "pointcloud",
            "id": lid,
            "name": lid.title(),
            "src": {"path": _copc(tmp_path, root, lid, xyz)},
            "format": "copc",
            "capture": cap,
        }
        for lid, xyz, cap in (("before", before, "c1"), ("after", after, "c2"))
    ]
    m = json.loads((root / "manifest.json").read_text())
    m["layers"] = layers
    (root / "manifest.json").write_text(json.dumps(m))

    result, rec = _run(root, {"layerFrom": "before", "layerTo": "after"})
    assert result["status"] == "done"
    m = json.loads((root / "manifest.json").read_text())
    layer = next(x for x in m["layers"] if x["id"] == "c1-c2-cloud")
    assert layer["kind"] == "pointcloud" and layer["format"] == "copc"
    assert layer["capture"] == "c2"
    assert layer["derived"] == {
        "kind": "change",
        "from": "c1",
        "to": "c2",
        "changeId": "c1-c2-cloud",
        "runId": "j1",
        "source": ["before", "after"],
    }
    assert layer["scalar"] == {
        "dim": "Distance",
        "label": "Distance",
        "unit": "m",
        "range": [0, 0.3],
        "diverging": False,
    }
    # the later points where both dates overlap (a few noisy ones at the edges fall outside)
    assert 0.99 * len(after) < layer["pointCount"] <= len(after)
    copc = root / layer["src"]["path"]
    assert copc.is_file()
    info = json.loads(
        subprocess.run([PDAL, "info", "--schema", str(copc)], check=True, capture_output=True).stdout
    )
    dims = {d["name"]: d for d in info["schema"]["dimensions"]}
    assert "Distance" in dims and dims["Distance"]["type"] == "floating" and dims["Distance"]["size"] == 4

    cs = validate_change_set(json.loads((root / "change" / "c1-c2-cloud.json").read_text()))
    assert cs["producer"] == "change.cloud" and cs["layers"] == ["c1-c2-cloud"]
    assert cs["registration"]["ok"] is True
    added = [i for i in cs["items"] if i["verdict"] == "added"]
    assert len(added) == 1
    item = added[0]
    assert item["kind"] == "region" and item["method"] == "cloud-to-cloud"
    # local frame: x east, y up, z south
    assert item["at"][0] == pytest.approx(3, abs=0.25) and item["at"][2] == pytest.approx(-3, abs=0.25)
    assert item["distance"]["maxM"] > 2.5
    assert len(item["outline"]) >= 4 and len(item["outlineLocal"]) >= 4
    assert cs["stats"]["regions"] == 1 and cs["stats"]["points"] == layer["pointCount"]

    # a recompute keeps the person's review and the previous file as .bak
    item["review"] = {"status": "confirmed", "by": "Tester", "at": "2026-10-06T10:00:00Z"}
    (root / "change" / "c1-c2-cloud.json").write_text(json.dumps(cs))
    _run(root, {"layerFrom": "before", "layerTo": "after"}, job_id="j2")
    again = json.loads((root / "change" / "c1-c2-cloud.json").read_text())
    assert next(i for i in again["items"] if i["id"] == item["id"])["review"]["status"] == "confirmed"
    assert (root / "change" / "c1-c2-cloud.json.bak").is_file()
    assert [x["id"] for x in json.loads((root / "manifest.json").read_text())["layers"]].count(
        "c1-c2-cloud"
    ) == 1


@needs_pdal
def test_viewing_clouds_are_read_from_their_las_sources_and_give_a_copc(tmp_path):
    from synth import write_las as write_las12

    rng = np.random.default_rng(21)
    g = ground(rng, [(3, 3, 0.8)], extent=6, spacing=0.06)
    before = g
    after = np.vstack([g + rng.normal(0, 0.002, g.shape), cylinder(rng, 3, 3, spacing=0.06)])
    layers = [
        {
            "kind": "pointcloud",
            "id": lid,
            "name": lid.title(),
            "src": {"path": f"clouds/{lid}/index.json"},
            "format": "png-packed",
            "capture": cap,
        }
        for lid, cap in (("before", "c1"), ("after", "c2"))
    ]
    root = _project(tmp_path, layers)
    (root / "sources").mkdir()
    for lid, xyz in (("before", before), ("after", after)):
        # LAS 1.2 point format 2, as stream C8's demo writes its sources
        write_las12(
            root / "sources" / f"{lid}.las", xyz + np.array([500000, 3200000, 0]), 32639, point_format=2
        )

    result, _ = _run(root, {"layerFrom": "before", "layerTo": "after"})
    assert result["status"] == "done"
    m = json.loads((root / "manifest.json").read_text())
    layer = next(x for x in m["layers"] if x["id"] == "c1-c2-cloud")
    assert layer["format"] == "copc" and layer["src"]["path"] == "change/c1-c2-cloud/distance.copc.laz"
    assert 0.99 * len(after) < layer["pointCount"] <= len(after)
    info = json.loads(
        subprocess.run(
            [PDAL, "info", "--schema", str(root / layer["src"]["path"])], check=True, capture_output=True
        ).stdout
    )
    dims = {d["name"] for d in info["schema"]["dimensions"]}
    assert {"Distance", "Red", "Green", "Blue"} <= dims
    cs = validate_change_set(json.loads((root / "change" / "c1-c2-cloud.json").read_text()))
    [added] = [i for i in cs["items"] if i["verdict"] == "added"]
    assert added["at"][0] == pytest.approx(3, abs=0.25) and added["at"][2] == pytest.approx(-3, abs=0.25)
    assert cs["stats"]["regions"] == 1 and cs["registration"]["ok"] is True

    # the same as the cloud-to-cloud of the points in memory
    o = np.array([500000, 3200000, 0])
    ref = compare_tiled(
        MemorySource(before + o),
        MemorySource(after + o),
        [(500000 - 6.0, 500000 + 6.0, 3200000 - 6.0, 3200000 + 6.0)],
        cap=3.0,
        min_dist=0.05,
        cell=0.25,
    )
    assert cs["stats"]["changedPoints"] == pytest.approx(ref.changed, abs=5)


def test_a_viewing_cloud_without_a_las_source_is_refused(tmp_path):
    layers = [
        {
            "kind": "pointcloud",
            "id": "a",
            "name": "A",
            "src": {"path": "a/index.json"},
            "format": "png-packed",
        },
        {"kind": "pointcloud", "id": "b", "name": "B", "src": {"path": "b.copc.laz"}, "format": "copc"},
    ]
    root = _project(tmp_path, layers)
    with pytest.raises(JobError, match=r'"A" is not a COPC cloud and has no LAS source \(sources/a\.las\)'):
        _run(root, {"layerFrom": "a", "layerTo": "b", "captures": {"from": "c1", "to": "c2"}})


@needs_pdal
def test_dates_that_do_not_line_up_are_refused_before_the_work(tmp_path):
    rng = np.random.default_rng(4)
    a = plane(rng, 0, 8, 0, 8, spacing=0.06)
    b = plane(rng, 0, 8, 0, 8, spacing=0.06) + np.array([0, 0, 0.15])
    root = _project(tmp_path, [])
    layers = [
        {
            "kind": "pointcloud",
            "id": "a",
            "name": "A",
            "src": {"path": _copc(tmp_path, root, "a", a)},
            "format": "copc",
        },
        {
            "kind": "pointcloud",
            "id": "b",
            "name": "B",
            "src": {"path": _copc(tmp_path, root, "b", b)},
            "format": "copc",
        },
    ]
    m = json.loads((root / "manifest.json").read_text())
    m["layers"] = layers
    (root / "manifest.json").write_text(json.dumps(m))
    with pytest.raises(JobError, match="not aligned"):
        _run(root, {"layerFrom": "a", "layerTo": "b", "captures": {"from": "c1", "to": "c2"}})
    assert not (root / "change" / "c1-c2-cloud.json").exists()


@needs_pdal
def test_the_distance_tile_reads_back_through_pdal(tmp_path):
    xyz = np.random.default_rng(1).uniform(0, 10, (500, 3)) + np.array([500000, 3200000, 0])
    src = tmp_path / "a.las"
    write_las(src, xyz, pdrf=7)
    out = tmp_path / "b.las"
    write_las(out, xyz, template=read_las(src), extra={"Distance": np.linspace(0, 1, 500)})
    info = json.loads(
        subprocess.run([PDAL, "info", "--stats", str(out)], check=True, capture_output=True).stdout
    )
    stats = {s["name"]: s for s in info["stats"]["statistic"]}
    assert stats["Distance"]["minimum"] == pytest.approx(0)
    assert stats["Distance"]["maximum"] == pytest.approx(1)
    assert stats["X"]["count"] == 500


# ---------------------------------------------------------------- height offsets (heightOffsetM)


def _offset_project(tmp_path, before, after, offsets=(None, None)):
    """Two COPC layers of one ground; ``offsets`` are the layers' ``heightOffsetM`` (None: no key)."""
    root = _project(tmp_path, [])
    layers = []
    for lid, xyz, cap, off in (("before", before, "c1", offsets[0]), ("after", after, "c2", offsets[1])):
        layer = {
            "kind": "pointcloud",
            "id": lid,
            "name": lid.title(),
            "src": {"path": _copc(tmp_path, root, lid, xyz)},
            "format": "copc",
            "capture": cap,
        }
        if off is not None:
            layer["heightOffsetM"] = off
        layers.append(layer)
    m = json.loads((root / "manifest.json").read_text())
    m["layers"] = layers
    (root / "manifest.json").write_text(json.dumps(m))
    return root


def _z_bounds(path):
    info = json.loads(
        subprocess.run([PDAL, "info", "--summary", str(path)], check=True, capture_output=True).stdout
    )
    b = info["summary"]["bounds"]
    return b["minz"], b["maxz"]


@needs_pdal
def test_cloud_change_applies_each_side_offset(tmp_path):
    rng = np.random.default_rng(8)
    g = plane(rng, 0, 6, 0, 6, spacing=0.06)
    # the later file is the same ground 5 m higher, put back down by its offset
    later = g + rng.normal(0, 0.002, g.shape) + np.array([0, 0, 5.0])
    root = _offset_project(tmp_path, g, later, (None, -5.0))
    result, _ = _run(root, {"layerFrom": "before", "layerTo": "after"})
    assert result["status"] == "done"
    cs = json.loads((root / "change" / "c1-c2-cloud.json").read_text())
    assert cs["registration"]["ok"] is True
    assert cs["stats"]["medianM"] < 0.01 and cs["stats"]["p95M"] < 0.02
    assert cs["stats"]["regions"] == 0


@needs_pdal
def test_cloud_change_offsets_on_both_sides_cancel(tmp_path):
    rng = np.random.default_rng(9)
    g = plane(rng, 0, 6, 0, 6, spacing=0.06)
    # files 3 m apart, offsets that bring both to the same height
    root = _offset_project(tmp_path, g + np.array([0, 0, 1.0]), g + np.array([0, 0, 4.0]), (2.0, -1.0))
    result, _ = _run(root, {"layerFrom": "before", "layerTo": "after"})
    assert result["status"] == "done"
    cs = json.loads((root / "change" / "c1-c2-cloud.json").read_text())
    assert cs["stats"]["medianM"] < 0.01 and cs["stats"]["regions"] == 0


@needs_pdal
def test_cloud_change_crop_bounds_follow_the_offset(tmp_path, monkeypatch):
    from aio_pipelines.change import cloud as cloud_mod

    rng = np.random.default_rng(10)
    g = plane(rng, 0, 6, 0, 6, spacing=0.06)
    root = _offset_project(tmp_path, g, g + np.array([0, 0, 5.0]), (None, -5.0))
    seen: dict[str, set] = {}
    original = cloud_mod._pdal

    def spy(ctx, args, what):
        if args[1] == "pipeline":
            pipe = Path(args[2])
            reader = json.loads(pipe.read_text())["pipeline"][0]
            if "bounds" in reader:
                # the z range sent to PDAL: the last [lo, hi] of the bounds
                z = reader["bounds"].rsplit("[", 1)[1].rstrip("])").split(",")
                seen.setdefault(pipe.stem, set()).add(tuple(float(v) for v in z))
        return original(ctx, args, what)

    monkeypatch.setattr(cloud_mod, "_pdal", spy)
    # a local region (x east, y up, z south) inside the ground, heights -1 to 2 m in project heights
    region = {"min": [0.5, -1.0, -5.5], "max": [5.5, 2.0, -0.5]}
    result, _ = _run(root, {"layerFrom": "before", "layerTo": "after", "region": region})
    assert result["status"] == "done"
    # in file heights: the earlier file has no offset, the later file's are 5 m above the project's
    assert seen["from"] == {(-1.0, 2.0)}
    assert seen["to"] == {(4.0, 7.0)}
    m = json.loads((root / "manifest.json").read_text())
    layer = next(x for x in m["layers"] if x["id"] == "c1-c2-cloud")
    # the later points inside the region were all read (none cropped away by the z range)
    assert layer["pointCount"] > 0.95 * len(g) * 25 / 36


@needs_pdal
def test_the_change_layer_has_no_offset(tmp_path):
    rng = np.random.default_rng(11)
    g = plane(rng, 0, 6, 0, 6, spacing=0.06)
    root = _offset_project(tmp_path, g, g + np.array([0, 0, 5.0]), (None, -5.0))
    result, _ = _run(root, {"layerFrom": "before", "layerTo": "after"})
    assert result["status"] == "done"
    m = json.loads((root / "manifest.json").read_text())
    layer = next(x for x in m["layers"] if x["id"] == "c1-c2-cloud")
    assert "heightOffsetM" not in layer
    # the offset is baked into the change cloud: its heights are the corrected ones
    lo, hi = _z_bounds(root / layer["src"]["path"])
    assert lo == pytest.approx(0, abs=0.05) and hi == pytest.approx(0, abs=0.05)
    # a recompute replaces an offset someone set on the change layer
    layer["heightOffsetM"] = 3.0
    (root / "manifest.json").write_text(json.dumps(m))
    _run(root, {"layerFrom": "before", "layerTo": "after"}, job_id="j2")
    m = json.loads((root / "manifest.json").read_text())
    assert "heightOffsetM" not in next(x for x in m["layers"] if x["id"] == "c1-c2-cloud")


# ---------------------------------------------------------------- date shifts (captures[].lineUp)


def _fake_pdal(monkeypatch, file_xyz, seen):
    """Stands in for PDAL's reader: crops ``file_xyz`` (file coordinates) by the pipeline's bounds."""
    import re

    from aio_pipelines.change import cloud

    def fake(ctx, args, what):
        spec = json.loads(Path(args[-1]).read_text())["pipeline"]
        seen.append(spec)
        bounds = next(s["bounds"] for s in spec if "bounds" in s)
        lo_hi = [float(v) for v in re.findall(r"-?\d+\.?\d*(?:e-?\d+)?", bounds)]
        x0, x1, y0, y1 = lo_hi[:4]
        keep = (
            (file_xyz[:, 0] >= x0) & (file_xyz[:, 0] <= x1) & (file_xyz[:, 1] >= y0) & (file_xyz[:, 1] <= y1)
        )
        write_las(Path(spec[-1]["filename"]), file_xyz[keep], pdrf=6)
        return ""

    monkeypatch.setattr(cloud, "_pdal", fake)


def _source(tmp_path, name, shift):
    from types import SimpleNamespace

    from aio_pipelines.change.cloud import PdalSource

    ctx = SimpleNamespace(job=SimpleNamespace(dir=tmp_path))
    return PdalSource(ctx, "pdal", tmp_path / f"{name}.copc.laz", name, 6, None, True, 0.0, shift)


def test_cloud_change_applies_the_date_shift(tmp_path, monkeypatch):
    rng = np.random.default_rng(31)
    base = plane(rng, 0, 8, 0, 8, spacing=0.08) + np.array([500000, 3200000, 0])
    moved = base + np.array([2.0, 0.0, 0.0])  # the same ground, 2 m east in its file
    seen: list = []
    _fake_pdal(monkeypatch, base, seen)
    pa = _source(tmp_path, "from", (0.0, 0.0)).read((500001.0, 500006.0, 3200001.0, 3200006.0))
    _fake_pdal(monkeypatch, moved, seen)
    pb = _source(tmp_path, "to", (-2.0, 0.0)).read((500001.0, 500006.0, 3200001.0, 3200006.0))
    assert len(pb.xyz) > 100
    assert np.median(np.abs(c2c_distances(pa.xyz, pb.xyz, cap=1.0))) < 0.05
    assert pb.xyz[:, 0].min() >= 500001.0 - 1e-6


def test_cloud_crop_bounds_are_in_file_coordinates(tmp_path, monkeypatch):
    seen: list = []
    _fake_pdal(monkeypatch, np.array([[500002.0, 3200003.0, 0.0]]), seen)
    src = _source(tmp_path, "to", (-2.0, 1.5))
    src.read((500000.0, 500010.0, 3200000.0, 3200010.0))
    bounds = seen[0][0]["bounds"]
    assert bounds == "([500002.0, 500012.0], [3199998.5, 3200008.5])"


def test_cloud_info_bounds_are_where_the_date_is_lined_up(tmp_path, monkeypatch):
    from types import SimpleNamespace

    from aio_pipelines.change import cloud

    summary = {
        "summary": {
            "num_points": 5,
            "bounds": {"minx": 0, "maxx": 4, "miny": 10, "maxy": 14, "minz": 1, "maxz": 2},
        }
    }
    monkeypatch.setattr(cloud, "_pdal", lambda *a, **k: json.dumps(summary))
    info = cloud._info(SimpleNamespace(), "pdal", tmp_path / "a.laz", 0.5, (-2.0, 1.0))
    assert info["bounds"] == [-2.0, 2.0, 11.0, 15.0, 1.5, 2.5]


@needs_pdal
def test_cloud_change_job_applies_the_date_shift(tmp_path):
    rng = np.random.default_rng(32)
    ground = plane(rng, 0, 8, 0, 8, spacing=0.06)
    root = _project(tmp_path, [])
    layers = [
        {"kind": "pointcloud", "id": "a", "name": "A", "capture": "c1", "format": "copc",
         "src": {"path": _copc(tmp_path, root, "a", ground)}},
        {"kind": "pointcloud", "id": "b", "name": "B", "capture": "c2", "format": "copc",
         "src": {"path": _copc(tmp_path, root, "b", ground + np.array([2.0, 0, 0]))}},
    ]  # fmt: skip
    m = json.loads((root / "manifest.json").read_text())
    m["layers"] = layers
    m["captures"][1]["lineUp"] = {"eastM": -2.0, "northM": 0.0, "with": "c1", "at": "2026-10-16T00:00:00Z"}
    (root / "manifest.json").write_text(json.dumps(m))
    result, _ = _run(root, {"layerFrom": "a", "layerTo": "b", "captures": {"from": "c1", "to": "c2"}})
    assert result["status"] == "done"
    cs = json.loads((root / "change" / "c1-c2-cloud.json").read_text())
    assert cs["registration"]["ok"] is True
    assert cs["registration"]["shiftM"] < 0.05
