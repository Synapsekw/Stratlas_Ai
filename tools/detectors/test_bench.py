"""Tests for the detector bench: a synthetic project in tmp and the fake llama-server."""

import base64
import hashlib
import io
import json
import sys
from pathlib import Path

import pytest
from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parents[1] / "python" / "tests"))

import bench  # noqa: E402
from fake_vlm import FakeVlm, logprob_response, text_response  # noqa: E402

W, H = 392, 280  # a multiple of 28 each, so one tile is sent as it is
CLASS = "cls-a"


def _tune(photo_id: str) -> bool:
    return int(hashlib.sha1(photo_id.encode()).hexdigest(), 16) % 10 < 3


def _ids(want_tune: bool, n: int) -> list[str]:
    out, i = [], 0
    while len(out) < n:
        pid = f"ph-{i}"
        if _tune(pid) == want_tune:
            out.append(pid)
        i += 1
    return out


def _photo(path: Path, square: tuple[int, int, int, int] | None) -> None:
    img = Image.new("RGB", (W, H), (40, 40, 40))
    if square:
        img.paste((255, 0, 0), square)
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, "JPEG", quality=95)


def _red_box(jpeg: bytes) -> list[float] | None:
    img = Image.open(io.BytesIO(jpeg)).convert("RGB")
    xs, ys = [], []
    for y in range(img.height):
        for x in range(img.width):
            r, g, b = img.getpixel((x, y))
            if r > 200 and g < 80 and b < 80:
                xs.append(x)
                ys.append(y)
    return [min(xs), min(ys), max(xs) + 1, max(ys) + 1] if xs else None


def _handler(body: dict) -> dict:
    url = body["messages"][0]["content"][0]["image_url"]["url"]
    jpeg = base64.b64decode(url.split(",", 1)[1])
    if body.get("logprobs"):
        return logprob_response([("Yes", -0.05), ("No", -3.0)])
    box = _red_box(jpeg)
    if box is None:
        return text_response("[]")
    return text_response(json.dumps([{"bbox_2d": box, "label": CLASS, "note": "red square"}]))


DETECTOR = {
    "schema": "aio.vlm-detector/1",
    "id": "red-square",
    "name": "Red square",
    "version": 1,
    "classId": CLASS,
    "looksLike": "a red square",
    "ignore": "",
    "question": "Is there a red square?",
    "tiles": {"n": 1, "overlap": 0.2, "sendW": W, "sendH": H},
}


def _sighting(pid: str, geom: dict) -> dict:
    return {"on": "image", "layer": "ph", "photo": pid, "geom": geom}


def _box(x: int, y: int, w: int, h: int) -> dict:
    return {"type": "box", "x": x, "y": y, "w": w, "h": h}


@pytest.fixture
def project(tmp_path: Path) -> dict:
    """10 bench photos with 4 truth boxes (one missed by the model) and a distractor square, plus a
    tune photo whose truth must be skipped."""
    root = tmp_path / "proj"
    ids = _ids(False, 10)
    tune_id = _ids(True, 1)[0]
    squares = {
        ids[0]: (50, 50, 90, 90),  # truth: issue box
        ids[1]: (200, 100, 260, 160),  # truth: issue polygon
        ids[2]: (100, 150, 140, 190),  # truth: accepted detection, source space at 2x
        ids[4]: (300, 200, 340, 240),  # distractor: no truth
        tune_id: (10, 10, 50, 50),
    }
    items = []
    for pid in [*ids, tune_id]:
        _photo(root / "photos" / f"{pid}.jpg", squares.get(pid))
        items.append({"id": pid, "src": {"path": f"photos/{pid}.jpg"}})
    manifest = {"schema": "aio.project/1", "layers": [{"id": "ph", "kind": "photos", "items": items}]}
    (root / "manifest.json").write_text(json.dumps(manifest))

    polygon = {
        "type": "polygon",
        "points": [{"x": 200, "y": 100}, {"x": 260, "y": 100}, {"x": 260, "y": 160}],
    }
    issues = [
        {"id": "i1", "classId": CLASS, "sightings": [_sighting(ids[0], _box(50, 50, 40, 40))]},
        {
            "id": "i2",
            "classId": CLASS,
            "sightings": [
                {"on": "mesh", "layer": "m", "geom": {"type": "spoint", "p": [0, 0, 0], "n": [0, 0, 1]}},
                _sighting(ids[1], polygon),
            ],
        },
        # a truth the model misses (no square on the photo)
        {"id": "i3", "classId": CLASS, "sightings": [_sighting(ids[3], _box(10, 10, 30, 30))]},
        # another class: filtered out
        {"id": "i4", "classId": "other", "sightings": [_sighting(ids[5], _box(5, 5, 30, 30))]},
        # on a photo in the tune split: skipped under bench
        {"id": "i5", "classId": CLASS, "sightings": [_sighting(tune_id, _box(10, 10, 40, 40))]},
    ]
    (root / "issues.json").write_text(json.dumps({"schema": "aio.issues/1", "issues": issues}))
    dets = [
        {"id": "d1", "photo": ids[2], "class": CLASS, "status": "accepted", "bbox": [200, 300, 280, 380],
         "space": "source", "width": W * 2, "height": H * 2},
        {"id": "d2", "photo": ids[6], "class": CLASS, "status": "draft", "bbox": [1, 1, 20, 20],
         "space": "source", "width": W, "height": H},
        {"id": "d3", "photo": ids[7], "class": CLASS, "status": "rejected", "bbox": [1, 1, 20, 20],
         "space": "source", "width": W, "height": H},
    ]  # fmt: skip
    (root / "detections").mkdir()
    pass_doc = {"schema": "aio.detections/1", "detections": dets}
    (root / "detections" / "pass.json").write_text(json.dumps(pass_doc))
    det_file = tmp_path / "detector.json"
    det_file.write_text(json.dumps(DETECTOR))
    return {"root": root, "ids": ids, "tune_id": tune_id, "detector": det_file, "out": tmp_path / "out"}


