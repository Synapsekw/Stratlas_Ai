"""inspection.run on a synthetic native project: a 20 m stack, posed photos, detections -> issues."""

import json
import math
import threading

import numpy as np
import pytest
from PIL import Image

from aio_pipelines.inspection.issues import issue_hash, merge
from aio_pipelines.inspection.pipeline import InspectionRun
from aio_pipelines.runtime import INPUTS_CHANGED, Job, JobError
from conftest import cylinder_glb, run_job

W, H = 1000, 750
HFOV = 50.0
AXIS = (3.0, -4.0)  # the stack layer is moved 3 m east and 4 m north
RADIUS = 2.0

GENERAL = {
    "id": "general-inspection",
    "name": "General inspection",
    "levels": [
        {"value": 1, "label": "Minor", "color": "#78b3d6", "criteria": "Monitor."},
        {"value": 2, "label": "Moderate", "color": "#ebc751", "criteria": "Plan."},
        {"value": 3, "label": "Severe", "color": "#f05653", "criteria": "Act."},
    ],
    "uncertain": {"label": "Uncertain", "color": "#878d93"},
}
CLASSES = {
    "id": "general-inspection-classes",
    "name": "General inspection classes",
    "assetType": "asset",
    "classes": [
        {"id": "corrosion", "label": "Corrosion", "color": "#f48d3c", "severityModel": "general-inspection"},
        {"id": "crack", "label": "Crack", "color": "#f05653", "severityModel": "general-inspection"},
    ],
}


def look_q(eye, target):
    """three.js camera quaternion looking from ``eye`` at ``target`` with +Y up."""
    d = np.subtract(target, eye).astype(float)
    z = -d / np.linalg.norm(d)
    x = np.cross([0, 1, 0], z)
    x /= np.linalg.norm(x)
    y = np.cross(z, x)
    m = np.column_stack([x, y, z])
    tr = m.trace()
    if tr > 0:
        s = math.sqrt(tr + 1) * 2
        q = [(m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s, s / 4]
    else:
        i = int(np.argmax(np.diag(m)))
        j, k = (i + 1) % 3, (i + 2) % 3
        s = math.sqrt(1 + m[i, i] - m[j, j] - m[k, k]) * 2
        q = [0.0, 0.0, 0.0, (m[k, j] - m[j, k]) / s]
        q[i] = s / 4
        q[j] = (m[j, i] + m[i, j]) / s
        q[k] = (m[k, i] + m[i, k]) / s
    return [float(v) for v in q]


def rot(q, v):
    from aio_pipelines.inspection.frame import rotate

    return rotate(q, v)


def to_pixel(cam, p):
    """Pinhole projection (the app's lens.ts maths) of a local point into a photo."""
    qc = [-cam["q"][0], -cam["q"][1], -cam["q"][2], cam["q"][3]]
    rel = rot(qc, np.subtract(p, cam["pos"]).tolist())
    f = (W / 2) / math.tan(math.radians(HFOV / 2))
    return W / 2 + f * rel[0] / -rel[2], H / 2 - f * rel[1] / -rel[2]


ax, az = AXIS
CAMS = {
    "e1": {"pos": [ax + 20, 10, az], "look": [ax, 10, az]},
    "e2": {"pos": [ax + 14, 14, az + 14], "look": [ax, 10, az]},
    "n1": {"pos": [ax, 18, az - 20], "look": [ax, 18, az]},
    "w1": {"pos": [ax - 20, 5, az], "look": [ax, 5, az]},
}
EAST_SPOT = [ax + RADIUS, 10.0, az]  # facing east, half way up
NORTH_TOP = [ax, 18.0, az - RADIUS]  # facing north, near the top


def native_project(root, issues=None):
    """A project as the builder makes it: manifest, models/, photos/, issues.json."""
    cylinder_glb(root / "models" / "stack.glb", radius=RADIUS, height=20.0)
    items = []
    (root / "photos").mkdir(parents=True, exist_ok=True)
    for pid, c in CAMS.items():
        c["q"] = look_q(c["pos"], c["look"])
        Image.new("RGB", (W, H), (120, 120, 120)).save(root / "photos" / f"{pid}.jpg")
        items.append({"id": pid, "src": {"path": f"photos/{pid}.jpg"}, "pos": c["pos"], "q": c["q"],
                      "lens": {"model": "pinhole", "hfovDeg": HFOV, "aspect": W / H},
                      "takenAt": "2026-01-02T10:00:00+03:00"})  # fmt: skip
    items.append({"id": "nogps", "src": {"path": "photos/e1.jpg"}})
    T = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, AXIS[0], 0, AXIS[1], 1]
    manifest = {
        "schema": "aio.project/1", "id": "synthetic", "name": "Synthetic stack", "crs": {"epsg": 32639},
        "origin": [500000, 3200000, 0], "captures": [], "type": "inspection",
        "layers": [
            {"kind": "mesh", "id": "stack", "name": "Stack", "visible": True, "src": {"path": "models/stack.glb"},
             "transform": T},
            {"kind": "photos", "id": "photos", "name": "Photos", "visible": True, "items": items},
        ],
        "severityModels": [GENERAL], "classCatalogues": [CLASSES],
    }  # fmt: skip
    (root / "manifest.json").write_text(json.dumps(manifest))
    (root / "issues.json").write_text(json.dumps({"schema": "aio.issues/1", "issues": issues or []}))
    return root


