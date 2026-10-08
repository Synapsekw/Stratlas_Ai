"""The M11 synthetic data generator (survey_synth.py, stream G13) states the truth: its analytic
volumes, areas, slopes and profiles agree with fine numeric integration, its files parse as the
formats they claim, its hostile files are hostile in the way they say, and its calibration has the
parameters and residuals it reports."""

from __future__ import annotations

import hashlib
import itertools
import json
import math
import re
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
import pytest

from survey_synth import (
    ANALYTIC,
    FIXTURE_CRS,
    SITE_E0,
    SITE_EPSG,
    SITE_H0,
    SITE_N0,
    SITES,
    US_FT,
    DesignBundle,
    Grid,
    HaulRoad,
    LandfillCell,
    Tin,
    _positive_part,
    benched_pit,
    bowl,
    calibration_json,
    catchment,
    cone,
    crs_of,
    csv_hostile,
    dxf_hostile,
    earthworks_site,
    from_lonlat,
    frustum,
    grid_volume,
    jobxml_hostile,
    landfill_site,
    landxml_hostile,
    mound,
    noise_variants,
    pad_tin,
    paraboloid,
    prism,
    quarry_site,
    read_aio_grid,
    read_tin,
    sample_grid,
    site_calibration,
    standard_alignment,
    to_lonlat,
    twelve_da_hostile,
    wedge,
    with_holes,
    write_12da,
    write_aio_grid,
    write_cog,
    write_dc,
    write_design_files,
    write_dxf,
    write_geoid_grid,
    write_jobxml,
    write_landxml,
    write_site,
    write_tin,
)

LX = "{http://www.landxml.org/schema/LandXML-1.2}"


def rect_grid(fn, rect, res):
    """``fn`` sampled at cell centres over an axis-aligned rectangle (its edges on the cells)."""
    x0, y0, x1, y1 = rect
    nx, ny = round((x1 - x0) / res), round((y1 - y0) / res)
    g = Grid(np.empty((ny, nx)), x0, y1, res)
    e, n = g.centres()
    g.z = fn(e, n)
    return g


def rel(a, b):
    return abs(a - b) / abs(b)


# ------------------------------------------------------------------ analytic surfaces


@pytest.mark.parametrize("name", ["cone", "frustum", "paraboloid", "prism", "wedge", "mound"])
def test_analytic_volumes_match_fine_integration(name):
    s = ANALYTIC[name]()
    width = s.truth["widthM"]
    fine = s.grid(width / 400)
    assert rel(grid_volume(fine, s.base)["fill"], s.truth["volumeM3"]) < 1e-3
    # the plan's quality target holds for the plain midpoint rule too: 1/50 of the width, 0.5 %
    coarse = s.grid(width / 50)
    assert rel(grid_volume(coarse, s.base)["fill"], s.truth["volumeM3"]) < 5e-3


def test_footprints_and_surface_areas():
    c = cone()
    g = c.grid(0.05)
    e, n = g.centres()
    r = np.hypot(e - c.centre[0], n - c.centre[1])
    inside = r < c.truth["footprintRadiusM"]
    assert rel(inside.sum() * g.res**2, c.truth["footprintAreaM2"]) < 2e-3
    # terrain (3D) area of the cone: the slope is constant, sqrt(1 + (H/R)^2) per unit footprint
    gy, gx = np.gradient(g.z, g.res)
    area3d = np.sum(np.sqrt(1 + gx**2 + gy**2)[inside]) * g.res**2
    assert rel(area3d, c.truth["lateralAreaM2"]) < 2e-3
    assert c.truth["slopeDeg"] == pytest.approx(math.degrees(math.atan(8 / 20)))
    w = wedge()
    gw = w.grid(0.05)
    e, n = gw.centres()
    x0, y0, x1, y1 = w.truth["rect"]
    m = (e > x0 + 0.1) & (e < x1 - 0.1) & (n > y0 + 0.1) & (n < y1 - 0.1)
    gy, gx = np.gradient(gw.z, gw.res)
    assert np.allclose(gx[m], 0.25) and np.allclose(gy[m], 0.0)
    assert w.truth["slopeAreaM2"] == pytest.approx(20 * 40 * math.sqrt(1 + 0.0625), rel=1e-12)
    assert w.truth["gradePct"] == 25


def test_profiles_and_contours():
    c = cone()
    p = c.truth["profileWE"]
    zmax = max(p["z"])
    assert zmax == pytest.approx(SITE_H0 + 8)
    assert p["chainage"][p["z"].index(zmax)] == pytest.approx(24.0)
    for ct in c.truth["contours"]:
        # a point on the stated radius has the stated height
        z = c.heights(np.array([c.centre[0] + ct["radiusM"]]), np.array([c.centre[1]]))
        assert z[0] == pytest.approx(ct["levelM"], abs=1e-9)
    w = wedge()
    pz = np.array(w.truth["profileAlong"]["z"])
    ch = np.array(w.truth["profileAlong"]["chainage"])
    assert np.allclose(np.diff(pz) / np.diff(ch), 0.25)


