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


# ---- date shifts (line up dates): the port of @aio/workspace `layerDateShifts` -----------------
# `captureIndex` rules 1 and 3 without volume hints; one shared fixture holds both to the same
# answers (packages/schema/src/__fixtures__/date-shift/membership.json).

DATED_KINDS = frozenset({"mesh", "pointcloud", "raster", "photos", "panoramas", "video", "walk", "vector"})
ZERO_M = 0.0005
_MONTHS = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
]
Shift = tuple[float, float]


def date_spellings(iso: str) -> list[str]:
    """Ways a layer id or name writes a capture's ISO date, lower case, longest first."""
    m = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", iso)
    if not m:
        return [iso.lower()]
    y, mo, d = m.groups()
    month = _MONTHS[int(mo) - 1] if 1 <= int(mo) <= 12 else ""
    mon, day = month[:3], str(int(d))
    forms = {
        iso,
        f"{y}{mo}{d}",
        f"{y}_{mo}_{d}",
        f"{y}.{mo}.{d}",
        f"{d}.{mo}.{y}",
        f"{d}/{mo}/{y}",
        f"{day} {month} {y}",
        f"{d} {month} {y}",
        f"{day} {mon} {y}",
        f"{d} {mon} {y}",
        f"{month} {day}, {y}",
        f"{mon} {day}, {y}",
        f"{month} {day} {y}",
        f"{mon} {day} {y}",
    }
    return sorted(forms, key=len, reverse=True)


def _contains_token(hay: str, needle: str) -> bool:
    """``needle`` in ``hay`` and not glued to more letters or digits on either side."""
    if not needle:
        return False
    at = hay.find(needle)
    while at >= 0:
        before = hay[at - 1] if at > 0 else " "
        end = at + len(needle)
        after = hay[end] if end < len(hay) else " "
        if not re.fullmatch(r"[a-z0-9]", before) and not re.fullmatch(r"[a-z0-9]", after):
            return True
        at = hay.find(needle, at + 1)
    return False


def _carries(layer: dict[str, Any], capture: dict[str, Any]) -> bool:
    texts = [str(layer.get("id", "")).lower(), str(layer.get("name", "")).lower()]
    cid = str(capture.get("id", "")).lower()
    if any(t == cid or _contains_token(t, cid) for t in texts):
        return True
    dates = date_spellings(str(capture.get("date", "")))
    return any(_contains_token(t, d) for t in texts for d in dates)


def layer_captures(manifest: dict[str, Any]) -> dict[str, str]:
    """The survey date each dated layer belongs to (layer id to capture id); absent layers are
    common to every date. Its own ``capture`` when it names a known capture, else, with two or
    more captures and a dated kind, the one capture whose id or date its id or name carries."""
    captures = [c for c in manifest.get("captures") or [] if isinstance(c, dict)]
    captures.sort(key=lambda c: str(c.get("date", "")))
    layers = [x for x in manifest.get("layers") or [] if isinstance(x, dict)]
    known = {str(c.get("id")) for c in captures}
    of: dict[str, str] = {}
    for layer in layers:
        own = layer.get("capture")
        if isinstance(own, str) and own in known:
            of[str(layer.get("id"))] = own
    if len(captures) > 1:
        for layer in layers:
            lid = str(layer.get("id"))
            if lid in of or layer.get("kind") not in DATED_KINDS:
                continue
            hits = [c for c in captures if _carries(layer, c)]
            if len(hits) == 1:
                of[lid] = str(hits[0].get("id"))
    return of


def _is_zero(s: Shift) -> bool:
    return abs(s[0]) <= ZERO_M and abs(s[1]) <= ZERO_M


def capture_shift(manifest: dict[str, Any], capture_id: str) -> Shift:
    """The shift a survey date carries, ``(0.0, 0.0)`` for none or an unknown date."""
    for c in manifest.get("captures") or []:
        if isinstance(c, dict) and c.get("id") == capture_id:
            up = c.get("lineUp")
            if isinstance(up, dict):
                s = (float(up.get("eastM", 0.0)), float(up.get("northM", 0.0)))
                return (0.0, 0.0) if _is_zero(s) else s
    return (0.0, 0.0)


def date_shift(manifest: dict[str, Any], layer_id: str) -> Shift:
    """The (east, north) metres a layer takes from its date; zero for none, a change result or an
    undated kind."""
    layer = next(
        (x for x in manifest.get("layers") or [] if isinstance(x, dict) and x.get("id") == layer_id),
        None,
    )
    if layer is None or layer.get("kind") not in DATED_KINDS:
        return (0.0, 0.0)
    derived = layer.get("derived")
    if isinstance(derived, dict) and derived.get("kind") == "change":
        return (0.0, 0.0)
    cid = layer_captures(manifest).get(layer_id)
    return capture_shift(manifest, cid) if cid is not None else (0.0, 0.0)


def local_delta(shift: Shift) -> Shift:
    """The shift in the local frame: ``(east, -north)``, for x and z."""
    return (shift[0], -shift[1])


_IDENTITY = [1.0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]


def shift_transform(t: list[float] | None, shift: Shift) -> list[float] | None:
    """A column-major 4x4 with the shift added to its translation (elements 12 and 14); ``t``
    comes back as it is for a zero shift."""
    if _is_zero(shift):
        return t
    out = list(t) if t is not None else list(_IDENTITY)
    dx, dz = local_delta(shift)
    out[12] += dx
    out[14] += dz
    return out
