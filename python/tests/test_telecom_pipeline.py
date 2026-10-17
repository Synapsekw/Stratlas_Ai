"""The `telecom.antennas` job end to end on synthetic towers."""

from __future__ import annotations

import json
import math
import re
import struct
import threading
import time
from pathlib import Path

import numpy as np
import pyproj
import pytest
from PIL import Image

from aio_pipelines.pipelines import all_pipelines
from aio_pipelines.runtime import Cancelled, Job, JobError
from aio_pipelines.telecom.crown import TOWER_HINT_NEEDED
from aio_pipelines.telecom.measure import grid_convergence_deg
from aio_pipelines.telecom.photos import CROP_MAX_PX
from antenna_synth import make_tower_project, tower_cloud
from conftest import Recorder, run_job
from test_telecom_crown import CAPTURE, line_up, lined_up_axis, write_evidence
from test_telecom_photos import look_at_q

CONTRACT = Path(__file__).resolve().parents[2] / "packages/schema/src/__fixtures__/antennas-contract.json"
REQUIRED = {
    "id",
    "name",
    "kind",
    "kindBasis",
    "status",
    "box",
    "support",
    "widthM",
    "heightM",
    "depthM",
    "convergenceDeg",
    "photos",
    "user",
    "runId",
    "createdAt",
}
RUN_KEYS = {"id", "at", "params", "cloudLayer", "axis", "crown", "north", "warnings", "counts"}
UNIT_ID = re.compile(r"^ant-[a-z0-9-]{1,60}$")
E0, N0 = 400000.0, 5600000.0


def pipeline():
    return all_pipelines()["telecom.antennas"]


def nearest(units: list[dict], truth: dict, origin=(E0, N0, 0.0)) -> dict:
    """The unit whose box centre is closest in E, N to a truth unit (local centre)."""
    e = origin[0] + truth["centre"][0]
    n = origin[1] - truth["centre"][2]
    return min(units, key=lambda u: (u["box"]["centre"][0] - e) ** 2 + (u["box"]["centre"][1] - n) ** 2)


def panel_truth(truth: dict, name: str = "panel-0") -> dict:
    return next(u for u in truth["units"] if u["name"] == name)


def read_file(root: Path) -> dict:
    return json.loads((root / "telecom" / "antennas.json").read_text("utf-8"))


def las_min_z(path: Path) -> float:
    with open(path, "rb") as f:
        head = f.read(227)
    return struct.unpack_from("<d", head, 219)[0]


def add_photo(root: Path, target_local, distance=10.0, name="front") -> None:
    """A posed photo layer: one camera `distance` m north of `target_local` looking at it."""
    target = np.asarray(target_local, dtype=float)
    pos = target + np.array([0.0, 0.0, -distance])
    (root / "photos").mkdir(exist_ok=True)
    Image.new("RGB", (1600, 1200), (120, 130, 140)).save(root / "photos" / f"{name}.jpg", "JPEG")
    m = json.loads((root / "manifest.json").read_text("utf-8"))
    m["layers"].append(
        {
            "kind": "photos",
            "id": "photos-1",
            "name": "Photos",
            "items": [
                {
                    "id": name,
                    "src": {"path": f"photos/{name}.jpg"},
                    "pos": pos.tolist(),
                    "q": look_at_q(pos, target),
                    "lens": {"model": "pinhole", "hfovDeg": 50.0, "aspect": 4 / 3},
                }
            ],
        }
    )
    (root / "manifest.json").write_text(json.dumps(m, indent=1), encoding="utf-8")


@pytest.fixture(scope="module")
def monopole():
    return tower_cloud(seed=1)


def test_registered():
    assert "telecom.antennas" in all_pipelines()
    p = pipeline()
    assert p.title == "Detect antennas" and p.keys == {"run", "cloud", "towerHint", "floorFraction"}
    assert [s.name for s in p.plan({"run": "run-a"})] == ["crown", "faces", "boxes", "photos", "commit"]
    assert [s.weight for s in p.plan({"run": "run-a"})] == [2.0, 3.0, 1.0, 1.0, 0.2]
    assert p.inputs({"run": "run-a"}, Path(".")) == ["manifest.json", "clouds", "engineering"]


