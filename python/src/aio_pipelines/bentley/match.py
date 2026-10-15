"""Photos of a Bentley block found in the folder the person chose.

``ImagePath`` names a drive of the computer that ran the AT (``R:/...``), so photos are matched
by file name, without case, anywhere under the chosen folder. Several files of one name are told
apart by the last two path segments (the photo's folder and name); still ambiguous counts as
missing. A file is given to one photo only. Symbolic links are not followed.
"""

from __future__ import annotations

import os
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from ..opf.reader import _photo_id as photo_id

__all__ = ["Matching", "file_name", "match_photos", "photo_id"]


@dataclass
class Matching:
    found: dict[str, Path] = field(default_factory=dict)
    missing: list[str] = field(default_factory=list)
    ambiguous: list[str] = field(default_factory=list)
    names: dict[str, str] = field(default_factory=dict)


def _parts(image_path: str) -> list[str]:
    return [p for p in re.split(r"[\\/]+", image_path.strip()) if p]


def file_name(image_path: str) -> str:
    parts = _parts(image_path)
    return parts[-1] if parts else ""


def _index(root: Path, check: Callable[[], None]) -> dict[str, list[Path]]:
    out: dict[str, list[Path]] = {}
    for n, (folder, _dirs, files) in enumerate(os.walk(root, followlinks=False)):
        if n % 200 == 0:
            check()
        for f in files:
            out.setdefault(f.lower(), []).append(Path(folder) / f)
    return out


def _tail(parts: list[str]) -> str:
    return "/".join(parts[-2:]).lower()


def match_photos(paths: dict[str, str], root: Path, check: Callable[[], None] = lambda: None) -> Matching:
    index = _index(root, check)
    m = Matching()
    used: set[Path] = set()
    for pid, image_path in paths.items():
        parts = _parts(image_path)
        m.names[pid] = parts[-1] if parts else ""
        cands = [c for c in index.get(m.names[pid].lower(), []) if c not in used]
        if len(cands) > 1:
            want = _tail(parts)
            cands = [c for c in cands if _tail(list(c.relative_to(root).parts)) == want]
            if len(cands) != 1:
                m.ambiguous.append(pid)
                m.missing.append(pid)
                continue
        if not cands:
            m.missing.append(pid)
            continue
        m.found[pid] = cands[0]
        used.add(cands[0])
    return m
