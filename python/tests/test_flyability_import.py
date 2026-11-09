"""flyability.import on the synthetic export (a box room; no client data).

PDAL builds the COPCs when it is found; without it the conversion is stood in for by numpy
(the flight's matrix applied, the LAS copied as the "COPC"), so everything but PDAL itself is
still checked. `test_pointcloud_matrix.py` checks the PDAL stage on its own.
"""

from __future__ import annotations

import copy
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import pytest

import flyability_synth as fs
from aio_pipelines import pointcloud as pc
from aio_pipelines.flyability.frames import to_scene
from aio_pipelines.flyability.pipeline import FlyabilityImport
from aio_pipelines.pipelines import all_pipelines
from aio_pipelines.runtime import JobError, Step
from aio_pipelines.volumetric.cloud import read_las_chunks
from conftest import run_job

PDAL = pc.find_pdal()
POINTS = 100_000  # dense enough that every cast ray meets a point of the sampled walls

SEVERITY_MODEL = {
    "id": "confined-space-4",
    "name": "Confined-space inspection (Low to Critical)",
    "levels": [
        {"value": 1, "label": "Low", "color": "#78b3d6", "criteria": "Cosmetic or early stage. Monitor."},
        {"value": 2, "label": "Medium", "color": "#ebc751", "criteria": "Visible deterioration."},
        {"value": 3, "label": "High", "color": "#f0904f", "criteria": "Significant damage."},
        {"value": 4, "label": "Critical", "color": "#f05653", "criteria": "Loss of function."},
    ],
    "uncertain": {"label": "Not rated", "color": "#9aa3ad"},
}


@pytest.fixture(scope="module")
def exports(tmp_path_factory):
    """One synthetic export per (generation, merged), made once: the job only reads them."""
    made: dict[tuple[str, bool], fs.SynthExport] = {}

    def get(generation: str = "2025", merged: bool = True) -> fs.SynthExport:
        key = (generation, merged)
        if key not in made:
            root = tmp_path_factory.mktemp(f"export-{generation}-{int(merged)}")
            made[key] = fs.make_export(root, generation=generation, merged=merged, points=POINTS)  # type: ignore[arg-type]
        return made[key]

    return get


@pytest.fixture(autouse=True)
def pdal_or_numpy(monkeypatch):
    """Real PDAL when found; else numpy stands in for the LAS preparation and the COPC build."""
    if PDAL is not None:
        return

    def prepare(ctx, pdal, src, dst, epsg, points, band, matrix=None):
        x, y, z, _ = next(read_las_chunks(src))
        xyz = np.column_stack([x, y, z])
        if matrix is not None:
            m = np.array(matrix, dtype=float).reshape(4, 4)
            xyz = xyz @ m[:3, :3].T + m[:3, 3]
        fs._write_las(dst, xyz)

    def build(ctx, las, staged, count, epsg, start):
        shutil.copyfile(las, staged)
        return "numpy"

    monkeypatch.setattr(pc, "find_pdal", lambda: "pdal")
    monkeypatch.setattr(pc, "prepare_las", prepare)
    monkeypatch.setattr(pc, "build_copc", build)


def _project(tmp_path: Path) -> Path:
    root = tmp_path / "proj"
    root.mkdir()
    manifest = {
        "schema": "aio.project/1",
        "id": "proj",
        "name": "Confined-space test project",
        "crs": {"epsg": 32640},
        "origin": [500000.0, 2700000.0, 0.0],
        "captures": [],
        "layers": [],
        "severityModels": [],
        "classCatalogues": [],
    }
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2), "utf-8")
    return root


def _params(syn: fs.SynthExport, **extra) -> dict:
    return {
        "src": str(syn.root),
        "inspections": [{"id": syn.inspection_id}],
        "severityModel": copy.deepcopy(SEVERITY_MODEL),
        "catalogueId": "confined-space",
        **extra,
    }


def _manifest(root: Path) -> dict:
    return json.loads((root / "manifest.json").read_text("utf-8"))


def _issues(root: Path) -> list[dict]:
    return json.loads((root / "issues.json").read_text("utf-8"))["issues"]


