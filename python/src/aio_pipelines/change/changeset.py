"""The change set file (``aio.change/1``) that every change pipeline writes.

One file per date pair and producer, ``<project>/change/<id>.json`` (data-conventions section 14;
the zod schema is ``@aio/schema`` ``change.ts``). Items carry ids the producer chooses so that a
recompute keeps the person's reviews: ``merge_reviews`` copies each ``review`` of the previous file
onto the item with the same id. ``write_change_set`` replaces the file atomically and keeps the
previous one as ``<id>.json.bak``; pipelines that stage their outputs use ``dump_change_set`` and
commit the staged file instead.

The checks here mirror the zod schema's main rules (schema, ids, the verdicts each kind may carry,
unique item ids, two different dates); the app validates the whole file again when it reads it.
"""

from __future__ import annotations

import json
import re
import shutil
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any

from ..runtime import JobError, atomic_write_bytes, now_iso

CHANGE_SCHEMA = "aio.change/1"
CHANGE_DIR = "change"
SET_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$")

#: The verdicts each kind of item may carry (``CHANGE_VERDICTS`` in ``change.ts``).
VERDICTS: dict[str, frozenset[str]] = {
    "issue": frozenset(
        {"new", "resolved", "not-seen", "grown", "shrunk", "worsened", "improved", "unchanged"}
    ),
    "detection": frozenset({"new", "resolved", "not-seen", "grown", "shrunk", "unchanged"}),
    "vector": frozenset({"added", "removed", "moved", "reshaped", "attributes", "unchanged"}),
    "region": frozenset({"added", "removed", "changed", "cut", "fill"}),
    "component": frozenset({"added", "removed", "moved", "changed", "unchanged"}),
    "frame": frozenset({"changed", "unchanged"}),
}
REVIEW_STATUS = frozenset({"open", "confirmed", "dismissed"})


def change_set_id(from_capture: str, to_capture: str, producer: str) -> str:
    """``c1-c2-raster`` for ``change.raster``: readable, file-name safe, stable per pair."""
    short = producer.split(".")[-1]
    raw = f"{from_capture}-{to_capture}-{short}"
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", raw).strip("-._")[:120]
    if not safe:
        raise JobError("A change set needs a name made of letters and digits.")
    return safe


def validate_change_set(data: Mapping[str, Any]) -> dict[str, Any]:
    """Check a change set; return it as a plain dict with ``layers`` and ``stats`` filled in."""
    if data.get("schema") != CHANGE_SCHEMA:
        raise JobError(f"A change set must say schema {CHANGE_SCHEMA}.")
    sid = data.get("id")
    if not isinstance(sid, str) or not SET_ID.match(sid):
        raise JobError(f'"{sid}" is not a valid change set id (a plain file name).')
    for key in ("from", "to", "producer", "createdAt"):
        if not isinstance(data.get(key), str) or not data[key]:
            raise JobError(f"The change set {sid} has no {key}.")
    if data["from"] == data["to"]:
        raise JobError(f"The change set {sid} compares {data['from']} with itself.")
    items = data.get("items")
    if not isinstance(items, list):
        raise JobError(f"The change set {sid} has no item list.")
    seen: set[str] = set()
    for i, item in enumerate(items):
        if not isinstance(item, Mapping):
            raise JobError(f"Item {i} of the change set {sid} is not an object.")
        iid, kind, verdict = item.get("id"), item.get("kind"), item.get("verdict")
        if not isinstance(iid, str) or not iid or len(iid) > 200:
            raise JobError(f"Item {i} of the change set {sid} has no valid id.")
        if iid in seen:
            raise JobError(f'The change set {sid} has the item id "{iid}" twice.')
        seen.add(iid)
        if kind not in VERDICTS:
            raise JobError(f'Item "{iid}" has an unknown kind "{kind}".')
        if verdict not in VERDICTS[kind]:
            raise JobError(f'Item "{iid}" ({kind}) cannot have the verdict "{verdict}".')
        review = item.get("review")
        if review is not None and (
            not isinstance(review, Mapping) or review.get("status") not in REVIEW_STATUS
        ):
            raise JobError(f'Item "{iid}" has an invalid review.')
    out = dict(data)
    out["items"] = [dict(it) for it in items]
    out.setdefault("layers", [])
    out.setdefault("stats", {})
    return out


def change_set(
    set_id: str,
    from_capture: str,
    to_capture: str,
    producer: str,
    items: Iterable[Mapping[str, Any]],
    *,
    layers: Iterable[str] = (),
    stats: Mapping[str, float] | None = None,
    run: Mapping[str, Any] | None = None,
    registration: Mapping[str, Any] | None = None,
    coverage: float | None = None,
    created_at: str | None = None,
) -> dict[str, Any]:
    """Build and check a change set."""
    data: dict[str, Any] = {
        "schema": CHANGE_SCHEMA,
        "id": set_id,
        "from": from_capture,
        "to": to_capture,
        "producer": producer,
        "createdAt": created_at or now_iso(),
        "items": [dict(it) for it in items],
        "layers": list(layers),
        "stats": dict(stats or {}),
    }
    if run is not None:
        data["run"] = dict(run)
    if registration is not None:
        data["registration"] = dict(registration)
    if coverage is not None:
        data["coverage"] = float(coverage)
    return validate_change_set(data)


def read_change_set(path: Path) -> dict[str, Any] | None:
    """The change set at ``path``, or None when there is none or it cannot be read."""
    try:
        text = path.read_text("utf-8-sig")
        return validate_change_set(json.loads(text))
    except (OSError, ValueError, JobError):
        return None


def merge_reviews(new: Mapping[str, Any], previous: Mapping[str, Any] | None) -> dict[str, Any]:
    """Copy each review of ``previous`` onto the item of ``new`` with the same id."""
    out = validate_change_set(new)
    if not previous:
        return out
    reviews = {
        it["id"]: it["review"]
        for it in previous.get("items", [])
        if isinstance(it, Mapping) and isinstance(it.get("id"), str) and it.get("review")
    }
    for it in out["items"]:
        if "review" not in it and it["id"] in reviews:
            it["review"] = reviews[it["id"]]
    return out


def dump_change_set(data: Mapping[str, Any]) -> bytes:
    return (json.dumps(validate_change_set(data), indent=1, ensure_ascii=False) + "\n").encode("utf-8")


def write_change_set(path: Path, data: Mapping[str, Any]) -> dict[str, Any]:
    """Write ``path`` atomically, keeping the reviews and a ``.bak`` of an earlier file."""
    previous = read_change_set(path) if path.exists() else None
    merged = merge_reviews(data, previous)
    if path.exists():
        shutil.copy2(path, path.with_name(path.name + ".bak"))
    atomic_write_bytes(path, dump_change_set(merged))
    return merged
