"""change.cloud: cloud-to-cloud distance, change regions and the tiled run (synthetic clouds only).

The maths runs on numpy arrays, so most tests need no PDAL; the end-to-end job (COPC in and out)
is skipped with a reason when PDAL is not available, as in test_pointcloud.py.
"""

import json
import subprocess
import threading

import numpy as np
import pytest

from aio_pipelines.change.changeset import validate_change_set
from aio_pipelines.change.cloud import (
    ChangeCloud,
    MemorySource,
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
