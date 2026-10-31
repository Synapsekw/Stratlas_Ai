"""Few-shot example crops in the yes/no check of `detect.vlm` (roadmap V2)."""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest
from PIL import Image

from aio_pipelines.detect import fewshot
from aio_pipelines.detect.engine import VlmClient, run_detector
from aio_pipelines.runtime import JobError
from conftest import run_job
from fake_vlm import FakeVlm, logprob_response, text_response
from test_detect_pipeline import detector, make_project, params, pass_of, pipeline, state_file

BOX = '[{"bbox_2d": [100, 100, 400, 300], "label": "x", "note": "one"}]'


def _crop(path: Path, size=(600, 400), colour=(200, 40, 40)) -> str:
    Image.new("RGB", size, colour).save(path)
    return str(path.resolve())


def _handler(score: float = 0.9):
    def handle(body: dict):
        if body.get("logprobs"):
            return logprob_response([("Yes", math.log(score)), ("No", math.log(1 - score))])
        return text_response(BOX)

    return handle


def _images(body: dict) -> int:
    return sum(1 for p in body["messages"][0]["content"] if p["type"] == "image_url")


def _texts(body: dict) -> list[str]:
    return [p["text"] for p in body["messages"][0]["content"] if p["type"] == "text"]


# ------------------------------------------------------------------ validate


def test_validate_takes_absolute_files_and_verdicts(tmp_path):
    a = _crop(tmp_path / "a.jpg")
    got = fewshot.validate_examples([{"file": a, "verdict": "is"}, {"file": a, "verdict": "is-not"}])
    assert got == [{"file": a, "verdict": "is"}, {"file": a, "verdict": "is-not"}]
    assert fewshot.validate_examples([]) == []


@pytest.mark.parametrize(
    "bad",
    [
        "x",
        [{"file": "rel/a.jpg", "verdict": "is"}],
        [{"file": "C:/a.jpg", "verdict": "maybe"}],
        [{"file": "C:/a.jpg", "verdict": "is", "extra": 1}],
        [{"file": "C:/a.jpg"}],
        [{"file": f"C:/{i}.jpg", "verdict": "is"} for i in range(fewshot.MAX_PER_VERDICT + 1)],
    ],
)
def test_validate_refuses_bad_examples(bad):
    with pytest.raises(JobError):
        fewshot.validate_examples(bad)


# ------------------------------------------------------------------ load


def test_load_shrinks_and_orders_is_before_is_not(tmp_path):
    no = _crop(tmp_path / "no.jpg", (300, 300), (40, 40, 200))
    yes = _crop(tmp_path / "yes.png", (1200, 600))
    shots, warnings = fewshot.load_examples(
        [{"file": no, "verdict": "is-not"}, {"file": yes, "verdict": "is"}]
    )
    assert warnings == []
    assert [s.verdict for s in shots] == ["is", "is-not"]
    import io

    with Image.open(io.BytesIO(shots[0].jpeg)) as im:
        assert max(im.size) == fewshot.EXAMPLE_MAX
    with Image.open(io.BytesIO(shots[1].jpeg)) as im:
        assert im.size == (300, 300)  # never enlarged


def test_load_skips_missing_and_unreadable_files_with_a_warning(tmp_path):
    bad = tmp_path / "bad.jpg"
    bad.write_bytes(b"not an image")
    ok = _crop(tmp_path / "ok.jpg")
    shots, warnings = fewshot.load_examples(
        [
            {"file": str(tmp_path / "gone.jpg"), "verdict": "is"},
            {"file": str(bad), "verdict": "is-not"},
            {"file": ok, "verdict": "is"},
        ]
    )
    assert [s.verdict for s in shots] == ["is"]
    assert len(warnings) == 2 and all("example crop" in w for w in warnings)


def test_load_refuses_a_file_too_large_to_be_a_crop(tmp_path, monkeypatch):
    monkeypatch.setattr(fewshot, "MAX_EXAMPLE_BYTES", 10)
    shots, warnings = fewshot.load_examples([{"file": _crop(tmp_path / "a.jpg"), "verdict": "is"}])
    assert shots == [] and len(warnings) == 1


# ------------------------------------------------------------------ prompt parts


def test_check_parts_show_examples_then_the_crop_then_the_question():
    shots = [fewshot.Example("is", b"y1"), fewshot.Example("is-not", b"n1"), fewshot.Example("is-not", b"n2")]
    parts = fewshot.check_parts(shots, b"crop", "Is this rust?")
    kinds = [p["type"] for p in parts]
    assert kinds == ["text", "image_url", "text", "image_url", "image_url", "text", "image_url", "text"]
    assert parts[-1]["text"].startswith("Is this rust?") and parts[-1]["text"].endswith("Answer yes or no.")
    # the crop to judge is the last image
    assert parts[-2]["image_url"]["url"].endswith("Y3JvcA==")  # base64 of b"crop"


