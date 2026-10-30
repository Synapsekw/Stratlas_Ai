"""Tests for the vlm detector engine, against a fake llama-server (no GPU, no network)."""

import json
import socket

import pytest
from PIL import Image

from aio_pipelines.detect.engine import (
    CAPPED_WARNING,
    MAX_CANDIDATES,
    Candidate,
    VlmClient,
    VlmUnavailable,
    box_frame,
    cap_candidates,
    check_prompt,
    choose_tiles,
    dedupe,
    detect_prompt,
    gsd_from_meta,
    parse_boxes,
    parse_boxes_ex,
    run_detector,
    score_from_top,
    suppress,
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


def cand(box, note="x", score=None):
    return Candidate(box=box, note=note, score=score)


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
    assert f"Report at most {MAX_CANDIDATES} areas, the clearest first." in p
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


def test_suppress_containment_keeps_the_higher_score():
    big, small = cand((0, 0, 100, 100), score=0.6), cand((30, 40, 60, 70), score=0.9)
    assert suppress([big, small]) == [small]
    big.score, small.score = 0.95, 0.5
    assert suppress([small, big]) == [big]


def test_suppress_containment_tie_keeps_the_smaller_box():
    big, small = cand((0, 0, 100, 100), score=0.8), cand((30, 40, 60, 70), score=0.8)
    assert suppress([big, small]) == [small]
    big.score = small.score = None
    assert suppress([big, small]) == [small]


def test_suppress_mostly_inside_counts_as_contained():
    big = cand((0, 0, 100, 100), score=0.9)
    # The small box is 100 x 10; 70 px of it lies inside the big one (share 0.7), then 50 px (0.5).
    assert suppress([big, cand((30, 40, 130, 50), score=0.5)]) == [big]
    assert len(suppress([big, cand((50, 40, 150, 50), score=0.5)])) == 2


def test_suppress_unscored_loses_to_scored():
    unscored, scored = cand((0, 0, 100, 100)), cand((10, 10, 100, 100), score=0.1)
    assert suppress([unscored, scored]) == [scored]


def test_suppress_by_iou_and_keeps_separate_boxes():
    a, b = cand((0, 0, 100, 100), score=0.7), cand((20, 0, 120, 100), score=0.9)  # IoU 0.67
    far = cand((500, 500, 600, 600), score=0.2)
    side = cand((60, 0, 160, 100), score=0.5)  # IoU 0.25, 40 % inside: both stay
    assert suppress([a, b, far]) == [b, far]
    assert suppress([a, side]) == [a, side]


def test_suppress_orders_by_score():
    boxes = [cand((i * 200, 0, i * 200 + 100, 100), score=s) for i, s in enumerate((0.2, 0.9, 0.5))]
    assert [c.score for c in suppress(boxes)] == [0.9, 0.5, 0.2]


def test_dedupe_drops_overlap_copies_in_order():
    first, copy = cand((0, 0, 100, 100), "first"), cand((2, 2, 101, 101), "copy")
    inside = cand((30, 30, 60, 60), "inside")  # contained, not a copy: left for suppress
    assert dedupe([first, copy, inside]) == [first, inside]


def test_cap_candidates_round_robin_across_tiles():
    ranked = [
        (r, t, cand((t * 100, r, t * 100 + 50, r + 50), f"{t}-{r}")) for t in range(2) for r in range(20)
    ]
    kept, capped = cap_candidates(ranked, cap=30)
    assert capped and len(kept) == 30
    assert [c.note for c in kept[:4]] == ["0-0", "1-0", "0-1", "1-1"]
    assert {c.note for c in kept} == {f"{t}-{r}" for t in range(2) for r in range(15)}
    assert cap_candidates(ranked[:5], cap=30) == ([c for _, _, c in ranked[:5]], False)


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


def test_parse_boxes_repairs_double_brace():
    got, repaired = parse_boxes_ex('[{"bbox_2d":[1,2,30,40],"note":"n"}}]')
    assert got == [([1.0, 2.0, 30.0, 40.0], "n")]
    assert repaired
    got, repaired = parse_boxes_ex('[{"bbox_2d":[1,2,30,40],"note":"n"},{"bbox_2d":[5,6,70,80]}}')
    assert [b for b, _ in got] == [[1.0, 2.0, 30.0, 40.0], [5.0, 6.0, 70.0, 80.0]]
    assert repaired
    assert parse_boxes('[{"bbox_2d":[1,2,30,40],"note":"n"}}]') == [([1.0, 2.0, 30.0, 40.0], "n")]


def test_parse_boxes_clean_reply_is_not_repaired():
    assert parse_boxes_ex('[{"bbox_2d":[1,2,30,40]}]')[1] is False
    assert parse_boxes_ex("[]") == ([], False)


def test_parse_boxes_cut_back():
    got, repaired = parse_boxes_ex('[{"bbox_2d":[1,2,30,40],"note":"a"},{"bbox_2d":[5,6,70,80],"no')
    assert got == [([1.0, 2.0, 30.0, 40.0], "a")]
    assert repaired


def test_parse_boxes_strips_think():
    reply = '<think>maybe [1, 2] here {"x": 1}</think>\n[{"bbox_2d":[1,2,30,40],"note":"n"}]'
    got, repaired = parse_boxes_ex(reply)
    assert got == [([1.0, 2.0, 30.0, 40.0], "n")]
    assert not repaired


# the same ids and answers as `localVlmModel` in apps/desktop/src/main/analytics/models.test.ts
BOX_FRAME_IDS = [
    ("qwen3.5-9b-q4_k_m", "rel1000"),
    ("qwen3-vl-4b-instruct-q4_k_m", "rel1000"),
    ("Qwen3-VL-4B-Instruct", "rel1000"),
    ("qwen3-8b-q4_k_m", "rel1000"),
    ("qwen2.5-vl-7b-instruct-q4_k_m", "pixels"),
    ("qwen-vl", "pixels"),
    ("qwen30-x", "pixels"),
    ("my-qwen3-finetune", "pixels"),
    ("anything-else", "pixels"),
]


def test_box_frame():
    for model_id, frame in BOX_FRAME_IDS:
        assert box_frame(model_id) == frame, model_id


def test_rel1000_boxes_scale_to_send_frame():
    img = Image.new("RGB", (1344, 1008))
    with FakeVlm(tile_handler('[{"bbox_2d":[500,500,750,750]}]')) as fake:
        res = run_detector(VlmClient(fake.url), img, ONE_TILE, frame="rel1000")
    assert res.candidates[0].box == pytest.approx((672.0, 504.0, 1008.0, 756.0))
    assert "model answered in fractions" not in res.warnings
    assert "reply repaired" not in res.warnings


def test_rel1000_scales_a_larger_source_by_the_tile():
    img = Image.new("RGB", (2688, 2016))
    with FakeVlm(tile_handler('[{"bbox_2d":[500,500,750,750]}]')) as fake:
        res = run_detector(VlmClient(fake.url), img, ONE_TILE, frame="rel1000")
    assert res.candidates[0].box == pytest.approx((1344.0, 1008.0, 2016.0, 1512.0))


def test_repaired_reply_adds_a_warning():
    img = Image.new("RGB", (1344, 1008))
    with FakeVlm(tile_handler('[{"bbox_2d":[100,100,300,300],"note":"n"}}]')) as fake:
        res = run_detector(VlmClient(fake.url), img, ONE_TILE)
    assert len(res.candidates) == 1
    assert "reply repaired" in res.warnings


def grid_boxes(count, per_row=10, step=40, size=30):
    return [
        (
            10 + step * (i % per_row),
            10 + step * (i // per_row),
            10 + step * (i % per_row) + size,
            10 + step * (i // per_row) + size,
        )
        for i in range(count)
    ]


def test_cap_per_tile_and_per_photo_bounds_the_checks():
    # 40 separate boxes in every tile reply: each tile keeps 30, the photo keeps 30: 30 yes/no calls
    img = Image.new("RGB", (2560, 1920), (120, 120, 120))
    with FakeVlm(tile_handler(boxes_json(*grid_boxes(40)))) as fake:
        res = run_detector(VlmClient(fake.url), img, DET)
        checks = [r for r in fake.requests if r.get("logprobs")]
    assert res.capped and CAPPED_WARNING in res.warnings
    assert len(res.candidates) == MAX_CANDIDATES == len(checks)


def test_cap_in_one_tile_keeps_the_first_answers():
    img = Image.new("RGB", (1344, 1008), (120, 120, 120))
    with FakeVlm(tile_handler(boxes_json(*grid_boxes(31, per_row=31)))) as fake:
        res = run_detector(VlmClient(fake.url), img, ONE_TILE)
    assert res.capped and len(res.candidates) == MAX_CANDIDATES
    assert max(c.box[0] for c in res.candidates) == pytest.approx(10 + 40 * 29)


def test_under_the_cap_is_not_capped():
    img = Image.new("RGB", (1344, 1008), (120, 120, 120))
    with FakeVlm(tile_handler(boxes_json([100, 100, 300, 300]))) as fake:
        res = run_detector(VlmClient(fake.url), img, ONE_TILE)
    assert not res.capped and CAPPED_WARNING not in res.warnings


def test_small_precise_box_inside_a_large_one_survives_when_it_scores_higher():
    calls = {"n": 0}

    def handler(req):
        if req.get("logprobs"):
            calls["n"] += 1  # the small box is checked first: the model listed it first
            return logprob_response(YES if calls["n"] == 1 else [("Yes", -3.0), ("No", -0.05)])
        return text_response(boxes_json([400, 400, 450, 450], [100, 100, 900, 900]))

    img = Image.new("RGB", (1344, 1008), (120, 120, 120))
    with FakeVlm(handler) as fake:
        res = run_detector(VlmClient(fake.url), img, ONE_TILE)
    assert [c.box for c in res.candidates] == [pytest.approx((400, 400, 450, 450))]


TILES = {"n": 2, "overlap": 0.2, "sendW": 1344, "sendH": 1008}


def test_choose_tiles_falls_back_without_gsd_or_size():
    assert choose_tiles(5472, 3648, TILES, None, 0.05) == 2
    assert choose_tiles(5472, 3648, TILES, 0.01, None) == 2
    assert choose_tiles(5472, 3648, {**TILES, "n": 3}, None, None) == 3


def test_choose_tiles_from_object_size_and_gsd():
    # 5472 x 3648 at 1 cm/px. A 2 m object is 200 px of source: 49 sent px whole, 88 at n = 2.
    assert choose_tiles(5472, 3648, TILES, 0.01, 2.0) == 2
    # a 10 m object is big enough whole
    assert choose_tiles(5472, 3648, TILES, 0.01, 10.0) == 1
    # 1.1 m: 27 sent px whole, 49 at n = 2, 70 at n = 3
    assert choose_tiles(5472, 3648, TILES, 0.01, 1.1) == 3
    # a 0.2 m object never reaches 64 sent px: the most tiles
    assert choose_tiles(5472, 3648, TILES, 0.01, 0.2) == 4


def test_gsd_from_meta_near_nadir_only():
    meta = {"focal35": 24.0, "RelativeAltitude": 60.0, "GimbalPitchDegree": -90.0}
    assert gsd_from_meta(meta, 5472, 3648) == pytest.approx(60 * 43.27 / (24 * 6576.4), rel=1e-3)
    assert gsd_from_meta({**meta, "GimbalPitchDegree": -30.0}, 5472, 3648) is None
    assert gsd_from_meta({**meta, "RelativeAltitude": -2.0}, 5472, 3648) is None
    for key in meta:
        assert gsd_from_meta({k: v for k, v in meta.items() if k != key}, 5472, 3648) is None
