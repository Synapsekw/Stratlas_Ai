"""The measured data behind a viewing layer, for the change pipelines (M8 data-format agreement).

A DSM imported as a shaded relief (``kit-pyramid``) and a point cloud packed for the viewer
(``png-packed``) cannot be measured. Their heights and points live beside the project in
``sources/``, named by the layer id:

- ``sources/<id>.json``: an ``aio.grid/1`` height grid, a 16-bit PNG (``file``, in the same folder)
  read as H = offset + value * scale (metres, project CRS), north up, pixel is area, ``x0`` the
  left easting, ``y1`` the top northing, ``res`` the cell size, ``nodata`` the empty value;
- ``sources/<id>.las`` (or ``.laz``): the points in the project CRS.

Only the project's own ``sources/`` folder is searched, by layer id; a path in the JSON is never
followed outside it.
"""

from __future__ import annotations

import json
import math
import re
import warnings
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from ..captures import date_similarity
from ..runtime import JobError
from ..similarity import Similarity

SOURCES = "sources"
GRID_SCHEMA = "aio.grid/1"
#: A layer id usable as a file name.
SAFE_ID = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._-]*$")


def _name(layer: dict[str, Any]) -> str:
    return str(layer.get("name") or layer.get("id"))


def _source_dir(project: Path, layer: dict[str, Any]) -> tuple[Path, str] | None:
    lid = layer.get("id")
    if not isinstance(lid, str) or not SAFE_ID.match(lid):
        return None
    return project / SOURCES, lid


@dataclass(frozen=True)
class _Stored:
    """Where a turned grid's file lies before its line-up: the north-up grid it was read on."""

    x0: float
    y1: float
    width: int
    height: int
    sim: Similarity


@dataclass(frozen=True)
class GridSource:
    """A parsed ``aio.grid/1`` height grid.

    Always north up: ``x0``, ``y1``, ``width`` and ``height`` are where its heights are. A grid
    whose date has a turned line-up is resampled onto the north-up grid that holds its turned
    footprint (``stored`` says where the file itself lies).
    """

    json_path: Path
    image: Path
    x0: float
    y1: float
    res: float
    width: int
    height: int
    scale: float
    offset: float
    nodata: float | None
    epsg: int | None
    stored: _Stored | None = None

    @property
    def files(self) -> list[str]:
        return [str(self.json_path), str(self.image)]

    @property
    def bounds(self) -> tuple[float, float, float, float]:
        """left, bottom, right, top in the project CRS."""
        return (self.x0, self.y1 - self.height * self.res, self.x0 + self.width * self.res, self.y1)

    def transform(self):
        from rasterio.transform import from_origin

        return from_origin(self.x0, self.y1, self.res, self.res)

    def heights(self) -> np.ndarray:
        """Heights (float64, metres, project CRS), NaN where there is no data; row 0 is north."""
        import rasterio
        from rasterio.errors import NotGeoreferencedWarning

        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", NotGeoreferencedWarning)
                with rasterio.open(self.image) as ds:
                    width, height = (
                        (self.stored.width, self.stored.height) if self.stored else (self.width, self.height)
                    )
                    if (ds.width, ds.height) != (width, height):
                        raise JobError(
                            f"The height grid {self.image.name} is {ds.width} x {ds.height} pixels; "
                            f"its {self.json_path.name} says {width} x {height}."
                        )
                    if ds.dtypes[0] not in ("uint8", "uint16", "int16", "uint32", "int32"):
                        raise JobError(f"The height grid {self.image.name} is not a grey PNG of heights.")
                    raw = ds.read(1)
        except rasterio.RasterioIOError as e:
            raise JobError(f"The height grid {self.image.name} could not be read: {e}") from e
        h = self.offset + raw.astype(np.float64) * self.scale
        if self.nodata is not None:
            h[raw == self.nodata] = np.nan
        return h if self.stored is None else self._turned(h)

    def _turned(self, h: np.ndarray) -> np.ndarray:
        """``h`` (on the stored grid) resampled onto this north-up grid through the line-up."""
        from rasterio.crs import CRS
        from rasterio.enums import Resampling
        from rasterio.transform import from_origin
        from rasterio.warp import reproject

        st = self.stored
        assert st is not None
        empty = -3.0e38
        src = np.where(np.isfinite(h), h, empty)
        out = np.full((self.height, self.width), empty, np.float64)
        # the same CRS on both sides: only the line-up's affine moves the cells
        crs = CRS.from_epsg(self.epsg or 3857)
        reproject(
            src,
            out,
            src_transform=st.sim.crs_affine() @ from_origin(st.x0, st.y1, self.res, self.res),
            src_crs=crs,
            src_nodata=empty,
            dst_transform=self.transform(),
            dst_crs=crs,
            dst_nodata=empty,
            resampling=Resampling.bilinear,
        )
        out[out <= empty * 0.5] = np.nan
        return out


def _number(d: dict[str, Any], key: str) -> float | None:
    v = d.get(key)
    if isinstance(v, bool) or not isinstance(v, int | float) or not np.isfinite(v):
        return None
    return float(v)


def height_offset_m(layer: dict[str, Any]) -> float:
    """The layer's ``heightOffsetM`` (metres added to a cloud's Z); a bool, a non-number or a non-finite value is 0."""
    return _number(layer, "heightOffsetM") or 0.0