def test_validate():
    p = pipeline()
    assert p.validate({"run": "run-a"}) == {"run": "run-a"}
    full = {"run": "run-a-2", "cloud": {"layer": "c1"}, "towerHint": [1, 2.5], "floorFraction": 0.6}
    assert p.validate(full) == {**full, "towerHint": [1.0, 2.5]}
    for bad in (
        {"run": "run-a", "extra": 1},  # unknown key
        {},  # no run
        {"run": "Run-A"},
        {"run": "job-a"},
        {"run": "run-"},
        {"run": "run-a", "towerHint": [1.0]},
        {"run": "run-a", "towerHint": [1.0, "2"]},
        {"run": "run-a", "towerHint": [1.0, 2.0, 3.0]},
        {"run": "run-a", "towerHint": [True, 2.0]},
        {"run": "run-a", "cloud": "c1"},
        {"run": "run-a", "cloud": {"layer": ""}},
        {"run": "run-a", "cloud": {"layer": "c1", "x": 1}},
        {"run": "run-a", "floorFraction": 0.2},
        {"run": "run-a", "floorFraction": 0.99},
    ):
        with pytest.raises(JobError):
            p.validate(bad)


def test_runs_end_to_end(tmp_path, monopole):
    xyz, truth = monopole
    root = make_tower_project(tmp_path / "p", xyz, epsg=32633)
    panel = panel_truth(truth)
    add_photo(root, panel["centre"])
    t0 = time.perf_counter()
    result, rec = run_job(pipeline(), root, {"run": "run-a"})
    elapsed = time.perf_counter() - t0
    assert result["status"] == "done"
    f = read_file(root)
    contract = json.loads(CONTRACT.read_text("utf-8"))
    assert f["schema"] == "aio.antennas/1" and set(f) == {"schema", "run", "units"}
    assert set(contract["example"]["units"][0]) >= REQUIRED and set(f["units"][0]) >= REQUIRED
    assert set(f["run"]) >= RUN_KEYS and set(f["run"]) <= RUN_KEYS | {"groundZ", "ai", "captureId"}
    assert "captureId" not in f["run"]  # the cloud has no survey date
    assert f["run"]["north"] == "grid" and f["run"]["cloudLayer"] == "tower-cloud"
    assert f["run"]["params"] == {"run": "run-a"} and f["run"]["id"] == "run-a"
    assert f["run"]["axis"]["source"] == "auto"
    assert f["run"]["axis"]["dir"] == pytest.approx([0.0, 0.0, 1.0], abs=0.01)  # up is U in E, N, U
    assert f["run"]["axis"]["point"][:2] == pytest.approx([E0, N0], abs=0.1)
    assert f["run"]["groundZ"] == pytest.approx(0.0, abs=0.05)  # the synthetic ground is at 0
    assert f["run"]["crown"]["topZ"] == pytest.approx(truth["height"], abs=0.3)
    lon, lat = pyproj.Transformer.from_crs(32633, 4326, always_xy=True).transform(E0, N0)
    conv = grid_convergence_deg(lon, lat, 32633)
    assert all(u["convergenceDeg"] == pytest.approx(conv, abs=0.01) for u in f["units"])
    got = nearest(f["units"], panel)
    assert got["box"]["centre"][0] == pytest.approx(E0 + panel["centre"][0], abs=0.05)
    assert got["box"]["centre"][1] == pytest.approx(N0 - panel["centre"][2], abs=0.05)
    assert got["box"]["centre"][2] == pytest.approx(panel["centre"][1], abs=0.05)
    az = got["azimuthGridDeg"]["value"] % 360.0
    assert got["kind"] == "panel" and min(az, 360.0 - az) < 1.0
    # review fields of a first run
    for u in f["units"]:
        assert UNIT_ID.match(u["id"]) and u["status"] == "draft" and u["kindBasis"] == "geometry"
        assert u["runId"] == "run-a" and u["user"] == {} and re.match(r"^A\d+$", u["name"])
    assert len({u["id"] for u in f["units"]}) == len(f["units"])
    counts = f["run"]["counts"]
    assert sum(counts.values()) == len(f["units"])
    assert counts["panel"] >= 3 and counts["dish"] >= 1
    # the posed photo sees the north panel, and its crop is on disk, named by the unit id
    assert got["photos"] and got["photos"][0]["layer"] == "photos-1" and got["photos"][0]["id"] == "front"
    assert got["crop"] == f"telecom/crops/{got['id']}.jpg"
    with Image.open(root / got["crop"]) as im:
        assert max(im.size) <= CROP_MAX_PX
    for u in f["units"]:
        if "crop" in u:
            assert (root / u["crop"]).is_file()
    # the camera stands north of the tower: units facing away from it have no photo and no crop
    south = nearest(f["units"], panel_truth(truth, "panel-120"))
    assert south["photos"] == [] and "crop" not in south
    assert not (root / "telecom" / "crops" / f"{south['id']}.jpg").exists()
    # progress: plan, then the five step messages, and the staged files did not leak
    msgs = [p.get("message") for p in rec.of("progress")]
    for m in (
        "Locating the tower crown",
        "Finding planar faces",
        "Fitting antenna boxes",
        "Picking the best photos",
        "Saving the inventory",
    ):
        assert m in msgs
    assert not list((root / "telecom").glob("*.tmp"))
    print(f"telecom.antennas on the synthetic monopole: {elapsed:.1f} s")
    assert elapsed < 120


