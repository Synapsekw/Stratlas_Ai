"""walk.sfm: equirectangular SfM in chunks, the join, the up direction and the sparse PLY."""

from __future__ import annotations

import itertools
import math
import time
from pathlib import Path

import numpy as np
import pytest

from aio_pipelines.photo.model import qvec_to_rotmat, rotmat_to_qvec
from aio_pipelines.runtime import Cancelled
from aio_pipelines.walk import sfm as S
from walk_equirect_synth import make_stills


def rand_rot(rng: np.random.Generator) -> np.ndarray:
    q = rng.normal(size=4)
    return qvec_to_rotmat(q / np.linalg.norm(q))


def angle_deg(a: np.ndarray, b: np.ndarray) -> float:
    a, b = np.asarray(a, float), np.asarray(b, float)
    c = np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b))
    return math.degrees(math.acos(max(-1.0, min(1.0, c))))


def rot_y(a: float) -> np.ndarray:
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def rot_x(a: float) -> np.ndarray:
    c, s = math.cos(a), math.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


def rot_z(a: float) -> np.ndarray:
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


# ------------------------------------------------------------------------------- umeyama


def test_umeyama_recovers_a_known_similarity_exactly():
    rng = np.random.default_rng(1)
    src = rng.normal(size=(20, 3)) * 5
    R = rand_rot(rng)
    s, t = 2.37, np.array([3.0, -1.5, 8.25])
    dst = s * src @ R.T + t
    s2, R2, t2 = S.umeyama(src, dst)
    assert s2 == pytest.approx(s, abs=1e-10)
    assert np.allclose(R2, R, atol=1e-10)
    assert np.allclose(t2, t, atol=1e-9)
    assert np.linalg.det(R2) == pytest.approx(1.0)


# ------------------------------------------------------------------------------- join


def line_truth(n: int):
    """A straight walk (centres exactly collinear) with turning, nodding cameras."""
    centres = np.array([[0.7 * k, 0.0, 0.0] for k in range(n)])
    rots = [rot_y(0.3 * math.sin(k / 4)) @ rot_x(0.05 * math.cos(k / 3)) for k in range(n)]
    return centres, rots


def model_of(idx: list[int], centres, rots, s: float, R: np.ndarray, t: np.ndarray) -> S.ChunkModel:
    """A chunk model seeing the truth through the similarity x_model = s R x_world + t."""
    poses = {}
    for k in idx:
        R_wc = R @ rots[k]  # camera to model frame
        c = s * R @ centres[k] + t
        R_cw = R_wc.T
        poses[k] = (R_cw, -R_cw @ c)
    pts = np.array([[1.0, 2.0, 3.0], [-1.0, 0.5, 4.0]])
    return S.ChunkModel(poses=poses, points=s * pts @ R.T + t, colors=np.full((2, 3), 7, np.uint8))


def test_two_overlapping_chunks_of_a_camera_line_join_within_1e_6():
    rng = np.random.default_rng(2)
    n = 30
    centres, rots = line_truth(n)
    a = model_of(list(range(0, 18)), centres, rots, 1.0, np.eye(3), np.zeros(3))
    b = model_of(list(range(12, 30)), centres, rots, 0.43, rand_rot(rng), np.array([5.0, 1.0, -2.0]))
    poses, segments, points, colors = S.join_chunks([a, b], n)
    assert segments == 1
    for k in range(n):
        p = poses[k]
        assert p.registered and p.segment == 0
        assert np.allclose(p.pos, centres[k], atol=1e-6)
        assert np.allclose(qvec_to_rotmat(p.q), rots[k], atol=1e-6)
    assert points.shape == (4, 3) and points.dtype == np.float32
    assert np.allclose(points[2:], [[1.0, 2.0, 3.0], [-1.0, 0.5, 4.0]], atol=1e-5)
    assert colors.dtype == np.uint8 and colors.shape == (4, 3)


def test_a_chunk_with_fewer_than_5_shared_registered_stills_starts_a_new_segment():
    rng = np.random.default_rng(3)
    n = 30
    centres, rots = line_truth(n)
    a = model_of(list(range(0, 18)), centres, rots, 1.0, np.eye(3), np.zeros(3))
    # 14..17 are shared (four stills): too few to join
    b_idx = [k for k in range(14, 30)]
    b = model_of(b_idx, centres, rots, 0.5, rand_rot(rng), np.array([1.0, 2.0, 3.0]))
    poses, segments, _, _ = S.join_chunks([a, b], n)
    assert segments == 2
    # numbered largest first: the 18-still segment is 0, the rest (18..29, twelve new stills) is 1
    assert all(poses[k].segment == 0 for k in range(18))
    assert all(poses[k].segment == 1 for k in range(18, 30))


def test_stills_no_model_registered_stay_unregistered():
    n = 12
    centres, rots = line_truth(n)
    a = model_of([0, 1, 2, 4, 5, 6, 7], centres, rots, 1.0, np.eye(3), np.zeros(3))
    poses, segments, _, _ = S.join_chunks([a], n)
    assert segments == 1
    assert [p.n for p in poses] == list(range(n))
    assert not poses[3].registered and poses[3].pos is None and poses[3].q is None
    assert poses[3].segment is None
    assert sum(p.registered for p in poses) == 7


