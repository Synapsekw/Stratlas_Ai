"""Findings from Flyability Inspector points of interest, and the merge that keeps user edits.

One finding per POI. The severity is the worst of its snapshots, the category comes from the tags,
and every snapshot becomes photo sightings. The cloud sighting is the worst snapshot's scene point
(a snapshot whose camera pose is not valid is never placed). `merge_issues` mirrors the TypeScript
`mergeImportedIssues` with `keepMissing` (packages/project/src/import/keep.ts).
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

from aio_pipelines.flyability.export import Poi, Snapshot
from aio_pipelines.flyability.frames import location_check

SEVERITY = {"Low": 1, "Medium": 2, "High": 3, "Critical": 4}

AUTHOR = "Flyability Inspector"
DEFAULT_CLASS = "finding"


@dataclass
class FindingContext:
    """What `build_issue` needs from the import job.

    `hit_m` is the cast distance (m) from each snapshot's camera to the cloud (nan = no hit) and
    `scene_point` the scene-frame point to pin (None = none). `existing_codes` maps issue id to
    issue code for every code in use; `build_issue` adds the codes it hands out. `phase_start_us`
    is the flight's `time_sync.phase_start_time` (flight id to microseconds), `flight_datetime`
    its `datetime_utc` (seconds); both are needed for a capture time. `now` is the import time
    (ISO, `...Z`).
    """

    hit_m: dict[str, float]
    scene_point: dict[str, list[float] | None]
    cloud_layer: str
    photos_layer: str
    severity_model_id: str
    now: str
    existing_codes: dict[str, str] = field(default_factory=dict)
    class_of: dict[str, str] = field(default_factory=dict)  # POI id to class id (category_classes)
    flight_datetime: dict[str, int] = field(default_factory=dict)
    phase_start_us: dict[str, int] = field(default_factory=dict)


def worst(snapshots: list[Snapshot]) -> int | Literal["uncertain"]:
    """The highest rated severity among the snapshots; `'uncertain'` when none is rated."""
    rated = [SEVERITY[s.criticality] for s in snapshots if s.criticality in SEVERITY]
    return max(rated) if rated else "uncertain"


def _slug(tag: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", tag.lower()).strip("-")


def _tags(poi: Poi) -> list[str]:
    tags = [t for t in poi.tags if _slug(t)]
    if tags:
        return tags
    seen: list[str] = []
    for s in poi.snapshots:
        for t in s.tags:
            if _slug(t) and t not in seen:
                seen.append(t)
    return seen


def category_classes(pois: list[Poi], catalogue: dict) -> tuple[dict, dict[str, str]]:
    """Add one class per distinct tag (`{id: slug, label: tag}`, keyed by id) to the catalogue.

    A POI's class is its first tag (the POI's own tags, else its snapshots'), `'finding'` when it
    has none. An id already in the catalogue is kept as it is.
    """
    by_poi: dict[str, str] = {}
    for poi in pois:
        tags = _tags(poi)
        for tag in tags:
            catalogue.setdefault(_slug(tag), {"id": _slug(tag), "label": tag})
        by_poi[poi.id] = _slug(tags[0]) if tags else DEFAULT_CLASS
    return catalogue, by_poi


def _next_code(used: dict[str, str]) -> str:
    top = 0
    for code in used.values():
        m = re.fullmatch(r"F(\d+)", code)
        if m:
            top = max(top, int(m.group(1)))
    return f"F{top + 1:02d}"


def _box(w: float, h: float) -> dict[str, Any]:
    return {"type": "box", "x": 0, "y": 0, "w": w, "h": h}


def _iso(seconds: float) -> str:
    return datetime.fromtimestamp(seconds, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _finite(v: float | None) -> float | None:
    return v if v is not None and math.isfinite(v) else None


def build_issue(poi: Poi, ctx: FindingContext) -> dict[str, Any]:
    snaps = poi.snapshots
    severity = worst(snaps)
    # the worst snapshot (the first when none is rated or on a tie)
    top = max(snaps, key=lambda s: SEVERITY.get(s.criticality or "", 0)) if snaps else None

    issue_id = f"fly-{poi.id}"
    code = ctx.existing_codes.get(issue_id)
    if code is None:
        code = _next_code(ctx.existing_codes)
        ctx.existing_codes[issue_id] = code

    comments = [s.comment.strip() for s in snaps if s.comment.strip()]
    title = comments[0] if comments else (poi.description.strip() or poi.name.strip() or poi.id)
    note = "\n".join(x for x in [poi.name.strip(), poi.description.strip(), *comments] if x)

    sightings: list[dict[str, Any]] = []
    # (1) the cloud point: the worst snapshot's, else the first placed one; never from a bad pose
    placed = [s for s in ([top] if top else []) + snaps if s.pose_valid and ctx.scene_point.get(s.id)]
    if placed:
        sightings.append(
            {
                "on": "pointcloud",
                "layer": ctx.cloud_layer,
                "geom": {"type": "point3", "p": list(ctx.scene_point[placed[0].id] or [])},
            }
        )
    # (2) the annotation points of each photo (a whole-image box without any)
    for s in snaps:
        if s.photo is None or s.image_size is None:
            continue
        w, h = s.image_size
        if s.points:
            for nx, ny, _ in s.points:
                geom = {"type": "point", "x": nx * w, "y": ny * h}
                sightings.append({"on": "image", "layer": ctx.photos_layer, "photo": s.id, "geom": geom})
        else:
            sightings.append({"on": "image", "layer": ctx.photos_layer, "photo": s.id, "geom": _box(w, h)})
    # (3) the annotated image of each snapshot
    for s in snaps:
        if s.annotated is None or s.image_size is None:
            continue
        sightings.append(
            {
                "on": "image",
                "layer": ctx.photos_layer,
                "photo": f"{s.id}-annotated",
                "geom": _box(*s.image_size),
            }
        )

    external: dict[str, Any] = {"source": "flyability", "poi": poi.id, "snapshots": [s.id for s in snaps]}
    hit = wall = None
    check: str = "unchecked"
    if top is not None:
        wall = top.wall_distance
        if top.flight_id:
            external["flight"] = top.flight_id
        start, stamp = ctx.phase_start_us.get(top.flight_id), ctx.flight_datetime.get(top.flight_id)
        if start is not None and stamp is not None:
            external["capturedAt"] = _iso(stamp + (top.time_us - start) / 1e6)
        if top.pose_valid:
            raw = ctx.hit_m.get(top.id, math.nan)
            check = location_check(raw, wall)
            hit = _finite(raw)
    external.update({"wallDistanceM": wall, "hitDistanceM": hit, "locationCheck": check})

    return {
        "id": issue_id,
        "code": code,
        "classId": ctx.class_of.get(poi.id, DEFAULT_CLASS),
        "severityModelId": ctx.severity_model_id,
        "severity": severity,
        "status": "draft",
        "title": title,
        "note": note,
        "author": AUTHOR,
        "createdAt": ctx.now,
        "updatedAt": ctx.now,
        "sightings": sightings,
        "source": "import",
        "external": external,
    }


def _untouched(i: dict[str, Any]) -> bool:
    return i.get("source") == "import" and i.get("updatedAt") == i.get("createdAt")


def merge_issues(existing: list[dict], imported: list[dict]) -> tuple[list[dict], dict[str, int]]:
    """Merge a fresh import into the saved issues by id, keeping every edit and every saved issue.

    The imported issues in import order, each replaced by the saved issue with the same id unless
    that one is an untouched import; then every saved issue the import does not have, in saved
    order. A repeated saved id keeps the first position with the last content (as a JS Map does).
    """
    saved: dict[str, dict] = {}
    for raw in existing:
        if isinstance(raw, dict) and isinstance(raw.get("id"), str) and raw["id"]:
            saved[raw["id"]] = raw
    counts = {"added": 0, "refreshed": 0, "kept_edited": 0, "kept_missing": 0}
    out: list[dict] = []
    for i in imported:
        s = saved.get(i["id"])
        if s is None:
            counts["added"] += 1
            out.append(i)
        elif _untouched(s):
            counts["refreshed"] += 1
            out.append(i)
        else:
            counts["kept_edited"] += 1
            out.append(s)
    ids = {i["id"] for i in imported}
    for sid, s in saved.items():
        if sid not in ids:
            counts["kept_missing"] += 1
            out.append(s)
    return out, counts
