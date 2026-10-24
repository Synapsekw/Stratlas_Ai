"""Re-run merge: a new run's units against the inventory the person may already have reviewed.

Spec section 5. A new unit matches an old one when their box centres are within `MATCH_RADIUS_M`
and either the kinds are equal or the old kind came from AI or a person (`kindBasis` "ai" or
"user": a relabelled unit matches whatever the geometry calls it now). Pairs are taken nearest
first, each unit at most once.

- A person-owned unit is one a person flagged (`origin` "flagged") or one with a typed geometry
  value (`basis` "user"; see `person_owned`). It matches whatever kind the new unit has. Matched,
  in any status, it is kept unchanged (the new unit is absorbed) except `photos` and `crop`, which
  refresh, and `notFoundInLatest`, which goes. Unmatched, in any status, it is kept: a flagged one
  is never marked not found; a detected accepted one is marked as below; a detected draft or
  rejected one stays unmarked.
- Matched accepted: keeps its id, name, status, user fields and a non-geometry kind; takes the new
  geometry only when the new fit has more support.
- Matched rejected: kept unchanged.
- Matched draft: new geometry, old id, name, user fields and non-geometry kind.
- Unmatched old accepted: kept, flagged `notFoundInLatest`. Unmatched old drafts and rejected
  units that are not person-owned are dropped (a rejected unit that is not found again has nothing left to reject).
- Deleted antennas: a new find whose box centre lies within `MATCH_RADIUS_M` of a deletion record's box
  centre (any kind) is dropped, so a unit the person deleted does not come back as a draft. Old units
  win: a find an old unit absorbs is never tested against the records.
- New units are drafts named `A<n>` after the highest number in use, numbered clockwise from north
  around the units' middle, with ids `ant-<run>-<k>`.

Units are stored in their own survey date's frame. When the previous file came from another date,
`in_capture_frame` first moves its units into the new date's frame (`date_frame_delta`), so the
match compares one frame and the merged file is entirely in the new date's frame.
"""

from __future__ import annotations

import math
import re
from collections.abc import Sequence

from ..captures import local_delta

MATCH_RADIUS_M = 0.3
#: Fields a run measures; the rest (id, name, status, kind from AI or a person, user) is review.
GEOMETRY = (
    "box",
    "support",
    "azimuthGridDeg",
    "downtiltDeg",
    "plumbDeg",
    "elevationDeg",
    "diameterM",
    "widthM",
    "heightM",
    "depthM",
    "convergenceDeg",
    "centreHeightM",
)
#: The measured values a person can type over (and a flagged unit can carry).
GEOMETRY_VALUES = (
    "azimuthGridDeg",
    "downtiltDeg",
    "plumbDeg",
    "elevationDeg",
    "diameterM",
    "widthM",
    "heightM",
    "depthM",
    "centreHeightM",
)
ID_MAX = 60  # characters after "ant-" (the unit id pattern ^ant-[a-z0-9-]{1,60}$)
_NAME = re.compile(r"^A(\d+)$")


def date_frame_delta(
    previous_shift: tuple[float, float], new_shift: tuple[float, float]
) -> tuple[float, float]:
    """The (east, north) metres that move a point stored in the previous date's own frame into the
    new date's own frame. A point P drawn lined up is stored as P minus its date's shift, so the
    move is the previous shift minus the new one, taken through `captures.local_delta` (x east,
    z south) like every other line-up."""
    ax, az = local_delta(previous_shift)
    bx, bz = local_delta(new_shift)
    dx, dz = ax - bx, az - bz
    return dx + 0.0, -dz + 0.0


def in_capture_frame(previous: dict | None, delta_en: tuple[float, float]) -> dict | None:
    """`previous` with each unit's box centre moved by `delta_en` (east, north); unchanged for a
    zero move. The units are copies: the caller's file is not changed."""
    if previous is None or (not delta_en[0] and not delta_en[1]):
        return previous
    units = []
    for u in previous.get("units") or []:
        if isinstance(u, dict) and isinstance(u.get("box"), dict) and u["box"].get("centre") is not None:
            e, n, z = _centre(u)
            centre = [round(e + delta_en[0], 3) + 0.0, round(n + delta_en[1], 3) + 0.0, z]
            u = {**u, "box": {**u["box"], "centre": centre}}
        units.append(u)
    return {**previous, "units": units}


def _centre(u: dict) -> tuple[float, float, float]:
    c = u["box"]["centre"]
    return float(c[0]), float(c[1]), float(c[2])


def _distance(a: dict, b: dict) -> float:
    return math.dist(_centre(a), _centre(b))


def _relabelled(u: dict) -> bool:
    return u.get("kindBasis") in ("ai", "user")


def person_owned(u: dict) -> bool:
    """A unit a person flagged, or one with a value a person typed: a re-run never overwrites it."""
    if u.get("origin") == "flagged":
        return True
    return any(isinstance(u.get(k), dict) and u[k].get("basis") == "user" for k in GEOMETRY_VALUES)


def next_name(units: list[dict]) -> str:
    """`A<n+1>` after the highest `A<n>` among the units' names (`A1` when none)."""
    top = max((int(m.group(1)) for u in units if (m := _NAME.match(str(u.get("name", ""))))), default=0)
    return f"A{top + 1}"