def test_chunk_ranges_cover_every_still_with_the_overlap():
    assert S.chunk_ranges(24, 300, 40) == [(0, 24)]
    assert S.chunk_ranges(320, 300, 40) == [(0, 300), (260, 320)]
    r = S.chunk_ranges(1000, 300, 40)
    assert r[0] == (0, 300) and r[-1][1] == 1000
    assert all(b0 == a1 - 40 for (_, a1), (b0, _) in itertools.pairwise(r))


# ------------------------------------------------------------------------------- up


def walk_cameras(Q: np.ndarray, n: int = 60):
    """Camera-to-SfM rotations of a level walk seen in an SfM frame rotated by Q from the world
    (world y down), with pitch and roll wobbling around zero."""
    world = [
        rot_y(2 * math.pi * k / n) @ rot_x(0.07 * math.sin(k * 1.3)) @ rot_z(0.07 * math.cos(k * 0.9))
        for k in range(n)
    ]
    return world, [rotmat_to_qvec(Q @ R) for R in world]


def test_up_from_cameras_recovers_a_tilted_up_within_half_a_degree():
    Q = rot_x(0.4) @ rot_z(-0.25) @ rot_y(1.0)
    _, qs = walk_cameras(Q)
    up = S.up_from_cameras(qs)
    assert np.linalg.norm(up) == pytest.approx(1.0)
    assert angle_deg(up, Q @ np.array([0.0, -1.0, 0.0])) < 0.5


def test_up_from_gravity_recovers_a_tilted_up_within_half_a_degree():
    rng = np.random.default_rng(4)
    Q = rot_x(-0.5) @ rot_z(0.3)
    world, qs = walk_cameras(Q)
    # gravity (down, world +y) seen in each camera, with a little sensor noise
    grav = [R.T @ np.array([0.0, 9.81, 0.0]) + rng.normal(scale=0.02, size=3) for R in world]
    up = S.up_from_gravity(qs, grav)
    assert np.linalg.norm(up) == pytest.approx(1.0)
    assert angle_deg(up, Q @ np.array([0.0, -1.0, 0.0])) < 0.5


# ------------------------------------------------------------------------------- ply


def test_write_ply_reads_back_with_its_header(tmp_path: Path):
    pts = np.array([[1.5, -2.0, 3.25], [0.0, 0.0, 0.0], [10.0, 20.0, 30.0]], np.float32)
    cols = np.array([[255, 0, 1], [2, 3, 4], [9, 8, 7]], np.uint8)
    out = tmp_path / "sparse.ply"
    S.write_ply(out, pts, cols)
    raw = out.read_bytes()
    head, body = raw.split(b"end_header\n", 1)
    text = head.decode("ascii")
    assert text.startswith("ply\nformat binary_little_endian 1.0\n")
    assert "element vertex 3\n" in text
    for prop in ("float x", "float y", "float z", "uchar red", "uchar green", "uchar blue"):
        assert f"property {prop}\n" in text
    rec = np.frombuffer(
        body, dtype=[("x", "<f4"), ("y", "<f4"), ("z", "<f4"), ("r", "u1"), ("g", "u1"), ("b", "u1")]
    )
    assert len(rec) == 3
    assert np.allclose(np.stack([rec["x"], rec["y"], rec["z"]], 1), pts)
    assert np.array_equal(np.stack([rec["r"], rec["g"], rec["b"]], 1), cols)


def test_write_ply_with_no_points(tmp_path: Path):
    out = tmp_path / "empty.ply"
    S.write_ply(out, np.zeros((0, 3), np.float32), np.zeros((0, 3), np.uint8))
    assert b"element vertex 0\n" in out.read_bytes()


# ------------------------------------------------------------------------------- retry (no COLMAP)


def fake_stages(monkeypatch, fail_maps: int):
    """``_Stages.run`` replaced: features pass, the first ``fail_maps`` map runs fail, later ones
    write a model where every still of the chunk is registered on a line."""
    calls: list[str] = []

    def run(self, stage, req, progress):
        calls.append(stage)
        progress(1.0)
        if req["op"] == "features":
            return {"images": len(req["names"])}
        if sum(c.startswith("map") for c in calls) <= fail_maps:
            raise S.JobError("COLMAP stopped during map (exit 3221225477).")
        out = Path(req["out"])
        out.mkdir(parents=True, exist_ok=True)
        k = len(req["names"])
        R = np.repeat(np.eye(3)[None], k, 0)
        t = np.array([[-0.5 * i, 0.1 * i * i, 0.0] for i in range(k)])
        np.savez(
            out / "model-0.npz",
            img_names=np.array(req["names"]),
            img_R=R,
            img_t=t,
            xyz=np.zeros((1, 3)),
            rgb=np.zeros((1, 3), np.uint8),
        )
        return {"models": [{"path": str(out / "model-0.npz")}]}

    monkeypatch.setattr(S._Stages, "run", run)
    return calls


