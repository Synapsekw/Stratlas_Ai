"""Shared parts of the imagery and surface change pipelines (M8 C2).

- ``Grid``: the common comparison grid, axis-aligned in the project local frame (x east, z south,
  data-conventions section 1), rows going south.
- Reading an ortho layer (``kit-pyramid``, ``image`` or ``cog``) onto a grid, band by band of grid
  rows from the pyramid level that matches the cell, so a large ortho is never read whole.
- Writing a change heat map as a ``kit-pyramid`` (``aio.tiles/1`` plus a ``legend``), polygons from
  a mask, lon/lat conversion, and the commit of a change run: derived files, the change set (with
  earlier reviews and a ``.bak``) and the manifest last (with ``manifest.json.bak``).
"""

from __future__ import annotations

import json
import math
import shutil
from collections.abc import Callable, Iterable
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import numpy as np

from ..runtime import (
    JobError,
    StepContext,
    atomic_write_bytes,
    atomic_write_json,
    commit_tree,
    replace_over,
    safe_project_path,
)
from .changeset import CHANGE_DIR, dump_change_set, merge_reviews, read_change_set

#: The largest comparison grid (cells); finer inputs are compared at a coarser cell.
MAX_CELLS = 2500 * 2500
#: Rows of the grid read at a time.
BAND_ROWS = 512
HEAT_TILE = 512


# ------------------------------------------------------------------------------------- manifest


def read_manifest(project: Path) -> dict[str, Any]:
    p = project / "manifest.json"
    try:
        m = json.loads(p.read_text("utf-8-sig"))
    except (OSError, ValueError) as e:
        raise JobError(f"Could not read the project manifest {p}: {e}") from e
    if not isinstance(m, dict) or m.get("schema") != "aio.project/1":
        raise JobError(f"{p} is not a project manifest (aio.project/1).")
    return m


def find_layer(manifest: dict[str, Any], layer_id: str) -> dict[str, Any]:
    for layer in manifest.get("layers") or []:
        if isinstance(layer, dict) and layer.get("id") == layer_id:
            return layer
    raise JobError(f'The project has no layer "{layer_id}".')


def asset_path(project: Path, layer: dict[str, Any]) -> Path:
    """The file of a layer's ``src`` (a path inside the project)."""
    ref = layer.get("src")
    name = layer.get("name") or layer.get("id")
    if not isinstance(ref, dict) or not isinstance(ref.get("path"), str):
        raise JobError(f'The layer "{name}" has no file path (packaged layers are read only here).')
    p = safe_project_path(project, ref["path"])
    if not p.exists():
        raise JobError(f'The file of layer "{name}" ({ref["path"]}) is missing.')
    return p


def capture_label(manifest: dict[str, Any], cid: str) -> str:
    for c in manifest.get("captures") or []:
        if c.get("id") == cid:
            return str(c.get("date") or c.get("label") or cid)
    return cid


def check_captures(manifest: dict[str, Any], a: str, b: str) -> None:
    if a == b:
        raise JobError("A change compares two different dates.")
    known = {c.get("id") for c in manifest.get("captures") or []}
    for cid in (a, b):
        if cid not in known:
            raise JobError(f'The project has no survey date "{cid}".')


# ----------------------------------------------------------------------------------------- grid


@dataclass(frozen=True)
class Grid:
    """``cols`` x ``rows`` cells of ``cell`` metres; the north-west corner at local (x0, z0)."""

    x0: float
    z0: float
    cell: float
    cols: int
    rows: int

    @staticmethod
    def over(box: tuple[float, float, float, float], cell: float) -> Grid:
        """A grid covering ``(minx, minz, maxx, maxz)``."""
        x0, z0, x1, z1 = box
        cols = max(1, math.ceil((x1 - x0) / cell - 1e-6))
        rows = max(1, math.ceil((z1 - z0) / cell - 1e-6))
        return Grid(float(x0), float(z0), float(cell), int(cols), int(rows))

    @staticmethod
    def of(d: dict[str, Any]) -> Grid:
        return Grid(float(d["x0"]), float(d["z0"]), float(d["cell"]), int(d["cols"]), int(d["rows"]))

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @property
    def box(self) -> tuple[float, float, float, float]:
        return (self.x0, self.z0, self.x0 + self.cols * self.cell, self.z0 + self.rows * self.cell)

    def centres(self, r0: int = 0, r1: int | None = None) -> tuple[np.ndarray, np.ndarray]:
        """Local x and z of the cell centres of rows ``r0`` to ``r1``."""
        r1 = self.rows if r1 is None else r1
        xs = self.x0 + (np.arange(self.cols) + 0.5) * self.cell
        zs = self.z0 + (np.arange(r0, r1) + 0.5) * self.cell
        return np.meshgrid(xs, zs)

    def affine(self):
        """(column, row) to local (x, z), for rasterio's features functions."""
        from rasterio.transform import Affine

        return Affine(self.cell, 0, self.x0, 0, self.cell, self.z0)

    def crs_transform(self, origin: list[float]):
        """(column, row) to project CRS (E, N): north up."""
        from rasterio.transform import from_origin

        return from_origin(origin[0] + self.x0, origin[1] - self.z0, self.cell, self.cell)


