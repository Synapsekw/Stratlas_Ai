"""survey.prepare: surfaces to height tiles (``aio.height-tiles/1``, data-conventions section 26).

Parameters as ``SurveyPrepareParams`` in ``@aio/schema`` (``jobs.ts``): ``surfaces[]`` of
``{ id, name, source, capture? }``, ``cellM?``, ``geodesy?``. One step per surface, then the site
tables (G1, when ``geodesy`` is not false and ``aio_pipelines.geodesy.site.write_site_tables``
exists), then the commit:

- ``dsm`` and ``dtm``: a raster layer with role ``dsm`` (a ``cog`` GeoTIFF read through rasterio,
  reprojected into the project CRS when it is in another, or an ``aio.grid/1`` height grid of a
  viewing layer); on its own pixel grid unless ``cellM`` asks for another cell;
- ``cloud``: a point cloud layer (``kit-packed``, ``copc`` through PDAL, or its LAS source) as the
  mean height of its points per cell, small gaps closed (as ``change.surface`` grids a cloud);
- ``design``: a design surface layer (``survey/designs/<design>/<layer>.tin``, ``aio.tin/1``,
  written by G6) rasterised barycentrically, its vertical offset added;
- ``derived``: another prepared surface with its terrain edits (``survey/cleanups.json``):
  ``crop`` keeps the ring, ``cleanup`` with ``method: 'tin'`` replaces the inside of the ring by a
  triangulation of the ring's edge sampled on the surface (``thin-plate`` is ``survey.cleanup``'s).

Tiles of 256 by 256 cells, rows from the south, heights float32 relative to a float64 base per tile
(``grid.encode_tile``), only the tiles that hold data, and a display pyramid of the means of the
valid 2 by 2 cells below. A surface whose ``fingerprint`` (the source files' SHA-256, the source,
the cell and this module's version) has not changed is left as it is. Steps are resumable and
cancellable; the commit replaces ``survey/surfaces/<id>/`` with ``tiles.json`` written last.
"""

from __future__ import annotations

import hashlib
import json
import math
import shutil
from pathlib import Path
from typing import Any

import numpy as np

from ..params import known_keys
from ..runtime import (
    JobError,
    Step,
    StepContext,
    atomic_write_bytes,
    atomic_write_json,
    commit_files,
    now_iso,
)
from .grid import TILE, TileSurface, Window, coverage, densify, encode_tile, normal_ring, read_tiles_json
from .tin import Tin, delaunay, rasterize, read_tin

PREPARE_VERSION = 1
SURFACES_DIR = "survey/surfaces"
SOURCE_KINDS = ("dsm", "dtm", "cloud", "design", "derived")
SAFE_ID = __import__("re").compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
#: The largest grid prepared (cells); a finer cell is refused with the cell that fits.
MAX_CELLS = 1_000_000_000
#: Default cell of a design rasterised for viewing when no cell is given.
DESIGN_MAX_CELLS = 16_000_000
GAP_PASSES = 3


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ----------------------------------------------------------------------------------- the sources


class Heights:
    """A grid in the project CRS: ``h[j, i]`` (row 0 south, NaN no data) at ``cell`` from (oe, on)."""

    def __init__(self, oe: float, on: float, cell: float, h: np.ndarray):
        self.oe, self.on, self.cell, self.h = float(oe), float(on), float(cell), h


def _manifest(project: Path) -> dict[str, Any]:
    from ..change.imagery import read_manifest

    return read_manifest(project)


def _layer(manifest: dict[str, Any], lid: str) -> dict[str, Any]:
    from ..change.imagery import find_layer

    return find_layer(manifest, lid)


def _crs_of(manifest: dict[str, Any]) -> dict[str, Any]:
    crs = manifest.get("crs")
    if not isinstance(crs, dict) or not (isinstance(crs.get("epsg"), int) or isinstance(crs.get("wkt"), str)):
        raise JobError("The project has no coordinate system; set one before preparing surfaces.")
    return {"epsg": crs["epsg"]} if isinstance(crs.get("epsg"), int) else {"wkt": crs["wkt"]}