def test_no_crs_is_project_north(tmp_path, monopole):
    xyz, truth = monopole
    root = make_tower_project(tmp_path / "p", xyz, epsg=None)
    assert "crs" not in json.loads((root / "manifest.json").read_text("utf-8"))
    run_job(pipeline(), root, {"run": "run-a"})
    f = read_file(root)
    assert f["run"]["north"] == "project"
    assert f["units"] and all(u["convergenceDeg"] is None for u in f["units"])
    got = nearest(f["units"], panel_truth(truth))
    assert got["box"]["centre"][0] == pytest.approx(E0 + panel_truth(truth)["centre"][0], abs=0.05)


def test_height_offset_applied(tmp_path, monopole):
    xyz, truth = monopole
    root = make_tower_project(tmp_path / "p", xyz, height_offset_m=2.5)
    assert las_min_z(root / "clouds" / "tower.las") == pytest.approx(-2.5, abs=0.05)
    run_job(pipeline(), root, {"run": "run-a"})
    f = read_file(root)
    panel = panel_truth(truth)
    assert nearest(f["units"], panel)["box"]["centre"][2] == pytest.approx(panel["centre"][1], abs=0.03)
    assert f["run"]["groundZ"] == pytest.approx(0.0, abs=0.05)


def test_ground_ignores_low_outliers_by_the_base(tmp_path, monopole):
    xyz, _ = monopole
    rng = np.random.default_rng(5)
    ang = rng.uniform(0, 2 * np.pi, 3)
    outliers = np.column_stack([1.5 * np.cos(ang), np.full(3, -4.0), 1.5 * np.sin(ang)])
    root = make_tower_project(tmp_path / "p", np.vstack([xyz, outliers]))
    run_job(pipeline(), root, {"run": "run-a"})
    f = read_file(root)
    assert f["run"]["groundZ"] == pytest.approx(0.0, abs=0.05)  # not dragged to -4 m
    assert f["units"]


def test_height_offset_absent(tmp_path, monopole):
    xyz, truth = monopole
    root = make_tower_project(tmp_path / "p", xyz)
    layer = json.loads((root / "manifest.json").read_text("utf-8"))["layers"][0]
    assert "heightOffsetM" not in layer
    assert las_min_z(root / "clouds" / "tower.las") == pytest.approx(float(xyz[:, 1].min()), abs=0.002)
    run_job(pipeline(), root, {"run": "run-a"})
    panel = panel_truth(truth)
    got = nearest(read_file(root)["units"], panel)
    assert got["box"]["centre"][2] == pytest.approx(panel["centre"][1], abs=0.03)


def test_rerun_keeps_review(tmp_path, monopole):
    xyz, truth = monopole
    root = make_tower_project(tmp_path / "p", xyz)
    run_job(pipeline(), root, {"run": "run-a"}, job_id="j1")
    f = read_file(root)
    a1 = next(u for u in f["units"] if u["name"] == "A1")
    a1["status"] = "accepted"
    a1["user"] = {"model": "X"}
    # a draft far from anything the run finds is dropped; a rejected one far away too
    ghost = json.loads(json.dumps(a1))
    ghost.update(id="ant-ghost-1", name="A90", status="draft", user={})
    ghost["box"]["centre"] = [E0 + 50.0, N0, 5.0]
    f["units"].append(ghost)
    (root / "telecom" / "antennas.json").write_text(json.dumps(f), encoding="utf-8")
    run_job(pipeline(), root, {"run": "run-b"}, job_id="j2")
    g = read_file(root)
    again = next(u for u in g["units"] if u["id"] == a1["id"])
    assert again["status"] == "accepted" and again["user"] == {"model": "X"} and again["name"] == "A1"
    assert "notFoundInLatest" not in again
    assert all(u["id"] != "ant-ghost-1" for u in g["units"])
    assert g["run"]["id"] == "run-b"
    # every unit of the first run was found again: ids and names are the first run's
    assert sorted(u["id"] for u in g["units"]) == sorted(
        u["id"] for u in f["units"] if u["id"] != "ant-ghost-1"
    )


