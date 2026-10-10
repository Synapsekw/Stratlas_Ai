"""LAS 1.4 and LAZ writer for point cloud exports.

The points keep every base field the source had (intensity, returns, classification, GPS time,
colour) when they come as LAS 1.4 records of point format 6, 7 or 8 (``change/las.py`` reads them;
PDAL writes them from COPC); only X, Y and Z are rewritten, in the export frame, with a scale of
0.001 of the output unit (1e-7 degree for longitude and latitude). A cloud known only by its
coordinates (a kit-packed layer) gets point format 6 records with return 1 of 1.

The CRS goes in an OGC WKT VLR (``LASF_Projection`` 2112, global encoding bit 4), compound with the
vertical CRS when the heights are on a geoid with an EPSG code. LAZ is the same file compressed by
PDAL (``pdal translate``, LASzip, every VLR forwarded); without PDAL a LAZ export is refused with that
reason, and a ``.las`` destination is written without it.
"""

from __future__ import annotations

import math
import os
import struct
import subprocess
from datetime import UTC, datetime
from pathlib import Path

import numpy as np

from ..change.las import BASE_LENGTH, Las
from ..runtime import JobError, replace_over

HEADER = 375
VLR_HEAD = 54
SYSTEM = b"Quadrion AI"
SOFTWARE = b"Quadrion AI survey.export"
PDAL_NEEDED = (
    "Exporting a point cloud as LAZ needs PDAL, which this pipeline pack does not have (no tools/pdal "
    "and none on the PATH). Install the full pipeline pack, or export as LAS."
)


def las_from_xyz(xyz: np.ndarray) -> Las:
    """Point format 6 records (return 1 of 1) for coordinates alone; X, Y, Z are set by ``write``."""
    n = len(xyz)
    rec = np.zeros((n, BASE_LENGTH[6]), dtype=np.uint8)
    rec[:, 14] = 0x11
    return Las(6, BASE_LENGTH[6], (1.0, 1.0, 1.0), (0.0, 0.0, 0.0), 0x10, [], rec)


def wkt_vlr(wkt: str) -> bytes:
    data = wkt.encode("utf-8") + b"\0"
    head = struct.pack("<H16sHH32s", 0, b"LASF_Projection", 2112, len(data), b"OGC WKT")
    return head + data


def write_las(path: Path, src: Las, xyz: np.ndarray, *, wkt: str, geographic: bool) -> dict[str, float | int]:
    """Write ``src``'s records with coordinates ``xyz`` (output frame), LAS 1.4, to ``path`` (a .las)."""
    xyz = np.asarray(xyz, dtype=np.float64).reshape(-1, 3)
    n = len(xyz)
    if n != src.count:
        raise JobError("The cloud and its coordinates differ in point count.")
    if n == 0:
        raise JobError("The point cloud has no points to export.")
    sc = (1e-7, 1e-7, 0.001) if geographic else (0.001, 0.001, 0.001)
    lo = xyz.min(axis=0)
    off = tuple(float(math.floor(v)) for v in lo)
    rec = np.ascontiguousarray(src.records[:, : BASE_LENGTH[src.pdrf]]).copy()
    ints = []
    for a in range(3):
        q = np.round((xyz[:, a] - off[a]) / sc[a])
        if q.max() > 2**31 - 1 or q.min() < -(2**31):
            raise JobError("The cloud's coordinates do not fit LAS integers at this scale.")
        qi = q.astype("<i4")
        rec[:, 4 * a : 4 * a + 4] = qi.view(np.uint8).reshape(n, 4)
        ints.append(qi.astype(np.float64) * sc[a] + off[a])
    vlr = wkt_vlr(wkt)
    rec_len = rec.shape[1]
    returns = np.bincount(rec[:, 14] & 0x0F, minlength=16)[1:16]
    now = datetime.now(UTC)
    h = bytearray(HEADER)
    h[0:4] = b"LASF"
    struct.pack_into("<H", h, 6, (src.global_encoding & ~0x01) | 0x10)
    h[24], h[25] = 1, 4
    h[26:58] = SYSTEM.ljust(32, b"\0")
    h[58:90] = SOFTWARE.ljust(32, b"\0")
    struct.pack_into("<HH", h, 90, now.timetuple().tm_yday, now.year)
    struct.pack_into("<H", h, 94, HEADER)
    struct.pack_into("<I", h, 96, HEADER + len(vlr))
    struct.pack_into("<I", h, 100, 1)
    h[104] = src.pdrf
    struct.pack_into("<H", h, 105, rec_len)
    struct.pack_into("<3d", h, 131, *sc)
    struct.pack_into("<3d", h, 155, *off)
    struct.pack_into(
        "<6d",
        h,
        179,
        float(ints[0].max()),
        float(ints[0].min()),
        float(ints[1].max()),
        float(ints[1].min()),
        float(ints[2].max()),
        float(ints[2].min()),
    )
    struct.pack_into("<Q", h, 247, n)
    struct.pack_into("<15Q", h, 255, *(int(x) for x in returns))
    tmp = path.with_name(f".{path.stem}.{os.getpid()}.tmp.las")
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(tmp, "wb") as f:
        f.write(bytes(h))
        f.write(vlr)
        f.write(rec.tobytes())
    replace_over(tmp, path)
    return {"points": n, "pointFormat": src.pdrf}


def compress_laz(pdal: str, las: Path, laz: Path, env: dict[str, str]) -> None:
    """``pdal translate`` a LAS to LAZ, every VLR and the header forwarded."""
    tmp = laz.with_name(f".{laz.stem}.{os.getpid()}.tmp.laz")
    cmd = [
        pdal,
        "translate",
        str(las),
        str(tmp),
        "--writers.las.compression=true",
        "--writers.las.forward=all",
        "--writers.las.minor_version=4",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, env=env, check=False)
    if proc.returncode != 0 or not tmp.is_file():
        msg = (proc.stderr or proc.stdout or "").strip().splitlines()
        if tmp.exists():
            tmp.unlink()
        raise JobError(f"PDAL could not write the LAZ file: {msg[-1] if msg else f'exit {proc.returncode}'}")
    replace_over(tmp, laz)
