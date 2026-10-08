"""Synthetic surveying data for M11 (stream G13): analytic surfaces with exact truths, survey sets
on two or three dates, designs (LandXML 1.2, DXF, 12da, CSV), coordinates and calibrations, and
hostile files. No client data: every file is procedural, seeded and placed at fictional sites.

Everything a stream's tests need imports from here (``from survey_synth import cone, ...``):

Analytic surfaces (``Surface``: ``heights(E, N)`` in the project CRS, metres, with ``truth``):
    ``cone``, ``frustum``, ``paraboloid``, ``prism``, ``wedge``, ``mound``, ``benched_pit``,
    ``bowl``, ``catchment``, ``landfill_cell`` (a ``LandfillCell`` with its lift surfaces) and
    ``HaulRoad`` (25 m running surface, 8 % grade, 2 % cross fall, superelevated curve, 1.5 m
    berms, a planted steep stretch and a planted low berm). ``Surface.grid(res)`` samples one at
    cell centres (``Grid``); cell sizes of 2 to 50 cm are the intended range.
Grids: ``Grid``, ``sample_grid``, ``noisy`` (seeded, bounded uniform noise), ``noise_variants``
    (below and above a deadband), ``with_holes`` (nodata discs with their exact area),
    ``write_aio_grid`` (``aio.grid/1``: 16-bit PNG and JSON, as ``change/sources.py`` reads it),
    ``write_cog`` (float32 Cloud Optimised GeoTIFF), ``grid_volume`` (midpoint sum), ``profile``.
Survey sets (``SurveySite``): ``analytic_site``, ``earthworks_site`` (cut and fill between dates, a
    planted 3 cm vertical shift, a parked excavator, checkpoints with one planted 15 cm off, the
    pad and road designs, a calibration), ``quarry_site`` (three monthly surveys, stockpiles
    with materials, a benched pit, a haul road), ``landfill_site`` (cell design, three lifts,
    weighbridge tonnage). ``write_site`` writes a set folder that ``tools/demo/survey-demo.mjs``
    turns into a project.
Designs: ``AlignmentGeom`` (line, clothoid, arc, station equation), ``Tin``, ``pad_tin``,
    ``write_tin`` (``aio.tin/1``), ``write_alignment_json`` (``aio.alignment/1``),
    ``write_landxml`` (hand-written from the LandXML 1.2 schema, not from any vendor sample),
    ``write_dxf`` (ASCII R12: 3DFACE, 3D POLYLINE, POINT, TEXT; ezdxf is not in the pack's
    environment, so this is our own minimal writer), ``write_12da`` (12d ASCII: ``model`` and
    ``string super`` with ``data_3d``), ``write_points_csv``.
Coordinates: ``FIXTURE_CRS`` (UTM 39N at the fictional desert site, NAD83(2011) Nevada Central in
    US survey feet, British National Grid, a fictional local site grid), ``site_calibration``
    (a calibration with exact parameters and exact least-squares residuals), ``write_jobxml``,
    ``write_dc``, ``write_geoid_grid`` (a fictional geoid with an analytic undulation).
Hostile files: ``landxml_hostile``, ``dxf_hostile``, ``twelve_da_hostile``, ``csv_hostile``,
    ``jobxml_hostile``; each returns ``{name: (path, claim)}``.

Conventions: (E, N, Z) in the project CRS and metres everywhere except where a format orders its
axes otherwise (LandXML and JobXML are N, E; calibration pairs are N, E, Z as controllers list
them). ``dz = To - From``; fill where dz > 0. Generation is deterministic (seeded, no clock).

Command line (used by tools/demo/survey-demo.mjs)::

    python tests/survey_synth.py demo --site earthworks|quarry|landfill|analytic --out DIR [--quick]
    python tests/survey_synth.py fixtures --out DIR
"""

from __future__ import annotations

import argparse
import hashlib
import itertools
import json
import math
import struct
import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

# ------------------------------------------------------------------ sites and CRSs

#: The fictional desert site (UTM 39N, inside the photo demo's fictional site, Rub' al Khali).
SITE_EPSG = 32639
SITE_E0, SITE_N0, SITE_H0 = 551200.0, 2331400.0, 120.0
#: The US survey foot, exactly.
US_FT = 1200 / 3937
#: Fixed time stamps (no clock in any generated file).
STAMP = "2026-03-02T10:00:00Z"

HeightFn = Callable[[np.ndarray, np.ndarray], np.ndarray]


@dataclass(frozen=True)
class FixtureCrs:
    """A fixture CRS and the fictional site in it.

    ``origin`` is the site centre in the CRS's own unit (``unit``); ``lonlat`` is that centre in
    WGS 84 degrees. ``proj4`` is set for the fictional local grid, which has no EPSG code.
    """

    id: str
    name: str
    epsg: int | None
    proj4: str | None
    unit: str
    vertical_epsg: int | None
    geoid: str | None
    lonlat: tuple[float, float]
    origin: tuple[float, float]
    note: str


#: The fictional site grid: a transverse Mercator at the desert site (scale 1, false origin
#: 10 000 E, 50 000 N), the base projection of the synthetic calibration.
SITE_GRID_PROJ4 = (
    "+proj=tmerc +lat_0=21.0829 +lon_0=51.4929 +k=1 +x_0=10000 +y_0=50000 +ellps=WGS84 +units=m +no_defs"
)

FIXTURE_CRS: dict[str, FixtureCrs] = {
    "utm39n": FixtureCrs(
        "utm39n",
        "WGS 84 / UTM zone 39N",
        32639,
        None,
        "m",
        3855,
        "EGM2008",
        (51.49291299907311, 21.082884844290966),
        (SITE_E0, SITE_N0),
        "The fictional desert site of every demo (Rub' al Khali, open desert).",
    ),
    "nevada-central-ftus": FixtureCrs(
        "nevada-central-ftus",
        "NAD83(2011) / Nevada Central (ftUS)",
        6519,
        None,
        "us-ft",
        6360,
        "GEOID18",
        (-116.55, 38.95),
        (1673594.136, 21214048.017),
        "A fictional site in empty central Nevada desert; US survey feet, NAVD88 (ftUS) heights.",
    ),
    "bng": FixtureCrs(
        "bng",
        "OSGB36 / British National Grid",
        27700,
        None,
        "m",
        5701,
        "OSGM15",
        (-4.70, 56.62),
        (234430.645, 750832.050),
        "A fictional site on open moorland; OSTN15 horizontal and OSGM15 vertical grids.",
    ),
    "site-grid": FixtureCrs(
        "site-grid",
        "Fictional site grid (transverse Mercator at the desert site)",
        None,
        SITE_GRID_PROJ4,
        "m",
        None,
        None,
        (51.4929, 21.0829),
        (10000.0, 50000.0),
        "A local grid with no EPSG code: the base projection of the synthetic calibration.",
    ),
}


def crs_of(fixture: FixtureCrs):
    """The fixture CRS as a rasterio CRS (PROJ inside rasterio; the pack has no pyproj)."""
    from rasterio.crs import CRS

    return CRS.from_epsg(fixture.epsg) if fixture.epsg else CRS.from_proj4(fixture.proj4 or "")


def to_lonlat(epsg_or_crs: Any, e: Sequence[float], n: Sequence[float]) -> tuple[list[float], list[float]]:
    """Projected coordinates to WGS 84 longitude and latitude (PROJ, through rasterio)."""
    from rasterio.warp import transform

    src = f"EPSG:{epsg_or_crs}" if isinstance(epsg_or_crs, int) else epsg_or_crs
    lon, lat = transform(src, "EPSG:4326", list(e), list(n))
    return list(lon), list(lat)


def from_lonlat(
    epsg_or_crs: Any, lon: Sequence[float], lat: Sequence[float]
) -> tuple[list[float], list[float]]:
    """WGS 84 longitude and latitude to projected coordinates (PROJ, through rasterio)."""
    from rasterio.warp import transform

    dst = f"EPSG:{epsg_or_crs}" if isinstance(epsg_or_crs, int) else epsg_or_crs
    e, n = transform("EPSG:4326", dst, list(lon), list(lat))
    return list(e), list(n)


# ------------------------------------------------------------------ grids


@dataclass
class Grid:
    """A north-up height grid: ``z[row, col]`` (row 0 north), NaN where there is no data.

    ``x0`` is the left easting and ``y1`` the top northing of the grid's edges (pixel is area),
    ``res`` the cell size in metres.
    """

    z: np.ndarray
    x0: float
    y1: float
    res: float
    epsg: int = SITE_EPSG

    @property
    def height(self) -> int:
        return int(self.z.shape[0])

    @property
    def width(self) -> int:
        return int(self.z.shape[1])

    @property
    def bounds(self) -> tuple[float, float, float, float]:
        """left, bottom, right, top."""
        return (self.x0, self.y1 - self.height * self.res, self.x0 + self.width * self.res, self.y1)

    def centres(self) -> tuple[np.ndarray, np.ndarray]:
        """Eastings and northings of the cell centres, each shaped like ``z``."""
        e = self.x0 + (np.arange(self.width) + 0.5) * self.res
        n = self.y1 - (np.arange(self.height) + 0.5) * self.res
        return np.meshgrid(e, n)

    def with_z(self, z: np.ndarray) -> Grid:
        return Grid(z, self.x0, self.y1, self.res, self.epsg)


def sample_grid(
    fn: HeightFn, centre: tuple[float, float], half: float, res: float, epsg: int = SITE_EPSG
) -> Grid:
    """``fn`` sampled at the cell centres of a square grid centred on ``centre`` that covers
    ``centre +- half`` (its edges exactly there when ``res`` divides ``2 half``, else the square
    grows to the next whole cell, still centred)."""
    n = max(1, math.ceil(2 * half / res - 1e-9))
    h = n * res / 2
    g = Grid(np.empty((n, n)), centre[0] - h, centre[1] + h, res, epsg)
    e, nn = g.centres()
    g.z = np.asarray(fn(e, nn), dtype=np.float64)
    return g


def grid_volume(top: Grid, base: Grid | float, rect: tuple[float, float, float, float] | None = None) -> dict:
    """Midpoint sums of ``dz = top - base`` (fill, cut, net) over the cells inside ``rect``.

    ``rect`` is (min E, min N, max E, max N); cells are coverage-weighted against it (exact for
    an axis-aligned rectangle). NaN cells are counted in ``uncovered``. A reference used by the
    tests to check the truths, not the engine.
    """
    b = base.z if isinstance(base, Grid) else np.full_like(top.z, float(base))
    dz = top.z - b
    w = np.ones_like(dz)
    if rect is not None:
        e, n = top.centres()
        h = top.res / 2
        we = np.clip(np.minimum(e + h, rect[2]) - np.maximum(e - h, rect[0]), 0, None) / top.res
        wn = np.clip(np.minimum(n + h, rect[3]) - np.maximum(n - h, rect[1]), 0, None) / top.res
        w = we * wn
    a = top.res**2
    ok = np.isfinite(dz)
    d = np.where(ok, dz, 0.0)
    fill = float(np.sum(w * np.clip(d, 0, None)) * a)
    cut = float(np.sum(w * np.clip(-d, 0, None)) * a)
    return {"fill": fill, "cut": cut, "net": fill - cut, "uncovered": float(np.sum(w * ~ok) * a)}


def noisy(grid: Grid, amplitude: float, seed: int) -> Grid:
    """``grid`` plus seeded uniform noise in [-amplitude, +amplitude] (bounded, so a deadband
    larger than ``amplitude`` removes all of it exactly)."""
    rng = np.random.default_rng(seed)
    return grid.with_z(grid.z + rng.uniform(-amplitude, amplitude, grid.z.shape))


def noise_variants(grid: Grid, deadband: float = 0.05, seed: int = 11) -> dict[str, tuple[Grid, float]]:
    """Two noisy copies: ``below`` (|noise| <= 0.4 deadband) and ``above`` (|noise| up to 3 x the
    deadband). Returns {name: (grid, amplitude)}."""
    return {
        "below": (noisy(grid, 0.4 * deadband, seed), 0.4 * deadband),
        "above": (noisy(grid, 3.0 * deadband, seed + 1), 3.0 * deadband),
    }


def with_holes(grid: Grid, holes: Sequence[tuple[float, float, float]]) -> tuple[Grid, float]:
    """``grid`` with nodata (NaN) discs (E, N, radius); returns it and the exact nodata area
    (cells whose centre is inside a disc, times the cell area)."""
    e, n = grid.centres()
    mask = np.zeros(grid.z.shape, bool)
    for he, hn, r in holes:
        mask |= (e - he) ** 2 + (n - hn) ** 2 <= r * r
    z = grid.z.copy()
    z[mask] = np.nan
    return grid.with_z(z), float(mask.sum() * grid.res**2)


def profile(fn: HeightFn, line: Sequence[tuple[float, float]], step: float) -> dict[str, list[float]]:
    """Exact heights of ``fn`` along a polyline every ``step`` metres (and at every vertex)."""
    ch: list[float] = []
    pts: list[tuple[float, float]] = []
    run = 0.0
    for (ax, ay), (bx, by) in itertools.pairwise(line):
        seg = math.hypot(bx - ax, by - ay)
        k = max(1, math.ceil(seg / step - 1e-9))
        for i in range(k):
            t = i * step / seg if i * step < seg else 1.0
            pts.append((ax + (bx - ax) * t, ay + (by - ay) * t))
            ch.append(run + min(i * step, seg))
        run += seg
    pts.append(tuple(line[-1]))
    ch.append(run)
    e = np.array([p[0] for p in pts])
    n = np.array([p[1] for p in pts])
    return {"chainage": [round(c, 9) for c in ch], "z": [float(v) for v in fn(e, n)]}


def write_aio_grid(
    grid: Grid,
    folder: Path,
    layer_id: str,
    *,
    kind: str = "dsm",
    capture: str | None = None,
    scale: float | None = None,
) -> tuple[Path, Path, dict]:
    """``<folder>/<layer_id>.json`` and ``.png``: an ``aio.grid/1`` 16-bit height grid.

    Heights are stored as H = offset + value * scale (value 0 is nodata), so they are quantised
    to ``scale`` (1 mm unless the range needs more); the JSON's ``scale`` says so.
    """
    from PIL import Image

    z = grid.z
    ok = np.isfinite(z)
    lo = float(np.floor(np.nanmin(z) - 1)) if ok.any() else 0.0
    hi = float(np.nanmax(z)) if ok.any() else 1.0
    if scale is None:
        scale = max(0.001, math.ceil((hi - lo) / 65000 * 1000) / 1000)
    raw = np.zeros(z.shape, np.uint16)
    raw[ok] = np.clip(np.round((z[ok] - lo) / scale), 1, 65535).astype(np.uint16)
    folder.mkdir(parents=True, exist_ok=True)
    png = folder / f"{layer_id}.png"
    Image.fromarray(raw).save(png)
    doc = {
        "schema": "aio.grid/1",
        "kind": kind,
        "layer": layer_id,
        **({"capture": capture} if capture else {}),
        "epsg": grid.epsg,
        "x0": grid.x0,
        "y1": grid.y1,
        "res": grid.res,
        "width": grid.width,
        "height": grid.height,
        "file": png.name,
        "scale": scale,
        "offset": lo,
        "nodata": 0,
        "note": "Synthetic heights (survey_synth.py). H = offset + value * scale, metres, project CRS, north up, pixel is area.",
    }
    js = folder / f"{layer_id}.json"
    js.write_text(json.dumps(doc, indent=1) + "\n", "utf-8", newline="\n")
    return js, png, doc


def read_aio_grid(json_path: Path) -> Grid:
    """Read back an ``aio.grid/1`` grid written by ``write_aio_grid`` (NaN for nodata)."""
    from PIL import Image

    doc = json.loads(json_path.read_text("utf-8"))
    raw = np.asarray(Image.open(json_path.parent / doc["file"]), dtype=np.float64)
    z = doc["offset"] + raw * doc["scale"]
    z[raw == doc["nodata"]] = np.nan
    return Grid(z, doc["x0"], doc["y1"], doc["res"], doc.get("epsg", SITE_EPSG))


def write_cog(grid: Grid, path: Path, nodata: float = -9999.0) -> Path:
    """A float32 Cloud Optimised GeoTIFF of the grid (DEFLATE, internal overviews)."""
    import rasterio
    from rasterio.shutil import copy as rio_copy
    from rasterio.transform import from_origin

    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.stem}.tmp.tif")
    z = np.where(np.isfinite(grid.z), grid.z, nodata).astype(np.float32)
    with rasterio.open(
        tmp,
        "w",
        driver="GTiff",
        width=grid.width,
        height=grid.height,
        count=1,
        dtype="float32",
        crs=f"EPSG:{grid.epsg}",
        transform=from_origin(grid.x0, grid.y1, grid.res, grid.res),
        nodata=nodata,
    ) as d:
        d.write(z, 1)
    rio_copy(str(tmp), str(path), driver="COG", COMPRESS="DEFLATE", BLOCKSIZE=256)
    tmp.unlink()
    return path