def source_files(project: Path, manifest: dict[str, Any], source: dict[str, Any]) -> list[Path]:
    """The files a source is read from (their hashes make the fingerprint)."""
    from ..change.imagery import asset_path
    from ..change.sources import cloud_source, grid_source

    kind = source["kind"]
    if kind in ("dsm", "dtm"):
        layer = _layer(manifest, source["layer"])
        if layer.get("kind") != "raster" or layer.get("role") != "dsm":
            raise JobError(f'The layer "{layer.get("name") or layer.get("id")}" is not a DSM or DTM raster.')
        if layer.get("format") == "cog":
            return [asset_path(project, layer)]
        g = grid_source(project, layer, manifest)
        return [g.json_path, g.image]
    if kind == "cloud":
        layer = _layer(manifest, source["layer"])
        if layer.get("kind") != "pointcloud":
            raise JobError(f'The layer "{layer.get("name") or layer.get("id")}" is not a point cloud.')
        if layer.get("format") in ("kit-packed", "copc"):
            return [asset_path(project, layer)]
        return [cloud_source(project, layer)]
    if kind == "design":
        entry, layer = _design(project, source["design"], source["layer"])
        return [project / "survey" / "designs" / entry["id"] / str(layer["file"])]
    if kind == "derived":
        return [project / SURFACES_DIR / source["of"] / "tiles.json", project / "survey" / "cleanups.json"]
    raise JobError(f'"{kind}" is not a surface source.')


def _design(project: Path, did: str, lid: str) -> tuple[dict[str, Any], dict[str, Any]]:
    p = project / "survey" / "designs.json"
    try:
        designs = json.loads(p.read_text("utf-8"))
    except (OSError, ValueError) as e:
        raise JobError(f"The designs list could not be read: {e}") from e
    entry = next((d for d in designs.get("designs") or [] if d.get("id") == did), None)
    layer = next((x for x in (entry or {}).get("layers") or [] if x.get("id") == lid), None)
    if entry is None or layer is None or layer.get("kind") != "surface":
        raise JobError(f'The design surface "{did}, {lid}" is not in the designs list.')
    return entry, layer


def _aligned(lo: float, cell: float) -> float:
    return math.floor(lo / cell) * cell


def _check_size(nx: int, ny: int, cell: float) -> None:
    if nx * ny > MAX_CELLS:
        need = cell * math.sqrt(nx * ny / MAX_CELLS)
        raise JobError(f"The surface is too large at {cell:g} m cells; use cells of {need:.2f} m or more.")


def read_raster(
    ctx: StepContext, manifest: dict[str, Any], source: dict[str, Any], cell: float | None
) -> Heights:
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.warp import reproject

    from ..change.imagery import asset_path, project_crs
    from ..change.sources import grid_source

    layer = _layer(manifest, source["layer"])
    if layer.get("format") != "cog":
        g = grid_source(ctx.project, layer, manifest)
        h = g.heights()[::-1].copy()
        oe, on = g.x0, g.y1 - g.height * g.res
        if cell is None or abs(cell - g.res) < 1e-12:
            return Heights(oe, on, g.res, h)
        return _resample(Heights(oe, on, g.res, h), cell)
    path = asset_path(ctx.project, layer)
    dst_crs = project_crs(manifest)
    with rasterio.open(path) as ds:
        same = ds.crs is None or dst_crs is None or ds.crs == dst_crs
        res = min(abs(ds.res[0]), abs(ds.res[1]))
        if same and ds.transform.b == 0 and ds.transform.d == 0 and (cell is None or abs(cell - res) < 1e-12):
            b = ds.bounds
            _check_size(ds.width, ds.height, res)
            data = ds.read(1, masked=True).astype(np.float64).filled(np.nan)
            if abs(abs(ds.res[0]) - abs(ds.res[1])) > 1e-9:
                raise JobError(f"The DSM {path.name} has cells that are not square; give a cell size.")
            return Heights(b.left, b.bottom, res, data[::-1].copy())
        from rasterio.warp import transform_bounds

        left, bottom, right, top = transform_bounds(ds.crs, dst_crs, *ds.bounds) if not same else ds.bounds
        c = float(cell or res)
        oe, on = _aligned(left, c), _aligned(bottom, c)
        nx, ny = math.ceil((right - oe) / c), math.ceil((top - on) / c)
        _check_size(nx, ny, c)
        from rasterio.transform import from_origin

        nodata = -3.0e38
        out = np.full((ny, nx), nodata, np.float32)
        reproject(
            rasterio.band(ds, 1),
            out,
            src_transform=ds.transform,
            src_crs=ds.crs or dst_crs,
            src_nodata=ds.nodata,
            dst_transform=from_origin(oe, on + ny * c, c, c),
            dst_crs=dst_crs or ds.crs,
            dst_nodata=nodata,
            resampling=Resampling.bilinear,
        )
        h = out.astype(np.float64)
        h[(out <= nodata * 0.5) | ~np.isfinite(h)] = np.nan
        return Heights(oe, on, c, h[::-1].copy())


