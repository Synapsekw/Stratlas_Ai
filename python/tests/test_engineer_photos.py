"""Photo ingestion: orientation, duplicates, caps, privacy, identity."""

from __future__ import annotations

import json

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter

from aio_pipelines.engineer.photos import ingest_photos
from synth_assets import synth_photos


def _jpeg(path, im, exif=None):
    im.save(path, "JPEG", quality=90, **({"exif": exif} if exif is not None else {}))
    return path


def _textured(size, colour):
    """A flat colour with a few hard edges (a blank frame fails the quality gate)."""
    im = Image.new("RGB", size, colour)
    d = ImageDraw.Draw(im)
    w, h = size
    d.rectangle([w // 5, h // 5, w // 2, h // 2], fill=(20, 20, 20))
    d.ellipse([w // 2, h // 3, w * 4 // 5, h * 4 // 5], fill=(240, 240, 240))
    return im


def test_exif_rotated_photo_comes_out_upright(tmp_path):
    exif = Image.Exif()
    exif[0x0112] = 6
    landscape = _textured((1600, 1200), (120, 140, 160))
    p = _jpeg(tmp_path / "a.jpg", landscape, exif)
    r = ingest_photos([p], tmp_path / "out", 800, 10)
    it = r.items[0]
    assert (it["w"], it["h"]) == (1200, 1600) and it["w"] < it["h"] and it["orientationApplied"] is True
    with Image.open(r.copies[it["id"]]) as c:
        assert c.size == (600, 800)
    # the synthetic generator stores sideways pixels with the tag; ingesting restores the plain picture
    plain = synth_photos(tmp_path / "plain", n=1, seed=9)[0]
    turned = synth_photos(tmp_path / "turned", n=1, seed=9, rotate_exif=True)[0]
    r2 = ingest_photos([turned], tmp_path / "out2", 2000, 10)
    with Image.open(r2.copies[r2.items[0]["id"]]) as got, Image.open(plain) as want:
        assert got.size == want.size
        diff = np.abs(np.asarray(got, dtype=int) - np.asarray(want, dtype=int)).mean()
        assert diff < 6
    assert turned.exists() and Image.open(turned).getexif().get(0x0112) == 6  # the original is untouched


def test_exact_and_near_duplicates_are_dropped_with_dup_of(tmp_path):
    a = synth_photos(tmp_path / "s", n=1, seed=3)[0]
    copy = tmp_path / "copy.jpg"
    copy.write_bytes(a.read_bytes())
    with Image.open(a) as im:
        shifted = ImageChops.offset(im, 1, 0)
    near = _jpeg(tmp_path / "near.jpg", shifted)
    r = ingest_photos([a, copy, near], tmp_path / "out", 640, 10)
    assert len(r.kept) == 1
    by_path = {i["original"]: i for i in r.items}
    kept_id = r.kept[0]
    assert (
        by_path[str(copy)]["dupOf"] == by_path[str(a)]["id"]
        and by_path[str(copy)]["id"] != by_path[str(a)]["id"]
    )
    assert kept_id in (by_path[str(a)]["id"], by_path[str(near)]["id"])
    dropped_near = next(i for i in (by_path[str(a)], by_path[str(near)]) if i["id"] != kept_id)
    assert dropped_near["dupOf"] == kept_id
    ids = [i["id"] for i in r.items]
    assert len(set(ids)) == len(ids)
    assert all(len(i) == 40 for i in ids)


def test_max_images_keeps_the_sharpest_and_copies_are_bounded(tmp_path):
    shots = synth_photos(tmp_path / "s", n=4, seed=5, size=(1600, 1200))
    paths = []
    for k, s in enumerate(shots):
        with Image.open(s) as im:
            # distinct pictures: draw a different bar in each so no two are near duplicates
            d = ImageDraw.Draw(im)
            d.rectangle([100 + 300 * k, 900, 300 + 300 * k, 1100], fill=(10, 10, 10))
            paths.append(_jpeg(tmp_path / f"p{k}.jpg", im.filter(ImageFilter.GaussianBlur(1.5 * k))))
    r = ingest_photos(paths, tmp_path / "out", 500, 2)
    assert len(r.kept) == 2
    sharp = {i["original"] for i in r.items if i["id"] in r.kept}
    assert sharp == {str(paths[0]), str(paths[1])}
    assert all("over the image limit" in i["review"] for i in r.items if i["id"] not in r.kept)
    for path in r.copies.values():
        with Image.open(path) as c:
            assert max(c.size) <= 500


def test_no_gps_or_text_leaves_the_photo_but_the_camera_position(tmp_path):
    exif = Image.Exif()
    exif[0x010E] = "Tower at the north gate, ask for J. Smith"
    exif[0x013B] = "J. Smith"
    gps = exif.get_ifd(0x8825)
    gps[1], gps[2], gps[3], gps[4] = "N", (48.0, 30.0, 0.0), "E", (11.0, 15.0, 0.0)
    gps[5], gps[6] = 0, 512.0
    p = _jpeg(tmp_path / "g.jpg", _textured((800, 600), (90, 120, 150)), exif)
    r = ingest_photos([p], tmp_path / "out", 400, 5)
    it = r.items[0]
    assert abs(it["gpsCamera"][0] - 11.25) < 1e-6 and abs(it["gpsCamera"][1] - 48.5) < 1e-6
    blob = json.dumps(r.items)
    assert "Smith" not in blob and "north gate" not in blob
    with Image.open(r.copies[it["id"]]) as c:
        assert len(c.getexif()) == 0 and "exif" not in c.info
    assert b"Smith" not in r.copies[it["id"]].read_bytes()


def test_a_photo_of_something_else_is_flagged_not_blended(tmp_path):
    same = synth_photos(tmp_path / "s", n=3, seed=2)
    odd = Image.new("RGB", (1600, 1200), (200, 60, 40))
    d = ImageDraw.Draw(odd)
    d.rectangle([600, 100, 1000, 1100], fill=(250, 200, 30))
    other = _jpeg(tmp_path / "other.jpg", odd)
    r = ingest_photos([*same, other], tmp_path / "out", 400, 10)
    assert r.identity["sameAsset"] is False
    flagged = {i for c in r.identity["conflicts"] for i in c["imageIds"]}
    by_path = {i["original"]: i for i in r.items}
    assert flagged == {by_path[str(other)]["id"]}
    assert by_path[str(other)]["review"].startswith("identity")
    assert len(r.kept) == 4  # flagged, still listed: the run decides, nothing is blended silently
    clean = ingest_photos(same, tmp_path / "out2", 400, 10)
    assert clean.identity == {"sameAsset": True, "conflicts": []}


def test_unreadable_files_are_rejected_with_a_reason(tmp_path):
    bad = tmp_path / "bad.jpg"
    bad.write_bytes(b"not an image")
    r = ingest_photos([bad], tmp_path / "out", 400, 5)
    assert r.items == [] and "bad.jpg" in r.rejected[0]["reason"]


def test_one_photo_is_in_memory_at_a_time(tmp_path, monkeypatch):
    """12 photos of 3000 x 2000: never more than a couple of full images alive together."""
    import gc

    from aio_pipelines.engineer import photos as mod

    paths = []
    for k in range(12):
        im = _textured((3000, 2000), (60 + 15 * k, 120, 200 - 10 * k))
        ImageDraw.Draw(im).rectangle([100 * k, 50, 100 * k + 80, 1900], fill=(255, 0, 0))
        paths.append(_jpeg(tmp_path / f"big{k}.jpg", im))
    del im
    seen = []
    real = mod._write_jpeg

    def spy(im, path):
        live = sum(o.width * o.height for o in gc.get_objects() if isinstance(o, Image.Image))
        seen.append(live)
        real(im, path)

    monkeypatch.setattr(mod, "_write_jpeg", spy)
    r = ingest_photos(paths, tmp_path / "out", 512, 20)
    assert len(r.kept) >= 6 and seen
    full = 3000 * 2000
    assert max(seen) < 1.5 * full, f"{max(seen) / full:.2f} full images alive"
    # every item still reports the full size, and the copies are bounded
    assert all((i["w"], i["h"]) == (3000, 2000) for i in r.items)
    for c in r.copies.values():
        with Image.open(c) as im:
            assert max(im.size) <= 512


def test_the_quality_gate_rejects_tiny_and_blank_photos_with_a_reason(tmp_path):
    tiny = _jpeg(tmp_path / "tiny.jpg", _textured((200, 150), (90, 90, 90)))
    blank = _jpeg(tmp_path / "blank.jpg", Image.new("RGB", (1600, 1200), (128, 128, 128)))
    good = _jpeg(tmp_path / "good.jpg", _textured((1600, 1200), (90, 120, 150)))
    r = ingest_photos([tiny, blank, good], tmp_path / "out", 640, 10)
    by = {i["original"]: i for i in r.items}
    assert by[str(tiny)]["review"].startswith("rejected: too small")
    assert by[str(blank)]["review"].startswith("rejected: no usable detail")
    assert r.kept == [by[str(good)]["id"]]
    assert {x["path"] for x in r.rejected} == {str(tiny), str(blank)}
    assert sorted(p.name for p in (tmp_path / "out").iterdir()) == [by[str(good)]["id"][:16] + ".jpg"]


def test_a_camera_far_from_the_asset_is_flagged_by_its_position_only(tmp_path):
    from aio_pipelines.engineer.photos import distance_m, flag_far_cameras

    def with_gps(name, lon, lat):
        exif = Image.Exif()
        gps = exif.get_ifd(0x8825)
        gps[1], gps[2] = ("N" if lat >= 0 else "S"), (abs(lat), 0.0, 0.0)
        gps[3], gps[4] = ("E" if lon >= 0 else "W"), (abs(lon), 0.0, 0.0)
        gps[5], gps[6] = 0, 300.0
        im = _textured((800, 600), (90, 120, 150))
        shift = 0 if lon < 11.5 else 300  # distinct pictures: no near duplicates
        ImageDraw.Draw(im).rectangle([shift, 450, shift + 90, 590], fill=(0, 0, 0))
        return _jpeg(tmp_path / name, im, exif)

    near = with_gps("near.jpg", 11.0, 48.0)
    far = with_gps("far.jpg", 12.0, 48.0)
    nogps = _jpeg(tmp_path / "nogps.jpg", _textured((900, 600), (92, 120, 150)))
    r = ingest_photos([near, far, nogps], tmp_path / "out", 400, 10)
    assert abs(distance_m(11.0, 48.0, 12.0, 48.0) - 74_400) < 1000
    flag_far_cameras(r, (11.0005, 48.0005))
    by = {i["original"]: i for i in r.items}
    assert r.identity["sameAsset"] is False
    assert r.identity["conflicts"][0]["imageIds"] == [by[str(far)]["id"]]
    assert by[str(far)]["review"].startswith("identity: camera is")
    for p in (near, nogps):  # one is in range, one has no GPS: neither is judged by position
        assert not by[str(p)].get("review", "").startswith("identity")


def test_cancellation_is_checked_between_photos(tmp_path):
    import pytest

    shots = synth_photos(tmp_path / "s", n=3, seed=2)
    calls = []

    def check():
        calls.append(1)
        if len(calls) == 2:
            raise RuntimeError("cancelled")

    with pytest.raises(RuntimeError, match="cancelled"):
        ingest_photos(shots, tmp_path / "out", 400, 10, check)
