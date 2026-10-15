"""bentley.import on the synthetic block (no client data)."""

import json
import shutil
from pathlib import Path

import pytest

import bentley_synth as bs
from aio_pipelines.bentley.importer import BentleyImport
from aio_pipelines.pipelines import all_pipelines
from aio_pipelines.runtime import JobError
from conftest import run_job


def _setup(tmp_path):
    root = bs.make_project(tmp_path / "proj")
    out = bs.make_block(tmp_path / "bentley")
    return root, out


def _manifest(root):
    return json.loads((root / "manifest.json").read_text("utf-8"))


def test_it_is_registered_and_checks_its_parameters(tmp_path):
    assert isinstance(all_pipelines()["bentley.import"], BentleyImport)
    p = BentleyImport()
    xml, photos = str(tmp_path / "at.xml"), str(tmp_path / "photos")
    assert p.validate({"xml": xml, "photos": photos}) == {"xml": xml, "photos": photos}
    assert p.validate({"xml": xml, "photos": photos, "name": " Mast "})["name"] == "Mast"
    with pytest.raises(JobError, match="does not take: bogus"):
        p.validate({"xml": xml, "photos": photos, "bogus": 1})
    with pytest.raises(JobError, match=r"\.xml"):
        p.validate({"xml": str(tmp_path / "at.opf"), "photos": photos})
    with pytest.raises(JobError):
        p.validate({"xml": xml})


def test_the_block_comes_in_as_a_run_and_a_photos_layer_placed_by_pose(tmp_path):
    root, out = _setup(tmp_path)
    result, _ = run_job(BentleyImport(), root, {"xml": out["xml"], "photos": out["photos"]})
    assert result["status"] == "done", result
    m = _manifest(root)
    (layer,) = [x for x in m["layers"] if x["kind"] == "photos"]
    assert layer["name"] == "at.xml photos"
    assert len(layer["items"]) == 3
    assert m["captures"] == [{"id": "capture-2026-03-04", "label": "Survey", "date": "2026-03-04"}]
    assert layer["capture"] == "capture-2026-03-04"
    for item in layer["items"]:
        assert len(item["pos"]) == 3 and len(item["q"]) == 4 and "takenAt" not in item
        assert item["lens"]["model"] == "pinhole" and item["lens"]["cx"] == bs.PP[0]
        assert (root / item["src"]["path"]).is_file()
    run_id = layer["id"].removeprefix("photos-")
    assert run_id.startswith("bentley-")
    run_dir = root / "photogrammetry" / run_id
    run = json.loads((run_dir / "run.json").read_text("utf-8"))
    assert run["status"] == "aligned" and run["capture"] == "capture-2026-03-04"
    assert run["photos"]["count"] == 4 and run["photos"]["registered"] == 3
    assert run["settings"]["bentley"]["xml"] == "at.xml"
    assert run["outputs"]["layers"] == [layer["id"]]
    assert {r["reason"] for r in run["photos"]["rejected"]} == {"not aligned in the block"}
    for f in ("cameras.txt", "images.txt", "points3D.txt", "frame.json", "photos.json"):
        assert (run_dir / "sparse" / f).is_file()
    cams = (run_dir / "sparse" / "cameras.txt").read_text("utf-8")
    assert "FULL_OPENCV 640 480" in cams
    doc = json.loads((run_dir / "sparse" / "photos.json").read_text("utf-8"))
    assert len(doc["photos"]) == 3
    for v in doc["photos"].values():
        assert Path(doc["imageRoot"], v["name"]).is_file()
    report = json.loads((run_dir / "report" / "bentley-import.json").read_text("utf-8"))
    assert report["imported"] == {"photos": 3, "missing": 0, "unaligned": 1, "layer": layer["id"]}


def test_missing_photos_are_left_out_and_listed(tmp_path):
    root, out = _setup(tmp_path)
    shutil.rmtree(tmp_path / "bentley" / "photos" / "flight-b")
    result, rec = run_job(BentleyImport(), root, {"xml": out["xml"], "photos": out["photos"]})
    assert result["status"] == "done"
    (layer,) = [x for x in _manifest(root)["layers"] if x["kind"] == "photos"]
    assert len(layer["items"]) == 2
    assert any("IMG_0003.JPG" in msg["message"] for msg in rec.of("log"))