def cell_for(box: tuple[float, float, float, float], finest: float) -> float:
    """The comparison cell: the coarser input's, coarser still when the grid would be too large."""
    w, h = box[2] - box[0], box[3] - box[1]
    need = math.sqrt(max(w * h, 1e-9) / MAX_CELLS)
    return float(max(finest, need))


def intersect(a, b):
    box = (max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3]))
    return box if box[0] < box[2] and box[1] < box[3] else None


def union(a, b):
    return (min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3]))


# --------------------------------------------------------------------------------------- orthos


def _corners(c: Any, what: str) -> dict[str, list[float]]:
    try:
        out = {k: [float(v) for v in c[k]] for k in ("tl", "tr", "bl")}
        if all(len(v) == 3 for v in out.values()):
            return out
    except (KeyError, TypeError, ValueError):
        pass
    raise JobError(f"{what} has no valid tl, tr, bl corners.")


class Ortho:
    """An ortho layer on the ground: its corners, finest pixel size and a way to sample it."""

    def __init__(self, project: Path, manifest: dict[str, Any], layer: dict[str, Any]):
        self.project = project
        self.manifest = manifest
        self.layer = layer
        self.name = str(layer.get("name") or layer.get("id"))
        fmt = layer.get("format")
        self.path = asset_path(project, layer)
        self.files: list[str] = [str(self.path)]
        self.y = 0.0
        if fmt == "kit-pyramid":
            try:
                idx = json.loads(self.path.read_text("utf-8-sig"))
            except (OSError, ValueError) as e:
                raise JobError(f'The tile index of "{self.name}" could not be read: {e}') from e
            levels = [
                lv
                for lv in idx.get("levels") or []
                if isinstance(lv, dict) and lv.get("cols", 0) > 0 and lv.get("rows", 0) > 0
            ]
            if not levels:
                raise JobError(f'The tile index of "{self.name}" has no levels.')
            self.levels = sorted(levels, key=lambda lv: lv["cols"] * lv["tileSize"])
            self.corners = _corners(idx.get("corners") or layer.get("corners"), f'"{self.name}"')
            fine = self.levels[-1]
            self.width_px = fine["cols"] * fine["tileSize"]
            self.height_px = fine["rows"] * fine["tileSize"]
            self.files = [str(self.path.parent)]
            self.kind = "pyramid"
        elif fmt == "image":
            from PIL import Image

            self.corners = _corners(layer.get("corners"), f'"{self.name}"')
            with Image.open(self.path) as im:
                self.width_px, self.height_px = im.size
            self.kind = "image"
        elif fmt == "cog":
            self.kind = "cog"
            self._cog_footprint()
        else:
            raise JobError(
                f'"{self.name}" is a {fmt} raster; imagery change reads kit pyramids, images and GeoTIFFs.'
            )
        self.y = float(np.mean([self.corners[k][1] for k in ("tl", "tr", "bl")]))
        tl, tr, bl = (np.array(self.corners[k]) for k in ("tl", "tr", "bl"))
        self.u = (tr - tl)[[0, 2]]
        self.v = (bl - tl)[[0, 2]]
        self.tl = tl[[0, 2]]
        self.gsd = float(np.hypot(*self.u)) / self.width_px

    def _cog_footprint(self) -> None:
        import rasterio
        from rasterio.warp import transform_bounds

        with rasterio.open(self.path) as ds:
            self.width_px, self.height_px = ds.width, ds.height
            b = ds.bounds
            dst = project_crs(self.manifest)
            if ds.crs is not None and dst is not None and ds.crs != dst:
                b = transform_bounds(ds.crs, dst, *b)
                left, bottom, right, top = b
            else:
                left, bottom, right, top = b.left, b.bottom, b.right, b.top
        o = self.manifest.get("origin") or [0, 0, 0]
        x0, x1 = left - o[0], right - o[0]
        z0, z1 = o[1] - top, o[1] - bottom
        self.corners = {"tl": [x0, 0.0, z0], "tr": [x1, 0.0, z0], "bl": [x0, 0.0, z1]}

    @property
    def box(self) -> tuple[float, float, float, float]:
        pts = [self.tl, self.tl + self.u, self.tl + self.v, self.tl + self.u + self.v]
        xs, zs = [p[0] for p in pts], [p[1] for p in pts]
        return (min(xs), min(zs), max(xs), max(zs))

    def sample(self, grid: Grid, check: Callable[[], None] = lambda: None, progress=lambda f: None):
        """RGB floats 0..1 ``(rows, cols, 3)`` and a validity mask on ``grid``."""
        if self.kind == "cog":
            return self._sample_cog(grid)
        rgb = np.zeros((grid.rows, grid.cols, 3), np.float32)
        valid = np.zeros((grid.rows, grid.cols), bool)
        det = self.u[0] * self.v[1] - self.u[1] * self.v[0]
        if abs(det) < 1e-12:
            raise JobError(f'"{self.name}" has degenerate corners.')
        for r0 in range(0, grid.rows, BAND_ROWS):
            check()
            r1 = min(grid.rows, r0 + BAND_ROWS)
            X, Z = grid.centres(r0, r1)
            dx, dz = X - self.tl[0], Z - self.tl[1]
            uu = (dx * self.v[1] - dz * self.v[0]) / det
            vv = (self.u[0] * dz - self.u[1] * dx) / det
            inside = (uu >= 0) & (uu <= 1) & (vv >= 0) & (vv <= 1)
            if inside.any():
                band, ok = self._sample_uv(uu, vv, inside, grid.cell)
                rgb[r0:r1] = band
                valid[r0:r1] = ok & inside
            progress(r1 / grid.rows)
        return rgb, valid

    # -- tiles

    def _level(self, cell: float) -> dict[str, Any]:
        if self.kind == "image":
            return {"z": 0, "tw": self.width_px, "th": self.height_px, "cols": 1, "rows": 1}
        for lv in self.levels:
            gsd = float(np.hypot(*self.u)) / (lv["cols"] * lv["tileSize"])
            if gsd <= cell * 1.01:
                break
        return {
            "z": lv["z"],
            "tw": lv["tileSize"],
            "th": lv["tileSize"],
            "cols": lv["cols"],
            "rows": lv["rows"],
            "pattern": lv["pattern"],
        }

    def _tile(self, lv: dict[str, Any], x: int, y: int) -> np.ndarray | None:
        from PIL import Image

        if self.kind == "image":
            path = self.path
        else:
            rel = (
                str(lv["pattern"]).replace("{z}", str(lv["z"])).replace("{x}", str(x)).replace("{y}", str(y))
            )
            try:
                path = safe_project_path(self.project, rel)
            except JobError:
                return None
            if not path.is_file():
                return None
        try:
            with Image.open(path) as im:
                return np.asarray(im.convert("RGBA"))
        except OSError:
            return None

    def _sample_uv(self, uu, vv, inside, cell):
        from scipy import ndimage as ndi

        lv = self._level(cell)
        W, H = lv["cols"] * lv["tw"], lv["rows"] * lv["th"]
        px = uu * W - 0.5
        py = vv * H - 0.5
        sel_x, sel_y = px[inside], py[inside]
        tx0 = max(0, math.floor(sel_x.min() / lv["tw"]))
        tx1 = min(lv["cols"] - 1, math.floor((sel_x.max() + 1) / lv["tw"]))
        ty0 = max(0, math.floor(sel_y.min() / lv["th"]))
        ty1 = min(lv["rows"] - 1, math.floor((sel_y.max() + 1) / lv["th"]))
        mos = np.zeros(((ty1 - ty0 + 1) * lv["th"], (tx1 - tx0 + 1) * lv["tw"], 4), np.uint8)
        for ty in range(ty0, ty1 + 1):
            for tx in range(tx0, tx1 + 1):
                t = self._tile(lv, tx, ty)
                if t is None:
                    continue
                h, w = min(t.shape[0], lv["th"]), min(t.shape[1], lv["tw"])
                oy, ox = (ty - ty0) * lv["th"], (tx - tx0) * lv["tw"]
                mos[oy : oy + h, ox : ox + w] = t[:h, :w]
        cy, cx = py - ty0 * lv["th"], px - tx0 * lv["tw"]
        coords = np.array([cy.ravel(), cx.ravel()])
        out = np.zeros((*uu.shape, 3), np.float32)
        for k in range(3):
            out[..., k] = (
                ndi.map_coordinates(mos[..., k].astype(np.float32), coords, order=1, mode="nearest").reshape(
                    uu.shape
                )
                / 255.0
            )
        alpha = ndi.map_coordinates(
            mos[..., 3].astype(np.float32), coords, order=1, mode="constant", cval=0
        ).reshape(uu.shape)
        return out, alpha > 254.0 * 0.999

    def _sample_cog(self, grid: Grid):
        import rasterio
        from rasterio.enums import ColorInterp, Resampling
        from rasterio.warp import reproject

        dst_crs = project_crs(self.manifest)
        transform = grid.crs_transform(self.manifest.get("origin") or [0, 0, 0])
        rgb = np.zeros((grid.rows, grid.cols, 3), np.float32)
        valid = np.ones((grid.rows, grid.cols), bool)
        with rasterio.open(self.path) as ds:
            if ds.dtypes[0] != "uint8":
                raise JobError(f'"{self.name}" is {ds.dtypes[0]}; an ortho must be 8-bit RGB.')
            src_crs = ds.crs or dst_crs
            bands = [1, 2, 3] if ds.count >= 3 else [1, 1, 1]
            alpha = next((i + 1 for i, c in enumerate(ds.colorinterp) if c == ColorInterp.alpha), None)
            for k, b in enumerate(bands):
                dest = np.full((grid.rows, grid.cols), -1.0, np.float32)
                reproject(
                    rasterio.band(ds, b),
                    dest,
                    src_transform=ds.transform,
                    src_crs=src_crs,
                    src_nodata=ds.nodata,
                    dst_transform=transform,
                    dst_crs=dst_crs or src_crs,
                    dst_nodata=-1.0,
                    resampling=Resampling.bilinear,
                )
                valid &= dest >= 0
                rgb[..., k] = np.clip(dest, 0, 255) / 255.0
            if alpha:
                dest = np.zeros((grid.rows, grid.cols), np.float32)
                reproject(
                    rasterio.band(ds, alpha),
                    dest,
                    src_transform=ds.transform,
                    src_crs=src_crs,
                    dst_transform=transform,
                    dst_crs=dst_crs or src_crs,
                    resampling=Resampling.nearest,
                )
                valid &= dest > 127
        return rgb, valid


