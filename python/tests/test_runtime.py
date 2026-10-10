import json
import os
import threading
from pathlib import Path

import pytest

from aio_pipelines import runtime
from aio_pipelines.runtime import (
    AtomicPath,
    Cancelled,
    Job,
    JobError,
    Step,
    atomic_write_bytes,
    atomic_write_json,
    commit_files,
    replace_over,
    safe_project_path,
)


class Recorder:
    def __init__(self):
        self.messages = []

    def __call__(self, method, params):
        self.messages.append((method, params))

    def of(self, method):
        return [p for m, p in self.messages if m == method]


class TwoSteps:
    """A pipeline that stages one file, then commits it; counts how often each step ran."""

    name = "test.two"
    title = "Two steps"
    description = "test"

    def __init__(self, fail_in=None, cancel_in=None):
        self.runs = {"make": 0, "commit": 0}
        self.fail_in = fail_in
        self.cancel_in = cancel_in

    def validate(self, params):
        if "text" not in params:
            raise JobError("text is required")
        return params

    def plan(self, params):
        def make(ctx):
            self.runs["make"] += 1
            for i in range(4):
                ctx.check()
                ctx.progress((i + 1) / 4, f"part {i + 1}")
            if self.fail_in == "make":
                raise RuntimeError("boom")
            atomic_write_bytes(ctx.stage("out.txt"), params["text"].encode())
            return {"bytes": len(params["text"])}

        def commit(ctx):
            self.runs["commit"] += 1
            if self.cancel_in == "commit":
                ctx.cancel_event.set()
                ctx.check()
            commit_files(ctx, [("out.txt", "result/out.txt")])
            return {"made": ctx.outputs("make")["bytes"]}

        return [Step("make", "Make the file", make, weight=3), Step("commit", "Write to project", commit)]


def run(tmp_path, pipeline, params=None, job_id="j1", cancel=None):
    rec = Recorder()
    job = Job(job_id, pipeline, tmp_path, params or {"text": "hello"}, rec, cancel or threading.Event())
    return job, rec


def test_a_job_stages_then_commits_and_writes_manifests(tmp_path):
    p = TwoSteps()
    job, rec = run(tmp_path, p)
    result = job.run()
    assert result["status"] == "done"
    assert (tmp_path / "result" / "out.txt").read_text() == "hello"
    manifest = json.loads((tmp_path / "jobs" / "j1" / "job.json").read_text())
    assert manifest["status"] == "done"
    assert [s["status"] for s in manifest["steps"]] == ["done", "done"]
    step = json.loads((tmp_path / "jobs" / "j1" / "steps" / "01-make.json").read_text())
    assert step["outputs"] == {"bytes": 5}
    assert rec.of("artifact") == [{"jobId": "j1", "path": "result/out.txt", "kind": "file"}]
    plan = rec.of("progress")[0]
    assert plan["state"] == "plan"
    assert plan["plan"] == [
        {"name": "make", "title": "Make the file"},
        {"name": "commit", "title": "Write to project"},
    ]
    fractions = [m["fraction"] for m in rec.of("progress")]
    assert fractions == sorted(fractions) and fractions[-1] == 1.0


def test_a_failed_job_leaves_the_project_untouched_and_resumes_from_the_failed_step(tmp_path):
    p = TwoSteps(fail_in="make")
    job, rec = run(tmp_path, p)
    with pytest.raises(RuntimeError):
        job.run()
    assert not (tmp_path / "result").exists()
    assert json.loads((tmp_path / "jobs" / "j1" / "job.json").read_text())["status"] == "failed"

    p.fail_in = None
    job, rec = run(tmp_path, p)
    assert job.run()["status"] == "done"
    assert p.runs == {"make": 2, "commit": 1}