def test_no_photo_found_fails_in_words(tmp_path):
    root, out = _setup(tmp_path)
    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(JobError, match="None of the 3"):  # Job.run raises after recording the failure
        run_job(BentleyImport(), root, {"xml": out["xml"], "photos": str(empty)})
    assert not [x for x in _manifest(root)["layers"] if x["kind"] == "photos"]


def test_no_readable_photo_fails_before_anything_is_written(tmp_path, monkeypatch):
    from aio_pipelines.aik import cameras

    def unreadable(src, dest, long_edge=2560):
        raise OSError("not a picture")

    monkeypatch.setattr(cameras, "review_copy", unreadable)
    root, out = _setup(tmp_path)
    before = (root / "manifest.json").read_text("utf-8")
    with pytest.raises(JobError, match="could be read"):
        run_job(BentleyImport(), root, {"xml": out["xml"], "photos": out["photos"]})
    assert (root / "manifest.json").read_text("utf-8") == before
    assert not (root / "manifest.json.bak").exists()
    assert not (root / "photogrammetry").exists() or not any((root / "photogrammetry").iterdir())


def test_a_commit_run_twice_adds_one_layer_and_one_capture(tmp_path):
    from aio_pipelines.bentley import importer

    root, out = _setup(tmp_path)
    calls = {"n": 0}
    real = importer._commit

    def twice(ctx, plan, params):
        calls["n"] += 1
        real(ctx, plan, params)
        return real(ctx, plan, params)

    importer._commit = twice
    try:
        result, _ = run_job(BentleyImport(), root, {"xml": out["xml"], "photos": out["photos"]})
    finally:
        importer._commit = real
    assert result["status"] == "done" and calls["n"] == 1
    m = _manifest(root)
    (layer,) = [x for x in m["layers"] if x["kind"] == "photos"]
    assert len(layer["items"]) == 3 and len(m["captures"]) == 1


def _redate(out, old, new):
    xml = Path(out["xml"])
    text = xml.read_text("utf-8")
    assert old in text
    xml.write_text(text.replace(old, new), "utf-8")


def test_an_unreadable_photo_date_is_skipped_and_logged(tmp_path):
    root, out = _setup(tmp_path)
    _redate(out, bs.TIMES[0], "2026:03:01 10:00:05")  # EXIF style, not ISO
    result, rec = run_job(BentleyImport(), root, {"xml": out["xml"], "photos": out["photos"]})
    assert result["status"] == "done"
    m = _manifest(root)
    (layer,) = [x for x in m["layers"] if x["kind"] == "photos"]
    assert len(layer["items"]) == 3 and layer["capture"] == "capture-2026-03-04"
    assert [c["date"] for c in m["captures"]] == ["2026-03-04"]
    assert any("1 photos have a date that could not be read" in msg["message"] for msg in rec.of("log"))


def test_no_readable_photo_date_imports_without_a_capture(tmp_path):
    root, out = _setup(tmp_path)
    for t in bs.TIMES:
        _redate(out, t, t.replace("-", ":").replace("T", " "))
    result, _ = run_job(BentleyImport(), root, {"xml": out["xml"], "photos": out["photos"]})
    assert result["status"] == "done"
    m = _manifest(root)
    (layer,) = [x for x in m["layers"] if x["kind"] == "photos"]
    assert "capture" not in layer and m["captures"] == []


def test_the_capture_comes_from_photos_in_the_layer(tmp_path, monkeypatch):
    from aio_pipelines.aik import cameras

    real = cameras.review_copy

    def first_unreadable(src, dest, long_edge=2560):
        if Path(src).name == "IMG_0001.JPG":
            raise OSError("not a picture")
        return real(src, dest, long_edge)

    monkeypatch.setattr(cameras, "review_copy", first_unreadable)
    root, out = _setup(tmp_path)
    _redate(out, bs.TIMES[0], "2026-03-02T10:00:05")  # the earliest day, but its copy fails
    result, _ = run_job(BentleyImport(), root, {"xml": out["xml"], "photos": out["photos"]})
    assert result["status"] == "done"
    m = _manifest(root)
    (layer,) = [x for x in m["layers"] if x["kind"] == "photos"]
    assert len(layer["items"]) == 2 and layer["capture"] == "capture-2026-03-04"
    assert [c["date"] for c in m["captures"]] == ["2026-03-04"]
