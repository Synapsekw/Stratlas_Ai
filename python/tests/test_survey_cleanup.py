"""survey.cleanup (M11 G8): cleanups and crops as derived surfaces, thin-plate fills, DTM presets.

On G13's earthworks site: survey d2 has a parked excavator (a 6 x 3 x 3 m block, 54 m3) on planar
ground. Cleaning it up makes a new surface where the excavator is gone; the original stays, and a
comparison changes only when it is given the cleaned surface.
"""

from __future__ import annotations

import json
import math

import numpy as np
import pytest

from aio_pipelines.pipelines import all_pipelines
from aio_pipelines.pointcloud import find_pdal
from aio_pipelines.runtime import JobError
from aio_pipelines.survey.cleanup import DTM_PRESETS, PRESETS, apply_edits, dtm_pipeline
from aio_pipelines.survey.compare import ProjectSurfaces, compare_item
from aio_pipelines.survey.grid import TileSurface
from conftest import run_job
from survey_g8 import manifest, put_surface, site_project, tree_hash
from survey_synth import SITE_E0, SITE_EPSG, SITE_N0, earthworks_site


@pytest.fixture(scope="module")
def site():
    return earthworks_site(quick=True)


def pipeline():
    return all_pipelines()["survey.cleanup"]


def ring_of(rect):
    x0, y0, x1, y1 = rect
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]


def edits_file(project, edits):
    doc = {"schema": "aio.terrain-edits/1", "edits": edits}
    (project / "survey" / "cleanups.json").write_text(json.dumps(doc), "utf-8")


def edit(eid, kind, ring, surface="s-d2", method=None, enabled=True):
    return {
        "id": eid,
        "kind": kind,
        "surface": surface,
        "ring": ring,
        **({"method": method} if method else {}),
        "enabled": enabled,
        "createdAt": "2026-10-09T10:00:00Z",
    }


def measurement(site, mid):
    return next(m for m in site.measurements if m["id"] == mid)


def ring2d(m):
    return [[p[0], p[1]] for p in m["points"]]


def volume(project, ring, to, capture="d2"):
    ps = ProjectSurfaces(project, capture)
    item = {"id": "pile", "from": {"kind": "smart"}, "to": to, "useDeadband": False}
    return compare_item(ring, item, ps.resolve, ps.site())


@pytest.mark.parametrize("method", ["tin", "thin-plate"])
def test_cleaning_up_the_excavator_changes_the_volume_only_on_the_cleaned_surface(tmp_path, site, method):
    site_project(tmp_path, site)
    exc_ring = ring2d(measurement(site, "m-excavator"))
    pile_ring = ring2d(measurement(site, "m-pile-a"))
    # the cleanup is drawn a metre around the excavator (6 x 3 m at E0 + 60, N0 + 60)
    cx, cy = SITE_E0 + 60, SITE_N0 + 60
    edits_file(
        tmp_path, [edit("exc", "cleanup", ring_of((cx - 4, cy - 2.5, cx + 4, cy + 2.5)), method=method)]
    )
    before = tree_hash(tmp_path / "survey" / "surfaces" / "s-d2")
    result, _ = run_job(pipeline(), tmp_path, {"surface": "s-d2", "edits": ["exc"]})
    assert result["outputs"]["commit"]["prepared"] == ["d2-clean"]
    meta = json.loads((tmp_path / "survey" / "surfaces" / "d2-clean" / "tiles.json").read_text("utf-8"))
    assert meta["source"] == {"kind": "derived", "of": "s-d2", "edits": ["exc"]}
    assert "capture" not in meta and meta["name"] == "Surface s-d2 (cleaned)"
    # the original never changes
    assert tree_hash(tmp_path / "survey" / "surfaces" / "s-d2") == before
    # the excavator's 54 m3 is on the survey of d2; on the cleaned surface it is gone
    cur = volume(tmp_path, exc_ring, {"kind": "current"})
    assert cur["fillM3"] == pytest.approx(54.0, rel=0.02)
    clean = volume(tmp_path, exc_ring, {"kind": "survey", "surface": "d2-clean"})
    assert clean["fillM3"] == pytest.approx(0.0, abs=0.05) and clean["cutM3"] == pytest.approx(0.0, abs=0.05)
    # a polygon away from the edit is the same on both
    pile = volume(tmp_path, pile_ring, {"kind": "current"})
    pile_clean = volume(tmp_path, pile_ring, {"kind": "survey", "surface": "d2-clean"})
    assert pile_clean["fillM3"] == pytest.approx(pile["fillM3"], abs=1e-6)
    # "current" still resolves to the delivered survey, not the cleaned one
    assert ProjectSurfaces(tmp_path, "d2").resolve({"kind": "current"}).name == "Surface s-d2"
    # the cleaned heights are the planar ground there
    s = TileSurface(tmp_path / "survey" / "surfaces" / "d2-clean")
    h = s.read(0, 0, s.nx, s.ny)
    i = int((cx - meta["originE"]) / meta["cellM"])
    j = int((cy - meta["originN"]) / meta["cellM"])
    e = meta["originE"] + (i + 0.5) * meta["cellM"]
    n = meta["originN"] + (j + 0.5) * meta["cellM"]
    assert h[j, i] == pytest.approx(float(site.ground(e, n)), abs=1e-3)


