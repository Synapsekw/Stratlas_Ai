"""model.fit_cloud on synthetic scans with known primitives (no client data)."""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pytest

from aio_pipelines.modelfit.fit import ModelFitCloud
from aio_pipelines.runtime import INPUTS_CHANGED, JobError
from conftest import run_job

TANK = {"c": (10.0, -10.0), "r": 5.0, "h": 10.0}
BOX = {"c": (-10.0, 10.0), "size": (6.0, 2.5, 3.0), "yaw": 30.0}
PIPE = {"a": (-12.0, 1.5, -22.0), "b": (6.0, 1.5, -22.0), "d": 0.3}


def _ground(rng, slope=0.02):
    xs, zs = np.meshgrid(np.arange(-25, 25, 0.4), np.arange(-25, 25, 0.4))
    x, z = xs.ravel(), zs.ravel()
    return np.column_stack([x, slope * x + rng.normal(0, 0.01, x.size), z])


def _tank(rng, half=False, c=TANK["c"], r=TANK["r"], h=TANK["h"], slope=0.02):
    hi = math.pi if half else 2 * math.pi
    a, y = np.meshgrid(np.arange(0, hi, 0.15 / r), np.arange(0.05, h, 0.15))
    a, y = a.ravel(), y.ravel()
    g = slope * c[0]
    wall = np.column_stack([c[0] + r * np.cos(a), g + y, c[1] + r * np.sin(a)])
    rr, aa = np.meshgrid(np.arange(0, r, 0.2), np.arange(0, 2 * math.pi, 0.08))
    roof = np.column_stack(
        [c[0] + (rr * np.cos(aa)).ravel(), np.full(rr.size, g + h), c[1] + (rr * np.sin(aa)).ravel()]
    )
    pts = np.vstack([wall, roof] if not half else [wall])
    return pts + rng.normal(0, 0.01, pts.shape)


def _box(rng, slope=0.02):
    (cx, cz), (sx, sy, sz), yaw = BOX["c"], BOX["size"], math.radians(BOX["yaw"])
    g = slope * cx
    pts = []
    for u in np.arange(-sx / 2, sx / 2 + 1e-9, 0.12):
        for v in np.arange(0.05, sy, 0.12):
            pts += [(u, v, -sz / 2), (u, v, sz / 2)]
        for w in np.arange(-sz / 2, sz / 2 + 1e-9, 0.12):
            pts.append((u, sy, w))
    for w in np.arange(-sz / 2, sz / 2 + 1e-9, 0.12):
        for v in np.arange(0.05, sy, 0.12):
            pts += [(-sx / 2, v, w), (sx / 2, v, w)]
    p = np.array(pts)
    # yaw counter-clockwise seen from above: the box x axis turns toward north (-z)
    ex = np.array([math.cos(yaw), -math.sin(yaw)])
    ez = np.array([math.sin(yaw), math.cos(yaw)])
    x = cx + p[:, 0] * ex[0] + p[:, 2] * ez[0]
    z = cz + p[:, 0] * ex[1] + p[:, 2] * ez[1]
    out = np.column_stack([x, g + p[:, 1], z])
    return out + rng.normal(0, 0.01, out.shape)


def _pipe(rng):
    a, b, r = np.array(PIPE["a"]), np.array(PIPE["b"]), PIPE["d"] / 2
    t, ang = np.meshgrid(np.arange(0, 1, 0.006), np.arange(0, 2 * math.pi, 0.25))
    t, ang = t.ravel(), ang.ravel()
    axis = (b - a) / np.linalg.norm(b - a)
    e1 = np.array([0.0, 1.0, 0.0])
    e2 = np.cross(axis, e1)
    p = a + np.outer(t, b - a) + r * (np.outer(np.cos(ang), e1) + np.outer(np.sin(ang), e2))
    return p + rng.normal(0, 0.003, p.shape)


def _noise(rng):
    return rng.uniform([-20, 1, 15], [-18, 3, 17], size=(400, 3))


def project(tmp: Path, pts: np.ndarray, layer_format: str = "kit-packed") -> Path:
    (tmp / "clouds").mkdir(parents=True, exist_ok=True)
    mm = np.round(pts * 1000).astype("<i2")
    (tmp / "clouds" / "scan.bin").write_bytes(mm.tobytes() + bytes(len(pts)))
    manifest = {
        "schema": "aio.project/1",
        "id": "synthetic",
        "name": "Synthetic",
        "crs": {"epsg": 32639},
        "origin": [500000, 3200000, 0],
        "captures": [],
        "layers": [
            {
                "kind": "pointcloud",
                "id": "scan",
                "name": "Modelling scan",
                "visible": True,
                "src": {"path": "clouds/scan.bin"},
                "format": layer_format,
            }
        ],
        "severityModels": [],
        "classCatalogues": [],
    }
    (tmp / "manifest.json").write_text(json.dumps(manifest), "utf-8")
    return tmp


def scene(rng, **kw):
    return np.vstack([_ground(rng), _tank(rng, **kw), _box(rng), _pipe(rng), _noise(rng)])


