"""Kit defect groups -> ``aio.issues/1`` issues, merged into the project's issues by stable ids.

One issue per kit defect (``records.build``: placed findings of the same class within
``cluster_m`` of each other; an unplaced finding is a defect of its own). The issue carries a
mesh sighting (surface point and normal of the group's medoid, in the project local frame) and
one image sighting (the box) per detection.

Merging (``merge``), so a run never loses anyone's work:
- Every issue already in ``issues.json`` is kept. Issues the pipeline did not make are never
  touched.
- ``<out>/issues-map.json`` remembers, for each issue the pipeline wrote, its detection ids and a
  hash of the issue as written. A new group takes over the earlier issue it shares detections
  with (or whose id it would get), keeping that issue's id, code and creation time.
- An issue a person changed since (hash differs: edited, reviewed, moved) is left exactly as it is.
- An earlier pipeline issue no detection backs any more stays in place for review.
- Detections a person already accepted into an issue in the review (``issueId``) are not grouped
  into issues of their own (``links``): their placement is added to that issue as a mesh sighting
  when it has none, and nothing else of it changes. An issue that no longer exists is not made again.
New issues get the next free ``D`` codes, top of the asset first, like the kit's defect ids.
"""

from __future__ import annotations

import hashlib
import json
import math
from datetime import UTC, datetime
from typing import Any

MAP_SCHEMA = "aio.inspection-issues/1"
AUTHOR = "Inspection pipeline"
NO_SIDE = "—"


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def _norm(v: Any) -> Any:
    """Numbers as JavaScript writes them (1.0 -> 1), rounded to 6 decimals, so app saves hash alike."""
    if isinstance(v, bool) or v is None or isinstance(v, str):
        return v
    if isinstance(v, int | float):
        f = round(float(v), 6)
        return int(f) if f.is_integer() else f
    if isinstance(v, dict):
        return {k: _norm(x) for k, x in v.items() if x is not None}
    if isinstance(v, list | tuple):
        return [_norm(x) for x in v]
    return v


def issue_hash(issue: dict[str, Any]) -> str:
    blob = json.dumps(_norm(issue), sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:24]


def _same_but_time(a: dict[str, Any], b: dict[str, Any]) -> bool:
    strip = ("updatedAt", "createdAt", "code")
    return issue_hash({k: v for k, v in a.items() if k not in strip}) == issue_hash(
        {k: v for k, v in b.items() if k not in strip}
    )


def _r(v, n=4):
    return [round(float(x), n) for x in v]


