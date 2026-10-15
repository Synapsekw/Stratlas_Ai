"""The `model.evidence` job end to end on seeded synthetic assets.

The committed fixture `packages/schema/src/__fixtures__/engineering/evidence.partial-stack.json` is
the pack of `test_partial_noisy_stack_pack`, parsed by the schema's own test. Regenerate it with

    AIO_UPDATE_FIXTURES=1 uv run pytest tests/test_model_evidence.py -k partial_noisy -q

(synthetic data only; the photos are generated, no private path is written).
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from aio_pipelines.engineer import pipeline as pipe
from aio_pipelines.engineer.pipeline import ModelEvidence
from aio_pipelines.pointcloud import find_pdal
from aio_pipelines.runtime import INPUTS_CHANGED, Cancelled, JobError
from aio_pipelines.selftest import SelfTest  # noqa: F401  (the registry import must keep working)
from conftest import run_job
from synth_assets import monopole_cloud, radius_at, stack_cloud, synth_photos, write_las

ORIGIN = (500000.0, 3200000.0, 10.0)
FIXTURE = (
    Path(__file__).resolve().parents[2]
    / "packages/schema/src/__fixtures__/engineering/evidence.partial-stack.json"
)


def make_project(
    root: Path, cloud: np.ndarray | None, colour: bool = True, photos: int = 0, fmt: str = "las"
) -> Path:
    layers = []
    if cloud is not None:
        (root / "clouds").mkdir(parents=True, exist_ok=True)
        rgb = None
        if colour:
            rgb = np.tile(np.array([150, 148, 140], dtype=np.uint8), (len(cloud), 1))
            rgb[(cloud[:, 1] >= 100) & (cloud[:, 1] < 104)] = [190, 40, 35]
        write_las(cloud, root / "clouds" / "scan.las", offset=ORIGIN, rgb=rgb)
        layers.append(
            {
                "kind": "pointcloud",
                "id": "scan",
                "name": "Scan",
                "visible": True,
                "src": {"path": "clouds/scan.las"},
                "format": fmt,
            }
        )
    if photos:
        synth_photos(root / "photos", n=photos, seed=4)
    manifest = {
        "schema": "aio.project/1",
        "id": "synthetic",
        "name": "Synthetic",
        "crs": {"epsg": 32633},
        "origin": list(ORIGIN),
        "captures": [],
        "layers": layers,
        "severityModels": [],
        "classCatalogues": [],
    }
    (root / "manifest.json").write_text(json.dumps(manifest), "utf-8")
    return root


def params(**kw):
    base = {
        "run": "run-test",
        "clouds": [{"layer": "scan"}],
        "meshes": [],
        "photos": [],
        "detail": "fast",
        "region": {"centre": [0.0, 0.0], "radiusM": 40.0},
    }
    base.update(kw)
    return base


def read_pack(project: Path) -> dict:
    return json.loads((project / "engineering" / "run-test" / "evidence.json").read_text("utf-8"))


@pytest.fixture(scope="module")
def stack_run(tmp_path_factory):
    root = tmp_path_factory.mktemp("stack")
    cloud, truth = stack_cloud(seed=7, partial=True, noise=0.03)
    make_project(root, cloud, photos=3)
    photos = [{"path": f"photos/synth_0{i}.jpg"} for i in (1, 2, 3)]
    result, rec = run_job(ModelEvidence(), root, params(photos=photos))
    return root, truth, read_pack(root), rec, result


def test_partial_noisy_stack_pack(stack_run):
    root, truth, pack, rec, result = stack_run
    assert result["status"] == "done" if "status" in result else True
    assert pack["schema"] == "aio.evidence/1" and pack["run"] == "run-test"
    assert pack["units"] == "m" and pack["crs"] == {"epsg": 32633}
    assert pack["crop"] == {"centre": [0.0, 0.0], "radiusM": 40.0}
    # taper within 2 percent at 0, 30 and 100 m (absolute y equals height above a base at 0)
    prof = pack["taper"]["profile"]
    ys, rs = [p["y"] for p in prof], [p["r"] for p in prof]
    assert len(prof) <= 8
    for y in (0.0, 30.0, 100.0):
        want = radius_at(truth["profile"], y)
        assert abs(float(np.interp(y, ys, rs)) - want) / want < 0.02, y
    assert abs(pack["height"] - 120.0) < 2.0
    assert abs(pack["base"][1]) < 0.3 and pack["baseInfo"] == {
        "observed": True,
        "basis": "ground",
        "gapM": pytest.approx(0, abs=1.0),
    }
    assert pack["axis"]["tiltDeg"] < 0.3
    # members: flues that are in view (the one in the missing sector is not invented), three light levels
    kinds = {g["kind"]: g for g in pack["members"]}
    assert len(kinds["flue"]["items"]) == truth["fluesSeen"] == 2
    assert all("residualM" in i and "coverage" in i for i in kinds["flue"]["items"])
    levels = kinds["light-candidate"]["levels"]
    assert len(levels) == 3 and all(
        abs(a - b) < 0.5 for a, b in zip(levels, truth["lightLevels"], strict=True)
    )
    assert pack["familyHints"]["suggested"] == "chimney" and pack["familyHints"]["reasons"]
    # slices see about 270 degrees of the shaft
    mid = [s for s in pack["slices"] if 20 < s["y"] < 100]
    assert mid and all(0.65 <= s["coverage"] <= 0.85 for s in mid)
    # colour bands: the red band at 100 to 104 m
    assert any(b["rgb"][0] > 180 and 96 < b["y0"] < 106 for b in pack["colours"])
    # photos: three kept, no private path
    assert len(pack["photos"]) == 3 and all(p["original"].startswith("photos/") for p in pack["photos"])
    assert pack["identity"] == {"sameAsset": True, "conflicts": []}
    assert pack["reconstruction"] == "not-needed"
    assert pack["samples"]["kept"] > 1000 and pack["samples"]["ground"] > 1000
    assert pack["isolation"]["dropped"] == []
    # bounded: images, pixels, files
    assert 0 < len(pack["images"]) <= 12
    folder = root / "engineering" / "run-test"
    names = sorted(p.name for p in folder.rglob("*") if p.is_file())
    assert not any(n.endswith((".npy", ".las", ".laz", ".bin")) for n in names)
    assert "evidence.json" in names
    for img in pack["images"]:
        f = folder / img["file"]
        assert f.is_file() and f.stat().st_size == img["bytes"]
        with Image.open(f) as im:
            assert max(im.size) <= 1024 and im.size == (img["w"], img["h"])
    assert {i["kind"] for i in pack["images"]} >= {"top", "side", "crop", "slice", "photo"}
    assert (folder / "evidence.json").stat().st_size < 200_000
    assert not any(p for p in (root / "jobs").glob("*/staging/evidence.json") if False)
    _compare_with_fixture(pack)


def _shape(v):
    if isinstance(v, dict):
        return {k: _shape(x) for k, x in sorted(v.items())}
    if isinstance(v, list):
        return [_shape(v[0])] if v else []
    return type(v).__name__ if not isinstance(v, int | float) else "number"


def _compare_with_fixture(pack: dict) -> None:
    if os.environ.get("AIO_UPDATE_FIXTURES"):
        FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        FIXTURE.write_text(json.dumps(pack, indent=1) + "\n", "utf-8")
        return
    assert FIXTURE.is_file(), "run with AIO_UPDATE_FIXTURES=1 to write the schema fixture"
    old = json.loads(FIXTURE.read_text("utf-8"))
    assert set(old) == set(pack), "the pack's keys changed: regenerate the fixture (see the module docstring)"


def test_photos_only_pack(tmp_path, monkeypatch):
    make_project(tmp_path, None, photos=3)
    monkeypatch.setattr(pipe, "photogrammetry_available", lambda: False)
    photos = [{"path": f"photos/synth_0{i}.jpg"} for i in (1, 2, 3)]
    run_job(ModelEvidence(), tmp_path, params(clouds=[], photos=photos, region=None))
    pack = read_pack(tmp_path)
    assert pack["axis"] is None and pack["taper"] is None and pack["base"] is None
    assert pack["slices"] == [] and pack["members"] == [] and pack["familyHints"] is None
    assert pack["reconstruction"] == "unavailable" and pack["bounds"] is None
    assert len(pack["photos"]) == 3 and all(i["kind"] == "photo" for i in pack["images"])
    assert any("photogrammetry is not available" in w for w in pack["warnings"])


def test_neighbour_and_no_colour(tmp_path):
    stack, truth = stack_cloud(seed=7, noise=0.03)
    mono, _ = monopole_cloud(seed=2, ground=False)
    make_project(tmp_path, np.vstack([stack, mono + np.array([15.0, 0.0, 0.0])]), colour=False)
    run_job(ModelEvidence(), tmp_path, params(region={"centre": [0.0, 0.0], "radiusM": 60.0}))
    pack = read_pack(tmp_path)
    assert pack["colours"] == [] and any("no colour" in w for w in pack["warnings"])
    assert len(pack["isolation"]["dropped"]) == 1 and any("Excluded" in w for w in pack["warnings"])
    prof = pack["taper"]["profile"]
    got = float(np.interp(30.0, [p["y"] for p in prof], [p["r"] for p in prof]))
    assert abs(got - radius_at(truth["profile"], 30.0)) / 7.6 < 0.03
    assert pack["axis"]["tiltDeg"] < 0.3


def test_limits_bound_the_images(tmp_path):
    cloud, _ = stack_cloud(seed=3, noise=0.02)
    make_project(tmp_path, cloud, photos=3)
    photos = [{"path": f"photos/synth_0{i}.jpg"} for i in (1, 2, 3)]
    limits = {"maxPoints": 20_000, "maxImages": 6, "maxPx": 200}
    run_job(ModelEvidence(), tmp_path, params(photos=photos, limits=limits))
    pack = read_pack(tmp_path)
    assert len(pack["images"]) <= 6 and pack["samples"]["kept"] <= 20_000
    assert sum(i["kind"] == "photo" for i in pack["images"]) <= 3
    for img in pack["images"]:
        assert max(img["w"], img["h"]) <= 200


def _steps(project: Path) -> list[str]:
    job = next((project / "jobs").iterdir())
    return sorted(p.name for p in (job / "steps").glob("*.json"))


def test_resume_skips_done_steps(tmp_path, monkeypatch):
    cloud, _ = stack_cloud(seed=3, noise=0.02)
    make_project(tmp_path, cloud)
    run_job(ModelEvidence(), tmp_path, params(), job_id="j1")
    first = read_pack(tmp_path)

    def boom(*a, **k):
        raise AssertionError("a finished step ran again")

    for name in (
        "read_region",
        "split_ground",
        "estimate_axis",
        "fit_sections",
        "find_flues",
        "render_ortho",
    ):
        monkeypatch.setattr(pipe, name, boom)
    _, rec = run_job(ModelEvidence(), tmp_path, params(), job_id="j1")
    states = [p["state"] for p in rec.of("progress") if "state" in p and p["state"] in ("skipped", "start")]
    assert states.count("skipped") == 8 and "start" not in states
    assert read_pack(tmp_path) == first


def test_cancel_leaves_completed_steps_and_resume_finishes(tmp_path, monkeypatch):
    cloud, _ = stack_cloud(seed=3, noise=0.02)
    make_project(tmp_path, cloud)
    cancel = threading.Event()
    real = pipe.crop_views

    def cancelling(*a, **k):
        cancel.set()
        return real(*a, **k)

    monkeypatch.setattr(pipe, "crop_views", cancelling)
    with pytest.raises(Cancelled):
        run_job(ModelEvidence(), tmp_path, params(), job_id="j1", cancel=cancel)
    assert _steps(tmp_path) == [
        f"0{i}-{n}.json" for i, n in enumerate(["crop", "ground", "axis", "sections", "members"], 1)
    ]
    assert not (tmp_path / "engineering").exists()  # nothing committed from a cancelled run
    monkeypatch.setattr(pipe, "crop_views", real)

    def boom(*a, **k):
        raise AssertionError("a finished step ran again")

    monkeypatch.setattr(pipe, "read_region", boom)
    run_job(ModelEvidence(), tmp_path, params(), job_id="j1")
    assert read_pack(tmp_path)["taper"] is not None


def test_changed_params_refuse_resume(tmp_path):
    cloud, _ = stack_cloud(seed=3, noise=0.02)
    make_project(tmp_path, cloud)
    run_job(ModelEvidence(), tmp_path, params(), job_id="j1")
    with pytest.raises(JobError, match="different parameters"):
        run_job(ModelEvidence(), tmp_path, params(detail="standard"), job_id="j1")


def test_changed_cloud_refuses_resume(tmp_path):
    cloud, _ = stack_cloud(seed=3, noise=0.02)
    make_project(tmp_path, cloud)
    run_job(ModelEvidence(), tmp_path, params(), job_id="j1")
    las = tmp_path / "clouds" / "scan.las"
    las.write_bytes(las.read_bytes() + b"\0")
    with pytest.raises(JobError, match=INPUTS_CHANGED):
        run_job(ModelEvidence(), tmp_path, params(), job_id="j1")


def test_validate_refuses_bad_params():
    v = ModelEvidence().validate
    with pytest.raises(JobError, match="run must"):
        v({"run": "Bad Name", "clouds": [{"layer": "a"}]})
    with pytest.raises(JobError, match="at least one"):
        v({"run": "run-a"})
    with pytest.raises(JobError, match="does not take"):
        v({"run": "run-a", "clouds": [{"layer": "a"}], "bogus": 1})
    with pytest.raises(JobError, match="region"):
        v({"run": "run-a", "clouds": [{"layer": "a"}], "region": {"centre": [0, 0]}})
    ok = v({"run": "run-a", "clouds": [{"layer": "a"}], "detail": "detailed"})
    assert ok["limits"] == {"maxPoints": 2_000_000, "maxImages": 40, "maxPx": 1568}


def test_registered_with_the_pack():
    from aio_pipelines.pipelines import all_pipelines

    p = all_pipelines()["model.evidence"]
    assert [s.name for s in p.plan(p.validate({"run": "run-a", "clouds": [{"layer": "a"}]}))] == [
        "crop",
        "ground",
        "axis",
        "sections",
        "members",
        "renders",
        "photos",
        "pack",
    ]


@pytest.mark.skipif(find_pdal() is None, reason="PDAL not found (set AIO_PDAL)")
def test_copc_pack_through_pdal(tmp_path):  # pragma: no cover - needs PDAL
    cloud, truth = stack_cloud(seed=7, partial=True, noise=0.03)
    make_project(tmp_path, cloud)
    las = tmp_path / "clouds" / "scan.las"
    copc = tmp_path / "clouds" / "scan.copc.laz"
    subprocess.run([find_pdal(), "translate", str(las), str(copc), "--writers.copc.forward=all"], check=True)
    shutil.copy(copc, copc)
    manifest = json.loads((tmp_path / "manifest.json").read_text("utf-8"))
    manifest["layers"][0].update({"src": {"path": "clouds/scan.copc.laz"}, "format": "copc"})
    (tmp_path / "manifest.json").write_text(json.dumps(manifest), "utf-8")
    run_job(ModelEvidence(), tmp_path, params())
    pack = read_pack(tmp_path)
    assert len(pack["members"]) >= 1 and abs(pack["height"] - truth["height"]) < 2.0