def box_at(cam, p, half=8):
    x, y = to_pixel(CAMS[cam], p)
    return [x - half, y - half, x + half, y + half]


def write_detections(root, dets, name="review.json", **extra):
    d = root / "detections"
    d.mkdir(exist_ok=True)
    doc = {"schema": "aio.detections/1", "source": "human", "detections": dets, **extra}
    (d / name).write_text(json.dumps(doc))


USER_ISSUE = {
    "id": "u1", "code": "F01", "classId": "crack", "severityModelId": "general-inspection", "severity": 1,
    "status": "reviewed", "title": "Hand made", "note": "", "author": "dan",
    "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z",
    "sightings": [{"on": "mesh", "layer": "stack", "geom": {"type": "spoint", "p": [1, 2, 3], "n": [0, 1, 0]}}],
    "source": "human",
}  # fmt: skip


def standard(root):
    native_project(root, [USER_ISSUE])
    write_detections(
        root,
        [
            {"id": "a", "photo": "e1", "class": "corrosion", "severity": 2, "bbox": box_at("e1", EAST_SPOT),
             "note": "Rust streak"},
            {"id": "b", "photo": "e2", "class": "corrosion", "severity": 3, "bbox": box_at("e2", EAST_SPOT)},
            {"id": "c", "photo": "n1", "class": "crack", "bbox": box_at("n1", NORTH_TOP)},
        ],
    )  # fmt: skip


def issues_of(root):
    return json.loads((root / "issues.json").read_text())["issues"]


def mesh_point(issue):
    return next(s["geom"]["p"] for s in issue["sightings"] if s["on"] == "mesh")


