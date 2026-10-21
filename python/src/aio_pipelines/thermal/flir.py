"""FLIR radiometric JPEGs: the FFF record in the APP1 segments, parsed from raw bytes.

Layout (as ExifTool documents it and FLIR cores write it):

- APP1 payloads headed ``FLIR\\0``, then a byte 1, the chunk index and the index of the last
  chunk; the FFF record is the concatenation of the chunk bodies (from byte 8), in order.
- FFF header (0x40 bytes): magic ``FFF\\0``, creator, version (100..199) at 0x14, directory
  offset at 0x18 and entry count at 0x1C. The header's byte order is whichever reads the
  version as 100..199 (big-endian on the cameras seen so far).
- Directory entries, 0x20 bytes each: type (u16) at 0x00, record offset (from the FFF start)
  at 0x0C and length at 0x10. Type 0x01 is RawData, 0x20 CameraInfo, 0 a free slot.
- Every record carries its own byte order: its first u16 is a small number (2), so it reads
  below 0x100 in the right order.
- RawData: width at 0x02, height at 0x04, image from 0x20: plain u16 words in the record's
  byte order (the XT2: 640 x 512 little-endian words; ExifTool wraps these in a TIFF only when
  it extracts them), a 16-bit PNG whose words FLIR wrote byte-swapped, or an uncompressed
  16-bit TIFF.
- CameraInfo: emissivity 0x20, distance 0x24, reflected 0x28 (K), air 0x2C (K), humidity 0x3C
  (fraction), PlanckR1 0x58, B 0x5C, F 0x60, Alpha1/2, Beta1/2, X 0x70..0x80, model 0xD4,
  PlanckO 0x308 (i32), PlanckR2 0x30C.

Anything missing, truncated or out of order gives ``None``, never partial numbers.
"""

from __future__ import annotations

import math
import struct
import zlib
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from aio_pipelines.thermal.physics import (
    KELVIN,
    Atmos,
    Planck,
    ThermalSettingsPy,
    checked_transmission,
    validate_settings,
)

REC_RAW = 0x01
REC_CAMERA_INFO = 0x20
CAMERA_INFO_MIN = 0x310
_PNG_SIG = b"\x89PNG\r\n\x1a\n"


@dataclass(frozen=True)
class FlirRecord:
    raw: np.ndarray  # uint16, (h, w)
    planck: Planck
    atmos: Atmos
    make: str
    model: str
    stored: ThermalSettingsPy


class _Bad(Exception):
    """The file is not a complete, readable FLIR record."""


def read_flir(path: Path) -> FlirRecord | None:
    """Decode a FLIR radiometric JPEG, or ``None`` when it is not one (or is damaged)."""
    try:
        data = Path(path).read_bytes()
    except OSError:
        return None
    return parse_flir(data)


def parse_flir(data: bytes) -> FlirRecord | None:
    try:
        return _parse(data)
    except (_Bad, struct.error, ValueError, IndexError, zlib.error):
        return None


# --- JPEG -----------------------------------------------------------------------------------


def _app1_payloads(data: bytes) -> list[bytes]:
    if data[:2] != b"\xff\xd8":
        raise _Bad("not a JPEG")
    out: list[bytes] = []
    pos, n = 2, len(data)
    while pos + 1 < n:
        if data[pos] != 0xFF:
            raise _Bad("marker expected")
        while pos + 1 < n and data[pos + 1] == 0xFF:
            pos += 1  # fill bytes
        marker = data[pos + 1]
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            pos += 2
            continue
        if marker in (0xDA, 0xD9):  # start of scan / end of image: no more metadata
            break
        if pos + 4 > n:
            raise _Bad("truncated segment")
        length = struct.unpack_from(">H", data, pos + 2)[0]
        end = pos + 2 + length
        if length < 2 or end > n:
            raise _Bad("truncated segment")
        if marker == 0xE1:
            out.append(data[pos + 4 : end])
        pos = end
    return out


def _join_flir_chunks(payloads: list[bytes]) -> bytes:
    chunks = [p for p in payloads if p.startswith(b"FLIR\0") and len(p) >= 8]
    if not chunks:
        raise _Bad("no FLIR record")
    last = chunks[0][7]
    if len(chunks) != last + 1:
        raise _Bad("FLIR chunk missing")
    for i, c in enumerate(chunks):
        if c[5] != 1:  # FLIR writes 1 here; anything else is a layout we have not seen
            raise _Bad("unknown FLIR chunk header")
        if c[6] != i or c[7] != last:
            raise _Bad("FLIR chunks out of order")
    return b"".join(c[8:] for c in chunks)


def _exif_make_model(payloads: list[bytes]) -> tuple[str, str]:
    for p in payloads:
        if not p.startswith(b"Exif\0\0"):
            continue
        try:
            _, tags = _tiff_ifd0(p[6:])
        except (_Bad, struct.error, IndexError, ValueError):
            return "", ""
        return _ascii(tags.get(0x010F)), _ascii(tags.get(0x0110))
    return "", ""


