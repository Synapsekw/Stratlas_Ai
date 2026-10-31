"""Multi-view vote maths (``multiview/vote.py``) on synthetic cameras and a flat ground surface."""

from __future__ import annotations

import math

import numpy as np
import pytest

from aio_pipelines.multiview import vote as V

W, H = 1000, 750


class Ground:
    """The plane y = 0 as a surface (rays hit it; nothing occludes)."""

    kind = "mesh"

    def hit(self, org, D):
        org, D = np.asarray(org, float), np.asarray(D, float)
        out = np.full(org.shape, np.nan)
        with np.errstate(divide="ignore", invalid="ignore"):
            t = -org[:, 1] / D[:, 1]
        ok = t > 0
        out[ok] = org[ok] + D[ok] * t[ok, None]
        return out

    def visible_many(self, cam_pos, points):
        return np.ones(len(points), bool)


def ring_cameras(n=5, radius=12.0, height=10.0, target=(0.0, 0.0, 0.0)):
    cams = {}
    for i in range(n):
        a = 2 * math.pi * i / n
        pos = (radius * math.cos(a), height, radius * math.sin(a))
        cams[f"p{i}"] = V.Camera.look_at(pos, target, 60.0, W, H)
    return cams


def box_around(cam, point, half=12.0, jitter=(0.0, 0.0)):
    uv, ok = cam.project(np.array([point], float))
    assert ok[0], "the test point must be in the frame"
    u, v = uv[0] + np.array(jitter)
    return [u - half, v - half, u + half, v + half]


def draft(photo, bbox, score, cls="rust", ident=None, threshold=0.8):
    return {
        "id": ident or f"{photo}-{cls}-{round(bbox[0])}",
        "photo": photo,
        "class": cls,
        "severity": "uncertain",
        "confidence": score,
        "status": "draft",
        "bbox": [round(v, 1) for v in bbox],
        "space": "preview",
        "origin": {"threshold": threshold},
    }


OBJECTS = [(-2.0, 0.0, 1.0), (2.5, 0.0, -1.5), (0.5, 0.0, 3.0)]


def test_camera_projects_and_casts_back():
    cam = ring_cameras()["p0"]
    uv, ok = cam.project(np.array([[0.0, 0.0, 0.0]]))
    assert ok[0]
    assert uv[0] == pytest.approx([W / 2 - 0.5, H / 2 - 0.5], abs=1e-6)  # pixel centres
    org, D = cam.rays(np.array([uv[0][0]]), np.array([uv[0][1]]))
    hit = Ground().hit(org, D)[0]
    assert hit == pytest.approx([0, 0, 0], abs=1e-6)
    # behind the camera: not in the frame
    _, ok = cam.project(np.array([[30.0, 10.0, 0.0]]))
    assert not ok[0]


def test_camera_from_pose_matches_look_at():
    # a camera at (0, 10, 0) looking straight down, image up = north (-z)
    q = [-math.sin(math.pi / 4), 0.0, 0.0, math.cos(math.pi / 4)]  # -90 deg about x
    cam = V.Camera.from_pose([0.0, 10.0, 0.0], q, 60.0, W, H)
    uv, ok = cam.project(np.array([[0.0, 0.0, -2.0]]))
    assert ok[0]
    assert uv[0][0] == pytest.approx(W / 2, abs=0.5)
    assert uv[0][1] < H / 2  # north is up in the image


def test_three_objects_in_five_views_give_three_drafts():
    cams = ring_cameras()
    rng = np.random.default_rng(1)
    dets = []
    for k, obj in enumerate(OBJECTS):
        for pid, cam in cams.items():
            dets.append(
                draft(pid, box_around(cam, obj, jitter=rng.normal(0, 3, 2)), 0.9, ident=f"o{k}-{pid}")
            )
    out, stats = V.vote(dets, cams, Ground())
    assert len(out) == 3
    for d in out:
        assert d["vote"]["views"] == 5
        assert d["vote"]["seenBy"] == 5
        assert "singleView" not in d["vote"]
        assert len(d["vote"]["sightings"]) == 4
        assert d["vote"]["placedOn"] == "mesh"
        assert d["confidence"] == pytest.approx(1 - 0.1**5, abs=1e-4)  # five agreeing views
        assert "belowThreshold" not in d
    assert stats["clusters"] == 3
    assert stats["merged"] == 12


