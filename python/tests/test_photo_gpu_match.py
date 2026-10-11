"""photo/gpu_match.py: pair matching on an array library, written into COLMAP's database. The
tests run it on numpy; with ``AIO_TEST_ADDON`` naming a built GPU add-on on a computer with an
NVIDIA card the matcher also runs on the card, and with a COLMAP engine installed a whole
alignment runs with the card's matcher path (on numpy) against COLMAP's own."""

from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path

import numpy as np
import pytest

from aio_pipelines.photo import gpu_match as G
from aio_pipelines.photo.align import PhotoAlign
from aio_pipelines.photo.colmap_io import ColmapEngine, engine_alias
from aio_pipelines.runtime import JobError
from conftest import run_job

REAL = os.environ.get("AIO_TEST_ADDON")


def _sift(rng, n: int) -> np.ndarray:
    """Descriptors as COLMAP stores them: non-negative unit vectors times 512, as bytes."""
    d = rng.random((n, 128)) ** 3
    d = d / np.linalg.norm(d, axis=1, keepdims=True) * 512
    return np.clip(np.round(d), 0, 255).astype(np.uint8)


def _two_photos(seed: int = 3, shared: int = 300, only_a: int = 150, only_b: int = 220):
    """Two descriptor sets that share ``shared`` features (with a little noise) in shuffled order."""
    rng = np.random.default_rng(seed)
    base = _sift(rng, shared)
    noisy = np.clip(base.astype(np.int16) + rng.integers(-3, 4, base.shape), 0, 255).astype(np.uint8)
    a = np.concatenate([base, _sift(rng, only_a)])
    b = np.concatenate([noisy, _sift(rng, only_b)])
    pa, pb = rng.permutation(len(a)), rng.permutation(len(b))
    return a[pa], b[pb]


def _reference(a: np.ndarray, b: np.ndarray, ratio=G.RATIO, max_distance=G.MAX_DISTANCE) -> np.ndarray:
    """COLMAP's rule, one descriptor at a time: nearest and second nearest by the angle between
    them, the distance and ratio tests each way, then the cross check."""
    dots = a.astype(np.int64) @ b.astype(np.int64).T
    dist = np.arccos(np.minimum(dots.astype(np.float32) * G.NORM, np.float32(1)))

    def one_way(d: np.ndarray) -> np.ndarray:
        out = np.full(d.shape[0], -1)
        for i, row in enumerate(d):
            order = np.argsort(row, kind="stable")
            best = row[order[0]]
            second = row[order[1]] if len(order) > 1 else np.float32(np.inf)
            if best <= np.float32(max_distance) and best < np.float32(ratio) * second:
                out[i] = order[0]
        return out

    m12, m21 = one_way(dist), one_way(dist.T)
    return np.array([(i, j) for i, j in enumerate(m12) if j >= 0 and m21[j] == i], np.uint32).reshape(-1, 2)


def test_matches_are_colmaps_mutual_nearest_neighbours():
    a, b = _two_photos()
    want = _reference(a, b)
    got = G.match_pair(np, a.astype(np.float32), b.astype(np.float32))
    assert got.dtype == np.uint32 and len(want) > 250
    np.testing.assert_array_equal(got, want)


@pytest.mark.parametrize("cells", [1, 7 * 520, 100 * 520, 10**9])
def test_the_block_size_does_not_change_the_answer(cells):
    a, b = _two_photos(seed=5)
    whole = G.match_pair(np, a.astype(np.float32), b.astype(np.float32))
    np.testing.assert_array_equal(
        G.match_pair(np, a.astype(np.float32), b.astype(np.float32), cells=cells), whole
    )


def test_empty_and_single_descriptor_sets():
    rng = np.random.default_rng(1)
    one = _sift(rng, 1).astype(np.float32)
    many = _sift(rng, 40).astype(np.float32)
    assert G.match_pair(np, one[:0], many).shape == (0, 2)
    assert G.match_pair(np, many, one[:0]).shape == (0, 2)
    # one descriptor against itself: nothing to be second best, so the ratio test passes
    np.testing.assert_array_equal(G.match_pair(np, one, one), [[0, 0]])
    np.testing.assert_array_equal(
        G.match_pair(np, one, one), _reference(one.astype(np.uint8), one.astype(np.uint8))
    )