def tiny_stills(folder: Path, n: int = 8) -> list[Path]:
    from PIL import Image

    folder.mkdir(parents=True, exist_ok=True)
    out = []
    for k in range(n):
        p = folder / f"still_{k:04d}.jpg"
        Image.fromarray(np.full((32, 64, 3), 100, np.uint8)).save(p)
        out.append(p)
    return out


def test_a_failed_mapper_run_is_retried_once(monkeypatch, tmp_path: Path):
    calls = fake_stages(monkeypatch, fail_maps=1)
    res = S.run_sfm(
        tiny_stills(tmp_path / "s"),
        tmp_path / "w",
        mask_bottom=0.25,
        chunk=300,
        gravity=None,
        check=lambda: None,
        progress=lambda f: None,
    )
    assert calls == ["features", "map-000", "map-000-retry"]
    assert res.registered_fraction == 1.0 and res.segments == 1


def test_a_mapper_that_fails_twice_raises(monkeypatch, tmp_path: Path):
    calls = fake_stages(monkeypatch, fail_maps=2)
    with pytest.raises(S.JobError, match="failed twice"):
        S.run_sfm(
            tiny_stills(tmp_path / "s"),
            tmp_path / "w",
            mask_bottom=0.25,
            chunk=300,
            gravity=None,
            check=lambda: None,
            progress=lambda f: None,
        )
    assert calls == ["features", "map-000", "map-000-retry"]


def test_stills_that_do_not_sort_in_walk_order_are_refused(tmp_path: Path):
    paths = tiny_stills(tmp_path / "s", 3)
    with pytest.raises(S.JobError, match="walk order"):
        S.run_sfm(
            [paths[1], paths[0], paths[2]],
            tmp_path / "w",
            mask_bottom=0.25,
            chunk=300,
            gravity=None,
            check=lambda: None,
            progress=lambda f: None,
        )


# ------------------------------------------------------------------------------- run_sfm (real COLMAP)


@pytest.fixture(scope="module")
def stills24(tmp_path_factory):
    folder = tmp_path_factory.mktemp("walk-sfm") / "stills"
    return make_stills(folder, n=24)


def test_run_sfm_registers_rendered_equirect_stills(stills24, tmp_path: Path):
    paths, centres, rots = stills24
    grav = [R.T @ np.array([0.0, 1.0, 0.0]) for R in rots]
    seen: list[float] = []
    t0 = time.monotonic()
    res = S.run_sfm(
        paths,
        tmp_path / "work",
        mask_bottom=0.25,
        chunk=300,
        gravity=grav,
        check=lambda: None,
        progress=seen.append,
    )
    took = time.monotonic() - t0
    assert took < 120
    assert len(res.poses) == 24
    assert res.registered_fraction >= 0.9
    assert res.segments == 1
    assert res.points.shape[1] == 3 and len(res.points) > 500 and res.points.dtype == np.float32
    assert res.colors.shape == res.points.shape and res.colors.dtype == np.uint8
    assert seen and seen[-1] == pytest.approx(1.0) and all(0.0 <= f <= 1.0 for f in seen)
    assert all(b >= a - 1e-9 for a, b in itertools.pairwise(seen))
    assert {"features", "map", "total"} <= set(res.timings)
    # the path has the true shape: a similarity takes the truth onto it within a few centimetres
    reg = [p for p in res.poses if p.registered]
    src = np.array([centres[p.n] for p in reg])
    dst = np.array([p.pos for p in reg])
    s, R, t = S.umeyama(src, dst)
    resid = np.linalg.norm(s * src @ R.T + t - dst, axis=1) / s
    assert resid.max() < 0.05
    # up: from gravity, and from the cameras alone, both near the true up in the SfM frame
    true_up = R @ np.array([0.0, -1.0, 0.0])
    assert res.up is not None and angle_deg(res.up, true_up) < 1.0
    assert angle_deg(S.up_from_cameras([np.array(p.q) for p in reg]), true_up) < 3.0
    # the masks follow COLMAP's convention: <image name>.png, the bottom quarter black
    from PIL import Image

    m = np.asarray(Image.open(tmp_path / "work" / "masks" / f"{paths[0].name}.png"))
    assert m.shape == (512, 1024)
    assert (m[: 384 - 1] == 255).all() and (m[384:] == 0).all()


def test_run_sfm_stops_when_cancelled(stills24, tmp_path: Path):
    paths, _, _ = stills24
    t0 = time.monotonic()
    calls = {"n": 0}

    def check():
        calls["n"] += 1
        if time.monotonic() - t0 > 1.0:
            raise Cancelled()

    with pytest.raises(Cancelled):
        S.run_sfm(
            paths,
            tmp_path / "work",
            mask_bottom=0.25,
            chunk=300,
            gravity=None,
            check=check,
            progress=lambda f: None,
        )
    assert time.monotonic() - t0 < 10
    assert calls["n"] > 3
