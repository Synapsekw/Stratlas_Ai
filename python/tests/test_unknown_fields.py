"""M9 forward compatibility: pipelines keep what they do not own and never touch the journal.

An M9 build (or a later one) may add keys to issues, layers and the manifest. The pipelines work
on dicts, so issues and entries they do not own must come back with those keys, values and key
order unchanged. ``journal/`` and ``team.json`` belong to the app alone: no pipeline reads or
writes them. Synthetic data only.
"""

import json
from pathlib import Path

import pytest

from aio_pipelines.inspection.pipeline import InspectionRun
from aio_pipelines.road.pipeline import RoadBuild
from conftest import run_job
from test_inspection import EAST_SPOT, NORTH_TOP, box_at, native_project, review_issue, write_detections
from test_road import road_project

FUTURE = {"nested": [1, "ü", None]}
FUTURE_KEY = "x_m9_future"

PERSON_ISSUE = {
    "id": "person-1", "code": "F01", "classId": "crack", "severityModelId": "general-inspection",
    "severity": 1, "status": "reviewed", "title": "Hand made", "note": "", "author": "Ana Example",
    "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z",
    "sightings": [{"on": "mesh", "layer": "stack", "geom": {"type": "spoint", "p": [1, 2, 3], "n": [0, 1, 0]},
                   FUTURE_KEY: FUTURE}],
    "source": "human", FUTURE_KEY: FUTURE, "x_m9_scalar": 1.5,
}  # fmt: skip


def exact(v) -> str:
    """The value as written: key order, types and text kept (1 stays 1, None stays null, "ü" stays "ü")."""
    return json.dumps(v, ensure_ascii=False)


def issues_of(root: Path) -> list[dict]:
    return json.loads((root / "issues.json").read_text("utf-8"))["issues"]


def with_future(root: Path, layer_ids: tuple[str, ...]) -> None:
    """Unknown keys on the manifest top level and on the named layers."""
    m = json.loads((root / "manifest.json").read_text("utf-8"))
    m[FUTURE_KEY] = FUTURE
    for lyr in m["layers"]:
        if lyr["id"] in layer_ids:
            lyr[FUTURE_KEY] = FUTURE
    (root / "manifest.json").write_text(json.dumps(m, ensure_ascii=False), "utf-8")


def write_issues(root: Path, issues: list[dict], **top) -> None:
    doc = {"schema": "aio.issues/1", "issues": issues, **top}
    (root / "issues.json").write_text(json.dumps(doc, ensure_ascii=False), "utf-8")


# ---------------------------------------------------------------- inspection.run


def inspection_project(root: Path) -> None:
    native_project(root)  # poses the synthetic cameras that box_at projects through
    b1 = box_at("e1", EAST_SPOT)
    review = {**review_issue("rev-1", "e1", b1), FUTURE_KEY: FUTURE}
    with_future(root, ("stack", "photos"))
    write_issues(root, [PERSON_ISSUE, review])
    write_detections(
        root,
        [
            # accepted into rev-1 in the review: the pipeline adds a mesh sighting to rev-1 only
            {"id": "a", "photo": "e1", "class": "corrosion", "severity": 2, "bbox": b1, "status": "accepted",
             "issueId": "rev-1"},
            {"id": "c", "photo": "n1", "class": "crack", "bbox": box_at("n1", NORTH_TOP)},
        ],
    )  # fmt: skip


def test_inspection_run_keeps_unknown_keys_on_issues_it_does_not_own(project):
    inspection_project(project)
    manifest_before = (project / "manifest.json").read_bytes()
    review_before = issues_of(project)[1]

    result, _ = run_job(InspectionRun(), project, {}, job_id="j1")
    c = result["outputs"]["commit"]
    assert (c["new"], c["linked"], c["placed"]) == (1, 1, 1)
    issues = issues_of(project)
    by_id = {i["id"]: i for i in issues}

    # a person's issue: every key, value and key order exactly as written
    assert exact(by_id["person-1"]) == exact(PERSON_ISSUE)
    # the review's issue the pipeline places: its unknown key stays, in place, unchanged
    rev = by_id["rev-1"]
    assert exact(rev[FUTURE_KEY]) == exact(FUTURE)
    assert list(rev)[: len(review_before)] == list(review_before)
    assert {k: v for k, v in rev.items() if k not in ("sightings", "updatedAt")} == {
        k: v for k, v in review_before.items() if k not in ("sightings", "updatedAt")
    }
    # inspection.run never writes the manifest: its unknown keys are byte-for-byte the same
    assert (project / "manifest.json").read_bytes() == manifest_before

    # a second run leaves them as they are too
    run_job(InspectionRun(), project, {}, job_id="j2")
    again = {i["id"]: i for i in issues_of(project)}
    assert exact(again["person-1"]) == exact(PERSON_ISSUE)
    assert exact(again["rev-1"]) == exact(rev)
    assert (project / "manifest.json").read_bytes() == manifest_before


