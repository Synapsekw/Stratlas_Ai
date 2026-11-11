"""walk.track and its tracker (``inspection/walktrack.py``) on a synthetic walk: frame boxes are
made by projecting known objects into the equirect frames of a known pose."""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pytest

from aio_pipelines.inspection import equirect as E
from aio_pipelines.inspection import walkjob
from aio_pipelines.inspection import walktrack as T
from aio_pipelines.pipelines import all_pipelines
from aio_pipelines.runtime import JobError
from conftest import run_job

W, H = 2048, 1024
LAYER = "walk-a"
HEIGHT = 1.7


def straight_pose(x0=0.0, x1=10.0, seconds=10.0, hz=2.0, y=HEIGHT, q=(0.0, 0.0, 0.0, 1.0)) -> list[dict]:
    """Samples of a walk along +x (east) at 1 m/s, camera looking north (identity q)."""
    n = int(seconds * hz) + 1
    return [
        {"t": k * 1000.0 / hz, "pos": [x0 + (x1 - x0) * k / (n - 1), y, 0.0], "q": list(q)} for k in range(n)
    ]


def yaw_q(deg: float) -> list[float]:
    """A turn about +y (three.js): positive turns the camera's -z towards -x."""
    a = math.radians(deg) / 2
    return [0.0, math.sin(a), 0.0, math.cos(a)]


def project(pose: T.WalkPose, t: float, p, radius=0.3, bottom: float | None = None) -> list[float]:
    """The frame box of a ball of ``radius`` at ``p`` seen at ``t`` (bottom: a box down to that y)."""
    pos, q = pose.at(t)
    qc = np.array([-q[0], -q[1], -q[2], q[3]])
    rel = T._rotate(qc, np.asarray(p, float) - pos)
    yaw, pitch = E.dir_to_look(rel)
    dist = float(np.linalg.norm(rel))
    half = math.degrees(math.atan(radius / dist))
    cx, cy = E.look_to_pixel(yaw, pitch, W, H)
    hx = half / 360 * W / max(0.05, math.cos(math.radians(pitch)))
    hy = half / 180 * H
    y1 = cy + hy
    if bottom is not None:
        rb = T._rotate(qc, np.array([p[0], bottom, p[2]], float) - pos)
        y1 = E.look_to_pixel(*E.dir_to_look(rb), W, H)[1]
    return [round(cx - hx, 1), round(cy - hy, 1), round(cx + hx, 1), round(y1, 1)]


def draft(i: int, t: float, box, cls="sign", conf=0.8, **extra) -> dict:
    return {
        "id": f"d{i}",
        "class": cls,
        "severity": "uncertain",
        "confidence": conf,
        "status": "draft",
        "bbox": box,
        "space": "source",
        "width": W,
        "height": H,
        "frame": {"layer": LAYER, "t": t},
        "origin": {"runId": "run-x", "model": "m", "threshold": 0.5},
        **extra,
    }


def frames(pose, objects, times, start=0, cls="sign", confs=None):
    out = []
    k = start
    for t in times:
        for j, p in enumerate(objects):
            c = (confs or {}).get((t, j), 0.8)
            out.append(draft(k, t, project(pose, t, p), cls=cls, conf=c))
            k += 1
    return out


TIMES = [k * 0.5 for k in range(21)]
P = (5.0, 1.0, -6.0)


@pytest.fixture
def pose():
    return T.pose_from_samples(straight_pose())


def test_pose_interpolates_position_and_slerps_orientation():
    p = T.pose_from_samples(
        [{"t": 0, "pos": [0, 0, 0], "q": [0, 0, 0, 1]}, {"t": 1000, "pos": [2, 0, 0], "q": yaw_q(90)}]
    )
    pos, q = p.at(0.5)
    assert pos == pytest.approx([1, 0, 0])
    assert q == pytest.approx(yaw_q(45))
    assert p.at(-1)[0] == pytest.approx([0, 0, 0]) and p.at(9)[0] == pytest.approx([2, 0, 0])


