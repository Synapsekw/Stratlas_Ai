"""Synthetic projects for the survey export tests (M11 G7): no client data, analytic truths only.

A project in WGS 84 / UTM 39N (the fictional desert site of G6's tests) with:

- a pad design (``pad``): a surface with a breakline and an outer boundary, the shared clothoid
  alignment of ``packages/survey/src/designs/__fixtures__`` (a line, a clothoid, an arc and a
  station equation), and two control points;
- prepared surfaces: ``plane`` (z = 100 + 0.02 E' - 0.01 N', exact under bilinear sampling) and
  ``cone`` (a cone with a hole), one tile each;
- survey measurements: a polygon, a line and a point.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np

from aio_pipelines.design.tin_io import encode_tin
from aio_pipelines.survey.grid import TILE, encode_tile

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "packages" / "survey" / "src" / "designs" / "__fixtures__"
SHARED = json.loads((FIXTURES / "alignment-clothoid.json").read_text("utf-8"))
CRS = {"epsg": 32639}
E0, N0 = 520010.0, 2750010.0
#: Prepared grid origin (lower-left corner) and cell
GE, GN, CELL = 519990.0, 2749990.0, 0.5
NX, NY = 120, 100


def pad_vertices() -> np.ndarray:
    """A 20 m square pad, 3 by 3 vertices, the middle row raised (G6's test pad)."""
    v = []
    for j in range(3):
        for i in range(3):
            z = 100.0 + (1.75 if (i, j) == (1, 1) else 0.25 * i + 0.5 * j)
            v.append((E0 + 10 * i, N0 + 10 * j, z))
    return np.asarray(v, dtype=np.float64)


def pad_triangles() -> np.ndarray:
    t = []
    for j in range(2):
        for i in range(2):
            a, b, c, d = j * 3 + i, j * 3 + i + 1, (j + 1) * 3 + i + 1, (j + 1) * 3 + i
            t += [(a, b, c), (a, c, d)]
    return np.asarray(t, dtype=np.uint32)


def plane(e: np.ndarray, n: np.ndarray) -> np.ndarray:
    return 100.0 + 0.02 * (e - GE) - 0.01 * (n - GN)


def cone(e: np.ndarray, n: np.ndarray) -> np.ndarray:
    return 100.0 + np.clip(4.0 * (1 - np.hypot(e - (GE + 30), n - (GN + 25)) / 15.0), 0, None)


def write_json(p: Path, v: Any) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(v, indent=1), encoding="utf-8", newline="")


def prepared(root: Path, sid: str, fn, hole: bool = False, capture: str | None = None) -> np.ndarray:
    """A prepared surface of one tile with posts at the cell centres; returns its (NY, NX) heights."""
    xs = GE + (np.arange(NX) + 0.5) * CELL
    ys = GN + (np.arange(NY) + 0.5) * CELL
    X, Y = np.meshgrid(xs, ys)
    h = fn(X, Y)
    if hole:
        h[(X > GE + 50) & (Y > GN + 40)] = np.nan
    tile = np.full((TILE, TILE), np.nan)
    tile[:NY, :NX] = h
    d = root / "survey" / "surfaces" / sid
    (d / "0").mkdir(parents=True, exist_ok=True)
    (d / "0" / "0_0.bin").write_bytes(encode_tile(tile))
    ok = np.isfinite(h)
    meta = {
        "schema": "aio.height-tiles/1",
        "id": sid,
        "name": f"{sid.title()} survey",
        "source": {"kind": "dsm", "layer": sid},
        "crs": CRS,
        "cellM": CELL,
        "tileSize": TILE,
        "originE": GE,
        "originN": GN,
        "cols": 1,
        "rows": 1,
        "levels": 1,
        "bounds": [GE, GN, float(h[ok].min()), GE + NX * CELL, GN + NY * CELL, float(h[ok].max())],
        "tiles": ["0_0"],
        "fingerprint": f"fp-{sid}",
        "preparedAt": "2026-10-09T00:00:00Z",
    }
    if capture:
        meta["capture"] = capture
    write_json(d / "tiles.json", meta)
    return h