def _resample(src: Heights, cell: float) -> Heights:
    """Bilinear resampling of a grid onto cells of ``cell`` aligned to multiples of it."""
    from .grid import ArraySurface, bilinear

    s = ArraySurface(src.oe, src.on, src.cell, src.h)
    x0, y0, x1, y1 = s.bounds
    oe, on = _aligned(x0, cell), _aligned(y0, cell)
    nx, ny = math.ceil((x1 - oe) / cell), math.ceil((y1 - on) / cell)
    _check_size(nx, ny, cell)
    xs = (np.arange(nx) + 0.5) * cell
    h = np.empty((ny, nx))
    for j in range(ny):
        h[j] = bilinear(s, xs, np.full(nx, (j + 0.5) * cell), oe - src.oe, on - src.on)
    return Heights(oe, on, cell, h)


def read_cloud(
    ctx: StepContext, manifest: dict[str, Any], source: dict[str, Any], cell: float | None
) -> Heights:
    from scipy import ndimage as ndi

    from ..change.surface import Surface

    s = Surface(ctx.project, manifest, {"layer": source["layer"], "kind": "cloud"})
    pts = s.points(ctx)
    if len(pts) == 0:
        raise JobError(f'The point cloud "{s.name}" has no points.')
    o = manifest.get("origin") or [0, 0, 0]
    e = pts[:, 0] + o[0]
    n = o[1] - pts[:, 2]
    z = pts[:, 1] + o[2]
    area = max(1e-6, float((e.max() - e.min()) * (n.max() - n.min())))
    c = float(cell or max(0.05, round(2 * math.sqrt(area / len(pts)), 3)))
    oe, on = _aligned(float(e.min()), c), _aligned(float(n.min()), c)
    nx = max(1, math.ceil((float(e.max()) - oe) / c + 1e-9))
    ny = max(1, math.ceil((float(n.max()) - on) / c + 1e-9))
    _check_size(nx, ny, c)
    ci = np.minimum(np.floor((e - oe) / c).astype(np.int64), nx - 1)
    rj = np.minimum(np.floor((n - on) / c).astype(np.int64), ny - 1)
    idx = rj * nx + ci
    tot = np.bincount(idx, weights=z, minlength=nx * ny)
    cnt = np.bincount(idx, minlength=nx * ny)
    with np.errstate(invalid="ignore", divide="ignore"):
        h = (tot / cnt).reshape(ny, nx)
    empty = (cnt == 0).reshape(ny, nx)
    k3 = np.ones((3, 3))
    for _ in range(GAP_PASSES):
        ctx.check()
        have = ~empty
        nb = ndi.convolve(have.astype(np.float64), k3, mode="constant")
        grow = empty & (nb >= 3)
        if not grow.any():
            break
        sums = ndi.convolve(np.where(have, h, 0.0), k3, mode="constant")
        h[grow] = sums[grow] / nb[grow]
        empty &= ~grow
    h[empty] = np.nan
    return Heights(oe, on, c, h)


