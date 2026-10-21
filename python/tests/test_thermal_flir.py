"""FLIR radiometric JPEG decoder and temperature physics, on synthetic fixtures only."""

from __future__ import annotations

import dataclasses

import numpy as np
import pytest

from aio_pipelines.thermal.flir import read_flir
from aio_pipelines.thermal.physics import Atmos, Planck, ThermalSettingsPy, to_celsius
from thermal_fixtures import (
    ATMOS,
    PLANCK,
    SETTINGS,
    field,
    make_flir_jpeg,
    plain_jpeg,
)
from thermal_reference import reference_field


@pytest.mark.parametrize(
    ("header_bo", "records_bo"), [(">", "<"), ("<", "<"), (">", ">")], ids=["flir", "le", "be"]
)
def test_reads_split_app1_record(tmp_path, header_bo, records_bo):
    path = tmp_path / "a_R.JPG"
    raw = make_flir_jpeg(path, field(), header_bo=header_bo, records_bo=records_bo, chunk_size=3000)
    rec = read_flir(path)
    assert rec is not None
    assert rec.raw.dtype == np.uint16
    assert rec.raw.shape == (48, 64)
    np.testing.assert_array_equal(rec.raw, raw)
    assert rec.planck.r1 == pytest.approx(PLANCK.r1, rel=1e-6)
    assert rec.planck.r2 == pytest.approx(PLANCK.r2, rel=1e-6)
    assert rec.planck.b == pytest.approx(PLANCK.b, rel=1e-6)
    assert rec.planck.f == pytest.approx(PLANCK.f, rel=1e-6)
    assert rec.planck.o == PLANCK.o
    for name in ("alpha1", "alpha2", "beta1", "beta2", "x"):
        assert getattr(rec.atmos, name) == pytest.approx(getattr(ATMOS, name), rel=1e-6)
    assert rec.make == "FLIR"
    assert rec.model == "XT2"
    assert rec.stored.emissivity == pytest.approx(0.95, abs=1e-6)
    assert rec.stored.distance_m == pytest.approx(18.0, abs=1e-5)
    assert rec.stored.air_c == pytest.approx(25.0, abs=1e-4)
    assert rec.stored.humidity_pct == pytest.approx(50.0, abs=1e-4)
    assert rec.stored.reflected_c == pytest.approx(25.0, abs=1e-4)


def test_png_raw_byte_order(tmp_path):
    tiff = make_flir_jpeg(tmp_path / "t.jpg", field(), raw_format="tiff")
    png = make_flir_jpeg(tmp_path / "p.jpg", field(), raw_format="png")
    plain = make_flir_jpeg(tmp_path / "r.jpg", field(), raw_format="plain")
    np.testing.assert_array_equal(tiff, png)
    for name in ("t.jpg", "p.jpg", "r.jpg"):
        rec = read_flir(tmp_path / name)
        assert rec is not None, name
        np.testing.assert_array_equal(rec.raw, tiff)
    np.testing.assert_array_equal(plain, tiff)


SETTING_SETS = [
    ThermalSettingsPy(emissivity=0.95, distance_m=1.0, air_c=25.0, humidity_pct=20.0, reflected_c=None),
    ThermalSettingsPy(emissivity=0.7, distance_m=18.0, air_c=32.0, humidity_pct=60.0, reflected_c=10.0),
    ThermalSettingsPy(emissivity=0.95, distance_m=60.0, air_c=5.0, humidity_pct=95.0, reflected_c=-5.0),
]


@pytest.mark.parametrize("settings", SETTING_SETS, ids=["e95-1m-20", "e70-18m-60", "e95-60m-95"])
def test_matches_reference_to_0_01c(tmp_path, settings):
    path = tmp_path / "f.jpg"
    make_flir_jpeg(path, field(64, 48, -20.0, 120.0), settings=settings)
    rec = read_flir(path)
    assert rec is not None
    ours = to_celsius(rec.raw, rec.planck, rec.atmos, settings)
    assert ours.dtype == np.float32
    assert ours.shape == (48, 64)
    ref = np.array(reference_field(rec.raw.tolist(), rec.planck, rec.atmos, settings))
    assert np.isfinite(ours).all()
    assert float(np.abs(ours - ref).max()) <= 0.01


def test_round_trip_known_field(tmp_path):
    truth = field(64, 48, -20.0, 120.0)
    path = tmp_path / "k.jpg"
    make_flir_jpeg(path, truth)
    rec = read_flir(path)
    assert rec is not None
    got = to_celsius(rec.raw, rec.planck, rec.atmos, rec.stored)
    assert float(np.abs(got - truth).max()) <= 0.05


def _segments_count(tmp_path) -> int:
    path = tmp_path / "count.jpg"
    make_flir_jpeg(path, field(), chunk_size=3000)
    return path.read_bytes().count(b"FLIR\0\x01")