def _with_geometry(old: dict, new: dict) -> dict:
    """`old` with every geometry field of `new` (fields `new` lacks are removed)."""
    out = {k: v for k, v in old.items() if k not in GEOMETRY}
    out.update({k: new[k] for k in GEOMETRY if k in new})
    if not _relabelled(old):
        out["kind"], out["kindBasis"] = new["kind"], "geometry"
    out["runId"] = new["runId"]
    return out


def _take_photos(out: dict, new: dict) -> None:
    """The new run's photos (and crop) when it found any; else the unit keeps its own."""
    if new.get("photos"):
        out["photos"] = new["photos"]
        if "crop" in new:
            out["crop"] = new["crop"]
        else:
            out.pop("crop", None)


def _pairs(old: list[dict], new: list[dict]) -> dict[int, int]:
    """new index -> old index, nearest pairs first."""
    cand = []
    for i, n in enumerate(new):
        for j, o in enumerate(old):
            d = _distance(n, o)
            if d <= MATCH_RADIUS_M and (o.get("kind") == n.get("kind") or _relabelled(o) or person_owned(o)):
                cand.append((d, i, j))
    cand.sort()
    taken_new: set[int] = set()
    taken_old: set[int] = set()
    out: dict[int, int] = {}
    for _, i, j in cand:
        if i in taken_new or j in taken_old:
            continue
        taken_new.add(i)
        taken_old.add(j)
        out[i] = j
    return out


def _clockwise(units: list[dict]) -> list[int]:
    """Indices of `units` clockwise from north around the middle of their centres (E, N)."""
    if not units:
        return []
    me = sum(_centre(u)[0] for u in units) / len(units)
    mn = sum(_centre(u)[1] for u in units) / len(units)

    def key(i: int) -> tuple[float, float]:
        e, n, z = _centre(units[i])
        bearing = math.degrees(math.atan2(e - me, n - mn)) % 360.0
        return round(bearing, 6), -z

    return sorted(range(len(units)), key=key)


def merge_with_sources(
    previous: dict | None, units: list[dict], run_id: str, deletions: Sequence[dict] = ()
) -> list[tuple[dict, int | None]]:
    """Like `merge_runs`, each unit with the index of the new unit it came from (None for an old
    unit that took nothing from this run: kept unmatched, or matched while rejected)."""
    old = [u for u in ((previous or {}).get("units") or []) if isinstance(u, dict) and "box" in u]
    pairs = _pairs(old, units)
    matched_old = set(pairs.values())
    out: list[tuple[dict, int | None]] = []
    # old units first, in their order: a reviewed inventory keeps its order
    by_old = {j: i for i, j in pairs.items()}
    for j, o in enumerate(old):
        status = o.get("status")
        owned = person_owned(o)
        if j not in matched_old:
            if owned and o.get("origin") == "flagged":
                u = dict(o)
                u.pop("notFoundInLatest", None)
                out.append((u, None))
            elif status == "accepted":
                out.append(({**o, "notFoundInLatest": True}, None))
            elif owned:
                u = dict(o)
                u.pop("notFoundInLatest", None)
                out.append((u, None))
            continue
        i = by_old[j]
        n = units[i]
        if owned:
            u = dict(o)
            u.pop("notFoundInLatest", None)
            _take_photos(u, n)
            out.append((u, i))
            continue
        if status == "rejected":
            u = dict(o)
            u.pop("notFoundInLatest", None)
            out.append((u, None))
            continue
        if status == "accepted" and not int(n.get("support", 0)) > int(o.get("support", 0)):
            u = dict(o)
        else:
            u = _with_geometry(o, n)
        u.pop("notFoundInLatest", None)
        _take_photos(u, n)
        out.append((u, i))
    # new units: drafts, numbered clockwise
    used_ids = {u["id"] for u, _ in out}
    top = int(next_name([u for u, _ in out])[1:]) - 1
    fresh = [
        i
        for i in range(len(units))
        if i not in pairs and not any(_distance(units[i], d) <= MATCH_RADIUS_M for d in deletions)
    ]
    order = _clockwise([units[i] for i in fresh])
    stem = run_id[4:] if run_id.startswith("run-") else run_id
    k = 0
    for rank, pos in enumerate(order):
        i = fresh[pos]
        while True:
            k += 1
            tail = f"-{k}"
            uid = f"ant-{stem[: ID_MAX - len(tail)]}{tail}"
            if uid not in used_ids:
                break
        used_ids.add(uid)
        u = {**units[i], "id": uid, "name": f"A{top + rank + 1}", "status": "draft"}
        u.pop("notFoundInLatest", None)
        out.append((u, i))
    return out


def merge_runs(
    previous: dict | None, units: list[dict], run_id: str, deletions: Sequence[dict] = ()
) -> list[dict]:
    """The inventory after a run: `previous` (the antennas file, or None) merged with `units` (the
    new run's units, with every field but `id`, `name` and `status`). `deletions` are the records
    of antennas the person deleted (each with a `box`). See the module docstring."""
    return [u for u, _ in merge_with_sources(previous, units, run_id, deletions)]
