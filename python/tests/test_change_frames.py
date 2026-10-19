"""change.frames: pose-matched frame pairs aligned by features; changes become draft detections.

Synthetic only: a procedural texture "world" seen by two cameras (two crops through slightly
different homographies), so both frames are full images of the same ground.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
from PIL import Image
from scipy import ndimage as ndi
from skimage.transform import ProjectiveTransform, warp

from aio_pipelines.change.changeset import validate_change_set
from aio_pipelines.change.frames import ChangeFrames, frame_change, pose_gap
from aio_pipelines.pipelines import all_pipelines
from aio_pipelines.runtime import JobError
from conftest import run_job

H, W = 300, 400
PATCH = (200, 140, 240, 180)  # x0, y0, x1, y1 in frame B


def world(seed: int = 0, h: int = 700, w: int = 900) -> np.ndarray:
    rng = np.random.default_rng(seed)
    img = ndi.gaussian_filter(rng.random((h, w)), 2.5)
    img = (img - img.min()) / (img.max() - img.min())
    for _ in range(140):
        y, x = int(rng.integers(0, h - 30)), int(rng.integers(0, w - 30))
        hh, ww = int(rng.integers(6, 28)), int(rng.integers(6, 28))
        img[y : y + hh, x : x + ww] = rng.random()
    return img.astype(np.float64)


def view(img: np.ndarray, dx: float, dy: float, rot_deg: float = 0.0, scale: float = 1.0, persp=0.0):
    """A frame of the world: output pixel (x, y) shows world point M (x, y)."""
    c, s = np.cos(np.radians(rot_deg)), np.sin(np.radians(rot_deg))
    m = np.array(
        [
            [scale * c, -scale * s, 150 + dx],
            [scale * s, scale * c, 120 + dy],
            [persp, 0.0, 1.0],
        ]
    )
    return warp(img, ProjectiveTransform(m), output_shape=(H, W), order=1)


def with_patch(frame: np.ndarray, value: float = 1.0) -> np.ndarray:
    out = frame.copy()
    x0, y0, x1, y1 = PATCH
    out[y0:y1, x0:x1] = value
    return out


@pytest.fixture(scope="module")
def frames():
    w = world()
    a = view(w, 0, 0)
    b = view(w, 7, -5, rot_deg=1.5, scale=1.02, persp=2e-5)
    return a, b


def test_a_viewpoint_offset_alone_gives_no_change(frames):
    a, b = frames
    r = frame_change(a, b, min_area_px=150)
    assert r["aligned"]
    assert r["inliers"] >= 12
    assert r["regions"] == []


def test_exposure_differences_alone_give_no_change(frames):
    a, b = frames
    r = frame_change(a, np.clip(b * 1.15 + 0.05, 0, 1), min_area_px=150)
    assert r["aligned"]
    assert r["regions"] == []


def test_a_patch_added_on_frame_b_gives_one_region_where_it_is(frames):
    a, b = frames
    r = frame_change(a, with_patch(b), min_area_px=150)
    assert r["aligned"]
    assert len(r["regions"]) == 1
    x0, y0, x1, y1 = r["regions"][0]["bbox"]
    assert abs(x0 - PATCH[0]) <= 6 and abs(y0 - PATCH[1]) <= 6
    assert abs(x1 - PATCH[2]) <= 6 and abs(y1 - PATCH[3]) <= 6
    assert 0 < r["regions"][0]["score"] <= 1


def test_unrelated_frames_do_not_align():
    a = view(world(1), 0, 0)
    b = view(world(2), 0, 0)
    r = frame_change(a, b, min_area_px=150)
    assert not r["aligned"]
    assert r["regions"] == []


# ------------------------------------------------------------------ the pipeline


def _png(path: Path, img: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8), "L").convert("RGB").save(path)


def _project(tmp_path: Path, frames, patch=True, b_pos=(0.5, 30, 0.2), line_up=None) -> Path:
    a, b = frames
    _png(tmp_path / "photos" / "a1.png", a)
    _png(tmp_path / "photos" / "b1.png", with_patch(b) if patch else b)
    q = [0.0, 0.0, 0.0, 1.0]
    manifest = {
        "schema": "aio.project/1",
        "id": "synthetic",
        "name": "Synthetic two dates",
        "captures": [
            {"id": "c1", "label": "First", "date": "2026-01-01"},
            {"id": "c2", "label": "Second", "date": "2026-06-01", **({"lineUp": line_up} if line_up else {})},
        ],
        "layers": [
            {
                "kind": "photos",
                "id": "photos-a",
                "name": "Photos A",
                "capture": "c1",
                "items": [{"id": "a1", "src": {"path": "photos/a1.png"}, "pos": [0, 30, 0], "q": q}],
            },
            {
                "kind": "photos",
                "id": "photos-b",
                "name": "Photos B",
                "capture": "c2",
                "items": [{"id": "b1", "src": {"path": "photos/b1.png"}, "pos": list(b_pos), "q": q}],
            },
            {
                "kind": "video",
                "id": "clip-b",
                "name": "Clip B",
                "capture": "c2",
                "src": {"path": "video/b.mp4"},
                "flight": {"src": {"path": "video/b.json"}, "startUtcMs": 0},
                "lens": {"model": "pinhole", "hfovDeg": 70, "aspect": 1.5},
            },
        ],
    }
    (tmp_path / "manifest.json").write_text(json.dumps(manifest), "utf-8")
    return tmp_path


PAIR = {"a": {"layer": "photos-a", "photo": "a1"}, "b": {"layer": "photos-b", "photo": "b1"}}


def test_the_pipeline_writes_draft_detections_and_frame_items(tmp_path, frames):
    project = _project(tmp_path, frames)
    params = {
        "from": "c1",
        "to": "c2",
        "pairs": [PAIR, {"a": PAIR["a"], "b": {"layer": "clip-b", "t": 3.5}}],
        "minAreaPx": 150,
    }
    result, rec = run_job(ChangeFrames(), project, params)
    assert result["status"] == "done"

    det = json.loads((project / "detections" / "change-frames-j1.json").read_text("utf-8"))
    assert det["schema"] == "aio.detections/1"
    assert det["source"] == "model"
    assert det["layer"] == "photos-b"
    assert det["run"]["id"] == "j1"
    [d] = det["detections"]
    assert d["photo"] == "b1"
    assert d["status"] == "draft"
    assert d["label"] == "change"
    assert d["class"] == "change"
    x0, y0, x1, y1 = d["bbox"]
    assert abs(x0 - PATCH[0]) <= 6 and abs(y1 - PATCH[3]) <= 6

    cs = validate_change_set(json.loads((project / "change" / "c1-c2-frames.json").read_text("utf-8")))
    assert cs["producer"] == "change.frames"
    assert (cs["from"], cs["to"]) == ("c1", "c2")
    [item] = cs["items"]
    assert item["kind"] == "frame"
    assert item["verdict"] == "changed"
    assert item["a"] == PAIR["a"] and item["b"] == PAIR["b"]
    assert item["detections"] == [f"change-frames-j1.json#{d['id']}"]
    assert item["poseM"] == pytest.approx(np.hypot(0.5, 0.2))
    assert cs["stats"]["pairs"] == 1
    assert cs["stats"]["skipped"] == 1
    # the video pair is skipped with a reason
    logs = " ".join(m["message"] for m in rec.of("log"))
    assert "video" in logs.lower()
    # the change mask for the review
    assert (project / "change" / "c1-c2-frames" / "b1.png").exists()


def test_a_recompute_keeps_the_review_and_backs_up(tmp_path, frames):
    project = _project(tmp_path, frames)
    params = {"from": "c1", "to": "c2", "pairs": [PAIR], "minAreaPx": 150}
    run_job(ChangeFrames(), project, params, job_id="j1")
    path = project / "change" / "c1-c2-frames.json"
    cs = json.loads(path.read_text("utf-8"))
    cs["items"][0]["review"] = {"status": "confirmed", "by": "Reviewer", "at": "2026-10-06T10:00:00Z"}
    path.write_text(json.dumps(cs), "utf-8")
    run_job(ChangeFrames(), project, params, job_id="j2")
    again = json.loads(path.read_text("utf-8"))
    assert again["items"][0]["review"]["status"] == "confirmed"
    assert (project / "change" / "c1-c2-frames.json.bak").exists()
    assert (project / "detections" / "change-frames-j2.json").exists()


def test_unchanged_pairs_write_unchanged_items_and_no_detections(tmp_path, frames):
    project = _project(tmp_path, frames, patch=False)
    run_job(ChangeFrames(), project, {"from": "c1", "to": "c2", "pairs": [PAIR], "minAreaPx": 150})
    cs = json.loads((project / "change" / "c1-c2-frames.json").read_text("utf-8"))
    assert [i["verdict"] for i in cs["items"]] == ["unchanged"]
    det = json.loads((project / "detections" / "change-frames-j1.json").read_text("utf-8"))
    assert det["detections"] == []


def test_the_dates_alone_pair_photos_by_pose(tmp_path, frames):
    project = _project(tmp_path, frames)
    result, _ = run_job(ChangeFrames(), project, {"from": "c1", "to": "c2", "minAreaPx": 150})
    assert result["status"] == "done"
    cs = json.loads((project / "change" / "c1-c2-frames.json").read_text("utf-8"))
    assert [(i["a"]["photo"], i["b"]["photo"]) for i in cs["items"]] == [("a1", "b1")]
    assert "lineUp" not in cs


def test_the_dates_come_from_the_layers_when_not_given(tmp_path, frames):
    project = _project(tmp_path, frames)
    run_job(ChangeFrames(), project, {"pairs": [PAIR], "minAreaPx": 150})
    assert (project / "change" / "c1-c2-frames.json").exists()


def test_bad_parameters_are_refused():
    p = all_pipelines()["change.frames"]
    with pytest.raises(JobError, match="does not take: bogus"):
        p.validate({"from": "c1", "to": "c2", "bogus": 1})
    with pytest.raises(JobError, match="pairs, or the two dates"):
        p.validate({"from": "c1"})
    with pytest.raises(JobError, match="time or a photo"):
        p.validate({"pairs": [{"a": {"layer": "x"}, "b": {"layer": "y", "photo": "p"}}]})
    with pytest.raises(JobError, match="maxPoseM"):
        p.validate({"from": "c1", "to": "c2", "maxPoseM": -1})


def test_a_missing_photo_file_fails_the_pair_not_the_job(tmp_path, frames):
    project = _project(tmp_path, frames)
    (project / "photos" / "b1.png").unlink()
    result, rec = run_job(ChangeFrames(), project, {"from": "c1", "to": "c2", "pairs": [PAIR]})
    assert result["status"] == "done"
    cs = json.loads((project / "change" / "c1-c2-frames.json").read_text("utf-8"))
    assert cs["items"] == []
    assert cs["stats"]["skipped"] == 1
    assert any("b1" in m["message"] for m in rec.of("log"))


def test_pose_pairs_use_shifted_positions(tmp_path, frames):
    # the second photo is 2 m east and 0.5 m south of the first in its file; its date is lined up
    # (east -2, north +0.5 puts it back: local x - 2, z - 0.5)
    shift = {"eastM": -2.0, "northM": 0.5, "with": "c1", "at": "2026-10-16T00:00:00Z"}
    project = _project(tmp_path, frames, b_pos=(2.0, 30, 0.5), line_up=shift)
    run_job(ChangeFrames(), project, {"from": "c1", "to": "c2", "minAreaPx": 150})
    cs = json.loads((project / "change" / "c1-c2-frames.json").read_text("utf-8"))
    [item] = cs["items"]
    assert (item["a"]["photo"], item["b"]["photo"]) == ("a1", "b1")
    assert item["poseM"] < 0.05
    assert cs["lineUp"] == {"from": {"eastM": 0.0, "northM": 0.0}, "to": {"eastM": -2.0, "northM": 0.5}}


def test_a_line_up_saved_after_the_pairing_stamps_the_shifts_the_pairs_were_made_with(
    tmp_path, frames, monkeypatch
):
    # the photos were paired with no shift; the date is lined up while the frames are compared
    shift = {"eastM": -2.0, "northM": 0.5, "with": "c1", "at": "2026-10-16T00:00:00Z"}
    project = _project(tmp_path, frames)
    compare = ChangeFrames._compare

    def compare_then_line_up(self, ctx):
        out = compare(self, ctx)
        m = json.loads((project / "manifest.json").read_text("utf-8"))
        m["captures"][1]["lineUp"] = shift
        (project / "manifest.json").write_text(json.dumps(m), "utf-8")
        return out

    monkeypatch.setattr(ChangeFrames, "_compare", compare_then_line_up)
    run_job(ChangeFrames(), project, {"from": "c1", "to": "c2", "minAreaPx": 150})
    cs = json.loads((project / "change" / "c1-c2-frames.json").read_text("utf-8"))
    # labelled with the frame the pairs were made in, so the set reads Out of date
    assert "lineUp" not in cs


def test_the_pose_gap_takes_each_layers_local_delta():
    q = [0.0, 0.0, 0.0, 1.0]
    a = {"pos": [0, 30, 0], "q": q}
    b = {"pos": [2, 30, 0.5], "q": q}
    assert pose_gap(a, b)[0] == pytest.approx(np.hypot(2, 0.5))
    assert pose_gap(a, b, (0.0, 0.0), (-2.0, -0.5))[0] == pytest.approx(0.0)


def test_pose_pairs_follow_a_turned_line_up(tmp_path, frames):
    from aio_pipelines.similarity import Similarity

    # the second date is turned 0.5 degrees about a point 100 m west of the photos, then 2 m east;
    # its photo is stored where that line-up puts it back onto the first
    turn = {"rotationDeg": 0.5, "scale": 1.0, "pivotE": -100.0, "pivotN": 0.0}
    sim = Similarity.from_line_up({"eastM": 2.0, "northM": 0.0}, turn)
    x, z = sim.inverse().apply_local(0.0, 0.0, [0, 0, 0])
    shift_only = {"eastM": 2.0, "northM": 0.0, "with": "c1", "at": "2026-10-18T00:00:00Z"}
    project = _project(tmp_path, frames, b_pos=(x, 30, z), line_up=shift_only)
    m = json.loads((project / "manifest.json").read_text("utf-8"))
    m["captures"][1]["lineUpTurn"] = turn
    (project / "manifest.json").write_text(json.dumps(m), "utf-8")
    assert np.hypot(x + 2.0, z) > 0.8  # the shift alone leaves it about 0.9 m away
    run_job(ChangeFrames(), project, {"from": "c1", "to": "c2", "minAreaPx": 150})
    cs = json.loads((project / "change" / "c1-c2-frames.json").read_text("utf-8"))
    [item] = cs["items"]
    assert item["poseM"] < 0.01
    assert cs["lineUp"] == {"from": {"eastM": 0.0, "northM": 0.0}, "to": {"eastM": 2.0, "northM": 0.0}}
    assert cs["lineUpTurn"] == {"to": turn}
