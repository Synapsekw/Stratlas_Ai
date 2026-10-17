"""Crown location: the cloud, the tower axis (evidence, hint or automatic) and the equipment band."""

from __future__ import annotations

import json
import os
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from aio_pipelines.engineer.axis import Axis
from aio_pipelines.inspection.frame import read_manifest
from aio_pipelines.runtime import JobError
from aio_pipelines.telecom import crown as crown_mod
from aio_pipelines.telecom.crown import (
    CROP_RADIUS_M,
    DEFAULT_FLOOR_FRACTION,
    HINT_RADIUS_M,
    MIN_CROWN_POINTS,
    NO_CLOUD,
    NO_TOWER,
    SPARSE_CROWN,
    TOWER_HINT_NEEDED,
    ShaftRadius,
    locate_crown,
    newest_evidence,
    pick_cloud_layer,
    shaft_radius_fn,
)
from antenna_synth import make_tower_project, tower_cloud, two_masts_cloud

TRUE_AXIS = {"point": [0.0, 0.0, 0.0], "dir": [0.0, 1.0, 0.0], "tiltDeg": 0.0}


def write_evidence(root: Path, run: str, axis: dict, height: float, cloud: str | None = "tower-cloud"):
    d = root / "engineering" / run
    d.mkdir(parents=True, exist_ok=True)
    setup = {"sources": {"clouds": [{"layer": cloud}] if cloud else []}}
    (d / "run.json").write_text(json.dumps({"schema": "aio.engineer-run/1", "id": run, "setup": setup}))
    doc = {
        "schema": "aio.evidence/1",
        "run": run,
        "axis": axis,
        "height": height,
        "crop": None,
        "base": axis["point"],
    }
    (d / "evidence.json").write_text(json.dumps(doc))


def crown_for(tmp_path, xyz, evidence=None, project_kwargs=None, **params):
    """make_tower_project + a ctx stub (check, job.dir, project), then locate_crown."""
    root = make_tower_project(tmp_path / "proj", xyz, **(project_kwargs or {}))
    if evidence is not None:
        write_evidence(root, "run-e", *evidence)
    job_dir = tmp_path / "job"
    job_dir.mkdir(exist_ok=True)
    ctx = SimpleNamespace(check=lambda: None, job=SimpleNamespace(dir=job_dir), project=root)
    return locate_crown(ctx, root, read_manifest(root), {"run": "run-t", **params})


def off_axis(c, xz):
    return float(np.hypot(c.axis.point[0] - xz[0], c.axis.point[2] - xz[1]))


def test_auto_finds_monopole_axis(tmp_path):
    xyz, truth = tower_cloud("monopole", seed=1)
    c = crown_for(tmp_path, xyz)
    p = truth["axis"]["point"]
    assert c.source == "auto" and off_axis(c, (p[0], p[2])) < 0.1
    assert c.top_y == pytest.approx(truth["height"], abs=0.3)
    assert c.floor_y <= min(u["centre"][1] - u["heightM"] / 2 for u in truth["units"])
    assert c.layer_id == "tower-cloud" and len(c.xyz) >= MIN_CROWN_POINTS
    assert float(c.xyz[:, 1].min()) >= c.floor_y - 1e-6


def test_evidence_axis_is_used(tmp_path):
    xyz, truth = tower_cloud(seed=1)
    c = crown_for(tmp_path, xyz, evidence=(TRUE_AXIS, truth["height"]))
    assert c.source == "evidence"
    assert c.height == pytest.approx(truth["height"])
    assert off_axis(c, (0.0, 0.0)) < 1e-9


def test_two_masts_need_a_hint(tmp_path):
    with pytest.raises(JobError, match="Click the tower once"):
        crown_for(tmp_path, two_masts_cloud(seed=1)[0])


def test_hint_picks_the_mast(tmp_path):
    xyz, truth = two_masts_cloud(seed=1)
    c = crown_for(tmp_path, xyz, towerHint=truth["masts"][1]["xz"])
    assert c.source == "hint" and off_axis(c, truth["masts"][1]["xz"]) < 0.15
    # the other mast does not leak into the crown cylinder
    assert float(np.hypot(c.xyz[:, 0] - truth["masts"][1]["xz"][0], c.xyz[:, 2]).max()) < 6.0


def test_ground_only_has_no_tower(tmp_path):
    xyz, _ = tower_cloud("monopole", seed=1)
    ground = xyz[xyz[:, 1] < 0.05]
    assert len(ground) > 1000
    with pytest.raises(JobError) as e:
        crown_for(tmp_path, ground)
    assert str(e.value) == NO_TOWER


def test_sparse_crown(tmp_path):
    xyz, truth = tower_cloud("monopole", seed=1)
    rng = np.random.default_rng(3)
    high = np.flatnonzero(xyz[:, 1] >= 21.0)
    keep = np.setdiff1d(np.arange(len(xyz)), high)
    xyz = np.vstack([xyz[keep], xyz[rng.choice(high, 400, replace=False)]])
    with pytest.raises(JobError) as e:
        crown_for(tmp_path, xyz, evidence=(TRUE_AXIS, truth["height"]))
    assert str(e.value) == SPARSE_CROWN


def test_empty_band(tmp_path):
    xyz, _ = tower_cloud("monopole", seed=1)
    xyz = xyz[xyz[:, 1] <= 12.0]
    with pytest.raises(JobError) as e:
        crown_for(tmp_path, xyz, evidence=(TRUE_AXIS, 30.0))
    assert str(e.value) == crown_mod.EMPTY_BAND


