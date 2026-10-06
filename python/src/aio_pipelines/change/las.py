"""LAS 1.4 point files in numpy, for the cloud change pipeline (``change.cloud``).

PDAL reads the COPC tiles and writes them as plain (uncompressed) LAS 1.4; this module reads those
records into numpy, and writes them back with extra-bytes dimensions appended (``Distance``, one
float per point, LAS 1.4 R15 section 2.5 "Extra Bytes"). PDAL then turns the LAS tiles into one
COPC with ``extra_dims: all``. Only point data record formats 6, 7 and 8 (the COPC formats) are
read; a base record is copied byte for byte, so every field PDAL wrote survives.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

import numpy as np

from ..runtime import atomic_write_bytes

HEADER_SIZE = 375
VLR_HEADER = 54
EXTRA_BYTES_RECORD = 192
EXTRA_BYTES_USER = "LASF_Spec"
EXTRA_BYTES_ID = 4
#: Base record length per point data record format (LAS 1.4 R15).
BASE_LENGTH = {6: 30, 7: 36, 8: 38}
#: Extra-bytes data types (1 to 10) to numpy.
EXTRA_DTYPE = {
    1: np.dtype("u1"),
    2: np.dtype("i1"),
    3: np.dtype("<u2"),
    4: np.dtype("<i2"),
    5: np.dtype("<u4"),
    6: np.dtype("<i4"),
    7: np.dtype("<u8"),
    8: np.dtype("<i8"),
    9: np.dtype("<f4"),
    10: np.dtype("<f8"),
}
#: Base fields read by name: (byte offset, dtype, formats that carry it).
BASE_FIELDS: dict[str, tuple[int, str, frozenset[int]]] = {
    "X": (0, "<i4", frozenset({6, 7, 8})),
    "Y": (4, "<i4", frozenset({6, 7, 8})),
    "Z": (8, "<i4", frozenset({6, 7, 8})),
    "Intensity": (12, "<u2", frozenset({6, 7, 8})),
    "Classification": (16, "u1", frozenset({6, 7, 8})),
    "GpsTime": (22, "<f8", frozenset({6, 7, 8})),
    "Red": (30, "<u2", frozenset({7, 8})),
    "Green": (32, "<u2", frozenset({7, 8})),
    "Blue": (34, "<u2", frozenset({7, 8})),
}


class LasError(Exception):
    """A file this module cannot read or write; the message says why."""


@dataclass(frozen=True)
class ExtraDim:
    name: str
    data_type: int
    options: int = 0
    description: str = ""
    min: float | None = None
    max: float | None = None

    @property
    def size(self) -> int:
        if self.data_type == 0:
            return self.options
        if self.data_type not in EXTRA_DTYPE:
            raise LasError(f'The extra dimension "{self.name}" has the unsupported type {self.data_type}.')
        return EXTRA_DTYPE[self.data_type].itemsize


@dataclass
class Vlr:
    user_id: str
    record_id: int
    description: str
    data: bytes


@dataclass
class Las:
    pdrf: int
    record_length: int
    scale: tuple[float, float, float]
    offset: tuple[float, float, float]
    global_encoding: int
    vlrs: list[Vlr]
    #: One row of ``record_length`` bytes per point.
    records: np.ndarray
    extra: list[ExtraDim] = field(default_factory=list)

    @property
    def count(self) -> int:
        return int(self.records.shape[0])

    @property
    def xyz(self) -> np.ndarray:
        """Coordinates in the file CRS (float64, one row per point)."""
        out = np.empty((self.count, 3), dtype=np.float64)
        for a, name in enumerate(("X", "Y", "Z")):
            out[:, a] = self.field(name) * self.scale[a] + self.offset[a]
        return out

    def field(self, name: str) -> np.ndarray:
        if name in BASE_FIELDS:
            off, dt, formats = BASE_FIELDS[name]
            if self.pdrf not in formats:
                raise LasError(f"Point format {self.pdrf} has no {name}.")
            return _column(self.records, off, np.dtype(dt))
        off = BASE_LENGTH[self.pdrf]
        for e in self.extra:
            if e.name == name:
                if e.data_type == 0:
                    raise LasError(f'The extra dimension "{name}" has no type.')
                return _column(self.records, off, EXTRA_DTYPE[e.data_type])
            off += e.size
        raise LasError(f'The file has no dimension "{name}".')


def _column(records: np.ndarray, offset: int, dt: np.dtype) -> np.ndarray:
    raw = np.ascontiguousarray(records[:, offset : offset + dt.itemsize])
    return raw.view(dt).reshape(-1).copy()


def _text(b: bytes) -> str:
    return b.split(b"\0", 1)[0].decode("ascii", errors="replace")


def parse_extra_bytes(payload: bytes) -> list[ExtraDim]:
    """The descriptors of an extra-bytes VLR payload (192 bytes each)."""
    if len(payload) % EXTRA_BYTES_RECORD:
        raise LasError(f"An extra-bytes record is {EXTRA_BYTES_RECORD} bytes; this one has {len(payload)}.")
    dims: list[ExtraDim] = []
    for i in range(0, len(payload), EXTRA_BYTES_RECORD):
        r = payload[i : i + EXTRA_BYTES_RECORD]
        data_type, options = r[2], r[3]
        name = _text(r[4:36])
        lo = struct.unpack_from("<d", r, 88)[0] if options & 0b10 else None
        hi = struct.unpack_from("<d", r, 112)[0] if options & 0b100 else None
        dims.append(ExtraDim(name, data_type, options, _text(r[160:192]), lo, hi))
    return dims


def _extra_record(d: ExtraDim) -> bytes:
    r = bytearray(EXTRA_BYTES_RECORD)
    r[2] = d.data_type
    options = d.options & ~0b110
    name = d.name.encode("ascii")[:32]
    r[4 : 4 + len(name)] = name
    if d.min is not None and d.max is not None:
        options |= 0b110
        struct.pack_into("<d", r, 88, float(d.min))
        struct.pack_into("<d", r, 112, float(d.max))
    r[3] = options
    desc = d.description.encode("ascii", errors="replace")[:32]
    r[160 : 160 + len(desc)] = desc
    return bytes(r)


def read_las(path: Path) -> Las:
    """Read a LAS 1.2 to 1.4 file of point format 6, 7 or 8 (as PDAL writes them)."""
    data = Path(path).read_bytes()
    if len(data) < 227 or data[:4] != b"LASF":
        raise LasError(f"{Path(path).name} is not a LAS file.")
    minor = data[25]
    header_size = struct.unpack_from("<H", data, 94)[0]
    point_offset = struct.unpack_from("<I", data, 96)[0]
    n_vlrs = struct.unpack_from("<I", data, 100)[0]
    pdrf = data[104] & 0x3F  # bits 6 and 7 flag compression
    rec_len = struct.unpack_from("<H", data, 105)[0]
    if pdrf not in BASE_LENGTH:
        raise LasError(f"Point format {pdrf} is not supported (expected 6, 7 or 8).")
    count = struct.unpack_from("<Q", data, 247)[0] if minor >= 4 else 0
    if not count:
        count = struct.unpack_from("<I", data, 107)[0]
    scale = struct.unpack_from("<3d", data, 131)
    offset = struct.unpack_from("<3d", data, 155)
    vlrs: list[Vlr] = []
    pos = header_size
    for _ in range(n_vlrs):
        user = _text(data[pos + 2 : pos + 18])
        rid, length = struct.unpack_from("<HH", data, pos + 18)
        desc = _text(data[pos + 22 : pos + 54])
        vlrs.append(Vlr(user, rid, desc, data[pos + VLR_HEADER : pos + VLR_HEADER + length]))
        pos += VLR_HEADER + length
    extra: list[ExtraDim] = []
    for v in vlrs:
        if v.user_id == EXTRA_BYTES_USER and v.record_id == EXTRA_BYTES_ID:
            extra = parse_extra_bytes(v.data)
    if BASE_LENGTH[pdrf] + sum(e.size for e in extra) > rec_len:
        raise LasError("The extra bytes do not fit the point records.")
    end = point_offset + count * rec_len
    if end > len(data):
        raise LasError(f"{Path(path).name} is shorter than its {count} points.")
    records = np.frombuffer(data, dtype=np.uint8, count=count * rec_len, offset=point_offset)
    return Las(
        pdrf=pdrf,
        record_length=rec_len,
        scale=(scale[0], scale[1], scale[2]),
        offset=(offset[0], offset[1], offset[2]),
        global_encoding=struct.unpack_from("<H", data, 6)[0],
        vlrs=vlrs,
        records=records.reshape(count, rec_len).copy(),
        extra=extra,
    )


def write_las(
    path: Path,
    xyz: np.ndarray,
    *,
    pdrf: int = 6,
    template: Las | None = None,
    intensity: np.ndarray | None = None,
    classification: np.ndarray | None = None,
    rgb: np.ndarray | None = None,
    extra: dict[str, np.ndarray] | None = None,
    descriptions: dict[str, str] | None = None,
    scale: float = 0.001,
) -> None:
    """Write a LAS 1.4 file, atomically.

    With a ``template`` (a file read by ``read_las``) its base records, VLRs (but its extra-bytes
    record) and coordinate frame are kept as they are and ``xyz`` only sets the bounds; without
    one the records are made from ``xyz`` and the optional fields. ``extra`` appends one float
    dimension per entry (float32 or float64 arrays, in order).
    """
    xyz = np.asarray(xyz, dtype=np.float64).reshape(-1, 3)
    n = xyz.shape[0]
    if template is not None:
        if template.count != n:
            raise LasError("The template and the coordinates differ in point count.")
        pdrf = template.pdrf
        base = template.records[:, : BASE_LENGTH[pdrf]]
        sc, off = template.scale, template.offset
        vlrs = [
            v for v in template.vlrs if not (v.user_id == EXTRA_BYTES_USER and v.record_id == EXTRA_BYTES_ID)
        ]
        encoding = template.global_encoding | 0x10
    else:
        if pdrf not in BASE_LENGTH:
            raise LasError(f"Point format {pdrf} is not supported (expected 6, 7 or 8).")
        sc = (scale, scale, scale)
        lo = np.floor(xyz.min(axis=0)) if n else np.zeros(3)
        off = (float(lo[0]), float(lo[1]), float(lo[2]))
        base = np.zeros((n, BASE_LENGTH[pdrf]), dtype=np.uint8)
        for a, name in enumerate(("X", "Y", "Z")):
            ints = np.round((xyz[:, a] - off[a]) / sc[a]).astype("<i4")
            base[:, BASE_FIELDS[name][0] : BASE_FIELDS[name][0] + 4] = ints.view(np.uint8).reshape(n, 4)
        base[:, 14] = 0x11  # return 1 of 1
        if intensity is not None:
            base[:, 12:14] = np.asarray(intensity, dtype="<u2").view(np.uint8).reshape(n, 2)
        if classification is not None:
            base[:, 16] = np.asarray(classification, dtype=np.uint8)
        if rgb is not None and pdrf in (7, 8):
            base[:, 30:36] = np.asarray(rgb, dtype="<u2").reshape(n, 3).view(np.uint8).reshape(n, 6)
        vlrs = []
        encoding = 0x10  # WKT, required for formats 6 and above
    dims: list[ExtraDim] = []
    cols = [np.ascontiguousarray(base, dtype=np.uint8)]
    for name, values in (extra or {}).items():
        arr = np.asarray(values)
        dt = np.dtype("<f8") if arr.dtype == np.float64 else np.dtype("<f4")
        arr = arr.astype(dt).reshape(n)
        finite = arr[np.isfinite(arr)]
        dims.append(
            ExtraDim(
                name,
                10 if dt.itemsize == 8 else 9,
                0,
                (descriptions or {}).get(name, ""),
                float(finite.min()) if finite.size else None,
                float(finite.max()) if finite.size else None,
            )
        )
        cols.append(arr.view(np.uint8).reshape(n, dt.itemsize))
    if dims:
        vlrs.append(
            Vlr(EXTRA_BYTES_USER, EXTRA_BYTES_ID, "Extra bytes", b"".join(_extra_record(d) for d in dims))
        )
    records = np.hstack(cols) if len(cols) > 1 else cols[0]
    rec_len = int(records.shape[1])

    # bounds and returns from the records actually written
    ints = [_column(records, BASE_FIELDS[k][0], np.dtype("<i4")) for k in ("X", "Y", "Z")]
    real = [ints[a] * sc[a] + off[a] for a in range(3)]
    returns = np.bincount(records[:, 14] & 0x0F, minlength=16)[1:16] if n else np.zeros(15, dtype=np.int64)

    vlr_bytes = b""
    for v in vlrs:
        vlr_bytes += struct.pack(
            "<H16sHH32s",
            0,
            v.user_id.encode("ascii")[:16],
            v.record_id,
            len(v.data),
            v.description.encode("ascii", errors="replace")[:32],
        )
        vlr_bytes += v.data
    now = datetime.now(UTC)
    h = bytearray(HEADER_SIZE)
    h[0:4] = b"LASF"
    struct.pack_into("<H", h, 6, encoding)
    h[24], h[25] = 1, 4
    h[26 : 26 + 8] = b"Stratlas"
    h[58 : 58 + 21] = b"Stratlas change.cloud"
    struct.pack_into("<HH", h, 90, now.timetuple().tm_yday, now.year)
    struct.pack_into("<H", h, 94, HEADER_SIZE)
    struct.pack_into("<I", h, 96, HEADER_SIZE + len(vlr_bytes))
    struct.pack_into("<I", h, 100, len(vlrs))
    h[104] = pdrf
    struct.pack_into("<H", h, 105, rec_len)
    struct.pack_into("<3d", h, 131, *sc)
    struct.pack_into("<3d", h, 155, *off)
    if n:
        struct.pack_into(
            "<6d",
            h,
            179,
            float(real[0].max()),
            float(real[0].min()),
            float(real[1].max()),
            float(real[1].min()),
            float(real[2].max()),
            float(real[2].min()),
        )
    struct.pack_into("<Q", h, 247, n)
    struct.pack_into("<15Q", h, 255, *(int(x) for x in returns))
    atomic_write_bytes(Path(path), bytes(h) + vlr_bytes + records.tobytes())