def test_a_cancelled_job_resumes_without_redoing_finished_steps(tmp_path):
    p = TwoSteps(cancel_in="commit")
    job, rec = run(tmp_path, p)
    with pytest.raises(Cancelled):
        job.run()
    assert not (tmp_path / "result").exists()
    assert json.loads((tmp_path / "jobs" / "j1" / "job.json").read_text())["status"] == "cancelled"

    p.cancel_in = None
    job, rec = run(tmp_path, p)
    assert job.run()["status"] == "done"
    assert p.runs == {"make": 1, "commit": 2}
    skipped = [m for m in rec.of("progress") if m.get("state") == "skipped"]
    assert [m["step"] for m in skipped] == ["make"]


def test_resuming_with_different_params_is_refused(tmp_path):
    p = TwoSteps(fail_in="make")
    job, _ = run(tmp_path, p)
    with pytest.raises(RuntimeError):
        job.run()
    job, _ = run(tmp_path, p, params={"text": "other"})
    with pytest.raises(JobError, match="different parameters"):
        job.run()


def test_cancel_before_start_stops_at_the_first_check(tmp_path):
    ev = threading.Event()
    ev.set()
    job, _ = run(tmp_path, TwoSteps(), cancel=ev)
    with pytest.raises(Cancelled):
        job.run()


def test_commit_is_idempotent_after_a_partial_move(tmp_path):
    p = TwoSteps()
    job, _ = run(tmp_path, p)
    job.run()
    # Running the commit again (as a resume after a crash mid-commit would) must not fail.
    (tmp_path / "jobs" / "j1" / "steps" / "02-commit.json").unlink()
    job, _ = run(tmp_path, p)
    assert job.run()["status"] == "done"


@pytest.mark.parametrize("bad", ["../x", "/abs/x", "C:/x", "a/../../x", ""])
def test_project_paths_never_escape_the_project(tmp_path, bad):
    with pytest.raises(JobError):
        safe_project_path(tmp_path, bad)


def test_invalid_job_ids_are_refused(tmp_path):
    with pytest.raises(JobError):
        Job("../evil", TwoSteps(), tmp_path, {"text": "x"}, Recorder(), threading.Event())


class PhotoSteps(TwoSteps):
    """TwoSteps that reads a photos folder, so a resume checks its inputs."""

    def inputs(self, params):
        return ["photos"]


def _photos(tmp_path, names=("a.jpg", "b.jpg")):
    folder = tmp_path / "photos"
    folder.mkdir(exist_ok=True)
    for n in names:
        (folder / n).write_bytes(b"jpeg " + n.encode())
    return folder


def test_a_job_records_a_hash_of_its_inputs(tmp_path):
    _photos(tmp_path)
    job, _ = run(tmp_path, PhotoSteps())
    assert job.run()["status"] == "done"
    inputs = json.loads((tmp_path / "jobs" / "j1" / "job.json").read_text())["inputs"]
    assert inputs["files"] == 2
    assert len(inputs["hash"]) == 32


def test_resuming_after_the_inputs_changed_is_refused(tmp_path):
    folder = _photos(tmp_path)
    p = PhotoSteps(cancel_in="commit")
    job, _ = run(tmp_path, p)
    with pytest.raises(Cancelled):
        job.run()
    started = json.loads((tmp_path / "jobs" / "j1" / "job.json").read_text())

    # unchanged inputs: the resume goes on
    p.cancel_in = "commit"
    job, _ = run(tmp_path, p)
    with pytest.raises(Cancelled):
        job.run()

    # a photo added, one changed in size, or one removed: refused, nothing redone or committed
    for change in (
        lambda: (folder / "c.jpg").write_bytes(b"new"),
        lambda: (folder / "a.jpg").write_bytes(b"a longer jpeg"),
        lambda: (folder / "b.jpg").unlink(),
    ):
        change()
        p.cancel_in = None
        runs = dict(p.runs)
        job, _ = run(tmp_path, p)
        with pytest.raises(JobError) as e:
            job.run()
        assert str(e.value) == ("The input photos changed since this job started. Start the job again.")
        assert p.runs == runs
        assert not (tmp_path / "result").exists()
        after = json.loads((tmp_path / "jobs" / "j1" / "job.json").read_text())
        assert after["inputs"] == started["inputs"]


