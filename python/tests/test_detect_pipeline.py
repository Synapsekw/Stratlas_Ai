"""The `detect.vlm` job end to end against the fake llama-server."""

from __future__ import annotations

import json
import math
import socket
import threading
from pathlib import Path

import pytest
from PIL import Image

from aio_pipelines.pipelines import all_pipelines
from aio_pipelines.runtime import Cancelled, Job, JobError
from conftest import run_job
from fake_vlm import FakeVlm, logprob_response, text_response

STOPPED = "The detector model stopped. Run the remaining photos again."
SHA = "b" * 64
KEY = "a" * 32
BOXES = (
    '[{"bbox_2d": [100, 100, 400, 300], "label": "x", "note": "small one"}, '
    '{"bbox_2d": [600, 500, 1000, 800], "label": "x", "note": "big one"}]'
)


def pipeline():
    return all_pipelines()["detect.vlm"]


def detector(det_id="rust-spots", class_id="rust", n=1, **extra) -> dict:
    return {
        "schema": "aio.vlm-detector/1",
        "id": det_id,
        "name": f"Detector {det_id}",
        "version": 2,
        "classId": class_id,
        "assetTypes": ["tower"],
        "looksLike": "rust",
        "ignore": "",
        "question": "Is this rust?",
        "tiles": {"n": n, "overlap": 0.2, "sendW": 1344, "sendH": 1008},
        "threshold": 0.8,
        "tunedOn": {"model": "m", "modelSha256": SHA},
        "author": "t",
        "createdAt": "2026-01-01T00:00:00Z",
        "updatedAt": "2026-01-01T00:00:00Z",
        "source": "user",
        "status": "verified",
        **extra,
    }


def make_project(root: Path, sizes=((400, 300), (400, 300), (400, 300)), classes=("rust", "bolt")) -> Path:
    root.mkdir(parents=True)
    items = []
    for i, (w, h) in enumerate(sizes, 1):
        (root / "photos").mkdir(exist_ok=True)
        Image.new("RGB", (w, h), (120, 90, 60)).save(root / "photos" / f"p{i}.jpg")
        items.append({"id": f"p{i}", "src": {"path": f"photos/p{i}.jpg"}})
    manifest = {
        "schema": "aio.project/1",
        "layers": [{"id": "ph", "kind": "photos", "items": items}],
        "classCatalogues": [
            {"assetType": "tower", "classes": [{"id": c, "label": c.title()} for c in classes]}
        ],
    }
    (root / "manifest.json").write_text(json.dumps(manifest), "utf-8")
    return root


def state_file(root: Path, url: str) -> str:
    p = root / "analytics-server.json"
    state = {"url": url, "pid": 4242, "apiKey": KEY, "modelSha256": SHA, "startedAt": "2026-01-01T00:00:00Z"}
    p.write_text(json.dumps(state), "utf-8")
    return str(p.resolve())


def params(server_file: str, photos=("p1", "p2", "p3"), detectors=None, **extra) -> dict:
    return {
        "run": "run-a",
        "layer": "ph",
        "photos": list(photos),
        "detectors": detectors or [{"where": "project", "detector": detector(), "threshold": 0.8}],
        "serverFile": server_file,
        "modelSha256": SHA,
        "model": "qwen-test",
        **extra,
    }


def scoring(scores):
    """A handler: boxes for a detect call, the next score for each check call."""
    state = {"i": 0}

    def handle(body: dict):
        if body.get("logprobs"):
            s = scores[state["i"] % len(scores)]
            state["i"] += 1
            return logprob_response([("Yes", math.log(s)), ("No", math.log(1 - s))])
        return text_response(BOXES)

    return handle


def pass_of(root: Path) -> dict:
    return json.loads((root / "detections" / "vlm-run-a.json").read_text("utf-8"))