def _run(root: Path, params: dict, job_id: str = "j1") -> dict:
    result, _ = run_job(FlyabilityImport(), root, params, job_id=job_id)
    assert result["status"] == "done", result
    return result["outputs"]["register"]


def _cloud_points(path: Path) -> np.ndarray | None:
    """The points of a built cloud (the numpy stand-in), or None with PDAL (a real COPC)."""
    if PDAL is not None:
        return None
    x, y, z, _ = next(read_las_chunks(path))
    return np.column_stack([x, y, z])


def _cloud_bounds(path: Path) -> tuple[np.ndarray, np.ndarray]:
    pts = _cloud_points(path)
    if pts is not None:
        return pts.min(axis=0), pts.max(axis=0)
    info = json.loads(
        subprocess.run(
            [PDAL, "info", "--summary", str(path)], capture_output=True, check=True, env=pc.pdal_env(PDAL)
        ).stdout
    )["summary"]["bounds"]
    return (
        np.array([info["minx"], info["miny"], info["minz"]]),
        np.array([info["maxx"], info["maxy"], info["maxz"]]),
    )


def test_it_is_registered_and_checks_its_parameters(tmp_path):
    assert isinstance(all_pipelines()["flyability.import"], FlyabilityImport)
    p = FlyabilityImport()
    good = {
        "src": str(tmp_path),
        "inspections": [{"id": "i1", "flights": ["f1"]}],
        "severityModel": SEVERITY_MODEL,
        "catalogueId": "confined-space",
    }
    assert p.validate(dict(good))["inspections"] == [{"id": "i1", "flights": ["f1"]}]
    assert p.validate({**good, "spaces": {"i1": "tank-a"}})["spaces"] == {"i1": "tank-a"}
    with pytest.raises(JobError, match="does not take: bogus"):
        p.validate({**good, "bogus": 1})
    for bad in (
        {**good, "inspections": []},
        {**good, "inspections": [{"flights": []}]},
        {**good, "severityModel": {"id": "x"}},
        {**good, "catalogueId": ""},
        {**good, "spaces": {"i1": "main"}},
        {k: v for k, v in good.items() if k != "src"},
    ):
        with pytest.raises(JobError):
            p.validate(bad)


def test_import_one_space_per_inspection(tmp_path, exports):
    syn = exports()
    root = _project(tmp_path)
    out = _run(root, _params(syn))
    m = _manifest(root)
    sid = f"fly-{syn.inspection_id[:8]}"
    (space,) = m["spaces"]
    assert space["id"] == sid
    assert space["crs"] == {"local": "flyability"}
    assert space["origin"] == [0, 0, 0]
    assert space["source"] == {
        "kind": "flyability",
        "inspectionId": syn.inspection_id,
        "assetName": "Synthetic chamber",
    }
    kinds = sorted(layer["kind"] for layer in m["layers"])
    assert kinds == ["flightline", "flightline", "photos", "pointcloud", "pointcloud", "pointcloud"]
    assert all(layer["space"] == sid for layer in m["layers"])
    by_id = {layer["id"]: layer for layer in m["layers"]}
    fa, fb = (f[:8] for f in syn.flight_ids)
    assert by_id[f"{sid}-{fa}-cloud"]["name"] == "Flight #1 cloud"
    assert by_id[f"{sid}-{fb}-cloud"]["src"] == {"path": f"clouds/flyability/{sid}/flight-2.copc.laz"}
    merged = by_id[f"{sid}-merged"]
    assert merged["name"] == "Merged cloud" and merged["format"] == "copc"
    assert merged["src"] == {"path": f"clouds/flyability/{sid}/merged.copc.laz"}
    path_b = by_id[f"{sid}-{fb}-path"]
    assert path_b["name"] == "Flight #2 path"
    assert path_b["flight"] == syn.flight_ids[1] and path_b["bootStartS"] == 20.0
    photos = by_id[f"{sid}-photos"]
    assert photos["name"] == "Finding photos"
    ids = {item["id"] for item in photos["items"]}
    assert ids == set(syn.snapshot_ids) | {f"{s}-annotated" for s in syn.snapshot_ids}
    for item in photos["items"]:
        assert (root / item["src"]["path"]).is_file()
        assert item["lens"] == {"model": "ftheta", "hfovDeg": 114, "aspect": 1.7778}
        assert len(item["pos"]) == 3 and len(item["q"]) == 4
    for layer in m["layers"]:
        if "src" in layer:
            assert (root / layer["src"]["path"]).is_file(), layer
    # the confined-space model and catalogue, with the untagged class and the tag classes
    assert [x["id"] for x in m["severityModels"]] == ["confined-space-4"]
    (cat,) = m["classCatalogues"]
    assert cat["id"] == "confined-space" and cat["assetType"] == "confined-space"
    classes = {c["id"]: c for c in cat["classes"]}
    assert classes["finding"]["color"] == "#95a0ab" and "corrosion" in classes
    # the pose file (aio.flight/1)
    pose = json.loads((root / path_b["src"]["path"]).read_text("utf-8"))
    assert pose["schema"] == "aio.flight/1"
    assert pose["lens"] == {"model": "ftheta", "hfovDeg": 114, "aspect": 1.7778}
    assert pose["samples"][0]["t"] == 0 and pose["startUtcMs"] == (1732600000 + 100) * 1000
    # findings: one per POI, every sighting layer exists
    issues = _issues(root)
    assert {i["id"] for i in issues} == {f"fly-{p}" for p in syn.poi_ids}
    for issue in issues:
        for s in issue["sightings"]:
            assert s["layer"] in by_id
    assert out["spaces"] == [{"id": sid, "name": "Synthetic room", "layers": sorted(by_id)}]
    f = out["findings"]
    assert f["added"] == 3 and f["refreshed"] == 0 and f["kept_edited"] == 0
    assert f["no_hit"] == 1 and f["skipped"] == 0 and f["invalid_pose"] == 0