def test_benched_pit_bowl_and_catchment():
    pit = benched_pit()
    g = pit.grid(0.1)
    assert rel(grid_volume(g, pit.base)["cut"], pit.truth["volumeM3"]) < 2e-3
    assert np.nanmin(g.z) == pytest.approx(pit.truth["floorLevelM"])
    # the benches are flat at their stated levels
    t = pit.truth
    for k, lvl in enumerate(t["benchLevelsM"]):
        x = t["floorHalfM"] + (k + 1) * t["faceRunM"] + k * t["benchWidthM"] + t["benchWidthM"] / 2
        assert pit.heights(np.array([pit.centre[0] + x]), np.array([pit.centre[1]]))[0] == pytest.approx(lvl)
    sump = benched_pit(sump=(5.0, 2.0))
    assert sump.truth["volumeM3"] - pit.truth["volumeM3"] == pytest.approx(200.0)
    assert rel(grid_volume(sump.grid(0.1), sump.base)["cut"], sump.truth["volumeM3"]) < 2e-3

    b = bowl()
    gb = b.grid(0.05)
    assert rel(grid_volume(gb, b.base)["cut"], b.truth["volumeM3"]) < 1e-3
    for f in b.truth["flood"]:
        depth = np.clip(f["levelM"] - gb.z, 0, None)
        assert rel(depth.sum() * gb.res**2, f["volumeM3"]) < 2e-3
        assert rel((depth > 0).sum() * gb.res**2, f["areaM2"]) < 5e-3

    c = catchment()
    gc = c.grid(0.5)
    assert np.nanmin(gc.z) == pytest.approx(c.base, abs=0.06)
    # trace steepest-descent paths from a grid of seeds; count those reaching the pour point
    h = c.truth["rect"]
    xs, ys = np.meshgrid(
        np.linspace(h[0] + 0.25, h[2] - 0.25, 120), np.linspace(h[1] + 0.25, h[3] - 0.25, 120)
    )
    x, y = xs.ravel().copy(), ys.ravel().copy()
    done = np.zeros(len(x), bool)
    reached = np.zeros(len(x), bool)
    for _ in range(4000):
        eps = 1e-4
        gx = (c.heights(x + eps, y) - c.heights(x - eps, y)) / (2 * eps)
        gy = (c.heights(x, y + eps) - c.heights(x, y - eps)) / (2 * eps)
        on = np.abs(x - c.centre[0]) < 0.06
        gx = np.where(on, 0.0, gx)  # in the channel: flow along it
        norm = np.hypot(gx, gy)
        step = np.where(done, 0.0, 0.05)
        x, y = x - step * gx / norm, y - step * gy / norm
        x = np.where(np.abs(x - c.centre[0]) < 0.06, c.centre[0], x)
        out = ~done & (y < h[1])
        reached |= out & (np.abs(x - c.centre[0]) < 0.1)
        done |= out
        if done.all():
            break
    share = reached.mean()
    assert share == pytest.approx(c.truth["catchmentAreaM2"] / c.truth["domainAreaM2"], abs=0.02)


def test_noise_holes_and_deadband():
    g = cone().grid(0.25)
    v = noise_variants(g, deadband=0.05, seed=3)
    below, amp = v["below"]
    assert np.abs(below.z - g.z).max() <= amp < 0.05
    above, amp2 = v["above"]
    assert (np.abs(above.z - g.z) > 0.05).mean() > 0.5
    # the same seed gives the same noise
    again, _ = noise_variants(g, deadband=0.05, seed=3)["below"]
    assert np.array_equal(again.z, below.z)
    # with the deadband in use, noise below it gives exactly zero cut and fill
    dz = below.z - g.z
    kept = np.abs(dz) >= 0.05
    assert not kept.any()
    h, area = with_holes(g, [(SITE_E0 + 5, SITE_N0, 3.0)])
    assert np.isnan(h.z).sum() * g.res**2 == area
    assert rel(area, math.pi * 9) < 0.05
    assert grid_volume(h, SITE_H0)["uncovered"] == pytest.approx(area)


def test_positive_part_is_exact():
    rng = np.random.default_rng(4)
    for _ in range(50):
        tri = rng.uniform(-5, 5, (3, 2))
        d = rng.uniform(-2, 2, 3)
        area = abs(np.cross(np.r_[tri[1] - tri[0], 0], np.r_[tri[2] - tri[0], 0])[2]) / 2
        # Monte Carlo on barycentric samples
        u = rng.random((200000, 2))
        u = np.where(u.sum(axis=1)[:, None] > 1, 1 - u, u)
        f = d[0] + u[:, 0] * (d[1] - d[0]) + u[:, 1] * (d[2] - d[0])
        mc = np.clip(f, 0, None).mean() * area
        exact = _positive_part(d[None, :], np.array([area]))[0]
        assert exact == pytest.approx(mc, rel=0.02, abs=2e-3 * area)


# ------------------------------------------------------------------ files: grids and TINs


