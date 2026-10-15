"""Streaming over a LAS 1.4 file: chunks, classes, and a filtered copy with a rewritten header."""

import os
import struct

import numpy as np
import pytest

from aio_pipelines.change.las import read_las, write_las
from aio_pipelines.pointcloud_cleanup.lasstream import class_histogram, filter_las, read_head
from aio_pipelines.runtime import JobError
from pccleanup_synth import planted_cloud, write_las14


def test_head_and_histogram(tmp_path):
    xyz, cls, _ = planted_cloud(ground_step=2.0, high=4, low=2)
    las = write_las14(tmp_path / "a.las", xyz, cls)
    head = read_head(las)
    assert head.count == len(xyz)
    assert head.pdrf == 6
    hist = class_histogram(las)
    assert hist[2] == int((cls == 2).sum())
    assert hist.sum() == len(xyz)


def test_filter_streams_in_chunks_and_rewrites_counts_and_bounds(tmp_path):
    xyz, cls, outlier = planted_cloud(ground_step=2.0, high=4, low=2)
    src = write_las14(tmp_path / "a.las", xyz, cls)

    def rule(p, c):
        keep = p[:, 2] < 20  # the high outliers go
        out = c.copy()
        out[p[:, 2] < -3] = 7  # the low ones become noise
        return keep, out

    # a chunk of 50 points: many chunks, and the result must not depend on them
    counts = filter_las(src, tmp_path / "b.las", rule, size=50)
    keep = xyz[:, 2] < 20
    assert counts == {"points_in": len(xyz), "points_out": int(keep.sum())}
    out = read_las(tmp_path / "b.las")
    assert out.count == int(keep.sum())
    np.testing.assert_allclose(out.xyz, xyz[keep], atol=1e-3)
    assert int((out.field("Classification") == 7).sum()) == int((xyz[keep][:, 2] < -3).sum())
    raw = (tmp_path / "b.las").read_bytes()
    max_x, min_x, max_y, min_y, max_z, min_z = struct.unpack_from("<6d", raw, 179)
    assert max_z < 20
    assert min_z == pytest.approx(xyz[keep][:, 2].min(), abs=1e-3)
    assert (max_x, min_x) == pytest.approx((xyz[keep][:, 0].max(), xyz[keep][:, 0].min()), abs=1e-3)
    assert (max_y, min_y) == pytest.approx((xyz[keep][:, 1].max(), xyz[keep][:, 1].min()), abs=1e-3)
    assert struct.unpack_from("<Q", raw, 247)[0] == int(keep.sum())
    # write_las writes "return 1 of 1": every kept point counts as a first return
    assert struct.unpack_from("<15Q", raw, 255) == (int(keep.sum()), *[0] * 14)
    assert struct.unpack_from("<I", raw, 107)[0] in (0, int(keep.sum()))
    assert not list(tmp_path.glob(".*.tmp"))


def test_a_cancel_mid_stream_leaves_no_file_held_open(tmp_path):
    xyz, cls, _ = planted_cloud(ground_step=2.0, high=4, low=2)
    src = write_las14(tmp_path / "a.las", xyz, cls)
    dst = tmp_path / "b.las"
    calls = []

    def check():
        calls.append(1)
        if len(calls) == 2:
            raise RuntimeError("cancelled")

    try:
        filter_las(src, dst, lambda p, c: (np.ones(len(p), bool), c), check=check, size=50)
    except RuntimeError:
        # the caller's cleanup runs while the traceback still holds filter_las's frame
        os.remove(src)
        assert not dst.exists()
        assert not list(tmp_path.glob("*"))
    else:
        pytest.fail("the cancel did not reach the caller")


def test_a_failing_rule_leaves_no_file_held_open(tmp_path):
    xyz, cls, _ = planted_cloud(ground_step=4.0, high=0, low=0)
    src = write_las14(tmp_path / "a.las", xyz, cls)

    def rule(p, c):
        raise ValueError("bad rule")

    try:
        filter_las(src, tmp_path / "b.las", rule, size=10)
    except ValueError:
        os.remove(src)
    assert not list(tmp_path.glob("*"))


def test_class_values_out_of_range_are_refused(tmp_path):
    xyz, cls, _ = planted_cloud(ground_step=4.0, high=0, low=0)
    src = write_las14(tmp_path / "a.las", xyz, cls)
    with pytest.raises(JobError, match="0 to 255"):
        filter_las(src, tmp_path / "b.las", lambda p, c: (np.ones(len(p), bool), c.astype(np.int64) + 300))
    assert not (tmp_path / "b.las").exists()


@pytest.mark.parametrize("pdrf", [7, 8])
def test_point_formats_7_and_8(tmp_path, pdrf):
    xyz, cls, _ = planted_cloud(ground_step=4.0, high=2, low=2)
    src = tmp_path / "a.las"
    write_las(src, xyz, pdrf=pdrf, classification=cls, rgb=np.full((len(xyz), 3), 1000))
    assert read_head(src).pdrf == pdrf
    assert class_histogram(src)[1] == 4
    counts = filter_las(
        src, tmp_path / "b.las", lambda p, c: (c != 1, np.where(c == 6, 7, c).astype(np.uint8))
    )
    out = read_las(tmp_path / "b.las")
    assert counts["points_out"] == out.count == int((cls != 1).sum())
    assert out.pdrf == pdrf
    np.testing.assert_allclose(out.xyz, xyz[cls != 1], atol=1e-3)
    assert int((out.field("Classification") == 7).sum()) == int((cls == 6).sum())
    assert (out.records[:, 30:36].view("<u2") == 1000).all()


def test_a_zero_point_source(tmp_path):
    src = tmp_path / "a.las"
    write_las(src, np.zeros((0, 3)), pdrf=6, classification=np.zeros(0, np.uint8))
    assert read_head(src).count == 0
    assert class_histogram(src).sum() == 0
    counts = filter_las(src, tmp_path / "b.las", lambda p, c: (np.ones(len(p), bool), c))
    assert counts == {"points_in": 0, "points_out": 0}
    assert read_head(tmp_path / "b.las").count == 0


def test_a_compressed_file_is_refused(tmp_path):
    xyz, cls, _ = planted_cloud(ground_step=4.0, high=0, low=0)
    src = write_las14(tmp_path / "a.las", xyz, cls)
    raw = bytearray(src.read_bytes())
    raw[104] |= 0x80  # the LAZ bit
    src.write_bytes(bytes(raw))
    with pytest.raises(JobError, match="compressed"):
        read_head(src)


def test_a_truncated_file_is_refused(tmp_path):
    xyz, cls, _ = planted_cloud(ground_step=4.0, high=0, low=0)
    src = write_las14(tmp_path / "a.las", xyz, cls)
    src.write_bytes(src.read_bytes()[:-10])
    with pytest.raises(JobError, match="shorter"):
        read_head(src)
    src.write_bytes(src.read_bytes()[:100])
    with pytest.raises(JobError, match="not a LAS file"):
        read_head(src)


def test_filter_of_nothing_kept_writes_an_empty_cloud(tmp_path):
    xyz, cls, _ = planted_cloud(ground_step=4.0, high=0, low=0)
    src = write_las14(tmp_path / "a.las", xyz, cls)
    counts = filter_las(src, tmp_path / "b.las", lambda p, c: (np.zeros(len(p), bool), c))
    assert counts["points_out"] == 0
    assert read_head(tmp_path / "b.las").count == 0