# ------------------------------------------------------------------ analytic surfaces


@dataclass(frozen=True)
class Surface:
    """An analytic height field around ``centre`` (E, N): absolute heights in the project CRS.

    ``base`` is the stated base level (metres) its ``truth`` volumes are measured against,
    ``half`` the half-size of a square that holds it, ``truth`` its exact values.
    """

    name: str
    kind: str
    centre: tuple[float, float]
    base: float
    half: float
    local: HeightFn = field(repr=False)
    truth: dict[str, Any]

    def heights(self, e: np.ndarray, n: np.ndarray) -> np.ndarray:
        return self.base + self.local(np.asarray(e) - self.centre[0], np.asarray(n) - self.centre[1])

    def grid(self, res: float, half: float | None = None) -> Grid:
        """Sampled at cell centres over ``centre +- half`` (default ``half`` rounded up to whole
        metres, so any cell that divides 1 m fits)."""
        return sample_grid(self.heights, self.centre, half if half is not None else math.ceil(self.half), res)


def _cross2(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """z of the cross product of (n, 2) vectors."""
    return a[:, 0] * b[:, 1] - a[:, 1] * b[:, 0]


def _positive_part(d: np.ndarray, area: np.ndarray) -> np.ndarray:
    """Integral of max(f, 0) over each triangle for f linear with vertex values ``d`` (m, 3)."""
    out = np.zeros(len(d))
    pos = (d > 0).sum(axis=1)
    out[pos == 3] = (area * d.mean(axis=1))[pos == 3]
    for k, sign in ((1, 1.0), (2, -1.0)):
        m = pos == k
        if not m.any():
            continue
        dd = d[m] * sign
        # the odd vertex: the one positive (k = 1) or the one non-positive (k = 2, after the flip)
        odd = np.argmax(dd, axis=1)
        p = dd[np.arange(len(dd)), odd]
        rest = np.sort(np.where(np.eye(3, dtype=bool)[odd], np.inf, dd), axis=1)[:, :2]
        part = area[m] * p**3 / (3 * (p - rest[:, 0]) * (p - rest[:, 1]))
        out[m] = part if k == 1 else area[m] * d[m].mean(axis=1) + part
    return out


def _r(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    return np.hypot(x, y)


def _cheb(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    return np.maximum(np.abs(x), np.abs(y))


def _circle_truth(radius: float, volume: float, height: float, extra: dict | None = None) -> dict:
    return {
        "volumeM3": volume,
        "heightM": height,
        "footprintRadiusM": radius,
        "footprintAreaM2": math.pi * radius * radius,
        "widthM": 2 * radius,
        **(extra or {}),
    }


def cone(
    radius: float = 20.0,
    height: float = 8.0,
    centre: tuple[float, float] = (SITE_E0, SITE_N0),
    base: float = SITE_H0,
) -> Surface:
    """A right circular cone on a flat base: V = pi R^2 H / 3, lateral area pi R sqrt(R^2 + H^2)."""
    R, H = radius, height

    def local(x, y):
        return np.clip(H * (1 - _r(x, y) / R), 0, None)

    slant = math.hypot(R, H)
    truth = _circle_truth(
        R,
        math.pi * R * R * H / 3,
        H,
        {
            "lateralAreaM2": math.pi * R * slant,
            "slopeDeg": math.degrees(math.atan2(H, R)),
            "slopePct": 100 * H / R,
            # contour at height L above the base: a circle of radius R (1 - L / H)
            "contours": [{"levelM": base + L, "radiusM": R * (1 - L / H)} for L in range(1, int(H))],
            "apex": [centre[0], centre[1], base + H],
        },
    )
    s = Surface("cone", "cone", centre, base, R * 1.25, local, truth)
    s.truth["profileWE"] = profile(
        s.heights, [(centre[0] - R * 1.2, centre[1]), (centre[0] + R * 1.2, centre[1])], 1.0
    )
    return s


def frustum(
    r_bottom: float = 20.0,
    r_top: float = 8.0,
    height: float = 6.0,
    centre: tuple[float, float] = (SITE_E0, SITE_N0),
    base: float = SITE_H0,
) -> Surface:
    """A truncated cone: V = pi H (R1^2 + R1 R2 + R2^2) / 3, flat top of radius ``r_top``."""
    R1, R2, H = r_bottom, r_top, height

    def local(x, y):
        return np.clip(H * (R1 - _r(x, y)) / (R1 - R2), 0, H)

    truth = _circle_truth(
        R1,
        math.pi * H * (R1 * R1 + R1 * R2 + R2 * R2) / 3,
        H,
        {"topAreaM2": math.pi * R2 * R2, "slopeDeg": math.degrees(math.atan2(H, R1 - R2))},
    )
    return Surface("frustum", "frustum", centre, base, R1 * 1.25, local, truth)


def paraboloid(
    radius: float = 20.0,
    height: float = 8.0,
    centre: tuple[float, float] = (SITE_E0, SITE_N0),
    base: float = SITE_H0,
) -> Surface:
    """z = H (1 - r^2 / R^2): V = pi R^2 H / 2."""
    R, H = radius, height

    def local(x, y):
        return np.clip(H * (1 - (x * x + y * y) / (R * R)), 0, None)

    return Surface(
        "paraboloid",
        "paraboloid",
        centre,
        base,
        R * 1.25,
        local,
        _circle_truth(R, math.pi * R * R * H / 2, H),
    )


def prism(
    size: tuple[float, float] = (32.0, 20.0),
    height: float = 5.0,
    centre: tuple[float, float] = (SITE_E0, SITE_N0),
    base: float = SITE_H0,
) -> Surface:
    """A rectangular block (axis aligned, vertical walls): V = a b h."""
    a, b = size[0] / 2, size[1] / 2

    def local(x, y):
        return np.where((np.abs(x) <= a) & (np.abs(y) <= b), height, 0.0)

    truth = {
        "volumeM3": size[0] * size[1] * height,
        "heightM": height,
        "footprintAreaM2": size[0] * size[1],
        "widthM": min(size),
        "rect": [centre[0] - a, centre[1] - b, centre[0] + a, centre[1] + b],
    }
    return Surface("prism", "prism", centre, base, max(a, b) + 4, local, truth)


def wedge(
    length: float = 40.0,
    width: float = 20.0,
    grade: float = 0.25,
    centre: tuple[float, float] = (SITE_E0, SITE_N0),
    base: float = SITE_H0,
) -> Surface:
    """A sloped plane wedge rising east from 0 (west edge) to ``grade * length`` (east edge, a
    vertical end face): V = W L^2 g / 2; the sloped face's area is W L sqrt(1 + g^2)."""
    L2, W2 = length / 2, width / 2

    def local(x, y):
        inside = (np.abs(x) <= L2) & (np.abs(y) <= W2)
        return np.where(inside, grade * (x + L2), 0.0)

    s = Surface(
        "wedge",
        "wedge",
        centre,
        base,
        max(L2, W2) * 1.3,
        local,
        {
            "volumeM3": width * length * length * grade / 2,
            "footprintAreaM2": width * length,
            "slopeAreaM2": width * length * math.sqrt(1 + grade * grade),
            "gradePct": 100 * grade,
            "slopeDeg": math.degrees(math.atan(grade)),
            "widthM": min(width, length),
            "rect": [centre[0] - L2, centre[1] - W2, centre[0] + L2, centre[1] + W2],
        },
    )
    s.truth["profileAlong"] = profile(
        s.heights, [(centre[0] - L2 + 1, centre[1]), (centre[0] + L2 - 1, centre[1])], 1.0
    )
    return s


def mound(
    radius: float = 15.0,
    height: float = 6.0,
    centre: tuple[float, float] = (SITE_E0, SITE_N0),
    base: float = SITE_H0,
) -> Surface:
    """A hemisphere-like mound: a spherical cap of footprint radius a and height h,
    V = pi h (3 a^2 + h^2) / 6."""
    a, h = radius, height
    rs = (a * a + h * h) / (2 * h)

    def local(x, y):
        r2 = np.minimum(x * x + y * y, rs * rs)
        return np.clip(np.sqrt(rs * rs - r2) - (rs - h), 0, None)

    truth = _circle_truth(a, math.pi * h * (3 * a * a + h * h) / 6, h, {"sphereRadiusM": rs})
    return Surface("mound", "mound", centre, base, a * 1.25, local, truth)


def _square_layers_volume(layers: Sequence[tuple[float, float, float]]) -> float:
    """Volume of stacked layers (thickness, half-size at the bottom, half-size at the top) of a
    square pit whose half-size is linear in depth (prismoidal, exact)."""
    v = 0.0
    for t, c0, c1 in layers:
        a0, a1, am = (2 * c0) ** 2, (2 * c1) ** 2, (c0 + c1) ** 2
        v += t / 6 * (a0 + 4 * am + a1)
    return v


def benched_pit(
    floor_half: float = 15.0,
    bench_height: float = 10.0,
    bench_width: float = 8.0,
    benches: int = 3,
    face_deg: float = 70.0,
    centre: tuple[float, float] = (SITE_E0, SITE_N0),
    base: float = SITE_H0,
    sump: tuple[float, float] | None = None,
) -> Surface:
    """A square pit (rim at ``base``) of ``benches`` faces of ``bench_height`` at ``face_deg``,
    with flat benches of ``bench_width`` between them; contours are squares (the Chebyshev
    distance from the centre). ``sump`` (half-size, depth) cuts a square sump in the floor.

    Truth: depth, bench levels, the volume below the rim (prismoidal per layer, exact), rim half.
    """
    t = bench_height / math.tan(math.radians(face_deg))
    depth = benches * bench_height
    # breakpoints from the floor outwards: (cheb radius, depth below the rim)
    pts: list[tuple[float, float]] = [(0.0, depth), (floor_half, depth)]
    c = floor_half
    for k in range(benches):
        c += t
        d = depth - (k + 1) * bench_height
        pts.append((c, d))
        if k < benches - 1:
            c += bench_width
            pts.append((c, d))
    rim = c
    xs = np.array([p[0] for p in pts])
    ds = np.array([p[1] for p in pts])

    def local(x, y):
        ch = _cheb(x, y)
        d = np.interp(ch, xs, ds, right=0.0)
        if sump is not None:
            d = d + np.where(ch <= sump[0], sump[1], 0.0)
        return -d

    layers = []
    c0 = floor_half
    for _ in range(benches):
        layers.append((bench_height, c0, c0 + t))
        c0 += t + bench_width
    vol = _square_layers_volume(layers)
    if sump is not None:
        vol += (2 * sump[0]) ** 2 * sump[1]
    truth = {
        "volumeM3": vol,
        "depthM": depth + (sump[1] if sump else 0.0),
        "rimLevelM": base,
        "rimHalfM": rim,
        "floorHalfM": floor_half,
        "floorLevelM": base - depth,
        "benchLevelsM": [base - depth + (k + 1) * bench_height for k in range(benches - 1)],
        "benchWidthM": bench_width,
        "faceRunM": t,
        "faceDeg": face_deg,
        "sumpM3": (2 * sump[0]) ** 2 * sump[1] if sump else 0.0,
        "rect": [centre[0] - rim, centre[1] - rim, centre[0] + rim, centre[1] + rim],
        "note": "Volume below the rim level; benches are square rings (Chebyshev distance).",
    }
    s = Surface("benched-pit", "benched-pit", centre, base, rim * 1.15, local, truth)
    s.truth["profileWE"] = profile(
        s.heights, [(centre[0] - rim - 5, centre[1]), (centre[0] + rim + 5, centre[1])], 1.0
    )
    return s


def bowl(
    radius: float = 25.0,
    depth: float = 4.0,
    centre: tuple[float, float] = (SITE_E0, SITE_N0),
    base: float = SITE_H0,
    levels: Sequence[float] = (-3.0, -2.0, -1.0),
) -> Surface:
    """A paraboloid depression z = -D (1 - r^2 / R^2): volume below the rim pi R^2 D / 2; flooded to
    level L (relative to the rim) it holds pi R^2 (L + D)^2 / (2 D) over a disc of radius^2
    R^2 (L + D) / D."""
    R, D = radius, depth

    def local(x, y):
        return -np.clip(D * (1 - (x * x + y * y) / (R * R)), 0, None)

    flood = [
        {
            "levelM": base + L,
            "volumeM3": math.pi * R * R * (L + D) ** 2 / (2 * D),
            "areaM2": math.pi * R * R * (L + D) / D,
        }
        for L in levels
    ]
    truth = _circle_truth(R, math.pi * R * R * D / 2, D, {"lowestM": base - D, "flood": flood})
    return Surface("bowl", "bowl", centre, base, R * 1.2, local, truth)


def catchment(
    half: float = 50.0,
    side_slope: float = 0.20,
    channel_slope: float = 0.02,
    centre: tuple[float, float] = (SITE_E0, SITE_N0),
    base: float = SITE_H0,
) -> Surface:
    """A V-shaped valley: z = s_side |x| + s_ch y over the square ``centre +- half``, its channel
    along x = 0 falling south. The pour point is the channel's south end (centre E, N - half).

    Truth (steepest descent): a point (x, y) reaches the channel at y - |x| k (k = s_ch / s_side),
    so the area draining through the pour point is the whole square less the two triangles that
    leave through the south edge first: 4 h^2 - k h^2.
    """
    k = channel_slope / side_slope

    def local(x, y):
        return side_slope * np.abs(x) + channel_slope * (y + half)

    truth = {
        "pourPoint": [centre[0], centre[1] - half],
        "pourPointZ": base,
        "catchmentAreaM2": 4 * half * half - k * half * half,
        "domainAreaM2": 4 * half * half,
        "channelSlopePct": 100 * channel_slope,
        "sideSlopePct": 100 * side_slope,
        "rect": [centre[0] - half, centre[1] - half, centre[0] + half, centre[1] + half],
        "note": "Grid it over exactly the square (half = this half); outside it the formula continues.",
    }
    return Surface("catchment", "catchment", centre, base, half, local, truth)


ANALYTIC: dict[str, Callable[..., Surface]] = {
    "cone": cone,
    "frustum": frustum,
    "paraboloid": paraboloid,
    "prism": prism,
    "wedge": wedge,
    "mound": mound,
    "benched-pit": benched_pit,
    "bowl": bowl,
    "catchment": catchment,
}


# ------------------------------------------------------------------ landfill cell


def _inset(x: np.ndarray, y: np.ndarray, a: float, b: float) -> np.ndarray:
    """Distance inside the rectangle |x| <= a, |y| <= b to its nearest edge (negative outside)."""
    return np.minimum(a - np.abs(x), b - np.abs(y))


def _rect_frustum_volume(a: float, b: float, run: float, d0: float, d1: float) -> float:
    """Volume between levels d0 < d1 (depths or heights from the rectangle 2a x 2b) of a solid
    whose half-sizes shrink by ``run`` per metre (prismoidal, exact)."""

    def area(d):
        return 4 * (a - run * d) * (b - run * d)

    return (d1 - d0) / 6 * (area(d0) + 4 * area((d0 + d1) / 2) + area(d1))


@dataclass(frozen=True)
class LandfillCell:
    """A landfill cell: an opening ``2a x 2b`` at ground level ``base`` with 1:``run`` side slopes
    to ``depth``, filled in lifts. ``lifts`` are the levels (relative to the ground) each lift
    reaches; levels above 0 build a cap with the same 1:``run`` outer slopes."""

    centre: tuple[float, float]
    base: float
    a: float = 60.0
    b: float = 40.0
    run: float = 3.0
    depth: float = 6.0
    lifts: tuple[float, ...] = (-3.0, 0.0, 3.0)
    final_cap: float = 6.0

    def cell_base(self, x: np.ndarray, y: np.ndarray) -> np.ndarray:
        ins = _inset(x, y, self.a, self.b)
        return -np.clip(ins / self.run, 0, self.depth)

    def after(self, level: float, x: np.ndarray, y: np.ndarray) -> np.ndarray:
        """Local heights once waste reaches ``level`` (relative to the ground)."""
        ins = _inset(x, y, self.a, self.b)
        z = self.cell_base(x, y)
        inside = ins > 0
        z = np.where(inside, np.maximum(z, min(level, 0.0)), z)
        if level > 0:
            cap = np.clip(ins / self.run, 0, level)
            z = np.where(inside, np.maximum(z, cap), z)
        return z

    def surface(self, level: float | None, name: str) -> Surface:
        fn = self.cell_base if level is None else (lambda x, y: self.after(level, x, y))
        return Surface(name, "landfill", self.centre, self.base, max(self.a, self.b) * 1.3, fn, {})

    def lift_volume(self, lo: float, hi: float) -> float:
        """Waste between levels ``lo`` and ``hi`` (relative to the ground), exact."""
        v = 0.0
        if lo < 0:  # inside the cell: depths from the ground
            v += _rect_frustum_volume(self.a, self.b, self.run, -min(hi, 0.0), -lo)
        if hi > 0:  # the cap above the ground
            v += _rect_frustum_volume(self.a, self.b, self.run, max(lo, 0.0), hi)
        return v

    def truth(self) -> dict:
        levels = [-self.depth, *self.lifts]
        lifts = [
            {
                "lift": i + 1,
                "fromM": self.base + levels[i],
                "toM": self.base + levels[i + 1],
                "volumeM3": self.lift_volume(levels[i], levels[i + 1]),
            }
            for i in range(len(self.lifts))
        ]
        airspace = self.lift_volume(-self.depth, self.final_cap)
        used = sum(x["volumeM3"] for x in lifts)
        return {
            "openingM": [2 * self.a, 2 * self.b],
            "sideSlope": f"1:{self.run:g}",
            "depthM": self.depth,
            "floorLevelM": self.base - self.depth,
            "lifts": lifts,
            "airspaceM3": airspace,
            "usedM3": used,
            "remainingM3": airspace - used,
            "finalCapLevelM": self.base + self.final_cap,
        }


# ------------------------------------------------------------------ alignments and the haul road


@dataclass(frozen=True)
class AlignElement:
    """A horizontal element: ``line``, ``spiral`` (clothoid) or ``arc``. Curvatures are signed:
    positive turns left (counter-clockwise seen from above)."""

    type: str
    length: float
    k0: float = 0.0
    k1: float = 0.0


_GL_X, _GL_W = np.polynomial.legendre.leggauss(24)


class AlignmentGeom:
    """A horizontal alignment from a start point and bearing (radians clockwise from grid north).

    Positions are integrated with 24-point Gauss-Legendre per evaluation (the bearing is at most
    quadratic in chainage), exact to well under a micrometre for these lengths. Stationing starts
    at ``start_station``; ``equations`` are (back, ahead) pairs: at station ``back`` of the
    incoming chainage, stations continue from ``ahead``.
    """

    def __init__(
        self,
        start: tuple[float, float],
        bearing: float,
        elements: Sequence[AlignElement],
        start_station: float = 0.0,
        equations: Sequence[tuple[float, float]] = (),
        name: str = "Alignment",
    ):
        self.name = name
        self.elements = list(elements)
        self.start_station = start_station
        self.equations = list(equations)
        self.starts: list[tuple[float, float, float, float]] = []  # chainage, E, N, bearing
        s, e, n, b = 0.0, float(start[0]), float(start[1]), float(bearing)
        for el in self.elements:
            self.starts.append((s, e, n, b))
            pe, pn = self._integrate(el, e, n, b, np.array([el.length]))
            e, n = float(pe[0]), float(pn[0])
            b = self._bearing(el, b, el.length)
            s += el.length
        self.length = s
        self.end = (e, n, b)

    @staticmethod
    def _bearing(el: AlignElement, b0: float, t):
        return b0 - (el.k0 * t + (el.k1 - el.k0) * np.asarray(t) ** 2 / (2 * el.length))

    def _integrate(self, el: AlignElement, e0: float, n0: float, b0: float, t: np.ndarray):
        t = np.asarray(t, dtype=np.float64)
        u = (t[:, None] / 2) * (_GL_X[None, :] + 1)
        bb = self._bearing(el, b0, u)
        w = (t[:, None] / 2) * _GL_W[None, :]
        return e0 + np.sum(w * np.sin(bb), axis=1), n0 + np.sum(w * np.cos(bb), axis=1)

    def _locate(self, s: np.ndarray) -> np.ndarray:
        bounds = np.array([st[0] for st in self.starts])
        return np.clip(np.searchsorted(bounds, s, side="right") - 1, 0, len(self.elements) - 1)

    def point(self, s: Sequence[float] | np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """E, N and bearing at internal chainages ``s`` (0 to ``length``)."""
        s = np.atleast_1d(np.asarray(s, dtype=np.float64))
        idx = self._locate(s)
        E = np.empty_like(s)
        N = np.empty_like(s)
        B = np.empty_like(s)
        for i in np.unique(idx):
            m = idx == i
            s0, e0, n0, b0 = self.starts[i]
            el = self.elements[i]
            t = s[m] - s0
            E[m], N[m] = self._integrate(el, e0, n0, b0, t)
            B[m] = self._bearing(el, b0, t)
        return E, N, B

    def curvature(self, s: np.ndarray) -> np.ndarray:
        s = np.atleast_1d(np.asarray(s, dtype=np.float64))
        idx = self._locate(s)
        k = np.empty_like(s)
        for i in np.unique(idx):
            m = idx == i
            el = self.elements[i]
            k[m] = el.k0 + (el.k1 - el.k0) * (s[m] - self.starts[i][0]) / el.length
        return k

    def station(self, s: float) -> float:
        """The station of internal chainage ``s`` (start station and equations applied)."""
        st = self.start_station + s
        for back, ahead in self.equations:
            if st >= back:
                st = st - back + ahead
        return st

    def element_records(self) -> list[dict]:
        """Each element with its start, end, centre (arcs) and PI (spirals), for writers."""
        out = []
        for i, el in enumerate(self.elements):
            s0, e0, n0, b0 = self.starts[i]
            e1, n1, b1 = self.point([s0 + el.length])
            rec: dict[str, Any] = {
                "type": el.type,
                "length": el.length,
                "start": (e0, n0),
                "end": (float(e1[0]), float(n1[0])),
                "dirStart": b0,
                "dirEnd": float(b1[0]),
                "k0": el.k0,
                "k1": el.k1,
            }
            k = el.k0 if el.type == "arc" else (el.k1 or el.k0)
            rec["rot"] = "ccw" if k > 0 else "cw"
            if el.type == "arc":
                r = 1 / abs(el.k0)
                sgn = 1 if el.k0 > 0 else -1
                # the centre lies to the left of the start tangent for a left (ccw) turn
                rec["radius"] = r
                rec["center"] = (e0 - sgn * r * math.cos(b0), n0 + sgn * r * math.sin(b0))
            if el.type == "spiral":
                rec["radiusStart"] = None if el.k0 == 0 else 1 / abs(el.k0)
                rec["radiusEnd"] = None if el.k1 == 0 else 1 / abs(el.k1)
                # PI: where the start and end tangents meet
                d0 = np.array([math.sin(b0), math.cos(b0)])
                d1 = np.array([math.sin(rec["dirEnd"]), math.cos(rec["dirEnd"])])
                p0 = np.array(rec["start"])
                p1 = np.array(rec["end"])
                uv = np.linalg.solve(np.c_[d0, -d1], p1 - p0)
                pi = p0 + uv[0] * d0
                rec["pi"] = (float(pi[0]), float(pi[1]))
            out.append(rec)
        return out

    def dense(self, step: float = 0.05) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
        """Chainage, E, N and bearing every ``step`` metres (both ends included)."""
        s = np.linspace(0.0, self.length, round(self.length / step) + 1)
        e, n, b = self.point(s)
        return s, e, n, b

    def to_json(self, crs: dict) -> dict:
        """The ``aio.alignment/1`` document (data-conventions section 28)."""
        els = []
        for r in self.element_records():
            pt = lambda p: [p[0], p[1]]  # noqa: E731
            if r["type"] == "line":
                els.append(
                    {"type": "line", "start": pt(r["start"]), "end": pt(r["end"]), "length": r["length"]}
                )
            elif r["type"] == "arc":
                els.append(
                    {
                        "type": "arc",
                        "start": pt(r["start"]),
                        "end": pt(r["end"]),
                        "center": pt(r["center"]),
                        "radius": r["radius"],
                        "rot": r["rot"],
                        "length": r["length"],
                    }
                )
            else:
                els.append(
                    {
                        "type": "spiral",
                        "spiral": "clothoid",
                        "start": pt(r["start"]),
                        "end": pt(r["end"]),
                        "radiusStart": r["radiusStart"],
                        "radiusEnd": r["radiusEnd"],
                        "rot": r["rot"],
                        "length": r["length"],
                        "dirStart": r["dirStart"],
                    }
                )
        return {
            "schema": "aio.alignment/1",
            "name": self.name,
            "crs": crs,
            "startStation": self.start_station,
            "elements": els,
            "equations": [{"back": b, "ahead": a} for b, a in self.equations],
            "intervalM": 20,
        }


def standard_alignment(
    start: tuple[float, float],
    bearing_deg: float = 90.0,
    turn: str = "ccw",
    radius: float = 90.0,
    lengths: tuple[float, float, float, float, float] = (60.0, 30.0, 60.0, 30.0, 60.0),
    name: str = "Haul road centreline",
) -> AlignmentGeom:
    """Line, clothoid in, arc, clothoid out, line; start station 1000, equation 1150 -> 1200."""
    k = (1 if turn == "ccw" else -1) / radius
    l1, s1, a, s2, l2 = lengths
    els = [
        AlignElement("line", l1),
        AlignElement("spiral", s1, 0.0, k),
        AlignElement("arc", a, k, k),
        AlignElement("spiral", s2, k, 0.0),
        AlignElement("line", l2),
    ]
    return AlignmentGeom(start, math.radians(bearing_deg), els, 1000.0, [(1150.0, 1200.0)], name)


@dataclass
class HaulRoad:
    """A haul road along an alignment (a ``standard_alignment``: line, clothoid, arc, clothoid,
    line). Heights at chainage s and offset o (metres, left positive):

    - centreline z_c(s) = ``z0`` + integral of the grade: ``grade`` (8 %) except ``steep``
      (s0, s1, 12 %), the planted steep stretch;
    - running surface |o| <= 12.5 (width 25 m): crowned at ``crossfall`` (2 %) on the tangents,
      one-way ``superelevation`` (5 %, the inside of the curve lower) on the arc, blended
      linearly through the clothoids;
    - berms of ``berm_height`` (1.5 m) on both sides: a triangle 4 m wide at the base, its crest at
      |o| = 14.5, relative to the road edge; the planted low berm (left side, s 100 to 120, 0.8 m);
    - a flat shoulder at edge height to |o| = 25, then a linear blend to the ground by |o| = 60.
    """

    align: AlignmentGeom
    z0: float
    grade: float = 0.08
    steep: tuple[float, float, float] = (170.0, 195.0, 0.12)
    half_width: float = 12.5
    crossfall: float = 0.02
    superelevation: float = 0.05
    berm_height: float = 1.5
    berm_base: float = 4.0
    low_berm: tuple[str, float, float, float] = ("left", 100.0, 120.0, 0.8)
    shoulder: float = 25.0
    blend: float = 60.0

    def centre_z(self, s: np.ndarray) -> np.ndarray:
        s = np.asarray(s, dtype=np.float64)
        a, b, g2 = self.steep
        extra = np.clip(np.minimum(s, b) - a, 0, None) * (g2 - self.grade)
        return self.z0 + self.grade * s + extra

    def grade_at(self, s: np.ndarray) -> np.ndarray:
        s = np.asarray(s, dtype=np.float64)
        a, b, g2 = self.steep
        return np.where((s >= a) & (s < b), g2, self.grade)

    def super_t(self, s: np.ndarray) -> np.ndarray:
        """0 on the tangents, 1 on the arc, linear through the clothoids (|k| / k_arc)."""
        k = self.align.curvature(s)
        karc = max(abs(e.k0) for e in self.align.elements if e.type == "arc")
        return np.abs(k) / karc

    def turn_sign(self) -> float:
        arc = next(e for e in self.align.elements if e.type == "arc")
        return 1.0 if arc.k0 > 0 else -1.0

    def berm(self, s: np.ndarray, side: str) -> np.ndarray:
        s = np.asarray(s, dtype=np.float64)
        h = np.full_like(s, self.berm_height)
        lside, a, b, low = self.low_berm
        if lside == side:
            h = np.where((s >= a) & (s < b), low, h)
        return h

    def section(self, s: np.ndarray, o: np.ndarray) -> np.ndarray:
        """Road heights at chainage ``s`` and offset ``o`` (left positive), within the shoulder."""
        s = np.asarray(s, dtype=np.float64)
        o = np.asarray(o, dtype=np.float64)
        zc = self.centre_z(s)
        t = self.super_t(s)
        sg = self.turn_sign()

        def surf(oo):
            # crown: -c |o|; one-way: the inside of the curve (left for a left turn) lower
            return (1 - t) * (-self.crossfall * np.abs(oo)) + t * (-self.superelevation * sg * oo)

        w = self.half_width
        oc = np.clip(o, -w, w)
        z = zc + surf(oc)
        ao = np.abs(o)
        crest = w + self.berm_base / 2
        hb = np.where(o >= 0, self.berm(s, "left"), self.berm(s, "right"))
        bump = hb * np.clip(1 - np.abs(ao - crest) / (self.berm_base / 2), 0, None)
        return z + np.where(ao > w, bump, 0.0)

    def heights(self, e: np.ndarray, n: np.ndarray, ground: HeightFn) -> np.ndarray:
        """The road set into ``ground``: the section within ``shoulder``, blended to the ground by
        ``blend``, the ground elsewhere."""
        from scipy.spatial import cKDTree

        e = np.asarray(e, dtype=np.float64)
        n = np.asarray(n, dtype=np.float64)
        g = ground(e, n)
        ds, de, dn, db = self.align.dense(0.05)
        tree = cKDTree(np.c_[de, dn])
        flat = np.c_[e.ravel(), n.ravel()]
        dist, idx = tree.query(flat, distance_upper_bound=self.blend + 1)
        near = np.isfinite(dist)
        out = g.ravel().copy()
        if near.any():
            i = idx[near]
            px, py = flat[near, 0] - de[i], flat[near, 1] - dn[i]
            te, tn = np.sin(db[i]), np.cos(db[i])
            along = px * te + py * tn
            # a left offset is positive: the cross product of the tangent with the point vector
            off = te * py - tn * px
            s = np.clip(ds[i] + along, 0, self.align.length)
            beyond = ((i == 0) & (along < -1e-6)) | ((i == len(ds) - 1) & (along > 1e-6))
            ao = np.abs(off)
            edge = self.section(s, np.clip(off, -self.shoulder, self.shoulder))
            wgt = np.clip((ao - self.shoulder) / (self.blend - self.shoulder), 0, 1)
            z = (1 - wgt) * edge + wgt * g.ravel()[near]
            sub = out[near]
            sub[~beyond] = z[~beyond]
            out[near] = sub
        return out.reshape(e.shape)

    def stations(self, step: float = 10.0) -> list[dict]:
        """The truth at every ``step`` metres of chainage: station, centre, grade, cross falls,
        superelevation, width, berm heights."""
        s = np.arange(0.0, self.align.length + 1e-9, step)
        e, n, _ = self.align.point(s)
        w = self.half_width
        zc = self.centre_z(s)
        zl = self.section(s, np.full_like(s, w))
        zr = self.section(s, np.full_like(s, -w))
        t = self.super_t(s)
        out = []
        for i, si in enumerate(s):
            out.append(
                {
                    "chainage": float(si),
                    "station": self.align.station(float(si)),
                    "e": float(e[i]),
                    "n": float(n[i]),
                    "z": float(zc[i]),
                    "gradePct": float(100 * self.grade_at(si)),
                    "crossFallLeftPct": float(100 * (zl[i] - zc[i]) / w),
                    "crossFallRightPct": float(100 * (zr[i] - zc[i]) / w),
                    "superelevationPct": float(100 * self.superelevation * t[i]),
                    "widthM": 2 * w,
                    "bermLeftM": float(self.berm(si, "left")),
                    "bermRightM": float(self.berm(si, "right")),
                }
            )
        return out

    def truth(self) -> dict:
        side, a, b, low = self.low_berm
        return {
            "lengthM": self.align.length,
            "startStation": self.align.start_station,
            "equations": [{"back": bk, "ahead": ah} for bk, ah in self.align.equations],
            "widthM": 2 * self.half_width,
            "gradePct": 100 * self.grade,
            "crossFallPct": 100 * self.crossfall,
            "superelevationPct": 100 * self.superelevation,
            "bermHeightM": self.berm_height,
            "limits": {
                "minWidthM": 20.0,
                "maxGradePct": 10.0,
                "crossFallMinPct": 1.0,
                "crossFallMaxPct": 4.0,
                "minBermHeightM": 1.0,
            },
            "violations": [
                {
                    "kind": "grade",
                    "fromChainage": self.steep[0],
                    "toChainage": self.steep[1],
                    "valuePct": 100 * self.steep[2],
                },
                {"kind": "berm", "side": side, "fromChainage": a, "toChainage": b, "valueM": low},
            ],
            "stations": self.stations(10.0),
        }

    def corridor_tin(self, step: float = 5.0) -> Tin:
        """The road's running surface and berms as a TIN (cross-sections every ``step`` m and at
        every element and violation boundary; offsets 16.5, 14.5, 12.5, 0 each side)."""
        cuts = {0.0, self.align.length, *self.steep[:2], *self.low_berm[1:3]}
        cuts |= {st[0] for st in self.align.starts}
        s = np.array(sorted(cuts | set(np.arange(0.0, self.align.length, step).tolist())))
        offs = np.array([16.5, 14.5, 12.5, 0.0, -12.5, -14.5, -16.5])
        e, n, b = self.align.point(s)
        verts = []
        for i in range(len(s)):
            nl = (-math.cos(b[i]), math.sin(b[i]))  # left normal
            z = self.section(np.full(len(offs), s[i]), offs)
            for k, o in enumerate(offs):
                verts.append((e[i] + o * nl[0], n[i] + o * nl[1], float(z[k])))
        m = len(offs)
        tris = []
        for i in range(len(s) - 1):
            for k in range(m - 1):
                a0, a1 = i * m + k, i * m + k + 1
                b0, b1 = a0 + m, a1 + m
                tris += [(a0, b0, a1), (a1, b0, b1)]
        return Tin(np.round(np.array(verts), 4), np.array(tris, dtype=np.int64), name="Road design")


# ------------------------------------------------------------------ TINs


@dataclass
class Tin:
    """A triangulated surface: ``vertices`` (n, 3) E, N, Z and ``triangles`` (m, 3) indices."""

    vertices: np.ndarray
    triangles: np.ndarray
    name: str = "TIN"
    breaklines: list[list[int]] = field(default_factory=list)

    def area2d(self) -> float:
        v = self.vertices
        a, b, c = v[self.triangles[:, 0]], v[self.triangles[:, 1]], v[self.triangles[:, 2]]
        return float(np.sum(np.abs(_cross2(b[:, :2] - a[:, :2], c[:, :2] - a[:, :2]))) / 2)

    def volume_above_plane(
        self, plane: Callable[[np.ndarray, np.ndarray], np.ndarray]
    ) -> tuple[float, float]:
        """Exact (fill, cut) of the TIN against a plane (``fill`` where the TIN is above it).

        The difference is linear on each triangle, so its positive part integrates in closed form:
        all positive, area times the mean; one vertex of the other sign, value p with the others
        q and r, A p^3 / (3 (p - q) (p - r)) for that vertex's sign."""
        v = self.vertices
        d = v[:, 2] - plane(v[:, 0], v[:, 1])
        t = self.triangles
        a, b, c = v[t[:, 0]], v[t[:, 1]], v[t[:, 2]]
        area = np.abs(_cross2(b[:, :2] - a[:, :2], c[:, :2] - a[:, :2])) / 2
        return float(np.sum(_positive_part(d[t], area))), float(np.sum(_positive_part(-d[t], area)))

    def heights(self, e: np.ndarray, n: np.ndarray) -> np.ndarray:
        """Barycentric heights (NaN outside the TIN)."""
        v = self.vertices
        e = np.asarray(e, dtype=np.float64)
        n = np.asarray(n, dtype=np.float64)
        pts = np.c_[e.ravel(), n.ravel()]
        out = np.full(len(pts), np.nan)
        t = self.triangles
        a = v[t[:, 0], :2]
        ab = v[t[:, 1], :2] - a
        ac = v[t[:, 2], :2] - a
        det = ab[:, 0] * ac[:, 1] - ab[:, 1] * ac[:, 0]
        # brute force per triangle bounding box (the TINs here are small)
        lo = np.minimum(np.minimum(v[t[:, 0], :2], v[t[:, 1], :2]), v[t[:, 2], :2])
        hi = np.maximum(np.maximum(v[t[:, 0], :2], v[t[:, 1], :2]), v[t[:, 2], :2])
        for k in range(len(t)):
            m = (pts[:, 0] >= lo[k, 0] - 1e-9) & (pts[:, 0] <= hi[k, 0] + 1e-9)
            m &= (pts[:, 1] >= lo[k, 1] - 1e-9) & (pts[:, 1] <= hi[k, 1] + 1e-9)
            m &= np.isnan(out)
            if not m.any():
                continue
            d = pts[m] - a[k]
            u = (d[:, 0] * ac[k, 1] - d[:, 1] * ac[k, 0]) / det[k]
            w = (ab[k, 0] * d[:, 1] - ab[k, 1] * d[:, 0]) / det[k]
            ok = (u >= -1e-9) & (w >= -1e-9) & (u + w <= 1 + 1e-9)
            z = v[t[k, 0], 2] + u * (v[t[k, 1], 2] - v[t[k, 0], 2]) + w * (v[t[k, 2], 2] - v[t[k, 0], 2])
            sub = out[m]
            sub[ok] = z[ok]
            out[m] = sub
        return out.reshape(e.shape)


def pad_tin(
    centre: tuple[float, float],
    half: tuple[float, float],
    level: float,
    batter: float,
    ground: Callable[[float, float], float],
    ground_grad: tuple[float, float],
    outer: tuple[float, float],
) -> Tin:
    """A fill pad: a flat top ``2 half`` at ``level``, planar batters falling 1:``batter``
    (rise:run) outwards to a planar ground (``ground`` at the centre, ``ground_grad`` its slope),
    and the ground out to the ``outer`` rectangle. Exact for a planar ground: every vertex lies on
    the planes it joins (toe corners solve the two batters and the ground)."""
    cx, cy = centre
    a, b = half
    gx, gy = ground_grad
    g0 = ground(cx, cy)
    k = 1 / batter
    top = [(cx + sx * a, cy + sy * b, level) for sx, sy in ((1, 1), (-1, 1), (-1, -1), (1, -1))]
    toes = []
    for sx, sy in ((1, 1), (-1, 1), (-1, -1), (1, -1)):
        # x, y local: level - k (sx x - a) = level - k (sy y - b) = g0 + gx x + gy y
        A = np.array([[-k * sx, k * sy], [-k * sx - gx, -gy]])
        rhs = np.array([-k * a + k * b, g0 - level - k * a])
        x, y = np.linalg.solve(A, rhs)
        toes.append((cx + x, cy + y, g0 + gx * x + gy * y))
    ox, oy = outer
    outs = [
        (cx + sx * ox, cy + sy * oy, g0 + gx * sx * ox + gy * sy * oy)
        for sx, sy in ((1, 1), (-1, 1), (-1, -1), (1, -1))
    ]
    v = np.round(np.array(top + toes + outs), 4)
    tris = [(0, 1, 2), (0, 2, 3)]
    for i in range(4):
        j = (i + 1) % 4
        tris += [(i, 4 + i, 4 + j), (i, 4 + j, j)]
        tris += [(4 + i, 8 + i, 8 + j), (4 + i, 8 + j, 4 + j)]
    tin = Tin(v, np.array(tris, dtype=np.int64), name="Pad design")
    tin.breaklines = [[0, 1, 2, 3, 0], [4, 5, 6, 7, 4]]
    return tin


def rect_tin(rect: tuple[float, float, float, float], fn: HeightFn, name: str, n: int = 1) -> Tin:
    """A rectangle split into an n x n grid of quads (two triangles each), heights from ``fn``."""
    x0, y0, x1, y1 = rect
    xs = np.linspace(x0, x1, n + 1)
    ys = np.linspace(y0, y1, n + 1)
    X, Y = np.meshgrid(xs, ys)
    v = np.c_[X.ravel(), Y.ravel(), fn(X.ravel(), Y.ravel())]
    tris = []
    for j in range(n):
        for i in range(n):
            a = j * (n + 1) + i
            tris += [(a, a + 1, a + n + 2), (a, a + n + 2, a + n + 1)]
    return Tin(np.round(v, 4), np.array(tris, dtype=np.int64), name=name)


def write_tin(path: Path, tin: Tin, crs: dict) -> Path:
    """An ``aio.tin/1`` file (data-conventions section 28): uint32 header length, JSON header,
    padding to 8 bytes, float64 vertices (E, N, Z), uint32 triangle indices."""
    v = np.ascontiguousarray(tin.vertices, dtype="<f8")
    t = np.ascontiguousarray(tin.triangles, dtype="<u4")
    head: dict[str, Any] = {
        "schema": "aio.tin/1",
        "crs": crs,
        "bounds": [
            float(v[:, 0].min()),
            float(v[:, 1].min()),
            float(v[:, 2].min()),
            float(v[:, 0].max()),
            float(v[:, 1].max()),
            float(v[:, 2].max()),
        ],
        "vertexCount": len(v),
        "triangleCount": len(t),
        "verticesAt": 0,
        "trianglesAt": 0,
        "breaklines": len(tin.breaklines),
    }
    for _ in range(4):
        raw = json.dumps(head, separators=(",", ":")).encode()
        at = 4 + len(raw)
        at += (-at) % 8
        if head["verticesAt"] == at:
            break
        head["verticesAt"] = at
        head["trianglesAt"] = at + v.nbytes
    raw = json.dumps(head, separators=(",", ":")).encode()
    body = struct.pack("<I", len(raw)) + raw
    body += b"\0" * (head["verticesAt"] - len(body))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(body + v.tobytes() + t.tobytes())
    return path


def read_tin(path: Path) -> tuple[dict, Tin]:
    data = path.read_bytes()
    n = struct.unpack_from("<I", data)[0]
    head = json.loads(data[4 : 4 + n])
    v = np.frombuffer(data, "<f8", head["vertexCount"] * 3, head["verticesAt"]).reshape(-1, 3)
    t = np.frombuffer(data, "<u4", head["triangleCount"] * 3, head["trianglesAt"]).reshape(-1, 3)
    return head, Tin(v.copy(), t.astype(np.int64))


def write_alignment_json(path: Path, align: AlignmentGeom, crs: dict) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(align.to_json(crs), indent=1) + "\n", "utf-8", newline="\n")
    return path


# ------------------------------------------------------------------ design file writers


def _num(v: float, d: int = 4) -> str:
    s = f"{v:.{d}f}"
    return "0" if s.strip("-0.") == "" else s


def _ne(p: Sequence[float]) -> str:
    """LandXML point text: northing easting [elevation]."""
    return " ".join(_num(c) for c in ([p[1], p[0]] + ([p[2]] if len(p) > 2 else [])))


@dataclass
class DesignBundle:
    """What one design file holds: surfaces, breaklines (on each Tin), points, alignments."""

    project: str
    surfaces: list[Tin] = field(default_factory=list)
    points: list[tuple[str, float, float, float, str]] = field(default_factory=list)  # name E N Z code
    alignments: list[AlignmentGeom] = field(default_factory=list)
    epsg: int = SITE_EPSG
    crs_name: str = "WGS 84 / UTM zone 39N"


def write_landxml(path: Path, d: DesignBundle) -> Path:
    """A LandXML 1.2 file, hand-written from the schema: Units, CoordinateSystem, Project,
    Application, CgPoints, Surfaces (TIN Definition with Pnts and Faces, SourceData Breaklines)
    and Alignments (CoordGeom with Line, Spiral (clothoid), Curve, and a StaEquation).
    Coordinates are northing easting elevation, metres."""
    out = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" '
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" '
        'xsi:schemaLocation="http://www.landxml.org/schema/LandXML-1.2 '
        'http://www.landxml.org/schema/LandXML-1.2/LandXML-1.2.xsd" '
        'version="1.2" date="2026-03-02" time="10:00:00" readOnly="false" language="English">',
        '  <Units><Metric areaUnit="squareMeter" linearUnit="meter" volumeUnit="cubicMeter" '
        'temperatureUnit="celsius" pressureUnit="milliBars" angularUnit="decimal degrees" '
        'directionUnit="decimal degrees"/></Units>',
        f'  <CoordinateSystem name="{d.crs_name}" epsgCode="{d.epsg}" horizontalDatum="WGS84" '
        'verticalDatum="ellipsoid (synthetic)"/>',
        f'  <Project name="{d.project}" desc="Synthetic design (fictional site, no client data)"/>',
        '  <Application name="Quadrion AI synthetic data" manufacturer="Quadrion AI (synthetic fixture)" '
        'version="1.0"/>',
    ]
    if d.points:
        out.append('  <CgPoints name="Control (synthetic)">')
        for name, e, n, z, code in d.points:
            out.append(f'    <CgPoint name="{name}" code="{code}">{_ne((e, n, z))}</CgPoint>')
        out.append("  </CgPoints>")
    if d.surfaces:
        out.append('  <Surfaces name="Designs">')
        for tin in d.surfaces:
            out.append(f'    <Surface name="{tin.name}" desc="Synthetic design surface">')
            if tin.breaklines:
                out.append("      <SourceData><Breaklines>")
                for k, chain in enumerate(tin.breaklines):
                    pts = " ".join(_ne(tin.vertices[i]) for i in chain)
                    out.append(
                        f'        <Breakline name="{tin.name} breakline {k + 1}" brkType="standard">'
                        f"<PntList3D>{pts}</PntList3D></Breakline>"
                    )
                out.append("      </Breaklines></SourceData>")
            out.append(f'      <Definition surfType="TIN" area2DSurf="{_num(tin.area2d())}">')
            out.append("        <Pnts>")
            for i, p in enumerate(tin.vertices):
                out.append(f'          <P id="{i + 1}">{_ne(p)}</P>')
            out.append("        </Pnts>")
            out.append("        <Faces>")
            for t in tin.triangles:
                out.append(f"          <F>{t[0] + 1} {t[1] + 1} {t[2] + 1}</F>")
            out.append("        </Faces>")
            out.append("      </Definition>")
            out.append("    </Surface>")
        out.append("  </Surfaces>")
    if d.alignments:
        out.append('  <Alignments name="Alignments">')
        for al in d.alignments:
            out.append(
                f'    <Alignment name="{al.name}" length="{_num(al.length)}" staStart="{_num(al.start_station)}">'
            )
            out.append("      <CoordGeom>")
            for r in al.element_records():
                st, en = _ne(r["start"]), _ne(r["end"])
                if r["type"] == "line":
                    out.append(
                        f'        <Line length="{_num(r["length"])}"><Start>{st}</Start><End>{en}</End></Line>'
                    )
                elif r["type"] == "arc":
                    out.append(
                        f'        <Curve rot="{r["rot"]}" crvType="arc" radius="{_num(r["radius"])}" '
                        f'length="{_num(r["length"])}"><Start>{st}</Start><Center>{_ne(r["center"])}</Center>'
                        f"<End>{en}</End></Curve>"
                    )
                else:
                    rs = "INF" if r["radiusStart"] is None else _num(r["radiusStart"])
                    re_ = "INF" if r["radiusEnd"] is None else _num(r["radiusEnd"])
                    out.append(
                        f'        <Spiral length="{_num(r["length"])}" radiusStart="{rs}" radiusEnd="{re_}" '
                        f'rot="{r["rot"]}" spiType="clothoid"><Start>{st}</Start><PI>{_ne(r["pi"])}</PI>'
                        f"<End>{en}</End></Spiral>"
                    )
            out.append("      </CoordGeom>")
            for back, ahead in al.equations:
                out.append(
                    f'      <StaEquation staBack="{_num(back)}" staAhead="{_num(ahead)}" staInternal="{_num(back)}"/>'
                )
            out.append("    </Alignment>")
        out.append("  </Alignments>")
    out.append("</LandXML>")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(out) + "\n", "utf-8", newline="\n")
    return path


def _dxf_pairs(out: list[str], pairs: Sequence[tuple[int, Any]]) -> None:
    for code, value in pairs:
        out.append(f"{code:>3}")
        out.append(_num(value) if isinstance(value, float) else str(value))


def write_dxf(path: Path, d: DesignBundle, units: int = 6) -> Path:
    """ASCII DXF (R12, ``$INSUNITS`` ``units``, 6 = metres): each TIN triangle as a 3DFACE (the
    fourth corner repeats the third), each breakline and each alignment (sampled every 1 m) as a
    3D POLYLINE, each point as a POINT with a TEXT label. Layers: the surface, breakline and
    alignment names in upper case."""
    out: list[str] = []
    _dxf_pairs(
        out,
        [
            (0, "SECTION"),
            (2, "HEADER"),
            (9, "$ACADVER"),
            (1, "AC1009"),
            (9, "$INSUNITS"),
            (70, units),
            (0, "ENDSEC"),
            (0, "SECTION"),
            (2, "ENTITIES"),
        ],
    )

    def lay(s: str) -> str:
        return "".join(ch if ch.isalnum() else "_" for ch in s.upper())

    def poly(layer: str, pts: np.ndarray, closed: bool = False) -> None:
        _dxf_pairs(
            out,
            [
                (0, "POLYLINE"),
                (8, layer),
                (66, 1),
                (10, 0.0),
                (20, 0.0),
                (30, 0.0),
                (70, 8 + (1 if closed else 0)),
            ],
        )
        for p in pts:
            _dxf_pairs(
                out,
                [
                    (0, "VERTEX"),
                    (8, layer),
                    (10, float(p[0])),
                    (20, float(p[1])),
                    (30, float(p[2])),
                    (70, 32),
                ],
            )
        _dxf_pairs(out, [(0, "SEQEND"), (8, layer)])

    for tin in d.surfaces:
        L = lay(tin.name)
        for t in tin.triangles:
            a, b, c = tin.vertices[t]
            _dxf_pairs(
                out,
                [
                    (0, "3DFACE"),
                    (8, L),
                    (10, float(a[0])),
                    (20, float(a[1])),
                    (30, float(a[2])),
                    (11, float(b[0])),
                    (21, float(b[1])),
                    (31, float(b[2])),
                    (12, float(c[0])),
                    (22, float(c[1])),
                    (32, float(c[2])),
                    (13, float(c[0])),
                    (23, float(c[1])),
                    (33, float(c[2])),
                ],
            )
        for chain in tin.breaklines:
            closed = len(chain) > 2 and chain[0] == chain[-1]
            poly(f"{L}_BREAKLINES", tin.vertices[chain[:-1] if closed else chain], closed)
    for al in d.alignments:
        s = np.linspace(0, al.length, math.ceil(al.length) + 1)
        e, n, _ = al.point(s)
        poly(lay(al.name), np.c_[e, n, np.zeros_like(e)])
    for name, e, n, z, _code in d.points:
        _dxf_pairs(out, [(0, "POINT"), (8, "CONTROL"), (10, e), (20, n), (30, z)])
        _dxf_pairs(
            out, [(0, "TEXT"), (8, "CONTROL"), (10, e + 0.5), (20, n + 0.5), (30, z), (40, 0.5), (1, name)]
        )
    _dxf_pairs(out, [(0, "ENDSEC"), (0, "EOF")])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(out) + "\n", "ascii", newline="\n")
    return path


