"""bentley_synth.py: the synthetic Bentley block, its photos and a tiny .zpc (no client data)."""

import json
import struct
import subprocess
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

import numpy as np

import bentley_synth as bs


def test_the_block_names_four_photos_one_unaligned_and_writes_three_jpgs(tmp_path):
    out = bs.make_block(tmp_path)
    root = ET.parse(out["xml"]).getroot()
    assert root.tag == "BlocksExchange" and root.get("version") == "3.2"
    photos = root.findall("Block/Photogroups/Photogroup/Photo")
    assert len(photos) == 4
    assert sum(p.find("Pose/Rotation") is None for p in photos) == 1
    jpgs = sorted(p.name for p in Path(out["photos"]).rglob("*") if p.suffix.lower() == ".jpg")
    assert jpgs == ["IMG_0001.JPG", "IMG_0003.JPG", "img_0002.jpg"]


def test_every_matrix_cell_in_the_xml_is_a_plain_float(tmp_path):
    out = bs.make_block(tmp_path)
    cells = [e for e in ET.parse(out["xml"]).getroot().iter() if e.tag.startswith("M_")]
    assert len(cells) == 9 * 6  # three posed photos, each a pose and a metadata rotation
    for e in cells:
        float(e.text)  # np.float64(...) reprs would raise here


def test_every_posed_camera_sees_the_target_inside_its_image(tmp_path):
    out = bs.make_block(tmp_path)
    for R, C in out["poses"].values():
        uv = bs.bentley_project(R, C, np.array([bs.TARGET]))[0]
        assert 0 < uv[0] < bs.W and 0 < uv[1] < bs.H


def test_the_zpc_is_a_zip_of_las_tiles_with_the_points_asked_for(tmp_path):
    z = bs.make_zpc(tmp_path / "cloud.zpc", tiles=2, points=300)
    with zipfile.ZipFile(z["zpc"]) as f:
        names = sorted(f.namelist())
        assert names == ["Tile_1.las", "Tile_2.las"]
        assert all(f.read(n)[:4] == b"LASF" for n in names)
    assert z["points"] == 600


def test_the_zpc_tiles_carry_the_creation_day_in_their_las_header(tmp_path):
    z = bs.make_zpc(tmp_path / "cloud.zpc", tiles=2, points=50)
    assert z["headerDay"] == "2026-10-12"
    with zipfile.ZipFile(z["zpc"]) as f:
        for n in f.namelist():
            assert struct.unpack_from("<HH", f.read(n), 90) == (285, 2026)
    other = bs.make_zpc(tmp_path / "other.zpc", tiles=1, points=50, created=(2025, 60))
    assert other["headerDay"] == "2025-03-01"
    with zipfile.ZipFile(other["zpc"]) as f:
        assert struct.unpack_from("<HH", f.read("Tile_1.las"), 90) == (60, 2025)


def test_the_cli_prints_the_fixture_paths(tmp_path):
    here = Path(bs.__file__).resolve()
    line = subprocess.run(
        [sys.executable, str(here), str(tmp_path / "fx")], capture_output=True, text=True, check=True
    ).stdout.strip()
    info = json.loads(line)
    assert Path(info["xml"]).is_file() and Path(info["photos"]).is_dir() and Path(info["zpc"]).is_file()
    assert info["headerDay"] == "2026-10-12"
