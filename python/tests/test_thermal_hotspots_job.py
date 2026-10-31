"""The ``thermal.hotspots`` job on a project with decoded rasters (thermal plan task 3.3)."""

from __future__ import annotations

import json
import math

import numpy as np
import pytest
from PIL import Image

from aio_pipelines.pipelines import all_pipelines
from aio_pipelines.runtime import JobError
from aio_pipelines.thermal import raster
from conftest import run_job
from test_inspection import look_q

W, H = 160, 128


def pipeline():
    return all_pipelines()["thermal.hotspots"]


def temps(spots=((70, 60),), seed=0):
    c = (30 + np.random.default_rng(seed).normal(0, 0.3, (H, W))).astype(np.float32)
    for x, y in spots:
        c[y : y + 3, x : x + 3] = 85.0
    return c


def make_project(root, rasters, statuses=None, posed=False, classes=()):
    root.mkdir(parents=True, exist_ok=True)
    (root / "photos").mkdir(exist_ok=True)
    items, index = [], {}
    for k, pid in enumerate(rasters):
        Image.new("RGB", (W, H)).save(root / "photos" / f"{pid}.jpg")
        item = {"id": pid, "src": {"path": f"photos/{pid}.jpg"}}
        if posed:
            a = 2 * math.pi * k / len(rasters)
            pos = [10 * math.cos(a), 8.0, 10 * math.sin(a)]
            item.update(pos=pos, q=look_q(pos, [0, 0, 0]), lens={"model": "pinhole", "hfovDeg": 45.0})
        items.append(item)
    for pid in statuses or {}:
        items.append({"id": pid, "src": {"path": f"photos/{pid}.jpg"}})
    folder = root / "thermal" / "rasters" / "th"
    folder.mkdir(parents=True, exist_ok=True)
    for pid, c in rasters.items():
        raster.write(folder, pid, c, {"schema": "aio.thermalRaster/1", "width": W, "height": H})
        index[pid] = {"status": "ok"}
    for pid, status in (statuses or {}).items():
        index[pid] = {"status": status, "reason": "test"}
    (folder / "index.json").write_text(json.dumps({"schema": "aio.thermalRaster/1", "photos": index}))
    manifest = {
        "schema": "aio.project/1", "origin": [0, 0, 0],
        "layers": [{"id": "th", "kind": "photos", "items": items}],
        "classCatalogues": [{"assetType": "x", "classes": [{"id": c, "label": c} for c in classes]}],
    }  # fmt: skip
    (root / "manifest.json").write_text(json.dumps(manifest))
    return root


PARAMS = {"layerId": "th", "rule": "delta", "thresholdC": 4.0}


def pass_of(root):
    return json.loads((root / "detections" / "thermal-th.json").read_text("utf-8"))


def test_hot_spots_become_draft_detections_and_candidates(tmp_path):
    root = make_project(
        tmp_path / "p", {"a": temps(), "b": temps(((20, 20), (120, 90)))}, {"c": "unsupported"}
    )
    result, rec = run_job(pipeline(), root, dict(PARAMS))
    out = result["outputs"]["commit"]
    assert out == {"pass": "detections/thermal-th.json", "candidates": 3, "photos": 2, "skipped": 1}
    cand = json.loads((root / "thermal" / "candidates.json").read_text("utf-8"))
    assert cand["schema"] == "aio.thermalCandidates/1"
    assert len(cand["candidates"]) == 3
    c0 = next(c for c in cand["candidates"] if c["photo"] == "a")
    assert c0["box"] == {"type": "box", "x": 70, "y": 60, "w": 3, "h": 3}
    assert c0["deltaC"] == pytest.approx(55.0, abs=0.2)
    doc = pass_of(root)
    assert doc["schema"] == "aio.detections/1" and doc["source"] == "model" and doc["layer"] == "th"
    assert doc["assessed"] == ["a", "b"]
    d = next(d for d in doc["detections"] if d["photo"] == "a")
    assert d["class"] == "hot-spot" and d["label"] == "Hot spot" and d["suggestedNew"] is True
    assert d["status"] == "draft" and d["severity"] == "uncertain"
    assert d["bbox"] == [70, 60, 73, 63] and d["space"] == "source" and (d["width"], d["height"]) == (W, H)
    assert [f["key"] for f in d["fields"]] == ["peak_c", "delta_c", "reference_c", "mean_c"]
    assert d["fields"][0] == {"key": "peak_c", "label": "Peak", "type": "number", "value": 85.0, "unit": "°C"}
    assert d["note"].startswith("Peak 85.0 °C, 55.")
    assert "vote" not in d  # unposed photos: no vote
    assert any("1 photos have no temperatures" in m["message"] for m in rec.of("log"))


def test_a_known_class_is_used_as_it_is(tmp_path):
    root = make_project(tmp_path / "p", {"a": temps()}, classes=("hot-spot",))
    run_job(pipeline(), root, dict(PARAMS))
    d = pass_of(root)["detections"][0]
    assert d["class"] == "hot-spot" and "suggestedNew" not in d and "label" not in d


