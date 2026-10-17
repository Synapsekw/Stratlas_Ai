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
    assert m["schema"] == "aio.procmodel/2"
    assert m["sources"] == [{"kind": "pointcloud", "ref": "scan"}]


def test_new_model_is_v2(tmp_path):
    rng = np.random.default_rng(2)
    project(tmp_path, np.vstack([_ground(rng), _tank(rng)]))
    run_job(ModelFitCloud(), tmp_path, {"layer": "scan", "kinds": ["cylinder"]})
    m = json.loads((tmp_path / "models" / "scan-scan.procmodel.json").read_text("utf-8"))
    assert m["schema"] == "aio.procmodel/2"
    assert m["materials"] == []
    assert m["assemblies"] == []
    assert [p["kind"] for p in m["parts"]] == ["cylinder"]
    assert not (tmp_path / "models" / "scan-scan.procmodel.json.bak").exists()


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
    # the /1 file is upgraded the way the app's migrator does it; the .bak keeps the /1 text
    m = json.loads((tmp_path / "models" / "site.procmodel.json").read_text("utf-8"))
    assert m["schema"] == "aio.procmodel/2"
    assert m["materials"] == [] and m["assemblies"] == []
    bak = json.loads((tmp_path / "models" / "site.procmodel.json.bak").read_text("utf-8"))
    assert bak == existing


SHAFT = {
    "kind": "shaft",
    "id": "shaft-1",
    "name": "Shaft",
    "description": "",
    "category": "shaft",
    "status": "accepted",
    "origin": {"by": "manual"},
    "quality": {},
    "sources": [],
    "material": "brick",
    "params": {"base": [0, 0, 0], "openTop": False, "profile": [{"y": 0, "r": 3}, {"y": 30, "r": 2}]},
}


def test_commit_appends_to_v2_model(tmp_path):
    rng = np.random.default_rng(3)
    project(tmp_path, scene(rng))
    (tmp_path / "models").mkdir()
    brick = {"id": "brick", "name": "Brick", "baseColor": [0.5, 0.3, 0.2, 1], "metallic": 0, "roughness": 0.9}
    existing = {
        "schema": "aio.procmodel/2",
        "id": "stack",
        "name": "Stack",
        "createdAt": "2026-10-06T08:00:00Z",
        "updatedAt": "2026-10-06T08:00:00Z",
        "family": "chimney",
        "run": {"id": "run-1", "detail": "standard"},
        "parts": [],
        "materials": [brick],
        "assemblies": [SHAFT],
        # a key this fitter does not know (a later field) is carried over as it is
        "georef": {"later": True},
    }
    (tmp_path / "models" / "stack.procmodel.json").write_text(json.dumps(existing), "utf-8")
    run_job(ModelFitCloud(), tmp_path, {"layer": "scan", "kinds": ["cylinder"], "model": "stack"})
    m = json.loads((tmp_path / "models" / "stack.procmodel.json").read_text("utf-8"))
    assert m["schema"] == "aio.procmodel/2"
    assert m["assemblies"] == [SHAFT]
    assert m["materials"] == [brick]
    assert m["family"] == "chimney" and m["run"] == {"id": "run-1", "detail": "standard"}
    assert [p["kind"] for p in m["parts"]] == ["cylinder"]
    assert m["parts"][0]["id"] != "shaft-1"
    assert m["georef"] == {"later": True}
    bak = json.loads((tmp_path / "models" / "stack.procmodel.json.bak").read_text("utf-8"))
    assert bak == existing
    assert sorted(p.name for p in (tmp_path / "models").iterdir()) == [
        "stack.procmodel.json",
        "stack.procmodel.json.bak",
    ]


def test_commit_refuses_a_newer_model_untouched(tmp_path):
    rng = np.random.default_rng(3)
    project(tmp_path, scene(rng))
    (tmp_path / "models").mkdir()
    text = json.dumps({"schema": "aio.procmodel/3", "id": "next", "parts": []})
    (tmp_path / "models" / "next.procmodel.json").write_text(text, "utf-8")
    with pytest.raises(JobError, match="newer version"):
        run_job(ModelFitCloud(), tmp_path, {"layer": "scan", "kinds": ["cylinder"], "model": "next"})
    assert (tmp_path / "models" / "next.procmodel.json").read_text("utf-8") == text
    assert not (tmp_path / "models" / "next.procmodel.json.bak").exists()


def test_resume_with_a_changed_cloud_is_refused(tmp_path):
    rng = np.random.default_rng(4)
    project(tmp_path, np.vstack([_ground(rng), _tank(rng)]))
    run_job(ModelFitCloud(), tmp_path, {"layer": "scan"})
    project(tmp_path, np.vstack([_ground(rng), _tank(rng)]))
    with pytest.raises(JobError, match=INPUTS_CHANGED.split(".")[0]):
        run_job(ModelFitCloud(), tmp_path, {"layer": "scan"})