def test_a_new_job_id_starts_over_with_the_changed_inputs(tmp_path):
    folder = _photos(tmp_path)
    p = PhotoSteps(cancel_in="commit")
    job, _ = run(tmp_path, p)
    with pytest.raises(Cancelled):
        job.run()
    (folder / "c.jpg").write_bytes(b"new")
    p.cancel_in = None
    job, _ = run(tmp_path, p, job_id="j2")
    assert job.run()["status"] == "done"


# ---------------------------------------------------------------- a reader holds the file open


class Refusals:
    """``os.replace`` as Windows answers while another process holds the target (``only``) open."""

    def __init__(self, monkeypatch, refuse, windows=True, only=None):
        self.left = refuse
        self.only = only
        self.calls = 0
        self.sleeps: list[float] = []
        self._replace = os.replace
        monkeypatch.setattr(runtime, "_WINDOWS", windows)
        monkeypatch.setattr(runtime.os, "replace", self.replace)
        monkeypatch.setattr(runtime.time, "sleep", self.sleeps.append)

    def replace(self, src, dst):
        if self.only and Path(dst) != self.only:
            return self._replace(src, dst)
        self.calls += 1
        if self.left > 0:
            self.left -= 1
            raise PermissionError(13, "Access is denied", str(src), 5, str(dst))
        self._replace(src, dst)


def test_a_refused_rename_is_tried_again_until_the_reader_lets_go(tmp_path, monkeypatch):
    dest = tmp_path / "run.json"
    dest.write_text("old")
    held = Refusals(monkeypatch, refuse=3)
    atomic_write_bytes(dest, b"new")
    assert dest.read_text() == "new"
    assert held.calls == 4
    assert held.sleeps == [0.01, 0.02, 0.04]
    assert [f.name for f in tmp_path.iterdir()] == ["run.json"]


def test_a_rename_refused_for_good_fails_after_about_2_5_s_and_keeps_the_old_file(tmp_path, monkeypatch):
    dest = tmp_path / "run.json"
    dest.write_text("old")
    held = Refusals(monkeypatch, refuse=10**6)
    with pytest.raises(PermissionError):
        atomic_write_bytes(dest, b"new")
    assert dest.read_text() == "old"
    assert held.calls == len(held.sleeps) + 1
    assert 2.0 < sum(held.sleeps) < 3.0
    # the temp file is cleaned up
    assert [f.name for f in tmp_path.iterdir()] == ["run.json"]


def test_off_windows_a_refused_rename_fails_at_once(tmp_path, monkeypatch):
    dest = tmp_path / "run.json"
    dest.write_text("old")
    held = Refusals(monkeypatch, refuse=1, windows=False)
    with pytest.raises(PermissionError):
        replace_over(tmp_path / "missing.tmp", dest)
    assert held.calls == 1 and held.sleeps == []


def test_an_atomic_path_waits_for_a_reader(tmp_path, monkeypatch):
    held = Refusals(monkeypatch, refuse=1)
    with AtomicPath(tmp_path / "a.bin") as tmp:
        tmp.write_bytes(b"a")
    assert (tmp_path / "a.bin").read_bytes() == b"a"
    assert held.calls == 2 and held.sleeps == [0.01]


def test_a_commit_waits_for_a_reader_of_the_project_file(tmp_path, monkeypatch):
    (tmp_path / "result").mkdir()
    (tmp_path / "result" / "out.txt").write_text("old")
    held = Refusals(monkeypatch, refuse=2, only=tmp_path / "result" / "out.txt")
    job, _ = run(tmp_path, TwoSteps())
    assert job.run()["status"] == "done"
    assert (tmp_path / "result" / "out.txt").read_text() == "hello"
    assert held.calls == 3 and held.sleeps == [0.01, 0.02]


windows_only = pytest.mark.skipif(
    os.name != "nt", reason="only Windows refuses to replace a file that another handle has open"
)


def _hold_as_python(path):
    """Open ``path`` as Python's ``open`` does (no delete sharing); answers the release."""
    return open(path, "rb").close