def test_transformed_flight_lands_aligned(tmp_path, exports):
    syn = exports()
    root = _project(tmp_path)
    _run(root, _params(syn))
    sid = f"fly-{syn.inspection_id[:8]}"
    fb = syn.flight_ids[1][:8]
    # flight B's cloud, written in its own frame, lies on the room's walls once moved
    lo, hi = _cloud_bounds(root / "clouds" / "flyability" / sid / "flight-2.copc.laz")
    assert np.all(np.abs(lo - 0.0) < 0.05), lo
    assert np.all(np.abs(hi - fs.ROOM) < 0.05), hi
    pts = _cloud_points(root / "clouds" / "flyability" / sid / "flight-2.copc.laz")
    if pts is not None:
        on_wall = np.min(np.abs(np.concatenate([pts, fs.ROOM - pts], axis=1)), axis=1)
        assert on_wall.max() < 0.005
    # its path: the first sample and the P1 waypoint (t = 30 s) where the room puts them
    pose = json.loads((root / "imports" / "flyability" / sid / "poses" / f"{fb}.flight.json").read_text())
    samples = {s["t"]: s for s in pose["samples"]}
    assert np.allclose(samples[0]["pos"], to_scene(np.array([1.0, 4.0, 1.5])), atol=0.05)
    assert np.allclose(samples[10000]["pos"], to_scene(np.array([3.0, 2.0, 1.5])), atol=0.05)
    # P1 (on flight B) pinned where its camera ray meets the room
    p1 = next(i for i in _issues(root) if i["id"] == f"fly-{syn.poi_ids[0]}")
    (cloud,) = [s for s in p1["sightings"] if s["on"] == "pointcloud"]
    assert cloud["layer"] == f"{sid}-merged"
    truth = to_scene(np.array(syn.hit[syn.snapshot_ids[0]]))
    assert np.linalg.norm(np.array(cloud["geom"]["p"]) - truth) < 0.05
    assert p1["external"]["locationCheck"] == "agrees"
    # the photo of P1 sits at its camera in the scene frame
    photos = next(x for x in _manifest(root)["layers"] if x["kind"] == "photos")
    item = next(x for x in photos["items"] if x["id"] == syn.snapshot_ids[0])
    cam = to_scene(np.array(syn.camera_position[syn.snapshot_ids[0]]))
    assert np.linalg.norm(np.array(item["pos"]) - cam) < 0.01