def _ascii(v: object) -> str:
    if isinstance(v, bytes):
        return v.split(b"\0", 1)[0].decode("ascii", "replace").strip()
    return ""


# --- FFF ------------------------------------------------------------------------------------


def _record_bo(rec: bytes) -> str:
    return "<" if struct.unpack_from("<H", rec, 0)[0] < 0x100 else ">"


def _parse(data: bytes) -> FlirRecord:
    payloads = _app1_payloads(data)
    fff = _join_flir_chunks(payloads)
    if len(fff) < 0x40 or fff[:4] not in (b"FFF\0", b"AFF\0"):
        raise _Bad("not an FFF record")
    bo = ">"
    if not 100 <= struct.unpack_from(">I", fff, 0x14)[0] < 200:
        bo = "<"
        if not 100 <= struct.unpack_from("<I", fff, 0x14)[0] < 200:
            raise _Bad("unknown FFF version")
    dir_off, count = struct.unpack_from(bo + "II", fff, 0x18)
    if count == 0 or count > 1024 or dir_off + 0x20 * count > len(fff):
        raise _Bad("FFF directory out of range")
    records: dict[int, bytes] = {}
    for i in range(count):
        e = dir_off + 0x20 * i
        typ = struct.unpack_from(bo + "H", fff, e)[0]
        off, length = struct.unpack_from(bo + "II", fff, e + 0x0C)
        if typ == 0 or length == 0:
            continue
        if off + length > len(fff):
            raise _Bad("FFF record truncated")
        records.setdefault(typ, fff[off : off + length])
    if REC_RAW not in records or REC_CAMERA_INFO not in records:
        raise _Bad("FFF record without raw data or camera info")

    planck, atmos, stored, model = _camera_info(records[REC_CAMERA_INFO])
    raw = _raw_data(records[REC_RAW])
    make, exif_model = _exif_make_model(payloads)
    return FlirRecord(
        raw=raw,
        planck=planck,
        atmos=atmos,
        make=make or "FLIR",
        model=model or exif_model,
        stored=stored,
    )


def _camera_info(rec: bytes) -> tuple[Planck, Atmos, ThermalSettingsPy, str]:
    if len(rec) < CAMERA_INFO_MIN:
        raise _Bad("camera info too short")
    bo = _record_bo(rec)

    def f32(off: int) -> float:
        v = struct.unpack_from(bo + "f", rec, off)[0]
        if not math.isfinite(v):
            raise _Bad(f"non-finite value at {off:#x}")
        return float(v)

    planck = Planck(
        r1=f32(0x58),
        r2=f32(0x30C),
        b=f32(0x5C),
        f=f32(0x60),
        o=float(struct.unpack_from(bo + "i", rec, 0x308)[0]),
    )
    if planck.r1 <= 0 or planck.r2 <= 0 or planck.b <= 0:
        raise _Bad("implausible Planck constants")
    atmos = Atmos(alpha1=f32(0x70), alpha2=f32(0x74), beta1=f32(0x78), beta2=f32(0x7C), x=f32(0x80))
    humidity = f32(0x3C)
    humidity_pct = humidity if humidity > 2.0 else humidity * 100.0
    stored = ThermalSettingsPy(
        emissivity=f32(0x20),
        distance_m=f32(0x24),
        air_c=f32(0x2C) - KELVIN,
        humidity_pct=humidity_pct,
        reflected_c=f32(0x28) - KELVIN,
    )
    # the stored settings must be usable as they are (a ValueError makes the record None)
    validate_settings(stored)
    checked_transmission(atmos, stored)
    model = _ascii(rec[0xD4 : 0xD4 + 32])
    return planck, atmos, stored, model


def _raw_data(rec: bytes) -> np.ndarray:
    if len(rec) < 0x20:
        raise _Bad("raw data too short")
    bo = _record_bo(rec)
    w, h = struct.unpack_from(bo + "HH", rec, 2)
    if w == 0 or h == 0:
        raise _Bad("empty raw image")
    body = rec[0x20:]
    if body.startswith(_PNG_SIG):
        img = _png16_flir(body)
    elif body[:4] in (b"II*\0", b"MM\0*"):
        img = _tiff16(body)
    else:
        need = w * h * 2
        if len(body) < need:
            raise _Bad("raw image truncated")
        img = np.frombuffer(body, dtype=bo + "u2", count=w * h).reshape(h, w)
    if img.shape != (h, w):
        raise _Bad("raw image size does not match its record")
    return np.ascontiguousarray(img, dtype=np.uint16)


# --- TIFF -----------------------------------------------------------------------------------

_TIFF_SIZES = {1: 1, 2: 1, 3: 2, 4: 4, 7: 1}