def test_tower_hint_message_matches_contract():
    assert json.loads(CONTRACT.read_text("utf-8"))["towerHintMessage"] == TOWER_HINT_NEEDED


def test_progress_and_cancel(tmp_path, monopole):
    xyz, _ = monopole
    root = make_tower_project(tmp_path / "p", xyz)
    cancel = threading.Event()
    rec = Recorder()

    def emit(method, params):
        rec(method, params)
        if method == "progress" and params.get("step") == "faces" and params.get("state") == "start":
            cancel.set()

    with pytest.raises(Cancelled):
        Job("jc", pipeline(), root, {"run": "run-a"}, emit, cancel).run()
    assert not (root / "telecom" / "antennas.json").exists()
    assert (root / "jobs" / "jc" / "steps" / "01-crown.json").is_file()
    assert not (root / "jobs" / "jc" / "steps" / "02-faces.json").exists()
    # resume: the crown is not located again, the run finishes, progress only grows
    result, rec2 = run_job(pipeline(), root, {"run": "run-a"}, job_id="jc")
    assert result["status"] == "done" and (root / "telecom" / "antennas.json").is_file()
    states = [(p.get("step"), p.get("state")) for p in rec2.of("progress")]
    assert ("crown", "skipped") in states
    fractions = [p["fraction"] for p in rec2.of("progress") if "fraction" in p]
    assert fractions == sorted(fractions) and fractions[-1] == 1.0
    first = [p["fraction"] for p in rec.of("progress") if "fraction" in p]
    assert first == sorted(first) and 0 < first[-1] < 1


def test_failure_carries_the_hint_message(tmp_path):
    from antenna_synth import two_masts_cloud

    xyz, _ = two_masts_cloud(seed=1)
    root = make_tower_project(tmp_path / "p", xyz)
    rec = Recorder()
    with pytest.raises(JobError) as e:
        Job("jh", pipeline(), root, {"run": "run-a"}, rec, threading.Event()).run()
    assert str(e.value) == TOWER_HINT_NEEDED
    assert rec.of("error")[0]["message"] == TOWER_HINT_NEEDED
    assert not (root / "telecom" / "antennas.json").exists()


def test_line_up_keeps_the_inventory_in_the_date_frame(tmp_path, monopole):
    # R-lineup: the cloud's date is lined up 3 m east and 2 m south; engineering evidence was
    # measured where the date is drawn (lined up), the cloud file and the photo poses are raw.
    # The inventory stays in the date's own frame: the same units, boxes and photos as unshifted.
    xyz, truth = monopole
    panel = panel_truth(truth)
    runs = {}
    for name, shift in (("plain", (0.0, 0.0)), ("moved", (3.0, -2.0))):
        root = make_tower_project(tmp_path / name, xyz)
        add_photo(root, panel["centre"])
        if shift != (0.0, 0.0):
            line_up(root, *shift)
        write_evidence(root, "run-e", lined_up_axis(*shift), truth["height"])
        result, _ = run_job(pipeline(), root, {"run": "run-a"})
        assert result["status"] == "done"
        runs[name] = read_file(root)
    plain, moved = runs["plain"], runs["moved"]
    assert moved["run"]["captureId"] == CAPTURE and "captureId" not in plain["run"]
    assert moved["run"]["axis"]["source"] == "evidence"
    assert moved["run"]["axis"]["point"] == plain["run"]["axis"]["point"]
    assert moved["run"]["axis"]["point"][:2] == pytest.approx([E0, N0], abs=1e-6)
    assert len(moved["units"]) == len(plain["units"]) > 0
    for a, b in zip(plain["units"], moved["units"], strict=True):
        assert a["kind"] == b["kind"] and a["box"] == b["box"]
        assert a.get("azimuthGridDeg") == b.get("azimuthGridDeg")
        # the photo projection still matches: raw boxes against raw poses
        assert [(p["id"], p["score"]) for p in a["photos"]] == [(p["id"], p["score"]) for p in b["photos"]]
    got = nearest(moved["units"], panel)
    assert got["box"]["centre"][:2] == pytest.approx(
        [E0 + panel["centre"][0], N0 - panel["centre"][2]], abs=0.05
    )
    assert got["photos"] and got["photos"][0]["id"] == "front"


