"""bentley/convert.py: Bentley's lens and pose in our conventions (synthetic block, no client data)."""

import math

import numpy as np
import pytest

import bentley_synth as bs
from aio_pipelines.bentley.blocks import read_block
from aio_pipelines.bentley.convert import TANGENTIAL_SWAP, block_frame, camera_pose, lens_of, lens_record
from aio_pipelines.opf.geometry import lens_to_colmap, quat_wxyz_to_matrix
from aio_pipelines.photo.model import Camera, project_points
from aio_pipelines.runtime import JobError

MANIFEST = {"crs": {"epsg": bs.EPSG}, "origin": list(bs.ORIGIN)}


def _block(tmp_path, **kw):
    out = bs.make_block(tmp_path, **kw)
    return out, read_block(tmp_path / "at.xml")


def test_the_tangential_terms_are_swapped_into_opencv(tmp_path):
    _, b = _block(tmp_path)
    lens = lens_of(b.groups[0])
    assert TANGENTIAL_SWAP is True
    assert lens.tangential == (bs.P_BENTLEY[1], bs.P_BENTLEY[0])
    assert lens.radial == bs.K and (lens.cx, lens.cy) == bs.PP


def test_a_known_point_projects_where_bentley_puts_it(tmp_path):
    out, b = _block(tmp_path)
    frame = block_frame(b, MANIFEST)
    model, params = lens_to_colmap(lens_of(b.groups[0]))
    cam = Camera(1, model, bs.W, bs.H, np.array(params))
    pts = np.array(
        [bs.TARGET, (bs.TARGET[0] + 3, bs.TARGET[1] - 2, 1.0), (bs.TARGET[0] - 4, bs.TARGET[1] + 1, 9.0)]
    )
    for p in b.aligned():
        pose = camera_pose(p, frame, bs.ORIGIN)
        R = quat_wxyz_to_matrix(pose.qvec)
        C = -R.T @ np.asarray(pose.tvec)
        ours, _ = project_points(cam, R, C, pts)
        R_b, C_b = out["poses"][p.id]
        assert np.abs(ours - bs.bentley_project(R_b, C_b, pts)).max() < 1e-6


def test_the_pose_round_trips_and_the_camera_looks_at_the_target(tmp_path):
    out, b = _block(tmp_path)
    frame = block_frame(b, MANIFEST)
    for p in b.aligned():
        pose = camera_pose(p, frame, bs.ORIGIN)
        R_b, C_b = out["poses"][p.id]
        R = quat_wxyz_to_matrix(pose.qvec)
        assert np.allclose(R, R_b, atol=1e-9)
        assert np.allclose(-R.T @ np.asarray(pose.tvec), C_b, atol=1e-6)
        # local frame: x east, y up, z south; three.js cameras look along -z of q
        e, n, h = C_b
        assert pose.pos == pytest.approx([e - bs.ORIGIN[0], h - bs.ORIGIN[2], -(n - bs.ORIGIN[1])], abs=1e-4)
        x, y, z, w = pose.q
        look = quat_wxyz_to_matrix([w, x, y, z]) @ np.array([0.0, 0.0, -1.0])
        t = np.array([bs.TARGET[0] - e, bs.TARGET[2] - h, -(bs.TARGET[1] - n)])
        assert math.degrees(math.acos(look @ t / np.linalg.norm(t))) < 0.01


def test_a_block_in_another_utm_zone_turns_with_the_grid(tmp_path):
    out, b = _block(tmp_path, srs="EPSG:32640")  # the same numbers read as UTM 40N
    frame = block_frame(b, MANIFEST)  # project in UTM 39N
    p = b.aligned()[0]
    pose = camera_pose(p, frame, bs.ORIGIN)
    R_b, _ = out["poses"][p.id]
    turned = math.degrees(math.acos((np.trace(quat_wxyz_to_matrix(pose.qvec) @ R_b.T) - 1) / 2))
    assert 0.5 < turned < 6.0  # grid convergence between the zones, a few degrees
    assert abs(pose.enh[0] - 500000) > 1000  # positions reprojected, not copied


def test_the_frame_notes_speak_of_the_block_not_opf(tmp_path):
    _, b = _block(tmp_path, srs="EPSG:32640")
    notes = block_frame(b, MANIFEST).notes
    assert notes and all("OPF" not in n for n in notes)
    assert any(n.startswith("The block CRS (EPSG:32640) differs from the project CRS") for n in notes)
    _, same = _block(tmp_path / "same")
    assert block_frame(same, MANIFEST).notes == []


@pytest.mark.parametrize("srs", ["WGS84", "EPSG:4326", "ENU:24.2,54.6", ""])
def test_a_block_without_a_projected_epsg_srs_is_refused(tmp_path, srs):
    _, b = _block(tmp_path, srs=srs)
    with pytest.raises(JobError, match="projected"):
        block_frame(b, MANIFEST)


def test_the_layer_lens_keeps_the_principal_point_and_distortion(tmp_path):
    _, b = _block(tmp_path)
    rec = lens_record(lens_of(b.groups[0]))
    assert rec["model"] == "pinhole" and rec["aspect"] == pytest.approx(bs.W / bs.H, abs=1e-6)
    assert rec["hfovDeg"] == pytest.approx(math.degrees(2 * math.atan(bs.W / (2 * bs.FOCAL_PX))), abs=1e-5)
    assert (rec["cx"], rec["cy"]) == bs.PP
    assert (rec["k1"], rec["k2"], rec["k3"]) == bs.K
    assert (rec["p1"], rec["p2"]) == (bs.P_BENTLEY[1], bs.P_BENTLEY[0])