def test_writes_pass_with_scores_and_threshold(tmp_path):
    root = make_project(tmp_path / "p")
    with FakeVlm(scoring([0.95, 0.6])) as vlm:
        run_job(pipeline(), root, params(state_file(root, vlm.url), photos=("p1",)))
        assert all(h.get("Authorization") == f"Bearer {KEY}" for h in vlm.headers)
    doc = pass_of(root)
    assert doc["schema"] == "aio.detections/1"
    assert doc["source"] == "model" and doc["producer"] == "qwen-test (local)" and doc["layer"] == "ph"
    assert doc["assessed"] == ["p1"]
    assert doc["run"]["id"] == "run-a" and doc["run"]["provider"] == "local"
    assert doc["run"]["promptVersion"] == "detectors"
    assert doc["run"]["images"] == 1 and doc["run"]["detections"] == 2
    dets = doc["detections"]
    assert [d["confidence"] for d in dets] == pytest.approx([0.95, 0.6])
    assert [d.get("belowThreshold") for d in dets] == [None, True]
    d = dets[0]
    assert d["id"] == "run-a-p1-rust-spots-0" and d["photo"] == "p1" and d["class"] == "rust"
    assert d["severity"] == "uncertain" and d["status"] == "draft" and d["space"] == "source"
    assert (d["width"], d["height"]) == (400, 300)
    assert d["note"] == "small one"  # listed first, checked first, highest score first
    assert d["origin"] == {
        "runId": "run-a",
        "model": "qwen-test",
        "detectorId": "rust-spots",
        "detectorVersion": 2,
        "modelSha256": SHA,
        "threshold": 0.8,
    }
    x1, y1, x2, y2 = d["bbox"]
    assert 0 <= x1 < x2 <= 400 and 0 <= y1 < y2 <= 300
    assert "unscored" not in d


def test_unscored_candidate_is_marked_and_has_no_confidence(tmp_path):
    root = make_project(tmp_path / "p")

    def handle(body):
        return text_response("no") if body.get("logprobs") else text_response(BOXES)

    with FakeVlm(handle) as vlm:
        run_job(pipeline(), root, params(state_file(root, vlm.url), photos=("p1",)))
    for d in pass_of(root)["detections"]:
        assert d["unscored"] is True and "confidence" not in d and "belowThreshold" not in d


def test_missing_photo_is_skipped_with_warning(tmp_path):
    root = make_project(tmp_path / "p")
    (root / "photos" / "p2.jpg").unlink()
    with FakeVlm(scoring([0.9])) as vlm:
        _, rec = run_job(pipeline(), root, params(state_file(root, vlm.url), photos=("p1", "p2", "ghost")))
    doc = pass_of(root)
    assert doc["assessed"] == ["p1"]
    assert {d["photo"] for d in doc["detections"]} == {"p1"}
    warnings = [m["message"] for m in rec.of("log") if m["level"] == "warn"]
    assert any("p2" in w for w in warnings) and any("ghost" in w for w in warnings)


def test_tiny_photo_runs_without_tiles_upscaling(tmp_path):
    root = make_project(tmp_path / "p", sizes=((200, 150),))
    dets = [{"where": "project", "detector": detector(n=2), "threshold": 0.8}]
    with FakeVlm(scoring([0.9])) as vlm:
        run_job(pipeline(), root, params(state_file(root, vlm.url), photos=("p1",), detectors=dets))
        detects = [r for r in vlm.requests if not r.get("logprobs")]
    assert len(detects) == 1  # n = 1, not four tiles
    assert pass_of(root)["assessed"] == ["p1"]


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_server_down_fails_with_message_and_keeps_staged_results(tmp_path):
    root = make_project(tmp_path / "p")
    cancel = threading.Event()

    def emit(method, p):
        if method == "progress" and str(p.get("message", "")).startswith("photo 2 of 3"):
            cancel.set()

    with FakeVlm(scoring([0.9])) as vlm:
        sf = state_file(root, vlm.url)
        with pytest.raises(Cancelled):
            Job("jd", pipeline(), root, params(sf), emit, cancel).run()
    results = root / "jobs" / "jd" / "staging" / "results"
    staged = sorted(results.glob("*.json"))
    assert len(staged) == 1
    state_file(root, f"http://127.0.0.1:{free_port()}")
    with pytest.raises(JobError) as e:
        run_job(pipeline(), root, params(sf), job_id="jd")
    assert str(e.value) == STOPPED
    assert sorted(results.glob("*.json")) == staged


def test_resume_skips_done_photos(tmp_path):
    root = make_project(tmp_path / "p")
    cancel = threading.Event()

    def emit(method, p):
        if method == "progress" and str(p.get("message", "")).startswith("photo 3 of 3"):
            cancel.set()

    with FakeVlm(scoring([0.9])) as vlm:
        sf = state_file(root, vlm.url)
        with pytest.raises(Cancelled):
            Job("jr", pipeline(), root, params(sf), emit, cancel).run()
        first = len(vlm.requests)
        assert first > 0
        run_job(pipeline(), root, params(sf), job_id="jr")
        later = vlm.requests[first:]
    assert later and len(later) < first  # only the third photo's calls
    doc = pass_of(root)
    assert doc["assessed"] == ["p1", "p2", "p3"]
    assert {d["photo"] for d in doc["detections"]} == {"p1", "p2", "p3"}


