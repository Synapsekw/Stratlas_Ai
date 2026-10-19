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

import hashlib
import json
import re
import shutil
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any

from ..runtime import JobError, atomic_write_bytes, now_iso
from ..similarity import Similarity

CHANGE_SCHEMA = "aio.change/1"
CHANGE_DIR = "change"
SET_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$")
SCOPE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
SCOPE_NAME_MAX = 120
#: A date's line-up as a change set records it: an (east, north) shift or the whole similarity.
LineUp = tuple[float, float] | Similarity

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


def change_set_id(from_capture: str, to_capture: str, producer: str, scope_id: str | None = None) -> str:
    """``c1-c2-raster`` for ``change.raster``: readable, file-name safe, stable per pair.

    An area-scoped run adds ``-area-<scope id>``; past 120 characters the pair part is cut and a
    12-character hash of the scope id keeps two areas apart.
    """
    short = producer.split(".")[-1]
    raw = f"{from_capture}-{to_capture}-{short}"
    base = re.sub(r"[^A-Za-z0-9._-]+", "-", raw).strip("-._")
    if scope_id is None:
        safe = base[:120]
    else:
        if not SCOPE_ID.match(scope_id):
            raise ValueError(f'"{scope_id}" is not a valid scope id.')
        safe = f"{base}-area-{scope_id}"
        if len(safe) > 120:
            tag = hashlib.sha1(safe.encode("utf-8")).hexdigest()[:12]
            safe = f"{base[: 120 - 18]}-area-{tag}"
    if not safe:
        raise JobError("A change set needs a name made of letters and digits.")
    return safe


def _valid_scope(scope: Any) -> bool:
    return (
        isinstance(scope, Mapping)
        and isinstance(scope.get("id"), str)
        and bool(SCOPE_ID.match(scope["id"]))
        and isinstance(scope.get("name"), str)
        and 1 <= len(scope["name"]) <= SCOPE_NAME_MAX
    )


def check_scope(p: Mapping[str, Any]) -> dict[str, str] | None:
    """The ``scope`` of job params ``p`` (the area polygon's id and label), checked.

    A scope without a ``mask`` is refused: a scoped run is never a whole-map run.
    """
    scope = p.get("scope")
    if scope is None:
        return None
    if not _valid_scope(scope):
        raise JobError("scope must be { id, name } of the area polygon.")
    if p.get("mask") is None:
        raise JobError("A scoped run needs its mask (the area polygon).")
    return {"id": scope["id"], "name": scope["name"]}


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
    if "scope" in data and not _valid_scope(data["scope"]):
        raise JobError(f"The change set {sid} has an invalid scope.")
    missing = data.get("volumesMissing")
    if missing is not None and not (
        isinstance(missing, Mapping)
        and isinstance(missing.get("reason"), str)
        and missing["reason"]
        and isinstance(missing.get("at"), str)
    ):
        raise JobError(f"The change set {sid} has an invalid volumesMissing note.")
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
    line_up: tuple[LineUp, LineUp] | None = None,
    created_at: str | None = None,
    scope: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Build and check a change set.

    ``scope`` (``{ id, name }`` of the area polygon) marks a set made for one area only.

    ``line_up`` is the line-up of each date (``from``, ``to``) when it was computed: an (east,
    north) shift or a ``Similarity``. Written as ``lineUp`` only when either is not zero, so the
    app can tell a set made before a later line-up. A date's turn and scale go beside it, in
    ``lineUpTurn`` (``lineUp`` is a strict object), for the dates that have one.
    """
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
    if scope is not None:
        data["scope"] = {"id": scope["id"], "name": scope["name"]}
    if run is not None:
        data["run"] = dict(run)
    if registration is not None:
        data["registration"] = dict(registration)
    if coverage is not None:
        data["coverage"] = float(coverage)
    if line_up is not None:
        sims = [s if isinstance(s, Similarity) else Similarity(float(s[0]), float(s[1])) for s in line_up]
        if not all(s.is_identity() for s in sims):
            data["lineUp"] = {
                k: _metres((s.east_m, s.north_m)) for k, s in zip(("from", "to"), sims, strict=True)
            }
            turns = {k: s.to_turn() for k, s in zip(("from", "to"), sims, strict=True)}
            if any(turns.values()):
                data["lineUpTurn"] = {k: t for k, t in turns.items() if t}
    return validate_change_set(data)


def _metres(shift: tuple[float, float]) -> dict[str, float]:
    # + 0.0: never a "-0.0" in the file
    return {"eastM": round(float(shift[0]), 3) + 0.0, "northM": round(float(shift[1]), 3) + 0.0}


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
