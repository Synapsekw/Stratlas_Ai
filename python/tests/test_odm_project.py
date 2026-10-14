import json
import os
from pathlib import Path

import pytest

from aio_pipelines.photo.odm import project as P
from aio_pipelines.runtime import JobError


def _photo(path: Path, data: bytes = b"\xff\xd8jpeg") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def test_same_file_names_in_two_folders_get_distinct_links(tmp_path):
    a = _photo(tmp_path / "100MEDIA" / "IMG_0001.JPG", b"a" * 10)
    b = _photo(tmp_path / "101MEDIA" / "IMG_0001.JPG", b"b" * 10)
    odm = tmp_path / "odm"
    names, copies = P.link_images(odm, [("0/100MEDIA/IMG_0001.JPG", a), ("1/101MEDIA/IMG_0001.JPG", b)])
    assert names == {"00000.jpg": "0/100MEDIA/IMG_0001.JPG", "00001.jpg": "1/101MEDIA/IMG_0001.JPG"}
    assert (odm / "images" / "00001.jpg").read_bytes() == b"b" * 10
    assert P.read_names(odm) == names
    assert copies == 0  # same drive: hard links
    assert os.stat(odm / "images" / "00000.jpg").st_nlink == 2
    assert P.link_images(odm, [("0/100MEDIA/IMG_0001.JPG", a), ("1/101MEDIA/IMG_0001.JPG", b)]) == (names, 0)


def test_a_failed_hard_link_copies(tmp_path, monkeypatch):
    a = _photo(tmp_path / "in" / "x.jpg")
    monkeypatch.setattr(os, "link", lambda *_: (_ for _ in ()).throw(OSError("cross-device")))
    names, copies = P.link_images(tmp_path / "odm", [("k", a)])
    assert copies == 1 and (tmp_path / "odm" / "images" / "00000.jpg").read_bytes() == a.read_bytes()


def test_run_odm_dir_is_the_run_folder_when_its_path_is_safe(tmp_path, monkeypatch):
    monkeypatch.setattr(P, "is_safe_path", lambda p: True)
    assert P.run_odm_dir(tmp_path, "r1", {}) == tmp_path / "photogrammetry" / "r1" / "odm"


def test_safe_paths():
    assert P.is_safe_path(Path(r"E:\Data\proj\photogrammetry\run-1\odm"))
    assert P.is_safe_path(Path(r"E:\Stratlas Data\proj"))  # spaces work (C5)
    assert not P.is_safe_path(Path(r"E:\Média\proj"))
    assert not P.is_safe_path(Path(r"E:\a&b\proj"))
    assert P.is_safe_path(Path(r"C:\Users\RUNNER~1\AppData\Local\Temp\odm"))  # an 8.3 short name


@pytest.mark.skipif(os.name != "nt", reason="directory junctions are Windows'")
def test_odm_path_reaches_an_unsafe_folder_through_a_junction(tmp_path):
    real = tmp_path / "Stratlas Data é" / "odm"
    (real / "images").mkdir(parents=True)
    work = tmp_path / "work"
    got = P.odm_path(real, work)
    assert P.is_safe_path(got)
    assert (got / "images").is_dir() and got.parent == work
    assert P.odm_path(real, work) == got  # reused
    with pytest.raises(JobError):
        P.odm_path(real, None)


def test_geo_txt(tmp_path):
    assert P.write_geo(tmp_path, []) is None
    path = P.write_geo(tmp_path, [P.GeoRow("00000.jpg", 55.1, 25.2, 101.5, 10.0, -90.0, 0.0, 0.03, 0.05)])
    lines = path.read_text().splitlines()
    assert lines[0] == "EPSG:4326"
    assert lines[1].split() == [
        "00000.jpg",
        "55.10000000",
        "25.20000000",
        "101.500",
        "10.000",
        "-90.000",
        "0.000",
        "0.030",
        "0.050",
    ]
    path = P.write_geo(tmp_path, [P.GeoRow("00001.jpg", 55.1, 25.2, 101.5, None, None, None, 0.03, 0.05)])
    row = path.read_text().splitlines()[1].split()
    assert len(row) == 9 and row[4:7] == ["nan", "nan", "nan"]  # always 9 columns (C15)


GCP = {
    "schema": "aio.gcp/1",
    "crs": {"epsg": 32639},
    "points": [
        {"id": "G1", "role": "control", "xyz": [412010.0, 3245010.0, 21.0], "accuracy": {"horizontalM": 0.02, "verticalM": 0.03},
         "marks": [{"photo": "k1", "px": [100.5, 200.5], "by": "person", "at": "2026-10-14T00:00:00Z", "state": "confirmed"},
                   {"photo": "k2", "px": [110.5, 210.5], "by": "person", "at": "2026-10-14T00:00:00Z", "state": "confirmed"},
                   {"photo": "k3", "px": [1.0, 1.0], "by": "detector", "at": "2026-10-14T00:00:00Z", "state": "draft"}]},
        {"id": "G2", "role": "control", "xyz": [412020.0, 3245010.0, 21.0], "accuracy": {"horizontalM": 0.02, "verticalM": 0.03},
         "marks": [{"photo": "k1", "px": [300.5, 200.5], "by": "person", "at": "2026-10-14T00:00:00Z", "state": "confirmed"},
                   {"photo": "k2", "px": [310.5, 210.5], "by": "person", "at": "2026-10-14T00:00:00Z", "state": "confirmed"}]},
        {"id": "G3", "role": "control", "xyz": [412020.0, 3245020.0, 21.0], "accuracy": {"horizontalM": 0.02, "verticalM": 0.03},
         "marks": [{"photo": "k1", "px": [300.5, 400.5], "by": "person", "at": "2026-10-14T00:00:00Z", "state": "confirmed"},
                   {"photo": "k2", "px": [310.5, 410.5], "by": "person", "at": "2026-10-14T00:00:00Z", "state": "confirmed"}]},
        {"id": "C1", "role": "check", "xyz": [412015.0, 3245015.0, 21.0], "accuracy": {"horizontalM": 0.02, "verticalM": 0.03},
         "marks": [{"photo": "k1", "px": [5.5, 5.5], "by": "person", "at": "2026-10-14T00:00:00Z", "state": "confirmed"},
                   {"photo": "k2", "px": [6.5, 6.5], "by": "person", "at": "2026-10-14T00:00:00Z", "state": "confirmed"}]},
        {"id": "G4", "role": "control", "disabled": True, "xyz": [0, 0, 0], "accuracy": {"horizontalM": 0.02, "verticalM": 0.03},
         "marks": [{"photo": "k1", "px": [7.5, 7.5], "by": "person", "at": "2026-10-14T00:00:00Z", "state": "confirmed"},
                   {"photo": "k2", "px": [8.5, 8.5], "by": "person", "at": "2026-10-14T00:00:00Z", "state": "confirmed"}]},
    ],
}  # fmt: skip