# ------------------------------------------------------------------------------------- geometry


def project_crs(manifest: dict[str, Any]):
    from rasterio.crs import CRS

    crs = manifest.get("crs") or {}
    try:
        if isinstance(crs.get("epsg"), int):
            return CRS.from_epsg(crs["epsg"])
        if isinstance(crs.get("wkt"), str):
            return CRS.from_wkt(crs["wkt"])
    except Exception as e:
        raise JobError(f"The project CRS could not be read: {e}") from e
    return None


def to_lonlat(manifest: dict[str, Any], xs: Iterable[float], zs: Iterable[float]) -> list[list[float]] | None:
    """Local (x, z) points as [lon, lat]; None when the project has no usable CRS."""
    from rasterio.warp import transform

    crs = project_crs(manifest)
    if crs is None:
        return None
    o = manifest.get("origin") or [0, 0, 0]
    E = [o[0] + float(x) for x in xs]
    N = [o[1] - float(z) for z in zs]
    try:
        lon, lat = transform(crs, "EPSG:4326", E, N)
    except Exception:
        return None
    return [[round(a, 8), round(b, 8)] for a, b in zip(lon, lat, strict=True)]


def from_lonlat(manifest: dict[str, Any], ring: list[list[float]]) -> list[tuple[float, float]]:
    """A lon/lat ring as local (x, z)."""
    from rasterio.warp import transform

    crs = project_crs(manifest)
    if crs is None:
        raise JobError("The project has no coordinate system, so map polygons cannot be placed.")
    o = manifest.get("origin") or [0, 0, 0]
    E, N = transform("EPSG:4326", crs, [p[0] for p in ring], [p[1] for p in ring])
    return [(e - o[0], o[1] - n) for e, n in zip(E, N, strict=True)]