def test_every_photo_failed_is_an_error(tmp_path):
    root = make_project(tmp_path / "p")
    with FakeVlm(lambda body: 500) as vlm, pytest.raises(JobError) as e:
        run_job(pipeline(), root, params(state_file(root, vlm.url), photos=("p1", "p2")))
    assert "no detections" not in str(e.value).lower()
    assert not (root / "detections" / "vlm-run-a.json").exists()


def test_three_failed_in_a_row_stops_with_message(tmp_path):
    root = make_project(tmp_path / "p", sizes=((400, 300),) * 5)
    with FakeVlm(lambda body: 500) as vlm:
        sf = state_file(root, vlm.url)
        with pytest.raises(JobError) as e:
            run_job(pipeline(), root, params(sf, photos=("p1", "p2", "p3", "p4", "p5")))
        seen = len(vlm.requests)
    assert str(e.value) == STOPPED
    assert seen == 6  # three photos tried (1 tile, asked twice each), not five


def test_a_success_resets_the_failure_streak(tmp_path):
    root = make_project(tmp_path / "p", sizes=((400, 300),) * 5)
    state = {"asks": 0}

    def handle(body):
        if body.get("logprobs"):
            return logprob_response([("Yes", -0.1), ("No", -3.0)])
        state["asks"] += 1
        # photos 1, 2, 4 and 5 fail (asked twice each); photo 3 answers at its first ask
        return text_response(BOXES) if state["asks"] == 5 else 500

    with FakeVlm(handle) as vlm:
        run_job(pipeline(), root, params(state_file(root, vlm.url), photos=("p1", "p2", "p3", "p4", "p5")))
        total = len(vlm.requests)
    assert pass_of(root)["assessed"] == ["p3"]
    assert total > 6


def test_two_detectors_one_pass(tmp_path):
    root = make_project(tmp_path / "p")
    dets = [
        {"where": "project", "detector": detector("rust-spots", "rust"), "threshold": 0.8},
        {"where": "shipped", "detector": detector("loose-bolt", "bolt"), "threshold": 0.5},
    ]
    with FakeVlm(scoring([0.9, 0.4])) as vlm:
        run_job(pipeline(), root, params(state_file(root, vlm.url), photos=("p1", "p2"), detectors=dets))
    doc = pass_of(root)
    ids = [d["id"] for d in doc["detections"]]
    assert len(ids) == len(set(ids)) == 8
    assert {d["class"] for d in doc["detections"]} == {"rust", "bolt"}
    assert {d["origin"]["threshold"] for d in doc["detections"]} == {0.8, 0.5}
    assert doc["run"]["images"] == 2 and doc["run"]["detections"] == 8


def test_photo_is_assessed_only_when_every_detector_ran(tmp_path):
    root = make_project(tmp_path / "p")
    dets = [
        {"where": "project", "detector": detector("rust-spots", "rust"), "threshold": 0.8},
        {
            "where": "shipped",
            "detector": detector("loose-bolt", "bolt", looksLike="a loose bolt"),
            "threshold": 0.5,
        },
    ]
    state = {"bolt_asks": 0}

    def handle(body):
        if body.get("logprobs"):
            return logprob_response([("Yes", -0.1), ("No", -3.0)])
        if "a loose bolt" in json.dumps(body):
            state["bolt_asks"] += 1
            # the bolt detector answers on p1 and fails on p2 (asked twice)
            return text_response(BOXES) if state["bolt_asks"] == 1 else 500
        return text_response(BOXES)

    with FakeVlm(handle) as vlm:
        run_job(pipeline(), root, params(state_file(root, vlm.url), photos=("p1", "p2"), detectors=dets))
    doc = pass_of(root)
    # p2 had no bolt result: listing it would read as "checked for bolts, none found"
    assert doc["assessed"] == ["p1"]
    assert doc["run"]["images"] == 1
    # the rust candidates on p2 are still kept
    assert {(d["photo"], d["class"]) for d in doc["detections"]} == {
        ("p1", "rust"),
        ("p1", "bolt"),
        ("p2", "rust"),
    }


