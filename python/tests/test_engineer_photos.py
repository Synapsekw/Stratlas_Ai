"""Photo ingestion: orientation, duplicates, caps, privacy, identity."""

from __future__ import annotations

import json

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter

from aio_pipelines.engineer.photos import ingest_photos
from synth_assets import synth_photos


def _jpeg(path, im, exif=None):
    im.save(path, "JPEG", quality=90, **({"exif": exif} if exif else {}))
    return path


def test_exif_rotated_photo_comes_out_upright(tmp_path):
    exif = Image.Exif()
    exif[0x0112] = 6
    landscape = Image.new("RGB", (1600, 1200), (120, 140, 160))
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
            paths.append(_jpeg(tmp_path / f"p{k}.jpg", im.filter(ImageFilter.GaussianBlur(3 * k))))
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
    p = _jpeg(tmp_path / "g.jpg", Image.new("RGB", (800, 600), (90, 120, 150)), exif)
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