@pytest.mark.skipif(
    not REAL, reason="set AIO_TEST_ADDON to a built GPU add-on on a computer with an NVIDIA card"
)
def test_the_card_gives_the_matches_of_the_cpu(tmp_path, monkeypatch):
    from aio_pipelines import accel

    monkeypatch.setenv(accel.CACHE_ENV, str(tmp_path / "kernels"))
    accel.activate(Path(REAL))
    import cupy as cp

    a, b = _two_photos(seed=9, shared=4000, only_a=3000, only_b=2500)
    want = G.match_pair(np, a.astype(np.float32), b.astype(np.float32))
    for cells in (G.CELLS, 1000 * len(b)):
        got = G.match_pair(
            cp, cp.asarray(a).astype(cp.float32), cp.asarray(b).astype(cp.float32), cells=cells
        )
        np.testing.assert_array_equal(got, want)


# ------------------------------------------------------------------------- COLMAP's database


def _database(path: Path, photos: dict[str, np.ndarray]) -> dict[str, int]:
    con = sqlite3.connect(path)
    con.executescript(
        """
        CREATE TABLE images (image_id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, name TEXT NOT NULL UNIQUE,
            camera_id INTEGER NOT NULL);
        CREATE TABLE descriptors (image_id INTEGER PRIMARY KEY NOT NULL, type INTEGER NOT NULL,
            rows INTEGER NOT NULL, cols INTEGER NOT NULL, data BLOB);
        CREATE TABLE matches (pair_id INTEGER PRIMARY KEY NOT NULL, rows INTEGER NOT NULL,
            cols INTEGER NOT NULL, data BLOB);
        CREATE TABLE two_view_geometries (pair_id INTEGER PRIMARY KEY NOT NULL, rows INTEGER NOT NULL,
            cols INTEGER NOT NULL, data BLOB, config INTEGER NOT NULL);
        """
    )
    ids = {}
    for name, d in photos.items():
        cur = con.execute("insert into images(name, camera_id) values (?, 1)", (name,))
        ids[name] = int(cur.lastrowid)
        con.execute(
            "insert into descriptors values (?, 0, ?, ?, ?)", (ids[name], d.shape[0], d.shape[1], d.tobytes())
        )
    con.commit()
    con.close()
    return ids


def _stored(path: Path, a: int, b: int) -> np.ndarray:
    con = sqlite3.connect(path)
    row = con.execute("select rows, cols, data from matches where pair_id = ?", (G.pair_id(a, b),)).fetchone()
    con.close()
    return np.frombuffer(row[2], np.uint32).reshape(row[0], row[1])


def test_matches_are_written_as_colmap_reads_them(tmp_path):
    a, b = _two_photos(seed=4)
    c = _sift(np.random.default_rng(8), 90)
    db = tmp_path / "database.db"
    ids = _database(db, {"DJI 0001.JPG": a, "b.jpg": b, "c.jpg": c})
    pairs = tmp_path / "pairs.txt"
    # the second photo first: COLMAP stores a pair under its smaller image id, columns to match
    pairs.write_text(f"b.jpg {engine_alias('DJI 0001.JPG')}\nb.jpg c.jpg\n", "utf-8")
    sent: list[dict] = []
    res = G.run({"database": str(db), "pairs": str(pairs)}, lambda **m: sent.append(m), np)
    assert res["pairs"] == 2 and res["made"] == 2 and res["gpu"] == "numpy"
    assert sent[-1] == {"progress": 1.0, "message": "2 of 2 pairs"}
    want = _reference(a, b)
    # the columns are (first image id, second image id) whatever order the list named them in;
    # the rows come in the order of the photo the list named first
    stored = _stored(db, ids["DJI 0001.JPG"], ids["b.jpg"])
    np.testing.assert_array_equal(stored[np.argsort(stored[:, 0])], want)
    assert res["matches"] == len(want) + len(_stored(db, ids["b.jpg"], ids["c.jpg"]))
    assert G.pair_id(2, 1) == G.pair_id(1, 2) == 1 * G.PAIR_RANGE + 2