def test_detections_become_issues_on_the_mesh_where_the_boxes_are(project):
    standard(project)
    result, rec = run_job(InspectionRun(), project, {})
    out = result["outputs"]
    assert out["read"]["photos"] == 4 and out["read"]["unplaced"] == 1
    assert out["detections"]["detections"] == 3
    assert out["place"] == {"points": 3, "unmapped": 0}
    assert out["commit"]["new"] == 2 and out["commit"]["issues"] == 3

    issues = issues_of(project)
    assert issues[0] == USER_ISSUE  # a person's issue is never touched
    crack, rust = issues[1], issues[2]
    assert crack["code"] == "D01" and crack["classId"] == "crack"  # numbered from the top down
    assert rust["code"] == "D02" and rust["classId"] == "corrosion"
    assert mesh_point(rust) == pytest.approx(EAST_SPOT, abs=0.15)
    assert mesh_point(crack) == pytest.approx(NORTH_TOP, abs=0.15)
    mesh = next(s for s in rust["sightings"] if s["on"] == "mesh")
    assert mesh["layer"] == "stack" and mesh["geom"]["n"] == pytest.approx([1, 0, 0], abs=0.1)
    boxes = [s for s in rust["sightings"] if s["on"] == "image"]
    assert [b["photo"] for b in boxes] == ["e1", "e2"]
    assert boxes[0]["geom"]["w"] == pytest.approx(16, abs=0.2)
    assert rust["severity"] == 3 and crack["severity"] == 2  # the group's worst; the kit default 2
    assert rust["status"] == "draft" and rust["source"] == "import"
    assert "Rust streak" in rust["note"] and "Seen in 2 photos" in rust["note"]
    assert rust["title"].startswith("Corrosion, ")

    # contact sheets, register, stats and the map
    insp = project / "inspection"
    layout = json.loads((insp / "contact" / "layout.json").read_text())
    assert [s["name"] for s in layout["sheets"]] == ["sheet-00"]
    assert (insp / "contact" / "sheet-00.jpg").exists()
    records = json.loads((insp / "records.json").read_text())
    s = records["stats"]
    assert s["findings"] == 3 and s["mapped"] == 3 and s["defects"] == 2 and s["photos"] == 4
    assert s["severity"] == {"1": 0, "2": 1, "3": 1} or s["severity"]["3"] == 1
    assert {v["code"] for v in records["issues"].values()} == {"D01", "D02"}
    assert (insp / "findings.csv").read_text("utf-8-sig").startswith("finding_id,defect_id")
    counted = json.loads((insp / "detections.json").read_text())
    assert counted["schema"] == "aio.detections/1" and len(counted["detections"]) == 3
    mp = json.loads((insp / "issues-map.json").read_text())
    assert sorted(mp["issues"][rust["id"]]["detections"]) == ["a", "b"]
    assert (project / "issues.json.bak").exists()
    assert any(m == "progress" for m, _ in rec.messages)


def test_a_second_run_keeps_ids_and_never_overwrites_a_persons_edit(project):
    standard(project)
    run_job(InspectionRun(), project, {}, job_id="j1")
    first = issues_of(project)
    again, _ = run_job(InspectionRun(), project, {}, job_id="j2")
    assert again["outputs"]["commit"]["unchanged"] == 2
    assert issues_of(project) == first

    # a person reviews the crack; a new detection joins the rust group
    issues = issues_of(project)
    issues[1] = {
        **issues[1],
        "status": "reviewed",
        "note": "Checked on site.",
        "updatedAt": "2026-02-01T00:00:00Z",
    }
    (project / "issues.json").write_text(json.dumps({"schema": "aio.issues/1", "issues": issues}))
    doc = json.loads((project / "detections" / "review.json").read_text())
    doc["detections"].append({"id": "d", "photo": "e1", "class": "corrosion", "severity": 1,
                              "bbox": box_at("e1", [ax + RADIUS, 10.3, az])})  # fmt: skip
    (project / "detections" / "review.json").write_text(json.dumps(doc))
    r3, _ = run_job(InspectionRun(), project, {}, job_id="j3")
    c = r3["outputs"]["commit"]
    assert c["kept_edited"] == 1 and c["updated"] == 1 and c["new"] == 0
    after = issues_of(project)
    assert after[1] == issues[1]  # the reviewed crack, exactly as the person left it
    assert [x["id"] for x in after] == [x["id"] for x in first]
    rust = after[2]
    assert len([s for s in rust["sightings"] if s["on"] == "image"]) == 3


def stopper(after: int, ev: threading.Event):
    """InspectionRun that cancels itself once step ``after`` (0-based) has finished."""

    class Stop(InspectionRun):
        def plan(self, params):
            steps = super().plan(params)
            inner = steps[after].run

            def run(ctx):
                out = inner(ctx)
                ev.set()
                return out

            s = steps[after]
            steps[after] = type(s)(s.name, s.title, run, s.weight)
            return steps

    return Stop()


def test_a_cancelled_job_resumes_and_the_project_is_untouched_until_commit(project):
    from aio_pipelines.runtime import Cancelled

    standard(project)
    before = (project / "issues.json").read_bytes()
    ev = threading.Event()
    with pytest.raises(Cancelled):
        run_job(stopper(4, ev), project, {}, job_id="j1", cancel=ev)  # stopped after cluster
    assert (project / "issues.json").read_bytes() == before
    assert not (project / "inspection").exists()  # everything is still in the job's staging
    result, rec = run_job(InspectionRun(), project, {}, job_id="j1")
    skipped = [p["step"] for p in rec.of("progress") if p.get("state") == "skipped"]
    assert skipped == ["read", "sheets", "detections", "place", "cluster"]
    assert result["outputs"]["commit"]["new"] == 2