def write_12da(path: Path, d: DesignBundle) -> Path:
    """12d ASCII (12da), written from the 12d ASCII format description: ``model "<name>"``
    blocks of ``string super { name ... colour ... data_3d { x y z ... } }``. A TIN goes as one
    closed 3D super string per triangle in the model ``<surface> faces`` (12d triangulates
    strings; this keeps the surface exact without its proprietary TIN block), breaklines in
    ``<surface> breaklines``, alignments (sampled every 1 m) and points in their own models.
    Coordinates are x (E), y (N), z."""
    out = [
        "// 12da written by the Quadrion AI synthetic data generator (fictional site, no client data)",
        f'// project "{d.project}"',
        "",
    ]

    def string(name: str, pts: np.ndarray, colour: str, closed: bool = False) -> None:
        out.append("string super {")
        out.append(f'  name "{name}"')
        out.append(f"  colour {colour}")
        out.append("  breakline line")
        if closed:
            out.append("  closed true")
        out.append("  data_3d {")
        for p in pts:
            out.append(f"    {_num(float(p[0]))} {_num(float(p[1]))} {_num(float(p[2]))}")
        out.append("  }")
        out.append("}")

    for tin in d.surfaces:
        out.append(f'model "{tin.name} faces"')
        for k, t in enumerate(tin.triangles):
            string(f"F{k + 1}", tin.vertices[t], "green", closed=True)
        if tin.breaklines:
            out.append(f'model "{tin.name} breaklines"')
            for k, chain in enumerate(tin.breaklines):
                string(f"BL{k + 1}", tin.vertices[chain], "red")
    for al in d.alignments:
        out.append(f'model "{al.name}"')
        s = np.linspace(0, al.length, math.ceil(al.length) + 1)
        e, n, _ = al.point(s)
        string(al.name, np.c_[e, n, np.zeros_like(e)], "yellow")
    if d.points:
        out.append('model "Control"')
        for name, e, n, z, _code in d.points:
            out.append("string super {")
            out.append(f'  name "{name}"')
            out.append("  colour cyan")
            out.append("  breakline point")
            out.append(f"  data_3d {{ {_num(e)} {_num(n)} {_num(z)} }}")
            out.append("}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(out) + "\n", "ascii", newline="\n")
    return path


def write_points_csv(path: Path, d: DesignBundle, with_tin_vertices: bool = True) -> Path:
    """CSV points: ``name,easting,northing,elevation,code`` (UTF-8 without BOM, comma separated):
    the control points and (default) every TIN vertex as ``<surface>-<n>``."""
    rows = ["name,easting,northing,elevation,code"]
    for name, e, n, z, code in d.points:
        rows.append(f"{name},{_num(e)},{_num(n)},{_num(z)},{code}")
    if with_tin_vertices:
        for tin in d.surfaces:
            tag = "".join(ch if ch.isalnum() else "-" for ch in tin.name.lower())
            for i, p in enumerate(tin.vertices):
                rows.append(f"{tag}-{i + 1},{_num(p[0])},{_num(p[1])},{_num(p[2])},SURFACE")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(rows) + "\n", "utf-8", newline="\n")
    return path


