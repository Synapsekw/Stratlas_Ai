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

        self.checks = 0

    def log(self, msg, level="info"):
        self.logs.append((level, msg))

    def check(self):
        self.checks += 1

    def progress(self, fraction, message=None):
        pass


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
    assert a["vote"]["sightings"] == [
        {"photo": "e2", "bbox": dets[1]["bbox"], "space": "preview", "confidence": 0.85, "id": "b"}
    ]
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
    seen = surf.visible_many(np.array([0.0, 0, 0]), np.array([[5.0, 0, 0], [9.0, 0, 0], [-4.0, 0, 0]]))
    assert seen.tolist() == [True, False, True]


def test_the_vote_surface_leaves_out_clouds_of_a_space_with_its_own_coordinates(monkeypatch, tmp_path):
    # the photos are placed in the project's frame: a cloud of a local space would sit 0 m from
    # the project origin, so it is left out (logged), never mixed in
    from types import SimpleNamespace

    import aio_pipelines.change.derived as D
    import aio_pipelines.tiles.cloud as TC

    site = np.array([[500005.0, 3200000.0, 10.0]] * 4) + np.arange(4)[:, None] * 0.1
    inside = np.array([[1.0, 2.0, 3.0]] * 4)
    files = {"site": site, "inside": inside}
    monkeypatch.setattr(D, "layer_file", lambda project, layer: layer["id"])
    monkeypatch.setattr(TC, "read_points", lambda ctx, path, off, shift: (files[path], None, None))
    logs = []
    ctx = SimpleNamespace(project=tmp_path, log=lambda msg, level="info": logs.append(msg))
    manifest = {
        "crs": {"epsg": 32639},
        "origin": [500000.0, 3200000.0, 0.0],
        "spaces": [{"id": "tank", "name": "Tank", "crs": {"local": "flyability"}, "origin": [0, 0, 0]}],
        "layers": [
            {"id": "site", "name": "Site", "kind": "pointcloud"},
            {"id": "inside", "name": "Inside", "kind": "pointcloud", "space": "tank"},
        ],
    }
    surf = S.cloud_surface(ctx, manifest)
    assert surf is not None and len(surf.points) == 4
    assert surf.points[:, 0].min() == pytest.approx(5.0)
    assert any('"Inside"' in m for m in logs)


def test_a_long_ray_through_a_wide_cloud_does_not_step_over_the_surface():
    # a wall at x = 5.2 and a far point cluster stretch the cloud 2 km: the ray takes long steps
    ys, zs = np.meshgrid(np.linspace(-3, 3, 121), np.linspace(-3, 3, 121))
    wall = np.column_stack([np.full(ys.size, 5.2), ys.ravel(), zs.ravel()])
    far = np.array([[2000.0, 0.0, 0.0], [2000.0, 0.05, 0.0]])
    surf = S.CloudSurface(np.vstack([wall, far]), spacing=0.05)
    hit = surf.hit(np.array([[0.0, 0.0, 0.0]]), np.array([[1.0, 0.0, 0.0]]))[0]
    assert hit[0] == pytest.approx(5.2, abs=1.0)
    # a point behind the wall is hidden, whatever the step
    assert surf.visible_many(np.array([0.0, 0, 0]), np.array([[1500.0, 0, 0]])).tolist() == [False]


def test_a_cancel_inside_the_vote_cancels_the_job(tmp_path):
    from aio_pipelines.runtime import Cancelled

    native_project(tmp_path)
    ctx = Ctx(tmp_path)

    def stop():
        raise Cancelled()

    ctx.check = stop
    dets = [draft("a", "e1", box_at("e1", EAST_SPOT)), draft("b", "e2", box_at("e2", EAST_SPOT))]
    with pytest.raises(Cancelled):
        S.vote_pass(ctx, "photos", dets)


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