@pytest.mark.parametrize("generation", ["2025", "2024"])
def test_privacy(tmp_path, exports, generation):
    syn = exports(generation=generation)
    root = _project(tmp_path)
    _run(root, _params(syn))
    for f in root.rglob("*"):
        if not f.is_file():
            continue
        data = f.read_bytes()
        assert syn.email.encode() not in data, f
        assert b"12.3456789" not in data, f
        assert f.suffix.lower() not in {".mov", ".bag", ".mcap", ".stn"}, f


def test_reimport_keeps_edits(tmp_path, exports):
    syn = exports()
    root = _project(tmp_path)
    _run(root, _params(syn))
    layers_before = [layer["id"] for layer in _manifest(root)["layers"]]
    p1_id = f"fly-{syn.poi_ids[0]}"
    issues = _issues(root)
    p1 = next(i for i in issues if i["id"] == p1_id)
    for s in p1["sightings"]:
        if s["on"] == "pointcloud":
            s["geom"]["p"] = [1.0, 2.0, -3.0]
    p1["updatedAt"] = "2026-11-01T09:00:00Z"
    edited = copy.deepcopy(p1)
    (root / "issues.json").write_text(json.dumps({"schema": "aio.issues/1", "issues": issues}), "utf-8")
    out = _run(root, _params(syn), job_id="j2")
    again = _issues(root)
    assert next(i for i in again if i["id"] == p1_id) == edited
    assert [layer["id"] for layer in _manifest(root)["layers"]] == layers_before
    assert len(_manifest(root)["spaces"]) == 1
    assert out["findings"]["kept_edited"] == 1 and out["findings"]["refreshed"] == 2
    assert (root / "issues.json.bak").is_file() and (root / "manifest.json.bak").is_file()
    codes = sorted(i["code"] for i in again)
    assert codes == sorted(set(codes))  # no code handed out twice


def test_reimport_keeps_unchanged_clouds(tmp_path, exports, monkeypatch):
    syn = exports()
    root = _project(tmp_path)
    _run(root, _params(syn))
    built: list[Path] = []
    real = pc.build_copc

    def counting(ctx, las, staged, count, epsg, start):
        built.append(Path(las))
        return real(ctx, las, staged, count, epsg, start)

    monkeypatch.setattr(pc, "build_copc", counting)
    _run(root, _params(syn), job_id="j2")
    assert built == []
    # a re-export with the same points but a new change time is built again
    las = next(Path(c) for c in syn.root.glob("maps/*/SYNTH_002_flight_livemap.las"))
    st = las.stat()
    os.utime(las, ns=(st.st_atime_ns, st.st_mtime_ns + 10**9))
    try:
        _run(root, _params(syn), job_id="j3")
    finally:
        os.utime(las, ns=(st.st_atime_ns, st.st_mtime_ns))
    assert len(built) == 1
    record = json.loads(
        (root / "imports" / "flyability" / f"fly-{syn.inspection_id[:8]}" / "clouds.json").read_text()
    )
    assert all(set(r) == {"bytes", "mtimeNs", "matrix"} for r in record["clouds"].values())


def test_a_space_of_another_inspection_is_refused(tmp_path, exports):
    syn = exports()
    root = _project(tmp_path)
    m = _manifest(root)
    m["spaces"] = [
        {
            "id": "tank-a",
            "name": "Tank A",
            "crs": {"local": "flyability"},
            "origin": [0, 0, 0],
            "source": {"kind": "flyability", "inspectionId": "another-inspection"},
        }
    ]
    (root / "manifest.json").write_text(json.dumps(m), "utf-8")
    with pytest.raises(JobError, match="holds another Flyability inspection"):
        run_job(FlyabilityImport(), root, _params(syn, spaces={syn.inspection_id: "tank-a"}))
    assert [s["id"] for s in _manifest(root)["spaces"]] == ["tank-a"]
    assert _manifest(root)["layers"] == []


def _manual_issue(iid: str, code: str, layer: str = "some-layer") -> dict:
    return {
        "id": iid,
        "code": code,
        "classId": "finding",
        "severityModelId": "confined-space-4",
        "severity": 2,
        "status": "draft",
        "title": "Added by hand",
        "note": "",
        "author": "someone",
        "createdAt": "2026-10-31T08:00:00Z",
        "updatedAt": "2026-10-31T08:00:00Z",
        "sightings": [{"on": "pointcloud", "layer": layer, "geom": {"type": "point3", "p": [0, 0, 0]}}],
        "source": "human",
    }


