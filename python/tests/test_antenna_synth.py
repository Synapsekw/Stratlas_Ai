"""The synthetic tower crown: complete exact truth, determinism, geometry that matches the truth."""

from __future__ import annotations

import json
import math

import numpy as np
import pytest

from antenna_synth import main, make_tower_project, tower_cloud, two_masts_cloud


def _axes(u):
    """Unit axes (across, up, normal) rebuilt from the truth angles, independent of the generator."""
    d, p, a = (math.radians(u[k]) for k in ("downtiltDeg", "plumbDeg", "azimuthDeg"))
    h = np.array([math.sin(a), 0.0, -math.cos(a)])  # outward horizontal
    right = np.array([-math.cos(a), 0.0, -math.sin(a)])  # viewer's right (west for a north face)
    n = h * math.cos(d) + np.array([0.0, -1.0, 0.0]) * math.sin(d)
    up = np.array([0.0, 1.0, 0.0]) * math.cos(d) + h * math.sin(d)
    up = up * math.cos(p) + right * math.sin(p)
    across = np.cross(up, n)
    return across / np.linalg.norm(across), up, n


def _local(xyz, u):
    across, up, n = _axes(u)
    rel = xyz - np.array(u["centre"])
    return np.column_stack([rel @ across, rel @ up, rel @ n])


def _half(u):
    return np.array([u["widthM"], u["heightM"], u["depthM"]]) / 2


def test_monopole_truth_is_complete():
    xyz, truth = tower_cloud("monopole", seed=1)
    kinds = sorted(u["kind"] for u in truth["units"])
    assert (
        kinds.count("panel") == 4
        and kinds.count("short") == 3
        and kinds.count("dish") == 1
        and kinds.count("other") == 1
    )
    assert max(u["widthM"] for u in truth["units"]) == pytest.approx(1.5)
    assert xyz[:, 1].max() == pytest.approx(truth["height"], abs=0.3)


def test_truth_values_are_the_brief_inputs():
    _, truth = tower_cloud("monopole", seed=1)
    by = {u["name"]: u for u in truth["units"]}
    sector = [by[f"panel-{a}"] for a in (0, 120, 240)]
    assert [u["downtiltDeg"] for u in sector] == [2.0, 4.0, 6.0]
    assert [u["plumbDeg"] for u in sector] == [0.0, 1.0, -1.0]
    assert [u["azimuthDeg"] for u in sector] == [0.0, 120.0, 240.0]
    assert all((u["widthM"], u["heightM"], u["depthM"]) == (0.30, 1.40, 0.15) for u in sector)
    wide = by["wide-300"]
    assert (wide["widthM"], wide["heightM"], wide["depthM"], wide["azimuthDeg"]) == (1.5, 1.3, 0.2, 300.0)
    assert wide["kind"] == "panel"
    dish = next(u for u in truth["units"] if u["kind"] == "dish")
    assert (dish["diameterM"], dish["azimuthDeg"], dish["elevationDeg"]) == (0.6, 60.0, 1.0)
    shorts = [u for u in truth["units"] if u["kind"] == "short"]
    assert all((u["widthM"], u["heightM"], u["depthM"]) == (0.40, 0.90, 0.20) for u in shorts)
    radio = next(u for u in truth["units"] if u["kind"] == "other")
    assert (radio["widthM"], radio["heightM"], radio["depthM"]) == (0.30, 0.40, 0.15)
    assert truth["axis"] == {"point": [0.0, 0.0, 0.0], "dir": [0.0, 1.0, 0.0]}
    r = {round(y): rr for y, rr in truth["shaftRadiusAt"]}
    assert r[0] == pytest.approx(0.6) and r[30] == pytest.approx(0.35)


def test_unit_centres_sit_on_the_crown_outside_the_shaft():
    _, truth = tower_cloud("monopole", seed=1)
    for u in truth["units"]:
        c = u["centre"]
        assert 25.5 < c[1] < 30.0
        assert math.hypot(c[0], c[2]) > 1.0
        if u["kind"] in ("panel", "short", "dish"):
            bearing = math.degrees(math.atan2(c[0], -c[2])) % 360
            diff = abs(bearing - u["azimuthDeg"]) % 360
            assert min(diff, 360 - diff) < 20  # outward faces point away from the axis