def _run(project: dict, url: str, *extra: str, split: str = "bench") -> dict:
    code = bench.main(
        [
            "--project", str(project["root"]),
            "--detector", str(project["detector"]),
            "--server", url,
            "--split", split,
            "--truth-class", CLASS,
            "--out", str(project["out"]),
            *extra,
        ]
    )  # fmt: skip
    assert code == 0
    return json.loads((project["out"] / "report.json").read_text("utf-8"))


def test_split_is_stable_and_30_percent():
    ids = [f"photo-{i}" for i in range(2000)]
    tune = [p for p in ids if bench.in_tune(p)]
    assert tune == [p for p in ids if _tune(p)]
    assert 0.27 < len(tune) / len(ids) < 0.33
    assert [bench.in_tune(p) for p in ids[:50]] == [bench.in_tune(p) for p in ids[:50]]


def test_recall_precision_and_f1_by_iou(project):
    with FakeVlm(_handler) as srv:
        report = _run(project, srv.url)
    assert report["photos"] == 10
    assert report["truth"] == 4
    assert report["found"] == report["tp"] == 3
    assert report["fp"] == 1 and report["fn"] == 1
    assert report["recall"] == pytest.approx(0.75)
    assert report["precision"] == pytest.approx(0.75)
    assert report["f1"] == pytest.approx(0.75)
    assert report["drafts"] == 4  # three hits and the distractor
    assert report["draftsPerPhoto"] == pytest.approx(0.4)
    assert report["unmatchedDrafts"] == 1
    assert report["iouMin"] == 0.3
    assert report["perClass"][CLASS]["recall"] == pytest.approx(0.75)
    # the old rule agrees here: every box is tight
    assert report["centreRule"] == {"found": 3, "recall": 0.75, "precision": 0.75, "unmatchedDrafts": 1}
    assert report["detectorVersion"] == 1 and len(report["datasetHash"]) == 64


def _huge(body: dict) -> dict:
    """A model that answers one box over the whole tile whenever it sees the square."""
    if body.get("logprobs"):
        return logprob_response([("Yes", -0.05), ("No", -3.0)])
    reply = _handler(body)
    content = reply["choices"][0]["message"]["content"]
    if content == "[]":
        return reply
    return text_response(json.dumps([{"bbox_2d": [0, 0, W, H], "label": CLASS, "note": "everything"}]))


def test_huge_boxes_pass_the_centre_rule_but_not_iou(project):
    with FakeVlm(_huge) as srv:
        report = _run(project, srv.url)
    assert report["centreRule"]["found"] == 3
    assert report["tp"] == 0 and report["recall"] == 0 and report["precision"] == 0
    drafts = json.loads((project["out"] / "drafts.json").read_text("utf-8"))
    assert all(not d["matched"] for d in drafts)
    assert sum(1 for d in drafts if d["centreMatched"]) == 3


def test_pr_curve_written(project):
    with FakeVlm(_handler) as srv:
        _run(project, srv.url)
    rows = json.loads((project["out"] / "pr.json").read_text("utf-8"))
    assert len(rows) == 21 and rows[0]["threshold"] == 0.0
    csv = (project["out"] / "pr.csv").read_text("utf-8").splitlines()
    assert csv[0] == "threshold,drafts,tp,fp,fn,precision,recall,f1" and len(csv) == 22


