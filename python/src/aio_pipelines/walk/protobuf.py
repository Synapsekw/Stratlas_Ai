"""A minimal protobuf wire-format walker and writer, enough for the Insta360 trailer metadata.

Only the wire format is handled (varint, 64-bit, length-delimited, 32-bit); field meaning lives in
the caller. Every length is bounds-checked: a damaged message raises ``ProtobufError`` rather than
reading past its end. Unknown fields are the caller's to skip.
"""

from __future__ import annotations

import struct
from collections.abc import Iterator

VARINT = 0
FIXED64 = 1
LEN = 2
FIXED32 = 5


class ProtobufError(ValueError):
    """The bytes are not a well-formed protobuf message."""


def read_varint(buf: bytes, pos: int) -> tuple[int, int]:
    """Decode one varint at ``pos``; answers (value, next position)."""
    value = 0
    shift = 0
    while True:
        if pos >= len(buf):
            raise ProtobufError("varint runs past the end")
        byte = buf[pos]
        pos += 1
        value |= (byte & 0x7F) << shift
        if byte < 0x80:
            return value, pos
        shift += 7
        if shift >= 70:
            raise ProtobufError("varint too long")


def iter_fields(buf: bytes) -> Iterator[tuple[int, int, int | bytes]]:
    """Yield (field number, wire type, value): an int for varints, bytes for the others."""
    pos = 0
    end = len(buf)
    while pos < end:
        key, pos = read_varint(buf, pos)
        field, wire = key >> 3, key & 7
        if field == 0:
            raise ProtobufError("field number 0")
        if wire == VARINT:
            value, pos = read_varint(buf, pos)
            yield field, wire, value
        elif wire == FIXED64:
            if pos + 8 > end:
                raise ProtobufError("fixed64 runs past the end")
            yield field, wire, buf[pos : pos + 8]
            pos += 8
        elif wire == LEN:
            n, pos = read_varint(buf, pos)
            if n > end - pos:
                raise ProtobufError("length-delimited field runs past the end")
            yield field, wire, buf[pos : pos + n]
            pos += n
        elif wire == FIXED32:
            if pos + 4 > end:
                raise ProtobufError("fixed32 runs past the end")
            yield field, wire, buf[pos : pos + 4]
            pos += 4
        else:
            raise ProtobufError(f"unsupported wire type {wire}")


def as_double(raw: bytes) -> float:
    return struct.unpack("<d", raw)[0]


def as_signed(value: int) -> int:
    """A varint read as int64 (two's complement)."""
    return value - (1 << 64) if value >= 1 << 63 else value


# Writing (used by the synthetic trailer writer in the tests).


def encode_varint(value: int) -> bytes:
    if value < 0:
        value += 1 << 64
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def field_varint(field: int, value: int) -> bytes:
    return encode_varint(field << 3 | VARINT) + encode_varint(int(value))


def field_bytes(field: int, value: bytes | str) -> bytes:
    data = value.encode() if isinstance(value, str) else value
    return encode_varint(field << 3 | LEN) + encode_varint(len(data)) + data


def field_double(field: int, value: float) -> bytes:
    return encode_varint(field << 3 | FIXED64) + struct.pack("<d", value)