def test_inspection_run_keeps_unknown_top_level_keys_of_issues_json(project):
    inspection_project(project)
    write_issues(project, issues_of(project), **{FUTURE_KEY: FUTURE})
    run_job(InspectionRun(), project, {})
    doc = json.loads((project / "issues.json").read_text("utf-8"))
    assert exact(doc.get(FUTURE_KEY)) == exact(FUTURE)
    assert list(doc) == ["schema", "issues", FUTURE_KEY]  # in the place it was written


# ---------------------------------------------------------------- road.build


EDITED_IMPORT = {
    # a builder issue (rd-0001, the pothole) a person edited: the rebuild keeps it as it is
    "id": "rd-0001", "code": "D0001", "classId": "potholes", "severityModelId": "road-astm-d6433",
    "severity": 2, "status": "reviewed", "title": "Pothole, checked", "note": "", "author": "Ben Example",
    "createdAt": "2026-10-01T09:00:00Z", "updatedAt": "2026-10-02T09:00:00Z",
    "sightings": [{"on": "map", "geom": {"type": "point", "p": [50, 0, 0]}, FUTURE_KEY: FUTURE}],
    "source": "import", FUTURE_KEY: FUTURE,
}  # fmt: skip


def road_with_future(tmp_path: Path, project: Path) -> dict:
    inputs = road_project(tmp_path, project)
    m = json.loads((project / "manifest.json").read_text("utf-8"))
    m["layers"] = [
        # not the builder's: a site model, and an earlier raw import of the same GeoTIFF that the
        # builder hides under its pyramid (it changes ``visible`` and nothing else)
        {"kind": "mesh", "id": "site", "name": "Site model", "visible": True,
         "src": {"path": "models/site.glb"}},
        {"kind": "raster", "id": "ortho-preview", "name": "ortho", "visible": True, "format": "image",
         "src": {"path": "rasters/ortho-preview.png"}},
    ]  # fmt: skip
    m["classCatalogues"] = [
        {"id": "road-classes", "name": "Road classes", "assetType": "road", "classes": [], FUTURE_KEY: FUTURE}
    ]
    (project / "manifest.json").write_text(json.dumps(m, ensure_ascii=False), "utf-8")
    with_future(project, ("site", "ortho-preview"))
    write_issues(project, [{**PERSON_ISSUE, "severityModelId": "road-astm-d6433"}, EDITED_IMPORT])
    return inputs


def test_road_build_keeps_unknown_keys_on_issues_layers_and_the_manifest(tmp_path, project):
    inputs = road_with_future(tmp_path, project)
    before = json.loads((project / "manifest.json").read_text("utf-8"))
    person = issues_of(project)[0]

    result, _ = run_job(RoadBuild(), project, {**inputs, "unitLength": 30, "lanes": 2, "laneWidth": 3.65})
    assert result["status"] == "done"
    assert result["outputs"]["commit"]["issuesKept"] == 2

    by_id = {i["id"]: i for i in issues_of(project)}
    assert {"rd-0000", "rd-0002"} <= set(by_id)  # the builder did write its own issues
    assert exact(by_id["person-1"]) == exact(person)
    assert exact(by_id["rd-0001"]) == exact(EDITED_IMPORT)

    m = json.loads((project / "manifest.json").read_text("utf-8"))
    assert exact(m[FUTURE_KEY]) == exact(FUTURE)
    assert list(m)[: len(before)] == list(before)  # top-level keys kept in their order
    layers = {lyr["id"]: lyr for lyr in m["layers"]}
    assert {"ortho", "closeups"} <= set(layers)  # the builder did rewrite the layers
    assert exact(layers["site"]) == exact(next(x for x in before["layers"] if x["id"] == "site"))
    preview_before = next(x for x in before["layers"] if x["id"] == "ortho-preview")
    assert layers["ortho-preview"] == {**preview_before, "visible": False}
    assert list(layers["ortho-preview"]) == list(preview_before)
    road_cat = next(c for c in m["classCatalogues"] if c["id"] == "road-classes")
    assert road_cat["classes"]  # the builder added its classes to this catalogue ...
    assert exact(road_cat[FUTURE_KEY]) == exact(FUTURE)  # ... and kept the unknown key