def test_changed_photo_refuses_resume(tmp_path):
    root = make_project(tmp_path / "p")
    with FakeVlm(scoring([0.9])) as vlm:
        sf = state_file(root, vlm.url)
        run_job(pipeline(), root, params(sf, photos=("p1", "p2")), job_id="jc")
        Image.new("RGB", (400, 300), (1, 2, 3)).save(root / "photos" / "p2.jpg")
        with pytest.raises(JobError, match="changed"):
            run_job(pipeline(), root, params(sf, photos=("p1", "p2")), job_id="jc")


@pytest.mark.parametrize(
    "mutate",
    [
        lambda p: p.update(run="nope"),
        lambda p: p.update(photos=[]),
        lambda p: p.update(detectors=[]),
        lambda p: p.update(serverFile="relative.json"),
        lambda p: p.update(modelSha256="zz"),
        lambda p: p.update(extra=1),
        lambda p: p["detectors"][0].update(threshold=1.5),
        lambda p: p["detectors"][0].update(where="elsewhere"),
        lambda p: p["detectors"][0]["detector"]["tiles"].update(sendW=1000),
        lambda p: p["detectors"][0]["detector"].update(schema="other"),
        lambda p: p["detectors"][0]["detector"].update(objectSizeM=0),
        lambda p: p["detectors"][0]["detector"].update(objectSizeM=500),
        lambda p: p["detectors"][0]["detector"].update(objectSizeM="1"),
        lambda p: p["detectors"][0]["detector"].update(objectSizeM=True),
    ],
)
def test_validate_rejects_bad_params(tmp_path, mutate):
    p = params(str((tmp_path / "s.json").resolve()))
    mutate(p)
    with pytest.raises(JobError):
        pipeline().validate(p)


def test_validate_accepts_good_params(tmp_path):
    p = params(str((tmp_path / "s.json").resolve()))
    assert pipeline().validate(dict(p))["run"] == "run-a"


def test_class_missing_from_project_suggests_new(tmp_path):
    root = make_project(tmp_path / "p", classes=("bolt",))
    det = detector("corrosion-metal", class_id="corrosion", name="Corrosion on metal")
    with FakeVlm(scoring([0.9])) as vlm:
        run_job(
            pipeline(),
            root,
            params(
                state_file(root, vlm.url),
                photos=("p1",),
                detectors=[{"where": "project", "detector": det, "threshold": 0.8}],
            ),
        )
    dets = pass_of(root)["detections"]
    assert dets
    for d in dets:
        assert d["class"] == "corrosion"
        assert d["label"] == "Corrosion on metal" and d["suggestedNew"] is True


def test_class_in_project_is_kept(tmp_path):
    root = make_project(tmp_path / "p", classes=("corrosion",))
    det = detector("corrosion-metal", class_id="corrosion", name="Corrosion on metal")
    with FakeVlm(scoring([0.9])) as vlm:
        run_job(
            pipeline(),
            root,
            params(
                state_file(root, vlm.url),
                photos=("p1",),
                detectors=[{"where": "project", "detector": det, "threshold": 0.8}],
            ),
        )
    dets = pass_of(root)["detections"]
    assert dets
    for d in dets:
        assert d["class"] == "corrosion" and "suggestedNew" not in d and "label" not in d


def test_prepare_output_without_class_ids_keeps_the_class(tmp_path):
    """A job prepared before classIds existed, then resumed: the detector's class stays as it was."""
    from dataclasses import replace

    root = make_project(tmp_path / "p", classes=("bolt",))
    real = pipeline()

    class OldPrepare:
        def __getattr__(self, name):
            return getattr(real, name)

        def plan(self, prm):
            def strip(step):
                def run(ctx):
                    out = step.run(ctx)
                    out.pop("classIds")
                    return out

                return replace(step, run=run)

            steps = real.plan(prm)
            return [strip(steps[0]), *steps[1:]]

    with FakeVlm(scoring([0.9])) as vlm:
        run_job(OldPrepare(), root, params(state_file(root, vlm.url), photos=("p1",)))
    dets = pass_of(root)["detections"]
    assert dets
    assert all(d["class"] == "rust" and "suggestedNew" not in d for d in dets)


