"""``pano.stitch`` geometry and frame reading (plan 2026-10-13-drone-panoramas-p1, task 3)."""

from __future__ import annotations

import math

import cv2
import numpy as np
import pytest

import pano_synth as ps
from aio_pipelines.pano.frames import (
    FrameError,
    encode_jpeg,
    list_frames,
    read_frame_info,
    read_gimbal,
    read_image,
)
from aio_pipelines.pano.geometry import (
    angle_deg,
    dirs_to_canvas,
    equirect_dirs,
    focal_px,
    gimbal_from_rot,
    nearest_rotation,
    pixels_to_rays,
    rot_from_gimbal,
    rotvecs_to_matrices,
)


def test_level_north_camera_looks_north_with_down_down():
    r = rot_from_gimbal(0, 0, 0)
    assert np.allclose(r[:, 2], [0, 1, 0])  # forward: north
    assert np.allclose(r[:, 0], [1, 0, 0])  # right: east
    assert np.allclose(r[:, 1], [0, 0, -1])  # down: down


def test_yaw_is_clockwise_from_north_and_pitch_is_up():
    assert np.allclose(rot_from_gimbal(90, 0, 0)[:, 2], [1, 0, 0], atol=1e-12)
    assert np.allclose(rot_from_gimbal(0, -90, 0)[:, 2], [0, 0, -1], atol=1e-12)
    assert np.allclose(rot_from_gimbal(0, 30, 0)[:, 2], [0, math.cos(math.radians(30)), 0.5])


@pytest.mark.parametrize("angles", [(30, -35, 2), (-170, 20, -1), (10, -89, 0.5), (179.5, 0, 0)])
def test_gimbal_angles_round_trip(angles):
    r = rot_from_gimbal(*angles)
    assert np.allclose(r.T @ r, np.eye(3)) and math.isclose(np.linalg.det(r), 1.0)
    assert np.allclose(gimbal_from_rot(r), angles, atol=1e-9)


def test_rotation_helpers():
    v = np.array([[0.1, -0.2, 0.3], [0.0, 0.0, 0.0]])
    m = rotvecs_to_matrices(v)
    assert np.allclose(m[0], cv2.Rodrigues(v[0])[0]) and np.allclose(m[1], np.eye(3))
    noisy = rot_from_gimbal(10, 20, 30) + 0.01
    assert angle_deg(nearest_rotation(noisy), rot_from_gimbal(10, 20, 30)) < 1.0
    assert angle_deg(rot_from_gimbal(0, 0, 0), rot_from_gimbal(5, 0, 0)) == pytest.approx(5.0)


def test_focal_from_the_35mm_equivalent_uses_the_diagonal():
    assert focal_px(28, 5472, 3648) == pytest.approx(4256.0, abs=0.1)
    assert focal_px(24, 5280, 3956) == pytest.approx(3659.7, abs=0.1)


def test_canvas_centre_looks_north_and_round_trips():
    d = equirect_dirs(360, 180, 0, 0, 360, 180)
    assert np.allclose(
        d[90, 180],
        [math.sin(math.radians(0.5)), math.cos(math.radians(0.5)), -math.sin(math.radians(0.5))],
        atol=1e-4,
    )
    u, v = dirs_to_canvas(d, 360, 180)
    assert np.allclose(u[10:170], np.arange(360)[None], atol=1e-3)
    assert np.allclose(v[10:170], np.arange(10, 170)[:, None], atol=1e-3)


def test_pixel_rays_through_the_principal_point_look_forward():
    rays = pixels_to_rays(np.array([[319.5, 213.0], [639, 213.0]]), 500.0, 640, 427)
    assert np.allclose(rays[0], [0, 0, 1])
    assert rays[1][0] > 0 and math.isclose(np.linalg.norm(rays[1]), 1.0)


def test_xmp_gimbal_in_attribute_and_element_form():
    attr = b'<rdf:Description drone-dji:GimbalYawDegree="-45.1" drone-dji:GimbalPitchDegree="-35.0"/>'
    assert read_gimbal(attr) == (-45.1, -35.0, 0.0)
    elem = (
        b"<drone-dji:GimbalYawDegree>12.5</drone-dji:GimbalYawDegree>"
        b"<drone-dji:GimbalPitchDegree>+20</drone-dji:GimbalPitchDegree>"
        b"<drone-dji:GimbalRollDegree>0.3</drone-dji:GimbalRollDegree>"
    )
    assert read_gimbal(elem) == (12.5, 20.0, 0.3)
    assert read_gimbal(b"<x:xmpmeta/>") is None


def test_reads_a_synthetic_frame_under_a_non_ascii_folder(tmp_path):
    folder = tmp_path / "Projet été"
    frames = ps.make_sphere(folder, "rows", frame_w=320, seed=2)
    info = read_frame_info(frames[0].path)
    assert (info.width, info.height, info.focal35) == (320, 213, 28.0)
    assert (info.yaw, info.pitch, info.roll) == pytest.approx(frames[0].gimbal, abs=1e-5)
    img = read_image(frames[0].path, 0.5)
    assert img.shape == (106, 160, 3)
    assert [p.name for p in list_frames(folder)][:2] == ["SYN_0001.JPG", "SYN_0002.JPG"]


def test_frames_without_gimbal_angles_or_focal_length_are_refused(tmp_path):
    plain = tmp_path / "plain.jpg"
    plain.write_bytes(encode_jpeg(np.full((40, 60, 3), 90, np.uint8), 90))
    with pytest.raises(FrameError, match="No gimbal angles"):
        read_frame_info(plain)
    broken = tmp_path / "broken.jpg"
    broken.write_bytes(b"not a jpeg")
    with pytest.raises(FrameError, match="Could not be read"):
        read_frame_info(broken)
    no_focal = tmp_path / "no_focal.jpg"
    data = encode_jpeg(np.full((40, 60, 3), 90, np.uint8), 90)
    xmp = ps.xmp_packet({"GimbalYawDegree": 1.0, "GimbalPitchDegree": -10.0})
    seg = b"\xff\xe1" + (len(xmp) + 2).to_bytes(2, "big") + xmp
    no_focal.write_bytes(data[:2] + seg + data[2:])
    with pytest.raises(FrameError, match="No 35 mm focal length"):
        read_frame_info(no_focal)