def test_left_out_candidates_are_a_run_warning(tmp_path):
    xyz, _ = tower_cloud(seed=1, interior=True)
    root = make_tower_project(tmp_path / "p", xyz)
    result, rec = run_job(pipeline(), root, {"run": "run-a"})
    assert result["status"] == "done"
    warnings = read_file(root)["run"]["warnings"]
    left = [w for w in warnings if "candidate box" in w]
    assert len(left) == 1 and re.match(r"^\d+ candidate boxes? (was|were) not listed: .+\.$", left[0])
    assert "\u2013" not in left[0] and "\u2014" not in left[0]
    logs = " ".join(str(p.get("message", "")) for p in rec.of("log"))
    assert "Candidate boxes left out:" in logs and "part of a listed unit" in logs
    assert "against a cap of" in logs


def _dated(root: Path, capture: str, shifts: dict[str, tuple[float, float]]) -> None:
    """Two survey dates, each lined up by its own shift; the cloud layer belongs to `capture`."""
    p = root / "manifest.json"
    m = json.loads(p.read_text("utf-8"))
    m["captures"] = [
        {
            "id": cid,
            "label": "Survey",
            "date": cid[len("capture-") :],
            "lineUp": {"eastM": e, "northM": n, "with": "capture-2026-01-01", "at": "2026-10-17T00:00:00Z"},
        }
        for cid, (e, n) in shifts.items()
    ]
    for layer in m["layers"]:
        if layer.get("kind") == "pointcloud":
            layer["capture"] = capture
    p.write_text(json.dumps(m, indent=1), encoding="utf-8")


def test_rerun_on_another_date_moves_the_inventory_into_its_frame(tmp_path, monopole):
    # Date A is lined up 3 m east, 2 m south; date B 1 m west, 1.5 m north. Both scan the same
    # physical tower, so B's own coordinates are A's plus (shift A - shift B) = (+4 E, -3.5 N).
    xyz, _ = monopole
    a, b = "capture-2026-02-01", "capture-2026-06-01"
    shifts = {a: (3.0, -2.0), b: (-1.0, 1.5)}
    de, dn = 4.0, -3.5
    root = make_tower_project(tmp_path / "p", xyz)
    _dated(root, a, shifts)
    assert run_job(pipeline(), root, {"run": "run-a"})[0]["status"] == "done"
    first = read_file(root)
    assert first["run"]["captureId"] == a and len(first["units"]) > 0
    kept = first["units"][0]
    first["units"][0] = {**kept, "status": "accepted"}
    (root / "telecom" / "antennas.json").write_text(json.dumps(first), encoding="utf-8")

    # the same tower in date B's own frame (local x east, z south)
    moved = np.array(xyz, dtype=np.float64)
    moved[:, 0] += de
    moved[:, 2] -= dn
    make_tower_project(tmp_path / "b", moved)
    (root / "clouds" / "tower.las").write_bytes((tmp_path / "b" / "clouds" / "tower.las").read_bytes())
    _dated(root, b, shifts)
    assert run_job(pipeline(), root, {"run": "run-b"}, job_id="jb")[0]["status"] == "done"
    second = read_file(root)
    assert second["run"]["captureId"] == b
    assert not any(u.get("notFoundInLatest") for u in second["units"])
    assert len(second["units"]) == len(first["units"])
    same = [u for u in second["units"] if u["id"] == kept["id"]]
    assert len(same) == 1 and same[0]["status"] == "accepted" and same[0]["name"] == kept["name"]
    # stored in B's frame, and no draft was added on top of it
    want = [kept["box"]["centre"][0] + de, kept["box"]["centre"][1] + dn, kept["box"]["centre"][2]]
    assert same[0]["box"]["centre"] == pytest.approx(want, abs=0.05)
    near = [
        u
        for u in second["units"]
        if u["id"] != kept["id"] and math.dist(u["box"]["centre"], same[0]["box"]["centre"]) < 0.3
    ]
    assert near == []
