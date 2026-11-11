"""What each survey date measured of its antennas (`telecom/history/<captureId>.json`, Wave 3 M2).

`telecom/antennas.json` holds one survey date and is not a record of what that date measured: the
re-run merge keeps an accepted unit's old geometry unless the new fit has more support, keeps the
units a person owns unchanged, and carries units it did not find into the new date. So that an
antenna's azimuth or downtilt can be read across dates, the commit also writes one record per date
(`aio.antenna-history/1`, in that date's own frame):

- one entry per unit this run measured (the merge gave it a new fit), under the merged unit's id,
  name and kind, with the values of this run's fit: box centre and extents, azimuth, downtilt and,
  when the fit has one, centre height. Units this run did not measure (not found, kept rejected,
  flagged and not found again) have no entry.
- `status` is the merged unit's and `reviewed` is false: whatever status it has was carried over
  from the earlier date (or is a fresh draft). A person's decision on that date makes it reviewed:
  when a run replaces an inventory of another date, the record of that date takes the statuses the
  person changed while it was live (`review_of`); the app does the same for the live date.
- a run on a date that already has a record keeps that record's reviewed entries (their status and
  `reviewed`), so running an earlier date again does not undo its review.

A date whose id is not a plain file name, or a run without a date, gets no record. The app links
the records into tracks at read time (`@aio/change` `antennaTracks`); nothing else reads them.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

HISTORY_DIR = "telecom/history"
HISTORY_SCHEMA = "aio.antenna-history/1"
VALUES = ("azimuthGridDeg", "downtiltDeg", "centreHeightM")
_SAFE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def capture_of(doc: dict[str, Any] | None) -> str | None:
    """The survey date an inventory names, when it is one a record can be filed under."""
    run = (doc or {}).get("run")
    cid = run.get("captureId") if isinstance(run, dict) else None
    return cid if isinstance(cid, str) and _SAFE.match(cid) and not cid.endswith(".") else None


def _value(u: dict[str, Any], key: str) -> float | None:
    v = u.get(key)
    if isinstance(v, dict) and isinstance(v.get("value"), int | float) and not isinstance(v["value"], bool):
        return float(v["value"])
    return None


def _units(doc: dict[str, Any] | None) -> list[dict[str, Any]]:
    return [
        u for u in ((doc or {}).get("units") or []) if isinstance(u, dict) and isinstance(u.get("id"), str)
    ]


def read_record(project: Path, capture: str) -> dict[str, Any] | None:
    """A date's record, or None when it is missing or not one."""
    p = project / HISTORY_DIR / f"{capture}.json"
    try:
        doc = json.loads(p.read_text("utf-8"))
    except (OSError, ValueError):
        return None
    return doc if isinstance(doc, dict) and doc.get("schema") == HISTORY_SCHEMA else None


def review_of(record: dict[str, Any], live: dict[str, Any] | None) -> dict[str, Any]:
    """The record with the decisions a person made while its date's inventory was live: an entry
    whose unit the person gave another status is reviewed, with that status."""
    status = {u["id"]: u.get("status") for u in _units(live)}
    out = []
    for e in _units(record):
        s = status.get(e["id"])
        if s in ("draft", "accepted", "rejected") and s != e.get("status"):
            e = {**e, "status": s, "reviewed": True}
        out.append(e)
    return {**record, "units": out}


def measured_record(
    merged: list[tuple[dict[str, Any], int | None]],
    units: list[dict[str, Any]],
    capture: str,
    run_id: str,
    at: str,
    existing: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """This run's record: one entry per unit it measured, with this run's fit."""
    kept = {e["id"]: e for e in _units(existing) if e.get("reviewed") is True}
    out: list[dict[str, Any]] = []
    for u, src in merged:
        if src is None or not isinstance(u.get("id"), str):
            continue
        fit = units[src]
        box = fit.get("box") or {}
        e: dict[str, Any] = {
            "id": u["id"],
            "name": u.get("name") or u["id"],
            "kind": u.get("kind") or fit.get("kind"),
            "status": u.get("status") or "draft",
            "reviewed": False,
            "centre": [float(v) for v in box.get("centre") or [0, 0, 0]],
            "extents": [float(v) for v in box.get("extents") or [0, 0, 0]],
        }
        for k in VALUES:
            v = _value(fit, k)
            if v is not None:
                e[k] = v
        prior = kept.get(u["id"])
        if prior is not None:
            e["status"] = prior.get("status", e["status"])
            e["reviewed"] = True
        out.append(e)
    return {"schema": HISTORY_SCHEMA, "captureId": capture, "runId": run_id, "at": at, "units": out}


def history_copies(
    project: Path,
    previous: dict[str, Any] | None,
    merged: list[tuple[dict[str, Any], int | None]],
    units: list[dict[str, Any]],
    new: dict[str, Any],
) -> list[tuple[str, dict[str, Any]]]:
    """The records a commit writes, as (project path, document): the replaced date's (with the
    person's review of it) first, then this run's."""
    out: list[tuple[str, dict[str, Any]]] = []
    now = capture_of(new)
    before = capture_of(previous)
    if previous is not None and before is not None and before != now:
        old = read_record(project, before)
        if old is not None:
            out.append((f"{HISTORY_DIR}/{before}.json", review_of(old, previous)))
    if now is not None:
        existing = read_record(project, now)
        if existing is not None and before == now:
            existing = review_of(existing, previous)
        run = new.get("run") or {}
        out.append(
            (
                f"{HISTORY_DIR}/{now}.json",
                measured_record(merged, units, now, str(run.get("id", "")), str(run.get("at", "")), existing),
            )
        )
    return out