def test_aio_grid_reads_like_the_change_pipeline(tmp_path):
    from aio_pipelines.change.sources import grid_source

    s = cone()
    g, _ = with_holes(s.grid(0.2), [(SITE_E0 + 20, SITE_N0 + 20, 2.0)])
    write_aio_grid(g, tmp_path / "sources", "dsm-d1", capture="d1")
    src = grid_source(tmp_path, {"id": "dsm-d1", "name": "DSM"}, {"crs": {"epsg": SITE_EPSG}})
    h = src.heights()
    ok = np.isfinite(g.z)
    assert np.array_equal(np.isfinite(h), ok)
    assert np.abs(h[ok] - g.z[ok]).max() <= src.scale / 2 + 1e-9
    assert (src.x0, src.y1, src.res) == (g.x0, g.y1, g.res)
    back = read_aio_grid(tmp_path / "sources" / "dsm-d1.json")
    assert np.allclose(back.z[ok], g.z[ok], atol=0.0006)


def test_cog_is_tiled_with_overviews(tmp_path):
    import rasterio

    g = paraboloid().grid(0.1)
    p = write_cog(g, tmp_path / "p.tif")
    with rasterio.open(p) as d:
        assert d.crs.to_epsg() == SITE_EPSG
        assert d.profile["tiled"] and d.overviews(1)
        assert np.allclose(d.read(1), g.z.astype(np.float32))
        assert d.transform.c == g.x0 and d.transform.f == g.y1


def test_tin_file_and_exact_pad_volume(tmp_path):
    def ground(e, n):
        return SITE_H0 + 0.01 * (np.asarray(e) - SITE_E0) + 0.005 * (np.asarray(n) - SITE_N0)

    pad = pad_tin(
        (SITE_E0, SITE_N0),
        (30, 20),
        SITE_H0 + 2,
        0.5,
        lambda e, n: float(ground(e, n)),
        (0.01, 0.005),
        (40, 30),
    )
    p = write_tin(tmp_path / "pad.tin", pad, {"epsg": SITE_EPSG})
    head, back = read_tin(p)
    assert head["schema"] == "aio.tin/1" and head["verticesAt"] % 8 == 0
    assert head["trianglesAt"] == head["verticesAt"] + 24 * head["vertexCount"]
    assert p.stat().st_size == head["trianglesAt"] + 12 * head["triangleCount"]
    assert np.array_equal(back.vertices, pad.vertices) and np.array_equal(back.triangles, pad.triangles)
    # the TIN covers the outer rectangle exactly once
    assert pad.area2d() == pytest.approx(80 * 60, rel=1e-12)
    fill, cut = pad.volume_above_plane(ground)
    g = rect_grid(
        lambda e, n: pad.heights(e, n) - ground(e, n),
        (SITE_E0 - 40, SITE_N0 - 30, SITE_E0 + 40, SITE_N0 + 30),
        0.1,
    )
    assert rel(np.nansum(np.clip(g.z, 0, None)) * 0.01, fill) < 1e-4
    assert cut < 0.01  # only the rounding of the written coordinates (0.1 mm)
    # the pad top and the batters are where they are said to be
    top = pad.heights(np.array([SITE_E0, SITE_E0 + 29]), np.array([SITE_N0, SITE_N0 + 19]))
    assert np.allclose(top, SITE_H0 + 2)


# ------------------------------------------------------------------ alignments and the haul road


def test_alignment_geometry_and_stationing():
    from scipy.special import fresnel

    al = standard_alignment((SITE_E0, SITE_N0), 90.0, "ccw", 90.0)
    assert al.length == pytest.approx(240.0)
    recs = al.element_records()
    for a, b in itertools.pairwise(recs):
        assert np.allclose(a["end"], b["start"], atol=1e-9)
        assert a["dirEnd"] == pytest.approx(b["dirStart"], abs=1e-12)
    arc = recs[2]
    for p in (arc["start"], arc["end"]):
        assert math.dist(p, arc["center"]) == pytest.approx(90.0, abs=1e-6)
    # total deflection: two clothoids (L / 2R each) and the arc (L / R)
    assert recs[0]["dirStart"] - recs[-1]["dirEnd"] == pytest.approx(30 / 180 * 2 + 60 / 90)
    # the clothoid against the Fresnel integrals: A^2 = R L, x = A sqrt(pi) C(t), y = A sqrt(pi) S(t)
    sp = recs[1]
    A = math.sqrt(90 * 30)
    S, C = fresnel(30 / (A * math.sqrt(math.pi)))
    along, left = A * math.sqrt(math.pi) * C, A * math.sqrt(math.pi) * S
    b0 = sp["dirStart"]
    dE, dN = sp["end"][0] - sp["start"][0], sp["end"][1] - sp["start"][1]
    assert dE * math.sin(b0) + dN * math.cos(b0) == pytest.approx(along, abs=1e-7)
    assert -dE * math.cos(b0) + dN * math.sin(b0) == pytest.approx(left, abs=1e-7)
    assert al.station(0.0) == 1000.0
    assert al.station(149.999) == pytest.approx(1149.999)
    assert al.station(150.0) == pytest.approx(1200.0)
    assert al.station(200.0) == pytest.approx(1250.0)
    doc = al.to_json({"epsg": SITE_EPSG})
    assert [e["type"] for e in doc["elements"]] == ["line", "spiral", "arc", "spiral", "line"]
    assert doc["elements"][1]["radiusStart"] is None and doc["elements"][1]["radiusEnd"] == pytest.approx(90)
    assert doc["equations"] == [{"back": 1150.0, "ahead": 1200.0}]


