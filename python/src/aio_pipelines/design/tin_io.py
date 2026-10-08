"""``aio.tin/1`` files (``<layer>.tin``, ``TinHeader`` of ``@aio/schema`` ``designs.ts``).

Layout, little-endian:

1. uint32: the length of the JSON header in bytes;
2. the UTF-8 JSON header;
3. zero padding to a multiple of 8 bytes (``verticesAt``);
4. ``vertexCount * 3`` float64: E, N, Z in the project CRS, metres, design offset not applied;
5. ``triangleCount * 3`` uint32 vertex indices (``trianglesAt``);
6. when the header has ``breaklines`` (the number of chains) and ``chainsAt``: each breakline or
   boundary chain as uint32 ``kind`` (0 breakline, 1 outer boundary, 2 void, 3 other boundary),
   uint32 ``count`` and ``count`` uint32 vertex indices. ``chainsAt`` is an additive header key
   (the header is a ``looseObject``); a reader that ignores it reads the surface as before.

``packages/survey/src/designs/tin.ts`` reads the same files in the renderer.
"""

from __future__ import annotations

import json
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from ..runtime import JobError
from .model import MAX_TRIANGLES

SCHEMA = "aio.tin/1"


def _pad8(n: int) -> int:
    return (n + 7) // 8 * 8


def encode_tin(
    vertices: np.ndarray,
    triangles: np.ndarray,
    crs: dict[str, Any],
    chains: list[tuple[int, np.ndarray]] | None = None,
) -> bytes:
    """The bytes of a ``.tin`` file; ``chains`` are (kind, vertex indices)."""
    v = np.ascontiguousarray(vertices, dtype="<f8").reshape(-1, 3)
    t = np.ascontiguousarray(triangles, dtype="<u4").reshape(-1, 3)
    if len(t) > MAX_TRIANGLES:
        raise JobError(f"A surface has {len(t):,} triangles, above the limit of {MAX_TRIANGLES:,}.")
    if len(t) and int(t.max()) >= len(v):
        raise JobError("A surface triangle names a vertex that does not exist.")
    if len(v):
        lo, hi = v.min(axis=0), v.max(axis=0)
        bounds = [float(lo[0]), float(lo[1]), float(lo[2]), float(hi[0]), float(hi[1]), float(hi[2])]
    else:
        bounds = [0.0] * 6
    chains = chains or []
    chain_bytes = b"".join(
        struct.pack("<II", kind, len(idx)) + np.ascontiguousarray(idx, dtype="<u4").tobytes()
        for kind, idx in chains
    )
    header: dict[str, Any] = {
        "schema": SCHEMA,
        "crs": crs,
        "bounds": bounds,
        "vertexCount": len(v),
        "triangleCount": len(t),
        "verticesAt": 0,
        "trianglesAt": 0,
    }
    if chains:
        header["breaklines"] = len(chains)
        header["chainsAt"] = 0
    # the offsets depend on the header's own length: settle them (two rounds at most)
    for _ in range(4):
        text = json.dumps(header, separators=(",", ":")).encode("utf-8")
        at = _pad8(4 + len(text))
        want = {"verticesAt": at, "trianglesAt": at + v.nbytes}
        if chains:
            want["chainsAt"] = at + v.nbytes + t.nbytes
        if all(header[k] == x for k, x in want.items()):
            break
        header.update(want)
    text = json.dumps(header, separators=(",", ":")).encode("utf-8")
    head = struct.pack("<I", len(text)) + text
    head += b"\0" * (header["verticesAt"] - len(head))
    return head + v.tobytes() + t.tobytes() + chain_bytes


@dataclass
class Tin:
    header: dict[str, Any]
    vertices: np.ndarray
    triangles: np.ndarray
    chains: list[tuple[int, np.ndarray]]


def decode_tin(data: bytes, vertical_offset: float = 0.0) -> Tin:
    """Read a ``.tin``; ``vertical_offset`` (the layer's ``verticalOffsetM``) is added to every Z."""
    if len(data) < 4:
        raise JobError("The surface file is empty or damaged.")
    (n,) = struct.unpack_from("<I", data, 0)
    if 4 + n > len(data):
        raise JobError("The surface file's header is damaged.")
    try:
        header = json.loads(data[4 : 4 + n].decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as e:
        raise JobError(f"The surface file's header is not JSON: {e}") from None
    if not isinstance(header, dict) or header.get("schema") != SCHEMA:
        raise JobError("The surface file is not an aio.tin/1 file.")
    nv, nt = int(header["vertexCount"]), int(header["triangleCount"])
    va, ta = int(header["verticesAt"]), int(header["trianglesAt"])
    if va % 8 or va + nv * 24 > len(data) or ta + nt * 12 > len(data) or nt > MAX_TRIANGLES:
        raise JobError("The surface file is shorter than its header says.")
    v = np.frombuffer(data, dtype="<f8", count=nv * 3, offset=va).reshape(-1, 3).copy()
    if vertical_offset:
        v[:, 2] += vertical_offset
    t = np.frombuffer(data, dtype="<u4", count=nt * 3, offset=ta).reshape(-1, 3).copy()
    chains: list[tuple[int, np.ndarray]] = []
    if "chainsAt" in header:
        at = int(header["chainsAt"])
        for _ in range(int(header.get("breaklines", 0))):
            kind, count = struct.unpack_from("<II", data, at)
            at += 8
            chains.append((kind, np.frombuffer(data, dtype="<u4", count=count, offset=at).copy()))
            at += 4 * count
    return Tin(header, v, t, chains)


def read_tin(path: Path, vertical_offset: float = 0.0) -> Tin:
    return decode_tin(path.read_bytes(), vertical_offset)


def chain_indices(
    vertices: np.ndarray, chains: list[tuple[int, np.ndarray]]
) -> tuple[np.ndarray, list[tuple[int, np.ndarray]]]:
    """Breakline and boundary chains as vertex indices.

    A chain point takes the surface vertex at the same E and N (to 1 mm); a point with no vertex
    there is appended as a new vertex (in no triangle). Returns the vertices with those appended.
    """
    if not chains:
        return vertices, []
    key = {(round(float(x) * 1000), round(float(y) * 1000)): i for i, (x, y) in enumerate(vertices[:, :2])}
    added: list[np.ndarray] = []
    out: list[tuple[int, np.ndarray]] = []
    for kind, coords in chains:
        idx = []
        for c in coords:
            k = (round(float(c[0]) * 1000), round(float(c[1]) * 1000))
            i = key.get(k)
            if i is None:
                i = len(vertices) + len(added)
                added.append(np.asarray(c[:3], dtype=np.float64))
                key[k] = i
            idx.append(i)
        out.append((kind, np.asarray(idx, dtype=np.uint32)))
    if added:
        vertices = np.vstack([vertices, np.vstack(added)])
    return vertices, out