def test_a_rerun_keeps_reviewed_detections_and_replaces_drafts(tmp_path):
    root = make_project(tmp_path / "p", {"a": temps(((70, 60), (20, 20))), "b": temps()})
    run_job(pipeline(), root, dict(PARAMS), job_id="j1")
    doc = pass_of(root)
    assert len(doc["detections"]) == 3
    accepted = next(d for d in doc["detections"] if d["photo"] == "a" and d["bbox"][0] == 70)
    accepted["status"] = "accepted"
    accepted["issueId"] = "i1"
    on_b = next(d for d in doc["detections"] if d["photo"] == "b")
    (root / "detections" / "thermal-th.json").write_text(json.dumps(doc))
    run_job(pipeline(), root, {**PARAMS, "photos": ["a"]}, job_id="j2")
    dets = pass_of(root)["detections"]
    # the accepted one stays as it was, the other draft on a is found again, b is untouched
    assert accepted in dets
    assert on_b in dets
    on_a = [d for d in dets if d["photo"] == "a"]
    assert len(on_a) == 2
    assert {d["id"].split("-")[1] for d in on_a} == {"j1", "j2"}


def test_photos_without_rasters_fail_with_a_sentence(tmp_path):
    root = make_project(tmp_path / "p", {}, {"c": "implausible"})
    with pytest.raises(JobError, match="None of these photos has temperatures"):
        run_job(pipeline(), root, dict(PARAMS))


def test_a_hot_spot_seen_in_posed_photos_is_voted(tmp_path):
    # three photos around the origin, the hot spot at the image centre of each: one object
    c = temps(((W // 2 - 1, H // 2 - 1),))
    root = make_project(tmp_path / "p", {"a": c, "b": c.copy(), "e": c.copy()}, posed=True)
    result, _ = run_job(pipeline(), root, dict(PARAMS))
    dets = pass_of(root)["detections"]
    assert len(dets) == 1
    assert dets[0]["vote"]["views"] == 3 and dets[0]["vote"]["placedOn"] == "rays"
    assert result["outputs"]["commit"]["candidates"] == 1


def test_a_rerun_on_another_photo_joins_the_kept_draft_of_the_same_object(tmp_path):
    c = temps(((W // 2 - 1, H // 2 - 1),))
    root = make_project(tmp_path / "p", {"a": c, "b": c.copy(), "e": c.copy()}, posed=True)
    run_job(pipeline(), root, {**PARAMS, "photos": ["a"]}, job_id="j1")
    assert len(pass_of(root)["detections"]) == 1
    result, _ = run_job(pipeline(), root, {**PARAMS, "photos": ["b"]}, job_id="j2")
    dets = pass_of(root)["detections"]
    assert len(dets) == 1 and dets[0]["photo"] == "a"
    assert dets[0]["vote"]["views"] == 2 and dets[0]["vote"]["sightings"][0]["photo"] == "b"
    assert result["outputs"]["commit"]["candidates"] == 0


def test_a_rerun_never_revives_a_reviewed_object(tmp_path):
    c = temps(((W // 2 - 1, H // 2 - 1),))
    root = make_project(tmp_path / "p", {"a": c, "b": c.copy(), "e": c.copy()}, posed=True)
    run_job(pipeline(), root, {**PARAMS, "photos": ["a"]}, job_id="j1")
    doc = pass_of(root)
    doc["detections"][0]["status"] = "accepted"
    (root / "detections" / "thermal-th.json").write_text(json.dumps(doc))
    run_job(pipeline(), root, {**PARAMS, "photos": ["b", "e"]}, job_id="j2")
    dets = pass_of(root)["detections"]
    assert dets == doc["detections"]  # b and e saw the same object: nothing new to review


def test_the_sightings_of_a_reviewed_detection_count_as_reviewed(tmp_path):
    # unposed photos: no vote, so only the boxes tell; the reviewed one carries b's box as a sighting
    root = make_project(tmp_path / "p", {"a": temps(), "b": temps()})
    run_job(pipeline(), root, {**PARAMS, "photos": ["a"]}, job_id="j1")
    doc = pass_of(root)
    d = doc["detections"][0]
    d["status"] = "rejected"
    d["vote"] = {"views": 2, "sightings": [{"photo": "b", "bbox": d["bbox"], "space": "source",
                                             "width": W, "height": H}]}  # fmt: skip
    (root / "detections" / "thermal-th.json").write_text(json.dumps(doc))
    run_job(pipeline(), root, {**PARAMS, "photos": ["b"]}, job_id="j2")
    assert pass_of(root)["detections"] == doc["detections"]


def test_a_merged_hot_spot_reports_its_hottest_view(tmp_path):
    hot, cooler = temps(((W // 2 - 1, H // 2 - 1),)), temps(((W // 2 - 1, H // 2 - 1),))
    cooler[H // 2 - 1 : H // 2 + 2, W // 2 - 1 : W // 2 + 2] = 60.0
    root = make_project(tmp_path / "p", {"a": cooler, "b": hot, "e": cooler.copy()}, posed=True)
    run_job(pipeline(), root, dict(PARAMS))
    dets = pass_of(root)["detections"]
    assert len(dets) == 1
    assert dets[0]["photo"] == "b"
    assert dets[0]["fields"][0]["value"] == pytest.approx(85.0)
    s = dets[0]["vote"]["sightings"][0]
    assert s["fields"][0]["value"] == pytest.approx(60.0) and (s["width"], s["height"]) == (W, H)


@pytest.mark.parametrize(
    "bad",
    [
        {"rule": "hot"},
        {"thresholdC": "4"},
        {"thresholdC": 0},
        {"photos": []},
        {"layerId": "../x"},
        {"minAreaPx": 0},
        {"maxPerPhoto": True},
        {"extra": 1},
    ],
)
def test_validate_refuses_bad_params(bad):
    with pytest.raises(JobError):
        pipeline().validate({**PARAMS, **bad})


def test_validate_accepts_the_absolute_rule():
    assert (
        pipeline().validate({**PARAMS, "rule": "absolute", "thresholdC": 60, "maxPerPhoto": 5})["rule"]
        == "absolute"
    )