def parts_of(tmp: Path, model: str = "scan-scan") -> list[dict]:
    return json.loads((tmp / "models" / f"{model}.procmodel.json").read_text("utf-8"))["parts"]


def test_tanks_boxes_and_pipes_fit_within_tolerance_and_noise_gives_nothing(tmp_path):
    rng = np.random.default_rng(1)
    project(tmp_path, scene(rng))
    run_job(ModelFitCloud(), tmp_path, {"layer": "scan"})
    parts = parts_of(tmp_path)
    kinds = sorted(p["kind"] for p in parts)
    assert kinds == ["box", "cylinder", "pipe"]
    by = {p["kind"]: p for p in parts}
    tank = by["cylinder"]
    assert abs(tank["radius"] - TANK["r"]) / TANK["r"] < 0.02
    assert abs(tank["height"] - TANK["h"]) / TANK["h"] < 0.02
    assert math.hypot(tank["base"][0] - TANK["c"][0], tank["base"][2] - TANK["c"][1]) < 0.05
    box = by["box"]
    for got, want in zip(box["size"], BOX["size"], strict=True):
        assert abs(got - want) / want < 0.03
    yaw = (box["yawDeg"] - BOX["yaw"] + 90) % 180 - 90
    assert abs(yaw) < 2
    pipe = by["pipe"]
    assert abs(pipe["diameter"] - PIPE["d"]) / PIPE["d"] < 0.05
    for p in parts:
        assert p["status"] == "draft"
        assert p["origin"]["by"] == "fit"
        assert p["origin"]["residualM"] < 0.05
        assert 0 < p["origin"]["inlierShare"] <= 1
        assert set(p) <= {
            "kind", "id", "name", "tag", "class", "status", "confidence", "origin",
            "base", "radius", "height", "roof", "roofHeight", "size", "yawDeg",
            "points", "diameter", "footprint", "baseY", "center",
        }  # fmt: skip
    m = json.loads((tmp_path / "models" / "scan-scan.procmodel.json").read_text("utf-8"))
    assert m["schema"] == "aio.procmodel/1"
    assert m["sources"] == [{"kind": "pointcloud", "ref": "scan"}]


def test_a_half_seen_tank_still_fits(tmp_path):
    rng = np.random.default_rng(2)
    project(tmp_path, np.vstack([_ground(rng), _tank(rng, half=True)]))
    run_job(ModelFitCloud(), tmp_path, {"layer": "scan", "kinds": ["cylinder"]})
    (tank,) = parts_of(tmp_path)
    assert abs(tank["radius"] - TANK["r"]) / TANK["r"] < 0.02


def test_kinds_limit_the_output_and_parts_append_to_a_model(tmp_path):
    rng = np.random.default_rng(3)
    project(tmp_path, scene(rng))
    (tmp_path / "models").mkdir()
    existing = {
        "schema": "aio.procmodel/1",
        "id": "site",
        "name": "Site",
        "createdAt": "2026-10-06T08:00:00Z",
        "updatedAt": "2026-10-06T08:00:00Z",
        "parts": [
            {
                "kind": "sphere",
                "id": "s1",
                "status": "accepted",
                "origin": {"by": "manual"},
                "center": [0, 5, 0],
                "radius": 1,
            }
        ],
    }
    (tmp_path / "models" / "site.procmodel.json").write_text(json.dumps(existing), "utf-8")
    run_job(ModelFitCloud(), tmp_path, {"layer": "scan", "kinds": ["cylinder"], "model": "site"})
    parts = parts_of(tmp_path, "site")
    assert [p["kind"] for p in parts] == ["sphere", "cylinder"]
    assert parts[0] == existing["parts"][0]
    assert (tmp_path / "models" / "site.procmodel.json.bak").is_file()


def test_resume_with_a_changed_cloud_is_refused(tmp_path):
    rng = np.random.default_rng(4)
    project(tmp_path, np.vstack([_ground(rng), _tank(rng)]))
    run_job(ModelFitCloud(), tmp_path, {"layer": "scan"})
    project(tmp_path, np.vstack([_ground(rng), _tank(rng)]))
    with pytest.raises(JobError, match=INPUTS_CHANGED.split(".")[0]):
        run_job(ModelFitCloud(), tmp_path, {"layer": "scan"})


def test_refusals_name_the_layer_and_the_fix(tmp_path, monkeypatch):
    rng = np.random.default_rng(5)
    project(tmp_path, _ground(rng), layer_format="copc")
    import aio_pipelines.pointcloud as pc

    monkeypatch.setattr(pc, "find_pdal", lambda: None)
    with pytest.raises(JobError, match="PDAL is not available"):
        run_job(ModelFitCloud(), tmp_path, {"layer": "scan"})
    with pytest.raises(JobError, match='no layer "nope"'):
        run_job(ModelFitCloud(), tmp_path, {"layer": "nope"}, job_id="j2")
    with pytest.raises(JobError, match="kinds must be"):
        ModelFitCloud().validate({"layer": "scan", "kinds": ["cone"]})