def test_a_second_run_keeps_what_is_there_and_clearing_drops_it(tmp_path):
    a, b = _two_photos(seed=6)
    db = tmp_path / "database.db"
    ids = _database(db, {"a.jpg": a, "b.jpg": b})
    pairs = tmp_path / "pairs.txt"
    pairs.write_text("a.jpg b.jpg\n", "utf-8")
    req = {"database": str(db), "pairs": str(pairs)}
    assert G.run(req, lambda **m: None, np)["made"] == 1
    con = sqlite3.connect(db)
    con.execute("update matches set rows = 0, data = x''")  # stands for another matcher's answer
    con.commit()
    con.close()
    again = G.run(req, lambda **m: None, np)
    assert again["made"] == 0 and len(_stored(db, ids["a.jpg"], ids["b.jpg"])) == 0
    G.clear_matches(db)
    assert G.run(req, lambda **m: None, np)["made"] == 1


def test_descriptors_that_are_not_sift_bytes_or_an_unknown_photo_are_refused(tmp_path):
    db = tmp_path / "database.db"
    floats = np.zeros((5, 64), np.uint8)
    _database(db, {"a.jpg": floats, "b.jpg": floats})
    pairs = tmp_path / "pairs.txt"
    pairs.write_text("a.jpg b.jpg\n", "utf-8")
    with pytest.raises(ValueError, match="are not 128 bytes each"):
        G.run({"database": str(db), "pairs": str(pairs)}, lambda **m: None, np)
    pairs.write_text("a.jpg z.jpg\n", "utf-8")
    with pytest.raises(ValueError, match="names a photo the database does not have"):
        G.run({"database": str(db), "pairs": str(pairs)}, lambda **m: None, np)


# ------------------------------------------------------------------------------- the engine


def _engine_or_skip() -> None:
    try:
        ColmapEngine().versions()
    except JobError as e:
        pytest.skip(f"no alignment engine here: {e}")


def _align(project: Path, photos: Path, run: str) -> tuple[dict, dict]:
    params = {"photos": {"folders": [str(photos)]}, "preset": "standard", "run": run}
    result, _ = run_job(PhotoAlign(), project, params, job_id=run)
    assert result["status"] == "done"
    report = json.loads((project / f"photogrammetry/{run}/report/align.json").read_text("utf-8"))
    return result, report


def test_an_alignment_with_the_cards_matcher_matches_colmaps(project, tmp_path, monkeypatch):
    _engine_or_skip()
    from photo_g2_synth import make_scene, render_nadir_set

    scene = make_scene(rows=3, cols=4, width=800, height=600, points=10, seed=21, gnss_sigma=(0.02, 0.03))
    photos = tmp_path / "photos"
    render_nadir_set(scene, photos, rtk=True, texture=(2048, 200.0))
    monkeypatch.delenv("AIO_PHOTO_ADDON", raising=False)
    cpu, cpu_report = _align(project, photos, "cpu")
    assert cpu["outputs"]["match"]["device"] == "cpu" and cpu["outputs"]["match"]["engine"] == "sift-colmap"
    monkeypatch.setattr(ColmapEngine, "match_backend", "numpy")
    card, card_report = _align(project, photos, "card")
    match = card["outputs"]["match"]
    assert match["device"] == "gpu" and match["engine"] == "sift-card"
    assert match["pairs"] == cpu["outputs"]["match"]["pairs"]
    # the same photos, as well aligned
    assert card_report["images"]["registered"] == cpu_report["images"]["registered"] >= 0.98 * 12
    assert card_report["meanReprojPx"] < 1.0
    assert abs(card_report["meanReprojPx"] - cpu_report["meanReprojPx"]) < 0.1


def test_a_card_that_fails_leaves_the_matching_to_colmap(project, tmp_path, monkeypatch):
    _engine_or_skip()
    from photo_g2_synth import make_scene, render_nadir_set

    scene = make_scene(rows=2, cols=3, width=800, height=600, points=10, seed=22, gnss_sigma=(0.02, 0.03))
    photos = tmp_path / "photos"
    render_nadir_set(scene, photos, rtk=True, texture=(2048, 200.0))
    # an add-on that is not there: the worker cannot load it, and the engine falls back
    monkeypatch.setattr(
        ColmapEngine, "_card", lambda self, job: {"addon": str(tmp_path / "pipeline-addon-cuda-0.0.0")}
    )
    seen = []
    params = {"photos": {"folders": [str(photos)]}, "preset": "standard", "run": "r1"}
    result, rec = run_job(PhotoAlign(), project, params)
    seen = [p.get("message", "") for p in rec.of("log")]
    assert result["status"] == "done" and result["outputs"]["match"]["device"] == "cpu"
    assert any(m.startswith("The graphics card could not be used for matching (") for m in seen), seen
