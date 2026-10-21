"""Hand placements of photos that processing must honour.

The app keeps a photo's hand correction in ``<project>/orientation.json`` (``aio.orientation/1``,
``PhotoCorrection``): degrees added to its direction and ``offsetM``, metres added to its imported
``pos`` in the local frame (x east, y up, z south). "Edit position" writes ``offsetM``; the photo
record's ``pos`` stays the imported original. A pinned photo (``pin`` on the photo record) is at its
``pos`` already, and the app ignores corrections for it (the pin is its hand placement).

photo.align sends a photo placed by hand (a non-zero offset, or a pin) to ODM at that place instead
of its EXIF GPS. Directions are not read here: ODM's priors keep the photo's own gimbal angles.
"""

from __future__ import annotations

import json
import math
from collections.abc import Callable
from pathlib import Path
from typing import Any

ORIENTATION_SCHEMA = "aio.orientation/1"
#: offsets under half a millimetre count as zero (the app's ``correctionTo`` rule)
ZERO_M = 5e-4

Offset = tuple[float, float, float]


def _vec3(v: Any) -> list[float] | None:
    if not isinstance(v, list | tuple) or len(v) != 3:
        return None
    if not all(isinstance(c, int | float) and not isinstance(c, bool) and math.isfinite(c) for c in v):
        return None
    return [float(c) for c in v]


def read_offsets(project: Path, warn: Callable[[str], None] | None = None) -> dict[tuple[str, str], Offset]:
    """Non-zero position offsets by ``(layer id, photo id)`` from the project's orientation.json.
    No file: none. A file that cannot be read, or of another schema: none, and ``warn`` says so."""
    path = project / "orientation.json"
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text("utf-8-sig"))
    except (OSError, ValueError) as e:
        if warn:
            warn(f"orientation.json cannot be read ({e}); photos go to processing at their imported places.")
        return {}
    schema = data.get("schema") if isinstance(data, dict) else None
    if schema != ORIENTATION_SCHEMA:
        if warn:
            warn(
                f"orientation.json is {schema or 'of no known schema'}, not {ORIENTATION_SCHEMA}; "
                "its photo corrections are ignored."
            )
        return {}
    photos = data.get("photos")
    out: dict[tuple[str, str], Offset] = {}
    if not isinstance(photos, dict):
        return out
    for layer, by_id in photos.items():
        if not isinstance(by_id, dict):
            continue
        for pid, c in by_id.items():
            off = _vec3(c.get("offsetM")) if isinstance(c, dict) else None
            if off and any(abs(v) >= ZERO_M for v in off):
                out[(str(layer), str(pid))] = (off[0], off[1], off[2])
    return out


def corrected_pos(item: dict[str, Any], offset: Offset | None) -> list[float] | None:
    """The photo's place as the app draws it: its ``pos`` plus the offset; a pinned photo's ``pos``
    as it is. None when the photo has no place."""
    pos = _vec3(item.get("pos"))
    if pos is None:
        return None
    if offset is None or item.get("pin") is not None:
        return pos
    return [pos[i] + offset[i] for i in range(3)]


def placed_by_hand(item: dict[str, Any], offset: Offset | None) -> bool:
    """Whether the photo's place is a hand placement (pinned, or moved by an offset) that processing
    must use instead of the photo's own GPS."""
    if _vec3(item.get("pos")) is None:
        return False
    return item.get("pin") is not None or offset is not None
