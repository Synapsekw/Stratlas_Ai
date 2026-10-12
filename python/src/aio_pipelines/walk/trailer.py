"""Read the Insta360 trailer: camera, lens calibration string, motion samples and frame times.

The layout follows Gyroflow's telemetry-parser (``src/insta360``, MIT OR Apache-2.0, by Adrian
Eddy), checked against an X4 clip. From the end of the file:

* a 72-byte footer: 32 zero bytes, u32 trailer length (counted from the trailer start to the end
  of the file), u32 version (3 on the X4), the 32-character mark;
* records, each a payload followed by a six-byte descriptor ``u8 format, u8 id, u32 size``
  (format 0 binary, 1 protobuf). The record just before the footer is an index (id 0): ten-byte
  entries ``u8 id, u8 format, u32 size, u32 offset`` (offset from the trailer start). With an
  index the records are read through it; without one the descriptors are walked backwards.

Records used: 1 metadata (protobuf), 3 motion samples, 4 per-frame exposure (its timestamps are
the frame times). Every other record is skipped. Motion samples come in two encodings: ``float64``
(u64 time in ms, acc xyz in g and gyro xyz in rad/s as f64, 56 bytes) and the raw ``int16`` one
the X4 writes (metadata ``is_raw_gyro``; u64 time in microseconds, six u16 counts offset by 32768,
acc scaled by ``acc_range`` g and gyro by ``gyro_range`` deg/s per 32768, 20 bytes). Frame-time
entries are u64 time (same unit) plus an f64 exposure, 16 bytes.

Times become seconds from the first video frame (metadata ``first_frame_timestamp``; else the
first frame-time entry; else the first sample), less the metadata ``gyro_timestamp`` (ms) for the
samples; samples and frame entries before the first frame are dropped. Axes become the camera
frame x right, y down, z forward: the X4 sensor's x points down, y back, z left, so camera
(x, y, z) = (-sz, sx, -sy).

A damaged trailer never raises: every length is bounds-checked and problems become warnings with
``imu=None``. The serial is kept only as a sha256 prefix.
"""

from __future__ import annotations

import hashlib
import os
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

import numpy as np

from aio_pipelines.walk import protobuf as pb

INSTA360_MARK = b"8db42d694ccc418790edff439fe026bf"
FOOTER_SIZE = 72
DESCRIPTOR_SIZE = 6

REC_INDEX = 0
REC_METADATA = 1
REC_IMU = 3
REC_FRAMES = 4

ACC_RANGE_DEFAULT_G = 16.0
GYRO_RANGE_DEFAULT_DPS = 2000.0

_FLOAT_ITEM = 8 + 6 * 8
_RAW_ITEM = 8 + 6 * 2
_FRAME_ITEM = 16
_MAX_RECORDS = 4096


@dataclass
class Imu:
    t: np.ndarray  # float64 seconds from the first video frame, shape (n,)
    acc: np.ndarray  # float64 g, shape (n, 3), camera frame (x right, y down, z forward)
    gyro: np.ndarray  # float64 rad/s, shape (n, 3), same frame


@dataclass
class Trailer:
    camera: str | None
    serial_hash: str | None
    firmware: str | None
    offset: str | None
    imu: Imu | None
    frame_times: np.ndarray | None
    warnings: list[str]
    # The centred window crop (width, height) in sensor pixels each lens stream was cut from,
    # for ``calib.parse_offset(..., crop=)``. None when the metadata does not say.
    window_crop: tuple[int, int] | None = None


@dataclass
class _Meta:
    camera: str | None = None
    serial: str | None = None
    firmware: str | None = None
    offset: str | None = None
    first_frame: int | None = None
    gyro_timestamp_ms: float | None = None
    raw_gyro: bool | None = None
    acc_range: float | None = None
    gyro_range: float | None = None
    window_crop: tuple[int, int] | None = None


def _text(value: int | bytes) -> str | None:
    if not isinstance(value, bytes):
        return None
    text = value.decode("utf-8", errors="replace").strip("\0").strip()
    return text or None