def test_one_draft_per_object_placed_on_crossing_rays(pose):
    dets = frames(pose, [P], TIMES, confs={(4.0, 0): 0.95})
    out, stats = T.track_frames(dets, {LAYER: pose}, None, {LAYER: HEIGHT})
    assert len(out) == 1 and stats["objects"] == 1 and stats["merged"] == 20
    d = out[0]
    assert d["id"] == "d8" and d["confidence"] == 0.95  # the best-scored member leads, own score kept
    tr = d["track"]
    assert tr["frames"] == 21 and tr["firstT"] == 0 and tr["lastT"] == 10
    assert tr["placedOn"] == "rays" and stats["placedOn"] == {"rays": 1}
    assert np.linalg.norm(np.subtract(tr["point"], P)) < 0.3
    assert len(tr["sightings"]) == 20 and tr["sightings"][0] == {
        "t": 0.0,
        "bbox": dets[0]["bbox"],
        "confidence": 0.8,
        "id": "d0",
    }
    # the lead frame is at x = 4: the object lies north-east-ish, 6.1 m away
    rel = np.subtract(P, [4.0, HEIGHT, 0.0])
    assert tr["bearingDeg"] == pytest.approx(math.degrees(math.atan2(rel[0], -rel[2])), abs=0.2)
    assert tr["rangeM"] == pytest.approx(float(np.linalg.norm(rel)), abs=0.3)


def test_turned_camera_still_tracks_in_the_walk_frame():
    samples = straight_pose()
    for k, s in enumerate(samples):
        s["q"] = yaw_q(k * 7.0)  # the walker turns while walking
    pose = T.pose_from_samples(samples)
    out, _ = T.track_frames(frames(pose, [P], TIMES), {LAYER: pose}, None, {LAYER: HEIGHT})
    assert len(out) == 1 and np.linalg.norm(np.subtract(out[0]["track"]["point"], P)) < 0.3


def test_two_objects_of_one_class_stay_two_tracks(pose):
    q2 = (8.0, 1.0, -6.0)
    out, stats = T.track_frames(frames(pose, [P, q2], TIMES), {LAYER: pose}, None, {LAYER: HEIGHT})
    assert len(out) == 2 and stats["objects"] == 2
    pts = sorted(tuple(d["track"]["point"]) for d in out)
    assert np.linalg.norm(np.subtract(pts[0], P)) < 0.3 and np.linalg.norm(np.subtract(pts[1], q2)) < 0.3


def test_other_classes_do_not_join(pose):
    dets = frames(pose, [P], TIMES) + frames(pose, [P], TIMES, start=100, cls="light")
    out, _ = T.track_frames(dets, {LAYER: pose}, None, {LAYER: HEIGHT})
    assert sorted(d["class"] for d in out) == ["light", "sign"]


def test_missing_frames_keep_the_track_too_many_break_it(pose):
    two_missing = [t for t in TIMES if t not in (1.0, 1.5)]
    out, _ = T.track_frames(
        frames(pose, [P], two_missing), {LAYER: pose}, None, {LAYER: HEIGHT}, assessed={LAYER: TIMES}
    )
    assert len(out) == 1 and out[0]["track"]["frames"] == 19
    three_missing = [t for t in TIMES if t not in (1.0, 1.5, 2.0)]
    out, _ = T.track_frames(
        frames(pose, [P], three_missing), {LAYER: pose}, None, {LAYER: HEIGHT}, assessed={LAYER: TIMES}
    )
    assert len(out) == 2


def test_ground_placement_when_the_rays_do_not_cross():
    # the walker stands still: no baseline, but the box bottom looks down at the ground
    pose = T.pose_from_samples(straight_pose(0.0, 0.0))
    p = (0.0, 0.3, -5.0)
    dets = [draft(k, t, project(pose, t, p, bottom=0.0)) for k, t in enumerate(TIMES[:5])]
    out, stats = T.track_frames(dets, {LAYER: pose}, None, {LAYER: HEIGHT})
    tr = out[0]["track"]
    assert tr["placedOn"] == "ground" and stats["placedOn"] == {"ground": 1}
    assert tr["point"] == pytest.approx([0.0, 0.0, -5.0], abs=0.1)
    assert tr["bearingDeg"] == pytest.approx(0.0, abs=0.2) or tr["bearingDeg"] == pytest.approx(
        360.0, abs=0.2
    )