def review_issue(iid, photo, bbox):
    """An issue a person accepted in the review: one image sighting, no placement yet."""
    x0, y0, x1, y1 = bbox
    return {
        "id": iid, "code": "F01", "classId": "corrosion", "severityModelId": "general-inspection",
        "severity": 2, "status": "draft", "title": "Corrosion", "note": "", "author": "reviewer",
        "createdAt": "2026-01-03T00:00:00Z", "updatedAt": "2026-01-03T00:00:00Z", "source": "agent",
        "sightings": [{"on": "image", "layer": "photos", "photo": photo,
                       "geom": {"type": "box", "x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0}}],
    }  # fmt: skip


def test_review_accepted_detections_are_placed_on_their_issue_not_made_again(project):
    b1, b2 = box_at("e1", EAST_SPOT), box_at("e2", EAST_SPOT)
    native_project(project, [review_issue("rev-1", "e1", b1)])
    write_detections(
        project,
        [
            # accepted in the review into rev-1 (the second one linked to it), with review fields
            {"id": "a", "photo": "e1", "class": "corrosion", "severity": 2, "bbox": b1, "status": "accepted",
             "issueId": "rev-1", "space": "source", "width": W, "height": H,
             "geom": {"type": "box", "x": b1[0], "y": b1[1], "w": 16, "h": 16},
             "origin": {"provider": "anthropic", "model": "claude-opus-5-5", "promptVersion": "detect-v1",
                        "runId": "r1"}, "reviewedBy": "dan", "reviewedAt": "2026-01-03T00:00:00Z"},
            {"id": "b", "photo": "e2", "class": "corrosion", "bbox": b2, "status": "accepted", "issueId": "rev-1"},
            # accepted for the pipeline (no issue yet)
            {"id": "c", "photo": "n1", "class": "crack", "bbox": box_at("n1", NORTH_TOP), "status": "accepted"},
            # a video frame: not placed
            {"id": "f", "frame": {"layer": "clip", "t": 3.5}, "class": "crack", "bbox": [1, 1, 9, 9],
             "space": "source", "width": 1920, "height": 1080, "status": "accepted"},
        ],
        name="ai-run.json",
        source="ai",
        run={"id": "r1", "provider": "anthropic", "model": "claude-opus-5-5", "promptVersion": "detect-v1"},
    )  # fmt: skip
    result, _ = run_job(InspectionRun(), project, {}, job_id="j1")
    out = result["outputs"]
    assert out["detections"]["detections"] == 3
    assert out["detections"]["skipped"] == {"video frame, not placed": 1}
    c = out["commit"]
    assert (c["new"], c["linked"], c["placed"], c["orphaned"]) == (1, 1, 1, 0)
    issues = issues_of(project)
    assert len(issues) == 2  # the review's issue and one pipeline issue (the crack); no duplicate
    rev = next(i for i in issues if i["id"] == "rev-1")
    assert mesh_point(rev) == pytest.approx(EAST_SPOT, abs=0.15)
    assert [s["on"] for s in rev["sightings"]] == ["image", "mesh"]  # nothing else changed
    assert rev["code"] == "F01" and rev["title"] == "Corrosion" and rev["status"] == "draft"
    crack = next(i for i in issues if i["id"] != "rev-1")
    assert crack["classId"] == "crack" and crack["source"] == "agent"
    mp = json.loads((project / "inspection" / "issues-map.json").read_text())
    assert "rev-1" not in mp["issues"]  # the pipeline never claims the review's issue
    assert mp["issues"][crack["id"]]["detections"] == ["c"]

    # a second run changes nothing; a deleted review issue is not made again
    again, _ = run_job(InspectionRun(), project, {}, job_id="j2")
    assert again["outputs"]["commit"]["placed"] == 0 and issues_of(project) == issues
    doc = json.loads((project / "issues.json").read_text())
    doc["issues"] = [i for i in doc["issues"] if i["id"] != "rev-1"]
    (project / "issues.json").write_text(json.dumps(doc))
    third, _ = run_job(InspectionRun(), project, {}, job_id="j3")
    assert third["outputs"]["commit"]["orphaned"] == 1 and third["outputs"]["commit"]["new"] == 0
    assert [i["id"] for i in issues_of(project)] == [crack["id"]]


def test_resume_is_refused_when_the_detections_changed(project):
    from aio_pipelines.runtime import Cancelled

    standard(project)
    ev = threading.Event()
    with pytest.raises(Cancelled):
        run_job(stopper(1, ev), project, {}, job_id="j1", cancel=ev)
    write_detections(project, [], name="more.json")
    with pytest.raises(JobError, match=INPUTS_CHANGED.split(".")[0]):
        Job("j1", InspectionRun(), project, {}, lambda *a: None, threading.Event()).run()


def test_drafts_rejected_and_weak_detections_do_not_count(project):
    native_project(project)
    write_detections(
        project,
        [
            {"photo": "e1", "class": "corrosion", "bbox": box_at("e1", EAST_SPOT), "status": "draft",
             "confidence": 0.9},
            {"photo": "e2", "class": "corrosion", "bbox": box_at("e2", EAST_SPOT), "status": "rejected"},
            {"photo": "n1", "class": "crack", "bbox": box_at("n1", NORTH_TOP), "confidence": 0.2},
        ],
        source="ai",
    )  # fmt: skip
    r, _ = run_job(InspectionRun(), project, {"minConfidence": 0.5}, job_id="j1")
    assert r["outputs"]["detections"]["detections"] == 0
    assert r["outputs"]["detections"]["skipped"] == {
        "draft, not reviewed": 1,
        "rejected": 1,
        "below minimum confidence": 1,
    }
    assert issues_of(project) == []
    r, _ = run_job(InspectionRun(), project, {"includeDrafts": True}, job_id="j2")
    issues = issues_of(project)
    assert r["outputs"]["detections"]["detections"] == 2 and len(issues) == 2
    assert {i["source"] for i in issues} == {"agent"}  # an AI pass makes agent issues


def test_uncertain_detections_stay_uncertain(project):
    native_project(project)
    write_detections(project, [{"photo": "w1", "class": "corrosion", "severity": "uncertain",
                                "bbox": box_at("w1", [ax - RADIUS, 5, az])}])  # fmt: skip
    run_job(InspectionRun(), project, {})
    (issue,) = issues_of(project)
    assert issue["severity"] == "uncertain"
    stats = json.loads((project / "inspection" / "records.json").read_text())["stats"]
    assert stats["uncertain"] == 1 and stats["uncertain_only"] == 1


def test_boxes_drawn_on_a_contact_sheet_land_on_their_photo(project):
    native_project(project)
    run_job(InspectionRun(), project, {}, job_id="j1")  # no detections yet: sheets only
    assert issues_of(project) == []
    layout = json.loads((project / "inspection" / "contact" / "layout.json").read_text())
    cell = next(c for c in layout["sheets"][0]["cells"] if c["photo"] == "e1")
    x0, y0, x1, y1 = box_at("e1", EAST_SPOT)
    s = cell["w"] / cell["pw"]
    sheet_box = [cell["x"] + x0 * s, cell["y"] + y0 * s, cell["x"] + x1 * s, cell["y"] + y1 * s]
    write_detections(
        project, [{"class": "corrosion", "space": "sheet", "sheet": "sheet-00", "bbox": sheet_box}]
    )
    run_job(InspectionRun(), project, {}, job_id="j2")
    (issue,) = issues_of(project)
    img = next(s for s in issue["sightings"] if s["on"] == "image")
    assert img["photo"] == "e1" and img["geom"]["x"] == pytest.approx(x0, abs=3)
    assert mesh_point(issue) == pytest.approx(EAST_SPOT, abs=0.2)


def test_kit_lists_and_coco_are_accepted(project):
    native_project(project)
    d = project / "detections"
    d.mkdir()
    bx = box_at("e1", EAST_SPOT)
    (d / "kit.json").write_text(json.dumps([{"image": "e1.jpg", "class": "Corrosion", "bbox": bx,
                                             "space": "preview"}]))  # fmt: skip
    nx = [v / s for v, s in zip(box_at("n1", NORTH_TOP), (W, H, W, H), strict=True)]
    coco = {
        "images": [{"id": 7, "file_name": "n1.jpg", "width": 2 * W, "height": 2 * H}],
        "categories": [{"id": 1, "name": "crack"}],
        "annotations": [{"image_id": 7, "category_id": 1, "score": 0.8,
                         "bbox": [nx[0] * 2 * W, nx[1] * 2 * H, (nx[2] - nx[0]) * 2 * W, (nx[3] - nx[1]) * 2 * H]}],
    }  # fmt: skip
    (d / "model.json").write_text(json.dumps(coco))
    r, _ = run_job(InspectionRun(), project, {})
    assert r["outputs"]["detections"]["detections"] == 2
    issues = issues_of(project)
    assert {i["classId"] for i in issues} == {"corrosion", "crack"}
    crack = next(i for i in issues if i["classId"] == "crack")
    assert mesh_point(crack) == pytest.approx(NORTH_TOP, abs=0.2)


def test_bad_inputs_fail_with_a_sentence(project):
    native_project(project)
    with pytest.raises(JobError, match="do not exist"):
        run_job(InspectionRun(), project, {"detections": "nowhere.json"})
    with pytest.raises(JobError, match="does not take"):
        InspectionRun().validate({"bogus": 1})
    write_detections(project, [{"photo": "e1", "class": "corrosion", "bbox": [1, 2]}])
    with pytest.raises(JobError, match="needs bbox"):
        run_job(InspectionRun(), project, {}, job_id="j2")


def test_a_project_without_a_model_says_so(project):
    native_project(project)
    (project / "models" / "stack.glb").unlink()
    with pytest.raises(JobError, match="no model"):
        run_job(InspectionRun(), project, {})


# ---------------------------------------------------------------- merge rules


def _p(dets, title="Corrosion, Shaft"):
    return {"defect": "D01", "detections": dets, "classId": "corrosion", "severityModelId": "general-inspection",
            "severity": 2, "title": title, "note": "", "source": "import",
            "sightings": [{"on": "image", "layer": "photos", "photo": "e1",
                           "geom": {"type": "box", "x": 1, "y": 1, "w": 2, "h": 2}}]}  # fmt: skip


def test_merge_never_drops_an_issue():
    issues, mp, c = merge([USER_ISSUE], None, [_p(["a"])], "2026-03-01T00:00:00Z")
    assert issues[0] == USER_ISSUE and len(issues) == 2 and c["new"] == 1 and c["user"] == 1
    made = issues[1]
    assert made["code"] == "D01" and mp["issues"][made["id"]]["hash"] == issue_hash(made)
    # the detection is gone: the earlier issue stays for a person to decide
    issues2, mp2, c2 = merge(issues, mp, [], "2026-03-02T00:00:00Z")
    assert issues2 == issues and c2["stale"] == 1 and made["id"] in mp2["issues"]


def test_merge_survives_a_crash_between_map_and_issues():
    issues, mp, _ = merge([], None, [_p(["a"])], "2026-03-01T00:00:00Z")
    # the map was written, issues.json was not: the next run makes the same issue once
    again, _, c = merge([], mp, [_p(["a"])], "2026-03-01T00:00:01Z")
    assert [i["id"] for i in again] == [i["id"] for i in issues] and c["new"] == 1
    # issues.json was written, the map was not: the issue is recognised by its id
    again2, _, c2 = merge(issues, None, [_p(["a"])], "2026-03-01T00:00:02Z")
    assert again2 == issues and c2["unchanged"] == 1


def test_merge_takes_codes_nobody_uses():
    taken = {**USER_ISSUE, "code": "D01"}
    issues, _, _ = merge([taken], None, [_p(["a"]), {**_p(["b"]), "defect": "D02"}], "2026-03-01T00:00:00Z")
    assert [i["code"] for i in issues] == ["D01", "D02", "D03"]


def test_issue_hash_ignores_how_numbers_are_written():
    a = {**USER_ISSUE, "severity": 1.0}
    assert issue_hash(a) == issue_hash(USER_ISSUE)