def grid_source(project: Path, layer: dict[str, Any], manifest: dict[str, Any] | None = None) -> GridSource:
    """The ``aio.grid/1`` height grid of a DSM layer that is not a GeoTIFF (validated).

    With the ``manifest``, the grid is where its date is lined up (callers add none): the date's
    shift is added to ``x0`` and ``y1``; with a turn or scale too, the heights are resampled onto
    the north-up grid that holds the turned footprint, at the same cell size.
    """
    name = _name(layer)
    where = _source_dir(project, layer)
    rel = f"{SOURCES}/{layer.get('id')}.json"
    missing = f'The DSM "{name}" has no height grid ({rel}); import a GeoTIFF DSM.'
    if where is None:
        raise JobError(missing)
    folder, lid = where
    path = folder / f"{lid}.json"
    if not path.is_file():
        raise JobError(missing)
    bad = f'The height grid of the DSM "{name}" ({rel})'
    try:
        g = json.loads(path.read_text("utf-8-sig"))
    except (OSError, ValueError) as e:
        raise JobError(f"{bad} could not be read: {e}") from e
    if not isinstance(g, dict) or g.get("schema") != GRID_SCHEMA:
        raise JobError(f"{bad} is not an {GRID_SCHEMA} file.")
    if g.get("kind") != "dsm":
        raise JobError(f"{bad} holds {g.get('kind')!r}, not DSM heights.")
    keys = ("x0", "y1", "res", "width", "height", "scale", "offset")
    nums = {k: _number(g, k) for k in keys}
    absent = [k for k, v in nums.items() if v is None]
    if absent:
        raise JobError(f"{bad} has no number for {', '.join(absent)}.")
    x0, y1, res, width, height, scale, offset = (float(nums[k] or 0.0) for k in keys)
    if res <= 0 or scale == 0 or width < 1 or height < 1 or width % 1 or height % 1:
        raise JobError(f"{bad} has a cell size, scale or size that cannot be right.")
    nodata = g.get("nodata", 0)
    if nodata is not None and _number(g, "nodata") is None:
        raise JobError(f"{bad} has a nodata value that is not a number.")
    file = g.get("file", f"{lid}.png")
    # the image sits beside the JSON: a bare file name, never a path
    if not isinstance(file, str) or not file or Path(file).name != file or file in (".", ".."):
        raise JobError(f"{bad} names its image {file!r}; it must be a file name in {SOURCES}/.")
    image = folder / file
    if not image.is_file():
        raise JobError(f'The image of the height grid of the DSM "{name}" ({SOURCES}/{file}) is missing.')
    epsg = g.get("epsg")
    if epsg is not None and (isinstance(epsg, bool) or not isinstance(epsg, int)):
        raise JobError(f"{bad} has an EPSG code that is not a number.")
    want = ((manifest or {}).get("crs") or {}).get("epsg")
    if isinstance(epsg, int) and isinstance(want, int) and epsg != want:
        raise JobError(f"{bad} is in EPSG:{epsg}; the project is in EPSG:{want}.")
    sim = date_similarity(manifest, str(layer.get("id"))) if manifest else Similarity(0.0, 0.0)
    common = {
        "json_path": path,
        "image": image,
        "res": res,
        "scale": scale,
        "offset": offset,
        "nodata": None if nodata is None else float(nodata),
        "epsg": epsg if isinstance(epsg, int) else None,
    }
    if not sim.has_turn():
        return GridSource(
            x0=x0 + sim.east_m, y1=y1 + sim.north_m, width=int(width), height=int(height), **common
        )
    # turned: the north-up grid, on the file's own cell lattice moved by the shift, that holds the
    # turned corners
    w, h = int(width), int(height)
    es, ns = sim.apply_en(
        np.array([x0, x0 + w * res, x0, x0 + w * res]), np.array([y1, y1, y1 - h * res, y1 - h * res])
    )
    ox, oy = x0 + sim.east_m, y1 + sim.north_m
    c0 = math.floor((float(es.min()) - ox) / res + 1e-9)
    c1 = math.ceil((float(es.max()) - ox) / res - 1e-9)
    r0 = math.floor((oy - float(ns.max())) / res + 1e-9)
    r1 = math.ceil((oy - float(ns.min())) / res - 1e-9)
    return GridSource(
        x0=ox + c0 * res,
        y1=oy - r0 * res,
        width=c1 - c0,
        height=r1 - r0,
        stored=_Stored(x0, y1, w, h, sim),
        **common,
    )


def cloud_source(project: Path, layer: dict[str, Any], why: str = "") -> Path:
    """``sources/<id>.las`` (or ``.laz``) of a point cloud layer packed for viewing.

    The points are in the file's own place: the reader adds the line-up of the layer's date
    (``captures.date_similarity``), as it adds its ``heightOffsetM``.
    """
    name = _name(layer)
    where = _source_dir(project, layer)
    if where is not None:
        folder, lid = where
        for ext in (".las", ".laz"):
            p = folder / f"{lid}{ext}"
            if p.is_file():
                return p
    rel = f"{SOURCES}/{layer.get('id')}.las"
    raise JobError(
        why or f'The point cloud "{name}" has no measured points ({rel}); import a LAS or COPC cloud.'
    )