def test_kept_missing_counts_only_this_inspections_findings(tmp_path, exports):
    syn = exports()
    root = _project(tmp_path)
    _run(root, _params(syn))
    sid = f"fly-{syn.inspection_id[:8]}"
    issues = _issues(root)
    # a finding of this inspection the export no longer has, one of another inspection, a manual one
    gone = copy.deepcopy(next(i for i in issues if i["id"] == f"fly-{syn.poi_ids[2]}"))
    gone["id"], gone["code"] = "fly-gone-poi", "F90"
    other = copy.deepcopy(gone)
    other["id"], other["code"] = "fly-other-poi", "F91"
    for s in other["sightings"]:
        s["layer"] = "fly-elsewhere-merged"
    issues += [gone, other, _manual_issue("manual-1", "F92", f"{sid}-merged")]
    (root / "issues.json").write_text(json.dumps({"schema": "aio.issues/1", "issues": issues}), "utf-8")
    out = _run(root, _params(syn), job_id="j2")
    assert out["findings"]["kept_missing"] == 1
    assert {"fly-gone-poi", "fly-other-poi", "manual-1"} <= {i["id"] for i in _issues(root)}


def test_new_codes_do_not_clash_with_an_issue_added_meanwhile(tmp_path, exports, monkeypatch):
    syn = exports()
    root = _project(tmp_path)
    real_plan = FlyabilityImport.plan

    def plan(self, params):
        steps = real_plan(self, params)

        def meddle(ctx):  # the app saves an issue between the findings and register steps
            doc = {"schema": "aio.issues/1", "issues": [_manual_issue("manual-1", "F01")]}
            (root / "issues.json").write_text(json.dumps(doc), "utf-8")
            return {}

        at = [s.name for s in steps].index("register")
        return [*steps[:at], Step("meddle", "meddle", meddle), *steps[at:]]

    monkeypatch.setattr(FlyabilityImport, "plan", plan)
    _run(root, _params(syn))
    issues = _issues(root)
    codes = [i["code"] for i in issues]
    assert len(codes) == len(set(codes)) == 4
    assert next(i for i in issues if i["id"] == "manual-1")["code"] == "F01"


def test_an_inspection_listed_twice_is_refused(tmp_path, exports):
    syn = exports()
    params = _params(syn)
    params["inspections"] = [{"id": syn.inspection_id}, {"id": syn.inspection_id}]
    with pytest.raises(JobError, match="listed twice"):
        run_job(FlyabilityImport(), _project(tmp_path), params)


def test_two_inspections_into_one_space_are_refused(tmp_path, exports):
    syn = exports()
    src = tmp_path / "export"
    shutil.copytree(syn.root, src)
    (src / "inspections" / "insp-two").mkdir()
    (src / "inspections" / "insp-two" / "inspection.json").write_text(
        json.dumps({"id": "insp-two", "name": "Second room"}), "utf-8"
    )
    root = _project(tmp_path)
    params = {
        **_params(syn, spaces={syn.inspection_id: "tank-a", "insp-two": "tank-a"}),
        "src": str(src),
        "inspections": [{"id": syn.inspection_id}, {"id": "insp-two"}],
    }
    with pytest.raises(JobError, match="would go into space tank-a"):
        run_job(FlyabilityImport(), root, params)
    assert "spaces" not in _manifest(root)
    assert _manifest(root)["layers"] == []


def test_existing_space_is_reused(tmp_path, exports):
    syn = exports()
    root = _project(tmp_path)
    _run(root, _params(syn, spaces={syn.inspection_id: "tank-a"}))
    m = _manifest(root)
    assert [s["id"] for s in m["spaces"]] == ["tank-a"]
    assert all(layer["space"] == "tank-a" for layer in m["layers"])
    # a second run without the map finds the space by its inspection
    _run(root, _params(syn), job_id="j2")
    assert [s["id"] for s in _manifest(root)["spaces"]] == ["tank-a"]