def ring_mask(manifest: dict[str, Any], rings: list[list[list[float]]], grid: Grid) -> np.ndarray:
    """Cells of ``grid`` inside any of the lon/lat rings."""
    from rasterio import features
    from shapely.geometry import Polygon

    shapes = []
    for ring in rings:
        pts = from_lonlat(manifest, ring)
        poly = Polygon(pts)
        if not poly.is_valid:
            poly = poly.buffer(0)
        if not poly.is_empty:
            shapes.append((poly, 1))
    if not shapes:
        return np.zeros((grid.rows, grid.cols), bool)
    return features.rasterize(
        shapes, out_shape=(grid.rows, grid.cols), transform=grid.affine(), fill=0, dtype="uint8"
    ).astype(bool)


def polygons(mask: np.ndarray, grid: Grid, simplify: float | None = None) -> list[Any]:
    """Outer polygons (shapely, local x/z) of the connected parts of ``mask``."""
    from rasterio import features
    from shapely.geometry import shape

    out = []
    for geom, val in features.shapes(
        mask.astype(np.uint8), mask=mask, transform=grid.affine(), connectivity=8
    ):
        if val != 1:
            continue
        poly = shape(geom)
        if simplify:
            poly = poly.simplify(simplify, preserve_topology=True)
        if not poly.is_empty:
            out.append(poly)
    return out


