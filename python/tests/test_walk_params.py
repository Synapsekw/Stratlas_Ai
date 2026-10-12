"""``walk.process`` checks its parameters the way ``WalkProcessParams`` (packages/schema/src/jobs.ts)
does: the same names, the same required one, the same ranges (walkProcess.test.ts parses the
same values with zod)."""

import os
from pathlib import Path

import pytest

from aio_pipelines.pipelines import all_pipelines
from aio_pipelines.runtime import JobError


def _abs(rel: str) -> str:
    return str(Path(os.path.abspath(os.sep)) / rel)


SMALLEST = {"walk": "vid-20260101-120000-00-001"}
FULL = {
    "walk": "w1",
    "src": [_abs("clips/VID_1_00_001.insv"), _abs("clips/VID_1_00_002.insv")],
    "stillsPerS": 2,
    "maskBottom": 0.25,
    "strideM": 0.7,
    "stabilize": True,
    "sfm": False,
    "chunk": 300,
}
KEYS = {"walk", "src", "stillsPerS", "maskBottom", "strideM", "stabilize", "sfm", "chunk"}


def _pipe():
    return all_pipelines()["walk.process"]


def test_listed_with_the_contract_title_and_description():
    p = _pipe()
    assert p.title == "Process 360 walk"
    assert p.description == (
        "Levelled playback copy, camera orientation, path from the video, sparse points and map stills for a 360 walk."
    )
    assert set(p.keys) == KEYS
    assert set(p.required) == {"walk"}


@pytest.mark.parametrize("params", [SMALLEST, FULL])
def test_valid_parameters_come_back_unchanged(params):
    assert _pipe().validate(dict(params)) == params


def test_unknown_keys_and_the_missing_walk_are_refused():
    with pytest.raises(JobError, match="does not take: layer"):
        _pipe().validate({**SMALLEST, "layer": "x"})
    with pytest.raises(JobError, match="needs: walk"):
        _pipe().validate({"sfm": True})


@pytest.mark.parametrize("walk", ["VID_1", "-x", "a" * 81, "", "a b", 3])
def test_a_walk_id_the_import_does_not_write_is_refused(walk):
    with pytest.raises(JobError):
        _pipe().validate({"walk": walk})


def test_walk_ids_at_the_limits():
    assert _pipe().validate({"walk": "a" * 80})["walk"] == "a" * 80
    assert _pipe().validate({"walk": "0-a"})["walk"] == "0-a"


@pytest.mark.parametrize(
    ("key", "bad", "good"),
    [
        ("stillsPerS", [0.4, 4.1, "2", True], [0.5, 4]),
        ("maskBottom", [-0.01, 0.6], [0, 0.5]),
        ("strideM", [0.2, 1.6], [0.3, 1.5]),
        ("chunk", [10, 2001, 300.5], [50, 2000]),
        ("stabilize", [1, "yes"], [True, False]),
        ("sfm", [0, "no"], [True, False]),
    ],
)
def test_ranges_and_types(key, bad, good):
    for v in bad:
        with pytest.raises(JobError, match=key):
            _pipe().validate({**SMALLEST, key: v})
    for v in good:
        assert _pipe().validate({**SMALLEST, key: v})[key] == v


def test_src_is_1_to_20_absolute_paths():
    for bad in ([], "x.insv", [_abs("a.insv")] * 21, [""], ["relative/VID_1_00_001.insv"], [3]):
        with pytest.raises(JobError, match="src"):
            _pipe().validate({**SMALLEST, "src": bad})
    assert _pipe().validate({**SMALLEST, "src": [_abs("a.insv")] * 20})


def test_inputs_name_the_walk_files_and_the_originals():
    assert _pipe().inputs(FULL) == ["walks/w1/walk.json", "walks/w1/playback.mp4", *FULL["src"]]
    assert _pipe().inputs(SMALLEST) == [
        "walks/vid-20260101-120000-00-001/walk.json",
        "walks/vid-20260101-120000-00-001/playback.mp4",
    ]


def test_four_resumable_steps_with_the_planned_weights():
    steps = _pipe().plan(_pipe().validate(dict(SMALLEST)))
    assert [(s.name, s.weight) for s in steps] == [
        ("read", 0.05),
        ("frames", 0.45),
        ("sfm", 0.45),
        ("finish", 0.05),
    ]