def write_design_files(folder: Path, d: DesignBundle, stem: str) -> dict[str, Path]:
    """The same design as LandXML, DXF, 12da and CSV points."""
    return {
        "landxml": write_landxml(folder / f"{stem}.xml", d),
        "dxf": write_dxf(folder / f"{stem}.dxf", d),
        "12da": write_12da(folder / f"{stem}.12da", d),
        "csv": write_points_csv(folder / f"{stem}-points.csv", d),
    }


# ------------------------------------------------------------------ hostile files


def landxml_hostile(folder: Path) -> dict[str, tuple[Path, str]]:
    """LandXML files an importer must refuse (or survive) with an exact reason."""
    folder.mkdir(parents=True, exist_ok=True)
    head = '<?xml version="1.0" encoding="UTF-8"?>\n'
    body = (
        '<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2">'
        '<Surfaces><Surface name="{name}"><Definition surfType="TIN"><Pnts>'
        '<P id="1">2331400 551200 120</P><P id="2">2331400 551210 120</P><P id="3">2331410 551200 120</P>'
        "</Pnts><Faces><F>{face}</F></Faces></Definition></Surface></Surfaces></LandXML>\n"
    )
    laughs = ['<!ENTITY lol "lol">']
    for i in range(1, 10):
        prev = f"&lol{i - 1};" if i > 1 else "&lol;"
        laughs.append(f'<!ENTITY lol{i} "{prev * 10}">')
    files = {
        "billion-laughs": (
            head
            + "<!DOCTYPE LandXML [\n"
            + "\n".join(laughs)
            + "\n]>\n"
            + body.format(name="&lol9;", face="1 2 3"),
            "a DTD with nested entity expansion (10^9 copies): refuse the DTD, never expand",
        ),
        "external-entity": (
            head
            + '<!DOCTYPE LandXML [ <!ENTITY ext SYSTEM "file:///C:/Windows/win.ini"> ]>\n'
            + body.format(name="&ext;", face="1 2 3"),
            "an external entity reading a local file: refuse, never resolve",
        ),
        "external-dtd": (
            head
            + '<!DOCTYPE LandXML SYSTEM "http://192.0.2.1/landxml.dtd">\n'
            + body.format(name="S", face="1 2 3"),
            "an external DTD on the network: refuse, never fetch (zero network)",
        ),
        "bad-face-index": (
            head + body.format(name="S", face="1 2 4294967295"),
            "a face naming a point that does not exist (index 4294967295): refuse with the face's line",
        ),
        "truncated": (
            head + body.format(name="S", face="1 2 3")[:160],
            "a file cut off inside an element: refuse with the line where it ends",
        ),
        "huge-declared": (
            head
            + body.format(name="S", face="1 2 3")
            .replace('surfType="TIN"', 'surfType="TIN" area2DSurf="1e300" elevMax="1e300"')
            .replace("<Pnts>", '<Pnts count="10000000000">'),
            "attributes that declare an absurd size (10^10 points, 1e300 m2): never preallocate from them",
        ),
    }
    out = {}
    for name, (text, claim) in files.items():
        p = folder / f"hostile-{name}.xml"
        p.write_text(text, "utf-8", newline="\n")
        out[name] = (p, claim)
    return out


