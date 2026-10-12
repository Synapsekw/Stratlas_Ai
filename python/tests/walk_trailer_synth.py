"""Synthetic Insta360 trailers for the walk tests (no real footage).

``write_trailer`` writes the layout ``aio_pipelines.walk.trailer`` reads: records packed back to back,
each followed by its six-byte descriptor, an index record, then the 72-byte footer ending in the
mark. Append it to any bytes (a synthetic video, or nothing) to make a clip with motion data.
"""

from __future__ import annotations

import struct
from typing import BinaryIO, Literal

import numpy as np

from aio_pipelines.walk import protobuf as pb
from aio_pipelines.walk.trailer import (
    INSTA360_MARK,
    REC_FRAMES,
    REC_IMU,
    REC_INDEX,
    REC_METADATA,
    Imu,
)

# Two lenses side by side on a 5760 x 2880 "sensor", each centred in its 2880 x 2880 half with a
# radius of half the height (the 195 degree circle touches the frame), no rotation.
SYNTH_OFFSET = (
    "2_1440.000_1440.000_1440.000_0.000_0.000_0.000_1440.000_4320.000_1440.000_0.000_0.000_0.000_5760_2880_0"
)

_ACC_RANGE = 32.0
_GYRO_RANGE = 2000.0


def synth_imu(seconds: float, rate: int, seed: int = 0) -> Imu:
    """Walking-like motion at ``rate`` Hz: gravity on -y (camera upright), a step bob, slow turns."""
    rng = np.random.default_rng(seed)
    n = round(seconds * rate)
    t = np.arange(n) / rate
    step = 2 * np.pi * 1.8 * t
    acc = np.zeros((n, 3))
    acc[:, 0] = 0.05 * np.sin(step / 2)
    acc[:, 1] = -1.0 + 0.15 * np.sin(step)
    acc[:, 2] = 0.08 * np.cos(step)
    acc += rng.normal(0.0, 0.01, acc.shape)
    gyro = np.zeros((n, 3))
    gyro[:, 0] = 0.2 * np.sin(step)
    gyro[:, 1] = 0.6 * np.sin(2 * np.pi * 0.1 * t)
    gyro[:, 2] = 0.1 * np.sin(step / 2)
    gyro += rng.normal(0.0, 0.02, gyro.shape)
    return Imu(t=t, acc=acc, gyro=gyro)


def _to_raw_axes(v: np.ndarray) -> np.ndarray:
    """Camera frame (x right, y down, z forward) to the X4 sensor axes (inverse of the reader)."""
    return np.stack([v[:, 1], -v[:, 2], -v[:, 0]], axis=1)


def _record(fmt: int, rid: int, payload: bytes) -> bytes:
    return payload + struct.pack("<BBI", fmt, rid, len(payload))


def write_trailer(
    f: BinaryIO,
    *,
    camera: str,
    offset: str,
    imu: Imu,
    frame_times: np.ndarray | None,
    encoding: Literal["float64", "int16"] = "float64",
) -> None:
    """Write a trailer at the current position of ``f``.

    Times are seconds from the first video frame (``imu.t`` may start before it). With
    ``frame_times`` the first frame is t = 0 and a frame-time record is written; without, no
    first-frame time is written and a reader takes the first sample as t = 0.
    """
    raw = encoding == "int16"
    scale = 1_000_000 if raw else 1000  # microseconds for the raw encoding, milliseconds otherwise
    base = 10 * scale

    meta = b"".join(
        [
            pb.field_bytes(1, "SYNTH0000000"),
            pb.field_bytes(2, f"Insta360 {camera}"),
            pb.field_bytes(3, "synthetic"),
            pb.field_bytes(5, offset),
            pb.field_varint(24, base) if frame_times is not None else b"",
            pb.field_varint(62, 1) if raw else b"",
            pb.field_bytes(65, pb.field_varint(1, int(_ACC_RANGE)) + pb.field_varint(2, int(_GYRO_RANGE)))
            if raw
            else b"",
        ]
    )

    ts = (base + np.round(np.asarray(imu.t, dtype=np.float64) * scale)).astype("<u8")
    acc = _to_raw_axes(np.asarray(imu.acc, dtype=np.float64))
    gyro = _to_raw_axes(np.asarray(imu.gyro, dtype=np.float64))
    if raw:
        dt = np.dtype([("ts", "<u8"), ("v", "<u2", (6,))])
        counts = np.concatenate(
            [acc / _ACC_RANGE * 32768.0, np.rad2deg(gyro) / _GYRO_RANGE * 32768.0], axis=1
        )
        rows = np.zeros(len(ts), dtype=dt)
        rows["ts"] = ts
        rows["v"] = np.clip(np.round(counts) + 32768, 0, 65535).astype("<u2")
    else:
        dt = np.dtype([("ts", "<u8"), ("v", "<f8", (6,))])
        rows = np.zeros(len(ts), dtype=dt)
        rows["ts"] = ts
        rows["v"] = np.concatenate([acc, gyro], axis=1)

    records: list[tuple[int, int, bytes]] = [(1, REC_METADATA, meta), (0, REC_IMU, rows.tobytes())]
    if frame_times is not None:
        ft = np.zeros(len(frame_times), dtype=np.dtype([("ts", "<u8"), ("exposure", "<f8")]))
        ft["ts"] = base + np.round(np.asarray(frame_times, dtype=np.float64) * scale)
        ft["exposure"] = 1.0 / 1000.0
        records.append((0, REC_FRAMES, ft.tobytes()))

    body = bytearray(b"\0" * 16)
    entries = bytearray()
    for fmt, rid, payload in records:
        entries += struct.pack("<BBII", rid, fmt, len(payload), len(body))
        body += _record(fmt, rid, payload)
    entries += b"\0" * (250 - len(entries))
    body += _record(0, REC_INDEX, bytes(entries))
    total = len(body) + 72
    body += b"\0" * 32 + struct.pack("<II", total, 3) + INSTA360_MARK
    f.write(bytes(body))


__all__ = ["SYNTH_OFFSET", "synth_imu", "write_trailer"]
