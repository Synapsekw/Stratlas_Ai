"""The multi-view vote bench on two synthetic fixtures: the vote must cut reviews and false drafts."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import vote_bench as vb


def test_the_vote_cuts_reviews_and_false_drafts_without_losing_objects():
    r = vb.run([1, 2])["total"]
    before = r["before"]
    assert r["fixture"]["falseDrafts"] > 0
    for name in ("afterMesh", "afterRays"):
        after = r[name]
        assert after["review"]["drafts"] < before["review"]["drafts"] / 2
        assert after["review"]["false"] < before["review"]["false"]
        assert after["e2"]["precision"] >= before["e2"]["precision"]
        assert after["e2"]["f1"] > before["e2"]["f1"]
        assert after["review"]["objectsCovered"] >= before["review"]["objectsCovered"] - 2


def test_spread_gives_every_sighting_the_voted_score():
    d = {"photo": "a", "bbox": [0, 0, 1, 1], "confidence": 0.9,
         "vote": {"views": 2, "sightings": [{"photo": "b", "bbox": [1, 1, 2, 2], "confidence": 0.5}]}}  # fmt: skip
    assert vb.spread([d]) == [
        (0, {"photo": "a", "box": [0, 0, 1, 1], "score": 0.9}),
        (0, {"photo": "b", "box": [1, 1, 2, 2], "score": 0.9}),
    ]


def test_main_prints_the_table(capsys, tmp_path):
    assert vb.main(["--seeds", "1", "--out", str(tmp_path)]) == 0
    assert "| afterMesh |" in capsys.readouterr().out
    assert (tmp_path / "report.json").exists()
