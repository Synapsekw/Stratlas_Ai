"""Flyability findings: one per POI, worst severity, tags, sightings, location check, merge."""

from __future__ import annotations

import copy
import dataclasses
import math
import re
from pathlib import Path

import numpy as np
import pytest

from aio_pipelines.flyability.export import read_export
from aio_pipelines.flyability.findings import (
    SEVERITY,
    FindingContext,
    build_issue,
    category_classes,
    merge_issues,
    worst,
)
from aio_pipelines.flyability.frames import to_scene, view_axis
from flyability_synth import SynthExport, make_export

NOW = "2026-10-31T12:00:00Z"


def _setup(tmp_path: Path, generation: str = "2025"):
    syn = make_export(tmp_path / "x", generation=generation)  # type: ignore[arg-type]
    pois = read_export(syn.root).inspections[0].pois
    return syn, pois


def _context(syn: SynthExport, pois, classes=None) -> FindingContext:
    hit_m: dict[str, float] = {}
    scene: dict[str, list[float] | None] = {}
    for poi in pois:
        for s in poi.snapshots:
            cam = np.array(syn.camera_position[s.id])
            hit = syn.hit[s.id]
            if hit is None:
                hit_m[s.id] = math.nan
                # the view axis is in the inspection frame for flight A; P3 is flight A
                pt = cam + 1.0 * view_axis(s.camera_q)
            else:
                hit_m[s.id] = float(np.linalg.norm(np.array(hit) - cam))
                pt = np.array(hit)
            scene[s.id] = [float(v) for v in to_scene(pt)]
    return FindingContext(
        hit_m=hit_m,
        scene_point=scene,
        hit_layer={sid: f"cloud-{syn.flight_ids.index(fid)}" for sid, fid in syn.snapshot_flight.items()},
        photos_layer="photos-1",
        severity_model_id="sev-1",
        now=NOW,
        class_of=classes or {},
        flight_datetime={f: 1732600000 + 100 * i for i, f in enumerate(syn.flight_ids)},
        phase_start_us={f: 20_000_000 for f in syn.flight_ids},
    )


def _catalogue() -> dict:
    return {"id": "c", "name": "Confined space", "assetType": "confined-space", "classes": []}


def _issues(tmp_path: Path, generation: str = "2025"):
    syn, pois = _setup(tmp_path, generation)
    cat, classes = category_classes(pois, _catalogue())
    ctx = _context(syn, pois, classes)
    return syn, pois, cat, [build_issue(p, ctx) for p in pois]


def test_one_finding_per_poi(tmp_path: Path) -> None:
    syn, pois, _, issues = _issues(tmp_path)
    assert [i["id"] for i in issues] == [f"fly-{p}" for p in syn.poi_ids]
    assert [i["code"] for i in issues] == ["F01", "F02", "F03"]
    p2 = issues[1]
    assert p2["severity"] == 4  # Critical beats Low
    assert p2["external"]["snapshots"] == syn.snapshot_ids[1:3]
    assert {s["photo"] for s in p2["sightings"] if s["on"] == "image"} == {
        syn.snapshot_ids[1],
        syn.snapshot_ids[2],
        f"{syn.snapshot_ids[1]}-annotated",
        f"{syn.snapshot_ids[2]}-annotated",
    }
    assert SEVERITY == {"Low": 1, "Medium": 2, "High": 3, "Critical": 4}
    assert issues[0]["severity"] == 3
    assert issues[0]["createdAt"] == issues[0]["updatedAt"] == NOW
    assert issues[0]["source"] == "import" and issues[0]["author"] == "Flyability Inspector"
    assert issues[0]["title"] == "finding 1"
    assert issues[0]["note"].splitlines() == ["POI-1", "finding 1"]


def test_null_criticality_is_uncertain(tmp_path: Path) -> None:
    _, pois, _, issues = _issues(tmp_path)
    assert issues[2]["severity"] == "uncertain"
    assert worst(pois[2].snapshots) == "uncertain"
    _, _, _, old = _issues(tmp_path / "y", "2024")
    assert [i["severity"] for i in old] == ["uncertain"] * 3
    assert issues[2]["title"] == "POI-3"  # no comment, no description: the POI name


def test_category_from_tags(tmp_path: Path) -> None:
    _, _, cat, issues = _issues(tmp_path)
    assert cat["classes"] == [
        {"id": "corrosion", "label": "corrosion", "color": "#e5484d", "severityModel": "confined-space-4"}
    ]
    assert re.fullmatch(r"#[0-9a-fA-F]{6}", cat["classes"][0]["color"])
    assert issues[0]["classId"] == "corrosion"
    assert issues[2]["classId"] == "finding"