def _parse_metadata(buf: bytes, warnings: list[str]) -> _Meta:
    meta = _Meta()
    has_gyro_ts = False
    gyro_ts: float | None = None
    try:
        for num, wire, value in pb.iter_fields(buf):
            if num == 1 and wire == pb.LEN:
                meta.serial = _text(value)
            elif num == 2 and wire == pb.LEN:
                camera = _text(value)
                if camera and camera.lower().startswith("insta360 "):
                    camera = camera[len("insta360 ") :].strip()
                meta.camera = camera
            elif num == 3 and wire == pb.LEN:
                meta.firmware = _text(value)
            elif num == 5 and wire == pb.LEN:
                meta.offset = _text(value)
            elif num == 24 and wire == pb.VARINT:
                meta.first_frame = pb.as_signed(int(value))
            elif num == 27 and wire == pb.LEN and isinstance(value, bytes):
                crop = dict((n, v) for n, w, v in pb.iter_fields(value) if w == pb.VARINT)
                dst_w, dst_h = int(crop.get(3, 0)), int(crop.get(4, 0))
                if dst_w > 0 and dst_h > 0:
                    meta.window_crop = (dst_w, dst_h)
            elif num == 28 and wire == pb.FIXED64 and isinstance(value, bytes):
                gyro_ts = pb.as_double(value)
            elif num == 29 and wire == pb.VARINT:
                has_gyro_ts = bool(value)
            elif num == 62 and wire == pb.VARINT:
                meta.raw_gyro = bool(value)
            elif num == 65 and wire == pb.LEN and isinstance(value, bytes):
                cfg = dict((n, v) for n, w, v in pb.iter_fields(value) if w == pb.VARINT)
                if int(cfg.get(1, 0)) > 0:
                    meta.acc_range = float(cfg[1])
                if int(cfg.get(2, 0)) > 0:
                    meta.gyro_range = float(cfg[2])
    except pb.ProtobufError as e:
        warnings.append(f"Trailer metadata is damaged ({e}); read what came before it.")
    if meta.raw_gyro is None:
        meta.raw_gyro = False  # protobuf leaves a false flag out
    if has_gyro_ts and gyro_ts is not None and np.isfinite(gyro_ts):
        meta.gyro_timestamp_ms = gyro_ts
    return meta


class _Reader:
    def __init__(self, f: BinaryIO, start: int, length: int, warnings: list[str]) -> None:
        self.f = f
        self.start = start  # absolute file position of the trailer start
        self.length = length  # trailer length including the footer
        self.warnings = warnings

    def read(self, offset: int, size: int) -> bytes | None:
        """``size`` bytes at ``offset`` from the trailer start, inside the records area only."""
        if offset < 0 or size < 0 or offset + size > self.length - FOOTER_SIZE:
            return None
        self.f.seek(self.start + offset)
        data = self.f.read(size)
        return data if len(data) == size else None

    def locate(self) -> dict[int, tuple[int, int, int]]:
        """Record id to (format, offset, size), from the index or else the descriptors."""
        end = self.length - FOOTER_SIZE
        desc = self.read(end - DESCRIPTOR_SIZE, DESCRIPTOR_SIZE)
        if desc is None:
            self.warnings.append("The trailer is too short to hold a record.")
            return {}
        _fmt, rid, size = struct.unpack("<BBI", desc)
        if rid == REC_INDEX and size % 10 == 0:
            index = self.read(end - DESCRIPTOR_SIZE - size, size)
            if index is None:
                self.warnings.append("The trailer index runs past the start of the trailer.")
                return {}
            found: dict[int, tuple[int, int, int]] = {}
            for i in range(0, size, 10):
                rid_i, fmt_i, size_i, off_i = struct.unpack_from("<BBII", index, i)
                if rid_i == 0 or size_i == 0:
                    continue
                if off_i + size_i > end:
                    self.warnings.append(
                        f"Trailer record {rid_i} runs past the start of the trailer ({size_i} bytes); skipped."
                    )
                    continue
                found.setdefault(rid_i, (fmt_i, off_i, size_i))
            return found
        return self._walk()

    def _walk(self) -> dict[int, tuple[int, int, int]]:
        found: dict[int, tuple[int, int, int]] = {}
        pos = self.length - FOOTER_SIZE  # end of the current record's descriptor
        for _ in range(_MAX_RECORDS):
            if pos - DESCRIPTOR_SIZE < 0:
                break
            desc = self.read(pos - DESCRIPTOR_SIZE, DESCRIPTOR_SIZE)
            if desc is None:
                break
            fmt, rid, size = struct.unpack("<BBI", desc)
            if size == 0 and rid == 0:
                break  # padding before the first record
            begin = pos - DESCRIPTOR_SIZE - size
            if begin < 0:
                self.warnings.append(
                    f"Trailer record {rid} claims {size} bytes, past the start of the trailer; stopped reading."
                )
                break
            found.setdefault(rid, (fmt, begin, size))
            pos = begin
        return found


def _decode_samples(
    buf: bytes, meta: _Meta, warnings: list[str]
) -> tuple[np.ndarray, np.ndarray, np.ndarray, float] | None:
    """Answers (ts, acc, gyro, ticks per second) in the sensor axes, or None."""
    raw = meta.raw_gyro
    if raw is None:
        fits_raw, fits_float = len(buf) % _RAW_ITEM == 0, len(buf) % _FLOAT_ITEM == 0
        raw = fits_raw and not fits_float
        warnings.append(
            "The trailer does not say how motion samples are stored; guessed from the record size."
        )
    item = _RAW_ITEM if raw else _FLOAT_ITEM
    n = len(buf) // item
    if n == 0:
        warnings.append("The trailer's motion record is empty.")
        return None
    if len(buf) % item:
        warnings.append("The trailer's motion record ends in a partial sample; it was ignored.")
    if raw:
        rows = np.frombuffer(buf, dtype=np.dtype([("ts", "<u8"), ("v", "<u2", (6,))]), count=n)
        counts = rows["v"].astype(np.float64) - 32768.0
        acc_range = meta.acc_range or ACC_RANGE_DEFAULT_G
        gyro_range = meta.gyro_range or GYRO_RANGE_DEFAULT_DPS
        acc = counts[:, :3] * (acc_range / 32768.0)
        gyro = np.deg2rad(counts[:, 3:] * (gyro_range / 32768.0))
        ticks = 1_000_000.0
    else:
        rows = np.frombuffer(buf, dtype=np.dtype([("ts", "<u8"), ("v", "<f8", (6,))]), count=n)
        acc = rows["v"][:, :3].astype(np.float64)
        gyro = rows["v"][:, 3:].astype(np.float64)
        ticks = 1000.0
    return rows["ts"].astype(np.int64), acc, gyro, ticks