def test_without_merged_cloud(tmp_path, exports):
    syn = exports(merged=False)
    root = _project(tmp_path)
    out = _run(root, _params(syn))
    m = _manifest(root)
    sid = f"fly-{syn.inspection_id[:8]}"
    ids = {layer["id"] for layer in m["layers"]}
    assert f"{sid}-merged" not in ids
    assert not (root / "clouds" / "flyability" / sid / "merged.copc.laz").exists()
    issues = {i["id"]: i for i in _issues(root)}
    p1 = issues[f"fly-{syn.poi_ids[0]}"]
    (cloud,) = [s for s in p1["sightings"] if s["on"] == "pointcloud"]
    assert cloud["layer"] == f"{sid}-{syn.flight_ids[1][:8]}-cloud"
    truth = to_scene(np.array(syn.hit[syn.snapshot_ids[0]]))
    assert np.linalg.norm(np.array(cloud["geom"]["p"]) - truth) < 0.05
    p2 = issues[f"fly-{syn.poi_ids[1]}"]
    (cloud2,) = [s for s in p2["sightings"] if s["on"] == "pointcloud"]
    assert cloud2["layer"] == f"{sid}-{syn.flight_ids[0][:8]}-cloud"
    assert out["findings"]["added"] == 3 and out["findings"]["no_hit"] == 1


def test_2024_generation(tmp_path, exports):
    syn = exports(generation="2024")
    root = _project(tmp_path)
    out = _run(root, _params(syn))
    assert out["findings"]["added"] == 3 and out["findings"]["no_hit"] == 1
    assert len(_manifest(root)["layers"]) == 6
    assert all(i["severity"] == "uncertain" for i in _issues(root))


def test_selected_flights_only(tmp_path, exports):
    syn = exports()
    root = _project(tmp_path)
    params = _params(syn)
    params["inspections"] = [{"id": syn.inspection_id, "flights": [syn.flight_ids[0]]}]
    _run(root, params)
    sid = f"fly-{syn.inspection_id[:8]}"
    ids = {layer["id"] for layer in _manifest(root)["layers"]}
    fa, fb = (f[:8] for f in syn.flight_ids)
    assert {f"{sid}-{fa}-cloud", f"{sid}-{fa}-path"} <= ids
    assert not ({f"{sid}-{fb}-cloud", f"{sid}-{fb}-path"} & ids)


def test_an_unknown_inspection_is_refused(tmp_path, exports):
    syn = exports()
    root = _project(tmp_path)
    params = _params(syn)
    params["inspections"] = [{"id": "not-there"}]
    with pytest.raises(JobError, match="no inspection"):
        run_job(FlyabilityImport(), root, params)
    assert "spaces" not in _manifest(root)


# The Python-written project files, kept in the TS package so a vitest parses them with the schema
# (packages/project/src/builder/flyability/pythonOutput.test.ts). Synthetic data only. Regenerate
# after a change to what the job writes with:  AIO_REGEN_FIXTURES=1 pytest -k committed_fixture
FIXTURE = (
    Path(__file__).resolve().parents[2] / "packages/project/src/builder/flyability/__fixtures__/python-output"
)


def _stable(v, key: str = ""):
    """Time stamps of the run fixed and floats rounded, so the files do not change from run to run."""
    if isinstance(v, dict):
        return {k: _stable(x, k) for k, x in v.items()}
    if isinstance(v, list):
        return [_stable(x) for x in v]
    if key in {"createdAt", "updatedAt"} and isinstance(v, str):
        return "2026-01-01T00:00:00Z"
    if isinstance(v, float):
        return round(v, 3) + 0.0  # no -0.0, which JSON.stringify writes as 0
    return v


