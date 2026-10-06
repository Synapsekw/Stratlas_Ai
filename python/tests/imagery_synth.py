"""Procedural two-date imagery and surfaces for the change.raster and change.surface tests (M8 C2).

Synthetic only: a sandy ground texture from seeded noise, a painted square, a shaded patch, a
slight tint, DSMs with a cone and a pit, and kit-packed clouds sampled from them. When stream C8's
``tests/synth.py`` lands, these generators can move there.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

EPSG = 32639
ORIGIN = [500000.0, 3200000.0, 0.0]


# ---------------------------------------------------------------------------------------- imagery


def ground(h: int, w: int, seed: int = 1) -> np.ndarray:
    """A sandy textured ground, RGB floats 0..1, shape (h, w, 3)."""
    rng = np.random.default_rng(seed)
    base = np.array([0.72, 0.62, 0.45])
    fine = ndi.gaussian_filter(rng.normal(0, 1, (h, w)), 1.2)
    coarse = ndi.gaussian_filter(rng.normal(0, 1, (h, w)), 12)
    lum = 1 + 0.18 * fine / (fine.std() + 1e-9) + 0.06 * coarse / (coarse.std() + 1e-9)
    return np.clip(base[None, None, :] * lum[..., None], 0, 1)


def noisy(img: np.ndarray, seed: int, sigma: float = 0.01) -> np.ndarray:
    rng = np.random.default_rng(seed)
    return np.clip(img + rng.normal(0, sigma, img.shape), 0, 1)


def paint(img: np.ndarray, r0: int, c0: int, size: int, colour=(0.35, 0.42, 0.55)) -> np.ndarray:
    out = img.copy()
    out[r0 : r0 + size, c0 : c0 + size] = colour
    return out


def shade(img: np.ndarray, r0: int, c0: int, size: int, factor: float = 0.6, soft: float = 2.0) -> np.ndarray:
    """Darken a square (a shadow or a cloud's shade): light only, nothing on the ground changed."""
    m = np.zeros(img.shape[:2])
    m[r0 : r0 + size, c0 : c0 + size] = 1
    if soft > 0:
        m = ndi.gaussian_filter(m, soft)
    return img * (1 - (1 - factor) * m)[..., None]


def tint(img: np.ndarray) -> np.ndarray:
    """A slight overall colour and exposure shift between flights."""
    return np.clip(img * np.array([1.04, 1.0, 0.95]) + 0.015, 0, 1)


def to_u8(img: np.ndarray) -> np.ndarray:
    return np.round(np.clip(img, 0, 1) * 255).astype(np.uint8)


def write_pyramid(
    project: Path, rel: str, img: np.ndarray, cell: float, x0: float, z0: float, y: float = 0.0
):
    """One-level kit pyramid of PNG tiles (``aio.tiles/1``) at ``rel/tiles.json``; returns the src."""
    tile = 256
    h, w = img.shape[:2]
    cols, rows = math.ceil(w / tile), math.ceil(h / tile)
    rgba = np.zeros((rows * tile, cols * tile, 4), np.uint8)
    rgba[:h, :w, :3] = to_u8(img)
    rgba[:h, :w, 3] = 255
    root = project / rel
    for ty in range(rows):
        for tx in range(cols):
            p = root / "0" / f"{tx}_{ty}.png"
            p.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(rgba[ty * tile : (ty + 1) * tile, tx * tile : (tx + 1) * tile], "RGBA").save(p)
    W, H = cols * tile * cell, rows * tile * cell
    index = {
        "schema": "aio.tiles/1",
        "levels": [
            {"z": 0, "tileSize": tile, "cols": cols, "rows": rows, "pattern": f"{rel}/0/{{x}}_{{y}}.png"}
        ],
        "corners": {"tl": [x0, y, z0], "tr": [x0 + W, y, z0], "bl": [x0, y, z0 + H]},
    }
    (root / "tiles.json").write_text(json.dumps(index), "utf-8")
    return {"path": f"{rel}/tiles.json"}


def write_image(project: Path, rel: str, img: np.ndarray, cell: float, x0: float, z0: float):
    """A plain PNG raster layer (``format: image``) and its corners."""
    p = project / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(to_u8(img), "RGB").save(p)
    h, w = img.shape[:2]
    return {"path": rel}, {
        "tl": [x0, 0.0, z0],
        "tr": [x0 + w * cell, 0.0, z0],
        "bl": [x0, 0.0, z0 + h * cell],
    }


def write_geotiff_rgb(path: Path, img: np.ndarray, cell: float, x0: float, z0: float):
    """An RGB GeoTIFF in the project CRS whose north-west corner is local (x0, z0)."""
    import rasterio
    from rasterio.transform import from_origin

    path.parent.mkdir(parents=True, exist_ok=True)
    h, w = img.shape[:2]
    E0, N1 = ORIGIN[0] + x0, ORIGIN[1] - z0
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        height=h,
        width=w,
        count=3,
        dtype="uint8",
        crs=f"EPSG:{EPSG}",
        transform=from_origin(E0, N1, cell, cell),
    ) as d:
        d.write(np.moveaxis(to_u8(img), -1, 0))