def test_gcp_list_has_confirmed_control_marks_only(tmp_path):
    out = P.write_gcp_list(
        tmp_path, GCP, {"k1": "00000.jpg", "k2": "00001.jpg", "k3": "00002.jpg"}, exclude=set()
    )
    lines = out.path.read_text().splitlines()
    assert lines[0] == "EPSG:32639"
    assert out.points == ["G1", "G2", "G3"] and out.marks == 6
    assert lines[1].split() == [
        "412010.0000",
        "3245010.0000",
        "21.0000",
        "100.00",
        "200.00",
        "00000.jpg",
        "G1",
    ]
    text = out.path.read_text()
    assert "C1" not in text and "G4" not in text and "00002.jpg" not in text  # checks, disabled, drafts


def test_gcp_list_leaves_out_outliers_and_needs_three_points(tmp_path):
    links = {"k1": "00000.jpg", "k2": "00001.jpg"}
    with pytest.raises(JobError, match="At least three usable control points"):
        P.write_gcp_list(tmp_path, GCP, links, exclude={"G3"})


def test_boundary_invalidate_and_cleanup(tmp_path):
    b = P.write_boundary(tmp_path, [[55.0, 25.0], [55.1, 25.0], [55.1, 25.1]])
    doc = json.loads(b.read_text())
    assert doc["type"] == "FeatureCollection"
    ring = doc["features"][0]["geometry"]["coordinates"][0]
    assert ring[0] == ring[-1] == [55.0, 25.0]  # closed
    for rel in (
        "opensfm/reconstruction.json",
        "openmvs/scene.mvs",
        "odm_meshing/x.ply",
        "opensfm/features/a.npz",
    ):
        (tmp_path / rel).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / rel).write_bytes(b"x" * 100)
    assert P.has_alignment(tmp_path)
    assert P.clean_intermediates(tmp_path) >= 200
    assert not (tmp_path / "openmvs").exists() and not (tmp_path / "odm_meshing").exists()
    assert (tmp_path / "opensfm" / "features" / "a.npz").exists()  # alignment kept for later products
    P.invalidate(tmp_path, ("opensfm/reconstruction.json", "missing/thing"))
    assert not P.has_alignment(tmp_path)


def test_link_images_prunes_stale_links_and_keeps_sources(tmp_path):
    a = _photo(tmp_path / "in" / "a.jpg", b"a" * 10)
    b = _photo(tmp_path / "in" / "b.jpg", b"b" * 10)
    odm = tmp_path / "odm"
    P.link_images(odm, [("a", a), ("b", b)])
    names, _ = P.link_images(odm, [("a", a)])
    assert names == {"00000.jpg": "a"}
    assert sorted(p.name for p in (odm / "images").iterdir()) == ["00000.jpg"]
    assert b.read_bytes() == b"b" * 10  # the source photo is untouched


def test_link_images_replaces_a_different_photo_of_the_same_size(tmp_path):
    a = _photo(tmp_path / "in" / "a.jpg", b"a" * 10)
    c = _photo(tmp_path / "in" / "c.jpg", b"c" * 10)
    odm = tmp_path / "odm"
    P.link_images(odm, [("a", a)])
    P.link_images(odm, [("c", c)])
    assert (odm / "images" / "00000.jpg").read_bytes() == b"c" * 10


def test_link_images_raises_a_plain_error_when_link_and_copy_both_fail(tmp_path, monkeypatch):
    a = _photo(tmp_path / "in" / "x.jpg")
    monkeypatch.setattr(os, "link", lambda *_: (_ for _ in ()).throw(OSError("no")))
    monkeypatch.setattr(P.shutil, "copy2", lambda *_: (_ for _ in ()).throw(OSError("disk full")))
    with pytest.raises(JobError, match="Could not link or copy"):
        P.link_images(tmp_path / "odm", [("k", a)])


@pytest.mark.skipif(os.name != "nt", reason="directory junctions are Windows'")
def test_odm_path_replaces_a_dangling_junction(tmp_path):
    real = tmp_path / "é" / "odm"
    real.mkdir(parents=True)
    work = tmp_path / "work"
    got = P.odm_path(real, work)
    real.rmdir()
    assert not got.exists()
    again = P.odm_path(real, work)
    assert again == got and again.is_dir()