def test_haul_road_truth_matches_its_surface():
    site = quarry_site(quick=True)
    road = site.road
    assert isinstance(road, HaulRoad)
    t = road.truth()
    s = np.array([st["chainage"] for st in t["stations"]])[1:-1]
    e, n, b = road.align.point(s)
    left = np.c_[-np.cos(b), np.sin(b)]

    def z_at(off):
        return road.heights(e + off * left[:, 0], n + off * left[:, 1], site.ground)

    zc = z_at(0.0)
    for k, st in enumerate(t["stations"][1:-1]):
        assert zc[k] == pytest.approx(st["z"], abs=1e-6)
    cl = (z_at(12.5) - zc) / 12.5 * 100
    cr = (z_at(-12.5) - zc) / 12.5 * 100
    assert np.allclose(cl, [st["crossFallLeftPct"] for st in t["stations"][1:-1]], atol=1e-4)
    assert np.allclose(cr, [st["crossFallRightPct"] for st in t["stations"][1:-1]], atol=1e-4)
    berm_l = z_at(14.5) - z_at(12.5)
    assert np.allclose(berm_l, [st["bermLeftM"] for st in t["stations"][1:-1]], atol=1e-4)
    # crowned 2 % on the tangents, 5 % one-way on the arc (left turn: left side lower)
    by_ch = {st["chainage"]: st for st in t["stations"]}
    assert by_ch[30.0]["crossFallLeftPct"] == pytest.approx(-2.0)
    assert by_ch[30.0]["crossFallRightPct"] == pytest.approx(-2.0)
    assert by_ch[120.0]["crossFallLeftPct"] == pytest.approx(-5.0)
    assert by_ch[120.0]["crossFallRightPct"] == pytest.approx(5.0)
    assert by_ch[120.0]["superelevationPct"] == pytest.approx(5.0)
    # the planted violations
    assert by_ch[180.0]["gradePct"] == pytest.approx(12.0) and by_ch[160.0]["gradePct"] == pytest.approx(8.0)
    assert by_ch[110.0]["bermLeftM"] == pytest.approx(0.8) and by_ch[110.0]["bermRightM"] == pytest.approx(
        1.5
    )
    assert {v["kind"] for v in t["violations"]} == {"grade", "berm"}
    # the grade measured on the surface along the centreline
    s2 = np.array([180.0, 181.0])
    e2, n2, _ = road.align.point(s2)
    z2 = road.heights(e2, n2, site.ground)
    assert (z2[1] - z2[0]) / 1.0 == pytest.approx(0.12, abs=1e-4)


def test_roads_stay_clear_of_the_other_features():
    q = quarry_site(quick=True)
    for f in q.features:
        r = f.surface.truth.get("rect") or [
            f.surface.centre[0] - f.surface.truth["footprintRadiusM"],
            f.surface.centre[1] - f.surface.truth["footprintRadiusM"],
            f.surface.centre[0] + f.surface.truth["footprintRadiusM"],
            f.surface.centre[1] + f.surface.truth["footprintRadiusM"],
        ]
        g = rect_grid(lambda e, n: q.road.heights(e, n, q.ground) - q.ground(e, n), r, 1.0)
        assert np.abs(g.z).max() == 0.0, f.id
    ew = earthworks_site(quick=True)
    road_tin = ew.designs[0]["layers"][1][1]
    v = road_tin.vertices
    inside = (np.abs(v[:, 0] - SITE_E0) < 40) & (np.abs(v[:, 1] - SITE_N0) < 30)
    assert not inside.any()


# ------------------------------------------------------------------ survey sites