def test_mesh_placement(pose):
    import trimesh

    from aio_pipelines.multiview.scene import MeshSurface

    wall = trimesh.creation.box(extents=[30.0, 6.0, 0.2])
    wall.apply_translation([5.0, 2.0, -6.1])  # its south face is the plane z = -6
    p = (5.0, 1.0, -6.0)
    out, stats = T.track_frames(frames(pose, [p], TIMES), {LAYER: pose}, MeshSurface(wall), {LAYER: HEIGHT})
    tr = out[0]["track"]
    assert tr["placedOn"] == "mesh" and stats["placedOn"] == {"mesh": 1}
    assert np.linalg.norm(np.subtract(tr["point"], p)) < 0.3


def test_without_a_pose_a_track_but_no_point(pose):
    out, stats = T.track_frames(frames(pose, [P], TIMES[8:12]), {LAYER: None})
    assert len(out) == 1 and "point" not in out[0]["track"] and stats["unplaced"] == 1


def test_reviewed_and_other_detections_untouched_order_kept(pose):
    dets = frames(pose, [P], TIMES)
    accepted = {**dets[3], "id": "acc", "status": "accepted", "class": "light"}  # another object
    photo = {"id": "ph", "photo": "p1", "class": "sign", "status": "draft", "bbox": [0, 0, 5, 5]}
    other_walk = {**dets[4], "id": "ow", "frame": {"layer": "walk-b", "t": 2.0}}
    out, _ = T.track_frames([photo, accepted, *dets, other_walk], {LAYER: pose}, None, {LAYER: HEIGHT})
    assert [d["id"] for d in out][:2] == ["ph", "acc"]
    assert out[0] is photo and out[1] is accepted and out[-1] is other_walk
    assert len(out) == 4 and "track" in out[2]


def test_one_frame_tracks_are_left_alone(pose):
    dets = frames(pose, [P], [2.0])
    out, stats = T.track_frames(dets, {LAYER: pose}, None, {LAYER: HEIGHT})
    assert out == dets and stats["merged"] == 0 and stats["objects"] == 1


def test_rerun_is_idempotent_and_an_extended_run_joins(pose):
    first, _ = T.track_frames(frames(pose, [P], TIMES[:12]), {LAYER: pose}, None, {LAYER: HEIGHT})
    again, stats = T.track_frames(first, {LAYER: pose}, None, {LAYER: HEIGHT})
    assert again == first and stats["merged"] == 11
    more = frames(pose, [P], TIMES[12:], start=500)
    out, _ = T.track_frames(first + more, {LAYER: pose}, None, {LAYER: HEIGHT})
    assert len(out) == 1 and out[0]["track"]["frames"] == 21


def test_sightings_are_capped(pose):
    dets = [draft(k, k * 0.01, project(pose, 5.0, P)) for k in range(T.MAX_SIGHTINGS + 6)]
    out, _ = T.track_frames(dets, {LAYER: None})
    tr = out[0]["track"]
    assert len(tr["sightings"]) == T.MAX_SIGHTINGS and tr["sightingsOmitted"] == 5
    # an expanded track gives back every listed sighting as a draft
    members = T.expand(out[0])
    assert len(members) == T.MAX_SIGHTINGS + 1
    m = members[1]
    assert m["status"] == "draft" and m["class"] == "sign" and m["frame"]["layer"] == LAYER
    assert m["width"] == W and m["origin"] == out[0]["origin"] and "track" not in m


# --------------------------------------------------------------------------------------------- job


def make_project(root: Path, dets, posed=True, assessed=None) -> Path:
    (root / "walks" / "a").mkdir(parents=True)
    (root / "detections").mkdir()
    layer = {"kind": "walk", "id": LAYER, "name": "Walk", "visible": True, "record": {"path": "walks/a/walk.json"},
             "src": {"path": "walks/a/play.mp4"}, "durationS": 10, "place": {"heightM": HEIGHT}}  # fmt: skip
    if posed:
        (root / "walks" / "a" / "pose.json").write_text(
            json.dumps({"schema": "aio.flight/1", "samples": straight_pose()}), "utf-8"
        )
        layer["flight"] = {"src": {"path": "walks/a/pose.json"}, "startUtcMs": 0}
    manifest = {"schema": "aio.project/1", "id": "w", "name": "W", "origin": [0, 0, 0], "layers": [layer]}
    (root / "manifest.json").write_text(json.dumps(manifest), "utf-8")
    write_pass(root, dets, assessed)
    return root


