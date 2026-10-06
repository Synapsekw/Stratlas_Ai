"""Synthetic two-date fixtures for point cloud and 3D model change (M8 stream C3). No client data.

    uv run --offline python scripts/change_fixture.py <out folder> [--copc] [--change <file>]

A fictional 30 x 30 m yard at E 500000, N 3200000 (EPSG 32639), seeded so every run writes the
same points. Between the two dates (10 Jan and 10 Feb 2026) a pipe moves 0.6 m north, a box is
added, and the tank stays where it is. Written into ``<out>``:

- ``clouds/site-2026-01-10.las`` and ``clouds/site-2026-02-10.las`` (LAS 1.4, point format 7);
  with ``--copc`` also as ``.copc.laz`` through PDAL (``AIO_PDAL``, the pack's or the PATH);
- ``models/site-e1.glb`` and ``models/site-e2.glb``: the tank ``T-101``, the pipe ``P-201`` (moved
  0.6 m), the skid ``K-301`` (gone on the later date), the box ``B-401`` (new) and a 0.25 m dent
  in the tank on the later date, nodes named ``<tag>_e1`` and ``<tag>_e2``;
- ``scene.json``: the facts the tests check, in the project local frame (x east, y up, z south).

``--change <file>`` runs ``change.cloud`` on the two COPCs in a temporary project and copies the
resulting cloud (with its ``Distance`` field) to ``<file>``: that is how
``packages/pointcloud/test-data/change.copc.laz`` is made.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

import numpy as np

ORIGIN = (500000.0, 3200000.0, 0.0)
EPSG = 32639
DATES = ("2026-01-10", "2026-02-10")
PIPE_MOVE_M = 0.6
DENT_M = 0.25


def _plane(rng, x0, x1, y0, y1, z, spacing, noise=0.003):
    n = int((x1 - x0) * (y1 - y0) / spacing**2)
    return np.column_stack([rng.uniform(x0, x1, n), rng.uniform(y0, y1, n), z + rng.normal(0, noise, n)])


def _tank(rng, cx, cy, r=3.0, h=6.0, spacing=0.15):
    m = int(2 * np.pi * r * h / spacing**2)
    a = rng.uniform(0, 2 * np.pi, m)
    side = np.column_stack([cx + r * np.cos(a), cy + r * np.sin(a), rng.uniform(0, h, m)])
    k = int(np.pi * r * r / spacing**2)
    rr = r * np.sqrt(rng.uniform(0, 1, k))
    b = rng.uniform(0, 2 * np.pi, k)
    top = np.column_stack([cx + rr * np.cos(b), cy + rr * np.sin(b), np.full(k, h)])
    return np.vstack([side, top]) + rng.normal(0, 0.003, (m + k, 3))


def _pipe(rng, x0, x1, cy, cz=1.5, r=0.4, spacing=0.1):
    m = int(2 * np.pi * r * (x1 - x0) / spacing**2)
    a = rng.uniform(0, 2 * np.pi, m)
    return np.column_stack([rng.uniform(x0, x1, m), cy + r * np.cos(a), cz + r * np.sin(a)]) + rng.normal(
        0, 0.003, (m, 3)
    )


def _box(rng, cx, cy, size=2.0, h=2.0, spacing=0.12):
    s = size / 2
    faces = [_plane(rng, cx - s, cx + s, cy - s, cy + s, h, spacing)]
    m = int(size * h / spacing**2)
    for axis, side in ((0, -1), (0, 1), (1, -1), (1, 1)):
        u, w = rng.uniform(-s, s, m), rng.uniform(0, h, m)
        f = np.full(m, side * s)
        faces.append(np.column_stack([cx + f, cy + u, w] if axis == 0 else [cx + u, cy + f, w]))
    return np.vstack(faces)


def clouds(seed: int = 7) -> tuple[dict[str, np.ndarray], dict[str, np.ndarray]]:
    """Points (E, N, H) and classes of both dates."""
    rng = np.random.default_rng(seed)
    out_xyz: dict[str, np.ndarray] = {}
    out_cls: dict[str, np.ndarray] = {}
    e0, n0, _ = ORIGIN
    for i, date in enumerate(DATES):
        g = _plane(rng, 0, 30, 0, 30, 0.0, 0.2)
        holes = [(8, 20, 3.0)] + ([(24, 22, 1.0)] if i else [])
        keep = np.ones(len(g), dtype=bool)
        for cx, cy, h in holes:
            keep &= ~((np.abs(g[:, 0] - cx) < h) & (np.abs(g[:, 1] - cy) < h))
        parts = [
            (g[keep], 2),
            (_tank(rng, 8, 20), 6),
            (_pipe(rng, 14, 24, 8 + (PIPE_MOVE_M if i else 0.0)), 1),
        ]
        if i:
            parts.append((_box(rng, 24, 22), 1))
        xyz = np.vstack([p for p, _ in parts]) + np.array([e0, n0, 0])
        out_xyz[date] = xyz
        out_cls[date] = np.concatenate([np.full(len(p), c, dtype=np.uint8) for p, c in parts])
    return out_xyz, out_cls


def _cylinder_y(radius, height, sections=72):
    import trimesh

    m = trimesh.creation.cylinder(radius=radius, height=height, sections=sections)
    m.apply_transform(trimesh.transformations.rotation_matrix(-np.pi / 2, [1, 0, 0]))
    m.apply_translation([0, height / 2, 0])
    return m


def models() -> tuple[dict, dict]:
    """GLB parts (local frame, y up) of both dates."""
    import trimesh

    def tank(dent=0.0):
        m = _cylinder_y(3.0, 6.0).subdivide_to_size(max_edge=0.2, max_iter=12)
        if dent:
            v = m.vertices.copy()
            ang = np.arctan2(v[:, 2], v[:, 0])
            side = np.hypot(v[:, 0], v[:, 2]) > 2.97
            bump = np.clip(1 - (ang / np.radians(25)) ** 2, 0, 1) * np.clip(
                1 - ((v[:, 1] - 3) / 1.5) ** 2, 0, 1
            )
            push = np.where(side, dent * bump, 0)
            v[:, 0] -= push * np.cos(ang)
            v[:, 2] -= push * np.sin(ang)
            m = trimesh.Trimesh(v, m.faces, process=False)
        m.apply_translation([8, 0, -20])
        return m

    def pipe(z):
        m = trimesh.creation.cylinder(radius=0.4, height=10, sections=32)
        m.apply_transform(trimesh.transformations.rotation_matrix(np.pi / 2, [0, 1, 0]))  # along x
        m.apply_translation([19, 1.5, z])
        return m

    def box(x, z, size=(2.0, 2.0, 2.0)):
        m = trimesh.creation.box(extents=size)
        m.apply_translation([x, size[1] / 2, z])
        return m

    before = {"T-101_e1": tank(), "P-201_e1": pipe(-8), "K-301_e1": box(4, -4, (3.0, 1.5, 2.0))}
    after = {"T-101_e2": tank(DENT_M), "P-201_e2": pipe(-8 - PIPE_MOVE_M), "B-401_e2": box(24, -22)}
    return before, after


def write_glb(path: Path, parts: dict) -> None:
    import trimesh

    scene = trimesh.Scene()
    for name, mesh in parts.items():
        scene.add_geometry(mesh, node_name=name, geom_name=name)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(scene.export(file_type="glb"))


def facts() -> dict:
    return {
        "origin": list(ORIGIN),
        "epsg": EPSG,
        "dates": list(DATES),
        "pipe": {"from": [19, 1.5, -8], "to": [19, 1.5, -8 - PIPE_MOVE_M], "movedM": PIPE_MOVE_M},
        "tank": {"at": [8, 3, -20], "radius": 3, "height": 6},
        "box": {"at": [24, 1, -22], "size": 2},
        "parts": {
            "moved": "P-201",
            "added": "B-401",
            "removed": "K-301",
            "changed": "T-101",
            "dentM": DENT_M,
        },
    }


def to_copc(pdal: str, las: Path, out: Path) -> None:
    pipe = las.with_suffix(".json")
    pipe.write_text(
        json.dumps(
            {
                "pipeline": [
                    {"type": "readers.las", "filename": str(las)},
                    {"type": "writers.copc", "filename": str(out), "a_srs": f"EPSG:{EPSG}"},
                ]
            }
        )
    )
    subprocess.run([pdal, "pipeline", str(pipe)], check=True, capture_output=True)
    pipe.unlink()


def main(argv: list[str] | None = None) -> int:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
    from aio_pipelines.change.las import write_las
    from aio_pipelines.pointcloud import find_pdal

    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("out", type=Path)
    ap.add_argument("--copc", action="store_true", help="also write the clouds as COPC (needs PDAL)")
    ap.add_argument("--change", type=Path, help="run change.cloud and copy its COPC here (needs PDAL)")
    args = ap.parse_args(argv)
    out: Path = args.out
    (out / "clouds").mkdir(parents=True, exist_ok=True)
    xyz, cls = clouds()
    colours = {1: (60, 120, 200), 2: (120, 110, 90), 6: (205, 205, 210)}
    for date in DATES:
        rgb = np.array([colours[int(c)] for c in cls[date]], dtype=np.uint16) * 256
        write_las(out / "clouds" / f"site-{date}.las", xyz[date], pdrf=7, classification=cls[date], rgb=rgb)
    before, after = models()
    write_glb(out / "models" / "site-e1.glb", before)
    write_glb(out / "models" / "site-e2.glb", after)
    (out / "scene.json").write_text(json.dumps(facts(), indent=1) + "\n")
    if args.copc or args.change:
        pdal = find_pdal()
        if not pdal:
            print("PDAL not found (set AIO_PDAL)", file=sys.stderr)
            return 2
        for date in DATES:
            to_copc(pdal, out / "clouds" / f"site-{date}.las", out / "clouds" / f"site-{date}.copc.laz")
    if args.change:
        from aio_pipelines.change.cloud import ChangeCloud
        from aio_pipelines.runtime import Job

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "clouds").mkdir()
            for date in DATES:
                shutil.copy(out / "clouds" / f"site-{date}.copc.laz", root / "clouds")
            manifest = {
                "schema": "aio.project/1",
                "id": "fixture",
                "crs": {"epsg": EPSG},
                "origin": list(ORIGIN),
                "captures": [{"id": f"c{i + 1}", "date": d} for i, d in enumerate(DATES)],
                "layers": [
                    {
                        "kind": "pointcloud",
                        "id": f"site-{d}",
                        "name": f"Site {d}",
                        "src": {"path": f"clouds/site-{d}.copc.laz"},
                        "format": "copc",
                        "capture": f"c{i + 1}",
                    }
                    for i, d in enumerate(DATES)
                ],
            }
            (root / "manifest.json").write_text(json.dumps(manifest))
            params = {"layerFrom": f"site-{DATES[0]}", "layerTo": f"site-{DATES[1]}"}
            Job("fixture", ChangeCloud(), root, params, lambda *_: None, threading.Event()).run()
            args.change.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(root / "change" / "c1-c2-cloud" / "distance.copc.laz", args.change)
            shutil.copy(root / "change" / "c1-c2-cloud.json", out / "c1-c2-cloud.json")
    print(f"Wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
