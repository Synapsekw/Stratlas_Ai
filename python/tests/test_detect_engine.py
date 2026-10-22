"""Tests for the vlm detector engine, against a fake llama-server (no GPU, no network)."""

import json
import socket

import pytest
from PIL import Image

from aio_pipelines.detect.engine import (
    Candidate,
    VlmClient,
    VlmUnavailable,
    check_prompt,
    detect_prompt,
    merge,
    parse_boxes,
    run_detector,
    score_from_top,
    tile_grid,
)
from fake_vlm import FakeVlm, logprob_response, text_response

DET = {
    "looksLike": "orange-brown rust on steel",
    "ignore": "intact painted bands",
    "question": "Is there rust in it?",
    "classId": "corrosion",
    "tiles": {"n": 2, "overlap": 0.2, "sendW": 1344, "sendH": 1008},
    "threshold": 0.8,
}
ONE_TILE = {**DET, "tiles": {"n": 1, "overlap": 0.2, "sendW": 1344, "sendH": 1008}}
YES = [("Yes", -0.01), ("No", -4.5)]


def cand(box, note="x"):
    return Candidate(box=box, note=note)


def boxes_json(*boxes):
    items = ", ".join(f'{{"bbox_2d": {list(b)}, "label": "corrosion", "note": "n"}}' for b in boxes)
    return f"[{items}]"


def tile_handler(reply):
    """Detect calls answer ``reply`` (a string, or an iterator of strings); check calls answer yes."""

    def handler(req):
        if req.get("logprobs"):
            return logprob_response(YES)
        return text_response(reply if isinstance(reply, str) else next(reply))

    return handler


def test_tile_grid_2x2_overlap():
    tiles = tile_grid(2560, 1920, 2, 0.2)
    assert len(tiles) == 4
    assert {(t[2], t[3]) for t in tiles} == {(1422, 1066)}
    assert {t[0] for t in tiles} == {0, 1138}
    assert {t[1] for t in tiles} == {0, 854}
    assert max(x + w for x, _, w, _ in tiles) == 2560
    assert max(y + h for _, y, _, h in tiles) == 1920


def test_tile_grid_n1_is_whole_image():
    assert tile_grid(2560, 1920, 1, 0.2) == [(0, 0, 2560, 1920)]


def test_prompts_follow_the_template():
    p = detect_prompt(DET)
    assert "Find: orange-brown rust on steel\nDo NOT report: intact painted bands\n" in p
    assert '"label": "corrosion"' in p
    assert p.endswith("Output [] if there is none.")
    assert "Do NOT report" not in detect_prompt({**DET, "ignore": ""})
    assert check_prompt(DET) == (
        "This is a crop from a drone inspection photo. Is there rust in it? Answer yes or no."
    )


def test_parse_fenced_and_bare_json():
    bare = '[{"bbox_2d": [1, 2, 30, 40], "label": "c", "note": "n"}]'
    assert parse_boxes(bare) == [([1.0, 2.0, 30.0, 40.0], "n")]
    assert parse_boxes(f"```json\n{bare}\n```") == [([1.0, 2.0, 30.0, 40.0], "n")]


def test_parse_garbage_is_none():
    assert parse_boxes("I see rust") is None
    assert parse_boxes("[]") == []


def test_parse_drops_non_finite_numbers():
    # Python's json reads NaN and Infinity; a pass file must never hold them
    reply = (
        '[{"bbox_2d": [NaN, 2, 30, 40]}, {"bbox_2d": [1, Infinity, 30, 40]},'
        ' {"bbox_2d": [1, 2, -Infinity, 40]}, {"bbox_2d": [1, 2, 30, 1e999]},'
        ' {"bbox_2d": ["nan", 2, 30, 40]}, {"bbox_2d": [5, 6, 70, 80], "note": "ok"}]'
    )
    assert parse_boxes(reply) == [([5.0, 6.0, 70.0, 80.0], "ok")]


def test_merge_drops_mostly_inside():
    big = cand((0, 0, 100, 100))
    # The small box is 100 x 10; 70 px of it lies inside the big one.
    assert merge([big, cand((30, 40, 130, 50))]) == [big]
    kept = merge([big, cand((50, 40, 150, 50))])
    assert len(kept) == 2
    assert kept[0] is big


def test_score_case_variants():
    top = [
        {"token": "Yes", "logprob": -0.01},
        {"token": "No", "logprob": -4.5},
        {"token": " yes", "logprob": -7.7},
    ]
    assert score_from_top(top) == pytest.approx(0.989, abs=0.001)
    assert score_from_top([{"token": "maybe", "logprob": -0.1}]) is None


def test_run_detector_maps_tiles_to_source():
    img = Image.new("RGB", (2560, 1920), (120, 120, 120))
    with FakeVlm(tile_handler(boxes_json([100, 100, 300, 300]))) as fake:
        res = run_detector(VlmClient(fake.url), img, DET)
    assert not res.failed
    sx, sy = 1422 / 1344, 1066 / 1008
    want = (1138 + 100 * sx, 854 + 100 * sy, 1138 + 300 * sx, 854 + 300 * sy)
    assert any(all(abs(a - b) < 0.5 for a, b in zip(c.box, want, strict=True)) for c in res.candidates)
    assert len(res.candidates) == 4
    assert all(c.score == pytest.approx(0.989, abs=0.001) for c in res.candidates)
    first = fake.requests[0]
    assert first["temperature"] == 0
    parts = first["messages"][0]["content"]
    assert [p["type"] for p in parts] == ["image_url", "text"]
    assert parts[0]["image_url"]["url"].startswith("data:image/jpeg;base64,")
    check = next(r for r in fake.requests if r.get("logprobs"))
    assert (check["top_logprobs"], check["max_tokens"]) == (10, 1)


