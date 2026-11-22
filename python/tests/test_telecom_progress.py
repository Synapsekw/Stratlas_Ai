"""Progress and Cancel inside the long steps of `telecom.antennas` (crown, faces, boxes), on the
synthetic monopole: the steps report how far they are and stop at a cancel inside the step, and
the faces they find are the same with or without the progress calls."""

from __future__ import annotations

import threading

import numpy as np
import pytest

from aio_pipelines.pipelines import all_pipelines
from aio_pipelines.runtime import Cancelled, Job
from aio_pipelines.telecom.faces import planar_faces
from antenna_synth import make_tower_project, tower_cloud
from conftest import Recorder

LONG_STEPS = ("crown", "faces", "boxes")


def _no_shaft(h):
    return np.zeros_like(np.asarray(h, dtype=float)) + 0.3


@pytest.fixture(scope="module")
def tower():
    return tower_cloud(seed=1)


def test_the_face_search_ticks_forward_and_finds_the_same_faces(tower):
    xyz, _ = tower
    shares: list[float] = []
    plain = planar_faces(xyz, np.zeros(3), np.array([0.0, 1.0, 0.0]), _no_shaft)
    ticked = planar_faces(xyz, np.zeros(3), np.array([0.0, 1.0, 0.0]), _no_shaft, tick=shares.append)
    assert len(shares) > 5 and shares == sorted(shares) and shares[0] >= 0.0 and shares[-1] < 1.0
    assert len(plain) == len(ticked) > 0
    for f, g in zip(plain, ticked, strict=True):
        assert np.array_equal(f.points, g.points) and np.array_equal(f.centre, g.centre)
        assert (f.width, f.height, f.support, f.coverage) == (g.width, g.height, g.support, g.coverage)


def test_a_tick_that_raises_stops_the_face_search(tower):
    xyz, _ = tower
    calls: list[float] = []

    def cancel(share: float) -> None:
        calls.append(share)
        if share >= 0.3:
            raise Cancelled()

    with pytest.raises(Cancelled):
        planar_faces(xyz, np.zeros(3), np.array([0.0, 1.0, 0.0]), _no_shaft, tick=cancel)
    assert calls[-1] >= 0.3


def test_detection_reports_progress_inside_its_long_steps(tmp_path, tower):
    xyz, _ = tower
    root = make_tower_project(tmp_path / "p", xyz, epsg=32633)
    rec = Recorder()
    result = Job(
        "jp", all_pipelines()["telecom.antennas"], root, {"run": "run-a"}, rec, threading.Event()
    ).run()
    assert result["status"] == "done"
    for step in LONG_STEPS:
        inside = {
            p["stepFraction"]
            for p in rec.of("progress")
            if p.get("step") == step and p.get("state") == "running" and 0.0 < p["stepFraction"] < 1.0
        }
        assert inside, f"no progress inside the {step} step"


def test_cancel_is_honoured_inside_the_faces_step(tmp_path, tower):
    xyz, _ = tower
    root = make_tower_project(tmp_path / "p", xyz, epsg=32633)
    cancel = threading.Event()
    rec = Recorder()

    def emit(method, p):
        rec(method, p)
        # a cancel pressed while the face search runs, past its first stage
        running = method == "progress" and p.get("step") == "faces" and p.get("state") == "running"
        if running and p["stepFraction"] > 0.0:
            cancel.set()

    with pytest.raises(Cancelled):
        Job("jc", all_pipelines()["telecom.antennas"], root, {"run": "run-a"}, emit, cancel).run()
    faces = [p for p in rec.of("progress") if p.get("step") == "faces"]
    assert not any(p.get("state") == "done" for p in faces)
    assert not list(root.rglob("faces.npz"))


def test_box_fitting_ticks_forward_and_finds_the_same_units(tower):
    from aio_pipelines.telecom.boxes import pair_faces

    xyz, _ = tower
    axis = np.zeros(3)
    faces = planar_faces(xyz, axis, np.array([0.0, 1.0, 0.0]), _no_shaft)
    shares: list[float] = []
    plain = pair_faces(faces, axis, xyz, _no_shaft, {})
    ticked = pair_faces(faces, axis, xyz, _no_shaft, {}, tick=shares.append)
    assert len(shares) > 2 and shares == sorted(shares) and shares[-1] < 1.0
    assert len(plain) == len(ticked) > 0
    for u, v in zip(plain, ticked, strict=True):
        assert np.array_equal(u.centre, v.centre) and np.array_equal(u.axes, v.axes)
        assert (u.kind, u.support) == (v.kind, v.support)

    def cancel(share: float) -> None:
        raise Cancelled()

    with pytest.raises(Cancelled):
        pair_faces(faces, axis, xyz, _no_shaft, {}, tick=cancel)
