"""A PMTiles version 3 archive writer and reader, our own (no new dependency).

The format is the one MapLibre's and 3DTilesRendererJS's ``pmtiles`` reader (BSD-3-Clause) reads:
a 127-byte header, a gzip-compressed root directory within the first 16 KiB, gzip-compressed JSON
metadata, optional leaf directories, then the tile data clustered in tile-id (Hilbert) order.
Identical tiles are stored once (run lengths for neighbours, shared offsets otherwise), so the
empty sea or desert of a region pack costs one tile.

Specification: https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md
"""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import os
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO

HEADER_SIZE = 127
#: The header and the root directory must fit in the first 16 KiB a reader fetches.
ROOT_LIMIT = 16_384 - HEADER_SIZE

COMPRESSION_NONE = 1
COMPRESSION_GZIP = 2
TILE_TYPES = {"mvt": 1, "png": 2, "jpeg": 3, "webp": 4, "avif": 5}


def zxy_to_tileid(z: int, x: int, y: int) -> int:
    """The tile id of the PMTiles v3 Hilbert ordering: all tiles of lower zooms come first."""
    if z < 0 or z > 26:
        raise ValueError(f"zoom {z} out of range")
    n = 1 << z
    if not (0 <= x < n and 0 <= y < n):
        raise ValueError(f"tile {z}/{x}/{y} out of range")
    acc = ((1 << (2 * z)) - 1) // 3
    d = 0
    s = n >> 1
    while s > 0:
        rx = 1 if x & s else 0
        ry = 1 if y & s else 0
        d += s * s * ((3 * rx) ^ ry)
        if ry == 0:
            if rx == 1:
                x = n - 1 - x
                y = n - 1 - y
            x, y = y, x
        s >>= 1
    return acc + d