def test_lone_box_seen_by_five_is_kept_and_flagged():
    cams = ring_cameras()
    dets = [draft(pid, box_around(cam, OBJECTS[0]), 0.9, ident=f"o-{pid}") for pid, cam in cams.items()]
    lone = draft("p2", box_around(cams["p2"], (3.0, 0.0, 3.0)), 0.95, ident="lone")
    out, stats = V.vote([*dets, lone], cams, Ground())
    assert len(out) == 2
    flagged = next(d for d in out if d["id"] == "lone")
    assert flagged["vote"]["views"] == 1
    assert flagged["vote"]["seenBy"] == 5
    assert flagged["vote"]["singleView"] is True
    assert flagged["vote"]["score"] == 0.95
    # 0.95 x (0.7 + 0.3 x 1/5) = 0.722: under the detector's 0.8
    assert flagged["confidence"] == pytest.approx(0.722, abs=1e-4)
    assert flagged["belowThreshold"] is True
    assert stats["singleView"] == 1


def test_object_seen_by_one_photo_only_is_not_flagged():
    cams = {"a": ring_cameras()["p0"]}
    out, _ = V.vote([draft("a", box_around(cams["a"], OBJECTS[0]), 0.9)], cams, Ground())
    assert out[0]["vote"] == {
        "views": 1,
        "seenBy": 1,
        "score": 0.9,
        "point": out[0]["vote"]["point"],
        "placedOn": "mesh",
    }
    assert out[0]["confidence"] == pytest.approx(0.9)


def test_classes_at_one_point_stay_apart():
    cams = ring_cameras(3)
    dets = []
    for pid, cam in cams.items():
        dets.append(draft(pid, box_around(cam, OBJECTS[0]), 0.9, cls="rust", ident=f"r-{pid}"))
        dets.append(draft(pid, box_around(cam, OBJECTS[0]), 0.9, cls="crack", ident=f"c-{pid}"))
    out, _ = V.vote(dets, cams, Ground())
    assert sorted(d["class"] for d in out) == ["crack", "rust"]
    assert all(d["vote"]["views"] == 3 for d in out)


def test_a_photo_never_votes_twice_in_one_cluster():
    cams = ring_cameras(3)
    dets = [draft(pid, box_around(cam, OBJECTS[0]), 0.9, ident=f"a-{pid}") for pid, cam in cams.items()]
    dets.append(draft("p0", box_around(cams["p0"], OBJECTS[0], jitter=(2, 2)), 0.6, ident="dup"))
    out, _ = V.vote(dets, cams, Ground())
    assert len(out) == 2
    main = next(d for d in out if d["vote"]["views"] == 3)
    assert "dup" not in [s.get("id") for s in main["vote"]["sightings"]]


def test_best_scored_member_stands_for_the_cluster():
    cams = ring_cameras(3)
    scores = {"p0": 0.7, "p1": 0.95, "p2": 0.8}
    dets = [draft(pid, box_around(cam, OBJECTS[1]), scores[pid], ident=pid) for pid, cam in cams.items()]
    out, _ = V.vote(dets, cams, Ground())
    assert len(out) == 1
    assert out[0]["id"] == "p1"
    assert out[0]["vote"]["score"] == 0.95
    assert out[0]["confidence"] == pytest.approx(1 - 0.3 * 0.05 * 0.2, abs=1e-4)
    assert {s["photo"] for s in out[0]["vote"]["sightings"]} == {"p0", "p2"}


def test_unplaceable_drafts_pass_through_untouched():
    cams = ring_cameras(2)
    no_pose = draft("other", [10, 10, 20, 20], 0.9, ident="np")
    sheet = {**draft("p0", [1, 1, 5, 5], 0.9, ident="sh"), "space": "sheet", "sheet": "sheet-00"}
    del sheet["photo"]
    sky = draft("p0", [0, 0, 10, 10], 0.9, ident="sky")  # top-left corner looks over the ground
    out, stats = V.vote([no_pose, sheet], cams, Ground())
    assert out == [no_pose, sheet]
    assert stats["unplaced"] == 2
    up = V.Camera.look_at((0, 1, 0), (0, 5, -10), 60.0, W, H)  # looks above the horizon
    out, stats = V.vote([sky], {"p0": up}, Ground())
    assert out == [sky]


def test_source_boxes_are_scaled_to_the_camera_frame():
    cams = ring_cameras(3)
    dets = []
    for pid, cam in cams.items():
        b = box_around(cam, OBJECTS[2])
        dets.append(
            {
                **draft(pid, [v * 4 for v in b], 0.9, ident=pid),
                "space": "source",
                "width": W * 4,
                "height": H * 4,
            }
        )
    out, _ = V.vote(dets, cams, Ground())
    assert len(out) == 1 and out[0]["vote"]["views"] == 3
    assert out[0]["vote"]["point"] == pytest.approx(list(OBJECTS[2]), abs=0.05)