def test_road_build_keeps_unknown_top_level_keys_of_issues_json(tmp_path, project):
    inputs = road_project(tmp_path, project)
    write_issues(project, [], **{FUTURE_KEY: FUTURE})
    run_job(RoadBuild(), project, {"centreline": inputs["centreline"], "defects": inputs["defects"]})
    doc = json.loads((project / "issues.json").read_text("utf-8"))
    assert exact(doc.get(FUTURE_KEY)) == exact(FUTURE)
    assert list(doc) == ["schema", "issues", FUTURE_KEY]  # in the place it was written


# ---------------------------------------------------------------- journal/ and team.json

CHAIN = "dev-0a1b2c3d.rep-4e5f6a7b"
TEAM = {
    "schema": "aio.team/1",
    "teamProjectId": "t_0123456789abcdefghjkmnpqrs",
    "name": "Synthetic team project",
    "createdAt": "2026-10-07T08:00:00Z",
    "createdBy": "ana@example.com",
}


def seed_journal(root: Path) -> None:
    seg = root / "journal" / "ops" / CHAIN / "000001.jsonl"
    seg.parent.mkdir(parents=True)
    ops = [
        {"schema": "aio.op/1", "seq": 1, "kind": "issue.create", "author": "ana@example.com",
         "target": "person-1", "note": "Synthetic op ü"},
        {"schema": "aio.op/1", "seq": 2, "kind": "issue.update", "author": "ben@example.com",
         "target": "person-1", "patch": {"status": "reviewed"}},
    ]  # fmt: skip
    seg.write_bytes(b"".join(json.dumps(o, ensure_ascii=False).encode("utf-8") + b"\n" for o in ops))
    (root / "team.json").write_text(json.dumps(TEAM, indent=2) + "\n", "utf-8")


def snapshot(root: Path) -> dict[str, tuple[bytes, int]]:
    files = [*sorted((root / "journal").rglob("*")), root / "team.json"]
    return {
        f.relative_to(root).as_posix(): (f.read_bytes(), f.stat().st_mtime_ns) if f.is_file() else (b"", 0)
        for f in files
    }


def run_inspection(tmp_path: Path, project: Path):
    inspection_project(project)
    seed_journal(project)
    before = snapshot(project)
    result, _ = run_job(InspectionRun(), project, {})
    assert result["status"] == "done"
    return before


def run_road(tmp_path: Path, project: Path):
    inputs = road_project(tmp_path, project)
    seed_journal(project)
    before = snapshot(project)
    result, _ = run_job(RoadBuild(), project, {**inputs, "unitLength": 30})
    assert result["status"] == "done"
    return before


@pytest.mark.parametrize("run", [run_inspection, run_road], ids=["inspection.run", "road.build"])
def test_no_pipeline_writes_under_journal_or_team_json(tmp_path, project, run):
    before = run(tmp_path, project)
    # same files (none added, none removed), same bytes, not rewritten (same modification time)
    assert snapshot(project) == before
    assert not list(project.glob("team.json.*")) and not list(project.glob("journal*.bak"))


def test_no_pipeline_module_names_the_journal_or_team_json():
    """A source guard for the pipelines not run above: none refers to journal/ or team.json."""
    import aio_pipelines

    pack = Path(aio_pipelines.__file__).parent
    hits = [
        f"{f.relative_to(pack).as_posix()}: {word}"
        for f in sorted(pack.rglob("*.py"))
        for word in ("journal", "team.json")
        if word in f.read_text("utf-8")
    ]
    assert hits == []
