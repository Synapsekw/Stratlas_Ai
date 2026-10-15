"""Streaming over a LAS 1.4 file: chunks, classes, and a filtered copy with a rewritten header."""

import struct

import numpy as np
import pytest

from aio_pipelines.change.las import read_las
from aio_pipelines.pointcloud_cleanup.lasstream import class_histogram, filter_las, read_head
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


def test_filter_of_nothing_kept_writes_an_empty_cloud(tmp_path):
    xyz, cls, _ = planted_cloud(ground_step=4.0, high=0, low=0)
    src = write_las14(tmp_path / "a.las", xyz, cls)
    counts = filter_las(src, tmp_path / "b.las", lambda p, c: (np.zeros(len(p), bool), c))
    assert counts["points_out"] == 0
    assert read_head(tmp_path / "b.las").count == 0
