"""Synthetic runtime checkpoints across the engineering measurement repair pack."""

import json
import threading

import pytest

from aio_pipelines import runtime
from aio_pipelines.runtime import Cancelled, Job, Step


class EvidenceSteps:
    name = "model.evidence"
    title = "Synthetic measurements"
    description = "Checkpoint regression"

    def __init__(self, height, cancel_in=None):
        self.height = height
        self.cancel_in = cancel_in
        self.ran = []

    def validate(self, params):
        return params

    def plan(self, params):
        def sections(ctx):
            self.ran.append("sections")
            return {"height": self.height}

        def members(ctx):
            self.ran.append("members")
            if self.cancel_in == "members":
                ctx.cancel_event.set()
                ctx.check()
            return {"height": ctx.outputs("sections")["height"]}

        def pack(ctx):
            self.ran.append("pack")
            if self.cancel_in == "pack":
                ctx.cancel_event.set()
                ctx.check()
            return {"height": ctx.outputs("members")["height"]}

        return [
            Step("sections", "Sections", sections),
            Step("members", "Members", members),
            Step("pack", "Pack", pack),
        ]


def job(root, pipeline):
    return Job("checkpoint-test", pipeline, root, {}, lambda *_: None, threading.Event())


def old_checkpoint(root, monkeypatch, version="0.13.0", name="model.evidence"):
    monkeypatch.setattr(runtime, "__version__", version)
    pipeline = EvidenceSteps(2.4, cancel_in="pack")
    pipeline.name = name
    with pytest.raises(Cancelled):
        job(root, pipeline).run()
    return root / "jobs" / "checkpoint-test" / "job.json"


@pytest.mark.parametrize("version", ["0.13.0", "0.12.0", "unknown"])
def test_upgrade_remeasures_old_evidence_before_relabelling_the_checkpoint(tmp_path, monkeypatch, version):
    manifest = old_checkpoint(tmp_path, monkeypatch, version)
    monkeypatch.setattr(runtime, "__version__", "0.13.1")
    repaired = EvidenceSteps(30)
    result = job(tmp_path, repaired).run()
    assert result["outputs"]["pack"]["height"] == 30
    assert repaired.ran == ["sections", "members", "pack"]
    assert json.loads(manifest.read_text())["version"] == "0.13.1"


def test_cancelling_the_upgrade_cannot_leave_old_members_under_the_new_version(tmp_path, monkeypatch):
    old_checkpoint(tmp_path, monkeypatch)
    monkeypatch.setattr(runtime, "__version__", "0.13.1")
    with pytest.raises(Cancelled):
        job(tmp_path, EvidenceSteps(30, cancel_in="members")).run()
    repaired = EvidenceSteps(30)
    result = job(tmp_path, repaired).run()
    assert result["outputs"]["pack"]["height"] == 30
    assert repaired.ran == ["members", "pack"]


@pytest.mark.parametrize("version", ["0.13.1", "0.14.0"])
def test_compatible_evidence_checkpoints_keep_finished_steps(tmp_path, monkeypatch, version):
    old_checkpoint(tmp_path, monkeypatch, version)
    monkeypatch.setattr(runtime, "__version__", "0.14.0")
    resumed = EvidenceSteps(30)
    assert job(tmp_path, resumed).run()["outputs"]["pack"]["height"] == 2.4
    assert resumed.ran == ["pack"]


def test_other_pipelines_keep_their_existing_cross_version_resume_behavior(tmp_path, monkeypatch):
    old_checkpoint(tmp_path, monkeypatch, name="test.other")
    monkeypatch.setattr(runtime, "__version__", "0.13.1")
    resumed = EvidenceSteps(30)
    resumed.name = "test.other"
    assert job(tmp_path, resumed).run()["outputs"]["pack"]["height"] == 2.4
    assert resumed.ran == ["pack"]