MODEL = "test-model"  # not a Qwen3 id, so boxes stay in sent pixels as the fake model answers


def test_write_reference_then_compare(project, tmp_path, capsys):
    ref = tmp_path / "refs" / "red-square.json"
    with FakeVlm(_handler) as srv:
        _run(project, srv.url, "--model", MODEL, "--write-reference", str(ref))
        stored = json.loads(ref.read_text("utf-8"))
        assert stored["schema"] == "aio.detector-bench-ref/1"
        assert stored["detector"] == "red-square" and stored["model"] == MODEL
        assert stored["metrics"]["f1"] == pytest.approx(0.75)
        _run(project, srv.url, "--model", MODEL, "--compare", str(ref))
        assert "Within 0.05" in capsys.readouterr().out
        stored["metrics"]["recall"] = 0.95
        ref.write_text(json.dumps(stored), "utf-8")
        code = bench.main(
            ["--project", str(project["root"]), "--detector", str(project["detector"]), "--server", srv.url,
             "--model", MODEL, "--split", "bench", "--truth-class", CLASS,
             "--out", str(project["out"]), "--compare", str(ref)]
        )  # fmt: skip
    assert code == 1
    assert "REGRESSION: recall" in capsys.readouterr().err
    compared = json.loads((project["out"] / "compare.json").read_text("utf-8"))
    assert compared["status"] == "regression"


def test_several_projects_add_up(project, tmp_path):
    import shutil

    twin = tmp_path / "twin"
    shutil.copytree(project["root"], twin)
    with FakeVlm(_handler) as srv:
        report = _run(project, srv.url, "--project", str(twin))
    assert report["photos"] == 20 and report["truth"] == 8 and report["tp"] == 6


def test_polygon_truth_uses_bounds_centre():
    poly = {"type": "polygon", "points": [{"x": 0, "y": 0}, {"x": 10, "y": 0}, {"x": 10, "y": 2}]}
    truth = bench.truth_box(poly)
    assert truth == (0, 0, 10, 2)
    assert bench.centre(truth) == (5, 1)
    assert bench.truth_box({"type": "polygon", "points": [[0, 0], [4, 0], [4, 6]]}) == (0, 0, 4, 6)


def test_threshold_drops_low_scores_from_hits(project):
    def low(body: dict) -> dict:
        if body.get("logprobs"):
            return logprob_response([("Yes", -3.0), ("No", -0.05)])
        return _handler(body)

    with FakeVlm(low) as srv:
        report = _run(project, srv.url)
    assert report["found"] == 0
    assert report["drafts"] == 0
    assert report["recall"] == 0


def test_report_and_sheet_written(project):
    with FakeVlm(_handler) as srv:
        _run(project, srv.url, "--limit", "10")
    out = project["out"]
    sheet = out / "sheet-1.jpg"
    assert sheet.is_file()
    assert Image.open(sheet).size[0] > 0
    drafts = json.loads((out / "drafts.json").read_text("utf-8"))
    assert len(drafts) == 4
    assert {"photo", "box", "score", "note", "matched"} <= set(drafts[0])
    assert sum(1 for d in drafts if not d["matched"]) == 1


def test_limit_caps_photos(project):
    with FakeVlm(_handler) as srv:
        report = _run(project, srv.url, "--limit", "3")
    assert report["photos"] == 3


def test_api_key_is_sent(project):
    with FakeVlm(_handler) as srv:
        _run(project, srv.url, "--api-key", "k3y", "--limit", "1")
        assert srv.headers
        assert all(h.get("Authorization") == "Bearer k3y" for h in srv.headers)


def test_photos_off_the_review_grid_are_warned_and_counted(project, capsys):
    # truth is in review-copy pixels (long edge 2560); one portrait review copy, nine small photos
    portrait = project["root"] / "photos" / f"{project['ids'][8]}.jpg"
    Image.new("RGB", (1920, 2560), (40, 40, 40)).save(portrait, "JPEG", quality=80)
    with FakeVlm(_handler) as srv:
        report = _run(project, srv.url)
    assert report["reviewGridMismatch"] == 9
    err = capsys.readouterr().err
    assert "9 of 10 photos" in err
    assert "2560" in err


def test_model_reaches_run_detector(project, monkeypatch):
    seen = []
    real = bench.run_detector

    def spy(client, image, det, frame="pixels"):
        seen.append(frame)
        return real(client, image, det, frame=frame)

    monkeypatch.setattr(bench, "run_detector", spy)
    with FakeVlm(_handler) as srv:
        _run(project, srv.url, "--model", "qwen3.5-9b-q4_k_m", "--limit", "1")
        assert seen == ["rel1000"]
        seen.clear()
        _run(project, srv.url, "--model", "qwen2.5-vl-7b-instruct-q4_k_m", "--limit", "1")
        assert seen == ["pixels"]


