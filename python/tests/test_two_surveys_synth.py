"""The synthetic two-survey site: the default scene is unchanged, the truth agrees with the scene."""

from __future__ import annotations

import atexit
import functools
import hashlib
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import products_synth as ps
import pytest
import two_surveys_synth as ts

# sha256 of the first image of make_scene(step=0.1), computed before the Variant refactor
DEFAULT_FIRST_IMAGE = "e7168dfc3ad0d4cefb0e9c148751fda74f001813d4af99d3bbd2e31e7fbe6667"
REPO = Path(__file__).resolve().parents[2]


@functools.cache
def project() -> tuple[Path, dict]:
    root = Path(tempfile.mkdtemp(prefix="aio-two-surveys-"))
    atexit.register(shutil.rmtree, root, True)
    return root, ts.write_project(root, step=0.1)


def test_default_scene_unchanged():
    scene = ps.make_scene(step=0.1)
    assert hashlib.sha256(scene.images[0].tobytes()).hexdigest() == DEFAULT_FIRST_IMAGE


def test_project_layout():
    root, res = project()
    assert res["runs"] == {"c1": ts.RUN1, "c2": ts.RUN2}
    manifest = json.loads((root / "manifest.json").read_text("utf-8"))
    assert [(c["id"], c["date"]) for c in manifest["captures"]] == [
        ("c1", "2026-10-07"),
        ("c2", "2026-10-21"),
    ]
    for cap, run in res["runs"].items():
        rdir = root / "photogrammetry" / run
        doc = json.loads((rdir / "run.json").read_text("utf-8"))
        assert doc["id"] == run
        assert (rdir / "sparse").is_dir()
        assert (rdir / "sparse" / "frame.json").is_file()
        assert (rdir / "sparse" / "photos.json").is_file()
        folder = root / f"photos-{cap}"
        assert doc["photos"]["source"]["folders"] == [str(folder)]
        assert len(list(folder.glob("*.jpg"))) == 16
        listing = json.loads((rdir / "sparse" / "photos.json").read_text("utf-8"))
        assert listing["imageRoot"] == str(folder)
    assert json.loads((root / "truth.json").read_text("utf-8")) == res["truth"]


def _north(points):
    """Truth points (x, z south) as (x, y north), the scene functions' frame."""
    return np.array([[p[0], -p[1]] for p in points], dtype=np.float64)


def test_truth_agrees_with_scene():
    _, res = project()
    t = res["truth"]
    before, after = ts.variants()
    shed = _north(t["shed"]["outlineLocal"])
    cx, cy = shed.mean(axis=0)
    at = (np.array([cx]), np.array([cy]))
    assert (ps.dsm(*at, after) - ps.dsm(*at, before))[0] == pytest.approx(3.0, abs=0.3)
    og = _north(t["openGround"])
    d = ps.dsm(og[:, 0], og[:, 1], after) - ps.dsm(og[:, 0], og[:, 1], before)
    assert np.abs(d).max() < 1e-9
    # the shed is clear of the pile and of the box
    pcx, pcy = _north([t["pile"]["centreLocal"]])[0]
    assert np.hypot(cx - pcx, cy - pcy) > t["pile"]["radiusM"] + 10
    assert shed[:, 1].max() < ps.BOX[2] - 5
    # fill volume against a numerical integral of the DSM difference over the pile
    r = t["pile"]["radiusM"]
    g = np.arange(-r - 1, r + 1, 0.05) + 0.025
    gx, gy = np.meshgrid(g + pcx, g + pcy)
    diff = ps.dsm(gx, gy, after) - ps.dsm(gx, gy, before)
    assert diff.sum() * 0.05 * 0.05 == pytest.approx(t["pile"]["fillM3"], rel=0.02)
    assert (t["pile"]["heightFrom"], t["pile"]["heightTo"]) == (4.0, 6.0)


def test_no_client_data_in_written_project():
    root, _ = project()
    texts = "".join(p.read_text("utf-8") for p in root.rglob("*.json")).lower()
    for word in ("client", "sinohydro", "propeller", "dji_"):
        assert word not in texts
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is not installed")
    out = subprocess.run(
        [node, str(REPO / "tools" / "demo" / "check-no-client-data.mjs"), str(root)],
        capture_output=True,
        text=True,
        timeout=120,
    )
    # the project sits in this machine's temp folder, so its own paths are not findings
    findings = [
        line
        for line in (out.stdout + out.stderr).splitlines()
        if line.strip().startswith("- ") and "a path of the build machine" not in line
    ]
    assert findings == [], out.stdout + out.stderr
