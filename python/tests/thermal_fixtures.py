"""Synthetic FLIR radiometric JPEGs: a known temperature field written the way FLIR cores do.

The JPEG carries an ordinary small visible image plus APP1 segments that hold one FLIR FFF
record split into ``FLIR\\0`` chunks (byte 5 = 1, byte 6 = chunk index, byte 7 = index of the
last chunk). The FFF header and record directory are big-endian; the CameraInfo and RawData
records are little-endian (their first 16-bit word, 2, tells the reader which). The raw thermal
image is plain 16-bit words in the record's byte order (as the XT2 writes it; ExifTool only wraps
them in a TIFF when it extracts them), a 16-bit TIFF, or a PNG whose 16-bit words are
byte-swapped (as FLIR handhelds write it).

Raw values come from the inverse of the FLIR formula, so the temperature each pixel should
decode to is known. No real photo is ever used.
"""

from __future__ import annotations

import io
import math
import struct
import zlib
from collections.abc import Sequence
from pathlib import Path

import numpy as np
from PIL import Image

from aio_pipelines.thermal.physics import Atmos, Planck, ThermalSettingsPy

# constants of the order a FLIR microbolometer core stores (invented, not from any one camera)
PLANCK = Planck(r1=21106.77, r2=0.012545258, b=1501.0, f=1.0, o=-7340.0)
ATMOS = Atmos(alpha1=0.006569, alpha2=0.01262, beta1=-0.002276, beta2=-0.00667, x=1.9)
SETTINGS = ThermalSettingsPy(
    emissivity=0.95, distance_m=18.0, air_c=25.0, humidity_pct=50.0, reflected_c=None
)

REC_RAW = 0x01
REC_CAMERA_INFO = 0x20
REC_FREE = 0x00


def _planck_raw(t_c: np.ndarray | float, planck: Planck) -> np.ndarray:
    t_k = np.asarray(t_c, dtype=np.float64) + 273.15
    return planck.r1 / (planck.r2 * (np.exp(planck.b / t_k) - planck.f)) - planck.o


def _tau(atmos: Atmos, settings: ThermalSettingsPy) -> float:
    ta = settings.air_c
    h2o = (settings.humidity_pct / 100.0) * math.exp(
        1.5587 + 0.06939 * ta - 0.00027816 * ta * ta + 0.00000068455 * ta**3
    )
    half = math.sqrt(settings.distance_m / 2.0)
    sq = math.sqrt(h2o)
    t = atmos.x * math.exp(-half * (atmos.alpha1 + atmos.beta1 * sq)) + (1.0 - atmos.x) * math.exp(
        -half * (atmos.alpha2 + atmos.beta2 * sq)
    )
    return t * t  # two half paths


def raw_from_temps(
    temps_c: np.ndarray, planck: Planck, atmos: Atmos, settings: ThermalSettingsPy
) -> np.ndarray:
    """Inverse FLIR formula: the uint16 raw a camera would record for these object temperatures."""
    e = settings.emissivity
    tau = _tau(atmos, settings)
    refl = settings.air_c if settings.reflected_c is None else settings.reflected_c
    signal = (
        e * tau * _planck_raw(temps_c, planck)
        + (1.0 - e) * tau * _planck_raw(refl, planck)
        + (1.0 - tau) * _planck_raw(settings.air_c, planck)
    )
    if signal.min() < 0 or signal.max() > 65535:
        raise ValueError("temperature field does not fit 16-bit raw values")
    return np.rint(signal).astype(np.uint16)


# --- raw image containers -------------------------------------------------------------------


def tiff16(raw: np.ndarray, rows_per_strip: int = 16) -> bytes:
    """Uncompressed little-endian 16-bit greyscale TIFF, several strips."""
    h, w = raw.shape
    data = raw.astype("<u2").tobytes()
    strips = [data[r * w * 2 : min(h, r + rows_per_strip) * w * 2] for r in range(0, h, rows_per_strip)]
    n = len(strips)
    entries = 9
    ifd_size = 2 + entries * 12 + 4
    offsets_at = 8 + ifd_size
    counts_at = offsets_at + 4 * n
    data_at = counts_at + 4 * n
    strip_offsets, pos = [], data_at
    for s in strips:
        strip_offsets.append(pos)
        pos += len(s)

    def entry(tag: int, typ: int, count: int, value: int) -> bytes:
        if typ == 3 and count == 1:
            return struct.pack("<HHIHH", tag, typ, count, value, 0)
        return struct.pack("<HHII", tag, typ, count, value)

    ifd = struct.pack("<H", entries)
    ifd += entry(256, 3, 1, w)
    ifd += entry(257, 3, 1, h)
    ifd += entry(258, 3, 1, 16)
    ifd += entry(259, 3, 1, 1)
    ifd += entry(262, 3, 1, 1)
    ifd += entry(273, 4, n, offsets_at if n > 1 else strip_offsets[0])
    ifd += entry(277, 3, 1, 1)
    ifd += entry(278, 3, 1, rows_per_strip)
    ifd += entry(279, 4, n, counts_at if n > 1 else len(strips[0]))
    ifd += struct.pack("<I", 0)
    out = b"II*\x00" + struct.pack("<I", 8) + ifd
    out += struct.pack(f"<{n}I", *strip_offsets) + struct.pack(f"<{n}I", *[len(s) for s in strips])
    return out + b"".join(strips)