def write_pass(root: Path, dets, assessed=None) -> None:
    doc = {"schema": "aio.detections/1", "source": "model", "layer": LAYER,
           "assessed": assessed if assessed is not None else [f"t:{round(t * 1000)}" for t in TIMES],
           "detections": dets}  # fmt: skip
    (root / "detections" / "model-run-x.json").write_text(json.dumps(doc), "utf-8")


def read_pass(root: Path) -> dict:
    return json.loads((root / "detections" / "model-run-x.json").read_text("utf-8"))


PARAMS = {"pass": "detections/model-run-x.json", "layer": LAYER}


def test_job_tracks_and_places_then_a_rerun_changes_nothing(tmp_path, pose):
    root = make_project(tmp_path / "p", frames(pose, [P], TIMES))
    res, _ = run_job(all_pipelines()["walk.track"], root, PARAMS)
    out = _outputs(res)
    assert out["objects"] == 1 and out["merged"] == 20 and out["placedOn"] == {"rays": 1}
    assert out["unchanged"] is False and out["pass"] == PARAMS["pass"]
    doc = read_pass(root)
    assert len(doc["detections"]) == 1 and doc["assessed"][0] == "t:0"
    tr = doc["detections"][0]["track"]
    assert tr["placedOn"] == "rays" and np.linalg.norm(np.subtract(tr["point"], P)) < 0.3
    before = (root / "detections" / "model-run-x.json").read_bytes()
    res2, _ = run_job(all_pipelines()["walk.track"], root, PARAMS, job_id="j2")
    assert (root / "detections" / "model-run-x.json").read_bytes() == before
    assert _outputs(res2)["unchanged"] is True and _outputs(res2)["merged"] == 20


def _outputs(res: dict) -> dict:
    """The commit step's outputs of a job result."""
    return res["outputs"]["commit"]


def test_job_with_nothing_repeated_leaves_the_file_byte_identical(tmp_path, pose):
    root = make_project(tmp_path / "p", frames(pose, [P], [3.0]))
    before = (root / "detections" / "model-run-x.json").read_bytes()
    res, _ = run_job(all_pipelines()["walk.track"], root, PARAMS)
    assert (root / "detections" / "model-run-x.json").read_bytes() == before
    assert _outputs(res)["unchanged"] is True


def test_job_without_a_pose_tracks_without_points(tmp_path, pose):
    root = make_project(tmp_path / "p", frames(pose, [P], TIMES[:6]), posed=False)
    run_job(all_pipelines()["walk.track"], root, PARAMS)
    tr = read_pass(root)["detections"][0]["track"]
    assert tr["frames"] == 6 and "point" not in tr


def test_job_tracks_again_when_the_pass_changed_before_commit(tmp_path, pose, monkeypatch):
    root = make_project(tmp_path / "p", frames(pose, [P], TIMES[:10]))
    later = frames(pose, [P], TIMES, start=0)
    orig = walkjob.WalkTrack._track

    def track_then_edit(self, ctx):
        out = orig(self, ctx)
        write_pass(root, later)  # the app saved the pass meanwhile
        return out

    monkeypatch.setattr(walkjob.WalkTrack, "_track", track_then_edit)
    run_job(all_pipelines()["walk.track"], root, PARAMS)
    dets = read_pass(root)["detections"]
    assert len(dets) == 1 and dets[0]["track"]["frames"] == 21


def test_job_retrack_after_a_review_makes_no_duplicate_of_the_reviewed_object(tmp_path, pose, monkeypatch):
    root = make_project(tmp_path / "p", frames(pose, [P], TIMES[:10]))
    accepted = {**draft(900, 5.0, project(pose, 5.0, P)), "id": "acc", "status": "accepted"}
    later = [accepted, *frames(pose, [P], TIMES)]
    orig = walkjob.WalkTrack._track

    def track_then_review(self, ctx):
        out = orig(self, ctx)
        write_pass(root, later)  # the person accepted the object meanwhile, and a run added frames
        return out

    monkeypatch.setattr(walkjob.WalkTrack, "_track", track_then_review)
    res, _ = run_job(all_pipelines()["walk.track"], root, PARAMS)
    assert [d["id"] for d in read_pass(root)["detections"]] == ["acc"]
    assert _outputs(res)["droppedOnReviewed"] == 21


