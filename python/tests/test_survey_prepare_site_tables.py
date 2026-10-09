"""survey.prepare's site tables on a calibrated site (M11 G1 with G2 and G7, data-conventions 25).

The renderer reads the cursor and every readout through the tables ``survey.prepare`` writes
(``survey/geodesy/site-transform.json``); every export goes through G7's frame (G1's
``site_pipeline``). On a calibrated site the two must agree: a readout and an export of the same
point give the same site-grid coordinates. Analytic truths only: G1's synthetic geoid and its known
calibration (``geodesy_synth.py``) over the synthetic yard of ``imagery_synth.py``.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from aio_pipelines.export.frame import build_frame  # noqa: E402
from aio_pipelines.pipelines import all_pipelines  # noqa: E402
from conftest import run_job  # noqa: E402
from geodesy_synth import GEOID_ID, fixture_sites, synthetic_geoid  # noqa: E402
from imagery_synth import ORIGIN, surface_project  # noqa: E402

SURFACES = {
    "surfaces": [
        {"id": "dsm-c1", "name": "DSM c1", "source": {"kind": "dsm", "layer": "surf-a"}, "capture": "c1"},
        {"id": "dsm-c2", "name": "DSM c2", "source": {"kind": "dsm", "layer": "surf-b"}, "capture": "c2"},
    ]
}


def write(p: Path, v) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(v, indent=1), encoding="utf-8", newline="")


def header(root: Path) -> dict:
    return json.loads((root / "survey" / "geodesy" / "site-transform.json").read_text("utf-8"))


def table(root: Path, h: dict, key: str) -> np.ndarray:
    g = h[key]
    raw = np.frombuffer((root / "survey" / "geodesy" / g["file"]).read_bytes(), dtype="<f8")
    return raw.reshape(g["rows"], g["cols"], g["bands"])


def bilinear(t: np.ndarray, g: dict, e: np.ndarray, n: np.ndarray) -> np.ndarray:
    """What the renderer does (``@aio/geo`` ``createSiteTransform``): bilinear between the nodes."""
    fx = (e - g["originX"]) / g["spacingM"]
    fy = (n - g["originY"]) / g["spacingM"]
    c0 = np.clip(np.floor(fx).astype(int), 0, g["cols"] - 2)
    r0 = np.clip(np.floor(fy).astype(int), 0, g["rows"] - 2)
    tx, ty = (fx - c0)[:, None], (fy - r0)[:, None]
    a, b = t[r0, c0], t[r0, c0 + 1]
    c, d = t[r0 + 1, c0], t[r0 + 1, c0 + 1]
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty


@pytest.fixture
def calibrated(tmp_path, monkeypatch):
    geoids = tmp_path / "geoids"
    synthetic_geoid(geoids)
    monkeypatch.setenv("QUADRION_GEOID_DIRS", str(geoids))
    site = fixture_sites(geoids)["calibrated-local"]
    root = tmp_path / "proj"
    root.mkdir()
    surface_project(root)
    write(root / "survey" / "settings.json", site["settings"])
    cal = {**site["calibration"], "appliedAt": "2026-10-09T08:00:00Z", "appliedBy": "surveyor"}
    write(root / "survey" / "calibration.json", cal)
    return root, site, cal


def test_readout_tables_on_a_calibrated_site_match_the_export_frame_within_a_millimetre(calibrated):
    root, _, cal = calibrated
    result, _ = run_job(all_pipelines()["survey.prepare"], root, SURFACES)
    assert result["outputs"]["geodesy"]["written"] is True
    h = header(root)
    assert h["calibration"] == cal["id"] and h["geoid"] == GEOID_ID
    assert "site calibration" in h["operation"]

    rng = np.random.default_rng(7)
    e = ORIGIN[0] - 29.5 + 59.0 * rng.random(200)
    n = ORIGIN[1] - 29.5 + 59.0 * rng.random(200)
    z = 40.0 + 10.0 * rng.random(200)
    # G7's export frame: the site grid, calibrated, in metres
    frame = build_frame(root, "site", "csv", "m")
    assert frame.calibrated and frame.meta["calibration"]
    want_e, want_n, want_z = frame.forward(e, n, z)

    grid = bilinear(table(root, h, "grid"), h["grid"], e, n)
    assert np.max(np.abs(grid[:, 0] - want_e)) < 1e-3
    assert np.max(np.abs(grid[:, 1] - want_n)) < 1e-3
    # the renderer's height is the stored height minus N_eff (geoid and the calibration's plane)
    n_eff = bilinear(table(root, h, "geoidGrid"), h["geoidGrid"], e, n)[:, 0]
    assert np.max(np.abs((z - n_eff) - want_z)) < 1e-3
    # and the calibration is not a no-op here: an uncalibrated readout would be kilometres away
    assert np.min(np.hypot(grid[:, 0] - e, grid[:, 1] - n)) > 1000


def test_applying_a_calibration_rewrites_the_tables_on_the_next_run(calibrated):
    root, site, cal = calibrated
    draft = {k: v for k, v in cal.items() if k not in ("appliedAt", "appliedBy")}
    write(root / "survey" / "calibration.json", draft)
    # a draft (not applied) is never used, even when the settings name it
    shown = {**site["settings"], "verticalDatum": {"kind": "geoid", "geoid": GEOID_ID}}
    write(root / "survey" / "settings.json", shown)
    run_job(all_pipelines()["survey.prepare"], root, SURFACES)
    before = header(root)
    assert "calibration" not in before

    # Apply (what main's geodesy:applyCalibration writes), then the app's re-run: the surfaces are
    # unchanged and skipped, the tables are written again through the calibration
    write(root / "survey" / "calibration.json", cal)
    write(root / "survey" / "settings.json", site["settings"])
    result, _ = run_job(all_pipelines()["survey.prepare"], root, {"surfaces": SURFACES["surfaces"][:1]}, "j2")
    assert result["outputs"]["surface-1"]["skipped"] is True
    after = header(root)
    assert after["calibration"] == cal["id"] and after["fingerprint"] != before["fingerprint"]
    # one surface in the job, but the tables still cover every prepared surface
    assert after["grid"]["cols"] == before["grid"]["cols"] and after["grid"]["rows"] == before["grid"]["rows"]
    frame = build_frame(root, "site", "csv", "m")
    e, n = np.array([ORIGIN[0] + 12.25]), np.array([ORIGIN[1] - 7.75])
    want_e, want_n, _ = frame.forward(e, n, np.zeros(1))
    got = bilinear(table(root, after, "grid"), after["grid"], e, n)
    assert abs(got[0, 0] - want_e[0]) < 1e-3 and abs(got[0, 1] - want_n[0]) < 1e-3
