"""Point records of a LAS 1.4 file (point formats 6, 7 and 8, as PDAL's writers.las writes a COPC
out), read in chunks so a 20 M point cloud never sits in memory whole, and a filtered copy whose
header counts and bounds are rewritten.

No file stays open between chunks and nothing is memory mapped: on Windows a job that is cancelled
mid-stream (or whose rule fails) can delete the source and the output in its cleanup straight away,
while the traceback still holds the reading frames."""

from __future__ import annotations

import os
import shutil
import struct
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from ..runtime import JobError, replace_over

CHUNK = 2_000_000
CLASS_BYTE = 16
RETURN_BYTE = 14
FORMATS = frozenset({6, 7, 8})

Rule = Callable[[np.ndarray, np.ndarray], tuple[np.ndarray, np.ndarray]]


@dataclass(frozen=True)
class LasHead:
    minor: int
    point_offset: int
    pdrf: int
    record_length: int
    count: int
    legacy_count: int
    scale: tuple[float, float, float]
    offset: tuple[float, float, float]
    evlr_start: int
    evlr_count: int


def read_head(path: Path) -> LasHead:
    name = Path(path).name
    with open(path, "rb") as f:
        b = f.read(375)
        size = os.fstat(f.fileno()).st_size
    if len(b) < 227 or b[:4] != b"LASF":
        raise JobError(f"{name} is not a LAS file.")
    if b[104] & 0xC0:
        raise JobError(f"{name} is compressed (LAZ); write it out as plain LAS first.")
    minor = b[25]
    pdrf = b[104] & 0x3F
    if pdrf not in FORMATS:
        raise JobError(f"Point format {pdrf} is not supported here (expected 6, 7 or 8).")
    legacy = struct.unpack_from("<I", b, 107)[0]
    wide = minor >= 4 and len(b) >= 255
    count = struct.unpack_from("<Q", b, 247)[0] if wide else 0
    evlr_start, evlr_count = struct.unpack_from("<QI", b, 235) if wide else (0, 0)
    head = LasHead(
        minor=minor,
        point_offset=struct.unpack_from("<I", b, 96)[0],
        pdrf=pdrf,
        record_length=struct.unpack_from("<H", b, 105)[0],
        count=count or legacy,
        legacy_count=legacy,
        scale=struct.unpack_from("<3d", b, 131),
        offset=struct.unpack_from("<3d", b, 155),
        evlr_start=evlr_start,
        evlr_count=evlr_count,
    )
    if head.point_offset + head.count * head.record_length > size:
        raise JobError(f"{name} is shorter than its {head.count} points; the file is cut off.")
    return head


def chunks(path: Path, head: LasHead, size: int = CHUNK) -> Iterator[np.ndarray]:
    """Point records, ``size`` at a time, each chunk a copy read from a file opened only for it."""
    rl = head.record_length
    for start in range(0, head.count, size):
        n = min(size, head.count - start)
        with open(path, "rb") as f:
            f.seek(head.point_offset + start * rl)
            data = np.fromfile(f, dtype=np.uint8, count=n * rl)
        if data.size != n * rl:
            raise JobError(f"{Path(path).name} is shorter than its {head.count} points; the file is cut off.")
        yield data.reshape(n, rl)


def xyz_of(head: LasHead, rec: np.ndarray) -> np.ndarray:
    q = np.ascontiguousarray(rec[:, :12]).view("<i4").reshape(-1, 3)
    return q * np.asarray(head.scale) + np.asarray(head.offset)


def classes_of(rec: np.ndarray) -> np.ndarray:
    return np.array(rec[:, CLASS_BYTE], dtype=np.uint8)


def class_histogram(path: Path) -> np.ndarray:
    head = read_head(path)
    hist = np.zeros(256, dtype=np.int64)
    for rec in chunks(path, head):
        hist += np.bincount(rec[:, CLASS_BYTE], minlength=256)
    return hist


def _classes_for(cls: np.ndarray) -> np.ndarray:
    cls = np.asarray(cls)
    if cls.dtype == np.uint8:
        return cls
    if cls.size and (not np.issubdtype(cls.dtype, np.integer) or cls.min() < 0 or cls.max() > 255):
        raise JobError("A class is a number from 0 to 255.")
    return cls.astype(np.uint8)


def filter_las(
    src: Path,
    dst: Path,
    rule: Rule,
    check: Callable[[], None] | None = None,
    progress: Callable[[float], None] | None = None,
    size: int = CHUNK,
) -> dict[str, int]:
    """Copy ``src`` to ``dst`` with the points ``rule(xyz, cls) -> (keep, new_cls)`` keeps, written
    with their new class. Header, VLRs and EVLRs are copied; counts, counts by return and bounds
    are rewritten. ``dst`` appears whole or not at all: the copy is written under a temporary name
    beside it, removed on any failure (a cancel raised by ``check`` included)."""
    head = read_head(src)
    dst = Path(dst)
    tmp = dst.with_name(f".{dst.name}.{os.getpid()}.tmp")
    try:
        kept, by_return, lo, hi, evlr_at = _write_filtered(src, tmp, head, rule, check, progress, size)
        legacy = head.legacy_count != 0 and kept < 2**32
        with open(tmp, "r+b") as f:
            f.seek(107)
            f.write(struct.pack("<I", kept if legacy else 0))
            f.write(struct.pack("<5I", *(int(v) if legacy else 0 for v in by_return[:5])))
            f.seek(179)
            f.write(struct.pack("<6d", hi[0], lo[0], hi[1], lo[1], hi[2], lo[2]))
            if head.minor >= 4:
                if head.evlr_count:
                    f.seek(235)
                    f.write(struct.pack("<Q", evlr_at))
                f.seek(247)
                f.write(struct.pack("<Q", kept))
                f.write(struct.pack("<15Q", *(int(v) for v in by_return)))
        replace_over(tmp, dst)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    return {"points_in": head.count, "points_out": kept}


def _write_filtered(
    src: Path,
    tmp: Path,
    head: LasHead,
    rule: Rule,
    check: Callable[[], None] | None,
    progress: Callable[[float], None] | None,
    size: int,
) -> tuple[int, np.ndarray, np.ndarray, np.ndarray, int]:
    with open(src, "rb") as f:
        header = f.read(head.point_offset)
    lo = np.full(3, np.inf)
    hi = np.full(3, -np.inf)
    kept = 0
    by_return = np.zeros(15, dtype=np.int64)
    done = 0
    evlr_at = 0
    with open(tmp, "wb") as out:
        out.write(header)
        for rec in chunks(src, head, size):
            if check:
                check()
            xyz = xyz_of(head, rec)
            keep, cls = rule(xyz, classes_of(rec))
            keep = np.asarray(keep, dtype=bool)
            if keep.any():
                part = rec[keep]
                part[:, CLASS_BYTE] = _classes_for(np.asarray(cls)[keep])
                out.write(part.tobytes())
                k = xyz[keep]
                lo = np.minimum(lo, k.min(axis=0))
                hi = np.maximum(hi, k.max(axis=0))
                kept += len(part)
                rn = np.clip(part[:, RETURN_BYTE] & 0x0F, 1, 15).astype(np.int64) - 1
                by_return += np.bincount(rn, minlength=15)[:15]
            done += len(rec)
            if progress:
                progress(done / max(head.count, 1))
        if head.evlr_count:
            evlr_at = out.tell()
            with open(src, "rb") as f:
                f.seek(head.evlr_start)
                shutil.copyfileobj(f, out)
    if not kept:
        lo = hi = np.zeros(3)
    return kept, by_return, lo, hi, evlr_at