def outline(
    manifest: dict[str, Any], poly: Any, y: float
) -> tuple[list[list[float]] | None, list[list[float]]]:
    """A polygon's exterior as a lon/lat ring and as local [x, y, z] points."""
    xs, zs = poly.exterior.coords.xy
    local = [[round(float(x), 3), round(y, 3), round(float(z), 3)] for x, z in zip(xs, zs, strict=True)]
    return to_lonlat(manifest, xs, zs), local


# -------------------------------------------------------------------------------------- heat map


def colour_ramp(values: np.ndarray, stops: list[tuple[float, str, float]]) -> np.ndarray:
    """RGBA uint8 of ``values`` through ``(value, #rrggbb, alpha)`` stops (linear between stops)."""
    vs = np.array([s[0] for s in stops], float)
    cols = np.array(
        [[int(s[1][i : i + 2], 16) for i in (1, 3, 5)] + [round(s[2] * 255)] for s in stops], float
    )
    out = np.zeros((*values.shape, 4), np.uint8)
    ok = np.isfinite(values)
    v = np.where(ok, values, vs[0])
    for k in range(4):
        out[..., k] = np.round(np.interp(v, vs, cols[:, k]))
    out[~ok] = 0
    return out


def write_pyramid(
    rgba: np.ndarray,
    grid: Grid,
    out_dir: Path,
    rel_dir: str,
    y: float,
    legend: dict[str, Any],
    check: Callable[[], None] = lambda: None,
) -> dict[str, Any]:
    """Write ``rgba`` (rows, cols, 4) as a kit pyramid in ``out_dir``; return its ``aio.tiles/1``.

    The finest level is the grid itself; each coarser level halves it, down to one tile or two.
    Tiles are WebP with alpha; empty tiles are written too, so a viewer never asks for a missing
    one. ``legend`` (the colour stops) goes in the index for the app's legend.
    """
    from PIL import Image

    t = HEAT_TILE
    n_levels = 1
    while max(grid.cols, grid.rows) > t * 2 ** (n_levels - 1):
        n_levels += 1
    f = 2 ** (n_levels - 1)
    cols = math.ceil(grid.cols / (t * f)) * f
    rows = math.ceil(grid.rows / (t * f)) * f
    img = np.zeros((rows * t, cols * t, 4), np.uint8)
    img[: grid.rows, : grid.cols] = rgba
    levels = []
    level = Image.fromarray(img, "RGBA")
    for z in range(n_levels - 1, -1, -1):
        check()
        lc, lr = cols // 2 ** (n_levels - 1 - z), rows // 2 ** (n_levels - 1 - z)
        if z < n_levels - 1:
            level = level.convert("RGBa").resize((lc * t, lr * t), Image.Resampling.BOX).convert("RGBA")
        for ty in range(lr):
            for tx in range(lc):
                p = out_dir / str(z) / f"{tx}_{ty}.webp"
                p.parent.mkdir(parents=True, exist_ok=True)
                level.crop((tx * t, ty * t, (tx + 1) * t, (ty + 1) * t)).save(p, "WEBP", quality=88, method=4)
        levels.append(
            {"z": z, "tileSize": t, "cols": lc, "rows": lr, "pattern": f"{rel_dir}/{z}/{{x}}_{{y}}.webp"}
        )
    W, H = cols * t * grid.cell, rows * t * grid.cell
    y = round(y, 3)
    return {
        "schema": "aio.tiles/1",
        "levels": sorted(levels, key=lambda lv: lv["z"]),
        "corners": {
            "tl": [round(grid.x0, 4), y, round(grid.z0, 4)],
            "tr": [round(grid.x0 + W, 4), y, round(grid.z0, 4)],
            "bl": [round(grid.x0, 4), y, round(grid.z0 + H, 4)],
        },
        "metresPerPx": [round(grid.cell * 2 ** (n_levels - 1 - z), 6) for z in range(n_levels)],
        "legend": legend,
    }