def test_a_disabled_edit_is_skipped_and_enabling_it_prepares_again(tmp_path, site):
    site_project(tmp_path, site)
    cx, cy = SITE_E0 + 60, SITE_N0 + 60
    ring = ring_of((cx - 4, cy - 2.5, cx + 4, cy + 2.5))
    edits_file(tmp_path, [edit("exc", "cleanup", ring, enabled=False)])
    params = {"surface": "s-d2", "edits": ["exc"], "out": "d2-test"}
    run_job(pipeline(), tmp_path, params)
    exc_ring = ring2d(measurement(site, "m-excavator"))
    off = volume(tmp_path, exc_ring, {"kind": "survey", "surface": "d2-test"})
    assert off["fillM3"] == pytest.approx(54.0, rel=0.02)
    edits_file(tmp_path, [edit("exc", "cleanup", ring, enabled=True)])
    result, _ = run_job(pipeline(), tmp_path, params, job_id="j2")
    assert result["outputs"]["commit"]["prepared"] == ["d2-test"]
    on = volume(tmp_path, exc_ring, {"kind": "survey", "surface": "d2-test"})
    assert on["fillM3"] == pytest.approx(0.0, abs=0.05)


def test_a_crop_keeps_only_the_ring(tmp_path, site):
    site_project(tmp_path, site)
    rect = (SITE_E0 - 50, SITE_N0 - 40, SITE_E0 + 30, SITE_N0 + 20)
    edits_file(tmp_path, [edit("crop", "crop", ring_of(rect))])
    run_job(pipeline(), tmp_path, {"surface": "s-d2", "edits": ["crop"]})
    meta = json.loads((tmp_path / "survey" / "surfaces" / "d2-clean" / "tiles.json").read_text("utf-8"))
    assert meta["bounds"][0] == pytest.approx(rect[0]) and meta["bounds"][1] == pytest.approx(rect[1])
    assert meta["bounds"][3] == pytest.approx(rect[2]) and meta["bounds"][4] == pytest.approx(rect[3])
    s = TileSurface(tmp_path / "survey" / "surfaces" / "d2-clean")
    o = TileSurface(tmp_path / "survey" / "surfaces" / "s-d2")
    h, ho = s.read(0, 0, o.nx, o.ny), o.read(0, 0, o.nx, o.ny)
    assert np.isfinite(h).sum() * 0.25 == pytest.approx(80 * 60)
    ok = np.isfinite(h)
    assert np.allclose(h[ok], ho[ok], atol=1e-4, rtol=0)


def bump_surface(fn, n=120, cell=0.5):
    """A surface ``fn(x, y)`` (local metres) with a 3 m block on [20, 30] x [25, 32]."""
    x = (np.arange(n) + 0.5) * cell
    X, Y = np.meshgrid(x, x)
    truth = fn(X, Y)
    h = truth + np.where((X > 20) & (X < 30) & (Y > 25) & (Y < 32), 3.0, 0.0)
    return h, truth, X, Y


CLEAN_RING = [[18.0, 23.0], [32.0, 23.0], [32.0, 34.0], [18.0, 34.0]]


def inside(X, Y):
    return (X > 18) & (X < 32) & (Y > 23) & (Y < 34)


def cleaned(h, method, ring=CLEAN_RING):
    return apply_edits(h, 0.0, 0.0, 0.5, [edit("e", "cleanup", ring, method=method)])