def test_category_falls_back_to_snapshot_tags(tmp_path: Path) -> None:
    _, pois = _setup(tmp_path)
    p = dataclasses.replace(
        pois[1],
        snapshots=[dataclasses.replace(pois[1].snapshots[0], tags=["Crack / Joint"])],
    )
    base = _catalogue()
    base["classes"].append({"id": "crack-joint", "label": "Old", "color": "#000000", "severityModel": "m"})
    cat, by_poi = category_classes([p], base)
    assert by_poi[p.id] == "crack-joint"
    assert [c["label"] for c in cat["classes"]] == ["Old"]  # an existing id is skipped
    q = dataclasses.replace(p, tags=["Crack / Joint", "腐蚀"])
    cat, by_poi = category_classes([q], _catalogue())
    ids = [c["id"] for c in cat["classes"]]
    assert ids[0] == "crack-joint" and re.fullmatch(r"tag-[0-9a-f]{8}", ids[1])


def test_annotation_points_in_pixels(tmp_path: Path) -> None:
    syn, pois = _setup(tmp_path)
    snap = dataclasses.replace(pois[1].snapshots[0], points=[(0.5, 0.25, "")], image_size=(4000, 3000))
    poi = dataclasses.replace(pois[1], snapshots=[snap])
    issue = build_issue(poi, _context(syn, [poi]))
    pts = [s for s in issue["sightings"] if s["on"] == "image" and s["geom"]["type"] == "point"]
    assert [s["geom"] for s in pts] == [{"type": "point", "x": 2000.0, "y": 750.0}]
    box = [s for s in issue["sightings"] if s.get("photo", "").endswith("-annotated")]
    assert box[0]["geom"] == {"type": "box", "x": 0, "y": 0, "w": 4000, "h": 3000}


def test_pin_uses_its_flights_layer(tmp_path: Path) -> None:
    syn, _, _, issues = _issues(tmp_path)
    layers = [i["sightings"][0]["layer"] for i in issues]
    assert layers == ["cloud-1", "cloud-0", "cloud-0"]  # P1 is flight B, the others flight A


def test_image_size_from_jpeg_header_and_no_sighting(tmp_path: Path) -> None:
    syn, pois = _setup(tmp_path)
    ctx = _context(syn, pois)
    snap = dataclasses.replace(pois[1].snapshots[0], image_size=None, points=[(0.5, 0.5, "")])
    issue = build_issue(dataclasses.replace(pois[1], snapshots=[snap]), ctx)
    assert {"type": "point", "x": 4.0, "y": 3.0} in [s["geom"] for s in issue["sightings"]]  # 8 x 6
    bare = dataclasses.replace(snap, pose_valid=False, photo=None, annotated=None)
    assert build_issue(dataclasses.replace(pois[1], snapshots=[bare]), ctx) is None


def test_sighting_order_and_whole_image_box(tmp_path: Path) -> None:
    syn, pois, _, issues = _issues(tmp_path)
    s = issues[1]["sightings"]
    assert s[0]["on"] == "pointcloud" and s[0]["geom"]["type"] == "point3"
    # worst (Critical) snapshot is pinned
    expect = to_scene(np.array(syn.hit[syn.snapshot_ids[2]]))
    assert s[0]["geom"]["p"] == pytest.approx(list(expect))
    kinds = [x["geom"]["type"] for x in s[1:]]
    assert kinds == ["box", "point", "box", "box"]  # Low box, Critical point, two annotated


def test_external_checks(tmp_path: Path) -> None:
    syn, pois, _, issues = _issues(tmp_path)
    assert [i["external"]["locationCheck"] for i in issues] == ["agrees", "disagrees", "no-hit"]
    p3 = issues[2]
    cam = np.array(syn.camera_position[syn.snapshot_ids[3]])
    axis = view_axis(pois[2].snapshots[0].camera_q)
    pin = p3["sightings"][0]["geom"]["p"]
    assert pin == pytest.approx(list(to_scene(cam + axis)))
    assert p3["external"]["hitDistanceM"] is None and p3["external"]["wallDistanceM"] is None
    ext = issues[1]["external"]
    assert ext["wallDistanceM"] == pytest.approx(syn.wall[syn.snapshot_ids[2]] + 2.0)
    assert ext["hitDistanceM"] == pytest.approx(syn.wall[syn.snapshot_ids[2]], abs=1e-6)
    assert ext["flight"] == syn.flight_ids[0]
    assert ext["source"] == "flyability" and ext["poi"] == syn.poi_ids[1]
    # flight A: datetime 1732600000, snapshot at 40 s, phase start 20 s
    assert ext["capturedAt"] == "2024-11-26T05:47:00Z"


def test_captured_at_absent_without_times(tmp_path: Path) -> None:
    syn, pois = _setup(tmp_path)
    ctx = dataclasses.replace(_context(syn, pois), phase_start_us={})
    assert "capturedAt" not in build_issue(pois[0], ctx)["external"]
    ctx = _context(syn, pois)
    # 1732600000 + 100 (flight B) + (30 s - 20 s)
    assert build_issue(pois[0], ctx)["external"]["capturedAt"] == "2024-11-26T05:48:30Z"


