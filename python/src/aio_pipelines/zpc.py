"""A Bentley ``.zpc`` point cloud export: a ZIP of LAS or LAZ tiles (iTwin Capture Modeler).

Only ``.las`` and ``.laz`` members are tiles; other members are ignored. A member with an
absolute path, a drive letter or ``..`` refuses the whole file (nothing is unpacked), as does an
encrypted member. Tiles are unpacked under names this module makes (``tile-NNN.<ext>``), never
the member's own, into the job's staging folder.
"""

from __future__ import annotations

import re
import zipfile
import zlib
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from .runtime import JobError, StepContext

TILE_SUFFIXES = {".las", ".laz"}
CHUNK = 8 * 1024 * 1024


@dataclass
class Tile:
    member: str
    name: str
    size: int


def _unsafe(name: str) -> bool:
    n = name.replace("\\", "/")
    return n.startswith("/") or bool(re.match(r"^[A-Za-z]:", n)) or ".." in n.split("/")


def list_tiles(path: Path, ignored: list[str] | None = None) -> list[Tile]:
    """The LAS and LAZ tiles of ``path``, in the ZIP's order. The names of the other members
    (not tiles, so not read) are added to ``ignored`` when given."""
    if not zipfile.is_zipfile(path):
        raise JobError(f"{path.name} is not a ZIP file, so not a Bentley .zpc export.")
    tiles: list[Tile] = []
    with zipfile.ZipFile(path) as z:
        for info in z.infolist():
            if info.is_dir():
                continue
            if _unsafe(info.filename):
                raise JobError(
                    f"{path.name} holds a file with an unsafe name ({info.filename[:120]}); it is not read."
                )
            if PurePosixPath(info.filename.replace("\\", "/")).suffix.lower() not in TILE_SUFFIXES:
                if ignored is not None:
                    ignored.append(info.filename)
                continue
            if info.flag_bits & 0x1:
                raise JobError(f"{path.name} is encrypted; export it again without a password.")
            tiles.append(
                Tile(info.filename, PurePosixPath(info.filename.replace("\\", "/")).name, info.file_size)
            )
    if not tiles:
        raise JobError(f"{path.name} holds no LAS or LAZ tiles.")
    return tiles


def extract_tiles(
    ctx: StepContext, src: Path, tiles: list[Tile], dest: Path, band: tuple[float, float]
) -> list[Path]:
    dest.mkdir(parents=True, exist_ok=True)
    lo, hi = band
    total = max(1, sum(t.size for t in tiles))
    done = 0
    out: list[Path] = []
    with zipfile.ZipFile(src) as z:
        for i, t in enumerate(tiles):
            dst = dest / f"tile-{i + 1:03d}{PurePosixPath(t.name).suffix.lower()}"
            try:
                with z.open(t.member) as fin, open(dst, "wb") as fout:
                    while chunk := fin.read(CHUNK):
                        ctx.check()
                        fout.write(chunk)
                        done += len(chunk)
                        ctx.progress(lo + (hi - lo) * done / total, f"Unpacking tile {i + 1} of {len(tiles)}")
            except (zipfile.BadZipFile, zlib.error, EOFError, OSError, NotImplementedError) as e:
                raise JobError(f"Tile {t.name} of {src.name} could not be unpacked: {e}") from None
            out.append(dst)
    return out