def test_thin_plate_reproduces_a_plane_exactly():
    h, truth, X, Y = bump_surface(lambda x, y: 50.0 + 0.03 * x - 0.02 * y)
    out = cleaned(h, "thin-plate")
    m = inside(X, Y)
    assert float(np.abs(out[m] - truth[m]).max()) < 1e-6
    assert np.array_equal(out[~m], h[~m])
    assert m.sum() == 28 * 22
    assert np.array_equal(h, truth + np.where((X > 20) & (X < 30) & (Y > 25) & (Y < 32), 3.0, 0.0))


def test_thin_plate_carries_a_curved_surface_across_the_hole():
    # a paraboloid bowl: the TIN of the edge is flat across, the thin-plate spline follows the curve
    h, truth, X, Y = bump_surface(lambda x, y: 50.0 + 0.004 * ((x - 30) ** 2 + (y - 30) ** 2))
    m = inside(X, Y)
    tps = cleaned(h, "thin-plate")
    tin = cleaned(h, "tin")
    err_tps = float(np.abs(tps[m] - truth[m]).max())
    err_tin = float(np.abs(tin[m] - truth[m]).max())
    # a 14 x 11 m hole in a bowl curving 0.12 m across it: the spline is within 4 cm, the TIN 12 cm
    assert err_tps < 0.04
    assert err_tin > 3 * err_tps
    # the TIN is exact on a plane too
    hp, tp, *_ = bump_surface(lambda x, y: 50.0 + 0.03 * x - 0.02 * y)
    assert float(np.abs(cleaned(hp, "tin")[m] - tp[m]).max()) < 1e-6


def test_edits_apply_in_order_and_bad_rings_are_refused():
    h, truth, X, Y = bump_surface(lambda x, y: 50.0 + 0.0 * x)
    crop = edit("c", "crop", [[0, 0], [25, 0], [25, 60], [0, 60]])
    clean = edit("k", "cleanup", CLEAN_RING, method="tin")
    # crop first: the cleanup's edge is half outside the survey and still fills the cells it can
    a = apply_edits(h, 0.0, 0.0, 0.5, [crop, clean])
    b = apply_edits(h, 0.0, 0.0, 0.5, [clean, crop])
    assert np.isnan(a[X > 25.5]).all() and np.isnan(b[X > 25.5]).all()
    assert np.allclose(b[(X < 25) & inside(X, Y)], 50.0)
    with pytest.raises(JobError, match="crosses itself"):
        apply_edits(h, 0.0, 0.0, 0.5, [edit("x", "cleanup", [[0, 0], [10, 10], [10, 0], [0, 10]])])
    with pytest.raises(JobError, match="three or more points"):
        apply_edits(h, 0.0, 0.0, 0.5, [edit("x", "crop", [[0, 0], [10, 10]])])
    with pytest.raises(JobError, match="too little survey"):
        apply_edits(np.full_like(h, np.nan), 0.0, 0.0, 0.5, [clean])


def test_an_edit_of_another_surface_or_a_missing_one_is_refused(tmp_path, site):
    site_project(tmp_path, site)
    edits_file(
        tmp_path, [edit("e1", "crop", ring_of((SITE_E0, SITE_N0, SITE_E0 + 5, SITE_N0 + 5)), surface="s-d1")]
    )
    with pytest.raises(JobError, match='belongs to the surface "s-d1"'):
        run_job(pipeline(), tmp_path, {"surface": "s-d2", "edits": ["e1"]})
    with pytest.raises(JobError, match=r'"e2" is not in survey/cleanups.json'):
        run_job(pipeline(), tmp_path, {"surface": "s-d2", "edits": ["e2"]}, job_id="j2")
    with pytest.raises(JobError, match="is not prepared"):
        run_job(pipeline(), tmp_path, {"surface": "nope", "edits": []}, job_id="j3")


@pytest.mark.parametrize(
    ("params", "message"),
    [
        ({"surface": "s", "edits": ["a"], "out": "s"}, "out must name a new surface"),
        ({"surface": "s", "edits": ["../a"]}, "edits must be"),
        ({"dtmFilter": {"layer": "c", "preset": "trees"}}, "preset must be one of"),
        ({"dtmFilter": {"layer": "c"}}, "dtmFilter must be"),
    ],
)
def test_bad_parameters_are_refused(params, message):
    with pytest.raises(JobError, match=message):
        pipeline().validate(params)