def test_invalid_pose_is_never_placed(tmp_path: Path) -> None:
    syn, pois = _setup(tmp_path)
    ctx = _context(syn, pois)
    bad = dataclasses.replace(pois[0].snapshots[0], pose_valid=False)
    poi = dataclasses.replace(pois[0], snapshots=[bad])
    issue = build_issue(poi, ctx)
    assert all(s["on"] != "pointcloud" for s in issue["sightings"])
    assert any(s["on"] == "image" for s in issue["sightings"])
    assert issue["external"]["locationCheck"] == "unchecked"
    assert issue["external"]["hitDistanceM"] is None
    # one good snapshot among bad ones still pins the cloud
    good = pois[1].snapshots
    mixed = dataclasses.replace(pois[1], snapshots=[dataclasses.replace(good[1], pose_valid=False), good[0]])
    pinned = build_issue(mixed, ctx)
    assert pinned["sightings"][0]["on"] == "pointcloud"
    assert pinned["sightings"][0]["geom"]["p"] == pytest.approx(ctx.scene_point[good[0].id])
    assert pinned["external"]["locationCheck"] == "unchecked"  # the worst snapshot is the bad one


def test_existing_code_is_kept(tmp_path: Path) -> None:
    syn, pois = _setup(tmp_path)
    ctx = _context(syn, pois)
    ctx.existing_codes.update({f"fly-{syn.poi_ids[1]}": "F07", "other": "F03"})
    codes = [build_issue(p, ctx)["code"] for p in pois]
    assert codes == ["F08", "F07", "F09"]


def test_issue_json_shape(tmp_path: Path) -> None:
    _, _, _, issues = _issues(tmp_path)
    keys = {
        "id", "code", "classId", "severityModelId", "severity", "status", "title", "note",
        "author", "createdAt", "updatedAt", "sightings", "source", "external",
    }  # fmt: skip
    for i in issues:
        assert keys <= set(i)
        assert re.fullmatch(r"[A-Z]{1,3}\d{2,4}", i["code"])
        assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", i["createdAt"])
        assert i["title"] and len(i["sightings"]) >= 1
        assert i["severity"] == "uncertain" or isinstance(i["severity"], int)
        ext = i["external"]
        assert ext["locationCheck"] in {"agrees", "disagrees", "no-hit", "unchecked", "moved"}
        assert ext["snapshots"] and set(ext) <= {
            "source", "poi", "snapshots", "flight", "capturedAt",
            "wallDistanceM", "hitDistanceM", "locationCheck",
        }  # fmt: skip
        for s in i["sightings"]:
            assert s["on"] in {"pointcloud", "image"} and s["layer"]


def test_merge_keeps_edits_and_missing(tmp_path: Path) -> None:
    syn, _, _, issues = _issues(tmp_path)
    p1, p2, p3 = issues
    edited = copy.deepcopy(p1)
    edited["updatedAt"] = "2026-11-01T09:00:00Z"
    edited["sightings"][0]["geom"]["p"] = [9.0, 9.0, 9.0]
    stale_p2 = {**copy.deepcopy(p2), "title": "old title"}
    gone = {**copy.deepcopy(p3), "id": "fly-gone", "code": "F09"}
    human = {**copy.deepcopy(p3), "id": "h1", "source": "human", "code": "F10"}
    merged, counts = merge_issues([edited, stale_p2, gone, human], issues)
    assert merged[0] == edited
    assert merged[1] == p2 and merged[1]["title"] != "old title"
    assert merged[2] == p3  # new
    assert [m["id"] for m in merged[3:]] == ["fly-gone", "h1"]
    assert counts == {"added": 1, "refreshed": 1, "kept_edited": 1, "kept_missing": 2}


def _human(i: str, **kw) -> dict:
    base = {
        "id": i, "code": "F01", "classId": "finding", "severityModelId": "m", "severity": 1,
        "status": "draft", "title": "t", "note": "", "author": "a", "source": "human",
        "createdAt": "2026-10-31T12:00:00Z", "updatedAt": "2026-10-31T12:00:00Z",
        "sightings": [{"on": "image", "layer": "l", "photo": "p", "geom": {"type": "point", "x": 1, "y": 1}}],
    }  # fmt: skip
    return {**base, **kw}


def test_merge_repeated_saved_id_and_junk() -> None:
    a, b = _human("a", title="one"), _human("b")
    a2 = {**a, "title": "two"}
    merged, counts = merge_issues([a, b, a2, "junk", {"nope": 1}], [])  # type: ignore[list-item]
    assert merged == [a2, b]  # first position, last content
    assert counts["kept_missing"] == 2


def test_merge_drops_malformed_saved_entries() -> None:
    bad = [
        _human("c1", code="x1"),
        _human("c2", title=""),
        _human("c3", sightings=[]),
        _human("c4", source="robot"),
        _human("c5", createdAt="yesterday"),
    ]
    merged, counts = merge_issues([*bad, _human("ok")], [])
    assert [m["id"] for m in merged] == ["ok"] and counts["kept_missing"] == 1