def dxf_hostile(folder: Path, many: int = 0) -> dict[str, tuple[Path, str]]:
    """DXF files: binary DXF, truncated, no units; ``many`` > 0 adds one with that many POINTs."""
    folder.mkdir(parents=True, exist_ok=True)
    out = {}
    p = folder / "hostile-binary.dxf"
    p.write_bytes(b"AutoCAD Binary DXF\r\n\x1a\x00" + bytes(range(256)) * 4)
    out["binary"] = (p, "a binary DXF (sentinel 'AutoCAD Binary DXF'): refuse, ASCII DXF only")
    p = folder / "hostile-truncated.dxf"
    p.write_text(
        "  0\nSECTION\n  2\nENTITIES\n  0\n3DFACE\n  8\nX\n 10\n551200.0\n 20\n", "ascii", newline="\n"
    )
    out["truncated"] = (p, "ends inside a 3DFACE with no EOF: refuse with the line number")
    p = folder / "hostile-odd-pairs.dxf"
    p.write_text(
        "  0\nSECTION\n  2\nENTITIES\n  0\nPOINT\n 10\nnot-a-number\n 20\n2331400.0\n  0\nENDSEC\n  0\nEOF\n",
        "ascii",
        newline="\n",
    )
    out["bad-number"] = (p, "a coordinate that is not a number: refuse with the line number")
    if many > 0:
        p = folder / f"hostile-{many}-points.dxf"
        lines = ["  0", "SECTION", "  2", "ENTITIES"]
        rng = np.random.default_rng(5)
        xy = rng.uniform(-100, 100, (many, 2))
        rec = "  0\nPOINT\n  8\nP\n 10\n{:.3f}\n 20\n{:.3f}\n 30\n120.000"
        body = "\n".join(rec.format(SITE_E0 + x, SITE_N0 + y) for x, y in xy)
        p.write_text("\n".join(lines) + "\n" + body + "\n  0\nENDSEC\n  0\nEOF\n", "ascii", newline="\n")
        out["many-entities"] = (
            p,
            f"{many} entities: stream within the limits or refuse exactly, never exhaust memory",
        )
    return out


def twelve_da_hostile(folder: Path) -> dict[str, tuple[Path, str]]:
    folder.mkdir(parents=True, exist_ok=True)
    texts = {
        "unclosed-brace": (
            'model "M"\nstring super {\n  name "A"\n  data_3d {\n    551200 2331400 120\n',
            "a string never closed: refuse with the line where it opened",
        ),
        "bad-number": (
            'model "M"\nstring super {\n  name "A"\n  data_3d {\n    551200 north 120\n  }\n}\n',
            "a coordinate that is not a number (line 5): refuse with that line",
        ),
        "unknown-record": (
            'model "M"\nwidget {\n  name "A"\n}\nstring super {\n  name "B"\n  data_3d {\n'
            "    551200 2331400 120\n    551210 2331400 120\n  }\n}\n",
            "an unknown record ('widget'): skip it with a warning and read the rest",
        ),
        "short-row": (
            'model "M"\nstring super {\n  name "A"\n  data_3d {\n    551200 2331400\n  }\n}\n',
            "a data_3d row with two values: refuse with the line",
        ),
    }
    out = {}
    for name, (text, claim) in texts.items():
        p = folder / f"hostile-{name}.12da"
        p.write_text(text, "ascii", newline="\n")
        out[name] = (p, claim)
    return out


def csv_hostile(
    folder: Path, points: Sequence[tuple[str, float, float, float, str]]
) -> dict[str, tuple[Path, str]]:
    """CSV point files with a BOM, mixed separators, and latitude and longitude swapped."""
    folder.mkdir(parents=True, exist_ok=True)
    out = {}
    rows = ["name,easting,northing,elevation,code"] + [
        f"{a},{e:.4f},{n:.4f},{z:.4f},{c}" for a, e, n, z, c in points
    ]
    p = folder / "hostile-bom.csv"
    p.write_bytes(b"\xef\xbb\xbf" + ("\r\n".join(rows) + "\r\n").encode())
    out["bom"] = (
        p,
        "UTF-8 with a BOM and CRLF line ends: read it the same as without (the header is 'name')",
    )
    mixed = [rows[0]] + [r.replace(",", ";") if i % 2 else r for i, r in enumerate(rows[1:])]
    p = folder / "hostile-mixed-separators.csv"
    p.write_text("\n".join(mixed) + "\n", "utf-8", newline="\n")
    out["mixed-separators"] = (
        p,
        "rows alternate ',' and ';': refuse with the first row whose separator differs (row 3)",
    )
    lon, lat = to_lonlat(SITE_EPSG, [q[1] for q in points], [q[2] for q in points])
    swapped = ["name,lat,lon,height"] + [
        f"{q[0]},{lo:.8f},{la:.8f},{q[3]:.3f}" for q, lo, la in zip(points, lon, lat, strict=True)
    ]
    p = folder / "hostile-latlon-swapped.csv"
    p.write_text("\n".join(swapped) + "\n", "utf-8", newline="\n")
    out["latlon-swapped"] = (
        p,
        "the 'lat' column holds longitudes and 'lon' latitudes (51.49 / 21.08): warn that the points fall "
        "outside the site and offer the swap",
    )
    return out


def jobxml_hostile(folder: Path, cal: dict) -> dict[str, tuple[Path, str]]:
    folder.mkdir(parents=True, exist_ok=True)
    good = write_jobxml(folder / "tmp.jxl", cal).read_text("utf-8")
    (folder / "tmp.jxl").unlink()
    out = {}
    p = folder / "hostile-unknown-elements.jxl"
    p.write_text(
        good.replace("<FieldBook>", '<FieldBook><FutureRecord a="1"><Deep><Er/></Deep></FutureRecord>'),
        "utf-8",
        newline="\n",
    )
    out["unknown-elements"] = (p, "elements a reader does not know: ignore them and read the calibration")
    p = folder / "hostile-dtd.jxl"
    p.write_text(
        good.replace("?>", '?>\n<!DOCTYPE JOBFile [ <!ENTITY x SYSTEM "file:///etc/passwd"> ]>', 1),
        "utf-8",
        newline="\n",
    )
    out["dtd"] = (p, "a DTD with an external entity: refuse")
    return out


# ------------------------------------------------------------------ calibration and controller files


def site_calibration(
    points_utm: Sequence[tuple[str, float, float, float]] | None = None,
    seed: int = 21,
    horizontal: dict | None = None,
    vertical: dict | None = None,
    noise_mm: float = 6.0,
) -> dict:
    """A synthetic calibration of the fictional site grid to WGS 84 with exact parameters and
    exact residuals.

    Base projection: ``SITE_GRID_PROJ4`` (WGS 84 to grid). Horizontal: the controller's 2D
    similarity ``local = origin + shift + scale R(rot) (grid - origin)``; vertical: an inclined
    plane on ellipsoidal heights ``local Z = h + shift + slopeN (N - n0) + slopeE (E - e0)``.
    Local coordinates are perturbed by small offsets projected orthogonal to the model's columns,
    so a least-squares solve recovers exactly these parameters and exactly these residuals
    (observed local minus computed, metres). Returns a dict with ``parameters``, ``pairs`` (name,
    WGS 84 lat/lon/h, grid N/E, local N/E/Z, residuals) and ``rmsH``, ``rmsV``.
    """
    from rasterio.crs import CRS

    pts = points_utm or [
        ("CAL1", SITE_E0 - 140.0, SITE_N0 - 130.0, SITE_H0 + 0.0),
        ("CAL2", SITE_E0 + 150.0, SITE_N0 - 120.0, SITE_H0 + 1.2),
        ("CAL3", SITE_E0 + 135.0, SITE_N0 + 145.0, SITE_H0 + 2.1),
        ("CAL4", SITE_E0 - 125.0, SITE_N0 + 140.0, SITE_H0 + 0.7),
        ("CAL5", SITE_E0 + 5.0, SITE_N0 + 8.0, SITE_H0 + 1.0),
    ]
    hz = horizontal or {
        "shiftE": 12.345,
        "shiftN": -6.789,
        "rotationRad": math.radians(0.35),
        "scale": 1.00015,
    }
    vt = vertical or {"shiftM": 1.234, "slopeN": 12e-6, "slopeE": -8e-6}
    lon, lat = to_lonlat(SITE_EPSG, [p[1] for p in pts], [p[2] for p in pts])
    ge, gn = from_lonlat(CRS.from_proj4(SITE_GRID_PROJ4), lon, lat)
    ge, gn = np.array(ge), np.array(gn)
    h = np.array([p[3] for p in pts])
    o_e, o_n = float(np.round(ge.mean(), 3)), float(np.round(gn.mean(), 3))
    s, r = hz["scale"], hz["rotationRad"]
    dx, dy = ge - o_e, gn - o_n
    le = o_e + hz["shiftE"] + s * (math.cos(r) * dx - math.sin(r) * dy)
    ln = o_n + hz["shiftN"] + s * (math.sin(r) * dx + math.cos(r) * dy)
    lz = h + vt["shiftM"] + vt["slopeN"] * dy + vt["slopeE"] * dx
    # perturbations orthogonal to the column space of each model -> exact LS residuals
    rng = np.random.default_rng(seed)
    m = len(pts)
    A = np.zeros((2 * m, 4))
    A[:m, 0], A[:m, 1], A[:m, 2] = dx, -dy, 1
    A[m:, 0], A[m:, 1], A[m:, 3] = dy, dx, 1
    v = rng.normal(0, noise_mm / 1000, 2 * m)
    v -= A @ np.linalg.lstsq(A, v, rcond=None)[0]
    B = np.c_[np.ones(m), dy, dx]
    w = rng.normal(0, noise_mm / 1000, m)
    w -= B @ np.linalg.lstsq(B, w, rcond=None)[0]
    le, ln, lz = le + v[:m], ln + v[m:], lz + w
    pairs = []
    for i, p in enumerate(pts):
        pairs.append(
            {
                "name": p[0],
                "wgs84": [lat[i], lon[i], float(h[i])],
                "grid": [float(gn[i]), float(ge[i]), float(h[i])],
                "local": [float(ln[i]), float(le[i]), float(lz[i])],
                "utm": [p[1], p[2], p[3]],
                "residualE": float(v[i]),
                "residualN": float(v[m + i]),
                "residualH": float(math.hypot(v[i], v[m + i])),
                "residualV": float(w[i]),
            }
        )
    return {
        "projection": {"proj4": SITE_GRID_PROJ4, "name": FIXTURE_CRS["site-grid"].name},
        "horizontal": {"originE": o_e, "originN": o_n, **hz},
        "vertical": {"originE": o_e, "originN": o_n, **vt},
        "pairs": pairs,
        "rmsH": float(math.sqrt(np.mean(v[:m] ** 2 + v[m:] ** 2))),
        "rmsV": float(math.sqrt(np.mean(w**2))),
        "note": "Residuals are observed local minus computed (metres); heights are ellipsoidal (no geoid).",
    }


