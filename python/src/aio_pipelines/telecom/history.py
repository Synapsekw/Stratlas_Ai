"""Per-date copies of the antenna inventory (`telecom/history/<captureId>.json`, Wave 3 M2).

`telecom/antennas.json` holds one survey date: a run on a new date moves the units into that date's
frame and replaces the file. So that an antenna's azimuth or downtilt can be read across dates, the
commit also keeps a copy per date, in the same `aio.antennas/1` shape and in that date's own frame:

- the inventory it replaces, when that names another date (`run.captureId`): the person's review of
  that date (accepted, rejected, typed values) is kept as it was left;
- the new inventory, under its own date, replaced by any later run on that date.

Copies carry no `crop` (crops follow the live inventory and may be removed). A date whose id is not
a plain file name, or a run without a date, gets no copy. The app links the units of the copies and
the live file into tracks at read time (`@aio/change` `antennaTracks`); nothing else reads them.
"""

from __future__ import annotations

import re
from typing import Any

HISTORY_DIR = "telecom/history"
_SAFE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def capture_of(doc: dict[str, Any] | None) -> str | None:
    """The survey date an inventory names, when it is one a copy can be filed under."""
    run = (doc or {}).get("run")
    cid = run.get("captureId") if isinstance(run, dict) else None
    return cid if isinstance(cid, str) and _SAFE.match(cid) and not cid.endswith(".") else None


def snapshot(doc: dict[str, Any]) -> dict[str, Any]:
    """The inventory without crop paths."""
    units = [
        {k: v for k, v in u.items() if k != "crop"} for u in doc.get("units") or [] if isinstance(u, dict)
    ]
    return {**doc, "units": units}


def history_copies(previous: dict[str, Any] | None, new: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    """The copies a commit writes, as (project path, document), the replaced date first."""
    out: list[tuple[str, dict[str, Any]]] = []
    now = capture_of(new)
    before = capture_of(previous)
    if previous is not None and before is not None and before != now:
        out.append((f"{HISTORY_DIR}/{before}.json", snapshot(previous)))
    if now is not None:
        out.append((f"{HISTORY_DIR}/{now}.json", snapshot(new)))
    return out