def proposals(R, meta, cat, frame, cams, layer_of, out: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """Issues (without id and code yet) from the kit records ``R``, one per defect, top first.

    ``meta``: detection id -> {source, uncertain, camera}; ``cams``: camera id -> {layer, photo};
    ``layer_of(kit_points)`` -> mesh layer id per point.
    """
    groups: dict[str, list[dict[str, Any]]] = {}
    for f in R["findings"]:
        if meta[f["key"]].get("issueId"):
            continue  # accepted into an issue in the review: see links()
        groups.setdefault(f.get("defect") or f["key"], []).append(f)

    def rank(kv):  # kit defect ids D01, D02 ... number the groups from the top down
        d = kv[0]
        return (0, int(d[1:]), d) if d[:1] == "D" and d[1:].isdigit() else (1, 0, d)

    order = sorted(groups.items(), key=rank)
    medoids = []
    for _, g in order:
        placed = [f for f in g if f.get("center") is not None]
        if placed:
            c = [sum(f["center"][i] for f in placed) / len(placed) for i in range(3)]
            medoids.append(min(placed, key=lambda f: (math.dist(f["center"], c), f["key"])))
        else:
            medoids.append(None)
    layers = layer_of([m["center"] for m in medoids if m is not None]) if any(medoids) else []
    li = iter(layers)
    out_list = []
    for (defect, g), med in zip(order, medoids, strict=True):
        cls = g[0]["class"]
        model = cat.model_of(cls)
        graded = [f["severity"] for f in g if not meta[f["key"]]["uncertain"]]
        if graded:
            severity: int | str = max(graded)
        else:
            severity = "uncertain" if model.get("uncertain") else min(f["severity"] for f in g)
        sightings: list[dict[str, Any]] = []
        if med is not None:
            n = frame.dir_to_local(med["normal"]) if med.get("normal") else [0, 1, 0]
            sightings.append(
                {
                    "on": "mesh",
                    "layer": next(li),
                    "geom": {"type": "spoint", "p": _r(frame.to_local(med["center"])), "n": _r(n)},
                }
            )
        for f in sorted(g, key=lambda f: (f["photo"], f["key"])):
            cam = cams[f["photo"]]
            x0, y0, x1, y1 = f["bbox"]
            sightings.append(
                {
                    "on": "image",
                    "layer": cam["layer"],
                    "photo": cam["photo"],
                    "geom": {
                        "type": "box",
                        "x": round(x0, 1),
                        "y": round(y0, 1),
                        "w": round(max(0.1, x1 - x0), 1),
                        "h": round(max(0.1, y1 - y0), 1),
                    },
                }
            )
        top = max(g, key=lambda f: f["height"])
        label = cat.classes[cls]["label"]
        where = top["component"] or top["zoneLabel"]
        notes: list[str] = []
        for f in g:
            n = (f.get("note") or "").strip()
            if n and not n.endswith((".", "!", "?")):
                n += "."
            if n and n not in notes:
                notes.append(n)
        photos = len({f["photo"] for f in g})
        pos = f"About {top['height']:.1f} m up" + ("" if top["side"] == NO_SIDE else f", {top['side']} side")
        seen = f"Seen in {photos} photo{'s' if photos != 1 else ''}"
        placed_txt = "." if med is not None else ", not placed on the model."
        notes.append(f"{seen}{placed_txt} {pos}, {top['zoneLabel']}.")
        sources = {meta[f["key"]]["source"] for f in g}
        out_list.append(
            {
                "defect": defect,
                "detections": sorted(f["key"] for f in g),
                "classId": cls,
                "severityModelId": model["id"],
                "severity": severity,
                "title": f"{label}, {where}",
                "note": " ".join(notes),
                "sightings": sightings,
                "source": "agent" if sources & {"ai", "model"} else "import",
            }
        )
    return out_list


def links(R, meta, frame, layer_of) -> list[dict[str, Any]]:
    """Placements of detections accepted into an issue in the review, one per issue.

    Each: ``{"issueId", "detections", "mesh"}`` with the mesh sighting at the medoid of the issue's
    placed detections, or ``mesh: None`` when none was placed.
    """
    by_issue: dict[str, list[dict[str, Any]]] = {}
    for f in R["findings"]:
        iid = meta[f["key"]].get("issueId")
        if iid:
            by_issue.setdefault(iid, []).append(f)
    out = []
    for iid in sorted(by_issue):
        g = by_issue[iid]
        placed = [f for f in g if f.get("center") is not None]
        mesh = None
        if placed:
            c = [sum(f["center"][i] for f in placed) / len(placed) for i in range(3)]
            med = min(placed, key=lambda f: (math.dist(f["center"], c), f["key"]))
            n = frame.dir_to_local(med["normal"]) if med.get("normal") else [0, 1, 0]
            mesh = {
                "on": "mesh",
                "layer": layer_of([med["center"]])[0],
                "geom": {"type": "spoint", "p": _r(frame.to_local(med["center"])), "n": _r(n)},
            }
        out.append({"issueId": iid, "detections": sorted(f["key"] for f in g), "mesh": mesh})
    return out


def _new_id(detections: list[str], taken: set[str]) -> str:
    base = "insp-" + hashlib.sha1(min(detections).encode("utf-8")).hexdigest()[:10]
    out, n = base, 2
    while out in taken:
        out = f"{base}-{n}"
        n += 1
    return out


def _next_code(used: set[str]) -> str:
    n = 1
    while True:
        code = f"D{n:02d}"
        if code not in used:
            used.add(code)
            return code
        n += 1


def merge(
    current: list[dict[str, Any]],
    old_map: dict[str, Any] | None,
    props: list[dict[str, Any]],
    stamp: str,
    linked: list[dict[str, Any]] | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any], dict[str, int]]:
    """Merge proposals into the current issues. Returns (issues, new map, counts)."""
    entries: dict[str, Any] = dict((old_map or {}).get("issues") or {})
    by_id = {i["id"]: i for i in current}
    used_codes = {i.get("code") for i in current}
    claimed: set[str] = set()
    result = {i["id"]: i for i in current}  # everything already there stays
    order = [i["id"] for i in current]
    counts = {"new": 0, "updated": 0, "unchanged": 0, "kept_edited": 0, "stale": 0, "user": 0,
              "linked": 0, "placed": 0, "orphaned": 0}  # fmt: skip
    for link in linked or []:
        issue = result.get(link["issueId"])
        if issue is None:
            counts["orphaned"] += 1  # deleted after the review accepted it: not made again
            continue
        counts["linked"] += 1
        if link.get("mesh") and not any(s.get("on") == "mesh" for s in issue.get("sightings", [])):
            sightings = [*issue.get("sightings", []), link["mesh"]]
            result[issue["id"]] = {**issue, "sightings": sightings, "updatedAt": stamp}
            counts["placed"] += 1
    new_entries: dict[str, Any] = {}

    for p in props:
        dets = set(p["detections"])
        # the earlier pipeline issue sharing most detections, else the one with this group's id
        best, overlap = None, 0
        for iid, e in entries.items():
            if iid in claimed or iid not in by_id:
                continue
            k = len(dets & set(e.get("detections") or []))
            if k > overlap or (k == overlap and k > 0 and best is not None and iid < best):
                best, overlap = iid, k
        candidate = _new_id(p["detections"], set())
        if best is None and candidate in by_id and candidate not in claimed:
            best = candidate
        body = {k: v for k, v in p.items() if k not in ("defect", "detections")}
        if best is not None:
            claimed.add(best)
            old = by_id[best]
            proposed = {
                "id": best,
                "code": old.get("code"),
                **body,
                "status": "draft",
                "author": AUTHOR,
                "createdAt": old.get("createdAt") or stamp,
                "updatedAt": old.get("updatedAt") or stamp,
            }
            e = entries.get(best) or {}
            untouched = e.get("hash") == issue_hash(old) or _same_but_time(old, proposed)
            if not untouched:
                counts["kept_edited"] += 1
                new_entries[best] = {"detections": p["detections"], "hash": e.get("hash")}
                continue
            if _same_but_time(old, proposed):
                counts["unchanged"] += 1
                result[best] = old
            else:
                proposed["updatedAt"] = stamp
                result[best] = proposed
                counts["updated"] += 1
            new_entries[best] = {"detections": p["detections"], "hash": issue_hash(result[best])}
            continue
        iid = _new_id(p["detections"], set(by_id) | set(result))
        issue = {
            "id": iid,
            "code": _next_code(used_codes),
            **body,
            "status": "draft",
            "author": AUTHOR,
            "createdAt": stamp,
            "updatedAt": stamp,
        }
        result[iid] = issue
        order.append(iid)
        counts["new"] += 1
        new_entries[iid] = {"detections": p["detections"], "hash": issue_hash(issue)}

    for iid, e in entries.items():
        if iid in new_entries:
            continue
        if iid in by_id:
            counts["stale"] += 1  # kept: a person decides what happens to it
        new_entries[iid] = e
    counts["user"] = sum(1 for i in current if i["id"] not in new_entries)
    issues = [result[i] for i in order]
    return issues, {"schema": MAP_SCHEMA, "issues": new_entries}, counts