def _png_filter_row(kind: int, row: bytes, prev: bytes, bpp: int = 2) -> bytes:
    out = bytearray(len(row))
    for i, x in enumerate(row):
        a = row[i - bpp] if i >= bpp else 0
        b = prev[i]
        c = prev[i - bpp] if i >= bpp else 0
        if kind == 0:
            p = 0
        elif kind == 1:
            p = a
        elif kind == 2:
            p = b
        elif kind == 3:
            p = (a + b) // 2
        else:
            pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
            p = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
        out[i] = (x - p) & 0xFF
    return bytes(out)


def png16_swapped(raw: np.ndarray) -> bytes:
    """16-bit greyscale PNG holding FLIR's byte-swapped words, every PNG row filter used."""
    h, w = raw.shape
    rows = raw.astype("<u2").tobytes()  # FLIR writes little-endian words into a big-endian PNG
    stride = w * 2
    prev = bytes(stride)
    filtered = bytearray()
    for y in range(h):
        row = rows[y * stride : (y + 1) * stride]
        kind = y % 5
        filtered.append(kind)
        filtered += _png_filter_row(kind, row, prev)
        prev = row

    def chunk(tag: bytes, body: bytes) -> bytes:
        return struct.pack(">I", len(body)) + tag + body + struct.pack(">I", zlib.crc32(tag + body))

    ihdr = struct.pack(">IIBBBBB", w, h, 16, 0, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(filtered)))
        + chunk(b"IEND", b"")
    )


# --- FFF records ----------------------------------------------------------------------------


def camera_info_record(
    planck: Planck, atmos: Atmos, stored: ThermalSettingsPy, model: str, bo: str = "<"
) -> bytes:
    rec = bytearray(0x400)
    refl = stored.air_c if stored.reflected_c is None else stored.reflected_c

    def put(fmt: str, off: int, *vals: object) -> None:
        struct.pack_into(bo + fmt, rec, off, *vals)

    put("H", 0x00, 2)
    put("f", 0x20, stored.emissivity)
    put("f", 0x24, stored.distance_m)
    put("f", 0x28, refl + 273.15)
    put("f", 0x2C, stored.air_c + 273.15)
    put("f", 0x30, stored.air_c + 273.15)  # IR window temperature
    put("f", 0x34, 1.0)  # IR window transmission
    put("f", 0x3C, stored.humidity_pct / 100.0)
    put("f", 0x58, planck.r1)
    put("f", 0x5C, planck.b)
    put("f", 0x60, planck.f)
    put("f", 0x70, atmos.alpha1)
    put("f", 0x74, atmos.alpha2)
    put("f", 0x78, atmos.beta1)
    put("f", 0x7C, atmos.beta2)
    put("f", 0x80, atmos.x)
    rec[0xD4 : 0xD4 + 32] = model.encode("ascii")[:31].ljust(32, b"\0")
    put("i", 0x308, int(planck.o))
    put("f", 0x30C, planck.r2)
    return bytes(rec)


def raw_data_record(raw: np.ndarray, raw_format: str, bo: str = "<") -> bytes:
    h, w = raw.shape
    head = bytearray(0x20)
    struct.pack_into(bo + "HHH", head, 0, 2, w, h)
    if raw_format == "tiff":
        body = tiff16(raw)
    elif raw_format == "png":
        body = png16_swapped(raw)
    elif raw_format == "plain":
        body = raw.astype(bo + "u2").tobytes()
    else:
        raise ValueError(raw_format)
    return bytes(head) + body


