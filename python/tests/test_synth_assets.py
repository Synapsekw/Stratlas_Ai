"""The seeded synthetic assets: determinism, truth in step with fixtures.ts, partial scans, LAS."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest

from synth_assets import (
    FLARE,
    LATTICE,
    MISSING_SECTOR,
    MONOPOLE,
    STACK,
    azimuth_deg,
    flare_cloud,
    lattice_cloud,
    monopole_cloud,
    radius_at,
    stack_cloud,
    synth_photos,
    write_las,
)

FIXTURES_TS = Path(__file__).resolve().parents[2] / "packages/modelling/src/engineer/fixtures.ts"


def _pdal() -> str | None:
    try:
        from aio_pipelines.pointcloud import find_pdal

        return find_pdal()
    except Exception:
        return shutil.which("pdal")


requires_pdal = pytest.mark.skipif(_pdal() is None, reason="PDAL not found (set AIO_PDAL)")


def _ts_block(name: str) -> str:
    text = FIXTURES_TS.read_text(encoding="utf-8")
    m = re.search(rf"export const {name} = \{{(.*?)\n\}}", text, re.S)
    assert m, name
    return m.group(1)


def _ts_number(block: str, key: str) -> float:
    m = re.search(rf"\b{key}: (-?[\d.]+)", block)
    assert m, key
    return float(m.group(1))


def _ts_list(block: str, key: str) -> list[float]:
    m = re.search(rf"\b{key}: \[([^\]]*)\]", block)
    assert m, key
    return [float(v) for v in m.group(1).split(",") if v.strip()]


def _ts_profile(block: str) -> list[dict]:
    return [{"y": float(y), "r": float(r)} for y, r in re.findall(r"\{ y: ([\d.]+), r: ([\d.]+) \}", block)]


def _ts_const(name: str) -> list[float] | float:
    text = FIXTURES_TS.read_text(encoding="utf-8")
    m = re.search(rf"const {name} = (\[[^\]]*\]|[\d.]+);", text)
    assert m, name
    return json.loads(m.group(1))


def test_stack_partial_leaves_the_missing_sector_empty():
    cloud, truth = stack_cloud(seed=3, partial=True)
    az = azimuth_deg(cloud)
    lo, hi = MISSING_SECTOR
    assert hi - lo == 90
    assert not np.any((az >= lo) & (az < hi))
    assert truth["partial"] is True and truth["missingSector"] == [lo, hi]
    assert truth["lightsSeen"] == len(STACK["lightLevels"]) * STACK["lightsPerLevel"]  # none lie south
    assert truth["fluesSeen"] == STACK["flues"] - 1  # the flue at 150 degrees is in the gap
    assert stack_cloud(seed=3)[1]["fluesSeen"] == STACK["flues"]
    full, _ = stack_cloud(seed=3, partial=False)
    assert np.any((azimuth_deg(full) >= lo) & (azimuth_deg(full) < hi))


@pytest.mark.parametrize("noise", [0.01, 0.02, 0.05])
def test_stack_noise_standard_deviation_matches_the_request(noise):
    cloud, truth = stack_cloud(seed=2, noise=noise, ground=False)
    # shaft points only: away from the flues (above the crown) and the light spheres
    sel = cloud[(cloud[:, 1] < 119) & (cloud[:, 1] > 1)]
    r = np.hypot(sel[:, 0], sel[:, 2])
    expected = np.array([radius_at(truth["profile"], y) for y in sel[:, 1]])
    # drop light spheres (they sit a light-radius off the wall) with a robust cut
    resid = r - expected
    resid = resid[np.abs(resid) < 6 * noise]
    assert abs(resid.std() - noise) <= 0.1 * noise


def test_generators_are_seeded_and_bounded():
    for gen in (stack_cloud, flare_cloud, lattice_cloud, monopole_cloud):
        a, ta = gen(seed=5)
        b, _ = gen(seed=5)
        c, _ = gen(seed=6)
        assert a.dtype == np.float64 and a.shape[1] == 3
        assert np.array_equal(a, b)
        assert not np.array_equal(a, c)
        assert 1_000 < len(a) < 150_000
        assert np.abs(a).max() < 200  # local coordinates near the origin
        assert ta["axis"]["dir"] == [0.0, 1.0, 0.0] and ta["base"] == [0.0, 0.0, 0.0]
    cloud, _ = stack_cloud(ground=False)
    assert cloud[:, 1].min() > -0.5


def test_ground_flag():
    with_ground, _ = stack_cloud(seed=1, ground=True)
    without, _ = stack_cloud(seed=1, ground=False)
    assert len(with_ground) > len(without)
    far = np.hypot(with_ground[:, 0], with_ground[:, 2]) > 20
    assert np.all(np.abs(with_ground[far, 1]) < 0.5)


def test_stack_truth_matches_fixtures_ts():
    block = _ts_block("STACK_TRUTH")
    _, t = stack_cloud()
    assert t["height"] == _ts_number(block, "height")
    assert t["profile"] == _ts_profile(block)
    assert t["flues"] == _ts_number(block, "flues") == len(t["flueAzimuths"])
    assert t["fluePitchR"] == _ts_number(block, "fluePitchR")
    assert t["lightLevels"] == _ts_list(block, "lightLevels")
    assert t["lightsPerLevel"] == _ts_number(block, "lightsPerLevel")
    bands = re.search(r"bands: \[(.*?)\] as", block, re.S)
    assert bands
    assert t["bands"] == [[float(a), float(b)] for a, b in re.findall(r"\[(\d+), (\d+)\]", bands.group(1))]
    assert t["flueAzimuths"] == _ts_const("STACK_FLUE_AZ")
    assert t["flueDiameter"] == 2 * _ts_const("STACK_FLUE_R")
    assert t["lightAzimuths"] == _ts_const("STACK_LIGHT_AZ")
    assert t["lightDiameter"] == _ts_const("STACK_LIGHT_SIZE")


def test_other_truths_match_fixtures_ts():
    b = _ts_block("FLARE_TRUTH")
    _, t = flare_cloud()
    assert (t["height"], t["tipR"], t["tipHeight"], t["pilots"]) == (
        _ts_number(b, "height"),
        _ts_number(b, "tipR"),
        _ts_number(b, "tipHeight"),
        _ts_number(b, "pilots"),
    )
    assert t["profile"] == _ts_profile(b)
    assert t["platformLevels"] == _ts_list(b, "platformLevels")
    assert t["serviceLines"] == _ts_number(b, "serviceLines")
    assert len(t["pilotAzimuths"]) == t["pilots"]

    b = _ts_block("LATTICE_TRUTH")
    _, t = lattice_cloud()
    for key in (
        "height",
        "widthBase",
        "widthTop",
        "bays",
        "antennasPerSector",
        "antennaSpread",
        "antennaR",
        "antennaY",
    ):
        assert t[key] == _ts_number(b, key), key
    assert t["legs"] == _ts_number(b, "legs") == len(t["legPositions"])
    assert t["sectors"] == _ts_list(b, "sectors")
    assert len(t["antennaAzimuths"]) == len(t["sectors"]) * t["antennasPerSector"]

    b = _ts_block("MONOPOLE_TRUTH")
    _, t = monopole_cloud()
    for key in ("height", "sides", "antennas", "antennaY"):
        assert t[key] == _ts_number(b, key), key
    assert t["profile"] == _ts_profile(b)
    # the module-level constants are the same numbers the truth dicts carry
    assert (FLARE["height"], LATTICE["height"], MONOPOLE["height"]) == (60.0, 40.0, 30.0)


def test_flare_tip_and_lattice_legs_sit_where_the_truth_says():
    cloud, t = flare_cloud(ground=False)
    tip = cloud[cloud[:, 1] > t["height"] + 0.2]
    assert np.hypot(tip[:, 0], tip[:, 2]).max() < t["tipR"] + 0.3
    cloud, t = lattice_cloud(ground=False)
    foot = cloud[cloud[:, 1] < 0.5]
    for leg in t["legPositions"]:
        d = np.hypot(foot[:, 0] - leg[0], foot[:, 2] - leg[2])
        assert d.min() < 0.3


def test_las_header_and_points_round_trip(tmp_path):
    cloud, _ = stack_cloud(seed=1)
    path = write_las(cloud, tmp_path / "s.las", crs_epsg=32633, offset=(400000, 5600000, 0))
    raw = path.read_bytes()
    assert raw[:4] == b"LASF" and raw[24:26] == bytes([1, 2])
    n = int.from_bytes(raw[107:111], "little")
    assert n == len(cloud)
    assert raw[104] == 0  # point format 0
    off_pts = int.from_bytes(raw[96:100], "little")
    rec = np.dtype([("x", "<i4"), ("y", "<i4"), ("z", "<i4"), ("rest", "V8")])
    data = np.frombuffer(raw[off_pts:], dtype=rec)
    assert len(data) == n
    # the GeoTIFF key directory carries the EPSG code
    assert (32633).to_bytes(2, "little") in raw[227:off_pts]
    east = 400000 + data["x"] * 0.001
    north = 5600000 + data["y"] * 0.001
    assert np.allclose(east - 400000, cloud[:, 0], atol=0.001)
    assert np.allclose(north - 5600000, -cloud[:, 2], atol=0.001)
    assert np.allclose(data["z"] * 0.001, cloud[:, 1], atol=0.001)


@requires_pdal
def test_las_converts_to_copc_with_pdal(tmp_path):
    cloud, _ = monopole_cloud(seed=1)
    las = write_las(cloud, tmp_path / "m.las")
    out = tmp_path / "m.copc.laz"
    pdal = _pdal()
    assert pdal
    subprocess.run([pdal, "translate", str(las), str(out), "--writers.copc.forward=all"], check=True)
    assert out.stat().st_size > 0


def test_synth_photos_render_and_tag_orientation(tmp_path):
    from PIL import Image

    plain = synth_photos(tmp_path / "plain", n=2, seed=4)
    assert [p.name for p in plain] == ["synth_01.jpg", "synth_02.jpg"]
    with Image.open(plain[0]) as im:
        assert im.size == (1600, 1200)
        assert im.getexif().get(0x0112) is None
    turned = synth_photos(tmp_path / "turned", n=1, seed=4, size=(800, 600), rotate_exif=True)
    with Image.open(turned[0]) as im:
        assert im.size == (600, 800)  # stored sideways
        assert im.getexif().get(0x0112) == 6
    again = synth_photos(tmp_path / "again", n=2, seed=4)
    assert plain[0].read_bytes() == again[0].read_bytes()
