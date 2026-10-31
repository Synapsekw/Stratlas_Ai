"""prepare_las with a row-major 4 x 4 `matrix` (a Flyability flight's own transform), synthetic."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from aio_pipelines import pointcloud as pc
from aio_pipelines.pointcloud import find_pdal, prepare_las
from aio_pipelines.runtime import Step
from aio_pipelines.volumetric.cloud import read_las_chunks
from conftest import run_job
from flyability_synth import YAW_20_SHIFT, _write_las

PDAL = find_pdal()
POINTS = np.array([[0.0, 0.0, 0.0], [1.0, 2.0, 3.0], [-4.5, 0.25, 1.125]])


class _Prepare:
    """A one-step pipeline that runs prepare_las on `src` into the staging folder."""

    name = "test.prepare"
    title = "prepare"
    description = "prepare"

    def __init__(self, src, matrix):
        self.src, self.matrix = src, matrix

    def validate(self, params):
        return params

    def plan(self, params):
        def run(ctx):
            dst = ctx.stage("out.las")
            prepare_las(ctx, PDAL or "pdal", self.src, dst, None, 3, (0.0, 1.0), matrix=self.matrix)
            if dst.stat().st_size < 375:  # a stand-in written by a faked PDAL
                return {}
            x, y, z, _ = next(read_las_chunks(dst))
            return {"points": np.column_stack([x, y, z]).tolist()}

        return [Step("prepare", "Prepare", run)]


def _project(tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    (root / "manifest.json").write_text("{}", "utf-8")
    return root


def _expected() -> np.ndarray:
    m = np.array(YAW_20_SHIFT).reshape(4, 4)
    return POINTS @ m[:3, :3].T + m[:3, 3]


def test_the_matrix_becomes_a_transformation_stage_before_the_writer(tmp_path, monkeypatch):
    src = tmp_path / "in.las"
    _write_las(src, POINTS)
    seen = {}

    def fake_run(ctx, args, what, band=(0.0, 0.0), measure=None):
        seen["pipeline"] = json.loads(Path(args[2]).read_text("utf-8"))["pipeline"]
        seen["what"] = what
        ctx.stage("out.las").write_bytes(b"LASF")
        return ""

    monkeypatch.setattr(pc, "_run", fake_run)
    result, _ = run_job(_Prepare(src, YAW_20_SHIFT), _project(tmp_path), {})
    assert result["status"] == "done", result
    stages = seen["pipeline"]
    assert stages[0] == str(src)
    assert stages[1] == {
        "type": "filters.transformation",
        "matrix": " ".join(repr(float(v)) for v in YAW_20_SHIFT),
    }
    writer = stages[2]
    assert writer["type"] == "writers.las"
    assert "a_srs" not in writer  # no CRS and no reprojection without an EPSG code
    assert all(writer[f"scale_{a}"] == 0.001 for a in "xyz")  # millimetres survive the move
    assert not any(s.get("type") == "filters.reprojection" for s in stages if isinstance(s, dict))


def test_without_a_matrix_the_pipeline_is_unchanged(tmp_path, monkeypatch):
    src = tmp_path / "in.las"
    _write_las(src, POINTS)
    seen = {}

    def fake_run(ctx, args, what, band=(0.0, 0.0), measure=None):
        seen["pipeline"] = json.loads(Path(args[2]).read_text("utf-8"))["pipeline"]
        ctx.stage("out.las").write_bytes(b"LASF")
        return ""

    monkeypatch.setattr(pc, "_run", fake_run)
    result, _ = run_job(_Prepare(src, None), _project(tmp_path), {})
    assert result["status"] == "done", result
    assert len(seen["pipeline"]) == 2 and seen["pipeline"][1]["type"] == "writers.las"


@pytest.mark.skipif(PDAL is None, reason="PDAL not found (set AIO_PDAL)")
def test_prepare_las_applies_matrix(tmp_path):
    src = tmp_path / "in.las"
    _write_las(src, POINTS)
    result, _ = run_job(_Prepare(src, YAW_20_SHIFT), _project(tmp_path), {})
    assert result["status"] == "done", result
    got = np.array(result["outputs"]["prepare"]["points"])
    assert np.allclose(got, _expected(), atol=0.001)