def read_design(ctx: StepContext, source: dict[str, Any], cell: float | None) -> Heights:
    entry, layer = _design(ctx.project, source["design"], source["layer"])
    path = ctx.project / "survey" / "designs" / entry["id"] / str(layer["file"])
    offset = float(layer.get("verticalOffsetM") or 0.0)
    absolute = read_tin(path, 0.0, 0.0, offset)
    if len(absolute.tris) == 0:
        raise JobError(f'The design surface "{entry.get("name")}, {layer.get("name")}" has no triangles.')
    x0, x1 = float(absolute.x.min()), float(absolute.x.max())
    y0, y1 = float(absolute.y.min()), float(absolute.y.max())
    c = float(cell or max(0.1, round(math.sqrt((x1 - x0) * (y1 - y0) / DESIGN_MAX_CELLS), 3)))
    oe, on = _aligned(x0, c), _aligned(y0, c)
    nx, ny = max(1, math.ceil((x1 - oe) / c)), max(1, math.ceil((y1 - on) / c))
    _check_size(nx, ny, c)
    tin = Tin(absolute.x - oe, absolute.y - on, absolute.z, absolute.tris)
    h = np.full((ny, nx), np.nan)
    for b0 in range(0, ny, TILE):
        ctx.check()
        win = Window(c, 0, b0, nx, min(TILE, ny - b0))
        h[b0 : b0 + win.ny] = rasterize(tin, win, ctx.check)
        ctx.progress(0.5 * (b0 + win.ny) / ny, "Design")
    return Heights(oe, on, c, h)


def read_derived(ctx: StepContext, source: dict[str, Any], cell: float | None) -> Heights:
    of = source["of"]
    folder = ctx.project / SURFACES_DIR / of
    meta = read_tiles_json(folder)
    s = TileSurface(folder, meta)
    h = s.read(0, 0, s.nx, s.ny)
    base = Heights(s.origin_e, s.origin_n, s.cell, h)
    edits = _edits(ctx.project, of, source.get("edits") or [])
    try:  # survey.cleanup (G8) owns cleanups; use its implementation when it has one
        from .cleanup import apply_edits  # type: ignore[attr-defined]
    except ImportError:
        apply_edits = None
    if apply_edits is not None:
        base.h = apply_edits(base.h, base.oe, base.on, base.cell, edits, ctx)
    else:
        for e in edits:
            ctx.check()
            _apply_edit(base, e)
    if cell is not None and abs(cell - base.cell) > 1e-12:
        base = _resample(base, cell)
    return base


def _edits(project: Path, surface: str, ids: list[str]) -> list[dict[str, Any]]:
    p = project / "survey" / "cleanups.json"
    try:
        doc = json.loads(p.read_text("utf-8")) if ids else {"edits": []}
    except (OSError, ValueError) as e:
        raise JobError(f"The terrain edits could not be read: {e}") from e
    by_id = {e.get("id"): e for e in doc.get("edits") or [] if isinstance(e, dict)}
    out = []
    for eid in ids:
        e = by_id.get(eid)
        if e is None:
            raise JobError(f'The terrain edit "{eid}" is not in survey/cleanups.json.')
        if e.get("surface") != surface:
            raise JobError(
                f'The terrain edit "{eid}" belongs to the surface "{e.get("surface")}", not "{surface}".'
            )
        if e.get("enabled", True):
            out.append(e)
    return out


def _apply_edit(g: Heights, edit: dict[str, Any]) -> None:
    from .grid import ArraySurface, bilinear

    ring = normal_ring([(p[0] - g.oe, p[1] - g.on) for p in edit["ring"]])
    if len(ring) < 3:
        raise JobError(f'The terrain edit "{edit.get("id")}" needs three or more points.')
    ny, nx = g.h.shape
    win = Window(g.cell, 0, 0, nx, ny)
    inside = coverage(ring, win) >= 0.5
    if edit.get("kind") == "crop":
        g.h[~inside] = np.nan
        return
    if edit.get("method", "tin") != "tin":
        raise JobError("A thin-plate cleanup is made by Terrain cleanup (survey.cleanup).")
    s = ArraySurface(0.0, 0.0, g.cell, g.h)
    xs, ys = densify(ring, g.cell)
    zs = bilinear(s, xs, ys, 0.0, 0.0)
    ok = np.isfinite(zs)
    if ok.sum() < 3:
        raise JobError(f'The edge of the terrain edit "{edit.get("id")}" has too little survey under it.')
    tris = delaunay(xs[ok], ys[ok])
    filled = rasterize(Tin(xs[ok], ys[ok], zs[ok], tris), win)
    use = inside & np.isfinite(filled)
    g.h[use] = filled[use]


# ------------------------------------------------------------------------------------- the tiles