def manifest(layers: list[dict[str, Any]], captures=None) -> dict[str, Any]:
    return {
        "schema": "aio.project/1",
        "id": "synthetic-change",
        "name": "Synthetic change site",
        "crs": {"epsg": EPSG},
        "origin": ORIGIN,
        "captures": captures
        or [
            {"id": "c1", "label": "First flight", "date": "2026-01-10"},
            {"id": "c2", "label": "Second flight", "date": "2026-03-01"},
        ],
        "layers": layers,
        "severityModels": [],
        "classCatalogues": [],
    }


def ortho_project(project: Path, a: np.ndarray, b: np.ndarray, cell: float = 0.25, fmt: str = "kit-pyramid"):
    """A project with an ortho per date (layers ``ortho-a`` on c1 and ``ortho-b`` on c2)."""
    h, w = a.shape[:2]
    x0, z0 = -w * cell / 2, -h * cell / 2
    layers = []
    for lid, cap, img in (("ortho-a", "c1", a), ("ortho-b", "c2", b)):
        layer: dict[str, Any] = {"kind": "raster", "id": lid, "name": f"Ortho {cap}", "visible": True}
        layer["role"] = "ortho"
        layer["capture"] = cap
        if fmt == "kit-pyramid":
            layer["format"] = "kit-pyramid"
            layer["src"] = write_pyramid(project, f"rasters/{lid}", img, cell, x0, z0)
        elif fmt == "image":
            layer["format"] = "image"
            layer["src"], layer["corners"] = write_image(project, f"rasters/{lid}.png", img, cell, x0, z0)
        else:
            layer["format"] = "cog"
            write_geotiff_rgb(project / f"rasters/{lid}.tif", img, cell, x0, z0)
            layer["src"] = {"path": f"rasters/{lid}.tif"}
        layers.append(layer)
    (project / "manifest.json").write_text(json.dumps(manifest(layers), indent=1), "utf-8")
    (project / "issues.json").write_text(json.dumps({"schema": "aio.issues/1", "issues": []}), "utf-8")
    return project


def raster_params(**extra) -> dict[str, Any]:
    return {
        "from": "c1",
        "to": "c2",
        "layerFrom": "ortho-a",
        "layerTo": "ortho-b",
        "method": "gradient",
        **extra,
    }


# --------------------------------------------------------------------------------------- surfaces

SURFACE_SIZE = 60.0  # metres, centred on the local origin (kit-packed clouds hold +-32 m)


def surface_grid(cell: float = 0.1):
    n = round(SURFACE_SIZE / cell)
    c = -SURFACE_SIZE / 2 + (np.arange(n) + 0.5) * cell
    X, Z = np.meshgrid(c, c)  # rows go south (+z)
    return X, Z


def terrain(X, Z) -> np.ndarray:
    """A gently sloping yard with a shed and a bund that stay put, heights above the project origin."""
    y = 1.0 + 0.01 * X - 0.004 * Z
    shed = (X >= 4) & (X <= 12) & (Z >= -25) & (Z <= -15)
    bund = np.exp(-(((Z - 22) / 1.2) ** 2)) * ((X > -25) & (X < 0))
    return y + 3.0 * shed + 1.0 * bund


def cone(X, Z, cx: float, cz: float, volume: float, height: float) -> np.ndarray:
    r = math.sqrt(3 * volume / (math.pi * height))
    return np.clip(height * (1 - np.hypot(X - cx, Z - cz) / r), 0, None)


def jitter(Y: np.ndarray, seed: int, amp: float = 0.02) -> np.ndarray:
    """Uniform noise of +-amp (survey noise)."""
    return Y + np.random.default_rng(seed).uniform(-amp, amp, Y.shape)


def write_dsm(path: Path, Y: np.ndarray, cell: float):
    """Heights in the local frame as a DSM GeoTIFF in the project CRS (H = origin + y)."""
    import rasterio
    from rasterio.transform import from_origin

    path.parent.mkdir(parents=True, exist_ok=True)
    n = Y.shape[0]
    E0, N1 = ORIGIN[0] - SURFACE_SIZE / 2, ORIGIN[1] + SURFACE_SIZE / 2
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        height=n,
        width=n,
        count=1,
        dtype="float32",
        crs=f"EPSG:{EPSG}",
        transform=from_origin(E0, N1, cell, cell),
        nodata=-10000,
    ) as d:
        d.write((Y + ORIGIN[2]).astype(np.float32), 1)


def write_kit_cloud(path: Path, X, Z, Y, seed: int = 3, keep: float = 1.0):
    """A kit-packed cloud (planar int16 mm x, y, z then uint8 intensity) from a height field."""
    rng = np.random.default_rng(seed)
    x, y, z = X.ravel(), Y.ravel(), Z.ravel()
    if keep < 1:
        pick = rng.random(x.size) < keep
        x, y, z = x[pick], y[pick], z[pick]
    xyz = np.stack([x, y, z], axis=1)
    q = np.round(xyz * 1000).astype("<i2")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(q.tobytes() + np.full(len(x), 128, np.uint8).tobytes())
    return len(x)