def test_rays_triangulate_without_a_surface():
    cams = ring_cameras()
    dets = [draft(pid, box_around(cam, OBJECTS[0]), 0.9, ident=pid) for pid, cam in cams.items()]
    dets.append(draft("p3", box_around(cams["p3"], (3.0, 0.0, 3.0)), 0.9, ident="lone"))
    out, stats = V.vote(dets, cams, None)
    assert len(out) == 2
    main = next(d for d in out if d["vote"]["views"] == 5)
    assert main["vote"]["placedOn"] == "rays"
    assert main["vote"]["point"] == pytest.approx(list(OBJECTS[0]), abs=0.1)
    lone = next(d for d in out if d["id"] == "lone")
    assert lone["vote"]["views"] == 1
    assert lone["vote"].get("singleView") is True  # placed at the scene's median depth
    assert stats["placedOn"] == "rays"


def test_unscored_cluster_keeps_no_confidence():
    cams = ring_cameras(2)
    dets = []
    for pid, cam in cams.items():
        d = draft(pid, box_around(cam, OBJECTS[0]), 0.9, ident=pid)
        del d["confidence"]
        d["unscored"] = True
        dets.append(d)
    out, _ = V.vote(dets, cams, Ground())
    assert len(out) == 1
    assert "confidence" not in out[0]
    assert "score" not in out[0]["vote"]


def test_radius_follows_the_detector_size():
    cams = ring_cameras(2)
    a = draft("p0", box_around(cams["p0"], (0.0, 0.0, 0.0)), 0.9, ident="a")
    b = draft("p1", box_around(cams["p1"], (0.9, 0.0, 0.0)), 0.9, ident="b")
    out, _ = V.vote([a, b], cams, Ground())
    assert len(out) == 2  # 0.9 m apart: two objects at the default 0.5 m
    out, _ = V.vote([a, b], cams, Ground(), radius_of=lambda d: 1.5)
    assert len(out) == 1


# ------------------------------------------------------------------------- review fixes


def test_seen_by_counts_only_the_photos_the_run_looked_at():
    # the detector ran on p0 and p1 of five photos that all see the spot
    cams = ring_cameras()
    d = draft("p0", box_around(cams["p0"], OBJECTS[0]), 0.9, ident="a")
    out, _ = V.vote([d], cams, Ground(), assessed={"rust": ["p0", "p1"]})
    assert out[0]["vote"]["seenBy"] == 2 and out[0]["vote"]["singleView"] is True
    # run on p0 alone: nothing else looked, so nothing disagrees
    out, _ = V.vote([d], cams, Ground(), assessed={"rust": ["p0"]})
    assert out[0]["vote"]["seenBy"] == 1 and "singleView" not in out[0]["vote"]
    assert out[0]["confidence"] == pytest.approx(0.9)
    # a flat list counts for every class; another class's photos do not count
    out, _ = V.vote([d], cams, Ground(), assessed=["p0", "p3"])
    assert out[0]["vote"]["seenBy"] == 2
    out, _ = V.vote([d], cams, Ground(), assessed={"crack": list(cams)})
    assert out[0]["vote"]["seenBy"] == 1


def test_a_guessed_depth_never_joins_another_draft():
    # two photos side by side looking straight down: their rays are parallel and never cross, so
    # neither has a place; at the median depth of the placed ones they would sit 0.3 m apart
    cams = ring_cameras()
    down = [-math.sin(math.pi / 4), 0.0, 0.0, math.cos(math.pi / 4)]
    cams["a"] = V.Camera.from_pose([30.0, 10.0, 0.0], down, 60.0, W, H)
    cams["b"] = V.Camera.from_pose([30.3, 10.0, 0.0], down, 60.0, W, H)
    centre = [W / 2 - 1, H / 2 - 1, W / 2 + 1, H / 2 + 1]
    dets = [draft(pid, box_around(cam, OBJECTS[0]), 0.9, ident=pid) for pid, cam in ring_cameras().items()]
    dets += [draft("a", centre, 0.9, ident="ga"), draft("b", centre, 0.8, ident="gb")]
    out, stats = V.vote(dets, cams, None)
    ids = {d["id"] for d in out}
    assert {"ga", "gb"} <= ids
    ga = next(d for d in out if d["id"] == "ga")
    assert ga["vote"]["views"] == 1 and "point" not in ga["vote"]
    assert stats["guessed"] == 2


def test_sightings_keep_their_own_space_note_and_fields():
    cams = ring_cameras(3)
    fields = [{"key": "delta_c", "label": "ΔT", "type": "number", "value": 12.0, "unit": "°C"}]
    dets = []
    for k, (pid, cam) in enumerate(cams.items()):
        b = box_around(cam, OBJECTS[0])
        d = {**draft(pid, [v * 2 for v in b], 0.9 - 0.1 * k, ident=pid), "space": "source",
             "width": W * 2, "height": H * 2, "note": f"note {pid}", "fields": fields}  # fmt: skip
        dets.append(d)
    out, _ = V.vote(dets, cams, Ground())
    s = out[0]["vote"]["sightings"][0]
    assert s["photo"] == "p1" and s["space"] == "source" and (s["width"], s["height"]) == (W * 2, H * 2)
    assert s["note"] == "note p1" and s["fields"] == fields


