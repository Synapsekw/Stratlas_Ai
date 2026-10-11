"""photo.products with the array code on the graphics card: how many workers share the card, the
fall back to the CPU, and whole dense and fuse steps. No card is needed: a numpy backend stands in
for it and the pool runs in this process. With ``AIO_TEST_ADDON`` naming a built GPU add-on on a
computer with an NVIDIA card, one test runs the real thing in real worker processes."""

from __future__ import annotations

import dataclasses
import json
import os
import threading

import numpy as np
import pytest

import products_synth as ps
from aio_pipelines import accel
from aio_pipelines.photo import card as K
from aio_pipelines.photo import pool as P
from aio_pipelines.photo.products import PhotoProducts
from aio_pipelines.runtime import Cancelled, Job, JobError
from conftest import Recorder

GB = 1024**3
RUN = ps.RUN
READY = {
    "state": "ready",
    "version": "0.1.0",
    "gpu": "Test Card",
    "driver": "591.86",
    "vramBytes": 16 * GB,
    "freeBytes": 12 * GB,
}
REAL = os.environ.get("AIO_TEST_ADDON")


@pytest.mark.parametrize(
    "photos, pixels, free, budget, cores, insist, want",
    [
        (200, 20_900_000, 12 * GB, 48 * GB, 24, False, 3),  # by the card: 0.7 * 12 GB over 2.7 GB each
        (200, 5_200_000, 12 * GB, 48 * GB, 24, False, 4),  # by the ceiling
        (200, 5_200_000, 12 * GB, 48 * GB, 6, False, 2),  # by cores: the CPU matcher needs them
        (200, 20_900_000, 2 * GB, 48 * GB, 24, False, 0),  # too little of the card is free: not used
        (200, 300_000, 12 * GB, 48 * GB, 24, False, 0),  # small photos: the CPU is as quick
        (200, 300_000, 12 * GB, 48 * GB, 24, True, 4),  # unless the job asked for the card
        (1, 20_900_000, 12 * GB, 48 * GB, 24, False, 1),
        (0, 20_900_000, 12 * GB, 48 * GB, 24, True, 0),
    ],
)
def test_plan_card_workers(monkeypatch, photos, pixels, free, budget, cores, insist, want):
    monkeypatch.delenv(P.WORKERS_ENV, raising=False)
    assert P.plan_card_workers(photos, pixels, free, budget, cores, insist) == want


def test_the_card_takes_a_photo_and_the_cpu_takes_over_when_it_fails():
    card = object()
    state = {"card": card}
    assert P.with_card(state, lambda b: ("card", b), lambda: "cpu") == (("card", card), "gpu", None)

    released = []
    state = {"card": dataclasses.replace(K.numpy_backend(), release=lambda: released.append(1))}

    def out_of_memory(b):
        raise MemoryError("out of memory allocating 2,147,483,648 bytes")

    res = P.with_card(state, out_of_memory, lambda: "cpu")
    assert res == ("cpu", "cpu", "MemoryError: out of memory allocating 2,147,483,648 bytes")
    assert released == [1] and state["card"] is not None  # one failure: the card is tried again
    P.with_card(state, out_of_memory, lambda: "cpu")
    assert state["card"] is None  # two: this process stops trying it
    assert P.with_card(state, out_of_memory, lambda: "cpu") == ("cpu", "cpu", None)


def test_a_cancel_or_a_job_error_on_the_card_is_not_a_reason_to_try_the_cpu():
    def cancel(b):
        raise Cancelled()

    def refuse(b):
        raise JobError("The photo x could not be read: broken")

    with pytest.raises(Cancelled):
        P.with_card({"card": object()}, cancel, lambda: "cpu")
    with pytest.raises(JobError, match="could not be read"):
        P.with_card({"card": object()}, refuse, lambda: "cpu")


def test_a_worker_that_cannot_load_the_add_on_says_why_once(tmp_path):
    state: dict = {}
    P.attach_card(state, None)
    assert state == {}  # no add-on named: nothing to say
    P.attach_card(state, str(tmp_path / "pipeline-addon-cuda-0.1.0"))
    assert "card" not in state and "not installed" in state["card_problem"]
    why = state["card_problem"]
    # the first photo carries the reason, the next ones do not repeat it
    assert P.with_card(state, lambda b: "card", lambda: "cpu") == ("cpu", "cpu", why)
    assert P.with_card(state, lambda b: "card", lambda: "cpu") == ("cpu", "cpu", None)


