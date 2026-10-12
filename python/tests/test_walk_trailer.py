"""The Insta360 trailer reader (aio_pipelines.walk.trailer) and the lens calibration string.

The fixture is the trailer of a real X4 clip cut down to a few hundred motion samples, with the
serial, the capture time, the file path and every GPS field replaced; synthetic trailers cover the
rest.
"""

from __future__ import annotations

import struct
from pathlib import Path

import numpy as np
import pytest

from aio_pipelines.walk.calib import CALIBRATED_FOV_DEG, Lens, default_lenses, parse_offset
from aio_pipelines.walk.trailer import INSTA360_MARK, REC_IMU, REC_INDEX, Imu, read_trailer
from walk_trailer_synth import SYNTH_OFFSET, synth_imu, write_trailer

FIXTURE = Path(__file__).parent / "fixtures" / "walk" / "x4-trailer.bin"
STREAM = 2880  # an X4 records each lens as a 2880 x 2880 stream


def _write(path: Path, imu: Imu, frame_times=None, encoding="float64", prefix: bytes = b"") -> Path:
    with path.open("wb") as f:
        f.write(prefix)
        write_trailer(
            f, camera="X4", offset=SYNTH_OFFSET, imu=imu, frame_times=frame_times, encoding=encoding
        )
    return path


def test_fixture_reads():
    data = FIXTURE.read_bytes()
    assert len(data) <= 64 * 1024
    assert b"DCIM" not in data and b".insv" not in data.lower()
    tr = read_trailer(FIXTURE)
    assert tr is not None
    assert tr.camera == "X4"
    assert tr.firmware
    assert tr.serial_hash is not None and len(tr.serial_hash) == 12
    assert tr.offset is not None and parse_offset(tr.offset, STREAM, STREAM, tr.window_crop) is not None
    assert tr.imu is not None
    assert len(tr.imu.t) >= 200
    assert tr.imu.t[0] >= 0.0 and np.all(np.diff(tr.imu.t) > 0)
    assert np.linalg.norm(tr.imu.gyro, axis=1).max() < 20.0
    assert abs(np.median(np.linalg.norm(tr.imu.acc, axis=1)) - 1.0) < 0.1
    # Held upright: gravity reads on -y (y is down), the strongest axis.
    mean = tr.imu.acc.mean(axis=0)
    assert mean[1] < -0.8 and abs(mean[0]) < 0.3 and abs(mean[2]) < 0.3
    assert tr.frame_times is not None and tr.frame_times[0] == pytest.approx(0.0, abs=1e-6)
    assert np.all(np.diff(tr.frame_times) > 0)


def test_round_trip_both_encodings(tmp_path):
    imu = synth_imu(seconds=2.0, rate=1000)
    for enc in ("float64", "int16"):
        p = _write(tmp_path / f"{enc}.bin", imu, encoding=enc)
        tr = read_trailer(p)
        assert tr is not None and tr.imu is not None, tr and tr.warnings
        assert tr.camera == "X4" and tr.offset == SYNTH_OFFSET and tr.warnings == []
        np.testing.assert_array_equal(tr.imu.t, imu.t)
        np.testing.assert_allclose(tr.imu.gyro, imu.gyro, atol=1e-3 if enc == "int16" else 1e-12)
        np.testing.assert_allclose(tr.imu.acc, imu.acc, atol=1e-3 if enc == "int16" else 1e-12)


def test_round_trip_with_frame_times(tmp_path):
    imu = synth_imu(seconds=1.0, rate=1000)
    frames = np.arange(25) / 25.0  # whole milliseconds: the float64 encoding keeps ms ticks
    tr = read_trailer(_write(tmp_path / "f.bin", imu, frame_times=frames, prefix=b"video" * 100))
    assert tr is not None and tr.frame_times is not None
    np.testing.assert_allclose(tr.frame_times, frames, atol=1e-9)
    np.testing.assert_array_equal(tr.imu.t, imu.t)


def test_no_mark_is_none(tmp_path):
    plain = tmp_path / "plain.mp4"
    plain.write_bytes(b"\0" * 4096)
    assert read_trailer(plain) is None
    tiny = tmp_path / "tiny.insv"
    tiny.write_bytes(INSTA360_MARK[:10])
    assert read_trailer(tiny) is None


def test_truncated_trailer_warns(tmp_path):
    p = tmp_path / "cut.bin"
    p.write_bytes(FIXTURE.read_bytes()[200:])  # the start of the trailer is gone
    tr = read_trailer(p)
    assert tr is not None and tr.imu is None and tr.warnings


def _patch_index_entry(data: bytearray, rid: int, size: int) -> None:
    total = len(data)
    idx_size = struct.unpack_from("<I", data, total - 72 - 4)[0]
    start = total - 72 - 6 - idx_size
    for i in range(start, start + idx_size, 10):
        if data[i] == rid:
            struct.pack_into("<I", data, i + 2, size)
            return
    raise AssertionError("no such record")