def test_check_parts_leave_out_a_verdict_with_no_examples():
    parts = fewshot.check_parts([fewshot.Example("is-not", b"n1")], b"crop", "Q?")
    texts = [p["text"] for p in parts if p["type"] == "text"]
    assert not any("answer is yes" in t for t in texts)
    assert any("answer is no" in t for t in texts)


# ------------------------------------------------------------------ engine


def test_without_examples_the_check_is_as_before():
    img = Image.new("RGB", (800, 600), (120, 90, 60))
    det = detector(n=1)
    with FakeVlm(_handler()) as vlm:
        run_detector(VlmClient(vlm.url), img, det)
    check = [b for b in vlm.requests if b.get("logprobs")]
    assert check and all(_images(b) == 1 for b in check)
    assert _texts(check[0]) == [
        "This is a crop from a drone inspection photo. Is this rust? Answer yes or no."
    ]


def test_with_examples_each_check_carries_them_and_detect_does_not(tmp_path):
    img = Image.new("RGB", (800, 600), (120, 90, 60))
    shots, _ = fewshot.load_examples(
        [
            {"file": _crop(tmp_path / "y.jpg"), "verdict": "is"},
            {"file": _crop(tmp_path / "n.jpg"), "verdict": "is-not"},
        ]
    )
    with FakeVlm(_handler()) as vlm:
        result = run_detector(VlmClient(vlm.url), img, detector(n=1), examples=shots)
    check = [b for b in vlm.requests if b.get("logprobs")]
    detect = [b for b in vlm.requests if not b.get("logprobs")]
    assert all(_images(b) == 1 for b in detect)
    assert check and all(_images(b) == 3 for b in check)
    assert result.candidates[0].score == pytest.approx(0.9)


# ------------------------------------------------------------------ job


def test_job_sends_the_examples_and_logs_how_many(tmp_path):
    root = make_project(tmp_path / "p")
    yes = _crop(tmp_path / "y.jpg")
    no = _crop(tmp_path / "n.jpg", colour=(40, 40, 200))
    item = {
        "where": "library",
        "detector": detector(),
        "threshold": 0.8,
        "examples": [{"file": yes, "verdict": "is"}, {"file": no, "verdict": "is-not"}],
    }
    with FakeVlm(_handler()) as vlm:
        _, rec = run_job(
            pipeline(), root, params(state_file(root, vlm.url), photos=("p1",), detectors=[item])
        )
    check = [b for b in vlm.requests if b.get("logprobs")]
    assert check and all(_images(b) == 3 for b in check)
    assert pass_of(root)["detections"]
    assert any("1 is, 1 is not" in m["message"] for m in rec.of("log"))


def test_job_runs_without_an_example_it_cannot_read(tmp_path):
    root = make_project(tmp_path / "p")
    item = {
        "where": "library",
        "detector": detector(),
        "threshold": 0.8,
        "examples": [{"file": str((tmp_path / "gone.jpg").resolve()), "verdict": "is-not"}],
    }
    with FakeVlm(_handler()) as vlm:
        _, rec = run_job(
            pipeline(), root, params(state_file(root, vlm.url), photos=("p1",), detectors=[item])
        )
    check = [b for b in vlm.requests if b.get("logprobs")]
    assert check and all(_images(b) == 1 for b in check)
    assert any("example crop" in m["message"] for m in rec.of("log"))


def test_validate_refuses_bad_examples_in_an_item(tmp_path):
    root = make_project(tmp_path / "p")
    item = {
        "where": "library",
        "detector": detector(),
        "threshold": 0.8,
        "examples": [{"file": "x", "verdict": "is"}],
    }
    with pytest.raises(JobError):
        pipeline().validate(params(state_file(root, "http://127.0.0.1:1"), detectors=[item]))


def test_validate_keeps_examples_and_items_without_them(tmp_path):
    root = make_project(tmp_path / "p")
    yes = _crop(tmp_path / "y.jpg")
    items = [
        {
            "where": "library",
            "detector": detector(),
            "threshold": 0.8,
            "examples": [{"file": yes, "verdict": "is"}],
        },
        {"where": "project", "detector": detector("bolts", "bolt"), "threshold": 0.5},
    ]
    got = pipeline().validate(params(state_file(root, "http://127.0.0.1:1"), detectors=items))
    assert got["detectors"][0]["examples"] == [{"file": yes, "verdict": "is"}]
    assert "examples" not in got["detectors"][1]
    json.dumps(got)