def surface_project(project: Path, kinds=("dsm", "dsm"), pile=1000.0, pit=300.0, noise=0.02, cell=0.1):
    """Two dates of a yard: the second adds a cone pile of ``pile`` m3 and digs a pit of ``pit`` m3."""
    X, Z = surface_grid(cell)
    base = terrain(X, Z)
    y1 = jitter(base, 11, noise)
    y2 = base.copy()
    if pile:
        y2 = y2 + cone(X, Z, -10.0, -8.0, pile, 6.0)
    if pit:
        y2 = y2 - cone(X, Z, 14.0, 12.0, pit, 3.0)
    y2 = jitter(y2, 12, noise)
    layers = []
    for lid, cap, Y, kind in (("surf-a", "c1", y1, kinds[0]), ("surf-b", "c2", y2, kinds[1])):
        if kind == "dsm":
            write_dsm(project / f"rasters/{lid}.tif", Y, cell)
            layers.append(
                {
                    "kind": "raster",
                    "id": lid,
                    "name": f"DSM {cap}",
                    "visible": True,
                    "capture": cap,
                    "role": "dsm",
                    "format": "cog",
                    "src": {"path": f"rasters/{lid}.tif"},
                }
            )
        elif kind == "grid":
            write_grid(project, lid, Y, cell)
            layers.append(
                {
                    "kind": "raster",
                    "id": lid,
                    "name": f"DSM {cap} (shaded relief)",
                    "visible": True,
                    "capture": cap,
                    "role": "dsm",
                    "format": "kit-pyramid",
                    "src": {"path": f"rasters/{lid}/tiles.json"},
                }
            )
        elif kind == "las":
            n = write_source_las(project, lid, X, Z, Y, seed=21 if cap == "c1" else 22)
            layers.append(
                {
                    "kind": "pointcloud",
                    "id": lid,
                    "name": f"Cloud {cap}",
                    "visible": True,
                    "capture": cap,
                    "format": "png-packed",
                    "src": {"path": f"clouds/{lid}/index.json"},
                    "pointCount": n,
                }
            )
        else:
            n = write_kit_cloud(project / f"clouds/{lid}.bin", X, Z, Y, seed=21 if cap == "c1" else 22)
            layers.append(
                {
                    "kind": "pointcloud",
                    "id": lid,
                    "name": f"Cloud {cap}",
                    "visible": True,
                    "capture": cap,
                    "format": "kit-packed",
                    "src": {"path": f"clouds/{lid}.bin"},
                    "pointCount": n,
                }
            )
    (project / "manifest.json").write_text(json.dumps(manifest(layers), indent=1), "utf-8")
    return project


#: Layer kinds of ``surface_project`` to the ``kind`` of the job's inputs.
SURFACE_KIND = {"dsm": "dsm", "grid": "dsm", "cloud": "cloud", "las": "cloud"}


def surface_params(kinds=("dsm", "dsm"), **extra) -> dict[str, Any]:
    return {
        "from": {"layer": "surf-a", "kind": SURFACE_KIND[kinds[0]]},
        "to": {"layer": "surf-b", "kind": SURFACE_KIND[kinds[1]]},
        **extra,
    }


def write_grid(
    project: Path, lid: str, Y: np.ndarray, cell: float, offset: float = -10.0, scale: float = 0.001
):
    """Heights as an ``aio.grid/1`` 16-bit PNG and its JSON in ``sources/`` (as C8's demo writes them)."""
    src = project / "sources"
    src.mkdir(parents=True, exist_ok=True)
    n = Y.shape[0]
    values = np.clip(np.round((Y + ORIGIN[2] - offset) / scale), 1, 65535).astype(np.uint16)
    Image.fromarray(values).save(src / f"{lid}.png")
    grid = {
        "schema": "aio.grid/1",
        "kind": "dsm",
        "layer": lid,
        "epsg": EPSG,
        "x0": ORIGIN[0] - SURFACE_SIZE / 2,
        "y1": ORIGIN[1] + SURFACE_SIZE / 2,
        "res": cell,
        "width": n,
        "height": n,
        "file": f"{lid}.png",
        "scale": scale,
        "offset": offset,
        "nodata": 0,
    }
    (src / f"{lid}.json").write_text(json.dumps(grid), "utf-8")


def write_source_las(project: Path, lid: str, X, Z, Y, seed: int = 3) -> int:
    """A height field as ``sources/<lid>.las`` (LAS 1.2, point format 2, project CRS E, N, H)."""
    from synth import write_las

    rng = np.random.default_rng(seed)
    x = X.ravel() + rng.uniform(-0.02, 0.02, X.size)
    z = Z.ravel() + rng.uniform(-0.02, 0.02, Z.size)
    enh = np.column_stack([ORIGIN[0] + x, ORIGIN[1] - z, ORIGIN[2] + Y.ravel()])
    (project / "sources").mkdir(parents=True, exist_ok=True)
    write_las(project / "sources" / f"{lid}.las", enh, EPSG, point_format=2)
    return len(enh)
