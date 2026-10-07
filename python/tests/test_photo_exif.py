"""photo/exif.py: EXIF and DJI XMP (GPS, gimbal, RTK), inspection verdicts, PPK, folder keys."""

import numpy as np
import pytest

from aio_pipelines.photo.exif import (
    GNSS_SIGMA,
    apply_ppk,
    inspect_photos,
    list_folder_photos,
    read_photo,
    read_ppk,
)
from aio_pipelines.runtime import JobError
from photo_g2_synth import SITE_LAT, SITE_LON, synthetic_jpeg


def _pix(seed, size=(160, 120)):
    return np.random.default_rng(seed).integers(0, 255, (size[1], size[0], 3), dtype=np.uint8)


def test_dji_style_tags_are_read(tmp_path):
    p = synthetic_jpeg(
        tmp_path / "a.jpg",
        alt=72.5,
        rel=60.25,
        yaw=12.5,
        pitch=-65.0,
        roll=0.3,
        rtk_flag=50,
        rtk_std=(0.011, 0.012, 0.021),
    )
    m = read_photo("a.jpg", p)
    assert m.error is None and (m.width, m.height) == (160, 120)
    assert (m.make, m.model) == ("Stratlas Synthetic", "SYN-20")
    assert m.lat == pytest.approx(SITE_LAT, abs=1e-7) and m.lon == pytest.approx(SITE_LON, abs=1e-7)
    assert m.abs_alt == pytest.approx(72.5) and m.rel_alt == pytest.approx(60.25)
    assert (m.yaw, m.pitch, m.roll) == (12.5, -65.0, 0.3)
    assert m.rtk_flag == 50 and m.rtk_std == (0.011, 0.012, 0.021)
    assert m.focal_mm == pytest.approx(8.8) and m.focal35 == 24
    assert m.blur is not None and m.dhash is not None


@pytest.mark.parametrize(
    ("flag", "kind"), [(50, "fixed"), (34, "float"), (16, "standard"), (0, "standard"), (None, "standard")]
)
def test_rtk_flags_map_to_solution_kinds(tmp_path, flag, kind):
    m = read_photo("a.jpg", synthetic_jpeg(tmp_path / "a.jpg", rtk_flag=flag))
    assert m.gnss_kind() == kind
    assert m.gnss_sigma("auto") == GNSS_SIGMA[kind]
    assert m.gnss_sigma("rtk") == GNSS_SIGMA["fixed"] and m.gnss_sigma("standard") == GNSS_SIGMA["standard"]
    assert m.gnss_sigma("ignore") is None


def test_rtk_standard_deviations_set_the_prior(tmp_path):
    m = read_photo("a.jpg", synthetic_jpeg(tmp_path / "a.jpg", rtk_flag=50, rtk_std=(0.03, 0.04, 0.06)))
    h, v = m.gnss_sigma("auto")
    assert h == pytest.approx(0.05 / 2**0.5)  # the horizontal sigma per axis of a 3-4-5 ellipse
    assert v == pytest.approx(0.06)


def test_inspection_rejects_and_warns_with_names(tmp_path):
    good = [synthetic_jpeg(tmp_path / f"p{i}.jpg", lat=SITE_LAT + i * 1e-4, pixels=_pix(i)) for i in range(6)]
    nogps = synthetic_jpeg(tmp_path / "nogps.jpg", lat=None, lon=None, pixels=_pix(10))
    pano = synthetic_jpeg(tmp_path / "pano.jpg", size=(400, 100), pixels=_pix(11, (400, 100)))
    dup = tmp_path / "copy.jpg"
    dup.write_bytes(good[0].read_bytes())
    corrupt = tmp_path / "broken.jpg"
    corrupt.write_bytes(good[1].read_bytes()[:900])
    keys = [p.name for p in [*good, nogps, pano, dup, corrupt]]
    metas = [read_photo(k, tmp_path / k) for k in keys]
    insp = inspect_photos(metas)
    rejected = {r["name"]: r["reason"] for r in insp.rejected}
    assert set(rejected) == {"pano.jpg", "copy.jpg", "broken.jpg"}
    assert "panorama" in rejected["pano.jpg"].lower()
    assert "p0.jpg" in rejected["copy.jpg"]
    assert "cannot be" in rejected["broken.jpg"]
    assert any("no GPS" in w and "nogps.jpg" in w for w in insp.warnings)
    assert {m.key for m in insp.photos} == {*(p.name for p in good), "nogps.jpg"}


def test_mixed_cameras_and_blur_are_warned(tmp_path):
    metas = []
    for i in range(6):
        metas.append(read_photo(f"a{i}", synthetic_jpeg(tmp_path / f"a{i}.jpg", pixels=_pix(i))))
    blurred = np.full((120, 160, 3), 128, np.uint8)
    metas.append(read_photo("flat", synthetic_jpeg(tmp_path / "flat.jpg", pixels=blurred)))
    metas.append(read_photo("other", synthetic_jpeg(tmp_path / "o.jpg", model="SYN-40", pixels=_pix(20))))
    insp = inspect_photos(metas)
    assert any("2 cameras" in w for w in insp.warnings)
    assert any("blurred" in w and "flat" in w for w in insp.warnings)


def test_a_file_that_is_not_an_image_is_rejected_not_raised(tmp_path):
    p = tmp_path / "x.jpg"
    p.write_bytes(b"not a jpeg at all")
    m = read_photo("x.jpg", p)
    assert m.error and "cannot be read" in m.error


def test_folders_with_repeating_file_names_get_distinct_keys(tmp_path):
    for folder in ("100MEDIA", "101MEDIA"):
        for i in (1, 2):
            synthetic_jpeg(tmp_path / "DCIM" / folder / f"DJI_{i:04d}.JPG", pixels=_pix(i))
    listed = list_folder_photos([tmp_path / "DCIM" / "100MEDIA", tmp_path / "DCIM" / "101MEDIA"])
    keys = [k for k, _ in listed]
    assert keys == [
        "100MEDIA/DJI_0001.JPG",
        "100MEDIA/DJI_0002.JPG",
        "101MEDIA/DJI_0001.JPG",
        "101MEDIA/DJI_0002.JPG",
    ]
    single = list_folder_photos([tmp_path / "DCIM" / "100MEDIA"])
    assert [k for k, _ in single] == ["DJI_0001.JPG", "DJI_0002.JPG"]
    with pytest.raises(JobError, match="does not exist"):
        list_folder_photos([tmp_path / "nowhere"])


def test_ppk_positions_replace_exif_ones(tmp_path):
    a = read_photo("100MEDIA/a.jpg", synthetic_jpeg(tmp_path / "a.jpg"))
    b = read_photo("100MEDIA/b.jpg", synthetic_jpeg(tmp_path / "b.jpg"))
    csv = tmp_path / "ppk.csv"
    csv.write_text("image,lat,lon,h,sh,sv\nb.jpg,25.2,51.5,40.5,0.02,0.03\n", "utf-8")
    n = apply_ppk([a, b], read_ppk(csv))
    assert n == 1 and b.ppk and b.lat == 25.2 and b.abs_alt == 40.5 and b.gnss_kind() == "fixed"
    assert not a.ppk
    bad = tmp_path / "bad.csv"
    bad.write_text("b.jpg,95,51,1,0.1,0.1\n", "utf-8")
    with pytest.raises(JobError, match="impossible"):
        read_ppk(bad)