def test_pass_lists_every_detector_of_the_run_with_its_class_as_given(tmp_path):
    root = make_project(tmp_path / "p", classes=("bolt",))
    dets = [
        {"where": "project", "detector": detector("loose-bolt", "bolt"), "threshold": 0.5},
        {
            "where": "project",
            "detector": detector("corrosion-metal", class_id="corrosion", name="Corrosion on metal"),
            "threshold": 0.8,
        },
    ]
    with FakeVlm(scoring([0.9])) as vlm:
        run_job(pipeline(), root, params(state_file(root, vlm.url), photos=("p1",), detectors=dets))
    listed = pass_of(root)["detectors"]
    assert [(d["id"], d["classId"], d["threshold"]) for d in listed] == [
        ("loose-bolt", "bolt", 0.5),
        # the class as the detector names it, not the suggested-new rewrite
        ("corrosion-metal", "corrosion", 0.8),
    ]
    assert {d["modelSha256"] for d in listed} == {SHA}
    assert listed[1]["name"] == "Corrosion on metal" and listed[0]["version"] == 2


def test_job_passes_the_box_frame_from_the_model_param(tmp_path):
    # the same reply read as 0 to 1000 (Qwen3) and as sent pixels (Qwen2.5-VL)
    out = {}
    for name, model in (("rel", "qwen3.5-9b-q4_k_m"), ("px", "qwen2.5-vl-7b-instruct-q4_k_m")):
        root = make_project(tmp_path / name)
        with FakeVlm(scoring([0.95])) as vlm:
            run_job(pipeline(), root, params(state_file(root, vlm.url), photos=("p1",), model=model))
        out[name] = {tuple(round(v) for v in d["bbox"]) for d in pass_of(root)["detections"]}
    assert (240, 150, 400, 240) in out["rel"]  # [600, 500, 1000, 800] of 1000 on a 400 x 300 photo
    assert (179, 149, 298, 238) in out["px"]  # the same numbers as pixels of the 1344 x 1008 frame


def test_validate_accepts_an_object_size(tmp_path):
    p = params(str((tmp_path / "s.json").resolve()))
    p["detectors"][0]["detector"]["objectSizeM"] = 0.5
    assert pipeline().validate(p)["detectors"][0]["detector"]["objectSizeM"] == 0.5


def test_a_capped_photo_is_counted_in_the_job_result(tmp_path):
    root = make_project(tmp_path / "p")
    many = "[" + ", ".join(f'{{"bbox_2d": [{40 * i}, 10, {40 * i + 30}, 40]}}' for i in range(31)) + "]"

    def handle(body):
        return (
            logprob_response([("Yes", -0.01), ("No", -4.5)]) if body.get("logprobs") else text_response(many)
        )

    with FakeVlm(handle) as vlm:
        result, rec = run_job(pipeline(), root, params(state_file(root, vlm.url), photos=("p1", "p2")))
    assert result["outputs"]["detect"]["capped"] == 2
    assert result["outputs"]["commit"]["capped"] == 2
    assert pass_of(root)["run"]["detections"] == 60
    assert any("more than 30 candidates" in m["message"] for m in rec.of("log") if m["level"] == "warn")


def test_tiles_follow_the_object_size_when_the_gsd_is_known(tmp_path, monkeypatch):
    from aio_pipelines.detect import pipeline as detect_pipeline

    monkeypatch.setattr(detect_pipeline, "_gsd", lambda path, w, h: 0.01)
    detects = {}
    for name, size in (("small", 0.2), ("large", 20.0)):
        root = make_project(tmp_path / name, sizes=((2688, 2016),))
        dets = [{"where": "project", "detector": detector(n=2, objectSizeM=size), "threshold": 0.8}]
        with FakeVlm(scoring([0.9])) as vlm:
            run_job(pipeline(), root, params(state_file(root, vlm.url), photos=("p1",), detectors=dets))
            detects[name] = len([r for r in vlm.requests if not r.get("logprobs")])
    assert detects == {"small": 16, "large": 1}  # 4 x 4 tiles for 20 px objects, whole for 2000 px


def test_tiles_stay_as_the_detector_says_without_a_gsd(tmp_path):
    root = make_project(tmp_path / "p", sizes=((2688, 2016),))
    dets = [{"where": "project", "detector": detector(n=2, objectSizeM=0.2), "threshold": 0.8}]
    with FakeVlm(scoring([0.9])) as vlm:
        run_job(pipeline(), root, params(state_file(root, vlm.url), photos=("p1",), detectors=dets))
        assert len([r for r in vlm.requests if not r.get("logprobs")]) == 4