def test_earthworks_truths():
    site = earthworks_site(quick=True)
    t = site.truth
    rects = {m["id"]: m["points"] for m in site.measurements}
    for cm in t["comparisons"]:
        pts = np.array(rects[cm["measurement"]])
        rect = (pts[:, 0].min(), pts[:, 1].min(), pts[:, 0].max(), pts[:, 1].max())
        a = rect_grid(site.surface(cm["from"]), rect, 0.05)
        b = rect_grid(site.surface(cm["to"]), rect, 0.05)
        v = grid_volume(b, a)
        for k in ("cutM3", "fillM3"):
            assert v[k[:-2]] == pytest.approx(cm[k], rel=2e-3, abs=0.05), (cm, k)
    d = t["deadband"]
    pts = np.array(rects[d["measurement"]])
    rect = (pts[:, 0].min(), pts[:, 1].min(), pts[:, 0].max(), pts[:, 1].max())
    a = rect_grid(site.surface("d2"), rect, 0.02)
    b = rect_grid(site.surface("d3"), rect, 0.02)
    dz = b.z - a.z
    used = np.abs(dz) >= d["deadbandM"]
    assert np.sum(np.clip(-dz, 0, None)[used]) * 0.02**2 == pytest.approx(d["cutM3"], rel=2e-3)
    assert np.sum(np.clip(dz, 0, None)[used]) == 0.0
    # the planted shift, the checkpoints and the excavator
    e, n = np.array([SITE_E0 + 100.0]), np.array([SITE_N0 + 100.0])
    assert (site.surface("d3")(e, n) - site.surface("d2")(e, n))[0] == pytest.approx(0.03)
    for cp in t["checkpoints"]["points"]:
        for cap in ("d2", "d3"):
            z = site.surface(cap)(np.array([cp["e"]]), np.array([cp["n"]]))[0]
            assert z - cp["z"] == pytest.approx(cp["dz"][cap], abs=1e-6)
    assert [p["name"] for p in t["checkpoints"]["points"] if p["planted"]] == ["CHK6"]
    assert t["checkpoints"]["rmseM"] == pytest.approx(0.15 / math.sqrt(8))
    r = t["excavator"]["rect"]
    g = rect_grid(site.surface("d2"), (r[0] - 1, r[1] - 1, r[2] + 1, r[3] + 1), 0.05)
    base = rect_grid(site.ground, (r[0] - 1, r[1] - 1, r[2] + 1, r[3] + 1), 0.05)
    assert grid_volume(g, base)["fill"] == pytest.approx(54.0, rel=1e-9)
    # the pad design against the d1 ground (exact on the TIN)
    pad = site.designs[0]["layers"][0][1]
    gp = rect_grid(
        lambda e, n: pad.heights(e, n) - site.surface("d1")(e, n),
        (SITE_E0 - 40, SITE_N0 - 30, SITE_E0 + 40, SITE_N0 + 30),
        0.1,
    )
    assert np.nansum(np.clip(gp.z, 0, None)) * 0.01 == pytest.approx(t["pad"]["fillM3"], rel=1e-4)


def test_quarry_and_landfill_truths():
    q = quarry_site(quick=True)
    for pid, sp in q.truth["stockpiles"].items():
        pts = np.array(sp["polygon"])
        rect = (pts[:, 0].min(), pts[:, 1].min(), pts[:, 0].max(), pts[:, 1].max())
        for cap, v in sp["dates"].items():
            g = rect_grid(q.surface(cap), rect, 0.05)
            base = rect_grid(q.ground, rect, 0.05)
            assert grid_volume(g, base)["fill"] == pytest.approx(v["volumeM3"], rel=2e-3), (pid, cap)
    pr = q.truth["pit"]["m1"]["rect"]
    a = rect_grid(q.surface("m2"), pr, 0.1)
    b = rect_grid(q.surface("m3"), pr, 0.1)
    assert grid_volume(b, a)["cut"] == pytest.approx(q.truth["pit"]["sumpCutM3"], rel=1e-9)
    g = rect_grid(q.surface("m1"), pr, 0.1)
    base = rect_grid(q.ground, pr, 0.1)
    assert grid_volume(g, base)["cut"] == pytest.approx(q.truth["pit"]["m1"]["volumeM3"], rel=2e-3)

    lf = landfill_site(quick=True)
    t = lf.truth["cell"]
    rect = (lf.centre[0] - 70, lf.centre[1] - 50, lf.centre[0] + 70, lf.centre[1] + 50)
    cell = LandfillCell(lf.centre, lf.h0)
    prev = rect_grid(lambda e, n: lf.h0 + cell.cell_base(e - lf.centre[0], n - lf.centre[1]), rect, 0.1)
    for i, cap in enumerate(("l1", "l2", "l3")):
        cur = rect_grid(lf.surface(cap), rect, 0.1)
        assert grid_volume(cur, prev)["fill"] == pytest.approx(t["lifts"][i]["volumeM3"], rel=1e-3)
        prev = cur
    assert t["airspaceM3"] == pytest.approx(t["usedM3"] + t["remainingM3"])
    for lift in t["lifts"]:
        assert lift["achievedDensityTPerM3"] == pytest.approx(lift["tonnes"] / lift["volumeM3"])
    cap_tin = lf.designs[0]["layers"][1][1]
    base_tin = lf.designs[0]["layers"][0][1]
    g1 = rect_grid(cap_tin.heights, rect, 0.1)
    g0 = rect_grid(base_tin.heights, rect, 0.1)
    assert grid_volume(g1, g0)["fill"] == pytest.approx(t["airspaceM3"], rel=1e-3)


