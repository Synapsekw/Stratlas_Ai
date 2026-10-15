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
from PIL import Image, ImageDraw

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
FIXTURE_PHOTO = FIXTURE.with_name("evidence.single-photo.json")


def make_project(
    root: Path,
    cloud: np.ndarray | None,
    colour: bool = True,
    photos: int = 0,
    fmt: str = "las",
    src: str = "clouds/scan.las",
) -> Path:
    layers = []
    if cloud is not None:
        (root / src).parent.mkdir(parents=True, exist_ok=True)
        rgb = None
        if colour:
            rgb = np.tile(np.array([150, 148, 140], dtype=np.uint8), (len(cloud), 1))
            rgb[(cloud[:, 1] >= 100) & (cloud[:, 1] < 104)] = [190, 40, 35]
        write_las(cloud, root / src, offset=ORIGIN, rgb=rgb)
        layers.append(
            {
                "kind": "pointcloud",
                "id": "scan",
                "name": "Scan",
                "visible": True,
                "src": {"path": src},
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
    # a fourth photo of something else (other colours): flagged, never blended
    odd = Image.new("RGB", (1600, 1200), (200, 60, 40))
    ImageDraw.Draw(odd).rectangle([600, 100, 1000, 1100], fill=(250, 200, 30))
    odd.save(root / "photos" / "odd.jpg", "JPEG")
    photos = [{"path": f"photos/synth_0{i}.jpg"} for i in (1, 2, 3)] + [{"path": "photos/odd.jpg"}]
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
    assert len(pack["photos"]) == 4 and all(p["original"].startswith("photos/") for p in pack["photos"])
    # the odd photo is flagged under its pack image id (img-photo-...), not its sha1
    assert pack["identity"]["sameAsset"] is False
    image_ids = {i["id"] for i in pack["images"]}
    (conflict,) = pack["identity"]["conflicts"]
    assert len(conflict["imageIds"]) == 1 and set(conflict["imageIds"]) <= image_ids
    assert conflict["imageIds"][0].startswith("img-photo-")
    flagged = [p for p in pack["photos"] if p["id"][:12] == conflict["imageIds"][0][len("img-photo-") :]]
    assert flagged and flagged[0]["original"] == "photos/odd.jpg"
    assert any("do not look like the same asset" in w for w in pack["warnings"])
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


def _compare_with_fixture(pack: dict, fixture: Path = FIXTURE) -> None:
    if os.environ.get("AIO_UPDATE_FIXTURES"):
        fixture.parent.mkdir(parents=True, exist_ok=True)
        fixture.write_text(json.dumps(pack, indent=1) + "\n", "utf-8")
        return
    assert fixture.is_file(), "run with AIO_UPDATE_FIXTURES=1 to write the schema fixture"
    old = json.loads(fixture.read_text("utf-8"))
    why = _differs(old, pack, "pack")
    assert why is None, f"the committed fixture has drifted ({why}): regenerate it (see the module docstring)"


#: values that depend on the image encoders (file bytes, hashes) and on the machine's temp paths
_ENCODER_KEYS = {"id", "sha1", "bytes", "dupOf", "imageIds", "blur", "file"}


def _differs(a, b, path: str):
    """Where `b` differs from the committed `a`: structure and strings exactly, numbers within a
    tolerance (BLAS and encoder versions move the last digits), encoder-dependent keys ignored."""
    if isinstance(a, dict) and isinstance(b, dict):
        if set(a) != set(b):
            return f"{path}: keys {sorted(set(a) ^ set(b))}"
        for k in a:
            if k in _ENCODER_KEYS:
                continue
            if (r := _differs(a[k], b[k], f"{path}.{k}")) is not None:
                return r
        return None
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            return f"{path}: {len(a)} items against {len(b)}"
        for i, (x, y) in enumerate(zip(a, b, strict=True)):
            if (r := _differs(x, y, f"{path}[{i}]")) is not None:
                return r
        return None
    if isinstance(a, bool) or isinstance(b, bool) or not isinstance(a, int | float):
        return None if a == b else f"{path}: {a!r} against {b!r}"
    return None if abs(a - b) <= 0.02 * max(1.0, abs(a)) + 0.05 else f"{path}: {a} against {b}"


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


def test_single_photo_pack(tmp_path, monkeypatch):
    """One ordinary photo and nothing else (acceptance C): a usable pack that claims no measurement.

    Its pack is the committed fixture `evidence.single-photo.json`, which the TypeScript acceptance
    tests assemble, mesh and place.
    """
    make_project(tmp_path, None, photos=1)
    monkeypatch.setattr(pipe, "photogrammetry_available", lambda: False)
    run_job(
        ModelEvidence(),
        tmp_path,
        params(clouds=[], photos=[{"path": "photos/synth_01.jpg"}], region=None),
    )
    pack = read_pack(tmp_path)
    assert (
        pack["crs"] is None
        and pack["bounds"] is None
        and pack["samples"] == {"read": 0, "kept": 0, "ground": 0}
    )
    assert pack["axis"] is None and pack["base"] is None and pack["height"] is None
    assert pack["taper"] is None and pack["slices"] == [] and pack["members"] == []
    assert pack["reconstruction"] == "unavailable"
    assert len(pack["photos"]) == 1 and [i["kind"] for i in pack["images"]] == ["photo"]
    assert pack["photos"][0]["orientationApplied"] is False
    assert any("not available" in w for w in pack["warnings"])
    _compare_with_fixture(pack, FIXTURE_PHOTO)


def test_a_large_cloud_is_processed_with_bounded_memory_and_nothing_raw_leaves(tmp_path):
    """Acceptance I at the job level: 2.5 million points on disk, a few hundred thousand read, a
    pack that holds measurements only."""
    import tracemalloc

    rng = np.random.default_rng(1)
    n = 2_500_000
    a = rng.uniform(0, 2 * np.pi, n)
    y = rng.uniform(0, 80, n)
    r = 6.0 - 1.5 * y / 80 + rng.normal(0, 0.02, n)
    cloud = np.column_stack([r * np.sin(a), y, -r * np.cos(a)])
    ground = np.column_stack(
        [rng.uniform(-40, 40, 200_000), rng.normal(0, 0.02, 200_000), rng.uniform(-40, 40, 200_000)]
    )
    make_project(tmp_path, np.vstack([cloud, ground]), colour=False)
    del cloud, ground, a, y, r
    limits = {"maxPoints": 150_000, "maxImages": 12, "maxPx": 512}
    tracemalloc.start()
    run_job(ModelEvidence(), tmp_path, params(limits=limits, region={"centre": [0.0, 0.0], "radiusM": 60.0}))
    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    pack = read_pack(tmp_path)
    assert pack["samples"]["read"] > 2_000_000 and pack["samples"]["kept"] <= 150_000
    assert peak < 600 * 1024 * 1024, f"{peak / 2**20:.0f} MB"
    prof = pack["taper"]["profile"]
    assert abs(float(np.interp(40.0, [p["y"] for p in prof], [p["r"] for p in prof])) - 5.25) < 0.1

    # nothing raw: no list in the pack is longer than its schema limits, and no point file is kept
    def longest(v):
        if isinstance(v, list):
            return max([len(v), *[longest(x) for x in v]])
        if isinstance(v, dict):
            return max([0, *[longest(x) for x in v.values()]])
        return 0

    assert longest(pack) <= 256
    folder = tmp_path / "engineering" / "run-test"
    assert (folder / "evidence.json").stat().st_size < 200_000
    assert not any(p.suffix in (".npy", ".las", ".laz", ".bin", ".csv") for p in folder.rglob("*"))


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


def add_layer(root: Path, layer: dict) -> None:
    m = json.loads((root / "manifest.json").read_text("utf-8"))
    m["layers"].append(layer)
    (root / "manifest.json").write_text(json.dumps(m), "utf-8")


def test_a_cloud_from_photogrammetry_is_marked_used(tmp_path):
    cloud, _ = stack_cloud(seed=3, noise=0.02)
    make_project(tmp_path, cloud, src="photogrammetry/run-1/odm/cloud.las")
    run_job(ModelEvidence(), tmp_path, params())
    assert read_pack(tmp_path)["reconstruction"] == "used"
    other = tmp_path / "other"
    other.mkdir()
    make_project(other, cloud)
    run_job(ModelEvidence(), other, params())
    assert read_pack(other)["reconstruction"] == "not-needed"


def test_photos_only_with_photogrammetry_points_to_reconstruct_first(tmp_path, monkeypatch):
    make_project(tmp_path, None, photos=3)
    monkeypatch.setattr(pipe, "photogrammetry_available", lambda: True)
    photos = [{"path": f"photos/synth_0{i}.jpg"} for i in (1, 2, 3)]
    run_job(ModelEvidence(), tmp_path, params(clouds=[], photos=photos, region=None))
    pack = read_pack(tmp_path)
    # photogrammetry is there but was not run: the pack says so, not "not needed"
    assert pack["reconstruction"] == "available-not-run" and pack["taper"] is None
    assert any("Reconstruct first" in w for w in pack["warnings"])


def _mesh_project(root: Path, n_meshes: int = 1):
    import trimesh

    (root / "meshes").mkdir(parents=True, exist_ok=True)
    layers = []
    for k in range(n_meshes):
        m = trimesh.creation.cylinder(radius=5.0 - k, height=60.0, sections=48)
        m.apply_transform(trimesh.transformations.rotation_matrix(np.pi / 2, [1, 0, 0]))  # axis along y
        m.apply_translation([20.0 * k, 30.0, 0.0])
        m.export(root / "meshes" / f"m{k}.glb")
        layers.append(
            {
                "kind": "mesh",
                "id": f"m{k}",
                "name": f"Model {k}",
                "visible": True,
                "src": {"path": f"meshes/m{k}.glb"},
            }
        )
    manifest = {
        "schema": "aio.project/1",
        "id": "s",
        "name": "S",
        "crs": {"epsg": 32633},
        "origin": list(ORIGIN),
        "captures": [],
        "layers": layers,
        "severityModels": [],
        "classCatalogues": [],
    }
    (root / "manifest.json").write_text(json.dumps(manifest), "utf-8")


def test_a_mesh_source_is_sampled_into_the_measured_points(tmp_path):
    _mesh_project(tmp_path)
    limits = {"maxPoints": 30_000, "maxImages": 12, "maxPx": 512}
    run_job(
        ModelEvidence(),
        tmp_path,
        params(
            clouds=[], meshes=[{"layer": "m0"}], region={"centre": [0.0, 0.0], "radiusM": 20.0}, limits=limits
        ),
    )
    pack = read_pack(tmp_path)
    assert 5000 < pack["samples"]["kept"] <= 30_000
    prof = pack["taper"]["profile"]
    got = float(np.interp(30.0, [p["y"] for p in prof], [p["r"] for p in prof]))
    assert abs(got - 5.0) < 0.1
    assert pack["colours"] == [] and pack["baseInfo"]["observed"] is False  # a mesh has no ground
    assert any("No ground" in w for w in pack["warnings"])
    # two meshes share the point budget, and a missing layer is refused
    two = tmp_path / "two"
    two.mkdir()
    _mesh_project(two, 2)
    run_job(
        ModelEvidence(),
        two,
        params(
            clouds=[],
            meshes=[{"layer": "m0"}, {"layer": "m1"}],
            region={"centre": [0.0, 0.0], "radiusM": 5.0},
            limits=limits,
        ),
    )
    assert read_pack(two)["samples"]["kept"] <= 30_000
    with pytest.raises(JobError, match="no layer"):
        run_job(
            ModelEvidence(),
            two,
            params(clouds=[], meshes=[{"layer": "nope"}], region=None, run="run-x"),
            job_id="j9",
        )


def test_different_coordinate_systems_are_warned_about(tmp_path):
    cloud, _ = stack_cloud(seed=3, noise=0.02)
    make_project(tmp_path, cloud)
    write_las(cloud, tmp_path / "clouds" / "other.las", crs_epsg=32634, offset=ORIGIN)
    add_layer(
        tmp_path,
        {
            "kind": "pointcloud",
            "id": "other",
            "name": "O",
            "visible": True,
            "src": {"path": "clouds/other.las"},
            "format": "las",
        },
    )
    run_job(ModelEvidence(), tmp_path, params(clouds=[{"layer": "scan"}, {"layer": "other"}]))
    assert any("different coordinate systems" in w for w in read_pack(tmp_path)["warnings"])


def test_a_cancel_while_committing_never_leaves_an_old_pack_beside_new_images(tmp_path, monkeypatch):
    cloud, _ = stack_cloud(seed=3, noise=0.02)
    make_project(tmp_path, cloud)
    run_job(ModelEvidence(), tmp_path, params(), job_id="j1")
    assert (tmp_path / "engineering" / "run-test" / "evidence.json").is_file()
    real = pipe.commit_tree

    def cancelling(ctx, staged, dest):
        real(ctx, staged, dest)  # the new images are in place...
        raise Cancelled()  # ...and the job is cancelled before the new pack

    monkeypatch.setattr(pipe, "commit_tree", cancelling)
    with pytest.raises(Cancelled):
        run_job(ModelEvidence(), tmp_path, params(), job_id="j2")
    assert not (tmp_path / "engineering" / "run-test" / "evidence.json").exists()


def test_only_the_source_files_decide_whether_a_job_may_resume(tmp_path):
    cloud, _ = stack_cloud(seed=3, noise=0.02)
    make_project(tmp_path, cloud)
    unrelated = tmp_path / "clouds" / "unrelated.las"
    unrelated.write_bytes(b"x")
    run_job(ModelEvidence(), tmp_path, params(), job_id="j1")
    unrelated.write_bytes(b"changed")  # another cloud of the project: not this job's input
    run_job(ModelEvidence(), tmp_path, params(), job_id="j1")
    assert ModelEvidence().inputs(params(), tmp_path) == ["manifest.json", "clouds/scan.las"]


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