def fff_bytes(records: Sequence[tuple[int, bytes]], header_bo: str = ">") -> bytes:
    """An FFF container: 0x40-byte header, record directory (0x20 per entry), then the records."""
    entries = [(REC_FREE, b""), *records]  # a free slot first, as cameras leave them
    dir_at = 0x40
    data_at = dir_at + 0x20 * len(entries)
    head = bytearray(0x40)
    head[0:4] = b"FFF\0"
    head[4:20] = b"SYNTH".ljust(16, b"\0")
    struct.pack_into(header_bo + "IIII", head, 0x14, 100, dir_at, len(entries), len(entries))
    directory, body, pos = bytearray(), bytearray(), data_at
    for i, (typ, rec) in enumerate(entries):
        offset = pos if rec else 0
        directory += struct.pack(header_bo + "HHIIIIIII", typ, 0, 100, i + 1, offset, len(rec), 0, 0, 0)
        body += rec
        pos += len(rec)
    return bytes(head) + bytes(directory) + bytes(body)


def flir_app1_segments(fff: bytes, chunk_size: int = 4000, version: int = 1) -> list[bytes]:
    """The FFF split into APP1 payloads, each headed ``FLIR\\0``, 1, index, last index."""
    parts = [fff[i : i + chunk_size] for i in range(0, len(fff), chunk_size)]
    last = len(parts) - 1
    return [b"FLIR\0" + bytes([version, i, last]) + p for i, p in enumerate(parts)]


def plain_jpeg(width: int = 64, height: int = 48, make: str | None = None, model: str | None = None) -> bytes:
    img = Image.new("L", (width, height), 128)
    exif = Image.Exif()
    if make is not None:
        exif[0x010F] = make
    if model is not None:
        exif[0x0110] = model
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=80, exif=exif.tobytes() if len(exif) else b"")
    return buf.getvalue()


def jpeg_with_app1(base: bytes, payloads: Sequence[bytes]) -> bytes:
    """Insert APP1 segments after the base JPEG's own APP segments (before its tables)."""
    pos = 2
    while base[pos] == 0xFF and 0xE0 <= base[pos + 1] <= 0xEF:
        pos += 2 + struct.unpack(">H", base[pos + 2 : pos + 4])[0]
    segs = b"".join(b"\xff\xe1" + struct.pack(">H", len(p) + 2) + p for p in payloads)
    return base[:pos] + segs + base[pos:]


def make_flir_jpeg(
    path: Path,
    temps_c: np.ndarray,
    planck: Planck = PLANCK,
    atmos: Atmos = ATMOS,
    settings: ThermalSettingsPy = SETTINGS,
    raw_format: str = "plain",
    model: str = "XT2",
    *,
    make: str = "FLIR",
    records_bo: str = "<",
    header_bo: str = ">",
    chunk_size: int = 4000,
    chunk_order: Sequence[int] | None = None,
    truncate_fff: int | None = None,
    chunk_version: int = 1,
    stored: ThermalSettingsPy | None = None,
    stored_atmos: Atmos | None = None,
) -> np.ndarray:
    """Write a radiometric JPEG for ``temps_c`` (°C, shape h x w) and return its raw array.

    ``chunk_order`` writes only these chunk indices, in this order (to fake broken files);
    ``truncate_fff`` cuts the FFF record to that many bytes before it is split;
    ``chunk_version`` is byte 5 of every chunk header (FLIR writes 1);
    ``stored`` / ``stored_atmos`` put other values in CameraInfo than the raw was made with.
    """
    raw = raw_from_temps(np.asarray(temps_c, dtype=np.float64), planck, atmos, settings)
    info = camera_info_record(planck, stored_atmos or atmos, stored or settings, model, records_bo)
    fff = fff_bytes(
        [
            (REC_CAMERA_INFO, info),
            (REC_RAW, raw_data_record(raw, raw_format, records_bo)),
        ],
        header_bo,
    )
    if truncate_fff is not None:
        fff = fff[:truncate_fff]
    segs = flir_app1_segments(fff, chunk_size, chunk_version)
    if chunk_order is not None:
        segs = [segs[i] for i in chunk_order]
    h, w = raw.shape
    Path(path).write_bytes(jpeg_with_app1(plain_jpeg(w, h, make, model), segs))
    return raw


def field(width: int = 64, height: int = 48, lo: float = -20.0, hi: float = 120.0) -> np.ndarray:
    """A smooth known field spanning ``lo`` to ``hi`` °C (diagonal ramp)."""
    yy, xx = np.mgrid[0:height, 0:width]
    t = (xx / (width - 1) + yy / (height - 1)) / 2.0
    return lo + (hi - lo) * t