def png_packed(tmp: Path, pts: np.ndarray, chunks: int = 2) -> None:
    """Write `pts` as an aio.pngcloud/1 layer "scan" (packages/pointcloud/README.md), in chunks:
    the first with bounds only, the others with an explicit quant."""
    from PIL import Image

    project(tmp, pts[:1], layer_format="png-packed")
    (tmp / "clouds" / "scan.bin").unlink()
    index = {"schema": "aio.pngcloud/1", "spacing": 0.2, "chunks": []}
    for k, part in enumerate(np.array_split(pts, chunks)):
        lo, hi = part.min(0), part.max(0)
        if k == 0:
            scale = (hi - lo) / 65535
            entry: dict = {}
        else:
            scale = np.full(3, float((hi - lo).max()) / 65535)
            entry = {"quant": {"offset": lo.tolist(), "scale": float(scale[0])}}
        u = np.clip(np.round((part - lo) / scale), 0, 65535).astype(np.uint16)
        n = len(part)
        planes = [u[:, a] & 0xFF for a in range(3)], [u[:, a] >> 8 for a in range(3)]
        stream = np.concatenate([np.concatenate([lo_b, hi_b]) for lo_b, hi_b in zip(*planes, strict=True)])
        stream = np.concatenate([stream.astype(np.uint8), np.full(3 * n, 128, np.uint8)])
        width = 256
        height = -(-len(stream) // (3 * width))
        px = np.zeros(width * height * 3, np.uint8)
        px[: len(stream)] = stream
        rel = f"clouds/scan/c{k:03d}.png"
        (tmp / "clouds" / "scan").mkdir(parents=True, exist_ok=True)
        Image.fromarray(px.reshape(height, width, 3), "RGB").save(tmp / rel)
        bounds = {"min": lo.tolist(), "max": hi.tolist()}
        index["chunks"].append({"file": rel, "points": n, "bounds": bounds, "lod": k, **entry})
    (tmp / "clouds" / "scan" / "index.json").write_text(json.dumps(index), "utf-8")
    manifest = json.loads((tmp / "manifest.json").read_text("utf-8"))
    manifest["layers"][0]["src"] = {"path": "clouds/scan/index.json"}
    (tmp / "manifest.json").write_text(json.dumps(manifest), "utf-8")


def test_a_png_packed_cloud_fits_like_the_kit_packed_one(tmp_path):
    rng = np.random.default_rng(1)
    pts = scene(rng)
    png_packed(tmp_path, pts)
    run_job(ModelFitCloud(), tmp_path, {"layer": "scan"})
    parts = parts_of(tmp_path)
    assert sorted(p["kind"] for p in parts) == ["box", "cylinder", "pipe"]
    tank = next(p for p in parts if p["kind"] == "cylinder")
    assert abs(tank["radius"] - TANK["r"]) / TANK["r"] < 0.02
    assert math.hypot(tank["base"][0] - TANK["c"][0], tank["base"][2] - TANK["c"][1]) < 0.05


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


def test_fit_points_carry_the_offset(tmp_path):
    from types import SimpleNamespace

    from aio_pipelines.modelfit.segment import load_layer_points

    pts = scene(np.random.default_rng(1))
    project(tmp_path, pts)
    ctx = SimpleNamespace(project=tmp_path, check=lambda: None)
    manifest = json.loads((tmp_path / "manifest.json").read_text("utf-8"))
    plain = load_layer_points(ctx, manifest, "scan", 0.0)
    manifest["layers"][0]["heightOffsetM"] = 5.0
    lifted = load_layer_points(ctx, manifest, "scan", 0.0)
    assert len(lifted) == len(plain)
    assert np.allclose(np.sort(lifted[:, 1]), np.sort(plain[:, 1]) + 5.0, atol=1e-6)
    assert np.allclose(np.sort(lifted[:, 0]), np.sort(plain[:, 0]), atol=1e-6)


@pytest.mark.parametrize("fmt", ["kit-packed", "png-packed", "copc"])
def test_fit_points_carry_the_shift(tmp_path, monkeypatch, fmt):
    from types import SimpleNamespace

    import aio_pipelines.pointcloud as pc
    from aio_pipelines.modelfit.segment import load_layer_points
    from synth_assets import write_las

    pts = scene(np.random.default_rng(1))
    if fmt == "png-packed":
        png_packed(tmp_path, pts)
    else:
        project(tmp_path, pts, layer_format=fmt)
    if fmt == "copc":
        # PDAL is replaced by a writer of the same points as a plain LAS
        monkeypatch.setattr(pc, "find_pdal", lambda: "pdal")
        monkeypatch.setattr(
            pc, "_run", lambda ctx, cmd, label: write_las(pts, Path(cmd[-1]), offset=(500000, 3200000, 0))
        )
    job_dir = tmp_path / "job"
    job_dir.mkdir()
    ctx = SimpleNamespace(project=tmp_path, check=lambda: None, job=SimpleNamespace(dir=job_dir))
    path = tmp_path / "manifest.json"
    manifest = json.loads(path.read_text("utf-8"))
    plain = load_layer_points(ctx, manifest, "scan", 0.0)
    manifest["captures"] = [
        {
            "id": "c1",
            "label": "Survey",
            "date": "2026-10-01",
            "lineUp": {"eastM": 2.0, "northM": -1.0, "with": "c0", "at": "2026-10-16T09:00:00Z"},
        }
    ]
    manifest["layers"][0]["capture"] = "c1"
    moved = load_layer_points(ctx, manifest, "scan", 0.0)
    assert len(moved) == len(plain)
    # 2 m east is local x + 2; 1 m south is local z + 1; heights stay
    assert np.allclose(np.sort(moved[:, 0]), np.sort(plain[:, 0]) + 2.0, atol=2e-3)
    assert np.allclose(np.sort(moved[:, 1]), np.sort(plain[:, 1]), atol=2e-3)
    assert np.allclose(np.sort(moved[:, 2]), np.sort(plain[:, 2]) + 1.0, atol=2e-3)