def _tiff_ifd0(t: bytes) -> tuple[str, dict[int, object]]:
    """Byte order and IFD0 of a TIFF as {tag: value}; ints as tuples, ASCII and bytes as bytes."""
    if t[:2] == b"II":
        bo = "<"
    elif t[:2] == b"MM":
        bo = ">"
    else:
        raise _Bad("not a TIFF")
    if struct.unpack_from(bo + "H", t, 2)[0] != 42:
        raise _Bad("not a TIFF")
    ifd = struct.unpack_from(bo + "I", t, 4)[0]
    n = struct.unpack_from(bo + "H", t, ifd)[0]
    tags: dict[int, object] = {}
    for i in range(n):
        e = ifd + 2 + 12 * i
        tag, typ, count = struct.unpack_from(bo + "HHI", t, e)
        size = _TIFF_SIZES.get(typ)
        if size is None:
            continue
        total = size * count
        at = e + 8 if total <= 4 else struct.unpack_from(bo + "I", t, e + 8)[0]
        if at + total > len(t):
            raise _Bad("TIFF tag out of range")
        if typ in (1, 2, 7):
            tags[tag] = t[at : at + total]
        else:
            fmt = "H" if typ == 3 else "I"
            tags[tag] = struct.unpack_from(f"{bo}{count}{fmt}", t, at)
    return bo, tags


def _tiff_int(tags: dict[int, object], tag: int, default: int | None = None) -> int:
    v = tags.get(tag)
    if isinstance(v, tuple) and v:
        return int(v[0])
    if default is None:
        raise _Bad(f"TIFF tag {tag} missing")
    return default


def _tiff16(t: bytes) -> np.ndarray:
    bo, tags = _tiff_ifd0(t)
    w, h = _tiff_int(tags, 256), _tiff_int(tags, 257)
    if _tiff_int(tags, 258) != 16 or _tiff_int(tags, 259, 1) != 1 or _tiff_int(tags, 277, 1) != 1:
        raise _Bad("unsupported TIFF raw image (16-bit, uncompressed, one band only)")
    offsets, counts = tags.get(273), tags.get(279)
    if not isinstance(offsets, tuple) or not isinstance(counts, tuple) or len(offsets) != len(counts):
        raise _Bad("TIFF strips missing")
    pieces = []
    for off, cnt in zip(offsets, counts, strict=True):
        if off + cnt > len(t):
            raise _Bad("TIFF strip truncated")
        pieces.append(t[off : off + cnt])
    pixels = b"".join(pieces)
    if len(pixels) < w * h * 2:
        raise _Bad("TIFF image truncated")
    return np.frombuffer(pixels, dtype=bo + "u2", count=w * h).reshape(h, w)


# --- PNG ------------------------------------------------------------------------------------


def _png16_flir(p: bytes) -> np.ndarray:
    """16-bit greyscale PNG with FLIR's byte-swapped words: the stored bytes are little-endian."""
    pos = len(_PNG_SIG)
    w = h = 0
    idat = bytearray()
    while pos + 8 <= len(p):
        length = struct.unpack_from(">I", p, pos)[0]
        tag = p[pos + 4 : pos + 8]
        body = p[pos + 8 : pos + 8 + length]
        if len(body) != length:
            raise _Bad("PNG chunk truncated")
        if tag == b"IHDR":
            w, h, depth, ctype, _comp, _filt, interlace = struct.unpack(">IIBBBBB", body)
            if depth != 16 or ctype != 0 or interlace != 0:
                raise _Bad("unsupported PNG raw image (16-bit grey, not interlaced, only)")
        elif tag == b"IDAT":
            idat += body
        elif tag == b"IEND":
            break
        pos += 12 + length
    if w == 0 or h == 0:
        raise _Bad("PNG without header")
    stride = w * 2
    raw = zlib.decompress(bytes(idat))
    if len(raw) < h * (stride + 1):
        raise _Bad("PNG image truncated")
    out = np.empty((h, stride), dtype=np.uint8)
    prev = np.zeros(stride, dtype=np.uint8)
    for y in range(h):
        start = y * (stride + 1)
        kind = raw[start]
        line = np.frombuffer(raw, dtype=np.uint8, count=stride, offset=start + 1)
        out[y] = _unfilter(kind, line, prev)
        prev = out[y]
    # PNG samples are big-endian; FLIR wrote little-endian words, so read the bytes as such.
    return out.reshape(-1).view("<u2").reshape(h, w)


def _unfilter(kind: int, line: np.ndarray, prev: np.ndarray) -> np.ndarray:
    bpp = 2
    if kind == 0:
        return line
    if kind == 1:  # Sub: running sum per byte lane
        return np.cumsum(line.reshape(-1, bpp), axis=0, dtype=np.uint8).reshape(-1)
    if kind == 2:  # Up
        return (line + prev).astype(np.uint8)
    if kind not in (3, 4):
        raise _Bad(f"unknown PNG filter {kind}")
    cur = bytearray(line.tobytes())
    up = prev.tobytes()
    for i in range(len(cur)):
        a = cur[i - bpp] if i >= bpp else 0
        b = up[i]
        if kind == 3:
            pred = (a + b) >> 1
        else:
            c = up[i - bpp] if i >= bpp else 0
            pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
            pred = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
        cur[i] = (cur[i] + pred) & 0xFF
    return np.frombuffer(bytes(cur), dtype=np.uint8)