def design(root: Path) -> None:
    folder = root / "survey" / "designs" / "pad"
    folder.mkdir(parents=True, exist_ok=True)
    v = pad_vertices()
    chains = [(0, np.asarray([3, 4, 5], dtype=np.uint32)), (1, np.asarray([0, 2, 8, 6], dtype=np.uint32))]
    (folder / "top.tin").write_bytes(encode_tin(v, pad_triangles(), CRS, chains))
    al = dict(SHARED["alignment"])
    write_json(folder / "cl.alignment.json", al)
    write_json(
        folder / "ctl.points.json",
        {
            "type": "FeatureCollection",
            "crs": CRS,
            "features": [
                {
                    "type": "Feature",
                    "properties": {"id": "CP1", "code": "CTRL"},
                    "geometry": {"type": "Point", "coordinates": [E0 - 5, N0 - 5, 99.5]},
                },
                {
                    "type": "Feature",
                    "properties": {"id": "CP2"},
                    "geometry": {"type": "Point", "coordinates": [E0 + 25, N0 + 25, 101.25]},
                },
            ],
        },
    )

    def layer(lid: str, name: str, kind: str, file: str) -> dict[str, Any]:
        return {
            "id": lid,
            "name": name,
            "kind": kind,
            "file": file,
            "counts": {},
            "visible": True,
            "archived": False,
            "verticalOffsetM": 0.0,
        }

    write_json(
        root / "survey" / "designs.json",
        {
            "schema": "aio.designs/1",
            "designs": [
                {
                    "id": "pad",
                    "name": "Pad design",
                    "src": "pad.xml",
                    "sha256": "0" * 64,
                    "bytes": 1,
                    "format": "landxml",
                    "units": "m",
                    "crs": CRS,
                    "calibrated": False,
                    "importedAt": "2026-10-09T00:00:00Z",
                    "layers": [
                        layer("top", "Pad top", "surface", "top.tin"),
                        layer("cl", "CL1", "alignment", "cl.alignment.json"),
                        layer("ctl", "Control", "points", "ctl.points.json"),
                    ],
                }
            ],
        },
    )


def measurements(root: Path) -> list[dict[str, Any]]:
    ms = [
        {
            "id": "m-poly",
            "family": "polygon",
            "tool": "volume",
            "label": "Pile A",
            "folder": "Stockpiles",
            "scope": {"kind": "site"},
            "points": [
                [GE + 20, GN + 15, 101.0],
                [GE + 40, GN + 15, 101.0],
                [GE + 40, GN + 35, 102.0],
                [GE + 20, GN + 35, 102.0],
            ],
            "items": [],
            "results": [],
            "createdAt": "2026-10-09T00:00:00Z",
        },
        {
            "id": "m-line",
            "family": "line",
            "tool": "section",
            "label": "Section 1",
            "scope": {"kind": "site"},
            "points": [[GE + 5, GN + 10, 100.0], [GE + 55, GN + 40, 100.0]],
            "items": [],
            "results": [],
            "createdAt": "2026-10-09T00:00:00Z",
        },
        {
            "id": "m-pt",
            "family": "point",
            "tool": "elevation",
            "label": "Spot 1",
            "folder": "Stockpiles",
            "scope": {"kind": "site"},
            "points": [[GE + 12.25, GN + 8.75, 100.5]],
            "items": [],
            "results": [],
            "createdAt": "2026-10-09T00:00:00Z",
        },
    ]
    write_json(root / "survey" / "measurements.json", {"schema": "aio.measurements/1", "measurements": ms})
    return ms


def project(
    tmp: Path,
    name: str = "proj",
    crs: dict[str, Any] | None = None,
    settings: dict[str, Any] | None = None,
    calibration: dict[str, Any] | None = None,
    layers: list[dict[str, Any]] | None = None,
) -> Path:
    root = tmp / name
    root.mkdir(parents=True)
    write_json(
        root / "manifest.json",
        {
            "schema": "aio.project/1",
            "crs": crs or CRS,
            "origin": [E0, N0, 100.0],
            "layers": layers or [],
            "captures": [{"id": "d1", "date": "2026-10-01"}],
        },
    )
    write_json(
        root / "survey" / "settings.json",
        settings or {"schema": "aio.survey-settings/1", "verticalDatum": {"kind": "project"}},
    )
    if calibration is not None:
        write_json(root / "survey" / "calibration.json", calibration)
    return root


def full_project(tmp: Path, **kw: Any) -> Path:
    root = project(tmp, **kw)
    design(root)
    prepared(root, "plane", plane, capture="d1")
    prepared(root, "cone", cone, hole=True)
    measurements(root)
    return root
