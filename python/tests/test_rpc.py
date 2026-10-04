"""The real server process over stdio, as the app runs it."""

import json
import queue
import subprocess
import sys
import threading
import time

import pytest


class Client:
    def __init__(self):
        self.p = subprocess.Popen(
            [sys.executable, "-m", "aio_pipelines"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.q: queue.Queue = queue.Queue()
        self.next_id = 0
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.p.stdout:
            self.q.put(json.loads(line))
        self.q.put(None)

    def send(self, obj):
        self.p.stdin.write((json.dumps(obj) + "\n").encode())
        self.p.stdin.flush()

    def request(self, method, params=None):
        self.next_id += 1
        self.send({"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params or {}})
        return self.next_id

    def until(self, pred, timeout=30):
        seen = []
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            msg = self.q.get(timeout=max(0.01, end - time.monotonic()))
            if msg is None:
                raise AssertionError(f"server exited; stderr: {self.p.stderr.read().decode()}")
            seen.append(msg)
            if pred(msg):
                return msg, seen
        raise AssertionError(f"timed out; saw {seen[-5:]}")

    def close(self):
        if self.p.poll() is None:
            self.p.stdin.close()
            self.p.wait(15)


@pytest.fixture
def client():
    c = Client()
    yield c
    c.close()


def test_version_and_list(client):
    rid = client.request("version")
    msg, _ = client.until(lambda m: m.get("id") == rid)
    assert msg["result"]["protocol"] == "aio.pipelines/1"
    assert msg["result"]["python"].startswith("3.")
    rid = client.request("pipelines.list")
    msg, _ = client.until(lambda m: m.get("id") == rid)
    names = {p["name"] for p in msg["result"]}
    assert {"aik.cameras", "aik.project", "aik.records", "volumetric.process", "system.selftest"} <= names


def test_protocol_errors(client):
    client.p.stdin.write(b"{not json\n")
    client.p.stdin.flush()
    msg, _ = client.until(lambda m: "error" in m)
    assert msg["error"]["code"] == -32700
    rid = client.request("nope")
    msg, _ = client.until(lambda m: m.get("id") == rid)
    assert msg["error"]["code"] == -32601
    rid = client.request("jobs.run", {"jobId": "x", "name": "missing", "project": "."})
    msg, _ = client.until(lambda m: m.get("id") == rid)
    assert msg["error"]["code"] == -32602


def test_a_job_streams_progress_and_answers_when_done(client, tmp_path):
    rid = client.request(
        "jobs.run", {"jobId": "s1", "name": "system.selftest", "project": str(tmp_path), "params": {}}
    )
    msg, seen = client.until(lambda m: m.get("id") == rid, timeout=120)
    assert msg["result"]["status"] == "done"
    kinds = {m.get("method") for m in seen}
    assert {"progress", "log", "artifact"} <= kinds
    assert (tmp_path / "jobs" / "s1" / "selftest.json").exists()


def test_cancel_then_resume(client, tmp_path):
    params = {"jobId": "c1", "name": "system.selftest", "project": str(tmp_path), "params": {"seconds": 30}}
    rid = client.request("jobs.run", params)
    client.until(lambda m: m.get("method") == "progress" and m["params"]["step"] == "wait", timeout=120)
    cid = client.request("cancel", {"jobId": "c1"})
    _, seen = client.until(lambda m: m.get("id") == rid, timeout=10)
    answers = {m["id"]: m for m in seen if "id" in m}
    assert answers[cid]["result"] == {"ok": True}
    assert answers[rid]["error"]["code"] == -32001
    job = json.loads((tmp_path / "jobs" / "c1" / "job.json").read_text())
    assert job["status"] == "cancelled"
    assert [s["status"] for s in job["steps"]] == ["done", "cancelled", "pending"]

    rid = client.request("jobs.run", params)
    msg, _ = client.until(
        lambda m: m.get("method") == "progress" and m["params"]["step"] == "libraries", timeout=60
    )
    assert msg["params"]["state"] == "skipped"
    client.request("cancel", {"jobId": "c1"})
    client.until(lambda m: m.get("id") == rid, timeout=10)


def test_closing_stdin_cancels_running_jobs_and_exits(client, tmp_path):
    client.request(
        "jobs.run",
        {"jobId": "e1", "name": "system.selftest", "project": str(tmp_path), "params": {"seconds": 60}},
    )
    client.until(lambda m: m.get("method") == "progress" and m["params"]["step"] == "wait", timeout=120)
    client.p.stdin.close()
    assert client.p.wait(15) == 0
    assert json.loads((tmp_path / "jobs" / "e1" / "job.json").read_text())["status"] == "cancelled"