def test_points_lie_on_unit_faces_with_the_truth_pose():
    xyz, truth = tower_cloud("monopole", seed=1, noise=0.0, occlude=False, ground=False)
    for u in truth["units"]:
        if u["kind"] == "dish":
            continue
        loc = _local(xyz, u)
        half = _half(u)
        sel = np.all(np.abs(loc) <= half + 0.004, axis=1)
        assert sel.sum() > 300, u["name"]
        on_face = np.isclose(np.abs(loc), half, atol=0.004).any(axis=1)
        assert on_face[sel].mean() > 0.97, u["name"]
        for axis in range(3):
            for sign in (-1, 1):
                hit = sel & (np.abs(loc[:, axis] - sign * half[axis]) < 0.004)
                assert hit.sum() > 20, (u["name"], axis, sign)


def test_occlusion_drops_back_face_of_240_panel_and_half_the_side_faces():
    full, truth = tower_cloud("monopole", seed=1, noise=0.0, occlude=False, ground=False)
    occl, _ = tower_cloud("monopole", seed=1, noise=0.0, occlude=True, ground=False)
    by = {u["name"]: u for u in truth["units"]}

    def faces(cloud, u):
        loc = _local(cloud, u)
        h = _half(u)
        inside = np.all(np.abs(loc) <= h + 0.004, axis=1)
        back = inside & (np.abs(loc[:, 2] + h[2]) < 0.003)
        side = inside & (np.abs(np.abs(loc[:, 0]) - h[0]) < 0.003)
        return back.sum(), side.sum()

    back_full, _ = faces(full, by["panel-240"])
    back_occ, _ = faces(occl, by["panel-240"])
    assert (
        back_full > 1000 and back_occ < 0.05 * back_full
    )  # leftovers are the pipes and ring touching the plane
    back0_full, side0_full = faces(full, by["panel-0"])
    back0_occ, side0_occ = faces(occl, by["panel-0"])
    assert back0_occ > 0.95 * back0_full  # only the 240 panel loses its back
    assert 0.3 * side0_full < side0_occ < 0.7 * side0_full


def test_dish_points_follow_truth_axis_and_diameter():
    xyz, truth = tower_cloud("monopole", seed=1, noise=0.0, occlude=False, ground=False)
    dish = next(u for u in truth["units"] if u["kind"] == "dish")
    a, e = math.radians(dish["azimuthDeg"]), math.radians(dish["elevationDeg"])
    axis = np.array([math.sin(a) * math.cos(e), math.sin(e), -math.cos(a) * math.cos(e)])
    rel = xyz - np.array(dish["centre"])
    along = rel @ axis
    radial = np.linalg.norm(rel - np.outer(along, axis), axis=1)
    sel = (radial <= 0.31) & (np.abs(along) <= 0.1)
    assert sel.sum() > 150
    assert radial[sel].max() == pytest.approx(0.3, abs=0.01)  # the rim: diameter 0.6


def test_seeded_and_deterministic():
    assert np.array_equal(tower_cloud(seed=3)[0], tower_cloud(seed=3)[0])
    assert not np.array_equal(tower_cloud(seed=3)[0], tower_cloud(seed=4)[0])


def test_noise_is_gaussian_about_the_faces():
    clean, _ = tower_cloud("monopole", seed=1, noise=0.0, occlude=False, ground=False)
    noisy, _ = tower_cloud("monopole", seed=1, noise=0.003, occlude=False, ground=False)
    assert clean.shape == noisy.shape
    assert (noisy - clean).ravel().std() == pytest.approx(0.003, rel=0.1)


def test_density_scales_with_points_per_m2():
    lo = tower_cloud(seed=1, points_per_m2=500.0, ground=False)[0]
    hi = tower_cloud(seed=1, points_per_m2=2000.0, ground=False)[0]
    assert 3.0 < len(hi) / len(lo) < 5.0


def test_ground_flag():
    no = tower_cloud(seed=1, ground=False)[0]
    yes = tower_cloud(seed=1, ground=True)[0]
    assert len(yes) > len(no) and (np.abs(no[:, 1]) < 0.05).sum() < 300
    assert (np.abs(yes[:, 1]) < 0.05).sum() > 1000


def test_shaft_tapers_and_matches_truth():
    xyz, truth = tower_cloud("monopole", seed=1, noise=0.0, ground=False)
    ys, rs = zip(*truth["shaftRadiusAt"], strict=True)
    for y in (2.0, 15.0, 24.0):
        band = xyz[np.abs(xyz[:, 1] - y) < 0.05]
        r = np.hypot(band[:, 0], band[:, 2])
        want = float(np.interp(y, ys, rs))
        assert r.max() == pytest.approx(want, abs=0.02)
        assert r.min() > want * math.cos(math.pi / 12) - 0.02