def test_sites_write_valid_sets_deterministically(tmp_path):
    meta = write_site(SITES["analytic"](True), tmp_path / "a")
    write_site(SITES["analytic"](True), tmp_path / "b")

    def tree(d: Path):
        return {
            p.relative_to(d).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(d.rglob("*"))
            if p.is_file()
        }

    assert tree(tmp_path / "a") == tree(tmp_path / "b")
    assert meta["id"] == "demo-survey-analytic" and len(meta["captures"]) == 2
    out = tmp_path / "e"
    write_site(earthworks_site(quick=True), out)
    sv = out / "survey"
    designs = json.loads((sv / "designs.json").read_text("utf-8"))
    d = designs["designs"][0]
    src = sv / "designs" / d["id"] / d["src"]
    assert hashlib.sha256(src.read_bytes()).hexdigest() == d["sha256"] and src.stat().st_size == d["bytes"]
    for layer in d["layers"]:
        assert (sv / "designs" / d["id"] / layer["file"]).is_file()
    assert designs["activeAlignment"] == "earthworks-design/road-cl"
    cal = json.loads((sv / "calibration.json").read_text("utf-8"))
    assert cal["source"]["file"] == "survey/calibration/site-calibration.jxl" and "appliedAt" not in cal
    settings = json.loads((sv / "settings.json").read_text("utf-8"))
    assert settings["schema"] == "aio.survey-settings/1" and settings["templateSets"] == ["construction"]
    for c in meta["captures"]:
        g = read_aio_grid(tmp_path / "a" / "captures" / c["id"] / "dsm.json")
        assert g.width == c["size"]
    truth = json.loads((out / "truth.json").read_text("utf-8"))
    assert truth["holes"]["d1"]["areaM2"] > 0


# ------------------------------------------------------------------ design formats


@pytest.fixture(scope="module")
def design_files(tmp_path_factory):
    site = earthworks_site(quick=True)
    d = site.designs[0]
    folder = tmp_path_factory.mktemp("designs")
    return d["bundle"], write_design_files(folder, d["bundle"], d["stem"])


def test_landxml_is_well_formed_and_complete(design_files):
    bundle, files = design_files
    root = ET.parse(files["landxml"]).getroot()
    assert root.tag == f"{LX}LandXML" and root.get("version") == "1.2"
    assert root.find(f"{LX}CoordinateSystem").get("epsgCode") == str(SITE_EPSG)
    assert "ynthetic" in root.find(f"{LX}Project").get("name")
    surfaces = root.findall(f".//{LX}Surface")
    assert len(surfaces) == len(bundle.surfaces)
    for el, tin in zip(surfaces, bundle.surfaces, strict=True):
        pnts = el.findall(f".//{LX}P")
        faces = el.findall(f".//{LX}F")
        assert len(pnts) == len(tin.vertices) and len(faces) == len(tin.triangles)
        n, e, z = map(float, pnts[0].text.split())
        assert (e, n, z) == pytest.approx(tuple(tin.vertices[0]), abs=5e-5)
        assert max(int(i) for f in faces for i in f.text.split()) == len(tin.vertices)
    assert len(root.findall(f".//{LX}Breakline")) == sum(len(t.breaklines) for t in bundle.surfaces)
    assert len(root.findall(f".//{LX}CgPoint")) == len(bundle.points)
    al = root.find(f".//{LX}Alignment")
    kinds = [c.tag.removeprefix(LX) for c in al.find(f"{LX}CoordGeom")]
    assert kinds == ["Line", "Spiral", "Curve", "Spiral", "Line"]
    sp = al.find(f".//{LX}Spiral")
    assert sp.get("spiType") == "clothoid" and sp.get("radiusStart") == "INF"
    eq = al.find(f"{LX}StaEquation")
    assert (float(eq.get("staBack")), float(eq.get("staAhead"))) == (1150.0, 1200.0)
    assert float(al.get("staStart")) == 1000.0


def _dxf_pairs(path: Path) -> list[tuple[int, str]]:
    lines = path.read_text("ascii").splitlines()
    assert len(lines) % 2 == 0
    return [(int(lines[i]), lines[i + 1]) for i in range(0, len(lines), 2)]


def test_dxf_12da_and_csv_hold_the_same_design(design_files):
    bundle, files = design_files
    pairs = _dxf_pairs(files["dxf"])
    assert pairs[-1] == (0, "EOF")
    assert (9, "$INSUNITS") in pairs and pairs[pairs.index((9, "$INSUNITS")) + 1] == (70, "6")
    n_faces = sum(1 for p in pairs if p == (0, "3DFACE"))
    assert n_faces == sum(len(t.triangles) for t in bundle.surfaces)
    xs = [float(v) for c, v in pairs if c in (10, 11, 12, 13)]
    ys = [float(v) for c, v in pairs if c in (20, 21, 22, 23)]
    assert all(abs(x - SITE_E0) < 300 for x in xs if x) and all(abs(y - SITE_N0) < 300 for y in ys if y)
    text = files["12da"].read_text("ascii")
    assert text.count("{") == text.count("}")
    models = re.findall(r'^model "([^"]+)"', text, re.M)
    assert f"{bundle.surfaces[0].name} faces" in models
    assert text.count("string super {") == (
        sum(len(t.triangles) + len(t.breaklines) for t in bundle.surfaces)
        + len(bundle.alignments)
        + len(bundle.points)
    )
    rows = re.findall(r"^\s+(-?\d+\.\d+) (-?\d+\.\d+) (-?\d+\.\d+)$", text, re.M)
    assert rows and all(abs(float(x) - SITE_E0) < 300 for x, _, _ in rows)
    lines = files["csv"].read_text("utf-8").splitlines()
    assert lines[0] == "name,easting,northing,elevation,code"
    assert len(lines) - 1 == len(bundle.points) + sum(len(t.vertices) for t in bundle.surfaces)


