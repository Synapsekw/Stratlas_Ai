"""The synthetic drone spheres (tests/pano_synth.py): frames, metadata and the e2e folder."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np

import pano_synth as ps
from aio_pipelines.pano.frames import read_frame_info
from aio_pipelines.pano.geometry import angle_deg, rot_from_gimbal


def test_both_patterns_have_the_frame_counts_of_the_spec():
    assert len(ps.ROWS) == 25 and len(ps.BURSTS) == 22
    assert {p for _, p in ps.ROWS} == {0.0, -35.0, -70.0, -90.0}
    assert {p for _, p in ps.BURSTS} == {20.0, -17.0, -55.0, -90.0}


def test_perturbations_are_zero_mean_and_bounded():
    eps = ps.perturbations(25, 1.5, seed=4)
    assert np.allclose(eps.mean(axis=0), 0.0)
    assert np.degrees(np.abs(eps)).max() <= 3.0


def test_written_gimbal_angles_are_off_by_one_to_three_degrees(tmp_path):
    frames = ps.make_sphere(tmp_path, "bursts", frame_w=320, seed=3)
    errors = []
    for f in frames:
        info = read_frame_info(f.path)
        errors.append(angle_deg(rot_from_gimbal(info.yaw, info.pitch, info.roll), f.truth))
    assert 0.5 < max(errors) < 4.5
    assert (read_frame_info(frames[0].path).width, read_frame_info(frames[0].path).height) == (320, 240)


def test_file_numbers_wrap_after_0999(tmp_path):
    frames = ps.make_sphere(tmp_path, "rows", frame_w=160, first_no=990, seed=1)
    names = [f.path.name for f in frames]
    assert names[9] == "SYN_0999.JPG" and names[10] == "SYN_0001.JPG"


def test_the_e2e_folder_script(tmp_path):
    script = Path(ps.__file__)
    out = subprocess.run(
        [sys.executable, str(script), str(tmp_path / "card"), "--lat", "28.9", "--lon", "51.0"],
        capture_output=True,
        text=True,
        check=True,
        timeout=240,
    )
    summary = json.loads(out.stdout.strip().splitlines()[-1])
    assert summary["spheres"] == [25, 22, 25] and summary["strays"] == 4
    assert len(list((tmp_path / "card").glob("*.JPG"))) == 76
    first = read_frame_info(tmp_path / "card" / "SYN_0960.JPG")
    assert first.focal35 == 28.0