# ---------------------------------------------------------------------------- whole steps


def _in_process(workers, init, initargs, task, items, check, done):
    """``pool.run_pool`` without processes: the worker's init and tasks run here."""
    init(*initargs)
    for item in items:
        check()
        done(item, task(item))


def _after(step: str):
    cancel = threading.Event()

    def emit(m, p):
        if m == "progress" and p.get("step") == step and p.get("stepFraction") == 1.0:
            cancel.set()

    return emit, cancel


def _run(root, params, job="g1", until="fuse"):
    seen = Recorder()
    after, cancel = _after(until)

    def emit(m, p):
        seen(m, p)
        after(m, p)

    with pytest.raises(Cancelled):
        Job(job, PhotoProducts(), root, params, emit, cancel).run()
    steps = {
        p.name: json.loads(p.read_text("utf-8"))["outputs"]
        for p in sorted((root / "jobs" / job / "steps").glob("*.json"))
    }
    return steps, [p.get("message", "") for p in seen.of("log")]


def _depth(root):
    d = next((root / "photogrammetry" / RUN / "work" / "products").glob("*/depth"))
    return {p.name: np.load(p) for p in sorted(d.glob("*.npy"))}


@pytest.fixture
def stand_in(monkeypatch, tmp_path):
    """The app named an add-on, the card passes its test, and a numpy backend plays the card."""
    monkeypatch.delenv(P.WORKERS_ENV, raising=False)
    monkeypatch.setenv(accel.ADDON_ENV, str(tmp_path / "pipeline-addon-cuda-0.1.0"))
    monkeypatch.setattr(accel, "check", lambda addon=None, timeout=120.0: dict(READY))
    monkeypatch.setattr(P, "run_pool", _in_process)
    backend = dataclasses.replace(K.numpy_backend(), name="gpu")

    def attach(state, addon):
        if addon:
            state["card"], state["rays"] = backend, K.Rays(backend)

    monkeypatch.setattr(P, "attach_card", attach)
    return backend


def test_a_job_that_asks_for_the_card_runs_depth_maps_and_fusion_on_it(stand_in):
    cpu_root = ps.project("card-cpu")
    cpu, _ = _run(cpu_root, {"run": RUN, "products": ["dsm"], "preset": "standard", "dense": "cpu"})
    root = ps.project("card-gpu")
    steps, log = _run(root, {"run": RUN, "products": ["dsm"], "preset": "standard", "dense": "cuda"})
    dense, fuse = steps["02-dense.json"], steps["03-fuse.json"]
    assert dense["device"] == "gpu" and dense["fallbacks"] == 0 and dense["accelerator"] == "0.1.0"
    assert fuse["device"] == "gpu" and fuse["fallbacks"] == 0
    assert any(m.startswith("Depth maps on Test Card, 12.9 GB free, GPU add-on 0.1.0;") for m in log)
    assert any(m.startswith("Fusion on Test Card") for m in log)
    assert cpu["02-dense.json"]["device"] == "cpu" and "accelerator" not in cpu["02-dense.json"]
    # the same cloud to within rounding
    assert abs(fuse["points"] - cpu["03-fuse.json"]["points"]) <= 0.01 * cpu["03-fuse.json"]["points"]
    a, b = _depth(cpu_root), _depth(root)
    assert a.keys() == b.keys()
    for name in a:
        both = np.isfinite(a[name]) & np.isfinite(b[name])
        if both.any():
            assert np.mean(np.abs(a[name][both] - b[name][both]) <= 0.001 * a[name][both]) > 0.99


def test_small_photos_stay_on_the_cpu_unless_the_job_asks_for_the_card(stand_in):
    steps, log = _run(
        ps.project("card-auto"), {"run": RUN, "products": ["dsm"], "preset": "standard"}, until="dense"
    )
    assert steps["02-dense.json"]["device"] == "cpu" and steps["02-dense.json"]["fallbacks"] == 0
    assert not any("Test Card" in m for m in log)