def test_lattice_has_crown_units():
    xyz, truth = tower_cloud("lattice", seed=2)
    assert all(u["centre"][1] > 35.0 for u in truth["units"])
    assert truth["height"] == 40.0
    assert len(truth["units"]) == 9
    assert xyz[:, 1].max() == pytest.approx(40.0, abs=0.3)
    assert all(36.0 <= u["centre"][1] <= 39.0 for u in truth["units"] if u["kind"] != "dish")


def test_unknown_kind_raises():
    with pytest.raises(ValueError):
        tower_cloud("pylon")


def test_two_masts_cloud():
    xyz, truth = two_masts_cloud(seed=1, gap_m=20.0)
    assert len(truth["masts"]) == 2
    (x0, z0), (x1, z1) = (m["xz"] for m in truth["masts"])
    assert math.hypot(x1 - x0, z1 - z0) == pytest.approx(20.0)
    for x, z in ((x0, z0), (x1, z1)):
        near = xyz[np.hypot(xyz[:, 0] - x, xyz[:, 2] - z) < 3.0]
        assert near[:, 1].max() == pytest.approx(30.0, abs=0.3)
        assert (near[:, 1] > 25).sum() > 1000  # a crown on each
    assert xyz[:, 1].max() == pytest.approx(30.0, abs=0.3)


def test_cli_writes_float32(tmp_path):
    out = tmp_path / "tower.f32"
    assert main(["--kind", "monopole", "--seed", "3", "--out", str(out)]) == 0
    pts = np.fromfile(out, dtype="<f4").reshape(-1, 3)
    assert len(pts) > 50_000 and (tmp_path / "tower.f32.json").exists()
    truth = json.loads((tmp_path / "tower.f32.json").read_text())
    assert len(truth["units"]) == 9 and truth["height"] == 30.0
    assert np.allclose(pts, tower_cloud("monopole", seed=3)[0].astype(np.float32))


def test_cli_points_per_m2(tmp_path):
    out = tmp_path / "t.f32"
    assert main(["--kind", "lattice", "--seed", "1", "--points-per-m2", "800", "--out", str(out)]) == 0
    assert 0 < len(np.fromfile(out, dtype="<f4").reshape(-1, 3)) < len(tower_cloud("lattice", seed=1)[0])


def _las_z(path):
    data = path.read_bytes()
    assert data[:4] == b"LASF"
    off = int.from_bytes(data[96:100], "little")
    n = int.from_bytes(data[107:111], "little")
    rec = np.frombuffer(
        data,
        dtype=np.dtype([("x", "<i4"), ("y", "<i4"), ("z", "<i4"), ("rest", "u1", 8)]),
        offset=off,
        count=n,
    )
    return rec["z"] * 0.001


def test_make_tower_project_offset(tmp_path):
    xyz, _ = tower_cloud(seed=1)
    root = make_tower_project(tmp_path / "p", xyz, height_offset_m=2.5)
    manifest = json.loads((root / "manifest.json").read_text())
    layer = manifest["layers"][0]
    assert layer["heightOffsetM"] == 2.5 and layer["format"] == "las"
    assert layer["id"] == "tower-cloud" and layer["kind"] == "pointcloud"
    assert manifest["schema"] == "aio.project/1" and manifest["crs"] == {"epsg": 32633}
    z = _las_z(root / layer["src"]["path"])
    assert len(z) == len(xyz)
    assert z.min() == pytest.approx(xyz[:, 1].min() - 2.5, abs=0.002)
    assert z.max() == pytest.approx(xyz[:, 1].max() - 2.5, abs=0.002)


def test_make_tower_project_without_offset_or_crs(tmp_path):
    xyz, _ = tower_cloud(seed=1, points_per_m2=300.0)
    root = make_tower_project(tmp_path / "q", xyz, epsg=None, photos=[{"id": "p1"}])
    manifest = json.loads((root / "manifest.json").read_text())
    layer = manifest["layers"][0]
    assert "heightOffsetM" not in layer and "crs" not in manifest
    assert manifest["origin"] == [400000.0, 5600000.0, 0.0]
    assert manifest["photos"] == [{"id": "p1"}]
    assert _las_z(root / layer["src"]["path"]).max() == pytest.approx(xyz[:, 1].max(), abs=0.002)
