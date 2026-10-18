"""Synthetic runtime checkpoints across the engineering measurement repair pack."""

import json
import threading
from pathlib import Path

import pytest

from aio_pipelines import runtime
from aio_pipelines.runtime import Cancelled, Job, JobError, Step


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


@pytest.mark.parametrize("version", ["0.13.0", "0.13.1", "0.12.0", "unknown"])
def test_upgrade_remeasures_old_evidence_before_relabelling_the_checkpoint(tmp_path, monkeypatch, version):
    manifest = old_checkpoint(tmp_path, monkeypatch, version)
    monkeypatch.setattr(runtime, "__version__", "0.14.0")
    repaired = EvidenceSteps(30)
    result = job(tmp_path, repaired).run()
    assert result["outputs"]["pack"]["height"] == 30
    assert repaired.ran == ["sections", "members", "pack"]
    assert json.loads(manifest.read_text())["version"] == "0.14.0"


def test_cancelling_the_upgrade_cannot_leave_old_members_under_the_new_version(tmp_path, monkeypatch):
    old_checkpoint(tmp_path, monkeypatch)
    monkeypatch.setattr(runtime, "__version__", "0.14.0")
    with pytest.raises(Cancelled):
        job(tmp_path, EvidenceSteps(30, cancel_in="members")).run()
    repaired = EvidenceSteps(30)
    result = job(tmp_path, repaired).run()
    assert result["outputs"]["pack"]["height"] == 30
    assert repaired.ran == ["members", "pack"]


@pytest.mark.parametrize("version", ["0.14.0", "0.14.1"])
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


class VersionedSteps(EvidenceSteps):
    name = "test.versioned"

    def __init__(self, height, checkpoint_version, cancel_in=None):
        super().__init__(height, cancel_in)
        self.checkpoint_version = checkpoint_version


def test_matching_pipeline_versions_reuse_finished_measurements(tmp_path):
    with pytest.raises(Cancelled):
        job(tmp_path, VersionedSteps(2.4, "measurements/1", cancel_in="pack")).run()
    resumed = VersionedSteps(30, "measurements/1")

    assert job(tmp_path, resumed).run()["outputs"]["pack"]["height"] == 2.4
    assert resumed.ran == ["pack"]
    manifest = tmp_path / "jobs/checkpoint-test/job.json"
    assert json.loads(manifest.read_text())["pipelineVersion"] == "measurements/1"


@pytest.mark.parametrize("previous_version", [None, "measurements/1"], ids=["legacy", "changed"])
def test_new_pipeline_versions_remeasure_every_stage_in_the_affected_job(tmp_path, previous_version):
    with pytest.raises(Cancelled):
        job(tmp_path, VersionedSteps(2.4, previous_version, cancel_in="pack")).run()
    unrelated = tmp_path / "jobs/other/steps/01-sections.json"
    unrelated.parent.mkdir(parents=True)
    unrelated.write_text('{"status":"done","outputs":{"height":12}}')
    resumed = VersionedSteps(30, "measurements/2")

    assert job(tmp_path, resumed).run()["outputs"]["pack"]["height"] == 30
    assert resumed.ran == ["sections", "members", "pack"]
    manifest = tmp_path / "jobs/checkpoint-test/job.json"
    assert json.loads(manifest.read_text())["pipelineVersion"] == "measurements/2"
    assert json.loads(unrelated.read_text())["outputs"]["height"] == 12


def test_interrupted_pipeline_invalidation_keeps_the_old_version_until_all_steps_are_removed(
    tmp_path, monkeypatch
):
    with pytest.raises(Cancelled):
        job(tmp_path, VersionedSteps(2.4, "measurements/1", cancel_in="pack")).run()
    manifest = tmp_path / "jobs/checkpoint-test/job.json"
    before = manifest.read_bytes()
    unlink = Path.unlink
    removed = []

    def interrupt_after_one(path, *args, **kwargs):
        if path.parent.name == "steps":
            if removed:
                raise OSError("interrupted invalidation")
            removed.append(path)
        return unlink(path, *args, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(Path, "unlink", interrupt_after_one)
        with pytest.raises(OSError, match="interrupted invalidation"):
            job(tmp_path, VersionedSteps(30, "measurements/2")).run()
    assert len(removed) == 1
    assert manifest.read_bytes() == before
    resumed = VersionedSteps(30, "measurements/2")
    assert job(tmp_path, resumed).run()["outputs"]["pack"]["height"] == 30
    assert resumed.ran == ["sections", "members", "pack"]


@pytest.mark.parametrize("change", ["inputs", "params"])
def test_pipeline_version_changes_do_not_bypass_source_or_parameter_checks(tmp_path, change):
    source = tmp_path / "input.txt"
    source.write_text("original")
    original = VersionedSteps(2.4, "measurements/1", cancel_in="pack")
    original.inputs = lambda params: ["input.txt"]
    with pytest.raises(Cancelled):
        job(tmp_path, original).run()
    manifest = tmp_path / "jobs/checkpoint-test/job.json"
    before = manifest.read_bytes()
    checkpoint = tmp_path / "jobs/checkpoint-test/steps/01-sections.json"
    previous_measurement = checkpoint.read_bytes()
    resumed = VersionedSteps(30, "measurements/2")
    resumed.inputs = original.inputs
    pending = job(tmp_path, resumed)
    if change == "inputs":
        source.write_text("changed source")
    else:
        pending.params = {"mode": "changed"}

    with pytest.raises(JobError, match=r"changed|different parameters"):
        pending.run()
    assert resumed.ran == []
    assert manifest.read_bytes() == before
    assert checkpoint.read_bytes() == previous_measurement


@pytest.mark.parametrize("version", [None, "", " "])
def test_pipelines_without_a_nonempty_checkpoint_version_keep_legacy_resume(tmp_path, version):
    with pytest.raises(Cancelled):
        job(tmp_path, VersionedSteps(2.4, version, cancel_in="pack")).run()
    resumed = VersionedSteps(30, version)
    assert job(tmp_path, resumed).run()["outputs"]["pack"]["height"] == 2.4
    assert resumed.ran == ["pack"]
    manifest = tmp_path / "jobs/checkpoint-test/job.json"
    assert "pipelineVersion" not in json.loads(manifest.read_text())


def test_model_evidence_checkpoints_use_the_measurement_algorithm_version():
    from aio_pipelines.engineer.observations import ALGORITHM
    from aio_pipelines.engineer.pipeline import ModelEvidence

    assert getattr(ModelEvidence, "checkpoint_version", None) == ALGORITHM


@pytest.mark.parametrize("previous", ["components/4", "components/5", "components/6"])
def test_cloud_discovery_invalidates_previous_measurements_without_supports(tmp_path, previous):
    from aio_pipelines.engineer.observations import ALGORITHM

    assert ALGORITHM == "components/7"
    with pytest.raises(Cancelled):
        job(tmp_path, VersionedSteps(2.4, previous, cancel_in="pack")).run()
    resumed = VersionedSteps(30, ALGORITHM)
    assert job(tmp_path, resumed).run()["outputs"]["pack"]["height"] == 30
    assert resumed.ran == ["sections", "members", "pack"]