def test_a_card_that_fails_on_every_photo_leaves_the_job_on_the_cpu_with_a_warning(stand_in, monkeypatch):
    def boom(a):
        raise RuntimeError("cudaErrorUnknown: device lost")

    broken = dataclasses.replace(stand_in, to_host=boom)
    monkeypatch.setattr(P, "attach_card", lambda state, addon: state.update(card=broken, rays=K.Rays(broken)))
    root = ps.project("card-broken")
    steps, log = _run(
        root, {"run": RUN, "products": ["dsm"], "preset": "standard", "dense": "cuda"}, until="dense"
    )
    dense = steps["02-dense.json"]
    assert dense["device"] == "cpu" and dense["fallbacks"] == 2  # two failures, then the worker stops trying
    assert any(
        "could not be used for a photo (RuntimeError: cudaErrorUnknown: device lost)" in m for m in log
    )
    assert any(m == "2 photos meant for the graphics card were done on the CPU." for m in log)
    assert len(_depth(root)) == 16  # every depth map was made


def test_a_finished_run_records_where_its_stages_ran(stand_in, monkeypatch):
    def boom(a):
        raise RuntimeError("out of memory")

    # the card fails once in fusion: the photo is done on the CPU and the run says so
    calls = {"n": 0}
    real = K.fuse_arrays

    def flaky(*a, **k):
        calls["n"] += 1
        if calls["n"] == 1:
            boom(None)
        return real(*a, **k)

    monkeypatch.setattr(K, "fuse_arrays", flaky)
    root = ps.project("card-done")
    params = {"run": RUN, "products": ["dsm"], "preset": "standard", "dense": "cuda", "capture": "c1"}
    res = Job("g3", PhotoProducts(), root, params, Recorder(), threading.Event()).run()
    assert res["status"] == "done"
    doc = json.loads((root / "photogrammetry" / RUN / "run.json").read_text("utf-8"))
    stages = {s["name"]: s for s in doc["stages"]}
    assert stages["dense"]["device"] == "gpu" and "fallbacks" not in stages["dense"]
    assert stages["fuse"]["device"] == "gpu" and stages["fuse"]["fallbacks"] == 1
    assert doc["versions"]["accelerator"] == "0.1.0"
    assert (
        "The graphics card could not be used for 1 photo steps; they were done on the CPU." in doc["warnings"]
    )


def test_a_card_that_is_not_ready_means_the_cpu_or_a_refusal_in_words(stand_in, monkeypatch):
    reason = "The GPU add-on needs graphics driver 528.33 or later (found 512.15)."
    monkeypatch.setattr(
        accel, "check", lambda addon=None, timeout=120.0: {"state": "driver-too-old", "reason": reason}
    )
    steps, log = _run(
        ps.project("card-old"), {"run": RUN, "products": ["dsm"], "preset": "standard"}, until="dense"
    )
    assert steps["02-dense.json"]["device"] == "cpu"
    assert log.count(f"Photo processing uses the CPU. {reason}") == 1
    with pytest.raises(JobError, match=r"needs graphics driver 528\.33 or later .* Use dense: auto or cpu"):
        Job(
            "g2",
            PhotoProducts(),
            ps.project("card-refused"),
            {"run": RUN, "products": ["dsm"], "preset": "standard", "dense": "cuda"},
            Recorder(),
            threading.Event(),
        ).run()


def test_asking_for_the_card_without_an_add_on_is_refused_before_any_work(monkeypatch):
    monkeypatch.delenv(accel.ADDON_ENV, raising=False)
    with pytest.raises(JobError, match="GPU accelerator is not installed"):
        PhotoProducts().validate({"run": RUN, "products": ["dsm"], "dense": "cuda"})


@pytest.mark.skipif(
    not REAL, reason="set AIO_TEST_ADDON to a built GPU add-on on a computer with an NVIDIA card"
)
def test_the_real_card_in_real_worker_processes(monkeypatch, tmp_path):
    monkeypatch.setenv(accel.ADDON_ENV, str(REAL))
    monkeypatch.setenv(accel.CACHE_ENV, str(tmp_path / "kernels"))
    monkeypatch.setenv(P.WORKERS_ENV, "2")
    steps, log = _run(
        ps.project("card-real"), {"run": RUN, "products": ["dsm"], "preset": "standard", "dense": "cuda"}
    )
    assert steps["02-dense.json"]["device"] == "gpu" and steps["02-dense.json"]["fallbacks"] == 0, log
    assert steps["03-fuse.json"]["device"] == "gpu" and steps["03-fuse.json"]["fallbacks"] == 0, log
    assert steps["02-dense.json"]["workers"] == 2
