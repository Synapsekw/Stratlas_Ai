"""Local-only checks of ``walk.process`` on real footage; never in CI, no footage in git.

- ``QUADRION_WALK_REFERENCE``: a 360 camera file on this machine (the founder's reference walk).
  The job runs on it into a temporary project: every SfM still registers, the orientation is
  finite and a levelled copy is written.
- ``QUADRION_WALK_BENCH``: a long walk for the benchmark (``scripts/walk_bench.py``). Heavy; only
  in a window the founder gives.

Both skip when their variable is unset.
"""

from __future__ import annotations

import importlib.util
import json
import os
import struct
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "walk_bench.py"


def _bench():
    spec = importlib.util.spec_from_file_location("walk_bench", SCRIPT)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _clip(var: str) -> Path:
    v = os.environ.get(var)
    if not v:
        pytest.skip(f"{var} is not set (local only)")
    p = Path(v)
    if not p.is_file():
        pytest.skip(f"{var} does not name a file")
    return p


@pytest.mark.timeout(3600)
def test_reference_walk_processes_completely(tmp_path):
    clip = _clip("QUADRION_WALK_REFERENCE")
    bench = _bench()
    report = bench.run(clip, tmp_path, keep=True)
    project = next(tmp_path.glob("walk-bench-*/project"))
    folder = next((project / "walks").iterdir())
    record = json.loads((folder / "process.json").read_text(encoding="utf-8"))
    assert record["path"]["source"] == "sfm", report
    assert record["path"]["registeredFraction"] == 1.0, report
    assert record["stabilize"]["levelled"] is True
    assert (folder / "stabilized.mp4").stat().st_size > 0
    data = (folder / "orientation.bin").read_bytes()
    assert len(data) % 20 == 0 and data
    for rec in struct.iter_unpack("<5f", data[: 20 * 200]):
        assert all(v == v and abs(v) < 1e6 for v in rec)


@pytest.mark.timeout(7200)
def test_benchmark_long_walk(tmp_path):
    clip = _clip("QUADRION_WALK_BENCH")
    report = _bench().run(clip, tmp_path)
    print(json.dumps(report, indent=1))
    assert report["totalSeconds"] > 0