def _main(project: dict, url: str, *extra: str) -> int:
    return bench.main(
        ["--project", str(project["root"]), "--detector", str(project["detector"]), "--server", url,
         "--model", MODEL, "--split", "bench", "--truth-class", CLASS, "--out", str(project["out"]), *extra]
    )  # fmt: skip


def test_a_failed_compare_does_not_become_the_baseline(project, tmp_path, capsys):
    ref = tmp_path / "ref.json"
    with FakeVlm(_handler) as srv:
        assert _main(project, srv.url, "--write-reference", str(ref)) == 0
        stored = json.loads(ref.read_text("utf-8"))
        stored["metrics"]["recall"] = 0.95
        ref.write_text(json.dumps(stored), "utf-8")
        assert _main(project, srv.url, "--compare", str(ref), "--write-reference", str(ref)) == 1
        assert json.loads(ref.read_text("utf-8"))["metrics"]["recall"] == 0.95
        assert "Not writing" in capsys.readouterr().err
        args = ("--compare", str(ref), "--write-reference", str(ref), "--force-reference")
        assert _main(project, srv.url, *args) == 1
    assert json.loads(ref.read_text("utf-8"))["metrics"]["recall"] == pytest.approx(0.75)


def test_compare_with_other_settings_is_refused(project, tmp_path, capsys):
    ref = tmp_path / "ref.json"
    with FakeVlm(_handler) as srv:
        assert _main(project, srv.url, "--write-reference", str(ref)) == 0
        assert _main(project, srv.url, "--compare", str(ref), "--iou", "0.5") == 2
    err = capsys.readouterr().err
    assert "not comparable" in err and "iouMin" in err
    assert json.loads((project["out"] / "compare.json").read_text("utf-8"))["status"] == "mismatch"


def test_duplicate_project_folder_names_are_refused(project, tmp_path, capsys):
    import shutil

    twin = tmp_path / "elsewhere" / project["root"].name
    shutil.copytree(project["root"], twin)
    code = bench.main(
        ["--project", str(project["root"]), "--project", str(twin), "--detector", str(project["detector"]),
         "--server", "http://127.0.0.1:1", "--split", "bench", "--out", str(project["out"])]
    )  # fmt: skip
    assert code == 2
    assert "share the folder name" in capsys.readouterr().err


def _truth_project(tmp_path: Path, issues: list[dict], dets: list[dict]) -> Path:
    root = tmp_path / "truth"
    (root / "detections").mkdir(parents=True)
    (root / "issues.json").write_text(json.dumps({"issues": issues}))
    (root / "detections" / "pass.json").write_text(json.dumps({"detections": dets}))
    return root


def _det(cls, bbox):
    return {"photo": "p", "class": cls, "status": "accepted", "bbox": bbox, "space": "preview"}


def test_truth_dedup_rules(tmp_path):
    issues = [
        {"classId": "rust", "sightings": [_sighting("p", _box(0, 0, 100, 100))]},
        # a second issue on the same spot is its own finding
        {"classId": "rust", "sightings": [_sighting("p", _box(10, 10, 80, 80))]},
        # another class on the same spot is never merged
        {"classId": "crack", "sightings": [_sighting("p", _box(0, 0, 100, 100))]},
    ]
    dets = [
        _det("rust", [5, 5, 100, 100]),  # IoU 0.9 with the rust issue: the same finding
        _det("paint", [0, 0, 100, 100]),  # same spot, other class: kept
        _det("rust", [50, 50, 150, 150]),  # IoU under 0.5 with every rust issue: kept
    ]
    root = _truth_project(tmp_path, issues, dets)
    truth = bench.load_truth(root, set(), {"p": (200, 200)})["p"]
    assert sorted(t["class"] for t in truth) == ["crack", "paint", "rust", "rust", "rust"]


def test_missing_classes_are_labelled_unclassified(tmp_path):
    issues = [{"sightings": [_sighting("p", _box(0, 0, 10, 10))]}]
    dets = [_det(None, [50, 50, 60, 60]), _det("", [100, 100, 110, 110])]
    root = _truth_project(tmp_path, issues, dets)
    truth = bench.load_truth(root, set(), {"p": (200, 200)})["p"]
    assert [t["class"] for t in truth] == ["unclassified"] * 3
    assert bench.class_label(None) == bench.class_label("") == "unclassified"
    assert bench.class_label("rust") == "rust"