def test_out_of_frame_boxes_are_clamped():
    img = Image.new("RGB", (1344, 1008))
    reply = boxes_json([1200, 900, 1500, 1100], [1400, 1100, 1500, 1200])
    with FakeVlm(tile_handler(reply)) as fake:
        res = run_detector(VlmClient(fake.url), img, ONE_TILE)
    assert [c.box for c in res.candidates] == [(1200.0, 900.0, 1344.0, 1008.0)]
    assert any("outside" in w for w in res.warnings)


def test_fraction_boxes_are_detected_and_warned():
    img = Image.new("RGB", (1344, 1008))
    with FakeVlm(tile_handler(boxes_json([0.25, 0.25, 0.5, 0.5]))) as fake:
        res = run_detector(VlmClient(fake.url), img, ONE_TILE)
    assert res.candidates[0].box == (336.0, 252.0, 672.0, 504.0)
    assert "model answered in fractions" in res.warnings


def test_tiny_boxes_are_dropped():
    img = Image.new("RGB", (1344, 1008))
    with FakeVlm(tile_handler(boxes_json([10, 10, 15, 15]))) as fake:
        res = run_detector(VlmClient(fake.url), img, ONE_TILE)
    assert res.candidates == []
    assert not res.failed


def test_unparseable_tile_retried_once_then_warned():
    img = Image.new("RGB", (1344, 1008))
    with FakeVlm(lambda req: text_response("I see rust")) as fake:
        res = run_detector(VlmClient(fake.url), img, ONE_TILE)
    assert len(fake.requests) == 2
    assert res.candidates == []
    assert res.warnings


def test_retry_recovers_a_tile():
    img = Image.new("RGB", (1344, 1008))
    replies = iter(["garbage", boxes_json([100, 100, 300, 300])])
    with FakeVlm(tile_handler(replies)) as fake:
        res = run_detector(VlmClient(fake.url), img, ONE_TILE)
    assert len(res.candidates) == 1
    assert not res.failed
    assert res.warnings == []


def test_all_tiles_failed_marks_failed():
    img = Image.new("RGB", (2560, 1920))
    with FakeVlm(lambda req: text_response("nope")) as fake:
        res = run_detector(VlmClient(fake.url), img, DET)
    assert res.failed
    assert len(fake.requests) == 8
    assert len(res.warnings) == 4


def test_unscored_when_check_has_no_yes_no():
    img = Image.new("RGB", (1344, 1008))

    def handler(req):
        if req.get("logprobs"):
            return logprob_response([("maybe", -0.1)], "maybe")
        return text_response(boxes_json([100, 100, 300, 300]))

    with FakeVlm(handler) as fake:
        res = run_detector(VlmClient(fake.url), img, ONE_TILE)
    assert res.candidates[0].score is None


def test_connection_refused_raises_unavailable():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    with pytest.raises(VlmUnavailable):
        VlmClient(f"http://127.0.0.1:{port}").chat(b"x", "hi")


def test_api_key_is_sent_as_bearer():
    with FakeVlm(lambda req: text_response("[]")) as fake:
        VlmClient(fake.url, api_key="k3y").chat(b"x", "hi")
        VlmClient(fake.url).chat(b"x", "hi")
    assert fake.headers[0]["Authorization"] == "Bearer k3y"
    assert "Authorization" not in fake.headers[1]


def test_requests_bypass_any_proxy(monkeypatch):
    # An unreachable proxy: if the call went through it, the chat would fail.
    for var in ("HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"):
        monkeypatch.setenv(var, "http://127.0.0.1:9")
    monkeypatch.delenv("NO_PROXY", raising=False)
    monkeypatch.delenv("no_proxy", raising=False)
    with FakeVlm(lambda req: text_response("[]")) as fake:
        text, _ = VlmClient(fake.url).chat(b"x", "hi")
    assert text == "[]"
    assert len(fake.requests) == 1


def test_detect_and_check_use_their_own_timeouts(monkeypatch):
    from aio_pipelines.detect import engine

    seen: list[tuple[bool, float]] = []
    real_open = engine._OPENER.open

    def recording_open(req, timeout=None):
        seen.append((bool(json.loads(req.data).get("logprobs")), timeout))
        return real_open(req, timeout=timeout)

    monkeypatch.setattr(engine._OPENER, "open", recording_open)
    img = Image.new("RGB", (800, 600), (120, 90, 60))
    with FakeVlm(tile_handler(boxes_json([100, 100, 300, 300]))) as fake:
        run_detector(VlmClient(fake.url), img, ONE_TILE)
    assert seen
    assert {t for is_check, t in seen if not is_check} == {120}
    assert {t for is_check, t in seen if is_check} == {60}