def write_jobxml(path: Path, cal: dict, job: str = "SYNTHETIC-CAL-0001") -> Path:
    """A synthetic Trimble JobXML (``.jxl``) holding the calibration, hand-written after the
    published JobXML structure: ``JOBFile`` > ``Environment`` > ``CoordinateSystem`` (ellipsoid,
    transverse Mercator ``Projection``, ``HorizontalAdjustment``, ``VerticalAdjustment``) and a
    ``FieldBook`` of ``PointRecord`` s (WGS 84 and grid positions) and a ``SiteCalibrationRecord``
    with its residuals. Angles in decimal degrees; the job name says synthetic."""
    hz, vt = cal["horizontal"], cal["vertical"]
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        f'<JOBFile jobName="{job}" product="Synthetic controller (fictional)" productVersion="1.0" '
        'version="5.6" timeStamp="2026-03-02T10:00:00">',
        "  <Environment>",
        "    <CoordinateSystem>",
        "      <SystemName>Fictional site grid (synthetic)</SystemName>",
        "      <ZoneName>Synthetic TM</ZoneName>",
        "      <DatumName>WGS 1984</DatumName>",
        "      <Ellipsoid><EarthRadius>6378137</EarthRadius><Flattening>0.0033528106647474805</Flattening></Ellipsoid>",
        "      <Projection>",
        "        <Type>TransverseMercatorProjection</Type>",
        "        <Scale>1</Scale>",
        "        <GridOrientation>IncreasingNorthEast</GridOrientation>",
        "        <CentralMeridian>51.4929</CentralMeridian>",
        "        <OriginLatitude>21.0829</OriginLatitude>",
        "        <FalseNorthing>50000</FalseNorthing>",
        "        <FalseEasting>10000</FalseEasting>",
        "      </Projection>",
        "      <HorizontalAdjustment>",
        "        <Type>Helmert</Type>",
        f"        <OriginNorth>{hz['originN']:.4f}</OriginNorth>",
        f"        <OriginEast>{hz['originE']:.4f}</OriginEast>",
        f"        <TranslationNorth>{hz['shiftN']:.6f}</TranslationNorth>",
        f"        <TranslationEast>{hz['shiftE']:.6f}</TranslationEast>",
        f"        <Rotation>{math.degrees(hz['rotationRad']):.10f}</Rotation>",
        f"        <Scale>{hz['scale']:.10f}</Scale>",
        "      </HorizontalAdjustment>",
        "      <VerticalAdjustment>",
        "        <Type>InclinedPlane</Type>",
        f"        <OriginNorth>{vt['originN']:.4f}</OriginNorth>",
        f"        <OriginEast>{vt['originE']:.4f}</OriginEast>",
        f"        <ConstantAdjustment>{vt['shiftM']:.6f}</ConstantAdjustment>",
        f"        <SlopeNorth>{vt['slopeN'] * 1e6:.6f}</SlopeNorth>",
        f"        <SlopeEast>{vt['slopeE'] * 1e6:.6f}</SlopeEast>",
        "      </VerticalAdjustment>",
        "    </CoordinateSystem>",
        "  </Environment>",
        "  <FieldBook>",
    ]
    for i, p in enumerate(cal["pairs"]):
        la, lo, h = p["wgs84"]
        ln, le, lz = p["local"]
        lines += [
            f'    <PointRecord ID="{i + 1:08X}" TimeStamp="2026-03-02T10:{i:02d}:00">',
            f"      <Name>{p['name']}</Name>",
            "      <Code>CAL</Code>",
            "      <Method>Coordinates</Method>",
            "      <Classification>Normal</Classification>",
            f"      <WGS84><Latitude>{la:.10f}</Latitude><Longitude>{lo:.10f}</Longitude><Height>{h:.4f}</Height></WGS84>",
            f"      <Grid><North>{ln:.4f}</North><East>{le:.4f}</East><Elevation>{lz:.4f}</Elevation></Grid>",
            "    </PointRecord>",
        ]
    lines.append('    <SiteCalibrationRecord ID="000000FF" TimeStamp="2026-03-02T11:00:00">')
    for p in cal["pairs"]:
        lines.append(
            f"      <CalibrationPoint><GridPoint>{p['name']}</GridPoint><GNSSPoint>{p['name']}</GNSSPoint>"
            "<Horizontal>true</Horizontal><Vertical>true</Vertical>"
            f"<HorizontalResidual>{p['residualH']:.4f}</HorizontalResidual>"
            f"<VerticalResidual>{p['residualV']:.4f}</VerticalResidual></CalibrationPoint>"
        )
    lines += ["    </SiteCalibrationRecord>", "  </FieldBook>", "</JOBFile>"]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", "utf-8", newline="\n")
    return path


def write_dc(path: Path, cal: dict, job: str = "SYNTHETIC-CAL-0001") -> Path:
    """A synthetic Trimble ``.dc`` survey data file holding the same calibration points.

    Fixed-width records as the ``.dc`` record layout describes them, as far as it is published:
    each line is a 2-digit record type, a 2-letter flag (``NM`` normal, ``KI`` keyed in) and
    16-character fields. Written records: ``00NM`` file header, ``10NM`` job name, ``08KI`` keyed-in
    grid point (name, north, east, elevation, code), ``64KI`` horizontal adjustment (origin north,
    origin east, translation north, translation east, rotation degrees, scale) and ``65KI``
    vertical adjustment (origin north, origin east, constant, slope north ppm, slope east ppm).
    Low confidence on vendor parity: G1 confirms against a real file on the founder's machine."""
    f16 = lambda v: f"{v:>16}"  # noqa: E731
    n16 = lambda v: f"{v:>16.6f}"  # noqa: E731
    hz, vt = cal["horizontal"], cal["vertical"]
    rows = [
        "00NMSC V10-70 (synthetic)   ",
        "10NM" + f"{job:<16}",
    ]
    for p in cal["pairs"]:
        ln, le, lz = p["local"]
        rows.append("08KI" + f16(p["name"]) + n16(ln) + n16(le) + n16(lz) + f16("CAL"))
    rows.append(
        "64KI"
        + n16(hz["originN"])
        + n16(hz["originE"])
        + n16(hz["shiftN"])
        + n16(hz["shiftE"])
        + n16(math.degrees(hz["rotationRad"]))
        + f"{hz['scale']:>16.10f}"
    )
    rows.append(
        "65KI"
        + n16(vt["originN"])
        + n16(vt["originE"])
        + n16(vt["shiftM"])
        + n16(vt["slopeN"] * 1e6)
        + n16(vt["slopeE"] * 1e6)
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\r\n".join(rows) + "\r\n", "ascii", newline="")
    return path


def calibration_json(cal: dict, cal_id: str, file_rel: str | None, sha: str | None) -> dict:
    """The ``aio.site-calibration/1`` document (a draft: not applied) for ``cal``."""
    return {
        "schema": "aio.site-calibration/1",
        "id": cal_id,
        "name": "Site calibration (synthetic)",
        "source": {
            "format": "jobxml",
            **({"file": file_rel} if file_rel else {}),
            **({"sha256": sha} if sha else {}),
        },
        "projection": {"wkt": crs_of(FIXTURE_CRS["site-grid"]).to_wkt()},
        "horizontal": {
            k: cal["horizontal"][k]
            for k in ("originE", "originN", "shiftE", "shiftN", "rotationRad", "scale")
        },
        "vertical": {k: cal["vertical"][k] for k in ("originE", "originN", "shiftM", "slopeN", "slopeE")},
        "pairs": [
            {
                "name": p["name"],
                "local": p["local"],
                "wgs84": p["wgs84"],
                "useH": True,
                "useV": True,
                "residualH": p["residualH"],
                "residualV": p["residualV"],
                "controllerResidualH": round(p["residualH"], 4),
                "controllerResidualV": round(p["residualV"], 4),
            }
            for p in cal["pairs"]
        ],
        "rmsH": cal["rmsH"],
        "rmsV": cal["rmsV"],
        "computedAt": STAMP,
    }


def write_geoid_grid(
    path: Path, lonlat: tuple[float, float], size_deg: float = 0.2, step_deg: float = 0.01
) -> dict:
    """A fictional geoid model (GeoTIFF, EPSG:4326, float32) around ``lonlat`` with the analytic
    undulation N = 25 + 0.5 (lon - lon0) - 0.3 (lat - lat0) metres; returns its truth. Not a real
    geoid: for testing the geoid pack import and bilinear sampling only."""
    import rasterio
    from rasterio.transform import from_origin

    lon0, lat0 = lonlat
    n = round(size_deg / step_deg) + 1
    west, north = lon0 - size_deg / 2 - step_deg / 2, lat0 + size_deg / 2 + step_deg / 2
    lons = west + (np.arange(n) + 0.5) * step_deg
    lats = north - (np.arange(n) + 0.5) * step_deg
    LO, LA = np.meshgrid(lons, lats)
    N = 25 + 0.5 * (LO - lon0) - 0.3 * (LA - lat0)
    path.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=n,
        height=n,
        count=1,
        dtype="float32",
        crs="EPSG:4326",
        transform=from_origin(west, north, step_deg, step_deg),
    ) as d:
        d.write(N.astype(np.float32), 1)
    return {
        "formula": "N = 25 + 0.5 (lon - lon0) - 0.3 (lat - lat0)",
        "lon0": lon0,
        "lat0": lat0,
        "bbox": [west, north - n * step_deg, west + n * step_deg, north],
        "licence": "CC0-1.0 (synthetic, fictional)",
        "attribution": "Synthetic geoid (survey_synth.py)",
    }


# ------------------------------------------------------------------ survey sites


@dataclass
class Feature:
    """A thing on a survey site: an analytic local height ``fn`` added to the ground, with a colour
    for the ortho, a material and the dates it is on."""

    id: str
    surface: Surface
    colour: tuple[int, int, int]
    dates: tuple[str, ...]
    material: str | None = None


@dataclass
class SurveySite:
    """A synthetic site surveyed on several dates (``captures``): absolute heights per capture from
    ``surface(capture)``, its truth, designs, measurements and survey files."""

    id: str
    name: str
    description: str
    centre: tuple[float, float]
    h0: float
    half: float
    res: float
    captures: list[dict]
    ground: HeightFn
    features: list[Feature]
    truth: dict
    shift: dict[str, float] = field(default_factory=dict)
    designs: list[dict] = field(default_factory=list)
    materials: list[dict] = field(default_factory=list)
    template_sets: list[str] = field(default_factory=list)
    holes: dict[str, list[tuple[float, float, float]]] = field(default_factory=dict)
    road: HaulRoad | None = None
    measurements: list[dict] = field(default_factory=list)
    extra_files: dict[str, str] = field(default_factory=dict)
    calibration: dict | None = None
    surfaces_override: dict[str, HeightFn] = field(default_factory=dict)

    def surface(self, capture: str) -> HeightFn:
        if capture in self.surfaces_override:
            return self.surfaces_override[capture]

        def fn(e, n):
            g = self.road.heights(e, n, self.ground) if self.road is not None else self.ground(e, n)
            z = g.copy()
            for f in self.features:
                if capture in f.dates:
                    z = z + f.surface.local(e - f.surface.centre[0], n - f.surface.centre[1])
            return z + self.shift.get(capture, 0.0)

        return fn

    def grid(self, capture: str, res: float | None = None) -> Grid:
        g = sample_grid(self.surface(capture), self.centre, self.half, res or self.res)
        if self.holes.get(capture):
            g, _ = with_holes(g, self.holes[capture])
        return g


def _rect(c: tuple[float, float], x0: float, y0: float, x1: float, y1: float) -> list[float]:
    return [c[0] + x0, c[1] + y0, c[0] + x1, c[1] + y1]


def _ring(rect: Sequence[float]) -> list[list[float]]:
    x0, y0, x1, y1 = rect
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]


def _measure(
    mid: str, label: str, rect: Sequence[float], fn: HeightFn, items: list[dict], material: str | None = None
) -> dict:
    ring = _ring(rect)
    z = fn(np.array([p[0] for p in ring]), np.array([p[1] for p in ring]))
    return {
        "id": mid,
        "family": "polygon",
        "tool": "volume",
        "label": label,
        "scope": {"kind": "site"},
        "points": [[p[0], p[1], round(float(zz), 4)] for p, zz in zip(ring, z, strict=True)],
        **({"material": material} if material else {}),
        "items": items,
        "results": [],
        "createdAt": STAMP,
        "createdBy": "Synthetic data (survey_synth.py)",
    }


def _cone_shift_truth(R: float, H: float, s: float, area: float) -> dict:
    """dz = s - cone over a polygon of ``area`` holding the whole cone (the cone removed and the
    survey shifted up by ``s``): exact cut, fill and net."""
    rs = R * (1 - s / H)
    cut = math.pi * rs * rs * (H - s) / 3
    net = s * area - math.pi * R * R * H / 3
    return {"cutM3": cut, "fillM3": cut + net, "netM3": net}


def analytic_site(quick: bool = False) -> SurveySite:
    """Five analytic shapes on flat ground (100 m), surveyed before (d1: bare) and after (d2)."""
    c = (551800.0, 2330600.0)
    h0 = 100.0
    caps = [
        {"id": "d1", "label": "Survey 2 March 2026", "date": "2026-03-02"},
        {"id": "d2", "label": "Survey 6 April 2026", "date": "2026-04-06"},
    ]
    shapes = [
        ("cone", cone(15, 6, (c[0] - 30, c[1] + 30), 0.0), (150, 140, 120)),
        ("frustum", frustum(15, 6, 5, (c[0] + 30, c[1] + 30), 0.0), (170, 150, 110)),
        ("paraboloid", paraboloid(15, 6, (c[0] - 30, c[1] - 30), 0.0), (140, 130, 125)),
        ("prism", prism((16, 12), 4, (c[0] + 30, c[1] - 30), 0.0), (120, 120, 130)),
        ("wedge", wedge(20, 10, 0.3, (c[0], c[1]), 0.0), (160, 135, 100)),
    ]
    feats = [Feature(n, s, col, ("d2",)) for n, s, col in shapes]
    truth: dict[str, Any] = {"shapes": {}, "comparisons": []}
    meas = []
    for n, s, _ in shapes:
        rect = (
            [s.centre[0] - 18, s.centre[1] - 18, s.centre[0] + 18, s.centre[1] + 18]
            if n != "wedge"
            else [s.centre[0] - 12, s.centre[1] - 7, s.centre[0] + 12, s.centre[1] + 7]
        )
        truth["shapes"][n] = {**s.truth, "base": h0, "polygon": _ring(rect)}
        truth["comparisons"].append(
            {
                "measurement": f"m-{n}",
                "from": "d1",
                "to": "d2",
                "fillM3": s.truth["volumeM3"],
                "cutM3": 0.0,
                "areaM2": (rect[2] - rect[0]) * (rect[3] - rect[1]),
            }
        )
        meas.append(
            _measure(
                f"m-{n}",
                f"{n.capitalize()} (synthetic)",
                rect,
                lambda e, nn: np.full_like(e, h0),
                [
                    {
                        "id": "survey-change",
                        "from": {"kind": "previous"},
                        "to": {"kind": "current"},
                        "useDeadband": False,
                    }
                ],
            )
        )
    return SurveySite(
        "demo-survey-analytic",
        "Survey analytic demo",
        "Five analytic shapes on flat ground, surveyed bare and built (synthetic demo data)",
        c,
        h0,
        64.0,
        0.25 if quick else 0.125,
        caps,
        lambda e, n: np.full_like(np.asarray(e, float), h0),
        feats,
        truth,
        measurements=meas,
        template_sets=["construction"],
    )


