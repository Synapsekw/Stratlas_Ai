import json
import math

import numpy as np
import pytest
import yaml
from PIL import Image

from aio_pipelines.aik.pipelines import AikProject, AikRecords
from aio_pipelines.runtime import JobError
from conftest import cylinder_glb, run_job

W, H = 1000, 750
HFOV = 40.0
VFOV = 2 * math.degrees(math.atan(math.tan(math.radians(HFOV / 2)) * H / W))


def kit_project(root, profile="telecom-tower", findings=None, mask=False, statuses=None):
    """A tiny kit job: a 20 m cylinder, one camera 20 m north looking at it, one finding."""
    cylinder_glb(root / "model.glb")
    cams = {
        "photos": [
            {"id": "p001", "name": "DJI_0001.JPG", "file": "photos/p001.jpg", "sequence": "1", "subject": "Shaft",
             "latitude": 29.0, "longitude": 48.0, "altitude": 40.0, "width": W, "height": H, "time": "2026:01:02 10:00:00",
             "position": [20, 10, 0], "target": [0, 10, 0], "up": [0, 1, 0], "hfov": HFOV, "vfov": VFOV},
            {"id": "p002", "name": "DJI_0002.JPG", "file": "photos/p002.jpg", "sequence": "1", "subject": "Top",
             "latitude": 29.0, "longitude": 48.0, "altitude": 52.0, "width": W, "height": H, "time": "2026:01:02 10:01:00",
             "position": [0, 22, 20], "target": [0, 18, 0], "up": [0, 1, 0], "hfov": HFOV, "vfov": VFOV},
        ]
    }  # fmt: skip
    (root / "cameras.json").write_text(json.dumps(cams))
    (root / "photos").mkdir()
    for p in ("p001", "p002"):
        Image.new("RGB", (W, H), (120, 120, 120)).save(root / "photos" / f"{p}.jpg")
    ass = {"photos": statuses or {"p001": {"status": "finding"}, "p002": {"status": "none"}}}
    if findings is not None:
        ass["findings"] = findings
    (root / "assessment.json").write_text(json.dumps(ass))
    if mask:
        (root / "masks").mkdir()
        m = np.zeros((H, W), np.uint8)
        m[300:450, 440:560] = 2
        Image.fromarray(m, "L").save(root / "masks" / "p001.png")
    job = {
        "job": {"id": "t", "title": "Test", "profile": profile},
        "inputs": {"model": "model.glb", "cameras": "cameras.json", "assessment": "assessment.json",
                   "masks": "masks", "surface": "surface.json"},
        "asset": {"height": 20.0},
    }  # fmt: skip
    (root / "job.yaml").write_text(yaml.safe_dump(job))
    return root


BOX = [450, 325, 550, 425]


def test_point_placement_puts_a_pin_on_the_surface_facing_the_camera(project):
    kit_project(
        project, findings=[{"id": "f1", "photo": "p001", "class": "corrosion", "severity": 2, "bbox": BOX}]
    )
    result, rec = run_job(AikProject(), project, {})
    assert result["outputs"]["project"] == {"out": "surface.json", "patches": 0, "points": 1, "unmapped": 0}
    surf = json.loads((project / "surface.json").read_text())
    pt = surf["points"][0]
    assert pt["finding"] == "f1"
    assert pt["center"] == pytest.approx([2.0, 10.0, 0.0], abs=0.5)  # median-distance hit of the box grid
    assert pt["normal"] == pytest.approx([1, 0, 0], abs=0.1)
    assert pt["component"] == "Stack shell"


def test_a_box_that_misses_the_model_is_unmapped(project):
    kit_project(
        project, findings=[{"id": "f1", "photo": "p001", "class": "corrosion", "bbox": [0, 0, 40, 40]}]
    )
    run_job(AikProject(), project, {})
    surf = json.loads((project / "surface.json").read_text())
    assert surf["unmapped"] == ["f1"] and surf["points"] == []


def test_patch_placement_projects_the_mask_onto_the_mesh(project):
    kit_project(project, profile="stack", mask=True)
    result, _ = run_job(AikProject(), project, {"grid": 16})
    surf = json.loads((project / "surface.json").read_text())
    assert len(surf["patches"]) == 1
    pa = surf["patches"][0]
    assert (
        pa["photo"] == "p001"
        and pa["vertexCount"] > 0
        and pa["textureData"].startswith("data:image/png;base64,")
    )
    pos = np.frombuffer(__import__("base64").b64decode(pa["positions"]), np.float32).reshape(-1, 3)
    radius = np.hypot(pos[:, 0], pos[:, 2])
    assert radius == pytest.approx(np.full(len(radius), 2.0), abs=0.05)  # on the shell
    assert pa["sourceCrop"] == [440, 300, 560, 450]


def test_records_numbers_findings_from_the_top_and_writes_csv(project):
    findings = [
        {"id": "low", "photo": "p001", "class": "corrosion", "severity": 1, "bbox": BOX},
        {"id": "high", "photo": "p002", "class": "fastener", "severity": 3, "bbox": BOX},
    ]
    kit_project(
        project, findings=findings, statuses={"p001": {"status": "finding"}, "p002": {"status": "finding"}}
    )
    run_job(AikProject(), project, {}, job_id="place")
    result, rec = run_job(AikRecords(), project, {}, job_id="rec")
    stats = result["outputs"]["build"]["stats"]
    assert stats["findings"] == 2 and stats["mapped"] == 2 and stats["photos"] == 2
    doc = json.loads((project / "records.json").read_text())
    by = {f["key"]: f for f in doc["findings"]}
    assert by["high"]["fid"] == "F01" and by["low"]["fid"] == "F02"  # top of the asset first
    assert by["low"]["side"] == "N" and by["low"]["height"] == pytest.approx(10, abs=0.5)
    assert by["high"]["side"] == "E"
    csv = (project / "findings.csv").read_text(encoding="utf-8-sig")
    assert csv.splitlines()[0].startswith("finding_id,defect_id,photo_id")
    assert len(csv.splitlines()) == 3


def test_records_without_cameras_explains_what_to_run_first(project):
    (project / "job.yaml").write_text(yaml.safe_dump({"job": {"profile": "stack"}}))
    with pytest.raises(JobError, match="Cameras from photos"):
        run_job(AikRecords(), project, {})


def test_inline_config_and_unknown_profile(project):
    with pytest.raises(JobError, match="Unknown profile"):
        run_job(AikRecords(), project, {"config": {"job": {"profile": "spaceship"}}})