def _hold_as_the_app(path):
    """Open ``path`` as the app does: Node opens with read, write and delete sharing, and a rename
    over the file is refused all the same. Answers the release."""
    import ctypes
    from ctypes import wintypes

    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.CreateFileW.restype = wintypes.HANDLE
    k32.CreateFileW.argtypes = [wintypes.LPCWSTR, *[wintypes.DWORD] * 2, wintypes.LPVOID]
    k32.CreateFileW.argtypes += [*[wintypes.DWORD] * 2, wintypes.HANDLE]
    k32.CloseHandle.argtypes = [wintypes.HANDLE]
    generic_read, share_all, open_existing, normal = 0x80000000, 0x7, 3, 0x80
    handle = k32.CreateFileW(str(path), generic_read, share_all, None, open_existing, normal, None)
    assert handle not in (None, wintypes.HANDLE(-1).value), ctypes.get_last_error()
    return lambda: k32.CloseHandle(handle)


READERS = pytest.mark.parametrize("hold", [_hold_as_python, _hold_as_the_app])


@windows_only
@READERS
def test_a_write_succeeds_once_a_real_reader_lets_go(tmp_path, hold):
    dest = tmp_path / "run.json"
    dest.write_text("old")
    release = threading.Timer(0.15, hold(dest))
    release.start()
    try:
        atomic_write_bytes(dest, b"new")
    finally:
        release.join()
    assert dest.read_text() == "new"
    assert [f.name for f in tmp_path.iterdir()] == ["run.json"]


@windows_only
@READERS
def test_a_write_fails_cleanly_while_a_real_reader_never_lets_go(tmp_path, monkeypatch, hold):
    monkeypatch.setattr(runtime, "_REPLACE_WAITS_S", (0.01, 0.02))
    dest = tmp_path / "run.json"
    dest.write_text("old")
    release = hold(dest)
    try:
        with pytest.raises(PermissionError):
            atomic_write_bytes(dest, b"new")
    finally:
        release()
    # the old file is whole and no temp file is left behind
    assert dest.read_text() == "old"
    assert [f.name for f in tmp_path.iterdir()] == ["run.json"]


class WritesRunFile:
    """A photo-like pipeline: each stage ends by writing the run's record into the project."""

    name = "test.run-file"
    title = "Run file"
    description = "test"

    def __init__(self, at_stage_end):
        self.at_stage_end = at_stage_end
        self.ran: list[str] = []

    def validate(self, params):
        return params

    def plan(self, params):
        def stage(name):
            def fn(ctx):
                ctx.check()
                self.at_stage_end(ctx, name)
                atomic_write_json(ctx.out("run.json"), {"stages": [*self.ran, name]})
                self.ran.append(name)
                return {}

            return fn

        return [Step(n, n, stage(n)) for n in ("inspect", "features", "match")]


@windows_only
def test_pause_while_the_app_reads_the_run_file_ends_cancelled_not_failed(tmp_path):
    """The flake of photo-process.spec.ts (CI run 38051445110), with a real open handle.

    Pause arrives after the stage's last cancel check, and the app reads ``run.json`` at that
    moment (its panels read the run again when a job changes state). The stage's own write of
    ``run.json`` was refused with WinError 5 and the job ended failed instead of cancelled.
    """
    readers: list[threading.Timer] = []

    def pause_during_features(ctx, name):
        if name != "features":
            return
        ctx.cancel_event.set()
        timer = threading.Timer(0.15, _hold_as_the_app(ctx.out("run.json")))
        timer.start()
        readers.append(timer)

    p = WritesRunFile(pause_during_features)
    job, rec = run(tmp_path, p, params={})
    try:
        with pytest.raises(Cancelled):
            job.run()
    finally:
        for t in readers:
            t.join()
    assert rec.of("error") == []
    assert p.ran == ["inspect", "features"]
    assert json.loads((tmp_path / "run.json").read_text())["stages"] == ["inspect", "features"]
    manifest = json.loads((tmp_path / "jobs" / "j1" / "job.json").read_text())
    assert manifest["status"] == "cancelled"
    assert [s["status"] for s in manifest["steps"]] == ["done", "done", "cancelled"]