def earthworks_site(quick: bool = False) -> SurveySite:
    """The earthworks demo: a planar site surveyed on three dates.

    d1: ground and stockpile A (cone). d2: plus a borrow pit (cut), stockpile B (frustum, fill)
    and a parked excavator (a 6 x 3 x 3 m block, for cleanup). d3: stockpile A and the excavator
    gone, and the whole survey planted 3 cm high (compare-to-previous QA). A nodata hole on d1.
    Designs: the fill pad (TIN with breaklines and batters) and the road (corridor TIN and an
    alignment with line, clothoid, arc and a station equation), as LandXML, DXF, 12da and CSV;
    control points; a site calibration (JobXML and .dc). Checkpoints with one planted 15 cm off.
    """
    c = (SITE_E0, SITE_N0)
    h0 = SITE_H0
    gx, gy = 0.01, 0.005

    def ground(e, n):
        return h0 + gx * (np.asarray(e) - c[0]) + gy * (np.asarray(n) - c[1])

    def at(x, y):
        return (c[0] + x, c[1] + y)

    caps = [
        {"id": "d1", "label": "Survey 2 March 2026", "date": "2026-03-02"},
        {"id": "d2", "label": "Survey 6 April 2026", "date": "2026-04-06"},
        {"id": "d3", "label": "Survey 4 May 2026", "date": "2026-05-04"},
    ]
    pile_a = cone(12, 5, at(-70, 60), 0.0)
    pile_b = frustum(10, 4, 3, at(-70, -60), 0.0)
    pit = Surface(
        "borrow-pit",
        "pit",
        at(70, -70),
        0.0,
        20.0,
        lambda x, y: -np.clip((15 - _cheb(x, y)) / 2, 0, 3),
        {"volumeM3": _square_layers_volume([(3.0, 9.0, 15.0)])},
    )
    exc = prism((6, 3), 3, at(60, 60), 0.0)
    feats = [
        Feature("pile-a", pile_a, (190, 170, 130), ("d1", "d2")),
        Feature("borrow-pit", pit, (150, 120, 90), ("d2", "d3")),
        Feature("pile-b", pile_b, (200, 180, 140), ("d2", "d3")),
        Feature("excavator", exc, (230, 180, 40), ("d2",)),
    ]
    shift = 0.03
    R = {
        "pile-a": _rect(c, -85, 45, -55, 75),
        "pit": _rect(c, 52, -88, 88, -52),
        "pile-b": _rect(c, -85, -75, -55, -45),
        "excavator": _rect(c, 54, 55, 66, 65),
    }
    area = {k: (r[2] - r[0]) * (r[3] - r[1]) for k, r in R.items()}
    vb = pile_b.truth["volumeM3"]
    vp = pit.truth["volumeM3"]
    comps = [
        {"measurement": "m-pile-a", "from": "d1", "to": "d2", "cutM3": 0.0, "fillM3": 0.0},
        {"measurement": "m-pit", "from": "d1", "to": "d2", "cutM3": vp, "fillM3": 0.0},
        {"measurement": "m-pile-b", "from": "d1", "to": "d2", "cutM3": 0.0, "fillM3": vb},
        {"measurement": "m-excavator", "from": "d1", "to": "d2", "cutM3": 0.0, "fillM3": 54.0},
        {
            "measurement": "m-pile-a",
            "from": "d2",
            "to": "d3",
            **_cone_shift_truth(12, 5, shift, area["pile-a"]),
        },
        {"measurement": "m-pit", "from": "d2", "to": "d3", "cutM3": 0.0, "fillM3": shift * area["pit"]},
        {"measurement": "m-pile-b", "from": "d2", "to": "d3", "cutM3": 0.0, "fillM3": shift * area["pile-b"]},
        {
            "measurement": "m-excavator",
            "from": "d2",
            "to": "d3",
            "cutM3": (3 - shift) * 18,
            "fillM3": shift * (area["excavator"] - 18),
        },
    ]
    for cm in comps:
        cm["netM3"] = cm["fillM3"] - cm["cutM3"]
        cm["areaM2"] = area[cm["measurement"][2:]]
    # with a 5 cm deadband in use, the 3 cm shift drops out; on pile A only cells where the cone is
    # at least 8 cm high count: a cone of height H - 0.08 plus a 5 cm disc, both of radius rb
    rb = 12 * (1 - 0.08 / 5)
    deadband = {
        "measurement": "m-pile-a",
        "from": "d2",
        "to": "d3",
        "deadbandM": 0.05,
        "useDeadband": True,
        "cutM3": math.pi * rb * rb * (5 - 0.08) / 3 + 0.05 * math.pi * rb * rb,
        "fillM3": 0.0,
    }
    # pad design and its fill against the planar ground (exact on the TIN)
    pad = pad_tin(c, (30, 20), h0 + 2.0, 0.5, lambda e, n: float(ground(e, n)), (gx, gy), (40, 30))
    pad_fill, pad_cut = pad.volume_above_plane(ground)
    align = standard_alignment(at(-115, 110), 90.0, "cw", 90.0, (60, 30, 30, 30, 40), "Road centreline")
    # a design road: no planted violations (those are the quarry haul road's)
    road = HaulRoad(
        align, float(ground(*at(-115, 110))), steep=(0.0, 0.0, 0.08), low_berm=("none", 0.0, 0.0, 1.5)
    )
    road_tin = road.corridor_tin()
    checkpoints = []
    for i, (x, y) in enumerate(
        [(100, 100), (-100, 100), (-100, -100), (100, -100), (0, 100), (0, -100), (100, 0), (-100, 0)]
    ):
        e, n = at(x, y)
        z = float(ground(e, n))
        planted = i == 5
        checkpoints.append(
            {
                "name": f"CHK{i + 1}",
                "e": e,
                "n": n,
                "z": round(z + (0.15 if planted else 0.0), 4),
                "trueSurfaceZ": z,
                "planted": planted,
                "dz": {
                    "d1": round(-0.15 if planted else 0.0, 6),
                    "d2": round(-0.15 if planted else 0.0, 6),
                    "d3": round((-0.15 if planted else 0.0) + shift, 6),
                },
            }
        )
    dzs = np.array([cp["dz"]["d2"] for cp in checkpoints])
    control = [
        (f"CP{i + 1}", *at(x, y), round(float(ground(*at(x, y))), 4), "CTRL")
        for i, (x, y) in enumerate([(-110, -110), (110, -110), (110, 110), (-110, 110)])
    ]
    cal = site_calibration()
    truth = {
        "comparisons": comps,
        "deadband": deadband,
        "features": {
            f.id: {**f.surface.truth, "dates": list(f.dates), "centre": list(f.surface.centre)} for f in feats
        },
        "verticalShift": {"capture": "d3", "previous": "d2", "shiftM": shift},
        "excavator": {
            "capture": "d2",
            "rect": exc.truth["rect"],
            "volumeM3": 54.0,
            "note": "Clean it up (TIN from the boundary): the surface becomes the planar ground exactly.",
        },
        "checkpoints": {
            "points": checkpoints,
            "capture": "d2",
            "plantedOffM": 0.15,
            "planted": "CHK6",
            "rmseM": float(np.sqrt(np.mean(dzs**2))),
            "meanM": float(dzs.mean()),
            "maxAbsM": float(np.abs(dzs).max()),
        },
        "ground": {"formula": "H0 + 0.01 (E - E0) + 0.005 (N - N0)", "H0": h0, "E0": c[0], "N0": c[1]},
        "pad": {
            "fillM3": pad_fill,
            "cutM3": pad_cut,
            "levelM": h0 + 2.0,
            "batter": "1:2",
            "outer": _ring(_rect(c, -40, -30, 40, 30)),
            "note": "Design pad against the d1 ground over the outer boundary (exact TIN to plane).",
        },
        "road": {
            "alignment": {
                "lengthM": align.length,
                "startStation": 1000.0,
                "equations": [{"back": 1150.0, "ahead": 1200.0}],
                "stations": [
                    {"chainage": s, "station": align.station(s)}
                    for s in (0.0, 100.0, 149.999, 150.0, 150.001, 200.0, align.length)
                ],
            }
        },
        "calibration": {k: cal[k] for k in ("horizontal", "vertical", "rmsH", "rmsV")},
    }
    meas = [
        _measure(
            "m-pile-a",
            "Stockpile A",
            R["pile-a"],
            ground,
            [
                {
                    "id": "change",
                    "from": {"kind": "previous"},
                    "to": {"kind": "current"},
                    "useDeadband": False,
                },
                {"id": "pile", "from": {"kind": "smart"}, "to": {"kind": "current"}, "useDeadband": False},
            ],
        ),
        _measure(
            "m-pit",
            "Borrow pit",
            R["pit"],
            ground,
            [{"id": "change", "from": {"kind": "previous"}, "to": {"kind": "current"}, "useDeadband": False}],
        ),
        _measure(
            "m-pile-b",
            "Stockpile B",
            R["pile-b"],
            ground,
            [{"id": "change", "from": {"kind": "previous"}, "to": {"kind": "current"}, "useDeadband": False}],
        ),
        _measure(
            "m-excavator",
            "Parked excavator",
            R["excavator"],
            ground,
            [{"id": "change", "from": {"kind": "previous"}, "to": {"kind": "current"}, "useDeadband": False}],
        ),
        _measure(
            "m-pad",
            "Pad to design",
            _rect(c, -40, -30, 40, 30),
            ground,
            [
                {
                    "id": "design",
                    "from": {"kind": "current"},
                    "to": {"kind": "design", "design": "earthworks-design", "layer": "pad"},
                    "useDeadband": False,
                }
            ],
        ),
    ]
    design = {
        "id": "earthworks-design",
        "name": "Pad and road design (synthetic)",
        "stem": "earthworks-design",
        "bundle": DesignBundle("Synthetic earthworks demo (fictional)", [pad, road_tin], control, [align]),
        "layers": [("pad", pad), ("road", road_tin)],
        "alignments": [("road-cl", align)],
    }
    return SurveySite(
        "demo-survey-earthworks",
        "Earthworks demo",
        "Fictional desert site, earthworks on 3 survey dates (synthetic demo data)",
        c,
        h0,
        128.0,
        0.5 if quick else 0.25,
        caps,
        ground,
        feats,
        truth,
        shift={"d3": shift},
        designs=[design],
        template_sets=["construction"],
        holes={"d1": [(c[0] + 100, c[1] - 20, 5.0)]},
        measurements=meas,
        calibration=cal,
        extra_files={
            "checkpoints.csv": "name,easting,northing,elevation\n"
            + "".join(f"{p['name']},{p['e']:.4f},{p['n']:.4f},{p['z']:.4f}\n" for p in checkpoints)
        },
    )


def quarry_site(quick: bool = False) -> SurveySite:
    """The quarry demo: three monthly surveys of a benched pit (three 10 m benches; a sump cut on
    the last date), three stockpiles with materials (a cone that grows, a frustum that shrinks, a
    paraboloid added on the last date) and a haul road with a planted steep stretch and a low
    berm. Stockpile truths are against the planar ground (the smart and fit-plane bases)."""
    c = (553000.0, 2333000.0)
    h0 = 140.0

    def ground(e, n):
        return h0 + 0.004 * (np.asarray(e) - c[0]) - 0.003 * (np.asarray(n) - c[1])

    def at(x, y):
        return (c[0] + x, c[1] + y)

    caps = [
        {"id": "m1", "label": "Survey 31 January 2026", "date": "2026-01-31"},
        {"id": "m2", "label": "Survey 28 February 2026", "date": "2026-02-28"},
        {"id": "m3", "label": "Survey 31 March 2026", "date": "2026-03-31"},
    ]
    materials = [
        {
            "id": "crushed-20",
            "name": "Crushed rock 20 mm",
            "code": "CR20",
            "densityTPerM3": 1.6,
            "swell": {"loose": 1.3, "compacted": 0.95},
        },
        {
            "id": "washed-sand",
            "name": "Washed sand",
            "code": "SND",
            "densityTPerM3": 1.5,
            "swell": {"loose": 1.15, "compacted": 0.9},
        },
        {
            "id": "base-course",
            "name": "Base course",
            "code": "BC",
            "densityTPerM3": 2.1,
            "swell": {"loose": 1.25, "compacted": 0.85},
        },
    ]
    piles = {
        "m1": [("sp1", cone(14, 6, at(60, 120), 0.0)), ("sp2", frustum(15, 6, 5, at(130, 60), 0.0))],
        "m2": [("sp1", cone(16, 7, at(60, 120), 0.0)), ("sp2", frustum(12, 5, 4, at(130, 60), 0.0))],
        "m3": [
            ("sp1", cone(18, 8, at(60, 120), 0.0)),
            ("sp2", frustum(10, 4, 3, at(130, 60), 0.0)),
            ("sp3", paraboloid(12, 5, at(60, 40), 0.0)),
        ],
    }
    mat_of = {"sp1": "crushed-20", "sp2": "washed-sand", "sp3": "base-course"}
    col_of = {"sp1": (120, 120, 125), "sp2": (225, 200, 140), "sp3": (95, 85, 80)}
    pit = benched_pit(centre=at(-120, 100), base=0.0)
    pit_m3 = benched_pit(centre=at(-120, 100), base=0.0, sump=(5.0, 2.0))
    feats = [
        Feature("pit", pit, (165, 140, 115), ("m1", "m2")),
        Feature("pit", pit_m3, (165, 140, 115), ("m3",)),
    ]
    for cap, lst in piles.items():
        for pid, s in lst:
            feats.append(Feature(pid, s, col_of[pid], (cap,), mat_of[pid]))
    align = standard_alignment(at(-200, -200), 90.0, "ccw", 90.0, name="Haul road centreline")
    road = HaulRoad(align, float(ground(*at(-200, -200))))
    pile_rects = {
        "sp1": _rect(c, 35, 95, 85, 145),
        "sp2": _rect(c, 110, 40, 150, 80),
        "sp3": _rect(c, 44, 24, 76, 56),
    }
    dens = {m["id"]: m["densityTPerM3"] for m in materials}
    stock = {}
    for cap, lst in piles.items():
        for pid, s in lst:
            v = s.truth["volumeM3"]
            stock.setdefault(pid, {"material": mat_of[pid], "polygon": _ring(pile_rects[pid]), "dates": {}})
            stock[pid]["dates"][cap] = {
                "volumeM3": v,
                "tonnes": v * dens[mat_of[pid]],
                "heightM": s.truth["heightM"],
            }
    truth = {
        "stockpiles": stock,
        "bases": "smart and fit-plane equal the planar ground exactly, so each pile's volume is its shape's",
        "pit": {
            "m1": pit.truth,
            "m3": pit_m3.truth,
            "sumpCutM3": pit_m3.truth["sumpM3"],
            "note": "Levels are relative to the ground plane at the pit (the rim follows it).",
        },
        "haulRoad": road.truth(),
        "ground": {"formula": "H0 + 0.004 (E - E0) - 0.003 (N - N0)", "H0": h0, "E0": c[0], "N0": c[1]},
    }
    meas = [
        _measure(
            f"m-{pid}",
            f"Stockpile {pid.upper()}",
            pile_rects[pid],
            ground,
            [{"id": "pile", "from": {"kind": "smart"}, "to": {"kind": "current"}, "useDeadband": False}],
            material=mat_of[pid],
        )
        for pid in ("sp1", "sp2", "sp3")
    ]
    pr = pit.truth["rect"]
    meas.append(
        _measure(
            "m-pit",
            "Pit (month on month)",
            [pr[0] - 3, pr[1] - 3, pr[2] + 3, pr[3] + 3],
            ground,
            [{"id": "change", "from": {"kind": "previous"}, "to": {"kind": "current"}, "useDeadband": False}],
        )
    )
    return SurveySite(
        "demo-survey-quarry",
        "Quarry demo",
        "Fictional desert quarry, 3 monthly surveys (synthetic demo data)",
        c,
        h0,
        256.0,
        1.0 if quick else 0.5,
        caps,
        ground,
        feats,
        truth,
        materials=materials,
        template_sets=["mining"],
        road=road,
        measurements=meas,
        designs=[
            {
                "id": "haul-road",
                "name": "Haul road (synthetic)",
                "stem": "haul-road",
                "bundle": DesignBundle(
                    "Synthetic quarry demo (fictional)", [road.corridor_tin()], [], [align]
                ),
                "layers": [("road", road.corridor_tin())],
                "alignments": [("road-cl", align)],
            }
        ],
    )


