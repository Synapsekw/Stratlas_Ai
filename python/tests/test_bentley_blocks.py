"""bentley/blocks.py: BlocksExchange 3.x read on the synthetic block (no client data)."""

import re

import numpy as np
import pytest

import bentley_synth as bs
from aio_pipelines.bentley.blocks import is_blocks_exchange, read_block
from aio_pipelines.runtime import JobError


def test_the_block_its_srs_and_its_photogroup_are_read(tmp_path):
    out = bs.make_block(tmp_path)
    b = read_block(tmp_path / "at.xml")
    assert b.version == "3.2" and b.name == "Synthetic mast - AT"
    assert b.srs is not None and b.srs.definition == "EPSG:32639"
    (g,) = b.groups
    assert (g.width, g.height) == (bs.W, bs.H)
    assert g.focal_px == pytest.approx(bs.FOCAL_PX)
    assert (g.cx, g.cy) == bs.PP and g.k == bs.K and g.p == bs.P_BENTLEY
    assert len(b.photos) == 4 and len(b.aligned()) == 3 and [p.id for p in b.unaligned()] == ["3"]
    assert b.photos[0].image_path == "R:/survey/flight-a/IMG_0001.JPG"
    assert b.photos[1].taken == "2026-03-04T10:00:01"
    assert out["xml"].endswith("at.xml")


def test_the_pose_is_the_adjusted_one_not_the_metadata_prior(tmp_path):
    out = bs.make_block(tmp_path)
    b = read_block(tmp_path / "at.xml")
    for p in b.aligned():
        R, C = out["poses"][p.id]
        assert np.allclose(p.rotation, R) and np.allclose(p.centre, C)


def test_focal_in_pixels_wins_over_millimetres(tmp_path):
    bs.make_block(tmp_path)
    xml = (tmp_path / "at.xml").read_text("utf-8")
    xml = xml.replace("<SensorSize>", "<FocalLengthPixels>512.5</FocalLengthPixels><SensorSize>")
    (tmp_path / "at.xml").write_text(xml, "utf-8")
    assert read_block(tmp_path / "at.xml").groups[0].focal_px == 512.5


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (('<BlocksExchange version="3.2">', '<BlocksExchange version="2.1">'), "version 3"),
        (("XRightYDown", "XRightYUp"), "XRightYDown"),
        (("<M_00>", "<Omega>1</Omega><M_00>"), "rotation matrices"),
        (("<SensorSize>6.4</SensorSize>", ""), "sensor size"),
        (("<AspectRatio>1</AspectRatio>", "<AspectRatio>1.1</AspectRatio>"), "aspect ratio"),
    ],
)
def test_what_this_build_cannot_place_is_refused_in_words(tmp_path, change, message):
    bs.make_block(tmp_path)
    p = tmp_path / "at.xml"
    p.write_text(p.read_text("utf-8").replace(*change), "utf-8")
    with pytest.raises(JobError, match=message):
        read_block(p)


def test_a_rotation_that_is_not_a_rotation_is_refused_with_the_photo(tmp_path):
    bs.make_block(tmp_path)
    p = tmp_path / "at.xml"
    xml = p.read_text("utf-8")
    start = xml.index("<M_00>") + len("<M_00>")
    p.write_text(xml[:start] + "3.0" + xml[xml.index("</M_00>") :], "utf-8")
    with pytest.raises(JobError, match="IMG_0001"):
        read_block(p)


def _first(xml: str, tag: str, value: str) -> str:
    """xml with the first <tag>'s text replaced by value."""
    return re.sub(rf"<{tag}>[^<]*</{tag}>", f"<{tag}>{value}</{tag}>", xml, count=1)


@pytest.mark.parametrize("bad", ["nan", "inf", "-inf", "NaN"])
@pytest.mark.parametrize(("tag", "named"), [("x", "IMG_0001"), ("M_11", "IMG_0001"), ("cx", None)])
def test_a_number_that_is_not_finite_is_refused_with_its_photo(tmp_path, bad, tag, named):
    bs.make_block(tmp_path)
    p = tmp_path / "at.xml"
    xml = p.read_text("utf-8")
    if tag == "cx":  # the principal point's x, inside the photogroup
        tag, named = "x", "Photogroup 1"
        start = xml.index("<PrincipalPoint>")
        xml = xml[:start] + _first(xml[start:], "x", bad)
    else:  # the first photo's centre or rotation: after the photogroup's principal point
        start = xml.index("<Pose>")
        xml = xml[:start] + _first(xml[start:], tag, bad)
    p.write_text(xml, "utf-8")
    with pytest.raises(JobError, match=rf"{named}.*{tag} is not a finite number") as e:
        read_block(p)
    assert not {chr(0x2013), chr(0x2014)} & set(str(e.value))  # no en or em dash


@pytest.mark.parametrize(
    ("tag", "value", "message"),
    [
        ("FocalLength", "0", "focal length must be more than 0"),
        ("FocalLength", "-35", "focal length must be more than 0"),
        ("SensorSize", "0", "sensor size must be more than 0"),
        ("Width", "0", "image size must be more than 0"),
        ("Height", "-1", "image size must be more than 0"),
    ],
)
def test_a_size_or_focal_of_zero_or_less_is_refused_in_words(tmp_path, tag, value, message):
    bs.make_block(tmp_path)
    p = tmp_path / "at.xml"
    p.write_text(_first(p.read_text("utf-8"), tag, value), "utf-8")
    with pytest.raises(JobError, match=rf'The photogroup "Photogroup 1".*{message}'):
        read_block(p)


def test_a_focal_in_pixels_of_zero_is_refused(tmp_path):
    bs.make_block(tmp_path)
    p = tmp_path / "at.xml"
    xml = p.read_text("utf-8").replace("<SensorSize>", "<FocalLengthPixels>0</FocalLengthPixels><SensorSize>")
    p.write_text(xml, "utf-8")
    with pytest.raises(JobError, match="focal length must be more than 0"):
        read_block(p)


def test_a_blank_focal_in_pixels_falls_back_to_millimetres(tmp_path):
    bs.make_block(tmp_path)
    p = tmp_path / "at.xml"
    xml = p.read_text("utf-8").replace(
        "<SensorSize>", "<FocalLengthPixels>  </FocalLengthPixels><SensorSize>"
    )
    p.write_text(xml, "utf-8")
    assert read_block(p).groups[0].focal_px == pytest.approx(bs.FOCAL_PX)


def test_other_xml_is_not_a_block(tmp_path):
    other = tmp_path / "notes.xml"
    other.write_text('<?xml version="1.0"?><LandXML/>', "utf-8")
    assert not is_blocks_exchange(other)
    bs.make_block(tmp_path)
    assert is_blocks_exchange(tmp_path / "at.xml")
    with pytest.raises(JobError, match="not a BlocksExchange"):
        read_block(other)
