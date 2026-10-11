"""Photo pair matching on the graphics card.

COLMAP's matcher is the longest stage of an alignment (two thirds of it on the measured sets).
This module does the same comparison on an array library: for every pair of the list, each
descriptor's nearest neighbour in the other photo by the same measure and the same tests as
COLMAP's (ratio 0.8, distance 0.7, cross check), written into COLMAP's database for COLMAP's own
geometric verification. With CuPy that is one matrix product per pair on the card (cuBLAS, which
the GPU add-on carries); with numpy it is the same code on the CPU, which is how the tests run it.

It runs as an operation of the COLMAP worker (``colmap_io.worker_main``, ``match-gpu``) in a
process that never imports pycolmap: the database is read and written with ``sqlite3``, so
NVIDIA's libraries and COLMAP's never share a process. A failure here costs nothing: the engine
drops what was written and lets COLMAP match every pair.
"""

from __future__ import annotations

import sqlite3
import time
from collections import OrderedDict
from collections.abc import Callable
from pathlib import Path
from typing import Any

import numpy as np

#: COLMAP's pair id: ``image_id1 * PAIR_RANGE + image_id2`` with ``image_id1 < image_id2``.
PAIR_RANGE = 2147483647
#: COLMAP's SIFT descriptors are unit vectors times 512, stored as bytes.
NORM = np.float32(1.0 / (512.0 * 512.0))
RATIO = 0.8
MAX_DISTANCE = 0.7
MAX_MATCHES = 32768
#: Products held at once, in cells: 250 million float32 are 1 GB of the card's memory.
CELLS = 250_000_000
#: Descriptors kept on the card between pairs, bytes.
KEEP_BYTES = 1_500_000_000


def _accept(xp: Any, best: Any, second: Any, ratio: float, max_distance: float) -> Any:
    """COLMAP's one-way test on products: near enough, and clearly nearer than the runner-up."""
    one = np.float32(1)
    d1 = xp.arccos(xp.minimum(best * NORM, one))
    d2 = xp.where(second < 0, np.float32(np.inf), xp.arccos(xp.minimum(second * NORM, one)))
    return (d1 <= np.float32(max_distance)) & (d1 < np.float32(ratio) * d2)


