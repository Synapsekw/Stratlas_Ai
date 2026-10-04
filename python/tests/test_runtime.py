import json
import threading

import pytest

from aio_pipelines.runtime import (
    Cancelled,
    Job,
    JobError,
    Step,
    atomic_write_bytes,
    commit_files,
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
