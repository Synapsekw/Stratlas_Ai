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


def test_recall_counts_centre_hits(project):
    with FakeVlm(_handler) as srv:
        report = _run(project, srv.url)
    assert report["photos"] == 10
    assert report["truth"] == 4
    assert report["found"] == 3
    assert report["recall"] == pytest.approx(0.75)
    assert report["drafts"] == 4  # three hits and the distractor
    assert report["draftsPerPhoto"] == pytest.approx(0.4)
    assert report["unmatchedDrafts"] == 1


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