def test_output_matches_committed_fixture(tmp_path, exports):
    syn = exports()
    root = _project(tmp_path)
    _run(root, _params(syn))
    manifest = _manifest(root)
    flightline = next(layer for layer in manifest["layers"] if layer["kind"] == "flightline")
    files = {
        "manifest.json": manifest,
        "issues.json": json.loads((root / "issues.json").read_text("utf-8")),
        "flight.json": json.loads((root / flightline["src"]["path"]).read_text("utf-8")),
    }
    files["flight.json"]["samples"] = files["flight.json"]["samples"][:3]
    text = {name: json.dumps(_stable(doc), indent=2, sort_keys=True) + "\n" for name, doc in files.items()}
    if os.environ.get("AIO_REGEN_FIXTURES") == "1":
        FIXTURE.mkdir(parents=True, exist_ok=True)
        for name, body in text.items():
            (FIXTURE / name).write_text(body, "utf-8", newline="\n")
    for name, body in text.items():
        on_disk = (FIXTURE / name).read_text("utf-8") if (FIXTURE / name).is_file() else ""
        assert on_disk == body, f"{name} is out of date: rerun with AIO_REGEN_FIXTURES=1"


def test_cap_id():
    from aio_pipelines.flyability.ids import cap_id

    assert cap_id("a" * 128) == "a" * 128
    long_a, long_b = "x" * 130 + "a", "x" * 130 + "b"
    assert len(cap_id(long_a)) == 128 and cap_id(long_a) == cap_id(long_a)
    assert cap_id(long_a) != cap_id(long_b)
    assert cap_id(long_a).startswith("x" * 119 + "-")


@pytest.mark.parametrize("what", ["space", "snapshot"])
def test_long_ids_are_capped_and_still_linked(tmp_path, exports, what):
    # A space id of 114 characters makes the flight cloud layer id 129 long; a snapshot id of 120
    # makes its annotated photo id 130 long. The project sits in a short folder so the long names
    # stay inside the Windows path limit.
    syn = exports()
    src = tmp_path / "export"
    shutil.copytree(syn.root, src)
    long_snap = "s" * 120
    spaces = {}
    if what == "snapshot":
        snap_json = src / "snapshots" / syn.snapshot_ids[0] / "snapshot.json"
        snap = json.loads(snap_json.read_text("utf-8"))
        snap["id"] = long_snap
        snap_json.write_text(json.dumps(snap), "utf-8")
    else:
        spaces = {syn.inspection_id: "t" * 114}
    short = Path(tempfile.mkdtemp(prefix="fl"))
    try:
        root = _project(short)
        params = {**_params(syn, spaces=spaces), "src": str(src)}
        _run(root, params)
        m = _manifest(root)
        layer_ids = {layer["id"] for layer in m["layers"]}
        assert all(len(i) <= 128 for i in layer_ids) and len(layer_ids) == 6
        photos = next(layer for layer in m["layers"] if layer["kind"] == "photos")
        photo_ids = {item["id"] for item in photos["items"]}
        assert all(len(i) <= 128 for i in photo_ids)
        if what == "snapshot":
            assert long_snap in photo_ids
            annotated = [i for i in photo_ids if i.startswith("s" * 119 + "-")]
            assert len(annotated) == 1 and len(annotated[0]) == 128
        else:
            assert any(i.startswith("t" * 114 + "-") and len(i) == 128 for i in layer_ids)
        for issue in _issues(root):
            assert len(issue["id"]) <= 128
            for s in issue["sightings"]:
                assert s["layer"] in layer_ids
                if "photo" in s:
                    assert s["photo"] in photo_ids
        # a second run finds the same ids again
        _run(root, params, job_id="j2")
        assert {layer["id"] for layer in _manifest(root)["layers"]} == layer_ids
    finally:
        shutil.rmtree(short, ignore_errors=True)


def _renamed_export(tmp_path: Path, names: list[str | None]) -> fs.SynthExport:
    syn = fs.make_export(tmp_path / "export", points=POINTS)
    for fid, name in zip(syn.flight_ids, names, strict=True):
        path = syn.root / "flights" / fid / "flight.json"
        doc = json.loads(path.read_text("utf-8"))
        doc["name"] = name
        path.write_text(json.dumps(doc), "utf-8")
    return syn


def _flight_cloud_files(root: Path, syn: fs.SynthExport) -> list[str]:
    layers = {layer["id"]: layer for layer in _manifest(root)["layers"]}
    sid = f"fly-{syn.inspection_id[:8]}"
    return [layers[f"{sid}-{fid[:8]}-cloud"]["src"]["path"] for fid in syn.flight_ids]


