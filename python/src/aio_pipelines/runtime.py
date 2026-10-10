"""Job runtime: steps, per-step manifests, staging, atomic commits, progress and cancellation.

A job lives in ``<project>/jobs/<jobId>/``:

    job.json            name, params (and their hash), inputs hash, status, step list
    steps/NN-<step>.json one manifest per finished step: its outputs, start and finish times
    staging/            everything the job produces before it is moved into the project

Steps write only to ``staging/`` (temp file + rename, so a staged file is either complete or
absent). The last step commits staged files into the project with ``os.replace`` (atomic per
file, same volume) and moves index files (``cameras.json``, ``piles.json``) last, so the project
never refers to a file that is not there yet. Running a job again with the same id skips every
step that has a manifest: a cancelled or crashed job resumes where it stopped.
A resume is refused when the job's input files (``Pipeline.inputs``) changed since it started:
``job.json`` keeps a hash of their sorted paths, sizes and modification times.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
import traceback
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any, Protocol

from . import __version__

JOB_SCHEMA = "aio.job/1"
JOB_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
STEP_NAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,47}$")
PROGRESS_MIN_INTERVAL_S = 0.2


class JobError(Exception):
    """A failure the person can act on; the message is shown as is."""


class Cancelled(Exception):
    """The job was cancelled; staged work is kept for a resume."""


Emit = Callable[[str, dict[str, Any]], None]


@dataclass(frozen=True)
class Step:
    name: str
    title: str
    run: Callable[[StepContext], dict[str, Any] | None]
    weight: float = 1.0


class Pipeline(Protocol):
    name: str
    title: str
    description: str

    def validate(self, params: dict[str, Any]) -> dict[str, Any]: ...

    def plan(self, params: dict[str, Any]) -> list[Step]: ...

    # Optional: ``inputs(params) -> list[str]``, the files and folders the job reads (absolute or
    # project-relative). A resumed job refuses to continue when any of them changed.


INPUTS_CHANGED = "The input photos changed since this job started. Start the job again."


def input_fingerprint(project: Path, paths: Iterable[str]) -> dict[str, Any]:
    """Hash of the sorted input files with their sizes and modification times.

    Folders are walked (hidden files and the project's ``jobs/`` folder are left out); a missing
    path counts as missing, so deleting an input changes the hash too.
    """
    jobs_dir = (project / "jobs").resolve()
    entries: list[tuple[str, int, int]] = []
    for raw in paths:
        p = Path(raw)
        if not p.is_absolute():
            p = project / p
        if p.is_file():
            st = p.stat()
            entries.append((p.resolve().as_posix(), st.st_size, st.st_mtime_ns))
        elif p.is_dir():
            for f in p.rglob("*"):
                if f.name.startswith(".") or not f.is_file():
                    continue
                r = f.resolve()
                if r.is_relative_to(jobs_dir):
                    continue
                st = f.stat()
                entries.append((r.as_posix(), st.st_size, st.st_mtime_ns))
        else:
            entries.append((p.resolve().as_posix(), -1, -1))
    entries.sort()
    blob = "\n".join(f"{name}\t{size}\t{mtime}" for name, size, mtime in entries)
    return {"hash": hashlib.sha256(blob.encode("utf-8")).hexdigest()[:32], "files": len(entries)}


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def params_hash(params: dict[str, Any]) -> str:
    blob = json.dumps(params, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(blob.encode()).hexdigest()[:16]


def _tmp_for(path: Path) -> Path:
    return path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")


_WINDOWS = os.name == "nt"
# Waits between the tries of a refused rename: 10 ms doubling to 1.28 s, about 2.5 s in all (the
# same as the app's own writes, `renameOver` in apps/desktop/src/main/fsutil.ts).
_REPLACE_WAITS_S = tuple(0.01 * 2**i for i in range(8))


def replace_over(src: str | os.PathLike[str], dst: str | os.PathLike[str]) -> None:
    """``os.replace`` that waits for a reader of ``dst`` on Windows.

    Windows refuses to replace a file while any other process holds it open, even only to read it:
    the app reading ``run.json`` or ``manifest.json`` again when a job changes state, a search
    indexer, antivirus, a backup or sync client. Such a reader is gone within milliseconds, so
    there a refused rename is tried again for about 2.5 s before it fails. Without this a job
    failed with ``PermissionError: [WinError 5]`` whenever a stage's write met a read.
    """
    for wait in (*_REPLACE_WAITS_S, None):
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            if not _WINDOWS or wait is None:
                raise
            time.sleep(wait)


def atomic_write_bytes(path: Path, data: bytes) -> None:
    """Write a file so it is either the old version or the complete new one, never partial."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = _tmp_for(path)
    try:
        with open(tmp, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        replace_over(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink()


def atomic_write_json(path: Path, data: Any, indent: int | None = 1) -> None:
    atomic_write_bytes(path, (json.dumps(data, indent=indent, ensure_ascii=False) + "\n").encode("utf-8"))


class AtomicPath:
    """``with AtomicPath(dest) as tmp: write(tmp)`` renames tmp over dest only if the block succeeds."""

    def __init__(self, dest: Path):
        self.dest = dest
        self.tmp = dest.with_name(f".{dest.stem}.{os.getpid()}.{threading.get_ident()}.tmp{dest.suffix}")

    def __enter__(self) -> Path:
        self.dest.parent.mkdir(parents=True, exist_ok=True)
        return self.tmp

    def __exit__(self, exc_type, exc, tb) -> None:
        if exc_type is None:
            replace_over(self.tmp, self.dest)
        elif self.tmp.exists():
            self.tmp.unlink()


def safe_project_path(project: Path, rel: str) -> Path:
    """Resolve a project-relative output path; refuse anything that could leave the project."""
    if not isinstance(rel, str) or not rel.strip():
        raise JobError("An output path is empty.")
    norm = rel.replace("\\", "/")
    pp = PurePosixPath(norm)
    if pp.is_absolute() or re.match(r"^[A-Za-z]:", norm) or ".." in pp.parts:
        raise JobError(f'The output path "{rel}" must stay inside the project folder.')
    return project.joinpath(*pp.parts)


class StepContext:
    def __init__(self, job: Job, index: int, step: Step):
        self.job = job
        self.index = index
        self.step = step
        self.params = job.params
        self.project = job.project
        self.staging = job.staging
        self.cancel_event = job.cancel_event
        self._last_emit = 0.0
        self._last_fraction = -1.0

    # paths
    def stage(self, rel: str) -> Path:
        p = safe_project_path(self.staging, rel)
        p.parent.mkdir(parents=True, exist_ok=True)
        return p

    def out(self, rel: str) -> Path:
        return safe_project_path(self.project, rel)

    def input(self, path: str) -> Path:
        """An input path: absolute, or relative to the project. It must exist."""
        p = Path(path)
        if not p.is_absolute():
            p = self.project / p
        if not p.exists():
            raise JobError(f'The input "{path}" does not exist.')
        return p

    def outputs(self, step_name: str) -> dict[str, Any]:
        return self.job.step_outputs.get(step_name, {})

    # control
    def check(self) -> None:
        if self.cancel_event.is_set():
            raise Cancelled()

    def progress(self, fraction: float, message: str | None = None) -> None:
        fraction = min(1.0, max(0.0, float(fraction)))
        t = time.monotonic()
        if (
            fraction < 1.0
            and t - self._last_emit < PROGRESS_MIN_INTERVAL_S
            and fraction - self._last_fraction < 0.05
        ):
            return
        self._last_emit, self._last_fraction = t, fraction
        self.job.emit_progress(self.index, "running", fraction, message)

    def log(self, message: str, level: str = "info") -> None:
        self.job.log(message, level, self.step.name)

    def artifact(self, rel: str, kind: str = "file") -> None:
        self.job.emit("artifact", {"jobId": self.job.job_id, "path": rel.replace("\\", "/"), "kind": kind})


def commit_files(ctx: StepContext, moves: Iterable[tuple[str, str]], announce: bool = True) -> int:
    """Move staged files into the project. Idempotent, so a commit interrupted half way resumes."""
    moved = 0
    for staged_rel, project_rel in moves:
        ctx.check()
        src = safe_project_path(ctx.staging, staged_rel)
        dst = ctx.out(project_rel)
        if src.exists():
            dst.parent.mkdir(parents=True, exist_ok=True)
            replace_over(src, dst)
            moved += 1
        elif not dst.exists():
            raise JobError(f'The staged file "{staged_rel}" is missing; start the job again.')
        if announce:
            ctx.artifact(project_rel)
    return moved


def commit_tree(ctx: StepContext, staged_dir: str, project_dir: str) -> int:
    """Commit every file of a staged folder (e.g. review copies) into a project folder."""
    root = safe_project_path(ctx.staging, staged_dir)
    if not root.exists():
        return 0
    files = sorted(p for p in root.rglob("*") if p.is_file() and not p.name.startswith("."))
    moves = [
        (f"{staged_dir}/{p.relative_to(root).as_posix()}", f"{project_dir}/{p.relative_to(root).as_posix()}")
        for p in files
    ]
    n = commit_files(ctx, moves, announce=False)
    ctx.artifact(project_dir, "folder")
    return n


class Job:
    def __init__(
        self,
        job_id: str,
        pipeline: Pipeline,
        project: Path | str,
        params: dict[str, Any],
        emit: Emit,
        cancel_event: threading.Event,
    ):
        if not isinstance(job_id, str) or not JOB_ID.match(job_id):
            raise JobError(f'"{job_id}" is not a valid job id.')
        self.job_id = job_id
        self.pipeline = pipeline
        self.project = Path(project)
        self.params = params
        self.emit = emit
        self.cancel_event = cancel_event
        self.dir = self.project / "jobs" / job_id
        self.staging = self.dir / "staging"
        self.steps_dir = self.dir / "steps"
        self.step_outputs: dict[str, dict[str, Any]] = {}
        self.steps: list[Step] = []
        self.weights: list[float] = []
        self.done = 0.0
        self.inputs: dict[str, Any] | None = None

    # notifications
    def log(self, message: str, level: str = "info", step: str | None = None) -> None:
        msg: dict[str, Any] = {"jobId": self.job_id, "level": level, "message": message}
        if step:
            msg["step"] = step
        self.emit("log", msg)

    def emit_progress(self, index: int, state: str, step_fraction: float, message: str | None = None) -> None:
        total = sum(self.weights) or 1.0
        fraction = (self.done + self.weights[index] * step_fraction) / total
        msg: dict[str, Any] = {
            "jobId": self.job_id,
            "step": self.steps[index].name,
            "stepIndex": index,
            "steps": len(self.steps),
            "state": state,
            "stepFraction": round(step_fraction, 4),
            "fraction": round(min(1.0, fraction), 4),
        }
        if message:
            msg["message"] = message
        self.emit("progress", msg)

    # manifests
    def _manifest(
        self, status: str, error: str | None = None, states: list[str] | None = None
    ) -> dict[str, Any]:
        path = self.dir / "job.json"
        prev: dict[str, Any] = {}
        if path.exists():
            prev = json.loads(path.read_text("utf-8"))
        m = {
            "schema": JOB_SCHEMA,
            "jobId": self.job_id,
            "pipeline": self.pipeline.name,
            "version": __version__,
            "params": self.params,
            "paramsHash": params_hash(self.params),
            "createdAt": prev.get("createdAt") or now_iso(),
            "updatedAt": now_iso(),
            "status": status,
            "steps": [
                {"name": s.name, "title": s.title, "status": (states[i] if states else "pending")}
                for i, s in enumerate(self.steps)
            ],
        }
        inputs = self.inputs or prev.get("inputs")
        if inputs:
            m["inputs"] = inputs
        if error:
            m["error"] = error
        atomic_write_json(path, m)
        return m

    def _step_file(self, index: int, step: Step) -> Path:
        return self.steps_dir / f"{index + 1:02d}-{step.name}.json"

    def run(self) -> dict[str, Any]:
        if self.cancel_event.is_set():
            raise Cancelled()
        self.params = self.pipeline.validate(dict(self.params))
        self.steps = self.pipeline.plan(self.params)
        for s in self.steps:
            if not STEP_NAME.match(s.name):
                raise JobError(f'Step name "{s.name}" is not valid.')
        self.weights = [max(0.0, s.weight) for s in self.steps]
        prev_path = self.dir / "job.json"
        prev: dict[str, Any] = {}
        if prev_path.exists():
            prev = json.loads(prev_path.read_text("utf-8"))
            if (
                prev.get("paramsHash") != params_hash(self.params)
                or prev.get("pipeline") != self.pipeline.name
            ):
                raise JobError(
                    f"Job {self.job_id} was started with different parameters; start a new job instead of resuming."
                )
        inputs_of = getattr(self.pipeline, "inputs", None)
        if callable(inputs_of):
            self.inputs = input_fingerprint(self.project, inputs_of(self.params))
            started = prev.get("inputs") if prev_path.exists() else None
            if isinstance(started, dict) and started.get("hash") != self.inputs["hash"]:
                # leave job.json as it was: the job can only be started again
                raise JobError(INPUTS_CHANGED)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.staging.mkdir(parents=True, exist_ok=True)
        self.steps_dir.mkdir(parents=True, exist_ok=True)
        states = ["pending"] * len(self.steps)
        self._manifest("running", states=states)
        self.emit(
            "progress",
            {
                "jobId": self.job_id,
                "state": "plan",
                "steps": len(self.steps),
                "plan": [{"name": s.name, "title": s.title} for s in self.steps],
                "fraction": 0.0,
            },
        )
        current = 0
        try:
            for i, step in enumerate(self.steps):
                current = i
                sf = self._step_file(i, step)
                if sf.exists():
                    rec = json.loads(sf.read_text("utf-8"))
                    if rec.get("status") == "done":
                        self.step_outputs[step.name] = rec.get("outputs") or {}
                        states[i] = "done"
                        self.emit_progress(i, "skipped", 1.0, "Already done")
                        self.done += self.weights[i]
                        continue
                if self.cancel_event.is_set():
                    raise Cancelled()
                states[i] = "running"
                self._manifest("running", states=states)
                self.emit_progress(i, "start", 0.0, step.title)
                started = now_iso()
                ctx = StepContext(self, i, step)
                outputs = step.run(ctx) or {}
                atomic_write_json(
                    sf,
                    {
                        "step": step.name,
                        "status": "done",
                        "startedAt": started,
                        "finishedAt": now_iso(),
                        "outputs": outputs,
                    },
                )
                self.step_outputs[step.name] = outputs
                states[i] = "done"
                self.emit_progress(i, "done", 1.0)
                self.done += self.weights[i]
        except Cancelled:
            states[current] = "cancelled"
            self._manifest("cancelled", states=states)
            self.log("Cancelled. Finished steps are kept; resume to continue.", "warn")
            raise
        except JobError as e:
            states[current] = "failed"
            self._manifest("failed", error=str(e), states=states)
            self.emit("error", {"jobId": self.job_id, "step": self.steps[current].name, "message": str(e)})
            raise
        except Exception as e:
            states[current] = "failed"
            msg = f"{type(e).__name__}: {e}"
            self._manifest("failed", error=msg, states=states)
            self.emit(
                "error",
                {
                    "jobId": self.job_id,
                    "step": self.steps[current].name,
                    "message": msg,
                    "traceback": traceback.format_exc(limit=8),
                },
            )
            raise
        self._manifest("done", states=states)
        return {
            "jobId": self.job_id,
            "status": "done",
            "outputs": {s.name: self.step_outputs.get(s.name, {}) for s in self.steps},
        }