def test_not_flir_returns_none(tmp_path):
    plain = tmp_path / "plain.jpg"
    plain.write_bytes(plain_jpeg(make="FLIR", model="XT2"))
    assert read_flir(plain) is None

    not_jpeg = tmp_path / "x.jpg"
    not_jpeg.write_bytes(b"not a jpeg at all")
    assert read_flir(not_jpeg) is None
    assert read_flir(tmp_path / "missing.jpg") is None

    for cut in (0x30, 0x200, 3000, 7000):
        trunc = tmp_path / f"trunc{cut}.jpg"
        make_flir_jpeg(trunc, field(), truncate_fff=cut, chunk_size=3000)
        assert read_flir(trunc) is None, cut

    n = _segments_count(tmp_path)
    assert n >= 3
    swapped = tmp_path / "swapped.jpg"
    order = list(range(n))
    order[0], order[1] = order[1], order[0]
    make_flir_jpeg(swapped, field(), chunk_size=3000, chunk_order=order)
    assert read_flir(swapped) is None

    missing = tmp_path / "missing_one.jpg"
    make_flir_jpeg(missing, field(), chunk_size=3000, chunk_order=[i for i in range(n) if i != 1])
    assert read_flir(missing) is None

    no_last = tmp_path / "no_last.jpg"
    make_flir_jpeg(no_last, field(), chunk_size=3000, chunk_order=list(range(n - 1)))
    assert read_flir(no_last) is None


def test_settings_change_moves_values(tmp_path):
    ambient = 25.0
    reflected = 15.0
    truth = np.full((48, 64), ambient)
    truth[10, 10] = 90.0  # hot pixel
    truth[20, 20] = reflected  # pixel at the reflected temperature
    stored = dataclasses.replace(SETTINGS, reflected_c=reflected)
    path = tmp_path / "s.jpg"
    make_flir_jpeg(path, truth, settings=stored)
    rec = read_flir(path)
    assert rec is not None
    at95 = to_celsius(rec.raw, rec.planck, rec.atmos, dataclasses.replace(stored, emissivity=0.95))
    at80 = to_celsius(rec.raw, rec.planck, rec.atmos, dataclasses.replace(stored, emissivity=0.80))
    assert at80[10, 10] > at95[10, 10] + 1.0
    assert abs(float(at95[10, 10]) - 90.0) <= 0.05
    assert abs(float(at80[20, 20]) - float(at95[20, 20])) <= 0.01
    assert abs(float(at80[20, 20]) - reflected) <= 0.05


def test_settings_validation():
    raw = np.full((2, 2), 20000, dtype=np.uint16)
    with pytest.raises(ValueError):
        to_celsius(raw, PLANCK, ATMOS, dataclasses.replace(SETTINGS, emissivity=0.0))
    with pytest.raises(ValueError):
        to_celsius(raw, PLANCK, ATMOS, dataclasses.replace(SETTINGS, distance_m=-1.0))
    with pytest.raises(ValueError):
        to_celsius(raw, PLANCK, ATMOS, dataclasses.replace(SETTINGS, humidity_pct=150.0))


@pytest.mark.parametrize(
    "atmos",
    [
        Atmos(alpha1=-1.0, alpha2=-1.0, beta1=0.0, beta2=0.0, x=1.0),  # transmission above 1
        Atmos(alpha1=1.0, alpha2=0.0, beta1=0.0, beta2=0.0, x=1.9),  # transmission below 0
    ],
    ids=["above-1", "below-0"],
)
def test_impossible_transmission_raises(atmos):
    raw = np.full((2, 2), 20000, dtype=np.uint16)
    with pytest.raises(ValueError, match="transmission"):
        to_celsius(raw, PLANCK, atmos, SETTINGS)


def test_raw_zero_far_away_is_nan():
    xt2_like = Planck(r1=366648.0, r2=1.0, b=1428.0, f=1.0, o=-338.0)
    far = dataclasses.replace(SETTINGS, distance_m=60.0)
    for planck in (PLANCK, xt2_like):
        got = to_celsius(np.zeros((3, 4), dtype=np.uint16), planck, ATMOS, far)
        assert got.shape == (3, 4)
        assert np.isnan(got).all()


def test_unusable_stored_settings_give_none(tmp_path):
    bad_e = tmp_path / "bad_e.jpg"
    make_flir_jpeg(bad_e, field(), stored=dataclasses.replace(SETTINGS, emissivity=0.0))
    assert read_flir(bad_e) is None
    bad_h = tmp_path / "bad_h.jpg"
    make_flir_jpeg(bad_h, field(), stored=dataclasses.replace(SETTINGS, humidity_pct=180.0))
    assert read_flir(bad_h) is None
    bad_tau = tmp_path / "bad_tau.jpg"
    make_flir_jpeg(
        bad_tau, field(), stored_atmos=Atmos(alpha1=-1.0, alpha2=-1.0, beta1=0.0, beta2=0.0, x=1.0)
    )
    assert read_flir(bad_tau) is None
    good = tmp_path / "good.jpg"
    make_flir_jpeg(good, field())
    rec = read_flir(good)
    assert rec is not None
    assert np.isfinite(to_celsius(rec.raw, rec.planck, rec.atmos, rec.stored)).all()


def test_chunk_header_version_must_be_1(tmp_path):
    path = tmp_path / "v2.jpg"
    make_flir_jpeg(path, field(), chunk_size=3000, chunk_version=2)
    assert read_flir(path) is None