def write_tiles(ctx: StepContext, g: Heights, out_dir: str) -> dict[str, Any]:
    """Level 0 and the display pyramid of ``g`` into staging; the ``tiles.json`` fields."""
    level = g.h
    cols = max(1, math.ceil(level.shape[1] / TILE))
    rows = max(1, math.ceil(level.shape[0] / TILE))
    present: list[str] = []
    zmin, zmax = math.inf, -math.inf
    emin = nmin = math.inf
    emax = nmax = -math.inf
    levels = 1
    lv = 0
    while True:
        lc = max(1, math.ceil(level.shape[1] / TILE))
        lr = max(1, math.ceil(level.shape[0] / TILE))
        for r in range(lr):
            ctx.check()
            for c in range(lc):
                t = np.full((TILE, TILE), np.nan)
                part = level[r * TILE : (r + 1) * TILE, c * TILE : (c + 1) * TILE]
                t[: part.shape[0], : part.shape[1]] = part
                ok = np.isfinite(t)
                if not ok.any():
                    continue
                atomic_write_bytes(ctx.stage(f"{out_dir}/{lv}/{c}_{r}.bin"), encode_tile(t))
                if lv == 0:
                    present.append(f"{c}_{r}")
                    zmin, zmax = min(zmin, float(t[ok].min())), max(zmax, float(t[ok].max()))
                    jj, ii = np.nonzero(ok)
                    emin = min(emin, g.oe + (c * TILE + ii.min()) * g.cell)
                    emax = max(emax, g.oe + (c * TILE + ii.max() + 1) * g.cell)
                    nmin = min(nmin, g.on + (r * TILE + jj.min()) * g.cell)
                    nmax = max(nmax, g.on + (r * TILE + jj.max() + 1) * g.cell)
            ctx.progress(0.5 + 0.5 * min(1.0, (r + 1) / lr) / (lv + 1), f"Tiles, level {lv}")
        if (lc <= 1 and lr <= 1) or levels >= 20:
            break
        # the next level: mean of the valid 2 by 2 cells
        ny2, nx2 = math.ceil(level.shape[0] / 2), math.ceil(level.shape[1] / 2)
        pad = np.full((ny2 * 2, nx2 * 2), np.nan)
        pad[: level.shape[0], : level.shape[1]] = level
        blocks = pad.reshape(ny2, 2, nx2, 2)
        ok = np.isfinite(blocks)
        n = ok.sum(axis=(1, 3))
        with np.errstate(invalid="ignore", divide="ignore"):
            level = np.where(n > 0, np.where(ok, blocks, 0.0).sum(axis=(1, 3)) / n, np.nan)
        levels += 1
        lv += 1
    if not present:
        raise JobError("The surface has no heights.")
    return {
        "cols": cols,
        "rows": rows,
        "levels": levels,
        "tiles": present,
        "bounds": [emin, nmin, zmin, emax, nmax, zmax],
    }


# -------------------------------------------------------------------------------------- pipeline


def _check_source(src: Any, where: str) -> None:
    if not isinstance(src, dict) or src.get("kind") not in SOURCE_KINDS:
        raise JobError(f"{where}.kind must be one of: {', '.join(SOURCE_KINDS)}.")
    need = {
        "dsm": ("layer",),
        "dtm": ("layer",),
        "cloud": ("layer",),
        "design": ("design", "layer"),
        "derived": ("of",),
    }[src["kind"]]
    for k in need:
        if not isinstance(src.get(k), str) or not src[k]:
            raise JobError(f"{where}.{k} is required.")
    if src["kind"] == "derived" and not (
        isinstance(src.get("edits"), list) and all(isinstance(e, str) for e in src["edits"])
    ):
        raise JobError(f"{where}.edits must be a list of edit ids.")