def test_a_reviewed_object_gets_no_new_draft_another_object_still_tracks(pose):
    q2 = (8.0, 1.0, -6.0)
    dets = frames(pose, [P, q2], TIMES)
    # rejected, with sightings only early in the walk: the drafts later on chain to it
    rejected = {**draft(900, 0.0, project(pose, 0.0, P)), "id": "rej", "status": "rejected"}
    rejected["track"] = {"frames": 2, "firstT": 0.0, "lastT": 0.5,
                         "sightings": [{"t": 0.5, "bbox": project(pose, 0.5, P)}]}  # fmt: skip
    out, stats = T.track_frames([rejected, *dets], {LAYER: pose}, None, {LAYER: HEIGHT})
    assert out[0] is rejected and len(out) == 2
    assert np.linalg.norm(np.subtract(out[1]["track"]["point"], q2)) < 0.3
    assert stats["droppedOnReviewed"] == 21 and stats["objects"] == 1


def test_a_reviewed_detection_of_another_class_or_far_away_blocks_nothing(pose):
    other = {**draft(900, 5.0, project(pose, 5.0, P)), "id": "acc", "status": "accepted", "class": "light"}
    far = {**draft(901, 5.0, project(pose, 5.0, (5.0, 1.0, 6.0))), "id": "acc2", "status": "accepted"}
    out, stats = T.track_frames([other, far, *frames(pose, [P], TIMES)], {LAYER: pose}, None, {LAYER: HEIGHT})
    assert len(out) == 3 and stats["droppedOnReviewed"] == 0 and out[2]["track"]["frames"] == 21


# ---------------------------------------------------------------- the renderer's pose convention


def quat_from_yaw_pitch_roll(yaw: float, pitch: float, roll: float) -> list[float]:
    """``@aio/geo`` walk/horizontal.ts ``quatFromYawPitchRoll``: Ry(yaw) Rx(pitch) Rz(roll), YXZ."""
    c1, c2, c3 = math.cos(pitch / 2), math.cos(yaw / 2), math.cos(roll / 2)
    s1, s2, s3 = math.sin(pitch / 2), math.sin(yaw / 2), math.sin(roll / 2)
    return [
        s1 * c2 * c3 + c1 * s2 * s3,
        c1 * s2 * c3 - s1 * c2 * s3,
        c1 * c2 * s3 - s1 * s2 * c3,
        c1 * c2 * c3 + s1 * s2 * s3,
    ]


def heading_of(dx: float, dz: float) -> float:
    """``headingOf``: the Ry angle of a travel direction (0 looks down -Z)."""
    return math.atan2(-dx, -dz)


@pytest.mark.parametrize(
    "frame_yaw,pitch,expected",
    [(0.0, 0.0, 90.0), (90.0, 0.0, 180.0), (-90.0, 0.0, 0.0), (0.0, 0.2, 90.0), (180.0, -0.1, 270.0)],
)
def test_a_box_at_a_known_yaw_has_the_renderers_bearing(frame_yaw, pitch, expected):
    # walkPoseSamples: q = quatFromYawPitchRoll(heading + yawOffset, pitch, roll), walking east
    q = quat_from_yaw_pitch_roll(heading_of(1.0, 0.0), pitch, 0.0)
    pose = T.pose_from_samples([{"t": k * 500.0, "pos": [k * 0.5, HEIGHT, 0.0], "q": q} for k in range(3)])
    x, y = E.look_to_pixel(frame_yaw, math.degrees(-pitch) + 5.0, W, H)  # level, a little above
    box = [x - 10, y - 10, x + 10, y + 10]
    dets = [draft(k, k * 0.5, box) for k in range(3)]
    out, _ = T.track_frames(dets, {LAYER: pose}, None, {LAYER: HEIGHT})
    b = out[0]["track"]["bearingDeg"]
    assert min(abs(b - expected), 360 - abs(b - expected)) < 0.5


def test_job_params_are_strict():
    p = all_pipelines()["walk.track"]
    assert p.validate({"pass": "detections/a.json"}) == {"pass": "detections/a.json"}
    for bad in (
        {"pass": "../a.json"},
        {"pass": "detections/../x.json"},
        {"pass": "detections/sub/a.json"},
        {"pass": "detections/a.json", "extra": 1},
        {"pass": "detections/a.json", "layer": ""},
        {},
    ):
        with pytest.raises(JobError):
            p.validate(bad)
