"""The OpenSfM sub-step parser, fed from trimmed real logs of a 1,003-photo run."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import pytest

from aio_pipelines.photo.odm.sfm_progress import SUBSTEPS, SfmProgress, photo_count

FIXTURES = Path(__file__).parent / "fixtures" / "odm_log"


def read_lines(name: str) -> list[str]:
    return (FIXTURES / name).read_text(encoding="utf-8").splitlines()


def make(total: int | None = 1003, clock: Callable[[], float] | None = None) -> SfmProgress:
    if clock is None:
        return SfmProgress(lambda: total)
    return SfmProgress(lambda: total, clock)


def feed_until(sp: SfmProgress, lines: list[str], needle: str) -> int:
    """Feed lines up to, not including, the first one holding ``needle``; return its index."""
    for i, line in enumerate(lines):
        if needle in line:
            return i
        sp.feed(line)
    raise AssertionError(f"{needle!r} not in the lines")


def test_weights_sum_to_100() -> None:
    assert sum(step.weight for step in SUBSTEPS) == 100


def test_photo_count_reads_the_image_list(tmp_path: Path) -> None:
    assert photo_count(tmp_path) is None
    (tmp_path / "opensfm").mkdir()
    (tmp_path / "opensfm" / "image_list.txt").write_text("a.jpg\n\nb.jpg\n  \nc.jpg\n", encoding="utf-8")
    assert photo_count(tmp_path) == 3


def test_first_run_counts_features_pairs_and_placed_photos() -> None:
    lines = read_lines("first-run.txt")
    sp = make()
    at = feed_until(sp, lines, "match_features")
    assert sp.detail() == {"label": "Finding features", "done": 20, "total": 1003, "unit": "photos"}
    sp.feed(lines[at])
    at += 1 + feed_until(sp, lines[at + 1 :], "create_tracks")
    assert sp.detail() == {"label": "Matching photos", "done": 48, "total": 12467, "unit": "pairs"}
    for line in lines[at:]:
        sp.feed(line)
    assert sp.current == "reconstruct"
    assert sp.detail() == {
        "label": "Building the 3D model",
        "done": 30,
        "total": 1003,
        "unit": "photos placed",
    }


def test_fraction_moves_with_the_counts_and_never_back() -> None:
    sp = make()
    last = 0.0
    for line in read_lines("first-run.txt"):
        sp.feed(line)
        now = sp.fraction()
        assert now >= last
        last = now
        if 'reconstruct "' in line:
            assert now == pytest.approx(0.34)
    assert last > 0.34


def test_a_resumed_run_counts_done_sub_steps_and_restarts_the_count() -> None:
    lines = read_lines("resumed-run.txt")
    sp = make()
    at = feed_until(sp, lines, "Found a valid OpenSfM tracks file")
    sp.feed(lines[at])
    assert sp.current == "reconstruct"
    assert sp.fraction() == pytest.approx(0.34)
    assert sp.detail() is not None
    assert sp.detail()["done"] == 0
    assert sp.detail()["label"] == "Building the 3D model"
    seed = at + 1 + feed_until(sp, lines[at + 1 :], "Starting reconstruction with")
    sp.feed(lines[seed])
    assert sp.detail()["done"] == 2
    stats = seed + 1 + feed_until(sp, lines[seed + 1 :], "Export reconstruction stats")
    for line in lines[seed + 1 : stats]:
        sp.feed(line)
    assert sp.detail()["done"] == 75
    for line in lines[stats:]:
        sp.feed(line)
        if "Undistorting" in line:
            assert sp.current == "undistort"
            assert sp.fraction() == pytest.approx(0.92)
    sp.finish()
    assert sp.fraction() == 1.0
    assert sp.detail() is None
    assert sp.current is None


def test_a_photo_added_twice_counts_once() -> None:
    sp = make()
    sp.feed('running "C:\\odm\\opensfm" reconstruct "C:\\odm-work\\project\\opensfm"')
    sp.feed("INFO: Starting reconstruction with 00430.jpg and 00431.jpg")
    sp.feed("INFO: Adding 00432.jpg to the reconstruction")
    assert sp.feed("INFO: Adding 00432.jpg to the reconstruction") is False
    assert sp.detail()["done"] == 3


def test_reconstruction_short_of_the_photo_count_waits_for_the_next_step() -> None:
    sp = make(3)
    sp.feed('running "C:\\odm\\opensfm" reconstruct "C:\\odm-work\\project\\opensfm"')
    sp.feed("INFO: Starting reconstruction with a.jpg and b.jpg")
    sp.feed("INFO: Adding c.jpg to the reconstruction")
    assert sp.fraction() == pytest.approx((34 + 52 * 0.99) / 100)
    sp.feed("INFO:    Export reconstruction stats")
    assert sp.fraction() == pytest.approx(0.86)


def test_line_variants_still_count() -> None:
    sp = make()
    started = sp.feed(
        'running "C:\\Program Files\\odm\\opensfm" detect_features "C:\\odm-work\\my project\\opensfm"\r'
    )
    assert started is True
    assert sp.current == "features"
    assert sp.feed("2026-10-16 14:10:09,257 INFO: Extracting ROOT_SIFT_GPU features for image a.jpg\r")
    assert sp.detail()["done"] == 1


def test_an_unknown_photo_count_shows_a_count_without_a_total() -> None:
    sp = make(None)
    sp.feed("[INFO]    Running opensfm stage")
    sp.feed('[INFO]    running "C:\\odm\\opensfm" detect_features "C:\\odm-work\\project\\opensfm"')
    sp.feed("INFO: Extracting ROOT_SIFT_GPU features for image a.jpg")
    sp.feed("INFO: Extracting ROOT_SIFT_GPU features for image b.jpg")
    assert sp.detail() == {"label": "Finding features", "done": 2, "unit": "photos"}
    assert sp.eta_seconds() is None
    assert sp.fraction() == pytest.approx(0.02)


def test_undistort_counts_tif_files() -> None:
    sp = make()
    sp.feed("[INFO]    Undistorting C:\\odm-work\\project\\opensfm ...")
    assert sp.set_undistorted(250) is True
    assert sp.detail()["done"] == 250
    assert sp.set_undistorted(100) is False
    assert sp.detail()["done"] == 250


def test_estimate_only_with_a_steady_rate() -> None:
    now = [1000.0]
    sp = make(1003, lambda: now[0])
    sp.feed('running "C:\\odm\\opensfm" detect_features "C:\\odm-work\\project\\opensfm"')
    n = 0

    def photo() -> None:
        nonlocal n
        n += 1
        sp.feed(f"INFO: Extracting ROOT_SIFT_GPU features for image p{n:05d}.jpg")

    start = now[0]
    while now[0] < start + 59:
        photo()
        now[0] += 0.15
    now[0] = start + 59
    assert sp.eta_seconds() is None
    while now[0] < start + 70:
        photo()
        now[0] += 0.15
    now[0] = start + 70
    assert sp.eta_seconds() == pytest.approx((1003 - 467) / (1 / 0.15), abs=2)
    while now[0] < start + 130:
        photo()
        now[0] += 0.6
    now[0] = start + 130
    assert sp.eta_seconds() is None

    sp.feed('running "C:\\odm\\opensfm" reconstruct "C:\\odm-work\\project\\opensfm"')
    sp.feed("INFO: Starting reconstruction with a.jpg and b.jpg")
    for i in range(300):
        now[0] += 1.0
        sp.feed(f"INFO: Adding r{i}.jpg to the reconstruction")
    assert sp.eta_seconds() is None