def landfill_site(quick: bool = False) -> SurveySite:
    """The landfill demo: a lined cell (120 x 80 m opening, 1:3 slopes, 6 m deep) filled in three
    lifts surveyed monthly (to -3 m, to ground, a 3 m cap), the cell base and final cap (+6 m) as
    designs, and weighbridge tonnages (achieved densities in the truth)."""
    c = (549500.0, 2329800.0)
    h0 = 95.0
    cell = LandfillCell(c, h0)
    caps = [
        {"id": "l1", "label": "Survey 31 January 2026", "date": "2026-01-31"},
        {"id": "l2", "label": "Survey 28 February 2026", "date": "2026-02-28"},
        {"id": "l3", "label": "Survey 31 March 2026", "date": "2026-03-31"},
    ]

    def ground(e, n):
        return np.full_like(np.asarray(e, dtype=np.float64), h0)

    over = {}
    for cap, level in zip(("l1", "l2", "l3"), cell.lifts, strict=True):
        over[cap] = (lambda lv: lambda e, n: h0 + cell.after(lv, np.asarray(e) - c[0], np.asarray(n) - c[1]))(
            level
        )
    t = cell.truth()
    tonnes = {1: 0.85, 2: 0.9, 3: 0.95}
    wb = []
    for lift in t["lifts"]:
        tn = round(lift["volumeM3"] * tonnes[lift["lift"]])
        lift["tonnes"] = tn
        lift["achievedDensityTPerM3"] = tn / lift["volumeM3"]
        wb.append(lift)
    base_tin = _cell_tin(cell, None, "Cell base design")
    cap_tin = _cell_tin(cell, cell.final_cap, "Final cap design")
    truth = {
        "cell": t,
        "ground": {"H0": h0},
        "designAirspaceM3": t["airspaceM3"],
        "comparisons": [
            {
                "measurement": "m-cell",
                "from": "design:cell-base" if i == 0 else caps[i - 1]["id"],
                "to": caps[i]["id"],
                "fillM3": t["lifts"][i]["volumeM3"],
                "cutM3": 0.0,
            }
            for i in range(3)
        ],
    }
    rect = _rect(c, -70, -50, 70, 50)
    meas = [
        _measure(
            "m-cell",
            "Cell 1",
            rect,
            ground,
            [
                {"id": "lift", "from": {"kind": "previous"}, "to": {"kind": "current"}, "useDeadband": False},
                {
                    "id": "airspace",
                    "from": {"kind": "current"},
                    "to": {"kind": "design", "design": "cell-design", "layer": "final-cap"},
                    "useDeadband": False,
                },
            ],
            material="msw",
        )
    ]
    weigh = "date,lift,tonnes,note\n" + "".join(
        f"{caps[i]['date']},{w['lift']},{w['tonnes']},Weighbridge total for the month (synthetic)\n"
        for i, w in enumerate(wb)
    )
    return SurveySite(
        "demo-survey-landfill",
        "Landfill demo",
        "Fictional desert landfill cell, 3 lifts (synthetic demo data)",
        c,
        h0,
        128.0,
        0.5 if quick else 0.25,
        caps,
        ground,
        [],
        truth,
        materials=[{"id": "msw", "name": "Municipal solid waste", "code": "MSW", "densityTPerM3": 0.9}],
        template_sets=["landfill"],
        measurements=meas,
        surfaces_override=over,
        designs=[
            {
                "id": "cell-design",
                "name": "Cell 1 design (synthetic)",
                "stem": "cell-design",
                "bundle": DesignBundle("Synthetic landfill demo (fictional)", [base_tin, cap_tin], [], []),
                "layers": [("cell-base", base_tin), ("final-cap", cap_tin)],
                "alignments": [],
            }
        ],
        extra_files={"weighbridge.csv": weigh},
    )


def _cell_tin(cell: LandfillCell, cap: float | None, name: str) -> Tin:
    """The cell base (cap None) or the cell base with a cap to ``cap``, as an exact TIN: nested
    rectangles at the slope breaks, joined by planar quads, out to a 10 m ground margin."""
    a, b, run = cell.a, cell.b, cell.run
    rings = [(a + 10, b + 10, 0.0), (a, b, 0.0)]
    if cap is None:
        rings += [(a - run * cell.depth, b - run * cell.depth, -cell.depth)]
    else:
        rings += [(a - run * cap, b - run * cap, cap)]
    v = []
    for ha, hb, z in rings:
        for sx, sy in ((1, 1), (-1, 1), (-1, -1), (1, -1)):
            v.append((cell.centre[0] + sx * ha, cell.centre[1] + sy * hb, cell.base + z))
    tris = []
    for r in range(len(rings) - 1):
        o, i0 = 4 * r, 4 * (r + 1)
        for k in range(4):
            j = (k + 1) % 4
            tris += [(o + k, i0 + k, i0 + j), (o + k, i0 + j, o + j)]
    last = 4 * (len(rings) - 1)
    tris += [(last, last + 1, last + 2), (last, last + 2, last + 3)]
    tin = Tin(np.round(np.array(v), 4), np.array(tris, dtype=np.int64), name=name)
    tin.breaklines = [[4, 5, 6, 7, 4], [8, 9, 10, 11, 8]]
    return tin


SITES: dict[str, Callable[[bool], SurveySite]] = {
    "analytic": analytic_site,
    "earthworks": earthworks_site,
    "quarry": quarry_site,
    "landfill": landfill_site,
}


# ------------------------------------------------------------------ rendering (ortho and relief)


def hillshade(z: np.ndarray, res: float, azimuth: float = 315.0, altitude: float = 45.0) -> np.ndarray:
    zz = np.where(np.isfinite(z), z, np.nanmean(z))
    gy, gx = np.gradient(zz, res)
    slope = np.arctan(np.hypot(gx, gy))
    aspect = np.arctan2(-gx, gy)
    az, alt = math.radians(azimuth), math.radians(altitude)
    s = np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect)
    return np.clip(s, 0, 1)


def render_ortho(site: SurveySite, capture: str, grid: Grid, seed: int = 3) -> np.ndarray:
    """A synthetic orthophoto: sand with seeded texture, each feature in its colour (piles stand
    out by material), the road surface grey, shaded by the terrain. uint8 RGB, grid-sized."""
    rng = np.random.default_rng(seed)
    e, n = grid.centres()
    h, w = grid.z.shape
    base = np.array([214, 190, 150], np.float64)
    tex = rng.normal(0, 1, (h // 4 + 2, w // 4 + 2))
    tex = np.kron(tex, np.ones((4, 4)))[:h, :w]
    rgb = np.broadcast_to(base, (h, w, 3)) * (1 + 0.04 * tex[..., None])
    rgb = rgb.copy()
    if site.road is not None:
        g = site.ground(e, n)
        rz = site.road.heights(e, n, site.ground)
        on = np.abs(rz - g) > 0.02
        rgb[on] = np.array([150, 145, 140]) * (1 + 0.03 * tex[on, None])
    for f in site.features:
        if capture not in f.dates:
            continue
        loc = f.surface.local(e - f.surface.centre[0], n - f.surface.centre[1])
        m = np.abs(loc) > 0.01
        rgb[m] = np.array(f.colour, np.float64) * (1 + 0.06 * tex[m, None])
    if site.surfaces_override:
        z = grid.z
        m = np.abs(z - site.h0) > 0.01
        rgb[m] = np.array([120, 110, 95]) * (1 + 0.08 * tex[m, None])
    shade = hillshade(grid.z, grid.res)
    rgb *= (0.55 + 0.6 * shade)[..., None]
    rgb[~np.isfinite(grid.z)] = 0
    return np.clip(rgb, 0, 255).astype(np.uint8)


def render_relief(grid: Grid) -> np.ndarray:
    """A shaded relief tinted by height (uint8 RGB)."""
    z = grid.z
    lo, hi = np.nanpercentile(z, 1), np.nanpercentile(z, 99)
    t = np.clip((np.where(np.isfinite(z), z, lo) - lo) / max(hi - lo, 1e-6), 0, 1)
    ramp = np.array([[40, 90, 160], [90, 170, 120], [230, 210, 120], [200, 110, 60]], np.float64)
    idx = t * (len(ramp) - 1)
    i0 = np.floor(idx).astype(int).clip(0, len(ramp) - 2)
    f = (idx - i0)[..., None]
    col = ramp[i0] * (1 - f) + ramp[i0 + 1] * f
    s = hillshade(z, grid.res)[..., None]
    out = col * (0.35 + 0.75 * s)
    out[~np.isfinite(z)] = 0
    return np.clip(out, 0, 255).astype(np.uint8)


# ------------------------------------------------------------------ the set folder of a demo


def _sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def _jdump(p: Path, doc: Any) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(doc, indent=1, default=float) + "\n", "utf-8", newline="\n")


def survey_settings(site: SurveySite, calibration_id: str | None = None) -> dict:
    """``survey/settings.json`` (``aio.survey-settings/1``) of a demo site."""
    return {
        "schema": "aio.survey-settings/1",
        "verticalDatum": {"kind": "project"},
        "distances": "grid",
        "units": {
            "distance": "m",
            "area": "m2",
            "volume": "m3",
            "density": "t/m3",
            "mass": "t",
            "grade": "percent",
        },
        "order": "NEZ",
        "precision": {"coordinate": 3, "distance": 3, "area": 2, "volume": 1, "grade": 1},
        "templateSets": site.template_sets,
        "materials": site.materials,
        "qa": {"level": "moderate"},
        "heatmap": {
            "stops": [
                {"value": -1, "color": "#b2182b"},
                {"value": -0.1, "color": "#f4a582"},
                {"value": 0.1, "color": "#92c5de"},
                {"value": 1, "color": "#2166ac"},
            ],
            "stepped": False,
        },
        "deadbandM": 0.05,
        **({"calibration": calibration_id} if calibration_id else {}),
    }


def write_site(site: SurveySite, out: Path) -> dict:
    """Write a demo's set folder (read by tools/demo/survey-demo.mjs):

    ``site.json`` (id, name, CRS, origin, extent, captures, files), ``truth.json``,
    ``captures/<id>/dsm.json`` + ``dsm.png`` (``aio.grid/1``), ``ortho.png`` and ``relief.png``,
    ``survey/`` (settings.json, measurements.json, designs.json, designs/<id>/ with the original
    files and their normalised layers, calibration files, CSVs), ready to copy into a project.
    """
    from PIL import Image

    out.mkdir(parents=True, exist_ok=True)
    crs = {"epsg": SITE_EPSG}
    caps = []
    truth = {
        "schema": "aio.truth/1",
        "project": site.id,
        "generator": "python/tests/survey_synth.py",
        "note": "Synthetic survey data: every value here is exact for the analytic surfaces (see the generator).",
        "crs": crs,
        "origin": [site.centre[0], site.centre[1], site.h0],
        "half": site.half,
        "res": site.res,
        "captures": site.captures,
        **site.truth,
        "holes": {},
    }
    for cap in site.captures:
        g = sample_grid(site.surface(cap["id"]), site.centre, site.half, site.res)
        if site.holes.get(cap["id"]):
            g, hole_area = with_holes(g, site.holes[cap["id"]])
            truth["holes"][cap["id"]] = {
                "discs": [list(h) for h in site.holes[cap["id"]]],
                "areaM2": hole_area,
            }
        folder = out / "captures" / cap["id"]
        _, _, doc = write_aio_grid(g, folder, "dsm", capture=cap["id"])
        Image.fromarray(render_ortho(site, cap["id"], g)).save(folder / "ortho.png")
        Image.fromarray(render_relief(g)).save(folder / "relief.png")
        caps.append({**cap, "size": g.width, "quantM": doc["scale"]})
    sv = out / "survey"
    cal_id = None
    if site.calibration is not None:
        jxl = write_jobxml(sv / "calibration" / "site-calibration.jxl", site.calibration)
        write_dc(sv / "calibration" / "site-calibration.dc", site.calibration)
        cal_id = "site-calibration"
        _jdump(
            sv / "calibration.json",
            calibration_json(site.calibration, cal_id, "survey/calibration/site-calibration.jxl", _sha(jxl)),
        )
    _jdump(sv / "settings.json", survey_settings(site))
    _jdump(sv / "measurements.json", {"schema": "aio.measurements/1", "measurements": site.measurements})
    entries = []
    for d in site.designs:
        folder = sv / "designs" / d["id"]
        src = write_landxml(folder / f"{d['stem']}.xml", d["bundle"])
        layers = []
        for lid, tin in d["layers"]:
            write_tin(folder / f"{lid}.tin", tin, crs)
            layers.append(
                {
                    "id": lid,
                    "name": tin.name,
                    "kind": "surface",
                    "file": f"{lid}.tin",
                    "counts": {"triangles": len(tin.triangles), "vertices": len(tin.vertices)},
                    "visible": True,
                    "archived": False,
                    "verticalOffsetM": 0.0,
                }
            )
        for lid, al in d["alignments"]:
            write_alignment_json(folder / f"{lid}.alignment.json", al, crs)
            layers.append(
                {
                    "id": lid,
                    "name": al.name,
                    "kind": "alignment",
                    "file": f"{lid}.alignment.json",
                    "counts": {"elements": len(al.elements)},
                    "visible": True,
                    "archived": False,
                    "verticalOffsetM": 0.0,
                }
            )
        entries.append(
            {
                "id": d["id"],
                "name": d["name"],
                "src": src.name,
                "sha256": _sha(src),
                "bytes": src.stat().st_size,
                "format": "landxml",
                "units": "m",
                "crs": crs,
                "calibrated": False,
                "importedAt": STAMP,
                "importedBy": "Synthetic data",
                "layers": layers,
            }
        )
        # the same design in the other formats, kept beside the set for import tests
        alt = out / "design-files" / d["id"]
        write_dxf(alt / f"{d['stem']}.dxf", d["bundle"])
        write_12da(alt / f"{d['stem']}.12da", d["bundle"])
        write_points_csv(alt / f"{d['stem']}-points.csv", d["bundle"])
    designs = {"schema": "aio.designs/1", "designs": entries}
    al_ids = [f"{d['id']}/{lid}" for d in site.designs for lid, _ in d["alignments"]]
    if al_ids:
        designs["activeAlignment"] = al_ids[0]
    _jdump(sv / "designs.json", designs)
    for name, text in site.extra_files.items():
        (sv / name).write_text(text, "utf-8", newline="\n")
    meta = {
        "schema": "aio.survey-set/1",
        "id": site.id,
        "name": site.name,
        "description": site.description,
        "crs": crs,
        "origin": [site.centre[0], site.centre[1], site.h0],
        "half": site.half,
        "res": site.res,
        "captures": caps,
        "calibration": cal_id,
    }
    _jdump(out / "site.json", meta)
    _jdump(out / "truth.json", truth)
    return meta


def write_fixtures(out: Path) -> dict:
    """Every analytic surface (aio.grid/1 and COG at 10 cm), the designs in every format, the
    hostile files, the calibration files and the fictional geoid, with one ``truth.json``."""
    truth: dict[str, Any] = {"surfaces": {}, "hostile": {}, "crs": {}}
    for name, make in ANALYTIC.items():
        s = make()
        g = s.grid(0.1)
        write_aio_grid(g, out / "surfaces", name)
        write_cog(g, out / "surfaces" / f"{name}.tif")
        truth["surfaces"][name] = {**s.truth, "base": s.base, "res": 0.1}
    site = earthworks_site(quick=True)
    d = site.designs[0]
    write_design_files(out / "designs", d["bundle"], d["stem"])
    for kind, fn in (("landxml", landxml_hostile), ("dxf", dxf_hostile), ("12da", twelve_da_hostile)):
        truth["hostile"][kind] = {k: [p.name, c] for k, (p, c) in fn(out / "hostile").items()}
    truth["hostile"]["csv"] = {
        k: [p.name, c] for k, (p, c) in csv_hostile(out / "hostile", d["bundle"].points).items()
    }
    cal = site.calibration or site_calibration()
    truth["hostile"]["jobxml"] = {
        k: [p.name, c] for k, (p, c) in jobxml_hostile(out / "hostile", cal).items()
    }
    write_jobxml(out / "calibration" / "site-calibration.jxl", cal)
    write_dc(out / "calibration" / "site-calibration.dc", cal)
    truth["calibration"] = cal
    truth["geoid"] = write_geoid_grid(out / "geoid" / "synthetic-geoid.tif", FIXTURE_CRS["utm39n"].lonlat)
    truth["crs"] = {
        k: {
            "name": v.name,
            "epsg": v.epsg,
            "proj4": v.proj4,
            "unit": v.unit,
            "verticalEpsg": v.vertical_epsg,
            "geoid": v.geoid,
            "lonlat": v.lonlat,
            "origin": v.origin,
        }
        for k, v in FIXTURE_CRS.items()
    }
    _jdump(out / "truth.json", truth)
    return truth


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Synthetic surveying data (M11, no client data).")
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("demo", help="a demo site's set folder for tools/demo/survey-demo.mjs")
    d.add_argument("--site", choices=sorted(SITES), required=True)
    d.add_argument("--out", type=Path, required=True)
    d.add_argument("--quick", action="store_true", help="coarser grids (CI)")
    f = sub.add_parser("fixtures", help="every analytic surface, design format, hostile file and calibration")
    f.add_argument("--out", type=Path, required=True)
    a = ap.parse_args(argv)
    if a.cmd == "demo":
        meta = write_site(SITES[a.site](a.quick), a.out)
        print(json.dumps({"id": meta["id"], "captures": len(meta["captures"])}))
    else:
        write_fixtures(a.out)
        print(json.dumps({"out": str(a.out)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
