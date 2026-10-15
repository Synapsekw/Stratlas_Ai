"""Synthetic clouds for the cleanup tests: a ground grid (class 2) with a building block (class 6)
around E 500000, N 3200000, and planted outliers (class 1): isolated high points 25 to 40 m up and
low points 6 to 8 m under the ground. Deterministic, no client data."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import numpy as np

from aio_pipelines.change.las import write_las
from aio_pipelines.pointcloud import find_pdal, pdal_env

E0, N0 = 500000.0, 3200000.0
EPSG = 32639


def planted_cloud(ground_step: float = 0.5, high: int = 40, low: int = 20, seed: int = 7):
    rng = np.random.default_rng(seed)
    g = np.arange(0.25, 40, ground_step)
    gx, gy = np.meshgrid(g, g)
    ground = np.c_[gx.ravel(), gy.ravel(), 0.02 * np.sin(gx.ravel())]
    bx, by = np.meshgrid(np.arange(15.25, 25, ground_step), np.arange(15.25, 25, ground_step))
    roof = np.c_[bx.ravel(), by.ravel(), np.full(bx.size, 10.0)]
    hi = np.c_[rng.uniform(2, 38, high), rng.uniform(2, 38, high), rng.uniform(25, 40, high)]
    lo = np.c_[rng.uniform(2, 38, low), rng.uniform(2, 38, low), rng.uniform(-8, -6, low)]
    xyz = np.vstack([ground, roof, hi, lo]) + np.array([E0, N0, 0.0])
    parts = [np.full(len(ground), 2), np.full(len(roof), 6), np.full(high + low, 1)]
    cls = np.concatenate(parts).astype(np.uint8)
    outlier = np.r_[np.zeros(len(ground) + len(roof), bool), np.ones(high + low, bool)]
    return np.round(xyz, 3), cls, outlier


def write_las14(path: Path, xyz: np.ndarray, cls: np.ndarray) -> Path:
    write_las(Path(path), xyz, pdrf=6, classification=cls)
    return Path(path)


def _pdal(stages: list, where: Path) -> None:
    pdal = find_pdal()
    assert pdal, "PDAL not found (set AIO_PDAL)"
    pipe = where.with_suffix(".pipeline.json")
    pipe.write_text(json.dumps({"pipeline": stages}))
    subprocess.run([pdal, "pipeline", str(pipe)], check=True, capture_output=True, env=pdal_env(pdal))
    pipe.unlink()


def to_copc(las: Path, copc: Path) -> Path:
    _pdal(
        [
            {"type": "readers.las", "filename": str(las), "override_srs": f"EPSG:{EPSG}"},
            {"type": "writers.copc", "filename": str(copc), "scale_x": 0.001, "scale_y": 0.001, "scale_z": 0.001,
             "offset_x": "auto", "offset_y": "auto", "offset_z": "auto"},
        ],
        copc,
    )  # fmt: skip
    return copc


def copc_to_las(copc: Path, las: Path) -> Path:
    _pdal(
        [
            {"type": "readers.copc", "filename": str(copc)},
            {"type": "writers.las", "filename": str(las), "minor_version": 4, "forward": "all", "extra_dims": "all"},
        ],
        las,
    )  # fmt: skip
    return las


def cloud_project(tmp_path: Path, xyz: np.ndarray, cls: np.ndarray, layer_id: str = "cloud-a") -> Path:
    root = tmp_path / "proj"
    (root / "clouds").mkdir(parents=True)
    las = write_las14(tmp_path / f"{layer_id}.las", xyz, cls)
    to_copc(las, root / "clouds" / f"{layer_id}.copc.laz")
    manifest = {
        "schema": "aio.project/1",
        "id": "p",
        "name": "Cleanup test",
        "crs": {"epsg": EPSG},
        "origin": [E0, N0, 0.0],
        "captures": [{"id": "d1", "label": "Day one", "date": "2026-10-01"}],
        "layers": [
            {"kind": "pointcloud", "id": layer_id, "name": "Scan", "visible": True, "capture": "d1",
             "src": {"path": f"clouds/{layer_id}.copc.laz"}, "format": "copc", "pointCount": len(xyz)},
        ],
    }  # fmt: skip
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2), "utf-8")
    return root