def test_sightings_past_the_cap_are_counted(monkeypatch):
    monkeypatch.setattr(V, "MAX_SIGHTINGS", 2)
    cams = ring_cameras(5)
    dets = [draft(pid, box_around(cam, OBJECTS[0]), 0.9, ident=pid) for pid, cam in cams.items()]
    out, _ = V.vote(dets, cams, Ground())
    v = out[0]["vote"]
    assert v["views"] == 5 and len(v["sightings"]) == 2 and v["sightingsOmitted"] == 2


def test_rank_of_picks_the_member_that_stands_for_the_cluster():
    cams = ring_cameras(3)
    delta = {"p0": 10.0, "p1": 30.0, "p2": 20.0}
    dets = []
    for pid, cam in cams.items():
        d = draft(pid, box_around(cam, OBJECTS[0]), 0.9, ident=pid)
        del d["confidence"]
        d["fields"] = [{"key": "delta_c", "label": "ΔT", "type": "number", "value": delta[pid], "unit": "°C"}]
        dets.append(d)
    out, _ = V.vote(dets, cams, Ground(), rank_of=lambda d: d["fields"][0]["value"])
    assert len(out) == 1 and out[0]["id"] == "p1"  # the highest ΔT is reported, never a lower one


def test_a_new_draft_on_a_reviewed_object_is_dropped_and_on_a_kept_draft_joins_it():
    cams = ring_cameras(3)
    reviewed = {**draft("p0", box_around(cams["p0"], OBJECTS[0]), 0.9, ident="r"), "status": "accepted"}
    kept = draft("p0", box_around(cams["p0"], OBJECTS[1]), 0.9, ident="k")
    fresh = [
        draft("p1", box_around(cams["p1"], OBJECTS[0]), 0.9, ident="n0"),
        draft("p1", box_around(cams["p1"], OBJECTS[1]), 0.9, ident="n1"),
        draft("p2", box_around(cams["p2"], OBJECTS[2]), 0.9, ident="n2"),
    ]
    kind = {"r": "reviewed", "k": "kept"}
    out, stats = V.vote([reviewed, kept, *fresh], cams, Ground(), fixed=lambda d: kind.get(d["id"]))
    by = {d["id"]: d for d in out}
    assert set(by) == {"r", "k", "n2"}
    assert by["r"] == reviewed  # a reviewed detection is never changed
    assert by["k"]["vote"]["views"] == 2 and by["k"]["vote"]["sightings"][0]["id"] == "n1"
    assert stats["droppedOnReviewed"] == 1 and stats["addedToKept"] == 1


def test_a_cancel_stops_the_vote():
    cams = ring_cameras()
    dets = [draft(pid, box_around(cam, OBJECTS[0]), 0.9, ident=pid) for pid, cam in cams.items()]

    class Stop(Exception):
        pass

    def check():
        raise Stop

    for surface in (Ground(), None):
        with pytest.raises(Stop):
            V.vote(dets, cams, surface, check=check)


def test_two_thousand_photos_of_thirty_drafts_vote_in_bounded_time():
    import time

    rng = np.random.default_rng(3)
    down = [-math.sin(math.pi / 4), 0.0, 0.0, math.cos(math.pi / 4)]
    cams, dets = {}, []
    objects = np.column_stack([rng.uniform(-400, 400, 8000), np.zeros(8000), rng.uniform(-300, 300, 8000)])
    for i in range(50):
        for j in range(40):
            pid = f"c{i}-{j}"
            cam = V.Camera.from_pose([-400 + i * 16.3, 40.0, -300 + j * 15.4], down, 70.0, W, H)
            cams[pid] = cam
            uv, ok = cam.project(objects, margin=0.0)
            seen = np.flatnonzero(ok)[:30]
            for k in seen:
                u, v = uv[k]
                dets.append(
                    draft(pid, [u - 6, v - 6, u + 6, v + 6], float(rng.uniform(0.5, 1)), ident=f"{pid}-{k}")
                )
    assert len(cams) == 2000 and len(dets) > 40_000
    for surface in (Ground(), None):
        t = time.perf_counter()
        out, stats = V.vote(dets, cams, surface)
        took = time.perf_counter() - t
        print(f"{stats['placedOn']}: {len(dets)} drafts -> {len(out)} in {took:.1f} s")
        assert took < 120
        assert stats["clusters"] < len(dets) / 3