def tileid_to_zxy(tile_id: int) -> tuple[int, int, int]:
    acc = 0
    for z in range(27):
        count = 1 << (2 * z)
        if tile_id < acc + count:
            d = tile_id - acc
            n = 1 << z
            x = y = 0
            s = 1
            while s < n:
                rx = 1 & (d // 2)
                ry = 1 & (d ^ rx)
                if ry == 0:
                    if rx == 1:
                        x = s - 1 - x
                        y = s - 1 - y
                    x, y = y, x
                x += s * rx
                y += s * ry
                d //= 4
                s *= 2
            return z, x, y
        acc += count
    raise ValueError("tile id out of range")


def _varint(out: bytearray, v: int) -> None:
    while v >= 0x80:
        out.append((v & 0x7F) | 0x80)
        v >>= 7
    out.append(v)


def _read_varint(buf: bytes, pos: int) -> tuple[int, int]:
    v = shift = 0
    while True:
        b = buf[pos]
        pos += 1
        v |= (b & 0x7F) << shift
        if b < 0x80:
            return v, pos
        shift += 7


@dataclass(frozen=True)
class Entry:
    tile_id: int
    offset: int
    length: int
    #: 0 for a pointer to a leaf directory.
    run_length: int


def encode_directory(entries: list[Entry]) -> bytes:
    out = bytearray()
    _varint(out, len(entries))
    last = 0
    for e in entries:
        _varint(out, e.tile_id - last)
        last = e.tile_id
    for e in entries:
        _varint(out, e.run_length)
    for e in entries:
        _varint(out, e.length)
    for i, e in enumerate(entries):
        prev = entries[i - 1] if i > 0 else None
        if prev is not None and e.offset == prev.offset + prev.length:
            _varint(out, 0)
        else:
            _varint(out, e.offset + 1)
    return gzip.compress(bytes(out), mtime=0)


def decode_directory(data: bytes) -> list[Entry]:
    buf = gzip.decompress(data)
    n, pos = _read_varint(buf, 0)
    ids, runs, lengths, offsets = [], [], [], []
    last = 0
    for _ in range(n):
        d, pos = _read_varint(buf, pos)
        last += d
        ids.append(last)
    for _ in range(n):
        v, pos = _read_varint(buf, pos)
        runs.append(v)
    for _ in range(n):
        v, pos = _read_varint(buf, pos)
        lengths.append(v)
    for i in range(n):
        v, pos = _read_varint(buf, pos)
        if v == 0 and i > 0:
            offsets.append(offsets[i - 1] + lengths[i - 1])
        else:
            offsets.append(v - 1)
    return [Entry(ids[i], offsets[i], lengths[i], runs[i]) for i in range(n)]


def _directories(entries: list[Entry]) -> tuple[bytes, bytes]:
    """The root directory and the leaf directories, leaves only when the root would not fit."""
    root = encode_directory(entries)
    if len(root) <= ROOT_LIMIT:
        return root, b""
    leaf_size = 4096
    while True:
        leaves = bytearray()
        pointers: list[Entry] = []
        for i in range(0, len(entries), leaf_size):
            chunk = entries[i : i + leaf_size]
            data = encode_directory(chunk)
            pointers.append(Entry(chunk[0].tile_id, len(leaves), len(data), 0))
            leaves += data
        root = encode_directory(pointers)
        if len(root) <= ROOT_LIMIT:
            return root, bytes(leaves)
        leaf_size *= 2


def _e7(v: float) -> int:
    return round(v * 10_000_000)


class PMTilesWriter:
    """Add tiles in any order; ``finish`` writes the archive clustered in tile-id order.

    Tile bytes go to a spool file beside the archive while the tiles are made, so memory holds
    only the index (a region pack is hundreds of thousands of tiles).
    """

    def __init__(self, path: Path, tile_type: str):
        if tile_type not in TILE_TYPES:
            raise ValueError(f"unknown tile type {tile_type}")
        self.path = Path(path)
        self.tile_type = TILE_TYPES[tile_type]
        self.spool_path = self.path.with_name(self.path.name + ".spool")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._spool: BinaryIO = open(self.spool_path, "wb")  # noqa: SIM115 - closed in finish/abort
        self._index: dict[int, tuple[int, int]] = {}
        self._by_hash: dict[bytes, tuple[int, int]] = {}
        self._spool_size = 0
        self.zooms: set[int] = set()

    def add(self, z: int, x: int, y: int, data: bytes) -> None:
        if not data:
            return
        tid = zxy_to_tileid(z, x, y)
        h = hashlib.sha256(data).digest()
        found = self._by_hash.get(h)
        if found is None:
            self._spool.write(data)
            found = (self._spool_size, len(data))
            self._spool_size += len(data)
            self._by_hash[h] = found
        self._index[tid] = found
        self.zooms.add(z)

    @property
    def count(self) -> int:
        return len(self._index)

    def abort(self) -> None:
        self._spool.close()
        self.spool_path.unlink(missing_ok=True)

    def finish(
        self,
        *,
        bounds: tuple[float, float, float, float],
        metadata: dict[str, Any],
        min_zoom: int | None = None,
        max_zoom: int | None = None,
    ) -> dict[str, int]:
        self._spool.close()
        ids = sorted(self._index)
        # Lay the tile data out again in tile-id order (clustered), each content once.
        entries: list[Entry] = []
        placed: dict[tuple[int, int], int] = {}
        order: list[tuple[int, int]] = []
        data_size = 0
        for tid in ids:
            spool_off, length = self._index[tid]
            off = placed.get((spool_off, length))
            if off is None:
                off = data_size
                placed[(spool_off, length)] = off
                order.append((spool_off, length))
                data_size += length
            last = entries[-1] if entries else None
            if (
                last is not None
                and last.offset == off
                and last.length == length
                and last.tile_id + last.run_length == tid
            ):
                entries[-1] = Entry(last.tile_id, last.offset, last.length, last.run_length + 1)
            else:
                entries.append(Entry(tid, off, length, 1))

        root, leaves = _directories(entries)
        meta = gzip.compress(json.dumps(metadata, ensure_ascii=False).encode("utf-8"), mtime=0)
        root_off = HEADER_SIZE
        meta_off = root_off + len(root)
        leaf_off = meta_off + len(meta)
        data_off = leaf_off + len(leaves)
        zs = sorted(self.zooms) or [0]
        lo = min_zoom if min_zoom is not None else zs[0]
        hi = max_zoom if max_zoom is not None else zs[-1]
        w, s, e, n = bounds
        header = struct.pack(
            "<7sB11QBBBBBBiiiiBii",
            b"PMTiles",
            3,
            root_off,
            len(root),
            meta_off,
            len(meta),
            leaf_off,
            len(leaves),
            data_off,
            data_size,
            sum(en.run_length for en in entries),
            len(entries),
            len(order),
            1,  # clustered
            COMPRESSION_GZIP,
            COMPRESSION_NONE,  # tiles are WebP, PNG or JPEG: already compressed
            self.tile_type,
            lo,
            hi,
            _e7(w),
            _e7(s),
            _e7(e),
            _e7(n),
            lo,
            _e7((w + e) / 2),
            _e7((s + n) / 2),
        )
        assert len(header) == HEADER_SIZE
        with open(self.path, "wb") as out, open(self.spool_path, "rb") as spool:
            out.write(header)
            out.write(root)
            out.write(meta)
            out.write(leaves)
            for spool_off, length in order:
                spool.seek(spool_off)
                out.write(spool.read(length))
            out.flush()
            os.fsync(out.fileno())
        self.spool_path.unlink(missing_ok=True)
        return {"tiles": sum(en.run_length for en in entries), "contents": len(order)}


@dataclass(frozen=True)
class Header:
    root_offset: int
    root_length: int
    metadata_offset: int
    metadata_length: int
    leaf_offset: int
    leaf_length: int
    data_offset: int
    data_length: int
    addressed_tiles: int
    tile_entries: int
    tile_contents: int
    clustered: bool
    internal_compression: int
    tile_compression: int
    tile_type: int
    min_zoom: int
    max_zoom: int
    bounds: tuple[float, float, float, float]


def read_header(raw: bytes) -> Header:
    v = struct.unpack("<7sB11QBBBBBBiiiiBii", raw[:HEADER_SIZE])
    if v[0] != b"PMTiles" or v[1] != 3:
        raise ValueError("not a PMTiles version 3 archive")
    return Header(
        *v[2:13],
        bool(v[13]),
        v[14],
        v[15],
        v[16],
        v[17],
        v[18],
        (v[19] / 1e7, v[20] / 1e7, v[21] / 1e7, v[22] / 1e7),
    )


class PMTilesReader:
    """Random access to the tiles of an archive (tests, and the pack checks)."""

    def __init__(self, path: Path):
        self._f = open(path, "rb")  # noqa: SIM115 - closed by close()
        self.header = read_header(self._f.read(HEADER_SIZE))
        self._root = decode_directory(self._read(self.header.root_offset, self.header.root_length))

    def __enter__(self) -> PMTilesReader:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def close(self) -> None:
        self._f.close()

    def _read(self, offset: int, length: int) -> bytes:
        self._f.seek(offset)
        return self._f.read(length)

    def metadata(self) -> dict[str, Any]:
        raw = self._read(self.header.metadata_offset, self.header.metadata_length)
        return json.loads(gzip.decompress(raw))

    def get(self, z: int, x: int, y: int) -> bytes | None:
        tid = zxy_to_tileid(z, x, y)
        entries = self._root
        for _ in range(4):
            found = _find(entries, tid)
            if found is None:
                return None
            if found.run_length > 0:
                return self._read(self.header.data_offset + found.offset, found.length)
            entries = decode_directory(self._read(self.header.leaf_offset + found.offset, found.length))
        return None

    def tiles(self) -> list[tuple[int, int, int]]:
        """Every addressed tile (z, x, y), for tests."""
        out: list[tuple[int, int, int]] = []

        def walk(entries: list[Entry]) -> None:
            for e in entries:
                if e.run_length == 0:
                    walk(decode_directory(self._read(self.header.leaf_offset + e.offset, e.length)))
                else:
                    out.extend(tileid_to_zxy(e.tile_id + i) for i in range(e.run_length))

        walk(self._root)
        return out


def _find(entries: list[Entry], tid: int) -> Entry | None:
    lo, hi = 0, len(entries) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        c = entries[mid].tile_id
        if tid > c:
            lo = mid + 1
        elif tid < c:
            hi = mid - 1
        else:
            return entries[mid]
    if hi >= 0:
        e = entries[hi]
        if e.run_length == 0 or tid - e.tile_id < e.run_length:
            return e
    return None


def tile_bytes_of(image: Any, fmt: str, *, quality: int = 80, lossless: bool = False) -> bytes:
    """Encode a PIL image as a tile: WebP (lossy or lossless), PNG or JPEG."""
    buf = io.BytesIO()
    if fmt == "webp":
        if lossless:
            image.save(buf, "WEBP", lossless=True, exact=True, quality=100, method=4)
        else:
            image.save(buf, "WEBP", quality=quality, method=4)
    elif fmt == "png":
        image.save(buf, "PNG", optimize=False, compress_level=6)
    elif fmt == "jpeg":
        image.convert("RGB").save(buf, "JPEG", quality=quality)
    else:
        raise ValueError(f"unknown tile format {fmt}")
    return buf.getvalue()