@pytest.mark.parametrize("names", [["Undefined", "Undefined"], [None, "undefined"], ["Pass", "Pass"]])
def test_unnamed_and_duplicate_flights_get_unique_safe_cloud_names(tmp_path, names):
    syn = _renamed_export(tmp_path, names)
    root = _project(tmp_path)
    _run(root, _params(syn))
    files = _flight_cloud_files(root, syn)
    assert len(set(files)) == 2
    assert not any("undefined" in f for f in files)
    for f in files:
        assert (root / f).is_file()
    # a re-import keeps the same names
    _run(root, _params(syn), job_id="j2")
    assert _flight_cloud_files(root, syn) == files


def test_a_named_flight_keeps_its_cloud_file_name(tmp_path):
    syn = _renamed_export(tmp_path, ["Chamber A pass", "Undefined"])
    root = _project(tmp_path)
    _run(root, _params(syn))
    a, b = _flight_cloud_files(root, syn)
    assert a.endswith("/chamber-a-pass.copc.laz")
    assert b.endswith(f"/flight-{syn.flight_ids[1][:8]}.copc.laz")


def test_only_the_merged_cloud_shows_at_first(tmp_path, exports):
    syn = exports()
    root = _project(tmp_path)
    _run(root, _params(syn))
    sid = f"fly-{syn.inspection_id[:8]}"
    clouds = {layer["id"]: layer for layer in _manifest(root)["layers"] if layer["kind"] == "pointcloud"}
    assert clouds[f"{sid}-merged"]["visible"] is True
    flights = [v for k, v in clouds.items() if k != f"{sid}-merged"]
    assert flights and all(v["visible"] is False for v in flights)


def test_flight_clouds_show_when_there_is_no_merged_cloud(tmp_path, exports):
    syn = exports(merged=False)
    root = _project(tmp_path)
    _run(root, _params(syn))
    clouds = [layer for layer in _manifest(root)["layers"] if layer["kind"] == "pointcloud"]
    assert clouds and all(layer["visible"] is True for layer in clouds)


def test_a_phase_1_undefined_cloud_is_kept_not_converted_again(tmp_path, monkeypatch):
    syn = _renamed_export(tmp_path, ["Undefined", "Chamber A pass"])
    root = _project(tmp_path)
    _run(root, _params(syn))
    sid = f"fly-{syn.inspection_id[:8]}"
    # make the project look like phase 1: the unnamed flight's cloud is undefined.copc.laz
    new = root / _flight_cloud_files(root, syn)[0]
    old_rel = f"clouds/flyability/{sid}/undefined.copc.laz"
    new.rename(root / old_rel)
    manifest = _manifest(root)
    for layer in manifest["layers"]:
        if layer["id"] == f"{sid}-{syn.flight_ids[0][:8]}-cloud":
            layer["src"]["path"] = old_rel
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2), "utf-8")
    rec = root / "imports" / "flyability" / sid / "clouds.json"
    doc = json.loads(rec.read_text("utf-8"))
    for key in list(doc["clouds"]):
        if key.endswith(f"flight-{syn.flight_ids[0][:8]}.copc.laz"):
            doc["clouds"][old_rel] = doc["clouds"].pop(key)
    rec.write_text(json.dumps(doc), "utf-8")
    built: list[Path] = []
    real = pc.build_copc

    def counting(ctx, las, staged, count, epsg, start):
        built.append(Path(las))
        return real(ctx, las, staged, count, epsg, start)

    monkeypatch.setattr(pc, "build_copc", counting)
    _run(root, _params(syn), job_id="j2")
    assert built == []
    assert _flight_cloud_files(root, syn)[0] == old_rel
    assert (root / old_rel).is_file()
    files = sorted(p.name for p in (root / "clouds" / "flyability" / sid).glob("*.copc.laz"))
    assert files == sorted(["undefined.copc.laz", "chamber-a-pass.copc.laz", "merged.copc.laz"])


def test_severity_levels_without_criteria_get_an_empty_one(tmp_path, exports):
    syn = exports()
    root = _project(tmp_path)
    params = _params(syn)
    for level in params["severityModel"]["levels"]:
        del level["criteria"]
    _run(root, params)
    (model,) = _manifest(root)["severityModels"]
    assert all(level["criteria"] == "" for level in model["levels"])