def _camera_axes(v: np.ndarray) -> np.ndarray:
    """X4 sensor axes (x down, y back, z left) to the camera frame (x right, y down, z forward)."""
    return np.stack([-v[:, 2], v[:, 0], -v[:, 1]], axis=1)


def read_trailer(path: str | Path) -> Trailer | None:
    """The trailer of an Insta360 file; None when the file does not end with the mark."""
    path = Path(path)
    try:
        size = os.path.getsize(path)
        if size < FOOTER_SIZE:
            return None
        with path.open("rb") as f:
            f.seek(size - FOOTER_SIZE)
            footer = f.read(FOOTER_SIZE)
            if len(footer) != FOOTER_SIZE or footer[-32:] != INSTA360_MARK:
                return None
            return _read(f, size, footer)
    except OSError:
        return None


def _empty(warnings: list[str]) -> Trailer:
    return Trailer(None, None, None, None, None, None, warnings)


def _read(f: BinaryIO, size: int, footer: bytes) -> Trailer:
    warnings: list[str] = []
    length, _version = struct.unpack_from("<II", footer, 32)
    if length < FOOTER_SIZE + DESCRIPTOR_SIZE:
        warnings.append("The trailer is too short to hold any record.")
        return _empty(warnings)
    if length > size:
        warnings.append("The trailer runs past the start of the file (the file looks truncated).")
        return _empty(warnings)
    reader = _Reader(f, size - length, length, warnings)
    records = reader.locate()

    def payload(rid: int) -> bytes | None:
        loc = records.get(rid)
        if loc is None:
            return None
        data = reader.read(loc[1], loc[2])
        if data is None:
            warnings.append(f"Trailer record {rid} could not be read; skipped.")
        return data

    meta_buf = payload(REC_METADATA)
    meta = _parse_metadata(meta_buf, warnings) if meta_buf is not None else _Meta()
    if meta_buf is None:
        warnings.append("The trailer has no metadata record.")
    elif meta.camera and meta.camera.upper() not in ("X4", "X5"):
        warnings.append(f"Motion axes are verified on the X4 only; {meta.camera} is read the same way.")

    samples = None
    imu_buf = payload(REC_IMU)
    if imu_buf is not None:
        samples = _decode_samples(imu_buf, meta, warnings)
    elif REC_IMU not in records:
        warnings.append("The trailer has no motion samples.")

    frame_ts = None
    frame_buf = payload(REC_FRAMES)
    if frame_buf is not None and len(frame_buf) >= _FRAME_ITEM:
        n = len(frame_buf) // _FRAME_ITEM
        frame_ts = np.frombuffer(frame_buf, dtype="<u8", count=n * 2)[0::2].astype(np.int64)

    ticks = samples[3] if samples is not None else (1_000_000.0 if meta.raw_gyro else 1000.0)
    if meta.first_frame is not None and meta.first_frame > 0:
        t0 = meta.first_frame
    elif frame_ts is not None and len(frame_ts):
        t0 = int(frame_ts[0])
    elif samples is not None:
        t0 = int(samples[0][0])
    else:
        t0 = 0

    imu = None
    if samples is not None:
        ts, acc, gyro, _ = samples
        t = (ts - t0) / ticks
        if meta.gyro_timestamp_ms:
            t = t - meta.gyro_timestamp_ms / 1000.0
        keep = (t >= 0) & np.isfinite(acc).all(axis=1) & np.isfinite(gyro).all(axis=1)
        if not keep.any():
            warnings.append("No motion sample falls inside the video.")
        else:
            t = t[keep]
            if np.any(np.diff(t) <= 0):
                order = np.argsort(t, kind="stable")
                t = t[order]
                acc, gyro = acc[keep][order], gyro[keep][order]
                warnings.append("Motion samples were out of order; sorted.")
            else:
                acc, gyro = acc[keep], gyro[keep]
            imu = Imu(t=t, acc=_camera_axes(acc), gyro=_camera_axes(gyro))

    frame_times = None
    if frame_ts is not None:
        ft = (frame_ts - t0) / ticks
        ft = ft[ft >= -1e-9]
        frame_times = ft if len(ft) else None

    serial_hash = hashlib.sha256(meta.serial.encode()).hexdigest()[:12] if meta.serial else None
    return Trailer(
        camera=meta.camera,
        serial_hash=serial_hash,
        firmware=meta.firmware,
        offset=meta.offset,
        imu=imu,
        frame_times=frame_times,
        warnings=warnings,
        window_crop=meta.window_crop,
    )