class SurveyPrepare:
    name = "survey.prepare"
    title = "Prepare surfaces"
    description = (
        "A DSM, DTM, cloud, design or cleaned surface to height tiles for measuring, "
        "plus the site coordinate tables."
    )
    keys = frozenset({"surfaces", "cellM", "geodesy"})
    required = frozenset({"surfaces"})

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        known_keys(params, set(self.keys), self.name)
        if params.get("surfaces") is None:
            raise JobError(f"{self.name} needs: surfaces.")
        surfaces = params["surfaces"]
        if not isinstance(surfaces, list) or not 1 <= len(surfaces) <= 50:
            raise JobError("surfaces must be a list of 1 to 50 surfaces.")
        seen = set()
        for k, s in enumerate(surfaces):
            if not isinstance(s, dict) or set(s) - {"id", "name", "source", "capture"}:
                raise JobError(f"surfaces[{k}] must be {{ id, name, source, capture? }}.")
            if not isinstance(s.get("id"), str) or not SAFE_ID.match(s["id"]):
                raise JobError(f"surfaces[{k}].id must be letters, digits, dot, dash or _.")
            if s["id"] in seen:
                raise JobError(f'The surface "{s["id"]}" is listed twice.')
            seen.add(s["id"])
            if not isinstance(s.get("name"), str) or not s["name"]:
                raise JobError(f"surfaces[{k}].name is required.")
            _check_source(s.get("source"), f"surfaces[{k}].source")
            if s["source"]["kind"] == "derived" and s["source"]["of"] == s["id"]:
                raise JobError(f'The surface "{s["id"]}" cannot be derived from itself.')
        cell = params.get("cellM")
        if cell is not None and (
            isinstance(cell, bool) or not isinstance(cell, int | float) or not 0.01 <= cell <= 100
        ):
            raise JobError("cellM must be between 0.01 and 100.")
        if params.get("geodesy") is not None and not isinstance(params["geodesy"], bool):
            raise JobError("geodesy must be true or false.")
        return dict(params)

    def plan(self, params: dict[str, Any]) -> list[Step]:
        cell = params.get("cellM")
        cell = float(cell) if cell is not None else None
        steps: list[Step] = []
        for k, spec in enumerate(params["surfaces"]):
            steps.append(Step(f"surface-{k + 1}", f"Prepare {spec['name']}", self._one(spec, cell), 3.0))
        if params.get("geodesy", True):
            steps.append(Step("geodesy", "Site coordinate tables", _geodesy(params), 0.5))
        steps.append(Step("commit", "Save the surfaces", self._commit(params), 1.0))
        return steps

    def _one(self, spec: dict[str, Any], cell: float | None):
        def run(ctx: StepContext) -> dict[str, Any]:
            manifest = _manifest(ctx.project)
            src = spec["source"]
            files = source_files(ctx.project, manifest, src)
            hashes = [_sha256(f) if f.is_file() else "" for f in files]
            fp = (
                "sha256:"
                + hashlib.sha256(
                    json.dumps(
                        {"v": PREPARE_VERSION, "source": src, "cellM": cell, "files": hashes},
                        sort_keys=True,
                        separators=(",", ":"),
                    ).encode()
                ).hexdigest()
            )
            old = ctx.project / SURFACES_DIR / spec["id"] / "tiles.json"
            if old.is_file():
                try:
                    if json.loads(old.read_text("utf-8")).get("fingerprint") == fp:
                        ctx.log(f'"{spec["name"]}" is already prepared from the same source.')
                        return {"id": spec["id"], "skipped": True}
                except ValueError:
                    pass
            if src["kind"] in ("dsm", "dtm"):
                g = read_raster(ctx, manifest, src, cell)
            elif src["kind"] == "cloud":
                g = read_cloud(ctx, manifest, src, cell)
            elif src["kind"] == "design":
                g = read_design(ctx, src, cell)
            else:
                g = read_derived(ctx, src, cell)
            ctx.progress(0.5, "Tiles")
            out_dir = f"surfaces/{spec['id']}"
            fields = write_tiles(ctx, g, out_dir)
            meta: dict[str, Any] = {
                "schema": "aio.height-tiles/1",
                "id": spec["id"],
                "name": spec["name"],
                "source": src,
                **({"capture": spec["capture"]} if spec.get("capture") else {}),
                "crs": _crs_of(manifest),
                "cellM": g.cell,
                "tileSize": TILE,
                "originE": g.oe,
                "originN": g.on,
                **fields,
                **({"sourceSha256": hashes[0]} if hashes and hashes[0] else {}),
                "fingerprint": fp,
                "preparedAt": now_iso(),
            }
            atomic_write_json(ctx.stage(f"{out_dir}/tiles.json"), meta)
            return {"id": spec["id"], "skipped": False, "tiles": len(fields["tiles"]), "cellM": g.cell}

        return run

    def _commit(self, params: dict[str, Any]):
        def commit(ctx: StepContext) -> dict[str, Any]:
            done = []
            marker = ctx.job.dir / "steps" / ".committing"
            for k, spec in enumerate(params["surfaces"]):
                out = ctx.outputs(f"surface-{k + 1}")
                if out.get("skipped"):
                    continue
                sid = spec["id"]
                staged = ctx.staging / "surfaces" / sid
                dest = ctx.out(f"{SURFACES_DIR}/{sid}")
                mark = marker.with_name(f".committing-{sid}")
                if dest.exists() and not mark.exists() and staged.exists():
                    shutil.rmtree(dest)
                mark.parent.mkdir(parents=True, exist_ok=True)
                mark.write_text("", "utf-8")
                files = sorted(p for p in staged.rglob("*") if p.is_file()) if staged.exists() else []
                moves = [
                    (
                        f"surfaces/{sid}/{p.relative_to(staged).as_posix()}",
                        f"{SURFACES_DIR}/{sid}/{p.relative_to(staged).as_posix()}",
                    )
                    for p in files
                    if p.name != "tiles.json"
                ]
                commit_files(ctx, moves, announce=False)
                commit_files(ctx, [(f"surfaces/{sid}/tiles.json", f"{SURFACES_DIR}/{sid}/tiles.json")])
                mark.unlink(missing_ok=True)
                done.append(sid)
            return {"prepared": done}

        return commit


