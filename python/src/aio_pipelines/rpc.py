"""JSON-RPC 2.0 over stdio, one JSON object per line.

Requests from the app:
    jobs.run        {jobId, name, project, params}  -> {jobId, status: "done", outputs}
    cancel          {jobId}                         -> {ok}
    pipelines.list  {}                              -> [{name, title, description}]
    version         {}                              -> {version, protocol, python, appRange}
    shutdown        {}                              -> {ok}, then the process exits
Notifications to the app (no id): progress, log, artifact, error; each carries jobId.

``jobs.run`` answers when the job ends. A cancelled job answers with error code CANCELLED, a
failed one with JOB_FAILED; both keep their staged work so the same jobId resumes. When stdin
closes (the app quit or crashed) every running job is cancelled and the process exits.
"""

from __future__ import annotations

import json
import platform
import threading
from typing import Any, TextIO

from . import APP_RANGE, PROTOCOL, __version__
from .runtime import Cancelled, Job, JobError, Pipeline

PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603
JOB_FAILED = -32000
CANCELLED = -32001
JOB_EXISTS = -32002


class RpcError(Exception):
    def __init__(self, code: int, message: str, data: Any = None):
        super().__init__(message)
        self.code, self.message, self.data = code, message, data


class Server:
    def __init__(self, reader: TextIO, writer: TextIO, pipelines: dict[str, Pipeline]):
        self.reader = reader
        self.writer = writer
        self.pipelines = pipelines
        self.lock = threading.Lock()
        self.jobs: dict[str, tuple[threading.Thread, threading.Event]] = {}
        self.stopping = False

    # output
    def send(self, msg: dict[str, Any]) -> None:
        line = json.dumps(msg, ensure_ascii=True, separators=(",", ":"), default=str)
        with self.lock:
            self.writer.write(line + "\n")
            self.writer.flush()

    def notify(self, method: str, params: dict[str, Any]) -> None:
        self.send({"jsonrpc": "2.0", "method": method, "params": params})

    def reply(self, rid: Any, result: Any) -> None:
        self.send({"jsonrpc": "2.0", "id": rid, "result": result})

    def fail(self, rid: Any, code: int, message: str, data: Any = None) -> None:
        err: dict[str, Any] = {"code": code, "message": message}
        if data is not None:
            err["data"] = data
        self.send({"jsonrpc": "2.0", "id": rid, "error": err})

    # input
    def handle_line(self, line: str) -> None:
        line = line.strip()
        if not line:
            return
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as e:
            self.fail(None, PARSE_ERROR, f"Parse error: {e}")
            return
        if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0" or not isinstance(msg.get("method"), str):
            self.fail(msg.get("id") if isinstance(msg, dict) else None, INVALID_REQUEST, "Invalid request")
            return
        rid = msg.get("id")
        params = msg.get("params") or {}
        method = msg["method"]
        try:
            if not isinstance(params, dict):
                raise RpcError(INVALID_PARAMS, "params must be an object")
            handler = {
                "jobs.run": self._run,
                "cancel": self._cancel,
                "pipelines.list": self._list,
                "version": self._version,
                "shutdown": self._shutdown,
            }.get(method)
            if handler is None:
                raise RpcError(METHOD_NOT_FOUND, f"Method not found: {method}")
            result = handler(rid, params)
            if result is not None and rid is not None:
                self.reply(rid, result)
        except RpcError as e:
            if rid is not None:
                self.fail(rid, e.code, e.message, e.data)
        except Exception as e:  # never let one bad message kill the server
            if rid is not None:
                self.fail(rid, INTERNAL_ERROR, f"{type(e).__name__}: {e}")

    def serve(self) -> int:
        for line in self.reader:
            self.handle_line(line)
            if self.stopping:
                break
        self.cancel_all()
        self.wait(timeout=10)
        return 0

    # job control
    def cancel_all(self) -> None:
        for _, ev in list(self.jobs.values()):
            ev.set()

    def wait(self, timeout: float | None = None) -> None:
        for t, _ in list(self.jobs.values()):
            t.join(timeout)

    # methods
    def _version(self, rid, params):
        return {
            "version": __version__,
            "protocol": PROTOCOL,
            "python": platform.python_version(),
            "appRange": APP_RANGE,
        }

    def _list(self, rid, params):
        return [
            {"name": p.name, "title": p.title, "description": p.description} for p in self.pipelines.values()
        ]

    def _shutdown(self, rid, params):
        self.stopping = True
        self.cancel_all()
        return {"ok": True}

    def _cancel(self, rid, params):
        entry = self.jobs.get(str(params.get("jobId")))
        if entry is None:
            return {"ok": False}
        entry[1].set()
        return {"ok": True}

    def _run(self, rid, params):
        job_id = params.get("jobId")
        name = params.get("name")
        project = params.get("project")
        job_params = params.get("params") or {}
        if not isinstance(job_id, str) or not isinstance(name, str) or not isinstance(project, str):
            raise RpcError(INVALID_PARAMS, "jobs.run needs jobId, name and project")
        if not isinstance(job_params, dict):
            raise RpcError(INVALID_PARAMS, "jobs.run params must be an object")
        pipeline = self.pipelines.get(name)
        if pipeline is None:
            raise RpcError(INVALID_PARAMS, f'There is no pipeline called "{name}".')
        running = self.jobs.get(job_id)
        if running and running[0].is_alive():
            raise RpcError(JOB_EXISTS, f"Job {job_id} is already running.")
        ev = threading.Event()
        try:
            job = Job(job_id, pipeline, project, job_params, self.notify, ev)
        except JobError as e:
            raise RpcError(INVALID_PARAMS, str(e)) from e

        def work():
            try:
                self.reply(rid, job.run())
            except Cancelled:
                self.fail(rid, CANCELLED, "Cancelled", {"jobId": job_id})
            except JobError as e:
                self.fail(rid, JOB_FAILED, str(e), {"jobId": job_id})
            except Exception as e:
                self.fail(rid, JOB_FAILED, f"{type(e).__name__}: {e}", {"jobId": job_id})

        t = threading.Thread(target=work, name=f"job-{job_id}", daemon=True)
        self.jobs[job_id] = (t, ev)
        t.start()
        return None  # answered by the worker