def test_lattice_crown(tmp_path):
    xyz, truth = tower_cloud("lattice", seed=1)
    c = crown_for(tmp_path, xyz)
    assert c.source == "auto" and off_axis(c, (0.0, 0.0)) < 0.15
    assert c.floor_y <= min(u["centre"][1] - u["heightM"] / 2 for u in truth["units"])
    assert c.floor_y > 0.5 * truth["height"]
    assert not c.warnings


def test_height_offset_is_applied(tmp_path):
    xyz, truth = tower_cloud("monopole", seed=1)
    c = crown_for(tmp_path, xyz, project_kwargs={"height_offset_m": 100.0})
    assert c.top_y == pytest.approx(truth["height"], abs=0.3)
    assert float(c.xyz[:, 1].max()) < truth["height"] + 1.5


def test_default_floor_and_warning_when_no_band_is_found(tmp_path, monkeypatch):
    monkeypatch.setattr(crown_mod, "_floor_h", lambda *a, **k: None)
    xyz, truth = tower_cloud("monopole", seed=1)
    c = crown_for(tmp_path / "a", xyz, evidence=(TRUE_AXIS, truth["height"]))
    assert c.floor_y == pytest.approx(DEFAULT_FLOOR_FRACTION * truth["height"], abs=1e-6)
    assert len(c.warnings) == 1 and "70%" in c.warnings[0]
    c = crown_for(tmp_path / "b", xyz, evidence=(TRUE_AXIS, truth["height"]), floorFraction=0.8)
    assert c.floor_y == pytest.approx(0.8 * truth["height"], abs=1e-6)
    assert "80%" in c.warnings[0]


def test_floor_h_needs_fifty_points_in_a_slice():
    shaft = ShaftRadius(0.0, 0.5)
    h = np.concatenate([np.full(49, 24.1), np.full(50, 25.6), np.full(60, 27.0)])
    r = np.full(len(h), 2.0)
    assert crown_mod._floor_h(h, r, shaft, 30.0) == pytest.approx(25.5 - 0.3, abs=0.25)
    assert crown_mod._floor_h(h, np.full(len(h), 0.6), shaft, 30.0) is None


def test_shaft_radius_matches_truth_and_round_trips():
    xyz, truth = tower_cloud("monopole", seed=1)
    axis = Axis((0.0, 0.0, 0.0), (0.0, 1.0, 0.0), 0.0)
    fn = shaft_radius_fn(xyz[np.hypot(xyz[:, 0], xyz[:, 2]) < 8.0], axis, truth["height"])
    (y0, r0), (y1, r1) = truth["shaftRadiusAt"]
    for y, r in ((y0, r0), (y1, r1)):
        assert float(fn(np.array([y]))[0]) == pytest.approx(r, abs=0.06)
    again = ShaftRadius.from_coef(fn.coef)
    h = np.linspace(0, 30, 7)
    assert np.allclose(again(h), fn(h))
    assert len(fn.coef) == 2 and all(isinstance(v, float) for v in fn.coef)


def test_pick_cloud_layer(tmp_path):
    xyz, _ = tower_cloud("monopole", seed=1)
    root = make_tower_project(tmp_path / "p", xyz)
    manifest = read_manifest(root)
    base = manifest["layers"][0]
    older = {**base, "id": "old-cloud", "visible": False}
    newer = {**base, "id": "new-cloud"}
    hidden_last = {**base, "id": "hidden-cloud", "visible": False}
    manifest["layers"] = [older, base, newer, hidden_last, {"kind": "mesh", "id": "m", "name": "m"}]
    layer, ev = pick_cloud_layer(root, manifest, None)
    assert layer["id"] == "new-cloud" and ev is None
    assert pick_cloud_layer(root, manifest, "tower-cloud")[0]["id"] == "tower-cloud"
    write_evidence(root, "run-e", TRUE_AXIS, 30.0, cloud="tower-cloud")
    layer, ev = pick_cloud_layer(root, manifest, None)
    assert layer["id"] == "tower-cloud" and ev["height"] == 30.0 and ev["cloud"] == "tower-cloud"
    # a different requested cloud does not take the evidence of another
    assert pick_cloud_layer(root, manifest, "new-cloud")[1] is None
    with pytest.raises(JobError) as e:
        pick_cloud_layer(root, manifest, "m")
    assert "not a point cloud" in str(e.value)
    manifest["layers"] = [{"kind": "mesh", "id": "m", "name": "m"}]
    with pytest.raises(JobError) as e:
        pick_cloud_layer(root, manifest, None)
    assert str(e.value) == NO_CLOUD


def test_newest_evidence_takes_the_latest_with_a_pack(tmp_path):
    root = tmp_path / "p"
    assert newest_evidence(root) is None
    write_evidence(root, "run-a", TRUE_AXIS, 10.0)
    (root / "engineering" / "run-nopack").mkdir()
    (root / "engineering" / "run-nopack" / "run.json").write_text("{}")
    assert newest_evidence(root)["height"] == 10.0
    write_evidence(root, "run-b", TRUE_AXIS, 20.0)
    os.utime(root / "engineering" / "run-a" / "evidence.json", (1, 1))
    assert newest_evidence(root)["height"] == 20.0


def test_constants():
    assert (CROP_RADIUS_M, HINT_RADIUS_M, DEFAULT_FLOOR_FRACTION) == (30.0, 8.0, 0.7)
    assert TOWER_HINT_NEEDED.startswith("Could not tell which structure is the tower.")
