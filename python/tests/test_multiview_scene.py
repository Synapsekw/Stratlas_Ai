"""The multi-view vote on a synthetic native project: posed photos around a 20 m stack mesh."""

from __future__ import annotations

import json

import numpy as np
import pytest

from aio_pipelines.multiview import scene as S
from test_inspection import AXIS, CAMS, EAST_SPOT, NORTH_TOP, RADIUS, box_at, native_project


class Ctx:
    def __init__(self, project):
        self.project = project
        self.logs: list[tuple[str, str]] = []

    def log(self, msg, level="info"):
        self.logs.append((level, msg))


def draft(ident, photo, bbox, score=0.9, cls="corrosion"):
    return {"id": ident, "photo": photo, "class": cls, "severity": "uncertain", "confidence": score,
            "status": "draft", "bbox": bbox, "space": "preview", "origin": {"threshold": 0.8}}  # fmt: skip


def test_cameras_are_the_posed_photos(tmp_path):
    native_project(tmp_path)
    manifest = json.loads((tmp_path / "manifest.json").read_text())
    cams = S.cameras(tmp_path, manifest, "photos")
    assert sorted(cams) == sorted(CAMS)  # "nogps" has no pose
    uv, ok = cams["e1"].project(np.array([EAST_SPOT]))
    assert ok[0]
    b = box_at("e1", EAST_SPOT)
    assert uv[0] == pytest.approx([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2], abs=1.0)


def test_drafts_of_one_spot_from_two_photos_become_one_on_the_mesh(tmp_path):
    native_project(tmp_path)
    dets = [
        draft("a", "e1", box_at("e1", EAST_SPOT), 0.9),
        draft("b", "e2", box_at("e2", EAST_SPOT), 0.85),
        draft("c", "n1", box_at("n1", NORTH_TOP), 0.9, cls="crack"),
    ]
    ctx = Ctx(tmp_path)
    out, stats = S.vote_pass(ctx, "photos", dets)
    assert stats is not None and stats["placedOn"] == "mesh"
    assert [d["id"] for d in out] == ["a", "c"]
    a = out[0]
    assert a["vote"]["views"] == 2
    # the west photo looks at the stack but the spot is on its far side: it does not count
    assert a["vote"]["seenBy"] == 2
    assert a["vote"]["sightings"] == [{"photo": "e2", "bbox": dets[1]["bbox"], "confidence": 0.85, "id": "b"}]
    p = np.array(a["vote"]["point"])
    assert np.hypot(p[0] - AXIS[0], p[2] - AXIS[1]) == pytest.approx(RADIUS, abs=0.1)
    assert p[1] == pytest.approx(10.0, abs=0.3)
    crack = out[1]
    assert crack["vote"]["views"] == 1
    assert any("Multi-view vote on the mesh" in m for _, m in ctx.logs)


def test_without_a_mesh_the_rays_are_triangulated(tmp_path):
    native_project(tmp_path)
    m = json.loads((tmp_path / "manifest.json").read_text())
    m["layers"] = [layer for layer in m["layers"] if layer["kind"] != "mesh"]
    (tmp_path / "manifest.json").write_text(json.dumps(m))
    dets = [draft("a", "e1", box_at("e1", EAST_SPOT)), draft("b", "e2", box_at("e2", EAST_SPOT))]
    out, stats = S.vote_pass(Ctx(tmp_path), "photos", dets)
    assert stats["placedOn"] == "rays"
    assert len(out) == 1 and out[0]["vote"]["views"] == 2
    assert out[0]["vote"]["point"] == pytest.approx(EAST_SPOT, abs=0.2)


def test_a_cloud_surface_places_like_the_mesh():
    # a wall of points at x = 5 facing a camera at the origin
    ys, zs = np.meshgrid(np.linspace(-3, 3, 121), np.linspace(-3, 3, 121))
    pts = np.column_stack([np.full(ys.size, 5.0), ys.ravel(), zs.ravel()])
    surf = S.CloudSurface(pts)
    assert surf.spacing == pytest.approx(0.05, abs=0.01)
    hit = surf.hit(np.array([[0.0, 0.0, 0.0]]), np.array([[1.0, 0.0, 0.0]]))[0]
    assert hit[0] == pytest.approx(5.0, abs=0.01)
    miss = surf.hit(np.array([[0.0, 0.0, 0.0]]), np.array([[-1.0, 0.0, 0.0]]))[0]
    assert np.isnan(miss[0])
    assert surf.visible(np.array([0.0, 0, 0]), np.array([5.0, 0, 0]))
    assert not surf.visible(np.array([0.0, 0, 0]), np.array([9.0, 0, 0]))


def test_one_posed_photo_runs_no_vote(tmp_path):
    native_project(tmp_path)
    dets = [draft("a", "e1", box_at("e1", EAST_SPOT)), draft("x", "nogps", [1, 1, 9, 9])]
    out, stats = S.vote_pass(Ctx(tmp_path), "photos", dets)
    assert stats is None and out == dets


def test_a_failure_leaves_the_drafts_and_warns(tmp_path):
    ctx = Ctx(tmp_path)  # no manifest at all
    dets = [draft("a", "e1", [1, 1, 9, 9])]
    out, stats = S.vote_pass(ctx, "photos", dets)
    assert out == dets and stats is None
    assert ctx.logs[-1][0] == "warn" and "vote was skipped" in ctx.logs[-1][1]


def test_radius_follows_object_size():
    of = S.radius_for({"big": {"objectSizeM": 2.0}, "small": {"objectSizeM": 0.1}})
    assert of({"origin": {"detectorId": "big"}}) == 2.0
    assert of({"origin": {"detectorId": "small"}}) == 0.5
    assert of({}) == 0.5