def test_hostile_files_are_what_they_claim(tmp_path):
    lx = landxml_hostile(tmp_path)
    laughs = lx["billion-laughs"][0].read_text("utf-8")
    assert "<!DOCTYPE" in laughs and laughs.count("<!ENTITY") == 10 and "&lol9;" in laughs
    assert 'SYSTEM "file:///' in lx["external-entity"][0].read_text("utf-8")
    assert 'SYSTEM "http://' in lx["external-dtd"][0].read_text("utf-8")
    with pytest.raises(ET.ParseError):
        ET.parse(lx["truncated"][0])
    root = ET.parse(lx["bad-face-index"][0]).getroot()
    face = root.find(f".//{LX}F").text.split()
    assert max(map(int, face)) > len(root.findall(f".//{LX}P"))
    assert 'count="10000000000"' in lx["huge-declared"][0].read_text("utf-8")
    dx = dxf_hostile(tmp_path, many=1000)
    assert dx["binary"][0].read_bytes().startswith(b"AutoCAD Binary DXF\r\n\x1a\x00")
    assert not dx["truncated"][0].read_text("ascii").rstrip().endswith("EOF")
    assert sum(1 for p in _dxf_pairs(dx["many-entities"][0]) if p == (0, "POINT")) == 1000
    td = twelve_da_hostile(tmp_path)
    t = td["unclosed-brace"][0].read_text("ascii")
    assert t.count("{") > t.count("}")
    assert "north" in td["bad-number"][0].read_text("ascii")
    pts = [
        ("P1", SITE_E0, SITE_N0, SITE_H0, "X"),
        ("P2", SITE_E0 + 10, SITE_N0 + 5, SITE_H0, "X"),
        ("P3", SITE_E0 + 20, SITE_N0 - 5, SITE_H0, "X"),
    ]
    cs = csv_hostile(tmp_path, pts)
    assert cs["bom"][0].read_bytes().startswith(b"\xef\xbb\xbf")
    rows = cs["mixed-separators"][0].read_text("utf-8").splitlines()
    assert ";" not in rows[1] and ";" in rows[2]
    sw = cs["latlon-swapped"][0].read_text("utf-8").splitlines()
    assert sw[0] == "name,lat,lon,height"
    lat_col = float(sw[1].split(",")[1])
    assert lat_col == pytest.approx(FIXTURE_CRS["utm39n"].lonlat[0], abs=0.01)  # a longitude
    jx = jobxml_hostile(tmp_path, site_calibration())
    ET.parse(jx["unknown-elements"][0])
    assert "<!DOCTYPE" in jx["dtd"][0].read_text("utf-8")


# ------------------------------------------------------------------ coordinates and calibration


def test_fixture_crs_sites():
    from rasterio.crs import CRS

    for f in FIXTURE_CRS.values():
        e, n = from_lonlat(crs_of(f), [f.lonlat[0]], [f.lonlat[1]])
        assert (e[0], n[0]) == pytest.approx(f.origin, abs=0.5 if f.id == "site-grid" else 0.002), f.id
    assert CRS.from_epsg(6519).linear_units == "US survey foot"
    assert US_FT == 1200 / 3937
    lon, lat = to_lonlat(SITE_EPSG, [SITE_E0], [SITE_N0])
    assert (lon[0], lat[0]) == pytest.approx(FIXTURE_CRS["utm39n"].lonlat, abs=1e-6)