# ---------------------------------------------------------------------------------------- commit


def save_arrays(path: Path, **arrays: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.stem + ".tmp.npz")
    np.savez_compressed(tmp, **arrays)
    replace_over(tmp, path)


def load_arrays(path: Path) -> dict[str, np.ndarray]:
    if not path.is_file():
        raise JobError(f"The staged file {path.name} is missing; start the job again.")
    with np.load(path) as z:
        return {k: z[k] for k in z.files}


def commit_run(
    ctx: StepContext,
    set_id: str,
    staged_dir: str,
    out_dir: str,
    change_set: dict[str, Any],
    layers: list[dict[str, Any]],
) -> dict[str, Any]:
    """Move a run into the project: derived files, the change set, then the manifest."""
    old = ctx.out(out_dir)
    if old.exists() and not (ctx.job.dir / "steps" / ".committing").exists():
        # files of an earlier run of this pair: replaced whole (the change set keeps the reviews)
        shutil.rmtree(old)
    (ctx.job.dir / "steps").mkdir(parents=True, exist_ok=True)
    (ctx.job.dir / "steps" / ".committing").write_text("", "utf-8")
    files = commit_tree(ctx, staged_dir, out_dir)
    set_path = ctx.out(f"{CHANGE_DIR}/{set_id}.json")
    previous = read_change_set(set_path) if set_path.exists() else None
    merged = merge_reviews(change_set, previous)
    if set_path.exists():
        shutil.copy2(set_path, set_path.with_name(set_path.name + ".bak"))
    atomic_write_bytes(set_path, dump_change_set(merged))
    ctx.artifact(f"{CHANGE_DIR}/{set_id}.json")
    mpath = ctx.out("manifest.json")
    manifest = read_manifest(ctx.project)
    ids = {x["id"] for x in layers}
    kept = list(manifest.get("layers") or [])
    for x in layers:
        at = next((i for i, k in enumerate(kept) if isinstance(k, dict) and k.get("id") == x["id"]), None)
        if at is None:
            kept.append(x)
        else:
            kept[at] = x
    manifest["layers"] = kept
    shutil.copyfile(mpath, mpath.with_name("manifest.json.bak"))
    atomic_write_json(mpath, manifest, indent=2)
    ctx.artifact("manifest.json")
    (ctx.job.dir / "steps" / ".committing").unlink(missing_ok=True)
    return {
        "files": files,
        "changeSet": f"{CHANGE_DIR}/{set_id}.json",
        "layers": sorted(ids),
        "items": len(merged["items"]),
    }


def derived(from_c: str, to_c: str, set_id: str, run_id: str, source: list[str]) -> dict[str, Any]:
    return {
        "kind": "change",
        "from": from_c,
        "to": to_c,
        "changeId": set_id,
        "runId": run_id,
        "source": source,
    }