def test_every_preset_is_a_pdal_ground_filter():
    assert set(DTM_PRESETS) == set(PRESETS)
    for preset in PRESETS:
        p = dtm_pipeline({"filename": "in.las"}, preset, "out.las")["pipeline"]
        assert p[1] == {"type": "filters.assign", "value": "Classification = 1"}
        assert p[2]["type"] in ("filters.smrf", "filters.csf")
        assert p[3] == {"type": "filters.range", "limits": "Classification[2:2]"}
        assert p[4]["type"] == "writers.las"
    windows = [DTM_PRESETS[k]["window"] for k in ("equipment", "equipment-vegetation", "structures")]
    assert windows == sorted(windows)


@pytest.mark.skipif(find_pdal() is None, reason="PDAL is not installed (AIO_PDAL)")
@pytest.mark.parametrize("preset", ["equipment", "everything"])
def test_a_dtm_preset_removes_the_excavator_from_a_cloud(tmp_path, preset):
    from synth import write_las

    rng = np.random.default_rng(5)
    n = 60_000
    x = rng.uniform(-40, 40, n)
    y = rng.uniform(-40, 40, n)
    z = 100.0 + 0.01 * x + 0.005 * y
    block = (np.abs(x - 5) < 3) & (np.abs(y + 4) < 1.5)
    z = np.where(block, z + 3.0, z)
    xyz = np.column_stack([SITE_E0 + x, SITE_N0 + y, z])
    (tmp_path / "sources").mkdir(parents=True)
    write_las(tmp_path / "sources" / "cloud-1.las", xyz, SITE_EPSG)
    layer = {
        "kind": "pointcloud",
        "id": "cloud-1",
        "name": "Cloud",
        "visible": True,
        "capture": "c1",
        "format": "png-packed",
        "src": {"path": "clouds/cloud-1/index.json"},
        "pointCount": n,
    }
    manifest(
        tmp_path,
        [{"id": "c1", "label": "Survey 1", "date": "2026-01-01"}],
        [SITE_E0, SITE_N0, 100.0],
        [layer],
    )
    result, _ = run_job(pipeline(), tmp_path, {"dtmFilter": {"layer": "cloud-1", "preset": preset}})
    assert result["outputs"]["commit"]["prepared"] == ["c1-dtm"]
    meta = json.loads((tmp_path / "survey" / "surfaces" / "c1-dtm" / "tiles.json").read_text("utf-8"))
    assert meta["source"] == {"kind": "dtm", "layer": "cloud-1"}
    assert meta["filter"]["preset"] == preset
    s = TileSurface(tmp_path / "survey" / "surfaces" / "c1-dtm", meta)
    from aio_pipelines.survey.grid import bilinear

    ex = np.array([SITE_E0 + 5, SITE_E0 + 3, SITE_E0 + 7]) - meta["originE"]
    ny = np.array([SITE_N0 - 4, SITE_N0 - 4, SITE_N0 - 3.5]) - meta["originN"]
    got = bilinear(s, ex, ny, 0.0, 0.0)
    want = 100.0 + 0.01 * np.array([5, 3, 7]) + 0.005 * np.array([-4, -4, -3.5])
    assert np.all(np.abs(got - want) < 0.15), got - want
    assert math.isfinite(meta["cellM"]) and meta["cellM"] > 0


def test_a_dtm_without_pdal_is_refused_clearly(tmp_path, monkeypatch):
    import aio_pipelines.pointcloud as pc

    monkeypatch.setattr(pc, "find_pdal", lambda: None)
    manifest(tmp_path, [], [SITE_E0, SITE_N0, 0.0])
    with pytest.raises(JobError, match="The DTM filter presets run in PDAL"):
        run_job(pipeline(), tmp_path, {"dtmFilter": {"layer": "cloud-1", "preset": "equipment"}})


def test_put_surface_helper_round_trips(tmp_path):
    h = np.arange(12.0).reshape(3, 4)
    put_surface(tmp_path, "t", h, 10.0, 20.0, 1.0)
    s = TileSurface(tmp_path / "survey" / "surfaces" / "t")
    assert np.allclose(s.read(0, 0, 4, 3), h, atol=1e-5)
