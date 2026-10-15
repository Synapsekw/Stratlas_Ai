"""Survey dates (manifest ``captures``) from a pipeline, as ``captureForDate`` in
``packages/project/src/builder/create.ts`` makes them: the first capture with that date, or a new
``capture-<date>`` (``-2``, ``-3`` when taken) labelled ``Survey``, kept in date order."""

from __future__ import annotations

import re
from typing import Any


def capture_for_date(manifest: dict[str, Any], date: str) -> str:
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        raise ValueError(f'"{date}" is not a date (YYYY-MM-DD).')
    caps = manifest.setdefault("captures", [])
    for c in caps:
        if isinstance(c, dict) and c.get("date") == date:
            return str(c["id"])
    taken = {str(c.get("id")) for c in caps if isinstance(c, dict)}
    base = f"capture-{date}"
    cid, n = base, 2
    while cid in taken:
        cid, n = f"{base}-{n}", n + 1
    caps.append({"id": cid, "label": "Survey", "date": date})
    caps.sort(key=lambda c: str(c.get("date", "")) if isinstance(c, dict) else "")
    return cid