def test_record_past_the_start_warns(tmp_path):
    data = bytearray(FIXTURE.read_bytes())
    _patch_index_entry(data, REC_IMU, 50_000_000)
    p = tmp_path / "bad-index.bin"
    p.write_bytes(bytes(data))
    tr = read_trailer(p)
    assert tr is not None and tr.imu is None and tr.warnings
    assert tr.camera == "X4"  # the other records still read


def _without_index(path: Path) -> bytearray:
    """Turn the index record into an unknown one: the reader walks the descriptors instead."""
    data = bytearray(path.read_bytes())
    assert data[len(data) - 72 - 5] == REC_INDEX
    data[len(data) - 72 - 5] = 0x7F
    return data


def test_descriptor_walk_and_unknown_records(tmp_path):
    imu = synth_imu(seconds=0.5, rate=1000)
    p = tmp_path / "walk.bin"
    p.write_bytes(bytes(_without_index(_write(tmp_path / "src.bin", imu))))
    tr = read_trailer(p)
    assert tr is not None and tr.imu is not None
    np.testing.assert_array_equal(tr.imu.t, imu.t)


def test_descriptor_walk_length_past_the_start(tmp_path):
    imu = synth_imu(seconds=0.5, rate=1000)
    data = _without_index(_write(tmp_path / "src.bin", imu))
    # The record before the index is the IMU one (no frame times written): claim a huge length.
    idx_size = struct.unpack_from("<I", data, len(data) - 72 - 4)[0]
    desc = len(data) - 72 - 6 - idx_size - 6
    assert data[desc + 1] == REC_IMU
    struct.pack_into("<I", data, desc + 2, 1 << 30)
    p = tmp_path / "bad.bin"
    p.write_bytes(bytes(data))
    tr = read_trailer(p)
    assert tr is not None and tr.imu is None and tr.warnings


def test_samples_before_first_frame_are_dropped(tmp_path):
    imu = synth_imu(seconds=1.0, rate=1000)
    early = Imu(t=imu.t - 0.1, acc=imu.acc, gyro=imu.gyro)
    tr = read_trailer(_write(tmp_path / "early.bin", early, frame_times=np.arange(20) / 30.0))
    assert tr is not None and tr.imu is not None
    keep = early.t >= 0
    assert tr.imu.t.min() >= 0.0
    np.testing.assert_allclose(tr.imu.t, early.t[keep], atol=1e-9)
    np.testing.assert_allclose(tr.imu.gyro, early.gyro[keep], atol=1e-12)


def test_no_frame_times_means_first_sample_is_zero(tmp_path):
    imu = synth_imu(seconds=1.0, rate=1000)
    late = Imu(t=imu.t + 5.0, acc=imu.acc, gyro=imu.gyro)
    tr = read_trailer(_write(tmp_path / "late.bin", late))
    assert tr is not None and tr.imu is not None and tr.frame_times is None
    assert tr.imu.t[0] == 0.0
    np.testing.assert_allclose(tr.imu.t, imu.t, atol=1e-9)


def test_parse_offset_fixture_centres():
    tr = read_trailer(FIXTURE)
    assert tr is not None and tr.offset is not None
    lenses = parse_offset(tr.offset, STREAM, STREAM, tr.window_crop)
    assert lenses is not None
    for lens in lenses:
        assert abs(lens.cx - STREAM / 2) < 0.05 * STREAM
        assert abs(lens.cy - STREAM / 2) < 0.05 * STREAM
        assert 0.9 * STREAM / 2 < lens.radius < 1.1 * STREAM / 2
        assert lens.fov_deg == CALIBRATED_FOV_DEG
    # Without the crop the centres still land near the middle.
    rough = parse_offset(tr.offset, STREAM, STREAM)
    assert rough is not None and all(abs(lens.cx - STREAM / 2) < 0.05 * STREAM for lens in rough)


def test_parse_offset_synth_and_garbage():
    a, b = parse_offset(SYNTH_OFFSET, 2880, 2880)
    assert a == Lens(cx=1440.0, cy=1440.0, radius=1440.0, fov_deg=CALIBRATED_FOV_DEG)
    assert b == a
    small = parse_offset(SYNTH_OFFSET, 720, 720)
    assert small is not None and small[0].radius == pytest.approx(360.0)
    for bad in (
        "",
        "hello",
        "2_1_2_3",
        "3_" + "_".join(["1.0"] * 20),
        "2_nan_" + "_".join(["1"] * 14),
        "2_a_b",
    ):
        assert parse_offset(bad, 2880, 2880) is None


def test_default_lenses():
    a, b = default_lenses(1920, 960)
    assert a == b == Lens(cx=960.0, cy=480.0, radius=480.0, fov_deg=195.0)