def match_pair(
    xp: Any, a: Any, b: Any, ratio: float = RATIO, max_distance: float = MAX_DISTANCE, cells: int = CELLS
) -> np.ndarray:
    """Matches (k, 2) uint32 between descriptor sets ``a`` (n1, 128) and ``b`` (n2, 128), float32
    arrays of ``xp``: pairs that are each other's nearest neighbour and pass COLMAP's tests.

    The products are worked in blocks of rows of ``a`` so they fit ``cells``; the answer does not
    depend on the block size.
    """
    n1, n2 = int(a.shape[0]), int(b.shape[0])
    if n1 == 0 or n2 == 0:
        return np.zeros((0, 2), np.uint32)
    rows = max(1, min(n1, cells // n2))
    m12 = xp.empty(n1, xp.int64)
    best0 = xp.full(n2, -1, xp.float32)
    second0 = xp.full(n2, -1, xp.float32)
    arg0 = xp.zeros(n2, xp.int64)
    cols = xp.arange(n2)
    bt = b.T
    for s in range(0, n1, rows):
        dots = a[s : s + rows] @ bt
        c = int(dots.shape[0])
        # each row's best and second best partner: the best is masked for the second, then put back
        idx = xp.arange(c)
        arg = dots.argmax(axis=1)
        best = dots[idx, arg]
        dots[idx, arg] = -1
        second = dots.max(axis=1)
        dots[idx, arg] = best
        m12[s : s + c] = xp.where(_accept(xp, best, second, ratio, max_distance), arg, -1)
        # each column's best and second best in this block, merged into the running ones
        carg = dots.argmax(axis=0)
        cbest = dots[carg, cols]
        dots[carg, cols] = -1
        csecond = dots.max(axis=0)
        second0 = xp.maximum(xp.minimum(best0, cbest), xp.maximum(second0, csecond))
        arg0 = xp.where(cbest > best0, carg + s, arg0)
        best0 = xp.maximum(best0, cbest)
        del dots
    m21 = xp.where(_accept(xp, best0, second0, ratio, max_distance), arg0, -1)
    i1 = xp.arange(n1)
    ok = (m12 >= 0) & (m21[xp.clip(m12, 0, None)] == i1)
    out = xp.stack([i1[ok], m12[ok]], 1).astype(xp.uint32)
    return np.asarray(out.get() if hasattr(out, "get") else out)


# ------------------------------------------------------------------------- COLMAP's database


def image_ids(con: sqlite3.Connection) -> dict[str, int]:
    return {str(name): int(i) for i, name in con.execute("select image_id, name from images")}


def read_descriptors(con: sqlite3.Connection, image_id: int) -> np.ndarray:
    """One photo's descriptors (n, 128) uint8; ``ValueError`` when they are not SIFT bytes."""
    row = con.execute("select rows, cols, data from descriptors where image_id = ?", (image_id,)).fetchone()
    if row is None:
        return np.zeros((0, 128), np.uint8)
    rows, cols, data = int(row[0]), int(row[1]), row[2] or b""
    if cols != 128 or len(data) != rows * cols:
        raise ValueError(f"the descriptors of image {image_id} are not 128 bytes each")
    return np.frombuffer(data, np.uint8).reshape(rows, cols)


def pair_id(a: int, b: int) -> int:
    lo, hi = (a, b) if a < b else (b, a)
    return lo * PAIR_RANGE + hi


def write_matches(con: sqlite3.Connection, a: int, b: int, matches: np.ndarray) -> None:
    """Store a pair's matches as COLMAP does: columns in the order of the smaller image id."""
    m = np.ascontiguousarray(matches if a < b else matches[:, ::-1], dtype=np.uint32)
    con.execute(
        "insert or replace into matches(pair_id, rows, cols, data) values (?, ?, 2, ?)",
        (pair_id(a, b), int(m.shape[0]), m.tobytes()),
    )


def clear_matches(database: Path | str) -> None:
    """Drop every match and verification: what a failed run on the card left behind."""
    con = sqlite3.connect(str(database), timeout=30)
    try:
        with con:
            con.execute("delete from matches")
            con.execute("delete from two_view_geometries")
    finally:
        con.close()


# -------------------------------------------------------------------------------- the operation


class _Kept:
    """Descriptors on the array library, the least recently used dropped first."""

    def __init__(self, xp: Any, con: sqlite3.Connection, budget: int):
        self.xp, self.con, self.budget = xp, con, budget
        self.held: OrderedDict[int, Any] = OrderedDict()
        self.bytes = 0

    def __call__(self, image_id: int) -> Any:
        if image_id in self.held:
            self.held.move_to_end(image_id)
            return self.held[image_id]
        d = self.xp.asarray(read_descriptors(self.con, image_id)).astype(self.xp.float32)
        self.held[image_id] = d
        self.bytes += int(d.nbytes)
        while self.bytes > self.budget and len(self.held) > 2:
            _, old = self.held.popitem(last=False)
            self.bytes -= int(old.nbytes)
        return d


def run(req: dict[str, Any], send: Callable[..., None], xp: Any = None) -> dict[str, Any]:
    """Match the pairs of ``req["pairs"]`` (a file of ``name name`` lines, as COLMAP reads it)
    and write them into ``req["database"]``. ``xp`` is the array library; without it the GPU
    add-on ``req["addon"]`` is loaded and CuPy is used. Pairs that already have matches are kept
    (a resume)."""
    from .colmap_io import engine_alias

    name = "numpy"
    if xp is None:
        from .. import accel

        accel.activate(Path(req["addon"]))
        import cupy  # type: ignore[import-not-found]

        xp = cupy
        props = cupy.cuda.runtime.getDeviceProperties(0)
        raw = props.get("name", b"")
        name = raw.decode("utf-8", "replace").strip("\x00 ") if isinstance(raw, bytes) else str(raw)
    lines = [ln.split() for ln in Path(req["pairs"]).read_text("utf-8").splitlines() if ln.strip()]
    t0 = time.monotonic()
    con = sqlite3.connect(str(req["database"]), timeout=60)
    try:
        ids = {engine_alias(n): i for n, i in image_ids(con).items()}
        have = {int(r[0]) for r in con.execute("select pair_id from matches")}
        kept = _Kept(xp, con, int(req.get("keepBytes", KEEP_BYTES)))
        cells = int(req.get("cells", CELLS))
        matched = made = 0
        for n, (na, nb) in enumerate(lines):
            if na not in ids or nb not in ids:
                raise ValueError(f"the pair list names a photo the database does not have ({na} or {nb})")
            ia, ib = ids[na], ids[nb]
            if pair_id(ia, ib) not in have:
                m = match_pair(xp, kept(ia), kept(ib), cells=cells)[:MAX_MATCHES]
                write_matches(con, ia, ib, m)
                have.add(pair_id(ia, ib))
                matched += int(m.shape[0])
                made += 1
            if n % 100 == 99:
                con.commit()  # a stop loses at most these pairs; the next run makes them again
                send(progress=(n + 1) / len(lines), message=f"{n + 1} of {len(lines)} pairs")
        con.commit()
    finally:
        con.close()
    send(progress=1.0, message=f"{len(lines)} of {len(lines)} pairs")
    return {
        "pairs": len(lines),
        "made": made,
        "matches": matched,
        "seconds": round(time.monotonic() - t0, 2),
        "gpu": name,
    }
