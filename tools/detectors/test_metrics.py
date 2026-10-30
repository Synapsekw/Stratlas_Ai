"""Tests for the bench metrics: IoU matching, precision/recall/F1, the PR curve and references."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

import metrics as m


def _t(box, cls="rust"):
    return {"box": tuple(box), "class": cls}


def _d(photo, box, score):
    return {"photo": photo, "box": list(box), "score": score}


def test_iou():
    assert m.iou((0, 0, 10, 10), (0, 0, 10, 10)) == pytest.approx(1.0)
    assert m.iou((0, 0, 10, 10), (5, 0, 15, 10)) == pytest.approx(50 / 150)
    assert m.iou((0, 0, 10, 10), (20, 20, 30, 30)) == 0.0
    assert m.iou((0, 0, 0, 10), (0, 0, 0, 10)) == 0.0  # no area


def test_a_huge_box_passes_the_centre_rule_but_not_iou():
    truth = {"p": [_t((40, 40, 60, 60))]}
    drafts = [_d("p", (0, 0, 1000, 1000), 0.9)]
    res = m.evaluate(drafts, truth, threshold=0.5, iou_min=0.3, detector_class="rust", photos=1)
    assert res["tp"] == 0 and res["fp"] == 1 and res["fn"] == 1
    assert res["precision"] == 0 and res["recall"] == 0 and res["f1"] == 0
    old = m.centre_rule(drafts, truth, threshold=0.5)
    assert old["found"] == 1 and old["recall"] == 1.0 and old["unmatchedDrafts"] == 0


def test_one_to_one_two_drafts_on_one_truth():
    truth = {"p": [_t((0, 0, 10, 10))]}
    drafts = [_d("p", (0, 0, 10, 10), 0.9), _d("p", (1, 1, 10, 10), 0.95)]
    res = m.evaluate(drafts, truth, threshold=0.5, iou_min=0.3, detector_class="rust", photos=1)
    assert res["tp"] == 1 and res["fp"] == 1 and res["fn"] == 0
    assert res["precision"] == pytest.approx(0.5)
    assert res["recall"] == pytest.approx(1.0)
    assert res["f1"] == pytest.approx(2 / 3)
    # the higher score takes the truth, even with the lower IoU
    matches = m.match(drafts, truth, iou_min=0.3)
    assert matches[1][0] == 0 and matches[0][0] is None


def test_a_draft_takes_the_best_free_truth():
    truth = {"p": [_t((0, 0, 10, 10)), _t((4, 0, 14, 10))]}
    drafts = [_d("p", (5, 0, 15, 10), 0.9), _d("p", (0, 0, 10, 10), 0.8)]
    matches = m.match(drafts, truth, iou_min=0.3)
    assert matches[0][0] == 1 and matches[1][0] == 0


def test_iou_bar_is_configurable_and_other_photos_never_match():
    truth = {"p": [_t((0, 0, 10, 10))]}
    drafts = [_d("p", (5, 0, 15, 10), 0.9), _d("q", (0, 0, 10, 10), 0.9)]
    lax = m.evaluate(drafts, truth, threshold=0.5, iou_min=0.3, detector_class="rust", photos=2)
    strict = m.evaluate(drafts, truth, threshold=0.5, iou_min=0.5, detector_class="rust", photos=2)
    assert lax["tp"] == 1 and strict["tp"] == 0
    assert lax["fp"] == 1 and strict["fp"] == 2


def test_threshold_and_missing_scores():
    truth = {"p": [_t((0, 0, 10, 10))]}
    drafts = [_d("p", (0, 0, 10, 10), 0.4), _d("p", (0, 0, 10, 10), None)]
    res = m.evaluate(drafts, truth, threshold=0.5, iou_min=0.3, detector_class="rust", photos=1)
    assert res["drafts"] == 0 and res["tp"] == 0 and res["fn"] == 1
    assert res["precision"] is None and res["recall"] == 0 and res["f1"] is None
    assert res["draftsPerPhoto"] == 0


def test_no_truth_gives_no_recall():
    res = m.evaluate(
        [_d("p", (0, 0, 1, 1), 0.9)], {}, threshold=0.5, iou_min=0.3, detector_class="rust", photos=4
    )
    assert res["recall"] is None and res["precision"] == 0 and res["draftsPerPhoto"] == 0.25


def test_per_class():
    truth = {
        "p": [_t((0, 0, 10, 10), "rust"), _t((50, 50, 60, 60), "crack")],
        "q": [_t((0, 0, 10, 10), "crack")],
    }
    drafts = [
        _d("p", (0, 0, 10, 10), 0.9),
        _d("p", (50, 50, 60, 60), 0.9),
        _d("p", (200, 200, 210, 210), 0.9),
    ]
    res = m.evaluate(drafts, truth, threshold=0.5, iou_min=0.3, detector_class="rust", photos=2)
    rust, crack = res["perClass"]["rust"], res["perClass"]["crack"]
    assert (rust["truth"], rust["tp"], rust["fp"], rust["fn"]) == (1, 1, 1, 0)
    assert rust["precision"] == pytest.approx(0.5) and rust["recall"] == 1.0
    assert (crack["truth"], crack["tp"], crack["fp"], crack["fn"]) == (2, 1, 0, 1)
    assert crack["precision"] == 1.0 and crack["recall"] == pytest.approx(0.5)


def test_pr_curve_rows_follow_the_threshold():
    truth = {"p": [_t((0, 0, 10, 10)), _t((20, 20, 30, 30))]}
    drafts = [_d("p", (0, 0, 10, 10), 0.92), _d("p", (20, 20, 30, 30), 0.41), _d("p", (60, 60, 70, 70), 0.7)]
    rows = m.pr_curve(drafts, truth, iou_min=0.3, detector_class="rust", photos=1)
    assert [r["threshold"] for r in rows][:3] == [0.0, 0.05, 0.1] and rows[-1]["threshold"] == 1.0
    assert len(rows) == 21
    by = {r["threshold"]: r for r in rows}
    assert (by[0.4]["tp"], by[0.4]["fp"], by[0.4]["recall"]) == (2, 1, 1.0)
    assert (by[0.5]["tp"], by[0.5]["fp"], by[0.5]["recall"]) == (1, 1, 0.5)
    assert (by[0.9]["tp"], by[0.9]["fp"], by[0.9]["precision"]) == (1, 0, 1.0)
    assert by[0.95]["drafts"] == 0
    recalls = [r["recall"] for r in rows]
    assert recalls == sorted(recalls, reverse=True)
    assert set(rows[0]) == {"threshold", "drafts", "tp", "fp", "fn", "precision", "recall", "f1"}


def test_pr_csv():
    rows = m.pr_curve([_d("p", (0, 0, 10, 10), 0.9)], {"p": [_t((0, 0, 10, 10))]}, 0.3, "rust", 1)
    text = m.pr_csv(rows)
    lines = text.strip().splitlines()
    assert lines[0] == "threshold,drafts,tp,fp,fn,precision,recall,f1"
    assert lines[1] == "0.00,1,1,0,0,1.0000,1.0000,1.0000"
    assert lines[-1] == "1.00,0,0,0,1,,0.0000,"


def test_dataset_hash_is_stable_and_sees_changes():
    truth = {"a": [_t((0, 0, 10, 10))]}
    h1 = m.dataset_hash(["b", "a"], truth)
    assert h1 == m.dataset_hash(["a", "b"], {"a": [_t((0.01, 0, 10, 10))]})
    assert h1 != m.dataset_hash(["a", "b"], {"a": [_t((0, 0, 11, 10))]})
    assert h1 != m.dataset_hash(["a"], truth)
    assert h1 != m.dataset_hash(["a", "b"], {"a": [_t((0, 0, 10, 10), "crack")]})
    assert len(h1) == 64


REPORT = {"precision": 0.6, "recall": 0.7, "f1": 0.65, "datasetHash": "h", "model": "qwen3.5-9b-q4_k_m"}


def _ref(**metrics):
    base = {"precision": 0.62, "recall": 0.72, "f1": 0.66}
    base.update(metrics)
    return {"datasetHash": "h", "model": "qwen3.5-9b-q4_k_m", "metrics": base}


def test_compare_inside_tolerance_is_ok():
    res = m.compare(REPORT, _ref(), tolerance=0.05)
    assert res["status"] == "ok" and res["regressions"] == [] and res["warnings"] == []


def test_compare_flags_a_drop_beyond_tolerance():
    res = m.compare(REPORT, _ref(recall=0.8), tolerance=0.05)
    assert res["status"] == "regression"
    assert len(res["regressions"]) == 1 and "recall" in res["regressions"][0]
    assert m.compare(REPORT, _ref(recall=0.8), tolerance=0.2)["status"] == "ok"


def test_compare_warns_on_another_dataset_or_model_but_still_compares():
    ref = _ref(f1=0.9)
    ref["datasetHash"] = "other"
    ref["model"] = "qwen2.5-vl-7b-instruct-q4_k_m"
    res = m.compare(REPORT, ref, tolerance=0.05)
    assert res["status"] == "regression"
    assert any("dataset" in w for w in res["warnings"])
    assert any("model" in w for w in res["warnings"])


def test_compare_without_reference_metrics():
    res = m.compare(REPORT, {"metrics": None, "datasetHash": None}, tolerance=0.05)
    assert res["status"] == "no-reference" and res["regressions"] == []


def test_an_unmeasured_metric_against_a_full_reference_is_a_regression():
    res = m.compare({**REPORT, "recall": None}, _ref(), tolerance=0.05)
    assert res["status"] == "regression" and any("recall" in r for r in res["regressions"])
    empty = {**REPORT, "precision": None, "recall": None, "f1": None}
    assert len(m.compare(empty, _ref(), tolerance=0.05)["regressions"]) == 3


SETTINGS = {"threshold": 0.8, "iouMin": 0.3, "split": "bench", "truthClasses": ["rust", "corrosion"]}


def test_compare_refuses_other_settings():
    ref = {**_ref(), **SETTINGS}
    same = {**REPORT, **SETTINGS, "truthClasses": ["corrosion", "rust"]}  # order does not matter
    assert m.compare(same, ref, tolerance=0.05)["status"] == "ok"
    for key, other in (("threshold", 0.5), ("iouMin", 0.5), ("split", "tune"), ("truthClasses", ["rust"])):
        res = m.compare({**same, key: other}, ref, tolerance=0.05)
        assert res["status"] == "mismatch", key
        assert len(res["mismatches"]) == 1 and key in res["mismatches"][0]
        assert res["regressions"] == []


def test_stale_tuned_on():
    det = {"id": "corrosion-metal", "tunedOn": {"model": "qwen2.5-vl-7b-instruct-q4_k_m"}}
    warns = m.stale_tuned_on(det, pack_model="qwen3.5-9b-q4_k_m")
    assert len(warns) == 1 and "qwen2.5-vl-7b-instruct-q4_k_m" in warns[0] and "qwen3.5-9b-q4_k_m" in warns[0]
    fresh = {"id": "x", "tunedOn": {"model": "qwen3.5-9b-q4_k_m"}}
    assert m.stale_tuned_on(fresh, pack_model="qwen3.5-9b-q4_k_m") == []
    assert len(m.stale_tuned_on({"id": "y"}, pack_model="qwen3.5-9b-q4_k_m")) == 1
    ref = {"model": "qwen2.5-vl-7b-instruct-q4_k_m"}
    warns = m.stale_tuned_on(fresh, pack_model="qwen3.5-9b-q4_k_m", reference=ref)
    assert len(warns) == 1 and "reference" in warns[0]