def _geodesy(params: dict[str, Any]):
    """The site transform tables (G1's ``geodesy.site.write_site_tables``), when that is built.

    Called with the project, its data CRS, the survey settings (the defaults when the site has
    none), the applied site calibration (``geodesy.site.applied_calibration``, the one every export
    uses, so a readout on a calibrated site matches its exports) and the extent of every prepared
    surface: this job's (staged or kept) and the project's others (E, N, from their ``tiles.json``),
    so preparing one more surface never shrinks the tables. Skipped quietly in a pack without G1.
    The tables are written again on every run: their header's ``fingerprint`` holds the CRS,
    settings and calibration they were made with, and the app re-runs this step after a person
    applies a calibration or changes the site settings.
    """

    def run(ctx: StepContext) -> dict[str, Any]:
        try:
            from ..geodesy.site import (  # type: ignore[import-not-found]
                applied_calibration,
                write_site_tables,
            )
        except ImportError:
            return {"written": False}
        manifest = _manifest(ctx.project)
        p = ctx.project / "survey" / "settings.json"
        try:
            settings = json.loads(p.read_text("utf-8")) if p.is_file() else None
        except (OSError, ValueError) as e:
            raise JobError(f"The survey settings could not be read: {e}") from e
        boxes = []
        ours = {spec["id"] for spec in params["surfaces"]}
        folders = [
            folder
            for spec in params["surfaces"]
            for folder in (ctx.staging / "surfaces" / spec["id"], ctx.project / SURFACES_DIR / spec["id"])
        ]
        kept = ctx.project / SURFACES_DIR
        if kept.is_dir():
            folders += [f for f in sorted(kept.iterdir()) if f.is_dir() and f.name not in ours]
        seen: set[str] = set()
        for folder in folders:
            if folder.name in seen or not (folder / "tiles.json").is_file():
                continue
            seen.add(folder.name)
            try:
                b = json.loads((folder / "tiles.json").read_text("utf-8")).get("bounds")
            except (OSError, ValueError):
                continue
            if isinstance(b, list) and len(b) == 6:
                boxes.append(b)
        if not boxes:
            return {"written": False}
        extent = (
            min(b[0] for b in boxes),
            min(b[1] for b in boxes),
            max(b[3] for b in boxes),
            max(b[4] for b in boxes),
        )
        settings = settings or {"schema": "aio.survey-settings/1", "verticalDatum": {"kind": "project"}}
        out = write_site_tables(
            ctx.project,
            data_crs=_crs_of(manifest),
            settings=settings,
            calibration=applied_calibration(ctx.project, settings),
            extent=extent,
        )
        return {"written": True, **(out if isinstance(out, dict) else {})}

    return run