def test_calibration_parameters_and_residuals_are_exact(tmp_path):
    cal = site_calibration()
    hz, vt = cal["horizontal"], cal["vertical"]
    g = np.array([[p["grid"][1], p["grid"][0]] for p in cal["pairs"]])
    loc = np.array([[p["local"][1], p["local"][0], p["local"][2]] for p in cal["pairs"]])
    h = np.array([p["wgs84"][2] for p in cal["pairs"]])
    dx, dy = g[:, 0] - hz["originE"], g[:, 1] - hz["originN"]
    m = len(g)
    A = np.zeros((2 * m, 4))
    A[:m, 0], A[:m, 1], A[:m, 2] = dx, -dy, 1
    A[m:, 0], A[m:, 1], A[m:, 3] = dy, dx, 1
    rhs = np.r_[loc[:, 0] - hz["originE"], loc[:, 1] - hz["originN"]]
    a, b, te, tn = np.linalg.lstsq(A, rhs, rcond=None)[0]
    assert math.hypot(a, b) == pytest.approx(hz["scale"], abs=1e-12)
    assert math.atan2(b, a) == pytest.approx(hz["rotationRad"], abs=1e-12)
    assert (te, tn) == pytest.approx((hz["shiftE"], hz["shiftN"]), abs=1e-9)
    res = rhs - A @ np.array([a, b, te, tn])
    assert np.allclose(res[:m], [p["residualE"] for p in cal["pairs"]], atol=1e-9)
    assert np.allclose(np.hypot(res[:m], res[m:]), [p["residualH"] for p in cal["pairs"]], atol=1e-9)
    B = np.c_[np.ones(m), dy, dx]
    k = np.linalg.lstsq(B, loc[:, 2] - h, rcond=None)[0]
    assert k == pytest.approx([vt["shiftM"], vt["slopeN"], vt["slopeE"]], abs=1e-9)
    assert np.allclose(loc[:, 2] - h - B @ k, [p["residualV"] for p in cal["pairs"]], atol=1e-9)
    assert 0 < cal["rmsH"] < 0.02 and 0 < cal["rmsV"] < 0.02
    # the grid positions are the WGS 84 positions through the site grid projection
    e, n = from_lonlat(
        crs_of(FIXTURE_CRS["site-grid"]),
        [p["wgs84"][1] for p in cal["pairs"]],
        [p["wgs84"][0] for p in cal["pairs"]],
    )
    assert np.allclose(e, g[:, 0], atol=1e-6) and np.allclose(n, g[:, 1], atol=1e-6)
    # the controller files carry the same numbers
    jx = write_jobxml(tmp_path / "c.jxl", cal)
    root = ET.parse(jx).getroot()
    assert root.tag == "JOBFile" and "SYNTHETIC" in root.get("jobName")
    assert float(root.find(".//HorizontalAdjustment/Scale").text) == pytest.approx(hz["scale"], abs=1e-10)
    assert float(root.find(".//VerticalAdjustment/ConstantAdjustment").text) == pytest.approx(vt["shiftM"])
    recs = root.findall(".//PointRecord")
    assert [r.find("Name").text for r in recs] == [p["name"] for p in cal["pairs"]]
    assert float(recs[0].find("WGS84/Latitude").text) == pytest.approx(cal["pairs"][0]["wgs84"][0], abs=1e-9)
    dc = write_dc(tmp_path / "c.dc", cal).read_text("ascii").splitlines()
    assert dc[0].startswith("00NM") and dc[1].startswith("10NMSYNTHETIC")
    pts = [r for r in dc if r.startswith("08KI")]
    assert len(pts) == m and all(len(r) == 4 + 16 * 5 for r in pts)
    assert float(pts[0][20:36]) == pytest.approx(cal["pairs"][0]["local"][0], abs=1e-6)
    doc = calibration_json(cal, "site-calibration", None, None)
    assert doc["schema"] == "aio.site-calibration/1" and len(doc["pairs"]) == m
    assert "TRANSVERSE" in doc["projection"]["wkt"].upper() or "Transverse" in doc["projection"]["wkt"]


def test_fictional_geoid(tmp_path):
    import rasterio

    t = write_geoid_grid(tmp_path / "g.tif", (51.49, 21.08))
    with rasterio.open(tmp_path / "g.tif") as d:
        v = next(d.sample([(51.49, 21.08), (51.54, 21.03)]))
        assert v[0] == pytest.approx(25.0, abs=1e-5)
        v2 = next(iter(d.sample([(51.54, 21.03)])))[0]
        assert v2 == pytest.approx(25 + 0.5 * 0.05 + 0.3 * 0.05, abs=1e-5)
    assert t["licence"].startswith("CC0")


def test_writers_accept_an_empty_bundle(tmp_path):
    b = DesignBundle("Synthetic empty (fictional)")
    write_landxml(tmp_path / "e.xml", b)
    write_dxf(tmp_path / "e.dxf", b)
    write_12da(tmp_path / "e.12da", b)
    assert ET.parse(tmp_path / "e.xml").getroot().find(f"{LX}Surfaces") is None
    assert _dxf_pairs(tmp_path / "e.dxf")[-1] == (0, "EOF")


def test_misc_shapes_have_their_volumes():
    # formulas restated independently
    assert frustum(10, 4, 3).truth["volumeM3"] == pytest.approx(156 * math.pi)
    assert cone(12, 5).truth["volumeM3"] == pytest.approx(240 * math.pi)
    assert paraboloid(20, 8).truth["volumeM3"] == pytest.approx(1600 * math.pi)
    assert prism((30, 20), 5).truth["volumeM3"] == 3000
    assert prism().truth["volumeM3"] == 32 * 20 * 5
    assert wedge(40, 20, 0.25).truth["volumeM3"] == 4000
    m = mound(15, 6)
    assert m.truth["volumeM3"] == pytest.approx(math.pi * 6 * (3 * 225 + 36) / 6)
    g = sample_grid(m.heights, m.centre, 20, 0.05)
    assert rel(grid_volume(g, m.base)["fill"], m.truth["volumeM3"]) < 1e-3
    assert Tin(np.zeros((0, 3)), np.zeros((0, 3), dtype=np.int64)).area2d() == 0.0
